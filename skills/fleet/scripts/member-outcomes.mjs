// Scraper for per-member model/effort facts. Pure over the harness's own
// subagent transcripts: no clock, no network, no gh. See
// docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { classifyRole } from "./compute-spend.mjs";

// `<synthetic>` is not a model — it is the harness labelling a turn it
// generated itself, and mapping it to anything would invent a data point. The
// `[1m]` suffix is a context-window variant of the SAME model: meta.json writes
// `claude-opus-5[1m]` while that member's own messages write `claude-opus-5`,
// so keeping both spellings would split every count in half.
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
// would be a blackout rather than degradation.
//
// `model` records the LAST turn's, not the first: a member whose model changed
// mid-run finished at the later one, and that is the tier its output reflects.
export function readMember(jsonlText, meta) {
  let model = null, effort = "", cache = 0, out = 0, turns = 0;
  let firstTs = null, lastTs = null, torn = false;
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
    cache += Number(u.cache_creation_input_tokens ?? 0);
    out += Number(u.output_tokens ?? 0);
    turns++;
  }
  if (!model) return null;

  const member = String(meta?.name ?? meta?.agentType ?? "");
  const { ticket, pr } = parseMemberName(member);
  const span = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : 0;
  return {
    role: classifyRole(meta), member, model, effort, ticket, pr,
    tokensCacheCreate: cache, tokensOut: out,
    wallS: Number.isFinite(span) ? Math.round(span) : 0,
    turns,
    // `errored` is a stall or a terminal API failure, NOT a code defect: the
    // transcript stops mid-write and its last line never parses. A member with a
    // single completed turn is NORMAL — the earlier rule keyed on
    // firstTs === lastTs and mislabelled every one-turn member as a stall.
    errored: torn ? "yes" : "no",
  };
}

// Walks one session's subagents dir. Every failure is per-member: one unreadable
// transcript or unparseable meta must not cost the other sixteen members their
// rows. board.mjs takes the same stance on the same files.
//
// run_date comes from the newest transcript's mtime rather than a clock read, so
// a backfill run in December still dates an August session in August.
export function rowsForSession(sessionDir) {
  const dir = join(sessionDir, "subagents");
  let names;
  try { names = readdirSync(dir); } catch { return []; }

  const rows = [];
  let newest = 0;
  for (const f of names.filter((x) => x.endsWith(".jsonl"))) {
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
      // `member` (meta.name ?? meta.agentType) COLLIDES for every unnamed
      // dispatch — they all fall back to the same agentType ("general-purpose"),
      // not to blank — so it is not unique within a session. The `agent-<id>`
      // filename stem is the only per-member identifier that is.
      const agent = f.replace(/\.jsonl$/, "");
      rows.push({ agent, ...row });
    } catch { /* one member's loss, not the session's */ }
  }
  const session = basename(sessionDir);
  const run_date = newest ? new Date(newest).toISOString().slice(0, 10) : "";
  return rows.map((r) => ({ session, run_date, ...r }));
}

export const COLUMNS = [
  "session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
  "tokens_cache_create", "tokens_out", "wall_s", "turns", "errored", "agent",
];

// Row objects use camelCase; the file uses snake_case. One map, one direction
// each, so a rename cannot silently drop a column.
const FIELD = {
  tokens_cache_create: "tokensCacheCreate", tokens_out: "tokensOut", wall_s: "wallS",
};
const field = (c) => FIELD[c] ?? c;
// Keyed on the transcript id, not the member name: `member` collides on the
// agentType fallback for every unnamed dispatch, so it collapses distinct
// members onto one key. `agent` is the `agent-<id>` filename stem — unique and
// stable per member.
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

export function parseTsv(text) {
  return String(text ?? "").split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const cells = l.split("\t");
      const r = {};
      COLUMNS.forEach((c, i) => { r[field(c)] = cells[i] ?? ""; });
      return r;
    });
}

import { writeFileSync, existsSync } from "node:fs";
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
  // A wrong guess (nonexistent dir, or the wrong sibling) used to exit 0
  // having scraped and written nothing, because rowsForSession() catches the
  // readdir failure and returns []. Refuse it loudly instead.
  if (!existsSync(join(sessionDir, "subagents"))) die(`no subagents/ under ${sessionDir}`);

  // Header comments are preserved verbatim across the rewrite: they carry the
  // read-out commands and the blank-means-unknown rule, and the rewrite is
  // routine (every re-scrape), so losing them would be a slow, silent erasure.
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  const header = prev.split("\n").filter((l) => l.startsWith("#")).join("\n");
  const merged = mergeRows(parseTsv(prev), rowsForSession(sessionDir));
  writeFileSync(file, (header ? header + "\n" : "") + formatTsv(merged));
  process.stderr.write(`${NAME}: wrote ${merged.length} rows to ${file}\n`);
}
