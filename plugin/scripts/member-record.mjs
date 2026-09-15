// The member-telemetry adapter (#1342, ruled on #1302). ONE per-member record
// shape, TWO readers chosen by the tree they walk, never by content. Both
// board.mjs (the live spend panel) and member-outcomes.mjs (the historical TSV
// scraper) build on the primitives here rather than each inlining Claude's
// transcript layout, so the fold-back arithmetic and the cwd encoders exist in
// exactly one place.
//
// The record: harness, session, agent, role, member, model, thinking,
// subagent_type, tokens_in, tokens_cache_create, tokens_cache_read,
// tokens_out, cost, wall_s, turns, ticket, pr. `harness` is set by which
// reader produced the row — structural, decided by which root the transcript
// lives under, before any byte is parsed. `cost` is omp-real
// (`usage.cost.total`, summed per member) and null for Claude — no pricing
// table exists in this repo, and inventing one is not this ticket's
// business. `thinking` is Claude's `d.effort` / omp's
// `thinking_level_change.thinkingLevel`, `-` when a harness that could have
// recorded it did not (never blank, so a hole is visible, per #1302's ruling
// on `auto`).
//
// `subagent_type` (#1066) is what the member was DISPATCHED AS — the agent
// DEFINITION the dispatch named, never the member's own name: Claude's
// `meta.customAgentType`, omp's `session_init.agent`. It is the only field
// that separates a deliberate alternate-tier pair from two members whose
// models merely happened to differ, and both readers already open the file
// it lives on, so it is derived rather than authored and survives a
// regeneration. `""` is NOT the `-` hole the fields above use: it means the
// dispatch named no agent definition, the ordinary shape of an untyped
// Claude `Task` call (measured 2026-09-12: 5,997 of 6,136 sidecars on disk
// carry no `customAgentType` key at all, and none of the typed ones predate
// 2026-08-28, when typed agent definitions came into use). Absence IS the
// discrimination — a closed category that can never hold a deliberate pair,
// not a value worth recovering. omp writes the key on every `session_init`
// (`task` for the default agent), so a blank on that side means the
// transcript carries no `session_init` line at all.
//
// Row identity is `session\0agent`, unchanged from before this ticket — the
// ledger has no member concept and gains none here (ledger.mjs is untouched).

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, basename, dirname, relative, isAbsolute, resolve, sep } from "node:path";

import { classifyRole } from "./compute-spend.mjs";

// ---------------------------------------------------------------------------
// cwd encoders — one per harness, because the rules are structurally
// different, not cosmetically. Claude's is a blind character replace,
// unchanged from board.mjs's original `encodeProjectDir`. omp's splits on
// whether the cwd is under $HOME: home-relative paths become `-` + segments
// joined by `-` with DOTS PRESERVED (`~/.claude` -> `-.claude`); non-home
// paths are realpath-resolved (so `/tmp/x`, a symlink to `/private/tmp/x` on
// macOS, encodes under the resolved name) and double-dash-wrapped. Both
// forms are measured against real `~/.omp/agent/sessions/*` directory names
// in member-record.test.mjs — `-dev-fleet-plugin`, `-.claude`, and
// `--private-tmp-fix685-scratch--` all exist on disk today.
// ---------------------------------------------------------------------------

// The encoding replaces every non-alphanumeric character with `-`, so
// /Users/x/.claude encodes to `-Users-x--claude` (double dash), not
// `-Users-x-.claude`. Replacing only slashes silently missed every cwd
// containing a dot — including this repo, which is what the fleet skills
// themselves run out of, so the panel never rendered here at all (board.mjs's
// original #(unnamed) regression). Moved here, verbatim, so board.mjs and any
// future Claude-side consumer share one definition instead of two that can
// drift apart.
export function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// `realpath` is an injectable seam, not a design nicety: the production
// default resolves the LIVE filesystem, but a directory a transcript's
// `session.cwd` names may no longer exist by the time anything reads that
// value back (a /tmp scratch dir cleaned up weeks later, say), and
// `fs.realpathSync` throws ENOENT on a path it cannot see. Callers who need to
// encode a cwd that is not guaranteed to exist — verifying the encoder against
// a historical transcript, for one — pass their own resolver.
export function encodeOmpProjectDir(cwd, { home = process.env.HOME, realpath = realpathSync } = {}) {
  const rel = relative(home, cwd);
  const isHome = !rel.startsWith("..") && !isAbsolute(rel);
  if (isHome) return "-" + rel.split(sep).filter(Boolean).join("-");
  const resolved = realpath(cwd);
  return "--" + resolved.split(sep).filter(Boolean).join("-") + "--";
}

