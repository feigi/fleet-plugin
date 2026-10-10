# 0025 — Nothing restarts a dead run; the next run's phase 0 resumes it

**Status:** Accepted. Ruled 2026-10-09 by the maintainer in a grilling session on
#1724 (stage 2b of #357), against the measurements below. Amends ADR 0008
(Failure mode, which left restart open, and §8, which gains a key owner).
Amended by #2967: the record Decision 3 names also carries `at`, the time
rotate wrote it. Decision 5's "a run's first tick" has no other marker in the
state file, so a reader takes a mark older than `at` as the previous run's and
reads `prior`, and a mark written since as the recorded controller's own and
judges the record.

## Context

ADR 0008 ruled out an out-of-band scheduler for the *live* run's heartbeat and
left one question open: only something outside the session can restart a dead
one. #1597 shipped the detection half — the Liveness mark (`beat`) and the
Stall report — and filed the restart half as #1724 with three directions:
nothing restarts a run, a dying controller hands off to a successor, or an
out-of-band starter launches one.

Measured before ruling (omp 18.8.5, Node 26, macOS):

- **Nothing outside the session can start a run.** omp offers `-p/--print`,
  `--mode json|rpc`, `--resume` and `acp`; none is a resident supervisor, so a
  starter needs a process of its own that outlives the session. Under `-p`,
  `/skill:…` arrives as literal text with no skill body expanded, also with
  `--plugin-dir plugin`. run-team is `disable-model-invocation: true` and
  invoke-only.
- **The deaths a successor would cover do not need one.** A budget stop's
  successor spends the budget again. At the context ceiling omp compacts
  rather than dying: one controller session ran 24 h through two compactions.
  `/exit` and Ctrl+C are deliberate. omp's `session_shutdown` extension event
  fires on Ctrl+C, `/exit`, SIGINT/TERM/HUP and uncaught exceptions with a 2 s
  cap, and never on SIGKILL or OOM — too short to hand off, and absent for the
  deaths that matter.
- **The beat cannot prove death.** Controller pid 29405 was alive and
  dispatching while its mark read `stale`: `beat.at` was four days old, the
  session had made no `fleet-heartbeat` call, and `ticked.at` was sixteen
  hours old. `fleet-tick.mjs` records `ticked` only after its refusals, so a
  refused tick leaves no trace. The cause was controller discipline, not
  persistence.
- **Something already acts on that verdict.** Phase 0's `ledger.mjs rotate`
  refuses only while the mark is `beating`, so a second run in that checkout
  would have rotated pid 29405's live ledger away.
- **A dead run's open PRs come back; its claims without a PR do not.** Phase
  0's fold-in queues every open PR a prior run left, and a merge drops
  `in-progress`. A Claim's worktree and label exist before its first push, and
  rotation carries no rows forward, the candidate scan excludes `in-progress`,
  and `inflight.sh` treats a worktree or remote branch as taken — so such a
  claim is held by nobody, forever. The runbook's promise that a killed
  member's ticket comes back as "new member, new name, the SAME ticket"
  holds within a run (the Member-killed row and its transcript-mtime check),
  not across runs.
- **A process-liveness predicate exists.** `proc.mjs` `isDead(pid)`, shared
  by the ledger lock and the controller record — `process.kill(pid, 0)`, only
  ESRCH is dead. The lock accepts that a reused pid reads live until a 10 s
  timeout.
- **Only the process tree names the controller.** A script runs as omp →
  `fleet-run` (node, `spawnSync`) → script, with no shell between: omp's bash
  tool runs inside omp's own process, so `$PPID` there is omp's parent, the
  login shell. omp's process name is `bun`; only its arguments
  (`bun …/.bun/bin/omp`) name it. omp exports no pid variable (`OMPCODE=1` and
  `AGENT=1` only). Two omp processes were live in one checkout at once. A
  member's processes are children of the controller's omp process. Measured
  for a bun-installed omp only.

## Decision

1. **Nothing restarts a dead run; the maintainer starts the next one.** A
   successor handoff and an out-of-band starter are rejected, not deferred,
   while fleet-ctl ships as an omp plugin. They reopen only if fleet-ctl ships
   a supervisor process outside omp. There is no separate resume entry point:
   `/skill:run-team`'s phase 0 is the resume path.
