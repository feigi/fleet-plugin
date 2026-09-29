# Controller

## What it is for

The `run-team` controller is the orchestrator: a single, long-running
session — never a dispatched subagent — that owns the main checkout and
drives every other role over one repo's `ready-for-agent` queue until it
drains. Invoked as `/fleet-ctl:run-team [implementers] [reviewers]`
(defaults 2 and 6, no hard cap; the merge bot is always at most 1).
Follows [`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md).

## How it works
1. **Start (phase 0).** Fast-forward against `origin/main`, pin
   [Instruments](instruments.md), check the merge gate spec against the
   live gate, launch the cockpit
   ([Ledger & Cockpit](ledger-and-cockpit.md)), build the
   [Shortlist](supply-and-shortlist.md).
2. **React to every wake** — a report, a label change, a CI run ending,
   or the [heartbeat](reaping-and-liveness.md)'s level-check — with one
   `fleet-tick.mjs` call: it reconciles `.fleet/ledger.md` and prints
   one action per role — `PULL #N`, `REFRESHED`, `DISPATCH review`/
   `DISPATCH fix-pr`/`DISPATCH merge-bot`, or a `HOLD` (draining, tier
   mismatch, review saturated) that outranks every row.
3. **Dispatch exactly what the tick printed:**
   [Pull & Claim](pull-and-claim.md) for admission,
   [Implementer](implementer.md) to build a ticket,
   [Reviewer](reviewer.md) to review it,
   [Merge bot](merge-bot.md) to merge it.
4. **The Finisher is the one exception** — never a tick-printed row. The
   controller dispatches it directly once CI is green, the review has
   returned, and its fix-applier (if any) has reported — see
   [Finisher](finisher.md).
5. **Phase 1 (Pull) is strictly serial**; everything else may run
   concurrently, bounded by the implementer/reviewer caps.

## Opinionated choices

- **No batching, no maintainer multi-select.** The controller reacts to
  a level condition (a slot is free, the Shortlist is short) rather
  than blocking its turn on a staged batch — the pre-cutover model left
  implementer slots idle 87–91% of wall time (ADR 0012,
  [`docs/adr/`](../adr/),
  [`docs/specs/2026-09-24-slot-based-fleet-loop-design.md`](../specs/2026-09-24-slot-based-fleet-loop-design.md)).
- **Instruments are re-read, never trusted stale.** The controller reads
  the scripts and runbooks that decide every gate out of the same main
  checkout any member can write to, and re-checks them before acting —
  a modified instrument still returns a verdict, just not necessarily
  the right one (see [Instruments](instruments.md)).
- **A report is consumed, not assumed.** A member's silence is never
  read as assent; a report is a delivered message the controller must
  consume, never an obligation discharged just by ending a turn.
