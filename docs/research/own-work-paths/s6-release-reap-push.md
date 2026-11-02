# S6 — release, reap, worktrees, pushes

Snapshot: `origin/main` 1a9692aa. All paths relative to the repo root.

What decides, today, that a claim released by `release-ticket.sh` is this Instance's: nothing on GitHub. The script takes `<issue> <slug> <type>` from its caller (`plugin/scripts/release-ticket.sh:219-222`), builds `branch="$type/$issue-$slug"` (`:236`) and treats it as own when (a) a LOCAL branch of that name exists in this clone (`:992-1002`, "Never dispatched" shape: ahead 0, no unique commit) or (b) the branch is on origin and every PR whose head is that name reads CLOSED (`:1250-1280`, "Closed unmerged" shape; no local branch needed, `:948-951`). Neither names an Instance; the name carries ticket and kind only. The controller's caller-side choice of the arguments comes from outside this slice (cited: `plugin/skills/run-team/SKILL.md:817`, `plugin/skills/run-team/references/tick-rows.md:87`).

What decides that reap's branches are this Instance's: reap iterates only the LOCAL `refs/heads` of the clone it runs in (`plugin/scripts/reap.sh:1049`), so the candidate set is bounded to this clone; GitHub state decides only WHETHER a local branch is accounted for (a remote deletion by anyone, plus a merged PR matched by head branch name alone).

### S6-1 release: is the claim branch pushed? (`ls-remote` by claim branch name)
- Where: `plugin/scripts/release-ticket.sh:883-907` (first read), `:1500-1503` (re-read before the remote delete), `:1511-1518` (read-back after a failed delete); wrapper `net_git` at `plugin/scripts/net.sh:335`
- Kind: read-select
- Does: `net_git "" "$ls_budget" ls-remote --heads origin "refs/heads/$branch"`; `$remote` non-empty = "pushed"; `$remote_sha` = the tip origin holds (`:902-907`)
- Scope today: per-object from the caller's `<issue> <slug> <type>` arguments (`:219-236`) — the name has no Instance part, so the answer is "somebody pushed this name", not "this Instance did"
- Feeds / Selected by: picks release mode: empty → never-dispatched mode (`:996-1002`); non-empty → blocks unless closed-PR mode (`:1252-1280`); sets `$remote_sha` for the local-tip equality check (`:991-995`) and the CAS-like re-read (`:1502-1503`); gates the remote delete (S6-4) / Selected by: the caller's arguments
- Exists because: "A pushed branch — work that survives the local delete and that a PR may already point at. Live query, so this one cannot be stale; a failure here is an unknown answer, never a 'no'." (`:871-873`)
- Own-work limit: read only the branch name this Instance's own claim created and recorded; a pushed branch of that name whose commits this Instance did not push must read as "not mine → stall" (nothing released)
- Mark: branch; nearest mark today: head branch name (`<type>/<issue>-<slug>`, no Instance part); tells Instances apart under one gh user: no; under different gh users: no (a branch has no pusher field in this read — `ls-remote` answers a sha only)
- Notes: failure or stall of the read is `die` (exit 2), never "not pushed" (`:886-894`); `FLEET_NET_TIMEOUT` shortens it (`:883`).

