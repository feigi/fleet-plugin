// Pure board-model builder. No I/O and no clock read — `now` is passed in, so
// dwell/staleness is deterministic and unit-testable. board.mjs does the gh/
// ledger I/O and calls computeBoard(); every stage-derivation and flag decision
// lives here and is exercised by compute-board.test.mjs (`node --test`).

// A ledger row is freeform, controller-authored text. Two real examples:
//   #332 impl-332 → PR#344 → MERGED 73b356de
//   #324 impl-324 → PR#346 · fix-pr-346 · ruled:6-applies · held-behind:#313
// Extract by token regex, never by position — the controller reorders and
// appends tokens freely. Unknown text is ignored, never fatal.
//
// The per-PR member is `fix-pr-<n>` on the default review path and
// `review-pr-<n>` on the hand-dispatch fallback, so `reviewer` must match both.
// Matching only the older name left every default-path row with reviewer null,
// which shows the implementer on the card and counts the PR as review backlog
// forever.
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
    reviewer: first(/\b(?:review|fix)-pr-\d+[a-z-]*\b/),
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

// Internal helpers — not exported; covered through computeBoard's tests.

// Carry the stage-entry timestamp forward while the column is unchanged, else
// reset to now. This is what makes dwell self-contained in board.json, needing
// no ledger timestamps and no controller involvement.
function stageEntry(prevTicket, column, now) {
  if (prevTicket && prevTicket.column === column && prevTicket.sinceEnteredStage != null) {
    return prevTicket.sinceEnteredStage;
  }
  return now;
}

function titleFor(issue, pr, issues) {
  if (pr && pr.title) return pr.title;
  const i = issues.find((x) => x.number === issue);
  return i ? i.title : `#${issue}`;
}

const FLAG_SEVERITY = { "red-ci": 5, killed: 4, blocked: 4, "sha-off-branch": 4, stale: 1 };
function severity(flags) {
  let s = 0;
  for (const f of flags) {
    if (f.startsWith("held-behind")) s = Math.max(s, 2);
    else s = Math.max(s, FLAG_SEVERITY[f] ?? 0);
  }
  return s;
}

function splitNumbered(line) {
  const m = line.match(/^#(\d+)\s+(.*)$/);
  return m ? { issue: Number(m[1]), subject: m[2] } : { issue: null, subject: line };
}

export function computeBoard(inputs) {
  const { ledger, issues, prs, ci, prev, now } = inputs;
  const prByNum = new Map(prs.map((p) => [p.number, p]));
  const prevByIssue = new Map((prev?.tickets || []).map((t) => [t.issue, t]));
  const ruledByPr = new Map();
  for (const r of ledger.ruled || []) {
    const s = splitNumbered(r);
    if (s.issue != null) ruledByPr.set(s.issue, s.subject);
  }

  const parsed = (ledger.rows || []).map(parseRow).filter(Boolean);
  const rowIssues = new Set(parsed.map((p) => p.issue));
  const tickets = [];

  for (const p of parsed) {
    const pr = p.pr != null ? prByNum.get(p.pr) : undefined;
    const prState = p.pr == null ? null
      : pr ? { open: pr.state === "OPEN", labels: pr.labels || [] }
           : { open: false, labels: [] };
    const column = deriveColumn(p, prState);
    const sinceEnteredStage = stageEntry(prevByIssue.get(p.issue), column, now);
    const ciState = p.pr != null ? (ci[p.pr] ?? "unknown") : null;
    const flags = deriveFlags(p, { ci: ciState, column, sinceEnteredStage, now });
    const inReview = column === "REVIEW" || column === "READY";
    tickets.push({
      issue: p.issue,
      title: titleFor(p.issue, pr, issues),
      column,
      agent: inReview ? (p.reviewer || p.impl) : p.impl,
      pr: p.pr,
      ci: ciState,
      sinceEnteredStage,
      flags,
      ruling: p.pr != null ? (ruledByPr.get(p.pr) ?? null) : null,
    });
  }

  for (const iss of issues) {
    if (rowIssues.has(iss.number)) continue;
    const sinceEnteredStage = stageEntry(prevByIssue.get(iss.number), "POOL", now);
    tickets.push({
      issue: iss.number, title: iss.title, column: "POOL", agent: null,
      pr: null, ci: null, sinceEnteredStage, flags: [], ruling: null,
    });
  }

  const attention = tickets.filter((t) => t.flags.length)
    .sort((a, b) => severity(b.flags) - severity(a.flags));

  const parsedByIssue = new Map(parsed.map((p) => [p.issue, p]));
  const reviewBacklog = tickets.filter(
    (t) => t.column === "REVIEW" && !parsedByIssue.get(t.issue)?.reviewer,
  ).length;
  const pool = tickets.filter((t) => t.column === "POOL").length;

  return {
    generatedAt: now,
    interval: inputs.interval ?? 15,
    repo: inputs.repo ?? null,
    repoUrl: inputs.repoUrl ?? null,
    queue: { pool, supply: pool, reviewBacklog },
    tickets,
    filed: (ledger.filed || []).map(splitNumbered),
    // Telemetry, not pipeline state: null whenever the transcripts are unreadable
    // or this run has produced none yet. The UI hides the panel rather than
    // rendering zeroes, which would read as "this run was free".
    spend: inputs.spend ?? null,
    attention,
  };
}
