# How often does a split pass by chance when the Fit re-judges it every run? (issue #4169)

Research note for the Router's self-refining clustering (map #4118). It measures; it rules on nothing.

## Question

The Fit re-judges every split at each phase 0. When no input matters, how often does a split appear by chance at some run, and for how many runs does it stay? How does that compare with judging once? And what does weighting Pulls by their known assignment probability do to the time to find a real split worth 6.5%?

## Method, source and reproduction

`docs/research/split-looks-derive.mjs` prints every table in the appendix; the prose and the headline tables below are hand-arranged rows of it and contain no number the appendix does not. Reproduce: `node docs/research/split-looks-derive.mjs --workers 14` (Node >= 18, seed 20261101; the defaults are the run reported here). Deterministic for a fixed seed whatever `--workers` is.

Reused from #4160 (`origin/research/split-gate`, `docs/research/split-gate-derive.mjs`), copied as they are: the corpus load through the Router's own modules (`attribute`, `generations`, `tally`, `underFloor`, `MIN_N`; `ticket-router.mjs:382-385`), the pool of 208 counted slow-high (104) and task-high (104) Pulls (gap $-4.23), the resampling (a period at its real share, a Cell, a Pull resampled within that period and Cell; Delta = $6 added to each task-high Pull whose fair-coin injected input is 1), the decoupled decoys (each Pull's nine recorded inputs taken from another, independently drawn Pull, so no input matters), the candidate cuts (25/50/75th percentiles, `kind`, `parent`, the injected bit; at most 24 cuts, fewer where a side holds under 2 x `MIN_N` Pulls), the gain engine (`pick`, `gainOf`, depth 1 and <= 2), G1 (99 shuffles, p <= 0.05), G2 (doubly robust, 5 cross-fitted folds, one-sided 95% lower bound > 0) and G3 = G1 and G2.

Changed, as the ticket asks:

