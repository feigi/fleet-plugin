# Slice S1 — claims and the Pull

Snapshot: `origin/main` 1a9692aa. All `file:line` are relative to the repo root.

Facts that hold across entries (cited once here, referred to as "S1-facts"):
- No file in this slice reads or writes an **assignee** (grep of every Target file for `assignee`/`--assignee`/`@me`/`api user`: no hit). No file here compares a login to anything. The **author login** is never read by the Pull, the claim or the shortlist.
- The claim's identity is the literal pair `impl-<N>` / `implementer`: branch `implementer/<N>-impl-<N>`, worktree `.worktrees/<N>-impl-<N>` (`plugin/scripts/pull.mjs:450` `member: \`impl-${ticket}\``; `plugin/scripts/pull.mjs:994` `--branch implementer/${st.ticket}-${st.member}`; `plugin/scripts/claim-ticket.sh:94` `branch="$type/$issue-$slug"`, `:95` `wt=".worktrees/$issue-$slug"`). It names the ticket and the kind; it has no Instance, run, session or user part.
- The only claim mark on GitHub is the **in-progress label**, added by `plugin/scripts/claim-ticket.sh:286` and never read by `pull.mjs`, `inflight.sh` or `claim-ticket.sh` themselves. It is read only by `candidates.mjs` as a server-side exclusion (`plugin/scripts/candidates.mjs:150`, `:450-451`). Nothing in this slice removes `ready-for-agent` on claim: after a claim the ticket still carries `ready-for-agent` (claim adds one label only, `plugin/scripts/claim-ticket.sh:286`), so `pull.mjs`'s label check (`plugin/scripts/pull.mjs:814`) passes on a ticket another Instance claimed.
- Every Instance orders candidates the same way: oldest first, never re-ranked (`plugin/scripts/candidates.mjs:654-664` `rows.sort((a, b) => a.n - b.n)`; `plugin/scripts/shortlist.mjs:339` keeps that order). Instances reading the same GitHub state converge on the same shortlist head.
- Shortlist refresh (`shortlist.mjs`) is invoked from: `plugin/scripts/fleet-tick.mjs:1959` (`refresh()`, other slice), `plugin/scripts/phase0.mjs:506` (other slice), `plugin/skills/run-team/SKILL.md:83` and `:503`, `plugin/skills/run-team/references/phase-0.md:625`, `plugin/skills/run-team/references/pull.md:301`, `plugin/skills/run-team/references/tick-rows.md:277-278` (trigger list). `candidates.mjs` is invoked by `shortlist.mjs:160` and by the standalone next-ticket skill (`plugin/skills/next-ticket/SKILL.md:27`). `inflight.sh` is invoked by `pull.mjs:787`, `shortlist.mjs:324`, `plugin/skills/next-ticket/SKILL.md:58`, `plugin/skills/run-team/references/phase-0.md:639`.
- `pull.mjs` runs from the MAIN checkout only (`plugin/scripts/pull.mjs:1259-1261` refuses a linked worktree); its record is `<scratch>/impl-<N>/pull.json` (host-local, `plugin/scripts/pull.mjs:1275`, `:1282`). The `GH_REPO` env var is scrubbed for every `gh` call it makes (`plugin/scripts/pull.mjs:428` `const GH_ENV = { GH_REPO: "" }`), so `gh` resolves the repository from the cwd's git remotes.

---

### S1-1 In-flight check, probe 1: any PR about ticket N, by anyone
- Where: `plugin/scripts/inflight.sh:269-270` (`gh issue view "$n" --json closedByPullRequestsReferences,url`), `:305-306` (`gh pr list --state all --search "$n" --limit 100 --json number,state,headRefName,url`), `:312-351` (python filter), `:372-374` (`add_hit "pr"`)
- Kind: read-select
- Does: asks GitHub which PRs close issue N (`closedByPullRequestsReferences`), then lists up to 100 PRs of any state by full-text `--search "$n"`. A hit is a linked PR whose state is not `MERGED`/`CLOSED` (`:343`, state `?` when the window did not cover it, `:342`) or a PR whose `headRefName` has N as a path segment (`seg = (^|[/-])N([-/]|$)`, `:315`) AND is `OPEN` (`:349-350`). No author, no assignee, no label is looked at.
- Scope today: repo-wide (full-text search over every PR of the repository; the closing-reference half is per-object from N but lists PRs of any author, even other repositories: `:221-225`)
- Feeds / Selected by: Feeds: the verdict (`plugin/scripts/inflight.sh:787-800`: any hit → exit 1 "taken", payload `hits[]`) that (a) ends a Pull with `LEFT #N: taken` (`plugin/scripts/pull.mjs:786-793`), (b) drops the ticket from the Shortlist (`plugin/scripts/shortlist.mjs:323-337`), (c) tells the next-ticket skill to treat the ticket as taken (`plugin/skills/next-ticket/SKILL.md:58-61`). Selected by: N, from the shortlist head (`pull.mjs:1228-1240`) or `--head <N>` (`pull.mjs:1302`).
- Exists because: `plugin/scripts/inflight.sh:339-341`: "An unknown state stays a hit and says "?" rather than freeing the ticket: a wrong "taken" costs one skipped ticket, a wrong "free" puts two agents on the same one." The closing-reference signal catches PRs with no `#N` text; the branch signal catches a PR before anyone writes a closing keyword (`:215-218`).
- Own-work limit: as a "taken by anyone" read it is the most conservative answer there is (any PR about N stalls the ticket), so it never lets an Instance act on another's PR; but it cannot say whether the hit is this Instance's own earlier PR or another Instance's. A read that must tell own from other needs a mark on the PR/branch; when ownership of a hit is unknown it must stall (as it does today: exit 1).
- Mark: PR; nearest today: head branch name (`implementer/<N>-impl-<N>`, matched only on the number segment, `:315`) plus closing reference (`closedByPullRequestsReferences`); tells Instances apart under one gh user: no; under different gh users: no (author is not read)
- Notes: A closed-unmerged or merged PR frees the ticket (`:317-320`). The probe cannot see a claim that has only the label (`in-progress`) and no PR, branch or local worktree yet; probe 2 and 3 cover branches only. `plugin/skills/run-team/references/pull.md:40-45` states it: "All three probes ask whether a branch-shaped claim exists ... and nothing else".

