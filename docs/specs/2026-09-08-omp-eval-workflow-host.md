# Research: can omp's eval host `review-pr.js`, and at what fidelity?

Ticket: `feigi/fleet-plugin#1296`. Scope: `workflows/review-pr.js` (86.7 KB) against omp's `eval` tool. No port attempted, no recommendation made — primitive inventory and gap analysis only, for a separate decision ticket to act on.

## Method

Read `workflows/review-pr.js` in full (1468 lines): `meta` export, `FINDINGS_SCHEMA`, `VERDICT_SCHEMA`, every `agent()` call site (snapshot, review, verify/refute), every `phase()`/`log()` call, and the file's own comments naming the Claude Code Workflow sandbox's global surface (lines 405–410). Cross-referenced omp's `eval`/`task` docs (`omp://tools/eval.md`, `omp://tools/task.md`) against the npm-shipped source at `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/**` (the same tree the docs cite). All line numbers below are from that installed package unless stated otherwise.

Established at charting and not re-derived here: omp ships no workflow runtime (129 docs, none for `workflows/`); the candidate host is `eval`.

## 1. Primitive-by-primitive mapping table

| `review-pr.js` primitive (call sites) | omp eval counterpart | Verdict |
|---|---|---|
| `export const meta = { name, description, whenToUse, phases }` (`review-pr.js:1-12`) | *(none)* | **NO EQUIVALENT.** No workflow-file registry, no declarative phase list consumed by any harness component. `eval.md` describes cells, not files with metadata exports. |
| `phase("Snapshot")` (`review-pr.js:709`, called 3× total across the run) | `phase(title)` — eval prelude, `src/eval/js/shared/prelude.txt:332-334` | **Matches as narration only.** Both are fire-and-forget status emitters (`globalThis.__omp_emit_status__("phase", …)` on the omp side). Neither omp `phase()` call is tied to `meta.phases`, ordering enforcement, or resumability — see Q3. |
| `log(message)` (7 call sites, e.g. `review-pr.js:1039`) | `log(message)` — `prelude.txt:330` | **Matches.** Pure narration on both sides (`__omp_emit_status__("log", …)`). |
| `agent(prompt, { label, phase, model, schema })` — snapshot call (`review-pr.js:710-891`) | `agent(prompt, { label, schema })` — `src/eval/agent-bridge.ts:28-39,251-261` | **Differs.** `phase` and `model` are not in eval's `agent()` schema and are silently discarded (see Q2). Return value is a handle, not the data (see Q2/Q3). |
| `agent(prompt, { label, phase, model, agentType, schema })` — review call, once per dimension (`review-pr.js:1299-1335`) | `agent(prompt, { label, agent, schema })` | **Differs**, same gaps as above, plus `agentType`'s literal values (`"pr-review-toolkit:code-reviewer"`, etc.) do not resolve under omp's agent lookup (see Q5). |
| `agent(prompt, { label, phase, effort, schema })` — verify/refute call, N per finding (`review-pr.js:1367-1409`) | `agent(prompt, { label, schema })` | **Differs.** `effort` has **no** per-call equivalent anywhere in eval's `agent()` — not just unsupported, absent from the bridge's option set entirely (see Q2/Q5). |
| `pipeline(items, stage1Fn, stage2Fn)` (`review-pr.js:1296-1420`, host-provided per the file's own comment at `review-pr.js:1194-1196`) | *(no named primitive)* — hand-rollable with `async`/`Promise` + `wait()` | **NO NAMED EQUIVALENT**, but the *behavior* (stage 2 starts the moment one item's stage 1 settles, not after every item's stage 1) is reproducible with plain per-item `async` closures run concurrently — see Q3. |
| `parallel(fns[])` (`review-pr.js:1348,1365-1366`, host-provided) | *(no named primitive)* — native `Promise.all` (JS) / `asyncio.gather` (Python), or `wait([...handles])` for `agent()` fan-out specifically | **NO NAMED EQUIVALENT**, but trivially replicable — JS's `Promise.all` is a language feature, not a host primitive that needs replacing. |
| `Workflow({scriptPath, resumeFromRunId})` — referenced only in the string `resumeFor()` returns (`review-pr.js:1271-1279`), invoked by the **controller**, not by this script | *(none)* | **NO EQUIVALENT.** No cached-replay-by-run-id mechanism exists anywhere in `eval` or `task` — see Q5. |
| `Workflow({name: "fleet:review-pr", args: {...}})` — this file's own invocation contract (`commands/review-and-fix.md:37`, `skills/run-team/SKILL.md:1130-1133`) | *(none direct)* — closest is the controller itself running an `eval` cell, or dispatching a `task`/`agent()` subagent that runs one | **NO DIRECT EQUIVALENT.** There is no "named, registered script the controller invokes with a structured `args` object" concept in eval — see Q5/Q6. |
| Top-level `args` + `decodeArgs(args)` (`review-pr.js:345-361`) | *(none)* — an `eval` cell's params are `{language, code, title, timeout, reset}` only | **NO EQUIVALENT.** Parameters must be interpolated into the `code` string itself, or staged through `read()`/`local://` files — see Q5. |
| Sandbox globals enumerated but **unused** by this file (`review-pr.js:406-407`): `console`, `setTimeout`, `clearTimeout`, `budget`, `workflow` | `console`/`setTimeout`/`clearTimeout` are ordinary Bun globals in eval's `js` backend (`eval.md` "Runtime behavior › JavaScript"); `budget` is a present-but-different eval prelude object (`budget.total`, `.spent()`, `.remaining()`); `workflow()` has no analog | **Mixed** — three exist as ordinary language/runtime features, one exists in different shape, one is absent entirely. None of these five are actually load-bearing for `review-pr.js`, so this row is informational, not a gap that blocks anything. |
| `Math.random`/`Date.now`/argless `new Date()` overridden to **throw** in the Claude Code Workflow sandbox (per this file's own measurement, `review-pr.js:396-398`, quoting the harness's `RANDOM_ERR`/`NOW_ERR` messages) | Unrestricted in eval's Bun VM — no such override is documented anywhere in `eval.md`, `agent-bridge.ts`, or `prelude.txt` | Not a primitive `review-pr.js` calls, but the **premise** several of its design comments defend against (why `scratch`'s per-run segment must be minted by the dispatched shell, not the script) does not hold under eval — see Q6. |

