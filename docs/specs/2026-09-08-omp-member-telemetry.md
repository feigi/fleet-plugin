# Research: where does omp keep per-member model, effort and token data?

Answers `feigi/fleet-plugin#1295`. Primary sources: `omp://session.md`, `omp://session-operations-export-share-fork-resume.md`, `omp://tools/task.md`, `omp://agent-hub.md`, `omp://rpc.md`, `omp://extensions.md`, and the `@oh-my-pi/pi-coding-agent` / `@oh-my-pi/omp-stats` source shipped in the local npm install (`omp/18.1.14`, resolved at `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src` and `.../@oh-my-pi/omp-stats/src`). Every claim below is either a doc quote with file:line for the backing source, or a measurement against a real, currently-live omp session on this box (`~/.omp/agent/sessions/-dev-fleet-plugin/2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127`, the wayfinder session that dispatched this very research ticket).

## Verdict up front

Model, tokens, and **cost** are fully recoverable per subagent, in a shape strictly easier to consume than Claude Code's — omp already folds per-turn usage into one JSON object per API turn and computes real dollar cost inline, so both of `member-outcomes.mjs`'s defensive "fold jsonl lines back into turns on `message.id`" blocks (its own comment, `scripts/member-outcomes.mjs:77-93`, and `board.mjs:339-345`) are dead code once ported — omp's session format doesn't split one turn across multiple JSONL lines.

**Effort/thinking level is the one field with a genuine, confirmed gap.** The *configured* selector (a concrete level like `high`, or the literal string `auto`) is recoverable from `session_init.resolvedModel`'s `:suffix`. But the common case — an agent configured `auto` (this is the *default* for every bundled/plugin agent observed on this box except the top-level `task` agent) — never persists the concrete per-turn level (`low`/`medium`/`high`/`xhigh`/`max`) that omp's own auto-thinking classifier actually picked. That classification result only becomes a persisted `thinking_level_change` entry when it *differs* from the session's current level, and a subagent's initial provisional level is chosen to already match the model's default — so for a typical short-lived subagent, no such entry is ever written. Confirmed by grepping four real completed/live subagent transcripts on this box: zero `thinking_level_change` entries in any of them, despite every one having an `auto` selector. This matches `@oh-my-pi/omp-stats`'s own `MessageStats` type, which is omp's official first-party usage-extraction schema and has no effort/thinking field at all (`omp-stats/src/types.ts:9-38`).

## 1. Session storage layout

Source: `omp://session.md` ("On-Disk Layout"), confirmed against real files.

```
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl        # root/main session
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>/<AgentId>.jsonl   # subagent transcript
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>/<AgentId>.md      # subagent's yield output
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>/<AgentId>.json    # structured-output sidecar (when the caller passed outputSchema)
```

`<encoded-cwd>` encoding (`omp://session.md` "On-Disk Layout", implemented in `pi-coding-agent/src/session/session-paths.ts:44-52,71-97`; **not** the same scheme Claude Code uses): computed from the canonicalized (symlink-resolved) cwd as `-<relative>` for directories under `$HOME` (path relative to home), `-tmp-<relative>` under the temp root (`os.tmpdir()` — `/var/folders/…/T` on macOS, not `/tmp`), `--<absolute>--` otherwise, with **only** path separators and `:` replaced by `-` — dots, underscores and other characters survive (real dir on this box: `-dev-fleet-plugin-.worktrees-1160-no-undo-audit-stderr-abort`). `board.mjs:268-269`'s `encodeProjectDir` (blanket `[^a-zA-Z0-9]` → `-` over the full absolute path) is wrong for the home-relative case, the one fleet actually hits: it keeps the home prefix the real scheme strips and rewrites dots, so for this repo it yields `-Users-chris-dev-fleet-plugin` where omp's real dir is `-dev-fleet-plugin`, and `-Users-chris-dev-fleet-plugin--worktrees-…` where omp's is `-dev-fleet-plugin-.worktrees-…`. It only coincidentally agrees on the temp branch, and then only when the temp root is literally `/tmp` (e.g. Linux with `TMPDIR` unset) and the relative path has no dots or other non-alphanumerics (`/tmp/foo` → `-tmp-foo` both ways). The absolute branch is wrong too (`/opt/x` → `-opt-x` vs omp's `--opt-x--`; on this box a `/tmp` cwd canonicalizes to `/private/tmp/…`, lands outside `os.tmpdir()`, and is stored as `--private-tmp-fleet-dispatch-test--`). A port needs the three-way branch, not a reused single regex.

