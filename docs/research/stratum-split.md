# How the light/heavy split divides this repository's Pulls (map #4118)

Measured 2026-11-01 at `origin/main` `e5040b9a`, for the ticket "Does a consumer's light/heavy split come from its own tickets?" (feigi/fleet-plugin#4123). The ruling built on this note was later withdrawn on the maintainer's word: the Router's inputs and how it groups tickets were reopened.

The figures come from the Router's own modules: `fitTable`, `ruleStratum`, `route` and `rowDispatch` in `plugin/scripts/ticket-router.mjs`, and `attribute`, `tally` and `generations` in `plugin/scripts/pull-attribution.mjs`. The guard is `pr-cost.mjs --json --guard` from that day, kept as `stratum-split-guard.json`.

Reproduce: `node docs/research/stratum-split-derive.mjs <checkout of e5040b9a>`.

## How the Pulls split

- **268 Pulls**, all with `sizing_src=rule`, an `exploration_draw` and no blank metric.
- **`brief_chars`**: p50 is 3,844 and p90 is 7,218. **`criteria`**: p50 is 4 and p90 is 9.
  - 56.3% of Pulls are past 3,483 characters, and 35.1% are past 5 criteria.
- **Under `ruleStratum`**: 184 heavy (68.7%), 84 light (31.3%), none unknown.
- **Slices**: all 30 rows with a `parent` are heavy. By length and criteria alone, 20 of them would be light.

## Per stratum and Cell (newest generation)

| Stratum | Cell | Pulls (all merged) | Failed | $ per merged PR | Minutes per merged PR |
|---|---|---|---|---|---|
| heavy | `slow-high` | 73 | 17 | 16.75 | 127.95 |
| heavy | `task-high` | 74 | 24 | 12.21 | 111.66 |
| heavy | `smol-high` | 20 | 12 | 12.18 | 114.65 |
| light | `slow-high` | 31 | 3 | 9.21 | 105.75 |
| light | `task-high` | 30 | 4 | 5.52 | 81.23 |
| light | `smol-high` | 12 | 6 | 9.19 | 103.02 |

- **Light against heavy**, $ per merged PR: 0.55 on `slow-high`, 0.45 on `task-high` and 0.75 on `smol-high`.
- **`task-high` against `slow-high`**: 0.600 on light, 0.728 on heavy and 0.709 on `*`.
- **Every row routes to `task-high`**, under both Objectives, in `*`, light and heavy. No stratum row differs from `*`.

## Sensitivity: this repository's own median as the threshold

With 3,844 as the threshold instead of 3,483, the split is 176 heavy and 92 light. `task-high` costs $5.77 per merged PR on light and $12.37 on heavy.

## When the stratum routes

- **During burn-in**, the draw picks the Cell. The row's Cell is recorded only as `policy_cell`.
- **After burn-in**, every Pull that does not explore takes its stratum's row, and a stratum without a row follows `*`.
- The derive script demonstrates both with `route` on synthetic issues.
