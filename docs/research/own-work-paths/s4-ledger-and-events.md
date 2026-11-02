# S4 (ledger and events) — plugin paths that read or act on GitHub work beyond the Instance's own

Snapshot: `origin/main` 1a9692aa. Every `file:line` is relative to that repo root. All five code files and `ledger.md` were read; nothing was run.

Summary of what S4 contains (facts):
- `ledger.mjs` reaches GitHub through exactly four call sites: `check`'s `gh issue list --search` (1330), `queueSnapshot`'s `gh pr list --label` (2245), the shared `look()`/`checkReaders()` child (2060-2072, used by the finisher gate at dispatch and by `settle --from-report`), and `git ls-remote origin` (2813). It makes no GitHub write of any kind. `rotate`, `row`, `token`, `filed`, `ruled`, `review`, `drain`, `undrain` and `dispatch impl-N|fix-pr-M` touch no GitHub state.
- No file in S4 reads another ticket's `in-progress` label, any assignee, or any PR author login. The only Label-role reads are `ready-to-merge` (queue, settle checks) and the claim ticket's own `labels` in `fleet-event.mjs`. The strings `in-progress`, `assignee` and `claimed` appear in S4 only in fleet-event.mjs prose/labels it removes (checked by grep).
- `settle impl-N --from-report` requires the PR to close #N (own repo) and to have head `implementer/N-impl-N`; it does NOT refuse a PR that also closes other tickets and never reads whether another claim holds them (2864-2872, see S4-6).
- `dispatch impl-N` has no GitHub gate at all (2263-2465 reads only the ledger, the row, `agents/` and the rendered brief). The claim itself is not in these files.
- `fleet-event.mjs` is the only S4 file that writes to GitHub, always on a ticket/PR number derived from a ledger member name (`impl-N` → #N, `finisher-pr-M` → PR M), with no re-check that the label/PR is this Instance's own.

---

### S4-1 check's tracker search: every issue in the repository, any state, any author
- Where: `plugin/scripts/ledger.mjs:1330-1335` (+ query built 1193-1196, env `GH_REPO: ""` 1246, repo probes 1262 and 1277, result ranked 1375-1381, verdict 1514-1520, payload 1539, exit code 1567)
- Kind: read-select
- Does: `execFileSync("gh", ["issue","list","--search", query, "--state","all","--limit","6","--json","number,title,state,url"], {cwd: <ledger's repo>, env: queryEnv})`; `query` is up to three longest content words of the subject typed by the caller. Rows are scored against the subject (title overlap) and shipped in `tracker.hits` with `url`.
- Scope today: repo-wide (all open and closed issues matching the words; no label, author or Instance filter)
- Feeds / Selected by: Feeds the `verdict` (`tracker-hit` → exit 3 at 1567; `soft-hit`, `unverified`, `clean` exit 0) that a caller reads before `gh issue create` (ledger.md:91, ledger.md:32-36, ledger.mjs comment 1521-1523, 1552-1556: "the instruction the callers carry makes exit 3 binding"). It selects no write onto the matched issues; it gates the caller's filing of a NEW issue. Selected by: subject words, 1193-1196.
- Exists because: "The ledger can only see what THIS run recorded. An issue that already exists on the tracker but never reached this `filed` list — filed by an earlier run, by the maintainer, by hand — is structurally invisible ... one issue was rediscovered five times in one run" (1156-1160).
- Own-work limit: this is an informing read; it must never select a write onto, or count as the Instance's own work, an issue it did not file. Today another Instance's (or a human's) matching issue blocks this Instance's filing at exit 3 (stall), which is the safe direction; it must stay read-only. [INFERENCE: whether a match filed by another Instance should block or only inform is a decision for the later ticket, not read from code.]
- Mark: object that would carry ownership: issue; nearest mark today: none (fields read are `number,title,state,url` — no author, no label); tells Instances apart under one gh user: no; under different gh users: no (author not even requested)
- Notes: gh failure degrades to `verdict: "unverified"` at exit 0, not a block (1435, 1514-1515). `ledger.ok`/`tracker.ok` in the payload separate the two halves (1539). The repo is resolved by binding gh's cwd to the ledger's repository (1212-1244, 1328-1334), so the search is the one repository's tracker, never a different one.

### S4-2 ledger.md instructs the check-then-create filing flow
- Where: `plugin/skills/run-team/references/ledger.md:32-36`, `:38-59`, `:91`
- Kind: instruction-read
- Does: tells members/controller to run `ledger.mjs check <subject>` "before every `gh issue create`", and that exit 3 ("open or closed tracker issues match") means "read those and decide"; names `verdict` values `already-filed`, `tracker-hit`, `clean`, `soft-hit`, `unverified`.
- Scope today: repo-wide (it describes S4-1)
- Feeds / Selected by: Feeds `gh issue create` by the caller (a write creating a NEW issue, not a write on an existing one). Selected by S4-1 (`ledger.mjs:1330`).
- Exists because: "the tracker query ... is what covers" duplicates beyond this run's `filed` list (ledger.md:91); "No claim/reserve step exists to close it" for the check→create→filed gap (ledger.md:36).
- Own-work limit: same as S4-1. The gap named in ledger.md:32-36 (two filers both read `clean`) is declared per run ("same-run accidental duplicate"); across Instances the ledger half is invisible to the other Instance, so only the tracker half can see the other's filing, after it exists.
- Mark: object: issue; nearest mark: none; tells Instances apart under one gh user: no; under different gh users: no
- Notes: ledger.md:36 "no claim/reserve step exists to close it" — a prior ruling (also ledger.mjs:603-607: "a claim/reserve subcommand closing that window was ruled out") that closes the check→create→filed window against a concurrent filer; it is not Instance-aware.

### S4-3 ledger.md instructs the merge bot's queue record
- Where: `plugin/skills/run-team/references/ledger.md:83`
- Kind: instruction-read
- Does: states that `dispatch merge-bot` records `queued=<pr>,<pr>…` ("the open `ready-to-merge` PRs gh lists at that moment") and that `settle merge-bot-<n> --from-report` fails (exit 3) on "a PR from it that is still open and carries the label, with no verdict in `merged`, `conflictHold` or `refused`"; an entry without `queued=` "cannot be judged (exit 2) — settle that bot by hand".
- Scope today: label-wide (it describes S4-4/S4-5)
- Feeds / Selected by: Feeds the merge bot's per-PR verdict obligation. Selected by S4-4.
- Exists because: the report must not be able to shrink the queue it is judged against (ledger.mjs:2945-2949).
- Own-work limit: the queue the bot owes verdicts on, and the PRs `merge-bot` may merge, would have to be only this Instance's own PRs; a foreign PR in the queue must stall (be left unlabelled-by-us, no verdict owed), never be judged or merged.
- Mark: object: PR; nearest mark: `ready-to-merge` label (state, not owner); tells Instances apart under one gh user: no; under different gh users: no (author login exists on the PR but is not read here)
- Notes: none.

### S4-4 dispatch merge-bot snapshots every open ready-to-merge PR in the repository
- Where: `plugin/scripts/ledger.mjs:2234-2260` (+ call at 709, label string via `readyLabel` 2219-2226, recorded at 2454)
- Kind: read-select
- Does: `spawnSync("gh", ["pr","list","--state","open","--label", <Label map's ready-to-merge string>, "--limit","1000","--json","number"], {cwd: <ledger's dir>, env: GH_REPO "" })`; refuses if the answer is not a JSON array of positive integers (2258) or has 1000 entries (2259). Run once, before the lock, when `dispatch merge-bot[-<n>]` is the whole command (709).
- Scope today: label-wide (and so repo-wide: no author, branch, or Instance filter; only `number` requested)
- Feeds / Selected by: Feeds `data.queued[member]` → the bot's `## Dispatched` entry `queued=…` (2454, 2461-2464), which `settle merge-bot --from-report` judges against (2950-2962, S4-5) and which the controller hands the bot as its queue. Selected by: the `ready-to-merge` label alone.
- Exists because: "the queue a merge bot is dispatched against, recorded on its `## Dispatched` entry ... Anything but a JSON array of PR numbers, or an answer filling the limit ... could not read the queue: refused, nothing written" (2228-2233); recorded "beside its brief, where nothing in its report can reach" (2452-2453).
- Own-work limit: the list must be limited to PRs this Instance owns (the merge bot must be given and held to only those); a `ready-to-merge` PR whose owner is unknown must not enter the queue (stall, not merge). Today any other Instance's PR carrying the label enters this Instance's queue and, through S4-5, must receive a verdict from this Instance's bot.
- Mark: object: PR; nearest mark today: `ready-to-merge` label (state, not owner; the `author`/head branch fields exist on the PR but `--json number` does not read them); tells Instances apart under one gh user: no; under different gh users: no (author not read; would be yes only if the filter added it)
- Notes: host-local gate: none; the `QUEUED` read happens before any ledger validation or lock (709). The label-map read (`readyLabel`, 2219) is `config`.

### S4-5 settle merge-bot --from-report reads PRs the report names and every PR queued at dispatch
- Where: `plugin/scripts/ledger.mjs:2943-2963` (+ `prView` 2084-2095, `look` 2060-2067, checks fail at 2966-2969)
- Kind: read-select
- Does: for every `report.merged[].pr`: `gh pr view <pr> --json state` and require `MERGED` (2944); for every PR in `data.queued[member]` that the report gave no verdict (`merged`, `conflictHold` or `refused`, via `mergeBotVerdicts`, report-schema.mjs:183-189): `gh pr view <pr> --json state,labels` and require that it is not OPEN or no longer carries the `ready-to-merge` string (2957-2961). Failure is `mismatch()`, exit 3, nothing written (2757-2764, 2966-2969). Success writes only `## Ruled` lines `merge-bot-<n> refused #<pr>: <reason>` (2963, local).
- Scope today: per-object from the bot's report (merged/refused/conflictHold PR numbers) and per-object from `queued=` (S4-4), which is label-wide
- Feeds / Selected by: Feeds the settle `merge-bot-n=done` (2943) and, after it, `fleet-event.mjs merge-bot-report`'s reap and reclaim under the tick (fleet-event.mjs:76-86, 668-674). Selected by: S4-4's label-wide queue, and by the bot's own report.
- Exists because: "Every PR queued when the bot was dispatched has a verdict, unless it has left the queue since — merged by someone else, closed or unlabelled" (2945-2949).
- Own-work limit: the queued set and the verdict obligation must be only this Instance's own PRs. Today a foreign PR that was `ready-to-merge` at dispatch and is still open and labelled at settle (not merged by this bot) makes this Instance's settle fail at exit 3 — it stalls this Instance's bot settle until that foreign PR leaves the queue or the bot rules on it. The `merged[]` PRs are read for state only; no write.
- Mark: object: PR; nearest mark: `ready-to-merge` label; tells Instances apart under one gh user: no; under different gh users: no
- Notes: `merged by someone else` is explicitly an allowed way for a queued PR to leave (2946) — i.e. the code already expects other actors' merges in this queue.

### S4-6 settle impl-N --from-report: what it reads and refuses about the PR; no check of other claims
- Where: `plugin/scripts/ledger.mjs:2856-2872` (+ `recipeGate` 2836-2853, `prViewClosing` 2100-2107, `ownClosingIssues` at plugin/scripts/closing-refs.mjs:19-37, `verify-sha.sh` call 2861 via 2068)
- Kind: read-select
- Does: for `report.pr` and `report.branch`/`report.head` taken from the member's own report file: (1) `sh verify-sha.sh <report.branch> <report.head>` must exit 0 (2861-2862) — plugin/scripts/verify-sha.sh:54-57 runs `git fetch --quiet origin <branch>` then `git merge-base --is-ancestor`; (2) `gh pr view <report.pr> --json state,closingIssuesReferences,url,headRefName` (2864); (3) PR reads OPEN (2865); (4) `numbers.includes(live.number)` — the PR's closing references in its own repository (closing-refs.mjs:19-37) include #N (2866); (5) `pr.headRefName === "implementer/<N>-impl-<N>"` (2871-2872); (6) the Recipe gate: `git rev-parse --verify origin/main^{commit}`, `derive-testcmd.sh . check|test --at origin/main`, the Check-step record at `<reports>/<member>.check.json` (local) and `git rev-parse <head>^{tree}` (2836-2853).
- Scope today: per-object from the member's report (`report.pr`, `report.branch`, `report.head`); no repo-wide read
- Feeds / Selected by: Feeds the settle `impl-N=PR#M` (2860) and the row fold of the PR's own `#M` row into the ticket's row (2638-2646, local), which the tick then reviews/merges. Selected by: the implementer's report (`$.pr`, `$.branch`, `$.head`), not by anything the ledger created; the claim branch is rebuilt from the ticket number (2871) "Never from the settling member's name or its report" (2867-2870).
- Exists because: "the member's claim and the world disagree" must stop the settle (2729-2735, 2966-2969).
- Own-work limit: only this Instance's own implementer PR may settle; settle must stall when ownership of PR M/branch is unknown. What it does NOT do: it never reads whether any other claim holds a ticket the PR also closes (no `in-progress` read on other tickets — `numbers` may hold other issues and only `live.number` is required to be among them, 2866), never reads the PR's author, and never reads an assignee. The only identity check is the head branch NAME, which is fixed by ticket number.
- Mark: object: PR (and the claim branch); nearest mark today: head branch name `implementer/N-impl-N` (2871) — names the ticket, no Instance part; closing reference (2866) ties PR to ticket; tells Instances apart under one gh user: no (two Instances claiming the same N share the branch name); under different gh users: no (author login not read)
- Notes: no `gh pr list`/`gh api` — every PR read is `gh pr view <number>`. verify-sha.sh's `git fetch origin <branch>` is a remote read keyed by `report.branch`, which is the member's word (the head-branch check at 2871-2872 is made on GitHub's `headRefName`, not on `report.branch`). A `bailed`/`blocked` settle reads no GitHub (2873-2878).

### S4-7 settle fix-pr-M --from-report: origin's branch head read by the report's branch name
- Where: `plugin/scripts/ledger.mjs:2879-2909` (+ `remoteHead` 2811-2816 → `git ls-remote origin refs/heads/<branch>` 2813; `verifyShaOf` 2888 → verify-sha.sh fetch)
- Kind: read-select
- Does: `applied`: `git ls-remote origin refs/heads/<report.branch>` must equal `report.head` (2882-2883); then `verify-sha.sh <report.branch> <report.head>` fetches `origin <branch>` (2888) and the Recipe gate (2836-2853) reads `<head>^{tree}`. `no-op`: the same `ls-remote` must start with the head PR M's latest `reviewed=` names (2899-2905). Neither reads the PR itself: no `gh pr view`, so nothing ties `report.branch` to PR M's actual head branch.
- Scope today: per-object from the fix-applier's report (`report.branch`, `report.head`) and from the ledger's `reviewed=` token
- Feeds / Selected by: Feeds the settle `fix-pr-M=applied:<head>|no-op|failed` (2881, 2891, 2908), which the tick reads to re-review/clear a Conflict hold. Selected by: the report's `$.branch` (a member-typed string), `$.head`.
- Exists because: the claim `applied`/`no-op` "asserts a git or GitHub state [that] has that state checked before anything is written" (2681-2683, 2695-2699).
- Own-work limit: only this Instance's own fix-applier's pushed branch; if the branch's owner is unknown, settle must stall. Today the branch string is the member's word and carries no Instance part.
- Mark: object: branch; nearest mark today: head branch name (as reported by the member); tells Instances apart under one gh user: no; under different gh users: no
- Notes: `git ls-remote` is a plain remote read (no auth beyond origin). The fix-applier's own push is outside S4 (member prompt).

### S4-8 dispatch finisher-pr-M gate: reads PR M's closing references, the title of every issue it closes, and its labels
- Where: `plugin/scripts/ledger.mjs:2395-2410` (+ `closingRefusals` 2150-2178: 2155, 2174; `releaseLabelRefusal` 2192-2210: 2196; `checkReaders` 2036-2133: gh child 2072, `GH_REPO: ""` 2041)
- Kind: read-select
- Does: `gh pr view <M> --json closingIssuesReferences,url` (2155) — own-repo references only (closing-refs.mjs:19-37); for every closing reference `n`: `gh issue view <n> --json title` (2174), compared to this PR's own suggestion-band record title `recordTitle(M)`; `gh pr view <M> --json labels` (2196); `gh label list --json name --limit 1000` (`LABEL_LIST_ARGS`, release-labels.mjs:13, via 2199 — `config`). Refuses (dies, exit 2, nothing written) when: the PR closes a ticket the ruling says it must not, or does not close one it must (2161-2169); a closing reference's issue title equals this PR's own suggestion-band record (2174); the PR carries more than one release label, or none where the repo defines them and the PR closes a ticket (2197-2209).
- Scope today: per-object from M (a PR number the ledger holds a `finisher-pr-M` member for) plus every issue number that PR closes (no author/Instance filter on them)
- Feeds / Selected by: Feeds the dispatch of `finisher-pr-M`, whose member then labels PR M `ready-to-merge` (outside S4). Selected by: the controller's member name `finisher-pr-M` (2280, 2395), gated first by local state only: the tick's conflict-hold fold (2396-2400), `dispositionsRefusal` (2402), the local ruling in `docs/metrics/tier-outcomes.tsv` (2404, `rulingOf` 2010-2028).
- Exists because: "no check can be skipped by forgetting to run it" (2393-2394); a PR closing its own review's record issue would close it unreviewed.
- Own-work limit: only this Instance's own PR M (an Owned PR) may reach this gate; reading the title of an issue a foreign PR closes is per-object read only but the dispatch it permits writes a label on PR M, so M's ownership must be established first (stall if unknown). The gate itself tests ownership nowhere: no author comparison, no `owned-pr.mjs`.
- Mark: object: PR; nearest mark today: closing reference (`closingIssuesReferences`) and the ledger's own `finisher-pr-M` token (local); tells Instances apart under one gh user: no; under different gh users: no
- Notes: "no `in-progress` read on other tickets": none. The references read may name tickets other claims hold; only their `title` is read (2111), never their labels.

### S4-9 settle finisher-pr-M labelled: PR M's labels
- Where: `plugin/scripts/ledger.mjs:2928-2934` (+ `readyLabel` 2931 `config`)
- Kind: read-select
- Does: `gh pr view <M> --json labels`; requires the `ready-to-merge` string among them and in the report's `labelsReadBack` (2932-2934).
- Scope today: per-object from M, the number in the member name `finisher-pr-M` (live.number)
- Feeds / Selected by: Feeds the settle `finisher-pr-M=labelled`, which the tick reads to dispatch the merge bot (header of fleet-event.mjs:75-76). Selected by: ledger member name.
- Exists because: "PR M's labels carry ready-to-merge, and so does the report's labelsReadBack" (2700-2701).
- Own-work limit: only this Instance's own PR M; ownership of M is not tested here.
- Mark: object: PR; nearest mark: `ready-to-merge` label (state); tells Instances apart under one gh user: no; under different gh users: no
- Notes: read only; the label write is the finisher's (outside S4).

### S4-10 impl-report bailed: relabel, comment and demotion of the claim ticket
- Where: `plugin/scripts/fleet-event.mjs:506-522` (+ `demote` 447-464: gh edit 454, comment 462 → `comment` 395-407, gh comment 400; `comments` read 377-378; `rendered` 427-439; `implReport` 590-592; header 22-41)
- Kind: write
- Does: after `ledger.mjs settle <member> --from-report` settled `bailed` (347-372): `gh issue view <N> --json labels,comments,state` (378); then, unless the issue already carries the target label and neither pulled label (451), `gh issue edit <N> --remove-label <ready-for-agent> --remove-label <in-progress> --add-label <needs-triage|ready-for-human>` (454); then `gh issue comment <N> --body <rendered relabel text>` unless an identical body is already among the issue's comments (396, 400).
- Scope today: per-object from `parseMember(member).number` (507) — the ticket number inside the `impl-N[-x]` name the controller passed (family checked at 981); no precondition that the issue still carries THIS Instance's claim
- Feeds / Selected by: Feeds S4-12 (release) on success (518-521). Selected by: the member name argument and the report's `bailCause` (509-510), settled from the report file on this host's scratch (ledger.mjs:2801-2806); the settle itself is judged against the local ledger (settleMember 2584-2597, `no live ${name} in the ledger — dispatch it first`).
- Exists because: "Dropping `in-progress` is the load-bearing half: phase 1 applied it and `candidates.mjs` excludes it, so leaving it makes the ticket invisible to the controller's scans and the maintainer's" (header 40).
- Own-work limit: only targets this Instance's own claim ticket #N; before the edit it must know the `in-progress` on #N is this Instance's claim, and stall (NEED, nothing written) when ownership is unknown. Today it removes the shared `ready-for-agent`/`in-progress` labels and adds a state label without reading who holds the claim, and its "already carries" idempotency check is on labels/comment text only.
- Mark: object: issue (ticket) — label and comment; nearest mark today: `in-progress` label (says nothing about by whom) and the ticket number in `impl-N`; tells Instances apart under one gh user: no; under different gh users: no
- Notes: comment body markers (all fixed text, no run/Instance/member token): `*Relabelled by the fleet controller.* Pulled for implementation and returned: …` (plugin/skills/run-team/briefs/relabel.md:8-21, kinds `needs-triage`, `fork`, `hands`, `covered`); for a `fixed` bail demoted to `needs-triage`: `*Relabelled by the fleet controller.* Pulled for implementation and returned as already fixed by <sha>: <sha> not on origin/main.` (fleet-event.mjs:477). Dedupe is exact body match against ANY comment on the issue (396), so an identical comment by another actor counts as already posted. The `covered` detail names `PR#M — <how>`; "The PR a `covered` detail names is never written to" (header 51). Every gh write here runs from `run()` with `GH_REPO: ""` and scrubbed git env (270-273).

### S4-11 impl-report fixed: close the ticket and strip its labels
- Where: `plugin/scripts/fleet-event.mjs:469-504` (gh close 491; gh edit 500; `verify-sha.sh main <sha>` 475)
- Kind: write
- Does: `sh verify-sha.sh main <sha>` (fetches `origin main`, plugin/scripts/verify-sha.sh:54-57); exit 0 → `gh issue view <N> --json labels,comments,state` (485), then unless CLOSED `gh issue close <N> [--comment <body>]` (491), then `gh issue edit <N> --remove-label <ready-for-agent|in-progress>` for whichever it carries (498-501); exit 1 → S4-10's demote to `needs-triage`; any other answer → NEED, nothing written (479-482).
- Scope today: per-object from `parseMember(member).number` (507); no precondition that the ticket's `in-progress` is this Instance's; the only precondition is that `<sha>` is on origin/main
- Feeds / Selected by: Feeds S4-12. Selected by: the report's `bailCause: "fixed"` and `bailDetail` opening with a sha (470, 509-515).
- Exists because: a ticket found already fixed on origin/main must be closed rather than left `in-progress` (header 42-50).
- Own-work limit: only this Instance's own claim ticket #N; stall when the claim's ownership is unknown. Any ticket whose number appears in an `impl-N` name settled `bailed` is closed on the member's word plus origin/main reachability of the quoted sha.
- Mark: object: issue (ticket); nearest mark today: `in-progress` label, ticket number in member name; tells Instances apart under one gh user: no; under different gh users: no
- Notes: comment body marker `*Closed by the fleet controller.* Pulled for implementation and found already fixed on origin/main: <detail>.` (relabel.md:23-24). The `git fetch origin main` is a read of shared repository content (`origin/main`), listed also under `config` in the Checked list.

### S4-12 impl-report bailed: release of the claim (call-through to release-ticket.sh)
- Where: `plugin/scripts/fleet-event.mjs:519-521` (+ `blocker` 526-534)
- Kind: write
- Does: `sh release-ticket.sh <N> impl-<N> implementer --apply`. [Call-through into another slice; read for the record only:] release-ticket.sh runs `gh issue edit <N> --remove-label <in-progress>` (release-ticket.sh:1524-1525), `git push origin --delete refs/heads/<branch>` (1507-1509) after `git ls-remote --heads origin refs/heads/<branch>` (885, 1500), and `gh pr list --state all --head <branch>` (1262); `<branch>` is `implementer/<N>-impl-<N>`-shaped (`$type/$issue-$slug`, release-ticket.sh:236). Refusal prints `NEED hand-release #<N> <blockers>` and is never forced (header 38-39).
- Scope today: per-object from the ticket number and the member name `impl-<N>` the script builds itself (519); no precondition in fleet-event that the `in-progress` is this Instance's
- Feeds / Selected by: Selected by S4-10/S4-11's success. Feeds the remote branch delete and label removal in release-ticket.sh (owned by another slice's inventory).
- Exists because: "`reap.sh` declines a claim that never became a PR, so the release of a bailed claim is `release-ticket.sh`'s" (header 41).
- Own-work limit: only this Instance's own claim #N and its claim branch; ownership unknown → stall (NEED).
- Mark: object: issue and branch; nearest mark today: `in-progress` label, head branch name `implementer/N-impl-N`; tells Instances apart under one gh user: no; under different gh users: no
- Notes: runs on a second run too, "It measures the claim again and writes nothing when nothing is left to release" (header 37-38).

### S4-13 finisher-report: halt and escalation comments on PR M
- Where: `plugin/scripts/fleet-event.mjs:636-666` (read 646/664 → `comments` 377-392; write → `comment` 395-407, gh comment 400)
- Kind: write
- Does: `gh pr view <M> --json comments` then `gh pr comment <M> --body <body>`: for a settled `halted:<cause>`, body `**<member> halted: \`<cause>\`.**\n\n<evidence>` (647); for a repair finisher whose `labelsReadBack` lacks `ready-to-merge`, body `**<member>, a repair finisher, read back no \`<ready-to-merge string>\` on PR #<M>.**` plus read-back lists (662-663). Either is skipped when an identical body is already among the PR's comments.
- Scope today: per-object from `parseMember(member).number` (639), the PR number inside `finisher-pr-M[-x]`; no author/ownership check on PR M
- Feeds / Selected by: Selected by the finisher's settle (636-641) and report. Feeds nothing downstream.
- Exists because: a halt "says why in its own comment" (651-652); the escalation is the one-shot signal for a repair finisher that read back no label (header 67-74).
- Own-work limit: only this Instance's own PR M; ownership unknown → stall.
- Mark: object: PR comment; nearest mark today: the comment's first line names the member (`finisher-pr-M[-x]`) — a run/ledger token with no Instance part; tells Instances apart under one gh user: no; under different gh users: no (comment author differs by user but is not read)
- Notes: marker shapes verbatim: `**finisher-pr-<M>[-x] halted: \`<cause>\`.**` and `**finisher-pr-<M>-<x>, a repair finisher, read back no \`ready-to-merge\` on PR #<M>.**`. Dedupe by exact-body match over every comment on the PR (396), so a body another Instance posted identically is read as already posted.

### S4-14 impl-report PR#M: claim branch upstream set in the local checkout
- Where: `plugin/scripts/fleet-event.mjs:543-569` (+ header 52, `implReport` 593)
- Kind: write
- Does: local git only: `git show-ref --verify --quiet refs/heads/<b>` (552), `git config --get branch.<b>.merge` (558), and when unset `git config branch.<b>.remote origin` and `git config branch.<b>.merge refs/heads/<b>` (564-567). `<b>` is `report.branch` from the member's report file (549). No fetch, no push, no `gh`. A failed write prints `NEED upstream <b> — <why>` and the exact command (551).
- Scope today: per-object from `report.branch` (member's word); local repository only
- Feeds / Selected by: Feeds `reap.sh`'s later selection: "`reap.sh` selects a branch with no upstream only when origin has no branch of its name and its merged PR recorded its tip, while an upstream's `[gone]` state also lets `git cherry`'s proof make it reapable" (header 52). Reap deletes branches after merge (other slice). Selected by: the settled `impl-N=PR#M` outcome (593) — the ledger's own claim.
- Exists because: without an upstream, `reap.sh` treats the branch as one it must not select unless origin lacks it (header 52).
- Own-work limit: only this Instance's own claim branch; a branch that is not this Instance's claim branch must never gain an upstream here. Host-local state that gates a Reap (a deletion).
- Mark: object: branch; nearest mark today: head branch name `implementer/N-impl-N` (not verified here against the claim name — `report.branch` is used as given); tells Instances apart under one gh user: no; under different gh users: no
- Notes: this is the only path in S4 that touches a remote ref's tracking configuration, and it does not contact the remote; `blocked`, `bailed` and `failed` outcomes set none (header 53).

### S4-15 every fleet-event kind ends in `fleet-tick.mjs --apply`
- Where: `plugin/scripts/fleet-event.mjs:1003`, `:1025` (header 8-12, 84-85)
- Kind: read-select
- Does: `spawnSync(node, [fleet-tick.mjs, "--apply", …])` after the kind's writes, for every kind including `heartbeat` and `label` (which write nothing, header 113-114, 126-130). [Call-through; facts read in fleet-tick.mjs (S3's file) for the record:] `gh api` login read via `GH_LOGIN_ARGS` (1705, definition not read), `gh pr list --state open --limit 200 --json number,labels,closingIssuesReferences,headRefOid,mergeable,body,url,author,isDraft` (1716), `gh pr|issue view <n> --json state` per target (1831, 1904), `gh issue list --label <label> --state open --limit … --jq length` (the In-flight count, 2068), and runs `reap.sh --apply` (1997) and `shortlist.mjs` (1959).
- Scope today: the tick's own (login-wide PR list, label-wide issue list, per-object state reads) — not decided in this file
- Feeds / Selected by: Feeds the tick's reap, reclaim and `DISPATCH` lines the controller acts on (fleet-event.mjs:84-85: "The reap and the reclaim run once for every merge bot settled `done`, always"). Selected by: whatever kind ran.
- Exists because: "Every kind performs its writes, then runs `fleet-tick.mjs --apply` with the In-flight bound" (header 8-10); a wake is "the writes it owes, then the tick" (header 2).
- Own-work limit: the tick's reads and its `--apply` writes (reap, reclaim) must be limited to this Instance's own work; this file adds no selection of its own but runs the apply on every event, including a heartbeat that records nothing. See S3's entries.
- Mark: see S3's entries; nearest in this file: none.
- Notes: the In-flight bound argument comes from `tickCaps(fleetDir)` (1001-1003) or `--in-flight` (970, 1003) — the controller's number, not a GitHub read in this file.

### S4-16 fleet-event drain / undrain: closeout begin releases every claim that never became a PR
- Where: `plugin/scripts/fleet-event.mjs:842-863` (header 131-143)
- Kind: write
- Does: `node closeout.mjs begin --reason <r>` / `reopen --reason <r>`. [Call-through; read for the record:] closeout.mjs reads `ledger.mjs read`'s rows (249-257) and, per claim with no PR, runs `release-ticket.sh <N> impl-<N> implementer --apply` (270) then `ledger.mjs settle <member>=released` (277); closeout.mjs also opens and merges the Close-out PR (`gh pr create --head … --label patch`, `gh pr merge … --match-head-commit`, closeout.mjs:419, 599). Its exit 4 is `NEED hand-release #<N> …`.
- Scope today: per-object from the ledger's rows (this run's `impl-<N>` tokens without a PR)
- Feeds / Selected by: Selected by: the ledger (local, invisible to other Instances) via `ledger.mjs read`. Feeds S4-12's targets (release-ticket.sh's label removal and branch delete).
- Exists because: "Nothing else in the loop fires for those claims" (header 134).
- Own-work limit: only this Instance's own claims named in its ledger; a ticket row not provably this Instance's claim is never released (stall).
- Mark: object: issue and branch; nearest mark today: the local ledger row (`ledger` mark: not on GitHub); tells Instances apart under one gh user: no (the ledger is invisible to the other Instance, and the GitHub-side marks are shared); under different gh users: no
- Notes: see S8a for closeout.mjs's own entries. `drain` also begins the drain marker locally (`ledger.mjs drain`).

