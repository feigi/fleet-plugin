---
description: merge every ready-to-merge open PR in numeric order — rebase, wait green, merge, never jumping a related PR
---

Set the goal, then work it until no open PR is left:

`/goal Merge all of this repo's open PRs in numeric order if labeled ready-to-merge. Rebase -> Wait for checks green -> check for the ready-to-merge label -> merge if labeled. Never merge past a lower-numbered PR whose work is related — wait for its label instead.`

Only `ready-to-merge` PRs are in scope — it is the author's sign-off. Never add the label yourself.

## Order, and the hold rule

Lowest number first. But the label alone does not authorize a merge: **a labeled PR must not jump a lower-numbered open PR touching related work.** Numeric order is the author's intended order; jumping it silently rebases the lower PR onto changes it was never written against.

Before touching labeled PR `N`, list every open PR below `N` lacking the label. For each, decide related or not:

```bash
~/.claude/skills/fleet/scripts/pr-overlap.mjs --a <lower-pr> --b <N>
```

**Any** of its three signals (`files`, `modules`, `dirs`) firing means related. Path equality alone is too weak: a repo mid-migration has `src/…/foo.test.ts` in one PR and `tests/unit/…/foo.test.ts` in the other — same module, zero shared paths.

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

1. If the PR is behind `origin/main`, update it **server-side first**: `gh pr update-branch <pr> --rebase`. That's an API call, not a push — no local git command runs, so the force-push classifier denial this step used to hit (`git push --force-with-lease`, judged and intermittently denied per invocation — 2 allowed / 2 denied on byte-identical invocations in one session; `settings.json` has since gained an `autoMode.allow` entry for exactly that command, so adding one is not the missing fix) never enters. The call is async; poll for the head to move:

   ```bash
   pre=$(gh pr view <pr> --json headRefOid -q .headRefOid)
   out=$(gh pr update-branch <pr> --rebase 2>&1); rc=$?
   post=$pre
   if [ "$rc" -eq 0 ]; then
     for _ in $(seq 1 60); do                 # 5 min cap, never an unbounded `until`
       post=$(gh pr view <pr> --json headRefOid -q .headRefOid)
       [ "$post" != "$pre" ] && break
       sleep 5
     done
   fi
   printf 'rc=%s pre=%s post=%s\n%s\n' "$rc" "$pre" "$post" "$out"
   ```

   **Check the call's exit status before polling, and bound the poll.** The head never moving *is* the failure case, so an `until` that waits for it to move spins forever in exactly the states the fallback exists for — the escapes named below are unreachable from a loop that never exits. Read the three outcomes off `rc` and `post`:

   - `rc=0` and `post != pre` → the rebase landed. Hold `pre` and `post`, step 4's proof needs both.
   - Non-zero `rc` carrying `UNPROCESSABLE: There are no new commits on the base branch` → it was already current, so `pre` and `post` are simply equal. Shouldn't happen here since you only call this when behind.
   - Any other non-zero `rc`, **or** `post` still equal to `pre` once the cap runs out → the fallback below, not a retry.

   This also repairs a branch carrying a merge commit — GitHub's rebase drops those too.

   **A worktree for this branch, if one exists, goes stale here** — the API rebased the remote, not your checkout. Expected, not a divergence. To prove it holds nothing unique, `git cherry origin/<branch> HEAD` from the worktree — **not** `git cherry origin/main HEAD`: `main` never contained this PR's commits before the merge either, so it reads `+` for all of them regardless of staleness and proves nothing (measured, feigi/claude-config#149).

   **Two, and only two, reasons this can't be used:** a real conflict, or `allow_update_branch` off on the repo. Both are whole-branch failures — GitHub's rebase replays every commit or none, no partial credit. Either → the fallback below, not a retry.

   **Fallback (server-side rebase unavailable).** Rebase locally, for verification only — this rebase never needs to reach the remote. The branch usually lives in a worktree (`git worktree list`) — rebase there, not the main checkout.

   **Confirm the worktree head *is* the reviewed remote PR head before rebasing** — a mismatch means the rebase would carry an unreviewed local commit into the merge:

   ```bash
   git -C <worktree> rev-parse HEAD
   gh pr view <pr> --json headRefOid -q .headRefOid    # -q, or you compare a SHA to JSON
   ```

   - **Equal** → proceed.
   - **Worktree ahead** → STOP, report `worktree-diverged-#<pr>`. A fix-agent that committed locally but never pushed, or was aborted mid-fix, leaves an unpushed, unreviewed commit that a clean-tree audit passes and your rebase would carry into the merge. The reviewed head lives on the remote, not here; hand the choice back with the PR.
   - **Worktree behind, or no worktree at all** → not a divergence. Rebase from the remote head (`git fetch` first) and say which you used.

   Run the **no-undo audit**, then before merging: diff `origin/main...HEAD` hunk by hunk — nothing but this PR's own change may appear — suite green on the rebased head, and `gh pr view <pr> --json mergeable,mergeStateStatus` reading `MERGEABLE`/`CLEAN` with the label still present, re-checked at the merge instant. Step 4 then merges whatever is actually on the remote — the pre-rebase head, since nothing here was pushed — content-equivalent to what you just verified, not graph-identical to it. Report this path as `rebase-fallback-#<pr>` with the reason; see step 4 for why its proof comes back disproved on purpose.

   **A repo that gates on currency cannot merge from this path — and this one does.** The fallback leaves the remote head behind `origin/main` on purpose, which is the exact condition `rebase-check` fails on: `.github/workflows/ci.yml` checks out `pull_request.head.sha` and exits 1 when the merge-base is not the base tip. It is an expected job, so `ci-state.mjs` reports non-green, step 3's gate never opens, and `mergeStateStatus` cannot read `CLEAN` either. The four checks above are still the honest verification of the *content*, but they do not clear that gate. So here the fallback **ends without merging**: report `rebase-fallback-#<pr>` as blocked and hand it back — choosing between resolving the conflict and turning `allow_update_branch` on is a human's call. Step 4's merge is reachable from this path only where no expected job gates on currency.

