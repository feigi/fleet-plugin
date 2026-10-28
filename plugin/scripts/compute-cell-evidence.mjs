// The cockpit's Cell evidence tab, as a value: computeCellEvidence() turns what
// gather() read (the cost guard, the receipts' `metrics` steps, the installed
// definitions, the carried `modelRoles` read) into the model the page lays out.
// Pure, like compute-board.mjs, which calls it and puts the answer in
// `board.json` as `cellEvidence`: no file, no process, no clock. Every word the
// tab shows is built here, so a test pins it where it is made and the page only
// places it.
//
// What this part holds is the guard section: what the cost guard holds each
// implementer Cell to, from the guard file and nothing recomputed, and "Declared,
// not measured". Figures show only from a guard `readCostGuard` (fleet-tick.mjs,
// the reader the tick judges the file by) accepts; `guard` here is that reader's
// own answer, `{ status: "ok", guard }` or `{ status: "missing" | "unreadable" }`.
//
// A figure the guard file lacks reads "not checked", never 0: the file written
// before the per-Cell counts existed carries only `n`, `mean_usd`, `fail_rate`
// and `untimed` per Cell, and each count the file does not carry is named as not
// checked where its figure would show.

import { CELL } from "./ledger-grammar.mjs";
import { implementerCell, modelsEqual, parseModelRoute, resolveRole } from "./tier-roles.mjs";

// The implementer Cells, in the order the guard section draws them. All five are
// drawn in every state: a card or a rescue can name any of them, and no link may
// point at nothing. A Cell the guard holds beyond these is drawn after them
// rather than left out.
export const CELLS = Object.freeze(["slow-high", "task-high", "smol-high", "slow-medium", "task-max"]);

const MINUS = "−";
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const superscript = (n) => String(n).replace(/\d/g, (d) => SUPERSCRIPT[d]);

