# 0031 — One In-flight bound replaces the implementer and reviewer caps: Pulls hold at B tickets between Claim and merge, reviews never wait

**Status:** Accepted. Ruled 2026-10-09 on #2873, #2874, #2875 and 2026-10-13 on #2876 (map #2870), against the measurements below (#2871, #2872). Amends ADR 0012 (decision 1's "Defaults: 2 implementers, 6 reviewers; no hard caps", decision 2's "there is no minimum queue depth", the Guard), ADR 0013 (§ 5's refresh trigger, § 7's and Consequences' "gains no argument", the Guard). Amended by #3277: § Guard's history band is built from disjoint, adjoining pairs of N-PR windows — the N PRs at positions s … s+N−1 and the N at s+N … s+2N−1, for s = 0, K, 2K, …, the shape of the pre and post windows, one pair every K PRs — not from overlapping consecutive windows; the published ×2.23 cycle / ×0.68 throughput band and its 79 pairs are that construction's. The False-trip bullet's overlapping-band reasoning (24.9 % per test, about 82 % for any of the six) does not hold; the disjoint-pair rate it sets beside it (about 10 % per test, as #2875 ruled) does.
Amended by #4029: decision 3's table drops `held-behind` from its "Held or halted PR" row — the merge bot no longer holds a PR behind a lower one; the row's other holds and halts still count.

## Context

Code line numbers below are as read at ruling time (origin/main `bd4afac8`,
2026-10-13) and drift with every merge; re-grep before editing. Research notes
are `docs/research/in-flight-baseline.md`,
`docs/research/in-flight-lead-share.md` and
`docs/research/in-flight-cycle-time-stages.md`, each reproduced by its
`-derive.mjs` script beside it. PR #3160 carries the first two notes with
their scripts and PR #3161 the third; none is on `main` until those merge.

- Today the fleet is throttled by two caps and one hold. `fleet-tick.mjs`
  takes `--implementer-cap` (default 2), `--reviewer-cap` (default 6) and
  `--max-reviews` (`plugin/scripts/fleet-tick.mjs:1069-1073`);
  `/run-team [implementers] [reviewers]` passes them. The implementer row's
  `AT CAP` fires when live implementers reach the cap (`:196`); the reviewer
  row's `AT CAP` and `HOLD (max-reviews <n> in flight)` fire at the review cap
  (`:273-274`). `HOLD (review side saturated)` (`:206`) fires only when at
  least one PR is owed a review AND no reviewer slot is free. SKILL.md's
  Defaults paragraph sizes the reviewer side from a 1.95·I note (reviewer
  slots in use ≈ I·(T_review + 0.94·T_fix)/T_impl).
- No signal in that design is the number of tickets between Claim and merge.
  The cockpit already counts it as `claimed` (ledger rows past POOL short of
  MERGED, `plugin/scripts/compute-board.mjs:393`), but nothing reads it to
  gate a Pull. ADR 0012 guard signal 3 (implementer-slot idle ratio) reads
  **0.906** and must fall; a throttle raises it by design, so the guard and
  any bound cannot both stand.
- Population measured: the 400 most recently merged PRs, #1826–#2865, created
  2026-09-25T18:58:33Z → 2026-10-04T20:55:15Z, read off GitHub only
  (`docs/research/in-flight-baseline.md`; re-read cold 2026-10-05, every table
  identical). Every Pull in it ran under an implementer cap of 2.
- **Depth.** In-flight depth (open PRs) time-weighted mean **5.02** while at
  least one PR was open, max **15** (2026-10-04T09:13:30Z); depth already open
  at a PR's creation median / p75 / p90 **5 / 7 / 9** (max 14). Depth is a
  lower bound on in-flight: Claim → PR-open is invisible on GitHub.
- **Cycle.** Created → merged median **1.38 h**, p75 2.37 h, p90 **5.23 h**.
  By depth at arrival (0–2 / 3–5 / 6–9 / 10+) the median is
  **1.16 / 1.27 / 1.62 / 1.82 h**. About half of that gradient is which day
  the PR arrived (Spearman ρ 0.20 → 0.06 after demeaning by creation day).
  The p90 tail is the 2026-09-30/10-01 Pass gap (one merge in 28.6 h), not
  depth.
