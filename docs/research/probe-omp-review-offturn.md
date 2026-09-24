# Probes run for `docs/research/omp-review-offturn.md`

Probes A1, A2 and B were run, verbatim, in the original research agent's own
persistent `eval` (JS/Bun) kernel, from cwd `/Users/chris/dev/fleet-plugin`.
Probes A2r and A3 were added during PR #1785's review, run in the fix-applier
agent's own kernel (a `fleet-implementer`-type subagent, omp 18.3.0, same cwd).
Timestamps are `Date.now()` epoch-ms from the live run.

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

**Result: the outer promise never settles, and nothing after the stall point
runs (including `phase()`/`log()`). This probe does NOT locate that stall
point.** `agent()` was called without `await`, so `h` is a `PendingHandle`
(Probe A2r shows its `id` is `null`), not a registered `AgentHandle`. The
`"awaiting-wait()"` stage was set synchronously right after that call, and
`await h.wait()` on a `PendingHandle` has to wait for the registration
host-bridge reply (it has no `id` to wait on until then) before the wait
bridge. So the stage covers both bridges, and the host-side job completing
(the notice above) says nothing about which reply the kernel lost. Probes A2r
and A3 separate the two.

## Probe A2r: A2 re-run with the registration and wait stages timed separately

Same shape as A2, but the `agent()` return value is inspected and then
`await`ed as its own stage before `.wait()`. This is also
`review-eval.mjs`'s real `ompAgent` shape (`await agent(...)` then `await
handle.wait()`, review-eval.mjs:85-87).

Cell 1:

```js
globalThis.__p = { stage: "not-started", t0: Date.now() };
async function runLikeReviewStaged() {
  const p = globalThis.__p;
  p.stage = "calling-agent()";
  const pending = agent("Reply with exactly the single word PONG and nothing else.", { agent: "sonic", label: "probeA2r" });
  p.agentReturn = {
    ctor: pending?.constructor?.name,
    isThenable: typeof pending?.then === "function",
    syncId: pending?.id ?? null,
    hasWait: typeof pending?.wait === "function",
  };
  p.stage = "awaiting-registration";
  const h = await pending;
  p.registeredAt = Date.now();
  p.handleId = h?.id ?? null;
  p.handleCtor = h?.constructor?.name;
  p.stage = "awaiting-wait()";
  const result = await h.wait();
  p.waitReturnedAt = Date.now();
  p.stage = "wait()-returned";
  p.result = typeof result === "string" ? result.slice(0, 200) : result;
  phase("probe A2r done");
  log("probe A2r phase/log after cell return");
  p.stage = "phase-log-called";
  return result;
}
globalThis.__pPromise = runLikeReviewStaged().catch((e) => {
  globalThis.__p.stage = "rejected";
  globalThis.__p.error = String((e && e.stack) || e);
});
display(globalThis.__p);
"cell-returned-immediately";
```
→
```json
{ "stage": "awaiting-registration", "t0": 1790258156607,
  "agentReturn": { "ctor": "PendingHandle", "isThenable": true, "syncId": null, "hasWait": true } }
```

Cell 2 (immediately after): `stage` `"awaiting-registration"`,
`elapsedMs` 2812. After `bash sleep 25`, Cell 3: unchanged, `elapsedMs`
31591. After `bash sleep 20`, Cell 4 attached a fresh `.then()` to
`__pPromise` and waited 3s in-cell (as in A2's Cell 5):
```json
{ "attached": 1790258214227, "settled": false }
{ "stage": "awaiting-registration", "elapsedMs": 60621 }
```
A final re-check at `elapsedMs` 228707 was still `"awaiting-registration"`,
late `.then()` still `settled: false`.

The same `agent()` call, `await`ed inside one live cell, shows what the
registration bridge replies here:
```js
globalThis.__c = { stage: "calling-agent()", t0: Date.now() };
try {
  const h = await agent("Reply with exactly the single word PONG and nothing else.", { agent: "sonic", label: "probeA2c" });
  const c = globalThis.__c;
  c.registeredAt = Date.now();
  c.handleId = h.id;
  c.handleCtor = h?.constructor?.name;
  c.statusAtRegistration = typeof h.status === "function" ? await h.status() : h.status;
  c.stage = "awaiting-wait()";
  globalThis.__cHandle = h;
  globalThis.__cPromise = h.wait().then(
    (r) => { c.stage = "wait()-returned"; c.waitReturnedAt = Date.now(); c.result = typeof r === "string" ? r.slice(0, 200) : r; phase("probe A2c done"); log("probe A2c phase/log after cell return"); c.stage = "phase-log-called"; },
    (e) => { c.stage = "wait()-rejected"; c.error = String((e && e.stack) || e); },
  );
} catch (e) {
  globalThis.__c.stage = "agent()-threw-in-cell";
  globalThis.__c.error = String((e && e.stack) || e);
}
display(globalThis.__c);
"cell-returned";
```
→ `"stage": "agent()-threw-in-cell"`, `"error": "ToolError: Cannot spawn
'sonic'. Allowed: none (spawns disabled for this agent) ..."`. This agent
type's spawn policy refuses the spawn at preflight.

