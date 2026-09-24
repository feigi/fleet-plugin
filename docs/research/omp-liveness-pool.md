# omp: liveness reads without a pool, and workpool behaviour under push-per-Pull

Research for `feigi/fleet-plugin` issue #1772, part of wayfinder map #1768
(retiring "wave" from `/fleet-ctl:run-team`). Resolves G5 ("omp implementer
dispatch primitive under per-slot Pull") and G3/G6's need for a liveness
source that doesn't depend on a staging-wave-scoped pool.

All claims below are either **measured** (live probe run in an omp `eval`
kernel on 2026-09-24, transcripts linked inline) or **cited** (file:line in
this repo / `omp://` doc page). Nothing is asserted from memory alone. The
§(a) census counts were re-measured the same day during this PR's review,
from a fleet member's seat in a live `/fleet-ctl:run-team` session.

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
| `read proc://` (bare) | background **jobs**, not agents — `task()`/`agent()`/`workpool()` dispatches plus bash/service jobs, including sibling members' jobs beyond this kernel's own pushes. Not a complete roster: re-measured from a member's seat it omitted two agents `history://` listed as `running` at the same moment (`Main`, and the reading member's own job), and an `idle` agent has no job row at all | **1** `read` call, independent of live-member count | `<id> [kind] status[, duration] — <label>` one line per job, e.g. `ResearchR4OmpLiveness.probe-timing [task] completed in 8.0s — …`; running jobs show `running up 3m42s` instead of a duration; a settled job stays listed as `completed` until its row ages out |
| `read history://` (bare) | full roster incl. `idle`/`parked` members `proc://` omits (a settled member survives here after `proc://`'s row ages out) | **1** `read` call | markdown table: `id \| status \| kind \| parent \| last activity`; measured 26 rows in the first probe, 190 in the mid-run re-measurement (10 `running`, 180 `parked`) — the `status` column is the only thing separating a live member from an hours-stale one |
| `read proc://<id>` | one already-known job | **1 call per id** — does not discover ids, only inspects a named one | `<id> [task] — running — <label>` or `… completed …`; measured a **transient** `Daemon broker connection closed` immediately after spawn, before the job was fully registered — retried a moment later and it resolved `running` cleanly, so treat the first read after spawn as possibly-racy, not as proof the mechanism doesn't cover in-flight task jobs |
| `pool.status()` (`eval`, in-process) | only members dispatched through **that one** `workpool()` object held in this kernel | **0** extra tool round-trips (an in-process attribute read) | see §(b) — `{queued, running, completed, failed, cancelled}` plus a per-worker `agents[]` array |
| `agent()` handle `.status` | one member this kernel itself spawned | **0** extra tool round-trips | `"running"` / `"completed"` |

**Answer: not from one bare read plus an id regex — neither primitive alone
gives a reliable live census.** The first draft of this section said
`fleet-tick.mjs --implementers/--reviewers/--merge-bots` could derive its
counts from one bare `read proc://` (or `read history://`) plus a
client-side regex on the `id` column for `impl-*`/`fix-pr-*`/
`finisher-pr-*`/`merge-bot-*`. Re-measured mid-run
(`probe_a_census_accuracy()` in `probe-liveness.py`; 10 agents `running`,
9 of them fix-appliers), that method miscounts in both directions:

- **`history://` overcounts.** 190 rows — 10 `running`, 180 `parked`. The
  id regex matched 19 of them and only 9 were running: the other 10 were
  `parked` members 3–4h stale (`impl-1712`, `impl-1744`, `fix-pr-1733`,
  `fix-pr-1742`, `fix-pr-1762`, `fix-pr-1762b`, `merge-bot-wave1`,
  `merge-bot-wave2`), plus two dot-qualified *children* of a fix-applier
  (`fix-pr-1733.RefuteDashDash`, `fix-pr-1733.RefuteDiffSwallow`) that a
  `fix-pr-*` prefix counts as fix-appliers in their own right (a
  subagent's children are `<id>.<child>`, `omp://tools/task.md:78`).
- **`proc://` both undercounts and overcounts.** It lists jobs, not agents:
  10 rows, 8 `running` task jobs plus 2 services. It omitted two agents
  `history://` listed as `running` at the same moment — `Main` and the
  reading member's own job (`fix-pr-1783`) — and an `idle` agent has no job
  row at all. Whether the controller's own read omits any member was not
  measured; one omitted running agent is enough to show `proc://` is not a
  roster. In the other direction, a settled job keeps its row as
  `completed` until it ages out, and nested jobs are listed too: this doc's
  own example row, `ResearchR4OmpLiveness.probe-timing [task] completed in
  8.0s`, is both — a settled, dot-qualified job, which an id-only regex
  counts as a live member whenever its id carries a member prefix.
- **The pattern list is short a family.** `SKILL.md:71-72` names
  `review-pr-<pr#>` as a member name alongside the four above; a regex
  without it misses every reviewer dispatched under that name.

Either error lands directly on the tick: the implementer deficit is
`implCap - impliedLive` (`fleet-tick.mjs:164`), so an overcount reads as
AT CAP and stalls refill, and an undercount dispatches past the cap. The
closest candidate is `history://` filtered on its `status` column (`running`
only), with ids anchored to exclude dot-qualified children and the name
family completed with `review-pr-*` — but that reader is not built and was
not checked against a known roster at fleet scale, so nothing here
certifies it as a census. What the bare reads do have over the pool is
reach: they see members dispatched **outside** a pool (direct `agent()`
calls) — the blind spot `fleet-tick.mjs:151-163` (`impliedLive`) already
accounts for in the pool-only path (issue #1692, cited at
`fleet-tick.mjs:157-159`). `pool.status()` stays exact for the members of
the one pool whose handle the caller holds, at zero tool-call overhead; it
cannot answer "how many `impl-*` are live" session-wide.

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
   only shows up once concurrent items exceed the pool's `limit`. That
   `limit` is the session's live `task.maxConcurrency` — a session-wide
   operator setting — and nothing else: `workpool(agent, name, context,
   tools)` takes no limit argument (`omp://tools/eval.md:181`), and the pool
   "knows nothing about the implementer cap" (`SKILL.md:1135-1137`). The
   implementer cap (≤ 5, `fleet-tick.mjs:436-437`) is fleet accounting,
   enforced only by the tick deciding how many items to push
   (`SKILL.md:1138`); the two numbers are independent of each other.

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
   globally (`pool-preflight.mjs:34-39`, echoed at `SKILL.md:1125-1127`),
   because the key governs every pool in the session, not just the
   caller's. Measured in this research session: the *effective* value is
   already `true` — i.e. this environment is pre-configured for the
   fresh-agent path, unlike the schema's own documented default of `false`
   (`pool-preflight.mjs:14`, `omp://settings.md:626`).

## (c) Does `eval.workpool.freshAgents: true` change any of (b)?

**Yes — on every refill, not just at the limit.** The first draft of this
section concluded the opposite (that `false` and `true` diverge only when
the pool is at its concurrency limit, so push-per-Pull "mostly can't
diverge"); every primary source contradicts it.

**What was measured.** This session runs with the effective setting at
`true` (`probe_freshagents_setting()`), and every pushed item got its own
worker id (`…-probe-pull-1-1`, `…-probe-pull-2-1`, `…-probe-pull-3-1`,
`…-probe-pull-3-2`), consistent with `omp://tools/eval.md:183`'s
"`eval.workpool.freshAgents=true` instead queues for a fresh agent whenever
capacity frees, so every item gets a new context and no follow-up batching
occurs." But those four ids do **not** discriminate `true` from `false`: no
probe ever pushed while an idle worker sat in an open pool. Under `false`'s
documented routing the same four ids follow — `probe-pull-1` and
`probe-pull-2` each held one item, and `probe-pull-3`'s second item was
pushed while its first was still `running`, so there was no idle worker to
pick and the pool had room to spawn one.

**What the `false` branch does** — cited, not measured, because the key is
global operator config this repo never sets (`pool-preflight.mjs:34-39`,
`SKILL.md:1125-1127`). All three primary sources state its routing the same
way, and unconditionally:

- `omp://tools/eval.md:183`: an item "goes to the idle worker with the
  lowest context usage, spawns a new worker while the pool has room, or is
  queued round-robin onto a busy worker".
- `pool-preflight.mjs:3-5`: "by default omp routes that item onto the idle
  worker with the lowest context usage and extends that worker's
  transcript."
- `SKILL.md:1120-1123`: "at the schema default of `false` a queued item
  lands on an idle worker and extends that worker's transcript, which is a
  wake".

The idle-worker check comes **first**, before the room-to-spawn check, and
nothing gates it on the pool being full. So the two settings diverge on
**every push that finds an idle keep-alive worker in an open pool**: `false`
extends that worker's transcript — a **Wake**, dragging its previous
ticket's context, worktree paths and claim state into the new item
(`pool-preflight.mjs:5-9`) — while `true` spawns a fresh agent
(`omp://settings.md:626`: "Spawn a new workpool agent for every item instead
of reusing idle workers or batching queued items"). The at-limit branch —
queued round-robin onto a *busy* worker — is a second, rarer divergence, not
the only one.

**Push-per-Pull lands in the first case on essentially every refill.** A
slot frees exactly when a worker finishes its item and goes idle; §(b)2
measured that the pool stays open as long as any other item is still
running; so the Pull that refills the freed slot pushes into an open pool
holding the just-idled worker, and at `false` that push is routed onto it.
The only refill that escapes is the one after every slot drained at once —
the pool has closed, the next Pull opens a new pool with no workers in it
(at an implementer cap of 1, every refill is that one). At any cap above 1
that is the edge case; the Wake is the steady state. (The first draft's
route to "mostly can't diverge" also rested on a wrong premise — that the
pool's `limit` is the implementer cap. It is `task.maxConcurrency`, see
§(b)1; implementer pushes alone, at most the ≤ 5 cap, never approach a
`limit` of 32, which is exactly why the at-limit branch is the rare one.)

**Consequence:** `pool-preflight.mjs` is load-bearing on every refill, not a
guard against a rare edge. The pool's never-Wake property is not a property
of the pool at all — it is the operator's setting, confirmed by the
preflight at every pool open, and a pool opened against a `false` layer
Wakes on its next refill, silently (`pool-preflight.mjs:5-9`,
`SKILL.md:1121-1123`). Nothing in (b)'s other findings (close-on-full-drain,
per-name retirement, immediate new-name open) depends on this setting;
those are structural to `workpool()` itself.

## Recommendation for G5

Re-derived after §(a) and §(c)'s corrections. The first draft framed the
pool as carrying a "reuse/never-Wake guarantee" that was mostly free in
steady state, and a bare `proc://` read as an equally cheap census for the
no-pool path. None of that holds: at `freshAgents: true` — the only setting
a refill may run under — the pool reuses nothing (`omp://settings.md:626`),
at `false` it Wakes on every refill (§(c)), and the bare reads miscount
(§(a)). The facts G5 weighs:

- **Pool path.** Never-Wake is the operator's
  `eval.workpool.freshAgents: true`, which a run may read but never write
  (`SKILL.md:1125-1127`), confirmed by `pool-preflight.mjs` at every pool
  open — skip it once against a `false` layer and the next refill is a
  silent Wake. Liveness is clean: `fleet-tick.mjs`'s
  `poolLiveness: {live, queued}` contract (`fleet-tick.mjs:104-126`,
  `SKILL.md:1141-1144`) maps onto the measured shape as
  `live = status().items.running`, `queued = status().items.queued`, and
  keeps working **as long as the same pool object stays open across
  consecutive Pulls** (§(b)2) — the controller needs a fresh pool only the
  next time it observes `closed: true`, and with it the next
  `merge-bot-<n>`-shaped monotonic name (§(b)4) and a fresh
  `pool-preflight.mjs` pass. What the pool buys is refill semantics and
  shared context stated once (`SKILL.md:1139`, `SKILL.md:1164-1167`) —
  zero throughput, and no Wake protection of its own.
- **Direct `agent()` per Pull (no pool).** Each call registers a new
  subagent (`omp://tools/eval.md:165`) and a child never inherits
  conversation history (`omp://tools/task.md:174`); `freshAgents` governs
  workpools only, so this path cannot Wake whatever the setting reads — no
  preflight, no pool names. Its cost is liveness: no `pool.status()`, and a
  bare `proc://`/`history://` read is **not** a drop-in census (§(a)). What
  it does have is the handles: `agent()` handle `.status` for every member
  this kernel spawned, at zero tool round-trips (§(a) table) — covering the
  members the controller dispatched, and nothing it didn't.

G5's question, restated on the corrected facts: is `pool.status()` liveness
plus refill and shared-context semantics worth a hard, every-refill
dependency on operator configuration, against a path that is never-Wake by
construction but must count its own handles? This research answers the
cost/lifecycle facts G5 needs; it does not decide between the two — that's
G5's call, per the plan.

## Caveats

- The transient `Daemon broker connection closed` on the very first
  `proc://<id>` read right after spawn (§a) was reproduced once and not
  systematically retried across many spawns; it may be a registration race
  specific to this environment rather than a documented guarantee. Treat a
  read immediately after spawn as possibly needing one retry.
- §(c)'s `false` branch is cited from documentation only
  (`omp://tools/eval.md:183`, `pool-preflight.mjs:3-5`,
  `SKILL.md:1120-1123`), not independently measured, because flipping
  `eval.workpool.freshAgents` is explicitly operator-only global config per
  this repo's own rule — measuring it live would have required breaking
  that rule for every other pool in this shared session. Nor does the
  `true`-branch measurement stand in for it (§(c)): a probe that
  discriminates the two must push into an open pool while one of its
  workers is idle — push A and B, let A alone settle, push C — and only
  a `false` session shows the difference.
- `pool-preflight.mjs` reads the setting at pool open only. Whether a
  mid-run change to the key reaches an already-open pool was not measured;
  the pool's `status()` carries its own `freshAgents` field (§(b)1), but
  whether that field is live or a snapshot taken at open was not measured
  either.
- `read proc://` and `read history://`'s row counts: the first probe saw 7
  and 26 rows in a lightly-loaded research session; the §(a)
  re-measurement, mid-run, saw 10 and 190 — 180 of the 190 `parked`.
  Parking disposes a session but keeps its registry entry
  (`omp://tools/task.md:107`), so an unfiltered `history://` grows with
  every member a session has ever dispatched and is dominated by stale rows
  at fleet scale. The read cost at high member counts is untested.
- I did not push enough concurrent items to exceed a pool's `limit` (32,
  from `task.maxConcurrency`) to observe `items.queued > 0` directly; that
  branch is cited from `omp://tools/eval.md:183`'s prose
  ("queued round-robin onto a busy worker and handed over as one batch when
  that worker's turn ends") rather than measured, since reproducing it
  would have cost 32+ real agent spawns for no incremental fact G5 needs:
  push-per-Pull pushes at most the implementer deficit (cap ≤ 5,
  `fleet-tick.mjs:436-437`), far below the pool's `limit`. The divergence
  that matters under Pull is §(c)'s idle-worker case, not this one.
- I could not find a documented "hub" CLI or tool distinct from the
  `read proc://` / `read history://` / `write agent://<id>` / `wait()`
  surface measured here; if a separate `hub` tool exists in some other
  session context (e.g. the top-level coding-agent chat surface, as opposed
  to this `eval` kernel), I did not have access to probe it directly and
  am relying on this repo's own prose plus `omp://` docs to conclude it's
  vocabulary for the same underlying primitives.