### S6-2 release: PRs that name the claim branch (`gh pr list --state all --head`)
- Where: `plugin/scripts/release-ticket.sh:1262-1264` (decision loop `:1266-1279`)
- Kind: read-select
- Does: `gh pr list --state all --head "$branch" --limit 1000 --json number,state,isCrossRepository --jq '.[] | select(.isCrossRepository | not) | "\(.number):\(.state)"'` — no `--repo`, no `--author`
- Scope today: per-object from the caller's branch name; PRs of ANY author in the repository whose same-repo head is that name (fork PRs are dropped, `:1257-1261`)
- Feeds / Selected by: `closed_pr=true` only when at least one PR and all read CLOSED (`:1273-1279`) → authorizes the remote branch delete (S6-4) and the label drop (S6-5) / Selected by: the pushed-branch read S6-1 (`:1254`) — only runs when `$remote` is non-empty and no earlier blocker (`:1252-1254`)
- Exists because: "The one pushed branch that releases: every PR of this repository whose head is $branch reads CLOSED, and there is at least one." (`:1240-1241`); `--limit 1000` because "gh's default page of 30 would hide a later OPEN PR" (`:1256`)
- Own-work limit: act only when the closed PR(s) are this Instance's Owned PR(s) (opened from this Instance's own branch); a CLOSED PR by another author/Instance under the same head name must stall, not release
- Mark: PR; nearest mark today: head branch name (and author login, which the script does not read); tells Instances apart under one gh user: no; under different gh users: yes only if author login were compared — it is not read here (`--json number,state,isCrossRepository`)
- Notes: states read: OPEN/MERGED block (`:1268-1276`); no PR at all blocks (`:1273-1274`); a failed read is `die` (`:1264`). Uses gh's own repo resolution from cwd (no `--repo`); reap's GraphQL lookup, by contrast, passes `--hostname` and owner/name from `remote.origin.url` (S6-7).

### S6-3 release: labels of the ticket (`gh issue view --json labels`)
- Where: `plugin/scripts/release-ticket.sh:1311-1314` (scan `:1326-1331`)
- Kind: read-select
- Does: `gh issue view "$issue" --json labels --jq '.labels[].name'`, then `grep -qxF -- "$in_progress"` (the string from `node label-map.mjs show in-progress`, `:1299`) → `has_label`
- Scope today: per-object from the caller's `<issue>`; reads the whole label set, so it cannot tell WHO set `in-progress`
- Feeds / Selected by: `has_label` decides whether the label drop runs (S6-5) and what the receipt reports (`:1536`) / Selected by: the caller's `<issue>` argument (`:220`)
- Exists because: "Read the label before touching anything, so a tracker that cannot answer stops the run before any delete" (`:1302-1303`)
- Own-work limit: read only the issue this Instance's claim recorded; the label's presence must be known to be this Instance's claim before it counts as releasable
- Mark: issue; nearest mark today: in-progress label ("says nothing about by whom"); tells Instances apart under one gh user: no; under different gh users: no
- Notes: `gh` failure is `die` (`:1313`). The in-progress role string is read from the Label map by `label-map.mjs show` (`:1299`), a local cache read (see Checked).

### S6-4 release: delete the claim branch from origin (closed-PR mode)
- Where: `plugin/scripts/release-ticket.sh:1499-1521` (the delete at `:1509`; dry-run preview `:1338-1341`)
- Kind: write
- Does: `net_git "" "$ls_budget" push origin --delete "refs/heads/$branch"` — a plain delete: "this file spells no form of force" and no lease on the tip, so "a push landing in the gap between that re-read and this call is deleted with the branch" (`:1489-1492`)
- Scope today: per-object from the caller's branch name; precondition = the S6-1 re-read at `:1500-1503` equals `$remote_sha` (read earlier, `:903-907`), and S6-2 read all-CLOSED
- Feeds / Selected by: it is the write / Selected by: caller arguments → S6-1 → S6-2 (`:1262`); runs before the label drop (`:1523`)
- Exists because: a closed-unmerged claim leaves the remote branch, so "the three artefacts survive the run and phase 0's in-flight probe reads the ticket as taken" (`:22-24`); remote delete is "a fourth artefact" (reaping.md:69)
- Own-work limit: only targets a remote branch this Instance's own claim pushed (identified by a mark that names the Instance); when ownership is unknown it must stall (halt, leave origin untouched). The existing guards (tip equality, CLOSED PRs, no OPEN/MERGED) protect against losing unmerged work, not against deleting another Instance's branch
- Mark: branch; nearest mark today: head branch name; tells Instances apart under one gh user: no; under different gh users: no
- Notes: the local branch need not exist (`:948-951`, `:1487-1489`), so this write can run with no local evidence of ownership at all. A non-zero push is followed by an `ls-remote` read-back; "gone counts as done" (`:1494-1498`, `:1511-1520`). Dry run is the default (`:17`); `--apply` required (`:227-232`).

