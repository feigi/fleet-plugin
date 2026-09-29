// The member-telemetry adapter (#1342, ruled on #1302). ONE per-member
// record shape, TWO readers a tree walk chooses by content, never by
// caller-supplied config: board.mjs (the live spend panel) and
// member-outcomes.mjs (the scraper) build on the primitives here rather than
// each inlining a transcript layout, so the fold-back arithmetic, the cwd
// encoder and the ticket/PR extraction each live in exactly one place.
//
// The record: harness, session, role, agent, model, thinking,
// subagent_type, tokens_in, tokens_cache_create, tokens_cache_read,
// tokens_out, cost, wall_s, turns, ticket, pr. `harness` is set by whichever
// reader produced the row — structural, decided by which root the transcript
// lives under, before any byte is parsed. `cost` is real (`usage.cost.total`
// — no pricing table exists in this repo, and inventing one is not this
// module's business.
//
// `thinking` is the harness-written level, blank when a hole is visible
// (#1302's ruling on "auto"). `subagent_type` (#1066) is what the member was
// DISPATCHED AS — the agent DEFINITION the dispatch named, never the
// member's own name: it is the only field that separates a deliberate
// alternate-tier pair from two members whose models already happened to
// differ, and both readers keep it because it is derived rather than
// authored and survives a regeneration. `""` is NOT the hole use; it means
// the dispatch named no agent definition, the ordinary shape of an untyped
// `task` call.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, basename, relative, isAbsolute, sep } from "node:path";

import { classifyRole, CANONICAL_MEMBER_NAME_PREFIXES } from "./compute-spend.mjs";

// ---------------------------------------------------------------------------
// cwd encoder
// ---------------------------------------------------------------------------

// `realpath` is an injectable seam, not a design nicety: the production
// default resolves the LIVE filesystem, but a directory a transcript reads
// may no longer exist by the time anything reads it — a scratch dir cleaned
// up weeks later, say — and `fs.realpathSync` throws ENOENT on a path it
// cannot see. Verifying the encoder against a historical transcript, for one
// callers who need to encode a cwd that is not guaranteed to exist — every
// caller but board.mjs's own live panel — pass their own resolver.
//
// Encodes the way the fleet's own tooling reads it back: every
// non-alphanumeric character with `-`, so `-Users-x-claude` decodes to
// `/Users/x/.claude`, not `-Users-x.claude`. Home-relative paths become
// `~/...`-style (`-` under $HOME) joined by `-` with DOTS PRESERVED
// (`.claude` -> `-.claude`); non-home paths are realpath-resolved (so `/tmp/x`,
// a symlink to `/private/tmp/x` on macOS, encodes under the resolved name)
// and double-dash-wrapped. Both forms are measured against real
// `~/.omp/agent/sessions/*` directory names in member-record.test.mjs - a
// `~/dev/fleet-plugin`, `--private-tmp-fx685-scratch--` all exist on disk
// today.
export function encodeProjectDir(cwd, { home = process.env.HOME, realpath = realpathSync } = {}) {
  const rel = relative(home, cwd);
  const isHome = !rel.startsWith("..") && !isAbsolute(rel);
  if (isHome) return "-" + rel.split(sep).filter(Boolean).join("-");
  const resolved = realpath(cwd);
  return "--" + resolved.split(sep).filter(Boolean).join("-") + "--";
}

// ---------------------------------------------------------------------------
// Ticket/PR extraction and model normalisation
// ---------------------------------------------------------------------------
// Moved here from member-outcomes.mjs (which re-exports both for the callers
// and tests that already import them from there) so member-record.mjs, the
// lower-level module, does not depend upward on either script it feeds.
// ---------------------------------------------------------------------------

// `<synthetic>` is not a model — it is the harness labelling a turn it
// generated itself, and mapping it to anything would invent a data point.
//
// The `[1m]` strip is DEFENSIVE, not load-bearing: it guards a
// context-window variant spelling (`claude-opus-5[1m]`) this scraper has
// never actually read from a transcript's `message.model`, where measurement
// found ZERO bracketed spellings across every file. It fires only if the
// model spelling ever changes to carry one.
export function normalizeModel(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "<synthetic>") return null;
  return s.replace(/\[[^\]]*\]$/, "");
}

