# 0016 — Per-ticket model+effort routing: go on the mechanism, hold on the table

**Status:** Accepted. Ruled 2026-09-28 (map #2030, decided across #2035–#2038).

## Context

Map #2030 chartered four grilling children to decide whether routing each
`fleet-implementer` Pull to a model+thinking-level **cell** from pre-dispatch
ticket metrics pays for itself, and if so, to design the mechanism:
`#2035` (Inputs — which metrics, how derived, what they cost),
`#2036` (Exploration — the cell grid, the draw, eligibility, records),
`#2037` (Instrument — the $-per-merged-PR formula, the quality floor, the
reasoning-pays-for-itself test), and `#2038` (Router — the algorithm and
the go/no-go call itself, against this ADR's own criterion: the readout's
effect size plus the instrument's guard).

The readout that grounds this decision is `#2031` ("Readout of the
within-run tier pairs"), `docs/research/tier-readout.md` on branch
`research/tier-readout`, refreshed for this map (n grew to 21 pairs / 12
dates from 17/8): **$ is the only high-power metric.** Effect size d≈1.35
means n≈9 per arm suffices to read the $ difference; the binary quality
floor (base fail rate ≈45%) needs 93 PRs/arm for a 20-point delta, 170 for
15, 389 for 10 — unresolvable inside a quarter at this project's measured
throughput (≈60 verdicts/active week against 35 `ready-for-agent` tickets
open today). Pooled, opus wins; effort-matched at n=10, sonnet wins — the
quality *sign* is not expected to resolve at any n this map can reach.

`#1111` (ruled 2026-09-27, recorded in `docs/adr/0014-omp-is-the-only-harness.md`'s
own brief) requires that any guard verdict this map produces have a **code
carrier** — no threshold may live in prose alone, because a hedge added as
its own sentence passes a presence pin and an absence pin was measured
failing (#476, #529).

Mid-map, the default cell itself moved: PR #2059 (merged 2026-09-27) changed
`fleet-implementer`'s declared tier from opus/**xhigh** to opus/**high**
("high should be enough for an implementer" — maintainer ruling during this
map's own charting, full account on #2034/#2036). Every cell-grid and
baseline-cell reference below reflects opus/**high**, not opus/xhigh.

`#2037`'s first-drafted trip rule — evict a cell on a bare point estimate,
`fail_rate > baseline` — was measured in-session to evict a cell with
p=0.44 at **equal** true fail rates (n=20/20; 0.46 at 60/60): no margin, no
real signal. `#2038` amended it before this ADR shipped (see Guard, below).

## Decision — go on the mechanism, hold on the table

1. **Build exploration (#2036), the instrument (#2037), and a constant-table
   router (#2038).** The router's only routing rule on day one is
   `slow-high` for every ticket; the table is data-fitted offline from
   `ticket-features.tsv` × outcomes on a 50-merged-PR cadence and changes
   only through a reviewed PR whose diff is the table and its estimates.
2. **Routing granularity is a `light|heavy|unknown` stratum** from a
   swappable classifier — a free-text rule on day one, `judge()` on haiku
   or Jev behind the same file contract once one passes its backtest — never
   a parametric ticket→cell model: at the reachable n a table diff is
   reviewable, coefficients are not.
3. **The objective is $ per merged PR; quality is a floor, not a fitted
   quantity.** The readout's $ effect (opus ≈3–4× sonnet per ticket, stable
   in every slice, d≈1.35) bounds the upside; its quality sign is
   unresolved (pooled opus wins, effort-matched sonnet wins at n=10) and
   stays unresolved at any n reachable in a quarter. The instrument's guard
   (below) is what keeps a cheaper cell honest, not the fit.
4. **Burn-in makes a fitted table reachable in weeks, not a quarter.** While
   `router-table.json.burn_in` is true, every Pull draws uniformly over the
   stage-1 cells (`slow-high`, `task-high`, `smol-high` — the model axis at
   fixed `high`) instead of the every-5th-Pull draw. Burn-in ends only when
   every stage-1 cell has pooled n≥20 in `cost-guard.json`; stage 2 (adding
   `slow-medium`, `task-max`) opens once every stage-1 cell has n≥20 and
   either a `*` adoption or an eviction has occurred. At ≈60 verdicts/week
   this reaches n=20/cell in ≈1 week, n=60 in ≈3 — first adoption in ≈3
   weeks, against 6.7 weeks under the pre-router 1-in-5 draw alone.
5. **Arm B is not run on day one.** `#2037`'s reasoning-pays-for-itself test
   (deterministic metrics vs. `+ fleet-router`-style reasoned sizing) needs a
   classifier that has already beaten the incumbent B classifier on the
   `#2035` offline backtest **and** a router table with at least one
   non-default row — with one row, no classifier can change the outcome. The
   backtest is filed as `#2127` ("Jev sizing backtest"), a research child of
   this map, blocked on this ADR's spec landing (it needs the backtest
   harness path the spec names). Until `#2127` passes and a stratum has
   adopted a cell, the record reads: *B not run — the table has no row a
   better classifier could change.*

## Guard — chosen before any further data

- **Carrier:** `pr-cost.mjs --guard` exit contract — `0` ok, `3` ≥1 cell
  tripped, `4` no verdict (baseline n<20), `2` input error — consumed by
  `fleet-tick.mjs`'s `router` row. The verdict never lives in prose alone
  (`#1111`).
- **Baseline:** `slow-high`, strictly, cumulative from a `WINDOW_START`
  constant in `pr-cost.mjs`. Never rolling; reset only by editing the
  constant in a PR.
- **Trip rule** (amends `#2037`'s first draft): per cell, n≥20 each side,
  `fail_rate − baseline ≥ 15 pts` **∨** `mean_usd ≥ baseline`. At n=20 the
  15-point margin is exactly a 3-of-20 count difference; the `fail_rate`
  disjunct alone brings false eviction at equal true fail rates from 0.44
  down to ≈0.21 (exact binomial for the stated `≥`; ≈0.13 if read as
  strict `>`). The `mean_usd` disjunct is a second, independent trigger
  that raises the combined false-eviction rate above whichever of those
  two figures applies.
  Still point estimates — a bootstrap 95% CI on the $ difference is printed
  beside the verdict for reading, never for judging. Sticky by construction:
  a tripped cell gets no new rows and cannot be adopted by a later fit; the
  route script substitutes `slow-high` for a tripped table row without
  waiting for a re-fit.
- **Guard/table asymmetry, on purpose:** the guard is pooled, the router
  table is per-stratum — a cell evicted pooled cannot win a stratum.
  Conservative by design.
- **Retire condition:** if every non-default cell of stage 1 trips before
  any stratum adopts one, the exploration draw is removed and the table
  stays one row — **the router retires without a new ADR.** Downside during
  burn-in is bounded to the burn-in Pulls themselves, with review + finisher
  as the net (map standing decision 3); after burn-in, to the exploration
  share (≤1 in 5).
- **Missing or unparseable `cost-guard.json` ⇒ default cell only.** The
  guard cannot be evaded by deleting it.

## Rejected alternatives

- **A fitted parametric ticket→cell model.** Rejected per `#2038`'s R1: at
  the n this map can reach, a table diff is reviewable in a PR; regression
  coefficients are not. No parametric model, ever.
- **Running arm B (reasoned sizing) from day one.** Rejected: the table has
  no row a better classifier could change until a non-default row exists,
  so B has nothing to prove against on day one.
- **Keeping the old alt-tier binary pairing** (every 5th Pull → sonnet vs.
  opus, `tier=alt`). Superseded by the exploration draw over N cells
  (`#2036`) — a two-point comparison cannot separate a model effect from an
  effort effect, which is exactly the confound `#2031`'s readout measured.
- **The bare point-estimate trip rule** (`fail_rate > baseline`, no margin).
  Rejected in-session: p=0.44 false-eviction rate at equal true fail rates
  is not a guard, it is a coin flip with extra steps. Replaced by the
  15-point margin above.
- **A dedicated `fleet-router` member.** Retired. Sizing (arm B, once
  gated) is one `judge()` call in the controller's own eval cell —
  measured ≈175× cheaper ($0.0002 vs. ~$0.035) at the same resolved model,
  with no member transcript, no ledger row, and no network access from the
  route script itself.

## Consequences

- `docs/specs/2026-09-28-model-effort-router-design.md` carries the full
  design — G1–G4 sections, the change surface, and the ticket breakdown
  handed to `/to-tickets`.
- `docs/adr/0013-automatic-supply-relabel-by-cause.md` § 6 (the alt-tier
  mechanism) is amended, append-only: the every-5th-Pull draw is now the
  Exploration draw over the cell grid, not the retired alt-tier binary
  pairing.
- `CONTEXT.md` § Tier and § Loop gain **Cell**, **Router**, **Exploration
  Pull**, **Exploration draw**, and **Admissible row**.
- `docs/metrics/ticket-features.tsv`, `docs/metrics/pricing.json`, and
  `.fleet/cost-guard.json` are new records this map's tickets create; none
  existed before this ADR.
- The router is designed to retire itself cleanly (see Guard, above) — a
  stage-1 sweep that trips every non-default cell needs no follow-up ADR to
  fall back to today's single-cell behavior.
