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
~/.claude/skills/fleet/scripts/ci-state.mjs --pr <n>
```

`ci-state.mjs` does the whole run-binding check and prints a `verdict` with reasons: it binds the run to the PR head, requires run `status` **completed** and **every expected job present** (the list derived from the workflow file, not hardcoded), and treats `skipped` as not-green. Exit 0 only when genuinely green. A force-push cancels the run under it, but finished jobs keep their conclusions and keep being reported — absent jobs read as `pending`, inherited ones as `pass`, and the script's job-presence check is what catches both.

**Query at labelling time; never label off a watcher's summary.** A monitor stitches its event from reads taken at different moments, so it can stream `RUN COMPLETE: success` under a run id whose authoritative job list is a failure — observed: streamed all-five-green for run `165158547`, while `gh run view 165158547 --json jobs` reported `rebase-check failure` with three jobs **skipped**; the green belonged to the previous run on an earlier head. Head-SHA binding does not catch this, because the *run id* is wrong rather than the head. Watchers are for waking you up, never for deciding.

**A conclusion is not stable even for a fixed run id on an unchanged head.** A rerun rewrites the existing run in place instead of creating a new one, so a run you read as `success` can later read `failure` with nothing pushed. Observed twice in one run, on two PRs: a refresh workflow re-ran the currency check after `main` advanced and flipped the same id on the same SHA. So a cached conclusion is not merely stale, it can be *inverted* — re-query at the moment you decide. Also note the newest run on a branch is often a label or policy workflow rather than CI, so `--limit 1` can hide the CI result entirely.

**`skipped` is not `passed`.** When the currency check fails, the heavy jobs report `skipped` — they did **not** execute. A board of `check: success` / currency `failure` / three `skipped` reads as "nearly green" and is in fact *three required suites unverified*. That is not grounds to withhold the label (see below), but if you label under it, say the label rests on the checks that actually ran plus your own verification — never call it "CI green".

**Do NOT rebase to label, and do not require a zero behind-count.** Your green proves the diff is sound *against the base it was tested on* — that is what the label attests, and it does not expire. Requiring currency forces a full CI cycle every time any sibling lands (six wasted cycles in one run) and re-establishes nothing the merge bot will not. Rebase only when pushing a change, or when the bot bounces it back.

Three claims, none substituting for another: **run-binding** (this green belongs to this SHA) · **your green** (correct against its base) · **the bot's post-rebase green** (still correct against current `main`). Only the third catches a sibling renaming a symbol you use — a rebase can apply cleanly and still break the build, which is why it is the bot's job and not yours.

## Specialists

**Prefer the workflow.** `Workflow({name: "review-pr", args: {pr, branch, worktree, testCmd, scratch}})` runs the fan-out with `agent()` returning **into the script**, so no report can go undelivered — the failure that cost one fleet five reports on one PR and four on another. It cuts the snapshot itself and adversarially verifies every finding. Needs explicit opt-in to multi-agent orchestration; without it, dispatch manually under the rules below, which are what the workflow encodes.

It cannot ask the user anything and cannot wait on CI — rebasing, watching checks, binding and labelling stay here.

- **Spawn unnamed.** Named agents cannot name children (`teammates cannot spawn teammates`). On that error drop the name; never downgrade to a solo review.
- **Say read-only.** `pr-review-toolkit` agents hold write tools; one committed and pushed during a report-only dispatch. No commits, no pushes, no worktree edits.
- **Cut TWO trees, not one — a shared snapshot is not enough.** Mutation probing is a *write*, so a mutating specialist and read-only specialists cannot share a copy: the readers then observe the mutant exactly as if it were real code. Give them `snap-ro`, pristine and **never written**, and one private copy **per mutating specialist**. Keep every one out of the worktree. Observed with a single shared snapshot: three specialists read two *different* in-flight mutations, one reporting the PR's own bug as still present; elsewhere three watched their file go clean → `M` mid-analysis; twice a reviewer came one step from filing a false finding. Reverting a probe does not help — it leaves a window where every concurrent reader sees a lie, and serializing does not close it because readers are concurrent with the *mutator*.
- **Do not trust the obvious contamination check.** `diff -rq` and `md5` against the mutating tree both returned *clean* — because the probe had been reverted between the two reads. A clean diff against a live tree is not evidence in either direction; only `snap-ro` and the object store settle it.
- **`git archive` carries tracked files only.** No `node_modules`, no gitignored runner or config. Provision in the same step — symlink `node_modules`, copy in what the runner needs — or specialists silently have no runnable suite and reason from source instead of measuring. That failure is invisible: you get confident prose where you asked for a measurement.
- **Some suites cannot be validly run from a snapshot at all.** Anything deriving identity from the checkout breaks — `derive_workspace_id` shells out to `git rev-parse`, and a `git archive` copy is not a git repo, so it falls back to the directory basename and the hook tests fail on the *name*. Naming the dir after the repo makes them pass **by coincidence, not correctness**. Run those in the real worktree or not at all.
- **Hand them the worktree's `./agent-test` runner and their own scratch dir.** Specialists inherit no environment. One falling back to the default config runs a `globalSetup` that brings the shared compose stack up and tears it down, recreating the DB mid-run for every sibling. **The snapshot does not cover this** — the compose project name comes from the environment, not the working directory, so three agents on three copies still collide. "I'm on my own copy" is the intuition that skips the runner.
- **Completion is not delivery — ping each specialist for its report.** Five finished with none surfacing; reports reach the *controller*, not you. A ruling citing a report you do not hold gets verified from source, never applied on trust.
- **Collect every report, then apply.** Editing while they read is the same defect as probing — one specialist reviewed uncommitted code that was never in the PR diff.

Tell readers **`git show <sha>:<path>` is the source of truth** — the object store cannot be contaminated by any agent, needs no copy, and touches nothing. Make it the default for settling *what the PR contains*, not a fallback. A finding that disagrees with it is a probe artifact.

**Scale the fan-out to the diff.** Six specialists on an 8-line docs-banner PR costs the same wall clock as six on a production refactor. Two or three for annotation-only or single-file changes; the full set for production code. Absent an explicit number, the default is the full set every time.

**If the ticket is a *correction* — stale docs, wrong comments, bad citations — hunt the defect inside the correction itself.** Four such tickets in one fleet run each shipped a new wrong claim in the fix: a misattributed package, a three-item list at inverted polarity (two items were the *negations* of the claims being marked stale, so the banner asserted currently-true facts were false), a commit body citing a line that held something else, and a banner whose own supporting sentence confirmed the bullet it marked as wrong. Nobody hunts this unprompted because the diff "obviously" improves accuracy. Read every corrected sentence literally and ask whether each clause is true under that reading.

## Judging findings

- **Verify, don't reason.** "Removing X makes this compile/fail" → compile it in an isolated copy. One command. Four successive confident claims about one file were all wrong; the compiler settled it.
- **Distrust negative claims hardest.** "Nothing else references this", "the sweep is clean" — most likely false, least likely checked: a grep that found nothing looks like a grep never run. Make the specialist state its search scope. Negative claim vs specific finding with paths → paths win.
- **Mutation-verify any "this test pins X".** Apply the mutation, confirm *that* test fails, revert. Then one it should **not** catch, staying green — else you proved it fails, not that it discriminates. **One syntactic form is not the class:** a stripper killing `// whole-line` passed a guard that `code; // trailing` walked through.
- **Comments are findings**, and the most common one. A comment asserting what the code does not do is a defect. One run shipped five: an invented citation, a mis-stated failure mode, a test file named as covering what it had zero coverage of, an overstated cast fix, a claim its own dependency's source contradicts. Check every added assertion against the tree — **including comments in files this diff does not touch** but whose claims it falsifies (test-name references, "N of 3" counts, tracking-issue pointers).
