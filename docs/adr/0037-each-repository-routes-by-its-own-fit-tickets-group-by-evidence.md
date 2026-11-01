# 0037 — Each repository routes by its own Fit: tickets group onto Cells by evidence, and the shipped table is only the starting table

**Status:** Accepted. Ruled 2026-11-01 on map #4118 ("A self-refining grouping of tickets onto Cells, learned from each repository's own evidence"), by the maintainer in grilling sessions, across #4122, #4124, #4126, #4129, #4157, #4158, #4161, #4162, #4163, #4165, #4170 and #4173, against the measurements in `docs/research/` (draft PR #4172). Amends ADR 0016 (see its Status line) and ADR 0013 § 6's exploration draw. Two parts reopen on a word, as the tickets say: the clean start (#4124, ruled by an agent while the maintainer was away, from the maintainer's stated expectation) and the pair "a Cell that exploration adds does not re-enter burn-in / ADR 0016's two stages and uniform draw are dropped" (#4161). The design is `docs/specs/2026-11-01-self-refining-router-design.md`.

## Context

ADR 0016 ruled that the router's table "changes only through a reviewed PR whose diff is the table and its estimates", fitted offline on this repository's runs; that routing granularity is a `light|heavy|unknown` stratum from a fixed rule; and that burn-in runs in two stages over a table's Cells. Three things measured on map #4118 break that:

- **A consumer has no Fit.** The only Fit that replaces a table runs in this repository's repo-local hook, which is not shipped. A consumer routes by this repository's table, installed beside the scripts: its first run routes every Pull at `slow-high`, and afterwards it draws over this repository's Cells and never leaves burn-in, because only a Fit changes `burn_in`. The maintainer's expectation was the opposite: "the consumer starts fleet-ctl in a new repo and it tries out different roles and efforts in order to get evidence about how they perform. this evidence then should be used to select the best role+effort for the two targets cost or speed."
- **Light and heavy do not matter here.** At 268 Pulls every light, heavy and `*` row is `task-high` under both Objectives, and the best one-input and two-input groupings of 19 candidate inputs gain $0.00 and $0.08 per merged PR in sample, against shuffled-null 95th percentiles of $0.22 and $0.60 (`docs/research/stratum-split.md`, `docs/research/router-inputs.md`). The maintainer: "I doubt that the light and heavy split will suffice."
- **A Fit is cheap and a gate can be measured.** A Fit takes 39–209 ms (`docs/research/fit-cadence.md`), and the random draws already logged let a split be scored off-policy (`docs/research/self-refining-routing.md`, `docs/research/split-gate.md`).

## Decision

