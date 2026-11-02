# own-work-S2 — phase 0, resume, infra (snapshot origin/main 1a9692aa)

All paths relative to repo root, read from `origin/main` 1a9692aa.

Orientation: phase 0 (`plugin/scripts/phase0.mjs`) is the only place in this slice that selects GitHub work. Its two selecting steps are `fold-in` (every open PR → every PR authored by the gh login becomes an inherited ledger row) and `stranded` (every open `in-progress` issue → resume/report). Both judge repository-wide lists with no Instance identity; the only ownership test anywhere in the slice is the `gh api user` login (owned-pr.mjs:12-34) and, for resume, "a worktree of this clone under `.worktrees/`" (stranded.mjs:356-369). The `reclaim` step's `gh api graphql` is keyed by numbers read off this Instance's own scratch directory names. The sibling scratch pass (reclaim-scratch.mjs:495-515) has no gh call.

---

### S2-1 Fold-in lists every open PR in the repository
- Where: `plugin/scripts/phase0.mjs:412-414`, `plugin/scripts/phase0.mjs:415,422-423`
- Kind: read-select
- Does: `gh pr list --state open --json number,closingIssuesReferences,url,author,isDraft --limit 1000` with `env: { GH_REPO: "" }` (cwd's own remote). No `--author`, no `--label`, no `--head`. A list at the cap of 1000 (`PR_LIMIT`, phase0.mjs:192) fails the step (423).
- Scope today: repo-wide
- Feeds / Selected by: feeds the Owned-PR filter S2-2 (phase0.mjs:434-438) and the closing-issue extraction `ownClosingIssues(pr.number, pr.url, pr.closingIssuesReferences)` (phase0.mjs:444-450); transitively the inherited ledger rows S2-3 (phase0.mjs:471). / Selected by: nothing — phase 0's `fold-in` step (STEPS table phase0.mjs:552), run every run after `recipe` (phase0.mjs:549-553), skipped only when the resumed receipt already holds it `ok` (phase0.mjs:711-713, 720-722).
- Exists because: "it is reviewable work no member otherwise picks up, because the Shortlist holds ISSUES and nothing looks at inherited PRs" (phase-0.md:522-524); header phase0.mjs:86-91 ("every Owned PR … that no carried ledger row names gets a `#<pr>` row").
- Own-work limit: the list may stay repo-wide only if what is *adopted* from it is limited to PRs this Instance's own earlier runs opened; an unreadable owner (no mark, or a mark of another Instance) must stall — no row, no review. A listing that cannot be limited must not be followed by a row write.
- Mark: PR; nearest mark today: author login (plus `isDraft`); tells Instances apart under one gh user: no; under different gh users: yes.
- Notes: the 1000-PR cap refusal (phase0.mjs:423) means a repository carrying many Instances' PRs would stop every Instance's phase 0 ("none is folded in"). The head branch (`implementer/<N>-impl-<N>[-x]` per stranded.mjs:207-208) is returned by neither this query nor `--json` here (`headRefName` is not requested), so branch pattern is not even read by fold-in.

### S2-2 Owned-PR rule: ownership is the gh login, nothing else
- Where: `plugin/scripts/phase0.mjs:427-438`, `plugin/scripts/owned-pr.mjs:12-18,26-28,32-34`
- Kind: read-select
- Does: `gh api user -q .login` (GH_LOGIN_ARGS, owned-pr.mjs:12; run with `GH_REPO: ""` at phase0.mjs:427) then `prs.filter((pr) => isOwnedPr(pr, login))` where `isOwnedPr` = `pr?.author?.login === login && pr?.isDraft === false` (owned-pr.mjs:33). A null author is "no login of the run's, so not owned" (phase0.mjs:431-433); a row without `author`/`isDraft` fails the whole step (phase0.mjs:434-437).
- Scope today: login-wide
- Feeds / Selected by: feeds S2-3 (the `owned` set drives every `ledger.mjs row` write, phase0.mjs:438,464-474). / Selected by: S2-1's list. The same rule is "one rule for every reader" (owned-pr.mjs:1-9), so other readers outside this slice share it (not traced here).
- Exists because: "Which PRs are the fleet's to fold in is decided by the login the `gh` credentials answer to" (phase0.mjs:424-426); "every member acts through those credentials, so every PR the fleet opens carries it" (owned-pr.mjs:3-4); ADR 0034 per the lead's brief (not cited in this file).
- Own-work limit: must additionally tell this Instance's PRs from another Instance's PRs of the same login; where it cannot tell, the PR is not owned (stall, no row). A draft stays excluded.
- Mark: PR; nearest mark today: author login; tells Instances apart under one gh user: no; under different gh users: yes.
- Notes: this is the one explicit ownership test in the slice. Two clones/machines on one gh user: each Instance's phase 0 adopts the other's open PRs, including ones the other Instance opened minutes ago and has live members reviewing (the ledger that would show "already named by a carried row", phase0.mjs:456-461, is local `.fleet/ledger.md` — invisible to the other Instance).

### S2-3 Fold-in writes an inherited row per Owned PR — the gate to review, fix, label and merge
- Where: `plugin/scripts/phase0.mjs:464-474` (the write at 471), `plugin/scripts/phase0.mjs:451-461` (the dedupe against carried rows)
- Kind: write
- Does: `node ledger.mjs row <pr> "PR#<pr> · inherited (closes #N[, #M] | closes no issue)"` for every owned PR no carried row names. The write itself is to the local ledger (`.fleet/ledger.md`), but the row is what makes the tick queue the PR for review "exactly as ticket work: same review workflow, same fix-applier, same finisher" (phase-0.md:524-526).
- Scope today: no precondition (beyond "no carried local row names it", phase0.mjs:456-461)
- Feeds / Selected by: feeds the tick's reviewer units (`DISPATCH review PR#…`, `DISPATCH fix-pr PR#…`, plugin/scripts/fleet-tick.mjs:402-418 — slice-S3 code, cited only for the chain: "a run that inherited more than B PRs dispatches a unit for each", fleet-tick.mjs:404-405), and from there every GitHub write the review/fix/finisher/merge-bot members make on that PR (their entries belong to the slices that own those files). Also evict.mjs reads the row's `closes` list to decide which claim trees stay (evict.mjs:40-44,127). / Selected by: S2-2's `owned` set (phase0.mjs:438) ← S2-1.
- Exists because: "reviewing them next run is also what stops one pinning `fleet-tick`'s backlog forever" (phase-0.md:534-535); "Measured 2026-09-03 — a prior run's ticket PR arrived this way and its review found a defect" (phase-0.md:531-533).
- Own-work limit: only PRs this Instance's own runs opened (or whose ownership is proven some other way than the shared login); a PR of unknown ownership gets no row — stall. A row write replaces the whole line (phase0.mjs:456-457 comment), so the dedupe is the only guard against wiping live tokens on a carried row.
- Mark: ledger row (local, invisible to other Instances) for "already ours"; PR head branch / author login for the selection; tells Instances apart under one gh user: no; under different gh users: yes (author login only).
- Notes: `ownClosingIssues` (closing-refs.mjs) is imported at phase0.mjs:176 and decides which closing references count as this repository's; not traced (not in this slice's file list). The `closes` list is parsed from `closingIssuesReferences` (phase0.mjs:444-446).

