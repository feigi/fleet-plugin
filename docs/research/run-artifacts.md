# Which files does fleet-ctl create in a run, and which survive it?

Research ticket [#4164](https://github.com/feigi/fleet-plugin/issues/4164), under the Wayfinder map [#4118](https://github.com/feigi/fleet-plugin/issues/4118).
Measured 2026-11-01 against `origin/main` `e810699f` (all `file:line` cites are at that commit). This note reports facts; it does not rule or recommend.

**Method.** Writers and deleters come from grepping `plugin/scripts/`, `plugin/skills/run-team/`, `plugin/commands/` and `plugin/agents/` for `writeFileSync`, `appendFileSync`, `renameSync`, `mkdirSync`, `rmSync`, `unlinkSync`, `linkSync`, `mkdtemp*`, `fleetFile(`, `.fleet/`, `scratch`, `--out`, and shell `mktemp`/`rm`/`git worktree`. Sizes come from `lstat` over the live checkout's `.fleet/`, `~/.fleet/` and the harness session directory, read-only, by [`run-artifacts-derive.mjs`](run-artifacts-derive.mjs) (reproduce: `node docs/research/run-artifacts-derive.mjs --fleet <checkout>/.fleet --merged-json <gh pr list -s merged -L 3000 --json number,mergedAt> --tier <committed tier-outcomes.tsv> --working-tier <working copy>`). No transcript, brief, log or scratch file was opened; the only file contents read were the `.fleet/phase0*.json` receipts (the `session` path, and the `pin` step's text), the rotated ledgers (only the `impl-<N>=PR#<M>` tokens, and `## Ruled` line counts), the TSVs, and JSON key names of one `review.json`, one `dispositions-*.json` and the cost-guard/preview files. Anything not measured is marked `[INFERENCE]`. The repository is **public** (`gh repo view`), so the committed TSVs are public.

## 1. Where a run writes (six locations, not four)

| # | Location | In the repo? | Committed? | Size now (apparent / `du`) | Who removes it |
|---|---|---|---|---|---|
| L1 | `docs/metrics/` in the main checkout | yes, tracked | **yes** — the three TSVs, via the Close-out PR (`closeout.mjs:161`, `:391-394`) | `member-outcomes.tsv` 7.9 MB (33,396 lines), `ticket-features.tsv` 38.8 KB (269), `tier-outcomes.tsv` 519 KB (850) | nobody; rows are replaced in place or appended |
| L2 | `<checkout>/.fleet/` | gitignored (`.gitignore:10`, "never committed") | **no** | 2,138 files, 9.4 MiB apparent, 14.8 MiB allocated (`du` 15,108 KiB) | rotation only (§3); no pruning |
| L3 | `<checkout>/.worktrees/<N>-impl-<N>` etc. | gitignored (`.gitignore:12`) | the branch is pushed; the tree is not | 34 trees, 509,808 KiB (`du`); `git worktree list` 34 | `reap.sh`, `release-ticket.sh`, `evict.mjs` |
| L4 | `~/.fleet/scratch/<repo-key>/` (scratch root) | **outside** | no | 1.73 GiB apparent / 1.99 GiB allocated, 99,671 files (keyed root); `~/.fleet/scratch/` as a whole 1.80 GiB | `reclaim-scratch.mjs` |
| L5 | other `~/.fleet/*` (`alarm/`, `suite-slots/`, `bin/`, `rerule-3831/`, `rerule-3832/`, `agent-test/`, `wt/`) | outside | no | `rerule-3832` 6.41 GiB, `rerule-3831` 677.5 MiB, rest < 10 KiB; `~/.fleet` total 10,319,296 KiB (`du`) | nothing in `plugin/` |
| L6 | `~/.omp/agent/sessions/-dev-fleet-plugin/` (harness transcripts) | **outside, harness-owned** | no | 116 sessions, 110,773 files, 7.56 GiB apparent / 7.75 GiB allocated (`du` 8,125,048 KiB) | nothing in `plugin/` |

Also written and removed within one process (nothing durable): system-tmp `fleet-tick-tier-*` (`fleet-tick.mjs:2049`, removed `:2056`), `merge-gate-*` (`merge-gate.mjs:315`, removed `:329`), `recipe-prove-*` logs and proof worktree (`recipe-prove.mjs:592`, removed `:554`, `:569`), `mktemp` files in `instruments.sh:318` (trap `:321`), `worktree.sh:121` (rm `:130-143`), `derive-testcmd.sh:207,296`, `no-undo-audit.sh:896` (trap `:903`), `inflight.sh:248` (trap `:201`). Lock/temp siblings: `ledger.md.lock`, `ledger.md.<pid>.tmp` (`ledger.mjs:573`), `<file>.tmp` beside every atomic write, `pid-lock.mjs` locks (`:124`, unlinked `:135`, `:154`).

Harness stores outside the repo the plugin never touches (`grep stats.db plugin/` is empty): `~/.omp/stats.db` 547.5 MiB, `~/.omp/run/` 680,540 KiB, `~/.omp/logs/` 12,796 KiB. Measured size only.

## 2. One row per artifact

Legend. **Life**: `C` committed (how) · `K` local and kept · `R` local, rotated/archived (to) · `D` deleted (when) · `H` outside repo. **Rebuild**: can it be rebuilt from committed records + GitHub (PR state, issue text)? **Learning**: `Fit` input to Router's Fit or the cost guard · `Ruling` evidence behind Rulings (reviews, Charges) · `Incident` · `Report` run report · `Cockpit` state · `None`. **Sens**: can it hold sensitive content (see §6).

Sizes are per run unless stated. "Per PR" means the scratch layout keys on the PR, not the run.

### 2a. Committed

