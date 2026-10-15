---
arg pr pr
arg branch branch
arg worktree worktree
arg testCmd testCmd
arg scratch scratch
path worktree
path scratch
---
Run the review of PR <pr> and report where its result is. Your five arguments are
the whole of your task:

pr: <pr>
branch: <branch>
worktree: <worktree>
testCmd: <testCmd>
scratch: <scratch>

`scratch` is the scratch root itself, the absolute path `scratch-root.mjs` prints,
never a directory whose last component is `pr` plus digits: the review creates
that partition under the root itself.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
