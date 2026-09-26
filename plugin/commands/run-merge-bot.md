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
~/.fleet/bin/fleet-run pr-overlap.mjs --a <lower-pr> --b <N>
```

**Any** of its four signals (`files`, `modules`, `dirs`, `prose`) firing means related. Path equality alone is too weak: a repo mid-migration has `src/…/foo.test.ts` in one PR and `tests/unit/…/foo.test.ts` in the other — same module, zero shared paths.

Two false positives in signal 3:

- **Repo root (`.`) is excluded above.** Every top-level file shares it, so it fires on PRs with nothing in common.
- **A bare top-level directory (`docs`, `tests`, `src`) is weak evidence.** Two PRs editing different documents under `docs/` are unrelated. Look at the actual files first: same document, module, or config → related. Different subjects sharing an ancestor → not related; proceed and say so.

**Signal 4, `prose`, is the one `signal=none` used to miss, and the only one that reads content rather than paths.** It fires when one PR changes a data file (`.tsv`, `.json`, `.yml`, …) whose path or basename appears in the other PR's own diff — the append-vs-rewrite collision `docs/metrics/tier-outcomes.tsv` has with `run-team/SKILL.md`'s tier guard by construction, since the file is append-only and every run produces a PR touching it. Weak evidence, on a par with a directory hit, and it prints its witness — the cited file, the citing file, the token and the line — because one read disproves it. It is ranked LAST, so it only ever converts a `none`: a `files`, `modules` or `dirs` verdict still reads exactly as it did before, with `prose=<n>` on the summary line beside it.

**`prose=0` is a clear only when `proseUnrun` is `null`.** A non-null `proseUnrun` means the scan was reached and could not cover the diff, so an empty `prose[]` there is silence rather than data — read the reason it names and settle the pair by hand.

Directory-only and prose-only hits prompt investigation. Shared *files* and *module names* are verdicts.

- **Related → HOLD `N`.** Do not rebase, do not merge. Report `held-behind-#<lower>` and move on. The watcher picks it up once the lower PR is signed off and merged.
- **Unrelated → proceed**, and report that it went ahead of `#<lower>` and on what evidence.

Also **related** even with an empty file intersection when:

- both reference the same issue, or were split from one
- one branch is stacked on the other, or their names share an issue/cluster
- they change the same exported symbol, config key, or docs section from different files — signal 4 mechanises the half of this where the section is a **data file** cited by name, so read `prose` before reaching for this bullet; a bare symbol or key name is still yours to read, and the measurement in the next paragraph is why it stays that way

Genuinely unclear → **hold**. Waiting costs a label; merging out of order costs a conflict resolution on someone else's branch, and the loser is the PR already reviewed.

**A fired signal is not a verdict — disprove it.** Soft signals fire on deliberately-partitioned PRs. Observed: two PRs sharing two issue refs and all of `reset_hint=` / `resetHint` / `terminalFailure`, provably unrelated — one handed the other a specific emit site in its own body, their exact-string pins were punctuation-distinct so neither could match the other's site, and **both were test-only**. That generalizes: **a test-only PR cannot invalidate what another PR asserts**, and neither can a docs-only one.

**`git merge-tree --write-tree <branch-a> <branch-b>` disproves a fired signal without inference.** It performs the merge in-memory and writes a tree, exiting non-zero with the conflicting paths on stdout only when the merge genuinely conflicts. That is a real answer, not an inference from a behind-count — being behind is not evidence of conflict. `rc=0` with a written tree means the two branches merge clean; run it on `files` before holding. It answers only whether the two trees conflict textually, not whether one PR's content invalidates the other's — the same-issue, stacked-branch, and shared-symbol conditions still decide that.

Obeying a fired signal blindly stalls the queue on a non-conflict; ignoring one is sloppy. Do the work, report which evidence settled it.

## The labelled head

`ready-to-merge` is a finisher's verdict on one tree, and it does not expire when that tree does. **A GitHub label does not follow the branch** — #180 is the record, and the query below is what reads it: `labeled ready-to-merge`, then commits and a `head_ref_force_pushed`, then `merged`, with no `unlabeled` anywhere between. The label stayed put while the head moved out from under it. Every other guard in this chain — the finisher's dispatch pin, the halt on a moved head, the worktree audit — runs *before* the label exists, so none of them is watching this window. You are the last gate, and **re-deriving the head is a requirement here, not bot discretion**: merge only a head that still carries the audit the label stands for.

**Read the timeline before `gh pr update-branch` and before anything else that can move the head.** Your own rebase lands commits after the label by construction, so once you have rebased this read can no longer tell your commits from someone else's:

```bash
gh api "repos/{owner}/{repo}/issues/<pr>/timeline?per_page=100" --paginate \
  -q '.[] | select((.event == "labeled" and .label.name == "ready-to-merge")
        or .event == "committed" or .event == "head_ref_force_pushed")
      | .event + " " + (.sha // .label.name // "")'
```

A `committed` or `head_ref_force_pushed` line after the last `labeled ready-to-merge` means the head moved after the audit. **Refuse: report `head-moved-after-label-#<pr>` and stop on that PR.** Leave the label where it is — you audited nothing and removing another member's verdict is not yours to do. What clears it is a **fresh** finisher against the new head; the first audit does not transfer, because it verified a different tree.

**Nothing after that label line is the normal case, and it proceeds untouched** — label applied, head unchanged, merge goes ahead exactly as it did before this gate existed. Record the head before you rebase — `gh pr view <pr> --json headRefOid -q .headRefOid` — because step 3 hands it to the merge gate as `--pre` and nothing later can reconstruct it. Where step 1 runs, that is its `pre`; on an already-current PR it is simply the head you merge.

What this gate deliberately does not answer. It does not ask *who* audited — a hand-added `ready-to-merge` with no finisher behind it reads clean here, and the reviewer-only rule in `run-team/SKILL.md` is what owns that. And a head rebased after the label by an **earlier, abandoned pass of this command** refuses too: that tree is one no finisher audited either, so the halt is correct rather than a false positive.

## Per-PR sequence

For each labeled PR clearing the hold rule, lowest first:

