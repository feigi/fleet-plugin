#!/usr/bin/env node
// The run's metrics duties that keep the router's inputs current: move the
// pending ticket-features rows into the tracked corpus, widen a member-outcomes
// corpus written before its latest columns, refresh the cost guard over it, then
// write the Preview fit beside that guard.
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
// not run. So does a row whose cell breaks its column's grammar at the file's
// width (`run_date` blank or a date; the token, time, `turns` and `cost`
// columns blank or a non-negative decimal; `harness` omp or claude; `report`
// blank or a reportStatus() value; `ending` one of endingOf()'s values on an
// implementer's row, blank on any other), the failure naming the line and the
// leftmost column that breaks, with its value: a tab inside a cell on every
// row, or on the only one, makes the file look one column wider and moves each
// cell after it one column right. Its limit: a tab whose split halves still fit
// their columns' grammar is widened — a trailing tab in the last cell of a
// reviewer row is byte for byte a real row one column wider.
//
// COST GUARD. `pr-cost.mjs --guard` rewrites `.fleet/cost-guard.json`, which
// the router reads and fails closed without. It needs all three metrics TSVs;
// a workspace that lacks one has no corpus to guard yet (its first run), so the
// guard is skipped with a line naming the missing file and
// `.fleet/cost-guard.json` is left as it is. Its exit 3 (a cell tripped) and 4
// (no verdict yet — the baseline cell has too few merged PRs) are verdicts the
// router and `fleet-tick.mjs` consume, not failures; any other non-zero exit is.
//
// PREVIEW FIT. After the cost guard wrote a guard, and only then, the Router's
// fit (`ticket-router.mjs`'s fitTable) runs in-process over the working-tree
// TSVs the guard just read and the guard just written, with the installed
// router table (`router-table.json` beside the scripts) as its prior and no
// commit. It writes `.fleet/router-preview.json` through a temp file and a
// rename: `computed_at`, `guard_computed_at` (the guard's own `computed_at`),
// `tsv_blobs` (the git blob id of each TSV it read, keyed by path as the guard
// keys its own), `prior` (the installed table's `fitted_commit`, `stage`,
// `cells`, `classifier` and `window_start`, and the install's `package.json`
// `version`) and the fitted `table`. The cockpit lays it out as what the
// evidence favours; nothing routes by it and nothing commits it. It is called
// in-process because a fit has no verdict for an exit status to carry, and the
// `fit` CLI reads the TSVs only as committed. It never fails the run: an error
// prints `metrics-refresh: preview: failed — <why>`, leaves the old file in
// place and leaves the exit status as the other duties set it. That line stays
// on stdout: the cockpit reads it off the receipts' `metrics` step, and
// close-out's receipt keeps only stdout from a run that exits 0.
//
// One `metrics-refresh: <duty>: …` line per duty on stdout. Exit 0 when no
// duty failed; 1 when one failed — named on stderr, and the duties after
// it did not run (each is safe to run again); 2 on a usage error. The
// Preview fit is not one of those duties: it never sets the exit status.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { isCLI } from "./is-cli.mjs";
import { COLUMNS as MEMBER_COLUMNS, ENDINGS, isImplementer, parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { blobId } from "./pr-cost.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "./pull-attribution.mjs";
import { REPORT_STATUSES } from "./report-files.mjs";
import { DEFAULT_TABLE, fitTable, readGuard, validateTable } from "./ticket-router.mjs";
import { parseTierOutcomes } from "./tier-outcomes.mjs";

const NAME = "metrics-refresh";
const PR_COST = fileURLToPath(new URL("./pr-cost.mjs", import.meta.url));
const PENDING = join(".fleet", "ticket-features.pending.tsv");
const FEATURES = join("docs", "metrics", "ticket-features.tsv");
const MEMBERS = join("docs", "metrics", "member-outcomes.tsv");
const TIERS = join("docs", "metrics", "tier-outcomes.tsv");
const CORPUS = [MEMBERS, TIERS, FEATURES];
const GUARD = join(".fleet", "cost-guard.json");
const PREVIEW = join(".fleet", "router-preview.json");
// The install's own package.json, whose `version` names the prior.
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));
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
// width before `ending` shipped (merged 2026-10-22). Every width from it up to the current
// one is a file of this corpus written before the columns past that width existed.
const MEMBER_FIRST_WIDTH = MEMBER_COLUMNS.indexOf("ending");
const MEMBER_NAME_AT = MEMBER_COLUMNS.indexOf("member");

