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
| 4 | Review start latency (PR opened → review dispatched) | median **8.8 min**, p90 **39.1 min** (max 425.3 min) | 75 | see below |

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

The 0.906 above no longer reproduces from the committed script, which
prints only the invocation-to-invocation figure, not the 0.867 variant.
Re-run on 2026-10-18 with the script as fixed in § "2026-10-18 — runbook
diet D6" below, it counted 85 implementer-role members in this session,
not 58, and printed 0.878. Why the count moved was not investigated.

### Signal 4 detail — review start latency

"Review dispatched" is the ticket's "workflow start": the earliest
`session_init` timestamp among review-core.js's own dispatches for a PR — its
`snapshot[-k]` member (label `snapshot`, the first agent the review workflow
dispatches) and its `review<dimension>[-k]` specialists (label
`review:<dimension>`), plus a hand-dispatched `review-pr-<n>` reviewer had
this session used that fallback (it did not). Each dispatch is keyed on the
PR it is *about*, read off the prompt's own PR interpolation: the snapshot
prompt's `gh pr diff <N> …` line (`gh pr diff <N> > "$RUN"/pr.diff` in this
session; `gh pr diff <N> -R "$REPO" > "$RUN"/pr.diff` since #3494), and the
specialist prompt's opening `Review PR #<N> (branch <branch>) for:`. That
timestamp is compared against the PR's own `createdAt` from
`gh pr list --json createdAt`.

The match keys on those prompt lines, not on a scratch path: review-core.js's
run root is `<scratch>/pr<N>`, where `<scratch>` is a caller argument
defaulting to `/tmp/review-pr-<N>`, so the path varies with whatever the
caller passed. Nor does it filter on the member-outcomes `role` column:
`compute-spend.mjs`'s `reviewer` role is a review-side *spend* bucket that
books `fix-pr-<n>` appliers by design and, through its description fallback,
`impl<N>` ticket implementers too.

Every one of the 75 merged PRs has a review dispatch in this session, and the
scan finds no reviewed PR outside them. All 75 latencies are non-negative.

An earlier revision of this note matched any `PR #<N>` anywhere in a
specialist/reviewer/finisher-role task and reported median 20.1 min, p90
2586.4 min over 86 PRs. Its 11 extra PRs (#1082, #1209, #1232, #1310, #1380,
#1409, #1413, #1502, #1530, #1559, #1581) were long-merged PRs that dispatches
about *other* PRs merely cited — every snapshot prompt quotes "PR #1409's
first review pass" as boilerplate — and they were exactly that set's 11
largest values.

Most reviews launch within minutes: 32 of 75 within 5 min, 60 within 30 min,
71 within 60 min. 32 of the 75 were launched within 5 s of another PR's
launch — the controller started those reviews in batches.

A second reading, the **first specialist fan-out** (the review actually
running), gives median 16.5 min, p90 246.8 min, max 547.7 min. Its long tail
comes from the 23 PRs whose first launch stopped at the snapshot and never
fanned out; each reached specialists only on a later relaunch (a second
snapshot for the same PR). A guard comparing before/after on this signal has
to pin which of the two events it means.

## What could NOT be derived, or is degraded

- **No Claude Code baseline.** `docs/metrics/member-outcomes.tsv` records
  the harness per row; every session from 2026-09-15 onward is `omp`. The
  most recent `claude`-harness activity in that file is a single session
  dated 2026-09-15 with essentially no rows. There is no recent Claude Code
  `/run-team` run of comparable scale (≥20 merged PRs) to baseline against —
  the before/after guard in standing decision 9 of the wayfinder map (#1768),
  a map whose notes make dual-harness (Claude Code + omp) permanent, can only
  be measured on omp today. **Missing field to close this gap: nothing
  structural** — the data would exist the next time a Claude Code `/run-team`
  run merges ≥20 PRs; it is a scheduling gap, not an instrumentation one.
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
  under- or slightly over-count by a handful of PRs at the margin. Signal 4's
  review-dispatch scan, a third route, finds exactly the same 75 merged PRs —
  none extra, none missing — though it too cannot see a PR this session
  merged without reviewing. **Missing field: a durable, timestamped
  per-PR-per-pass merge record** (something
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
run, change `SESSION_NAME`/`SESSION_DIR` and the `invocations` entries, one
per run-team invocation in that session's top-level `.jsonl`. A
`/fleet-ctl:run-team <impl> <reviewers>` user turn (`grep -n
"fleet-ctl:run-team"`) carries its implementer cap. A `/skill:run-team`
invocation is a `skill-prompt` record instead (`grep -n "skill:run-team"`);
with no arguments it runs at the default in-flight bound its own skill
prompt states. Both greps also match lines that merely quote the command,
so keep only the invocations.

## 2026-10-16 — run-team SKILL.md in tokens, before and after the runbook diet

- **Before:** 93.2k tokens, as #2929 measured it on the 257 KB
  `plugin/skills/run-team/SKILL.md` of that time (the figure
  `docs/specs/2026-10-13-runbook-diet-and-incident-policy.md` cites).
- **After:** 69,159 tokens for the 186,100-byte file #3210 left on `main`
  (`500b2738`), a ratio of 2.69 bytes per input token. Measured with omp
  18.11.2 on `anthropic/claude-opus-5-5` (`modelRoles.slow`) as the
  difference between two `omp -p --mode json --no-session --no-tools
  --system-prompt x` runs: SKILL.md plus "Reply with the single word ok."
  (72,987 input tokens: `input` + `cacheWrite`) less that sentence alone
  (3,828). `tests/skill-budget.test.mjs` records the same numbers in its
  header and holds the file at a 187,000-byte ceiling.
- **To re-read:** done, in § "2026-10-18 — runbook diet D6: controller
  `cache_creation` per merged PR and skipped-duty tickets, after the diet"
  below.

## 2026-10-18 — runbook diet D6: controller `cache_creation` per merged PR and skipped-duty tickets, after the diet

**Window.** One settled omp session,
`2026-10-17T06-37-13-170Z_01a14894-2e52-741b-a112-b6f78ae5ac8b`: one
`/skill:run-team` invocation, no arguments, at 2026-10-17T06:37:19.614Z;
last write 2026-10-18T00:00:17.874Z. Its skill prompt was 184,571
characters. It is the only settled run-team session started after #3389
merged (2026-10-16T19:42:02Z). `2026-10-14T15-40-12-075Z_01a13b12-37ab-72ac-84c0-4e3d5f16cd7b`
re-invoked the 304,412-character pre-diet skill as late as
2026-10-16T23:41:11Z and merged no PR after #3389.
`2026-10-18T00-00-53-428Z_01a14c4f-b0b4-7058-885d-1aa2f9cec757` dispatched
this measurement and is not counted.

**PRs.** The derivation script's name evidence attributed 17 merged PRs:
#3393, #3394, #3396, #3398, #3399, #3405, #3408, #3409, #3412, #3414,
#3415, #3419, #3423, #3425, #3426, #3429, #3432. The controller's own
`gh pr merge` loops in its top-level transcript merged three that no member
name embeds: #3404 and #3406 (docs PRs) and #3437 (the close-out metrics
PR), 20 in all. #3392 merged inside the window, by the maintainer
("fyi, i merged pr://3392"), and is not counted.

### Controller `cache_creation` per merged PR

| | session | Σ `usage.cacheWrite`, top-level assistant turns | n | per merged PR |
|---|---|---|---|---|
| before | `2026-09-18T15-04-10-915Z_01a0b50b-e5a3-76ce-9591-42b8312f5408` | 10,029,018 | 75 | **133,720** |
| after, the note's n | `2026-10-17T06-37-13-170Z_01a14894-2e52-741b-a112-b6f78ae5ac8b` | 852,959 | 17 | **50,174** |
| after, every PR the run merged | same | 852,959 | 20 | **42,648** |

The 17-PR row is the like-for-like one: the baseline's n counted only PRs a
dispatched member's name embeds, as that row does.

Derived by `docs/research/baseline-efficiency-derive.py` re-pointed per
Reproduction above: `SESSION_NAME` the after session, one invocation
`(2026-10-17T06:37:19.614Z, 5)`, `session_end` 2026-10-18T00:00:17.874Z.
The 5 is the in-flight bound a no-argument invocation defaults to, as that
session's skill prompt states, not the reviewer cap of the before rows'
`2 5`. The cap feeds only signal 3, which this section does not report. The
script needed two fixes to run on today's tree: `COLUMNS` now lists the 20
columns `plugin/scripts/member-outcomes.mjs` writes (it parsed 0 rows
against 15), and `gh pr list --limit 400` no longer reached #1600 (now
5000). With both, the unchanged before session again gave n = 75,
10,029,018 and 133,720. The same run printed signal 3 as 0.878, not the
0.906 above, and counted 85 implementer-role members where the Signal 3
detail counted 58; that detail now says the 0.906 no longer reproduces.

### `ready-for-human` tickets filed per run whose title names a skipped duty

**Filed by the run:** an issue whose `gh issue create` call sits in the
session's transcript tree (the top-level controller transcript or a member
transcript under the session directory), matched by issue number and
creation time. Every issue GitHub shows created inside either session's
span was found in that session's tree or in another session's.

