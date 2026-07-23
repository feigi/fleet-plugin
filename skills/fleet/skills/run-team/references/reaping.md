# Reaping merged branches and worktrees

Why the reap runs after every wave, why `commit-commands:clean_gone` is
disqualified, and why the hand-rolled reap is shaped the way it is (implemented by
`reap.sh`). The assertions these justify live in SKILL.md's "Reap after every
wave" section; the evidence is here.

## Reap after every wave, not once at the end

A merge deletes the remote branch and leaves the local branch `[gone]` with its
worktree — and its `node_modules` — still on disk. A stale worktree still answers
`git worktree list`, so phase 0's in-flight probe reads an already-merged ticket
as taken and the queue quietly shrinks as the run goes on.

## Why `commit-commands:clean_gone` is disqualified

Its `[gone]` detection itself works fine — with an upstream configured,
`git branch -v` does print `[gone]` and its grep matches (verified, git 2.50.1).
The problem is not detection. It is what happens after a match:

- It deletes with `git branch -D` and no merged check at all — nothing stops it
  deleting a branch whose commits exist nowhere else.
- It removes worktrees with `git worktree remove --force`. Fatal here: members
  hold worktrees, and `--force` discards uncommitted work that exists nowhere
  else. Same class as `git reset --hard` to start a rebase.

The skill is the maintainer's to fix. Do not patch it; do the reap yourself.

## Why the reap is shaped the way it is

Every precondition is recomputed **inside** the same command as the delete:

- **`for-each-ref`, not `git branch | grep`.** `%(upstream:track)` emits exactly
  `[gone]` as its own field. Nothing to pattern-match, no `-v`/`-vv` trap.
- **Recompute per branch, in this command.** A branch list from an earlier tool
  call is already false: one observed run listed 28 gone branches, and two calls
  later 27 had been reaped by a concurrent session. The benign direction is a
  no-op; the dangerous one is a worktree that gained work *after* the check.
- **`git cherry origin/main`, not `git diff main..`.** Against `origin/main` — a
  local `main` you never fast-forwarded reads every merged branch as unmerged. Any
  `+` line is a commit that exists nowhere else.
- **`-D` is authorized by that cherry check, and only by it.** `git branch -d`
  would refuse everything here: upstream is gone, so it falls back to comparing
  against `HEAD`, which is a possibly-behind local `main`. Never `-D` a branch
  whose cherry output you did not just read.
- **`worktree remove` without `--force`.** It refuses on modifications *and*
  untracked files, so it double-covers the dirty check. A refusal is a finding to
  report, never something to force past.

## Never reap a branch a live member is on

Cross-check `.fleet/ledger.md` before running: a row without a terminal state
means someone may still be in that worktree — a merged PR can still have a
reviewer filing follow-ups. The dirty check does not see a member that committed
but has not pushed. Update the reaped tickets' ledger rows in the same step, and
report reaped and kept counts. Kept-with-reason is the half worth reading.
