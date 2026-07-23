---
description: merge every ready-to-merge open PR in numeric order — rebase, wait green, merge, never jumping a related PR
---

Set the goal, then work it until no open PR is left:

`/goal Merge all agent-brain PRs in numeric order if labeled ready-to-merge. Rebase -> Wait for checks green -> check for the ready-to-merge label -> merge if labeled. Never merge past a lower-numbered PR whose work is related — wait for its label instead.`

Only `ready-to-merge` PRs are in scope — it is the author's sign-off. Never add the label yourself.

## Order, and the hold rule

Lowest number first. But the label alone does not authorize a merge: **a labeled PR must not jump a lower-numbered open PR touching related work.** Numeric order is the author's intended order; jumping it silently rebases the lower PR onto changes it was never written against.

Before touching labeled PR `N`, list every open PR below `N` lacking the label. For each, decide related or not:

```bash
lower=$(mktemp); this=$(mktemp)
gh pr diff <lower-pr> --name-only | sort -u > "$lower"
gh pr diff <N> --name-only | sort -u > "$this"

echo "--- shared files ---"
comm -12 "$lower" "$this"
echo "--- shared module names (same file moved/split across dirs) ---"
comm -12 <(xargs -n1 basename < "$lower" | sed 's/\.test\.ts$//;s/\.ts$//' | sort -u) \
         <(xargs -n1 basename < "$this" | sed 's/\.test\.ts$//;s/\.ts$//' | sort -u)
echo "--- shared directories ---"
comm -12 <(xargs -n1 dirname < "$lower" | grep -vx '\.' | sort -u) \
         <(xargs -n1 dirname < "$this" | grep -vx '\.' | sort -u)
```

**Any** of the three producing output means related. Path equality alone is too weak: a repo mid-migration has `src/…/foo.test.ts` in one PR and `tests/unit/…/foo.test.ts` in the other — same module, zero shared paths.

Two false positives in signal 3:

- **Repo root (`.`) is excluded above.** Every top-level file shares it, so it fires on PRs with nothing in common.
- **A bare top-level directory (`docs`, `tests`, `src`) is weak evidence.** Two PRs editing different documents under `docs/` are unrelated. Look at the actual files first: same document, module, or config → related. Different subjects sharing an ancestor → not related; proceed and say so.

Directory-only hits prompt investigation. Shared *files* and *module names* are verdicts.

- **Related → HOLD `N`.** Do not rebase, do not merge. Report `held-behind-#<lower>` and move on. The watcher picks it up once the lower PR is signed off and merged.
- **Unrelated → proceed**, and report that it went ahead of `#<lower>` and on what evidence.

Also **related** even with an empty file intersection when:

- both reference the same issue, or were split from one
- one branch is stacked on the other, or their names share an issue/cluster
- they change the same exported symbol, config key, or docs section from different files

Genuinely unclear → **hold**. Waiting costs a label; merging out of order costs a conflict resolution on someone else's branch, and the loser is the PR already reviewed.

**A fired signal is not a verdict — disprove it.** Soft signals fire on deliberately-partitioned PRs. Observed: two PRs sharing two issue refs and all of `reset_hint=` / `resetHint` / `terminalFailure`, provably unrelated — one handed the other a specific emit site in its own body, their exact-string pins were punctuation-distinct so neither could match the other's site, and **both were test-only**. That generalizes: **a test-only PR cannot invalidate what another PR asserts**, and neither can a docs-only one.

Obeying a fired signal blindly stalls the queue on a non-conflict; ignoring one is sloppy. Do the work, report which evidence settled it.

## Per-PR sequence

For each labeled PR clearing the hold rule, lowest first:

1. Rebase onto `origin/main`; push `--force-with-lease` if it moved. The branch usually lives in a worktree (`git worktree list`) — rebase there, not the main checkout. Run the **no-undo audit** first.

