# Baseline: the four efficiency signals (issue #1769)

## Question

For the most recent run(s) totalling ≥20 merged PRs: fleet `cache_creation`
per merged PR, controller `cache_creation` per merged PR, implementer-slot
idle ratio, and review start latency (PR opened → review dispatched).

## Window measured

One continuous omp session:
`~/.omp/agent/sessions/-dev-fleet-plugin/2026-09-18T15-04-10-915Z_01a0b50b-e5a3-76ce-9591-42b8312f5408`
(top-level transcript `…5408.jsonl`, 49.6 MB). It is the **most recent
settled session** on this workstation — its last write is 2026-09-23
06:26:29Z and nothing has appended since, so it will not move under a
re-scrape the way an in-flight session would.

`docs/metrics/member-outcomes.tsv` (the tracked file) had already scraped
part of this session (505 of its rows, dated through `run_date=2026-09-19`)
but the session kept running afterward. I re-ran the project's own
`plugin/scripts/member-outcomes.mjs` against the session directory into a
scratch file (`/tmp/…mo.tsv`, **never** the tracked TSV) to pick up the whole
thing: 1238 rows.

The session's own transcript records three `/fleet-ctl:run-team` invocations
(the literal user turns, `<uuid>.jsonl`):

| timestamp (UTC) | invocation | implementer cap | reviewer cap |
|---|---|---|---|
| 2026-09-18T15:04:56.850Z | `/fleet-ctl:run-team 3 6` | 3 | 6 |
| 2026-09-19T21:38:11.735Z | `/fleet-ctl:run-team 2 5` | 2 | 5 |
| 2026-09-22T17:47:21.419Z | `/fleet-ctl:run-team 2 5` | 2 | 5 |

**n = 75 merged PRs**, `#1600`–`#1705` (full list in the derivation script's
output), directly attributed to this session by name evidence — every one of
the 75 has at least one dispatched member in this session whose canonical
name embeds that PR number (`fix-pr-<n>`, `finisher-pr-<n>`, `review-pr-<n>`
— via `member-record.mjs`'s own `parseMemberName`; or `mergebot<n>` /
`merge-bot-w<k>-<n>` / `fixapplier<n>`, three additional naming variants this
session actually used that `parseMemberName` does not parse) — and confirmed
merged via `gh pr list --state merged`. Earliest of the 75 created
2026-09-18T15:56:40Z, earliest merged 2026-09-18T16:56:52Z, latest merged
2026-09-22T21:30:06Z. This comfortably clears the ≥20 floor the ticket asks
for.