- **Label → merged.** Last `ready-to-merge` → merged median **15 min**, p90
  65 min, **6.8 %** over 90 min (n = 398 labelled; the latest 150 merged read
  p90 93 min, 10.7 %); ADR 0007 guard 1 (median above 90 min) is not tripped.
  Created → first label median 0.88 h; 45 of 398 were relabelled.
- **Throughput.** **2.72** merged PRs per active UTC clock hour (147 active of
  218.7 wall hours); 1.89 per open-time hour (Little's law closes: 5.02 ÷ 1.89
  = 2.65 h = mean cycle); 40 per active day.
- **Where cycle time goes** (`docs/research/in-flight-cycle-time-stages.md`).
  From the 3–5 to the 10+ depth bucket (200-PR window) open → first review
  evidence *falls* 28 → 21 min while first `ready-to-merge` → merged rises
  16 → 31 min and review evidence → first label rises 21 → 34 min: the extra
  time sits after the review. Label → merged tracks how many lower PRs are
  already labelled ahead — 12 min / 16 min / 27 min / 1.58 h at 0 / 1 / 2–3 /
  4+ (ρ 0.50) — at a flat 8–9 min per merge; lower PRs merely open carry
  nothing (ρ 0.08). On the 400 window the ready-queue depth at label time
  predicts label → merged at ρ 0.48 against 0.14 for depth at arrival, so a
  bound trims that queue only by trimming arrivals; it does not speed the
  merge gate. Genuine label churn is 8 of 200 (4 %); 32 of 36 relabels are a
  4-s re-pin flip. Same-day arrivals explain nothing (ρ 0.04). "Depth is a
  symptom of a slow merge side" was tried and refuted: merge throughput is
  higher at depth (ρ +0.32).
- **A bound of 8, replayed.** It would have held **90 of 400** Pulls (22.5 %),
  82 of them on 10-03/10-04; their cycle median read 1.65 h against 1.29 h.
  That undercounts, because it measures open-PR depth only. With the
  implementer phase counted (L = 19.3 min, the median T_impl;
  `docs/research/in-flight-lead-share.md`) the held share of Pulls is
  **B=5 68.3 %, B=6 54.5 %, B=8 28.8 %** (98 of 115 on 10-03/10-04),
  **B=10 17.3 %**; held vs not held cycle median at B=8 is 1.56 vs 1.30 h. The
  mean in flight with the implementer phase counted is **5.6** (5.56).
- **Ceilings.** Little's law at B=5, on the means (cycle 2.65 h plus the
  0.32 h implementer phase): 5 ÷ 2.97 h ≈ **1.7** merges per open-time hour
  against 1.89 measured, which needs ≈ 5.6 in flight, the measured mean. The
  merge gate saturates near 10–11
  in flight: μ 7.12 merges/h × (T_impl 19.3 min + W₀ 1.16 h) ≈ **10.5**, so a
  bound past that buys nothing. The review side is about **84 %** of
  cache-write tokens, fanning out to 1 snapshot + up to 6 specialists + 2
  refuters per finding.
- **omp's semaphore** (`omp://tools/task.md`, quoted in
  `docs/research/omp-review-offturn.md` § (d)): one session-scoped
  `Semaphore`, resized in place from `task.maxConcurrency` (default 32, `0`
  unbounded), bounds concurrent subagents, **queues at the ceiling rather than
  refusing**, and exists once per `TaskTool` instance, so a member's own
  fan-out runs on its own counter. It counts live members, not tickets. The
  fleet reads and writes it nowhere; SKILL.md's `--max-reviews` note already
  leans on it.
- A PR carries at most one live review unit at a time (a review, a fix-applier
  or a finisher), so review units ≤ open PRs; with the bound capping open
  PRs, the reviewer cap was redundant.

## Decision