// A figure's count, or null when the file does not carry it as one.
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// An ISO time, or epoch milliseconds, to the minute; a string that is no time as it came.
function when(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

// A difference in tenths, with its sign: the minus is U+2212, as in the spec's own
// figures. Rounded half away from zero, so −43.75 reads −43.8 as +43.75 reads +43.8.
const tenths = (x) => Math.sign(x) * Math.round(Math.abs(x) * 10);
const signed = (t, unit) => `${t < 0 ? MINUS : "+"}${(Math.abs(t) / 10).toFixed(1)}${unit}`;
// failed/claims in tenths of a percent, off the counts, and as a percentage to one place.
const rateTenths = (failed, claims) => Math.round((failed * 1000) / claims);
const ratePct = (failed, claims) => (rateTenths(failed, claims) / 10).toFixed(1);
// A rate the guard file stored, 0–1, as a percentage to one place.
const storedPct = (rate) => `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;

// The generation a model identity names, put on the scale of a judged
// generation, which member-outcomes.mjs's dispatchModel strips of its provider
// and its level: this drops the provider only, so the model it is handed must
// already be level-free, as resolveRole's answer is.
const generationOf = (model) => String(model).split("/").at(-1);

// ---------------------------------------------------------------------------
// The Tier route: the cockpit's own `modelRoles`, a carried `{ value, readAt, error }`.
// ---------------------------------------------------------------------------

// What the carried read says about itself, for the heading and beside each Tier
// route: null while the last read stands, else the words for a failing or an unread one.
function readLabel(modelRoles) {
  const failure = modelRoles?.error ?? null;
  if (modelRoles?.value == null) {
    return failure === null
      ? "not checked: modelRoles not read yet"
      : `not checked: modelRoles not read yet; reading fails: ${failure.message}`;
  }
  return failure === null ? null : `as read at ${when(modelRoles.readAt)}; reading fails: ${failure.message}`;
}

// The model `<role>` resolves to under the carried read: a model name, `null`
// when the role is unset, `undefined` when there is no read to ask.
function routeModel(role, modelRoles) {
  if (!isRecord(modelRoles?.value)) return undefined;
  return resolveRole(role, modelRoles.value);
}

// "Tier route: <model> · <level>" for a role and a level, and what it cannot be
// compared with. `generation` is the generation the Cell is judged on, when it has one.
function tierRoute(role, level, generation, modelRoles) {
  const label = readLabel(modelRoles);
  const model = routeModel(role, modelRoles);
  if (model === undefined) return { model: null, text: "Tier route: not checked", label, flag: null };
  if (model === null) return { model: null, text: `modelRoles.${role} unset: omp picks the model`, label, flag: "not checked" };
  const differs = generation != null && !modelsEqual(model, generation);
  return {
    model,
    text: `Tier route: ${model} · ${level}`,
    label,
    flag: differs ? "⚑ differs from the judged generation" : null,
  };
}

// ---------------------------------------------------------------------------
// No guard: the newest `metrics` step of the phase 0 and close-out receipts.
// ---------------------------------------------------------------------------

// `step` is `{ status, at, output }` or null. A step that has not run carries no
// refresh to quote.
const ran = (step) => step != null && step.status !== "pending" && Number.isFinite(Date.parse(step.at));

// metrics-refresh's own line from a step's output: the cost-guard duty's, else
// the last of its lines, else the output's first line. Its own prefix, the
// "skipped," and the note that the file was left as it was are dropped; the rest
// is quoted as written. Found anywhere in a line, not at its start: a failed
// close-out step glues its headline to the first line of the script's output.
function refreshLine(output) {
  const text = String(output ?? "");
  const own = /metrics-refresh: cost guard( failed)?: ([^\n]*)/.exec(text);
  const last = [...text.matchAll(/metrics-refresh: ([^\n]*)/g)].at(-1);
  const line = own ? (own[1] ? own[2] : own[2].replace(/^skipped, /, "")) : last ? last[1] : text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().replace(/; \S*cost-guard\.json left as it is$/, "");
}

// The newest `metrics` step of the two receipts, with the verb its status and
// line give it: `{ verb, at, why }`, or null when neither receipt has run one.
function newestRefresh(receipts) {
  const steps = [receipts?.phase0, receipts?.closeout].filter(ran);
  if (steps.length === 0) return null;
  const step = steps.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
  const why = refreshLine(step.output);
  const verb = step.status === "failed" ? "failed" : /metrics-refresh: cost guard: skipped,/.test(step.output ?? "") ? "skipped" : "ran";
  return { verb, at: step.at, why };
}

// ---------------------------------------------------------------------------
// The guard section.
// ---------------------------------------------------------------------------

// The per-Cell fields the guard file gained, by the words that name them in a label.
const FIELD_WORDS = [
  ["n_claims", "claim counts"], ["n_failed", "failure counts"], ["by_hand", "by-hand count"], ["left_out", "left-out count"],
  ["pending", "pending count"], ["excluded", "no-Admissible-row count"], ["unpriced", "unpriced count"], ["untimed", "untimed count"],
];

// Merged PRs against `min_n`. A Cell is judged only while the baseline has
// `min_n` merged PRs itself: below that the guard holds nothing back, whatever a
// Cell's own n.
function mergedFigure(e, g, isBase) {
  const n = e.n;
  const min = g.min_n;
  const base = g.baseline.cell;
  const judged = isBase || g.verdict !== "none";
  const text = n >= min
    ? judged ? `${n} ≥ ${min} ✓` : `${n} ≥ ${min}: not judged until ${base} has ${min}`
    : `${n} of ${min}: not judged`;
  const beside = [];
  const unchecked = [];
  for (const [key, words] of [["left_out", "left out"], ["pending", "pending"]]) {
    const k = count(e[key]);
    if (k === null) unchecked.push(words);
    else if (k > 0) beside.push(`${k} ${words}`);
  }
  return { text, beside, unchecked };
}

// The fail rate with its gap to the baseline's and to the floor, worked from the
// claim and failure counts. Whole counts and the integer cross-product are what
// the guard itself judges by (`underFloor`), so a gap near the floor reads the
// way the guard rules; a rounded rate never enters it.
function failFigure(e, g, baseEntry, isBase) {
  const claims = count(e.n_claims);
  const failed = count(e.n_failed);
  const trip = count(g.trip_points);
  const base = g.baseline.cell;
  const beside = [];
  const hand = count(e.by_hand);
  if (hand === null) beside.push("Rulings given by hand: not checked");
  else if (hand > 0) beside.push(`${hand} of ${e.n} Rulings given by hand`);

  if (claims === null || failed === null) {
    const stored = typeof e.fail_rate === "number" ? storedPct(e.fail_rate) : null;
    return { text: stored === null ? "no fail rate yet" : `${stored} · gap and floor: not checked`, beside };
  }
  if (claims === 0) return { text: "no fail rate yet: no claims", beside };
  const rate = `${ratePct(failed, claims)}%`;
  if (isBase) {
    return { text: trip === null ? `${rate} · the floor: not checked` : `${rate} · the floor is ${((rateTenths(failed, claims) + trip * 10) / 10).toFixed(1)}%`, beside };
  }
  const bClaims = count(baseEntry?.n_claims);
  const bFailed = count(baseEntry?.n_failed);
  if (bClaims === null || bFailed === null) return { text: `${rate} · gap: not checked: ${base} has no counts`, beside };
  if (bClaims === 0) return { text: `${rate} · no gap: ${base} has no claims`, beside };
  // (failed/claims − bFailed/bClaims) × 100, from the counts.
  const num = (failed * bClaims - bFailed * claims) * 100;
  const den = claims * bClaims;
  const gap = signed(tenths(num / den), " pts");
  if (trip === null) return { text: `${rate} · ${gap} on ${base} · the floor: not checked`, beside };
  const margin = (trip * den - num) / den;
  const floor = margin > 0 ? `${(tenths(margin) / 10).toFixed(1)} pts inside the floor` : `${(tenths(-margin) / 10).toFixed(1)} pts past the floor`;
  return { text: `${rate} · ${gap} on ${base} · ${floor}`, beside };
}

// $ per merged PR, against the baseline's.
function usdFigure(e, g, isBase) {
  const base = g.baseline.cell;
  if (typeof e.mean_usd !== "number") return { text: "no merged PR yet: no $ per merged PR" };
  const usd = `$${e.mean_usd.toFixed(2)}`;
  if (isBase) return { text: usd };
  const b = g.baseline.mean_usd;
  if (typeof b !== "number" || b === 0) return { text: `${usd} · no comparison: ${base} has no $ per merged PR` };
  return { text: `${usd} · ${signed(tenths(((e.mean_usd - b) / b) * 100), "%")} on ${base}` };
}

// An older generation's figures: printed, never compared, so no gap, no floor,
// no judged mark. The same counts are not repeated: only what it merged, how it failed and what it cost.
function olderRow(cell, o) {
  const n = count(o.n_merged) ?? count(o.n);
  const claims = count(o.n_claims);
  const failed = count(o.n_failed);
  const rate = claims === null || failed === null
    ? typeof o.fail_rate === "number" ? storedPct(o.fail_rate) : "no fail rate yet"
    : claims === 0 ? "no fail rate yet" : `${ratePct(failed, claims)}%`;
  return {
    generation: o.generation,
    anchor: `cell-${cell}@${o.generation}`,
    mark: "not judged",
    merged: n === null ? "merged PRs: not checked" : `${n} merged PRs`,
    failRate: rate,
    usd: typeof o.mean_usd === "number" ? `$${o.mean_usd.toFixed(2)}` : "no $ per merged PR",
  };
}

// The footnotes one entry's figure needs: the sentence under the section and the
// mark on the figure. The middle column is the words the merged figure names as
// "not checked" when the file does not carry that count.
const NOTES = [
  ["excluded", "no Admissible row", (cell, k) => `${cell}: ${k} drawn here have no Admissible row: they ran under another Cell, at another effort, or with no model on record, so they count in no Cell's figures`],
  ["unpriced", "unpriced", (cell, k) => `${cell}: ${k} unpriced: part of their Spend can't be booked`],
  ["untimed", "untimed", (cell, k) => `${cell}: ${k} untimed: a member's work time isn't on record`],
];

