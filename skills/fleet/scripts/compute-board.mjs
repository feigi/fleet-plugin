// Pure board-model builder. No I/O and no clock read — `now` is passed in, so
// dwell/staleness is deterministic and unit-testable. board.mjs does the gh/
// ledger I/O and calls computeBoard(); every stage-derivation and flag decision
// lives here and is exercised by compute-board.test.mjs (`node --test`).

// A ledger row is freeform, controller-authored text. Two real examples:
//   #332 impl-332 → PR#344 → MERGED 73b356de
//   #324 impl-324 → PR#346 · review-pr-346-b · ruled:6-applies · held-behind:#313
// Extract by token regex, never by position — the controller reorders and
// appends tokens freely. Unknown text is ignored, never fatal.
export function parseRow(row) {
  const issueM = row.match(/^#(\d+)\b/);
  if (!issueM) return null;
  const first = (re) => (row.match(re) || [null])[0];
  const prM = row.match(/\bPR\s*#(\d+)\b/);
  const mergedM = row.match(/\bMERGED\s+([0-9a-f]{7,40})\b/i);
  const heldM = row.match(/\bheld-behind[:\s]+#?(\d+)\b/i);
  const causes = [];
  for (const t of ["KILLED", "BLOCKED", "SHA-OFF-BRANCH"]) {
    if (new RegExp(`\\b${t}\\b`).test(row)) causes.push(t.toLowerCase());
  }
  return {
    issue: Number(issueM[1]),
    impl: first(/\bimpl-\d+[a-z-]*\b/),
    reviewer: first(/\breview-pr-\d+[a-z-]*\b/),
    pr: prM ? Number(prM[1]) : null,
    merged: !!mergedM,
    sha: mergedM ? mergedM[1] : null,
    heldBehind: heldM ? Number(heldM[1]) : null,
    causes,
  };
}

// A parsed row is IMPLEMENTING or later. MERGED is durable (ledger-only); READY
// needs the live PR label; a PR with no ready-to-merge label is in REVIEW.
export function deriveColumn(parsed, prState) {
  if (parsed.merged) return "MERGED";
  if (parsed.pr && prState && prState.labels.includes("ready-to-merge")) return "READY";
  if (parsed.pr) return "REVIEW";
  return "IMPLEMENTING";
}

// Dwell thresholds per column, ms. A ticket sitting longer than this in a
// non-terminal column earns `stale`. POOL and MERGED are absent → never stale.
export const STALE_MS = {
  IMPLEMENTING: 20 * 60 * 1000,
  REVIEW: 45 * 60 * 1000,
  READY: 15 * 60 * 1000,
};

export function deriveFlags(parsed, ctx) {
  const flags = [];
  if (ctx.ci === "red") flags.push("red-ci");
  if (parsed.heldBehind != null) flags.push(`held-behind:#${parsed.heldBehind}`);
  for (const c of parsed.causes) flags.push(c); // killed | blocked | sha-off-branch
  const limit = STALE_MS[ctx.column];
  if (limit != null && ctx.sinceEnteredStage != null && ctx.now - ctx.sinceEnteredStage > limit) {
    flags.push("stale");
  }
  return flags;
}
