#!/usr/bin/env node
// The consumer-repo pre-flight: what the fleet needs from this machine and
// this repository before a run-team run may shortlist or dispatch anything.
// run-team calls it at the start of Phase 0, so the checks run without the
// maintainer copying a block by hand.
//
// THE CHECKS are the CHECKS table below, one probe per row, each run with the
// main checkout as its cwd. A row passes when its argv exits 0 and, where the
// row says `want`, its stdout carries a line equal to that string — or, for
// `want: NONEMPTY`, any non-blank line. A row marked `warn` reports a miss as a
// WARN and passes: the CI-workflow row, because a repo without a workflow
// named CI still runs, with the merge bot told so per call. Every other miss
// is a FAIL. Every row runs, so one run names every failure, not the first.
//
// No row names a manifest, a lockfile or a test runner: the consumer's Install
// step and Test entrypoint come from its Recipe, and the fleet keeps no table
// of supported technologies.
//
// THE MARKER. A run where nothing FAILed writes `.fleet/preflight.json`
// (resolved through fleet-dir.mjs, so a worktree and the main checkout name
// the same file) holding a sha256 of the check set: every row's name, argv,
// `want` and `warn`. A later run whose check set hashes the same prints
// PREFLIGHT SKIPPED and runs nothing — the rows cost several `gh` calls, and
// every controller tick already spends its own share of the secondary rate
// limit. A row added, removed or changed moves the hash, so the next run
// checks again. A failed run writes no marker. A marker that cannot be read
// is treated as absent. Deleting the file makes the next run check again.
//
// CLI (no flags):
//   preflight.mjs   one `ok|WARN|FAIL <name>[: why]` line per row, then
//                   `PREFLIGHT OK`, `PREFLIGHT SKIPPED` or
//                   `PREFLIGHT FAILED: <names>`.
//                   Exit 0 passed or skipped, 1 a row failed, 2 could not run
//                   (a flag given, no repository, the marker not writable).
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";

export const MARKER_FILE = "preflight.json";
export const NONEMPTY = { nonEmpty: true };
const PROBE_TIMEOUT_MS = 60_000;
const NAME = "preflight";
const die = makeDie(NAME);

const label = (l) => ({ name: `label:${l}`, argv: ["gh", "label", "list", "--search", l, "--json", "name", "--jq", ".[].name"], want: l });

// A leading `~/` in an argv element is the user's home, expanded at run time
// and hashed as written, so the hash does not change with the box.
export const CHECKS = [
  { name: "binary:node", argv: ["node", "-v"] },
  { name: "binary:git", argv: ["git", "--version"] },
  { name: "binary:gh", argv: ["gh", "--version"] },
  { name: "binary:jq", argv: ["jq", "--version"] },
  { name: "binary:python3", argv: ["python3", "--version"] },
  { name: "binary:shasum", argv: ["shasum", "--version"] },
  { name: "gh-auth", argv: ["gh", "auth", "status"] },
  { name: "origin-remote", argv: ["git", "remote", "get-url", "origin"] },
  { name: "origin-main", argv: ["git", "rev-parse", "--verify", "-q", "origin/main"] },
  { name: "worktrees-ignored", argv: ["git", "check-ignore", "-q", ".worktrees/probe"] },
  { name: "fleet-ignored", argv: ["git", "check-ignore", "-q", ".fleet/probe"] },
  label("ready-for-agent"),
  label("in-progress"),
  label("ready-to-merge"),
  { name: "allow-merge-commit", argv: ["gh", "api", "repos/{owner}/{repo}", "--jq", ".allow_merge_commit"], want: "true" },
  { name: "ruleset", argv: ["gh", "api", "repos/{owner}/{repo}/rulesets", "--jq", ".[].name"], want: NONEMPTY },
  { name: "ci-workflow", argv: ["sh", "-c", "grep -l '^name: *CI *$' .github/workflows/*.y*ml"], warn: true },
  { name: "resolver", argv: ["~/.fleet/bin/fleet-run", "--root"] },
];

/** sha256 over every row's name, argv, want and warn, in table order. */
export function checkSetHash(checks) {
  const rows = checks.map(({ name, argv, want, warn }) => [name, argv, want ?? null, warn === true]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const wanted = (want) => (want === NONEMPTY ? "a non-blank line" : `a line "${want}"`);

// One row: null when it passed, else why it did not.
function probe({ argv, want }, cwd, env) {
  const [cmd, ...args] = argv.map((a) => (a.startsWith("~/") ? join(env.HOME ?? "", a.slice(2)) : a));
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  const shown = argv.join(" ");
  if (r.error) return `${shown} did not run: ${r.error.code ?? r.error.message}`;
  if (r.status !== 0) {
    const last = String(r.stderr ?? "").trim().split("\n").at(-1);
    return `${shown} ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${last ? `: ${last}` : ""}`;
  }
  if (want === undefined) return null;
  const lines = String(r.stdout).split("\n").map((l) => l.trim());
  const hit = want === NONEMPTY ? lines.some(Boolean) : lines.includes(want);
  return hit ? null : `${shown} printed ${lines.some(Boolean) ? JSON.stringify(lines.filter(Boolean).join(" ")) : "nothing"}, want ${wanted(want)}`;
}

function readMarker(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.checks ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `checks` from the main checkout `cwd` belongs to, unless the marker
 * records this exact check set as passed. Writes the marker when no row
 * failed. Throws FleetDirUnresolvable when `cwd` is in no repository, and an
 * Error naming the path when the marker cannot be written.
 *
 * Returns `{ skipped, marker, results: [{name, warn, ok, why}], failed }`.
 */
export function runPreflight({ checks = CHECKS, cwd = process.cwd(), env = process.env } = {}) {
  const marker = fleetFile(MARKER_FILE, { cwd });
  const workspace = dirname(dirname(marker));
  const hash = checkSetHash(checks);
  if (readMarker(marker) === hash) return { skipped: true, marker, results: [], failed: [] };

  const childEnv = gitEnv({}, env);
  const results = checks.map((c) => {
    const why = probe(c, workspace, childEnv);
    return { name: c.name, warn: c.warn === true, ok: why === null, why };
  });
  const failed = results.filter((r) => !r.ok && !r.warn).map((r) => r.name);
  if (failed.length === 0) {
    try {
      mkdirSync(dirname(marker), { recursive: true });
      const tmp = `${marker}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ checks: hash, passed: new Date().toISOString() })}\n`);
      renameSync(tmp, marker);
    } catch (e) {
      throw new Error(`cannot write ${marker}: ${e?.code ?? e?.message}`);
    }
  }
  return { skipped: false, marker, results, failed };
}

function main() {
  const { sweep, stray } = defineFlags(die, { flags: {} });
  sweep();
  stray();
  let r;
  try {
    r = runPreflight();
  } catch (e) {
    die(e.message);
  }
  if (r.skipped) {
    console.log(`PREFLIGHT SKIPPED: this check set already passed (${r.marker}; delete it to check again)`);
    return;
  }
  for (const x of r.results) console.log(x.ok ? `ok ${x.name}` : `${x.warn ? "WARN" : "FAIL"} ${x.name}: ${x.why}`);
  if (r.failed.length) {
    console.log(`PREFLIGHT FAILED: ${r.failed.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PREFLIGHT OK (${r.marker})`);
}

if (isCLI(import.meta.url)) main();
