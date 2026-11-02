# S3 — the tick and the controller's skill (inventory of paths that reach GitHub work beyond the Instance's own)

Snapshot: `origin/main` 1a9692aa. All `file:line` are repo-root-relative. Files read in full: `plugin/scripts/fleet-tick.mjs`, `staleness.mjs`, `dispatch-prompt.mjs` (gh/git call sites), `plugin/skills/run-team/SKILL.md`, and the five references. Where an entry's downstream script belongs to another slice I name it and say so; I read only enough of it to cite the trigger (marked "read from …").

Line-number drift vs the starting points: `reviewDue` is `fleet-tick.mjs:1194-1197` (not ~1203); the In-flight PR term is `:1092-1093`, `:1151`; `unclaimed()` is `:1273-1278`.

---

## A. `plugin/scripts/fleet-tick.mjs`

### S3-1 The open-PR list: every open PR in the repository, any author, any label
- Where: `plugin/scripts/fleet-tick.mjs:1713-1756` (`openPrs`), `:1716-1717`, `:1579` (PR_LIMIT), `:1739-1747`, called at `:2298`
- Kind: read-select
- Does: `gh pr list --state open --limit 200 --json number,labels,closingIssuesReferences,headRefOid,mergeable,body,url,author,isDraft` — no `--author`, `--label`, `--head` or `--search`; errors out at exactly 200 rows (`:1745-1747`)
- Scope today: repo-wide
- Feeds / Selected by: feeds every PR-keyed count in `deriveRun` (`:1007-1261`): the In-flight PR term (S3-3), `reviewDue` (S3-4), `fixDue`/conflicts (S3-5, S3-6), the merge queue (S3-7), `unlabelled` (S3-8), the `open` set that lifts `behind-pr:#M` Exclusions (`:1014`, `:986-987`), `main()`'s `over` test (`:2422`). / Selected by: nothing — a repository-wide query run every tick.
- Exists because: "a failed read is not an empty queue" (`:1719`); "a backlog that silently drops PRs is not a reconcile" (`:1746`); the header lists it as "The open PRs, by label, by owner (author and draft flag), by whether they close an issue … the merge queue, which PRs are owed a review, which conflict …" (`:58-63`).
- Own-work limit: the list stays a read, but every consumer below must keep only the PRs this Instance created or adopted (an identifier the Instance itself recorded); a PR whose ownership is unknown is skipped from every action and every count, never acted on.
- Mark: PR; nearest mark today: author login (`owned-pr.mjs:32-34`, applied only in S3-2/S3-4) and, for ledger-keyed consumers, the PR number on this Instance's ledger; tells Instances apart under one gh user: no; under different gh users: yes (author login)
- Notes: `author` and `isDraft` are fetched and `mergeable`/`body`/`headRefOid` are fetched for PRs of every author; `body` is hashed into the park match (`bodyDigest`, `:612`, `:1108`).

### S3-2 The gh login and the Owned PR flag
- Where: `plugin/scripts/fleet-tick.mjs:1702-1712` (`runLogin`), `:1748-1751`, `:1195` (only reader of `.owned`); `plugin/scripts/owned-pr.mjs:12` (`GH_LOGIN_ARGS`), `:32-34` (`isOwnedPr`)
- Kind: read-select
- Does: `gh api user -q .login`, then `isOwnedPr(p, login)` = `pr.author.login === login && pr.isDraft === false`, set as `p.owned` on each row of S3-1
- Scope today: login-wide
- Feeds / Selected by: feeds `reviewDue` only (`:1195`) → `DISPATCH review PR#<M>` (S3-4). Every other PR-keyed count ignores `.owned`. / Selected by: the credentials `gh` answers to.
- Exists because: `owned-pr.mjs:1-5` — "an open, non-draft PR whose `author.login` is the login the fleet's `gh` credentials answer to: every member acts through those credentials, so every PR the fleet opens carries it. A bot's PR, a stranger's, a fork's and a draft are not owned"; failed read refuses the tick because "'owns nothing' would drop every PR from review work" (`:1698`).
- Own-work limit: the filter must be replaced or narrowed to PRs this Instance created or adopted; the login alone covers every Instance sharing the gh user. When the PR's owner is unknown: no review, no fix — stall.
- Mark: PR; nearest mark today: author login; tells Instances apart under one gh user: no; under different gh users: yes
- Notes: the one place in the tick that tests ownership at all; it gates one of the seven PR-keyed reads.

### S3-3 The In-flight count includes every open issue-closing PR of any author
- Where: `plugin/scripts/fleet-tick.mjs:1092-1093` (`prsIn`, `closing`), `:1097`, `:1151-1153` (`inFlight`, `inFlightPrs`), `:386-389` (`HOLD (in-flight n/B)`), `:2360` (`held`), `:1309-1315` (`refreshWhy` returns null when held), `:350-353` (counts printed on the implementer row)
- Kind: read-inform
- Does: `inFlight = inFlightImpl + prsIn.length`, `prsIn = prs.filter((p) => p.closingIssuesReferences.length > 0)` over the whole S3-1 list; the same list's `closing` set removes this ledger's tickets from the ledger half (`:1094-1097`)
- Scope today: repo-wide
- Feeds / Selected by: feeds the Pull bound — at or over B every Pull is held (`:386-389`), and the refresh triggers are skipped (`:2360-2363`); prints `prs=<n>` on the implementer row (`:351`). / Selected by: S3-1.
- Exists because: "every open PR that closes an issue, whoever opened it and whatever its state" (`:63-65`); "a PR closing nothing is never in flight, however it was made" (`:1084-1085`); "A PR absorbs its ticket, so the hand-off from implementer to PR counts once" (`:1088`).
- Own-work limit: count only tickets this Instance claimed (ledger) and PRs this Instance created or adopted; another Instance's PRs are not this Instance's In-flight. Unknown ownership: the PR counts toward nothing and the printed `prs=<n>` omits it.
- Mark: PR / issue; nearest mark today: closing reference (`Closes #N` via `closingIssuesReferences`, restricted to this repository by `ownClosingIssues`, `:1751`); tells Instances apart under one gh user: no; under different gh users: no (closing reference carries no owner; author login would)
- Notes: also pulls the dashboard-shaped reading `prs=<n>` into the implementer row detail, so the printed In-flight counts others' work too. No filter by author, draft flag or label anywhere on this path.

### S3-4 `reviewDue`: owned open PRs with no review on THIS ledger → `DISPATCH review`
- Where: `plugin/scripts/fleet-tick.mjs:1194-1197` (`reviewDue`), `:418` (`DISPATCH review ${prs(reviews)}`), `:1001-1002` (`pastPinDue`), `:405-407`
- Kind: read-select
- Does: `prs.filter((p) => !isQueued(p) && p.owned && (!state(p.number)?.reviewedAny || pastPinDue(state(p.number), p.headRefOid))).map(p => p.number)` — the PR need not appear on the ledger at all; `state()` is this run's per-PR fold of `.fleet/ledger.md`
- Scope today: login-wide
- Feeds / Selected by: feeds the reviewers row `DISPATCH review PR#<M>` (`:418`) → S3-17 → a `fleet-review-runner` on PR M and, after the result, `fixDue` (S3-5) and the finisher (S3-20) on the same PR. "Every due unit is dispatched, no cap" (`:402-407`). / Selected by: S3-1 + S3-2; ledger absence = "no review on record" (`:1196`).
- Exists because: "Open, not signed off, owned (openPrs() reads that off the PR's author and draft flag; a PR closing no issue is as due as one closing one), with no live or returned review on record" (`:1186-1189`); `pastPinDue`: a finisher halted `past-pin` owes a fresh review while the head is past what that review read (`:996-1002`).
- Own-work limit: only a PR this Instance created or adopted may be review-due; a PR with another Instance's mark, or no readable mark, gets no row. "No review on THIS ledger" cannot count as "no review" for another Instance's PR — it is a ledger no other Instance can read.
- Mark: PR; nearest mark today: author login (S3-2); tells Instances apart under one gh user: no; under different gh users: yes
- Notes: two Instances on one gh user each see the other's non-draft PR as owned and review-due, and each ledger lacks the other's `review=`/`reviewed=` tokens — the review, then the fix-applier and finisher chain (S3-5, S3-18, S3-20), would run twice on one PR. A PR closing no issue is due too (Ticketless or Close-out PR, S3-26).