// The grammar of every member-outcomes column the widen checks, as [test(cell, cells), what it
// expected]. The free-text columns (`model`, `effort`, `member`, `agent`, `subagent_type`,
// `dispatch_model`) and `role` have none here, and neither does `work_s`: it is the current
// width's last column, so no width the widen reads reaches it. A blank `run_date` is unknown —
// rowsForSession() writes one when no transcript's mtime can be read, or every one is the epoch.
const DECIMAL = [(v) => /^(?:\d+(?:\.\d+)?)?$/.test(v), "blank or a non-negative decimal"];
const MEMBER_GRAMMAR = {
  run_date: [(v) => /^(?:\d{4}-\d{2}-\d{2})?$/.test(v), "blank or a YYYY-MM-DD date"],
  tokens_cache_create: DECIMAL, tokens_out: DECIMAL, wall_s: DECIMAL, turns: DECIMAL, tokens_in: DECIMAL,
  tokens_cache_read: DECIMAL, tokens_cache_write_1h: DECIMAL, cost: DECIMAL,
  harness: [(v) => v === "omp" || v === "claude", "omp or claude"],
  report: [(v) => v === "" || REPORT_STATUSES.includes(v), `blank or one of ${REPORT_STATUSES.join(", ")}`],
  ending: [
    (v, cells) => (isImplementer(cells[MEMBER_NAME_AT]) ? ENDINGS.has(v) : v === ""),
    "one of endingOf()'s values on an implementer's row, blank on any other",
  ],
};
// In column order, so a row that breaks several columns is refused naming the leftmost.
const MEMBER_CHECKED = Object.entries(MEMBER_GRAMMAR)
  .map(([c, [ok, what]]) => ({ c, at: MEMBER_COLUMNS.indexOf(c), ok, what }))
  .sort((a, b) => a.at - b.at);

