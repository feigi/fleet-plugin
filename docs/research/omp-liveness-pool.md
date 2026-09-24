# omp: liveness reads without a pool, and workpool behaviour under push-per-Pull

Research for `feigi/fleet-plugin` issue #1772, part of wayfinder map #1768
(retiring "wave" from `/fleet-ctl:run-team`). Resolves G5 ("omp implementer
dispatch primitive under per-slot Pull") and G3/G6's need for a liveness
source that doesn't depend on a staging-wave-scoped pool.

All claims below are either **measured** (live probe run in an omp `eval`
kernel on 2026-09-24, transcripts linked inline) or **cited** (file:line in
this repo / `omp://` doc page). Nothing is asserted from memory alone.

## (a) Live counts by name pattern, without a pool

### What's actually available

There is no `hub` shell binary (`which hub` → `command not found`) and no
`hub` symbol inside an `eval` kernel (`'hub' in dir()` → `False`,
`hub` → `NameError`). `SendMessage`/`hub` are explicitly scoped as
**"harness terms"** confined to `CLAUDE:`/`OMP:` marked lines in this repo's
own prose (`plugin/skills/run-team/references/member-lifecycle.md:26`,
`plugin/scripts/prose-pin.mjs:433-437`) — i.e. "hub jobs"/"hub send"/"hub
wait"/"hub cancel" as this repo uses them are this repo's own shorthand for
whatever the omp session's job/peer surface exposes, not a literal
standalone CLI. `omp://tui.md:104` and `omp://keybindings.md:50` confirm
**Agent Hub** is the *TUI* roster surface (`Alt+A`), not a programmatic API.

The programmatic equivalents, measured directly:

| Read | Scope | Cost | Measured shape |
|---|---|---|---|
| `read proc://` (bare) | **every** registered background job in the session — every `task()`/`agent()`/`workpool()` dispatch and every bash/service job, across ALL sibling sessions sharing the daemon, not just this kernel's own pushes | **1** `read` call, independent of live-member count | `<id> [kind] status[, duration] — <label>` one line per job, e.g. `ResearchR4OmpLiveness.probe-timing [task] completed in 8.0s — …`; running jobs show `running up 3m42s` instead of a duration |
| `read history://` (bare) | full roster incl. `idle`/`parked` members `proc://` omits (a settled member survives here after `proc://`'s row ages out) | **1** `read` call | markdown table: `id \| status \| kind \| parent \| last activity`, measured 26 rows across running/idle/parked members in this session |
| `read proc://<id>` | one already-known job | **1 call per id** — does not discover ids, only inspects a named one | `<id> [task] — running — <label>` or `… completed …`; measured a **transient** `Daemon broker connection closed` immediately after spawn, before the job was fully registered — retried a moment later and it resolved `running` cleanly, so treat the first read after spawn as possibly-racy, not as proof the mechanism doesn't cover in-flight task jobs |
| `pool.status()` (`eval`, in-process) | only members dispatched through **that one** `workpool()` object held in this kernel | **0** extra tool round-trips (an in-process attribute read) | see §(b) — `{queued, running, completed, failed, cancelled}` plus a per-worker `agents[]` array |
| `agent()` handle `.status` | one member this kernel itself spawned | **0** extra tool round-trips | `"running"` / `"completed"` |

**Answer:** yes — `fleet-tick.mjs --implementers/--reviewers/--merge-bots`
*could* derive its counts instead of being told them, via **one** bare
`read proc://` (or `read history://` for a broader idle/parked view), then a
client-side regex filter on the `id` column for `impl-*`/`fix-pr-*`/
`finisher-pr-*`/`merge-bot-*`. That is strictly cheaper than the pool path
for a census across *all* roles at once (one read, not one pool per role),
and it is the only path of the two that sees members dispatched **outside**
a pool (direct `agent()` calls, or another session's dispatches) — which
matters because `fleet-tick.mjs:151-160` (`impliedLive`) already has to
account for exactly that blind spot in the pool-only path (issue #1692,
cited at `fleet-tick.mjs:157-159`). `pool.status()` remains the right choice
only when the caller already holds that specific pool's handle and wants
zero tool-call overhead; it cannot answer "how many `impl-*` are live"
session-wide.

Probe transcript: `agent://ResearchR4OmpLiveness.probe-agent-handle`,
`agent://ResearchR4OmpLiveness.probe-timing`; bare reads reproduced in
`probe-liveness.py` in this directory.

## (b) Workpool where push == dispatch (one item per Pull)

Measured live with `probe-liveness.py`'s `probe_b_lifecycle()`, `agent="task"`,
in a session where `eval.workpool.freshAgents` is effectively `true`
(see §(c)).

1. **`.status()` while in flight, queue empty** (single item, right after
   `push`):
   ```json
   {"name": "probe-pull-1", "agent": "task", "limit": 32, "closed": false,
    "freshAgents": true,
    "agents": [{"id": "…-probe-pull-1-1", "state": "running", "queued": 0,
                "turns": 0, "current": "…-probe-pull-1-1-b1"}],
    "items": {"queued": 0, "running": 1, "completed": 0, "failed": 0, "cancelled": 0},
    "batches": 1}
   ```
   `queued` stays 0 because `limit` (32, from `task.maxConcurrency`,
   `omp://tools/task.md`) is nowhere near saturated by one item — queueing
   only shows up once concurrent items exceed the pool's `limit`.

2. **Does the pool close on first full drain?** Yes, and the drain
   condition is precise: **`items.running + items.queued` reaching 0**, not
   "the first item finishes." Pushing a second item *before* the first
   settles (measured: item #2 pushed 2s after item #1, while item #1 was
   still `running`) keeps the pool open (`closed: false`, `batches: 2`) —
   both items are tracked together and the pool closes **once, when both
   have settled**:
   ```json
   {"closed": true, "agents": [],
    "items": {"queued": 0, "running": 0, "completed": 2, "failed": 0, "cancelled": 0},
    "batches": 2}
   ```
   A single combined background-job notice delivers both results
   ("Pool `probe-pull-3` completed (2 item(s), 2 batch(es))."), confirming
   `eval.md`'s "the aggregate result auto-delivers once, while internal
   batch jobs are consumed." **Consequence for push-per-Pull:** a pool
   opened for a Pull does **not** have to close between every single Pull —
   it stays open across consecutive Pulls as long as a next Pull's `push()`
   lands before the pool ever observes zero live+queued simultaneously. It
   only self-closes at the moment implementer slots all go simultaneously
   idle, and that moment is exactly when a fresh pool would be needed
   anyway under `merge-bot-<n>`-style monotonic naming.

3. **Can a new pool open under a new name immediately?** Yes, measured —
   `workpool(agent="task", name="probe-pull-2")` succeeded with no delay
   the instant `probe-pull-1` had closed; no preflight call is enforced by
   the `workpool()` primitive itself (the preflight discipline is a
   controller-side policy, see below, not a runtime gate).

4. **Can a pool be reopened under the *same* name after it closed?** No —
   measured: `workpool(agent="task", name="probe-pull-1")` a second time,
   after the first had fully drained and closed, raised
   `RuntimeError: workpool "probe-pull-1" already exists`. A closed pool's
   name is retired for the life of the process, not recycled
   (`omp://tools/eval.md`: "Pools are process-local"). Pushing to an
   already-closed pool handle likewise raises
   `RuntimeError: workpool <name> is closed`. **Consequence:** a
   monotonic per-run name counter (`merge-bot-<n>`-shaped) is still
   required for pools under Pull — a name cannot be reused even once the
   pool it named has fully drained.

5. **`pool-preflight.mjs` requirement** (`plugin/scripts/pool-preflight.mjs`):
   reads the **effective** `eval.workpool.freshAgents` setting via
   `omp config get eval.workpool.freshAgents --json` (merged across 5
   config layers — built-in default, global config, project
   `.omp/config.yml`, `--config` overlays, runtime overrides;
   `pool-preflight.mjs:20-32`), and refuses (exit 2) unless that value is
   **exactly `true`** (`pool-preflight.mjs:47,63,199-211`). It never writes
   — flipping the key is deliberately left to the operator, install-time,
   globally (`pool-preflight.mjs:34-39`, echoed at `SKILL.md:1135-1137`),
   because the key governs every pool in the session, not just the
   caller's. Measured in this research session: the *effective* value is
   already `true` — i.e. this environment is pre-configured for the
   fresh-agent path, unlike the schema's own documented default of `false`
   (`pool-preflight.mjs:14`, `omp://settings.md`).

## (c) Does `eval.workpool.freshAgents: true` change any of (b)?

Measured, not inferred: this session runs with the effective setting at
`true`, and the behaviour observed IS the fresh-agent path — every pushed
item got a brand-new agent id (`…-probe-pull-1-1`, `…-probe-pull-2-1`,
`…-probe-pull-3-1`, `…-probe-pull-3-2`), never a shared/reused worker id,
matching `omp://tools/eval.md`'s "`eval.workpool.freshAgents=true` instead
queues for a fresh worker whenever capacity frees, so every item gets a new,
empty context and no follow-up batching occurs."

What I could **not** measure without violating the repo's own rule (never
set this key — it's global operator config, `pool-preflight.mjs:34-39`) is
the `false` branch. Per docs (`eval.md`, `pool-preflight.mjs:1-9`), the
difference only surfaces when the pool is **at its concurrency limit** and a
new item must wait: `false` hands the new item to a reused/busy worker
round-robin at that worker's next turn boundary — a **Wake**, which drags in
that worker's prior context; `true` always spins a genuinely fresh agent
instead. Under push-per-Pull, `limit` is set to the implementer cap and a
Pull only ever pushes when a slot is free (never oversubscribed by design),
so the pool is essentially never *at* its limit when a Pull fires — meaning
`false` vs `true` mostly can't diverge in the steady state this design
targets. `pool-preflight.mjs` exists precisely to guarantee that "mostly"
never becomes "sometimes silently": it refuses to open a pool at all unless
`freshAgents` reads `true`, closing the one gap (a stale/misconfigured
layer) where the divergence could occur unnoticed. Nothing in (b)'s other
findings (close-on-full-drain, per-name retirement, immediate new-name
open) depends on this setting; those are structural to `workpool()` itself.

## Recommendation for G5

`fleet-tick.mjs`'s `poolLiveness: {live, queued}` contract
(`fleet-tick.mjs:104-126`, `SKILL.md:1153-1156`) maps directly onto
`pool.status()`'s measured shape: `live = status().items.running`,
`queued = status().items.queued`. That mapping keeps working under Pull
**as long as the same pool object stays open across consecutive Pulls**
(true whenever implementer slots don't all go idle simultaneously) — the
controller does not need a fresh pool per Pull, only a fresh pool the next
time it observes `closed: true`, at which point it also needs the next
`merge-bot-<n>`-shaped monotonic name and a fresh `pool-preflight.mjs`
check. If G5 instead ends up favoring direct `agent()` per Pull (no pool),
§(a)'s bare `read proc://` gives an equally cheap, pool-independent
liveness census that also sees non-pool dispatches — the two options are
not equally *costly*, but neither is liveness-blind; the deciding factor is
G5's own question (does keeping a workpool's reuse/never-Wake guarantee
matter enough to carry the preflight-and-monotonic-naming machinery, or
does a bare `proc://` read plus direct `agent()` calls replace it more
simply). This research answers the cost/lifecycle facts G5 needs; it does
not decide between the two — that's G5's call, per the plan.

## Caveats

- The transient `Daemon broker connection closed` on the very first
  `proc://<id>` read right after spawn (§a) was reproduced once and not
  systematically retried across many spawns; it may be a registration race
  specific to this environment rather than a documented guarantee. Treat a
  read immediately after spawn as possibly needing one retry.
- §(c)'s `false` branch is cited from documentation only (`eval.md`,
  `pool-preflight.mjs`'s own header), not independently measured, because
  flipping `eval.workpool.freshAgents` is explicitly operator-only global
  config per this repo's own rule — measuring it live would have required
  breaking that rule for every other pool in this shared session.
- `read proc://` and `read history://`'s row counts were measured at
  session-scoped sizes (7 and 26 rows respectively) in a lightly-loaded
  research session, not at fleet-scale (dozens of implementers/reviewers
  live at once); nothing in the observed behaviour suggests these reads
  don't scale, but the exact cost curve at high member counts is untested.
- I did not push enough concurrent items to exceed a pool's `limit` (32,
  from `task.maxConcurrency`) to observe `items.queued > 0` directly; that
  branch is cited from `omp://tools/eval.md`'s prose
  ("queued round-robin onto a busy worker … as one batch when that worker's
  turn ends") rather than measured, since reproducing it would have cost
  32+ real agent spawns for no incremental fact G5 needs (push-per-Pull by
  construction never pushes past the free-slot count).
- I could not find a documented "hub" CLI or tool distinct from the
  `read proc://` / `read history://` / `write agent://<id>` / `wait()`
  surface measured here; if a separate `hub` tool exists in some other
  session context (e.g. the top-level coding-agent chat surface, as opposed
  to this `eval` kernel), I did not have access to probe it directly and
  am relying on this repo's own prose plus `omp://` docs to conclude it's
  vocabulary for the same underlying primitives.
