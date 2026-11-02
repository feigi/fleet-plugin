# S7 — review, fix, CI watcher, recipe (snapshot origin/main 1a9692aa)

Reading guide: `plugin/` paths are relative to the repo root. `push-sync.mjs`, `ledger.mjs`, `fleet-event.mjs`, `label-map.mjs` are other slices' files; they are cited only where an S7 file points a member at them, and the entry says so.

Fleet comment/body markers found in S7 files (verbatim shapes; none names a run, member or Instance):
- PR comment `ready-to-merge-head: <prHead>` — `plugin/commands/review-and-fix.md:28` (prHead = full SHA of the green ci-state reading).
- Issue body line `Deferred from PR #<pr> review` plus the finding's `dimension` — `plugin/commands/review-and-fix.md:25`.
- Issue title `PR #<pr> review: the suggestion band, checked`, label wontfix, then CLOSED — `plugin/commands/review-and-fix.md:25`, `plugin/scripts/dispositions-check.mjs:241`.
- Comment opening `Promoted — applied, not filed` on that record issue — `plugin/commands/review-and-fix.md:25`.
- PR comment "the numbers" of the filed deferral issues (no fixed shape) — `plugin/commands/review-and-fix.md:25` (end of step 5).
- Ledger token `ci=<run-id>:<attempt>:<conclusion>` — LOCAL only (`plugin/scripts/fleet-event.mjs:812`), not on GitHub.
- Snapshot commit `review snapshot of $SHA` (user `fleet`/`fleet@invalid`) — LOCAL throwaway repo, never pushed (`plugin/scripts/review-core.mjs:1082`).

---

### S7-1 CI watcher lists every open PR of the repository
- Where: `plugin/skills/run-team/references/ci-watcher.md:28` (+ `:18`, `:36-38`, `:43`, `:57`)
- Kind: read-select
- Does: `prs=$(gh pr list --state open --limit "$pr_cap" --json number --jq '.[].number' 2>/dev/null)` with `pr_cap=200`; no `--author`, no `--label`, no `--head`.
- Scope today: repo-wide (every open PR, whoever opened it, whatever its branch)
- Feeds / Selected by: feeds the per-PR pass `for pr in $(printf '%s\n' "$prs")` (`ci-watcher.md:80`) → `ci-state.mjs --pr "$pr"` (`:81`, entry S7-2) → "your normal handling of $st … `fleet-event.mjs ci "$pr"`" (`:93`, entry S7-3). Also sets the budget reserve `200 + 4 * count` (`:43`, `:57`) and the cap latch `open-PR list hit its --limit $pr_cap — PRs past it are NOT watched` (`:36-38`), so other Instances' PRs spend this Instance's REST budget and trip its DEGRADED lines. Upstream: none (a selecting read; seeded by nothing).
- Exists because: "a probe that cannot read is a transition event, not silence" (`ci-watcher.md:9`); "Every open PR stalls unlabelled while the run reads as merely quiet" (`ci-watcher.md:250-252`) — the watcher is the controller's only CI wake.
- Own-work limit: only the PRs this Instance owns (PRs whose rows its ledger holds / whose head branches it created). The watcher needs a different list source than the repository's whole open-PR set; when ownership of a PR is unknown it must not poll or count it (stall = no wake for it).
- Mark: PR (or its head branch); nearest mark today: none on this read (no filter at all); head branch name / author login exist on the rows but are not used here. Tells Instances apart under one gh user: no; under different gh users: yes (author login), but not applied.
- Notes: the same block is armed "verbatim" from `plugin/skills/run-team/SKILL.md:646-647`. The block's own comment says the cap rule mirrors `candidates.mjs`'s `refuseIfCapped()` and `fleet-tick.mjs`'s `PR_LIMIT` (`ci-watcher.md:126-128`).