The artifacts directory is the session file path with the trailing `.jsonl` stripped — verified in source, not just doc:

```ts
// session/session-manager.ts:110-113
function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH); // ".jsonl".length
}
```

Subagent transcripts sit **directly inside** that directory (`<AgentId>.jsonl`), one level, not under a fixed subdirectory name the way Claude Code uses `subagents/`. A subagent's own subagent (nested spawn) gets **its own** artifacts dir the same way — `<parent_stem>/<ChildAgentId>/<GrandchildAgentId>.jsonl` — since the child's `.jsonl` file, once it exists, has the identical `.slice(0,-6)` artifacts-dir rule applied recursively. `omp-stats`'s own trace walker (`omp-stats/src/trace.ts`, `buildTrackTree`, depth-capped at `MAX_TRACK_DEPTH = 6`) confirms this by construction — it recurses into each track's own artifacts dir to find its children.

**Per-subagent records are real, separate session files** — not inline entries in the parent. Confirmed by directory listing of the real wayfinder session:

```
$ ls ~/.omp/agent/sessions/-dev-fleet-plugin/2026-09-08T*_01a08126*/
FleetSurfaceInventory.jsonl  FleetSurfaceInventory.md   FleetSurfaceInventory.json
OmpExtensionModel.jsonl      OmpExtensionModel.md       OmpExtensionModel.json
ResearchEvalHost.jsonl       ResearchTelemetry.jsonl    SaveAgentDialectDrift.jsonl
SaveDualHarnessDecision.jsonl  SaveDualHarnessDecision.md
SaveOmpPluginInterop.jsonl     SaveOmpPluginInterop.md
21.bash-original.log
```

