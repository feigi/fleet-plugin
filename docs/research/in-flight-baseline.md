# Baseline: the flow signals for the In-flight bound (issue #2871)

## Question

What are the flow signals the In-flight bound's guard (map #2870, standing
decisions 2, 4 and 6) will be measured against — in-flight depth, cycle time
created→merged, throughput, and the `ready-to-merge` timings ADR 0007 guard 1
reads — over the ≥200 most recently merged PRs of this repo, read off GitHub
only (never off one session's transcripts), and how are they reproduced on
demand?

The charting read of 2026-10-05 recorded in #2870's Notes is the hypothesis;
§ Hypothesis check confirms or corrects it line by line.

## Window measured

**n = 400 merged PRs, #1826–#2865** — the 400 most recently *created* merged
PRs at the time the listing was read (2026-10-05T12:14Z; Query P below,
pages 1–4). Created 2026-09-25T18:58:33Z (#1826) → 2026-10-04T20:55:15Z
(#2865); merged 2026-09-25T20:00:22Z (#1827) → 2026-10-04T21:43:18Z (#2865).
Every one targets `main`. This clears the ticket's ≥200 floor twice over.

**Dropped: 0 closed-unmerged PRs.** Every one of the 400 most recently
created closed PRs was merged; the first closed-unmerged PRs in the listing
are two on page 5, created before the window. The other 640 numbers in
#1826–#2865 are issues (PRs and issues share one number space).

**Carry-in: 2 PRs** created before the window start and still open at it —
#1824 (2026-09-25 18:47:37 → 19:50:01) and #1825 (18:50:12 → 20:15:51). They
are outside the population and enter only the sensitivity line in § 1.

The queries (GitHub REST; every number below names the one it came from):

- **Query P** — `GET /repos/feigi/fleet-plugin/pulls?state=closed&sort=created&direction=desc&per_page=100&page=N`,
  N = 1…6 (pages 5–6 serve the carry-in scan only). Fields read: `number`,
  `created_at`, `merged_at`, `closed_at`. 600 closed PRs seen.
- **Query E** — `GET /repos/feigi/fleet-plugin/issues/<n>/events?per_page=100&page=N`
  for each of the 400 (every timeline fit one page — the longest has 22
  events; the script follows `page=2` whenever a page is exactly 100 long).
  Fields read: `event`, `label.name`, `created_at`.

The full population — number, created_at, merged_at, depth at arrival, cycle
time — is the `## Population list` block of the script's own output.

Conventions, all in the script: percentiles are linear-interpolated on the
sorted data (`k = (n−1)·p`, the same `pct()` as
`baseline-efficiency-derive.py`); the sweep orders same-instant events merges
first, then arrivals by PR number, so a PR merged in the same second as
another's creation is not counted open at it; days and clock hours are UTC;
hours are shown to two decimals, minutes rounded.

Script: `docs/research/in-flight-baseline-derive.mjs` (zero dependencies,
Node ≥ 18; § Reproduction). Its stdout is markdown and every table in
§ Results is pasted from it unedited.

## Results

### 1. In-flight depth (Query P; sweep +1 at `created_at`, −1 at `merged_at`)

| Measure | Value | Source |
|---|---|---|
| Time-weighted mean depth while ≥1 PR open | **5.02** | Σ depth·dt / Σ dt over depth≥1; open time 211.09 h of 218.75 h wall |
| Time-weighted mean over the whole wall clock (first created → last merged) | 4.84 | Σ depth·dt / wall span |
| Max depth | **15** | first reached 2026-10-04T09:13:30Z |
| Depth already open at a PR's creation — median / p75 / p90 / max | **5 / 7 / 9 / 14** | n=400; linear-interpolated percentiles |
| Mean depth at arrival | 5.22 |  |
| Sensitivity: + carry-in PRs (depth only) | mean-while-open 5.02; max 15 at 2026-10-04T09:13:30Z; at-arrival median/p75/p90 5/7/9 | 2 carry-in interval(s) added to the sweep |

The max of 15 is reached by #2737's arrival at 09:13:30Z on 2026-10-04, the
fifth PR opened in five minutes (#2733–#2737, 09:08–09:13) on top of ten
already open. Depth at arrival maxes at 14 (#2737, and #2780 at 11:59:49Z the
same day); the sweep's 15 is the depth *after* #2737 arrives.

Depth-at-arrival histogram (Query P):

| Depth at arrival | PRs | Share | Cum. share |  |
|---|---|---|---|---|
| 0 | 10 | 2.5% | 2.5% | ███████ |
| 1 | 24 | 6.0% | 8.5% | ████████████████ |
| 2 | 34 | 8.5% | 17.0% | ███████████████████████ |
| 3 | 58 | 14.5% | 31.5% | ███████████████████████████████████████ |
| 4 | 60 | 15.0% | 46.5% | ████████████████████████████████████████ |
| 5 | 52 | 13.0% | 59.5% | ███████████████████████████████████ |
| 6 | 43 | 10.8% | 70.3% | █████████████████████████████ |
| 7 | 29 | 7.3% | 77.5% | ███████████████████ |
| 8 | 24 | 6.0% | 83.5% | ████████████████ |
| 9 | 29 | 7.3% | 90.8% | ███████████████████ |
| 10 | 19 | 4.8% | 95.5% | █████████████ |
| 11 | 7 | 1.8% | 97.3% | █████ |
| 12 | 4 | 1.0% | 98.3% | ███ |
| 13 | 5 | 1.3% | 99.5% | ███ |
| 14 | 2 | 0.5% | 100.0% | █ |

Per UTC day (Query P):

| Day (UTC) | Open at day start | Arrivals | Merges | Peak depth | Mean depth |
|---|---|---|---|---|---|
| 2026-09-25 | 0 | 14 | 13 | 8 | 5.00 |
| 2026-09-26 | 1 | 69 | 64 | 8 | 3.03 |
| 2026-09-27 | 6 | 45 | 47 | 7 | 3.12 |
| 2026-09-28 | 4 | 29 | 31 | 11 | 4.52 |
| 2026-09-29 | 2 | 31 | 28 | 8 | 3.46 |
| 2026-09-30 | 5 | 6 | 5 | 7 | 5.39 |
| 2026-10-01 | 6 | 14 | 16 | 10 | 6.40 |
| 2026-10-02 | 4 | 35 | 32 | 7 | 3.04 |
| 2026-10-03 | 7 | 65 | 62 | 12 | 6.92 |
| 2026-10-04 | 10 | 92 | 102 | 15 | 7.95 |

"Open at day start" is the depth at 00:00Z (for 09-25, at the window's first
instant); "Mean depth" is time-weighted over the day. The depth at 00:00Z
never fell below 1 after the first day: at no midnight in the window was the
fleet empty. The two quiet days, 09-30 and 10-01 (6 and 14 arrivals), carry a
mean depth *above* the busy days' because the PRs open then sat rather than
flowed — see § 2 and § 5.

### 2. Cycle time `created_at` → `merged_at` (Query P)

| Measure | Value |
|---|---|
| n | 400 |
| min | 0.25 h (15 min) |
| median | **1.38 h (83 min)** |
| p75 | 2.37 h (142 min) |
| p90 | **5.23 h (314 min)** |
| max | 37.51 h (2251 min) |
| mean | 2.65 h (159 min) |

By depth at arrival (Query P):

| Depth at arrival | n | Cycle median | Cycle p90 |
|---|---|---|---|
| 0–2 | 68 | 1.16 h (70 min) | 3.94 h (236 min) |
| 3–5 | 170 | 1.27 h (76 min) | 5.88 h (353 min) |
| 6–9 | 125 | 1.62 h (97 min) | 5.74 h (344 min) |
| 10+ | 37 | 1.82 h (109 min) | 3.45 h (207 min) |

The median rises monotonically with depth at arrival (+0.66 h from the 0–2 to
the 10+ bucket). The p90 does not: the tail is not a depth phenomenon. The 40
PRs above the overall p90 (5.23 h) arrived at depths 0–10, 13 of them at
depth ≤ 3; the six longest (27–37.5 h: #2248, #2271, #2278, #2280, #2281,
#2285) arrived at depths 3–6 on 09-29/09-30, and five of them merged between
07:01 and 07:36 on 10-01 (#2285 at 20:52 that day). Between 02:23:14Z on
09-30 and 07:01:14Z on 10-01 — 28.6 h — exactly one PR merged, #2286, by hand
(09-30's row above). Those are hours in which no Pass ran, not hours in which
the merge gate was saturated.

### 3. The proposed bound 8 (Query P)

| Measure | Value |
|---|---|
| Arrivals at depth ≥ 8 (the Pulls the bound would have held) | **90 of 400 (22.5%)** |
| … with carry-in counted | 92 of 400 (23.0%) |
| Cycle time, depth ≥ 8: n / median / p75 / p90 / max | 90 / **1.65 h (99 min)** / 2.61 h (156 min) / **3.59 h (215 min)** / 10.03 h (602 min) |
| Cycle time, depth < 8: n / median / p75 / p90 / max | 310 / **1.29 h (78 min)** / 2.32 h (139 min) / **5.88 h (353 min)** / 37.51 h (2251 min) |
| Share of all open-PR time spent at depth ≥ 8 | 15.1% (31.85 h of 211.09 h) |

The 90 held arrivals cluster: 5 on 09-28, 3 on 10-01, **33 on 10-03 and 49 on
10-04** — the two highest-throughput days (62 and 102 merges). PRs that
arrived at depth ≥ 8 took 0.36 h longer at the median than the rest, and had
a *shorter* p90 (3.59 h against 5.88 h), because the long tail lives in the
quiet days, at low depth. Read against standing decision 6: 8 sits above the
measured mean (5.02) and p75 (7) and below the peak (15), as the decision
says; it would have held roughly one Pull in four or five over this window
and almost all of those on the two busiest days.

What this number is not: a count of refused Pulls. The bound acts at Pull
time on the in-flight count (Claim → merge, standing decision 7), while depth
here is counted at PR creation over open PRs only — see § What could NOT be
derived. And a hold defers the arrival, which changes every later depth; the
counterfactual trajectory under a bound is not derivable from this data.

### 4. Throughput (Query P)

| Definition | Hours | Merged PRs / hour |
|---|---|---|
| **Primary — active clock hour**: a UTC clock hour with ≥1 arrival or ≥1 merge in the population | 147 | **2.72** |
| Alternative A — per-day span: Σ over UTC days of (last event − first event), events = arrivals and merges | 180.3 | 2.22 |
| Alternative B — open time: Σ dt while ≥1 PR in flight (the sweep's own clock) | 211.1 | 1.89 |
| Wall clock, first created → last merged (floor, counts idle nights) | 218.7 | 1.83 |
| Per active UTC day (a day with ≥1 arrival or merge) | 10 days | 40.0 / day |

**Definition chosen: an active hour is a UTC clock hour in which at least one
population PR was created or merged.** Why: it needs only the two timestamps
every PR carries, so a later run reproduces it with no judgement call; it is
the granularity a guard would read (per hour, not per second); and it
excludes the hours the controller was not running — nights, and the gaps
between runs — without pretending to know *why* nothing happened in them.
Its bias is upward: an hour with one merge at 00:02 and nothing else counts
as a full active hour, so 2.72 is the rate the fleet sustains while it is
doing anything at all.

The alternatives bracket it. **A** (per-day span) counts the idle minutes
*inside* a day's activity and reads 2.22/h. **B** (open time) counts every
hour some PR was in flight, including the ~30 h stall around 09-30, and reads
1.89/h — the closest to a Little's-law denominator (mean depth 5.02 ÷ 1.89/h
≈ 2.65 h, which is exactly the mean cycle time in § 2, as it must be). The
wall-clock floor is 1.83/h. Whatever the guard adopts, it has to name one of
these and keep it; between the primary and B is a factor of 1.4.

### 5. `ready-to-merge` label timings (Query E)

Events were read for **all 400** PRs, merged 2026-09-25T20:00:22Z (#1827) →
2026-10-04T21:43:18Z (#2865). 398 carry at least one `labeled ready-to-merge`
event; **2 carry none** and are excluded from the timings: #2286 (merged by
hand 2026-09-30, timeline `referenced` → `merged`) and #1927 (merged via
GitHub auto-merge, `auto_merge_enabled` → `merged`). "Last label" is the last
`ready-to-merge` applied **at or before** `merged_at`.

| Measure | Value |
|---|---|
| Last `ready-to-merge` labeled → merged_at: median / p75 / p90 / max | **15 min** / 32 min / **1.09 h (65 min)** / 12.06 h (723 min) (n=398) |
| … share > 90 min (ADR 0007 guard 1's median trigger) | **27 of 398 (6.8%)** |
| … share > 3 h (guard 1's single-Pass trigger) | 9 of 398 (2.3%) |
| … PRs whose `ready-to-merge` was re-applied AFTER the merge (ignored for "last label") | 1 (#2065) |
| … waits > 3 h, listed | #2290 12.06 h (merged 2026-10-01); #2309 11.56 h (merged 2026-10-02); #2289 11.18 h (merged 2026-10-01); #2093 9.38 h (merged 2026-09-28); #2294 6.47 h (merged 2026-10-01); #2298 6.38 h (merged 2026-10-01); #2262 3.45 h (merged 2026-09-30); #2260 3.30 h (merged 2026-09-30); #2478 3.08 h (merged 2026-10-03) |
| PRs with no `merged` event in their timeline (merged_at still from Query P) | 1 (#2222) |
| created_at → first `ready-to-merge`: median / p75 / p90 / max | **0.88 h (53 min)** / 1.62 h (97 min) / **3.10 h (186 min)** / 37.32 h (2239 min) (n=398) |
| PRs labelled `ready-to-merge` more than once | **45 of 398 (11.3%)** |
| Label-count distribution (labels: PRs) | 1: 353, 2: 42, 3: 3 |
| PRs with ≥1 `unlabeled ready-to-merge` event | 46 |
| First label → merged (the whole queue wait, relabels included): median / p90 | 17 min / 1.60 h (96 min) |

Last label → merged by UTC day of merge (Query E):

| Day (UTC) | n | median | p90 | > 90 min |
|---|---|---|---|---|
| 2026-09-25 | 13 | 34 min | 67 min | 1 |
| 2026-09-26 | 64 | 12 min | 41 min | 0 |
| 2026-09-27 | 46 | 15 min | 51 min | 1 |
| 2026-09-28 | 31 | 18 min | 47 min | 1 |
| 2026-09-29 | 28 | 13 min | 34 min | 0 |
| 2026-09-30 | 4 | 162 min | 204 min | 3 |
| 2026-10-01 | 16 | 29 min | 530 min | 4 |
| 2026-10-02 | 32 | 13 min | 36 min | 1 |
| 2026-10-03 | 62 | 24 min | 111 min | 8 |
| 2026-10-04 | 102 | 11 min | 58 min | 8 |

The same measures over the **150 most recently merged** PRs (#2422–#2865,
merged 2026-10-03T04:29:41Z → 2026-10-04T21:43:18Z; `--events 150`), which
is the cut the ticket names and the one a run-sized guard would read:

| Measure (latest 150 merged) | Value |
|---|---|
| Last `ready-to-merge` labeled → merged_at: median / p75 / p90 / max | **15 min** / 35 min / **1.54 h (93 min)** / 3.08 h (185 min) (n=150) |
| … share > 90 min | **16 of 150 (10.7%)** |
| … share > 3 h | 1 of 150 (0.7%) — #2478 |
| created_at → first `ready-to-merge`: median / p75 / p90 / max | **0.90 h (54 min)** / 1.51 h (90 min) / **2.27 h (136 min)** / 11.33 h (680 min) (n=150) |
| PRs labelled `ready-to-merge` more than once | **31 of 150 (20.7%)**; distribution 1: 119, 2: 28, 3: 3 |
| First label → merged: median / p90 | 23 min / 1.91 h (114 min) |

ADR 0007 guard 1 reads the median last-label→merged over a run of ≥20
merges, trigger > 90 min. Against its own 2026-09-17 baseline of 48 min
(n=25) the queue wait has fallen to **15 min** at every cut tried (398, 150,
and every day but the two quiet ones). The guard is not tripped, and the
drop is consistent with ADR 0012's dispatch-on-label Pass replacing the
wave-batched merge bot it measured. Its second trigger — a single Pass whose
last PR waits > 3 h — has nine candidates over the window (table above), six
of them merged on 09-30/10-01; whether any was the *last* PR of its Pass is
not visible on GitHub (§ What could NOT be derived).

Relabelling is a 2026-10-03/04 phenomenon: 31 of the 45 relabelled PRs are
in the latest 150, and all three triple-labelled PRs (#2757, #2780, #2808)
merged on 10-04 within two minutes of their third label. The timelines show
`unlabeled` → `labeled` pairs (46 PRs carry an `unlabeled`), i.e. the label
was removed and re-applied rather than applied twice; a fix-applier settling
a Conflict hold and re-queueing the PR produces exactly this shape, but the
events name no cause, so that is a reading, not a measurement. #2065's second
label was applied 2 min *after* its merge (15:15:16Z against merged_at
15:12:53Z) — a Pass relabelling a PR it had just merged — and is excluded
from "last label" but counted as a relabel.

## Hypothesis check — the charting read of 2026-10-05 (#2870 Notes)

The charting read's window — "the 400 most recently merged PRs #1826–#2865,
created 2026-09-25 → merged 2026-10-04" — is this population to within one
PR at the edge: the 400 most recently *merged* would swap #1827 (merged
2026-09-25T20:00:22Z) for the carry-in #1825 (merged 20:15:51Z, created
before #1826). Both readings span #1826–#2865 and no figure below moves on
that swap.

| Signal | Charting read | Measured here | Verdict |
|---|---|---|---|
| Depth, time-weighted mean | 5.0 | 5.02 (while ≥1 open); 4.84 over the wall clock | confirmed |
| Depth, max | 15 on 2026-10-04 | 15, first reached 2026-10-04T09:13:30Z | confirmed |
| Depth at arrival median / p75 / p90 | 5 / 7 / 9 | 5 / 7 / 9 (max 14) | confirmed |
| Cycle median / p75 / p90 | 1.4 h / 2.4 h / 5.2 h | 1.38 h / 2.37 h / 5.23 h | confirmed |
| Cycle median by depth bucket 0–2 / 3–5 / 6–9 / 10+ | 1.1 / 1.3 / 1.6 / 1.8 h | 1.16 / 1.27 / 1.62 / 1.82 h | confirmed |
| Last label → merged, median | 15 min | 15 min (n=398 and n=150 alike) | confirmed |
| Last label → merged, p90 | 1.2 h | **1.54 h (93 min)** over the 150 most recently *merged*; 1.09 h over all 398 | **corrected** — see below |
| Share > 90 min | 9 % | **10.7 %** (16 of 150 most recently merged); 6.8 % over all 398 | **corrected** — see below |
| Created → first label, median / p90 | 0.9 h / 2.2 h | 0.90 h / 2.27 h (latest 150); 0.88 h / **3.10 h** over all 398 | confirmed on the 150; the 400-wide p90 is 0.9 h worse |
| Relabelled more than once | 31 of 150 | 31 of 150 (45 of 398) | confirmed |

**The two corrections have one cause.** The charting read's "latest 150" was
the 150 highest-numbered PRs (#2457–#2865, i.e. most recently *created*):
over that cut the script reproduces its figures to the minute — p90 72 min =
1.2 h, 14 of 150 = 9.3 % over 90 min, created→first p90 2.18 h, 31
relabelled. The ticket, and a run-sized guard, read the 150 most recently
*merged* (#2422–#2865). The two cuts differ by four PRs each way: by merge
date the cut takes #2422, #2425, #2428 and #2438 (created 10-02, merged on
10-03 after 04:29Z, two of them after 171 and 178 min on the label) in place
of #2457, #2461, #2462 and #2463 (merged before 04:29Z on 10-03, none over
90 min) — and the > 90 min count goes from 14 to 16 and the p90 from 72 to 93
min, because all eight of 10-03's > 90 min waits sit inside the by-merge cut.
The median is 15 min on both cuts. The map's Notes should carry 1.5 h / 11 %
(or name the cut they mean); nothing else in them moves.

Beyond the hypothesis, two things the Notes do not yet say:

- The bound would have held **90 of 400 arrivals (22.5 %)**, 82 of them on
  10-03/10-04. Those PRs' cycle median was 1.65 h against 1.29 h for the
  rest; their p90 was lower (3.59 h vs 5.88 h).
- **Throughput 2.72 merged PRs per active clock hour** (147 active hours of
  218.7 wall); 1.89/h on the sweep's open-time clock; 40 per active day.

## What could NOT be derived, or is degraded

- **Depth is a lower bound on the in-flight count the bound will read.**
  Standing decision 7 defines in flight as Claim → merge; GitHub sees a
  ticket only once its PR is opened. Every implementer working between its
  Claim and `gh pr create` is invisible here, so the fleet's true in-flight
  count at each Pull was ≥ the depth measured, by the number of live
  implementers (2 under today's cap, more under a bound of 8). The 22.5 %
  "held" share is therefore also a lower bound. **Missing field: the Claim
  instant on something durable GitHub can be asked for** — a timestamp the
  implementer writes into the PR body at open time, or the ledger's
  `claimed_at` published alongside the PR — would let the sweep start each
  interval at the Claim. Until then a guard reading this script measures
  PR-open depth, and should say so.
- **Closed-unmerged PRs were in flight until closed, and the script
  excludes them from the sweep.** Zero fell in this window, so nothing is
  lost here; a later window with closed-unmerged PRs would understate depth
  by their open intervals. The script reports their count and numbers; adding
  them to the sweep (created→closed) is a one-line change the Reproduction
  section names.
- **Pass boundaries are not on GitHub.** ADR 0007 guard 1's second trigger
  ("a single Pass in which the last PR waits more than 3 h") needs to know
  which PR was the last of its Pass; the merge bot's name and lifetime live
  in its transcript and the ledger only. Nine PRs waited > 3 h; whether any
  closed a Pass cannot be read. **Missing field: the Pass name on the PR** —
  a comment or a `pass:<name>` label the merge bot applies as it merges —
  would make the trigger derivable from Query E alone.
- **Bot and human are the same actor.** Every `labeled`, `unlabeled` and
  `merged` event in the 400 timelines carries `actor.login = feigi`: the
  merge bot, the controller, the fix-appliers and the maintainer all act
  under one token. The two hand-merged PRs were found by the *absence* of a
  `ready-to-merge` label, not by who merged them, and a human relabel is
  indistinguishable from a Pass's. **Missing field: a distinct identity for
  the merge bot** (a GitHub App installation, or a bot account) — then
  "merges by the Pass" and "merges by hand" are a filter, not an inference.
- **Why a PR was relabelled is not in the events.** 45 PRs carry
  `unlabeled` → `labeled` pairs; a settled Conflict hold, a `held-behind`
  release, a Pass restart and a manual re-queue all leave the same two
  events. The reading in § 5 is a hypothesis. **Missing field: the hold
  reason** on the PR (the ledger's `conflict-hold:#<pr>` row published as a
  PR comment, or a label naming the hold) would split the 45 by cause.
- **GitHub timeline quirk, one PR.** #2222 has `merged_at`
  2026-09-29T16:34:01Z and a `merge_commit_sha`, but its timeline records
  `closed` (with that commit id) and no `merged` event. `merged_at` from
  Query P is used throughout, so no number depends on the `merged` event;
  the script reports the count of such PRs so a later window can tell
  whether this recurs.
- **Window edges.** Two carry-in PRs (#1824, #1825) were open at the window
  start; adding them to the sweep moves no headline figure (§ 1's
  sensitivity row). The window ends at the last merge, so no PR open at
  2026-10-04T21:43Z is cut off — the population is closed PRs by
  construction. Still-open PRs created inside the window are not in Query P
  (`state=closed`) and would, if later merged, join a later run's population.
- **The transport this run used.** `gh auth status` failed (the session's
  `GH_TOKEN` is invalid), so the script took its curl path and sent the
  equally invalid `GITHUB_TOKEN` — and every call returned 200 with
  `X-RateLimit-Limit: 15000`, because this session's outbound proxy
  substitutes its own GitHub credentials. The token-rejection branch
  (`/rate_limit` → 401 → continue without the token) is therefore exercised
  by the script's logic but was not observed live here. On a workstation
  with a valid `gh` login the script uses `gh api` and neither branch runs.

## Reproduction

```
cd <repo root>
node docs/research/in-flight-baseline-derive.mjs --repo feigi/fleet-plugin --n 400 \
  --cache /tmp/in-flight-baseline-cache --json /tmp/in-flight-baseline.json \
  > /tmp/in-flight-baseline.md
node docs/research/in-flight-baseline-derive.mjs --n 400 --events 150 \
  --cache /tmp/in-flight-baseline-cache > /tmp/in-flight-baseline-150.md   # the latest-150 cut in § 5
```

Requires Node ≥ 18 and either `gh` authenticated against the repo (used
automatically when `gh auth status` succeeds) or `curl` (used otherwise,
with `GITHUB_TOKEN` when set; an invalid token is detected on `/rate_limit`
and dropped with a warning). Raw JSON is cached under `--cache` (default
`<os.tmpdir()>/in-flight-baseline-cache/`, never inside the repo); a cached
run of the two commands above takes seconds and is byte-identical below the
derived-at stamp in its title line. The
listing pages are *positional* — page 1 is "the newest 100 closed PRs" at
read time — so **pass `--refresh` (or a fresh `--cache` dir) whenever the
window should move**; the script prints when the cached listing was read and
warns on stderr once it is a day old. Event pages for merged PRs are stable
and safe to keep.

The script exits 2, with the reason on stderr and no tables, when the
population comes up short of `--n` (the listing ended, or too few PRs since
`--after`), or when any page is not a 200 with a JSON array — a cut list is
never counted as a whole one (`docs/agents/issue-tracker.md`'s `--limit`
rule). `--allow-short` overrides the first case and marks the output.

**To re-run on the first ≥20 merged PRs after the cutover** (the guard's
before/after read): take the cutover instant — the `merged_at` of the PR
that lands the In-flight bound, `gh pr view <N> --json mergedAt` — and run

```
node docs/research/in-flight-baseline-derive.mjs --repo feigi/fleet-plugin \
  --after <cutover ISO-8601 instant, e.g. 2026-10-12T09:00:00Z> --n 20 --refresh \
  --cache /tmp/in-flight-baseline-after --json /tmp/in-flight-after.json > /tmp/in-flight-after.md
```

`--after` makes the population the merged PRs *created* at or after that
instant, earliest first; `--n 20` takes the first 20 of them and exits 2 while
fewer than 20 exist (so the command can be re-run daily until it succeeds);
`--n all --min 20` takes every merged PR since the cutover instead, with the
same floor. Events are read for the whole population unless `--events K` says
otherwise. Nothing else changes: the same tables come out with the same
query names, and the carry-in line names the PRs the previous run left open
at the cutover (dry-run against 2026-10-04T00:00:00Z: 20 PRs #2607–#2659,
9 carry-in, 4 pages of Query P — one for the population, three for the
carry-in scan). Compare its § 1–5 against this document's
line by line; the guard reads the primary definitions (depth sweep over
population PRs, active-clock-hour throughput, last label at or before
merge).

Other knobs: `--bound B` recomputes § 3 for a different In-flight bound;
`--repo owner/name` points at a consumer repo; `--transport curl --no-token`
forces the unauthenticated path. To include closed-unmerged PRs in the
depth sweep (not done here; none occurred), change `mergedSoFar()`'s filter
from `p.merged_at` to `p.merged_at || p.closed_at` and use `closed_at` as the
interval end for those PRs — the per-PR list block then marks them, and the
cycle-time tables must keep excluding them.
