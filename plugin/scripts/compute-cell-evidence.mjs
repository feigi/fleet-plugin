// The cockpit's Cell evidence tab, as a value: computeCellEvidence() turns what
// gather() read (the cost guard, the receipts' `metrics` steps, the installed
// definitions, the starting router table, the carried `modelRoles` and model
// catalog reads, the Fit) into the model the page lays out.
// Pure, like compute-board.mjs, which calls it and puts the answer in
// `board.json` as `cellEvidence`: no file, no process, no clock. Every word the
// tab shows is built here, so a test pins it where it is made and the page only
// places it.
//
// What this holds is the guard section — what the cost guard holds each
// implementer Cell to, from the guard file and nothing recomputed, with this
// run's Pulls booked to each Cell off the board's cards — "Declared, not
// measured", and one view of the Fit that routes this run: the table `route`
// routes by, which is the Fit beside the guard (`.fleet/router-fit.json`, which
// metrics-refresh.mjs writes at phase 0), or the starting table while that Fit
// is missing, unreadable or invalid. For each Objective × group of its tree it
// lays out the Cell the table plus the workspace's guard route to and why
// (ticket-router.mjs's rowDispatch, the function `route` itself calls), with
// every candidate's verdict and range, and for each group the Cells it draws
// over; above them, burn-in progress, the Cells the guard has tripped and,
// apart from them, the Cells the install does not run (each with its role, the
// model the role resolves to and the levels that model runs), a notice
// for each starting Cell whose model changed and restarted burn-in, and a flag
// while the newest refit failed and an older Fit, or the starting table, routes.
// The receipts' newest `metrics` step is what the guard section quotes when there
// is no guard; the newest one that tried a refit is where that flag is read.
// Figures show only from a guard `readCostGuard` (fleet-tick.mjs, the reader
// the tick judges the file by) accepts; `guard` here is that reader's own
// answer, `{ status: "ok", guard }` or
// `{ status: "missing" | "unreadable" }`.
//
// A figure the guard file lacks reads "not checked", never 0: the file written
// before the per-Cell counts existed carries only `n`, `mean_usd`, `fail_rate`
// and `untimed` per Cell, and each count the file does not carry is named as not
// checked where its figure would show.

import { isDeepStrictEqual } from "node:util";
import { CELL, OBJECTIVES, POLICY_CELL, STARTING_CELLS } from "./ledger-grammar.mjs";
import { costGuardFault } from "./fleet-tick.mjs";
import { MIN_N, defaultCellOf, installOf, parseGuard, readGuard, rowDispatch, startingCellsOf, unrunnableCells } from "./ticket-router.mjs";
import { implementerCell, modelsEqual, parseModelRoute, resolveRole } from "./tier-roles.mjs";

// The implementer Cells, in the order the guard section draws them: one per
// definition, every role × level from low to max. All of them are drawn in
// every state: a card or a rescue can name any of them, and no link may point
// at nothing. The five Cells that had definitions first keep their order; the
// rest follow by role (slow, task, smol), each role's levels low to max. A
// Cell the guard holds beyond these is drawn after them rather than left out.
export const CELLS = Object.freeze([
  "slow-high", "task-high", "smol-high", "slow-medium", "task-max",
  "slow-low", "slow-xhigh", "slow-max",
  "task-low", "task-medium", "task-xhigh",
  "smol-low", "smol-medium", "smol-xhigh", "smol-max",
]);

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
// The newest `metrics` step of the phase 0 and close-out receipts: the guard
// section quotes it when there is no guard. The view of the Fit reads a failed
// refit off the newest one that tried a refit instead.
// ---------------------------------------------------------------------------

// `step` is `{ status, at, output }` or null. A step that has not run carries no
// refresh to quote.
const ran = (step) => step != null && step.status !== "pending" && Number.isFinite(Date.parse(step.at));

// The newest of `steps` by `at`; on equal times, the first. Null for none.
const newest = (steps) => (steps.length === 0 ? null : steps.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a)));

// The newest `metrics` step of the two receipts that has run, by `at`; on equal
// times, phase 0's. Null when neither receipt has run one.
function newestStep(receipts) {
  return newest([receipts?.phase0, receipts?.closeout].filter(ran));
}

// The newest `metrics` step of the two receipts that tried a refit — its output
// carries a `metrics-refresh: fit:` line — picked as newestStep picks. A
// close-out's step, which runs with `--no-fit` and computes no Fit, and a step
// that stopped before its refit tried none, so neither hides an earlier
// failure. Null when neither receipt's step tried one.
function newestRefit(receipts) {
  return newest([receipts?.phase0, receipts?.closeout].filter((s) => ran(s) && /metrics-refresh: fit: /.test(String(s.output ?? ""))));
}

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