| # | Path pattern | Writer (file:line) | Deleter / rotation | Size per run | Life | Rebuild | Learning | Sens |
|---|---|---|---|---|---|---|---|---|
| A1 | `docs/metrics/member-outcomes.tsv` | scrape `member-outcomes.mjs:516-517` (run by `closeout.mjs finish` step `scrape`, `closeout.mjs:30-33`); widen `metrics-refresh.mjs:214-215` | none; replace-by-key (`mergeRows`, `member-outcomes.mjs` "Replace-by-key"); only `ending` and `work_s` survive a re-scrape that cannot read them | grows +121 KiB and +124 KiB across the last two Close-outs (7,682,810 → 7,803,846 → 7,928,173 B); 456–2,459 added lines per Close-out commit | C: Close-out PR, `git commit -- METRICS` (`closeout.mjs:394`), merged only on an Inert diff (`finisher-scope.mjs:31`) | **No** from committed records. Source is the harness transcripts (L6, not owned); the `report` column also reads the scratch `reports/` at scrape time (`member-outcomes.mjs:212` `withReports`, called `:511`) and a re-scrape overwrites it | Fit (cost, tokens, model per Cell), Report | no: names, models, token counts, cost |
| A2 | `docs/metrics/ticket-features.tsv` | drained from pending by `metrics-refresh.mjs:251-254`; `parent` back-filled by `slice-fill.mjs:100-101` | none | +3 … +37 rows per Close-out (18 rows in the 2026-10-31 one); ≈150 B/row | C: as A1 | **Partly.** Columns `brief_chars criteria comments age_days paths test_paths xrefs` are computed from the issue text *at dispatch* and `policy_cell chosen_cell exploration_draw router_usd` from the Router's state at that moment; the issue can change afterwards. `parent` is re-readable from the issue (`slice-fill.mjs:78`) | Fit | no |
| A3 | `docs/metrics/tier-outcomes.tsv` (the Rulings) | `tier-outcomes.mjs:893-895` (`append`), also by hand with flags | none; rows appended, "never inserted" | +3 … +37 rows per Close-out (one per merged implementer PR); ≈910 B/row | C: as A1 | **No** once the evidence is reclaimed. `append` derives the verdict from `<scratch>/pr<pr>/<run>/review.json` + `<scratch>/dispositions-fix-pr-<pr>[-x].json` + `<scratch>/reports/impl-<ticket>[-x].json` + ledger tokens (`tier-outcomes.mjs:60-114`), and "otherwise refused with the flags to give" (`:112-114`). The free-text `note` keeps the quoted claims | Fit (merged count, `minted_false_claim`), Ruling | `note` quotes reviewers' claims about code; public |
| A4 | `plugin/scripts/router-table.json` (the table that routes) | `ticket-router.mjs:857-858` (`fit`); re-fit duty in `.omp/skills/run-team-local/hook.mjs` | none | one file; committed value now `fitted_commit: null`, `stage: 1`, `n_rows: 0` (measured with `jq`): **nothing fitted is committed**; the learned Fit exists only as B8 | C: ordinary PR (not the Close-out PR) | A fitted table would be rebuildable from the TSV blobs at `fitted_commit` (`ticket-router.mjs:809-838` re-fits and compares); the current one has no fit to rebuild | Fit | no |
| A5 | `docs/metrics/pricing.json` | no writer under `plugin/scripts/` (only read: `pr-cost.mjs:9,274`) | none | 1.2 KB, static | C: ordinary PR | n/a | Fit (cost cross-check) | no |

### 2b. `.fleet/` in the main checkout (gitignored, local)

