# Slot-based fleet loop — no waves, off-turn reviews, automatic supply

Date: 2026-09-24
Status: decided on map #1768 (2026-09-24); accepted as ADR 0012 and ADR 0013; handed to `/to-tickets` (§ 9).
Map: feigi/fleet-plugin#1768. Decision tickets: #1773, #1774, #1775, #1776, #1777, #1778; baseline #1769.
ADRs: `docs/adr/0012-slot-based-loop-no-waves.md`, `docs/adr/0013-automatic-supply-relabel-by-cause.md`.
Supersedes in part: `docs/specs/2026-07-22-run-team-agent-fleet-design.md` (phase 0 multi-select and its invariant, phase 3 edge list, merge-bot waves).
Relates to: `docs/research/baseline-efficiency.md`, `docs/research/claude-workflow-offturn.md`, `docs/research/omp-liveness-pool.md`.
Line numbers below are against `origin/main` `6f2c654` (2026-09-24) and drift; re-grep before editing.

## Why (measured)

The map's own "Measured premises," verbatim: *the controller runs each
review blocking its own turn 20–40 min, one at a time (SKILL.md
L1880–1930) — the cause of empty implementer slots and single-review
concurrency; merge latency is serialized CI, 48 min median (#1573).*

`docs/research/baseline-efficiency.md` § Results, over n=75 merged PRs, one
continuous omp session (#1600–#1705): fleet `cache_creation` **1,078,459**
per merged PR (total 80,884,397 across every dispatched member with
`role != memory`, ÷ 75); controller `cache_creation` **133,720** per merged
PR (total 10,029,018, summed from the session's own top-level assistant
turns, never a subagent file, ÷ 75); implementer-slot idle ratio **0.906**
(90.6%), a tighter activity-envelope-bounded variant reading **0.867**;
review start latency median **8.8 min**, p90 **39.1 min** (max 425.3 min).
"An earlier revision of this note matched any `PR #<N>` anywhere in a
specialist/reviewer/finisher-role task and reported median 20.1 min, p90
2586.4 min over 86 PRs" — the wrong metric, corrected in the merged doc.
"32 of the 75 were launched within 5 s of another PR's launch — the
controller started those reviews in batches."

The brief's fixed cost is the lever #1774 named: `run-merge-bot.md` is
57 KB, ~14k tokens per dispatch; median merge-bot dispatch reads 51k
`cache_creation` on Claude, 130k on omp (#1776). The grace-sweep table
(#1774, across 73 busy periods in two windows):

| Grace | Re-dispatches avoided | Idle bot-minutes |
|---|---|---|
| 5 min | 4% | 362 |
| 10 min | 18% | 700 |
| **15 min** | **42%** | **943** |
| 30 min | 49% | 1,529 |
| 60 min | 60% | 2,519 |

15 min is the knee. From 15 to 60 min the bot spends about 121 extra
minutes per avoided dispatch. On Claude that is roughly 3x the cost of the
dispatch it avoids (median dispatch: 51k `cache_creation`). On omp it
passes the "60 min cache-cold point and costs about the same as a dispatch
(median 130k)."

Per Pull the controller emits "~1 KB of prompt instead of ~15.5 KB on
Claude (status quo today) and instead of one 14.5 KB pool context per
staging on omp — so guard signal 2 (controller `cache_creation`/PR) does
not rise on either harness from retiring the pool" (#1777). #1773's own
sizing note for the spec: reviewer slots in use ≈ I·(T_review +
0.94·T_fix)/T_impl ≈ 1.95·I (medians since 2026-08-07: T_impl 19.3 min,
T_fix 21.0 min, T_review ~18 min; 0.94 fix-appliers per review) — so at
the default ~4 of 6 are already busy; idle slots cost nothing.

## Vocabulary

Defined in `CONTEXT.md` § Loop: **Shortlist** — the ordered list of
tickets the controller may admit. **Pull** — admitting one ticket into one
free implementer slot the moment it frees. **Exclusion** — a ticket ruled
inadmissible for now, recorded with its premise. **Pass** — one merge
bot's lifetime, from dispatch-on-label to its one exit report.

## 1. Supply

Source: #1775

*Shortlist* (artefact): `.fleet/shortlist.json`, ordered oldest-first, produced by `shortlist.mjs`; `fleet-tick.mjs --pool` is derived from its unclaimed depth (G6 owns the tick's reading).
*Pull* (event): one free implementer slot → the sequence in Decision 2, terminating in one dispatch or an empty shortlist.
*Exclusion* (record): a ticket row `excluded · behind-pr:#M | behind-issue:#M`; lifted at refresh when the premise's state is MERGED/CLOSED.

Change surface: SKILL.md phase 0 L230–588 (steps 4–6 removed, steps 1–3 pointed at `shortlist.mjs`), L763–776 (alt-tier per staging → per 5th Pull), L1500–1501 (exception removed), L1510–1528 (bail table becomes the Pull table, reclassify sentence reversed), L3405–3410 (row vocabulary gains `excluded ·` and `tier=alt`); `fleet-tick.mjs` `readSupply()` L559–602 and `implementers()` L198–200 (`RE-SHORTLIST` rows lose "ask the maintainer to tick"); `plugin/agents/fleet-implementer-alt.agent.md` ("one per wave"); `references/member-lifecycle.md` naming list unchanged here (G2). New: `shortlist.mjs` + test; `merge-bot pass done → refresh` edge is G6's.

The decision itself is ADR 0013 § Decision, items 1–7 (verbatim from
#1775); the relabel comment templates live there.

## 2. Implementer dispatch

Source: #1777

**1. Direct dispatch per Pull on both harnesses. The workpool is retired.**

Rule (both harnesses): **a Pull is one claim followed by one dispatch of a new member under a name no member has held; nothing holds a queue.**
CLAUDE: one more `Agent` call, `subagent_type: "fleet-ctl:fleet-implementer"` (`-alt` on the 5th Pull per #1775), `run_in_background: true`.
OMP: one more `task` call, `agent: fleet-implementer` (`fleet-implementer-alt` on the 5th Pull), `name: impl-<N>`.

Not `eval`'s `agent()`: a kernel-resident handle keeps the lost-kernel rule alive and needs a `wait`; `task` jobs are process-level and their reports auto-deliver individually.

Why the pool loses under Pull:
- The pool's only refill virtue — handing a queued item to a freed worker without a controller turn (SKILL.md L1121) — is exactly what Pull forbids (admission per slot, never batched). Push-per-Pull carries zero queue depth.
- A Pull pushes *after* a slot frees. Whenever the finishing implementer was the only live one (at cap 2: any time the other slot was idle — empty shortlist, refresh, run tail), the pool has already closed → every Pull would need a closed-check, a monotonic `impl-pool-<n>`, and a fresh preflight, for nothing.
- Per-item completion never arrives from a pool (L1190–1193); `task` delivers each member's report natively.
- Alt-tier is dispatched outside the pool (L1166) → `pool.status()` is blind to one implementer in five.
- One same-rule Pair: the two marked lines differ only in tool name. The `#1590` entry in `marked-pairs.mjs` `KNOWN_EQUALITY_EXCEPTIONS` (L294–297) is deleted, not kept.
- `eval.workpool.freshAgents` stops being a precondition: `task` children start blank by construction.

**2. The shared implementer background moves into the agent definition.**

The invariant verbatim blocks (SKILL.md L1245–1480 today: unattended-member, `edit`/`read` absolute-path (#1727), re-derive claims, `gh issue view` backstop, commit incrementally, no `git stash`, shared `eval` kernel (#1447)) — 14,503 bytes over 203 quoted lines — become the **body of `plugin/agents/fleet-implementer.agent.md`**, byte-identical in `fleet-implementer-alt.agent.md` (a new test pins the two bodies equal; frontmatter differs only in tier). The per-Pull prompt carries only what varies: ticket number, distilled brief, worktree abs path, branch, `<scratch>/impl-<N>/` — i.e. the three blocks with placeholders (`You are ALREADY in worktree…`, `Here is the ticket's distilled brief…`, `Every scratch file goes under…`).

Measured: omp injects the agent body as the `§ Role` section of the member's system prompt (probe `body-probe-1`, agent `fleet-review-snapshot`: `session_init.systemPrompt` contains the body verbatim; the member quoted it back). Claude Code agent bodies are system prompts by definition. Same rule, both harnesses; the prose pins on those blocks retarget from SKILL.md to the agent file.

Cost: per Pull the controller emits ~1 KB of prompt instead of ~15.5 KB on Claude (status quo today) and instead of one 14.5 KB pool context per staging on omp — so guard signal 2 (controller `cache_creation`/PR) does not rise on either harness from retiring the pool.

**3. Implementer liveness input to the tick: caller-stated from the ledger, both harnesses.**

`poolLiveness`, `pool-derived`, `stated-unused` and UNKNOWN-on-absent (`fleet-tick.mjs` L66–111, L157–175) are deleted; the STATED path is the only path. Live implementers = ledger rows `impl-<N>` with a dispatch and no outcome (G6 decides whether `reconcile()` reads the ledger itself or the tick's caller states the number). `read proc://` (1 call, every job) is reserved for the **Member-killed confirmation** on omp — beside the mtime discriminator — not the tick: #1692's over-dispatch came from two sources disagreeing, and one source leaves nothing to disagree.

### Ruled without a question (forced by 1–3 or measured)

- `task.maxConcurrency`: implementers queue at the ceiling like reviews (#1771); no fleet-side handling.
- Names: `impl-<N>` unchanged; no pool name, no counter. Hyphenated `task` names measured working (`impl-probe-9999` listed by `read proc://`, result delivered individually).
- Claim-then-dispatch: phase 1 claims serially in the main checkout, immediately followed by the one dispatch — L1181–1188 survives as "claim what you are about to dispatch; dispatch what you have just claimed".
- #1591 outcome classification survives verbatim, keyed to the member's own job status (`completed`/`failed`/`cancelled` now arrive per member); L1201–1215 reworded per member, "confirm death first" unchanged.
- Lost-kernel rule (L1236–1240) retired.
- Alt-tier: same primitive, `fleet-implementer-alt`, every 5th Pull per #1775; L1166–1172 deleted except "no per-call tier or effort anywhere on this path" (ADR 0005), which stays.

### Change surface

- `plugin/skills/run-team/SKILL.md` L1103–1230: whole pool block → the refill Pair (§1) + §2's "what the prompt carries" + §3's liveness sentence; L1232–1470 verbatim blocks: seven move to the agent file, three stay. Phase 2 header L718 wording ("Agent call") becomes the Pair.
- `plugin/agents/fleet-implementer.agent.md`, `fleet-implementer-alt.agent.md`: bodies per §2 (alt description drops "one per wave"). New test: bodies byte-equal.
- `plugin/scripts/pool-dispatch-dialect-prose.test.mjs`: tests 3, 6–13 deleted (pool line, preflight, one-pool-per-wave, cap-vs-worker-bound, pool-derived liveness, alt outside pool, item-vs-context, claim-with-push, completion unchanged, blocked-only wait, lost kernel, pool scope); tests 1–2, 4–5 retargeted to the new Pair.
- `plugin/scripts/marked-pairs.mjs` L294–297: `#1590` exception removed; `marked-pairs` tests referencing it.
- `plugin/scripts/fleet-tick.mjs` POOL/UNKNOWN branches; `fleet-tick.test.mjs` #1692 case rewritten to the STATED shape; `fleet-tick-prose.test.mjs` pool rows (G6 owns the row table).
- `plugin/scripts/pool-preflight.mjs`, `pool-preflight.test.mjs` deleted; `arg.test.mjs` L49 CONSUMERS entry; `instruments.sh` pin.
- `docs/adr/0003-…` point 9 marked superseded by ADR 0012 (precondition retired); `README.md` L35; `CONTEXT.md` L160 (one precondition remains: `enabledProviders`).
- `implementer-model-tier.test.mjs` L378/400–401 wording (G3/G6 own the rest).
- `references/member-lifecycle.md` L26 "harness terms" list unchanged.

## 3. Reviews

Source: #1773

Facts this rests on: #1770 (Claude `Workflow` is async-only; subagents cannot call it; `Agent` has `run_in_background`), #1771 (omp: unawaited controller-kernel promise hangs at `await handle.wait()`; a `task` member running `runReviewOnOmp` works and auto-delivers), plus four probes in this session.

### 1. Unit that runs the review

Rule (both harnesses): **dispatch the review, never wait on it, act when its result lands.**
CLAUDE: the controller calls `Workflow({name: "fleet-ctl:review-pr", args: {pr, branch, worktree, testCmd, scratch}})`; it returns `async_launched` in ~1.5 s and the controller continues. Not a member, no name; its `Run ID` goes on the ledger row.
OMP: the controller dispatches a member named `review-pr-<pr#>`, agent `fleet-review-runner.agent.md` (`model: haiku`, `effort: low`, `thinking-level: low`, no `tools:`). Prompt = the same args. It loads `review-eval.mjs` through the Resolver (`FLEET_HARNESS=omp ~/.fleet/bin/fleet-run --path review-eval.mjs`), awaits `runReviewOnOmp(args)` in its own kernel, writes the result file (§2), reports the digest + path, exits.

Fallback on both (unavailable, or failed after one retry — §5): the hand-dispatched `review-pr-<pr#>` member reading `review-and-fix.md`, unchanged in content; on Claude dispatched with `run_in_background: true`. Its relay duties (SKILL.md L2753–2782) stay fallback-only.

### 2. Result delivery

- One artefact on both harnesses: `<scratch>/review-<pr>.json` holding the bare result object.
  CLAUDE: on the task-notification, the controller runs `jq '.result' <output-file> > <scratch>/review-<pr>.json` (shell only; the `<output-file>` lives under session-scoped `/private/tmp/claude-501/…`).
  OMP: the `review-pr-<n>` member writes it; its report is the member report ("the report is a SendMessage" rule unchanged).
- `review-core.js` (and its Claude twin in `review-pr.js`) reorder the returned object so the **digest** comes first and survives Claude's ~8 KB inline `<result>` truncation: `pr, head, resume, testEnvironment, dimensionsRun, dimensionsUnrun, cwdAudit, counts{survived, refuted, unverified, crashed}`, then `snapshot, survived, refuted, unverified`. (Today `resume` is last — L935 — and falls past the cut on large results.)
- The controller reads the digest only. Findings never enter its context; measured cost avoided ≈ 7–15k tokens per review in (26–61 KB results) plus up to ~10k chars per fix-applier prompt out.

### 3. Cap accounting

- The reviewer cap counts **live units**: a running review (Workflow in flight, or `review-pr-<n>` member) = 1; each `fix-pr-<n>` = 1; finisher and CI wait = 0. A PR holds at most one slot at a time.
- In-flight reviews are derived from the ledger (§7), not remembered.
- **Defaults: 2 implementers, 6 reviewers. No hard caps on either role — defaults only.** Merge bot stays 1 (ADR 0007, out of scope). Sizing note for the spec: reviewer slots in use ≈ I·(T_review + 0.94·T_fix)/T_impl ≈ 1.95·I (medians since 2026-08-07: T_impl 19.3 min, T_fix 21.0 min, T_review ~18 min; 0.94 fix-appliers per review) — so at the default ~4 of 6 are busy; idle slots cost nothing. Re-derive from the map's guard after ≥20 merged PRs.
- CLAUDE: at most **1** review in flight until two concurrent workflows are verified on a live run (docs cap agents per workflow run at 16 and state no per-session limit on runs — unmeasured). The other slots still serve fix-appliers.
- OMP: all review units count against one session semaphore (`task.maxConcurrency`, default 32) shared with every `agent()`; at the ceiling work is queued, not refused (#1771) — a wall-time cost, not a failure.

### 4. Fix-applier and finisher hand-off

- The **controller** dispatches `fix-pr-<pr#>` on the result edge, prompt carrying PR#, worktree abs path, branch, `testCmd`, and the **path** `<scratch>/review-<pr>.json` with `jq` extraction recipes — not the findings.
- The fix-applier owns every per-PR ruling formerly the controller's: both mutual-exclusion scans (before applying; as its own refuters report), suggested-fix-quotes-deleted-text + re-derive, `refuted=false` ≠ apply, sibling-site extension needs per-site measurement, `testEnvironment`/`cwdAudit` reading before acting on `test_run`.
- Digest `counts.survived == 0` and nothing to file → controller dispatches the finisher directly (edge unchanged).
- CLAUDE: reports of refuters the fix-applier spawns still surface to the controller; the controller neither scans nor relays them. The fix-applier retrieves them itself (`tail -1 <output-file> | jq …`, already in its prompt at L2278) and asks the controller by name only if the file yields nothing.
- Finisher dispatch gate unchanged (CI green or `no-ci`, fix-applier report received, controller outbox empty).

### 5. Failure handling

Rule: **whoever holds the review call retries once; a second failure → the fallback reviewer.** Failure = throw, empty return, or notification `status` ≠ completed.
CLAUDE: the controller relaunches `Workflow` once; still failing → fallback `review-pr-<pr#>` (background).
OMP: the `review-pr-<n>` member catches, re-calls `runReviewOnOmp` once, then reports `failed` with both errors; the controller dispatches the fallback as `review-pr-<pr#>-b`. A killed member follows the Failure-handling table (fresh name, inherited state stated).

### 6. Crash repair inside the run

- `review-core.js` (and `review-pr.js`) re-dispatch **each crashed specialist once and each crashed refuter pair once** before assembling the result. Residue lands in `dimensionsUnrun` / `unverified` as today; the fix-applier names it unrun/deferred in its report and re-runs nothing.
- `resume` now means "crashed again after the in-run retry".
  CLAUDE: the controller may relaunch with `Workflow({scriptPath, resumeFromRunId})` (cached replay) as a second line.
  OMP: no replay exists (measured: TurnRecovery auto-retry `retry.maxRetries=10` fires only on transient errors while a turn is live; F5/Alt+R `app.retry` is TUI-only on the focused session; Agent Hub revive needs `aborted`, not `failed`; `AsyncJobManager` has no retry verb). `resume` is reported, not acted on.

### 7. Ledger

- At launch the controller appends to the PR's row: `review=wf:<runId>` (Claude) | `review=member:review-pr-<n>` (omp) | `review=fallback:review-pr-<n>[-b]`.
- On the result: `reviewed=<head>:<survived>/<refuted>/<unverified>`.
- In-flight reviews = rows with `review=` and no `reviewed=` → feeds `--reviewers` with live fix-appliers (G6 consumes this).
- The fix-applier's report lists refutations it reversed; the controller copies them to the `ruled` line.

### 8. Retired

- SKILL.md "One review workflow at a time" (L1946–1953); "Only you can run it … no reason to run `eval` themselves on omp" (L1908–1919) rewritten per §1; controller-side mutual-exclusion scan, suggested-fix scan and "verbatim means every one" relay (L2018–2119) move into the fix-applier prompt.
- "Reviews are the bottleneck … one at a time" and the 2/3 default derivation (L3073–3097); L3/L11 "up to 5 / cap 5".
- Map fog item "Porting `selectDimensions` sizing … into a reviewer member prompt" — moot: Claude keeps `Workflow` as primary.

### Change surface

- `plugin/scripts/review-core.js`: result key order; in-run retry of crashed specialists/refuter pairs; `resumeFor` wording ("after the in-run retry").
- `plugin/workflows/review-pr.js`: same two changes in its twin copy (pinned by `review-pr-cwd-isolation.test.mjs` and the resume-wording pin).
- `plugin/agents/fleet-review-runner.agent.md`: new.
- `plugin/skills/run-team/SKILL.md`: § Reviewers, fallback §, phase-3 "Review slot free, PR queued" edge (now fires per free slot), fix-applier prompt, L3/L11/L3073–3097.
- `plugin/commands/review-and-fix.md`: fix-applier role reads the result file and owns per-PR rulings.
- `plugin/scripts/fleet-tick.mjs` L435–437: drop the `> 5` bound on `--implementers`/`--reviewers`/caps (keep ≥ 1); G6 owns `reconcile()`.
- `plugin/scripts/ledger.mjs`: `review=` / `reviewed=` fields if the row schema is validated.

## 4. Merge

Source: #1774

Where this section and § 6 differ on ledger mechanics, § 6 (#1778, decided
later the same day) governs: `ledger.mjs dispatched` is the merge-bot case
of `ledger.mjs dispatch`.

*Pass* (event): one `merge-bot-<n>` dispatch goes from drain to grace to a single exit report. Every pass ends in that report, whether or not it merged anything.

1. **Dispatch on the label.** A `ready-to-merge` label, seen through the finisher's report, the persistent label Monitor, or a tick's queue read, dispatches a merge bot when `fleet-tick.mjs` `mergeBot()` says `DISPATCH merge-bot`. The existing rule applies: no merge bot live (cap 1, ADR 0007), and at least one queued PR not held. The bot does **not** wait for the finisher's report.
   - The finisher is done at duty 3 (the label).
   - The bot's rebase is server-side (`gh pr update-branch --rebase`), so it never touches the finisher's worktree.
   - SKILL.md L1535–1542 (the "destructive rebase" wait) is deleted.
   - `mergeBot()` is unchanged: there is no queue-depth threshold, and `--merge-holds` keeps its meaning.
2. **Naming.** `merge-bot-<n>`, where `n` = 1 + the number of `merge-bot-` entries in a new append-only ledger list, `## Dispatched`.
   - The list is written by `ledger.mjs dispatched <member-name>` **before** the dispatch.
   - There is one ledger per run (`ledger.mjs` L104), so `n` restarts at 1 every run.
   - A replacement for a dead bot gets a new `n`.
   - Merge bots have no ticket row to count; the alt-tier count from #1775 stays on `impl-` rows. This resolves #1775's Fog item.
   - Scratch paths become `<scratch>/pr<N>/merge-bot-<n>/`.
3. **Drain.** The bot selects, merges, then re-fetches and **re-evaluates the queue from scratch** after every merge (`run-merge-bot.md` L279, unchanged). A label that arrives mid-pass is merged in the same pass.
4. **Grace: 15 min, fixed, dispatched bots only.** Grace starts once no labelled PR is actionable. Every 60s the bot polls `gh pr list --state open --label ready-to-merge --json number`. When the poll shows a new PR, the bot re-runs selection from the top, hold rule included, and grace restarts after that drain. After 15 minutes with no change, the bot sends its report and exits. Wait mechanics are a Marked-line Pair (ADR 0004):
   - **Claude:** foreground `Bash` chunks of at most 4 min each. That keeps every turn under the 5-min prompt-cache cliff: about 4 chunks per grace, each a warm turn of about 1k `cache_creation` plus 61k cache read.
   - **omp:** one Python `eval` cell that polls via `subprocess.run`, with a cell `timeout` of at least 1000s. **Never `bash` plus `wait`.** omp `bash` auto-backgrounds anything past about 60s even with `timeout` set, and `wait` then returns "Skipped due to a queued background completion". One member lost 7 turns to this.
5. **CI wait on omp (folded in).** `gh run watch` (`run-merge-bot.md` L201–204) hits the same ~60s ceiling on omp: 150 of 3,485 merge-bot calls sit in the 59–60s band. On omp, the per-merge CI wait becomes an `eval` cell polling `gh run view <run-id> --json status,conclusion` until the run is terminal. The re-query-for-verdict rule (L206) is unchanged. On Claude, L204 is unchanged.
6. **Report once, at exit.** The bot sends one report after grace, in L287's outcome vocabulary: `SendMessage` on Claude, the `task` result on omp. There are no per-merge reports.
7. **Controller on the report ("Reap after each merge pass").**
   1. Write each `held-behind-#<lower>` into that ticket's row as `held-behind:#<lower>`. This is the existing row token (SKILL.md L3409).
   2. Reap: `reap.sh --apply`, **always**, even if the pass merged nothing.
   3. Tick (the reconcile, plus #1775's refresh; #1778 owns the edge list).

   If the tick says `DISPATCH merge-bot` because a label landed in the last moment, dispatch `merge-bot-<n+1>` straight away.
8. **Holds.** `--merge-holds` is derived from the ledger: rows carrying `held-behind:#M` whose `#M` is neither MERGED nor CLOSED. This is the same lift rule as #1775's `behind-pr` Exclusion. A hold is dropped once its premise PR closes.
9. **Re-dispatch.** A label that arrives after the exit report dispatches a fresh `merge-bot-<n>` immediately. There is no minimum queue depth, and the "At 6+ open PRs batch a wave" rule (SKILL.md L2879) is retired. Detection costs nothing extra: the finisher's duty-4 report already wakes the controller, and the persistent label Monitor plus every tick's queue read catch hand-applied labels.
10. **Brief.** The brief always travels with the dispatch, never as a follow-up (SKILL.md L2798). Its contents are deferred to #1776.
11. **Top-level `/run-merge-bot` is unchanged.** It keeps its permanent 60s Monitor ("Then stay armed"). Grace applies only when a controller dispatched the bot.
12. **Stuck bot.** No new rule. A bot that never reports is a silent member: the existing "Member silent or truncated" row, plus #1772's liveness checks, cover it.

### Prose pins to rewrite

**Tests**
- `run-merge-bot-prose.test.mjs`:
  - L968 and L1075: `merge-bot-<wave#>` → `merge-bot-<n>`.
  - L997: "every wave's bot" → "every pass's bot".
  - L1107–1111: the test title "…this pass's wave", `phrase("base=<scratch>/pr<N>/merge-bot-<wave#>")`, and the "per-wave namespace" message.
  - Comments at L435, L884, L1092.
- `fleet-tick-prose.test.mjs` L73–74: "Merge-bot wave reports done" → "Merge-bot pass reports done".
- `finisher-name-prose.test.mjs`:
  - L33: `MEMBER_NAMES` → `merge-bot-<n>`.
  - L85: remove `wave` from `(?:issue|pr|wave)#`.
  - L111: comment.
- `member-outcomes.test.mjs`:
  - L61–62: title and comment become "per-run dispatch counter, never a PR".
  - L252: `description: "merge bot wave 12"`.
  - L335: `description: "merge wave 3"`.
- `compute-spend.test.mjs`:
  - L165: **delete**. It pins the description alternative that is being removed.
  - L212–213: keep the name-priority test, reword the description and the comment.
- `ledger.mjs` tests: new `dispatched` command and `## Dispatched` section.

**Scripts**
- `compute-spend.mjs` L165: `/merge wave|merge-bot/` → `/merge-bot/`. Also update the comment at L150–151.
- `member-record.mjs` L125: "its number is a WAVE index" → "its number is a per-run dispatch counter, never a PR".
- `ledger.mjs`: add the `dispatched` command, and add it to the usage string at L215.

**Bot prose (`plugin/commands/run-merge-bot.md`)**
- L82, L89, L106: scratch paths → `merge-bot-<n>`.
- L142: "one wave … the next", "costs a wave" → pass.
- L201–204: omp CI wait becomes an `eval` poll cell (Marked-line Pair).
- L263: "normal case in a pass".
- L281–283: rewrite as a per-pass statement. Staleness compounds within a pass and the last PR pays the largest rebase. Keep "never rebase a PR before it is the actual merge candidate" and drop the batching conclusion.
- L313–353: the dispatched-bot branch (L315–319, "report your pass and exit instead") becomes the grace rule (Merge §4). The top-level branch is unchanged.

**Controller prose (`plugin/skills/run-team/SKILL.md`)**
- L72: naming list.
- L1543–1544: the two trigger bullets "→ merge-bot wave" become "→ dispatch `merge-bot-<n>`". **Delete L1546–1552.** "Merge-bot wave reports done" becomes "Merge-bot pass reports done → record holds, reap, then reconcile".
- L1628: edge name.
- L1659: `--merge-holds` source → ledger rows (Merge §8).
- L2568: "costs a wave" → "costs a pass".
- L2786: "Per pass, named `merge-bot-<n>` (`ledger.mjs dispatched`)".
- L2879–2880: retire "At 6+ open PRs batch a wave rather than merging singles". Keep "behind-count … expired on arrival".
- L2882: "intra-pass re-checks".
- L2885, L2888, L2901, L2923, L2965: the heading becomes "Reap after each merge pass", and the "each wave" / "a wave that" / "per merge wave" references follow it.

**References and docs**
- `references/member-lifecycle.md` L7: naming list.
- `references/reaping.md` L3, L5, L31: "after every wave" → "after each merge pass".
- `CONTEXT.md` L41: "after a merge wave" → "after each merge pass".
- `docs/adr/0007-…md`: add the "Amended by ADR 0012" line; L128 text stays.
- #1776 corrects this list for `run-merge-bot-prose.test.mjs` L928–1121 (the `gateProof()` block): deleted with § Prove the gate blocks, not renamed; the step-3 pins L968/L997/L1075/L1107–1111 are rewritten against the two-invocation rule.

## 5. Merge gate

Source: #1776

### Scope

`plugin/scripts/merge-gate.mjs` is **the whole of step 3**, not a `jq`
replacement for the CI payload. It runs, in order, `instruments.sh --repo
<git-common-dir>`, `gh pr view <pr> --json labels,reviewDecision,headRefOid`,
and `ci-state.mjs --pr <pr> --declare-no-ci` (through the Resolver), then
answers the conjunction. It is **read-only**: it never merges, labels, never
rebases, never waits.

Why the whole step and not payload only: the brief's fixed cost is the
lever #1774 named (57 KB, "14k tokens per dispatch; median 1 merge per busy
period). A payload-only gate removes the `jq` but keeps every hand-run read
the traps protect — `--quiet`, `2>&1`, the vacuous-subset gate makes them
deletable by construction. A whole-step gate makes them deletable by
construction.

### Interface

```
~/.fleet/bin/fleet-run merge-gate.mjs --pr <n> --pre <sha> [--post <sha>] [--out <path>]
```

- `--pre`: the head recorded at **the labelled head** (`gh pr view --json
  headRefOid`), before anything can move it.
- `--post`: the head step 1's `gh pr update-branch --rebase` produced,
  omitted on the no-rebase path (equivalent to `--post == --pre`).
- `--out`: where the JSON line is also written; default
  `<scratch>/pr<N>/merge-bot-<n>/ci.json`, directory created with `mkdir
  -p` (see *Ruled* below).

Stdout: exactly one JSON line: `{pr, verdict, reason, head, pre, post,
behind, instruments, ci}` — `verdict ∈ {mergeable, blocked, unknown}`, `ci`
the full `ci-state` payload or `null`. Stderr: the child processes'
diagnostics, never folded into stdout.

`.mjs`, not `.sh`: the script parses two JSON documents in `sh` that is
`jq`, which is the exact exit-3/4/5 channel the table at SKILL.md
L2813–2834 documents. With `arg.mjs` + `git-env.mjs` that channel does not
exist, and nothing on the merge path writes `jq` any more.

### Exit vocabulary

0 mergeable · 1 blocked (a verdict about this PR, now) · 2 could-not-evaluate
(a finding about the tree, the tooling, or the API — never about the PR).
Same three-way contract as `inflight.sh`, `prove-merge.sh`, `staleness.mjs`.

| condition | exit | `reason` |
|---|---|---|
| every check holds | 0 | — |
| `ready-to-merge` absent | 1 | `label-pulled` |
| `reviewDecision == CHANGES_REQUESTED` | 1 | `changes-requested` |
| `headRefOid ∉ {pre, post}` | 1 | `head-moved-after-label` |
| `ci-state` exit 1 (`not-green`: head mismatch, `status != completed`, missing/failed jobs) | 1 | `ci:<first entry of ci.reasons>` |
| `behind > 0` | 1 | `behind:<n>` |
| `ci-state` exit 2 — `rate-limited`, no payload, `{}`, zero bytes, unparseable | 2 | `rate-limited` / `ci-unreadable` |
| `behind === null` | 2 | `behind-unknown` |
| `instruments.sh` exit 1 | 2 | `instrument-set-changed` |
| `instruments.sh` exit 2 | 2 | `instruments-unanswerable` |
| `gh pr view` fails or misparses | 2 | `pr-unreadable` |

Checks run in the table's order and the first failure is the `reason`; the
JSON still carries every field that was read. An instrument change maps to
2, not 1: 1 means "this PR is not mergeable now", and a changed instrument
says nothing about the PR — the response is stop-and-report, the same as
every other 2. The `reason` tokens preserve today's report vocabulary
(`head-moved-after-label-#<pr>`, `instrument-set-changed-#<pr>`): the bot
reports `<reason>-#<pr>`.

### `--declare-no-ci` is fixed inside the gate

`ci-state.mjs` L763: `gateSatisfied = verdict === "green" || (verdict ===
"no-ci" && declareNoCi)`. The flag touches one arm — a repo with no
workflow files, where the finisher's label is the CI verdict — and cannot
relax `green`/`not-green`. The gate always passes it, on every call, with
no option on its own surface. Safe in both directions: it cannot pass a
real red (L763), and it cannot pass a no-CI PR whose label was pulled,
because the label check runs first in the same process. `ci.verdict:
"no-ci"` in the output shows which arm cleared.

### The brief's step 3, and the merge instant

Step 3 becomes one rule with two invocations:

1. **Run `merge-gate`.** Exit it with `reason ci:...` and `ci.status !=
   completed` → wait on `ci.runId` — Claude: `gh run watch <runId>
   --exit-status`; omp: the `eval` poll cell #1774 ruled (a Marked-line
   Pair, ADR 0004) — then return to 1. Any other 1 → skip the PR, report
   `<reason>-#<pr>`, move on. Exit 2 → report the label (re-run once only
   for `rate-limited`).
2. **Run `merge-gate` again immediately before `gh pr merge`, and merge
   only on that second exit 0.**

Invocation 2 subsumes two rules the brief carries today: "re-query at the
moment you merge — a conclusion can invert under a fixed run id"
(`run-merge-bot.md` L232) and the second `instruments.sh` check before the
write (L245–251). Cost: one extra `ci-state` per merge — a handful of REST
calls, against the "2000-call poll loop the traps were written for. The
gate never waits itself: #1774 measured omp `bash` backgrounding at "60s,
so a `--wait` would reintroduce the loop.

### What leaves the prose

**§ Prove the gate blocks, in a directory you own** (L70–106) — whole
section, including the `gate-proof/` directory rule, the plain-`mkdir`
claim, the `gate-proof-2` fallback, and its watcher step. Step 3's
hand-chained reads (L212–251): label/reviewDecision recheck, `headRefOid ∈
{pre, post}`, both `instruments.sh` invocations and their `--repo` spelling
paragraph, the `ci-state.mjs --pr` invocation and its "binds run head,
status, every expected job" explanation, the merge-instant re-query rule,
the `--declare-no-ci` paragraph. What survives of step 3 is the *facts* the
gate now enforces, stated once each as the reason a `reason` token exists
(a cancelled run's inherited "pass", the third-SHA push, the rerun that
inverts a conclusion) — not as instructions.

`run-team/SKILL.md` § Merge bot: "`ci-state --quiet` is unsatisfiable-FALSE"
bullet (L2802–2805) — nothing but the gate invokes `ci-state` now. The `jq`
exit table bullet (L2813–2834) — no `jq` on the merge path. "So gate on
the payload's own fields … Ask the bot which fields its gate actually read"
(L2836–2843), the empty-payload and `rate-limited` paragraphs
(L2845–2858), and "Ask which directory it proved the gate in" (L2860–2866).
The measurements those paragraphs record move into `merge-gate.test.mjs`
as named cases. "Put every gate trap in the bot's brief" (L2798) collapses
to the one bullet that stays (below).

### What the brief keeps

- **Shell traps, verbatim** (SKILL.md L2806–2812, `references/` § Shell
  traps). The bot still reads `rc=$?` from `gh pr update-branch`,
  `merge-gate.mjs`, `prove-merge.sh`, and its watcher step still captures
  `gh pr list` — the assigned-variable and `PIPESTATUS`/read-only `status`
  traps are unchanged.
- **The labelled-head timeline read** (`run-merge-bot.md` L51–68), which
  produces `--pre`. Kept as the one hand-run read this cutover leaves in
  the brief — see *Fog*.
- Step 1 (rebase and its fallback), step 2's wait, step 4 (`gh pr merge
  --merge`, `prove-merge.sh`, `drop-merged-label.sh`), and the hold rule —
  untouched by this ticket.

### Tests — `merge-gate.test.mjs`

`gh`, `ci-state.mjs` and `instruments.sh` stubbed on `PATH` with a call log,
the pattern `plugin/scripts/ci-state.test.mjs` L8 and
`drop-merged-label.test.mjs` L26–82 already use. One case per check that
must block **on its own** — deleting the check goes red (the discipline
`plugin/scripts/drop-merged-label.test.mjs` L11–13 states):

- `rate-limited` payload · `{}` · zero-byte · unparseable → 2
  (`rate-limited` / `ci-unreadable`).
- green with `behind: 3` → 1 `behind:3`; green with `behind: null` → 2
  `behind-unknown`.
- `status: in_progress`, no conclusion → 1 `ci:...`.
- label absent → 1 `label-pulled`; `CHANGES_REQUESTED` → 1
  `head-moved-after-label-#<pr>`.
- `pre == post` / `--post` omitted with head on `pre` → 0 (the no-rebase
  path).
- `instruments.sh` exit 1 → 2; exit 2 → 2.
- `gh pr view` non-zero → 2.
- the mergeable shape → 0 with the JSON line's fields populated and
  `ci-state` called with `--declare-no-ci` exactly once (asserted from the
  call log).
- `ci-state` stderr noise never reaches the parse (stub writes traces to
  stderr; stdout JSON still parses).
- `no-ci` verdict with label present → 0.

### `instruments.sh --pin`

No change. The set is every tracked file (`plugin/scripts/instruments.sh`
L30–40), so `merge-gate.mjs` is covered by the first pin after it merges.

### Ruled without asking

(measurement left one answer)

- The gate creates `<scratch>/pr<N>/merge-bot-<n>/` with `mkdir -p`. The
  plain-`mkdir` rule partitioned *fixtures* between same-named bots across
  waves; under #1774's `merge-bot-<n>` there is no same-named bot in a run
  and no fixture, so nothing is left to collide.
- The gate is not a `--wait`er (above).
- Additive: no process changes, no pin changes. Admissible by one
  implementer with no collision surface.
- **T-a — ship `merge-gate.mjs` + `merge-gate.test.mjs`.** Interface, exit
  vocabulary, fixed argv, and test list exactly as above.
- **T-b — retire the gate prose and its pins.** Folded into #1774's prose
  ticket so `run-merge-bot.md` and SKILL.md § Merge bot are cut over
  **once**; depends on T-a merged. This ticket **corrects #1774's pin
  list** for the gate-proof section — those pins are deleted with the
  section, not renamed: `run-merge-bot-prose.test.mjs`: the whole
  `gateProof()` block, L928–1121 (between(DOC, "## Prove the gate blocks…",
  "## Per-PR sequence") — the `between` guard itself the heading is gone,
  so this is a deletion, not the L968/L997/L1075/L1107–1111 renames #1774
  listed. Step-3 pins in the same file that name `instruments.sh --repo`,
  `ci-state.mjs --pr`, `--declare-no-ci` or the merge-instant re-query rule
  rewrite against the two-invocation rule.
  - `shell-traps-prose.test.mjs` L124–125: the brief-list slice ends at
    the `jq` bullet (`indexOf("- **A `jq`" ) exit outside 0 and 1")`:
    re-anchor on the shell-traps bullet, which is now the list's only
    entry.
  - `quiet-payload-prose.test.mjs`: unaffected — its four `SITES`
    (L175–180) are the CI-Monitor read, the finisher-duty read,
    review-and-fix step 6 and `ci-state.mjs`'s header; the merge-bot
    `--quiet` bullet was never a site.

SKILL.md § Merge bot: delete L2802–2805, L2813–2834, L2836–2858,
L2860–2866; reduce L2798 to the shell-traps bullet; add the two-invocation
rule. `run-merge-bot.md`: delete L70–106 and L236–243; rewrite step 3 as
the two-invocation rule; keep L51–68. `docs/adr/` — none; `CONTEXT.md` —
none (the gate is not a domain term).

## 6. Loop

Source: #1778

Facts this rests on: #1773 §3/§7 (in-flight reviews derivable from
`review=`/`reviewed=` rows; cap counts live reviews + fix-appliers; Claude
≤1 review in flight until measured), #1774 §7–88 (`held-behind:#M` rows,
`## Dispatched` list, reap after each pass), #1775 (`.fleet/shortlist.json`;
`--pool` = unclaimed depth, its reading handed here; refresh triggers),
#1777 §3 (implementer liveness is `impl-<N>` rows with no outcome; whether
`reconcile()` reads the ledger itself or handed here), ADR 0008 (the
controller holds its own turn; `fleet-tick.mjs` today refuses six
caller-stated counts).

**Rule: record, tick, act, beat.** Every wake — a member report, a
workflow notification, a label, a CI run reaching a terminal state, a
heartbeat — ends in one `fleet-tick.mjs` invocation, and the controller
does what it prints. There are no hand-run refill or dispatch edges left.

### 1. The tick reads the run, nobody states it

The six caller-stated flags (`--implementers --reviewers --merge-bots
--pool --reviews-ready --merge-holds`) are **deleted**. `main()` reads
`.fleet/ledger.md` and `.fleet/shortlist.json` (both resolved against the
git common dir as `ledger.mjs` does) plus the open-PR list it already
fetches; `reconcile()` stays pure and takes the derived counts. Provenance
markers (`caller-stated` / `pool-derived` / `unknown`, `fleet-tick.mjs`
L58–126) and `NOT_ZERO` go with them.

- Derived inputs: live implementers = unsettled `impl-` tokens; live
  reviewer units = rows with `review=` and no `reviewed=` plus unsettled
  `fix-pr-` tokens; live merge bot = last `## Dispatched` entry without
  `=done`; `--merge-holds` = `held-behind:#M` rows whose `#M` is neither
  MERGED nor CLOSED; pool = shortlist entries with no `impl-`/`excluded`
  row; supply = the `scanned` count `shortlist.mjs` records at scan time
  (`readSupply()` L549–602 deleted — a fresh run has a stale shortlist
  presered; missing ledger on a fresh run = zero rows).
- Failure direction preserved: missing or unparsable shortlist = depth 0 +
  refresh, never a refusal (pool depth only bounds Pulls downward).

### 2. Ledger grammar: `<member>` live, `<member>=<outcome>` settled

New subcommands: `ledger.mjs dispatch <ticket|pr> <member>` and `ledger.mjs
settle <member> <outcome>` (the `dispatched` command #1774 §2 introduced
becomes the merge-bot case of `dispatch`, still appending to `##
Dispatched`). The controller writes one command per report and never
hand-edits row text for liveness; `-> PR#344` stays as the human-readable
arrow, the tick reads only `=`-tokens.

Outcome vocabulary: `impl-N = PR#M | bailed | released | killed | tier-
mismatch`; `fix-pr-M = applied:<head> | no-op | failed | killed`;
`finisher-pr-M = labelled | failed | killed`; `merge-bot-n = done | killed`.
Replacement members (`-b`) get their own token. #1773's `review=... /
reviewed=...` pair stays as ruled; a dead review is settled `review=..
.=failed`.

### 3. Shortlist refresh runs inside the tick

The tick Pulls from the *current* file first, then runs `shortlist.mjs`
itself when (unclaimed < implementer cap) v (file missing/empty) v (an
`excluded behind-pr:#M` premise is no longer in the open-PR list it already
holds); `behind-issue:#M` premises cost one `gh issue view M --json state`
each). It prints `REFRESHED shortlist: n entries; k lifted`. The pass-
done edge needs no special case — any tick after a merge sees the lifted
premise. Step 0 of a run regenerates the file (a dead run's shortlist is
stale by definition).

### 4. Rows and actions

- **Implementers:** `PULL #412 #415` names the next unclaimed shortlist
  head(s), one per free slot; the controller runs #1775 §2's sequence per
  named ticket, and a ticket that fails judgement is relabelled/excluded so
  the next tick names the next head. The review-backlog gate is
  **narrowed**: `HOLD` only when ≥1 open PR (closing an issue) has no
  `review=` token **and** no reviewer slot is free — the one true half of
  L3073–3079 ("more PRs into a review-bound pipeline buys nothing"), firing
  only when the review side is actually saturated. `RE-SHORTLIST` rows and
  "ask the maintainer to tick" are deleted; the table becomes `PULL k` /
  `REFRESHED` / `SUGGEST /triage, hold idle`.
- **Reviewers (named, in priority order):** `DISPATCH fix-pr PR#346` for
  every row with `reviewed=` and `counts.survived > 0` and no `fix-pr-`
  token; then `DISPATCH review PR#350 ...` for open PRs closing an issue
  with no `review=` token, oldest first, bounded by free reviewer slots
  (#1773 §3 counting) and by `--max-reviews`. Finish what is started before
  starting more.
- **`--max-reviews <n>`**, default = reviewer cap, as a Marked-line Pair:
  CLAUDE: `fleet-tick.mjs --max-reviews 1` / OMP: `fleet-tick.mjs`. Lifting
  the Claude bound once two concurrent Workflows are measured is one line
  in SKILL.md.
- **Finisher stays a prose edge** on the CI-terminal wake (`ci=...:success`
  or `no-ci`, fix-applier settled, controller outbox empty); the outbox
  condition is the one input that lives only in the controller's head, and
  a printed `DISPATCH finisher` it must sometimes refuse is a row it learns
  to ignore.
- **Merge bot:** `mergeBot()` unchanged (#1774 §1); liveness from `##
  Dispatched`.
- **Caps:** `fleet-tick.mjs` L437 `> 5` bound dropped, `≥ 1` kept; defaults
  2/6 (#1773). `DISPATCH fix-pr|review` stays non-actionable; `SUGGEST
  /triage` stays heartbeat back-off, fold and ceiling unchanged (ADR 0008
  §4–86).

### 5. Drain

`ledger.mjs drain "<reason>"` writes one marker on the drain event; the
tick then prints `HOLD (draining)` on the implementer row, stops
refreshing, and keeps the review/fix-applier/merge rows firing until open
PRs are merged. Drain releases every claim that never became a PR
(unchanged) and settles those rows `impl-N=released`. `fleet-heartbeat.mjs
--stop` unchanged. Survives a context loss: a replacement controller reads
the marker and does not restart supply.

### 6. Tier guards under Pull

`tier-check.mjs --batch` runs per Pull on the member just dispatched (a
batch of one); a mismatch → `settle impl-N=tier-mismatch`, and the tick
prints `HOLD (tier mismatch impl-N)` until the controller fixes it. The
ADR 0005 floor over `tier-outcomes.tsv` runs at every alt Pull (every 5th,
#1775 §6), before choosing alt: a floor breach dispatches that Pull at
default tier and prints why. "Pool empty → phase 0" (L1610–1615) as the
guard's trigger is gone.

### 7. The phase-3 edge list becomes a record-before-tick table

| Wake | Record, then tick |
|---|---|
| Implementer report | `verify-sha`; `settle impl-N=PR#M` or `=bailed` (relabel per #1775 §4) |
| Workflow notification / `review-pr-n` report | write `<scratch>/review-<pr>.json`; `reviewed=<head>:s/r/u` |
| Fix-applier report | `settle fix-pr-M=…`; copy reversed refutations to `ruled` |
| Finisher report | `settle finisher-pr-M=labelled` |
| Label seen (persistent Monitor) | nothing to record |
| CI run terminal | `ci=<run>:<attempt>:<conclusion>` on the row; finisher gate (prose, §4) |
| Merge-bot pass report | `held-behind:#M` rows; `settle merge-bot-n=done`; `reap.sh --apply` |
| Drain | `ledger.mjs drain`; release claims; `settle impl-N=released` |
| Heartbeat | nothing to record |

Then `fleet-tick.mjs`, act on every printed line, arm the beat. Edges
removed: "Merge-bot wave reports done" (→ the pass-report row above, #1774
§7), "Pool empty → phase 0", the tier-guard wave clause, L1535–1542
(#1774), the separate "Implementer completes → refill" and "Review slot
free, PR queued" instructions (now rows the tick prints).

### Change surface

- `plugin/scripts/fleet-tick.mjs`: `OPTIONS/WHY/LIVE_WHY` (L327–402)
  reduced to `--implementer-cap --reviewer-cap --max-reviews --fold-unchanged
  --state`; `liveness()`/`provenance` (L58–126) deleted; `readSupply()`
  (L549–602) deleted; `implementers()`/`reviewers()` per §4; ledger +
  shortlist readers new; `unpairedFlags` test shrinks; header comment
  (L15–45) rewritten.
- `plugin/scripts/fleet-tick.test.mjs`: `#1692` case → ledger-derived shape;
  new cases for named rows, narrowed backlog gate, `--max-reviews`, drain,
  unparsable-row refusal, missing-shortlist = depth 0.
- `plugin/scripts/ledger.mjs`: `dispatch`, `settle`, `drain` subcommands;
  `=`-token parser; usage string L215.
- `plugin/scripts/shortlist.mjs` (new, #1775) records `scanned` in the file
  the tick invokes it.
- `plugin/skills/run-team/SKILL.md`: Phase 3 L1488–1616 → the table in §7
  + the reconcile block retitled "**Every wake ends in the tick.**" (the
  `fleet-tick-prose.test.mjs` slice start; end marker "**Own the CI waits.**"
  unchanged); L1617–1656 flag prose → `--max-reviews` Pair; § Queue depth
  L3046–3136: definitions of pool/supply per §1, L3073–3079 and L3099–3105
  retired, table per §4, "ask the maintainer to tick" gone; § Run ledger
  gains the `=`-grammar and the three subcommands; L1610–1615 tier guard →
  §6.
- `plugin/scripts/fleet-tick-prose.test.mjs`: L73–75 pin ("neither covers a
  fully drained queue") retired — replaced by a pin that the record-before-
  tick table names every wake; L81–86 flag list → the three surviving
  flags; L88–96 ("live counts are controller-stated") inverted.
- `plugin/scripts/implementer-model-tier.test.mjs` L378–423 ("stops the
  wave" → "holds the next Pull"), L485 ("costs a wave slot" → "costs an
  implementer slot").
- Wording only: `fleet-state.mjs` L26/30/223/290, `fleet-heartbeat.mjs`
  L218/252 context, `instruments.sh` L84 ("per wave" → "per pass"),
  `reap.sh` L1128 comment (title unchanged), `fleet-state.test.mjs` L210
  ("during a merge wave" → "during a merge pass").
- `CONTEXT.md`: Pull, Pass, Shortlist, Exclusion per the map: "Liveness
  mark" entry unchanged (run liveness, not member liveness).

## 7. ADR amendments

- `docs/adr/0003-dual-harness-dev-loop-install-is-the-only-path.md`:
  amended by ADR 0012 — point 9's `eval.workpool.freshAgents` precondition
  is retired with the omp workpool; points 1–8 stand.
- `docs/adr/0005-tier-declared-per-harness-verified-at-dispatch.md`:
  amended by ADR 0012 — the `tier-outcomes.tsv` floor runs at every
  alternate-tier Pull, not on "Pool empty → phase 0"; floor and query
  unchanged.
- `docs/adr/0007-main-ruleset-is-the-merge-gate.md`: amended by ADR 0012 —
  guard 1's trigger reads "a single pass in which the last PR waits more
  than 3 h"; threshold unchanged.
- `docs/adr/0008-a-turn-based-fleet-holds-its-own-turn.md`: amended by ADR
  0012 — §1 reads "records, then ticks"; the ledger now records dispatch
  and settlement, so the tick derives its counts and the controller states
  none; §2–§8 unchanged.

> **Superseded in part.** The slot-based loop (2026-09-24) retires phase 0's
> multi-select and the invariant *"exactly one human decision per wave, zero
> unilateral grabs"* below, the phase-3 edge list, and every merge-bot "wave":
> supply is automatic (ADR 0013); reviews run off the controller's turn, the
> merge bot is dispatched on the first `ready-to-merge` label and every wake
> ends in one `fleet-tick.mjs` run (ADR 0012). The text below is left as
> written. See `docs/specs/2026-09-24-slot-based-fleet-loop-design.md`.

added to `docs/specs/2026-07-22-run-team-agent-fleet-design.md` after its
fourth `> **Superseded in part.**` block.

## 8. Change surface

### 8.1 Every "wave" in the prose tree

`grep -n -i -E '\bwaves?\b' plugin/skills/run-team/SKILL.md
plugin/commands/run-merge-bot.md plugin/skills/run-team/references/reaping.md
plugin/skills/run-team/references/ci-and-staleness.md
plugin/skills/run-team/references/member-lifecycle.md
plugin/agents/fleet-implementer-alt.agent.md CONTEXT.md` — re-run at
`6f2c654` (2026-09-24): 56 + 8 + 3 + 0 + 1 + 1 + 2 = **71 hits**;
`ci-and-staleness.md` has none.

| file | line | text (≤80 chars) | owning section | replacement |
|---|---|---|---|---|
| `plugin/skills/run-team/SKILL.md` | 72 | `review-pr-<pr#>`, `finisher-pr-<pr#>`, `merge-bot-<wave#>`. See | §4 Merge | `merge-bot-<wave#>` → `merge-bot-<n>` |
| `plugin/skills/run-team/SKILL.md` | 131 | shares, so ordinary work moves refs several times a wave and a per-gate | §4 Merge | wording: wave → pass |
| `plugin/skills/run-team/SKILL.md` | 428 | Measured, one wave: #132's one-line remedy had shipped in `e7b11e6` ten days | §4 Merge | measurement note: wave → pass |
| `plugin/skills/run-team/SKILL.md` | 558 | express this, and it is what actually stalls a wave. | §1 Supply | phase 0 → shortlist.mjs (ADR 0013 §1) |
| `plugin/skills/run-team/SKILL.md` | 575 | tickets — which is exactly how both land in one wave. | §1 Supply | phase 0 → shortlist.mjs (ADR 0013 §1) |
| `plugin/skills/run-team/SKILL.md` | 577 | Maintainer ticks what to **stage this wave** — how many, what order, what | §1 Supply | phase 0 → shortlist.mjs (ADR 0013 §1) |
| `plugin/skills/run-team/SKILL.md` | 584 | unticked ticket keeps `ready-for-agent` and returns next wave. | §1 Supply | phase 0 → shortlist.mjs (ADR 0013 §1) |
| `plugin/skills/run-team/SKILL.md` | 586 | Never put two sequenced tickets in one wave. That lives in the brief's `Out of | §1 Supply | phase 0 → shortlist.mjs (ADR 0013 §1) |
| `plugin/skills/run-team/SKILL.md` | 673 | on re-poll attempt 24 (~2 min) in one wave and attempt 14 (~84s) in the next, | §4 Merge | measurement note: wave → pass |
| `plugin/skills/run-team/SKILL.md` | 733 | wave**: dispatching the next batch on top of an unresolved tier mismatch | §1 Supply | "stops the wave" → "holds the next Pull" (#1778) |
| `plugin/skills/run-team/SKILL.md` | 773 | **One implementer per staged wave goes at the alternate tier — one per phase-0 | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 780 | **Count the rate against phase-0 staging, because "wave" is not a dispatch | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 782 | no new wave — the guard below says it outright, "refill is level-triggered, so | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 783 | there are no implementer waves" — so a rule counted per refill would put roughly | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 785 | pool empties, and each of those stagings is a fresh wave that carries its own | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 812 | **Why one per wave and not a week of one tier followed by a week of the other:** | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 849 | within-run pairing above**: one implementer per wave at the alternate tier makes | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 852 | else** — the alternate member is picked as the most ordinary ticket in its wave | §1 Supply | staging language → Pull/shortlist (ADR 0013) |
| `plugin/skills/run-team/SKILL.md` | 923 | refill is level-triggered, so there are no implementer waves. **Append one row… | §1 Supply | refill prose → Pull (ADR 0013 §2) |
| `plugin/skills/run-team/SKILL.md` | 1059 | from now on every wave contributes a `sonnet` and an `opus` implementer run | §1 Supply | alt-tier per staging → every 5th Pull (ADR 0013 §6) |
| `plugin/skills/run-team/SKILL.md` | 1070 | per wave by construction. **Do not read the pairs early.** Report the count — | §1 Supply | alt-tier per staging → every 5th Pull (ADR 0013 §6) |
| `plugin/skills/run-team/SKILL.md` | 1082 | than implementation (Red flags, below), so one extra fix-round costs a wave slot | §2 Implementer dispatch | "costs a wave slot" → "costs an implementer slot" |
| `plugin/skills/run-team/SKILL.md` | 1121 | OMP: a freed slot is refilled by the staging wave's own dispatch pool, which ha… | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1134 | that wave by hand, exactly as the Claude line above describes, and report the | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1137 | 9), never something a run writes in order to dispatch a wave. | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1139 | **One named pool per phase-0 staging wave, named after that wave.** A pool | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1141 | drains whenever supply momentarily empties — so the wave is the pool's natural | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1167 | and still counts against the wave's cap.** A pool is homogeneous in its agent — | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1169 | is one implementer per staged wave at the *other* definition, so that one is | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1199 | first pooled wave and report it if it is not. | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1222 | ticket demoted mid-wave is excluded from its own pool's remaining pushes and | §2 Implementer dispatch | pool block deleted (ADR 0012 Decision 4) |
| `plugin/skills/run-team/SKILL.md` | 1239 | the wave under a new pool name, and never let a pool nobody can read present as… | §2 Implementer dispatch | pool block deleted, retired with workpool |
| `plugin/skills/run-team/SKILL.md` | 1543 | - **Reviewer labels a PR** → merge-bot wave. | §6 Loop | merge-bot wave reports → pass reports (#1774) |
| `plugin/skills/run-team/SKILL.md` | 1544 | - **Monitor: `ready-to-merge` appears** → merge-bot wave. Catches hand-added la… | §6 Loop | merge-bot wave reports → pass reports (#1774) |
| `plugin/skills/run-team/SKILL.md` | 1546 | and the wave's first act on a behind PR is a rebase** — which is destructive to | §6 Loop | merge-bot wave reports → pass reports (#1774) |
| `plugin/skills/run-team/SKILL.md` | 1553 | - **Merge-bot wave reports done** → reap merged branches and worktrees (below), | §6 Loop | merge-bot wave reports → pass reports (#1774) |
| `plugin/skills/run-team/SKILL.md` | 1570 | `skipped` (behind-count staleness, the normal wave case) still labels — do NOT | §6 Loop | wave → pass |
| `plugin/skills/run-team/SKILL.md` | 1628 | **merge-bot wave reports done** and **Monitor: CI run completes** — end with one | §6 Loop | edges → record-before-tick table (§6 §7) |
| `plugin/skills/run-team/SKILL.md` | 2568 | guard — but its refusal costs a wave and leaves the label lying, which is yours | §4 Merge | "costs a wave" → "costs a pass" |
| `plugin/skills/run-team/SKILL.md` | 2802 | Per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read | §4 Merge | `merge-bot-<wave#>` → `merge-bot-<n>` (ledger.mjs dispatched) |
| `plugin/skills/run-team/SKILL.md` | 2864 | (three waves measured 20-377 core each, against ~2000 for the poll loop) and tr… | §4 Merge | wave count measurement → pass count |
| `plugin/skills/run-team/SKILL.md` | 2901 | merge. At 6+ open PRs batch a wave rather than merging singles. Any behind-count | §4 Merge | "At 6+ open PRs batch a wave" retired (#1774 §9) |
| `plugin/skills/run-team/SKILL.md` | 2904 | `run-merge-bot.md` carries the mechanics — intra-wave re-checks, run-binding, t… | §4 Merge | "intra-wave" → "intra-pass" |
| `plugin/skills/run-team/SKILL.md` | 2907 | ### Reap after every wave | §4 Merge | heading: "Reap after every wave" → "after each merge pass" |
| `plugin/skills/run-team/SKILL.md` | 2910 | worktree — and its `node_modules` — still on disk. Reap after **each** wave, not | §4 Merge | wording: wave → pass |
| `plugin/skills/run-team/SKILL.md` | 2923 | reported, never removed. Read `worktreesRemoved` alongside `reaped`: a wave that | §4 Merge | wording: wave → pass |
| `plugin/skills/run-team/SKILL.md` | 2945 | fires per merge wave and nothing fires at end of run, so the claim survives it… | §4 Merge | wording: wave → pass |
| `plugin/skills/run-team/SKILL.md` | 2987 | write directly (**Phase 1**, **Reap after every wave**, **Release the claims | §4 Merge | "Reap after every wave" → "after each merge pass" |
| `plugin/skills/run-team/SKILL.md` | 3104 | `docs/metrics/member-outcomes.tsv`, not one wave.** A single `run_date` is not | §6 Loop | queue depth section retired (§6 Change surface) |
| `plugin/skills/run-team/SKILL.md` | 3105 | representative — `run_date=2026-08-10`, the first full wave after #210 | §6 Loop | queue depth section retired (§6 Change surface) |
| `plugin/skills/run-team/SKILL.md` | 3112 | that would support narrowing, the opposite of the single-wave read. Taking the | §6 Loop | queue depth section retired (§6 Change surface) |
| `plugin/skills/run-team/SKILL.md` | 3114 | not an outlier wave, not overfit to a narrow recent slice): median implementer | §6 Loop | queue depth section retired (§6 Change surface) |
| `plugin/skills/run-team/SKILL.md` | 3126 | (Deeper waves do cost: the last PR in one pays the largest rebase and the longe… | §6 Loop | queue depth section retired (§6 Change surface) |
| `plugin/skills/run-team/SKILL.md` | 3127 | cycle. That is an argument for batching a wave, never for idling an implementer… | §6 Loop | queue depth section retired (§6 Change surface) |
| `plugin/skills/run-team/SKILL.md` | 3269 | **Do not guess the victim — the blast radius is the machine, not the wave.** | §6 Loop | wording: wave → Pull/pass per context |
| `plugin/skills/run-team/SKILL.md` | 3530 | tickets as taken, so the starvation compounds every wave. | §6 Loop | wording: wave → Pull/pass per context |
| `plugin/commands/run-merge-bot.md` | 82 | **Every fixture you write goes under `<scratch>/pr<N>/merge-bot-<wave#>/gate-pr… | §5 Merge gate | merge-bot-<n>; L82-106 deleted (§5 gate-proof retired) |
| `plugin/commands/run-merge-bot.md` | 89 | base=<scratch>/pr<N>/merge-bot-<wave#> | §5 Merge gate | merge-bot-<n>; L82-106 deleted (§5 gate-proof retired) |
| `plugin/commands/run-merge-bot.md` | 106 | Real readings are not fixtures: keep the `ci-state` payload you actually gate o… | §5 Merge gate | merge-bot-<n>; L82-106 deleted (§5 gate-proof retired) |
| `plugin/commands/run-merge-bot.md` | 142 | **`post != pre` with `pr_head` still on `pre` is not a desync until it SURVIVES… | §4 Merge | #1774 § Prose pins to rewrite; two-invocation rule (#1776) |
| `plugin/commands/run-merge-bot.md` | 168 | **Why the ref and not `headRefOid`: during the PR object's lag both operands go… | §4 Merge | #1774 § Prose pins to rewrite; two-invocation rule (#1776) |
| `plugin/commands/run-merge-bot.md` | 263 | **No rebase happened because the PR was already current? Pass the head twice.**… | §4 Merge | #1774 § Prose pins to rewrite; staleness/batching prose |
| `plugin/commands/run-merge-bot.md` | 281 | **Staleness fires *within* a wave, and it compounds.** The first merge makes ev… | §4 Merge | #1774 § Prose pins to rewrite; staleness/batching prose |
| `plugin/commands/run-merge-bot.md` | 283 | Measured over one three-merge wave: the next queue member went 0 → 2 → 7 → **10… | §4 Merge | #1774 § Prose pins to rewrite; staleness/batching prose |
| `plugin/skills/run-team/references/reaping.md` | 3 | Why reap runs after every wave, why `commit-commands:clean_gone` disqualified,… | §4 Merge | "after every wave" → "after each merge pass" |
| `plugin/skills/run-team/references/reaping.md` | 5 | ## Reap after every wave, not once at the end | §4 Merge | "after every wave" → "after each merge pass" |
| `plugin/skills/run-team/references/reaping.md` | 31 | Above walk finds branch's worktree by `branch refs/heads/<name>` line `git work… | §4 Merge | "after every wave" → "after each merge pass" |
| `plugin/skills/run-team/references/member-lifecycle.md` | 7 | Name makes it team member; membership carries `Agent` tool. Omit it → member lo… | §4 Merge | wording: merge wave → merge pass |
| `plugin/agents/fleet-implementer-alt.agent.md` | 3 | description: A /fleet-ctl:run-team implementer dispatched at the ALTERNATE tier… | §2 Implementer dispatch | "one per wave" → "every 5th Pull" (ADR 0013 §6) |
| `CONTEXT.md` | 41 | Deleting branches whose upstream is gone, and their worktrees, after a merge wa… | done in this PR (#1795) | done in this PR — "after each merge pass" |
| `CONTEXT.md` | 160 | machine to dispatch its own wave. Three exist, all on omp, all session-wide: | done in this PR (#1795) | done in this PR — "dispatch its own members" |

### 8.2 Pins and files per section

§ 1: see ADR 0013 Decision 1, 4, 6 and § 1's change-surface paragraph;
§ 2: § 2 Change surface; § 3: § 3 Change surface; § 4: § 4 Prose pins to
rewrite; § 5: § 5 What leaves the prose / Tests; § 6: § 6 Change surface.

### 8.3 Code-side "wave" wording (breaking cutover)

**Breaking cutover for metrics** (#1774): "Wave" is removed with a
breaking cutover: no legacy name handling, and the `merge wave` regex in
`compute-spend.mjs` is deleted. Stored records (transcripts,
`docs/metrics/*.tsv`, accepted ADRs, dated specs) are not migrated. Guards
1 and 2 count only merged PRs after the cutover (at least 20), against the
frozen #1769 baseline of 1,078k fleet `cache_creation` per merged PR. If
pre-cutover sessions are re-scraped, up to 3 `MergeBotWave<N>` omp rows may
be rebooked as `other` [unmeasured]; that is accepted, because the guards
don't read pre-cutover rows.

**Wording only** (#1778): `fleet-state.mjs` L26/30/223/290,
`fleet-heartbeat.mjs` L218/252 context, `instruments.sh` L84 ("per wave" →
"per pass"), `reap.sh` L1128 comment (title unchanged), `fleet-
state.test.mjs` L210 ("during a merge wave" → "during a merge pass").

**The verb "waves"/"waves it through"/"waves the mutant through"**, used
in several test comments, matches `\bwaves\b`. A no-`wave` gate should
either rephrase these or exempt the verb. The fixture filename
`workflow-files.mjs` L62 (`"merge-wave.js"`) and
`workflow-meta-first.test.mjs` L158/177 quote the layout tree of the dated
2026-07-23 spec. Rename the fixture, or keep it as a quotation.

Remaining code-side hits, wording only unless a section above says
otherwise (re-grep at `6f2c654`, non-test files):

- `plugin/scripts/board.mjs:1011,1160`
- `plugin/scripts/ci-state.mjs:404`
- `plugin/scripts/compute-spend.mjs:147,150,151,165`
- `plugin/scripts/fleet-heartbeat.mjs:218`
- `plugin/scripts/fleet-state.mjs:26,30,223,290`
- `plugin/scripts/fleet-tick.mjs:684,695,697`
- `plugin/scripts/marked-pairs.mjs:295`
- `plugin/scripts/member-record.mjs:125`
- `plugin/scripts/pool-preflight.mjs:37,86` (file deleted per § 2)
- `plugin/scripts/tier-check.mjs:7,48`
- `plugin/scripts/tier-roles.mjs:233`
- `plugin/scripts/workflow-files.mjs:62`
- `plugin/scripts/instruments.sh:84`
- `plugin/scripts/no-undo-audit.sh:350`
- `plugin/scripts/reap.sh:1121,1128,1338`
- `plugin/scripts/release-ticket.sh:338`

Test files are not listed here; each ticket in § 9 owns its pins.

## 9. Tickets (input to /to-tickets)

Breakdown approved by the maintainer at the `/to-tickets` quiz, 2026-09-24.
Blockers first; every slice is additive until T7–T9, which cut over
`plugin/skills/run-team/SKILL.md` prose serially because all three touch
it.

| # | Title | Blocked by | Delivers | Spec § |
|---|---|---|---|---|
| T1 | `shortlist.mjs`: the Shortlist as a script (`candidates` → dep scan → `inflight.sh` → minus live Exclusions) writing `.fleet/shortlist.json` | — | `node plugin/scripts/shortlist.mjs` writes the oldest-first survivors with `scanned`; test covers drop reasons and premise lift | 1; ADR 0013 §1, §3 |
| T2 | `ledger.mjs dispatch\|settle\|drain`, the `<member>`/`<member>=<outcome>` grammar and the `## Dispatched` list | — | subcommands + parser + usage; `merge-bot-<n>` count from `## Dispatched`; tests | 6 §2, 4 item 2 |
| T3 | `merge-gate.mjs` + `merge-gate.test.mjs` (additive; no prose or pin changes) | — | #1776 T-a exactly: interface, exit vocabulary, fixed `--declare-no-ci` argv, test list | 5 |
| T4 | Implementer agent bodies: the shared implementer blocks move into `fleet-implementer{,-alt}.agent.md`; byte-equal test; alt description drops "one per wave" | — | both agent files carry the body; a test pins them byte-equal; SKILL.md untouched (removed in T7) | 2 Decision 2 |
| T5 | Off-turn review unit: `fleet-review-runner.agent.md`, `review-core.js`/`review-pr.js` result key order + one in-run retry + `resumeFor` wording, `review-and-fix.md` reads `<scratch>/review-<pr>.json` | — | `review-pr-<n>` member runs `runReviewOnOmp` to completion; fix-applier reads the file and owns rulings; pins updated | 3 §1–§6 |
| T6 | `fleet-tick.mjs` reads the run: ledger + shortlist derived inputs, `PULL`/`DISPATCH`/`REFRESHED`/`HOLD` rows, `--max-reviews`, drain; delete `liveness()`, `readSupply()`, POOL/UNKNOWN, `pool-preflight.mjs` (+test), `marked-pairs.mjs` `#1590` exception; `instruments.sh` pin list | T1, T2 | tick output per § 6 §1–§6; `fleet-tick.test.mjs` cases from § 6 Change surface | 6, 2 Decision 3 |
| T7 | Prose cutover — supply and dispatch: phase 0 → `shortlist.mjs`, phase 1 Pull table + relabel-by-cause, phase 2 direct-dispatch Pair and block removal, alt-tier every 5th Pull, § Queue depth supply definitions, § Run ledger grammar, README L35, `CONTEXT.md` § Install precondition list; their pins | T1, T2, T4, T6 | SKILL.md phases 0–2 read per ADR 0013 and spec § 2; `pool-dispatch-dialect-prose`, `implementer-model-tier`, `within-run-pair-prose`, `tier-routing-prose` pins green | 1, 2, 8 |
| T8 | Prose cutover — loop and reviews: phase 3 record-before-tick table, `--max-reviews` Pair, § Reviewers / fallback / fix-applier prompt, tier guard under Pull; `fleet-tick-prose` pins; wording in `fleet-state.mjs`, `fleet-heartbeat.mjs`, `fleet-tick.mjs` L684–697 | T5, T6, T7 | SKILL.md phase 3 and § Reviewers read per spec § 3 and § 6; pins green | 3, 6, 8 |
| T9 | Prose cutover — merge side (#1776 T-b folded into #1774's prose): `run-merge-bot.md` two-invocation step 3, deletions (§ Prove the gate blocks, `--declare-no-ci` paragraph), `merge-bot-<n>` paths; SKILL.md § Merge bot + § Reap after each merge pass; `references/reaping.md`, `member-lifecycle.md` L7; `compute-spend.mjs` regex, `member-record.mjs`, `instruments.sh` L84, `reap.sh`; all merge-side pins | T2, T3, T8 | no `wave` remains in `plugin/skills`, `plugin/commands`, `plugin/agents`, `CONTEXT.md` (outside `_Avoid_` lines) — the map's destination criterion | 4, 5, 8 |

## Not yet specified (for the map)

- #1774: **Non-merge "wave" uses** stay out of that ticket's scope. These
  are staging wave, pool dispatch, busy-wave heartbeat, within-run pair,
  tier-check and implementer-model-tier, in `fleet-state.mjs`,
  `fleet-heartbeat.mjs`, `fleet-tick.mjs` L684–697,
  `pool-dispatch-dialect-prose.test.mjs`, `within-run-pair-prose.test.mjs`,
  `tier-check.mjs` L7/40, and `CONTEXT.md` L160. Owners: #1775, #1778, or a
  #1779 sweep.
- #1774: **The verb.** "waves it through" / "waves the mutant through",
  used in several test comments, matches `\bwaves\b`. A no-`wave` gate
  should either rephrase these or exempt the verb.
- #1774: **`merge-wave.js`.** This fixture filename (`workflow-files.mjs`
  L62, `workflow-meta-first.test.mjs` L158/177) quotes the layout tree of
  the dated 2026-07-23 spec. Rename the fixture, or keep it as a
  quotation.
- #1775: `board.mjs`/`compute-board.mjs` will render an `excluded ·` row as
  a ticket card; decide whether the cockpit shows exclusions or filters
  the prefix.
- #1775: `merge-bot-<n>` counter has no per-ticket row to count; #1774
  resolves this by counting the ledger's `## Dispatched` list instead
  (spec § 4 item 2).
- #1776: fold the labelled-head timeline read (`run-merge-bot.md` L51–68)
  into `merge-gate` (`--post` exempting the bot's own rebase). Needs a
  probe first: the timeline event shape a `gh pr update-branch --rebase`
  lands as (`head_ref_force_pushed` with `after == post`?) is unmeasured,
  and `headRefOid ∈ {pre, post}` cannot substitute — a head that moved
  before the bot started is already `pre`.
- #1776 (Caveats): `merge-gate` output field `instruments` carries the
  digest `instruments.sh` prints; whether the controller wants it in
  `ci.json` at all is a T-a implementer's call — dropping it changes no
  exit.
- #1777 (Caveats): `read proc://` at fleet-scale row counts untested (R4
  caveat carries over); not load-bearing for spec § 2 since the tick no
  longer reads it.
- #1777 (Caveats): Claude-side system-prompt injection of the agent body
  not re-probed this session (it is the documented mechanism and every
  fleet review specialist already relies on it).
- #1778: `board.mjs`/cockpit reading the new `=`-tokens and `## Dispatched`
  — render settled vs live members, or ignore.
- #1778: whether `fleet-tick`'s per-tick `shortlist.mjs` run should be
  rate-limited on the heartbeat ceiling (one `candidates.mjs` query per
  ≤20 min is the status quo cost; not measured under the low-water
  trigger).
