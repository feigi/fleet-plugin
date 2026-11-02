# S5b — the finisher and labels (snapshot origin/main 1a9692aa)

All paths are `plugin/…` at `origin/main` 1a9692aa. Common facts for the finisher scripts:

- **Selected by (the finisher's PR M).** The scripts never choose a PR: `--pr <M>` is an argument. It comes from the brief's `arg pr M` (`plugin/skills/run-team/briefs/finisher.md:4`, `:15`) and the member name `finisher-pr-<M>[-x]` (`briefs/finisher.md:21-22`), rendered by the controller with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<pr#> …` and recorded with `ledger.mjs dispatch <pr#> finisher-pr-<pr#>` (`plugin/skills/run-team/references/finisher.md:23-25`). The choice of M is the controller's: the CI Monitor edge (`references/finisher.md:45-85`), the `no-op` report edge (`:86-101`), the `no-ci` edge (`:102-112`), or the tick's `DISPATCH finisher` row, which is built from the open-PR list (`plugin/scripts/fleet-tick.mjs:428`, `:1209-1210`; tick-rows.md:34). No script in this slice compares M's head branch or author to the Instance's own claim before it writes.
- **The pin** (`--pin`) is the controller's dispatch pin; no script compares it to the PR's `headRefOid` (deliberately: `plugin/agents/fleet-finisher.agent.md:39-45`).
- **`gh` resolves the repository from the cwd's git remotes** (`finisher-label.mjs:161-163`, `:167`), so every `gh pr` call is per-number in the one repository the checkout's remote names.

### S5b-1 Finisher adds `patch` to a Ticketless PR
- Where: `plugin/scripts/finisher-label.mjs:217` (+ `:193-196` the Ticketless test, `:199-205` the zero-release-label read, `:213-220`)
- Kind: write
- Does: `gh pr edit <M> --add-label patch` (step `add-patch`), only when the PR carries none of `patch`/`minor`/`major`, the repo defines them, and `ticketlessVerdict` says Ticketless.
- Scope today: no precondition (read of labels at `:199`, write at `:217`, not atomic; nothing checks who owns PR M). Per-object from the `--pr` argument.
- Feeds / Selected by: feeds the exactly-one-release-label gate (`:223-225`) and so steps 2-3 (`:245`, `:256`). Selected by: PR M from the controller's dispatch (see common facts). The Ticketless verdict that unlocks it is decided from (a) `gh pr view <M> --json closingIssuesReferences,url` (`plugin/scripts/ticketless.mjs:82`) and (b) the run ledger's settled `impl-<N>=PR#<M>` tokens, read through `ledger.mjs read` on the checkout's own `.fleet/ledger.md` (`ticketless.mjs:99`, `:106`, `:115`). Host-local state gates this GitHub write.
- Exists because: "No ticket picks the bump of a Ticketless PR, so it gets the smallest" (`finisher-label.mjs:216`); `ledger.mjs dispatch` does not refuse such a PR (`plugin/scripts/ledger.mjs:2186-2187`, `:2204`).
- Own-work limit: only targets this Instance's own PR. Ownership must be proved before the Ticketless test is trusted: the test answers "Ticketless" for any PR that closes no own-repo issue and has no settled token in THIS Instance's ledger, so a PR another Instance implemented (whose token sits in that Instance's ledger) and whose body only says `Refs #N` reads as Ticketless here. When ownership is unknown: stall (exit 2/3), write nothing.
- Mark: PR; nearest mark today: none (the ledger token is host-local, ledger = invisible to other Instances; the closing reference ties PR to ticket, not to an owner); tells Instances apart under one gh user: no; under different gh users: no (the author login is never read in this path).
- Notes: a label write with no owner check; two Instances running a finisher on the same PR both read zero release labels and both add `patch` (idempotent label add, so no visible conflict).

### S5b-2 Finisher posts the head record comment `ready-to-merge-head: <pin>`
- Where: `plugin/scripts/finisher-label.mjs:245` (+ `:236` the grammar, `:241` the skip test, `:244-247`)
- Kind: write
- Does: `gh pr comment <M> --body "ready-to-merge-head: <pin>"` (step `comment`), skipped only when the newest matching comment already names this pin.
- Scope today: no precondition on owner (per-object from `--pr`); the skip test reads every comment on the PR regardless of author (see S5b-4).
- Feeds / Selected by: feeds the merge bot, which reads it as "the head the label was applied to" (`finisher-label.mjs:31-33`, `:46-47`; `plugin/skills/run-team/references/finisher.md:315-316`, `:384-386`) and the Ticketless-human path where the maintainer's `ready-to-merge` is merged off this record (`references/finisher.md:245`). Selected by: PR M from the controller's dispatch (common facts); pin from the controller's dispatch.
- Exists because: the label is "a verdict on the tree the finisher read, and a GitHub label does not follow the branch" (`references/finisher.md:305-308`); the record pins the head so the merge bot refuses a moved head.
- Own-work limit: only targets this Instance's own PR; posted only when the Instance can show M is its own; when unknown, stall and post nothing.
- Mark: **fleet comment marker — verbatim shape:** body is exactly `ready-to-merge-head: <40 lowercase hex>`; parsed by `/^ready-to-merge-head: ([0-9a-f]{40})\s*$/` (`finisher-label.mjs:236`); "the newest record wins" by `createdAt`, ties by list order (`:234-240`). Prefix fixed "whatever the Label map says" (`:45-47`). Nothing in the body names a run, member, Instance or ledger token. Comment: carries only a head SHA; nearest mark today: none for ownership (the comment's author login exists on GitHub but this script never reads it); tells Instances apart under one gh user: no; under different gh users: no in this code (the author login is not read) — [INFERENCE] GitHub itself stores the comment author, so a reader could compare it.
- Notes: the fixed 40-hex check is at `:141`; a short or uppercase pin is refused/folded.

### S5b-3 Finisher adds the `ready-to-merge` label
- Where: `plugin/scripts/finisher-label.mjs:256` (+ `:155-159` string from the Label map, `:242` already-labelled test, `:254-258`, `:249-252` the exit-5 hold)
- Kind: write
- Does: `gh pr edit <M> --add-label <Label map string for ready-to-merge>` (step `add-label`), skipped when the PR already carries the label and the newest record names this pin; not reached on a Ticketless PR whose diff is not inert (exit 5).
- Scope today: no precondition on owner (per-object from `--pr`).
- Feeds / Selected by: feeds the merge bot's queue (`ready-to-merge` is what it merges on; see `references/finisher.md:305-313`) and the cockpit/tick `unlabelled` flags (`plugin/scripts/compute-board.mjs:82-94`, `:293`; `plugin/scripts/fleet-tick.mjs:424-434`). Selected by: PR M from the controller's dispatch (common facts).
- Exists because: duty 3, "apply one release label … `ready-to-merge`" (`plugin/agents/fleet-finisher.agent.md:271-276`); a finisher that stopped after the precondition "reported `labelled` on a PR that never got the label" (`finisher-label.mjs:2-4`).
- Own-work limit: only targets this Instance's own PR; label added only after ownership is shown; when ownership is unknown, stall. The idempotence branch (`:255`) makes a second Instance's finisher on the same PR a no-op that still answers exit 0 off the read-back, so "labelled" cannot tell whose finisher put the label there.
- Mark: PR (label); nearest mark today: `ready-to-merge` label — state, not owner; tells Instances apart under one gh user: no; under different gh users: no.
- Notes: the read-back (`:261`, `gh pr view <M> --json labels`) is per-object from M and is listed under Checked.

### S5b-4 Finisher scans every comment on the PR for head records, whatever the author
- Where: `plugin/scripts/finisher-label.mjs:199-200` (the read), `:236-242` (the scan)
- Kind: read-select
- Does: `gh pr view <M> --json labels,comments`; the shape check requires only `body` and `createdAt` on each comment (`:200`); matching is by body regex alone (`:236-240`), the newest one decides `recorded` (`:241`).
- Scope today: per-object from `--pr` (PR M), but the records inside it are selected by content, not by author — a record posted by any commenter, another Instance's included, counts.
- Feeds / Selected by: feeds the comment write S5b-2 (skipped when `recorded`) and, through `recorded && labelled` (`:255`), the label write S5b-3. Selected by: PR M from the controller's dispatch.
- Exists because: "The newest record wins, the way the merge bot reads it" (`:234-235`); keeps the finisher idempotent.
- Own-work limit: must count only records this Instance's own finisher posted for this Instance's own PR; a record it cannot attribute must not satisfy `recorded` (stall rather than skip the write or answer success).
- Mark: comment; nearest mark today: none read (the body has only the SHA); tells Instances apart under one gh user: no; under different gh users: no in this code (author not read).
- Notes: the same pattern on the merge-bot side is in S5a's slice.

### S5b-5 Label map `set --create` creates a label in the shared repository
- Where: `plugin/scripts/label-map.mjs:708` (+ `:339-341` the `gh` wrapper, `:646`, `:715` "already exists" counts as existing, `:701-718`, `:719-732`)
- Kind: write
- Does: `gh label create [--] <string>` (no colour) for each Label role whose string is missing from the live label list, only under `--create`; the live list is then re-read (`:720`).
- Scope today: no precondition (repo-wide shared configuration object; a concurrent create by another Instance answers "already exists" and is accepted, `:646`, `:714-717`).
- Feeds / Selected by: feeds the cached Label map (`.fleet/labels.json`, host-local; `label-map.mjs:10-13`), which every label write in this slice reads (`finisher-label.mjs:156`). Selected by: the `<role>=<label>` answers and `--accept-suggestions` from the maintainer (`:663-686`), reached from `skills/next-ticket/SKILL.md:24`, `skills/run-team/SKILL.md:70`, `skills/run-team/references/phase-0.md:166-167` and `commands/review-and-fix.md:10` (instructions in other slices).
- Exists because: a role's string "not in the tracker" would make every later label write or read name a label that does not exist; created "on your confirmation".
- Own-work limit: a label is nobody's work; creation is bounded by the maintainer's confirmation. What differs per Instance is the cache: the map is host-local (`:10-13`) and `origin` records "maintainer" answers, so two Instances can hold different strings for one role until each is asked. Needed: both must resolve to the one string the tracker has, or stall.
- Mark: none (label list is config, not a work object); tells Instances apart: not applicable.
- Notes: never creates a label from `ensure` (`:41-44`, `:615-642`); the creation write exists only in `setLabelMap`.

### S5b-6 Agent instruction: run `finisher-label.mjs` on the dispatched PR
- Where: `plugin/agents/fleet-finisher.agent.md:271-289` (+ `:11`, `:272`)
- Kind: instruction-write
- Does: "`~/.fleet/bin/fleet-run finisher-label.mjs --pr <M> --pin <your dispatch pin>`": confirms one release label (adds `patch` to a Ticketless PR with none), records the audited head, adds `ready-to-merge`, reads back.
- Scope today: per-object from the brief's PR M; no precondition on owner.
- Feeds / Selected by: feeds S5b-1, S5b-2, S5b-3. Selected by: `<M>` is "the PR's number" the brief names (`fleet-finisher.agent.md:7`; `briefs/finisher.md:15`), from the controller's dispatch.
- Exists because: "Duty 3 is one script, and its exit code is your verdict" (`:271`); a halt at any earlier duty "leaves `ready-to-merge` off: you add no label" (`:11`).
- Own-work limit: the finisher may run it only on a PR the dispatching Instance owns; the dispatch gate (S5b-8, S5b-9, and Checked list) reads only PR M's own state, never ownership.
- Mark: PR; nearest mark today: none (the member name `finisher-pr-<M>[-x]` names the PR number, not an Instance); tells Instances apart under one gh user: no; under different gh users: no.
- Notes: `--repo` is not passed by the prompt, so `gh` runs in the finisher's cwd.

### S5b-7 Agent instruction: tracker-wide duplicate search before filing a deferral
- Where: `plugin/agents/fleet-finisher.agent.md:92-110` (same text `plugin/skills/run-team/references/finisher.md:189-207`)
- Kind: instruction-read
- Does: "file it the way step 5 does, through `ledger.mjs check "<subject>"`, never a bare search"; "a deferral it reads as unfiled may already be on the tracker under someone else's wording". `ledger.mjs check` runs `gh issue list --search <query> --state all --limit … --json number,title,state,url` (`plugin/scripts/ledger.mjs:1332-1334`). The by-hand home test (`agent.md:85-91`: "A comment on an existing *follow-up* issue is filed") also reads whichever tracker issue the finisher decides holds the deferral; no command is named.
- Scope today: repo-wide (every issue, all states, by text).
- Feeds / Selected by: feeds S5b-8 (the filing/comment) and the `needs-triage` count the step-5 guard reads (`agent.md:101-104`: "open `needs-triage` issues citing `Deferred from PR` above 40 on 3 consecutive run dates" — a repo-wide count, another slice). Selected by: the finisher's own subject string for each deferral.
- Exists because: "never a bare search" (`:96`): a duplicate filed twice.
- Own-work limit: a hit written by another Instance's run is a legitimate duplicate of the same tracker work, but the finisher must not treat it as its own home or comment on it as if it owned it. Needed: read-only against others' issues; ownership of the home unknown → stall (halt), do not file or comment.
- Mark: issue; nearest mark today: none (`needs-triage` label is state; title/subject text is the only key); tells Instances apart under one gh user: no; under different gh users: no.
- Notes: `ledger.mjs filed <N> "<subject>"` (`agent.md:107`) records the filing in the local ledger only.

### S5b-8 Agent instruction: file a `needs-triage` issue, or comment on a found duplicate
- Where: `plugin/agents/fleet-finisher.agent.md:94-110` (same text `references/finisher.md:191-207`)
- Kind: instruction-write
- Does: "file it … labelled `needs-triage` … its body carrying the refuter's verdict or the review's votes and the candidate remedy" (`gh issue create`, named at `:108`); "A duplicate is a comment citing that verdict on the existing issue, never a relabel" (`:98-100`).
- Scope today: `gh issue create` — creates a new object (own by construction); the comment — per-object from S5b-7's search hit (an issue the search chose, not one this Instance created), no precondition.
- Feeds / Selected by: feeds the maintainer's triage queue and the `needs-triage` count above. Selected by: S5b-7's hit (`ledger.mjs:1332`) for the comment; none for the create.
- Exists because: "What fails is a promise living only in a PR body" (`:91-92`); a deferral needs a home that outlives the merge.
- Own-work limit: create is own. The comment lands on an issue found by a tracker-wide search, which may belong to another Instance's work or to nobody's; it is a write on work this Instance did not start. Must be limited to issues this Instance filed itself, or stall when ownership is unknown.
- Mark: issue/comment; nearest mark today: none; tells Instances apart under one gh user: no; under different gh users: no.
- Notes: duty 2 text says the finisher "files last", after the reviewer; so another Instance's fix-applier could have filed the same deferral in parallel.

### S5b-9 Controller instruction: repair a PR body to match its ruling
- Where: `plugin/skills/run-team/references/finisher.md:122` (the full line is truncated in the display; read with `:raw:122-122`); the refusal message that carries the command is `plugin/scripts/ledger.mjs:2163`, `:2167`, `:2174`
- Kind: instruction-write
- Does: "The controller repairs the body itself with `gh pr edit <M> --body-file <file>`, then dispatches the finisher again" after `ledger.mjs dispatch` refused over closing references; the refusal asks to add `Closes #<N>` or to rephrase as `Refs #<N>` (`ledger.mjs:2163`, `:2167`).
- Scope today: per-object from PR M, which is the finisher gate's PR.
- Feeds / Selected by: feeds the second dispatch attempt. Selected by: the PR the gate refused (`ledger.mjs:2395-2409`), M chosen as in the common facts.
- Exists because: closing references must match the ruled `closed_own_ticket` verdict, else a merge closes the wrong ticket or the PR's own suggestion-band record (`references/finisher.md:122`, `ledger.mjs:2143-2147`).
- Own-work limit: only edits the body of this Instance's own PR; nothing in the instruction checks ownership, so when ownership is unknown it must stall.
- Mark: PR; nearest mark today: closing reference (`Closes #<N>` ties PR to ticket, not owner); tells Instances apart under one gh user: no; under different gh users: no.
- Notes: the edit REPLACES the whole body (`--body-file`), not an append.

### S5b-10 Controller instruction: add or remove a release label on the PR the gate refused
- Where: `plugin/skills/run-team/references/finisher.md:123` (read with `:raw:123-123`); command text in the refusal at `plugin/scripts/ledger.mjs:2209` (`gh pr edit ${pr} --add-label <patch|minor|major>`)
- Kind: instruction-write
- Does: "The controller adds or removes the label itself, then dispatches the finisher again" — `gh pr edit <M> --add-label <patch|minor|major>`, or a removal when several are found (`ledger.mjs:2198`).
- Scope today: per-object from PR M; no precondition.
- Feeds / Selected by: feeds the exactly-one-release-label test the gate and `finisher-label.mjs:203-225` both make. Selected by: the PR the gate refused (`ledger.mjs:2406-2409`).
- Exists because: "the bump, or which label stays, is not picked for the controller" (`references/finisher.md:123`).
- Own-work limit: only edits this Instance's own PR's labels; stall when ownership is unknown.
- Mark: PR (label); nearest mark today: `patch`/`minor`/`major` labels — state, not owner; tells Instances apart: no / no.
- Notes: none.

### S5b-11 Controller instruction: take `ready-to-merge` off a PR before approving a push
- Where: `plugin/skills/run-team/references/finisher.md:303-319` (the instruction to clear the label; `label-off=` first, then the removal); `plugin/skills/run-team/references/ledger.md:97` states the token
- Kind: instruction-write
- Does: remove the Label map's `ready-to-merge` label from PR M, preceded by the ledger token `label-off=<finisher-pr-M[-x]>` so the tick does not read the removal as a finisher's miss (`plugin/scripts/fleet-tick.mjs:659-670`, `:678-679`; `plugin/scripts/ledger.mjs:216-217`). The command is not spelled out in this file.
- Scope today: per-object from PR M; no precondition.
- Feeds / Selected by: feeds the merge bot's queue (removing the label is "the reliable stop", `:311-312`) and the tick's `unlabelled` reading. Selected by: the PR whose member the controller is about to let push, or whose label is "left on a moved head" (`:318`).
- Exists because: "a GitHub label does not follow the branch — on one PR it survived a push and came to sit on a commit nobody had audited" (`:306-308`).
- Own-work limit: only removes the label from this Instance's own PR; the `label-off=` token is host-local, so another Instance's tick never sees it and reads the removal as a finisher miss.
- Mark: PR (label); nearest mark today: `ready-to-merge` label (state) + host-local ledger token; tells Instances apart: no / no (the token is invisible to other Instances).
- Notes: none.

### S5b-12 Controller/finisher dispatch: which PR gets a finisher
- Where: `plugin/skills/run-team/references/finisher.md:45-85` (CI Monitor edge `fleet-event.mjs ci <pr>` → `ci-state.mjs --pr <N>`), `:86-101` (no-op report edge), `:102-112` (`no-ci` edge), `:406-422` (resolving a finisher that died); tick path `plugin/scripts/fleet-tick.mjs:428`, `:1209-1210`
- Kind: instruction-read
- Does: the controller decides M from the CI result of a PR, the fix-applier's report, or the tick's `DISPATCH finisher PR#<M>` row ("a finisher settled `labelled`, yet the open list shows PR M without `ready-to-merge`", `references/tick-rows.md:34-36`). The open list is a repo-wide PR list read by the tick (`fleet-tick.mjs:1209-1210`, not this slice).
- Scope today: label-wide / repo-wide for the tick path (open PRs without the label); per-object from M for the CI-edge path.
- Feeds / Selected by: feeds every write in S5b-1 through S5b-3. Selected by: the tick's `unlabelled` fold (`fleet-tick.mjs:729-733`) and the controller's ledger rows.
- Exists because: "Reconcile, do not wait for an event" (`references/finisher.md:96`); an edge-only path strands PRs that needed nothing fixed.
- Own-work limit: only PRs named by a row in this Instance's ledger; a PR with no row in this Instance's ledger must never reach a finisher. [INFERENCE] The tick's open-PR list comes from outside this slice; whether it is filtered to the Instance is S3Tick's finding.
- Mark: PR; nearest mark today: none on GitHub (the ledger row is host-local); tells Instances apart: no / no.
- Notes: none.

### S5b-13 Cockpit flag over PRs whose finisher died
- Where: `plugin/skills/run-team/references/finisher.md:408-422` (the instruction text); code: `plugin/scripts/compute-board.mjs:89-94`, `:292-294`, `:507-509`
- Kind: read-inform
- Does: "The cockpit flags a REVIEW-column open PR without the label, whose latest finisher attempt settled `failed` or `killed`" — a card flag `finisher:failed`/`finisher:killed` at severity 4. Informs only; "You never add the label yourself, and the tick does not retry" (`:422`).
- Scope today: label-wide (open PRs lacking `ready-to-merge`) intersected with this Instance's ledger rows.
- Feeds / Selected by: feeds the human reader only. Selected by: the board's open-PR read plus the ledger rows (compute-board.mjs, another slice).
- Exists because: "A finisher settled `failed` or `killed` left its PR without `ready-to-merge`, and nothing else notices" (`references/finisher.md:408-410`).
- Own-work limit: show only cards whose PR is this Instance's own.
- Mark: PR; nearest mark today: none on GitHub; tells Instances apart: no / no.
- Notes: with no Label map read, these flags are suppressed (`compute-board.mjs:652-655`, `:804-805`).

## Checked, own-only or config
- `plugin/scripts/finisher-label.mjs:156` — `readLabelMap`: reads the host-local `.fleet/labels.json` cache (label-map.mjs:235-247); no GitHub call; config.
- `plugin/scripts/finisher-label.mjs:206` — `gh label list --json name --limit 1000` (`release-labels.mjs:12-13`): the repository's label list, only to learn whether `patch`/`minor`/`major` are defined; config.
- `plugin/scripts/finisher-label.mjs:261` — read-back `gh pr view <M> --json labels` after this run's own write; per-object on PR M, own-only after S5b-3.
- `plugin/scripts/finisher-label.mjs:231` and `plugin/scripts/finisher-scope.mjs:174`, `:178`, `:180`, `:186` — `git rev-parse refs/remotes/origin/main`, `merge-base`, `diff-tree` at the dispatch pin; local git; `origin/main` content is config. No `gh pr view --json files` (`finisher-scope.mjs:14`).
- `plugin/scripts/ticketless.mjs:82` — `gh pr view <M> --json closingIssuesReferences,url`: per-object on the dispatched PR; read-only, feeds S5b-1. The ledger read at `:106` is host-local.
- `plugin/scripts/finisher-audit.mjs:276` — `git ls-remote origin refs/heads/<branch>`, `<branch>` the audited worktree's row (`:407`, `:420`): per-object keyed by the dispatched member's own branch, full ref name so it matches only itself (`:127-130`); the remote is "asked rather than the PR object" (`:140-141`). Own-only.
- `plugin/scripts/finisher-audit.mjs:348` — `sh worktree-audit.sh` in `--repo`: lists this checkout's worktrees (local); the row is chosen by `realpath(--worktree)` (`:360`). No `gh`.
- `plugin/scripts/finisher-audit.mjs:403` — `git range-diff … origin/main <pin> HEAD`: local objects; `origin/main` is config. Nothing is fetched (`:142-143`).
- `plugin/scripts/finisher-tree.mjs:141` — `git worktree add --detach <scratch>/pr<N>/finish-<member> <pin>`: local, in scratch; `:151` Install step through `evict.mjs`'s `installIn()`; no GitHub.
- `plugin/scripts/label-map.mjs:350` — `gh label list --limit 1000 --json name` (`readLiveLabels`), called by `ensure` (`:591`, `:616`) and `set` (`:665`, `:720`): the tracker's label list; config.
- `plugin/scripts/label-map.mjs:615-642`, `:754-796` — `ensure` and `show`: write only the host-local cache, never a label (`:41-44`); config.
- `plugin/scripts/ledger.mjs:2150-2178` — finisher dispatch gate, closing references: reads `gh pr view <M> --json closingIssuesReferences,url` (`ledger.mjs:2086`, `:2155`) and `gh issue view <n> --json title` (`:2111`) for each issue PR M closes, to compare with its suggestion-band record title. Per-object from PR M's own references. It reads no `in-progress` label and no other ticket's state: the starting point "reads other tickets' `in-progress`" does not hold in this gate (no `in-progress` match anywhere in `ledger.mjs`'s `closingRefusals`/`releaseLabelRefusal`, `:2150-2210`; dispatch call site `:2395-2409`). Owned by S4Ledger; listed here as the finisher gate.
- `plugin/scripts/ledger.mjs:2192-2210` — finisher dispatch gate, release labels: `prLabels(pr)` per-object on PR M, `repoLabels()` (`gh label list`) config.
- `plugin/agents/fleet-finisher.agent.md:15-23` — `label-map.mjs show needs-triage|wontfix`: host-local cache; config.
- `plugin/agents/fleet-finisher.agent.md:26`, `:129`, `:138`, `:158` — instructions to run `finisher-audit.mjs`, `finisher-scope.mjs`, `ticketless.mjs`, `finisher-tree.mjs`: per-object on the dispatched PR/worktree/pin; the `gh` call inside `ticketless.mjs` is the per-object read above.
- `plugin/agents/fleet-finisher.agent.md:55` — `instruments.sh --repo …`: local baseline file; no GitHub.
- `plugin/agents/fleet-finisher.agent.md:73-85` — dispositions homes: the finisher relies on `dispositions-check.mjs`'s read-back (`homeHolds`), a per-object read of the PR's own fix-applier record (other slice); the by-hand fallback is S5b-7.
- `plugin/agents/fleet-finisher.agent.md:114` — `git diff origin/main...<pin>`: local objects; config.
- `plugin/agents/fleet-finisher.agent.md:291-305` — report file under the scratch root; host-local.
- `plugin/skills/run-team/briefs/finisher.md:12-33` — brief text: report-file path, `report-schema.mjs`, process-hygiene rules; no GitHub access. `:34-38` repair brief: "Duty 3's script decides whether the label is on", no new read or write.
- `plugin/skills/run-team/references/finisher.md:9-11` — "a turn-based member re-reading `gh pr checks` each idle cycle" is a rule against that read, not an instruction to run it.
- `plugin/skills/run-team/references/finisher.md:113-121` — ruling row: reads the main checkout's `docs/metrics/tier-outcomes.tsv`; host-local file.
- `plugin/skills/run-team/references/finisher.md:125-151` — CI gate prose (`ci-state.mjs` without `--quiet`, `--declare-no-ci`): per-PR CI read on the dispatched PR's head; script in S7ReviewCI's slice.
- `plugin/skills/run-team/references/finisher.md:153-164`, `:209-239`, `:247-301`, `:321-367`, `:395-404` — outbox rule, range rule, Inert diff verdict, verification-tree rules, halt causes: local git/ledger/worktree reasoning; no GitHub read or write.
- `plugin/skills/run-team/references/finisher.md:369-393` — stray/past-pin/human halts: `ledger.mjs review <M>`, `DISPATCH review PR#<M>` (tick's rows); the maintainer's `ready-to-merge` and the merge bot's read of `ready-to-merge-head:` describe S5b-2/S5b-3's consumer.

## Files with no GitHub access
- `plugin/scripts/finisher-scope.mjs` (local `git` only: rev-parse, merge-base, diff-tree)
- `plugin/scripts/finisher-tree.mjs` (local `git worktree add`, Install step; no `gh`, no remote)
