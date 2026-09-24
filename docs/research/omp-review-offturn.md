# omp: which primitive runs review-core.js off the controller's turn?

Research for `feigi/fleet-plugin` issue #1771 (wayfinder map #1768, slug
`omp-review-offturn`). Answers measured live against a real omp `eval`/`task`
session (this research agent's own kernel), not inferred from docs alone.

## TL;DR / recommended primitive

**Dispatch a `task`-type member (`review-pr-<pr#>`) that owns an `eval` tool
call. The member runs `await runReviewOnOmp(args)` to completion inside that
one cell of its own kernel, with the eval call's `timeout: 0`.** The default
cell timeout is 30s (`omp://tools/eval.md`), which aborts a review that runs
for minutes. The member's agent type must also have a spawn policy that allows
the `fleet-review-*` agents, because `agent()` preflight refuses spawns
otherwise (Probe A2r in `probe-omp-review-offturn.md`). The controller's turn
stays free the whole time. The member's final report auto-delivers to the
controller like any other `task` dispatch, with no polling. This mirrors the
*existing* Claude-side fallback in SKILL.md § "Fallback: hand-dispatched reviewer
member (no `Workflow` tool)": the `review-pr-<pr#>` member (SKILL.md L2728) is
hand-dispatched, does the whole review-and-fix loop and exits. The omp version
keeps that shape but runs `eval` to invoke `runReviewOnOmp` instead of
`Workflow`.

**Do NOT fire-and-forget `runReviewOnOmp()` from the controller's own eval
kernel across a cell boundary** (storing the returned promise on `globalThis`
and letting the cell return). Measured live below with pipeline-shaped
probes: the chain is orphaned at its first host-bridge `await` whose reply
arrives after the cell returned. In `runReviewOnOmp` that `await` is the
snapshot's `agent()` registration (review-core.js:585, through
`review-eval.mjs`'s `ompAgent`). This matches the symptom in memory
`r8OYSbQL_MTO_-hk1T06_`.

## (a) An unawaited promise in an eval cell

Probes A1 and A2 were run in this agent's own persistent eval kernel
(`/Users/chris/dev/fleet-plugin`, Bun JS backend). Probes A2r and A3 were
added in PR #1785's review (below).

**Probe A1 — plain promise, no host bridge calls.** Kicked off a bare
`new Promise((resolve) => setTimeout(resolve, 4000))` chained with `.then()`,
stored unawaited on `globalThis`, returned the cell immediately. A later cell
(after a 6s `bash sleep`) found `resolved: true, thenFired: true` — **a plain
JS promise chain with no host-bridge calls DOES keep running and DOES settle
across cell boundaries**, in the same persistent kernel process. This matches
`omp://tools/eval.md`'s "One tool call is one cell; state survives later
calls" for plain kernel state, and explains why the JS event loop itself isn't
the problem.

**Probe A2 — replicating `runReviewOnOmp`'s actual shape.** Defined:

```js
async function runLikeReview() {
  const h = agent("Reply with exactly the single word PONG and nothing else.",
    { agent: "sonic", label: "probeA2" });   // NOT awaited: h is a PendingHandle
  const result = await h.wait();
  phase("probe A2 done");              // eval prelude global, called AFTER the cell returned
  log("...");
  return result;
}
globalThis.__probe2Promise = runLikeReview().catch(...);
// cell returns immediately, unawaited
```

Progress was tracked via a `globalThis.__probe2` state object updated at each
step. Result, checked from later cells over 35+ seconds (well past the ~20s
the underlying `sonic` job actually took):

- The state reached `"awaiting-wait()"`, which is set synchronously right after
  the un-awaited `agent(...)` call, and **never advanced**.
  `phase("probe A2 done")` was never reached. A *fresh* `.then()` attached to
  the outer promise from a new cell never fired, even with a 3s in-cell
  wait.
- The underlying `agent()` job **did** complete: an auto-delivered system
  notice arrived unprompted (no polling) reporting
  `{"status":"complete","assignment":"reply with PONG","response":"PONG"}`
  for job `ResearchR3OmpReviewOffTurn.probeA2`.

**What A2 does and does not show.** A2 shows that the orchestrating promise
never settles and that code after the stall, including `phase()`/`log()`,
never runs. It does **not** show *where* the chain stalls. `agent()` was not
`await`ed, so `h` is a `PendingHandle` with no `id` yet. `await h.wait()` on it
has to wait for the registration host-bridge reply (which supplies the `id`)
before the wait bridge, and the single `"awaiting-wait()"` stage covers both.

**Probes A2r and A3, added in PR #1785's review, separate the two bridges.**
Both are in `probe-omp-review-offturn.md`, run from a different
(`fleet-implementer`-type) agent's kernel.
- **A2r**: the same pipeline, with `await agent(...)` (as `review-eval.mjs`'s
  `ompAgent` does, review-eval.mjs:85-87) as its own timed stage before
  `.wait()`. It stalled at `"awaiting-registration"` for 228s+ and never
  reached `.wait()`. In a live cell the same `agent()` call rejects at
  preflight (`Cannot spawn 'sonic'. Allowed: none (spawns disabled for this
  agent)`), so a reply existed and was never delivered to the orphaned
  promise. No job was spawned there, so A2r shows a lost *rejection* reply,
  not a lost successful registration.
- **A3**: `completion()`, which uses the same `PendingHandle` → handle
  `.wait()` shape, with registration `await`ed *inside* the cell so that only
  `.wait()` crosses the boundary. It stalled at `"awaiting-wait()"` for 137s+.
  The identical call fully awaited in a live cell took 34ms to register and
  581ms to wait, and returned `"PONG"`.

**Reading:** a host-bridge reply that arrives after its originating cell has
returned is never delivered to the kernel-side promise, and this held for both
the registration bridge and the wait bridge. Plain JS promises are unaffected
(A1). For the real pipeline, `runReview` calls `phase("Snapshot")`
synchronously in the starting cell (review-core.js:584). The next step is
`await agent(...)` for the snapshot (review-core.js:585, through `ompAgent`), a
bridge await. [INFERENCE] The fire-and-forget pipeline therefore stalls there,
before any `phase()`/`log()` call after the cell returns can run. That locates
the stall earlier than memory `r8OYSbQL_MTO_-hk1T06_`'s `phase()`/`log()`
hypothesis and is consistent with memory `N_igqqvVjpogQ7Y-wQKOR`'s observation
("the snapshot stage completed... but ZERO `fleet-review-*`
dimension-specialist peers were ever spawned"). The snapshot job runs
host-side, while the promise orchestrating the later stages is already
orphaned.

**Is completion observable without polling?** Split answer:
- Per-`agent()`-call: **yes** — each individual `agent()`/`workpool()` spawn
  is a registered async job and *does* auto-deliver a system notice when it
  settles, unprompted, exactly as `omp://tools/eval.md`'s "Auto-backgrounding"
  section and `xd://eval/agents`' "Unwaited results auto-deliver like async
  jobs" describe.
- For the *pipeline as a whole*: **no** — because the orchestrating `await`
  chain is orphaned after the first hop, no later stage ever runs, so there is
  nothing left to auto-deliver a *review result* for. The one delivered notice
  is for the snapshot (or whichever call was in flight), not the review.

**Can the cell register completion via `@tool` or a `local://` write?**
Structurally no, for the same reason: any `write("local://...")` or `@tool`
call placed after the first `await` inside the pipeline is dead code once the
cell returns — it is never reached, because the `await` that would reach it
never resumes. Registering a callback *before* the first `await` is reachable
(as shown, code runs fine up to the `agent()` call itself) but cannot help,
because nothing meaningful has happened yet at that point.

The one *documented* mechanism that could keep a bare eval-kernel pipeline
alive off-turn is `eval.autoBackground.enabled` (default `false`,
`thresholdMs` default 60000ms, per `omp://tools/eval.md` § Auto-backgrounding):
if a *single, still-open* cell call runs past the threshold, the **tool
itself** — not user code — converts the still-in-flight call into a
backgrounded async job and returns control to the caller, while the call
keeps running to completion in place (this is different from a script
fire-and-forget: the underlying tool invocation is never severed, just
detached from blocking the turn). This was **not testable from this agent's
own tool surface**: the `eval` tool schema exposed here takes only
`language`, `code`, `reset`, `timeout`, `title` — no per-call
`autoBackground` toggle — so whether it is enabled is a host/session-level
setting outside a member's control. If it is on, the correct recipe would be
`await runReviewOnOmp(args)` as a single, otherwise-ordinary blocking call
(exactly as memory `r8OYSbQL_MTO_-hk1T06_`'s working fix already does with
`timeout: 0`) and let the *host* background it past the threshold, rather than
the caller doing so manually with an unawaited promise. **Caveat:** unverified
whether `autoBackground` is available/on in this install; treat as untested.

## (b) A task-dispatched member (`review-pr-<n>`)

This research agent **is** a `task`-dispatched member, and was used as the
live test subject:

- **Has `eval`?** Yes — every probe above ran from this agent's own `eval`
  tool.
- **Can it call `agent()` in its own kernel?** Yes, if its agent type's spawn
  policy allows it. Probe A2 spawned a real `sonic` subagent from this
  agent's own eval kernel and got a real, correct reply (`PONG`) through
  auto-delivery. The same call from a `fleet-implementer`-type member (Probe
  A2r) was refused at preflight: `Cannot spawn 'sonic'. Allowed: none (spawns
  disabled for this agent)`. No `plugin/agents/*.agent.md` declares `spawns:`,
  so the `review-pr-<n>` member's agent type must be chosen for its spawn
  policy.
- **Can it load `review-eval.mjs` through the Resolver?** Yes, measured
  directly:
  ```
  $ FLEET_HARNESS=omp ~/.fleet/bin/fleet-run --path review-eval.mjs
  /Users/chris/.omp/plugins/cache/plugins/fleet-plugin___fleet-ctl___0.0.0/scripts/review-eval.mjs
  ```
  followed by `await import(path)` from this agent's own eval kernel, which
  succeeded and returned `{ runReviewOnOmp: [Function] }` (arity 1) — the
  export review-eval.mjs itself declares (`review-eval.mjs:125`). The pipeline
  was **not invoked** (that would dispatch real `fleet-review-*` specialists,
  out of scope for this ticket's constraints), only imported and inspected.
- **Does its final message auto-deliver to the controller?** Yes, by
  construction: this agent was dispatched via `task` by `Main`, and (per this
  harness's own `task` contract) "Your final result reaches Main
  automatically" — no polling, no `SendMessage` round-trip needed. This is the
  same mechanism `omp://tools/task.md`'s Outputs section documents for a
  background (`async.enabled: true`) spawn: `content: "Spawned agent <id> (job
  <jobId>)"` returned immediately, then the settled result "delivered later
  like a backgrounded bash command."

**A load-bearing status-quo fact this contradicts partially:** SKILL.md
L1908–1909 (§ "Reviewers", one sentence covering both harnesses) currently
reads "Only you can run it — members have no `Workflow` tool on Claude and no
reason to run `eval` themselves on omp (verified 2026-07-30 for the
`general-purpose` subagent on Claude...)." The verification date and example
are **Claude-only** (checking `Workflow` tool availability for the
`general-purpose` subagent). The omp half of that sentence ("no reason to run
`eval` themselves") was **never actually tested**. It is a design assertion,
not a measured limitation. This research measured the opposite: a
`task`-dispatched member on omp *can* run `eval`, *can* call `agent()` (given
a spawn-permitting agent type, above), and *can* load `review-eval.mjs`
through the Resolver exactly as the controller does. No harness constraint
prevents it. Invoking the review directly from the controller today is a
design choice.

**Recursion depth is not a concern.** `review-core.js`'s `runReview(host,
args)` (review-core.js:534) is one flat async function — snapshot,
specialists, and refuters are all dispatched via the *same* `host.agent()`
call from the *same* call stack (`review-core.js:585` snapshot,
`review-core.js:722` specialist dimension selection, `review-core.js:830-833`
per-finding refuters) — there is no agent-dispatching-agent recursion inside
the review pipeline itself. Adding one level of indirection (controller →
`review-pr-<n>` member → specialists/refuters) puts specialists/refuters at
depth 2 from the controller, which is *at*, not past, the documented default
`task.maxRecursionDepth` of 2 (`omp://tools/eval.md`: "Eval subagent spawning
obeys `task.maxRecursionDepth` (default `2`; negative values allow unlimited
depth)."; `omp://tools/task.md` item 13: "strip `task` at
`task.maxRecursionDepth`" — the *child's own* further fan-out is what gets
capped, not the spawn arriving at that depth).

## (c) Delivery path per "React to artifacts, not agents"

(The ticket cites this at SKILL.md L1469. In this branch it is L1492–1495,
the paragraph that opens with the bolded "React to artifacts, not agents." and
continues: `` `idle` means "not currently executing", not "done", and a finished
member's finding may never arrive.`` Re-anchor by that phrase, not by line.)

- **Plain unawaited eval promise (a):** no viable delivery path for the
  pipeline as a whole — it never finishes, so there is no artifact to react
  to. The one thing that *does* arrive (a per-`agent()`-call auto-delivered
  notice) is not the review result and stops at whichever stage was first
  dispatched.
- **`task`-dispatched member (b):** the artifact is the member's own final
  report/structured output, delivered via the *same* auto-delivery mechanism
  every other `task` dispatch uses (no bespoke plumbing needed) — this is
  exactly a "SendMessage" event, satisfying "React to artifacts, not agents"
  directly: the controller's tick reacts to the delivered report content (or,
  per the existing PR-review contract, the PR's resulting label/state), never
  by polling the member's `idle`/`running` status.

## (d) `task.maxConcurrency` interplay at the stated fan-out ceiling

`omp://tools/eval.md` § Limits and errors reads, exactly: **"Eval subagent
spawning obeys `task.maxRecursionDepth` (default `2`; negative values allow
unlimited depth). Helper fan-out uses `task.maxConcurrency` (default 32, `0`
unbounded)."** So the eval doc ties `agent()` spawning to *recursion depth*.
The concurrency setting is tied to "helper fan-out", and the same doc's
§ `workpool()` separately says a pool is "bounded by the live
`task.maxConcurrency`". It does not say that eval `agent()` calls acquire the
`task` tool's semaphore.

That semaphore is described by `omp://tools/task.md` § Limits & Caps:
**"Concurrency: one session-scoped `Semaphore` is resized in place from the
live `task.maxConcurrency` setting before every acquire and release, then
bounds concurrent subagents across parallel `task` calls — both async job
bodies and the sync fallback acquire it."** Flow step 4 adds that there is
"one per `TaskTool` instance". Flow step 12 says each `task` spawn gets "a
child agent session".

What this supports for the recommended primitive (controller → 5
`review-pr-<n>` members → specialists/refuters):

- **Controller tier (`task`):** the 5 members are 5 `task` spawns on the
  controller's semaphore, well under the default 32.
- **Member tier (eval `agent()`):** each member's review fan-out (1 snapshot,
  up to 6 specialists, and 2 refuters per critical/important finding) is
  spawned with eval `agent()` from that member's own child session. The
  sources give no single counter shared by the controller, all members and
  every `agent()` inside `runReviewOnOmp`.
  [INFERENCE] Given "one per `TaskTool` instance" and a separate child
  session per member, any `task.maxConcurrency`-sized limit an eval spawn
  meets is the member's own, not the controller's. Whether eval `agent()`
  spawns queue on any concurrency limit at all is **undocumented and
  unmeasured**.
- The "5 reviews × per-review fan-out ≤ 32" arithmetic therefore does not
  apply to this shape as a single budget.

**What happens at a limit differs by tier.**
- `task` tier: **queueing, not refusal.** Per `omp://tools/task.md` Flow step
  4, each spawn's agent id and job entry are allocated and registered
  immediately (`queued: true`), and each job body acquires the semaphore
  before it runs `#executeSync(...)`. None of the failures listed in
  `omp://tools/task.md` § Errors (parameter validation, spawn-policy denial,
  isolation, job-registration failure, child failures) is a concurrency-cap
  error.
- eval `agent()` tier: **refusal at preflight for depth and spawn policy.**
  `omp://tools/eval.md` § `agent()`: "Preflight (spawn policy, unknown agent,
  `task.maxRecursionDepth`, hard turn budget, plan-mode isolation controls,
  unknown `tools` names) fails the call synchronously". Probe A2r observed
  exactly that for spawn policy (`Cannot spawn 'sonic'. Allowed: none`). In
  `review-eval.mjs` that throw comes out of `ompAgent`'s `await agent(...)`,
  outside its `try`, which only guards `.wait()` (review-eval.mjs:84-90).

**Practical implication for the design:** the controller-side concurrency
budget is not the constraint at 5 reviews. The hard gates are the member's
agent type (its spawn policy must admit every `fleet-review-*` agent) and
recursion depth (specialists/refuters at depth 2 against the default
`task.maxRecursionDepth` of 2, see §(b)). Both fail synchronously rather than
queue. G1/G5 should verify both end-to-end with a real member before relying
on them. Whether heavy refuter fan-out inside one member queues (extending
wall-time) is an open question for G1/G5 to measure, not a documented
ceiling.

## Sources

Numeric defaults quoted below and above (`task.maxConcurrency` 32,
`task.maxRecursionDepth` 2, eval cell `timeout` 30s,
`eval.autoBackground.thresholdMs` 60000ms) come from omp's own docs, which
ship with omp outside this repo and carry no version pin here. They were read
on omp 18.3.0 during PR #1785's review.

- `omp://tools/eval.md` — Auto-backgrounding, prelude helpers (`agent()`,
  `completion()`, `workpool()`, `wait()`), Limits and errors (recursion depth
  vs. helper fan-out), backend/kernel-persistence semantics.
- `omp://tools/task.md` — Inputs/Outputs, Flow (steps 3–4, 12–13), Limits &
  Caps (Concurrency, Idle TTL, recursion-depth tool stripping), Errors.
- `omp://extensions.md` — not directly load-bearing for this ticket (covers
  the `packages/coding-agent` extension surface, not the `task`/`eval` tool
  contracts); read for completeness per the ticket's source list.
- `xd://eval/agents` — DAG/handle model (`agent()` returns at once; unwaited
  results auto-deliver; `wait()` = barrier).
- `plugin/scripts/review-eval.mjs` (full file read) — header comments citing
  #1296 Q2 (handle-vs-data), Q3 (no `pipeline`/`parallel` builtin), Q6
  (relative sibling import), and #1433 (no per-call cwd, why the isolation
  rule lives in prompts instead).
- `plugin/scripts/review-core.js:534-936` (`runReview`), `:584-585`
  (`phase("Snapshot")` then the first `await agent(...)`), `:177`
  (`DEFAULT_DIMENSIONS`), `:830-833` (per-finding refuter dispatch). Together
  they show the flat, non-recursive dispatch shape.
- `plugin/scripts/review-eval.mjs:84-90` (`ompAgent`: `await agent(...)` then
  `await handle.wait()`, `try` around `.wait()` only).
- `plugin/skills/run-team/SKILL.md:1905-1909` (§ "Reviewers": per-harness
  review dispatch instructions and the "no reason to run `eval` themselves on
  omp" claim), `:1946-1953` ("One review workflow at a time": 1 snapshot + ≤6
  specialists + 2 refuters/finding, reviewer cap accounting; the
  "5 concurrent reviews" figure is the ticket's own, #1771 (d)), `:1492-1495`
  ("React to artifacts, not agents."), `:2722-2782` (§ "Fallback:
  hand-dispatched reviewer member (no `Workflow` tool)". This is the
  Claude-side `review-pr-<pr#>` member, named at `:2728`, and the
  architectural precedent this research's recommendation ports to omp).
- Live probes: this agent's own `eval` kernel, session
  `ResearchR3OmpReviewOffTurn` (A1, A2, B), plus PR #1785's fix-applier kernel
  (A2r, A3). `probe-omp-review-offturn.md` alongside this file has the exact
  code run.

## Caveats

- `eval.autoBackground.enabled`/`thresholdMs` could not be tested — this
  agent's own `eval` tool exposes no per-call toggle for it, and there is no
  visibility into whether it is enabled at the host/session level for a real
  `run-team` controller session. If it is enabled by default in a real
  controller session (unlike this research session), it may offer a *second*
  viable off-turn primitive for approach (a) that this research could not
  confirm or refute.
- The recommended primitive (task-dispatched `review-pr-<n>` member with its
  own `eval`) was verified for its *building blocks* (eval, `agent()`,
  Resolver import, auto-delivery) but the full `runReviewOnOmp()` pipeline was
  deliberately **not invoked end-to-end** inside a dispatched member, per this
  ticket's constraint against dispatching real fleet members/reviews. G1
  should treat the end-to-end wiring (member prompt, result schema, fix-
  applier/finisher hand-off) as a design task, not a re-verified fact.
- `task.maxConcurrency`'s default (32) and the queueing-not-refusal behavior
  of the `task` tier are taken from `omp://tools/task.md`/`omp://tools/eval.md`
  prose. No load test was run against 30+ simultaneous spawns (it would have
  required dispatching that many real subagents, out of proportion for this
  ticket). Whether eval `agent()` spawns inside one member queue on any
  concurrency limit is not documented and was not measured (§(d)).
- Probes A2r/A3 ran in a `fleet-implementer`-type agent whose spawns are
  disabled. A2r therefore shows a lost *rejection* reply from the
  registration bridge, not a lost successful registration, and A3 isolates the
  wait bridge with `completion()` rather than `agent()`. That both behave the
  same way under a successful `agent()` spawn is [INFERENCE].
- SKILL.md's cited line numbers (1492, 1905-1909, 1946-1953, 2722-2782, 2728)
  may drift further as the plan's own G-tickets rewrite this file. Re-anchor
  by the quoted phrase or § heading, not by line number, once G1/G2/G5/G6
  land.
