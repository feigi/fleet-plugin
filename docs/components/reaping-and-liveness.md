# Reaping & Liveness

## What it is for

Two related but distinct disciplines that keep the fleet's bookkeeping
honest as claims end and time passes: **reaping** cleans up branches and
worktrees after a claim's life ends, and **liveness** is how the
controller — and any reader — knows the run itself is still alive when
nothing else is left to report.

## How it works

A merge deletes a PR's remote branch and leaves the local branch `[gone]`
with its worktree — and `node_modules` — still on disk; a stale worktree
still answers `inflight.sh`, so an unswept merge silently narrows what
the Shortlist can still admit. [`reap.sh`](../../plugin/scripts/reap.sh),
run after **every** merge pass (never per-claim), recomputes `git branch -v` for
`[gone]` upstreams, confirms each via `git cherry origin/main`
(authorizing `-D`, never `-d`), and sweeps orphaned worktree directories
the same pass. [`release-ticket.sh`](../../plugin/scripts/release-ticket.sh)
is its inverse for a claim that never became a PR — a collision found
mid-run, an operator abort — checking four preconditions (0 commits ahead
of `origin/main`, no unique cherry-picked commits, no branch pushed, a
clean worktree) before removing the worktree and branch and recording one
of the **Release outcome** states: `Unreleased` (default, nothing
attempted), `Deregistered` (git's registration cleared, directory still
on disk), `Released` (both gone, full success), `Partially released` (at
least one artefact removed before a later step refused), or
`Indeterminate` (the probe itself couldn't measure, never asserted for a
healthy claim). Separately,
[`fleet-heartbeat.mjs`](../../plugin/scripts/fleet-heartbeat.mjs) is the
one trigger that survives a fully drained Shortlist: every other tick
invocation is a *wake* (a member report, a label, a CI run ending), and a
drained fleet emits none of those, so the heartbeat holds the
controller's turn for a backing-off interval (base 300s, doubling to a
1200s ceiling while nothing happens) and then tells it to run the tick
anyway. Each beat writes a **Liveness mark** — when it was last seen and
the interval in effect then — to the shared heartbeat state file; a
reader comparing that mark's age against its own interval produces a
**Stall report**: naming how many tickets are still claimed and in
flight, and whether the pool still has supply. Detection only — a stall
report neither releases the stranded claims nor restarts anything.

## Opinionated choices

A hold-and-reissue heartbeat, never a backgrounded watcher: a
backgrounded watcher does not wake an idle agent, measured twice in one
run when a member backgrounded its test suite and a Monitor and sat idle
for two hours because nothing in the harness ever woke it — so the
heartbeat blocks the controller's own turn instead
([ADR 0008](../adr/0008-a-turn-based-fleet-holds-its-own-turn.md)). The
backoff ceiling is a bounded worst-case, not a tuning knob: 20 minutes is
what a quiet night costs in noticing work that arrives from *outside*
the fleet — a maintainer triaging a ticket, a reviewer filing a
correction — with no event the controller could otherwise observe. Reap
and release are two different scripts on purpose: reap authorizes a
destructive `-D` off git's own evidence (a gone upstream plus a
cherry-confirmed merge) at fleet-wide, post-merge cadence, while release
authorizes the same kind of deletion off a *specific claim's*
preconditions at a different trigger (drain, abort) — conflating them was
measured to let one silently borrow the other's authorization.
