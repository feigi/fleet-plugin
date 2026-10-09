# In-flight bound: held share with the implementer phase counted

Read 2026-10-09 for the grilling of the In-flight bound's default. Population #1826–#2865 (n=400), created 2026-09-25T18:58:33Z → 2026-10-04T20:55:15Z — the baseline note's window. The baseline's default `--n 400` window has since moved (it reads #1907–#2963 on 2026-10-09), so reproduce with `--after`:

```
node docs/research/in-flight-baseline-derive.mjs --n 400 --after 2026-09-25T18:58:33Z --bound 8 --cache /tmp/inflight-cache --json /tmp/inflight-base.json
node docs/research/in-flight-lead-share-derive.mjs /tmp/inflight-base.json --cache /tmp/inflight-cache
```

L = implementer lead before the PR opens (median T_impl 19.3 min); Pull = created − L; held = other tickets in flight at the Pull ≥ B. Tables below are the script's output, unedited.

L=0 depth-at-arrival reproduction vs baseline --json: 400/400 identical

## L = 0 min — Pull = created − 0 min; in-flight interval [created − L, merged]
In-flight at Pull (others): median 5 / p75 7 / p90 9 / max 14, mean 5.22. Time-weighted mean: 4.84 over wall 218.7 h, 5.02 while ≥1 in flight (211.1 h). Max in flight 15.

| B | held share % | held n/400 | held per day: mean over 10 days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight time % (h) |
|---|---|---|---|---|---|---|
| 4 | 68.5 | 274 | 27.4 / 19 / 87 (10) [10-04:87 10-03:58 09-26:32] | 1.56 / 5.22 | 1.08 / 5.15 (126) | 72.3 / 75.0 (158.3) |
| 5 | 53.5 | 214 | 21.4 / 12.5 / 75 (10) [10-04:75 10-03:54 09-28:20] | 1.63 / 5.61 | 1.18 / 4.54 (186) | 52.5 / 54.5 (114.9) |
| 6 | 40.5 | 162 | 16.2 / 6.5 / 64 (10) [10-04:64 10-03:50 09-28:14] | 1.65 / 3.76 | 1.24 / 5.72 (238) | 35.5 / 36.8 (77.7) |
| 7 | 29.8 | 119 | 11.9 / 2.5 / 55 (7) [10-04:55 10-03:44 09-28:9] | 1.64 / 3.59 | 1.29 / 7.22 (281) | 23.2 / 24.0 (50.7) |
| 8 | 22.5 | 90 | 9.0 / 0 / 49 (4) [10-04:49 10-03:33 09-28:5] | 1.65 / 3.59 | 1.29 / 5.88 (310) | 14.6 / 15.1 (31.9) |
| 9 | 16.5 | 66 | 6.6 / 0 / 41 (4) [10-04:41 10-03:21 09-28:2] | 1.65 / 3.56 | 1.34 / 5.83 (334) | 10.8 / 11.2 (23.6) |
| 10 | 9.3 | 37 | 3.7 / 0 / 28 (3) [10-04:28 10-03:8 09-28:1] | 1.82 / 3.45 | 1.36 / 5.74 (363) | 6.0 / 6.2 (13.1) |
| 12 | 2.8 | 11 | 1.1 / 0 / 11 (1) [10-04:11] | 1.46 / 3.39 | 1.37 / 5.38 (389) | 1.4 / 1.5 (3.1) |

## L = 10 min — Pull = created − 10 min; in-flight interval [created − L, merged]
In-flight at Pull (others): median 5 / p75 8 / p90 10 / max 15, mean 5.67. Time-weighted mean: 5.14 over wall 218.9 h, 5.30 while ≥1 in flight (212.4 h). Max in flight 16.