| # | Path pattern | Writer (file:line) | Deleter / rotation | Size per run | Life | Rebuild | Learning | Sens |
|---|---|---|---|---|---|---|---|---|
| B1 | `.fleet/ledger.md` (+ `.lock`, `.<pid>.tmp`) | `ledger.mjs:552-574` (`save`), every `row`/`token`/`settle`/`dispatch`/`review`/`ruled`/`filed` call; `fleet-event.mjs` and `fleet-tick.mjs` drive it | `ledger.mjs rotate` hard-links to the archive (`:1716`) then unlinks when nothing is carried (`:1727`) | live file 13 KiB | K until rotated, then B2 | **Partly.** PR numbers, heads, merge state are on GitHub; `reviewed=<head>:<survived/refuted/unverified>:<run>`, `dispositions-ok`, `tier=`/`tier-ok=`, `## Routed` (policy cell, draw, stratum), `## Filed`, `## Drain` are controller records found nowhere else | Ruling (counts), Fit (`## Routed`), Incident (`failed`/`bailed`/`halted`/`parked` tokens), Report | PR/ticket numbers, session paths, free text of filings: low |
| B2 | `.fleet/ledger.<UTC stamp>.md` (31) and `.fleet/ledger.<date>-<run\|prev>.md` (15, Aug–Sep, hand-named) | `ledger.mjs:1714-1716` | never deleted (no `unlink`/`rm` of archives anywhere in `plugin/`) | 2.8–18.3 KiB for the 15 runs joined to a receipt; all 31 stamped = 490 KiB; the 15 older = 1,115 KiB | R: archive beside the ledger | as B1 | as B1 | low |
| B3 | `.fleet/phase0.json`, `phase0.previous.json`, `phase0.<stamp>.json` | `phase0.mjs:579-583` after every step; held aside `:703`, restored/filed `:330-342`; `closeout.mjs:462-473` moves it to `phase0.previous.json` | rotation files it as `phase0.<stamp>.json` (`ledger.mjs:1706,1738-1745`); never deleted | 3.5 KiB (15 archived = 52 KiB) | R: beside the ledger archive | **No.** Records `session` (the controller's harness session dir), `scratch`, `objective`, `inFlight`, and each step's output text, which since 2026-10-30 includes the plugin version (§7.3) | Report, Incident (refusals, crashes) | session path embeds the OS user name; step output holds `gh` text |
| B4 | `.fleet/closeout.json`, `closeout.<stamp>.json` | `closeout.mjs:218-223` after each step | rotated by `ledger.mjs:1706,1738-1745`; never deleted | 16.5 KiB (12 archived = 198 KiB) | R: beside the ledger archive | Mostly yes: reason, branch, PR, pin and merge outcome are also in the Close-out PR and commit (`Closeout: <reason>`); the per-step `output` text is not | Report, Incident (which step failed) | step outputs hold `gh`/git text and paths |
| B5 | `.fleet/briefs/<member>.md` + `.json`, `.fleet/briefs.<stamp>/` | `dispatch-prompt.mjs:365-374` (`render --member`) | `briefs/` renamed to `briefs.<stamp>/` by `ledger.mjs:1706,1738-1745`; never deleted | 135–687 KiB (median 334 KiB over the 15 joined runs); 18 rotated dirs = 6,268 KiB apparent, 1,857 files | R | **No.** The implementer brief pastes "the ticket … verbatim" (`briefs/implementer.md:14-18`: title, `## Agent Brief` comment or body, Out of scope); sha256 sidecar fixes the bytes | Ruling (what each member was told), Fit (issue text at dispatch), Incident | issue text and comments (public repo here), absolute paths |
| B6 | `.fleet/heartbeat.json` | `fleet-state.mjs:340-342` (`writeState`), called by `fleet-heartbeat.mjs`, `fleet-event.mjs`, `ledger.mjs:1767` | none; overwritten. `AGENTS.md:25-39` defines "live run" off it | 0.7 KiB | K | not needed | Cockpit, Incident (`stopped` reason) | pids, process start time, `.fleet/` path |
| B7 | `.fleet/cost-guard.json` | `pr-cost.mjs:440-442` (`--guard`), run by `metrics-refresh.mjs:266` at phase 0 and Close-out | none; overwritten | 2.8 KiB | K | **Yes** while the three TSV blobs it pins (`tsv_blobs`) are committed. Measured now: all three blob ids equal `origin/main`'s | Fit (guard verdict `tripped`, per-cell trip points) | no |
| B8 | `.fleet/router-preview.json` (the Preview fit) | `metrics-refresh.mjs:330-331` | none; overwritten; "never routed, never committed" (`CONTEXT.md`, Preview fit) | 12 KiB | K | **Yes**, same condition as B7. Pins `prior.version` = `3.133.0` now | Fit, Cockpit | no |
| B9 | `.fleet/ticket-features.pending.tsv` | `ticket-router.mjs:771-782` (`route`, one row per Pull) | `metrics-refresh.mjs:224,254` unlinks after draining into A2 (working tree, not committed) | 3 KiB; 16 rows now | D: at the next drain (phase 0 / Close-out) | no, until drained; then A2 | Fit | no |
| B10 | `.fleet/shortlist.json` | `shortlist.mjs:342-344` | none; overwritten | < 1 KiB | K | yes (GitHub issue list) | Cockpit | no |
| B11 | `.fleet/recipe.json` | `recipe-prove.mjs:490-497`; restored on failure `:505-506` | none; overwritten | 2 KiB | K | needs a paid re-derive (`fleet-recipe-deriver`) | None durable | `recipe` commands may carry env assignments `[INFERENCE]` |
| B12 | `.fleet/preflight.json`, `.fleet/labels.json` | `preflight.mjs:144-149`; `label-map.mjs:180-183` | none; overwritten | < 1 KiB each | K | yes (re-run; labels from GitHub) | None | no |
| B13 | `.fleet/board.json`, `.fleet/board.html` | `board.mjs:427-428`; `board-server.mjs:535,572-573` | none; overwritten each tick | 80 KiB | K | yes, from ledger + GitHub + transcripts (spend) | Cockpit | PR/issue titles |
| B14 | `.fleet/instruments.sha` (+ `.pre-move-claude-config`, hand-renamed) | `instruments.sh:376-381` (`pin`); three lines: digest, `root=`, `version=` | none; overwritten on each pin | 142 B; `version=3.136.2` now | K | no (single slot) | Incident (what moved), version (§7.3) | install root path |
| B15 | `.fleet/main-checkout.sha` | `main-checkout.mjs:510-513` | none; overwritten | < 1 KiB | K | yes | Cockpit | no |
| B16 | `.fleet/merge-bot-*/`, `.fleet/pr<N>/`, `.fleet/scratch/` (7 + 4 + 1) | no current writer: scratch moved to `~/.fleet/scratch` with `scratch-root.mjs` (added `ee46de8f`, 2026-10-11); mtimes 2026-09-27 … 2026-10-16 | never (`reclaim-scratch.mjs` only sweeps `~/.fleet/scratch`) | 158 + 5 KiB | K | no | Ruling/Incident (merge-bot gate output of old runs) `[INFERENCE]` | as C3 |
| B17 | `.fleet/pr<N>-findings.{md,json}` (17, 2026-08-13…18) | no writer under `plugin/` (`grep 'findings\.(json\|md)'` empty) → hand-saved `[INFERENCE]` | never | 664 KiB total | K | no | Ruling (August review findings) | review text |
| B18 | `.fleet/caps.txt`, `.fleet/batch.json`, `.fleet/ledger.prev-run.md`, `.fleet/phase0.{precrash,2026-10-28T0010Z-crash,2026-10-29-crash2}.json` | no `plugin/` writer (`caps.txt` 2026-10-04 and `batch.json` 2026-10-14 are one-offs; crash receipts renamed by hand) | never | 13 KiB + 10 KiB | K | no | Incident (crashes) | paths |

### 2c. Scratch root `~/.fleet/scratch/<repo-key>/` (outside the repo)

Layout from `fleet-dir.mjs:157-167`; entry kinds from `reclaim-scratch.mjs:22-60`. Present now under `fleet-plugin-28971265/`.

| # | Path pattern | Writer (file:line) | Deleter / rotation | Size | Life | Rebuild | Learning | Sens |
|---|---|---|---|---|---|---|---|---|
| C1 | `pr<N>/run-XXXXXXXX/{review.json, pr.diff, pr-messages.md, test-run.log, install.log, status.txt, repo.err, snapshot-<sha>/, <dimension>/}` — the review run root | `review-core.mjs:1073-1087` (mktemp, clone, install, status), `:1155-1156` (diff, messages), `:1300` (test log); `review.json` by `review-eval.mjs:212` (`wx`) | `reclaim-scratch.mjs --pr` (`review-core.mjs:1075`) prunes `run-*` idle > 7 days; the root sweep removes `pr<N>/` when PR #N is MERGED or CLOSED and no live ledger token names it (`reclaim-scratch.mjs:24-30`), called after each merge pass (`fleet-tick.mjs:2008-2021`, since `e335b127` 2026-10-15) and at phase 0 (`phase0.mjs:354-356`) | per run root: 111 / 133 / 70 / 67 MiB (4 present); of which `review.json` 6.8 KiB (4 files = 32,927 B, avg 8.0 KiB) | D: at merge/close with no live token; else 7 days idle | `review.json` **no** (findings with counts, `survived`, `refuted`, `unverified`, `dimensionsRun/Unrun`, `head`, `snapshot`); `pr.diff` and `pr-messages.md` yes (GitHub) | Ruling (the first review's findings) | clones of the repo + installed dependencies; test/install logs can print environment values |
| C2 | `pr<N>/fix-XXXXXXXX/` (fix-applier working clone) and `pr<N>/finish-*`, `pr<N>/fixwork` | fix-applier / finisher members (`references/isolation.md:129`; briefs) | with `pr<N>/` | 174 MiB, 1.34 GiB, 2.9 MiB, 80 KiB (4 present) | D | working state, yes (branch is pushed) | None durable | full clone with dependencies |
| C3 | `pr<N>/merge-bot-<n>/{body.md, ci.json …}` and `merge-bot-<n>/` | merge bot (`commands/run-merge-bot.md:217`, `merge-gate.mjs --out …/ci.json` at `:235-237`); the gate writes it at `merge-gate.mjs:451-452` | with `pr<N>/`; a live `merge-bot-<n>` token holds every `pr<M>/` (`reclaim-scratch.mjs:26-29`) | 92 KiB (2 bots) | D | gate verdict not on GitHub (`main-gain-removed:<path>` is parked on the ledger row, B1) | Incident (why a merge was refused) | PR body, CI payload |
| C4 | `dispositions-fix-pr-<M>[-x].json` — the Charges | the fix-applier (`briefs/fix-applier.md:79`) | same verdict as `pr<M>/` (`reclaim-scratch.mjs:24`) | 1–1.3 KiB each (4 present) | D | **No** | Ruling (the Charges) | quoted finding text |
| C5 | `reports/<member>.json`, `<member>.check.json` | members (briefs); Check-step record `recipe-check.mjs:285`; schema `report-schema.mjs` | `ledger.mjs:2522` (`clearReport`, on re-dispatch); reclaimed with the entry it goes with (`reclaim-scratch.mjs:42-55`) | 55 files, 4,014 KiB (current) | D | **No.** Includes `sizing.verdict`/`ranBeforePr` that `tier-outcomes.mjs:60-69` reads | Report, Ruling (sizing), Fit | none known |
| C6 | `impl-<N>/{issue.json, pull.json, pull.previous.json, …}` | `pull.mjs:810` (issue), `:503` (state), `:1312` (previous) | removed when issue #N is CLOSED, or OPEN and idle > 7 days with no live token and no claim worktree (`reclaim-scratch.mjs:31-41`) | 5 present, 3,178 KiB total | D: when the ticket closes (i.e. at merge) | `issue.json` **no** (title, body, comments, labels, `createdAt` as read at dispatch; GitHub holds the current text; edit history `[INFERENCE]`, not measured) | Fit (the text A2's features come from) | issue text |
| C7 | `logs/`, `*.log`/`*.txt`/`*.out`/`*.err`, `issue<N>.*`, `batch-*.json`, `pr<N>-*` at the root | members by hand (baseline/mutant runs, acceptance mutation) | "anything else": idle > 7 days and no live token (`reclaim-scratch.mjs:56-60`) | 39 loose files 4,918 KiB, `logs/` 1,577 KiB, `pr/` 75 MiB (7,463 files) | D: 7 days idle | no | None durable | test output |
| C8 | Loose entries **directly under `~/.fleet/scratch/`** (no repo key): 39 `impl-*`, 38 `dispositions-fix-pr-*.json`, 37 `review-<N>.json`, 20 `batch-*.json`, 13 `fix*`, 5 hand-folded briefs, `maingain-3050/`, … | members before the keyed root existed / by hand | **never**: the siblings pass skips anything not key-shaped (`reclaim-scratch.mjs:494`, `SCRATCH_KEY_SHAPE`) | 76 MiB `impl-*` (2,376 files) + 0.7 MiB `review-*.json` + 0.2 MiB `dispositions-*` … ≈ 80 MiB | K | no | Ruling (37 review copies, `review-2965.json` … `review-3060.json`, and 38 Charge records) | as C1 |

### 2d. Other `~/.fleet/`, worktrees, harness

| # | Path pattern | Writer (file:line) | Deleter / rotation | Size | Life | Rebuild | Learning | Sens |
|---|---|---|---|---|---|---|---|---|
| D1 | `~/.fleet/alarm/<pid>.json` | `controller-alarm.mjs:136-138` (omp extension, `session_start`) | none; "a leftover file from a dead session is harmless" (`:55-56`) | 44 files, 5.6 KiB | K | n/a | Cockpit (alarm armed proof) | pid, `.fleet/` path |
| D2 | `~/.fleet/suite-slots/` | `suite-slot.mjs:124` + `pid-lock.mjs:124` | `pid-lock.mjs:135,154` unlink on release | 4 files | D: on release | n/a | None | no |
| D3 | `~/.fleet/bin/fleet-run` and the plugin copies | `fleet-bootstrap:103-114` | none | 5.7 KiB | K | yes (install) | None | no |
| D4 | `~/.fleet/rerule-3831/`, `rerule-3832/` (PR dirs for the 21 + 180 PRs in `listing.md`, plus `driver.mjs`, `sessions.json`, 198 `dispositions-*.json`, 0 `review.json`) | **no writer under `plugin/`**; made for tickets #3831/#3832 ("Re-rule … from their review evidence") by a driver that reads the harness sessions (`driver.mjs:24,122`) | none | 677.5 MiB + 6.41 GiB; `listing.md` cost figures sum to $14.54 (21 PRs) and $146.46 (180 PRs) | K | it *is* a rebuild of C1/C4 from L6 | Ruling | as C1 |
| D5 | `~/.fleet/agent-test/`, `mark-3000`, `wt/` | none found | none | 0.2 KiB / 0 / 0 | K | n/a | None | no |
| E1 | `<checkout>/.worktrees/<N>-impl-<N>`, `review-*`, … (34) with `agent-test` runner | `claim-ticket.sh:95,318` (`git worktree add`), runner `:416`; evict marks `evict.mjs:336,455,460` | `reap.sh:1599` and `release-ticket.sh:1365` (`git worktree remove`); `evict.mjs` deletes ignored dependency paths only | 498 MiB for 34 | D: at reap | yes — the work is on the pushed branch | None durable | untracked files in a tree `[INFERENCE]` |
| H1 | `~/.omp/agent/sessions/-dev-fleet-plugin/<stamp>_<uuid>.jsonl` (controller) and `<stamp>_<uuid>/{<Member>.jsonl, N.bash.log, *.md, *.json, .lock.os, *.tombstone}` (members, nested) | the harness (omp); not the plugin | **none**: no `rmSync`/`unlink` in `plugin/` names it; the oldest session is still there (2026-09-08) | per controller session 37.0–391.7 MiB (median 130.0); see §5 | H | not rebuildable; it is the source of A1 and of the re-rule (D4) | Ruling (reviewers' and fix-appliers' final output), Fit (cost), Incident (tombstones), Report | **yes** (§6) |

## 3. What deletes or rotates what

| Mechanism | What it touches | Trigger | file:line |
|---|---|---|---|
| `ledger.mjs rotate` | links `ledger.md` → `ledger.<stamp>.md`; renames `phase0.json`, `closeout.json`, `briefs/` to `<name>.<stamp>…`; unlinks `ledger.md` if nothing carried; records the new run's `controller` in `heartbeat.json`. Refuses if an archive name exists. Nothing is pruned. | phase 0 step `rotate` of the next run | `ledger.mjs:1642-1777`, `phase0.mjs:330-345`, `ledger-grammar.mjs:30-44` |
| `closeout.mjs finish` step `phase0-receipt` | `phase0.json` → `phase0.previous.json` | end of run | `closeout.mjs:462-476` |
| `metrics-refresh.mjs` drain | pending → A2 (working tree), then unlinks pending; widens A1 | phase 0 and Close-out | `metrics-refresh.mjs:214-254` |
| `reclaim-scratch.mjs` | everything under the keyed scratch root by GitHub state + 7-day idleness (§2c) | (1) phase 0 after rotation, `--after-rotate` (`phase0.mjs:354`); (2) every `tick --apply` after a merge pass (`fleet-tick.mjs:2008-2021`, with `reap.sh` and `evict.mjs`); (3) `--pr` prune per review (`review-core.mjs:1075`); (4) `--siblings` (`phase0.mjs:356`) removes other *key-shaped* roots idle 7 days | `reclaim-scratch.mjs:132-141` (REMOVE), `:486-494` |
| `reap.sh`, `release-ticket.sh` | merged/abandoned claim worktrees and branches | tick `--apply`; Close-out `release` | `reap.sh:1599`, `release-ticket.sh:1365` |
| `ledger.mjs dispatch` | clears the last report of the member being re-dispatched | dispatch | `ledger.mjs:2511-2525` |
| `git worktree remove` in `recipe-prove.mjs` | proof worktree | end of proof | `recipe-prove.mjs:554` |
| *Nothing* | `ledger.<stamp>.md`, `phase0.<stamp>.json`, `closeout.<stamp>.json`, `briefs.<stamp>/`, `~/.fleet/alarm/*`, harness sessions, unkeyed `~/.fleet/scratch/*` entries | — | no `rm`/`unlink` site in `plugin/` reaches them |

## 4. Rebuildable from committed records plus GitHub?

| Rebuildable | Not rebuildable (what is lost) |
|---|---|
| B7 cost guard and B8 Preview fit (from the TSVs whose blob ids they pin — all three equal `origin/main` now); B10, B12, B13, B15 (GitHub + ledger); E1 worktrees (pushed branches); C1 `pr.diff`/`pr-messages.md` (GitHub); the Close-out facts in B4 (PR, commit) | **A1** rows, if the transcripts go (L6 not owned) — and `report` depends on scratch present at scrape time; **A3** the verdict, once C1 `review.json` + C4 Charges + C5 reports are reclaimed; **A2** the decision-time columns and the issue text they came from; **B1/B2** `reviewed=` counts, `## Routed`, parked/halted tokens; **B3/B4** step outputs, session link, version text; **B5** the brief each member was given (and with it the issue text at dispatch); **C3** merge-gate verdicts; **C6** `issue.json`; **B14** versions of earlier pins; **B6** history of beats. **A4** has no fit to rebuild: `fitted_commit` is null |

Only the first column's items are recoverable by a script alone. The rest are either local-only (`.fleet/`, gitignored) or in scratch (deleted by design) or in harness transcripts (paid re-extraction: the re-rule driver's own `listing.md` sums to $14.54 for 21 PRs = $0.69/PR and $146.46 for 180 PRs = $0.81/PR).