### S7-2 CI watcher runs ci-state against every listed PR (rules, runs, compare)
- Where: `plugin/skills/run-team/references/ci-watcher.md:81`; `plugin/scripts/ci-state.mjs:459-461` (GraphQL `pullRequest(number: $pr)` + `object(expression: "refs/pull/<pr>/head")`, `:402-411`, `:484-485`), `:676` (`gh api repos/{owner}/{repo}/rules/branches/<base>`), `:693` (`gh api repos/{owner}/{repo}/branches/<base>`), `:742-744` (`gh run list --branch <headRefName> --workflow CI --limit 30`), `:830-832` (`gh run view <runId> --json jobs,attempt,status,conclusion,headSha`), `:896` (`gh api … repos/<nameWithOwner>/compare/<base>...<prHead>`)
- Kind: read-select
- Does: `st=$(~/.fleet/bin/fleet-run ci-state.mjs --pr "$pr" 2>/dev/null)` per listed PR; ci-state itself is read-only (no write anywhere in the file).
- Scope today: per-object from `--pr` (caller-supplied); no ownership check inside ci-state; fed repo-wide by S7-1 in the watcher. `gh run list --branch <branch>` returns every run on that branch name, whoever triggered it.
- Feeds / Selected by: selected by S7-1 (`ci-watcher.md:80-81`); feeds the CI wake (S7-3) and, in the standalone path, the label gate (S7-16, `plugin/commands/review-and-fix.md:35-38`).
- Exists because: `gh pr checks` "reports a `pass` inherited from a cancelled run on a superseded SHA" (`ci-state.mjs:5-8`); the run is bound to the PR head.
- Own-work limit: reads only this Instance's own PRs and the runs of their own head branches; PR number must come from a row this Instance holds; unknown ownership → do not call.
- Mark: PR / head branch; nearest mark today: head branch name (`headRefName` read at `ci-state.mjs:494`, `--branch` at `:744`); tells Instances apart under one gh user: no; under different gh users: no (a branch name carries no user).
- Notes: the behind-count compare (`:896`) is informing-only (`behind` is "context for the caller, not part of the green verdict", `:914-917`). The cost is quoted per PR, "4 core REST units" (`ci-watcher.md:140-142`), account-wide: "another run on the same token, or any `gh run` use, spends it" (`ci-watcher.md:199-202`) — two Instances on one gh user share this budget.

### S7-3 CI wake books a `ci=` token for any PR the watcher lists
- Where: `plugin/skills/run-team/references/ci-watcher.md:93` (instruction); consequence in `plugin/scripts/fleet-event.mjs:790-819` (`ci-state.mjs --pr <pr>` again at `:791`, then `ledger.mjs token <pr> ci=<run-id>:<attempt>:<conclusion>` at `:817`) and `plugin/scripts/ledger.mjs:3182-3185` ("else `#M`, created when neither exists")
- Kind: instruction-read
- Does: "a run at a terminal state is the CI wake: `fleet-event.mjs ci "$pr"`"; re-reads ci-state for that PR and appends a token to the PR's ledger row, creating a `#M` row for a PR the ledger does not know (ledger.mjs header, `:3182-3185`).
- Scope today: per-object from the watcher's `$pr`, which is repo-wide (S7-1)
- Feeds / Selected by: selected by S7-1/S7-2 (`ci-watcher.md:80-93`); the token is host-local (ledger invisible to other Instances) but "the tick reads the run off `.fleet/ledger.md`" and a green CI plus a returned review is what lets a finisher be dispatched (`plugin/commands/review-and-fix.md:24`) → label write (S7-16). [INFERENCE] whether the tick treats a CI-only row of an unknown PR as dispatchable is for the ledger/tick slices; nothing in S7 files says it does not.
- Exists because: "a wake you have not written down is one it cannot see" (`plugin/skills/run-team/references/ci-and-staleness.md:177-179`).
- Own-work limit: only books tokens for PRs this Instance owns; a CI wake for an unowned PR writes nothing (stall).
- Mark: PR row on the local ledger; nearest mark today: none on GitHub (ledger is local); tells Instances apart under one gh user: no; under different gh users: no.
- Notes: host-local state, cited because it gates later GitHub writes.

### S7-4 Controller is told to arm a persistent Monitor over "open PRs' latest runs"
- Where: `plugin/skills/run-team/references/ci-and-staleness.md:14-17`, `:24-31`
- Kind: instruction-read
- Does: "controller arms second persistent Monitor over open PRs' latest runs, keyed `<run-id>:<attempt>:<conclusion>`"; "Take run id, head, conclusion from **one** `gh run list --json` row"; members re-query `gh run view <rid> --json jobs` at labelling time.
- Scope today: repo-wide (open PRs) for the Monitor; per-object from the member's own run for the labelling re-query
- Feeds / Selected by: same set as S7-1/S7-2 (the Monitor is the block in `ci-watcher.md`, armed from `plugin/skills/run-team/SKILL.md:646-647`); feeds S7-3.
- Exists because: "Members turn-based, cannot hold across ten-minute run" (`ci-and-staleness.md:12`).
- Own-work limit: the Monitor's PR set limited to this Instance's own PRs (see S7-1); the labelling re-query is own-only when its PR is.
- Mark: PR / head branch; nearest mark today: none (open PRs, unfiltered); tells Instances apart under one gh user: no; under different users: no.