2. Watch checks settle **on the rebased head**. A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching. A stale `rebase-check` failure usually means step 1 has not landed; `integration` and `mutation` skip behind it.

   **Hold the wait inside one blocking command — you are turn-based and cannot "keep an eye on" a run.** If you push and then end your turn, your pass stops there and nothing resumes it: whatever wakes you is external and may never come. Observed repeatedly — a bot rebases, pushes, goes idle, and the queue silently stalls with the PR one command from merging. Block instead:

   ```bash
   gh run watch <run-id> --exit-status    # returns only when the run reaches a terminal state
   ```

   Take `<run-id>` from the same `gh run list --json` row you took the head from. A CI cycle here runs ~5-6 minutes; if `gh run watch` outlives your shell timeout, re-issue it — that is still one blocking call per turn, not an idle turn. Never `sleep`-poll in a loop you exit early.

   **`gh run watch` returning is permission to look, not a verdict.** It tells you the run reached a terminal state; it does not tell you which one, and a rerun can rewrite that state in place afterwards. Re-query `gh run view <run-id> --json jobs,attempt` for the decision — see step 3 and the re-query rule below.

   **You are the only place currency is proven, so never merge on a green from before your rebase.** The reviewer's green attests the diff was correct against *its* base — that claim does not expire and does not cover yours. Only a run on the rebased head shows it is still correct against current `main`.

   **Triage a post-rebase red by what the pre-rebase run did.** Green before, red after, with no change of your own between, means a sibling merge broke this PR semantically — a rebase applies cleanly and still breaks the build when someone renamed a symbol it uses. That is a **finding, not a chore**: report it and hand it back to the reviewer with the failing job. Red both before and after is also the reviewer's. You fix only the mechanical failures you caused: conflict resolution and the release label.

3. Green → re-check immediately before merging (`gh pr view <pr> --json labels,reviewDecision`): the label must still be there (it can be pulled while CI runs) and `reviewDecision` must not be `CHANGES_REQUESTED`. Either fails → skip, say so, move on.

   **Bind the green to the *run*, not to check conclusions.** `gh pr checks` aggregates across runs and reports a `pass` inherited from a **cancelled** run on a superseded SHA — head-SHA binding misses it, since the head is right and only the conclusions belong elsewhere.

   ```bash
   rid=$(gh run list --branch <branch> --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run view "$rid" --json headSha,status,conclusion
   gh run view "$rid" --json jobs --jq '.jobs[] | "\(.name) \(.status)/\(.conclusion // "-")"'
   git rev-parse origin/<branch>; gh pr view <pr> --json headRefOid
   ```

   Require all four: run `headSha` == branch head == `headRefOid`, run `status` **completed**, **every expected job present in that run**. A force-push cancels the run under it; finished jobs keep their conclusions and keep being reported. Absent jobs read as `pending`, inherited ones as `pass`.

   **Re-query at the moment you merge — a conclusion can invert under a fixed run id.** A rerun rewrites the *existing* run rather than creating a new one, so a run id you read as `success` can later read `failure` with nothing pushed to the branch. Observed twice in one fleet run, on two PRs: a refresh workflow re-ran the currency check after `main` advanced and flipped the same id on the same SHA. This cuts both ways — a red you cached may since have gone green on re-run, and a green you cached may be red. Never carry a conclusion across a wait.

   Also: `--workflow CI` above matters. The newest run on a branch is frequently a label or policy workflow, so a bare `--limit 1` can return something that is not CI at all.

