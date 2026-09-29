# 0018 — A branch delete is a compare-and-swap on a tip read once; upstream config is never a delete-safety input

**Status:** Accepted. Ruled 2026-09-29 on #1330 by the maintainer, from a
grilling session. Implemented in `release-ticket.sh` by `901b857b` (#1325);
the checked-out gap is #2218, and `reap.sh` is #2219.

## Context

The invariant is **never destroy a commit that exists nowhere else**.

- **#760 retired `-d`.** `claim-ticket.sh` passes `--no-track`, so a claim has
  no upstream until its first push. With no upstream, `git branch -d` measures
  against local HEAD alone, and it refuses a pristine claim whenever local
  `main` is behind `origin/main`. The release is then half done: worktree
  deleted, branch stranded, `in-progress` still on the issue.
  `release-ticket.sh` moved to `-D`.
- **`-D` has no view of its own on merge safety,** so the script's guards
  became the only enforcement. PR #1320's review found a distinct way to make
  them vacuous in each of three rounds: a `BASE_REF` naming the claim's own
  branch, a commit landing across the `gh issue view`, and a local tag
  `origin/main` shadowing the remote-tracking ref. Each was fixed.
- **#1330 asked two things.** Is one enforcement point acceptable? And does
  the premise "a claim acquires an upstream only through its first `git push
  -u`" need a code guard? Today it is written only in
  `plugin/skills/next-ticket/SKILL.md` step 7.
- **#1325 (`901b857b`) has since replaced `-D`** with `git update-ref -d
  refs/heads/$branch $tip`.

## Decision

1. **A branch delete is a compare-and-swap on a tip read once.** Read `$tip`
   once. The delete-time recount and the delete itself measure `$tip`, not
   the live ref — the earlier guards (commits ahead, `git cherry`) still run
   against the live branch; the recount is what the compare-and-swap
   actually depends on. Delete with `git update-ref -d refs/heads/<b>
   <tip>`, which refuses unless the ref still equals `$tip`. Plain `-d`
   stays retired (#760). `-D` is retired as each script migrates.
2. **The base is always measured by its fully qualified name.** `$base_rev`
   is `refs/remotes/…`, never a shorthand that git's disambiguation order can
   resolve to a tag or branch. It never names the branch being deleted.
3. **What the compare-and-swap gives up is restored explicitly.**
   `update-ref` does not check worktrees, so `release-ticket.sh` refuses when
   a worktree holds the branch: on its porcelain `branch` line, or, for a
   worktree detached mid-rebase (`rebase-merge/head-name`,
   `rebase-apply/head-name`) or mid-bisect (`BISECT_START`), through that
   operation's admin state — the two cases `-D` refused that the listing
   alone misses (measured, git 2.50.1). The reader is `wt_holding` in
   `plugin/scripts/worktree.sh`, over `wt_op_state`, which also holds the
   in-progress marker list `reap.sh` keeps busy worktrees on (`BISECT_LOG`
   for "in progress", `BISECT_START` for "which branch"). A detached
   worktree whose admin dir cannot be read is "cannot tell", and the
   release halts on it (#2218).
4. **The compare-and-swap is the second mechanism, and one enforcement point
   is not accepted.** It closes the check-then-act class: a commit that
   lands after the checks moves the ref, and the delete refuses. It does
   **not** cover a base that points at the branch itself. That class stays
   guarded by the `BASE_REF` accept-list, the self-reference guard and
   `$base_rev`. The one route left is deliberately rewriting
   `refs/remotes/origin/main` by hand, which is accepted. Rejected: a
   server-side check (`git ls-remote origin refs/heads/main` plus
   `merge-base --is-ancestor`). It closes that class too, but ancestry
   against the server SHA needs its objects locally — unlike the
   `ls-remote` the release path already runs, `merge-base --is-ancestor`
   adds a fetch and its failure modes to the path that releases claims.
5. **Upstream config decides liveness only.** No delete guard reads `@{u}` or
   `branch.<b>.merge`. The only reader is `reap.sh`'s candidate selection,
   `%(upstream:track)` = `[gone]`. A branch pushed without `-u` is never
   selected: it leaks, and nothing is lost. The `-u` premise therefore stays
   prose and gets no code guard.

## Consequences

- **Accepted residual window, measured:** between the fresh worktree re-read
  and the `update-ref` call, a concurrent checkout can end up holding a
  deleted branch. Measured (git 2.50.1): the worktree's branch goes unborn
  (`git status -sb` reads "No commits yet"), and a commit made there after
  the delete becomes a parentless root — history is severed, but the
  original commit is not lost, only unreachable from the new branch. A
  commit made there before the delete moves the ref off `$tip`, and the
  compare-and-swap refuses. Git has no lock that stops a `worktree add` of
  an existing branch, so this script cannot close the window.
- **Two holds `-D` refused are still outside that reader** (measured, git
  2.50.1): a branch listed in a `rebase --update-refs` run's
  `rebase-merge/update-refs`, and a bisect's starting branch in a worktree
  that has since checked out a different branch mid-bisect. Neither worktree
  is `detached` with the claim branch in its head-name or `BISECT_START`, so
  `wt_holding` does not read them.
- **`reap.sh` does not conform yet.** Until #2219 lands it authorizes `git
  branch -D` with `git cherry` on the live ref alone, and the gap between the
  two calls stays open.
- **`worktree-audit.sh` is out of scope.** It reports a mid-rebase/bisect
  worktree as `DETACHED`. It deletes nothing; whether that misleads its
  consumer is #2220.
- **Any future script that deletes a branch** follows points 1–3, and treats
  upstream config as liveness only (point 5).