// ---------------------------------------------------------------------------
// Ticket/PR extraction and model normalisation — shared across harnesses
// because both readers build the same record fields from a member's naming.
// Moved here from member-outcomes.mjs (which re-exports both for the callers
// and tests that already import them from there) so member-record.mjs, the
// lower-level module, does not depend upward on either script it feeds.
// ---------------------------------------------------------------------------

// `<synthetic>` is not a model — it is the harness labelling a turn it
// generated itself, and mapping it to anything would invent a data point.
//
// The `[1m]` strip is DEFENSIVE, not load-bearing: meta.json carries the
// context-window variant (`claude-opus-5[1m]`, 395 metas on disk) but this
// scraper reads `message.model` from the transcript, where measurement found
// ZERO bracketed spellings across every file. It fires only if the model
// source ever moves to meta.json — a plausible change, since meta carries the
// REQUESTED tier and the transcript the EFFECTIVE one.
//
// Note what is NOT handled: meta.json also carries bare aliases (`sonnet`
// 279, `opus` 61, `haiku` 25). Those WOULD collide with the versioned ids and
// split counts for real. Canonicalising them is only worth writing when
// something actually reads meta.model.
export function normalizeModel(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "<synthetic>") return null;
  return s.replace(/\[[^\]]*\]$/, "");
}

// A member's name is the only place its unit of work is recorded — nothing
// writes ticket or PR into meta.json (Claude) or anywhere in the transcript
// (omp; there is no dispatch sidecar at all — see readOmpMember).
//
// FOUR finisher spellings are live on disk, measured 2026-08-27 across every
// meta.json: finisher-pr-<n> 163, finish-pr-<n> 58, finisher-<n> 44,
// finish-<n> 18. All four book a PR, and matching only the first cost 120 of
// 283 finisher members their join key to tier-outcomes.tsv. The fix-pr-<n>
// and review-pr-<n> families share the first pattern only because the infix
// is the same — they are NOT finisher spellings. `finisher-pr-<n>` is the
// canonical name run-team now fixes (#326); the other three stay matched
// because the runs that used them are already in the record.
//
// merge-bot-<n> is deliberately excluded: its number is a WAVE index, and
// booking it as a pr would join the row to an unrelated PR's verdict. A
// single trailing lowercase letter is a retry suffix (-b, -c and -d all
// observed) and is stripped first, because a re-dispatched member works the
// same unit.
//
// The NUMERIC suffix (`impl-137-2`) looks like the same retry spelling and is
// deliberately NOT stripped. The one real instance on disk describes itself
// as "Implement 137+138+139 set" — a multi-ticket batch that no single
// `ticket` value represents. Blank is the honest answer; booking it to 137
// would join the row to two tickets it did not do.
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

// ---------------------------------------------------------------------------
// Claude reader
// ---------------------------------------------------------------------------

