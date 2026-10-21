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
literal that path
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

**Run `recipe-check.mjs` (below) from the worktree before committing.**
`tests 0` is a FAILED run, not a pass. Red or zero-test → fix it, or move that
finding to defer; never commit over it. **Never `--no-verify`** on a commit you push, or on the push — a failing
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
Run `recipe-check.mjs` (below) from the worktree before you push, then push with
`~/.fleet/bin/fleet-run push-sync.mjs --branch <branch>`. Report the new head, or that no conflict was
left.
## kind: red-check
Read the failing job's log and fix the cause. Run `recipe-check.mjs` (below)
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
step only reports. A hook that rewrites a file the PR does not otherwise change
is the same stale base. Stage every change of your own before the commit that
runs the hook, so every change still unstaged after it is the hook's alone:
never stage those, `git restore -- <that path>` for each such path alone, then
rebase and re-run. An untracked path no ignore rule covers, still present after
that commit, is the hook's alone too, since your own new files were staged with
the rest: never stage it, `git clean -fd -- <that path>` for each such path
alone, a directory as `recipe-check.mjs` lists it (`dir/`), then rebase and
re-run. That command deletes only the path it names and never an ignored file.

**`recipe-check.mjs` is how you run `<checkCmd>` and `<testCmd>`:**
`~/.fleet/bin/fleet-run recipe-check.mjs --member <your name> --testCmd "<testCmd>" --reports <scratch>/reports`,
from the worktree, after `git add` and before the commit — `<testCmd>` copied
verbatim as the one quoted argument. It runs the Recipe's Check step,
`<checkCmd>`, then `<testCmd>`, against the staged tree and records both beside
your report. Run it again after any content change or rebase: the controller
refuses an `applied` report whose head's tree has no green record, and a
message-only amend keeps the record valid. After the commit, and before you
push or report, compare `git rev-parse 'HEAD^{tree}'` with the `tree` field of
your record, `<scratch>/reports/<your name>.check.json`. A commit hook that
rewrote and re-staged files after the record was written makes the two differ.
When they do, list the paths it changed,
`git diff --name-only "$(jq -r .tree <scratch>/reports/<your name>.check.json)" HEAD`.
If the PR changes every listed path anyway, run `recipe-check.mjs` again with
the same arguments: right after the commit the index holds the committed tree,
so the re-run runs both commands on that tree and records it, leaving the
head's sha as it is. A listed path the PR does not otherwise change is a stale
base the hook staged rather than left unstaged, and a re-run would record it
green: `git fetch origin && git rebase origin/main`, take the commit back with
`git reset --soft HEAD^`, put each such path alone back with
`git restore --source=HEAD --staged --worktree -- <that path>`, run
`recipe-check.mjs`, then `git commit -C ORIG_HEAD` and compare again. A hook
that stages such a path again on the rebased base → push nothing and report
that cause. Equal trees need no re-run. Exit 1 is red; exit 75 is no test
result — no slot was free and nothing ran — so run it again.

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
