# S5a — the merge bot's Pass (snapshot origin/main 1a9692aa)

All `file:line` are in `origin/main` 1a9692aa, relative to the repo root. `cmd` = `plugin/commands/run-merge-bot.md`.

Headline facts, then entries.

- `run-merge-bot.md` has NO author-login, assignee, Instance or "mine" test anywhere (grep of `owned|author|gh api user|assignee` over cmd, merge-gate.mjs, delete-merged-branch.sh, drop-merged-label.sh, the agent file finds only prose: cmd:11 "the author's sign-off", cmd:28 "any other PR's author clears it"). The only thing that makes a PR the Pass's to merge is the `ready-to-merge` label on an open PR.
- No hold rule orders a labelled PR behind other open PRs. The opposite is written: cmd:24-30 "A labelled PR never waits on an open PR without it". Order reads only the labelled set. The one rule that reads *other* open PRs is the grace's "any PR open at all" exit read (S5a-4), and the post-merge branch-keep lookups (S5a-20).
- `gh pr merge <pr> --merge` carries no `--match-head-commit` (cmd:230; `grep -n "match-head-commit" cmd` finds nothing). The pin to the audited head is the merge gate's two reads (cmd:215), not an argument of the merge call.
- The Pass never pushes with git. Its rebase is `gh pr update-branch <pr> --rebase` (server-side, cmd:71, 78); the local fallback "pushes nothing" (cmd:132, 134, 157, 176). The only `git push` in the slice is the remote branch delete (S5a-21).

