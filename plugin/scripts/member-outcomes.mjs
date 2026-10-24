// Scraper for per-member model/effort facts. Pure over omp's own transcripts:
// no clock, no network, no gh. Two columns look beside the subagent ones:
// `work_s` also reads the controller's own `<session>.jsonl` next to the
// session directory, and `report` asks whether the member's report file is in
// the scratch root (`--scratch <dir>`, default the root scratch-root.mjs
// prints).
//
// The transcript parsing (fold, model/effort extraction, ticket/pr naming,
// and the `gh pr create` result an implementer's `pr` comes from)
// lives in member-record.mjs, shared with board.mjs. `normalizeModel`
// and `parseMemberName` are re-exported here verbatim so nothing importing
// them from this file needs to change.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { readOmpSession, normalizeModel, parseMemberName, isOmpSessionDirName } from "./member-record.mjs";
import { stripLevel } from "./tier-roles.mjs";
import { reportFamily, reportStatus, defaultScratch } from "./report-files.mjs";
import { FleetDirUnresolvable } from "./fleet-dir.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXED_SHA } from "./fleet-event.mjs";
import { parseReport, reportViolation } from "./report-schema.mjs";

export { normalizeModel, parseMemberName };

// One row per member, via member-record.mjs's readOmpSession(). This file's
// own row shape stays camelCase (`effort`, `tokensCacheCreate`, `tokensOut`,
// `wallS`) so the TSV/FIELD machinery below and every existing consumer are
// untouched, while the actual transcript parsing — the fold, model/effort
// last-wins, ticket/pr naming — lives in exactly one place and is the same
// primitive board.mjs's spend reader calls too, so the two can no longer
// drift.
//
// `effort` reads the record's `thinking` field: the TSV COLUMN stays
// named `effort` rather than renamed, because every awk one-liner in
// this file's header indexes columns by position, and a
// rename buys nothing a comment does not already say. `thinking` is never
// blank on the record (`-` marks the hole so it stays visible there), but
// this TSV's own `effort` column predates that convention and already
// documents blank as ITS spelling of "unknown" (header: "BLANK MEANS
// UNKNOWN") — so `-` maps back to `""` here, at the boundary, rather than
// widening the legacy column's vocabulary.
//
// `subagentType` is the record's `subagent_type` unchanged — `""` stays
// `""` here, because unlike `effort` it does NOT mean unknown: it means the
// transcript carried no `session_init` agent to read (no such line, or one
// without a string `agent`); an untyped dispatch is not that shape, since the
// omp reader records the generic `task` for it. That closed reading is what
// cell-readout.mjs's admissibility test depends on: a blank is never any
// cell's definition.
//
// A member is never torn in the sense this file historically tracked (no
// fold-back to tear mid-turn); `false` says so plainly rather than leaving
// the column blank, which would read as "unmeasured".
//
// The walk is RECURSIVE: a member can itself dispatch further members
// (measured on disk — a research session held seven more `.jsonl` files one
// level down), and `agent` is the path-relative stem, so a nested member's
// row reads `<parent>/<id>` while a flat one is unchanged — which is what
// lets this widening REPLACE the existing rows rather than duplicate them.
//
// `stats` is an optional out-param: callers that omit it behave exactly as
// before. The CLI needs it because a session where every member dropped was
// otherwise indistinguishable from a healthy one.
//
// run_date comes from the newest transcript's mtime rather than a clock
// read, so a backfill run in December still dates an August session in
// August.
export function rowsForSession(sessionDir, stats = {}, { verifyMain = verifyMainWithGit } = {}) {
  let names;
  try { names = readdirSync(sessionDir, { recursive: true }); }
  catch { names = []; }
  const jsonlNames = names.filter((x) => x.endsWith(".jsonl"));
  let newest = 0;
  for (const f of jsonlNames) {
    try { newest = Math.max(newest, statSync(join(sessionDir, f)).mtimeMs); } catch { /* raced away */ }
  }
  const activity = { stamps: [], unread: 0 };
  const recs = readOmpSession(sessionDir, activity); // may throw — a wrong-root refusal, not a per-file fault
  const controller = controllerStamps(sessionDir);
  const workUnknown = typeof controller === "string" ? controller
    : activity.unread ? `${activity.unread} unreadable transcript${activity.unread === 1 ? "" : "s"}` : null;
  const halts = workUnknown ? [] : haltsOf(activity.stamps.concat(controller));
  stats.workSUnknown = workUnknown;
  stats.seen = jsonlNames.length;
  stats.dropped = jsonlNames.length - recs.length;
  stats.torn = 0;
  const session = basename(sessionDir);
  const run_date = newest ? new Date(newest).toISOString().slice(0, 10) : "";
  const endings = endingsOf(recs, verifyMain);
  return recs.map((r, i) => ({
    session, run_date,
    harness: r.harness, role: r.role, member: r.member, model: r.model,
    effort: r.thinking === "-" ? "" : r.thinking, ticket: r.ticket, pr: r.pr,
    tokensCacheCreate: r.tokens_cache_create, tokensOut: r.tokens_out,
    wallS: r.wall_s, turns: r.turns, agent: r.agent, torn: false,
    subagentType: r.subagent_type,
    tokensIn: r.tokens_in, tokensCacheRead: r.tokens_cache_read,
    tokensCacheWrite1h: r.tokens_cache_write_1h ?? "", cost: r.cost == null ? "" : Number(r.cost.toFixed(6)),
    ending: endings[i],
    dispatchModel: dispatchModel(r.resolvedModelIdentity),
    workS: workUnknown ? null : r.transcript.timed ? workSeconds(r.transcript.workParts, halts) : "",
  }));
}