### S1-2 In-flight check, probe 2: any remote branch carrying N, by anyone
- Where: `plugin/scripts/inflight.sh:450` (`net_git "$wdfile" "$ls_budget" ls-remote --heads origin`), `:500-503` (awk filter `(^|[/-])N([-/]|$)` on `refs/heads/`), `:505-507` (`add_hit "remote-branch"`)
- Kind: read-select
- Does: `git ls-remote --heads origin` lists every branch on origin; keeps those with N as a path segment.
- Scope today: repo-wide (every branch on origin; no author or prefix limit)
- Feeds / Selected by: Feeds: same verdict as S1-1 (`plugin/scripts/inflight.sh:787-800`) → `pull.mjs:786-793`, `shortlist.mjs:323-337`, next-ticket `SKILL.md:58-61`. Selected by: N as for S1-1.
- Exists because: `plugin/scripts/inflight.sh:4-7`: "a PR can exist with its branch deleted, a branch can exist with no PR yet, and a worktree can exist before anything is pushed." A failed `ls-remote` is recorded as unknown, never free (`:484-485`).
- Own-work limit: a "taken by anyone" read; any remote branch not provably this Instance's own must stall the ticket. Today it cannot tell own from other: the matched name `implementer/<N>-impl-<N>` is identical for every Instance.
- Mark: branch; nearest today: head branch name (`implementer/<N>-impl-<N>`); tells Instances apart under one gh user: no; under different gh users: no
- Notes: A claimed ticket with the branch not yet pushed is invisible to this probe: `claim-ticket.sh` creates the branch with `--no-track` and pushes nothing (`plugin/scripts/claim-ticket.sh:318`), so between a claim and its first push, on another clone, the only GitHub trace is the `in-progress` label, which no probe here reads.

### S1-3 In-flight check, probe 3: local branch or worktree for N in THIS clone
- Where: `plugin/scripts/inflight.sh:557-785` (`probe_local`), `:656` (`git for-each-ref --format='%(refname)' refs/heads`), `:665-669` (filter), `:682-685` (`[ -n "$local_b" ]` → `add_hit "local"` on a branch alone), `:700-706` (`wt_counts`), `:749-759` (worktree basename match; `[ -n "$local_b" ] || add_hit "local"`)
- Kind: read-select (local refs only; no network)
- Does: any local branch whose name has N as a segment, or any linked worktree of this checkout whose basename has N as a segment, is a hit. A local branch alone is enough (`:682-685`).
- Scope today: per-object from this clone's own refs and worktrees (git common dir of the checkout it runs in, `:558`); another Instance's clone is never seen.
- Feeds / Selected by: Feeds: same verdict (`:787-800`). Selected by: N.
- Exists because: a worktree can exist before anything is pushed (`:6-7`); `plugin/scripts/reap.sh` residue left by a merged ticket reads as a live claim until reaped (`plugin/scripts/reap.sh:1727-1731`).
- Own-work limit: none needed beyond what it is: it reads only this Instance's own clone, so what it sees is by construction this Instance's own claim or residue. It is the one In-flight probe that cannot see another Instance.
- Mark: branch/worktree; nearest today: head branch name; tells Instances apart under one gh user: yes (separate clones hold separate refs); under different gh users: yes
- Notes: a stale local branch from an earlier run of this Instance makes the ticket "taken" to this Instance forever (stall, not collision).

### S1-4 Candidate scan: every open `ready-for-agent` issue of the repository
- Where: `plugin/scripts/candidates.mjs:424-460` (`query()`), `:463` (`execFileSync("gh", ["issue","list","--state","open","--limit",…,"--search",…,"--json","number,title,labels,body,blockedBy","--jq",JQ])`), `:150` (`EXCLUDED_ROLES = ["in-progress","onhold","wontfix","needs-triage","needs-info"]`), `:167-168` (`WAYFINDER_EXCLUDE`), `:450-451` (search string `-label:"<role string>" … label:"<ready-for-agent string>"`), `:71` (`--limit` default 500), `:532-538` (`refuseIfCapped`), `:621-623`, `:641-647` (`--allow-fallback` unlabeled retry), `:664`
- Kind: read-select
- Does: `gh issue list --state open --search '-label:"in-progress" -label:"onhold" … label:"ready-for-agent"'`, reducing each body to dependency refs inside `gh` (`--jq`). Rows: `{n,t,l,d,dh,spec}`.
- Scope today: label-wide (open issues of the repository; the `in-progress` exclusion is what hides tickets already claimed by anyone)
- Feeds / Selected by: Feeds: `shortlist.mjs:160` (→ `.fleet/shortlist.json`, the list the Pulls take heads from, `plugin/scripts/pull.mjs:1213-1240`) and the next-ticket skill's candidate list (`plugin/skills/next-ticket/SKILL.md:27`). Selected by: the Label map roles (`candidates.mjs:141`, `:146`).
- Exists because: server-side exclusions keep claimed and on-hold tickets out of the queue (`plugin/scripts/fleet-tick.mjs:2061-2065`: the `in-progress` role is "the claim label claim-ticket.sh adds and candidates.mjs's query EXCLUDES"); `refuseIfCapped` stops a silently truncated queue (`candidates.mjs:525-531`).
- Own-work limit: the list is a supply count of tickets nobody has claimed; it names no claim. What the Pull may act on from it is only a ticket this Instance then claims itself (S1-13); the `in-progress` exclusion is the only cross-Instance claim signal in the supply and it is read only at refresh time (stale between refreshes, S1-5/S1-6 notes). When ownership of an `in-progress` ticket is unknown it is excluded, which is stall.
- Mark: issue; nearest today: in-progress label (any claimer); tells Instances apart under one gh user: no; under different gh users: no
- Notes: `--allow-fallback` (`:641-647`, solo only; the fleet never passes it, `plugin/skills/run-team/SKILL.md:88-89`) widens to every open issue not excluded, `ready-for-human` and untriaged included.