2. **One controller per checkout.** Runs in other checkouts or on other
   machines are out of scope; nothing here detects or arbitrates them.
3. **A controller record proves death; the Liveness mark only reports.**
   Phase 0's rotation step owns `controller {pid, lstart, prior}` in
   `.fleet/heartbeat.json`. It judges the record it finds **once**, before
   writing anything — `dead`, `ancestor`, `none`, or alive (Decision 4
   refuses that) — and as its last act, whether or not there was a ledger to
   rotate, replaces the record with this run's: `pid` is the nearest ancestor
   of the writing script, at any depth, whose program or first argument has
   the file name `omp`; `lstart` is that process's start time; `prior` is the
   verdict it judged. No environment variable or `$PPID` is a source. With no
   such ancestor it **removes** the key, so an older run's record never
   outlives the run that should have replaced it. A recorded controller is
   **dead** when the shared `isDead` predicate says so or its start time no
   longer matches; the start time closes the pid-reuse gap the ledger lock
   tolerates, because a lock lives seconds and this record lives days.
4. **Where a record exists, only it gates an action.**
   - *Rotation* refuses while the recorded controller is alive, its start
     time matches, and it is not an ancestor of the caller, whatever the
     mark says — so the same session's next run rotates, and another
     session's live run is never rotated away.
   - *Stranded claims:* the step after rotation reads `prior`, never the new
     record's own pid, which is always this run's live ancestor. On `dead`,
     phase 0 lists every `in-progress` ticket with no open PR and resumes
     each under the in-run Member-killed rule — a new member with a new name,
     the same ticket, the existing worktree and branch, and the inherited
     state in its prompt. A worktree outside this checkout is reported, not
     resumed.
   - On `ancestor` (the same session's earlier run) its claims are left
     alone: their members may still be live, and the Member-killed
     transcript-mtime check covers them.
   - While a record exists, the Liveness mark's verdict (`assessBeat`)
     decides nothing; it feeds the Stall report alone. With no record,
     rotation keeps the mark-based check (Decision 6).
5. **The Stall report names which kind of stall it sees.** Alive with a
   matching start time: not beating, controller alive (pid N). Dead or
   mismatched: stalled, controller gone; the next run resumes its claims.
   No record: today's wording. The report a run's first tick prints is the
   previous run's stall, and by then rotation has replaced the record with
   this run's own live one, so that report reads `prior`, never the record
   itself: `dead` is stalled, controller gone, and this run resumes its
   claims; `ancestor` is controller alive; `none` is today's wording. Later
   ticks read the record.
6. **No record proves nothing.** On the first run after this ships, or when
   the last run found no omp ancestor, rotation keeps the mark-based check
   and judges `none`; a step that finds no record at all — this run found no
   ancestor — reads it as `none` too. On `none` the stranded-claim step
   reports and resumes nothing, and the Stall report keeps today's wording.

## Consequences

- ADR 0008 §8 gains an owner: the rotation step owns `controller`, and no
  other script writes it. `fleet-heartbeat` keeps `beat`, `fleet-tick` keeps
  `quiet` and `digest`. If run state moves to another store, the key moves
  with it under the same single-writer rule.
- A controller killed between its rotation and its record write leaves the
  record it found in place; the next run judges that one again, finds it
  dead, and resumes what both runs stranded.
- A controller session resumed with `omp --resume` is a new omp process, so
  its pid is not the one the record names. Its run begins at phase 0 like any
  other (Decision 1), which judges the old record `dead` and replaces it. A
  resumed session that carries on its loop without phase 0 leaves the record
  naming a dead process, and another session's run would judge it `dead` and
  resume claims whose members are still live; the record-only rule no longer
  has the mark's protection for such a session.
- An omp installed some other way than bun (npm global, a compiled binary)
  may not match the ancestor rule; it then degrades to Decision 6 rather than
  misidentifying a controller. Unmeasured.
- Tests run under `node --test` inside a live omp session would find that
  session's omp as an ancestor, so the ancestor source must be replaceable in
  tests.
- A live controller that stops ticking is now reported as alive rather than
  dead; the discipline that keeps it ticking, the refused tick that records no
  `ticked`, and the drains that never record `--stop` are a separate fix.
- Left out: arbitration between concurrent controllers, restart of members
  inside a live run (the Member-killed rule stands), and the storage of run
  state.