// A member's name is the only place its unit of work is recorded — there is
// no dispatch sidecar at all (see ompMemberRecord).
//
// FOUR finisher spellings are live on disk, measured 2026-08-27 across every
// transcript: finisher-pr-<n>, finish-pr-<n>, finisher-<n>, finish-<n>. All
// four book a PR, and matching only the first cost 120 of 283 finisher
// members their join key to tier-outcomes.tsv. The fix-pr-<n> and
// review-pr-<n> families share the first pattern only because the infix is
// the same — they are NOT finisher spellings. `finisher-pr-<n>` is the
// canonical name run-team now fixes (#326); the other three stay matched
// because the runs that used them are already in the record.
//
// merge-bot-<n> is deliberately excluded: its number is a per-run dispatch
// counter, never a PR, and booking it as a pr would join the row to an
// unrelated PR's verdict. A single trailing lowercase letter is a retry
// suffix (-b, -c and -d all observed) and is stripped first, because a
// re-dispatched member works the same unit. A trailing `-v<n>` (`-v2`,
// `-v10`, ...) is a DIFFERENT spelling of the same re-dispatch, used when a
// controller re-dispatches a finisher/reviewer against a PR whose head moved
// after label (#1482, measured: ~67% of one finisher's tokens fell through
// to a blank pr column under the old letter-only regex); it is stripped for
// the same reason, not because it looks like a second-ticket suffix — no
// naming convention in this repo otherwise uses a literal `-v` + digits
// tail.
//
// The NUMERIC suffix on a TICKET-shaped name (`impl-137-2`) looks like the
// same retry spelling and is deliberately NOT stripped there. The one real
// instance on disk describes itself as "Implement 137+138+139 set" — a
// multi-ticket batch that no single `ticket` value represents. Blank is the
// honest answer; booking it to 137 would join the row to two tickets it did
// not do.
//
// A PR-shaped name's numeric suffix is a DIFFERENT case: `fix-pr-<n>`,
// `review-pr-<n>`, `finisher-pr-<n>` and `resolve-pr-<n>` carry exactly ONE
// number, the PR itself, so a second trailing `-\d+` cannot be a second
// ticket the way `impl-<ticket>-<n>`'s can — there is only ever one PR per
// such name. A trailing `-\d+` there (`finisher-pr-1440-2`, `fix-pr-1281-2`)
// is the same re-dispatch retry the letter and `-v<n>` suffixes above
// already cover, and is now stripped for PR-shaped names only (#1482,
// measured: 476,202 cache-create tokens across 7 real rows fell through to a
// blank pr column this way — more than the 37,580 the `-v<n>` fix above
// addressed). The ticket-shaped `impl-<ticket>-<n>` family above is
// untouched: its second-ticket ambiguity is real, and a PR-shaped name's is
// not.
//
// `resolve` joins the `-pr-` alternation for #1250: `resolve-pr-<n>` is a
// controller-dispatched conflict/rebase resolver against an already-open PR
// (measured session descriptions: "Resolve conflict on PR 1232", "Rebase
// and resolve conflicts for PR #1310") — the same shape as `fix-pr-<n>`'s
// applier and `review-pr-<n>`'s reviewer, just not a name run-team's own
// naming convention fixes, so it stays out of the canonical list in
// SKILL.md/member-lifecycle.md the same way `finish-<n>`/`finisher-<n>` do.
// Unrecognised, a `resolve-pr-<n>` member fell through to `{ticket:"",
// pr:""}`, losing its join key into tier-outcomes.tsv exactly the way an
// unmatched finisher spelling once did (#1072).
export function parseMemberName(name) {
  const s = String(name ?? "").trim().replace(/-(?:[a-z]|v\d+)$/, "");
  let m = /^(?:fix|review|finish(?:er)?|resolve)-pr-(\d+)(?:-\d+)?$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^finish(?:er)?-(\d+)$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^impl-(\d+)$/.exec(s);
  if (m) return { ticket: m[1], pr: "" };
  return { ticket: "", pr: "" };
}

