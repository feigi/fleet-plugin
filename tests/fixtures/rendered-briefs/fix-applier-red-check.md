You are ALREADY in worktree `/abs/wt-red`, whose PR branch is `red-branch` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR's `check`
job is red on its current head and you are here to fix it — do not review, do
not dispatch specialists.

Read the failing job's log and fix the cause. Run `TESTCMD-7` from the
worktree before you push, then push with `git push origin HEAD:red-branch`.
Report the new head and **stop**: do not watch, poll or wait for CI — the
controller owns the next run on the pushed head. A red that is not yours to
fix — a flake that passes on rerun, or staleness — gets nothing pushed: report
that instead.