### S2-4 Stranded-claim step lists every open `in-progress` issue in the repository
- Where: `plugin/scripts/stranded.mjs:318-320`, `plugin/scripts/stranded.mjs:113-127` (wrapper `ghList`), `plugin/scripts/stranded.mjs:300-306` (label string off the Label map)
- Kind: read-select
- Does: `gh issue list --label <in-progress string> --state open --json number,title,url,closedByPullRequestsReferences --limit 1000` with `GH_REPO: ""`. Skipped (`issues = []`) when `prior` is `ancestor` (stranded.mjs:313,318). A list at the cap exits 2 (stranded.mjs:125).
- Scope today: label-wide
- Feeds / Selected by: feeds the classification loop stranded.mjs:359-389 (→ S2-8 resume, S2-9 report) and the `live` set that excludes disk claims whose issue still holds the label (stranded.mjs:397-399). / Selected by: phase 0's `stranded` step (phase0.mjs:479-481), after fold-in; `prior` from the local controller record (stranded.mjs:311-312; `readState` → `controller.prior`, set by `ledger.mjs rotate`).
- Exists because: "a claim's label and worktree exist before its first push … a claim a dead run left without a PR is held by nobody until this step names it" (stranded.mjs:7-12).
- Own-work limit: the in-progress label says nothing about by whom; the read may stay label-wide only if each issue it returns is then judged "mine" by a mark that names this Instance (not the label), and "not mine / unknown" issues are neither resumed nor presented as stranded. Under `prior: dead` for *this checkout's* previous run only — a dead *other* Instance's run says nothing here.
- Mark: issue; nearest mark today: in-progress label (no owner part); tells Instances apart under one gh user: no; under different gh users: no (the label does not name a user).
- Notes: the "dead" verdict is `controller.prior` in local `.fleet/heartbeat.json` (stranded.mjs:14-33) — a statement about THIS checkout's previous controller only, yet it is applied to every in-progress issue of the repository (stranded.mjs:376). Another Instance's live claim is therefore judged under "prior: dead" simply because this Instance's own previous run died.

### S2-5 Stranded-claim step lists every open PR to decide which tickets "the fold-in owns"
- Where: `plugin/scripts/stranded.mjs:322-329` (lazy `open()`), `plugin/scripts/stranded.mjs:335-350` (`prsFor`), `plugin/scripts/stranded.mjs:361-365`, `plugin/scripts/stranded.mjs:412-416`
- Kind: read-select
- Does: `gh pr list --state open --json number,headRefName,url --limit 1000` (`GH_REPO: ""`); then, per ticket N: an issue counts as held when `closedByPullRequestsReferences` names an open PR of that list, or a linked PR lives in another repository ("whose state this repository's list cannot show, so it counts"), or an open PR's `headRefName` opens with the ticket number (`^([^/]*/)?N([-/]|$)`, stranded.mjs:343). A PR that carries the number elsewhere in its branch (`segment(N)`, stranded.mjs:100) is `mentioned`, which blocks `resume` and is named in `why`.
- Scope today: repo-wide
- Feeds / Selected by: feeds S2-8/S2-9 (`held` → the claim is dropped from the list with only a stderr log `#N has … — the fold-in owns it`, stranded.mjs:351,362-365; `mentioned` → `action` forced to `report`, stranded.mjs:384-386). / Selected by: S2-4's issue rows and the disk-claim loop (stranded.mjs:398-416).
- Exists because: "One with an open PR is not stranded: phase 0's fold-in queues every open PR, so it is never listed here" (stranded.mjs:10-12); "`implementer/1799-bump-node-20` names issue 1799 and merely ends in 20" (stranded.mjs:333-334).
- Own-work limit: PRs of any author are read; the conclusion "the fold-in owns it" is true only for a PR authored by this gh login (S2-2) and, once ownership is Instance-specific, only for this Instance's. A held PR that is not this Instance's own must be treated as "someone else's work: leave alone", not as "fold-in owns it".
- Mark: PR; nearest mark today: head branch name (`<type>/<n>-<slug>` — carries the ticket number and the member type, no Instance part) and closing reference; tells Instances apart under one gh user: no; under different gh users: no (this path does not read the author at all).
- Notes: this is a second, independent PR-to-ticket linkage rule (branch-prefix pattern + `closedByPullRequestsReferences`), with a different owner test (none) than the fold-in's (author login). Under different gh users another Instance's open PR is silently dropped here ("the fold-in owns it") while the fold-in itself does not own it (S2-2).

