You are ALREADY in worktree `/abs/wt-conflict`, whose PR branch is `conflict-branch` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR sits on a
conflict hold and you are here to clear it — do not review, do not dispatch
specialists.

Bring `conflict-branch` current with `origin/main`, resolving every conflict by the
**No-undo audit** in `$(~/.fleet/bin/fleet-run --root)/commands/run-merge-bot.md`.
Run `recipe-check.mjs` (below) from the worktree before you push, then push with
`~/.fleet/bin/fleet-run push-sync.mjs --branch conflict-branch`. Report the new head, or that no conflict was
left.

**A red `CHECKCMD-2` is yours to judge.** Read what it reports and fix every
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
re-run. That command never deletes an ignored file. A path the re-run still
refuses after that clean → push nothing and report that cause.

**`recipe-check.mjs` is how you run `CHECKCMD-2` and `TESTCMD-2`:**
`~/.fleet/bin/fleet-run recipe-check.mjs --member <your name> --testCmd "TESTCMD-2" --reports /abs/scratch-conflict/reports`,
from the worktree, after `git add` and before the commit — `TESTCMD-2` copied
verbatim as the one quoted argument. It runs the Recipe's Check step,
`CHECKCMD-2`, then `TESTCMD-2`, against the staged tree and records both beside
your report. Run it again after any content change or rebase: the controller
refuses an `applied` report whose head's tree has no green record, and a
message-only amend keeps the record valid. After the commit, and before you
push or report, compare `git rev-parse 'HEAD^{tree}'` with the `tree` field of
your record, `/abs/scratch-conflict/reports/<your name>.check.json`. A commit hook that
rewrote and re-staged files after the record was written makes the two differ.
When they do, list the paths it changed,
`git diff --name-only "$(jq -r .tree /abs/scratch-conflict/reports/<your name>.check.json)" HEAD`.
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

Your report is a file, `/abs/scratch-conflict/reports/<your name>.json`, `<your name>` the
`fix-pr-` name you were dispatched as, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print fix-pr` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate fix-pr /abs/scratch-conflict/reports/<your name>.json`
answers `valid`. Your final message is then one line,
`<your name>: <outcome> /abs/scratch-conflict/reports/<your name>.json`, `<outcome>` the
report's `outcome`.

Push, write your report, exit; never poll a CI run.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.
Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.