**What is committed:** the three TSVs (A1–A3) at Close-out, the router table (A4) and pricing (A5) by ordinary PRs, the Close-out PR/commit message, and the code branches. Nothing else a run writes is committed.

**Uncommitted right now (live run, measured read-only):** 13 data rows in the main checkout's `docs/metrics/tier-outcomes.tsv` that `origin/main` lacks (`git hash-object` working `0f26a9203c` vs blob `511a54145a`; line-diff 13 added, 0 removed), and 16 rows in `.fleet/ticket-features.pending.tsv`. `member-outcomes.tsv` and `ticket-features.tsv` in the working tree equal `origin/main`. These reach main only at the next `closeout.mjs finish` commit-and-pr step (`closeout.mjs:391-394`, three paths only).

## 5. Sizes

`.fleet/` per kind (apparent / allocated, from `run-artifacts-derive.mjs`):

| Kind | Entries | Files | Apparent | Allocated |
|---|---:|---:|---:|---:|
| `ledger.md` live | 1 | 1 | 13 KiB | 16 KiB |
| `ledger.<stamp>.md` | 31 | 31 | 490 KiB | 564 KiB |
| `ledger.<date>-<run\|prev>.md` (Aug–Sep) | 15 | 15 | 1,115 KiB | 1,148 KiB |
| `phase0.json` / `phase0.<stamp>.json` / crash-named | 1 / 15 / 3 | 19 | 5 / 52 / 10 KiB | 8 / 68 / 12 KiB |
| `closeout.<stamp>.json` | 12 | 12 | 198 KiB | 228 KiB |
| `briefs/` (live) + `briefs.<stamp>/` (18) | 19 | 1,973 | 536 + 6,268 KiB | 816 + 11,064 KiB |
| `heartbeat`, `cost-guard`, `router-preview`, `ticket-features.pending` | 4 | 4 | 19 KiB | 28 KiB |
| `shortlist`, `recipe`, `preflight`, `labels`, `instruments.sha*`, `main-checkout.sha` | 7 | 7 | 3 KiB | 28 KiB |
| `board.json` + `board.html` | 2 | 2 | 80 KiB | 84 KiB |
| legacy `merge-bot-*`, `pr<N>`, `scratch` | 12 | 54 | 163 KiB | 320 KiB |
| hand-saved `pr<N>-findings.*`, `caps.txt`, `batch.json` | 19 | 19 | 664 KiB | 708 KiB |
| **Total** | | **2,138** | **9.4 MiB** | **14.8 MiB** |

