// The one booking of member rows, merges and claims to Pulls, read by both the
// cost guard (pr-cost.mjs) and the router's fit (ticket-router.mjs), so the two
// print the same figures for a cell. Neither CLI imports the other; both import
// this, and with it the two judgements they share: the quality floor (the
// guard's fail leg) and the bootstrap range of a $ per merged PR difference.
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
// RULING. One PR's merge counts once, to one Pull. First, carrier binding: a
// Pull takes the Ruling of a PR it is the carrier of (the last Pull in file
// order whose implementer rows carry the PR) when a ruling row names that PR,
// the latest such row in file order, whatever its ticket or date. A Pull that
// carries several ruled PRs takes the one whose ruling row is latest in file
// order and leaves the others to the date floor. Every ruling row of the bound
// row's tickets is checked as `rulingFor` checks the Pull's own ticket's, so a
// Pull can be refused for a bad row of a ticket that is not its own.
// Then the date-floor fallback: each other Pull's candidate Ruling is
// `rulingFor` of its ticket and date, unless a carrier took that PR. Among the
// Pulls whose candidate names a PR, the last in file order takes it, with the
// verdict of the latest such ruling row in file order, and is unpriced, since
// its PR's review and fix spend cannot be booked. The other candidates stay
// unruled.
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
//   untimed   a booked row whose `agent` names no parent has a blank `work_s`;
//   counted   every other Pull: the only ones in a cell's figures.
//
// ENDINGS come from member-outcomes' `ending` column. The cell's: `hollow`,
// `budget`, `bail:fixed-refuted`, `unknown`. The ticket's: `blocked` and every
// other `bail:<cause>`. Neither's: `provider`, `crash`, `abort`.
//
// CLAIMS. A merged Pull is one claim, false when its Ruling fails the floor
// (`minted_false_claim=yes` or `closed_own_ticket=no`). Each `bail:fixed` or
// `bail:fixed-refuted` ending is one claim, false when refuted. A cell's fail
// rate is its counted Pulls' false claims over their claims.
//
// SPEND is the recorded `cost` of every row booked to the Pull. A `cost` that
// is neither blank nor a number is refused, naming the row.
//
// WORK TIME is the summed `work_s` of the rows booked to the Pull whose
// `agent` names no parent: every implementer, rescues included, and the PR's
// review, fix and finisher members. A nested member adds nothing, since its
// time lies inside its parent's. A `work_s` that is neither blank nor a number
// is refused, naming the row.
//
// GENERATION. A cell's figures are per Cell generation: the cell on one
// dispatch model, member-outcomes' `dispatch_model`. A Pull's generation is
// the dispatch model of its first Admissible implementer row in dispatch
// order: the session, then `impl-<N>` before its retries `-b`, `-c`, ….
// A row at another cell (a rescue) is booked to the Pull and never changes
// its generation; an excluded Pull has none. A cell's NEWEST generation is
// that of its latest Pull that has one, by session id, then file order.
// Generations are told apart by model alone, so a cell that returns to an
// earlier model rejoins that generation's Pulls. Only the newest generation's
// figures are judged; older ones are reported beside them, never pooled.
//
// THE FLOOR. A cell is under the floor against a baseline when its fail rate
// is TRIP_POINTS or more points above the baseline's, compared in integer
// counts. The guard holds it pooled; the fit holds it per row.

import { isDigits } from "./arg.mjs";
import { CELL } from "./ledger-grammar.mjs";
import { parseMemberName } from "./member-record.mjs";
import { isImplementer } from "./member-outcomes.mjs";
import { DATE, rulingFor, rulingsByTicket } from "./tier-outcomes.mjs";

// The ticket-features row, one per Pull, in this order. `objective` came last
// and is optional on read: a file whose header lacks it reads it blank.
export const FEATURE_COLUMNS = Object.freeze([
  "run_date", "session", "agent", "ticket", "policy_cell", "chosen_cell", "exploration_draw",
  "sizing_src", "sizing_pre", "router_usd", "brief_chars", "criteria", "comments", "age_days",
  "paths", "test_paths", "xrefs", "kind", "objective",
]);
const OPTIONAL_COLUMNS = new Set(["objective"]);

