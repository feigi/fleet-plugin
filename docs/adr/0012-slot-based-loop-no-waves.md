# 0012 — The fleet loop is slot-based: no waves, reviews off the controller's turn, one merge pass per label

**Status:** Accepted. Ruled 2026-09-24 on #1773, #1774, #1776, #1777, #1778 (map #1768), against the measurements below. Amends ADR 0003 (point 9), ADR 0005 (floor placement), ADR 0007 (guard 1 trigger), ADR 0008 (§1).

## Context

- Today's staging "wave" is the phase-0 multi-select batch: the maintainer
  ticks what to stage, how many, what order, what collides (SKILL.md
  L577–586).
- Implementer refill is already level-triggered — "there are no implementer
  waves" (SKILL.md L923/L783) — yet still keyed to the staging: the pool is
  refilled per staging (SKILL.md L1087–1141), the alternate-tier implementer
  is one per staged wave (SKILL.md L773–812), `merge-bot-<wave#>` is a wave
  index (SKILL.md L72, L2802), and the merge bot batches "At 6+ open PRs"
  (SKILL.md L2901) and reaps after every wave (SKILL.md L2907–2987).
- The controller runs each review blocking its own turn 20–40 min, one at a
  time (SKILL.md L1880–1930) — "the cause of empty implementer slots and
  single-review concurrency" (map #1768).
