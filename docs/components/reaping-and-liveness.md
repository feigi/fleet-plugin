# Reaping & Liveness

## What it is for

Two disciplines that keep the fleet's bookkeeping honest over time:
**reaping** cleans up branches and worktrees after a claim's life ends,
and **liveness** is how the controller — and any reader — knows the run
itself is still alive when nothing else is left to report.

## How it works
1. **Reap after every merge pass** (never per-claim).
   [`reap.sh`](../../plugin/scripts/reap.sh) recomputes `git branch -v`
   for `[gone]` upstreams, confirms each via `git cherry origin/main`
   (one of several checks that must pass before it deletes the branch
   with a compare-and-swap `git update-ref -d`), and sweeps orphaned
   worktree directories the same pass.
2. **Release a claim that never became a PR** with
   [`release-ticket.sh`](../../plugin/scripts/release-ticket.sh): checks
   four preconditions (0 commits ahead of `origin/main`, no unique
   cherry-picked commits, no branch pushed, a clean worktree) before
   removing the worktree/branch, recording a **Release outcome**:
   `Unreleased` (default), `Deregistered` (registration cleared,
   directory left), `Released` (full success), `Partially released`
   (one artefact removed before a later step refused), or
   `Indeterminate` (the probe itself couldn't measure).
3. **Beat.** [`fleet-heartbeat.mjs`](../../plugin/scripts/fleet-heartbeat.mjs)
   is the one trigger that survives a fully drained Shortlist: it holds
   the controller's turn for a backing-off interval (base 300s,
   doubling to a 1200s ceiling) and then tells it to run the tick
   anyway.
4. **Mark and report.** Each beat writes a **Liveness mark** — when it
   was last seen and the interval then in effect — to the heartbeat
   state file; a reader comparing that age against its own interval
   produces a **Stall report**: how many tickets are claimed and in
   flight, and whether the pool still has supply, led by whose stall it
   is — controller alive, gone, or unknown — off the **Controller
   record** (`controller` in the same state file, written by the ledger
   rotation at phase 0). Detection only.

## Opinionated choices

- **A hold-and-reissue heartbeat, never a backgrounded watcher.** A
  backgrounded watcher does not wake an idle agent, so the heartbeat
  blocks the controller's own turn instead
  ([ADR 0008](../adr/0008-a-turn-based-fleet-holds-its-own-turn.md)).
- **The backoff ceiling is a bounded worst-case, not a tuning knob.**
  20 minutes is what a quiet night costs in noticing work that arrives
  from *outside* the fleet, with no event the controller could
  otherwise observe.
- **Reap and release are two different scripts on purpose.** Reap
  authorizes a destructive `git update-ref -d` off git's own evidence at
  fleet-wide, post-merge cadence; release authorizes deletion off a
  *specific claim's* preconditions at a different trigger (drain, abort) —
  conflating them was measured to let one silently borrow the other's
  authorization.