// ---------------------------------------------------------------------------
// transcript reader
// ---------------------------------------------------------------------------

// An omp transcript line carries no `sessionId`/`parentUuid` — session id
// lives in the DIRECTORY name, never per line; omp's envelope is
// `{type,id,parentId,timestamp,message}`. That is the structural signature
// this reader refuses on if it is ever absent — a validation CHECK inside
// this reader, per #1302's ruling: every root this module is ever handed is
// an omp `~/.omp/agent/sessions/**` tree, so a line failing this shape
// signals a corrupted or foreign file, not a harness to dispatch to.
//
// Both halves of that signature are checked, not just the blocklist half: a
// line carrying neither Claude's keys NOR omp's own `type` field (e.g. a
// foreign/corrupted `{"foo":"bar"}`) used to sail past the blocklist-only
// check below and fold into a fabricated all-null/zero member record instead
// of the refusal this comment already promised. `type` is the one envelope
// field foldOmpTranscript's own loop dispatches every branch on below, so
// requiring it costs nothing a real omp line does not already carry.
function assertOmpShaped(d, filePath) {
  const shaped =
    d !== null &&
    typeof d === "object" &&
    typeof d.type === "string" &&
    d.type !== "" &&
    !Object.prototype.hasOwnProperty.call(d, "sessionId") &&
    !Object.prototype.hasOwnProperty.call(d, "parentUuid");
  if (!shaped) {
    throw new Error(`member-record: not an omp-shaped transcript line, refusing to parse it: ${filePath}`);
  }
}

// `openedPrs` (#2209) is every PR number the member's OWN `gh pr create`
// printed — the source of `pr` for a member whose name carries none, which is
// every implementer (`impl-<ticket>` names a ticket, never a PR). Chosen over
// the ledger's `impl-<N>=PR#M` settle token because that token is written by a
// live run only: a regeneration over past sessions has the transcript and
// nothing else, and this module stays pure over transcripts. Measured
// 2026-09-29 across every real `~/.omp/agent/sessions/**/*.jsonl`: every
// successful create was a `bash` toolCall whose result line printed gh's
// stdout — the URL on a line of its own — then omp's "Wall time" trailer.
//
// Three filters keep a URL that is NOT a PR this member opened out:
// - the CALL must invoke `gh pr create` (first in the command or after a
//   shell separator, optionally through `rtk`) — a `gh pr view`/`gh pr list`
//   result prints bare PR URLs too, and `gh pr create` quoted as text is no
//   invocation;
// - the URL must be a LINE of its own, the shape gh prints, never a URL
//   inside prose;
// - a URL right after gh's "... already exists:" refusal is skipped: that PR
//   was opened by someone else for the same branch.
// `isError` is deliberately NOT a filter: a create chained before a failing
// command (`gh pr create ... && gh pr edit --add-label x`) exits non-zero
// having still opened the PR it printed.
const GH_PR_CREATE_RE = /(?:^|[;&|(\n])\s*(?:rtk\s+)?gh\s+pr\s+create\b/;
function createdPrNumbers(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\s*$/.exec(lines[i]);
    if (m && !(i > 0 && /already exists:\s*$/.test(lines[i - 1]))) out.push(m[1]);
  }
  return out;
}

