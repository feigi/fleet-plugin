// Scraper for per-member model/effort facts. Pure over the harness's own
// subagent transcripts: no clock, no network, no gh. See
// docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md.
//
// The Claude-specific parsing (message.id fold-back, model/effort
// extraction, ticket/pr naming) now lives in member-record.mjs (#1342),
// shared with board.mjs and with the omp reader. `normalizeModel` and
// `parseMemberName` are re-exported here verbatim so nothing importing them
// from this file needs to change.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { readClaudeMember, readOmpSession, isOmpSessionDirName, normalizeModel, parseMemberName } from "./member-record.mjs";

export { normalizeModel, parseMemberName };

// One row from one Claude member's transcript plus its meta. Takes TEXT
// rather than a path so it stays pure — the file reading lives in
// rowsForSession().
//
// A thin adapter over member-record.mjs's readClaudeMember(): this file's own
// row shape stays camelCase (`effort`, `tokensCacheCreate`, `tokensOut`,
// `wallS`) so the TSV/FIELD machinery below and every existing consumer are
// untouched, while the actual transcript parsing — the message.id fold-back,
// model/effort last-wins, ticket/pr naming — lives in exactly one place and
// is the same primitive board.mjs's readAgent now calls too, so the two can
// no longer drift the way they once did.
// `effort` reads the record's `thinking` field: #1342 keeps the TSV COLUMN
// named `effort` rather than renaming it, because every awk one-liner in
// this file's header and in docs/specs indexes columns by position, and a
// rename buys nothing a comment does not already say. `thinking` is never
// blank on the record (`-` marks the hole so it stays visible there), but
// this TSV's own `effort` column predates that convention and already
// documents blank as ITS spelling of "unknown" (header: "BLANK MEANS
// UNKNOWN") — so `-` maps back to `""` here, at the boundary, rather than
// widening the legacy column's vocabulary.
//
// `subagentType` is the record's `subagent_type` unchanged — `""` stays
// `""` here, because unlike `effort` it does NOT mean unknown: it means the
// dispatch named no agent definition, which is the reading the pair query
// in this file's header depends on.
export function readMember(jsonlText, meta) {
  const rec = readClaudeMember(jsonlText, meta);
  if (!rec) return null;
  return {
    harness: rec.harness, role: rec.role, member: rec.member, model: rec.model,
    effort: rec.thinking === "-" ? "" : rec.thinking, ticket: rec.ticket, pr: rec.pr,
    tokensCacheCreate: rec.tokens_cache_create, tokensOut: rec.tokens_out,
    wallS: rec.wall_s, turns: rec.turns, torn: rec.torn,
    subagentType: rec.subagent_type,
  };
}

// One row per omp member, via member-record.mjs's readOmpSession(). Kept
// beside readMember rather than merged into it: the two harnesses hand this
// file records shaped identically at the member-record.mjs boundary but with
// different provenance (a meta.json sidecar vs a session_init/thinking_level
// walk), and rowsForSession dispatches to whichever this file's own
// convention — camelCase, `effort` not `thinking`, `torn` present — applies
// to. omp rows are never torn in the sense this file tracks (no fold-back to
// tear mid-turn); `false` says so plainly rather than leaving the column
// blank, which would read as "unmeasured".
//
// `-` maps to `""` here too, for the same reason as readMember's `effort` —
// this TSV's blank convention predates the record's `-` one and the two rows
// share one column.
function rowsForOmpSession(sessionDir, stats) {
  let names;
  try { names = readdirSync(sessionDir, { recursive: true }); }
  catch { names = []; }
  const jsonlNames = names.filter((x) => x.endsWith(".jsonl"));
  let newest = 0;
  for (const f of jsonlNames) {
    try { newest = Math.max(newest, statSync(join(sessionDir, f)).mtimeMs); } catch { /* raced away */ }
  }
  const recs = readOmpSession(sessionDir); // may throw — a wrong-root refusal, not a per-file fault
  stats.seen = jsonlNames.length;
  stats.dropped = jsonlNames.length - recs.length;
  stats.torn = 0;
  const run_date = newest ? new Date(newest).toISOString().slice(0, 10) : "";
  return recs.map((r) => ({
    session: r.session, run_date,
    harness: r.harness, role: r.role, member: r.member, model: r.model,
    effort: r.thinking === "-" ? "" : r.thinking, ticket: r.ticket, pr: r.pr,
    tokensCacheCreate: r.tokens_cache_create, tokensOut: r.tokens_out,
    wallS: r.wall_s, turns: r.turns, agent: r.agent, torn: false,
    subagentType: r.subagent_type,
  }));
}

