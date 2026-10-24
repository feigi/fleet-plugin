Implement ticket 4120. You are ALREADY in worktree `/abs/wt-impl`, whose PR branch is
`impl-branch`. Your scratch directory is `/abs/scratch-impl/impl-4120/`; outside the worktree,
write nowhere else but your report file below.

The ticket, pasted verbatim from the controller's own read — its title, the
`## Agent Brief` comment or the issue body, whichever carries the brief, and its
`Out of scope`:

BRIEF-TEXT-1

The controller's staleness probe: STALE-NOTE-1

Before you commit and push, run
`~/.fleet/bin/fleet-run recipe-check.mjs --member <your name> --testCmd ./agent-test --reports /abs/scratch-impl/reports`
from the worktree, after `git add`: it runs the Recipe's Check step, then
`./agent-test`, against the staged tree and records both beside your report.
Run it again after any content change or rebase. After the commit, and before
you push or report, compare `git rev-parse 'HEAD^{tree}'` with the `tree` field
of your record, `/abs/scratch-impl/reports/<your name>.check.json`. A commit hook that
rewrote and re-staged files after the record was written makes the two differ.
When they do, list the paths it changed,
`git diff --name-only "$(jq -r .tree /abs/scratch-impl/reports/<your name>.check.json)" HEAD`.
If the PR changes every listed path anyway, run `recipe-check.mjs` again with
the same arguments: right after the commit the index holds the committed tree,
so the re-run runs both commands on that tree and records it, leaving the
head's sha as it is. A listed path the PR does not otherwise change is a stale
base the hook staged rather than left unstaged, and a re-run would record it
green: `git fetch origin && git rebase origin/main`, take the commit back with
`git reset --soft HEAD^`, put each such path alone back with
`git restore --source=HEAD --staged --worktree -- <that path>`, run
`recipe-check.mjs`, then `git commit -C ORIG_HEAD` and compare again. A hook
that stages such a path again on the rebased base → push nothing and report
that cause. Equal trees need no re-run. The controller refuses a report whose
head's tree has no green record, and exit 75 from it is no test result — run it
again. So is exit 143, 130 or 129: it received a SIGTERM, SIGINT or SIGHUP and
recorded nothing — run it again with `timeout: 0` on the call.

Your report is a file, `/abs/scratch-impl/reports/<your name>.json`, `<your name>` the
`impl-4120[-x]` you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print impl` prints. Write it before
your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate impl /abs/scratch-impl/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-impl/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