- Merge latency is serialized CI, 48 min median (#1573).
- `Workflow` is non-blocking by tool design on Claude Code, and omp's `Agent`
  supports `run_in_background` (#1770).
- A `task`-dispatched `review-pr-<n>` member delivers its report the ordinary
  way while an unawaited promise hangs permanently at its first internal
  `await handle.wait()` and never delivers (#1771).
- `read proc://` is a one-call liveness census across every dispatched member
  (#1772).
- The four baseline numbers, measured over n=75 merged PRs, one continuous
  omp session (#1600–#1705): fleet `cache_creation` **1,078,459**/merged PR;
  controller `cache_creation` **133,720**/merged PR; implementer-slot idle
  ratio **0.906** (tighter activity-envelope variant **0.867**); review start
  latency median **8.8 min**, p90 **39.1 min** (max 425.3 min) — corrected in
  the merged research doc from an earlier revision's median 20.1 min, p90
  2586.4 min over 86 PRs, which matched any `PR #<N>` anywhere in a
  specialist/reviewer/finisher-role task rather than the review workflow's
  own start (#1769, `docs/research/baseline-efficiency.md`).
- `run-merge-bot.md` is 57 KB, ≈14k tokens per dispatch; median merge-bot
  dispatch reads 51k `cache_creation` on Claude, 130k on omp (#1776).
- The grace-sweep table below and "15 min is the knee": across 73 busy
  periods, grace avoided 4% of re-dispatches at 5 min, 18% at 10 min, 42% at
  15 min, 49% at 30 min, 60% at 60 min; past 15 min, a live bot costs more
  than a restart (#1774).
- Per Pull the controller emits ~1 KB of prompt instead of ~15.5 KB on
  Claude today, and instead of one 14.5 KB pool context per staging on omp;
  omp injects an agent body as the `§ Role` section of the member's system
  prompt, measured (#1777).

## Decision

1. **Reviews run off the controller's turn (#1773).** Claude dispatches a
   background `Workflow` (≤1 in flight until measured); omp dispatches a
   `fleet-review-runner` member `review-pr-<n>` that runs `runReviewOnOmp` to
   completion in its own kernel. The result lands at
   `<scratch>/review-<pr>.json`; the controller reads a digest, not the
   findings, and dispatches `fix-pr-<n>` with the path. The fix-applier owns
   every per-PR ruling (formerly the controller's): mutual-exclusion scans,
   suggested-fix quotes, deleted-text re-derivation, per-site measurement
   needs. A crashed specialist or refuter pair is retried once, in-run.
   Defaults: 2 implementers, 6 reviewers; no hard caps — review units are
   bounded by the ledger's live count, never remembered. Detail: spec § 3.
2. **The merge bot is dispatched on the first `ready-to-merge` label
   (#1774) — no wait for the finisher's report.** Standing decision 3's
   "after that PR's finisher report" is superseded: the rebase is
   server-side (`gh pr update-branch --rebase`), so nothing on the
   finisher's worktree needs to have happened first. A **Pass** is: the bot
   drains every labelled PR, re-evaluating the queue from scratch after each
   merge, then holds a fixed 15-minute grace polling labels every 60 s
   (Claude ≤4-min foreground Bash chunks under the 5-min cache cliff; omp
   one Python `eval` cell polling via `subprocess.run`, never `bash`+`wait`),
   then sends one report and exits. On the report, the controller writes
   `held-behind:#<lower>` into the ticket row, reaps always, and ticks. A
   label landing after the exit dispatches a fresh `merge-bot-<n+1>`
   immediately — "At 6+ open PRs batch a wave" is retired, there is no
   minimum queue depth. Merge-bot cap stays 1 and ADR 0007 is unchanged.
   The omp CI wait (`gh run watch`) also moves to an `eval` poll of
   `gh run view <run-id> --json status,conclusion`. Detail: spec § 4.
3. **The merge gate ships as `merge-gate.mjs --pr <n> --pre <sha>
   [--post <sha>] [--out <path>]` (#1776).** It runs `instruments.sh`,
   `gh pr view` (labels, `reviewDecision`, `headRefOid`), and
   `ci-state.mjs --pr <n> --declare-no-ci` (through the Resolver) as one
   read-only conjunction; it never merges, labels, or waits. Exit 0
   mergeable, 1 blocked (with `reason`), 2 could-not-evaluate; one JSON line
   written to `<scratch>/pr<N>/merge-bot-<n>/ci.json`. `run-merge-bot.md`
   step 3 becomes one rule with two invocations: run `merge-gate`, wait on
   `ci.runId` if in progress, run `merge-gate` again immediately before
   `gh pr merge`, and merge only on that second exit 0. This retires
   § Prove the gate blocks, the `jq` exit table, and the `--quiet` bullet,
   and both controller asks from #1776's grilling; the brief keeps the
   shell traps and the labelled-head timeline read. Detail: spec § 5.
4. **Implementer dispatch is one claim then one direct dispatch per Pull, on
   both harnesses (#1777).** The workpool is retired:
   `eval.workpool.freshAgents` stops being a precondition, `pool-preflight.mjs`
   and its test are deleted, and the `#1590` pair exception in
   `marked-pairs.mjs` is removed, not kept. The shared implementer background
   — the invariant verbatim blocks today quoted in SKILL.md — becomes the
   body of `plugin/agents/fleet-implementer.agent.md`, byte-identical in
   `fleet-implementer-alt.agent.md`; the per-Pull prompt carries only what
   varies: ticket number, distilled brief, worktree abs path, branch, and
   `<scratch>/impl-<N>/`. Implementer liveness input to the tick is
   caller-stated from the ledger on both harnesses: live implementers are
   `impl-<N>` rows with a dispatch and no outcome; `read proc://` is
   reserved for the Member-killed confirmation on omp, not the tick.
   Detail: spec § 2.
5. **Every wake ends in one `fleet-tick.mjs` run — record, tick, act, beat
   (#1778).** The six caller-stated flags
   (`--implementers --reviewers --merge-bots --pool --reviews-cap
   --merge-holds`) are deleted. The tick derives live members, holds, pool
   and supply from `.fleet/ledger.md` (`<member>` live, `<member>=<outcome>`
   settled, via `ledger.mjs dispatch|settle|drain`) and
   `.fleet/shortlist.json`, naming what it counts on every printed row:
   `PULL #N`, `DISPATCH fix-pr PR#M` then `DISPATCH review PR#M` (bounded by
   `--max-reviews`, Claude 1), `REFRESHED`, `HOLD`. A tier check runs per
   Pull (`tier-check.mjs --batch`) and the ADR 0005 floor over
   `tier-outcomes.tsv` is read at every alternate-tier Pull, not on "Pool
   empty → phase 0" — the guard's trigger is gone. The phase-3 edge list
   becomes a record-before-tick table (spec § 6 § 7). Detail: spec § 6.
6. **The word "wave" leaves the prose tree; `CONTEXT.md` gains Shortlist,
   Pull, Exclusion and Pass; Reap reads "after each merge pass".**
   `merge-bot-<n>` is numbered from the ledger's `## Dispatched` count per
   run, not a wave index. The cutover is breaking for metrics:
   `compute-spend.mjs`'s `/merge wave|merge-bot/` alternative is deleted, no
   legacy-name handling is added, and stored records (transcripts,
   `docs/metrics/*.tsv`, accepted ADRs, dated specs) are left as written.
   Detail: spec § 8.

## Guard — chosen before any further data

**Population:** the first ≥20 merged PRs after the cutover (the last prose
ticket of spec § 9 merged), per harness. Only omp has a baseline today
(`docs/research/baseline-efficiency.md`: n=75, #1600–#1705, one session);
the Claude Code leg is measured at the first Claude `/run-team` run that
merges ≥20 PRs — a scheduling gap, not an instrumentation one. Pre-cutover
rows are never read; stored records (transcripts, `docs/metrics/*.tsv`,
accepted ADRs, dated specs) stay as written.

| # | Signal | Baseline (omp) | Must |
|---|---|---|---|
| 1 | Fleet `cache_creation` per merged PR (Σ `tokens_cache_create` over every dispatched member with `role != memory`, ÷ n) | **1,078,459** | not rise |
| 2 | Controller `cache_creation` per merged PR (Σ `usage.cacheWrite` over the controller kernel's own assistant turns, ÷ n) | **133,720** | not rise |
| 3 | Implementer-slot idle ratio (1 − avg live implementers ÷ cap, time-weighted over the run) | **0.906** (activity-envelope variant 0.867) | fall |
| 4 | Review start latency, PR `createdAt` → review workflow start (the snapshot dispatch on Claude, `review-pr-<n>`'s `session_init` on omp — not the first specialist fan-out, which read 16.5 min / 246.8 min) | median **8.8 min**, p90 **39.1 min** | fall (both) |

**Method:** `python3 docs/research/baseline-efficiency-derive.py` against the
post-cutover session (its docstring names what to change); same events, same
`role` classifier.

**Trigger:** any signal in the wrong direction on that window. **Then:**
revisit the decision that owns the signal, with the measurement in hand —
signal 1: merges per pass first (past 15 min of idle a live bot costs more
than a restart), then the bot's brief size (the gate script is where guard
1 gets its margin); signal 2: the per-Pull prompt (the pool's 14.5 KB
context was the cost being retired); signal 3: the Pull path and refresh
triggers; signal 4: the reviewer cap, `--max-reviews`, and Claude's ≤1-in-
flight bound. Never reopen on fewer than 20 PRs. **Do not** read guard trips
as licence to reintroduce staging: automatic supply is ADR 0013's own
decision and carries the same guard.

## Consequences

- ADR 0003 point 9 amended: `eval.workpool.freshAgents`'s precondition is
  retired with the workpool; `enabledProviders` and the omp Tier routes
  (ADR 0011) remain — `CONTEXT.md` § Install's "Three exist" shrinks to two
  in the cutover ticket (spec § 9, T7).
- ADR 0005 amended: the `tier-outcomes.tsv` floor runs at every alternate-
  tier Pull; "Pool empty → phase 0" as its trigger is gone; the floor and
  the query themselves are unchanged.
- ADR 0007 amended: guard 1's trigger reads "a single pass in which the
  last PR waits more than 3 h"; the threshold is unchanged; the body text
  is intact.
- ADR 0008 amended: §1 reads "the controller records, then ticks" in place
  of "the controller restates its counts and runs `fleet-tick.mjs` itself";
  the Context bullet "the ledger records a dispatch, never a liveness, so
  nothing in the repo can be read for them" is superseded — the ledger now
  records both dispatch and settlement. §2–§8 are unchanged.
- `docs/specs/2026-07-22-run-team-agent-fleet-design.md` is superseded in
  part (blockquote, spec § 7).
- `.fleet/ledger.md` gains a `## Dispatched` append-only list and the
  `<member>`/`<member>=<outcome>` grammar.
- `pool-preflight.mjs` and its test are deleted; the `merge wave` alternative
  in `compute-spend.mjs`'s classifier is deleted, with no legacy-name
  handling added.
- Every prose pin listed in spec § 8 is rewritten in the spec § 9 tickets.
- The cockpit's reading of `excluded ·` rows and `=`-tokens is fog for the
  map, not this ADR (ADR 0013 § Fog).

## Rejected alternatives

- **Waiting for the finisher's report before dispatching the bot** — the
  rebase is server-side, so nothing on the finisher's worktree needs to
  have happened first (#1774 §1).
- **A minimum queue depth, "6+ batch"** — retired outright; re-dispatch is
  immediate (#1774 §9).
- **Workpool push-per-Pull** — the pool's only refill virtue (handing a
  queued item to a freed worker without a controller turn) is exactly what
  Pull forbids; a Pull pushes after a slot frees, and whenever the
  finishing implementer was the only live one the pool has already closed;
  per-item completion never arrives from a pool, `task` delivers each
  member's report natively; alt-tier is dispatched outside the pool, so
  `pool.status()` is blind to one implementer in five (#1777 Decision 1).
- **A fire-and-forget unawaited review promise on omp** — hangs permanently
  at its first internal `await handle.wait()` and never delivers (#1771).
- **A subagent invoking `Workflow`** — unconditionally "no" by tool design
  (#1770).
- **Caller-stated tick counts** — the six flags
  (`--implementers --reviewers --merge-bots --pool --reviews-cap
  --merge-holds`) are deleted; the tick derives every count itself (#1778
  §1).
- **Pooling the review fan-out** — ruled out on #1420; adjacent, not this
  destination (map #1768, Out of scope).
