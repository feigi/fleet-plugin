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
- **A cherry that cannot answer is a KEEP.** Capture git's output; never pipe git itself: `cmd | grep -q` takes grep's exit status, never cmd's, so a `git cherry` that dies (rc 128 — one unreadable loose object is enough) prints nothing, grep exits 1, and a dead probe reads identical to "nothing unmerged" (verified, git 2.50.1). Unanswerable probe authorizes no delete — same fail-closed shape as `worktree remove` below. Read the `+` anchored, too: the capture folds stderr in, so an unanchored match reads a `+` in a diagnostic as a commit. Pinned by a test.
- **`worktree remove` without `--force`.** Refuses on modifications *and* untracked files, so double-covers dirty check. Refusal is finding to report, never something to force past.

## Why a second sweep, over worktrees rather than branches

Above walk finds branch's worktree by `branch refs/heads/<name>` line `git worktree list --porcelain` prints. Worktree at detached HEAD carries no such line — so it was not refused, it was **not considered**, which is why no-silent-caps rule did not fire either: branch reaped, no `would remove worktree` line, no `kept` entry, directory left on disk. Measured live during merge wave.

**Route not established — shape is.** Do not repeat that merge bot's server-side rebase detaches worktree: measured false. Bot reported `path=rebase` for #969/#970/#972, `reap.sh` dry run right after printed `would remove worktree` for all three — line only ATTACHED worktree reaches. `run-merge-bot.md` agrees: API rebased remote, not your checkout, left attached and merely stale. `release-ticket.sh` names one route it did measure, interrupted rebase. Cost of shape is what matters and is measured: stale worktree still answers `git worktree list`, in-flight probe reads it as live claim, already-merged ticket reads as taken, queue quietly shrinks.

So `reap.sh` enumerates worktrees git lists with **no `branch` line at all** and decides each on own state:

