# 0026 — The tick detects a conflicting PR before the merge bot does

**Status:** Accepted. Ruled on #2882.

## Context

A `conflict-hold:#<pr>` was written only by the merge bot, and only when its
local-rebase fallback stopped on a conflict. So a hold was late by
construction: a PR that started conflicting with `main` after a fix-applier's
push stayed unflagged until it was labelled `ready-to-merge` and a merge bot
reached it. In between, no instrument the controller reads said anything.
`fleet-tick.mjs` read no mergeability field at all, and the gap was found when
an operator looked at the PR by hand and remembered the recovery recipe.

## Decision

1. **Instruments over operator recall.** `fleet-tick.mjs` adds `mergeable` to
   the `gh pr list --json` it already makes every tick, with no extra `gh`
   call. A row without a string `mergeable` refuses the tick, the same way a
   missing `headRefOid` does. `ci-state.mjs` is unchanged: there is one
   mergeability reading, not two.
2. **A conflict is `mergeable=CONFLICTING`, nothing else.** `UNKNOWN` is read
   again next tick. A PR that is merely behind is not a reason to rebase: the
   merge bot's server-side `update-branch` covers it. `mergeStateStatus` is not
   requested.
3. **The tick prints `CONFLICT PR#<M>` on the reviewers role, and the
   controller writes the hold.** The line is actionable and prints its step:
   `ledger.mjs read`, then `ledger.mjs row` with
   `conflict-hold:#<M> (conflict: mergeable=CONFLICTING)` appended to the row
   naming the PR. That is the merge bot's own procedure and its existing token,
   so the fold, `fixDue`, `ledger.mjs dispatch`'s choice of the conflict
   fix-applier's definition and the lift rule (`applied:`/`no-op`) all apply
   unchanged. The tick stays read-only and `ledger.mjs` gains no subcommand.
4. **Guards on the line.** It prints only for an open PR the ledger tracks
   (human and chore PRs are excluded), with no unresolved conflict hold already
   on it (the hold is the deduplication record), with no live fix-applier,
   finisher or implementer on it, and, for a PR carrying `ready-to-merge`,
   with no live merge bot: a queued PR is left to the bot's own fallback. A
   review in flight does not stop it, because `fixDue` already waits for the
   review to return. It prints under a main-checkout hold or a drain, since it
   only writes a record; the fix-applier it leads to obeys every hold through
   the reviewers row.
5. **Treadmill cap.** A PR with two landed conflict fix-appliers that reads
   `CONFLICTING` again prints `ESCALATE conflict PR#<M>` instead: the
   controller comments and flags the PR for a human, writes no hold and
   dispatches no fix-applier. It keeps no new state. Like `ESCALATE
   unlabelled`, it is not actionable, repeats while the condition holds (the
   quiet line folds the repeats) and clears when the PR stops reading
   `CONFLICTING`, closes or merges.
6. **`ledger.mjs dispatch` refuses a finisher on a conflict-held PR**, read off
   the same per-PR fold as the dispositions refusal and checked ahead of it. A
   finisher would otherwise label a PR known to conflict, or race the conflict
   fix-applier and end in its own `rebase` halt, which escalates.

## Consequences

- A PR can now be held before it has been reviewed, so a conflict fix-applier
  — always the slow-high definition — can run on a PR whose review is still
  owed. That cost is accepted in exchange for finding the conflict on the
  tick that first sees it.
- A conflict fix-applier's push on an unlabelled PR moves no label. On a PR
  carrying `ready-to-merge` the push moves the head after the label, and the
  next merge bot refuses it `head-moved-after-label`, as before.
- The merge bot remains a writer of the hold for the PRs it owns: a queued PR
  while a bot is live, and any conflict its fallback meets.
