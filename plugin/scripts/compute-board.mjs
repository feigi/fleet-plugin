// Pure board-model builder. No I/O and no clock read — `now` is passed in, so
// dwell/staleness is deterministic and unit-testable. board.mjs does the gh/
// ledger I/O and calls computeBoard(); every stage-derivation and flag decision
// lives here and is exercised by compute-board.test.mjs (`node --test`).
//
// #1597, #1820, #1839: the THREE imports this module takes, all pure ones.
// fleet-state.mjs owns the heartbeat's `beat` key, and the rule for reading
// that key travels with it rather than being copied here. That module's own
// I/O (its path probe, its file read) is never called from this file; only
// assessBeat/isStalled/stallReport are, all of which are functions of their
// arguments. Importing the rule is what keeps the cockpit's stall wording and
// fleet-tick's identical — two spellings of "this run is dead" would be two
// answers the operator has to reconcile at 3am.
// ledger-grammar.mjs owns the member grammar (`<member>` live,
// `<member>=<outcome>` settled) and has no I/O at all; parseToken is read
// from it for the same reason — one grammar, one reader, so the cockpit and
// fleet-tick.mjs cannot disagree about which members are live.
// fleet-tick.mjs owns a row's PR reading, PR_MENTION, and a row with no impl
// token is read through it (#1820 amendment 2a, below) so both readers name
// the same PR for the same text, for a row that carries a PR-bound signal —
// an unsignaled row (no mention, no PR-bound member, no review=/reviewed=)
// still gets pr: null here while fleet-tick.mjs's own row-key fallback keys
// it to its ticket number regardless; see the amendment note below. The
// regex is all this file takes from it: the tick's I/O and main() never run
// here, main() being guarded on argv[1].
import { assessBeat, isStalled, stallReport } from "./fleet-state.mjs";
import { parseToken } from "./ledger-grammar.mjs";
import { PR_MENTION } from "./fleet-tick.mjs";

// A ledger row is freeform, controller-authored text. Two real examples:
//   #332 impl-332=PR#344 → PR#344 → MERGED 73b356de
//   #324 impl-324=PR#346 → PR#346 · fix-pr-346 · ruled:6-applies · held-behind:#313
// Extract by token, never by position — the controller reorders and appends
// tokens freely. Unknown text is ignored, never fatal.
//
// Member tokens are ledger-grammar.mjs's (#1820). On a row that has one, the
// row's LAST `impl` token, retry suffix included, decides the card: live →
// IMPLEMENTING, `=PR#M` → that PR decides, `=released`/`=bailed` → no card of
// the row's own (the POOL loop shows the ticket if it is still
// `ready-for-agent`), `=killed`/`=tier-mismatch` → IMPLEMENTING with that
// outcome as a flag. There the `→ PR#M` arrow is human-readable only;
// parseRow reads only the settled impl token's outcome. PR_MENTION is a blind
// `PR#<n>` text scan that in practice also lands on the impl token's embedded
// value, because that precedes the arrow in every row this run writes — but
// nothing enforces that order, so on such a row the arrow is never a value
// either reader may rely on.
//
// #1820 amendment 2a: a row with no `impl` token at all has no outcome to
// read, so it takes the tick's reading. `ledger.mjs dispatch <pr> fix-pr-<pr>` /
// `finisher-pr-<pr>` appends `#<pr> <member>` for a PR this run's
// implementers did not open. Once such a row carries a PR-bound signal — a
// `PR#M` mention, a `fix-pr-`/`finisher-pr-` member, `review=` or `reviewed=`
// — its PR is PR_MENTION's, else the row key, and that PR decides the card as
// `=PR#M` does. An Exclusion never takes one.
//
// A member settled anywhere on the row is settled — a bare copy beside
// `<member>=<outcome>` is what a whole-line `row` rewrite leaves.
//
// A PR's review is not a member (#1773 §7): `review=wf:<runId>` is a Workflow
// with nobody to name, while `review=member:<name>` and
// `review=fallback:<name>` name a runner member, live until the token is
// settled `=failed` or a later `reviewed=` records its result.
//
// #1820 amendment 5a: a `review=` token puts the PR under review only while
// it is live. A settled `review=…=failed` is a dead review and the PR is owed
// one again, as run-team SKILL.md defines review-due and as fleet-tick.mjs's
// `reviewedAny` reads the token: the PR is owed none while the row carries
// ANY live `review=` — wherever it sits, not only as the last one — or any
// `reviewed=`. A `review=` token outside the grammar is still read as live
// here; fleet-tick.mjs refuses that ledger outright, so there is no reading of
// it to agree with.
//
// `#N excluded · behind-pr:#M` / `behind-issue:#M` is an Exclusion — pool
// supply, not a claim — spelled exactly as shortlist.mjs and fleet-tick.mjs
// spell it. `#M` is an issue or PR number, or the branch name recorded before
// that PR existed.
const EXCLUDED_ROW = /^#[0-9]+[ \t]+excluded(?=[ \t]|$)([\s\S]*)$/;
const PREMISE = /\bbehind-(pr|issue):#?([^\s,;]+)/g;
const REVIEW = /^review=(?:wf|member|fallback):([^=\s]+?)(=failed)?$/;

