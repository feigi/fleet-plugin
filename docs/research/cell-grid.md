# The Cell grid: which role × effort Cells can exist, and what makes one routable (issue #4120)

Map #4118. Facts only: no ruling, no recommendation.

Measured at `origin/main` `e5040b9a` (2026-11-01), omp 18.14.2, on one operator machine. Every figure below
reproduces with `node docs/research/cell-grid-derive.mjs` run in a checkout (section A and the catalog half of B
read the live omp and so describe *this* machine; C and the `pricing.json` half of B need only the committed files;
`--no-omp` skips the live reads). Anything not measured is marked `[INFERENCE]`.

## 1. Catalog and `modelRoles` on this machine

How they are read: `tier-roles.mjs:172` `readOmpConfigValue(key)` runs `omp config get <key> --json` and returns the
record's `.value`; `:180` `readOmpModelCatalog()` runs `omp models --json` and returns `{ models: [{ selector,
thinking, … }] }` (`readOmpJson` `:191`; a non-JSON or non-object reply is refused naming the command). The
role→model step is `resolveRole` (`:116`: follows an `@other-role` alias chain, up to 8 hops, then
`stripLevel` drops a trailing `:<level>` — `:107`), and `catalogEntry` (`:214`) finds the model's catalog entry
by exact `selector`, else by provider-less equality.

| role | `modelRoles` entry | resolved model | catalog `thinking` |
|---|---|---|---|
| `slow` | `anthropic/claude-opus-5-5:high` | `anthropic/claude-opus-5-5` | low, medium, high, xhigh, max |
| `task` | `anthropic/claude-sonnet-5-5:high` | `anthropic/claude-sonnet-5-5` | low, medium, high, xhigh, max |
| `smol` | `anthropic/claude-haiku-5-5:auto` | `anthropic/claude-haiku-5-5` | low, medium, high, xhigh, max |

(Also set on this machine, never used by a Cell: `advisor` and `plan` → `claude-fable-5-1`, `web` → haiku-5-5,
`default` → `claude-sonnet-5-5:medium`. `tier-roles.mjs:72` `ROLE_ORDER = ["slow","task","smol"]` is the only role
list the Router ever names.)

* `modelRoles.smol`'s own `:auto` suffix is **not** a catalog level (the catalog lists no `auto`). It does not
  matter to a Cell: the referring definition's explicit `:<level>` wins over the role's baked suffix, and
  `resolveRole` strips the suffix before the catalog lookup (`tier-roles.mjs:5-8` header, `:107-125`).
* `minimal` is in the `CELL` grammar (`ledger-grammar.mjs:812`) but is in **no** current role model's catalog
  list. The catalog lists `minimal` only for the 4.x models (`claude-haiku-4-5`, `claude-opus-4-5`,
  `claude-sonnet-4-5`: minimal, low, medium, high, xhigh) and not for any 5.x model.
* Unsupported level: omp **clamps it silently** (`tier-roles.mjs:22-26`). The run then resolves at a level the
  definition never declared, `tier-check` reads that level and compares it exactly
  (`tier-check.mjs:162-165`), so every row the definition ran would be inadmissible
  (`pull-attribution.mjs:190-193` `admissibleRow` needs `row.effort === level`). This is why
  `checkRoutes` (`tier-roles.mjs:250`, clamp test `:312-322`) refuses a definition whose level is not in the role
  target's catalog list.
* `omp models --json` also carries a `cost` per model (§ 4), `contextWindow` (opus-5-5 / sonnet-5-5: 1,000,000;
  haiku-5-5: 100,000; haiku-4-5: 200,000) and `pricingStatus: fixed`.
* `node plugin/scripts/tier-roles.mjs --check --in-flight 3` on this machine: exit 0, "every definition routes to a
  resolvable model at a level it runs, no shadowing override".

**Contradicts the ticket's "What is known":** "`claude-haiku-4-5` has no `max`" is true of `claude-haiku-4-5`
(ladder minimal…xhigh), but this machine's `smol` is `claude-haiku-5-5`, whose catalog **does** list `max`.
The `smol-high` rows in `member-outcomes.tsv` show the switch: `claude-haiku-4-5` 2026-10-12..10-17, then
`claude-haiku-5-5` from 2026-10-17 (§ 5, C2). On the current install no level from `low` to `max` is clamped for
any of the three roles; only `minimal` is. The clamp is a property of the operator's `modelRoles`, not of the
role name. `tier-roles.test.mjs:366-367` pins the clamp with a fixture catalog (`NO_TASK_MAX`) and not with the
live one.

## 2. Definitions

Five files, `plugin/agents/fleet-implementer-<cell>.agent.md`, each with the same 5-line frontmatter and a
byte-identical body (15.8K each; the `description` says so and a test pins it):

| file | `model:` (the whole binding) |
|---|---|
| `fleet-implementer-slow-high` | `"@slow:high"` |
| `fleet-implementer-slow-medium` | `"@slow:medium"` |
| `fleet-implementer-task-high` | `"@task:high"` |
| `fleet-implementer-task-max` | `"@task:max"` |
| `fleet-implementer-smol-high` | `"@smol:high"` |

The binding is the `model:` line alone (`frontmatter-allowlist.json:25`: `^@(slow|task|smol):(minimal|low|medium|high|xhigh|max)$`;
name `^fleet-[^:]*$` at `:29`). omp resolves `@<role>` through `modelRoles` natively, so there is no generator and
no record to write (`tier-roles.mjs:1-8`). The Cell is derived from the file name
(`implementerCell`, `tier-roles.mjs:136`; `CELL_DEF`, `ledger-grammar.mjs:813`).

## 3. What a new Cell needs to be routable

A Cell is `<role>-<level>`. The list below is every place the code or a test names the set. "New level on an
existing role" and "new role" are separated where they differ.

1. **The definition file** `plugin/agents/fleet-implementer-<cell>.agent.md` with `model: "@<role>:<level>"` and
   the shared body. Pins: `tests/tier-roles.test.mjs:349-355` (the implementer definitions are *exactly* the five
   cells), `tests/frontmatter-check.test.mjs:450` (hard-coded list of five files), `tests/label-map-member-prose.test.mjs:126`
   (five names), `tests/compute-spend.test.mjs:420`, `tests/member-write-guard.test.mjs:89` (`OTHER_CELLS`).
2. **The `CELL` grammar**, `ledger-grammar.mjs:812` `^(slow|task|smol)-(minimal|low|medium|high|xhigh|max)$`.
   A new *level* on an existing role is already inside it; a new *role* needs this regex edited, and so do the
   hard-coded copies of the role/level alternation: `tier-roles.mjs:74` (`MODEL_ROUTE_RE`) and `:72`
   (`ROLE_ORDER`), `frontmatter-allowlist.json:25`. `CELL_DEF` (`:813`) is derived from `CELL`, so it follows.
   Users of `CELL`: `ticket-router.mjs:54,155` (table validation), `pull-attribution.mjs:86,179,192`,
   `compute-board.mjs:425-426`, `compute-cell-evidence.mjs:268,353,508`, `ledger.mjs:774,3159` (`tier=<cell>`
   grammar), `ledger-grammar.mjs:892-902` (routing tokens), `compute-spend.mjs:129`, `member-write-guard.mjs:111`.
   `tests/ledger-grammar.test.mjs:400,413` pin the grammar and `GRID`.
3. **The router table's `cells`**, `plugin/scripts/router-table.json:6-10`: today `slow-high`, `task-high`,
   `smol-high` (stage 1). `validateTable` (`ticket-router.mjs:150-157`) requires each entry to satisfy `CELL` and be
   unique. `slow-medium` and `task-max` are **not** in the shipped table: they enter `cells` only through `STAGE2`.
   `rowDispatch` draws over `table.cells` less the tripped (`:213-226`); `route` explores over it (`:330-338`).
4. **`STAGE2`**, `ticket-router.mjs:78`: `[{ cell: "slow-medium", survives: "slow-high" }, { cell: "task-max", survives: "task-high" }]`,
   read once at `:606-608`. The fit appends `cell` to `cells` when `cells` has `survives`, `survives` is not
   tripped, and the fit is at stage 1 with every stage-1 Cell at n ≥ 20 and (some `*` row adopted a non-`slow-high`
   Cell or some Cell is tripped) (`:603-605`). A Cell absent from `STAGE2` and `router-table.json` is never
   added to `cells` by the fit. `[INFERENCE]` there is no stage 3: `stage` is set to 2 once and the list is the
   only expansion path in `fitTable`. Pins: `tests/ticket-router.test.mjs` (20 lines mention `slow-medium`, 13
   `task-max`).
5. **`burn_in`**, `ticket-router.mjs:618`: `burn_in = !cells.every(guard.n[c] >= 20)`. Appending a Cell to `cells`
   makes `burn_in` true again until that Cell has n ≥ 20 (the fit at e5040b9a is the live example: stage 2 and
   `burn_in: true`). This is a code fact; the consequence for any one repo's run is not measured here.
6. **The guard** (`pr-cost.mjs`): `STAGE_1` (`:101`) is only the retire test (`:227`); the guard's own per-Cell
   figures are generic over whatever Cells the PRs ran (`:166-220`), and `BASELINE_CELL` is `slow-high` (`:99`).
   `parseGuard` (`ticket-router.mjs:242-255`) accepts any `CELL`-shaped name in `tripped` and any `cells[].cell`.
   A Cell trips only when it and `slow-high` both have ≥ 20 merged PRs (`pr-cost.mjs:218-220`). Figures are per Cell
   generation (one model); a role whose `modelRoles` changes starts a new generation for each of its Cells
   (`pull-attribution.mjs`; the smol-high rows above are two generations).
7. **tier-roles check** (`tier-roles.mjs`, run by `phase0.mjs:304`): (a) well-formed route (`:74`); (b) role has
   `modelRoles.<role>` (`:296-301`); (d) the level is in the role target's catalog list (`:312-322`). For a Cell
   *not* routable — `routableCells(table)` (`:147-155`) = `POLICY_CELL` ∪ `table.cells` ∪ every row-set value — a
   level mismatch is a **notice**; for a routable Cell it is a **violation** that stops the run. So adding a Cell
   to `cells` (or to a row) is what promotes an unsupported level from notice to refusal. (e) `slow` and `task`
   resolving to one model is a notice (`:346-349`). Pins: `tests/tier-roles.test.mjs:354,366-387,421-433,555-612`
   (task-max fixtures), `tests/tier-check.test.mjs:704-738`.
8. **tier-check** (`tier-check.mjs`, run after each Pull's dispatch): declared = the definition's `model:` route,
   expected model = `expectedOmpModel` through `modelRoles`; `compare` (`:162-165`) is exact on level and by role
   target on model. It needs nothing per Cell beyond the definition file and the ledger entry's `agent=`.
9. **frontmatter-check** (`frontmatter-check.mjs` with `frontmatter-allowlist.json`): the shape of the new file
   only (`frontmatter-allowlist.json:24-31`); no list of Cells. `tests/frontmatter-check.test.mjs:450` lists the five by name.
10. **Cockpit / cell evidence**: `compute-cell-evidence.mjs:39` `CELLS = ["slow-high","task-high","smol-high","slow-medium","task-max"]`
    fixes which Cells have a page and their order (`drawOrder` `:353`, used `:378,386`; `compute-board.mjs:390`
    builds the `#cells/<cell>` href). A Cell outside `CELLS` still appears if the guard holds it or a Pull targeted
    it (`:353`). Pins: `tests/cockpit-tabs.test.mjs:555` (asserts the five `cell-*` ids in order),
    `:62,637-728`; `tests/compute-cell-evidence.test.mjs` (17 `slow-medium`, 20 `task-max`);
    `tests/compute-board-cell-line.test.mjs`, `tests/board-cell-evidence-gather.test.mjs`,
    `tests/cell-evidence-alerts.test.mjs`.