// The quality floor's margin, in points of fail rate.
export const TRIP_POINTS = 15;

// The floor, in integer counts so a 3-of-20 difference is exactly 15 points
// rather than 14.999… in floating point. Each side is `{ claims, failed }`.
export function underFloor(cell, base) {
  return (cell.failed * base.claims - base.failed * cell.claims) * 100 >= TRIP_POINTS * cell.claims * base.claims;
}

const round2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

// Deterministic, so a re-run reads the same range.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The bootstrap 95% range of (cell − base) per merged PR, its ends rounded to
// two places. Each unit is one counted Pull, `bootUnit`'s shape:
// `{ value, merged }`, `value` the measure `bootUnit` was asked for and
// merged 0 or 1. The figure per merged PR is Σvalue / Σmerged. null when
// either side has no unit, or when under half the resamples have a merged PR
// on both sides.
export function bootstrapDiffCI(cellUnits, baseUnits, { iterations = 2000, seed = 1 } = {}) {
  if (!cellUnits.length || !baseUnits.length) return null;
  const rand = mulberry32(seed);
  const resample = (units) => {
    let u = 0, m = 0;
    for (let i = 0; i < units.length; i++) {
      const x = units[Math.floor(rand() * units.length)];
      u += x.value; m += x.merged;
    }
    return m ? u / m : null;
  };
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    const a = resample(cellUnits), b = resample(baseUnits);
    if (a !== null && b !== null) diffs.push(a - b);
  }
  if (diffs.length < iterations / 2) return null;
  diffs.sort((x, y) => x - y);
  return [round2(diffs[Math.floor(0.025 * (diffs.length - 1))]), round2(diffs[Math.ceil(0.975 * (diffs.length - 1))])];
}

// What a bootstrap unit measures: `usd`, its spend, or `minutes`, its work time.
const METRIC = Object.freeze({ usd: (u) => u.spend, minutes: (u) => u.workS / 60 });

// A counted Pull as a bootstrap unit, its `value` the Pull's `metric`.
export const bootUnit = (u, metric = "usd") => ({ value: METRIC[metric](u), merged: u.merged ? 1 : 0 });

// ticket-features.tsv: one bare header line naming the columns, then rows.
// Read by header name; a row whose width differs from the header's is refused.
export function parseFeatures(text) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("ticket-features.tsv has no header line");
  const header = lines[0].split("\t");
  const missing = FEATURE_COLUMNS.filter((c) => !header.includes(c) && !OPTIONAL_COLUMNS.has(c));
  if (missing.length) throw new Error(`ticket-features.tsv header lacks ${missing.join(", ")}`);
  return lines.slice(1).map((l, i) => {
    const cells = l.split("\t");
    if (cells.length !== header.length) {
      throw new Error(`ticket-features.tsv row ${i + 1}: ${cells.length} fields, expected ${header.length} — ${l.slice(0, 60)}`);
    }
    const row = Object.fromEntries(header.map((c, j) => [c, cells[j]]));
    for (const c of OPTIONAL_COLUMNS) row[c] ??= "";
    if (!isDigits(row.ticket)) throw new Error(`ticket-features.tsv row ${i + 1}: ticket ${JSON.stringify(row.ticket)} is not a number`);
    if (!CELL.test(row.chosen_cell)) throw new Error(`ticket-features.tsv row ${i + 1}: chosen_cell ${JSON.stringify(row.chosen_cell)} is not a cell`);
    return row;
  });
}

export const EXCLUDED_MEMBER = /^(?:merge-?bot|memory$|__advisor$)/i;
// omp nests a member's id as `<parent>/<parent>.<child>`: the child is the last segment after either separator.
export const lastSegment = (agent) => String(agent).split(/[/.]/).at(-1);

