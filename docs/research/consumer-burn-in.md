# Burn-in at a consumer's pace: how long, and what it costs (issue #4119, map #4118)

## Question

From a new repository's first run, how many Pulls pass before (a) its cost guard
can trip a Cell, (b) stage 1's burn-in ends, (c) stage 2's burn-in ends — at 10,
30 and 100 Pulls a week — and what does burn-in cost in $ and in floor failures,
against routing every Pull at `slow-high`?

## How this was measured

`node docs/research/consumer-burn-in-derive.mjs` reproduces every figure below
at origin/main `e5040b9a` (2026-11-01). It imports the Router's own modules
(`pr-cost.mjs`: `computeReport`, `guardFile`, `trips`, `readPrs`;
`pull-attribution.mjs`: `attribute`, `tally`, `underFloor`;
`ticket-router.mjs`: `fitTable`, `readGuard`, `MIN_N`; `ledger-grammar.mjs`:
`drawCell`), reads `docs/metrics/*.tsv` and `plugin/scripts/router-table.json`,
and runs the real `route` and `pr-cost` CLIs on synthetic inputs in a temp dir.
`gh pr list` is read once into the committed snapshot
`docs/research/consumer-burn-in-prs.json` (588 PRs, fetched 2026-11-01T00:08Z;
`--refresh` refetches); § 2 still calls `gh` through pr-cost. Sections below are
the script's own section numbers. Simulation: 4000 runs per scenario, seed 4119,
about 40 s in all; sensitivity rows 1500 runs each.

