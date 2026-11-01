# Why did fail rates fall between the two draw periods? (issue #4156)

Research note for the Router's self-refining clustering (map #4118). It measures; it rules on nothing.

## Question

Between the period when three Cells were drawn (K = 3, sessions 2026-10-11 to 2026-10-25T09-45) and the period after it, when two were (K = 2, sessions 2026-10-22 to 2026-10-30), the fail rate fell from 26% to 13% on `slow-high` and from 32% to 21% on `task-high` (#4150). How much of that fall comes from each of three causes: a different mix of tickets, a change in how Rulings are worked out, or the Cells doing better? The Fit pools every Pull since 2026-10-03, so the answer bears on how much old evidence a Fit may count.

## Method, source and reproduction

Every table below is printed by `docs/research/fail-rate-drift-derive.mjs` and pasted here unedited from its stdout (run at `origin/main` `e810699f`, 2026-11-01, `--state` pointing at the main checkout's `.fleet/`); the prose around the tables is hand-written, and the counts it states were read off those tables. The script imports the Router's own modules from the checkout it sits in:

- **Pull set and period**: as in #4150 (`docs/research/router-inputs-derive.mjs`): `attribute({ features, members, tiers, windowStart: "2026-10-03", stratum: ruleStratum })` (`pull-attribution.mjs:301`) over `docs/metrics/{ticket-features,member-outcomes,tier-outcomes}.tsv`, filtered as `fitPulls` does (`ticket-router.mjs:382-385`), then `tally(units, generations(all)).pulls`: the newest generation of each Cell, status `counted`. Period = each Pull's recorded K (`exploration_draw` `k/K`). Only slow-high and task-high are measured: smol-high is drawn in period A only. 208 Pulls: A 110, B 98.
- **Failure**: a counted Pull's `falseClaims` (`pull-attribution.mjs:378-386`); the script checks that equals the count of Rulings failing `failsFloor` (`minted_false_claim=yes` or `closed_own_ticket=no`, `pull-attribution.mjs:217`) and that no counted Pull carries a `bail:fixed-refuted` ending (every counted Pull has `claims = 1`).
- **Provenance**: `isDerivedNote` (`tier-outcomes.mjs:755`) on the Ruling in force, plus the file's own history: `git log -p -- docs/metrics/tier-outcomes.tsv` gives every version of each PR's row (the commit that added it, its date) and so each Pull's FIRST Ruling, which re-rules overwrote. The re-rule batches are the header's (`tier-outcomes.tsv` lines 57-117): #3831, 2026-10-26, 21 rows; #3832, 2026-10-27, 180 rows; the script checks both header entries exist and reads a row's batch from its note's ` — re-ruled by #38xx` suffix.
- **Mix**: the nine recorded metrics (`issueMetrics`, `ticket-router.mjs:113-131`) as `ticket-features.tsv` holds them, and `ruleStratum` (`ticket-router.mjs:139`) for light/heavy.
- **Commits**: `git log --since=2026-10-11 --until=2026-10-31 --no-merges` over the review, Charges, ruling and evidence files named in § 9; each commit's first **release** from the public npm registry document for `@feigi/fleet-ctl` (every version carries its `gitHead` and publish time; 578 releases carry a head present in this checkout), cached outside the repository (`--cache`, refused inside it).
- **Install version per session** (§ 8, `pin`): `--state <main checkout>/.fleet`, the live run's phase-0 receipts, which are outside the repository. Without `--state` the column prints `not read`.

Reproduce: `node docs/research/fail-rate-drift-derive.mjs --state <main checkout>/.fleet` (Node ≥ 18; 20 to 80 s; needs `git` and, once, network for the registry; deterministic for a fixed registry document and seed — two runs diff-identical). Bootstrap: 95% range, 1000 resamples, seed 20261101; weights are refit on every resample. A range that contains 0 is a drop that resample cannot tell from none.

Conventions. Fail rate = failing Pulls ÷ counted Pulls. Drop = A − B, in percentage points (pp); positive means B is lower (the `A→B` rows of § 1 print the change B − A, so they are negative). `E` / `R` / `H` = the Ruling in force was derived at close-out, re-ruled (R3831 / R3832), or by hand (§ 3). "First ruling" = the first committed version of the PR's row.

Derive output header: 

> Repository HEAD e810699f; window start 2026-10-03; 268 Pulls in the window, 268 in the Fit's set; 208 counted newest-generation Pulls of slow-high and task-high (smol-high is drawn in period A only and is left out); seed 20261101; bootstrap 1000; perms 2000.
> The Ruling of every one of these Pulls is the row `attribute` booked to it; `claims` = Pulls on every row (so a failure is exactly a failing Ruling: no `bail:fixed-refuted` ending is counted); `falseClaims` = failures (equals the Ruling-floor count).

## 1. Fail rate per Cell and period; failure kinds

Period A = recorded K 3 (slow, smol, task); B = K 2 (slow, task). Kinds: `false claim` = `minted_false_claim=yes` and `closed_own_ticket=yes`; `unmet` = `closed_own_ticket=no` and no false claim; `both` = both.

| Cell | period | Pulls | failures | fail rate | false claim | unmet | both | any false claim | any unmet |
|---|---|---|---|---|---|---|---|---|---|
| slow-high | A | 50 | 13 | 26.0% | 6 | 2 | 5 | 11 | 7 |
| slow-high | B | 54 | 7 | 13.0% | 3 | 1 | 3 | 6 | 4 |
| task-high | A | 60 | 19 | 31.7% | 8 | 5 | 6 | 14 | 11 |
| task-high | B | 44 | 9 | 20.5% | 6 | 0 | 3 | 9 | 3 |
| slow-high | A→B | 50→54 | 13→7 | 26.0%→13.0% (-13.0 pp) | | | | | |
| task-high | A→B | 60→44 | 19→9 | 31.7%→20.5% (-11.2 pp) | | | | | |
| slow+task | A→B | 110→98 | 32→16 | 29.1%→16.3% (-12.8 pp) | | | | | |

Reading. Both Cells reproduce #4150's rates (26.0 / 13.0 and 31.7 / 20.5). A failing Pull is one failing Ruling: no counted Pull ends `bail:fixed-refuted`. The kinds split differently by Cell: on slow-high both kinds fall (false claim, any: 11 of 50 → 6 of 54; unmet, any: 7 → 4); on task-high the false-claim count is about flat (14 of 60 = 23.3% → 9 of 44 = 20.5%) and the fall is in `closed_own_ticket=no` (11 of 60 = 18.3% → 3 of 44 = 6.8%, none of B's 9 failures is unmet-only).

## 2. How each Ruling was first written

Snapshots of the whole file as committed (`git show <sha>:docs/metrics/tier-outcomes.tsv`), rows split by `run_date` against 2026-10-15. The first snapshot is the file as the map #3673 note of 2026-10-21 saw it:

| snapshot | what it is | rows run_date >= 10-15 | of those blank sizing | of those minted_false_claim=yes | rows run_date < 10-15 | of those minted_false_claim=yes |
|---|---|---|---|---|---|---|
| 712d97ef | 10-21 morning: hand-written rows of the 10-18..10-20 close-outs | 60 | 60 | 1 | 306 | 154 |
| f6793d2a | 10-21: backfill of 69 reviewed PRs | 129 | 129 | 25 | 306 | 154 |
| f6c08ff0 | 10-25: append works the Ruling out from the Charges | 157 | 148 | 31 | 306 | 154 |
| 7c98045c | 10-26: re-rule #3831 (21 rows) | 182 | 150 | 35 | 306 | 154 |
| c3f0c6d1 | 10-27: re-rule #3832 (180 rows) | 185 | 150 | 56 | 306 | 162 |
| e810699f | this checkout | 255 | 152 | 67 | 306 | 162 |

Every row of `docs/metrics/tier-outcomes.tsv` as FIRST committed (`git log -p`; a row later edited in place counts as first written), split by `run_date` (the date the controller stamped at ruling) against 2026-10-15:

| first-committed row's run_date | rows | derived note | blank sizing | minted_false_claim=yes | closed_own_ticket=no | fails the floor |
|---|---|---|---|---|---|---|
| < 2026-10-15 | 306 | 0 | 165 | 140 | 16 | 147 |
| >= 2026-10-15 | 256 | 77 | 153 | 41 | 28 | 53 |
| >= 2026-10-15, note not derived | 179 | 0 | 150 | 30 | 22 | 40 |
| >= 2026-10-15, note derived | 77 | 77 | 3 | 11 | 6 | 13 |
| >= 2026-10-03 (the window), note not derived | 202 | 0 | 156 | 33 | 22 | 43 |

The Pulls above, by the commit that first wrote their Ruling (first version of the PR's row; `E` = never rewritten, `R` = a later version exists):

| first-writing commit date | first note | Pulls | blank sizing at first writing | failing at first writing | failing now | rewritten since |
|---|---|---|---|---|---|---|
| 61b6e107 2026-10-11 | hand, sizing recorded | 3 | 0 | 0 | 1 | 3 |
| 5af23ead 2026-10-12 | hand, sizing recorded | 4 | 0 | 0 | 2 | 4 |
| 234bb4cf 2026-10-12 | hand, sizing recorded | 7 | 0 | 1 | 2 | 7 |
| 983c5eb1 2026-10-18 | hand, blank sizing | 8 | 8 | 0 | 0 | 8 |
| a9610166 2026-10-19 | hand, blank sizing | 6 | 6 | 0 | 1 | 6 |
| 73fb08d3 2026-10-20 | hand, blank sizing | 10 | 10 | 0 | 4 | 10 |
| a7939ce1 2026-10-21 | hand, blank sizing | 3 | 3 | 1 | 2 | 3 |
| f6793d2a 2026-10-21 | hand, blank sizing | 44 | 44 | 16 | 11 | 44 |
| 4d1e756e 2026-10-21 | hand, blank sizing | 11 | 11 | 0 | 4 | 11 |
| daf97c52 2026-10-23 | hand, sizing recorded | 9 | 0 | 0 | 2 | 9 |
| dad8b3ca 2026-10-24 | hand, blank sizing | 7 | 7 | 2 | 3 | 7 |
| 0c1ca6a9 2026-10-25 | hand, sizing recorded | 20 | 0 | 0 | 3 | 20 |
| ae5c498f 2026-10-25 | derived | 4 | 1 | 1 | 1 | 0 |
| 2acb399e 2026-10-26 | derived | 2 | 0 | 1 | 1 | 0 |
| 0531772b 2026-10-29 | derived | 37 | 2 | 7 | 7 | 0 |
| 24bba20f 2026-10-30 | derived | 15 | 0 | 1 | 1 | 0 |
| 635243c5 2026-10-31 | derived | 18 | 0 | 3 | 3 | 0 |

Reading. The artefact in map #3673's note is real and reproduces exactly: in the file at `712d97ef` (2026-10-21) the 60 rows dated from 2026-10-15 all have a blank `sizing` and 1 `minted_false_claim=yes`, against 154 of 306 before. (Counted over each row's first-committed version the earlier 306 show 140 rather than 154, so 14 of them changed verdict after their first commit; those edits were not inspected.) Three things the snapshots add. The next commit that day, `f6793d2a` (a backfill of 69 reviewed PRs, also blank `sizing`), carries 24 more false claims (25 in all): blank `sizing` marks Rulings written without the scratch's report file, not Rulings that pass. The Rulings written by hand at the 10-18, 10-19 and 10-20 close-outs are the ones that read clean: for the Pulls in this set their first versions (8 + 6 + 10 rows) fail 0 of 24 (the table of first-writing commits). And the later re-rules move the counts the other way: the 185 rows dated from 10-15 that `c3f0c6d1` leaves in the file hold 56 false claims, and the 255 in the checkout now hold 67; `sizing` stays blank on 152 of those 255 rows, since a re-rule rewrites verdicts and note, not `sizing`.

## 3. Provenance of the Ruling the Router reads

Groups, from the row in force: **E** = note is a derived note and carries no re-rule suffix (written by `append` from the Charges at close-out, never rewritten as a re-rule); **R3831 / R3832** = note ends ` — re-ruled by #3831|#3832 from session …` (header batches dated 2026-10-26 and 2026-10-27); **H** = note not derived (by hand). `ruling date` = the commit date of the row's version in force, and for R rows the batch date the header gives (the `run_date` column of a re-ruled row keeps the ORIGINAL stamp). `lag` = ruling date minus the Pull's `run_date`, in days.

| Cell | period | group | Pulls | failing (in force) | fail rate | failing at first ruling | median lag d | min..max lag d | stamped run_date lag, median d |
|---|---|---|---|---|---|---|---|---|---|
| slow-high | A | E | 1 | 0 | 0.0% | 0 | 0.0 | 0..0 | 0.0 |
| slow-high | A | R3831 | 6 | 3 | 50.0% | 2 | 5.0 | 5..5 | 3.0 |
| slow-high | A | R3832 | 43 | 10 | 23.3% | 6 | 10.0 | 7..16 | 3.0 |
| slow-high | A | all | 50 | 13 | 26.0% | 8 | 9.0 | 0..16 | 3.0 |
| slow-high | B | E | 35 | 3 | 8.6% | 3 | 1.0 | 0..2 | 1.0 |
| slow-high | B | R3831 | 6 | 2 | 33.3% | 0 | 4.0 | 4..4 | 0.0 |
| slow-high | B | R3832 | 13 | 2 | 15.4% | 0 | 4.0 | 4..4 | 1.0 |
| slow-high | B | all | 54 | 7 | 13.0% | 3 | 2.0 | 0..4 | 1.0 |
| task-high | A | E | 5 | 2 | 40.0% | 2 | 0.0 | 0..1 | 0.0 |
| task-high | A | R3831 | 2 | 0 | 0.0% | 0 | 5.0 | 5..5 | 3.0 |
| task-high | A | R3832 | 52 | 16 | 30.8% | 11 | 9.0 | 7..16 | 1.0 |
| task-high | A | H | 1 | 1 | 100.0% | 1 | 13.0 | 13..13 | 7.0 |
| task-high | A | all | 60 | 19 | 31.7% | 14 | 9.0 | 0..16 | 1.0 |
| task-high | B | E | 35 | 8 | 22.9% | 8 | 2.0 | 0..2 | 1.0 |
| task-high | B | R3831 | 2 | 0 | 0.0% | 0 | 4.0 | 4..4 | 0.0 |
| task-high | B | R3832 | 7 | 1 | 14.3% | 0 | 4.0 | 4..4 | 1.0 |
| task-high | B | all | 44 | 9 | 20.5% | 8 | 2.0 | 0..4 | 1.0 |

Pooled over both Cells (slow-high + task-high):

| period | group | Pulls | failing | fail rate | share of period's Pulls |
|---|---|---|---|---|---|
| A | E | 6 | 2 | 33.3% | 5.5% |
| A | R3831 | 8 | 3 | 37.5% | 7.3% |
| A | R3832 | 95 | 26 | 27.4% | 86.4% |
| A | H | 1 | 1 | 100.0% | 0.9% |
| A | all | 110 | 32 | 29.1% | 100.0% |
| B | E | 70 | 11 | 15.7% | 71.4% |
| B | R3831 | 8 | 2 | 25.0% | 8.2% |
| B | R3832 | 20 | 3 | 15.0% | 20.4% |
| B | all | 98 | 16 | 16.3% | 100.0% |

Reading. `isDerivedNote` is true of every R row, because `deriveRuling` composes the note and the re-rules call it (`tier-outcomes.mjs:719`, the note ends ` — re-ruled by #38xx from session …`): it cannot tell a Ruling written at close-out from one rebuilt ten days later. By that predicate 207 of these 208 Rulings are derived; only PR #3331 (task-high, period A, failing) is by hand — one of the two rows the header lists as not re-ruled. `tally`'s `by_hand` therefore reads 1 where 131 of 208 Rulings (103 of 110 in A, 28 of 98 in B) were produced by a re-rule, not by the live Charges. Provenance and period are nearly collinear: period A is 94% re-ruled (8 R3831 + 95 R3832 of 110), period B is 71% close-out-derived (70 of 98). The 28 B Pulls that are R are the sessions 2026-10-22T08-03 and 2026-10-23T22-31, before the 2026-10-25 derivation shipped; the 70 E Pulls are the sessions of 10-27 onward. The Ruling's date lags the Pull's run by 0–2 days for E rows (median 1–2), by 4 days for B's R rows, and by 5–16 days (median 5–10) for A's R rows, which carry the batch date of 10-26 or 10-27; the `run_date` column of an R row keeps the original stamp, so it understates the lag (median 0–3 days).

## 4. The same Pulls as FIRST ruled, and what the re-rules changed

`first ruling` = the first committed version of the Pull's PR row. The three first-ruling provenances: `derived` (a derived note), `hand, blank sizing` (a non-derived note and a blank `sizing`: ruled without its evidence, the artefact), `hand, sizing recorded` (a non-derived note with `sizing`).

| Cell | period | first-ruling provenance | Pulls | failing at first ruling | fail rate at first ruling | failing now | fail rate now | pass→fail | fail→pass | median lag of first ruling, d |
|---|---|---|---|---|---|---|---|---|---|---|
| slow-high | A | derived | 1 | 0 | 0.0% | 0 | 0.0% | 0 | 0 | 0.0 |
| slow-high | A | hand, blank sizing | 42 | 8 | 19.0% | 11 | 26.2% | 5 | 2 | 3.0 |
| slow-high | A | hand, sizing recorded | 7 | 0 | 0.0% | 2 | 28.6% | 2 | 0 | 1.0 |
| slow-high | A | all | 50 | 8 | 16.0% | 13 | 26.0% | 7 | 2 | 3.0 |
| slow-high | B | derived | 35 | 3 | 8.6% | 3 | 8.6% | 0 | 0 | 1.0 |
| slow-high | B | hand, sizing recorded | 19 | 0 | 0.0% | 4 | 21.1% | 4 | 0 | 2.0 |
| slow-high | B | all | 54 | 3 | 5.6% | 7 | 13.0% | 4 | 0 | 2.0 |
| task-high | A | derived | 5 | 2 | 40.0% | 2 | 40.0% | 0 | 0 | 0.0 |
| task-high | A | hand, blank sizing | 47 | 11 | 23.4% | 14 | 29.8% | 8 | 5 | 3.0 |
| task-high | A | hand, sizing recorded | 8 | 1 | 12.5% | 3 | 37.5% | 3 | 1 | 1.0 |
| task-high | A | all | 60 | 14 | 23.3% | 19 | 31.7% | 11 | 6 | 1.0 |
| task-high | B | derived | 35 | 8 | 22.9% | 8 | 22.9% | 0 | 0 | 2.0 |
| task-high | B | hand, sizing recorded | 9 | 0 | 0.0% | 1 | 11.1% | 1 | 0 | 2.0 |
| task-high | B | all | 44 | 8 | 18.2% | 9 | 20.5% | 1 | 0 | 2.0 |
| slow+task | A | derived | 6 | 2 | 33.3% | 2 | 33.3% | 0 | 0 | 0.0 |
| slow+task | A | hand, blank sizing | 89 | 19 | 21.3% | 25 | 28.1% | 13 | 7 | 3.0 |
| slow+task | A | hand, sizing recorded | 15 | 1 | 6.7% | 5 | 33.3% | 5 | 1 | 1.0 |
| slow+task | A | all | 110 | 22 | 20.0% | 32 | 29.1% | 18 | 8 | 1.5 |
| slow+task | B | derived | 70 | 11 | 15.7% | 11 | 15.7% | 0 | 0 | 2.0 |
| slow+task | B | hand, sizing recorded | 28 | 0 | 0.0% | 5 | 17.9% | 5 | 0 | 2.0 |
| slow+task | B | all | 98 | 11 | 11.2% | 16 | 16.3% | 5 | 0 | 2.0 |

| Cell | fail rate A | B | drop (pp) — Rulings as first written | fail rate A | B | drop (pp) — Rulings in force |
|---|---|---|---|---|---|---|
| slow-high | 16.0% | 5.6% | +10.4 | 26.0% | 13.0% | +13.0 |
| task-high | 23.3% | 18.2% | +5.2 | 31.7% | 20.5% | +11.2 |
| slow+task | 20.0% | 11.2% | +8.8 | 29.1% | 16.3% | +12.8 |

Reading. The first Ruling of an R row was written either by hand with its `sizing` recorded (the sessions of 10-11 to 10-12, 10-22 to 10-23: `hand, sizing recorded`) or by hand with a blank one (10-18 to 10-24 close-outs and backfills: `hand, blank sizing`, Main's "ruled without evidence"). Every one of those first Rulings was rewritten by a re-rule, except PR #3331's; the Rulings now in force are the re-rules' and the close-out derivations'. The re-rules changed verdicts in both directions: of the 208 Pulls, 23 went pass → failure and 8 failure → pass (A: 18 and 8; B: 5 and 0), which raised A's rate from 20.0% to 29.1% (+9.1 pp) and B's from 11.2% to 16.3% (+5.1 pp). The drop as first written is 8.8 pp (slow-high 10.4, task-high 5.2), as now in force 12.8 pp (13.0, 11.2): the re-rules add 4.0 pp to the drop, because more of A was re-ruled and the re-rule moved failures up. Under the first Rulings 28 of B's 98 Pulls, the R group, are all passes (0 of 28); under the re-rules they fail 5 of 28.

## 5. Ticket mix, period A against period B

The nine recorded metrics, as `ticket-features.tsv` holds them (what the Router saw at dispatch), over the counted slow-high + task-high Pulls (the draws inside a period are random between the Cells, so the Cells are pooled). Test: period labels permuted (seeded), statistic = |difference of mean ranks| (numeric) or chi-square (kind, Slice); p add-one.

n: A 110, B 98.

| feature | A median (p25..p75) | B median (p25..p75) | A mean | B mean | statistic | p |
|---|---|---|---|---|---|---|
| brief_chars | 4069.5 (3023.5..5599.5) | 4046.5 (2552.5..5481.0) | 4558.6 | 4571.4 | 5.30 | 0.52 |
| criteria | 4.0 (0.0..6.0) | 5.0 (3.0..7.0) | 4.2 | 4.9 | 10.15 | 0.22 |
| comments | 1.0 (1.0..2.0) | 1.0 (1.0..1.0) | 1.3 | 1.1 | 8.90 | 0.22 |
| age_days | 0.0 (0.0..2.0) | 0.0 (0.0..1.0) | 1.7 | 1.0 | 10.00 | 0.19 |
| paths | 8.0 (5.0..12.0) | 6.0 (3.0..12.8) | 9.8 | 9.7 | 11.89 | 0.16 |
| test_paths | 1.0 (0.0..2.0) | 0.0 (0.0..2.0) | 1.5 | 1.7 | 7.26 | 0.34 |
| xrefs | 2.0 (1.0..3.0) | 2.0 (1.0..4.8) | 2.4 | 2.7 | 3.75 | 0.64 |
| kind | (none) 17.3%, bug 42.7%, documentation 1.8%, enhancement 38.2% | (none) 0.0%, bug 46.9%, documentation 2.0%, enhancement 51.0% | | | 19.08 | 0.00 |
| slice | no-slice 85.5%, slice 14.5% | no-slice 95.9%, slice 4.1% | | | 6.53 | 0.02 |
| rule stratum (light/heavy, derived from the above) | light 28.2%, heavy 71.8%, unknown 0.0% | light 30.6%, heavy 69.4%, unknown 0.0% | | | 0.15 | 0.76 |

blank recorded metrics: none.

Does the ticket's mix predict failure? Fail rate by feature stratum, both periods pooled, Rulings in force:

| stratum | Pulls | failing | fail rate |
|---|---|---|---|
| (none) / no-slice / heavy | 11 | 3 | 27.3% |
| (none) / no-slice / light | 6 | 0 | 0.0% |
| (none) / slice / heavy | 2 | 1 | 50.0% |
| bug / no-slice / heavy | 64 | 16 | 25.0% |
| bug / no-slice / light | 29 | 1 | 3.4% |
| documentation / no-slice / heavy | 1 | 0 | 0.0% |
| documentation / no-slice / light | 1 | 0 | 0.0% |
| documentation / slice / heavy | 2 | 2 | 100.0% |
| enhancement / no-slice / heavy | 51 | 13 | 25.5% |
| enhancement / no-slice / light | 25 | 6 | 24.0% |
| enhancement / slice / heavy | 16 | 6 | 37.5% |
| brief_chars > median 4047.5 | 104 | 30 | 28.8% |
| brief_chars <= median 4047.5 | 104 | 18 | 17.3% |
| criteria > median 5.0 | 80 | 22 | 27.5% |
| criteria <= median 5.0 | 128 | 26 | 20.3% |
| comments > median 1.0 | 60 | 14 | 23.3% |
| comments <= median 1.0 | 148 | 34 | 23.0% |
| age_days > median 0.0 | 98 | 25 | 25.5% |
| age_days <= median 0.0 | 110 | 23 | 20.9% |
| paths > median 7.0 | 99 | 30 | 30.3% |
| paths <= median 7.0 | 109 | 18 | 16.5% |
| test_paths > median 1.0 | 63 | 15 | 23.8% |
| test_paths <= median 1.0 | 145 | 33 | 22.8% |
| xrefs > median 2.0 | 77 | 24 | 31.2% |
| xrefs <= median 2.0 | 131 | 24 | 18.3% |

Reading. The mix differs in two recorded features. `kind`: 17.3% of A's Pulls have no kind label, none of B's; enhancement 38% → 51%. Slice: 14.5% of A's Pulls are Slices, 4.1% of B's. The other seven metrics and light/heavy do not differ detectably (permutation p 0.16 to 0.76; medians differ by at most two units: paths 8 vs 6, criteria 4 vs 5). Fail rate by stratum, both periods pooled: bug/light 3.4% (1 of 29) against 24–38% in every heavy or enhancement stratum with 16 or more Pulls; Slices fail 37.5% (enhancement, 16 Pulls) to 100% (documentation, 2 Pulls); `paths` and `brief_chars` above the median fail 30.3% and 28.8%, against 16.5% and 17.3% at or below.

## 6. Reweighting one period to the other's mix

Two weightings, both fit on the slow-high + task-high Pulls pooled (the Cells are drawn at random inside a period, so one mix per period) and applied to each Cell's Pulls:

- **strata**: kind (bug / enhancement / documentation / none) × Slice (`parent` set) × the rule's light/heavy (`ruleStratum`); a Pull of stratum s in the period being reweighted gets weight share_target(s) / share_source(s); a stratum absent from the target gets weight 0.
- **IPW**: ridge-penalised (λ = 1) logistic regression of period (A = 1) on log1p of the seven numeric metrics (standardised), kind dummies and the Slice flag; a B Pull gets weight p/(1−p) (to A's mix), an A Pull (1−p)/p (to B's mix). Self-normalised; no trimming.

Coverage: B Pulls in a stratum with no A Pull, and A Pulls in a stratum with no B Pull (strata weighting gives them weight 0):

B Pulls in a stratum absent from A: 2 of 98; A Pulls in a stratum absent from B: 21 of 110. 11 strata in all.

| stratum (kind / Slice / light-heavy) | A Pulls | B Pulls | A share | B share |
|---|---|---|---|---|
| (none) / no-slice / heavy | 11 | 0 | 10.0% | 0.0% |
| (none) / no-slice / light | 6 | 0 | 5.5% | 0.0% |
| (none) / slice / heavy | 2 | 0 | 1.8% | 0.0% |
| bug / no-slice / heavy | 33 | 31 | 30.0% | 31.6% |
| bug / no-slice / light | 14 | 15 | 12.7% | 15.3% |
| documentation / no-slice / heavy | 0 | 1 | 0.0% | 1.0% |
| documentation / no-slice / light | 0 | 1 | 0.0% | 1.0% |
| documentation / slice / heavy | 2 | 0 | 1.8% | 0.0% |
| enhancement / no-slice / heavy | 19 | 32 | 17.3% | 32.7% |
| enhancement / no-slice / light | 11 | 14 | 10.0% | 14.3% |
| enhancement / slice / heavy | 12 | 4 | 10.9% | 4.1% |

Reweighted fail rate (Rulings in force). `B→A` = period B's Pulls weighted to A's mix; `A→B` = period A's Pulls weighted to B's mix. Ranges are 95% bootstrap ranges (resampling Pulls within each Cell and period, weights refit on every resample), in percentage points / percent. `drop left` = (A − B reweighted to A's mix) ÷ (A − B) — the share of the observed drop that stays when the mix difference is removed; the second variant moves A instead of B.

| Cell | method | A rate | B rate | observed drop (pp) | B→A rate [range] | drop left after B→A (pp) [range] | share of drop left | A→B rate [range] | drop left after A→B (pp) [range] | share left | ESS of B→A / A→B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| slow-high | strata | 26.0% | 13.0% | +13.0 [-2.1, 28.4] | 11.8% [3.8, 22.0] | +14.2 [-0.3, 29.2] | 108.6% | 28.6% [14.7, 43.2] | +15.6 [-0.6, 32.4] | 119.8% | 46.4 / 38.1 |
| task-high | strata | 31.7% | 20.5% | +11.2 [-6.2, 28.0] | 20.7% [6.8, 40.5] | +11.0 [-10.7, 29.7] | 98.2% | 25.9% [12.5, 41.5] | +5.4 [-12.8, 25.2] | 48.3% | 31.2 / 39.8 |
| pooled | strata | 29.1% | 16.3% | +12.8 [1.8, 23.4] | 16.0% [7.7, 27.0] | +13.1 [-0.1, 25.0] | 102.6% | 27.2% [17.1, 37.4] | +10.9 [-1.2, 22.4] | 85.2% | 76.1 / 77.9 |
| slow-high | ipw | 26.0% | 13.0% | +13.0 [-0.8, 28.4] | 17.2% [4.7, 34.7] | +8.8 [-11.1, 27.1] | 67.1% | 28.3% [12.9, 48.2] | +15.3 [-1.5, 35.1] | 117.7% | 39.5 / 26.4 |
| task-high | ipw | 31.7% | 20.5% | +11.2 [-7.4, 26.8] | 17.5% [4.8, 38.9] | +14.2 [-9.1, 32.0] | 126.3% | 23.5% [12.1, 37.8] | +3.0 [-14.9, 21.7] | 26.8% | 29.4 / 39.5 |
| pooled | ipw | 29.1% | 16.3% | +12.8 [2.0, 23.3] | 17.4% [7.4, 31.1] | +11.7 [-2.9, 24.9] | 91.8% | 26.1% [15.9, 38.3] | +9.7 [-2.5, 23.1] | 76.3% | 68.3 / 60.9 |

The same reweighting on the Rulings **as first written** (`failFirst`):

| Cell | method | A rate | B rate | observed drop (pp) | B→A rate [range] | drop left after B→A (pp) [range] | share left |
|---|---|---|---|---|---|---|---|
| slow-high | strata | 16.0% | 5.6% | +10.4 [-1.1, 22.1] | 4.8% [0.0, 11.0] | +11.2 [0.6, 22.3] | 107.4% |
| task-high | strata | 23.3% | 18.2% | +5.2 [-11.2, 20.8] | 18.8% [5.2, 37.3] | +4.6 [-17.8, 22.5] | 88.3% |
| pooled | strata | 20.0% | 11.2% | +8.8 [-1.6, 19.3] | 11.4% [4.1, 21.5] | +8.6 [-4.3, 19.9] | 98.2% |
| slow-high | ipw | 16.0% | 5.6% | +10.4 [-1.3, 22.1] | 8.9% [0.0, 24.1] | +7.1 [-11.0, 20.9] | 67.6% |
| task-high | ipw | 23.3% | 18.2% | +5.2 [-11.7, 19.7] | 16.0% [3.6, 33.3] | +7.3 [-13.0, 24.8] | 142.3% |
| pooled | ipw | 20.0% | 11.2% | +8.8 [-1.1, 18.1] | 12.3% [4.1, 23.4] | +7.7 [-5.4, 19.2] | 87.9% |

Reading. Mix explains little of the pooled drop and none of it when B is moved to A's mix (strata): B's rate at A's mix is 16.0% (strata) or 17.4% (IPW) against 16.3% observed, so 102.6% or 91.8% of the 12.8 pp remains. Moving A to B's mix lowers A to 27.2% or 26.1%, so 85.2% or 76.3% remains. Per Cell the picture is wider: slow-high keeps 67–120% of its 13.0 pp under the four variants; task-high keeps 27–126% (A → B: 5.4 pp by strata, 3.0 pp by IPW, down from 11.2), and every per-Cell range contains 0, as does the observed per-Cell drop itself (slow-high [-2.1, 28.4], task-high [-6.2, 28.0]). The pooled drop's range is [1.8, 23.4] (strata resamples) or [2.0, 23.3] (IPW). Effective sample sizes are 26–78. In the A → B direction strata weighting gives weight 0 to the 21 A Pulls (of 110) in strata B never draws (no kind label, and A's documentation Slices); in B → A, 2 of 98 B Pulls fall in strata A lacks. On the Rulings as first written the pooled share left is 98.2% (strata) and 87.9% (IPW).

## 7. How much of each Cell's drop falls inside Rulings of each provenance

Rate = Σ over groups of (failing Pulls in the group ÷ the period's Pulls). A group's **contribution to the drop** = its contribution to A's rate − its contribution to B's rate; the contributions sum to the observed drop. A group's within-group rate is in § 3. `R` = R3831 + R3832. The `B→A strata/IPW` columns give B's contributions with B reweighted to A's mix first (weights as in § 6), so they sum to the drop left after the mix is removed.

| Cell | group | A: Pulls | A: failing | B: Pulls | B: failing | A contribution (pp) | B contribution (pp) | contribution to drop (pp) | share of drop | after B→A strata: contribution (pp) | after B→A IPW: contribution (pp) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| slow-high | E | 1 | 0 | 35 | 3 | +0.0 | +5.6 | -5.6 | -42.6% | -4.8 | -8.9 |
| slow-high | R | 49 | 13 | 19 | 4 | +26.0 | +7.4 | +18.6 | 142.6% | +19.0 | +17.7 |
| slow-high | H | 0 | 0 | 0 | 0 | +0.0 | +0.0 | +0.0 | 0.0% | +0.0 | +0.0 |
| slow-high | total | | | | | +26.0 | +13.0 | +13.0 | 100.0% | +14.2 | +8.8 |
| task-high | E | 5 | 2 | 35 | 8 | +3.3 | +18.2 | -14.8 | -132.4% | -15.4 | -12.7 |
| task-high | R | 54 | 16 | 9 | 1 | +26.7 | +2.3 | +24.4 | 217.6% | +24.8 | +25.2 |
| task-high | H | 1 | 1 | 0 | 0 | +1.7 | +0.0 | +1.7 | 14.9% | +1.7 | +1.7 |
| task-high | total | | | | | +31.7 | +20.5 | +11.2 | 100.0% | +11.0 | +14.2 |
| pooled | E | 6 | 2 | 70 | 11 | +1.8 | +11.2 | -9.4 | -73.7% | -9.6 | -10.5 |
| pooled | R | 103 | 29 | 28 | 5 | +26.4 | +5.1 | +21.3 | 166.6% | +21.8 | +21.3 |
| pooled | H | 1 | 1 | 0 | 0 | +0.9 | +0.0 | +0.9 | 7.1% | +0.9 | +0.9 |
| pooled | total | | | | | +29.1 | +16.3 | +12.8 | 100.0% | +13.1 | +11.7 |

Within one provenance group, A against B (rate difference in pp; 95% bootstrap range over Pulls; raw, then B reweighted to A's stratum mix inside the group). `R` pools both re-rule batches.

| Cell | group | A rate (n) | B rate (n) | A − B raw (pp) [range] | A − B with B at A's mix, strata within the group (pp) [range] |
|---|---|---|---|---|---|
| slow-high | E | 0.0% (1) | 8.6% (35) | too few Pulls | |
| slow-high | R | 26.5% (49) | 21.1% (19) | +5.5 [-18.5, 27.1] | +10.7 [-14.1, 29.2] |
| task-high | E | 40.0% (5) | 22.9% (35) | +17.1 [-28.6, 62.9] | +15.8 [-29.6, 61.3] |
| task-high | R | 29.6% (54) | 11.1% (9) | +18.5 [-7.4, 38.9] | +15.3 [-4.0, 38.9] |
| pooled | E | 33.3% (6) | 15.7% (70) | +17.6 [-18.6, 59.5] | +12.2 [-25.3, 53.7] |
| pooled | R | 28.2% (103) | 17.9% (28) | +10.3 [-7.6, 26.8] | +9.9 [-9.3, 28.1] |

Inside period B, the same Cell's rate by provenance (the B-period Rulings differ in how they were made, and in WHEN: R rows are Pulls of sessions before the 2026-10-25 derivation; E rows after it):

| Cell | group | B Pulls | failing | rate | first session | last session |
|---|---|---|---|---|---|---|
| slow-high | E | 35 | 3 | 8.6% | 2026-10-27T07-41 | 2026-10-30T08-34 |
| slow-high | R | 19 | 4 | 21.1% | 2026-10-22T08-03 | 2026-10-23T22-31 |
| task-high | E | 35 | 8 | 22.9% | 2026-10-27T07-41 | 2026-10-30T08-34 |
| task-high | R | 9 | 1 | 11.1% | 2026-10-22T08-03 | 2026-10-23T22-31 |
| slow+task | E | 70 | 11 | 15.7% | 2026-10-27T07-41 | 2026-10-30T08-34 |
| slow+task | R | 28 | 5 | 17.9% | 2026-10-22T08-03 | 2026-10-23T22-31 |

Period B, slow-high + task-high: re-ruled minus close-out-derived fail rate +2.1 pp [-13.6, 18.6] (R 28 Pulls, E 70 Pulls; bootstrap over Pulls).

Reading. The drop sits in the R rows. Pooled, the R group's rate contributes 26.4 pp to A's rate and 5.1 pp to B's: +21.3 pp, which is 166.6% of the 12.8 pp drop; the E group contributes −9.4 pp (A 1.8 pp, B 11.2 pp, −73.7%); the one H Pull +0.9 pp. Per Cell: slow-high R +18.6 pp, E −5.6 pp; task-high R +24.4, E −14.8, H +1.7. These are contributions to the rate (failing Pulls of a group over the period's Pulls), so they move with the group's share as well as its rate: E is 5.5% of A's Pulls and 71.4% of B's. Reweighting B to A's mix first changes none of them by more than 3.3 pp (the last two columns). Inside one group the drop is: R only 28.2% (103) → 17.9% (28), +10.3 pp [-7.6, 26.8] (with B at A's mix inside the group +9.9 pp [-9.3, 28.1]), which is 80% of the pooled drop; E only has 6 A Pulls, 33.3% → 15.7% (70), +17.6 pp [-18.6, 59.5]. Inside B the R Pulls fail 17.9% and the E Pulls 15.7%, +2.1 pp [-13.6, 18.6]: B's Rulings do not differ by provenance beyond what 98 Pulls can show.

## 8. Calendar view: the same Pulls by session date, split by K

Period B's first session (2026-10-22T08-03) opens before period A's last (2026-10-25T09-45), so the two K values were drawn concurrently over a stretch. Fail rate (Rulings in force, then as first written), slow-high + task-high pooled, by the date of the Pull's session:

| session dates | K | Pulls | failing | fail rate | rate as first written | E | R | H |
|---|---|---|---|---|---|---|---|---|
| 10-11..10-17 | 3 | 47 | 13 | 27.7% | 27.7% | 0 | 46 | 1 |
| 10-18..10-21 | 3 | 57 | 17 | 29.8% | 12.3% | 0 | 57 | 0 |
| 10-22..10-25 | 3 | 6 | 2 | 33.3% | 33.3% | 6 | 0 | 0 |
| 10-22..10-25 | 2 | 28 | 5 | 17.9% | 0.0% | 0 | 28 | 0 |
| 10-26..10-30 | 2 | 70 | 11 | 15.7% | 15.7% | 70 | 0 | 0 |

Overlap stretch, sessions 2026-10-22T08-03 .. 2026-10-25T09-45 (both K drawn): K=3 6 Pulls, 2 failing (33.3%); K=2 28 Pulls, 5 failing (17.9%).
Sessions (to the minute) with Pulls of both K: 0.

### Per session

A session is the unit the install, the controller state and the reviewers' behaviour are shared in, so Pulls of one session are not independent. The Fit's window holds 16 sessions with slow-high/task-high Pulls. `pin` = the `instruments pinned: … (version X)` line of the run's phase-0 receipt (`.fleet/phase0.<UTC stamp>.json`, written within two minutes after the session's start), read from /Users/chris/dev/fleet-plugin/.fleet.

| session start (UTC) | K | Pulls | failing | fail rate | rate as first written | E / R / H | pin |
|---|---|---|---|---|---|---|---|
| 2026-10-11T10:19:42Z | 3 | 1 | 0 | 0.0% | 0.0% | 0 / 1 / 0 | no receipt |
| 2026-10-11T10:52:47Z | 3 | 13 | 5 | 38.5% | 7.7% | 0 / 13 / 0 | no receipt |
| 2026-10-14T15:40:12Z | 3 | 25 | 8 | 32.0% | 48.0% | 0 / 24 / 1 | no receipt |
| 2026-10-17T06:37:13Z | 3 | 8 | 0 | 0.0% | 0.0% | 0 / 8 / 0 | no receipt |
| 2026-10-18T00:00:53Z | 3 | 16 | 2 | 12.5% | 25.0% | 0 / 16 / 0 | no version line (phase0.2026-10-18T000116Z.json) |
| 2026-10-18T18:19:15Z | 3 | 6 | 3 | 50.0% | 16.7% | 0 / 6 / 0 | no version line (phase0.2026-10-18T181936Z.json) |
| 2026-10-19T09:02:17Z | 3 | 6 | 1 | 16.7% | 0.0% | 0 / 6 / 0 | no receipt |
| 2026-10-19T15:04:42Z | 3 | 10 | 4 | 40.0% | 0.0% | 0 / 10 / 0 | no version line (phase0.2026-10-19T150534Z.json) |
| 2026-10-20T11:17:09Z | 3 | 11 | 4 | 36.4% | 0.0% | 0 / 11 / 0 | no version line (phase0.2026-10-20T111752Z.json) |
| 2026-10-21T09:58:51Z | 3 | 8 | 3 | 37.5% | 25.0% | 0 / 8 / 0 | no version line (phase0.2026-10-21T100029Z.json) |
| 2026-10-22T08:03:57Z | 2 | 8 | 2 | 25.0% | 0.0% | 0 / 8 / 0 | no version line (phase0.2026-10-22T080420Z.json) |
| 2026-10-23T22:31:59Z | 2 | 20 | 3 | 15.0% | 0.0% | 0 / 20 / 0 | no receipt |
| 2026-10-25T09:45:34Z | 3 | 6 | 2 | 33.3% | 33.3% | 6 / 0 / 0 | no version line (phase0.2026-10-25T094558Z.json) |
| 2026-10-27T07:41:45Z | 2 | 37 | 7 | 18.9% | 18.9% | 37 / 0 / 0 | no receipt |
| 2026-10-29T20:51:55Z | 2 | 9 | 1 | 11.1% | 11.1% | 9 / 0 / 0 | no version line (phase0.2026-10-29T205223Z.json) |
| 2026-10-30T08:34:47Z | 2 | 24 | 3 | 12.5% | 12.5% | 24 / 0 / 0 | 3.123.1 (phase0.2026-10-30T083515Z.json) |

Cluster bootstrap: whole sessions resampled with replacement inside each period (11 A sessions, 5 B sessions), 1000 resamples; the 95% range of the fail-rate drop A − B, in pp. `R only` restricts both periods to re-ruled Pulls.

| Pulls | drop A − B (pp) | cluster 95% range | Pull-level 95% range (§ 6) |
|---|---|---|---|
| slow-high | +13.0 | [-0.6, 26.0] | [-2.1, 28.4] |
| task-high | +11.2 | [-3.2, 26.9] | [-6.2, 28.0] |
| slow+task | +12.8 | [2.5, 21.0] | [1.8, 23.4] |
| slow+task, R only | +10.3 | [-2.3, 18.3] | n/a |

Reading. The fall appears between the sessions of 10-18..10-21 (29.8%, 57 Pulls, K = 3) and the sessions of 10-22..10-25 (17.9%, 28 Pulls, K = 2) — the same dates the K = 3 draw nearly ended: only one K = 3 session (2026-10-25T09-45, 6 Pulls, 33.3%) lies after 10-22, and no session has Pulls of both K, so the overlap carries no contrast. The calendar is therefore not separable from K or from provenance. Rates by session range from 0% (10-17T06-37, 8 Pulls) to 50% (10-18T18-19, 6 Pulls) in A and from 11.1% to 25.0% in B. The 16 sessions are the unit that shares an install, a controller and its reviewers: with sessions resampled whole (11 A, 5 B) the pooled drop's range is [2.5, 21.0], slow-high [-0.6, 26.0], task-high [-3.2, 26.9], and re-ruled Pulls only [-2.3, 18.3]. The `pin` column: the phase-0 receipts of the main checkout's `.fleet/` name the installed version for one session only, 2026-10-30T08:34:47Z (version 3.123.1, published 2026-10-29T14:09Z, while the newest release at that start was 3.127.1, published 2026-10-30T08:28Z, six minutes earlier): receipts of the runs from 10-18 to 10-29 hold no version line; seven sessions (10-11T10:19, 10-11T10:52, 10-14, 10-17, 10-19T09:02, 10-23, 10-27) have no receipt at all, eight have a receipt with no version line.

## 9. Review, Charges and ruling commits, 2026-10-11 .. 2026-10-30

`git log --since=2026-10-11 --until=2026-10-31 --no-merges` over: plugin/scripts/tier-outcomes.mjs, plugin/scripts/review-core.mjs, plugin/agents/fleet-review-*, plugin/skills/run-team/references/reviewers.md, plugin/commands/review-and-fix.md, plugin/scripts/dispositions-check.mjs, plugin/agents/fleet-fix-applier.agent.md, plugin/skills/run-team/briefs/fix-applier.md, plugin/scripts/reclaim-scratch.mjs, plugin/scripts/closeout.mjs, plugin/scripts/diff-stats.mjs; 122 commits, of which 16 touched only closeout.mjs and/or diff-stats.mjs and are left out (they neither review nor charge nor rule), plus the 1 named commit `e335b127` (the tick's reclaim, whose file is not pathspecced). Categories: `ruling` = tier-outcomes.mjs; `review` = review-core.mjs, fleet-review-* agents, reviewers.md, review-and-fix.md; `charges` = dispositions-check.mjs, the fix-applier agent and brief; `evidence` = reclaim-scratch.mjs and the tick's reclaim.

Availability. Each commit's **first npm release** is the earliest published @feigi/fleet-ctl version whose recorded `gitHead` has the commit as an ancestor (578 releases carry a gitHead present in this checkout; first 2026-10-03T09:07:13.612Z, last 2026-11-01T09:43:49.352Z). The fleet executes an installed package (instruments.sh header), so a commit can only have run in a session that began after its first release was published. `A after` / `B after` = Pulls (slow+task, counted) of that period whose session started after that time, of 110 A and 98 B. Period A's sessions run 2026-10-11T10:19:42Z .. 2026-10-25T09:45:34Z; period B's 2026-10-22T08:03:57Z .. 2026-10-30T08:34:47Z. **Which installed version ran a given session is not recorded in the repository or in the run's phase-0 receipts before 2026-10-30T08:35** (see the note), so `after` is an upper bound: the maintainer may have kept an older install.

| date | sha | categories | commit subject (effect as the subject states it) | first release (published UTC) | A after | B after |
|---|---|---|---|---|---|---|
| 2026-10-11 | 33618b78 | review | docs(review-and-fix): a prose-guard gap sits below the claim bar unless something acts on the guarded text | 3.35.7 (2026-10-11T14:56) | 96 | 98 |
| 2026-10-11 | 614daf37 | review | feat(scratch): computed scratch root replaces the injected-root claim (#2194) | 3.36.0 (2026-10-11T18:04) | 96 | 98 |
| 2026-10-11 | a0c7ab91 | review | fix(scratch): validate pr before resolving the default scratch root; exit 2 when the root cannot be created; name FleetDirUnresolvable in the header ( | 3.36.0 (2026-10-11T18:04) | 96 | 98 |
| 2026-10-11 | 20ca0bb7 | review | fix(scratch): hold an explicit review scratch to the work-tree refusal; pin the git-failure arms of scratchRootRefusal (#2194) | 3.36.0 (2026-10-11T18:04) | 96 | 98 |
| 2026-10-11 | f8900708 | review | fix(ledger): converge a PR's tokens on the PR's row; review tokens only through `ledger.mjs review` | 3.37.0 (2026-10-11T19:03) | 96 | 98 |
| 2026-10-12 | 159a6230 | evidence+review | feat(reclaim-scratch): reclaim the scratch root on GitHub terminal state and age | 3.42.0 (2026-10-12T16:49) | 96 | 98 |
| 2026-10-12 | f26c6671 | evidence | fix(reclaim-scratch): a partial GitHub failure and an unsearchable directory keep their entry | 3.42.0 (2026-10-12T16:49) | 96 | 98 |
| 2026-10-12 | 5c9599ce | evidence | fix(reclaim-scratch): keep a PR in an unrecognised state, say why a body was unparseable, pin batching, symlinks, the cutoff and GH_REPO | 3.42.0 (2026-10-12T16:49) | 96 | 98 |
| 2026-10-12 | af16781e | evidence | fix(reclaim-scratch): unlink a symlink entry before any chmod/chflags can follow it | 3.42.0 (2026-10-12T16:49) | 96 | 98 |
| 2026-10-12 | 751b2fb3 | review | wip: initial suite-slot implementation | 3.43.0 (2026-10-12T19:36) | 96 | 98 |
| 2026-10-12 | 7ecf82f9 | review | feat: implement suite-slot semaphore to bound concurrent test-suite runs | 3.43.0 (2026-10-12T19:36) | 96 | 98 |
| 2026-10-12 | 3d560005 | review | fix: rework the suite slot bound to the maintainer's ruling | 3.43.0 (2026-10-12T19:36) | 96 | 98 |
| 2026-10-13 | b97a474d | review | Fix remaining fallback references and amend ADR 0022 | 3.43.7 (2026-10-13T12:15) | 96 | 98 |
| 2026-10-13 | a7df7b89 | review | WIP: predecessor's partial fix edits for PR 3163 review findings | 3.43.7 (2026-10-13T12:15) | 96 | 98 |
| 2026-10-13 | 2b5f1c3b | review | WIP: redo cutover by hand — tests, docs, comments | 3.43.7 (2026-10-13T12:15) | 96 | 98 |
| 2026-10-13 | 318acf69 | review+charges | feat(review-and-fix): the fix-applier's refuter checks out-of-scope suggestions above the claim bar | 3.45.0 (2026-10-13T14:36) | 96 | 98 |
| 2026-10-13 | b82151a5 | charges | fix(dispositions-check): an out-of-scope verdict path needs its finding directory to be a refuter's location | 3.45.0 (2026-10-13T14:36) | 96 | 98 |
| 2026-10-13 | ea570cd9 | charges | fix(review-and-fix): suggestion refuter findings on the out-of-scope refuter's docs, comments and apply guard | 3.45.0 (2026-10-13T14:36) | 96 | 98 |
| 2026-10-13 | 23f583b5 | review+charges | File every plugin-created issue needs-triage (ADR 0032 supersedes 0001) | 3.47.0 (2026-10-13T19:50) | 96 | 98 |
| 2026-10-13 | c4f1aa27 | review | run-team: ship a red-check fixer dispatch; review-and-fix description true on both paths | 3.47.4 (2026-10-13T22:46) | 96 | 98 |
| 2026-10-13 | 357dccac | review | Change 1-5: Add Install step to snapshot, remove node_modules symlink, update test runner ecosystem examples | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-13 | 4c29bd7c | review | fix(review): run the Recipe Install step in the review snapshot, from its root, after the tree-hash compare | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-13 | 497fe053 | review | fix(review): drop the node_modules special case; report what the snapshot reads untracked after the Install step instead of excluding it | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-13 | cf52cafa | review | fix(review): every own-copy instruction says how to make the copy — tracked files, git init and commit, then the Install step | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-13 | d823f757 | review | fix(review): an Install step that fails in the snapshot skips the shared test run, reports every dimension unrun, and files one finding | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-13 | 734c70b6 | review | fix(review): name an expected fail from two ecosystems, vitest `expected fail` beside pytest `xfailed` | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-14 | bfe7deae | review | fix(review): installFinding claims only the measured exit on a verified snapshot; cap the snapshot's status listing and report a failed read | 3.47.6 (2026-10-13T23:21) | 96 | 98 |
| 2026-10-14 | 0952e3e7 | review | Item 2b: Update review-and-fix.md Specialists section and remove relay references | 3.49.1 (2026-10-14T01:18) | 96 | 98 |
| 2026-10-14 | 3a7f1483 | review | Finish the hand-dispatched-reviewer cutover across its twins | 3.49.1 (2026-10-14T01:18) | 96 | 98 |
| 2026-10-14 | ba59281f | evidence+ruling | feat(tier-outcomes): read sizing from the implementer's report file; member-outcomes `report` column; reclaim removes report files | 3.51.0 (2026-10-15T06:09) | 71 | 98 |
| 2026-10-15 | 3023fa70 | evidence | Review fix for #3199: refuse a --scratch that is not a directory, keep a reports/ whose type cannot be read, say the report layout is the readers' con | 3.51.0 (2026-10-15T06:09) | 71 | 98 |
| 2026-10-15 | 9fe1ee65 | charges | Initial templates and dispatch-prompt.mjs script | 3.54.0 (2026-10-15T09:09) | 71 | 98 |
| 2026-10-15 | 6c30dd92 | charges | Rewrite dispatch-prompt renderer and briefs to the template contract | 3.54.0 (2026-10-15T09:09) | 71 | 98 |
| 2026-10-15 | 69fa2845 | charges | feat: fix-applier agent body, finisher and merge-bot bodies carry their invariant text; briefs keep the per-dispatch lines | 3.56.0 (2026-10-15T13:01) | 71 | 98 |
| 2026-10-15 | f66e501f | charges | fix: review findings on the fix-applier body and fleet-fix-applier dispatch | 3.56.0 (2026-10-15T13:01) | 71 | 98 |
| 2026-10-15 | 46b73322 | charges | fix: give the fix-applier a spawn policy for its refuters; correct finisher and merge-bot prose the split made stale | 3.56.0 (2026-10-15T13:01) | 71 | 98 |
| 2026-10-15 | af7e7495 | charges | feat: ledger.mjs dispatch refuses a member with no rendered brief and records its hash | 3.58.0 (2026-10-15T14:53) | 71 | 98 |
| 2026-10-15 | 7ce49247 | charges | docs: member briefs and bodies name the report file and the one-line message; the controller settles --from-report | 3.59.0 (2026-10-15T16:45) | 71 | 98 |
| 2026-10-15 | 2ce6808c | charges | refactor: SKILL.md loses its verbatim member blocks; suites pin rendered briefs and bodies | 3.61.1 (2026-10-15T21:03) | 71 | 98 |
| 2026-10-15 | 0117a539 | charges | fix: PR review — retire the last say-it-in-the-prompt rules into the briefs, key final sentences in the duplication check, pin the reserved-flag refus | 3.61.1 (2026-10-15T21:03) | 71 | 98 |
| 2026-10-15 | e335b127 | evidence | fleet-tick --apply: reap and reclaim once per merge pass, tier-check every unchecked implementer | 3.57.0 (2026-10-15T14:40) | 71 | 98 |
| 2026-10-16 | e7d51ac6 | other+ruling | fleet-tick callers: the receipt's caps and fleet-event hand the tick --in-flight; a killed implementer's owed replacement is named on the in-flight ho | 3.65.0 (2026-10-16T03:38) | 71 | 98 |
| 2026-10-16 | 194f5c1d | review | run-team: every Measured paragraph of SKILL.md moves to references/, each rule keeping one clause and a pointer | 3.70.0 (2026-10-16T13:54) | 71 | 98 |
| 2026-10-16 | e2dd20f6 | review | feat(review): the snapshot reads the Recipe's uncovered steps and the test environment note names them | 3.71.0 (2026-10-16T14:37) | 71 | 98 |
| 2026-10-17 | 26a30ed9 | review+charges | review: split dimensionsUnrun into crashes and a suiteVerdict on the shared test run | 3.72.0 (2026-10-17T18:40) | 63 | 98 |
| 2026-10-17 | 2062da2d | review | review: build dimensionsUnrun where it is computed, from unrunCrashed alone | 3.72.0 (2026-10-17T18:40) | 63 | 98 |
| 2026-10-17 | 6da64c00 | evidence | Reclaim sibling keys under the scratch parent on every phase 0 | 3.72.1 (2026-10-17T19:30) | 63 | 98 |
| 2026-10-17 | 46ccb05a | evidence | Apply PR #3415 review: harden the sibling pass and report its failures | 3.72.1 (2026-10-17T19:30) | 63 | 98 |
| 2026-10-17 | 79756b4a | evidence | reclaim-scratch: keep an OPEN impl-N/ while its claim worktree stands (#3403) | 3.72.5 (2026-10-17T22:37) | 63 | 98 |
| 2026-10-17 | 6be90651 | evidence | Apply PR #3429 review: unlisted claim dirs are unknown, name the refusing call, pin the match rule | 3.72.5 (2026-10-17T22:37) | 63 | 98 |
| 2026-10-18 | b52805b4 | charges+review | fix: route detached refspec pushes through push-sync.mjs, which moves the claim worktree | 3.76.9 (2026-10-18T14:37) | 47 | 98 |
| 2026-10-18 | d2ef528d | review | review: keep the tests dimension for a production diff with source and no test file | 3.78.0 (2026-10-18T15:36) | 47 | 98 |
| 2026-10-18 | 7c2a85db | review+charges | Add a Recipe Check step: members run CI's non-test merge-gating checks | 3.79.0 (2026-10-18T19:31) | 41 | 98 |
| 2026-10-18 | 6934bb02 | charges | review: apply the PR #3506 review's findings on the Recipe Check step | 3.79.0 (2026-10-18T19:31) | 41 | 98 |
| 2026-10-18 | bbdd866b | other+review | review: snapshot reads the PR from the worktree's repository, not the caller's cwd (#3494) | 3.79.2 (2026-10-18T20:14) | 41 | 98 |
| 2026-10-18 | 4985eb7e | review | review: resolve the snapshot's repository through gh inside the worktree, and record why it could not | 3.79.2 (2026-10-18T20:14) | 41 | 98 |
| 2026-10-19 | 2d18433f | review | Run the Install step with CI unset in claim, proof and review snapshot | 3.82.1 (2026-10-19T13:34) | 35 | 98 |
| 2026-10-19 | b44a1345 | charges | Qualify the no-verify rule, add WIP exemption, hook-rewrite rule, deriver clause | 3.82.1 (2026-10-19T13:34) | 35 | 98 |
| 2026-10-19 | ff628c47 | charges | Update goldens and pre-split fixtures to the new text | 3.82.1 (2026-10-19T13:34) | 35 | 98 |
| 2026-10-19 | 9b416ec9 | review | Qualify review-and-fix step 3's no-bypass rule; scope the glossary's CI sentence | 3.82.1 (2026-10-19T13:34) | 35 | 98 |
| 2026-10-19 | 03e46086 | review | run-team: remove Phase 3 (event loop) from SKILL.md, cut 1 of 5 toward 75,000 bytes | 3.82.4 (2026-10-19T17:38) | 25 | 98 |
| 2026-10-19 | 838f9a50 | review | review-core: run snapshot Install step with env -u CI | 3.82.7 (2026-10-19T19:05) | 25 | 98 |
| 2026-10-19 | d694ecba | review+charges | feat(settle): refuse an implementer or fix-applier report whose head has no green Check-step record | 3.82.14 (2026-10-20T00:44) | 25 | 98 |
| 2026-10-19 | a8e6b844 | review | run-team: remove Phase 2 (dispatch) from SKILL.md (cut 2 of 5 toward 75,000 bytes) | 3.82.14 (2026-10-20T00:44) | 25 | 98 |
| 2026-10-20 | 459da8b3 | review | wip: move Run ledger out of run-team SKILL (#3542) | 3.82.15 (2026-10-20T02:58) | 25 | 98 |
| 2026-10-20 | d0474089 | review | run-team SKILL: move Guards, Queue depth and Tier outcomes guard out (#3543) | 3.82.16 (2026-10-20T04:57) | 25 | 98 |
| 2026-10-20 | 2e62a646 | review | wip: review digest detail to references/reviewers.md (#3545) | 3.82.20 (2026-10-20T08:34) | 25 | 98 |
| 2026-10-20 | 7a1c477d | review | fix: PR #3606 review — green suite, retargeted pins, stale pointers (#3545) | 3.82.20 (2026-10-20T08:34) | 25 | 98 |
| 2026-10-20 | 5974309a | ruling | tier-outcomes check --live: a reviewed PR that closes no issue is noted, not warned about | 3.82.21 (2026-10-20T10:44) | 25 | 98 |
| 2026-10-20 | 21e8d070 | ruling | fix: PR #3613 review — shared closing-refs reader, GH_REPO blanked, gh timeout, read failures say why (#3611) | 3.82.21 (2026-10-20T10:44) | 25 | 98 |
| 2026-10-20 | 6ef539d4 | evidence | reclaim-scratch: a member's <member>.check.json goes with its report | 3.82.26 (2026-10-20T13:38) | 14 | 98 |
| 2026-10-20 | 7c582b44 | evidence | reclaim-scratch: apply PR #3629 review — impl age-alone case discriminates, header rewrap | 3.82.26 (2026-10-20T13:38) | 14 | 98 |
| 2026-10-20 | 460c96ca | evidence | fleet-tick: batch the PR-state probe into one aliased gh api graphql read per 100 PRs | 3.83.1 (2026-10-20T16:58) | 14 | 98 |
| 2026-10-20 | 7b482008 | review+ruling | docs(scripts): retarget comments that cite run-team SKILL.md sections it no longer holds | 3.86.1 (2026-10-20T21:56) | 14 | 98 |
| 2026-10-21 | 849f7bd5 | review+charges | Tell members to compare HEAD^{tree} with their Check-step record after the commit | 3.88.6 (2026-10-21T11:27) | 6 | 98 |
| 2026-10-21 | 62de5a24 | review+charges | List what a commit hook re-staged before re-running recipe-check.mjs | 3.88.6 (2026-10-21T11:27) | 6 | 98 |
| 2026-10-21 | 61eb8457 | ruling | tier-outcomes: take a PR's ticket from its settled impl token | 3.88.7 (2026-10-21T12:11) | 6 | 98 |
| 2026-10-21 | 980d2ae6 | ruling | tier-outcomes: refuse an unreadable closing reference, and say why append refuses a token-named PR | 3.88.7 (2026-10-21T12:11) | 6 | 98 |
| 2026-10-21 | 65254690 | charges | fix(skills): hook-rewrite rule removes untracked hook output, not only unstaged | 3.88.11 (2026-10-21T14:08) | 6 | 98 |
| 2026-10-21 | 46a237ec | charges | fix(skills): bail when the untracked-path clean cannot clear the refusal | 3.88.11 (2026-10-21T14:08) | 6 | 98 |
| 2026-10-21 | c26e918a | ruling | ledger dispatch: refuse an implementer PR's finisher until its ruling is recorded | 3.89.0 (2026-10-21T15:23) | 6 | 98 |
| 2026-10-21 | 217910bc | charges+review | ledger: gate finisher dispatch on the PR's closing references | 3.90.0 (2026-10-21T19:08) | 6 | 98 |
| 2026-10-21 | 40d6cb2a | charges | ledger: share the PR's ruling with the closing-reference gate, trim the record title (PR #3721 review) | 3.90.0 (2026-10-21T19:08) | 6 | 98 |
| 2026-10-22 | dbfabac7 | ruling | closing references: count only own-repository references in every reader | 3.93.1 (2026-10-22T20:02) | 6 | 90 |
| 2026-10-24 | fc7042ed | review | feat(ledger): refuse a finisher for a PR without exactly one release label | 3.98.0 (2026-10-24T14:04) | 6 | 70 |
| 2026-10-24 | 30ca2128 | review | feat(review): the comments dimension checks the PR body and commit messages | 3.100.0 (2026-10-24T21:31) | 6 | 70 |
| 2026-10-24 | b0a1a62d | review | fix(review): show a failed body read, and name the saved bodies to refuters | 3.100.0 (2026-10-24T21:31) | 6 | 70 |
| 2026-10-24 | a0546b66 | charges | recipe-check: a run killed by a signal records nothing and says it was killed | 3.100.3 (2026-10-25T00:00) | 6 | 70 |
| 2026-10-25 | 0f71b510 | review | recipe-check: apply PR #3818 review — release signals once recorded, queue the closing line | 3.100.3 (2026-10-25T00:00) | 6 | 70 |
| 2026-10-25 | 37fb07f2 | review+charges | dispositions-check: require a Charge on the record answering a PR's first review | 3.101.0 (2026-10-25T02:34) | 6 | 70 |
| 2026-10-25 | 78aa079e | charges | dispositions-check, dispatch-prompt: apply PR #3824 review — pin the ticket refusals and Charge rules | 3.101.0 (2026-10-25T02:34) | 6 | 70 |
| 2026-10-25 | f6c08ff0 | other+charges+ruling | tier-outcomes append: work the Ruling out from the Charges | 3.102.0 (2026-10-25T04:53) | 6 | 70 |
| 2026-10-25 | 4c57b325 | charges+ruling | tier-outcomes: apply PR #3826 review — refuse an unreadable record entry or a review file the ledger did not count | 3.102.0 (2026-10-25T04:53) | 6 | 70 |
| 2026-10-25 | c967d2a0 | ruling | tier-outcomes: export the Ruling derivation as the pure deriveRuling | 3.102.2 (2026-10-25T12:45) | 0 | 70 |
| 2026-10-25 | b6fa0e13 | ruling | tier-outcomes: pin the stderr's review run and a both-charged deriveRuling | 3.102.2 (2026-10-25T12:45) | 0 | 70 |
| 2026-10-28 | a893055d | ruling | feat(cost-guard): the guard keeps every per-Cell figure it judged | 3.110.0 (2026-10-28T06:05) | 0 | 33 |
| 2026-10-28 | 17c4a252 | charges | fix(member-write-guard): refuse path writers inside the live Install root | 3.110.1 (2026-10-28T06:37) | 0 | 33 |
| 2026-10-28 | 9e04196b | ruling | Create docs/metrics/ before the first tier-outcomes append and member-outcomes scrape write | 3.110.2 (2026-10-28T07:34) | 0 | 33 |
| 2026-10-28 | a6a1c92c | ruling | Put the else of append's new-file block on the closing brace line | 3.110.2 (2026-10-28T07:34) | 0 | 33 |
| 2026-10-28 | 85f5c921 | charges | fix(report-schema): let a fix-pr report say null where no record or test run exists | 3.110.4 (2026-10-28T08:25) | 0 | 33 |
| 2026-10-28 | 3dd28e45 | charges+review | feat(label-map): solo entry points derive the Label map; dispatched members and the merge bot read it | 3.117.0 (2026-10-28T21:04) | 0 | 33 |
| 2026-10-29 | b59efa4d | charges | feat(dispositions-check): read the home's triage and wontfix labels from the Label map | 3.122.1 (2026-10-29T11:32) | 0 | 33 |
| 2026-10-29 | 6b7f7244 | charges | fix(dispositions-check): tell a missing --review before the Label map; pin the dangling-ledger case to the ledger | 3.122.1 (2026-10-29T11:32) | 0 | 33 |
| 2026-10-30 | 4fa57305 | review | docs(review-and-fix): standalone Label map question names the payload's tableFile and how to make the answer permanent | 3.127.3 (2026-10-30T10:35) | 0 | 0 |
| 2026-10-30 | d1c127b4 | review+charges | feat(run-team): recipe-check exit 4 for a refusal the member cannot clear, member endings, and a Recipe read on the blocked and failed settle wakes | 3.128.0 (2026-10-30T19:48) | 0 | 0 |
| 2026-10-30 | 88058de5 | review+charges | fix(recipe-check): a record it cannot write exits 4; bound the wakes' Recipe read | 3.128.0 (2026-10-30T19:48) | 0 | 0 |
| 2026-10-30 | 4707912c | review | fix: label-map refuses $, backtick and comma in a string; prose carries a mapped string in double quotes | 3.128.3 (2026-10-30T23:46) | 0 | 0 |

Releases published inside period spans: between 2026-10-11T10:19:42Z and 2026-10-25T09:45:34Z: 263; between 2026-10-22T08:03:57Z and 2026-10-30T08:34:47Z: 102. Latest release published before period B's first session: 3.90.0; before period A's first: 3.35.1.

Reading. The log returns 122 commits over the pathspec; 16 of them touched only `closeout.mjs` and/or `diff-stats.mjs` (neither a review, Charges nor ruling file) and are left out of the table; `e335b127` is added by name because its file, `fleet-tick.mjs`, is too large to pathspec wholesale. What the commits changed, read from their messages and bodies (the table's subject column is verbatim): 
- The evidence reclaim chain. `159a6230` (10-12, release 3.42.0): `reclaim-scratch.mjs` removes a merged or closed PR's `pr<M>/` and `dispositions-fix-pr-<M>*.json` and any scratch entry idle for 7 days, run after `reap.sh` "on every merge-bot pass"; the review snapshot's prune becomes `reclaim-scratch.mjs --pr`. `ba59281f` (10-14, 3.51.0): `append` reads `sizing` from `<scratch>/reports/impl-<ticket>.json` and the reclaim removes the report file. `e335b127` (10-15, 3.57.0): `fleet-tick --apply` runs the reap and the reclaim "once per merge pass". `sizing` is blank on 152 of the 255 rows dated from 10-15 and on 3 of the 77 derived ones (§ 2). [INFERENCE] these three commits are the mechanism of those blanks and of the Rulings written without review evidence; the commit message of `e335b127` (2026-10-15 14:41 +0200, released 3.57.0 at 14:40Z) matches Main's 10-15 date, and no recorded install version shows the reclaim ran in any session.
- What review flags. `357dccac`…`d823f757` (10-13, 3.47.6): an Install step in the review snapshot, failures reported as one finding and the shared test run skipped; `e2dd20f6` (10-16, 3.71.0): the snapshot reads the Recipe's uncovered steps; `d2ef528d` (10-18, 3.78.0): the tests dimension is kept for a production diff with source and no test file, and given a coverage-gap duty (mutate the changed source, report behaviour no test kills); `30ca2128` (10-24, 3.100.0): the comments dimension checks the PR body and commit messages (saved to `pr-messages.md`) for false claims.
- What a member runs before it pushes. `7c2a85db` (10-18, 3.79.0): a Recipe Check step, CI's non-test merge-gating checks, run by `next-ticket` before push and by `review-and-fix` step 3 before committing ("the review and the finisher do not run it"); `d694ecba` (10-19, 3.82.14): `settle --from-report` refuses an implementer or fix-applier report whose head has no green Check-step record; `849f7bd5` / `62de5a24` (10-21, 3.88.6): members compare `HEAD^{tree}` with their Check-step record after the commit and list what a commit hook re-staged before re-running the check.
- What is charged and how the Ruling is made. `37fb07f2` (10-25, 3.101.0): the fix-applier gives each standing finding of a PR's first review a Charge (`false-claim`, `unmet`, `both`, or `none` with a reason) and `dispositions-check.mjs` refuses the record without one; `f6c08ff0` (10-25, 3.102.0): `tier-outcomes.mjs append` with no verdict flags works both verdicts and the note out from the Charges (header 2026-10-25, #3805), and hand-given verdicts are accepted only for a PR `gh` reports merged, with `--note`; `4c57b325`, `c967d2a0`, `b6fa0e13` (10-25, to 3.102.2): refuse an unreadable record entry, export `deriveRuling`, pin the both-charged case. `c26e918a` (10-21, 3.89.0): the finisher is refused until the PR's ruling is recorded; `217910bc` / `dbfabac7` (10-21, 10-22): the finisher gate and every reader count only own-repository closing references. Of the 16 commits in the window that touched `tier-outcomes.mjs`, the diffs of 12 contain no added or removed line naming `closed_own_ticket`, `minted_false_claim`, `failsFloor`, `deriveRuling` or `VERDICT`; the four that do are `f6c08ff0` (18 lines), `c967d2a0` (9) and `b6fa0e13` (2), all 10-25, and `a893055d` (10-28, 1 line), which adds `isDerivedNote` itself: the predicate that tells a derived note from a typed one did not exist while either period ran.
- The two re-rules are data commits (`7c98045c` 10-26, `c3f0c6d1` 10-27), not plugin commits.

What the installed version could have run. The fleet executes an installed package (`instruments.sh` header), published on release; `A after` / `B after` count the Pulls whose session began after the commit's first release, the most that could have run it. The newest release before period A's first session was 3.35.1, before B's 3.90.0, and 263 releases were published inside A's span, 102 inside B's. Every commit through `217910bc` / `40d6cb2a` (3.90.0, 2026-10-21T19:08Z) was released before B's first session (2026-10-22T08:03Z) and so was available to all 98 B Pulls; `dbfabac7` (3.93.1, 10-22T20:02Z) to 90. Of the later changes, `30ca2128`, `37fb07f2`, `f6c08ff0` were available to 70 B Pulls (the E sessions, 10-27 on) and 6 A Pulls (the session of 10-25T09-45, since 3.100.0/3.101.0/3.102.0 were published 10-24T21:31Z, 10-25T02:34Z, 10-25T04:53Z) and to none of B's 28 R Pulls; `d2ef528d`, `7c2a85db`, `d694ecba`, `849f7bd5` were available to 47, 41, 25 and 6 of the 110 A Pulls and to all of B. **The version the fleet had installed in each session is not recorded in the repository and, in the receipts, only for the last B session** (3.123.1, not the newest release at that moment): `after` is an upper bound, not what ran.

## 10. Fail rate before and after each release, all counted slow-high + task-high Pulls

For the commits whose subject changes what review flags, what a member runs before push, what is charged, how the Ruling is worked out or whether the evidence survives. A Pull is `after` when its session started after the commit's first release (§ 9). Descriptive only: release time is confounded with calendar time, and with every other change released alongside it.

| sha | change | first release | before: Pulls / failing / rate | after: Pulls / failing / rate | before, period A only | after, period A only |
|---|---|---|---|---|---|---|
| e335b127 | tick reclaims scratch after every merge pass | 3.57.0 (2026-10-15T14:40) | 39 / 13 / 33.3% | 169 / 35 / 20.7% | 39 / 13 / 33.3% | 71 / 19 / 26.8% |
| 159a6230 | reclaim-scratch.mjs; review snapshot prune becomes reclaim --pr | 3.42.0 (2026-10-12T16:49) | 14 / 5 / 35.7% | 194 / 43 / 22.2% | 14 / 5 / 35.7% | 96 / 27 / 28.1% |
| ba59281f | sizing read from report file (reclaim removes report files) | 3.51.0 (2026-10-15T06:09) | 39 / 13 / 33.3% | 169 / 35 / 20.7% | 39 / 13 / 33.3% | 71 / 19 / 26.8% |
| 357dccac | Install step in the review snapshot | 3.47.6 (2026-10-13T23:21) | 14 / 5 / 35.7% | 194 / 43 / 22.2% | 14 / 5 / 35.7% | 96 / 27 / 28.1% |
| e2dd20f6 | snapshot reads the Recipe's uncovered steps | 3.71.0 (2026-10-16T14:37) | 39 / 13 / 33.3% | 169 / 35 / 20.7% | 39 / 13 / 33.3% | 71 / 19 / 26.8% |
| d2ef528d | tests dimension kept for production diff with source and no test file | 3.78.0 (2026-10-18T15:36) | 63 / 15 / 23.8% | 145 / 33 / 22.8% | 63 / 15 / 23.8% | 47 / 17 / 36.2% |
| 7c2a85db | Recipe Check step: members run CI's non-test checks | 3.79.0 (2026-10-18T19:31) | 69 / 18 / 26.1% | 139 / 30 / 21.6% | 69 / 18 / 26.1% | 41 / 14 / 34.1% |
| d694ecba | settle refuses a report with no green Check-step record | 3.82.14 (2026-10-20T00:44) | 85 / 23 / 27.1% | 123 / 25 / 20.3% | 85 / 23 / 27.1% | 25 / 9 / 36.0% |
| 849f7bd5 | members compare HEAD^{tree} with their Check-step record | 3.88.6 (2026-10-21T11:27) | 104 / 30 / 28.8% | 104 / 18 / 17.3% | 104 / 30 / 28.8% | 6 / 2 / 33.3% |
| 30ca2128 | comments dimension checks PR body and commit messages | 3.100.0 (2026-10-24T21:31) | 132 / 35 / 26.5% | 76 / 13 / 17.1% | 104 / 30 / 28.8% | 6 / 2 / 33.3% |
| 37fb07f2 | Charge required on the record answering a first review | 3.101.0 (2026-10-25T02:34) | 132 / 35 / 26.5% | 76 / 13 / 17.1% | 104 / 30 / 28.8% | 6 / 2 / 33.3% |
| f6c08ff0 | append works the Ruling out from the Charges | 3.102.0 (2026-10-25T04:53) | 132 / 35 / 26.5% | 76 / 13 / 17.1% | 104 / 30 / 28.8% | 6 / 2 / 33.3% |

Reading. Splitting all 208 Pulls by each release is confounded with date: every release from `d694ecba` (10-20) to `f6c08ff0` (10-25) shows the same split (26.5–28.8% before, 17.1–20.3% after; `849f7bd5`: 104 Pulls at 28.8% against 104 at 17.3%). Inside period A the Pulls that began after the Check-step releases failed more, not less (after `7c2a85db` 14 of 41 = 34.1% against 18 of 69 = 26.1% before; after `d694ecba` 9 of 25 = 36.0% against 27.1%), on 41 and 25 Pulls.

## Decomposition, as the tables give it

Pooled slow-high + task-high, 29.1% → 16.3%, 12.8 pp (range 1.8 to 23.4 by Pull, 2.5 to 21.0 by session). Slow-high 13.0 pp, task-high 11.2 pp; neither Cell's own range excludes 0.

| piece | slow-high (13.0 pp) | task-high (11.2 pp) | pooled (12.8 pp) | where |
|---|---|---|---|---|
| left after B → A mix, strata / IPW | 14.2 / 8.8 pp | 11.0 / 14.2 pp | 13.1 / 11.7 pp | § 6 |
| left after A → B mix, strata / IPW | 15.6 / 15.3 pp | 5.4 / 3.0 pp | 10.9 / 9.7 pp | § 6 |
| visible in the Rulings as first written | 10.4 pp | 5.2 pp | 8.8 pp | § 4 |
| added by the re-rules | 2.6 pp | 6.0 pp | 4.0 pp | § 4 |
| inside R Rulings (contribution to the drop) | +18.6 pp | +24.4 pp | +21.3 pp | § 7 |
| inside E Rulings (contribution) | −5.6 pp | −14.8 pp | −9.4 pp | § 7 |
| inside H Rulings (contribution) | 0 | +1.7 pp | +0.9 pp | § 7 |
| within R only, A − B | +5.5 pp (49 vs 19 Pulls) | +18.5 pp (54 vs 9) | +10.3 pp [-7.6, 26.8] | § 7 |

The mix explains at most 3.1 pp of the pooled 12.8 pp (A → B, IPW) and between −0.3 and 1.1 pp when B is moved to A's; the provenance split cannot be read independently of the period, because 94% of A is R and 71% of B is E, and the R rows of B are the only R/E overlap (17.9% against 15.7% within B). What is left once mix is removed (9.7 to 13.1 pp pooled) is a difference between A's sessions and B's sessions that these data cannot assign to a Ruling process, a review/charge change, or the Cells: those three move together by calendar (§ 8, § 10) and the only recorded install version is the last session's. [INFERENCE] Whether a given piece of that remainder belongs to the Cells needs a comparison the periods do not hold: a K = 2 draw and a K = 3 draw in the same sessions under the same install, with every Ruling made by one process.

## Contradictions, limits

- #4150 reports the periods' rates; they reproduce here. The ticket's three causes are not separable on this data: provenance, calendar and install are collinear with the period (§ 3, § 8), that collinearity is what §§ 3 and 8 print.
- `isDerivedNote` / `tally().by_hand` read 1 hand-ruled Ruling among these 208; 131 were produced by a re-rule from session evidence rather than the live Charges. The two are both "derived" by the Router's own predicate.
- Map #3673's note says blank-`sizing` Rulings dated from 10-15 hold 1 false claim in 60: confirmed for the file at `712d97ef`; the next commit's 69 backfilled rows (same blank `sizing`) hold 24 more.
- Bootstrap ranges resample Pulls; Pulls of one session share an install and controller. Resampling whole sessions gives ranges no wider than the Pull-level ones (pooled [2.5, 21.0] against [1.8, 23.4]; slow-high [-0.6, 26.0] against [-2.1, 28.4]). [INFERENCE] With 11 A and 5 B sessions and session rates from 0% to 50%, neither is a firm range.
- A first Ruling is read from `git log -p` (the first commit that added a line for the PR); the date of an R row's Ruling is the header's batch date, not a field of the row.
- Release availability uses the registry's `gitHead` ancestry (binary search over releases in time order, which assumes releases come off `main` in order) and session start times from session ids (UTC). Both are upper bounds on what ran.
- Not measured: Pull-level effects of the new `pr-messages.md` comments check on false-claim findings; the cost or quality of the Check step; which install each session ran (not recorded before 2026-10-30).