11. **cell-readout** (`cell-readout.mjs`): generic over `CELL`/`POLICY_CELL` (`:88,152,165,208,300`); no Cell is
    named. Pins: `tests/cell-readout.test.mjs` (5 `slow-medium`, 2 `task-max`).
12. **Pricing**: not required. `docs/metrics/pricing.json` is "Cross-check reference only" (its own `_about`);
    `pr-cost.mjs` uses it only for `cross_check`, and `claude-haiku-5-5` (today's smol model) is absent from it while
    that Cell is routed.
13. **Docs** that enumerate the five: `docs/components/implementer.md:7`, `docs/adr/0016-per-ticket-model-effort-routing.md:88`,
    `docs/specs/2026-09-28-model-effort-router-design.md:163-182,337,619`, `plugin/skills/run-team/references/ledger.md:72,77`
    (examples).
14. **Tests that pin Cell names**, by file (`grep -c` of `slow-medium`/`task-max`): `ticket-router` 20/13,
    `compute-cell-evidence` 17/20, `tier-roles` 1/20, `cockpit-tabs` 6/8, `cell-readout` 5/2, `tier-check` 4/0,
    `ledger-grammar` 3/4, `compute-board-cell-line` 2/0, `pull` 0/3, `compute-spend` 1/1,
    `frontmatter-check` 1/1, `member-write-guard` 1/1, `label-map-member-prose` 1/1.

Not needed: no list of Cells in the dispatch step. `expectedDefinition` (`ledger-grammar.mjs:984-990`) maps a row's
`tier=`/`cell=` to `fleet-implementer-<suffix>` for any `[a-z0-9]` words joined by `-` (`TIER_SUFFIX`, `:958`), and
writing a row's `tier=` is checked against `CELL` (`ledger.mjs:3159`), so a definition file plus the `CELL` match
is enough there.

## 4. Price

`docs/metrics/pricing.json` (USD per million tokens; "cross-check reference only") and the live catalog `cost`:

| model (role) | in | out | cache read | cache write | source |
|---|---|---|---|---|---|
| `claude-opus-5-5` (slow) | 4 | 20 | 0.2 | 8 (1h) / 5 (catalog) | pricing.json / catalog |
| `claude-sonnet-5-5` (task) | 2 | 10 | 0.2 (pricing.json) / 0.1 (catalog) | 4 (1h) / 2.5 (catalog) | both |
| `claude-haiku-5-5` (smol) | 0.1 | 0.5 | 0.01 | 0.125 | **catalog only** (absent from pricing.json) |
| `claude-haiku-4-5` (smol before 2026-10-17) | 1 | 5 | 0.1 | 2 (1h) / 1.25 | pricing.json, catalog |
| `claude-opus-5`, `claude-sonnet-5` | 5 / 2 | 25 / 10 | 0.5 / 0.2 | — | pricing.json |

Price order of the three roles' models, cheapest first: **smol (haiku-5-5) < task (sonnet-5-5) < slow (opus-5-5)**,
on output $/Mtok 0.5 < 10 < 20 (ratios: slow:task 2×, task:smol 20×, slow:smol 40×). Within a role the per-token
price does not depend on the level; effort moves the tokens (§ 5), not the rate. The two sources disagree on
sonnet-5-5 `cache_read` (0.2 vs 0.1) and on opus-5-5's cache-write tier (pricing.json has the 1h tier only;
the catalog carries one figure). `longContext` pricing exists for haiku-5-5 above 100k input tokens
(input 0.5, output 2.5).