// The newest `metrics` step, with the verb its status and line give it:
// `{ verb, at, why }`, or null when neither receipt has run one.
function newestRefresh(step) {
  if (step === null) return null;
  const why = refreshLine(step.output);
  const verb = step.status === "failed" ? "failed" : /metrics-refresh: cost guard: skipped,/.test(step.output ?? "") ? "skipped" : "ran";
  return { verb, at: step.at, why };
}

// Why the Fit failed, off a `metrics` step's output: the rest of
// metrics-refresh's `fit: failed — ` line, trimmed, or null when the output
// has none. Found anywhere in a line, as refreshLine finds its own.
export function refitFailure(output) {
  const m = /metrics-refresh: fit: failed — ([^\n]*)/.exec(String(output ?? ""));
  return m === null ? null : m[1].trim();
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
// Cell's own n. A Cell the guard lists `unmatched` has `min_n` of its own but is
// short of them, on its side or the baseline's, in the stretches both were drawn
// in, so it was not judged either.
function mergedFigure(e, g, isBase) {
  const n = e.n;
  const min = g.min_n;
  const base = g.baseline.cell;
  const unmatched = !isBase && Array.isArray(g.unmatched) && g.unmatched.includes(e.cell);
  const judged = isBase || (g.verdict !== "none" && !unmatched);
  const text = n >= min
    ? judged ? `${n} ≥ ${min} ✓`
      : unmatched ? `${n} ≥ ${min}: not judged, under ${min} on a side in the stretches shared with ${base}`
        : `${n} ≥ ${min}: not judged until ${base} has ${min}`
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
// claim and failure counts of the Cell's whole generation. Whole counts and the
// integer cross-product are what the guard itself judges by, so a rounded rate
// never enters it. The guard holds a Cell to the baseline only over the stretches
// both were drawn in, so a gap read from the whole generations can differ from
// the one the guard ruled on, and `tripped` is what it ruled.
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

// "this run's Pulls" on an entry, and a target for every generation a card
// links to on it. `pulls` is each card's `{ issue, cell, mark, targets }`, booked
// As-routed: listed under the Pull's Cell, mark and all, whether or not it has an
// Admissible row. A generation no figures, older row or "no figures yet" carries
// gets a "no figures yet for <model>" of its own (the card's model), so a card's
// link lands in every state: the entry's own "no figures yet" takes it when it
// names no model.
function booked(entry, pulls) {
  const cell = entry.cell;
  const out = { ...entry, pulls: pulls.filter((p) => p.cell === cell).map((p) => ({ issue: p.issue, href: `#board/${p.issue}`, mark: p.mark })), unfigured: [] };
  const has = new Set([out.figures?.generation, ...out.older.map((o) => o.generation), out.none?.generation].filter(Boolean));
  for (const t of pulls.flatMap((p) => p.targets)) {
    if (t.cell !== cell || !t.generation || has.has(t.generation)) continue;
    has.add(t.generation);
    const none = { text: `no figures yet for ${t.generation}`, generation: t.generation, anchor: `cell-${cell}@${t.generation}` };
    if (out.none !== null && out.none.anchor === null) out.none = { ...out.none, ...none };
    else out.unfigured.push(none);
  }
  return out;
}

// The Cells drawn: CELLS, then any the guard holds or a card names beyond them.
const drawOrder = (held, pulls) => [...new Set([...CELLS, ...held, ...pulls.flatMap((p) => p.targets.map((t) => t.cell)).filter((c) => CELL.test(c))])];

// `step` is the receipts' newest `metrics` step, newestStep's pick.
function guardSection(read, receipts, step, modelRoles, pulls, recordsNote = null) {
  const label = readLabel(modelRoles);
  const refresh = newestRefresh(step);
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
      cells: drawOrder([], pulls).map((cell) => booked(guardEntry(cell, stub, byCell, modelRoles, footnotes), pulls)),
      footnotes,
    };
  }

  const g = read.guard;
  const { state, heading, source } = guardHeading(g);
  const byCell = new Map(g.cells.map((c) => [c.cell, c]));
  const order = drawOrder(g.cells.map((c) => c.cell), pulls);
  const cells = order.map((cell) => booked(guardEntry(cell, g, byCell, modelRoles, footnotes), pulls));

  const missing = FIELD_WORDS.filter(([key]) => g.cells.some((c) => count(c[key]) === null)).map(([, words]) => words);
  if (missing.length > 0) notes.push(`not checked: this guard predates the ${missing.join(", ")}`);
  if (refresh !== null && refresh.verb === "failed" && Date.parse(refresh.at) > Date.parse(g.computed_at)) {
    notes.push(`the newest refresh failed at ${when(refresh.at)}: ${refresh.why}; these figures are from ${when(g.computed_at)}`);
  }
  if (recordsNote !== null) notes.push(recordsNote);
  if (label !== null) notes.push(label);
  return { state, heading, source, notes, cells, footnotes };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ---------------------------------------------------------------------------
// The Fit that routes this run, `.fleet/router-fit.json`.
// ---------------------------------------------------------------------------

// The table `route` routes by, and where it comes from: the Fit gather read
// beside the guard, else the starting table — as `route` falls back to it when
// the Fit is missing, unreadable or invalid. `fit` is gather's read, `{ status:
// "ok", fit } | { status: "missing" } | { status: "unreadable", why }`;
// `starting` the starting table validateTable accepted, or null. `fit` in the
// answer is the Fit read, null when the starting table routes.
function routingTable(fit, starting) {
  if (fit?.status === "ok") {
    const p = fit.fit;
    const n = p.table.n_rows;
    const rows = Number.isInteger(n) && n >= 0 ? plural(n, "Pull") : "Pulls: not checked: `n_rows` is not a count";
    return { fit: p, table: p.table, source: { text: ["Fit", computedWords(p), rows].join(" · "), check: null } };
  }
  const why = fit?.status === "unreadable" ? `the Fit is not read: ${fit.why}` : "no Fit yet: the next phase 0 writes one";
  return { fit: null, table: starting, source: { text: `starting table · ${why}`, check: starting === null ? "not checked: no starting table read" : null } };
}

// When the Fit read was computed, in words: its `computed_at` is null when the
// file holds no string there, which leaves the table it routes by unchanged.
const computedWords = (p) => (p.computed_at === null ? "computed: not checked: `computed_at` is not a string" : `computed ${when(p.computed_at)}`);

// The flag while this run's Fit failed: `step` is the receipts' newest `metrics`
// step that tried a refit, newestRefit's pick, `p` the Fit read, null when none
// was. Raised while that step's output holds the failed line and no Fit was
// written after it — a `computed_at` before the step's `at`, or one that is no
// time. A later step that tried a refit, a Fit written after this one, or the
// receipt no longer read clears it; a close-out step, which tries none, does not.
function failedFitFlag(step, p) {
  if (step === null) return null;
  const why = refitFailure(step.output);
  if (why === null) return null;
  const computed = p === null ? NaN : Date.parse(p.computed_at);
  if (Number.isFinite(computed) && computed >= Date.parse(step.at)) return null;
  const routes = p === null ? "no Fit is read, so the starting table routes" : `the last good Fit, ${computedWords(p)}, routes`;
  return `this run's Fit failed at ${when(step.at)}: ${why}; ${routes}`;
}

// How a Pull is dispatched, for every group alike: what `route` does under the guard and the install
// (installOf's, or null where it was not read).
function dispatchHeading(table, guard, install) {
  if (guard === null) return `no cost guard: every Pull runs at ${defaultCellOf(install)}, the default Cell`;
  if (table === null) return null;
  if (table.burn_in) return "burn-in: every Pull is drawn over the starting Cells the guard has not tripped";
  return "every 5th Pull that is no chain head is drawn over its group's exploration Cells; the rest run the group's Cell";
}

// Merged PRs per counted starting Cell, against MIN_N: the counts burn-in is judged on —
// the Fit's own guard counts while the Fit routes, the cost guard's while the
// starting table does. Null with neither to count from. The Cells counted are
// the ones the Fit recorded, or the install this cockpit reads runs while the
// starting table routes (countedStartingCells); the heading says which set it
// counted and which starting Cells it left out as unrunnable. It follows the
// routing table's `burn_in`, and says "ended" only of counts that all reach
// MIN_N: a Fit sets its flag off its own counts, but the starting table's flag
// is its own, whatever the cost guard counts since.
function burnInProgress(p, guard, table, inst) {
  const n = p !== null ? p.table.guard.n : guard?.n;
  if (!isRecord(n)) return null;
  const counted = countedStartingCells(p, inst);
  const left = STARTING_CELLS.filter((c) => !counted.includes(c));
  const subset = left.length > 0;
  const cells = counted.map((cell) => ({ cell, n: count(n[cell]) ?? 0, of: MIN_N }));
  const done = cells.filter((c) => c.n >= MIN_N).length;
  const kind = subset ? "runnable starting" : "starting";
  const out = subset ? `; ${list(left)} unrunnable` : "";
  const tally = `${done} of ${cells.length} ${kind} Cells ${done === 1 ? "has" : "have"} the ${MIN_N} merged PRs each needs${out}`;
  if (table === null || table.burn_in) return { heading: `burn-in: ${tally}`, cells };
  const heading = done === cells.length
    ? `burn-in ended: every ${kind} Cell has its ${MIN_N} merged PRs${out}`
    : `no burn-in: the starting table routes without it, though only ${tally}`;
  return { heading, cells };
}

// The Cells the cost guard has tripped, in words, or null with no guard.
function trippedWords(guard) {
  if (guard === null) return null;
  return guard.tripped.length === 0 ? "the cost guard has tripped no Cell" : `tripped by the cost guard: ${list(guard.tripped)}`;
}

// The starting Cells burn-in counts, in their order: the set the Fit recorded
// while a Fit routes — every starting Cell for a Fit that records none, as
// every Fit did — else those the cockpit's own install read runs, all three
// while it has none.
function countedStartingCells(p, inst) {
  return p === null ? startingCellsOf(inst.install) : fitStartingCells(p.table);
}

// The starting Cells a Fit's table records, in their order: all three for a table that records none, or none usable.
function fitStartingCells(table) {
  const recorded = table.starting_cells;
  const valid = Array.isArray(recorded) && recorded.length > 0 && recorded.every((c) => STARTING_CELLS.includes(c));
  return valid ? STARTING_CELLS.filter((c) => recorded.includes(c)) : [...STARTING_CELLS];
}

// A notice for each counted starting Cell whose role's model changed and so restarted
// burn-in: the Fit holds an older generation of it in the root group, and its
// newest generation is short of MIN_N merged PRs in the counts the Fit judged
// burn-in on. None while the starting table routes, which holds no estimates.
function modelChanges(p) {
  if (p === null || !p.table.burn_in) return [];
  const root = isRecord(p.table.estimates?.["*"]) ? p.table.estimates["*"] : {};
  return fitStartingCells(p.table).flatMap((cell) => {
    const e = root[cell];
    const older = isRecord(e?.older) ? Object.keys(e.older) : [];
    const k = count(p.table.guard.n[cell]) ?? 0;
    if (older.length === 0 || typeof e.generation !== "string" || k >= MIN_N) return [];
    return [`${cell}'s model changed to ${e.generation}, after ${list(older)}: burn-in restarted, at ${k} of the ${MIN_N} merged PRs it needs`];
  });
}

// What this install runs, for the exploration Cells, off the cockpit's own reads:
// `{ install, note }`, installOf's answer, or `{ install: null, why }` while one
// of the reads it needs has no value. A catalog read that fails is worded the
// way readLabel words modelRoles': beside the unread catalog in `why`, and in
// `note`, while the last read stands, beside the Cells it names.
function installFrom(modelRoles, catalog, agents) {
  if (!isRecord(modelRoles?.value)) return { install: null, why: "modelRoles not read yet", note: null };
  const failing = catalog?.error == null ? "" : `; reading fails: ${catalog.error.message}`;
  if (!isRecord(catalog?.value)) return { install: null, why: `omp's model catalog not read yet${failing}`, note: null };
  if (agents == null || agents.error) return { install: null, why: "the definitions could not be read", note: null };
  const note = failing === "" ? null : `omp's model catalog as read at ${when(catalog.readAt)}${failing}`;
  return { install: installOf({ modelRoles: modelRoles.value, catalog: catalog.value, definitions: agents.list.map((a) => a.file) }), why: null, note };
}

// The Cells this install does not run, apart from the tripped ones, each with its role, the model the role resolves
// to and the levels that model runs: `{ heading, cells: [{ cell, role, model, levels, text }] }`. While the install
// has not been read the heading says so, and no Cell is named.
function unrunnableView(inst) {
  if (inst.install === null) return { heading: `unrunnable Cells: not checked: ${inst.why}`, cells: [] };
  const cells = unrunnableCells(inst.install).map((cell) => {
    const role = CELL.exec(cell)[1];
    const model = inst.install.models[role];
    const levels = inst.install.ladders[role];
    return { cell, role, model, levels, text: `${cell} · modelRoles.${role} → ${model ?? "no model"} runs ${levels.join(", ") || "none"}` };
  });
  const heading = cells.length === 0 ? "the install runs every Cell it has a definition for" : `not run by this install: ${list(cells.map((c) => c.cell))}`;
  return { heading, cells };
}

// The Cells a group draws over, in words: rowDispatch's draw, which is centred on
// the group's `cost` row Cell whichever Objective routes the Pull. Null with no
// guard, when nothing is drawn.
function exploringWords(table, guard, stratum, inst) {
  if (guard === null) return null;
  if (!table.burn_in && inst.install === null) return `exploring: not checked: ${inst.why}`;
  const rd = rowDispatch({ table, guard, objective: "cost", stratum, install: inst.install });
  if (table.burn_in) {
    if (rd.draw !== null) return `drawn over ${list(rd.draw.cells)}`;
    const orUnrunnable = unrunnableCells(inst.install).some((c) => STARTING_CELLS.includes(c)) ? " or unrunnable" : "";
    return `draws nothing: every starting Cell is tripped${orUnrunnable}`;
  }
  const words = rd.draw === null ? "exploring nothing: no exploration Cell this install runs is left untripped" : `exploring ${list(rd.draw.cells)}`;
  return inst.note === null ? words : `${words}; ${inst.note}`;
}

// A candidate's judged generation against the Tier route model of its Cell:
// null for a row with no estimate (it names no generation), else `{ state,
// generation, text }`, `text` set where the two differ or cannot be compared.
function generationCheck(cell, generation, modelRoles) {
  if (typeof generation !== "string" || generation === "") return null;
  const parsed = CELL.exec(cell);
  if (parsed === null) return { state: "not checked", generation, text: "not checked: not a Cell the fleet defines" };
  const model = routeModel(parsed[1], modelRoles);
  if (model === undefined) return { state: "not checked", generation, text: "not checked: modelRoles not read yet" };
  if (model === null) return { state: "not checked", generation, text: `not checked: modelRoles.${parsed[1]} unset: omp picks the model` };
  if (modelsEqual(model, generation)) return { state: "same", generation, text: null };
  return { state: "differs", generation, text: `judged on ${generation}; ${cell} runs ${model} here` };
}

// A candidate's 95% interval, of (candidate − base) per merged PR: dollars under
// `cost`, minutes of work time under `speed`.
function intervalWords(range, objective) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) return "no 95% interval";
  const one = (x) => `${x < 0 ? MINUS : ""}${objective === "cost" ? `$${Math.abs(x).toFixed(2)}` : `${Math.abs(x).toFixed(1)} min`}`;
  return `95% interval [${one(range[0])}, ${one(range[1])}]`;
}

