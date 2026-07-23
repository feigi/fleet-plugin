---
description: review a PR, apply recommended actions, push, watch checks until green
argument-hint: [pr-number]
---

1. Run `/pr-review-toolkit:review-pr $ARGUMENTS` (no arg → current branch). See **Specialists** — those constraints are not optional.
2. Plan the actions. Split explicitly into **apply now** / **defer**. A finding is deferred, never dropped.
3. Commit, push.
4. Watch checks until green; fix failures, repeat from 3.
5. File each deferred finding: `gh issue create --label ready-for-agent` with the finding, `file:line`, why deferred, `Deferred from PR #<pr> review`. `gh issue list --search` first — comment on an existing follow-up, never duplicate. Post the numbers as one PR comment.
6. Green **and** deferrals filed → `gh pr edit <pr> --add-label ready-to-merge`. Do not merge.

**Bind green to the *run*, not to check conclusions.** `gh pr checks` aggregates across runs and reports a `pass` inherited from a **cancelled** run on a superseded SHA. Head-SHA binding misses it — the head is genuinely right; only the conclusions belong to another commit.

```bash
rid=$(gh run list --branch <branch> --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$rid" --json headSha,status,conclusion
gh run view "$rid" --json jobs --jq '.jobs[] | "\(.name) \(.status)/\(.conclusion // "-")"'
git rev-parse origin/<branch>; gh pr view <n> --json headRefOid
```

Require three: run `headSha` == branch head == `headRefOid`; run `status` **completed**; **every expected job present in that run**. A force-push cancels the run under it, but finished jobs keep their conclusions and keep being reported. Absent jobs read as `pending`, inherited ones as `pass`.

**Query at labelling time; never label off a watcher's summary.** A monitor stitches its event from reads taken at different moments, so it can stream `RUN COMPLETE: success` under a run id whose authoritative job list is a failure — observed: streamed all-five-green for run `165158547`, while `gh run view 165158547 --json jobs` reported `rebase-check failure` with three jobs **skipped**; the green belonged to the previous run on an earlier head. Head-SHA binding does not catch this, because the *run id* is wrong rather than the head. Watchers are for waking you up, never for deciding.

**Do NOT rebase to label, and do not require a zero behind-count.** Your green proves the diff is sound *against the base it was tested on* — that is what the label attests, and it does not expire. Requiring currency forces a full CI cycle every time any sibling lands (six wasted cycles in one run) and re-establishes nothing the merge bot will not. Rebase only when pushing a change, or when the bot bounces it back.

Three claims, none substituting for another: **run-binding** (this green belongs to this SHA) · **your green** (correct against its base) · **the bot's post-rebase green** (still correct against current `main`). Only the third catches a sibling renaming a symbol you use — a rebase can apply cleanly and still break the build, which is why it is the bot's job and not yours.

## Specialists

**Prefer the workflow.** `Workflow({name: "review-pr", args: {pr, branch, worktree, testCmd, scratch}})` runs the fan-out with `agent()` returning **into the script**, so no report can go undelivered — the failure that cost one fleet five reports on one PR and four on another. It cuts the snapshot itself and adversarially verifies every finding. Needs explicit opt-in to multi-agent orchestration; without it, dispatch manually under the rules below, which are what the workflow encodes.

It cannot ask the user anything and cannot wait on CI — rebasing, watching checks, binding and labelling stay here.

- **Spawn unnamed.** Named agents cannot name children (`teammates cannot spawn teammates`). On that error drop the name; never downgrade to a solo review.
- **Say read-only.** `pr-review-toolkit` agents hold write tools; one committed and pushed during a report-only dispatch. No commits, no pushes, no worktree edits.
- **Cut one snapshot; every specialist works there, reading or writing.** `git archive HEAD | tar -x -C <dir>` once, hand all of them that path, keep every one out of the worktree. It cannot change under them, so mutation probes, your own mid-review edits and sibling contention all stop mattering — no coordination needed. Observed without it: three specialists read two *different* in-flight mutations, one reporting the PR's own bug as still present; elsewhere three watched their file go clean → `M` mid-analysis. Reverting probes does not help — it leaves a window where every concurrent reader sees a lie, and serializing does not close it because readers are concurrent with the *mutator*.
- **Hand them the worktree's `./agent-test` runner and their own scratch dir.** Specialists inherit no environment. One falling back to the default config runs a `globalSetup` that brings the shared compose stack up and tears it down, recreating the DB mid-run for every sibling. **The snapshot does not cover this** — the compose project name comes from the environment, not the working directory, so three agents on three copies still collide. "I'm on my own copy" is the intuition that skips the runner.
- **Completion is not delivery — ping each specialist for its report.** Five finished with none surfacing; reports reach the *controller*, not you. A ruling citing a report you do not hold gets verified from source, never applied on trust.
- **Collect every report, then apply.** Editing while they read is the same defect as probing — one specialist reviewed uncommitted code that was never in the PR diff.

Tell readers **`git show HEAD:<path>` is the source of truth**. A finding that disagrees with it is a probe artifact.

## Judging findings

- **Verify, don't reason.** "Removing X makes this compile/fail" → compile it in an isolated copy. One command. Four successive confident claims about one file were all wrong; the compiler settled it.
- **Distrust negative claims hardest.** "Nothing else references this", "the sweep is clean" — most likely false, least likely checked: a grep that found nothing looks like a grep never run. Make the specialist state its search scope. Negative claim vs specific finding with paths → paths win.
- **Mutation-verify any "this test pins X".** Apply the mutation, confirm *that* test fails, revert. Then one it should **not** catch, staying green — else you proved it fails, not that it discriminates. **One syntactic form is not the class:** a stripper killing `// whole-line` passed a guard that `code; // trailing` walked through.
- **Comments are findings**, and the most common one. A comment asserting what the code does not do is a defect. One run shipped five: an invented citation, a mis-stated failure mode, a test file named as covering what it had zero coverage of, an overstated cast fix, a claim its own dependency's source contradicts. Check every added assertion against the tree — **including comments in files this diff does not touch** but whose claims it falsifies (test-name references, "N of 3" counts, tracking-issue pointers).
