# Where cycle time goes as in-flight depth rises (issue #2872)

Research ticket on the wayfinder map [#2870](https://github.com/feigi/fleet-plugin/issues/2870)
(the In-flight bound). Companion to the baseline ticket #2871, over the same
population. Every number below is printed by
`docs/research/in-flight-cycle-time-stages-derive.mjs`; the tables under
**Population (as read)** and **Results** are that script's output, pasted
verbatim (one elision, marked in place), and the prose under **Reading** and
**Caveats** interprets them.

## Question

The charting read of 2026-10-05 (map #2870, Measured premises) found cycle
time rising with depth at arrival — median 1.1 h at depth 0–2 → 1.8 h at
10+ — while the merge side stayed fast (last `ready-to-merge` → merged median
15 min). Which stage absorbs the extra time, and is depth the cause or merely a
correlate of busy days?

Decompose each merged PR's created→merged into the stages the GitHub tracker
can see — (a) PR open → first review evidence, (b) first review evidence →
first `ready-to-merge`, (c) first `ready-to-merge` → merged, and (d) label
churn (`ready-to-merge` removed and re-added, with the cause where legible and
the time it cost) — report each stage's median and p90 per depth-at-arrival
bucket (0–2, 3–5, 6–9, 10+) and the share of churned PRs per bucket, then
separate depth from busy days: compare PRs of the same day at different depth
and regress cycle time on depth at arrival and same-day arrivals.

## What the tracker can see

Before fixing the stage definitions I read the full GitHub record of fourteen
PRs by hand — the three newest (#2865, #2860, #2840), every PR whose
`ready-to-merge` was off for more than a minute (PRs #2734, #2780, #2808,
then #2506, #2757, #2753 and #2500), the one finisher-halt comment (#2555),
the PR merged with the label off (#2468) and the two with a commit within two
minutes of PR open (#2585, #2491) — through
`GET /issues/<n>/events`, `/pulls/<n>/commits`, `/pulls/<n>/reviews`,
`/pulls/<n>/comments`, `/issues/<n>/comments`, `/issues/<n>/timeline` and the
linked issue's `/issues/<m>/events`. What the fleet's members leave on GitHub,
in the order a PR meets them:

| actor (per the fleet's own docs) | what it writes on GitHub | what it does not |
|---|---|---|
| implementer (the Pull) | `labeled in-progress` on the ticket (the Claim), the PR itself, `labeled patch`/`minor` within seconds of open (the release label) | — |
| the review (`review-core.mjs`: snapshot + specialists + refuters) | **nothing**. `/pulls/<n>/reviews` and `/pulls/<n>/comments` are empty across all 200 PRs. Its return is a `reviewed=<head>` token in the run ledger | so the review's own duration is not legible here |
| fix-applier (`fix-pr-<n>`) | a commit (its `commit.author.date` is the `git commit` moment, surviving the later rebase), a push — a `head_ref_force_pushed` event **only** when it rebased before pushing; a plain `git push origin HEAD:<branch>` leaves no issue event (e.g. #2500's fix commit `b0a014a`, authored 17:21, has no push event before the merge bot's 17:40 rebase) — and, on 99 of 200 PRs, one report comment opening `Review fix applied …`, `Review fixes pushed …`, `Review fix-applier: …`, `Review deferrals filed …` or `Deferred from PR …` | the deferral issues it files are elsewhere |
| finisher (`finisher-pr-<n>`) | `labeled ready-to-merge` | a halt (`halted:past-pin`, `live-editor`, `rebase`) is a ledger token; exactly one PR (#2555) carries a comment saying `finisher-pr-2555 halted (cause: other)` |
| merge bot (one Pass) | `gh pr update-branch --rebase` → a `head_ref_force_pushed` whose commits all carry a `committer.date` equal to the push; then, on 32 of 200 PRs, `unlabeled ready-to-merge` followed by `labeled ready-to-merge` 4 s later (max 56 s) — on 29 straight after that rebase push and about 2 min before `merged`, on 3 (#2319, #2324, #2325, the first merges of 2026-10-02) after the previous evening's push and some 30 min *before* the bot's rebase; `merged`, `closed`, `head_ref_deleted` (`delete-merged-branch.sh`), `unlabeled in-progress` on the ticket | its refusals (`head-moved-after-label`, `label-pulled`, `behind:<n>`, `held-behind-#<lower>`, `conflict-held-#<pr>`, `rebase-fallback`) go to its pass report and the ledger; no PR comment in the population carries any of those words |
| controller | takes `ready-to-merge` off before approving a push onto a labelled head, or when a head moved under the label (`label-off=` in the ledger, `run-team/SKILL.md` **Once the label is on, take it off before you approve any push**) | leaves no comment |
| GitHub itself | `referenced` on a PR or issue when a pushed commit's message cites it (112 events; present only when the message does), `auto_merge_enabled` ×5 / `auto_merge_disabled` ×3, and 52 `Release workflow failed` comments on 51 PRs — all after their merge | — |

Every one of the 1578 events in the population has actor `feigi`: the fleet
runs under one account, so **no role is legible from the actor**, only from
the shape and order of the writes.

Two readings follow from this. First, the 4-second `unlabeled`/`labeled`
pair is not label churn in the ticket's sense: all 32 follow a push that
landed after the previous label — for 29 the merge bot's own rebase, by
signature (a `head_ref_force_pushed` within 2 min of the `committer.date`
every commit on the PR carries, the mark of `gh pr update-branch --rebase`);
for 3 (#2319, #2324, #2325, the first merges of 2026-10-02) a push from the
previous evening whose own nature the later rebase re-dated away — nothing is
pushed or commented inside the gap, and the merge follows within minutes
(median 2 min; some 30 min for those 3, after the bot's morning rebase). It is
consistent with a deliberate re-pin once the head has moved under the label,
so that the timeline the bot gates on (`run-merge-bot.md`, **The labelled
head**: a `labeled` line, then commits, then `merged`, with no `unlabeled`
between) shows the label after the head moved; no shipped document describes
the flip (the one label-off rule, `run-team/SKILL.md` **Once the label is on,
take it off before you approve any push**, precedes a push rather than
following one, and nothing under `plugin/` or `.github/` removes
`ready-to-merge`), and whose hand it is cannot be read off one account. The
script counts it separately as a **re-pin flip** and excludes it from churn.
Second, 36 of 200 PRs were labelled `ready-to-merge` more than once — the
same order as the charting read's "31 of the latest 150" — but 32 of the 36
are re-pin flips only; genuine churn, a label off for longer than a minute
or with a push inside the gap, is 8 PRs.

### Stage definitions, and the signal that stands in for each

| stage | from | to | stand-in and its bias |
|---|---|---|---|
| (0) Claim → open | last `labeled in-progress` on the linked issue (`Closes #m` in the PR body) before the PR opened | `pull.created_at` | context for the In-flight definition (standing decision 7: in flight = Claim to merge); 190 of 200 PRs have it |
| (a) open → first review evidence | `pull.created_at` | the earliest of: the first commit authored after open (`commit.author.date`); the first fix-applier report comment before merge; the first `head_ref_force_pushed` before the first `ready-to-merge`; the first `labeled ready-to-merge` | the review itself writes nothing, so (a) is the review's runtime **plus** the fix-applier's work up to its first commit — an upper bound on the review's return. 29 PRs (15 %) have the label as the first write (no fix, no comment): their (a) is the whole pre-label interval and their (b) is 0 by construction. 2 PRs (#2491, #2585) have a post-open commit under 2 min after open, plausibly the implementer's own follow-up; they are counted as read |
| (b) first review evidence → first `ready-to-merge` | as above | first `labeled ready-to-merge` | the fix-applier's remaining work, its push, CI on the new head, the finisher's dispatch and audit |
| (c) first `ready-to-merge` → merged | first `labeled ready-to-merge` | `pull.merged_at` | the wait for a Pass: numeric-order discipline, `held-behind` and Conflict holds, rebase → CI → merge gate per PR, and any churn. Also (c′) from the **last** label (the charting read's definition, which the re-pin flip shortens to the bot's final minutes) and (c″) from the last label that is not a re-pin flip's relabel |
| (d) churn | each `unlabeled ready-to-merge` | the next `labeled ready-to-merge` (or the merge, when none follows) | a gap ≤ 60 s with no push or comment inside is a re-pin flip, not churn. Otherwise churn, in the shape the record allows: **push-then-label-off** (a push landed after the previous label and before the unlabel: the head moved under the label, the label was cleared, a fresh audit relabelled), **push-then-label-off+push** (the same, with a further push before the relabel), **label-off-then-push** (nothing pushed since the previous label; a push lands inside the gap: the label was pulled ahead of an approved push — a fix-applier on a Conflict hold or a review retry — and a fresh finisher relabelled after it), **label-off-no-push**, **finisher-halt-comment**, **merged-unlabelled**. Time lost = the gap |
| depth at arrival | — | — | population PRs with `created_at` < this PR's `created_at` and `merged_at` > it (the ticket's definition); the one older page fetched as a buffer is used only for a sensitivity line |
| same-day arrivals | — | — | population PRs created on the same UTC calendar day; also arrivals within ±1 h of this PR's creation, a finer busyness measure |
| fleet-live time | — | — | every tracker write on a population PR (open, label on/off, force push, pre-merge comment, merge) marks the fleet live; a gap of more than 30 min between consecutive writes (the p99 of the inter-write gap) is dormant from its 30th minute to the next write. A PR's live interval is its wall interval minus dormant stretches. Reported beside wall time because nights and breaks sit inside cycle time |

Percentiles interpolate linearly, as in `baseline-efficiency-derive.py`.

## Population (as read)

- Query: `GET /repos/feigi/fleet-plugin/pulls?state=closed&sort=created&direction=desc&per_page=100&page=1..2` → 200 closed PRs, 200 merged, 0 closed-unmerged dropped; population = the first 200 merged.
- PRs #2302–#2865 (numbers are not contiguous: issues interleave), created 2026-10-01T10:10:06.000Z → 2026-10-04T20:55:15.000Z, merged 2026-10-01T11:43:22.000Z → 2026-10-04T21:43:18.000Z.
- Open PRs at read time (`GET /pulls?state=open`): 0 — no still-open PR from the window is missing from the depth count.
- Buffer (1 older page, 100 merged PRs, #2028–#2298): 6 of them were still open when the population's first PR arrived; counting them moves 8 PRs to a deeper bucket (sensitivity only; every table below uses the ticket's definition).
- Arrivals per UTC day: 2026-10-01: 8, 2026-10-02: 35, 2026-10-03: 65, 2026-10-04: 92.
- Depth at arrival (population PRs open at each PR's creation): median 6, p75 9, p90 10, max 14, SD 3.33; buckets 0-2: 30, 3-5: 54, 6-9: 80, 10+: 36. Same-day arrivals SD 24.7; arrivals within ±1 h median 7, SD 4.18.
- Linked issues: 192 PRs name `Closes #m` (5 name more than one); 8 name none. Claim (`labeled in-progress` on the linked issue before the PR opened) found for 190.
- Review-side writes: `/pulls/<n>/reviews` 0 across the population, `/pulls/<n>/comments` 0; `/issues/<n>/comments` 163, of which 99 are pre-merge review-side reports (99 PRs) and 52 are post-merge `Release workflow failed` notices.
- `head_ref_force_pushed` events: 375 (196 PRs); commits authored after PR open: 200 (149 PRs), of which 2 PRs have their first one under 5 min after open (#2491, #2585 — plausibly the implementer's own follow-up rather than a fix-applier's). Where a PR has both a post-open commit and a review-side comment, the comment follows the commit by median 7 min (p90 25 min, n=79).
- Comments carrying the ledger's hold/refusal vocabulary (`held-behind`, `conflict-hold`, `past-pin`, `head-moved-after-label`, `label-pulled`, `rebase-fallback`): 0; comments reporting a finisher halt (`finisher-pr-<n> halted`): 1 (#2555). Event actors: feigi.

## Results

### First review evidence — which signal won

| bucket | n | evidence = commit | evidence = comment | evidence = push | evidence = label | label is the first write (review silent) |
|---|---|---|---|---|---|---|
| 0-2 | 30 | 24 | 1 | 0 | 5 | 17 % (5/30) |
| 3-5 | 54 | 40 | 5 | 1 | 8 | 15 % (8/54) |
| 6-9 | 80 | 54 | 12 | 3 | 11 | 14 % (11/80) |
| 10+ | 36 | 29 | 1 | 1 | 5 | 14 % (5/36) |
| all | 200 | 147 | 19 | 5 | 29 | 15 % (29/200) |

### Stages per depth-at-arrival bucket (median / p90)

| bucket | n | cycle created→merged | (0) Claim→open | (a) open→evidence | (b) evidence→first label | (c) first label→merged | (c') last label→merged | (c'') last non-flip label→merged | churn span first→last label (churned PRs) |
|---|---|---|---|---|---|---|---|---|---|
| 0-2 | 30 | 1.55 h / 10.87 h | 14 min / 29 min | 40 min / 1.67 h | 24 min / 1.01 h | 13 min / 3.67 h | 12 min / 35 min | 13 min / 1.73 h | 2.20 h / 2.20 h |
| 3-5 | 54 | 1.26 h / 2.76 h | 12 min / 25 min | 28 min / 1.34 h | 21 min / 47 min | 16 min / 1.09 h | 13 min / 38 min | 16 min / 1.09 h | — |
| 6-9 | 80 | 1.54 h / 3.19 h | 12 min / 25 min | 21 min / 50 min | 26 min / 1.47 h | 25 min / 2.08 h | 22 min / 1.87 h | 25 min / 1.87 h | 1.86 h / 4.99 h |
| 10+ | 36 | 1.83 h / 3.47 h | 17 min / 34 min | 21 min / 55 min | 34 min / 1.52 h | 31 min / 2.03 h | 9 min / 59 min | 27 min / 1.69 h | 2.07 h / 2.38 h |
| all | 200 | 1.51 h / 3.69 h | 13 min / 29 min | 26 min / 1.02 h | 24 min / 1.34 h | 22 min / 1.88 h | 15 min / 1.16 h | 20 min / 1.68 h | 2.14 h / 3.55 h |

Stage shares of the median cycle, all PRs: (a) 29 % (26/91), (b) 26 % (24/91), (c) 24 % (22/91) (medians in minutes; they need not sum to the cycle median).

Mean stage minutes per bucket (means do sum): 0-2: cycle 203 = (a) 69 + (b) 46 + (c) 88; 3-5: cycle 119 = (a) 50 + (b) 35 + (c) 34; 6-9: cycle 130 = (a) 26 + (b) 55 + (c) 49; 10+: cycle 119 = (a) 29 + (b) 39 + (c) 50.

### (d) Label churn per bucket

| bucket | n | labelled ready-to-merge >1× | re-pin flips (≤60 s, nothing inside) | churned PRs (label off >60 s or with a push inside) | churn windows | time lost per churned PR (median / p90) | merged with label off |
|---|---|---|---|---|---|---|---|
| 0-2 | 30 | 13 % (4/30) | 3 PRs / 3 flips | 3 % (1/30) | 1 | 22 min / 22 min | 0 |
| 3-5 | 54 | 24 % (13/54) | 13 PRs / 13 flips | 0 % (0/54) | 0 | — | 0 |
| 6-9 | 80 | 11 % (9/80) | 7 PRs / 7 flips | 5 % (4/80) | 4 | 32 min / 55 min | 1 |
| 10+ | 36 | 28 % (10/36) | 9 PRs / 9 flips | 8 % (3/36) | 3 | 11 min / 18 min | 0 |
| all | 200 | 18 % (36/200) | 32 PRs / 32 flips | 4 % (8/200) | 8 | 22 min / 44 min | 1 |

Churn windows by legible shape (all buckets): **label-off-then-push** 2 (PRs #2753, #2757; label-off median 32 min); **merged-unlabelled** 1 (PRs #2468; label-off n/a); **push-then-label-off** 3 (PRs #2506, #2734, #2780; label-off median 11 min); **push-then-label-off+push** 2 (PRs #2500, #2808; label-off median 40 min).

Re-pin flips: 32 in 32 PRs; gap median 4 s, max 56 s; 32 follow a push that landed after the previous label, 29 of them a rebase by signature (a `head_ref_force_pushed` within 2 min of a `commit.committer.date` on the PR — `gh pr update-branch --rebase` re-dates every commit it lands); the flip precedes the merge by median 2 min.

### (c) against the queue ahead

| lower-numbered population PRs still open at first label | n | (c) first label→merged median / p90 | (c'') last non-flip label→merged median / p90 | churned | depth-at-arrival median |
|---|---|---|---|---|---|
| 0 | 30 | 13 min / 50 min | 12 min / 38 min | 3 % (1/30) | 2 |
| 1-2 | 62 | 14 min / 59 min | 14 min / 48 min | 3 % (2/62) | 4 |
| 3-5 | 67 | 22 min / 1.67 h | 17 min / 1.61 h | 3 % (2/67) | 7 |
| 6+ | 41 | 50 min / 2.39 h | 36 min / 2.05 h | 7 % (3/41) | 9 |

Spearman(lower open at first label, (c)): 0.35; Spearman(depth at arrival, (c)): 0.16; Spearman(depth at arrival, lower open at first label): 0.65.

### Depth or busy day?

| UTC day | arrivals | depth median | cycle median @0-2 (n) | cycle median @3-5 (n) | cycle median @6-9 (n) | cycle median @10+ (n) | Spearman(depth, cycle) within day | PRs with a fix-applier comment |
|---|---|---|---|---|---|---|---|---|
| 2026-10-01 | 8 | 2 | 11.29 h (5) | 5.74 h (3) | — (0) | — (0) | -0.30 | 3 |
| 2026-10-02 | 35 | 2 | 1.39 h (21) | 1.54 h (12) | 9.36 h (2) | — (0) | 0.14 | 18 |
| 2026-10-03 | 65 | 8 | 2.52 h (3) | 1.15 h (12) | 1.42 h (42) | 1.08 h (8) | -0.02 | 28 |
| 2026-10-04 | 92 | 8 | 19 min (1) | 1.18 h (27) | 1.60 h (36) | 1.88 h (28) | 0.33 | 50 |

OLS of log(cycle hours) on standardised predictors (β = change in log-hours per 1 SD; n=200):

- depth at arrival alone: depth β=-0.013 (t=-0.3); R²=0.000
- same-UTC-day arrivals alone: same-day β=-0.030 (t=-0.6); R²=0.002
- both: depth β=-0.005 (t=-0.1), same-day β=-0.029 (t=-0.5); R²=0.002
- arrivals within ±1 h alone: ±1 h β=-0.132 (t=-2.5); R²=0.031
- depth + arrivals within ±1 h: depth β=0.070 (t=1.2), ±1 h β=-0.167 (t=-2.8); R²=0.038
- Spearman(depth, cycle) all PRs: 0.07; Spearman(same-day arrivals, cycle): 0.04; Spearman(depth, same-day arrivals): 0.30.

Per stage, log-hours on depth + same-day arrivals: (a): depth β=-0.248 (t=-4.5), same-day β=0.073 (t=1.3); R²=0.093 (n=200); (b): depth β=0.105 (t=1.3), same-day β=-0.150 (t=-1.9); R²=0.024 (n=171); (c): depth β=0.181 (t=2.1), same-day β=-0.162 (t=-1.9); R²=0.031 (n=200).

### Within-day stage medians (days with ≥ 30 arrivals)

| UTC day | bucket | n | cycle | (a) open→evidence | (b) evidence→first label | (c) first label→merged | (c') last label→merged | churned |
|---|---|---|---|---|---|---|---|---|
| 2026-10-02 | 0-2 | 21 | 1.39 h / 2.25 h | 38 min / 52 min | 26 min / 55 min | 11 min / 34 min | 11 min / 27 min | 0 % (0/21) |
| 2026-10-02 | 3-5 | 12 | 1.54 h / 2.75 h | 34 min / 1.01 h | 27 min / 1.22 h | 20 min / 57 min | 20 min / 35 min | 0 % (0/12) |
| 2026-10-02 | 6-9 | 2 | 9.36 h / 9.62 h | 26 min / 32 min | 6.03 h / 6.23 h | 2.90 h / 2.95 h | 2.90 h / 2.95 h | 0 % (0/2) |
| 2026-10-03 | 0-2 | 3 | 2.52 h / 7.59 h | 1.24 h / 4.72 h | 20 min / 57 min | 11 min / 2.39 h | 11 min / 38 min | 33 % (1/3) |
| 2026-10-03 | 3-5 | 12 | 1.15 h / 5.66 h | 21 min / 5.00 h | 25 min / 1.29 h | 24 min / 1.07 h | 24 min / 1.07 h | 0 % (0/12) |
| 2026-10-03 | 6-9 | 42 | 1.42 h / 2.99 h | 20 min / 34 min | 29 min / 1.65 h | 25 min / 1.80 h | 25 min / 1.17 h | 5 % (2/42) |
| 2026-10-03 | 10+ | 8 | 1.08 h / 3.44 h | 19 min / 26 min | 36 min / 1.21 h | 16 min / 2.10 h | 16 min / 2.10 h | 0 % (0/8) |
| 2026-10-04 | 0-2 | 1 | 19 min / 19 min | 10 min / 10 min | 0 min / 0 min | 9 min / 9 min | 9 min / 9 min | 0 % (0/1) |
| 2026-10-04 | 3-5 | 27 | 1.18 h / 2.10 h | 28 min / 1.28 h | 18 min / 41 min | 12 min / 34 min | 2 min / 28 min | 0 % (0/27) |
| 2026-10-04 | 6-9 | 36 | 1.60 h / 2.84 h | 22 min / 55 min | 21 min / 1.07 h | 26 min / 1.83 h | 15 min / 1.69 h | 6 % (2/36) |
| 2026-10-04 | 10+ | 28 | 1.88 h / 3.44 h | 22 min / 1.19 h | 30 min / 1.49 h | 32 min / 2.00 h | 8 min / 43 min | 11 % (3/28) |

### Dormancy removed: the same stages in fleet-live time

Tracker writes on population PRs: 1165; inter-write gaps above 30 min: 13, dormant time 22.5 h of the window's 83.6 h (10-01 10:10+31 min, 10-01 11:43+272 min, 10-01 18:28+37 min, 10-01 19:36+8 min, 10-01 21:17+490 min, 10-02 13:23+19 min, 10-02 20:38+11 min, 10-03 04:41+37 min, 10-03 06:07+123 min, 10-03 11:50+255 min, 10-03 17:56+29 min, 10-04 05:19+7 min, 10-04 16:52+30 min). PRs whose interval crosses a dormant stretch: 47 (0-2: 10/30, 3-5: 12/54, 6-9: 22/80, 10+: 3/36).

| bucket | n | live cycle | live (a) | live (b) | live (c) | wall cycle (for reference) |
|---|---|---|---|---|---|---|
| 0-2 | 30 | 1.40 h / 3.73 h | 36 min / 1.12 h | 24 min / 1.01 h | 13 min / 2.07 h | 1.55 h / 10.87 h |
| 3-5 | 54 | 1.20 h / 2.34 h | 28 min / 1.00 h | 21 min / 47 min | 16 min / 47 min | 1.26 h / 2.76 h |
| 6-9 | 80 | 1.52 h / 2.79 h | 21 min / 43 min | 26 min / 1.45 h | 25 min / 1.58 h | 1.54 h / 3.19 h |
| 10+ | 36 | 1.80 h / 3.17 h | 21 min / 55 min | 34 min / 1.39 h | 31 min / 1.92 h | 1.83 h / 3.47 h |
| all | 200 | 1.45 h / 2.84 h | 26 min / 57 min | 24 min / 1.29 h | 22 min / 1.60 h | 1.51 h / 3.69 h |

Mean live stage minutes per bucket (means do sum): 0-2: live cycle 115 = (a) 41 + (b) 39 + (c) 35; 3-5: live cycle 89 = (a) 34 + (b) 31 + (c) 24; 6-9: live cycle 115 = (a) 25 + (b) 50 + (c) 40; 10+: live cycle 113 = (a) 29 + (b) 38 + (c) 45.

OLS of log(live cycle hours): depth alone depth β=0.061 (t=1.4); R²=0.010; same-day alone same-day β=0.024 (t=0.5); R²=0.002; both depth β=0.059 (t=1.3), same-day β=0.007 (t=0.1); R²=0.010; depth + ±1 h arrivals depth β=0.106 (t=2.1), ±1 h β=-0.090 (t=-1.8); R²=0.026. Spearman(depth, live cycle) all PRs: 0.13; within day: 2026-10-01 -0.15, 2026-10-02 0.18, 2026-10-03 -0.00, 2026-10-04 0.38.

Per stage in live time, log-hours on depth + same-day arrivals: (a): depth β=-0.181 (t=-3.9), same-day β=0.078 (t=1.7); R²=0.074 (n=200); (b): depth β=0.125 (t=1.6), same-day β=-0.135 (t=-1.7); R²=0.025 (n=171); (c): depth β=0.201 (t=2.7), same-day β=-0.115 (t=-1.5); R²=0.038 (n=200).

Live (c) against the queue ahead: 0 lower open → 13 min / 50 min (n=30); 1-2 lower open → 14 min / 48 min (n=62); 3-5 lower open → 22 min / 1.49 h (n=67); 6+ lower open → 50 min / 2.10 h (n=41).

### Alternative reading tested: depth as a symptom of a slow merge side

Little's law: with arrivals steady, PRs pile up exactly when merges have been slow, so depth at arrival could be a symptom of a slow Pass rather than a cause of a long wait — and a slow Pass would lengthen the arriving PR's own (c) too. (i) The Pass's recent throughput: population PRs with `merged_at` in [created − 2 h, created); the regression runs on PRs whose preceding 2 h were fully fleet-live (no dormant stretch inside), so a sleeping fleet cannot pose as a slow bot. (ii) (c) split into PRs served ahead (population `merged_at` inside (first label, merged)) and per-merge pace ((c) ÷ (served + 1)). (iii) The queue ahead split into lower-numbered PRs already carrying `ready-to-merge` and unmerged at this PR's first label (the Pass's own queue, lowest number first) and lower PRs merely open at that moment (in the Pass's way only when related — `held-behind`).

- (i) Spearman(depth, merges in prior 2 h): 0.32 (all 200), 0.30 (fully-live preceding window, n=138); Spearman(merges in prior 2 h, cycle): -0.16 (all), -0.02 (fully-live).
- (i) OLS on the fully-live subset (n=138; predictors re-standardised within it): log(cycle) on depth alone depth β=0.114 (t=2.0); R²=0.029; on depth + prior merges depth β=0.129 (t=2.2), prior merges β=-0.049 (t=-0.8); R²=0.034. log(live cycle): depth alone depth β=0.154 (t=3.1); R²=0.065; depth + prior merges depth β=0.171 (t=3.2), prior merges β=-0.054 (t=-1.0); R²=0.073.

| bucket | n (with a label) | merges in prior 2 h (median) | served ahead during (c) (median / p90) | pace (c)/(served+1) (median / p90) | live pace (median / p90) | (c) (median / p90) |
|---|---|---|---|---|---|---|
| 0-2 | 30 | 3 | 0.0 / 1.0 | 13 min / 54 min | 13 min / 37 min | 13 min / 3.67 h |
| 3-5 | 54 | 7 | 1.0 / 2.7 | 8 min / 28 min | 8 min / 25 min | 16 min / 1.09 h |
| 6-9 | 80 | 7 | 2.0 / 6.0 | 9 min / 22 min | 9 min / 21 min | 25 min / 2.08 h |
| 10+ | 36 | 9 | 3.0 / 6.5 | 8 min / 17 min | 8 min / 16 min | 31 min / 2.03 h |
| all | 200 | 7 | 1.0 / 6.0 | 9 min / 24 min | 9 min / 22 min | 22 min / 1.88 h |

- (ii) Spearman(depth, served ahead): 0.42; Spearman(depth, pace): -0.17; Spearman(depth, live pace): -0.18; Spearman(lower open at label, served ahead): 0.58; Spearman(lower open at label, pace): -0.06. Pace by bucket in minutes per merge, mean: 0-2 55, 3-5 14, 6-9 16, 10+ 11.

| lower PRs already labelled and unmerged at first label | n | (c) median / p90 | live (c) median / p90 | served ahead (median) | lower PRs open but unlabelled at first label (median) | depth-at-arrival median |
|---|---|---|---|---|---|---|
| 0 | 79 | 12 min / 42 min | 12 min / 42 min | 0 | 1 | 4 |
| 1 | 50 | 16 min / 1.18 h | 16 min / 55 min | 1 | 1 | 5 |
| 2-3 | 48 | 27 min / 2.12 h | 27 min / 1.64 h | 3 | 2 | 8.5 |
| 4+ | 23 | 1.58 h / 2.37 h | 1.46 h / 2.25 h | 6 | 2 | 10 |

- (iii) Spearman((c), lower labelled ahead): 0.50; Spearman((c), lower open but unlabelled): 0.08; Spearman(lower labelled ahead, lower open unlabelled): 0.22. OLS of log((c) hours) on standardised predictors (n=200): labelled + unlabelled labelled ahead β=0.536 (t=7.3), open unlabelled ahead β=-0.069 (t=-0.9); R²=0.211; labelled + unlabelled + depth labelled ahead β=0.624 (t=7.3), open unlabelled ahead β=0.011 (t=0.1), depth β=-0.190 (t=-2.0); R²=0.226.

### Reading

**1. The extra time at depth sits after the review, not in it.** Between the
3–5 and 10+ buckets (54 and 36 PRs; the 0–2 bucket is a special case, point
4) the median cycle rises 1.26 h → 1.83 h. Of the three stages, (a) open →
first review evidence *falls* 28 → 21 min, (b) evidence → first
`ready-to-merge` rises 21 → 34 min, and (c) first `ready-to-merge` → merged
rises 16 → 31 min. The live-time means, which do add up, split the same way:
3–5: 89 min = (a) 34 + (b) 31 + (c) 24; 10+: 113 = 29 + 38 + 45 — of the
24 extra minutes, 21 are in (c), 7 in (b), and (a) gives 5 back. (Wall-clock
means are 119 min in both buckets: 12 of the 54 depth-3–5 PRs crossed a
dormant stretch against 3 of 36 at 10+, which is why means and medians
disagree there and why the live figures are the ones to read.) The same
ordering holds inside each of the two days that populate every bucket
(**Within-day stage medians**): on 2026-10-04, 3–5 → 6–9 → 10+ reads (a)
28 → 22 → 22 min, (b) 18 → 21 → 30 min, (c) 12 → 26 → 32 min; on 2026-10-03
(a) 21 → 20 → 19, (b) 25 → 29 → 36, (c) 24 → 25 → 16 (eight PRs at 10+).

**2. "The merge side stays fast" is true of the last label only.** (c′) last
`ready-to-merge` → merged is 15 min median / 1.16 h p90 — exactly the charting
read's 15 min / 1.2 h, so that number is confirmed, but it measures from the
re-pin flip that precedes the merge by two minutes on 32 PRs. From the last
label that is not a flip (c″) it is 20 min / 1.68 h; from the first label
(c), 22 min / 1.88 h, and 31 min median at 10+ against 16 at 3–5. The
strongest correlate of (c) in the record is not depth at arrival but the
**queue ahead at label time**: with no lower-numbered population PR still open
when the label lands, (c) is 13 min median; with 1–2, 14 min; 3–5, 22 min;
6+, 50 min (p90 2.39 h). Spearman(queue ahead, (c)) = 0.35 against
Spearman(depth at arrival, (c)) = 0.16, and the two correlate 0.65 with each
other. Split by what a Pass actually takes (**Alternative reading tested**,
(iii)), the signal is the *labelled* queue — lower PRs already carrying
`ready-to-merge` and unmerged when this PR's label lands: (c) is 12 min median
with none ahead, 16 with one, 27 with 2–3, 1.58 h with 4+ (n = 79/50/48/23),
Spearman 0.50, β +0.54 log-hours per SD (t = 7.3) — while lower PRs merely
open and unlabelled carry nothing (Spearman 0.08; β −0.07, t = −0.9), so a
`held-behind` hold behind an unlabelled related PR is not a visible driver.
With the labelled queue held, depth at arrival's own coefficient on (c) is
−0.19 (t = −2.0): depth reaches (c) through the queue, not beside it. This is
the Pass's own discipline doing what it says: lowest number first, and after
every merge the next candidate is behind again and pays a rebase → CI → gate
cycle (`run-merge-bot.md`, **Staleness fires within a pass, and it
compounds**). That cycle is the per-merge pace, and it does not stretch with
depth: (c) ÷ (PRs served ahead + 1) is 8–9 min median in every bucket above
0–2 (Spearman with depth −0.17), while the PRs served ahead rise 0 → 1 → 2 → 3
(median). A PR that arrives at depth is labelled while more lower PRs are
already labelled and waiting, and waits one Pass cycle for each.

**3. (b) grows as well, and its inside is not legible.** Evidence → first
label holds the fix-applier's remaining work and push, CI on the new head, the
finisher's dispatch and its audit. It rises 21 → 34 min median (3–5 → 10+)
here, and the live-time regression gives it β = +0.125 log-hours per SD of
depth (t = 1.6) on 200 PRs, +0.36 (t = 5.5) on the 400-PR window below.
Which component stretches — CI contention, finisher dispatch cadence, a
re-review after a `past-pin` halt — is not on GitHub; the missing field is
named under **What could NOT be derived**.

**4. (a) shrinks with depth, and the 0–2 bucket is the cold start.** Open →
first review evidence is 40 → 28 → 21 → 21 min across the buckets (36 → 28
→ 21 → 21 live), β = −0.18 per SD of depth (t = −3.9) in live time. Depth
0–2 arrivals are overwhelmingly the first PRs of a day or a run — 26 of the
30 are from 2026-10-01 and 10-02 (5 and 21), 10 of the 30 cross a dormant
stretch, and the five from 10-01 have a median cycle of 11.3 h. That bucket's
wall p90 of 10.87 h becomes 3.73 h in live time. Whether the review side is
simply warmer at depth, or something else shortens (a), is not legible here.

**5. Churn is rare and cheap, and the charting read's "labelled more than
once" is mostly the re-pin flip.** 36 of 200 PRs (18 %) carry more than one
`labeled ready-to-merge`, the same order as the charting read's 31 of 150;
32 of them are the 4-second re-pin flip with nothing in between (29 straight
after the bot's rebase).
Genuine churn is 8 PRs (4 %): 1/30, 0/54, 4/80, 3/36 by bucket (8 % at 10+),
costing 22 min median / 44 min p90 per churned PR, 2.14 h median from first
to last label. Every window that ends in a relabel has a push in it: on five
PRs the push landed on the labelled head before the label came off (11 min
median off on #2506, #2734 and #2780; 40 min on #2500 and #2808, which took a
further push before the relabel), on two the label came off first and a push
followed (#2753 and #2757, 32 min). Which of the ledger's causes each was — merge-bot
refusal `head-moved-after-label`, a `past-pin` re-review, a finisher halt, a
Conflict hold's fix-applier — is not on GitHub (0 comments carry those words;
the one finisher-halt comment, on #2555, precedes that PR's first label and
caused no churn). At the ticket's granularity — merge-bot refusal, `past-pin`
re-review, finisher halt, `held-behind`, Conflict hold — **0 of 8 windows are
attributable (0 %)**; by the shape the tracker can tell apart, 8 of 8 are (0
`label-off-no-push`); over 400 PRs, 9 of 11 by shape and 2 (#2137, #2143) not
even by shape. #2468 merged 92 s after its label was pulled, with no
relabel — the merge gate's `label-pulled` row should refuse that, so it was
not a Pass that merged it. Churn's share of depth's extra time is small: at
10+ three PRs lost 11 min median each.

**6. Depth or busy day — plainly.** Same-day arrivals explains nothing:
Spearman with cycle 0.04 (−0.03 over 400 PRs), OLS β −0.03 (t = −0.6; −0.08,
t = −1.8 over 400) — a *negative* sign, so busier days are if anything
faster — and it takes only four distinct values here (8, 35, 65, 92), ten
over 400, so it is a coarse regressor by construction. Depth at arrival on
this 200-PR window explains almost nothing overall either: Spearman 0.07
(0.13 live), β −0.01 wall / +0.06 live (t ≤ 1.4), R² ≤ 1 %. Within days it is
day-dependent: 2026-10-04 (92 PRs, every bucket populated) shows the charting
read's rise, 1.18 → 1.60 → 1.88 h with Spearman 0.33 (0.38 live), while
2026-10-03 (65) is flat (−0.02) and 10-02 (35) has no PR above depth 9.
Hour-level busyness runs the other way: arrivals within ±1 h β = −0.13
(t = −2.5), because a busy hour is one in which the fleet is awake; holding it
fixed *raises* depth's coefficient (+0.07 wall, +0.11 live, t = 2.1) — depth
was masked by busyness, not produced by it. The 400-PR window (the charting
read's own population, below) makes the same picture significant: depth β
+0.106 (t = 2.4) alone, +0.139 (t = 3.0) with same-day arrivals held, +0.25
(t = 5.6) with ±1 h arrivals held — roughly +11 % to +28 % cycle time per SD
of depth (2.95 PRs) — against same-day arrivals' −0.117 (t = −2.6); per
stage, (a) −0.11 (t = −2.2), (b) +0.37 (t = 5.2), (c) +0.26 (t = 4.5).
The single largest driver of wall-clock cycle time in either window is
neither: dormancy. 22.5 h of this window's 83.6 h (13 gaps over 30 min;
78.6 of 218.7 h over 400) is fleet-dormant, 47 of 200 PRs cross a dormant
stretch, and every p90 above 3.5 h in the wall tables comes down to 3.7 h or
less in live time (the 0–2 bucket's cycle p90 from 10.87 h to 3.73 h).

**Verdict.** Depth at arrival is not a proxy for busy days: same-day arrivals
carries no signal in either window, and holding busyness fixed never lowers
depth's coefficient — on 400 PRs it rises from +0.106 to +0.139 (same-day
held) and +0.25 (±1 h held); on 200 it moves from nil (−0.01) to +0.07
(t = 1.2) wall and +0.11 (t = 2.1) live. Nor is depth a symptom of a slow
merge side (**Caveats**): the Pass is merging *more*, not less, in the two
hours before a deep arrival, and its per-merge pace is flat across depth; what
depth adds is labelled PRs ahead. It is also not a large effect: on the ticket's
200-PR, four-day window it is within noise overall and visible inside one of
the four days; on the 400-PR window it is significant per stage at
+11–28 % cycle time per SD of depth. Where it lands is consistent in both:
**after the review** — (c), the wait for a Pass, through queue position at
label time, and (b), evidence → label — while the review-side stage (a) runs
*faster* at depth. Confidence: moderate on the direction and the stage, low
on the size — four days (ten over 400), one GitHub account, the review's own
timings unobserved, and a fleet whose code changed daily across the window
(the 400 window's early days show (b) medians of 5–6 min against 18–30 min on
2026-10-04 — a different fleet). For the In-flight bound this says that a hold
on Pulls would shorten the stage whose growth is legible, the Pass's queue;
it would not speed up a review side that already runs faster at depth.

## Against the charting read: the 400-PR window

The map's Measured premises were read off the 400 most recently merged PRs,
PRs #1826–#2865. Re-running the same script with `--population 400` (the
same PRs #1826–#2865, created 2026-09-25T18:58:33Z → 2026-10-04T20:55:15Z,
ten UTC days, 0 closed-unmerged dropped, 0 open at read time) reproduces the charting
read's cycle medians — 1.16 h / 1.27 h / 1.62 h / 1.82 h against its 1.1 /
1.3 / 1.6 / 1.8 — and gives the stage and regression results the four-day
window is too short for. The tables below are that run's output; the full
output has the same sections as above.

#### 400-PR window — Stages per depth-at-arrival bucket (median / p90)

| bucket | n | cycle created→merged | (0) Claim→open | (a) open→evidence | (b) evidence→first label | (c) first label→merged | (c') last label→merged | (c'') last non-flip label→merged | churn span first→last label (churned PRs) |
|---|---|---|---|---|---|---|---|---|---|
| 0-2 | 68 | 1.16 h / 3.94 h | 12 min / 27 min | 37 min / 1.48 h | 8 min / 43 min | 11 min / 44 min | 10 min / 41 min | 11 min / 41 min | 2.20 h / 4.08 h |
| 3-5 | 170 | 1.27 h / 5.88 h | 12 min / 39 min | 32 min / 1.88 h | 7 min / 1.14 h | 16 min / 1.23 h | 15 min / 1.05 h | 16 min / 1.23 h | 3 min / 3 min |
| 6-9 | 125 | 1.62 h / 5.74 h | 13 min / 40 min | 25 min / 1.75 h | 13 min / 1.61 h | 25 min / 1.89 h | 22 min / 1.62 h | 24 min / 1.75 h | 1.86 h / 4.99 h |
| 10+ | 37 | 1.82 h / 3.45 h | 17 min / 36 min | 21 min / 55 min | 34 min / 1.50 h | 30 min / 2.01 h | 11 min / 59 min | 25 min / 1.69 h | 2.07 h / 2.38 h |
| all | 400 | 1.38 h / 5.23 h | 13 min / 36 min | 28 min / 1.76 h | 11 min / 1.29 h | 17 min / 1.60 h | 15 min / 1.09 h | 17 min / 1.29 h | 2.07 h / 4.55 h |

Stage shares of the median cycle, all PRs: (a) 34 % (28/83), (b) 13 % (11/83), (c) 20 % (17/83) (medians in minutes; they need not sum to the cycle median).

Mean stage minutes per bucket (means do sum): 0-2: cycle 125 = (a) 69 + (b) 24 + (c) 32; 3-5: cycle 172 = (a) 78 + (b) 52 + (c) 44; 6-9: cycle 171 = (a) 46 + (b) 72 + (c) 54; 10+: cycle 117 = (a) 30 + (b) 39 + (c) 49.

#### 400-PR window — (d) Label churn per bucket

| bucket | n | labelled ready-to-merge >1× | re-pin flips (≤60 s, nothing inside) | churned PRs (label off >60 s or with a push inside) | churn windows | time lost per churned PR (median / p90) | merged with label off |
|---|---|---|---|---|---|---|---|
| 0-2 | 68 | 7 % (5/68) | 2 PRs / 2 flips | 4 % (3/68) | 3 | 22 min / 3.68 h | 0 |
| 3-5 | 170 | 11 % (18/170) | 17 PRs / 17 flips | 1 % (1/170) | 1 | 2 min / 2 min | 0 |
| 6-9 | 125 | 9 % (11/125) | 9 PRs / 9 flips | 3 % (4/125) | 4 | 32 min / 55 min | 1 |
| 10+ | 37 | 27 % (10/37) | 9 PRs / 9 flips | 8 % (3/37) | 3 | 11 min / 18 min | 0 |
| all | 400 | 11 % (44/400) | 37 PRs / 37 flips | 3 % (11/400) | 11 | 21 min / 1.36 h | 1 |

Churn windows by legible shape (all buckets): **label-off-no-push** 2 (PRs #2137, #2143; label-off median 5 min); **label-off-then-push** 3 (PRs #2136, #2753, #2757; label-off median 32 min); **merged-unlabelled** 1 (PRs #2468; label-off n/a); **push-then-label-off** 3 (PRs #2506, #2734, #2780; label-off median 11 min); **push-then-label-off+push** 2 (PRs #2500, #2808; label-off median 40 min).

Re-pin flips: 37 in 37 PRs; gap median 4 s, max 56 s; 37 follow a push that landed after the previous label, 32 of them a rebase by signature (a `head_ref_force_pushed` within 2 min of a `commit.committer.date` on the PR — `gh pr update-branch --rebase` re-dates every commit it lands); the flip precedes the merge by median 2 min.

#### 400-PR window — (c) against the queue ahead

| lower-numbered population PRs still open at first label | n | (c) first label→merged median / p90 | (c'') last non-flip label→merged median / p90 | churned | depth-at-arrival median |
|---|---|---|---|---|---|
| 0 | 63 | 11 min / 46 min | 11 min / 42 min | 3 % (2/63) | 3 |
| 1-2 | 151 | 14 min / 60 min | 13 min / 54 min | 3 % (4/151) | 4 |
| 3-5 | 134 | 24 min / 1.83 h | 23 min / 1.71 h | 1 % (2/134) | 6 |
| 6+ | 50 | 43 min / 2.39 h | 33 min / 2.07 h | 6 % (3/50) | 9 |

Spearman(lower open at first label, (c)): 0.39; Spearman(depth at arrival, (c)): 0.26; Spearman(depth at arrival, lower open at first label): 0.63.

#### 400-PR window — Depth or busy day?

| UTC day | arrivals | depth median | cycle median @0-2 (n) | cycle median @3-5 (n) | cycle median @6-9 (n) | cycle median @10+ (n) | Spearman(depth, cycle) within day | PRs with a fix-applier comment |
|---|---|---|---|---|---|---|---|---|
| 2026-09-25 | 14 | 5 | 1.11 h (3) | 2.06 h (6) | 2.11 h (5) | — (0) | 0.27 | 1 |
| 2026-09-26 | 69 | 3 | 48 min (12) | 49 min (47) | 37 min (10) | — (0) | -0.03 | 0 |
| 2026-09-27 | 45 | 3 | 55 min (17) | 54 min (26) | 1.29 h (2) | — (0) | 0.10 | 1 |
| 2026-09-28 | 29 | 5 | 2.71 h (4) | 2.82 h (11) | 2.02 h (13) | 1.17 h (1) | -0.30 | 0 |
| 2026-09-29 | 31 | 4 | 1.48 h (6) | 2.84 h (19) | 2.95 h (6) | — (0) | 0.49 | 2 |
| 2026-09-30 | 6 | 5 | — (0) | 28.50 h (4) | 15.81 h (2) | — (0) | -0.09 | 3 |
| 2026-10-01 | 14 | 5.5 | 13.07 h (1) | 10.82 h (6) | 5.87 h (7) | — (0) | -0.48 | 6 |
| 2026-10-02 | 35 | 2 | 1.39 h (21) | 1.54 h (12) | 9.36 h (2) | — (0) | 0.14 | 18 |
| 2026-10-03 | 65 | 8 | 2.52 h (3) | 1.15 h (12) | 1.42 h (42) | 1.08 h (8) | -0.02 | 28 |
| 2026-10-04 | 92 | 8 | 19 min (1) | 1.18 h (27) | 1.60 h (36) | 1.88 h (28) | 0.33 | 50 |

OLS of log(cycle hours) on standardised predictors (β = change in log-hours per 1 SD; n=400):

- depth at arrival alone: depth β=0.106 (t=2.4); R²=0.014
- same-UTC-day arrivals alone: same-day β=-0.078 (t=-1.8); R²=0.008
- both: depth β=0.139 (t=3.0), same-day β=-0.117 (t=-2.6); R²=0.030
- arrivals within ±1 h alone: ±1 h β=-0.270 (t=-6.4); R²=0.093
- depth + arrivals within ±1 h: depth β=0.250 (t=5.6), ±1 h β=-0.368 (t=-8.3); R²=0.160
- Spearman(depth, cycle) all PRs: 0.20; Spearman(same-day arrivals, cycle): -0.03; Spearman(depth, same-day arrivals): 0.25.

Per stage, log-hours on depth + same-day arrivals: (a): depth β=-0.110 (t=-2.2), same-day β=-0.092 (t=-1.9); R²=0.028 (n=400); (b): depth β=0.367 (t=5.2), same-day β=-0.154 (t=-2.2); R²=0.079 (n=321); (c): depth β=0.261 (t=4.5), same-day β=-0.048 (t=-0.8); R²=0.050 (n=398).

#### 400-PR window — Within-day stage medians (days with ≥ 30 arrivals)

| UTC day | bucket | n | cycle | (a) open→evidence | (b) evidence→first label | (c) first label→merged | (c') last label→merged | churned |
|---|---|---|---|---|---|---|---|---|
| 2026-09-26 | 0-2 | 12 | 48 min / 1.45 h | 29 min / 52 min | 6 min / 14 min | 12 min / 31 min | 10 min / 31 min | 0 % (0/12) |
| 2026-09-26 | 3-5 | 47 | 49 min / 1.59 h | 22 min / 41 min | 5 min / 11 min | 11 min / 60 min | 11 min / 60 min | 0 % (0/47) |
| 2026-09-26 | 6-9 | 10 | 37 min / 1.14 h | 15 min / 23 min | 0 min / 8 min | 22 min / 39 min | 22 min / 39 min | 0 % (0/10) |
| 2026-09-27 | 0-2 | 17 | 55 min / 10.03 h | 23 min / 9.04 h | 5 min / 12 min | 16 min / 50 min | 16 min / 50 min | 0 % (0/17) |
| 2026-09-27 | 3-5 | 26 | 54 min / 3.52 h | 26 min / 2.02 h | 6 min / 11 min | 18 min / 50 min | 16 min / 47 min | 0 % (0/26) |
| 2026-09-27 | 6-9 | 2 | 1.29 h / 1.81 h | 38 min / 54 min | 4 min / 7 min | 36 min / 54 min | 36 min / 54 min | 0 % (0/2) |
| 2026-09-29 | 0-2 | 6 | 1.48 h / 2.09 h | 1.04 h / 1.23 h | 16 min / 42 min | 7 min / 15 min | 7 min / 15 min | 0 % (0/6) |
| 2026-09-29 | 3-5 | 19 | 2.84 h / 5.31 h | 1.43 h / 2.41 h | 29 min / 2.32 h | 20 min / 2.34 h | 20 min / 2.34 h | 0 % (0/19) |
| 2026-09-29 | 6-9 | 6 | 2.95 h / 21.62 h | 60 min / 2.09 h | 2.35 h / 19.39 h | 10 min / 14 min | 10 min / 14 min | 0 % (0/6) |
| 2026-10-02 | 0-2 | 21 | 1.39 h / 2.25 h | 38 min / 52 min | 26 min / 55 min | 11 min / 34 min | 11 min / 27 min | 0 % (0/21) |
| 2026-10-02 | 3-5 | 12 | 1.54 h / 2.75 h | 34 min / 1.01 h | 27 min / 1.22 h | 20 min / 57 min | 20 min / 35 min | 0 % (0/12) |
| 2026-10-02 | 6-9 | 2 | 9.36 h / 9.62 h | 26 min / 32 min | 6.03 h / 6.23 h | 2.90 h / 2.95 h | 2.90 h / 2.95 h | 0 % (0/2) |
| 2026-10-03 | 0-2 | 3 | 2.52 h / 7.59 h | 1.24 h / 4.72 h | 20 min / 57 min | 11 min / 2.39 h | 11 min / 38 min | 33 % (1/3) |
| 2026-10-03 | 3-5 | 12 | 1.15 h / 5.66 h | 21 min / 5.00 h | 25 min / 1.29 h | 24 min / 1.07 h | 24 min / 1.07 h | 0 % (0/12) |
| 2026-10-03 | 6-9 | 42 | 1.42 h / 2.99 h | 20 min / 34 min | 29 min / 1.65 h | 25 min / 1.80 h | 25 min / 1.17 h | 5 % (2/42) |
| 2026-10-03 | 10+ | 8 | 1.08 h / 3.44 h | 19 min / 26 min | 36 min / 1.21 h | 16 min / 2.10 h | 16 min / 2.10 h | 0 % (0/8) |
| 2026-10-04 | 0-2 | 1 | 19 min / 19 min | 10 min / 10 min | 0 min / 0 min | 9 min / 9 min | 9 min / 9 min | 0 % (0/1) |
| 2026-10-04 | 3-5 | 27 | 1.18 h / 2.10 h | 28 min / 1.28 h | 18 min / 41 min | 12 min / 34 min | 2 min / 28 min | 0 % (0/27) |
| 2026-10-04 | 6-9 | 36 | 1.60 h / 2.84 h | 22 min / 55 min | 21 min / 1.07 h | 26 min / 1.83 h | 15 min / 1.69 h | 6 % (2/36) |
| 2026-10-04 | 10+ | 28 | 1.88 h / 3.44 h | 22 min / 1.19 h | 30 min / 1.49 h | 32 min / 2.00 h | 8 min / 43 min | 11 % (3/28) |

#### 400-PR window — Dormancy removed

Tracker writes on population PRs: 2073; inter-write gaps above 30 min: 46, dormant time 78.6 h of the window's 218.7 h. PRs whose interval crosses a dormant stretch: 113 (0-2: 18/68, 3-5: 51/170, 6-9: 41/125, 10+: 3/37).

_(The script prints the 46 gaps in parentheses after the dormant total, as the 200-PR line above does; that list is elided here.)_

| bucket | n | live cycle | live (a) | live (b) | live (c) | wall cycle (for reference) |
|---|---|---|---|---|---|---|
| 0-2 | 68 | 1.10 h / 2.56 h | 35 min / 1.36 h | 7 min / 43 min | 11 min / 44 min | 1.16 h / 3.94 h |
| 3-5 | 170 | 1.25 h / 3.33 h | 31 min / 1.52 h | 6 min / 47 min | 16 min / 1.01 h | 1.27 h / 5.88 h |
| 6-9 | 125 | 1.56 h / 3.14 h | 25 min / 1.36 h | 13 min / 1.46 h | 25 min / 1.55 h | 1.62 h / 5.74 h |
| 10+ | 37 | 1.79 h / 3.13 h | 21 min / 55 min | 34 min / 1.38 h | 30 min / 1.91 h | 1.82 h / 3.45 h |
| all | 400 | 1.36 h / 3.24 h | 28 min / 1.43 h | 9 min / 1.20 h | 17 min / 1.29 h | 1.38 h / 5.23 h |

Mean live stage minutes per bucket (means do sum): 0-2: live cycle 93 = (a) 45 + (b) 21 + (c) 27; 3-5: live cycle 107 = (a) 48 + (b) 29 + (c) 30; 6-9: live cycle 118 = (a) 38 + (b) 42 + (c) 38; 10+: live cycle 112 = (a) 30 + (b) 37 + (c) 45.

OLS of log(live cycle hours): depth alone depth β=0.133 (t=3.8); R²=0.036; same-day alone same-day β=-0.031 (t=-0.9); R²=0.002; both depth β=0.154 (t=4.3), same-day β=-0.074 (t=-2.1); R²=0.046; depth + ±1 h arrivals depth β=0.222 (t=6.2), ±1 h β=-0.226 (t=-6.3); R²=0.123. Spearman(depth, live cycle) all PRs: 0.23; within day: 2026-09-25 0.29, 2026-09-26 -0.03, 2026-09-27 0.10, 2026-09-28 -0.25, 2026-09-29 0.48, 2026-09-30 0.03, 2026-10-01 -0.56, 2026-10-02 0.18, 2026-10-03 -0.00, 2026-10-04 0.38.

Per stage in live time, log-hours on depth + same-day arrivals: (a): depth β=-0.073 (t=-1.7), same-day β=-0.089 (t=-2.1); R²=0.025 (n=400); (b): depth β=0.356 (t=5.5), same-day β=-0.106 (t=-1.6); R²=0.086 (n=318); (c): depth β=0.249 (t=4.8), same-day β=-0.024 (t=-0.5); R²=0.057 (n=398).

#### 400-PR window — Alternative reading tested: depth as a symptom of a slow merge side

Little's law: with arrivals steady, PRs pile up exactly when merges have been slow, so depth at arrival could be a symptom of a slow Pass rather than a cause of a long wait — and a slow Pass would lengthen the arriving PR's own (c) too. (i) The Pass's recent throughput: population PRs with `merged_at` in [created − 2 h, created); the regression runs on PRs whose preceding 2 h were fully fleet-live (no dormant stretch inside), so a sleeping fleet cannot pose as a slow bot. (ii) (c) split into PRs served ahead (population `merged_at` inside (first label, merged)) and per-merge pace ((c) ÷ (served + 1)). (iii) The queue ahead split into lower-numbered PRs already carrying `ready-to-merge` and unmerged at this PR's first label (the Pass's own queue, lowest number first) and lower PRs merely open at that moment (in the Pass's way only when related — `held-behind`).

- (i) Spearman(depth, merges in prior 2 h): 0.18 (all 400), 0.18 (fully-live preceding window, n=246); Spearman(merges in prior 2 h, cycle): -0.28 (all), -0.12 (fully-live).
- (i) OLS on the fully-live subset (n=246; predictors re-standardised within it): log(cycle) on depth alone depth β=0.189 (t=4.3); R²=0.070; on depth + prior merges depth β=0.209 (t=4.7), prior merges β=-0.104 (t=-2.3); R²=0.090. log(live cycle): depth alone depth β=0.203 (t=5.2); R²=0.101; depth + prior merges depth β=0.223 (t=5.7), prior merges β=-0.099 (t=-2.5); R²=0.124.

| bucket | n (with a label) | merges in prior 2 h (median) | served ahead during (c) (median / p90) | pace (c)/(served+1) (median / p90) | live pace (median / p90) | (c) (median / p90) |
|---|---|---|---|---|---|---|
| 0-2 | 68 | 4 | 0.0 / 1.3 | 9 min / 33 min | 9 min / 33 min | 11 min / 44 min |
| 3-5 | 169 | 5 | 1.0 / 3.0 | 8 min / 30 min | 8 min / 26 min | 16 min / 1.23 h |
| 6-9 | 124 | 6 | 2.0 / 6.0 | 9 min / 24 min | 9 min / 21 min | 25 min / 1.89 h |
| 10+ | 37 | 9 | 3.0 / 6.4 | 8 min / 16 min | 8 min / 16 min | 30 min / 2.01 h |
| all | 398 | 6 | 1.0 / 4.3 | 8 min / 26 min | 8 min / 24 min | 17 min / 1.60 h |

- (ii) Spearman(depth, served ahead): 0.40; Spearman(depth, pace): 0.01; Spearman(depth, live pace): -0.01; Spearman(lower open at label, served ahead): 0.57; Spearman(lower open at label, pace): 0.03. Pace by bucket in minutes per merge, mean: 0-2 14, 3-5 18, 6-9 16, 10+ 10.

| lower PRs already labelled and unmerged at first label | n | (c) median / p90 | live (c) median / p90 | served ahead (median) | lower PRs open but unlabelled at first label (median) | depth-at-arrival median |
|---|---|---|---|---|---|---|
| 0 | 181 | 11 min / 1.00 h | 11 min / 49 min | 0 | 1 | 4 |
| 1 | 96 | 19 min / 1.15 h | 19 min / 57 min | 1 | 1 | 5 |
| 2-3 | 88 | 26 min / 1.88 h | 26 min / 1.49 h | 3 | 1 | 6 |
| 4+ | 33 | 1.13 h / 2.40 h | 1.13 h / 2.18 h | 5 | 2 | 9 |

- (iii) Spearman((c), lower labelled ahead): 0.44; Spearman((c), lower open but unlabelled): 0.18; Spearman(lower labelled ahead, lower open unlabelled): 0.18. OLS of log((c) hours) on standardised predictors (n=398): labelled + unlabelled labelled ahead β=0.461 (t=8.9), open unlabelled ahead β=0.080 (t=1.5); R²=0.178; labelled + unlabelled + depth labelled ahead β=0.484 (t=7.9), open unlabelled ahead β=0.100 (t=1.7), depth β=-0.047 (t=-0.7); R²=0.179.

Two differences from the 200-PR window matter for reading it. The older six
days ran an earlier fleet: on 2026-09-26 and 09-27 the (b) medians are 5–6 min
and 1 of 114 PRs carries a fix-applier comment, against 18–30 min and a
comment on 50 of 92 PRs on 2026-10-04 (the per-day table's last column, and the within-day table's (b) column) — the
stage boundaries are the same, the machinery behind them was not. And
dormancy is larger (78.6 of 218.7 h), which is why the wall-clock 3–5 bucket's
p90 (5.88 h) and mean (172 min) exceed the 10+ bucket's (3.45 h, 117 min); in
live time they read 3.33 h and 107 min against 3.13 h and 112 min. The two
GitHub reviews and two review comments in this window are inline review
comments on #2112 (2026-09-28), actor `feigi` like every other write; no
fleet member writes inline review comments, so they are read as a human's,
not as review-side writes of the fleet.

## Caveats

**The alternative tried: depth as a symptom of a slow merge side.** Little's
law makes depth and cycle time correlate by construction — PRs pile up when
merges are slow — so the headline could be reverse causation: the Pass was
slow for its own reasons (CI, a Conflict hold, the controller elsewhere), PRs
that arrived then saw high depth, and the same slowness lengthened their (c).
**Alternative reading tested** (under **Results**, and again for the 400-PR
window) puts that to the data three ways. (i) The Pass's throughput in the
two hours before arrival is *higher*, not lower, at depth (Spearman +0.32 on
200 PRs, +0.18 on 400), and once depth is in the model it explains nothing of
cycle time (β −0.05, t = −0.8, on the 138 PRs whose preceding two hours were
fully fleet-live; −0.10, t = −2.3, on 246 of 400) while depth's coefficient
holds (+0.13, t = 2.2; +0.21, t = 4.7). (ii) The per-merge pace a PR meets in
(c) — (c) ÷ (PRs served ahead + 1) — is 8–9 min median in every bucket from
3–5 up, on both windows (Spearman with depth −0.17 and +0.01); what rises with
depth is the count of PRs served ahead, 0 → 1 → 2 → 3 median (Spearman 0.42,
0.40). (c) grows by the number of merges waited for, each at an unchanged
cost — a queue, not a slowdown. (iii) The queue that counts is the labelled
one: (c) against lower PRs already carrying `ready-to-merge` at label time
reads Spearman 0.50 (0.44 over 400), β +0.54 (t = 7.3; +0.46, t = 8.9),
against 0.08 (0.18) and β −0.07 (t = −0.9; +0.08, t = 1.5) for lower PRs
merely open; with both held, depth's own coefficient on (c) is −0.19
(t = −2.0; −0.05, t = −0.7). **Where it lands:** refuted on this record, and
the test sharpens the headline rather than softening it — depth at arrival
predicts (c) only through how many labelled PRs are ahead when the finisher
lands the label, at a flat ~8–9 min per merge. That pace is the Pass's
rebase → CI → gate cycle, one merge per CI cycle, and it is the ceiling an
In-flight bound would be holding Pulls against: a queue forms whenever labels
land faster than one per ~8–9 min. What the test cannot exclude is a common
cause that raises both the labelled queue and (c) without touching pace or
recent throughput — a burst of finisher labels in one minute, say; the per-PR
rows show such bursts (#2734–#2737, created within 3 min at depth 11–14), and
they are a depth effect in all but name.

Smaller caveats, in the order the note meets them:

- **The flip is "after the head moved", not "after the bot's rebase".** 29 of
  the 32 re-pin flips (32 of 37 over 400) follow the bot's rebase by
  signature; #2319, #2324 and #2325 follow the previous evening's push and
  precede the morning rebase by some 30 min. The first run's prose said all
  32; the script now prints the signature count.
- **The (b) regressions describe PRs that had a fix.** They drop the 29 PRs
  (15 %) whose (b) is 0 by construction (label first) — n = 171 of 200, 321
  and 318 of 400 — so their β is conditional on a fix-applier having run; the
  bucket medians include the zeros.
- **Every t here is optimistic.** OLS assumes independent rows; PRs arrive in
  bursts and share a day's fleet state, so the effective n is smaller than
  200 or 400. Read the t-values as an ordering of effects, not as tests.
- **One Pass per CI cycle is read, not observed.** The ~8–9 min pace is
  inferred from merge timestamps; per-head CI run durations
  (`GET /actions/runs?head_sha=`) were not pulled, so whether the pace is CI
  time, gate re-checks or the bot's own turn time is not separated.
- **Numbers in the prose are the script's**, re-run on a fresh cache for this
  review with every table reproducing; the "pasted verbatim" promise has one
  exception, marked in place (the 400-window dormancy line's gap list).

## What could NOT be derived, or is degraded

- **The ledger archives `.fleet/ledger.*.md` were not available.** `.fleet/`
  is gitignored (`.gitignore` line 10: "Fleet runtime state — the ledger, the
  cockpit board, the instrument pin; never committed"), and no `.fleet/`
  directory exists on the machine this ran on, so none of the archives the
  ticket names could be read — not the live ledger, not any archive. Every
  cause the ticket asks for by name is a ledger or pass-report token
  (`reviewed=`, `halted:past-pin`, `label-off=`, `held-behind:#`,
  `conflict-hold:#`, `head-moved-after-label-#`, `label-pulled-#`), and 0 of
  the population's 163 PR comments carry any of them. **Missing field:** the
  merge gate's `reason` and the finisher's `halted:<cause>` posted on the PR
  itself — a comment, as the one `finisher-pr-2555 halted (cause: other)`
  comment already does, or a label — would make every churn window
  attributable without the ledger.
- **The review's own return time is unobserved.** `review-core.mjs` writes
  nothing to GitHub (0 reviews, 0 review comments on 200 PRs); stage (a) is
  therefore the review's runtime plus the fix-applier's work up to its first
  commit, and (b) begins at that commit rather than at the review's return.
  For the 29 PRs (15 %) whose first write is the label, (a) is the whole
  pre-label interval and (b) is 0 by construction. **Missing field:** the
  `reviewed=<head>` moment on the PR — a check run or a comment from the
  `review-pr-<n>` runner.
- **Non-force pushes are invisible.** `head_ref_force_pushed` appears only
  when the pusher rebased first; a plain push leaves no issue event (#2500's
  fix commit is the clear case). The first post-open commit's author date
  stands in; it is the `git commit` moment, not the push. 2 PRs (#2491,
  #2585) have a post-open commit under 2 min after open that is plausibly the
  implementer's own follow-up, counted as read. **Missing field:** per-head CI
  run timestamps (`GET /actions/runs?head_sha=<sha>`) would date each head's
  arrival and split (b) into fix-applier → CI → finisher; not pulled here.
- **`held-behind` and Conflict holds leave no GitHub trace.** A PR held
  behind a lower PR keeps its label; a Conflict hold is a ledger token on the
  ticket's row. Both sit inside (c) unseen; the labelled queue ahead at label
  time is the proxy, and it is the strongest correlate of (c) in the record,
  while lower PRs that are open but unlabelled — the only ones a
  `held-behind` can wait on — carry none, so `held-behind` holds are not a
  visible driver here.
- **No role attribution.** All 1578 events have actor `feigi`; implementer,
  fix-applier, finisher, merge bot and controller are inferred from the shape
  of the writes, including the re-pin flip, whose author cannot be read.
- **Same-day arrivals is coarse and the window is short.** Four UTC days
  (8/35/65/92 arrivals), one of which populates every depth bucket; the
  regressor takes four values. The 400-PR window has ten days and reaches
  t ≈ 5 on the stage effects, at the price of spanning several versions of
  the fleet. A later window should re-run both sizes.
- **Depth is population-relative.** PRs older than the population that were
  still open at an arrival are not counted by the ticket's definition; one
  older page as a buffer finds 6 such PRs, moving 8 of 200 PRs one bucket
  deeper. 0 PRs were open at read time, so nothing newer is missing.
- **The fleet changed under the window.** The plugin ships daily; the 400
  window's early days show a different (b) regime. Stage *definitions* are
  stable across it; the machinery they measure is not.
- **Ignored on purpose:** 52 post-merge `Release workflow failed` comments
  (a workflow's, after `merged`), `auto_merge_enabled` ×5 /
  `auto_merge_disabled` ×3 (no effect on any stage boundary), and
  `referenced` events (present only when a commit message cites the number).

## Reproduction

```
cd /path/to/fleet-plugin
node docs/research/in-flight-cycle-time-stages-derive.mjs --repo feigi/fleet-plugin --population 200
node docs/research/in-flight-cycle-time-stages-derive.mjs --repo feigi/fleet-plugin --population 400   # the charting read's window
```

Zero dependencies; Node ≥ 18. Transport: `gh api` when `gh auth status`
succeeds, else `curl` (with `Authorization: Bearer $GITHUB_TOKEN` when set).
This run used curl through the session's HTTPS proxy, whose core limit read
15,000/h; a personal token's is 5,000/h, and one run of 200 PRs is about 1,200
reads (one listing page per 100 PRs, five per PR, one per linked issue), 400
PRs about 2,400. Raw JSON is cached under `--cache <dir>` (default
`$TMPDIR/in-flight-cycle-time-stages-cache/<owner>__<repo>`), never in the
repository; `--refresh` ignores the cache. Any non-200 status, non-JSON body
or non-array page exits 2 rather than counting a short list, and a population
the repo cannot fill exits 1. Output is the markdown of **Population (as
read)**, **Results** and the per-PR appendix, to stdout; progress to stderr.

To re-run on a later window — the first ≥ 20 merged PRs after the In-flight
bound's cutover — pass the cutover as `--since <ISO 8601>` and the population
as the number merged since it (`--population 20` at the earliest), or bound
both ends with `--since`/`--until`; the population is always the newest
`--population` merged PRs created inside the window, so without `--since` a
re-run simply picks up the newest PRs. To compare against this note, keep the
stage definitions and the 30-minute dormancy threshold (`DORMANT_AFTER`) as
they are; both are constants at the top of the script. `--buffer-pages`
(default 1) sets how many older pages feed the depth sensitivity line only.

## Appendix — per-PR rows (200-PR population)

<details><summary>200 rows: PR, created (UTC), depth, bucket, same-day arrivals, cycle h, live cycle h, (0) claim→open h, (a) h, (b) h, (c) h, (c'') h, evidence kind, ready-to-merge label count, re-pin flips, churn windows (shape:gap min), lower-numbered PRs open at first label, of which already labelled, population PRs merged during (c)</summary>

| PR | created | depth | bucket | same-day | cycle | live cycle | (0) | (a) | (b) | (c) | (c'') | evidence | labels | flips | churn | lower@label | labelled@label | served |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| #2302 | 10-01 10:10 | 0 | 0-2 | 1 | 1.55 | 1.03 | 0.41 | 0.82 | 0.29 | 0.45 | 0.45 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2309 | 10-01 11:11 | 1 | 0-2 | 2 | 18.84 | 5.38 | 1.44 | 6.27 | 1.00 | 11.56 | 11.56 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2310 | 10-01 11:15 | 2 | 0-2 | 3 | 5.87 | 1.33 | 0.04 | 5.64 | 0.00 | 0.23 | 0.23 | label | 1 | 0 | — | 1 | 0 | 0 |
| #2311 | 10-01 11:27 | 3 | 3-5 | 4 | 5.74 | 1.21 | 0.09 | 5.47 | 0.00 | 0.27 | 0.27 | label | 1 | 0 | — | 2 | 1 | 1 |
| #2312 | 10-01 16:45 | 3 | 3-5 | 5 | 1.11 | 1.11 | 5.43 | 0.46 | 0.10 | 0.55 | 0.55 | comment | 1 | 0 | — | 1 | 0 | 0 |
| #2319 | 10-01 18:11 | 1 | 0-2 | 6 | 12.60 | 3.68 | 0.04 | 0.22 | 0.00 | 12.38 | 12.38 | label | 2 | 1 | — | 1 | 0 | 1 |
| #2324 | 10-01 19:35 | 2 | 0-2 | 7 | 11.29 | 2.99 | — | 0.64 | 0.46 | 10.19 | 10.19 | commit | 2 | 1 | — | 2 | 2 | 2 |
| #2325 | 10-01 19:36 | 3 | 3-5 | 8 | 11.35 | 3.05 | — | 0.68 | 0.38 | 10.29 | 10.29 | commit | 2 | 1 | — | 3 | 2 | 3 |
| #2334 | 10-02 07:10 | 0 | 0-2 | 1 | 1.54 | 1.54 | 0.10 | 0.89 | 0.26 | 0.39 | 0.39 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2335 | 10-02 07:27 | 1 | 0-2 | 2 | 1.67 | 1.67 | 0.39 | 0.84 | 0.71 | 0.12 | 0.12 | commit | 1 | 0 | — | 0 | 0 | 1 |
| #2337 | 10-02 07:47 | 2 | 0-2 | 3 | 1.24 | 1.24 | 0.31 | 0.70 | 0.35 | 0.18 | 0.18 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2338 | 10-02 07:49 | 3 | 3-5 | 4 | 1.00 | 1.00 | 0.35 | 0.63 | 0.09 | 0.29 | 0.29 | comment | 1 | 0 | — | 3 | 1 | 1 |
| #2339 | 10-02 08:04 | 4 | 3-5 | 5 | 1.72 | 1.72 | 0.21 | 0.56 | 0.78 | 0.39 | 0.39 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2355 | 10-02 08:45 | 4 | 3-5 | 6 | 1.98 | 1.98 | 0.07 | 0.98 | 0.00 | 1.00 | 1.00 | label | 2 | 1 | — | 1 | 1 | 1 |
| #2356 | 10-02 08:47 | 5 | 3-5 | 7 | 2.03 | 2.03 | 0.12 | 1.01 | 0.76 | 0.26 | 0.26 | commit | 1 | 0 | — | 1 | 1 | 1 |
| #2357 | 10-02 09:12 | 3 | 3-5 | 8 | 1.70 | 1.70 | 0.38 | 0.58 | 0.53 | 0.60 | 0.60 | comment | 1 | 0 | — | 2 | 1 | 2 |
| #2358 | 10-02 09:13 | 4 | 3-5 | 9 | 2.83 | 2.83 | 0.40 | 1.43 | 1.27 | 0.13 | 0.13 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2365 | 10-02 11:03 | 1 | 0-2 | 10 | 2.25 | 2.25 | 0.37 | 0.86 | 1.19 | 0.20 | 0.20 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2366 | 10-02 11:19 | 2 | 0-2 | 11 | 1.42 | 1.42 | 0.24 | 0.81 | 0.47 | 0.14 | 0.14 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2369 | 10-02 11:32 | 3 | 3-5 | 12 | 1.32 | 1.32 | 0.46 | 0.67 | 0.26 | 0.39 | 0.39 | commit | 1 | 0 | — | 2 | 0 | 1 |
| #2376 | 10-02 12:31 | 3 | 3-5 | 13 | 0.87 | 0.87 | 0.15 | 0.22 | 0.45 | 0.20 | 0.20 | commit | 1 | 0 | — | 1 | 1 | 1 |
| #2380 | 10-02 13:23 | 0 | 0-2 | 14 | 1.18 | 0.87 | 0.17 | 0.73 | 0.21 | 0.24 | 0.24 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2379 | 10-02 13:23 | 0 | 0-2 | 15 | 1.79 | 1.48 | 0.17 | 0.64 | 0.35 | 0.80 | 0.80 | commit | 1 | 0 | — | 0 | 0 | 1 |
| #2384 | 10-02 14:24 | 2 | 0-2 | 16 | 1.24 | 1.24 | 0.11 | 0.63 | 0.17 | 0.44 | 0.44 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2387 | 10-02 15:27 | 1 | 0-2 | 17 | 1.31 | 1.31 | 0.31 | 0.45 | 0.78 | 0.09 | 0.09 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2389 | 10-02 15:59 | 1 | 0-2 | 18 | 1.06 | 1.06 | 0.16 | 0.54 | 0.37 | 0.15 | 0.15 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2394 | 10-02 16:55 | 1 | 0-2 | 19 | 0.77 | 0.77 | 0.16 | 0.47 | 0.17 | 0.13 | 0.13 | comment | 1 | 0 | — | 0 | 0 | 0 |
| #2395 | 10-02 16:55 | 2 | 0-2 | 20 | 1.55 | 1.55 | 0.17 | 0.58 | 0.75 | 0.22 | 0.22 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2401 | 10-02 17:45 | 1 | 0-2 | 21 | 1.60 | 1.60 | 0.29 | 0.78 | 0.62 | 0.19 | 0.19 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2402 | 10-02 17:45 | 2 | 0-2 | 22 | 1.03 | 1.03 | 0.30 | 0.43 | 0.47 | 0.12 | 0.12 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2408 | 10-02 19:17 | 1 | 0-2 | 23 | 0.82 | 0.82 | 0.23 | 0.25 | 0.39 | 0.19 | 0.19 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2411 | 10-02 19:47 | 1 | 0-2 | 24 | 0.84 | 0.84 | 0.12 | 0.72 | 0.00 | 0.12 | 0.12 | label | 1 | 0 | — | 0 | 0 | 0 |
| #2412 | 10-02 20:10 | 1 | 0-2 | 25 | 2.42 | 2.23 | 0.49 | 0.89 | 0.92 | 0.62 | 0.62 | commit | 2 | 1 | — | 0 | 0 | 0 |
| #2416 | 10-02 21:19 | 1 | 0-2 | 26 | 1.38 | 1.38 | 0.40 | 0.39 | 0.43 | 0.56 | 0.56 | commit | 1 | 0 | — | 1 | 1 | 1 |
| #2420 | 10-02 21:51 | 2 | 0-2 | 27 | 1.55 | 1.55 | 0.56 | 0.74 | 0.64 | 0.16 | 0.16 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2422 | 10-02 22:43 | 1 | 0-2 | 28 | 10.82 | 8.16 | 0.17 | 0.55 | 10.00 | 0.27 | 0.27 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2424 | 10-02 22:50 | 2 | 0-2 | 29 | 1.39 | 1.39 | 0.29 | 0.59 | 0.43 | 0.37 | 0.37 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2425 | 10-02 22:52 | 3 | 3-5 | 30 | 12.47 | 9.80 | — | 0.40 | 10.93 | 1.14 | 1.14 | commit | 1 | 0 | — | 0 | 0 | 6 |
| #2426 | 10-02 22:56 | 4 | 3-5 | 31 | 1.37 | 1.37 | 0.02 | 0.57 | 0.44 | 0.37 | 0.37 | commit | 1 | 0 | — | 3 | 1 | 1 |
| #2427 | 10-02 22:57 | 5 | 3-5 | 32 | 0.58 | 0.58 | 0.03 | 0.45 | 0.00 | 0.13 | 0.13 | label | 1 | 0 | — | 5 | 1 | 1 |
| #2428 | 10-02 23:11 | 6 | 6-9 | 33 | 9.68 | 7.02 | 0.28 | 0.56 | 6.27 | 2.85 | 2.85 | commit | 1 | 0 | — | 2 | 0 | 0 |
| #2437 | 10-02 23:57 | 5 | 3-5 | 34 | 0.56 | 0.56 | 0.12 | 0.38 | 0.00 | 0.18 | 0.18 | label | 1 | 0 | — | 3 | 0 | 0 |
| #2438 | 10-02 23:57 | 6 | 6-9 | 35 | 9.04 | 6.38 | 0.12 | 0.30 | 5.79 | 2.96 | 2.96 | commit | 1 | 0 | — | 3 | 1 | 1 |
| #2439 | 10-03 00:03 | 7 | 6-9 | 1 | 2.39 | 2.39 | 0.23 | 0.24 | 1.45 | 0.69 | 0.69 | commit | 1 | 0 | — | 4 | 0 | 2 |
| #2442 | 10-03 00:11 | 8 | 6-9 | 2 | 0.62 | 0.62 | 0.10 | 0.42 | 0.00 | 0.20 | 0.20 | label | 1 | 0 | — | 5 | 0 | 0 |
| #2443 | 10-03 00:12 | 9 | 6-9 | 3 | 0.90 | 0.90 | 0.12 | 0.25 | 0.23 | 0.42 | 0.42 | commit | 1 | 0 | — | 6 | 1 | 1 |
| #2448 | 10-03 00:22 | 8 | 6-9 | 4 | 1.56 | 1.56 | 0.28 | 0.33 | 1.05 | 0.18 | 0.18 | commit | 1 | 0 | — | 5 | 0 | 0 |
| #2449 | 10-03 01:09 | 6 | 6-9 | 5 | 0.47 | 0.47 | 0.02 | 0.45 | 0.00 | 0.02 | 0.02 | label | 1 | 0 | — | 6 | 0 | 0 |
| #2450 | 10-03 01:19 | 7 | 6-9 | 6 | 0.90 | 0.90 | 0.18 | 0.31 | 0.06 | 0.53 | 0.53 | comment | 1 | 0 | — | 6 | 0 | 1 |
| #2453 | 10-03 01:26 | 8 | 6-9 | 7 | 1.27 | 1.27 | 0.31 | 0.45 | 0.57 | 0.24 | 0.24 | commit | 1 | 0 | — | 4 | 0 | 0 |
| #2457 | 10-03 01:50 | 8 | 6-9 | 8 | 1.57 | 1.57 | 0.17 | 0.45 | 0.46 | 0.65 | 0.65 | commit | 1 | 0 | — | 4 | 0 | 1 |
| #2461 | 10-03 02:35 | 6 | 6-9 | 9 | 1.62 | 1.62 | 0.10 | 0.31 | 0.96 | 0.35 | 0.35 | commit | 1 | 0 | — | 4 | 0 | 0 |
| #2462 | 10-03 02:36 | 7 | 6-9 | 10 | 1.81 | 1.81 | 0.10 | 0.23 | 1.04 | 0.54 | 0.54 | commit | 1 | 0 | — | 5 | 1 | 1 |
| #2463 | 10-03 02:40 | 8 | 6-9 | 11 | 0.63 | 0.63 | 0.17 | 0.20 | 0.00 | 0.43 | 0.43 | label | 1 | 0 | — | 7 | 1 | 0 |
| #2468 | 10-03 02:57 | 8 | 6-9 | 12 | 7.18 | 4.51 | 0.27 | 0.41 | 5.99 | 0.78 | 0.78 | commit | 1 | 0 | merged-unlabelled:∞ | 2 | 1 | 4 |
| #2469 | 10-03 02:58 | 9 | 6-9 | 13 | 1.52 | 1.52 | 0.29 | 0.41 | 0.65 | 0.46 | 0.46 | commit | 1 | 0 | — | 7 | 2 | 2 |
| #2470 | 10-03 03:10 | 10 | 10+ | 14 | 2.63 | 2.02 | 0.49 | 0.33 | 0.62 | 1.68 | 1.68 | commit | 1 | 0 | — | 8 | 3 | 4 |
| #2477 | 10-03 03:51 | 9 | 6-9 | 15 | 5.22 | 2.56 | 0.12 | 0.16 | 2.07 | 2.99 | 2.99 | commit | 1 | 0 | — | 5 | 2 | 2 |
| #2478 | 10-03 03:51 | 10 | 10+ | 16 | 5.31 | 2.64 | 0.13 | 0.31 | 1.91 | 3.08 | 3.08 | commit | 1 | 0 | — | 6 | 2 | 3 |
| #2479 | 10-03 03:56 | 11 | 10+ | 17 | 0.66 | 0.66 | 0.21 | 0.34 | 0.00 | 0.32 | 0.32 | label | 1 | 0 | — | 10 | 3 | 2 |
| #2486 | 10-03 08:41 | 7 | 6-9 | 18 | 0.95 | 0.95 | 0.13 | 0.19 | 0.38 | 0.37 | 0.37 | comment | 1 | 0 | — | 3 | 0 | 1 |
| #2487 | 10-03 08:41 | 8 | 6-9 | 19 | 1.91 | 1.91 | 0.14 | 0.28 | 1.21 | 0.42 | 0.42 | commit | 1 | 0 | — | 1 | 0 | 1 |
| #2488 | 10-03 08:46 | 9 | 6-9 | 20 | 2.35 | 2.35 | 0.23 | 0.56 | 0.62 | 1.16 | 1.16 | commit | 1 | 0 | — | 3 | 1 | 7 |
| #2489 | 10-03 08:47 | 10 | 10+ | 21 | 2.05 | 2.05 | — | 0.43 | 0.91 | 0.72 | 0.72 | commit | 1 | 0 | — | 4 | 2 | 4 |
| #2491 | 10-03 08:54 | 10 | 10+ | 22 | 0.99 | 0.99 | — | 0.03 | 0.83 | 0.13 | 0.13 | commit | 1 | 0 | — | 5 | 1 | 0 |
| #2493 | 10-03 09:12 | 8 | 6-9 | 23 | 1.49 | 1.49 | 0.19 | 0.18 | 0.58 | 0.74 | 0.74 | commit | 1 | 0 | — | 5 | 1 | 4 |
| #2494 | 10-03 09:14 | 9 | 6-9 | 24 | 1.21 | 1.21 | 0.02 | 0.94 | 0.00 | 0.27 | 0.27 | label | 1 | 0 | — | 5 | 4 | 0 |
| #2495 | 10-03 09:20 | 10 | 10+ | 25 | 0.68 | 0.68 | 0.31 | 0.24 | 0.30 | 0.14 | 0.14 | commit | 1 | 0 | — | 8 | 2 | 1 |
| #2499 | 10-03 10:28 | 5 | 3-5 | 26 | 0.48 | 0.48 | 0.15 | 0.26 | 0.00 | 0.22 | 0.22 | label | 1 | 0 | — | 3 | 3 | 1 |
| #2500 | 10-03 10:30 | 6 | 6-9 | 27 | 7.25 | 3.01 | 0.18 | 0.47 | 0.50 | 6.29 | 0.17 | commit | 2 | 0 | push-then-label-off+push:61 | 0 | 0 | 2 |
| #2501 | 10-03 10:32 | 7 | 6-9 | 28 | 1.28 | 1.28 | 0.21 | 0.40 | 0.52 | 0.36 | 0.36 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2506 | 10-03 11:23 | 2 | 0-2 | 29 | 8.86 | 4.14 | 0.15 | 5.59 | 0.33 | 2.94 | 0.74 | commit | 2 | 0 | push-then-label-off:22 | 1 | 1 | 10 |
| #2507 | 10-03 11:27 | 3 | 3-5 | 30 | 6.00 | 1.75 | 0.21 | 5.54 | 0.30 | 0.15 | 0.15 | commit | 1 | 0 | — | 2 | 1 | 0 |
| #2508 | 10-03 11:47 | 4 | 3-5 | 31 | 7.22 | 2.50 | 0.26 | 5.48 | 0.62 | 1.13 | 1.13 | commit | 1 | 0 | — | 1 | 1 | 0 |
| #2509 | 10-03 16:40 | 4 | 3-5 | 32 | 2.44 | 1.95 | 0.13 | 0.34 | 0.76 | 1.34 | 1.34 | commit | 1 | 0 | — | 2 | 1 | 1 |
| #2510 | 10-03 16:48 | 5 | 3-5 | 33 | 2.60 | 2.11 | 0.16 | 0.46 | 1.72 | 0.42 | 0.42 | commit | 1 | 0 | — | 3 | 3 | 2 |
| #2511 | 10-03 16:48 | 6 | 6-9 | 34 | 3.00 | 2.52 | 0.08 | 0.41 | 0.72 | 1.87 | 1.87 | commit | 1 | 0 | — | 4 | 3 | 3 |
| #2519 | 10-03 17:01 | 7 | 6-9 | 35 | 2.87 | 2.38 | 0.19 | 0.34 | 0.00 | 2.52 | 2.52 | label | 1 | 0 | — | 7 | 3 | 6 |
| #2520 | 10-03 17:03 | 8 | 6-9 | 36 | 2.93 | 2.44 | 0.22 | 0.43 | 0.44 | 2.05 | 2.05 | commit | 1 | 0 | — | 6 | 4 | 5 |
| #2528 | 10-03 17:21 | 9 | 6-9 | 37 | 2.72 | 2.24 | 0.30 | 0.24 | 1.36 | 1.13 | 1.13 | commit | 1 | 0 | — | 7 | 6 | 6 |
| #2529 | 10-03 17:29 | 9 | 6-9 | 38 | 2.68 | 2.20 | 0.22 | 0.40 | 1.12 | 1.17 | 1.17 | commit | 1 | 0 | — | 8 | 8 | 7 |
| #2533 | 10-03 17:52 | 9 | 6-9 | 39 | 2.49 | 2.01 | 0.26 | 1.77 | 0.50 | 0.22 | 0.22 | commit | 1 | 0 | — | 2 | 2 | 2 |
| #2535 | 10-03 19:26 | 7 | 6-9 | 40 | 1.01 | 1.01 | 0.20 | 0.36 | 0.40 | 0.25 | 0.25 | commit | 1 | 0 | — | 2 | 2 | 2 |
| #2536 | 10-03 19:34 | 8 | 6-9 | 41 | 2.53 | 2.53 | — | 0.62 | 1.67 | 0.24 | 0.24 | commit | 1 | 0 | — | 0 | 0 | 1 |
| #2538 | 10-03 19:44 | 9 | 6-9 | 42 | 0.80 | 0.80 | 0.14 | 0.26 | 0.11 | 0.43 | 0.43 | comment | 1 | 0 | — | 5 | 2 | 4 |
| #2539 | 10-03 19:45 | 10 | 10+ | 43 | 1.16 | 1.16 | 0.52 | 0.47 | 0.58 | 0.11 | 0.11 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2554 | 10-03 20:51 | 2 | 0-2 | 44 | 2.52 | 2.52 | 0.48 | 1.24 | 1.10 | 0.19 | 0.19 | commit | 1 | 0 | — | 0 | 0 | 1 |
| #2555 | 10-03 20:54 | 3 | 3-5 | 45 | 2.59 | 2.59 | 0.50 | 0.67 | 1.35 | 0.58 | 0.58 | commit | 1 | 0 | — | 1 | 0 | 2 |
| #2556 | 10-03 20:59 | 3 | 3-5 | 46 | 0.87 | 0.87 | 0.12 | 0.29 | 0.39 | 0.19 | 0.19 | commit | 1 | 0 | — | 3 | 0 | 0 |
| #2557 | 10-03 21:06 | 4 | 3-5 | 47 | 0.35 | 0.35 | 0.19 | 0.19 | 0.11 | 0.04 | 0.04 | comment | 1 | 0 | — | 4 | 0 | 0 |
| #2558 | 10-03 21:08 | 5 | 3-5 | 48 | 1.08 | 1.08 | 0.13 | 0.37 | 0.51 | 0.21 | 0.21 | commit | 1 | 0 | — | 3 | 1 | 1 |
| #2563 | 10-03 21:26 | 6 | 6-9 | 49 | 0.51 | 0.51 | — | 0.28 | 0.00 | 0.24 | 0.24 | label | 1 | 0 | — | 5 | 1 | 1 |
| #2564 | 10-03 21:27 | 7 | 6-9 | 50 | 1.06 | 1.06 | 0.27 | 0.95 | 0.00 | 0.11 | 0.11 | label | 1 | 0 | — | 2 | 0 | 0 |
| #2567 | 10-03 21:36 | 7 | 6-9 | 51 | 0.70 | 0.70 | 0.14 | 0.31 | 0.00 | 0.39 | 0.39 | label | 1 | 0 | — | 6 | 2 | 3 |
| #2575 | 10-03 22:31 | 2 | 0-2 | 52 | 0.74 | 0.74 | 0.09 | 0.59 | 0.00 | 0.15 | 0.15 | label | 1 | 0 | — | 2 | 1 | 0 |
| #2576 | 10-03 22:31 | 3 | 3-5 | 53 | 1.15 | 1.15 | 0.09 | 0.22 | 0.43 | 0.50 | 0.50 | commit | 1 | 0 | — | 3 | 2 | 3 |
| #2577 | 10-03 22:42 | 4 | 3-5 | 54 | 1.08 | 1.08 | 0.17 | 0.34 | 0.31 | 0.42 | 0.42 | commit | 1 | 0 | — | 3 | 3 | 3 |
| #2579 | 10-03 22:45 | 5 | 3-5 | 55 | 1.15 | 1.15 | 0.22 | 0.34 | 0.41 | 0.39 | 0.39 | commit | 1 | 0 | — | 2 | 2 | 2 |
| #2580 | 10-03 22:45 | 6 | 6-9 | 56 | 1.25 | 1.25 | 0.22 | 0.38 | 0.18 | 0.68 | 0.68 | commit | 1 | 0 | — | 5 | 3 | 5 |
| #2581 | 10-03 22:45 | 7 | 6-9 | 57 | 1.34 | 1.34 | 0.22 | 0.35 | 0.16 | 0.83 | 0.83 | comment | 1 | 0 | — | 6 | 3 | 6 |
| #2584 | 10-03 22:58 | 8 | 6-9 | 58 | 1.22 | 1.22 | 0.22 | 0.32 | 0.08 | 0.82 | 0.82 | comment | 1 | 0 | — | 6 | 5 | 6 |
| #2585 | 10-03 23:02 | 9 | 6-9 | 59 | 9.01 | 8.89 | — | 0.01 | 8.63 | 0.37 | 0.37 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2597 | 10-03 23:32 | 7 | 6-9 | 60 | 0.76 | 0.76 | 0.14 | 0.34 | 0.21 | 0.21 | 0.21 | commit | 1 | 0 | — | 3 | 2 | 2 |
| #2598 | 10-03 23:33 | 8 | 6-9 | 61 | 2.15 | 2.15 | 0.14 | 0.18 | 1.83 | 0.14 | 0.14 | comment | 1 | 0 | — | 1 | 0 | 1 |
| #2599 | 10-03 23:33 | 9 | 6-9 | 62 | 0.85 | 0.85 | 0.15 | 0.20 | 0.42 | 0.22 | 0.22 | commit | 1 | 0 | — | 4 | 2 | 2 |
| #2601 | 10-03 23:38 | 10 | 10+ | 63 | 0.85 | 0.85 | 0.24 | 0.16 | 0.48 | 0.21 | 0.21 | commit | 1 | 0 | — | 4 | 2 | 2 |
| #2602 | 10-03 23:53 | 9 | 6-9 | 64 | 0.73 | 0.73 | 0.20 | 0.25 | 0.07 | 0.41 | 0.41 | comment | 1 | 0 | — | 5 | 2 | 3 |
| #2604 | 10-03 23:54 | 9 | 6-9 | 65 | 1.33 | 1.33 | 0.35 | 0.51 | 0.71 | 0.11 | 0.11 | commit | 1 | 0 | — | 2 | 0 | 0 |
| #2607 | 10-04 00:02 | 9 | 6-9 | 1 | 0.66 | 0.66 | 0.10 | 0.17 | 0.04 | 0.45 | 0.45 | comment | 1 | 0 | — | 7 | 3 | 4 |
| #2608 | 10-04 00:03 | 10 | 10+ | 2 | 0.76 | 0.76 | 0.14 | 0.58 | 0.00 | 0.18 | 0.18 | label | 1 | 0 | — | 4 | 1 | 1 |
| #2614 | 10-04 00:15 | 9 | 6-9 | 3 | 1.08 | 1.08 | 0.36 | 0.71 | 0.27 | 0.10 | 0.10 | commit | 1 | 0 | — | 2 | 0 | 0 |
| #2616 | 10-04 00:19 | 9 | 6-9 | 4 | 1.11 | 1.11 | 0.41 | 0.56 | 0.33 | 0.23 | 0.23 | commit | 1 | 0 | — | 4 | 1 | 2 |
| #2617 | 10-04 00:29 | 9 | 6-9 | 5 | 1.04 | 1.04 | 0.17 | 0.35 | 0.41 | 0.28 | 0.28 | commit | 1 | 0 | — | 5 | 2 | 3 |
| #2618 | 10-04 00:30 | 9 | 6-9 | 6 | 1.12 | 1.12 | 0.19 | 0.45 | 0.49 | 0.18 | 0.18 | commit | 1 | 0 | — | 3 | 1 | 1 |
| #2619 | 10-04 00:33 | 10 | 10+ | 7 | 0.35 | 0.35 | 0.24 | 0.25 | 0.00 | 0.10 | 0.10 | label | 1 | 0 | — | 7 | 0 | 0 |
| #2625 | 10-04 00:59 | 7 | 6-9 | 8 | 1.84 | 1.84 | 0.47 | 0.32 | 1.31 | 0.21 | 0.21 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2629 | 10-04 01:06 | 8 | 6-9 | 9 | 0.68 | 0.68 | 0.25 | 0.21 | 0.22 | 0.25 | 0.25 | commit | 1 | 0 | — | 4 | 1 | 2 |
| #2631 | 10-04 01:06 | 9 | 6-9 | 10 | 1.36 | 1.36 | 0.27 | 0.29 | 0.93 | 0.14 | 0.14 | commit | 1 | 0 | — | 2 | 0 | 0 |
| #2639 | 10-04 01:31 | 6 | 6-9 | 11 | 0.52 | 0.52 | 0.09 | 0.19 | 0.27 | 0.06 | 0.06 | commit | 1 | 0 | — | 3 | 0 | 0 |
| #2642 | 10-04 01:53 | 4 | 3-5 | 12 | 1.16 | 1.16 | 0.30 | 0.46 | 0.40 | 0.29 | 0.29 | commit | 1 | 0 | — | 2 | 1 | 2 |
| #2643 | 10-04 02:02 | 5 | 3-5 | 13 | 0.91 | 0.91 | 0.42 | 0.40 | 0.30 | 0.21 | 0.21 | commit | 1 | 0 | — | 3 | 1 | 1 |
| #2644 | 10-04 02:15 | 5 | 3-5 | 14 | 1.37 | 1.37 | 0.29 | 0.48 | 0.77 | 0.11 | 0.11 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2652 | 10-04 03:24 | 2 | 0-2 | 15 | 0.32 | 0.32 | 0.08 | 0.17 | 0.00 | 0.16 | 0.16 | label | 1 | 0 | — | 2 | 1 | 1 |
| #2653 | 10-04 03:32 | 3 | 3-5 | 16 | 0.56 | 0.56 | 0.13 | 0.21 | 0.00 | 0.35 | 0.35 | label | 1 | 0 | — | 1 | 0 | 0 |
| #2654 | 10-04 03:33 | 4 | 3-5 | 17 | 1.24 | 1.24 | 0.23 | 0.60 | 0.30 | 0.34 | 0.34 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2656 | 10-04 03:43 | 4 | 3-5 | 18 | 1.57 | 1.57 | 0.40 | 0.50 | 0.44 | 0.64 | 0.64 | commit | 1 | 0 | — | 2 | 1 | 1 |
| #2658 | 10-04 03:49 | 4 | 3-5 | 19 | 2.37 | 2.25 | 0.50 | 0.33 | 0.30 | 1.75 | 1.75 | commit | 1 | 0 | — | 3 | 0 | 2 |
| #2659 | 10-04 03:55 | 5 | 3-5 | 20 | 0.50 | 0.50 | 0.17 | 0.21 | 0.26 | 0.04 | 0.04 | commit | 1 | 0 | — | 4 | 0 | 0 |
| #2660 | 10-04 03:56 | 6 | 6-9 | 21 | 2.36 | 2.23 | 0.17 | 0.24 | 0.49 | 1.63 | 1.63 | commit | 1 | 0 | — | 4 | 3 | 3 |
| #2662 | 10-04 04:09 | 6 | 6-9 | 22 | 2.25 | 2.13 | 0.17 | 0.42 | 0.30 | 1.54 | 1.54 | commit | 1 | 0 | — | 4 | 3 | 3 |
| #2671 | 10-04 04:26 | 6 | 6-9 | 23 | 2.89 | 2.77 | 0.12 | 0.24 | 0.37 | 2.28 | 2.28 | commit | 1 | 0 | — | 5 | 4 | 8 |
| #2672 | 10-04 04:31 | 7 | 6-9 | 24 | 2.12 | 1.99 | 0.20 | 0.31 | 0.05 | 1.75 | 1.75 | comment | 1 | 0 | — | 6 | 4 | 4 |
| #2673 | 10-04 04:37 | 8 | 6-9 | 25 | 2.11 | 1.98 | 0.10 | 0.21 | 0.00 | 1.90 | 1.90 | label | 1 | 0 | — | 7 | 3 | 5 |
| #2674 | 10-04 04:39 | 9 | 6-9 | 26 | 2.80 | 2.67 | 0.14 | 0.22 | 0.18 | 2.39 | 2.39 | commit | 1 | 0 | — | 8 | 7 | 9 |
| #2682 | 10-04 05:00 | 9 | 6-9 | 27 | 1.82 | 1.70 | 0.10 | 0.20 | 0.04 | 1.58 | 1.58 | comment | 1 | 0 | — | 9 | 8 | 6 |
| #2683 | 10-04 05:01 | 10 | 10+ | 28 | 1.91 | 1.79 | 0.12 | 0.23 | 0.70 | 0.99 | 0.99 | commit | 1 | 0 | — | 9 | 8 | 6 |
| #2688 | 10-04 06:54 | 4 | 3-5 | 29 | 1.51 | 1.51 | 0.28 | 0.56 | 0.69 | 0.25 | 0.25 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2689 | 10-04 06:54 | 5 | 3-5 | 30 | 0.65 | 0.65 | 0.08 | 0.25 | 0.20 | 0.19 | 0.19 | commit | 1 | 0 | — | 3 | 1 | 1 |
| #2690 | 10-04 07:06 | 5 | 3-5 | 31 | 0.56 | 0.56 | 0.08 | 0.12 | 0.00 | 0.44 | 0.44 | label | 1 | 0 | — | 5 | 2 | 3 |
| #2694 | 10-04 07:13 | 6 | 6-9 | 32 | 1.69 | 1.69 | 0.20 | 0.31 | 1.21 | 0.17 | 0.17 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2699 | 10-04 07:44 | 3 | 3-5 | 33 | 0.78 | 0.78 | 0.17 | 0.27 | 0.00 | 0.51 | 0.51 | label | 1 | 0 | — | 3 | 1 | 2 |
| #2700 | 10-04 07:45 | 4 | 3-5 | 34 | 0.88 | 0.88 | 0.17 | 0.48 | 0.21 | 0.19 | 0.19 | commit | 1 | 0 | — | 2 | 1 | 1 |
| #2701 | 10-04 07:45 | 5 | 3-5 | 35 | 0.96 | 0.96 | 0.18 | 0.47 | 0.34 | 0.15 | 0.15 | commit | 1 | 0 | — | 2 | 1 | 1 |
| #2705 | 10-04 07:57 | 6 | 6-9 | 36 | 1.48 | 1.48 | 0.19 | 0.31 | 0.46 | 0.71 | 0.71 | commit | 1 | 0 | — | 1 | 0 | 2 |
| #2706 | 10-04 07:59 | 7 | 6-9 | 37 | 1.56 | 1.56 | 0.41 | 0.34 | 0.42 | 0.81 | 0.81 | commit | 1 | 0 | — | 2 | 1 | 3 |
| #2707 | 10-04 07:59 | 8 | 6-9 | 38 | 1.65 | 1.65 | 0.24 | 0.59 | 0.18 | 0.88 | 0.88 | push | 1 | 0 | — | 3 | 3 | 4 |
| #2710 | 10-04 08:16 | 8 | 6-9 | 39 | 1.46 | 1.46 | 0.30 | 0.45 | 0.76 | 0.24 | 0.24 | commit | 1 | 0 | — | 2 | 2 | 2 |
| #2712 | 10-04 08:17 | 9 | 6-9 | 40 | 1.52 | 1.52 | 0.19 | 0.33 | 0.71 | 0.49 | 0.49 | commit | 1 | 0 | — | 4 | 3 | 4 |
| #2713 | 10-04 08:19 | 10 | 10+ | 41 | 1.01 | 1.01 | 0.57 | 0.48 | 0.34 | 0.18 | 0.18 | commit | 1 | 0 | — | 5 | 3 | 0 |
| #2718 | 10-04 08:30 | 10 | 10+ | 42 | 1.41 | 1.41 | 0.23 | 0.42 | 0.00 | 0.99 | 0.99 | label | 1 | 0 | — | 6 | 3 | 6 |
| #2721 | 10-04 08:44 | 8 | 6-9 | 43 | 1.26 | 1.26 | 0.20 | 0.47 | 0.53 | 0.27 | 0.27 | commit | 1 | 0 | — | 2 | 2 | 2 |
| #2726 | 10-04 08:51 | 9 | 6-9 | 44 | 1.25 | 1.25 | — | 1.11 | 0.00 | 0.14 | 0.14 | label | 1 | 0 | — | 1 | 1 | 1 |
| #2731 | 10-04 08:54 | 10 | 10+ | 45 | 2.21 | 2.21 | 0.81 | 0.58 | 1.60 | 0.03 | 0.03 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2733 | 10-04 09:08 | 10 | 10+ | 46 | 3.58 | 3.58 | — | 1.57 | 1.97 | 0.04 | 0.04 | commit | 1 | 0 | — | 0 | 0 | 0 |
| #2734 | 10-04 09:10 | 11 | 10+ | 47 | 2.60 | 2.60 | 0.19 | 0.37 | 0.29 | 1.95 | 0.08 | commit | 2 | 0 | push-then-label-off:7 | 5 | 2 | 7 |
| #2735 | 10-04 09:10 | 12 | 10+ | 48 | 1.14 | 1.14 | 0.20 | 0.32 | 0.32 | 0.50 | 0.50 | commit | 1 | 0 | — | 6 | 2 | 3 |
| #2736 | 10-04 09:10 | 13 | 10+ | 49 | 1.22 | 1.22 | 0.20 | 0.35 | 0.35 | 0.52 | 0.52 | commit | 1 | 0 | — | 7 | 4 | 4 |
| #2737 | 10-04 09:13 | 14 | 10+ | 50 | 1.27 | 1.27 | 0.04 | 0.29 | 0.45 | 0.53 | 0.53 | commit | 1 | 0 | — | 7 | 4 | 4 |
| #2740 | 10-04 09:28 | 13 | 10+ | 51 | 2.61 | 2.61 | 0.40 | 0.30 | 2.12 | 0.18 | 0.18 | commit | 1 | 0 | — | 1 | 0 | 0 |
| #2752 | 10-04 10:17 | 7 | 6-9 | 52 | 1.93 | 1.93 | 0.48 | 0.37 | 1.28 | 0.27 | 0.27 | commit | 1 | 0 | — | 2 | 1 | 1 |
| #2753 | 10-04 10:18 | 8 | 6-9 | 53 | 3.13 | 3.13 | 0.50 | 0.95 | 0.70 | 1.48 | 0.15 | commit | 2 | 0 | label-off-then-push:32 | 3 | 2 | 8 |
| #2754 | 10-04 10:19 | 9 | 6-9 | 54 | 2.05 | 2.05 | 0.50 | 0.83 | 0.82 | 0.40 | 0.40 | commit | 1 | 0 | — | 4 | 3 | 2 |
| #2756 | 10-04 10:36 | 7 | 6-9 | 55 | 1.88 | 1.88 | 0.29 | 0.50 | 0.83 | 0.55 | 0.55 | commit | 1 | 0 | — | 5 | 1 | 3 |
| #2757 | 10-04 10:36 | 8 | 6-9 | 56 | 3.77 | 3.77 | 0.26 | 0.45 | 0.92 | 2.40 | 0.39 | commit | 3 | 1 | label-off-then-push:31 | 6 | 4 | 12 |
| #2758 | 10-04 10:38 | 9 | 6-9 | 57 | 10.03 | 9.53 | 0.30 | 0.88 | 8.66 | 0.49 | 0.49 | commit | 2 | 1 | — | 0 | 0 | 3 |
| #2761 | 10-04 10:58 | 10 | 10+ | 58 | 1.64 | 1.64 | 0.31 | 0.66 | 0.39 | 0.60 | 0.60 | commit | 1 | 0 | — | 8 | 6 | 4 |
| #2762 | 10-04 10:58 | 11 | 10+ | 59 | 3.69 | 3.69 | 0.36 | 1.76 | 1.44 | 0.49 | 0.49 | push | 1 | 0 | — | 2 | 1 | 1 |
| #2763 | 10-04 11:01 | 12 | 10+ | 60 | 2.05 | 2.05 | 0.40 | 1.32 | 0.60 | 0.13 | 0.13 | commit | 1 | 0 | — | 4 | 2 | 1 |
| #2771 | 10-04 11:39 | 12 | 10+ | 61 | 3.55 | 3.55 | 0.61 | 1.13 | 0.82 | 1.60 | 1.60 | commit | 2 | 1 | — | 3 | 1 | 5 |
| #2778 | 10-04 11:58 | 12 | 10+ | 62 | 1.65 | 1.65 | 0.27 | 0.27 | 0.19 | 1.19 | 1.19 | comment | 1 | 0 | — | 9 | 4 | 6 |
| #2779 | 10-04 11:59 | 13 | 10+ | 63 | 0.97 | 0.97 | 2.17 | 0.71 | 0.14 | 0.13 | 0.13 | commit | 1 | 0 | — | 7 | 3 | 0 |
| #2780 | 10-04 11:59 | 14 | 10+ | 64 | 3.39 | 3.39 | 0.29 | 0.53 | 0.37 | 2.48 | 1.67 | commit | 3 | 1 | push-then-label-off:11 | 8 | 4 | 9 |
| #2783 | 10-04 12:16 | 13 | 10+ | 65 | 1.46 | 1.46 | 0.28 | 0.30 | 0.61 | 0.55 | 0.55 | commit | 1 | 0 | — | 7 | 4 | 2 |
| #2784 | 10-04 12:24 | 13 | 10+ | 66 | 1.42 | 1.42 | 0.42 | 0.37 | 0.63 | 0.42 | 0.42 | commit | 1 | 0 | — | 8 | 5 | 3 |
| #2791 | 10-04 12:47 | 11 | 10+ | 67 | 2.73 | 2.73 | 0.41 | 0.57 | 0.59 | 1.58 | 1.58 | commit | 2 | 1 | — | 5 | 3 | 4 |
| #2792 | 10-04 13:04 | 11 | 10+ | 68 | 2.62 | 2.62 | 0.22 | 0.36 | 0.56 | 1.70 | 1.70 | commit | 2 | 1 | — | 6 | 4 | 5 |
| #2794 | 10-04 13:08 | 11 | 10+ | 69 | 2.69 | 2.69 | 0.28 | 0.17 | 0.65 | 1.88 | 1.88 | commit | 2 | 1 | — | 7 | 4 | 6 |
| #2808 | 10-04 13:32 | 11 | 10+ | 70 | 2.95 | 2.95 | 0.45 | 0.52 | 0.33 | 2.10 | 0.23 | commit | 3 | 1 | push-then-label-off+push:19 | 7 | 6 | 9 |
| #2809 | 10-04 13:50 | 9 | 6-9 | 71 | 2.17 | 2.17 | 0.12 | 0.31 | 0.11 | 1.75 | 1.75 | push | 2 | 1 | — | 9 | 7 | 7 |
| #2810 | 10-04 13:50 | 10 | 10+ | 72 | 2.37 | 2.37 | 0.12 | 0.19 | 0.00 | 2.18 | 2.18 | label | 2 | 1 | — | 10 | 6 | 8 |
| #2819 | 10-04 14:32 | 10 | 10+ | 73 | 1.82 | 1.82 | 0.16 | 0.35 | 1.29 | 0.18 | 0.18 | commit | 2 | 1 | — | 3 | 2 | 1 |
| #2821 | 10-04 14:55 | 10 | 10+ | 74 | 1.84 | 1.84 | 0.23 | 0.35 | 1.34 | 0.16 | 0.16 | commit | 2 | 1 | — | 1 | 0 | 0 |
| #2825 | 10-04 16:24 | 3 | 3-5 | 75 | 1.94 | 1.43 | 0.33 | 0.36 | 1.35 | 0.23 | 0.23 | commit | 2 | 1 | — | 1 | 0 | 1 |
| #2826 | 10-04 16:26 | 4 | 3-5 | 76 | 2.04 | 1.54 | 0.35 | 1.56 | 0.29 | 0.19 | 0.19 | commit | 2 | 1 | — | 2 | 1 | 1 |
| #2827 | 10-04 16:36 | 4 | 3-5 | 77 | 1.41 | 0.91 | 0.15 | 1.27 | 0.12 | 0.03 | 0.03 | push | 1 | 0 | — | 3 | 0 | 0 |
| #2828 | 10-04 16:40 | 5 | 3-5 | 78 | 1.95 | 1.44 | 0.21 | 1.31 | 0.36 | 0.28 | 0.28 | commit | 2 | 1 | — | 3 | 2 | 2 |
| #2829 | 10-04 16:44 | 6 | 6-9 | 79 | 1.44 | 0.93 | 0.28 | 1.17 | 0.13 | 0.13 | 0.13 | comment | 2 | 1 | — | 4 | 0 | 0 |
| #2830 | 10-04 16:48 | 6 | 6-9 | 80 | 1.98 | 1.47 | 0.35 | 1.83 | 0.12 | 0.03 | 0.03 | push | 1 | 0 | — | 1 | 0 | 0 |
| #2837 | 10-04 18:30 | 3 | 3-5 | 81 | 1.72 | 1.72 | 0.20 | 0.98 | 0.41 | 0.33 | 0.33 | commit | 2 | 1 | — | 1 | 0 | 2 |
| #2838 | 10-04 18:35 | 4 | 3-5 | 82 | 1.18 | 1.18 | 0.28 | 0.78 | 0.37 | 0.03 | 0.03 | commit | 1 | 0 | — | 2 | 0 | 0 |
| #2839 | 10-04 18:37 | 4 | 3-5 | 83 | 2.18 | 2.18 | 0.32 | 1.35 | 0.67 | 0.17 | 0.17 | commit | 2 | 1 | — | 1 | 1 | 1 |
| #2840 | 10-04 18:39 | 5 | 3-5 | 84 | 1.29 | 1.29 | 0.17 | 0.76 | 0.39 | 0.15 | 0.15 | commit | 2 | 1 | — | 3 | 0 | 0 |
| #2841 | 10-04 19:02 | 5 | 3-5 | 85 | 2.38 | 2.38 | 0.22 | 0.95 | 0.15 | 1.28 | 1.28 | commit | 2 | 1 | — | 3 | 1 | 8 |
| #2842 | 10-04 19:28 | 6 | 6-9 | 86 | 1.07 | 1.07 | 0.65 | 0.44 | 0.22 | 0.41 | 0.41 | commit | 2 | 1 | — | 4 | 1 | 2 |
| #2843 | 10-04 19:28 | 7 | 6-9 | 87 | 0.91 | 0.91 | 0.65 | 0.47 | 0.00 | 0.44 | 0.44 | label | 2 | 1 | — | 6 | 2 | 3 |
| #2844 | 10-04 19:28 | 8 | 6-9 | 88 | 0.61 | 0.61 | 0.66 | 0.36 | 0.04 | 0.21 | 0.21 | comment | 2 | 1 | — | 7 | 1 | 1 |
| #2859 | 10-04 20:27 | 4 | 3-5 | 89 | 0.66 | 0.66 | 0.18 | 0.44 | 0.05 | 0.17 | 0.17 | comment | 2 | 1 | — | 1 | 1 | 1 |
| #2860 | 10-04 20:28 | 5 | 3-5 | 90 | 0.49 | 0.49 | 0.21 | 0.24 | 0.12 | 0.12 | 0.12 | commit | 2 | 1 | — | 2 | 1 | 0 |
| #2861 | 10-04 20:36 | 5 | 3-5 | 91 | 0.65 | 0.65 | 0.33 | 0.40 | 0.13 | 0.12 | 0.12 | commit | 2 | 1 | — | 1 | 1 | 0 |
| #2865 | 10-04 20:55 | 4 | 3-5 | 92 | 0.80 | 0.80 | 0.64 | 0.31 | 0.36 | 0.13 | 0.13 | commit | 2 | 1 | — | 0 | 0 | 0 |

</details>