---

## Markers this slice writes to GitHub (verbatim shapes)
- Issue comments: `*Relabelled by the fleet controller.* Pulled for implementation and returned: …` / `*Closed by the fleet controller.* Pulled for implementation and found already fixed on origin/main: <detail>.` (plugin/skills/run-team/briefs/relabel.md:7-24; fleet-event.mjs:477). No member, run or Instance token.
- PR comments: `**<member> halted: \`<cause>\`.**` (fleet-event.mjs:647) and `**<member>, a repair finisher, read back no \`<ready-to-merge>\` on PR #<M>.**` (662). `<member>` is `finisher-pr-M[-x]` (ledger-grammar.mjs:78) — a ledger name with no Instance part.
- Labels it adds/removes: the Label map's `needs-triage`, `ready-for-human`, `ready-for-agent`, `in-progress` strings (fleet-event.mjs:241-246, 443, 454, 500).
- No commit message, trailer, PR body or branch name is written by S4 files; branch names it reads: `implementer/<N>-impl-<N>` (ledger.mjs:2871).
- Ledger-only tokens (NOT on GitHub, invisible to other Instances): `impl-N[-x]`, `fix-pr-M`, `finisher-pr-M`, `merge-bot-n`, `review-pr-M[-x]` (ledger-grammar.mjs:78, 613), `queued=`, `brief=`, `agent=`, `session=` (157), `conflict-hold:#M`, `parked=`, `reviewed=…`, `ci=…`.

