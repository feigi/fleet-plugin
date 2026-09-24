# omp: which primitive runs review-core.js off the controller's turn?

Research for `feigi/fleet-plugin` issue #1771 (wayfinder map #1768, slug
`omp-review-offturn`). Answers measured live against a real omp `eval`/`task`
session (this research agent's own kernel), not inferred from docs alone.

## TL;DR / recommended primitive

**Dispatch a `task`-type member (`review-pr-<pr#>`) that itself owns an `eval`
tool call, and has that member run `await runReviewOnOmp(args)` to completion
inside its own kernel/turn.** The controller's turn is free the whole time; the
member's final report auto-delivers to the controller exactly like any other
`task` dispatch (no polling). This mirrors the *existing* Claude-side fallback
architecture (SKILL.md L2738 `review-pr-<pr#>`, hand-dispatched, does the whole
review-and-fix loop and exits) — the omp-native version of the same shape,
except the member runs `eval` to invoke `runReviewOnOmp` instead of `Workflow`.

**Do NOT fire-and-forget `runReviewOnOmp()` from the controller's own eval
kernel across a cell boundary** (storing the returned promise on `globalThis`
and letting the cell return). Measured live below: this permanently orphans
the pipeline after (at most) its first internal `await`, matching and
sharpening the existing memory `r8OYSbQL_MTO_-hk1T06_`.

## (a) An unawaited promise in an eval cell

Two live probes, both run in this agent's own persistent eval kernel
(`/Users/chris/dev/fleet-plugin`, Bun JS backend).

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
    { agent: "sonic", label: "probeA2" });
  const result = await h.wait();       // <-- an eval agent() handle, like review-core.js's host.agent()
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

- The state got as far as `"awaiting-wait()"` (i.e. the code up to and
  including calling `agent(...)` ran fine in the original, already-returned
  cell) and **never advanced past it** — `phase("probe A2 done")` was never
  reached, `stage` never became anything else, even after attaching a *fresh*
  `.then()` to the outer promise from a brand new cell and awaiting 3s inline.
- Yet the underlying `agent()` job **did** complete: an auto-delivered system
  notice arrived unprompted (no polling) reporting
  `{"status":"complete","assignment":"reply with PONG","response":"PONG"}`
  for job `ResearchR3OmpReviewOffTurn.probeA2`.

**This pinpoints the failure more precisely than the existing memory
(`r8OYSbQL_MTO_-hk1T06_`), which hypothesized `phase()`/`log()` as the
culprit.** The hang measured here begins at `await h.wait()` itself — the
`agent()` call's own async job completes and the host *does* auto-deliver a
notice for it, but the specific JS promise object returned by `.wait()` inside
an already-returned cell is never resolved/settled, so any code after it
(including `phase`/`log`, and — critically — the SECOND, THIRD, … stage of a
multi-stage pipeline like `review-core.js`'s snapshot→specialists→refuters)
never runs. This exactly reproduces the shape of memory
`N_igqqvVjpogQ7Y-wQKOR`'s observation ("the snapshot stage completed... but
ZERO `fleet-review-*` dimension-specialist peers were ever spawned") — the
orchestrating promise died at the *first* internal `await`, one call in.

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
- **Can it call `agent()` in its own kernel?** Yes — Probe A2 spawned a real
  `sonic` subagent from this agent's own eval kernel and got a real, correct
  reply (`PONG`) delivered via auto-delivery.
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
L1918–1919 (single sentence spanning both harnesses) currently reads "Only you
can run it — members have no `Workflow` tool on Claude and no reason to run
`eval` themselves on omp (verified 2026-07-30 for the `general-purpose`
subagent...)." The verification date/example given is **Claude-only**
(checking `Workflow` tool availability for the `general-purpose` subagent);
the omp half of that sentence ("no reason to run `eval` themselves") was
**never actually tested** — it is a design assertion, not a measured
limitation. This research measured the opposite: a `task`-dispatched member
on omp *can* run `eval`, *can* call `agent()`, and *can* load
`review-eval.mjs` through the Resolver exactly as the controller does. There
is no technical barrier; today's controller-direct-invocation is a design
choice, not a harness constraint.

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
obeys `task.maxRecursionDepth` (default `2`, negative values allow unlimited
depth)"; `omp://tools/task.md` item 13: "strip `task` at
`task.maxRecursionDepth`" — the *child's own* further fan-out is what gets
capped, not the spawn arriving at that depth).

## (c) Delivery path per "React to artifacts, not agents"

(SKILL.md's line has drifted slightly since the ticket was filed: currently at
L1502–1505, not L1469 — same text: `"idle" means "not currently executing",
not "done", and a finished member's finding may never arrive... React to
artifacts, not agents.`)

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

