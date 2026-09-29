# Pull & Claim

## What it is for

A **Pull** is the fleet's only unit of supply: the moment one implementer
slot frees, the controller admits exactly one ticket into it — judged,
then either claimed, relabelled by cause, or excluded. Nothing else grabs
work; nothing holds a queue behind the free slot.

## How it works

Phase 1 of [`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md)
runs serially in the main checkout (concurrent `worktree add` and label
writes would race). It takes the [Shortlist](supply-and-shortlist.md)'s
head, re-checks it isn't stale since the last refresh (`inflight.sh <N>`
again), reads the full ticket (`gh issue view <N> --json
title,body,comments,labels`, `## Agent Brief` outranking the body), and
applies the **decided?** test: would two competent implementers reading
only the ticket build materially different things — architecture, API
shape, schema, UX, a new dependency or seam? An undecided ticket is
relabelled `needs-triage`; a genuine fork with named options and no
ruling is relabelled `ready-for-human`; a target the brief's `Out of
scope` sequences behind an open ticket, or one that collides with a live
branch or open PR, is excluded (`excluded · behind-pr:#M` /
`behind-issue:#M`) rather than claimed. A decided, live, unclaimed ticket
is claimed: [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh)
labels the issue `in-progress`, derives a frozen install command from
`origin/main`'s own lockfile, creates a branch and a dedicated `git
worktree` (`<type>/<issue>-<slug>`), materializes the [Recipe](recipe.md)'s
install step there, and emits a JSON claim receipt. The Pull table names
every outcome exactly once — no ticket is ever both relabelled and
claimed, or left in neither state — before
[dispatching the implementer](implementer.md). Relabelling and excluding
write a `ledger.mjs row` comment naming the cause; neither invokes
anything automatically, so a relabelled ticket costs nothing until a
human runs `/triage` or the excluding PR/issue closes and the ticket
re-enters the Shortlist on its own.

## Opinionated choices

Relabel by cause, not a bare demotion: every non-admission is a label
plus a one-line reason the maintainer can read later, reversing the
older "one human decision per batch, zero unilateral grabs" invariant
into "zero human decisions per admission, every non-admission legible"
([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md)). The
**decided?** bar here is deliberately heavier than the filing-time bar a
reviewer applies when it defers a finding into a new ticket — a wrong
claim here costs a worktree and a dispatch, a wrong filing there costs
one PR review the maintainer already runs
([ADR 0001](../adr/0001-filing-label-bar-is-defect-confirmed.md)). A
claim is exactly three artefacts — branch, worktree, `in-progress` label
— taken together, independent of whether the worktree directory still
exists on disk, which is what makes an orphaned worktree directory a
distinct, later failure mode from a claim that was never released (see
[Reaping & Liveness](reaping-and-liveness.md)).
