#!/usr/bin/env node
// The run's two metrics duties that keep the router's inputs current: move the
// pending ticket-features rows into the tracked corpus, then refresh the cost
// guard over it.
//
//   metrics-refresh.mjs [--repo <dir>]
//
//   --repo   the workspace whose `.fleet/` and `docs/metrics/` the duties read
//            and write; default the main checkout of the repository the cwd is
//            in, where the router script appends its pending rows
//
// DRAIN. `ticket-router.mjs route` appends one row per Pull to
// `.fleet/ticket-features.pending.tsv`; this moves them into
// `docs/metrics/ticket-features.tsv`, deduped on `session` + `agent`, and
// deletes the pending file. A crash between the write and the delete leaves
// rows the next drain finds already there, so a second run changes nothing.
// A pending file that is empty, or blank lines only, is removed with its own
// line: an append created it and never wrote.
// Only the run's controller appends to the pending file and drains it, and it
// does both serially, so nothing appends between the read and either unlink.
// The drain takes no lock by design: a second controller on one checkout is
// refused at phase 0.
//
// COST GUARD. `pr-cost.mjs --guard` rewrites `.fleet/cost-guard.json`, which
// the router reads and fails closed without. It needs all three metrics TSVs;
// a workspace that lacks one has no corpus to guard yet (its first run), so the
// guard is skipped with a line naming the missing file and
// `.fleet/cost-guard.json` is left as it is. Its exit 3 (a cell tripped) and 4
// (no verdict yet — the baseline cell has too few merged PRs) are verdicts the
// router and `fleet-tick.mjs` consume, not failures; any other non-zero exit is.
//
// One `metrics-refresh: <duty>: …` line per duty on stdout. Exit 0 when
// neither duty failed; 1 when one failed — named on stderr, and the duty after
// it did not run (each is safe to run again); 2 on a usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { isCLI } from "./is-cli.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "./pr-cost.mjs";

const NAME = "metrics-refresh";
const PR_COST = fileURLToPath(new URL("./pr-cost.mjs", import.meta.url));
const PENDING = join(".fleet", "ticket-features.pending.tsv");
const FEATURES = join("docs", "metrics", "ticket-features.tsv");
const CORPUS = [join("docs", "metrics", "member-outcomes.tsv"), join("docs", "metrics", "tier-outcomes.tsv"), FEATURES];
const GUARD = join(".fleet", "cost-guard.json");
// pr-cost.mjs --guard: 0 no cell tripped, 3 a cell tripped, 4 no verdict yet —
// all three are verdicts its readers consume; anything else is a failure.
const GUARD_VERDICT_EXITS = new Set([0, 3, 4]);
const MAX_BUFFER = 64 * 1024 * 1024;

const say = (line) => process.stdout.write(`${NAME}: ${line}\n`);
const headerOf = (text) => String(text).split("\n").find((l) => l.trim() && !l.startsWith("#")).split("\t");
const pullKey = (r) => `${r.session}\0${r.agent}`;

function drain(repo) {
  const pending = join(repo, PENDING);
  if (!existsSync(pending)) return say(`drain: nothing pending in ${PENDING}`);
  const pendingText = readFileSync(pending, "utf8");
  if (pendingText.trim() === "") {
    unlinkSync(pending);
    return say(`drain: ${PENDING} was empty — removed (an append created it and never wrote: crash or full disk)`);
  }
  let incoming;
  try {
    incoming = parseFeatures(pendingText);
  } catch (e) {
    throw new Error(`${PENDING}: ${e.message}`);
  }
  const target = join(repo, FEATURES);
  let text = existsSync(target) ? readFileSync(target, "utf8") : `${FEATURE_COLUMNS.join("\t")}\n`;
  const seen = new Set(parseFeatures(text).map(pullKey));
  const header = headerOf(text);
  const unknown = headerOf(pendingText).filter((c) => !header.includes(c));
  if (unknown.length) throw new Error(`${PENDING} carries ${unknown.join(", ")}, which ${FEATURES} has no column for`);
  const added = [];
  for (const r of incoming) {
    if (seen.has(pullKey(r))) continue;
    seen.add(pullKey(r));
    added.push(header.map((c) => r[c] ?? "").join("\t"));
  }
  if (added.length) {
    if (!text.endsWith("\n")) text += "\n";
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, `${text}${added.join("\n")}\n`);
    renameSync(`${target}.tmp`, target);
  }
  unlinkSync(pending);
  say(`drain: ${added.length} row${added.length === 1 ? "" : "s"} from ${PENDING} into ${FEATURES} (${incoming.length - added.length} already there)`);
}

function costGuard(repo) {
  const missing = CORPUS.filter((f) => !existsSync(join(repo, f)));
  if (missing.length) return say(`cost guard: skipped, ${missing.join(", ")} not found — no corpus to guard yet; ${GUARD} left as it is`);
  const out = join(repo, GUARD);
  const r = spawnSync(process.execPath, [PR_COST, "--guard", "--out", out], {
    cwd: repo, encoding: "utf8", env: gitEnv(), maxBuffer: MAX_BUFFER,
  });
  if (!GUARD_VERDICT_EXITS.has(r.status)) {
    throw new Error(`pr-cost.mjs --guard exited ${r.error?.code ?? r.status ?? r.signal}: ${String(r.stderr ?? "").trim()}`);
  }
  const g = JSON.parse(readFileSync(out, "utf8"));
  const tripped = g.tripped.map((t) => (typeof t === "string" ? t : t?.cell));
  say(`cost guard: verdict ${g.verdict}${tripped.length ? ` (tripped: ${tripped.join(", ")})` : ""}, pr-cost.mjs exit ${r.status}; ${GUARD} computed ${g.computed_at}`);
}

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, { flags: { repo: "value" } });
  F.sweep();
  F.stray();
  let repo = F.arg("repo") === null ? null : resolve(F.arg("repo"));
  if (repo === null) {
    try {
      repo = dirname(fleetFile(null));
    } catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      die(`${e.message} — pass --repo <dir>`);
    }
  }
  for (const [name, duty] of [["drain", drain], ["cost guard", costGuard]]) {
    try {
      duty(repo);
    } catch (e) {
      process.stderr.write(`${NAME}: ${name} failed: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }
}

if (isCLI(import.meta.url)) main();