// Folds one omp subagent transcript into per-turn totals. One
// `message.usage` per assistant turn already (no cross-line fold-back
// needed), a real per-turn dollar cost at `usage.cost.total`, and the
// declared thinking level on its own `thinking_level_change` event rather
// than repeated per line. Measured 2026-09-08/09 against real
// `~/.omp/agent/sessions/**/*.jsonl` files:
//   {"type":"session",...,"cwd":"/Users/chris/dev/fleet-plugin"}
//   {"type":"thinking_level_change",...,"thinkingLevel":"high","configured":null}
//   {"type":"message","message":{"role":"assistant","model":"claude-sonnet-5",
//     "usage":{"input":2,"output":201,"cacheRead":0,"cacheWrite":31319,
//       "totalTokens":31522,"cost":{"input":4e-6,"output":0.00201,
//       "cacheRead":0,"cacheWrite":0.0783,"total":0.0803}}}}
//
// `thinking` reads the harness-WRITTEN level, never the frontmatter — that
// is what makes #1298's declared-vs-resolved comparison possible (#1302's
// ruling). It stays `null` here (ompMemberRecord turns that into the
// record's `-`) when no `thinking_level_change` line exists, rather than
// guessing the default: a member that is not a fleet definition genuinely
// has no recorded level, and the hole must stay visible.
//
// `session_init.task` is the closest thing to a dispatch sidecar this
// module has — there is no separate description file at all.
// ompMemberRecord below uses it, together with the transcript's own nesting
// depth AND the AgentId itself, as REAL classifyRole() signals. A
// canonically-stemmed AgentId (`impl-<n>`, `fix-pr-<n>`, `finisher-<n>`,
// `review-pr-<n>`, `merge-bot-<n>`) IS matched against classifyRole, as
// `memberName`, per #1506; only a non-canonical AgentId — a generated word
// pair that names nothing — is still never matched.
//
// `resolvedModelIdentity` (#1345) is `session_init`'s OWN field, written at
// DISPATCH — before the member's first assistant turn exists, which is what
// makes it different from `model` above: a member still working folds to
// `model: null` (no assistant turn yet) but already carries
// `resolvedModelIdentity` (measured `anthropic/claude-opus-5` (61),
// `anthropic/claude-sonnet-5` (103), `anthropic/claude-haiku-4-5` (68)
// across real `~/.omp/agent/sessions/**` — always provider-prefixed, never a
// bare alias). `model` itself is left untouched by this addition: board.mjs
// and member-outcomes.mjs read `model` for cost/spend attribution, where the
// per-turn value (which can in principle change mid-run) is the fact they
// want, not the dispatch-time identity.
//
// `agent` (#1066) is `session_init`'s dispatch-time record of WHICH AGENT
// DEFINITION this member is. Measured 2026-09-12 across real
// `~/.omp/agent/sessions/**`: present on every one of the 1,191 transcripts
// carrying a `session_init` line (`fleet-implementer` 51,
// `fleet-implementer-alt` 17, the default `task` 220, plus the review
// fan-out's own definitions), absent only where the line itself is.
//
// `entries` (#1717) is the per-agent tool stream compute-spend.mjs's
// attributeTools reads: `assistant`/`result` entries. Measured 2026-09-26
// across 5,085 real `~/.omp/agent/sessions/**/*.jsonl` files, the call is a
// block on the assistant message and the result a line of its own:
//   {"type":"message","message":{"role":"assistant","stopReason":"toolUse",
//     "content":[{"type":"toolCall","id":"toolu_01JV…","name":"bash",
//       "arguments":{…},"intent":"…"}],"usage":{…}}}
//   {"type":"message","message":{"role":"toolResult","toolCallId":"toolu_01JV…",
//     "toolName":"bash","content":[{"type":"text","text":"…"}],"details":{…},
//     "isError":false,"timestamp":1790415990525}}
// All 176,056 `toolCall` blocks carried `id` and `name`; the ~29-call gap
// against the 176,027 results below is orphan calls whose result never
// landed (aborted before the tool replied) — attributeTools still counts
// them under their own name via `calls++`, only `resultChars`/`cacheWrite`
// stay at 0. Each of the 176,027 results sat on its own line, so parallel
// calls arrive as consecutive `toolResult` lines, which attributeTools
// accumulates into one batch (run lengths 2 through 14 matched the
// calls-per-turn counts to within one).
//
// A result's `chars` sums its text blocks' lengths (`content` was an array
// every time: 179,380 text blocks, 14 image blocks — an unmeasured
// non-array `content` folds to 0 blocks and `chars: 0`). A non-text block
// (an image) counts at its JSON length. `prunedAt` (194) holds a
// placeholder such as "[Uneventful result elided]" instead of the output,
// so its `chars` is the placeholder's length.
//
// The result line names its tool (`toolName`), but the stream stays
// id-only, so a result whose id no `toolCall` block carries books as
// `unknown`. Measured, that is a turn aborted mid-stream (2 results): the
// tool's "not executed" result is written first, then the assistant message
// persists with empty content, so the call never lands. That aborted
// message is still an `assistant` entry, as is every line `turns` counts.
// 142 aborted or errored turns followed a result batch. When one never
// reached the API its usage is all zero, and attributeTools books the batch
// before it at 0.
//
// `openedPrs` (#2209) folds the `bash` calls that invoke `gh pr create`
// against their own results, via createdPrNumbers above — distinct PR
// numbers in first-seen order.
export function foldOmpTranscript(jsonlText, filePath) {
  let model = null, thinking = null, task = null, resolvedModelIdentity = null, agent = null;
  let firstTs = null, lastTs = null;
  let input = 0, cacheWrite = 0, cacheRead = 0, output = 0, cost = 0, turns = 0;
  let sawCost = false;
  let malformedNonLastLines = 0;
  const entries = [];
  const createCallIds = new Set();
  const openedPrs = new Set();
  const lines = String(jsonlText ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let d;
    // A torn tail (transcript read mid-write) is dropped, and costs at most
    // that one turn either way. A MIDDLE line failing the same parse is not
    // a live write in progress — it is lost data, and (#1717) it can desync
    // a toolCall from its toolResult, not just a turn's totals, so it is
    // counted, never for the last line.
    try { d = JSON.parse(raw); }
    catch { if (i !== lines.length - 1) malformedNonLastLines++; continue; }
    assertOmpShaped(d, filePath);
    if (typeof d.timestamp === "string") { firstTs ??= d.timestamp; lastTs = d.timestamp; }
    if (d.type === "thinking_level_change" && typeof d.thinkingLevel === "string") thinking = d.thinkingLevel;
    if (d.type === "session_init") {
      if (typeof d.task === "string") task = d.task;
      if (typeof d.resolvedModelIdentity === "string") resolvedModelIdentity = d.resolvedModelIdentity;
      if (typeof d.agent === "string") agent = d.agent;
    }
    const m = d.message;
    if (d.type === "message" && m?.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "toolCall" && c.name === "bash" && typeof c.arguments?.command === "string"
          && GH_PR_CREATE_RE.test(c.arguments.command)) createCallIds.add(c.id);
      }
    }
    if (d.type === "message" && m?.role === "assistant" && m.usage) {
      const u = m.usage;
      if (typeof m.model === "string" && m.model) model = m.model;
      const cw = Number(u.cacheWrite ?? 0);
      input += Number(u.input ?? 0);
      cacheWrite += cw;
      cacheRead += Number(u.cacheRead ?? 0);
      output += Number(u.output ?? 0);
      if (u.cost && typeof u.cost.total === "number") { cost += u.cost.total; sawCost = true; }
      turns++;
      const blocks = Array.isArray(m.content) ? m.content : [];
      entries.push({
        kind: "assistant", cacheWrite: cw,
        tools: blocks.filter((c) => c?.type === "toolCall").map((c) => ({ id: c.id, name: c.name })),
      });
    } else if (d.type === "message" && m?.role === "toolResult") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const chars = blocks.reduce(
        (n, b) => n + (b?.type === "text" && typeof b.text === "string" ? b.text.length : JSON.stringify(b).length), 0);
      entries.push({ kind: "result", results: [{ id: m.toolCallId, chars }] });
      if (createCallIds.has(m.toolCallId)) {
        const text = blocks.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
        for (const n of createdPrNumbers(text)) openedPrs.add(n);
      }
    }
  }
  const span = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : 0;
  return {
    model, thinking, task, resolvedModelIdentity, agent,
    input, cacheWrite, cacheRead, output,
    cost: sawCost ? cost : null,
    turns,
    wallS: Number.isFinite(span) ? Math.round(span) : 0,
    entries,
    malformedNonLastLines,
    openedPrs: [...openedPrs],
  };
}