## 2. Does `agent()` accept a per-call schema and return parsed, validated data?

**Yes to per-call schema, yes to validated parsed data — but only after an explicit `.wait()`, and with materially different retry/exhaustion behavior than what `review-pr.js`'s own comments describe for Claude Code.**

**Schema is accepted per call and really validated**, against real JSON Schema, at the child's own `yield` tool-call boundary — not re-parsed by the parent:

```ts
// src/tools/yield.ts:236
const MAX_SCHEMA_RETRIES = 3;
```
```ts
// src/tools/yield.ts:483-489
this.#schemaValidationFailures++;
if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
  const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
  const retryHint = remaining > 0
    ? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
    : " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
  …
  throw new Error(`${scope} does not match schema: ${formatAllValidationIssues(sectionFailure.issues)}.${retryHint}`);
}
schemaValidationOverridden = true;
```

This is the same *shape* of behavior `review-pr.js`'s own `FINDINGS_SCHEMA` comment describes for Claude Code (`review-pr.js:36-41`, "85 transcripts carried `Output does not match required schema`, 184 rejection events … every one recovered by retry"): a schema violation is rejected back to the model as a tool error and retried, not silently coerced.

**Where it differs from what `review-pr.js` assumes:**

1. **Exhaustion is *not* the same as Claude Code's "`agent()` returns null."** `review-pr.js:50-52` documents: *"Exhaustion emits `Failed to provide valid structured output after <n> attempts` and `agent()` then returns null."* Under omp, exhausting `MAX_SCHEMA_RETRIES` sets `schemaOverridden = true` and — in the default `permissive` schema mode — the run is **accepted anyway** (`exitCode = 0`) carrying the invalid data, not rejected to null:
   ```ts
   // src/task/executor.ts:635-636
   export const SUBAGENT_WARNING_SCHEMA_OVERRIDDEN =
     "SYSTEM WARNING: Subagent exhausted schema-retry budget; result was accepted despite failing the output schema.";
   ```
   ```ts
   // src/task/executor.ts:735-736
   const mustReject =
     failure !== undefined && (mode === "strict" || (!assembled.schemaOverridden && !schemaError));
   ```
   Only `schemaMode: "strict"` makes an exhausted retry a hard failure (nonzero exit → `agent().wait()` throws or, with `wait(..., {raiseErrors:false})`, returns an `Error` in that slot — never `null`). `review-pr.js`'s downstream guards (`if (snap) {…}`, `if (!snap || …)`) are written for a null-on-exhaustion contract that omp's default mode does not provide, and omp's strict mode throws rather than nulls.