// An Admissible row for `cell`: dispatched as the cell's own definition, run at
// the cell's level, with its dispatch model on record. The last turn's `model`
// is not read: a member that fell back to another provider is still admitted.
export function admissibleRow(row, cell) {
  const level = CELL.exec(cell)?.[2] ?? null;
  return level !== null && row.subagentType === `fleet-implementer-${cell}` && row.effort === level && !!row.dispatchModel;
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
const ticketsEnding = (e) => e === "blocked" || (e.startsWith("bail:") && !CELL_ENDINGS.has(e));
const failsFloor = (ruling) => ruling.minted_false_claim === "yes" || ruling.closed_own_ticket === "no";
// An omp session id opens with its ISO start time, so two of them sort in time order.
const STARTED = /^\d{4}-\d{2}-\d{2}T/;
const startedBefore = (pull, row) => (STARTED.test(pull.session) && STARTED.test(row.session) ? pull.session < row.session : pull.run_date <= row.run_date);
// An implementer leaf's retry suffix: "" for `impl-<N>`, "b" for `impl-<N>-b`.
const retryOf = (row) => /^impl-\d+(?:-([a-z0-9]+))?$/.exec(String(row.member).split("/").pop())?.[1] ?? "";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Implementer rows in dispatch order: by session, then the bare name before
// its retries, a shorter suffix before a longer one (`-z` before `-aa`).
const dispatchOrder = (rows) => [...rows].sort((a, b) => {
  const [x, y] = [retryOf(a), retryOf(b)];
  return cmp(a.session, b.session) || x.length - y.length || cmp(x, y);
});
const key = (session, agent) => `${session}\0${agent}`;
// The omp rows a Pull can book: every member but the merge bot, memory and the advisor.
const ompRows = (members) => members.filter((r) => r.harness === "omp" && !EXCLUDED_MEMBER.test(lastSegment(r.member)));

/**
 * Each implementer row of `omp` to its Pull among `pulls`: the same session's
 * Pull of the row's ticket and agent, else that session's last Pull of the
 * ticket, else the ticket's last Pull started before the row (a retry in a
 * later session). `impls` maps every Pull to its rows, `implPull` each booked
 * row's session+agent to its Pull. A row with no ticket, or no such Pull, is
 * booked to none.
 */
function bookImplementers(pulls, omp) {
  const bySessionTicket = new Map(), byTicket = new Map();
  for (const p of pulls) {
    const k = key(p.session, p.ticket);
    (bySessionTicket.get(k) ?? bySessionTicket.set(k, []).get(k)).push(p);
    (byTicket.get(p.ticket) ?? byTicket.set(p.ticket, []).get(p.ticket)).push(p);
  }
  const implPull = new Map();
  const impls = new Map(pulls.map((p) => [p, []]));
  for (const r of omp) {
    if (!isImplementer(r.member) || !r.ticket) continue;
    const own = bySessionTicket.get(key(r.session, r.ticket));
    const pull = own ? (own.find((p) => p.agent === r.agent) ?? own.at(-1)) : byTicket.get(r.ticket)?.findLast((p) => startedBefore(p, r));
    if (!pull) continue;
    implPull.set(key(r.session, r.agent), pull);
    impls.get(pull).push(r);
  }
  return { impls, implPull };
}

// A Pull's generation from its implementer rows: its first Admissible row's dispatch model, else null.
const generationOf = (own, cell) => dispatchOrder(own).find((m) => admissibleRow(m, cell))?.dispatchModel ?? null;

/**
 * Each of `pulls` (ticket-features rows) to its generation, `attribute`'s
 * rule over `members`: the dispatch model of the Pull's first Admissible
 * implementer row in dispatch order, or null when it has none. Every caller
 * that names a Pull's generation reads it here, so the guard, the fit and the
 * stopping rule never derive two generations for one Pull.
 */
export function pullGenerations(pulls, members) {
  const { impls } = bookImplementers(pulls, ompRows(members));
  return new Map(pulls.map((p) => [p, generationOf(impls.get(p), p.chosen_cell)]));
}

// A booked row's recorded number in `column` (`field` on the parsed row; `column` defaults to `field` where the two names agree): null when blank; refused, naming the row, when neither blank nor a number.
function numberOf(row, field, column = field) {
  const c = String(row[field] ?? "");
  if (c === "") return null;
  const n = Number(c);
  if (c.trim() === "" || !Number.isFinite(n)) throw new AttributionError(`member-outcomes row session ${row.session} agent ${row.agent}: ${column} '${c}' is not a number`);
  return n;
}

/**
 * One unit per ticket-features row dated on or after `windowStart` (every dated
 * row when null), in file order: `{ pull, cell, stratum, generation, status,
 * merged, pr, ruling, pendingPr, claims, falseClaims, rows, spend, workS }`,
 * `generation` null exactly when the Pull is excluded. `spend` is null when a
 * booked `cost` is blank, and `workS`, its work time in seconds, when a booked
 * `work_s` of a row naming no parent is. `prs` is `gh pr list`'s
 * `{ number, state }` rows, or null when PR state is unknown (the fit). `stratum`
 * maps a features row to its stratum. Throws `AttributionError` on a features
 * row it cannot date or a booked `cost` or `work_s` it cannot read, and
 * `RulingError` as `rulingFor` does.
 */
export function attribute({ features, members, tiers, prs = null, windowStart = null, stratum = () => null }) {
  const pulls = datedRows(features);
  const omp = ompRows(members);
  // Implementer rows to their Pull, and a PR-named member's key to its PR.
  const { impls, implPull } = bookImplementers(pulls, omp);
  const prOfKey = new Map();
  for (const r of omp) {
    if (isImplementer(r.member)) continue;
    const { pr } = parseMemberName(r.member);
    if (pr) prOfKey.set(key(r.session, r.agent), pr);
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

  // Rulings: each PR's merge to one Pull, carriers first, then the date floor.
  const inWindow = pulls.filter((p) => windowStart === null || p.run_date >= windowStart);
  const rulings = rulingsByTicket(tiers);
  const fileOrder = new Map(tiers.map((t, i) => [t, i]));
  // Each PR to its latest ruling row in file order, whatever its ticket or date.
  const ruleRows = new Set([...rulings.values()].flat());
  const rulingOfPr = new Map(tiers.filter((t) => ruleRows.has(t)).map((t) => [t.pr, t]));
  const ruled = new Map(); // pull -> { pr, ruling, carried }
  const candidates = new Map(); // pr -> [{ pull, ruling }], the Pulls no carrier binding ruled
  for (const p of inWindow) {
    // Called for every Pull, bound or not, so a bad ruling row of its ticket is refused either way.
    const candidate = rulingFor(rulings, p.ticket, p.run_date);
    let bound = null;
    for (const r of impls.get(p)) {
      const row = carrier.get(r.pr) === p ? rulingOfPr.get(r.pr) : undefined;
      if (row && (bound === null || fileOrder.get(row) > fileOrder.get(bound))) bound = row;
    }
    if (bound) {
      // A bound row of another ticket is refused on the same terms as one of the Pull's own.
      for (const t of String(bound.ticket).split("+")) rulingFor(rulings, t, "");
      ruled.set(p, { pr: bound.pr, ruling: bound, carried: true });
    } else if (candidate) (candidates.get(candidate.pr) ?? candidates.set(candidate.pr, []).get(candidate.pr)).push({ pull: p, ruling: candidate });
  }
  const taken = new Set([...ruled.values()].map((r) => r.pr));
  for (const [pr, cands] of candidates) {
    if (taken.has(pr)) continue;
    const ruling = cands.reduce((a, c) => (fileOrder.get(c.ruling) > fileOrder.get(a) ? c.ruling : a), cands[0].ruling);
    ruled.set(cands.at(-1).pull, { pr, ruling, carried: false });
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
    let spend = 0, blank = false, workS = 0, untimed = false;
    for (const m of booked) {
      const c = numberOf(m, "cost");
      if (c === null) blank = true;
      else spend += c;
      const w = numberOf(m, "workS", "work_s");
      if (String(m.agent).includes("/")) continue;
      if (w === null) untimed = true;
      else workS += w;
    }
    const generation = generationOf(own, pull.chosen_cell);
    let status = "counted";
    if (generation === null) status = "excluded";
    else if (pendingPr !== null) status = "pending";
    else if (claims === 0 && own.every((m) => ticketsEnding(m.ending) || NEITHER_ENDINGS.has(m.ending))) status = "left-out";
    else if (blank || (r && !r.carried)) status = "unpriced";
    else if (untimed) status = "untimed";
    return {
      pull, cell: pull.chosen_cell, stratum: stratum(pull), generation, status, merged, pr: r?.pr ?? null, ruling: r?.ruling ?? null,
      pendingPr, claims, falseClaims, rows: booked, spend: blank ? null : spend, workS: untimed ? null : workS,
    };
  });
}

/**
 * Each cell's generations, newest first: cell -> [model, …]. A generation's
 * place is that of its latest Pull, by session id (an omp session id opens
 * with its start time), then by file order, the order of `units`.
 */
export function generations(units) {
  const latest = new Map(); // cell -> Map(generation -> { session, at })
  units.forEach((u, at) => {
    if (!u.generation) return;
    const gens = latest.get(u.cell) ?? latest.set(u.cell, new Map()).get(u.cell);
    const held = gens.get(u.generation);
    if (!held || u.pull.session >= held.session) gens.set(u.generation, { session: u.pull.session, at });
  });
  return new Map([...latest].map(([cell, gens]) => [cell, [...gens]
    .sort(([, a], [, b]) => cmp(b.session, a.session) || b.at - a.at)
    .map(([g]) => g)]));
}

/**
 * Per cell, in cell-name order: `{ cell, generation, n, merged, claims, failed,
 * spend, workS, pulls, excluded, left_out, unpriced, untimed, pending, older }`.
 * `generation` is the cell's newest (null when no Pull of it has one), and the
 * figures beside it are that generation's alone: `n`, `merged`, `claims`,
 * `failed`, `spend` and `workS` (work time, in seconds) over its counted
 * Pulls, `pulls` those counted units themselves in the order of `units`, then
 * its left-out, unpriced, untimed and pending Pull counts.
 * `excluded` counts the cell's excluded Pulls, which have no generation.
 * `older` is an array, newest first, of every other generation's figures in
 * the same shape, each carrying its `generation`. `order` is `generations()`
 * of the units that place each cell's generations; by default these same
 * units, but a caller tallying a subset passes the whole set's, so a subset
 * never moves a cell's newest generation.
 */
export function tally(units, order = generations(units)) {
  // `n` is read off `pulls`, so the count and the list cannot drift apart.
  const figures = (generation) => ({
    generation, get n() { return this.pulls.length; }, merged: 0, claims: 0, failed: 0, spend: 0, workS: 0, pulls: [],
    left_out: 0, unpriced: 0, untimed: 0, pending: 0,
  });
  const cells = new Map();
  for (const u of units) {
    const c = cells.get(u.cell) ?? cells.set(u.cell, { excluded: 0, gens: new Map() }).get(u.cell);
    if (u.status === "excluded") {
      c.excluded++;
      continue;
    }
    const g = u.generation ?? null;
    const f = c.gens.get(g) ?? c.gens.set(g, figures(g)).get(g);
    if (u.status === "counted") {
      if (u.merged) f.merged++;
      f.claims += u.claims;
      f.failed += u.falseClaims;
      f.spend += u.spend;
      f.workS += u.workS;
      f.pulls.push(u);
    } else f[u.status.replace("-", "_")]++;
  }
  return [...cells].sort(([a], [b]) => cmp(a, b)).map(([cell, c]) => {
    const ranked = order.get(cell) ?? [];
    const newest = ranked[0] ?? null;
    const rank = (g) => (ranked.includes(g) ? ranked.indexOf(g) : ranked.length);
    const older = [...c.gens.values()].filter((f) => f.generation !== newest).sort((a, b) => rank(a.generation) - rank(b.generation));
    return { cell, ...(c.gens.get(newest) ?? figures(newest)), excluded: c.excluded, older };
  });
}