Measured $ per implementer Pull at `high`, post-cutover (C2; `cost` is $ of record per row, a Pull sums its
retries; Pulls = distinct session/impl-N):

| Cell | model | n Pulls | run_date span | tokens_out mean | $ per Pull (mean) |
|---|---|---|---|---|---|
| slow-high | opus-5-5 | 320 | 2026-10-04..10-31 | 37,989 | 3.48 |
| task-high | sonnet-5-5 | 182 | 2026-10-03..10-31 | 35,338 | 1.52 |
| smol-high | haiku-5-5 | 33 | 2026-10-17..10-26 | 102,677 | 0.18 |
| smol-high | haiku-4-5 | 27 | 2026-10-12..10-17 | 35,184 | 1.63 |
| smol-high | ollama | 1 | 2026-10-20 | 0 | 0.00 |

(These are Pulls, not merged PRs; the Router's per-merged-PR figures divide by merged and differ — e.g. the
slow-high guard figure $14.51 per merged PR at the same window is a different denominator.) haiku-5-5 emits
about 2.9× the tokens_out of the other two at one-twentieth the output price.

## 5. What effort does, measured (pre-cutover `high` vs `xhigh`)

Source: `docs/metrics/member-outcomes.tsv`, rows with `subagent_type` `fleet-implementer` or
`fleet-implementer-alt`, role `implementer`, member `impl-N[-x]` (`ledger-grammar.mjs` `parseMember`, family `impl`;
`fix-pr-*`, `Refute*`, finishers and named strays excluded). One Pull = one session's `impl-N` with its retry
attempts summed. `dispatch_model` equals `model` on every omp row of these groups. Cells are mean/median.