### S5a-1 Pass selection: "every open PR carrying ready-to-merge, lowest number first"
- Where: `plugin/commands/run-merge-bot.md:9` (the `/goal`), `:24`, `:67`, `:260`; dispatched-bot queue recorded by `plugin/scripts/ledger.mjs:2240` (another slice's script; cited, not entered)
- Kind: instruction-read
- Does: goal text `Merge all of this repo's open PRs in numeric order if labeled ready-to-merge`; "Lowest number first, among the PRs that carry the label"; "For each labeled PR, lowest first"; after each merge "re-evaluate the queue from scratch" (`:260`). The file gives NO command for this selection read — the model chooses it. The only `gh pr list` commands the file spells out are the grace poll (S5a-3, S5a-4) and the Monitor (S5a-5). A dispatched bot's recorded queue is `gh pr list --state open --label <ready> --limit 1000 --json number` (`ledger.mjs:2240`), read back in the file only on the Label-map-refusal path (`cmd:19`: `ledger.mjs read | jq -c '.queued["merge-bot-<n>"]'`) and by the settle check (`cmd:312`).
- Scope today: label-wide (repo-wide set of open PRs, filtered by label string from the Label map `cmd:15`)
- Feeds / Selected by: feeds every later entry of this Pass (S5a-6 … S5a-23) — each acts on a PR number taken from this set / selected by the `ready-to-merge` label alone (`cmd:11`; gate row `merge-gate.mjs:399`)
- Exists because: the Pass is the queue drain; "Only `ready-to-merge` PRs are in scope — it is the author's sign-off" (`cmd:11`). Order rule `cmd:24-30`: waiting on unlabelled PRs "would not avoid the conflict, only move it onto the labelled PR".
- Own-work limit: the selected set must be only PRs this Instance owns (its own PRs from its own branches); a labelled PR whose ownership is unknown must be skipped (stall), not merged. Today nothing intersects the label set with anything of this Instance's.
- Mark: PR; nearest mark today: `ready-to-merge` label (state, not owner); tells Instances apart under one gh user: no; under different gh users: no (label carries no login; `author.login` is available on the PR but is never read here)
- Notes: the label is added by a finisher or standalone `review-and-fix` (`cmd:36`); "Never add the label yourself" (`cmd:11`). Another Instance's labelled PR is indistinguishable from own in this selection. The dispatched bot's `queued=` record is host-local (`## Dispatched`, ledger) and is itself taken from the label-wide read at dispatch time; `settle --from-report` refuses a report that leaves a still-open, still-labelled PR from that queue without a verdict (`cmd:312`), i.e. the local record forces the bot to give another Instance's labelled PR a verdict (`refused` with a reason, at least).

### S5a-2 Agent prompt: drain the queue, re-evaluate after each merge, hold a 15-minute grace
- Where: `plugin/agents/fleet-merge-bot.agent.md:11-15`
- Kind: instruction-read
- Does: "run **one** pass — drain the queue, re-evaluating after each merge, hold a 15-minute grace for late labels, then report once and exit"; "The grace ends early … once no PR is open".
- Scope today: label-wide (it delegates to cmd and S5a-1/-3/-4)
- Feeds / Selected by: feeds S5a-3, S5a-4 and every per-PR write below / selected by the controller's dispatch "on the first `ready-to-merge` label" (`plugin/skills/run-team/SKILL.md:230`, outside this slice)
- Exists because: a bot dispatched on the first label would otherwise exit before a later label (cmd:299 "a label landing minutes after your last merge is the common case").
- Own-work limit: the drain and the grace may only cover this Instance's own labelled PRs; a late label on an unowned PR must fire nothing.
- Mark: PR; nearest mark today: `ready-to-merge` label; tells Instances apart under one gh user: no; different gh users: no
- Notes: `plugin/skills/run-team/briefs/merge-bot.md` (n, scratch, report path) holds no GitHub instruction; see the no-GitHub list.

### S5a-3 Grace poll: every 60s, labelled open PRs, "a number not in the seed re-runs selection"
- Where: `plugin/commands/run-merge-bot.md:301-302`
- Kind: instruction-read
- Does: `gh pr list --state open --label "<ready-to-merge string>" --limit 200 --json number`, every 60s for 15 minutes. "A number not in the seed → re-run selection from the top, drain what it makes actionable". A poll returning 200 names `poll-capped-at-200` in the report.
- Scope today: label-wide
- Feeds / Selected by: feeds S5a-1 re-selection → S5a-6…23 on any newly seen number / selected by the label string
- Exists because: late labels (`cmd:299`).
- Own-work limit: the poll's set must be limited to PRs this Instance owns; a number another Instance labels must not enter the seed or trigger a drain.
- Mark: PR; nearest mark: `ready-to-merge` label; one gh user: no; different users: no
- Notes: the seed is local to the bot's session.

### S5a-4 Grace exit read: "is ANY PR open at all"
- Where: `plugin/commands/run-merge-bot.md:303`
- Kind: read-inform
- Does: `gh pr list --state open --limit 1 --json number` at grace start and on every 60s poll; "An empty list (no PR open at all, any author, labelled or not) ends the grace: report and exit now."
- Scope today: repo-wide ("any author, labelled or not")
- Feeds / Selected by: feeds nothing but the Pass's own exit timing (report and exit); no write / selected by nothing (no filter)
- Exists because: stop the 15-minute wait when the repo has no PR left.
- Own-work limit: only this Instance's own open PRs may extend or end the grace; as written, another Instance's (or a human's) open PR keeps the grace running for its full 15 minutes, and an empty repo ends it early. Stall-safe direction (a foreign PR only lengthens the wait).
- Mark: PR; nearest mark today: none (not even the label); one gh user: no; different gh users: no
- Notes: result decides exit only; it informs nothing shown or counted elsewhere.

### S5a-5 Top-level Monitor: persistent label watcher
- Where: `plugin/commands/run-merge-bot.md:324-370` (script lines `:327-359`, poll at `:329`, seed `:340`)
- Kind: instruction-read
- Does: `gh pr list --state open --label "$label" --limit "$cap" --json number --jq '.[].number'` every 60s (`sleep 60`, `:348`), cap 200; prints `ready-to-merge label added: PR #$n` for numbers not in `seen`; "On an event, do not merge that PR on sight — re-run selection from the top" (`:370`). Only for the top-level invocation; skipped when a controller dispatched the bot (`:318`).
- Scope today: label-wide
- Feeds / Selected by: feeds S5a-1 re-selection / selected by label string
- Exists because: "The pass ends, the queue does not" (`:324`).
- Own-work limit: same as S5a-3 — events only for this Instance's own PRs.
- Mark: PR; nearest mark: `ready-to-merge` label; one gh user: no; different gh users: no
- Notes: it counts and prints others' work too (DEGRADED/RECOVERED lines at `:333`, `:336` report the labelled-list size), so it is also a read-inform of the label-wide count.

### S5a-6 Conflict-hold check: ledger row read before step 1
- Where: `plugin/commands/run-merge-bot.md:69`
- Kind: instruction-read
- Does: "check the ledger for an unresolved conflict hold on this PR. Read the ticket row that names it … (`ledger.mjs read`)"; a `conflict-hold:#<pr>` token with no `fix-pr-<n>` settled after it → "Skip it … Report `conflict-held-#<pr>`". Host-local read that gates the rebase write (S5a-10) and the fallback.
- Scope today: per-object from S5a-1's PR number (looked up in the host-local ledger, never on GitHub)
- Feeds / Selected by: gates S5a-10, S5a-12, S5a-13 / selected by the PR number from S5a-1
- Exists because: "a fix-applier already owns this PR's conflict" (`:69`) — so the bot does not rebase under it.
- Own-work limit: the ledger is invisible to other Instances (host-local), so this gate cannot see a fix-applier another Instance dispatched on the same PR; the write path it gates (S5a-10) must be limited to PRs this Instance owns, and must stall when ownership is unknown.
- Mark: ledger (not on GitHub); nearest mark today: ledger `conflict-hold:#<pr>` token; one gh user: no (invisible to other Instances); different gh users: no
- Notes: the row is "the row whose first `PR#` mention is `PR#<pr>`, or the row keyed `#<pr>`" (`:178`).

### S5a-7 Recorded labelled head: newest `ready-to-merge-head:` comment, by anyone
- Where: `plugin/commands/run-merge-bot.md:36-42` (command at `:39-41`)
- Kind: instruction-read
- Does: `gh pr view <pr> --json comments -q '[.comments[] | {createdAt, sha: (.body | capture("\\Aready-to-merge-head: (?<sha>[0-9a-f]{40})\\s*\\z").sha)}] | sort_by(.createdAt) | last | .sha // ""'` — newest comment whose whole body is that line, any commenter.
- Scope today: per-object from S5a-1's PR number
- Feeds / Selected by: feeds the head-moved gate (`:46-48`) and `--pre` for S5a-17 / selected by S5a-1's PR
- Exists because: "A GitHub label does not follow the branch" (`:34`); the label binds to the audited tree.
- Own-work limit: the recorded head is trusted only if posted by the Instance that audited it (the finisher of this Instance); a comment from another Instance (same gh user too) cannot be told apart.
- Mark: comment; nearest mark today: comment body `ready-to-merge-head: <sha>` (names a head, no run/member/Instance); one gh user: no; different gh users: no (the query filters on neither `author.login` nor anything else — `:63` "nor who posted the record")
- Notes: the comment is written by a finisher/standalone `review-and-fix` "immediately before the label" (`:36`).

### S5a-8 Timeline fallback read when no head record exists
- Where: `plugin/commands/run-merge-bot.md:50-59` (command `:53-56`)
- Kind: instruction-read
- Does: `gh api "repos/{owner}/{repo}/issues/<pr>/timeline?per_page=100" --paginate -q '.[] | select((.event == "labeled" and .label.name == env.label) or .event == "committed" or .event == "head_ref_force_pushed") | .event + " " + (.sha // .label.name // "")'`
- Scope today: per-object from S5a-1's PR number
- Feeds / Selected by: refuses the PR `head-moved-after-label-#<pr>` if a `committed`/`head_ref_force_pushed` follows the last `labeled` line / selected by S5a-1's PR
- Exists because: "a hand-added label, or one applied before its labeller recorded a head".
- Own-work limit: as S5a-7; the timeline shows every actor's events and cannot say whose.
- Mark: PR timeline; nearest mark today: none (events carry actor, never read); one gh user: no; different gh users: no
- Notes: "once you have rebased this read can no longer tell your commits from someone else's" (`:50`).

### S5a-9 Pre-rebase reads of the PR's head branch
- Where: `plugin/commands/run-merge-bot.md:74-77` (fire block)
- Kind: instruction-read
- Does: `branch=$(gh pr view <pr> --json headRefName -q .headRefName)`; `pre=$(git ls-remote origin "$ref" | cut -f1)` with `ref="refs/heads/$branch"`; `[ -n "$pre" ] || { echo "no such remote ref: $ref"; exit 2; }`. Also `gh pr view <pr> --json headRefOid -q .headRefOid` at `:61` and `:145`.
- Scope today: per-object from S5a-1's PR number (its head branch name)
- Feeds / Selected by: feeds S5a-10 (`pre` is the unrecoverable pre-rebase head, `:109`) and `--pre` of S5a-17 / selected by S5a-1's PR
- Exists because: "`pre` is the one reading nothing after the rebase can reconstruct".
- Own-work limit: only for a branch of a PR this Instance created; a head branch whose creator is unknown must stall.
- Mark: branch; nearest mark today: head branch name (`implementer/<N>-impl-<N>[-x]` per `plugin/scripts/claim-ticket.sh:9-10`; no Instance part); one gh user: no; different gh users: no
- Notes: a fork PR's branch is "not on `origin` at all" (`:148`) and reads empty.

### S5a-10 Server-side rebase of the PR head (the Pass's only head-moving write)
- Where: `plugin/commands/run-merge-bot.md:71`, `:78` (`out=$(gh pr update-branch <pr> --rebase 2>&1); rc=$?`)
- Kind: instruction-write
- Does: "If the PR is behind `origin/main`, update it server-side first: `gh pr update-branch <pr> --rebase`. That's an API call, not a push". GitHub rewrites the PR head branch to a new commit (orphaning the old head, `:128`). No head pin is passed in the command as written. Fire "once; only the poll is ever re-issued" (`:109`).
- Scope today: per-object from S5a-1's PR number; no precondition on the PR's head at the moment of the call (the `pre` read at `:76` is not passed to the call)
- Feeds / Selected by: moves the head every later gate pins (S5a-17 `--pre/--post`); can orphan a push another actor lands at the same moment / selected by S5a-1 (label-wide), gated only by S5a-6 (host-local ledger) and the head-moved gate (S5a-7/8)
- Exists because: "you are the only place currency is proven, so never merge on a green from before your rebase" (`:199`); it also avoids "the force-push classifier denial" of the old `git push --force-with-lease` (`:71`).
- Own-work limit: only targets this Instance's own PR head branch. If ownership of the head is unknown, stall — do not rebase. Note the rebase rewrites a branch other Instances' members could be pushing to (an implementer or fix-applier) — it must not run while any other Instance may push.
- Mark: branch; nearest mark today: head branch name (no Instance part); one gh user: no; different gh users: no (`author.login` differs only across users and is not read here)
- Notes: "Two, and only two, reasons this can't be used: a real conflict, or `allow_update_branch` off" (`:136`). Messages in the command prompt rank the old `git push --force-with-lease` (`:71`) as removed, so no force-push by git remains here.

### S5a-11 Post-rebase poll of the branch ref and the PR object
- Where: `plugin/commands/run-merge-bot.md:85-106` (`post=$(git ls-remote origin "$ref" | cut -f1)` at `:91`; `pr_head=$(gh pr view <pr> --json headRefOid -q .headRefOid)` at `:96`, `:101`)
- Kind: instruction-read
- Does: up to 60 × 5s loops (two caps, one `eval` cell with `timeout` ≥ 900s, `:111`) re-reading the branch ref and the PR object's head until each moves off `pre`.
- Scope today: per-object from S5a-1's PR number
- Feeds / Selected by: decides landed / fallback / desync (`:115-126`) / selected by S5a-9's `branch` and `pre`
- Exists because: the PR object lags the ref (measured 84 s–2 min, `:122`).
- Own-work limit: only for this Instance's own PR branch; a head that moves because another Instance pushed is indistinguishable from the rebase landing.
- Mark: branch; nearest mark: head branch name; one gh user: no; different gh users: no
- Notes: a third SHA that appears "is a push that landed while you waited on CI" (`:219`) — the gate treats any foreign push as `head-moved-after-label`, not as another Instance.

### S5a-12 Local fallback verification: worktree lookup, fetch, cherry, body and closing refs
- Where: `plugin/commands/run-merge-bot.md:132` (`git cherry origin/<branch> HEAD`), `:138` (`git worktree list`), `:143-152` (`git -C <worktree> rev-parse HEAD`, `git ls-remote origin refs/heads/<branch>`, `gh pr view <pr> --json headRefOid -q .headRefOid`, `git fetch origin`), `:187` (`gh pr view <pr> --json body -q .body`, `gh pr view <pr> --json number,url,closingIssuesReferences`, then `main-gain.mjs --head … --body-file … --closing-refs …`)
- Kind: instruction-read
- Does: when the server-side rebase is unavailable, rebases a local worktree "for verification only — this rebase never needs to reach the remote" (`:138`); the worktree must equal the remote branch ref (`ls-remote`, not `rev-parse origin/<branch>`); "worktree ahead → STOP `worktree-diverged-#<pr>`" (`:157`). Nothing here pushes (`:132`, `:134`, `:176`).
- Scope today: per-object from S5a-1's PR number (its head branch and worktree under this checkout)
- Feeds / Selected by: feeds `rebase-fallback-#<pr>` hand-back and S5a-13 / selected by S5a-1's PR; the worktree is "the branch usually lives in a worktree (`git worktree list`)" of this checkout (host-local)
- Exists because: a verified-then-merged tree must be the remote head, not an unreviewed local commit (`:140`).
- Own-work limit: the worktree belongs to this Instance's own claim; a PR whose branch has no worktree in this clone (another Instance's) is "no worktree at all" (`:158`) and the text then rebases "from the remote head" — it must instead stall.
- Mark: branch; nearest mark today: head branch name; one gh user: no; different gh users: no
- Notes: "Worktree behind, or no worktree at all → not a divergence" (`:158`): lack of a local worktree is treated as fine, so a PR from another Instance proceeds. Fork PR: empty ref read → `blocked` (`:148`).

### S5a-13 Conflict-hold recording on the ledger (host-local write that makes the tick dispatch a fix-applier)
- Where: `plugin/commands/run-merge-bot.md:178-185` (commands `:181-182`: `~/.fleet/bin/fleet-run ledger.mjs read`, `ledger.mjs row <key> "<text> · conflict-hold:#<pr> (conflict: <path1>, <path2>)"`)
- Kind: instruction-write
- Does: when the fallback's local rebase stopped on conflicting paths, appends the token `conflict-hold:#<pr> (conflict: …)` to "the ticket row that names the PR". "From then on the tick prints `DISPATCH fix-pr PR#<pr>` for it" (`:185`), and a fix-applier then pushes to the PR head.
- Scope today: per-object from S5a-1's PR number (host-local ledger row)
- Feeds / Selected by: feeds the controller tick's `DISPATCH fix-pr PR#<pr>` (and, via that, a fix-applier's push to the PR branch) / selected by S5a-1's PR; read-fresh guard `:178` "unless it already carries one unresolved"
- Exists because: "your report is gone when you exit, and nothing else durable says the PR is stuck: the controller records a hold off the tick's `CONFLICT` line only for a PR no live merge bot owns" (`:178`).
- Own-work limit: a hold may only be recorded for a PR this Instance's ledger already tracks as its own; for a PR it does not own, record nothing and stall (report only). The ledger write gates a GitHub write (the fix-applier's push), so it belongs in this inventory.
- Mark: ledger (not on GitHub); nearest mark today: ledger row token `conflict-hold:#<pr>`; one gh user: no (invisible to other Instances); different gh users: no
- Notes: the tick refuses "a hold naming another PR" (`:185`). Row text `· conflict-hold:#<pr> (conflict: path1, path2)` is the only fleet marker in this write.

