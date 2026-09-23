// Pure board-model builder. No I/O and no clock read — `now` is passed in, so
// dwell/staleness is deterministic and unit-testable. board.mjs does the gh/
// ledger I/O and calls computeBoard(); every stage-derivation and flag decision
// lives here and is exercised by compute-board.test.mjs (`node --test`).
//
// #1597: the ONE import this module takes, and it is a pure one —
// fleet-state.mjs owns the heartbeat's `beat` key, and the rule for reading
// that key travels with it rather than being copied here. That module's own
// I/O (its path probe, its file read) is never called from this file; only
// assessBeat/isStalled/stallReport are, all of which are functions of their
// arguments. Importing the rule is what keeps the cockpit's stall wording and
// fleet-tick's identical — two spellings of "this run is dead" would be two
// answers the operator has to reconcile at 3am.
import { assessBeat, isStalled, stallReport } from "./fleet-state.mjs";

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

// The stall surface, or null when there is nothing to say. #1597.
//
// The two facts the report needs beyond the mark itself — what is claimed and
// whether the pool still has supply — are read off THIS model rather than
// re-queried, which is the whole reason this lives here and not in gather().
// A ticket in flight is one the ledger placed past POOL and short of MERGED:
// a row exists for it, so it was claimed, and it has not landed, so the claim
// is still outstanding. That is the same population the `in-progress` label
// marks, arrived at from the ledger instead of from a label query the cockpit
// has no reason to run.
//
// `ledgerOk`/`poolOk` gate `claimed`/`supply` at `null`, never a computed
// zero, the moment either input did not actually read — the same "unknown is
// not zero" contract fleet-state.mjs's stallReport() states in its own words
// and fleet-tick.mjs's CLI side already honours. `tickets`/`pool` derive
// straight from `ledger.rows`/`issues`, which reduce to the empty array on
// either a genuinely empty read AND a failed one alike (gather()'s tryRun/
// tryParse fallback) — so without this gate, a `gh`/ledger outage prints the
// exact same "0 claimed, pool supply 0" a healthy drained run would, which is
// the one report an operator has no reason to distrust and every reason to.
//
// The verdict carries `text` — the rendered line — because board.html is
// served as one self-contained file with no imports: a page that formatted
// this itself would be a second wording of the same verdict, free to drift
// from fleet-tick's the moment either is edited. The page renders; the rule
// and its words stay here.
function stall(beat, ticked, tickets, pool, { ledgerOk, poolOk }, now) {
  const verdict = assessBeat({ beat, ticked, now });
  if (!isStalled(verdict)) return null;
  const claimed = ledgerOk ? tickets.filter((t) => t.column !== "POOL" && t.column !== "MERGED").length : null;
  const supply = poolOk ? pool : null;
  return { ...verdict, claimed, supply, text: stallReport(verdict, { claimed, supply }) };
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

  // A wayfinder:* ticket is documentation-only regardless of its triage role
  // (#1331): candidates.mjs's dispatch scan never surfaces one even carrying
  // `ready-for-agent`, so this POOL column must not either, or an
  // undispatchable ticket inflates the operator's read of available work.
  // Filtered HERE rather than out of gather()'s gh query: `issues` also feeds
  // titleFor() above, and a query-level exclusion silently strips a
  // wayfinder-labelled issue's title lookup too, turning an unrelated ledger
  // row's card into a bare `#<number>` even though only the POOL card was
  // ever supposed to change.
  for (const iss of issues) {
    if (rowIssues.has(iss.number)) continue;
    if ((iss.labels || []).some((l) => l.startsWith("wayfinder:"))) continue;
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
    // #1584: which workspace this board describes and which port served it.
    // Pass-through, exactly like repo/repoUrl above and for the same reason —
    // resolveCockpitInstance() answers both at the gather boundary, and this
    // module reads no cwd, no git and no socket, so it cannot re-derive either
    // and must not try. Defaulted to null rather than left undefined: a
    // missing key and a null one are the same value to a reader in JS but not
    // in the JSON on disk, and #1585's launch handshake reads `workspace` off
    // that JSON — a dropped key would make every board anonymous to it.
    workspace: inputs.workspace ?? null,
    port: inputs.port ?? null,
    queue: { pool, supply: pool, reviewBacklog },
    tickets,
    filed: (ledger.filed || []).map(splitNumbered),
    // Not derivable from anything else in this model: a ledger that was never
    // read, one read empty, and one whose payload would not parse all reduce to
    // the same empty lists, which is the collapse #816 names. gather() is the
    // only caller that can tell them apart, so it says so and this carries the
    // answer to the page. Defaulted rather than required — every other caller
    // of computeBoard builds its inputs by hand and means a ledger it read.
    ledgerState: ledger.state ?? "read",
    // Telemetry, not pipeline state: null when this run has produced no
    // transcripts yet, `{ ok: false, error }` when they cannot be read,
    // `{ ok: true, ... }` when they can. Those are deliberately not the same
    // value — the UI hides the panel on null rather than rendering zeroes,
    // which would read as "this run was free", and shows the error, which is
    // a bug the operator has to act on.
    spend: inputs.spend ?? null,
    // #1597. Telemetry beside `spend`, and under the same rule: a liveness
    // input can only ever POPULATE or OMIT this field, and nothing above it
    // reads `inputs.beat` — no column, no flag, no dwell clock, no attention
    // row. A dead controller does not move a ticket; it means nobody is
    // moving the tickets, which is a different statement and belongs in a
    // different field.
    //
    // Null for "nothing to report", which covers both a run that has never
    // beaten and one that is beating normally — the page hides the banner on
    // either, because a banner that fires on every healthy tick is a banner
    // the operator learns to read past.
    // `beat`/`ticked` pass through bare, unlike `spend` two fields up: that
    // coalesce is load-bearing because the value is serialised into
    // board.json as-is, while these two are only ever fed to assessBeat(),
    // which already treats `undefined` and `null` identically — a `?? null`
    // here would cost a line to say nothing stall() does not already do.
    //
    // `ledgerOk`/`poolOk` default to true absent a signal, matching
    // `ledgerState`'s own `?? "read"` default just above: every caller that
    // builds inputs by hand (every test in this suite) means a read that
    // succeeded, and only gather() — which now sets both — can say otherwise.
    liveness: stall(inputs.beat, inputs.ticked, tickets, pool, {
      ledgerOk: (ledger.state ?? "read") === "read",
      poolOk: inputs.poolOk ?? true,
    }, now),
    attention,
  };
}