| B | held share % | held n/400 | held per day: mean over 10 days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight time % (h) |
|---|---|---|---|---|---|---|
| 4 | 75.8 | 303 | 30.3 / 20.5 / 88 (10) [10-04:88 10-03:62 09-26:50] | 1.51 / 5.21 | 1.14 / 6.94 (97) | 76.3 / 78.6 (167.1) |
| 5 | 61.3 | 245 | 24.5 / 13 / 85 (10) [10-04:85 10-03:55 09-26:30] | 1.56 / 5.22 | 1.18 / 5.43 (155) | 57.0 / 58.8 (124.9) |
| 6 | 45.0 | 180 | 18.0 / 7 / 69 (10) [10-04:69 10-03:52 09-28:16] | 1.59 / 3.90 | 1.24 / 5.88 (220) | 40.0 / 41.2 (87.5) |
| 7 | 33.3 | 133 | 13.3 / 4 / 57 (8) [10-04:57 10-03:48 09-28:10] | 1.62 / 3.57 | 1.28 / 7.54 (267) | 26.5 / 27.3 (58.0) |
| 8 | 25.3 | 101 | 10.1 / 0.5 / 51 (5) [10-04:51 10-03:40 09-28:6] | 1.64 / 3.55 | 1.30 / 6.24 (299) | 16.9 / 17.4 (37.1) |
| 9 | 18.0 | 72 | 7.2 / 0 / 41 (4) [10-04:41 10-03:26 09-28:3] | 1.60 / 3.58 | 1.32 / 5.87 (328) | 12.7 / 13.1 (27.8) |
| 10 | 13.5 | 54 | 5.4 / 0 / 35 (3) [10-04:35 10-03:18 09-28:1] | 1.48 / 3.26 | 1.37 / 5.80 (346) | 7.8 / 8.0 (17.0) |
| 12 | 4.5 | 18 | 1.8 / 0 / 17 (2) [10-04:17 10-03:1] | 1.85 / 3.08 | 1.37 / 5.63 (382) | 2.2 / 2.2 (4.8) |

## L = 19.3 min — Pull = created − 19.3 min; in-flight interval [created − L, merged]
In-flight at Pull (others): median 6 / p75 8 / p90 11 / max 15, mean 6.21. Time-weighted mean: 5.42 over wall 219.1 h, 5.56 while ≥1 in flight (213.6 h). Max in flight 16.

| B | held share % | held n/400 | held per day: mean over 10 days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight time % (h) |
|---|---|---|---|---|---|---|
| 4 | 80.5 | 322 | 32.2 / 23 / 86 (10) [10-04:86 10-03:64 09-26:60] | 1.46 / 5.22 | 1.20 / 4.95 (78) | 78.9 / 80.9 (172.8) |
| 5 | 68.3 | 273 | 27.3 / 17.5 / 85 (10) [10-04:85 10-03:59 09-26:39] | 1.49 / 5.06 | 1.24 / 6.49 (127) | 60.7 / 62.3 (133.0) |
| 6 | 54.5 | 218 | 21.8 / 8.5 / 82 (10) [10-04:82 10-03:55 09-26:25] | 1.48 / 3.64 | 1.28 / 7.95 (182) | 44.2 / 45.3 (96.7) |
| 7 | 40.0 | 160 | 16.0 / 4.5 / 71 (8) [10-04:71 10-03:49 09-26:13] | 1.50 / 3.40 | 1.31 / 8.13 (240) | 30.5 / 31.3 (66.9) |
| 8 | 28.8 | 115 | 11.5 / 2.5 / 56 (7) [10-04:56 10-03:42 09-28:6] | 1.56 / 3.28 | 1.30 / 7.24 (285) | 19.6 / 20.1 (43.0) |
| 9 | 22.0 | 88 | 8.8 / 1.5 / 47 (6) [10-04:47 10-03:33 09-28:3] | 1.56 / 3.56 | 1.31 / 5.87 (312) | 14.4 / 14.8 (31.6) |
| 10 | 17.3 | 69 | 6.9 / 0 / 44 (3) [10-04:44 10-03:23 09-28:2] | 1.56 / 3.18 | 1.34 / 5.87 (331) | 9.2 / 9.5 (20.3) |
| 12 | 8.0 | 32 | 3.2 / 0 / 23 (2) [10-04:23 10-03:9] | 1.38 / 2.93 | 1.38 / 5.68 (368) | 3.4 / 3.5 (7.5) |

