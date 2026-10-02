# Correction tickets

## What it is for

How a reviewer's finding that can't be fixed in scope right now becomes
a new tracked ticket — and the filing bars that decide whether it
becomes one at all.

## How it works
1. **File.** [`review-and-fix.md`](../../plugin/commands/review-and-fix.md)
   step 5 files ordinary deferrals through `ledger.mjs check "<subject>"`
   (never a bare search) then `ledger.mjs filed <N> "<subject>"`.
2. **Bar one — is the defect confirmed?** A confirmed defect with an
   open remedy files `ready-for-agent` even if *how* to fix it is still
   open (divergence there costs one PR review the maintainer already
   runs); an unconfirmed one files `needs-triage`
   ([ADR 0001](../adr/0001-filing-label-bar-is-defect-confirmed.md)).
3. **Bar two — is the finding worth a claim?** A finding whose own claim
   is that correct code could merely be shaped better never gets its
   own issue — it lands under a `Below the claim bar` heading on the
   review's closed record issue, promoted only if a later review
   re-derives it as `survived` or a maintainer hits it directly
   ([ADR 0002](../adr/0002-filing-second-bar-worth-a-claim.md)).
4. **No separate route at implementation.** A ticket whose actual subject is
   *correcting a wrong claim the fleet itself shipped* dispatches like any
   other: every implementer agent body carries the claim discipline built for
   that failure mode (see
   [`plugin/skills/run-team/references/correction-tickets.md`](../../plugin/skills/run-team/references/correction-tickets.md)).

## Opinionated choices

- **Two separate bars at filing time, not one.** Confirming a defect
  exists and judging whether it's worth its own ticket are different
  questions; collapsing them was measured routing real, confirmed-but-
  easy findings into a `needs-triage` queue no fleet member could ever
  consume.
- **Both bars carry a pre-chosen, pre-data guard** (a floor of filings
  across multiple run dates, a trigger ratio) rather than a
  discretionary retune, so a guard that never fires is evidence the bar
  is right, not evidence nobody's watching.