### S1-5 Shortlist: state of each blocker issue/PR named by candidates
- Where: `plugin/scripts/shortlist.mjs:225-244` (`probeState`: `gh <kind> view <target> --json state`), `:263-267` (blockers not themselves candidates), `:278-282`
- Kind: read-select
- Does: for each `d` ref of a candidate that is not itself a candidate, `gh issue view <b> --json state` (answers for a PR number too).
- Scope today: per-object from the candidate's body/blockedBy refs (any issue or PR of any author; no ownership relation)
- Feeds / Selected by: Feeds: drops a candidate while a blocker is OPEN/unreadable (`shortlist.mjs:268-282`). Selected by: `d` from the candidate scan (S1-4).
- Exists because: `plugin/scripts/shortlist.mjs:39-43`: an unreadable blocker counts as open, "a ticket admitted wrongly costs a Pull's full read at best and two members on one ticket at worst."
- Own-work limit: read-only state lookup of a dependency; no act on the blocker. An Instance must not act on a blocker it does not own, and it does not today; a blocker whose state is unknown stalls the dependent ticket.
- Mark: none (state of someone else's ticket); nearest today: none; tells Instances apart under one gh user: no; under different gh users: no

### S1-6 Shortlist: exclusion premises (`behind-pr`, `behind-issue`) read from the ledger, asked of GitHub
- Where: `plugin/scripts/shortlist.mjs:284-320` (`premisesOf(line)`, `probeState(...)` at `:298`, `stillExcluded` `:300-309`), `:221` (`askable`)
- Kind: read-select
- Does: for each candidate whose ledger row reads `excluded · behind-pr:#M` / `behind-issue:#M`, `gh pr view M --json state` / `gh issue view M --json state`; MERGED/CLOSED lifts the exclusion (`CLOSED` set `:86`).
- Scope today: per-object from a ledger premise (the ledger is host-local; `M` is whatever PR or issue the controller typed, any author)
- Feeds / Selected by: Feeds: whether the candidate stays on the Shortlist (`:310-320`); a lifted ticket is then pulled (`plugin/scripts/pull.mjs:1228-1241`). Selected by: ledger row written by `pull.mjs:1134` (S1-8).
- Exists because: a ticket sequenced behind an open PR/issue must not be pulled until that is MERGED/CLOSED (`plugin/skills/run-team/references/pull.md:337-343`).
- Own-work limit: the premise `M` is a PR or issue that may belong to another Instance (by definition an open PR touching the same paths, S1-8); reading its state is informing, not acting. An unreadable premise stands (stall), as coded (`shortlist.mjs:301-306`).
- Mark: PR or issue (the premise object); nearest today: none; tells Instances apart under one gh user: no; under different gh users: no
- Notes: a branch name may stand in for `M` before its PR exists (`pull.md:339`, `:353-354`); `gh pr view <branch>` resolves by head branch name, so it finds whichever PR has that head, on any author.

### S1-7 Pull step "issue": read the ticket in full, gate on `ready-for-agent`
- Where: `plugin/scripts/pull.mjs:795-823` (`stage_issue`), `:797` (`gh issue view <N> --json title,body,comments,labels,createdAt`), `:814` (`if (!issue.labels.some((l) => l?.name === this.p.labels["ready-for-agent"])) return this.leave("relabelled elsewhere")`), `:815-819` (`strandedRuling`)
- Kind: read-select
- Does: reads the full ticket (all comments) of the shortlist head before any claim; leaves the Pull when `ready-for-agent` is gone. It never looks at `in-progress`.
- Scope today: per-object from the shortlist head or `--head <N>` (`pull.mjs:1302`); the object is not yet this Instance's (the claim comes later, `pull.mjs:923-939`)
- Feeds / Selected by: Feeds: Q1 staleness, Q2 decided, Q3 collision (S1-8), and every relabel/close write (S1-10, S1-11, S1-12), then the claim (S1-13). Selected by: `shortlistHead` (`pull.mjs:1213-1246`) or the tick's `PULL` row via `--head`.
- Exists because: `plugin/skills/run-team/references/pull.md:308-313`: "The shortlist file can be older than a relabel ... A Pull that trusted a list built before the relabel landed would hand a ticket the fleet has already judged unimplementable straight to the next member."
- Own-work limit: before the claim, the Pull holds no mark on the ticket. The label gate sees `ready-for-agent`, which a claim does not remove (S1-facts), so it cannot see another Instance's claim. What a Pull may do after this read is limited to tickets it then claims; when another Instance's claim is unknown it must stall.
- Mark: issue; nearest today: ready-for-agent label (state, not owner); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the tick may name `N` via `pull.mjs next --head <N>` (`plugin/skills/run-team/SKILL.md:378`, tick slice); `heldOut` (S1-9) is the only ledger check on that path.

### S1-8 Pull step "collision": every open PR of the repository, its file list and its diff
- Where: `plugin/scripts/pull.mjs:842-921` (`stage_collision`), `:844` (`gh pr list --state open --limit 200 --json number,headRefName`), `:855` (cap refused at `PR_LIMIT = 200`, `:151`), `:871-886` (`gh pr diff <M> --name-only`, then `gh pr diff <M>` for each PR that shares a brief path), `:739` (`git fetch -q origin pull/<M>/head`), `:887-901` (live worktree branches of this checkout against `origin/main...<branch>`), `:1134-1136` (the `behind-pr:#M` answer writes the exclusion row)
- Kind: read-select
- Does: lists every open PR (any author, any branch), fetches the changed-file list of each, and for each PR sharing a path with the brief reads its full diff and fetches its head (`pull/<M>/head` into `FETCH_HEAD`) to find merge-base headings. Prints one line per PR.
- Scope today: repo-wide (all open PRs, capped at 200); the local half (`git worktree list`, `git for-each-ref`, `git diff origin/main...<branch>`, `:856-902`) is this clone's own worktrees
- Feeds / Selected by: Feeds: Q3 `collision` question (`pull.mjs:920`); the controller's answer `behind-pr:#M` / `behind-issue:#M` becomes the ledger row `excluded · <token>` (`pull.mjs:1134`) that ends the Pull (`pull.mjs:1136`) and holds the ticket out of later Shortlists (S1-6, S1-9). Selected by: the brief's paths of the shortlist head (S1-7).
- Exists because: `plugin/skills/run-team/references/pull.md:220-236`: a collision with an open PR or live branch means this ticket sequences behind it; "A PR the scan could not read is still yours to judge, and `behind-pr` on it is taken."
- Own-work limit: informing reads of other work to decide whether to wait; nothing is written to those PRs. Own PRs from the same Instance also appear in the list (no filter), so an Instance's own earlier PR can hold its own later ticket (stall behind own work). A PR whose ownership is unknown may only be waited behind, never acted on.
- Mark: PR; nearest today: head branch name (matched only for display, `pull.mjs:887`, `:900`); tells Instances apart under one gh user: no; under different gh users: no (author is not requested: the `--json` field list is `number,headRefName`, `:844`)
- Notes: `git fetch -q origin pull/<M>/head` (`:739`) writes `FETCH_HEAD` in the main checkout for every shared PR, a fetch of a PR that is any author's. `origin/main` is not fetched by the Pull (`:733`, `:889` read the local ref as last fetched).

### S1-9 Pull start: does an exclusion premise still stand (`next --head`, shortlist head)
- Where: `plugin/scripts/pull.mjs:1146-1167` (`standingPremise`, `:1151` `spawn("gh", [kind, "view", target, "--json", "state"])`), `:1189-1200` (`heldOut`, called at `:1308` for `next --head <N>`), `:1214-1246` (`shortlistHead` calls `standingPremise` at `:1232` for every entry up to the first free one)
- Kind: read-select
- Does: for each entry (or the `--head` ticket) whose ledger row is `excluded · behind-<kind>:#<target>`, `gh pr|issue view <target> --json state`; `MERGED`/`CLOSED` lifts it (`LIFTED` `:159`); an unreadable premise is exit 2 and the exclusion stands (`:1195-1197`, `:1242-1243`).
- Scope today: per-object from a ledger premise (as S1-6)
- Feeds / Selected by: Feeds: whether this Pull may start (`pull.leave(held)` `:1318-1321`) and which head is taken (`:1228-1241`). Selected by: ledger rows (host-local) written by `pull.mjs:1134`.
- Exists because: same premise rule as S1-6, applied by the Pull itself so that a head asked for by number is not pulled behind a standing exclusion (`pull.mjs:1306-1308`).
- Own-work limit: informing state read of a PR/issue that may be another Instance's; no act on it. Unreadable → stall.
- Mark: PR or issue (premise); nearest today: none; tells Instances apart under one gh user: no; under different gh users: no

### S1-10 Pull Q1b `close`: close the ticket as already fixed
- Where: `plugin/scripts/pull.mjs:1081-1092` (`answer_close`), `:1089` (`gh issue close <N> --comment <closeComment>`), `:210-213` (`closeComment`: `*Closed by the fleet controller.* Pulled for implementation and found already fixed by <commit>: <subject>.`)
- Kind: write
- Does: `gh issue close <N> --comment "…"` on the Pull's own ticket number, BEFORE any claim (the claim is stage `claim`, after `collision`: `pull.mjs:923-939`).
- Scope today: no precondition (per-object from the shortlist head; nothing checks `in-progress` or any claim mark at close time; the only earlier check is the S1-1..S1-3 in-flight check at `pull.mjs:786-793`, run once at Pull start)
- Feeds / Selected by: Selected by: Q1b answer `yes` after `staleness.mjs` exit 1 with a commit (`pull.mjs:1065-1068`), on ticket N of S1-7. Feeds: ticket closed; Pull ends `LEFT #N: closed: fixed by …` (`pull.mjs:1091`).
- Exists because: a backlog ticket whose fix already shipped must not cost a claim, a worktree and a dispatch (`plugin/skills/run-team/references/pull.md:144-149`).
- Own-work limit: only targets a ticket this Instance has not claimed and that no other Instance's claim is known to cover; an `in-progress` label, a branch or a PR for N seen at this moment means ownership is unknown or another's → stall (do not close). Today the label is not read here.
- Mark: issue; nearest today: in-progress label (not read here); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the comment text (`*Closed by the fleet controller.* …`) carries a commit and subject; no run, Instance, member or ledger token.

### S1-11 Pull Q2/stranded ruling: comment on the ticket before it is claimed
- Where: `plugin/scripts/pull.mjs:1108-1121` (`relabelled`), `:1113` (`gh issue comment <N> --body <comment>`), `:815-819` (stranded-ruling path), `:1094-1101` (Q2 causes), `:165` (`RELABELLED` text), `:189-208` (`relabel()` comment text)
- Kind: write
- Does: posts one comment `*Relabelled by the fleet controller.* Pulled for implementation and returned: <cause>` on the ticket. One comment per cause: `st.commented` records it in the local Pull record (`:1112-1116`).
- Scope today: no precondition (per-object from the shortlist head; no claim exists yet, no `in-progress` check)
- Feeds / Selected by: Selected by: Q2 answer other than `decided` (`needs-triage`, `ready-for-human-fork`, `ready-for-human-hands`, …) or a stranded ruling found at `pull.mjs:816`; ticket of S1-7. Feeds: S1-12 (the label swap that follows).
- Exists because: `plugin/skills/run-team/references/pull.md:332-335`: "These comments, the stranded-ruling comment and the comment closing a provably fixed ticket are the only writes the fleet makes to a ticket it did not claim."
- Own-work limit: only targets a ticket this Instance pulled and has not seen anyone else hold; when another Instance's claim or PR may exist for N, stall (no comment). A second Instance running the same Pull on the same N posts a second comment (the dedup is the local record, `:1112`, not GitHub).
- Mark: comment; nearest today: fleet comment marker `*Relabelled by the fleet controller.*` (verbatim first words, `pull.mjs:165`), no Instance part; tells Instances apart under one gh user: no; under different gh users: no (author login differs but is not read)
- Notes: fleet comment markers written in this slice: `*Relabelled by the fleet controller.* Pulled for implementation and returned: …` and `*Closed by the fleet controller.* …` (same texts in `plugin/skills/run-team/briefs/relabel.md:8-24`).

### S1-12 Pull relabel: swap `ready-for-agent` for another label on the unclaimed ticket
- Where: `plugin/scripts/pull.mjs:1118` (`gh issue edit <N> --remove-label <ready-for-agent string> --add-label <label>`), `:1119-1120`
- Kind: write
- Does: removes `ready-for-agent`, adds `needs-triage` / `ready-for-human` (labels from the Label map, `pull.mjs:189-208`).
- Scope today: no precondition (per-object from the shortlist head; `gh issue edit --remove-label` is idempotent whether or not another Instance did the same or claimed N in between)
- Feeds / Selected by: Selected by: the same Q2 answers / stranded ruling as S1-11. Feeds: the ticket leaves the supply for everyone (`candidates.mjs` requires `ready-for-agent`, `:451`).
- Exists because: `pull.md:308-313`, `:315-317`: "An unclaimed ticket is yours to reclassify at the Pull" so the ticket stops costing a read per scan.
- Own-work limit: only a ticket no other Instance has claimed; it may remove `ready-for-agent` from a ticket another Instance claimed a moment ago (the claim leaves `ready-for-agent` in place, S1-facts) → so with ownership unknown it must stall.
- Mark: label; nearest today: ready-for-agent / ready-for-human / needs-triage labels (state, not owner); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the comment (S1-11) and the edit are two commands; a failure between them leaves the comment posted and the label unchanged (`pull.mjs:1119` "the comment is posted").

### S1-13 Claim: add the `in-progress` label with no precondition
- Where: `plugin/scripts/claim-ticket.sh:286` (`gh issue edit "$issue" --add-label "$in_progress"`), `:274` (label string from `label-map.mjs show in-progress`), `:148-153` (the only refusals: `$wt` exists, branch `refs/heads/$branch` exists, both LOCAL), `:163` (`origin/main^{commit}` must resolve; no fetch is run), `:318` (`git worktree add --no-track "$wt" -b "$branch" origin/main`), called from `plugin/scripts/pull.mjs:932` (`claim-ticket.sh <N> impl-<N> implementer --apply`)
- Kind: write
- Does: `gh issue edit <N> --add-label in-progress`, then creates branch `implementer/<N>-impl-<N>` and worktree `.worktrees/<N>-impl-<N>` from `origin/main` in THIS clone. Nothing is pushed.
- Scope today: no precondition on GitHub: it does not read the issue, its labels, its PRs or origin's branches before labelling. `--add-label` is idempotent, so a second Instance labelling the same N a moment later also succeeds. The refusals at `:148-153` read only this clone.
- Feeds / Selected by: Selected by: the Pull's collision answer `clear` (`pull.mjs:1125-1127`), on ticket N of S1-7. Feeds: the `in-progress` exclusion in S1-4; the branch of S1-2/S1-3; the route/row/dispatch steps (`pull.mjs:941-1017`); exit 2 from this script is "taken" (`pull.mjs:937`).
- Exists because: `plugin/scripts/claim-ticket.sh:7-13` — the claim is the branch plus the worktree, labelled so the supply stops listing it; `--no-track` so `@{u}` does not answer for `origin/main` (`:288-312`).
- Own-work limit: only targets a ticket this Instance may claim: the label add must be conditional on a read proving no other Instance holds N, which no code here does; with ownership unknown it must stall. An already existing `in-progress` label is today indistinguishable from a claim by this Instance's earlier run.
- Mark: issue (label) and branch; nearest today: in-progress label (says nothing about by whom) and head branch name `implementer/<N>-impl-<N>` (no Instance part); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the `in-progress` write is step 1 of the apply branch and everything after it (`:318` `worktree add`, install, runner) can still fail with the label already on (`:107-113` comment names this half-claim). Exit 2 messages `$wt already exists — ticket may already be claimed` / `branch … already exists` (`:149`, `:153`) are local-only: a second clone sees neither. The claim does not `git fetch` before reading `origin/main` (`:163`, `:197-199` `--at origin/main`, `:318`): the worktree is cut from the clone's last-fetched `origin/main`. Ports derived from N (`:215-217`) are host-local.

### S1-14 Standalone next-ticket: candidate list
- Where: `plugin/skills/next-ticket/SKILL.md:27` (`candidates.mjs --require-label ready-for-agent --allow-fallback`), `:34-38`, `:51` (dependencies from the `d` array)
- Kind: instruction-read
- Does: tells the solo session to run the candidate scan of S1-4 with `--allow-fallback` (unlabeled retry when the labeled pass is empty).
- Scope today: label-wide (S1-4); with the fallback, every open issue not excluded
- Feeds / Selected by: Feeds: the maintainer's choice at step 4 (`SKILL.md:67-82`) and then S1-16. Selected by: Label map.
- Exists because: suggest ready tickets to a present maintainer (`SKILL.md:10`); "Solo only — flag exists for this caller" (`:36`).
- Own-work limit: as S1-4; the maintainer's pick is the only own-work filter in this path (`SKILL.md:12`: "Never grab ticket unilaterally. Labels and git state record only some claims; others live in maintainer's head or another agent session." `:82`: "Maintainer says taken → drop, re-suggest.").
- Mark: issue; nearest today: in-progress label; tells Instances apart under one gh user: no; under different gh users: no

### S1-15 Standalone next-ticket: in-flight probe and per-candidate issue read
- Where: `plugin/skills/next-ticket/SKILL.md:58` (`inflight.sh <N>`), `:61`, `:63` (`gh issue view <N> --json title,body,comments --jq …`), `:65`
- Kind: instruction-read
- Does: instructs running `inflight.sh <N>` (S1-1..S1-3) on each surviving candidate and then reading the issue and comments of the survivors.
- Scope today: per-object from the candidate list; the probes are repo-wide (S1-1, S1-2)
- Feeds / Selected by: Feeds: the suggestion (`:67`) and S1-16. Selected by: S1-14.
- Exists because: `SKILL.md:65`: "Step 1 already excludes `in-progress`, so step 3 catches the claim that never reached the label rather than the common case."
- Own-work limit: informing only; any "taken" hit not provably own stalls (`:61` "Exit 2 is not free").
- Mark: PR / branch; nearest today: head branch name; tells Instances apart under one gh user: no; under different gh users: no

### S1-16 Standalone next-ticket: claim = label write, then hand-built branch
- Where: `plugin/skills/next-ticket/SKILL.md:87` (`gh issue edit <N> --add-label "<in-progress string>"`), `:92` (branch and worktree "inferred", no `claim-ticket.sh`)
- Kind: instruction-write
- Does: tells the solo session to add `in-progress` to the maintainer-picked ticket and then create a branch and worktree by hand.
- Scope today: no precondition (no read of `in-progress` or of PRs between the maintainer's answer and the write; the in-flight probe of S1-15 ran earlier, before the maintainer answered)
- Feeds / Selected by: Selected by: maintainer pick (`SKILL.md:82`). Feeds: S1-19 push/PR; the supply exclusion in S1-4.
- Exists because: "mark in-progress" is the skill's claim (`SKILL.md:10`).
- Own-work limit: only targets the ticket the maintainer picked; it must not run when another Instance's claim on N is visible or unknown.
- Mark: issue (label); nearest today: in-progress label; tells Instances apart under one gh user: no; under different gh users: no
- Notes: this path never runs `claim-ticket.sh`, so none of its local refusals (`claim-ticket.sh:148-153`) apply; the claim branch has the human shape `feat|fix|refactor/<N>-slug` (`SKILL.md:92`). `claim-ticket.sh:13` names next-ticket's `fix/<N>-<slug>` as a caller shape, but the skill text does not call it.

### S1-17 Standalone next-ticket: infer naming from `git branch -r`
- Where: `plugin/skills/next-ticket/SKILL.md:92` ("Infer branch/worktree convention from `git worktree list` / `git branch -r`")
- Kind: instruction-read
- Does: reads every remote-tracking branch of origin (as last fetched) and every worktree of this clone.
- Scope today: repo-wide (all remote-tracking refs, any author's)
- Feeds / Selected by: Feeds: the branch name the solo session creates (S1-16, S1-19). Selected by: none (whole list).
- Exists because: no fixed naming in the solo path.
- Own-work limit: informing only; the convention it learns (e.g. `implementer/…`) must not be copied from another's branch (`plugin/skills/run-team/references/pull.md:363-366` warns against exactly this for the fleet path: "Never read them off `git branch -r` or `git worktree list`").
- Mark: branch; nearest today: head branch name; tells Instances apart under one gh user: no; under different gh users: no

### S1-18 Standalone next-ticket: abandon → remove `in-progress`
- Where: `plugin/skills/next-ticket/SKILL.md:96` (`gh issue edit <N> --remove-label "<in-progress string>"`)
- Kind: instruction-write
- Does: removes the label from the ticket the session claimed when the session abandons before a PR opens.
- Scope today: no precondition (the label is removed without reading who added it)
- Feeds / Selected by: Selected by: this session's own claim (S1-16). Feeds: the ticket reappears in S1-4.
- Exists because: a left-behind label hides the ticket from every scan (`plugin/skills/run-team/references/reaping.md:67`).
- Own-work limit: only targets a ticket this Instance itself labelled; with the label present and ownership unknown it must not remove it (stall).
- Mark: issue (label); nearest today: in-progress label; tells Instances apart under one gh user: no; under different gh users: no

### S1-19 Standalone next-ticket: push and PR from the claim branch; `push-sync` for a PR's worktree
- Where: `plugin/skills/next-ticket/SKILL.md:107` (`git fetch origin && git rebase origin/main`), `:109` (`git push --force-with-lease -u origin HEAD`), `:110` (`gh pr create --base main --body "… Closes #N"`), `:113` (`gh pr edit --add-label <patch|minor|major>`), `:116`, `:171` (`push-sync.mjs --branch <branch> --force-with-lease`), `:181` (fallback: plain `git push -u origin HEAD` for a never-pushed branch)
- Kind: instruction-write
- Does: pushes the claim branch (create or force-with-lease), opens a PR whose body ends `Closes #N`, adds exactly one release label; for a detached worktree of an already-open PR names the branch explicitly (`HEAD:refs/heads/<branch>`).
- Scope today: per-object from this session's claim branch (`SKILL.md:116`: "Push and open the PR from the branch you claimed in step 5"); the `push-sync` branch at `:171` is per-object from "an already-open PR's worktree" that `run-team`'s runbook (another slice) created, i.e. a branch the controller chose
- Feeds / Selected by: Selected by: S1-16 claim. Feeds: the PR S1-1/S1-8 see; `Closes #N` becomes the closing reference.
- Exists because: end-of-session deliverable (`SKILL.md:102-104`); lease on re-push (`:181`).
- Own-work limit: only this Instance's own claim branch and own PR. The push-sync path (`:164-179`) targets whatever branch the worktree holds: it must be limited to a branch this Instance created or was handed; the lease guards the branch tip, not the owner. `:181` allows a plain `git push -u origin HEAD` for a never-pushed branch after a lease denial; a never-pushed branch name `implementer/<N>-impl-<N>` that another Instance already pushed makes the lease/denial the only signal [INFERENCE: not run].
- Mark: branch and PR; nearest today: head branch name and closing reference (`Closes #N`); tells Instances apart under one gh user: no; under different gh users: no
- Notes: the `gh pr edit --add-label` without a PR argument resolves "the current branch's PR" (`SKILL.md:187`).

### S1-20 Standalone next-ticket: create missing triage labels
- Where: `plugin/skills/next-ticket/SKILL.md:24` (`label-map.mjs set --create`; "labels that do not exist are created on your confirmation")
- Kind: instruction-write
- Does: creates label strings in the tracker (`gh label create`, in `plugin/scripts/label-map.mjs:64`, other slice) after the maintainer confirms.
- Scope today: repo-wide (repository label list; configuration)
- Feeds / Selected by: Selected by: maintainer confirmation of a label-map question. Feeds: the Label map every later claim uses.
- Exists because: the map's roles must exist in the tracker before a claim can label (`SKILL.md:90`).
- Own-work limit: none needed beyond maintainer confirmation; creates configuration, nobody's work.
- Mark: none; nearest today: none; tells Instances apart under one gh user: no; under different gh users: no

### S1-21 pull.md: the reads the controller is told to expect from a Pull
- Where: `plugin/skills/run-team/references/pull.md:19-27` (`inflight.sh <N>` "In-flight check, again"), `:46-48` (`gh issue view <N> --json title,body,comments,labels,createdAt`), `:220-236` (open-PR and live-branch collision scan), `:308-313` (labels re-read at the Pull), `:337-355` (exclusion premise reads, `gh pr view` / `gh issue view`)
- Kind: instruction-read
- Does: describes, for the controller to read when a step refuses or an answer needs more, the S1-1..S1-3, S1-7, S1-8, S1-9 reads.
- Scope today: repo-wide (collision scan, in-flight), per-object from the shortlist head (issue read), per-object from ledger premises
- Feeds / Selected by: Feeds: the answers to Q3 (`behind-pr:#M`) and the PR-less branch-name premise (`:339`). Selected by: the Pull driver (`pull.mjs`).
- Exists because: see S1-1, S1-7, S1-8.
- Own-work limit: as those entries. The text itself says: "A free verdict is not evidence that nobody is editing the ticket's target files" (`:40-41`); and "a block ... `behind-pr` on [a PR the scan could not read] is taken" (`:235-236`).
- Mark: PR / issue; nearest today: head branch name; tells Instances apart under one gh user: no; under different gh users: no

### S1-22 pull.md: relabel and close instructions on an unclaimed ticket
- Where: `plugin/skills/run-team/references/pull.md:57-60` (torn → relabel `ready-for-human`), `:76-87`, `:99-102` (already fixed → "close it citing the commit"), `:291-297` (Pull table), `:315-335` (`gh issue edit <N> --remove-label "<ready-for-agent string>" --add-label "<label string>"`, preceded by exactly one comment rendered by `dispatch-prompt.mjs render relabel --kind <kind>`)
- Kind: instruction-write
- Does: tells the controller to comment on and relabel an unclaimed ticket, or to close it citing the commit. It runs through `pull.mjs` answers (S1-10, S1-11, S1-12); `:318-320` says the stranded-ruling comment is `pull.mjs`'s own.
- Scope today: no precondition (per-object from the shortlist head; "An unclaimed ticket is yours to reclassify at the Pull", `:315`)
- Feeds / Selected by: Selected by: the Pull's Q1/Q2 answers on ticket N. Feeds: ticket leaves the supply.
- Exists because: `pull.md:332-335` (see S1-11).
- Own-work limit: only a ticket this Instance pulled and no other Instance holds; unknown → stall. The text's premise "unclaimed" is read from nothing: the Pull never reads `in-progress` (S1-7).
- Mark: issue; nearest today: ready-for-agent / ready-for-human / needs-triage labels; tells Instances apart under one gh user: no; under different gh users: no

### S1-23 pull.md: the claim instruction
- Where: `plugin/skills/run-team/references/pull.md:248-249` (`claim-ticket.sh <N> impl-<N> implementer --apply`, "Exit 2 → treat it as taken"), `:298`, `:359-366` ("The two arguments are always that literal pair"), `:392-396` ("Claim what you are about to dispatch; dispatch what you have just claimed")
- Kind: instruction-write
- Does: tells the controller that the Pull's claim step is S1-13 and that its exit 2 means taken.
- Scope today: no precondition (S1-13)
- Feeds / Selected by: Selected by: the collision answer `clear`. Feeds: S1-13.
- Exists because: see S1-13; `:395-396` a claim run ahead of its dispatch leaves "a worktree, a branch and an `in-progress` label with no member behind them".
- Own-work limit: as S1-13.
- Mark: issue (label) and branch; nearest today: in-progress label and head branch name `implementer/<N>-impl-<N>`; tells Instances apart under one gh user: no; under different gh users: no

### S1-24 pull.md: the In-flight bound counts open PRs
- Where: `plugin/skills/run-team/references/pull.md:599-620` ("B caps live review units (≤ open PRs ≤ B)"; "those PRs count as In flight because they sit between Claim and merge")
- Kind: instruction-read
- Does: describes the In-flight bound B (default 5) as a cap on open PRs / live review units; the count itself is made by the tick (other slice).
- Scope today: repo-wide as described (open PRs of the repository), informing only in this file
- Feeds / Selected by: Feeds: the tick's `--in-flight` (`pull.md:601-602`) and so how many Pulls run per tick. Selected by: `$ARGUMENTS`.
- Exists because: `pull.md:605-609`: the level is set by load (review concurrency).
- Own-work limit: "own work only covers ... the In-flight bound" (contract): a count of PRs/claims that are not this Instance's own shrinks this Instance's supply of Pulls; the count must be limited to this Instance's own PRs and claims. The count's code is in `fleet-tick.mjs` (not this slice).
- Mark: PR; nearest today: author login (tick slice) / head branch name; tells Instances apart under one gh user: no; under different gh users: yes (author) [INFERENCE: from contract text; count code not in this slice]

### S1-25 relabel.md: the comments a relabel or a close files on a ticket
- Where: `plugin/skills/run-team/briefs/relabel.md:7-24` (`## kind: needs-triage`, `fork`, `hands`, `covered`, `fixed`)
- Kind: instruction-write
- Does: the five comment bodies the controller files on a ticket: `*Relabelled by the fleet controller.* Pulled for implementation and returned: …` and `*Closed by the fleet controller.* Pulled for implementation and found already fixed on origin/main: <detail>.` The `covered` kind (`:17-21`) names "an open pull request" and tells maintainers "Close this issue when that pull request merges, or restore `ready-for-agent` if it closes unmerged."
- Scope today: per-object from the ticket the controller passes (`pull.md:323`; bails via `plugin/scripts/fleet-event.mjs:427-438`, `:244-245`, `:483`, `:515-517`, other slice)
- Feeds / Selected by: Selected by: Pull Q2 answers and implementer bails (`covered`/`fixed`, `plugin/agents/fleet-implementer-slow-high.agent.md:54-58`). Feeds: comments on tickets.
- Exists because: the label is how a Pull surfaces a ticket to the maintainer (`pull.md:57-59`).
- Own-work limit: only a ticket this Instance pulled or claimed.
- Mark: comment; nearest today: fleet comment markers `*Relabelled by the fleet controller.*` / `*Closed by the fleet controller.*`; no run, member, ledger token or Instance in any of the five; tells Instances apart under one gh user: no; under different gh users: no
- Notes: `covered` names another PR in `<detail>` (`PR#M — <how M's diff meets N's acceptance>`, `agent.md:57`), so a comment about another Instance's PR is written onto the ticket.

### S1-26 Implementer: "already covered by an open PR M you find"
- Where: `plugin/agents/fleet-implementer-slow-high.agent.md:56-58` ("Already covered by an open PR M you find → bail with `bailCause` `covered` … PR M is never edited"); the same body in the four other implementer definitions
- Kind: instruction-read
- Does: tells the implementer to bail when it finds an open PR that covers the ticket. No command is named to find one.
- Scope today: repo-wide (open PRs of the repository; command left to the member)
- Feeds / Selected by: Feeds: the `covered` bail → relabel comment (S1-25) and label write (`fleet-event.mjs:244`, other slice).
- Exists because: a ticket already covered by an open PR must not be implemented twice (`agent.md:50-61`).
- Own-work limit: informing only ("PR M is never edited"); a PR found that is not this Instance's own may only be reported, never touched.
- Mark: PR; nearest today: none (the member picks any open PR); tells Instances apart under one gh user: no; under different gh users: no

### S1-27 Implementer: push the claim branch, open the PR, label it, write body markers
- Where: `plugin/agents/fleet-implementer-slow-high.agent.md:42` (`gh issue view <N> --json title,body,comments --jq …`), `:222-229` (push, `gh pr create` with `Closes #N` in the body, `gh pr edit --add-label` as its own command with one release label), `:229-236` (PR body line `Sizing: light|heavy — <signal>`), `plugin/skills/run-team/briefs/implementer.md:14-19` ("commit on [<branch>] and open your PR from it ... the settle refuses a PR from any other branch"; if the ticket names another branch, "say in the PR body that you used `<branch>`"), `plugin/skills/sizing-a-ticket/SKILL.md:13` (`gh issue view <N> …`)
- Kind: instruction-write
- Does: the member pushes `implementer/<N>-impl-<N>` (via `next-ticket` step 7, S1-19), opens the PR, adds a release label (`patch`/`minor`/`major`), puts `Closes #N` and a `Sizing:` line in the body.
- Scope today: per-object from the member's own branch and own PR (the brief hands it `<branch>`)
- Feeds / Selected by: Selected by: the dispatch brief (`pull.mjs:992-996`: `--branch implementer/${ticket}-${member}`). Feeds: the PR the controller later settles (other slice).
- Exists because: the PR is the deliverable; `Sizing:` is read as a covariate (`agent.md:235-236`).
- Own-work limit: only this Instance's own branch and PR; the brief hands it both.
- Mark: branch/PR body; nearest today: head branch name `implementer/<N>-impl-<N>` and closing reference `Closes #N`; body marker `Sizing: light|heavy — <signal>` names neither run nor member; tells Instances apart under one gh user: no; under different gh users: no
- Notes: `gh issue view <N>` at `agent.md:42` and `sizing-a-ticket/SKILL.md:13` reads the member's own claimed ticket (own-only after claim; also listed in Checked). The five implementer definitions differ only in `name`, `description` and `model` lines (`diff` against slow-high: lines 2-4 only), so these entries cover `fleet-implementer-slow-medium`, `-smol-high`, `-task-high`, `-task-max` too.

### S1-28 slice-fill: read the bodies of every ticket named in the committed features corpus
- Where: `plugin/scripts/slice-fill.mjs:89` (`ghAliasedRead(tickets, { field: "issue", selection: "{body}", … })`), `:83` (tickets from `parseFeatures(text)` of `docs/metrics/ticket-features.tsv`, `:31`), `plugin/scripts/gh-aliased-read.mjs:61` (`gh api graphql … repository{ n<N>:issue(number:<N>){body} }`, other slice's file)
- Kind: read-inform
- Does: reads the body of each distinct ticket number in the corpus, in aliased GraphQL batches, and writes `parent` into the corpus file; the corpus is a committed file that Close-out PRs append to, so its rows come from every Instance's runs once merged.
- Scope today: per-object from corpus rows (tickets of any run, any Instance); read-only on GitHub, writes a local file
- Feeds / Selected by: Feeds: only `docs/metrics/ticket-features.tsv` (`:98-101`). Selected by: corpus rows.
- Exists because: `plugin/scripts/slice-fill.mjs:2-3`: "so the Router's fit reads every Slice as a Slice".
- Own-work limit: a read of ticket bodies for statistics, no write to GitHub; no limit needed beyond its being read-only.
- Mark: none; nearest today: none; tells Instances apart under one gh user: no; under different gh users: no
- Notes: no caller in `plugin/` invokes it (grep `slice-fill`: only its own header and docs); run by hand [INFERENCE: from absence of callers].

---

## Checked, own-only or config
- `plugin/scripts/pull.mjs:1171`, `:657`, `:976`, `:1004`, `:1134` — `ledger.mjs read|row|dispatch`: the host-local ledger; not GitHub (the row at `:1134` is the exclusion S1-8 writes; no GitHub effect).
- `plugin/scripts/pull.mjs:1217` — reads `.fleet/shortlist.json`, a host-local file written by `shortlist.mjs`.
- `plugin/scripts/pull.mjs:856-858`, `:888-899` — `git worktree list --porcelain -z`, `git for-each-ref refs/heads`, `git diff origin/main...<branch>` over this clone's linked worktrees; a clone's worktrees belong to its one Instance (the scan of other Instances' PRs is S1-8).
- `plugin/scripts/pull.mjs:727`, `:733`, `:912` — `git cat-file blob <rev>:<path>`, `git merge-base origin/main <rev>`: reads of `origin/main` content and merge bases; config/content, nobody's work.
- `plugin/scripts/pull.mjs:829` — `git log -1 --format=%s <commit>` in this clone.
- `plugin/scripts/pull.mjs:1054` — `staleness.mjs`: reads `origin/main` only (`pull.md:193-195`); content read.
- `plugin/scripts/pull.mjs:955` — `release-ticket.sh <N> impl-<N> implementer --apply` after the router refused, on the claim this Pull just made; own claim by number; the script's own reads and writes (ls-remote, label read, label drop) belong to another slice.
- `plugin/scripts/pull.mjs:950` — `ticket-router.mjs route`: local, no GitHub (see no-GitHub list).
- `plugin/scripts/pull.mjs:992` — `dispatch-prompt.mjs render`: local.
- `plugin/scripts/pull.mjs:1259`, `:1263`, `:1269` — `git rev-parse --show-toplevel`, `scratch-root.mjs`, `readLabelMap` (reads the Label map; config).
- `plugin/scripts/claim-ticket.sh:197`, `:199` — `derive-testcmd.sh . install|test --at origin/main`: Recipe cache and `origin/main` content; config.
- `plugin/scripts/claim-ticket.sh:274` — `label-map.mjs show in-progress`: Label map; config.
- `plugin/scripts/claim-ticket.sh:318`, `:331` — `git worktree add --no-track … -b … origin/main` and the Install step: this clone's own worktree; no push, no fetch.
- `plugin/scripts/inflight.sh:132-133`, `:442` — `net.sh` helpers and the timeout budget; local.
- `plugin/scripts/candidates.mjs:141` — `readLabelMap()`; config.
- `plugin/scripts/shortlist.mjs:201` — `ledger.mjs read`; local.
- `plugin/scripts/shortlist.mjs:339-344` — writes `.fleet/shortlist.json` (host-local).
- `plugin/scripts/ticket-router.mjs:672` (`gitBeside`), `:683`, `:692` — `git rev-parse` / `git show <sha>:<tsv>` against the local object store for the offline fit; `:811` only names a `git fetch --depth=1 origin <sha>` for a human; never run by the script.
- `plugin/scripts/ticket-router.mjs:761-784` — appends the Pull's feature row to `ticket-features.pending.tsv` beside the guard in `.fleet/` (host-local).
- `plugin/skills/next-ticket/SKILL.md:107` — `git fetch origin && git rebase origin/main`: refreshes `origin/main` content; no GitHub write.
- `plugin/skills/next-ticket/SKILL.md:110`, `:113` — `gh pr create`, `gh pr edit --add-label`: the session's own PR from its own branch (own-only; the push is S1-19).
- `plugin/skills/next-ticket/SKILL.md:63`, `plugin/skills/sizing-a-ticket/SKILL.md:13`, `plugin/agents/fleet-implementer-slow-high.agent.md:42` — `gh issue view <N> …` on the ticket the session or member already claimed: own-only after a claim.
- `plugin/skills/run-team/briefs/implementer.md:29-52`, `:70-77` — `recipe-check.mjs`, `report-schema.mjs`: local files.
- `plugin/skills/run-team/references/pull.md:168-216`, `:360-388` — `staleness.mjs` and the Recipe/runner: `origin/main` content and this clone's worktree.
- `plugin/skills/run-team/references/pull.md:398-418`, `:420-437` — `ledger.mjs dispatch`, `dispatch-prompt.mjs render`: local.
- `plugin/skills/run-team/references/pull.md:268-282`, `:440-682` — router arguments, tiers, fit and metrics prose; no GitHub reads or writes (the only GitHub mention, `:599-620`, is S1-24).
- `plugin/skills/sizing-a-ticket/SKILL.md:20` — scratch path under `<scratch>/impl-<N>/`; local.

## Files with no GitHub access
- `plugin/scripts/ticket-router.mjs` (header `:42-44`: "The script never touches the network"; only local `git` at `:672`)
- `plugin/scripts/router-table.json`
- `plugin/scripts/ticket-text.mjs`
- `plugin/scripts/pull-attribution.mjs` (pure; takes a `prs` argument that its callers fill, `:295`)
- `plugin/scripts/closing-refs.mjs`