function footnotesFor(cell, e, notes) {
  const marks = [];
  const unchecked = [];
  for (const [key, words, text] of NOTES) {
    const k = count(e[key]);
    if (k === null) unchecked.push(words);
    else if (k > 0) {
      const mark = superscript(notes.length + 1);
      notes.push({ mark, text: text(cell, k) });
      marks.push(mark);
    }
  }
  return { marks, unchecked };
}

// One Cell's entry: its header line, its three figures (or "no figures yet"), its older generations.
function guardEntry(cell, g, byCell, modelRoles, notes) {
  const e = byCell.get(cell) ?? null;
  const isBase = cell === g.baseline.cell;
  const parsed = CELL.exec(cell);
  const [role, level] = parsed ? [parsed[1], parsed[2]] : [null, null];
  const generation = e !== null && typeof e.generation === "string" && e.generation !== "" ? e.generation : null;
  const route = role === null
    ? { model: null, text: "no Tier route: not a Cell the fleet defines", label: null, flag: null }
    : tierRoute(role, level, generation, modelRoles);
  const entry = {
    cell,
    anchor: `cell-${cell}`,
    baseline: isBase,
    judged: generation === null ? null : `judged on ${generation}`,
    route,
    figures: null,
    none: null,
    older: e !== null && Array.isArray(e.older)
      ? e.older.filter((o) => isRecord(o) && typeof o.generation === "string" && o.generation !== "").map((o) => olderRow(cell, o))
      : [],
  };

  if (generation === null) {
    // No figures: not in the guard, or in it with no Pull that has a generation.
    const model = route.model === null ? null : generationOf(route.model);
    const marks = e === null ? [] : footnotesFor(cell, e, notes).marks;
    entry.none = {
      text: `no figures yet for ${model ?? cell}`,
      generation: model,
      anchor: model === null ? null : `cell-${cell}@${model}`,
      marks,
    };
    return entry;
  }

  const baseEntry = byCell.get(g.baseline.cell) ?? null;
  const merged = mergedFigure(e, g, isBase);
  const { marks, unchecked } = footnotesFor(cell, e, notes);
  const checks = [...merged.unchecked, ...unchecked];
  entry.figures = {
    generation,
    anchor: `cell-${cell}@${generation}`,
    merged: { text: merged.text, beside: [...merged.beside, ...(checks.length ? [`${checks.join(", ")}: not checked`] : [])], marks },
    failRate: failFigure(e, g, baseEntry, isBase),
    usd: usdFigure(e, g, isBase),
  };
  return entry;
}

