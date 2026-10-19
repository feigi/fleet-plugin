You are ALREADY in worktree `/abs/wt-conflict`, whose PR branch is `conflict-branch` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR sits on a
conflict hold and you are here to clear it — do not review, do not dispatch
specialists.

Bring `conflict-branch` current with `origin/main`, resolving every conflict by the
**No-undo audit** in `$(~/.fleet/bin/fleet-run --root)/commands/run-merge-bot.md`.
Run `CHECKCMD-2` and `TESTCMD-2` from the worktree before you push, then push with
`~/.fleet/bin/fleet-run push-sync.mjs --branch conflict-branch`. Report the new head, or that no conflict was
left.

**A red `CHECKCMD-2` is yours to judge.** Read what it reports and fix every
finding in a file the PR changes, including lines you did not edit — CI checks
whole files. Never edit a file the PR does not otherwise change: a finding there
is a stale base, not your code, so rebase onto `origin/main` and re-run; still
red → push nothing and report that cause. No fix command is recorded; the Check
step only reports. A hook that rewrites a file the PR does not otherwise change
is the same stale base. Stage every change of your own before the commit that
runs the hook, so every change still unstaged after it is the hook's alone:
never stage those, `git restore -- <that path>` for each such path alone, then
rebase and re-run.

Your report is a file, `/abs/scratch-conflict/reports/<your name>.json`, `<your name>` the
`fix-pr-` name you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print fix-pr` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate fix-pr /abs/scratch-conflict/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-conflict/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

Push, write your report, exit; never poll a CI run.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