// Folds one Claude subagent transcript into turns. This is the ONE place the
// message.id fold-back arithmetic lives now — board.mjs's readAgent (which
// additionally needs the per-block tool stream for cache-write attribution)
// and this module's own readClaudeMember (which needs only the per-turn
// totals) both call it, so the two can no longer drift the way they did
// before this ticket: readAgent tracked cache_read and raw input tokens,
// readMember did not, and neither tracked the other's torn-line bookkeeping
// consistently.
//
// ONE assistant API turn is written as SEVERAL jsonl lines — one per content
// block (thinking, text, each tool_use) — and every one of those lines
// repeats the SAME `message.id` and the SAME `message.usage` object. Summing
// usage per LINE therefore counts each turn's cache_creation once per block:
// measured across 2452 real transcripts, +206% (535M counted vs 175M actual),
// and again across 2,723 flat transcripts, +176.0% on cache_creation and
// +140.9% on turn count, MODEL-DEPENDENT (opus-5 2.81x, sonnet-5 2.39x)
// because blocks-per-turn tracks how tool-heavy a turn is. So fold lines back
// into turns on `message.id` and take each turn's usage exactly once.
//
// `output_tokens` is a streaming snapshot, so the LARGEST value across a
// turn's lines is the final one; summing it also overcounts, by ~1.5%.
//
// A line with no `message.id` becomes its own turn — the honest reading when
// the harness gives nothing to fold on (0 of 127,102 real assistant lines
// lack one; fixtures only).
//
// `model`/`effort` are last-wins: a member whose model or effort changed
// mid-run finished at the later one, and that is the tier its output
// reflects.
//
// Malformed lines are skipped, not fatal — a transcript being appended to
// while it is read has a torn LAST line on every tick. `torn` reflects only
// the final line (resets on the next successful parse, so a mid-file tear is
// a hiccup, not a stall); `malformedNonLastLines`/`malformedNonLastLineError`
// COUNT the different, real fault of a line that will never complete, for a
// caller (board.mjs) that surfaces it.
// omp's envelope always carries a top-level `parentId` key — even a root
// event writes `parentId: null` rather than omitting it (measured against
// real `~/.omp/agent/sessions/**/*.jsonl` files). A Claude transcript line
// never carries that key at all; Claude's own parent reference is spelled
// `parentUuid`. That makes `parentId`'s presence a safe POSITIVE signature
// for "this is omp content", the mirror of assertNotClaudeShaped below —
// and unlike checking for the ABSENCE of Claude's own keys, it never fires
// on this repo's existing Claude test fixtures, none of which set
// `sessionId`/`parentUuid`/`parentId` at all (they construct only the
// fields the fold-back arithmetic reads).
function assertNotOmpShaped(d, filePath) {
  if (Object.prototype.hasOwnProperty.call(d, "parentId")) {
    throw new Error(`member-record: omp-shaped transcript found under the Claude root, refusing to parse it as Claude: ${filePath}`);
  }
}

// Folds one Claude subagent transcript into turns. This is the ONE place the
// message.id fold-back arithmetic lives now — board.mjs's readAgent (which
// additionally needs the per-block tool stream for cache-write attribution)
// and this module's own readClaudeMember (which needs only the per-turn
// totals) both call it, so the two can no longer drift the way they did
// before this ticket: readAgent tracked cache_read and raw input tokens,
// readMember did not, and neither tracked the other's torn-line bookkeeping
// consistently.
//
// ONE assistant API turn is written as SEVERAL jsonl lines — one per content
// block (thinking, text, each tool_use) — and every one of those lines
// repeats the SAME `message.id` and the SAME `message.usage` object. Summing
// usage per LINE therefore counts each turn's cache_creation once per block:
// measured across 2452 real transcripts, +206% (535M counted vs 175M actual),
// and again across 2,723 flat transcripts, +176.0% on cache_creation and
// +140.9% on turn count, MODEL-DEPENDENT (opus-5 2.81x, sonnet-5 2.39x)
// because blocks-per-turn tracks how tool-heavy a turn is. So fold lines back
// into turns on `message.id` and take each turn's usage exactly once.
//
// `output_tokens` is a streaming snapshot, so the LARGEST value across a
// turn's lines is the final one; summing it also overcounts, by ~1.5%.
//
// A line with no `message.id` becomes its own turn — the honest reading when
// the harness gives nothing to fold on (0 of 127,102 real assistant lines
// lack one; fixtures only).
//
// `model`/`effort` are last-wins: a member whose model or effort changed
// mid-run finished at the later one, and that is the tier its output
// reflects.
//
// Malformed lines are skipped, not fatal — a transcript being appended to
// while it is read has a torn LAST line on every tick. `torn` reflects only
// the final line (resets on the next successful parse, so a mid-file tear is
// a hiccup, not a stall); `malformedNonLastLines` COUNTS the different, real
// fault of a line that will never complete, and `malformedNonLastLineError`
// carries the FIRST such parse error as its representative cause.
//
// #916: that count was a boolean until the board needed to put the fault on
// the page rather than only on stderr. A flag was enough for one warning
// sentence and is not enough for a number the operator reads every tick, and
// this loop is the only place in the codebase with a per-line view to count
// from — board.mjs's readAgent stopped having one when the fold-back
// arithmetic moved here (#1342). Consumers that only ever asked "any?" read a
// non-zero count exactly as they read `true`.
//
// `filePath` defaults to a placeholder: member-outcomes.mjs's readMember()
// is documented pure — text in, no path — so it has none to give, and the
// wrong-root check below still runs; it just names nothing concrete if it
// fires from that path.
export function foldClaudeTranscript(jsonlText, filePath = "<transcript>") {
  let model = null, effort = "";
  let firstTs = null, lastTs = null;
  let torn = false, malformedNonLastLines = 0, malformedNonLastLineError = null;
  const turnById = new Map();
  const entries = [];
  let anon = 0;
  let cacheWrite = 0, cacheRead = 0, input = 0, maxCtx = 0;
  const lines = String(jsonlText ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let d;
    try { d = JSON.parse(raw); torn = false; }
    catch (e) {
      torn = true;
      if (i !== lines.length - 1) { malformedNonLastLines++; malformedNonLastLineError ??= e.message; }
      continue;
    }
    assertNotOmpShaped(d, filePath);
    const ts = d.timestamp;
    if (ts) { firstTs ??= ts; lastTs = ts; }
    const m = d.message;
    // `message.content` is an array of blocks on tool-bearing turns but a
    // plain STRING on ordinary prose turns.
    const blocks = Array.isArray(m?.content) ? m.content : [];
    if (m && d.type === "assistant") {
      const norm = normalizeModel(m.model);
      if (norm) model = norm;
      if (typeof d.effort === "string") effort = d.effort;
      const u = m.usage ?? {};
      const id = m.id ?? `\0anon${anon++}`;
      let turn = turnById.get(id);
      if (!turn) {
        // First line of this turn — bill its usage now, once.
        const cw = u.cache_creation_input_tokens ?? 0;
        const cr = u.cache_read_input_tokens ?? 0;
        const inp = u.input_tokens ?? 0;
        cacheWrite += cw; cacheRead += cr; input += inp;
        maxCtx = Math.max(maxCtx, inp + cr + cw);
        turn = { kind: "assistant", cacheWrite: cw, tools: [], output: 0 };
        entries.push(turn);
        turnById.set(id, turn);
      }
      turn.output = Math.max(turn.output, u.output_tokens ?? 0);
      for (const c of blocks) if (c?.type === "tool_use") turn.tools.push({ id: c.id, name: c.name });
    } else if (d.type === "user") {
      const results = blocks
        .filter((c) => c?.type === "tool_result")
        .map((c) => ({ id: c.tool_use_id, chars: typeof c.content === "string" ? c.content.length : JSON.stringify(c.content ?? "").length }));
      if (results.length) entries.push({ kind: "result", results });
    }
  }
  const output = entries.reduce((n, e) => n + (e.output ?? 0), 0);
  const span = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : 0;
  return {
    model, effort, torn, malformedNonLastLines, malformedNonLastLineError,
    entries, cacheWrite, cacheRead, input, output, maxCtx,
    turns: turnById.size,
    wallS: Number.isFinite(span) ? Math.round(span) : 0,
  };
}