### S6-5 release: drop `in-progress` from the ticket (no precondition on who holds it)
- Where: `plugin/scripts/release-ticket.sh:1523-1527` (dry-run preview `:1335`); string from `:1299`
- Kind: write
- Does: `gh issue edit "$issue" --remove-label "$in_progress"` — runs when S6-3 saw the label (`has_label=true`) and every delete above it succeeded ("Label LAST", `:1343-1351`)
- Scope today: no precondition — the only gates are the local/remote artefact checks of the claim branch (S6-1, S6-2, `:942-1002`, `:1250-1280`) and the S6-3 read; none compares the label to a holder
- Feeds / Selected by: the ticket becomes visible to `candidates.mjs` again (`:1307-1310`, `:1321-1322`) / Selected by: caller's `<issue>` → S6-3 `has_label`
- Exists because: "Worktree and branch gone with in-progress left behind hides the ticket from candidates.mjs entirely — worse than not releasing. All three artefacts or none." (reaping.md:67)
- Own-work limit: only targets an issue whose `in-progress` this Instance's own claim added; when ownership of the label is unknown it must stall and leave the label (a second Instance that claimed the same ticket shares the same label, and removing it frees the ticket under that claim)
- Mark: issue; nearest mark today: in-progress label; tells Instances apart under one gh user: no; under different gh users: no
- Notes: both claim shapes reach this write with local-only evidence in the never-dispatched shape (a local branch of the name with ahead 0, `:996-1002`) — that evidence exists in whichever clone holds the local branch, so two clones that each hold a local branch of this name each pass it. Failure → `halt` after the deletes already landed (`:1525-1526`).

### S6-6 reap: `git fetch --prune origin` (what origin no longer holds)
- Where: `plugin/scripts/reap.sh:271-283` (budget `net_fetch_budget`, `plugin/scripts/net.sh:81`); feeds the reads at `:1049`, `:1093`
- Kind: read-select
- Does: `net_git "" "$fetch_budget" fetch --prune --quiet origin` — all branches of origin (default refspec), deleting local `refs/remotes/origin/*` for any branch gone from origin, whoever removed it
- Scope today: repo-wide (every remote branch, every author)
- Feeds / Selected by: `[gone]` verdict of `%(upstream:track)` for local branches with an upstream (`:1049-1063`); absence of `refs/remotes/origin/<b>` for local no-upstream branches (`:1090-1101`, `show-ref` at `:1093`); `$base_rev` (`refs/remotes/origin/main`) for `git cherry` and ancestry / Selected by: none (unconditional)
- Exists because: "refusing to reap on stale refs" (`:280`, `:282`); reap "only a ref the `fetch --prune` above maintains can answer it [has this work landed upstream]" (`:141-142`)
- Own-work limit: the fetch itself writes only local remote-tracking refs; what it feeds must be limited to branches this Instance created — a `[gone]` verdict means "someone deleted origin's branch", and the merge bot of another Instance deletes remote heads too (run-merge-bot.md:248 names that step)
- Mark: branch; nearest mark today: head branch name; tells Instances apart under one gh user: no; under different gh users: no
- Notes: fetch failure or stall is `die` — nothing is deleted (`:275-283`).

