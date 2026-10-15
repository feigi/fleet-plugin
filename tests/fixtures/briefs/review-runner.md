Run the review of PR 3297 and report where its result is. Your five arguments are
the whole of your task:

pr: 3297
branch: rr-branch
worktree: /abs/wt-rr
testCmd: TESTCMD-6
scratch: /abs/scratch-root

`scratch` is the scratch root itself, the absolute path `scratch-root.mjs` prints,
never a directory whose last component is `pr` plus digits: the review creates
that partition under the root itself.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
