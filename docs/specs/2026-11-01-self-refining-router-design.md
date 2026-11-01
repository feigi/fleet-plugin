# A self-refining Router: tickets group onto Cells, learned per repository

Date: 2026-11-01
Status: decided on map #4118 ("A self-refining grouping of tickets onto Cells, learned from each repository's own evidence"), 2026-11-01; accepted as ADR 0037; sliced in § 6 for the controller to file as `needs-triage` issues once the maintainer has reviewed this spec.
Map: [A self-refining grouping of tickets onto Cells, learned from each repository's own evidence](https://github.com/feigi/fleet-plugin/issues/4118) (feigi/fleet-plugin#4118). Decision tickets: § 1.
ADR: `docs/adr/0037-each-repository-routes-by-its-own-fit-tickets-group-by-evidence.md`.
Amends: `docs/adr/0016-per-ticket-model-effort-routing.md` (decisions 1, 2 and 4, and its Guard section's retire condition and cumulative baseline); `docs/adr/0013-automatic-supply-relabel-by-cause.md` § 6's draw; `docs/specs/2026-09-28-model-effort-router-design.md` (R2–R5, § 5); `docs/specs/2026-10-27-cockpit-tabs-design.md` (§ 4–§ 5, the two-sided policy rows). Each is amended by its own slice (§ 6, slice S11), which writes the notes under the changed text.
Relates to: ADR 0034 and `CONTEXT.md` (**Inert diff**, **Ticketless PR**); [Router numbers you can trust, plus a cost-or-speed choice](https://github.com/feigi/fleet-plugin/issues/3673) (figures per Cell generation, the quality floor, the adoption rule, the run's Objective: all hold here).
Research: the eleven notes under `docs/research/` — `consumer-burn-in`, `cell-grid`, `fit-cadence`, `stratum-split`, `router-noise`, `router-inputs`, `self-refining-routing`, `fail-rate-drift`, `split-gate`, `split-looks`, `run-artifacts` — collected in draft PR [docs(research): the research behind the Router grouping map](https://github.com/feigi/fleet-plugin/pull/4172). Until that PR merges they are on branch `docs/research-map-4118`; § 4 cites each figure by its path.
Base tree: `origin/main` `b848c23a` (2026-11-01). Line numbers below are read against that tree and drift; re-grep before editing. Tickets quoted for their own line numbers read `e5040b9a`, which this tree has moved past by 22 commits; every number cited here was re-read at `b848c23a`.

Cells are model roles paired with a thinking level. No model name is written into a Cell token, a definition or this spec: the model behind a role is data, kept per Cell generation.

## 1. Destination and decisions

In every repository that installs fleet-ctl, the Router learns from that repository's own Pulls how to group its tickets, serves each group with one Cell, and keeps refining the grouping and each group's Cell as the evidence grows, for the run's Objective (`cost` or `speed`), with no human step. The inputs it reads come from the ticket at dispatch and from the evidence the repository's own runs left; the groups are a tree of readable splits; the Fit that holds them is computed at every phase 0, lives in `.fleet/` and is never committed; and every record the learning rests on is committed, so no run's learnings are lost. This repository is one more consumer.

Every decision below was made with the maintainer on 2026-11-01 unless noted. The last `## Resolution` comment on each ticket is authoritative; this spec merges them and adds only what § 2.12 lists.

| Decision | What it settles |
|---|---|
| [Which role × effort Cells can exist, and what makes one routable](https://github.com/feigi/fleet-plugin/issues/4120) (#4120) | 15 runnable Cells here, 5 defined; the grid follows the operator's `modelRoles`; a new level needs a definition file and the Cell lists. |
| [How long burn-in takes at a consumer's pace, and what it costs](https://github.com/feigi/fleet-plugin/issues/4119) (#4119) | Burn-in draws start at run 2; its length and cost at 10, 30 and 100 Pulls a week. |
| [What a new consumer starts from](https://github.com/feigi/fleet-plugin/issues/4124) (#4124) | A clean start: nothing from this repository routes, excludes or seeds anything at a consumer; run 1 is all `slow-high`. Ruled by an agent while the maintainer was away, from the maintainer's stated expectation; **reopens on a word**. |
| [What a Fit at every close-out does to routing, against one every 50 merged PRs](https://github.com/feigi/fleet-plugin/issues/4121) (#4121) | The cadence measurement behind the phase-0 Fit. |
| [Does this repository route the way a consumer does?](https://github.com/feigi/fleet-plugin/issues/4122) (#4122) | Yes, one mechanism; the shipped table is only the starting table; the re-fit PR, CI's check of the table and the re-fit PR's human stop retire. |
| [How a self-refining grouping of tickets onto Cells is learned elsewhere](https://github.com/feigi/fleet-plugin/issues/4151) (#4151) | Policy trees, model-based recursive partitioning and causal trees read as rules; off-policy evaluation scores a grouping on logged draws; no source has a per-Cell floor. |
| [Which ticket inputs change which Cell wins?](https://github.com/feigi/fleet-plugin/issues/4150) (#4150) | None can be shown at 268 Pulls (a power limit); the record justifies one group; a split needs a gate that fires only when it beats a shuffled null. |
| [Must a reviewer be able to read why a ticket got its Cell?](https://github.com/feigi/fleet-plugin/issues/4157) (#4157) | Yes: the grouping is a tree of splits on dispatch-time inputs; it starts as one group. |
| [Which ticket inputs are recorded at dispatch from now on?](https://github.com/feigi/fleet-plugin/issues/4158) (#4158) | Record named paths (the list), whether each exists and its size, the directories spanned, the title and (amended) the installed plugin's version. Filed as #4159. |
| [How a repository's own Fit reaches its routing](https://github.com/feigi/fleet-plugin/issues/4126) (#4126) | The Fit computed at each phase 0 routes that run; it lives in `.fleet/`, is never committed, and records its inputs. |
| [What does a run route by when its phase-0 Fit is missing or fails?](https://github.com/feigi/fleet-plugin/issues/4162) (#4162) | The last Fit that computed, else the starting table. |
| [Why did fail rates fall between the two draw periods?](https://github.com/feigi/fleet-plugin/issues/4156) (#4156) | Not separable; outcomes shift for every Cell together. |
| [How much does old evidence count when the fleet itself changes?](https://github.com/feigi/fleet-plugin/issues/4163) (#4163) | Time-matched comparisons; every Pull kept; each Cell judged on its newest generation. |
| [When would a self-splitting grouping first split, and how often by chance?](https://github.com/feigi/fleet-plugin/issues/4160) (#4160) | The gate's chance-split rate and its pace. |
| [How the Router groups tickets onto Cells and refines the grouping](https://github.com/feigi/fleet-plugin/issues/4161) (#4161) | The split gate, depth and size, probability weights, one grouping for both Objectives, exploration in each group. Folds in [What burn-in tries, and what each later Exploration Pull tries](https://github.com/feigi/fleet-plugin/issues/4125) (#4125). Two parts **reopen on a word**: a Cell that exploration adds does not re-enter burn-in; ADR 0016's two stages and uniform draw are dropped. |
| [How often does a split pass by chance when the Fit re-judges it every run?](https://github.com/feigi/fleet-plugin/issues/4169) (#4169) | Chance splits at every-run re-judging, and the time to a real split. |
| [Must a split pass at two consecutive Fits before it stands?](https://github.com/feigi/fleet-plugin/issues/4170) (#4170) | Yes; it merges back on one failure. |
| [Does withdrawing a Cell here still remove it from every consumer?](https://github.com/feigi/fleet-plugin/issues/4129) (#4129) | No: the stopping rule retires; each repository excludes a Cell on its own evidence. |
| [Which files does fleet-ctl create in a run, and which survive it?](https://github.com/feigi/fleet-plugin/issues/4164) (#4164) | Only the three metrics TSVs reach main on their own. |
| [Which run artifacts are committed, and how do they reach main?](https://github.com/feigi/fleet-plugin/issues/4165) (#4165) | The Close-out PR also commits run records and review evidence; phase 0 catches up; the 435 unruled PRs are backfilled. Filed as #4175 and #4176. |
| [What does a repository's cockpit show of its Router?](https://github.com/feigi/fleet-plugin/issues/4173) (#4173) | One view of the phase-0 Fit. |

Withdrawn, so not a decision: [Does a consumer's light/heavy split come from its own tickets?](https://github.com/feigi/fleet-plugin/issues/4123) (#4123) — its ruling (keep the light/heavy constants) was withdrawn on the maintainer's word that light and heavy may not suffice.

**Filed ahead of this spec, because evidence not recorded or kept today is gone later. This spec references them and does not re-specify them:**
- [Record more ticket inputs at dispatch: named paths, their size, directory spread, title, plugin version](https://github.com/feigi/fleet-plugin/issues/4159) (#4159);
- [Keep every run's learnings: commit run records and review evidence with the Close-out PR](https://github.com/feigi/fleet-plugin/issues/4175) (#4175);
- [Backfill Rulings for the 435 unruled implementer PRs merged 2026-09-26..10-14](https://github.com/feigi/fleet-plugin/issues/4176) (#4176).

**Out of scope** (the map's own list): paid inputs (an LLM's sizing judgement, arm B, stays as designed and switched off; text embeddings); pooling evidence across repositories (no consumer's records leave its repository); choosing the Objective ([Cost or speed: where the user chooses the objective](https://github.com/feigi/fleet-plugin/issues/3680)).

## 2. The design

### 2.1 Today, in brief

A consumer routes by the table installed beside the scripts: `route` defaults to it (`plugin/scripts/ticket-router.mjs:65`, `:728`) and run-team's route call passes no `--table` (`plugin/skills/run-team/references/pull.md:251-253`). Nothing fits a consumer's table: the only Fit that replaces a table is the repo-local hook's, which is not shipped (`.omp/skills/run-team-local/hook.mjs:233`). So a consumer's first run routes every Pull at `slow-high` (no guard: `ticket-router.mjs:213-214`, `:323-329`); afterwards every Pull draws over the shipped table's Cells less those its own guard tripped, and burn-in never ends, because only a Fit changes `burn_in` (`:618`). A Ticketless PR merges unattended only on an Inert diff, whose data paths are exactly the three metrics TSVs (`plugin/scripts/closeout.mjs:161`, `plugin/scripts/finisher-scope.mjs:33`, `:138`).

The shipped `router-table.json` is the Fit of this repository's runs at `e5040b9a` (re-fit PR [chore: re-fit router-table.json at e5040b9a](https://github.com/feigi/fleet-plugin/pull/4115), merged 2026-11-01): stage 2, five Cells, `burn_in: true`, and every row (`*`, `light`, `heavy`, both Objectives) `task-high`. It reaches a consumer only after a release and an install.

### 2.2 The starting table

The shipped `plugin/scripts/router-table.json` **reduces to the starting table**, the table every repository begins from (#4124, #4122):

- one group, the `*` row, for every ticket;
- `cells`: `slow-high`, `task-high`, `smol-high` — the three models at `high`, which is what burn-in covers;
- `burn_in: true`, both Objectives' rows `slow-high`, no estimates, `fitted_commit` null, `n_rows` 0, `classifier` `{ b: null, tau: null }`.

That is the literal already kept at `tests/support/day-one-router-table.mjs:30-47` (`DAY_ONE_TABLE`). It changes only when the starting point itself changes, through an ordinary change, never by a Fit and never by a re-fit PR. Nothing from this repository's rows, trips or estimates routes, excludes or seeds anything at a consumer (#4124).

**Burn-in** draws uniformly over the starting Cells less those the repository's own guard has tripped (`ticket-router.mjs:213-226`, `:330`). It starts at run 2: run 1 has no cost guard, so every Pull is `slow-high`, and `pr-cost.mjs` writes a guard even at verdict `none` (`plugin/scripts/pr-cost.mjs:441-442`), so run 2 has one (`docs/research/consumer-burn-in.md` § 2). It ends once every starting Cell has 20 merged PRs (`MIN_N`) on its newest generation. A role's model change starts the Cell's new generation at zero merged PRs, which re-enters burn-in (unchanged; the cockpit says so, § 2.8).

**No stages.** ADR 0016's stage 2 (`STAGE2`, `ticket-router.mjs:78`; the branch at `:604-611`) retires: `slow-medium` and `task-max` are exploration candidates like any other Cell (§ 2.6). **A Cell that exploration adds does not re-enter burn-in:** `burn_in` is judged over the starting Cells only, where today it is `!cells.every(atN)` over the table's whole set (`:618`), so adding a Cell switches burn-in back on and draws uniformly over every Cell (`:330`), which is the opposite of a walk. This follows from the exploration decision and was not put to the maintainer on its own, so it **reopens on a word** (#4161).

What a clean start costs a new consumer, at this repository's rates (`docs/research/consumer-burn-in.md` § 3–§ 4): stage 1 (the three models at `high`) ends after about 102 Pulls, 10 weeks at 10 Pulls a week; against routing every Pull at `slow-high` it saves $213 and adds 12.4 floor failures, about 10 of them from the roughly 25 Pulls that land on `smol-high` before a consumer's guard can trip it (fail rate 0.56 here). That is the price of the maintainer's "tries out different roles and efforts in order to get evidence".

### 2.3 The per-repository Fit

The **Fit** is the Router's table, recomputed from the repository's own records (the three metrics TSVs, `.fleet/cost-guard.json` and the starting table as its prior). It replaces the **Preview fit** (`.fleet/router-preview.json`), which is only displayed today: the Fit that is displayed is the Fit that routes.

- **When.** Computed at every phase 0, by `metrics-refresh.mjs`: the step that drains the pending features rows, runs `pr-cost.mjs --guard` and writes the Preview fit today (`plugin/scripts/metrics-refresh.mjs:59-66`, `:294-345`; `plugin/skills/run-team/references/phase-0.md:230-251`). A Fit takes 39–209 ms (`docs/research/fit-cadence.md`, Results).
- **One Fit per run.** Cost rows come only from close-out's scrape (`closeout.mjs:30-33`), so nothing a Fit reads changes mid-run, and no Fit runs there. Each close-out's evidence routes the next run. Burn-in ending, a Cell adopted, a split standing or merging back take effect at the next phase 0.
- **Where.** `.fleet/router-fit.json`, beside the cost guard, written through a temp file and a rename, never committed (`.fleet/` is gitignored). The rename after a successful computation is what makes the file on disk the last good Fit: the writer throws on anything it cannot read, fit or write before the rename, so a failure leaves the old file as it was (the Preview fit's writer already works this way, `metrics-refresh.mjs:289-293`).
- **Recorded inputs.** The Fit records the git blob id of each metrics file it read (`tsv_blobs`), the guard it used (its `tripped` list and per-Cell `n`, with the guard's own `computed_at`), and its prior, so it can be recomputed from the repository's own records once those rows are on `origin/main`. Today's Preview fit already records the first two, and the prior's `fitted_commit`, `version`, `cells` and `classifier` (`metrics-refresh.mjs:304-326`). A Fit is a pure function of those records, the guard and the starting table, as `fitTable` is today, plus the previous Fit's split-pass history (§ 2.4); it carries no other state, so there is no stage to carry and a Cell exploration added is re-derived from the record at each Fit.
- **If it is missing or fails** (#4162): the run routes by the last Fit that computed, which is the file left in `.fleet/`; if no Fit has ever computed, by the starting table. A failed Fit costs one run of staleness, never a switch to the dearest Cell. The cost guard still trips Cells on that run's evidence (it is written by its own step and read by `route` on every Pull), and the failure is reported where the cockpit reads it: a `metrics-refresh: fit: failed — <why>` line on the step's output, as `preview: failed —` is today (`plugin/scripts/compute-cell-evidence.mjs:152-158`, `refitFailure`). A first run needs no special case: no records, so its Fit is the starting table. A missing guard still means `slow-high` and no draw (`ticket-router.mjs:323-329`): deleting the guard cannot evade it.
- **How `route` reads it.** `route` reads `.fleet/router-fit.json` beside the `--guard` it is given, as it already writes the Pull's pending features row beside that file (`ticket-router.mjs:761`). A file that is absent, unparseable or fails `validateTable` (`:150`) is the starting table, beside the script (`DEFAULT_TABLE`, `:65`), and the Routing says so in its `REASON`.
- **Nothing new is committed.** The Close-out PR stays an Inert diff and keeps merging on its own; the two-consecutive-Fits test (§ 2.4) reads its history from the previous Fit file, not from a commit.
- **The accepted cost.** In histories where no Cell is truly cheaper, a Fit at every run adopts a not-cheaper Cell at some run in 20.4% of histories, against 5.6% at the old every-50-merged-PRs cadence; both end with 5.6% still adopted (`docs/research/fit-cadence.md`, Results 2). A false pick has passed the quality floor and its point estimate was at most 0.75 of `slow-high`'s, so it routes to a Cell about as dear as `slow-high`. On this repository's real history every cadence reached the same rows and undid nothing.

### 2.4 Groups

**Shape.** The grouping is a tree of readable splits on inputs recorded at dispatch (#4157). Each leaf is a group, a **Stratum** in the glossary's new sense; each node carries its own `cost` and `speed` rows, so a ticket missing the input a split reads is routed by that node's row, as a ticket with an `unknown` Stratum follows `*` today (`rowFor`, `ticket-router.mjs:199`). The tree starts as one group and splits only when the logged random draws show a split pays. ADR 0016 decision 2's ban on a parametric ticket→Cell model stands, because at the reachable n a table diff is reviewable and coefficients are not; its fixed `light|heavy|unknown` Stratum does not (ADR 0037). A reviewer diffs the tree as they diff the table today.

**Inputs.** A split is tested only on inputs recorded at dispatch, because an issue's text changes after its Pull and a file's size changes with every merge (#4158). Those are the ticket-features columns: today `brief_chars`, `criteria`, `comments`, `age_days`, `paths`, `test_paths`, `xrefs`, `kind` and `parent` (`plugin/scripts/pull-attribution.mjs:95-99`), and, once #4159 lands, the named paths, whether each exists and its size, the directories spanned, the title and the plugin version. A candidate cut is a percentile cut (25th, 50th, 75th) of a numeric input, a value of `kind`, or the presence of `parent`, as `docs/research/split-gate.md` searched; a cut whose smaller side holds fewer than 2 × `MIN_N` Pulls is dropped. Rows written before a column existed stay blank in it, as they do for `parent` and `objective`.

**The gate** (#4161). A split stands only when it passes **both** tests, on the Fit's Pulls:
- *the shuffled null:* the best split's in-sample gain beats the 95th percentile of the same search run on shuffled inputs, shuffled inside sets of Pulls with equal assignment probability;
- *the off-policy lower bound:* a doubly robust estimate of the split's value over one group's, scored with each Pull's own known probability of the Cell it got (in place of a fixed 1/2), has a one-sided 95% lower bound above 0.

Both tests together split by chance 0–3% of the time at a single look, against 2–7% for the shuffled null alone (`docs/research/split-gate.md`, § 3).

**Depth and size.** Splits go to **depth 2 at most**. Every side must hold **at least 20 merged PRs on each candidate Cell**: a Cell is a candidate in a group only with 20 merged PRs there, and the base `slow-high` needs 20 too, because `judge` returns no verdict without them (`ticket-router.mjs:499`, `MIN_N` at `:74`). So no split can pass before burn-in has produced those Pulls.

**Standing.** Every Fit re-judges every split. A split **stands after it passes at two consecutive Fits, on the same input or inputs** (thresholds move with the record's percentiles, so the input is the identity, not the cut), and **merges back as soon as it fails at a Fit** (#4170, #4161). The previous Fit's passing candidates are kept in the Fit file for this. With this rule 15% of no-effect histories ever hold a chance split, against 24% if it stood on one pass, and 1% still hold one at the end; a real split worth 6.5% reaches 80% of histories at run 37 (629 Pulls) instead of run 32 (544) (`docs/research/split-looks.md` § 1–§ 2).

**One grouping serves both Objectives, and it splits on cost.** A split is judged on $ per merged PR. Each group keeps a `cost` row and a `speed` row, both judged as today: the `cost` row adopts a Cell only at or under 0.75 of `slow-high`'s $ per merged PR there and with the bootstrap 95% CI of the difference wholly below zero; the `speed` row starts from the `cost` row's Cell and adopts another only at or under 0.75 of that Cell's minutes of Work time per merged PR and with the CI wholly below zero (ADR 0016 as amended by #3678 and #3680; `judge`, `ticket-router.mjs:494-546`, `judgeSpeedRow` `:554`). Among qualifying Cells, one another is reliably cheaper than drops out; then the lower fail rate, the lower figure, the Cell name decide, unchanged.

**The quality floor applies per row.** Each row of each group refuses a Cell whose fail rate is 15 points or more above `slow-high`'s in that group (`underFloor`, `pull-attribution.mjs:107-109`; `TRIP_POINTS` `:103`), afresh at every Fit, refusing the Cell only for that row; the Cell still takes Exploration Pulls.

**Routing by group.** `route` walks the tree on the ticket's dispatch-time inputs to a leaf, takes that group's row for the run's Objective, and the Routing line's `STRATUM` names the group by its rule path (for example `brief_chars>4047`, or `*` for the root) in place of `light|heavy|unknown` (`plugin/scripts/ledger-grammar.mjs:851`, `:858`). The fixed light/heavy rule (`HEAVY_BRIEF_CHARS` 3,483 and `HEAVY_CRITERIA` 5, `ticket-router.mjs:69-70`; `ruleStratum` `:139`) retires; "heavy" and "light" survive only as the cuts a split may happen to take. Arm B (a paid sizing label) stays as designed and switched off (`classifier.b` null, `bArmLive` `:194`); how a label would enter a tree is the effort that switches it on.

### 2.5 Evidence

- **Every Pull counts, weighted by its known assignment probability** (#4161). The probability is uniform during burn-in (1 over the number of untripped starting Cells); after burn-in it is 4 in 5 at the group's Cell, and the remaining 1 in 5 is spread over the group's exploration Cells. The gate (§ 2.4) weighs each Pull by it. Counting only the exploring Pulls would need 2.5–2.8 times more Pulls for the same share of histories: with weights a real split worth 6.5% is found by run 32 (544 Pulls), against run 85 (1,445 Pulls) on the uniform draws alone (`docs/research/split-looks.md` § 2); each Pull carries about 0.56–0.70 of a fair draw's information.
- **Comparisons are time-matched** (#4163). Two Cells are compared only over the stretches of time in which both were drawn, and the stretches are then pooled. Every Pull is kept, and a shift that hits every Cell at once cancels. This applies to the figures and to the quality floor alike, and a Cell that ran in only one stretch is judged against the Cells that ran alongside it, never against a base whose other stretches pull the base's figures up or down. The case that needs it: `smol-high` was drawn only until 2026-10-25, while fail rates were higher, and even within that period it failed 28 points more often than `slow-high`, range [3.1, 50.0] (`docs/research/router-inputs.md` § 3). **A stretch is one UTC calendar week of `run_date`, cut where the recorded plugin version changes** — this spec's pick between a session and a week (§ 2.12): a session of about 17 Pulls seldom holds an exploration Cell at all, and the version is recorded with each Pull by #4159 so that a stretch can be cut where the fleet's own pipeline changed.
- **Each Cell is judged on its newest generation.** An older generation is reported beside it and never pooled with it, because each model generation prices and fails differently; a role that returns to an earlier model rejoins that generation (`CONTEXT.md` **Cell generation**; unchanged).
- **No Ruling-provenance filter.** The fall in fail rates between the two draw periods (29.1% to 16.3%) cannot be separated into re-rulings (131 of 208 Rulings), process changes in the fleet and an unrecorded plugin version; ticket mix explains at most 3.1 points; outcomes shift for every Cell together (`docs/research/fail-rate-drift.md`, Decomposition). Time-matching is the answer to drift, not a filter on who ruled.

### 2.6 Exploration in each group

After burn-in, as today, every 5th `impl-` row that is not a chain head explores (`EXPLORE_EVERY`, `ticket-router.mjs:72`, `:330`): one Pull in five. What changes is the draw: it is no longer uniform over every untripped Cell less the `cost` row's Cell (`:213-226`, `:336`), but uniform over the **group's exploration Cells**, around the group's `cost` row Cell (exploration ignores the Objective, as today):

- one effort level up and one level down on the same role's own ladder;
- the **bigger model one level lower**;
- the **smaller model one level higher**.

The last two test the maintainer's hypothesis that a smaller model with more effort, or a bigger one with less, can do the job cheaper or faster. A candidate that does not exist is absent: there is no bigger model above `slow`, no level above `max`, and a level the role's catalog does not list would be clamped by omp (`docs/research/cell-grid.md` § 1, § 6). The ladders come from the operator's `modelRoles` and the catalog, so the grid is the install's. On this install:

| Group's Cell | Exploration Cells |
|---|---|
| `task-high` | `task-xhigh`, `task-medium`, `slow-medium`, `smol-xhigh` |
| `slow-high` | `slow-xhigh`, `slow-medium`, `task-xhigh` |
| `smol-high` | `smol-xhigh`, `smol-medium`, `task-medium` |

A tripped Cell is never drawn (`rowDispatch` leaves the guard's tripped Cells out, `:219`). A group with no candidate left has no draw. Exploration reaches any Cell of the grid by walking, so **every Cell the grid can reach needs a definition** (`plugin/agents/fleet-implementer-<cell>.agent.md`): today five of the 15 exist. A new level needs only a definition file, the Cell lists in the cockpit, the docs and the tests, and the generic code (the `CELL` grammar, the guard, tier-check, dispatch, the cell readout) already accepts any Cell name (`docs/research/cell-grid.md` § 3).

Each candidate needs 20 merged PRs before it can be judged. With k candidates sharing one Pull in five, each takes about 100 × k Pulls to get there [INFERENCE: arithmetic from the draw rate at a merge fraction near 1, from the facts on #4125; not in a research note]: about 400 Pulls for four. The 1-in-5 share is **revisited once a repository's record shows what exploring costs**; no note measures that cost, so the share is not tuned.

### 2.7 Exclusion

Each repository excludes a failing Cell on its own evidence alone (#4129), by three means:
- its **cost guard**, which stops drawing a Cell once it trips: a Cell with 20 merged PRs and `slow-high` with 20 whose fail rate is 15 or more points above the baseline's, or whose $ per merged PR is at or above it (`pr-cost.mjs:218-220`; ADR 0016 § Guard), sticky by construction;
- **each row's quality floor** (§ 2.4);
- its **groups' exploration, which moves on**: the candidates are those of the group's current Cell, so a walk away from a Cell that keeps losing leaves it behind.

**The stopping rule retires.** It files a `ready-for-human` issue asking the maintainer to withdraw a failing Cell's definition from the plugin, which would remove the Cell from every consumer, against the clean start. Retiring it removes the hook's duty 2 (`hook.mjs:140` `stopping`, registered `:317`, imported `:41`; `.omp/skills/run-team-local/SKILL.md:39-55`), `cell-readout.mjs`'s `stoppingRule` (`plugin/scripts/cell-readout.mjs:46`, `:205`) and the `Withdraw exploration cell <cell>:` issue it files. A definition leaves the plugin only through an ordinary change, for example when a model is no longer offered. The cockpit shows the Cells a repository's guard has tripped (§ 2.8).

ADR 0016's Guard section names two things the decisions strand. Its retire condition, "if every non-default cell of stage 1 trips before any stratum adopts one", reads over the starting table's Cells now that there is no stage 1. Its baseline, "`slow-high`, strictly, cumulative from a `WINDOW_START` constant" (`pr-cost.mjs:98`), compares Cells over the whole window: the quality floor is one rule in the Fit and in the guard (`underFloor`), and #4163 applies time-matching to "the quality floor alike" and drops cumulative pooling, so the guard's trip comparison is time-matched too (§ 2.12). `WINDOW_START` stays as the window's lower bound.

### 2.8 The cockpit

The Cell evidence tab becomes **one view of the phase-0 Fit**, the Fit that routes the run (#4173). The separate "routes now" and "evidence favours" sides end, because they no longer differ. The view shows:
- the tree of groups, and each group's Cell, with every candidate's verdict and range;
- burn-in progress, as merged PRs per Cell against 20;
- exploration: which Cells each group is trying;
- the Cells the cost guard has tripped;
- a notice when a role's model changed and burn-in restarted (today the repo-local drift notice, `hook.mjs:316`);
- a flag when this run's Fit failed and the last good Fit routes.

Retired: the comparison of this checkout's table with the installed one (`compute-cell-evidence.mjs:570-592` `behindMain`, and the checkout read at `plugin/scripts/board-gather.mjs:844-860`), and the consumer footnote that routing reaches a consumer "only through its cost guard, which can hold a Cell back but never picks one" (`compute-cell-evidence.mjs:601`). The board card's Cell line, which prints a brief against the 3,483 threshold (`plugin/scripts/compute-board.mjs:41`, `:381`), prints the group's rule instead.

### 2.9 This repository

This repository is one more consumer (#4122). It routes by its own Fit, through the same mechanism. A fleet run refuses a linked root (`README.md:32-37`), so its runs route by the installed `@feigi/fleet-ctl`: the starting table is the installed one, and the Fit is computed in this repository's own `.fleet/`. What this repository learns no longer waits on a merged re-fit PR, a release and an install to route. What retires:
- the hook's re-fit duty (`routerFit`, `hook.mjs:233`, registered `:318`) and its paragraph (`.omp/skills/run-team-local/SKILL.md:56-98`), with the `chore/router-fit-<date>` PR, `FIT_BRANCH` (`hook.mjs:52`) and the human stop at `SKILL.md:94-98`;
- CI's "Router table check" of the shipped table (`.github/workflows/ci.yml:175-189`) and the test that runs it (`tests/ticket-router.test.mjs:1152-1214`);
- `ticket-router.mjs`'s `fit`, `--check` and `--due` modes (`:24-40`, `:826-859`), `FIT_EVERY_MERGED` (`:76`), `mergedSince` (`:633`) and the read-from-git helpers only they use (`resolveCommit`, `showAt`, `:681-695`);
- the question in [Router re-fit PR: lift the human stop once re-fits have merged by hand?](https://github.com/feigi/fleet-plugin/issues/4066) (#4066), since no re-fit PR remains to stop.

Until the slices land, today's path still runs: the hook still opens a re-fit PR once 50 merged PRs are due. Tests keep reading the day-one literal `tests/support/day-one-router-table.mjs`.

### 2.10 Durability

"Its important we dont lose the learnings we get from runs." The Fit reads the three metrics TSVs and is recomputable from them; what it cannot recompute is lost once deleted, so the records are kept. This is filed already and is **not re-specified here**:
- [#4159](https://github.com/feigi/fleet-plugin/issues/4159): the inputs a split can be tested on are recorded at dispatch, including the plugin version;
- [#4175](https://github.com/feigi/fleet-plugin/issues/4175): the Close-out PR also commits each run's ledger archive, receipts and plugin version and each reviewed PR's review record and Charges (about 200 KiB a run here); the Inert data set widens to those paths so the PR still merges on its own; `reclaim-scratch` deletes review evidence only once the Close-out PR that carries it has merged; a run's phase 0 commits whatever an earlier run left. Briefs, the issue text as dispatched, are not committed; transcripts (about 130 MiB a run, possibly holding secrets) stay with the harness;
- [#4176](https://github.com/feigi/fleet-plugin/issues/4176): the 435 merged implementer PRs from 2026-09-26 to 10-14 that have no Ruling are backfilled from transcripts while those exist (about $300–350).

The slices of § 6 depend on #4159 only for the extra split inputs and the version cut of a stretch; the Fit works on today's nine inputs without it.

### 2.11 Naming

**Stratum** keeps its name: the maintainer's "cluster" is a leaf of the tree, and the name is kept now that the mechanism is chosen. It changes meaning, from a fixed `light|heavy|unknown` rule to a group learned from evidence. The **Preview fit** is retired into **Fit**, and **Starting table** is new (`CONTEXT.md`).

### 2.12 What this spec chose

Where a resolution left a point to the spec, or the mechanism needed one, this spec picks as follows; each is a slice's detail to confirm, and none contradicts a resolution:
1. A **stretch** is a UTC calendar week of `run_date`, cut at a recorded plugin-version change (#4163 left the unit to the spec).
2. The Fit is the file `.fleet/router-fit.json`; `route` reads it beside `--guard`.
3. A group is named by its rule path in the Routing line's `STRATUM`.
4. A Pull records its **assignment probability** at dispatch, in a new optional ticket-features column written by `route`, which alone knows whether the draw was burn-in or every-5th, the number of Cells, and whether the row was a chain head (never exploring). It cannot be derived later from `exploration_draw` alone: a burn-in draw and an every-5th draw look alike in the row. A row without the column is left out of the weighted comparisons and counted as left out, as `left_out` counts other unusable Pulls (`ticket-router.mjs:419`).
5. "Two consecutive Fits" are two consecutive Fits that computed; a failed Fit is no look.
6. The guard's trip comparison is time-matched with the Fit's (§ 2.7).
7. A ticket missing the input a split reads follows the node's own row.
8. A candidate exploration Cell the install cannot run is absent from the draw.

## 3. What retires or changes

Read at `b848c23a`. "Slice" names the § 6 slice that carries the change.

**Code**

| What | Where | Becomes | Slice |
|---|---|---|---|
| The shipped table | `plugin/scripts/router-table.json` | the starting table (§ 2.2) | S9 |
| Light/heavy rule and thresholds | `ticket-router.mjs:69-70`, `:139`; `ledger-grammar.mjs:858` (`STRATA`) | a tree walk on dispatch-time inputs; the Routing's `STRATUM` names the group | S1 |
| Rows keyed by stratum, `rowFor` | `ticket-router.mjs:150`, `:199`, `:217`, `:581-598` | rows per tree node; `validateTable` accepts a tree | S1 |
| Stage 2 and `stage` | `ticket-router.mjs:78`, `:604-611`, `:616` | none; `burn_in` over the starting Cells | S4 |
| Exploration draw set | `ticket-router.mjs:213-226`, `:330-340`; `ledger-grammar.mjs:832` (`drawCell`) | uniform over the group's exploration Cells | S5 |
| Pooled comparisons | `ticket-router.mjs:494-546` (`judge`), `:501-503`; `pr-cost.mjs:218-220` | time-matched stretches | S6 |
| Ticket-features row | `pull-attribution.mjs:95-100` | gains #4159's columns and the assignment probability | S5 |
| The Preview fit | `metrics-refresh.mjs:59-66`, `:105`, `:294-345`; `phase-0.md:248-251`; `close-out.md:114-117` | the Fit, which routes | S3 |
| The route call's table | `pull.md:249-253`; `ticket-router.mjs:728`, `:757-760` | reads the Fit beside `--guard`, else the starting table | S3 |
| Split gate | none today | the tree search, both tests, depth, two-pass standing | S7 |
| Stopping rule | `hook.mjs:41`, `:140`, `:317`; `cell-readout.mjs:46`, `:205`; `SKILL.md:39-55`; tests `tests/run-team-local-hook.test.mjs:259-431`, `tests/cell-readout.test.mjs`; the pin at `tests/citation-sweep-prose.test.mjs:663-665` | retired | S8 |
| The hook's re-fit | `hook.mjs:52`, `:233`, `:318`; `SKILL.md:3`, `:23-27`, `:56-98`, `:107-108`; tests `tests/run-team-local-hook.test.mjs:433-668` | retired | S9 |
| `fit`, `--check`, `--due` | `ticket-router.mjs:24-40`, `:76`, `:633`, `:681-695`, `:790-859`; tests `tests/ticket-router.test.mjs` (`--check` and `fit --due` tests, e.g. `:944-1150`, `:1268-`; `:1545`, `:1917`) | retired | S9 |
| CI's router check | `.github/workflows/ci.yml:175-189`; `tests/ticket-router.test.mjs:1152-1214` | retired | S9 |
| Two-sided policy rows | `compute-cell-evidence.mjs:570-613`, `:689-`, `:731-`; `board-gather.mjs:793-875`; `compute-board.mjs:41`, `:381`; their tests (`compute-cell-evidence`, `board-cell-evidence-gather`, `cell-evidence-alerts`, `cockpit-tabs`, `compute-board-cell-line`) | one view of the Fit | S10 |
| Cell definitions | `plugin/agents/fleet-implementer-{slow-high,slow-medium,task-high,task-max,smol-high}.agent.md`; Cell lists `compute-cell-evidence.mjs:42`, `compute-board.mjs`, docs, tests | one definition per reachable Cell | S2 |

**Docs and records**

| What | Where | Change | Slice |
|---|---|---|---|
| ADR 0016 | `**Status:**` | amended by ADR 0037 (this PR) | — |
| ADR 0013 | `**Status:**` | its § 6 draw amended by ADR 0037 (this PR) | — |
| `CONTEXT.md` | **Router**, **Preview fit** (now **Fit**), **Starting table** (new), **Stratum**, **Exploration Pull**, **Exploration draw**, **Cell evidence**, **Quality floor** | this PR | — |
| `CONTEXT.md` | **Admissible row** names `stoppingRule` (pinned by `tests/citation-sweep-prose.test.mjs:663-665`) | drops it when the rule retires | S8 |
| Router spec | R2 classifiers, R3 table, R4 allocation, R5 fit, R6 route, § 5 the hook | amendment notes under the changed text | S11 |
| Cockpit tabs spec | § 4–§ 5 (reads, policy rows) | amendment notes | S11 |
| `docs/components/tier-routing.md:24`, `:68` | the draw over the table's `cells` | the group's exploration Cells | S11 |
| Issues | #4066 | retired, no re-fit PR remains | S9 |

## 4. The measured basis

Every figure below is from the cited note, measured at `origin/main` `e5040b9a` or later (each note names its commit), on this repository's 268 Pulls unless it says otherwise.

| Decision | Figure | Note |
|---|---|---|
| The grid | Every role runs `low`–`max`: 15 runnable Cells, 5 defined; roles by price `smol` < `task` < `slow`; `claude-opus-5-5` at `xhigh` cost $3.54 per Pull against $2.14 at `high` (+65%, 59 and 51 Pulls, bootstrap range of the difference $0.77–2.05; an association, not a controlled comparison). | `docs/research/cell-grid.md` § 1, § 5, § 6 |
| Clean start, burn-in pace | Burn-in draws start at run 2. The guard can first trip a Cell after about 85 Pulls, stage 1 ends after about 102 [85, 119], stage 1 then 2 after about 187 [136, 221]: 10.2 and 18.7 weeks at 10 Pulls a week, 3.4 and 6.2 at 30. | `docs/research/consumer-burn-in.md` § 2, § 4 |
| Clean-start cost | Stage 1: −$213.47 and +12.42 floor failures against all-`slow-high`; `smol-high`'s 27.8 Pulls carry 10.28 of the failures (fail rate 0.5625 against 0.1923 on `slow-high`, floor 0.3423). | `docs/research/consumer-burn-in.md` § 3, § 4 |
| Fit at every run | False adoption at some look: 20.4% [15.6, 25.9] of 250 null histories at every run, 5.6% [3.1, 9.2] at the old cadence; both still adopted at the end in 5.6%. A Fit takes 39–209 ms. | `docs/research/fit-cadence.md`, Results 2 |
| Light/heavy | 184 heavy, 84 light; every light, heavy and `*` row is `task-high` under both Objectives, so no stratum row differs from `*`; the grouping gain of the light/heavy split is exactly $0.00 and 0.00 minutes. | `docs/research/stratum-split.md`; `docs/research/router-inputs.md` § 6.1 |
| Power at this n | Per-Pull CV 0.64 for $ and 0.49 for minutes; 163 Pulls a Cell to see a 20% $ difference. The smallest cost interaction the record could detect is $6.0–16.0 per merged PR, against a $4.23 gap between `task-high` and `slow-high`. | `docs/research/router-noise.md`; `docs/research/router-inputs.md` § 2.4, § 7 |
| One group today | 19 inputs (9 recorded, 10 free from the issue text): the best in-sample grouping gain is $0.00 (one input) and $0.08 (two), against shuffled-null 95th percentiles of $0.22 and $0.60; held-out gain is negative in all eight variants (−$0.28 to −$0.94 per merged PR, −3.16 to −10.29 minutes). | `docs/research/router-inputs.md` § 6.1, § 6.3 |
| Readable rules | Policy trees, MOB and causal trees give rules, at 500–5,000 cases (a depth-2 tree over 3 Cells leaves 22 Pulls per leaf and Cell at 268); Hoeffding trees need 25,000+ examples; bandits learn 30–150 coefficients (1.8–8.9 Pulls each at 268); no source has a per-Cell quality floor. | `docs/research/self-refining-routing.md` §§ 1–6, Comparison |
| Drift | Fail rate 29.1% → 16.3% (12.8 points, range [1.8, 23.4]); 131 of 208 Rulings re-ruled; mix explains at most 3.1 points; the three causes collinear with the period. `smol-high` was drawn only until 2026-10-25. | `docs/research/fail-rate-drift.md`, Decomposition |
| The gate | On the real record nothing splits (best depth-2 gain $0.08, null 95th percentile $0.52). With no input mattering, the shuffled null splits 2–4% at depth 1 and 5–7% at depth 2, the lower bound 0–1% from 2,000 draws on, both together 0–3%. A flip worth 6.5% ($0.87) is found 80% of the time after about 1,000 uniform draws, one worth 13.1% after about 500. | `docs/research/split-gate.md` §§ 1–4 |
| Pace of the gate | 1,000 uniform draws are 4,592 Pulls: 51 weeks at 90 Pulls a week, 153 at 30 and 459 (about 9 years) at 10, counting only exploring Pulls; after burn-in the draw is 4 in 5 against 1 in 5, not 50/50. | `docs/research/split-gate.md` § 4–§ 5 |
| Re-judging every run | Depth 2, decided gate: 24.0% of no-effect histories hold a chance split at some run (15.0% if two consecutive passes are required), lasting 3.4 (4.5) runs on average, 1.0% at the end. A real split worth 6.5% reaches 80% of histories at run 32 (544 Pulls) on one pass, run 37 (629) on two; counting only exploring Pulls it takes run 85 (1,445) and run 100 (1,700). | `docs/research/split-looks.md` § 1–§ 2 |
| Durability | Only the three metrics TSVs reach main; per-PR review evidence is about 9 KiB a PR and `reclaim-scratch` deletes it; about 200 KiB a run is committed under #4175; transcripts run about 130 MiB a run; 435 merged PRs have no Ruling, about $0.69–0.81 each to rebuild. | `docs/research/run-artifacts.md` § 2–§ 7 |

## 5. Limits

What no note measured, and so what this spec does not claim:
- **Depth beyond 2.** The gate was simulated to depth 2. A deeper tree divides the same Pulls by more groups and multiplies the looks; the cap stays 2 until a record shows a depth-2 split standing and a measurement covers deeper.
- **Splits that matter only for speed.** The gate scores $ per merged PR. The `speed` Objective's own heterogeneity was not simulated (`docs/research/split-gate.md` § 6, not measured); one grouping split on cost serves both Objectives by decision, not by measurement.
- **Effect shapes other than the ones tested.** The simulations inject one flat $ shift on one Cell, on a fair-coin input, over a pool of two Cells (`slow-high` and `task-high`, 208 Pulls). A shift on a different Cell, a shape that varies with an input's size, two interacting inputs, three or more Cells and an effect on fail rate were not run (`docs/research/split-gate.md` Method; `docs/research/split-looks.md` Method).
- **The exploration share.** One Pull in five was not tuned; what exploring costs a repository, and how long four candidates take to reach 20 merged PRs (about 400 Pulls, § 2.6), were not measured. The share is revisited once a record shows the cost.
- **Small repositories' pace.** At 10 Pulls a week, stage 1 of burn-in alone takes about 10 weeks (`docs/research/consumer-burn-in.md` § 4), and a real split worth 6.5% is found by about 544 Pulls with weighting [INFERENCE: 544 ÷ 10, a year] and by 1,445 without it (about 2.8 years); a smaller split takes longer, and `docs/research/split-gate.md` § 4 puts 1,000 uniform draws at 459 weeks, about 9 years, at 10 Pulls a week. A small repository will route by one group for years, and that is the intended outcome of a gate that fires only when it beats the null.
- **The estimator on the real record.** The time-matched comparison and the weighted gate were not run on this repository's 268 Pulls; the simulations resample a pool and do not time-match. What the first Fit here reproduces (today every row routes `task-high`) is not predicted by a note.
- **The stretch unit.** A week of `run_date`, cut at a version change (§ 2.12), is this spec's pick and unmeasured against a session.
- **Rulings that reopen on a word.** Three were not put to the maintainer in a measured form of their own: the clean start (#4124, ruled by an agent while the maintainer was away), a Cell that exploration adds not re-entering burn-in, and dropping ADR 0016's two stages and uniform draw (both #4161).

## 6. Proposed slices

Not filed. The controller files each as a `needs-triage` issue with a `Part of` line naming map #4118, ordered by native blocked-by links, after the maintainer reviews this spec. #4159, #4175 and #4176 are filed already and are blockers or companions, not slices.

**S1. A tree-shaped table, read by `route`.**
- *Scope:* the table gains a tree of splits with a `cost` and a `speed` row on each node; `validateTable` accepts it; `route` walks the tree on the ticket's dispatch-time inputs, falls back to the node's row for a missing input, and prints the group's rule path in the Routing's `STRATUM`; `ruleStratum`, `HEAVY_BRIEF_CHARS`, `HEAVY_CRITERIA` and `STRATA` retire; the board card's Cell line prints the group's rule; the starting table is the one-node tree.
- *Acceptance:* a one-node tree routes every ticket as `*` does today; a two-leaf fixture routes each side by its own row; a ticket missing the split's input follows the node's row; `ledger.mjs` refuses a malformed Routing line; `tests/ticket-router.test.mjs` and the board card tests are green with `ruleStratum` gone.
- *Blocked by:* none.

**S2. A definition for every Cell the grid can reach.**
- *Scope:* one `plugin/agents/fleet-implementer-<cell>.agent.md` for each of the 15 Cells (10 are missing), byte-identical bodies, `model: "@<role>:<level>"`; the Cell lists in the cockpit, the docs and the tests; `tier-roles.mjs --check` refuses a definition whose level the role's catalog does not list.
- *Acceptance:* every Cell of 3 roles × `low`–`max` has a definition; `tier-roles.mjs --check` is green; the cockpit lists 15 Cells; the body-identity test covers all of them.
- *Blocked by:* none.

**S3. The phase-0 Fit routes the run.**
- *Scope:* `metrics-refresh.mjs` writes the Fit, `.fleet/router-fit.json`, in place of the Preview fit: temp file and rename, the guard it used and each TSV's blob id recorded, a `fit: failed — <why>` line on failure that leaves the old file; `route` reads the Fit beside `--guard`, else the starting table, with a `REASON` naming the fallback; run-team's route call, phase-0 and close-out prose describe the Fit. One Fit per run.
- *Acceptance:* a fixture run computes a Fit at phase 0 and its next `route` call uses it; a Fit that throws leaves the previous file, and the run routes by it; with no Fit file ever, by the starting table; a deleted guard still means `slow-high` with no draw; the Fit file is untracked; the recorded blob ids recompute the same Fit once the rows are on a commit.
- *Blocked by:* S1.

**S4. Burn-in over the starting Cells, with no stages.**
- *Scope:* `STAGE2` and the `stage` field retire; `burn_in` is judged over the starting Cells only; a Cell added by exploration does not re-enter it; a role's model change re-enters it (unchanged).
- *Acceptance:* a Fit with the three starting Cells at 20 merged each has `burn_in: false` whatever Cells exploration has added; `slow-medium` and `task-max` are never drawn by burn-in; a model change on a role restores burn-in for that Cell.
- *Blocked by:* S1.

**S5. Exploration in each group, and the assignment probability.**
- *Scope:* the after-burn-in draw is uniform over the group's exploration Cells (§ 2.6), runnable and untripped; each Pull records its assignment probability in a new optional ticket-features column, written by `route` (§ 2.12 item 4); `FEATURE_COLUMNS` and the pending-file header handling take the column.
- *Acceptance:* for `task-high` the candidates are `task-xhigh`, `task-medium`, `slow-medium` and `smol-xhigh`; a Cell the install cannot run is never a candidate; chain heads never explore and record probability 1 for the policy Cell; a burn-in Pull records 1 over the number of untripped starting Cells; an old pending file with no such column still appends.
- *Blocked by:* S1, S2, S4.

**S6. Time-matched comparisons for the rows, the floor and the guard.**
- *Scope:* `judge`'s ranges and `underFloor`'s comparison are computed over the stretches (§ 2.5) in which both Cells were drawn, then pooled; `pr-cost.mjs`'s trip comparison uses the same function; the Cell generation rule is unchanged; the version cut applies once #4159's column exists.
- *Acceptance:* on this repository's record `smol-high` is compared with `slow-high` only over the weeks both were drawn and reproduces a fail-rate gap near the 28 points [3.1, 50.0] the notes report; a shift added to every Cell at once leaves every verdict unchanged; a Cell that ran in one stretch is never judged against a base from other stretches.
- *Blocked by:* S1 (and #4159 for the version cut).

**S7. The split gate.**
- *Scope:* the tree search over the recorded inputs (§ 2.4): the shuffled null and the off-policy lower bound, with each Pull's recorded probability, both required; depth 2 at most; 20 merged PRs per candidate Cell on each side; standing after two consecutive Fits on the same input(s); merging back on one failure; the previous Fit's passes read from the last Fit file; a split judged on `cost`, both rows kept per group; the quality floor per row.
- *Acceptance:* on this repository's 268 Pulls nothing splits; on a seeded fixture with a real flip worth 6.5% the split stands by the 37th run of 17 Pulls in 80% of histories; on a no-effect fixture no more than 15% of histories hold a chance split at some run and 1% at the end (the measured rates of `docs/research/split-looks.md`, with the ranges the notes give); a Fit that failed counts as no look.
- *Blocked by:* S3, S5, S6.

**S8. The stopping rule retires.**
- *Scope:* the hook's duty 2 and the `Withdraw exploration cell` issue, `stoppingRule` and its tests, the `SKILL.md` paragraph and description; `CONTEXT.md` **Admissible row** drops its `stoppingRule` clause and `tests/citation-sweep-prose.test.mjs`'s `stoppingRule` pin goes with it; open withdrawal issues are left to the maintainer.
- *Acceptance:* the hook runs two duties; no code or doc names `stoppingRule`; the citation-sweep test is green.
- *Blocked by:* none.

**S9. This repository routes as a consumer.**
- *Scope:* `router-table.json` reduces to the starting table; the hook's re-fit duty, `FIT_BRANCH`, CI's "Router table check" and its test, `fit`, `--check`, `--due`, `FIT_EVERY_MERGED`, `mergedSince` and the read-from-git helpers retire; `run-team-local`'s `SKILL.md` and description; the day-one test support's header comment; the controller retires [#4066](https://github.com/feigi/fleet-plugin/issues/4066).
- *Acceptance:* no `chore/router-fit-*` PR can open; CI has no router step; `route` with no Fit routes by the starting table; `tests/ticket-router.test.mjs`'s shipped-table validity test passes on the starting table; nothing in the repository reads `fitted_commit`.
- *Blocked by:* S3, S4.

**S10. One cockpit view of the Fit.**
- *Scope:* the Cell evidence tab shows the tree of groups and each Cell with every candidate's verdict and range, burn-in progress (merged PRs per Cell against 20), what each group is exploring, the Cells the guard has tripped, the model-change notice and a failed-Fit flag; the two-sided policy rows, `behindMain`, the consumer footnote, the checkout-table read and the Preview-fit reader retire.
- *Acceptance:* the tab reads `.fleet/router-fit.json` and the guard only; a failed Fit shows the flag and the last good Fit's rows; a consumer sees no sentence that its runs reach routing "only through its cost guard"; the card tests and the tab's tests are green.
- *Blocked by:* S3, S5.

**S11. Amend the specs the design supersedes.**
- *Scope:* notes under the changed text in the router spec (R2–R6, § 5) and the cockpit tabs spec (§ 4–§ 5), and in `docs/components/tier-routing.md`, each pointing here.
- *Acceptance:* every sentence this spec supersedes carries a note naming it; no sentence still says the table changes only through a reviewed PR.
- *Blocked by:* S9, S10.

**Blocked-by order**

| Slice | Blocked by |
|---|---|
| S1 | — |
| S2 | — |
| S3 | S1 |
| S4 | S1 |
| S5 | S1, S2, S4 |
| S6 | S1 (and #4159 for the version cut) |
| S7 | S3, S5, S6 |
| S8 | — |
| S9 | S3, S4 |
| S10 | S3, S5 |
| S11 | S9, S10 |
