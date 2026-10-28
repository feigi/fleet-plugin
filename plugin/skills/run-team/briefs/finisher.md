---
arg worktree abs-path
arg pin your dispatch pin
arg pr M
arg testCmd testCmd
arg scratch scratch
path worktree
path scratch
literal your name
literal outcome
---
## kind: fresh, repair
Finish PR <M>. Your arguments are the whole of your per-dispatch task:

pr: <M>
worktree: <abs-path>
pin: <your dispatch pin>
testCmd: <testCmd>
scratch: <scratch>

Your report is a file, `<scratch>/reports/<your name>.json`, `<your name>` the
`finisher-pr-<M>[-x]` you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print finisher` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate finisher <scratch>/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> <scratch>/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
## kind: repair

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

An earlier finisher on this PR reported `labelled`, but its read-back did not carry `ready-to-merge`: you are the repair finisher. Duty 3's script decides whether the label is on, as your agent definition says.