2. **The parsed value is not the value `await agent(...)` returns.** `agent()` registers a background job and hands back an `AgentHandle` immediately:
   ```ts
   // src/eval/agent-bridge.ts:166 (doc comment)
   /** Register a background subagent and return its handle immediately. */
   ```
   ```js
   // src/eval/js/shared/prelude.txt:251-261
   const agent = async (prompt, opts, ...rest) => {
     …
     const result = await globalThis.__omp_call_tool__("__agent__", { prompt, ...options });
     if (!result || typeof result.id !== "string") throw new Error("agent() did not return a handle");
     return new AgentHandle(result.id, result.agent, options.schema);
   };
   ```
   Parsed data only appears once you call `.wait()` on that handle (or pass it to top-level `wait()`), which is where the actual `structuredOutput.data` gets unwrapped:
   ```js
   // src/eval/js/shared/prelude.txt:194-200
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
   // src/eval/agent-bridge.ts:28-39
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

**`meta.phases` itself has no counterpart** (Q1). `phase()`/`log()` calls transfer 1:1 as narration (`prelude.txt:330-334`), but they are cosmetic on both sides — they never gated ordering or dependency in Claude Code's Workflow sandbox either; `pipeline()`/`parallel()` did that.

**`pipeline()` and `parallel()` must become explicit code, and in eval specifically, explicit `wait()`/handle-plumbing — not just a `Promise.all` swap:**

- `parallel(fns[])` is describable as `Promise.all(fns.map(fn => fn()))` at the language level. But every `fn` in `review-pr.js`'s two `parallel()` sites (`review-pr.js:1357,1366`) dispatches an `agent()` call whose *value* only becomes available after `.wait()`. So the eval equivalent of `parallel(findings.map(f => () => agent(...)))` is: dispatch every `agent()` call (each resolves almost immediately to a handle — dispatch itself is non-blocking, matching `parallel()`'s concurrency intent), collect the handles into an array, then `await wait(handles)` as one barrier. That barrier is new code, not present in the Claude Code version, because Claude Code's `agent()` was already the blocking primitive `parallel()` fanned out over.

- `pipeline(items, stage1, stage2)`'s documented behavior (`review-pr.js:1282-1284`, *"a dimension's findings start verifying the moment that dimension finishes, rather than waiting for the slowest reviewer"*) plus its null short-circuit (`review-pr.js:1194-1196`, *"the harness runs `if (result === null) break` before handing a dimension to the next stage"*) is reproducible with an ordinary per-item `async` closure — `dimensions.map(async d => { const h = await agent(reviewPrompt(d)); const review = await h.wait().catch(() => null); if (!review) return null; return runVerifyStage(review, d); })` run under one `Promise.all` — but two things are lost or must be re-implemented by hand:

  1. **Ordering/failure isolation**: Claude Code's `pipeline()` gives this per-item independence for free, including the null-short-circuit; in eval the null-check has to be written explicitly at each stage boundary, and a thrown `ToolError` from `agent()`'s failure path (Q2) must also be caught explicitly — `pipeline()`'s host-level "map failures to the same null slot (#527)" behavior (`review-pr.js:1205`) has no counterpart, so `review-pr.js`'s `unrunCrashed()` logic (which relies on a `null` slot per crashed dimension) needs a `try/catch → null` wrapper around every stage that isn't required today.
  2. **Partial results across a whole run**: Claude Code's resumability (`Workflow({resumeFromRunId})`, Q5) means a `pipeline()`/`parallel()` fan-out that partially crashes can be *relaunched* and only the dead legs re-run, replaying the live legs from cache. Nothing in `eval`/`task` replays completed `agent()` calls on a fresh script execution — each `eval` cell/script run is a clean dispatch. A `wait()`-based reproduction of `pipeline()`/`parallel()` gets you the *concurrency shape* but not the *resumability* Claude Code's version rode on top of it for free.

## 4. How does `SendMessage` map onto `hub`?

**`review-pr.js` itself calls `SendMessage` zero times.** Its own top-of-file rationale (`review-pr.js:14-26`) states this is deliberate: *"agent() returns INTO THIS SCRIPT. There is no delivery path to lose"* — the whole design displaces the hand-dispatch fleet's `SendMessage`-based reporting (documented in `skills/run-team/SKILL.md`, `docs/specs/2026-07-22-run-team-agent-fleet-design.md`, `skills/run-team/references/member-lifecycle.md`) with direct return values. So there is nothing in this file to map. For completeness, since the general pattern is what `review-pr.js` was built to avoid, here is how the surrounding fleet's `SendMessage` usage compares to `hub`:

| Property | `SendMessage` (Claude Code fleet docs) | `hub` (`op:"send"`) |
|---|---|---|
| Default delivery mode | Push-style report: *"A report is a `SendMessage`, not the end of a turn… The controller does not acknowledge reports"* (`skills/run-team/SKILL.md:21-34`) — effectively fire-and-forget from the sender's perspective | Fire-and-forget by default: *"returns delivery receipts immediately… Replies are real turns by the recipient, observed with `wait` (or the `await: true` send sugar)"* (`src/tools/hub/messaging.ts:6-9`) |
| Blocking variant | Not documented as a first-class option; controller polls/relays instead | `await: true` sugar blocks the sender's turn on the recipient's reply |
| Steering (interrupting a running peer mid-task) | Not documented | Present: eval cells specifically back this off — *"A queued user/peer message (steer) arriving mid-wait backgrounds the cell immediately"* (`omp://tools/eval.md`, "Auto-backgrounding") |
| Reviving a parked/idle recipient | Explicitly does **not** work for a dead member: *"`SendMessage` does nothing for dead… A killed member cannot be resumed"* (`docs/specs/2026-07-22-run-team-agent-fleet-design.md:161-166`, `skills/run-team/references/member-lifecycle.md:33`); it *does* resume an idle/truncated one, but *"resumes its transcript, carrying the previous ticket's context into the next one"* — a hazard the docs warn against reusing for new work | Parked agents are revived automatically on direct send: *"Direct sends go through the bus unfiltered so parked recipients are revived"* (`src/tools/hub/messaging.ts:299-301`); a genuinely dead/aborted job still fails delivery (receipt `outcome: "failed"`) |
| Reaching a message's own spawner, not just the top-level controller ("grandchild routing") | Explicitly broken: *"Specialist's report routes to *you*, controller… Reviewer has no *messaging* channel to a grandchild — `SendMessage` to one returns `had no active task; resumed from transcript` without report"* (`skills/run-team/references/member-lifecycle.md:19-25`) — this is the exact failure `review-pr.js` was written to route around | omp's agent registry is process-global (`packages/coding-agent/src/registry/agent-registry.ts`, cited in `omp://tools/task.md` source list) and roster entries carry `parentId` (`src/tools/hub/messaging.ts:190-191`) rather than being scoped to a two-level controller/child relationship — consistent with any live/idle/parked agent being independently addressable by id. This is an architectural difference worth flagging, not independently re-measured here for the deep-nesting case. |

