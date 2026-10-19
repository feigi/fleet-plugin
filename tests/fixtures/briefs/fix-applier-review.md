You are ALREADY in worktree `/abs/wt-fix`, whose PR branch is `fix-branch` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. The review is done and its result is the
file below — do not re-review, do not dispatch specialists.

Read `$(~/.fleet/bin/fleet-run --root)/commands/review-and-fix.md` and run **steps 2, 3
and 5 only**: split apply-now/defer, commit, push, file every deferral as its
own issue with the label the finding's state calls for. Skip step 1 — the
review already ran — and steps 4 and 6: the controller owns the CI wait and
dispatches the finisher.

**The review's result is `/abs/scratch-fix/pr3293/run-AbCd1234/review.json`** — the digest first
(`jq '{pr, head, resume, testEnvironment, suiteVerdict, dimensionsRun, dimensionsUnrun, cwdAudit, counts}'`),
then every finding (`jq '.survived'`, `jq '.unverified'`, `jq '.refuted'`).
Read it through `review-and-fix.md`'s **The review result file**, which holds
the rest of the recipes and every ruling on the findings: both
mutual-exclusion scans, the suggested-fix re-derivation, `refuted=false` ≠
apply, per-site measurement for a sibling-site extension, and `testEnvironment`
and `cwdAudit` before any result of the shared test run. Every one of those
rulings is yours — nobody upstream has made one, and the controller never
reads the findings.

**Run `recipe-check.mjs` (below) from the worktree before committing.**
`tests 0` is a FAILED run, not a pass. Red or zero-test → fix it, or move that
finding to defer; never commit over it. **Never `--no-verify`** on a commit you push, or on the push — a failing
hook is a finding you report, not an obstacle you route around. Report the test
result with your SHA. Nothing re-reviews this commit: the review ran against a
snapshot cut before your edits existed, and a refuter checked the finding's
claim, never your patch.

**Before you report, write every ruling to `/abs/scratch-fix/dispositions-<your name>.json`**,
`<your name>` the `fix-pr-3293[-x]` you were dispatched as — the record the controller checks with
`dispositions-check.mjs` before it dispatches any finisher.

**A red `CHECKCMD-1` is yours to judge.** Read what it reports and fix every
finding in a file the PR changes, including lines you did not edit — CI checks
whole files. Never edit a file the PR does not otherwise change: a finding there
is a stale base, not your code, so rebase onto `origin/main` and re-run; still
red → push nothing and report that cause. No fix command is recorded; the Check
step only reports. A hook that rewrites a file the PR does not otherwise change
is the same stale base. Stage every change of your own before the commit that
runs the hook, so every change still unstaged after it is the hook's alone:
never stage those, `git restore -- <that path>` for each such path alone, then
rebase and re-run.

**`recipe-check.mjs` is how you run `CHECKCMD-1` and `TESTCMD-1`:**
`~/.fleet/bin/fleet-run recipe-check.mjs --member <your name> --testCmd "TESTCMD-1" --reports /abs/scratch-fix/reports`,
from the worktree, after `git add` and before the commit — `TESTCMD-1` copied
verbatim as the one quoted argument. It runs the Recipe's Check step,
`CHECKCMD-1`, then `TESTCMD-1`, against the staged tree and records both beside
your report. Run it again after any content change or rebase: the controller
refuses an `applied` report whose head's tree has no green record, and a
message-only amend keeps the record valid. Exit 1 is red; exit 75 is no test
result — no slot was free and nothing ran — so run it again.

Your report is a file, `/abs/scratch-fix/reports/<your name>.json`, `<your name>` the
`fix-pr-` name you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print fix-pr` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate fix-pr /abs/scratch-fix/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-fix/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

Push, write your report, exit; never poll a CI run.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