// One member record from one omp transcript's fold. `member` is the AgentId
// (the filename stem, e.g. `InstallVerifySearch`) — there is no separate
// display name, so `ticket`/`pr` extraction runs against it directly.
//
// `role` is NEVER guessed off the bare AgentId ALONE — a generated CamelCase
// word pair names nothing classifyRole can read. FOUR real signals exist:
// `session_init.agent` (the agent DEFINITION the dispatch named),
// `session_init.task` (the dispatch prompt, when present), `spawnDepth` (the
// transcript's own nesting depth, supplied by readOmpSession from the walk —
// a fact about where the file lives, not a guess about what it is), and —
// per #1506's ruling below — the AgentId itself, handed to classifyRole as
// `memberName`. Depth matters on its own: classifyRole checks depth BEFORE
// any text match, specifically so a nested member whose task happens to
// read like a reviewer's ("Review PR 1353 correctness") still books as the
// fan-out specialist it structurally is, not a reviewer. None present
// yields `"-"` — the same visible-hole spelling as `thinking`, never a
// default like "other", which only makes sense where a real dispatch record
// backs it.
//
// `agent` reaches classifyRole as its `agentDefinition` (#1486, #1505). It
// is the same value the `subagent_type` column below already records, and
// withholding it here made classifyRole's FIRST branch — the one whose
// comment says memory-system work must "never land in review spend" —
// structurally unreachable, leaving every row's role decided by
// dispatch-prompt prose alone. Measured 2026-09-16 before the fix: 50
// omp/memory-proxy rows, not one of them `role=memory`, and a single
// definition (`fleet-review-verifier`) split across four buckets on nothing
// but how each prompt happened to read.
//
// #1506's gap: `memberName` used to be left unset here on the theory that
// the AgentId genuinely is not a name — a generated CamelCase word pair
// (`InstallVerifySearch`) names nothing the classifier can read. True for
// the ordinary case, but false for members dispatched under run-team's own
// naming convention: `impl-<n>`, `fix-pr-<n>`, `finisher-<n>`, `finish-<n>`,
// `review-pr-<n>` and `merge-bot-<n>` ARE the dispatch name — exactly why
// `parseMemberName` runs against this same stem below. Those members are
// dispatched under the generic default `task` definition (`folded.agent` is
// `undefined`), so the definition-based fix above cannot reach them, and
// they fall through to prose classification of `folded.task` alone.
// Measured against docs/metrics/member-outcomes.tsv (#1506): 478 omp rows
// carry such an AgentId, 52 of them booked `other` for want of this signal —
// 31 `fix-pr-*`, 9 `impl-*` and 12 `merge-bot-*` members whose dispatch
// prompt never happens to name the role.
//
// RULED: pass the AgentId unconditionally — NOT gated on looking
// name-shaped first. Every name-driven branch in classifyRole is
// hyphen-anchored (`^impl-`, `review-pr-`, `fix-pr-`, `^finish-`) or a
// multi-word phrase ("implement ticket", "review pr"), so a stray generated
// word pair cannot coincidentally satisfy one; the one bare-word pattern,
// `finisher`, carries that risk today and has not fired on the 4,574
// sidecars measured for #1505. `OMP_CANONICAL_STEM_RE` below exists only to
// widen `hasRoleSignal` itself: a canonically-named member whose transcript
// predates #1343 (no `session_init` line at all, so neither `task` nor
// `agent` exist) still holds a readable identity and must not fall back to
// the "-" hole. Measured 2026-09-16: zero such rows on disk today, but the
// gate exists so the design does not assume that stays true forever. Built
// from `CANONICAL_MEMBER_NAME_PREFIXES` (compute-spend.mjs) rather than its
// own copy of the prefix list, so the two cannot drift apart.
//
// REJECTED: dispatching these roles under real agent definitions instead
// (the issue's other named approach) — a controller/dispatch-convention
// change, out of scope for a classifier fix, and unlike this one it cannot
// repair the 478 historical rows already on disk.
const OMP_CANONICAL_STEM_RE = new RegExp(`^(?:${CANONICAL_MEMBER_NAME_PREFIXES})-`);
export function ompMemberRecord(folded, agentStem, spawnDepth = 0) {
  if (!folded.model) return null; // no assistant turn — not a real member transcript
  const member = agentStem;
  const named = parseMemberName(member);
  const { ticket } = named;
  // A name-carried PR (`fix-pr-<n>`, `finisher-<n>`, ...) is the member's unit
  // of work by construction and wins. Otherwise (#2209) the one PR its own
  // `gh pr create` printed; none, or more than one (measured: impl-1578 opened
  // its real PR plus a throwaway probe PR), stays blank — never a guess.
  const pr = named.pr || (folded.openedPrs?.length === 1 ? folded.openedPrs[0] : "");
  const hasRoleSignal = spawnDepth >= 1 || typeof folded.task === "string" || typeof folded.agent === "string"
    || OMP_CANONICAL_STEM_RE.test(member);
  const role = hasRoleSignal
    ? classifyRole({ agentDefinition: folded.agent, memberName: member, description: folded.task, spawnDepth })
    : "-";
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
    // carries no `session_init` line to read one from.
    subagent_type: folded.agent ?? "",
    tokens_in: folded.input, tokens_cache_create: folded.cacheWrite,
    tokens_cache_read: folded.cacheRead, tokens_out: folded.output,
    cost: folded.cost,
    wall_s: folded.wallS, turns: folded.turns,
    ticket, pr,
  };
}

