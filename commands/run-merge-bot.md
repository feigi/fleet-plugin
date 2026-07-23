---
description: merge every ready-to-merge open PR in numeric order — rebase, wait green, merge, never jumping a related PR
---

Set the goal, then work it until no open PR is left:

`/goal Merge all agent-brain PRs in numeric order if labeled ready-to-merge. Rebase -> Wait for checks green -> check for the ready-to-merge label -> merge if labeled. Never merge past a lower-numbered PR whose work is related — wait for its label instead.`

Only PRs carrying the `ready-to-merge` label are in scope — it is the author's sign-off. Never add the label yourself.

## Order, and the hold rule

Work labeled PRs lowest number first. But the label alone does not authorize a merge: **a labeled PR must not jump ahead of a lower-numbered open PR that touches related work.** Numeric order is the author's intended merge order; jumping it silently rebases the lower PR onto changes it was never written against.

Before touching a labeled PR `N`, list every open PR numbered below `N` that lacks `ready-to-merge`. For each, decide related or unrelated:

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

Two known false positives in signal 3, both filtered or discounted rather than obeyed blindly:

- **Repo root (`.`) is excluded above.** Every top-level file — `README.md`, `stryker.conf.json`, `package.json` — shares it, so it fires on PRs with nothing whatsoever in common.
- **A bare top-level directory (`docs`, `tests`, `src`) is weak evidence.** Two PRs editing different documents under `docs/` are not related. Before holding on a directory-only hit, look at the actual files: same document, same module, or same config? Related. Different subjects that happen to share an ancestor? Not related — proceed, and say so in the report.

A directory-only hit is a prompt to investigate, not a verdict. Shared *files* and shared *module names* are verdicts.

- **Related → HOLD `N`.** Do not rebase it, do not merge it. Report it as `held-behind-#<lower>` and move to the next labeled PR. The watcher below picks it up once the lower PR is signed off and merged.
- **Unrelated → proceed.** Merge `N` normally, and say in the report that it went ahead of `#<lower>` and on what evidence you judged them unrelated.

Shared files are the mechanical signal, not the only one. Also treat as **related** — and therefore hold — when any of these hold even with an empty file intersection:

- both PRs reference the same issue (`#NNN` in title or body), or were split from one issue
- one branch is stacked on the other, or their branch names name the same issue/cluster
- they change the same exported symbol, config key, or docs section from different files

When the call is genuinely unclear, **hold**. Waiting costs a label; merging out of order costs a conflict resolution on someone else's branch, and the loser is the PR that was already reviewed.

**A fired signal is not a verdict — disprove it.** Soft signals fire on deliberately-partitioned PRs. Observed: two PRs sharing two issue refs and all of `reset_hint=` / `resetHint` / `terminalFailure`, provably unrelated — one handed the other a specific emit site in its own body, their exact-string pins were punctuation-distinct so neither could match the other's site, and **both were test-only**. That last generalizes: **a test-only PR cannot invalidate what another PR asserts.**

Obeying a fired signal blindly stalls the queue on a non-conflict; ignoring one is sloppy. Do the work, report which evidence settled it.

## Per-PR sequence

For each labeled PR that clears the hold rule, lowest number first:

1. Rebase its branch onto `origin/main`; push with `--force-with-lease` if it moved. The branch usually lives in a worktree (`git worktree list`) — rebase there, not in the main checkout. Run the **no-undo audit** below first.
2. Watch the checks until they settle **on the rebased head**. A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching the change. A stale `rebase-check` failure usually means step 1 has not landed yet; `integration` and `mutation` skip behind it and only run for real once it passes.

   **You are the only place currency is proven, so never merge on a green from before your rebase.** The reviewer's green attests the diff was correct against *its* base; that claim does not expire and does not cover yours. Only a run on the rebased head shows the diff is still correct against current `main`.

   **Triage a post-rebase red by whether the pre-rebase run passed.** Green before, red after, with no change of your own in between, means a sibling merge broke this PR semantically — a rebase applies cleanly and still breaks the build when someone renamed a symbol it uses. That is a **finding, not a chore**: report it and hand it back to the reviewer with the failing job, do not quietly fix it. Red both before and after is the PR's own problem and belongs to the reviewer too. The only failures you fix yourself are the mechanical ones you caused: conflict resolution and the missing release label.