(`ResearchTelemetry.jsonl` is this very subagent's own live session file, and `ResearchEvalHost.jsonl` is a sibling still running as this was written.)

Each `<AgentId>.jsonl` is a **complete, independently-loadable omp session** — same `SessionHeader` + `SessionEntry` format as a main session (`omp://session.md` "Entry Taxonomy"), not a stripped-down record. It has its own `model_change`, `session_init`, `message`, `credential_pin`, and (for automatic-thinking models) potential `thinking_level_change` entries.

## 2. Per-subagent usage (tokens, cost)

Fully persisted, per turn, inline on every assistant `message` entry — no separate side-channel needed. From `omp://session.md` ("message" entry example) and confirmed on a real transcript line:

```json
{
  "type": "message",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "usage": {
      "input": 8, "output": 439, "cacheRead": 59196, "cacheWrite": 6209,
      "totalTokens": 65852,
      "cost": { "input": 8e-06, "output": 0.002195, "cacheRead": 0.0059196, "cacheWrite": 0.00776125, "total": 0.01588385 },
      "cttl": { "ephemeral5m": 6209 }
    }
  }
}
```

Key architectural difference from Claude Code that changes how a port should be written, not just where it reads from: **omp writes one `message`-type JSONL entry per completed API turn**, with the turn's full content (thinking blocks, tool calls, text) as one `content` array inside that single entry, and exactly one `usage` object on it. Claude Code instead writes one raw JSONL *line* per content block, all repeating the same `message.id` and the same `usage` object — which is why `board.mjs:339-345` and `member-outcomes.mjs:77-93` both carry heavy, measured commentary about folding lines back into turns on `message.id` (a real, measured Claude Code bug: +206% cache-write overcount if you sum naively). **That fold-back step has no work to do under omp** — summing every assistant `message` entry's `usage` directly, once per entry, is already correct. Porting the fold-back logic unchanged is harmless (it degrades to a no-op grouping of one line per group) but is dead weight worth dropping, not preserving.

A second usage channel exists that Claude Code has no equivalent of: `model_usage` entries, for auxiliary model calls that aren't part of the visible conversation (auto-thinking classification, title generation, etc.):

```json
{
  "type": "model_usage", "purpose": "auto-thinking", "role": "smol",
  "model": "claude-haiku-4-5",
  "usage": { "input": 786, "output": 143, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 929,
             "cost": { "total": 0.001501, ... } },
  "stopReason": "stop"
}
```

`@oh-my-pi/omp-stats`'s own extractor treats these identically to assistant messages (`omp-stats/src/parser.ts:230-260`, `extractModelUsageStats` delegates straight into the same `extractStats`). A faithful port should sum both entry types if it wants the true per-agent spend total; summing only `message` entries undercounts by the classifier's own token cost (small, but real — $0.0015 on the sampled child).

**Cost is a genuine upgrade over the Claude Code source.** `usage.cost.total` is a real, already-priced dollar figure computed by omp itself at write time — `board.mjs`/`member-outcomes.mjs` currently have no cost field at all (Claude Code transcripts carry only raw token counts; any pricing table lives outside these two scripts, unverified in this research since it's out of scope). The `omp-stats` README notes one caveat worth carrying forward: "Subscription-backed models use matching public API prices when an exact public model exists... Subscription-only models without a public price are reported as N/A and excluded from dollar totals" — so `cost.total` can legitimately be `0` for a model with no public price, which is not the same as "free."

## 3. Effort / thinking level — the confirmed gap

Source: `packages/coding-agent/src/task/executor.ts:3210-3232`, `src/sdk.ts:1599-1635`, `src/session/model-controls.ts:589-666`, `src/thinking.ts:373-377`, plus direct inspection of four real transcripts.

**What is recoverable, reliably:** the *configured* thinking selector at spawn time, from the child's own `session_init.resolvedModel`:

```
FleetSurfaceInventory (agent=scout):        resolvedModel = "anthropic/claude-haiku-4-5:auto"
OmpExtensionModel (agent=scout):            resolvedModel = "anthropic/claude-haiku-4-5:auto"
SaveDualHarnessDecision (agent=memory-proxy): resolvedModel = "anthropic/claude-haiku-4-5:auto"
ResearchEvalHost (agent=task):              resolvedModel = "anthropic/claude-sonnet-5:high"
```

The `:suffix` grammar is `formatModelSelectorValue` (`config/model-resolver.ts:265-267`): `${selector}:${thinkingLevel}` whenever the configured level isn't `Inherit`. This is exactly the field `@oh-my-pi/omp-stats`'s own Traces feature surfaces as `TraceTrack.model` — *"`session_init.resolvedModel` ?? first assistant model"* (`omp-stats/src/shared-types.ts:539-540`, built at `omp-stats/src/trace.ts:296-297`) — so this is not a research inference, it's the field omp's own shipped dashboard already uses for this exact purpose.

**What is not recoverable when the selector is `auto`** (which is the default for every subagent sampled here except the top-level `task` agent): the concrete level (`low`/`medium`/`high`/`xhigh`/`max`) that omp's per-turn auto-thinking classifier actually picked for that specific turn. The mechanism:

- `applyAutoThinkingLevel()` (`session/model-controls.ts:598-666`) runs once per real user turn on any session with `isAutoThinking` true — **this includes subagent sessions**, since a subagent's task text is delivered as a `role: "user"` first turn, and `#host` is just `this` (the child's own `AgentSession`), not something main-session-specific.
- The classifier call is itself billed and recorded as a `model_usage` entry (`purpose: "auto-thinking"`, confirmed present in the real `FleetSurfaceInventory.jsonl`).
- Its *result* is only written as a durable `thinking_level_change` entry when `shouldPersistResolution = this.#thinkingLevel !== effort` (`model-controls.ts:653-658`) — i.e., only on a **change**.
- A subagent's initial in-memory level is `resolveProvisionalAutoLevel(model)` (`thinking.ts:373-377`): the model's own `thinking.defaultLevel`, or `High`, clamped. In practice the classifier's first-turn result usually matches this provisional default, so `shouldPersistResolution` is false and **nothing is ever written**.

Measured: grepping all four sample transcripts (`FleetSurfaceInventory.jsonl`, `OmpExtensionModel.jsonl`, `SaveDualHarnessDecision.jsonl`, `SaveOmpPluginInterop.jsonl`) for `thinking_level_change` and for a per-message `effort`/`thinkingLevel` key returns **zero hits** in every case, despite every one having `thinkingSignature` blocks proving thinking was genuinely active. No assistant `message` entry carries an `effort` field of any kind (full observed key set: `api, completedAt, content, contextSnapshot, duration, model, provider, responseId, role, stopReason, timestamp, ttft, usage` — confirmed by exhaustively enumerating every distinct key set across a real transcript). This is the omp equivalent of the `d.effort` field `member-outcomes.mjs:109` reads from Claude Code's transcript, and it simply does not exist.

The only other place a concrete level could show up is the caller-supplied `effort: "lo"|"med"|"hi"` on the `task` tool call itself (`omp://tools/task.md` Inputs table) — but that field is gated behind `task.enableEffort`, **default `false`**, and even when used it maps through `resolveTaskEffortLevel` into the same `session_init.resolvedModel:<level>` suffix already covered above, not a separate persisted field.

**Bottom line:** effort is recoverable as "the configured selector, which is usually the literal string `auto` and therefore not actionable as a concrete tier" for the common case, and as a genuine concrete level only for an agent explicitly pinned away from `auto` (like the sampled `task` agent, pinned to `:high`). A port that needs concrete per-turn effort to A/B-test tiers (as `implementer-model-tier.test.mjs` does today) has **no persisted source for it** when the agent runs `auto` — this is not a missing-research question, it is a real product gap in what omp durably records.

## 4. Agent Hub — is its structure independently readable?

Source: `omp://agent-hub.md`.

Agent Hub is TUI-internal live state: "The roster updates from the session's agent registry and progress events." That registry (`AgentRegistry`, `packages/coding-agent/src/registry/agent-registry.ts`, per `omp://tools/task.md` Source list) is an in-process, per-process-lifetime object — there is no on-disk or socket-exposed copy of it for an external script to read. Agent Hub's *display* fields (cost, tokens, model role, resolved model) are all sourced from the same session JSONL files documented above plus live in-memory progress — "Opening the Hub for a persisted session scans that session's artifact tree. Historical subagent JSONL files become parked rows" (`omp://agent-hub.md` "Persisted agents and advisors"). So Agent Hub is not a *separate* structure a script could read instead of the files — it's a live view over the exact same files, plus in-memory state that only exists inside a running omp process and isn't exposed for out-of-process reads. **Not usable by `board.mjs`.**

## 5. `--mode json`, RPC/SDK, and `agent_end` — none of these fit a script running outside a session

Source: `omp://cli-reference.md`, `omp://rpc.md`, `omp://extensions.md`.

All three are for observing or driving a session **while its own omp process is alive**:

- `--mode json` (`omp -p --mode json "..."`) "emit[s] structured events instead of rendered text" for *that one invocation's own run* — it is a headless print-mode replacement for the TUI, not a query interface over other sessions' history.
- RPC mode (`omp --mode rpc`) is a newline-delimited JSON protocol over the stdio of an omp process **you spawn and own**. It does have exactly the right shape for subagent introspection — `get_subagents`, `get_subagent_messages` (with `fromByte` incremental reads), and a `subagent_lifecycle`/`subagent_progress`/`subagent_event` frame stream gated by `set_subagent_subscription` (`omp://rpc.md` "Session"/"Subagent subscriptions") — but only for the subagents of *that* RPC-mode process's own live session. There is no "attach to an already-running omp process and ask about its subagents" RPC command; you'd have to be the parent that spawned it.
- Extensions' `agent_end` event (`omp://extensions.md` "Prompt and turn lifecycle") is in-process only — an extension module loaded into a specific running session, not something a separate script can subscribe to externally.

None of these are available to `board.mjs`/`member-outcomes.mjs`'s actual execution model: **a plain Node script, run on a schedule or manually, against sessions it did not spawn and has no live connection to** (including the currently-in-flight one, which is exactly what `board.mjs`'s "rank by newest transcript mtime" logic exists to find). For that posture, the only viable source under omp is the same one Claude Code uses: read the session JSONL tree directly off disk. This is not a downgrade — it's the same shape of solution, just against a richer, better-normalized file format.

