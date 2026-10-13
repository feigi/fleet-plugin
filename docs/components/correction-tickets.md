# Correction tickets

## What it is for

How a reviewer's finding that can't be fixed in scope right now becomes
a new tracked ticket — and the filing bars that decide whether it
becomes one at all.

## How it works
1. **File.** [`review-and-fix.md`](../../plugin/commands/review-and-fix.md)
   step 5 files ordinary deferrals through `ledger.mjs check "<subject>"`
   (never a bare search) then `ledger.mjs filed <N> "<subject>"`.
2. **The label — always `needs-triage`.** Every issue the plugin files
   is `needs-triage`, a confirmed defect included, since confirming a
   defect does not settle its remedy; only triage sets `ready-for-agent`
   ([ADR 0032](../adr/0032-every-issue-files-needs-triage.md)).
3. **The bar — is the finding worth a claim?** A finding whose own claim
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

- **A label rule and a claim bar, kept apart.** Confirming a defect exists
  does not settle how it should be fixed, so a confirmed defect files
  `needs-triage` like every other issue — the label never turns on
  confirmation. Whether a finding earns its own issue at all is the
  separate worth-a-claim bar; collapsing the two was measured routing
  confirmed findings into the fleet's pool with their remedy still open.
- **The claim bar and the label rule each carry a pre-chosen, pre-data
  guard** (a floor of filings across multiple run dates, a trigger ratio
  or count) rather than a discretionary retune, so a guard that never
  fires is evidence the rule is right, not evidence nobody's watching.