- **Histories grown run by run**, 17 Pulls a run. Pulls 1-102 (6 runs) are drawn uniformly over slow-high and task-high. After that each Pull is drawn independently, 4/5 to the policy Cell and 1/5 to the other (a Bernoulli draw per Pull, not an exact count). The policy Cell is the previous look's one-Cell choice: the split-gate engine's `pick` over one group (the cheaper Cell if it has >= `MIN_N` Pulls, clears the floor and is cheaper in sample, else slow-high).
- **A look at every run boundary**, on the prefix grown so far; the cuts are re-derived from the prefix's percentiles at each look. Looks at runs 1..118 (2,006 Pulls) for Delta 0 and 1..148 (2,516 Pulls) for Delta 6.
- **Propensities.** G2 uses each Pull's known probability of the Cell it got (1/2 in burn-in, 4/5 or 1/5 after) in place of the fixed 1/2. G1's shuffle of the whole (Cell, $, claims, failed) tuple against the inputs stays inside propensity strata (rows with the same P(slow-high): 1/2, 4/5, 1/5). The gain engine itself is split-gate's, unweighted. G2 is computed only where G1 passes (only G1 and G3 are reported).
- **Standing, and the "same inputs" test.** A split stands at a look when the gate passes there; the adopted partition is the best one at that depth. The hysteresis variant needs the gate to pass at 2 consecutive looks, either with the same input(s) in the adopted partition ("same inputs"; thresholds move with the record's percentiles, so the partition itself is never identical) or with any partition ("any split"). A *real* split is held when the gate passes and the adopted partition uses the injected input; the hysteresis variants then need that at both looks.
- **Arms.**
  - `rule`: the real rule above, weighted gates, a look every run. 300 histories at Delta 0, 160 at Delta 6.
  - `uniform`: the same decoys, but the record holds only uniform-draw Pulls, counted as split-gate counted them: the 102 burn-in Pulls, then 1 Pull in 5 (a record of 482 draws at 2,006 Pulls). Propensity 1/2 throughout. A look at every run, the x axis in real Pulls. 300 and 160 histories. This is "without weighting, counting only uniform-draw Pulls".
  - `once`: the real-rule draw but no Fit adopts anything, so the policy Cell stays slow-high (4/5 slow-high after burn-in); judged once, at the last Pull. `oncet`: the same with task-high as the policy Cell throughout (the state a real-rule history ends in). 1,000 histories per Delta and arm.
- **Precision.** 95% Wilson ranges beside every share; a 95% bootstrap range over histories (1,000 resamples) beside every 80% crossing. Compute: 6,920 histories, 833 s wall on 14 worker threads; the machine's load average was 37-90 on 14 cores, so the 11,542 s of worker time is wall time inside a loaded machine, not CPU.

Not measured, and so not claimed: the Router's own adoption margin (`ADOPT_RATIO` 0.75 and the bootstrap range, `ticket-router.mjs:518-519`) is not applied to the one-Cell choice; a standing split does not change the draw (only the one-Cell policy Cell does; [INFERENCE] a standing split on an input would send each group 4/5 to its own Cell, leaving the per-group information the same, 4 p (1-p) = 0.64); G2h and realised gain are not computed; coupled and padded decoy families are not run.

## 1. Chance splits (Delta 0: no input matters)

300 histories of the real rule, 2,006 Pulls (118 runs), a look at each run. `ever` is the share of histories with a split standing at some look. A *stretch* is a maximal run of consecutive looks at which a split stands; `mean run` and `max run` are over all stretches of all histories, in runs (17 Pulls each). `final` is the share split at the last look. `once` is the share split when the gates are judged once at 2,006 Pulls (`once`: 4/5 slow-high; `oncet`: 4/5 task-high). Ranges are 95% Wilson.

| gate | depth | stands when | ever split % [range] | stretches / history | mean run | max run | final look % [range] | once, 4/5 slow-high % [range] | once, 4/5 task-high % [range] |
|---|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | 29.7 [25-35] | 0.66 | 3.6 | 42 | 0.0 [0-1] | 4.4 [3-6] | 1.7 [1-3] |
| G1 | 1 | 2 looks, same inputs | 19.3 [15-24] | 0.33 | 5.1 | 41 | 0.0 [0-1] | | |
| G1 | 2 | every look | 56.0 [50-62] | 1.79 | 3.1 | 58 | 3.7 [2-6] | 5.9 [5-8] | 6.4 [5-8] |
| G1 | 2 | 2 looks, same inputs | 36.3 [31-42] | 0.88 | 4.1 | 57 | 2.3 [1-5] | | |
| G3 | 1 | every look | 7.0 [5-10] | 0.08 | 1.8 | 5 | 0.0 [0-1] | 0.2 [0-1] | 0.0 [0-0] |
| G3 | 1 | 2 looks, same inputs | 3.0 [2-6] | 0.04 | 1.6 | 4 | 0.0 [0-1] | | |
| G3 | 2 | every look | 24.0 [20-29] | 0.49 | 3.4 | 58 | 1.0 [0-3] | 3.6 [3-5] | 1.7 [1-3] |
| G3 | 2 | 2 looks, same inputs | 15.0 [11-19] | 0.26 | 4.5 | 57 | 1.0 [0-3] | | |

The appendix also has the "2 looks, any split" rows (within 1 point of "same inputs" in every cell above), the share of all looks at which a split stands (G1: 2.0% depth 1, 4.7% depth 2; G3: 0.1% and 1.4%), and the same table for the uniform-draw-only record, in which the shares are of the same size: ever split G1 38.3 / 51.3%, G3 6.0 / 20.3% (depth 1 / 2).

Facts:

- Judged at every run, a chance split stands at some look in 30% (G1, depth 1) and 56% (G1, depth 2) of histories, against 4.4% and 5.9% when the gates are judged once at the end of the same record (1.7% and 6.4% when task-high holds 4/5). G3: 7.0% and 24.0% against 0.2% and 3.6% (0.0% and 1.7%).
- A stretch is short on average (3.1-3.6 runs for G1, 1.8 and 3.4 for G3) but not always: the longest single stretch is 42 runs (714 Pulls) for G1 at depth 1, 58 runs (986 Pulls) at depth 2 for G1 and G3. G3 at depth 1 never stands longer than 5 runs (85 Pulls).
- Needing the gate to pass at 2 consecutive looks removes about a third of the ever-split share for G1 (29.7 to 19.3%; 56.0 to 36.3%) and 37-57% of it for G3 (7.0 to 3.0%; 24.0 to 15.0%). The stretches that remain are longer on average (5.1 and 4.1 runs for G1) and the longest are unchanged (41-57 runs).
- The share split at the last look of the real-rule histories is lower than the share split when judged once at the end: G1 depth 1 0/300 (0.0% [0-1]) against 44/1000 (`once`) and 17/1000 (`oncet`). At depth 2 they are within range (3.7 [2-6] against 5.9 and 6.4). See Contradictions.
- When in a history: with the real rule, the share of looks with a G1 depth-1 split standing is 1.4% in the first 204 Pulls, 4.0% in 205-340, 2.5-2.8% in 341-1,360, then 1.3% and 0.4% in the last two buckets; the uniform-draw record's share rises over the same Pulls from 2.0% to 4.6% (appendix, "When in a history").
- Once a history is past burn-in it follows the cheaper Cell: the one-Cell choice at the look after burn-in is task-high in 83% of Delta-0 histories, 94% after 204 Pulls and 100% from 1,020 Pulls.

## 2. Time to the real split (Delta 6)

160 histories per looking arm, a look at every run, up to 2,516 Pulls (148 runs). `run for 80%` is the first run by which 80% of histories have, at some look, held the real split (the gate passes and the adopted partition uses the injected input); the bracket is a 95% bootstrap range over histories. `draws` is the record's size in uniform-draw terms: for the real rule burn-in + 0.64 per later Pull (4 p (1-p), p = 4/5; a conversion, not a measurement), for the uniform-draw record its actual size. `first held by` is cumulative over looks; `held at the look` is the share of histories holding it at the one look at that many Pulls.

| gate | depth | stands when | record | run for 80% [95% bootstrap] | Pulls | draws | first held by 500 / 1000 / 1500 / 2000 / 2500 Pulls % | held at the look at 500 / 1000 / 1500 / 2000 / 2500 % |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | real rule, weighted | 34 [28-41] | 578 | 407 | 75 / 93 / 99 / 99 / 99 | 61 / 84 / 93 / 98 / 99 |
| G1 | 1 | every look | uniform draws only | 85 [70-108] | 1,445 | 370 | 41 / 61 / 80 / 88 / 92 | 21 / 43 / 57 / 68 / 77 |
| G1 | 1 | 2 looks, same inputs | real rule, weighted | 41 [34-50] | 697 | 483 | 68 / 91 / 99 / 99 / 99 | 56 / 84 / 91 / 95 / 99 |
| G1 | 1 | 2 looks, same inputs | uniform draws only | 104 [76-122] | 1,768 | 435 | 36 / 54 / 78 / 83 / 89 | 19 / 36 / 56 / 64 / 76 |
| G1 | 2 | every look | real rule, weighted | 32 [25-36] | 544 | 385 | 77 / 94 / 99 / 100 / 100 | 63 / 87 / 97 / 100 / 99 |
| G1 | 2 | every look | uniform draws only | 81 [65-95] | 1,377 | 357 | 48 / 68 / 83 / 89 / 92 | 24 / 37 / 62 / 66 / 77 |
| G1 | 2 | 2 looks, same inputs | real rule, weighted | 35 [30-40] | 595 | 418 | 73 / 93 / 98 / 99 / 99 | 49 / 74 / 88 / 87 / 90 |
| G1 | 2 | 2 looks, same inputs | uniform draws only | 99 [83-118] | 1,683 | 418 | 36 / 59 / 75 / 86 / 91 | 13 / 26 / 51 / 57 / 68 |
| G3 | 1 | every look | real rule, weighted | 59 [50-79] | 1,003 | 679 | 61 / 79 / 88 / 91 / 93 | 41 / 53 / 70 / 75 / 83 |
| G3 | 1 | every look | uniform draws only | not reached by 148 | > 2,516 | - | 29 / 44 / 59 / 64 / 74 | 16 / 28 / 38 / 43 / 51 |
| G3 | 1 | 2 looks, same inputs | real rule, weighted | 65 [57-87] | 1,105 | 744 | 52 / 75 / 86 / 90 / 92 | 36 / 51 / 69 / 74 / 82 |
| G3 | 1 | 2 looks, same inputs | uniform draws only | not reached by 148 | > 2,516 | - | 23 / 39 / 54 / 60 / 71 | 14 / 24 / 34 / 42 / 51 |
| G3 | 2 | every look | real rule, weighted | 32 [27-36] | 544 | 385 | 76 / 93 / 99 / 99 / 99 | 56 / 79 / 90 / 89 / 94 |
| G3 | 2 | every look | uniform draws only | 85 [66-111] | 1,445 | 370 | 43 / 66 / 81 / 87 / 90 | 21 / 34 / 59 / 63 / 74 |
| G3 | 2 | 2 looks, same inputs | real rule, weighted | 37 [33-43] | 629 | 439 | 68 / 91 / 97 / 99 / 99 | 43 / 66 / 80 / 79 / 86 |
| G3 | 2 | 2 looks, same inputs | uniform draws only | 100 [87-121] | 1,700 | 421 | 33 / 56 / 73 / 85 / 89 | 10 / 23 / 48 / 54 / 65 |

("2 looks, any split" rows are in the appendix. They equal "same inputs" in the run for 80% except G3 depth 2 weighted (36 [33-41] runs, 612 Pulls); the held-at-look column differs by up to 12 points at depth 2, e.g. G1 depth 2 weighted 59 / 86 / 95 / 98 / 99.)

Weighting against the draw-count claim. Pulls for 80% under the real rule with weighted gates, against the uniform-draw record counted at 1 draw per 5 Pulls, and what one real Pull is worth in uniform draws:

| gate | depth | stands when | Pulls, real rule weighted | Pulls, uniform draws only | uniform draws at its 80% | draws per Pull (burn-in included) | draws per Pull beyond burn-in | real-rule draws at its 80% at 0.64 per Pull |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | 578 | 1,445 | 370 | 0.64 | 0.56 | 407 |
| G1 | 1 | 2 looks, same inputs | 697 | 1,768 | 435 | 0.62 | 0.56 | 483 |
| G1 | 2 | every look | 544 | 1,377 | 357 | 0.66 | 0.58 | 385 |
| G1 | 2 | 2 looks, same inputs | 595 | 1,683 | 418 | 0.70 | 0.64 | 418 |
| G3 | 1 | every look | 1,003 | not reached | - | - | - | 679 |
| G3 | 2 | every look | 544 | 1,445 | 370 | 0.68 | 0.61 | 385 |
| G3 | 2 | 2 looks, same inputs | 629 | 1,700 | 421 | 0.67 | 0.61 | 439 |

Judged once, at 2,516 Pulls with 4/5 to slow-high and no adoption, the real split is the adopted split's input in 99.5% (G1 depth 1), 99.8% (G1 depth 2), 97.8% (G3 depth 1) and 99.6% (G3 depth 2) of 1,000 histories.

Facts:

- With a look at every run, 80% of histories have held the real split by run 32-41 under G1 and G3 at depth 2 and G1 at depth 1 (544-697 Pulls, 385-483 draws by the 0.64 conversion), and by run 59-65 (1,003-1,105 Pulls) under G3 at depth 1. With a look at every run on the uniform-draw-only record the same crossings are at run 81-104 (1,377-1,768 Pulls; 357-435 draws), and G3 at depth 1 does not reach 80% by 2,516 Pulls (74% at 2,500).
- Around the 80% crossing for G1 depth 1 weighted (578 Pulls): at 500 Pulls 75% of histories have first held the real split but 61% hold it at that look; at 1,000 Pulls 93% and 84%. The held-at-look column is the single-look detection rate and is the one comparable with split-gate's single-look curve (uniform-draw record, G1 depth 1: 68% at about 2,000 Pulls = about 480 draws, 77% at about 2,500 = about 580 draws; split-gate, decoupled: 73% at N = 500, 97% at N = 1,000).
- Weighted Pulls versus uniform-draw Pulls: the real-rule record needs 2.5-2.8 times fewer Pulls for the same share (G1 depth 1: 578 against 1,445). Read as draws per Pull, the uniform record's draws at its own 80% point divided by the weighted record's Pulls: 0.62-0.70 with the burn-in counted, 0.56-0.64 beyond it, against 0.64 per Pull after burn-in claimed. The bootstrap ranges on the crossings are wide (e.g. 28-41 against 70-108 runs for G1 depth 1); [INFERENCE] from those ranges the ratio is known to about +/-0.1; a standard error on the ratio itself was not computed.
- Requiring the real split to pass at 2 consecutive looks adds 7 runs (G1 depth 1: 34 to 41), 3 (G1 depth 2), 5 (G3 depth 2) and 6 (G3 depth 1) under the real rule, and 19, 18 and 15 runs on the uniform-draw record (G1 depth 1, G1 depth 2, G3 depth 2).

## Contradictions with what is known

- The 1,000 random draws for 80% (split-gate, one look) is a different quantity from `run for 80%` here. Judged at every run, 80% have held the real split at some look by 357-435 uniform-draw-equivalent draws (G1, G3 depth 2, G1 depth 1), well before the 1,000 draws a single look needs; the single-look detection rate in this run at the same record sizes matches split-gate's. Both numbers are measured; they answer different questions.
- The real-rule histories' last look splits less often than the same record judged once: G1 depth 1 0/300 against 17/1000 for `oncet`, which has the same end state (task-high 4/5, 2,006 Pulls) and differs only in that the real-rule policy follows each look's choice, which in 17% of Delta-0 histories is slow-high at the first post-burn-in look and 100% task-high from 1,020 Pulls. Probability of 0 in 300 at a rate of 1.7% is about 0.6%. The profile by Pulls (G1 depth 1, real rule: 1.3% then 0.4% of looks in the last two buckets, against 4.4% and 4.6% for the uniform-draw record) shows the same fall late in the history; why was not measured. The gap does not appear at depth 2 (3.7 against 5.9 and 6.4).
- G1 at depth 2 splits by chance in 5.9% [5-8] (`once`) and 6.4% [5-8] (`oncet`) of 1,000 histories, at or above the one-sided 5% level; split-gate's decoupled G1 depth-2 numbers were 2-7%.

## Appendix: derive output

Verbatim output of `node docs/research/split-looks-derive.mjs --workers 14` at `origin/main` `e810699f`.

# split-looks derive output

Repository HEAD e810699f; window start 2026-10-03; 268 Pulls in the window, 268 in the Fit's set (ticket-router.mjs:382-385); pool 208 counted slow-high (104) and task-high (104) Pulls, pooled gap -4.23; MIN_N 20, TRIP_POINTS 15; seed 20261101.
Settings: 17 Pulls per run, uniform draw to 102 Pulls (6 runs), then 4/5 policy Cell : 1/5 other; histories 300 (Delta 0, 118 runs = 2006 Pulls) and 160 (Delta 6, 148 runs = 2516 Pulls) per looking arm, 1000 per Delta for the judged-once arm; G1 shuffles per look 99; workers 14.

## 1. Chance splits (Delta 0: no input matters)

**Real draw rule, propensity-weighted gates, 2006 Pulls** (300 histories, looks at runs 1..118 = 2006 Pulls; `mean run` and `max run` are the length in runs of a stretch of consecutive looks at which a split stands, over all stretches of all histories; `looks split` is the share of all looks at which a split stands; `final` the share split at the last look)

| gate | depth | a split stands when | ever split % [range] | stretches per history | mean run | max run | looks split % | final look % [range] |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | 29.7 [25-35] | 0.66 | 3.6 | 42 | 2.0 | 0.0 [0-1] |
| G1 | 1 | 2 looks, same inputs | 19.3 [15-24] | 0.33 | 5.1 | 41 | 1.4 | 0.0 [0-1] |
| G1 | 1 | 2 looks, any split | 19.7 [16-25] | 0.33 | 5.3 | 41 | 1.5 | 0.0 [0-1] |
| G1 | 2 | every look | 56.0 [50-62] | 1.79 | 3.1 | 58 | 4.7 | 3.7 [2-6] |
| G1 | 2 | 2 looks, same inputs | 36.3 [31-42] | 0.88 | 4.1 | 57 | 3.1 | 2.3 [1-5] |
| G1 | 2 | 2 looks, any split | 37.0 [32-43] | 0.84 | 4.5 | 57 | 3.2 | 2.3 [1-5] |
| G3 | 1 | every look | 7.0 [5-10] | 0.08 | 1.8 | 5 | 0.1 | 0.0 [0-1] |
| G3 | 1 | 2 looks, same inputs | 3.0 [2-6] | 0.04 | 1.6 | 4 | 0.1 | 0.0 [0-1] |
| G3 | 1 | 2 looks, any split | 3.0 [2-6] | 0.04 | 1.8 | 4 | 0.1 | 0.0 [0-1] |
| G3 | 2 | every look | 24.0 [20-29] | 0.49 | 3.4 | 58 | 1.4 | 1.0 [0-3] |
| G3 | 2 | 2 looks, same inputs | 15.0 [11-19] | 0.26 | 4.5 | 57 | 1.0 | 1.0 [0-3] |
| G3 | 2 | 2 looks, any split | 15.0 [11-19] | 0.25 | 4.8 | 57 | 1.0 | 1.0 [0-3] |

**Judged once at the end, against the last look of the looking histories.** `once`: the same record grown without any adoption (4/5 to slow-high after burn-in), judged only at its last Pull. `last look`: the share split at the last look of the real-rule histories above. `uniform record`: the uniform-draw-only record at its last look.

| gate | depth | horizon Pulls | once, 4/5 slow-high, split % [range] (n) | once, 4/5 task-high % [range] (n) | last look of the real-rule histories % [range] (n) | uniform-draw record, last look % [range] (n; draws) |
|---|---|---|---|---|---|---|
| G1 | 1 | 2006 | 4.4 [3-6] (1000) | 1.7 [1-3] (1000) | 0.0 [0-1] (300) | 3.3 [2-6] (300; 482) |
| G1 | 2 | 2006 | 5.9 [5-8] (1000) | 6.4 [5-8] (1000) | 3.7 [2-6] (300) | 5.7 [4-9] (300; 482) |
| G3 | 1 | 2006 | 0.2 [0-1] (1000) | 0.0 [0-0] (1000) | 0.0 [0-1] (300) | 0.3 [0-2] (300; 482) |
| G3 | 2 | 2006 | 3.6 [3-5] (1000) | 1.7 [1-3] (1000) | 1.0 [0-3] (300) | 2.0 [1-4] (300; 482) |

**Chance splits in the uniform-draw-only record** (split-gate's accounting: burn-in Pulls, then 1 Pull in 5 as a random draw; still a look at every run).

**Uniform-draw record** (300 histories, looks at runs 1..118 = 2006 Pulls; `mean run` and `max run` are the length in runs of a stretch of consecutive looks at which a split stands, over all stretches of all histories; `looks split` is the share of all looks at which a split stands; `final` the share split at the last look)

| gate | depth | a split stands when | ever split % [range] | stretches per history | mean run | max run | looks split % | final look % [range] |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | 38.3 [33-44] | 1.30 | 3.6 | 60 | 3.9 | 3.3 [2-6] |
| G1 | 1 | 2 looks, same inputs | 29.0 [24-34] | 0.66 | 4.9 | 59 | 2.8 | 2.7 [1-5] |
| G1 | 1 | 2 looks, any split | 29.0 [24-34] | 0.65 | 5.1 | 59 | 2.8 | 3.0 [2-6] |
| G1 | 2 | every look | 51.3 [46-57] | 1.78 | 2.8 | 44 | 4.2 | 5.7 [4-9] |
| G1 | 2 | 2 looks, same inputs | 35.0 [30-41] | 0.79 | 3.9 | 29 | 2.6 | 4.0 [2-7] |
| G1 | 2 | 2 looks, any split | 35.0 [30-41] | 0.77 | 4.2 | 43 | 2.7 | 4.0 [2-7] |
| G3 | 1 | every look | 6.0 [4-9] | 0.14 | 2.1 | 11 | 0.2 | 0.3 [0-2] |
| G3 | 1 | 2 looks, same inputs | 3.3 [2-6] | 0.05 | 2.9 | 10 | 0.1 | 0.3 [0-2] |
| G3 | 1 | 2 looks, any split | 3.3 [2-6] | 0.05 | 2.9 | 10 | 0.1 | 0.3 [0-2] |
| G3 | 2 | every look | 20.3 [16-25] | 0.46 | 3.2 | 25 | 1.2 | 2.0 [1-4] |
| G3 | 2 | 2 looks, same inputs | 12.0 [9-16] | 0.21 | 4.5 | 15 | 0.8 | 2.0 [1-4] |
| G3 | 2 | 2 looks, any split | 12.0 [9-16] | 0.20 | 4.9 | 24 | 0.9 | 2.0 [1-4] |

**When in a history chance splits stand.** Share of (history, look) pairs at which a split stands (every-look rule), by the Pulls grown at the look.

| gate | depth | record | 1-204 Pulls | 205-340 Pulls | 341-680 Pulls | 681-1020 Pulls | 1021-1360 Pulls | 1361-1700 Pulls | 1701-2006 Pulls |
|---|---|---|---|---|---|---|---|---|---|
| G1 | 1 | real rule | 1.4 | 4.0 | 2.5 | 2.8 | 2.6 | 1.3 | 0.4 |
| G1 | 1 | uniform draws | 2.0 | 3.5 | 3.9 | 4.3 | 3.9 | 4.4 | 4.6 |
| G1 | 2 | real rule | 2.3 | 5.6 | 5.9 | 4.8 | 5.1 | 4.1 | 4.9 |
| G1 | 2 | uniform draws | 1.9 | 3.3 | 3.8 | 4.1 | 4.5 | 4.6 | 6.1 |
| G3 | 1 | real rule | 0.3 | 0.5 | 0.4 | 0.0 | 0.0 | 0.0 | 0.0 |
| G3 | 1 | uniform draws | 0.1 | 0.6 | 0.2 | 0.5 | 0.1 | 0.3 | 0.2 |
| G3 | 2 | real rule | 0.5 | 2.5 | 1.9 | 1.4 | 1.6 | 1.5 | 0.8 |
| G3 | 2 | uniform draws | 0.2 | 0.8 | 1.0 | 1.3 | 1.1 | 1.3 | 2.3 |

## 2. Time to the real split (Delta 6)

The real split is held at a look when the gate passes and the adopted partition uses the injected input. `first held` is the first look at which that is so under the hysteresis variant (so `first held by` is cumulative over looks); `held at the look` is the share of histories in which it is held at that one look. `run for 80%` is the first run by which 80% of histories have first held it; `Pulls` = run x 17. `draws`: the record's size in uniform-draw terms: for the real-rule record, burn-in Pulls + 0.64 per later Pull (4 p (1-p) with p = 4/5); for the uniform-draw record, its actual size. `x` = never reached within the horizon.

| gate | depth | hysteresis | record | histories | run for 80% [95% bootstrap] | Pulls for 80% | draws at that run | first held by 500 / 1000 / 1500 / 2000 / 2500 Pulls % | held at the look at those Pulls % |
|---|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | real rule, weighted | 160 | 34 [28-41] | 578 | 407 | 75 / 93 / 99 / 99 / 99 | 61 / 84 / 93 / 98 / 99 |
| G1 | 1 | every look | uniform draws only | 160 | 85 [70-108] | 1445 | 370 | 41 / 61 / 80 / 88 / 92 | 21 / 43 / 57 / 68 / 77 |
| G1 | 1 | 2 looks, same inputs | real rule, weighted | 160 | 41 [34-50] | 697 | 483 | 68 / 91 / 99 / 99 / 99 | 56 / 84 / 91 / 95 / 99 |
| G1 | 1 | 2 looks, same inputs | uniform draws only | 160 | 104 [76-122] | 1768 | 435 | 36 / 54 / 78 / 83 / 89 | 19 / 36 / 56 / 64 / 76 |
| G1 | 1 | 2 looks, any split | real rule, weighted | 160 | 41 [34-50] | 697 | 483 | 68 / 91 / 99 / 99 / 99 | 56 / 84 / 91 / 95 / 99 |
| G1 | 1 | 2 looks, any split | uniform draws only | 160 | 104 [76-122] | 1768 | 435 | 36 / 54 / 78 / 83 / 89 | 19 / 36 / 56 / 64 / 76 |
| G1 | 2 | every look | real rule, weighted | 160 | 32 [25-36] | 544 | 385 | 77 / 94 / 99 / 100 / 100 | 63 / 87 / 97 / 100 / 99 |
| G1 | 2 | every look | uniform draws only | 160 | 81 [65-95] | 1377 | 357 | 48 / 68 / 83 / 89 / 92 | 24 / 37 / 62 / 66 / 77 |
| G1 | 2 | 2 looks, same inputs | real rule, weighted | 160 | 35 [30-40] | 595 | 418 | 73 / 93 / 98 / 99 / 99 | 49 / 74 / 88 / 87 / 90 |
| G1 | 2 | 2 looks, same inputs | uniform draws only | 160 | 99 [83-118] | 1683 | 418 | 36 / 59 / 75 / 86 / 91 | 13 / 26 / 51 / 57 / 68 |
| G1 | 2 | 2 looks, any split | real rule, weighted | 160 | 35 [30-40] | 595 | 418 | 73 / 93 / 98 / 99 / 99 | 59 / 86 / 95 / 98 / 99 |
| G1 | 2 | 2 looks, any split | uniform draws only | 160 | 99 [83-118] | 1683 | 418 | 36 / 59 / 75 / 86 / 91 | 16 / 32 / 57 / 62 / 75 |
| G3 | 1 | every look | real rule, weighted | 160 | 59 [50-79] | 1003 | 679 | 61 / 79 / 88 / 91 / 93 | 41 / 53 / 70 / 75 / 83 |
| G3 | 1 | every look | uniform draws only | 160 | x | > 2516 | - | 29 / 44 / 59 / 64 / 74 | 16 / 28 / 38 / 43 / 51 |
| G3 | 1 | 2 looks, same inputs | real rule, weighted | 160 | 65 [57-87] | 1105 | 744 | 52 / 75 / 86 / 90 / 92 | 36 / 51 / 69 / 74 / 82 |
| G3 | 1 | 2 looks, same inputs | uniform draws only | 160 | x | > 2516 | - | 23 / 39 / 54 / 60 / 71 | 14 / 24 / 34 / 42 / 51 |
| G3 | 1 | 2 looks, any split | real rule, weighted | 160 | 65 [57-87] | 1105 | 744 | 52 / 75 / 86 / 90 / 92 | 36 / 51 / 69 / 74 / 82 |
| G3 | 1 | 2 looks, any split | uniform draws only | 160 | x | > 2516 | - | 23 / 39 / 54 / 60 / 71 | 14 / 24 / 34 / 42 / 51 |
| G3 | 2 | every look | real rule, weighted | 160 | 32 [27-36] | 544 | 385 | 76 / 93 / 99 / 99 / 99 | 56 / 79 / 90 / 89 / 94 |
| G3 | 2 | every look | uniform draws only | 160 | 85 [66-111] | 1445 | 370 | 43 / 66 / 81 / 87 / 90 | 21 / 34 / 59 / 63 / 74 |
| G3 | 2 | 2 looks, same inputs | real rule, weighted | 160 | 37 [33-43] | 629 | 439 | 68 / 91 / 97 / 99 / 99 | 43 / 66 / 80 / 79 / 86 |
| G3 | 2 | 2 looks, same inputs | uniform draws only | 160 | 100 [87-121] | 1700 | 421 | 33 / 56 / 73 / 85 / 89 | 10 / 23 / 48 / 54 / 65 |
| G3 | 2 | 2 looks, any split | real rule, weighted | 160 | 36 [33-41] | 612 | 428 | 69 / 92 / 97 / 99 / 99 | 53 / 76 / 88 / 89 / 94 |
| G3 | 2 | 2 looks, any split | uniform draws only | 160 | 100 [87-121] | 1700 | 421 | 33 / 56 / 73 / 85 / 89 | 13 / 29 / 54 / 59 / 71 |

**Looking at one look only, at the end (`once` arm, Delta 6, 2516 Pulls, no adoption).** Share whose adopted split uses the injected input:

| gate | depth | histories | split on the injected input % [range] | any split % |
|---|---|---|---|---|
| G1 | 1 | 1000 | 99.5 [99-100] | 99.5 [99-100] |
| G1 | 2 | 1000 | 99.8 [99-100] | 99.8 [99-100] |
| G3 | 1 | 1000 | 97.8 [97-99] | 97.8 [97-99] |
| G3 | 2 | 1000 | 99.6 [99-100] | 99.6 [99-100] |

**Weighting against the draw-count claim.** Pulls for 80% under the real rule with weighted gates, against the uniform-draw record at 1 draw per 5 Pulls, and the ratio of the two. 'Draws per Pull' = the uniform record's draws at its own 80% point / the Pulls the weighted real-rule record needed for 80%: how many uniform draws one real Pull is worth, burn-in included; the next column leaves the burn-in out. The last column is the real-rule record's size in draws at its 80% point if each Pull after burn-in were worth 0.64 (to set beside the uniform draws).

| gate | depth | hysteresis | Pulls, real rule weighted | Pulls, uniform draws only | uniform draws at its 80% | draws per Pull of the weighted record | the same beyond the burn-in: (draws - 102) / (Pulls - 102) | real-rule draws at its 80% by 0.64 per Pull |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | every look | 578 | 1445 | 370 | 0.64 | 0.56 | 407 |
| G1 | 1 | 2 looks, same inputs | 697 | 1768 | 435 | 0.62 | 0.56 | 483 |
| G1 | 1 | 2 looks, any split | 697 | 1768 | 435 | 0.62 | 0.56 | 483 |
| G1 | 2 | every look | 544 | 1377 | 357 | 0.66 | 0.58 | 385 |
| G1 | 2 | 2 looks, same inputs | 595 | 1683 | 418 | 0.70 | 0.64 | 418 |
| G1 | 2 | 2 looks, any split | 595 | 1683 | 418 | 0.70 | 0.64 | 418 |
| G3 | 1 | every look | 1003 | x | - | - | - | 679 |
| G3 | 1 | 2 looks, same inputs | 1105 | x | - | - | - | 744 |
| G3 | 1 | 2 looks, any split | 1105 | x | - | - | - | 744 |
| G3 | 2 | every look | 544 | 1445 | 370 | 0.68 | 0.61 | 385 |
| G3 | 2 | 2 looks, same inputs | 629 | 1700 | 421 | 0.67 | 0.61 | 439 |
| G3 | 2 | 2 looks, any split | 612 | 1700 | 421 | 0.69 | 0.63 | 428 |

## 3. The draw rule the histories followed

Share of real-rule histories (Delta 0) whose look chose task-high as the one-Cell policy (so that slow-high is the 1/5 side), by Pulls: 102: 83%, 204: 94%, 340: 96%, 510: 98%, 1020: 100%, 2006: 100%. Delta 6: 102: 73%, 204: 81%, 340: 91%, 510: 97%, 1020: 99%, 2006: 100%.

The largest record judged is 2006 Pulls (Delta 0) and 2516 Pulls (Delta 6).

Compute: 6920 histories on 14 worker threads, 832 s wall for the simulation, 11542 s of worker time, 833 s in all.