### S2-6 Stranded-claim step asks GitHub for every PR of a local claim's branch, all states
- Where: `plugin/scripts/stranded.mjs:134-151` (`closedHeadPr`), `plugin/scripts/stranded.mjs:374,378-379,384`
- Kind: read-select
- Does: `gh pr list --state all --head <branch> --json number,state --limit 1000` (`GH_REPO: ""`), run only when `prior === "dead"` and the matched worktree has a branch (stranded.mjs:374). `closed` is the highest PR number when every PR of that head is CLOSED unmerged; a failed/capped list is `failed`.
- Scope today: per-object from this checkout's own worktree branch (e.g. `implementer/<N>-impl-<N>[-x]`, CLAIM_BRANCH stranded.mjs:208) — but the result set is every PR of ANY author whose head ref carries that name.
- Feeds / Selected by: feeds `action` for that claim: `closed` → `report` with `why` `PR #<M> closed unmerged` (stranded.mjs:379,384; phase0.mjs:496); `failed` → `report`; empty/open → resume stays possible. / Selected by: the one worktree under this checkout's `.worktrees/` (`one`, stranded.mjs:366-369) of an in-progress issue S2-4.
- Exists because: "an unmerged close is the maintainer's to rule on" (stranded.mjs:23-25); closed-unmerged "never resume".
- Own-work limit: the query is by branch NAME, which has no Instance part; the PRs it returns must be limited to PRs this Instance's own claim opened (e.g. its own recorded PR number or an owner-bearing branch), or the verdict is "unknown → report/stall".
- Mark: branch/PR; nearest mark today: head branch name; tells Instances apart under one gh user: no; under different gh users: no (`--head` filters by ref only; author not read).
- Notes: two Instances' claims on branch names of the same shape (`implementer/12-impl-12`) in different clones read each other's PR history through this query. Unmerged-close of the other Instance's PR would be reported against this Instance's local branch.

