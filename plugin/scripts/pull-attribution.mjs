// The one booking of member rows, merges and claims to Pulls, read by both the
// cost guard (pr-cost.mjs) and the router's fit (ticket-router.mjs), so the two
// print the same figures for a cell. Neither CLI imports the other; both import
// this.
//
// THE UNIT is the Pull, a ticket-features.tsv row, booked AS ROUTED to its
// `chosen_cell`: its merge, its Ruling and all its spend. A ticket Pulled twice
// is two units. Nothing splits across cells.
//
// JOINS. Only omp member rows are read, and a member whose name's last segment
// starts with merge-bot (or mergebot), or is `memory` or `__advisor`, is booked
// nowhere: its cost does not vary with the cell.
//   - An implementer row (member-outcomes' implementer leaf) joins the Pull of
//     its `ticket` in its own session. A session with no Pull of that ticket
//     (a claim resumed in a later run) joins the ticket's latest earlier Pull.
//   - A review, fix or finisher row — any row whose name carries a PR — joins
//     the Pull whose implementer rows carry that PR in `pr`.
//   - A nested member books with its nearest booked ancestor.
//
// RULING. A Pull's candidate Ruling is `rulingFor` of its ticket and date. One
// PR's merge counts once: among the Pulls whose candidate names it, the Pull
// whose implementer rows carry the PR takes it, with the verdict of the latest
// such ruling row in file order. When none carries it, the last of them in
// file order takes it and is unpriced, since its PR's review and fix spend
// cannot be booked. The other candidates stay unruled.
//
// MERGED: the Pull holds a Ruling and, when PR states are given, its PR is
// MERGED. With PR states, a ruled PR that is OPEN or not in the list, or an
// unruled Pull whose implementer opened a PR still OPEN, is pending.
//
// STATUS, first that applies:
//   excluded  no Admissible row among the Pull's implementer rows;
//   pending   see above (only with PR states);
//   left-out  holds no claim (never merged, no `fixed` bail), and every
//             implementer ending is the ticket's or neither's;
//   unpriced  a booked row's `cost` is blank, or the Pull took its Ruling
//             without carrying its PR;
//   counted   every other Pull: the only ones in a cell's figures.
//
// ENDINGS come from member-outcomes' `ending` column. The cell's: `hollow`,
// `budget`, `bail:fixed-refuted`, `unknown`. The ticket's: every other
// `bail:<cause>`. Neither's: `provider`, `crash`, `abort`.
//
// CLAIMS. A merged Pull is one claim, false when its Ruling fails the floor
// (`minted_false_claim=yes` or `closed_own_ticket=no`). Each `bail:fixed` or
// `bail:fixed-refuted` ending is one claim, false when refuted. A cell's fail
// rate is its counted Pulls' false claims over their claims.
//
// SPEND is the recorded `cost` of every row booked to the Pull. A `cost` that
// is neither blank nor a number is refused, naming the row.

import { isDigits } from "./arg.mjs";
import { CELL } from "./ledger-grammar.mjs";
import { parseMemberName } from "./member-record.mjs";
import { isImplementer } from "./member-outcomes.mjs";
import { DATE, rulingFor, rulingsByTicket } from "./tier-outcomes.mjs";

// The ticket-features row, one per Pull, in this order.
export const FEATURE_COLUMNS = Object.freeze([
  "run_date", "session", "agent", "ticket", "policy_cell", "chosen_cell", "exploration_draw",
  "sizing_src", "sizing_pre", "router_usd", "brief_chars", "criteria", "comments", "age_days",
  "paths", "test_paths", "xrefs", "kind",
]);

// ticket-features.tsv: one bare header line naming the columns, then rows.
// Read by header name; a row whose width differs from the header's is refused.
export function parseFeatures(text) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("ticket-features.tsv has no header line");
  const header = lines[0].split("\t");
  const missing = FEATURE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`ticket-features.tsv header lacks ${missing.join(", ")}`);
  return lines.slice(1).map((l, i) => {
    const cells = l.split("\t");
    if (cells.length !== header.length) {
      throw new Error(`ticket-features.tsv row ${i + 1}: ${cells.length} fields, expected ${header.length} — ${l.slice(0, 60)}`);
    }
    const row = Object.fromEntries(header.map((c, j) => [c, cells[j]]));
    if (!isDigits(row.ticket)) throw new Error(`ticket-features.tsv row ${i + 1}: ticket ${JSON.stringify(row.ticket)} is not a number`);
    if (!CELL.test(row.chosen_cell)) throw new Error(`ticket-features.tsv row ${i + 1}: chosen_cell ${JSON.stringify(row.chosen_cell)} is not a cell`);
    return row;
  });
}

