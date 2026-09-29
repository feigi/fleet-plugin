# fleet-ctl components

One page per fleet-ctl component: what it's for, how it works, and the
opinionated design choices behind it. Grounded in the current code and
runbooks — see [`../../README.md`](../../README.md) for the end-to-end flow
diagram and [`../../CONTEXT.md`](../../CONTEXT.md) for the shared vocabulary
these pages use.

## The loop

- [Controller](controller.md) — the `run-team` orchestrator; the slot-based
  loop that ties every role below together.
- [Supply & Shortlist](supply-and-shortlist.md) — scanning `ready-for-agent`
  issues into the ordered admission list.
- [Pull & Claim](pull-and-claim.md) — admitting one ticket into one free
  implementer slot: judge, then claim, relabel, or exclude.

## The roles

- [Implementer](implementer.md) — builds one claimed ticket into a pushed
  branch and an open PR.
- [Tier routing](tier-routing.md) — which model tier an implementer runs
  at, and how that's verified.
- [Reviewer](reviewer.md) — the review fan-out: snapshot, specialists,
  verifier, fix-applier.
- [Finisher](finisher.md) — the last gate before `ready-to-merge`: audit,
  confirm, label.
- [Merge bot](merge-bot.md) — one Pass over the `ready-to-merge` queue:
  hold rule, rebase, gate, merge.

## Shared building blocks

- [CI State](ci-state.md) — the one script every gate asks whether a PR's
  CI is genuinely green.
- [Recipe](recipe.md) — deriving a consumer repo's install step and test
  entrypoint by reasoning, not a lookup table.
- [Reaping & Liveness](reaping-and-liveness.md) — cleaning up claims after
  they end, and the heartbeat that keeps a drained queue from stalling
  silently.
- [Isolation](isolation.md) — worktrees, scratch partitions, and the write
  guard that keep members from colliding.
- [Ledger & Cockpit](ledger-and-cockpit.md) — the durable run-state record
  under `.fleet/`, and the read-only UI built over it.
- [Instruments](instruments.md) — detecting a silent change to the scripts
  and runbooks a gate decision depends on.
- [Install & Resolver](install-and-resolver.md) — how an edit to this repo
  reaches a running fleet at all.
- [Correction tickets](correction-tickets.md) — how a reviewer's finding
  becomes (or doesn't become) a new tracked ticket.

## Standalone (outside the fleet loop)

- [next-ticket](next-ticket.md) — pick, size, and claim one ticket for a
  human-present session.
- [sizing-a-ticket](sizing-a-ticket.md) — deciding how much process a
  ticket needs before implementing it.
