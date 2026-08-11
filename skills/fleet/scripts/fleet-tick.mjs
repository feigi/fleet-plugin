#!/usr/bin/env node
// The reconcile tick. run-team's Phase 3 is an event loop, and implementer
// refill was wired as an EDGE — "a member finished → refill its slot". That
// edge dies the moment live implementers reach 0, because 0 implementers emit
// no completion event, and "free capacity + a non-empty pool" is a LEVEL
// condition an edge-triggered loop cannot observe once it stops changing. #3:
// implementers sat at 0/target with pool 1 and ~57 `ready-for-agent` in supply
// until a human asked why nothing was being implemented. No error, no warning.
//
// So compute the deficit instead of remembering it. One invocation prints
// actual/target and an explicit ACTION per role, with run-team's queue-depth
// guards applied in code rather than recalled from its table. You cannot forget
// what a script prints at you.
//
// WHERE THE NUMBERS COME FROM — the contract, and the one thing #3 left open:
//
//   args   Live member counts and the pool. The ledger records a DISPATCH
//          (`impl-332`), never a liveness: that token outlives the member's
//          death, its bail and the merge, and no field distinguishes them. A
//          liveness derived from it is a guess whose BOTH error directions are
//          the failures this script exists to prevent — over-count HOLDs, which
//          is the #3 stall itself, and under-count DISPATCHes past the cap. The
//          controller dispatched the members and receives their reports, so it
//          is the only component that knows; it states them. Required, never
//          defaulted, for the same reason: a default silently converts a
//          forgotten flag into one of those two failures.
//   gh     Review backlog and merge queue, from open PRs by label.
//   script Supply, from candidates.mjs.
//
// The pure half below is `reconcile()`; main() does the I/O. Split so the guard
// table is unit-testable without a network — fleet-tick.test.mjs.

// Every role's TARGET is its configured cap. Availability of work belongs in
// the ACTION, not the target: a reviewer target that shrank to the backlog
// would print `0/0 → idle` and read as "correctly sized" for the exact drained
// state that is the defect.
export function reconcile(s) {
  return [implementers(s), reviewers(s), mergeBot(s)];
}

function implementers(s) {
  const deficit = s.implCap - s.implLive;
  const detail = `pool=${s.pool} supply=${s.supply} review-backlog=${s.reviewBacklog}`;
  const row = (action, extra = "") => ({
    role: "implementers", actual: s.implLive, target: s.implCap,
    action, detail: extra ? `${detail} — ${extra}` : detail,
  });

  if (deficit <= 0) return row("AT CAP");

  // The refill gate is the REVIEW backlog and never the merge-queue depth:
  // more PRs into a review-bound pipeline buys nothing, while a deep
  // ready-to-merge queue adds no rebases per PR and is not a reason to idle an
  // implementer. Checked before the pool table, and short-circuiting it: a
  // re-shortlist exists to enable a dispatch that is being held, and a /triage
  // suggestion under a hold is noise the controller would act on.
  if (s.reviewBacklog >= 2) return row("HOLD", "a review-bound pipeline gains nothing from more PRs");

  if (s.pool >= 1) return row(`DISPATCH ${Math.min(deficit, s.pool)}`);

  // Pool 0. Supply is open `ready-for-agent`, so it is an UPPER bound — the
  // decided? check and the in-flight scan both run downstream of it and only
  // ever remove tickets. An over-count therefore lands on `RE-SHORTLIST`
  // rather than `SUGGEST /triage`, and re-shortlisting is exactly what
  // discovers that the surplus was undecided. The safe direction.
  if (s.supply >= s.implCap) return row("RE-SHORTLIST", "ask the maintainer to tick");
  if (s.supply > 0) return row("RE-SHORTLIST + SUGGEST /triage");
  return row("SUGGEST /triage", "no supply — hold implementer slots idle");
}

function reviewers(s) {
  const deficit = s.reviewerCap - s.reviewerLive;
  const row = (action) => ({
    role: "reviewers", actual: s.reviewerLive, target: s.reviewerCap,
    action, detail: `review-backlog=${s.reviewBacklog}`,
  });
  if (deficit <= 0) return row("AT CAP");
  if (s.reviewBacklog === 0) return row("IDLE OK");
  return row(`DISPATCH ${Math.min(deficit, s.reviewBacklog)}`);
}

function mergeBot(s) {
  // Cap is 1 by invariant, not by configuration.
  const row = (action) => ({
    role: "merge-bot", actual: s.mergeBotLive, target: 1,
    action, detail: `merge-queue=${s.mergeQueue}`,
  });
  if (s.mergeBotLive >= 1) return row("AT CAP");
  if (s.mergeQueue === 0) return row("IDLE OK");
  return row("DISPATCH merge-bot");
}

export function formatLines(rows) {
  const w = Math.max(...rows.map((r) => r.role.length));
  return rows.map((r) => `${r.role.padEnd(w)} ${r.actual}/${r.target} → ${r.action}   (${r.detail})`);
}
