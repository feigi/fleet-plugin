// Scraper for per-member model/effort facts. Pure over the harness's own
// subagent transcripts: no clock, no network, no gh. See
// docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { classifyRole } from "./compute-spend.mjs";

// `<synthetic>` is not a model — it is the harness labelling a turn it
// generated itself, and mapping it to anything would invent a data point.
//
// The `[1m]` strip is DEFENSIVE, not load-bearing: meta.json carries the
// context-window variant (`claude-opus-5[1m]`, 395 metas on disk) but this
// scraper reads `message.model` from the transcript, where measurement found
// ZERO bracketed spellings across every file. It fires only if the model source
// ever moves to meta.json — a plausible change, since meta carries the
// REQUESTED tier and the transcript the EFFECTIVE one.
//
// Note what is NOT handled: meta.json also carries bare aliases (`sonnet` 279,
// `opus` 61, `haiku` 25). Those WOULD collide with the versioned ids and split
// counts for real. Canonicalising them is only worth writing when something
// actually reads meta.model.
export function normalizeModel(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "<synthetic>") return null;
  return s.replace(/\[[^\]]*\]$/, "");
}

// A member's name is the only place its unit of work is recorded — nothing
// writes ticket or PR into meta.json.
//
// FOUR finisher spellings are live on disk, measured 2026-08-27 across every
// meta.json: finisher-pr-<n> 163, finish-pr-<n> 58, finisher-<n> 44,
// finish-<n> 18. All four book a PR, and matching only the first cost 120 of
// 283 finisher members their join key to tier-outcomes.tsv. The fix-pr-<n> and
// review-pr-<n> families share the first pattern only because the infix is the
// same — they are NOT finisher spellings. #326 tracks picking a canonical
// finisher name; this function reads what is actually on disk rather than
// waiting for that.
//
// merge-bot-<n> is deliberately excluded: its number is a WAVE index, and
// booking it as a pr would join the row to an unrelated PR's verdict. A single
// trailing lowercase letter is a retry suffix (-b, -c and -d all observed) and
// is stripped first, because a re-dispatched member works the same unit.
//
// The NUMERIC suffix (`impl-137-2`) looks like the same retry spelling and is
// deliberately NOT stripped. The one real instance on disk describes itself as
// "Implement 137+138+139 set" — a multi-ticket batch that no single `ticket`
// value represents. Blank is the honest answer; booking it to 137 would join
// the row to two tickets it did not do.
export function parseMemberName(name) {
  const s = String(name ?? "").trim().replace(/-[a-z]$/, "");
  let m = /^(?:fix|review|finish|finisher)-pr-(\d+)$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^finish(?:er)?-(\d+)$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^impl-(\d+)$/.exec(s);
  if (m) return { ticket: m[1], pr: "" };
  return { ticket: "", pr: "" };
}

// One row from one member's transcript plus its meta. Takes TEXT rather than a
// path so it stays pure — the file reading lives in rowsForSession().
//
// The torn-line skip mirrors board.mjs: a transcript can be read while it is
// still being appended to, and losing a whole member over its last few bytes
// would be a blackout rather than degradation. `torn` rides on the row for
// rowsForSession() to COUNT, but it is NOT a column: it records when the
// scraper ran, not anything about the member, and it flips back to false on the
// next re-scrape of the same file.
//
// `model` records the LAST turn's, not the first: a member whose model changed
// mid-run finished at the later one, and that is the tier its output reflects.
// `effort` is last-wins for the same reason.
//
// USAGE IS FOLDED ONTO `message.id`, exactly as board.mjs:221-232 does. ONE
// assistant API turn is written as SEVERAL jsonl lines — one per content block
// (thinking, text, each tool_use) — and every one repeats the SAME message.id
// and the SAME usage object. Summing per LINE counts each turn's cache_creation
// once per block: measured across all 2,723 flat transcripts, +176.0% on
// cache_creation and +140.9% on the turn count, with 2,704 of them affected.
// Worse, the overcount is MODEL-DEPENDENT (opus-5 2.81x against sonnet-5 2.39x)
// because blocks-per-turn tracks how tool-heavy a turn is — so summing per line
// tilts the very cost comparison this file exists to support.
//
// `output_tokens` is a streaming snapshot, so the LARGEST value across a turn's
// lines is the final one. Summing it overcounts too, by ~1.5%.
//
// A line with no `message.id` becomes its own turn — the honest reading when the
// harness gives nothing to fold on. Measured: 0 of 127,102 real assistant lines
// lack one, so that path is fixtures only.
export function readMember(jsonlText, meta) {
  let model = null, effort = "";
  let firstTs = null, lastTs = null, torn = false;
  const turnById = new Map();
  let anon = 0;
  for (const raw of String(jsonlText ?? "").split("\n")) {
    if (!raw.trim()) continue;
    let d;
    try { d = JSON.parse(raw); torn = false; } catch { torn = true; continue; }
    const ts = d.timestamp;
    if (ts) { firstTs ??= ts; lastTs = ts; }
    const m = d.message;
    if (!m || d.type !== "assistant") continue;
    const norm = normalizeModel(m.model);
    if (norm) model = norm;
    if (typeof d.effort === "string") effort = d.effort;
    const u = m.usage ?? {};
    const id = m.id ?? `\0anon${anon++}`;
    let turn = turnById.get(id);
    if (!turn) {
      // First line of this turn — bill its cache write now, once.
      turn = { cache: Number(u.cache_creation_input_tokens ?? 0), out: 0 };
      turnById.set(id, turn);
    }
    turn.out = Math.max(turn.out, Number(u.output_tokens ?? 0));
  }
  if (!model) return null;

  let cache = 0, out = 0;
  for (const t of turnById.values()) { cache += t.cache; out += t.out; }

  const member = String(meta?.name ?? meta?.agentType ?? "");
  const { ticket, pr } = parseMemberName(member);
  const span = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : 0;
  return {
    role: classifyRole(meta), member, model, effort, ticket, pr,
    tokensCacheCreate: cache, tokensOut: out,
    wallS: Number.isFinite(span) ? Math.round(span) : 0,
    turns: turnById.size,
    torn,
  };
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

export const COLUMNS = [
  "session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
  "tokens_cache_create", "tokens_out", "wall_s", "turns", "agent",
];

// Row objects use camelCase; the file uses snake_case. One map, one direction
// each, so a rename cannot silently drop a column.
const FIELD = {
  tokens_cache_create: "tokensCacheCreate", tokens_out: "tokensOut", wall_s: "wallS",
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
import { makeDie } from "./arg.mjs";

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
  if (!file || file.startsWith("--")) die("--file needs a path");

  // findSubagentsDir() (board.mjs) returns .../<session>/subagents; a human
  // types the session dir instead. Accept both rather than making the caller
  // remember which.
  const arg = dirs[0].replace(/\/+$/, "");
  const sessionDir = basename(arg) === "subagents" ? dirname(arg) : arg;
  // A wrong guess used to exit 0 having scraped and written nothing, because
  // rowsForSession() catches the readdir failure and returns []. Probe with the
  // SAME call it makes: an existsSync test closes only the ENOENT half, and
  // EACCES (an unreadable dir) and ENOTDIR (a regular FILE named subagents)
  // both walked straight past it back into the silent exit 0.
  try { readdirSync(join(sessionDir, "subagents")); }
  catch (e) { die(`cannot read ${join(sessionDir, "subagents")}: ${e.code ?? e.message}`); }

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
