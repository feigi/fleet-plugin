# Which plugin paths touch GitHub work that isn't the Instance's own?

Task for `feigi/fleet-plugin` issue #4217, under the map #4212 ("Several fleet
Instances on one repository: own work only, never colliding — any machine, any
gh user"). Code reading of every file under `plugin/` at `origin/main`
1a9692aa (2026-11-02), plus `CONTEXT.md` and `docs/adr/` for the claim-branch
rules. No plugin script was run and no GitHub request was made; the one
measurement (§ Measured) used a local bare repository. Every `file:line` is a
line at 1a9692aa; `cmd` is `plugin/commands/run-merge-bot.md`. Anything not
read in code or measured is marked **[INFERENCE]**.

## TL;DR

- **Ownership is tested in one place.** `owned-pr.mjs:32-34` (author login
  equals `gh api user`, not a draft) is read by the phase-0 Fold-in
  (`phase0.mjs:438`) and the tick's review-due (`fleet-tick.mjs:1195`), and by
  nothing else. Every other path selects by a label, a branch name, a number
  the controller passes, or this checkout's ledger, which no other Instance can
  read.
- **Under one shared gh user, nothing on GitHub tells Instances apart.** The
  plugin never reads or writes an assignee. The `in-progress` label, every
  branch name the fleet cuts (`implementer/<N>-impl-<N>[-x]`,
  `<type>/<N>-<slug>`, `chore/run-artifacts-<yyyymmdd>[b-z]`) and every
  comment or body marker it writes (`ready-to-merge-head: <sha>`,
  `*Relabelled by the fleet controller.*`, `*Closed by the fleet controller.*`,
  `**<member> halted: …**`, `Closeout: <reason>`, `Deferred from PR #<pr> review`)
  name no Instance, run or user. The author login separates different gh users
  only, and only the two readers above use it.
- **Where another Instance's work enters.** Every downstream write inherits the
  scope of one of these selecting reads:
  - the Fold-in and the tick's open-PR list feed review, fix and finish (login-wide; P12, P15, P16);
  - the merge queue feeds the Pass's rebase, merge, `in-progress` drop and branch delete (label-wide; P17, P32–P38);
  - the In-flight count and the run-over gate (repo-wide; P18, P20);
  - the stranded-claim scan feeds resume and "release by hand" advice (label-wide `in-progress`, repo-wide PRs; P13, P14);
  - the CI watcher feeds `ci=` tokens and finisher dispatch (repo-wide; P24);
  - the tracker search behind every filing feeds comments on a found issue (repo-wide; P27);
  - the cockpit board and the cost guard (repo-wide; P40, P42).
- **Writes with no ownership precondition**, each able to land on another
  Instance's work today:
  - the claim's label add (P8);
  - the Pull's close, comment and relabel, all before any claim (P7);
  - the bail relabel, close and release (P11);
  - release's unleased remote branch delete and its label drop (P23);
  - the controller's PR body edits, label removals and comments (P21);
  - the fix-applier's push and body overwrite (P26);
  - the finisher's `patch`, head record and `ready-to-merge` (P29);
  - the merge bot's rebase with no head pin, its merge without `--match-head-commit`, its `in-progress` drop found by a commit-message scan, and its remote head delete (P34, P36–P38).
- **A claim is invisible to another Instance until its first push, and that
  push does not stop a double claim.**
  - `claim-ticket.sh:286` adds `in-progress` with no read first and leaves `ready-for-agent` on.
  - Nothing a Pull runs reads `in-progress` on the head it is taking. The issue gate (`pull.mjs:814`) checks `ready-for-agent` only, `unclaimed()` checks this ledger only, and the In-flight probes read PRs, origin's branches and this clone's refs. The candidate scan excludes `in-progress`, but only when the Shortlist is refreshed (P1–P4, P8).
  - The implementer's first push is `git fetch origin && git rebase origin/main` then a bare `git push --force-with-lease -u origin HEAD` (`next-ticket/SKILL.md:107-109`). After that fetch the lease matches whatever the other Instance pushed, and the push replaces it: measured below. So on a double claim the later push wins and the earlier branch is overwritten.
- **Reads of everyone's work that keep the fleet safe** stall rather than
  collide: the In-flight probes (any PR or branch about N means taken), the
  collision scan, the Exclusion premises, and the branch-keep lookups before a
  remote delete. None of them can recognise this Instance's own work (P3, P5,
  P6, P38).
- **Other Instances' work stalls this one.** The In-flight count holds Pulls
  (P18). Close-out waits until no PR is open anywhere in the repository (P20).
  A labelled PR this merge bot did not judge fails its settle (P32). Any open
  PR stretches the merge bot's grace (P33). A similar issue anywhere blocks a
  filing (P27).
- **No merge-bot hold behind lower unlabelled PRs exists on main.**
  `cmd:24-30` says "A labelled PR never waits on an open PR without it,
  however related their work". The only order is lowest number first among
  labelled PRs. The read-versus-touch ticket's example of a hold rule
  describes no current code.
- **26 rules assume a claim branch stays unpushed until the member's first
  push** (§ Rules). If the claim branch were on origin from claim time:
  - every claim would be in release's "pushed branch" shape, so every bail, drain and router refusal would end in `NEED hand-release` (R4, R5);
  - reap's no-upstream arm would keep the branch for a different reason (R7);
  - `[gone]` would follow any remote delete of the branch (R8).

## How to read the tables

Each row is one **path**: a selecting read with the writes that hang off it,
or one write. **Entries** names the detailed records under
[`own-work-paths/`](own-work-paths/), 174 entries in all (51 selecting reads,
14 informing reads, 28 writes, 35 prompt-surface reads, 46 prompt-surface
writes). Each entry gives the verbatim command, its scope, what it feeds or
what selected it, the code's own reason, the limit and the mark.