export function parseRow(row) {
  const issueM = row.match(/^#(\d+)\b/);
  if (!issueM) return null;
  const mergedM = row.match(/\bMERGED\s+([0-9a-f]{7,40})\b/i);
  const heldM = row.match(/\bheld-behind[:\s]+#?(\d+)\b/i);
  const causes = [];
  for (const t of ["KILLED", "BLOCKED", "SHA-OFF-BRANCH"]) {
    if (new RegExp(`\\b${t}\\b`).test(row)) causes.push(t.toLowerCase());
  }
  const ex = EXCLUDED_ROW.exec(row);

  // `live` holds member names in row order; `outcomes` every settled name's
  // latest outcome. A malformed outcome is still a settle — never counted
  // live, never decides a card — but it is not silently dropped either: it
  // earns the row a `ledger-error` flag (deriveFlags below), the same
  // "refuse rather than guess" contract ledger-grammar.mjs's own docstring
  // states `.error` exists for.
  const live = [];
  const outcomes = new Map();
  const settled = new Set();
  let lastImpl = null;
  let anyImpl = false;
  let prMember = false;
  let review = false; // any review= token: a PR-bound signal (amendment 2a)
  let reviewLive = false; // one not settled `=failed` (amendment 5a)
  let reviewed = false;
  let runners = [];
  let malformed = false;
  for (const tok of row.split(/\s+/).filter(Boolean)) {
    const t = parseToken(tok);
    if (t) {
      if (t.error) malformed = true;
      if (t.outcome === null) live.push(t);
      else settled.add(t.name);
      if (t.outcome !== null && !t.error) outcomes.set(t.name, t.outcome);
      if (t.family === "impl") {
        anyImpl = true;
        if (!t.error) lastImpl = t.name;
      }
      if (t.bound === "pr") prMember = true;
      continue;
    }
    if (tok.startsWith("review=")) {
      review = true;
      const m = REVIEW.exec(tok);
      if (!m?.[2]) reviewLive = true;
      if (m && !tok.startsWith("review=wf:")) {
        if (m[2]) settled.add(m[1]);
        else { live.push({ name: m[1], family: "review" }); runners.push(m[1]); }
      }
    } else if (tok.startsWith("reviewed=")) {
      reviewed = true;
      for (const r of runners) settled.add(r);
      runners = [];
    }
  }
  const alive = live.filter((t) => !settled.has(t.name));
  const implOutcome = lastImpl ? (outcomes.get(lastImpl) ?? null) : null;
  const prM = implOutcome && /^PR#(\d+)$/.exec(implOutcome);
  let pr = prM ? Number(prM[1]) : null;
  // #1820 amendment 2a: a row with NO impl token — a malformed one still
  // counts, since that row's key is a ticket — is keyed, once THIS row
  // carries a PR-bound signal, the way fleet-tick.mjs's PR_MENTION-then-
  // row-key logic would: its first PR_MENTION (itself a signal), else the
  // row key when the first word is exactly `#N`. fleet-tick.mjs's own
  // row-key fallback (deriveRun) is NOT itself gated on a signal — this
  // module's extra gate exists so an ordinary unclaimed ticket never
  // borrows its own number as a phantom PR. An Exclusion is supply and
  // never takes a PR, whatever text it carries.
  if (!anyImpl && !ex) {
    const mention = PR_MENTION.exec(row);
    if (mention) pr = Number(mention[1]);
    else if ((prMember || review || reviewed) && row.split(/\s/)[0] === issueM[0]) pr = Number(issueM[1]);
  }
  return {
    issue: Number(issueM[1]),
    excluded: ex ? [...ex[1].matchAll(PREMISE)].map(([, kind, target]) => ({ kind, target })) : null,
    impl: lastImpl,
    implOutcome,
    agent: alive.length ? alive[alive.length - 1].name : null,
    pr,
    merged: !!mergedM,
    sha: mergedM ? mergedM[1] : null,
    heldBehind: heldM ? Number(heldM[1]) : null,
    causes,
    malformed,
    review,
    reviewed,
    underReview: reviewLive || alive.some((t) => t.family === "fix-pr" || t.family === "finisher-pr"),
  };
}

// A parsed row's column, or null when the row claims no card of its own (a
// released or bailed implementer: the ticket went back to the tracker, and the
// POOL loop shows it if it is still `ready-for-agent`). An Exclusion is POOL.
// MERGED is an explicit `MERGED <sha>` token or, failing one, `prState.merged`
// — gh's answer for a row PR absent from the open list, or (#1841) a
// carry-forward of the previous board's MERGED for that SAME PR on that
// ticket: MERGED is terminal, so a merged PR never reopens regardless of
// what this run's merged read says — but a ticket retried under a NEW PR
// after its earlier one merged gets no such carry-forward; that new PR's
// state is unknown, not MERGED. READY needs the live PR label; any other
// PR, closed-unmerged included, is in REVIEW.
export function deriveColumn(parsed, prState) {
  if (parsed.excluded) return "POOL";
  if (parsed.merged) return "MERGED";
  if (parsed.pr != null) {
    if (prState && prState.merged) return "MERGED";
    if (prState && prState.labels.includes("ready-to-merge")) return "READY";
    return "REVIEW";
  }
  if (parsed.implOutcome === "released" || parsed.implOutcome === "bailed") return null;
  return "IMPLEMENTING";
}

// Dwell thresholds per column, ms. A ticket sitting longer than this in a
// non-terminal column earns `stale`. POOL and MERGED are absent → never stale.
export const STALE_MS = {
  IMPLEMENTING: 20 * 60 * 1000,
  REVIEW: 45 * 60 * 1000,
  READY: 15 * 60 * 1000,
};

// An Exclusion's badges are its premises, `excluded:#880` for a number and
// `excluded:<branch>` for a branch name, and nothing else: it is supply, so no
// dwell clock and no cause applies. isBadge() keeps them out of `attention`.
export function deriveFlags(parsed, ctx) {
  if (parsed.excluded) {
    return parsed.excluded.length
      ? parsed.excluded.map(({ target }) => `excluded:${target.length > 0 && !/[^0-9]/.test(target) ? "#" : ""}${target}`)
      : ["excluded"];
  }
  const flags = [];
  if (parsed.malformed) flags.push("ledger-error");
  if (ctx.ci === "red") flags.push("red-ci");
  if (parsed.heldBehind != null) flags.push(`held-behind:#${parsed.heldBehind}`);
  for (const c of parsed.causes) flags.push(c); // killed | blocked | sha-off-branch
  const o = parsed.implOutcome;
  if ((o === "killed" || o === "tier-mismatch") && !flags.includes(o)) flags.push(o);
  const limit = STALE_MS[ctx.column];
  if (limit != null && ctx.sinceEnteredStage != null && ctx.now - ctx.sinceEnteredStage > limit) {
    flags.push("stale");
  }
  return flags;
}

const isBadge = (flag) => flag === "excluded" || flag.startsWith("excluded:");

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

const FLAG_SEVERITY = { "red-ci": 5, "ledger-error": 5, killed: 4, "tier-mismatch": 4, blocked: 4, "sha-off-branch": 4, stale: 1 };
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

// `merged` (#1820) is gh's list of merged PR numbers, consulted only for a row
// PR absent from the open list `prs`; absent means none known, and a PR in
// neither list (closed unmerged, or a failed read) keeps REVIEW — unless
// (#1841) the previous board already showed the SAME PR MERGED for this
// ticket, in which case it stays MERGED: MERGED is terminal, so a merged PR
// cannot reopen, whether this run's merged read failed outright or simply
// succeeded without listing it (#1840's window-scoping symptom, a separate
// fix). Keyed on the PR, not just the ticket: a ticket retried under a NEW
// PR after its earlier one merged carries no MERGED verdict forward for
// that new, unrelated PR — only a previous board entry for the SAME `p.pr`
// counts. A PR that IS in the open list is never eligible for this
// carry-forward — only the "absent from both `prs` and (maybe) `merged`"
// branch below ever consults it.
export function computeBoard(inputs) {
  const { ledger, issues, prs, ci, prev, now } = inputs;
  const prByNum = new Map(prs.map((p) => [p.number, p]));
  const mergedPrs = new Set(inputs.merged || []);
  const prevByIssue = new Map((prev?.tickets || []).map((t) => [t.issue, t]));
  const ruledByPr = new Map();
  for (const r of ledger.ruled || []) {
    const s = splitNumbered(r);
    if (s.issue != null) ruledByPr.set(s.issue, s.subject);
  }

  const parsed = (ledger.rows || []).map(parseRow).filter(Boolean);
  const rowIssues = new Set();
  const tickets = [];

  for (const p of parsed) {
    const pr = p.pr != null ? prByNum.get(p.pr) : undefined;
    const prevTicket = prevByIssue.get(p.issue);
    const prState = p.pr == null ? null
      : pr ? { open: pr.state === "OPEN", labels: pr.labels || [] }
           : { open: false, labels: [], merged: mergedPrs.has(p.pr) || (prevTicket?.column === "MERGED" && prevTicket.pr === p.pr) };
    const column = deriveColumn(p, prState);
    if (column === null) continue; // released/bailed: the POOL loop below decides
    rowIssues.add(p.issue);
    const sinceEnteredStage = stageEntry(prevTicket, column, now);
    const ciState = p.pr != null ? (ci[p.pr] ?? "unknown") : null;
    const flags = deriveFlags(p, { ci: ciState, column, sinceEnteredStage, now });
    tickets.push({
      issue: p.issue,
      title: titleFor(p.issue, pr, issues),
      column,
      agent: p.agent,
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

  const attention = tickets.filter((t) => t.flags.some((f) => !isBadge(f)))
    .sort((a, b) => severity(b.flags) - severity(a.flags));

  // Backlog is a PR nobody has reviewed and nobody is reviewing: no live
  // `review=` (#1820 amendment 5a — a settled `=failed` one is no review), no
  // `reviewed=`, and no live fix-applier or finisher on the row.
  const parsedByIssue = new Map(parsed.map((p) => [p.issue, p]));
  const reviewBacklog = tickets.filter((t) => {
    const p = parsedByIssue.get(t.issue);
    return t.column === "REVIEW" && !p.underReview && !p.reviewed;
  }).length;
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