### S3-5 `fixDue`: PRs on this ledger with unanswered findings, holds or mismatches → `DISPATCH fix-pr`
- Where: `plugin/scripts/fleet-tick.mjs:1181-1185` (`fixDue`), `:417` (`DISPATCH fix-pr`), `:1132-1137` (`mismatchDue`), `:1112` (`fixRunning`)
- Kind: read-select
- Does: `[...byPr.entries()].filter(([n, st]) => open.has(n) && (((st.survived > 0 || st.unverified > 0) && !st.reviewFixed) || conflictHeld(st) || mismatchDue(st)) && !fixRunning(st) && !st.inFlight)` — keyed by PRs the ledger names, intersected with the open list; no `.owned` test
- Scope today: per-object from ledger (this Instance's `.fleet/ledger.md` fold), intersected with the repo-wide open list
- Feeds / Selected by: feeds `DISPATCH fix-pr PR#<M>` (`:417`) → S3-18 → a member that pushes to PR M's branch. / Selected by: the ledger rows (written by `ledger.mjs review/dispatch/row`, and by the merge bot's `conflict-hold:#<pr>` token, `:594-596`) and S3-1's `open`.
- Exists because: "finishing what is started beats starting more" (`:406-407`); a returned review's survived/unverified findings, a conflict hold no fix-applier has cleared, or a dispositions mismatch is owed a fix-applier (`:1174-1185`).
- Own-work limit: acts only on PRs this Instance created or adopted. This path is own-only exactly as far as every ledger row naming a PR is an own PR — which depends on S3-4 (reviews recorded on someone else's PR make it "known" here) and on Fold-in (phase 0, another slice).
- Mark: PR; nearest mark today: PR number on this Instance's ledger (host-local; invisible to other Instances); tells Instances apart under one gh user: no (nothing on GitHub); under different gh users: no
- Notes: a conflict hold on the row can come from the merge bot (`:594-596`), the merge bot being label-selected (S3-7, S3-19).

### S3-6 `CONFLICT` and `ESCALATE conflict` rows: open PRs GitHub reads CONFLICTING that the ledger tracks
- Where: `plugin/scripts/fleet-tick.mjs:1121-1125` (`conflicting`, `treadmill`), `:1220-1221`, `:443-452` (rows), `:164-167` (`reconcile` placing `conflictRows` outside the dispatch hold)
- Kind: read-select
- Does: `prs.filter((p) => p.mergeable === "CONFLICTING" && byPr.has(p.number) && !conflictHeld(state(p.number)) && !working(state(p.number)) && !(isQueued(p) && mergeBotLive > 0))`; prints `CONFLICT PR#<M> … ledger.mjs row <key> "<text> · conflict-hold:#<M> (conflict: mergeable=CONFLICTING)"`; past two landed conflict fix-appliers prints `ESCALATE conflict`
- Scope today: per-object from ledger (`byPr.has`), intersected with the repo-wide open list; label-wide for the queued branch (`isQueued`)
- Feeds / Selected by: feeds the controller's `fleet-event.mjs conflict <M>` (a ledger write) and then S3-5 → S3-18 conflict fix-applier (rebase and push onto PR M's branch); `ESCALATE conflict` feeds S3-23's `comment on the PR`. / Selected by: S3-1 (`mergeable`) ∩ the ledger.
- Exists because: "An open PR the run tracks that GitHub reads CONFLICTING, with no hold on record and nobody working it: the controller writes the hold the merge bot would" (`:435-438`); `workers` check: "one still unsettled holds the CONFLICT line off, since it may be pushing to the branch right now" (`:841-843`).
- Own-work limit: only for PRs this Instance created or adopted; "nobody working it" must also mean no other Instance is — today `working()` reads only this ledger's tokens (`:1119`), so a PR another Instance's member is rebasing right now is invisible to it.
- Mark: PR; nearest mark today: PR number on this ledger; tells Instances apart under one gh user: no; under different gh users: no
- Notes: `reconcile` places the conflict rows outside the dispatch hold (`:164-167`), so they print under phase-0 and main-checkout holds and during drain.