- **Bounded to `*/.worktrees/*` — fleet's own worktree home — and everything outside it is a `kept` entry.** Branch sweep authorizes `-D` on evidence PR merged (`%(upstream:track)` reads exactly `[gone]`). This sweep has none to read: branchless + clean + patch-equivalent also describes human's `git worktree add --detach` scratch checkout that was never ticket. Unbounded, `--apply` deleted it (measured, PR #985 review). Bound is ownership, never contents.
- **`git cherry` against `origin/main`, never `merge-base --is-ancestor`.** Branch was rebased before it merged, so tip fully upstream is patch-equivalent, not ancestor — ancestry answers no for exactly work that is safe. Subject is full object id off porcelain, so no refname shadows it.
- **Absent `branch` line is not by itself detached HEAD.** git prints none for worktree whose HEAD it cannot resolve either, reporting null object id instead — four measured corruption routes for admin `HEAD` (#179). Nothing about such worktree decidable, so report and leave. Null id alone is not the test: unborn branch is legitimate null id and DOES carry `branch` line.
- **A git operation in progress is a keep, and git is no backstop for it.** Measured, git 2.50.1 (Apple Git-155): `worktree remove` *without* `--force` removes worktree holding interrupted rebase, and one holding bisect, at rc 0. Both detach, both leave `status --porcelain` empty — so every other check passes them and sequencer state, todo list and original head go with directory. Interrupted rebase is exactly how fleet worktree wanders off its branch (see `release-ticket.sh`'s own stray guard).
- **Every decline is a `kept` entry, `branch` null.** No branch to name. Gap was invisible precisely because nothing was reported.
- **Removals join `worktreesRemoved[]`, from both sweeps.** One meaning, no qualifier: a key naming only removals no branch accounted for would leave reader unable to tell absent removal from unreported one.
- **Not fixed in merge bot.** Re-attaching worktree after rebase puts invariant where it only helps paths that remember to do it, and next permitted-command change moves problem again.

## Why reap declines a claim that was never dispatched

Undispatched claim = `in-progress` label + worktree + branch, no PR. `reap.sh` skips it, correctly: no merge happened, so no remote branch was ever deleted, so branch is not `[gone]` and the `for-each-ref` filter never selects it. Forced past that, `git cherry` is empty and `-D` unauthorized. Reap's evidence is "merged upstream"; this branch never went anywhere.

So nothing in the run cleans it up. Next run, phase 0's probe 3 sees the worktree and the local branch → hit → free ticket reads as taken, silently. Same failure as a stale merged worktree, opposite end of the lifecycle. Normal, not exotic: phase 1 is serial and runs ahead of dispatch, so collision-after-claim, drain, and re-prioritisation all produce it.

`release-ticket.sh` covers it. Four preconditions, recomputed inside same invocation as delete, same reason reap recomputes — but the dirty check is the conditional one: it opens only when the worktree directory is there to read, and where that directory is established absent it does not run at all, leaving the absence measurement itself as what stands in for it:

- **`ahead` + dirty catch a member that did work.** `ahead` against `origin/main`. Not redundant with `git cherry`: commit already cherry-picked upstream is upstream-equivalent (`-` line, not `+`), and only `ahead` still sees it. Pinned by a test.
- **`git cherry` catches commits that exist only locally.** Against `origin/main`, never a local main — same trap reap has.
- **Remote check catches a pushed branch.** Live `git ls-remote`, so it cannot be stale. Its failure is an unknown answer, never a "not pushed" — swallow it and a release deletes the local copy of work already on the server.
- **Label read first, `gh` failure fatal.** Worktree and branch gone with `in-progress` left behind hides the ticket from `candidates.mjs` entirely — worse than not releasing. All three artefacts or none.

**`-D` here too, and for reap's reason** — authorized by the `ahead` and `git cherry` checks above, plus the `ahead` recount re-run against `origin/main` immediately before the delete itself (a commit can land across the `gh issue view` between the checks and the delete; `git cherry` is not re-run, because such a commit is ahead of `origin/main` by construction), and by nothing else. A claim used to carry `origin/main` as its upstream, so `-d` compared against *that* and forgave a behind local main; since #760 `claim-ticket.sh` passes `--no-track` (so `@{u}` cannot silently answer about main), a claim has no upstream until its first `push -u`, and `-d` falls back to comparing against local `HEAD`. Measured: with local `main` behind `origin/main`, `-d` refuses a pristine claim — half-releasing it, worktree deleted and branch stranded with `in-progress` still on the ticket. The two checks above are strictly stronger than what `-d` would have asked, and both measure against `origin/main` rather than a local ref.

**`worktree remove` without `--force`** refuses on modified and untracked files and deletes ignored files silently (verified, git 2.50.1). Ignored-silently is what is wanted: `./agent-test` materializes `.agent-test.sh` beside itself in every worktree it runs in (and before #55, `claim-ticket.sh` wrote an untracked `agent-test` into every worktree it claimed), so treating ignored files as dirt would strand every release. The same asymmetry is why the runner itself is tracked as a BOOTSTRAP rather than committed as a copy: a claim that overwrote a tracked `agent-test` would leave a modified tracked path, which this refusal does not forgive. Its refusal is the dirty check recomputed by git at the moment of the delete — for the live-directory case ONLY. `worktree remove` gates that clean check on the same `stat` the guard does, so it is not an independent second opinion: where the path cannot be stat'ed git reaches the same "gone" by the same means, accepts the entry at rc 0 and deregisters a worktree whose files are still on disk (measured, git 2.50.1: an untracked file in a worktree under a `chmod 000` parent). There the `gone` guard is sole arbiter — which is why it establishes absence instead of inferring it from a failed `-e`, and why the fail-open fixed in `1e54bac` survived being reasoned about: guard and backstop fail on the same inputs.

**A worktree that wandered off the branch blocks too.** The worktree is located by the branch it has checked out, and it does not stay there — an interrupted rebase leaves it detached, a member can switch it. The lookup then finds nothing, which reads as "no worktree of ours": the dirty check is skipped entirely and the release reports success while the worktree stands with the member's work in it, so the next run's probe still reads the ticket as taken. So a linked worktree at `claim-ticket.sh`'s `.worktrees/<issue>-<slug>` that is *not* on the branch is its own blocker — which remedy it names is the next paragraph, and is not always a hand-release. The path is read as the whole rest of the `worktree list --porcelain` line, never the first whitespace field, or every checkout under a directory with a space in its name reads as a different path.

**Which remedy depends on whether that directory still exists.** The registration outlives it: `worktree list --porcelain` keeps the entry, annotated `prunable`, after an `rm -rf`, so the blocker named a hand-release nobody could perform and every later run repeated it. When the directory is established gone the blocker names `git worktree prune` instead — that clears the entry and the next run releases (verified, git 2.50.1). Still a blocker, never a release: the worktree is not on the claim's branch, so releasing would delete a different ref and then reach the prune every `--apply` ends with, unanchoring a detached HEAD's commits as a side effect. Absence is established by walking up to the nearest ancestor that exists and requiring it to be searchable — the same predicate the dirty check uses, because `-e` is false both for a directory that is gone and for one inside a prefix we may not search, and pruning the second unregisters a worktree still holding uncommitted work.

Check: `node --test scripts/release-ticket.test.mjs` — real throwaway repos, no mocked git history, one case per precondition proving it blocks on its own.

## Never reap a branch a live member is on

Cross-check `.fleet/ledger.md` before running: row without terminal state means someone may still be in that worktree — merged PR can still have reviewer filing follow-ups. Dirty check does not see member that committed but not pushed. Update reaped tickets' ledger rows in same step, report reaped and kept counts. Kept-with-reason is half worth reading.