// The `work_s` column: a member's working time in whole seconds. Its parts
// are the fold's (member-record.mjs): each run of entries between two
// `session_exit` entries, from its first entry to its last, so omp's idle
// wait before each exit and the wait until a wake are in no part. Every halt
// is then subtracted where it falls inside a part. `wall_s` stays the raw
// span, teardown included.
//
// A halt is a stretch over HALT_MS in which no transcript of the run records
// an entry: every transcript in the session directory, nested ones and those
// that book no row included, and the controller's own `<session>.jsonl` beside
// the directory, the one that keeps writing while no member runs. Halts are
// the gaps between consecutive instants of that one sorted list, so no two
// overlap, and a part never shares time with another part of the same member:
// no overlap is subtracted twice.
//
// Without the controller transcript no halt can be told from a member's own
// quiet stretch, and with any transcript of the run unreadable, or a line of
// the controller's lost, entries are missing from the instants, so a stretch
// they wrote through reads as a halt. Each way every row's `work_s` is `null`:
// unknown, written blank, and never written over a recorded value
// (mergeRows); `stats.workSUnknown` names the cause. A transcript with no
// timestamped entry reads `""`, blank because there is nothing to time.
export const HALT_MS = 60 * 60 * 1000;

// The controller transcript's entry instants, in epoch ms, or a string naming
// why they cannot be had. It is not a member transcript, so a line is read for
// its timestamp alone. An unparseable LAST line is a write in progress and is
// skipped, as the member fold skips it; an unparseable line before it is lost
// data that may have been the entry breaking a stretch, so a halt there could
// not be told from the run writing, and the instants are unknown.
function controllerStamps(sessionDir) {
  let text;
  try { text = readFileSync(join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`), "utf8"); }
  catch (e) { return e?.code === "ENOENT" ? "no controller transcript" : `unreadable controller transcript: ${e?.code ?? e}`; }
  const stamps = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let d;
    try { d = JSON.parse(lines[i]); }
    catch { if (i !== lines.length - 1) return "an unparseable controller transcript line"; continue; }
    const ms = typeof d?.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (Number.isFinite(ms)) stamps.push(ms);
  }
  return stamps;
}

// Every gap over HALT_MS between consecutive instants, as [from, to].
export function haltsOf(stamps) {
  const sorted = [...stamps].sort((a, b) => a - b);
  const halts = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > HALT_MS) halts.push([sorted[i - 1], sorted[i]]);
  }
  return halts;
}

// The parts' summed length less each halt's share inside them, in whole seconds.
export function workSeconds(parts, halts) {
  let ms = 0;
  for (const [from, to] of parts) {
    if (!(to > from)) continue;
    ms += to - from;
    for (const [h0, h1] of halts) ms -= Math.max(0, Math.min(to, h1) - Math.max(from, h0));
  }
  return Math.round(ms / 1000);
}

// The `dispatch_model` column: the model fixed at dispatch, `session_init`'s
// own model (the record's `resolvedModelIdentity`), with its provider prefix
// and `:<level>` suffix stripped. `model` is the member's last turn, which a
// provider fallback moves; this one does not move. Blank when the transcript
// carries no `session_init` model: blank means unknown. Operator config is
// never read for it.
export function dispatchModel(identity) {
  return stripLevel(String(identity ?? "").trim()).split("/").at(-1);
}

// A column is APPENDED, never inserted, as a rule: a read-out that indexes by
// position (`$5`, in the file's header) silently repoints when one is added
// ahead of it. `report` is placed after `subagent_type` regardless, which
// moves the four priced columns one place right; every script that reads this
// file through parseTsv takes those four by name, and the header's
// position-indexed read-outs name columns ahead of them. `subagent_type`
// follows `harness`. `cost` is the provider's own per-turn `usage.cost.total`,
// summed to the micro-dollar — the $ of record; `tokens_cache_write_1h` and
// `cost` are blank where the transcript recorded no figure, never 0, and
// `cost` is also blank when any turn that reported tokens recorded none.
export const COLUMNS = [
  "session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
  "tokens_cache_create", "tokens_out", "wall_s", "turns", "agent", "harness",
  "subagent_type", "report", "tokens_in", "tokens_cache_read", "tokens_cache_write_1h", "cost",
  "ending", "dispatch_model", "work_s",
];

// `report`: what reportStatus() says of the row's member under `scratch` — a
// pure function of the member name and the file system, never of the
// transcript, so it is stamped here on the rows rowsForSession() returned.
// With no `scratch` (null: none could be resolved) a member a schema covers
// reads blank — unknown, the file's own spelling of it — and one none covers
// still reads `-`, which needs no file to look at.
export function withReports(rows, scratch) {
  return rows.map((r) => ({
    ...r,
    report: scratch === null && reportFamily(r.member) !== null ? "" : reportStatus(scratch, r.member),
  }));
}

// The `ending` column: how an implementer's run ENDED, read off its own
// transcript and the reports it wrote. Blank on every row that is not an
// implementer (the member's leaf is `impl-<N>`, with an optional retry
// suffix): blank there means "not an implementer row", not unknown. `unknown`
// is where the transcript cannot say: a malformed line, no transcript, or a
// fixed sha origin/main cannot answer. Precedence, first that applies wins:
//   pr            the row's pr is named, the member's own `gh pr create`
//                 opened one (more than one leaves the pr column blank), or
//                 the last report claims a PR an earlier same-ticket
//                 implementer opened in this session;
//   blocked       the last report blocks mid-implementation;
//   bail:<cause>  the last report bails (`fixed` is checked against main);
//   provider      a model fell back, or the last turn errored;
//   budget        a budget notice reached the member;
//   abort         the last turn was aborted;
//   crash         the session never exited and wrote no yield sidecar;
//   hollow        none of the above: the member stopped on its own.
const IMPLEMENTER_LEAF = /^impl-\d+(?:-[a-z0-9]+)?$/;
export const isImplementer = (member) => IMPLEMENTER_LEAF.test(member.split("/").pop());

export function endingOf({ member, pr, signals = null, earlierPrs = new Set(), verifyMain = verifyMainWithGit }) {
  if (!isImplementer(member)) return "";
  if (pr) return "pr";
  if (!signals || signals.malformedNonLastLines > 0) return "unknown";
  if (signals.openedPrs.length > 0) return "pr";
  const last = lastReport(signals.reportWrites, member.split("/").pop());
  if (last?.outcome === "pr" && earlierPrs.has(String(last.pr))) return "pr";
  if (last?.outcome === "blocked") return "blocked";
  // lastReport passed the impl schema, whose bailCause is a BAILS key or null.
  if (last?.bailCause) return bailEnding(last, verifyMain);
  if (signals.providerFallback || signals.lastStopReason === "error") return "provider";
  if (signals.budgetNotice) return "budget";
  if (signals.lastStopReason === "aborted") return "abort";
  if (!signals.sessionExit && !signals.hasYield) return "crash";
  return "hollow";
}

// The member's last report, when the last one it wrote is a valid impl report
// naming this member; null when it wrote none, or the last one is malformed.
// "Valid" is `reportViolation("impl", …)` as it stands now, so a last report
// that fails an impl rule is no report and the member reads the stop its
// transcript actually had (`provider`, `budget`, `abort`, `crash`, `hollow`).
// That includes a `bailed` report that names a `pr` or a `head`, and a
// `blocked` one that does: a bail is the pre-code outcome and a block reports
// no PR, so neither reads `bail:<cause>` or `blocked`. A `covered` bail names
// its PR in `bailDetail` with `pr: null`, and stays a bail.
// A transcript written before that rule existed is read under the current
// rule, so a re-scrape can turn a recorded `bail:<cause>` into a non-bail
// ending. The one recorded case is `impl-3655`, `bail:hands` with
// `pr: null` and a `head`, which reads `hollow` on its next re-scrape. That
// flip is accepted: it matches the glossary's "valid bail", and `mergeRows()`
// keeps no earlier `bail:*` row against it.
function lastReport(reportWrites, leaf) {
  const last = reportWrites.filter((r) => r.file === `${leaf}.json`).at(-1);
  if (!last) return null;
  const parsed = parseReport(last.content);
  if ("violation" in parsed) return null;
  if (reportViolation("impl", parsed.value) !== null) return null;
  return parsed.value.member === leaf ? parsed.value : null;
}

// A bail's ending: its cause, except `fixed`, which holds only while origin/main
// reaches the sha its detail opens with.
function bailEnding(report, verifyMain) {
  if (report.bailCause !== "fixed") return `bail:${report.bailCause}`;
  const m = FIXED_SHA.exec((report.bailDetail ?? "").trim());
  if (!m) return "unknown";
  const status = verifyMain(m[1]);
  if (status === 0) return "bail:fixed";
  if (status === 1) return "bail:fixed-refuted";
  return "unknown";
}

// Each record's ending. `earlierPrs` is the set of PRs the same-ticket
// implementers opened before this one started, so a continuation's report can
// name its predecessor's PR and still read `pr`. A record never joins itself:
// its own start is not before its own start. An `impl-<ticket>` record's `pr`
// is blank or its one opened PR, so `openedPrs` alone holds every PR it opened.
function endingsOf(recs, verifyMain) {
  return recs.map((r) => {
    const earlierPrs = new Set();
    if (r.ticket && isImplementer(r.member)) {
      for (const o of recs) {
        if (o.ticket !== r.ticket || !isImplementer(o.member)) continue;
        if (!(o.transcript.startedAt < r.transcript.startedAt)) continue;
        for (const n of o.transcript.openedPrs) earlierPrs.add(String(n));
      }
    }
    return endingOf({ member: r.member, pr: r.pr, signals: r.transcript, earlierPrs, verifyMain });
  });
}

// The verifier the `fixed` bail calls: `verify-sha.sh main <sha>` answers
// 0 when origin/main reaches the sha, 1 when it does not, and 2 when it could
// not say (its exit status, or none when the script did not run at all). A
// verifier that could not say leaves the bail `unknown`, so its own diagnosis
// goes to stderr: without it an offline scrape and a broken script both read
// as a bare `unknown`.
const VERIFY_SHA = fileURLToPath(new URL("./verify-sha.sh", import.meta.url));
function verifyMainWithGit(sha) {
  const r = spawnSync("sh", [VERIFY_SHA, "main", sha], { encoding: "utf8" });
  if (r.status === 0 || r.status === 1) return r.status;
  const why = r.error ? r.error.message : (r.stderr ?? "").trim() || `exit ${r.status ?? r.signal}`;
  process.stderr.write(`${NAME}: verify-sha.sh main ${sha} could not answer, so its fixed bail reads unknown: ${why}\n`);
  return 2;
}

// Row objects use camelCase; the file uses snake_case. One map, one direction
// each, so a rename cannot silently drop a column.
const FIELD = {
  tokens_cache_create: "tokensCacheCreate", tokens_out: "tokensOut", wall_s: "wallS",
  subagent_type: "subagentType", tokens_in: "tokensIn", tokens_cache_read: "tokensCacheRead",
  tokens_cache_write_1h: "tokensCacheWrite1h", dispatch_model: "dispatchModel", work_s: "workS",
};
const field = (c) => FIELD[c] ?? c;
// Keyed on the transcript's path-relative stem, not the member name: `member`
// collides on the agentType fallback for every unnamed dispatch, collapsing
// 2,715 rows onto 1,497 keys (measured). `agent` is unique WITHIN A SESSION,
// which is all the key needs — it is NOT globally unique, because a NAMED
// member's stem is derived from its name and so repeats across sessions.
const key = (r) => `${r.session}\0${r.agent}`;

// Replace-by-key, not append. This is what makes a close-out re-run and a full
// regeneration both safe, and it is the reason no backfill-only code path is
// needed: the idempotency backfill wants is the idempotency a re-run wants.
//
// Two cells are the exception, each keeping what the replaced row recorded
// where this scrape could not say. An incoming `unknown` ending keeps the
// recorded ending: `unknown` is this scrape failing to say (a verifier that is
// offline, a transcript gone unreadable), not a reading, so it never
// overwrites one: a recorded `bail:fixed` would otherwise flip to `unknown`
// on any re-scrape run without network. `stats.endingsKept` counts them. An
// incoming `null` work_s (halts that could not be found) keeps a
// recorded `work_s` the same way; `stats.workSKept` counts those.
export function mergeRows(existing, incoming, stats = {}) {
  const by = new Map((existing ?? []).map((r) => [key(r), r]));
  stats.endingsKept = 0;
  stats.workSKept = 0;
  for (const r of incoming ?? []) {
    const old = by.get(key(r));
    let row = r;
    if (r.ending === "unknown" && old?.ending && old.ending !== "unknown") {
      row = { ...row, ending: old.ending };
      stats.endingsKept++;
    }
    if (r.workS === null && (old?.workS ?? "") !== "") {
      row = { ...row, workS: old.workS };
      stats.workSKept++;
    }
    by.set(key(r), row);
  }
  return [...by.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

export function formatTsv(rows) {
  return rows.map((r) => COLUMNS.map((c) => String(r[field(c)] ?? "")).join("\t")).join("\n") + "\n";
}

// REFUSES a row whose cell count is not exactly COLUMNS.length rather than
// padding it. Padding looked harmless and was not: when this was written
// `agent` was the LAST column, so a short row parsed to `agent: ""` — a key
// rowsForSession can never produce, which means mergeRows can never REPLACE
// it. Three ways to reach that were measured, all previously exit 0: a
// transcript torn mid-write became a permanent phantom that re-scraping could
// not heal; git conflict markers became three data rows; and adding one column
// ahead of `agent` collapsed the corpus onto one key per session, 2,702 rows
// to 156. `agent` is no longer last — the priced columns follow it — and
// there a padded "" would read as "no figure was recorded" for a member whose
// transcript carried one, so a short row stays refused for that too.
export function parseTsv(text) {
  return String(text ?? "").split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const cells = l.split("\t");
      if (cells.length !== COLUMNS.length) {
        throw new Error(`malformed row: ${cells.length} fields, expected ${COLUMNS.length} — ${l.slice(0, 60)}`);
      }
      const r = {};
      COLUMNS.forEach((c, i) => { r[field(c)] = cells[i]; });
      return r;
    });
}

import { writeFileSync, existsSync, renameSync } from "node:fs";
import { isCLI } from "./is-cli.mjs";
import { makeDie, isFlagLike } from "./arg.mjs";

const NAME = "member-outcomes";

// Only runs as a CLI, never on import — the test file and any wrapper import
// the pure helpers. Exact identity (by realpath, see is-cli.mjs), not a suffix
// match: a suffix test fires for any file ending in this one's name.
if (isCLI(import.meta.url)) {
  const die = makeDie(NAME);
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf("--file");
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : "docs/metrics/member-outcomes.tsv";
  const scratchIdx = argv.indexOf("--scratch");
  const scratchArg = scratchIdx >= 0 ? argv[scratchIdx + 1] : null;
  // An unrecognised `--flag` is silently dropped by the dirs filter below
  // rather than refused — worst case `--file=/tmp/x.tsv` (no such flag;
  // --file wants a SPACE, not `=`) never sets fileIdx, so this would silently
  // write the production metrics file instead of the path the operator asked
  // for.
  const bad = argv.find((a) => a.startsWith("--") && a !== "--file" && a !== "--scratch");
  if (bad) die(`unknown option ${bad} (did you mean --file <path> or --scratch <dir>?)`);

  // fileIdx is -1 when --file is absent, which makes fileIdx + 1 equal 0 — the
  // FIRST positional argument, not a real index into argv. Without the
  // fileIdx < 0 guard this filters out the session dir itself, and the bare
  // form (the one the spec, the backfill loop and run-team's close-out scrape
  // instruction all use) always exits 2. `--scratch`'s value is skipped the
  // same way.
  const valueOf = (idx) => (i) => idx >= 0 && i === idx + 1;
  const isFileValue = valueOf(fileIdx);
  const isScratchValue = valueOf(scratchIdx);
  const dirs = argv.filter((a, i) => !a.startsWith("--") && !isFileValue(i) && !isScratchValue(i));
  if (dirs.length !== 1) die("usage: member-outcomes.mjs <session-dir> [--file <tsv>] [--scratch <dir>]");
  // arg.mjs's rule, consumed rather than copied. This line used to
  // hand-write `!file || file.startsWith("--")`, which was that rule with the
  // blank spelling missing — so `--file "   "` was accepted here and wrote the
  // metrics TSV to a whitespace-named path, while every script routing through
  // arg() refused it. That gap is what a copy costs and is why the predicate
  // is imported. The refusal WORDING stays this script's own: `--file` is the
  // flag the operator typed.
  if (isFlagLike(file)) die("--file needs a path");
  if (scratchIdx >= 0 && isFlagLike(scratchArg)) die("--scratch needs a path");
  // An explicit root that is not a directory is a mistyped path, and reading it
  // as a root would stamp `absent` on every covered row and, by the replace-by-key
  // merge, over a recorded `ok`/`invalid` — indistinguishable from "wrote no report".
  if (scratchIdx >= 0) {
    let isDir = false;
    try { isDir = statSync(scratchArg).isDirectory(); }
    catch (e) { die(`cannot read --scratch ${scratchArg}: ${e.code ?? e.message}`); }
    if (!isDir) die(`--scratch ${scratchArg} is not a directory`);
  }

  const sessionDir = dirs[0].replace(/\/+$/, "");
  // A wrong guess used to exit 0 having scraped and written nothing, because
  // rowsForSession() catches the readdir failure and returns []. Probe with
  // the SAME call it makes: an existsSync test closes only the ENOENT half,
  // and EACCES (an unreadable dir) and ENOTDIR (a regular FILE, not a
  // directory) both walked straight past it back into the silent exit 0.
  try { readdirSync(sessionDir); }
  catch (e) { die(`cannot read ${sessionDir}: ${e.code ?? e.message}`); }
  // The session-dir-name rule already covers `readMembers`'s tree search (findOmpSessionDirs);
  // this CLI hands rowsForSession one EXPLICIT directory instead of a tree to
  // search, which skipped that check entirely — any readable directory (e.g. the
  // encoded-cwd project dir one level up from a real session) passed the readdirSync
  // probe above, then had every nested .jsonl folded in and every row stamped with
  // the PROJECT dir's own name as `session`, never a real omp session id.
  if (!isOmpSessionDirName(basename(sessionDir))) {
    die(`${sessionDir} is not an omp <ISO>_<uuid> session directory`);
  }

  // Header comments are preserved verbatim across the rewrite: they carry the
  // read-out commands and the blank-means-unknown rule, and the rewrite is
  // routine (every re-scrape), so losing them would be a slow, silent erasure.
  //
  // The LEADING block only. Collecting every `#` line from anywhere hoisted a
  // below-data note to the top, away from the row it annotated, and dropped the
  // blank lines between paragraphs — silently, while promising "verbatim".
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  const prevLines = prev ? prev.split("\n") : [];
  let h = 0;
  while (h < prevLines.length && (prevLines[h].startsWith("#") || !prevLines[h].trim())) h++;
  const header = prevLines.slice(0, h).join("\n").replace(/\n+$/, "");

  let existing;
  try { existing = parseTsv(prev); }
  catch (e) { die(`${file} is not readable as this schema: ${e.message}`); }

  let scratch = scratchArg;
  if (scratch === null) {
    try { scratch = defaultScratch(); }
    catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      process.stderr.write(`${NAME}: WARNING no scratch root to look for report files in (${e.message}) — \`report\` is left blank where a schema covers the member; pass --scratch <dir>\n`);
    }
  }

  const stats = {};
  const merged = mergeRows(existing, withReports(rowsForSession(sessionDir, stats), scratch), stats);
  // Write-then-rename: writeFileSync truncates before it writes, so an interrupt
  // over the committed corpus left a torn file that the NEXT scrape read, merged
  // and rewrote — losing every other session's rows for good.
  writeFileSync(file + ".tmp", (header ? header + "\n" : "") + formatTsv(merged));
  renameSync(file + ".tmp", file);
  // Report the SCRAPE, not just the file. `merged.length` is the whole corpus,
  // so a session where every member dropped printed the same reassuring line as
  // a healthy one — 0-of-2 was indistinguishable from full success.
  const torn = stats.torn ? `, ${stats.torn} torn mid-write` : "";
  const kept = stats.endingsKept ? `, ${stats.endingsKept} read unknown and kept the ending already recorded` : "";
  // Whatever left every row's `work_s` unknown, and how many rows kept the
  // value already recorded, after the yield rather than inside it.
  const workKept = stats.workSKept ? `, ${stats.workSKept} kept the work_s already recorded` : "";
  const work = stats.workSUnknown ? `; work_s unknown (${stats.workSUnknown})${workKept}` : "";
  process.stderr.write(
    `${NAME}: scraped ${stats.seen - stats.dropped} of ${stats.seen} members ` +
    `(${stats.dropped} dropped${torn}${kept}); ${file} now holds ${merged.length} rows${work}\n`,
  );
}