1. **The signal is the In-flight count; the lever is a hard bound on it, an
   implementer-row `HOLD` in `fleet-tick.mjs` (#2870 standing decisions 2, 3).**
   In flight is every ticket between its Claim and its PR's merge, read against
   one number, the **In-flight bound** B. Reaching it holds every Pull until a
   merge brings the count below B; Pulls resume as merges land. The signal is
   not review-side depth, not merge-side latency or queue depth, not an
   arrival-vs-merge rate. Reviewers, finishers and the merge bot never slow for
   it. The bound is the fleet's operating level, not a burst ceiling: with live
   implementers = B − In-flight PRs, the fleet fills to B whenever the
   Shortlist has work, so "a cap in disguise" is the design. Detail: spec § 1.
2. **One argument: `/run-team [in-flight]` (#2873).** It replaces
   `[implementers] [reviewers]`; `--implementer-cap`, `--reviewer-cap` and
   `--max-reviews` become one tick flag, `--in-flight <B>`.
   - **Default 5**, set by load, not throughput. B caps live review units (≤
     open PRs ≤ B; the review side is ~84 % of cache-write tokens), so 5 keeps
     worst-case review concurrency below the old reviewer cap (6) and the
     start-of-run burst at 5 implementers. It sits near the measured mean in
     flight (5.6) and the operator's hand-held 2026-10-08 run. By Little's
     law, on the means (cycle 2.65 h plus the 0.32 h implementer phase), B=5
     allows ≈ 1.7 merges per open-time hour against 1.89 measured, so the
     default does not rest on throughput headroom and the guard's throughput
     test (3b) may trip on it; the merge gate saturates near 10–11, so raising
     B past that buys nothing. 8 was rejected:
     peak review concurrency above today's, for a throughput gain the backlog
     does not show it needs.
   - **Fixed for the run**, overridable by the argument, never adapted live in
     v1. The bound limits how far ahead the fleet implements, not how fast:
     Pulls restock as merges land. No formula in code: the constant lives once,
     as the tick's `"in-flight"` option default; SKILL.md states it in the
     arguments line and one Defaults paragraph, which replaces the 1.95·I note
     with this rationale and keeps the re-derive rule — once ≥ 20 PRs have
     merged under it, never from one run's rows. The description drops
     "(default 2 and 6)".
   - **Floor and ceiling.** B ≥ 1 through the tick's `positive()` digits-and-≥1
     rule (`fleet-tick.mjs:1105`); **0 is refused** (draining is how you stop
     implementing); no notice at B = 1; **no upper cap**. The operator-facing
     ceiling is the phase-0 semaphore notice (decision 7).
   - **Inheritance.** A run that folds in more open issue-closing PRs than B
     starts fully held: no Pull until merges bring In flight below B, while
     reviewers, finishers and the merge bot work the inherited PRs. Phase 0
     prints no separate line; the first tick's `HOLD (in-flight 7/5)`-style row
     is the notice.
   - The tick's `parseArgs({ options: OPTIONS })` is strict (`:1090`), so an
     unknown `--implementer-cap` throws: the old flags are removed, not
     tolerated. Detail: spec § 1.
3. **What is In flight (#2874).** n = the number of open PRs that close an
   issue, plus claimed tickets with a live implementer (or one owed a
   replacement) that no open PR closes yet. The unit is the PR for a PR and
   the ticket for a ticket no PR has absorbed: a PR counts once however many
   issues it closes, and a ticket counts once, which covers the moment an
   implementer has opened its PR but not yet reported. Two open PRs closing
   one issue count two (spec § 2; #2874 did not rule that case). The edge
   cases:

   | Case | Counts? | Why |
   |---|---|---|
   | Open PR that closes an issue | yes | between Claim and merge |
   | Claimed ticket, live `impl-` member, no open PR yet | yes | between Claim and PR |
   | Newest `impl-` member settled `killed` or `tier-mismatch` on an open issue (replacement owed) | yes | the replacement `impl-<N>-b` is not a Pull and is never bound-held; already counted, it fits by construction (n stays ≤ B, no Pull takes its slot) |
   | "Implementer blocked or ambiguous mid-implementation" (slot freed, `in-progress` stays) | **no** | the failure-handling row frees the slot and the ticket waits for a human; settle outcome `blocked` (decision 8) |
   | Held or halted PR (`conflict-hold`, `held-behind`, a finisher halted `past-pin`, `dispositions-escalate`, a finisher that settled `failed`/`killed`) | yes | still between Claim and merge; the full stop is accepted (decision 4) |
   | Exclusion row (`excluded · behind-pr:#M` / `behind-issue:#M`) | **no** | gates the claim — no claim, no member; the PR it waits behind counts in its own right if that PR closes an issue |
   | Inherited issue-closing PR (a prior run's) | yes, from the first tick | the count reads `gh`, not the phase-0 fold |
   | Human-authored or draft issue-closing PR | yes | `openPrs()` filters neither author nor draft, and the fleet reviews and merges them |
   | Chore PR closing nothing, this run's or inherited | **no** | never In flight; the same filter as the tick's review-due test |

   `failed` is not an `impl` outcome (`plugin/scripts/ledger-grammar.mjs:27`:
   `PR#M | bailed | released | killed | tier-mismatch`), so no row settles an
   implementer `=failed`. Detail: spec § 2.
4. **The hold (#2874).**
   - `HOLD (in-flight <n>/<B>)` **replaces the implementer row's `AT CAP`
     outright**: one condition (n ≥ B), one wording, whatever mix of members
     and PRs makes up n. The row prints `n/B` (actual = In flight, target =
     the bound); detail `implementers=<i> prs=<p> unclaimed=… supply=…`;
     `acts: false`.
   - **Rank:** the main-checkout overlay > `HOLD (draining)` > `HOLD (tier
     mismatch …)` > `HOLD (tier unchecked …)` > `HOLD (in-flight …)`. The tier
     holds need the controller to act, so they stay visible while the bound
     also holds. The rank only decides which `HOLD` row prints; it is never a
     guard remedy.
   - **Pull count: one head per free slot**, `heads.slice(0, B − n)`. The
     start-of-run and post-Pass burst — up to B Pulls back to back — is
     accepted: Phase 1 is serial, the Pull's collision check excludes
     overlapping tickets, and omp's `task.maxConcurrency` is the operator's
     ceiling on live members.
   - **Replacements are not Pulls** and are never bound-held (decision 3).
   - **The full stop.** A fleet whose every In-flight slot is held by a PR
     nothing can merge without a human stops implementing. **No escape hatch in
     v1.** The Stall report names the held count and whose move it is (its
     owner line).
   - **No durable record** beyond the printed line and the tick's state file:
     the guard's signals all come from GitHub, and none reads the tick's own
     held time.
   - **Heartbeat: no new rule.** A tick held by the bound is quiet. During a
     Pass each rebased candidate's CI-terminal event wakes the controller
     within about one CI cycle and the Pass report wakes it at the end; that
     tick prints `PULL`, which resets the back-off. Worst case is a PR closed
     without merging, which waits for the 20-min heartbeat ceiling.

   Detail: spec § 3.
5. **The reviewer row is uncapped (#2874).** It dispatches every fix and
   review that is due, with no cap, and prints `<units>/<B>`: units ≤ open PRs
   ≤ B by construction, and an inherited run over B shows the overflow
   honestly. **Deleted**, with their `fleet-tick.test.mjs` cases and
   SKILL.md prose pins: `HOLD (review side saturated)` (unreachable once no
   reviewer cap exists), `HOLD (max-reviews <n> in flight)`, and the reviewer
   row's `AT CAP`. The merge-bot row's `AT CAP` (cap 1, ADR 0007) is
   unchanged. Detail: spec § 4.
6. **Shortlist refresh at unclaimed < B, and none while `HOLD (in-flight …)`
   stands (#2874; amends ADR 0013 § 5).** B is the most a full deficit can
   Pull, so § 5's "cap, not cap − live" buffer carries over with B as the
   cap. A refresh while held cannot feed a Pull, and skipping it keeps B=5
   from refreshing on every tick while supply is thin. Detail: spec § 5.
7. **The phase-0 semaphore notice (#2874).** omp's `task.maxConcurrency` is
   not the bound: it counts live members, not tickets; it queues rather than
   refuses, so a Pull meeting it would leave a claim with no running
   implementer; and it is session-wide. Phase 0 reads it against B and prints a
   **notice, never a hold**; the fleet never writes it (Install-time
   precondition rule). `tier-roles.mjs --check` gains `--in-flight <B>`,
   **required under `--check`** (leaving it out is a usage error); it reads
   `task.maxConcurrency` with the merged `omp config get <key> --json`
   (measured: unset returns the default 32), runs once per run before the
   first dispatch, and never changes the exit code. Notices use the existing
   channel (stdout on a pass, stderr after violations: the two
   `for (const n of notices)` loops in `main()` of
   `plugin/scripts/tier-roles.mjs`). Lines, for B=5 and c =
   `task.maxConcurrency`:
   - c ≥ 2·B+2, or c = 0 (unbounded): no notice line. At B = 5 the notice
     fires below 12.
   - c < 2·B+2: `tier-roles: notice: task.maxConcurrency is 8, below 2·5+2 = 12
     for In-flight bound 5 — omp queues members past it, so a Pulled
     implementer may sit unstarted; raise it in omp config (the fleet never
     writes it)`
   - unreadable: `tier-roles: notice: task.maxConcurrency unreadable —
     <why>; In-flight bound 5 is unchecked against it`

   Detail: spec § 6.
8. **`blocked`: the settle outcome for a mid-implementation block (#2874,
   closing grilling 2026-10-13).** A new `impl` outcome **`blocked`**: the slot
   is freed, the claim and `in-progress` stay, no replacement is owed, and the
   ticket is **not** In flight. `released` is wrong for it because the claim
   stays. `ledger-grammar.mjs` outcomes gain it, `ledger.mjs settle` accepts it,
   SKILL.md's failure-handling row for "Implementer blocked or ambiguous
   *mid-implementation*" and its settle-outcomes list name it, and the tick's
   In-flight derivation excludes a row whose newest `impl-` token settled
   `blocked`. Detail: spec § 7.

## Guard — chosen before any further data

The guard is a section of this ADR, not an ADR of its own: it is how the
bound's decision gets checked and cannot stand without it. It replaces ADR
0012's Guard (restated in ADR 0013); its remedies are chosen here, before any
reading.

**Signals.** Six tests over four signals; every figure is a ratio post ÷ pre
over the windows below, tripped on a margin, not on direction (Trip rule).

| # | Signal | Direction | Read from |
|---|---|---|---|
| 1 | Fleet `cache_creation` per merged PR (Σ `tokens_cache_create` over dispatched members with `role != memory`, ÷ n) | must not rise | `docs/metrics/member-outcomes.tsv`, booked per PR the way `plugin/scripts/pr-cost.mjs` does (omp rows only; merge-bot, `memory` and `__advisor` rows stay unbooked) |
| 2 | Controller `cache_creation` per merged PR (Σ `usage.cacheWrite` over the controller kernel's own assistant turns, ÷ n) | must not rise | controller transcripts, as `docs/research/baseline-efficiency-derive.py` reads them (rows dated within the window's created span) |
| 3a | Cycle time created → merged, **median** (replaces idle ratio) | must not rise | GitHub PR `created_at` / `merged_at` |
| 3b | Merged PRs per **active clock hour** (replaces idle ratio): a UTC hour in which at least one PR in the population was created or merged | must not fall | GitHub, the baseline script's primary definition |
| 4a | Review start latency, PR `createdAt` → review workflow start (`review-pr-<n>`'s `session_init`), **median** | fall | `docs/metrics/member-outcomes.tsv`, per PR |
| 4b | The same, **p90** | fall | `docs/metrics/member-outcomes.tsv`, per PR |

- Signal 3 (implementer-slot idle ratio) is replaced by 3a and 3b: a throttle
  raises the idle ratio by design. **In-flight depth p90 at arrival is
  dropped as a signal** — the hold caps it by construction, so the tick's tests
  cover it. Signals 1, 2 and 4 keep their directions. The Claude Code leg and
  the "per harness" wording go (ADR 0014). Signal 4 keeps "fall" and trips on
  its rise side, as Then's "Signal 4 rises" names it.
- **No signal reads the tick's own held time**, so no held-time record exists
  and decision 4's "no durable record" stands.

**Population and windows.** Paired neighbouring windows, same scripts, rule
fixed now, numbers measured at the cutover. **N = 20**, matching the guard's
existing "never reopen on fewer than 20 PRs".

- **Cutover:** the start of the first `/run-team` whose phase-0 fast-forward
  and instruments pin include the merge of the spec's ticket that changes
  which PRs get Pulled — the `fleet-tick.mjs` ticket; a notice, prose or
  script ticket moves no Pull and does not move the pin. It is read from the
  first timestamp in that run's omp session file under
  `~/.omp/agent/sessions/-dev-fleet-plugin/`. A run already going at the merge
  never picks up the new rules mid-run, so it belongs to neither side.
- **Pre window:** the 20 merged PRs created most recently before that merge.
  **Post window:** the first 20 merged PRs created after the cutover, spread
  over at least two `/run-team` invocations. PRs created between the merge and
  the cutover count in neither window. At 2.72 merges per active hour the post
  window fills in ≈ 7.4 active hours.
- **Step 0 of every reading:** re-scrape `docs/metrics/member-outcomes.tsv`
  with `member-outcomes.mjs`. As of 2026-10-09 it has no rows dated 2026-09-25
  or later (the last omp `run_date` is 2026-09-22), so signals 1, 2 and 4 could
  not yet be read over the slot loop; their band (below) needs those rows.
- **Fleet rows** are booked to the window's PRs; **controller rows** are those
  dated within the window's created span.

**Wave-era baselines lapse unread.** ADR 0012's Guard was never read after its
cutover. Its numbers — signal 1 = 1,078,459, signal 2 = 133,720, signal 3 =
0.906, signal 4 = 8.8 min median / 39.1 min p90, n = 75 (#1600–#1705) —
describe a loop that no longer exists. The pre window above is the slot loop's
first recorded reading.

**Trip rule — a margin from the slot loop's own history, not a direction.**
For each test the script computes the ratio of consecutive same-size windows
(window k+1 ÷ window k) across the slot-loop history before the cutover, from
2026-09-25T18:58:33Z to that merge (20-PR windows,
offset 5). A test trips when post ÷ pre lands **past the one-sided p90** of
those ratios: above it for a "must not rise" test, **below the p10** for a
"must not fall" one. The band is computed at the cutover from the same history
the pre window ends. There are six tests: cycle (3a), throughput (3b), signal 1,
signal 2, signal 4's median (4a) and p90 (4b).

- **Why a margin.** With no change at all, consecutive 20-PR windows over that
  history (79 pairs, offset 5) move the "wrong" way **53 %** of the time for
  cycle and **48 %** for throughput. ADR 0012's "any signal in the wrong
  direction" would trip on almost every reading.
- **False-trip arithmetic.** On today's data the band is **×2.23** for cycle
  (trips above) and **×0.68** for throughput (trips below). A one-sided p90
  of *disjoint* windows would give about **10 % false trips per test**. The
  band here comes from windows that overlap (N − K = 15 of 20 PRs shared),
  and their ratios spread less than a pre and a post window that share no PR,
  so the rate is higher: an iid lognormal null model fitted to the baseline's
  median 1.38 h and p90 5.23 h gives **24.9 %** false trips for the cycle
  test with the overlapping band against 10.2 % with a disjoint-pair band
  (4000 trials; a model figure, not a measurement — the model's band is
  ×1.29 against the real ×2.23). With all six at that rate and independent,
  any of the six trips about **82 %** of the time (1 − 0.75⁶); less, since
  the tests are correlated. A trip means revisiting the owning decision with
  the measurement in hand, never a rollback, so a false trip costs one look.
- **Limit.** At N = 20 the guard catches only harm of roughly 1.5–2× or more.

**Script.** `docs/research/in-flight-guard-derive.mjs`, extending
`docs/research/in-flight-baseline-derive.mjs` (`--after ISO --n N`). It
computes the pre and post windows, the per-test band and the six verdicts, and
takes `--cutover <ISO>`. It is a ticket in the spec, not a cutover blocker.
Re-run recipe: spec § 8.

**Then — what each trip revisits first** (with the measurement in hand):

- **Throughput falls** → the default bound first (at B = 5, 68 % of past Pulls
  would have been held), then the definition of In flight (held and halted
  PRs taking slots, decision 3). **Never the hold's rank.**
- **Cycle rises** → re-run the stage-decomposition script
  (`docs/research/in-flight-cycle-time-stages-derive.mjs`) on both windows. A
  rise in first `ready-to-merge` → merged belongs to ADR 0007 guard 1 (the merge
  side, outside this ADR). A rise in Claim → open, open → review evidence, or
  evidence → label revisits the default bound.
- **Signal 1 rises** → the default bound first (it is the load lever), then
  ADR 0012's existing order: merges per pass, then the bot's brief size.
- **Signal 2 rises** → unchanged: the per-Pull prompt.
- **Signal 4 rises** → the reviewer row's uncapped dispatch first (decision
  5), then the operator's `task.maxConcurrency`, which the phase-0 notice
  already reports (decision 7).
- **Do not** read a trip as licence to reintroduce staging **or the
  implementer and reviewer caps**: automatic supply is ADR 0013's own
  decision, and this ADR's bound is the cap's replacement. Taking the
  reading, and acting on a trip, is past this ADR's destination.

## Consequences

- **Retires:** `--implementer-cap` (default 2), `--reviewer-cap` (default 6)
  and `--max-reviews` (replaced by `--in-flight`, default 5);
  `HOLD (review side saturated)`, `HOLD (max-reviews <n> in flight)` and the
  reviewer row's `AT CAP`, each with its `fleet-tick.test.mjs` cases and prose
  pins; the Defaults paragraph's 1.95·I sizing note; and
  `/run-team [implementers] [reviewers]` — SKILL.md's `argument-hint`, its
  `$ARGUMENTS` paragraph, the tick invocation, the caps and `--max-reviews`
  paragraphs, § Queue depth, `README.md`'s invocation line and the description's
  "(default 2 and 6)" — in favour of `/run-team [in-flight]`. ADR 0013 § 7's
  "gains no argument" is superseded by the one argument. The merge-bot row's
  `AT CAP` and cap of 1 (ADR 0007) stay.
- **What the operator sees:** Pull rows until n reaches B, then a quiet
  `HOLD (in-flight n/B)` on the implementer row; a reviewer row `<units>/<B>`
  that never blocks a dispatch; at phase 0 a `tier-roles` notice when
  `task.maxConcurrency` < 2·B+2 (12 at B = 5); an inherited run over B starts
  held with e.g. `7/5` and Pulls nothing until merges bring the count below B.
- **The full stop is accepted.** A fleet whose every slot is held by a PR no
  agent can merge stops implementing until a human moves one; the Stall
  report's owner line names whose move it is. There is no escape hatch in v1.
- **The burst is accepted:** up to B Pulls back to back at the start of a run
  and after a Pass. Held share at B = 5 is 68.3 % of past Pulls
  (implementer phase counted), so the bound will bind often; that is the
  operating level, not a fault.
- **Cutover hazard, accepted:** between the `fleet-tick.mjs` ticket and the
  prose ticket a default run ticks on the new rules under prose that still says
  "2 implementers, 6 reviewers", and an argument-invoked run passes
  `--implementer-cap`, which the strict `parseArgs` refuses at the first tick.
  Blockers-first ordering pulls the prose ticket right behind it; the cutover
  is not atomic.
- **`docs/metrics` is unaffected:** no column names a cap or the bound, and no
  held-time record exists.
- **Cockpit: one flag line in v1.** `compute-board.mjs`'s `claimed` is the
  ledger half of In flight and stays as is; `deriveFlags` gains `blocked` for
  a settled `impl-<N>=blocked` row (spec § 7); standing decision 8 is met by
  the tick's `HOLD (in-flight n/B)` row and the Stall report's owner line. The
  Stall report still prints "N ticket(s) claimed and in flight" (that is the
  ledger half, not the In-flight count) and `CONTEXT.md`'s **Stall report**
  entry keeps matching it; rewording both, with a board/stall `in-flight n/B`
  (the tick writing `inFlight`/`bound` into `heartbeat.json`), is a
  carry-over, after the cutover.
- `CONTEXT.md` § Loop gains **In flight** and **In-flight bound**.
- ADR 0012's and ADR 0013's `**Status:**` lines carry the amendment; their
  bodies are unchanged. ADR 0012 decision 2's "there is no minimum queue
  depth" narrows and does not reverse: the merge bot still dispatches on the
  first label and is never gated, and only Pulls are gated, on the In-flight
  count (spec § 9).
- ADR 0007 is unchanged: guard 1 still governs the merge side, and the guard
  here hands a rise in first `ready-to-merge` → merged to it.
- Out of scope here: parallel merge bots and overlap-proof currency (ADR 0007
  guard 1), tuning omp's `task.maxConcurrency` (the operator's setting), and
  per-ticket model+effort routing (map #2030).

## Rejected alternatives

- **Review-side depth as the signal** — a PR carries at most one live review
  unit, so review units ≤ open PRs ≤ B: the bound on tickets already bounds
  review depth (#2870 standing decision 2).
- **Merge latency or merge-queue depth as the signal** — the extra cycle time
  at depth is label → merged and tracks the labelled queue ahead (ρ 0.50, flat
  8–9 min per merge), which a bound trims only by trimming arrivals; it does
  not speed the gate, and the merge bot is never gated (ADR 0012 decision 2).
- **An arrival-vs-merge rate** — depth is the running difference of arrivals
  and merges, and the baseline closes Little's law on it (5.02 ÷ 1.89 =
  2.65 h = mean cycle); the count already is the signal (#2870 standing
  decision 2).
- **omp's `task.maxConcurrency` as the bound** — it counts live members, not
  tickets; it queues rather than refuses, so a Pull meeting it would leave a
  claim with no running implementer; and it is session-wide (decision 7).
- **Default 8** — peak review concurrency above today's, for a throughput gain
  the backlog does not show it needs; the merge gate saturates near 10.5, and
  Little's law on the means puts B = 5 at ≈ 1.7 merges per open-time hour
  against 1.89 measured, a gap the guard's throughput test (3b) reads (#2873).
- **An adaptive bound** — v1 never adapts live; the bound limits how far ahead
  the fleet implements, not how fast, and a derivation re-run under the ≥ 20
  PR rule is a check, not a formula in code (#2873).
- **An escape hatch for a fully held fleet** — no signal reads held time, and a
  bypass is a second admission path with no measurement behind it; the full
  stop is visible and its owner named instead (standing decision 8).
- **A reviewer cap kept beside the bound** — redundant: review units ≤ open
  PRs ≤ B (decision 5).
- **`HOLD (review side saturated)` kept** — unreachable once no reviewer cap
  exists, and it throttles on live members, not tickets (decision 5).
- **Keeping guard signal 3 (implementer-slot idle ratio)** — a throttle raises
  it by design, so it must fall and cannot (#2875).
- **A plain direction test for the guard** — consecutive no-change windows move
  the wrong way 53 % (cycle) and 48 % (throughput) of the time, so ADR 0012's
  trigger would trip on almost every reading (#2875).
- **A durable held-time record** — no signal reads it (#2874 decision 11,
  #2875).