export const EXCLUDED_MEMBER = /^(?:merge-?bot|memory$|__advisor$)/i;
// omp nests a member's id as `<parent>/<parent>.<child>`: the child is the last segment after either separator.
export const lastSegment = (agent) => String(agent).split(/[/.]/).at(-1);

// An Admissible row for `cell`: dispatched as the cell's own definition, run at
// the cell's level, with a resolved model on record.
export function admissibleRow(row, cell) {
  const level = CELL.exec(cell)?.[2] ?? null;
  return level !== null && row.subagentType === `fleet-implementer-${cell}` && row.effort === level && !!row.model;
}

// A bad input row, as opposed to a bug: a caller that reports bad input catches this class alone.
export class AttributionError extends Error {}

/**
 * The features rows with a YYYY-MM-DD `run_date`, the rows that can be placed
 * against the window and a ruling. A blank `run_date` (route writes one for a
 * session id with no date) is no Pull and is left out. Any other date is a
 * hand-edit that cannot be placed and is refused: dropping it would shrink
 * every figure unseen.
 */
function datedRows(features) {
  return features.filter((r) => {
    if (DATE.test(r.run_date)) return true;
    if (r.run_date !== "") throw new AttributionError(`ticket #${r.ticket}: a ticket-features row's run_date is '${r.run_date}', expected YYYY-MM-DD or blank`);
    return false;
  });
}

const CELL_ENDINGS = new Set(["hollow", "budget", "bail:fixed-refuted", "unknown"]);
const NEITHER_ENDINGS = new Set(["provider", "crash", "abort"]);
const ticketsEnding = (e) => e.startsWith("bail:") && !CELL_ENDINGS.has(e);
const failsFloor = (ruling) => ruling.minted_false_claim === "yes" || ruling.closed_own_ticket === "no";
// An omp session id opens with its ISO start time, so two of them sort in time order.
const STARTED = /^\d{4}-\d{2}-\d{2}T/;
const startedBefore = (pull, row) => (STARTED.test(pull.session) && STARTED.test(row.session) ? pull.session < row.session : pull.run_date <= row.run_date);

function costOf(row) {
  const c = String(row.cost ?? "");
  if (c === "") return null;
  const n = Number(c);
  if (c.trim() === "" || !Number.isFinite(n)) throw new AttributionError(`member-outcomes row session ${row.session} agent ${row.agent}: cost '${c}' is not a number`);
  return n;
}

/**
 * One unit per ticket-features row dated on or after `windowStart` (every dated
 * row when null), in file order: `{ pull, cell, stratum, status, merged, pr,
 * ruling, pendingPr, claims, falseClaims, rows, spend }`. `prs` is `gh pr list`'s
 * `{ number, state }` rows, or null when PR state is unknown (the fit). `stratum`
 * maps a features row to its stratum. Throws `AttributionError` on a features
 * row it cannot date or a booked `cost` it cannot read, and `RulingError` as
 * `rulingFor` does.
 */