### S3-7 The merge queue: every open PR carrying `ready-to-merge` → `DISPATCH merge-bot`
- Where: `plugin/scripts/fleet-tick.mjs:1098-1099` (`isQueued`, `queued`), `:1198` (`mergeQueue`), `:1201` (`mergeHeld`), `:1204-1207` (`mergeParked`), `:1103-1110` (`parkOn`), `:458-479` (`mergeBot`, `:478` `DISPATCH merge-bot`), `:1121-1122`, `:1195`, `:2299` (label string from `.fleet/labels.json`)
- Kind: read-select
- Does: `queued = prs.filter(isQueued)`, `isQueued = p.labels.some((l) => l && l.name === queuedLabel)` — no author, ledger or `.owned` test; `mergeQueue - mergeHeld - parked.length > 0` and no live merge bot → `DISPATCH merge-bot`
- Scope today: label-wide (repo-wide set of PRs carrying the `ready-to-merge` role's string)
- Feeds / Selected by: feeds `DISPATCH merge-bot` (`:478`) → S3-19 (the merge bot, one per pass, selects and merges `ready-to-merge` PRs); feeds the `merge-queue=`/`held=` counts on the merge-bot row (`:462`); excludes queued PRs from `reviewDue` (`:1195`) and from `unlabelled` (`:1210`). / Selected by: S3-1 + the Label map.
- Exists because: "`ready-to-merge` is the author's sign-off and nothing more" (`:465`); the queue is "which PRs are owed a review, which conflict, which queued PR still matches the head and body it was parked at" (`:58-62`).
- Own-work limit: dispatch a merge bot only for a queued PR this Instance created or adopted and whose label this Instance's own finisher applied; a labelled PR with another Instance's (or no) mark is not this Instance's queue — no `DISPATCH merge-bot` for it, and the merge bot must be handed the PR numbers rather than a label query.
- Mark: PR; nearest mark today: `ready-to-merge` label (state, not owner); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the single most direct cross-Instance path in the tick: Instance B's finisher labels B's PR, Instance A's tick counts it in `merge-queue=` and dispatches A's merge bot. `mergeHeld`/`mergeParked` then read only A's ledger for holds/parks on that PR (`:1201`, `:1204-1207`) — a hold or park B recorded is invisible to A. `unlabelled`/`label-off=` (S3-8, S3-21) removal by A's controller on its own PR is equally visible to B's merge bot.

### S3-8 `unlabelled`: ledger finisher said `labelled`, open list shows no `ready-to-merge` → `DISPATCH finisher`
- Where: `plugin/scripts/fleet-tick.mjs:1209-1210`, `:730-734` (`unlabelledFinishers`), `:688-723` (`latestFinisherAttempts`), `:424-434` (rows), `:659-670` (`label-off=`)
- Kind: read-select
- Does: PRs whose latest `finisher-pr-M` attempt on this ledger settled `labelled` while `prs.filter(!isQueued)` contains M and no `label-off=` accounts for it → `DISPATCH finisher PR#<M>` once, then `ESCALATE unlabelled`
- Scope today: per-object from ledger (`finisher-pr-<M>` tokens), intersected with the open list's unlabelled PRs
- Feeds / Selected by: feeds the repair finisher (S3-20), which re-applies `ready-to-merge` (a label write by a member). / Selected by: S3-1 (label state) + the ledger.
- Exists because: "A finisher settled `labelled` on a PR the open list shows without `ready-to-merge`. One such attempt since the controller's last deliberate removal gets one fresh finisher" (`:419-422`); "A missing label is a finisher's miss only when no such removal accounts for it" (`:659-662`).
- Own-work limit: acts only on PRs whose finisher this Instance dispatched (ledger-keyed — already true), and must not treat a label removed by another Instance's controller as this Instance's finisher's miss; a missing label whose remover is unknown = stall, not repair.
- Mark: PR; nearest mark today: `finisher-pr-<M>` token on this ledger (host-local); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the removal that this check cannot account for is exactly the "label moved unexpectedly" case SKILL.md:28 tells the controller not to re-add (see Checked).

### S3-9 The shortlist refresh: the tick runs `shortlist.mjs` and replaces the Pull heads
- Where: `plugin/scripts/fleet-tick.mjs:1958-1966` (`refresh`, spawns `shortlist.mjs`), `:2361-2382` (trigger and head replacement), `:1309-1315` (`refreshWhy`), `:1318-1320` (`shortQueue`), `:2344-2347`, `:489-497` (`shortlistRows`); `:1273-1278` (`unclaimed`), `:346-399` (`implementers`, `:391` `PULL` rows)
- Kind: read-select
- Does: `spawnSync(process.execPath, [join(SCRIPT_DIR, "shortlist.mjs")])` when `status !== "ok"`, entries empty, `unclaimed < bound`, or a lifted premise (S3-10) — never while `held` (S3-3) or draining; `shortlist.mjs`'s own selecting reads (`gh issue list --label ready-for-agent …`, per-ticket probes; `shortlist.mjs:231-232` is one of them) belong to another slice
- Scope today: repo-wide / label-wide (through `shortlist.mjs`)
- Feeds / Selected by: feeds `heads = unclaimed(r.entries, run)` → one `PULL #<N> — pull.mjs next --head <N>` row per free slot (`:391`) → S3-14. / Selected by: `shortlist.mjs` output; `supply=` and `unclaimed=` printed on the implementer row are counts over everyone's `ready-for-agent` tickets (`:349-353`).
- Exists because: a failed refresh "IS actionable: a blind implementer row backing off tick after identical tick is the drained-queue stall this tick exists to end, exactly" (`:486-488`); a refresh that succeeds "replaces the heads outright: the PULL is read off what shortlist.mjs just probed" (`:2344-2346`).
- Own-work limit: the list is a read of tickets nobody owns yet (candidates); what is read about a candidate must stop at its claim state, and the write that follows (S3-14) must be conditional on the ticket still being unclaimed on GitHub, never on this Instance's ledger alone.
- Mark: issue; nearest mark today: in-progress label (query EXCLUDES it, per `:2062-2065`); tells Instances apart under one gh user: no; under different gh users: no (the label says claimed, not by whom)
- Notes: `unclaimed()` (below) is the second half of "which head is mine to Pull".

### S3-10 `unclaimed()`: a Shortlist head is "claimed" only by this run's ledger
- Where: `plugin/scripts/fleet-tick.mjs:1273-1278` (`unclaimed`), `:1015` and `:1028` (`claimed` built from `impl-` members and `excluded` rows), `:2347`, `:2368`
- Kind: read-select
- Does: `entries.map((e) => e.n).filter((n) => !run.claimed.has(n) || unverifiable.has(n))` — `run.claimed` = tickets with an `impl-` member on THIS `.fleet/ledger.md` plus tickets with an `excluded` row whose premise still holds
- Scope today: per-object from ledger
- Feeds / Selected by: feeds `heads` → `PULL` rows (`:391`) and the short-queue refresh trigger (`:1313`, `:2356`). / Selected by: S3-9's shortlist file.
- Exists because: "The shortlist entries no `impl-` or `excluded` row has claimed, in the file's own oldest-first order" (`:1263-1264`); "A row naming no premise has nothing to lift: it claims its ticket for good, as `pull.mjs next` and shortlist.mjs read it" (`:1271-1272`).
- Own-work limit: a head must be Pulled only when no other Instance holds it; this function can say only "no row on this host's ledger". Unknown claim state = no PULL row (stall).
- Mark: issue; nearest mark today: `impl-<N>` token on this ledger (host-local), in-progress label on GitHub (read by `shortlist.mjs`, not here); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the only GitHub-side guard between refresh and Pull is `shortlist.mjs`'s query excluding `in-progress`, run at refresh time; the Pull happens a tick later, and nothing in the tick re-reads the label before printing `PULL`.

### S3-11 Exclusion-premise probes: `gh pr view <branch>` / `gh issue view <#M>` on the work an Exclusion waits behind
- Where: `plugin/scripts/fleet-tick.mjs:1830-1843` (`premiseState`), `:1856-1880` (`liftedPremise`), `:1862`, `:1869`, `:2363`, `:978-990` (premise parsing, `behind-pr:#M` lift off the open list)
- Kind: read-select
- Does: `gh pr view <target> --json state` for a branch-named `behind-pr:<branch>` premise; `gh issue view <M> --json state` for `behind-issue:#M`; `behind-pr:#M` lifts off the S3-1 open list (`:986-987`, `:1876`); env scrubbed with `gitEnv({ GH_REPO: "" })`
- Scope today: per-object from a ledger premise (the premise names someone else's PR/branch/issue by definition)
- Feeds / Selected by: feeds the refresh trigger (`behind-pr:#<t> MERGED`, `…not merged, #<n> still on the shortlist`, `:1864-1872`) → S3-9 → PULL heads. / Selected by: `excluded` rows written by `pull.mjs` after the Q3 collision answer (`SKILL.md:502`; pull.mjs is another slice).
- Exists because: "before its PR exists, 'no open PR' is not 'merged'" (`:1849-1850`); "An unanswered probe never lifts an exclusion" (`:1855`).
- Own-work limit: this is a read of a ticket's blocker, which is usually another party's PR or branch. It may stay a read; the decision it feeds (Pull the ticket) must treat a blocker owned by another Instance the same as any foreign blocker. Unknown state: exclusion stands (already the code's rule).
- Mark: PR / branch / issue; nearest mark today: head branch name (`gh pr view <branch>` resolves by branch name, any author); tells Instances apart under one gh user: no; under different gh users: no
- Notes: `gh pr view <branch>` resolves a branch name to whichever PR carries it. A branch-named premise is the plugin's only collision signal for an Instance's in-progress branch, and it is named by head branch, which has no Instance part.

### S3-12 Stall report: `gh issue list --label in-progress` counts every claimed ticket in the repository
- Where: `plugin/scripts/fleet-tick.mjs:2067-2084` (`claimed`), `:2090-2096` (`claimedCount`), `:2268-2272` (printed in `stallReport`), `:1587` (`CLAIMED_LIMIT`)
- Kind: read-inform
- Does: `gh issue list --label <in-progress string> --state open --limit 200 --json number --jq length`; prints the number in the stall report when the prior run's liveness verdict is stalled
- Scope today: label-wide
- Feeds / Selected by: feeds only the text of the stall report (`stallReport(verdict, { claimed, supply, owner })`). / Selected by: the Label map's `in-progress` string; read before any other gh read.
- Exists because: "How many tickets a dead run stranded. The in-progress role is the claim label claim-ticket.sh adds and candidates.mjs's query EXCLUDES — which is why a stranded ticket is invisible to the next run's scans, and why this count is the actionable half of the report" (`:2061-2065`).
- Own-work limit: "stranded" must count only claims this Instance's earlier runs left (own claims); another Instance's live claims are not stranded and not this Instance's to report.
- Mark: issue; nearest mark today: in-progress label; tells Instances apart under one gh user: no; under different gh users: no
- Notes: with several Instances on one repository this number includes every live Instance's claims, reading as "stranded" in a report that tells the next run what to resume.

### S3-13 `--apply`: reap, reclaim and evict after every merge-bot pass settled `done`
- Where: `plugin/scripts/fleet-tick.mjs:1995-2013` (`applyReap`), `:2307-2320`, `:1496-1499` (`reapDue`), `:1971-1976` (`runSibling`), `:1169` (`mergeBotDone`)
- Kind: write
- Does: `spawnSync(reap.sh, ["--apply"])`, `reclaim-scratch.mjs --root <scratch> --apply`, `evict.mjs --apply` once for any merge pass settled `done` on this ledger; read from `reap.sh` (another slice): `git fetch --prune origin` (`reap.sh:270-282`), enumerates `[gone]` branches and no-upstream branches repository-wide (`reap.sh:1049-1065`), deletes them (`reap.sh:1135-1138`); `reclaim-scratch.mjs:121` reads PR/branch state through `ghAliasedRead`
- Scope today: no precondition (the trigger is this Instance's own merge pass; the target set is whatever `reap.sh` selects)
- Feeds / Selected by: feeds deletion of local and remote-tracking-derived branches and worktrees, and scratch removal. / Selected by: `mergeBotDone` (own ledger, `:1169`) as the trigger; `reap.sh`'s own `[gone]` enumeration as the target set (other slice).
- Exists because: "Reap, reclaim and evict after every merge pass settled `done` since the last time they ran" (`:2308-2310`); SKILL.md:175-184 relies on it.
- Own-work limit: only branches/worktrees this Instance created (recorded by it); a `[gone]` branch that is not on this Instance's records is another Instance's (or the maintainer's) and is kept. Ownership unknown: keep.
- Mark: branch; nearest mark today: none for ownership (head branch name `implementer/<N>-…` names the ticket, no Instance part; pattern not in this slice's files); tells Instances apart under one gh user: no; under different gh users: no
- Notes: `fleet-tick.mjs` itself only spawns; the selection and the delete sit in `reap.sh` (owner: another slice). The trigger is a ledger state (host-local), so two Instances each reap after their own passes.

---

## B. `plugin/skills/run-team/SKILL.md` and its references

### S3-14 `PULL` rows: run `pull.mjs next --head <N>` — claim, close, relabel on a ticket not yet claimed
- Where: `plugin/skills/run-team/SKILL.md:378`, `:405-406`, `:453-457` (Q1b `close`, Q2 `decided`), `:487-488`, `:497-502` (exit table), `plugin/skills/run-team/references/tick-rows.md:7-9`
- Kind: instruction-write
- Does: "one Pull per named ticket … `pull.mjs next --head <N>`"; Q1b "`yes` closes the issue with a comment citing the commit and its subject"; Q2 "any but `decided` posts that cause's comment and replaces `ready-for-agent` with its label"; exit table row 0: "decided, live, free, claimed, routed" (claim is the step after Q1/Q1b/Q2/Q3); exit 1 `taken … in-flight hit … or claim-ticket.sh exit 2`
- Scope today: per-object from S3-9/S3-10 (a ticket this Instance has not claimed); no precondition on the close and relabel writes
- Feeds / Selected by: feeds writes in `pull.mjs` (other slice): issue comment, label swap, close, and `claim-ticket.sh` (adds `in-progress`). / Selected by: the tick's `PULL` row (S3-9, S3-10).
- Exists because: SKILL.md:405-406 — "Serial, main checkout, one Pull at a time. Never parallel, never inside a member — concurrent `worktree add` and label writes race"; `:487-488` — the issue step re-reads labels fresh and exits 1 `relabelled elsewhere` once `ready-for-agent` is gone.
- Own-work limit: close, relabel and comment may touch only a ticket this Instance has claimed (a claim that succeeded conditionally on GitHub); before the claim they must be reads only. Unknown claim state: leave the ticket (stall).
- Mark: issue; nearest mark today: in-progress label (state), assignee (not read or written by anything in this slice — grep of the slice finds none); tells Instances apart under one gh user: no; under different gh users: no
- Notes: "Serial" and the race sentence at `:405-406` are about one controller's Pulls; they say nothing about a second Instance. The order claim-after-close/relabel is from SKILL.md's own exit-table wording (`:497`) and the Q1b/Q2 text; the pull.mjs code was not read in this slice [INFERENCE for ordering inside pull.mjs].

### S3-15 Phase 0 step 1: `shortlist.mjs` run by hand
- Where: `plugin/skills/run-team/SKILL.md:83-98`; `plugin/skills/run-team/references/tick-rows.md:275-287` (refresh described as the tick's)
- Kind: instruction-read
- Does: "`~/.fleet/bin/fleet-run shortlist.mjs`, then read `.fleet/shortlist.json`"; "`--require-label ready-for-agent` mandatory, no fallback: never run `candidates.mjs --allow-fallback` by hand"
- Scope today: repo-wide / label-wide (through `shortlist.mjs`)
- Feeds / Selected by: feeds the run's first `unclaimed()` set (S3-10) and `supply=`. / Selected by: nothing.
- Exists because: "a dead run's shortlist is stale by definition" (`tick-rows.md:285`).
- Own-work limit: as S3-9.
- Mark: issue; nearest mark today: `ready-for-agent` label + in-progress label exclusion; tells Instances apart under one gh user: no; under different gh users: no
- Notes: same read as S3-9, by the controller instead of the tick.

### S3-16 Phase 0: `NEED resume #<n> <worktree> <branch>` — dispatch an implementer onto a dead run's claim
- Where: `plugin/skills/run-team/SKILL.md:73-79`; `plugin/skills/run-team/references/tick-rows.md:82-86` (`replace #N`); `plugin/scripts/fleet-tick.mjs:2061-2066`
- Kind: instruction-write
- Does: "a dead run's claim: no PR, or not only `CLOSED` ones. Dispatch a stranded `impl-<n>-b` the ordinary way … in that worktree and branch, and never with `claim-ticket.sh`: the claim stands"
- Scope today: per-object from a phase-0 NEED line (selector in `phase0.mjs`, another slice); `[INFERENCE]` that it selects off the in-progress label, since the tick's stall report treats "claimed" = the label count as the stranded-claim measure (`fleet-tick.mjs:2061-2066`)
- Feeds / Selected by: feeds an implementer that pushes to the claim's branch and opens a PR. / Selected by: phase 0's "Resume the claims a dead run left without a PR" step (`SKILL.md:73`, other slice).
- Exists because: "the claim stands" — resuming is cheaper than releasing and re-pulling a ticket with a worktree and branch.
- Own-work limit: resume only a claim this Instance's own earlier run made (its worktree on this host, its ledger). A claim with the in-progress label and no record here is another Instance's live claim — leave it (stall).
- Mark: issue + branch + worktree; nearest mark today: in-progress label (+ local worktree); tells Instances apart under one gh user: no; under different gh users: no
- Notes: Stranded Claim identification is the other slice's; this entry is the controller instruction that acts on it.

### S3-17 `DISPATCH review PR#<M>`: dispatch a review runner onto the PR the tick names
- Where: `plugin/skills/run-team/SKILL.md:225-226`, `:383`, `:148`, `:754` (`past-pin` re-review); `plugin/skills/run-team/references/member-lifecycle.md:194-195`; `plugin/skills/run-team/references/tick-rows.md:31-32`
- Kind: instruction-write
- Does: "`DISPATCH review PR#<M>`: a `task` member named `review-pr-<pr#>`, agent `fleet-review-runner`, its prompt the five args `pr`, `branch`, `worktree`, `testCmd` and `scratch`. Record `review=member:review-pr-<pr#>` on the PR's row before the call"; `:148` "the PR is owed a review from here on"
- Scope today: per-object from S3-4 (login-wide)
- Feeds / Selected by: feeds a runner that reads PR M's diff and head and produces a result file; the returned `reviewed=<head>:<s>/<r>/<u>:<run>` token makes the PR fixable (S3-5) and gates its finisher (S3-20). / Selected by: S3-4.
- Exists because: "The tick counts in-flight reviews off the ledger and nowhere else, so a review you launched and never recorded is one it names again" (`member-lifecycle.md:194`); `:226` — a review row with `review=` and no `reviewed=` stays a live review unit unless gh reports its PR MERGED or CLOSED.
- Own-work limit: dispatch only for a PR this Instance created or adopted; the `review=` token the Instance writes is local, so another Instance cannot see that a review already runs on its own PR.
- Mark: PR; nearest mark today: author login + the `review=`/`reviewed=` tokens on this ledger (host-local); tells Instances apart under one gh user: no; under different gh users: yes (author login)
- Notes: Invariant `SKILL.md:25` "A reviewer never reviews a PR it implemented" is enforced by member name, not by a GitHub-visible mark.

### S3-18 `DISPATCH fix-pr`: fix-applier, conflict fix-applier and red-check fixer onto PR M
- Where: `plugin/skills/run-team/SKILL.md:227-229`, `:382`, `:387`, `:521`; `plugin/skills/run-team/references/member-lifecycle.md:196-198`; `plugin/skills/run-team/references/tick-rows.md:28-30`, `:50-62`
- Kind: instruction-write
- Does: render `dispatch-prompt.mjs render fix-applier --kind review|conflict|red-check …`, record `ledger.mjs dispatch <pr#> fix-pr-<pr#>`, `task` call in "the PR's existing worktree"; branch from "`gh pr view <N> --json headRefName -q .headRefName`" (`:521`); red-check fixer: "on a `check`-job `failure` bound to the PR's current head … The tick prints no `DISPATCH` for it: reconcile it yourself" (`:229`)
- Scope today: per-object from S3-5 / S3-6 (ledger-keyed); the red-check fixer is selected by the controller from the CI Monitor (S3-25), repo-wide
- Feeds / Selected by: feeds member pushes to the PR branch (fix commits, rebase) and settle of `applied:<head>` that "lifts the merge hold". / Selected by: S3-5, S3-6, S3-25.
- Exists because: the review's findings and conflicts are fixed by a fresh member in the PR's own worktree (`:227-229`); "On a PR carrying `ready-to-merge`, its push moves the head after the label: a fresh finisher" (`:227`).
- Own-work limit: push only to a PR branch this Instance created (and whose worktree is on this host); a PR the Instance does not own is neither fixed nor rebased. Unknown owner: no dispatch.
- Mark: PR + head branch; nearest mark today: head branch name (no Instance part), PR number on this ledger; tells Instances apart under one gh user: no; under different gh users: no
- Notes: the red-check fixer path (`:229`) has no tick row, so no ledger check stands between the CI Monitor's repo-wide list and the dispatch — the controller decides alone, "always after the review".

### S3-19 `DISPATCH merge-bot`: the merge pass over the `ready-to-merge` queue
- Where: `plugin/skills/run-team/SKILL.md:165-168`, `:171-184`, `:230`, `:384`, `:809-812`; `plugin/skills/run-team/references/tick-rows.md:33`; `plugin/skills/run-team/references/failure-handling.md:70-74`
- Kind: instruction-write
- Does: "dispatch on the first `ready-to-merge` label without waiting for the finisher report" (`:230`); the bot merges with "`gh pr merge <n> --merge` alone … the merge bot deletes the head branch itself" (`failure-handling.md:72-73`); on conflict it writes `conflict-hold:#<pr>` onto the PR's row (`:810`); on a main-gain hit it parks the PR (S3-22); "A label that landed at the last moment reads `DISPATCH merge-bot` again: dispatch the next bot straight away" (`:172-173`)
- Scope today: label-wide (the bot's own selection in `commands/run-merge-bot.md`, another slice); the dispatch trigger is S3-7
- Feeds / Selected by: feeds `gh pr merge`, head-branch deletion, `gh pr update-branch --rebase` (`ci-and-staleness.md:187`, cited, other slice) on queued PRs. / Selected by: S3-7.
- Exists because: `SKILL.md:26` — "The merge bot only touches PRs whose implementer reported done; rebasing a worktree someone is working in destroys uncommitted work."
- Own-work limit: merge only PRs this Instance created or adopted and whose label this Instance's finisher applied; a labelled PR whose provenance is unknown is skipped and stays queued (stall).
- Mark: PR; nearest mark today: `ready-to-merge` label (state); tells Instances apart under one gh user: no; under different gh users: no
- Notes: Invariant `SKILL.md:26` relies on "implementer reported done", which is a ledger fact (host-local), not a GitHub-visible one.

### S3-20 `DISPATCH finisher`: finisher fresh, repair and halt-resolution dispatches
- Where: `plugin/skills/run-team/SKILL.md:231`, `:385`, `:525-560`, `:576-630` (dispatch and refusals), `:753-756`, `:762-770`; `plugin/skills/run-team/references/tick-rows.md:34-44`; `plugin/skills/run-team/references/member-lifecycle.md:57`
- Kind: instruction-write
- Does: "dispatch a **finisher** — a fresh small agent … Render its brief with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<pr#> …`"; the finisher applies `ready-to-merge` ("never add the label yourself", `:385`, `:769-770`); `ledger.mjs dispatch` refuses it on a PR with a returned review whose survived/unverified count is not answered, with a live fix-applier, or with an unresolved conflict hold (`:600-630`)
- Scope today: per-object from the ledger (a PR with a returned review and a fix-applier report on this ledger), or from S3-8 for repair dispatches, or from S3-25's CI edge (repo-wide events)
- Feeds / Selected by: feeds the label write on PR M and the `gh`-side PR checks the finisher reads. / Selected by: S3-4/S3-5 chain, S3-8, S3-25.
- Exists because: "Green is therefore not the gate: dispatch a finisher only once the PR's review has returned AND its fix-applier, if one was dispatched, has sent its report" (`:529-541`).
- Own-work limit: only for PRs this Instance created or adopted; applying `ready-to-merge` is a write with no precondition today, so another Instance must not be able to apply or remove that label on this Instance's PR, nor be taken for the remover.
- Mark: PR; nearest mark today: `finisher-pr-<M>` token on this ledger; tells Instances apart under one gh user: no; under different gh users: no
- Notes: `SKILL.md:27` — "`ready-to-merge` is added by a reviewer only — never an implementer, never you" is a who-did-it rule; `SKILL.md:28` says no write is attributable (S3-21).

### S3-21 Controller removes `ready-to-merge` from a PR before approving a push
- Where: `plugin/skills/run-team/SKILL.md:639-642`; `plugin/skills/run-team/references/ci-and-staleness.md:185-188` (cited, other slice, queue Monitor)
- Kind: instruction-write
- Does: "`ledger.mjs token <PR number> label-off=<latest finisher attempt>` … then remove the label (`gh pr edit <pr> --remove-label "<ready-to-merge string>"`, the string `show ready-to-merge` prints), then approve. Then dispatch a **fresh** finisher against the new head"
- Scope today: per-object from ledger (the PR whose latest finisher attempt is on this ledger); no precondition against an Instance's merge bot acting on that PR at the same moment
- Feeds / Selected by: feeds the S3-8 `label-off=` accounting and the S3-20 fresh finisher. / Selected by: S3-18/S3-20 (the PR a fix-applier is about to push to).
- Exists because: "a push before that report is mid-work on a SHA the member may still move"; the first audit "verified a different tree" (`:641-642`).
- Own-work limit: only this Instance's own PR; if the PR might be in another Instance's merge pass, wait (stall) rather than remove the label.
- Mark: PR; nearest mark today: `ready-to-merge` label (state); tells Instances apart under one gh user: no; under different gh users: no
- Notes: Invariant `SKILL.md:28` — "Every member acts through the maintainer's `gh` credentials, so no write is attributable: when a label moves unexpectedly, ask members directly, rule out automation …, and do not re-add it." The "ask members" step assumes every writer is one of this run's own members; another Instance's controller or merge bot would not be among them.

### S3-22 Controller edits a PR body with `gh pr edit --body-file` (closing references; main-gain acknowledgement)
- Where: `plugin/skills/run-team/SKILL.md:562`, `:794`
- Kind: instruction-write
- Does: (a) "The PR's closing references match its ruling and exclude its own suggestion-band record → … repair the body with `gh pr edit <M> --body-file <file>`, then dispatch again" (`:562`); (b) main-gain park: "append the lines to the PR body with `gh pr edit <pr> --body-file <file>`" the line shape `main-gain-removal: <path> <key> - <why>`, after the maintainer's yes (`:794`)
- Scope today: (a) per-object from ledger (the PR at the finisher gate, S3-20); (b) per-object from the merge bot's park report (`fleet-event.mjs merge-bot-report` writes `parked=<head>:<body digest>:<reason>` on the PR's row; the PR comes from the label-wide queue, S3-7/S3-19). No precondition on a concurrent edit of the body in either case.
- Feeds / Selected by: (a) feeds the finisher's gate refusal; (b) feeds `parkOn` (`fleet-tick.mjs:1103-1110`) via `bodyDigest(p.body)` — "a new head or an edited body lifts every earlier park". / Selected by: (a) S3-20; (b) S3-19.
- Exists because: (a) a PR whose body closes the wrong tickets (or its own suggestion record) would close them on merge; (b) "The edited body lifts the park" (`:794`), and "There is no standing restore procedure" otherwise.
- Own-work limit: edit only the body of a PR this Instance created or adopted; for (b), a PR whose park came from another Instance's merge pass must not have its body edited here.
- Mark: PR; nearest mark today: closing reference (`Closes #N`) for (a); fleet body marker `main-gain-removal: <path> <key> - <why>` for (b) — a verbatim line shape in the PR body that other Instances' ticks also read, through `bodyDigest` over `body` (S3-1); tells Instances apart under one gh user: no; under different gh users: no
- Notes: no `Refs #M` rewrite appears in any file of this slice (grep of SKILL.md and the four references: no `Refs #`); the only controller-run body edits are the two above. The park token `parked=<head>:<digest>:<reason>` itself is a ledger token (host-local), so a park recorded by one Instance does not exist for another.

### S3-23 Controller posts `gh pr comment` on PRs: halt, dispositions escalate, conflict escalate
- Where: `plugin/skills/run-team/SKILL.md:388`, `:617-619`, `:746-747`, `:787-788`; `plugin/skills/run-team/references/tick-rows.md:63-66`
- Kind: instruction-write
- Does: "`ESCALATE conflict PR#<M>` — … comment on the PR and flag it for a human" (`:388`); "Post the check's output … with `gh pr comment <M>`, and flag the PR for a human" (`:617-619`, `:787-788`); "you post the finisher's halt report — cause and evidence — with `gh pr comment <M>`, so it outlives the run" (`:746-747`); `rebase`/`stray`/`unreadable`/`missing`/`absent`/`other` halts: "Escalate — comment and flag" (`:755-757`)
- Scope today: per-object from the ledger (PRs whose finisher/fix-applier tokens are on this ledger); no precondition
- Feeds / Selected by: feeds the maintainer's attention. / Selected by: S3-6 (`ESCALATE conflict`), S3-20 (halt), S3-18 (dispositions).
- Exists because: "so it outlives the run".
- Own-work limit: only on PRs this Instance created or adopted; comment text carries no run, member or ledger token (verbatim: none found in these lines), so another Instance cannot tell whose comment it is.
- Mark: comment; nearest mark today: none (comment bodies hold evidence, not a run or member marker); tells Instances apart under one gh user: no; under different gh users: yes (comment author)
- Notes: `SKILL.md:389` for `pr-closed`/`pr-unchecked`: "post no GitHub comment" (`tick-rows.md:75-76`).

### S3-24 Persistent Monitor on the `ready-to-merge` label
- Where: `plugin/skills/run-team/SKILL.md:135`, `:165-170`; `plugin/skills/run-team/references/ci-and-staleness.md:185-190`
- Kind: instruction-read
- Does: "You own the watcher, not the bot. Arm one yourself, `persistent: true`, seeded before the loop so handled PRs do not re-fire" — fires `fleet-event.mjs label <pr>` when a PR gains the label. The query body is not in these files; `commands/run-merge-bot.md:302` (other slice) shows its shape: `gh pr list --state open --label "<ready-to-merge string>" --limit 200 --json number`
- Scope today: label-wide
- Feeds / Selected by: feeds `fleet-event.mjs label <pr>` → S3-7 / S3-19. / Selected by: nothing.
- Exists because: "The `ready-to-merge` Monitor catches hand-added labels as well as a finisher's own" (`ci-and-staleness.md:185`).
- Own-work limit: wake only for PRs this Instance's finisher labelled, or that it created or adopted.
- Mark: PR; nearest mark today: `ready-to-merge` label; tells Instances apart under one gh user: no; under different gh users: no
- Notes: "hand-added labels" by anyone — the Monitor is deliberately label-wide.

### S3-25 Persistent Monitor over every open PR's latest CI run, and its `ci=` wake
- Where: `plugin/skills/run-team/SKILL.md:134`, `:529-560` (`CI run terminal` edge), `:576-598`, `:646-657`; the block it names is `plugin/skills/run-team/references/ci-watcher.md:20-28` (cited, other slice)
- Kind: instruction-read
- Does: "Arm a second persistent Monitor over open PRs' latest runs from the block in references/ci-watcher.md, verbatim, keyed `<run-id>:<attempt>:<conclusion>`: one `~/.fleet/bin/fleet-run ci-state.mjs --pr <N>` per open PR"; the block's list is `gh pr list --state open --limit "$pr_cap" --json number` (`ci-watcher.md:28`) plus `gh api rate_limit` (config)
- Scope today: repo-wide
- Feeds / Selected by: feeds `fleet-event.mjs ci <pr>` → records `ci=<run-id>:<attempt>:<conclusion>` on the PR's row → finisher dispatch (S3-20), red-check fixer (S3-18). / Selected by: nothing — every open PR of every author.
- Exists because: "Green is therefore not the gate" and "the Monitor is edge-keyed on `<run-id>:<attempt>:<conclusion>`, so no push means no CI event, ever" (`SKILL.md:557-558`).
- Own-work limit: poll `ci-state.mjs` only for PRs this Instance created or adopted; a CI event for any other PR is dropped before it reaches `fleet-event.mjs ci`.
- Mark: PR; nearest mark today: none (the number list is repo-wide); tells Instances apart under one gh user: no; under different gh users: no (author login would, as a filter)
- Notes: whether `fleet-event.mjs ci` writes a ledger row for a PR not already on the ledger is `fleet-event.mjs`'s (another slice); here the instruction does not filter.

### S3-26 End of run: `closeout.mjs begin` / `finish` — Close-out PR creation and merge, claims release
- Where: `plugin/skills/run-team/SKILL.md:185-208` (End of run), `:189-194` (`begin`, `NEED hand-release`), `:199-205` (`finish`, `left open`); read from `plugin/scripts/closeout.mjs:342-348` (branch name `chore/run-artifacts-<date>` with `b`–`z` suffix; `git ls-remote --exit-code --heads origin <name>`), `:407-408` (`git push -u --force-with-lease=…`), `:419` (`gh pr create --head <branch> --title "Closeout: <reason>" --label patch --body …`), `:599` (`gh pr merge <n> --merge --match-head-commit <pin>`) — script is another slice's
- Kind: instruction-write
- Does: "`closeout.mjs begin --reason`", "`closeout.mjs finish --reason` … then merges the Close-out PR"; "`begin` selects a claim with no PR and a live or `bailed` implementer token on every run: release the rest by hand and run `begin` again" (`:192-194`); "A PR it names `left open` is the next run's: you never label or merge it" (`:200`)
- Scope today: per-object from this run's receipt (its own branch/PR) for the push/create/merge; claim release selected from ledger tokens
- Feeds / Selected by: feeds a created branch, a PR labelled `patch`, a merge, and releases of claims. / Selected by: the Instance's own `closeout.mjs` receipt and ledger.
- Exists because: the Close-out PR carries the run's artifacts (docs/metrics) into main; the name uses "the UTC date" and `b…z` suffixes while a name exists "locally or on origin".
- Own-work limit: branch, PR and merge only the Close-out PR this Instance created; a same-date `chore/run-artifacts-<date>` branch that another Instance pushed must never be adopted or overwritten — the name check is the only collision test and it has no Instance part.
- Mark: PR + branch; nearest mark today: head branch name `chore/run-artifacts-<UTC date>[b-z]`; tells Instances apart under one gh user: no; under different gh users: no
- Notes: `begin` ~ "release the rest by hand" interacts with S3-28 (claims with no PR). Verbatim GitHub-visible markers written by `closeout.mjs` (read at `closeout.mjs:416-419`): PR title `Closeout: <reason>`, label `patch`, body `Closeout: <reason>\n\nRows changed:\n<row counts>\n`; head branch `chore/run-artifacts-<YYYYMMDD>[b-z]` (`closeout.mjs:342-344`). The push is `git push -u --force-with-lease=refs/heads/<branch>:<pin> origin <branch>` (`closeout.mjs:407-408`) — a force-with-lease whose lease is this run's last-pushed head, "an empty one expects the branch absent from origin" (`:405-406`).

### S3-27 The controller's own reap by hand: `[gone]` branches (clean_gone prohibited)
- Where: `plugin/skills/run-team/SKILL.md:175-184`, `:921-923`; `plugin/skills/run-team/references/reaping.md` (named, other slice)
- Kind: instruction-write
- Does: "The tick's `--apply` reaps after the pass … **Do not invoke `commit-commands:clean_gone`**: do the reap yourself. **Never reap a branch a live member is on** — cross-check `.fleet/ledger.md` first for a row without a terminal state."
- Scope today: no precondition beyond this host's ledger (the live-member check reads only `.fleet/ledger.md`)
- Feeds / Selected by: feeds deletion of every `[gone]` local branch and its worktree (S3-13). / Selected by: `git branch -vv` `[gone]` — a purely local view of origin after fetch.
- Exists because: stale worktrees make phase 0 read merged tickets as taken (`:926-927`); merge bot "deletes the head branch itself".
- Own-work limit: reap only branches/worktrees this Instance created; the live-member cross-check must cover every Instance's members, not one ledger.
- Mark: branch; nearest mark today: none (`[gone]` is a tracking-branch state; branch name names the ticket, no Instance part); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the only guard the instruction names is this host's ledger. A branch another Instance (on another clone) is working would show `[gone]` only if its remote branch was deleted; the check cannot see that Instance's live members.

### S3-28 `release-ticket.sh --apply`: abandoned claims and closed-PR release
- Where: `plugin/skills/run-team/SKILL.md:389` (`release #N`), `:816-817` (abandon and release "over every claimed ticket with no PR when the run ends or the maintainer drains"), `:190-194`; `plugin/skills/run-team/references/tick-rows.md:87-92`
- Kind: instruction-write
- Does: "`~/.fleet/bin/fleet-run release-ticket.sh <N> impl-<N> implementer --apply`, the pair the claim took, on the spot — and over every claimed ticket with no PR"; "That refusal is the finding, never an obstacle: a claim carrying commits or a pushed branch is not auto-released, ever"
- Scope today: per-object from the ledger (`impl-<N>` tokens) — but "every claimed ticket with no PR" is selected at the end of run by `closeout.mjs begin` (ledger-based per `:192`) or by hand `[INFERENCE]` from the in-progress label
- Feeds / Selected by: feeds removal of `in-progress` and a branch/worktree deletion (release-ticket.sh, another slice). / Selected by: the ledger's `impl-<N>` tokens for the controller's own claims.
- Exists because: "The reap at the end will pick up the claim I never dispatched" → "it declines: not `[gone]`, no unique commits. Release it, or it reads as taken next run" (`:903-904`).
- Own-work limit: release only a claim this Instance made (its ledger token and worktree). A claim with `in-progress` and no record here is not this Instance's to release (stall).
- Mark: issue; nearest mark today: in-progress label + this ledger; tells Instances apart under one gh user: no; under different gh users: no
- Notes: scope is own-only as long as the claim list comes from the ledger; the instruction text "every claimed ticket with no PR" does not say which source.

### S3-29 Implementer bail causes: relabel / close / comment on the claimed ticket, and PR M of `covered`
- Where: `plugin/skills/run-team/SKILL.md:154`, `:718-728`
- Kind: instruction-write
- Does: table "Issue action": `undecided` → relabel `needs-triage`; `fork` and `hands` → relabel `ready-for-human`; `fixed` → "`verify-sha.sh main <sha>` first. Exit 0: close N with the `fixed` comment …, drop `ready-for-agent`, release the claim (drops `in-progress`)"; `covered` → "relabel `ready-for-human` with the `covered` comment: close N when M merges, or restore `ready-for-agent` if M closes unmerged. PR M's body is never edited"
- Scope today: per-object from this run's own claim (issue N); the `covered` row names PR M, another PR the member found by its own search
- Feeds / Selected by: feeds writes on issue N (label, comment, close). / Selected by: the bail report of `impl-<N>` (own member).
- Exists because: "A member that bails demotes nothing itself; demotion by cause is yours" (`:732`).
- Own-work limit: writes only on N, which this Instance claimed; the follow-up "close N when M merges, or restore `ready-for-agent` if M closes unmerged" is a read of PR M (not own) — it must remain a read, never an edit of M.
- Mark: issue; nearest mark today: in-progress label + this ledger; tells Instances apart under one gh user: no; under different gh users: no
- Notes: no precondition against the in-progress label having been taken by another Instance after this claim — the claim itself is the object whose atomicity matters (S3-14).

---

## Checked, own-only or config
- `plugin/scripts/fleet-tick.mjs:1893-1919` `closedTickets`: `gh issue view <N> --json state` for tickets from this ledger's mismatched/owed/keyed `impl-` members — own claim's issue, read only.
- `plugin/scripts/fleet-tick.mjs:1930-1953` `prStates` + `plugin/scripts/gh-aliased-read.mjs:1-104`: one aliased `gh api graphql` `repository { n<N>: pullRequest(number:N){state} }` read per hundred PR numbers, numbers from this ledger's `review=` tokens and keyed `impl-<N>=PR#<M>` tokens — per-object from own ledger, read only.
- `plugin/scripts/fleet-tick.mjs:184-196` `prClosedRows`, `:1063-1071` `prKeyed`: ESCALATE lines on tickets whose keyed PR is closed — per-object from this ledger; prints only; the writes in SKILL.md:389 are S3-28.
- `plugin/scripts/fleet-tick.mjs:2033-2059` `applyTierChecks`, `:1971-1976` `runSibling("tier-check.mjs")`: reads `<session>/<member>.jsonl` transcripts and writes ledger rows; `tier-check.mjs` was searched for `gh`/`git ls-remote`/`fetch`/`push` call sites and none found — host-local.
- `plugin/scripts/fleet-tick.mjs:1771-1787` `readLedger` (`ledger.mjs read`), `:1789-1843` shortlist/label-map/cost-guard file reads, `:2200-2215` `readPulls`, `:2152-2180` `readReports`, `:2187-2195` `listTranscripts`, `:2305` `checkMainCheckout()`, `:2281-2284` phase-0 receipt, `:2231-2273` state-file reads/writes — host-local `.fleet/`, `~/.fleet`, scratch, process table; none gate a GitHub write here (the `held` flags only hold printing rows).
- `plugin/scripts/fleet-tick.mjs:1224-1236` `reviewed` block and `:1252-1259` `reporters`/`recorded` — ledger-only counts.
- `plugin/scripts/fleet-tick.mjs:1566-1568` `fleet-state.mjs` calls — host-local state; `stallOwner`/`assessBeat` read the controller record only.
- `plugin/scripts/fleet-tick.mjs:2061-2096` `claimed` is S3-12; `:2090-2096` `claimedCount` reads the Label map (config) then S3-12.
- `plugin/scripts/fleet-tick.mjs:1565`, `:2221-2229` `label-map.mjs` read: the Label map is shared repository configuration (`config`).
- `plugin/scripts/fleet-tick.mjs:1706` `gh api user -q .login` is S3-2; no other `gh api` call in this file.
- `plugin/scripts/staleness.mjs:180-182`, `:245`, `:278`, `:307`, `:382` — `git rev-parse --show-toplevel`, `git -C <root> ls-tree origin/main`, `git cat-file blob`, `git log -S … origin/main` on the local clone's `origin/main` content, `config`; no `gh`, no `fetch`, no network; read-only. Its verdict feeds the Q1/Q1b answers (S3-14).
- `plugin/scripts/dispatch-prompt.mjs:240-246` `instruments.sh --repo <root>` — local; `instruments.sh:95` states "No network, no `gh`, no fetch" (config/host-local).
- `plugin/scripts/dispatch-prompt.mjs:194-228` `ticketFor` — reads `<scratch>/impl-<N>/issue.json` saved by the Pull for the ticket this ledger's `impl-<N>=PR#<pr>` names: own, host-local.
- `plugin/skills/run-team/SKILL.md:108-112` and `references/member-lifecycle.md:61` "Read `gh pr view`, `gh run view`, `git -C <worktree> status` before messaging" — per-object reads of the PR/run of a member this run dispatched: own.
- `plugin/skills/run-team/SKILL.md:521` `gh pr view <N> --json headRefName -q .headRefName` — per-object read of a PR the tick named (S3-4/S3-5); read only.
- `plugin/skills/run-team/SKILL.md:28` + `references/invariants.md:15-17` "when a label moves unexpectedly, ask members directly, rule out automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it" — reads host-local files and own members; but note it presumes every writer is one of this run's members (S3-21).
- `plugin/skills/run-team/SKILL.md:816` Member-unaccounted census: `read history://`, `read agent://<member>`, "PR head, worktree, labels" — per-object reads of own members' artifacts.
- `plugin/skills/run-team/SKILL.md:846-849` `verify-sha.sh <branch> <sha>` — per-object on a branch an own member reported; script is another slice.
- `plugin/skills/run-team/SKILL.md:837-838` `worktree-audit.sh` — host-local audit of local worktrees (script another slice); `references/failure-handling.md:37-42`.
- `plugin/skills/run-team/SKILL.md:257` `jq … <scratch>/pr<pr>/<run>/review.json` — host-local file read.
- `plugin/skills/run-team/SKILL.md:885-893` (A tooling defect): "report, never fix" — no GitHub write named.
- `plugin/skills/run-team/references/correction-tickets.md:33-34` — `gh pr view N --repo owner/repo`, `gh api repos/<owner>/<repo>` named as how to settle a citation to ANOTHER repository's evidence (a different repository, not another Instance's work in this one); no instruction to file a ticket exists in this file — it says what a correction ticket's implementer must check; the file holds no controller-filed-ticket instruction.
- `plugin/skills/run-team/references/failure-handling.md:44-67` `verify-sha.sh` text: same as the SKILL.md row above.
- `plugin/skills/run-team/references/tick-rows.md:7-9`, `:254-287` — descriptions of what the tick reads (covered by S3-1, S3-9, S3-14); `:107-251` hold rows and main-checkout/phase-0/liveness/report advice lines are host-local advice.
- `plugin/skills/run-team/references/member-lifecycle.md:146` "one `gh issue view` per ticket" — per-object read of the ticket the Pull claimed (own after claim).
- `plugin/skills/run-team/SKILL.md:40-72` phase 0 steps 0 (`phase0.mjs`, `NEED derive-recipe`, `NEED answer-label-map`) — Label map and Recipe are shared configuration (`config`); `label-map.mjs set --create` writes labels (a `gh label create`, config write; flagged for the owner of `label-map.mjs`).

## Files with no GitHub access
- `plugin/scripts/dispatch-prompt.mjs` (reads the ledger, saved issue files and instruments only; no gh, no network)
- `plugin/skills/run-team/references/invariants.md` (prose only; its only command, a local `grep -rn '<label>' .github/workflows/`)
- `plugin/skills/run-team/references/correction-tickets.md` (evidence prose; names `gh pr view --repo` / `gh api repos/…` only as a citation-qualifying example for another repository)
