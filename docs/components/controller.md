# Controller

## What it is for

The `run-team` controller is the orchestrator: a single, long-running
session — never a dispatched subagent — that owns the main checkout and
drives every other role over one repo's `ready-for-agent` queue until it
drains. It is invoked as `/fleet-ctl:run-team [implementers] [reviewers]`
(defaults 2 and 6, no hard cap; the merge bot is always at most 1) and
follows [`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md).

## How it works

On start (phase 0), the controller fast-forwards its own checkout against
`origin/main`, pins [Instruments](instruments.md), checks the merge gate's
ruleset spec against the live gate, launches the cockpit
([Ledger & Cockpit](ledger-and-cockpit.md)), and builds the
[Shortlist](supply-and-shortlist.md). From there the loop is slot-based,
not phase-based: every wake — a member's report, a label change, a CI run
ending, or the [heartbeat](reaping-and-liveness.md)'s own level-check —
runs one `fleet-tick.mjs` invocation that reconciles `.fleet/ledger.md`
against reality and prints an action per role: `PULL #N` when an
implementer slot is free and the Shortlist has a head, `REFRESHED` when
the Shortlist needed rebuilding, `DISPATCH review`/`DISPATCH
fix-pr`/`DISPATCH merge-bot` when a PR needs one, or a `HOLD` (draining,
tier mismatch, review side saturated) that outranks every other row. The
controller then dispatches exactly what the tick told it to —
[Pull & Claim](pull-and-claim.md) for admission, the
[Implementer](implementer.md) role to build a ticket, the
[Reviewer](reviewer.md) and [Finisher](finisher.md) to land it, the
[Merge bot](merge-bot.md) to merge it — and reacts to the next wake. Phase
1 (Pull) is the one strictly serial step; everything else may run
concurrently, bounded by the implementer/reviewer caps and the merge
bot's cap of 1.

## Opinionated choices

No batching and no maintainer multi-select: the controller's whole job is
reacting to a level condition (a slot is free, the Shortlist is short)
rather than blocking its own turn on a staged batch, which is what a drained
pipeline with idle slots used to look like before the slot-based rewrite
(ADR 0012, [`docs/adr/`](../adr/)),
[`docs/specs/2026-09-24-slot-based-fleet-loop-design.md`](../specs/2026-09-24-slot-based-fleet-loop-design.md)).
The controller reads its own instruments — the scripts and runbooks that
decide every gate — out of the same main checkout any member can write
to, and re-checks them before acting rather than trusting a stale read,
because a modified instrument still returns a verdict, just not
necessarily the right one (see [Instruments](instruments.md)). A member's
silence is never read as assent, and a report is a delivered message the
controller must consume, never an obligation a member discharges just by
ending its turn.
