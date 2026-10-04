#!/usr/bin/env node
// The per-cell readout: how many within-session comparisons each implementer
// cell has against the policy cell, and whether that is enough to read it.
//
//   cell-readout.mjs [--ticket-features <tsv>] [--member-outcomes <tsv>]
//
// Inputs default to docs/metrics/ under the working directory. A Pull is a
// ticket-features.tsv row; what it ran is the member-outcomes.tsv row with the
// same `session` + `agent`. Rows of one `session` + `agent` that name one
// `chosen_cell` are one Pull; the readout refuses rows naming different cells,
// naming the file, the session, the agent and both cells, since which cell ran
// is then unknown.
//
// ADMISSIBLE ROW. A Pull counts only when its member row exists, was
// dispatched as the drawn cell's own definition (`subagent_type` =
// `fleet-implementer-<chosen_cell>`), ran at the cell's level (`effort` = the
// cell's `<level>`) and has a resolved `model` on record. So a generic `task`
// dispatch, a clamped effort and every pre-cutover `fleet-implementer` /
// `fleet-implementer-alt` row are never admissible. Whether the resolved model
// was the role's target at dispatch is recorded in neither file; that half of
// the tier check is the run ledger's, not this readout's.
//
// COMPARISON. For a cell X other than slow-high, a comparison is one session
// holding at least one admissible X row and at least one admissible slow-high
// row whose resolved (`model`, `effort`) differ from that X row's. A session
// counts once however many rows it holds, and its date is its member-outcomes
// `run_date`; a blank `run_date` means unknown, so that session is still a
// comparison but adds no date to the distinct-date count.
//
// GATE. A cell is read only once it has at least GATE.comparisons comparisons
// across at least GATE.runDates distinct run_dates. A gated cell prints one
// line on stdout:
//
//   <cell> <comparisons> <run_dates> <resolved models>
//
// `<resolved models>` is the model of every admissible row at the cell — one
// model by name, or `mixed (<model-a> n=…, <model-b> n=…)` when they span more
// than one, because a role's target is operator config that can move under a
// cell's history. A cell below the gate prints nothing on stdout and one
// `below the gate` count on stderr. Neither the gate line nor that count names
// a session, ticket or member: the gate forbids reading a comparison early.
// Only the refusal of conflicting ticket-features rows names a session and an
// agent, and it prints nothing on stdout.
//
// STOPPING RULE (exported as `stoppingRule`, not printed by this CLI). For a
// cell X other than slow-high whose definition is live, a VERDICT is a ticket
// with an admissible Pull at X dated on or after the day X's
// `fleet-implementer-<cell>` definition was most recently added, ruled by its
// last tier-outcomes.tsv row (a `+`-joined `ticket` field rules each ticket
// it names) dated on or after the ticket's last such Pull: a ruling never
// predates the Pull it rules, and a row with both verdict columns blank was
// never ruled, so it is skipped. A ticket with no such row is no verdict.
// A ticket counts once however many Pulls it took. A verdict FAILS
// the quality floor on `minted_false_claim=yes` or `closed_own_ticket=no`; a
// counted ruling holding anything but `yes` or `no` in either column, one
// blank included, is refused rather than read as a pass. So is a non-blank
// ruling row of such a ticket whose `run_date` is not `YYYY-MM-DD`: it cannot
// be placed against the Pull, and dropping it would uncount the ticket.
// X is to be withdrawn once it has at least STOP.verdicts verdicts and
// floor failures ÷ verdicts is at least STOP.failRate.
//
// Exit 0 whatever the counts; 2 on a usage error or an unreadable or
// malformed input, with nothing on stdout.