**omp harness (has `dispatch_model`, `cost`, `turns`):**

| model | subagent_type | effort | n Pulls | run_date span | tokens_out | turns | wall_s | cost USD |
|---|---|---|---|---|---|---|---|---|
| opus-5-5 | fleet-implementer | high | 149 | 2026-09-26..10-03 | 32,066 / 22,536 | 52.3 / 41 | 1,795 / 1,256 | 2.56 / 1.63 |
| opus-5-5 | fleet-implementer | xhigh | 69 | 2026-09-25..09-27 | 45,682 / 40,467 | 65.4 / 62 | 1,373 / 1,293 | 3.52 / 2.79 |
| opus-5 | fleet-implementer | xhigh | 128 | 2026-09-12..09-23 | 58,014 / 55,063 | 68.7 / 63 | 1,748 / 1,592 | 7.37 / 6.15 |
| sonnet-5 | fleet-implementer-alt | high | 8 | 2026-09-27..09-29 | 33,192 / 41,942 | 50.8 / 61 | 2,753 / 1,524 | 1.59 / 2.12 |
| sonnet-5 | fleet-implementer-alt | xhigh | 47 | 2026-09-11..09-27 | 46,716 / 43,369 | 63.0 / 61 | 1,298 / 1,154 | 2.42 / 1.88 |
| sonnet-5 | fleet-implementer | xhigh | 14 | 2026-09-11 | 42,103 / 42,595 | 59.6 / 55 | 1,457 / 1,358 | 2.08 / 1.82 |