1. **Every repository routes by its own Fit, and this repository is one more consumer.** The Fit is the Router's table recomputed from the repository's own records. It is computed at every phase 0, kept in `.fleet/` beside the cost guard and never committed, and records the blob id of each metrics file and the guard it read, so it can be recomputed. It routes that run; each close-out's evidence routes the next. A run whose Fit is missing or fails routes by the last Fit that computed, else by the starting table: a failed Fit costs one run of staleness, never a switch to the dearest Cell.
2. **The shipped `router-table.json` is only the starting table:** one group, the three models at `high`, every row `slow-high`, no estimates, in burn-in. It changes only when the starting point itself changes, never by a Fit or a re-fit PR. The hook's re-fit duty, CI's check of the shipped table and the re-fit PR's human stop retire. A clean start: nothing from this repository routes, excludes or seeds anything at a consumer; run 1 is all `slow-high`.
3. **Groups are a tree of readable splits on dispatch-time inputs, learned from the repository's own Pulls.** It starts as one group. A split stands only when it passes both a shuffled-null test and an off-policy lower bound, to depth 2 at most, with at least 20 merged PRs per candidate Cell on each side, after two consecutive Fits on the same input or inputs; it merges back on one failure; every Fit re-judges every split. One grouping, split on cost, serves both Objectives; each group keeps a `cost` row and a `speed` row, and the quality floor applies per row. The **Stratum** is that group, learned, not a fixed rule. A parametric ticket→Cell model stays rejected (ADR 0016 decision 2).
4. **Evidence:** every Pull counts, weighted by its known assignment probability; two Cells are compared only over the stretches in which both were drawn, then pooled; each Cell is judged on its newest generation.
5. **Each group explores at one Pull in five,** drawing over its Cell with one effort level up and down, the bigger model one level lower and the smaller model one level higher. Burn-in covers the three models at `high`; ADR 0016's two stages and its uniform draw over every Cell retire, and a Cell that exploration adds does not re-enter burn-in.
6. **The stopping rule retires.** Each repository excludes a failing Cell on its own evidence alone: its cost guard, each row's quality floor and its groups' exploration moving on. A Cell's definition leaves the plugin only through an ordinary change. The cockpit shows the Cells a guard has tripped.
7. **The cockpit's Cell evidence tab is one view of the Fit that routes.**
8. **Every record the learning rests on is committed** (#4158 → #4159, #4165 → #4175, #4176), so no run's learnings are lost; the Close-out PR stays an Inert diff.

## Rejected alternatives

- **A Fit every 50 merged PRs, committed as a per-repository table** (#4126): it would add the table's path to the Inert data set, and only a Fit moves `burn_in`, so a consumer at 10 Pulls a week could wait about 5 weeks after its Cells reach 20 merged PRs for burn-in to end [INFERENCE, `docs/research/fit-cadence.md`]. **A phase-0 Fit with hysteresis**: never measured.
- **Two mechanisms** (#4122): this repository fitting the shipped table through reviewed PRs while every consumer fits its own. One path to keep, and a consumer's bug shows here first.
- **Routing by this repository's rows, or excluding a Cell this repository tripped, until a consumer's Fit can judge** (#4124): it routes one repository's record at another.
- **A learned model judged only by its outcomes** (#4157): coefficients at 268 Pulls, 1.8–8.9 Pulls each, cannot be diffed.
- **Keeping the light/heavy constants** (#4123, withdrawn), **a per-repository threshold computed by the Fit** (new machinery with no measured routing effect).
- **Cumulative pooling, a rolling window, exponential decay** (#4163): drift that hits every Cell at once does not cancel.
- **The shuffled null alone, a holdout gate, counting only exploring Pulls, a grouping per Objective, a split standing on its first pass** (#4161, #4170): the first splits by chance up to 5–7% at depth 2 alone; counting only exploring Pulls takes 2.5–2.8 times the Pulls.
- **Withdrawing a Cell from the plugin on one repository's record, or a stopping rule per repository** (#4129).
- **Keeping two sides, "routes now" and "evidence favours", in the cockpit** (#4173): they no longer differ.
- **Always routing by the starting table, or by `slow-high` only, when a Fit fails** (#4162).
- **Paid inputs and cross-repository pooling** stay out of scope.

## Consequences

- `docs/specs/2026-11-01-self-refining-router-design.md` carries the design, what retires with file and line, the measured basis, the limits and the slices.
- **What this repository learns routes at once.** Today a re-fit reaches routing only after a merged PR, a release and an install; the Fit is computed in each repository's own `.fleet/`.
- A small repository routes by one group for a long time: a split worth 6.5% is found by about 544 Pulls with the weights, about a year at 10 Pulls a week [INFERENCE: 544 ÷ 10], and the first stage of burn-in alone takes about 10 weeks. That is what a gate that fires only when it beats the null costs.
- A Fit at every run adopts a not-cheaper Cell at some run in 20.4% of no-effect histories, against 5.6% at the old cadence; both end at 5.6%. A false pick is about as dear as `slow-high` and above the quality floor.
- Every Cell the grid can reach needs a definition file, and exploration costs Pulls: about 100 × k Pulls for k candidates to reach 20 merged PRs each.
- `CONTEXT.md` gains **Starting table** and **Fit**, and **Router**, **Stratum**, **Exploration Pull**, **Exploration draw**, **Cell evidence** and **Quality floor** are reworded; **Preview fit** retires into **Fit**.