**Result: the registration bridge's reply, a preflight rejection that a live
cell receives before it returns, never reached the promise orphaned by the returned
cell.** `runLikeReviewStaged()` neither advanced nor rejected (its `.catch`
would have set `stage: "rejected"`). The chain stalled at `await agent(...)`,
before `.wait()` was ever called. Limit: no job was spawned in this session,
so this run shows a lost *rejection* reply. It does not show a successful
registration being lost.

## Probe A3: the wait bridge alone (registration completed in-cell)

`agent()` spawns are refused for this agent type (above), so the wait bridge
was isolated with the `completion()` prelude helper, which has the same
handle shape (a `PendingHandle` that resolves to a handle with `.wait()`).
Registration is `await`ed inside the cell, so only the `.wait()` reply
crosses the cell boundary.

Cell 1:

```js
globalThis.__w = { stage: "calling-completion()", t0: Date.now() };
try {
  const pending = completion("Reply with exactly the single word PONG and nothing else.", { model: "smol" });
  globalThis.__w.completionReturn = { ctor: pending?.constructor?.name, isThenable: typeof pending?.then === "function", syncId: pending?.id ?? null };
  const ch = await pending; // registration bridge resolved INSIDE this cell
  const w = globalThis.__w;
  w.registeredAt = Date.now();
  w.handleCtor = ch?.constructor?.name;
  w.handleId = ch?.id ?? null;
  w.stage = "awaiting-wait()";
  globalThis.__wPromise = ch.wait().then(
    (r) => { w.stage = "wait()-returned"; w.waitReturnedAt = Date.now(); w.result = typeof r === "string" ? r.slice(0, 200) : r; },
    (e) => { w.stage = "wait()-rejected"; w.waitReturnedAt = Date.now(); w.error = String((e && e.stack) || e); },
  );
} catch (e) {
  globalThis.__w.stage = "threw-in-cell";
  globalThis.__w.error = String((e && e.stack) || e);
}
display(globalThis.__w);
"cell-returned";
```
→
```json
{ "stage": "awaiting-wait()", "t0": 1790258248234,
  "completionReturn": { "ctor": "PendingHandle", "isThenable": true, "syncId": null },
  "registeredAt": 1790258248272, "handleCtor": "CompletionHandle", "handleId": "cmp-158c3a929402495d" }
```

After `bash sleep 20`, Cell 2: `stage` still `"awaiting-wait()"`,
`elapsedMs` 23992.

Control cell, the identical call fully `await`ed in one live cell:
```js
const t0 = Date.now();
const ch = await completion("Reply with exactly the single word PONG and nothing else.", { model: "smol" });
const tReg = Date.now();
const r = await ch.wait();
display({ registerMs: tReg - t0, waitMs: Date.now() - tReg, result: typeof r === "string" ? r.slice(0, 200) : r, orphanState: globalThis.__w.stage });
```
→ `{ "registerMs": 34, "waitMs": 581, "result": "PONG", "orphanState": "awaiting-wait()" }`

A final re-check at `elapsedMs` 137080 was still `"awaiting-wait()"`.

**Result: the wait bridge also stalls on its own.** A `.wait()` issued before
the cell returned, on a handle registered in that cell, never settled, while
the same call settled in 581ms inside a live cell. Live-cell bridge traffic
afterwards (the control) did not deliver it either.

**Combined reading of A2r + A3:** a host-bridge reply that arrives after its
originating cell has returned is never delivered to the kernel-side promise.
Both the `agent()`/`completion()` registration bridge and the `.wait()`
bridge were observed to stall this way. A plain JS promise with no bridge
(A1) is unaffected.

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

`agent()` depends on the member's agent type. Probe A2r's in-cell
call from a `fleet-implementer`-type member was refused at preflight
(`Cannot spawn 'sonic'. Allowed: none (spawns disabled for this agent)`). No
`plugin/agents/*.agent.md` declares `spawns:`. A `review-pr-<n>` member
therefore needs an agent type whose spawn policy allows the `fleet-review-*`
agents.