(`claude-opus-5` has no `high` Pull on omp: its 2 `high` rows are members `BraveCentipede` and `SmokeTest`, neither an `impl-N` Pull.)

**The one comparable pair, opus-5-5** — xhigh minus high, Router's `bootstrapDiffCI` (2000 resamples, seed 1) over
per-Pull units (mean per Pull; every unit counts as merged:1):

| scope | n high / xhigh | tokens_out | turns | wall_s | cost USD |
|---|---|---|---|---|---|
| all dates | 149 / 69 | [5,795, 20,928] | [4.4, 21.5] | [−797, −121] | [0.29, 1.57] |
| shared dates 2026-09-26..27 | 51 / 59 | [9,549, 23,907] | [8.8, 27.9] | [248, 583] | [0.77, 2.05] |

Shared-date means: high 29,207 tokens_out, 47.8 turns, 984 s, $2.14; xhigh 45,700 tokens_out, 66.2 turns,
1,398 s, $3.54. So on the same model xhigh emitted ~1.4–1.6× the output tokens and ~1.4× the turns, and cost
~$0.8–2.1 more per Pull (shared-date 95% range). Wall time **flips sign** between the two scopes: over all dates
`high` is slower (mean 1,795 s vs 1,373 s, median 1,256 vs 1,293) because the `high` cohort runs to 2026-10-03 and
carries a long tail; on the two shared dates `xhigh` is slower (+248..+583 s). The wall figure is therefore not
stable across eras and should not be read as an effort effect.

**sonnet-5** has only 8 `high` Pulls (3 on the shared date 2026-09-27); its xhigh−high ranges straddle zero on
every measure (all dates: tokens_out [−2,952, 27,770], cost [−0.05, 1.54]; shared dates tokens_out [−17,225,
35,496], cost [−0.80, 1.63]). **opus-5** has no omp `high` comparison.

**claude harness (pre-2026-09-10; tokens_out, turns, wall_s only; no `cost`, `dispatch_model` or `tokens_in`):**
`opus-5` `fleet-implementer` high n=75 (2026-08-28..09-08, tokens_out 8,886 / 7,213, turns 48.1 / 41, wall 1,591 /
1,266); `sonnet-5` `fleet-implementer-alt` high n=9 (09-08) vs xhigh n=23 (08-28..09-03), tokens_out 9,443 vs 6,010,
turns 44.3 vs 52.8, wall 1,973 vs 2,071; the xhigh−high ranges are wide and straddle zero, and the two efforts
share no date. Another unlabeled-`subagent_type` population (opus-5 xhigh 178 rows to 2026-08-27, opus-5 high 22,
sonnet-5 xhigh 66, high 9) is outside the named subagent types and not summarised. `tokens_out` on the claude
harness is a different measure from omp's (several times below omp's per-Pull figure for the same model class: 8,886 here for opus-5 against 32,066–58,014 on omp for opus-5/opus-5-5), so the
two harnesses must not be pooled `[INFERENCE: reading of the scale difference; the derivation of the claude
harness's tokens_out is not examined here]`.

