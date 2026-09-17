# 0002 — Filing gains a second bar: *is the finding worth a claim*

**Status:** Accepted. Ruled 2026-08-31, on the measurement below.

## Context

ADR 0001 repriced the filing-time **label** — `is the defect confirmed` — and
shelved four volume throttles behind a pre-chosen guard (floor: 20 post-reprice
deferrals across ≥3 run dates; trigger: `needs-triage` still taking more than
half). That guard never fired, because it watched the seat the load left.
Routing genuinely moved: on 2026-08-31 `needs-triage` held 5 of 214 open
issues. The load moved to the other two seats — `ready-for-agent` (194 open,
125 issues citing `Deferred from PR`) and the maintainer's close ledger.

Measured 2026-08-15→31, all as-of figures. Universe: the 400 most recently
created closed **issues** — `gh issue list --state closed --limit 400`, no PRs
— of which 58 closed before 2026-08-15 and fall outside the window:

- 342 closes in the window, 218 `wontfix` (64%).
- 85 of the 218 were records filed **closed** by design — 37
  `PR #N review: the suggestion band, checked` plus 48 legacy
  `REFUTED:`/`Record:` — zero triage cost, working as intended.
- The remaining **133 were real triage closes: 121 review deferrals, 86 of
  which had sat open more than three days.** The other 12 are not review
  deferrals — bugs, aggregates, and one legacy review record — and are not
  the shape described below.

The 121 share a shape. The finding's own claim was that *correct code could be
shaped better* — style, naming, layout, redundancy, a micro-simplification —
and triage closed each under the repriced bar's own logic: a ticket whose only
open item is "is this worth doing?" answers itself. The review path files a
question the triage path already knows the answer to, one open issue at a time.

That is a different defect from 0001's. 0001 fixed *which label* a filed issue
carries. Nothing yet asks whether an own open issue should exist at all.

## Decision

Filing keeps 0001's bar for the label and gains a second, earlier bar for the
issue's existence: **is the finding worth a claim.**

- **The bar reads the finding's claim, never its review band.** A finding
  whose own claim is that correct code could be shaped better — style, naming,
  layout, redundancy, a micro-simplification — is below the bar: its only open
  question answers itself, so it never gets its own open issue.
- **Below the bar → the per-review closed record issue**, under a
  `Below the claim bar` heading: `file:line`, dimension, the claim, and a
  re-open trigger per entry. `ledger.mjs check` reads `--state all`, so a
  future run re-deriving the finding lands on the record instead of re-filing.
- **Promotion path:** a later review returning the same finding as
  `survived`, or a maintainer hitting the defect, files it open then, citing
  the record.
- **Anything alleging wrong behavior files open**, under 0001's confirmed/torn
  split, whatever band it sat in — `unverified` with crashed refuters
  included.

## This is not the shelved severity floor

0001's option 1 (file `important` and above) stays shelved, and #591 is why:
the `unverified` band conflates policy-skipped suggestions with findings whose
refuters crashed, so any rule keyed on bands silently drops `critical`
findings nobody looked at. This bar is keyed on the finding's *claim* — a
crashed-refuter `critical` alleges wrong behavior, sits above the bar, and
files open exactly as before. #591 blocks band-keyed floors; it does not gate
this.

## The guard — chosen before any data, tier-guard precedent

Input: `Below the claim bar` entries recorded after this decision lands on
`main`. Both directions are pre-chosen; a guard retuned later is not a guard.

- **Floor:** 20 below-bar entries across at least 3 distinct run dates.
- **Trigger A — bar too wide:** 5 or more of those entries promoted (a later
  `survived` finding or a maintainer hit). The bar is burying real work;
  retune or revert. **Promotion signal — two marks, both on the record
  issue:** an open issue citing the record, and a
  `Promoted — applied, not filed` comment on it, which `review-and-fix.md`
  step 5 requires where a later review re-derives the entry in scope, its
  refuter lets it through, and the run applies the fix instead of filing it.
  That second path files nothing, so without the comment this trigger would
  count only promotions that happened to need a ticket of their own and would
  miss the entry re-derived, checked and worth fixing — the strongest
  evidence there is that the bar buried real work. Count both marks off each
  record's own timeline — `gh api repos/{owner}/{repo}/issues/<n>/timeline
  --paginate` — and record the date taken with the verdict, as 0001's guard
  does.
- **Trigger B — bar missed the load:** non-record `wontfix` closes still above
  half of all closes over the same window. The clause is not where the volume
  is; 0001's shelved options come back off the shelf.

When either fires, the verdict lands on `main` — a guard verdict that lives
only in an unmerged PR re-fires every run.

## Consequences

- Triage stops re-answering "is this worth doing?" one open ticket at a time;
  that answer is given once, at filing, where the finding is already in hand.
- The record issue carries entries nobody checked, alongside refutations that
  were. The heading is the boundary; an entry under it asserts nothing about
  the code, only that the question answered itself.
- A worth-it call the maintainer might have answered *yes* is deferred until
  rediscovery or a direct hit. That is the trade this decision buys, priced
  against 121 review-deferral closes in sixteen days.
- Dedup, labels, phase 0, and 0001's guard are all unchanged.