Cross-check (§ 0, § 3): the guard's figures equal the Fit's `*` estimates for
every Cell (slow-high n=104, failed 20, $14.5057 per merged PR, 121.33 min per
merged PR; the same as the brief's), and the guard trips `smol-high` only; the
Fit gives stage 2, `burn_in: true`, every row `task-high`.

## 1. What a new consumer's `route` prints (script § 1)

`route --objective cost --session 2026-11-01T10-00-00-000Z_aaaaaaaa-… --arm A
--impl-row <t-100> --issue issue.json --guard <g> --pending <tmp>` on a one-ticket
issue (`brief 80, 2 criteria`, so stratum `light`), against the installed table
(`plugin/scripts/router-table.json`: `stage 1`, cells `slow-high task-high
smol-high`, `burn_in true`, `fitted_commit null`). `route` reads the table beside
the script when `--table` is absent (`ticket-router.mjs:728`).

(a) **No guard file** — every ticket, exit 0:

```
POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=light BRIEF=80 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=guard-missing
```

(b) **A minimal guard that trips nothing**, `{"tripped":[],"cells":[]}` — tickets
101–106, exit 0 each:

```
POLICY=slow-high CELL=smol-high DRAW=2/3 BY=burn-in STRATUM=light BRIEF=80 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok   (101, 103, 105)
POLICY=slow-high CELL=slow-high DRAW=1/3 BY=burn-in STRATUM=light BRIEF=80 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok   (102)
POLICY=slow-high CELL=task-high DRAW=3/3 BY=burn-in STRATUM=light BRIEF=80 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok   (104, 106)
```

So the first guarded Pull draws over all three stage-1 Cells, uniformly, by
`sha256(session\tticket)`, with `POLICY=slow-high` recorded beside it. The guard's
`verdict`, `n` and `baseline` are never read by `route` (`parseGuard`,
`ticket-router.mjs:242-256`, keeps `tripped`, `cells[].n` and `window_start`;
`rowDispatch` reads only `tripped`, `:213-226`).

(c) **A guard with n=500 merged on every stage-1 Cell, nothing tripped** — still
`BY=burn-in`, draws `smol-high`/`slow-high`/`smol-high` for tickets 101–103. The
route path reads `table.burn_in` from the installed table (`:218`, `:330`), never
the guard's `n`. `guard.n` is read only by `fitTable` (`:602`, `:618`).

## 2. Does a consumer's second run have a guard? (script § 2)

Yes, even at verdict `none`. `pr-cost --guard` writes the guard file before it
sets its exit status (`pr-cost.mjs:441`, `:446`); `none` is exit 4, a verdict
(`EXIT`, `pr-cost.mjs:103`). Run on only the first run's features rows (19 rows)
with the full member/tier TSVs: exit 4, guard written, `verdict none`,
`tripped []`, baseline `slow-high n=6`, cells `slow-high 6, smol-high 6,
task-high 7`. On the first two runs (20 rows): the same, `task-high 8`. `route`
against either guard prints `BY=burn-in` draws (`smol-high`, `slow-high`,
`smol-high` for tickets 101–103), `REASON=ok`.

What gates the guard is not the 20-merged floor but the three metrics TSVs:
`metrics-refresh.mjs` skips the guard, and leaves `.fleet/cost-guard.json` as it
was, when any of `member-outcomes`, `tier-outcomes`, `ticket-features` is absent
(`metrics-refresh.mjs:258-260`: "no corpus to guard yet"). Run 1's close-out writes
and commits them (`close-out.md:3`, `:102-111`), so run 2's phase 0 refreshes the guard
(`phase-0.md:226-237`: "the guard has to be fresh before the first Pull is
routed"). **So burn-in begins at run 2**, with no 20-merged precondition; run 1
is all `slow-high`.

[INFERENCE] that run 2 finds all three TSVs committed rests on close-out as
documented; not exercised on a fresh consumer.

## 3. Per-Cell figures, newest generation (script § 3)

As the guard computes them (`computeReport`, `pr-cost.mjs:161-`; mean $ =
Pulls' spend ÷ merged; fail rate = failed ÷ claims; `fitTable`'s `*`
estimates agree to the cent). Counted Pulls are all merged in this corpus
(claims = merged = n), so $ per Pull = $ per merged PR and failures per Pull =
fail rate.

| Cell | generation | n counted = merged | failed | fail rate | $ per merged PR (= per counted Pull) | min per merged PR | guard |
|---|---|---|---|---|---|---|---|
| slow-high | claude-opus-5-5 | 104 | 20 | 0.1923 | 14.51 | 121.33 | baseline |
| task-high | claude-sonnet-5-5 | 104 | 28 | 0.2692 | 10.28 | 102.88 | ok (floor 0.3423; cheaper) |
| smol-high | claude-haiku-5-5 | 32 | 18 | 0.5625 | 11.06 | 110.29 | **tripped** (fail leg: 0.5625 ≥ 0.3423) |
| slow-medium | — | 0 | — | — | — | — | no Pull in the corpus |
| task-max | — | 0 | — | — | — | — | no Pull in the corpus |

Units by chosen Cell over the window: task-high 105, slow-high 104, smol-high 59
(21 of them on the older generation `claude-haiku-4-5`, 5 `excluded`, 1
`unpriced`). The merge fraction used in the draw simulation is guard-counted
merged ÷ every Pull routed to the Cell on its newest generation, `excluded`
included: slow-high 104/104 = 1.000, task-high 104/105 = 0.9905, smol-high
32/38 = 0.8421. For slow-medium and task-max there is no figure; [INFERENCE] 1.0
was used, and a sensitivity row sets every fraction to 1.0.

## 4. Pace (script § 4)

**Model.** Runs of R Pulls; R = 17 (this repo's median 16.5 Pulls per run over 16
runs; mean 16.75; this repo's pace since 2026-10-03 is 64.7 Pulls and 3.86 runs a
week). Runs per week at pace P: P ÷ 17, i.e. 0.59, 1.76 and 5.9 runs a week at
10, 30 and 100 Pulls a week. Run 1 has no guard: all R Pulls `slow-high`. From
run 2 each Pull draws with the real `drawCell` over the table's Cells less the
tripped, on a synthetic session id per run and a synthetic increasing ticket
number. Each Pull is a counted merged PR with its Cell's merge fraction (§ 3).
Merged PRs count at the next run's phase 0, which is when the guard is
refreshed: **exact** is the Pull on which a condition becomes true; **boundary**
is the number of Pulls dispatched before the first run whose phase-0 guard can
see it, the number a consumer lives by. Boundary values are multiples of 17, so
the percentile bands are coarse.

Pulls dispatched, median [p10, p90]; weeks at 10 / 30 / 100 Pulls a week are
the boundary Pull count ÷ pace.

| | Scenario | exact | boundary | weeks at 10 | at 30 | at 100 |
|---|---|---|---|---|---|---|
| (a) guard can first trip a Cell | (i) stage 1, 3 Cells | 73 [63, 84] | 85 [68, 85] | 8.5 [6.8, 8.5] | 2.83 [2.27, 2.83] | 0.85 [0.68, 0.85] |
| | (ii) #4115's stage 2: 4 drawn, smol-high tripped | 83 [71, 92] | 85 [85, 102] | 8.5 [8.5, 10.2] | 2.83 [2.83, 3.4] | 0.85 [0.85, 1.02] |
| | (iii) all five untripped | 98 [84, 111] | 102 [85, 119] | 10.2 [8.5, 11.9] | 3.4 [2.83, 3.97] | 1.02 [0.85, 1.19] |
| (b) stage-1 burn-in ends | (i) | 91 [80, 107] | 102 [85, 119] | 10.2 [8.5, 11.9] | 3.4 [2.83, 3.97] | 1.02 [0.85, 1.19] |
| (c) stage-2 burn-in ends | (ii) | 111 [99, 129] | 119 [102, 136] | 11.9 [10.2, 13.6] | 3.97 [3.4, 4.53] | 1.19 [1.02, 1.36] |
| | (iii) | 146 [129, 173] | 153 [136, 187] | 15.3 [13.6, 18.7] | 5.1 [4.53, 6.23] | 1.53 [1.36, 1.87] |
| | (iv) sequential | 177 [134, 208] | 187 [136, 221] | 18.7 [13.6, 22.1] | 6.23 [4.53, 7.37] | 1.87 [1.36, 2.21] |

(i)–(iii) are the scenarios as the ticket set them: every Cell of the set drawn
from run 2. (iv) is the path a consumer takes: stage 1 draws until all three
stage-1 Cells hold 20 merged; stage 2 then opens (`slow-medium` if `slow-high` is
untripped, `task-max` if `task-high` is untripped, `fitTable` `:604-609`); trips
use the real `trips()` over outcomes (spend, failed) resampled from this repo's
counted Pulls of the Cell. Its stage 1 equals (i)'s (exact 89 [78, 105],
boundary 102 [85, 119]). Stage 2 opens at the stage-1 boundary, 102 [85, 119]
Pulls; `smol-high` is tripped by the guard rule in 99.8% of runs, and some Cell
is tripped at the moment stage 2 opens in 97.5%. [INFERENCE] for (iv): stage 2's
opening condition also needs an adopted row or a tripped Cell (`:604`); the
adoption leg, a bootstrap range, is not simulated, so (iv) assumes the opening
happens at stage-1's end; `slow-medium` and `task-max` take merge fraction 1.0
and the outcomes of `slow-high` and `task-high` respectively.

Sensitivity, boundary median [p10, p90] in Pulls (trip / end):

| | (i) | (ii) | (iii) |
|---|---|---|---|
| R=5 | 65 [60, 75] / 80 [70, 95] | 75 [70, 90] / 100 [90, 116] | 95 [80, 110] / 135 [120, 160] |
| R=10 | 70 [60, 80] / 90 [80, 100] | 80 [70, 90] / 110 [100, 130] | 100 [80, 110] / 140 [130, 170] |
| R=17 | 85 [68, 85] / 102 [85, 119] | 85 [85, 102] / 119 [102, 136] | 102 [85, 119] / 153 [136, 170] |
| R=40 | 120 [120, 120] / 120 [120, 160] | 120 [120, 120] / 160 [160, 160] | 160 [120, 160] / 200 [160, 200] |
| R=17, all merge fractions 1.0 | 85 [68, 85] / 85 [85, 102] | 85 [85, 102] / 119 [102, 136] | 102 [85, 119] / 153 [136, 170] |

The R=17 row's (iii) p90 reads 170 here and 187 in the primary table because the
sensitivity rows use 1500 runs and a different seed: the p90 at this granularity
moves by one run (17 Pulls) between seeds.

## 5. What burn-in costs against routing every Pull at slow-high (script § 5)

Per Pull (§ 3): slow-high $14.51 and 0.1923 floor failures; task-high $10.28
and 0.2692; smol-high $11.06 and 0.5625. "Floor failures" are the guard's
`n_failed`: merged PRs ruled `minted_false_claim=yes` or `closed_own_ticket=no`,
plus `bail:fixed-refuted`. Extra = Σ over Cells of (Pulls on the Cell ×
(its figure − slow-high's)), over the mean Pulls drawn through the boundary
at which burn-in ends, run 1 included. Negative $ is a saving.

| Burn-in | mean Pulls | by Cell (slow-high / task-high / smol-high / slow-medium / task-max) | all-slow-high cost | extra $ (measured Cells) | extra floor failures (measured Cells) |
|---|---|---|---|---|---|
| stage 1, (i) | 100.4 | 44.8 / 27.8 / 27.8 / – / – | $1455.78, 19.3 failures | **−$213.47** | **+12.42** |
| stage 1, (iv) | 98.9 | 45.4 / 26.7 / 26.8 / – / – | $1434.76, 19.0 | −$205.27 | +11.98 |
| stage 2, (ii) | 120.9 | 42.9 / 25.9 / 0 / 26.0 / 26.0 | $1753.24, 23.2 | −$109.67 | +1.99 |
| stage 2, (iii) | 157.2 | 45.0 / 28.1 / 28.0 / 28.0 / 28.2 | $2279.60, 30.2 | −$215.10 | +12.51 |
| stage 2, (iv), cumulative | 181.0 | 69.6 / 42.7 / 27.1 / 24.4 / 17.1 | $2625.33, 34.8 | −$273.99 | +13.33 |

In stage 1 (i), smol-high's 27.8 Pulls carry 10.28 of the 12.42 extra failures
and −$95.76 of the −$213.47. The Pulls on `slow-medium` and `task-max`
(52.0, 56.1, 41.6 in (ii), (iii), (iv)) have no corpus figure, so the table's
$ and failures cover the measured Cells only. [INFERENCE] stand-in, never
measured: if `slow-medium` costs and fails as `slow-high` and `task-max` as
`task-high`, the totals become −$219.69 / +4.00 (ii), −$334.12 / +14.68 (iii),
−$346.44 / +14.64 (iv).

**Pulls on smol-high before a consumer's guard could trip it** (both `smol-high`
and `slow-high` at 20 merged), median [p10, p90], mean:

| | at the Pull itself | at the refresh that can trip it |
|---|---|---|
| (i) | 24 [21, 27], 23.8 | 26 [23, 31], 26.5 |
| (iii) | 23 [21, 27], 23.8 | 25 [22, 29], 25.4 |
| (iv) | 24 [21, 27], 23.8 | 26 [23, 31], 26.8 |

In (iv), where the guard trips `smol-high` at that refresh (99.8% of runs) and it
is drawn no more, `smol-high` receives 27 Pulls [23, 32] (mean 27.1) through
the end of stage 2. Under (ii), where `smol-high` starts tripped, 0. Against
the all-`slow-high` baseline each `smol-high` Pull costs 0.5625 − 0.1923 =
0.370 extra floor failures and −$3.45.

## What contradicts the ticket's "What is known"

1. **Burn-in does not end at a consumer when its Cells reach 20 merged.** `route`
   reads `burn_in` from the installed table (`ticket-router.mjs:218`, `:330`), and
   `route` with 500 merged on every Cell still prints `BY=burn-in` (§ 1(c)). Only
   `fit` rewrites the table (`:618` computes the flag; the mode is the header's `fit --table`), and the Preview fit that a
   consumer's `metrics-refresh` runs is written to `.fleet/router-preview.json`,
   "never routed, never committed" (`CONTEXT.md:655-661`: in a consumer it
   "fits the consumer's records alone, while the table that routes is fitted on
   this repository's runs"). The Pull counts in § 4 are when a consumer's own
   records would end burn-in under `fitTable`'s rule (`burn_in = !cells.every(n ≥
   20)`, `:618`); the consumer's routing ends it only if a plugin release ships a
   table with `burn_in: false`. run-team passes no `--table`
   (`pull.md:251-253`). [INFERENCE] about releases: no code path in the tree lets
   a consumer rewrite its installed table; not searched in the plugin installer.
2. **"Once a guard exists, burn-in draws": a guard exists from run 2 whatever
   its verdict** (§ 2), so burn-in starts with run 2, not when the guard first
   has a verdict; the 20-merged floor delays only the first trip, not the
   draws.
3. **`burn_in` counts every Cell in the table, tripped or not**
   (`cells.every(atN)` over `prior.cells` plus stage-2 additions, `:602`,
   `:618`), and a Cell the guard has no Pull for reads n = 0. Stage 2 cannot
   open before every stage-1 Cell has 20 merged, so (c) is strictly later than
   (b) in a consumer; in this repo both were met in the same Fit.
4. In this corpus every counted Pull is merged, so the merge fraction below 1
   (§ 3) comes from `excluded` and `unpriced` Pulls, not from unmerged PRs; and
   `smol-high` carries an older generation (21 Pulls) that the newest generation's
   n = 32 does not include.

## Not measured

- `slow-medium` and `task-max`: no Pull in the corpus, so no $ per Pull, fail
  rate or merge fraction. Their simulated outcomes are [INFERENCE] stand-ins.
- Stage-2 opening in (iv) by adoption (the bootstrap leg of `judge`).
- A consumer's run size: the sizes in § 4 are this repo's; a consumer's
  Pulls-per-run is the free parameter, shown by the R rows.
- The dollars are this repo's per-Cell means; a consumer's tickets and
  repositories differ. Per-Cell figures (this repo's own sampling error) are not
  put through a bootstrap in the cost table beyond the trip rule in (iv).
- Merge latency: PRs that merge after their run's close-out count a run later.