## Field-by-field mapping

| `board.mjs` / `member-outcomes.mjs` field | Claude Code source | omp source | Status |
|---|---|---|---|
| Project transcript root | `~/.claude/projects/<encoded-cwd>/` (`board.mjs:268-269`, naive `[^a-zA-Z0-9]→-`) | `~/.omp/agent/sessions/<encoded-cwd>/` — 3-branch encoding (home/`tmp`/absolute), `omp://session.md` "On-Disk Layout" | **Different encoding; must reimplement per omp's own scheme, not reuse `encodeProjectDir`** |
| Live session picking | newest `subagents/` dir by newest `.jsonl` mtime inside it (`board.mjs:272-297`) | newest top-level `<timestamp>_<sessionId>.jsonl` by mtime, in the same encoded-cwd dir (no fixed `subagents/` subdir — children live in `<file-stem>/`) | Direct equivalent, different directory shape |
| Subagent transcript location | `<session>/subagents/*.jsonl` (+ nested `workflows/wf_<id>/*.jsonl`) | `<session-stem>/<AgentId>.jsonl` (+ nested `<session-stem>/<ParentAgentId>/<ChildAgentId>.jsonl` for a subagent's own subagent) | Direct equivalent, one less fixed path segment |
| Member identity / `agent` key | transcript path-relative stem, since `meta.name`/`meta.agentType` collide across unnamed dispatches (`member-outcomes.mjs:208-213`) | `<AgentId>.jsonl` filename stem — `AgentOutputManager` guarantees this is unique **within the whole agent tree**, not just within one session (`omp://tools/task.md` "Notes") | Direct equivalent, stronger uniqueness guarantee |
| `model` (per turn, last-wins) | `message.model` on each raw transcript line (`member-outcomes.mjs:107-108`) | `message.model` on each `message`-type entry, bare model id, one entry per turn (no fold-back needed) | **Direct equivalent** |
| `effort` (per turn, last-wins) | `d.effort` string field on each transcript line (`member-outcomes.mjs:109`) | *(none)* — no per-turn field exists | **NO EQUIVALENT** for the concrete per-turn value |
| Effort — configured selector only | *(n/a, Claude Code has no separate configured/actual split)* | `session_init.resolvedModel`'s `:suffix` (concrete level, or literal `"auto"`) | **PARTIAL** — present but frequently `auto`, i.e. non-actionable, and never resolved to a concrete level when it is |
| `tokensCacheCreate` / `cacheWrite` | summed `cache_creation_input_tokens`, deduped per `message.id` across multiple raw lines (`member-outcomes.mjs:77-93,115`) | `message.usage.cacheWrite`, already one value per turn | **Direct equivalent, no dedup step required** |
| `cacheRead` (board.mjs only) | summed `cache_read_input_tokens` per turn (`board.mjs:423-427`) | `message.usage.cacheRead` | **Direct equivalent** |
| `tokensOut` / output | max `output_tokens` across a turn's lines, summed across turns (streaming-snapshot caveat) (`member-outcomes.mjs:88-89,118`) | `message.usage.output`, one final value per turn — no streaming-snapshot caveat (persisted post-completion) | **Direct equivalent, simpler** |
| `maxCtx` (context window estimate) | `input_tokens + cacheRead + cacheWrite`, maxed across turns (`board.mjs:427`) | `usage.input + usage.cacheRead + usage.cacheWrite`, same formula | **Direct equivalent** |
| Dollar cost | *(none — not read by either script today)* | `usage.cost.{input,output,cacheRead,cacheWrite,total}`, computed by omp itself per turn | **NEW, strict upgrade** — caveat: `0`/unpriced for subscription-only models with no public rate card |
| `wallS` (span) | `lastTs - firstTs` over the entry-level `d.timestamp` on every transcript line — an ISO-8601 **string**, hence `Date.parse` (`member-outcomes.mjs:96,104,127`) | either the entry-level `timestamp` (also an ISO-8601 string, on every entry — `Date.parse` ports unchanged) or `message.timestamp` on `message` entries (a **numeric** epoch-ms — subtract directly; what the §6 PoC uses) | **Equivalent, but the two omp fields are not interchangeable** — `Date.parse` on the numeric `message.timestamp` is `NaN`, and they are different instants (measured on an assistant entry: `message.timestamp` is when the turn started, the entry `timestamp` when it was persisted, ~9 s later), so pick one and never mix them |
| `turns` | count of distinct `message.id` groups (`member-outcomes.mjs:97,111-117,132`) | count of `message`-type, `role:"assistant"` entries directly (each *is* one turn already) | **Direct equivalent, no grouping needed** |
| `role` classification input: `meta.agentType`/`description`/`customAgentType` | `.meta.json` sidecar beside the transcript, `customAgentType` **conditional** on a *named* `subagent_type` dispatch (measured 22/241 present) | `session_init.agent` on the child's own `.jsonl` — the dispatched agent type name (e.g. `scout`, `fleet-implementer`), **unconditionally present** on every subagent, no separate sidecar file | **Direct equivalent, stronger** (no conditional-presence trap, no second file to open) |
| `description` (short label) | `.meta.json`'s `description` | *(none)* — `session_init.task` carries the **full** task prompt text, not a short label; the UI's one-line label is generated on the fly by a tiny model and not persisted | **NO EQUIVALENT** for a short label; full text available instead |
| `ticket`/`pr` (parsed from member name) | pure string parsing of the member/agent name (`member-outcomes.mjs:30-61`) | same pure string parsing, applied to the `<AgentId>.jsonl` stem | Ports unchanged — depends on fleet's own naming convention for dispatched `name` params, not on the harness |
| Torn-line / live-tail-write handling | per-line `JSON.parse` try/catch, last line only (`board.mjs:320-338`, `member-outcomes.mjs:66-71,99-102`) | identical hazard — a child `.jsonl` can be read mid-append the same way | Ports unchanged |
| `session` / `run_date` | session dir basename / newest transcript mtime (`member-outcomes.mjs:192-193`) | session header `id` (or artifacts-dir basename) / newest child-file mtime | **Direct equivalent** |

## 6. Worked example

Run against a real omp session on this box — the wayfinder session that dispatched this very ticket (`~/.omp/agent/sessions/-dev-fleet-plugin/2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127`). No omp process was involved; this is a plain Node script reading files off disk, structurally equivalent to `member-outcomes.mjs`'s own posture.

```js
// /tmp/omp-member-outcomes-poc.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const sessionFile = process.argv[2]; // path to the ROOT session .jsonl
const artifactsDir = sessionFile.slice(0, -".jsonl".length);

function readChild(path) {
  const text = readFileSync(path, "utf8");
  let agent = null, modelRole = null, resolvedModel = null, lastModel = null;
  let input = 0, out = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  let auxCalls = 0, auxCost = 0;
  // message.timestamp is numeric epoch ms, NOT the entry-level ISO string
  // member-outcomes.mjs Date.parse()s — never mix the two (see mapping table).
  let turns = 0, firstTs = null, lastTs = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (d.type === "session_init") {
      agent = d.agent; modelRole = d.modelRole; resolvedModel = d.resolvedModel;
    } else if (d.type === "message") {
      const m = d.message;
      if (m?.timestamp) { firstTs ??= m.timestamp; lastTs = m.timestamp; }
      if (m?.role === "assistant" && m.usage) {
        turns++;
        lastModel = m.model;
        input += m.usage.input || 0;
        out += m.usage.output || 0;
        cacheRead += m.usage.cacheRead || 0;
        cacheWrite += m.usage.cacheWrite || 0;
        cost += m.usage.cost?.total || 0;
      }
    } else if (d.type === "model_usage") {
      // auxiliary calls (auto-thinking classifier etc.): billed, but not turns (§2)
      auxCalls++;
      auxCost += d.usage?.cost?.total || 0;
    }
  }
  const wallS = firstTs && lastTs ? Math.round((lastTs - firstTs) / 1000) : 0;
  return { agent, modelRole, resolvedModel, lastModel, turns, wallS,
    input, out, cacheRead, cacheWrite, cost, auxCalls, auxCost };
}

const usd = (n) => `$${n.toFixed(6)}`;
for (const f of readdirSync(artifactsDir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const r = readChild(join(artifactsDir, f));
  console.log(`--- ${f}  agent=${r.agent} modelRole=${r.modelRole} selector=${r.resolvedModel} lastModel=${r.lastModel}`);
  console.log(`  turns=${r.turns} wallS=${r.wallS} input=${r.input} out=${r.out} cacheRead=${r.cacheRead} cacheWrite=${r.cacheWrite}`);
  console.log(`  cost: turns=${usd(r.cost)} + model_usage=${usd(r.auxCost)} (calls=${r.auxCalls}) = ${usd(r.cost + r.auxCost)}`);
}
```

Output, pasted verbatim from running exactly the script above (`node /tmp/omp-member-outcomes-poc.mjs ~/.omp/agent/sessions/-dev-fleet-plugin/2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127.jsonl`) on 2026-09-24, during PR #1784's review. The session has grown since this research was first written — 17 children rather than 7, and children that were still live or later resumed then (`ResearchEvalHost`, `ResearchTelemetry`, `SaveAgentDialectDrift`) have since moved on — so these figures supersede the first run's. The four children that had already finished by then (`FleetSurfaceInventory`, `OmpExtensionModel`, `SaveDualHarnessDecision`, `SaveOmpPluginInterop`) reproduce the original turn/token/cost figures exactly:

```
--- FleetSurfaceInventory.jsonl  agent=scout modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=10 wallS=122 input=82 out=8173 cacheRead=370189 cacheWrite=75924
  cost: turns=$0.172871 + model_usage=$0.001501 (calls=1) = $0.174372
--- MapUpdate.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=14 wallS=71 input=28 out=5024 cacheRead=543877 cacheWrite=29572
  cost: turns=$0.233001 + model_usage=$0.000000 (calls=0) = $0.233001
--- Memory1.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=2 wallS=20 input=4 out=1657 cacheRead=31319 cacheWrite=34333
  cost: turns=$0.108674 + model_usage=$0.000000 (calls=0) = $0.108674
--- Memory2.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=3 wallS=37 input=6 out=2959 cacheRead=82059 cacheWrite=24843
  cost: turns=$0.108121 + model_usage=$0.000000 (calls=0) = $0.108121
--- Memory3.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=5 wallS=48 input=10 out=3439 cacheRead=135094 cacheWrite=41680
  cost: turns=$0.165629 + model_usage=$0.000000 (calls=0) = $0.165629
--- Memory4.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=5 wallS=28 input=10 out=2275 cacheRead=134338 cacheWrite=37795
  cost: turns=$0.144125 + model_usage=$0.000000 (calls=0) = $0.144125
--- Memory5.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=2 wallS=16 input=4 out=1198 cacheRead=31335 cacheWrite=33056
  cost: turns=$0.100895 + model_usage=$0.000000 (calls=0) = $0.100895
--- OmpCopyExcludes.jsonl  agent=scout modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=13 wallS=142 input=106 out=6969 cacheRead=559390 cacheWrite=64063
  cost: turns=$0.170969 + model_usage=$0.000779 (calls=1) = $0.171748
--- OmpExtensionModel.jsonl  agent=scout modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=9 wallS=186 input=74 out=13891 cacheRead=376719 cacheWrite=86646
  cost: turns=$0.215508 + model_usage=$0.000000 (calls=1) = $0.215508
--- OmpManifestCI.jsonl  agent=scout modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=21 wallS=123 input=180 out=10815 cacheRead=875403 cacheWrite=54095
  cost: turns=$0.209414 + model_usage=$0.001487 (calls=1) = $0.210901
--- ResearchEvalHost.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=53 wallS=765 input=106 out=48471 cacheRead=5998671 cacheWrite=164785
  cost: turns=$2.096619 + model_usage=$0.000000 (calls=0) = $2.096619
--- ResearchTelemetry.jsonl  agent=task modelRole=task selector=anthropic/claude-sonnet-5:high lastModel=claude-sonnet-5
  turns=72 wallS=715 input=144 out=54498 cacheRead=9957938 cacheWrite=232408
  cost: turns=$3.117876 + model_usage=$0.000000 (calls=0) = $3.117876
--- SaveAgentDialectDrift.jsonl  agent=memory-proxy modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=8 wallS=1266 input=72 out=7156 cacheRead=180996 cacheWrite=69483
  cost: turns=$0.140805 + model_usage=$0.000821 (calls=1) = $0.141626
--- SaveDualHarnessDecision.jsonl  agent=memory-proxy modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=7 wallS=74 input=64 out=5326 cacheRead=210690 cacheWrite=38268
  cost: turns=$0.095598 + model_usage=$0.000825 (calls=1) = $0.096423
--- SaveEvalAgentSemantics.jsonl  agent=memory-proxy modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=7 wallS=78 input=68 out=4850 cacheRead=175178 cacheWrite=21860
  cost: turns=$0.069161 + model_usage=$0.000823 (calls=1) = $0.069984
--- SaveOmpPluginInterop.jsonl  agent=memory-proxy modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=4 wallS=59 input=36 out=4918 cacheRead=66808 cacheWrite=25468
  cost: turns=$0.063142 + model_usage=$0.000804 (calls=1) = $0.063946
--- SaveOmpTelemetry.jsonl  agent=memory-proxy modelRole=smol selector=anthropic/claude-haiku-4-5:auto lastModel=claude-haiku-4-5
  turns=7 wallS=84 input=60 out=5312 cacheRead=178769 cacheWrite=22105
  cost: turns=$0.072128 + model_usage=$0.000826 (calls=1) = $0.072954
```

Every field a fleet dashboard needs — member identity, dispatched agent type, model, tokens, real dollar cost (including the `model_usage` auxiliary spend §2 says a port must add on top of the turns), wall time — comes out of a single ~50-line script with zero external dependencies. The one field missing across all seventeen is a concrete effort/thinking level: every non-`task` agent here shows the literal string `auto`, which is the ceiling of what's recoverable for them (§3).

## Bonus finding: `@oh-my-pi/omp-stats` is a primary source in its own right

`npm ls -g` on this box resolves a whole separate first-party package, `@oh-my-pi/omp-stats`, shipped alongside `pi-coding-agent` and wired to the `omp stats` CLI subcommand (`cli-commands.ts:186`). It is exactly the kind of tool `board.mjs`/`member-outcomes.mjs` are: a plain script that reads the session JSONL tree off disk (`omp-stats/README.md`: "Session log parsing: Reads JSONL session logs from `~/.omp/agent/sessions/`") and aggregates it. Its `MessageStats` schema (`omp-stats/src/types.ts:9-38`) and `classifyAgentType`/`AgentType` (`main`/`subagent`/`advisor`, `omp-stats/src/parser.ts:42-50`) independently corroborate every field in the mapping table above, including the *absence* of an effort field.

More directly relevant still: `omp-stats` ships an unexported-but-fully-legible `trace.ts` module (`buildSessionTrace`, `buildTrackTree`) that already implements the exact recursive artifacts-dir walk this ticket needed to establish, producing a `TraceTrack` per subagent (with `agent`, `model`, and per-span `tokens`/`cost`) and a `TraceSummary` per session. It backs the `omp stats` web dashboard's "Traces" view (`/api/session/trace` in `omp-stats/src/server.ts:293`) but is not part of the package's public `export` surface (`omp-stats/src/index.ts` only re-exports the aggregator/gain/server functions, not `trace.ts`). A fleet port has three real options, in order of coupling: (1) mirror `trace.ts`'s walk in fleet's own scripts, as the worked example above does at much smaller scope; (2) hit `omp stats`'s local HTTP API (`GET /api/session/trace?file=...`) while that server happens to be running; (3) take on `@oh-my-pi/omp-stats` as a project dependency and import its non-exported internals directly from its package path (fragile — those exports are not part of its declared public API and could move). This research recommends noting the existence of `trace.ts` as the canonical reference implementation to diff against, without taking a position on which integration option to build — that decision is out of scope for this ticket per the assignment.