import { readFileSync } from "node:fs";
import { makeDie, defineFlags } from "./arg.mjs";
import { isCLI } from "./is-cli.mjs";
import { CELL, POLICY_CELL } from "./ledger-grammar.mjs";
import { formatTsv as formatMemberTsv, parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { parseFeatures } from "./pr-cost.mjs";
import { VERDICT, VERDICT_COLUMNS } from "./tier-outcomes.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const NAME = "cell-readout";
export const GATE = Object.freeze({ comparisons: 10, runDates: 5 });
export const STOP = Object.freeze({ verdicts: 10, failRate: 0.8 });

const key = (session, agent) => `${session}\0${agent}`;
const levelOf = (cell) => CELL.exec(cell)?.[2] ?? null;

/**
 * `features` keyed by session+agent. A repeat naming the same `chosen_cell`
 * collapses into the first row; one naming another cell throws.
 */
function pullsOf(features) {
  const pulls = new Map();
  for (const p of features) {
    const k = key(p.session, p.agent);
    const prev = pulls.get(k);
    if (!prev) pulls.set(k, p);
    else if (prev.chosen_cell !== p.chosen_cell) throw new Error(`session ${p.session} agent ${p.agent} has two rows, chosen_cell '${prev.chosen_cell}' and '${p.chosen_cell}'`);
  }
  return pulls;
}

/** The join's member row for a Pull when the Pull is admissible, else null. */
function admissibleMember(pull, members) {
  const m = members.get(key(pull.session, pull.agent));
  if (!m) return null;
  const level = levelOf(pull.chosen_cell);
  if (level === null || m.subagentType !== `fleet-implementer-${pull.chosen_cell}` || m.effort !== level || !m.model) return null;
  return m;
}

// One member row per session+agent. A key repeated with different fields is
// refused rather than collapsed to whichever row came last; an identical
// repeat is one row.
function indexMembers(members) {
  const byKey = new Map();
  for (const m of members) {
    const k = key(m.session, m.agent);
    const held = byKey.get(k);
    if (held && formatMemberTsv([held]) !== formatMemberTsv([m])) {
      throw new Error(`member-outcomes.tsv: session ${m.session} agent ${m.agent} has two rows with different fields`);
    }
    if (!held) byKey.set(k, m);
  }
  return byKey;
}

/**
 * `cells`: one entry per cell other than the policy cell that has a
 * ticket-features row, `{ cell, comparisons, runDates, dates, models, gated }`,
 * sorted by cell. `dates` is the comparisons' distinct run_dates, sorted;
 * `models` maps each resolved model of the cell's admissible rows to its row
 * count, largest first. `unjoined` counts Pulls with no member row. Throws on
 * two ticket-features rows of one session+agent naming different cells, and on
 * a member-outcomes session+agent repeated with different fields.
 */
export function readout({ features, members }) {
  const byKey = indexMembers(members);
  const pulls = pullsOf(features);
  const sessions = new Map();
  const cells = new Map();
  let unjoined = 0;
  for (const p of pulls.values()) {
    if (p.chosen_cell !== POLICY_CELL && !cells.has(p.chosen_cell)) cells.set(p.chosen_cell, new Map());
    if (!byKey.has(key(p.session, p.agent))) unjoined++;
    const m = admissibleMember(p, byKey);
    if (!m) continue;
    if (p.chosen_cell !== POLICY_CELL) cells.get(p.chosen_cell).set(m.model, (cells.get(p.chosen_cell).get(m.model) ?? 0) + 1);
    if (!sessions.has(p.session)) sessions.set(p.session, { runDate: m.run_date, rows: [] });
    sessions.get(p.session).rows.push({ cell: p.chosen_cell, model: m.model, effort: m.effort });
  }

  const out = [...cells].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([cell, modelCounts]) => {
    let comparisons = 0;
    const dates = new Set();
    for (const { runDate, rows } of sessions.values()) {
      const base = rows.filter((r) => r.cell === POLICY_CELL);
      const compared = rows.some((x) => x.cell === cell && base.some((s) => s.model !== x.model || s.effort !== x.effort));
      if (!compared) continue;
      comparisons++;
      if (runDate) dates.add(runDate);
    }
    const models = new Map([...modelCounts].sort(([a, n], [b, k]) => k - n || (a < b ? -1 : a > b ? 1 : 0)));
    const runDates = dates.size;
    return { cell, comparisons, runDates, dates: [...dates].sort(), models, gated: comparisons >= GATE.comparisons && runDates >= GATE.runDates };
  });
  return { cells: out, unjoined };
}

/**
 * One entry per cell named in `added` (cell → the `YYYY-MM-DD` its definition
 * was most recently added) other than the policy cell, sorted by cell:
 * `{ cell, since, verdicts, failures, stop }`. `verdicts` is
 * `[{ ticket, pr, run_date, closed_own_ticket, minted_false_claim, failed }]`
 * sorted by ticket, `run_date` the ruling's; `stop` is whether the stopping
 * rule withdraws the cell. `verdicts` are parsed tier-outcomes.tsv rows.
 * Throws on a counted ruling whose `closed_own_ticket` or `minted_false_claim`
 * is not `yes` or `no`, and on a non-blank ruling row of a Pulled ticket whose
 * `run_date` is not `YYYY-MM-DD`.
 */
