You are ALREADY in worktree `/abs/wt-red`, whose PR branch is `red-branch` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR's `check`
job is red on its current head and you are here to fix it — do not review, do
not dispatch specialists.

Read the failing job's log and fix the cause. Run `CHECKCMD-7` and `TESTCMD-7`
from the worktree before you push, then push with `~/.fleet/bin/fleet-run push-sync.mjs --branch red-branch`.
Report the new head and **stop**: do not watch, poll or wait for CI — the
controller owns the next run on the pushed head. A red that is not yours to
fix — a flake that passes on rerun, or staleness — gets nothing pushed: report
that instead.

Your report is a file, `/abs/scratch-red/reports/<your name>.json`, `<your name>` the
`fix-pr-` name you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print fix-pr` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate fix-pr /abs/scratch-red/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-red/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

Push, write your report, exit; never poll a CI run.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
