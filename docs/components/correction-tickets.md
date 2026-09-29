# Correction tickets

## What it is for

How a reviewer's finding that can't be fixed in scope right now becomes
a new tracked ticket — and the filing bars that decide whether it
becomes one at all.

## How it works

[`plugin/skills/run-team/references/correction-tickets.md`](../../plugin/skills/run-team/references/correction-tickets.md)
governs `class=correction` tickets, whose actual claimed subject is
*correcting a wrong claim the fleet itself shipped* — a misattributed
package, an inverted polarity list, a stale banner, a commit body citing
the wrong line — never a reviewer's ordinary deferral. Ordinary
deferrals are filed by
[`review-and-fix.md`](../../plugin/commands/review-and-fix.md) step 5,
through `ledger.mjs check "<subject>"` (never a bare search, so an
existing record is found rather than duplicated) then `ledger.mjs filed
<N> "<subject>"`. Two bars decide the label a filed finding gets: **is
the defect confirmed** — a confirmed defect with an open remedy files as
`ready-for-agent` even if *how* to fix it is still open, because
divergence between two implementers on the remedy costs one PR review
the maintainer already runs, while an unconfirmed one files
`needs-triage`
([ADR 0001](../adr/0001-filing-label-bar-is-defect-confirmed.md)); and
**is the finding worth a claim** — a finding whose own claim is that
correct code could merely be shaped better (style, naming, a
micro-simplification) never gets its own open issue at all, landing
instead as an entry under a `Below the claim bar` heading on the
review's own closed record issue, promoted to a real ticket only if a
later review re-derives it as `survived` or a maintainer hits it
directly ([ADR 0002](../adr/0002-filing-second-bar-worth-a-claim.md)). A
`class=correction` ticket routes through implementation with extra rigor
for the same failure mode (new wrong claims), never a lower-capability
dispatch — the guard fired 2026-08-16 once every class began dispatching
at the session's one tier.

## Opinionated choices

Two separate bars at filing time, not one: confirming a defect exists
and judging whether it's worth its own ticket are different questions,
and collapsing them (as the original single-bar design did) was
measured routing real, confirmed-but-easy findings into a `needs-triage`
queue no fleet member could ever consume. Both bars carry a pre-chosen,
pre-data guard (a floor of filings across multiple run dates, a trigger
ratio) rather than a discretionary retune, so a guard that never fires
is evidence the bar is right, not evidence nobody's watching.
