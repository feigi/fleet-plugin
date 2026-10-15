---
arg worktree abs-path
arg pin your dispatch pin
arg pr M
arg testCmd testCmd
arg scratch scratch
path worktree
path scratch
---
## kind: fresh, repair
Finish PR <M>. Your arguments are the whole of your per-dispatch task:

pr: <M>
worktree: <abs-path>
pin: <your dispatch pin>
testCmd: <testCmd>
scratch: <scratch>
## kind: repair

An earlier finisher on this PR reported `labelled`, but its read-back did not carry `ready-to-merge`: you are the repair finisher. Duty 3's script decides whether the label is on, as above.