// One row of the routing table under the guard and the install: the Cell it
// routes to and why, the row's own Cell where the guard holds it back or the
// install does not run it (`install` is installOf's answer, null where the
// cockpit has not read one), and each candidate's n (null where the table
// carries no count), verdict and interval.
function rowEntry(table, guard, modelRoles, objective, stratum, install) {
  const rd = rowDispatch({ table, guard, objective, stratum, install });
  const row = table.rows[objective][stratum];
  const record = isRecord(table.reasons?.[objective]?.[stratum]) ? table.reasons[objective][stratum] : null;
  const estimates = isRecord(table.estimates?.[stratum]) ? table.estimates[stratum] : {};
  const held = rd.reason === "table-cell-unrunnable" ? `${row} unrunnable here`
    : row === rd.policy ? null
      : rd.reason === "guard-missing" ? `${row} held: no cost guard` : `${row} tripped`;
  return {
    cell: rd.policy,
    held,
    reason: record !== null && typeof record.reason === "string" ? record.reason : "not checked",
    candidates: Object.entries(isRecord(record?.cells) ? record.cells : {}).map(([cell, x]) => ({
      cell,
      n: count(estimates[cell]?.merged),
      verdict: typeof x?.verdict === "string" ? x.verdict : "not checked",
      interval: intervalWords(x?.range, objective),
      model: generationCheck(cell, estimates[cell]?.generation, modelRoles),
    })),
  };
}

