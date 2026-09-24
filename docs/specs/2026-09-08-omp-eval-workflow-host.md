# Research: can omp's eval host `review-pr.js`, and at what fidelity?

Ticket: `feigi/fleet-plugin#1296`. Scope: `workflows/review-pr.js` (86.7 KB) against omp's `eval` tool. No port attempted, no recommendation made — primitive inventory and gap analysis only, for a separate decision ticket to act on.

## Method

Read `workflows/review-pr.js` in full (1468 lines): `meta` export, `FINDINGS_SCHEMA`, `VERDICT_SCHEMA`, every `agent()` call site (snapshot, review, verify/refute), every `phase()`/`log()` call, and the file's own comments naming the Claude Code Workflow sandbox's global surface (lines 405–410). Cross-referenced omp's `eval`/`task` docs (`omp://tools/eval.md`, `omp://tools/task.md`) against the npm-shipped source at `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/**` (the same tree the docs cite).

**Pinned to omp/18.3.0.** Every omp line number below is from `@oh-my-pi/pi-coding-agent` 18.3.0 (`omp --version` → `omp/18.3.0`; the package's `package.json` `version` agrees), re-verified against that install on 2026-09-24. Bare `src/…` paths are relative to that package root; `workflows/…`, `skills/…`, `commands/…`, `scripts/…` and `docs/…` paths are this repo. omp source moves between releases — the first draft's citations had drifted by 18.3.0, and one cited module (`src/tools/hub/messaging.ts`) no longer exists — so re-check against the pinned version before trusting a line number, and re-pin on upgrade.

Established at charting and not re-derived here: omp ships no workflow runtime (129 docs, none for `workflows/`); the candidate host is `eval`.

## 1. Primitive-by-primitive mapping table

| `review-pr.js` primitive (call sites) | omp eval counterpart | Verdict |
|---|---|---|
| `export const meta = { name, description, whenToUse, phases }` (`review-pr.js:1-12`) | *(none)* | **NO EQUIVALENT.** No workflow-file registry, no declarative phase list consumed by any harness component. `eval.md` describes cells, not files with metadata exports. |
| `phase("Snapshot")` (`review-pr.js:709` — the only literal `phase()` call; "Review" and "Verify" are named only through the host-defined `phase:` option on `agent()` calls, `review-pr.js:844,1330,1408`, which the `agent()` rows below cover) | `phase(title)` — eval prelude, `src/eval/js/shared/prelude.txt:518-521` | **Matches as narration only.** Both are fire-and-forget status emitters (`globalThis.__omp_emit_status__("phase", …)` on the omp side; it also sets `globalThis.__omp_phase__`, which nothing else in the installed package reads). omp's `phase()` is tied to no phase list, ordering enforcement, or resumability — see Q3. |
| `log(message)` (7 call sites, e.g. `review-pr.js:1039`) | `log(message)` — `prelude.txt:516` | **Matches.** Pure narration on both sides (`__omp_emit_status__("log", …)`). |
| `agent(prompt, { label, phase, model, schema })` — snapshot call (`review-pr.js:710-891`) | `agent(prompt, { label, schema })` — argument schema `src/eval/agent-bridge.ts:25-36`, JS wrapper `src/eval/js/shared/prelude.txt:434-448` | **Differs.** `phase` and `model` are not in eval's `agent()` schema and are silently discarded (see Q2). Return value is a handle, not the data (see Q2/Q3). |
| `agent(prompt, { label, phase, model, agentType, schema })` — review call, once per dimension (`review-pr.js:1299-1335`) | `agent(prompt, { label, agent, schema })` | **Differs**, same gaps as above, plus `agentType`'s literal values (`"pr-review-toolkit:code-reviewer"`, etc.) do not resolve under omp's agent lookup (see Q5). |
| `agent(prompt, { label, phase, effort, schema })` — verify/refute call, N per finding (`review-pr.js:1367-1409`) | `agent(prompt, { label, schema })` | **Differs.** `effort` has **no** per-call equivalent anywhere in eval's `agent()` — not just unsupported, absent from the bridge's option set entirely (see Q2/Q5). |
| `pipeline(items, stage1Fn, stage2Fn)` (`review-pr.js:1296-1420`, host-provided per the file's own comment at `review-pr.js:1194-1196`) | *(no named primitive)* — hand-rollable with `async`/`Promise` + `wait()` | **NO NAMED EQUIVALENT**, but the *behavior* (stage 2 starts the moment one item's stage 1 settles, not after every item's stage 1) is reproducible with plain per-item `async` closures run concurrently — see Q3. |
| `parallel(fns[])` (two nested sites: outer `review-pr.js:1348`, one fn per finding; inner `review-pr.js:1365`, one fn per refuter — host-provided) | *(no named primitive)* — native `Promise.all` (JS) / `asyncio.gather` (Python), or `wait([...handles])` for `agent()` fan-out specifically | **NO NAMED EQUIVALENT**, but trivially replicable — JS's `Promise.all` is a language feature, not a host primitive that needs replacing. |
| `pipeline()`/`parallel()` fan-out, checked against eval's one **named** fan-out primitive (#1296 lists `workpool()` as a candidate) | `workpool(agent?, { name, context, tools })` → `WorkPool` with `.push(...items)`, `.status()`, `.peek()`, `.close()` — `src/eval/js/shared/prelude.txt:450-514`; host bridge `src/eval/workpool-bridge.ts:66-126` (ops `create`/`push`/`status`/`peek`/`close`); pool in `src/task/workpool.ts` | **Does not substitute here.** A queueing pool of keep-alive workers of **one** agent type, capped by the live session-wide `task.maxConcurrency`; string items only, no per-item schema, and results auto-deliver to the owning agent's turn as rendered text instead of returning into the script (no `pool.wait()`). Assessed in full under Q3. |
| `Workflow({scriptPath, resumeFromRunId})` — referenced only in the string `resumeFor()` returns (`review-pr.js:1271-1279`), invoked by the **controller**, not by this script | *(none)* | **NO EQUIVALENT.** No cached-replay-by-run-id mechanism exists anywhere in `eval` or `task` — see Q5. |
| `Workflow({name: "fleet:review-pr", args: {...}})` — this file's own invocation contract (`commands/review-and-fix.md:37`, `skills/run-team/SKILL.md:1130-1133`) | *(none direct)* — closest is the controller itself running an `eval` cell, or dispatching a `task`/`agent()` subagent that runs one | **NO DIRECT EQUIVALENT.** There is no "named, registered script the controller invokes with a structured `args` object" concept in eval — see Q5/Q6. |
| Top-level `args` + `decodeArgs(args)` (`review-pr.js:345-361`) | *(none)* — an `eval` cell's params are `{language, code, title, timeout, reset}` only | **NO EQUIVALENT.** Parameters must be interpolated into the `code` string itself, or staged through `read()`/`local://` files — see Q5. |
| Sandbox globals enumerated but **unused** by this file (`review-pr.js:406-407`): `console`, `setTimeout`, `clearTimeout`, `budget`, `workflow` | `console`/`setTimeout`/`clearTimeout` are ordinary Bun globals in eval's `js` backend (`eval.md` "Runtime behavior › JavaScript"); `budget` is a present-but-different eval prelude object (async `budget.total()`, `.spent()`, `.remaining()`, `.hard()` — `src/eval/js/shared/prelude.txt:528-539`); `workflow()` has no analog | **Mixed** — three exist as ordinary language/runtime features, one exists in different shape, one is absent entirely. None of these five are actually load-bearing for `review-pr.js`, so this row is informational, not a gap that blocks anything. |
| `Math.random`/`Date.now`/argless `new Date()` overridden to **throw** in the Claude Code Workflow sandbox (per this file's own measurement, `review-pr.js:396-398`, quoting the harness's `RANDOM_ERR`/`NOW_ERR` messages) | Unrestricted in eval's Bun VM — no such override is documented anywhere in `eval.md`, `agent-bridge.ts`, or `prelude.txt` | Not a primitive `review-pr.js` calls, but the **premise** several of its design comments defend against (why `scratch`'s per-run segment must be minted by the dispatched shell, not the script) does not hold under eval — see Q6. |

## 2. Does `agent()` accept a per-call schema and return parsed, validated data?

**Yes to per-call schema, yes to validated parsed data — but only after an explicit `.wait()`, and with materially different retry/exhaustion behavior than what `review-pr.js`'s own comments describe for Claude Code.**

**Schema is accepted per call and really validated**, against real JSON Schema, at the child's own `yield` tool-call boundary — not re-parsed by the parent:

```ts
// src/tools/yield.ts:238
const MAX_SCHEMA_RETRIES = 3;
```
```ts
// src/tools/yield.ts:543-560
if (sectionFailure && !sectionFailure.success) {
  this.#schemaValidationFailures++;
  if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
    const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
    const retryHint =
      remaining > 0
        ? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
        : " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
    …
    throw new Error(`${scope} does not match schema: ${formatAllValidationIssues(sectionFailure.issues)}.${retryHint}`);
  }
  …
  schemaValidationOverridden = true;
```

This is the same *shape* of behavior `review-pr.js`'s own `FINDINGS_SCHEMA` comment describes for Claude Code (`review-pr.js:36-41`, "85 transcripts carried `Output does not match required schema`, 184 rejection events … every one recovered by retry"): a schema violation is rejected back to the model as a tool error and retried, not silently coerced.

**Where it differs from what `review-pr.js` assumes:**

1. **Exhaustion is *not* the same as Claude Code's "`agent()` returns null."** `review-pr.js:50-52` documents: *"Exhaustion emits `Failed to provide valid structured output after <n> attempts` and `agent()` then returns null."* Under omp, exhausting `MAX_SCHEMA_RETRIES` sets `schemaOverridden = true` and — in the default `permissive` schema mode — the run is **accepted anyway** (`exitCode = 0`) carrying the invalid data, not rejected to null:
   ```ts
   // src/task/executor.ts:661-662
   export const SUBAGENT_WARNING_SCHEMA_OVERRIDDEN =
     "SYSTEM WARNING: Subagent exhausted schema-retry budget; result was accepted despite failing the output schema.";
   ```
   ```ts
   // src/task/executor.ts:761-762
   const mustReject =
     failure !== undefined && (mode === "strict" || (!assembled.schemaOverridden && !schemaError));
   ```
   Only `schemaMode: "strict"` makes an exhausted retry a hard failure (nonzero exit → `agent().wait()` throws or, with `wait(..., {raiseErrors:false})`, returns an `Error` in that slot — never `null`). `review-pr.js`'s downstream guards (`if (snap) {…}`, `if (!snap || …)`) are written for a null-on-exhaustion contract that omp's default mode does not provide, and omp's strict mode throws rather than nulls.

2. **The parsed value is not the value `await agent(...)` returns.** `agent()` registers a background job and hands back a handle immediately:
   ```ts
   // src/eval/agent-bridge.ts:168 (doc comment)
   /** Register a background subagent and return its handle immediately. */
   ```
   ```js
   // src/eval/js/shared/prelude.txt:434-448
   const agent = (prompt, opts, ...rest) => {
     const promise = (async () => {
       …
       const result = await globalThis.__omp_call_tool__("__agent__", { prompt, ...options });
       if (!result || typeof result.id !== "string") throw new Error("agent() did not return a handle");
       return new AgentHandle(result.id, result.agent, options.schema);
     })();
     return new PendingHandle(promise);
   };
   ```
   In 18.3.0 the call returns a thenable `PendingHandle` synchronously; `await` resolves it to the `AgentHandle` itself, never to the subagent's data (`src/eval/js/shared/prelude.txt:187-193`: *"`await` it to get the resolved handle (for dag wiring via `.id`/`.handle`), or call the handle methods directly (`h.wait()`, `h.status()`, …)"*).
   Parsed data only appears once you call `.wait()` on that handle (or pass it to top-level `wait()`), which is where the actual `structuredOutput.data` gets unwrapped:
   ```js
   // src/eval/js/shared/prelude.txt:242-247
   const value = hasOwn(snapshot ?? {}, "data")
     ? snapshot.data
     : handle._schema !== undefined
       ? JSON.parse(snapshot?.text ?? "")
       : (snapshot?.text ?? "");
   handle._result = value;
   ```
   A verbatim port of `const snap = await agent(...)` would bind `snap` to a *handle* (with `.id`, `.agent`, `.handle`, `.send()`, `.output()`) — `snap.path`, `snap.head`, `snap.pathVerified` etc. would all be `undefined` until an extra `await snap.wait()` is inserted. So: validation happens host-side (not userland), but the *unwrapping* step that Claude Code's `agent()` performs implicitly is a second, explicit call in eval.

3. **Extra options are silently dropped, not rejected.** eval's `agent()` argument schema is:
   ```ts
   // src/eval/agent-bridge.ts:25-36
   const agentArgsSchema = type({
     prompt: "string>0",
     "agent?": "string>0",
     "label?": "string",
     "schema?": "unknown",
     "schemaMode?": "'permissive' | 'strict'",
     "isolated?": "boolean",
     "apply?": "boolean",
     "merge?": "boolean",
     "tools?": "string[]",
     "+": "delete",
   });
   ```
   `"+": "delete"` means unknown keys — `phase`, `model`, `effort` — are stripped, not flagged. A literal port of `review-pr.js`'s `agent(prompt, {label, phase, model, schema})` calls would not throw; it would silently run every dimension on whatever model the target agent's frontmatter pins, ignoring `snapshotModel`/`specialistModel`/`verifierEffort` entirely, with no error surfaced anywhere — precisely the "silent green" failure mode this file is otherwise obsessive about guarding against.

## 3. Does the phase structure have a counterpart, or must it become explicit `wait()` barriers?

**`meta.phases` itself has no counterpart** (Q1). `phase()`/`log()` calls transfer 1:1 as narration (`prelude.txt:516-521`), but they are cosmetic on both sides — they never gated ordering or dependency in Claude Code's Workflow sandbox either; `pipeline()`/`parallel()` did that.

**`pipeline()` and `parallel()` must become explicit code, and in eval specifically, explicit `wait()`/handle-plumbing — not just a `Promise.all` swap:**

- `parallel(fns[])` is describable as `Promise.all(fns.map(fn => fn()))` at the language level. `review-pr.js` nests it two levels deep inside the verify stage: the outer `parallel()` (`review-pr.js:1348`) runs one fn per finding, and each of those fns returns either an already-settled `Promise.resolve(...)` (the 0-verifier `suggestion` band, `review-pr.js:1364`) or an inner `parallel()` (`review-pr.js:1365`) whose fns each dispatch one refuter `agent()` call (`review-pr.js:1366-1409`). Only the inner level's fns touch `agent()`, and in eval each such call's *value* only becomes available after `.wait()`. So the eval equivalent of the inner `parallel(Array.from({ length: n }, () => () => agent(...)))` is: dispatch every `agent()` call (each returns a handle immediately — dispatch itself is non-blocking, matching `parallel()`'s concurrency intent), collect the handles into an array, then `await wait(handles)` as one barrier per finding; the outer level stays a plain `Promise.all` over those per-finding promises. That barrier is new code, not present in the Claude Code version, because Claude Code's `agent()` was already the blocking primitive `parallel()` fanned out over.

- `pipeline(items, stage1, stage2)`'s documented behavior (`review-pr.js:1282-1284`, *"a dimension's findings start verifying the moment that dimension finishes, rather than waiting for the slowest reviewer"*) plus its null short-circuit (`review-pr.js:1194-1196`, *"the harness runs `if (result === null) break` before handing a dimension to the next stage"*) is reproducible with an ordinary per-item `async` closure — `dimensions.map(async d => { const h = await agent(reviewPrompt(d)); const review = await h.wait().catch(() => null); if (!review) return null; return runVerifyStage(review, d); })` run under one `Promise.all` — but two things are lost or must be re-implemented by hand:

  1. **Ordering/failure isolation**: Claude Code's `pipeline()` gives this per-item independence for free, including the null-short-circuit; in eval the null-check has to be written explicitly at each stage boundary, and a thrown `ToolError` from `agent()`'s failure path (Q2) must also be caught explicitly — `pipeline()`'s host-level "map failures to the same null slot (#527)" behavior (`review-pr.js:1205`) has no counterpart, so `review-pr.js`'s `unrunCrashed()` logic (which relies on a `null` slot per crashed dimension) needs a `try/catch → null` wrapper around every stage that isn't required today.
  2. **Partial results across a whole run**: Claude Code's resumability (`Workflow({resumeFromRunId})`, Q5) means a `pipeline()`/`parallel()` fan-out that partially crashes can be *relaunched* and only the dead legs re-run, replaying the live legs from cache. Nothing in `eval`/`task` replays completed `agent()` calls on a fresh script execution — each `eval` cell/script run is a clean dispatch. A `wait()`-based reproduction of `pipeline()`/`parallel()` gets you the *concurrency shape* but not the *resumability* Claude Code's version rode on top of it for free.

**`workpool()` — eval's only named fan-out primitive — does not close the gap.** #1296 lists it as a candidate, and it is the one eval surface that queues past a concurrency ceiling, so it is the natural thing to try for `parallel()`/`pipeline()`. Read against the 18.3.0 source, it fits neither:

- **Concurrency limit — the one thing it does that bare `agent()` does not.** A pool's worker ceiling is the live, session-wide `task.maxConcurrency` (default 32, `0` = unbounded; `src/task/workpool.ts:142-146`, `src/config/settings-schema.ts:5127-5129`); an item past the ceiling queues onto an existing worker instead of failing (`src/task/workpool.ts:256-287`). Bare `agent()` has no such bound: each call registers its job directly with the session's async job manager (`src/eval/agent-bridge.ts:204-248`) — the `task.maxConcurrency` semaphore lives in the `task` tool (`src/task/index.ts:627-634`), not on this path — so an `agent()` fan-out's only ceiling is `async.maxJobs` (default 100, `src/config/settings-schema.ts:4745-4748`), at which `register()` **throws** `Background job limit reached` instead of queueing (`src/async/job-manager.ts:332-336`). Whether `review-pr.js`'s widest fan-out ever approaches that cap was not measured here. The pool ceiling is not per-pool either: `workpool()` takes no `limit` option (`prelude.txt:500-506` accepts `name`/`context`/`tools` only).
- **Results never come back into the script.** `.push()` returns item *ids* only (`prelude.txt:457-467`); there is no `pool.wait()` (`omp://tools/eval.md`, § `workpool()`), and top-level `wait()` rejects anything that is not an `agent()`/`completion()` handle (`prelude.txt:256`). The pool's aggregate result auto-delivers **once**, after its first full drain, to the owning agent's turn as rendered markdown with each batch's output inlined as text (`src/task/workpool.ts:501-516`), and a per-turn delivery is truncated at 6,000 characters (`src/task/workpool.ts:101,518-524`). `verdictFor(n, votes)` and `unrunCrashed()` need the votes and reviews as values inside the script; the only in-script read path is polling `.peek()` for batch `output` strings, which the tool contract forbids (*"NEVER poll"*, `src/prompts/tools/eval-agents.md:6`).
- **No per-item schema.** Items are strings (`prelude.txt:458-460`); the worker's yield contract is a pool-built strict schema whose per-item value is `{}` — any shape (`src/task/workpool-yield.ts:8-15`, applied at `src/task/workpool.ts:357,385-386`). `workpool()` accepts no `schema` option, so `FINDINGS_SCHEMA`/`VERDICT_SCHEMA` would become prompt text rather than host-enforced — reversing Q2's "yes".
- **One agent type per pool.** The agent is resolved once, at `create` (`src/eval/workpool-bridge.ts:79-84`). The review stage's six dimensions each name a different `agentType`, so that stage would need six single-item pools — no pooling at all. Only the verify stage, where every refuter uses the same default agent, fits one pool.
- **Keep-alive workers undercut refuter independence.** A pushed item goes to the least-loaded *idle* worker, or queues onto a busy worker and is handed over with its other queued items as one batch turn (`src/task/workpool.ts:256-287`; `omp://tools/eval.md`, § `workpool()`). Two refuter votes on one finding — or refuters for different findings — can therefore run in one worker's accumulated context, which undercuts the *n independent adversarial votes* `verifiersFor`/`verdictFor` count on. `eval.workpool.freshAgents=true` restores a fresh context per item, but it is a session setting read at pool creation (`src/task/workpool.ts:133`), not a per-pool option.
- **First drain closes the pool — hostile to `pipeline()`.** The pool job waits for its queue to drain, then sets `closed = true` (`src/task/workpool.ts:181,191`); a later `.push()` throws `workpool <name> is closed` (`src/task/workpool.ts:150`). `pipeline()`'s point is to push a dimension's verify work the moment that dimension's review settles; with one shared verify pool, the first dimension's refuters can drain it before the second dimension's review finishes, and the second push then fails. The docs' own remedy — *"create a new named pool for another phase"* (`omp://tools/eval.md`, § `workpool()`) — is a phase barrier, the opposite of `pipeline()`'s no-barrier contract (`review-pr.js:1282-1284`).

Net: `workpool()` supplies the bounded, queueing half of fan-out that bare `agent()` lacks, and nothing else `review-pr.js` needs from `parallel()`/`pipeline()` — it is built for results that flow to the controller's turn, not back into a script. The per-item `async` closure + `agent()` + `wait()` reproduction above remains the closer fit.

## 4. How does `SendMessage` map onto `hub`?

**`review-pr.js` itself calls `SendMessage` zero times.** Its own top-of-file rationale (`review-pr.js:14-26`) states this is deliberate: *"agent() returns INTO THIS SCRIPT. There is no delivery path to lose"* — the whole design displaces the hand-dispatch fleet's `SendMessage`-based reporting (documented in `skills/run-team/SKILL.md`, `docs/specs/2026-07-22-run-team-agent-fleet-design.md`, `skills/run-team/references/member-lifecycle.md`) with direct return values. So there is nothing in this file to map. For completeness, since the general pattern is what `review-pr.js` was built to avoid, here is how the surrounding fleet's `SendMessage` usage compares to omp's peer messaging.

**omp 18.3.0 has no `hub` tool.** The name survives only as the `/hub` slash command that opens the live Agent Hub UI (`src/slash-commands/builtin-session.ts:521-523`). Peer messaging is `write agent://<id>` (broadcast: `agent://all`), handled by `src/internal-urls/agent-protocol.ts:60-88`, which calls `executeSend` (`src/irc/messaging.ts:43-100`) on the process-global `IrcBus` (`src/irc/bus.ts`); replies are observed with the zero-argument `wait` tool (`src/tools/wait.ts`). The right-hand column describes that surface.

| Property | `SendMessage` (Claude Code fleet docs) | omp 18.3.0 peer messaging (`write agent://<id>` → `src/irc/`) |
|---|---|---|
| Default delivery mode | Push-style report: *"A report is a `SendMessage`, not the end of a turn… The controller does not acknowledge reports"* (`skills/run-team/SKILL.md:21-37`) — effectively fire-and-forget from the sender's perspective | Fire-and-forget: *"Send a direct message or broadcast; delivery never waits for a reply."* (`src/irc/messaging.ts:42`). The bus's receipt *"reports how the message reached the recipient (waiter/aside = "injected", idle wake = "woken", park revival = "revived"), not what they did with it"* (`src/irc/bus.ts:56-60`). Replies are real turns by the recipient, observed with `wait` (`src/prompts/tools/wait.md:2`) |
| Blocking variant | Not documented as a first-class option; controller polls/relays instead | None on the send path — `write agent://<id>` takes a path and content only, with no `await`-style option. The sender blocks by calling the parameterless `wait` tool (`src/tools/wait.ts:21`), which returns on the first background result **or any** peer message, not specifically the recipient's reply (`src/tools/wait.ts:66-72,159-165`) |
| Steering (interrupting a running peer mid-task) | Not documented | Present, non-interrupting: a busy recipient gets the message *"as a non-interrupting aside at the next step boundary"* (`src/irc/bus.ts:7-9`). eval cells specifically back off when `eval.autoBackground.enabled` is on (default `false`) — *"A queued user/peer message (steer) arriving mid-wait backgrounds the cell immediately"* (`omp://tools/eval.md`, "Auto-backgrounding") |
| Reviving a parked/idle recipient | Explicitly does **not** work for a dead member: *"`SendMessage` does nothing for dead… A killed member cannot be resumed"* (`docs/specs/2026-07-22-run-team-agent-fleet-design.md:161-166`, `skills/run-team/references/member-lifecycle.md:33`); it *does* resume an idle/truncated one, but *"resumes its transcript, carrying the previous ticket's context into the next one"* — a hazard the docs warn against reusing for new work | Parked recipients are revived on direct send: *"parked agents are revived through the AgentLifecycleManager, idle agents are woken with a real turn"* (`src/irc/bus.ts:5-7`, revival gate `:130-153`); `executeSend` first restores the parked roster (`src/irc/messaging.ts:56-60`) and reports `Queued for <id> (was parked; revived).` (`src/irc/messaging.ts:91-92`). A hard-aborted recipient still fails delivery — receipt `outcome: "failed"`, *"was hard-aborted and cannot be messaged or revived"* (`src/irc/bus.ts:106-111`) |
| Reaching a message's own spawner, not just the top-level controller ("grandchild routing") | Explicitly broken: *"Specialist's report routes to *you*, controller… Reviewer has no *messaging* channel to a grandchild — `SendMessage` to one returns `had no active task; resumed from transcript` without report"* (`skills/run-team/references/member-lifecycle.md:19-25`) — this is the exact failure `review-pr.js` was written to route around | omp's agent registry is process-global (`src/registry/agent-registry.ts`, cited in `omp://tools/task.md` source list). Refs carry `parentId` (`src/registry/agent-registry.ts:74`), but visibility is not scoped by it — `listVisibleTo` returns every running/idle non-advisor agent (`src/registry/agent-registry.ts:335-339`) and a direct send resolves its recipient by id alone (`src/irc/bus.ts:97-105`) — consistent with any live/idle/parked agent being independently addressable by id. This is an architectural difference worth flagging, not independently re-measured here for the deep-nesting case. |

The practical upshot for a port: `review-pr.js`'s decision to route findings through `agent()` return values instead of `SendMessage` isn't undermined by anything in omp's messaging — if anything, its flatter, process-global addressing looks like it would have made the original grandchild-routing failure *less* likely, though that specific claim about deep nesting is inference from the registry's documented shape, not a reproduced measurement.

## 5. What has no counterpart at all?

In priority order for whoever picks this up next:

1. **Run-level resumability with cached `agent()` replay.** `Workflow({scriptPath, resumeFromRunId})` — cited only in the string `resumeFor()` builds (`review-pr.js:1271-1279`) and pinned by `scripts/review-pr-unverified-discriminant.test.mjs:130-144` — lets the controller relaunch a partially-crashed run and *"the unchanged prefix of `agent()` calls replays from cache and only the calls that died run live."* Nothing in `eval` or `task` memoizes subagent dispatch by run id across separate tool invocations. This is the single biggest behavioral loss: every one of `review-pr.js`'s "a crashed dimension is resumable, not a reason to defer" guarantees (`review-pr.js:1258-1259`) depends on it.

2. **A named, invokable workflow file with a structured `args` contract.** `Workflow({name: "fleet:review-pr", args: {pr, branch, worktree, testCmd, scratch}})` (`commands/review-and-fix.md:37`, `skills/run-team/SKILL.md:1130-1133`) is how the controller runs this file at all, and it's restricted to the controller (*"Only you can run it — members have no `Workflow` tool"*, `SKILL.md:1132`). `eval` has no file-registry, no name-based invocation, and no invocation-time parameter object — a cell is `{language, code, title, timeout, reset}` and nothing else. Porting `review-pr.js`'s `args`/`decodeArgs` contract means either interpolating caller values into a `code` string per invocation, or staging them through `read()`/`local://` files; both are qualitatively different from passing a JSON `args` object to a named script.

3. **Per-call `model` and `effort` overrides on subagent dispatch.** `review-pr.js` exposes `A.snapshotModel`, `A.specialistModel`, `A.verifierEffort`, and per-dimension `d.model` as first-class caller-tunable knobs, each threaded into an `agent()` call's `model`/`effort` option. eval's `agent()` schema has no `model` or `effort` field at all (Q2) — *"the selected agent's frontmatter model and settings always apply (no per-call `model`)"* (`omp://tools/eval.md`, § `agent()`). The only lever is `task.agentModelOverrides`, a **session-wide** setting (`omp://tools/task.md`, § Flow step 7), not a per-call, per-dispatch argument — so a script cannot vary the model per dimension or per run the way `DEFAULT_DIMENSIONS` and the `A.*Model` args do today.

4. **Exact-string, namespaced agent-type resolution.** All six `DEFAULT_DIMENSIONS` entries name their specialist with the Claude Code Task-tool convention `"<plugin>:<agent-file-name>"` — e.g. `agentType: "pr-review-toolkit:code-reviewer"` (`review-pr.js:154`). omp's agent lookup is an **exact match on the bare frontmatter `name:` field** (`src/task/discovery.ts:176-178`: `agents.find(a => a.name === name)`), with no colon-splitting anywhere in the resolution path:
   ```ts
   // src/task/structured-subagent.ts:275-281
   const discovery = await discoverAgents(request.session.cwd, undefined, request.session.effectiveExtensionRoots?.());
   const agents = [...discovery.agents, ...(request.session.getSessionAgents?.() ?? [])];
   const agent = getAgent(agents, agentName);
   if (!agent) {
     const available = agents.map(candidate => candidate.name).join(", ") || "none";
     throw new StructuredSubagentError("preflight", `Unknown agent "${agentName}". Available: ${available}`);
   }
   ```
   The `pr-review-toolkit` plugin's own frontmatter is bare: `name: code-reviewer` (`~/.claude/plugins/cache/claude-plugins-official/pr-review-toolkit/6bfd4e0c6d3d/agents/code-reviewer.md:2`, the install path `~/.claude/plugins/installed_plugins.json` records on 2026-09-24; the cache hash changes on plugin update). Passing the literal string `"pr-review-toolkit:code-reviewer"` as `agent()`'s `agent` option would fail this exact preflight check outright. Worse, the bare name `"code-reviewer"` is **not unique** across installed marketplace plugins on this machine — `feature-dev` also ships a `code-reviewer.md` with the same `name: code-reviewer` (`~/.claude/plugins/cache/claude-plugins-official/feature-dev/6bfd4e0c6d3d/agents/code-reviewer.md:2`) — and omp's discovery dedupes by first-seen name with no per-plugin disambiguation (`src/task/discovery.ts:155-160`), so even a corrected bare-name call risks silently resolving to the wrong plugin's agent depending on discovery order, not the one `review-pr.js` intends.

5. **The `mktemp`-based per-run token argument for its own safety property.** Not a primitive gap so much as a premise gap: `review-pr.js:389-410` derives its whole "the shell mints the per-run directory segment, never the script" design from a measured Claude Code Workflow sandbox restriction (`Math.random`/`Date.now`/argless `new Date()` throw — *"unavailable in workflow scripts (breaks resume)"*). No such restriction is documented anywhere for eval's Bun VM. This doesn't cost anything by itself, but the code and the 52-line comment block defending it (`review-pr.js:378-429`) exist entirely because of a Claude-Code-specific constraint that would not apply verbatim in eval — see Q6.

## 6. Could a Claude Code workflow and an omp eval script share one implementation file?

Not verbatim, and not as a thin dispatcher either — feasibility only, no recommendation:

- **The file's contract is Claude-Code-shaped end to end**, not incidentally. `export const meta` (Q1/Q5 #2), the sandboxed global surface (`console`/`budget`/`agent`/`parallel`/`pipeline`/`workflow`/`args`, `review-pr.js:406-407`), the implicit top-level `await` with no `import` (`review-pr.js:229-230`, `912-916`), and the `Math.random`/`Date.now` throw (Q5 #5) are all Claude Code Workflow-sandbox specifics with no eval analog. An eval `js` cell is a Bun worker VM with normal `import`, normal `Date.now`, normal `Promise`, and no `meta`/`phase`-list contract to satisfy (`omp://tools/eval.md`, § Runtime behavior › JavaScript).
- **The primitives that *do* transfer** (`log`, `phase`, a per-call JSON-Schema-validated `agent()`) transfer with different call shapes and different failure semantics (Q2, Q3) — a shim would need to paper over "handle vs. value," "null-on-exhaustion vs. accept-with-warning," and "silently-dropped `model`/`effort`/`phase` options" (Q2) to keep the *same source text* behaviorally equivalent under both hosts.
- **The primitives that don't transfer at all** (`pipeline`, `parallel`, `Workflow({resumeFromRunId})`, per-call `model`/`effort`, namespaced `agentType`) are not cosmetic — `pipeline`/`parallel`'s concurrency shape is reproducible (Q3), but the *resumability* the whole design leans on for crash recovery (`resumeFor`, Q5 #1) has no eval-side substitute at all, host primitive or otherwise.
- A shim library (a thin `pipeline()`/`parallel()`/`phase()` polyfill loaded into both hosts) could plausibly cover the concurrency-shape gaps. It could not by itself restore run-level `agent()`-call caching, restore a controller-facing `Workflow({name, args})` invocation contract, or resolve `pr-review-toolkit:code-reviewer`-style plugin-qualified agent names — those are host capabilities, not call-shape differences, and no amount of userland wrapping inside the shared file changes what the underlying host does or doesn't persist across a relaunch.

Net: the host shims necessarily diverge on at least the resumability and agent-resolution axes; how much of the rest could be unified behind a shim is a design question for the follow-up ticket, not settled by this research.