### S7-5 Controller is told to arm a `ready-to-merge` Monitor that "catches hand-added labels as well as a finisher's own"
- Where: `plugin/skills/run-team/references/ci-and-staleness.md:185-191` (same instruction `plugin/skills/run-team/SKILL.md:165-168`)
- Kind: instruction-read
- Does: "Arm one yourself, `persistent: true`, seeded before the loop so handled PRs do not re-fire" — the watcher command itself is not in this file; the selector is by the ready-to-merge label (Label role).
- Scope today: label-wide [INFERENCE from "catches hand-added labels" — the command text is in SKILL.md/merge-bot slice, not S7]
- Feeds / Selected by: feeds `fleet-event.mjs label <pr>` and `DISPATCH merge-bot` (`SKILL.md:165-166`) → merge bot's `gh pr update-branch --rebase` (`ci-and-staleness.md:187`) → merge.
- Exists because: a human may add the label; "The bot does not wait for that finisher's report" (`ci-and-staleness.md:186`).
- Own-work limit: only reacts to ready-to-merge on PRs this Instance owns; a label on an unowned PR is ignored (stall).
- Mark: PR; nearest mark today: ready-to-merge label (state, not owner); tells Instances apart under one gh user: no; under different gh users: no.
- Notes: `ci-and-staleness.md:187` names `gh pr update-branch --rebase` as the merge bot's server-side rebase (a GitHub write on the labelled PR's head branch) — not in an S7 file's own instruction beyond this mention.

### S7-6 Review snapshot reads the PR, its branch and its head by number — no ownership check
- Where: `plugin/scripts/review-core.mjs:1153-1163` (`gh repo view --json url`, `gh pr diff ${pr} -R "$REPO"`, `gh pr view ${pr} -R "$REPO" --json body,commits|isCrossRepository|headRefName|headRefOid`, `git -C ${worktree} ls-remote origin "refs/heads/$branch"` at `:1160`, `git … ls-remote origin "refs/pull/${pr}/head"` at `:1161`), `:1228-1229` (`diff-stats.mjs --pr ${pr} --repo "$REPO"`), `plugin/scripts/diff-stats.mjs:235` (`gh pr view <pr> --json files,changedFiles [-R repo]`)
- Kind: read-select
- Does: all keyed on `args.pr` (`review-core.mjs:1003`, validated only as digits at `:1034`); `$branch` is whatever `gh pr view` reports for that PR. Nothing here writes to GitHub; the review writes no comment, label or review on the PR (grep of review-core.mjs, review-eval.mjs and the `fleet-review-*` agents: no `gh` write, no `git push`).
- Scope today: per-object from `args.pr` (supplied by the controller via `plugin/skills/run-team/briefs/review-runner.md:10-17` → `plugin/agents/fleet-review-runner.agent.md:9-14`); ownership of that PR is never checked here.
- Feeds / Selected by: feeds the review result file `<scratch>/pr<pr>/<run>/review.json` that the fix-applier reads and writes against (S7-8..S7-14); selected upstream by the controller's choice of PR for `review-pr-<pr#>` (other slices).
- Exists because: "a 'gh' with no -R reads whichever PR in THAT repository shares the number" (`review-core.mjs:1143-1146`); the same-repo branch ref is read with `ls-remote` so the diff is judged against the reviewed head.
- Own-work limit: only a PR this Instance owns may be reviewed; the runner must be dispatched with a PR number taken from an Instance-held row; ownership unknown → refuse before any `gh` read (stall).
- Mark: PR; nearest mark today: none checked in this path (author login/head branch name are read here only as data); tells Instances apart under one gh user: no; under different gh users: yes (author login) but not applied.
- Notes: `reclaim-scratch.mjs --pr ${pr} --root … --apply` at `review-core.mjs:1075` is host-local. The cross-repo branch is `isCrossRepository` (`:1157`).