### S6-7 reap: merged-PR lookup by local branch name (`gh api graphql`, batched)
- Where: `plugin/scripts/reap.sh:832-904` (query at `:859-864`, call at `:867-871`, bounded wrapper `gh_bounded` `:807-820`, identity from `remote.origin.url` `:765-792`); consumers `:1153`, `:1236`; decision `pr_tie` `:908-999`
- Kind: read-select
- Does: one `gh api graphql --hostname "$pr_host" -f "query=..." -f "owner=$pr_owner" -f "name=$pr_name" -f "h<i>=<branch>" ... --jq …` per `$pr_chunk`=500 branches (`:831`); per alias `pullRequests(headRefName:$h<i>,states:MERGED,first:2){nodes{number baseRefName isCrossRepository headRefOid timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100){pageInfo{hasNextPage} nodes{... on HeadRefForcePushedEvent{beforeCommit{oid}}}}}}`. Read-only (a query, no mutation)
- Scope today: per-object from this clone's local branch names (`$pr_branches` = the `[gone]` branches plus the no-upstream branches whose `origin/<b>` is gone, `:1103-1104`); the PR match is by head-branch NAME across all authors, merged state only, both Instances' PRs included
- Feeds / Selected by: the local branch delete + worktree removal (S6-8): for a no-upstream branch it IS the selection (`:1150-1160`), for a `[gone]` branch it overturns a `git cherry` keep (`:1236-1243`) / Selected by: S6-6 (`fetch --prune`) and the local `for-each-ref` (`:1049`, `:1089-1104`)
- Exists because: "A stranded tip is a head the PR's remote branch once held … only GitHub records it" (`:696-701`); "One lookup by head name, MERGED PRs only" (`:713-714`); kept unless exactly one PR matches (a reused name matches several, `:926-931`), base equals `BASE_REF`'s branch (`:937-940`), not cross-repository (`:941-944`), `headRefOid` is a commit here and an ancestor of `$base_rev` (`:950-961`), and the tip equals one of the PR's recorded heads or is an ancestor of one (`:965-997`)
- Own-work limit: the lookup must be limited to PRs this Instance opened (an Owned PR) for branches this Instance created; a merged PR of the same head name from another Instance/author must keep (stall), not tie
- Mark: PR; nearest mark today: head branch name (the lookup key) plus the commit-id tie (tip equals a head the PR recorded) — the tie proves "this tip was on that PR", not "this Instance owns that PR"; tells Instances apart under one gh user: no (the PR author is not read — `.number .baseRefName .isCrossRepository .headRefOid` and force-push `beforeCommit.oid` only, `:841-845`); under different gh users: no (same reason)
- Notes: never called when no `+` branch and no selected no-upstream branch exists (lazy, `:1153`, `:1236`; reaping.md:34). `gh` missing/failed/timeout/unparseable/next-page → every affected branch keeps with its reason (`:834-836`, `:891-899`, `:933-936`). Off when `$base` is not `origin/<branch>` or `remote.origin.url` has no `host/owner/repo` (`:797`). Nothing cached between runs (`:738`). Contrast: the tie compares COMMIT IDS, so a different Instance's PR with the same head name ties only if this clone's tip really is one of its heads.