- **Where**: the call site at 1a9692aa.
- **Why it exists**: what breaks without it, from the code's own comments.
- **Own-work limit**: what the path would have to be limited to so it only
  ever reads or acts on this Instance's own work, and what it does when
  ownership is unknown (stall, per the map's standing decision 2).
- **Mark**: the object that would carry ownership · the nearest mark it has
  today · whether that mark tells Instances apart under one shared gh user /
  under different gh users.

## Marks that exist today

| Mark | Carried on | Read as an ownership test by | One gh user | Different gh users |
|---|---|---|---|---|
| author login | PR, issue, comment | `owned-pr.mjs:32-34`, from the Fold-in (`phase0.mjs:438`) and review-due (`fleet-tick.mjs:1195`) only. The merge queue, finisher, merge bot, release, reap, stranded scan and CI watcher never request it | ✗ | ✓ |
| head branch name | branch, PR | release, reap, stranded scan, In-flight probe, merge bot, Close-out. It names the ticket (`implementer/<N>-impl-<N>[-x]`) or the date (`chore/run-artifacts-<yyyymmdd>[b-z]`), never an Instance | ✗ | ✗ |
| `in-progress` label | issue | excluded by the candidate scan (`candidates.mjs:450`); read by the stranded scan, release, the merge bot's drop and the stall count; not read by the Pull, `unclaimed()`, the In-flight probes or the cockpit pool | ✗ | ✗ |
| assignee | issue, PR | nothing: the plugin never reads or writes it | — | — |
| closing reference (`Closes #N`) | PR → issue | In-flight count, settle, finisher gate, `drop-merged-label.sh`, `tier-outcomes.mjs`. It ties a PR to a ticket, not to an owner | ✗ | ✗ |
| `ready-to-merge`, `patch`/`minor`/`major`, `onhold` | PR, issue | merge queue, finisher, merge gate. They record state, not owner | ✗ | ✗ |
| fleet comment and body markers | comments, bodies, titles | `ready-to-merge-head: <sha>` is read from any commenter (`finisher-label.mjs:236-242`, `cmd:39-41`); fleet comments are deduplicated by exact body against every comment (`fleet-event.mjs:396`) | ✗ | ✗ (author not read) |
| ledger tokens | `.fleet/ledger.md`, not GitHub | `unclaimed()`, `fixDue`, CONFLICT rows, finisher rows, the Ruling gate | this clone only | this clone only |

## Paths

### Claims and the Pull

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P1 Candidate scan and Shortlist.** Every open `ready-for-agent` issue, with `in-progress` and `onhold` excluded server-side, oldest first. Refreshed only on triggers: low-water mark, empty list, lifted premise. | `candidates.mjs:463` (query `:424-460`, exclusion `:450`); refresh `fleet-tick.mjs:1958-1966`, `:2361-2382` | The supply of unclaimed tickets. The label exclusion is what hides claimed tickets. | None for the read: the pool belongs to nobody yet. Between refreshes, a ticket another Instance claims stays at the head of this Instance's list, so acting on it depends on P4 and P8. | issue · `in-progress` · ✗ / ✗ | S1-4, S1-14, S2-10, S2-16, S3-9, S3-15 |
| **P2 `unclaimed()`.** A Shortlist head counts as claimed only if this ledger has an `impl-` row or an Exclusion for it. | `fleet-tick.mjs:1273-1278` (`claimed` built `:1015`, `:1028`) | Keeps the tick from Pulling its own claims again. | Must also count any other Instance's claim, which only GitHub can show. Unknown → no PULL row. | issue · none on GitHub (ledger) · ✗ / ✗ | S3-10 |
| **P3 In-flight check.** Taken = any PR about N (its closing references, then full-text `gh pr list --state all --search N`), any branch on origin with N as a path segment, or a local branch or worktree for N. | `inflight.sh:269-270`, `:305-306`, `:450`, `:500-507`, `:557-785` | "a wrong 'taken' costs one skipped ticket, a wrong 'free' puts two agents on one ticket" (`:339-341`); "a branch can exist with no PR yet, and a worktree can exist before anything is pushed" (`:4-7`). | Stays a read of everyone's PRs and branches: any hit stalls. It never reads `in-progress`, so another Instance's claim is invisible until its first push. It cannot tell this Instance's own PR or branch from another's. | PR, branch · head branch name, closing reference · ✗ / ✗ (the local probe sees this clone only) | S1-1, S1-2, S1-3, S1-15, S1-21 |
| **P4 Pull issue gate.** Reads the ticket with its comments and leaves only when `ready-for-agent` is gone. It never reads `in-progress`, and a claim leaves `ready-for-agent` on, so another Instance's claim passes. | `pull.mjs:797`, `:814`; `claim-ticket.sh:286` | "The shortlist file can be older than a relabel" (`pull.md:308-313`). | Must see any other Instance's claim on N and stall. | issue · `in-progress` (not read) · ✗ / ✗ | S1-7 |
| **P5 Collision scan.** Every open PR (cap 200) and its file list; for each PR sharing a path, its diff and head (`git fetch origin pull/<M>/head`); this clone's worktree branches. | `pull.mjs:844`, `:855`, `:871-902`; local branches `:439-443` | A ticket that collides with an open PR or live branch is sequenced behind it (`pull.md:220-236`). | Stays a read of everyone's open PRs: it is a safety read. It cannot tell its own PRs from others' (the author is not requested), and it refuses past 200 open PRs. | PR · head branch name (display only) · ✗ / ✗ | S1-8, S9-23 |
| **P6 Exclusion premises and blockers.** `gh pr view` or `gh issue view <M> --json state` on what a ticket waits behind, and on a candidate's blockers. | `shortlist.mjs:225-244`, `:284-320`; `pull.mjs:1146-1167`, `:1189-1200`; `fleet-tick.mjs:1830-1880` | A ticket sequenced behind an open PR or issue is not Pulled until that is merged or closed (`pull.md:337-343`). An unreadable blocker counts as open (`shortlist.mjs:39-43`). | None: a state read of what is usually someone else's work, acted on by nothing. | none needed | S1-5, S1-6, S1-9, S3-11 |
| **P7 Writes before the claim.** Close as already fixed, the relabel comment, and the swap of `ready-for-agent` for `needs-triage` or `ready-for-human`. All three run on the Shortlist head before the claim step, with no read of `in-progress`. | `pull.mjs:1089`, `:1113`, `:1118`; `SKILL.md:453-457`, `:497`; `pull.md:57-102`; `briefs/relabel.md:7-24` | Q1b closes a provably fixed ticket and Q2 returns an undecided one to triage: "the only writes the fleet makes to a ticket it did not claim" (`pull.md:332-335`). | Only on a ticket no other Instance holds. When another claim is possible or unknown, stall and write nothing. | issue · `in-progress` (not read); the comment markers name no Instance · ✗ / ✗ | S1-10, S1-11, S1-12, S1-22, S1-25, S3-14 |
| **P8 The claim.** `gh issue edit N --add-label in-progress`, then branch `implementer/<N>-impl-<N>` cut `--no-track` from `origin/main`, plus a worktree. No GitHub read first and no fetch; it refuses only on a local worktree path or local branch. Two Instances both label (the add is idempotent) and both cut the same branch name. | `claim-ticket.sh:286`, `:148-153`, `:163`, `:280`, `:317-318` | A Claim is the branch, the worktree and the label together (CONTEXT.md **Claim**). | The label add must be conditional on no other Instance holding N. Unknown → stall. | issue, branch · `in-progress`, head branch name · ✗ / ✗ | S1-13, S1-23, S9-2, S9-3 |
| **P9 The implementer's push and PR.** `git fetch origin && git rebase origin/main`, then `git push --force-with-lease -u origin HEAD`, `gh pr create … Closes #N`, and a release label. After the fetch, the bare lease overwrites a same-named branch another Instance pushed (§ Measured). Bail `covered` when it finds an open PR M covering the ticket. | `next-ticket/SKILL.md:107-113`; `fleet-implementer-slow-high.agent.md:56-58`, `:222-229` (the other four cells match) | The member's one push of its claim (`SKILL.md:116`). | Push only to this Instance's own claim branch, never over a tip it did not push. Reading PR M for `covered` stays a read. | branch, PR · head branch name, closing reference · ✗ / ✗ | S1-26, S1-27, S9-20, S9-21 |
| **P10 Standalone next-ticket.** Candidate scan with `--allow-fallback`, In-flight probe, a bare `--add-label in-progress` after the maintainer's pick, branch naming inferred from `git branch -r`, label removal on abandon, the P9 push, `push-sync` for a detached PR worktree, `label-map.mjs set --create`. | `next-ticket/SKILL.md:12`, `:24`, `:27`, `:58-65`, `:87`, `:92`, `:96`, `:107-113`, `:171` | A solo session claiming outside run-team. The maintainer's pick is its only own-work filter (`:12`). | As P8 for the label add and removal (remove only a label this Instance added). Push only its own claim branch. | issue, branch · `in-progress`, head branch name · ✗ / ✗ | S1-14 – S1-20 |
| **P11 Bail outcomes on the claimed ticket.** On `bailed`: drop `ready-for-agent` and `in-progress`, add `needs-triage` or `ready-for-human`, comment, then `release-ticket.sh --apply`. On `fixed`: `gh issue close N` and strip labels. The ticket is the N in the member name `impl-N`. | `fleet-event.mjs:447-464`, `:469-504`, `:506-522`; `SKILL.md:718-728` | A bailed ticket returns to triage and its claim disappears (`fleet-event.mjs:35-41`). | Only when the `in-progress` on N is this Instance's claim. Otherwise stall (NEED). | issue · `in-progress` · ✗ / ✗ | S4-10, S4-11, S4-12, S3-29 |

### Phase 0: adoption and resume

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P12 Fold-in.** Every open PR (cap 1000; a full page refuses), kept when its author is the gh login and it is not a draft, gets a ledger row `PR#<n> · inherited (…)`. That row queues review, fix, finish and merge. Deduplicated only against this ledger's carried rows. | `phase0.mjs:412-414`, `:423`, `:427-438`, `:451-461`, `:471`; `phase-0.md:513-535` | An Owned PR a prior run left open is reviewable work nothing else picks up (`phase-0.md:522-524`). Measured 2026-09-03: such a PR's review found a defect (`:531-533`). | Adopt only PRs this Instance's earlier runs opened. Unknown → no row. | PR · author login · ✗ / ✓ | S2-1, S2-2, S2-3, S2-13 |
| **P13 Stranded-claim scan.** Every open `in-progress` issue; every open PR, of any author, counts as "the fold-in owns it"; every PR of a local claim's branch name in any state; an issue read and release dry run per disk claim. A claim with no worktree here is reported as `report #N — no worktree for it in this checkout`, with the advice "push the branch and open a PR, or release the claim by hand". The stall report counts every `in-progress` issue. | `stranded.mjs:318-320`, `:322-350`, `:134-151`, `:248-287`, `:376-388`, `:209`, `:423`; `fleet-tick.mjs:2067-2084`; `phase-0.md:545-599` | "a claim a dead run left without a PR is held by nobody until this step names it" (`stranded.mjs:7-12`). | List and report only this Instance's own claims. Another Instance's live claim is neither stranded nor to be released by hand. "The fold-in owns it" holds only for an own PR. | issue · `in-progress` · ✗ / ✗ (PR side: head branch name · ✗ / ✗) | S2-4, S2-5, S2-6, S2-7, S2-9, S2-14, S3-12 |
| **P14 Resume.** When the prior run is dead, one worktree for N sits under this checkout's `.worktrees/` and no PR is mentioned, phase 0 prints `NEED resume #n <worktree> <branch>`. The controller dispatches `impl-<n>-b` there, never through `claim-ticket.sh`: "the claim stands". Nobody checks who holds the label now, so a stale local worktree can resume onto a ticket another Instance claimed since **[INFERENCE from the code]**. | `stranded.mjs:356-369`, `:384`; `phase0.mjs:495-499`; `SKILL.md:73-79`; `phase-0.md:601-621` | Nothing restarts a dead run; the next run resumes it (ADR 0025). | Resume only a claim this Instance made and still holds. Unknown → report, dispatch nothing. | issue · `in-progress` plus the local worktree name · ✗ / ✗ | S2-8, S2-15, S3-16 |

### The tick: which PRs get members

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P15 Open-PR list and the Owned flag.** `gh pr list --state open --limit 200` with author, labels, closing references, head, mergeability and body; `gh api user`; `owned = isOwnedPr(p, login)`. Only review-due reads `.owned`. Feeds P16–P20. | `fleet-tick.mjs:1713-1756` (call `:1716-1717`), `:1702-1712`, `:1751` | One read per tick feeds every PR row. | Every consumer keeps only this Instance's PRs. Unknown → skipped everywhere. | PR · author login · ✗ / ✓ | S3-1, S3-2 |
| **P16 Review-due, then fix and conflict rows.** Review-due = not queued, owned, and no `reviewed=` on THIS ledger → `DISPATCH review`, then fix-appliers and finishers follow. `fixDue` and CONFLICT rows take this ledger's PRs that are still open. `working()` reads only this ledger. | `fleet-tick.mjs:1194-1197`, `:418`; `fixDue` `:1181-1185`; CONFLICT `:1121-1125`, `:443-452`; `working()` `:1119`; `SKILL.md:225-229` | Every Owned PR gets one review (ADR 0034). | Only PRs this Instance created or adopted. "No review on this ledger" is not "no review". Under one gh user, each Instance reviews, fixes and finishes the other's PRs today. | PR · author login · ✗ / ✓ (the ledger keys are local) | S3-4, S3-5, S3-6, S3-17, S3-18 |
| **P17 Merge-queue dispatch.** Any open PR carrying `ready-to-merge` is queued; no author, ledger or Owned test → `DISPATCH merge-bot`. The label Monitor "catches hand-added labels as well as a finisher's own". | `fleet-tick.mjs:1098-1099`, `:1198-1207`, `:478`; `SKILL.md:135`, `:165-184`, `:230`; `ci-and-staleness.md:185-191` | The label is the author's sign-off (`cmd:11`); one Pass drains the queue. | Dispatch only for a labelled PR this Instance owns and labelled. | PR · `ready-to-merge` · ✗ / ✗ | S3-7, S3-19, S3-24, S7-5 |
| **P18 In-flight count.** `inFlight` adds this ledger's live implementers to every open PR in the repository with a closing reference, of any author. Reaching the bound prints `HOLD (in-flight n/B)`. | `fleet-tick.mjs:1092-1093`, `:1097`, `:1151-1153`, `:386-389`, `:2360`; `pull.md:599-620` | The In-flight bound caps live work; a PR counts because it "sit[s] between claim and merge". | Count only this Instance's claims and PRs. Today other Instances' PRs hold this Instance's Pulls (a stall). | PR · closing reference · ✗ / ✗ (author not applied) | S3-3, S1-24 |
| **P19 Finisher rows.** A PR whose latest finisher on this ledger settled `labelled`, but that the open list shows without `ready-to-merge` → `DISPATCH finisher`, then `ESCALATE`. The controller also picks M from CI events and fix-applier no-op reports. | `fleet-tick.mjs:1209-1210`, `:730-734`, `:659-670`; `SKILL.md:231`, `:525-630`; `finisher.md:45-101` | A label that went missing after a finisher set it means the finisher missed. | Keyed by this ledger already. It must not read a label another Instance's controller removed as its own finisher's miss. | PR · `finisher-pr-M` ledger token (local) · ✗ / ✗ | S3-8, S3-20, S5b-12 |
| **P20 Run-over gate.** `over = draining && prs.length === 0 && implLive === 0` over the repo-wide list. `closeout.mjs finish` fails (exit 3) until the tick prints `ACTION: run over`. | `fleet-tick.mjs:2422`; `closeout.mjs:287-294`; `close-out.md:18-19` | `finish` closes the run once the tick says it is over (`closeout.mjs:10-12`). | "No open PR" must mean none of this Instance's own. Today any open PR in the repository holds this Instance's close-out, and its metrics rows with it. | PR · author login (`owned` exists, unused here) · ✗ / ✓ | S8a-4 |
| **P21 The controller's own PR writes.** It removes `ready-to-merge` after a `label-off=` token, repairs a body (`gh pr edit --body-file`) for its ruling or a main-gain acknowledgement, adds or removes a release label, comments halts and escalations, and closes and reopens a desynced PR. The target is whatever PR the tick, gate or bot names; there is no ownership test. | `SKILL.md:388`, `:562`, `:617-619`, `:639-642`, `:746-747`, `:787-788`, `:794`; `finisher.md:122-123`, `:303-319`; `cmd:126-128` | Each repairs a refusal the gate or a member reported. | Only on PRs this Instance owns. | PR · none · ✗ / ✗ | S3-21, S3-22, S3-23, S5b-9, S5b-10, S5b-11, S5a-19 |
| **P22 Reap after a merge pass.** `reap.sh --apply` runs after any merge pass of this ledger settles `done`. It does `git fetch --prune origin` over every branch, then one GraphQL lookup of MERGED PRs by head-branch name, which does not read the author. The deletes are local only: branch, config and worktree. No remote delete, no label write. | `fleet-tick.mjs:1995-2013`, `:2307-2320`; `reap.sh:274`, `:859-871`, `:965-997`, `:1599`, `:1676`, `:1706`, `:1993`; `SKILL.md:175-184` | A merged branch's worktree otherwise reads as a live claim and the queue shrinks (`reaping.md:9`). | The local deletes already touch only this clone. The verdicts must name this Instance's own branch or PR: `[gone]` only says someone deleted origin's branch, and another Instance's merge bot or release does that too. | branch · head branch name (plus the commit tie) · ✗ / ✗ | S3-13, S3-27, S6-6, S6-7, S6-8, S6-11 |
| **P23 Release.** `ls-remote` by the claim branch name; `gh pr list --state all --head <branch>` of any author; the issue's labels; then `git push origin --delete refs/heads/<branch>` with no lease (closed-PR mode, `:1489-1492`) and `gh issue edit --remove-label in-progress`. Ownership is the caller's `<issue> <slug> <type>` alone, and closed-PR mode needs no local branch. Callers: bail, drain and close-out `begin`, router refusal, and "release the rest by hand". | `release-ticket.sh:236`, `:883-907`, `:948-951`, `:996-1002`, `:1262`, `:1311-1314`, `:1509`, `:1525`; `fleet-event.mjs:519-521`, `:842-863`; `closeout.mjs:270`; `pull.mjs:955`; `SKILL.md:389`, `:816-817`; `close-out.md:11-16` | A released claim reads as free again. "All three artefacts or none" (`reaping.md:67`). | Only this Instance's own claim and branch. Unknown → stall, nothing deleted. | issue, branch · `in-progress`, head branch name · ✗ / ✗ | S6-1 – S6-5, S4-12, S4-16, S3-28, S8a-8 |

### Review, fix and CI

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P24 CI watcher.** `gh pr list --state open --limit 200` with no filter, then `ci-state.mjs --pr` for every listed PR. A terminal run books `ci=<run>:<attempt>:<conclusion>` on the PR's ledger row (`#M` when no ticket row names it), which wakes the finisher path. Each listed PR reserves 4 core REST units from a budget that "is one account" (`ci-watcher.md:13`), which Instances under one gh user share. | `ci-watcher.md:13`, `:28`, `:40-43`, `:81`, `:93`; `fleet-event.mjs:812-819`; `SKILL.md:134`; `ci-and-staleness.md:14-31`; `shell-traps.md:24-30` | CI completion is what dispatches a finisher. | Watch only this Instance's own PRs. | PR · none (author not requested) · ✗ / ✗ | S7-1 – S7-4, S3-25, S2-20 |
| **P25 Review snapshot.** `gh pr diff` and `gh pr view` keyed on the `pr` argument, which is checked only to be digits. | `review-core.mjs:1153-1163`, `:1034`; `diff-stats.mjs:235` | The review reads the PR it was handed (selected by P16). | Only an own PR. | PR · none · ✗ / ✗ | S7-6 |
| **P26 Fix-applier writes.** A push through `push-sync.mjs`, `git push [--force-with-lease] origin HEAD:refs/heads/<branch>`; the pre-push `ls-remote` does not gate it. Also a whole-body `gh pr edit --body-file` and one PR comment listing the filed issues. The target is whatever PR and branch the brief names. | `push-sync.mjs:100-109`, `:172-183`; `briefs/fix-applier.md:96`, `:100`; `fleet-fix-applier.agent.md:348`; `review-and-fix.md:22`, `:25`, `:113` | Applies a review's findings to the PR. | Only this Instance's own PR head and body. Never push over or rewrite what another Instance owns. | branch, PR · head branch name · ✗ / ✗ | S7-8, S7-9, S7-14, S6-9, S6-10 |
| **P27 Filing through the tracker search.** `ledger.mjs check` runs `gh issue list --search <words> --state all --limit 6` before every `gh issue create`. A match blocks the filing, or the member comments on the found issue instead. The suggestion-band record issue is found by its title `PR #<pr> review: the suggestion band, checked`. `dispositions-check` reads back each recorded issue. | `ledger.mjs:1330-1335`; `ledger.md:32-59`; `review-and-fix.md:25-27`; `fleet-finisher.agent.md:92-110`; `dispositions-check.mjs:727`; `instruments.md:76-88` | No duplicate issues: a closed duplicate still counts. | The search may read every issue, since duplicates are repo-wide. Strictly own-only, a comment would land only on an issue this Instance filed. | issue · none (author not requested) · ✗ / ✗ | S4-1, S4-2, S5b-7, S5b-8, S7-10 – S7-13, S7-15, S2-19 |
| **P28 Standalone `/review-and-fix`.** Acts on the PR number the user names: review, push, body edit, comments, head record, `ready-to-merge`, and `label-map.mjs ensure` / `set --create`. | `review-and-fix.md:3`, `:10`, `:14`, `:22`, `:28` | A human-driven review outside run-team; the human's choice is the filter. | Refuse or stall on a PR another Instance owns. | PR · none · ✗ / ✗ | S7-7, S7-16, S7-17 |

### Finisher

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P29 Finisher writes.** `gh pr edit --add-label patch` on a Ticketless PR, `gh pr comment --body "ready-to-merge-head: <pin>"`, `gh pr edit --add-label <ready-to-merge>`. `--pr` and `--pin` come from the brief. The Ticketless test reads this Instance's ledger, so another Instance's PR that says only `Refs #N` reads as Ticketless here: that unlocks `patch` and skips the acceptance mutation. | `finisher-label.mjs:217`, `:245`, `:256`; `ticketless.mjs:82-115`; `briefs/finisher.md:4`, `:15`; `fleet-finisher.agent.md:271-289` | The finisher's sign-off that the audited head may merge. | Only an own PR. Unknown → stall, nothing written. | PR · `ready-to-merge`, the head-record comment · ✗ / ✗ | S5b-1, S5b-2, S5b-3, S5b-6 |
| **P30 Head records read from anyone.** The finisher and the merge bot take the newest `ready-to-merge-head: <sha>` comment whoever posted it ("nor who posted the record", `cmd:63`), with a timeline fallback. Another Instance's record or label makes this finisher skip its writes and exit 0, and makes the bot trust a head another Instance audited. | `finisher-label.mjs:199-200`, `:236-242`, `:255`; `cmd:36-42`, `:50-59` | "A GitHub label does not follow the branch" (`cmd:34`): the record binds the label to the audited tree. | Trust only a record this Instance's finisher posted. | comment · body `ready-to-merge-head: <sha>` · ✗ / ✗ | S5b-4, S5a-7, S5a-8 |
| **P31 Settle and finisher-dispatch checks.** Settle reads the PR, branch and head a member reported: `implementer/N-impl-N`, `Closes #N`, OPEN. The finisher gate reads PR M's closing references, the title of each issue it closes, its release labels and, at settle, its labels. None of these reads `in-progress` or tests that M is this Instance's. | `ledger.mjs:2856-2872`, `:2879-2909`, `:2395-2410`, `:2150-2178`, `:2192-2210`, `:2928-2934` | A member's report is believed only against GitHub. | M and the reported branch must be own. Unknown → refuse. | PR · head branch name, closing reference · ✗ / ✗ | S4-6, S4-7, S4-8, S4-9 |

### Merge bot

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P32 The Pass's queue.** At dispatch, `gh pr list --state open --label <ready-to-merge> --limit 1000 --json number` is recorded as `queued=`. The bot merges every open labelled PR, lowest first, re-evaluating after each, with a 60 s grace poll and a persistent Monitor. Settle fails (exit 3) if any queued PR is still open and labelled without a verdict. | `ledger.mjs:2234-2260`, `:2943-2963`; `cmd:9`, `:24-30`, `:67`, `:260`, `:301-302`, `:324-370`; `fleet-merge-bot.agent.md:11-15`; `ledger.md:83` | "Only `ready-to-merge` PRs are in scope — it is the author's sign-off" (`cmd:11`). | The queue holds only this Instance's labelled PRs; unknown → skip. Today this bot merges another Instance's labelled PR, or fails its own settle on one it left. | PR · `ready-to-merge` (author not requested) · ✗ / ✗ | S5a-1 – S5a-3, S5a-5, S4-3, S4-4, S4-5 |
| **P33 Grace exit.** `gh pr list --state open --limit 1`: the grace ends only when no PR at all is open. | `cmd:303` | Stops the 15-minute wait in an empty repository. | Only this Instance's PRs may extend the grace. Today a foreign PR stretches it (a stall). | PR · none · ✗ / ✗ | S5a-4 |
| **P34 Rebase and the reads around it.** `gh pr update-branch <pr> --rebase` passes no head pin. Around it: a head-branch read, `ls-remote` before and after, a local fallback (`git cherry`, worktree lookup), and a plain `git fetch origin` before every gate run. A concurrent push by another Instance's member is orphaned, and a head moved by another Instance reads like the rebase landing. | `cmd:71`, `:74-78`, `:85-106`, `:132-172`, `:212` | "you are the only place currency is proven" (`cmd:199`). | Rebase only an own PR head, and only while no other Instance can push to it. | branch · head branch name · ✗ / ✗ | S5a-9 – S5a-12, S5a-14 |
| **P35 Conflict hold.** A PR with an unresolved `conflict-hold:#<pr>` is skipped. A conflicting rebase records that token on the PR's ledger row, and the tick then dispatches a fix-applier that pushes to the PR head. | `cmd:69`, `:178-185` | "nothing else durable says the PR is stuck" (`cmd:178`). | Record a hold only for an own PR. The ledger is invisible to other Instances, so their fix-appliers are not seen. | ledger token (local) · ✗ / ✗ | S5a-6, S5a-13 |
| **P36 Gate and merge.** `merge-gate.mjs` reads labels, review decision, head, body and closing references; its only ownership-shaped test is that the label is present. Then `gh pr merge <pr> --merge` with no `--match-head-commit`, guarded only by a second gate run just before. The bot adds a missing release label when CI's release-label check fails. | `merge-gate.mjs:275`, `:399-418`; `cmd:189`, `:191-195`, `:201`, `:215`, `:230` | The gate is the last check before the merge. | Merge only an own PR, at the head this Instance audited. Unknown → stall. | PR · `ready-to-merge` plus the head pin · ✗ / ✗ | S5a-15 – S5a-18 |
| **P37 Drop `in-progress` after the merge.** The issue set is the PR's own-repository closing references plus every `close`/`fix`/`resolve #N` in any commit message. Each one carrying `in-progress` loses it. | `drop-merged-label.sh:49-83`, `:191-192`; `cmd:248`, `:256` | "a merged ticket that keeps the label is invisible the moment it is reopened" (`cmd:256`). | Only the ticket this Instance claimed for this PR. A ticket named in a commit message but claimed by another Instance keeps its label. | issue · `in-progress`, closing reference · ✗ / ✗ | S5a-22, S5a-23 |
| **P38 Delete the merged head branch.** First the keep lookups: `gh pr list --head` and `--base <branch>` of any author keep the branch. Then `git push --force-with-lease=refs/heads/<b>:<merged head> origin --delete refs/heads/<b>`. Deleting another Instance's branch makes its local branch `[gone]`, which its reap then acts on. | `delete-merged-branch.sh:238-248`, `:264-269`; `cmd:248-258` | "Without it a merged branch is never `[gone]`, so `reap.sh` never reaps it" (`cmd:248`). | Only the head branch of a PR this Instance merged and owns. The keep lookups stay a read of everyone's PRs. | branch · head branch name · ✗ / ✗ | S5a-20, S5a-21 |

### Close-out

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P39 Close-out branch, PR and merge.** The name is `chore/run-artifacts-<UTC yyyymmdd>`, then `b`…`z`, the first free one by `git show-ref` and `git ls-remote --heads origin`. The push is `git push -u --force-with-lease=refs/heads/<b>:<pin or empty>`, then `gh pr create --label patch`, and `finish` merges with `--match-head-commit <pin>`. Two Instances on one UTC day start from the same name. The empty lease refuses a name another Instance pushed first, and the receipt keeps the name, so the step stalls rather than collides. A Close-out PR left open is an Owned Ticketless PR to every Instance's Fold-in under one gh user. | `closeout.mjs:340-352`, `:405-413`, `:415-423`, `:438-444`, `:599`; `close-out.md:20-27`, `:129-142` | The metrics files "reach `main` through the same review as ticket work rather than being lost" (`close-out.md:138-139`). | Only its own branch and PR; never adopt one it finds. | branch, PR · head branch name (date and letter), author login · ✗ / ✓ | S8a-1, S8a-2, S8a-3, S8a-9, S8a-10, S3-26 |

### Cockpit and metrics

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P40 Cockpit board.** `gh issue list --label ready-for-agent --limit 100` with no `in-progress` exclusion, `gh pr list --state open --limit 100`, and `ci-state.mjs --pr` for every open PR. Another Instance's claimed tickets show as POOL cards, because a claim leaves `ready-for-agent` on. Its PRs count against the 100 cap and can push this Instance's own PRs off the board. In-flight and claimed counts come from this ledger. | `board-gather.mjs:1199-1200`, `:1223-1224`, `:1278-1281`; `compute-board.mjs:89-94`, `:529-533`; `phase0.mjs:317-329` | "the pool's ONLY source" (`board-gather.mjs:1209-1210`); the board mirrors the ledger plus GitHub. | Show only own claims and PRs. The pool may stay shared but must leave claimed tickets out. | issue, PR · `in-progress` (not used); none for PRs · ✗ / ✗ | S8a-5, S8a-6, S8a-7, S2-11, S2-17, S5b-13 |
| **P41 Rulings.** `tier-outcomes.mjs append <pr>` with hand verdicts accepts any MERGED PR and takes the ticket from its closing references, with no ledger needed. The derived append is gated by this ledger's `reviewed=`. `check --live` makes close-out wait for a Ruling on every PR this ledger reviewed, including PRs P16 reviewed for another Instance. The row lands in `docs/metrics/tier-outcomes.tsv` through the Close-out PR. | `tier-outcomes.mjs:565`, `:763-766`, `:803-897`, `:850-856`, `:920-933`; `closeout.mjs:325-328`; `SKILL.md:286`; `pull.md:488-500` | Each implementer PR's verdict feeds the Router's quality floor. | Rule only PRs this Instance's own Pulls opened. | PR · closing reference · ✗ / ✗ | S8b-2, S8b-3, S8b-4 |
| **P42 Cost guard and the shared corpus.** `gh pr list --state all --search created:<window>` reads every PR since 2026-10-03 (number, state, merge time) at every phase 0 and close-out, to settle merged and pending against the corpus. `slice-fill` reads the body of every ticket the corpus names. The corpus TSVs are committed by Close-out PRs and carry no Instance column, so other Instances' rows count once merged. | `pr-cost.mjs:98`, `:124-142`, `:409-412`; `metrics-refresh.mjs:259-276`; `compute-cell-evidence.mjs:374-416`; `slice-fill.mjs:89` | Merged state "which tier-outcomes.tsv does not record" (`pr-cost.mjs:11-12`); the Router fails closed without the guard. | Acts on nothing; it reads others' PRs for a repository-wide statistic. Strictly own-only, it would read only the PRs its own rows name. Whether Instances share one corpus and Router is the Close-out-metrics ticket's question. | PR, corpus row · none (no Instance or author column) · ✗ / ✗ | S8b-1, S8b-5, S8b-6, S1-28 |

### Shared configuration

| Path | Where | Why it exists | Own-work limit | Mark | Entries |
|---|---|---|---|---|---|
| **P43 Label creation.** `gh label create <string>` under `label-map.mjs set --create`; "already exists" is accepted. The Label map cache is host-local, so two Instances can map one role to different strings. | `label-map.mjs:10-13`, `:646`, `:701-718`; `phase-0.md:120-122`, `:166-179`; `next-ticket/SKILL.md:24`; `review-and-fix.md:10` | Every Label role needs a string the tracker has (ADR 0035). | None: repository configuration, not work. But every Instance must map each role to the same string. | n/a | S5b-5, S2-18, S1-20, S7-17 |

## Rules that assume a claim branch stays unpushed until the first push

The sweep found 26 such rules, grouped here into 14 rows. Each reads "no
remote branch", "no Upstream" or "tip equals `origin/main`" as a fact about
the claim. The **If pushed at claim time** column assumes the claim branch is
on origin from the claim on, possibly carrying one claim-only commit on top of
`origin/main`. It judges no claim design. Full records, with each rule's
pinning tests, are in
[`s9-unpushed-claim-rules.md`](own-work-paths/s9-unpushed-claim-rules.md).

| Rule | Where | What it infers | If pushed at claim time | Pinned by | Entries |
|---|---|---|---|---|---|
| **R1 Glossary and ADRs.** Upstream: "There is none at claim time (`--no-track`); it is set by the member's first `git push -u` or by the controller's settle". ADR 0018: "a claim has no upstream until its first push". ADR 0025: "A Claim's worktree and label exist before its first push". | `CONTEXT.md:40-45`, `:52-55`, `:76-81`, `:478-482`; ADR 0018 `:11-16`; ADR 0025 `:111-116` | A claim is label plus local branch plus worktree; `[gone]` arises only after a push or a settle. | These sentences become false; "release and reap find the claim through that branch" changes meaning. | behaviour pinned at R2, R7, R8 | S9-1, S9-25, S9-26 |
| **R2 Claim cut `--no-track`.** No upstream at all, rather than one naming a ref that never existed, because that would read `[gone]`. | `claim-ticket.sh:280`, `:288-318` | A fresh claim is not `[gone]`; `@{u}` fails loudly instead of answering about main; `-d` is retired. | The upstream-less arm of reap sees `origin/<b>` present and keeps the branch for that reason; the `[gone]` arm fires on any delete of the remote ref. | `tests/claim-lifecycle.test.mjs:95`, `:105-107`, `:122` | S9-2 |
| **R3 Local-only collision guard.** It refuses on a local branch or worktree path; no `ls-remote`, no fetch. | `claim-ticket.sh:148-153`, `:163-164` | A branch name unused locally is unused. | A second claim from another clone passes and meets the remote ref only at its own push. | `tests/claim-ticket.test.mjs:1294`, `:769-804`; no remote-only case | S9-3 |
| **R4 Release: the never-dispatched shape.** "Never dispatched: no branch on origin. The branch must carry no commit beyond origin/main". A delete-time recount must be 0. | `release-ticket.sh:4-7`, `:885-907`, `:996-1018`, `:247-252`, `:1393-1399` | No remote ref and a tip at `origin/main` means no work, so deleting loses nothing. | A pristine claim leaves this shape at once. A claim-only commit reads as member work (`ahead`, `cherry`, recount ≥ 1). | `tests/release-ticket.test.mjs:392`, `:499`, `:526`; `tests/claim-lifecycle.test.mjs:148` | S9-4, S9-6 |
| **R5 Release: a pushed branch blocks.** A branch on origin blocks unless every PR naming it is CLOSED unmerged. Callers treat the refusal as "the finding": bail, drain and close-out `begin`, router refusal, and the stranded dry run. | `release-ticket.sh:1240-1280`; `fleet-event.mjs:35-41`, `:506-522`; `closeout.mjs:19-23`, `:270-278`; `pull.mjs:955-962`; `stranded.mjs:270-287` | A remote ref means a member pushed work; a pushed branch with no PR is a half-finished hand-off. | Every claim reads "exists on origin and no PR names it": every bail, drain and router refusal ends in `NEED hand-release`, and `begin` exits 4 every run. | `tests/release-ticket.test.mjs:952`, `:972`, `:992`, `:1004`; `tests/fleet-event.test.mjs` bail cases | S9-5, S9-14, S9-16, S9-17 |
| **R6 In-flight probe 2.** "a branch can exist with no PR yet, and a worktree can exist before anything is pushed". | `inflight.sh:4-7`, `:406-510` | A remote branch with N in it is someone's pushed work. | Fires on every claimed ticket from claim time, in every clone. The verdict stays "taken". | `tests/inflight.test.mjs:477`, `:493` | S9-7 |
| **R7 Reap: the no-upstream arm and `pr_tie`.** A branch with no upstream is selected only when `origin/<b>` is absent and its merged PR recorded its tip. A tip already on the base ties by equality only. | `reap.sh:1049-1101`, `:966-981` | No remote branch plus a recorded tip means merged; equality guards a fresh claim that reuses a merged PR's name. | Kept while `origin/<b>` exists. A claim-only commit takes the ancestry arm instead of the equality-only one. | `tests/reap.test.mjs:5650`, `:5665`, `:5565-5618` | S9-8, S9-9 |
| **R8 Reap: `[gone]` plus `git cherry`; the Upstream written at settle; the merge bot's delete.** A branch is reapable once the ref it tracks is gone and every commit is on `origin/main`. `claimUpstream` writes an upstream at a `PR#M` settle only when none is set. The merge bot's remote delete is what makes the local branch `[gone]`. | `reap.sh:1063`, `:1204-1244`; `claim-ticket.sh:300-312`; `fleet-event.mjs:52`, `:541-569`; `delete-merged-branch.sh:2-18` | An upstream exists only after a push or settle, so `[gone]` means merged and deleted. | `[gone]` follows any delete of the remote ref, including release's closed-PR delete. A pristine claim has an empty `cherry`, so reap would delete it. | `tests/claim-lifecycle.test.mjs:95`, `:122`; `tests/reap.test.mjs:926`; `tests/fleet-event.test.mjs:283`, `:301`, `:313` | S9-10, S9-18, S9-22 |
| **R9 `reaping.md` prose.** "Undispatched claim … skipped, correctly: no merge happened … this branch never went anywhere"; "Dirty check does not see member that committed but not pushed". | `reaping.md:28`, `:56-62`, `:66`, `:90-92`; `SKILL.md:903-904` | An undispatched claim has nothing on the server. | "never went anywhere" and "pushed means work on the server" become false. | `tests/reaping-prose.test.mjs`, `tests/reaping-release-authorizers-prose.test.mjs` (not read in detail) | S9-11, S9-12 |
| **R10 Stranded resume and report.** A claim is found by label plus local worktree and branch; remote state is read only through the PR list. The way out is "push the branch and open a PR". The replacement inherits `git log origin/main..HEAD`. | `stranded.mjs:7-12`, `:35-49`, `:209`, `:372-395`; `phase-0.md:540-547`, `:587-607` | A claim with no PR that "never opened" one is resumable, and its commits beyond main are the dead member's work. | `resume` and release disagree with what origin holds; "named until it is pushed" is wrong; a claim-only commit is listed as inherited work. | `tests/stranded.test.mjs:133`, `:361`, `:516` | S9-13, S9-14, S9-15 |
| **R11 `push-sync` first push.** By refspec with no `-u`; origin may not have the branch yet. | `push-sync.mjs:9-10`, `:18-21` | A branch origin lacks has no `equalsRemote`; the ancestor guard carries it. | `remoteBefore` is the claim-time tip, and the `reset --keep` sync runs on every push. | `tests/push-sync.test.mjs:308` | S9-19 |
| **R12 The member pushes once, at the end.** next-ticket step 7's push is the first push, and the plain-push fallback is scoped to "a branch that has never been pushed". The briefs say WIP commits are local ("it is never pushed"), which is what makes `--no-verify` on them safe. | `next-ticket/SKILL.md:102-116`; `fleet-implementer-*.agent.md:84-86`, `:103-106`, `:222` | Nothing before step 7 is on origin. | Every push is a re-push, so a lease denial always means a re-push denial and the fallback never applies. "Abandoned before PR opens → remove the label" leaves a remote branch behind. | `tests/force-with-lease-reason-prose.test.mjs:89-108`; `tests/stash-prohibition-prose.test.mjs` | S9-20, S9-21 |
| **R13 Collision scan's local branches.** The scan diffs local worktree branches against `origin/main` and drops those whose upstream is `[gone]`. | `pull.mjs:82-107`, `:439-443` | Another member's change in progress shows as an open PR or a local branch. | A remote branch with no PR and no worktree here is still not scanned; a claim whose remote ref was deleted is dropped as merged. | `tests/pull.test.mjs:1447` | S9-23 |
| **R14 `worktree-audit.sh` "ahead of origin/main".** Cited as the committed-and-pushed versus committed-only distinction. | `worktree-audit.sh:2-7`, `:118-123`, `:322` | Commits ahead of the base are the member's. | `ahead` ≥ 1 for an untouched claim with a claim-only commit; the audit still cannot tell pushed from committed. | `tests/worktree-audit.test.mjs:124` | S9-24 |

## Measured: a bare `--force-with-lease` after a fetch replaces another clone's branch

The implementer's push is next-ticket step 7: `git fetch origin && git rebase
origin/main`, then `git push --force-with-lease -u origin HEAD`
(`plugin/skills/next-ticket/SKILL.md:107-109`). git documents that a lease
with no expected value compares origin's ref with the local remote-tracking
ref, and the fetch has just set that ref to whatever another clone pushed.
Reproduced with git 2.54.0 against a local bare repository. Clone A cut
`implementer/7-impl-7 --no-track` from `origin/main`, committed and pushed.
Clone B cut the same name, committed, and pushed:

```text
B, no fetch:   ! [rejected]  HEAD -> implementer/7-impl-7 (stale info)        exit 1
B, after `git fetch origin && git rebase origin/main`:
               + 83ab078...998953d HEAD -> implementer/7-impl-7 (forced update) exit 0
origin's implementer/7-impl-7 afterwards: 998953d "B work"
```

So the step-7 sequence lets the later claimer replace the earlier claimer's
branch, and with it the head of any PR already open from it. **[INFERENCE]**
GitHub accepts the same forced update on a branch no ruleset protects; this
measurement did not involve GitHub.

## Corrections to premises elsewhere on the map

- **Merge-bot hold rule.** The read-versus-touch ticket cites "the merge bot's
  hold rule keeps a PR from jumping a lower related one". On main a labelled
  PR never waits on an unlabelled one (`cmd:24-30`); the Pass orders only
  labelled PRs, lowest number first (P32).
- **Line numbers have moved** since the map's measured premises. The Fold-in
  list is `phase0.mjs:412` and the Owned filter `:438` (map: `:409-410`).
  Review-due is `fleet-tick.mjs:1194-1197` (`:1203-1205`). The In-flight
  count is `:1092-1093`, `:1151-1153` (`:1099`). `unclaimed()` is
  `:1273-1278` (`:1286-1290`). The queue snapshot is `ledger.mjs:2234-2245`
  (`:2236`). Rotate's refusal is `ledger.mjs:1666-1668` (`:1663`). The
  linked-worktree refusal is `phase0.mjs:646-649` (`:644-646`).
- **"The first push wins" on a double claim** holds only for a push without a
  prior fetch. The implementer's step 7 fetches first, so the later push wins
  (§ Measured).
- **Pending, not on main:** issue #4167 (ruled 2026-11-02, `ready-for-agent`)
  makes settle and the finisher gate refuse a PR that closes a ticket another
  claim holds, read off `in-progress`. Today no settle or gate check reads
  another ticket's label (P31).

## Coverage

Eleven read-only passes each took a disjoint file set. Together they cover all
143 files under `plugin/`; S9 also swept `CONTEXT.md` and `docs/adr/`. Each
detail file ends with the call sites it judged own-only or configuration, and
with the files that have no GitHub access, so every file is accounted for.
Every cited line range was checked to exist at 1a9692aa. About 65 citations
behind the rows above were re-read against the code, and all matched.

| Detail file | Files | Entries |
|---|---|---|
| [s1-claims-and-pull.md](own-work-paths/s1-claims-and-pull.md) | `pull.mjs`, `claim-ticket.sh`, `inflight.sh`, `candidates.mjs`, `shortlist.mjs`, ticket routing, `slice-fill.mjs`; `pull.md`, next-ticket, implementer brief and agents, relabel brief, sizing | 28 |
| [s2-phase-0-and-resume.md](own-work-paths/s2-phase-0-and-resume.md) | `phase0.mjs`, `owned-pr.mjs`, `stranded.mjs`, `preflight.mjs`, `reclaim-scratch.mjs`, `evict.mjs`, host infrastructure; `phase-0.md`, `instruments.md`, `shell-traps.md` | 20 |
| [s3-tick-and-controller.md](own-work-paths/s3-tick-and-controller.md) | `fleet-tick.mjs`, `staleness.mjs`, `dispatch-prompt.mjs`; run-team `SKILL.md`, `tick-rows.md`, lifecycle references | 29 |
| [s4-ledger-and-events.md](own-work-paths/s4-ledger-and-events.md) | `ledger.mjs`, `ledger-grammar.mjs`, `fleet-event.mjs`, report schema; `ledger.md` | 16 |
| [s5a-merge-bot.md](own-work-paths/s5a-merge-bot.md) | `run-merge-bot.md`, merge-bot agent and brief, `merge-gate.mjs`, `drop-merged-label.sh`, `delete-merged-branch.sh`, `prove-merge.sh`, `verify-sha.sh`, `no-undo-audit.sh`, `main-gain.mjs` | 23 |
| [s5b-finisher-and-labels.md](own-work-paths/s5b-finisher-and-labels.md) | `finisher-*.mjs`, `label-map.mjs`, `ticketless.mjs`; finisher agent, brief and reference | 13 |
| [s6-release-reap-push.md](own-work-paths/s6-release-reap-push.md) | `release-ticket.sh`, `reap.sh`, `worktree.sh`, `worktree-audit.sh`, `push-sync.mjs`; `reaping.md`, `isolation.md` | 12 |
| [s7-review-fix-ci.md](own-work-paths/s7-review-fix-ci.md) | `review-core.mjs`, `ci-state.mjs`, `dispositions-check.mjs`, `diff-stats.mjs`, recipe scripts; `review-and-fix.md`, CI watcher references, fix-applier and review agents | 17 |
| [s8a-close-out-and-cockpit.md](own-work-paths/s8a-close-out-and-cockpit.md) | `closeout.mjs`, `close-out.md`, `board-*.mjs`, `board.html`, `compute-board.mjs`, `compute-spend.mjs`, `gh-aliased-read.mjs` | 10 |
| [s8b-metrics.md](own-work-paths/s8b-metrics.md) | `member-outcomes.mjs`, `member-record.mjs`, `tier-*.mjs`, `pr-cost.mjs`, `metrics-refresh.mjs`, cell evidence, frontmatter check | 6 |
| [s9-unpushed-claim-rules.md](own-work-paths/s9-unpushed-claim-rules.md) | all of `plugin/`, `CONTEXT.md`, `docs/adr/` (one rule class) | 26 rules |