2. Watch checks settle **on the rebased head**. A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching. A stale `rebase-check` failure usually means step 1 has not landed; `integration` and `mutation` skip behind it.

   **Hold the wait inside one blocking command — you are turn-based and cannot "keep an eye on" a run.** If you push and then end your turn, your pass stops there and nothing resumes it: whatever wakes you is external and may never come. Observed repeatedly — a bot rebases, pushes, goes idle, and the queue silently stalls with the PR one command from merging. Block instead:

   ```bash
   gh run watch <run-id> --exit-status    # returns only when the run reaches a terminal state
   ```

   Take `<run-id>` from the same `gh run list --json` row you took the head from. A CI cycle here runs ~5-6 minutes; if `gh run watch` outlives your shell timeout, re-issue it — that is still one blocking call per turn, not an idle turn. Never `sleep`-poll in a loop you exit early.

   **`gh run watch` returning is permission to look, not a verdict.** It tells you the run reached a terminal state, not which one — and that state can still change under you afterwards (step 3's re-query rule). Re-query `gh run view <run-id> --json jobs,attempt` for the decision.

   **You are the only place currency is proven, so never merge on a green from before your rebase.** The reviewer's green attests the diff was correct against *its* base — that claim does not expire and does not cover yours. Only a run on the rebased head shows it is still correct against current `main`.

   **Triage a post-rebase red by what the pre-rebase run did.** Green before, red after, with no change of your own between, means a sibling merge broke this PR semantically — a rebase applies cleanly and still breaks the build when someone renamed a symbol it uses. That is a **finding, not a chore**: report it and hand it back to the reviewer with the failing job. Red both before and after is also the reviewer's. You fix only the mechanical failures you caused: conflict resolution and the release label.

3. Green → re-check immediately before merging (`gh pr view <pr> --json labels,reviewDecision`): the label must still be there (it can be pulled while CI runs) and `reviewDecision` must not be `CHANGES_REQUESTED`. Either fails → skip, say so, move on.

   **Bind the green to the *run*, not to check conclusions.** `gh pr checks` aggregates across runs and reports a `pass` inherited from a **cancelled** run on a superseded SHA — head-SHA binding misses it, since the head is right and only the conclusions belong elsewhere.

   ```bash
   ~/.claude/skills/fleet/scripts/ci-state.mjs --pr <pr>
   ```

   No `--branch` flag — it derives the branch from the PR. It binds run head, `status`, and every expected job from one query, and reports non-green unless the run's head matches the PR head, `status` is **completed**, and every expected job is present and succeeded. That presence requirement is what catches the case above — a force-push cancels the run under you, its finished jobs go on reporting what they concluded, and whatever never ran is missing from the run entirely, which reads as `pending` in an aggregating checks summary, never here: `ci-state.mjs` names it in the reason `expected jobs absent from the run: …` and refuses green.

   **Re-query at the moment you merge — a conclusion can invert under a fixed run id.** A rerun rewrites the *existing* run rather than creating a new one, so a run id you read as `success` can later read `failure` with nothing pushed to the branch. Observed twice in one fleet run, on two PRs: a refresh workflow re-ran the currency check after `main` advanced and flipped the same id on the same SHA. This cuts both ways — a red you cached may since have gone green on re-run, and a green you cached may be red. Never carry a conclusion across a wait.

   Also: the newest run on a branch is frequently a label or policy workflow, not CI — `ci-state.mjs` filters by `--workflow CI` by default.

   **`verdict: "no-ci"` on a `ready-to-merge` PR is not a block.** The label is
   the record here: a finisher only ever adds it in a no-CI repo after checking
   the reviewer's own green `testCmd` run (see `run-team/SKILL.md`'s finisher
   gate). Pass `--declare-no-ci` here so the exit-0 gate reads correctly —
   passing it is how you read that label's verdict out, never a second
   confirmation of it, since the flag only echoes itself back. Without it you'd
   read a legitimately labeled PR as stuck red forever, off a run that will
   never exist.