3. Green → re-check right before merging (`gh pr view <pr> --json labels,reviewDecision`): the `ready-to-merge` label must still be there (it may have been pulled while CI ran) and `reviewDecision` must not be `CHANGES_REQUESTED`. Either fails → skip it, say so, move on.

   **Bind the green to the *run*, not to check conclusions.** `gh pr checks` aggregates job results across runs and reports a `pass` inherited from a **cancelled** run on a superseded SHA — head-SHA binding misses it, since the head is right and only the conclusions belong elsewhere.

   ```bash
   rid=$(gh run list --branch <branch> --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run view "$rid" --json headSha,status,conclusion
   gh run view "$rid" --json jobs --jq '.jobs[] | "\(.name) \(.status)/\(.conclusion // "-")"'
   git rev-parse origin/<branch>; gh pr view <pr> --json headRefOid
   ```

   Require all four: run `headSha` == branch head == `headRefOid`, run `status` **completed**, and **every expected job present in that run**. A force-push cancels the run under it; jobs that already finished keep their conclusions and keep being reported.
4. Labeled → `gh pr merge <pr> --merge` (no-ff). `gh pr merge` can exit silently; confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit` before claiming it merged.

   **Prove which head landed.** A rebase-then-merge leaves no trace of *which* version went in, and "I rebased" is exactly the claim asserted without doing it:

   ```bash
   git merge-base --is-ancestor <pre-rebase-head> origin/main   # expect FAILURE
   git merge-base --is-ancestor <rebased-head>    origin/main   # expect SUCCESS
   git rev-parse <merge-commit>^2                               # expect <rebased-head>
   ```

   Then re-fetch and **re-evaluate the queue from scratch** on the new `main` — labels and numbers move while CI runs, and a merge newly unblocks or blocks others.

**Staleness fires *within* a wave.** The first merge makes every other PR behind — including the second of this same pass, verified green minutes ago. Re-check `git rev-list --count origin/<branch>..origin/main` before **each** merge. Observed: 0 behind → 4 the moment the first landed. A behind-count handed to you at dispatch is already expired.

Report merged / skipped-unlabeled / held-behind-#X / blocked after the pass.

## No-undo audit (before every rebase)

A rebase resolved the wrong way silently reverts work already merged into `main`. The revert looks like an ordinary conflict resolution and passes CI, because the branch's own tests never covered what it undid. Never resolve blind.

**1. Do not destroy unpushed work.** The branch's worktree may hold uncommitted changes that exist nowhere else:

```bash
git -C <worktree> status --porcelain     # must be empty before rebasing
git -C <worktree> stash list
```

Non-empty → stop and report. Commit or stash it deliberately; **never** `git clean`, `git checkout .`, or `git reset --hard` to make a rebase start. That work is unrecoverable and is not on the remote.

**2. Preview the conflicts before starting:**

```bash
git merge-tree --write-tree --name-only origin/main origin/<branch>
```

**3. For each conflicting file, name the work at risk** — what `main` gained since this branch forked:

```bash
base=$(git merge-base origin/main origin/<branch>)
git log --oneline "$base"..origin/main -- <conflicting files>
git diff --stat "$base"..origin/main -- <conflicting files>
```

Those commits are what a careless resolution deletes. Read them before resolving.

**4. Resolution rule: take `main`'s side wholesale, then re-apply the branch's own delta on top.** Never blanket `-X ours` / `-X theirs`. The branch's side of a conflict is by definition the *pre-merge* text — on a docs or comment hunk it carries claims a later PR already corrected, and keeping it reintroduces them silently.

**5. After rebasing, before pushing, prove nothing was undone:**

```bash
git diff origin/main...HEAD -- <conflicting files>
```

Every hunk must be the PR's own intended change. A deletion of a line `main` introduced, that this PR has no business touching, means the resolution ate merged work — redo it. Re-derive any numbers, offsets, or anchors the conflict touched rather than carrying the branch's stale ones.

## Then stay armed

The pass ends, the queue does not. Once no labeled PR is actionable, arm a persistent Monitor that watches for the label landing on any open PR, so a later sign-off restarts the loop without the user re-running this command:

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

Arm it with `persistent: true` and a description like `ready-to-merge label on agent-brain PRs`. Details that matter:

- Seed `seen` **before** the loop so PRs already handled in the pass — including ones skipped for `CHANGES_REQUESTED` or left blocked on red CI — do not re-fire every minute. Only a label that appears after arming is an event.
- The `if cur=$(poll)` guard keeps `seen` intact when a `gh` call fails transiently; without it one failed poll would replay the whole labeled set on the next success.
- 60s poll — remote API, keep it off rate limits.
- A PR held by the hold rule stays in `seen`, so its own label will not re-fire. That is fine: what unblocks it is the **lower** PR getting labeled, which does fire, and step 4's full re-evaluation then picks up both in numeric order.

When an event lands, do not merge that PR on sight — **re-run the selection from the top**, hold rule included, and work whatever is now actionable in numeric order. Report each outcome and leave the monitor armed. Do not re-arm a second monitor; one watch per session. Stop it with TaskStop when the user says to stop watching.