## L = 30 min — Pull = created − 30 min; in-flight interval [created − L, merged]
In-flight at Pull (others): median 6 / p75 9 / p90 12 / max 16, mean 6.81. Time-weighted mean: 5.74 over wall 219.2 h, 5.87 while ≥1 in flight (214.3 h). Max in flight 17.

| B | held share % | held n/400 | held per day: mean over 10 days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight time % (h) |
|---|---|---|---|---|---|---|
| 4 | 84.3 | 337 | 33.7 / 24 / 87 (10) [10-04:87 10-03:66 09-26:62] | 1.45 / 5.45 | 1.24 / 3.40 (63) | 81.1 / 83.0 (177.8) |
| 5 | 76.3 | 305 | 30.5 / 21 / 84 (10) [10-04:84 10-03:65 09-26:53] | 1.49 / 5.52 | 1.24 / 4.14 (95) | 64.0 / 65.5 (140.3) |
| 6 | 62.0 | 248 | 24.8 / 12 / 83 (10) [10-04:83 10-03:58 09-26:36] | 1.43 / 3.64 | 1.30 / 8.51 (152) | 48.7 / 49.8 (106.7) |
| 7 | 49.0 | 196 | 19.6 / 8 / 80 (9) [10-04:80 10-03:52 09-26:24] | 1.46 / 3.56 | 1.31 / 7.79 (204) | 35.0 / 35.8 (76.7) |
| 8 | 37.0 | 148 | 14.8 / 4.5 / 68 (7) [10-04:68 10-03:47 09-26:13] | 1.47 / 3.01 | 1.36 / 8.08 (252) | 23.4 / 24.0 (51.4) |
| 9 | 26.8 | 107 | 10.7 / 2.5 / 54 (7) [10-04:54 10-03:39 09-28:4] | 1.56 / 3.56 | 1.31 / 5.87 (293) | 17.3 / 17.7 (37.9) |
| 10 | 19.3 | 77 | 7.7 / 0.5 / 45 (5) [10-04:45 10-03:28 09-28:2] | 1.56 / 3.23 | 1.34 / 5.97 (323) | 11.1 / 11.3 (24.2) |
| 12 | 11.0 | 44 | 4.4 / 0 / 32 (2) [10-04:32 10-03:12] | 1.42 / 3.31 | 1.37 / 5.74 (356) | 4.7 / 4.8 (10.2) |

## Sensitivity (step 4), L = 19.3 min — Pulls whose Pull day (UTC) is 2026-10-03 or 2026-10-04 removed from the *counted* Pulls; the in-flight counts still include those days' PRs as other tickets (their interval is real); n = 246

| B | held share % | held n/246 | held per day: mean over 8 days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) |
|---|---|---|---|---|---|
| 4 | 69.9 | 172 | 21.5 / 19 / 60 (8) [09-26:60 09-27:25 09-28:23] | 1.39 / 8.52 | 1.20 / 5.36 (74) |
| 5 | 52.4 | 129 | 16.1 / 14.5 / 39 (8) [09-26:39 09-28:20 09-29:19] | 1.55 / 8.66 | 1.24 / 5.32 (117) |
| 6 | 32.9 | 81 | 10.1 / 8 / 25 (8) [09-26:25 09-28:16 09-29:9] | 1.53 / 8.08 | 1.27 / 8.35 (165) |
| 7 | 16.3 | 40 | 5.0 / 4 / 13 (6) [09-26:13 09-28:11 10-01:5] | 1.31 / 5.74 | 1.31 / 9.09 (206) |
| 8 | 6.9 | 17 | 2.1 / 2 / 6 (5) [09-28:6 09-26:4 10-01:3] | 1.49 / 3.56 | 1.31 / 9.06 (229) |
| 9 | 3.3 | 8 | 1.0 / 0.5 / 3 (4) [09-28:3 09-26:2 10-01:2] | 1.14 / 3.02 | 1.32 / 8.71 (238) |
| 10 | 0.8 | 2 | 0.3 / 0 / 2 (1) [09-28:2] | 1.51 / 1.79 | 1.31 / 8.42 (244) |
| 12 | 0.0 | 0 | 0.0 / 0 / 0 (0) [] | — / — | 1.31 / 8.32 (246) |

