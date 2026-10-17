# Salvaging an Idle Open `impl-<N>/` Partition Before the TTL Delete

Scratch reclaim removes an open issue's `impl-<N>/` partition once it has no live
`impl-<N>` token and has been idle past 7 days (ADR 0029 decision 5). We don't accept
proposals to add a salvage step in front of that delete: preserving, exporting as a
patch, or surfacing the partition's contents before it goes.

## Why this is out of scope

**The partition holds no git work.** A member's code lives in its claim worktree,
`.worktrees/<N>-impl-<N>`, which `claim-ticket.sh` creates outside the scratch root. The
implementer prompt says the scratch root sits deliberately outside every worktree so a
harness never dirties one. Uncommitted or unpushed work in that worktree is already
protected without any salvage step: Reap keeps a dirty worktree, and Release refuses to
drop unpushed work. Nothing the delete removes is code that exists nowhere else.

**What an idle `impl-<N>/` can hold is regenerable or disposable:**

- `issue.json`, `pull.json` and `pull.previous.json`, the Pull's records. A record left
  by another session makes the Pull start over, so a stale one is discarded by design.
- The heavy-tier plan.
- Probe and mutation copies with their `.orig` files.
- Children's directories at `impl-<N>/<child>/`.

None of it is a diff, so there is nothing for a patch export to capture. Exporting a
patch only makes sense for a git worktree, and none is created under `impl-<N>/`.

**The anecdote behind the request was about a different partition.** The triggering
report, #3317, described a fixer that died with its diff surviving only in a scratch
worktree. That was a fix-applier, whose scratch lives under `pr<N>/`, not `impl-<N>/`.
The `pr<N>/` side is a separate question.

## What is not rejected

The narrower gap the investigation found is a different request: a `prior: dead` resume
inherits the files under `impl-<N>/`, but a dead run more than 7 days old has already
lost that partition to reclaim, which Phase 0 runs before stranded. The commits are safe
in `.worktrees/`; the plan and probe notes are not. Keeping an open `impl-<N>/` while its
claim worktree stands is tracked as its own ticket and amends decision 5; it is not a
salvage step.

## What would reopen this

Either of these:

- A measured loss of git work (commits or uncommitted changes) that lived only inside
  an `impl-<N>/` partition, not in a `.worktrees/` claim worktree.
- A change to the layout that puts a git worktree or other irreplaceable work under
  `impl-<N>/`.

## Prior requests

- #3391 — "Salvage idle open impl-<N>/ scratch partitions before TTL delete"
