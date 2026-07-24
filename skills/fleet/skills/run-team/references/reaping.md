# Reaping merged branches and worktrees

Why reap runs after every wave, why `commit-commands:clean_gone` disqualified, why hand-rolled reap shaped this way (implemented by `reap.sh`). Assertions these justify live in SKILL.md's "Reap after every wave" section; evidence here.

## Reap after every wave, not once at the end

Merge deletes remote branch, leaves local branch `[gone]` with worktree — and its `node_modules` — still on disk. Stale worktree still answers `git worktree list`, so phase 0's in-flight probe reads already-merged ticket as taken and queue quietly shrinks as run goes on.

## Why `commit-commands:clean_gone` is disqualified

Its `[gone]` detection works fine — with upstream configured, `git branch -v` prints `[gone]` and grep matches (verified, git 2.50.1). Problem not detection. Problem what happens after match:

- Deletes with `git branch -D`, no merged check at all — nothing stops it deleting branch whose commits exist nowhere else.
- Removes worktrees with `git worktree remove --force`. Fatal here: members hold worktrees, `--force` discards uncommitted work that exists nowhere else. Same class as `git reset --hard` to start rebase.

Skill is maintainer's to fix. Do not patch it; do reap yourself.

## Why the reap is shaped the way it is

Every precondition recomputed **inside** same command as delete:

- **`for-each-ref`, not `git branch | grep`.** `%(upstream:track)` emits exactly `[gone]` as own field. Nothing to pattern-match, no `-v`/`-vv` trap.
- **Recompute per branch, in this command.** Branch list from earlier tool call already false: one observed run listed 28 gone branches, two calls later 27 reaped by concurrent session. Benign direction is no-op; dangerous one is worktree that gained work *after* check.
- **`git cherry origin/main`, not `git diff main..`.** Against `origin/main` — local `main` you never fast-forwarded reads every merged branch as unmerged. Any `+` line is commit that exists nowhere else.
- **`-D` authorized by that cherry check, and only by it.** `git branch -d` would refuse everything here: upstream gone, so falls back to comparing against `HEAD`, a possibly-behind local `main`. Never `-D` branch whose cherry output you did not just read.
- **`worktree remove` without `--force`.** Refuses on modifications *and* untracked files, so double-covers dirty check. Refusal is finding to report, never something to force past.

## Never reap a branch a live member is on

Cross-check `.fleet/ledger.md` before running: row without terminal state means someone may still be in that worktree — merged PR can still have reviewer filing follow-ups. Dirty check does not see member that committed but not pushed. Update reaped tickets' ledger rows in same step, report reaped and kept counts. Kept-with-reason is half worth reading.