// The verdict state's words and the source line under them.
function guardHeading(g) {
  const state = g.verdict === "none" ? "holds-nothing-back" : g.verdict === "tripped" ? "trips" : "trips-nothing";
  const heading = state === "holds-nothing-back"
    ? `holds no Cell back until ${g.baseline.cell} has ${g.min_n} merged PRs: it has ${g.baseline.n}`
    : state === "trips" ? `trips ${g.tripped.join(", ")}` : "trips nothing";
  const trip = count(g.trip_points);
  const source = [
    "this repository's runs",
    `computed ${when(g.computed_at)}`,
    typeof g.window_start === "string" ? `window from ${g.window_start}` : "window: not checked",
    `min ${g.min_n} merged PRs`,
    trip === null ? "floor: not checked" : `floor ${trip} pts over ${g.baseline.cell}`,
  ].join(" · ");
  return { state, heading, source };
}

function guardSection(read, receipts, modelRoles) {
  const label = readLabel(modelRoles);
  const refresh = newestRefresh(receipts);
  const notes = [];
  const footnotes = [];

  if (read?.status !== "ok") {
    // No guard the tick's reader accepts: never an alert. A refresh that fails
    // every time, a fresh workspace and a lost file are all this state.
    if (read?.status === "unreadable") notes.push(`cost-guard.json unreadable: ${read.why}`);
    notes.push(refresh === null
      ? receipts?.phase0 == null && receipts?.closeout == null
        ? "no phase 0 or close-out receipt here"
        : "no metrics refresh has run in the receipts here"
      : `${refresh.verb} at ${when(refresh.at)}: ${refresh.why}`);
    if (label !== null) notes.push(label);
    const byCell = new Map();
    const stub = { baseline: { cell: "slow-high" } };
    return {
      state: "no-guard",
      heading: "no cost guard",
      source: null,
      notes,
      cells: CELLS.map((cell) => guardEntry(cell, stub, byCell, modelRoles, footnotes)),
      footnotes,
    };
  }

  const g = read.guard;
  const { state, heading, source } = guardHeading(g);
  const byCell = new Map(g.cells.map((c) => [c.cell, c]));
  const order = [...CELLS, ...g.cells.map((c) => c.cell).filter((c) => !CELLS.includes(c))];
  const cells = order.map((cell) => guardEntry(cell, g, byCell, modelRoles, footnotes));

  const missing = FIELD_WORDS.filter(([key]) => g.cells.some((c) => count(c[key]) === null)).map(([, words]) => words);
  if (missing.length > 0) notes.push(`not checked: this guard predates the ${missing.join(", ")}`);
  if (refresh !== null && refresh.verb === "failed" && Date.parse(refresh.at) > Date.parse(g.computed_at)) {
    notes.push(`the newest refresh failed at ${when(refresh.at)}: ${refresh.why}; these figures are from ${when(g.computed_at)}`);
  }
  if (label !== null) notes.push(label);
  return { state, heading, source, notes, cells, footnotes };
}

