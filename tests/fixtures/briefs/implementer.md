Implement ticket 4120. You are ALREADY in worktree `/abs/wt-impl`, whose PR branch is
`impl-branch`. Your scratch directory is `/abs/scratch-impl/impl-4120/`; outside the worktree,
write nowhere else but your report file below.

The ticket, pasted verbatim from the controller's own read — its title, the
`## Agent Brief` comment or the issue body, whichever carries the brief, and its
`Out of scope`:

BRIEF-TEXT-1

The controller's staleness probe: STALE-NOTE-1

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