### S5a-14 Plain `git fetch origin` before every gate run and in the fallback
- Where: `plugin/commands/run-merge-bot.md:48` ("after a plain `git fetch origin`"), `:152`, `:160-172`, `:212`
- Kind: instruction-read
- Does: "Run a plain `git fetch origin` in the main checkout before every gate run — never `git fetch origin <src>:<dst>`" (`:212`); `fetch.prune=true` in effect, so it also prunes local `refs/remotes/origin/*` of branches other Instances deleted (`:160-172`).
- Scope today: repo-wide (every branch and tag of `origin`)
- Feeds / Selected by: feeds the gate's `main-gain.mjs` and rebase-carry reads of `origin/main` and head objects (`merge-gate.mjs:198`, `:232`; `main-gain.mjs:19` "the caller fetches first") / selected by nothing (whole remote)
- Exists because: "an unfetched head is `main-gain-unanswerable`, an unheld labelled or carried head is no carry, and a stale `origin/main` is a check against the wrong `main`" (`:212`).
- Own-work limit: the fetch writes only local state; the reads after it must be limited to `origin/main` content and this Instance's own PR head objects. Judged for scope: `origin/main` only is config; nothing in this slice reads other `origin/*` branches.
- Mark: none needed for the fetch; the head objects read are PR heads from S5a-1
- Notes: the same plain fetch (`git fetch --quiet origin`) is run by `plugin/scripts/prove-merge.sh:107-110` (listed in Checked).