// The Fit's labels against `raw`, the guard on disk, and `records`, whether the
// Fit read the guard's files: fitted beside another guard, or on other records.
// A Fit that names no guard time or no blob ids leaves its own check unchecked.
function fitLabels(p, raw, records) {
  const labels = [];
  if (p.guard_computed_at === null) labels.push("fitted beside this guard: not checked: `guard_computed_at` is not a string");
  else if (p.guard_computed_at !== raw.computed_at) labels.push(`fitted beside the guard of ${when(p.guard_computed_at)}, not this one`);
  if (records === null) labels.push(`fitted on the guard's records: not checked: ${isRecord(raw.tsv_blobs) ? "the Fit names no blob ids" : "this guard predates the blob ids it needs"}`);
  else if (!records) labels.push("fitted on other records than the guard's");
  return labels;
}

// The Cells whose newest generation's merged n the guard and the Fit count
// differently although both read the same files, `records` true: the guard
// counts merges by GitHub's state, the Fit by Rulings. Files the guard names no
// blob ids for, or other files, compare nothing.
function nDiffers(p, raw, records) {
  if (records !== true) return [];
  const fit = isRecord(p.table.estimates?.["*"]) ? p.table.estimates["*"] : {};
  return raw.cells.filter((e) => {
    const f = fit[e.cell];
    return isRecord(f) && f.generation === e.generation && count(f.merged) !== null && count(f.merged) !== e.n;
  }).map((e) => e.cell);
}