4. `gh pr merge <pr> --merge` (no-ff). It can exit silently — confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit` before claiming it merged. **Never `--delete-branch`**; GitHub removes the remote branch anyway.

   **Prove which head landed.** A rebase-then-merge leaves no trace of *which* version went in, and "I rebased" is exactly the claim asserted without doing it:

   ```bash
   ~/.claude/skills/fleet/scripts/prove-merge.sh <pre-rebase-head> <rebased-head> <merge-commit>
   ```

   **No rebase happened because the PR was already current? Pass the head twice.** That is the normal case in a wave, not an edge case, and `pre == post` selects a proof path built for it. Never invent a plausible-looking `pre` to make the arguments differ — a `pre` that never landed satisfies the pre-rebase leg by construction, and passing one is the single easiest way to turn a stale merge into `proved=true`.

   Exit **0** proved, **1** disproved, **2** the script could not evaluate the claim at all — the merge is unreachable from `origin/main`, is not a merge commit, or an argument does not resolve. Treat 2 as "ask a human", not as a disproof.

   **A `rebase-fallback-#<pr>` merge is expected to disprove here.** Step 1's fallback never lands a rebased head on the remote, so `pre == post` and `headWasCurrent` reads false — `prove-merge.sh` exits **1**, correctly (`prove-merge.test.mjs`'s `ATTACK: un-rebased head that merged cleanly still proves false` pins exactly this shape). That is the honest answer, not a script fault. Report the merge as **argued** — backed by the fallback's four checks — and never as `proved`; a merge whose ancestry was not proved is never reported as proved.

   **Drop `in-progress` from every issue this PR closes** — the merge is the only point where the ticket number and the fact of completion are known together, and nothing else clears it:

   ```bash
   ~/.claude/skills/fleet/scripts/drop-merged-label.sh <pr> --apply
   ```

   Exit 0 done or nothing to close, **1 a removal failed — report it as `label-drop-failed-#<issue>`, never swallow it**: a merged ticket that keeps the label is invisible the moment it is reopened. Exit 2 means the PR was not actually MERGED yet — call this only after the merge is confirmed at the top of this step.

   Then re-fetch and **re-evaluate the queue from scratch** — labels and numbers move while CI runs, and a merge newly unblocks or blocks others.

**Staleness fires *within* a wave, and it compounds.** The first merge makes every other PR behind — including the second of this same pass, verified green minutes ago. Re-check `git rev-list --count origin/<branch>..origin/main` before **each** merge. Any behind-count handed to you at dispatch is already expired.

Measured over one three-merge wave: the next queue member went 0 → 2 → 7 → **10 behind** without ever changing, because each merge adds its own commits plus a merge commit. So the *last* PR in a wave pays the largest rebase and the longest CI cycle, and a PR rebased early pays again for every sibling that lands after it. This is the argument for batching a wave rather than merging singles — and for never rebasing a PR before it is the actual merge candidate.

**A PR whose heavy jobs have only ever `skipped` is getting its first real verification from your rebase.** Reviewers may legitimately have labelled on the checks that did run plus local evidence, saying so explicitly. When your post-rebase run finally executes those suites, treat a red there as a **genuine first result**, not a regression you caused — read the failing job before concluding, and do not hand it back as "the rebase broke it".

Report merged / skipped-unlabeled / held-behind-#X / worktree-diverged-#X / label-drop-failed-#X / rebase-fallback-#X / blocked after the pass.

## No-undo audit (before every rebase)

A rebase resolved the wrong way silently reverts work already in `main`. It looks like an ordinary conflict resolution and passes CI, because the branch's own tests never covered what it undid. Never resolve blind.

**1-3. Do not destroy unpushed work, preview conflicts, and name the work at risk** — what `main` gained in the conflicting files since the branch forked:

```bash
~/.claude/skills/fleet/scripts/no-undo-audit.sh <worktree> <branch>
```

