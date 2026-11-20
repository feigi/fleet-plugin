// Why the cost guard tripped a Cell, and which Objective a reason holds a Cell
// back under. One table for the guard that writes the reasons (pr-cost.mjs) and
// every reader of its `tripped` entries: the router, the tick and the cockpit.
//
// A `tripped` entry is `{ cell, on: [<reason>, …] }`. A bare Cell name, or an
// entry whose `on` is null, was written before a trip recorded its reasons: it
// holds the Cell back under every Objective, as every trip did then, and has
// no reasons to name.
//
// Zero deps: sibling modules only.

import { CELL } from "./ledger-grammar.mjs";

/** The reasons, in the order an entry lists them. */
export const TRIP_REASONS = Object.freeze(["floor", "usd", "minutes"]);

/** The reasons each Objective holds a Cell back on: `cost` leaves out a dearer Cell, `speed` a slower one; both a Cell under the floor. */
export const EXCLUDED_ON = Object.freeze({
  cost: Object.freeze(["floor", "usd"]),
  speed: Object.freeze(["floor", "minutes"]),
});

/**
 * Why `raw`, one entry of a guard's `tripped`, is no entry, or null when it is one: a Cell name, or `{ cell, on }`
 * with `cell` a Cell and `on` a non-empty list of reasons when it is present and not null. An empty `on` would hold
 * its Cell back under neither Objective while the guard's verdict still reads `tripped`.
 */
export function tripFault(raw) {
  const cell = typeof raw === "string" ? raw : raw?.cell;
  if (typeof cell !== "string" || !CELL.test(cell)) return `\`tripped\` names ${JSON.stringify(raw)}, which is not a Cell`;
  if (typeof raw !== "string" && raw.on != null && (!Array.isArray(raw.on) || raw.on.length === 0 || !raw.on.every((r) => TRIP_REASONS.includes(r)))) {
    return `\`tripped\` names ${cell} on ${JSON.stringify(raw.on)}, which is not a list of ${TRIP_REASONS.join(", ")}`;
  }
  return null;
}

/** `raw` as `{ cell, on }`, `on` null for an entry that records none. Call only on an entry tripFault accepts. */
export const tripEntry = (raw) => (typeof raw === "string" ? { cell: raw, on: null } : { cell: raw.cell, on: raw.on == null ? null : [...new Set(raw.on)] });

/** Whether `entry` (tripEntry's) holds its Cell back under `objective`: on a reason the Objective excludes, or on none recorded. */
export const excludedUnder = (entry, objective) => entry.on === null || entry.on.some((r) => EXCLUDED_ON[objective].includes(r));

/** The Cells of `entries` (tripEntry's, or any entry tripFault accepts) that `objective` holds back, sorted, each once. */
export const excludedCells = (entries, objective) => [...new Set(entries.map(tripEntry).filter((e) => excludedUnder(e, objective)).map((e) => e.cell))].sort();

/** `entry` (tripEntry's) in words: the Cell, then its reasons in parentheses when it records any. */
export const tripWords = (entry) => (entry.on === null || entry.on.length === 0 ? entry.cell : `${entry.cell} (${entry.on.join(", ")})`);
