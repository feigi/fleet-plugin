# Fit cadence: a Fit at every run boundary against one every 50 merged PRs (issue #4121, map #4118)

## Question

If a repository's Fit ran at every close-out instead of every 50 merged PRs, how
often would its rows change, and how often would it adopt a Cell that is no
cheaper than `slow-high`?

## What was measured, and on what

Inputs: `docs/metrics/{ticket-features,member-outcomes,tier-outcomes}.tsv` of
`e5040b9a` (this branch's base): 268 features rows, 33 189 member rows, 561
verdict rows (blobs `1d8dd680ea`, `d176d764ea`, `511a54145a`, as printed by the
script). Every figure below is the output of
`docs/research/fit-cadence-derive.mjs`, which imports the Router's own modules
from the checkout (`pull-attribution.mjs`: `attribute`, `generations`,
`admissibleRow`; `pr-cost.mjs`: `computeReport`, `guardFile`, `WINDOW_START`;
`ticket-router.mjs`: `fitTable`, `readGuard`, `ruleStratum`, `MIN_N`;
`member-outcomes.mjs`: `parseTsv`, `isImplementer`; `tier-outcomes.mjs`:
`parseTierOutcomes`; `ledger-grammar.mjs`: `CELL`). No figure is re-derived by
hand.

**Anchor to the known facts.** The script's full-corpus guard and Fit reproduce
the facts at `e5040b9a`: slow-high n=104, 20 failed of 104 claims, $14.51 per
merged PR; task-high n=104, $10.28; smol-high n=32, tripped; Fit over 268 Pulls,
stage 2, `burn_in` true, every row `task-high`. `node plugin/scripts/pr-cost.mjs
--json --guard --out <file>` (live `gh pr list`, exit 3 = `tripped`) returns the
same `cells[]`: slow-high 104 / 20 of 104 / $14.51, smol-high 32 / 18 of 32 /
$11.06, task-high 104 / 28 of 104 / $10.28. So the guard built with `prs=null`
(below) equals the CLI's at the corpus's end.

**Corpus shape.** The corpus has 16 runs (distinct `session`s of Pulls dated on
or after the window start 2026-10-03), 2026-10-11 → 2026-10-30. The first Pull
is 2026-10-11, so the window's first eight days hold none. Per run, 1–40 Pulls.
Rulings lag Pulls: 210 of the 268 ruled Pulls hold a Ruling dated after the
Pull's own `run_date` (output line `corpus: …`), so merged counts jump when
rulings land (60 → 143 merged between boundaries 9 and 10). Pull statuses:
261 counted, 6 excluded (no admissible implementer row), 1 unpriced.

### Replay construction

- **Run boundary**: after each of the 16 sessions, sorted by session id (an omp
  id opens with its start time), plus one **end-of-corpus look** (b17) that reads
  every row of the three TSVs — the state a Fit at the corpus's own commit reads,
  because the Rulings of the last runs land after the last run's date (b16 merged
  251, b17 merged 261).
- **Prefix corpus at boundary b**: features rows of sessions ≤ b; member rows
  with `session` ≤ b (exact: a member row is written by its own session); verdict
  rows with `run_date` ≤ the last `run_date` of a features row of a session ≤ b.
  `tier-outcomes.tsv` has a `run_date` column (`COLUMNS`,
  `tier-outcomes.mjs:144`), and `rulingFor` already reads it as the date a
  ruling is on or after (`tier-outcomes.mjs:236-245`).
- **Approximation, stated**: a Ruling's date is a day, a run a timestamp, so a
  Ruling written by a later run of the same day leaks into an earlier run's
  prefix. Only three days hold two runs (10-11, 10-18, 10-19). The script re-runs
  the whole replay with a strict cut (`run_date <` the boundary's date when a
  later run shares that date): the guard tables differ at b7 (merged 36 against
  44) and nowhere else, and every cadence's rows, changes and adoptions come out
  identical (output § "Replay, sensitivity").