4. `gh pr merge <pr> --merge` (no-ff). It can exit silently — confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit` before claiming it merged. **Never `--delete-branch`**; GitHub removes the remote branch anyway.

   **Prove which head landed.** A rebase-then-merge leaves no trace of *which* version went in, and "I rebased" is exactly the claim asserted without doing it:

   ```bash
   git merge-base --is-ancestor <pre-rebase-head> origin/main   # expect FAILURE
   git merge-base --is-ancestor <rebased-head>    origin/main   # expect SUCCESS
   git rev-parse <merge-commit>^2                               # expect <rebased-head>
   ```

   Then re-fetch and **re-evaluate the queue from scratch** — labels and numbers move while CI runs, and a merge newly unblocks or blocks others.

**Staleness fires *within* a wave, and it compounds.** The first merge makes every other PR behind — including the second of this same pass, verified green minutes ago. Re-check `git rev-list --count origin/<branch>..origin/main` before **each** merge. Any behind-count handed to you at dispatch is already expired.

Measured over one three-merge wave: the next queue member went 0 → 2 → 7 → **10 behind** without ever changing, because each merge adds its own commits plus a merge commit. So the *last* PR in a wave pays the largest rebase and the longest CI cycle, and a PR rebased early pays again for every sibling that lands after it. This is the argument for batching a wave rather than merging singles — and for never rebasing a PR before it is the actual merge candidate.

**A PR whose heavy jobs have only ever `skipped` is getting its first real verification from your rebase.** Reviewers may legitimately have labelled on the checks that did run plus local evidence, saying so explicitly. When your post-rebase run finally executes those suites, treat a red there as a **genuine first result**, not a regression you caused — read the failing job before concluding, and do not hand it back as "the rebase broke it".

Report merged / skipped-unlabeled / held-behind-#X / blocked after the pass.

## No-undo audit (before every rebase)

A rebase resolved the wrong way silently reverts work already in `main`. It looks like an ordinary conflict resolution and passes CI, because the branch's own tests never covered what it undid. Never resolve blind.

**1. Do not destroy unpushed work.** The worktree may hold changes existing nowhere else:

```bash
git -C <worktree> status --porcelain     # must be empty before rebasing
git -C <worktree> stash list
```

Non-empty → stop and report. **Never** `git clean`, `git checkout .`, or `git reset --hard` to make a rebase start. That work is unrecoverable and is not on the remote. The stash stack is repo-global across worktrees — never pop, drop or apply an entry you did not create.

**2. Preview conflicts:**

```bash
git merge-tree --write-tree --name-only origin/main origin/<branch>
```

**3. Name the work at risk** — what `main` gained since the branch forked:

```bash
base=$(git merge-base origin/main origin/<branch>)
git log --oneline "$base"..origin/main -- <conflicting files>
git diff --stat "$base"..origin/main -- <conflicting files>
```

Those commits are what a careless resolution deletes. Read them first.

**4. Take `main`'s side wholesale, then re-apply the branch's delta on top.** Never blanket `-X ours` / `-X theirs`. The branch's side is by definition *pre-merge* text — on a docs or comment hunk it carries claims a later PR already corrected, and keeping it reintroduces them silently.

**5. Before pushing, prove nothing was undone:**

```bash
git diff origin/main...HEAD -- <conflicting files>
```

Three dots, never two: a two-dot diff on a stale branch renders `main`'s gains as deletions and reads as a mass revert. Every hunk must be the PR's own intended change. A deletion of a line `main` introduced that this PR has no business touching means the resolution ate merged work — redo it. Re-derive any numbers, offsets or anchors the conflict touched rather than carrying stale ones.

## Then stay armed

**Skip this whole section if a controller dispatched you** (`/fleet:run-team`, or any
caller that says it owns the watcher) — report your pass and exit instead. A
monitor armed by a member dies with that member and the queue stops silently, so
the watcher belongs to whoever outlives the pass. Only arm one when you are the
top-level invocation.

The pass ends, the queue does not. Once no labeled PR is actionable, arm a persistent Monitor so a later sign-off restarts the loop without re-running this command:

```bash
poll() { gh pr list --state open --label ready-to-merge --json number --jq '.[].number' 2>/dev/null | tr '\n' ' '; }
seen=$(poll)
while true; do
  sleep 60
  if cur=$(poll); then
    for n in $cur; do
      case " $seen " in *" $n "*) ;; *) echo "ready-to-merge label added: PR #$n" ;; esac
    done
    seen="$cur"
  fi
done
```

Arm with `persistent: true`, description `ready-to-merge label on agent-brain PRs`. Details that matter:

- Seed `seen` **before** the loop so PRs already handled — including ones skipped for `CHANGES_REQUESTED` or left on red CI — do not re-fire every minute. Only a label appearing after arming is an event.
- The `if cur=$(poll)` guard keeps `seen` intact when a `gh` call fails transiently; without it one failed poll replays the whole labeled set.
- 60s poll — remote API, stay off rate limits.
- A held PR stays in `seen`, so its own label will not re-fire. Fine: what unblocks it is the **lower** PR getting labeled, which does fire, and step 4's re-evaluation picks up both in numeric order.

On an event, do not merge that PR on sight — **re-run selection from the top**, hold rule included. Report each outcome and leave the monitor armed. One watch per session; stop with TaskStop.