It refuses (exit 1) on a dirty worktree. Exit **2** is not that refusal: it means the audit could not answer at all — a bad argument, no such worktree, a worktree git does not answer for (its linkage is broken, so git walks up and reports the enclosing repo), a ref that does not resolve, a probe that could not run, or a conflicting path no pathspec can name — and it emits no payload. Treat 2 as "ask a human", never as "the worktree is dirty"; there is nothing to commit and hunting for it wastes the pass. **Never** `git clean`, `git checkout .`, `git reset --hard`, or `git stash` to make it pass — that work is unrecoverable and is not on the remote, and stashing it clears `porcelain` so the audit passes on the next run without the work ever shipping. The stash count it prints is reported, not gated: the stack is repo-global across worktrees, so a nonzero count is usually the maintainer's. It can also come back `unknown` rather than a number — the list came back empty and the audit cannot call that an empty stash. Usually `refs/stash` is not absent, which an unreadable ref, an unreadable reflog, or a ref pointing at a missing object each produce just as a genuinely empty stash would. The fourth cause is the opposite shape: `refs/stash` **is** absent while its reflog is not, so the entries it names are unreachable rather than gone — the audit's line says which of the two you have. Neither is the same thing as an empty stash and the audit no longer conflates them. The number it prints is a floor, not a proof: a reflog that is merely truncated — some entries lost, the rest still parsing — drops the missing entries from `git stash list` itself, so the audit and your own read of the list come up short by the same ones and neither reports it. Read `git stash list` yourself when the count is nonzero **or `unknown`** — an entry naming this branch may be a dead member's only copy — and never pop, drop or apply an entry you did not create. On `unknown` do not stop at that list: three of its four causes leave it empty at rc 0, so read the files behind it. Set `c=$(git rev-parse --git-common-dir)` — the stack is repo-global, and a linked worktree's `.git` is a file, so `.git/refs/stash` reaches nothing — then `ls -l "$c"/refs/stash "$c"/logs/refs/stash`, where a mode of `----------` on either, or a `Permission denied` from `ls` itself, is the fault, and `cat "$c"/logs/refs/stash`, which still names the branch when `refs/stash` is the unreadable one. `No such file or directory` for `refs/stash` alone, with the reflog listing beside it, is the fourth cause: recover from the SHAs `cat` prints, do not rebase over it. A missing `refs/stash` file is not an empty stash: `git gc` packs it into `packed-refs`. Read the at-risk commits it lists first; those are what a careless resolution deletes.

**4. Take `main`'s side wholesale, then re-apply the branch's delta on top.** Never blanket `-X ours` / `-X theirs`. The branch's side is by definition *pre-merge* text — on a docs or comment hunk it carries claims a later PR already corrected, and keeping it reintroduces them silently.

**5. Before pushing, prove nothing was undone:**

```bash
git diff origin/main...HEAD -- <conflicting files>
```

Three dots, never two: a two-dot diff on a stale branch renders `main`'s gains as deletions and reads as a mass revert. Every hunk must be the PR's own intended change. A deletion of a line `main` introduced that this PR has no business touching means the resolution ate merged work — redo it. Re-derive any numbers, offsets or anchors the conflict touched rather than carrying stale ones.

`<conflicting files>` is the audit's `conflicts[]`, not typed by hand — and `conflictsRewritten[]` sits next to it for exactly this step. A path is reported at the same index in both arrays; `true` there means the path held a control byte the audit could not give a JSON short form to and replaced with a space, so the string in `conflicts[]` is not the byte-for-byte name of anything on disk. Pasting it into the command above builds a pathspec that matches nothing — the diff comes back empty, and empty reads as "nothing to prove", the opposite of unproven. Skip the command for any path flagged `true` and inspect it by hand (`git status`, or `ls` the worktree) instead of by pathspec.

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

Arm with `persistent: true`, description `ready-to-merge label on this repo's PRs`. Details that matter:

- Seed `seen` **before** the loop so PRs already handled — including ones skipped for `CHANGES_REQUESTED` or left on red CI — do not re-fire every minute. Only a label appearing after arming is an event.
- The `if cur=$(poll)` guard keeps `seen` intact when a `gh` call fails transiently; without it one failed poll replays the whole labeled set.
- 60s poll — remote API, stay off rate limits.
- A held PR stays in `seen`, so its own label will not re-fire. Fine: what unblocks it is the **lower** PR getting labeled, which does fire, and step 4's re-evaluation picks up both in numeric order.

On an event, do not merge that PR on sight — **re-run selection from the top**, hold rule included. Report each outcome and leave the monitor armed. One watch per session; stop with TaskStop.