// `text`, a member-outcomes TSV at an earlier width, at the current one, with the columns it
// lacks appended to every row. The file has no header row, so a row's width is the only thing
// that says which columns it holds; leading comments and every cell already there are kept.
// An appended cell is blank, which that file's own rule reads as unknown — except `ending` on
// an implementer's row, where blank means "not an implementer": that reads `unknown`. Rows of
// one width other than the current or an earlier one, and a file whose rows are not all of
// one width, throw: parseTsv's refusal to guess a row's columns stands, and this does not
// widen what it would not read. So does a row with a cell that breaks MEMBER_GRAMMAR for the
// column it sits in at that width, the error naming the leftmost such column: a tab inside a
// cell, on every row or the only one, makes a file look one column wider than it is and moves
// each cell after it one column right, where `agent` lands in `harness` and `cost` in
// `ending`. Its limit: a tab whose split halves still fit the grammar of the columns they land
// in is widened — a trailing tab in the last cell of a reviewer row is byte for byte a real row
// one column wider. A row ending in a CR (a CRLF file) is checked without that CR, and gains
// its cells before it, so the CR stays the row's last byte. A file with no rows comes back as
// `{ rows: 0 }`, and one already at the current width as null, unchecked: neither has anything
// to write.
function widenMembers(text) {
  const lines = text.split("\n");
  const rows = [];
  lines.forEach((l, i) => { if (l.trim() && !l.startsWith("#")) rows.push(i); });
  if (!rows.length) return { rows: 0 };
  const markerAt = rows.find((i) => /^(<{7}|={7}|>{7})( |\r?$)/.test(lines[i]));
  if (markerAt !== undefined) throw new Error(`git conflict marker — ${lines[markerAt].slice(0, 60)}`);
  const widths = [...new Set(rows.map((i) => lines[i].split("\t").length))].sort((a, b) => a - b);
  if (widths.length > 1) throw new Error(`rows of different widths (${widths.join(", ")}) — a file is written at one width`);
  const [width] = widths;
  if (width === MEMBER_COLUMNS.length) return null;
  if (width < MEMBER_FIRST_WIDTH || width > MEMBER_COLUMNS.length) {
    const row = lines[rows[0]];
    throw new Error(`malformed row: ${width} fields, expected ${MEMBER_COLUMNS.length} (or an earlier ${MEMBER_FIRST_WIDTH} to ${MEMBER_COLUMNS.length - 1}) — ${row.slice(0, 60)}`);
  }
  const checked = MEMBER_CHECKED.filter(({ at }) => at < width);
  const added = MEMBER_COLUMNS.slice(width);
  for (const i of rows) {
    const eol = lines[i].endsWith("\r") ? "\r" : "";
    const cells = lines[i].slice(0, lines[i].length - eol.length).split("\t");
    const bad = checked.find(({ at, ok }) => !ok(cells[at], cells));
    if (bad) {
      throw new Error(`line ${i + 1}: \`${bad.c}\` is ${JSON.stringify(cells[bad.at])}, expected ${bad.what}, read at ${width} columns`
        + ` — a tab inside a cell, or a hand edit, moves every cell after it one column — ${lines[i].slice(0, 60)}`);
    }
    lines[i] = [...cells, ...added.map((c) => (c === "ending" && isImplementer(cells[MEMBER_NAME_AT]) ? "unknown" : ""))].join("\t") + eol;
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
  if (widened === null) return say(`member-outcomes: already ${MEMBER_COLUMNS.length} columns`);
  if (widened.rows === 0) return say("member-outcomes: no rows to widen");
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

// The guard file it wrote, parsed, or null when it skipped and wrote none.
function costGuard(repo) {
  const missing = CORPUS.filter((f) => !existsSync(join(repo, f)));
  if (missing.length) {
    say(`cost guard: skipped, ${missing.join(", ")} not found — no corpus to guard yet; ${GUARD} left as it is`);
    return null;
  }
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
  return g;
}

// The install's `package.json` `version`, or null when it names none or cannot be read:
// the prior is named by it, and the fit does not need it.
function installVersion(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"))?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// The Preview fit over `repo`'s working-tree TSVs and `written`, the guard file the
// guard duty just wrote (parsed), with the router table at `tablePath` as its
// prior, written to `.fleet/router-preview.json` through a temp file and a
// rename. Throws on anything it cannot read, fit or write, before the rename, so
// the old file stays as it was.
export function writePreview(repo, written, { tablePath = DEFAULT_TABLE, packagePath = PACKAGE, now = new Date() } = {}) {
  const guard = readGuard(written);
  if (guard === null) throw new Error(`${GUARD} is not a guard the router reads`);
  let prior;
  try {
    prior = validateTable(JSON.parse(readFileSync(tablePath, "utf8")));
  } catch (e) {
    throw new Error(`cannot read the installed router table ${tablePath}: ${e.code ?? e.message}`);
  }
  if (prior instanceof Error) throw new Error(`${tablePath}: ${prior.message}`);
  // Keyed by the path as the guard keys its own (pr-cost.mjs reads these, relative to the workspace).
  const tsvBlobs = {};
  const read = (rel, parse) => {
    const bytes = readFileSync(join(repo, rel));
    tsvBlobs[rel] = blobId(bytes);
    try { return parse(bytes.toString("utf8")); } catch (e) { throw new Error(`${rel}: ${e.message}`); }
  };
  const members = read(MEMBERS, parseMemberTsv);
  const verdicts = read(TIERS, parseTierOutcomes);
  const features = read(FEATURES, parseFeatures);
  const table = fitTable({ prior, features, members, verdicts, guard, commit: null });
  const preview = {
    computed_at: now.toISOString(),
    guard_computed_at: written.computed_at,
    tsv_blobs: Object.fromEntries(Object.entries(tsvBlobs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    prior: {
      fitted_commit: prior.fitted_commit,
      version: installVersion(packagePath),
      stage: prior.stage,
      cells: prior.cells,
      classifier: prior.classifier,
      window_start: prior.window_start,
    },
    table,
  };
  const file = join(repo, PREVIEW);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(preview, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return preview;
}

// The Preview fit as the run calls it: only beside a guard the guard duty wrote, and
// never a failure of the run — its error is a line, and the exit stays as it was.
function preview(repo, written) {
  if (written === null) return say(`preview: skipped, no guard written — ${PREVIEW} left as it is`);
  let p;
  try {
    p = writePreview(repo, written);
  } catch (e) {
    return say(`preview: failed — ${e.message}`);
  }
  say(`preview: fitted ${p.table.n_rows} Pull${p.table.n_rows === 1 ? "" : "s"}, stage ${p.table.stage}${p.table.burn_in ? ", in burn-in" : ""}; ${PREVIEW} computed ${p.computed_at}`);
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
  let written = null;
  for (const [name, duty] of [["drain", drain], ["member-outcomes", widenMemberOutcomes], ["cost guard", costGuard]]) {
    try {
      const out = duty(repo);
      if (duty === costGuard) written = out;
    } catch (e) {
      process.stderr.write(`${NAME}: ${name} failed: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }
  preview(repo, written);
}

if (isCLI(import.meta.url)) main();