### S5a-15 Release label add on a labelled PR (instruction, no command given)
- Where: `plugin/commands/run-merge-bot.md:189` ("A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching"), `:201` ("You fix only the mechanical failures you caused: conflict resolution and the release label")
- Kind: instruction-write
- Does: tells the bot to add `patch`, `minor` or `major` to the PR when its CI fails `validate-release-label`. The file prints no command; the shape is [INFERENCE] `gh pr edit <pr> --add-label <patch|minor|major>`.
- Scope today: per-object from S5a-1's PR number; no precondition (no read of the label set is required before the add)
- Feeds / Selected by: feeds the next gate run (`ci:` row, `merge-gate.mjs:409`) / selected by S5a-1's PR; which of the three is left to the bot ("the one matching")
- Exists because: `release-label.yml` "exits 1 when the count of those three is zero" (`:189`).
- Own-work limit: only on this Instance's own PR; for a PR of unknown ownership report `ci:…` and stall. The finisher gate counts these three labels "before it labels" (`plugin/scripts/release-labels.mjs:3-5`), so the bot's add races a finisher's.
- Mark: PR; nearest mark today: `patch`/`minor`/`major` labels (state, not owner); one gh user: no; different gh users: no
- Notes: `plugin/scripts/release-labels.mjs` itself holds only constants (see no-GitHub list).

