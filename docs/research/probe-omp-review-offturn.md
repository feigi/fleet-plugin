# Probes run for `docs/research/omp-review-offturn.md`

All cells below were run, verbatim, in this research agent's own persistent
`eval` (JS/Bun) kernel, from cwd `/Users/chris/dev/fleet-plugin`. Timestamps
are `Date.now()` epoch-ms from the live run.

## Probe A1 — plain promise across a cell boundary

Cell 1:

```js
globalThis.__probe = { startedAt: Date.now(), resolved: false, resolvedAt: null };
globalThis.__probePromise = new Promise((resolve) => {
  setTimeout(() => {
    globalThis.__probe.resolved = true;
    globalThis.__probe.resolvedAt = Date.now();
    resolve("done");
  }, 4000);
}).then((v) => { globalThis.__probe.thenFired = true; return v; });
log("kicked off unawaited promise, cell returning immediately");
"cell1-returned";
```
→ returned `"cell1-returned"` immediately.

(`bash sleep 6` in between, to let 4s elapse past a cell boundary.)

Cell 2:

```js
display(globalThis.__probe);
display({ now: Date.now() });
```
→
```json
{ "startedAt": 1790248107081, "resolved": true, "resolvedAt": 1790248111081, "thenFired": true }
{ "now": 1790248123646 }
```

**Result: resolved and `.then()` fired, fully across the cell boundary.**

## Probe A2 — `runReviewOnOmp`-shaped pipeline (agent() + phase()/log() after return)

Cell 1:

```js
globalThis.__probe2 = { stage: "not-started" };
async function runLikeReview() {
  globalThis.__probe2.stage = "spawning";
  const h = agent("Reply with exactly the single word PONG and nothing else.", { agent: "sonic", label: "probeA2" });
  globalThis.__probe2.handleId = h.id;
  globalThis.__probe2.stage = "awaiting-wait()";
  const result = await h.wait();
  globalThis.__probe2.stage = "wait()-returned";
  globalThis.__probe2.result = result;
  phase("probe A2 done");
  log("probe A2 phase/log call succeeded post-cell-return");
  globalThis.__probe2.stage = "phase-log-called";
  return result;
}
globalThis.__probe2Promise = runLikeReview().catch((e) => {
  globalThis.__probe2.stage = "rejected";
  globalThis.__probe2.error = String(e && e.stack || e);
});
"cell-returned-immediately";
```
→ returned `"cell-returned-immediately"` immediately.

Cell 2 (immediately after):
```js
display(globalThis.__probe2);
```
→ `{ "stage": "awaiting-wait()" }`

(`bash sleep 20`, then check again — no explicit `.wait()`/poll of the handle.)

Cell 3:
```js
display(globalThis.__probe2);
```
→ `{ "stage": "awaiting-wait()" }` — unchanged.

**Unprompted, in between cells (no tool call from this agent), a system notice
arrived:**
```
Background job ResearchR3OmpReviewOffTurn.probeA2 has completed. Resume your
work using the result below.
{
  "status": "complete",
  "assignment": "reply with PONG",
  "response": "PONG"
}
```

Cell 4 (checked immediately after the notice):
```js
display(globalThis.__probe2);
```
→ `{ "stage": "awaiting-wait()" }` — still unchanged, despite the underlying
job having visibly completed per the notice above.

(`bash sleep 15` more — 35s total since spawn, well past the job's actual
completion.)

Cell 5 — non-invasive re-check plus a *fresh* `.then()` attached to the outer
promise, with an in-cell 3s wait to rule out a delayed microtask:
```js
globalThis.__probe2LateCheck = { attached: Date.now(), settled: false };
globalThis.__probe2Promise.then(() => {
  globalThis.__probe2LateCheck.settled = true;
  globalThis.__probe2LateCheck.settledAt = Date.now();
});
await new Promise((r) => setTimeout(r, 3000));
display(globalThis.__probe2LateCheck);
display(globalThis.__probe2);
```
→
```json
{ "attached": 1790248266740, "settled": false }
{ "stage": "awaiting-wait()" }
```

**Result: the outer promise never settles. The hang begins at `await
h.wait()` — the underlying `agent()` job completes and auto-delivers a
notice, but the specific `.wait()` promise created in the already-returned
cell is never resolved, orphaning everything after it (including
`phase()`/`log()`, and, by direct analogy, every later pipeline stage in
`review-core.js`'s snapshot→specialists→refuters chain).**

## Probe B — task-dispatched member capabilities (self-observation)

Resolver lookup, run from this agent's own eval kernel:
```js
const proc = Bun.$`FLEET_HARNESS=omp ~/.fleet/bin/fleet-run --path review-eval.mjs`;
const out = await proc.text();
display({ resolvedPath: out.trim() });
```
→ `{ "resolvedPath": "/Users/chris/.omp/plugins/cache/plugins/fleet-plugin___fleet-ctl___0.0.0/scripts/review-eval.mjs" }`

Import + inspect (no invocation):
```js
const path = "/Users/chris/.omp/plugins/cache/plugins/fleet-plugin___fleet-ctl___0.0.0/scripts/review-eval.mjs";
const mod = await import(path);
display({ exports: Object.keys(mod), runReviewOnOmpType: typeof mod.runReviewOnOmp, fnLength: mod.runReviewOnOmp.length });
```
→ `{ "exports": ["runReviewOnOmp"], "runReviewOnOmpType": "function", "fnLength": 1 }`

Kernel cwd check (confirms the Resolver ran against the real repo checkout,
not a detached scratch dir):
```js
const cwdRes = await Bun.$`pwd`.text();
display({ cwd: cwdRes.trim() });
```
→ `{ "cwd": "/Users/chris/dev/fleet-plugin" }`

This agent (`ResearchR3OmpReviewOffTurn`) is itself a `task`-dispatched
subagent of `Main`, dispatched with `eval`, `bash`, `task`, and other tools
available — directly demonstrating that a `task`-dispatched member on omp has
`eval`, can call `agent()` (Probe A2's spawn), and can load
`review-eval.mjs` through the Resolver exactly as the controller does.
