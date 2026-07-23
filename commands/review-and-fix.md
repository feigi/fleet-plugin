---
description: review a PR, apply recommended actions, push, watch checks until green
argument-hint: [pr-number]
---

1. **Rebase before reading any CI.** `git rev-list --count origin/<branch>..origin/main` — non-zero → rebase, `--force-with-lease`, read CI only on the new head. Green does not decay visibly: stale passes stay displayed, and `rebase-check` can be stale-**green**. Behind-count is the only honest signal.
2. Run `/pr-review-toolkit:review-pr $ARGUMENTS` (no arg → current branch). See **Specialists** — those three constraints are not optional.
3. Plan recommended actions. Split explicitly into **apply now** / **defer**. A finding is deferred, never dropped.
4. Commit, push.
5. Watch checks until green; fix failures, repeat from 4.
6. File each deferred finding: `gh issue create --label ready-for-agent` with the finding, `file:line`, why deferred, `Deferred from PR #<pr> review`. `gh issue list --search` first — comment on an existing follow-up, don't duplicate. Post numbers as one PR comment.
7. Green **and** deferrals filed → `gh pr edit <pr> --add-label ready-to-merge`. Do not merge.

**Bind green to the *run*, not to check conclusions.** `gh pr checks` aggregates job results across runs and reports a `pass` inherited from a **cancelled** run on a superseded SHA. Head-SHA binding does not catch it — the head is genuinely correct; only the conclusions belong to another commit.

```bash
rid=$(gh run list --branch <branch> --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$rid" --json headSha,status,conclusion
gh run view "$rid" --json jobs --jq '.jobs[] | "\(.name) \(.status)/\(.conclusion // "-")"'
git rev-parse origin/<branch>; gh pr view <n> --json headRefOid
```

Require all four: run `headSha` == branch head == `headRefOid`; run `status` **completed**; and **every expected job present in that run**. A force-push cancels the run under it, but jobs that already finished keep their conclusions and keep being reported. Missing jobs read as `pending` in the summary and as `pass` once inherited — absent, not pending.

## Specialists

**Prefer the workflow.** `Workflow({name: "review-pr", args: {pr, branch, worktree, testCmd, scratch}})` runs the fan-out with `agent()` returning **into the script**, so no report can go undelivered — the failure that cost this fleet five reports on one PR and four on another. It also cuts the snapshot itself and adversarially verifies every finding before returning. It needs the caller's explicit opt-in to multi-agent orchestration; without that, dispatch manually and apply the rules below, which are the same rules the workflow encodes.

The workflow cannot ask the user anything and cannot wait on CI — rebasing, watching checks, binding and labelling stay here.

- **Spawn unnamed.** Named agents cannot name children — `teammates cannot spawn teammates`. On that error drop the name; do not downgrade to a solo review.
- **Say read-only.** `pr-review-toolkit` agents hold write tools; one has committed and pushed during a report-only dispatch. No commits, no pushes, no worktree edits.
- **Cut one snapshot; every specialist works there, reading or writing.** `git archive HEAD | tar -x -C <dir>` once, hand all of them that path, and keep every one out of the worktree. It cannot change under them, so mutation probes, your own mid-review edits and sibling contention all stop mattering — no coordination needed. Observed without it: three specialists read two *different* in-flight mutations, one reporting the PR's own bug as still present; on another PR three watched their file go clean → `M` mid-analysis. Reverting probes does not help — it leaves a window where every concurrent reader sees a lie, and serializing does not close it because readers are concurrent with the *mutator*.

- **Hand them the worktree's `./agent-test` runner and their own scratch dir.** Specialists inherit no environment. One that falls back to the default config runs a `globalSetup` which brings the shared compose stack up and tears it down — dropping and recreating the DB mid-run for every sibling. **The snapshot does not cover this:** the compose project name comes from the environment, not the working directory, so three agents on three separate copies still collide. Filesystem isolation and stack isolation are different problems — "I'm on my own copy" is the intuition that makes an agent skip the runner.
- **Completion is not delivery — ping each specialist for its report.** Five finished with none surfacing; their reports reach the *controller*, not you. A ruling citing a report you do not hold gets verified from source, never applied on trust.
- **Collect every report, then apply.** Editing while they read is the same defect as probing — and a fourth specialist once reviewed uncommitted code that was never in the PR diff.

Tell readers **`git show HEAD:<path>` is the source of truth**. A finding that disagrees with it is a probe artifact.

## Judging findings

- **Verify, don't reason.** "Removing X makes this compile/fail" → compile it in an isolated copy. One command. Four successive confident claims about one file were all wrong; the compiler settled it.
- **Distrust negative claims hardest.** "Nothing else references this", "the sweep is clean" — most likely false, least likely checked: a grep that found nothing looks like a grep never run. Make the specialist state its search scope. Negative claim vs specific finding with paths → paths win.
- **Mutation-verify any "this test pins X".** Apply the mutation, confirm *that* test fails, revert, record it. Then a mutation it should **not** catch, staying green — else you proved it fails, not that it discriminates. **One syntactic form is not the class:** a stripper that kills `// whole-line` passed a guard that `code; // trailing` walked straight through.
- **Comments are findings.** A comment asserting what the code does not do is a defect, and the most common one. One fleet run shipped five: an invented citation, a mis-stated failure mode, a test file named as covering what it had zero coverage of, an overstated cast fix, a claim its own dependency's source contradicts. Check every added factual assertion against the tree.