### S5a-16 CI wait: `gh run view <run-id>` poll
- Where: `plugin/commands/run-merge-bot.md:191-195`
- Kind: instruction-read
- Does: `gh run view <run-id> --json status,conclusion` via `subprocess.run` until `status` is `completed`, bounded 20 minutes per PR (`:189`). `<run-id>` is the gate's `ci.runId` (`:191`).
- Scope today: per-object from the gate's `ci.runId` (`ci-state.mjs`, another slice; invoked at `plugin/scripts/merge-gate.mjs:367` with `--pr <n>`)
- Feeds / Selected by: feeds the second gate run / selected by the run `ci-state.mjs` binds to the PR head
- Exists because: "you are turn-based and cannot 'keep an eye on' a run" (`:191`).
- Own-work limit: only runs bound to this Instance's own PR head.
- Mark: PR head SHA; nearest mark today: run `headSha`; one gh user: no; different gh users: no
- Notes: no `gh run rerun|cancel` anywhere in this file.

### S5a-17 Merge gate: `gh pr view` of the queue's PR; the only ownership-shaped test is label presence
- Where: `plugin/scripts/merge-gate.mjs:275` (`gh pr view <pr> --json labels,reviewDecision,headRefOid,body,url,closingIssuesReferences`), `:399` (`label-pulled` if no label equals `ready`), `:400`, `:401`, `:367` (`ci-state.mjs --pr <n> --declare-no-ci`), `:150` (`ready = readLabelMap()["ready-to-merge"]`); invoked by `plugin/commands/run-merge-bot.md:205-215`
- Kind: read-select
- Does: for the PR number the bot hands it, reads labels, review decision, head, body, URL, closing references; blocks on `label-pulled`, `changes-requested`, `head-moved-after-label` (head ∉ {pre, post} and no proven rebase-carry), then `main-gain-removed`, `ci:`, `behind:` (`:399-418`). "Never merges, labels, rebases or waits" (`:14-16`). Run twice, "merge only on that second exit 0" (`cmd:215`).
- Scope today: per-object from S5a-1's PR number
- Feeds / Selected by: feeds S5a-18 (the merge) and, via `--out` `<scratch>/pr<N>/merge-bot-<n>/ci.json` (`cmd:210`), the controller's parking of a `main-gain-removed` refusal at `head` + `bodyDigest` (`merge-gate.mjs:28-31`) / selected by S5a-1
- Exists because: the label "does not expire when that tree does" (`cmd:34`); the gate is "the last gate".
- Own-work limit: add a precondition "PR is this Instance's own" before a mergeable verdict; unknown → stall (exit 2-class `unknown`, never 0).
- Mark: PR; nearest mark today: `ready-to-merge` label presence + head SHA pin (`pre`/`post`) + `reviewDecision`; none names an owner; one gh user: no; different gh users: no
- Notes: `mainGain.hits` etc. read `origin/main` and PR head objects locally (`main-gain.mjs` makes no gh call; see no-GitHub list). `reviewDecision === "CHANGES_REQUESTED"` is any reviewer's.

