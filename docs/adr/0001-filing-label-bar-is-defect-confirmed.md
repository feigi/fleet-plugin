# 0001 — The filing-time label bar is *is the defect confirmed*

**Status:** Accepted. Ruled 2026-08-18 on #239; the filing-step half landed in
`6d0c1f6`, which is in `origin/main`'s history.

## Context

`review-and-fix.md` step 2 defers a review finding rather than dropping it, and
step 5 files each deferral as its own issue. #239 opened as a volume question —
most open issues are review deferrals, so should filing be throttled? — and
proposed four throttles: a severity floor, one batched issue per review, filing
only dimension-attributable findings, or accepting the rate.

All four price the wrong thing. A throttle files fewer issues at the same
ratio, and the ratio is where the damage is. Deferrals were landing in
`needs-triage`, which no fleet member can consume — the fleet has no triage
role (#592) — rather than in `ready-for-agent`, which is what
`candidates.mjs --require-label` and the cockpit's pool query read. Volume is
the symptom; routing is the disease.

The routing came from one instruction. Step 5 told the filer to pick the label
using the **decided?** test defined in `run-team/SKILL.md`'s phase 0. That test
asks whether two competent implementers reading only the ticket would build
materially different things, and its inventory marks architecture, API shape,
schema, UX, a new dependency and a new seam as undecided. A review finding
characteristically has a confirmed defect and an open remedy, so a filer
applying the test honestly answered "undecided" nearly every time. The test was
working correctly, in the wrong seat.

The #239 ruling records the movement that produced: `needs-triage` at 11
pending when step 5's cost sentence was written and at 135 when the ruling was
made. Those are the ruling's own figures as of 2026-08-18; this record does not
re-derive them.

## Decision

Two seats, two bars, each correct where it stands.

- **Filing time** — `review-and-fix.md` step 5. The bar is **is the defect
  confirmed**. A confirmed defect whose remedy is still open files as
  `ready-for-agent`, with the openness named in the body. Divergence between
  two implementers costs one PR review, which the maintainer already runs. The
  bar is stated inline, and step 5 no longer points at phase 0's criterion —
  that pointer is what made the two seats collide.
- **Consumption time** — `run-team/SKILL.md` phase 0, **decided?**. The bar
  stays **is the approach decided**, and the test is behaviorally unchanged.
  Divergence here costs a claim, a worktree and a dispatch.

`torn → needs-triage` is retained at filing time, narrowed: under the new bar
torn means the filer is unsure anything is broken, not unsure how to fix it.
Filing an unconfirmed defect as `ready-for-agent` is the live-bait failure #238
documents. Narrowing the bar shrinks how often the tie-break fires; it does not
reverse it.

Step 5's cost sentence was repriced rather than deleted. The trade-off it names
is still the right one — a misfiled `needs-triage` costs a triage pass, a
misfiled `ready-for-agent` costs a claim and a demote — and the prices, not the
reasoning, are what changed.

## Shelved, not rejected

The four options are shelved behind the guard below, not ruled wrong. If
routing does not move, volume becomes the live lever again:

1. A severity floor — file `important` and above, record the rest on the PR.
2. One issue per review, carrying all of that review's deferrals.
3. File only dimension-attributable findings.
4. Accept the rate.

If the guard fires, #591 lands first: a severity floor applied to the
`unverified` band would silently drop `critical` findings nobody looked at,
because that band holds both policy-skipped suggestions and findings whose
refuters crashed.

## The guard — floor and trigger, chosen before any data

Following the phase-2 tier guard's precedent, both are fixed now and fire on
the accumulated record across runs, never on the run in front of you.

- **Floor:** 20 deferrals filed across at least 3 distinct run dates after this
  decision lands.
- **Trigger:** `needs-triage` still taking more than half of them.

The guard's input is deferrals filed *after* `6d0c1f6` — the filing-step half
dated in the Status line, because that is what moved filer behaviour, not this
record's own merge. The standing backlog is not that input — it is mostly
pre-reprice filings, whose reconciliation is #593.

Baseline for that comparison, measured against the tracker on 2026-08-23 — an
as-of figure, never a live count, because the tracker is append-only and any
count quoted here rots on the next filing. Of 235 open issues, 168 cited
`Deferred from PR`, and those carried `needs-triage` 107, `ready-for-agent` 60,
`ready-for-human` 1.

When the guard fires, its verdict lands on `main`. A guard verdict that lives
only in an unmerged PR re-fires every run.

## Relationship to #211

This decision **complements #211 and does not supersede it.** #211 governs what
gets **applied**; this governs what gets **labelled** when a finding is filed.

The two are routinely conflated, and #211's own title invites it — it claims to
"replace the apply/defer/file policy behind 83% of open issues", which reads as
though the filing rate was in scope. It was not. What #211 shipped into step 2
is a scope split plus one refuter for in-scope suggestions: in-scope suggestions
are applied if they survive, out-of-scope ones still defer, and `unverified` is
untouched and always defers. Step 5's one-issue-per-deferral filing was left
exactly as it stood. #211's design record is
`docs/specs/2026-08-06-review-pr-cost-and-apply-policy-design.md`.

## Consequences

- A confirmed defect with an open remedy is agent-grabbable, and its open
  remedy is named in the body rather than encoded in the label.
- The maintainer's `needs-triage` queue stops absorbing the review path's
  output by default. It still receives every finding whose filer is unsure
  anything is broken.
- Divergence between two implementers on a remedy-open ticket is now caught at
  PR review rather than prevented at filing. That is the trade this decision
  buys, and the cost it accepts.
- Phase 0 is unchanged, so nothing about which tickets the fleet is willing to
  start has moved.