- **Prefix guard**: pr-cost exports `computeReport` and `guardFile`
  (`pr-cost.mjs:161`, `:330`), so the script calls them, then `readGuard`, with
  `prs: null`. The CLI reads PR state from `gh pr list`, which is not a function
  of the prefix; with `prs` null `attribute` reads a Pull as merged exactly when
  the prefix holds its Ruling (`pull-attribution.mjs:365`), the reading
  `fitTable` itself takes (`ticket-router.mjs:371-381`). **Effect**: at an
  earlier boundary a real guard would have counted a Pull whose PR was open then
  as `pending` and left its spend out of the Cell's `mean_usd`; the replay
  counts that Pull as an unmerged counted Pull. Only the guard's `tripped` set
  can differ; the CLI cross-check above holds only at the end of the corpus.
  `[INFERENCE]` for the size of this effect at earlier boundaries: not measured.
- **Fit chain**: `fitTable({ prior, features, members, verdicts, guard, commit:
  null })` at each look, `prior` the shipped `router-table.json` at the first
  look and the previous Fit's returned table afterwards, as `fit` rewrites the
  table. Stage and `cells` carry over; the rows are re-judged from scratch each
  time.
- **Cadences.**
  **A**: every boundary (17 looks).
  **B**: the task's definition, boundaries where the cumulative merged count
  crosses a multiple of 50: b9, b10, b11, b15, b16 (merged 60, 143, 152, 231, 251;
  the counts are `attribute`'s counted, merged Pulls, `mergedSince`'s own
  definition, `ticket-router.mjs:633-637`).
  **B-due**: what `ticket-router.mjs fit --due` does (`FIT_EVERY_MERGED = 50`,
  `:76`, `:849-853`): merged Pulls not in the last Fit's features rows ≥ 50. It
  differs from B because it counts from the last Fit, not from multiples of 50:
  b9, b15.
- **A row**: objective × {`*`, `light`, `heavy`} — six slots. A slot's cell is its
  own row, else the `*` row (`rowFor`, `ticket-router.mjs:199`); no Pull is in
  stratum `unknown`. **Row change**: a slot's cell differs from the previous look's
  (the first look compares with the shipped table: all `slow-high`). **Adoption**:
  a slot moves to a Cell other than `slow-high`. **Undone**: a slot that adopted X
  later holds anything other than X at a later look.

## Results 1 — the replay (this repository's one history)

### Boundaries and the guard at each

