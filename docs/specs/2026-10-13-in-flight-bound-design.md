# The In-flight bound — one argument, one hold, a flow guard

Date: 2026-10-13
Status: decided on map #2870 (grilling 2026-10-05 and 2026-10-09; closing grilling 2026-10-13); accepted as ADR 0031, which amends ADR 0012 and ADR 0013 on their `**Status:**` lines; handed to `/to-tickets` (§ 12).
Map: feigi/fleet-plugin#2870. Decision tickets: #2873, #2874, #2875; research: #2871, #2872; closing: #2876.
ADRs: `docs/adr/0031-in-flight-bound-replaces-the-implementer-and-reviewer-caps.md`; amends `docs/adr/0012-slot-based-loop-no-waves.md` and `docs/adr/0013-automatic-supply-relabel-by-cause.md` (Status lines only, § 9).
Supersedes in part: `docs/specs/2026-09-24-slot-based-fleet-loop-design.md` § 3 (the reviewer cap, `--max-reviews`) and § 6 §4 (the implementer row's `AT CAP` and the review-backlog gate); the dated spec is left as written.
Relates to: `docs/research/in-flight-baseline.md`, `docs/research/in-flight-lead-share.md`, `docs/research/in-flight-cycle-time-stages.md` (each reproduced by the `-derive.mjs` script beside it), `docs/research/baseline-efficiency.md`, `docs/research/omp-review-offturn.md` § (d).
Line numbers below are against `origin/main` `bd4afac8` (2026-10-13) and drift; re-grep the anchor phrase before editing. Tests live in `tests/`, not beside the scripts.

`ADR 0031 § N` below names that ADR's `## Decision` point N; `ADR 0031 § Guard` is its `## Guard — chosen before any further data`.

## Why (measured)

The map's own premises: the fleet is throttled by two caps and one hold, and
no signal in that design is the number of tickets between Claim and merge.
`fleet-tick.mjs` takes `--implementer-cap` (default 2), `--reviewer-cap`
(default 6) and `--max-reviews`; the implementer row's `AT CAP` fires at the
implementer cap; `HOLD (review side saturated)` fires only when at least one PR
is owed a review AND no reviewer slot is free. The cockpit already counts the
proposed set as `claimed`, and nothing reads it to gate a Pull. ADR 0012's
guard signal 3 (implementer-slot idle ratio) reads **0.906** and must fall; a
throttle raises it by design, so that guard and any bound cannot both stand.

Population: the 400 most recently merged PRs, #1826–#2865, created
2026-09-25T18:58:33Z → 2026-10-04T20:55:15Z, read off GitHub only
(`docs/research/in-flight-baseline.md`; re-read cold 2026-10-05, every table
identical). **Every Pull in it ran under an implementer cap of 2.**

| Measure | Value |
|---|---|
| In-flight depth (open PRs), time-weighted, while ≥ 1 PR open | mean **5.02**, max **15** (2026-10-04T09:13Z) |
| Depth already open when a PR was created | median / p75 / p90 **5 / 7 / 9** |
| Cycle created → merged | median **1.38 h**, p75 2.37 h, p90 **5.23 h** |
| Cycle median by depth at arrival 0–2 / 3–5 / 6–9 / 10+ | **1.16 / 1.27 / 1.62 / 1.82 h** |
| Last `ready-to-merge` → merged | median **15 min**, p90 65 min, 6.8 % over 90 min (ADR 0007 guard 1 not tripped) |
| Throughput | **2.72** merged PRs per active UTC clock hour (147 of 218.7 wall hours); 40 per active day |
| Little's law closes | 5.02 ÷ 1.89 per open-time hour = 2.65 h = mean cycle |

Where cycle time goes (`docs/research/in-flight-cycle-time-stages.md`, 200-PR
window): from the 3–5 to the 10+ depth bucket, open → first review evidence
*falls* 28 → 21 min while first `ready-to-merge` → merged rises 16 → 31 min and
evidence → first label rises 21 → 34 min — the extra time sits after the
review. Label → merged tracks how many lower PRs are already labelled ahead:
12 min / 16 min / 27 min / 1.58 h at 0 / 1 / 2–3 / 4+ (Spearman 0.50), at a
flat 8–9 min per merge; lower PRs merely open carry nothing (0.08). On the
400 window the ready-queue depth at label time predicts label → merged at ρ
0.48 against 0.14 for depth at arrival, so **a bound trims that queue only by
trimming arrivals; it does not speed the merge gate.** About half of the
depth↔cycle gradient is which day the PR arrived (ρ 0.20 → 0.06 demeaned by
creation day). Genuine label churn is 8 of 200 (4 %); 32 of 36 relabels are a
4-s re-pin flip. "Depth is a symptom of a slow merge side" was tried and
refuted: merge throughput is higher at depth (ρ +0.32).

The default, derived with the implementer phase counted
(`docs/research/in-flight-lead-share.md`, L = 19.3 min, the median T_impl; a
Pull happens L before the PR is created; held = other tickets In flight at the
Pull ≥ B), window #1826–#2865:

| B | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 12 |
|---|---|---|---|---|---|---|---|---|
| Held share of Pulls, % | 80.5 | **68.3** | 54.5 | 40.0 | 28.8 | 22.0 | 17.3 | 8.0 |
| Held Pulls, of 400 | 322 | 273 | 218 | 160 | 115 | 88 | 69 | 32 |

At B=8 98 of the 115 held Pulls fall on 10-03/10-04; held vs not-held cycle
median at B=8 is 1.56 vs 1.30 h. With 10-03/10-04 Pulls removed (n = 246) B=5
holds 52.4 % (129). The baseline's 22.5 % at B=8 (90 of 400) undercounted
because it measured open-PR depth only. Mean In flight with the implementer
phase counted is **5.6** (5.56). Ceilings: Little's law at B=5 gives
5 ÷ (1.27 h + 0.32 h) ≈ **3.1** merges/h against 2.7 measured per active hour;
the merge gate saturates near 10–11 In flight (μ 7.12 merges/h × (T_impl 19.3
min + W₀ 1.16 h) ≈ **10.5**), so a bound past that buys nothing. The review
side is about **84 %** of cache-write tokens, fanning out to 1 snapshot + up to
6 specialists + 2 refuters per finding. Caveats carried, not resolved: every
Pull in the window ran under cap 2, so arrivals with no implementer cap and
the collision cost at ≥ 5 concurrent implementers are unmeasured — the guard
(§ 8) judges the default after the cutover. The baseline script's default
`--n 400` window has moved (#1907–#2963 on 2026-10-09): reproduce the
published numbers with `--after 2026-09-25T18:58:33Z` (§ 8.4).

omp's semaphore (`omp://tools/task.md`, quoted in
`docs/research/omp-review-offturn.md` § (d)): one session-scoped `Semaphore`,
resized in place from `task.maxConcurrency` (default 32, `0` unbounded),
**queues at the ceiling rather than refusing**, one per session so a member's
own fan-out runs on its own counter. It counts live members, not tickets. The
fleet reads and writes it nowhere today.

The guard's own history: over 2026-09-25T18:58:33Z → 2026-10-09, consecutive
20-PR windows (79 pairs, offset 5) move the "wrong" way **53 %** of the time
for cycle and **48 %** for throughput with no change at all. The p90 band is
**×2.23** for cycle and **×0.68** for throughput (as of 2026-10-09; recomputed
at the cutover, § 8.2).

## Vocabulary

Defined in `CONTEXT.md` § Loop (written by the closing ticket #2876), wording
ruled in #2874 and reproduced verbatim:

**In flight**:
A ticket between its Claim and its PR's merge — an implementer live or owed a
replacement on it, or an open PR closing it. A PR closing nothing is never in flight.
_Avoid_: WIP, open work, backlog

**In-flight bound**:
The most tickets a run lets be In flight at once — fixed for the run, set by
`/run-team`'s one argument. Reaching it holds every Pull until a merge brings the
count below it; reviewers, finishers and the merge bot never slow for it.
_Avoid_: WIP limit, PR cap, throttle, backpressure, implementer cap, reviewer cap

In this spec `n` is the In-flight count, `B` the bound, `i` the part of `n`
that is tickets counted through the ledger and `p` the part that is open
issue-closing PRs; `n = i + p`. **Claim**, **Pull**, **Shortlist**,
**Exclusion** and **Pass** are as in the 2026-09-24 spec's Vocabulary.

## 1. The bound and the argument

Source: #2873; map standing decisions 2, 3, 5; ADR 0031 § 1, § 2.

**1. The signal is the In-flight count; the lever is one hard bound on it.** n
is read against B. Reaching it holds every Pull until a merge brings n below
B; Pulls resume as merges land. The lever is the implementer row's `HOLD`
(§ 3) and nothing else: reviewers, finishers and the merge bot never slow for
it. The signal is not review-side depth, not merge-side latency or queue
depth, not an arrival-vs-merge rate (ADR 0031 § Rejected alternatives). The
bound is the fleet's operating level, not a burst ceiling: with live
implementers = B − In-flight PRs, the fleet fills to B whenever the Shortlist
has work, so "a cap in disguise" is the design.

**2. One argument: `/run-team [in-flight]`.**

- `argument-hint: "[in-flight]"` replaces `"[implementers] [reviewers]"`.
  `$ARGUMENTS` is optional, one positive integer, **default 5**.
- The tick takes one flag, `--in-flight <B>`, replacing `--implementer-cap`,
  `--reviewer-cap` and `--max-reviews`. Declared in `OPTIONS` first,
  `"in-flight": { type: "string", default: "5" }`, so the default goes through
  the same guard as a passed value. **That default is the only place the
  number 5 lives in code**; SKILL.md states it in the arguments line and in one
  Defaults paragraph (§ 10), and `tier-roles.mjs` takes the resolved `B` as a
  required argument (§ 6).
- The controller passes `--in-flight <B>` on every tick when `$ARGUMENTS` set
  it, and never otherwise — the rule the two caps followed.
- **Fixed for the run, operator-overridable, never adapted live in v1.** The
  bound limits how far ahead the fleet implements, not how fast: Pulls restock
  as merges land. No formula in code. The derivation is a check, re-run under
  the existing rule — once ≥ 20 PRs have merged under it, never from one run's
  rows (§ 8.4). This settles the map's fog item "adapts live?" for v1: no.
- **Floor and ceiling.** `positive("in-flight")` is the digits-and-≥1 rule
  already in `options()`: `--in-flight 0` exits 2 with
  `--in-flight must be at least 1, got 0` (draining is how you stop
  implementing); `x`, `3 6` (passed as one value) and the empty string exit 2
  with `--in-flight must be a non-negative integer, got '<raw>'`; stdout empty in
  every refusal. **No upper cap.** No notice at B = 1. The operator-facing
  ceiling is the semaphore notice (§ 6).
- **The old flags are removed, not tolerated.** `parseArgs({ options: OPTIONS })`
  is strict (Node's default), so an unknown option throws and `die()` exits 2.
  Measured on `bd4afac8` with a flag already deleted once:
  `node plugin/scripts/fleet-tick.mjs --implementers 1` prints
  `fleet-tick: Unknown option '--implementers' — accepted: --implementer-cap, --reviewer-cap, --max-reviews, --fold-unchanged, --state, --liveness-impl, --liveness-fix-pr, --liveness-finisher, --liveness-merge-bot, --liveness-review`
  and exits 2. After T1 the same call with `--implementer-cap 3` prints the
  same shape with the list
  `--in-flight, --fold-unchanged, --state, --liveness-impl, --liveness-fix-pr, --liveness-finisher, --liveness-merge-bot, --liveness-review`.
- `options()` returns `{ bound, fold, state, liveness }`; `bound` replaces
  `implCap`, `reviewerCap` and `maxReviews` everywhere they were read.
- **Inheritance.** A run that folds in more open issue-closing PRs than B
  starts fully held: no Pull until merges bring n below B, while reviewers,
  finishers and the merge bot work the inherited PRs. Phase 0 prints no
  separate line; the first tick's `HOLD (in-flight 7/5)`-style row is the
  notice (§ 3).

**Why 5 (the rationale SKILL.md's Defaults paragraph carries, § 10).** The
level is set by **load**, not throughput. B caps live review units (≤ open PRs
≤ B), and the review side is ~84 % of cache-write tokens, fanning out to 1
snapshot + up to 6 specialists + 2 refuters per finding. 5 keeps worst-case
review concurrency below the old reviewer cap (6) and the start-of-run burst
at 5 implementers; it sits near the measured mean In flight (5.6) and the
operator's hand-held 2026-10-08 run (open PRs ≤ 4 + implementers). By Little's
law B=5 allows ≈ 3.1 merges/h against 2.7 measured; the merge gate saturates
near 10.5, so raising B past that buys nothing. **8 was rejected**: peak review
concurrency above today's, for a throughput gain the backlog does not show it
needs. At B=5 68.3 % of past Pulls would have been held: the bound will bind
often, and that is the operating level, not a fault.

Tests (T1, `tests/fleet-tick.test.mjs`): `CLI: --in-flight defaults to 5 and
prints n/B`; `CLI: --in-flight must be a positive integer, no upper bound`;
`CLI: the three retired flags refuse as unknown` (§ 10).

## 2. In flight — what counts

Source: #2874 decisions 1–5; ADR 0031 § 3.

**Definition.** n = the open PRs that close an issue, plus the claimed tickets
that have a live implementer — or are owed a replacement — and that no open PR
closes yet. One PR counts once, and so does one ticket: the moment an
implementer has opened its PR but not yet reported, and a PR that closes two
issues, each count one. **The count reads `gh` and the ledger on every tick,
never the Phase-0 fold**: standing decision 7's "once folded in at phase 0" is
dropped.

**Computation** (`deriveRun`, pure; reuses its `prs`, `closed` and the existing
`newest` array):

```
prsIn   = prs.filter(p => p.closingIssuesReferences.length > 0)        // p
closing = Set of every .number in every prsIn[].closingIssuesReferences
ledger  = newest.filter(m =>                                           // i
            (m.outcome === null                                        // live
             || ((m.outcome === "killed" || m.outcome === "tier-mismatch")
                 && !closed.has(m.number)))                            // owed, issue open
            && !closing.has(m.number))                                 // no open PR closes it
n = prsIn.length + ledger.length
```

- "Closes an issue" is GitHub's own linked set, `closingIssuesReferences`, the
  test `reviewDue` already uses (`fleet-tick.mjs:843`) — never a keyword regex
  over the body. `openPrs()` already requires the field to be an array; T1
  also requires each element to carry an integer `number` and refuses the tick
  otherwise (`gh pr list did not return …`), the same "no silent default" rule.
- `newest` is the existing selection (`fleet-tick.mjs:757`): the latest `impl-`
  member of each ticket, so a replacement `impl-<N>-b` supersedes `impl-<N>`.
- `closed` is the existing deriveRun parameter: ticket numbers the caller
  probed CLOSED. T1 widens `main()`'s probe (`closedTickets`, `:1283`, called
  at `:1406`) from the tier-mismatched members to every member `deriveRun`
  reports as `owedReplacement` (the newest member settled `killed` or
  `tier-mismatch`, no open PR closing its ticket) plus the tier-mismatched
  ones, one `gh issue view <N> --json state` per ticket, deduped. The failure
  rule is the probe's own: a probe that cannot answer is disclosed on stderr
  and **the ticket stays counted** — an unreadable state never uncounts.
- `deriveRun` returns `inFlight` (n), `inFlightImpl` (i), `inFlightPrs` (p) and
  `owedReplacement` (member names). `implLive` stays: `main()`'s `over` reads
  it (`:1470`).

**Edge cases.** Every case #2874 ruled, and the corners it implies:

| Case | Counts? | Why |
|---|---|---|
| Open PR that closes an issue (this run's) | **yes**, 1 (p) | between Claim and merge; the unit is the PR |
| One PR closing two issues | **yes**, once | the unit is the PR; a live implementer on either issue is absorbed into it |
| Claimed ticket whose newest `impl-` member is live (bare token), no open PR closes it | **yes**, 1 (i) | between Claim and PR |
| Implementer has opened its PR but not yet reported (member live, open PR closes its ticket) | **yes**, once — as the PR | the PR absorbs the ticket (`closing.has`); no double count at the hand-off |
| Replacement owed: newest `impl-` member settled `killed` or `tier-mismatch`, issue open, no open PR closes it | **yes**, 1 (i) | the claim stands and a replacement is owed. The replacement (`impl-<N>-b …`) is **not a Pull** and the bound never holds it: neither the tick nor `ledger.mjs dispatch` reads B, and because the ticket is already counted n stays ≤ B and no Pull takes its slot |
| The same ticket once the replacement is dispatched | **yes**, the same 1 | the newest member is now live; n does not move |
| Replacement owed but the issue is CLOSED (probed) | no | there is nothing left to replace; the same probe lifts the tier-mismatch hold |
| "Implementer blocked or ambiguous mid-implementation": newest `impl-` member settled `blocked` | **no** | the slot is freed, `in-progress` stays, and the ticket waits for a human (§ 7); no replacement is owed |
| Newest member settled `bailed` or `released` (derived) | no | the ticket went back to the tracker / the claim is released; not live, not owed |
| Newest member settled `PR#M`, PR M merged or closed unmerged (derived) | no | PR M is not on the open list; nothing is between Claim and merge |
| Newest member settled `PR#M`, PR M open and closes an issue | **yes**, 1 — as the PR | row 1 |
| PR on `conflict-hold:#<pr>` | **yes** | held or halted PRs are still between Claim and merge; the full stop is accepted (§ 3) |
| PR on `held-behind:#<lower>` | **yes** | same |
| PR whose finisher settled `halted:past-pin` (any `halted:<cause>`) | **yes** | same |
| PR whose latest dispositions verdict is `dispositions-escalate` | **yes** | same |
| PR whose finisher settled `failed` or `killed` | **yes** | same |
| Exclusion row (`excluded · behind-pr:#M` / `behind-issue:#M`) | **no** | it gates the claim: there is no claim and no member. The PR it waits behind counts in its own right if that PR closes an issue. (The count reads members, never `claimed`, which an Exclusion joins.) |
| Inherited issue-closing PR (a prior run's) | **yes**, from the first tick | the count reads `gh`, not the fold |
| Chore PR closing nothing, this run's or inherited | **no** | never In flight; the filter is the tick's review-due test |
| Human-authored issue-closing PR | **yes** | `openPrs()` filters neither author nor draft, and the fleet reviews and merges it |
| Draft issue-closing PR | **yes** | same |
| Two open PRs closing the same issue (derived) | **yes**, 2 | the unit is the PR (`p` is `prsIn.length`); a second PR on one ticket is a second thing a merge must clear |
| Review, fix-applier, finisher and merge-bot members | no | they are not tickets; a PR holds at most one live review unit, so units ≤ open PRs |

`failed` is not an `impl` outcome (`ledger-grammar.mjs:27`: `PR#M | bailed |
released | killed | tier-mismatch`), so no row settles an implementer
`=failed`; #2874's ticket wording "settled `=failed` implementer" has no case.

Tests (T1): the `deriveRun` cases in § 10's ADD list, one per table row;
`inFlight === inFlightImpl + inFlightPrs` for every fixture.

## 3. The hold

Source: #2874 decisions 6, 7, 9, 11; ADR 0031 § 4.

**Row.** The implementer row prints `n/B` — actual = In flight, target = the
bound — on every action, and the action is

```
HOLD (in-flight <n>/<B>)
```

whenever **n ≥ B**. It **replaces the implementer row's `AT CAP` outright**
(`fleet-tick.mjs:195-196`): one condition, one wording, whatever mix of
members and PRs makes up n. `acts: false` — a held tick is quiet.

```
implementers 7/5 → HOLD (in-flight 7/5)   (implementers=2 prs=5 unclaimed=3 supply=57)
```

**Detail**, on every implementer action (it is the row's detail, set by
`mkRow` at `:171`):

```
implementers=<i> prs=<p> unclaimed=<k> supply=<s>[ shortlist=<status>][ specs-dropped=…]
```

`i` and `p` are § 2's parts (`n = i + p`); `unclaimed` and `supply` are as
today (`supply` prints `?` for an unreadable list); the `shortlist=` and
`specs-dropped=` tails keep their current wording. **`unreviewed=` is deleted**:
it fed only the saturation gate (§ 4). A tier hold's clearing step still
follows the counts after ` — `.

**Rank.** The row's branches, first match wins:

1. the main-checkout overlay (`mainCheckoutHold`, over every dispatching row);
2. `HOLD (draining)`;
3. `HOLD (tier mismatch …)`;
4. `HOLD (tier unchecked …)`;
5. `HOLD (in-flight <n>/<B>)`;
6. `PULL`; then `SUGGEST /triage, hold idle`.

The tier holds need the controller to act (`acts: true`), so they stay visible
while the bound also holds. **The rank only decides which `HOLD` row prints;
it is never a guard remedy** (§ 8).

**Pull count: one head per free slot**, `heads.slice(0, B − n)`, as the old
`heads.slice(0, deficit)` (`:208`). The start-of-run and post-Pass burst — up
to B Pulls back to back — is accepted: Phase 1 is serial, the Pull's
collision check excludes overlapping tickets, and omp's `task.maxConcurrency`
is the operator's ceiling on live members (§ 6).

**Replacements are not Pulls and never bound-held** (§ 2). The tick has no row
for them and the bound has no reader other than the implementer row.

**The inherited run's first tick.** Seven open issue-closing PRs folded in
from a prior run, B = 5, nothing claimed:

```
implementers 7/5 → HOLD (in-flight 7/5)   (implementers=0 prs=7 unclaimed=… supply=…)
reviewers    0/5 → DISPATCH review PR#… PR#…   (reviews=0 fix-pr=0 fix-due=0 review-due=7)
```

No Pull until merges bring n below 5; reviewers, finishers and the merge bot
work the inherited PRs. The row is the only notice; no record, no Phase-0
line.

**The full stop.** A fleet whose every In-flight slot is held by a PR nothing
can merge without a human stops implementing. **No escape hatch in v1.** The
Stall report names whose move it is through its owner line
(`fleet-state.mjs`'s `stallOwner`), and the tick's `HOLD (in-flight n/B)` row
names the count; nothing else ships (§ 10, § Not yet specified).

**No record.** Nothing beyond the printed line and the tick's state file
(`heartbeat.json`'s `quiet`, `digest`, `seen`). Every guard signal reads
GitHub (§ 8), so none needs the tick's held time. If a later guard needs it,
the record question reopens there.

**Heartbeat: no new rule.** A held tick is quiet (`acts: false`), so `quiet`
increments and the beat backs off toward `DEFAULT_CEILING_S` (1200 s). During
a Pass each rebased candidate's CI-terminal event wakes the controller within
about one CI cycle, and the Pass report wakes it at the end; that tick prints
`PULL`, which resets the back-off. Worst case is a PR closed without merging,
which waits for the 20-min ceiling.

Tests (T1): `implementers: HOLD (in-flight n/B) at n ≥ B …`; the rank case;
the Pull-count case; the detail case; `CLI: an inherited run over B starts
fully held`; `CLI: a held tick is quiet` (§ 10).

## 4. The reviewer row

Source: #2874 decision 8; ADR 0031 § 5.

With no reviewer cap the row **dispatches every fix and every review that is
due**, fixes first (finish what is started), each as one line naming all its
PRs, exactly as today's `DISPATCH fix-pr PR#a PR#b` / `DISPATCH review PR#c`:

- `reviewers(s)` loses `free`, `s.reviewerCap` and `s.maxReviews`: `fixes =
  s.fixDue`, `reviews = s.reviewDue`; it returns `{ rows, conflictRows }` — no
  `left`.
- It prints **`<units>/<B>`**: `units = reviewsLive + fixLive`, target `B`. A
  PR holds at most one live review unit, so units ≤ open PRs; with the bound
  capping open issue-closing PRs that is ≤ B by construction, and **an
  inherited run over B shows the overflow honestly** (`7/5`).
- Detail: `reviews=<r> fix-pr=<f> fix-due=<d> review-due=<v>` (the trailing
  `max-reviews=<n>` is deleted).
- Unchanged: the finisher repair row (`DISPATCH finisher PR#…`), `ESCALATE
  unlabelled`, `CONFLICT`, `ESCALATE conflict` (they never waited on a slot);
  `IDLE OK` when nothing is due and no unlabelled row printed.
- **Deleted**, with their tests and prose pins: `HOLD (review side saturated)`
  (`fleet-tick.mjs:206`, unreachable once no reviewer cap exists, and it
  throttled on live members, not tickets); `HOLD (max-reviews <n> in flight)`
  (`:274`); the reviewer row's `AT CAP` (`:273`). `reconcile()` no longer
  computes the reviewer rows first: the implementer row has nothing to read
  from them (`:79-98`, `:278`).
- **The merge-bot row's `AT CAP`** (`:284`, cap 1 by invariant, ADR 0007)
  stays.
- Review concurrency is bounded by the bound alone: ≤ B live units, each a
  member whose own fan-out (1 snapshot + up to 6 specialists + 2 refuters per
  finding) runs on its own semaphore counter (§ Why). Worst case at B=5 is
  below the old reviewer cap of 6.
- The dangling-review probe (`finishedReviewPrs`, `:1310`) stays: it keeps
  `units` honest — a `review=` token on a MERGED or CLOSED PR is not a unit;
  a probe that cannot answer keeps the unit counted and is disclosed.

Tests (T1): `reviewers: every due fix and review is dispatched, no cap`;
`reviewers: the row prints <units>/<B>`; `reviewers: no state prints AT CAP,
HOLD (max-reviews …) or HOLD (review side saturated)` (§ 10).

## 5. Shortlist refresh

Source: #2874 decision 10; ADR 0031 § 6 (amends ADR 0013 § 5).

The low-water mark is **unclaimed < B**. B is the most a full deficit can Pull
(n = 0 Pulls B), so § 5's "cap, not cap − live" buffer carries over with B as
the cap. **No refresh runs while the bound holds (n ≥ B)**: a refresh while
held cannot feed a Pull, and skipping it keeps B=5 from refreshing on every
tick while supply is thin. The skip covers every trigger — the low-water mark,
a missing, unparsable or empty list, and a lifted Exclusion premise — because
the first tick with n < B runs the refresh and the Pull in the same tick:
`main()` refreshes before `reconcile()`, so nothing a held tick skipped is
lost.

- `refreshWhy({ draining, held, status, entries, unclaimed: k, bound })`
  (`:939`) returns `null` when `draining !== null` **or** `held`, else
  `shortlist <status>` (status not `ok`), `shortlist empty`, or
  `unclaimed <k> < in-flight bound <B>` (the last replaces
  `unclaimed ${k} < cap ${implCap}`, `:943`). `held` is `run.inFlight >=
  bound`, **whichever `HOLD` row prints** — a tier hold printing above the
  bound does not make the refresh worth running.
- `main()` (`:1423-1425`) skips `liftedPremise(...)` under the same condition
  it already skips it for `draining`.
- While held no `REFRESHED` / `REFRESH FAILED` row prints; `shortlist=<status>`
  in the implementer detail still reports a missing list.
- Prose: § Queue depth's table row "below the cap, missing or empty" and Phase
  0 step 2's "below the implementer cap" read "below the In-flight bound" and
  say the tick never refreshes while `HOLD (in-flight <n>/<B>)` stands (§ 10).

Tests (T1): `refreshWhy: unclaimed < bound refreshes; held refreshes nothing;
draining nothing`; `CLI: a held tick refreshes no shortlist; the unheld one
does` (§ 10).

## 6. Phase-0 semaphore notice

Source: #2874 decision 12; map standing decision 10; ADR 0031 § 7.

omp's `task.maxConcurrency` is not the bound: it counts live members, not
tickets; it queues rather than refuses, so a Pull meeting it would leave a
claim with no running implementer; and it is session-wide. Phase 0 reads it
against B and prints a **notice, never a hold**; the fleet never writes it
(Install-time precondition rule). Modelled on the role-target notice.

**`tier-roles.mjs --check` gains `--in-flight <B>`, required under `--check`;**
leaving it out is a usage error (`die`, exit 2, stdout empty), as is a value
that is not digits ≥ 1. The usage string at `:342` becomes `--check
--in-flight <B> [--agents <dir>] [--model-roles <path>] [--overrides <path>]
[--catalog <path>] [--max-concurrency <path>]`.

- It reads `task.maxConcurrency` through the existing
  `readOmpConfigValue("task.maxConcurrency")` — the merged
  `omp config get task.maxConcurrency --json` (measured: unset returns the
  default `32`). `--max-concurrency <path>` is the test seam, like
  `--overrides` and `--model-roles`: a file holding the bare JSON value; absent
  it, the live read. It runs once per run, before the first dispatch (the
  existing step, § 10), and **the exit code never changes on its account**.
- A pure `semaphoreNotice({ inFlight, read })` returns the notice line or
  `null`, where `read` is `{ ok: true, value }` or `{ ok: false, why }`; its
  line joins `notices` beside the existing role-target notice, so the existing
  channel carries it: stdout on a pass (after the pass line), stderr after
  violations. `checkRoutes()` stays pure and unchanged.
- Lines, with `c` = `task.maxConcurrency` and `B` the bound (for B=5, `2·B+2`
  = 12):

| Reading | Output |
|---|---|
| `c ≥ 2·B+2`, or `c = 0` (unbounded) | no notice line |
| `0 < c < 2·B+2` | `tier-roles: notice: task.maxConcurrency is <c>, below 2·<B>+2 = <2B+2> for In-flight bound <B> — omp queues members past it, so a Pulled implementer may sit unstarted; raise it in omp config (the fleet never writes it)` |
| unreadable (the read throws, or the value is not a non-negative integer) | `tier-roles: notice: task.maxConcurrency unreadable — <why>; In-flight bound <B> is unchecked against it` |

For B=5 and c=8 the notice is exactly this one line:

```
tier-roles: notice: task.maxConcurrency is 8, below 2·5+2 = 12 for In-flight bound 5 — omp queues members past it, so a Pulled implementer may sit unstarted; raise it in omp config (the fleet never writes it)
```

For B=5 and a read that failed with message `M`, exactly:

```
tier-roles: notice: task.maxConcurrency unreadable — M; In-flight bound 5 is unchecked against it
```

`<why>` is the thrown message (`omp config get task.maxConcurrency --json
failed: …`) or `not a non-negative integer (got <json>)`.

SKILL.md carries the invocation once, at the existing `tier-roles.mjs --check`
step (`SKILL.md:1307`, run once per run before the run's first dispatch — the
phase-0 gate this notice rides): `--check --in-flight <B>`, `<B>` the run's
bound (the argument, else the default the arguments line states). It says a
notice line is the operator's to read and report, never a reason to stop the
run, and that exit 1 (violations) still stops it (§ 10).

Tests (T2, `tests/tier-roles.test.mjs`): `semaphoreNotice` cases (above, at,
below the threshold; `0`; unreadable; B=1 and B=5); CLI: no `--in-flight` →
exit 2; `--in-flight 0`/`x` → exit 2; `--max-concurrency` file `8` with
`--in-flight 5` → the exact line on stdout and exit 0; with a violation the
notice goes to stderr and exit stays 1; `0` and `12` print no notice line.

## 7. `blocked`

Source: #2874 decision 2, closing grilling 2026-10-13; ADR 0031 § 8.

The failure-handling row "Implementer blocked or ambiguous *mid-implementation*"
(`SKILL.md:4179`) says free the slot, leave `in-progress`, report — and no
settle outcome records it: `ledger-grammar.mjs` has none, `released` is wrong
because the claim stays, and `failed` is not an `impl` outcome.

- **New `impl` outcome `blocked`.** The slot is freed, the claim and
  `in-progress` stay, no replacement is owed, and the ticket is **not** In
  flight. `ledger-grammar.mjs:27` becomes `impl: { label: "impl-N", bound:
  "ticket", outcomes: ["PR#M", "bailed", "released", "killed", "tier-mismatch",
  "blocked"] }`; `ledger.mjs settle impl-<N> blocked` (and the one-token
  `settle impl-<N>=blocked`) is accepted through that grammar — no change in
  `ledger.mjs` beyond it. A refusal now reads `expected PR#M | bailed |
  released | killed | tier-mismatch | blocked`.
- **The tick** excludes a ticket whose newest `impl-` member settled `blocked`
  (§ 2): the outcome is in neither the live nor the owed set. A settled
  `blocked` member is still a member for the tier holds, as `bailed` is: the
  newest member with no verdict holds the implementer row at `HOLD (tier
  unchecked impl-<N>)` until `tier-check.mjs` writes `tier-ok=` or
  `tier-unverifiable=` (SKILL.md's list at `:1253-1254` gains `blocked`).
- **SKILL.md.** The failure row's response column reads:

  > Free the slot, `ledger.mjs settle impl-<N> blocked`, leave `in-progress`,
  > report — the ticket is not In flight and waits for a human; the row above
  > is the pre-code bail, not this one

  and the settle-outcomes list (`:4290-4291`) gains `blocked` after
  `tier-mismatch`.
- **The cockpit needs no change.** `compute-board.mjs` already flags a row
  carrying the word `blocked` (`parseRow`, `:132`, severity 4) and keeps the
  card in IMPLEMENTING (`deriveColumn`, `:267` returns null only for `released`
  and `bailed`): a settled-`blocked` ticket stays on the board, flagged, and
  stays in `claimed` — the claim is still outstanding, which is what the Stall
  report counts.

Tests (T1): `tests/ledger-grammar.test.mjs:16` gains `blocked`;
`tests/ledger-dispatch.test.mjs` settles `impl-<N>=blocked` (the one-token and
two-token spellings) and updates the refusal regex at `:378`;
`tests/fleet-tick.test.mjs` ADD 4 and 25 (§ 10); `tests/compute-board.test.mjs`
one case pinning that a settled-`blocked` ticket renders IMPLEMENTING with
the `blocked` flag (existing behaviour, now load-bearing).

## 8. Guard

Source: #2875; ADR 0031 § Guard. The guard is **a section of the In-flight
bound ADR**, `## Guard — chosen before any further data`, as in ADR 0012; it
is how the bound's decision gets checked and cannot stand without it. It
replaces ADR 0012's Guard (restated in ADR 0013), whose wave-era baselines
lapse unread. This section carries everything the ADR's Guard carries, plus
the script, the signal reads, the cutover recipe and the re-run recipe.

### 8.1 What the guard says

**Signals.** Six tests over four signals. Each is a ratio post ÷ pre over the
windows below, tripped on a margin, never on direction.

| # | Signal | Direction | Read from |
|---|---|---|---|
| 1 | Fleet `cache_creation` per merged PR (Σ `tokens_cache_create` over dispatched members with `role != memory`, ÷ n) | must not rise | `docs/metrics/member-outcomes.tsv`, booked per PR the way `plugin/scripts/pr-cost.mjs` does: omp rows only; merge-bot, `memory` and `__advisor` rows stay unbooked |
| 2 | Controller `cache_creation` per merged PR (Σ `usage.cacheWrite` over the controller kernel's own top-level assistant turns, ÷ n) | must not rise | controller transcripts, as `docs/research/baseline-efficiency-derive.py` reads them — never a subagent file; turns dated within the window's created span |
| 3a | Cycle time created → merged, **median** (replaces the idle ratio) | must not rise | GitHub PR `created_at` / `merged_at` |
| 3b | Merged PRs per **active clock hour** (replaces the idle ratio): a UTC hour in which at least one PR in the population was created or merged | must not fall | GitHub; the baseline script's primary definition |
| 4a | Review start latency, PR `createdAt` → review workflow start (`review-pr-<n>`'s `session_init`), **median** | must fall; trips on its rise side | `docs/metrics/member-outcomes.tsv` per PR, the start read from the member's transcript |
| 4b | The same, **p90** | must fall; trips on its rise side | same |

- **Signal 3 (implementer-slot idle ratio) is replaced** by 3a and 3b: a
  throttle raises the idle ratio by design. **In-flight depth p90 at arrival
  is dropped** — the hold caps it by construction, so the tick's tests cover
  it and a guard signal would add nothing. Signals 1, 2 and 4 keep their
  directions. The Claude Code leg and the "per harness" wording go (ADR 0014).
- **No signal reads the tick's own held time**, so the record question stays
  closed (§ 3).

**Population and windows.** Paired neighbouring windows, same scripts, rule
fixed now, numbers measured at the cutover. **N = 20**, matching the guard's
existing "never reopen on fewer than 20 PRs".

- **Cutover:** the start of the first `/run-team` whose phase-0 fast-forward
  and instruments pin include the merge of the spec's ticket that changes
  which PRs get Pulled — **T1, the tick** (#2875's "the spec's last ticket",
  read against § 12's slicing: T2 prints a notice, T3 rewrites prose, T4 is
  this script, and none moves a Pull; pinning on T3 would put PRs Pulled under
  the new tick into the pre window). It is read from the first timestamp in
  that run's omp session file (§ 8.3). A run already going at the merge never
  picks up the new rules mid-run, so it belongs to neither side.
- **Pre window:** the 20 merged PRs created most recently before that merge.
  **Post window:** the first 20 merged PRs created after the cutover, spread
  over at least two `/run-team` invocations. PRs created between the merge and
  the cutover count in neither window. At 2.72 merged PRs per active hour the
  post window fills in ≈ 7.4 active hours (20 ÷ 2.72), so over ≥ 2 invocations.
- **Step 0 of every reading:** re-scrape `docs/metrics/member-outcomes.tsv`
  with `plugin/scripts/member-outcomes.mjs`. As of 2026-10-09 it has no rows
  dated 2026-09-25 or later (the last omp `run_date` is 2026-09-22), so signals
  1, 2 and 4 cannot yet be read over the slot loop; their band (below) needs
  those rows.
- **Fleet rows** are booked to the window's PRs; **controller rows** are those
  dated within the window's created span.

**ADR 0012's wave-era baselines lapse unread.** Its guard was never read after
its cutover; its numbers — signal 1 = 1,078,459, signal 2 = 133,720, signal 3
= 0.906, signal 4 = 8.8 min median / 39.1 min p90, n = 75 (#1600–#1705) —
describe a loop that no longer exists. The pre window above is the slot loop's
first recorded reading.

**Trip rule — a margin from the slot loop's own history, not a direction.** For
each test the script computes the ratio of consecutive same-size windows
(window k+1 ÷ window k) across the slot-loop history before the cutover, from
2026-09-25T18:58:33Z to the merge (20-PR windows, offset 5, § 8.2). A test
trips when post ÷ pre lands **past the one-sided p90** of those ratios: above
it for a "must not rise" test (cycle, signals 1 and 2, and signal 4's two
tests on their rise side), **below the p10** for a "must not fall" test
(throughput). The band is computed at the cutover from the same history the
pre window ends.

- **Why a margin.** With no change at all, consecutive 20-PR windows over that
  history (79 pairs, offset 5) move the "wrong" way **53 %** of the time for
  cycle and **48 %** for throughput. ADR 0012's "any signal in the wrong
  direction" would trip on almost every reading.
- **False-trip arithmetic.** On today's data (2026-10-09) the band is
  **×2.23** for cycle (trips above) and **×0.68** for throughput (trips
  below). A one-sided p90 gives about **10 % false trips per test** and about
  **35–47 % for any of the six** (47 % = 1 − 0.9⁶ were they independent; less,
  since the tests are correlated). A trip means revisiting the owning decision
  with the measurement in hand, never a rollback, so a false trip costs one
  look.
- **Limit.** At N = 20 the guard catches only harm of roughly 1.5–2× or more.

**Then — what each trip revisits first**, with the measurement in hand:

- **Throughput falls** → the default bound first (at B = 5, 68 % of past
  Pulls would have been held), then the definition of In flight (held and
  halted PRs taking slots, § 2). **Never the hold's rank**, which only decides
  which `HOLD` row prints.
- **Cycle rises** → re-run the stage-decomposition script
  (`docs/research/in-flight-cycle-time-stages-derive.mjs`) on both windows. A
  rise in first `ready-to-merge` → merged belongs to ADR 0007 guard 1 (the
  merge side, outside this map). A rise in Claim → open, open → review
  evidence, or evidence → label revisits the default bound.
- **Signal 1 rises** → the default bound first (it is the load lever), then
  ADR 0012's existing order: merges per pass, then the bot's brief size.
- **Signal 2 rises** → unchanged: the per-Pull prompt.
- **Signal 4 rises** → the reviewer row's uncapped dispatch first (§ 4), then
  the operator's `task.maxConcurrency`, which the phase-0 notice already
  reports (§ 6).
- **Do not** read a trip as licence to bring back staging **or the implementer
  and reviewer caps**: automatic supply is ADR 0013's own decision, and the
  bound is the cap's replacement. Taking the reading, and acting on a trip, is
  past the map's destination.

### 8.2 The script

**`docs/research/in-flight-guard-derive.mjs`** (T4), extending
`docs/research/in-flight-baseline-derive.mjs` (zero dependencies, Node ≥ 18,
`gh api` else `curl`, the same truncation rule and cache refusal inside a git
checkout). It computes the pre and post windows, the per-test band and the six
verdicts. It is a ticket, not a cutover blocker.

```
node docs/research/in-flight-guard-derive.mjs --merge <ISO> [--cutover <ISO>]
     [--after 2026-09-25T18:58:33Z] [--n 20] [--offset 5]
     [--repo feigi/fleet-plugin] [--cache DIR] [--refresh]
     [--member-outcomes docs/metrics/member-outcomes.tsv]
     [--sessions ~/.omp/agent/sessions/-dev-fleet-plugin] [--json FILE]
```

| Flag | Meaning |
|---|---|
| `--cutover <ISO>` | The cutover instant (§ 8.3). Post window = the first `--n` merged PRs created at or after it, earliest first — the baseline's `--after <ISO> --n <N>` semantics. Omitted: no windows and no verdict; the script prints the history's ratio series and the band alone (exit 0), which is how the ×2.23 / ×0.68 figures above reproduce before any cutover exists. |
| `--merge <ISO>` | required. The `mergedAt` of the ticket that changes which PRs get Pulled (T1, § 8.1). Pre window = the `--n` merged PRs created most recently **before** it; PRs created between it and `--cutover` are in neither window. The history ends here. |
| `--after <ISO>` | start of the slot-loop history, default `2026-09-25T18:58:33Z` (the baseline note's first creation). |
| `--n <N>` | window size, default 20. |
| `--offset <K>` | the stride between consecutive history windows, default 5 PRs. |
| `--member-outcomes`, `--sessions` | the signal 1 / 4 and signal 2 inputs (below); the defaults are the paths shown. |

- **Windows over the history.** The history is the merged PRs created in
  `[--after, --merge)`, ordered by creation. History window k is the PRs at
  positions `k·K … k·K + N − 1`; window k+1 starts K PRs later, so consecutive
  windows overlap by N − K. On 2026-10-09's data that is 79 pairs (80 windows
  over ≈ 415 PRs). The ratio of a test is `f(window k+1) ÷ f(window k)`; the
  band is its **p90** for the "must not rise" tests and its **p10** for the
  "must not fall" one, by the linear-interpolation percentile the baseline
  script's `pct()` uses.
- **How each signal is read** (per window of N merged PRs):
  - **3a** the median of `merged_at − created_at` over the window's PRs.
  - **3b** N ÷ the number of distinct UTC clock hours in which at least one PR
    of the window was created or merged.
  - **1** Σ `tokens_cache_create` over the `member-outcomes.tsv` rows booked
    to the window's PRs ÷ N. Booking is `pr-cost.mjs`'s: omp rows only
    (`harness` = `omp`); a row is booked to a PR when its member name carries
    the PR (`review-pr-<n>`, `fix-pr-<n>`, the finisher spellings, the review
    fan-out labels; `member-record.mjs`'s `parseMemberName` decides) or it is
    an implementer row whose `ticket` column is an issue the PR closes
    (`closingIssuesReferences`), each with the members nested under its `agent`
    path; `merge-bot-*`, `memory` and `__advisor` rows are booked nowhere. The
    script prints the unbooked and unpriced counts.
  - **2** Σ `usage.cacheWrite` over the controller's own top-level assistant
    turns — the `.jsonl` file of each omp session under `--sessions`, never a
    file in a session's subagent directory — whose `timestamp` lies within the
    window's created span (earliest `created_at` to latest `created_at` among
    its PRs), ÷ N. The controller's `cacheWrite` is summed exactly as
    `baseline-efficiency-derive.py` folds it.
  - **4a / 4b** per window PR, the `review-pr-<n>` member's start (the first
    `timestamp` in its transcript — its `session_init` — found through the
    row's `session` and `agent` columns) minus the PR's `createdAt`; the median
    and the p90 over the PRs with a review row. PRs with none are listed
    unbooked and excluded.
- **Output.** Both windows (PR numbers, created range, distinct `/run-team`
  sessions their PRs fall in), the six values per window, post ÷ pre, the band
  and the verdict `TRIP` or `ok` per test; `--json` writes the same. Every
  table names the query that produced it.
- **Exit codes**, pr-cost's guard vocabulary: **0** no test tripped; **3** at
  least one tripped (`tripped[]` names each); **4** no verdict — a post window
  shorter than N, fewer than two `/run-team` sessions among its PRs, or
  `member-outcomes.tsv` lacking rows for the window or the history (step 0
  undone); **2** input error (an untrusted page, a bad ISO) — nothing printed
  as a verdict.
- **Tests** (T4, `tests/in-flight-guard-derive.test.mjs`): the script exports
  its pure functions (window cut, active-hour count, ratio series, percentile
  band, verdicts) and runs its CLI only when invoked, as `fleet-tick.mjs` does;
  the test drives them on synthetic PRs and rows: a flat series trips nothing;
  a post ÷ pre cycle ratio of 3 against a history whose p90 is 2.23 trips
  `3a`; a throughput ratio of 0.5 against a p10 of 0.68 trips `3b`; PRs
  created between the merge and the cutover are in neither window; a 19-PR
  post window exits 4.

### 8.3 Reading the cutover from the omp session file

1. The merge instant: `gh pr view <T1's PR> --json mergedAt -q .mergedAt`.
2. The candidate sessions: the files `*.jsonl` directly under
   `~/.omp/agent/sessions/-dev-fleet-plugin/`, named `<ISO-with-dashes>_<id>`,
   e.g. `2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127.jsonl`
   (the directory of the same stem beside it holds the subagent transcripts).
   The ISO of the name is the session start with `:` and the `.` of the
   milliseconds written as `-`: `2026-09-08T13-13-27-300Z` is
   `2026-09-08T13:13:27.300Z`.
3. A `/run-team` run is a session with a user turn beginning `/run-team`,
   `/skill:run-team` or `/fleet-ctl:run-team`. Take them in order of start and
   keep the first whose phase-0 evidence includes the merge: its `git merge
   --ff-only origin/main` (or a `git rev-list --count main..origin/main` of
   `0` after the fetch) and its `instruments.sh --pin` tool results precede its
   first `ledger.mjs dispatch`, and the main it fast-forwarded to contains the
   merge commit (`git merge-base --is-ancestor <merge-sha> <that HEAD>`). A run
   that started before the merge, or fast-forwarded to a main without it, is
   skipped: it belongs to neither window.
4. **The cutover is the first timestamp in that session file**: the first line
   carrying a string `timestamp` — `jq -r 'select(.timestamp != null) |
   .timestamp' <file> | head -1`. Measured on the 2026-09-08 file: line 1 is
   `{"type":"title",…}` with no `timestamp`; line 2 is
   `{"type":"session","version":3,"id":…,"timestamp":"2026-09-08T13:13:27.300Z",…}`,
   equal to the name's ISO — the value `--cutover` takes.

### 8.4 Re-running the default bound

The Defaults paragraph keeps the re-derive rule: **once ≥ 20 PRs have merged
under it, never from one run's rows.** The recipe, from the repo root, with
`<cutover>` read as § 8.3:

```
node docs/research/in-flight-baseline-derive.mjs --after <cutover> --n all --min 20 --bound 5 --cache /tmp/inflight-cache --json /tmp/inflight-post.json
node docs/research/in-flight-lead-share-derive.mjs /tmp/inflight-post.json --cache /tmp/inflight-cache
```

`--n all --min 20` exits 2 when fewer than 20 merged PRs were created after the
cutover, which is the "≥ 20 PRs merged under it" rule in code. Read the
`L = 19.3 min` table: the held share at B=5 and its neighbours against the
published 68.3 / 54.5 / 28.8 % (B=5 / 6 / 8), and the held vs not-held cycle
median. After the cutover the Pulls were held for real, so the table reads the
bound's utilisation, no longer a counterfactual; and the arrivals-without-a-cap
and collision-cost caveats (§ Why) are now measurable. To reproduce the
published numbers instead: `--n 400 --after 2026-09-25T18:58:33Z --bound 8` on
the first command.

## 9. ADR amendments

- **`docs/adr/0031-in-flight-bound-replaces-the-implementer-and-reviewer-caps.md`**
  is new, in ADR 0012's mould: Context, `## Decision` points 1–8 (numbered as
  this spec cites them: 1 signal and lever, 2 one argument, 3 what is In
  flight, 4 the hold, 5 the reviewer row, 6 Shortlist refresh, 7 the semaphore
  notice, 8 `blocked`), `## Guard — chosen before any further data`,
  `## Consequences`, `## Rejected alternatives`.
- **ADR 0012** and **ADR 0013** get **only** their `**Status:**` lines
  appended (AGENTS.md § ADR amendments: an accepted ADR's body stays as
  ruled; a change that falsifies or closes something it states is recorded on
  the Status line as `Amended by ADR NNNN: …`). No `## Amendment` body
  section, no body edit. The text is #2875's drafted text with `NNNN` →
  `0031`, verbatim otherwise, appended after the line's existing `Amended
  by …` sentences:

> **ADR 0012:** `Amended by ADR 0031: decision 1's "Defaults: 2 implementers, 6 reviewers; no hard caps" gives way to one In-flight bound (default 5) that holds Pulls; decision 2's "there is no minimum queue depth" still governs the merge bot, which dispatches on the first label, but open PRs now gate Pulls through the bound; the Guard's signal 3 (implementer-slot idle ratio) is replaced by cycle time created→merged (must not rise) and merged PRs per active clock hour (must not fall), signals 1, 2 and 4 are re-measured on the window before the In-flight cutover — the wave-era baselines lapse unread — every signal trips on a margin drawn from the slot loop's history instead of on direction, and signal 4's Then names the uncapped reviewer row in place of the reviewer cap and --max-reviews.`

> **ADR 0013:** `Amended by ADR 0031: § 5's refresh trigger reads unclaimed Shortlist entries < the In-flight bound and skips while HOLD (in-flight …) stands; § 7's and Consequences' "/run-team [implementers] [reviewers] … gains no argument" becomes one argument, the In-flight bound; the Guard is replaced as in ADR 0012's amendment.`

- **"Merge-queue depth never gates"** is the map's paraphrase of SKILL.md
  § Queue depth, not ADR text. The ADR ruling it narrows is ADR 0012 decision
  2's "there is no minimum queue depth", and the narrowing does not reverse it:
  the merge bot still dispatches on the first label and is never gated; only
  Pulls are gated, on the In-flight count. The SKILL.md paragraph is rewritten
  (§ 10), the ADR body is not.
- ADR 0030's `--implementer-cap` / `--reviewer-cap` sentences (Context and
  Consequences) describe the flags as they stood and stay as written; so do
  the dated specs and `docs/metrics` (§ 10, unchanged).

## 10. Change surface

Every replacement text under `plugin/` **states the claim and cites no issue,
PR, ADR, `docs/` record path or test file** (AGENTS.md § Shipped surface). Line
numbers are `bd4afac8`; each row's anchor phrase was re-grepped there.

### Code

`plugin/scripts/fleet-tick.mjs` (T1):

| Anchor phrase (current line) | Becomes |
|---|---|
| `// Every role's TARGET is its configured cap.` (`:79`); `const rev = reviewers(s);` (`:87`); `...mainCheckoutHold(s, [implementers(s, rev.left), ...rev.rows])` (`:92`) | comment: the implementer and reviewer rows' TARGET is the In-flight bound, the merge bot's is 1. `reconcile` no longer computes the reviewer rows first: `mainCheckoutHold(s, [implementers(s), ...rev.rows])` with `rev = reviewers(s)` read for `rows`/`conflictRows` only |
| `function implementers(s, left)` (`:169`) | `function implementers(s)` |
| `const row = mkRow("implementers", s.implLive, s.implCap,` (`:171`); the template with `unreviewed=${left.unreviewed}` (`:172`) | ``mkRow("implementers", s.inFlight, s.bound, `implementers=${s.inFlightImpl} prs=${s.inFlightPrs} unclaimed=${s.heads.length} supply=${s.supply ?? "?"}` + …)``, the `shortlist=` and `specs-dropped=` tails unchanged |
| `const deficit = s.implCap - s.implLive;` / `if (deficit <= 0) return row("AT CAP");` (`:195-196`) | ``if (s.inFlight >= s.bound) return row(`HOLD (in-flight ${s.inFlight}/${s.bound})`);`` — after the tier-unchecked branch (`:191`), `acts` false |
| the review-backlog gate comment and `if (left.unreviewed >= 1 && left.free <= 0) return row("HOLD (review side saturated)");` (`:198-206`) | **deleted** |
| ``if (s.heads.length) return row(`PULL ${s.heads.slice(0, deficit)…`` (`:208`) | `s.heads.slice(0, s.bound - s.inFlight)` |
| `// Reviewer units: an in-flight review = 1` (`:217`) … `function reviewers(s)` (`:223`) | comment drops the `--max-reviews`/cap sentences; body per § 4 |
| `max-reviews=${s.maxReviews}` (`:225`) | removed from the detail |
| `mkRow("reviewers", s.reviewsLive + s.fixLive, s.reviewerCap, detail)`; `let free = Math.max(0, s.reviewerCap - …)`; `fixes = s.fixDue.slice(0, free)`; `reviews = s.reviewDue.slice(0, Math.min(free, …))` (`:226-231`) | `mkRow("reviewers", s.reviewsLive + s.fixLive, s.bound, detail)`; `fixes = s.fixDue`; `reviews = s.reviewDue` |
| ``if (owed && free <= 0) rows.push(row("AT CAP"))`` and ``else if (s.reviewDue.length) rows.push(row(`HOLD (max-reviews …`` (`:272-274`) | **deleted**; `if (!rows.length && !unlabelledRows.length) rows.push(row("IDLE OK"))` |
| `return { rows, conflictRows, left: { unreviewed: …, free } };` (`:278`) | `return { rows, conflictRows };` |
| `if (s.mergeBotLive >= 1) return row("AT CAP");` (`:284`) | unchanged |
| `export function deriveRun(` (`:528`); `const newest = impls.filter(` (`:757`); the returned object after `implLive: live("impl"),` (`:815`) | adds the § 2 computation after `tierUnchecked` (`:766`), and returns `inFlight`, `inFlightImpl`, `inFlightPrs`, `owedReplacement` |
| `function openPrs()` validation (`:1144-1148`) | also requires each `closingIssuesReferences` element to carry an integer `number`; the die message names it |
| `export function refreshWhy({ …, implCap })` (`:939`); `unclaimed ${k} < cap ${implCap}` (`:943`) | § 5 |
| `const OPTIONS = {` (`:1065`); `"implementer-cap": …` (`:1069`), `"reviewer-cap"` (`:1070`), `"max-reviews"` (`:1073`) and their comments (`:1066-1068`, `:1071-1072`) | `"in-flight": { type: "string", default: "5" }` first, one comment (§ 1); the three entries deleted |
| `options()` (`:1087`): `const reviewerCap = positive("reviewer-cap")` (`:1110`) and the returned `implCap`, `reviewerCap`, `maxReviews` (`:1112-1113`) | `bound: positive("in-flight")` |
| `closedTickets(mismatched)` (`:1283`) and its call `closedTickets(run.tierMismatch)` (`:1406`) | probes the union of `run.tierMismatch` and `run.owedReplacement` (§ 2); the second `deriveRun` pass condition is unchanged |
| `const trigger = refreshWhy({ … implCap: caps.implCap })` (`:1423-1424`) and `liftedPremise` guard (`:1425`) | `bound: caps.bound`, `held: run.inFlight >= caps.bound` (§ 5) |
| `const rows = reconcile({ ...caps, ...run, … })` (`:1449`) | unchanged — `caps` is now `{ bound }` |
| header comment `WHERE THE NUMBERS COME FROM` (`:19-71`) | the `ledger` and `gh` paragraphs name the In-flight count |

`plugin/scripts/ledger-grammar.mjs:27` (T1): `blocked` appended (§ 7).
`plugin/scripts/ledger.mjs` (T1): none beyond the grammar — `settle` validates
through it (`:1914` usage string names no outcomes).

`plugin/scripts/tier-roles.mjs` (T2): `defineFlags` (`:312`) gains `"in-flight":
"value"` and `"max-concurrency": "value"`; `main()` (`:337`) requires
`--in-flight` under `--check` (`:342`, the usage string), validates it with the
digits-and-≥1 rule, reads `task.maxConcurrency` (`:346`'s `config` helper),
builds the notice with a new exported pure `semaphoreNotice` and adds it to
`notices` before the two print loops (`:361`, `:366`). `checkRoutes`
(`:208`) and the exit codes are unchanged.

### Tests

`tests/fleet-tick.test.mjs` (T1). Helper `state()` (`:15-23`): `implCap: 2,
reviewerCap: 6, maxReviews: 6, implLive: 0` become `bound: 5, inFlight: 0,
inFlightImpl: 0, inFlightPrs: 0`.

**DELETE** (the case is the retired behaviour):

| Line | Case |
|---|---|
| `:64` | `implementers: the backlog gate holds only when an unreviewed PR is left AND no reviewer slot is free` |
| `:78` | `implementers: the gate counts the slots this tick's own dispatches fill` |
| `:86` | `implementers: --max-reviews leaving a PR owed with slots free does not hold implementers` |
| `:217` | `reviewers: --max-reviews bounds reviews in flight, and a throttled review is a HOLD that says why` |
| `:227` | `reviewers: work owed with every slot full is AT CAP` |
| `:1904` | `CLI: --max-reviews bounds the reviews one tick starts` |
| `:1921-1924` | the `saturated` half of `CLI: the narrowed backlog gate …` (the case stays, retitled `CLI: a deep review backlog never holds the implementer row`, its first half asserting `implementers 3/5 → PULL #7 #8` — its three fixture PRs close issues, so they count) |

**REWRITE** (the behaviour stays, its terms change). The fixture `pr(number,
…)` (`:532`) closes `[number + 1000]` by default, so **every fixture PR now
counts toward n**: an expectation of `implementers 0/<B>` beside open fixture
PRs becomes `implementers <p>/<B>`, and a PULL count is `B − n`.

| Line | Case → change |
|---|---|
| `:30` | free slots PULL one head each: `state({ bound: 2, heads: [412, 415, 420], supply: 9 })`, target `2`, action `PULL #412 #415` |
| `:38` | `a PULL never takes live past the cap` → `a PULL never takes In flight past the bound`: vary `bound` × `inFlight`, assert `inFlight + pulled ≤ bound` and `pulled === max(0, min(heads, bound − inFlight))` |
| `:48` | the PULL is bounded by the heads: `state({ bound: 5, heads: [7] })` |
| `:52` | `at cap nothing is pulled` → `at the bound nothing is pulled`: `state({ inFlight: 5, heads: [1, 2, 3] })` → `HOLD (in-flight 5/5)`, `acts === false` |
| `:93` | draining outranks every branch: the matrix gains `{ inFlight: 5 }` |
| `:103`, `:121`, `:152`, `:164`, `:178` | detail assertions: `unclaimed=1 supply=0 unreviewed=0 — ` → `implementers=0 prs=0 unclaimed=1 supply=0 — ` (`:107`, `:122`, `:156-157`, `:168`, `:172`, `:181`) |
| `:203` | `dispatches never take live units past the reviewer cap` → `every due fix and review is dispatched, with no cap`: `fixDue [1,2,3,4]`, `reviewDue [5,6,7,8]` for every `(reviewsLive, fixLive)` pair ⇒ all eight PRs dispatched |
| `:234`, `:279` | the `full`/`at cap` sub-cases (`fixLive: 6 … "AT CAP"`, `:240-241`, `:280-281`) are removed; the unfull assertions stay |
| `:432` | `formatLines` expected lines: `implementers 0/5 → PULL #412   (implementers=0 prs=0 unclaimed=1 supply=57)` and `reviewers    0/5 → DISPATCH fix-pr PR#346   (reviews=0 fix-pr=0 fix-due=1 review-due=1)` (and the `DISPATCH review PR#350` twin) |
| `:448` | `actionable`: the `AT CAP` row (`:455`, `implLive: 2`) becomes `{ inFlight: 5, heads: [1] }` → `false` |
| `:1499` | `refreshWhy`: `implCap` → `bound`, `"unclaimed 1 < cap 2"` → `"unclaimed 1 < in-flight bound 2"` (`:1500-1505`) |
| `:1763` | `the #1692 shape`: pass `--in-flight 2`; `implementers 2/2 → HOLD (in-flight 2/2)` (`:1769`); the one-settled half: `impl-412=PR#500` with PR 500 not on the open list ⇒ `implementers 1/2 → PULL #420` |
| `:1782`, `:1791`, `:1807`, `:1814`, `:1820`, `:1840`, `:1848` | every `implementers 0/2 → …` expectation becomes `0/5` with `implementers=0 prs=0` and no `unreviewed=0` (`:1787`, `:1795`, `:1810`, `:1817`, `:1826`, `:1844`, `:1851`) |
| `:1873`, `:2044`, `:2053`, `:2073`, `:2085`, `:2095`, `:2113`, `:2123` | `--implementer-cap N` → `--in-flight N` (`:1874`, `:2045`, `:2059`, `:2074`, `:2086`, `:2096`, `:2103`, `:2114`, `:2126`, `:2131`); each expected PULL count is `N − n`, so re-derive it where the fixture's ledger carries a settled `PR#M` implementer whose open PR closes an issue — that PR now counts |
| `:2297` | the unknown-flag regex `accepted: --implementer-cap, --reviewer-cap, --max-reviews, --fold-unchanged, --state` → `accepted: --in-flight, --fold-unchanged, --state` (`:2301`) |
| `:2306` | `caps must be positive integers, with no upper bound` → `--in-flight must be …`: refuse `["--in-flight", "0"]`, `["--in-flight=x"]`, `["--in-flight="]`; accept `9` and `100` (`big.stdout` `implementers 0/9`, `reviewers    0/9`) |
| `:2460`, `:2470`, `:2478`, `:2488`, `:2498`, `:2515`, `:3156` | the dangling-review cases drop `CAPS` (`:2458`) and `--reviewer-cap 1 --max-reviews 1` (`:2471`, `:2479`, `:2489`, `:2505`, `:2519`, `:3157`) and assert **units** instead of a slot: a MERGED/CLOSED zombie is probed and counts 0 (`reviewers +0/5 → DISPATCH review PR#500`); a review on an open PR is never probed and counts 1 (`reviewers +1/5 → DISPATCH review PR#500`, replacing `1/1 → AT CAP`, `:2484`, `:2494`, `:2510`, `:2525`, `:3163`); an unanswered probe keeps the unit counted and is disclosed |
| `:2901` | busy fleet not STALLED: pass `--in-flight 2`; `implementers 2/2 → HOLD (in-flight 2/2)` (`:2918`) |
| `:3035` | the usage-refusal half: `--implementer-cap 0` → `--in-flight 0` (`:3060`) |
| `:3267` | carried live members: pass `--in-flight 2`; `implementers 2/2 → HOLD (in-flight 2/2)` (`:3280`); the merge-bot line `merge-bot +1/1 → AT CAP` (`:3281`) is unchanged |
| `:1940` | `merge-bot +1/1 → AT CAP` (`:1943`) is unchanged |

**ADD** (T1):

1. `deriveRun: an open issue-closing PR is In flight once, however many issues it closes`
2. `deriveRun: a live implementer with no open PR is In flight; with its PR open and unreported it counts once, as the PR`
3. `deriveRun: a replacement owed — newest impl settled killed or tier-mismatch on an open issue — counts, and its live replacement counts the same one`
4. `deriveRun: a newest impl settled blocked, bailed, released, or PR#M with PR M merged counts nothing` (table-driven)
5. `deriveRun: held and halted PRs count — conflict-hold, held-behind, halted:past-pin, dispositions-escalate, finisher failed, finisher killed` (table-driven)
6. `deriveRun: an Exclusion row counts nothing, and the PR it waits behind counts in its own right`
7. `deriveRun: inherited, human-authored and draft issue-closing PRs count from the first tick; a chore PR closing nothing never does`
8. `deriveRun: two open PRs closing one issue count two`
9. `deriveRun: an owed replacement whose issue is in closed counts nothing; unprobed it counts`
10. `deriveRun: inFlight is inFlightImpl plus inFlightPrs` (every fixture above)
11. `implementers: HOLD (in-flight n/B) whenever n ≥ B — the wording, n/B on the row, acts false, an inherited n over B printed as 7/5`
12. `implementers: the in-flight hold ranks below draining, tier mismatch, tier unchecked and the main-checkout overlay, and the tier holds stay actionable`
13. `implementers: PULL takes B − n heads, never more than the heads`
14. `implementers: the detail is implementers=<i> prs=<p> unclaimed=<k> supply=<s>, before a tier hold's clearing step, with no unreviewed=`
15. `reviewers: every due fix and every due review is dispatched with no cap, fix-appliers first`
16. `reviewers: the row prints <units>/<B>, an inherited run over B printing the overflow`
17. `reviewers: no state prints AT CAP, HOLD (max-reviews …) or HOLD (review side saturated)` (property loop over the state space; the merge-bot row's `AT CAP` is asserted separately)
18. `refreshWhy: unclaimed below the bound refreshes, held refreshes nothing, draining nothing`
19. `CLI: --in-flight defaults to 5 and prints n/B`
20. `CLI: the three retired flags refuse as unknown` (each of `--implementer-cap`, `--reviewer-cap`, `--max-reviews`; exit 2, stdout empty, the `accepted:` list of § 1)
21. `CLI: an inherited run over B starts fully held` (seven open issue-closing PRs, B = 5: `implementers 7/5 → HOLD (in-flight 7/5)`, no `PULL`, `DISPATCH review` for each due PR)
22. `CLI: a held tick refreshes no shortlist; the same fixture one merge later does` (missing shortlist: `r.refreshed` 0 then 1)
23. `CLI: an owed replacement on a CLOSED issue is not In flight; a probe that cannot answer leaves it counted and is disclosed on stderr`
24. `CLI: a held tick is quiet — the state file's quiet increments`
25. `CLI: a ledger carrying impl-<N>=blocked counts nothing for N — no In-flight slot, no PULL held on its account`

`tests/ledger-grammar.test.mjs:16` (T1): the `impl-412` outcome list gains
`"blocked"`. `tests/ledger-dispatch.test.mjs` (T1): the refusal regex at
`:378` ends `\| tier-mismatch \| blocked`; a new case settles
`impl-<N>=blocked` both spellings. `tests/compute-board.test.mjs` (T1): one
case, § 7. `tests/tier-roles.test.mjs` (T2): `installFlags` (`:364`) adds
`"--in-flight", "5", "--max-concurrency", jsonFile(d, "max-concurrency.json",
32)`; every `--check` call goes through it (`:375-443`), so none reads the
box's own omp; the cases of § 6.

### Prose

`plugin/skills/run-team/SKILL.md` (T3):

| Anchor phrase (current line) | Becomes |
|---|---|
| `description: Run an agent fleet — implementers, reviewers (default 2 and 6), one merge bot — …` (`:3`) | `… implementers, reviewers, one merge bot — …` |
| `argument-hint: "[implementers] [reviewers]"` (`:4`) | `argument-hint: "[in-flight]"` |
| `` `$ARGUMENTS` = `[implementers] [reviewers]`, both optional, default 2 and 6, no hard cap — … `` (`:11-13`) | `` `$ARGUMENTS` = `[in-flight]`, optional, one positive integer, default 5: the In-flight bound, the most tickets between Claim and merge at once. It becomes the tick's `--in-flight` and `tier-roles.mjs --check --in-flight`. Merge bot is at most one, not configurable. `` |
| `Refresh is the tick's from here on.` … `below the implementer cap` (`:670-672`) | `below the In-flight bound`, plus: never while `HOLD (in-flight <n>/<B>)` stands |
| `member has held; nothing holds a queue.** The implementer cap is the fleet's` (`:1127`) | `The In-flight bound is the fleet's` |
| `` `killed` or `released`, and `HOLD (tier mismatch impl-<N>)` `` (`:1253-1254`) | the list of settled members becomes `bailed`, `killed`, `released` or `blocked` |
| ``Before the run's first dispatch run `~/.fleet/bin/fleet-run tier-roles.mjs --check` `` (`:1307-1308`) | the invocation reads ``--check --in-flight <B>``, followed by the semaphore-notice sentences of § 6 |
| ``the tick names it as `DISPATCH review PR#<M>` once a reviewer slot is free,`` (`:1724`) | ``the tick names it as `DISPATCH review PR#<M>`,`` — no slot clause |
| `` ~/.fleet/bin/fleet-run fleet-tick.mjs [--implementer-cap <n>] [--reviewer-cap <n>] [--max-reviews <n>] `` (`:1860`) | `` ~/.fleet/bin/fleet-run fleet-tick.mjs [--in-flight <n>] `` |
| `It reads the run itself, and nobody states a count. Live implementers, live review units …` (`:1863-1866`) | names the In-flight count (open issue-closing PRs off `gh` plus claimed tickets with a live or owed implementer off the ledger) beside the live review units |
| `below the implementer cap, when the file is missing or empty` (`:1868`) | `below the In-flight bound, …`, never while the bound holds |
| ``The caps default to 2 implementers and 6 reviewers, and neither is a hard bound: pass `--implementer-cap` and `--reviewer-cap` on every tick when `$ARGUMENTS` set them, and never otherwise.`` (`:1874-1876`) | ``The In-flight bound defaults to 5 and is fixed for the run: pass `--in-flight` on every tick when `$ARGUMENTS` set it, and never otherwise.`` |
| `Finishers take no reviewer slot, so this prints whatever the reviewer cap reads.` (`:1907-1908`) | `Finishers are not review units, so this prints whatever the unit count reads.` |
| ``- `HOLD (…)` — the row is held and says why: draining, a tier mismatch, an unchecked tier, a saturated review side, `--max-reviews` in flight, or every queued merge candidate held …`` (`:1933-1935`) | ``… draining, a tier mismatch, an unchecked tier, the In-flight bound reached (`HOLD (in-flight <n>/<B>)` — nothing to do: a merge brings n below B), or every queued merge candidate held …`` |
| `` - `AT CAP`, `IDLE OK` — nothing to do on that row. `` (`:1945`) | unchanged text; `AT CAP` now prints only on the merge-bot row |
| ``**`--max-reviews <n>`** bounds how many reviews are in flight at once, inside the reviewer cap. …`` (`:1993-1998`) | A paragraph opening ``**`--in-flight <B>`**``: the run's In-flight bound; leave it at its default unless `$ARGUMENTS` set it; omp's `task.maxConcurrency` is not the bound (it counts live members, not tickets, queues at its ceiling rather than refusing, and is session-wide); phase 0 reports it below 2·B+2 as a notice, never a hold, and the fleet never writes it. It ends before `**Why every wake.**` (`:2000`) |
| `**The reviewer cap counts live review units.** A review in flight — …` (`:2385-2397`) | opens `**Review units are counted, never capped.**`; keeps the unit definition, the `review=` and no `reviewed=` derivation and the probe (a probe that cannot answer keeps the unit counted); drops `The defaults are 2 implementers and 6 reviewers, and neither is a hard cap`, the `--max-reviews` sentence and `The slots a review does not hold still serve fix-appliers.` |
| `` floors the backlog at a depth nothing in the run can drain — the implementer gate then holds for the rest of the run against a queue of nothing `` (`:3873-3874`) | `… nothing in the run can drain` kept; the gate clause becomes `the reviewer row would then report a review owed for the rest of the run` |
| `**Defaults: 2 implementers, 6 reviewers — no hard cap on either.** Reviewer slots in use ≈ I·(…)/T_impl ≈ 1.95·I … Re-derive it from the map's guard once 20 or more PRs have merged under it, never from one run's rows.` (`:3885-3890`) | One paragraph opening `**Default: In-flight bound 5, fixed for the run.**`, carrying § 1's *Why 5* (load not throughput; live review units ≤ open PRs ≤ B; ~84 % of cache-write tokens; 1 snapshot + up to 6 specialists + 2 refuters per finding; below the old reviewer count of 6; near the measured mean In flight of 5.6; ≈ 3.1 merges/h against 2.7 measured; the merge gate saturates near 10.5; 8 rejected) and the sentence "Re-derive it once 20 or more PRs have merged under it, never from one run's rows." The `1.95` note is gone |
| `**The review-backlog gate is narrowed, and the merge-queue depth never gates.** …` (`:3892-3900`) | `**The review backlog never gates, and the merge-queue depth is still no signal.**` — the only gate on a Pull is the In-flight count; a deep `ready-to-merge` queue adds no rebases per PR, and those PRs count as In flight because they sit between Claim and merge, not because the queue is deep |
| the table row `below the cap, missing or empty` (`:3923`) | `below the In-flight bound, missing or empty` |
| ``Four holds outrank every row: … `HOLD (review side saturated)` when a PR is still owed its review and no reviewer slot is left for it — refreshing to enable a Pull you are holding buys nothing.`` (`:3930-3937`) | The same four-hold sentence with ``HOLD (in-flight <n>/<B>)`` — n tickets between Claim and merge, n ≥ B — in place of the saturated-side hold; the closing clause (`refreshing to enable a Pull you are holding buys nothing`) stays |
| `- Implementers and review units at their caps (default 2 and 6, no hard cap on either), ≤ 1 merge bot. Caps bound *members* and review units, not live agents — …` (`:3951-3953`) | `- In-flight tickets at most the bound (default 5), ≤ 1 merge bot. The bound counts tickets, not live agents — members fan out and their children consume slots you never dispatched.` |
| `Implementer blocked or ambiguous *mid-implementation*` (`:4179`) | § 7 |
| ``Outcomes: `impl-N` = `PR#M \| bailed \| released \| killed \| tier-mismatch` `` (`:4290-4291`) | `… \| tier-mismatch \| blocked` |
| `the tick counts it against the reviewer cap unless gh reports its PR MERGED or CLOSED` (`:4350`) | `the tick counts it as a live review unit unless gh reports its PR MERGED or CLOSED` |
| `so that order is what keeps the fallback counted against the cap.` (`:2488-2489`) | `so that order is what keeps the fallback counted as the live review unit.` |

Unchanged in SKILL.md: Phase 0's and Phase 1's "one free implementer slot is one
Pull" (`:255`, `:690`) — with B − n free slots the sentence still holds; the
cap-free occurrences at `:613`, `:1432`, `:2241`, `:2282`.

`README.md` (T3): `(both optional, default 2 and 6, no hard cap)` (`:59`) and
`/skill:run-team [implementers] [reviewers]` (`:63`) → the In-flight bound,
one optional argument, default 5; `/skill:run-team [in-flight]`.

`docs/components/controller.md` (T3): `Invoked as /skill:run-team
[implementers] [reviewers] (defaults 2 and 6, no hard cap; …)` (`:8-9`), `a
HOLD on the implementer row (draining, tier mismatch, review saturated)`
(`:22-23`) and `bounded by the implementer/reviewer caps` (`:37`) → one
In-flight bound, the hold `(draining, tier mismatch, tier unchecked,
in-flight)`, bounded by the In-flight bound.
`docs/components/supply-and-shortlist.md:29` (`entries fall below the
implementer cap`) → `below the In-flight bound, never while it holds`. (Not
shipped, so these two cite ADR 0031 where the file cites ADRs.)

Prose pins (T3):

| Test | Pin → change |
|---|---|
| `tests/fleet-tick-prose.test.mjs:34` `the tick block names the script and only the flags it still takes` | the survivor list `["--implementer-cap", "--reviewer-cap", "--max-reviews"]` (`:39`) becomes `["--in-flight"]`; the loop at `:44` also forbids the three retired flags (same `(?![\w-])` lookahead) |
| `:63-71` `maxReviewsPair` and `--max-reviews defaults to the reviewer cap, and omp leaves it there` | replaced by `inFlightPair`, `RUN_TEAM.paragraph("**`--in-flight <B>`**", …, "**Why every wake.** A merge cascade is a firehose")`, pinning `Leave it at its default`, `task.maxConcurrency`, `never a hold`, and that it names no numeric `--in-flight \d` |
| `:137-148` `the queue-depth table keeps the implementer row's four holds above its rows` | `` "`HOLD (review side saturated)`" `` (`:145`) → `` "`HOLD (in-flight <n>/<B>)`" ``; `Four holds outrank every row` (`:144`) stays; the comment at `:138-142` says `an in-flight bound` for `a saturated review side` |
| `:168-171` `the review-backlog definition states what the script actually counts` | the bullet's end marker `"**Defaults: 2 implementers, 6 reviewers"` → `"**Default: In-flight bound 5"`; `nothing in the run can drain` (`:185`) still holds |
| new, same file | the tick block says `pass --in-flight … when $ARGUMENTS set it, and never otherwise`; the Defaults paragraph says `fixed for the run`, `never from one run's rows`, and has no `1.95`; the failure row names `blocked` |
| `tests/review-path-default.test.mjs:250-257` | `/The reviewer cap counts live review units/` → `/Review units are counted, never capped/` and its message; the `` `review=` and no `reviewed=` `` pin (`:260`) stays |

### Unchanged

`plugin/scripts/compute-board.mjs`: `claimed` (`:393`, ledger rows past POOL
short of MERGED) is the ledger half of In flight and stays as it is — a
settled-`blocked` or Exclusion-free claimed ticket is still claimed.
`plugin/scripts/fleet-heartbeat.mjs`, `fleet-state.mjs` (no heartbeat rule, no
new key). `docs/metrics/*.tsv` (no column names a cap or the bound, and no
held-time record exists). `plugin/scripts/inflight.sh` and `shortlist.mjs`'s
"in-flight check" (the claim-time probe for an open PR or worktree on a
ticket — a different thing from the In-flight count, kept as is).
`CONTEXT.md`'s **Stall report** entry drops "and in flight" (the closing
ticket #2876, not T1–T4); the **Pull** entry's "free implementer slot" stays.
ADR 0030, ADR 0007 and the dated specs stay as written.

## 11. Cutover

The cutover is not atomic. T3 (blocked by T1 and T2) lands the prose; between
a code ticket's merge and T3's, `plugin/` is internally inconsistent:

- **T1 → T3, a default run.** It ticks on the new rules (B = 5, `HOLD (in-flight
  n/5)`, an uncapped reviewer row) under SKILL.md prose that still says "2
  implementers, 6 reviewers" and lists `AT CAP` and `HOLD (review side
  saturated)`. SKILL.md's own rule is "Pull nothing the tick did not name"
  (`:1725-1726`), so the controller Pulls what the tick prints — up to 5 —
  and meets `HOLD (in-flight n/5)` as a hold the prose does not name: a stale
  explanation, with the tick still deciding every dispatch.
- **T1 → T3, an argument-invoked run.** `/run-team 3 6` makes the controller
  pass `--implementer-cap 3 --reviewer-cap 6`, which the strict `parseArgs`
  refuses at the **first tick**: exit 2, stdout empty, `fleet-tick: Unknown
  option '--implementer-cap' — accepted: --in-flight, …` (the same mechanism
  measured on `bd4afac8` with `--implementers`, § 1). No tick ever runs, so
  the run cannot Pull. An operator who must run in the window passes no
  argument.
- **T2 → T3.** SKILL.md's `tier-roles.mjs --check` (no `--in-flight`) is a
  usage error, exit 2 with no notice, at the step that gates the first
  dispatch.
- **Length of the window**, derived from the measured medians: T3 is blocked by
  T1 and T2, so it is Pulled only after both merge; Pull → merged is T_impl 19.3
  min + created → merged 1.38 h ≈ **1.7 h at the median** (created → merged
  p90 5.23 h), of which last `ready-to-merge` → merged is median 15 min, p90 65
  min. Blockers-first ordering and T3 right behind T1/T2 are the whole
  mitigation; the hazard is accepted.
- **T4** is outside the window: it ships nothing under `plugin/` and the
  guard is not a cutover blocker (§ 8.2).

## 12. Tickets (input to /to-tickets)

Tickets are written to `.scratch/` and posted to GitHub once the docs PR
merges, so every citation here resolves on `main`. Blockers first; every
ticket is admissible by `candidates.mjs` (body carries no `User Stories`
heading; blockers named under `## Blocked by` as a list).

| # | Title | Blocked by | Delivers | Spec § |
|---|---|---|---|---|
| T1 | `fleet-tick.mjs`: the In-flight bound — `--in-flight <B>` (default 5) replaces `--implementer-cap`, `--reviewer-cap`, `--max-reviews`; the In-flight count; `HOLD (in-flight <n>/<B>)`; the uncapped reviewer row; refresh at unclaimed < B and none while held; the `blocked` settle outcome | — | `node plugin/scripts/fleet-tick.mjs` reads `--in-flight` through `positive()` (0, `x`, empty refused, exit 2); derives `n = i + p` from the ledger and the open issue-closing PR list by § 2's rules; prints `implementers n/B` with `HOLD (in-flight <n>/<B>)` at n ≥ B (`acts: false`, detail `implementers=<i> prs=<p> unclaimed=… supply=…`) ranked below the main-checkout overlay, `HOLD (draining)`, the tier holds; `PULL` takes `B − n` heads; `reviewers <units>/<B>` dispatches every due fix and review; `HOLD (review side saturated)`, `HOLD (max-reviews …)` and the reviewer `AT CAP` appear nowhere in `plugin/scripts/fleet-tick.mjs`; `--implementer-cap`, `--reviewer-cap`, `--max-reviews` exit 2 as unknown options; `refreshWhy` reads `unclaimed <k> < in-flight bound <B>` and `main()` runs no refresh at n ≥ B; `ledger-grammar.mjs` and `ledger.mjs settle` accept `impl-<N>=blocked` and the tick counts nothing for it; `node --test tests/fleet-tick.test.mjs tests/ledger-grammar.test.mjs tests/ledger-dispatch.test.mjs tests/compute-board.test.mjs` green with § 10's DELETE, REWRITE and ADD lists applied | 1, 2, 3, 4, 5, 7, 10 |
| T2 | `tier-roles.mjs --check --in-flight <B>`: the semaphore notice | — | `--check` without `--in-flight` exits 2 with a usage error; with a `--max-concurrency` file `8` and `--in-flight 5` stdout carries `tier-roles: notice: task.maxConcurrency is 8, below 2·5+2 = 12 for In-flight bound 5 — omp queues members past it, so a Pulled implementer may sit unstarted; raise it in omp config (the fleet never writes it)` and the exit is 0; `0` and `12` print no notice line; an unreadable value prints `tier-roles: notice: task.maxConcurrency unreadable — <why>; In-flight bound 5 is unchecked against it`; with violations the notice goes to stderr and the exit stays 1; `node --test tests/tier-roles.test.mjs` green | 6, 10 |
| T3 | Prose cutover: `/run-team [in-flight]` — SKILL.md, README, `docs/components`, and the pins | T1, T2 | `grep -n -E 'implementer-cap\|reviewer-cap\|max-reviews\|implementers\] \[reviewers\]\|default 2 and 6\|2 implementers\|6 reviewers\|1\.95' plugin README.md docs/components` prints nothing; SKILL.md's `argument-hint`, `$ARGUMENTS` paragraph, tick invocation, caps paragraph, `--max-reviews` paragraph, § Queue depth, Defaults paragraph, description, `tier-roles.mjs --check --in-flight <B>` step, failure row and settle-outcomes list read as § 10's Prose table says; `node --test tests/fleet-tick-prose.test.mjs tests/review-path-default.test.mjs` green with the moved pins | 1, 5, 6, 7, 10 |
| T4 | The guard script `docs/research/in-flight-guard-derive.mjs` | — | `node docs/research/in-flight-guard-derive.mjs --merge <ISO> --cutover <ISO>` prints both 20-PR windows, the six values per window, post ÷ pre, the per-test band (p90 / p10 of consecutive same-size history-window ratios, stride 5, from 2026-09-25T18:58:33Z to the merge) and the six verdicts, with exit 0 / 3 / 4 / 2 as § 8.2 says; `node --test tests/in-flight-guard-derive.test.mjs` green on synthetic windows; not a cutover blocker | 8 |

## Not yet specified (for the map)

- **Cockpit and Stall report: `in-flight n/B`.** v1 ships nothing new on the
  board: `compute-board.mjs`'s `claimed` stays, and standing decision 8 is met by
  the tick's `HOLD (in-flight n/B)` row and the Stall report's owner line. A
  board/stall `in-flight n/B` — the tick writing `inFlight` and `bound` into
  `heartbeat.json` and the board reading them — is a carry-over, after the
  cutover.
- **The guard's reading after the cutover**, and acting on a trip, are past the
  map's destination: the guard in ADR 0031 governs, and the first reading
  waits for ≥ 20 post-cutover merged PRs over ≥ 2 invocations (≈ 7.4 active
  hours at 2.72 merges per active hour) and for the `member-outcomes.tsv`
  re-scrape that gives signals 1, 2 and 4 any rows over the slot loop.
- **Two open PRs closing one issue** count two (§ 2); #2874 ruled "one ticket
  counts once" for the live-implementer-plus-PR hand-off and said nothing of a
  second PR on one ticket.
- **Unmeasured under the cap-free regime:** arrivals with no implementer cap
  and the collision cost at ≥ 5 concurrent implementers; the guard (§ 8)
  judges the default once ≥ 20 PRs have merged under it.
- **Whether `closingIssuesReferences` is truncated** on a PR closing many
  issues is not probed; `PR_LIMIT` (200) is unchanged.