// Walks one session's subagents dir. Every failure is per-member: one unreadable
// transcript or unparseable meta must not cost the other sixteen members their
// rows. board.mjs takes the same stance on the same files.
//
// The walk is RECURSIVE. Subagent transcripts live at TWO depths: the flat
// `subagents/agent-*.jsonl` a directly-dispatched member writes, and
// `subagents/workflows/wf_<id>/agent-*.jsonl` for the fan-out a Workflow
// dispatches. Measured 2026-08-27: 2,723 flat against 2,894 nested across 37
// sessions — a one-level readdir saw 48% of the corpus. The nested half is not
// a fringe: it is `workflows/review-pr.js`'s specialists, and that file pins
// `model: "sonnet"` on three of its six dimensions, so the half where model is
// deliberately VARIED was the half being dropped.
//
// `agent` is the path-relative stem, so a nested member reads
// `workflows/wf_<id>/agent-<id>` while a flat one is unchanged — which is what
// let this widening REPLACE the existing rows rather than duplicate them.
//
// `stats` is an optional out-param: callers that omit it behave exactly as
// before. The CLI needs it because a session where every member dropped was
// otherwise indistinguishable from a healthy one.
//
// run_date comes from the newest transcript's mtime rather than a clock read, so
// a backfill run in December still dates an August session in August.
export function rowsForSession(sessionDir, stats = {}) {
  // Dispatched by NAME, the same structural rule member-record.mjs's own
  // reader-selection uses, never by content: an omp session directory is
  // `<ISO>_<uuid>` and holds `.jsonl` files directly, no `subagents/` child.
  if (isOmpSessionDirName(basename(sessionDir))) return rowsForOmpSession(sessionDir, stats);
  const dir = join(sessionDir, "subagents");
  let names;
  try { names = readdirSync(dir, { recursive: true }); } catch { return []; }

  const rows = [];
  let newest = 0, seen = 0, torn = 0;
  for (const f of names.filter((x) => x.endsWith(".jsonl"))) {
    seen++;
    try {
      // Sample the mtime for EVERY transcript, not only the ones that yield a
      // row: run_date is the newest transcript this session wrote, and a
      // dropped member (synthetic-only, unreadable meta) still wrote a file.
      // Sampling only survivors dates the session from an older file, which
      // across midnight is the wrong day.
      newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
      const jsonl = readFileSync(join(dir, f), "utf8");
      const meta = JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      const row = readMember(jsonl, meta);
      if (!row) continue;
      if (row.torn) torn++;
      // `member` (meta.name ?? meta.agentType) COLLIDES for every unnamed
      // dispatch — they all fall back to the same agentType ("general-purpose"),
      // not to blank — so it is not unique within a session. The transcript's
      // path-relative stem is the only per-member identifier that is.
      const agent = f.replace(/\.jsonl$/, "");
      rows.push({ agent, ...row });
    } catch { /* one member's loss, not the session's */ }
  }
  stats.seen = seen;
  stats.dropped = seen - rows.length;
  stats.torn = torn;
  const session = basename(sessionDir);
  const run_date = newest ? new Date(newest).toISOString().slice(0, 10) : "";
  return rows.map((r) => ({ session, run_date, ...r }));
}

// APPENDED TO, never inserted into: every read-out in the file's header and
// in docs/specs indexes by position, so a column added anywhere but the end
// silently repoints every `$n` a reader already wrote down. `subagent_type`
// (#1066) is therefore last, after `harness`.
export const COLUMNS = [
  "session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
  "tokens_cache_create", "tokens_out", "wall_s", "turns", "agent", "harness",
  "subagent_type",
];

// Row objects use camelCase; the file uses snake_case. One map, one direction
// each, so a rename cannot silently drop a column.
const FIELD = {
  tokens_cache_create: "tokensCacheCreate", tokens_out: "tokensOut", wall_s: "wallS",
  subagent_type: "subagentType",
};
const field = (c) => FIELD[c] ?? c;
// Keyed on the transcript's path-relative stem, not the member name: `member`
// collides on the agentType fallback for every unnamed dispatch, collapsing
// 2,715 rows onto 1,497 keys (measured). `agent` is unique WITHIN A SESSION,
// which is all the key needs — it is NOT globally unique, because a NAMED
// member's stem is derived from its name and so repeats across sessions.
const key = (r) => `${r.session}\0${r.agent}`;

