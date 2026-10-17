# 0030 — The host-wide suite bound lives in the runner-writers, not in the Recipe

**Status:** Accepted. Ruled 2026-10-12 by the maintainer in a grilling session
on #2321, split from #2315 (which runs the test command once per review),
against `main` at `704fd002`.

## Context

Nothing bounded how many full test-suite runs one host executed at once.
`--implementer-cap` and `--reviewer-cap` count members, not suite runs, and
every member runs the full suite whenever its flow needs it. The field
observation that motivated this (#2315, 2026-10-01, darwin 25.4 arm64, 48 GB)
was about fourteen concurrent full runs, unified-log volume up about 75-fold
and then a kernel panic; nothing proves the test load caused the panic. Each
`node --test` already spawns one worker per core less one, so the load is the
number of concurrent runs, whatever the core count.

The first idea was to wrap the command where it is handed out, at
`derive-testcmd.sh`. That cannot hold, for two reasons that shape the whole
decision:

- `recipe-prove.mjs` reads the cache back through `derive-testcmd.sh` and
  requires the printed Test entrypoint to equal the Recipe's `test` byte for
  byte (ADR 0015's read-back). A wrapped string printed there fails the proof.
- A repository that tracks its own `agent-test` runs that file and never reads
  the printed entrypoint, so this repository's own implementers would stay
  unbound.

And the bound cannot live in a workspace's `.fleet/`: a review's snapshot is a
`git archive` tree, not a repository (`review-and-fix.md`, on initialising the
copy), so nothing anchored at the workspace is reachable from the review's run.

## Decision

1. **The mechanism is `plugin/scripts/suite-slot.mjs`**, reached through the
   Resolver: `~/.fleet/bin/fleet-run suite-slot.mjs '<entrypoint>' [args…]`. It
   runs the entrypoint under `sh -c` with the arguments after it, argv
   preserved. Slots are `~/.fleet/suite-slots/<i>.lock`, pid-stamped, created
   `O_EXCL`; a waiter cycles them every 2 s. The lock primitive is the
   ledger's, extracted into `pid-lock.mjs` and imported by both, not copied.
2. **The bound is 2, fixed, not core-scaled**, overridable by
   `FLEET_SUITE_SLOTS`. Oversubscription is about that bound whatever the core
   count. Reviewable once `slotWaitMs` has field data.
3. **It lives in the command-writers the plugin owns, plus this repository's
   runner.** `claim-ticket.sh`'s emitted runner execs the wrapper; the review's
   test-run block wraps its command; the controller hands the fix-applier and
   the finisher the wrapped string as `<testCmd>`; this repository's tracked
   `agent-test` takes a slot itself for a bare run. `derive-testcmd.sh`, the
   Recipe cache and `recipe-prove.mjs` are untouched, so ADR 0015 and the
   read-back equality hold. A repository that tracks its own runner wraps it
   itself.
4. **Re-entrant.** The holder exports `FLEET_SUITE_SLOT=<lock path>` to its
   child, and a wrapper that sees it runs straight through: a controller-wrapped
   `<testCmd>` inside the review's own wrap is a no-op, not a deadlock.
5. **Full runs only, decided by arity.** No appended arguments is the full
   suite and takes a slot. Appended arguments are a narrowed run and pass
   through, so a verifier's narrowed run never queues behind a full one; its
   fall-back to the full command is gated. `recipe-prove.mjs`'s phase-0 proof
   run is ungated, and the merge bot runs no suite.
6. **Stale locks: dead-holder takeover by pid**, under the ledger's `.reap`
   discipline. The ledger's permanent-wedge shapes — a leftover `.reap`, an
   empty or unparseable `.lock`, and the transient zombie holder — apply
   unchanged, and the runbook names `~/.fleet/suite-slots/` beside
   `ledger.lock`.
7. **The wait is capped and never counts against the run.** The wrapper waits
   up to `FLEET_SUITE_WAIT_S` (default 1800) and then exits **75** with
   `suite-slot: no slot after <n>s`, having launched nothing. On acquisition it
   prints `SUITE_SLOT_WAIT_MS=<n>` to stderr. The review's block deadline is
   3600 — the wait cap plus the run's own 1800 — because one omp command
   deadline is clamped at 3600 s, so wait and run inside a single command cannot
   exceed it. `TEST_RUN_SCHEMA` gains an optional `slotWaitMs`.
8. **A review that exits 75 has an unusable suite verdict, with no retry.**
   `testRunReason` has a distinct branch — no suite slot within the wait, the
   host at its bound, not a test failure — so the review's `suiteVerdict` is
   not usable for that reason, and the controller re-reviews through the next
   runner letter. The test-run agent
   keeps "never a second time". Implementers, fix-appliers and finishers are
   told in one line that exit 75 is not a test result and to run the command
   again.

## Consequences

- A holder SIGKILLed while its test run continues frees its slot to the next
  waiter while that run is still going, so the bound can be exceeded for the
  length of one orphaned run. Accepted: the takeover is by pid, as the ledger's
  is.
- `FLEET_SUITE_SLOT` is inherited by everything the holder runs, so a suite
  that itself tests the wrapper must clear it from its children's environment.
- Rejected: wrapping at the `derive-testcmd.sh` hand-out (the read-back
  equality, and a tracked runner that never reads it); scaling the bound with
  the core count (each run already scales with it).
- `--implementer-cap` and `--reviewer-cap` keep counting members.