**`ready-for-human`:** the issue carried the label at any point
(a timeline `labeled` event), not only today. Triage can apply it after
filing (#3417 was filed `needs-triage`), and a before-session ticket can
have lost it since (#1653, #1697).

**Names a skipped duty:** the title's subject is a fleet member role or the
controller, and it says that actor left out a step its role owes (did not
run it, skipped it, omitted it). A title naming a defect in a script's
code, a missing test, or work nobody owns does not count.

| side | ticket (filer) | `ready-for-human` | title | skipped duty? |
|---|---|---|---|---|
| before | #1653 (controller) | 2026-09-21 to 2026-10-09 | board.mjs:688: the skips gate's ENOENT message prints the full path twice | no: a script's message |
| before | #1657 (`fix-pr-1656`) | since 2026-09-21 | board.mjs: PORT_SPAN=512 makes cross-workspace port collisions reachable at realistic workspace counts | no: a script's constant |
| before | #1697 (`impl-1218`) | 2026-09-22 to 2026-09-29 | betweenPhrases: a bound matching before an intact end anchor throws 'slice end anchor moved' — fix the misattributing message; correct staleness pin's reflow header | no: a helper's message |
| after | #3417 (`fix-pr-3412`) | since 2026-10-17 | metrics-refresh drain unlinks the pending ticket-features file while a router append is in flight, losing the row | no: a script's race |

**Result: 0 before (over the before session's three invocations), 0
after (over one).** The before run filed no `ready-for-human` ticket
naming a skipped duty by this rule, so this count had nothing to fall
from.

Widening "filed per run" to any session filing during the after run's span
adds #3428 ("run-team/SKILL.md sits 1 byte under its 187,000-byte ceiling
and nothing owns the cut toward D1's 41,000 target", filed from
`2026-10-17T06-37-52-105Z_01a14894-c669-75df-b9a7-734a481320c9`) and #3430
("briefText reads only a ## Agent Brief comment: rulings under other
headers never reach the Pull", filed from
`2026-10-17T09-03-39-877Z_01a1491a-4165-76ab-b96e-16016ba40fb7`). Neither
names a skipped duty: one is unowned work, the other a function's code.
The before run's span holds no other session's issue.
