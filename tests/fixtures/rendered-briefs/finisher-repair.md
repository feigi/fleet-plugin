Finish PR 3296. Your arguments are the whole of your per-dispatch task:

pr: 3296
worktree: /abs/wt-fin-r
pin: 0123456789abcdef0123456789abcdef01234567
testCmd: TESTCMD-5
scratch: /abs/scratch-fin-r

An earlier finisher on this PR reported `labelled`, but its read-back did not carry `ready-to-merge`: you are the repair finisher. Duty 3's script decides whether the label is on, as above.