### S5a-18 `gh pr merge <pr> --merge` on the queue's PR, no head pin
- Where: `plugin/commands/run-merge-bot.md:230` (and the pin point `:215`)
- Kind: instruction-write
- Does: `gh pr merge <pr> --merge` (no-ff). "It can exit silently — confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit`". "Never `--delete-branch` on this call." `--match-head-commit` appears nowhere in the file or in `merge-gate.mjs`; the only head guard is the second gate run "immediately before `gh pr merge`" (`:215`), a separate call with a time window before the merge.
- Scope today: per-object from S5a-1's PR number; no precondition on the head at the instant of the merge (the merge takes whatever head the PR has)
- Feeds / Selected by: feeds S5a-20, S5a-21, S5a-23 (all take the PR number just merged) and `prove-merge.sh` (Checked) / selected by S5a-1's label-wide queue, gated by S5a-17's exit 0
- Exists because: the merge is the Pass's purpose.
- Own-work limit: only merges a PR this Instance owns, at the head it audited; ownership unknown → stall (not merge).
- Mark: PR; nearest mark today: `ready-to-merge` label + head SHA pin (gate only); one gh user: no; different gh users: no
- Notes: `--merge` is "load-bearing, not stylistic" (`:232`: `prove-merge.sh` needs a two-parent commit). A merge commit subject is GitHub's `Merge pull request #<n> from <owner>/<branch>`, which `main-gain.mjs:163` (`MERGE_SUBJECT`) reads to name the landing source — a marker the plugin reads off `main`, never writes itself.

### S5a-19 Controller remedy for a desynced PR: close and reopen
- Where: `plugin/commands/run-merge-bot.md:126-128`
- Kind: instruction-write
- Does: "The controller's remedy is close-and-reopen … before closing anything, run `git merge-base --is-ancestor <pr_head> origin/<branch>`. Non-ancestor → do not close". The bot does not run it ("Report it and stop"); the controller does.
- Scope today: per-object from S5a-1's PR number
- Feeds / Selected by: feeds nothing in the Pass / selected by the bot's desync report (S5a-11)
- Exists because: a PR object that stays on the pre-rebase head blocks the gate (`:126`); "a one-way door" past an orphaning rebase (`:128`).
- Own-work limit: only for a PR this Instance owns; a close on another Instance's PR kills its review thread and labels (`:128`).
- Mark: PR; nearest mark today: none; one gh user: no; different gh users: no
- Notes: `gh pr close`/`reopen` are not spelled in the file; the shape is [INFERENCE].

### S5a-20 Branch-keep lookups: every open PR headed or based on the merged PR's branch
- Where: `plugin/scripts/delete-merged-branch.sh:238-248` (`gh pr list --head "$branch" --state open --limit 1000 --json number,isCrossRepository --jq '.[] | select(.isCrossRepository | not) | .number'` at `:239`; `gh pr list --base "$branch" --state open --limit 1000 --json number --jq '.[].number'` at `:245`), `:259-262` (exit 3, `sed 's/^/branch-kept-#/'`); also `:116-118` (`gh pr view "$pr" --json state,isCrossRepository,headRefName,headRefOid,baseRefName`) and `:213-214`, `:203` (`git ls-remote --heads origin refs/heads/$branch`)
- Kind: read-select
- Does: after the MERGED gate, reads which open PRs (any author) use the merged branch as head or base; keeps the branch (exit 3, one `branch-kept-#<n>` per such PR) when any does. The `--head` lookup excludes cross-repository PRs.
- Scope today: repo-wide by branch name (`--head`, `--base` of a branch name, not by an identifier this Instance recorded)
- Feeds / Selected by: feeds S5a-21 (delete or keep) and the report tokens `branch-kept-#<n>` naming OTHER PRs (`cmd:254`) / selected by S5a-18's merged PR (head branch from `:116`)
- Exists because: "deleting a branch closes every open PR headed by it, and may close rather than retarget every open PR based on it" (`:32-36`).
- Own-work limit: lookups may only name PRs this Instance owns; a PR of another Instance keeping the branch must still protect it (stall = keep), but must not be reported as this Pass's work.
- Mark: PR; nearest mark today: head branch name / base branch name; one gh user: no; different gh users: no
- Notes: invoked by `cmd:248-252` as `~/.fleet/bin/fleet-run delete-merged-branch.sh <pr>` ("this bot owns that step, and no repo setting does it for you"); the label half runs from this script first (`:138-141`, S5a-22/23).

