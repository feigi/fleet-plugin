# Which ticket inputs change which Cell wins? (issue #4150)

Research note for the Router's self-refining clustering (map #4118). It measures; it rules on nothing.

## Question

Which inputs known before dispatch change which Cell is cheapest or fastest for a ticket, or how often a Cell fails? The inputs are the nine recorded ticket metrics (`issueMetrics`, `plugin/scripts/ticket-router.mjs:113-131`) and whatever the issue text offers for free. And how much would routing by the best grouping on those inputs gain over sending every ticket to one Cell?

## Method, source and reproduction

Every table and quoted line below is printed by `docs/research/router-inputs-derive.mjs` and pasted here unedited from its stdout; the prose around them is hand-written, and the counts it states were read off those tables. The script imports the Router's own modules from the checkout it sits in:

- **Pull set**: `attribute({ features, members, tiers: verdicts, windowStart: "2026-10-03", stratum: ruleStratum })` (`pull-attribution.mjs:301`) over `docs/metrics/{ticket-features,member-outcomes,tier-outcomes}.tsv`, filtered to `exploration_draw !== "" || sizing_src === "rule"` — exactly `fitPulls`, `ticket-router.mjs:382-385`.
- **Per-Cell Pulls**: `tally(units, generations(all)).pulls`, the newest generation of each Cell, status `counted`.
- **Bootstrap and floor**: `bootUnit`, `bootstrapDiffCI` (the script's own generic bootstrap reproduces `bootstrapDiffCI` to the digit on the top-level `$` gap, and says so), and `underFloor` with `TRIP_POINTS = 15`.
- **Issue text**: `gh issue view <n> --json number,title,body,labels,comments,createdAt,updatedAt,state` for each of the 267 distinct tickets, cached outside the repository (default `<tmpdir>/router-inputs-cache`; the script refuses a cache inside the repo). `briefText` / `briefPaths` (`plugin/scripts/ticket-text.mjs`) run on it.
- **Measured at** `origin/main` `24d29a4e` (2026-11-01), which is newer than the `e5040b9a` the ticket quotes. The per-Cell figures are identical to the ticket's (§ 0).

Reproduce: `node docs/research/router-inputs-derive.mjs` (Node ≥ 18; about 20 s; deterministic for a fixed cache — two runs diff-identical; `--perms`, `--cv-null`, `--seed`, `--cache` documented in its header). Seeds: bootstrap seed 1/2/3 for $/minutes/fail as `bootstrapDiffCI`'s default; permutations and folds from `--seed 20261101`.

Conventions. $ and minutes are per merged PR, `Σ/Σ merged`, as the Fit computes them (every counted Pull merged, so they equal the Pull mean). Fail = `falseClaims / claims` (`tally`'s `failed / claims`). Gap = (task-high − slow-high), so negative favours task-high. A bootstrap range is 95%, 2000 resamples; `*` means it excludes 0. A numeric input is split at the median of the Pulls in the pool being split (`>` median vs `≤` median); `kind` is each category against the rest; `parent` by presence; the free inputs are booleans.

## 0. The Pull set

| Cell | Model | n | failed | $/Pull mean (sd) | min/Pull mean (sd) | $/merged | min/merged |
|---|---|---|---|---|---|---|---|
| slow-high | claude-opus-5-5 | 104 | 20 | 14.51 (10.06) | 121.3 (66.9) | 14.51 | 121.3 |
| smol-high | claude-haiku-5-5 | 32 | 18 | 11.06 (7.04) | 110.3 (51.8) | 11.06 | 110.3 |
| task-high | claude-sonnet-5-5 | 104 | 28 | 10.28 (6.16) | 102.9 (46.5) | 10.28 | 102.9 |

Merged: 240 of 240 counted newest-generation Pulls.

Pulls in the Fit's set by status and generation (older generation, excluded, unpriced Pulls are not in the rows above):

| Cell | generation | status | Pulls |
|---|---|---|---|
| slow-high | claude-opus-5-5 | counted | 104 |
| smol-high | (none) | excluded | 5 |
| smol-high | claude-haiku-4-5 | counted | 21 |
| smol-high | claude-haiku-5-5 | counted | 32 |
| smol-high | claude-haiku-5-5 | unpriced | 1 |
| task-high | (none) | excluded | 1 |
| task-high | claude-sonnet-5-5 | counted | 104 |

Distinct tickets: 267 of 268 Pulls (ticket 3545 has two Pulls).

### Rescues (an implementer row whose subagent_type is not `fleet-implementer-<chosen_cell>`)

15 of 268 Fit Pulls carry one; 4 of 240 counted newest-generation Pulls. By drawn Cell (counted newest-gen): slow-high 0/104, task-high 1/104, smol-high 3/32.

| drawn Cell -> implementer row's subagent_type | rows |
|---|---|
| smol-high -> fleet-implementer-slow-high | 12 |
| smol-high -> fleet-implementer-task-high | 1 |
| task-high -> fleet-implementer-slow-high | 2 |

The ticket's per-Cell table (n 104 / 104 / 32; failed 20 / 28 / 18; $/Pull 14.51 / 10.28 / 11.06 and minutes 121.3 / 102.9 / 110.3, with their sds) reproduces exactly at `24d29a4e`. Of the 268 Pulls, 240 are counted newest-generation; the other 28 are 21 Pulls of smol-high's older generation (claude-haiku-4-5), 6 with no admissible implementer row (5 smol-high, 1 task-high; status `excluded`) and 1 unpriced. The exclusion is decided after the draw, from what the implementer did, so it can depend on the outcome.

## 1. Randomization check, and where the comparison stops being randomized

### What the draw hashes

`drawCell` (ledger-grammar.mjs:832-838) hashes `sha256("<session>\t<ticket>")`, takes its first 8 hex digits mod K and indexes the sorted Cell list; no feature is read. The Router calls it at ticket-router.mjs:336 with `policyCell: null` and `cells` = the table's Cells less the guard's tripped ones (rowDispatch, :213-226). K is therefore 3 while smol-high is untripped and 2 after.

Recomputing `drawCell({session, ticket, policyCell: null, cells})` over the draw set implied by each Pull's recorded K reproduces the recorded Cell and `k/K` on 265 of 268 Pulls. The misses are tickets 3375, 3378, 3384, all in session 2026-10-17T06-37. [INFERENCE] those Pulls were routed under a session string other than the row's recorded one; the recorded Cell is used as drawn.

Draw sets by period (K from the recorded `exploration_draw`); sessions are omp session ids, which open with their start time:

| period | draw set | Pulls | first session | last session | smol-high drawn | slow-high | task-high |
|---|---|---|---|---|---|---|---|
| A (K=3) | slow, smol, task | 170 | 2026-10-11T10-19 | 2026-10-25T09-45 | 59 | 50 | 61 |
| B (K=2) | slow, task | 98 | 2026-10-22T08-03 | 2026-10-30T08-34 | 0 | 54 | 44 |

smol-high draws: first session 2026-10-11T10-52, last 2026-10-25T09-45. Its older generation claude-haiku-4-5 ran in sessions 2026-10-11T10-52 to 2026-10-17T06-37 (21 Pulls); the newest, claude-haiku-5-5, 2026-10-17T06-37 to 2026-10-25T09-45 (33 Pulls). The first period-B session (2026-10-22T08-03) starts before the last smol-high draw: sessions overlap, so the boundary used below is each Pull's recorded K, not a date.

Sub-period A2 = period A Pulls with session >= 2026-10-17T06-37 (the first claude-haiku-5-5 Pull): the only stretch in which all three newest-generation Cells were drawn. Every smol-high comparison below is restricted to A2.

### Independence of the drawn Cell from the inputs

Is the drawn Cell independent of the nine recorded inputs and of the free inputs? Statistic: Kruskal-Wallis H (numeric) or chi-square (categorical) of Cell against input, computed inside each period and summed; p = share of 2000 within-period shuffles of the Cell labels with a statistic at least as large (add-one). Run on (i) all 268 Pulls by drawn Cell and (ii) the counted newest-generation Pulls.

| input | (i) stat | (i) p | (ii) stat | (ii) p |
|---|---|---|---|---|
| brief_chars | 7.61 | 0.05 | 2.45 | 0.48 |
| criteria | 5.84 | 0.11 | 3.56 | 0.29 |
| comments | 1.16 | 0.72 | 2.77 | 0.37 |
| age_days | 0.70 | 0.83 | 0.70 | 0.84 |
| paths | 3.65 | 0.30 | 4.06 | 0.26 |
| test_paths | 2.51 | 0.43 | 2.08 | 0.53 |
| xrefs | 2.06 | 0.55 | 1.85 | 0.61 |
| kind | 6.81 | 0.59 | 6.92 | 0.57 |
| parent | 3.09 | 0.39 | 6.39 | 0.10 |
| names_md | 3.60 | 0.32 | 4.64 | 0.20 |
| names_code | 0.25 | 0.97 | 0.47 | 0.94 |
| names_sh | 0.84 | 0.85 | 2.17 | 0.54 |
| names_data | 2.91 | 0.40 | 2.29 | 0.54 |
| names_dir | 1.78 | 0.62 | 1.14 | 0.75 |
| names_test | 4.74 | 0.20 | 5.74 | 0.12 |
| prose_only | 1.15 | 0.54 | 1.85 | 0.58 |
| code_blocks_any | 1.45 | 0.73 | 2.07 | 0.58 |
| extra_labels_any | 2.59 | 0.53 | 4.09 | 0.24 |
| brief_in_comment | 2.95 | 0.40 | 3.36 | 0.35 |

19 inputs tested; 0 of 19 with p < 0.05 in (i) (about 1.0 expected by chance), 0 of 19 in (ii). Smallest p: (i) 0.05, (ii) 0.10; Bonferroni threshold 0.0026.

Recorded-input medians by drawn Cell (all 268 Pulls; the counted newest-generation Pulls give the same picture, see (ii) above):

| input | slow-high | task-high | smol-high |
|---|---|---|---|
| brief_chars | 4223.5 | 3869.0 | 3158.0 |
| criteria | 5.0 | 5.0 | 3.0 |
| comments | 1.0 | 1.0 | 1.0 |
| age_days | 0.0 | 1.0 | 0.0 |
| paths | 6.0 | 8.0 | 7.0 |
| test_paths | 1.0 | 0.0 | 0.0 |
| xrefs | 2.0 | 2.0 | 1.0 |
| kind=bug (n) | 47 | 46 | 22 |
| kind=enhancement (n) | 50 | 43 | 28 |
| kind=documentation (n) | 0 | 4 | 2 |
| kind=(none) (n) | 7 | 12 | 7 |
| parent present (n) | 6 | 14 | 10 |
| Pulls | 104 | 105 | 59 |

Reading. The draw is a function of `session` and `ticket` only (`ledger-grammar.mjs:836`); none of the 19 inputs tested (9 recorded, 10 free) separates the Cells at 5% within period on either Pull set, which is what the construction predicts. The three Pulls the hash does not reproduce are one session's, and their draws are taken as recorded.

### Correction to "the record is a randomized comparison"

The record is a randomized comparison between slow-high and task-high within a draw-set period, as routed. It is not one beyond that, for five measured reasons:

1. **The draw set changed mid-window.** K = 3 (slow, smol, task) for 170 Pulls, K = 2 (slow, task) for 98. smol-high's last draw is session `2026-10-25T09-45`; the first K = 2 session is `2026-10-22T08-03`, so sessions overlap and the boundary used here is each Pull's recorded K. smol-high exists only in period A, and its newest generation (claude-haiku-5-5) only from session `2026-10-17T06-37` on. So smol-high versus anything else is confounded with time and ticket mix unless restricted to A2 (period A from that session), the only stretch in which all three newest-generation Cells were drawn. Every smol-high comparison below is restricted to A2.
2. **slow-high versus task-high is balanced within each period but not between them** (A: slow 50, task 60; B: slow 54, task 44), and the periods differ in outcome: slow-high's fail rate is 26.0% in A and 13.0% in B, task-high's 31.7% and 20.5% (§ 2.0). The pooled slow/task comparison is unbiased only because both Cells draw from the same tickets in each period; the period-stratified gaps in § 2 check that and agree with the pooled ones.
3. **Rescues are booked to the drawn Cell.** A Pull whose implementer failed can be rescued at another Cell, and the Fit books the whole Pull, merge and cost, to the drawn Cell (#3675). Every figure here is as routed (intent-to-treat), as the Fit does. A "Cell" in this note is therefore a drawn Cell plus whatever rescue followed. The drop-the-rescued sensitivity is § 4.
4. **Post-draw exclusion.** The generation filter removes 6 Pulls by what the implementer did (§ 0), and 21 more by the older generation.
5. **One ticket (3545) has two Pulls**, and 3 draws do not reproduce from the hash (§ 1): the Pulls are not strictly independent draws of the ticket mix.

## 2. Recorded inputs: per-Cell figures, gaps and interactions

The Fit books a whole Pull to the Cell it drew, whatever rescued it (#3675); this section does the same. Pool = every counted newest-generation slow-high and task-high Pull, periods A and B together (both Cells are drawn in both periods at equal odds, so period does not bias their gap; the period-stratified table checks that).

### 2.0 By draw-set period

| period | Cell | n | $/merged | min/merged | failed/claims | task-high - slow-high $ [range] | min [range] |
|---|---|---|---|---|---|---|---|
| A (K=3) | slow-high | 50 | 14.16 | 108.2 | 13/50 (26.0%) |  |  |
|  | task-high | 60 | 10.47 | 94.7 | 19/60 (31.7%) | -3.69 [-6.72, -0.72] | -13.5 [-34.4, 4.7] |
|  | smol-high | 32 | 11.06 | 110.3 | 18/32 (56.3%) |  |  |
| A2 (K=3, from first haiku-5-5 session) | slow-high | 32 | 14.55 | 112.9 | 9/32 (28.1%) |  |  |
|  | task-high | 39 | 9.06 | 90.8 | 10/39 (25.6%) | -5.49 [-9.49, -1.73] | -22.1 [-51.7, 1.2] |
|  | smol-high | 32 | 11.06 | 110.3 | 18/32 (56.3%) |  |  |
| B (K=2) | slow-high | 54 | 14.83 | 133.5 | 7/54 (13.0%) |  |  |
|  | task-high | 44 | 10.02 | 114.1 | 9/44 (20.5%) | -4.81 [-8.05, -1.66] | -19.4 [-44.5, 4.6] |

### 2.1 task-high − slow-high, every input, as routed

Pool: 208 Pulls (task-high 104, slow-high 104). Gap = task-high - slow-high; range = bootstrap 95% (2000 resamples, Pulls resampled within Cell and side, the Router's bootstrapDiffCI draw order); * = range excludes 0. $ and minutes are per merged PR; fail = false claims / claims, in %, and its gap in points. `MDE` = smallest gap 80%-powered at 5% two-sided from the measured per-Pull sd and n on that side (fail: binomial).

All Pulls: $ 10.28 vs 14.51, gap -4.23 [-6.51, -2.04] *; minutes 102.9 vs 121.3, gap -18.45 [-35.36, -3.10] *; fail 28/104 vs 20/104, gap +7.7 pts [-3.8, 19.2]. Router `bootstrapDiffCI` on the same $ units: [-6.51, -2.04] (identical to the generic bootstrap here). MDE (80% power, 5% two-sided) on these Pulls: $ 3.24, minutes 22.4, fail 16.3 pts.

| input | side | n task-high | n slow-high | $ task-high | $ slow-high | $ gap [range] | MDE $ | min task-high | min slow-high | min gap [range] | MDE min | fail task-high | fail slow-high | fail gap pts [range] |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| brief_chars | <= 4047.5 | 55 | 49 | 8.76 | 11.17 | -2.42 [-5.33, 0.46] | 4.10 | 94.5 | 104.1 | -9.5 [-26.7, 7.8] | 25.3 | 12/55 (21.8%) | 6/49 (12.2%) | +9.6 [-4.0, 24.1] |
| brief_chars | > 4047.5 | 49 | 55 | 11.99 | 17.47 | -5.49 [-8.68, -2.36] * | 4.56 | 112.2 | 136.7 | -24.5 [-48.8, -1.8] * | 34.5 | 16/49 (32.7%) | 14/55 (25.5%) | +7.2 [-10.1, 24.2] |
| criteria | <= 5 | 65 | 63 | 9.36 | 12.49 | -3.13 [-5.64, -0.41] * | 3.70 | 99.7 | 108.9 | -9.2 [-27.1, 8.1] | 24.6 | 16/65 (24.6%) | 10/63 (15.9%) | +8.7 [-5.3, 22.7] |
| criteria | > 5 | 39 | 41 | 11.81 | 17.60 | -5.79 [-9.80, -2.04] * | 5.66 | 108.2 | 140.4 | -32.3 [-62.2, -5.2] * | 41.2 | 12/39 (30.8%) | 10/41 (24.4%) | +6.4 [-13.5, 26.3] |
| comments | <= 1 | 72 | 76 | 9.87 | 14.13 | -4.27 [-7.26, -1.50] * | 3.98 | 102.3 | 118.1 | -15.8 [-36.2, 2.5] | 26.8 | 20/72 (27.8%) | 14/76 (18.4%) | +9.4 [-3.9, 22.9] |
| comments | > 1 | 32 | 28 | 11.21 | 15.52 | -4.32 [-8.14, -0.68] * | 5.38 | 104.2 | 130.0 | -25.8 [-55.8, 3.2] | 41.3 | 8/32 (25.0%) | 6/28 (21.4%) | +3.6 [-19.2, 24.1] |
| age_days | <= 0 | 50 | 60 | 8.17 | 12.80 | -4.62 [-7.36, -1.84] * | 3.98 | 93.8 | 116.8 | -23.0 [-45.3, -1.9] * | 31.1 | 11/50 (22.0%) | 12/60 (20.0%) | +2.0 [-13.3, 17.7] |
| age_days | > 0 | 54 | 44 | 12.23 | 16.84 | -4.61 [-8.24, -1.26] * | 5.03 | 111.3 | 127.6 | -16.2 [-38.4, 5.3] | 32.0 | 17/54 (31.5%) | 8/44 (18.2%) | +13.3 [-5.1, 30.2] |
| paths | <= 7 | 48 | 61 | 8.41 | 12.69 | -4.28 [-7.66, -1.31] * | 4.55 | 90.0 | 113.9 | -24.0 [-45.4, -3.4] * | 30.1 | 10/48 (20.8%) | 8/61 (13.1%) | +7.7 [-6.0, 22.6] |
| paths | > 7 | 56 | 43 | 11.88 | 17.08 | -5.21 [-8.00, -2.28] * | 4.10 | 114.0 | 131.9 | -17.9 [-41.6, 4.4] | 33.6 | 18/56 (32.1%) | 12/43 (27.9%) | +4.2 [-12.9, 22.5] |
| test_paths | <= 1 | 69 | 76 | 9.47 | 14.77 | -5.30 [-8.19, -2.66] * | 3.98 | 95.9 | 123.4 | -27.5 [-45.3, -9.6] * | 26.0 | 17/69 (24.6%) | 16/76 (21.1%) | +3.6 [-10.4, 17.0] |
| test_paths | > 1 | 35 | 28 | 11.87 | 13.79 | -1.92 [-5.54, 1.71] | 5.31 | 116.6 | 115.6 | +1.0 [-27.6, 28.4] | 42.4 | 11/35 (31.4%) | 4/28 (14.3%) | +17.1 [-3.6, 37.1] |
| xrefs | <= 2 | 65 | 66 | 8.91 | 12.30 | -3.39 [-6.16, -0.84] * | 3.73 | 100.1 | 116.5 | -16.4 [-37.8, 3.4] | 30.0 | 12/65 (18.5%) | 12/66 (18.2%) | +0.3 [-13.4, 12.5] |
| xrefs | > 2 | 39 | 38 | 12.55 | 18.33 | -5.77 [-9.95, -2.27] * | 5.54 | 107.6 | 129.8 | -22.2 [-46.4, -0.8] * | 32.3 | 16/39 (41.0%) | 8/38 (21.1%) | +20.0 [-0.8, 40.6] |
| kind | not bug | 58 | 57 | 12.00 | 17.47 | -5.47 [-8.86, -2.32] * | 4.61 | 103.8 | 129.3 | -25.5 [-48.1, -5.0] * | 30.5 | 20/58 (34.5%) | 11/57 (19.3%) | +15.2 [-0.5, 30.9] |
| kind | = bug | 46 | 47 | 8.11 | 10.91 | -2.80 [-5.57, -0.20] * | 3.87 | 101.8 | 111.7 | -9.9 [-33.4, 12.5] | 32.8 | 8/46 (17.4%) | 9/47 (19.1%) | -1.8 [-16.9, 15.3] |
| kind | not enhancement | 62 | 54 | 8.78 | 10.92 | -2.13 [-4.75, 0.34] | 3.53 | 102.0 | 107.5 | -5.5 [-26.9, 14.1] | 28.9 | 14/62 (22.6%) | 9/54 (16.7%) | +5.9 [-9.1, 19.8] |
| kind | = enhancement | 42 | 50 | 12.49 | 18.38 | -5.90 [-9.79, -2.30] * | 5.18 | 104.2 | 136.2 | -32.0 [-56.0, -9.7] * | 34.1 | 14/42 (33.3%) | 11/50 (22.0%) | +11.3 [-7.0, 29.7] |
| kind | not documentation | 100 | 104 | 10.24 | 14.51 | -4.27 [-6.50, -1.96] * | 3.25 | 102.7 | 121.3 | -18.7 [-34.0, -3.4] * | 22.7 | 26/100 (26.0%) | 20/104 (19.2%) | +6.8 [-4.9, 17.7] |
| kind | = documentation | 4 | 0 | 11.22 | - | - | - | 108.5 | - | - | - | 2/4 (50.0%) | 0/0 (-%) | - |
| kind | not (none) | 92 | 97 | 10.24 | 14.76 | -4.52 [-6.90, -2.17] * | 3.44 | 103.2 | 124.3 | -21.2 [-37.7, -5.1] * | 23.5 | 24/92 (26.1%) | 20/97 (20.6%) | +5.5 [-6.2, 18.0] |
| kind | = (none) | 12 | 7 | 10.54 | 10.94 | -0.40 [-5.24, 4.19] | 7.39 | 100.7 | 79.7 | +21.1 [-12.7, 56.0] | 53.9 | 4/12 (33.3%) | 0/7 (0.0%) | +33.3 [8.3, 58.3] * |
| parent | no parent | 90 | 98 | 9.16 | 14.11 | -4.95 [-7.20, -2.65] * | 3.30 | 98.8 | 121.2 | -22.4 [-38.7, -5.9] * | 23.4 | 21/90 (23.3%) | 18/98 (18.4%) | +5.0 [-6.5, 16.6] |
| parent | Slice (parent) | 14 | 6 | 17.44 | 20.99 | -3.55 [-8.02, 1.30] | 7.06 | 129.2 | 124.1 | +5.1 [-31.4, 41.8] | 54.1 | 7/14 (50.0%) | 2/6 (33.3%) | +16.7 [-31.0, 61.9] |
| names_md | no | 39 | 51 | 9.46 | 13.13 | -3.68 [-7.05, -0.31] * | 4.92 | 102.0 | 118.5 | -16.5 [-40.3, 7.2] | 34.7 | 10/39 (25.6%) | 9/51 (17.6%) | +8.0 [-9.4, 24.7] |
| names_md | yes | 65 | 53 | 10.77 | 15.83 | -5.06 [-8.07, -2.18] * | 4.21 | 103.4 | 124.0 | -20.6 [-43.5, -1.1] * | 30.9 | 18/65 (27.7%) | 11/53 (20.8%) | +6.9 [-8.3, 22.7] |
| names_code | no | 22 | 20 | 8.38 | 13.24 | -4.86 [-12.34, 1.14] | 9.73 | 95.4 | 120.5 | -25.1 [-58.5, 5.0] | 47.9 | 4/22 (18.2%) | 4/20 (20.0%) | -1.8 [-25.9, 21.8] |
| names_code | yes | 82 | 84 | 10.79 | 14.81 | -4.02 [-6.43, -1.70] * | 3.29 | 104.9 | 121.5 | -16.7 [-35.4, 0.9] | 25.4 | 24/82 (29.3%) | 16/84 (19.0%) | +10.2 [-2.9, 23.5] |
| names_sh | no | 85 | 81 | 9.90 | 14.03 | -4.13 [-6.73, -1.61] * | 3.67 | 102.5 | 116.3 | -13.7 [-30.3, 3.1] | 24.0 | 20/85 (23.5%) | 12/81 (14.8%) | +8.7 [-2.4, 20.8] |
| names_sh | yes | 19 | 23 | 11.97 | 16.18 | -4.21 [-9.05, 0.55] | 6.92 | 104.4 | 139.2 | -34.8 [-75.2, 1.4] | 55.1 | 8/19 (42.1%) | 8/23 (34.8%) | +7.3 [-21.5, 36.2] |
| names_data | no | 71 | 64 | 9.26 | 12.68 | -3.41 [-6.26, -0.79] * | 3.86 | 101.6 | 118.8 | -17.2 [-39.7, 3.8] | 30.6 | 18/71 (25.4%) | 12/64 (18.8%) | +6.6 [-8.1, 20.4] |
| names_data | yes | 33 | 40 | 12.46 | 17.43 | -4.97 [-8.81, -1.28] * | 5.49 | 105.6 | 125.5 | -19.8 [-41.2, 1.6] | 31.1 | 10/33 (30.3%) | 8/40 (20.0%) | +10.3 [-8.8, 31.0] |
| names_dir | no | 41 | 42 | 9.55 | 11.47 | -1.93 [-4.76, 0.79] | 4.12 | 101.6 | 113.2 | -11.6 [-34.3, 11.1] | 32.8 | 11/41 (26.8%) | 4/42 (9.5%) | +17.3 [2.7, 34.3] * |
| names_dir | yes | 63 | 62 | 10.75 | 16.56 | -5.81 [-8.92, -2.62] * | 4.54 | 103.7 | 126.9 | -23.2 [-44.7, -2.9] * | 30.4 | 17/63 (27.0%) | 16/62 (25.8%) | +1.2 [-14.8, 17.1] |
| names_test | no | 54 | 47 | 9.58 | 14.08 | -4.51 [-8.43, -1.18] * | 5.10 | 95.9 | 121.8 | -25.8 [-46.7, -5.7] * | 29.5 | 14/54 (25.9%) | 10/47 (21.3%) | +4.6 [-11.3, 20.6] |
| names_test | yes | 50 | 57 | 11.03 | 14.85 | -3.82 [-6.81, -0.85] * | 4.22 | 110.4 | 121.0 | -10.6 [-35.0, 11.6] | 33.3 | 14/50 (28.0%) | 10/57 (17.5%) | +10.5 [-5.1, 26.5] |
| prose_only (true) | - | side empty | | | | | | | | | | | | |
| code_blocks_any | no | 98 | 100 | 10.29 | 14.30 | -4.01 [-6.36, -1.78] * | 3.33 | 103.5 | 120.8 | -17.3 [-33.7, -1.9] * | 23.2 | 28/98 (28.6%) | 19/100 (19.0%) | +9.6 [-1.6, 21.7] |
| code_blocks_any | yes | 6 | 4 | 10.06 | 19.60 | -9.55 [-18.36, 1.27] | 15.68 | 93.2 | 134.5 | -41.3 [-91.4, 13.7] | 85.9 | 0/6 (0.0%) | 1/4 (25.0%) | -25.0 [-75.0, 0.0] |
| extra_labels_any | no | 99 | 102 | 9.83 | 14.41 | -4.58 [-6.90, -2.36] * | 3.24 | 101.5 | 121.2 | -19.7 [-36.4, -3.8] * | 22.9 | 25/99 (25.3%) | 20/102 (19.6%) | +5.6 [-6.3, 16.7] |
| extra_labels_any | yes | 5 | 2 | 19.22 | 19.45 | -0.22 [-7.42, 7.03] | 13.37 | 130.2 | 126.8 | +3.4 [-45.2, 52.0] | 97.5 | 3/5 (60.0%) | 0/2 (0.0%) | +60.0 [20.0, 100.0] * |
| brief_in_comment | no | 30 | 21 | 14.22 | 20.32 | -6.09 [-9.62, -2.61] * | 5.13 | 111.4 | 127.5 | -16.2 [-36.4, 4.2] | 29.3 | 14/30 (46.7%) | 5/21 (23.8%) | +22.9 [-3.3, 47.6] |
| brief_in_comment | yes | 74 | 83 | 8.68 | 13.04 | -4.36 [-7.01, -1.79] * | 3.64 | 99.4 | 119.8 | -20.3 [-40.4, -1.2] * | 27.2 | 14/74 (18.9%) | 15/83 (18.1%) | +0.8 [-11.5, 13.3] |

Counting the 41 sides on which both Cells are present (documentation has no slow-high Pull; `prose_only` has one Pull in all): task-high is cheaper per merged PR than slow-high on **41 of 41** sides, with a range excluding 0 on 31; it is faster on 37 of 41 (17 exclude 0); and it fails more often on 38 of 41, with a range excluding 0 on 3 (`kind` none, `names_dir` no, `extra_labels_any` yes: n = 12/7, 41/42 and 5/2 Pulls of the two Cells). The pooled gap is −4.23 [−6.51, −2.04] $ and −18.45 [−35.36, −3.10] minutes; the fail gap is +7.7 [−3.8, 19.2] points.

### 2.2 Interactions: does the gap differ between sides?

Interaction = (gap on the `yes`/high/in-category side) - (gap on the other side), task-high - slow-high; range = bootstrap 95% of the four groups resampled independently. A range excluding 0 means the gap differs between sides. n = [side1 task-high, side1 slow-high, side2 task-high, side2 slow-high].

| input | cut | n | $ interaction [range] | MDE $ | min interaction [range] | MDE min | fail interaction pts [range] | MDE fail pts |
|---|---|---|---|---|---|---|---|---|
| brief_chars | > 4047.5 | 49/55/55/49 | -3.07 [-7.32, 1.09] | 6.13 | -14.95 [-45.03, 14.36] | 42.81 | -2.4 [-24.4, 19.2] | 32.2 |
| criteria | > 5 | 39/41/65/63 | -2.66 [-7.51, 1.90] | 6.77 | -23.11 [-55.90, 10.30] | 47.96 | -2.4 [-27.0, 22.3] | 34.2 |
| comments | > 1 | 32/28/72/76 | -0.05 [-4.35, 4.48] | 6.70 | -9.95 [-43.45, 23.71] | 49.21 | -5.8 [-31.8, 19.9] | 36.1 |
| age_days | > 0 | 54/44/50/60 | +0.01 [-4.52, 4.44] | 6.42 | +6.80 [-24.73, 39.80] | 44.60 | +11.3 [-11.2, 32.8] | 32.5 |
| paths | > 7 | 56/43/48/61 | -0.93 [-5.07, 3.51] | 6.13 | +6.06 [-21.73, 36.49] | 45.10 | -3.5 [-27.0, 19.9] | 33.0 |
| test_paths | > 1 | 35/28/69/76 | +3.38 [-1.00, 7.76] | 6.64 | +28.59 [-8.67, 60.19] | 49.69 | +13.6 [-9.5, 37.6] | 34.8 |
| xrefs | > 2 | 39/38/65/66 | -2.38 [-7.19, 2.15] | 6.68 | -5.86 [-35.50, 26.12] | 44.12 | +19.7 [-3.6, 44.9] | 34.5 |
| kind | = bug | 46/47/58/57 | +2.67 [-1.57, 6.79] | 6.02 | +15.59 [-15.76, 47.32] | 44.82 | -16.9 [-39.8, 5.2] | 32.0 |
| kind | = enhancement | 42/50/62/54 | -3.76 [-7.98, 0.72] | 6.27 | -26.50 [-57.81, 5.04] | 44.73 | +5.4 [-19.3, 29.9] | 33.3 |
| kind | = documentation | 4/0/100/104 | not estimable: a Cell is absent on a side | | | | | |
| kind | = (none) | 12/7/92/97 | +4.12 [-1.28, 9.26] | 8.16 | +42.23 [4.02, 80.42] * | 58.75 | +27.9 [0.7, 57.2] * | 41.8 |
| parent | has parent | 14/6/90/98 | +1.40 [-3.71, 6.47] | 7.80 | +27.47 [-9.89, 65.73] | 58.93 | +11.7 [-37.0, 58.1] | 67.7 |
| names_md | true | 65/53/39/51 | -1.38 [-5.66, 3.11] | 6.47 | -4.09 [-35.80, 25.65] | 46.45 | -1.1 [-23.7, 21.2] | 33.1 |
| names_code | true | 82/84/22/20 | +0.84 [-5.40, 8.45] | 10.27 | +8.41 [-27.20, 45.23] | 54.23 | +12.0 [-13.8, 38.7] | 38.7 |
| names_sh | true | 19/23/85/81 | -0.09 [-5.46, 5.56] | 7.84 | -21.08 [-62.15, 18.42] | 60.09 | -1.4 [-34.6, 31.4] | 45.5 |
| names_data | true | 33/40/71/64 | -1.56 [-6.25, 3.01] | 6.71 | -2.67 [-31.08, 28.69] | 43.63 | +3.7 [-21.0, 28.5] | 34.8 |
| names_dir | true | 63/62/41/42 | -3.88 [-8.17, 0.50] | 6.13 | -11.58 [-43.21, 16.42] | 44.70 | -16.1 [-37.9, 6.3] | 32.0 |
| names_test | true | 50/57/54/47 | +0.68 [-3.77, 5.20] | 6.62 | +15.26 [-14.56, 45.60] | 44.50 | +5.8 [-17.3, 28.3] | 32.8 |
| code_blocks_any | true | 6/4/98/100 | -5.54 [-14.25, 4.99] | 16.03 | -23.97 [-74.78, 35.76] | 88.94 | -34.6 [-83.5, -0.5] * | 63.0 |
| extra_labels_any | true | 5/2/99/102 | +4.36 [-3.78, 12.55] | 13.75 | +23.11 [-27.69, 73.35] | 100.18 | +54.4 [8.5, 97.3] * | 63.5 |
| brief_in_comment | true | 74/83/30/21 | +1.74 [-2.50, 6.30] | 6.29 | -4.17 [-31.61, 23.00] | 40.02 | -22.0 [-49.6, 7.6] | 40.4 |

Smallest interaction detectable (80% power, 5% two-sided) across the 20 estimable splits: $ 6.02 to 16.03, minutes 40.0 to 100.2, fail 32.0 to 67.7 pts.

20 interactions estimated x 3 metrics = 60 ranges; usd: 0 exclude 0, min: 1 exclude 0, fail: 3 exclude 0 (at 95%, about 1.0 per metric expected by chance alone; the inputs are not independent).

The three fail-rate interactions that exclude 0 and the one minutes interaction (`kind` none, n = 12/7 vs 92/97) sit on groups of 2 to 12 Pulls of a Cell. 60 ranges at 95% would show about 3 by chance on 20 correlated splits; 4 appeared. **No $ interaction excludes 0.** The largest-looking recorded $ interaction is `test_paths > 1`: the task-high advantage shrinks from −5.30 [−8.19, −2.66] to −1.92 [−5.54, 1.71] $ and from −27.5 to +1.0 minutes, interaction +3.38 [−1.00, 7.76] $ and +28.6 [−8.7, 60.2] minutes, both ranges holding 0.

### 2.3 Period-stratified gaps

Period-stratified gap (task-high - slow-high; gap inside period A (K=3) and B (K=2), weighted by the side's Pulls in each; resampled within period x Cell):

| input | side | $ gap [range] | min gap [range] |
|---|---|---|---|
| (all Pulls) | - | -4.22 [-6.55, -2.13] * | -16.30 [-31.72, -0.75] * |
| brief_chars | <= 4047.5 | -2.38 [-5.18, 0.43] | -9.89 [-27.17, 7.10] |
| brief_chars | > 4047.5 | -5.21 [-8.47, -2.26] * | -18.82 [-42.94, 3.29] |
| criteria | <= 5 | -3.15 [-5.82, -0.60] * | -8.81 [-26.46, 7.12] |
| criteria | > 5 | -5.59 [-9.75, -1.88] * | -30.53 [-61.28, -2.86] * |
| comments | <= 1 | -4.28 [-7.10, -1.74] * | -14.82 [-34.59, 3.50] |
| comments | > 1 | -4.04 [-7.71, -0.45] * | -18.84 [-44.26, 5.00] |
| age_days | <= 0 | -4.62 [-7.52, -1.69] * | -21.38 [-44.96, -0.23] * |
| age_days | > 0 | -4.49 [-7.91, -1.13] * | -13.24 [-33.24, 6.85] |
| paths | <= 7 | -4.28 [-7.58, -1.16] * | -22.90 [-44.60, -2.48] * |
| paths | > 7 | -4.91 [-7.53, -2.14] * | -13.54 [-34.14, 7.45] |
| test_paths | <= 1 | -5.33 [-8.06, -2.58] * | -25.40 [-43.27, -8.60] * |
| test_paths | > 1 | -1.86 [-5.46, 1.77] | +2.34 [-26.89, 29.85] |
| xrefs | <= 2 | -3.39 [-5.94, -0.84] * | -16.19 [-36.61, 4.14] |
| xrefs | > 2 | -5.94 [-9.75, -2.46] * | -17.12 [-38.27, 4.01] |
| kind | not bug | -5.47 [-8.61, -2.38] * | -23.62 [-45.97, -3.24] * |
| kind | = bug | -2.75 [-5.58, -0.10] * | -7.69 [-29.37, 14.68] |
| kind | not enhancement | -2.14 [-4.55, 0.20] | -2.75 [-20.69, 16.10] |
| kind | = enhancement | -5.96 [-9.69, -2.55] * | -31.02 [-55.79, -7.83] * |
| kind | not documentation | -4.23 [-6.64, -2.02] * | -16.43 [-33.08, -1.41] * |
| kind | = documentation | - n/a | - n/a |
| kind | not (none) | -4.53 [-6.90, -2.23] * | -19.54 [-36.40, -3.19] * |
| kind | = (none) | - n/a | - n/a |
| parent | no parent | -4.85 [-7.14, -2.71] * | -20.13 [-37.41, -4.86] * |
| parent | Slice (parent) | -3.45 [-7.72, 1.02] | +6.07 [-26.33, 39.00] |
| names_md | no | -3.33 [-6.75, -0.20] * | -11.51 [-36.05, 12.46] |
| names_md | yes | -5.07 [-8.10, -2.20] * | -20.30 [-41.60, 0.44] |
| names_code | no | -4.65 [-11.85, 1.24] | -21.07 [-50.54, 7.26] |
| names_code | yes | -4.04 [-6.33, -1.75] * | -14.71 [-32.52, 2.68] |
| names_sh | no | -4.20 [-6.80, -1.81] * | -12.03 [-29.48, 4.05] |
| names_sh | yes | -3.77 [-8.13, 0.68] | -30.07 [-62.72, 4.00] |
| names_data | no | -3.43 [-6.11, -0.95] * | -16.26 [-37.06, 3.86] |
| names_data | yes | -4.92 [-8.57, -1.34] * | -18.72 [-39.80, 2.23] |
| names_dir | no | -1.92 [-4.76, 0.93] | -11.21 [-33.90, 10.57] |
| names_dir | yes | -5.81 [-9.10, -2.67] * | -20.55 [-44.18, -1.36] * |
| names_test | no | -4.12 [-7.63, -1.05] * | -19.19 [-38.79, -0.20] * |
| names_test | yes | -3.82 [-6.82, -1.01] * | -10.51 [-34.11, 11.77] |
| prose_only | no | -4.30 [-6.78, -2.09] * | -16.88 [-33.61, -1.75] * |
| code_blocks_any | no | -3.99 [-6.37, -1.74] * | -14.97 [-30.74, 0.64] |
| code_blocks_any | yes | -9.55 [-17.45, -1.71] * | -41.30 [-86.42, 3.82] |
| extra_labels_any | no | -4.53 [-6.91, -2.31] * | -17.28 [-33.20, -2.09] * |
| extra_labels_any | yes | - n/a | - n/a |
| brief_in_comment | no | -6.07 [-9.28, -2.78] * | -16.17 [-36.46, 5.31] |
| brief_in_comment | yes | -4.18 [-6.75, -1.61] * | -16.71 [-35.84, 1.75] |

### 2.4 Power on the recorded splits

The `MDE` columns above are the smallest gap each side could have shown with 80% power at 5% two-sided, from the measured per-Pull sd and n of the two groups (`MDE = 2.80 · sqrt(Σ s²/n)`; for fail rate the binomial variance). On the whole pool the smallest detectable (task − slow) gap is $3.24, 22.4 minutes and 16.3 points of fail rate, against observed gaps of 4.23, 18.5 and 7.7: the cost gap clears it, the minutes gap sits near it, and the fail-rate gap is less than half of it. Per side the MDE is $3.2 to $15.7 (a side of 4 to 6 Pulls of a Cell is at the top). For an interaction it is the root of four variances: $6.0 to $16.0, 40 to 100 minutes and 32 to 68 fail points over the 20 splits (line above). The whole pooled cost gap is $4.23, so an interaction smaller than about $6 — about 42% of slow-high's $14.51 per Pull — could not have been seen on any split, and neither could a fail-rate interaction below about 32 points.

## 3. smol-high versus slow-high, A2 only

A2 pool: 103 Pulls (slow-high 32, task-high 39, smol-high 32). smol-high has 32 Pulls, so a median split leaves about half that on each side: only the sides listed under "Sides where both Cells" reach the Router's MIN_N of 20, and `n` is shown beside every figure so the reader can discount the rest.

All Pulls: $ 11.06 vs 14.55, gap -3.49 [-7.78, 0.69]; minutes 110.3 vs 112.9, gap -2.63 [-32.89, 25.76]; fail 18/32 vs 9/32, gap +28.1 pts [3.1, 50.0] *. Router `bootstrapDiffCI` on the same $ units: [-7.78, 0.69] (identical to the generic bootstrap here). MDE (80% power, 5% two-sided) on these Pulls: $ 6.06, minutes 42.9, fail 33.2 pts.

On A2 the Cells' fail rates are slow-high 9/32, task-high 10/39, smol-high 18/32. smol-high's $ gap to slow-high is −3.49 [−7.78, 0.69], its minutes gap −2.63 [−32.89, 25.76], and its fail gap +28.1 [3.1, 50.0] points. The pool's MDE is $6.06, 42.9 minutes, 33.2 points: the cost and minutes gaps are below it.

On 8 of the 44 sides both Cells have at least the Router's MIN_N of 20 Pulls (listed below); on the other 36 one Cell has under 20 and the figures are to be read with their `n`.

Sides where both Cells have at least the Router's MIN_N (20) Pulls: 8 of 44.

| input | side | n smol-high | n slow-high | $ gap [range] | min gap [range] | fail gap pts [range] |
|---|---|---|---|---|---|---|
| test_paths | <= 1 | 25 | 23 | -4.61 [-10.02, 0.42] | -4.5 [-43.6, 30.5] | +25.2 [-0.5, 51.3] |
| kind | not (none) | 27 | 27 | -3.88 [-8.77, 0.87] | -4.3 [-40.7, 26.4] | +25.9 [0.0, 51.9] |
| names_md | yes | 23 | 20 | -4.67 [-9.88, 0.57] | -0.9 [-45.9, 36.1] | +35.2 [6.5, 62.6] * |
| names_code | yes | 26 | 28 | -2.42 [-6.97, 1.98] | +4.2 [-31.1, 35.9] | +32.7 [6.6, 55.8] * |
| names_sh | no | 21 | 24 | -4.53 [-9.19, 0.02] | -7.5 [-46.5, 27.6] | +32.7 [6.0, 59.5] * |
| names_data | no | 21 | 26 | -4.72 [-10.14, 0.45] | -8.9 [-47.3, 25.5] | +25.5 [-2.2, 53.1] |
| names_dir | yes | 22 | 22 | -6.88 [-12.22, -1.98] * | -14.6 [-56.7, 21.2] | +13.6 [-13.6, 40.9] |
| brief_in_comment | yes | 26 | 26 | -2.26 [-6.74, 2.00] | -9.4 [-44.2, 21.2] | +23.1 [-3.8, 50.0] |

| input | cut | n | $ interaction [range] | MDE $ | min interaction [range] | MDE min | fail interaction pts [range] | MDE fail pts |
|---|---|---|---|---|---|---|---|---|
| brief_chars | > 3999 | 15/17/17/15 | +1.97 [-6.00, 9.91] | 11.81 | -12.05 [-70.56, 40.17] | 81.57 | +16.9 [-31.8, 62.7] | 65.5 |
| criteria | > 4 | 14/17/18/15 | -3.26 [-11.74, 4.70] | 11.97 | -35.21 [-97.95, 16.56] | 82.93 | -26.4 [-73.7, 19.9] | 65.8 |
| comments | > 1 | 16/10/16/22 | +4.99 [-2.47, 12.80] | 11.68 | +8.52 [-43.01, 64.13] | 79.58 | +24.3 [-22.6, 69.3] | 66.4 |
| age_days | > 0 | 13/11/19/21 | +7.96 [0.41, 15.85] * | 11.50 | +25.38 [-27.06, 82.70] | 79.58 | +37.9 [-6.0, 79.6] | 62.7 |
| paths | > 7.5 | 16/16/16/16 | +7.64 [-0.52, 15.89] | 11.99 | +44.53 [-11.30, 103.41] | 85.77 | +18.8 [-25.0, 62.5] | 65.7 |
| test_paths | > 1 | 7/9/25/23 | +3.78 [-5.20, 12.57] | 13.34 | +6.42 [-55.59, 68.19] | 93.99 | +6.5 [-43.6, 58.2] | 71.7 |
| xrefs | > 1 | 12/14/20/18 | -1.04 [-9.46, 7.75] | 12.60 | -45.30 [-110.28, 8.45] | 90.20 | +27.9 [-17.7, 72.9] | 65.5 |
| kind | = bug | 10/13/22/19 | +3.94 [-4.72, 12.91] | 12.91 | +17.09 [-37.82, 78.58] | 84.59 | -41.0 [-89.2, 8.9] | 69.5 |
| kind | = enhancement | 16/14/16/18 | -4.44 [-12.12, 3.65] | 11.79 | -21.76 [-85.99, 31.53] | 88.04 | +36.7 [-8.1, 81.4] | 63.9 |
| kind | = (none) | 5/5/27/27 | +2.53 [-4.74, 10.26] | 11.65 | +10.88 [-34.64, 63.02] | 75.78 | +14.1 [-33.3, 65.2] | 71.5 |
| names_md | true | 23/20/9/12 | -1.62 [-8.64, 5.56] | 11.03 | +17.21 [-32.55, 62.08] | 70.79 | +26.9 [-23.9, 76.2] | 69.0 |
| names_code | true | 26/28/6/4 | +6.63 [-5.72, 19.25] | 20.78 | +36.07 [-11.21, 82.55] | 72.54 | +32.7 [-33.7, 102.6] | 97.2 |
| names_sh | true | 11/8/21/24 | +4.19 [-4.78, 12.80] | 13.33 | +17.91 [-35.88, 73.90] | 80.96 | -12.3 [-64.8, 39.1] | 71.9 |
| names_data | true | 11/6/21/26 | +4.20 [-4.60, 12.40] | 12.71 | +22.10 [-31.13, 77.13] | 81.28 | +4.8 [-49.9, 61.1] | 78.0 |
| names_dir | true | 22/22/10/10 | -10.86 [-18.87, -2.90] * | 11.99 | -38.16 [-92.05, 13.39] | 79.95 | -46.4 [-89.1, 2.7] | 64.6 |
| names_test | true | 14/22/18/10 | +0.20 [-8.08, 8.97] | 12.75 | +1.63 [-54.28, 54.51] | 81.24 | +33.4 [-16.4, 82.7] | 70.3 |
| brief_in_comment | true | 26/26/6/6 | +6.58 [-1.42, 15.00] | 12.73 | -36.17 [-103.09, 21.81] | 96.04 | -26.9 [-75.6, 20.5] | 67.5 |

Smallest interaction detectable (80% power, 5% two-sided) across the 17 estimable splits: $ 11.03 to 20.78, minutes 70.8 to 96.0, fail 62.7 to 97.2 pts.

17 interactions estimated x 3 metrics = 51 ranges; usd: 2 exclude 0, min: 0 exclude 0, fail: 0 exclude 0 (at 95%, about 0.9 per metric expected by chance alone; the inputs are not independent).

Where `n` allows (the 8 sides above), the smol-high − slow-high $ gap is negative on all 8 with a range excluding 0 on 1 (`names_dir` yes, −6.88 [−12.22, −1.98]); its fail-rate gap is positive on all 8, excluding 0 on 3. smol-high's cost gap has task-high's sign but the pool cannot resolve it, at a fail rate 28 points above slow-high's on A2. Of the 17 estimable interactions, 2 $ interactions exclude 0 (`age_days > 0` +7.96 [0.41, 15.85]; `names_dir` −10.86 [−18.87, −2.90]) and none on minutes or fail; with the 2.6 expected by chance over 51 ranges and an MDE of $11.0 to $20.8, that is not distinguishable from noise.

For comparison, task-high − slow-high on the same A2 Pulls (n = 39 / 32): gap −5.49 [−9.49, −1.73] $; 4 of 17 $ interactions exclude 0 there (`paths > 9` +7.48 [0.55, 14.48], `test_paths > 1` +10.10 [2.96, 17.94], `kind` enhancement −7.86 [−15.19, −0.30], `brief_in_comment` +9.78 [1.16, 18.13]), against 0 of 20 on the full pool. On the full pool the same `test_paths > 1` interaction is +3.38 [−1.00, 7.76]. The A2 task-high − slow-high table is the script's § 3.2.

## 4. Sensitivity: drop every Pull with an implementer row at a Cell other than the drawn one

4 of 240 counted newest-generation Pulls are rescued (1 of the 208 slow/task ones). Per-Cell figures after the drop:

| Cell | n | failed | $/merged | min/merged |
|---|---|---|---|---|
| slow-high | 104 | 20 | 14.51 | 121.3 |
| task-high | 103 | 28 | 10.31 | 103.3 |
| smol-high | 29 | 15 | 10.45 | 103.2 |

All Pulls: $ 10.31 vs 14.51, gap -4.19 [-6.47, -1.97] *; minutes 103.3 vs 121.3, gap -18.03 [-34.56, -2.55] *; fail 28/103 vs 20/104, gap +8.0 pts [-3.7, 19.6]. Router `bootstrapDiffCI` on the same $ units: [-6.47, -1.97] (identical to the generic bootstrap here). MDE (80% power, 5% two-sided) on these Pulls: $ 3.25, minutes 22.4, fail 16.4 pts.

On the 207 slow/task Pulls left, every figure moves by at most $0.04, 0.4 minutes or 0.3 points: gap −4.19 [−6.47, −1.97] $ (was −4.23 [−6.51, −2.04]), −18.03 [−34.56, −2.55] minutes (was −18.45 [−35.36, −3.10]), fail +8.0 [−3.7, 19.6] points (was +7.7 [−3.8, 19.2]). The side-by-side and interaction tables (script § 4.1) differ from § 2 only through the one dropped task-high Pull: the interaction ranges excluding 0 number $ 0, minutes 1, fail 2 (was 0, 1, 3). The drop removes 4 of 240 counted Pulls (1 task-high, 3 smol-high; 15 of 268 Pulls carry a non-drawn implementer row at all). The ticket's 14 of 144 on 2026-10-21 is the same quantity measured earlier.

## 5. Free inputs from the issue text

### 5.1 What was derived

The inputs are deterministic functions of `briefText(issue)` and `briefPaths(brief)` (and the issue's labels), computed on today's text:

| input | definition |
|---|---|
| `names_md` | the brief names a path ending `.md` |
| `names_code` | … ending `.mjs .js .cjs .ts .tsx .jsx` |
| `names_sh` | … ending `.sh` |
| `names_data` | … ending `.json .jsonl .tsv .yml .yaml .toml` |
| `names_dir` | a named token ends in `/` |
| `names_test` | a named path matches the Router's `test_paths` regex (`\.test\.\|(^\|/)tests?/`): the boolean `test_paths > 0`, not a new signal |
| `prose_only` | at least one path named and every path ends `.md` |
| `code_blocks_any` | the brief has a fenced code block |
| `extra_labels_any` | the issue has a label other than the three kinds and `ready-for-agent` |
| `brief_in_comment` | the brief is an `## Agent Brief` comment rather than the body |

Re-running the Router's own `issueMetrics` on today's issues and comparing to the recorded columns over the 240 counted newest-generation Pulls: differing rows brief_chars 4, criteria 0, paths 17, test_paths 1, comments 6. The text-derived inputs below are today's text; where a Pull's recomputed brief_chars, paths or test_paths differ from the recorded value the ticket's text has changed since dispatch, so its text-derived inputs may differ from what the Router could have read then; those Pulls are kept (no run drops them).

Distinct-per-Pull path tokens by extension (top): mjs 743, md 444, (none) 424, (dir) 268, json 120, sh 87, tsv 38, git 22.
Fenced code blocks per brief (count of Pulls): 0: 230, 1: 7, 2: 2, 3: 1.
Labels on the counted Pulls' issues: ready-for-agent 239, enhancement 108, bug 105, in-progress 7, documentation 5. "Labels beyond kind" here also leaves out `ready-for-agent` (on 239 of 240): the rest are in-progress 7.
Briefs taken from an `## Agent Brief` comment: 183 of 240; from the body: 57.
Counts of Pulls with each boolean free input true: names_md 141, names_code 192, names_sh 53, names_data 84, names_dir 147, names_test 121, prose_only 1, code_blocks_any 10, extra_labels_any 7, brief_in_comment 183.

Reading. The text-derived inputs reproduce the recorded columns closely (`criteria` exactly, `brief_chars` on all but 4 Pulls, `paths` on all but 17, `comments` on all but 6, `test_paths` on all but 1), so today's text is close to what the Router read at dispatch. Three of the requested inputs have almost no variation: **`prose_only` is true for 1 of 240 Pulls** (141 briefs name an `.md` path; 140 of them also name something that is not `.md`), **fenced code blocks appear in 10 of 240 briefs**, and **no label beyond kind and `ready-for-agent` appears on more than 7 issues** (all `in-progress`). They cannot be tested; their rows in § 2.1 hold 1, 10 and 7 Pulls. The other free inputs are tested like the recorded ones in §§ 2.1–2.3: none has a $ interaction range excluding 0 on the full pool, and the only fail-rate interactions that exclude 0 (`code_blocks_any`, `extra_labels_any`) sit on groups of 4 to 6 and 2 to 5 Pulls of a Cell.

### 5.2 Free inputs seen but not tested

- the ticket title's words and length; the number of headings or sections in the brief;
- whether the brief carries an `Out of scope` section, a `## Parent` or `Spec:` line, an ADR or `CONTEXT.md` reference;
- the number of *distinct directories* the named paths fall in, and which top-level area (`plugin/scripts`, `plugin/agents`, `docs`, `tests`);
- whether each named path exists at the dispatch commit (new file versus edit), the named files' line counts, and how recently and how often they changed (all readable from the repository);
- the issue's author, creation hour and reaction counts;
- the length of the comment thread's text rather than its count;
- empirical evidence of the same kind the maintainer names: the cost and outcome of earlier Pulls on the same paths or area, and the Cell that served them. Nothing in this note tests it, and it is not free of the ordering problem: a Pull's evidence exists only for Pulls earlier in the record.

## 6. Grouping gain over one Cell, against a permutation null

Routing value of a grouping: each group takes the Cell with the lowest figure per merged PR among the Cells with >= minN Pulls in that group that clear the quality floor against slow-high there; a group where no Cell qualifies takes the one-Cell choice. The value is the groups' Pull-share-weighted figure. The one-Cell baseline is the same rule over a single group, and a grouping's gain is that Cell's value minus the routed value, both over the grouping's own group shares, so a grouping that moves no group off the one-Cell choice gains exactly 0. Gains are in-sample unless the cross-validation section says otherwise.

### 6.1 slow-high versus task-high, as routed, minN = 20 (the Router's MIN_N)

Pool 208 Pulls (slow-high 104, task-high 104); candidate cuts 25 over 15 inputs; depth-2 = every pair of cuts of two different inputs; a group needs >= 20 Pulls of a Cell for that Cell to be picked there, and a non-default Cell must clear the floor (underFloor, 15 points) against slow-high in that group. One-Cell baseline: $ 10.28/merged at task-high; minutes 102.9/merged at task-high.

The Router's current light/heavy split (ruleStratum): $ gain 0.00/merged (0.0%), minutes gain 0.00 (0.0%); Pulls light 61, heavy 147, unknown 0; $ picks light: task-high, heavy: task-high, unknown: task-high; minutes picks light: task-high, heavy: task-high, unknown: task-high.

Top one-input groupings by $ per merged PR (gain = one-Cell value - routed value; positive is better):

| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |
|---|---|---|---|
| brief_chars > 2795.75 | 0.00 $ | 0.0% | g0: task-high (n 26/26; failed 2/4); g1: task-high (n 78/78; failed 18/24) |
| brief_chars > 4047.5 | 0.00 $ | 0.0% | g0: task-high (n 49/55; failed 6/12); g1: task-high (n 55/49; failed 14/16) |
| brief_chars > 5595.75 | 0.00 $ | 0.0% | g0: task-high (n 77/79; failed 13/19); g1: task-high (n 27/25; failed 7/9) |
| criteria > 0 | 0.00 $ | 0.0% | g0: task-high (n 27/26; failed 3/6); g1: task-high (n 77/78; failed 17/22) |
| criteria > 5 | 0.00 $ | 0.0% | g0: task-high (n 63/65; failed 10/16); g1: task-high (n 41/39; failed 10/12) |

Top two-input groupings by $ per merged PR (gain = one-Cell value - routed value; positive is better):

| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |
|---|---|---|---|
| brief_chars > 4047.5 & paths > 4 | 0.08 $ | 0.7% | g0: slow-high (n 23/20; failed 1/4); g1: task-high (n 26/35; failed 5/8); g2: task-high (n 15/6; failed 5/1); g3: task-high (n 40/43; failed 9/15) |
| criteria > 6 & paths > 4 | 0.06 $ | 0.6% | g0: slow-high (n 31/23; failed 3/5); g1: task-high (n 47/59; failed 9/16); g2: task-high (n 7/3; failed 3/0); g3: task-high (n 19/19; failed 5/7) |
| criteria > 0 & paths > 12.25 | 0.01 $ | 0.1% | g0: slow-high (n 20/19; failed 0/2); g1: task-high (n 7/7; failed 3/4); g2: task-high (n 61/56; failed 11/16); g3: task-high (n 16/22; failed 6/6) |
| brief_chars > 2795.75 & criteria > 0 | 0.00 $ | 0.0% | g0: task-high (n 10/13; failed 0/1); g1: task-high (n 16/13; failed 2/3); g2: task-high (n 17/13; failed 3/5); g3: task-high (n 61/65; failed 15/19) |
| brief_chars > 2795.75 & criteria > 5 | 0.00 $ | 0.0% | g0: task-high (n 25/23; failed 2/3); g1: task-high (n 1/3; failed 0/1); g2: task-high (n 38/42; failed 8/13); g3: task-high (n 40/36; failed 10/11) |

Top one-input groupings by minutes per merged PR (gain = one-Cell value - routed value; positive is better):

| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |
|---|---|---|---|
| test_paths > 1 | 0.3 min | 0.3% | g0: task-high (n 76/69; failed 16/17); g1: slow-high (n 28/35; failed 4/11) |
| brief_chars > 2795.75 | 0.0 min | 0.0% | g0: task-high (n 26/26; failed 2/4); g1: task-high (n 78/78; failed 18/24) |
| brief_chars > 4047.5 | 0.0 min | 0.0% | g0: task-high (n 49/55; failed 6/12); g1: task-high (n 55/49; failed 14/16) |
| brief_chars > 5595.75 | 0.0 min | 0.0% | g0: task-high (n 77/79; failed 13/19); g1: task-high (n 27/25; failed 7/9) |
| criteria > 0 | 0.0 min | 0.0% | g0: task-high (n 27/26; failed 3/6); g1: task-high (n 77/78; failed 17/22) |

Top two-input groupings by minutes per merged PR (gain = one-Cell value - routed value; positive is better):

| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |
|---|---|---|---|
| criteria > 5 & test_paths > 1 | 3.0 min | 2.9% | g0: task-high (n 43/44; failed 8/9); g1: slow-high (n 20/21; failed 2/7); g2: task-high (n 33/25; failed 8/8); g3: task-high (n 8/14; failed 2/4) |
| paths > 4 & names_dir | 1.5 min | 1.4% | g0: task-high (n 19/19; failed 1/5); g1: task-high (n 19/7; failed 5/0); g2: slow-high (n 23/22; failed 3/6); g3: task-high (n 43/56; failed 11/17) |
| xrefs > 1 & names_test | 1.3 min | 1.3% | g0: task-high (n 20/29; failed 4/5); g1: slow-high (n 26/15; failed 5/6); g2: task-high (n 27/25; failed 6/9); g3: task-high (n 31/35; failed 5/8) |
| test_paths > 0 & xrefs > 1 | 1.3 min | 1.2% | g0: task-high (n 21/29; failed 4/5); g1: task-high (n 27/25; failed 6/9); g2: slow-high (n 25/15; failed 5/6); g3: task-high (n 31/35; failed 5/8) |
| criteria > 6 & test_paths > 0 | 1.0 min | 1.0% | g0: task-high (n 32/45; failed 5/11); g1: slow-high (n 46/37; failed 7/10); g2: task-high (n 16/9; failed 5/3); g3: task-high (n 10/13; failed 3/4) |

Permutation null over 500 shuffles: for each shuffle the max gain over every candidate partition of that depth is kept. "column" shuffles each input's column across Pulls independently; "row" shuffles whole feature rows against the outcomes (keeps the inputs' mutual correlation); with one input the two are the same null. Both leave each Pull's drawn Cell and outcome together. p = (1 + #null max >= real best)/(1 + shuffles).

| metric | depth | real best gain | null median | null 95th pct | null max | p (column) | p (row) | 95th pct (row) |
|---|---|---|---|---|---|---|---|---|
| $ per merged PR | <= 1 input | 0.00 (0.0%) | 0.00 | 0.22 | 0.70 | 1.000 | 1.000 | 0.18 |
| $ per merged PR | <= 2 inputs | 0.08 (0.7%) | 0.22 | 0.60 | 1.08 | 0.808 | 0.743 | 0.55 |
| minutes per merged PR | <= 1 input | 0.32 (0.3%) | 1.14 | 4.03 | 6.28 | 0.705 | 0.645 | 4.53 |
| minutes per merged PR | <= 2 inputs | 2.96 (2.9%) | 4.16 | 6.58 | 8.82 | 0.794 | 0.745 | 6.88 |

Reading. With the floor, MIN_N and the one-Cell rule as the task defines them, **no one-input grouping moves any group off task-high on $**: task-high is cheaper than slow-high in both halves of every one of the 25 cuts, so the best one-input $ gain is exactly 0 (the null's 95th percentile is 0.22 per merged PR). The Router's own light/heavy split also gains exactly 0 on $ and minutes (every row routes to task-high, as the ticket says). The best two-input $ grouping gains $0.08 (0.7% of $10.28); the null's 95th percentile is $0.60, p = 0.81 (column) / 0.74 (row). On minutes the best one-input grouping (`test_paths > 1`, which routes the 63 Pulls with more than one test path to slow-high) gains 0.32 minutes (0.3%) against a null 95th percentile of 4.03; the best two-input grouping gains 2.96 minutes (2.9%, `criteria > 5 & test_paths > 1`) against 6.58, p = 0.79. **No best grouping reaches the null's 95th percentile in any of the four rows.**

The null's 95th percentile is itself the smallest gain that would stand out from searching these partitions on this record: $0.22 (2.1% of the baseline) for one input and $0.60 (5.8%) for two; 4.03 minutes (3.9%) and 6.58 (6.4%).

### 6.2 Sensitivities of the same search

The same search with `minN = 10` (§ 5.2 of the script), with the rescued Pulls dropped (script § 5.3), and with all three Cells on A2 (script § 5.4):

**`minN = 10`** (script § 5.2):

| metric | depth | real best gain | null median | null 95th pct | null max | p (column) | p (row) | 95th pct (row) |
|---|---|---|---|---|---|---|---|---|
| $ per merged PR | <= 1 input | 0.00 (0.0%) | 0.00 | 0.31 | 0.87 | 1.000 | 1.000 | 0.32 |
| $ per merged PR | <= 2 inputs | 0.23 (2.2%) | 0.43 | 0.72 | 0.99 | 0.936 | 0.838 | 0.71 |
| minutes per merged PR | <= 1 input | 0.32 (0.3%) | 1.69 | 4.49 | 7.12 | 0.798 | 0.750 | 4.69 |
| minutes per merged PR | <= 2 inputs | 2.96 (2.9%) | 4.67 | 7.04 | 10.15 | 0.934 | 0.886 | 7.27 |

**Rescued Pulls dropped, `minN = 20`** (script § 5.3):

| metric | depth | real best gain | null median | null 95th pct | null max | p (column) | p (row) | 95th pct (row) |
|---|---|---|---|---|---|---|---|---|
| $ per merged PR | <= 1 input | 0.00 (0.0%) | 0.00 | 0.22 | 0.51 | 1.000 | 1.000 | 0.18 |
| $ per merged PR | <= 2 inputs | 0.08 (0.7%) | 0.25 | 0.62 | 1.31 | 0.822 | 0.764 | 0.59 |
| minutes per merged PR | <= 1 input | 0.32 (0.3%) | 1.17 | 4.23 | 7.28 | 0.683 | 0.649 | 3.91 |
| minutes per merged PR | <= 2 inputs | 2.97 (2.9%) | 4.26 | 6.46 | 8.38 | 0.804 | 0.731 | 6.59 |

**All three Cells, A2, `minN = 10`** (script § 5.4):

| metric | depth | real best gain | null median | null 95th pct | null max | p (column) | p (row) | 95th pct (row) |
|---|---|---|---|---|---|---|---|---|
| $ per merged PR | <= 1 input | 0.70 (7.8%) | 0.17 | 1.05 | 1.83 | 0.168 | 0.190 | 1.20 |
| $ per merged PR | <= 2 inputs | 0.77 (8.5%) | 1.04 | 1.86 | 2.51 | 0.749 | 0.659 | 1.80 |
| minutes per merged PR | <= 1 input | 0.97 (1.1%) | 2.42 | 6.83 | 10.29 | 0.745 | 0.703 | 7.69 |
| minutes per merged PR | <= 2 inputs | 7.80 (8.6%) | 6.90 | 10.98 | 15.66 | 0.327 | 0.289 | 10.76 |

The three-Cell A2 groupings that win (top lists, script § 5.4) include:

Top one-input groupings by $ per merged PR (gain = one-Cell value - routed value; positive is better):

| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |
|---|---|---|---|
| criteria > 5 | 0.70 $ | 7.8% | g0: task-high (n 20/20/21; failed 4/1/12); g1: smol-high (n 12/19/11; failed 5/9/6) |
| names_dir | 0.02 $ | 0.2% | g0: task-high (n 10/11/10; failed 2/3/8); g1: smol-high (n 22/28/22; failed 7/7/10) |
| brief_chars > 2860 | 0.00 $ | 0.0% | g0: task-high (n 6/9/11; failed 1/0/6); g1: task-high (n 26/30/21; failed 8/10/12) |
| brief_chars > 4322 | 0.00 $ | 0.0% | g0: task-high (n 17/18/17; failed 4/2/8); g1: task-high (n 15/21/15; failed 5/8/10) |
| brief_chars > 5629.5 | 0.00 $ | 0.0% | g0: task-high (n 25/28/24; failed 7/5/11); g1: task-high (n 7/11/8; failed 2/5/7) |

Top two-input groupings by $ per merged PR (gain = one-Cell value - routed value; positive is better):

| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |
|---|---|---|---|
| criteria > 0 & paths > 5 | 0.77 $ | 8.5% | g0: task-high (n 1/2/4; failed 0/0/2); g1: task-high (n 9/5/9; failed 1/1/5); g2: task-high (n 11/12/5; failed 4/1/4); g3: smol-high (n 11/20/14; failed 4/8/7) |
| brief_chars > 2860 & criteria > 5 | 0.70 $ | 7.8% | g0: task-high (n 6/9/11; failed 1/0/6); g1: task-high (n 0/0/0; failed 0/0/0); g2: task-high (n 14/11/10; failed 3/1/6); g3: smol-high (n 12/19/11; failed 5/9/6) |
| paths > 5 & names_dir | 0.57 $ | 6.2% | g0: task-high (n 3/6/6; failed 1/0/4); g1: task-high (n 9/8/3; failed 3/1/2); g2: task-high (n 7/5/4; failed 1/3/4); g3: smol-high (n 13/20/19; failed 4/6/8) |
| age_days > 0 & paths > 5 | 0.49 $ | 5.4% | g0: task-high (n 11/11/6; failed 4/1/4); g1: smol-high (n 10/12/13; failed 4/5/6); g2: task-high (n 1/3/3; failed 0/0/2); g3: slow-high (n 10/13/10; failed 1/4/6) |
| criteria > 5 & test_paths > 2 | 0.44 $ | 4.9% | g0: task-high (n 15/17/16; failed 3/0/10); g1: task-high (n 5/3/5; failed 1/1/2); g2: smol-high (n 12/13/10; failed 5/7/5); g3: task-high (n 0/6/1; failed 0/2/1) |

- `minN = 10`: best $ gain 0.23 (2.2%, two inputs), 0 for one input; null 95th percentiles 0.31 and 0.72; best minutes 0.32 and 2.96 against 4.49 and 7.04. Nothing reaches the null.
- Rescued dropped: the same groupings win with gains within 0.01 $ and 0.01 minutes of the as-routed run, and the same non-result against the null.
- A2 with smol-high: the best one-input $ grouping is `criteria > 5`, which sends that half (12 slow-high, 19 task-high and 11 smol-high Pulls; the group's counts and failures are in the table) to **smol-high** for a $0.70 (7.8%) gain; the null's 95th percentile is $1.05, p = 0.17. In that group smol-high failed 6 of 11 against slow-high's 5 of 12, 12.9 points above it, under the 15-point floor by 2.1 points. The best two-input minutes grouping gains 7.80 min (8.6%) against a 10.98 null 95th percentile. With three Cells the search has more room and the same outcome.

### 6.3 Cross-validation

The search above picks its best split from the same Pulls it scores, and a permutation null alone does not say what a chosen split would do on a Pull it has not seen. So: 5-fold cross-validation, repeated 10 times with different random folds. In each fold the best partition is chosen on the other four folds and applied to the held-out fold; a held-out Pull counts toward a policy's value only where its drawn Cell is the one the policy picks (the draw is uniform over the two Cells within each period, so those matched Pulls are an unbiased sample of that policy). The null is 100 whole-row shuffles through the same pipeline.

`minN = 20`:

| metric | depth | CV gain mean over repeats [min, max] | % of baseline | null mean | null 95th pct | repeats with gain > null 95th pct | most-chosen split |
|---|---|---|---|---|---|---|---|
| $ per merged PR | <= 1 | -0.29 [-1.14, 0.00] | -2.8% | -0.24 | 0.01 | 0/10 | (none: one Cell) (46/50 folds) |
| $ per merged PR | <= 2 | -0.66 [-1.30, -0.23] | -6.5% | -0.96 | -0.02 | 0/10 | criteria > 6 & paths > 4 (17/50 folds) |
| minutes per merged PR | <= 1 | -3.16 [-6.33, 1.41] | -3.1% | -4.82 | 1.82 | 0/10 | test_paths > 1 (25/50 folds) |
| minutes per merged PR | <= 2 | -10.29 [-14.78, -6.34] | -10.0% | -5.28 | 2.31 | 0/10 | test_paths > 1 (6/50 folds) |

`minN = 10`:

| metric | depth | CV gain mean over repeats [min, max] | % of baseline | null mean | null 95th pct | repeats with gain > null 95th pct | most-chosen split |
|---|---|---|---|---|---|---|---|
| $ per merged PR | <= 1 | -0.28 [-1.07, 0.00] | -2.7% | -0.37 | 0.12 | 0/10 | (none: one Cell) (46/50 folds) |
| $ per merged PR | <= 2 | -0.94 [-1.45, -0.40] | -9.1% | -0.69 | 0.29 | 0/10 | paths > 12.25 & test_paths > 1 (11/50 folds) |
| minutes per merged PR | <= 1 | -4.10 [-8.63, 2.03] | -4.0% | -4.78 | 1.98 | 1/10 | test_paths > 1 (26/50 folds) |
| minutes per merged PR | <= 2 | -6.06 [-10.57, -2.27] | -5.9% | -5.41 | 1.57 | 0/10 | test_paths > 1 & names_sh (16/50 folds) |

Reading. Held-out, the chosen grouping does **worse** than the one-Cell rule in all eight rows (mean CV gain −0.28 to −0.94 $ per merged PR, −3.16 to −10.29 minutes). The repeats that beat the null's 95th percentile number 0 of 10 in seven rows and 1 of 10 in one (minutes, `minN = 10`, one input). The in-sample gains of § 6.1 do not survive held-out scoring.

## 7. Power for the grouping gains

The smallest grouping gain that stands out from the permutation null is the null's 95th percentile (§ 6.1): $0.22 and $0.60 per merged PR, 4.03 and 6.58 minutes. The inputs' power is the MDE of §§ 2.4 and 3: $6.0 to $16.0 for a cost interaction, 22.4 minutes and $3.24 for the pooled task − slow gap. The ticket's rule of thumb (73 Pulls per Cell for a 30% $ difference, 163 for 20%, 286 for a 19% against 29% fail rate) is for its own baseline and sd; here the figures are computed from the measured sds of the two Cells: with 104 Pulls a Cell the pool resolves $3.24 (22% of slow-high's $14.51) and 16.3 points of fail rate. [INFERENCE, arithmetic only] halving a side's n multiplies its MDE by about √2.

## 8. What differs from "Known"

- **Randomization.** The ticket says every Pull "carries a burn-in draw over the stage-1 Cells ... so any grouping can be scored on it". That holds within a draw-set period for slow-high and task-high, as routed. It does not hold across the K = 3 → 2 change for smol-high, and it is as-routed, not as-run, for the Pulls that were rescued (§ 1).
- **Commit.** Measured at `24d29a4e`, not `e5040b9a`; the Pull counts and per-Cell figures are identical.
- **Rescues.** 15 of 268 Fit Pulls (4 of 240 counted newest-generation) carry an implementer row at a Cell other than the drawn one, against 14 of 144 on 2026-10-21.
- **"No light or heavy row has chosen a different Cell from `*`"** is reproduced as a result: light/heavy gains exactly 0 on both objectives (§ 6.1).
- **Not tested here**: the Fit's own adoption rules (`ADOPT_RATIO` 0.75, "reliably cheaper", the floor per row, the guard) are not applied to the grouping search; the routing value picks the lowest figure among Cells above `minN` that clear the floor, as the task defines it, which is more permissive than `judge` (`ticket-router.mjs:494-546`). [INFERENCE] Where this more permissive rule finds nothing the Fit's rule has nothing to adopt either; where it finds something (A2 smol-high) the Fit's rule, which also needs MIN_N merged PRs per side, a 0.75 ratio and a range wholly below zero, is stricter.

## Reproduction

```
git fetch origin && git worktree add -b research/router-inputs $D origin/main
node docs/research/router-inputs-derive.mjs > /tmp/router-inputs.out.md    # ~20 s
```

The script's stdout holds every table above plus the sections this note summarises (script §§ 3.2, 4.1, 5.2–5.4). Free-input figures are computed on issue text as of the fetch (`updatedAt` newest 2026-10-31T20:27Z for the 267 tickets); a re-fetch after a ticket edit can move them.
