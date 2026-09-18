# 0008 — A turn-based fleet holds its own turn; nothing external wakes it

**Status:** Accepted. Ruled 2026-09-18 on #357 (item 2 of #3), against the measurements below.

## Context

`fleet-tick.mjs` computes the fleet's deficit correctly and was wired to two
**merge-side edges** (#336, items 1 and 3 of #3). Item 2 — a periodic resync
heartbeat — never shipped, and #3's root cause is that an edge-triggered loop
cannot observe a level that has stopped changing. The uncovered state is the one
#3 was filed about: a fully drained queue emitting no events at all, where
nothing invokes the reconcile and the stall is silent again.

The open question was never the arithmetic. It was the **execution model**: the
fleet's members are turn-based and cannot hold a wait, so a "persistent
time-based tick" had no obvious owner. Three candidates were on the table — a
Monitor-style watcher, a scheduled invocation (cron/launchd), or an obligation
written into the controller's phase-3 prose — and each fails differently.

Measured before ruling:

- **An external scheduler cannot run the reconcile at all.** `fleet-tick.mjs`
  requires six controller-stated counts and refuses at exit 2 rather than
  defaulting any of them, because "the ledger records a dispatch, never a
  liveness, so nothing in the repo can be read for them"
  (`plugin/scripts/fleet-tick.mjs`, `LIVE_WHY`). A cron entry holds none of that
  state. The most an out-of-band mechanism could do is **wake** the controller.
- **A backgrounded watcher does not wake an idle agent.** Measured twice in one
  run: `fix-pr-1184` backgrounded its test suite plus a Monitor and sat idle for
  roughly two hours; neither ever woke it, and no work was lost only because the
  maintainer pinged it by name (`skills/run-team/SKILL.md`, "A member runs its
  test suite in the foreground"). `run-merge-bot.md`'s CI gate states the
  general rule: *"whatever wakes you is external and may never come."*
- **Prose alone has already failed twice.** `docs/specs/2026-07-23-fleet-plugin-design.md`:
  *"A JS loop holds across turns, so the wait has a mechanism rather than an
  instruction. The turn-based stall has already been patched twice with more
  prose."* The accepted cure was a blocking primitive held inside one turn —
  `gh run watch <run-id> --exit-status` — with an explicit re-issue rule when it
  outlives the shell timeout.
- **Neither harness has a periodic hook.** Claude Code's hook events are all
  edge-triggered off a user or agent action (`~/.claude/settings.json`); omp's
  extension timers (`ctx.setInterval`) are session-bound and cleared on
  `session_shutdown` (`omp://extensions.md`). Neither documents an entry point
  by which an external process injects a turn into an idle agent.
- **The harnesses differ in how long one command may block, and this is the one
  asymmetry the design must absorb.** Measured 2026-09-18 on omp: a foreground
  `sleep 55` held the turn (55.00 s wall, returned in-foreground), while
  anything past the 60 s `bash.autoBackground.thresholdMs` converts to a
  background job; `timeout` sets the deadline without extending foreground
  waiting. Claude Code instead kills at its shell timeout, which
  `run-merge-bot.md` already records as shorter than a ~5-6 minute CI cycle.
- **Background-job completion does inject a turn on omp** — observed twice in
  one session, each time while the agent sat idle awaiting user input with no
  keystroke intervening. This is *not* generalised: the two-hour no-wake
  measurement above was a **member** (subagent) on **Claude Code**, and these
  were the **main agent** on **omp**. Two variables differ; neither result
  settles the other, and the design deliberately does not depend on either.
- **Operating target is unattended/overnight** (maintainer's ruling). The
  ledger records a 9-hour intra-session gap, and run wall-clock of 58 min to
  3.5 h.

## Decision

1. **The controller holds its own turn. No out-of-band scheduler, no background
   watcher.** `fleet-heartbeat.mjs` blocks for an interval and prints one line;
   the controller then restates its counts and runs `fleet-tick.mjs` itself.
   This is `gh run watch`'s shape with `sleep` in its place.
2. **The heartbeat takes no fleet state and never reports any.** Every flag has
   a default. A monitor event is a wake-up, never a verdict: counts captured
   before a twenty-minute hold and fed to a tick firing after it are a stale
   verdict, and a stale verdict prints an ACTION nobody can take. It also makes
   a late-firing hold harmless — a free extra tick, never a decision.
3. **A long interval is served by several holds, and the remainder is persisted,
   not counted in prose.** `--hold` (default 240 s) bounds one call under both
   harnesses' ceilings; the partial line says how much remains and instructs the
   controller to re-issue *without ending its turn*. On omp a hold past 60 s
   becomes a background job whose completion also wakes the controller — the
   same instruction works under both mechanics, by design rather than by luck.
4. **Exponential back-off: base 300 s, ×2, ceiling 1200 s**, reset to base on
   any tick that asks for anything. A quiet eight hours costs ~26 wakes instead
   of ~96.
5. **The ceiling is a bound on blindness, not a comfort setting.** Supply grows
   from outside the fleet — a triaged ticket, a reviewer's correction ticket —
   and that arrival emits no event, so the ceiling *is* the worst-case latency
   for noticing it. Do not raise it past 30 minutes: past that this design
   becomes #3 at a slower rate.
6. **Back off on "nothing to act on", never on "output unchanged".** A tick
   printing `DISPATCH 1` every interval because the controller has not acted is
   byte-identical each time; backing off there would stretch the interval while
   work sat in the pool. Output identity decides only whether to *fold* the
   printing (`--fold-unchanged`); `actionable()` alone decides the back-off.
   `SUGGEST /triage` is deliberately not actionable — it asks a maintainer, and
   on an unattended night there is nobody to ask.
7. **The beat does not stop on idleness.** An empty pool and empty supply are
   the state a newly triaged ticket arrives into. The run ends on maintainer
   drain, budget, or context exhaustion.
8. **One state file, one writer per key.** `.fleet/heartbeat.json`, resolved
   against the git common dir like `ledger.mjs`'s ledger: `fleet-tick` owns
   `quiet` and `digest`, `fleet-heartbeat` owns `elapsed`. A key both wrote
   would need a lock neither is positioned to hold.

## Failure mode

Stated plainly, because the ticket required it: **the wait lives inside a turn,
so it cannot outlive the run.** There is no scheduler to die, no watcher to go
quiet, and no idle-but-alive state for the fleet to be silent in — the two
shapes this repo has already been bitten by. If the controller stops, the run
has stopped, which is observable by definition.

What it does **not** survive is the death of the session itself: context
exhaustion, a crashed harness, or a budget stop. That is stage 2 (#1597), and it
is the one place where an out-of-band mechanism may have to be reconsidered —
only something outside the session can restart a dead one. This ADR rules
against out-of-band scheduling for the *live-run* heartbeat; it does not
pre-judge that question.

Degraded reads all fail toward beating **more** often, never less: a missing or
corrupt state file restarts at the base interval and says so, and a failed state
write is reported and survived. Silence is never a state this script can be in —
it prints one line on every invocation, because a heartbeat that printed nothing
would be indistinguishable from a heartbeat that died, which is the exact
"indistinguishable from a working one" the member-idle measurement names.

## Consequences

- `fleet-tick.mjs` gains a side effect it did not have — it writes the back-off
  streak and the fold digest on every run, including the two merge-side edges.
  An edge tick that dispatched is the clearest possible "there is work here", so
  letting only heartbeat ticks reset the streak would leave a long interval
  armed straight after a busy wave.
- The two shipped edge invocations are unchanged: both new flags default, and a
  folded edge tick is explicitly forbidden.
- `fleet-tick.test.mjs`'s stub-directory harness now copies every sibling module
  the script imports (`SIBLING_MODULES`). An unlisted import is a
  MODULE_NOT_FOUND at startup — exit 1, the same code `candidates.mjs` uses for
  "queue empty", which is why those four tests were the ones that went red.
- The prose pin that asserted the reconcile block "admits it is edge-triggered
  only" now asserts the block names *where* the drained-queue case is handled.
  An admission with nowhere to go is how item 2 of #3 went missing in the first
  place.