// ---------------------------------------------------------------------------
// Declared, not measured.
// ---------------------------------------------------------------------------

// Every definition but the implementer Cells', each with its Declared tier and
// the Tier route that tier resolves to under the cockpit's own `modelRoles`.
// `agents` is `{ list: [{ file, model }], error }`; `error` is why the
// definitions could not be listed, and then there is no list to count.
function declaredSection(agents, modelRoles) {
  if (agents?.error) {
    return { heading: `Declared, not measured: the definitions could not be read: ${agents.error}`, members: [] };
  }
  const members = (agents?.list ?? [])
    .filter((a) => implementerCell(a.file) === null)
    .map((a) => {
      const name = a.file.replace(/\.agent\.md$/, "");
      const declared = typeof a.model === "string" ? a.model.replace(/^(["'])(.*)\1$/, "$2") : null;
      const { role, level } = parseModelRoute(declared);
      let route;
      if (declared === null) route = "no Declared tier";
      else if (role === null) route = "Declared tier is not a route";
      else {
        const model = routeModel(role, modelRoles);
        route = model === undefined ? "not checked" : model === null ? `modelRoles.${role} unset: omp picks the model` : `${model} · ${level}`;
      }
      return { name, declared, route };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const n = members.length;
  return { heading: `Declared, not measured: ${n} other member${n === 1 ? "" : "s"}`, members };
}

/**
 * The Cell evidence tab's model. `guard` is `readCostGuard`'s answer, `receipts`
 * is `{ phase0, closeout }`, each the receipt's `metrics` step `{ status, at,
 * output }` or null, `agents` is `{ list: [{ file, model }], error }`, and
 * `modelRoles` the carried `{ value, readAt, error }` or null — `error` being
 * `{ at, message }`. An input left out reads as nothing read: a missing guard,
 * no receipt, no definitions, no `modelRoles` read.
 */
export function computeCellEvidence({ guard, receipts, agents, modelRoles = null }) {
  return {
    guard: guardSection(guard, receipts, modelRoles),
    declared: declaredSection(agents, modelRoles),
  };
}