// ompMemberRecord straight from the transcript text. board.mjs's live spend
// panel calls the two halves itself instead, because it needs the fold's tool
// stream (#1717) beside the record, and folding the file twice for it would
// parse every transcript twice on every tick.
export function readOmpMember(jsonlText, filePath, agentStem, spawnDepth = 0) {
  return ompMemberRecord(foldOmpTranscript(jsonlText, filePath), agentStem, spawnDepth);
}

// One omp session directory's member transcripts, as the walk both readers of
// that directory need it: readOmpSession below, and board.mjs's live spend
// panel (#1716), which folds each file itself so it can keep its own
// per-transcript skip tally. RECURSIVE: a member can itself dispatch further
// members (measured on disk — a research session's `Facts1303/` held seven
// more `.jsonl` files one level down), and `agent` is the path-relative stem
// so those nest instead of colliding. `spawnDepth` is read straight off
// that path — one `/` per nesting level — and handed to ompMemberRecord as a
// real fact about the walk, not a guess about the member.
//
// Throws when the directory itself cannot be listed; the caller decides what
// that means.
export function ompSessionTranscripts(sessionDir) {
  return readdirSync(sessionDir, { recursive: true })
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      file: join(sessionDir, f),
      agent: f.replace(/\.jsonl$/, ""),
      spawnDepth: (f.match(/[\\/]/g) ?? []).length,
    }));
}

