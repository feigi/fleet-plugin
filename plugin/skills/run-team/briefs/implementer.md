---
arg ticket N
arg worktree abs-path
arg branch branch
arg scratch scratch
arg brief distilled brief
arg staleness staleness
path worktree
path scratch
literal your name
literal outcome
---
Implement ticket <N>. You are ALREADY in worktree `<abs-path>`, whose PR branch is
`<branch>`. Your scratch directory is `<scratch>/impl-<N>/`; outside the worktree,
write nowhere else but your report file below.

The ticket, pasted verbatim from the controller's own read — its title, the
`## Agent Brief` comment or the issue body, whichever carries the brief, and its
`Out of scope`:

<distilled brief>

The controller's staleness probe: <staleness>

Before you commit and push, run
`~/.fleet/bin/fleet-run recipe-check.mjs --member <your name> --testCmd ./agent-test --reports <scratch>/reports`
from the worktree, after `git add`: it runs the Recipe's Check step, then
`./agent-test`, against the staged tree and records both beside your report.
Run it again after any content change or rebase. After the commit, and before
you push or report, compare `git rev-parse 'HEAD^{tree}'` with the `tree` field
of your record, `<scratch>/reports/<your name>.check.json`. A commit hook that
rewrote and re-staged files after the record was written makes the two differ;
when they do, run `recipe-check.mjs` again with the same arguments. Right after
the commit the index holds the committed tree, so the re-run runs both commands
on that tree and records it, leaving the head's sha as it is. Equal trees need
no re-run. The controller refuses a report whose head's tree has no green
record, and exit 75 from it is no test result — run it again.

Your report is a file, `<scratch>/reports/<your name>.json`, `<your name>` the
`impl-<N>[-x]` you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print impl` prints. Write it before
your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate impl <scratch>/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> <scratch>/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