Per run, `.fleet/` adds ledger + receipts + briefs ≈ 0.2–0.7 MiB (briefs dominate: 135–687 KiB each); about 0.36 MiB on average (briefs 6,268 KiB over 18 rotated runs = 348 KiB each; ledger + `phase0` + `closeout` ≈ 394 KiB over the 15 runs joined to a receipt ≈ 26 KiB each).

Scratch, `~/.fleet/scratch/fleet-plugin-28971265/` (1.73 GiB, 99,671 files): `pr<N>/` 4 dirs 1,721,396 KiB (92,057 files; `pr4149` alone 1,540,300 KiB, of which one fix clone is 1,404,408 KiB); `pr/` 75,454 KiB; `impl-<N>/` 5 dirs 3,178 KiB; `reports/` 4,014 KiB; `logs/` 1,577 KiB; loose files 4,918 KiB; `merge-bot-*` 68 KiB. The learning-bearing files in it — `review.json` (avg 8.0 KiB), `dispositions-*.json` (1–1.3 KiB), `reports/` — are under 0.5% of the bytes. Per PR the evidence directory is 67–133 MiB (review run root) plus up to 1.34 GiB (fix clone).

Harness sessions, per controller session (one row per phase-0 receipt; sessions are shared: 14 distinct controller sessions serve 19 receipts, so rows 10-23/precrash, 10-26/10-27, 10-28/10-29/10-29T205223Z and 10-30T154733/10-31 repeat a session):