### S6-8 reap: delete local branch, its config section and its worktree, driven by remote state (host-local; no GitHub write)
- Where: `plugin/scripts/reap.sh:1127-1718` (branch sweep: `git worktree remove "$wt"` `:1599`, `git update-ref --no-deref -d "refs/heads/$b" "$tip"` `:1676`, `git config --remove-section "branch.$b"` `:1706`); `:1752-2049` (second sweep: `git worktree remove "$wt"` `:1993`, reported `REMOVED worktree` `:2006`); `git worktree prune` `:2078`
- Kind: write
- Does: only under `--apply` (dry run is the default, `:4`, `:291`); deletes local refs/worktrees/config only. No `git push`, no remote delete, no `gh` write, no label write anywhere in `reap.sh` (verified by grep for `push`, `--delete`, `gh issue|pr`, `label` in the file; the only `gh` call is the S6-7 query)
- Scope today: this clone's local branches (`for-each-ref refs/heads`, `:1049`) and its linked worktrees under `*/.worktrees/*` (second sweep bound, reaping.md:47)
- Feeds / Selected by: nothing on GitHub; effect reaches other Instances only indirectly, none shares this clone's disk / Selected by: S6-6 (`[gone]`, `origin/<b>` absent) + S6-7 (merged-PR tie) + `git cherry` against `$base_rev` (`:1162-1235`)
- Exists because: "Merge deletes remote branch, leaves local branch `[gone]` with worktree … still on disk. Stale worktree still answers `git worktree list`, so the in-flight probe reads already-merged ticket as taken and queue quietly shrinks" (reaping.md:9)
- Own-work limit: local deletes need only be limited to this clone's own branches (already true: iterated from this clone's `refs/heads`); the GitHub-derived verdicts that authorize them (S6-6, S6-7) are the part that would have to name this Instance's own PR/branch
- Mark: branch (local); nearest mark today: head branch name; tells Instances apart under one gh user: no; under different gh users: no
- Notes: the file's own comments assume one shared ref store per checkout: "`claim-ticket.sh` creates a branch per ticket and `reap.sh` deletes them in the ref store every worktree shares" (`plugin/skills/run-team/references/instruments.md:43-44`), and "operate on the single shared ref store every worktree and the main checkout read and write directly" (`plugin/skills/run-team/references/isolation.md:149-154`). The "concurrent session" case the header cites was a second session on the same clone (`reap.sh:5-7`), not a second clone. reap.sh declines the `in-progress`/never-dispatched claim by design: "no merge happened, so no remote branch was ever deleted, so branch is not `[gone]`" (`release-ticket.sh:19-24`).

### S6-9 push-sync: origin's head of the branch before the push (`ls-remote`)
- Where: `plugin/scripts/push-sync.mjs:100-109` (`remoteHead`), `:172` (call)
- Kind: read-inform
- Does: `git ls-remote origin refs/heads/<branch>` with a 30 s timeout (`:71`, `:102`), exact-name match on `name === ref` (`:104-107`)
- Scope today: per-object from the `--branch` argument (`:158`); the answer is the tip of the name, whoever pushed it
- Feeds / Selected by: only the sync guard `equalsRemote` (`:205`) — a failed or timed-out read "does not stop the push" (`:18-21`); it does NOT gate the push / Selected by: `--branch`, supplied by the dispatching brief (`plugin/skills/run-team/briefs/fix-applier.md:96,100`, `plugin/commands/review-and-fix.md:22`, `plugin/skills/next-ticket/SKILL.md:171`)
- Exists because: "the local ref read before the push equals origin's head read before the push, or is an ancestor of the pushed SHA. A rebase's force-push replaces exactly the tip origin had, so under this guard no commit that was only local is dropped." (`:34-37`)
- Own-work limit: read only the branch of this Instance's own PR/claim; the branch name must be this Instance's own before the read means anything
- Mark: branch; nearest mark today: head branch name; tells Instances apart under one gh user: no; under different gh users: no
- Notes: the `--branch` value arrives from a prompt, not from the script's own state; the script checks only that it is a valid ref name (`:161-163`).