**Era confound.** `high` and `xhigh` were not assigned at random. Within a model they sit in different periods
(opus-5-5: xhigh 09-25..09-27, high 09-26..10-03 with 98 of the 149 `high` Pulls after 09-27), on different
ticket mixes (no ticket-level covariate was used; `ticket-features.tsv`'s earliest `run_date` is 2026-10-11, so it does not cover these Pulls), under different controller versions (`fleet-implementer` vs `-alt` definitions), and
and `[INFERENCE]` with prompts and brief templates also changing between the periods (not diffed here). The shared-date control
narrows the window to two days and 51 vs 59 Pulls; it does not remove ticket-mix differences. Treat the
xhigh−high figures as an association, not an effect of effort alone.

**Post-cutover rows on `slow-medium` or `task-max`: none.** `member-outcomes.tsv` has 0 rows with
`subagent_type` `fleet-implementer-slow-medium` or `fleet-implementer-task-max` (C2, last two lines of the
derive output). No Cell other than `slow-high`, `task-high` and `smol-high` has ever run.

## 6. Orderings

Effort ladder per model, from the catalog's `thinking` array order (the order is the catalog's; the catalog is the
only ordering source — `tier-roles.mjs` never ranks levels):

| model | ladder (low → high) |
|---|---|
| `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-mythos-5(-1)`, `claude-fable-5` | low, medium, high, xhigh, max |
| `claude-haiku-4-5`, `claude-opus-4-5`, `claude-sonnet-4-5` | minimal, low, medium, high, xhigh |
| `claude-opus-4-6` | low, medium, high, max |
| `claude-sonnet-4-6` | low, medium, high |

The `CELL` grammar's own order (`minimal, low, medium, high, xhigh, max`) is a regex alternation, not a rank.
Role ladder by price (§ 4), cheapest first: **smol < task < slow**.

**Grid on this machine** (R = the role's model lists the level, C = omp would clamp it):

| role (model) | minimal | low | medium | high | xhigh | max |
|---|---|---|---|---|---|---|
| smol (haiku-5-5) | C | R | R | **R** (exists) | R | R |
| task (sonnet-5-5) | C | R | R | **R** (exists) | R | **R** (exists) |
| slow (opus-5-5) | C | R | **R** (exists) | **R** (exists, policy) | R | R |

Neighbours of each existing Cell: *level ±1* = the next entry on the role's own catalog ladder; *role ±1 at the
same level* = the adjacent role in the price order. "[clamped]" marks a neighbour the catalog cannot run;
"none" marks the end of a ladder.

| Cell | level up | level down | dearer role, same level | cheaper role, same level |
|---|---|---|---|---|
| slow-high (policy) | slow-xhigh | slow-medium | none | task-high |
| task-high | task-xhigh | task-medium | slow-high | smol-high |
| smol-high | smol-xhigh | smol-medium | task-high | none |
| slow-medium | slow-high | slow-low | none | task-medium |
| task-max | none | task-xhigh | slow-max | smol-max |

No neighbour here is `[clamped]`: with the install above every neighbour of the five Cells is runnable
(`minimal` is never a neighbour of a 5.x ladder, since the 5.x ladders start at `low`). Cells that would be clamped
on this machine: any `*-minimal`. On the previous smol model (`claude-haiku-4-5`, ladder minimal…xhigh) `smol-max`
would have been clamped and `smol-minimal` runnable; that is what the ticket's note refers to.
The neighbour table depends on `modelRoles` and the catalog at the time of the read: the same Cell names have
different neighbours if the operator repoints a role (e.g. `slow` → `claude-opus-4-6` has no `xhigh`: `slow-xhigh`
would be clamped and the "up" neighbour of `slow-high` would be `slow-max`).

## 7. Reproducing

```
node docs/research/cell-grid-derive.mjs            # needs omp on PATH for A and the catalog half of B
node docs/research/cell-grid-derive.mjs --no-omp   # B (pricing.json) and C, C2 only
```

Modules imported from the checkout: `tier-roles.mjs` (`readOmpConfigValue`, `readOmpModelCatalog`, `resolveRole`,
`catalogEntry`, `stripLevel`), `member-outcomes.mjs` (`parseTsv`), `ledger-grammar.mjs` (`CELL`, `POLICY_CELL`,
`parseMember`), `pull-attribution.mjs` (`bootstrapDiffCI`). Compute: ~4 s; the bootstrap uses the module's defaults
(2000 resamples, seed 1), so the ranges are exactly reproducible but are 2.5/97.5th percentiles of 2000 draws, not
a precision claim beyond that.