### S7-7 Standalone `/review-and-fix` acts on whatever PR number the user names
- Where: `plugin/commands/review-and-fix.md:3` (`argument-hint: [pr-number]`), `:14`, `:22`
- Kind: instruction-write
- Does: no PR-selecting read (no `gh pr list`, no `--author`, no `$ARGUMENTS` handling in the file); the PR is the one the invoker names; the command then reviews it (hand-dispatch of the six `fleet-review-*`, `:14-16`), pushes to its branch (S7-8), edits its body (S7-9), comments and labels it (S7-16).
- Scope today: per-object from the user's argument; no precondition that the PR is this Instance's own
- Feeds / Selected by: feeds S7-8, S7-9, S7-10..S7-16; selected by the invoker.
- Exists because: it is the human/standalone entry; "Run standalone, with no dispatcher" (`review-and-fix.md:6`).
- Own-work limit: only targets this Instance's own PR; a PR whose ownership is unknown → stall (ask/refuse), never act.
- Mark: PR; nearest mark today: none checked; tells Instances apart under one gh user: no; under different gh users: yes (author login) but not applied.

### S7-8 Fix-applier pushes to the PR's head branch through `push-sync.mjs`
- Where: `plugin/commands/review-and-fix.md:22`; `plugin/skills/run-team/briefs/fix-applier.md:96`, `:100`; `plugin/agents/fleet-fix-applier.agent.md:348`; implementation (other slice) `plugin/scripts/push-sync.mjs:155`, `:160`, `:175-177`; branch source `plugin/skills/run-team/references/reviewers.md:94-102`
- Kind: instruction-write
- Does: `~/.fleet/bin/fleet-run push-sync.mjs --branch <branch>` — `push-sync.mjs:175` runs `git push [--force-with-lease] origin HEAD:refs/heads/<branch>`; the lease flag is optional (`:155`, `:160`) and is NOT shown in either brief line (`fix-applier.md:96`, `:100`). `--force-with-lease` is the bare form (no `<ref>:<expect>`), so git's expectation is the local remote-tracking ref [INFERENCE — git behaviour, not read in plugin code]. The conflict kind first runs `git fetch origin && git rebase origin/main` (`fix-applier.md:93-96`, `:141`), which refreshes that tracking ref.
- Scope today: per-object from the brief's `branch` arg (`fix-applier.md:3`, `:21`: "the push destination below, given to you because a detached worktree cannot supply it"); the controller derives it from "the PR's head branch — `gh pr view <N> --json headRefName -q .headRefName`, or the same branch you cut the worktree from" (`reviewers.md:94-97`). Precondition today: git's own fast-forward rule (and lease, when passed); no check that the branch's tip is this Instance's.
- Feeds / Selected by: selected by the dispatch (`fix-applier.md:2-7` args `pr`, `branch`, `worktree`) the controller builds from the PR's row; feeds the head SHA the finisher is later pinned to (`plugin/agents/fleet-fix-applier.agent.md:286-293`).
- Exists because: "a bare `git push` exits 128 (`fatal: You are not currently on a branch`)" from a detached worktree; the refspec push alone leaves the claim worktree's ref at the old tip (`review-and-fix.md:22`).
- Own-work limit: only targets this Instance's own PR head branch; a non-fast-forward or a tip the Instance did not push must stall, never force; unknown ownership → no push.
- Mark: branch; nearest mark today: head branch name (`implementer/<N>-impl-<N>[-x]` style per the Marks list; real patterns are in other slices) — names the ticket/kind, no Instance part; tells Instances apart under one gh user: no; under different gh users: no.
- Notes: a rebased conflict-kind push with no `--force-with-lease` named in the brief would be rejected as non-fast-forward by git [INFERENCE]; the brief text does not say which form the member must use.