// Replace-by-key, not append. This is what makes a phase-3 re-run and a full
// regeneration both safe, and it is the reason no backfill-only code path is
// needed: the idempotency backfill wants is the idempotency a re-run wants.
export function mergeRows(existing, incoming) {
  const by = new Map((existing ?? []).map((r) => [key(r), r]));
  for (const r of incoming ?? []) by.set(key(r), r);
  return [...by.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

export function formatTsv(rows) {
  return rows.map((r) => COLUMNS.map((c) => String(r[field(c)] ?? "")).join("\t")).join("\n") + "\n";
}

// REFUSES a row whose cell count is not exactly COLUMNS.length rather than
// padding it. Padding looked harmless and was not: `agent` is the LAST column,
// so a short row parsed to `agent: ""` — a key rowsForSession can never
// produce, which means mergeRows can never REPLACE it. Three ways to reach that
// were measured, all previously exit 0: a transcript torn mid-write became a
// permanent phantom that re-scraping could not heal; git conflict markers became
// three data rows; and adding one column ahead of `agent` collapsed the corpus
// onto one key per session, 2,702 rows to 156.
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
import { pathToFileURL } from "node:url";
import { makeDie, isFlagLike } from "./arg.mjs";

const NAME = "member-outcomes";

// Only runs as a CLI, never on import — the test file and any wrapper import
// the pure helpers. Exact identity, not a suffix match: fleet-tick.test.mjs
// records a copy under an unresolved path silently never running main(), and a
// suffix test additionally fires for any file ending in this one's name.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const die = makeDie(NAME);
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf("--file");
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : "docs/metrics/member-outcomes.tsv";
  // An unrecognised `--flag` is silently dropped by the dirs filter below
  // rather than refused — worst case `--file=/tmp/x.tsv` (no such flag;
  // --file wants a SPACE, not `=`) never sets fileIdx, so this would silently
  // write the production metrics file instead of the path the operator asked
  // for.
  const bad = argv.find((a) => a.startsWith("--") && a !== "--file");
  if (bad) die(`unknown option ${bad} (did you mean --file <path>?)`);

  // fileIdx is -1 when --file is absent, which makes fileIdx + 1 equal 0 — the
  // FIRST positional argument, not a real index into argv. Without the
  // fileIdx < 0 guard this filters out the session dir itself, and the bare
  // form (the one the spec, the backfill loop and run-team's phase-3
  // instruction all use) always exits 2.
  const dirs = argv.filter((a, i) => !a.startsWith("--") && (fileIdx < 0 || i !== fileIdx + 1));
  if (dirs.length !== 1) die("usage: member-outcomes.mjs <session-dir> [--file <tsv>]");
  // arg.mjs's rule, consumed rather than copied (#567). This line used to
  // hand-write `!file || file.startsWith("--")`, which was that rule with the
  // blank spelling missing — so `--file "   "` was accepted here and wrote the
  // metrics TSV to a whitespace-named path, while every script routing through
  // arg() refused it. That gap is what a copy costs and is why the predicate
  // is imported. The refusal WORDING stays this script's own: `--file` is the
  // flag the operator typed.
  if (isFlagLike(file)) die("--file needs a path");

  // findSubagentsDir() (board.mjs) returns .../<session>/subagents; a human
  // types the session dir instead. Accept both rather than making the caller
  // remember which.
  const arg = dirs[0].replace(/\/+$/, "");
  const sessionDir = basename(arg) === "subagents" ? dirname(arg) : arg;
  // A wrong guess used to exit 0 having scraped and written nothing, because
  // rowsForSession() catches the readdir failure and returns []. Probe with
  // the SAME call it makes, per harness: an existsSync test closes only the
  // ENOENT half, and EACCES (an unreadable dir) and ENOTDIR (a regular FILE
  // named subagents) both walked straight past it back into the silent
  // exit 0. omp session dirs have no `subagents/` wrapper — rowsForSession
  // reads the session dir itself — so the probe reads THAT instead.
  if (isOmpSessionDirName(basename(sessionDir))) {
    try { readdirSync(sessionDir); }
    catch (e) { die(`cannot read ${sessionDir}: ${e.code ?? e.message}`); }
  } else {
    try { readdirSync(join(sessionDir, "subagents")); }
    catch (e) { die(`cannot read ${join(sessionDir, "subagents")}: ${e.code ?? e.message}`); }
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

  const stats = {};
  const merged = mergeRows(existing, rowsForSession(sessionDir, stats));
  // Write-then-rename: writeFileSync truncates before it writes, so an interrupt
  // over the committed corpus left a torn file that the NEXT scrape read, merged
  // and rewrote — losing every other session's rows for good.
  writeFileSync(file + ".tmp", (header ? header + "\n" : "") + formatTsv(merged));
  renameSync(file + ".tmp", file);
  // Report the SCRAPE, not just the file. `merged.length` is the whole corpus,
  // so a session where every member dropped printed the same reassuring line as
  // a healthy one — 0-of-2 was indistinguishable from full success.
  const torn = stats.torn ? `, ${stats.torn} torn mid-write` : "";
  process.stderr.write(
    `${NAME}: scraped ${stats.seen - stats.dropped} of ${stats.seen} members ` +
    `(${stats.dropped} dropped${torn}); ${file} now holds ${merged.length} rows\n`,
  );
}
