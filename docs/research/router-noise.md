# Per-Pull noise, and how many Pulls a Cell comparison needs (map #4118)

Measured 2026-11-01 at `origin/main` `e5040b9a`. These are the power figures quoted on "Which ticket inputs change which Cell wins?" (feigi/fleet-plugin#4150) and in the map's grilling.

The Pulls are the Fit's own: `attribute` filtered as in `ticket-router.mjs:382-385`, with per-Cell newest-generation figures from `tally`.

Reproduce: `node docs/research/router-noise-derive.mjs <checkout of e5040b9a>`.

## Noise per Pull

| Cell | Model | Pulls | Failed | $ per Pull: mean (sd), CV | Minutes per Pull: mean (sd), CV |
|---|---|---|---|---|---|
| `slow-high` | `claude-opus-5-5` | 104 | 20 | 14.51 (10.06), 0.69 | 121.33 (66.86), 0.55 |
| `task-high` | `claude-sonnet-5-5` | 104 | 28 | 10.28 (6.16), 0.60 | 102.88 (46.52), 0.45 |
| `smol-high` | `claude-haiku-5-5` | 32 | 18 | 11.06 (7.04), 0.64 | 110.29 (51.80), 0.47 |

The mean coefficient of variation is 0.64 for $ and 0.49 for minutes.

## Pulls per Cell to see a difference

The test is 80% power, two-sided 5%.

| Difference to detect | $ | Minutes |
|---|---|---|
| 50% | 26 | 16 |
| 30% | 73 | 43 |
| 20% | 163 | 95 |

For a fail rate against 19%:

| Fail rate | Pulls per Cell |
|---|---|
| 29% | 286 |
| 34% | 135 |
| 39% | 80 |

- For $ and minutes, n = 2·(1.96 + 0.8416)²·CV²/δ², the two-sample normal approximation with equal CVs.
- For fail rates, the standard two-proportion formula.
- `router-inputs.md` and `self-refining-routing.md` recompute these with their own baselines and get 74, 165 and 287.
