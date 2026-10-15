---
arg ticket N
arg worktree abs-path
arg branch branch
arg scratch scratch
arg brief distilled brief
arg staleness staleness
path worktree
path scratch
---
Implement ticket <N>. You are ALREADY in worktree `<abs-path>`, whose PR branch is
`<branch>`. Your scratch directory is `<scratch>/impl-<N>/`; write nowhere else
outside the worktree.

The ticket, pasted verbatim from the controller's own read — its title, the
`## Agent Brief` comment or the issue body, whichever carries the brief, and its
`Out of scope`:

<distilled brief>

The controller's staleness probe: <staleness>

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
