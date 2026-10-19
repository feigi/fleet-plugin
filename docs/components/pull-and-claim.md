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
   - Provably fixed already (`staleness.mjs` exit 1, checked against
     `origin/main`) → close citing the fixing commit, next entry.
   - Undecided → relabel `needs-triage`.
   - Genuine fork, options named, no ruling → relabel `ready-for-human`.
   - Sequenced behind an open ticket, or collides with a live
     branch/PR → exclude (`excluded · behind-pr:#M` /
     `behind-issue:#M`).
   - Decided, live, unclaimed → claim.
4. **Claim.** [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh)
   labels the issue `in-progress`, creates a branch and worktree
   (`<type>/<issue>-<slug>`), runs the [Recipe](recipe.md)'s Install step
   there — read from the Recipe cache, refusing if it changed the tree —
   and emits a JSON claim receipt.
5. **Dispatch** the [Implementer](implementer.md).

Relabelling and excluding write a `ledger.mjs row` comment naming the
cause; a relabelled ticket costs nothing until a human runs `/triage`,
and an excluded one re-enters the Shortlist once its premise closes.

[`pull.mjs`](../../plugin/scripts/pull.mjs) runs the mechanical steps
of a Pull in order and stops at each judgement — staleness, decided?,
collision — with a `QUESTION <qid>:` block (exit 10) that the
controller answers in one token with `pull.mjs answer`. State and every
answer, with its time, are in `<scratch>/impl-<N>/pull.json`, so a
process killed between answers resumes at the pending question. Exit 0
prints the `DISPATCH` spec; exit 1 means the ticket left the Pull; a
router that refuses releases the claim. The tick reads that file for each
head it names: a standing question prints `PULL #N (Q<n> pending —
pull.mjs answer N <qid> …)` in place of `PULL #N — pull.mjs next --head
N`, so a controller that lost its place never asks it twice. A head whose
Pull already ended in this run names no row, since `next --head` would
start that ticket over and the next head fills the slot. A Pull that ended
on an exclusion, reason `excluded · …`, is the exception: once the premise
has lifted the tick counts the head and names its row again, and `next`
without `--head` takes it.

## Opinionated choices

- **Relabel by cause, not a bare demotion.** Every non-admission is a
  label plus a one-line reason the maintainer can read later, reversing
  "one human decision per batch" into "zero human decisions per
  admission, every non-admission legible"
  ([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md)).
- **A consumption-time bar.** The **decided?** test runs here, never
  at filing time: every issue the plugin files is `needs-triage`, and
  only triage sets `ready-for-agent`
  ([ADR 0032](../adr/0032-every-issue-files-needs-triage.md)).
- **A claim is exactly three artefacts** — branch, worktree,
  `in-progress` label — taken together, independent of whether the
  worktree directory still exists on disk (see
  [Reaping & Liveness](reaping-and-liveness.md)).