// One member record from one Claude transcript + its meta.json. `cost` is
// always null here — Claude Code transcripts carry no dollar figure and no
// pricing table exists in this repo to derive one; `torn` rides along for
// rowsForSession() to count, exactly as it did when this lived in
// member-outcomes.mjs — it is scrape-quality metadata, not part of the
// canonical record's field list, and only member-outcomes.mjs reads it.
export function readClaudeMember(jsonlText, meta, filePath = "<transcript>") {
  const folded = foldClaudeTranscript(jsonlText, filePath);
  if (!folded.model) return null;
  const member = String(meta?.name ?? meta?.agentType ?? "");
  const { ticket, pr } = parseMemberName(member);
  return {
    harness: "claude",
    role: classifyRole(meta), member,
    model: folded.model,
    // Never blank — a Claude member whose transcript carries no `d.effort`
    // (haiku models, which have no effort control at all) is a genuine hole,
    // the same class of thing as omp's missing `thinking_level_change`, and
    // #1302's ruling says a hole must stay visible rather than read as
    // though nothing were being asked. member-outcomes.mjs's TSV adapter
    // maps `-` back to "" for its own legacy `effort` column, which already
    // spells the same "unknown" concept as blank and predates this ticket.
    thinking: folded.effort || "-",
    // Straight off the sidecar this function is already handed — the
    // dispatch's own record of which agent definition produced this member
    // (`fleet-implementer` and `fleet-implementer-alt` are the two the tier
    // pairing turns on). Never `meta.agentType`: that is the member's NAME
    // for a named dispatch (`impl-387`) and the built-in type otherwise, so
    // reading it here would fill the column with something that answers a
    // different question. Absent key -> "", a fact about the dispatch and
    // not a hole; see this module's header.
    subagent_type: typeof meta?.customAgentType === "string" ? meta.customAgentType : "",
    tokens_in: folded.input, tokens_cache_create: folded.cacheWrite,
    tokens_cache_read: folded.cacheRead, tokens_out: folded.output,
    cost: null,
    wall_s: folded.wallS, turns: folded.turns,
    ticket, pr,
    torn: folded.torn,
  };
}