export function attribute({ features, members, tiers, prs = null, windowStart = null, stratum = () => null }) {
  const key = (session, agent) => `${session}\0${agent}`;
  const pulls = datedRows(features);
  const bySessionTicket = new Map(), byTicket = new Map();
  for (const p of pulls) {
    const k = key(p.session, p.ticket);
    (bySessionTicket.get(k) ?? bySessionTicket.set(k, []).get(k)).push(p);
    (byTicket.get(p.ticket) ?? byTicket.set(p.ticket, []).get(p.ticket)).push(p);
  }

  const omp = members.filter((r) => r.harness === "omp" && !EXCLUDED_MEMBER.test(lastSegment(r.member)));
  // Implementer rows to their Pull, and a PR-named member's key to its PR.
  const implPull = new Map(), prOfKey = new Map();
  const impls = new Map(pulls.map((p) => [p, []]));
  for (const r of omp) {
    if (isImplementer(r.member)) {
      if (!r.ticket) continue;
      const own = bySessionTicket.get(key(r.session, r.ticket));
      const pull = own ? (own.find((p) => p.agent === r.agent) ?? own.at(-1)) : byTicket.get(r.ticket)?.findLast((p) => startedBefore(p, r));
      if (!pull) continue;
      implPull.set(key(r.session, r.agent), pull);
      impls.get(pull).push(r);
    } else {
      const { pr } = parseMemberName(r.member);
      if (pr) prOfKey.set(key(r.session, r.agent), pr);
    }
  }
  // Each PR to the last Pull, in file order, whose implementer rows carry it.
  const carrier = new Map();
  for (const p of pulls) for (const r of impls.get(p)) if (r.pr) carrier.set(r.pr, p);

  // Every row books to its nearest booked ancestor, itself included.
  const rows = new Map(pulls.map((p) => [p, []]));
  for (const r of omp) {
    const segs = String(r.agent).split("/");
    for (let i = segs.length; i > 0; i--) {
      const k = key(r.session, segs.slice(0, i).join("/"));
      const pull = implPull.get(k) ?? carrier.get(prOfKey.get(k));
      if (pull) rows.get(pull).push(r);
      if (pull || prOfKey.has(k)) break;
    }
  }

  // Rulings: each PR's merge to one Pull.
  const inWindow = pulls.filter((p) => windowStart === null || p.run_date >= windowStart);
  const rulings = rulingsByTicket(tiers);
  const fileOrder = new Map(tiers.map((t, i) => [t, i]));
  const candidates = new Map(); // pr -> [{ pull, ruling }]
  for (const p of inWindow) {
    const ruling = rulingFor(rulings, p.ticket, p.run_date);
    if (ruling) (candidates.get(ruling.pr) ?? candidates.set(ruling.pr, []).get(ruling.pr)).push({ pull: p, ruling });
  }
  const ruled = new Map(); // pull -> { pr, ruling, carried }
  for (const [pr, cands] of candidates) {
    const ruling = cands.reduce((a, c) => (fileOrder.get(c.ruling) > fileOrder.get(a) ? c.ruling : a), cands[0].ruling);
    const held = cands.find((c) => c.pull === carrier.get(pr));
    ruled.set(held?.pull ?? cands.at(-1).pull, { pr, ruling, carried: !!held });
  }

  const state = prs && new Map(prs.map((p) => [String(p.number), p.state]));
  return inWindow.map((pull) => {
    const own = impls.get(pull);
    const booked = rows.get(pull);
    const r = ruled.get(pull) ?? null;
    let merged = r !== null;
    let pendingPr = null;
    if (state) {
      if (r) {
        const s = state.get(r.pr);
        if (s === undefined || s === "OPEN") pendingPr = r.pr;
        merged = s === "MERGED";
      } else pendingPr = own.find((m) => m.pr && state.get(m.pr) === "OPEN")?.pr ?? null;
    }
    let claims = 0, falseClaims = 0;
    if (merged) {
      claims++;
      if (failsFloor(r.ruling)) falseClaims++;
    }
    for (const m of own) {
      if (m.ending === "bail:fixed" || m.ending === "bail:fixed-refuted") claims++;
      if (m.ending === "bail:fixed-refuted") falseClaims++;
    }
    let spend = 0, blank = false;
    for (const m of booked) {
      const c = costOf(m);
      if (c === null) blank = true;
      else spend += c;
    }
    let status = "counted";
    if (!own.some((m) => admissibleRow(m, pull.chosen_cell))) status = "excluded";
    else if (pendingPr !== null) status = "pending";
    else if (claims === 0 && own.every((m) => ticketsEnding(m.ending) || NEITHER_ENDINGS.has(m.ending))) status = "left-out";
    else if (blank || (r && !r.carried)) status = "unpriced";
    return {
      pull, cell: pull.chosen_cell, stratum: stratum(pull), status, merged, pr: r?.pr ?? null, ruling: r?.ruling ?? null,
      pendingPr, claims, falseClaims, rows: booked, spend: blank ? null : spend,
    };
  });
}

/**
 * Per cell, in cell-name order: `{ cell, n, merged, claims, failed, spend,
 * excluded, left_out, unpriced, pending }`. `n`, `merged`, `claims`, `failed`
 * and `spend` are over counted Pulls alone; the last four count the Pulls of
 * each other status.
 */
export function tally(units) {
  const cells = new Map();
  for (const u of units) {
    const c = cells.get(u.cell) ?? cells.set(u.cell, {
      cell: u.cell, n: 0, merged: 0, claims: 0, failed: 0, spend: 0, excluded: 0, left_out: 0, unpriced: 0, pending: 0,
    }).get(u.cell);
    if (u.status === "counted") {
      c.n++;
      if (u.merged) c.merged++;
      c.claims += u.claims;
      c.failed += u.falseClaims;
      c.spend += u.spend;
    } else c[u.status.replace("-", "_")]++;
  }
  return [...cells.values()].sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
}
