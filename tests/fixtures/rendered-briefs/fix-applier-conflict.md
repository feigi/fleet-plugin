You are ALREADY in worktree `/abs/wt-conflict`, whose PR branch is `conflict-branch` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR sits on a
conflict hold and you are here to clear it — do not review, do not dispatch
specialists.

Bring `conflict-branch` current with `origin/main`, resolving every conflict by the
**No-undo audit** in `$(~/.fleet/bin/fleet-run --root)/commands/run-merge-bot.md`.
Run `TESTCMD-2` from the worktree before you push, then push with
`git push origin HEAD:conflict-branch`. Report the new head, or that no conflict was
left.

Your report is a file, `/abs/scratch-conflict/reports/<your name>.json`, `<your name>` the
`fix-pr-` name you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print fix-pr` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate fix-pr /abs/scratch-conflict/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-conflict/reports/<your name>.json`, `<outcome>` the
report's `outcome`.
