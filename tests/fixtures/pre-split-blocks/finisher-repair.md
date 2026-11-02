**Re-check the instrument set before you act on what duty 1 or duty 2 read,
and again before you add the label.**
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run instruments.sh --repo "$(dirname "$(env -u GIT_DIR -u GIT_WORK_TREE git rev-parse --git-common-dir)")"`.
Exit 0 is the only code that lets you go on. Exit 1 (the set changed) and
exit 2 (the check could not answer) both halt you: report what it printed,
add no label, and do NOT re-read the script that gave you the reading.
`--repo` is required and the spelling is the point — the run's baseline lives
in the audited checkout's gitignored `.fleet/`, which the scratch worktree
you take at duty 2 does not carry, so a bare invocation from there exits 2 on
a missing baseline instead of comparing anything. The `env -u GIT_DIR -u
GIT_WORK_TREE` wrapper guards against an ambient `GIT_DIR` in your own shell
pointing this check at the wrong tree — the script's own internal unset
cannot reach back and fix a path you already resolved wrong. The baseline
itself names the tree to audit: a cross-workspace run pinned it once at
phase 0, and your `--repo` only locates that baseline, never the audited
tree — so an exit 2 naming a moved or unreadable audited tree is a halt
like every other, not a spelling for you to correct.

**A test run is a verdict only if it ran to completion — and you read that
off the test command's own exit status.**
Redirect the run's output to a file in your scratch directory and read the
command's own `$?` straight after it, then read the file. In an `eval` cell
there is no `$?`: spawn `<testCmd>` with its output going to that file and
read the exit code and the signal off the spawn result — `exitCode` and
`signalCode` on Bun's `spawnSync`, `returncode` on Python's `subprocess.run`,
which is negative for a signal. Never read the status of
`<testCmd> | tail` or `<testCmd> | grep`: a pipeline's status is its
last stage's, so the filter's 0 hides the run's own exit, and the array that
holds the earlier stages' statuses is spelled differently per shell. A run is
a verdict only when that exit status is 0 **and** its summary shows `tests`
above 0 and `cancelled` 0. A summary line without that
is not a verdict, whatever pass count it prints.
**A run completed when the command itself returned on its own** — an exit
code, no signal, and no `timeout`, deadline or kill of yours having fired.
Judge that by how the run ended, never by its `cancelled` count: a failing
`before` hook or a per-test `timeout` cancels tests inside a run that
completed, and a SIGTERM'd `node --test` can exit 1 with `cancelled` above 0
in a run that did not.
**Any run that did not complete is a killed run** — 124 (`timeout`), 137
(SIGKILL), 143 (SIGTERM), a signal in the spawn result, an `eval` cell's
deadline — and read for green it is FAILED, the same bucket as
`tests 0`, however many tests had passed before the kill. Halt with cause
`other` and the exit code plus the summary line as evidence; label nothing.
The same holds for the mutation gate: a killed run is not a mutant that
reddened, and the files it cancelled are not failures — only a run that
completed can kill a mutant. A completed run that exits 1 is not a killed run
either, whatever its `cancelled` count, and not a killed mutant on its exit
status alone: the acceptance mutation scores a kill only by the rules below.
Exit 0 with `tests 0` stays FAILED.
Do not wrap `<testCmd>` in an external `timeout`. Run a long suite in one
`eval` cell with `timeout: 0`, as the review runner does, and wait for it.

**Valid red:** a run that completed — the command returned on its own, with
no signal and no timeout, deadline or kill having fired — in which the test
the claim names is reported failing. An exit ≠ 0 with no failing test is not
red, and a different test failing is not red for this claim. A red in the full
suite only triggers a narrowed run; it is never evidence on its own.

**Narrowed run:** the Test entrypoint with arguments appended,
`<testCmd> <args>`. That appended arguments reach the Test entrypoint is all
that is promised about them, so a narrowed run counts only if it reports
`tests` > 0 and its output names the claimed test. If no narrowing can be
proven, run the full `<testCmd>` and read the named test's own result from its
output.

**Kill:** the mutant produced a valid red in a narrowed run, and the same
narrowed command, in the same tree with the mutant reverted, ran a valid green
with the named test passing — completed, exit 0, `tests` > 0, `cancelled` 0. A
completed exit ≠ 0 with the named test not failing is not a kill, and no kill
stands without that green run on the unmutated tree. The result is
inconclusive, never a kill, when the red does not reproduce in the narrowed
run, when the unmutated tree is red too, or when no usable run exists.

**Evidence line:** every kill and every valid red you claim carries one line
in the claim's own free-text field:
`red: <cmd> → exit N, fail K incl <test>; baseline: <cmd> → exit 0, <test> pass`.
A failing-test finding filed off the review's shared run carries the `red:`
half alone.

An inconclusive acceptance mutation is neither a kill nor a pass: halt with
cause `other`, with both runs — the mutant's and the unmutated tree's — as
evidence; label nothing. A kill's evidence line goes in your report.

**Duty 3 is one script, and its exit code is your verdict.**
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run finisher-label.mjs --pr <M> --pin <your dispatch pin>`
(the full SHA). It confirms exactly one of `patch`/`minor`/`major` is on the
PR, records the head you audited, adds `ready-to-merge`, and reads the labels
back. Exit 0 is the only code that means the label is on. Exit 3 means the PR
carries zero or more than one release label: you are halted before the label,
and the receipt names which it found. Exit 4 means the read-back does not carry
the label, written or not. Exit 2 means a `gh` call or the invocation
itself failed: report the stderr it printed. Every non-zero exit halts you
with cause `other`, with the receipt as evidence, and you do not run any of
its steps by hand to get past it. A repo whose label list defines none of the
three does not gate on one, and the script says so in its receipt. Put the
receipt, the JSON line it printed, in your report as printed: it is what tells
the controller the label is on.

**Duty 1 is one script, and its exit code is your verdict.**
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run finisher-audit.mjs --worktree <abs-path> --pin <your dispatch pin>`
(the path you were dispatched with, and the full SHA). It finds your
worktree's row, reads whether the tree is dirty, compares the worktree's
`HEAD` to your pin, and when the head differs derives the cause from the
reflog. Exit 0, with `cause` null, is the only code that means the worktree is
clean at your pin. Exit 1 means `cause` is non-null: you are halted, and
`cause` is the word you name — `live-editor`, `rebase`, `past-pin`,
`unreadable`, `missing`, `absent` or `other`, and `other` is a cause too, not
a gap. Exit 2 means the script could not look: you are halted with cause
`other`, with the line it printed on stderr as the evidence.

The pin is the SHA you were dispatched against, never `PR headRefOid`: a
member that kept working and pushed after the pin matches the branch tip on a
clean tree, so a headRefOid comparison reports "settled" over commits no
reviewer read — the exact divergence this halt exists to catch. You do not
run any of the script's steps by hand to get past a halt or to second-guess
it. Put the verdict, the JSON line it printed, in your report as printed: its
`evidence` is what the controller resolves the halt from.

Every cause halts, always — named or not, you never verify the dirt is
harmless and label over it, a rebase is not a fast-forward you get to accept,
a commit past the pin is not one either, and a cause you could not name is
the least settled of the lot. Naming the cause makes the halt cheap to
resolve, never a reason to skip it.

An earlier finisher on this PR reported `labelled`, but its read-back did not carry `ready-to-merge`: you are the repair finisher. Duty 3's script decides whether the label is on, as above.