1. If the PR is behind `origin/main`, update it **server-side first**: `gh pr update-branch <pr> --rebase`. That's an API call, not a push — no local git command runs, so the force-push classifier denial this step used to hit (`git push --force-with-lease`, judged and intermittently denied per invocation — 2 allowed / 2 denied on byte-identical invocations in one session; `settings.json` has since gained an `autoMode.allow` entry for exactly that command, so adding one is not the missing fix) never enters. The call is async, so this is two blocks. The fire block reads the head the rebase starts from and makes the call, in seconds:

   ```bash
   branch=$(gh pr view <pr> --json headRefName -q .headRefName)
   ref="refs/heads/$branch"
   pre=$(git ls-remote origin "$ref" | cut -f1)
   [ -n "$pre" ] || { echo "no such remote ref: $ref"; exit 2; }
   out=$(gh pr update-branch <pr> --rebase 2>&1); rc=$?
   printf 'rc=%s branch=%s pre=%s\n%s\n' "$rc" "$branch" "$pre" "$out"
   ```

   The poll block waits for the head to move, handed `rc`, `branch` and `pre` off the fire block's report line:

   ```bash
   rc=<rc>; branch=<branch>; pre=<pre>        # off the fire block's report line, never re-derived here
   [ -n "$rc" ] && [ -n "$branch" ] && [ -n "$pre" ] || { echo "rc, branch and pre come from the fire block"; exit 2; }
   ref="refs/heads/$branch"
   post=$pre
   if [ "$rc" -eq 0 ]; then
     for _ in $(seq 1 60); do                 # 5 min cap, never an unbounded `until`
       post=$(git ls-remote origin "$ref" | cut -f1)
       [ -n "$post" ] && [ "$post" != "$pre" ] && break
       sleep 5
     done
   fi
   pr_head=$(gh pr view <pr> --json headRefOid -q .headRefOid)
   if [ "$rc" -eq 0 ] && [ -n "$post" ] && [ "$post" != "$pre" ]; then
     for _ in $(seq 1 60); do                 # PR object lags the ref (measured 84s-2min); same cap as above
       [ -n "$pr_head" ] && [ "$pr_head" != "$pre" ] && break
       sleep 5
       pr_head=$(gh pr view <pr> --json headRefOid -q .headRefOid)
     done
   fi
   printf 'rc=%s branch=%s pre=%s post=%s pr_head=%s\n' \
     "$rc" "$branch" "$pre" "$post" \
     "$pr_head"
   ```

   **Fire once; only the poll is ever re-issued.** `pre` is the one reading nothing after the rebase can reconstruct: once the rebase lands, the ref it was read from *is* the rebased head. So a fire block run a second time reads the rebased head as its `pre`, `gh pr update-branch` answers `UNPROCESSABLE: There are no new commits on the base branch`, and a rebase that landed reports as the already-current row below, never verified. The poll only reads, so re-issuing it with the same `rc` and `pre` is safe — and it is the half that gets cut off. Each of its loops is capped at 60 × 5s, and the PR object's measured lag alone outruns both harnesses' defaults on the common landed-with-lag path (#1895's own repro: 75.6s wall-clock at re-poll attempt 14, 129.2s at attempt 24 — a separate measurement from the pr_head-catchup pass below, whose attempt 14/24 wall-clock times differ from these). One re-issue is enough, never a loop of them: the ref poll alone ends inside the 600000 ceiling below, so a re-issued poll finds the ref already moved on its first read and waits out only the PR object's cap. The poll splits by harness:

   CLAUDE: run the poll block as one foreground `Bash` call with its `timeout` at 600000, the tool's ceiling, not its 120000 default; if it is still cut off before its report line — both caps back to back can outrun even the ceiling — re-issue the poll block once with the same `rc` and `pre`, never the fire block.
   OMP: the `Bash` `timeout` ceiling does not apply — omp `bash` backgrounds any call past about 60s even with `timeout` set — so run the poll block in one Python `eval` cell through `subprocess.run`, its cell `timeout` at 900s or more, above both caps back to back; never `bash` plus `wait`.

   **Poll `git ls-remote`, not `gh pr view headRefOid`** — the PR object's head is precisely the field that desyncs, so polling it asks the one source that can be wrong about the thing you are waiting for. Measured, feigi/claude-config#903: the rebase landed and moved the branch ref, `headRefOid` stayed on the pre-rebase SHA with `mergeable_state: unknown` and no CI run on the new head, and the loop burned all 60 iterations reading a landed rebase as un-landed — straight into the fallback, whose local rebase would then have replayed commits the remote already carried. `ls-remote` reads the ref itself and carries no local state, the same reason the `fetch.prune` note below re-derives a reading from `git ls-remote origin` rather than trusting a number measured while the ref was missing. Keep the `headRefOid` read, as the `pr_head` the printf reports: it is no longer the gate, and its *disagreement* with `post` is the desync signal you want on the record. That is why the poll block re-polls it only once the ref has moved — to let the PR object catch up, never to decide whether the rebase landed.

   **Check the call's exit status before polling, and bound the poll.** The head never moving *is* the failure case, so an `until` that waits for it to move spins forever in exactly the states the fallback exists for — the escapes named below are unreachable from a loop that never exits. Read the four outcomes off `rc` and `post`:

   - `rc=0`, `post` **non-empty**, and `post != pre` → the rebase landed. Hold `pre` and `post`, step 4's proof needs both.
   - Non-zero `rc` carrying `UNPROCESSABLE: There are no new commits on the base branch` → it was already current, so `pre` and `post` are simply equal. Shouldn't happen here since you only call this when behind.
   - Any other non-zero `rc`, **or** `post` still equal to `pre` once the cap runs out → the fallback below, not a retry.
   - **`post` empty once the cap runs out** → the ref read failed; this is never "the rebase landed". An empty `post` satisfies `post != pre` all by itself, so without this row a failed `ls-remote` is classified as success — the same hole `[ -n "$pre" ]` closes on the way in, and the loop's own `[ -n "$post" ]` is why an empty read cannot break out early. Take the fallback below, and report the ref as unreadable rather than as a head that never moved.

   **`post != pre` with `pr_head` still on `pre` is not a desync until it SURVIVES a bounded re-poll.** The PR object lags the ref move, so a `headRefOid` read taken in the same instant as the rebase reproduces the desync signature exactly while nothing is wrong. Measured twice in one run on 2026-09-01: it cleared on re-poll attempt 24 (~2 min) in one pass and attempt 14 (~84s) in the next, both after `gh pr update-branch --rebase` returned `rc=0`. So re-poll `headRefOid` on the same bounded cap you already use for `ls-remote` before calling this, and report the desync only if `pr_head` is still on `pre` when that cap runs out. The poll block's second loop is that re-poll: a `pr_head` it prints still on `pre` beside a moved `post` has already survived the cap, so report it as printed and never poll a second round. Reporting it on a single read costs a pass for a state that fixes itself, and it is the reading a bot gets when it does everything else right.

   **`pr_head` still empty once the re-poll cap runs out is neither outcome above — it is the PR-object read failing, not lagging.** The break condition (`[ -n "$pr_head" ] && [ "$pr_head" != "$pre" ]`) needs a read to succeed before it can even compare to `pre`, the same hole `[ -n "$post" ]` closes for the ref poll above; a `gh pr view` that fails for the whole cap (API, auth, or network) leaves `pr_head` empty, and an empty string is not "still on `pre`" — the desync row above needs a SHA that disagrees with `post`, and this one never produced a SHA at all. Report the PR-object read as unreadable rather than folding it into either the desync above or the landed row it prints beside, and do not feed an empty `pr_head` into the close-and-reopen check below — there is no head there for `git merge-base --is-ancestor` to place.

   **A desync that DOES survive the cap is the one state that needs a controller.** The rebase landed; GitHub's PR object did not follow. CI is bound to the stale head or absent entirely, so the merge gate cannot clear no matter how long you wait, and no merge-bot action fixes it — do not retry the rebase, and do not rebase locally, because the remote is already correct. Report it and stop.

   **The controller's remedy is close-and-reopen, and it has a precondition that must be checked FIRST.** Reopening requires the PR's recorded head to still be reachable from the branch — and a rebase orphans it by construction, which is the very event that produced the desync. So before closing anything, run `git merge-base --is-ancestor <pr_head> origin/<branch>`. Non-ancestor → **do not close**: GitHub refuses to reopen a PR whose head is unreachable (measured on #903 — three reopen attempts, `Could not open the pull request` each time), and the only recovery is opening a replacement PR from the same branch, which loses the review thread and every label on it. Close-and-reopen is normally reversible; past an orphaning rebase it is a one-way door.

   This also repairs a branch carrying a merge commit — GitHub's rebase drops those too.

   **A worktree for this branch, if one exists, goes stale here** — the API rebased the remote, not your checkout. Expected, not a divergence. To prove it holds nothing unique, run `git cherry origin/<branch> HEAD` from the worktree **before the merge, never after**, and **not** `git cherry origin/main HEAD`: `main` never contained this PR's commits before the merge either, so it reads `+` for all of them regardless of staleness and proves nothing (measured, feigi/claude-config#149). The window is the point: GitHub deletes the remote branch when the PR lands — the same reason step 4 never passes `--delete-branch` — so `origin/<branch>` outlives the merge only until the next pruning fetch, and step 4's `prove-merge.sh` runs one seconds later (`grep -n 'git fetch --quiet origin' scripts/prove-merge.sh`, plain, which prunes under the `fetch.prune=true` this machine's global config sets — `git config --show-origin --get fetch.prune`). Past that fetch the probe fails on a missing ref, an error easy to misread as the divergence it was meant to rule out.

   **Neither result halts this path, and a `+` here is not the diverged-worktree STOP.** The clean answer is the absence of a `+`, not the absence of output: `git cherry` prints a line per commit in `origin/<branch>..HEAD`, `-` where the upstream already holds an equivalent patch and `+` where it does not, so it never goes silent merely because the rebase superseded everything. A worktree that has not fetched since the API rebase — the state this step leaves it in, since no local git command runs here — reads nothing; one that has fetched reads `-` for every rebased commit. Both are clean (measured 2026-08-29 in a scratch repo: a bare remote, a branch rebased onto an advanced `main` and force-pushed, and a clone left at the pre-rebase head — `git cherry origin/feat HEAD` printed nothing before that clone fetched and a `-` per rebased commit after, while an unpushed commit added on top raised a `+` in both). A `+` names a commit the worktree holds and that branch does not — say so alongside the merge, since it is the only signal that something local is unpushed, but it does not stop the merge, because nothing local reaches the remote from here: this step rebases through the API and pushes nothing, and step 4 merges the remote head, so an unpushed local commit is structurally unable to enter the merge. That STOP lives in the fallback (server-side rebase unavailable) and does not halt for the reason just ruled out here: neither path can carry a local commit to the remote, because neither pushes. What differs is what gets verified — the fallback rebases the worktree and verifies *that* head, so a commit only the worktree holds makes the verified tree something other than the reviewed head; here the worktree is only read, never rebased, so a `+` is a report, not a halt.

   **Two, and only two, reasons this can't be used:** a real conflict, or `allow_update_branch` off on the repo. Both are whole-branch failures — GitHub's rebase replays every commit or none, no partial credit. Either → the fallback below, not a retry.

   **Fallback (server-side rebase unavailable).** Rebase locally, for verification only — this rebase never needs to reach the remote. The branch usually lives in a worktree (`git worktree list`) — rebase there, not the main checkout.

   **Confirm the worktree head *is* the reviewed remote PR head before rebasing** — a mismatch means the rebase would fold an unreviewed local commit into the tree you verify, while the merge takes the remote head without it:

   ```bash
   git -C <worktree> rev-parse HEAD
   git ls-remote origin refs/heads/<branch> | cut -f1   # the operand the arms below turn on
   gh pr view <pr> --json headRefOid -q .headRefOid     # recorded, NOT the gate (-q, or you compare a SHA to JSON)
   ```

   **Compare the worktree head against the branch REF, and never against `gh pr view <pr> --json headRefOid -q .headRefOid`** — the PR object's head is the field that desyncs from the branch, which is why step 1 polls `git ls-remote` rather than it. Never `git rev-parse origin/<branch>` either: that is this clone's cached copy of the ref, so a worktree sitting on a stale copy agrees with it by construction and every tree this check exists to catch passes. The `headRefOid` read stays, and stays demoted — a value disagreeing with the ref is the PR-object desync above, a fact for the report, never the operand this check turns on. **An empty ref read is neither equal nor a mismatch**: the read failed, or the head branch is not on `origin` at all (a fork PR), so report the ref as unreadable and stop, `blocked` — an empty string compares unequal to every sha, so without this clause a failed read renders as a diverged worktree, the same hole `[ -n "$pre" ]` closes on the way into the poll above.

   **Why the ref and not `headRefOid`: during the PR object's lag both operands go stale in the SAME direction, so that compare fails OPEN as readily as it fails closed.** The false STOP is the visible half — the worktree holds the rebased head, the PR object still holds the pre-rebase sha, and a correct tree comes back `worktree-diverged-#<pr>`, costing a pass. The silent half is the one that ships: a worktree that has not fetched since the rebase sits on that same pre-rebase sha, so BOTH sides read it, the check reads **Equal**, and this fallback verifies a tree the remote no longer has while step 4 merges the head it does — a green measured against a tree no merge will take, which is the exact failure the STOP arm below exists to prevent, reached through the arm that passes. Measured at the sibling site (`run-team/SKILL.md` phase 1, #1168) in a scratch repo: a clone unfetched since the rebase resolved `origin/<branch>` to the pre-rebase commit with its subject unchanged, while `git ls-remote origin refs/heads/<branch>` read the true tip from that same clone. **Re-reading `headRefOid` on a settle window does not reach that half at all** — it fires only where the two disagree — which is why the operand changes here rather than the verdict gaining a window.

   **Unequal → `git fetch origin` and read the ref once more, then decide on that second reading. Bounded at one re-read, never a third.** Neither operand is a cached value, so a stable second reading cannot flip the verdict; what the re-read is for is the ref MOVING while you verify, which is live here because one way into this fallback is a step-1 poll whose cap ran out with the ref unmoved, and that call is async — it can land a moment after you gave up on it. The two readings differ → the head is not settled and the audit behind the label verified a tree that is already gone, so **refuse: report `head-moved-after-label-#<pr>` and stop**, label untouched, the same verdict and the same remedy — a fresh finisher against the new head — the gate above reaches for a head that moved after the audit. Do not read a third time; that is the unbounded wait step 1 had to be written out of. The two readings agree → the mismatch is real and belongs to one of the two arms below. **`Equal` is not among the outcomes a surviving mismatch can reach**: a worktree that is not on the branch ref never passes this check, whatever the PR object says.

   **Ahead or behind is `git cherry origin/<branch> HEAD` from the worktree, run after that fetch — not the sha compare.** A rebase orphans the pre-rebase head, so the ref does not carry the worktree's commits BY SHA even where it carries every patch in them; read the mismatch as "commits the ref lacks" and a worktree holding no work of its own answers yes and takes the STOP. Patch equivalence is the question, and `git cherry` is the instrument this step already uses for it: a `+` → ahead; no `+` → behind, a worktree the rebase superseded included.

   - **Equal** → proceed.
   - **Worktree ahead** → STOP, report `worktree-diverged-#<pr>`. A fix-agent that committed locally but never pushed, or was aborted mid-fix, leaves an unpushed, unreviewed commit that a clean-tree audit passes. Nothing on this path pushes, so that commit cannot enter the merge — what it corrupts is the verification: rebase on top of it and both the `origin/main...HEAD` diff and the suite run against a tree that is not the reviewed head, while any merge takes the remote head, so the content-equivalence this path depends on is gone and a green says nothing about what would land. It fails silently, which is why this halts rather than proceeding on the green. The reviewed head lives on the remote, not here; hand the choice back with the PR.
   - **Worktree behind, or no worktree at all** → not a divergence. Rebase from the remote head (`git fetch` first) and say which you used.

   **Plain `git fetch origin` only — never `git fetch origin <src>:<dst>`.** `fetch.prune=true` is
   in effect here, set in `~/.gitconfig` rather than by anything this repo ships — `git config
   --show-origin --get fetch.prune` prints the file it came from, where a bare `git config --get`
   only says it is on. So it travels with this machine, not with the clone: it applies in every
   repo this operator fetches in, and not at all for anyone whose global config lacks it. Pairing
   prune with an explicit refspec **deletes the very ref the refspec names**. Reproduced
   2026-08-19 in a scratch clone: `git fetch origin main:refs/remotes/origin/main` printed
   `- [deleted] (none) -> origin/main`, took the remote-tracking refs from 10 to 8, and left
   `refs/remotes/origin/HEAD` dangling; in the live checkout the next `git rev-list` failed with
   `unknown revision`. Do not reason about which refs are "outside" the refspec — the destination
   itself goes. A plain `git fetch origin` restores it. Re-derive whatever reading you were taking
   from `git ls-remote origin`, which carries no local state, rather than trusting a number
   measured while the ref was missing.

   Run the **no-undo audit**, then before merging: diff `origin/main...HEAD` hunk by hunk — nothing but this PR's own change may appear — suite green on the rebased head, and `gh pr view <pr> --json mergeable,mergeStateStatus` reading `MERGEABLE`/`CLEAN` with the label still present, re-checked at the merge instant. Step 4 then merges whatever is actually on the remote — the pre-rebase head, since nothing here was pushed — content-equivalent to what you just verified, not graph-identical to it. Report this path as `rebase-fallback-#<pr>` with the reason; see step 4 for why its proof comes back disproved on purpose.

   **A repo that gates on currency cannot merge from this path — and this one does.** The fallback leaves the remote head behind `origin/main` on purpose, which is the exact condition `rebase-check` fails on: `.github/workflows/ci.yml` checks out `pull_request.head.sha` and exits 1 when the merge-base is not the base tip. It is an expected job, so `ci-state.mjs` reports non-green, step 3's gate never opens, and `mergeStateStatus` cannot read `CLEAN` either. The four checks above are still the honest verification of the *content*, but they do not clear that gate. So here the fallback **ends without merging**: report `rebase-fallback-#<pr>` as blocked and hand it back — choosing between resolving the conflict and turning `allow_update_branch` on is a human's call. Step 4's merge is reachable from this path only where no expected job gates on currency.

2. Watch checks settle **on the rebased head**. A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching; `release-label.yml` defines that job and exits 1 when the count of those three is zero. A stale `rebase-check` failure usually means step 1 has not landed. Where a repo chains jobs behind that check with `needs:`, they come back `skipped` rather than red and the currency check is the only thing to fix — check `ci.yml` for a `needs:` chain before assuming that: it declares none as of this reading, so no job is currently skipped behind `rebase-check`.

   **Hold the wait inside one blocking call — you are turn-based and cannot "keep an eye on" a run.** If you push and then end your turn, your pass stops there and nothing resumes it: whatever wakes you is external and may never come. Observed repeatedly — a bot rebases, pushes, goes idle, and the queue silently stalls with the PR one command from merging. Block instead, on the run step 3's first gate reading names — its `ci.runId` — the wait split by harness:

   CLAUDE: `gh run watch <run-id> --exit-status` returns only when the run reaches a terminal state; if it outlives your shell timeout, re-issue it — still one blocking call per turn, not an idle turn.
   OMP: `gh run watch` does not apply — omp `bash` backgrounds any call past about 60s even with `timeout` set, so hold the wait in one Python `eval` cell that polls `gh run view <run-id> --json status,conclusion` through `subprocess.run` until `status` reads `completed`, its cell `timeout` well above the CI cycle.

   A CI cycle here runs ~5-6 minutes. Never `sleep`-poll in a loop you exit early.

   **The wait returning is permission to look, not a verdict.** It tells you the run reached a terminal state, not which one — and that state can still change under you afterwards (step 3's second run exists for that). The decision is step 3's gate, run again, never the wait's own exit status.

   **You are the only place currency is proven, so never merge on a green from before your rebase.** The reviewer's green attests the diff was correct against *its* base — that claim does not expire and does not cover yours. Only a run on the rebased head shows it is still correct against current `main`.

   **Triage a post-rebase red by what the pre-rebase run did.** Green before, red after, with no change of your own between, means a sibling merge broke this PR semantically — a rebase applies cleanly and still breaks the build when someone renamed a symbol it uses. That is a **finding, not a chore**: report it and hand it back to the reviewer with the failing job. Red both before and after is also the reviewer's. You fix only the mechanical failures you caused: conflict resolution and the release label.

3. **Gate the merge with `merge-gate.mjs`, run twice, and merge only on the second run's exit 0.**

   ```bash
   ~/.fleet/bin/fleet-run merge-gate.mjs --pr <pr> --pre <pre> --post <post> \
     --out <scratch>/pr<N>/merge-bot-<n>/ci.json; rc=$?
   ```

   `--pre` is the head you recorded at **The labelled head**; `--post` is the head step 1's rebase produced — omit it when no rebase ran, which is the same as passing `pre` twice. `pr<N>` is this PR and `merge-bot-<n>` is your own name, so the reading lands under a directory only you write, never in the scratch root by itself: that root is injected into every dispatched member and shared with every sibling. The gate is read-only — it runs the instrument re-check, `gh pr view <pr> --json labels,reviewDecision,headRefOid` and `ci-state.mjs --pr <pr>`, answers their conjunction, and never merges, labels, rebases or waits. Stdout is exactly one JSON line, `{pr, verdict, reason, head, pre, post, behind, instruments, ci}`; stderr is its children's diagnostics, so never fold `2>&1` into the line you read. Read `rc` straight off the call, as above — never through a pipe.

   1. **Run it.** Exit 0 → go to 2. Exit 1 with a `ci:…` `reason`, `ci.runId` set and `ci.status` not `completed` → the run has started but not finished: wait on `ci.runId` (step 2), then run it again. Exit 1 with `ci.runId` **null** (`reason` starts `no CI run whose headSha equals`) → GitHub has not yet registered a run for this head at all — right after `gh pr update-branch --rebase`, the id step 2's wait blocks on does not exist yet, so never route this into step 2's `gh run watch`/`gh run view <run-id>` with a null id. Wait 15s and run the gate again instead, capped at 20 attempts (~5 minutes); no run within that cap → skip the PR and report `<reason>-#<pr>`, the same as any other exit 1. Any other exit 1 → skip the PR, report `<reason>-#<pr>` (`head-moved-after-label-#<pr>`, `label-pulled-#<pr>`, `changes-requested-#<pr>` …), leave the label where it is, and move on. Exit 2 → stop on that PR and report `<reason>-#<pr>`: the gate could not evaluate — a finding about the tree, the tooling or the API, never about the PR. Re-run once only for `rate-limited`, a quota refusal that clears by itself.
   2. **Run it again immediately before `gh pr merge`, and merge only on that second exit 0.** Anything else takes the same arms as 1, and nothing merges.

   Each `reason` is a fact the gate now enforces, not a step you run:

   - **`head-moved-after-label`** — the PR head is neither `pre` nor `post`. **Any third SHA is a push that landed while you waited on CI, and no CI check can see it**: `ci-state.mjs` selects the run whose `headSha` equals the *current* PR head (`scripts/ci-state.mjs`, the `r.headSha === prHead` filter), so a member's push plus its own green run satisfies every CI check while the audit behind the label belongs to a tree that is gone. The remedy is a fresh finisher against the new head, label untouched.
   - **`behind:<n>`** — you are the only place currency is proven, and a sibling merge since your rebase expires it (the staleness below).
   - **`instrument-set-changed` / `instruments-unanswerable`** — the instrument re-check the controller runs before its own gates (`run-team/SKILL.md`, **You read your instruments out of a tree every member can write to**), taken at this seat because nothing dispatches a merge bot to read that rule. Report `<reason>-#<pr>` with what the gate printed, leave the label alone, and do **not** re-run the gate.
   - **`ci:…`** — bound to the *run*, not to check conclusions. `gh pr checks` aggregates across runs and reports a `pass` inherited from a **cancelled** run on a superseded SHA; head-SHA binding alone misses it, since the head is right and only the conclusions belong elsewhere. `ci-state.mjs` binds run head, `status`, and every expected job from one query, and reports non-green unless the run's head matches the PR head, `status` is **completed**, and every expected job is present and succeeded. That presence requirement is what catches the case above — a force-push cancels the run under you, its finished jobs go on reporting what they concluded, and whatever never ran is missing from the run entirely, which reads as `pending` in an aggregating checks summary, never here: `ci-state.mjs` names it in the reason `expected jobs absent from the run: …` and refuses green.

   **Why twice: a conclusion can invert under a fixed run id.** A rerun rewrites the *existing* run rather than creating a new one, so a run id you read as `success` can later read `failure` with nothing pushed to the branch. Observed twice in one fleet run, on two PRs: a refresh workflow re-ran the currency check after `main` advanced and flipped the same id on the same SHA. And a CI wait puts minutes between the first reading and the merge — minutes in which the label can be pulled and the instrument set can change. Never carry a reading across a wait; the second run is the reading the merge rests on.

4. `gh pr merge <pr> --merge` (no-ff). It can exit silently — confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit` before claiming it merged. **Never `--delete-branch`**; GitHub removes the remote branch anyway.

   **`--merge` (no-ff) is load-bearing, not stylistic — and do not let a content claim reach you worded as a graph-shape one.** It always writes a **two-parent** merge commit, even where the branch is trivially fast-forwardable, and step 5's proof *requires* that: `prove-merge.sh` dies at `has no second parent — not a merge commit` and exits **2** on a single-parent merge. Exit 2 is "could not evaluate the claim at all", not "the claim is false" — so a real fast-forward leaves you with no proof to report and a halt, not a failed proof. Measured on #908: a controller brief predicted "the merge will be a fast-forward", and the merge tree *was* byte-identical to the reviewed head (`988f29d1`, `git diff <pin> <merge>` empty) — but the commit still had two parents, which is the only reason the proof was available. "The merge adds nothing" is a statement about content; **never write it as "fast-forward", which is a statement about shape, and which would have broken step 5.**

   **Prove which head landed.** A rebase-then-merge leaves no trace of *which* version went in, and "I rebased" is exactly the claim asserted without doing it:

   ```bash
   ~/.fleet/bin/fleet-run prove-merge.sh <pre-rebase-head> <rebased-head> <merge-commit>
   ```

   **No rebase happened because the PR was already current? Pass the head twice.** That is the normal case in a pass, not an edge case, and `pre == post` selects a proof path built for it. Never invent a plausible-looking `pre` to make the arguments differ — a `pre` that never landed satisfies the pre-rebase leg by construction, and passing one is the single easiest way to turn a stale merge into `proved=true`.

   **Read `gates`, not the flat fields.** The payload's flat fields are observations, and one of them being true or false says nothing about the verdict on its own. `gates` is the verdict's own working: `proved` is true exactly when every value in it is true. Membership is per-invocation — on the rebase path it carries `preDidNotLand` (leg 1), on the no-rebase path it does not, because leg 1 is dropped there. That is why `preIsAncestor:true` sits next to `proved:true` on the no-rebase path and is **not** a contradiction: leg 1 wants it false, and leg 1 is not a gate on that path (#18). A sanity check written against `preIsAncestor === false` rejects correct merges; write it against `gates` instead.

   Exit **0** proved, **1** disproved, **2** the script could not evaluate the claim at all — the merge is unreachable from `origin/main`, is not a merge commit, or an argument does not resolve. Treat 2 as "ask a human", not as a disproof.

   **A `rebase-fallback-#<pr>` merge is expected to disprove here.** Step 1's fallback never lands a rebased head on the remote, so `pre == post` and `headWasCurrent` reads false — `prove-merge.sh` exits **1**, correctly (`prove-merge.test.mjs`'s `ATTACK: un-rebased head that merged cleanly still proves false` pins exactly this shape). That is the honest answer, not a script fault. Report the merge as **argued** — backed by the fallback's four checks — and never as `proved`; a merge whose ancestry was not proved is never reported as proved.

   **Drop `in-progress` from every issue this PR closes** — the merge is the only point where the ticket number and the fact of completion are known together, and nothing else clears it:

   ```bash
   ~/.fleet/bin/fleet-run drop-merged-label.sh <pr> --apply
   ```

   Exit 0 done or nothing to close, **1 a removal failed — report it as `label-drop-failed-#<issue>`, never swallow it**: a merged ticket that keeps the label is invisible the moment it is reopened. Exit 2 means the PR was not actually MERGED yet — call this only after the merge is confirmed at the top of this step.

   Then re-fetch and **re-evaluate the queue from scratch** — labels and numbers move while CI runs, and a merge newly unblocks or blocks others.

**Staleness fires *within* a pass, and it compounds.** The first merge makes every other PR behind — including the second of this same pass, verified green minutes ago. The gate's `behind` re-reads currency before **each** merge, and refuses a behind head as `behind:<n>` — step 3.1's ordinary skip-and-report arm, same as any other exit 1: label untouched, report `behind:<n>-#<pr>`, move on to the next candidate. That PR is rebased again only if it is still labelled when a **later** merge in this pass drives the next queue re-evaluation from scratch (step 4's last line) and selects it fresh from step 1 — nothing retries it on the strength of the skip alone, and a pass that merges nothing else after skipping it reports the skip, not a retry. Any behind-count handed to you at dispatch is already expired.

Measured over one three-merge pass: the next queue member went 0 → 2 → 7 → **10 behind** without ever changing, because each merge adds its own commits plus a merge commit. So the *last* PR in a pass pays the largest rebase and the longest CI cycle, and a PR rebased early pays again for every sibling that lands after it — so never rebase a PR before it is the actual merge candidate.

**A PR whose heavy jobs have only ever `skipped` is getting its first real verification from your rebase.** Reviewers may legitimately have labelled on the checks that did run plus local evidence, saying so explicitly. When your post-rebase run finally executes those suites, treat a red there as a **genuine first result**, not a regression you caused — read the failing job before concluding, and do not hand it back as "the rebase broke it".

Report merged / skipped-unlabeled / held-behind-#X / worktree-diverged-#X / head-moved-after-label-#X / label-drop-failed-#X / rebase-fallback-#X / instrument-set-changed-#X / `<reason>-#X` for any other gate refusal / blocked after the pass — a dispatched bot once, at exit, after its grace (**Grace, then one report**, below).

## No-undo audit (before every rebase)

A rebase resolved the wrong way silently reverts work already in `main`. It looks like an ordinary conflict resolution and passes CI, because the branch's own tests never covered what it undid. Never resolve blind.

**1-3. Do not destroy unpushed work, preview conflicts, and name the work at risk** — what `main` gained in the conflicting files since the branch forked:

```bash
~/.fleet/bin/fleet-run no-undo-audit.sh <worktree> <branch>
```

It refuses (exit 1) on a dirty worktree. Exit **2** is not that refusal: it means the audit could not answer at all — a bad argument, no such worktree, a worktree git does not answer for (its linkage is broken, and git still answers at rc 0 — for the enclosing repo when the `.git` is gone, from another worktree's HEAD and index when it names that worktree's admin dir), `BASE_REF` is not spelled `origin/<branch>` or `refs/remotes/<path>` (#1565), `BASE_REF` names the audited branch (#1565), a ref that does not resolve, a probe that could not run, or a conflicting path no pathspec can name — and it emits no payload. What it will **not** do is spend a 2 on the formatting of `worktree` or `branch`: those two echo the arguments you handed it rather than reporting a finding, so an escaper that cannot render one leaves that field and its `*Rewritten` flag as JSON `null` and the run still delivers `clean`, `stash`, `conflicts[]` and `atRisk[]` at its own exit code, naming the field and the escaper on stderr. Read a `null` there as "this run could not render the path or branch you passed in" — it is **never** "there is no worktree", and never a path: pasting it into a command builds a pathspec matching nothing, the same empty-reads-as-proven trap the `conflictsRewritten[]` note below describes. Treat 2 as "ask a human", never as "the worktree is dirty"; there is nothing to commit and hunting for it wastes the pass. **Never** `git clean`, `git checkout .`, `git reset --hard`, or `git stash` to make it pass — that work is unrecoverable and is not on the remote, and stashing it clears `porcelain` so the audit passes on the next run without the work ever shipping. The stash count it prints is reported, not gated: the stack is repo-global across worktrees, so a nonzero count is usually the maintainer's. It can also come back `unknown` rather than a number. Usually the list came back empty and the audit cannot call that an empty stash: `refs/stash` is not absent, which an unreadable ref, an unreadable reflog, or a ref pointing at a missing object each produce just as a genuinely empty stash would. The fourth cause is the opposite shape: `refs/stash` **is** absent while its reflog is not, so the entries it names are unreachable rather than gone. One cause is neither shape: `git stash list` printed entries and then exited nonzero, so what it printed is short — a corrupt loose object behind an entry that is not the tip does this, and the audit reports `unknown` there rather than the number it could have counted. The audit's line says which of them you have. None is the same thing as an empty stash and the audit no longer conflates them. The number it prints is a floor, not a proof: a reflog that is merely truncated — some entries lost, the rest still parsing — drops the missing entries from `git stash list` itself, so the audit and your own read of the list come up short by the same ones and neither reports it. Read `git stash list` yourself when the count is nonzero **or `unknown`** — an entry naming this branch may be a dead member's only copy — and never pop, drop or apply an entry you did not create. On `unknown` do not stop at that list: the causes git stays silent about leave it empty at rc 0, so the list alone shows you nothing. The missing-object cause is the one git is not silent about: `git stash list`'s own stderr there already ends `fatal: bad object refs/stash`, naming that cause outright, so read that line first. The corrupt loose object is named outright too — `fatal: loose object … is corrupt`, printed after the entries git could read — and the audit's own line carries that text for you either way. For the causes it stays silent on, read the files behind it. Set `c=$(git rev-parse --git-common-dir)` — the stack is repo-global, and a linked worktree's `.git` is a file, so `.git/refs/stash` reaches nothing — then `ls -l "$c"/refs/stash "$c"/logs/refs/stash`, where a mode of `----------` on either, or a `Permission denied` from `ls` itself, is the fault, and `cat "$c"/logs/refs/stash`, which still names the branch when `refs/stash` is the unreadable one. `No such file or directory` for `refs/stash` alone, with the reflog listing beside it, is the fourth cause: recover from the SHAs `cat` prints, do not rebase over it. A missing `refs/stash` file is not an empty stash: `git gc` packs it into `packed-refs`. When both reads instead come back with nothing to recover from — `cat` denied, or a reflog that is present but blank — `git show refs/stash` still resolves the ref whether loose or packed, printing the `WIP on <branch>` label; it prints no diff beside that label when the stashed change was staged before `git stash`, so read the content with `git stash show -p refs/stash`, which prints the hunk either way. Both fail only where the ref FILE is itself the broken one — unreadable, holding text that is not a SHA, or gone with nothing in `packed-refs` — and there the SHA `cat` already printed, in the reflog's second field, is what `git stash show -p <that sha>` recovers instead. That fallback is a SHA `cat` printed, so it is gone where the reflog is the denied read too — both files unreadable, `refs/stash` holding text that is not a SHA while the reflog cannot be read, or `refs/stash` gone with nothing in `packed-refs` while the reflog cannot be read — and nothing ref-based recovers there: `git stash list` is still empty at rc 0, `git show refs/stash` answers `ambiguous argument` and `git stash show -p refs/stash` answers `not a valid reference`, and no SHA was printed to hand them instead. Restore read permission where the mode is yours to fix — on whichever of the two files `ls` gave a `----------`, or on the `logs/refs` directory when `ls` failed before printing a mode at all. Only the both-files-unreadable shape then has `git stash list` name the entry again on its own, measured, because the ref file's own content was never touched, only its permission. The other two shapes leave `refs/stash` itself broken — deleted, or holding garbage text — so restoring the reflog's mode only unlocks the SHA `cat` now prints; `git stash list` stays empty at rc 0 until you clear the broken ref and re-point it yourself. `git update-ref refs/stash <that sha>` works directly once `refs/stash` is already gone; where it instead holds garbage text, `git update-ref` refuses that too (`reference broken`, even with `-d`) until you `rm` the file first. Either path is measured to list the entry again as a new `stash@{0}` (an empty-subject entry the update itself adds), pushing the recovered one down to `stash@{1}` rather than restoring it to its original slot. Where there is no mode left to fix — both files are simply gone, with nothing in `packed-refs` and no reflog to read either — `git fsck` still prints a `dangling commit <sha>` line per stash entry, objects loose or packed — at a nonzero exit in the unreadable-ref shape, so read its lines and not its status — and `git stash show -p <that sha>` prints the hunk there, refusing anything that is not a stash (`is not a stash-like commit`). Treat it as a lead, not a listing: no `stash@{N}` comes back with it, and an entry someone dropped on purpose is indistinguishable from a live one. Read the at-risk commits the audit lists first; those are what a careless resolution deletes.

**4. Take `main`'s side wholesale, then re-apply the branch's delta on top.** Never blanket `-X ours` / `-X theirs`. The branch's side is by definition *pre-merge* text — on a docs or comment hunk it carries claims a later PR already corrected, and keeping it reintroduces them silently.

**5. Before pushing, prove nothing was undone:**

```bash
git diff origin/main...HEAD -- <conflicting files>
```

Three dots, never two: a two-dot diff on a stale branch renders `main`'s gains as deletions and reads as a mass revert. Every hunk must be the PR's own intended change. A deletion of a line `main` introduced that this PR has no business touching means the resolution ate merged work — redo it. Re-derive any numbers, offsets or anchors the conflict touched rather than carrying stale ones.

`<conflicting files>` is the audit's `conflicts[]`, not typed by hand — and `conflictsRewritten[]` sits next to it for exactly this step. A path is reported at the same index in both arrays; `true` there means the path held a control byte the audit could not give a JSON short form to and replaced with a space, so the string in `conflicts[]` is not the byte-for-byte name of anything on disk. Pasting it into the command above builds a pathspec that matches nothing — the diff comes back empty, and empty reads as "nothing to prove", the opposite of unproven. Skip the command for any path flagged `true` and inspect it by hand (`git status`, or `ls` the worktree) instead of by pathspec.

## Grace, then one report

**Only a bot a controller dispatched holds a grace** (`/fleet-ctl:run-team`, or any caller that says it owns the watcher); the top-level invocation arms its Monitor instead (**Then stay armed**). You were dispatched on the first `ready-to-merge` label, never after anyone's report, and a label landing minutes after your last merge is the common case — so the pass does not end the moment the queue empties. It drains, then waits **15 minutes** for late labels, then reports once:

- Grace starts once no labelled PR is actionable — every one merged, skipped or held. Seed the labelled set then, the way **Then stay armed** seeds its Monitor, so a PR you already handled does not re-fire.
- Every 60s, poll `gh pr list --state open --label ready-to-merge --json number`. A number not in the seed → **re-run selection from the top**, hold rule included, drain what it makes actionable, and restart the grace after that drain. A failed poll is no reading: keep the seed and poll again.
- 15 minutes with no new label → report and exit.

The wait itself splits by harness:

CLAUDE: hold the grace in foreground `Bash` calls of at most 4 minutes each, polling every 60s inside each — about four per grace — so no turn outlives the 5-minute prompt-cache cliff.
OMP: the 4-minute foreground `Bash` chunking does not apply — hold the whole grace in one Python `eval` cell that polls `gh` through `subprocess.run`, its cell `timeout` at 1000s or more; never `bash` plus `wait`: omp `bash` backgrounds any call past about 60s even with `timeout` set, and `wait` then returns "Skipped due to a queued background completion".

**One report, at exit, and none before it** — every PR this pass touched, in the vocabulary above, a pass that merged nothing included. The controller reaps on that report and records each `held-behind-#<lower>` on the held ticket's row, so a report sent mid-pass is one it acts on too early.

CLAUDE: `SendMessage` the report to the controller, then exit.
OMP: a separate send does not apply — your `task` result is the report, delivered when you exit.

## Then stay armed

**Skip this whole section if a controller dispatched you** (`/fleet-ctl:run-team`, or any
caller that says it owns the watcher) — hold the grace above instead. A
monitor armed by a member dies with that member and the queue stops silently, so
the watcher belongs to whoever outlives the pass. Only arm one when you are the
top-level invocation.

The pass ends, the queue does not. Once no labeled PR is actionable, arm a persistent Monitor so a later sign-off restarts the loop without re-running this command:

```bash
poll() { gh pr list --state open --label ready-to-merge --json number --jq '.[].number' 2>/dev/null; }
if seed=$(poll); then
  seen=" $(printf '%s\n' "$seed" | tr '\n' ' ')"
else
  echo 'ready-to-merge monitor: seed poll failed, not arming'
  exit 1
fi
while true; do
  sleep 60
  if cur=$(poll); then
    while IFS= read -r n; do                 # capture-then-loop: heredoc-fed, never `for n in $cur`
      [ -n "$n" ] || continue                # a blank line in OUR OWN list, not a probe that could not look
      case "$seen" in *" $n "*) ;; *) echo "ready-to-merge label added: PR #$n" ;; esac
    done <<EOF
$cur
EOF
    seen=" $(printf '%s\n' "$cur" | tr '\n' ' ')"
  fi
done
```

Arm with `persistent: true`, description `ready-to-merge label on this repo's PRs`. Details that matter:

- Seed `seen` **before** the loop so PRs already handled — including ones skipped for `CHANGES_REQUESTED` or left on red CI — do not re-fire every minute. Only a label appearing after arming is an event. The seed poll is guarded the same way as every tick: a `gh` call failing on the very first poll must not arm on an empty `seen`, which would replay the whole labeled set as spurious events on tick one.
- The `if cur=$(poll)` guard — seed and every tick alike — keeps `seen` intact when a `gh` call fails transiently; without it a failed poll reads as an empty labeled set and either arms on nothing (the seed) or wipes `seen` (a tick), both replaying the full labeled set as events on the next successful poll. The guard depends on `poll` ending in the bare `gh` call, not in a pipe: `tr` sits at the call sites (not inside `poll`) precisely so a failing `gh` call's exit status reaches `cur=$(poll)` / `seed=$(poll)` instead of being swallowed by `tr`, which exits 0 regardless of what it reads.
- **The per-PR loop is heredoc-fed on purpose — `for n in $cur` is the one form that cannot work here.** This runs under zsh, which word-splits an unquoted command substitution's result but *not* an unquoted parameter expansion, and `cur` is a parameter. Measured on zsh 5.9 with `seen="849 850 "` and `cur="849 850 852 "`: the bare form runs **one** iteration with the whole list glued into a single value and emits `ready-to-merge label added: PR #849 850 852`, one nonsense event naming no PR, while the real new PR is never reported; the heredoc form emits `PR #852` alone. `run-team/SKILL.md`'s **Shell traps** carries the mechanism, the remedy table and the `</dev/null` trap that bites the next command added inside this loop. Note the contrast with step 1's `for _ in $(seq 1 60)`: that is a command substitution, it splits, and it is correct as written.
- 60s poll — remote API, stay off rate limits.
- A held PR stays in `seen`, so its own label will not re-fire. Fine: what unblocks it is the **lower** PR getting labeled, which does fire, and step 4's re-evaluation picks up both in numeric order.

On an event, do not merge that PR on sight — **re-run selection from the top**, hold rule included. Report each outcome and leave the monitor armed. One watch per session; stop with TaskStop.
