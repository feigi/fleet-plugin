# Per-ticket model+effort router: inputs, exploration, instrument, and the constant-table router

Date: 2026-09-28
Status: decided on map #2030 (2026-09-28); accepted as ADR 0016; handed to `/to-tickets` (§ 8).
Map: feigi/fleet-plugin#2030. Decision tickets: #2035, #2036, #2037, #2038; baseline readout #2031.
ADR: `docs/adr/0016-per-ticket-model-effort-routing.md`.
Amends: `docs/adr/0013-automatic-supply-relabel-by-cause.md` § 6 (append-only — see § Amendment there).
Relates to: `docs/research/tier-readout.md` (branch `research/tier-readout`), `docs/metrics/member-outcomes.tsv`, `docs/metrics/tier-outcomes.tsv`.
Base tree: `main` at PR #2111 (ADR 0014, omp-only cutover, single `model: "@<role>:<level>"` frontmatter key) and PR #2059 (default cell moved opus/xhigh → opus/**high**). Line numbers below are read against that tree as of 2026-09-28 and drift; re-grep before editing — § 6 (below) records every place a cited hand-off anchor had already drifted at spec-writing time.

Cells are omp roles paired with a thinking level, never vendor model names,
in any token, definition, or prose this spec or its tickets write. The
model behind a role is read from `member-outcomes.tsv`'s `model` column,
never written into a cell's name.

## 1. G1 — Inputs

Source: `#2035` resolution (2026-09-28T08:54:50Z) + its amendment from
`#2038` (last comment, 2026-09-28T12:25:52Z).

**Measurement basis.** Evidence over the 282 candidate tickets in
`docs/metrics/tier-outcomes.tsv`, from one bulk `gh issue list --json
number,title,body,comments,labels,createdAt`. Observational and univariate;
the floor failure rate across all of them is 56.7%.

**Rules.**
1. **Kept = recorded.** Every metric that is free, deterministic, known
   before dispatch, present on most tickets, and actually varies gets
   recorded. Router v1 (`#2038`) chooses which ones it uses. A reasoned
   (token-costing) metric is kept only if a router variant consumes it.
2. **No network call beyond the Pull's step-3 read.** Step 3 becomes one
   `gh issue view <N> --json title,body,comments,labels,createdAt` written
   to `<scratch>/impl-<N>/issue.json`; the controller renders its read from
   that file, and the router script reads the same file. The script never
   touches the network. A missing or unparseable file leaves the metric
   columns blank.
3. **Brief text.** The last comment containing a line matching `^## Agent
   Brief` — otherwise the issue body. The script applies this rule; the
   controller never supplies the text.

**Kept metrics:**

| column | derivation | value | signal (fail% ÷ median / >median) |
|---|---|---|---|
| `brief_chars` | Unicode code points of the trimmed brief | int ≥ 0 | p=0.39 vs post-hoc `loc`; heavy 21%→52% across the median |
| `criteria` | brief lines matching `^\s*[-*]\s*\[[ xX]\]` | int ≥ 0 | when none 50.6/65.3; p=0.27; heavy 26%→62% at >5 |
| `comments` | raw gh comment count, unfiltered | int ≥ 0 | 53.1/61.5; p=0.21 |
| `paths` | distinct backtick tokens with no whitespace, containing `/` or ending `.ext` | int ≥ 0 | 53.7/60.2; p=0.01 |
| `test_paths` | `paths` tokens matching `\.test\.\|\(^\|/\)tests?/` | int ≥ 0 | 58.0/55.3; flat |
| `xrefs` | distinct `#<digits>` mentions in the brief | int ≥ 0 | blank kept under rule 1 |
| `kind` | first label of `bug`/`enhancement`/`documentation` | label | covers ≈52% (label `bug` 131, `enhancement` 16) |

**Dropped:**
- `decided/undecided`: always decided among dispatched tickets, because the
  Pull gates on it.
- `class`: subjective, its value set has drifted (`#2116`, resolved
  2026-09-28: `class` retired), and correction covers tests-only and
  production diffs far more than does routine. It is already stored in
  `tier-outcomes.tsv` —
  the eligibility rule below reads it from the ledger row, not from
  `ticket-features.tsv`. Confound: it is not a router input.
- `Agent Brief Category`: free text, 48% coverage, degenerate (273/282
  tickets have ≤2 labels).
- **Existence and LOC of cited paths:** only 15.8% of tickets cite a path
  that exists as written, because of the `skills/fleet/` → `plugin/`
  rename (`d687ebb3`); 147 of 534 path tokens use the stale prefix. Any
  future rename breaks it again.
- **`router_tokens`:** replaced by `#2032`. The router member's cost comes
  from its own `member-outcomes.tsv` row, not a single un-priceable sum.

**Variant B (reasoned sizing) — kept, gated.** Before any B Pull runs:
Haiku sizes the 121 tickets that have a member's own light/heavy sizing
verdict, seeing only comments dated before dispatch. Scored by **balanced
accuracy** against the member's own verdict. The free baseline is fixed,
not fitted: heavy if `brief_chars` > the verdict-known median (3,483.5) or
`criteria` > 5. B goes live only if haiku beats the baseline by **≥10
points**. If it fails, the live A/B test is recorded as not run, with the
reason.

**Member-side sizing is kept** (resolves the map's open item): the
member's `sizing_pre` is the reference label for the backtest and for
every later check of `sizing_pre`. It is never shown to the member — that
would anchor and contaminate the label.

**Amendment from `#2038` (Router, resolved 2026-09-28) — folds into `ticket-features.tsv`'s columns:**
1. **Columns:** `run_date session agent ticket policy_cell chosen_cell
   exploration_draw sizing_src sizing_pre router_usd brief_chars criteria
   comments age_days paths test_paths xrefs kind` (18). `agent_router` is
   dropped (no member exists); `sizing_src` ∈ `rule|haiku|jev:<model>` — the
   resolved model, so a silent haiku fallback is visible in the data;
   `router_usd` from `status().cost`, blank on arm A.
2. **No `fleet-router` member.** `sizing_pre` on B Pulls comes from one
   `judge()` call in the controller's eval cell (measured: resolves to
   `anthropic/claude-haiku-4-5`, $0.0002, 0.6 s, one-hot probabilities ⇒
   uncalibrated). Written to `<scratch>/impl-<N>/sizing.json`; the route
   script reads the file, never the network.