| Receipt | Root `.jsonl` | Session dir | Dir files | Sub-agent `.jsonl` | Total | Receipts sharing it | Close-out receipt |
|---|---:|---:|---:|---:|---:|---:|---|
| 10-18T000116Z | 3.5 MiB | 97.3 MiB | 1,862 | 442 | 100.8 MiB | 1 | yes |
| 10-18T181936Z | 4.8 | 137.1 | 2,772 | 653 | 141.9 | 1 | **NO** |
| 10-19T090748Z | 6.9 | 63.8 | 1,426 | 344 | 70.6 | 1 | **NO** |
| 10-19T150534Z | 1.2 | 35.8 | 783 | 186 | 37.0 | 1 | yes |
| 10-20T111752Z | 6.4 | 122.4 | 2,311 | 526 | 128.9 | 1 | yes |
| 10-21T100029Z | 11.8 | 118.2 | 2,183 | 491 | 130.0 | 1 | yes |
| 10-22T080420Z | 2.0 | 88.9 | 1,586 | 368 | 90.9 | 1 | **NO** |
| 10-23T223449Z | 41.3 | 96.7 | 1,404 | 323 | 138.0 | 2 | yes |
| 10-25T094558Z | 3.5 | 147.5 | 2,876 | 671 | 150.9 | 1 | yes |
| 10-26T130445Z | 3.1 | 56.3 | 1,029 | 237 | 59.4 | 2 | yes |
| 10-27T223202Z | 3.1 | 56.3 | 1,029 | 237 | 59.4 | 2 | yes |
| 10-28T0010Z-crash / 10-29-crash2 / 10-29T205223Z | 63.3 | 328.4 | 8,656 | 1,968 | **391.7** | 3 | (hand-named) / (hand-named) / yes |
| 10-30T083515Z | 1.5 | 65.5 | 1,274 | 298 | 67.0 | 1 | yes, but 7 steps not `ok` |
| 10-30T154733Z / 10-31T202750Z | 4.4 | 129.6 | 2,347 | 522 | 133.9 | 2 | yes / yes |
| live `phase0.json` | 3.1 | 77.1 | 1,364 | 319 | 80.2 | 1 | — |

Min 37.0 MiB, median 130.0 MiB, max 391.7 MiB per receipt row; 14 distinct controller sessions = 1.68 GiB. The other 102 sessions (5.88 GiB) are named by no receipt (interactive or earlier). Inside session dirs, by kind: sub-agent `.jsonl` 25,066 files 5.68 GiB; `*.bash.log` 18,341 files 868.1 MiB; `*.log` 3,980 files 229.8 MiB; agent `*.md` 25,176 files 58.0 MiB; `*.json` 12,861 files 32.0 MiB; `*.tsv` 4 files 8.6 MiB; `.lock.os` 23,537; `.tombstone` 125. The scrape step walks every one of the 116 session directories at each Close-out (`closeout.mjs:30-33`).