The practical upshot for a port: `review-pr.js`'s decision to route findings through `agent()` return values instead of `SendMessage` isn't undermined by anything in `hub` — if anything, `hub`'s flatter, process-global addressing looks like it would have made the original grandchild-routing failure *less* likely, though that specific claim about deep nesting is inference from the registry's documented shape, not a reproduced measurement.

## 5. What has no counterpart at all?

In priority order for whoever picks this up next:

1. **Run-level resumability with cached `agent()` replay.** `Workflow({scriptPath, resumeFromRunId})` — cited only in the string `resumeFor()` builds (`review-pr.js:1271-1279`) and pinned by `scripts/review-pr-unverified-discriminant.test.mjs:130-144` — lets the controller relaunch a partially-crashed run and *"the unchanged prefix of `agent()` calls replays from cache and only the calls that died run live."* Nothing in `eval` or `task` memoizes subagent dispatch by run id across separate tool invocations. This is the single biggest behavioral loss: every one of `review-pr.js`'s "a crashed dimension is resumable, not a reason to defer" guarantees (`review-pr.js:1258-1259`) depends on it.

2. **A named, invokable workflow file with a structured `args` contract.** `Workflow({name: "fleet:review-pr", args: {pr, branch, worktree, testCmd, scratch}})` (`commands/review-and-fix.md:37`, `skills/run-team/SKILL.md:1130-1133`) is how the controller runs this file at all, and it's restricted to the controller (*"Only you can run it — members have no `Workflow` tool"*, `SKILL.md:1132`). `eval` has no file-registry, no name-based invocation, and no invocation-time parameter object — a cell is `{language, code, title, timeout, reset}` and nothing else. Porting `review-pr.js`'s `args`/`decodeArgs` contract means either interpolating caller values into a `code` string per invocation, or staging them through `read()`/`local://` files; both are qualitatively different from passing a JSON `args` object to a named script.

