---
arg worktree abs-path
arg branch branch
arg testCmd testCmd
arg checkCmd checkCmd
arg scratch scratch
arg pr pr
arg run run
arg mismatched-record mismatched record
arg violations violations
path worktree
path scratch
path mismatched-record
literal your name
literal outcome
---
## kind: review, dispositions-retry
You are ALREADY in worktree `<abs-path>`, whose PR branch is `<branch>` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. The review is done and its result is the
file below — do not re-review, do not dispatch specialists.

## kind: conflict
You are ALREADY in worktree `<abs-path>`, whose PR branch is `<branch>` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR sits on a
conflict hold and you are here to clear it — do not review, do not dispatch
specialists.

## kind: red-check
You are ALREADY in worktree `<abs-path>`, whose PR branch is `<branch>` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR's `check`
job is red on its current head and you are here to fix it — do not review, do
not dispatch specialists.

## kind: review, dispositions-retry
Read `$(~/.fleet/bin/fleet-run --root)/commands/review-and-fix.md` and run **steps 2, 3
and 5 only**: split apply-now/defer, commit, push, file every deferral as its
own issue with the label the finding's state calls for. Skip step 1 — the
review already ran — and steps 4 and 6: the controller owns the CI wait and
dispatches the finisher.

**The review's result is `<scratch>/pr<pr>/<run>/review.json`** — the digest first
(`jq '{pr, head, resume, testEnvironment, suiteVerdict, dimensionsRun, dimensionsUnrun, cwdAudit, counts}'`),
then every finding (`jq '.survived'`, `jq '.unverified'`, `jq '.refuted'`).
Read it through `review-and-fix.md`'s **The review result file**, which holds
the rest of the recipes and every ruling on the findings: both
mutual-exclusion scans, the suggested-fix re-derivation, `refuted=false` ≠
apply, per-site measurement for a sibling-site extension, and `testEnvironment`
and `cwdAudit` before any result of the shared test run. Every one of those
rulings is yours — nobody upstream has made one, and the controller never
reads the findings.

**Run `<checkCmd>` from the worktree before committing**, copied verbatim. **Run `<testCmd>` from the worktree before committing**, copied verbatim.
`tests 0` is a FAILED run, not a pass. Red or zero-test → fix it, or move that
finding to defer; never commit over it. **Never `--no-verify`** — a failing
hook is a finding you report, not an obstacle you route around. Report the test
result with your SHA. Nothing re-reviews this commit: the review ran against a
snapshot cut before your edits existed, and a refuter checked the finding's
claim, never your patch.

**Before you report, write every ruling to `<scratch>/dispositions-<your name>.json`**,
`<your name>` the `fix-pr-<pr>[-x]` you were dispatched as — the record the controller checks with
`dispositions-check.mjs` before it dispatches any finisher.
## kind: conflict
Bring `<branch>` current with `origin/main`, resolving every conflict by the
**No-undo audit** in `$(~/.fleet/bin/fleet-run --root)/commands/run-merge-bot.md`.
Run `<checkCmd>` and `<testCmd>` from the worktree before you push, then push with
`~/.fleet/bin/fleet-run push-sync.mjs --branch <branch>`. Report the new head, or that no conflict was
left.
## kind: red-check
Read the failing job's log and fix the cause. Run `<checkCmd>` and `<testCmd>`
from the worktree before you push, then push with `~/.fleet/bin/fleet-run push-sync.mjs --branch <branch>`.
Report the new head and **stop**: do not watch, poll or wait for CI — the
controller owns the next run on the pushed head. A red that is not yours to
fix — a flake that passes on rerun, or staleness — gets nothing pushed: report
that instead.
## kind: review, dispositions-retry, conflict, red-check

**A red `<checkCmd>` is yours to judge.** Read what it reports and fix every
finding in a file the PR changes, including lines you did not edit — CI checks
whole files. Never edit a file the PR does not otherwise change: a finding there
is a stale base, not your code, so rebase onto `origin/main` and re-run; still
red → push nothing and report that cause. No fix command is recorded; the Check
step only reports.

Your report is a file, `<scratch>/reports/<your name>.json`, `<your name>` the
`fix-pr-` name you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print fix-pr` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate fix-pr <scratch>/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> <scratch>/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

Push, write your report, exit; never poll a CI run.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
## kind: dispositions-retry

This is the one automatic retry of a dispositions mismatch. The mismatched
member's record is `<mismatched record>`: start from it, and write your own
record as above. The check printed these violations, each naming a bucket, an
index and a rule:

<violations>