Re-rule scratch (D4): `rerule-3831` 32,766 files 677.5 MiB; `rerule-3832` 335,191 files 6.41 GiB.

## 6. Sensitivity

Names only; no content was read or copied.

| Where | Kinds of sensitive content it can hold |
|---|---|
| L6 harness transcripts: controller `.jsonl`, member `.jsonl`, `*.bash.log`, agent `*.md`, `*.json` | everything a tool call saw or a model was shown: environment variable values printed by commands, tokens or credentials in command lines and outputs (e.g. `gh`/git remotes and config), contents of any file read (including local config and `.env`-style files), issue/PR/comment text, absolute home paths and the OS user name, hostnames. Shape-only scan (`gh*_`, `github_pat_`, `sk-`, `sk-ant-`, `AKIA`, PEM headers, `xox*-`; **matches are patterns, not verified secrets**): 72 of 110,772 session files match — 54 sub-agent `.jsonl`, 9 `*.bash.log`, 4 `*.log`, 3 root `.jsonl`, 1 `.json`, 1 `.md` |
| C1/C2 clones, `install.log`, `test-run.log`, C7 logs | a full repository snapshot with installed dependencies, and test/install output that can print environment values. Shape-only matches: 52 files in the keyed scratch root, 58 loose under `~/.fleet/scratch/`, 52 in `rerule-3831`, 568 in `rerule-3832` (the matched file names in `rerule-3831` are repo files `smoke-omp.sh` and `shell.md`; I did not open them, so whether they are fixtures is `[INFERENCE]`) |
| B5 briefs | issue text and comments verbatim; absolute paths |
| B3/B4 receipts, B6, D1, B14 | absolute paths with the OS user name, session paths, pids, process start times, `gh` command output |
| B11 `recipe.json` | derived Install/Check/Test commands; may carry env assignments `[INFERENCE]` |
| A1–A3 (committed, public) | member/model names, token counts, cost; `tier-outcomes.tsv` `note` quotes review claims about code |
| Measured none | `.fleet/` (0 of 2,138 files match the credential shapes), `~/.fleet/alarm/` (0 of 44) |

## 7. The known losses, mapped to the artifact responsible

### 7.1 Runs that never closed out

