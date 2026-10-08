# 0024 — `ready-to-merge` binds to the net change; a proven rebase-carry keeps the label

**Status:** Accepted. Ruled 2026-10-07 by the maintainer in a run-team session
("one review per PR is enough — a clean rebase carries the verdict"), recorded
on #2887. Amends ADR 0012 (Decision 3) and `docs/requirements.md` §3.4.

## Context

`docs/requirements.md` §3.4 bound `ready-to-merge` to the head SHA it was
applied at. The merge gate checked that by SHA alone: a PR head outside
`{pre, post}` was `head-moved-after-label`, and the merge bot's timeline read
refused any `committed` or `head_ref_force_pushed` line after the label before
the gate ever ran. A rebase that leaves the patch untouched therefore cost a
full fresh-finisher pass, and the controller worked around it by hand.

- `git patch-id --stable` is not a usable identity for "the same change":
  measured with git 2.50.1, two branches adding `new` and `  new` to the same
  file gave one patch-id, so an indentation change would pass.
- A `--binary` patch can encode a file as a delta against the other side;
  measured, two different pairs of blobs produced the same delta in both
  directions, so the patch text alone cannot tell them apart.
- GitHub's REST `head_ref_force_pushed` event names only the head the
  force-push produced (measured on #2923); the head it replaced is GraphQL's
  `HeadRefForcePushedEvent.beforeCommit`. A plain push between the label and
  that force-push leaves no timeline entry once the force-push orphans it.

## Decision

1. **The label binds to the net change it audited, not to one SHA.** A head
   that moved after the label is a **rebase-carry** when its diff against its
   own merge base with `origin/main` is byte-identical to the labelled head's,
   ignoring only each hunk header's line numbers and function context and a
   text file's blob ids. Every added, removed and context line, every mode
   line, symlink target, submodule pointer and a binary file's whole block,
   blob ids included, must match. Renames are compared as the deletion and
   addition they are.
2. **The proof is a merge-gate row, fail-closed.** `merge-gate.mjs` runs it in
   the main checkout, read-only, for the head `gh pr view` read when that head
   is outside `{pre, post}`. A missing object, a base that is not exactly one
   merge base, or any git failure is no carry, and the row stays
   `head-moved-after-label` (exit 1). The head `ci-state` reads must be `pre`,
   `post` or that same carried head. Every other row, and the row order, is
   unchanged; CI must still be green on the actual current head.
3. **A carry is visible.** The gate's JSON line gains `rebaseCarry`
   (`{labelled, accepted}` or null), and the merge bot reports
   `rebase-carry-#<pr>` with both SHAs.
4. **The merge bot hands a force-push to the gate instead of refusing it on
   sight.** The labelled head is the `beforeCommit` of the first force-push
   after the last `ready-to-merge` label, refused when any of its own commits
   carries a committer date after the label — the same predicate the
   `committed`-line check applies — or when it is not in the main checkout.
   Commits added without a force-push are refused as before.

## Consequences

- A conflict-free rebase no longer needs a fresh finisher; review fixes,
  conflict resolutions and edited commits still do.
- A rebase over a `main` edit inside a hunk's context window changes a context
  line and is refused. That false negative is accepted rather than loosening
  the comparison.
- The labelled head must still be in the main checkout. One the checkout
  never fetched is no carry.
- Left out: judging who pushed, commit-message or author differences, the
  reviewer and finisher dispatch pin, and any change to `ci-state.mjs`,
  `main-gain.mjs` or `instruments.sh`.