// Walks one session's `subagents/` dir into records. RECURSIVE: subagent
// transcripts live at TWO depths, the flat `subagents/agent-*.jsonl` a
// directly-dispatched member writes and the nested
// `subagents/workflows/wf_<id>/agent-*.jsonl` a Workflow's fan-out writes
// (measured 2,723 flat against 2,894 nested across 37 sessions — a
// one-level readdir saw 48% of the corpus). `agent` is the path-relative
// stem, so a nested member reads `workflows/wf_<id>/agent-<id>`.
//
// Every failure is per-member: one unreadable transcript or unparseable meta
// (including an ABSENT meta.json — the ordinary shape for an unnamed agent
// carries one regardless) must not cost the other members their rows. The
// wrong-root shape check (assertNotOmpShaped, inside foldClaudeTranscript)
// runs even when meta.json is absent or unreadable: an omp file sitting
// under a Claude `subagents/` dir never carries a `.meta.json` sidecar
// either, and reading meta FIRST — the previous ordering — let exactly that
// file vanish into the ordinary "no sidecar" skip below instead of being
// refused. readClaudeMember() therefore always runs (its throw propagates
// uncaught); only the DECISION to keep its row waits on meta.
export function readClaudeSession(subagentsDir) {
  let names;
  try { names = readdirSync(subagentsDir, { recursive: true }); }
  catch { return []; }
  const session = basename(dirname(subagentsDir));
  const rows = [];
  for (const f of names.filter((x) => x.endsWith(".jsonl"))) {
    const filePath = join(subagentsDir, f);
    let jsonl;
    try { jsonl = readFileSync(filePath, "utf8"); }
    catch { continue; } // one unreadable transcript, not the session
    let meta, metaOk = true;
    try { meta = JSON.parse(readFileSync(filePath.replace(/\.jsonl$/, ".meta.json"), "utf8")); }
    catch { meta = {}; metaOk = false; }
    const rec = readClaudeMember(jsonl, meta, filePath); // may throw — see comment above
    if (!metaOk || !rec) continue;
    rows.push({ ...rec, session, agent: f.replace(/\.jsonl$/, "") });
  }
  return rows;
}

