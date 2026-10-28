#!/usr/bin/env node
// The run's three metrics duties that keep the router's inputs current: move the
// pending ticket-features rows into the tracked corpus, widen a member-outcomes
// corpus written before its latest columns, then refresh the cost guard over it.
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
// A corpus written before a column the pending file carries — one the row
// grammar names — gains that column, blank on every row it already holds.
// A pending file that is empty, or blank lines only, is removed with its own
// line: an append created it and never wrote.
// The drain takes no lock by design: it assumes only the run's controller
// appends to the pending file and drains it, serially, so nothing appends
// between the read and either unlink. One controller per checkout is the
// rule, but phase 0 refuses a second one at its ledger rotation, which runs
// after its drain step, so a second controller's drain is not guarded.
//
// MEMBER-OUTCOMES WIDEN. `member-outcomes.mjs` refuses a row that is not exactly
// as wide as its current columns, so a consumer's `docs/metrics/member-outcomes.tsv`
// written before `ending`, `dispatch_model` or `work_s` shipped (20, 21 or 22
// columns; the file has no header row, so width is all that tells) could not be
// read by phase 0, the close-out scrape or `tier-outcomes.mjs append`. This
// appends the missing columns to every row, so every consumer widens at its next
// run start. Cells already there and the leading comments stay as written; an
// added cell is blank (unknown), except `ending` on an implementer's row, which
// is `unknown`, because blank there means "not an implementer". A file at the
// current width is not touched, so a second run changes nothing. Rows of any
// other width, rows of mixed widths and git conflict markers fail the duty,
// naming the file, and the file is left as it was; the cost guard after it does
// not run.
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
import { COLUMNS as MEMBER_COLUMNS, isImplementer } from "./member-outcomes.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "./pull-attribution.mjs";

const NAME = "metrics-refresh";
const PR_COST = fileURLToPath(new URL("./pr-cost.mjs", import.meta.url));
const PENDING = join(".fleet", "ticket-features.pending.tsv");
const FEATURES = join("docs", "metrics", "ticket-features.tsv");
const MEMBERS = join("docs", "metrics", "member-outcomes.tsv");
const CORPUS = [MEMBERS, join("docs", "metrics", "tier-outcomes.tsv"), FEATURES];
const GUARD = join(".fleet", "cost-guard.json");
// pr-cost.mjs --guard: 0 no cell tripped, 3 a cell tripped, 4 no verdict yet —
// all three are verdicts its readers consume; anything else is a failure.
const GUARD_VERDICT_EXITS = new Set([0, 3, 4]);
const MAX_BUFFER = 64 * 1024 * 1024;

const say = (line) => process.stdout.write(`${NAME}: ${line}\n`);
const headerOf = (text) => String(text).split("\n").find((l) => l.trim() && !l.startsWith("#")).split("\t");
const pullKey = (r) => `${r.session}\0${r.agent}`;

// `text`, a features TSV, with `columns` appended: named on its header line, blank on each row.
function widen(text, columns) {
  let header = true;
  return text.split("\n").map((l) => {
    if (!l.trim() || l.startsWith("#")) return l;
    const added = header ? columns : columns.map(() => "");
    header = false;
    return [l, ...added].join("\t");
  }).join("\n");
}

// The first width a member-outcomes.tsv was ever written at that a later column widened: the
// width before `ending` shipped (2026-10-21). Every width from it up to the current one is a
// file of this corpus written before the columns past that width existed.
const MEMBER_FIRST_WIDTH = MEMBER_COLUMNS.indexOf("ending");
const MEMBER_NAME_AT = MEMBER_COLUMNS.indexOf("member");

// `text`, a member-outcomes TSV at an earlier width, at the current one, with the columns it
// lacks appended to every row. The file has no header row, so a row's width is the only thing
// that says which columns it holds; leading comments and every cell already there are kept.
// An appended cell is blank, which that file's own rule reads as unknown — except `ending` on
// an implementer's row, where blank means "not an implementer": that reads `unknown`. Rows of
// one width other than the current or an earlier one, and a file whose rows are not all of
// one width, throw: parseTsv's refusal to guess a row's columns stands, and this does not
// widen what it would not read. A file already at the current width comes back as it is.
function widenMembers(text) {
  const lines = String(text).split("\n");
  const rows = [];
  lines.forEach((l, i) => { if (l.trim() && !l.startsWith("#")) rows.push(i); });
  const marker = rows.map((i) => lines[i]).find((l) => /^(<{7}|={7}|>{7})( |$)/.test(l));
  if (marker !== undefined) throw new Error(`git conflict marker — ${marker.slice(0, 60)}`);
  const widths = [...new Set(rows.map((i) => lines[i].split("\t").length))].sort((a, b) => a - b);
  if (widths.length > 1) throw new Error(`rows of different widths (${widths.join(", ")}) — a file is written at one width`);
  const [width = MEMBER_COLUMNS.length] = widths;
  if (width === MEMBER_COLUMNS.length) return { text, width, rows: 0 };
  if (width < MEMBER_FIRST_WIDTH || width > MEMBER_COLUMNS.length) {
    const row = lines[rows[0]];
    throw new Error(`malformed row: ${width} fields, expected ${MEMBER_COLUMNS.length} (or an earlier ${MEMBER_FIRST_WIDTH} to ${MEMBER_COLUMNS.length - 1}) — ${row.slice(0, 60)}`);
  }
  const added = MEMBER_COLUMNS.slice(width);
  for (const i of rows) {
    const cells = lines[i].split("\t");
    const implementer = isImplementer(cells[MEMBER_NAME_AT]);
    lines[i] = [...cells, ...added.map((c) => (c === "ending" && implementer ? "unknown" : ""))].join("\t");
  }
  return { text: lines.join("\n"), width, rows: rows.length };
}

function widenMemberOutcomes(repo) {
  const file = join(repo, MEMBERS);
  if (!existsSync(file)) return say(`member-outcomes: skipped, ${MEMBERS} not found — no corpus to widen yet`);
  let widened;
  try {
    widened = widenMembers(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${MEMBERS}: ${e.message}`);
  }
  if (widened.rows === 0) return say(`member-outcomes: already ${MEMBER_COLUMNS.length} columns`);
  writeFileSync(`${file}.tmp`, widened.text);
  renameSync(`${file}.tmp`, file);
  say(`member-outcomes: widened ${widened.rows} row${widened.rows === 1 ? "" : "s"} from ${widened.width} to ${MEMBER_COLUMNS.length} columns`);
}

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
  const had = headerOf(text);
  const newer = headerOf(pendingText).filter((c) => !had.includes(c));
  const unknown = newer.filter((c) => !FEATURE_COLUMNS.includes(c));
  if (unknown.length) throw new Error(`${PENDING} carries ${unknown.join(", ")}, which ${FEATURES} has no column for`);
  if (newer.length) text = widen(text, newer);
  const header = [...had, ...newer];
  const added = [];
  for (const r of incoming) {
    if (seen.has(pullKey(r))) continue;
    seen.add(pullKey(r));
    added.push(header.map((c) => r[c] ?? "").join("\t"));
  }
  if (added.length || newer.length) {
    if (!text.endsWith("\n")) text += "\n";
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, `${text}${added.map((l) => `${l}\n`).join("")}`);
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
  for (const [name, duty] of [["drain", drain], ["member-outcomes", widenMemberOutcomes], ["cost guard", costGuard]]) {
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