3. **Per-call `model` and `effort` overrides on subagent dispatch.** `review-pr.js` exposes `A.snapshotModel`, `A.specialistModel`, `A.verifierEffort`, and per-dimension `d.model` as first-class caller-tunable knobs, each threaded into an `agent()` call's `model`/`effort` option. eval's `agent()` schema has no `model` or `effort` field at all (Q2) — *"the selected agent's frontmatter model and settings always apply (no per-call `model`)"* (`omp://tools/eval.md`, § `agent()`). The only lever is `task.agentModelOverrides`, a **session-wide** setting (`omp://tools/task.md`, § Flow step 7), not a per-call, per-dispatch argument — so a script cannot vary the model per dimension or per run the way `DEFAULT_DIMENSIONS` and the `A.*Model` args do today.

4. **Exact-string, namespaced agent-type resolution.** All six `DEFAULT_DIMENSIONS` entries name their specialist with the Claude Code Task-tool convention `"<plugin>:<agent-file-name>"` — e.g. `agentType: "pr-review-toolkit:code-reviewer"` (`review-pr.js:154`). omp's agent lookup is an **exact match on the bare frontmatter `name:` field**, with no colon-splitting anywhere in the resolution path:
   ```ts
   // src/task/structured-subagent.ts:272-276
   const discovery = await discoverAgents(request.session.cwd, undefined, request.session.effectiveExtensionRoots?.());
   const agent = getAgent(discovery.agents, agentName);
   if (!agent) {
     const available = discovery.agents.map(candidate => candidate.name).join(", ") || "none";
     throw new StructuredSubagentError("preflight", `Unknown agent "${agentName}". Available: ${available}`);
   }
   ```
   The `pr-review-toolkit` plugin's own frontmatter is bare: `name: code-reviewer` (`~/.claude/plugins/cache/claude-plugins-official/pr-review-toolkit/0120fb83da5d/agents/code-reviewer.md:2`). Passing the literal string `"pr-review-toolkit:code-reviewer"` as `agent()`'s `agent` option would fail this exact preflight check outright. Worse, the bare name `"code-reviewer"` is **not unique** across installed marketplace plugins on this machine — `feature-dev` also ships a `code-reviewer.md` (`~/.claude/plugins/cache/claude-plugins-official/feature-dev/0120fb83da5d/agents/code-reviewer.md`) — and omp's discovery dedupes by first-seen name with no per-plugin disambiguation (`src/task/discovery.ts:123-136`), so even a corrected bare-name call risks silently resolving to the wrong plugin's agent depending on discovery order, not the one `review-pr.js` intends.