* Close-out exists since `0e43627a` (2026-10-15). A run has a close-out receipt `.fleet/closeout.<stamp>.json` (B4) only if `closeout.mjs begin` ran. Ledger archives with **no** close-out receipt: all 12 before 10-15 (`10-02T102404Z` … `10-14T154033Z`, which also have no phase-0 receipt), then `10-17T063733Z` (neither receipt), `10-18T181936Z`, `10-19T090748Z`, `10-22T080420Z`, `10-22T090058Z`, `10-28T000120Z`, `10-29T093307Z`. A receipt exists but is unfinished for `10-30T083515Z` (2 of 9 steps `ok`; `tick` failed; `scrape`, `tier-outcomes`, `metrics`, `commit-and-pr`, `phase0-receipt`, `heartbeat-stop` pending). The three post-10-15 runs before the issue's 2026-10-21 count with no close-out receipt are `10-17T063733Z`, `10-18T181936Z`, `10-19T090748Z` `[INFERENCE]` — 47 + 23 + 12 ledger rows, 34 + 22 + 7 = 63 implementer PRs; the ticket says 67 merged tickets and does not give its counting method, so I could not reproduce 67.
* What rides on the receipt: the `commit-and-pr` step is the only thing that commits A1–A3 (`closeout.mjs:391-394`); the `scrape` step reads all 116 sessions every time (`:30-33`), so an unclosed run's member rows are re-scraped by a later Close-out as long as the transcripts remain (all are still present, oldest 2026-09-08). The tier rows for those three runs now exist (0 of their implementer PRs lack a row).
* **Larger measured gap.** 693 distinct merged implementer PRs appear as `impl-<N>=PR#<M>` in rotated ledgers; **435 have no row in `docs/metrics/tier-outcomes.tsv` on `origin/main`**. All 435 merged 2026-09-26 … 2026-10-14 (229 of them on or after the cost guard's `window_start` 2026-10-03). They come from 8 of the 12 archives `10-02T102404Z` … `10-14T154033Z` — none has a phase-0 or close-out receipt (receipts begin with `10-18T000116Z`). `tier-outcomes.tsv` has no row at all for PR numbers 1600–2999 (200-wide buckets of the `pr` column: 1400 → 71 rows, 1600…2999 → 0, 3000 → 25). PRs #1867, #2358, #2535, #2901 are absent from the file at all 7 commits sampled, `29ed7540` … `origin/main`. Per-archive table: `run-artifacts-derive.mjs` output, "Ruling coverage".

### 7.2 Reclaimed review evidence

* Artifacts: C1 `review.json`, C4 `dispositions-fix-pr-<M>.json`, C5 `reports/impl-<N>.json` — the three files `tier-outcomes.mjs append` derives a Ruling from (`tier-outcomes.mjs:60-114`).
* Deleter: `reclaim-scratch.mjs` root sweep, run after **every merge pass** since `e335b127` (2026-10-15) at `fleet-tick.mjs:2008-2021`, plus phase 0 `:354`. `pr<M>/` goes when PR #M is MERGED or CLOSED and no live ledger token names it (`reclaim-scratch.mjs:24-30`); `impl-<N>/` and its reports when the issue closes (`:31-41`) — at merge for a PR that closes its ticket.
* The window: `append` is meant to run "before the finisher runs" (`CONTEXT.md`, Ruling), but `closeout.mjs finish` still raises `NEED tier-outcomes append <n>` for each PR whose ledger row carries `reviewed=` and has no row (`closeout.mjs:34-39`), so an append can fall after the merge-pass reclaim `[INFERENCE: I did not trace a PR through both]`. For a merged PR given no verdict flags, `append` derives the verdict "when its evidence is still in scratch, and otherwise refused with the flags to give" (`tier-outcomes.mjs:112-114`): the verdict is then typed by hand.
* Size of what is lost vs. what is deleted with it: evidence ≈ 8 KiB `review.json` + ≈ 1 KiB Charges per PR; the deleted directories are 67–133 MiB plus up to 1.34 GiB.
* Numbers in `tier-outcomes.tsv` now (`origin/main`, columns `run_date`, `minted_false_claim`): before 2026-10-15: 306 rows, 162 `yes`; on/after: 255 rows, 67 `yes`; 2026-10-15…21: 136 rows, 47 `yes`. The ticket's "154 in 306" differs by 8 (rows re-ruled since, `c3f0c6d1` `[INFERENCE]`), and I could **not** reproduce "1 in 60" by a date filter; no `note` in the file says the evidence was gone.
* What was rebuilt, and how: tickets #3831/#3832 re-ruled 21 and 180 rows by re-reading harness sessions (D4); the driver's own `listing.md` figures sum to $14.54 and $146.46.

### 7.3 The plugin version a session ran

The issue says it is "not recorded anywhere". Measured: three places record the **installed package version**, all local, none per session, none committed:

* the `pin` step output of the phase-0 receipt: `instruments pinned: <kind> <root> (version <v>)` (`phase0.mjs:253`). Of the 17 archived `phase0.2026-*.json` receipts, 3 carry a version — `10-30T083515Z` → 3.123.1, `10-30T154733Z` → 3.127.1, `10-31T202750Z` → 3.127.8 — and the other 14 say only `instruments pinned`; the live `phase0.json` → 3.133.0 (`phase0.precrash.json` not checked);
* `.fleet/instruments.sha` third line `version=` (`instruments.sh:376-381`): single slot, overwritten each pin — now 3.136.2, while the live receipt says 3.133.0;
* `.fleet/router-preview.json` `prior.version` (now 3.133.0), overwritten each `metrics-refresh`.

No TSV column holds a version (`member-outcomes.mjs:199-205`, `ticket-features.tsv` header, `tier-outcomes.mjs:144-147`; `grep -ci version` on `member-outcomes.tsv` = 0), and the transcripts carry the agent definition name, not the package version `[INFERENCE: not opened]`.

### 7.4 Issue text at dispatch

* `<scratch>/impl-<N>/issue.json` (C6; `gh issue view --json title,body,comments,labels,createdAt`, `pull.mjs:55-60,796-810`): removed when the issue closes.
* Copy 1: `.fleet/briefs/impl-<N>.md` → `.fleet/briefs.<stamp>/` (B5), verbatim "the ticket" block (`briefs/implementer.md:14-18`), with a sha256 sidecar; local, never pruned, present for implementers from the `briefs.2026-10-18T000116Z` run (22 implementer briefs there; 18 rotated dirs, 0–31 each).
* Copy 2: the member's own transcript (L6).
* Committed: only the numeric/label derivations in A2 (20 columns: `run_date session agent ticket policy_cell chosen_cell exploration_draw sizing_src sizing_pre router_usd brief_chars criteria comments age_days paths test_paths xrefs kind objective parent`).
* GitHub holds the current text; whether it can return the dispatch-time text depends on the platform's edit history, which I did not measure.

## 8. Contradictions with the ticket's "Known" and with the task brief

1. **"Only the three TSVs are committed."** Also tracked: `plugin/scripts/router-table.json` (written by `ticket-router.mjs fit`, `:857-858`; the committed value is unfitted: `fitted_commit: null`, `n_rows: 0`) and `docs/metrics/pricing.json` (no run writer). The Close-out PR commits exactly the three (`closeout.mjs:161,394`).
2. **Locations.** The ticket and brief list `.fleet/merge-bot-*/` and `pr*/` as live scratch. Those are a **legacy layout** (mtimes 2026-09-27 … 10-16; `scratch-root.mjs` landed 2026-10-11). Live scratch is `~/.fleet/scratch/<repo-key>/`, outside the repo, 1.73 GiB; `~/.fleet/` as a whole is 9.8 GiB, 7.1 GiB of it the two `rerule-*` trees that no plugin script writes.
3. **Version.** Recorded in three local places (§7.3), contrary to "not recorded anywhere"; not recorded per session and not committed.
4. **"Three runs … 67 merged tickets."** Not reproduced. Measured: 435 merged implementer PRs without a committed Ruling (§7.1), from 8 earlier archives that have no receipts at all; the three candidate runs after close-out shipped hold 63 implementer PRs and all have rows now.
5. **"154 in 306" and "1 in 60".** Measured 162 in 306 and not reproducible (§7.2).
6. **"`reclaim-scratch` deletes … after each merge-bot pass."** Confirmed, and it also runs at phase 0, per review (`--pr`), and deletes by GitHub state, not by whether a Ruling was written.
7. The ticket says `.fleet/` holds `briefs*/` as "scratch". They are run evidence (the member's dispatch text), rotated, never reclaimed.

## 9. Summary

* **Committed:** A1 member-outcomes, A2 ticket-features, A3 tier-outcomes (Close-out PR, Inert diff), plus the router table and pricing by ordinary PRs. Nothing else a run writes.
* **Lost or at risk, not rebuildable from committed records + GitHub:** the review evidence behind Rulings (C1 `review.json`, C4 Charges, C5 reports) once reclaimed — rebuilt only by paid re-reading of harness transcripts (≈ $0.7–0.8 per PR); 435 merged PRs of 2026-09-26…10-14 with no Ruling row; A1 member rows (source is the unowned L6, which nothing prunes today); A2's decision-time columns and the issue text behind them (local copies only in B5/C6/L6); the ledger archives, receipts, briefs and `heartbeat.json` (B1–B6, all gitignored, never pruned, one clean clone loses them); the plugin version per session; 13 Ruling rows and 16 pending feature rows uncommitted in the live checkout.
* **Sizes per run:** `.fleet/` ≈ 0.2–0.7 MiB (briefs dominate); committed TSVs ≈ +120 KiB per Close-out; scratch per PR 67–133 MiB review root plus up to 1.34 GiB fix clone, with the learning in ≈ 9 KiB; harness session per controller session 37–392 MiB (median 130 MiB), 1.68 GiB for the 14 controller sessions, 7.56 GiB for all 116.
