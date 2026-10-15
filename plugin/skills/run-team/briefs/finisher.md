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
## kind: repair

An earlier finisher on this PR reported `labelled`, but its read-back did not carry `ready-to-merge`: you are the repair finisher. Duty 3's script decides whether the label is on, as above.