## Sensitivity (step 4, strict variant), L = 19.3 min — burst-day PRs removed from the population entirely (any PR whose Pull, creation or merge falls on 10-03/10-04), so burst traffic is also absent from the in-flight counts; n = 236

| B | held share % | held n/236 | held per day mean/median/max (days with ≥1 held) | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight % |
|---|---|---|---|---|---|---|
| 4 | 68.6 | 162 | 20.3 / 17.5 / 60 (8) | 1.42 / 7.81 | 1.16 / 4.34 (74) | 73.2 / 75.6 |
| 5 | 50.8 | 120 | 15.0 / 13 / 39 (8) | 1.55 / 8.03 | 1.20 / 4.86 (116) | 53.2 / 55.0 |
| 6 | 31.8 | 75 | 9.4 / 8 / 25 (8) | 1.53 / 5.82 | 1.25 / 5.87 (161) | 33.5 / 34.6 |
| 7 | 15.7 | 37 | 4.6 / 4 / 13 (5) | 1.35 / 5.74 | 1.29 / 8.04 (199) | 18.1 / 18.6 |
| 8 | 6.4 | 15 | 1.9 / 1 / 6 (4) | 1.67 / 4.29 | 1.28 / 8.03 (221) | 8.7 / 9.0 |
| 9 | 3.0 | 7 | 0.9 / 0 / 3 (3) | 1.17 / 3.41 | 1.30 / 6.30 (229) | 5.2 / 5.4 |
| 10 | 0.8 | 2 | 0.3 / 0 / 2 (1) | 1.51 / 1.79 | 1.29 / 5.87 (234) | 1.3 / 1.3 |
| 12 | 0.0 | 0 | 0.0 / 0 / 0 (0) | — / — | 1.29 / 5.87 (236) | 0.0 / 0.0 |

## Step 3 — merge-gate capacity
PRs with no ready-to-merge label event in cache: 0; PRs with no label before merge: 2. Merges 400; gaps 399.

| gap definition | n gaps | median gap min | μ = 60/median (merges/h) | mean gap min | μ=60/mean | p25–p75 min |
|---|---|---|---|---|---|---|
| label-waiting: gap after merge i is busy if some PR merging after i already carried its first ready-to-merge label at merge i's instant | 272 | 6.22 | 9.65 | 17.04 | 3.52 | 5.2–10.5 |
| consecutive merges < 30 min apart | 304 | 6.66 | 9.01 | 10.10 | 5.94 | 5.3–13.3 |
| both of the above | 243 | 6.00 | 10.00 | 7.85 | 7.64 | 5.0–8.4 |
| all inter-merge gaps | 399 | 9.35 | 6.42 | 32.74 | 1.83 | 5.7–28.1 |

W0 = median created→merged, PRs arriving at open-PR depth 0–2 (baseline depth, L=0): n=68, 69.5 min (1.16 h). Depth 0–1: 73.8 min; depth 0: 84.7 min (n=10).

| gap definition | μ /h | μ·W0 | μ·(W0 + 19.3 min) |
|---|---|---|---|
| label-waiting: gap after merge i is busy if some PR merging after i already carried its first ready-to-merge label at merge i's instant | 9.65 | 11.18 | 14.29 |
| consecutive merges < 30 min apart | 9.01 | 10.44 | 13.34 |
| both of the above | 10.00 | 11.59 | 14.81 |
| all inter-merge gaps | 6.42 | 7.44 | 9.50 |

Stages-note pace cross-check (pace = (first ready-to-merge label → merged) / (merges by others in that span + 1); over all 398 labelled PRs): median 8.43 min/merge (μ 7.12/h), mean 16.05 min/merge.