## Checked, own-only or config
- `plugin/scripts/ledger.mjs:1646-1781` — `rotate`: moves the ledger file and records the controller in the heartbeat file; refuses a second live controller in the same checkout (1666-1668, host-local, context only); no `gh`, no `git` remote call.
- `plugin/scripts/ledger.mjs:744-936` — `read`, `row`, `filed`, `ruled`, `drain`, `undrain`, `token` (3191), `review` (3011): rewrite the local ledger only; `row`/`token`/`review` carry PR numbers and tokens as text, none reads GitHub.
- `plugin/scripts/ledger.mjs:2263-2465` — `dispatch impl-N|fix-pr-M`: local only (ledger, row, `agents/`, rendered brief, report clear 2435); the claim is not read or written here; only `finisher-pr-M` (S4-8) and `merge-bot` (S4-4) reach gh.
- `plugin/scripts/ledger.mjs:2219-2226` — `readyLabel`: Label map read (`label-map.mjs`), config.
- `plugin/scripts/ledger.mjs:2199` — `repoLabels()` / `gh label list --json name --limit 1000` (release-labels.mjs:13): list of the repository's labels, config.
- `plugin/scripts/ledger.mjs:2837-2839` — `git rev-parse --verify origin/main^{commit}`, `derive-testcmd.sh . check|test --at origin/main`: origin/main content and Recipe cache, config.
- `plugin/scripts/ledger.mjs:2851` — `git rev-parse <head>^{tree}` on a head S4-6/S4-7 already named: local object read.
- `plugin/scripts/ledger.mjs:1262`, `:1277`, `:2049` — `git rev-parse --show-toplevel|--git-common-dir` on the ledger's directory: repository location, config.
- `plugin/scripts/ledger.mjs:2010-2028` — `rulingOf`: reads `docs/metrics/tier-outcomes.tsv` in the checkout, local.
- `plugin/scripts/ledger.mjs:2801-2806`, `:2841-2849` — member report and Check-step record files under `<scratch>/reports`: host-local files.
- `plugin/scripts/ledger.mjs:2910-2927` — the fix-applier's dispositions record file: host-local.
- `plugin/scripts/fleet-event.mjs:285-293` — `ledger.mjs read` of this run's ledger: local.
- `plugin/scripts/fleet-event.mjs:1006` — `readLabelMap()`: Label map, config.
- `plugin/scripts/fleet-event.mjs:578-588` — `recipeWake`: `recipe-read.mjs` → `derive-testcmd.sh . install|check|test --at origin/main` from the main checkout: Recipe cache/origin/main, config.
- `plugin/scripts/fleet-event.mjs:628-631` — `dispositions-check.mjs --member <member> --scratch <scratch>` for this run's own review fix-applier (the member's own PR): call-through, per-object from the member; S7's file reads it.
- `plugin/scripts/fleet-event.mjs:684-708` — `park`: reads `<scratch>/pr<pr>/<member>/ci.json` (local) and writes a `parked=` ledger token via `ledger.mjs token`: local, no GitHub.
- `plugin/scripts/fleet-event.mjs:732-751`, `:753-785`, `:826-840` — `review-result`, `review-failed`, `conflict`: ledger tokens from local files and rows; no GitHub.
- `plugin/scripts/fleet-event.mjs:790-820` — `ci <pr>`: `node ci-state.mjs --pr <pr>` for the PR number the controller passes (per-object; ci-state.mjs reads `gh run list --branch <branch> --workflow …` at 743-744, `gh run view <id>` at 831-832, `gh api graphql` at 460-461, `gh api repos/{owner}/{repo}/compare/…` at 896 — other slice's file) then a local `ledger.mjs token`.
- `plugin/scripts/fleet-event.mjs:898-938` — `member-died`: reads the session directory and heartbeat file, settles a ledger member; no GitHub.
- `plugin/scripts/fleet-event.mjs:475` — `verify-sha.sh main <sha>`: fetches `origin main`, shared repository content, config.
- `plugin/scripts/ledger-grammar.mjs` — all (see no-GitHub list).
- `plugin/skills/run-team/references/ledger.md:7-30`, `:61-121` — descriptions of the lock, row grammar, rotate, tokens and suite slots: local ledger/host-local; the lines that name GitHub reads are S4-2 and S4-3.

## Files with no GitHub access
- `plugin/scripts/ledger-grammar.mjs` (pure grammar: member/token/row parsing; defines the member-name form `impl|fix-pr|finisher-pr|merge-bot-<n>[-x]` at :78, no `gh`/`git`/network, no process spawn)
- `plugin/scripts/report-files.mjs` (reads `<scratch>/reports/<member>.json` and `<member>.check.json`; file reads only, :1-18)
- `plugin/scripts/report-schema.mjs` (report schemas and validation; file reads only; the PR numbers, `branch` and `head` strings that S4-5/6/7 read are fields defined here at :124-176)
