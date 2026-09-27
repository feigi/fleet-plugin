# Readout of the within-run tier pairs: does model tier move outcomes?

Research for [issue #2031](https://github.com/feigi/fleet-plugin/issues/2031), a child of
wayfinder map #2030 (per-ticket model+effort routing for fleet implementers). Derivation
script: `docs/research/tier-readout-derive.mjs`, run as
`node docs/research/tier-readout-derive.mjs docs/metrics/member-outcomes.tsv docs/metrics/tier-outcomes.tsv`.
Every number below comes from that script's output against the two TSVs as they stood on
2026-09-27 — re-run it before citing, per both files' own header warning that an append
lands without touching the header.

## 0. The gate has moved since it cleared

The pairing gate (≥10 pairs across ≥5 `run_date`s) cleared on 2026-09-12 at 17 pairs / 8
dates (#1066). Running the exact query from `member-outcomes.tsv`'s own header today finds
**21 pairs across 12 run_dates**:

```
awk -F'\t' '!/^#/ {if ($15 ~ /(^|:)fleet-implementer-alt$/) a[$1 FS $5]; \
    else if ($15 ~ /(^|:)fleet-implementer$/) t[$1 FS $5]; d[$1]=$2} \
    END{for (k in a) {split(k,x,FS); for (j in t) {split(j,y,FS); \
      if (x[1]==y[1] && x[2]!=y[2]) p[x[1]]}} \
    for (s in p) {n++; r[d[s]]} print n+0, length(r)}' docs/metrics/member-outcomes.tsv
```
→ `21 12`, dates 2026-08-28 .. 2026-09-19. Nobody has read either the original 17 or the
current 21. This readout covers all 21. The header's own flagged non-pair — a session that
dispatched 12 alt and 15 top implementers that all resolved to `claude-sonnet-5` anyway — is
confirmed still excluded by the query's model-difference test:

```
EXCLUDED (same model): 2026-09-08T14-14-34-049Z_01a0815e-e141-716c-b2d8-2adf310fbe55
  run_date=2026-09-11 model=claude-sonnet-5 alt#=12 top#=15
```

## 1. Identifying the pairs, and a join-key correction

`member-outcomes.tsv`'s `pr` column is **blank on every implementer-dispatch row**: 268
rows carry `subagent_type` matching `fleet-implementer` or `fleet-implementer-alt`, and 0 of
them carry a non-blank `pr`. This isn't a data gap — an `impl-<n>` dispatch is named for the
**ticket** it was given, and it does not know its own PR number until after it opens one, so
the scraper (per its own header: "`ticket`/`pr` are blank when the member name does not
identify one") never has a PR to record for this role. The join to `tier-outcomes.tsv`
(where the controller records the verdict once review rules it) therefore has to run on
**`ticket`**, not `pr`. Doing that: of the 235 alt+top dispatch rows across the 21 paired
sessions, 149 carry a ticket that resolves to exactly one `tier-outcomes.tsv` row (29 alt,
120 top); the rest are still open, unruled, or the ticket was never re-verdicted.

The full per-pair, per-member listing (ticket ask #1) is the Appendix at the end of this
document — all 21 pairs, every alt and top dispatch, with model, effort, ticket, verdict,
and every token/timing column. It shows something the pairing count alone hides: **pair size
is wildly unequal**, because every 5th `impl-` dispatch draws alt (`SKILL.md:967-972`), so a
session that ran many tickets in one sitting dispatches roughly 4 top members for every alt
member. Two sessions alone (`2026-09-12`, 33 top / 2 alt joined; `2026-09-17`, 25 top / 1
alt joined) supply 58 of the 120 joined top rows. Any comparison that pools rows naively is
implicitly a comparison dominated by whichever session happened to run the most tickets, not
an equal-weight comparison of the two arms — see §3b for the fix.

## 2. Join to `tier-outcomes.tsv`: `closed_own_ticket`, `minted_false_claim`, `class`, `sizing`, `profile`, `loc`, `files`

Done via `ticket`. Every joined row carries all seven columns (blank where
`tier-outcomes.tsv` itself has not recorded one — `sizing`/`profile`/`loc`/`files` are blank
on every row before 2026-08-28, per that file's own header).

## 3. Per-arm report

**Quality floor, as the ticket defines it**: `minted_false_claim=yes` OR
`closed_own_ticket=no`.

### 3a. Row-level, all joined dispatches in paired sessions — CONFOUNDED by ticket count per session, see 3b

```
ALT (fleet-implementer-alt): n=29 fail=21/29 (72.4%) cacheCreate mean/med=176246/153094
  out mean/med=9374/4700 wall_s mean=1495 turns mean=48 $ mean/med=$0.53/$0.46
TOP (fleet-implementer):     n=120 fail=63/120 (52.5%) cacheCreate mean/med=205133/167246
  out mean/med=34131/20444 wall_s mean=1762 turns mean=61 $ mean/med (n=120)=$2.14/$1.97
```

Stratified by sizing (member's own light/heavy verdict, where dated before the PR opened):

```
alt sizing=heavy:  n=2  fail=2/2 (100.0%)  $ mean/med=$0.83/$0.93
alt sizing=light:  n=18 fail=16/18 (88.9%) $ mean/med=$0.54/$0.46
alt sizing=(blank):n=9  fail=3/9 (33.3%)   $ mean/med=$0.46/$0.41
top sizing=heavy:  n=41 fail=28/41 (68.3%) $ mean/med=$2.89/$2.72
top sizing=light:  n=43 fail=22/43 (51.2%) $ mean/med=$1.78/$1.36
top sizing=(blank):n=36 fail=13/36 (36.1%) $ mean/med=$1.70/$1.47
```

Stratified by profile (diff-stats.mjs, merged diff):

```
alt profile=docs:        n=1  fail=1/1 (100.0%)  $ mean=$0.41
alt profile=production:  n=17 fail=15/17 (88.2%)  $ mean/med=$0.58/$0.46
alt profile=small:       n=2  fail=0/2 (0.0%)     $ mean/med=$0.45/$0.62
alt profile=tests-only:  n=9  fail=5/9 (55.6%)     $ mean/med=$0.49/$0.46
top profile=docs:        n=3  fail=0/3 (0.0%)      $ mean/med=$1.52/$1.00
top profile=production:  n=67 fail=38/67 (56.7%)   $ mean/med=$2.27/$2.04
top profile=single-file: n=2  fail=0/2 (0.0%)      $ mean/med=$0.75/$0.79
top profile=small:       n=1  fail=0/1 (0.0%)      $ mean=$1.31
top profile=tests-only:  n=47 fail=25/47 (53.2%)   $ mean/med=$2.05/$2.02
```

### 3b. Session-level: one paired observation per session (equal weight, not per-ticket)

17 of the 21 paired sessions have a verdicted ticket on **both** sides. Full per-session
means are in the script's raw output (omitted here for length — re-run to see them);
across-session averages of the per-session means:

```
                 alt      top
failRate:        0.755    0.634
meanCacheCreate: 191300.245  209336.086
meanOut:         10106.853   15503.875
meanWall:        1808.951    1585.372
meanTurns:       51.637      54.751
meanDollars:     0.579       1.696
```

Direction is unchanged from the row-level pooling (§3a): alt fails more, costs less, in both
views. That agreement is expected — it is the same underlying sessions — but it rules out
"the row-level number is just an artefact of two mega-sessions": even giving every session
equal weight, alt's failure rate (75.5%) is higher than top's (63.4%).

### 3c. CONFOUNDED — every row of `tier-outcomes.tsv`, unpaired, by its own `tier` label

`tier-outcomes.tsv` carries no token columns, so this view has no `$` figure — descriptives
only, over all 283 data rows in the file regardless of session, date, class, or whether a pair exists:

```
tier=opus:   n=217 fail=119 (54.8%)
tier=sonnet: n=63  fail=39  (61.9%)
```

Same direction as the paired views (opus/top lower failure rate), for what a fully
confounded, all-history, all-role comparison is worth — mixes every ticket difficulty, every
class, every generation the file has ever recorded, with no control at all.

### 3d. The split the naive numbers above hide: effort was not held constant

The tiering spec's explicit design (`docs/specs/2026-08-27-fleet-member-outcomes-plan-2-tiering.md`
§ "Explicitly NOT done here"): *"No effort experiment. Both implementer definitions share
one effort on purpose."* Both agent definitions declare `xhigh`. In practice, across most of
this corpus, **they did not run at the same resolved effort** — a drift already flagged
in agent-brain memory (2026-09-09, `settings.json`'s `effortLevel` silently capping
frontmatter). Grouping the paired `run_date`s by whether every alt row's effort that day
matched every top row's effort:

```
effort-matched dates:    2026-09-08, 2026-09-12, 2026-09-17, 2026-09-18, 2026-09-19
effort-mismatched dates: 2026-08-28, 2026-08-29, 2026-08-30, 2026-08-31, 2026-09-01,
                          2026-09-02, 2026-09-03
```

(09-08 ran both arms capped to `high`; 09-12/17/18/19 ran both uncapped at `xhigh`; every
earlier date ran alt uncapped at `xhigh` while top was capped to `high` — **alt getting
strictly more thinking budget than top**, the opposite of this box's *current* drift
reported by the T1 ticket on this map, where top is capped and alt is not — the direction of
the miscalibration has flipped at least once over the study period.)

```
-- MATCHED (n=10 alt / n=80 top, all joined rows come from only 3 sessions)
  alt: n=10 fail=3/10 (30.0%)  cacheCreate mean/med=109749/94901  $ mean/med=$0.42/$0.38
  top: n=80 fail=36/80 (45.0%) cacheCreate mean/med=192262/165509 $ mean/med=$2.36/$2.30
-- MISMATCHED (n=19 alt / n=40 top)
  alt: n=19 fail=18/19 (94.7%) cacheCreate mean/med=211245/172069 $ mean/med=$0.59/$0.48
  top: n=40 fail=27/40 (67.5%) cacheCreate mean/med=230874/184071 $ mean/med=$1.69/$1.36
```

**This reverses the pooled result.** At matched effort, sonnet (alt) has the *lower* failure
rate (30.0% vs 45.0%). At mismatched effort — where alt was actually handed *more* thinking
budget than top, and still failed far more (94.7% vs 67.5%) — the pooled §3a/§3b numbers
come almost entirely from this regime: 7 of the 12 paired dates (15 of the 21 pairs, 1-15
in run_date order) ran mismatched effort, against 5 dates (6 pairs, 16-21) that ran matched
effort. The naive "opus wins" read of §3a/§3b is not naming the
model effect cleanly; it is dominated by a regime where the *cheaper* model got *more*
reasoning budget and still lost badly, which is itself informative but is not the same claim
as "opus beats sonnet at equal effort." The one genuinely equal-effort slice — 10 alt tickets
across 3 sessions (7 of which come from a single day, 2026-09-08, that had its own
settings.json-driven cap incident, not a clean day) — points the other way, at an n far too
small to trust on its own.

## 4. Token → $ conversion

Source: [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing) (Anthropic,
read 2026-09-27). Per the ticket's instruction, only cache-write and output are priced —
`member-outcomes.mjs` scrapes neither `input_tokens` nor `cache_read_input_tokens`, so every
`$` figure above is a **lower bound**, and the two arms are understated by different amounts
if their cache-read volume differs (unmeasured here). $/MTok used (5-minute cache-write
tier, the default `cache_control` duration and the only one the scraper's single
`tokens_cache_create` column can represent — a 1-hour write is priced at $10/$12.50/MTok for
opus/sonnet respectively, 60% higher, and the corpus cannot distinguish the two):

| model | cache_write (5m) | output |
|---|---|---|
| `claude-opus-5` | $6.25/MTok | $25/MTok |
| `claude-sonnet-5` | $2.50/MTok | $10/MTok |
| `claude-opus-4-7` / `claude-opus-4-8` | $6.25/MTok | $25/MTok |
| `claude-haiku-4-5` | $1.25/MTok | $5/MTok |

Every paired row in this corpus uses `claude-opus-5` or `claude-sonnet-5` — no
`claude-opus-4-x` rows fall inside a pair, so the "never pool generations" warning does not
bite here, but it would on any future extension of this query. Sonnet's $2/$10 introductory
rate became the *permanent* standard rate as of 2026-09-01 per the same pricing page (the
scheduled increase to $3/$15 was cancelled), so one rate applies across the whole corpus.

## 5. tier-check-verification and effort per date

**Zero of the 21 paired sessions are tier-check-verified.** The ticket's cutoff is run_date
≥ 2026-09-20; every paired session's `run_date` (which `member-outcomes.tsv` stamps from the
newest transcript mtime, not a dispatch-time clock read) falls in 2026-08-28..2026-09-19.
None of the pairs read here were dispatched under an enforced pre-flight tier check — every
row's model/effort is exactly what the transcript recorded, unverified against what the
dispatch declared. Per-date effort combination (from the script; every date is
`not verified`):

```
2026-08-28: alt={xhigh} top={high}
2026-08-29: alt={xhigh} top={high}
2026-08-30: alt={xhigh} top={high}
2026-08-31: alt={xhigh} top={high}
2026-09-01: alt={xhigh} top={high}
2026-09-02: alt={xhigh} top={high}
2026-09-03: alt={xhigh} top={high}
2026-09-08: alt={high}  top={high}
2026-09-12: alt={xhigh} top={xhigh}
2026-09-17: alt={xhigh} top={xhigh}
2026-09-18: alt={xhigh} top={xhigh}
2026-09-19: alt={xhigh} top={xhigh}
```

This box's *current* (2026-09-27) override — `fleet-implementer` at `@slow:high` while its
frontmatter declares `xhigh` — matches the 08-28..09-03 regime, not the 09-12..09-19 one:
the drift these dates show is not a one-time incident, it is the box's steady state except
for a brief window (09-12 through 09-19) when it was apparently correct, and 09-08's
one-off settings.json cap. T1 on this map (reconciling the current override) needs to keep
recording *resolved*, not *declared*, tier for this reason, and this history says the
reconciliation itself needs re-checking periodically, not just once.

## 6. Answer

**Does model tier move the quality floor at n=17 (verdicted) / 21 (all pairs)?** Direction
is not stable. Pooled across all effort regimes (§3a, §3b), top(opus) shows a *lower*
failure rate than alt(sonnet) — 52.5–63.4% vs 72.4–75.5% depending on weighting — and that
same direction shows up in the fully confounded whole-file view (§3c: opus 54.8% vs sonnet
61.9%, n=280). But splitting by whether effort was actually held constant (§3d) **reverses
the sign** in the one slice where it's a fair fight: at matched effort, sonnet's failure rate
(30.0%, n=10) is *lower* than opus's (45.0%, n=80). The pooled "opus wins" read is
substantially a story about the mismatched-effort regime, where sonnet got *more* thinking
budget than opus and still failed at 94.7%.

**Does it move $ per PR?** Yes, unambiguously, and this is the one stable result: opus/top
costs roughly 3–4x sonnet/alt per ticket under every weighting and every effort regime
(§3a: $2.14 vs $0.53 mean; §3b: $1.70 vs $0.58 session-mean; §3d matched: $2.36 vs $0.42;
§3d mismatched: $1.69 vs $0.59) — output-token volume drives most of this (top's median
`tokens_out` is 4–8x alt's), not just the list-price ratio. This is the number I'd trust
most: it's consistent everywhere, it's large, and unlike the quality-floor read it doesn't
flip sign when you control for effort.

**Confidence: low**, for four compounding reasons, all visible in this data, none
hypothetical:
1. **n is small and clustered, not independent.** 149 joined tickets come from 17 sessions;
   two sessions alone supply 58 of 120 top rows. Tickets within one session share a
   controller, a day, and (per the appendix) sometimes even a settings.json incident — they
   are not 149 independent trials.
2. **Effort was not controlled** for 15 of 21 pairs, directly contradicting the tiering
   spec's stated design, and the direction of the miscalibration has already flipped once
   (alt-favoring before 09-12, top-favoring by 09-27). Any pooled number is a mixture of two
   different experiments in proportions nobody chose.
3. **Zero rows are tier-check-verified.** Every number here rests on what the transcript
   happened to record, with no independent confirmation the dispatch asked for what it got.
4. **The matched-effort slice that would settle the sign is n=10**, from 3 sessions, one of
   which (09-08) was itself an anomalous settings.json-cap day.

**Does this support "go"?** No — not yet, and not because the effect is null; because the
evidence needed to call it hasn't accumulated under controlled conditions. Recommendations
for G4 (go/no-go criterion) and the standing pairing policy:

- **Do not taper the pairing rate.** The spec deferred the taper decision to "what the first
  ≥10 pairs are for" (§ "No pairing-rate taper"); those pairs turned out to be
  effort-confounded for 15 of 21, so the taper question is still unanswered, not
  answered-and-ready-to-shrink. Tapering now would shrink the one lever available for
  getting a clean-effort n.
- **T1 (reconcile the override) is a precondition, not a parallel task.** Every future pair
  is confounded again until it lands, and — per §5 — the reconciliation needs a standing
  recheck (e.g. tied to tier-check being enforced, not a one-time fix), because this drift
  has already recurred once.
- **Target the matched-effort slice specifically.** Once T1 lands and tier-check enforcement
  makes future pairs verifiable, the useful target is ~20+ *matched-effort, verified* pairs
  before ruling — not 10 more of whatever mix happens to occur, which is what produced the
  confound this readout found.
- **G4's go/no-go criterion should treat this readout as "insufficient evidence, not
  negative evidence."** The $ signal is real and large; the quality signal is real but its
  sign is not yet resolved. A router built on this data alone would be optimizing for cost
  on a quality assumption that has already been observed to flip.

## Appendix: every dispatched member of every pair, both arms, in run_date order

### Pair 1 — session `20349c08-0f80-4c27-af01-48cab13faa48` — run_date 2026-08-28

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-387 | 387 | claude-sonnet-5 | xhigh | yes/yes | 169931 | 3848 | 765 | 41 |
| top | impl-375 | 375 | claude-opus-5 | high | yes/no | 186798 | 4504 | 1185 | 46 |
| top | impl-381 | 381 | claude-opus-5 | high | yes/yes | 443005 | 28828 | 2359 | 92 |
| top | impl-389 | 389 | claude-opus-5 | high | yes/no | 274605 | 12455 | 2094 | 43 |

### Pair 2 — session `f9cc9b5e-ea11-46ee-bed2-a559abc04ba0` — run_date 2026-08-29

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-401 | 401 | claude-sonnet-5 | xhigh | yes/yes | 151706 | 12012 | 734 | 49 |
| alt | impl-427 | 427 | claude-sonnet-5 | xhigh | yes/yes | 368976 | 4384 | 5534 | 86 |
| top | impl-388 | 388 | claude-opus-5 | high | yes/yes | 202772 | 19318 | 1948 | 102 |
| top | impl-400 | 400 | claude-opus-5 | high | yes/yes | 190891 | 6601 | 1543 | 41 |
| top | impl-402 | 402 | claude-opus-5 | high | yes/no | 124336 | 12861 | 953 | 35 |
| top | impl-415 | 415 | claude-opus-5 | high | yes/yes | 414585 | 1355 | 2341 | 61 |
| top | impl-424 | 424 | claude-opus-5 | high | yes/yes | 112999 | 7213 | 1389 | 38 |
| top | impl-431 | 431 | claude-opus-5 | high | yes/no | 172547 | 3740 | 1938 | 64 |

### Pair 3 — session `14d2ef0c-e016-47eb-9539-4acabdc899b4` — run_date 2026-08-30

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-463 | 463 | claude-sonnet-5 | xhigh | yes/yes | 210336 | 21051 | 1866 | 80 |
| top | impl-454 | 454 | claude-opus-5 | high | yes/yes | 136515 | 2782 | 1266 | 41 |
| top | impl-496 | 496 | claude-opus-5 | high | yes/no | 174396 | 10825 | 1232 | 98 |

### Pair 4 — session `278cab08-3590-4ffd-9a03-d5daf2dbb861` — run_date 2026-08-30

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-443 | 443 | claude-sonnet-5 | xhigh | yes/yes | 365602 | 4447 | 8750 | 47 |
| top | impl-347 | 347 | claude-opus-5 | high | yes/yes | 228224 | 10882 | 1862 | 90 |
| top | impl-439 | 439 | claude-opus-5 | high | no/yes | 109790 | 2015 | 1171 | 46 |
| top | impl-447 | 447 | claude-opus-5 | high | yes/yes | 89416 | 679 | 528 | 28 |
| top | impl-503 | 503 | claude-opus-5 | high | yes/yes | 107543 | 6875 | 659 | 31 |

### Pair 5 — session `bfea3561-fc45-44a8-b9f9-491b6334147c` — run_date 2026-08-30

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-437 | 437 | claude-sonnet-5 | xhigh | yes/yes | 172069 | 4664 | 856 | 56 |
| top | impl-436 | 436 | claude-opus-5 | high | yes/yes | 156226 | 13143 | 1251 | 50 |
| top | impl-453 | 453 | claude-opus-5 | high | yes/yes | 124124 | 9241 | 1483 | 45 |

### Pair 6 — session `d913dcb9-28b2-45a6-80cf-4da02ee07b62` — run_date 2026-08-30

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-468 | 468 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 151179 | 2258 | 665 | 43 |
| top | impl-455 | 455 | claude-opus-5 | high | (no tier-outcomes row) | 109992 | 4944 | 1220 | 37 |
| top | impl-493 | 493 | claude-opus-5 | high | (no tier-outcomes row) | 636835 | 11073 | 2599 | 94 |
| top | impl-494 | 494 | claude-opus-5 | high | (no tier-outcomes row) | 108447 | 6820 | 901 | 34 |

### Pair 7 — session `033e86e7-d315-44df-b1cb-0bfacecd8316` — run_date 2026-08-31

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-525 | 525 | claude-sonnet-5 | xhigh | yes/yes | 155299 | 1908 | 619 | 49 |
| top | impl-482 | 482 | claude-opus-5 | high | yes/yes | 322563 | 6615 | 2224 | 69 |
| top | impl-529 | 529 | claude-opus-5 | high | yes/yes | 116225 | 7156 | 1510 | 44 |

### Pair 8 — session `1c8adfea-6417-4b5b-a51e-33265d482781` — run_date 2026-08-31

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-533 | 533 | claude-sonnet-5 | xhigh | yes/yes | 353907 | 4841 | 4680 | 84 |
| top | impl-393 | 393 | claude-opus-5 | high | yes/yes | 232474 | 1840 | 1545 | 43 |
| top | impl-528 | 528 | claude-opus-5 | high | yes/yes | 92020 | 2753 | 864 | 35 |

### Pair 9 — session `a704783e-6f72-411e-8154-71239863a5b2` — run_date 2026-08-31

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-553 | 553 | claude-sonnet-5 | xhigh | yes/no | 126727 | 14315 | 854 | 51 |
| top | impl-532 | 532 | claude-opus-5 | high | yes/yes | 164023 | 7856 | 973 | 76 |
| top | impl-551 | 551 | claude-opus-5 | high | (no tier-outcomes row) | 215791 | 7526 | 1552 | 66 |

### Pair 10 — session `449b7161-729d-4c60-94ee-80a345e5d2f9` — run_date 2026-09-01

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-584 | 584 | claude-sonnet-5 | xhigh | no/yes | 165746 | 3445 | 764 | 46 |
| top | impl-583 | 583 | claude-opus-5 | high | yes/no | 326287 | 30607 | 2890 | 53 |
| top | impl-590 | 590 | claude-opus-5 | high | yes/no | 147031 | 31088 | 1773 | 56 |
| top | impl-591 | 591 | claude-opus-5 | high | yes/no | 184071 | 8755 | 1410 | 51 |

### Pair 11 — session `6adfe010-407b-489b-aaed-811486a0b19b` — run_date 2026-09-01

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-539 | 539 | claude-sonnet-5 | xhigh | yes/yes | 123994 | 7753 | 1085 | 50 |
| alt | impl-570 | 570 | claude-sonnet-5 | xhigh | yes/yes | 280693 | 1580 | 916 | 45 |
| alt | impl-581 | 581 | claude-sonnet-5 | xhigh | yes/yes | 132391 | 6220 | 887 | 49 |
| alt | impl-585 | 585 | claude-sonnet-5 | xhigh | yes/yes | 89976 | 969 | 656 | 38 |
| top | impl-535 | 535 | claude-opus-5 | high | yes/yes | 200305 | 8035 | 1310 | 47 |
| top | impl-567 | 567 | claude-opus-5 | high | yes/yes | 420386 | 11006 | 2846 | 66 |
| top | impl-578 | 578 | claude-opus-5 | high | yes/yes | 106548 | 15422 | 811 | 41 |

### Pair 12 — session `72f556c0-b1c0-4adf-b36c-83116dbed4b7` — run_date 2026-09-01

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-1170 | 1170 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 197007 | 5520 | 3708 | 59 |
| alt | impl-752 | 752 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 220895 | 391 | 6849 | 51 |
| top | impl-1177 | 1177 | claude-opus-5 | high | (no tier-outcomes row) | 104257 | 14527 | 1394 | 41 |
| top | impl-551-b | 551 | claude-opus-5 | high | (no tier-outcomes row) | 103865 | 8786 | 1133 | 50 |
| top | impl-605 | 605 | claude-opus-5 | high | (no tier-outcomes row) | 97584 | 2140 | 743 | 36 |

### Pair 13 — session `2c1b9510-77c9-41b2-ac8a-02ee78bb1c12` — run_date 2026-09-02

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-654 | 654 | claude-sonnet-5 | xhigh | yes/yes | 153094 | 2513 | 482 | 37 |
| alt | impl-818 | 818 | claude-sonnet-5 | xhigh | yes/yes | 327305 | 2599 | 1975 | 65 |
| top | impl-603 | 603 | claude-opus-5 | high | yes/yes | 105982 | 10809 | 1034 | 33 |
| top | impl-836 | 836 | claude-opus-5 | high | yes/yes | 322805 | 11579 | 2177 | 36 |
| top | impl-847 | 847 | claude-opus-5 | high | yes/yes | 85244 | 13934 | 1367 | 37 |
| top | impl-851 | 851 | claude-opus-5 | high | yes/yes | 424561 | 20775 | 3462 | 55 |
| top | impl-853 | 853 | claude-opus-5 | high | yes/yes | 600666 | 10798 | 3446 | 40 |

### Pair 14 — session `9d506598-a99d-43f0-9990-19b35d88e96a` — run_date 2026-09-02

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-625 | 625 | claude-sonnet-5 | xhigh | yes/yes | 258657 | 20137 | 1988 | 58 |
| top | impl-570 | 570 | claude-opus-5 | high | yes/yes | 221187 | 5006 | 1173 | 37 |
| top | impl-676 | 676 | claude-opus-5 | high | yes/yes | 71537 | 6941 | 697 | 24 |
| top | impl-709 | 709 | claude-opus-5 | high | yes/no | 78856 | 8190 | 872 | 28 |

### Pair 15 — session `caf66206-51cd-4b02-b26d-d07bedae5dc5` — run_date 2026-09-03

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-1146 | 1146 | claude-sonnet-5 | xhigh | yes/yes | 172654 | 1483 | 861 | 40 |
| alt | impl-742 | 742 | claude-sonnet-5 | xhigh | no/yes | 234598 | 6218 | 1526 | 42 |
| top | impl-1129 | 1129 | claude-opus-5 | high | yes/no | 945763 | 5934 | 4225 | 123 |
| top | impl-1141 | 1141 | claude-opus-5 | high | yes/no | 311200 | 6021 | 1838 | 59 |
| top | impl-1149 | 1149 | claude-opus-5 | high | yes/no | 394129 | 11879 | 1722 | 64 |
| top | impl-712 | 712 | claude-opus-5 | high | yes/no | 112311 | 3660 | 905 | 41 |

### Pair 16 — session `578f7cda-56a9-4454-b29d-05e38fd52bd4` — run_date 2026-09-08

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-686 | 686 | claude-sonnet-5 | high | yes/no | 92279 | 4700 | 387 | 33 |
| top | impl-697 | 697 | claude-opus-5 | high | yes/no | 88937 | 2832 | 630 | 25 |
| top | impl-699 | 699 | claude-opus-5 | high | yes/no | 112929 | 1679 | 675 | 37 |
| top | impl-739 | 739 | claude-opus-5 | high | yes/no | 167112 | 3712 | 943 | 32 |
| top | impl-759 | 759 | claude-opus-5 | high | no/no | 160893 | 5068 | 1635 | 36 |

### Pair 17 — session `e6750ed8-8671-476d-841c-adcf5866c7e2` — run_date 2026-09-08

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-213 | 213 | claude-sonnet-5 | high | (no tier-outcomes row) | 643423 | 14388 | 2444 | 104 |
| alt | impl-22 | 22 | claude-sonnet-5 | high | yes/no | 94838 | 4044 | 395 | 21 |
| alt | impl-25 | 25 | claude-sonnet-5 | high | yes/no | 82021 | 10954 | 501 | 28 |
| alt | impl-602 | 602 | claude-sonnet-5 | high | yes/no | 134331 | 7279 | 689 | 35 |
| alt | impl-613 | 613 | claude-sonnet-5 | high | yes/yes | 174630 | 27698 | 1049 | 44 |
| alt | impl-624 | 624 | claude-sonnet-5 | high | yes/yes | 148369 | 965 | 752 | 38 |
| alt | impl-660 | 660 | claude-sonnet-5 | high | (no tier-outcomes row) | 119047 | 6808 | 530 | 53 |
| alt | impl-786 | 786 | claude-sonnet-5 | high | (no tier-outcomes row) | 253725 | 8155 | 11013 | 43 |
| alt | impl-805 | 805 | claude-sonnet-5 | high | yes/no | 86184 | 4086 | 818 | 49 |
| top | impl-1262 | 1262 | claude-opus-5 | high | yes/no | 131761 | 16612 | 850 | 29 |
| top | impl-18 | 18 | claude-opus-5 | high | yes/no | 77024 | 5264 | 457 | 22 |
| top | impl-218 | 218 | claude-opus-5 | high | yes/yes | 127054 | 9537 | 568 | 39 |
| top | impl-516 | 516 | claude-opus-5 | high | (no tier-outcomes row) | 123558 | 3931 | 695 | 32 |
| top | impl-55 | 55 | claude-opus-5 | high | yes/yes | 152113 | 17076 | 1198 | 53 |
| top | impl-600 | 600 | claude-opus-5 | high | yes/yes | 132227 | 5827 | 850 | 36 |
| top | impl-612 | 612 | claude-opus-5 | high | yes/no | 93919 | 19063 | 1035 | 38 |
| top | impl-614 | 614 | claude-opus-5 | high | (no tier-outcomes row) | 284910 | 19372 | 1705 | 59 |
| top | impl-617 | 617 | claude-opus-5 | high | yes/yes | 114628 | 19629 | 841 | 46 |
| top | impl-623 | 623 | claude-opus-5 | high | yes/no | 109470 | 4811 | 697 | 27 |
| top | impl-651 | 651 | claude-opus-5 | high | yes/no | 65103 | 420 | 386 | 18 |
| top | impl-667 | 667 | claude-opus-5 | high | (no tier-outcomes row) | 115818 | 2629 | 490 | 16 |
| top | impl-669 | 669 | claude-opus-5 | high | (no tier-outcomes row) | 57258 | 6375 | 492 | 17 |
| top | impl-727 | 727 | claude-opus-5 | high | yes/no | 248610 | 1883 | 1753 | 47 |
| top | impl-730 | 730 | claude-opus-5 | high | (no tier-outcomes row) | 394140 | 9912 | 1773 | 95 |
| top | impl-783 | 783 | claude-opus-5 | high | (no tier-outcomes row) | 110950 | 7387 | 534 | 69 |
| top | impl-805 | 805 | claude-opus-5 | high | yes/no | 30672 | 661 | 35 | 5 |
| top | impl-809 | 809 | claude-opus-5 | high | (no tier-outcomes row) | 56656 | 315 | 316 | 14 |
| top | impl-816 | 816 | claude-opus-5 | high | yes/yes | 338744 | 7561 | 1638 | 47 |
| top | impl-839 | 839 | claude-opus-5 | high | yes/no | 710370 | 8462 | 5564 | 61 |
| top | impl-951 | 951 | claude-opus-5 | high | yes/no | 404122 | 8929 | 3889 | 71 |
| top | impl-952 | 952 | claude-opus-5 | high | yes/no | 640071 | 6238 | 5703 | 41 |
| top | impl-953 | 953 | claude-opus-5 | high | yes/no | 460267 | 4396 | 6275 | 35 |
| top | impl-959 | 959 | claude-opus-5 | high | yes/yes | 287124 | 7003 | 1544 | 77 |
| top | impl-974 | 974 | claude-opus-5 | high | yes/no | 80828 | 4764 | 337 | 23 |

### Pair 18 — session `2026-09-11T09-12-25-754Z_01a08fbd-579a-77d3-991b-b80e489f2c19` — run_date 2026-09-12

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-1040 | 1040 | claude-sonnet-5 | xhigh | yes/no | 73647 | 17078 | 901 | 31 |
| alt | impl-825 | 825 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 65197 | 15376 | 596 | 13 |
| alt | impl-964 | 964 | claude-sonnet-5 | xhigh | no/no | 94901 | 37273 | 842 | 31 |
| top | impl-1005 | 1005 | claude-opus-5 | xhigh | yes/no | 118623 | 22881 | 1026 | 34 |
| top | impl-1016 | 1016 | claude-opus-5 | xhigh | yes/yes | 181453 | 92392 | 4506 | 116 |
| top | impl-1019 | 1019 | claude-opus-5 | xhigh | yes/yes | 144844 | 52318 | 2105 | 48 |
| top | impl-1020 | 1020 | claude-opus-5 | xhigh | yes/no | 253813 | 106568 | 2585 | 160 |
| top | impl-1025-2 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 66229 | 37320 | 1847 | 34 |
| top | impl-1029 | 1029 | claude-opus-5 | xhigh | yes/yes | 327966 | 94276 | 2622 | 134 |
| top | impl-1031 | 1031 | claude-opus-5 | xhigh | yes/no | 133063 | 35298 | 1723 | 63 |
| top | impl-1032 | 1032 | claude-opus-5 | xhigh | yes/no | 135265 | 47679 | 1397 | 53 |
| top | impl-1033 | 1033 | claude-opus-5 | xhigh | yes/no | 99758 | 27161 | 1116 | 32 |
| top | impl-1034 | 1034 | claude-opus-5 | xhigh | yes/no | 77872 | 19179 | 1057 | 36 |
| top | impl-1038 | 1038 | claude-opus-5 | xhigh | yes/no | 139345 | 48156 | 1292 | 55 |
| top | impl-1049-2 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 100499 | 33330 | 2054 | 35 |
| top | impl-1061 | 1061 | claude-opus-5 | xhigh | yes/no | 117928 | 31813 | 1113 | 35 |
| top | impl-1062 | 1062 | claude-opus-5 | xhigh | yes/no | 75413 | 24801 | 1595 | 35 |
| top | impl-1066 | 1066 | claude-opus-5 | xhigh | yes/yes | 268949 | 95441 | 2157 | 127 |
| top | impl-1070 | 1070 | claude-opus-5 | xhigh | yes/no | 125977 | 44699 | 1420 | 45 |
| top | impl-1072 | 1072 | claude-opus-5 | xhigh | yes/no | 82069 | 26224 | 940 | 30 |
| top | impl-1081 | 1081 | claude-opus-5 | xhigh | yes/yes | 188259 | 54411 | 1336 | 51 |
| top | impl-1093 | 1093 | claude-opus-5 | xhigh | yes/no | 247514 | 50229 | 2120 | 46 |
| top | impl-1108 | 1108 | claude-opus-5 | xhigh | yes/yes | 212932 | 76232 | 1918 | 70 |
| top | impl-1136 | 1136 | claude-opus-5 | xhigh | yes/no | 68540 | 23944 | 1109 | 28 |
| top | impl-1143 | 1143 | claude-opus-5 | xhigh | yes/no | 94029 | 35318 | 1156 | 36 |
| top | impl-894 | 894 | claude-opus-5 | xhigh | yes/yes | 158070 | 52332 | 1719 | 61 |
| top | impl-896 | 896 | claude-opus-5 | xhigh | yes/yes | 202362 | 83856 | 3194 | 131 |
| top | impl-906 | 906 | claude-opus-5 | xhigh | yes/no | 60053 | 18646 | 807 | 23 |
| top | impl-911 | 911 | claude-opus-5 | xhigh | yes/yes | 104747 | 42821 | 1505 | 47 |
| top | impl-915 | 915 | claude-opus-5 | xhigh | yes/no | 167246 | 41153 | 1177 | 45 |
| top | impl-918 | 918 | claude-opus-5 | xhigh | yes/yes | 69125 | 27019 | 1059 | 56 |
| top | impl-924 | 924 | claude-opus-5 | xhigh | yes/no | 184017 | 60548 | 2080 | 64 |
| top | impl-944 | 944 | claude-opus-5 | xhigh | yes/yes | 147500 | 54605 | 1182 | 51 |
| top | impl-956 | 956 | claude-opus-5 | xhigh | yes/yes | 123253 | 47552 | 1552 | 37 |
| top | impl-961 | 961 | claude-opus-5 | xhigh | yes/yes | 165509 | 52832 | 1381 | 60 |
| top | impl-966 | 966 | claude-opus-5 | xhigh | (no tier-outcomes row) | 250659 | 92316 | 2521 | 83 |
| top | impl-981 | 981 | claude-opus-5 | xhigh | (no tier-outcomes row) | 76452 | 27030 | 1606 | 34 |
| top | impl-986 | 986 | claude-opus-5 | xhigh | yes/no | 77574 | 20444 | 1055 | 21 |
| top | impl-991 | 991 | claude-opus-5 | xhigh | (no tier-outcomes row) | 92407 | 32545 | 1143 | 41 |
| top | impl-992 | 992 | claude-opus-5 | xhigh | no/no | 176075 | 56230 | 3003 | 63 |
| top | impl-993 | 993 | claude-opus-5 | xhigh | yes/no | 100192 | 23044 | 1411 | 42 |

### Pair 19 — session `2026-09-15T14-40-07-175Z_01a0a582-ca07-7421-acd4-e4713d1a552d` — run_date 2026-09-17

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-1412 | 1412 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 88164 | 23327 | 1156 | 59 |
| alt | impl-744 | 744 | claude-sonnet-5 | xhigh | yes/no | 116285 | 33379 | 1209 | 61 |
| alt | impl-889 | 889 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 351318 | 58812 | 1520 | 79 |
| top | impl-1002 | 1002 | claude-opus-5 | xhigh | yes/yes | 216721 | 101109 | 2110 | 86 |
| top | impl-1004 | 1004 | claude-opus-5 | xhigh | yes/no | 218457 | 99496 | 3022 | 106 |
| top | impl-1039 | 1039 | claude-opus-5 | xhigh | yes/yes | 208551 | 72873 | 2382 | 69 |
| top | impl-1045 | 1045 | claude-opus-5 | xhigh | yes/yes | 198251 | 76440 | 2000 | 77 |
| top | impl-1053 | 1053 | claude-opus-5 | xhigh | yes/yes | 264562 | 90141 | 2432 | 126 |
| top | impl-1055 | 1055 | claude-opus-5 | xhigh | (no tier-outcomes row) | 129899 | 52479 | 1300 | 46 |
| top | impl-1056 | 1056 | claude-opus-5 | xhigh | yes/yes | 438456 | 142758 | 4667 | 208 |
| top | impl-1057 | 1057 | claude-opus-5 | xhigh | (no tier-outcomes row) | 175490 | 61058 | 1521 | 74 |
| top | impl-1059 | 1059 | claude-opus-5 | xhigh | (no tier-outcomes row) | 113595 | 38895 | 1274 | 57 |
| top | impl-1064 | 1064 | claude-opus-5 | xhigh | (no tier-outcomes row) | 109404 | 32227 | 1143 | 46 |
| top | impl-1071 | 1071 | claude-opus-5 | xhigh | (no tier-outcomes row) | 106809 | 46051 | 1327 | 48 |
| top | impl-1083 | 1083 | claude-opus-5 | xhigh | yes/no | 308255 | 72948 | 1923 | 65 |
| top | impl-1084 | 1084 | claude-opus-5 | xhigh | (no tier-outcomes row) | 102885 | 38608 | 1780 | 64 |
| top | impl-1088 | 1088 | claude-opus-5 | xhigh | (no tier-outcomes row) | 84107 | 43503 | 1937 | 61 |
| top | impl-1100 | 1100 | claude-opus-5 | xhigh | (no tier-outcomes row) | 99136 | 42217 | 1592 | 71 |
| top | impl-1113 | 1113 | claude-opus-5 | xhigh | (no tier-outcomes row) | 136200 | 49574 | 1476 | 56 |
| top | impl-1119 | 1119 | claude-opus-5 | xhigh | (no tier-outcomes row) | 80276 | 35658 | 1896 | 47 |
| top | impl-1125 | 1125 | claude-opus-5 | xhigh | (no tier-outcomes row) | 60051 | 26243 | 1044 | 47 |
| top | impl-1130 | 1130 | claude-opus-5 | xhigh | (no tier-outcomes row) | 138675 | 70762 | 1629 | 64 |
| top | impl-1131 | 1131 | claude-opus-5 | xhigh | yes/no | 290312 | 72623 | 2009 | 119 |
| top | impl-1160 | 1160 | claude-opus-5 | xhigh | yes/yes | 354891 | 113051 | 2624 | 146 |
| top | impl-1161 | 1161 | claude-opus-5 | xhigh | (no tier-outcomes row) | 138902 | 51972 | 1754 | 73 |
| top | impl-1168 | 1168 | claude-opus-5 | xhigh | yes/yes | 181494 | 55063 | 1502 | 69 |
| top | impl-1175 | 1175 | claude-opus-5 | xhigh | (no tier-outcomes row) | 72632 | 31847 | 1093 | 31 |
| top | impl-1181 | 1181 | claude-opus-5 | xhigh | yes/yes | 238201 | 56845 | 1645 | 81 |
| top | impl-1192 | 1192 | claude-opus-5 | xhigh | (no tier-outcomes row) | 142292 | 43918 | 1577 | 73 |
| top | impl-1327 | 1327 | claude-opus-5 | xhigh | (no tier-outcomes row) | 196937 | 57952 | 2159 | 69 |
| top | impl-1419 | 1419 | claude-opus-5 | xhigh | (no tier-outcomes row) | 138760 | 70935 | 1818 | 67 |
| top | impl-1421 | 1421 | claude-opus-5 | xhigh | (no tier-outcomes row) | 149601 | 62507 | 2042 | 80 |
| top | impl-1423 | 1423 | claude-opus-5 | xhigh | yes/no | 245242 | 56366 | 1472 | 83 |
| top | impl-1472 | 1472 | claude-opus-5 | xhigh | (no tier-outcomes row) | 171904 | 80875 | 2015 | 78 |
| top | impl-1486 | 1486 | claude-opus-5 | xhigh | yes/yes | 315988 | 80887 | 1920 | 121 |
| top | impl-705 | 705 | claude-opus-5 | xhigh | yes/yes | 298525 | 90198 | 2639 | 118 |
| top | impl-780 | 780 | claude-opus-5 | xhigh | (no tier-outcomes row) | 141960 | 71036 | 1719 | 58 |
| top | impl-814 | 814 | claude-opus-5 | xhigh | yes/yes | 160152 | 63988 | 1516 | 71 |
| top | impl-854 | 854 | claude-opus-5 | xhigh | yes/yes | 313427 | 93385 | 2317 | 125 |
| top | impl-870 | 870 | claude-opus-5 | xhigh | yes/no | 146038 | 72235 | 1799 | 80 |
| top | impl-878 | 878 | claude-opus-5 | xhigh | yes/no | 263337 | 102516 | 2863 | 172 |
| top | impl-880 | 880 | claude-opus-5 | xhigh | yes/no | 112585 | 52658 | 1612 | 60 |
| top | impl-907 | 907 | claude-opus-5 | xhigh | yes/no | 114503 | 53280 | 1278 | 73 |
| top | impl-916 | 916 | claude-opus-5 | xhigh | yes/yes | 162373 | 57380 | 1705 | 109 |
| top | impl-926 | 926 | claude-opus-5 | xhigh | yes/yes | 173981 | 59776 | 1631 | 84 |
| top | impl-932 | 932 | claude-opus-5 | xhigh | yes/no | 198144 | 59400 | 1501 | 54 |
| top | impl-940 | 940 | claude-opus-5 | xhigh | (no tier-outcomes row) | 103366 | 36019 | 1099 | 41 |
| top | impl-990 | 990 | claude-opus-5 | xhigh | yes/yes | 223976 | 90128 | 2073 | 96 |
| top | impl-997 | 997 | claude-opus-5 | xhigh | yes/no | 171252 | 58690 | 1598 | 82 |

### Pair 20 — session `2026-09-18T06-44-48-800Z_01a0b342-b620-747d-ad66-d367a6c4e29a` — run_date 2026-09-18

No verdicted ticket on either side. Notable: this session's `top`-arm members are named `FinisherPr<n>`, `FixPr<n>`, `MergeBotWave<n>`, `Impl<n>` — i.e. the controller dispatched the `fleet-implementer` agent DEFINITION for what its own name says is finisher, fix-applier and merge-bot work, not fresh ticket implementation. That mixes the arm with non-comparable work; it does not enter any computed statistic above (no tier-outcomes join), but it is a data-quality fact worth carrying into G2's exploration design (ticket eligibility).

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | Impl1133 |  | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 266450 | 102649 | 2176 | 111 |
| top | FinisherPr1598 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 76525 | 20691 | 865 | 22 |
| top | FinisherPr1598b |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 59104 | 17659 | 1150 | 34 |
| top | FixPr1568 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 27173 | 101 | 14 | 2 |
| top | FixPr1568-2 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 1488388 | 217008 | 7899 | 221 |
| top | FixPr1569 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 30484 | 240 | 14 | 3 |
| top | FixPr1569-2 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 239865 | 105952 | 2166 | 96 |
| top | FixPr1574 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 475263 | 99763 | 2696 | 139 |
| top | FixPr1580 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 185207 | 76766 | 1985 | 87 |
| top | FixPr1581 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 194407 | 107454 | 2197 | 64 |
| top | FixPr1592 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 164411 | 65633 | 1723 | 60 |
| top | FixPr1598 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 220569 | 89068 | 2224 | 95 |
| top | Impl1188 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 168805 | 82930 | 1980 | 78 |
| top | Impl875 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 240243 | 55488 | 1453 | 60 |
| top | MergeBotWave7 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 119573 | 30276 | 837 | 27 |

### Pair 21 — session `2026-09-18T15-04-10-915Z_01a0b50b-e5a3-76ce-9591-42b8312f5408` — run_date 2026-09-19

No verdicted ticket on either side (open PRs at scrape time).

| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |
|---|---|---|---|---|---|---|---|---|---|
| alt | impl-1190b |  | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 54728 | 21577 | 772 | 37 |
| alt | impl-1199 | 1199 | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 0 | 0 | 8 | 1 |
| alt | impl-1199-2 |  | claude-sonnet-5 | xhigh | (no tier-outcomes row) | 28718 | 2056 | 31 | 9 |
| top | impl-1190 | 1190 | claude-opus-5 | xhigh | (no tier-outcomes row) | 0 | 0 | 8 | 1 |
| top | impl-1190-2 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 20611 | 1682 | 31 | 5 |
| top | impl-1199b |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 262601 | 127414 | 4387 | 151 |
| top | impl-1212 | 1212 | claude-opus-5 | xhigh | (no tier-outcomes row) | 12419 | 2 | 8 | 1 |
| top | impl-1212-2 |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 18952 | 1231 | 31 | 4 |
| top | impl-1212b |  | claude-opus-5 | xhigh | (no tier-outcomes row) | 129193 | 60316 | 1707 | 66 |
| top | impl-1217 | 1217 | claude-opus-5 | xhigh | (no tier-outcomes row) | 53974 | 18530 | 682 | 11 |
| top | impl-1284 | 1284 | claude-opus-5 | xhigh | (no tier-outcomes row) | 76011 | 37876 | 1277 | 50 |
| top | impl-1457 | 1457 | claude-opus-5 | xhigh | (no tier-outcomes row) | 76985 | 24483 | 781 | 24 |
| top | impl-1465 | 1465 | claude-opus-5 | xhigh | (no tier-outcomes row) | 115482 | 43237 | 1361 | 60 |
| top | impl-1492 | 1492 | claude-opus-5 | xhigh | (no tier-outcomes row) | 162974 | 79535 | 1990 | 94 |
| top | impl-1499 | 1499 | claude-opus-5 | xhigh | (no tier-outcomes row) | 132204 | 52232 | 1379 | 55 |
| top | impl-1505 | 1505 | claude-opus-5 | xhigh | (no tier-outcomes row) | 226641 | 105709 | 2580 | 117 |
| top | impl-1512 | 1512 | claude-opus-5 | xhigh | (no tier-outcomes row) | 161188 | 67269 | 1549 | 58 |
| top | impl-1513 | 1513 | claude-opus-5 | xhigh | (no tier-outcomes row) | 311627 | 107992 | 2756 | 139 |
| top | impl-1514 | 1514 | claude-opus-5 | xhigh | (no tier-outcomes row) | 152244 | 58404 | 1469 | 66 |
| top | impl-1604 | 1604 | claude-opus-5 | xhigh | (no tier-outcomes row) | 295156 | 66686 | 8077 | 102 |
| top | impl-1606 | 1606 | claude-opus-5 | xhigh | (no tier-outcomes row) | 175548 | 96039 | 4358 | 115 |
| top | impl-1609 | 1609 | claude-opus-5 | xhigh | (no tier-outcomes row) | 158195 | 82594 | 2421 | 103 |