### S5a-21 Delete the merged PR's remote head branch (leased)
- Where: `plugin/scripts/delete-merged-branch.sh:264-266` (`git push --force-with-lease="refs/heads/$branch:$oid" origin --delete "refs/heads/$branch"`), read-back `:268-269` (`git ls-remote --heads origin refs/heads/$branch`); instruction `plugin/commands/run-merge-bot.md:248-252`, `:254`, `:258`
- Kind: write
- Does: after the merge is confirmed and no open PR keeps it (S5a-20), deletes `refs/heads/<branch>` on `origin` (REMOTE ONLY: "This script runs no local branch or worktree command at all", `:14`). Lease is the PR's merged `headRefOid` (`:117`), "so a push that landed on the branch after the merge makes the delete refuse" (`:22-23`). Skipped for a cross-repository PR (`:188-190`); refuses when the head is the base branch (`:179`).
- Scope today: per-object from S5a-18's merged PR number (its `headRefName`)
- Feeds / Selected by: makes the branch `[gone]` so `reap.sh` reaps its local branch and worktree (`cmd:248`, `:258`) / selected by the head branch `gh pr view` printed for the merged PR (`:116-118`)
- Exists because: "Without it a merged branch is never `[gone]`, so `reap.sh` never reaps it or its worktree" (`cmd:248`).
- Own-work limit: only deletes the head branch of a PR this Instance merged and owns. Deleting another Instance's branch strands that Instance's worktree and its `reap.sh` (its local branch goes `[gone]` under it). The lease is to the merged head only — it does not know whose branch it is.
- Mark: branch; nearest mark today: head branch name (no Instance part); one gh user: no; different gh users: no
- Notes: exit 0 `deleted` / `alreadyGone` / `skipped cross-repository`; 1 still on origin; 2 unknown; 3 kept; 4 label half failed (`:57-76`). Local state it reads: `net.sh`, `json.sh` libs.

### S5a-22 Issues-this-PR-closes read: closing references plus a commit-message scan
- Where: `plugin/scripts/drop-merged-label.sh:49-53` (`gh pr view "$pr" --json state --jq .state`), `:70-73` (`gh pr view "$pr" --json closingIssuesReferences,url --jq "$own_closes"`), `:80-83` (`gh pr view "$pr" --json commits --jq '[.commits[] | (.messageHeadline // "") + "\n" + (.messageBody // "")] | join("\n")'`), `:93` (`grep -Eio '(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*#[0-9]+'`), `:121` (union), `:151-152` (`gh issue view "$n" --json labels --jq '.labels[].name'`); called from `plugin/scripts/delete-merged-branch.sh:138-141` as `sh "$label_script" "$pr" --apply`
- Kind: read-select
- Does: selects the issue numbers from the merged PR's closing references (own repo only, `:55-69`) UNION every `close/fix/resolve #N` found in every commit's headline+body on the PR; then reads each such issue's labels.
- Scope today: per-object from S5a-18's merged PR number, but the issue set is chosen by text in commit messages and the PR body ("A commit-message-only reference" counts, `:15-20`)
- Feeds / Selected by: feeds S5a-23's `gh issue edit --remove-label` / selected by S5a-18's PR; text from every commit on the branch (including commits another actor pushed)
- Exists because: "the merge is the only point where the ticket number and the fact of completion are known together" (`cmd:248`; script `:8-10`); GitHub's real closer "honors" commit-message keywords (`:16-18`).
- Own-work limit: the issue set must be limited to the ticket this Instance claimed for this PR; an issue named in a commit message but claimed by another Instance must not be touched.
- Mark: issue; nearest mark today: closing reference (PR → issue); one gh user: no; different gh users: no
- Notes: the script is "dry-run by default; --apply mutates" (`:27`); delete-merged-branch always passes `--apply`. The reference in a foreign repo is dropped (`:22-25`).