5. **The `mktemp`-based per-run token argument for its own safety property.** Not a primitive gap so much as a premise gap: `review-pr.js:389-410` derives its whole "the shell mints the per-run directory segment, never the script" design from a measured Claude Code Workflow sandbox restriction (`Math.random`/`Date.now`/argless `new Date()` throw — *"unavailable in workflow scripts (breaks resume)"*). No such restriction is documented anywhere for eval's Bun VM. This doesn't cost anything by itself, but the code and 60+ lines of comment defending it (`review-pr.js:389-430`) exist entirely because of a Claude-Code-specific constraint that would not apply verbatim in eval — see Q6.

## 6. Could a Claude Code workflow and an omp eval script share one implementation file?

Not verbatim, and not as a thin dispatcher either — feasibility only, no recommendation:

- **The file's contract is Claude-Code-shaped end to end**, not incidentally. `export const meta` (Q1/Q5 #2), the sandboxed global surface (`console`/`budget`/`agent`/`parallel`/`pipeline`/`workflow`/`args`, `review-pr.js:406-407`), the implicit top-level `await` with no `import` (`review-pr.js:229-230`, `912-916`), and the `Math.random`/`Date.now` throw (Q5 #5) are all Claude Code Workflow-sandbox specifics with no eval analog. An eval `js` cell is a Bun worker VM with normal `import`, normal `Date.now`, normal `Promise`, and no `meta`/`phase`-list contract to satisfy (`omp://tools/eval.md`, § Runtime behavior › JavaScript).
- **The primitives that *do* transfer** (`log`, `phase`, a per-call JSON-Schema-validated `agent()`) transfer with different call shapes and different failure semantics (Q2, Q3) — a shim would need to paper over "handle vs. value," "null-on-exhaustion vs. accept-with-warning," and "silently-dropped `model`/`effort`/`phase` options" (Q2) to keep the *same source text* behaviorally equivalent under both hosts.
- **The primitives that don't transfer at all** (`pipeline`, `parallel`, `Workflow({resumeFromRunId})`, per-call `model`/`effort`, namespaced `agentType`) are not cosmetic — `pipeline`/`parallel`'s concurrency shape is reproducible (Q3), but the *resumability* the whole design leans on for crash recovery (`resumeFor`, Q5 #1) has no eval-side substitute at all, host primitive or otherwise.
- A shim library (a thin `pipeline()`/`parallel()`/`phase()` polyfill loaded into both hosts) could plausibly cover the concurrency-shape gaps. It could not by itself restore run-level `agent()`-call caching, restore a controller-facing `Workflow({name, args})` invocation contract, or resolve `pr-review-toolkit:code-reviewer`-style plugin-qualified agent names — those are host capabilities, not call-shape differences, and no amount of userland wrapping inside the shared file changes what the underlying host does or doesn't persist across a relaunch.

Net: the host shims necessarily diverge on at least the resumability and agent-resolution axes; how much of the rest could be unified behind a shim is a design question for the follow-up ticket, not settled by this research.