export function stoppingRule({ features, members, verdicts, added }) {
  const byKey = new Map(members.map((m) => [key(m.session, m.agent), m]));
  const rulings = new Map();
  for (const v of verdicts) {
    if (VERDICT_COLUMNS.every((c) => v[c] === "")) continue;
    for (const t of String(v.ticket).split("+")) (rulings.get(t) ?? rulings.set(t, []).get(t)).push(v);
  }
  // Per cell, each ticket's last admissible Pull: the one its ruling must follow.
  const charged = new Map(Object.keys(added).filter((c) => c !== POLICY_CELL).map((c) => [c, new Map()]));
  for (const p of features) {
    const pulls = charged.get(p.chosen_cell);
    if (!pulls || p.run_date < added[p.chosen_cell] || !admissibleMember(p, byKey)) continue;
    pulls.set(p.ticket, p);
  }
  return [...charged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([cell, pulls]) => {
    const list = [];
    for (const p of pulls.values()) {
      const own = rulings.get(p.ticket) ?? [];
      for (const r of own) {
        if (!ISO_DATE.test(r.run_date)) throw new Error(`ticket #${p.ticket} (PR #${r.pr}): run_date is '${r.run_date}', expected YYYY-MM-DD`);
      }
      const v = own.findLast((r) => r.run_date >= p.run_date);
      if (!v) continue;
      for (const c of VERDICT_COLUMNS) {
        if (!VERDICT.includes(v[c])) throw new Error(`ticket #${p.ticket} (PR #${v.pr}): ${c} is '${v[c]}', expected yes or no`);
      }
      list.push({
        ticket: p.ticket, pr: v.pr, run_date: v.run_date,
        closed_own_ticket: v.closed_own_ticket, minted_false_claim: v.minted_false_claim,
        failed: v.minted_false_claim === "yes" || v.closed_own_ticket === "no",
      });
    }
    list.sort((a, b) => Number(a.ticket) - Number(b.ticket));
    const failures = list.filter((v) => v.failed).length;
    const stop = list.length >= STOP.verdicts && failures / list.length >= STOP.failRate;
    return { cell, since: added[cell], verdicts: list, failures, stop };
  });
}

// Only a gated cell is formatted, and a comparison needs an admissible row at
// the cell, so `models` is never empty here.
function formatModels(models) {
  if (models.size === 1) return [...models.keys()][0];
  return `mixed (${[...models].map(([m, n]) => `${m} n=${n}`).join(", ")})`;
}

function main() {
  const die = makeDie(NAME);
  const { arg, sweep, stray } = defineFlags(die, {
    flags: { "ticket-features": "value", "member-outcomes": "value" },
  });
  sweep();
  stray();
  const featuresPath = arg("ticket-features") ?? "docs/metrics/ticket-features.tsv";
  const membersPath = arg("member-outcomes") ?? "docs/metrics/member-outcomes.tsv";
  const load = (path, parse) => {
    let text;
    try { text = readFileSync(path, "utf8"); }
    catch (e) { die(`cannot read ${path}: ${e.code ?? e.message}`); }
    try { return parse(text); }
    catch (e) { die(`${path}: ${e.message}`); }
  };
  // A repeated session+agent naming different cells is refused while the file
  // is loaded, so the refusal names the path that was read.
  const features = load(featuresPath, (text) => {
    const rows = parseFeatures(text);
    pullsOf(rows);
    return rows;
  });
  const members = load(membersPath, parseMemberTsv);

  let result;
  try { result = readout({ features, members }); }
  catch (e) { die(e.message); }
  const { cells, unjoined } = result;
  const lines = [];
  const notes = [];
  if (unjoined > 0) {
    notes.push(`${unjoined} ticket-features row${unjoined === 1 ? " has" : "s have"} no member-outcomes row — never admissible`);
  }
  if (cells.length === 0) notes.push(`no cell other than ${POLICY_CELL} has a ticket-features row`);
  for (const c of cells) {
    if (c.gated) lines.push(`${c.cell} ${c.comparisons} ${c.runDates} ${formatModels(c.models)}`);
    else notes.push(`${c.cell} below the gate: ${c.comparisons} comparisons across ${c.runDates} run_dates (needs ${GATE.comparisons} across ${GATE.runDates})`);
  }
  for (const n of notes) process.stderr.write(`${NAME}: ${n}\n`);
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
}

if (isCLI(import.meta.url)) main();