// Finds every `subagents/` directory reachable under `root`: `root` may
// already BE a subagents dir, a single session dir (holding `subagents/`
// directly), an encoded-project dir (holding many session dirs), or the
// whole `~/.claude/projects` tree. Recursion stops the instant a
// `subagents/` child is found — readClaudeSession's own recursive walk
// covers everything beneath it, so descending further here would only
// re-discover the same files as a second, wrongly-scoped "session".
function findClaudeSubagentsDirs(root) {
  if (basename(root) === "subagents") return [root];
  let ents;
  try { ents = readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  if (ents.some((e) => e.isDirectory() && e.name === "subagents")) return [join(root, "subagents")];
  const found = [];
  for (const e of ents) if (e.isDirectory()) found.push(...findClaudeSubagentsDirs(join(root, e.name)));
  return found;
}

// ---------------------------------------------------------------------------
// omp reader
// ---------------------------------------------------------------------------

// A Claude transcript line carries `sessionId`/`parentUuid` (and `agentId`,
// `cwd`, `version`, `gitBranch`) on EVERY line — measured against real
// `~/.claude/projects/**/subagents/*.jsonl` files. An omp line never carries
// either key at all: omp's envelope is `{type,id,parentId,timestamp,message}`,
// session id lives in the DIRECTORY name, not per line. That is the
// structural signature this reader refuses on — a validation CHECK inside the
// omp reader, per #1302's ruling, never the signal that chose this reader in
// the first place (readMembers picks the reader by which ROOT it was asked to
// walk, before any byte is parsed).
function assertNotClaudeShaped(d, filePath) {
  if (Object.prototype.hasOwnProperty.call(d, "sessionId") || Object.prototype.hasOwnProperty.call(d, "parentUuid")) {
    throw new Error(`member-record: Claude-shaped transcript found under the omp root, refusing to parse it as omp: ${filePath}`);
  }
}

// Folds one omp subagent transcript. Structurally simpler than Claude's: one
// `message.usage` per assistant turn already (no fold-back), a real per-turn
// dollar cost at `usage.cost.total`, and the declared thinking level on its
// own `thinking_level_change` event rather than repeated per line. Measured
// 2026-09-08/09 against real `~/.omp/agent/sessions/**/*.jsonl` files:
//   {"type":"session",...,"cwd":"/Users/chris/dev/fleet-plugin"}
//   {"type":"thinking_level_change",...,"thinkingLevel":"high","configured":null}
//   {"type":"message","message":{"role":"assistant","model":"claude-sonnet-5",
//     "usage":{"input":2,"output":201,"cacheRead":0,"cacheWrite":31319,
//       "totalTokens":31522,"cost":{"input":4e-6,"output":0.00201,
//       "cacheRead":0,"cacheWrite":0.0783,"total":0.0803}}}}
//
// `thinking` reads the harness-WRITTEN level, never the frontmatter — that is
// what makes #1298's declared-vs-resolved comparison possible (#1302's
// ruling). It stays `null` here (readOmpMember turns that into the record's
// `-`) when no `thinking_level_change` line exists, rather than guessing the
// default: a member that is not a fleet definition genuinely has no recorded
// level, and the hole must stay visible.
//
// `session_init.task` is carried through as the closest thing omp has to
// Claude's `meta.description` — there is no dispatch sidecar on this side at
// all. readOmpMember below only uses it, together with the transcript's own
// nesting depth, as a REAL classifyRole() signal; it is never matched
// against the bare agent id, which is a generated word pair and names
// nothing.
//
// `resolvedModelIdentity` (#1345) is `session_init`'s OWN field, written at
// DISPATCH — before the member's first assistant turn exists, which is what
// makes it different from `model` above: a member still working folds to
// `model: null` (no assistant turn yet) but already carries
// `resolvedModelIdentity` (measured `anthropic/claude-opus-5` (61),
// `anthropic/claude-sonnet-5` (103), `anthropic/claude-haiku-4-5` (68) across
// real `~/.omp/agent/sessions/**` — always provider-prefixed, never a bare
// alias). `model` itself is left untouched by this addition: board.mjs and
// member-outcomes.mjs read `model` for cost/spend attribution, where the
// per-turn value (which can in principle change mid-run) is the fact they
// want, not the dispatch-time identity.
//
// `agent` (#1066) is `session_init`'s dispatch-time record of WHICH AGENT
// DEFINITION this member is — omp's spelling of Claude's
// `meta.customAgentType`, and the omp arm of the deliberate-pair column.
// Measured 2026-09-12 across real `~/.omp/agent/sessions/**`: present on
// every one of the 1,191 transcripts carrying a `session_init` line
// (`fleet-implementer` 51, `fleet-implementer-alt` 17, the default `task`
// 220, plus the review fan-out's own definitions), absent only where the
// line itself is.
export function foldOmpTranscript(jsonlText, filePath) {
  let model = null, thinking = null, task = null, resolvedModelIdentity = null, agent = null;
  let firstTs = null, lastTs = null;
  let input = 0, cacheWrite = 0, cacheRead = 0, output = 0, cost = 0, turns = 0;
  let sawCost = false;
  for (const raw of String(jsonlText ?? "").split("\n")) {
    if (!raw.trim()) continue;
    let d;
    // A torn tail (transcript read mid-write) is dropped like Claude's, but
    // there is no fold-back to protect here — each surviving line is already
    // one whole turn, so losing the last line costs at most that one turn.
    try { d = JSON.parse(raw); } catch { continue; }
    assertNotClaudeShaped(d, filePath);
    if (typeof d.timestamp === "string") { firstTs ??= d.timestamp; lastTs = d.timestamp; }
    if (d.type === "thinking_level_change" && typeof d.thinkingLevel === "string") thinking = d.thinkingLevel;
    if (d.type === "session_init") {
      if (typeof d.task === "string") task = d.task;
      if (typeof d.resolvedModelIdentity === "string") resolvedModelIdentity = d.resolvedModelIdentity;
      if (typeof d.agent === "string") agent = d.agent;
    }
    const m = d.message;
    if (d.type === "message" && m?.role === "assistant" && m.usage) {
      const u = m.usage;
      if (typeof m.model === "string" && m.model) model = m.model;
      input += Number(u.input ?? 0);
      cacheWrite += Number(u.cacheWrite ?? 0);
      cacheRead += Number(u.cacheRead ?? 0);
      output += Number(u.output ?? 0);
      if (u.cost && typeof u.cost.total === "number") { cost += u.cost.total; sawCost = true; }
      turns++;
    }
  }
  const span = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : 0;
  return {
    model, thinking, task, resolvedModelIdentity, agent,
    input, cacheWrite, cacheRead, output,
    cost: sawCost ? cost : null,
    turns,
    wallS: Number.isFinite(span) ? Math.round(span) : 0,
  };
}

// One member record from one omp transcript. `member` is the AgentId (the
// filename stem, e.g. `InstallVerifySearch`) — omp has no separate display
// name the way Claude's meta.json does, so `ticket`/`pr` extraction runs
// against it directly.
//
// `role` is NEVER guessed off the bare AgentId — a generated CamelCase word
// pair names nothing classifyRole can read. Two REAL signals exist instead:
// `session_init.task` (the dispatch prompt, when present) and `spawnDepth`
// (the transcript's own nesting depth, supplied by readOmpSession from the
// walk — a fact about where the file lives, not a guess about what it is).
// Depth matters on its own: classifyRole checks depth BEFORE any text match,
// specifically so a nested member whose task happens to read like a
// reviewer's ("Review PR 1353 correctness") still books as the fan-out
// specialist it structurally is, not a reviewer. Neither signal present
// yields `"-"` — the same visible-hole spelling as `thinking`, never a
// default like "other", which only makes sense where a real dispatch record
// (Claude's meta.json) backs it.
export function readOmpMember(jsonlText, filePath, agentStem, spawnDepth = 0) {
  const folded = foldOmpTranscript(jsonlText, filePath);
  if (!folded.model) return null; // no assistant turn — not a real member transcript
  const member = agentStem;
  const { ticket, pr } = parseMemberName(member);
  const hasRoleSignal = spawnDepth >= 1 || typeof folded.task === "string";
  const role = hasRoleSignal ? classifyRole({ description: folded.task ?? "", spawnDepth }) : "-";
  return {
    harness: "omp",
    role,
    member,
    model: folded.model,
    // Additive only (#1345) — `model` above stays the per-turn value
    // board.mjs/member-outcomes.mjs already key cost/spend attribution on;
    // this is the dispatch-time identity `session_init` wrote before any
    // turn existed, `null` when the transcript predates #1343 or carries no
    // `session_init` line at all (never guessed).
    resolvedModelIdentity: folded.resolvedModelIdentity ?? null,
    thinking: folded.thinking ?? "-",
    // The dispatch record's own agent definition, `""` when the transcript
    // carries no `session_init` line to read one from — the same column
    // Claude fills from `meta.customAgentType`, so a deliberate pair reads
    // identically on either harness.
    subagent_type: folded.agent ?? "",
    tokens_in: folded.input, tokens_cache_create: folded.cacheWrite,
    tokens_cache_read: folded.cacheRead, tokens_out: folded.output,
    cost: folded.cost,
    wall_s: folded.wallS, turns: folded.turns,
    ticket, pr,
  };
}

// Walks one omp session directory into records. RECURSIVE for the same
// reason as Claude's reader: a member can itself dispatch further members
// (measured on disk — a research session's `Facts1303/` held seven more
// `.jsonl` files one level down), and `agent` is the path-relative stem so
// those nest instead of colliding. `spawnDepth` is read straight off that
// path — one `/` per nesting level, the same signal Claude's own reviewer
// fan-out relies on via `meta.spawnDepth` — and handed to readOmpMember as a
// real fact about the walk, not a guess about the member.
//
// Deliberately NOT wrapped in a blanket try/catch around readOmpMember: the
// wrong-root refusal (assertNotClaudeShaped, inside foldOmpTranscript) must
// propagate all the way out of readMembers, uncaught, per #1342's acceptance
// criterion. Only the raw file read is given the ordinary per-member
// tolerance.
export function readOmpSession(sessionDir) {
  let names;
  try { names = readdirSync(sessionDir, { recursive: true }); }
  catch { return []; }
  const session = basename(sessionDir);
  const rows = [];
  for (const f of names.filter((x) => x.endsWith(".jsonl"))) {
    const filePath = join(sessionDir, f);
    let text;
    try { text = readFileSync(filePath, "utf8"); }
    catch { continue; }
    const agent = f.replace(/\.jsonl$/, "");
    const spawnDepth = (f.match(/[\\/]/g) ?? []).length;
    const rec = readOmpMember(text, filePath, agent, spawnDepth); // may throw — see comment above
    if (!rec) continue;
    rows.push({ ...rec, session, agent });
  }
  return rows;
}

// An omp session directory is identified STRICTLY by name — `<ISO>_<uuid>`,
// e.g. `2026-09-08T13-13-27-300Z_01a08126-…` — never by holding `.jsonl`
// files directly. That second test used to be a shortcut, and it fired one
// level too high on the real tree: `~/.omp/agent/sessions/-dev-fleet-plugin/`
// holds the project's MAIN-session transcripts as plain files SIBLING to the
// per-session directories, so `findOmpSessionDirs` recursing from the
// encoded-cwd dir hit the `.jsonl` test there first, returned the whole
// project as "one session", stamped every row `session=-dev-fleet-plugin`
// instead of the `<ISO>_<uuid>` name #1302 rules the row key on, and booked
// the controller's own top-level transcripts as members. Name-only matching
// costs nothing a real fixture needs: every fixture in this repo already
// names its session dir in the real shape.
const OMP_SESSION_DIR_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+$/i;

// Exposed for callers that already hold one EXPLICIT directory rather than a
// tree to search — member-outcomes.mjs's CLI, which is handed a session dir
// directly the way it is already handed a Claude one — so the pattern is
// defined once.
export function isOmpSessionDirName(name) {
  return OMP_SESSION_DIR_RE.test(name);
}

function findOmpSessionDirs(root) {
  if (OMP_SESSION_DIR_RE.test(basename(root))) return [root];
  let ents;
  try { ents = readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const found = [];
  for (const e of ents) if (e.isDirectory()) found.push(...findOmpSessionDirs(join(root, e.name)));
  return found;
}

// ---------------------------------------------------------------------------
// readMembers — the one entry point that owns both roots
// ---------------------------------------------------------------------------

// Which harness a root belongs to is a property of the PATH alone: does it
// sit under a `.claude/projects` tree or a `.omp/agent/sessions` tree.
// Checked as path SEGMENTS, not a substring match, so a cwd that merely
// contains the text `.claude/projects` somewhere in an unrelated component
// cannot be mistaken for the real tree.
function harnessForRoot(root) {
  const segs = resolve(String(root)).split(sep);
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === ".claude" && segs[i + 1] === "projects") return "claude";
  }
  for (let i = 0; i + 2 < segs.length; i++) {
    if (segs[i] === ".omp" && segs[i + 1] === "agent" && segs[i + 2] === "sessions") return "omp";
  }
  return null;
}