### S7-9 Fix-applier overwrites the PR body (and may correct a body finding)
- Where: `plugin/commands/review-and-fix.md:22` (`gh pr edit <pr> --body-file <path>`), `:113` ("A false claim in the PR body is corrected there, by editing it with `gh pr edit`")
- Kind: instruction-write
- Does: `gh pr edit <pr> --body-file <path>` — replaces the whole body; "re-read the body against the final diff".
- Scope today: per-object from `<pr>` of the dispatch; no precondition (no read-modify-write guard, no check that the body's last editor was this Instance)
- Feeds / Selected by: selected by the fix-applier's own PR number (`fix-applier.md:7`, `review-and-fix.md:22`); feeds the permanent record ("It merges into the permanent record and nothing downstream re-derives it", `:22`).
- Exists because: a removed or reversed change "leaves the body asserting work the diff no longer contains".
- Own-work limit: only edits the body of this Instance's own PR; unknown ownership → stall.
- Mark: PR body; nearest mark today: none (body content is free text); tells Instances apart under one gh user: no; under different gh users: no.

### S7-10 Fix-applier files each deferred finding as a new issue labelled `needs-triage`
- Where: `plugin/commands/review-and-fix.md:25` (`gh issue create --label "<needs-triage string>"`), `:27`
- Kind: instruction-write
- Does: creates a NEW issue (own object) with body `Deferred from PR #<pr> review`, `file:line`, the finding's `dimension`, refuter verdict and candidate remedy; "Every issue you create is labelled `needs-triage`"; `ledger.mjs filed <N> "<subject>"` records it locally.
- Scope today: no precondition (creation); per-object from `<pr>` for the marker text
- Feeds / Selected by: feeds the shared backlog every Instance's triage/pool reads ("invisible to both `candidates.mjs --require-label` and the cockpit's pool query", `:25`); selected by the fix-applier's own deferral list.
- Exists because: "A finding is deferred, never dropped" (`review-and-fix.md:19`).
- Own-work limit: creation targets only its own new issue; the issue carries whatever mark the decision picks so other Instances can tell whose backlog item it is.
- Mark: issue; nearest mark today: closing/body reference `Deferred from PR #<pr> review` (names a PR, not an owner) and label needs-triage; tells Instances apart under one gh user: no; under different gh users: yes only via issue author login (not used).

### S7-11 Fix-applier files/closes the suggestion-band record issue, one per PR review
- Where: `plugin/commands/review-and-fix.md:25` (`gh issue create --label "<wontfix string>"` then CLOSED; "Append it to the same closed record issue under a `Below the claim bar` heading"), `plugin/scripts/dispositions-check.mjs:147-148`, `:241`, `:254`
- Kind: instruction-write
- Does: title `PR #<pr> review: the suggestion band, checked`, created then closed; later entries appended to it; its `home` is judged as "already closed and labelled `wontfix`" with trimmed title equal to `recordTitle(pr)` (`dispositions-check.mjs:254`).
- Scope today: per-object by title/PR number (`recordTitle(pr)`); an existing record is found by the tracker search (S7-12), so a second review of the same PR — from any Instance — lands on the same record
- Feeds / Selected by: selected by `ledger.mjs check` tracker rows (S7-12) and the PR number; feeds `dispositions-check.mjs` home verdicts (S7-15), which gate the finisher.
- Exists because: a refuted suggestion must not read as queued agent work; "Closed is still a durable home — `check` reads the tracker at `--state all`" (`review-and-fix.md:25`).
- Own-work limit: only creates/appends/closes a record for a PR this Instance reviewed itself; a record created by another Instance stalls (no append).
- Mark: issue; nearest mark today: title `PR #<pr> review: the suggestion band, checked` (a PR number, no owner); tells Instances apart under one gh user: no; under different gh users: no (issue author login exists, unused).

### S7-12 Duplicate guard searches the whole tracker before filing
- Where: `plugin/commands/review-and-fix.md:25` (instruction `~/.fleet/bin/fleet-run ledger.mjs check "<subject>"`); implementation (other slice) `plugin/scripts/ledger.mjs:1331-1334` (`gh issue list --search <query> --state all --limit <n> --json number,title,state,url`)
- Kind: instruction-read
- Does: `ledger.mjs check` "reads this run's filed list *and* the tracker at `--state all`, so a closed duplicate still counts"; exit 3 = "a clean ledger with matching tracker rows that score against the subject".
- Scope today: repo-wide (every issue, open and closed, matched by a subject text query)
- Feeds / Selected by: feeds S7-13 (comment onto the existing follow-up) and "file a new open issue citing" a closed record (`:26`); selected by the subject string (finding text).
- Exists because: "the duplicate class that guard exists to catch was filed from *here*" (`review-and-fix.md:25`).
- Own-work limit: informs only; whatever it returns, the write that follows may touch only this Instance's own issues; a hit on another Instance's issue must not be commented on without ownership proven (stall = file own issue citing it, or skip).
- Mark: issue; nearest mark today: none (query by text); tells Instances apart under one gh user: no; under different gh users: no.

### S7-13 Fix-applier comments onto an existing open issue chosen by that search
- Where: `plugin/commands/review-and-fix.md:25` ("comment on the existing follow-up rather than filing a second issue"; `Promoted — applied, not filed` comment on the record), `:26` ("A duplicate that should hold an open deferral is a comment, never a relabel")
- Kind: instruction-write
- Does: `gh issue comment` on an issue found by S7-12 — cites "the refuters' verdict — or the review's votes"; "change no label".
- Scope today: per-object from the tracker rows `ledger.mjs check` printed; no precondition on who authored or holds the issue
- Feeds / Selected by: selected by S7-12 (`review-and-fix.md:25-26`); feeds the issue number written as `issue` in the disposition record (`:27`) that S7-15 reads back.
- Exists because: a duplicate "becomes a comment on the issue that already covers it, never a dropped finding".
- Own-work limit: only comments on issues this Instance itself filed; a match on another Instance's issue → stall (record `issue` as unchecked/escalate) rather than write.
- Mark: issue + comment; nearest mark today: comment opening `Promoted — applied, not filed` (for the record issue only); tells Instances apart under one gh user: no; under different gh users: yes only via comment author (not read).

### S7-14 Fix-applier posts the filed-issue numbers as one PR comment
- Where: `plugin/commands/review-and-fix.md:25` (last sentence of step 5: "Post the numbers as one PR comment.")
- Kind: instruction-write
- Does: `gh pr comment` on the fix-applier's PR; shape of the comment not fixed in the file.
- Scope today: per-object from `<pr>` of the dispatch; no precondition
- Feeds / Selected by: selected by the dispatch PR; feeds nothing programmatic found in S7 files.
- Exists because: leave the deferral numbers visible on the PR.
- Own-work limit: only on this Instance's own PR.
- Mark: PR comment; nearest mark today: none; tells Instances apart under one gh user: no; under different gh users: no.

### S7-15 dispositions-check reads back each deferral's issue
- Where: `plugin/scripts/dispositions-check.mjs:727` (`gh issue view <n> --json labels,state,title`), `:722-744` (`issueReader(repo)`), `:253-254` (`homeHolds`), `:968` (unchecked message); entry point `:837`
- Kind: read-select
- Does: for each deferral's `issue` number taken from the fix-applier's own record `<scratch>/dispositions-<member>.json` (`:909-929`), runs `gh issue view` from `--repo` (cwd) so gh resolves the tracker from that repository's remotes (`:716-719`); compares state/title/labels to the filing-table row (`:115-148`).
- Scope today: per-object from a record-supplied number (model-written; it may name an issue the fix-applier only "commented onto", `review-and-fix.md:27`)
- Feeds / Selected by: selected by the record (`dispositions-check.mjs:909`); feeds the verdict `ok|mismatch|escalate|unchecked` that `ledger.mjs dispatch` uses to refuse or allow the PR's finisher (`:153-157`; `review-and-fix.md:28`) → label write S7-16.
- Exists because: "that issue — read back through `gh issue view --json labels,state,title` — must be its finding's home in this table" (`:115-118`).
- Own-work limit: read only issues this Instance filed/commented-on for its own PR's record; an issue it did not create reads as unchecked (stall).
- Mark: issue; nearest mark today: title `PR #<pr> review: the suggestion band, checked` + wontfix label for the record row (`:254`); needs-triage/ready-for-agent labels for open rows; tells Instances apart under one gh user: no; under different gh users: no.
- Notes: the PR number comes from the member name `fix-pr-<M>` (`:844-846`), the merge-base is `git merge-base origin/main <review head>` (`:931`) — local ref, config.

### S7-16 Finisher/standalone writes `ready-to-merge-head:` comment and the ready-to-merge label
- Where: `plugin/commands/review-and-fix.md:28` (`gh pr comment <pr> --body "ready-to-merge-head: <prHead>"`; `gh pr edit <pr> --add-label "<ready-to-merge string>"`), `:35-38` (`ci-state.mjs --pr <n>`), `:28` (release label count `patch|minor|major`)
- Kind: instruction-write
- Does: two writes on the PR in order: comment (verbatim `ready-to-merge-head: <prHead>`, `prHead` the full SHA of the green ci-state reading, "which the merge bot reads as the head the label was applied to") then `--add-label`. Preconditions in the text: green ci-state or the `check` job rule, deferrals filed, "exactly one release label", `dispositions-check.mjs … exiting 0`. No precondition that the label is absent or that another comment already exists.
- Scope today: per-object from `<pr>` (standalone: user-named; under the fleet: "a fresh small agent the controller dispatches", `:28`, whose brief is in the finisher slice)
- Feeds / Selected by: selected by the controller's finisher dispatch after the final verdict (`:24`); feeds the ready-to-merge Monitor (S7-5) → merge bot.
- Exists because: "the merge bot reads [the comment] as the head the label was applied to".
- Own-work limit: only labels/comments on this Instance's own PR; ownership unknown → stall; the label write should be conditional on the label's absence.
- Mark: PR; nearest mark today: comment `ready-to-merge-head: <prHead>` (names a head SHA, not an owner) + ready-to-merge label (state, not owner); tells Instances apart under one gh user: no; under different gh users: no.

### S7-17 Standalone label-map derivation creates labels in the tracker
- Where: `plugin/commands/review-and-fix.md:10` (`label-map.mjs ensure`, `label-map.mjs set --create`); implementation (other slice) `plugin/scripts/label-map.mjs:708` (`gh label create <string>`, "already exists" counts as existing `:644-646`, `:715`)
- Kind: instruction-write
- Does: standalone only; "Dispatched as a fix-applier, you never run `ensure` and never ask" (`review-and-fix.md:10`).
- Scope today: repo-wide (shared label list), no precondition beyond the maintainer's answer
- Feeds / Selected by: feeds the Label map every Label-role write above spells its labels from; selected by the maintainer's reply.
- Exists because: roles map to tracker strings; missing ones must exist.
- Own-work limit: none needed beyond idempotence (`already exists` accepted); shared config, not work.
- Mark: label; nearest mark today: none; tells Instances apart: not applicable (config).

---

## Checked, own-only or config
- `plugin/scripts/review-core.mjs:1153` — `gh repo view --json url -q .url` run from the PR's worktree: config (repository resolution).
- `plugin/scripts/review-core.mjs:1075` — `reclaim-scratch.mjs --pr ${pr} … --apply`: host-local scratch, no GitHub.
- `plugin/scripts/review-core.mjs:1082` — `git init … commit` in the snapshot copy: local throwaway repo, never pushed.
- `plugin/scripts/review-core.mjs:1206`, `:1217` — `derive-testcmd.sh … test|uncovered`: Recipe cache read, local.
- `plugin/scripts/ci-state.mjs:360-362` — `gh repo view --json nameWithOwner,url`: config (repository and host resolution).
- `plugin/skills/run-team/references/ci-watcher.md:20` — `gh api rate_limit --jq '.resources.core.remaining'`: config (rate limits, unmetered). The bucket is account-wide: two Instances on one gh user share it (`ci-watcher.md:199-202`).
- `plugin/skills/run-team/references/ci-watcher.md:55` — `gh api -i 'repos/{owner}/{repo}/actions/workflows?per_page=1'`: config (workflow list / rate-limit header probe).
- `plugin/scripts/ci-state.mjs:676`, `:693` — branch rules and classic protection of the base branch: config.
- `plugin/scripts/ci-state.mjs:459-461` workflow-file reads at the PR's head/base commits (`file(path: $dir)`, `:395-421`): config content (workflow files) read per PR; the per-PR part is S7-2.
- `plugin/scripts/dispositions-check.mjs:699`, `:931-937` — `git -C <repo> merge-base origin/main <head>` and `git diff`: local refs, `origin/main` content.
- `plugin/scripts/dispositions-check.mjs:863` — `readLabelMap({cwd: repo})`: Label map config.
- `plugin/scripts/dispositions-check.mjs:877` — ledger read via `ledger.mjs read`: host-local.
- `plugin/scripts/recipe-check.mjs:190-195`, `:200` — local `git rev-parse|write-tree|diff|ls-files` and `derive-testcmd.sh`: local, no remote.
- `plugin/scripts/recipe-prove.mjs:586-587`, `:597` — `git rev-parse origin/main^{commit}` and `git worktree add --detach <wt> <sha>`: local ref of `origin/main`, local throwaway worktree.
- `plugin/scripts/recipe-read.mjs:38`, `:57` — `derive-testcmd.sh . install|check|test --at origin/main`: Recipe cache, local.
- `plugin/scripts/derive-testcmd.sh:144-148` — `--at <rev>` reads a tree from a local ref (comment only; no remote command in the file).
- `plugin/agents/fleet-recipe-deriver.agent.md:27-29` — `git -C <repo> fetch origin` then `git show origin/main:<path>` / `git ls-tree -r --name-only origin/main`: config (fetch refreshes remote-tracking refs; no branch of other work is judged).
- `plugin/skills/run-team/briefs/recipe-deriver.md:7-9` — dispatch text only, no GitHub.
- `plugin/agents/fleet-fix-applier.agent.md:199` — `git fetch origin && git rev-list --merges --count "origin/<base>..HEAD"`: reads `origin/<base>` content for the member's own PR; own-only.
- `plugin/agents/fleet-fix-applier.agent.md:203` — mention of the merge bot's `gh pr update-branch --rebase` ("run-merge-bot.md step 1"): description, not an instruction to this member.
- `plugin/commands/review-and-fix.md:23`, `plugin/skills/run-team/briefs/fix-applier.md:141` — `git fetch origin && git rebase origin/main` in the member's own worktree: `origin/main` content, own-only.
- `plugin/skills/run-team/briefs/fix-applier.md:99` — "Read the failing job's log" (red-check kind): per-object read of the dispatched PR's own failing run; PR comes from the controller's dispatch (S7-8 Scope).
- `plugin/commands/review-and-fix.md:24` — standalone "watch the run until the diff-validating jobs are green (bind via `ci-state.mjs`)": per-PR from the user-named PR (S7-7), read-only.
- `plugin/commands/review-and-fix.md:42` and `plugin/skills/run-team/references/ci-and-staleness.md:31` — `gh run view <rid> --json jobs` at labelling time: per-run read keyed by the run id the member's own ci-state reading bound.
- `plugin/skills/run-team/references/reviewers.md:94-102` — `gh pr view <N> --json headRefName -q .headRefName`: per-object read of the dispatched PR's branch (feeds S7-8's `--branch`).
- `plugin/agents/fleet-review-runner.agent.md:44-49`, `plugin/skills/run-team/briefs/review-runner.md:10-17` — no `gh` of its own; runs `runReviewToFile` for the caller-supplied `pr` (S7-6).
- `plugin/scripts/review-eval.mjs` — local result-file writer and dispatch shim; GitHub work is review-core's (S7-6).
- `plugin/scripts/diff-stats.mjs:235` — see S7-6 (per-object from `--pr`, read-only).

