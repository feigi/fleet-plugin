# When would a self-splitting grouping first split, and how often by chance? (issue #4160)

Research note for the Router's self-refining clustering (map #4118). It measures; it rules on nothing.

## Question

Suppose the Router starts each repository with one group and splits a group only when a gate passes on the logged random draws. How many Pulls pass before it finds a real input effect of a given size? And how often does it split when no effect exists?

## Method, source and reproduction

`docs/research/split-gate-derive.mjs` prints every table in Appendix A and the section in Appendix B; the prose around them is hand-written, and the counts it states were read off those tables. The headline tables H1-H12 below are rows of Appendix A's §3 re-arranged by a one-off script that is not committed; they contain no number that Appendix A does not. The weeks table is Appendix A's §4, pasted unedited.

- **Corpus**, as router-inputs-derive.mjs (#4150) loads it, through the Router's own modules (`plugin/scripts/`): `attribute({ features, members, tiers: verdicts, windowStart: "2026-10-03", stratum: ruleStratum })`, filtered to `exploration_draw !== "" || sizing_src === "rule"` (`ticket-router.mjs:382-385`), `tally(units, generations(all)).pulls` for the newest generation of each Cell, the quality floor `underFloor` (`TRIP_POINTS` 15) and `MIN_N` 20. Every counted Pull is merged (the script stops otherwise), so $ per merged PR is $ per Pull.
- **Pool resampled**: the 208 counted slow-high (104) and task-high (104) Pulls, by draw-set period (A: K=3, 110 Pulls; B: K=2, 98). The simulated population has period A at its real share (0.53), each Cell drawn at 1/2: slow-high $14.47, task-high $10.26, gap $-4.22 (router-inputs: $-4.23). Per-Pull $ coefficient of variation 0.69 (slow-high) and 0.60 (task-high).
- **A simulated record** of N Pulls: for each Pull a period (at its real share), a Cell (uniform, as burn-in draws), then a Pull resampled with replacement from that period and Cell; its $, failed/claims and its nine recorded inputs (`brief_chars`, `criteria`, `comments`, `age_days`, `paths`, `test_paths`, `xrefs`, `kind`, `parent`) stay with it. An injected input is a fair coin, independent of everything; where it is 1, Delta dollars are added to each task-high Pull's $. Delta ∈ {0, 2, 4, 5, 6, 8}. Three record families:
  - `coupled`: the issue's design, as above.
  - `decoupled`: each Pull's nine recorded inputs come from another, independently drawn Pull, so none of the decoys carries information about the outcome. Delta 0 and 6 only.
  - `padded`: `coupled` plus four more fair-coin decoys, so the search is as wide as router-inputs' (25 cuts). Delta 0 and 6 only.
- **The search** is router-inputs' gain engine on $ per merged PR: candidate cuts at the record's 25/50/75th percentiles of each numeric input, `kind` as one four-way partition, `parent` by presence, the injected input; a binary cut whose smaller side holds fewer than 2 x `MIN_N` Pulls is dropped; depth 1 is one cut, depth 2 every pair of cuts of two different inputs. Each group takes the cheapest Cell with at least `MIN_N` Pulls that clears the floor against slow-high in that group; the gain of a partition is the one-Cell value minus the routed value, groups weighted by their share of Pulls. The Fit's one-Cell choice is the same rule over one group. A partition that moves no group off the one-Cell choice gains exactly 0.
- **Gates**, all one-sided at 95%, each applied to the best partition of depth <= 1 or <= 2 by in-sample gain:
  - **G1**: the best gain beats the 95th percentile of the same search on shuffled inputs. Per record, 99 shuffles of the whole (Cell, $, claims, failed) tuple against the inputs (router-inputs' "row" null); it passes when (1 + #shuffles with best gain >= the real one)/(99 + 1) <= 0.05 and the gain is positive.
  - **G2**: a doubly robust estimate of (one-Cell value - split value), propensity 1/2, the outcome model a group x Cell mean cross-fitted over 5 random folds, on the record the split was chosen on; it passes when the one-sided 95% lower bound (normal approximation) is above 0.
  - **G3**: G1 and G2.
  - **G2h** (an addition, not in the ticket): G2 with the split chosen on a random half of the record and scored on the other half, so the estimate is not scored on the data that chose the split.
- **Realised gain** is not read off the record. Each adopted policy (its groups' rules and per-group Cells) is scored on a separate 200,000-Pull reference sample of the same family and Delta, as `one-Cell choice of the record - policy`, groups weighted by their share of Pulls; a record that does not split scores 0. The coupled and the decoupled reference samples score the injected split alone at $0.87 (§2) and $0.90 (H10): [INFERENCE] reference-sample error of about $0.03.
- **Measured at** `origin/main` `e810699f` (2026-11-01). The per-Cell figures reproduce router-inputs' (104/104 Pulls, gap $-4.23).
- **Reproduce**: `node docs/research/split-gate-derive.mjs` (Node >= 18; seed 20261101). Simulations per N for `coupled` and, equally, for `decoupled` and `padded`: 268:400, 500:400, 1000:400, 2000:300, 5000:200, 10000:100, 20000:50; 5,550 records in all; 99 G1 shuffles per record. The full run took 1,161 s wall on 8 worker threads (41 min 45 s of CPU; the machine's load average was 152 when development began and 104 after the run, on 14 cores). Results are deterministic and do not depend on the worker count: two runs of a reduced configuration (`--ns 268,1000 --sims 30 --deltas 0,6`) on 8 and on 2 workers differ only in the `Settings:` line, which prints the worker count; and a rerun of `--ns 268 --sims 400 --only decoupled --deltas 0,6` reproduces the N=268 rows of Appendix A's §3.2 digit for digit. Appendix A was printed by the script before §5 (the one-Cell baseline) was added; §5 only appends a section, and Appendix B is its output from `--only-base` (47 s).
- **Precision.** The 95% Wilson ranges are printed beside every share. Half-widths are at most 5 points at 400 records (N <= 1000), 5.6 at 300 (N=2000), 6.8 at 200 (N=5000), 9.6 at 100 (N=10000) and 13.5 at 50 (N=20000); N = 10,000 and 20,000 are beyond the ticket's grid and are there to show where the curves end. Realised gains carry a standard error over records in the tables and about $0.03 of reference-sample error on top.

The ticket's grid is N = 268, 500, 1,000, 2,000, 5,000. The first five columns of every table are those; 10,000 and 20,000 are added.

## 1. The gate on the real record

The real record the search can use is the 208 counted slow-high and task-high Pulls of the 268 (smol-high's 32 counted Pulls and its older generation are not in a two-Cell search). With the nine recorded inputs and no injected one, the search has 18 cuts (router-inputs, with six free inputs: 25 cuts over 15 inputs).

| depth | best split | in-sample gain $/merged | null 95th pct | G1 p | G2 DR gain [LCB] | G1 | G2 | G3 |
|---|---|---|---|---|---|---|---|---|
| 1 | (none moves a group) | 0.00 | 0.17 | 1.000 | 0.00 [-] | no | no | no |
| 2 | brief_chars > 4047.5 & paths > 4 | 0.08 | 0.52 | 0.545 | 0.01 [-0.69] | no | no | no |

(1,999 shuffles for the null here.) No gate splits the real record at either depth: no depth-1 partition has a positive gain (the one-Cell choice is task-high), and the best depth-2 partition's $0.08 is below the null's 95th percentile of $0.52. The best gains, 0.00 and 0.08, are router-inputs' (§5.1 there), which the port reproduces. G2h, scored on held-out halves, passes in 18 of 200 random halves at depth 1 and in 18 of 200 at depth 2 (9%); it is a different question from the full-record G2 above, which is evaluated on all 208 Pulls.

## 2. What the injected effect is worth

| Delta | gap bit=0 | gap bit=1 | one-Cell choice | split picks (bit=0 / bit=1) | oracle gain $ | % of one-Cell value |
|---|---|---|---|---|---|---|
| 0 | -4.20 | -4.28 | task-high | task-high / task-high | 0.00 | 0.0% |
| 2 | -4.20 | -2.28 | task-high | task-high / task-high | 0.00 | 0.0% |
| 4 | -4.20 | -0.28 | task-high | task-high / task-high | 0.00 | 0.0% |
| 5 | -4.20 | 0.72 | task-high | task-high / slow-high | 0.36 | 2.8% |
| 6 | -4.20 | 1.72 | task-high | task-high / slow-high | 0.87 | 6.5% |
| 8 | -4.20 | 3.72 | task-high | task-high / slow-high | 1.88 | 13.1% |

(Gap = task-high - slow-high on the reference sample, per side of the injected input.) Slow-high becomes the cheaper Cell on the injected side once Delta exceeds about 4.2, so Delta 5 and above flip it. At Delta 0, 2 and 4 no split changes any group's Cell: the true gain of every split on the injected input is 0. At Delta 8 the pooled gap is about -0.3, so the one-Cell choice itself is close to a coin flip at small N (§5, Appendix B: the one-Cell choice is slow-high in 44% of N=268 records at Delta 8, 4% at N=20,000).

## 3. How often it splits: headline tables

Cells are the share of simulated records, in %, with the 95% Wilson range where printed. A record "splits on the injected input" when the gate passes and the adopted partition uses it; "splits on any decoy" when the gate passes and the partition uses at least one recorded (or coin) decoy. At depth 2 a partition can use both: the injected input plus a decoy as its second cut, which is how the depth-2 rows read in H4-H8; H9 gives the decoy-only share. Appendix A §3 has, for every (family, gate, depth, N, Delta), also `any`, `decoy-only`, the realised gain, the mean in-sample best gain and the mean G1 null 95th percentile.

**H1. Decoupled decoys, Delta = 0: share of records that split on any decoy [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 4 [2-6] | 3 [1-5] | 3 [2-5] | 2 [1-4] | 2 [1-4] | 0 [0-4] | 0 [0-7] |
| G1 | 2 | 7 [4-9] | 5 [3-8] | 5 [3-8] | 5 [3-8] | 5 [3-9] | 5 [2-11] | 0 [0-7] |
| G2 | 1 | 6 [4-8] | 1 [1-3] | 0 [0-1] | 0 [0-1] | 0 [0-2] | 0 [0-4] | 0 [0-7] |
| G2 | 2 | 9 [7-12] | 4 [2-6] | 3 [1-5] | 0 [0-2] | 1 [0-4] | 0 [0-4] | 0 [0-7] |
| G3 | 1 | 1 [1-3] | 0 [0-1] | 0 [0-1] | 0 [0-1] | 0 [0-2] | 0 [0-4] | 0 [0-7] |
| G3 | 2 | 3 [2-5] | 2 [1-3] | 2 [1-4] | 0 [0-2] | 1 [0-4] | 0 [0-4] | 0 [0-7] |
| G2h | 1 | 7 [4-9] | 5 [3-7] | 1 [0-3] | 0 [0-1] | 0 [0-2] | 0 [0-4] | 0 [0-7] |
| G2h | 2 | 7 [5-10] | 5 [3-7] | 1 [0-3] | 0 [0-1] | 0 [0-2] | 0 [0-4] | 0 [0-7] |

**H2. Coupled decoys (the issue's design), Delta = 0: share of records that split on any decoy [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 16 [13-20] | 14 [11-18] | 32 [27-36] | 25 [20-30] | 22 [16-28] | 11 [6-19] | 6 [2-16] |
| G1 | 2 | 45 [40-50] | 70 [66-75] | 99 [98-100] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2 | 1 | 7 [5-10] | 3 [2-5] | 2 [1-4] | 2 [1-4] | 1 [0-4] | 0 [0-4] | 0 [0-7] |
| G2 | 2 | 38 [33-43] | 47 [42-52] | 85 [81-88] | 95 [92-97] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G3 | 1 | 3 [2-5] | 2 [1-4] | 2 [1-4] | 2 [1-4] | 1 [0-4] | 0 [0-4] | 0 [0-7] |
| G3 | 2 | 27 [22-31] | 44 [39-49] | 85 [81-88] | 95 [92-97] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2h | 1 | 9 [6-12] | 6 [4-9] | 1 [0-2] | 1 [0-3] | 0 [0-2] | 0 [0-4] | 0 [0-7] |
| G2h | 2 | 11 [8-14] | 12 [9-15] | 19 [16-23] | 58 [53-64] | 85 [79-89] | 91 [84-95] | 100 [93-100] |

**H3. Padded search (25 cuts), Delta = 0: share of records that split on any decoy [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 11 [8-14] | 21 [17-25] | 32 [27-36] | 30 [25-36] | 21 [15-27] | 15 [9-23] | 4 [1-13] |
| G1 | 2 | 29 [25-34] | 70 [65-74] | 99 [97-99] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2 | 1 | 7 [4-9] | 5 [3-8] | 2 [1-4] | 1 [1-3] | 1 [0-3] | 1 [0-5] | 0 [0-7] |
| G2 | 2 | 33 [29-38] | 52 [47-57] | 87 [83-90] | 96 [93-98] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G3 | 1 | 2 [1-4] | 5 [3-8] | 2 [1-4] | 1 [1-3] | 1 [0-3] | 1 [0-5] | 0 [0-7] |
| G3 | 2 | 20 [16-24] | 48 [43-52] | 87 [83-90] | 96 [93-98] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2h | 1 | 10 [8-14] | 6 [4-8] | 2 [1-4] | 1 [1-3] | 0 [0-2] | 0 [0-4] | 0 [0-7] |
| G2h | 2 | 12 [9-15] | 12 [9-16] | 21 [17-25] | 62 [56-67] | 77 [71-82] | 99 [95-100] | 98 [90-100] |

**H4. Decoupled decoys, Delta = 6: share that split on the injected input [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 43 [38-47] | 73 [68-77] | 97 [95-98] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G1 | 2 | 37 [32-42] | 75 [71-79] | 98 [96-99] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2 | 1 | 31 [26-35] | 50 [45-55] | 80 [76-84] | 96 [93-97] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2 | 2 | 57 [52-62] | 80 [76-83] | 95 [92-97] | 100 [98-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G3 | 1 | 28 [24-33] | 49 [44-54] | 80 [76-84] | 96 [93-97] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G3 | 2 | 36 [31-41] | 70 [65-74] | 95 [92-96] | 100 [98-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2h | 1 | 15 [12-19] | 28 [24-32] | 49 [44-53] | 78 [73-82] | 99 [96-100] | 100 [96-100] | 100 [93-100] |
| G2h | 2 | 16 [12-19] | 28 [24-32] | 43 [38-48] | 70 [64-75] | 97 [94-99] | 100 [96-100] | 100 [93-100] |

**H5. Coupled decoys, Delta = 6: share that split on the injected input [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 33 [29-38] | 66 [61-70] | 80 [75-83] | 95 [92-97] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G1 | 2 | 43 [38-48] | 62 [57-66] | 67 [62-71] | 81 [77-85] | 91 [86-94] | 99 [95-100] | 98 [90-100] |
| G2 | 1 | 26 [22-31] | 45 [40-50] | 68 [64-73] | 94 [90-96] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G2 | 2 | 47 [42-51] | 62 [57-66] | 67 [62-71] | 81 [77-85] | 91 [86-94] | 99 [95-100] | 98 [90-100] |
| G3 | 1 | 25 [21-29] | 45 [40-50] | 68 [64-73] | 94 [90-96] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G3 | 2 | 43 [38-47] | 61 [56-66] | 67 [62-71] | 81 [77-85] | 91 [86-94] | 99 [95-100] | 98 [90-100] |
| G2h | 1 | 15 [12-19] | 21 [17-25] | 35 [31-40] | 65 [59-70] | 97 [94-99] | 100 [96-100] | 100 [93-100] |
| G2h | 2 | 19 [15-23] | 35 [30-39] | 42 [38-47] | 68 [63-73] | 84 [78-88] | 91 [84-95] | 98 [90-100] |

**H6. Coupled decoys, Delta = 5: share that split on the injected input [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 19 [15-23] | 34 [30-39] | 49 [44-54] | 61 [56-67] | 83 [77-87] | 91 [84-95] | 98 [90-100] |
| G1 | 2 | 27 [23-31] | 42 [37-47] | 43 [38-47] | 46 [40-52] | 56 [49-62] | 60 [50-69] | 74 [60-84] |
| G2 | 1 | 14 [11-18] | 19 [15-23] | 27 [23-32] | 42 [36-47] | 73 [66-78] | 90 [83-94] | 98 [90-100] |
| G2 | 2 | 30 [26-35] | 43 [38-47] | 43 [38-47] | 46 [40-52] | 56 [49-62] | 60 [50-69] | 74 [60-84] |
| G3 | 1 | 13 [10-17] | 19 [15-23] | 27 [23-32] | 42 [36-47] | 73 [66-78] | 90 [83-94] | 98 [90-100] |
| G3 | 2 | 25 [21-29] | 42 [37-46] | 43 [38-47] | 46 [40-52] | 56 [49-62] | 60 [50-69] | 74 [60-84] |
| G2h | 1 | 8 [6-11] | 9 [6-12] | 8 [6-11] | 13 [10-17] | 42 [35-48] | 68 [58-76] | 86 [74-93] |
| G2h | 2 | 11 [8-14] | 17 [13-20] | 21 [17-25] | 36 [30-41] | 53 [46-59] | 59 [49-68] | 60 [46-72] |

**H7. Coupled decoys, Delta = 8: share that split on the injected input [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 67 [62-71] | 88 [84-90] | 97 [95-98] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G1 | 2 | 69 [64-73] | 87 [83-90] | 95 [93-97] | 100 [98-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2 | 1 | 59 [54-63] | 86 [83-89] | 97 [95-98] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2 | 2 | 72 [68-76] | 87 [83-90] | 95 [93-97] | 100 [98-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G3 | 1 | 58 [53-63] | 86 [83-89] | 97 [95-98] | 100 [99-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G3 | 2 | 68 [64-73] | 87 [83-90] | 95 [93-97] | 100 [98-100] | 100 [98-100] | 100 [96-100] | 100 [93-100] |
| G2h | 1 | 33 [28-37] | 62 [57-67] | 84 [80-87] | 99 [97-100] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G2h | 2 | 40 [35-45] | 68 [64-73] | 86 [82-89] | 96 [93-98] | 100 [98-100] | 100 [96-100] | 100 [93-100] |

**H8. Padded search, Delta = 6: share that split on the injected input [95% range]**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 33 [28-37] | 61 [56-66] | 79 [75-83] | 94 [91-96] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G1 | 2 | 45 [40-49] | 59 [54-64] | 65 [60-70] | 77 [72-81] | 92 [87-95] | 98 [93-99] | 100 [93-100] |
| G2 | 1 | 26 [22-31] | 46 [41-50] | 69 [64-73] | 91 [87-94] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G2 | 2 | 50 [45-55] | 59 [54-64] | 65 [60-70] | 77 [72-81] | 92 [87-95] | 98 [93-99] | 100 [93-100] |
| G3 | 1 | 25 [21-29] | 45 [40-50] | 69 [64-73] | 91 [87-94] | 100 [97-100] | 100 [96-100] | 100 [93-100] |
| G3 | 2 | 44 [39-49] | 59 [54-64] | 65 [60-70] | 77 [72-81] | 92 [87-95] | 98 [93-99] | 100 [93-100] |
| G2h | 1 | 11 [9-15] | 21 [17-25] | 37 [32-41] | 62 [56-67] | 93 [89-96] | 100 [96-100] | 100 [93-100] |
| G2h | 2 | 17 [14-21] | 30 [25-34] | 45 [40-49] | 63 [58-69] | 83 [77-87] | 95 [89-98] | 100 [93-100] |

**H9. Decoupled decoys, Delta = 6: share that split on a decoy and not on the injected input (false splits next to a real effect)**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 4 | 2 | 1 | 0 | 0 | 0 | 0 |
| G1 | 2 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |
| G2 | 1 | 6 | 1 | 1 | 0 | 0 | 0 | 0 |
| G2 | 2 | 13 | 5 | 1 | 0 | 0 | 0 | 0 |
| G3 | 1 | 2 | 1 | 1 | 0 | 0 | 0 | 0 |
| G3 | 2 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |
| G2h | 1 | 1 | 1 | 2 | 0 | 0 | 0 | 0 |
| G2h | 2 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |

**H10. Decoupled decoys, Delta = 6: mean realised gain, $ per merged PR (s.e.); the injected split alone is worth 0.87**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 0.48 (0.03) | 0.73 (0.03) | 0.88 (0.01) | 0.90 (0.00) | 0.90 (0.00) | 0.90 (0.00) | 0.90 (0.00) |
| G1 | 2 | 0.34 (0.03) | 0.60 (0.02) | 0.77 (0.01) | 0.84 (0.01) | 0.88 (0.00) | 0.90 (0.00) | 0.90 (0.00) |
| G2 | 1 | 0.38 (0.03) | 0.53 (0.03) | 0.73 (0.02) | 0.86 (0.01) | 0.90 (0.00) | 0.90 (0.00) | 0.90 (0.00) |
| G2 | 2 | 0.48 (0.03) | 0.63 (0.03) | 0.74 (0.01) | 0.84 (0.01) | 0.88 (0.00) | 0.90 (0.00) | 0.90 (0.00) |
| G3 | 1 | 0.35 (0.03) | 0.52 (0.03) | 0.73 (0.02) | 0.86 (0.01) | 0.90 (0.00) | 0.90 (0.00) | 0.90 (0.00) |
| G3 | 2 | 0.33 (0.03) | 0.56 (0.02) | 0.74 (0.01) | 0.84 (0.01) | 0.88 (0.00) | 0.90 (0.00) | 0.90 (0.00) |
| G2h | 1 | 0.22 (0.03) | 0.36 (0.03) | 0.49 (0.03) | 0.70 (0.02) | 0.89 (0.01) | 0.90 (0.00) | 0.90 (0.00) |
| G2h | 2 | 0.19 (0.03) | 0.29 (0.03) | 0.37 (0.02) | 0.55 (0.02) | 0.82 (0.01) | 0.89 (0.00) | 0.90 (0.00) |

**H11. Coupled decoys, Delta = 0: mean realised gain, $ per merged PR (s.e.)**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 0.01 (0.03) | -0.02 (0.02) | -0.02 (0.00) | -0.01 (0.00) | -0.00 (0.00) | -0.00 (0.00) | -0.00 (0.00) |
| G1 | 2 | 0.09 (0.03) | 0.08 (0.02) | 0.25 (0.01) | 0.29 (0.01) | 0.34 (0.01) | 0.34 (0.01) | 0.38 (0.01) |
| G2 | 1 | 0.20 (0.04) | 0.03 (0.02) | -0.00 (0.00) | -0.00 (0.00) | -0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G2 | 2 | 0.21 (0.04) | 0.08 (0.02) | 0.24 (0.01) | 0.28 (0.01) | 0.34 (0.01) | 0.34 (0.01) | 0.38 (0.01) |
| G3 | 1 | 0.08 (0.03) | 0.02 (0.01) | -0.00 (0.00) | -0.00 (0.00) | -0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G3 | 2 | 0.10 (0.03) | 0.07 (0.02) | 0.24 (0.01) | 0.28 (0.01) | 0.34 (0.01) | 0.34 (0.01) | 0.38 (0.01) |
| G2h | 1 | 0.27 (0.05) | 0.25 (0.05) | 0.03 (0.02) | -0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G2h | 2 | 0.28 (0.04) | 0.25 (0.05) | 0.07 (0.02) | 0.20 (0.01) | 0.30 (0.01) | 0.31 (0.01) | 0.39 (0.01) |

**H12. Decoupled decoys, Delta = 0: mean realised gain, $ per merged PR (s.e.)**

| gate | depth | 268 | 500 | 1000 | 2000 | 5000 | 10000 | 20000 |
|---|---|---|---|---|---|---|---|---|
| G1 | 1 | 0.02 (0.02) | -0.01 (0.00) | -0.01 (0.00) | -0.00 (0.00) | -0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G1 | 2 | -0.01 (0.02) | -0.03 (0.01) | -0.02 (0.00) | -0.01 (0.00) | -0.00 (0.00) | -0.00 (0.00) | 0.00 (0.00) |
| G2 | 1 | 0.19 (0.04) | 0.04 (0.02) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G2 | 2 | 0.16 (0.04) | 0.03 (0.02) | -0.01 (0.00) | -0.00 (0.00) | -0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G3 | 1 | 0.04 (0.02) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G3 | 2 | 0.02 (0.02) | -0.01 (0.00) | -0.01 (0.00) | -0.00 (0.00) | -0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G2h | 1 | 0.20 (0.04) | 0.15 (0.03) | 0.03 (0.01) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |
| G2h | 2 | 0.19 (0.04) | 0.13 (0.03) | 0.03 (0.01) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) | 0.00 (0.00) |

**What the headline tables show** (every figure is a cell of H1-H12 or of Appendix A §3):

1. **Chance splits when no decoy carries information** (decoupled, Delta 0, H1). G1 at depth 1 splits in 4% [2-6] of records at N=268, 2-3% from 500 to 5,000 and 0 at 10,000 and 20,000; at depth 2, 7% [4-9] at 268 and 5% from 500 to 10,000 (0 [0-7] at 20,000, 50 records). G2 splits in 6% and 9% (depth 1, 2) at 268, 1% and 4% at 500, and 0-3% from 1,000. G3 never exceeds 3%. G2h is at 7% at 268 and 5% at 500, 1% at 1,000 and 0 from 2,000. The mean realised gain of these chance splits is within $0.04 of 0 for G1 and G3; for G2 at N=268 it is +$0.16 to +$0.19 and for G2h +$0.19 to +$0.20; at N=500 +$0.03 to +$0.04 (G2) and +$0.13 to +$0.15 (G2h) (H12). [INFERENCE] The positive gain comes from records whose one-Cell choice is itself wrong: task-high is under the quality floor against slow-high in 5% of N=268 records and 1% of N=500 records (Appendix B), which makes the one-Cell choice slow-high, and a chance split that moves a group to task-high then earns the gap. The G1 rates sit at or below the 5% the test is set to; the G1 ranges at depth 2 include 5% at every N.
2. **When the decoys keep their Pulls' own structure** (coupled, Delta 0, H2, H3). Depth-1 G1 splits on a decoy in 16, 14, 32, 25, 22, 11 and 6% of records (N=268 to 20,000); depth-2 G1 in 45, 70, 99, 100, 100, 100 and 100%. G2 and G3 at depth 1 stay at or below 7%; at depth 2 G2 goes 38, 47, 85, 95, 100, 100, 100%. These are not chance splits in the simulated population: their mean realised gain on the reference sample is +$0.09 (N=268) to +$0.38 (N=20,000) for G1 at depth 2 (H11), and about 0 at depth 1. [INFERENCE] The 208 resampled Pulls' own noise is the population's structure, and a record large enough finds it; the real 208-Pull record's best depth-2 gain is $0.08 against a null 95th percentile of $0.52 (§1). The `padded` family (H3) gives the same picture with 25 cuts.
3. **Finding a real flip, Delta 6** (oracle gain $0.87, 6.5% of the one-Cell value). Decoupled (H4): G1 at depth 1 splits on the injected input in 43, 73, 97 and 100% of records at N = 268, 500, 1,000, 2,000; G2 and G3 at depth 1 in 31/28, 50/49, 80/80, 96/96%; G2h in 15, 28, 49, 78 and, at 5,000, 99%. At depth 2: G1 37, 75, 98, 100%; G2 57, 80, 95, 100%; G3 36, 70, 95, 100%; G2h 16, 28, 43, 70, 97% (N up to 5,000). Coupled (H5): G1 depth 1 33, 66, 80, 95, 100%; G1 depth 2 43, 62, 67, 81, 91, 99%; G2h depth 1 15, 21, 35, 65, 97%. Padded (H8): G1 depth 1 79% at 1,000 and 94% at 2,000; depth 2 77% at 2,000 and 92% at 5,000.
4. **Delta 5** (oracle $0.36, 2.8%; H6, coupled). G1 at depth 1: 61% at 2,000, 83% at 5,000, 91% at 10,000, 98% at 20,000. G2 and G3 at depth 1: 73% at 5,000, 90% at 10,000. G2h at depth 1: 42% at 5,000, 86% at 20,000. No gate at depth 2 reaches 80% by N=20,000 (G1/G2/G3: 74%, 50 records).
5. **Delta 8** (oracle $1.88, 13.1%; H7, coupled). G1 at depth 1 and depth 2: 67/69% at 268, 88/87% at 500, 97/95% at 1,000; G2 and G3 within 1-2 points of those from N=500; G2h 33/40%, 62/68%, 84/86%.
6. **Delta 2 and 4** (no flip, true gain 0). In `coupled`, the share of records that split on the injected input never exceeds 3% at Delta 2 and 22% at Delta 4 (G1 at depth 2, N=500), for any gate, depth or N; from N=5,000 up it is at most 11% at Delta 4 (G2h at depth 2, N=5,000) and 0 for every gate at N=20,000. At Delta 4 and N >= 5,000 almost every record splits on a decoy instead, with a positive realised gain (+$0.12 to +$0.15 for depth-1 G1): [INFERENCE] once the injected side's gap has shrunk to about -$0.3, the population's own decoy structure is large enough to move groups.
7. **A split at depth 2 next to a real one.** At Delta 6, decoupled, the depth-2 partition contains the injected cut and a decoy cut in 98% (N=1,000), 100% (2,000 and up) of G1 records (H4 and H9: decoy-only splits 0-2%). The realised gain at depth 2 is below depth 1's by $0.11 at N=1,000 (0.77 vs 0.88), $0.06 at 2,000 (0.84 vs 0.90), $0.02 at 5,000 and 0 at 10,000 (H10).
8. **G2 against G1 and G2h.** On the same records G2 and G3 lag G1 at depth 1 (Delta 6, decoupled: 80 vs 97% at N=1,000, 96 vs 100% at 2,000), and lead it at depth 2 at the small N (57 vs 37% at 268, 80 vs 75% at 500). G2h, the split scored on held-out data, needs more records than any other gate: 5,000 against 1,000-2,000 at Delta 6. Its realised gain at Delta 6 and N=1,000 is 0.49 (depth 1) against 0.88 for G1.

## 4. Pulls and weeks to the first real split

Assumptions (stated by the script above its table): all Pulls are random draws until burn-in ends, taken at 102 Pulls (`consumer-burn-in`'s stage-1 boundary median, a 3-Cell draw there, [INFERENCE] counted here as 2-Cell draws), then 1 Pull in 5 is a random draw (`EXPLORE_EVERY = 5`, `ticket-router.mjs:72`), so a record of N random-draw Pulls takes 102 + 5 (N - 102) Pulls for N > 102. Weeks are Pulls / 10, 30, 90 a week. The `Pulls` columns hold those figures; the last two columns are the grid N's weeks at 30 a week if every Pull were at 1 in 5 (5 N) or every Pull were a random draw (N). "Grid N" is the smallest simulated N whose point estimate reaches 80%; "Wilson low >= 80%?" is whether the range's lower end does too. "Interpolated N" joins the P(inj) points by straight lines on log N ([INFERENCE]: the curve between simulated N is not measured).

| design | Delta | gate | depth | P(inj) % by N | grid N at >= 80% | Wilson low >= 80%? | Pulls | weeks @10 | @30 | @90 | interpolated N | Pulls | weeks @10 | @30 | @90 | @30, 5 N | @30, N |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| coupled | 5 | G1 | 1 | 268:19 500:34 1000:49 2000:61 5000:83 10000:91 20000:98 | 5000 | no | 24592 | 2459 | 820 | 273 | 4487 | 22027 | 2203 | 734 | 245 | 833 | 167 |
| coupled | 5 | G1 | 2 | 268:27 500:42 1000:43 2000:46 5000:56 10000:60 20000:74 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 5 | G2 | 1 | 268:14 500:19 1000:27 2000:42 5000:73 10000:90 20000:98 | 10000 | yes | 49592 | 4959 | 1653 | 551 | 6730 | 33242 | 3324 | 1108 | 369 | 1667 | 333 |
| coupled | 5 | G2 | 2 | 268:30 500:43 1000:43 2000:46 5000:56 10000:60 20000:74 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 5 | G3 | 1 | 268:13 500:19 1000:27 2000:42 5000:73 10000:90 20000:98 | 10000 | yes | 49592 | 4959 | 1653 | 551 | 6730 | 33242 | 3324 | 1108 | 369 | 1667 | 333 |
| coupled | 5 | G3 | 2 | 268:25 500:42 1000:43 2000:46 5000:56 10000:60 20000:74 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 5 | G2h | 1 | 268:8 500:9 1000:8 2000:13 5000:42 10000:68 20000:86 | 20000 | no | 99592 | 9959 | 3320 | 1107 | 15874 | 78962 | 7896 | 2632 | 877 | 3333 | 667 |
| coupled | 5 | G2h | 2 | 268:11 500:17 1000:21 2000:36 5000:53 10000:59 20000:60 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 6 | G1 | 1 | 268:33 500:66 1000:80 2000:95 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1022 | 4702 | 470 | 157 | 52.2 | 333 | 66.7 |
| coupled | 6 | G1 | 2 | 268:43 500:62 1000:67 2000:81 5000:91 10000:99 20000:98 | 2000 | no | 9592 | 959 | 320 | 107 | 1877 | 8977 | 898 | 299 | 99.7 | 333 | 66.7 |
| coupled | 6 | G2 | 1 | 268:26 500:45 1000:68 2000:94 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1378 | 6482 | 648 | 216 | 72.0 | 333 | 66.7 |
| coupled | 6 | G2 | 2 | 268:47 500:62 1000:67 2000:81 5000:91 10000:99 20000:98 | 2000 | no | 9592 | 959 | 320 | 107 | 1877 | 8977 | 898 | 299 | 99.7 | 333 | 66.7 |
| coupled | 6 | G3 | 1 | 268:25 500:45 1000:68 2000:94 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1378 | 6482 | 648 | 216 | 72.0 | 333 | 66.7 |
| coupled | 6 | G3 | 2 | 268:43 500:61 1000:67 2000:81 5000:91 10000:99 20000:98 | 2000 | no | 9592 | 959 | 320 | 107 | 1877 | 8977 | 898 | 299 | 99.7 | 333 | 66.7 |
| coupled | 6 | G2h | 1 | 268:15 500:21 1000:35 2000:65 5000:97 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 3073 | 14957 | 1496 | 499 | 166 | 833 | 167 |
| coupled | 6 | G2h | 2 | 268:19 500:35 1000:42 2000:68 5000:84 10000:91 20000:98 | 5000 | no | 24592 | 2459 | 820 | 273 | 3976 | 19472 | 1947 | 649 | 216 | 833 | 167 |
| coupled | 8 | G1 | 1 | 268:67 500:88 1000:97 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 400 | 1592 | 159 | 53.1 | 17.7 | 83.3 | 16.7 |
| coupled | 8 | G1 | 2 | 268:69 500:87 1000:95 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 394 | 1562 | 156 | 52.1 | 17.4 | 83.3 | 16.7 |
| coupled | 8 | G2 | 1 | 268:59 500:86 1000:97 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 434 | 1762 | 176 | 58.7 | 19.6 | 83.3 | 16.7 |
| coupled | 8 | G2 | 2 | 268:72 500:87 1000:95 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 374 | 1462 | 146 | 48.7 | 16.2 | 83.3 | 16.7 |
| coupled | 8 | G3 | 1 | 268:58 500:86 1000:97 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 435 | 1767 | 177 | 58.9 | 19.6 | 83.3 | 16.7 |
| coupled | 8 | G3 | 2 | 268:68 500:87 1000:95 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 398 | 1582 | 158 | 52.7 | 17.6 | 83.3 | 16.7 |
| coupled | 8 | G2h | 1 | 268:33 500:62 1000:84 2000:99 5000:100 10000:100 20000:100 | 1000 | no | 4592 | 459 | 153 | 51.0 | 893 | 4057 | 406 | 135 | 45.1 | 167 | 33.3 |
| coupled | 8 | G2h | 2 | 268:40 500:68 1000:86 2000:96 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 796 | 3572 | 357 | 119 | 39.7 | 167 | 33.3 |
| decoupled | 6 | G1 | 1 | 268:43 500:73 1000:97 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 613 | 2657 | 266 | 88.6 | 29.5 | 167 | 33.3 |
| decoupled | 6 | G1 | 2 | 268:37 500:75 1000:98 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 579 | 2487 | 249 | 82.9 | 27.6 | 167 | 33.3 |
| decoupled | 6 | G2 | 1 | 268:31 500:50 1000:80 2000:96 5000:100 10000:100 20000:100 | 1000 | no | 4592 | 459 | 153 | 51.0 | 1000 | 4592 | 459 | 153 | 51.0 | 167 | 33.3 |
| decoupled | 6 | G2 | 2 | 268:57 500:80 1000:95 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 506 | 2122 | 212 | 70.7 | 23.6 | 167 | 33.3 |
| decoupled | 6 | G3 | 1 | 268:28 500:49 1000:80 2000:96 5000:100 10000:100 20000:100 | 1000 | no | 4592 | 459 | 153 | 51.0 | 1000 | 4592 | 459 | 153 | 51.0 | 167 | 33.3 |
| decoupled | 6 | G3 | 2 | 268:36 500:70 1000:95 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 663 | 2907 | 291 | 96.9 | 32.3 | 167 | 33.3 |
| decoupled | 6 | G2h | 1 | 268:15 500:28 1000:49 2000:78 5000:99 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2211 | 10647 | 1065 | 355 | 118 | 833 | 167 |
| decoupled | 6 | G2h | 2 | 268:16 500:28 1000:43 2000:70 5000:97 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2828 | 13732 | 1373 | 458 | 153 | 833 | 167 |
| padded | 6 | G1 | 1 | 268:33 500:61 1000:79 2000:94 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1046 | 4822 | 482 | 161 | 53.6 | 333 | 66.7 |
| padded | 6 | G1 | 2 | 268:45 500:59 1000:65 2000:77 5000:92 10000:98 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2457 | 11877 | 1188 | 396 | 132 | 833 | 167 |
| padded | 6 | G2 | 1 | 268:26 500:46 1000:69 2000:91 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1420 | 6692 | 669 | 223 | 74.4 | 333 | 66.7 |
| padded | 6 | G2 | 2 | 268:50 500:59 1000:65 2000:77 5000:92 10000:98 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2457 | 11877 | 1188 | 396 | 132 | 833 | 167 |
| padded | 6 | G3 | 1 | 268:25 500:45 1000:69 2000:91 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1420 | 6692 | 669 | 223 | 74.4 | 333 | 66.7 |
| padded | 6 | G3 | 2 | 268:44 500:59 1000:65 2000:77 5000:92 10000:98 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2457 | 11877 | 1188 | 396 | 132 | 833 | 167 |
| padded | 6 | G2h | 1 | 268:11 500:21 1000:37 2000:62 5000:93 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 3419 | 16687 | 1669 | 556 | 185 | 833 | 167 |
| padded | 6 | G2h | 2 | 268:17 500:30 1000:45 2000:63 5000:83 10000:95 20000:100 | 5000 | no | 24592 | 2459 | 820 | 273 | 4437 | 21777 | 2178 | 726 | 242 | 833 | 167 |

Read off that table (grid N, point estimate at or above 80%):

- **Delta 6** (a flip worth $0.87 per merged PR). Decoupled: N=1,000 for G1 at both depths, for G2 and G3 at depth 2 and, at exactly 80% (Wilson low end under 80%), for G2 and G3 at depth 1; N=5,000 for G2h. Coupled: N=2,000 for G1, G2 and G3 at depth 1 (the depth-2 ones reach 81%, Wilson low end under 80%), N=5,000 for G2h. Padded: N=2,000 for G1, G2, G3 at depth 1; N=5,000 at depth 2 and for G2h.
- **Delta 8** (a flip worth $1.88): N=500 for G1, G2 and G3 at both depths, N=1,000 for G2h.
- **Delta 5** (a flip worth $0.36): N=5,000 for G1 at depth 1, N=10,000 for G2 and G3 at depth 1, N=20,000 for G2h at depth 1 (point estimate 86%, Wilson low end under 80%); no gate at depth 2 reaches 80% by N=20,000.
- Pulls and weeks for the Ns that appear above, at 10 / 30 / 90 Pulls a week: N=500: 2,092 Pulls, 209 / 70 / 23 weeks. N=1,000: 4,592 Pulls, 459 / 153 / 51 weeks. N=2,000: 9,592 Pulls, 959 / 320 / 107 weeks. N=5,000: 24,592 Pulls, 2,459 / 820 / 273 weeks. N=10,000: 49,592 Pulls, 4,959 / 1,653 / 551 weeks. N=20,000: 99,592 Pulls, 9,959 / 3,320 / 1,107 weeks. If every Pull were a random draw, N=1,000 is 100 / 33 / 11 weeks and N=2,000 is 200 / 67 / 22; if every Pull from the first were at 1 in 5, N=1,000 is 500 / 167 / 56 weeks.

## 5. The one-Cell baseline

The realised gain in §3 is scored against each record's own one-Cell choice. Appendix B counts how often that choice is slow-high: at N=268, 5% of records at Delta 0 and 2, 6% at 4, 9% at 5, 16% at 6 and 44% at 8; at N=500, 1% at Delta 0-4, 5% at 6, 43% at 8; at N=1,000, 0% to Delta 5, 2% at 6, 31% at 8; at N=20,000, 0% to Delta 6 and 4% at 8. The 5% and 1% at Delta 0 are records in which task-high is under the quality floor against slow-high (`underFloor`, 15 points; its failure rate in the pool is 28 of 104 claims against slow-high's 20 of 104, 7.7 points apart); at Delta 8 the pooled gap is about -$0.3 and the choice is cost-driven.

## 6. Where the measurements differ from the ticket's framing

- **Same candidate count as router-inputs.** Not so for the design as written: nine recorded inputs plus the injected one give 21.3 cuts on average per record (21.2 for `decoupled`) and 221.6 depth-2 partitions, against router-inputs' 25 cuts over 15 inputs (it added six free inputs read off the issue text). The `padded` family adds four fair-coin decoys to reach 25.3 cuts and 316.0 partitions; its numbers are in H3, H8 and Appendix A §3.3.
- **"The real 268-Pull record".** The two-Cell search has 208 Pulls (§1); smol-high's Pulls are not in it.
- **Delta 2 and 4 do not flip the cheapest Cell.** With a pooled gap of $-4.2 on the injected-input-0 side and $-2.3 / $-0.3 on the other, task-high stays cheapest on both sides; the true gain of any split on the injected input is 0 (§2). The ticket's "flips the cheapest Cell on one side" holds from Delta 5 up. The tables report the injected-input share at Delta 2 and 4 as measured (item 6 above), with no true split to find.
- **Delta 0 is a false-split rate only for `decoupled`.** In `coupled` and `padded`, decoys keep their Pulls' outcome structure, the 208 Pulls' sampling noise made population fact by resampling, and at large N the gates find it (item 2 above; Appendix A §3.1, §3.3). Appendix A §3.2 is the family in which every decoy is a true null.
- **The random draws after burn-in are not a draw between slow-high and task-high.** `rowDispatch` (`ticket-router.mjs:217-221`) removes the policy row's Cell from the exploration draw's Cells once burn-in ends, and `route` draws from what is left (`:330-338`, `drawCell` with `policyCell: null`). [INFERENCE from reading the code; not simulated] With a table of slow-high and task-high only, the exploring Pull (1 in 5, `implRow % 5 === 0 && !chainHead`) runs at the one Cell that is not the policy row's, and the other 4 in 5 run at the policy row's Cell. The 1-in-5 share used in §4 is the ticket's assumption; the simulated records, and the gates' propensity of 1/2, treat the logged draws as a fair 50/50 draw between the two Cells. With three live Cells the draw is uniform over the two non-policy Cells.
- **Burn-in Pulls are 3-Cell draws.** `consumer-burn-in`'s 102-Pull boundary is for three stage-1 Cells; a slow-high/task-high record built from them holds about two thirds as many Pulls. §4 counts all 102 as 2-Cell draws ([INFERENCE]).

## 7. What was not measured

- Each gate is applied once to a record of fixed size N. A gate checked at every Fit as the record grows (repeated looks) is not simulated; its chance-split rate and its first-split time are not measured here.
- After a first split the tree's later splits, depth beyond 2, and the per-group recheck are not simulated.
- Only the $ per merged PR objective was gated. Minutes, the fail-rate leg of the floor as an objective, and a floor that trips are not varied; the floor enters only through `underFloor` at the group level.
- Effects other than a fair-coin binary input with a $Delta shift on task-high alone: no effect on slow-high, no continuous or numeric-threshold effect, no effect on a minority side, no heteroscedastic noise.
- smol-high, the six free inputs of router-inputs, and effort Cells.
- G1 uses 99 shuffles per record (its p-values lie on a 0.01 grid); G2's lower bound is a normal approximation on the per-Pull doubly robust differences, with the propensity set to the known 1/2; neither is calibrated beyond what H1 shows.
- The interpolated Ns in §4 and the 102-Pull burn-in boundary are inferences, as marked.
- The ticket's candidate gates were read as written; the exact estimator for G2 (cross-fitted group x Cell outcome model; one-sided 95% normal lower bound) is this note's choice, not the source note's.

## Appendix A. Derive output (full run)

`node docs/research/split-gate-derive.mjs`, stdout, headings demoted one level.

## split-gate derive output

Repository HEAD e810699f; window start 2026-10-03; 268 Pulls in the window, 268 in the Fit's set (ticket-router.mjs:382-385); 240 counted newest-generation Pulls, of which 208 slow-high or task-high (slow-high 104, task-high 104); MIN_N 20, TRIP_POINTS 15; seed 20261101.
Settings: sims per N 268:400 500:400 1000:400 2000:300 5000:200 10000:100 20000:50; decoupled-decoy sims 268:400 500:400 1000:400 2000:300 5000:200 10000:100 20000:50; G1 shuffles per record 99; reference sample 200000 Pulls; workers 8; deltas 0,2,4,5,6,8.

### 0. The pool the simulation resamples

Counted newest-generation slow-high and task-high Pulls, by draw-set period (A: K=3, B: K=2; the period is each Pull's recorded K). $ = $/Pull (= $/merged PR: all merged); fail = falseClaims/claims.

| period | Cell | n | $/Pull mean (sd) | failed/claims |
|---|---|---|---|---|
| A (K=3) | slow-high | 50 | 14.16 (9.26) | 13/50 |
| A (K=3) | task-high | 60 | 10.47 (6.69) | 19/60 |
| B (K=2) | slow-high | 54 | 14.83 (10.82) | 7/54 |
| B (K=2) | task-high | 44 | 10.02 (5.41) | 9/44 |

Pooled over both periods (the pairs' Pull mean): slow-high 14.51, task-high 10.28, gap task-high - slow-high -4.23. Simulated population (period A share 0.53, each Cell drawn at 1/2, Pull resampled within period and Cell): slow-high 14.47, task-high 10.26, gap -4.22 (router-inputs reports a pooled gap of -4.23).
Per-Pull $ sd / mean: slow-high 0.69, task-high 0.60 (coefficient of variation).

### 1. The real record

208 Pulls (slow-high 104, task-high 104); no injected input; 18 candidate cuts over 8 of the nine recorded inputs (router-inputs, with six free inputs added: 25 cuts over 15 inputs), 18 one-cut and 138 two-cut partitions. The router-inputs gain engine, $ per merged PR, minN 20.

G1 null: 1999 shuffles of the whole outcome tuple against the inputs, the same search. G2: cross-fitted doubly robust difference (5 folds, propensity 1/2), one-sided 95% lower bound. G2h: the split is chosen on a random half and scored on the other half; the row below is the share of 200 random halves that pass.

| depth | best split | in-sample gain $/merged | null 95th pct | G1 p | G2 DR gain [LCB] | G1 | G2 | G3 |
|---|---|---|---|---|---|---|---|---|
| 1 | (none moves a group) | 0.00 | 0.17 | 1.000 | 0.00 [-] | no | no | no |
| 2 | brief_chars > 4047.5 & paths > 4 | 0.08 | 0.52 | 0.545 | 0.01 [-0.69] | no | no | no |

G2h over 200 random train/test halves: depth 1 passes 18, depth 2 passes 18.

Baseline Cell (one group, lowest $ clearing the floor): task-high.
(Cross-check against router-inputs § 5.1, whose search also had six free inputs: depth-1 best $ gain 0.00, null 95th pct 0.22; depth-2 best 0.08, 0.60.)

### 2. What the injected effect is worth

Reference sample 200000 Pulls drawn like the records (coupled decoys). Per side of the injected bit: task-high - slow-high $ gap; one-Cell choice; best-split gain over it (the gain an unlimited-data split on the injected bit would realise, $ per merged PR, groups weighted by Pull share).

| Delta | gap bit=0 | gap bit=1 | one-Cell choice | split picks (bit=0 / bit=1) | oracle gain $ | % of one-Cell value |
|---|---|---|---|---|---|---|
| 0 | -4.20 | -4.28 | task-high | task-high / task-high | 0.00 | 0.0% |
| 2 | -4.20 | -2.28 | task-high | task-high / task-high | 0.00 | 0.0% |
| 4 | -4.20 | -0.28 | task-high | task-high / task-high | 0.00 | 0.0% |
| 5 | -4.20 | 0.72 | task-high | task-high / slow-high | 0.36 | 2.8% |
| 6 | -4.20 | 1.72 | task-high | task-high / slow-high | 0.87 | 6.5% |
| 8 | -4.20 | 3.72 | task-high | task-high / slow-high | 1.88 | 13.1% |

Slow-high is the cheapest Cell on the injected side once Delta exceeds the pooled gap (about 4.2). Below it the split changes no group's Cell, so its true gain is 0 and a split on it is a chance split that buys nothing.

### 3. Detection and false-split tables

Records built as in the issue: N Pulls, each period drawn at its real share, Cell drawn 1/2 per Pull, the Pull resampled with replacement within that period and Cell (its $, minutes, failed and its nine recorded inputs stay together). A fair-coin injected input is added; on its side 1 each task-high Pull's $ rises by Delta. Search size per record, mean: coupled: 21.3 cuts (20.3 on the nine recorded inputs and the coins) and 221.6 partitions; decoupled: 21.2 cuts (20.2 on the nine recorded inputs and the coins) and 219.1 partitions; padded: 25.3 cuts (24.3 on the nine recorded inputs and the coins) and 316.0 partitions; router-inputs' search was 25 cuts over 15 inputs. G1: p = (1 + #shuffles whose best gain >= the real best)/(99 + 1) <= 0.05 (the real best beats the 95th percentile of the same search on shuffled inputs). G2: one-sided 95% lower bound of the cross-fitted doubly robust difference (one Cell minus the split) > 0, estimated on the record the split was chosen on. G3: G1 and G2. G2h: as G2, but the split is chosen on a random half and scored on the other.

Columns: `inj` = share of simulated records whose adopted split uses the injected input; `decoy` = share whose adopted split uses at least one recorded (decoy) input; `any` = share that split at all; `decoy-only` = split on decoys and not on the injected input; `gain` = mean realised gain in $ per merged PR (± 1 s.e.) of the adopted policy over the record's one-Cell choice, scored on the reference sample, 0 when no split; ranges are 95% Wilson ranges. `best` = mean in-sample best gain; `null95` = mean G1 null 95th percentile (depth <= d).

#### 3.1 Decoy inputs resampled with their Pulls (the issue's design)

**G1, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 16 [13-20] | 16 | 16 | 0.01 (0.03) | 0.26 | 0.31 |
| 268 | 2 | 400 | 0 [0-1] | 23 [19-27] | 23 | 23 | 0.01 (0.03) | 0.35 | 0.45 |
| 268 | 4 | 400 | 8 [6-11] | 27 [23-31] | 35 | 27 | 0.03 (0.02) | 0.61 | 0.66 |
| 268 | 5 | 400 | 19 [15-23] | 26 [22-30] | 45 | 26 | 0.17 (0.02) | 0.82 | 0.79 |
| 268 | 6 | 400 | 33 [29-38] | 25 [21-30] | 59 | 25 | 0.49 (0.03) | 1.07 | 0.92 |
| 268 | 8 | 400 | 67 [62-71] | 18 [14-22] | 84 | 18 | 1.44 (0.04) | 1.58 | 1.09 |
| 500 | 0 | 400 | 0 [0-1] | 14 [11-18] | 14 | 14 | -0.02 (0.02) | 0.05 | 0.06 |
| 500 | 2 | 400 | 0 [0-1] | 26 [22-31] | 26 | 26 | -0.04 (0.01) | 0.13 | 0.16 |
| 500 | 4 | 400 | 13 [10-17] | 40 [35-45] | 53 | 40 | -0.01 (0.01) | 0.37 | 0.32 |
| 500 | 5 | 400 | 34 [30-39] | 39 [34-43] | 73 | 39 | 0.19 (0.01) | 0.63 | 0.43 |
| 500 | 6 | 400 | 66 [61-70] | 26 [22-31] | 92 | 26 | 0.71 (0.02) | 0.98 | 0.56 |
| 500 | 8 | 400 | 88 [84-90] | 11 [9-15] | 99 | 11 | 1.82 (0.02) | 1.71 | 0.80 |
| 1000 | 0 | 400 | 0 [0-1] | 32 [27-36] | 32 | 32 | -0.02 (0.00) | 0.02 | 0.00 |
| 1000 | 2 | 400 | 0 [0-1] | 55 [50-59] | 55 | 55 | -0.01 (0.01) | 0.08 | 0.03 |
| 1000 | 4 | 400 | 14 [11-18] | 69 [64-73] | 83 | 69 | 0.01 (0.01) | 0.27 | 0.13 |
| 1000 | 5 | 400 | 49 [44-54] | 48 [43-53] | 97 | 48 | 0.25 (0.01) | 0.53 | 0.21 |
| 1000 | 6 | 400 | 80 [75-83] | 20 [16-24] | 100 | 20 | 0.79 (0.02) | 0.92 | 0.32 |
| 1000 | 8 | 400 | 97 [95-98] | 3 [2-5] | 100 | 3 | 1.92 (0.01) | 1.77 | 0.56 |
| 2000 | 0 | 300 | 0 [0-1] | 25 [20-30] | 25 | 25 | -0.01 (0.00) | 0.01 | 0.00 |
| 2000 | 2 | 300 | 0 [0-1] | 70 [64-75] | 70 | 70 | 0.03 (0.00) | 0.06 | 0.01 |
| 2000 | 4 | 300 | 10 [7-14] | 87 [83-90] | 97 | 87 | 0.07 (0.01) | 0.20 | 0.04 |
| 2000 | 5 | 300 | 61 [56-67] | 38 [33-44] | 100 | 38 | 0.29 (0.01) | 0.45 | 0.09 |
| 2000 | 6 | 300 | 95 [92-97] | 5 [3-8] | 100 | 5 | 0.85 (0.01) | 0.89 | 0.16 |
| 2000 | 8 | 300 | 100 [99-100] | 0 [0-1] | 100 | 0 | 1.93 (0.01) | 1.82 | 0.39 |
| 5000 | 0 | 200 | 0 [0-2] | 22 [16-28] | 22 | 22 | -0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 2 | 200 | 0 [0-2] | 88 [82-91] | 88 | 88 | 0.06 (0.00) | 0.06 | 0.00 |
| 5000 | 4 | 200 | 7 [4-11] | 93 [89-96] | 100 | 93 | 0.12 (0.01) | 0.17 | 0.01 |
| 5000 | 5 | 200 | 83 [77-87] | 18 [13-23] | 100 | 18 | 0.34 (0.00) | 0.43 | 0.02 |
| 5000 | 6 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 0.87 (0.00) | 0.91 | 0.05 |
| 5000 | 8 | 200 | 100 [98-100] | 0 [0-2] | 100 | 0 | 1.92 (0.01) | 1.89 | 0.24 |
| 10000 | 0 | 100 | 0 [0-4] | 11 [6-19] | 11 | 11 | -0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 95 [89-98] | 95 | 95 | 0.07 (0.00) | 0.05 | 0.00 |
| 10000 | 4 | 100 | 1 [0-5] | 99 [95-100] | 100 | 99 | 0.14 (0.00) | 0.16 | 0.00 |
| 10000 | 5 | 100 | 91 [84-95] | 9 [5-16] | 100 | 9 | 0.35 (0.00) | 0.41 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.87 (0.00) | 0.90 | 0.02 |
| 10000 | 8 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 1.90 (0.01) | 1.89 | 0.15 |
| 20000 | 0 | 50 | 0 [0-7] | 6 [2-16] | 6 | 6 | -0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.07 (0.00) | 0.05 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.15 (0.00) | 0.15 | 0.00 |
| 20000 | 5 | 50 | 98 [90-100] | 2 [0-10] | 100 | 2 | 0.36 (0.00) | 0.39 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.87 (0.00) | 0.89 | 0.00 |
| 20000 | 8 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 1.88 (0.00) | 1.89 | 0.10 |

**G2, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 7 [5-10] | 7 | 7 | 0.20 (0.04) | 0.26 | 0.31 |
| 268 | 2 | 400 | 0 [0-1] | 11 [8-14] | 11 | 11 | 0.15 (0.03) | 0.35 | 0.45 |
| 268 | 4 | 400 | 3 [2-5] | 18 [15-22] | 21 | 18 | 0.13 (0.03) | 0.61 | 0.66 |
| 268 | 5 | 400 | 14 [11-18] | 22 [18-27] | 37 | 22 | 0.19 (0.02) | 0.82 | 0.79 |
| 268 | 6 | 400 | 26 [22-31] | 24 [20-29] | 50 | 24 | 0.43 (0.03) | 1.07 | 0.92 |
| 268 | 8 | 400 | 59 [54-63] | 21 [18-26] | 80 | 21 | 1.30 (0.04) | 1.58 | 1.09 |
| 500 | 0 | 400 | 0 [0-1] | 3 [2-5] | 3 | 3 | 0.03 (0.02) | 0.05 | 0.06 |
| 500 | 2 | 400 | 0 [0-1] | 6 [4-8] | 6 | 6 | 0.02 (0.01) | 0.13 | 0.16 |
| 500 | 4 | 400 | 4 [2-6] | 16 [13-20] | 20 | 16 | 0.02 (0.01) | 0.37 | 0.32 |
| 500 | 5 | 400 | 19 [15-23] | 18 [14-22] | 36 | 18 | 0.11 (0.01) | 0.63 | 0.43 |
| 500 | 6 | 400 | 45 [40-50] | 16 [13-20] | 62 | 16 | 0.51 (0.03) | 0.98 | 0.56 |
| 500 | 8 | 400 | 86 [83-89] | 11 [8-14] | 97 | 11 | 1.79 (0.02) | 1.71 | 0.80 |
| 1000 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | -0.00 (0.00) | 0.02 | 0.00 |
| 1000 | 2 | 400 | 0 [0-1] | 12 [9-16] | 12 | 12 | 0.01 (0.00) | 0.08 | 0.03 |
| 1000 | 4 | 400 | 4 [2-6] | 28 [23-32] | 31 | 28 | 0.02 (0.00) | 0.27 | 0.13 |
| 1000 | 5 | 400 | 27 [23-32] | 27 [22-31] | 54 | 27 | 0.15 (0.01) | 0.53 | 0.21 |
| 1000 | 6 | 400 | 68 [64-73] | 16 [13-20] | 84 | 16 | 0.68 (0.02) | 0.92 | 0.32 |
| 1000 | 8 | 400 | 97 [95-98] | 3 [2-5] | 100 | 3 | 1.92 (0.01) | 1.77 | 0.56 |
| 2000 | 0 | 300 | 0 [0-1] | 2 [1-4] | 2 | 2 | -0.00 (0.00) | 0.01 | 0.00 |
| 2000 | 2 | 300 | 0 [0-1] | 12 [9-16] | 12 | 12 | 0.01 (0.00) | 0.06 | 0.01 |
| 2000 | 4 | 300 | 2 [1-5] | 41 [35-46] | 43 | 41 | 0.05 (0.00) | 0.20 | 0.04 |
| 2000 | 5 | 300 | 42 [36-47] | 30 [25-35] | 72 | 30 | 0.21 (0.01) | 0.45 | 0.09 |
| 2000 | 6 | 300 | 94 [90-96] | 4 [3-7] | 98 | 4 | 0.83 (0.01) | 0.89 | 0.16 |
| 2000 | 8 | 300 | 100 [99-100] | 0 [0-1] | 100 | 0 | 1.93 (0.01) | 1.82 | 0.39 |
| 5000 | 0 | 200 | 0 [0-2] | 1 [0-4] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 2 | 200 | 0 [0-2] | 34 [28-41] | 34 | 34 | 0.02 (0.00) | 0.06 | 0.00 |
| 5000 | 4 | 200 | 2 [1-5] | 81 [75-86] | 83 | 81 | 0.11 (0.01) | 0.17 | 0.01 |
| 5000 | 5 | 200 | 73 [66-78] | 17 [12-22] | 89 | 17 | 0.30 (0.01) | 0.43 | 0.02 |
| 5000 | 6 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 0.87 (0.00) | 0.91 | 0.05 |
| 5000 | 8 | 200 | 100 [98-100] | 0 [0-2] | 100 | 0 | 1.92 (0.01) | 1.89 | 0.24 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 45 [36-55] | 45 | 45 | 0.03 (0.00) | 0.05 | 0.00 |
| 10000 | 4 | 100 | 0 [0-4] | 99 [95-100] | 99 | 99 | 0.15 (0.00) | 0.16 | 0.00 |
| 10000 | 5 | 100 | 90 [83-94] | 9 [5-16] | 99 | 9 | 0.35 (0.01) | 0.41 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.87 (0.00) | 0.90 | 0.02 |
| 10000 | 8 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 1.90 (0.01) | 1.89 | 0.15 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 72 [58-83] | 72 | 72 | 0.05 (0.00) | 0.05 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.15 (0.00) | 0.15 | 0.00 |
| 20000 | 5 | 50 | 98 [90-100] | 2 [0-10] | 100 | 2 | 0.36 (0.00) | 0.39 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.87 (0.00) | 0.89 | 0.00 |
| 20000 | 8 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 1.88 (0.00) | 1.89 | 0.10 |

**G3, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 3 [2-5] | 3 | 3 | 0.08 (0.03) | 0.26 | 0.31 |
| 268 | 2 | 400 | 0 [0-1] | 7 [5-10] | 7 | 7 | 0.07 (0.02) | 0.35 | 0.45 |
| 268 | 4 | 400 | 2 [1-4] | 13 [10-16] | 14 | 13 | 0.06 (0.02) | 0.61 | 0.66 |
| 268 | 5 | 400 | 13 [10-17] | 18 [14-22] | 31 | 18 | 0.15 (0.02) | 0.82 | 0.79 |
| 268 | 6 | 400 | 25 [21-29] | 19 [15-23] | 44 | 19 | 0.38 (0.03) | 1.07 | 0.92 |
| 268 | 8 | 400 | 58 [53-63] | 15 [12-19] | 73 | 15 | 1.26 (0.04) | 1.58 | 1.09 |
| 500 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | 0.02 (0.01) | 0.05 | 0.06 |
| 500 | 2 | 400 | 0 [0-1] | 5 [3-8] | 5 | 5 | 0.01 (0.01) | 0.13 | 0.16 |
| 500 | 4 | 400 | 4 [2-6] | 14 [11-18] | 19 | 14 | 0.02 (0.01) | 0.37 | 0.32 |
| 500 | 5 | 400 | 19 [15-23] | 18 [14-22] | 36 | 18 | 0.11 (0.01) | 0.63 | 0.43 |
| 500 | 6 | 400 | 45 [40-50] | 15 [12-19] | 60 | 15 | 0.50 (0.03) | 0.98 | 0.56 |
| 500 | 8 | 400 | 86 [83-89] | 11 [8-14] | 97 | 11 | 1.79 (0.02) | 1.71 | 0.80 |
| 1000 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | -0.00 (0.00) | 0.02 | 0.00 |
| 1000 | 2 | 400 | 0 [0-1] | 12 [9-16] | 12 | 12 | 0.01 (0.00) | 0.08 | 0.03 |
| 1000 | 4 | 400 | 4 [2-6] | 27 [23-32] | 31 | 27 | 0.02 (0.00) | 0.27 | 0.13 |
| 1000 | 5 | 400 | 27 [23-32] | 27 [22-31] | 54 | 27 | 0.15 (0.01) | 0.53 | 0.21 |
| 1000 | 6 | 400 | 68 [64-73] | 16 [13-20] | 84 | 16 | 0.68 (0.02) | 0.92 | 0.32 |
| 1000 | 8 | 400 | 97 [95-98] | 3 [2-5] | 100 | 3 | 1.92 (0.01) | 1.77 | 0.56 |
| 2000 | 0 | 300 | 0 [0-1] | 2 [1-4] | 2 | 2 | -0.00 (0.00) | 0.01 | 0.00 |
| 2000 | 2 | 300 | 0 [0-1] | 12 [9-16] | 12 | 12 | 0.01 (0.00) | 0.06 | 0.01 |
| 2000 | 4 | 300 | 2 [1-5] | 41 [35-46] | 43 | 41 | 0.05 (0.00) | 0.20 | 0.04 |
| 2000 | 5 | 300 | 42 [36-47] | 30 [25-35] | 72 | 30 | 0.21 (0.01) | 0.45 | 0.09 |
| 2000 | 6 | 300 | 94 [90-96] | 4 [3-7] | 98 | 4 | 0.83 (0.01) | 0.89 | 0.16 |
| 2000 | 8 | 300 | 100 [99-100] | 0 [0-1] | 100 | 0 | 1.93 (0.01) | 1.82 | 0.39 |
| 5000 | 0 | 200 | 0 [0-2] | 1 [0-4] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 2 | 200 | 0 [0-2] | 34 [28-41] | 34 | 34 | 0.02 (0.00) | 0.06 | 0.00 |
| 5000 | 4 | 200 | 2 [1-5] | 81 [75-86] | 83 | 81 | 0.11 (0.01) | 0.17 | 0.01 |
| 5000 | 5 | 200 | 73 [66-78] | 17 [12-22] | 89 | 17 | 0.30 (0.01) | 0.43 | 0.02 |
| 5000 | 6 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 0.87 (0.00) | 0.91 | 0.05 |
| 5000 | 8 | 200 | 100 [98-100] | 0 [0-2] | 100 | 0 | 1.92 (0.01) | 1.89 | 0.24 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 45 [36-55] | 45 | 45 | 0.03 (0.00) | 0.05 | 0.00 |
| 10000 | 4 | 100 | 0 [0-4] | 99 [95-100] | 99 | 99 | 0.15 (0.00) | 0.16 | 0.00 |
| 10000 | 5 | 100 | 90 [83-94] | 9 [5-16] | 99 | 9 | 0.35 (0.01) | 0.41 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.87 (0.00) | 0.90 | 0.02 |
| 10000 | 8 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 1.90 (0.01) | 1.89 | 0.15 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 72 [58-83] | 72 | 72 | 0.05 (0.00) | 0.05 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.15 (0.00) | 0.15 | 0.00 |
| 20000 | 5 | 50 | 98 [90-100] | 2 [0-10] | 100 | 2 | 0.36 (0.00) | 0.39 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.87 (0.00) | 0.89 | 0.00 |
| 20000 | 8 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 1.88 (0.00) | 1.89 | 0.10 |

**G2h, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 9 [6-12] | 9 | 9 | 0.27 (0.05) | 0.26 | 0.31 |
| 268 | 2 | 400 | 0 [0-1] | 9 [6-12] | 9 | 9 | 0.19 (0.04) | 0.35 | 0.45 |
| 268 | 4 | 400 | 3 [2-5] | 8 [6-11] | 11 | 8 | 0.15 (0.03) | 0.61 | 0.66 |
| 268 | 5 | 400 | 8 [6-11] | 7 [5-10] | 14 | 7 | 0.15 (0.03) | 0.82 | 0.79 |
| 268 | 6 | 400 | 15 [12-19] | 8 [6-11] | 23 | 8 | 0.25 (0.03) | 1.07 | 0.92 |
| 268 | 8 | 400 | 33 [28-37] | 9 [7-12] | 42 | 9 | 0.71 (0.05) | 1.58 | 1.09 |
| 500 | 0 | 400 | 0 [0-1] | 6 [4-9] | 6 | 6 | 0.25 (0.05) | 0.05 | 0.06 |
| 500 | 2 | 400 | 0 [0-1] | 6 [4-9] | 6 | 6 | 0.17 (0.04) | 0.13 | 0.16 |
| 500 | 4 | 400 | 3 [1-5] | 8 [5-11] | 10 | 8 | 0.15 (0.03) | 0.37 | 0.32 |
| 500 | 5 | 400 | 9 [6-12] | 8 [6-11] | 17 | 8 | 0.16 (0.03) | 0.63 | 0.43 |
| 500 | 6 | 400 | 21 [17-25] | 8 [6-11] | 29 | 8 | 0.33 (0.03) | 0.98 | 0.56 |
| 500 | 8 | 400 | 62 [57-67] | 8 [6-11] | 70 | 8 | 1.28 (0.04) | 1.71 | 0.80 |
| 1000 | 0 | 400 | 0 [0-1] | 1 [0-2] | 1 | 1 | 0.03 (0.02) | 0.02 | 0.00 |
| 1000 | 2 | 400 | 0 [0-1] | 3 [2-5] | 3 | 3 | 0.02 (0.01) | 0.08 | 0.03 |
| 1000 | 4 | 400 | 1 [0-3] | 6 [4-8] | 7 | 6 | 0.02 (0.01) | 0.27 | 0.13 |
| 1000 | 5 | 400 | 8 [6-11] | 6 [4-9] | 14 | 6 | 0.07 (0.01) | 0.53 | 0.21 |
| 1000 | 6 | 400 | 35 [31-40] | 8 [5-11] | 43 | 8 | 0.40 (0.03) | 0.92 | 0.32 |
| 1000 | 8 | 400 | 84 [80-87] | 7 [4-9] | 90 | 7 | 1.69 (0.03) | 1.77 | 0.56 |
| 2000 | 0 | 300 | 0 [0-1] | 1 [0-3] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 2000 | 2 | 300 | 0 [0-1] | 7 [4-10] | 7 | 7 | 0.00 (0.00) | 0.06 | 0.01 |
| 2000 | 4 | 300 | 0 [0-2] | 13 [10-17] | 13 | 13 | 0.02 (0.00) | 0.20 | 0.04 |
| 2000 | 5 | 300 | 13 [10-17] | 10 [7-14] | 23 | 10 | 0.07 (0.01) | 0.45 | 0.09 |
| 2000 | 6 | 300 | 65 [59-70] | 6 [4-9] | 71 | 6 | 0.60 (0.02) | 0.89 | 0.16 |
| 2000 | 8 | 300 | 99 [97-100] | 0 [0-2] | 99 | 0 | 1.92 (0.01) | 1.82 | 0.39 |
| 5000 | 0 | 200 | 0 [0-2] | 0 [0-2] | 0 | 0 | 0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 2 | 200 | 0 [0-2] | 18 [13-23] | 18 | 18 | 0.01 (0.00) | 0.06 | 0.00 |
| 5000 | 4 | 200 | 0 [0-2] | 44 [37-51] | 44 | 44 | 0.07 (0.01) | 0.17 | 0.01 |
| 5000 | 5 | 200 | 42 [35-48] | 17 [12-22] | 58 | 17 | 0.18 (0.01) | 0.43 | 0.02 |
| 5000 | 6 | 200 | 97 [94-99] | 1 [0-4] | 98 | 1 | 0.85 (0.01) | 0.91 | 0.05 |
| 5000 | 8 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 1.94 (0.01) | 1.89 | 0.24 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 24 [17-33] | 24 | 24 | 0.02 (0.00) | 0.05 | 0.00 |
| 10000 | 4 | 100 | 0 [0-4] | 66 [56-75] | 66 | 66 | 0.10 (0.01) | 0.16 | 0.00 |
| 10000 | 5 | 100 | 68 [58-76] | 7 [3-14] | 75 | 7 | 0.26 (0.02) | 0.41 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.87 (0.00) | 0.90 | 0.02 |
| 10000 | 8 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 1.91 (0.01) | 1.89 | 0.15 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 42 [29-56] | 42 | 42 | 0.03 (0.00) | 0.05 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 86 [74-93] | 86 | 86 | 0.14 (0.01) | 0.15 | 0.00 |
| 20000 | 5 | 50 | 86 [74-93] | 10 [4-21] | 96 | 10 | 0.34 (0.01) | 0.39 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.87 (0.00) | 0.89 | 0.00 |
| 20000 | 8 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 1.90 (0.01) | 1.89 | 0.10 |

**G1, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [0-2] | 45 [40-50] | 45 | 44 | 0.09 (0.03) | 0.63 | 0.61 |
| 268 | 2 | 400 | 3 [2-5] | 56 [51-61] | 56 | 54 | 0.18 (0.03) | 0.84 | 0.77 |
| 268 | 4 | 400 | 13 [10-16] | 66 [61-71] | 66 | 54 | 0.34 (0.03) | 1.13 | 1.00 |
| 268 | 5 | 400 | 27 [23-31] | 76 [72-80] | 77 | 50 | 0.53 (0.03) | 1.34 | 1.13 |
| 268 | 6 | 400 | 43 [38-48] | 84 [80-87] | 85 | 41 | 0.83 (0.03) | 1.57 | 1.26 |
| 268 | 8 | 400 | 69 [64-73] | 90 [87-93] | 92 | 23 | 1.58 (0.03) | 2.02 | 1.44 |
| 500 | 0 | 400 | 1 [1-3] | 70 [66-75] | 70 | 69 | 0.08 (0.02) | 0.35 | 0.27 |
| 500 | 2 | 400 | 1 [1-3] | 82 [78-86] | 82 | 81 | 0.20 (0.02) | 0.55 | 0.39 |
| 500 | 4 | 400 | 22 [18-26] | 94 [92-96] | 95 | 73 | 0.36 (0.02) | 0.86 | 0.57 |
| 500 | 5 | 400 | 42 [37-47] | 97 [95-98] | 98 | 56 | 0.58 (0.02) | 1.10 | 0.70 |
| 500 | 6 | 400 | 62 [57-66] | 99 [98-100] | 100 | 38 | 0.96 (0.02) | 1.40 | 0.84 |
| 500 | 8 | 400 | 87 [83-90] | 99 [98-100] | 100 | 13 | 1.92 (0.02) | 2.05 | 1.10 |
| 1000 | 0 | 400 | 0 [0-1] | 99 [98-100] | 99 | 99 | 0.25 (0.01) | 0.36 | 0.12 |
| 1000 | 2 | 400 | 1 [0-2] | 100 [99-100] | 100 | 99 | 0.42 (0.01) | 0.55 | 0.19 |
| 1000 | 4 | 400 | 15 [12-19] | 100 [99-100] | 100 | 85 | 0.58 (0.01) | 0.82 | 0.31 |
| 1000 | 5 | 400 | 43 [38-47] | 100 [99-100] | 100 | 57 | 0.77 (0.01) | 1.04 | 0.40 |
| 1000 | 6 | 400 | 67 [62-71] | 100 [99-100] | 100 | 33 | 1.12 (0.01) | 1.35 | 0.52 |
| 1000 | 8 | 400 | 95 [93-97] | 100 [99-100] | 100 | 5 | 2.03 (0.01) | 2.07 | 0.79 |
| 2000 | 0 | 300 | 0 [0-1] | 100 [99-100] | 100 | 100 | 0.29 (0.01) | 0.33 | 0.05 |
| 2000 | 2 | 300 | 0 [0-1] | 100 [99-100] | 100 | 100 | 0.47 (0.01) | 0.52 | 0.09 |
| 2000 | 4 | 300 | 10 [7-14] | 100 [99-100] | 100 | 90 | 0.66 (0.01) | 0.76 | 0.16 |
| 2000 | 5 | 300 | 46 [40-52] | 100 [99-100] | 100 | 54 | 0.84 (0.01) | 0.97 | 0.21 |
| 2000 | 6 | 300 | 81 [77-85] | 100 [99-100] | 100 | 19 | 1.18 (0.01) | 1.29 | 0.30 |
| 2000 | 8 | 300 | 100 [98-100] | 100 [99-100] | 100 | 0 | 2.07 (0.01) | 2.07 | 0.55 |
| 5000 | 0 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.34 (0.01) | 0.35 | 0.02 |
| 5000 | 2 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.51 (0.01) | 0.53 | 0.03 |
| 5000 | 4 | 200 | 5 [2-8] | 100 [98-100] | 100 | 96 | 0.72 (0.01) | 0.75 | 0.06 |
| 5000 | 5 | 200 | 56 [49-62] | 100 [98-100] | 100 | 45 | 0.87 (0.01) | 0.95 | 0.08 |
| 5000 | 6 | 200 | 91 [86-94] | 100 [98-100] | 100 | 10 | 1.23 (0.00) | 1.29 | 0.13 |
| 5000 | 8 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 2.07 (0.01) | 2.09 | 0.35 |
| 10000 | 0 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.34 (0.01) | 0.34 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.52 (0.01) | 0.51 | 0.01 |
| 10000 | 4 | 100 | 5 [2-11] | 100 [96-100] | 100 | 95 | 0.72 (0.01) | 0.72 | 0.03 |
| 10000 | 5 | 100 | 60 [50-69] | 100 [96-100] | 100 | 40 | 0.87 (0.01) | 0.92 | 0.04 |
| 10000 | 6 | 100 | 99 [95-100] | 100 [96-100] | 100 | 1 | 1.24 (0.00) | 1.28 | 0.06 |
| 10000 | 8 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 2.05 (0.01) | 2.08 | 0.23 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.38 (0.01) | 0.37 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.55 (0.01) | 0.54 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.73 (0.01) | 0.72 | 0.01 |
| 20000 | 5 | 50 | 74 [60-84] | 100 [93-100] | 100 | 26 | 0.87 (0.01) | 0.90 | 0.02 |
| 20000 | 6 | 50 | 98 [90-100] | 100 [93-100] | 100 | 2 | 1.24 (0.00) | 1.26 | 0.03 |
| 20000 | 8 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 2.03 (0.01) | 2.06 | 0.15 |

**G2, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [0-3] | 38 [33-43] | 38 | 37 | 0.21 (0.04) | 0.63 | 0.61 |
| 268 | 2 | 400 | 3 [1-5] | 68 [64-73] | 68 | 66 | 0.26 (0.03) | 0.84 | 0.77 |
| 268 | 4 | 400 | 15 [12-19] | 86 [82-89] | 86 | 71 | 0.41 (0.03) | 1.13 | 1.00 |
| 268 | 5 | 400 | 30 [26-35] | 90 [87-93] | 91 | 60 | 0.61 (0.03) | 1.34 | 1.13 |
| 268 | 6 | 400 | 47 [42-51] | 96 [93-97] | 96 | 50 | 0.92 (0.03) | 1.57 | 1.26 |
| 268 | 8 | 400 | 72 [68-76] | 97 [94-98] | 98 | 26 | 1.66 (0.03) | 2.02 | 1.44 |
| 500 | 0 | 400 | 1 [0-2] | 47 [42-52] | 47 | 46 | 0.08 (0.02) | 0.35 | 0.27 |
| 500 | 2 | 400 | 2 [1-3] | 81 [77-85] | 81 | 80 | 0.21 (0.02) | 0.55 | 0.39 |
| 500 | 4 | 400 | 21 [17-25] | 94 [91-96] | 94 | 73 | 0.36 (0.02) | 0.86 | 0.57 |
| 500 | 5 | 400 | 43 [38-47] | 97 [95-98] | 97 | 55 | 0.58 (0.02) | 1.10 | 0.70 |
| 500 | 6 | 400 | 62 [57-66] | 99 [97-99] | 99 | 38 | 0.96 (0.02) | 1.40 | 0.84 |
| 500 | 8 | 400 | 87 [83-90] | 99 [98-100] | 100 | 13 | 1.92 (0.02) | 2.05 | 1.10 |
| 1000 | 0 | 400 | 0 [0-1] | 85 [81-88] | 85 | 85 | 0.24 (0.01) | 0.36 | 0.12 |
| 1000 | 2 | 400 | 1 [0-2] | 98 [96-99] | 98 | 98 | 0.42 (0.01) | 0.55 | 0.19 |
| 1000 | 4 | 400 | 14 [11-18] | 100 [98-100] | 100 | 85 | 0.58 (0.01) | 0.82 | 0.31 |
| 1000 | 5 | 400 | 43 [38-47] | 100 [99-100] | 100 | 57 | 0.77 (0.01) | 1.04 | 0.40 |
| 1000 | 6 | 400 | 67 [62-71] | 100 [99-100] | 100 | 33 | 1.12 (0.01) | 1.35 | 0.52 |
| 1000 | 8 | 400 | 95 [93-97] | 100 [99-100] | 100 | 5 | 2.03 (0.01) | 2.07 | 0.79 |
| 2000 | 0 | 300 | 0 [0-1] | 95 [92-97] | 95 | 95 | 0.28 (0.01) | 0.33 | 0.05 |
| 2000 | 2 | 300 | 0 [0-1] | 100 [99-100] | 100 | 100 | 0.47 (0.01) | 0.52 | 0.09 |
| 2000 | 4 | 300 | 10 [7-14] | 100 [99-100] | 100 | 90 | 0.66 (0.01) | 0.76 | 0.16 |
| 2000 | 5 | 300 | 46 [40-52] | 100 [99-100] | 100 | 54 | 0.84 (0.01) | 0.97 | 0.21 |
| 2000 | 6 | 300 | 81 [77-85] | 100 [99-100] | 100 | 19 | 1.18 (0.01) | 1.29 | 0.30 |
| 2000 | 8 | 300 | 100 [98-100] | 100 [99-100] | 100 | 0 | 2.07 (0.01) | 2.07 | 0.55 |
| 5000 | 0 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.34 (0.01) | 0.35 | 0.02 |
| 5000 | 2 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.51 (0.01) | 0.53 | 0.03 |
| 5000 | 4 | 200 | 5 [2-8] | 100 [98-100] | 100 | 96 | 0.72 (0.01) | 0.75 | 0.06 |
| 5000 | 5 | 200 | 56 [49-62] | 100 [98-100] | 100 | 45 | 0.87 (0.01) | 0.95 | 0.08 |
| 5000 | 6 | 200 | 91 [86-94] | 100 [98-100] | 100 | 10 | 1.23 (0.00) | 1.29 | 0.13 |
| 5000 | 8 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 2.07 (0.01) | 2.09 | 0.35 |
| 10000 | 0 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.34 (0.01) | 0.34 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.52 (0.01) | 0.51 | 0.01 |
| 10000 | 4 | 100 | 5 [2-11] | 100 [96-100] | 100 | 95 | 0.72 (0.01) | 0.72 | 0.03 |
| 10000 | 5 | 100 | 60 [50-69] | 100 [96-100] | 100 | 40 | 0.87 (0.01) | 0.92 | 0.04 |
| 10000 | 6 | 100 | 99 [95-100] | 100 [96-100] | 100 | 1 | 1.24 (0.00) | 1.28 | 0.06 |
| 10000 | 8 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 2.05 (0.01) | 2.08 | 0.23 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.38 (0.01) | 0.37 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.55 (0.01) | 0.54 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.73 (0.01) | 0.72 | 0.01 |
| 20000 | 5 | 50 | 74 [60-84] | 100 [93-100] | 100 | 26 | 0.87 (0.01) | 0.90 | 0.02 |
| 20000 | 6 | 50 | 98 [90-100] | 100 [93-100] | 100 | 2 | 1.24 (0.00) | 1.26 | 0.03 |
| 20000 | 8 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 2.03 (0.01) | 2.06 | 0.15 |

**G3, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [0-2] | 27 [22-31] | 27 | 26 | 0.10 (0.03) | 0.63 | 0.61 |
| 268 | 2 | 400 | 2 [1-3] | 47 [42-52] | 47 | 46 | 0.18 (0.03) | 0.84 | 0.77 |
| 268 | 4 | 400 | 12 [9-15] | 65 [60-69] | 65 | 53 | 0.33 (0.03) | 1.13 | 1.00 |
| 268 | 5 | 400 | 25 [21-29] | 73 [69-77] | 74 | 49 | 0.52 (0.03) | 1.34 | 1.13 |
| 268 | 6 | 400 | 43 [38-47] | 83 [79-86] | 83 | 41 | 0.82 (0.03) | 1.57 | 1.26 |
| 268 | 8 | 400 | 68 [64-73] | 89 [86-92] | 91 | 22 | 1.56 (0.03) | 2.02 | 1.44 |
| 500 | 0 | 400 | 1 [0-2] | 44 [39-49] | 44 | 43 | 0.07 (0.02) | 0.35 | 0.27 |
| 500 | 2 | 400 | 1 [0-3] | 74 [69-78] | 74 | 73 | 0.19 (0.02) | 0.55 | 0.39 |
| 500 | 4 | 400 | 20 [17-24] | 90 [87-93] | 90 | 70 | 0.35 (0.02) | 0.86 | 0.57 |
| 500 | 5 | 400 | 42 [37-46] | 95 [93-97] | 96 | 54 | 0.58 (0.02) | 1.10 | 0.70 |
| 500 | 6 | 400 | 61 [56-66] | 99 [97-99] | 99 | 38 | 0.95 (0.02) | 1.40 | 0.84 |
| 500 | 8 | 400 | 87 [83-90] | 99 [98-100] | 100 | 13 | 1.92 (0.02) | 2.05 | 1.10 |
| 1000 | 0 | 400 | 0 [0-1] | 85 [81-88] | 85 | 85 | 0.24 (0.01) | 0.36 | 0.12 |
| 1000 | 2 | 400 | 1 [0-2] | 98 [96-99] | 98 | 98 | 0.42 (0.01) | 0.55 | 0.19 |
| 1000 | 4 | 400 | 14 [11-18] | 100 [98-100] | 100 | 85 | 0.58 (0.01) | 0.82 | 0.31 |
| 1000 | 5 | 400 | 43 [38-47] | 100 [99-100] | 100 | 57 | 0.77 (0.01) | 1.04 | 0.40 |
| 1000 | 6 | 400 | 67 [62-71] | 100 [99-100] | 100 | 33 | 1.12 (0.01) | 1.35 | 0.52 |
| 1000 | 8 | 400 | 95 [93-97] | 100 [99-100] | 100 | 5 | 2.03 (0.01) | 2.07 | 0.79 |
| 2000 | 0 | 300 | 0 [0-1] | 95 [92-97] | 95 | 95 | 0.28 (0.01) | 0.33 | 0.05 |
| 2000 | 2 | 300 | 0 [0-1] | 100 [99-100] | 100 | 100 | 0.47 (0.01) | 0.52 | 0.09 |
| 2000 | 4 | 300 | 10 [7-14] | 100 [99-100] | 100 | 90 | 0.66 (0.01) | 0.76 | 0.16 |
| 2000 | 5 | 300 | 46 [40-52] | 100 [99-100] | 100 | 54 | 0.84 (0.01) | 0.97 | 0.21 |
| 2000 | 6 | 300 | 81 [77-85] | 100 [99-100] | 100 | 19 | 1.18 (0.01) | 1.29 | 0.30 |
| 2000 | 8 | 300 | 100 [98-100] | 100 [99-100] | 100 | 0 | 2.07 (0.01) | 2.07 | 0.55 |
| 5000 | 0 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.34 (0.01) | 0.35 | 0.02 |
| 5000 | 2 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.51 (0.01) | 0.53 | 0.03 |
| 5000 | 4 | 200 | 5 [2-8] | 100 [98-100] | 100 | 96 | 0.72 (0.01) | 0.75 | 0.06 |
| 5000 | 5 | 200 | 56 [49-62] | 100 [98-100] | 100 | 45 | 0.87 (0.01) | 0.95 | 0.08 |
| 5000 | 6 | 200 | 91 [86-94] | 100 [98-100] | 100 | 10 | 1.23 (0.00) | 1.29 | 0.13 |
| 5000 | 8 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 2.07 (0.01) | 2.09 | 0.35 |
| 10000 | 0 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.34 (0.01) | 0.34 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.52 (0.01) | 0.51 | 0.01 |
| 10000 | 4 | 100 | 5 [2-11] | 100 [96-100] | 100 | 95 | 0.72 (0.01) | 0.72 | 0.03 |
| 10000 | 5 | 100 | 60 [50-69] | 100 [96-100] | 100 | 40 | 0.87 (0.01) | 0.92 | 0.04 |
| 10000 | 6 | 100 | 99 [95-100] | 100 [96-100] | 100 | 1 | 1.24 (0.00) | 1.28 | 0.06 |
| 10000 | 8 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 2.05 (0.01) | 2.08 | 0.23 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.38 (0.01) | 0.37 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.55 (0.01) | 0.54 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.73 (0.01) | 0.72 | 0.01 |
| 20000 | 5 | 50 | 74 [60-84] | 100 [93-100] | 100 | 26 | 0.87 (0.01) | 0.90 | 0.02 |
| 20000 | 6 | 50 | 98 [90-100] | 100 [93-100] | 100 | 2 | 1.24 (0.00) | 1.26 | 0.03 |
| 20000 | 8 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 2.03 (0.01) | 2.06 | 0.15 |

**G2h, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 11 [8-14] | 11 | 11 | 0.28 (0.04) | 0.63 | 0.61 |
| 268 | 2 | 400 | 1 [0-2] | 14 [11-18] | 14 | 14 | 0.22 (0.03) | 0.84 | 0.77 |
| 268 | 4 | 400 | 6 [4-8] | 20 [16-24] | 21 | 15 | 0.20 (0.03) | 1.13 | 1.00 |
| 268 | 5 | 400 | 11 [8-14] | 22 [18-27] | 24 | 13 | 0.26 (0.03) | 1.34 | 1.13 |
| 268 | 6 | 400 | 19 [15-23] | 32 [27-36] | 34 | 16 | 0.39 (0.03) | 1.57 | 1.26 |
| 268 | 8 | 400 | 40 [35-45] | 43 [38-48] | 52 | 12 | 0.85 (0.04) | 2.02 | 1.44 |
| 500 | 0 | 400 | 0 [0-1] | 12 [9-15] | 12 | 12 | 0.25 (0.05) | 0.35 | 0.27 |
| 500 | 2 | 400 | 0 [0-1] | 22 [18-26] | 22 | 22 | 0.23 (0.04) | 0.55 | 0.39 |
| 500 | 4 | 400 | 7 [5-10] | 33 [28-37] | 33 | 26 | 0.27 (0.03) | 0.86 | 0.57 |
| 500 | 5 | 400 | 17 [13-20] | 42 [37-47] | 42 | 26 | 0.41 (0.03) | 1.10 | 0.70 |
| 500 | 6 | 400 | 35 [30-39] | 54 [49-59] | 55 | 20 | 0.67 (0.04) | 1.40 | 0.84 |
| 500 | 8 | 400 | 68 [64-73] | 80 [76-84] | 81 | 13 | 1.47 (0.04) | 2.05 | 1.10 |
| 1000 | 0 | 400 | 0 [0-1] | 19 [16-23] | 19 | 19 | 0.07 (0.02) | 0.36 | 0.12 |
| 1000 | 2 | 400 | 0 [0-1] | 35 [30-40] | 35 | 35 | 0.15 (0.02) | 0.55 | 0.19 |
| 1000 | 4 | 400 | 6 [4-8] | 44 [39-49] | 44 | 38 | 0.23 (0.02) | 0.82 | 0.31 |
| 1000 | 5 | 400 | 21 [17-25] | 51 [46-56] | 51 | 30 | 0.36 (0.02) | 1.04 | 0.40 |
| 1000 | 6 | 400 | 42 [38-47] | 68 [63-72] | 68 | 26 | 0.71 (0.03) | 1.35 | 0.52 |
| 1000 | 8 | 400 | 86 [82-89] | 96 [94-98] | 97 | 11 | 1.86 (0.02) | 2.07 | 0.79 |
| 2000 | 0 | 300 | 0 [0-1] | 58 [53-64] | 58 | 58 | 0.20 (0.01) | 0.33 | 0.05 |
| 2000 | 2 | 300 | 0 [0-1] | 73 [68-78] | 73 | 73 | 0.36 (0.01) | 0.52 | 0.09 |
| 2000 | 4 | 300 | 8 [5-11] | 75 [69-79] | 75 | 67 | 0.49 (0.02) | 0.76 | 0.16 |
| 2000 | 5 | 300 | 36 [30-41] | 81 [77-85] | 81 | 46 | 0.65 (0.02) | 0.97 | 0.21 |
| 2000 | 6 | 300 | 68 [63-73] | 95 [92-97] | 95 | 27 | 1.07 (0.02) | 1.29 | 0.30 |
| 2000 | 8 | 300 | 96 [93-98] | 100 [99-100] | 100 | 4 | 2.05 (0.01) | 2.07 | 0.55 |
| 5000 | 0 | 200 | 0 [0-2] | 85 [79-89] | 85 | 85 | 0.30 (0.01) | 0.35 | 0.02 |
| 5000 | 2 | 200 | 0 [0-2] | 99 [96-99] | 99 | 99 | 0.49 (0.01) | 0.53 | 0.03 |
| 5000 | 4 | 200 | 11 [7-16] | 97 [94-99] | 97 | 86 | 0.67 (0.01) | 0.75 | 0.06 |
| 5000 | 5 | 200 | 53 [46-59] | 100 [98-100] | 100 | 48 | 0.86 (0.01) | 0.95 | 0.08 |
| 5000 | 6 | 200 | 84 [78-88] | 100 [98-100] | 100 | 16 | 1.20 (0.01) | 1.29 | 0.13 |
| 5000 | 8 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 2.10 (0.01) | 2.09 | 0.35 |
| 10000 | 0 | 100 | 0 [0-4] | 91 [84-95] | 91 | 91 | 0.31 (0.01) | 0.34 | 0.00 |
| 10000 | 2 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.52 (0.01) | 0.51 | 0.01 |
| 10000 | 4 | 100 | 7 [3-14] | 100 [96-100] | 100 | 93 | 0.72 (0.01) | 0.72 | 0.03 |
| 10000 | 5 | 100 | 59 [49-68] | 100 [96-100] | 100 | 41 | 0.87 (0.01) | 0.92 | 0.04 |
| 10000 | 6 | 100 | 91 [84-95] | 100 [96-100] | 100 | 9 | 1.23 (0.01) | 1.28 | 0.06 |
| 10000 | 8 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 2.05 (0.01) | 2.08 | 0.23 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.39 (0.01) | 0.37 | 0.00 |
| 20000 | 2 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.56 (0.01) | 0.54 | 0.00 |
| 20000 | 4 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.75 (0.01) | 0.72 | 0.01 |
| 20000 | 5 | 50 | 60 [46-72] | 100 [93-100] | 100 | 40 | 0.87 (0.01) | 0.90 | 0.02 |
| 20000 | 6 | 50 | 98 [90-100] | 100 [93-100] | 100 | 2 | 1.24 (0.00) | 1.26 | 0.03 |
| 20000 | 8 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 2.05 (0.01) | 2.06 | 0.15 |

#### 3.2 Decoys decoupled from outcomes (each Pull's nine inputs taken from another Pull, so every decoy is a true null)

**G1, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 4 [2-6] | 4 | 4 | 0.02 (0.02) | 0.22 | 0.34 |
| 268 | 6 | 400 | 43 [38-47] | 4 [2-6] | 46 | 4 | 0.48 (0.03) | 0.95 | 0.93 |
| 500 | 0 | 400 | 0 [0-1] | 3 [1-5] | 3 | 3 | -0.01 (0.00) | 0.05 | 0.09 |
| 500 | 6 | 400 | 73 [68-77] | 2 [1-4] | 75 | 2 | 0.73 (0.03) | 0.88 | 0.58 |
| 1000 | 0 | 400 | 0 [0-1] | 3 [2-5] | 3 | 3 | -0.01 (0.00) | 0.00 | 0.00 |
| 1000 | 6 | 400 | 97 [95-98] | 1 [0-3] | 98 | 1 | 0.88 (0.01) | 0.90 | 0.32 |
| 2000 | 0 | 300 | 0 [0-1] | 2 [1-4] | 2 | 2 | -0.00 (0.00) | 0.00 | 0.00 |
| 2000 | 6 | 300 | 100 [99-100] | 0 [0-1] | 100 | 0 | 0.90 (0.00) | 0.91 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 2 [1-4] | 2 | 2 | -0.00 (0.00) | 0.00 | 0.00 |
| 5000 | 6 | 200 | 100 [98-100] | 0 [0-2] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.00 |

**G2, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [0-2] | 6 [4-8] | 6 | 6 | 0.19 (0.04) | 0.22 | 0.34 |
| 268 | 6 | 400 | 31 [26-35] | 6 [4-9] | 37 | 6 | 0.38 (0.03) | 0.95 | 0.93 |
| 500 | 0 | 400 | 0 [0-1] | 1 [1-3] | 1 | 1 | 0.04 (0.02) | 0.05 | 0.09 |
| 500 | 6 | 400 | 50 [45-55] | 1 [0-2] | 51 | 1 | 0.53 (0.03) | 0.88 | 0.58 |
| 1000 | 0 | 400 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 1000 | 6 | 400 | 80 [76-84] | 1 [0-2] | 81 | 1 | 0.73 (0.02) | 0.90 | 0.32 |
| 2000 | 0 | 300 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 2000 | 6 | 300 | 96 [93-97] | 0 [0-1] | 96 | 0 | 0.86 (0.01) | 0.91 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 0 [0-2] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 5000 | 6 | 200 | 100 [98-100] | 0 [0-2] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.00 |

**G3, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 1 [1-3] | 1 | 1 | 0.04 (0.02) | 0.22 | 0.34 |
| 268 | 6 | 400 | 28 [24-33] | 2 [1-4] | 31 | 2 | 0.35 (0.03) | 0.95 | 0.93 |
| 500 | 0 | 400 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.05 | 0.09 |
| 500 | 6 | 400 | 49 [44-54] | 1 [0-2] | 50 | 1 | 0.52 (0.03) | 0.88 | 0.58 |
| 1000 | 0 | 400 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 1000 | 6 | 400 | 80 [76-84] | 1 [0-2] | 81 | 1 | 0.73 (0.02) | 0.90 | 0.32 |
| 2000 | 0 | 300 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 2000 | 6 | 300 | 96 [93-97] | 0 [0-1] | 96 | 0 | 0.86 (0.01) | 0.91 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 0 [0-2] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 5000 | 6 | 200 | 100 [98-100] | 0 [0-2] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.00 |

**G2h, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 7 [4-9] | 7 | 7 | 0.20 (0.04) | 0.22 | 0.34 |
| 268 | 6 | 400 | 15 [12-19] | 1 [1-3] | 16 | 1 | 0.22 (0.03) | 0.95 | 0.93 |
| 500 | 0 | 400 | 0 [0-1] | 5 [3-7] | 5 | 5 | 0.15 (0.03) | 0.05 | 0.09 |
| 500 | 6 | 400 | 28 [24-32] | 1 [1-3] | 29 | 1 | 0.36 (0.03) | 0.88 | 0.58 |
| 1000 | 0 | 400 | 0 [0-1] | 1 [0-3] | 1 | 1 | 0.03 (0.01) | 0.00 | 0.00 |
| 1000 | 6 | 400 | 49 [44-53] | 2 [1-3] | 50 | 2 | 0.49 (0.03) | 0.90 | 0.32 |
| 2000 | 0 | 300 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 2000 | 6 | 300 | 78 [73-82] | 0 [0-1] | 78 | 0 | 0.70 (0.02) | 0.91 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 0 [0-2] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 5000 | 6 | 200 | 99 [96-100] | 0 [0-2] | 99 | 0 | 0.89 (0.01) | 0.88 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.00 |

**G1, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [1-3] | 7 [4-9] | 7 | 5 | -0.01 (0.02) | 0.36 | 0.64 |
| 268 | 6 | 400 | 37 [32-42] | 38 [33-42] | 39 | 2 | 0.34 (0.03) | 1.24 | 1.27 |
| 500 | 0 | 400 | 1 [0-2] | 5 [3-8] | 5 | 5 | -0.03 (0.01) | 0.14 | 0.29 |
| 500 | 6 | 400 | 75 [71-79] | 76 [72-80] | 76 | 1 | 0.60 (0.02) | 1.09 | 0.85 |
| 1000 | 0 | 400 | 0 [0-1] | 5 [3-8] | 5 | 5 | -0.02 (0.00) | 0.04 | 0.12 |
| 1000 | 6 | 400 | 98 [96-99] | 98 [96-99] | 98 | 0 | 0.77 (0.01) | 1.00 | 0.52 |
| 2000 | 0 | 300 | 1 [0-2] | 5 [3-8] | 5 | 5 | -0.01 (0.00) | 0.01 | 0.06 |
| 2000 | 6 | 300 | 100 [99-100] | 100 [99-100] | 100 | 0 | 0.84 (0.01) | 0.95 | 0.30 |
| 5000 | 0 | 200 | 1 [0-3] | 5 [3-9] | 5 | 5 | -0.00 (0.00) | 0.00 | 0.02 |
| 5000 | 6 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 0.88 (0.00) | 0.90 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 5 [2-11] | 5 | 5 | -0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.06 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.03 |

**G2, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 2 [1-3] | 9 [7-12] | 9 | 8 | 0.16 (0.04) | 0.36 | 0.64 |
| 268 | 6 | 400 | 57 [52-62] | 67 [63-72] | 70 | 13 | 0.48 (0.03) | 1.24 | 1.27 |
| 500 | 0 | 400 | 0 [0-1] | 4 [2-6] | 4 | 4 | 0.03 (0.02) | 0.14 | 0.29 |
| 500 | 6 | 400 | 80 [76-83] | 85 [81-88] | 85 | 5 | 0.63 (0.03) | 1.09 | 0.85 |
| 1000 | 0 | 400 | 0 [0-1] | 3 [1-5] | 3 | 3 | -0.01 (0.00) | 0.04 | 0.12 |
| 1000 | 6 | 400 | 95 [92-97] | 96 [93-97] | 96 | 1 | 0.74 (0.01) | 1.00 | 0.52 |
| 2000 | 0 | 300 | 0 [0-1] | 0 [0-2] | 0 | 0 | -0.00 (0.00) | 0.01 | 0.06 |
| 2000 | 6 | 300 | 100 [98-100] | 100 [98-100] | 100 | 0 | 0.84 (0.01) | 0.95 | 0.30 |
| 5000 | 0 | 200 | 0 [0-2] | 1 [0-4] | 1 | 1 | -0.00 (0.00) | 0.00 | 0.02 |
| 5000 | 6 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 0.88 (0.00) | 0.90 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.06 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.03 |

**G3, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [0-2] | 3 [2-5] | 3 | 3 | 0.02 (0.02) | 0.36 | 0.64 |
| 268 | 6 | 400 | 36 [31-41] | 37 [32-41] | 38 | 2 | 0.33 (0.03) | 1.24 | 1.27 |
| 500 | 0 | 400 | 0 [0-1] | 2 [1-3] | 2 | 2 | -0.01 (0.00) | 0.14 | 0.29 |
| 500 | 6 | 400 | 70 [65-74] | 71 [66-75] | 71 | 1 | 0.56 (0.02) | 1.09 | 0.85 |
| 1000 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | -0.01 (0.00) | 0.04 | 0.12 |
| 1000 | 6 | 400 | 95 [92-96] | 95 [92-97] | 95 | 0 | 0.74 (0.01) | 1.00 | 0.52 |
| 2000 | 0 | 300 | 0 [0-1] | 0 [0-2] | 0 | 0 | -0.00 (0.00) | 0.01 | 0.06 |
| 2000 | 6 | 300 | 100 [98-100] | 100 [98-100] | 100 | 0 | 0.84 (0.01) | 0.95 | 0.30 |
| 5000 | 0 | 200 | 0 [0-2] | 1 [0-4] | 1 | 1 | -0.00 (0.00) | 0.00 | 0.02 |
| 5000 | 6 | 200 | 100 [98-100] | 100 [98-100] | 100 | 0 | 0.88 (0.00) | 0.90 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 0.90 (0.00) | 0.88 | 0.06 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.03 |

**G2h, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 1 [0-2] | 7 [5-10] | 7 | 7 | 0.19 (0.04) | 0.36 | 0.64 |
| 268 | 6 | 400 | 16 [12-19] | 13 [10-17] | 17 | 2 | 0.19 (0.03) | 1.24 | 1.27 |
| 500 | 0 | 400 | 1 [0-2] | 5 [3-7] | 5 | 4 | 0.13 (0.03) | 0.14 | 0.29 |
| 500 | 6 | 400 | 28 [24-32] | 28 [23-32] | 28 | 1 | 0.29 (0.03) | 1.09 | 0.85 |
| 1000 | 0 | 400 | 0 [0-1] | 1 [0-3] | 1 | 1 | 0.03 (0.01) | 0.04 | 0.12 |
| 1000 | 6 | 400 | 43 [38-48] | 43 [38-48] | 43 | 0 | 0.37 (0.02) | 1.00 | 0.52 |
| 2000 | 0 | 300 | 0 [0-1] | 0 [0-1] | 0 | 0 | 0.00 (0.00) | 0.01 | 0.06 |
| 2000 | 6 | 300 | 70 [64-75] | 70 [64-75] | 70 | 0 | 0.55 (0.02) | 0.95 | 0.30 |
| 5000 | 0 | 200 | 0 [0-2] | 0 [0-2] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.02 |
| 5000 | 6 | 200 | 97 [94-99] | 97 [94-99] | 97 | 0 | 0.82 (0.01) | 0.90 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 100 [96-100] | 100 | 0 | 0.89 (0.00) | 0.88 | 0.06 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 0.90 (0.00) | 0.89 | 0.03 |

#### 3.3 Decoys resampled with their Pulls, plus 4 fair-coin decoys (a search as wide as router-inputs': 25 cuts)

**G1, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 11 [8-14] | 11 | 11 | 0.01 (0.03) | 0.25 | 0.32 |
| 268 | 6 | 400 | 33 [28-37] | 21 [17-25] | 53 | 21 | 0.44 (0.03) | 1.02 | 0.94 |
| 500 | 0 | 400 | 0 [0-1] | 21 [17-25] | 21 | 21 | 0.04 (0.03) | 0.11 | 0.12 |
| 500 | 6 | 400 | 61 [56-66] | 27 [23-32] | 88 | 27 | 0.68 (0.02) | 1.01 | 0.62 |
| 1000 | 0 | 400 | 0 [0-1] | 32 [27-36] | 32 | 32 | -0.01 (0.01) | 0.03 | 0.01 |
| 1000 | 6 | 400 | 79 [75-83] | 21 [17-25] | 100 | 21 | 0.74 (0.01) | 0.92 | 0.33 |
| 2000 | 0 | 300 | 0 [0-1] | 30 [25-36] | 30 | 30 | -0.02 (0.00) | 0.01 | 0.00 |
| 2000 | 6 | 300 | 94 [91-96] | 6 [4-9] | 100 | 6 | 0.83 (0.01) | 0.89 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 21 [15-27] | 21 | 21 | -0.01 (0.00) | 0.01 | 0.00 |
| 5000 | 6 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 0.85 (0.00) | 0.87 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 15 [9-23] | 15 | 15 | -0.01 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.85 (0.00) | 0.91 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 4 [1-13] | 4 | 4 | -0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.85 (0.00) | 0.92 | 0.00 |

**G2, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 7 [4-9] | 7 | 7 | 0.20 (0.04) | 0.25 | 0.32 |
| 268 | 6 | 400 | 26 [22-31] | 23 [19-27] | 49 | 23 | 0.41 (0.03) | 1.02 | 0.94 |
| 500 | 0 | 400 | 0 [0-1] | 5 [3-8] | 5 | 5 | 0.08 (0.03) | 0.11 | 0.12 |
| 500 | 6 | 400 | 46 [41-50] | 22 [18-26] | 67 | 22 | 0.53 (0.03) | 1.01 | 0.62 |
| 1000 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | 0.01 (0.01) | 0.03 | 0.01 |
| 1000 | 6 | 400 | 69 [64-73] | 17 [14-21] | 86 | 17 | 0.65 (0.02) | 0.92 | 0.33 |
| 2000 | 0 | 300 | 0 [0-1] | 1 [1-3] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 2000 | 6 | 300 | 91 [87-94] | 6 [4-9] | 97 | 6 | 0.80 (0.01) | 0.89 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 1 [0-3] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 6 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 0.85 (0.00) | 0.87 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 1 [0-5] | 1 | 1 | -0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.85 (0.00) | 0.91 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.85 (0.00) | 0.92 | 0.00 |

**G3, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | 0.06 (0.03) | 0.25 | 0.32 |
| 268 | 6 | 400 | 25 [21-29] | 14 [11-18] | 39 | 14 | 0.35 (0.03) | 1.02 | 0.94 |
| 500 | 0 | 400 | 0 [0-1] | 5 [3-8] | 5 | 5 | 0.08 (0.03) | 0.11 | 0.12 |
| 500 | 6 | 400 | 45 [40-50] | 20 [17-24] | 66 | 20 | 0.52 (0.03) | 1.01 | 0.62 |
| 1000 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | 0.01 (0.01) | 0.03 | 0.01 |
| 1000 | 6 | 400 | 69 [64-73] | 17 [14-21] | 86 | 17 | 0.65 (0.02) | 0.92 | 0.33 |
| 2000 | 0 | 300 | 0 [0-1] | 1 [1-3] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 2000 | 6 | 300 | 91 [87-94] | 6 [4-9] | 97 | 6 | 0.80 (0.01) | 0.89 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 1 [0-3] | 1 | 1 | -0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 6 | 200 | 100 [97-100] | 1 [0-3] | 100 | 1 | 0.85 (0.00) | 0.87 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 1 [0-5] | 1 | 1 | -0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.85 (0.00) | 0.91 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.85 (0.00) | 0.92 | 0.00 |

**G2h, depth 1**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 10 [8-14] | 10 | 10 | 0.34 (0.05) | 0.25 | 0.32 |
| 268 | 6 | 400 | 11 [9-15] | 9 [7-12] | 20 | 9 | 0.23 (0.03) | 1.02 | 0.94 |
| 500 | 0 | 400 | 0 [0-1] | 6 [4-8] | 6 | 6 | 0.22 (0.05) | 0.11 | 0.12 |
| 500 | 6 | 400 | 21 [17-25] | 9 [7-12] | 30 | 9 | 0.30 (0.03) | 1.01 | 0.62 |
| 1000 | 0 | 400 | 0 [0-1] | 2 [1-4] | 2 | 2 | 0.07 (0.03) | 0.03 | 0.01 |
| 1000 | 6 | 400 | 37 [32-41] | 9 [7-12] | 46 | 9 | 0.41 (0.03) | 0.92 | 0.33 |
| 2000 | 0 | 300 | 0 [0-1] | 1 [1-3] | 1 | 1 | 0.01 (0.01) | 0.01 | 0.00 |
| 2000 | 6 | 300 | 62 [56-67] | 5 [3-8] | 67 | 5 | 0.57 (0.03) | 0.89 | 0.16 |
| 5000 | 0 | 200 | 0 [0-2] | 0 [0-2] | 0 | 0 | 0.00 (0.00) | 0.01 | 0.00 |
| 5000 | 6 | 200 | 93 [89-96] | 4 [2-8] | 97 | 4 | 0.81 (0.01) | 0.87 | 0.05 |
| 10000 | 0 | 100 | 0 [0-4] | 0 [0-4] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 10000 | 6 | 100 | 100 [96-100] | 0 [0-4] | 100 | 0 | 0.85 (0.00) | 0.91 | 0.02 |
| 20000 | 0 | 50 | 0 [0-7] | 0 [0-7] | 0 | 0 | 0.00 (0.00) | 0.00 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 0 [0-7] | 100 | 0 | 0.85 (0.00) | 0.92 | 0.00 |

**G1, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 29 [25-34] | 29 | 29 | 0.07 (0.03) | 0.60 | 0.67 |
| 268 | 6 | 400 | 45 [40-49] | 75 [70-79] | 75 | 30 | 0.74 (0.03) | 1.55 | 1.31 |
| 500 | 0 | 400 | 1 [0-2] | 70 [65-74] | 70 | 69 | 0.11 (0.03) | 0.43 | 0.35 |
| 500 | 6 | 400 | 59 [54-64] | 99 [97-99] | 99 | 40 | 0.95 (0.02) | 1.44 | 0.92 |
| 1000 | 0 | 400 | 0 [0-1] | 99 [97-99] | 99 | 99 | 0.24 (0.01) | 0.36 | 0.14 |
| 1000 | 6 | 400 | 65 [60-70] | 100 [99-100] | 100 | 35 | 1.07 (0.01) | 1.35 | 0.55 |
| 2000 | 0 | 300 | 0 [0-1] | 100 [99-100] | 100 | 100 | 0.27 (0.01) | 0.34 | 0.06 |
| 2000 | 6 | 300 | 77 [72-81] | 100 [99-100] | 100 | 23 | 1.14 (0.01) | 1.30 | 0.31 |
| 5000 | 0 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.30 (0.01) | 0.33 | 0.02 |
| 5000 | 6 | 200 | 92 [87-95] | 100 [98-100] | 100 | 9 | 1.20 (0.00) | 1.25 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.34 (0.01) | 0.36 | 0.01 |
| 10000 | 6 | 100 | 98 [93-99] | 100 [96-100] | 100 | 2 | 1.22 (0.00) | 1.27 | 0.07 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.35 (0.01) | 0.37 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 1.22 (0.00) | 1.28 | 0.03 |

**G2, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 33 [29-38] | 33 | 33 | 0.23 (0.04) | 0.60 | 0.67 |
| 268 | 6 | 400 | 50 [45-55] | 97 [95-98] | 97 | 47 | 0.88 (0.03) | 1.55 | 1.31 |
| 500 | 0 | 400 | 1 [0-2] | 52 [47-57] | 52 | 51 | 0.12 (0.03) | 0.43 | 0.35 |
| 500 | 6 | 400 | 59 [54-64] | 99 [98-100] | 100 | 41 | 0.95 (0.02) | 1.44 | 0.92 |
| 1000 | 0 | 400 | 0 [0-1] | 87 [83-90] | 87 | 87 | 0.23 (0.01) | 0.36 | 0.14 |
| 1000 | 6 | 400 | 65 [60-70] | 100 [99-100] | 100 | 35 | 1.07 (0.01) | 1.35 | 0.55 |
| 2000 | 0 | 300 | 0 [0-1] | 96 [93-98] | 96 | 96 | 0.26 (0.01) | 0.34 | 0.06 |
| 2000 | 6 | 300 | 77 [72-81] | 100 [99-100] | 100 | 23 | 1.14 (0.01) | 1.30 | 0.31 |
| 5000 | 0 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.30 (0.01) | 0.33 | 0.02 |
| 5000 | 6 | 200 | 92 [87-95] | 100 [98-100] | 100 | 9 | 1.20 (0.00) | 1.25 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.34 (0.01) | 0.36 | 0.01 |
| 10000 | 6 | 100 | 98 [93-99] | 100 [96-100] | 100 | 2 | 1.22 (0.00) | 1.27 | 0.07 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.35 (0.01) | 0.37 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 1.22 (0.00) | 1.28 | 0.03 |

**G3, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 20 [16-24] | 20 | 20 | 0.08 (0.03) | 0.60 | 0.67 |
| 268 | 6 | 400 | 44 [39-49] | 74 [69-78] | 74 | 30 | 0.74 (0.03) | 1.55 | 1.31 |
| 500 | 0 | 400 | 1 [0-2] | 48 [43-52] | 48 | 47 | 0.12 (0.03) | 0.43 | 0.35 |
| 500 | 6 | 400 | 59 [54-64] | 99 [97-99] | 99 | 40 | 0.95 (0.02) | 1.44 | 0.92 |
| 1000 | 0 | 400 | 0 [0-1] | 87 [83-90] | 87 | 87 | 0.23 (0.01) | 0.36 | 0.14 |
| 1000 | 6 | 400 | 65 [60-70] | 100 [99-100] | 100 | 35 | 1.07 (0.01) | 1.35 | 0.55 |
| 2000 | 0 | 300 | 0 [0-1] | 96 [93-98] | 96 | 96 | 0.26 (0.01) | 0.34 | 0.06 |
| 2000 | 6 | 300 | 77 [72-81] | 100 [99-100] | 100 | 23 | 1.14 (0.01) | 1.30 | 0.31 |
| 5000 | 0 | 200 | 0 [0-2] | 100 [98-100] | 100 | 100 | 0.30 (0.01) | 0.33 | 0.02 |
| 5000 | 6 | 200 | 92 [87-95] | 100 [98-100] | 100 | 9 | 1.20 (0.00) | 1.25 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 100 [96-100] | 100 | 100 | 0.34 (0.01) | 0.36 | 0.01 |
| 10000 | 6 | 100 | 98 [93-99] | 100 [96-100] | 100 | 2 | 1.22 (0.00) | 1.27 | 0.07 |
| 20000 | 0 | 50 | 0 [0-7] | 100 [93-100] | 100 | 100 | 0.35 (0.01) | 0.37 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 1.22 (0.00) | 1.28 | 0.03 |

**G2h, depth 2**

| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |
|---|---|---|---|---|---|---|---|---|---|
| 268 | 0 | 400 | 0 [0-1] | 12 [9-15] | 12 | 12 | 0.32 (0.05) | 0.60 | 0.67 |
| 268 | 6 | 400 | 17 [14-21] | 32 [27-36] | 33 | 16 | 0.35 (0.03) | 1.55 | 1.31 |
| 500 | 0 | 400 | 0 [0-1] | 12 [9-16] | 12 | 12 | 0.22 (0.04) | 0.43 | 0.35 |
| 500 | 6 | 400 | 30 [25-34] | 49 [44-54] | 50 | 20 | 0.55 (0.03) | 1.44 | 0.92 |
| 1000 | 0 | 400 | 0 [0-1] | 21 [17-25] | 21 | 21 | 0.11 (0.03) | 0.36 | 0.14 |
| 1000 | 6 | 400 | 45 [40-49] | 71 [66-75] | 71 | 27 | 0.75 (0.03) | 1.35 | 0.55 |
| 2000 | 0 | 300 | 0 [0-1] | 62 [56-67] | 62 | 62 | 0.20 (0.02) | 0.34 | 0.06 |
| 2000 | 6 | 300 | 63 [58-69] | 92 [89-95] | 93 | 29 | 1.02 (0.02) | 1.30 | 0.31 |
| 5000 | 0 | 200 | 0 [0-2] | 77 [71-82] | 77 | 77 | 0.26 (0.01) | 0.33 | 0.02 |
| 5000 | 6 | 200 | 83 [77-87] | 100 [98-100] | 100 | 18 | 1.17 (0.01) | 1.25 | 0.13 |
| 10000 | 0 | 100 | 0 [0-4] | 99 [95-100] | 99 | 99 | 0.34 (0.01) | 0.36 | 0.01 |
| 10000 | 6 | 100 | 95 [89-98] | 100 [96-100] | 100 | 5 | 1.21 (0.01) | 1.27 | 0.07 |
| 20000 | 0 | 50 | 0 [0-7] | 98 [90-100] | 98 | 98 | 0.35 (0.01) | 0.37 | 0.00 |
| 20000 | 6 | 50 | 100 [93-100] | 100 [93-100] | 100 | 0 | 1.22 (0.00) | 1.28 | 0.03 |

### 4. Pulls and weeks to the first real split

For each gate and depth, the smallest simulated N at which the gate splits on the injected input in at least 80% of records (point estimate; whether the Wilson lower end also reaches 80% is shown), and the N at which 80% is crossed when the P(inj) points are joined by straight lines on log N ([INFERENCE]: the curve between grid points is not simulated). N counts random-draw Pulls. Assumption: all Pulls are random draws until burn-in ends (taken at 102 Pulls, consumer-burn-in's stage-1 boundary median; [INFERENCE] its 3-Cell draws are counted as 2-Cell draws), then 1 Pull in 5 is (ticket-router.mjs:72, EXPLORE_EVERY), so Pulls needed = N for N <= 102, else 102 + 5 (N - 102); weeks = Pulls / (10, 30, 90 a week). The last two columns are the grid N's weeks at 30 a week if every Pull were at 1 in 5 (5 N) or all were random draws (N).

| design | Delta | gate | depth | P(inj) % by N | grid N at >= 80% | Wilson low >= 80%? | Pulls | weeks @10 | @30 | @90 | interpolated N | Pulls | weeks @10 | @30 | @90 | @30, 5 N | @30, N |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| coupled | 5 | G1 | 1 | 268:19 500:34 1000:49 2000:61 5000:83 10000:91 20000:98 | 5000 | no | 24592 | 2459 | 820 | 273 | 4487 | 22027 | 2203 | 734 | 245 | 833 | 167 |
| coupled | 5 | G1 | 2 | 268:27 500:42 1000:43 2000:46 5000:56 10000:60 20000:74 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 5 | G2 | 1 | 268:14 500:19 1000:27 2000:42 5000:73 10000:90 20000:98 | 10000 | yes | 49592 | 4959 | 1653 | 551 | 6730 | 33242 | 3324 | 1108 | 369 | 1667 | 333 |
| coupled | 5 | G2 | 2 | 268:30 500:43 1000:43 2000:46 5000:56 10000:60 20000:74 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 5 | G3 | 1 | 268:13 500:19 1000:27 2000:42 5000:73 10000:90 20000:98 | 10000 | yes | 49592 | 4959 | 1653 | 551 | 6730 | 33242 | 3324 | 1108 | 369 | 1667 | 333 |
| coupled | 5 | G3 | 2 | 268:25 500:42 1000:43 2000:46 5000:56 10000:60 20000:74 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 5 | G2h | 1 | 268:8 500:9 1000:8 2000:13 5000:42 10000:68 20000:86 | 20000 | no | 99592 | 9959 | 3320 | 1107 | 15874 | 78962 | 7896 | 2632 | 877 | 3333 | 667 |
| coupled | 5 | G2h | 2 | 268:11 500:17 1000:21 2000:36 5000:53 10000:59 20000:60 | not reached by 20000 | - | - | - | - | - | - | - | - | - | - | - | - |
| coupled | 6 | G1 | 1 | 268:33 500:66 1000:80 2000:95 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1022 | 4702 | 470 | 157 | 52.2 | 333 | 66.7 |
| coupled | 6 | G1 | 2 | 268:43 500:62 1000:67 2000:81 5000:91 10000:99 20000:98 | 2000 | no | 9592 | 959 | 320 | 107 | 1877 | 8977 | 898 | 299 | 99.7 | 333 | 66.7 |
| coupled | 6 | G2 | 1 | 268:26 500:45 1000:68 2000:94 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1378 | 6482 | 648 | 216 | 72.0 | 333 | 66.7 |
| coupled | 6 | G2 | 2 | 268:47 500:62 1000:67 2000:81 5000:91 10000:99 20000:98 | 2000 | no | 9592 | 959 | 320 | 107 | 1877 | 8977 | 898 | 299 | 99.7 | 333 | 66.7 |
| coupled | 6 | G3 | 1 | 268:25 500:45 1000:68 2000:94 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1378 | 6482 | 648 | 216 | 72.0 | 333 | 66.7 |
| coupled | 6 | G3 | 2 | 268:43 500:61 1000:67 2000:81 5000:91 10000:99 20000:98 | 2000 | no | 9592 | 959 | 320 | 107 | 1877 | 8977 | 898 | 299 | 99.7 | 333 | 66.7 |
| coupled | 6 | G2h | 1 | 268:15 500:21 1000:35 2000:65 5000:97 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 3073 | 14957 | 1496 | 499 | 166 | 833 | 167 |
| coupled | 6 | G2h | 2 | 268:19 500:35 1000:42 2000:68 5000:84 10000:91 20000:98 | 5000 | no | 24592 | 2459 | 820 | 273 | 3976 | 19472 | 1947 | 649 | 216 | 833 | 167 |
| coupled | 8 | G1 | 1 | 268:67 500:88 1000:97 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 400 | 1592 | 159 | 53.1 | 17.7 | 83.3 | 16.7 |
| coupled | 8 | G1 | 2 | 268:69 500:87 1000:95 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 394 | 1562 | 156 | 52.1 | 17.4 | 83.3 | 16.7 |
| coupled | 8 | G2 | 1 | 268:59 500:86 1000:97 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 434 | 1762 | 176 | 58.7 | 19.6 | 83.3 | 16.7 |
| coupled | 8 | G2 | 2 | 268:72 500:87 1000:95 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 374 | 1462 | 146 | 48.7 | 16.2 | 83.3 | 16.7 |
| coupled | 8 | G3 | 1 | 268:58 500:86 1000:97 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 435 | 1767 | 177 | 58.9 | 19.6 | 83.3 | 16.7 |
| coupled | 8 | G3 | 2 | 268:68 500:87 1000:95 2000:100 5000:100 10000:100 20000:100 | 500 | yes | 2092 | 209 | 69.7 | 23.2 | 398 | 1582 | 158 | 52.7 | 17.6 | 83.3 | 16.7 |
| coupled | 8 | G2h | 1 | 268:33 500:62 1000:84 2000:99 5000:100 10000:100 20000:100 | 1000 | no | 4592 | 459 | 153 | 51.0 | 893 | 4057 | 406 | 135 | 45.1 | 167 | 33.3 |
| coupled | 8 | G2h | 2 | 268:40 500:68 1000:86 2000:96 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 796 | 3572 | 357 | 119 | 39.7 | 167 | 33.3 |
| decoupled | 6 | G1 | 1 | 268:43 500:73 1000:97 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 613 | 2657 | 266 | 88.6 | 29.5 | 167 | 33.3 |
| decoupled | 6 | G1 | 2 | 268:37 500:75 1000:98 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 579 | 2487 | 249 | 82.9 | 27.6 | 167 | 33.3 |
| decoupled | 6 | G2 | 1 | 268:31 500:50 1000:80 2000:96 5000:100 10000:100 20000:100 | 1000 | no | 4592 | 459 | 153 | 51.0 | 1000 | 4592 | 459 | 153 | 51.0 | 167 | 33.3 |
| decoupled | 6 | G2 | 2 | 268:57 500:80 1000:95 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 506 | 2122 | 212 | 70.7 | 23.6 | 167 | 33.3 |
| decoupled | 6 | G3 | 1 | 268:28 500:49 1000:80 2000:96 5000:100 10000:100 20000:100 | 1000 | no | 4592 | 459 | 153 | 51.0 | 1000 | 4592 | 459 | 153 | 51.0 | 167 | 33.3 |
| decoupled | 6 | G3 | 2 | 268:36 500:70 1000:95 2000:100 5000:100 10000:100 20000:100 | 1000 | yes | 4592 | 459 | 153 | 51.0 | 663 | 2907 | 291 | 96.9 | 32.3 | 167 | 33.3 |
| decoupled | 6 | G2h | 1 | 268:15 500:28 1000:49 2000:78 5000:99 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2211 | 10647 | 1065 | 355 | 118 | 833 | 167 |
| decoupled | 6 | G2h | 2 | 268:16 500:28 1000:43 2000:70 5000:97 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2828 | 13732 | 1373 | 458 | 153 | 833 | 167 |
| padded | 6 | G1 | 1 | 268:33 500:61 1000:79 2000:94 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1046 | 4822 | 482 | 161 | 53.6 | 333 | 66.7 |
| padded | 6 | G1 | 2 | 268:45 500:59 1000:65 2000:77 5000:92 10000:98 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2457 | 11877 | 1188 | 396 | 132 | 833 | 167 |
| padded | 6 | G2 | 1 | 268:26 500:46 1000:69 2000:91 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1420 | 6692 | 669 | 223 | 74.4 | 333 | 66.7 |
| padded | 6 | G2 | 2 | 268:50 500:59 1000:65 2000:77 5000:92 10000:98 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2457 | 11877 | 1188 | 396 | 132 | 833 | 167 |
| padded | 6 | G3 | 1 | 268:25 500:45 1000:69 2000:91 5000:100 10000:100 20000:100 | 2000 | yes | 9592 | 959 | 320 | 107 | 1420 | 6692 | 669 | 223 | 74.4 | 333 | 66.7 |
| padded | 6 | G3 | 2 | 268:44 500:59 1000:65 2000:77 5000:92 10000:98 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 2457 | 11877 | 1188 | 396 | 132 | 833 | 167 |
| padded | 6 | G2h | 1 | 268:11 500:21 1000:37 2000:62 5000:93 10000:100 20000:100 | 5000 | yes | 24592 | 2459 | 820 | 273 | 3419 | 16687 | 1669 | 556 | 185 | 833 | 167 |
| padded | 6 | G2h | 2 | 268:17 500:30 1000:45 2000:63 5000:83 10000:95 20000:100 | 5000 | no | 24592 | 2459 | 820 | 273 | 4437 | 21777 | 2178 | 726 | 242 | 833 | 167 |

Compute: 5550 simulated records on 8 worker threads, 1161 s wall for the simulation, 1161 s in all.

## Appendix B. §5 of the derive output (`--only-base`)

### 5. The one-Cell baseline, by N and Delta

400 fresh records per row from the coupled design; no search, one group. `cost` = share in which task-high's in-sample $/Pull is below slow-high's; `floor` = share in which task-high is under the quality floor against slow-high (underFloor, 15 points) with both Cells at >= 20 Pulls; `one-Cell = slow-high` = share whose one-group choice is slow-high (slow-high is also the choice when neither Cell qualifies). The realised gain in § 3 is scored against this one-Cell choice.

| N | Delta | task-high cheaper in-sample % | task-high under the floor % | one-Cell = slow-high % |
|---|---|---|---|---|
| 268 | 0 | 100 | 5 | 5 |
| 268 | 2 | 100 | 5 | 5 |
| 268 | 4 | 99 | 5 | 6 |
| 268 | 5 | 96 | 5 | 9 |
| 268 | 6 | 88 | 5 | 16 |
| 268 | 8 | 57 | 5 | 44 |
| 500 | 0 | 100 | 1 | 1 |
| 500 | 2 | 100 | 1 | 1 |
| 500 | 4 | 100 | 1 | 1 |
| 500 | 5 | 100 | 1 | 2 |
| 500 | 6 | 96 | 1 | 5 |
| 500 | 8 | 58 | 1 | 43 |
| 1000 | 0 | 100 | 0 | 0 |
| 1000 | 2 | 100 | 0 | 0 |
| 1000 | 4 | 100 | 0 | 0 |
| 1000 | 5 | 100 | 0 | 0 |
| 1000 | 6 | 98 | 0 | 2 |
| 1000 | 8 | 70 | 0 | 31 |
| 2000 | 0 | 100 | 0 | 0 |
| 2000 | 2 | 100 | 0 | 0 |
| 2000 | 4 | 100 | 0 | 0 |
| 2000 | 5 | 100 | 0 | 0 |
| 2000 | 6 | 100 | 0 | 0 |
| 2000 | 8 | 71 | 0 | 29 |
| 5000 | 0 | 100 | 0 | 0 |
| 5000 | 2 | 100 | 0 | 0 |
| 5000 | 4 | 100 | 0 | 0 |
| 5000 | 5 | 100 | 0 | 0 |
| 5000 | 6 | 100 | 0 | 0 |
| 5000 | 8 | 86 | 0 | 14 |
| 10000 | 0 | 100 | 0 | 0 |
| 10000 | 2 | 100 | 0 | 0 |
| 10000 | 4 | 100 | 0 | 0 |
| 10000 | 5 | 100 | 0 | 0 |
| 10000 | 6 | 100 | 0 | 0 |
| 10000 | 8 | 87 | 0 | 13 |
| 20000 | 0 | 100 | 0 | 0 |
| 20000 | 2 | 100 | 0 | 0 |
| 20000 | 4 | 100 | 0 | 0 |
| 20000 | 5 | 100 | 0 | 0 |
| 20000 | 6 | 100 | 0 | 0 |
| 20000 | 8 | 97 | 0 | 4 |