// The adapter's public entry point. `roots` may mix Claude and omp trees
// freely — each element is dispatched to its reader by where it lives, and
// every record it produces carries the `harness` that decided it. A root
// under neither tree is refused rather than silently skipped: the module
// makes it impossible to point a reader at the other's tree, but it cannot
// make a THIRD tree meaningful, and silently returning no rows for a typo'd
// path is the same blackout #1302's ruling exists to prevent.
//
// A Claude root that resolves to NO `subagents/` directory anywhere gets the
// same treatment, symmetric with the omp side's content-shape refusal: an
// omp session directory dropped under `~/.claude/projects/<enc>/` has no
// `subagents/` child at any depth (it holds `.jsonl` files directly instead),
// so findClaudeSubagentsDirs legitimately finds none — and a silent empty
// result here is exactly the blackout this function's own contract refuses
// everywhere else. The omp side does not need the mirror of THIS check: its
// wrong-shape refusal already fires from inside foldOmpTranscript on the
// first line of whatever the misrouted content turns out to be.
export function readMembers(roots) {
  const rows = [];
  for (const root of [].concat(roots ?? [])) {
    const harness = harnessForRoot(root);
    if (harness === "claude") {
      const dirs = findClaudeSubagentsDirs(root);
      if (dirs.length === 0) {
        throw new Error(`member-record: no subagents/ directory found anywhere under the Claude root, refusing to silently contribute nothing: ${root}`);
      }
      for (const dir of dirs) rows.push(...readClaudeSession(dir));
    } else if (harness === "omp") {
      for (const dir of findOmpSessionDirs(root)) rows.push(...readOmpSession(dir));
    } else {
      throw new Error(`member-record: root is neither a Claude nor an omp telemetry tree: ${root}`);
    }
  }
  return rows;
}
