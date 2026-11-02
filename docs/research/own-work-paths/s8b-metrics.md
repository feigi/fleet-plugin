# S8b — metrics and telemetry (snapshot 1a9692aa)

All citations are lines of `origin/main` 1a9692aa, relative to repo root.

### S8b-1 Cost guard lists every PR of the repository created since the window start
- Where: `plugin/scripts/pr-cost.mjs:406-421` (the `gh` call at `:409-412`), `plugin/scripts/pr-cost.mjs:124-142` (`readPrs`, the slicing), `plugin/scripts/pr-cost.mjs:423` (call), `plugin/scripts/pr-cost.mjs:98` (`WINDOW_START = "2026-10-03"`), `plugin/scripts/pr-cost.mjs:104` (`GH_PR_LIMIT = 1000`)
- Kind: read-select
- Does: `execFileSync("gh", ["pr", "list", "--state", "all", "--search", \`created:${created}\`, "--limit", String(GH_PR_LIMIT), "--json", "number,state,mergedAt"])`. No `--author`, no `--label`, no `--base`. `readPrs` re-reads halved `created:` date slices until every slice is short of the 1000 cap (`:130-139`); a one-day slice still full is exit 2 (`:135-137`). Fields requested are `number,state,mergedAt` only — no author, head branch or label is fetched.
- Scope today: repo-wide (every PR of the repository in every state, from any author, from `2026-10-03` on)
- Feeds / Selected by: Feeds `computeReport` (`plugin/scripts/pr-cost.mjs:161-162`) → `attribute()`, which uses the list only as a number→state map: `plugin/scripts/pull-attribution.mjs:360` (`state = new Map(prs.map(p => [String(p.number), p.state]))`), `:371-372` (a ruled PR that is OPEN or absent from the list → `pendingPr`; `merged = s === "MERGED"`), `:374-375` (an unruled Pull's own implementer PRs that are OPEN → pending; MERGED with no Ruling → `noRulingPrs`). Output goes to stdout and, with `--guard`, to `.fleet/cost-guard.json` (`plugin/scripts/pr-cost.mjs:437-446`, path `:358-366`). That file is the router's fail-closed input and fleet-tick's `router` row (`plugin/scripts/fleet-tick.mjs:499-550`), and the cockpit's Cell evidence (see S8b-6). Selected by: nothing the Instance created — the date window only. The PR numbers actually looked up come from the three metrics TSVs read at `plugin/scripts/pr-cost.mjs:397-399` (`docs/metrics/member-outcomes.tsv` `pr` column, `tier-outcomes.tsv` `pr` column, `ticket-features.tsv`).
- Exists because: `plugin/scripts/pr-cost.mjs:11-12` "for merged state, which tier-outcomes.tsv does not record"; `:17-19` "a PR that merged but past a truncated read would be counted pending, silently". The pagination exists only because the read is repo-wide.
- Own-work limit: read only the state of the PR numbers this Instance's own rows name (the PRs its own Pulls opened, from its own ledger/transcripts), never a repository list; for a PR whose ownership is unknown, count it neither merged nor failed (today an absent number already reads as pending, `pull-attribution.mjs:371`) and stall the verdict rather than guess.
- Mark: object that would carry ownership: PR (and the corpus row naming it); nearest mark today: none on the corpus rows — `member-outcomes.tsv` COLUMNS (`plugin/scripts/member-outcomes.mjs:199-204`) and `ticket-features.tsv` FEATURE_COLUMNS (`plugin/scripts/pull-attribution.mjs:95-99`) have no Instance/host/author column; the `gh` call asks for no author; tells Instances apart under one gh user: no; under different gh users: no (author login would, but the call does not fetch it)
- Notes: The TSVs are tracked files committed by the Close-out PR (`plugin/scripts/closeout.mjs:161` `METRICS`), so once another Instance's rows reach `origin/main` they sit in this Instance's corpus and the guard counts them; only rows not yet merged are host-local. Wider than own work in the other direction too: PRs in the list with no corpus row are never looked at (only looked up by number), so the repo-wide breadth costs reads, not decisions. No GitHub write.

### S8b-2 Ruling row appended by hand for any merged PR named on the command line
- Where: `plugin/scripts/tier-outcomes.mjs:803-897` (`append`), `:812-823` (verdict flags → `byHand`), `:847-856` (state gate), `:875-876` (ticket), `:891-896` (row written), `:507-521` (`ghPrView`), `:527-535` (`closingIssueNumbers`), `:794-801` (`prState`), `:564-580` (`ticketFor`)
- Kind: write
- Does: `append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no --note <text>` runs `gh pr view <pr> --json state` (`prState`, `:850`), requires `MERGED` (`:854-856`), then `gh pr view <pr> --json closingIssuesReferences,url` (`closingNumbers`, `:875`), takes the PR's one own-repository closing issue as `ticket` (`ticketFor`, `:565`: `numbers.length === 1` → ticket, no ledger consulted) and appends the Ruling row `run_date,pr,ticket,…,closed_own_ticket,minted_false_claim,note` to `docs/metrics/tier-outcomes.tsv` (`:891-896`). `GH_REPO` is blanked (`:511`), so `<pr>` resolves in the cwd's repository. Local ledger is read (`readLedger`, `:846`) but with a PR that closes exactly one issue it is not required to name the PR.
- Scope today: per-object from argv PR number; no precondition (no ledger row, no author, no branch check). Any MERGED PR of the repository passes.
- Feeds / Selected by: Selected by the controller's typed argument: `plugin/skills/run-team/SKILL.md:286` ("append one row … when you rule each PR's review … `tier-outcomes.mjs append <pr>`"), `plugin/skills/run-team/references/pull.md:488-500` (by-hand verdicts "for a merged PR whose evidence is reclaimed"), and the close-out step's `NEED tier-outcomes append <n>` (`plugin/scripts/closeout.mjs:327-328`). Feeds the Ruling the cost guard reads: `rulingFor`/`rulingsByTicket` (`plugin/scripts/tier-outcomes.mjs`, imported by `plugin/scripts/pull-attribution.mjs` and `plugin/scripts/cell-readout.mjs:91`) → `merged`/`failed` per Pull (S8b-1), and the Ruling row is committed by the Close-out PR (`plugin/scripts/closeout.mjs:161`).
- Exists because: header `plugin/scripts/tier-outcomes.mjs:110-114` "Verdicts given by hand … are written as given for a PR GitHub reports MERGED" — a merged PR's evidence is reclaimed with its scratch (`:784-786`).
- Own-work limit: only targets a PR this Instance's own run reviewed/ruled (its own ledger row names it); when the PR is not on this Instance's ledger (ownership unknown) it must refuse and stall, not write on the strength of `MERGED` alone. Today the by-hand path never asks.
- Mark: object that would carry ownership: PR (or the ledger-side row naming it, which is host-local); nearest mark today: closing reference (`closingIssuesReferences`, `:528`) — ties PR to ticket, not to an owner; tells Instances apart under one gh user: no; under different gh users: no (author login is not read here)
- Notes: The derived-from-Charges path (S8b-3) is gated by this Instance's ledger and scratch; this by-hand path is the one that is not. `check` (not `append`) reads no PR.

### S8b-3 Ruling row derived from Charges, gated by this Instance's ledger
- Where: `plugin/scripts/tier-outcomes.mjs:857-873` (derived branch), `:762-782` (`scratchRuling`), `:759-760` (`firstReview(prTokens(ledger.rows, pr))`), `:859-867` (state read only on refusal), `:875-876` (`closingNumbers`), `:487-500` (`readLedger`), `:546-557` (`implementerClaims`), `:891-896`
- Kind: write
- Does: `append <pr>` with no verdict flags: `readLedger(paths.ledger, false)` (`:846`, `node ledger.mjs [--file <ledger>] read`), `scratchRuling` → `firstReview(prTokens(ledger?.rows, Number(pr)))` — a `reviewed=` token of the PR on the run ledger — else `{missing}` and refusal (`:764-766`). On a refusal it calls `gh pr view <pr> --json state` (`prState`, `:863`) only to word the next step (`nextStep`, `:787-792`). Then `gh pr view <pr> --json closingIssuesReferences,url` (`:875`), `ticketFor` (zero or several closing issues fall back to the one settled `impl-<N>=PR#<pr>` token in the run ledger, `implementerClaims`, `:548-557`, `:564-580`), and the row is appended (`:891-896`).
- Scope today: per-object from the run ledger — a PR with a `reviewed=` token on the ledger `--ledger`/default names. `--ledger <path>` can name any ledger file (`:437`, `:945`).
- Feeds / Selected by: Selected by the ledger's `reviewed=` rows, which the controller wrote when its own review runners returned (ledger is `.fleet/` local, invisible to other Instances). The ledger can also hold PRs the run adopted rather than created (Fold-in) [INFERENCE: whether Fold-in rows carry `reviewed=` is in another slice]. Feeds the same Ruling as S8b-2 (guard, `pull-attribution.mjs:360-375`) and `ledger.mjs dispatch`'s finisher gate (`plugin/scripts/ledger.mjs:2011-2026` reads this TSV).
- Exists because: `plugin/scripts/tier-outcomes.mjs:2-5` the tier column "used to be typed by hand from what the controller MEANT to dispatch"; Ruling "worked out from the Charges the fix-applier recorded" (`:79-83`).
- Own-work limit: only targets a PR this Instance's own ledger row names as reviewed by this Instance's own run; ownership unknown (no ledger token) → refuse and stall (today it refuses, `:764-766`, but the same PR number can then be ruled by hand via S8b-2).
- Mark: object that would carry ownership: ledger row (host-local) / PR; nearest mark today: none on GitHub — the gate is the local ledger; closing reference supplies `ticket`; tells Instances apart under one gh user: yes, but only through the host-local ledger (invisible on GitHub); under different gh users: yes (same)
- Notes: The two `gh pr view` reads here are per-object and only decide row text; the ownership precondition is purely local state gating a row that later merges into the shared corpus.

### S8b-4 `check --live` reads closing references of every PR the ledger marks reviewed
- Where: `plugin/scripts/tier-outcomes.mjs:920-933` (`check --live`), `:410-421` (`unrecordedReviewedPrs`), `:899-909` (`closingNumbersOrNull`), `:527-535`, `:507-521`; consumed by `plugin/scripts/closeout.mjs:325-328`
- Kind: read-inform
- Does: `readLedger(paths.ledger, true)` (`:921`), then for each PR with a `reviewed=` row and no row in `tier-outcomes.tsv` (`:922`) runs `gh pr view <pr> --json closingIssuesReferences,url` (`:923` → `:507-512`, 60 s timeout, `GH_REPO` blanked) and prints `WARNING PR #<n> carries reviewed= on the ledger but has no row …` (`:931`) or a `note` line (`:927`).
- Scope today: per-object from run ledger rows (`reviewed=` token, PR from `rowPr()` or the row key, `:416-417`).
- Feeds / Selected by: Selected by this run's ledger rows. Feeds `closeout.mjs:327-328`: every `WARNING PR #(\d+) carries reviewed=` becomes `NEED tier-outcomes append <pr>` and the close-out step stays pending (`pending(...)`), i.e. it blocks Close-out until a Ruling exists (S8b-2/S8b-3).
- Exists because: close-out must not finish with a reviewed PR unruled (`plugin/scripts/closeout.mjs:34-38`).
- Own-work limit: only PRs this Instance's own ledger names as reviewed by this Instance's own run; a ledger row for a PR of unknown ownership (adopted) must not create a `NEED` for this Instance — stall/skip.
- Mark: object that would carry ownership: ledger row / PR; nearest mark today: none on GitHub; tells Instances apart under one gh user: yes via local ledger only; different gh users: yes (same)
- Notes: A PR whose read fails keeps its warning after a line that never reads `WARNING PR #` (`:899-901`).

### S8b-5 Phase 0 and Close-out refresh run the repo-wide cost-guard read
- Where: `plugin/scripts/metrics-refresh.mjs:259-276` (`costGuard`, `spawnSync(process.execPath, [PR_COST, "--guard", "--out", out])` at `:266`), `:363-372` (duty loop), `:98` (`PR_COST`); callers `plugin/scripts/phase0.mjs:312`, `plugin/scripts/closeout.mjs:333`; doc `plugin/skills/run-team/references/phase-0.md:230-233`, `plugin/skills/run-team/references/close-out.md:106-113`
- Kind: read-select
- Does: after `drain` and `widenMemberOutcomes`, if all three `docs/metrics/*.tsv` exist, spawns `pr-cost.mjs --guard --out <repo>/.fleet/cost-guard.json` — i.e. S8b-1's repo-wide `gh pr list --state all --search created:…` on every run start and every close-out; exit 3/4 are verdicts (`:108-110`, `:269`). Then `preview()` (`:337-346`) fits the Preview over the same TSVs and the guard (local files only).
- Scope today: repo-wide (inherits S8b-1).
- Feeds / Selected by: Feeds `.fleet/cost-guard.json` (`:104`, host-local) and `.fleet/router-preview.json` (`:105`); the guard is what the router and tick read (`plugin/scripts/fleet-tick.mjs:499-550`). Selected by: every run's phase 0 and close-out, unconditionally.
- Exists because: `plugin/scripts/metrics-refresh.mjs:51-52` "`pr-cost.mjs --guard` rewrites `.fleet/cost-guard.json`, which the router reads and fails closed without".
- Own-work limit: same as S8b-1 — its read limited to PR numbers this Instance's own rows name.
- Mark: as S8b-1 (none today).
- Notes: `plugin/scripts/metrics-refresh.mjs:22-26` records the single-controller assumption: the pending-features drain "takes no lock by design … One controller per checkout is the rule, but phase 0 refuses a second one at its ledger rotation, which runs after its drain step, so a second controller's drain is not guarded." That drain is host-local file I/O (`.fleet/ticket-features.pending.tsv`, `:99`), listed here only because the comment names the multi-controller case. The `docs/metrics/*` writes (`drain` `:243-255`, `widen` `:214-216`, `preview` `:329-331`) are local file I/O and decide nothing from GitHub.

### S8b-6 Cockpit Cell evidence shows the repo-wide guard figures and tests the close-out PR against the open-PR list
- Where: `plugin/scripts/compute-cell-evidence.mjs:374-416` (`guardSection`, per-Cell n / fail rate / mean $), `:889-` (`noRulingAlert`, "Pulls that merged with no Ruling, per Cell"), `:812-820` (`prIsOpen`), `:829-884` (`recordsAgainstMain`, `openPrs` use at `:866-872`), `:937-950` (`computeCellEvidence` inputs); caller `plugin/scripts/compute-board.mjs:867-871` (`openPrs: { numbers: (inputs.prs ?? []).map(p => p.number), capped: … }`)
- Kind: read-inform
- Does: pure function, no GitHub call of its own. Lays out the guard file S8b-1 wrote — each Cell's `n_merged`, `n_claims`, `n_failed`, `fail_rate`, `mean_usd`, `no_ruling`, `pending` (`:408`, `:891`) — as the dashboard's Cell evidence tab, and checks whether the close-out receipt's PR (`closeoutPr.number`, `:865`) is in `openPrs.numbers` (`:817-819`) to word a records alert (`:866-872`).
- Scope today: repo-wide for the guard figures (counted from S8b-1's list and the shared corpus); for `prIsOpen`, the membership test of one own PR number in the board's open-PR list — that list is `compute-board.mjs:868`'s input `inputs.prs`, produced by `plugin/scripts/board-gather.mjs` (another slice; `prs`, `prsOk`, `prsCapped` at `board-gather.mjs:1361`).
- Feeds / Selected by: Feeds the board's `cellEvidence` (`plugin/scripts/compute-cell-evidence.mjs:1-5`). Selected by: guard file `.fleet/cost-guard.json` (S8b-5) and the board's open-PR list.
- Exists because: "what the cost guard holds each implementer Cell to, from the guard file and nothing recomputed" (`plugin/scripts/compute-cell-evidence.mjs:10-12`).
- Own-work limit: show only counts over PRs/Pulls this Instance's own rows name; `no_ruling` and `pending` PR counts and the `openPrs` membership test are the only parts that concern specific PRs, and the latter only ever asks about the Instance's own close-out PR.
- Mark: as S8b-1 (none on the corpus rows); the `openPrs` test is per own PR number, so no mark is needed for it.
- Notes: `pulls` (this run's Pulls, `:925-926`) comes from the board's cards and is the only own-run input; the guard figures are not.

## Checked, own-only or config
- `plugin/scripts/member-outcomes.mjs:327-334` — `verifyMainWithGit` spawns `sh verify-sha.sh main <sha>` (`plugin/scripts/verify-sha.sh:~28-31`: `git fetch --quiet origin main`, then `git merge-base --is-ancestor <sha> origin/main`); `<sha>` is the `bailDetail` of this member's own `fixed` bail report (`:294`); only `origin/main` content — config for this inventory.
- `plugin/scripts/member-outcomes.mjs:249-264` — `endingOf` reads the member's own transcript signals (`openedPrs`, reports); no GitHub call.
- `plugin/scripts/member-outcomes.mjs:412-531` — CLI scrape of `~/.omp/agent/sessions/<encoded cwd>/<session>` transcripts into `docs/metrics/member-outcomes.tsv`; host-local files, `pr` column taken from the member's own `gh pr create` output.
- `plugin/scripts/member-record.mjs:211-260` and `:356-359`, `:447`, `:479` — `createdPrNumbers`/`openedPrs` parse PR numbers out of the member's OWN `gh pr create` transcript results; reads transcripts, runs no `gh`.
- `plugin/scripts/member-record.mjs:833-847` — `ompMemberRecord` classifies roles and PR (`namedPr || openedPrs[0]`) from the transcript; no GitHub call.
- `plugin/scripts/tier-check.mjs:355` — `runLedger` runs `ledger.mjs [--file] read|settle|row`; the run's own ledger, host-local; its verdicts `tier-ok=`/`tier-mismatch=` are ledger tokens, not GitHub writes.
- `plugin/scripts/tier-check.mjs:451-529` — reads batch/agent-definition/transcript files; local.
- `plugin/scripts/tier-roles.mjs:195` and `:396`, `:407` — `omp config get` (`readOmpJson`) of `modelRoles` and `task.maxConcurrency`: host config, config.
- `plugin/scripts/tier-roles.mjs:359-370` (`semaphoreNotice`) — compares `task.maxConcurrency` with `2·B+2`; the In-flight bound value `B` is a CLI number (`:422-429`), nothing counted from GitHub.
- `plugin/scripts/tier-outcomes.mjs:240-340`, `:365-405` (`checkRows`), `:944-947` — member-outcomes vs tier-outcomes comparison over local TSVs; no `gh`.
- `plugin/scripts/tier-outcomes.mjs:487-500` — `readLedger` spawns `ledger.mjs read`; local file.
- `plugin/scripts/pr-cost.mjs:244-292`, `:330-348`, `:437-446` — `abReport`/`crossCheck`/`guardFile` and the guard-file write; local computation and `.fleet/cost-guard.json` write.
- `plugin/scripts/pr-cost.mjs:402-403` — reads `router-table.json` beside the script; config.
- `plugin/scripts/compute-cell-evidence.mjs:426-448` (`repoIdentity`) — parses the install's `package.json` `repository` url and the workspace's `repoUrl`; config, no call.
- `plugin/scripts/compute-cell-evidence.mjs:598-613`, `:829-884` (`mainMetrics`, `checkoutTable`) — compare TSV blob ids and the router table with `origin/main`'s as already read by board-gather (`board-gather.mjs:1356-1358`, another slice); `origin/main` content, config.
- `plugin/scripts/metrics-refresh.mjs:219-256` (`drain`), `:173-217` (`widenMembers`/`widenMemberOutcomes`), `:289-333` (`writePreview`) — `docs/metrics/*` and `.fleet/*` file I/O; no GitHub read decides any row.
- `plugin/scripts/cell-readout.mjs:85-91`, `:275` — `readFileSync` of the three TSVs; ranks Cells from local corpus, no GitHub.
- `plugin/scripts/frontmatter-check.mjs:44-47`, `:221`, `:232` — reads `.md` frontmatter and `frontmatter-allowlist.json`; local lint.

## Files with no GitHub access
- `plugin/scripts/member-record.mjs` (only parses `gh pr create` text out of transcripts; runs no `gh`, `git` or API call)
- `plugin/scripts/tier-check.mjs`
- `plugin/scripts/tier-roles.mjs`
- `plugin/scripts/cell-readout.mjs`
- `plugin/scripts/frontmatter-check.mjs`
- `plugin/scripts/frontmatter-allowlist.json`
- `plugin/scripts/compute-cell-evidence.mjs` (no call of its own; S8b-6 records what it shows)
- `plugin/scripts/member-outcomes.mjs` (no `gh`; one `git fetch origin main` through `verify-sha.sh`, listed in Checked)