### S5a-23 Drop `in-progress` from the issues the merged PR closes (no ownership precondition)
- Where: `plugin/scripts/drop-merged-label.sh:191-192` (`gh issue edit "$n" --remove-label "$in_progress"`), `:145` (`node label-map.mjs show in-progress`), `:168` (`grep -qxF -- "$in_progress"`); via `plugin/scripts/delete-merged-branch.sh:140`; instruction `plugin/commands/run-merge-bot.md:248`, `:256`
- Kind: write
- Does: for each issue in S5a-22's set whose labels include the `in-progress` Label map string (read at `:152`, `:168`), removes it. An issue without the label is left ("already clear", `:180`).
- Scope today: per-object from S5a-22's issue numbers; precondition = the label is present and the PR is `MERGED` (`:53`); no check that THIS Instance holds the claim (the label carries no claimant)
- Feeds / Selected by: feeds nothing on GitHub; reported as `label-drop-failed-#<issue>` / `label-read-failed-#<pr>` (`cmd:256`) / selected by S5a-22
- Exists because: "a merged ticket that keeps the label is invisible the moment it is reopened" (`cmd:256`; script `:28-30`); "nothing else clears it" (`cmd:248`).
- Own-work limit: only drops the label from a ticket this Instance claimed and whose PR it merged. Another Instance that claimed the same ticket (or reclaimed it after this PR's ticket reopened) loses its claim label; with ownership unknown → stall (leave the label).
- Mark: issue; nearest mark today: `in-progress` label (says nothing about by whom); closing reference ties PR to ticket, not to an owner; one gh user: no; different gh users: no
- Notes: Label map read via `label-map.mjs show in-progress`; no assignee is ever read or written in this slice.

## Markers seen in this slice
- Comment body `ready-to-merge-head: <sha>` (40 hex, whole body) — read at `cmd:36-42`; posted by a finisher / standalone `review-and-fix`, not by this slice.
- PR-body line `main-gain-removal: <path> <key> - <why>` — read by the gate through `main-gain.mjs` (`cmd:11`, `merge-gate.mjs:322` `--body-file -`), not written here.
- Merge-commit subject `Merge pull request #<n> from …` — read by `main-gain.mjs:163`.
- Ledger row token `· conflict-hold:#<pr> (conflict: <path1>, <path2>)` (`cmd:182`) — host-local.
- Ledger `## Dispatched` `queued=<pr>,<pr>…` and `## Ruled` line `merge-bot-<n> refused #<pr>: <reason>` (`cmd:312`) — host-local; "moves no label and holds nothing".
- Merge-bot report file `<scratch>/reports/merge-bot-<n>.json` (`agent:20-25`) — host-local.
- Nothing the Pass writes to GitHub (comment, body, title, trailer) names a run, member or Instance. It writes no PR/issue comments and no labels itself except S5a-15 and S5a-23.

## Checked, own-only or config
- `plugin/commands/run-merge-bot.md:15` — `~/.fleet/bin/fleet-run label-map.mjs show ready-to-merge`: reads the Label map (config).
- `plugin/commands/run-merge-bot.md:19` — `ledger.mjs read | jq '.queued["merge-bot-<n>"]'`: host-local ledger read, no GitHub; the recorded queue is S5a-1's.
- `plugin/commands/run-merge-bot.md:128` — `git merge-base --is-ancestor <pr_head> origin/<branch>`: local object read of the PR in hand.
- `plugin/commands/run-merge-bot.md:230` (confirm read) — `gh pr view <pr> --json state,mergedAt,mergeCommit`: per-object read of the PR this bot just merged.
- `plugin/commands/run-merge-bot.md:237` — `prove-merge.sh <pre> <post> <merge>` call: per-object, args are heads of the PR just merged.
- `plugin/commands/run-merge-bot.md:280` — `no-undo-audit.sh <worktree> <branch>`: local worktree audit (no network), branch passed by the caller.
- `plugin/commands/run-merge-bot.md:312`, `plugin/agents/fleet-merge-bot.agent.md:20-25` — report file and `report-schema.mjs validate`: host-local state, no GitHub.
- `plugin/agents/fleet-merge-bot.agent.md:39` — `prs=$(gh pr list …)`: an illustrative snippet in a shell-trap table, not an instruction to run it.
- `plugin/scripts/merge-gate.mjs:150` — `readLabelMap()["ready-to-merge"]`: Label map (config).
- `plugin/scripts/merge-gate.mjs:257-269` — `git rev-parse --git-common-dir` + `instruments.sh --repo <main checkout>`: local instrument digest (config).
- `plugin/scripts/merge-gate.mjs:196-236` — `cat-file`, `merge-base --all origin/main`, `diff-tree`, `merge-tree --write-tree` rebase-carry proof: local git objects, `origin/main` content only (config), no network.
- `plugin/scripts/merge-gate.mjs:308-343` — runs `main-gain.mjs` in the main checkout with the body on stdin: local git, no GitHub.
- `plugin/scripts/prove-merge.sh:107-110` — `net_git "" "$fetch_budget" fetch --quiet origin`: plain fetch; the proof reads `$base` (default `origin/main`, `:105`) and the merge commit only, so it judges `origin/main` content (config), not other branches.
- `plugin/scripts/prove-merge.sh:94-99` — `git merge-base --is-ancestor`: local.
- `plugin/scripts/verify-sha.sh:54-57` — `git fetch --quiet origin <branch>`, `:73`, `:89`: fetch of one named branch and a reachability check; `<branch>` and `<sha>` are argv from callers outside this slice (`plugin/scripts/ledger.mjs:2040`, `:2068` `verifyShaOf`; `fleet-event.mjs`, `member-outcomes.mjs:327`), the member-reported branch of its own claim; never called from this slice's files.
- `plugin/scripts/drop-merged-label.sh:145` — `label-map.mjs show in-progress`: Label map (config).
- `plugin/scripts/delete-merged-branch.sh:196` — `net_budget 30 …`: timeout config.
- `plugin/scripts/release-labels.mjs:13` — `LABEL_LIST_ARGS = ["label", "list", "--json", "name", "--limit", "1000"]`: a constant naming a repository label-list read (config); called by `finisher-label.mjs:206` and `ledger.mjs:2132`, not by this file.

## Files with no GitHub access
- `plugin/skills/run-team/briefs/merge-bot.md` (names `n`, `scratch`, report path; no `gh` or git instruction)
- `plugin/skills/run-team/references/merge-bot.md` (ten-line prose; no instruction)
- `plugin/scripts/main-gain.mjs` (local `git` reads of `origin/main` and head objects only; `:15` "a pure function, so no `gh` call here"; `:19` "It never fetches, writes or changes refs")
- `plugin/scripts/no-undo-audit.sh` (local worktree and `refs/remotes/origin/*` reads only; no `gh`, `ls-remote`, `fetch` or `push` call — the only matches are comments and a die message at `:582`)
- `plugin/scripts/release-labels.mjs` (constants and pure functions; no call)