## Files with no GitHub access
- `plugin/scripts/review-eval.mjs`
- `plugin/scripts/recipe-check.mjs`
- `plugin/scripts/recipe-prove.mjs`
- `plugin/scripts/recipe-read.mjs`
- `plugin/scripts/derive-testcmd.sh`
- `plugin/skills/run-team/briefs/recipe-deriver.md`
- `plugin/skills/run-team/briefs/review-runner.md`
- `plugin/agents/fleet-review-comments.agent.md`
- `plugin/agents/fleet-review-correctness.agent.md`
- `plugin/agents/fleet-review-silent-failure.agent.md`
- `plugin/agents/fleet-review-simplify.agent.md`
- `plugin/agents/fleet-review-snapshot.agent.md` (the `gh`/`ls-remote` commands it runs come from review-core.mjs's prompt, S7-6; the agent file has none)
- `plugin/agents/fleet-review-test-run.agent.md`
- `plugin/agents/fleet-review-tests.agent.md`
- `plugin/agents/fleet-review-types.agent.md`
- `plugin/agents/fleet-review-verifier.agent.md`
- `plugin/agents/fleet-review-runner.agent.md` (no `gh` instruction of its own; see Checked)
- `plugin/agents/fleet-recipe-deriver.agent.md` (only the `git fetch origin` config read in Checked)