(Output § "Replay, verdicts cut at run_date <= …"; `cells n (guard)` is merged
PRs of each Cell's newest generation.)

| b | session | date | Pulls | merged | cells n (guard) | tripped |
|--:|---|---|--:|--:|---|---|
| 1 | 2026-10-11T10-19-42 | 2026-10-11 | 1 | 0 | task-high:0 | - |
| 2 | 2026-10-11T10-52-47 | 2026-10-11 | 20 | 3 | slow-high:1 smol-high:0 task-high:2 | - |
| 3 | 2026-10-14T15-40-12 | 2026-10-14 | 60 | 19 | slow-high:6 smol-high:5 task-high:8 | - |
| 4 | 2026-10-17T06-37-13 | 2026-10-17 | 77 | 36 | slow-high:10 smol-high:5 task-high:12 | - |
| 5 | 2026-10-18T00-00-53 | 2026-10-18 | 99 | 36 | slow-high:10 smol-high:5 task-high:12 | - |
| 6 | 2026-10-18T18-19-15 | 2026-10-18 | 107 | 36 | slow-high:10 smol-high:5 task-high:12 | - |
| 7 | 2026-10-19T09-02-17 | 2026-10-19 | 115 | 44 | slow-high:13 smol-high:7 task-high:15 | - |
| 8 | 2026-10-19T15-04-42 | 2026-10-19 | 133 | 44 | slow-high:13 smol-high:7 task-high:15 | - |
| 9 | 2026-10-20T11-17-09 | 2026-10-20 | 149 | 60 | slow-high:17 smol-high:13 task-high:21 | - |
| 10 | 2026-10-21T09-58-51 | 2026-10-21 | 163 | 143 | slow-high:43 smol-high:26 task-high:53 | smol-high |
| 11 | 2026-10-22T08-03-57 | 2026-10-22 | 171 | 152 | slow-high:50 smol-high:26 task-high:55 | smol-high |
| 12 | 2026-10-23T22-31-59 | 2026-10-23 | 191 | 153 | slow-high:50 smol-high:26 task-high:56 | smol-high |
| 13 | 2026-10-25T09-45-34 | 2026-10-25 | 198 | 188 | slow-high:69 smol-high:31 task-high:67 | smol-high |
| 14 | 2026-10-27T07-41-45 | 2026-10-27 | 235 | 191 | slow-high:69 smol-high:32 task-high:69 | smol-high |
| 15 | 2026-10-29T20-51-55 | 2026-10-29 | 244 | 231 | slow-high:86 smol-high:32 task-high:92 | smol-high |
| 16 | 2026-10-30T08-34-47 | 2026-10-30 | 268 | 251 | slow-high:96 smol-high:32 task-high:102 | smol-high |
| 17 | end of corpus | all | 268 | 261 | slow-high:104 smol-high:32 task-high:104 | smol-high |

### Cadence A — a Fit at every boundary (17 looks)

| look | b | stage | burn_in | cost/* | cost/light | cost/heavy | speed/* | speed/light | speed/heavy |
|--:|--:|--:|---|---|---|---|---|---|---|
| 1–9 | 1–9 | 1 | true | slow-high | slow-high | slow-high | slow-high | slow-high | slow-high |
| 10 | 10 | 2 | true | task-high | task-high | slow-high | task-high | task-high | slow-high |
| 11 | 11 | 2 | true | task-high | task-high | slow-high | task-high | task-high | slow-high |
| 12 | 12 | 2 | true | task-high | task-high | slow-high | task-high | task-high | slow-high |
| 13 | 13 | 2 | true | task-high | task-high | slow-high | task-high | task-high | slow-high |
| 14–17 | 14–17 | 2 | true | task-high | task-high | task-high | task-high | task-high | task-high |

(Looks 1–9 are nine identical rows in the output; looks 14–17 four.)

**Row changes 6, adoptions 6, adoptions later undone 0, held at the last look 6.**
Each of the six slots changes once, `slow-high` → `task-high`: four at b10, the
two `heavy` slots at b14. The `heavy` slots wait because `task-high` is
`under-floor` at b10–b12 (its heavy fail rate is 15 points over slow-high's),
`too-dear` at b13 (ratio 0.75, over the 0.75 cut), `qualifies` from b14 (ratio
0.73). Cost rows' weighing at each look, from the output:

- b10 `*`: task-high qualifies, n=53/43 merged, $ ratio 0.66, CI [−8.69, −1.75];
  smol-high tripped. `heavy`: task-high under-floor, ratio 0.75.
- b13 `heavy`: task-high too-dear, n=50/51, ratio 0.75, CI [−7.62, −0.50].
- b14 `heavy`: task-high qualifies, n=52/51, ratio 0.73, CI [−10.74, −0.97].
- b17 `*`: task-high qualifies, n=104/104, ratio 0.71, CI [−6.51, −2.04].

`burn_in` stays `true` through the end: stage 2 adds `slow-medium` and
`task-max` at b10 and no Pull in the corpus ever ran them (the live run used the
shipped 3-Cell table), so `cells.every(n ≥ 20)` never holds
(`ticket-router.mjs:618`).

### Cadence B — a Fit when cumulative merged PRs cross a multiple of 50 (5 looks)

| look | b | stage | burn_in | cost/* | cost/light | cost/heavy | speed/* | speed/light | speed/heavy |
|--:|--:|--:|---|---|---|---|---|---|---|
| 1 | 9 | 1 | true | slow-high | slow-high | slow-high | slow-high | slow-high | slow-high |
| 2 | 10 | 2 | true | task-high | task-high | slow-high | task-high | task-high | slow-high |
| 3 | 11 | 2 | true | task-high | task-high | slow-high | task-high | task-high | slow-high |
| 4 | 15 | 2 | true | task-high | task-high | task-high | task-high | task-high | task-high |
| 5 | 16 | 2 | true | task-high | task-high | task-high | task-high | task-high | task-high |

**Row changes 6, adoptions 6, undone 0, held at the last look 6.** The look at b9
reads slow-high n=17 (< 20), so it judges nothing.

### Cadence B-due — `fit --due`, 50 merged since the last Fit (2 looks)

Looks at b9 (all `slow-high`) and b15 (all six slots `task-high`, stage 2).
**Row changes 6, adoptions 6, undone 0, held 6.**

### Replay summary

| cadence | looks | row changes | adoptions | adoptions later undone | slots on `task-high` at the last look | first adoption |
|---|--:|--:|--:|--:|--:|---|
| A (every boundary) | 17 | 6 | 6 | 0 | 6 | b10 (four slots), b14 (two) |
| B (cross a multiple of 50) | 5 | 6 | 6 | 0 | 6 | b10 (four), b15 (two) |
| B-due (`fit --due`) | 2 | 6 | 6 | 0 | 6 | b15 (all six) |

On this one history the cadence changes **when** rows move and not **whether**:
all three reach the same table. A and B both move the four slots at b10
(2026-10-21, the first look with slow-high n ≥ 20; B looks there because merged
goes 60 → 143, crossing 100). B-due's first informative look is b15
(2026-10-29): its b9 look reads slow-high n=17. A moves the two `heavy` slots at
b14 (2026-10-27); B and B-due at b15. The informative looks are b10–b17 for A
(8), b10, b11, b15, b16 for B (4) and b15 for B-due (1). No look reverses an
adoption, so the replay has no adoption undone. One history is one draw; it says
nothing about how often an adoption is undone (§ 2 does).

## Results 2 — the null simulation

**Design.** Take the final corpus (the 268 Pulls; `attribute` over all three
TSVs). Within each stratum (`light`, `heavy`), permute `chosen_cell` among the
Pulls whose status is not `excluded` (6 Pulls are `excluded`, so 262 are
permuted), keeping their order. In each history 144–189 Pulls change Cell.
For each moved Pull the script relabels its implementer member rows to the new
Cell (`subagent_type` `fleet-implementer-<cell>`, `effort`, and `dispatch_model`
= the model that Cell's original Pulls used at that Pull's session — the latest
original Pull of the new Cell at or before it, else the earliest), so the Pull's
bundle of outcomes (spend, work time, Ruling, review and fix rows) stays with
the Pull and only its Cell label moves. A label-only permutation would make
every moved Pull `excluded`: `admissibleRow` requires `subagentType ===
fleet-implementer-<cell>` (`pull-attribution.mjs:191-194`) `[INFERENCE]` from the
code, not run. Then no Cell is truly different. The script checks on the first
permutation: statuses, strata and merged flags unchanged for every Pull, per
stratum × Cell counts of non-excluded Pulls unchanged, and each Cell keeps its
generations (task-high: sonnet-5-5; slow-high: opus-5-5; smol-high: haiku-5-5
newest, haiku-4-5 older).

Both cadences are replayed over each permuted history, with the same boundaries,
prefix cuts, prefix guards and Fit chains as § 1. **False adoption**: some slot
(any objective, any stratum) holds a Cell other than `slow-high` at some look.
(A speed row inherits the cost row's Cell, so a cost adoption is also a speed
adoption; the speed column counts both.) An **informative look** is one whose
guard has `slow-high` and at least one other Cell at n ≥ 20 merged PRs — the
only looks that can adopt anything.

**N = 250 histories**, seeds 4121 … 4370, 6 worker threads.

| cadence | looks/history | informative looks per history (mean) | histories with a false adoption (any row, any look) | share | exact 95% CI | of them in a cost row | in a speed row |
|---|--:|--:|--:|--:|---|--:|--:|
| A (every boundary) | 17 | 8.84 | 51/250 | 20.4% | 15.6%–25.9% | 39 | 51 |
| B (cross a multiple of 50) | 5 | 4.84 | 37/250 | 14.8% | 10.6%–19.8% | 28 | 37 |
| B-due (`fit --due`) | 2 | 1.84 | 14/250 | 5.6% | 3.1%–9.2% | 12 | 14 |

The interval is Clopper–Pearson, exact binomial 95%. Paired: A only 14
histories, B only 0, both 37, neither 199 (B's looks are a subset of A's
boundaries and the stage-2 Cells have no Pulls, so a B adoption is also an A
adoption). Cells falsely adopted, in histories: A: smol-high 28, task-high 28;
B: smol-high 17, task-high 22; B-due: smol-high 6, task-high 8.

What those adoptions look like:

| cadence | histories whose last look still holds a false adoption | histories with an adoption later undone | looks with a false adoption / informative looks | row changes per history | adoptions per history | adoptions undone per history |
|---|---|---|---|--:|--:|--:|
| A | 14/250 (5.6%) | 45/250 (18.0%) | 116/2211 (5.2%) | 1.36 | 0.75 | 0.62 |
| B | 19/250 (7.6%) | 24/250 (9.6%) | 57/1211 (4.7%) | 0.65 | 0.40 | 0.25 |
| B-due | 14/250 (5.6%) | 0/250 (0.0%) | 14/461 (3.0%) | 0.13 | 0.13 | 0.00 |

Cadence A, histories holding a false adoption at the Fit of boundary b (of 250):
b10=10, b11=14, b12=15, b13=19, b14=11, b15=14, b16=19, b17=14 (b1–b9: 0).
Cadence B at its own looks: b9=0, b10=10, b11=14, b15=14, b16=19. B-due: b9=0,
b15=14. (Row changes and adoptions here are over all histories, not only those
with a false adoption.)

Readings, each from the table above: a single Fit is wrong in 3.0–5.2% of the
informative looks, whichever cadence; the share of histories that are wrong at
some look grows with the number of looks (5.6% with one informative look, 14.8%
with ~5, 20.4% with ~9). Under A, 45 of the 51 false adopters later undo a false
adoption, and 14 histories still hold one at the last look; under B, 24 of 37
undo one and 19 still hold one (B's last look is b16, A's is the end of the
corpus; B-due has no look after b15 and no undo).

## Cost of the measurement

- One Fit (`fitTable`, after the prefix is built): mean 39–209 ms across the
  replay chains in four runs of the script; one prefix guard plus merged count
  (`computeReport`, `guardFile`, `attribute`): 73–287 ms per boundary. The spread
  is the machine's load (the controller's fleet run was live, load average 18–94).
  A real `fit` also needs the three TSVs read at the commit (`showAt`), not
  measured.
- One null history (permute, relabel, 17 prefix guards, 17 + 5 + 2 Fits): mean
  3.0 s CPU in the final run, 5.4, 8.1 and 9.7 s in three earlier runs of the same
  script. The final run: 250 histories, 6 workers, 130 s wall, 12.3 min user
  CPU; whole script (replay, sensitivity replay, null) 2 min 15 s wall. The
  null result was identical in all four runs (deterministic seeds); the four
  runs together took about 48 min of user CPU, over the ~20 min the brief
  allowed, because the script was rerun to add columns (`informative looks`,
  per-boundary counts) and the corpus line.
- Bootstrap precision: `bootstrapDiffCI` is seeded and deterministic (`seed = 1`,
  2000 iterations, `pull-attribution.mjs:131`), so a re-run reads the same
  ranges; the false-adoption shares carry binomial noise only (CI above).

## Caveats

1. **One real history.** § 1 is one ordered corpus of 16 runs from one
   repository; the replay's "0 undone" is one draw. The rates in § 2 are over
   permuted copies of this corpus, so they describe a repository with this
   corpus's size, spend/time variance, failure rate and run sizes.
2. **The permutation moves outcome bundles between Cells**, not just labels
   (without relabeling the member rows every moved Pull would be `excluded`).
   Each Cell keeps its generation line by construction, using the model it had
   at the Pull's session, so the *structure* of generations is kept but the
   count of Pulls on each generation is not: a Cell's newest generation holds a
   different number of Pulls at a given look than in the real history
   (`[INFERENCE]` that this changes the false-adoption rate; it was not varied).
   A permutation of the bare `chosen_cell` column breaks generation structure
   outright (every moved Pull loses its admissible rows).
3. **Time structure is randomised.** Within a stratum the Cells are shuffled
   across the whole final corpus, so each Cell gets Pulls in every run; in the
   real history smol-high ran only until 2026-10-25 and was drawn 6 of 19 in the
   first run. The permuted histories reach n ≥ 20 on a Cell at different
   boundaries from the real one (informative looks per history: mean 8.84 for
   A, 4.84 for B, 1.84 for B-due, against 8, 4 and 1 in the real history).
4. **Stage transitions change the Cell set, and the sim cannot exercise that.**
   Stage 2 adds `slow-medium` and `task-max`; the corpus has no Pull on either, so
   they stay `too-few` in every look and `burn_in` stays `true`. A repository
   whose stage-2 Cells get draws has more candidates per row, which raises the
   chance that one of them is falsely adopted (`[INFERENCE]`; not simulated). In
   the sims 240 of 250 A histories reach stage 2 by the end; stage 1 → 2 needs
   every stage-1 Cell at n ≥ 20 and an adoption or a tripped Cell.
5. **The guard stays on in the null.** A Cell whose mean $ is at or above
   slow-high's, or whose fail rate is 15 points over, is tripped and out of every
   row. Under the null a Cell lands at or above slow-high on mean $ about half the time (`[INFERENCE]`, not counted), so the
   rates are for the whole Router (guard + floor + 0.75 ratio + bootstrap), not
   for the bootstrap alone.
6. **Prefix approximations** (§ replay construction): same-day Ruling leak
   (sensitivity run changes nothing in rows), and `prs=null` in the prefix guard
   (a real guard would hold open-PR Pulls as `pending`).
7. **Cadence B vs `--due`.** The task's B (crossing a multiple of 50) and the
   shipped `--due` (50 since the last Fit) look at different boundaries (b9, b10,
   b11, b15, b16 against b9, b15); both are reported. The ticket's "one every 50
   merged PRs" is the second in code (`ticket-router.mjs:76`, `:849-853`).
8. **Looks per cadence are corpus-bound.** A has 17 looks and 8.84 informative
   ones because nine boundaries come before any Cell has 20 merged PRs. A
   repository with bigger runs has fewer boundaries per 50 merged PRs and A and B
   draw closer.
9. **A history's false adoption is any slot at any look**, counted once; the
   per-look false-adoption share (5.2%, 4.7%, 3.0%) counts a look with at least
   one wrong slot.

## Reproduction

```
git worktree add --detach "$D" e5040b9a   # the inputs' commit; any checkout holding these TSVs works
node docs/research/fit-cadence-derive.mjs --root "$D" --n 250 --workers 6 --seed 4121 --json out.json > out.md
```

Defaults: `--n 30`, `--workers 4`, `--root` the checkout the script sits in.
`--skip-null` replays only (≈ 20 s). Zero dependencies, Node ≥ 20 (worker
threads). The output is deterministic apart from the timings; `--seed S` makes
history h use seed S + h.