Full method and script: `docs/research/baseline-efficiency-derive.py`
(reproducible only on a machine holding this session's transcripts — see the
script's own docstring and Caveats below).

## Results

| # | Signal | Value | n | Method |
|---|---|---|---|---|
| 1 | Fleet `cache_creation` / merged PR | **1,078,459** (total 80,884,397) | 75 | Σ `tokens_cache_create` over every dispatched member in the session with `role != memory`, ÷ n |
| 2 | Controller `cache_creation` / merged PR | **133,720** (total 10,029,018) | 75 | Σ `usage.cacheWrite` over the session's own top-level assistant turns (the controller kernel, never a subagent file), ÷ n |
| 3 | Implementer-slot idle ratio | **0.906** (90.6%) | — | see below |
| 4 | Review start latency (PR opened → review dispatched) | median **20.1 min**, p90 **2586.4 min** (~43.1 h) | 86 PRs | see below |

Fleet spend is ~8.1× controller spend for this session (81M vs 10M
`cache_creation` tokens) — consistent with `compute-spend.mjs`'s own framing
that the controller supervises rather than does the heavy lifting.

### Signal 3 detail — implementer idle ratio

For each implementer-role member (58 in this session, role from
`classifyRole` in `plugin/scripts/compute-spend.mjs`), I read its own
transcript's first and last `timestamp` line directly — its live interval —
and swept those intervals against the declared cap, piecewise per
`/run-team` invocation (cap 3 from invocation 1 until invocation 2, cap 2
from invocation 2 through session end):

| segment | wall span | avg live implementers | cap | idle ratio |
|---|---|---|---|---|
| `/run-team 3 6` window | 30.6 h | 0.34 | 3 | 0.886 |
| `/run-team 2 5` × 2 window | 80.8 h | 0.17 | 2 | 0.914 |
| **time-weighted overall** | 111.4 h | — | — | **0.906** |

A tighter variant — bounding each segment by the *observed* implementer
activity envelope (first dispatch to last completion among that segment's
own implementers) instead of invocation-to-invocation wall clock — still
reads idle ratio 0.867 overall (0.592 for segment 1's 8.5 h envelope, 0.900
for segment 2+3's 69.9 h envelope). Either way the finding is the same
order of magnitude: implementer slots sat empty roughly 87–91% of the time
this session was in `/run-team`, most of the wall-clock time was spent on
review/fix/finish/merge work rather than fresh implementer dispatch, which
is exactly the shape of inefficiency the wayfinder map's destination
(off-turn reviews, dispatch-on-label merging) targets.

### Signal 4 detail — review start latency

"Review dispatched" is a proxy: the earliest `session_init` dispatch
timestamp, among this session's `specialist`/`reviewer`/`finisher`-role
members, whose task text names a given PR — either via the
`.fleet/scratch/pr<N>` path `review-eval.mjs` writes for the snapshot step
(review-core.js's first specialist), or a bare `PR #<N>`. That is compared
against the PR's own `createdAt` from `gh pr list --json createdAt`. 86 PRs
matched (a slightly larger set than the 75 directly-merge-attributed PRs
above, because a couple of PRs this session reviewed were merged by a
neighboring short-lived session, or the match is on a PR still awaiting
merge at the time of a later data point — see Caveats). All 86 had
non-negative latency (dispatch after creation, as expected).

The wide median-to-p90 spread (20 minutes vs 43 hours) is direct evidence of
the staging behaviour the wayfinder map exists to retire: most PRs get
reviewed almost immediately, but a meaningful tail waits for a
maintainer-chosen staging batch to be assembled before their review starts.

## What could NOT be derived, or is degraded

- **No Claude Code baseline.** `docs/metrics/member-outcomes.tsv` records
  the harness per row; every session from 2026-09-15 onward is `omp`. The
  most recent `claude`-harness activity in that file is a single session
  dated 2026-09-15 with essentially no rows. There is no recent Claude Code
  `/run-team` run of comparable scale (≥20 merged PRs) to baseline against —
  the dual-harness guard in standing decision 9 can only be measured on omp
  today. **Missing field to close this gap: nothing structural** — the data
  would exist the next time a Claude Code `/run-team` run merges ≥20 PRs; it
  is a scheduling gap, not an instrumentation one.
- **n=75 is a lower bound built from name evidence, not a ledger.**
  `.fleet/ledger.md` (the live ledger) and every archived
  `.fleet/ledger.*.md` have **no rows at all** for PRs #1600–#1705 — the
  ledger's row-set for that stretch has since been reaped/superseded (the
  live ledger currently jumps from PR #1237-era rows, ~2026-09-06, straight
  to #1366+, ~2026-09-10, then to #1607+, ~2026-09-21). So the merged-PR set
  for this window had to be reconstructed from dispatch names and cross-
  checked against `gh`, rather than read off an authoritative per-run
  ledger. A broader corroborating scan (every merge-bot dispatch's own task
  text, filtered to PR numbers `gh` confirms merged in the window) finds 73
  of the same 75 by a completely different route, which is reassuring but
  not a proof of completeness — the wave-batch merge-bot dispatches
  (`merge-bot-1`…`merge-bot-12`, `merge-bot-w3`…`merge-bot-w8`, `wave1`–
  `wave3`) list several PR numbers each as "considered in this pass," not
  necessarily "merged in this pass," so a name-based reconstruction can
  under- or slightly over-count by a handful of PRs at the margin. **Missing
  field: a durable, timestamped per-PR-per-pass merge record** (something
  `merge-gate.sh`/the merge bot's own report could emit) would remove this
  reconstruction step entirely; today it is implicit in the bot's transcript
  prose only.
- **Idle ratio's wall-clock denominator conflates "loop actively waiting for
  a slot" with "the controller was not running at all"** (nights, breaks
  between the three invocations). I reported both the full invocation-to-
  invocation figure (0.906) and a tighter, activity-envelope-bounded figure
  (0.867) precisely because the transcripts contain no explicit
  loop-was-live/loop-was-dormant marker to settle this cleanly. **Missing
  field: a heartbeat/liveness timestamp series** (something `fleet-tick.mjs`
  could already be positioned to emit, given its existing heartbeat) would
  let a future measurement bound idle ratio to genuinely-active loop time
  only.
- **Review start latency's PR set (86) is not exactly the merged-PR set (75)
  used for signals 1–2.** The `.fleet/scratch/pr<N>` / `PR #<N>` text match
  is per-PR, not per-session-attribution, so it also catches a few PRs whose
  review this session dispatched but whose final merge (or ledger
  attribution) belongs to a neighboring session in the same window. I did
  not attempt to force the two sets to match, since latency is a legitimate
  per-PR measurement independent of which session's spend total it should be
  pooled into.

## Reproduction

```
cd /Users/chris/dev/fleet-plugin
python3 docs/research/baseline-efficiency-derive.py
```

Requires: `plugin/scripts/member-outcomes.mjs` runnable from the repo root
(node), `gh` authenticated against `feigi/fleet-plugin`, and the named omp
session's transcript tree present under
`~/.omp/agent/sessions/-dev-fleet-plugin/` on the machine running it — this
last part is not portable off this workstation. To baseline a *different*
run, change `SESSION_NAME`/`SESSION_DIR` and the three `invocations` entries
(read them straight off that session's own `/fleet-ctl:run-team <impl>
<reviewers>` lines, `grep -n "fleet-ctl:run-team"` against its top-level
`.jsonl`).