3. **Backtest gate generalised:** any B classifier must beat the
   *incumbent* B classifier (`rule` until `haiku` passes) by ≥10 pts
   balanced accuracy on the 121 labelled tickets, assert the expected model
   id, and write `docs/research/sizing-backtest-<model>.tsv` so the verdict
   re-derives without re-calling.

**Record:** `docs/metrics/ticket-features.tsv`, one row per Pull, written
by the router script at dispatch. Authored, append-only, never
regenerated. A row with no `member-outcomes.tsv` match means dispatch
failed. `run_date` = the UTC date in the session id (informational only,
may differ from `member-outcomes.tsv`'s own `run_date` for the same
session — that field derives from transcript mtime, which can cross UTC
midnight; not part of any join).

**Joins:** `ticket-features.tsv` ↔ `tier-outcomes.tsv` on `ticket` alone
(`tier-outcomes`'s `ticket` value split on `+`, no `run_date`); when a
ticket is re-dispatched, the **last** row before the ruling carries the
verdict — earlier rows are superseded attempts whose tokens still book to
the PR. `ticket-features.tsv` ↔ `member-outcomes.tsv` on `session`+`agent`
(`agent` ≠ `impl-<ticket>` in general: re-dispatches are named
`impl-<N>-2`, alt pairs `impl-<N>b`, and `member-outcomes.tsv` leaves
`ticket` blank for those names — `ticket-features.tsv`'s own `ticket`
column is the reliable link).

**Pending-row path:** `.fleet/ticket-features.pending.tsv`, named
explicitly. The scratch root is harness-injected, not a contract; a
`.fleet/` file is. In a consumer repo with no drain hook the file grows
~200 B/Pull inside a gitignored directory — accepted; the plugin's own
phase 0 can prune it later if growth ever matters. **Write path:** per
`#2089`, this is a plugin-only write; the drain into
`docs/metrics/ticket-features.tsv` runs through the repo-local hook (§ 5,
below), not through `plugin/skills/run-team/SKILL.md`.

## 2. G2 — Exploration

Source: `#2036` resolution (2026-09-28T10:47:22Z) + Addendum
(2026-09-28T11:00:42Z) + amendment from `#2038` (last comment,
2026-09-28T12:26:54Z).

**Cell.** A cell is `<role>-<level>` — an omp role (`slow`, `task`,
`smol`) and a thinking level (`minimal`, `low`, `medium`, `high`, `xhigh`,
`max`). Grammar, exported from `plugin/scripts/ledger-grammar.mjs`:

```js
export const CELL = /^(slow|task|smol)-(minimal|low|medium|high|xhigh|max)$/;
```

One definition per cell, `plugin/agents/fleet-implementer-<cell>.agent.md`,
frontmatter exactly:

```yaml
name: fleet-implementer-<cell>
description: A /fleet-ctl:run-team implementer at cell <cell>. Dispatched by the controller in phase 2, never invoked directly; the body is byte-identical across every fleet-implementer-* definition.
model: "@<role>:<level>"
```

The route derives from the file name (`fleet-implementer-slow-medium` ⇒
`@slow:medium`); a pin asserts the derivation for every
`fleet-implementer-*` file and that every body is byte-identical.
`fleet-implementer.agent.md` and `fleet-implementer-alt.agent.md` are
**deleted**; nothing is named `fleet-implementer` alone.

**Grid at ratification (K_all = 5):**

| cell | route | role at ratification |
|---|---|---|
| `slow-high` | `@slow:high` | default = `policy_cell` (PR #2059's opus/**high**) |
| `slow-medium` | `@slow:medium` | one level down on the default role |
| `task-high` | `@task:high` | continues the effort-matched slice R1 found (n=10, 30% vs 45%) |
| `task-max` | `@task:max` | the cheaper role at its ceiling |
| `smol-high` | `@smol:high` | the cost floor |

**Cell-level membership constraint (addendum).** A cell's level must be in
`modelRoles.<role>`'s current target's `thinking.efforts`. Measured
against omp's own catalog: `claude-sonnet-5` and `claude-opus-5-5` are
`anthropic-adaptive` with `[low, medium, high, xhigh, max]` — `task-max` is
a distinct wire effort, not a budget collapse, so the cell measures
something real. `claude-haiku-4-5` is `mode: budget` with `[minimal, low,
medium, high, xhigh]` — **no `max`**; a `smol-max` cell would silently
clamp, tier-check would read a different level than declared, and every
row would be inadmissible. Rule: adding a
`fleet-implementer-<cell>.agent.md` file requires the level to be in the
target's `thinking.efforts`; the phase-0 drift notice (below) also fires
when a role's *new* target no longer supports an existing cell's level.

**Exploration Pull.** Unchanged counter: count the `impl-` rows in
`.fleet/ledger.md` at Pull time; the Pull that creates row 5, 10, 15 … is
an Exploration Pull (standing decision 8; neither taper nor raise ruled;
at the measured ~170 omp implementer rows/month that is ~34 Exploration
Pulls/month, ~8.5 per non-default cell). Every other Pull dispatches
`fleet-implementer-<policy_cell>`; `policy_cell` is `slow-high` on every
Pull until the router (§ 4) exists.

**Draw.** Let E be `router-table.json.cells` at dispatch time, minus
`policy_cell`, sorted lexicographically by token; K = |E|. Then:

```
k = 1 + (parseInt(sha256(`${session}\t${ticket}`).slice(0, 8), 16) % K)
chosen_cell = E[k − 1]
```

`session` is the omp session id (the string `ticket-features.tsv` records
in `session`), `ticket` the issue number. No RNG, no seed token: the draw
is reproducible from the row's own columns plus `router-table.json.cells`
present at that commit, and a re-dispatch of the same ticket in the same
session (`impl-<N>-2`) lands on the same cell. Propensity is 1/K; the draw
includes every non-default cell uniformly. The draw lives in the router
script (§ 4) as one pure function, `drawCell({ session, ticket, policyCell,
cells }) → { cell, k, K }`, exported from `ledger-grammar.mjs` alongside
`CELL`.

**K=0 rule (addendum).** When every non-default cell has been withdrawn
(E empty), the Exploration Pull dispatches `policy_cell` instead:
`exploration_draw` stays blank, `chosen_cell = policy_cell`, no `tier=`
ledger token is written. `drawCell` returns `{ cell: policyCell, k: 0, K: 0
}`; the caller writes the draw column only when `K > 0`. No `% 0`.

**Eligibility.** The Exploration assignment rolls to the next Pull only
when the pulled ticket is one another open ticket sequences after
(`behind-issue:#M`). `class=correction` **no longer rolls**: `class` is not
a router input (§ 1), its meaning has drifted (`#2116`), and the
floor-failure rate is flat across classes (routine 56.7%, correction
51.1%) — excluding corrections only reintroduces the difficulty confound
the readout (`#2031`) measured and this map exists to remove. No
feature-based exclusion: a heavy ticket may draw `smol-high`; review +
finisher are the safety net (standing decision 3). The member is never
told. Exploration is not pausable per run; `/run-team` gains no argument;
withdrawing a cell (below) is the only off switch.

**Records.**
- **Ledger:** `ledger.mjs row <N> "impl-<N> · … · tier=<cell>"` on
  Exploration rows only; a row without `tier=` ran at `policy_cell`; a
  replacement inherits the row's `tier=` token. `tier=` stays a free-text
  row token; the writer validates the value against `CELL`.
- `docs/metrics/ticket-features.tsv` (§ 1): `policy_cell` always filled;
  `chosen_cell = policy_cell` exactly when `exploration_draw` is blank;
  `exploration_draw = <k>/<K>` on Exploration Pulls. Both cell columns use
  the `CELL` token.
- `docs/metrics/tier-outcomes.tsv` `tier` column: the `CELL` token for
  every row dispatched under this spec (`slow-high`, `smol-high`, …); the
  `ticket-features.tsv` join on `ticket` remains authoritative.
- `docs/metrics/member-outcomes.tsv`: no new column from this section;
  `subagent_type` carries `fleet-implementer-<cell>`, `model`/`effort`
  carry what resolved.

**Admissible row.** A row counts for the per-cell readout and the stopping
rule only when its ledger outcome is not `tier-mismatch` (tier-check
passed: resolved model = `modelRoles.<role>`'s target at dispatch) and
`member-outcomes.tsv`'s `effort` equals the cell's `<level>`. Rows
dispatched as `fleet-implementer`/`fleet-implementer-alt` (pre-cutover
history) are never admissible to the per-cell readout.

**Comparison with N cells.** "Unconfounded comparison" = a *within-session*
comparison: for cell X ≠ `slow-high`, one session holding ≥1 admissible row
with `chosen_cell = X` and ≥1 admissible row with `chosen_cell = slow-high`
whose resolved (`model`, `effort`) differ from X's. **Per-cell gate:** read
cell X only once it has ≥10 comparisons across ≥5 distinct `run_date`s.
This query lives in `plugin/scripts/cell-readout.mjs` (new, § 4/§ 6), not
in `member-outcomes.tsv`'s own header — it reads `ticket-features.tsv`
joined to `member-outcomes.tsv` on `session`+`agent`, and prints one line
per cell (`<cell> <comparisons> <run_dates> <resolved models>`), never
enough to identify a specific comparison.

**Role-target drift.** A cell is a role, and `modelRoles.<role>` is
operator config that has changed silently before (measured: alt and top
both resolved to sonnet on two different dates). Accepted as the price of
omp's indirection; rows pool across resolved models. Two warnings:
1. **Phase 0 notice** (per the addendum, this belongs to the repo-local
   hook — § 5 — not to `tier-roles.mjs`, which stays metrics-blind and
   only supplies the current `modelRoles.<role>` target): for each
   `fleet-implementer-<cell>` definition whose most recent admissible
   `member-outcomes.tsv` row exists, compare that row's `model` against the
   current target; differ ⇒ `tier-roles: notice: fleet-implementer-<cell>
   last ran <model-then>; modelRoles.<role> now resolves <model-now> —
   cell history spans two models`. It also fires when a role's new target
   no longer supports an existing cell's level.
2. **Close-out readout** (`cell-readout.mjs`): a cell whose gate-window
   rows span >1 resolved model prints `mixed (<model-a> n=…, <model-b>
   n=…)` in its models column.

**Per-cell stopping rule.** Computed at close-out by the repo-local hook
(§ 5), immediately after it drains `ticket-features.pending.tsv`: for cell
X, verdicts = admissible `ticket-features.tsv` rows with `chosen_cell = X`
and `run_date` ≥ the date `fleet-implementer-<cell>.agent.md` was most
recently added, joined to `tier-outcomes.tsv` on `ticket` (last row per
ticket dated ≥ the `run_date` of the ticket's last such row at X; a row
whose `closed_own_ticket` and `minted_false_claim` are both blank was never
ruled and is skipped; a ticket with no such row is no verdict). When
verdicts ≥ 10 AND floor failures ÷ verdicts ≥ 0.80 (P ≈ 12%
on one look, ≈13.5% cumulative across repeated close-out checks, at the
measured 56.7% base rate — not the ≈5% a 50% assumption gives), the
hook files one issue: title `Withdraw
exploration cell <cell>: <failures>/<verdicts> floor failures`, label
`ready-for-human`, body = the verdict table; deduped on an open issue with
the same title. **Withdrawal** = a PR that removes the cell from
`router-table.json.cells` and deletes its
`fleet-implementer-<cell>.agent.md` in the same commit (K shrinks;
draws after that commit use the smaller E; dropping the cell from
`cells` — not just its file — keeps burn-in's `n≥20` end condition
reachable and keeps the draw from ever naming a cell with no live
definition). **Reinstatement** = the reverse PR, maintainer-only; the
date filter above restarts the count.

**Clarification from `#2725` (2026-10-04):** a ticket's verdict belongs to
one cell, the cell of its § 1 carrier. The ticket's ruling is its
latest-dated `tier-outcomes.tsv` row (the later in file order on a tie, a
both-blank row skipped); the carrier is the ticket's latest
`ticket-features.tsv` row across all cells, `slow-high` included, dated ≤
the ruling (the later in file order on a tie). The ruling is a verdict for
X only when the carrier is an admissible row at X dated ≥ the date
`fleet-implementer-<cell>.agent.md` was most recently added; this replaces
the "last row per ticket dated ≥ … the ticket's last such row at X" join
above, under which one ruling dated after Pulls at two cells counted for
both. A carrier at the policy cell, or one that is not admissible or predates
its cell's definition, charges nobody: the verdict does not fall back to an
earlier Pull.

**Amendment from `#2038` (Router, resolved 2026-09-28):**
1. **Burn-in:** while `router-table.json.burn_in` is true, **every** Pull
   draws — `drawCell({ …, policyCell: null, cells })` so E = all cells
   including `slow-high`, `exploration_draw = k/K` with K = |cells|. Ends
   when every cell in `cells` has pooled n≥20 in `cost-guard.json`; the fit
   flips the flag. Afterwards the every-5th-row draw applies unchanged.
2. **Staged `cells`:** stage 1 = `{slow-high, task-high, smol-high}` (model
   axis at fixed `high`); stage 2 adds `slow-medium`, `task-max` on
   surviving models. The list lives in `router-table.json.cells`; the fit
   advances it. Stage-2 `fleet-implementer-<cell>.agent.md` definitions may
   exist before they enter `cells`.
3. Rationale: at ~60 verdicts/week the 5k draw over K=4 reaches n=20/cell in
   6.7 weeks; stage-1 burn-in reaches it in ≈1.

## 3. G3 — Instrument

Source: `#2037` resolution (2026-09-28T10:47:47Z) + amendment from `#2038`
(last comment, 2026-09-28T12:26:56Z).

**Scope.** omp only. Claude Code rows (`harness=claude`, `cost: null`) are
outside the instrument entirely.

**Price source.** `docs/metrics/member-outcomes.tsv` gains four columns,
appended **after `subagent_type`**: `tokens_in`, `tokens_cache_read`,
`tokens_cache_write_1h`, `cost`. `cost` = Σ
`message.usage.cost.total` over the member's turns — omp's own per-turn,
provider-computed, TTL-aware figure; the **$ of record**.
`plugin/scripts/member-record.mjs`'s `ompMemberRecord()` already computes
`tokens_in`, `tokens_cache_read`, `tokens_out`, and `cost` (verify the
exact current lines before editing — see § 6); `tokens_cache_write_1h` is
new, from `cttl.ephemeral1h` (5m write = `tokens_cache_create −
tokens_cache_write_1h`). `docs/metrics/pricing.json` (new) exists only to
cross-check `cost` from the token columns; it never itself produces a
published $. **Backfill:** all 37 omp sessions currently in the TSV are
still on disk under `~/.omp/agent/sessions/**`; `mergeRows` is
replace-by-key, so one re-scrape fills history.

**Booking.** Charged to a PR:
- every `impl-*` attempt for its ticket, including superseded re-dispatches
  (`impl-<N>-2`, `impl-<N>b`) — the **last** row before the ruling carries
  the verdict (§ 1);
- `review-pr-<N>`, `fix-pr-<N>`, `finisher-pr-<N>` (and the finisher
  spellings `parseMemberName` already matches);
- review-fan-out specialists — **currently unbookable**: the dispatch label
  carries no PR number. On `main` today (post PR #2111 — `plugin/workflows/
  review-pr.js` no longer exists; see § 6 for the corrected file), the
  label templates live in `plugin/scripts/review-core.mjs`: a bare
  `"snapshot"` label, and `` `review:${d.key}` `` /
  `` `verify:${d.key}` `` for the specialist and verifier dispatches.
  **Change:** these three label sites gain a `:pr${pr}` suffix
  (`` `review:${d.key}:pr${pr}` ``, `` `verify:${d.key}:pr${pr}` ``,
  `` `snapshot:pr${pr}` ``); `parseMemberName` (in `member-record.mjs`)
  gains a pattern matching the new colon-delimited shape to extract `pr` —
  **the exact regex needs re-deriving against the current label shape**,
  the `#2037` hand-off's proposed pattern
  (`/^(review|verify|snapshot)[a-z]*pr(\d+)(-\d+)?$/`) assumed a
  path-segment shape from the now-deleted `review-pr.js`, not the
  colon-delimited shape `review-core.mjs` actually emits today;
- `fleet-router` — **retired** (§ 2/§ 4); routing cost is `router_usd` in
  `ticket-features.tsv`, a `judge()` call, not a member-outcomes join.

Excluded: `merge-bot-*` (cost does not vary with the implementer cell),
`memory`, `__advisor`.

**Cell key** = `ticket-features.tsv`'s `chosen_cell`, cross-checked against
the verdict-carrying `impl-*` row's resolved `model`/`effort`; a
disagreement is listed under `mismatch` and excluded from every cell,
never reassigned.

**Quality floor.** Failure = `minted_false_claim=yes` ∨
`closed_own_ticket=no`. Corpus fact: `minted_false_claim=yes` on 151/283
ruled PRs (53%), `closed_own_ticket=no` on 17/283; floor passes 122/283. At
n=20 the failure-rate SE is ≈11 points, so the guard cannot separate a
≤10-point rise from noise — the spec records this rather than hiding it.
Merged state is read from one `gh pr list --state all --limit 1000 --json
number,state,mergedAt` per run (`tier-outcomes.tsv` has no `merged`
column).

**Per-cell figures:** `n_pulls`, `n_merged`, `n_pass`, `fail_rate = failed ÷
merged`, `mean_usd` = the cell's total booked $ (merged + unmerged +
superseded attempts) ÷ merged — the guard figure, so an abandon-happy cell
carries its abandoned spend — `median_usd` over merged PRs only
(descriptive), `router_usd`.

**Guard.** See `docs/adr/0016-per-ticket-model-effort-routing.md` § Guard
for the full, amended rule (baseline, trip margin, retire condition). New
`plugin/scripts/pr-cost.mjs` (CLI) computes it; `compute-spend.mjs` is a
pure per-role library with no PR concept and stays untouched. Inputs: the
three TSVs + the one `gh pr list`. Output: stdout TSV per cell (`--json`
optional); `.fleet/cost-guard.json` (gitignored — `computed_at`,
`window_start`, `baseline{cell,n,mean_usd,fail_rate}`, `cells[]` (each with
`n`, `mean_usd`, `fail_rate` — the router reads per-cell `n` to end
burn-in), `tripped[]`, `verdict: ok|tripped|none`). Runs at **phase 0 and
close-out** through the repo-local hook (§ 5). No committed report
snapshot; the numbers a ruling turns on go into the ADR that rules, not
into a tracked file.

**`fleet-tick.mjs` row**, following the existing `HOLD (tier mismatch …)`
pattern (`#1111`'s carrier requirement), `acts:false`:
```
router  OK           (sonnet/high $12.3 vs opus/high $31.0, n=24/31; fail 25% vs 29%)
router  DEFAULT-ONLY (cost guard: haiku/high fail 45% > 29%, n=21/31)
router  NO VERDICT   (baseline n=7/20)
router  DEFAULT-ONLY (cost-guard.json missing — run pr-cost.mjs --guard)
```
A separate row, not a suffix on `implementers`: pinned by a new
`fleet-tick.test.mjs` case, not a rewrite of an existing one.

**The reasoning test (A vs B).** Assignment: `ticket % 2` — even → A
(deterministic metrics only), odd → B (plus `sizing_pre`). Deterministic,
keeps every re-dispatch of a ticket in one arm, independent of the 1-in-5
Exploration draw. Ruling: ≥20 merged PRs per arm. B wins iff `mean_usd`
**including `router_usd`** is lower than A's **and** `fail_rate` is not
higher; otherwise B is switched off. `pr-cost.mjs` also prints the
disagreement rate (`policy_cell` vs `chosen_cell` on B Pulls) — when arms
rarely differ the report says `underpowered`, not "B loses". The cell
guard counts every Pull by its cell regardless of arm. **B never runs**
until `#2127` (the Jev sizing backtest) passes and a non-default table row
exists — see ADR 0016 § Decision point 5.

**Amendment from `#2038` (folded in above):**
1. Trip rule margin (15 pts) — in the ADR's Guard section.
2. `cost-guard.json` per-cell shape (`n`, `mean_usd`, `fail_rate`) — above.
3. `router_usd` from `status().cost`, not a member-outcomes join — above.
4. **Fit objective is $ per merged PR only; the fit does not re-test the
   quality floor** — the guard is the only quality gate (§ 4).

## 4. G4 — Router

Source: `#2038` resolution (2026-09-28T12:26:50Z), § R1–R8, verbatim
(reflowed into this spec's numbering; content unchanged).

### R1. Shape

The router is a **stratum table**: `classifier(issue.json) → stratum ∈
{light, heavy, unknown}`, `table[stratum] → CELL`. Nothing else routes. v1
ships the table with one row, `"*": "slow-high"`; the first re-fit that
writes a non-default row **is** v2 — mechanism unchanged, data changed. No
parametric ticket→cell model, ever: at the reachable n a table diff is
reviewable, coefficients are not.

### R2. Classifiers (the extension seam)

| id | where it runs | output | used on |
|---|---|---|---|
| `rule` | route script, always | `heavy` iff `brief_chars > 3483 ∨ criteria > 5`, else `light`; `unknown` when metrics are blank | every Pull → `policy_cell` |
| `haiku` | one `judge()` call in the controller's eval cell, `{type:"choice", criteria:{light,heavy}}` over the issue text | `sizing.json` | arm B, once gated |
| `jev` | the same `judge()` call with TypeSafe credentials present | `sizing.json` | arm B, once gated |

`judge()` replaces the `#2035`-era haiku `fleet-router` **member** (≈175×
cheaper, $0.0002 vs ~$0.035; same model; cost from `status().cost`). No
`fleet-router` agent definition exists. The controller writes
`<scratch>/impl-<N>/sizing.json` = `{ source: "haiku"|"jev", model:
<status().model>, label, confidence, usd }`; the route script reads it if
present. Missing/unparseable ⇒ `unknown`. The script never touches the
network.

**Confidence:** ignored for `haiku` (uncalibrated, measured). For `jev`,
`confidence < τ` ⇒ `unknown`; τ is chosen by the backtest (max balanced
accuracy on non-abstained rows, abstain ≤ 20%) and checked into
`router-table.json` under `classifier`.

**Gate for any B classifier:** the `#2035` backtest (121 labelled tickets,
member's own sizing verdict as label) must beat the **incumbent B
classifier** (`rule` until `haiku` passes; then `haiku`) by ≥10 pts
balanced accuracy, and the batch's `status().model` must equal the
classifier's expected model id. The backtest writes
`docs/research/sizing-backtest-<model>.tsv` so the gate verdict re-derives
without re-calling. `sizing_pre` is recorded at dispatch and never
recomputed.

**A/B (from § 3) tests the classifier, not a second table:** on B Pulls
`chosen_cell = table[sizing.json.label]`, `policy_cell = table[rule]`. B's
gate = a classifier passed its backtest **and** the table has ≥1
non-default row. Until then: *B not run — the table has no row a better
classifier could change.*

### R3. Table artefact — `plugin/scripts/router-table.json`

```json
{
  "window_start": "<WINDOW_START from pr-cost.mjs>",
  "fitted_through": "<last run_date used>",
  "n_rows": 0,
  "stage": 1,
  "cells": ["slow-high", "task-high", "smol-high"],
  "burn_in": true,
  "rows": { "*": "slow-high" },
  "classifier": { "b": null, "tau": null },
  "estimates": { "<stratum>": { "<cell>": { "n": 0, "merged": 0, "usd_per_merged": null, "fail_rate": null, "fix_rounds": null, "review_findings": null } } }
}
```

Lives under `plugin/` because the route script runs from the installed
plugin. **Hierarchical rows:** the script uses `rows[stratum]` when
present, else `rows["*"]`. The fit writes a stratum row only when
candidate and baseline both have n≥20 in that stratum; `*` adopts on
pooled n. `estimates` exists so a re-fit PR diff explains itself;
`fix_rounds` and `review_findings` are report-only quality proxies — no
rule reads them.

### R4. Allocation — burn-in, then 5k

- **Burn-in** (`burn_in: true`): every Pull draws uniformly over `cells`
  **including** `slow-high` — `drawCell` called with `policyCell: null` so
  E = all cells, `exploration_draw = k/K` with K = `cells.length`. Ends
  when every cell in `cells` has pooled n≥20 in `cost-guard.json`; the fit
  flips `burn_in` to `false`. Cheaper than today (every non-default cell is
  cheaper than opus); the quality net is review + finisher.
- **After burn-in:** the every-5th-`impl-`-row draw (§ 2), E = `cells`
  minus `policy_cell`, unchanged.
- **Stage 1** = model axis at fixed `high`: `{slow-high, task-high,
  smol-high}` (K=3 during burn-in, over all three cells; K=2 applies
  only to the post-burn-in draw, which excludes `policy_cell`) —
  exactly the readout's unanswered effort-matched question. **Stage 2**
  adds the effort cells
  (`slow-medium`, `task-max`) on the models that survive stage 1; the fit
  advances `stage` and `cells` when every stage-1 cell has n≥20 and either
  a `*` adoption or an eviction has occurred. Stage-2 definitions may exist
  on disk before they enter `cells`.

Under stage 1 + burn-in at ~60 verdicts/week: n=20/cell in ≈1 week, n=60 in
≈3, first per-stratum rows in ≈2.

### R5. Fit — `ticket-router.mjs fit`

**Input rows:** `ticket-features.tsv` rows with `run_date ≥ window_start`,
joined to verdicts per § 1 (member-outcomes on `session`+`agent`;
tier-outcomes on `ticket`, split `+`; last row per ticket dated ≥ the
`run_date` of the ticket's last input row wins, a row whose
`closed_own_ticket` and `minted_false_claim` are both blank skipped — the
rule the § 2 stopping rule applies), restricted
to **arm A rows plus Exploration rows** (`exploration_draw` non-blank). B
non-exploration rows are excluded (they are the A/B's test set). No
inverse-propensity weighting: within a stratum every `chosen_cell` is
either the policy row or a uniform draw, so per-(stratum, cell) means are
unbiased; `exploration_draw` is an audit column.

**Adoption rule, per stratum s (and `*`):** among cells with n≥20 in s, not
in `cost-guard.json.tripped`, adopt the cell minimising **$ per merged PR**
= Σ`cost` of every row booked to the cell's PRs (failures, fix rounds,
re-dispatches, router $ included) ÷ merged rows, **iff** `usd_per_merged ≤
0.75 × baseline_s` (baseline = `slow-high` rows in s, n≥20). Else
`slow-high`. The fit does **not** re-test the quality floor — that is the
guard's job.

**Cadence and operator:** every **N = 50** merged PRs since
`fitted_through`, **run by the repo-local hook (§ 5) at close-out** (it
already drains the pending TSV and scrapes outcomes there):
`ticket-router.mjs fit` → chore PR through the review queue, never a direct
merge. A no-change fit still lands (`estimates` moves; reviewers watch n
climb). Never a maintainer-run obligation (`#1111`). The fit never moves
`WINDOW_START`.

**Check — `ticket-router.mjs --check`** (CI, alongside `tier-roles.mjs
--check`): re-fits from rows with `run_date ≤ fitted_through` and fails if
the result ≠ the checked-in table. The table is a code carrier.

### R6. Route — `ticket-router.mjs route`

```
node plugin/scripts/ticket-router.mjs route --session <id> --ticket <N> --arm <A|B> --impl-row <k> \
  --issue <scratch>/impl-<N>/issue.json [--sizing <scratch>/impl-<N>/sizing.json] \
  --guard .fleet/cost-guard.json --table plugin/scripts/router-table.json
→ POLICY=<cell> CELL=<cell> DRAW=<k/K|-> STRATUM=<light|heavy|unknown> REASON=<ok|no-issue-json|no-sizing|guard-missing|guard-tripped|table-cell-tripped>
```

Order: metrics → stratum (`rule`; `sizing.json` on B) → `policy_cell =
rows[stratum] ?? rows["*"]` → if that cell ∈ `tripped[]`, substitute
`slow-high` (`table-cell-tripped`; auto-revert, the next fit drops the
row) → guard eligibility (`tripped[]` leave E; missing/unparseable guard
⇒ default only, `guard-missing`) → draw (burn-in or 5k) → `chosen_cell`.
**Always exit 0 with a full line** on every data degradation. **Exit 2
only for usage errors** (bad args, unreadable/invalid `router-table.json`)
— a repo bug; the controller does not dispatch and emits an event per
SKILL.md's "a probe that could not look emits an event". `REASON` goes to
the ledger line only; the fit distinguishes fallback rows by blank
metrics. The controller holds no copy of the defaulting logic.

Guard/table asymmetry, stated on purpose: the guard is pooled, the table
per-stratum; a cell evicted pooled cannot win a stratum. Conservative by
design.

### R7. `ticket-features.tsv` columns (amends § 1)

`run_date session agent ticket policy_cell chosen_cell exploration_draw
sizing_src sizing_pre router_usd brief_chars criteria comments age_days
paths test_paths xrefs kind` (18). `agent_router` dropped (no member);
`sizing_src` ∈ `rule|haiku|jev:<model>` — the resolved model, so a silent
haiku fallback is visible in the data; `router_usd` from `status().cost`,
blank on A. `pr-cost.mjs`'s "incl. router $" sums `router_usd`.

### R8. Naming

One script, `plugin/scripts/ticket-router.mjs`, modes `route` / `fit` /
`--check`; `drawCell` and `CELL` come from `ledger-grammar.mjs`. One script
because the stratum rule is the one function that must never diverge
between dispatch and fit. Not `fleet-router.mjs` (the retired member's
name).

## 5. The repo-local hook (`#2089`)

Per `#2089`'s ruling (maintainer, 2026-09-27), fleet-plugin's own run
conventions — the metrics scrape, the chore/run-artifacts PR, and any
repo-local doc cites — leave the plugin and move into a repo-local skill,
`.omp/skills/run-team-local/SKILL.md`, called by `/fleet-ctl:run-team`
through a named hook at fixed phases. That file did not exist when this spec
was written (no `.omp/` directory at all on `main` then) — this map's
tickets (§ 8, T5) create it, since this repo dogfoods its own plugin. Its
duties, all drawn from this spec:

- **Phase 0:** drain `.fleet/ticket-features.pending.tsv` into
  `docs/metrics/ticket-features.tsv`; run `pr-cost.mjs --guard`, refreshing
  `.fleet/cost-guard.json`; print the role-target drift notice (§ 2).
- **Close-out:** drain the pending TSV again (a crashed run's rows are not
  lost); re-run `pr-cost.mjs --guard`; run the per-cell stopping rule (§ 2)
  and file a withdrawal issue on floor failure; run `ticket-router.mjs fit`
  every 50 merged PRs since `fitted_through` (§ 4 R5), opening a chore PR.

The plugin itself keeps only the repo-agnostic parts — the closing-issue
filter in `fleet-tick.mjs`, the router script, the instrument script, the
cell definitions, and the ledger grammar. Nothing in `plugin/skills/
run-team/SKILL.md` reads or writes a consumer repo's TSV directly; it
calls the hook.

## 6. Discrepancies found against current `main` (2026-09-28)

The hand-off comments this spec is built from cite line numbers and file
paths from earlier states of the tree. Re-verified against `main` at
spec-writing time; recorded here rather than silently reconciled, per this
map's own instruction:

- **`plugin/workflows/review-pr.js` no longer exists.** PR #2111 (ADR
  0014, point 4) deleted `plugin/workflows/` entirely. `#2037`'s booking
  section cites label-template changes at `review-pr.js:1750/:1870/:1043`
  — those coordinates resolve to nothing; the file is gone, not shifted.
  The actual label-template call sites today are in
  `plugin/scripts/review-core.mjs` (a bare `"snapshot"` label around line
  709, `` `review:${d.key}` `` around line 845, `` `verify:${d.key}` ``
  around line 937 — re-grep before editing, these drift too) — see § 3.
  Neither template currently carries a PR number, so `#2037`'s proposed
  `parseMemberName` regex (assuming a `review-pr-<n>`-style path segment)
  needs re-deriving against the actual colon-delimited label shape; left
  as an open design point for the implementing ticket (T3, § 8), not
  resolved here.
- **`plugin/scripts/member-record.mjs`'s token/cost fields are not at
  lines 425–427** as `#2037`'s resolution cites. On `main` today,
  `ompMemberRecord()`'s token/cost object (`tokens_in`, `tokens_cache_read`,
  `tokens_cache_write_1h` [new], `cost`, …) sits around line 413–415; the
  cited 425–427 is `readOmpMember()`, a two-line wrapper around it.
- **`plugin/scripts/tier-check.test.mjs` has no line 748.** The addendum
  to `#2036` pins the `--repo`-default case at `:748`; the file is 647
  lines total on `main` today. The actual test (`CLI: --repo defaults to
  the script's own plugin/ root …`, asserting
  `agentFile: "agents/fleet-implementer.agent.md"`) is currently around
  lines 573–584 — locate it by searching for that `agentFile` string, not
  by line number.
- **`plugin/scripts/tier-roles.test.mjs:74` is not a real-repo
  override/tier pin.** It is a `parseModelRoute` negative-test assertion
  (`parseModelRoute("@fast:high")` ⇒ null). The actual real-repo
  structural pin (`checkRoutes: every real plugin/agents definition routes
  cleanly …`) is currently around lines 258–261.
- **No vocabulary/glossary cross-reference exists in
  `plugin/skills/run-team/SKILL.md` near line 3304–3306** (or anywhere in
  that file) — `#2036`'s change-surface list cites this anchor; it does
  not resolve to anything on `main`. Dropped from § 8's change surface;
  no ticket touches it.
- **Every other cited `run-team/SKILL.md` line number has drifted by
  roughly 3–8 lines** (the file has grown since the hand-offs were
  written) but the content itself is present and matches the described
  paragraph in every case checked: the single dispatch line (cited
  837–838, now ≈831), the every-5th-Pull / alt-tier paragraph (cited
  967–972, now ≈960–967), the body-identity prose (cited 868–869/909–913,
  now ≈840–842/902–908, and is inside Phase 2, not Phase 0 as the citing
  hand-off implied), and the pair-gate paragraph (cited 1262–1271, now
  ≈1259–1268). Re-grep each before editing; do not trust the cited numbers.

## 7. Change surface

**2026-10-02:** the `#2116` items in T1, T2 and T5 below moved to `#2336`;
those tickets skip them.

Compiled from `#2035`, `#2036`, `#2037`, `#2038`, `#2116`'s hand-offs and corrected
against § 6. Grouped by the ticket (§ 8) that owns each file.

**T1 — cell grid, grammar, pins:**
- `plugin/scripts/ledger-grammar.mjs`: export `CELL`, `drawCell`.
- `plugin/agents/fleet-implementer-{slow-high,slow-medium,task-high,task-max,smol-high}.agent.md`: new, byte-identical bodies, each gaining the correction-discipline block that `#2116` moves from phase-2-only SKILL.md prose into every cell's shared body (settling commands, no unasked-for prose, no positional references, host-qualified cross-repo citations, no present-tense counts, inline re-settled commit/PR-body claims).
- `plugin/agents/fleet-implementer.agent.md`, `fleet-implementer-alt.agent.md`: deleted.
- `plugin/scripts/compute-spend.mjs`: `CELL_DEF` regex (currently line 111) replacing the two-name `fleet-implementer(-alt)?` test; comment above it (currently lines 98–102) rewritten from "closed at two by the alternate-tier pairing" to "closed to the `CELL` grammar".
- `plugin/scripts/tier-roles.mjs`: gains the "level ∈ `thinking.efforts`" validation per cell definition, alongside its existing route/role checks.
- `plugin/scripts/tier-roles.test.mjs`: route pins rewritten for five cells (real-repo structural pin currently ≈258–261).
- `plugin/scripts/tier-check.test.mjs`: the `--repo`-default case (currently ≈573–584, see § 6) rewritten to `agents/fleet-implementer-slow-high.agent.md`.
- `plugin/scripts/within-run-pair-prose.test.mjs`: rate assertion, body-identity assertion (across all five defs), and the `tier=alt`/rollover assertion (→ `tier=<cell>`) rewritten.
- `plugin/scripts/implementer-model-tier.test.mjs`: name⇒route derivation plus byte-identical-body assertion for every `fleet-implementer-*` file; drops the "class selects discipline, never a model" pin and the `class=routine`↔`sonnet` rebinding scans (`#2116`).
- `plugin/scripts/immutable-body-claim-prose.test.mjs`: the phase-0 claim-settling pin moves from `run-team/SKILL.md` prose to the shared agent body (`#2116`).

**T2 — router mechanism + dispatch cutover (blocked by T1):**
- `plugin/scripts/ticket-router.mjs`: new, `route`/`fit`/`--check` (§ 4 R1–R8).
- `plugin/scripts/router-table.json`: new, checked-in, `burn_in: true`, stage 1, one row `"*": "slow-high"`.
- `plugin/scripts/ledger.mjs`: writes `tier=<cell>` row token (was `tier=alt`).
- `docs/metrics/ticket-features.tsv`: new, 18-column header (§ 1/R7), written via `.fleet/ticket-features.pending.tsv`.
- `plugin/skills/run-team/SKILL.md`: dispatch line (≈831) calls `ticket-router.mjs route`, dispatches the returned `CELL`; every-5th-Pull paragraph (≈960–967) rewritten per ADR 0013 § 6 Amendment (already merged in this PR — SKILL.md prose must match it); body-identity prose (≈840–842/902–908) and pair-gate paragraph (≈1259–1268) rewritten for N cells; also deletes the `Class?` block (`:587–612`), the discipline clause (`:871–872`), "whatever the class" (`:903`), the tier-guard fired-state account and revert floor/trigger (`:1001–1019`, `:1273–1288`), and `class=unknown` recovery plus its three examples (`:1052–1068`), and collapses `:2525–2600` into one class-free rationale paragraph (`#2116`).
- `plugin/scripts/fleet-tick.test.mjs`: the ledger-row fixture carrying `tier=alt` (currently ≈385) → `tier=task-high`.
- `plugin/skills/run-team/references/correction-tickets.md`: drops the class-judgement line (`#2116`).
- `plugin/scripts/ci-completes-premise-prose.test.mjs`: drops the "repeat `class=`, `ports=` …" phrase from its golden (`#2116`).
- `plugin/scripts/dispatch-block-golden-prose.test.mjs`: golden gains the new correction-discipline block, loses the `Class?`-block assertion (`#2116`).
- `plugin/scripts/tier-guard-gate-prose.test.mjs`: drops the revert-floor/trigger pins (`#2116`).

**T3 — cost instrument (blocked by T1):**
- `plugin/scripts/member-record.mjs`: `tokens_cache_write_1h` field added to `ompMemberRecord()`'s token/cost object (currently ≈413–415, see § 6).
- `plugin/scripts/member-outcomes.mjs`: `COLUMNS` (currently ≈86–90) gains `tokens_in, tokens_cache_read, tokens_cache_write_1h, cost` after `subagent_type`; `rowsForSession()` reads them from `readOmpMember()`'s output.
- `docs/metrics/member-outcomes.tsv`: header gains the four columns; backfilled by one re-scrape (all 37 sessions still on disk).
- `docs/metrics/pricing.json`: new, cross-check reference table only.
- `plugin/scripts/pr-cost.mjs`: new — booking joins, quality floor, `--guard` exit contract, `.fleet/cost-guard.json`, A/B reasoning-test report.
- `plugin/scripts/review-core.mjs`: the three label-template sites (§ 6) gain `:pr${pr}`.
- `plugin/scripts/member-record.mjs`: `parseMemberName` gains a pattern for the new colon-delimited specialist label shape (see § 6 — exact regex is this ticket's own design decision).
- `plugin/scripts/fleet-tick.mjs`: new `router` row (§ 3), following the `HOLD` pattern.
- `plugin/scripts/fleet-tick.test.mjs`: new cases for the `router` row (OK/DEFAULT-ONLY/NO VERDICT).

**T4 — cell readout (blocked by T1, T2):**
- `plugin/scripts/cell-readout.mjs`: new — the per-cell gate query (§ 2), `mixed` marker.
- `docs/metrics/member-outcomes.tsv`: header comment (currently ≈67–99) — the pair-query awk one-liner replaced by the per-cell definition and a pointer to `cell-readout.mjs`.
- `plugin/scripts/member-outcomes-header.test.mjs`: the `pairQuery`/awk assertion (currently ≈100–140) rewritten to assert the pointer.

**T5 — repo-local hook (blocked by T2, T3, T4):**
- `.omp/skills/run-team-local/SKILL.md`: new (§ 5).
- `docs/metrics/tier-outcomes.tsv`: repo-local (per `#2089`, the append moves to this hook); re-judges the 6 `risky` rows (`#1053`, `#854`, `#1168` → `correction`; `#1056`, `#1181`, `#1160` → `routine`), adds the provenance and retirement notes to the header, and drops the tier-guard floor bullet — new rows carry an empty `class` (`#2116`).
- `plugin/scripts/tier-outcomes-header.test.mjs`: drops the tier-guard floor pin (`#2116`).

**Landed by this PR directly (not a `/to-tickets` ticket):**
- `docs/adr/0016-per-ticket-model-effort-routing.md` (this decision).
- `docs/adr/0013-automatic-supply-relabel-by-cause.md` § 6 amendment (append-only).
- `CONTEXT.md` § Tier / § Loop: **Cell**, **Router**, **Exploration Pull**,
  **Exploration draw**, **Admissible row**.
- This spec.

## 8. Tickets (input to `/to-tickets`)

`/to-tickets` is a personal maintainer tool that lives outside this repo
(confirmed: no `plugin/commands/to-tickets.md`, no
`plugin/skills/to-tickets/`, and `docs/specs/2026-07-30-fleet-trust-the-
label-design.md` states directly that `to-tickets` "point[s] at personal
skills that live outside this repo"). This spec documents the breakdown
below in the same shape the `2026-09-24` slot-based-loop spec's own § 9
used, and the tickets are filed to GitHub directly, matching that
breakdown, labelled `ready-for-agent` + `enhancement`, blockers first so
blocker tickets carry the lower issue numbers — replicating `/to-tickets`'
own documented output contract (oldest/blocker-first numbering,
`## Dependencies (blocking)` sections `candidates.mjs` parses) since the
external tool itself is not invokable from here.

Every slice below is additive except where noted; T1 is the only
non-additive slice (it deletes the two pre-cutover agent definitions and
rewrites their pins in the same change).

| # | Title | Blocked by | Delivers | Spec § |
|---|---|---|---|---|
| T1 | Cell grid: grammar, five `fleet-implementer-<cell>` definitions, and the tier-pin rewrite | — | `CELL`/`drawCell` exported; five cell definitions live, the two pre-cutover ones gone; every pin in the change surface green | 2, 7 |
| T2 | Router mechanism: `ticket-router.mjs`, `router-table.json`, and the SKILL.md/ledger dispatch cutover | T1 | `route`/`fit`/`--check` per R1–R8; `/run-team` phase 2 dispatches the router's chosen cell; ledger carries `tier=<cell>` | 4, 7 |
| T3 | Cost instrument: `pr-cost.mjs`, priced `member-outcomes.tsv` columns, specialist booking, and the `fleet-tick.mjs` guard row | T1 | `pr-cost.mjs --guard` exit contract; `.fleet/cost-guard.json`; review-fan-out rows booked to a PR; `router` tick row | 3, 7 |
| T4 | Cell readout: `cell-readout.mjs`, the per-cell gate, and the `member-outcomes.tsv` header rewrite | T1, T2 | `cell-readout.mjs` prints the gate line per cell; `mixed` marker on role-target drift | 2, 7 |
| T5 | Repo-local hook: TSV drain, stopping rule, drift notice, and router re-fit cadence | T2, T3, T4 | `.omp/skills/run-team-local/SKILL.md` runs every duty in § 5 at phase 0 and close-out | 5, 7 |

**Not filed here:** `#2127` ("Jev sizing backtest") is already filed as a
research child of map #2030, blocked on this spec landing — it needs the
backtest harness path this spec names, which is `docs/research/
sizing-backtest-<model>.tsv` written by `ticket-router.mjs`'s classifier
gate (§ 4 R2). No duplicate ticket is filed.

**Not yet specified (for the map):**
- Who re-verifies `router-table.json --check` in CI alongside
  `tier-roles.mjs --check` — a CI-workflow change, not named by any G1–G4
  section; left for T2's implementer to wire once the script exists.
- Whether `cell-readout.mjs`'s close-out output should render in the
  cockpit (`board.mjs`) — out of scope for this map, same treatment as
  ADR 0013's own `excluded ·` row question.
