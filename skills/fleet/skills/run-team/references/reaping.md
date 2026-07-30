# Reaping merged branches and worktrees

Why reap runs after every wave, why `commit-commands:clean_gone` disqualified, why hand-rolled reap shaped this way (implemented by `reap.sh`), and why a claim that never became a PR needs a different script (`release-ticket.sh`). Assertions these justify live in SKILL.md's "Reap after every wave" and "Release the claims that never became PRs" sections; evidence here.

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

## Why reap declines a claim that was never dispatched

Undispatched claim = `in-progress` label + worktree + branch, no PR. `reap.sh` skips it, correctly: no merge happened, so no remote branch was ever deleted, so branch is not `[gone]` and the `for-each-ref` filter never selects it. Forced past that, `git cherry` is empty and `-D` unauthorized. Reap's evidence is "merged upstream"; this branch never went anywhere.

So nothing in the run cleans it up. Next run, phase 0's probe 3 sees the worktree and the local branch → hit → free ticket reads as taken, silently. Same failure as a stale merged worktree, opposite end of the lifecycle. Normal, not exotic: phase 1 is serial and runs ahead of dispatch, so collision-after-claim, drain, and re-prioritisation all produce it.

`release-ticket.sh` covers it. Four preconditions, recomputed inside same invocation as delete, same reason reap recomputes:

- **`ahead` + dirty catch a member that did work.** `ahead` against `origin/main`. Not redundant with `git cherry`: commit already cherry-picked upstream is upstream-equivalent (`-` line, not `+`), and only `ahead` still sees it. Pinned by a test.
- **`git cherry` catches commits that exist only locally.** Against `origin/main`, never a local main — same trap reap has.
- **Remote check catches a pushed branch.** Live `git ls-remote`, so it cannot be stale. Its failure is an unknown answer, never a "not pushed" — swallow it and a release deletes the local copy of work already on the server.
- **Label read first, `gh` failure fatal.** Worktree and branch gone with `in-progress` left behind hides the ticket from `candidates.mjs` entirely — worse than not releasing. All three artefacts or none.

**`-d` here, `-D` in reap** — opposite calls, both correct. Claim branch still has its upstream (`git worktree add -b <b> origin/main` sets it, git 2.50.1), so `-d` compares against `origin/main` and accepts an unmodified claim even when local main is behind. Reap's `[gone]` branches have no upstream left, so `-d` would compare against a possibly-behind local HEAD and refuse everything. A `-d` refusal here means the branch carries something the four checks missed: report, never escalate.

**`worktree remove` without `--force`** refuses on modified and untracked files and deletes ignored files silently (verified, git 2.50.1). Ignored-silently is what is wanted: `claim-ticket.sh` writes `agent-test` into every worktree, so treating ignored files as dirt would strand every release. Its refusal is the dirty check recomputed by git at the moment of the delete.

**A worktree that wandered off the branch blocks too.** The worktree is located by the branch it has checked out, and it does not stay there — an interrupted rebase leaves it detached, a member can switch it. The lookup then finds nothing, which reads as "no worktree of ours": the dirty check is skipped entirely and the release reports success while the worktree stands with the member's work in it, so the next run's probe still reads the ticket as taken. So a linked worktree at `claim-ticket.sh`'s `.worktrees/<issue>-<slug>` that is *not* on the branch is its own blocker — release it by hand. The path is read as the whole rest of the `worktree list --porcelain` line, never the first whitespace field, or every checkout under a directory with a space in its name reads as a different path.

Check: `node --test skills/fleet/scripts/release-ticket.test.mjs` — real throwaway repos, only `gh` stubbed, one case per precondition proving it blocks on its own.

## Never reap a branch a live member is on

Cross-check `.fleet/ledger.md` before running: row without terminal state means someone may still be in that worktree — merged PR can still have reviewer filing follow-ups. Dirty check does not see member that committed but not pushed. Update reaped tickets' ledger rows in same step, report reaped and kept counts. Kept-with-reason is half worth reading.