// Walks one omp session directory into records, via the walk above.
//
// Deliberately NOT wrapped in a blanket try/catch around readOmpMember: the
// wrong-shape refusal (assertOmpShaped, inside foldOmpTranscript) must
// propagate all the way out of readMembers, uncaught, per #1342's acceptance
// criterion. Only the directory listing and the raw file read are given the
// ordinary per-member tolerance.
export function readOmpSession(sessionDir) {
  let transcripts;
  try { transcripts = ompSessionTranscripts(sessionDir); }
  catch { return []; }
  const session = basename(sessionDir);
  const rows = [];
  for (const { file, agent, spawnDepth } of transcripts) {
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch { continue; }
    const rec = readOmpMember(text, file, agent, spawnDepth); // may throw — see comment above
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
// tree to search — member-outcomes.mjs's CLI, so the pattern is defined once.
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
// readMembers — the one entry point
// ---------------------------------------------------------------------------

// The adapter's public entry point. A root that resolves to no session
// directory anywhere is refused rather than silently skipped: silently
// returning no rows for a typo'd path is the blackout #1302's ruling exists
// to prevent.
export function readMembers(roots) {
  const rows = [];
  for (const root of [].concat(roots ?? [])) {
    const dirs = findOmpSessionDirs(root);
    if (dirs.length === 0) {
      throw new Error(`member-record: no omp session directory found anywhere under this root, refusing to silently contribute nothing: ${root}`);
    }
    for (const dir of dirs) rows.push(...readOmpSession(dir));
  }
  return rows;
}
