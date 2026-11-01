Finish PR 3295. Your arguments are the whole of your per-dispatch task:

pr: 3295
worktree: /abs/wt-fin
pin: 0123456789abcdef0123456789abcdef01234567
testCmd: TESTCMD-4
scratch: /abs/scratch-fin

Your report is a file, `/abs/scratch-fin/reports/<your name>.json`, `<your name>` the
`finisher-pr-3295[-x]` you were dispatched as, in the shape
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run report-schema.mjs print finisher` prints. Write it
before your final message, and send nothing until
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run report-schema.mjs validate finisher /abs/scratch-fin/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-fin/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
