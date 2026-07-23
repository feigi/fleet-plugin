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

- **Spawn unnamed.** Named agents cannot name children — `teammates cannot spawn teammates`. On that error drop the name; do not downgrade to a solo review.
- **Say read-only.** `pr-review-toolkit` agents hold write tools; one has committed and pushed during a report-only dispatch. No commits, no pushes, no worktree edits.
- **Mutating specialists use an isolated `git archive HEAD` copy, never the worktree.** "Revert every probe" is not sufficient — it leaves a window where concurrent readers observe a lie. Serializing does not help; readers are concurrent with the mutator. Observed: three specialists, one worktree, two read different in-flight mutations, one saw the PR's own bug as still present.

- **Pass your isolation envelope down verbatim.** Specialists do not inherit it. Give each one the test invocation (`--config vitest.ci.config.ts`, or your `TEST_COMPOSE_PROJECT`/`TEST_POSTGRES_PORT`/`TEST_OLLAMA_PORT`) and its own scratch dir. Omit it and a specialist runs the default config, whose `globalSetup` does `docker compose -p agent-brain-test up` then `down --remove-orphans` — dropping and recreating the shared DB mid-run for every sibling.
- **Completion is not delivery — ping each specialist for its report.** Five finished with none surfacing; their reports reach the *controller*, not you. A ruling citing a report you do not hold gets verified from source, never applied on trust.
- **Do not edit the worktree while specialists read it.** Applying fixes mid-review is the same defect as probing: three specialists watched one file go clean → `M` under them and re-baselined mid-run, and a fourth reviewed uncommitted code that was never in the PR diff. Collect every report, then apply.

Tell readers **`git show HEAD:<path>` is the source of truth**. A finding that disagrees with it is a probe artifact.

## Judging findings

- **Verify, don't reason.** "Removing X makes this compile/fail" → compile it in an isolated copy. One command. Four successive confident claims about one file were all wrong; the compiler settled it.
- **Distrust negative claims hardest.** "Nothing else references this", "the sweep is clean" — most likely false, least likely checked: a grep that found nothing looks like a grep never run. Make the specialist state its search scope. Negative claim vs specific finding with paths → paths win.
- **Mutation-verify any "this test pins X".** Apply the mutation, confirm *that* test fails, revert, record it. Then a mutation it should **not** catch, staying green — else you proved it fails, not that it discriminates. **One syntactic form is not the class:** a stripper that kills `// whole-line` passed a guard that `code; // trailing` walked straight through.
- **Comments are findings.** A comment asserting what the code does not do is a defect, and the most common one. One fleet run shipped five: an invented citation, a mis-stated failure mode, a test file named as covering what it had zero coverage of, an overstated cast fix, a claim its own dependency's source contradicts. Check every added factual assertion against the tree.
