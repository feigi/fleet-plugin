#!/usr/bin/env node
// The per-cell readout: how many within-session comparisons each implementer
// cell has against the policy cell, and whether that is enough to read it.
//
//   cell-readout.mjs [--ticket-features <tsv>] [--member-outcomes <tsv>]
//
// Inputs default to docs/metrics/ under the working directory. A Pull is a
// ticket-features.tsv row; what it ran is the member-outcomes.tsv row with the
// same `session` + `agent`.
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
// `run_date`.
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
// `below the gate` count on stderr. Nothing on either stream names a session,
// ticket or member: the gate forbids reading a comparison early.
//
// Exit 0 whatever the counts; 2 on a usage error or an unreadable or
// malformed input, with nothing on stdout.

import { readFileSync } from "node:fs";
import { makeDie, defineFlags } from "./arg.mjs";
import { isCLI } from "./is-cli.mjs";
import { CELL, POLICY_CELL } from "./ledger-grammar.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { parseFeatures } from "./pr-cost.mjs";

const NAME = "cell-readout";
export const GATE = Object.freeze({ comparisons: 10, runDates: 5 });

const key = (session, agent) => `${session}\0${agent}`;
const levelOf = (cell) => CELL.exec(cell)?.[2] ?? null;

/** The join's member row for a Pull when the Pull is admissible, else null. */
function admissibleMember(pull, members) {
  const m = members.get(key(pull.session, pull.agent));
  if (!m) return null;
  const level = levelOf(pull.chosen_cell);
  if (level === null || m.subagentType !== `fleet-implementer-${pull.chosen_cell}` || m.effort !== level || !m.model) return null;
  return m;
}

/**
 * One entry per cell other than the policy cell that has a ticket-features
 * row: `{ cell, comparisons, runDates, models, gated }`, sorted by cell.
 * `models` maps each resolved model of the cell's admissible rows to its row
 * count, largest first. `unjoined` counts Pulls with no member row.
 */
export function readout({ features, members }) {
  const byKey = new Map(members.map((m) => [key(m.session, m.agent), m]));
  // One Pull per session+agent: a re-dispatch lands on the same cell and the
  // same member row.
  const pulls = new Map(features.map((p) => [key(p.session, p.agent), p]));
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
      dates.add(runDate);
    }
    const models = new Map([...modelCounts].sort(([a, n], [b, k]) => k - n || (a < b ? -1 : a > b ? 1 : 0)));
    const runDates = dates.size;
    return { cell, comparisons, runDates, models, gated: comparisons >= GATE.comparisons && runDates >= GATE.runDates };
  });
  out.unjoined = unjoined;
  return out;
}

export function formatModels(models) {
  if (models.size === 0) return "-";
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
  const features = load(featuresPath, parseFeatures);
  const members = load(membersPath, parseMemberTsv);

  const cells = readout({ features, members });
  const lines = [];
  const notes = [];
  if (cells.unjoined > 0) {
    notes.push(`${cells.unjoined} ticket-features row${cells.unjoined === 1 ? " has" : "s have"} no member-outcomes row — never admissible`);
  }
  if (cells.length === 0) notes.push(`no cell but ${POLICY_CELL} has a ticket-features row`);
  for (const c of cells) {
    if (c.gated) lines.push(`${c.cell} ${c.comparisons} ${c.runDates} ${formatModels(c.models)}`);
    else notes.push(`${c.cell} below the gate: ${c.comparisons} comparisons across ${c.runDates} run_dates (needs ${GATE.comparisons} across ${GATE.runDates})`);
  }
  for (const n of notes) process.stderr.write(`${NAME}: ${n}\n`);
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
}

if (isCLI(import.meta.url)) main();
