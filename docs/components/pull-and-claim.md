# Pull & Claim

## What it is for

A **Pull** is the fleet's only unit of supply: the moment one
implementer slot frees, the controller admits exactly one ticket into
it — judged, then either claimed, relabelled by cause, or excluded.

## How it works
1. **Take the Shortlist head**, serially, in the main checkout
   (concurrent worktree/label writes would race). Re-check it isn't
   stale (`inflight.sh <N>` again).
2. **Read the ticket in full** (`gh issue view <N> --json
   title,body,comments,labels`; `## Agent Brief` outranks the body).
3. **Judge — decided?** Would two competent implementers reading only
   the ticket build materially different things (architecture, API
   shape, schema, UX, a new dependency or seam)?
   - Undecided → relabel `needs-triage`.
   - Genuine fork, options named, no ruling → relabel `ready-for-human`.
   - Sequenced behind an open ticket, or collides with a live
     branch/PR → exclude (`excluded · behind-pr:#M` /
     `behind-issue:#M`).
   - Decided, live, unclaimed → claim.
4. **Claim.** [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh)
   labels the issue `in-progress`, derives a frozen install command from
   `origin/main`'s lockfile, creates a branch and worktree
   (`<type>/<issue>-<slug>`), materializes the [Recipe](recipe.md)'s
   install step, and emits a JSON claim receipt.
5. **Dispatch** the [Implementer](implementer.md).

Relabelling and excluding write a `ledger.mjs row` comment naming the
cause; a relabelled ticket costs nothing until a human runs `/triage`,
and an excluded one re-enters the Shortlist once its premise closes.

## Opinionated choices

- **Relabel by cause, not a bare demotion.** Every non-admission is a
  label plus a one-line reason the maintainer can read later, reversing
  "one human decision per batch" into "zero human decisions per
  admission, every non-admission legible"
  ([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md)).
- **A heavier bar than filing-time.** The **decided?** test here is
  stricter than the bar a reviewer applies when deferring a finding —
  a wrong claim costs a worktree and a dispatch, a wrong filing costs
  one PR review the maintainer already runs
  ([ADR 0001](../adr/0001-filing-label-bar-is-defect-confirmed.md)).
- **A claim is exactly three artefacts** — branch, worktree,
  `in-progress` label — taken together, independent of whether the
  worktree directory still exists on disk (see
  [Reaping & Liveness](reaping-and-liveness.md)).