// A group's depth in the tree and its own rule, off its rule path: `*` is the
// root, and each test joined by `&` is one level below it.
function groupOf(stratum) {
  if (stratum === "*") return { depth: 0, rule: "*" };
  const tests = stratum.split("&");
  return { depth: tests.length, rule: tests.at(-1) };
}

/**
 * The view of the Fit that routes this run. `fit` is gather's read of the Fit
 * and `starting` the starting table (see routingTable); `guard`
 * readCostGuard's answer and `routed` readGuard's for the same file, null when
 * the router reads none; `step` the receipts' newest `metrics` step that tried
 * a refit; `agents`, `modelRoles` and `catalog` the cockpit's own reads, which
 * say what this install runs: each group's exploration Cells, the Cells it
 * does not run, and the starting Cells burn-in counts while the starting table
 * routes; `objective`
 * the live run's, or null. Each Objective's lines are the table's groups in
 * the table's order, the tree's root first; every line has an anchor the
 * `#cells/row/<objective>/<stratum>` link lands on. A candidate's generation
 * check moves to one model-name line when every candidate named differs.
 */
function fitView({ fit, starting, guard, routed, modelRoles, catalog, agents, step, objective }) {
  const { fit: p, table, source } = routingTable(fit, starting);
  const raw = guard?.status === "ok" ? guard.guard : null;
  let labels = [];
  let differ = [];
  if (p !== null && raw !== null) {
    // Whether the Fit read the guard's files: null when the guard or the Fit
    // names no blob ids to compare, else whether the two name the same ones.
    const records = isRecord(raw.tsv_blobs) && p.tsv_blobs !== null ? isDeepStrictEqual(p.tsv_blobs, raw.tsv_blobs) : null;
    labels = fitLabels(p, raw, records);
    differ = nDiffers(p, raw, records);
  }
  const mark = "¹";
  const inst = installFrom(modelRoles, catalog, agents);
  const entry = (o, s) => {
    const e = rowEntry(table, routed, modelRoles, o, s, inst.install);
    return { ...e, candidates: e.candidates.map((c) => ({ ...c, nMark: s === "*" && differ.includes(c.cell) ? mark : null })) };
  };
  // A group's exploration Cells are centred on its `cost` row whichever
  // Objective routes the Pull, so each group's words are worked out once.
  const exploring = new Map();
  const exploringOf = (s) => {
    if (!exploring.has(s)) exploring.set(s, exploringWords(table, routed, s, inst));
    return exploring.get(s);
  };
  const line = (o, s, rest) => ({ stratum: s, ...groupOf(s), ...rest, anchor: `cells-row-${o}-${s}`, href: `#cells/row/${o}/${s}` });
  const objectives = OBJECTIVES.map((o) => ({
    objective: o,
    live: o === objective,
    lines: table === null
      ? [line(o, "*", { entry: null, exploring: null, unread: "no starting table read: the rows are not known" })]
      : Object.keys(table.rows[o]).map((s) => line(o, s, { entry: entry(o, s), exploring: exploringOf(s), unread: null })),
  }));

  const checks = objectives.flatMap((o) => o.lines.flatMap((l) => (l.entry === null ? [] : l.entry.candidates.map((c) => c.model)))).filter((m) => m !== null);
  const modelLine = checks.length > 0 && checks.every((m) => m.state === "differs") ? [...new Set(checks.map((m) => m.text))].join("; ") : null;
  if (modelLine !== null) {
    for (const l of objectives.flatMap((o) => o.lines)) {
      if (l.entry !== null) l.entry.candidates = l.entry.candidates.map((c) => (c.model === null ? c : { ...c, model: { ...c.model, text: null } }));
    }
  }
  return {
    title: "The Fit that routes this run",
    flag: failedFitFlag(step, p),
    source,
    heading: dispatchHeading(table, routed, inst.install),
    labels,
    notices: modelChanges(p),
    burnIn: burnInProgress(p, routed, table, inst),
    tripped: trippedWords(routed),
    unrunnable: unrunnableView(inst),
    modelLine,
    footnotes: differ.length === 0 ? [] : [{ mark, text: `${list(differ)}: the guard counts merges by GitHub's state, the Fit by Rulings, and the Fit admits only drawn or rule-sized Pulls` }],
    objectives,
  };
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

// ---------------------------------------------------------------------------
// Alerts: the state of the whole records, shown only while it holds.
// ---------------------------------------------------------------------------

// A blob id as the tab prints it.
const blob8 = (id) => (typeof id === "string" ? id.slice(0, 8) : String(id));

// Whether the close-out receipt's PR is among the open ones: null where that
// cannot be told — the open PRs not read (`openPrs` null), or a list cut short
// that does not name it.
function prIsOpen(pr, openPrs) {
  if (pr === null) return false;
  if (!isRecord(openPrs) || !Array.isArray(openPrs.numbers)) return null;
  if (openPrs.numbers.includes(pr)) return true;
  return openPrs.capped === true ? null : false;
}

// The guard's and the Fit's TSV blob ids against main's. `alert` is the
// alert while the records are not on main, else null; `note`, in its place, is
// a note under the guard section's heading: a check that could not run is never
// an alert, so an offline cockpit raises none. `main` is the carried read of
// `docs/metrics`, `{ value: { blobs }, readAt, error }`, `blobs` null for a 404.
// A guard that names no blob ids has nothing to compare, and neither has one
// whose cockpit read nothing (`main` null). The Fit is compared only while it
// was fitted beside this guard and names blob ids of its own: a guard written
// after it — a close-out's, which computes no Fit, or one whose refit failed —
// moves on alone, and the view of the Fit already says it was fitted beside
// another guard, or that its blob ids are not checked.
function recordsAgainstMain({ read, fit, main, closeoutPr, openPrs }) {
  const none = { alert: null, note: null };
  if (main == null || read?.status !== "ok") return none;
  const g = read.guard;
  const unchecked = (why) => ({ alert: null, note: `records against main: not checked: ${why}` });
  if (!isRecord(g.tsv_blobs)) return unchecked("this guard predates the blob ids it needs");
  if (main.error != null) {
    return unchecked(`${main.error.message}; last succeeded ${main.readAt == null ? "never" : when(main.readAt)}`);
  }
  const blobs = isRecord(main.value) ? main.value.blobs : undefined;
  if (blobs === null) return { alert: null, note: "records against main: main holds no metrics yet" };
  if (!isRecord(blobs)) return unchecked("main's docs/metrics not read yet");

  const mine = fit?.status === "ok" && fit.fit.guard_computed_at === g.computed_at && fit.fit.tsv_blobs !== null ? fit.fit : null;
  const held = (ids, path) => (isRecord(ids) && Object.hasOwn(ids, path) ? ids[path] : undefined);
  const paths = [...new Set([...Object.keys(g.tsv_blobs), ...(mine === null ? [] : Object.keys(mine.tsv_blobs))])].sort();
  const lines = [];
  let guardDiffers = false;
  let fitDiffers = false;
  for (const path of paths) {
    const onMain = held(blobs, path);
    const guardId = held(g.tsv_blobs, path);
    const fitId = mine === null ? undefined : held(mine.tsv_blobs, path);
    const gd = guardId !== undefined && guardId !== onMain;
    const fd = fitId !== undefined && fitId !== onMain;
    if (!gd && !fd) continue;
    guardDiffers ||= gd;
    fitDiffers ||= fd;
    const said = [guardId === undefined ? null : fitId === guardId ? `the guard and the Fit read ${blob8(guardId)}` : `the guard read ${blob8(guardId)}`,
      fitId === undefined || fitId === guardId ? null : `the Fit read ${blob8(fitId)}`].filter(Boolean);
    lines.push(`${path}: ${said.join(", ")}; main holds ${onMain === undefined ? "none" : blob8(onMain)}`);
  }
  if (lines.length === 0) return none;

  const both = guardDiffers && fitDiffers;
  const subject = both ? "the guard and the Fit" : guardDiffers ? "the guard" : "the Fit";
  const pr = Number.isInteger(closeoutPr?.number) ? closeoutPr.number : null;
  const open = prIsOpen(pr, openPrs);
  const computed = guardDiffers ? g.computed_at : mine.computed_at;
  let sentence;
  if (open === null) {
    return unchecked(isRecord(openPrs)
      ? `the close-out's PR #${pr} is not among the open PRs read, and that list was cut short`
      : `the open PRs were not read, so whether the close-out's PR #${pr} is open is unknown`);
  }
  if (open) {
    const committed = Date.parse(closeoutPr.at);
    if (!Number.isFinite(committed)) return unchecked(`the close-out receipt records no time for PR #${pr}'s commit step`);
    const built = Date.parse(computed);
    if (!Number.isFinite(built)) return unchecked(`the ${guardDiffers ? "guard" : "Fit"} records no time it was computed`);
    sentence = built <= committed
      ? `${subject} ${both ? "count" : "counts"} the rows of open PR #${pr}, not on main yet`
      : `${subject} ${both ? "lack" : "lacks"} the rows of open PR #${pr}`;
  } else {
    sentence = `main's records changed after ${when(computed)}; the next phase 0 recomputes`;
  }
  return { alert: { id: "records-not-on-main", headline: "Records not on main", sentence, lines }, note: null };
}

// Pulls that merged with no Ruling, per Cell, off the guard's newest generations.
function noRulingAlert(read) {
  if (read?.status !== "ok") return null;
  const held = read.guard.cells.map((c) => [c.cell, count(c.no_ruling)]).filter(([, k]) => k !== null && k > 0);
  if (held.length === 0) return null;
  return {
    id: "merged-with-no-ruling",
    headline: `Merged with no Ruling: ${held.map(([cell, k]) => `${cell} ${k}`).join(", ")}`,
    sentence: "each counts as not merged, so n reads low and $ per merged PR high",
    lines: [],
  };
}

// The Router's reader and the tick's reading the same guard file differently:
// the one that accepts it, and why the other refuses. `json` is the file as
// parsed, null when missing or unparseable, which both refuse alike.
function readersAlert(json) {
  if (json == null) return null;
  const router = parseGuard(json);
  const tickWhy = costGuardFault(json);
  const tickAccepts = tickWhy === null;
  if (tickAccepts === router.ok) return null;
  return {
    id: "guard-readers-disagree",
    headline: "Guard readers disagree",
    sentence: tickAccepts
      ? `the tick's reader (readCostGuard) accepts the guard and the Router's (readGuard) refuses it: ${router.why}`
      : `the Router's reader (readGuard) accepts the guard and the tick's (readCostGuard) refuses it: ${tickWhy}`,
    lines: [],
  };
}

/**
 * The Cell evidence tab's model. `guard` is `readCostGuard`'s answer, `receipts`
 * is `{ phase0, closeout }`, each the receipt's `metrics` step `{ status, at,
 * output }` or null, `agents` is `{ list: [{ file, model }], error }`, and
 * `modelRoles` and `catalog` the carried `{ value, readAt, error }` reads of
 * `omp config get modelRoles` and `omp models`, or null — `error` being
 * `{ at, message }`, and `pulls` this run's Pulls, one per card with a Cell line:
 * `{ issue, cell, mark, targets: [{ cell, generation }] }` (compute-board.mjs's
 * cellLine). `table` is the starting router table `validateTable` accepted or
 * null, `objective` the live run's Objective or null between runs, and `fit`
 * the Fit as gather read `.fleet/router-fit.json`: `{ status: "ok", fit: {
 * computed_at, guard_computed_at, tsv_blobs, table } }`, the first three null
 * where the file holds no string or object, `{ status: "missing" }`
 * or `{ status: "unreadable", why }`. An input left out reads as nothing
 * read: a missing guard, no receipt, no definitions, no `modelRoles` or catalog
 * read, no Pull, no table, no Objective, no Fit.
 */
export function computeCellEvidence({ guard, receipts, agents, modelRoles = null, catalog = null, pulls = [], table = null, objective = null, fit = null,
  guardJson = null, mainMetrics = null, closeoutPr = null, openPrs = null }) {
  const routed = guard?.status === "ok" ? readGuard(guard.guard) : null;
  const step = newestStep(receipts);
  const records = recordsAgainstMain({ read: guard, fit, main: mainMetrics, closeoutPr, openPrs });
  return {
    alerts: [records.alert, noRulingAlert(guard), readersAlert(guardJson)].filter((a) => a !== null),
    policy: fitView({ fit, starting: table, guard, routed, modelRoles, catalog, agents, step: newestRefit(receipts), objective }),
    guard: guardSection(guard, receipts, step, modelRoles, pulls, records.note),
    declared: declaredSection(agents, modelRoles),
  };
}
