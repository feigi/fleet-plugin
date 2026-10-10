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
// named CI still runs, its workflow named per call (`ci-state.mjs
// --workflow`) or declared absent (`--declare-no-ci`). Every other miss is a
// FAIL. Every row runs, so one run names every failure, not the first.
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
// CLI (no arguments):
//   preflight.mjs   one `ok|WARN|FAIL <name>[: why]` line per row, then
//                   `PREFLIGHT OK`, `PREFLIGHT SKIPPED` or
//                   `PREFLIGHT FAILED: <names>`.
//                   Exit 0 passed or skipped, 1 a row failed, 2 could not run
//                   (an argument given, no repository) or could not write the
//                   marker after every row passed, the row lines printed first.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCLI } from "./is-cli.mjs";
import { makeDie } from "./arg.mjs";
import { fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";

export const MARKER_FILE = "preflight.json";
export const NONEMPTY = { nonEmpty: true };
const PROBE_TIMEOUT_MS = 60_000;
const NAME = "preflight";
const die = makeDie(NAME);

const label = (l) => ({ name: `label:${l}`, argv: ["gh", "label", "list", "--search", l, "--json", "name", "--jq", ".[].name"], want: l });

// A workflow file whose top-level `name:` is CI, matched the way ci-state.mjs
// reads a workflow's name: either quote style, and a trailing ` # comment` is
// not part of the name. A plain `^name: *CI *$` would WARN for a repo
// `--workflow CI` resolves without trouble.
const CI_NAMED = String.raw`grep -lE "^name:[[:space:]]*[\"']?CI[\"']?([[:space:]]+#.*)?[[:space:]]*\$" .github/workflows/*.y*ml`;

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
  { name: "ci-workflow", argv: ["sh", "-c", CI_NAMED], warn: true },
  { name: "resolver", argv: ["~/.fleet/bin/fleet-run", "--root"] },
];

/** sha256 over every row's name, argv, want and warn, in table order. */
export function checkSetHash(checks) {
  const rows = checks.map(({ name, argv, want, warn }) => [name, argv, want, warn === true]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const wanted = (want) => (want === NONEMPTY ? "a non-blank line" : `a line "${want}"`);

// One row: null when it passed, else why it did not.
function probe({ argv, want }, cwd, env, timeoutMs) {
  const shown = argv.join(" ");
  if (argv.some((a) => a.startsWith("~/")) && !env.HOME) return `${shown} did not run: HOME is not set`;
  const [cmd, ...args] = argv.map((a) => (a.startsWith("~/") ? join(env.HOME, a.slice(2)) : a));
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: timeoutMs });
  // ENOENT and EACCES mean it never started; ETIMEDOUT and ENOBUFS mean it ran
  // and was killed, so a hung `gh` is not reported as a missing binary.
  if (r.error?.code === "ETIMEDOUT") return `${shown} timed out after ${timeoutMs}ms`;
  if (r.error?.code === "ENOBUFS") return `${shown} output exceeded maxBuffer`;
  if (r.error) return `${shown} did not run: ${r.error.code ?? r.error.message}`;
  if (r.status !== 0) {
    const last = r.stderr.trim().split("\n").at(-1);
    return `${shown} ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${last ? `: ${last}` : ""}`;
  }
  if (want === undefined) return null;
  const lines = r.stdout.split("\n").map((l) => l.trim());
  const said = lines.filter(Boolean);
  const hit = want === NONEMPTY ? said.length > 0 : lines.includes(want);
  return hit ? null : `${shown} printed ${said.length ? JSON.stringify(said.join(" ")) : "nothing"}, want ${wanted(want)}`;
}

function readMarker(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.checks;
  } catch {
    return null;
  }
}

/**
 * Run `checks` from the main checkout `cwd` belongs to, unless the marker
 * records this exact check set as passed. Writes the marker when no row
 * failed. Throws FleetDirUnresolvable when `cwd` is in no repository.
 *
 * Returns `{ skipped, marker, results: [{name, warn, ok, why}], failed,
 * writeError }`; `writeError` is null, or says why the marker could not be
 * written — the rows have run by then, so they come back with it.
 */
export function runPreflight({ checks = CHECKS, cwd = process.cwd(), env = process.env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const marker = fleetFile(MARKER_FILE, { cwd });
  const workspace = dirname(dirname(marker));
  const hash = checkSetHash(checks);
  if (readMarker(marker) === hash) return { skipped: true, marker, results: [], failed: [], writeError: null };

  const childEnv = gitEnv({}, env);
  const results = checks.map((c) => {
    const why = probe(c, workspace, childEnv, timeoutMs);
    return { name: c.name, warn: c.warn === true, ok: why === null, why };
  });
  const failed = results.filter((r) => !r.ok && !r.warn).map((r) => r.name);
  let writeError = null;
  if (failed.length === 0) {
    const tmp = `${marker}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify({ checks: hash, passed: new Date().toISOString() })}\n`);
      try {
        renameSync(tmp, marker);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      writeError = `cannot write ${marker}: ${e?.code ?? e?.message}`;
    }
  }
  return { skipped: false, marker, results, failed, writeError };
}

function main() {
  // No flags at all, so not defineFlags: its unknown-flag refusal lists the
  // accepted flags, and this script has none to list.
  if (process.argv.length > 2) die(`takes no arguments, got: ${process.argv.slice(2).join(" ")}`);
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
  if (r.writeError) die(r.writeError);
  console.log(`PREFLIGHT OK (${r.marker})`);
}

if (isCLI(import.meta.url)) main();