Per `omp://tools/task.md` § Limits & Caps: **"Concurrency: one session-scoped
`Semaphore` ... resized in place from the live `task.maxConcurrency` setting
before every acquire and release, then bounds concurrent subagents across
parallel `task` calls — both async job bodies and the sync fallback acquire
it."** `omp://tools/eval.md` confirms the *same* counter covers eval's own
`agent()`/`workpool()` spawns: "Eval subagent spawning obeys
`task.maxConcurrency` (default `32`, `0` unbounded)." So the whole session —
controller, any dispatched review members, and every `agent()` call inside
`runReviewOnOmp` — shares **one** semaphore, default capacity 32.

At the stated ceiling (5 concurrent reviews × up to 6 specialists, or ×2
refuters per critical/important finding, plus 1 snapshot each):
worst realistic peak (e.g. 5 reviews simultaneously in their specialist
fan-out: 5×6=30) sits *under* the default 32; adversarial overlaps (e.g. many
reviews concurrently running several findings' refuter pairs at once) can
exceed it.

**What happens at the ceiling is queueing, never refusal or an error.** Per
`omp://tools/task.md`'s Flow step 4: each spawn's agent id and job entry are
allocated and registered **immediately** (`queued: true` in the listing,
visible right away), and *only the execution itself*
(`#executeSync(...)`) waits for the shared semaphore to free a slot. A job
that is over the limit shows up as pending/queued in the progress array and
starts once capacity frees — "Malformed backends errors surface as
`ToolError`; unavailable/disabled backends and missing session return output
with nonzero errors" is the *only* documented error path, and it is unrelated
to hitting the concurrency cap. **Practical implication for the design:** 5
concurrent reviews under the default cap of 32 is safe from outright failures,
but peak fan-out (many concurrent refuter pairs) can silently extend review
wall-time as later specialists/refuters queue behind the semaphore rather than
running immediately — worth surfacing as a tunable (`task.maxConcurrency`) or
a design constraint (stagger dispatch, or budget concurrent reviews below the
worst-case product) in G1/G5, not treated as a hard ceiling that refuses work.

## Sources

- `omp://tools/eval.md` — Auto-backgrounding, prelude helpers (`agent()`,
  `workpool()`, `wait()`), backend/kernel-persistence semantics.
- `omp://tools/task.md` — Inputs/Outputs, Flow (steps 3–4), Limits & Caps
  (Concurrency, Idle TTL, recursion-depth tool stripping).
- `omp://extensions.md` — not directly load-bearing for this ticket (covers
  the `packages/coding-agent` extension surface, not the `task`/`eval` tool
  contracts); read for completeness per the ticket's source list.
- `xd://eval/agents` — DAG/handle model (`agent()` returns at once; unwaited
  results auto-deliver; `wait()` = barrier).
- `plugin/scripts/review-eval.mjs` (full file read) — header comments citing
  #1296 Q2 (handle-vs-data), Q3 (no `pipeline`/`parallel` builtin), Q6
  (relative sibling import), and #1433 (no per-call cwd, why the isolation
  rule lives in prompts instead).
- `plugin/scripts/review-core.js:534-913` (`runReview`), `:177`
  (`DEFAULT_DIMENSIONS`), `:830-833` (per-finding refuter dispatch) — the flat,
  non-recursive dispatch shape.
- `plugin/skills/run-team/SKILL.md:1915-1930` (per-harness review dispatch
  instructions and the "no reason to run eval themselves on omp" claim),
  `:1960-1963` (5 concurrent reviews × 1 snapshot + ≤6 specialists + 2
  refuters/finding, reviewer cap accounting), `:1502-1505` ("React to
  artifacts, not agents"), `:2738-2762` (Claude-side hand-dispatched
  `review-pr-<pr#>` fallback member, the architectural precedent this
  research's recommendation ports to omp).
- Live probes: this agent's own `eval` kernel, session
  `ResearchR3OmpReviewOffTurn`, transcripts reproduced inline above
  (`probe-omp-review-offturn.md` alongside this file has the exact code run).

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
  are taken from `omp://tools/task.md`/`omp://tools/eval.md` prose; the exact
  numeric ceiling was not independently load-tested against 30+ simultaneous
  spawns in this session (would have required dispatching that many real
  subagents, out of proportion for this ticket).
- SKILL.md's cited line numbers (1502, 1915-1930, 2738) may drift further as
  the plan's own G-tickets rewrite this file; re-anchor by search, not by line
  number, once G1/G2/G5/G6 land.
