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

Your report is a file, `<scratch>/reports/<your name>.json`, `<your name>` the
`impl-<N>[-x]` you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print impl` prints. Write it before
your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate impl <scratch>/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> <scratch>/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