### S2-7 Stranded-claim step: `gh issue view` and release dry run for each implementer claim found on the disk
- Where: `plugin/scripts/stranded.mjs:248-264` (`viewIssue`), `plugin/scripts/stranded.mjs:398-427`, `plugin/scripts/stranded.mjs:270-287` (`releaseDryRun`), `plugin/scripts/stranded.mjs:211-243` (`diskClaims`)
- Kind: read-select
- Does: for every implementer claim on THIS disk (worktree `.worktrees/<N>-impl-<N>[-x]` under this checkout, or a local branch `implementer/<N>-impl-<N>[-x]`) whose issue does not hold the label: `gh issue view <N> --json number,title,url,state,labels,closedByPullRequestsReferences` (`GH_REPO: ""`), then `prsFor` (S2-5) and `sh release-ticket.sh <N> <slug> implementer` WITHOUT `--apply` ("it reads and changes nothing", stranded.mjs:266-269). The dry run's own GitHub/remote reads — `git ls-remote --heads origin refs/heads/<branch>` (release-ticket.sh:885), `gh pr list --state all --head <branch> --limit 1000` (release-ticket.sh:1262), `gh issue view <N> --json labels` (release-ticket.sh:1312) — are keyed by the claim's own number/branch; their writes (`gh issue edit --remove-label` release-ticket.sh:1525, `git push origin --delete` release-ticket.sh:1509) are not reached without `--apply` (stranded.mjs:272 passes none).
- Scope today: per-object from local disk claims (`diskClaims`, the issue number and slug are parsed from this checkout's own worktree/branch names).
- Feeds / Selected by: feeds a `report` entry whose `why` is the dry run's blockers plus `WAYS_OUT` = "push the branch and open a PR, or release the claim by hand" (stranded.mjs:209,419-425; phase0.mjs:496). / Selected by: the disk (stranded.mjs:398) minus issues S2-4 returned as `live` (stranded.mjs:397-399).
- Exists because: "a bail that left commits behind cannot release its claim, and nothing else names it once the run that made it is gone" (stranded.mjs:38-43).
- Own-work limit: only this Instance's own disk claim (it is keyed by local names, so it already is) — but the issue read must not conclude "unlabelled, so its claim is free to release" for a ticket whose label another Instance holds / has removed and re-added.
- Mark: issue + local worktree/branch; nearest mark today: local worktree name (not on GitHub) and the `in-progress` label; tells Instances apart under one gh user: no for the label; the local worktree is own by construction; under different gh users: no.
- Notes: the dry-run script's internals (release-ticket.sh) belong to another slice; cited only to show which remote/GitHub reads the dry run performs.

### S2-8 Stranded-claim `resume` verdict: controller dispatches a new implementer onto an `in-progress` ticket
- Where: `plugin/scripts/stranded.mjs:384` (`action = … "resume"`), `plugin/scripts/stranded.mjs:356-369` (the worktree-under-`.worktrees/` test), `plugin/scripts/phase0.mjs:495-499` (`NEED resume #<n> <worktree> <branch>`), `plugin/scripts/phase0.mjs:500-502`
- Kind: write
- Does: `action = "resume"` iff `prior === "dead"` && exactly one non-prunable worktree whose directory name carries the ticket number as a whole segment sits directly under this checkout's `.worktrees/` && that worktree has a branch && no `mentioned` PR && no closed-unmerged / unanswered `--head` list. phase 0 turns it into `NEED resume #<n> <worktree> <branch>` (unless a ledger row `#<n>` already exists, phase0.mjs:497) and stops the run `pending` (exit 4) so the controller dispatches a member (`impl-<N>-b`) into that worktree/branch (phase-0.md:601-612). That member's later pushes / PR creation / label work land on the ticket. No claim-ticket.sh call: "the claim already stands" (phase-0.md:611-612).
- Scope today: no precondition on the ticket's label holder — the only gate is "one worktree of this clone under `.worktrees/`", which proves a local claim once existed here, not that the issue's current `in-progress` label is still this Instance's.
- Feeds / Selected by: feeds the controller's dispatch of the resumed member (SKILL.md:73-77, outside this slice; phase-0.md:601-612) and its eventual push/PR/review chain. / Selected by: S2-4 (issue), S2-5 (no open PR / `mentioned`), S2-6 (closed-unmerged), local `git worktree list --porcelain -z` (stranded.mjs:155-177, 357).
- Exists because: "a claim a dead run left without a PR is held by nobody until this step names it" (stranded.mjs:9-12); resume instead of release because the branch may hold commits.
- Own-work limit: only targets this Instance's own claim — i.e. a ticket whose `in-progress` mark names this Instance. Where ownership of the label is unknown (no Instance in the label), it must stall (report, no dispatch). Today the only own-test is the local worktree.
- Mark: issue (the claim); nearest mark today: in-progress label + local worktree directory name + local `implementer/<N>-…` branch; tells Instances apart under one gh user: no (label is anonymous; the local worktree is invisible to others); under different gh users: no.
- Notes: [INFERENCE] a collision path exists: Instance A keeps a stale `.worktrees/<N>-impl-<N>` from an earlier dead run; the maintainer releases #N by hand (as stranded.mjs:209,423 advises) and Instance B re-claims #N; A's next phase 0 (prior `dead`) reads B's fresh `in-progress` label, finds no open PR yet, finds its own stale worktree, and returns `resume` — nothing in the code compares who applied the label. Not run, derived from stranded.mjs:359-389.

### S2-9 Stranded-claim `report` lines surface other Instances' live claims as "stranded"
- Where: `plugin/scripts/stranded.mjs:376-388`, `plugin/scripts/stranded.mjs:381-383`, `plugin/scripts/phase0.mjs:496`, `plugin/scripts/phase0.mjs:501`
- Kind: read-inform
- Does: every open `in-progress` issue with no open PR and no matching worktree here becomes `{n, t, action: "report", why: "no worktree for it in this checkout"}` (stranded.mjs:383,387) and a `report #<n> — <why>` line in phase 0's output and in the receipt (phase0.mjs:496,730). Under `prior: none`: "no record proves the previous run dead, so nothing is resumed" (stranded.mjs:376) — every in-progress claim reported. `outside`: "its worktree is outside this checkout's .worktrees/: <paths>" (stranded.mjs:382) names worktrees of a linked checkout elsewhere on this host.
- Scope today: label-wide
- Feeds / Selected by: feeds the controller's report to the maintainer `#<N> — <why>` "and nothing else: no dispatch, no label change, no release" (phase-0.md:613-615), plus the `WAYS_OUT` advice "release the claim by hand" on the disk-claim form (stranded.mjs:209). / Selected by: S2-4.
- Exists because: "`none` — nothing proves the previous run dead: every in-progress claim `report`" (stranded.mjs:32-33); a stranded claim must be visible to the maintainer, because the candidate scan excludes `in-progress` (fleet-state.mjs:583-586).
- Own-work limit: "own work only, everywhere … and the dashboard": report only this Instance's own claims; other Instances' in-progress tickets must not be listed as stranded, nor have release suggested.
- Mark: issue; nearest mark today: in-progress label; tells Instances apart under one gh user: no; under different gh users: no.
- Notes: `report` acts on nothing in code, but the receipt (`.fleet/phase0.json`) records it and the controller relays it to the maintainer verbatim; a maintainer acting on `release #<N>` (the tick's `ESCALATE pr-closed` line, phase-0.md:615-617) would release another Instance's live claim.

### S2-10 Phase 0's `shortlist` step: repository-wide, label-wide candidate scan
- Where: `plugin/scripts/phase0.mjs:505-509`
- Kind: read-select
- Does: `node shortlist.mjs` — per phase-0.md:625-641 `candidates.mjs --require-label ready-for-agent --with-dropped` (oldest-first), a dependency scan (shortlist.mjs:19-25 uses `gh issue view <N> --json state`), Exclusion premise probes (`gh pr view M` / `gh issue view M`, shortlist.mjs:23-25,231), then `inflight.sh <N>` per survivor. The scripts' internals belong to the slices that own shortlist.mjs / candidates.mjs / inflight.sh; this entry records only phase 0's call.
- Scope today: label-wide (the candidate scan); per-object from candidate rows (the probes).
- Feeds / Selected by: feeds `.fleet/shortlist.json` that every Pull claims from (phase-0.md:643-646; Pull → claim-ticket.sh, slice-S1 code). / Selected by: runs last, after `stranded` is `ok` ("the shortlist waits for the stranded claims", phase0.mjs:150-153).
- Exists because: the supply of tickets for Pulls; "the script runs the cheap filters and nothing else" (phase-0.md:625-628).
- Own-work limit: reading the pool of unclaimed tickets is shared by definition; what must be limited is that an in-flight ticket held by another Instance reads as "taken" (stall), not "free" — inflight.sh's rule, not this file's.
- Mark: issue; nearest mark today: in-progress label (excluded by the scan) + open PR linkage (inflight check); tells Instances apart under one gh user: no; under different gh users: no.
- Notes: `phase0.mjs` only runs the child; it passes no scoping argument.

### S2-11 Phase 0 launches the cockpit board, a read-only mirror of `.fleet/ledger.md` + gh
- Where: `plugin/scripts/phase0.mjs:317-329`
- Kind: read-inform
- Does: `spawn(node board.mjs serve --open [--spend-dir <dir>])`, `detached: true, stdio: "ignore"`, recorded, never fails the run. The board's own gh queries are in board.mjs/board-gather.mjs (not in this slice).
- Scope today: [INFERENCE] repo-wide, per phase-0.md:257 "a read-only mirror of `.fleet/ledger.md` + `gh`".
- Feeds / Selected by: feeds the maintainer's dashboard only (acts on nothing). / Selected by: phase 0's `cockpit` step (phase0.mjs:551).
- Exists because: "Launch the cockpit. On every phase-0 pass" (phase-0.md:255).
- Own-work limit: the board must show only this Instance's own claims/PRs/reviews (the contract's "dashboard"), however many other Instances share the repository.
- Mark: issue/PR; nearest mark today: none for the board (mirrors ledger + gh); tells Instances apart: see the slice that owns board.mjs.
- Notes: the board is per-workspace (one port derived per workspace, phase-0.md:264-269): "A second fleet on another workspace collides with none of that" — a host-local statement, not a GitHub one.

### S2-12 Reclaim step asks GitHub for the state of the PR/issue number named by each scratch entry
- Where: `plugin/scripts/reclaim-scratch.mjs:318-329` (`githubStates`), `plugin/scripts/reclaim-scratch.mjs:406`, `plugin/scripts/reclaim-scratch.mjs:408-466`, `plugin/scripts/gh-aliased-read.mjs:19-22,56-104` (the `gh api graphql` wrapper), `plugin/scripts/phase0.mjs:355-364` (the two call sites; the first with `--root <scratch> --after-rotate --apply`, the second `--siblings`)
- Kind: read-inform
- Does: `gh api graphql -F owner={owner} -F name={repo}` with one aliased `issueOrPullRequest(number:N){__typename ... on Issue{state} ... on PullRequest{state}}` per number, ≤100 per call, for every `pr<M>/`, `impl-<N>/`, `reports/<member>.json`, `dispositions-fix-pr-<M>.json` entry under THIS workspace's scratch root. The verdict only decides local removal (`removeEntry` → `sh -c rm -rf`, reclaim-scratch.mjs:199-201,622): a MERGED/CLOSED PR or CLOSED issue with no live ledger token → remove; OPEN → keep; `impl-<N>` OPEN with no live token, no claim worktree here, idle > 7 days → remove.
- Scope today: per-object from local scratch entry names (numbers this Instance's own members created partitions for).
- Feeds / Selected by: feeds only local deletes; no GitHub write. / Selected by: the scratch directory listing (reclaim-scratch.mjs:388-405) and the scratch root being the workspace's own (reclaim-scratch.mjs:557-566).
- Exists because: "Reclaim authorizes on GitHub state and on age" (reclaim-scratch.mjs:5-6); a keyed entry "is never judged by the ledger or by mtime alone in GitHub's place" (reclaim-scratch.mjs:86-87).
- Own-work limit: none beyond what it already is — keyed by this Instance's own scratch names and own ledger; the only work-sharing seam is an Instance whose merged/closed PR was a PR it also reviews (fine: removal of its own scratch).
- Mark: n/a (local deletes only).
- Notes: the SIBLING pass (`--siblings`, reclaim-scratch.mjs:495-515, 548-551, 581-590) has NO gh call: it judges "every key-shaped directory directly under the scratch parent … by age alone" (reclaim-scratch.mjs:489-494, `SCRATCH_KEY_SHAPE` fleet-dir.mjs:170) and removes other workspaces' scratch keys after 7 idle days, re-judging each just before removing (reclaim-scratch.mjs:614-619). A second clone on the same machine has a different key (`<basename>-<sha256(dir)[:8]>`, fleet-dir.mjs:157-162), so two Instances on one host sweep each other's scratch by age alone. Host-local, no GitHub write — recorded because it is the only cross-Instance delete in this slice.

---

## Prompt-surface entries (`.md` under `skills/`)

### S2-13 phase-0.md instructs the controller to fold every Owned PR a prior run left open
- Where: `plugin/skills/run-team/references/phase-0.md:513-535`
- Kind: instruction-read
- Does: "Fold in every Owned PR a prior run left open, before shortlisting … an open PR, not a draft, whose author is the login `gh api user` answers to … Queue each for review exactly as ticket work: same review workflow, same fix-applier, same finisher." The row `#<pr>` / `PR#<pr> · inherited (closes #…)`. "Skip a PR a row rotate carried already holds" (phase-0.md:528-531).
- Scope today: login-wide
- Feeds / Selected by: feeds the review → fix → finisher → merge chain on every PR the fold-in lists (see S2-1..S2-3). / Selected by: phase0.mjs step `fold-in`.
- Exists because: see S2-1 (phase-0.md:522-524, 531-535).
- Own-work limit: the instruction must say "your own PRs", not "every PR of the gh login".
- Mark: PR; nearest mark today: author login; one gh user: no; different gh users: yes.
- Notes: "However an Owned PR is named and whatever it carries … no PR is exempt from being wrong" (phase-0.md:520-535) — the prose explicitly forbids filtering by ticket or content.

### S2-14 phase-0.md instructs the controller to read repo-wide `in-progress` claims and PR state
- Where: `plugin/skills/run-team/references/phase-0.md:545-558`, `plugin/skills/run-team/references/phase-0.md:580-599`
- Kind: instruction-read
- Does: `~/.fleet/bin/fleet-run stranded.mjs` "lists and classifies; you dispatch"; for `prior: dead`: "every open `in-progress` issue with no open PR … `resume` when exactly one worktree for it sits under this checkout's `.worktrees/`", with `gh pr list --state all --head <branch>` (phase-0.md:554); for any `prior`, every implementer claim on the disk whose issue is open with no label and no open PR is a `report`.
- Scope today: label-wide; per-object from disk claims.
- Feeds / Selected by: feeds S2-15. / Selected by: phase0.mjs step `stranded`.
- Exists because: see S2-4.
- Own-work limit: as S2-4/S2-8.
- Mark: issue; nearest mark today: in-progress label + local worktree; one gh user: no; different gh users: no.
- Notes: none.

### S2-15 phase-0.md instructs the controller to dispatch resume members and relay `release`/`replace`
- Where: `plugin/skills/run-team/references/phase-0.md:601-621`, `plugin/skills/run-team/references/phase-0.md:559-579` (carried tokens)
- Kind: instruction-write
- Does: "A `resume` follows the Member-killed row across the run boundary: a new member under a new name — `impl-<N>-b` … on the same ticket, in the printed worktree and branch … never `claim-ticket.sh`: the claim already stands." A `report` goes to the maintainer "as `#<N> — <why>` and nothing else: no dispatch, no label change, no release"; "One whose `why` reads `PR #<M> closed unmerged` waits on the maintainer's `replace #<N>` or `release #<N>`". The `ancestor` branch instructs the controller to `ledger.mjs settle <name> killed` / `ledger.mjs review <pr> review=member:<name>=failed` (local ledger writes).
- Scope today: no precondition (on who holds the label).
- Feeds / Selected by: feeds the dispatched member's GitHub writes. / Selected by: S2-8 output.
- Exists because: see S2-8; resume rather than re-claim preserves commits.
- Own-work limit: only this Instance's own stranded claim; unknown ownership → report, never dispatch.
- Mark: issue; nearest mark today: in-progress label; one gh user: no; different gh users: no.
- Notes: `replace #<N>` / `release #<N>` are maintainer words mapped by the tick (references/tick-rows.md, other slice).

### S2-16 phase-0.md instructs the controller to build the Shortlist from a repo-wide label scan
- Where: `plugin/skills/run-team/references/phase-0.md:625-641`, `plugin/skills/run-team/references/phase-0.md:659-662`
- Kind: instruction-read
- Does: `~/.fleet/bin/fleet-run shortlist.mjs` — "Candidate scan — `candidates.mjs --require-label ready-for-agent --with-dropped`", "Dependency scan", "Live Exclusions", "In-flight check — `inflight.sh <N>` per survivor" (phase-0.md:630-641). "`--require-label ready-for-agent` mandatory, no fallback" (phase-0.md:659-662).
- Scope today: label-wide; per-object from rows.
- Feeds / Selected by: feeds Pulls (phase 1). / Selected by: phase0.mjs step `shortlist`.
- Exists because: "The script runs the cheap filters and nothing else" (phase-0.md:625-628).
- Own-work limit: as S2-10.
- Mark: issue; nearest mark today: label (`ready-for-agent`/`in-progress`) + open-PR linkage; one gh user: no; different gh users: no.
- Notes: "Every probe fails CLOSED: … an unanswered in-flight check counts as taken" (phase-0.md:653-657) is the stall-never-collide stance already present, for the in-flight probe.

### S2-17 phase-0.md instructs the controller to launch the cockpit board
- Where: `plugin/skills/run-team/references/phase-0.md:255-269`
- Kind: instruction-read
- Does: "`node ~/.fleet/bin/fleet-run board.mjs serve --open &` … a read-only mirror of `.fleet/ledger.md` + `gh`".
- Scope today: [INFERENCE] repo-wide (the gh half of the mirror).
- Feeds / Selected by: dashboard only. / Selected by: phase0.mjs step `cockpit`.
- Exists because: maintainer visibility.
- Own-work limit: as S2-11.
- Mark: see S2-11.
- Notes: none.

### S2-18 phase-0.md instructs the controller to create tracker labels the Label map needs
- Where: `plugin/skills/run-team/references/phase-0.md:166-179`, `plugin/skills/run-team/references/phase-0.md:120-122`
- Kind: instruction-write
- Does: `~/.fleet/bin/fleet-run label-map.mjs set --create` with `--accept-suggestions` or `<role>=<label>`; "labels that do not exist are created on your confirmation" (phase-0.md:163-164). Underlying call: `gh label create <string>` with "already exists" counted as existing (label-map.mjs:64-66,644-646,707-716 — another slice's file, cited only for the call). The `ensure` step run by phase 0 "reads the cached map, the repository's triage-label table and the tracker's live label list … and never creates a label" (phase-0.md:120-122).
- Scope today: repo-wide config (the tracker's label namespace is shared by every Instance of the repository)
- Feeds / Selected by: feeds every later label write (Label map strings). / Selected by: phase0.mjs step `labels` exit 3 → `NEED answer-label-map` (phase0.mjs:266-282).
- Exists because: a role's string must exist before a claim can apply it.
- Own-work limit: none needed for the read; the create is a shared-config write that is idempotent on "already exists" (label-map.mjs:644-646), so two Instances creating the same label does not collide.
- Mark: label; n/a (config).
- Notes: the Label map cache is `.fleet/labels.json`, local per checkout (phase-0.md:116); two Instances can hold different maps for the same repository.

### S2-19 instruments.md instructs the controller to file a tooling defect with `gh issue create`
- Where: `plugin/skills/run-team/references/instruments.md:76-88`
- Kind: instruction-write
- Does: "`ledger.mjs check "<subject>"`, then `gh issue create --label "<needs-triage string>"` … then `ledger.mjs filed <N> "<subject>"`. A tracker hit is handled the way step 5 handles one." Applies only when "this main checkout's `origin` is the repository that `repository.url` in the Install root's `package.json` names". The check is a tracker search (ledger.mjs, other slice).
- Scope today: no precondition (the `check` is a search; two Instances can file the same defect — [INFERENCE] nothing on GitHub deduplicates across Instances)
- Feeds / Selected by: feeds a new issue (not existing work). / Selected by: a tooling-defect trigger the controller observes in its own run (instruments.md:47-65).
- Exists because: "Report it during the run — deferring loses the evidence" (instruments.md:49-50).
- Own-work limit: creates a new object, so it targets no one's existing work; the search before it is a repository-wide tracker read.
- Mark: issue (new); nearest mark today: none; one gh user: n/a; different gh users: n/a.
- Notes: the same file's pointers at instruments.md:25-30 (finisher labels, merge bot merges) name where other slices' instructions live; they carry no command.

### S2-20 shell-traps.md templates a loop over a repository PR list handed to ci-state.mjs
- Where: `plugin/skills/run-team/references/shell-traps.md:24-30`, `plugin/skills/run-team/references/shell-traps.md:63-67`
- Kind: instruction-read
- Does: the "capture-then-loop" snippet `while IFS= read -r pr; do … node …/ci-state.mjs --pr "$pr" </dev/null; done <<EOF $prs EOF` and the table row `prs=$(gh pr list …)` then `for pr in $prs`. The source of `$prs` is not specified in this file; the file says it is "prescriptive — copied verbatim into a watcher or into the merge bot's agent body" (shell-traps.md:5-14).
- Scope today: [INFERENCE] repo-wide / label-wide, depending on the watcher/merge-bot text it is copied into (outside this slice: references/ci-watcher.md, agents/fleet-merge-bot.agent.md).
- Feeds / Selected by: feeds `ci-state.mjs --pr <n>` (a per-PR read) in the copied watcher. / Selected by: the watcher/bot prompt that defines `$prs`.
- Exists because: zsh vs bash word-splitting, "a probe that could not look emits an event; it never `continue`s" (shell-traps.md:36-41).
- Own-work limit: whatever the copying document selects must be limited to this Instance's own PRs; this file only provides the loop.
- Mark: PR; nearest mark today: none stated here; see the owning slice.
- Notes: the file itself selects nothing; recorded because the `gh pr list …` in its table is the shape the merge bot is told to loop over.

---

## Checked, own-only or config
- `plugin/scripts/phase0.mjs:233-238` — `git symbolic-ref -q HEAD`: local HEAD of this checkout (host-local).
- `plugin/scripts/phase0.mjs:241-249` — `git fetch origin` then `rev-list --count main..origin/main` and `merge --ff-only origin/main`: config / `origin/main` content; the fetch refreshes every `refs/remotes/origin/*` ref but this file reads only `origin/main` afterwards; the merge is a local fast-forward, no push.
- `plugin/scripts/phase0.mjs:252-258` — `instruments.sh --pin`: local package digest (config).
- `plugin/scripts/phase0.mjs:260-264`, `plugin/scripts/main-checkout.mjs:304-307,330-345,507-508` — baseline reads `refs/remotes/origin/main` only: `origin/main` content (config).
- `plugin/scripts/phase0.mjs:266-282` — `label-map.mjs ensure`: tracker label list read (config); ensure "never creates a label" (phase-0.md:121-122); creation is S2-18.
- `plugin/scripts/phase0.mjs:284-295`, `plugin/scripts/preflight.mjs:66,70,75-76` — `gh --version`, `gh auth status`, `gh api repos/{owner}/{repo} --jq .allow_merge_commit`, `gh api repos/{owner}/{repo}/rulesets --jq .[].name`: repo settings / credentials (config).
- `plugin/scripts/phase0.mjs:297-303` — `bash .github/scripts/apply-ruleset.sh --check`: ruleset spec vs live gate (config, read-only; "reconciling is a write … the maintainer's", phase0.mjs:57-58).
- `plugin/scripts/phase0.mjs:305-315` — `tier-roles.mjs --check`, `metrics-refresh.mjs`: local tier table/metrics TSVs (no gh call in these files was read; grep of those two files for gh calls found none).
- `plugin/scripts/phase0.mjs:331-353` — `ledger.mjs rotate`: local ledger/receipt/controller record (host-local).
- `plugin/scripts/phase0.mjs:366-372`, `plugin/scripts/evict.mjs:18` — `evict.mjs --after-rotate --apply`: local claim trees only; "nothing here calls `gh`" (evict.mjs:18); git calls are `-C <tree>` status/reflog/ls-files and `git worktree list` (evict.mjs:123-244,265,309-311,416-434), `derive-testcmd.sh <tree> install --at origin/main` (evict.mjs:409).
- `plugin/scripts/phase0.mjs:388-393` — `readRecipe(cwd)`: `derive-testcmd.sh . install|check|test --at origin/main` — `origin/main` content (config).
- `plugin/scripts/phase0.mjs:395-407,451-461` — `ledger.mjs read`: local ledger parse (host-local).
- `plugin/scripts/phase0.mjs:515-547` — alarm step: reads `~/.fleet/alarm/<pid>.json` and the process table (host-local).
- `plugin/scripts/phase0.mjs:556-751` — receipt read/write, session, scratch root: `.fleet/phase0.json`, `phase0.previous.json`; none gates a GitHub write directly. The "a linked worktree cannot host a run" check at phase0.mjs:646-649 (`git rev-parse --show-toplevel` must equal the main checkout root) is host-local and gates every GitHub call in the step list because phase 0 refuses to run from a linked worktree; it does not distinguish Instances (one clone = one Instance).
- `plugin/scripts/stranded.mjs:155-177,213-218,356-357` — `git worktree list --porcelain -z` and `git for-each-ref refs/heads/implementer/`: this clone's local worktrees and branches (host-local, own by construction).
- `plugin/scripts/stranded.mjs:431-448` — `ledger.mjs --file … read`: local (host-local).
- `plugin/scripts/reclaim-scratch.mjs:199-201,203-239,278-311` — removal sequence, ledger read, `git worktree list` claim-worktree test: local.
- `plugin/scripts/reclaim-scratch.mjs:495-524` — sibling pass (age only, no gh): see S2-12 Notes.
- `plugin/scripts/reclaim-scratch.mjs:526-630` — argument handling, root-must-be-own-scratch guard (557-566): local.
- `plugin/scripts/gh-aliased-read.mjs:56-104` — the GraphQL wrapper; sole other-slice user not traced here (cited in S2-12); call-site scoping is `GH_REPO: ""` so the cwd's own repository is read.
- `plugin/scripts/net.sh:1-414` — library of bounded git network wrappers (`net_git`, `net_fetch_budget`); no call sites in this file; "`gh` calls are deliberately NOT routed through this" (net.sh:30-33). Callers (e.g. `git ls-remote`, `git push`) are in release-ticket.sh/reap.sh and are inventoried by the slices owning them.
- `plugin/scripts/fleet-state.mjs:488-492,594-624` — comments only: "the tick runs a gh query for the claimed count" (fleet-state.mjs:489, 594-596) — the gh query itself is in the tick (slice S3); fleet-state.mjs has no gh call. `stallReport` (fleet-state.mjs:599-624) formats a `claimed` count it is handed: informing text, "N ticket(s) claimed and in flight" (fleet-state.mjs:623), whose scope is decided by the caller. It also states "the next run resumes its claims without a PR, and its open PRs return through the fold-in" (fleet-state.mjs:615-617), describing S2-3/S2-8.
- `plugin/scripts/fleet-heartbeat.mjs`, `plugin/scripts/controller-alarm.mjs`, `plugin/scripts/pid-lock.mjs` — heartbeat/alarm marks, pid locks in local `.fleet/` and `~/.fleet/alarm/`: host-local, no GitHub.
- `plugin/scripts/member-write-guard.mjs:99,257-258` — refuses member writes under the main checkout (local `git` only): host-local.
- `plugin/scripts/fleet-dir.mjs:82-84,203-219`, `plugin/scripts/git-env.mjs`, `plugin/scripts/repo-root.mjs`, `plugin/scripts/scratch-root.mjs` — workspace/scratch path resolution via `git rev-parse --git-common-dir`/`--show-toplevel`/`check-ignore`: host-local; the scratch key is `<basename>-<sha256(workspace dir)[:8]>` (fleet-dir.mjs:157-162), per clone.
- `plugin/scripts/evict-mark.mjs:42` — `git rev-parse --absolute-git-dir`: local.
- `plugin/scripts/suite-slot.mjs:109` — runs a local test entrypoint through `sh -c`: local.
- `plugin/scripts/instruments.sh` — "No network, no `gh`, no fetch" (instruments.sh:95-96): local digest of the Install root.
- `plugin/scripts/fleet-run`, `plugin/scripts/fleet-bootstrap`, `plugin/scripts/fleet-provenance` — Install-root resolver / bootstrap / provenance: local files only (greps for fetch, ls-remote, push, gh, curl, http, github found none).
- `plugin/skills/run-team/references/phase-0.md:45-63` — fast-forward instruction: `git fetch origin && git rev-list --count main..origin/main; git merge --ff-only origin/main` (config; local fast-forward).
- `plugin/skills/run-team/references/phase-0.md:199-224` — ruleset check instruction: `.github/scripts/apply-ruleset.sh --check` (config; "3 does not stop the run and is not yours to fix").
- `plugin/skills/run-team/references/phase-0.md:457-458` — "`origin/main` does not resolve … fetch it and check again": `git fetch` of `origin/main` (config).
- `plugin/skills/run-team/references/phase-0.md:499-501` — "release that claim with `release-ticket.sh` first" after an Install-step refusal: acts on this run's own just-made claim (per-object from own claim).
- `plugin/skills/run-team/references/phase-0.md:226-251` — metrics drain / cost guard: local TSVs and `.fleet/` files.
- `plugin/skills/run-team/references/phase-0.md:294-390,391-442` — rotate / reclaim / evict instructions: local ledger/scratch/trees; reclaim's `gh` use is S2-12.
- `plugin/skills/run-team/references/phase-0.md:444-511` — Recipe derivation: `origin/main` content and a throwaway worktree of `origin/main` (config).
- `plugin/skills/run-team/references/instruments.md:1-75,89-113` — instrument re-check rationale; no command touches GitHub apart from S2-19.

## Files with no GitHub access
- `plugin/scripts/phase0-receipt.mjs`
- `plugin/scripts/fleet-state.mjs` (comments name a gh query run by the tick; the file has none)
- `plugin/scripts/main-checkout.mjs` (reads only `refs/remotes/origin/main`)
- `plugin/scripts/repo-root.mjs`
- `plugin/scripts/fleet-heartbeat.mjs`
- `plugin/scripts/controller-alarm.mjs`
- `plugin/scripts/pid-lock.mjs`
- `plugin/scripts/fleet-bootstrap`
- `plugin/scripts/fleet-run`
- `plugin/scripts/fleet-provenance`
- `plugin/scripts/instruments.sh`
- `plugin/scripts/is-cli.mjs`
- `plugin/scripts/proc.mjs`
- `plugin/scripts/git-env.mjs`
- `plugin/scripts/json.sh`
- `plugin/scripts/net.sh` (library of bounded git wrappers; no call sites)
- `plugin/scripts/arg.mjs` (argument validators; comments mention `gh pr view` as the reason numeric args are checked)
- `plugin/scripts/member-write-guard.mjs`
- `plugin/scripts/suite-slot.mjs`
- `plugin/scripts/fleet-dir.mjs`
- `plugin/scripts/scratch-root.mjs`
- `plugin/scripts/evict.mjs`
- `plugin/scripts/evict-mark.mjs`
- `plugin/.claude-plugin/plugin.json` (grep for gh/github/issues/pull: no match)
- `plugin/package.json` (only `repository.url` `git+https://github.com/feigi/fleet-plugin.git`, package.json:8 — metadata the controller compares to `origin` in S2-19; no access)
- `plugin/LICENSE` (license text)
- `plugin/NOTICE` (attribution text naming github.com/anthropics/claude-plugins-official, NOTICE:9; no access)

(`references/instruments.md` and `references/shell-traps.md` appear above as S2-19 and S2-20 and in the Checked list; they hold no other GitHub path.)