### S6-10 push-sync: push `HEAD` to `refs/heads/<branch>` on origin
- Where: `plugin/scripts/push-sync.mjs:175-183` (flag read `:160`); also the sync `reset --keep` at `:225` (local)
- Kind: write
- Does: `git push [--force-with-lease] origin HEAD:refs/heads/<branch>`; git's output goes to stderr (`:176-177`); a failed push (a denied lease included) "exits with the push's own status, is never retried with `--force`, and nothing is synced" (`:24-26`, `:179-183`). No `-u`/`--set-upstream` is passed, so the push leaves the local claim branch without an upstream
- Scope today: no precondition from the pre-push read — the `ls-remote` result is not consulted before the push (`:172` vs `:175`); the only server-side precondition is git's own: a plain push refuses a non-fast-forward; with `--force-with-lease` the bare form (no `=<ref>:<expect>`) leases against this clone's `refs/remotes/origin/<branch>` [INFERENCE from git's documented behaviour; the expectation is not spelled in the code]
- Feeds / Selected by: moves origin's ref of `<branch>`; then the holder worktree of that branch is moved to the pushed SHA (`:186-228`) / Selected by: `--branch` and the cwd's `HEAD` — both supplied by the caller: fix-applier brief (`briefs/fix-applier.md:96,100`), `fleet-fix-applier.agent.md:348`, `review-and-fix.md:22`, reviewer detach case (`references/reviewers.md:99`), and the next-ticket flow with the lease flag (`plugin/skills/next-ticket/SKILL.md:171`)
- Exists because: "A member in a `--detach` worktree can only push by refspec, and a refspec push moves origin's ref alone" (`:7-9`)
- Own-work limit: only targets this Instance's own claim branch / Owned PR head; must not force-replace a head another Instance pushed — the bare lease checks against whatever this clone last fetched, not against who wrote the tip; when ownership is unknown it must stall and push nothing
- Mark: branch; nearest mark today: head branch name; tells Instances apart under one gh user: no; under different gh users: no
- Notes: exit 3 = "pushed, NOT synced" (`:57-58`); a push to a fix-applier PR branch is a push to the PR's remote head. The `--force-with-lease` caller is a prompt-surface instruction (next-ticket SKILL.md:170-171), cited only; its own slice owns it.

### S6-11 reaping.md: reap and ledger cross-check instruction (host-local)
- Where: `plugin/skills/run-team/references/reaping.md:5`, `:7-9`, `:90-92`
- Kind: instruction-write
- Does: after each merge pass, reap — and "Cross-check `.fleet/ledger.md` before running: row without terminal state means someone may still be in that worktree"; "Update reaped tickets' ledger rows in same step, report reaped and kept counts" (`:92`). The only GitHub-visible effect of `reap.sh` is none (S6-8); the instruction is to run a host-local delete
- Scope today: per-object from the local ledger (invisible to other Instances) and the local `[gone]` set
- Feeds / Selected by: `reap.sh --apply` (S6-6..S6-8) / Selected by: the controller's ledger rows (local `.fleet/ledger.md`)
- Exists because: "Dirty check does not see member that committed but not pushed." (`:92`)
- Own-work limit: its guard must stay own-work-only: the ledger names only this Instance's members, so a branch another Instance's member is on appears nowhere in it
- Mark: none (ledger is local `.fleet/` state, not on GitHub); nearest mark today: ledger; tells Instances apart under one gh user: yes for local-only data but not readable by another Instance; under different gh users: yes (same caveat)
- Notes: the file is explanatory prose for `reap.sh`/`release-ticket.sh`; it describes (not instructs) the `gh pr list`/`ls-remote`/`push --delete`/`gh issue edit` steps of S6-1..S6-5 (`:62-69`, "The remote branch is a fourth artefact: `--apply` deletes it after the local deletes and before the label drops", `:69`).

### S6-12 isolation.md: re-creating a worktree for an already-open PR (`ls-remote`, `gh pr view`, `git fetch origin`)
- Where: `plugin/skills/run-team/references/isolation.md:43-65` (create + verify), `:86-94` (fetch-and-retry), `:96-111` (review backstop, prose)
- Kind: instruction-read
- Does: tells the controller: "Create it detached from the remote ref … `git worktree add --detach <path> origin/<branch>`"; verify with `git -C <path> rev-parse HEAD` against `git ls-remote origin refs/heads/<branch> | cut -f1`; "Read `gh pr view <N> --json headRefOid -q .headRefOid` here too, and record it"; on mismatch "`git worktree remove --force <path>` first, then fetch and re-create once" with `git fetch origin`
- Scope today: per-object from "an already-open PR" `<N>` / `<branch>` the controller names (`:43`); the file does not say whose PR — a rebaser/resolver is sent into "an already-open PR's worktree" (`:15-16`)
- Feeds / Selected by: whether the controller dispatches a member into that worktree (`:54-55`: "Unequal → dispatch nothing"); the `git worktree remove --force` is a local delete / Selected by: the controller's choice of PR (outside this slice)
- Exists because: a stale local branch "wins over the rebased `origin/` ref that is actually the PR" and "produces confident wrong output" (`:24-41`); "Why the ref and not `headRefOid`" (`:67-84`)
- Own-work limit: the PR `<N>` must be an Owned PR of this Instance; for any PR not provably this Instance's it must read nothing and dispatch nothing
- Mark: PR; nearest mark today: head branch name / author login (`gh pr view` returns neither here: `--json headRefOid` only); tells Instances apart under one gh user: no; under different gh users: no
- Notes: `git fetch origin` fetches every branch of origin, all authors (repo-wide, as S6-6). `review-core.mjs` is cited at `:96-106` (its own slice). Lines `:21`, `:117-118` (`derive-testcmd.sh … --at origin/main`, `evict.mjs --restore`) are config/local.

## Checked, own-only or config
- `plugin/scripts/release-ticket.sh:283-284` — `git rev-parse --verify refs/remotes/origin/main` (`$base_rev`): `origin/main` content, config (local ref, no network)
- `plugin/scripts/release-ticket.sh:1299` — `node label-map.mjs show in-progress`: the in-progress role string from the Label map (local cache read; `ensure`/`set` are the `gh label` ones, not called here), config
- `plugin/scripts/release-ticket.sh:296-940, :1003-1234, :1363-1480` — `git worktree list --porcelain`, dirty/stray/orphan checks, `git cherry`, `git update-ref -d`, `git worktree remove` (no `--force`), `git worktree prune` (`:1533`): host-local ref store and filesystem, no GitHub access
- `plugin/scripts/release-ticket.sh:996-1002` — `git rev-list --count refs/remotes/origin/main..refs/heads/$branch` ahead check: local refs only, own local branch
- `plugin/scripts/reap.sh:258` — `git rev-parse --show-toplevel` (self worktree): local
- `plugin/scripts/reap.sh:290` — `git rev-parse --verify $base_rev`: `origin/main` content, config
- `plugin/scripts/reap.sh:768` — `git config --get remote.origin.url`: repository config (identity for S6-7)
- `plugin/scripts/reap.sh:1093` — `git show-ref --verify --quiet refs/remotes/origin/$b`: local ref read after the fetch, folded into S6-6
- `plugin/scripts/reap.sh:1162-1235` — `git cherry $base_rev $tip`: local commit comparison against `origin/main`, own local branch
- `plugin/scripts/reap.sh:1111`, `:1706` — `git config --local --get-regexp '^branch\.'` / `--remove-section`: local config
- `plugin/scripts/worktree-audit.sh:178-221` — `BASE_REF`/`origin/main` qualified to `refs/remotes/origin/main` and resolved: `origin/main` content, config; the script is audit-only and runs no `gh`, `ls-remote`, `fetch` or `push` (grep of `\bgh\b|ls-remote|git (fetch|push)|net_git|spawn|execFile|\bpush\b` over it hit only comments)
- `plugin/scripts/push-sync.mjs:161-173` — `git check-ref-format`, `git rev-parse HEAD`, `commitOf(refs/heads/<branch>)`: local reads
- `plugin/scripts/push-sync.mjs:186-228` — `git worktree list`, `git -C <holder> status`, `merge-base --is-ancestor`, `reset --keep`: host-local; moves only the worktree that holds the pushed branch
- `plugin/skills/run-team/references/reaping.md:11-18, :20-81` — rationale prose for reap and release (no instruction beyond those in S6-11 and the S6-1..S6-8 behaviour they describe)
- `plugin/skills/run-team/references/isolation.md:5-41, :113-119, :121-339` — agent-test envelope, evict restore, scratch paths, omp `task`/kernel/`pkill` notes: host-local or no GitHub access; `:149-154` and `:230-246` are descriptions of claim/release/reap on omp (single shared ref store assumption, cited in S6-8)

## Files with no GitHub access
- `plugin/scripts/worktree.sh`
