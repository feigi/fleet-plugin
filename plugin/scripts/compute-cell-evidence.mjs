// The cockpit's Cell evidence tab, as a value: computeCellEvidence() turns what
// gather() read (the cost guard, the receipts' `metrics` steps, the installed
// definitions, the installed router table and package, the carried `modelRoles`
// read, the Preview fit) into the model the page lays out.
// Pure, like compute-board.mjs, which calls it and puts the answer in
// `board.json` as `cellEvidence`: no file, no process, no clock. Every word the
// tab shows is built here, so a test pins it where it is made and the page only
// places it.
//
// What this holds is the guard section — what the cost guard holds each
// implementer Cell to, from the guard file and nothing recomputed, with this
// run's Pulls booked to each Cell off the board's cards — "Declared, not
// measured", and the policy rows: for each Objective × Stratum row, on the
// routes-now side the Cell the installed router table plus the workspace's guard
// route to, why, and how a Pull on that row is dispatched (ticket-router.mjs's
// rowDispatch, the function `route` itself calls), and on the evidence-favours
// side the same for the Preview fit's table (`.fleet/router-preview.json`, which
// metrics-refresh.mjs writes beside the guard), marked where its Cell differs.
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
import { CELL, OBJECTIVES, POLICY_CELL, STRATA } from "./ledger-grammar.mjs";
import { costGuardFault } from "./fleet-tick.mjs";
import { MIN_N, parseGuard, readGuard, rowDispatch } from "./ticket-router.mjs";
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

// The Cells drawn: the five, then any the guard holds or a card names beyond them.
const drawOrder = (held, pulls) => [...new Set([...CELLS, ...held, ...pulls.flatMap((p) => p.targets.map((t) => t.cell)).filter((c) => CELL.test(c))])];

function guardSection(read, receipts, modelRoles, pulls, recordsNote = null) {
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

// ---------------------------------------------------------------------------
// Policy rows: Objective × Stratum, routes now.
// ---------------------------------------------------------------------------

// A repository's host and `owner/name` off a `package.json` `repository` url (an
// npm shorthand, a scp-style address or a URL), or null when it names none. A
// `#ref` pin and a `www.` host name the same repository; a segment of dots only
// names none.
export function repoIdentity(url) {
  if (typeof url !== "string") return null;
  const s = url.trim().replace(/^git\+/, "").replace(/#.*$/, "");
  let host;
  let path;
  const short = /^(github|gitlab|bitbucket):([^/\s]+\/[^/\s]+)$/.exec(s);
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (short) {
    host = `${short[1]}.${short[1] === "bitbucket" ? "org" : "com"}`;
    path = short[2];
  } else if (scp) {
    [, host, path] = scp;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    host = "github.com";
    path = s;
  } else {
    try { ({ hostname: host, pathname: path } = new URL(s)); } catch { return null; }
  }
  const [owner, rest] = path.split("/").filter(Boolean);
  const name = rest?.replace(/\.git$/, "");
  if (!host || !owner || !name || /^\.+$/.test(owner) || /^\.+$/.test(name)) return null;
  return { host: host.toLowerCase().replace(/^www\./, ""), name: `${owner}/${name}` };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// Whose runs the installed table is, and what the install is: "this repository's
// runs · fitted at 1a2b3c4 on 198 Pulls · @feigi/fleet-ctl 3.105.0". `install` is
// `{ name, version, repository, error }`, `repository` the package's url.
function routesSource(table, install, repoUrl) {
  const named = repoIdentity(install?.repository);
  const here = repoIdentity(repoUrl);
  const same = named !== null && here !== null && named.host === here.host && named.name.toLowerCase() === here.name.toLowerCase();
  const runs = same ? "this repository's runs" : named !== null ? `${named.name}'s runs` : "another repository's runs";
  let fitted;
  if (table === null) fitted = "no router table read";
  else if (!table.fitted_commit) fitted = "never fitted";
  else {
    const on = Number.isInteger(table.n_rows) ? `on ${plural(table.n_rows, "Pull")}` : "on a number of Pulls not checked";
    fitted = `fitted at ${String(table.fitted_commit).slice(0, 7)} ${on}`;
  }
  let installed;
  if (install == null || install.error) installed = `install not read${install?.error ? `: ${install.error}` : ""}`;
  else installed = `${install.name ?? "unnamed package"} ${install.version === "0.0.0" ? "linked checkout" : (install.version ?? "no version")}`;
  const check = install == null || install.error
    ? "not checked: the install was not read"
    : named === null
      ? "not checked: the install names no repository"
      : here === null ? "not checked: this workspace's repository is not known" : null;
  return { same, owner: named === null ? "another repository" : named.name, runs, text: [runs, fitted, installed].join(" · "), check };
}

// The Cells short of `MIN_N` merged PRs in the table's `guard.n`, in the table's
// order, as one phrase: past tense for an installed table, whose counts are what
// its fit saw ("had"), present for the Preview fit, whose counts are the
// workspace's own now ("has", "have").
function shortWords(table, tense = "past") {
  const short = table.cells.filter((c) => (table.guard.n[c] ?? 0) < MIN_N).map((c) => [c, table.guard.n[c] ?? 0]);
  if (short.length === 0) return null;
  const each = short.length === 1 ? "it needs" : "each needs";
  const one = tense === "past" ? "had" : "has";
  const counts = new Set(short.map(([, n]) => n));
  if (counts.size === 1) {
    const verb = tense === "past" ? "had" : short.length === 1 ? "has" : "have";
    return `${list(short.map(([c]) => c))} ${verb} ${short[0][1]} of the ${MIN_N} merged PRs ${each}`;
  }
  return `${list(short.map(([c, n]) => `${c} ${one} ${n}`))} of the ${MIN_N} merged PRs ${each}`;
}

// The side's burn-in or no-guard heading, or null while neither holds. Past tense
// for a fitted table, whose counts are what its fit saw.
function routesHeading(table, guard, source) {
  if (table === null) return "no router table read: the rows are not known";
  if (guard === null) return `no cost guard: every Pull runs at ${POLICY_CELL}, the default Cell`;
  if (!table.burn_in) return null;
  const K = rowDispatch({ table, guard, objective: "cost", stratum: "*" }).draw?.cells.length ?? 0;
  const drawn = K === 0 ? "no Cell is left to draw, so every Pull runs at its row's Cell" : `every Pull drawn over ${plural(K, "Cell")}`;
  if (!table.fitted_commit) return `never fitted: ${drawn}`;
  const short = shortWords(table);
  const ends = source.same ? "" : "; it ends with a later fit, reaching this install with a plugin release";
  return `stage ${table.stage} at its fit on ${source.owner}'s runs: ${short === null ? "every Cell had its merged PRs" : short}; ${drawn}${ends}`;
}

// One row's dispatch, in the words a heading or a row carries: what `route` does
// with a Pull on it under the guard, from rowDispatch.
function dispatchWords(table, rd, row) {
  const tripped = rd.reason === "table-cell-tripped" ? `the row's ${row} tripped` : null;
  if (rd.reason === "guard-missing") return `${POLICY_CELL} only`;
  if (rd.draw?.by === "burn-in") {
    return `drawn over ${plural(rd.draw.cells.length, "Cell")}: ${rd.draw.cells.join(", ")}${tripped ? `; ${tripped}, so its policy Cell is ${POLICY_CELL}` : ""}`;
  }
  const fifth = rd.draw === null ? "no draw: no other Cell is left" : "every 5th Pull drawn over the rest";
  return `${tripped ? `${POLICY_CELL}, ${tripped}` : "the row's Cell"}; ${fifth}`;
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

// One row of a table under the guard — the installed table for routes now, the
// Preview fit's for evidence favours: the Cell it routes to and why, its
// dispatch, and each candidate's n (null where the table carries no count),
// verdict and interval.
function rowEntry(table, guard, modelRoles, objective, stratum) {
  const rd = rowDispatch({ table, guard, objective, stratum });
  const row = table.rows[objective][stratum];
  const record = isRecord(table.reasons?.[objective]?.[stratum]) ? table.reasons[objective][stratum] : null;
  const estimates = isRecord(table.estimates?.[stratum]) ? table.estimates[stratum] : {};
  const held = row === rd.policy ? null
    : rd.reason === "guard-missing" ? `${row} held: no cost guard` : `${row} tripped`;
  return {
    cell: rd.policy,
    held,
    reason: record !== null && typeof record.reason === "string" ? record.reason : "not checked",
    dispatch: dispatchWords(table, rd, row),
    candidates: Object.entries(isRecord(record?.cells) ? record.cells : {}).map(([cell, x]) => ({
      cell,
      n: count(estimates[cell]?.merged),
      verdict: typeof x?.verdict === "string" ? x.verdict : "not checked",
      interval: intervalWords(x?.range, objective),
      model: generationCheck(cell, estimates[cell]?.generation, modelRoles),
    })),
  };
}

// Routes now's "installed table behind main's", for the one repository whose
// checkout holds the table the install is a release of: `label` where the
// checkout's `fitted_commit` and `n_rows` differ from the installed table's, and
// `check` where the checkout's table could not be compared. `checkout` is
// gather's read of the checkout's `plugin/scripts/router-table.json`, `{ status:
// "ok", table } | { status: "missing" } | { status: "unreadable", why }`, or
// null where nothing read it. A consumer, whose install names another repository,
// is never compared.
function behindMain(source, table, checkout) {
  const none = { label: null, check: null };
  if (!source.same || table === null || checkout == null) return none;
  if (checkout.status === "missing") return { label: null, check: "not checked: this checkout holds no plugin/scripts/router-table.json" };
  if (checkout.status !== "ok") return { label: null, check: `not checked: this checkout's router table was not read: ${checkout.why}` };
  const main = checkout.table;
  const commit = (t) => (t.fitted_commit ? String(t.fitted_commit) : null);
  const mainAt = commit(main);
  const installedAt = commit(table);
  if (mainAt === installedAt && main.n_rows === table.n_rows) return none;
  const on = Number.isInteger(main.n_rows) ? `on ${plural(main.n_rows, "Pull")}` : "on a number of Pulls not checked";
  const fitted = mainAt === null ? "never fitted" : `fitted at ${mainAt.slice(0, 7)} ${on}`;
  const routes = installedAt === null ? "a table never fitted" : installedAt.slice(0, 7);
  return { label: `main's table is ${fitted}; this install routes by ${routes} until the plugin is updated`, check: null };
}

// The routes-now side of the policy rows: its heading words and every row the
// installed table holds, `rows[objective][stratum]` — `*` and each Stratum with a
// row of its own. `rows` is null when no table could be read, and each of its
// rows then reads `unread`.
function routesNow({ table, guard, modelRoles, install, repoUrl, checkout }) {
  const source = routesSource(table, install, repoUrl);
  const behind = behindMain(source, table, checkout);
  const foot = source.same ? [] : [{ mark: "¹", text: "this repository's runs reach routing only through its cost guard, which can hold a Cell back but never picks one" }];
  return {
    title: "routes now",
    source: { text: source.text + (foot.length ? " ¹" : ""), check: source.check ?? behind.check },
    heading: routesHeading(table, guard, source),
    labels: behind.label === null ? [] : [behind.label],
    footnotes: foot,
    rows: table === null ? null : Object.fromEntries(OBJECTIVES.map((o) => [o,
      Object.fromEntries(["*", ...STRATA].filter((s) => Object.hasOwn(table.rows[o], s)).map((s) => [s, rowEntry(table, guard, modelRoles, o, s)])),
    ])),
    unread: "router table not read",
  };
}

// ---------------------------------------------------------------------------
// Policy rows: what the evidence favours — the Preview fit, `.fleet/router-preview.json`.
// ---------------------------------------------------------------------------

const FAVOURS = "evidence favours";

// The evidence-favours side with no Preview fit to lay out: its heading says
// why, and its column is empty — nothing is unknown there, there is nothing to show.
const noFit = (heading) => ({
  title: FAVOURS, source: { text: "Preview fit", check: null }, heading, labels: [], footnotes: [], rows: null, unread: null,
});

// The Preview fit's heading labels, against `raw`, the guard on disk, `routed`,
// readGuard's answer for it, `table`, the installed one, and `records`, whether
// the fit read the guard's files: fitted beside another guard, on other records,
// or against another prior. The prior is
// compared only on what the fit takes from it — `stage`, `cells`, `classifier`,
// and `window_start` when the guard gives none — so a release that changes only
// what the fit recomputes, or `fitted_commit` and `version`, raises nothing: the
// next phase 0's refit would come out the same.
function previewLabels(p, raw, routed, table, records) {
  const labels = [];
  if (p.guard_computed_at !== raw.computed_at) labels.push(`fitted beside the guard of ${when(p.guard_computed_at)}, not this one`);
  if (records === null) labels.push("fitted on the guard's records: not checked: this guard predates the blob ids it needs");
  else if (!records) labels.push("fitted on other records than the guard's");
  if (table === null) {
    labels.push("fitted against the installed table: not checked: no router table read");
    return labels;
  }
  const read = ["stage", "cells", "classifier", ...(routed.window_start === null ? ["window_start"] : [])];
  const prior = isRecord(p.prior) ? p.prior : {};
  if (read.some((k) => !isDeepStrictEqual(prior[k], table[k]))) {
    const version = prior.version === "0.0.0" ? "linked checkout" : (typeof prior.version === "string" ? prior.version : "no version");
    const fitted = typeof prior.fitted_commit === "string" && prior.fitted_commit !== "" ? `fitted at ${prior.fitted_commit.slice(0, 7)}` : "never fitted";
    labels.push(`fitted against ${version} · ${fitted}; the next phase 0 refits`);
  }
  return labels;
}

// The Cells whose newest generation's merged n the guard and the fit count
// differently although both read the same files, `records` true: the guard
// counts merges by GitHub's state, the fit by Rulings. Files the guard names no
// blob ids for, or other files, compare nothing.
function nDiffers(p, raw, records) {
  if (records !== true) return [];
  const fit = isRecord(p.table.estimates?.["*"]) ? p.table.estimates["*"] : {};
  return raw.cells.filter((e) => {
    const f = fit[e.cell];
    return isRecord(f) && f.generation === e.generation && count(f.merged) !== null && count(f.merged) !== e.n;
  }).map((e) => e.cell);
}

// The evidence-favours side: the Preview fit's table laid out row by row under
// the workspace's guard, as routes now lays out the installed one, each row's
// Cell marked where it differs from the Cell routes now gives that row. `preview`
// is gather's read, `{ status: "ok", preview } | { status: "missing" } | {
// status: "unreadable", why }`; `guard` readCostGuard's answer and `routed`
// readGuard's for the same file, null when the router reads none; `mark` the
// footnote mark its n footnote takes.
function evidenceFavours({ preview, guard, routed, table, modelRoles, mark }) {
  if (routed === null) return noFit("no Preview fit: it is written only beside a cost guard");
  if (preview?.status === "unreadable") return noFit(`no Preview fit read: ${preview.why}`);
  if (preview?.status !== "ok") return noFit("no Preview fit yet: the next phase 0 writes one");
  const p = preview.preview;
  const fit = p.table;
  const raw = guard.guard;
  // Whether the fit read the guard's files: null when the guard names no blob
  // ids to compare, else whether the two name the same ones.
  const records = isRecord(raw.tsv_blobs) ? isDeepStrictEqual(p.tsv_blobs, raw.tsv_blobs) : null;
  const differ = nDiffers(p, raw, records);
  const entry = (o, s) => {
    const e = rowEntry(fit, routed, modelRoles, o, s);
    const now = table === null ? null : rowDispatch({ table, guard: routed, objective: o, stratum: s }).policy;
    return {
      ...e,
      differs: now !== null && now !== e.cell ? "≠ routes now" : null,
      candidates: e.candidates.map((c) => ({ ...c, nMark: s === "*" && differ.includes(c.cell) ? mark : null })),
    };
  };
  return {
    title: FAVOURS,
    source: { text: ["Preview fit", "this repository's runs", `computed ${when(p.computed_at)}`, plural(fit.n_rows, "Pull")].join(" · "), check: null },
    heading: fit.burn_in ? `stage ${fit.stage}: ${shortWords(fit, "present") ?? "every Cell has its merged PRs"}` : null,
    labels: previewLabels(p, raw, routed, table, records),
    footnotes: differ.length === 0 ? [] : [{ mark, text: `${list(differ)}: the guard counts merges by GitHub's state, the fit by Rulings, and the fit admits only drawn or rule-sized Pulls` }],
    rows: Object.fromEntries(OBJECTIVES.map((o) => [o,
      Object.fromEntries(["*", ...STRATA].filter((s) => Object.hasOwn(fit.rows[o], s)).map((s) => [s, entry(o, s)])),
    ])),
    unread: null,
  };
}

// The policy rows as the page lays them out, from each side built above. Pure
// and side-agnostic: a side's shared dispatch (the one most rows have, the rest
// showing theirs on the row), its one model-name line when every candidate it
// names differs, a Stratum no side has a row for collapsed to one line, and the
// Objective of the live run marked. Every row, collapsed or not, has an anchor
// the `#cells/row/<objective>/<stratum>` link lands on. A side with no rows reads
// its `unread` on every row, and keeps a Stratum from collapsing, since its rows
// are not known; one whose `unread` is null has nothing to show, its cells are
// empty, and the Strata collapse on the sides that have rows.
export function policyRowsView({ sides, objective = null }) {
  const entries = (s) => (s.rows === null ? [] : OBJECTIVES.flatMap((o) => Object.values(s.rows[o])));
  const shared = sides.map((s) => {
    const seen = new Map();
    for (const e of entries(s)) seen.set(e.dispatch, (seen.get(e.dispatch) ?? 0) + 1);
    return [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  });
  const modelLine = sides.map((s) => {
    const checks = entries(s).flatMap((e) => e.candidates.map((c) => c.model)).filter((m) => m !== null);
    return checks.length > 0 && checks.every((m) => m.state === "differs") ? [...new Set(checks.map((m) => m.text))].join("; ") : null;
  });
  const show = (e, i) => ({
    ...e,
    dispatch: e.dispatch === shared[i] ? null : e.dispatch,
    candidates: e.candidates.map((c) => (c.model !== null && modelLine[i] !== null ? { ...c, model: { ...c.model, text: null } } : c)),
  });
  // How many sides have rows, and whether a Stratum none of them has a row for
  // may collapse: never while a side's rows are unknown.
  const read = sides.filter((s) => s.rows !== null).length;
  const collapsible = read > 0 && sides.every((s) => s.rows !== null || !s.unread);
  const cellOf = (s, e, i) => {
    if (s.rows === null) return s.unread ? { unread: s.unread } : { empty: true };
    if (e === null) return { follows: "no row of its own: follows *" };
    return show(e, i);
  };
  return {
    sides: sides.map((s, i) => ({ title: s.title, source: s.source, heading: s.heading, labels: s.labels ?? [], dispatch: shared[i], modelLine: modelLine[i], footnotes: s.footnotes })),
    objectives: OBJECTIVES.map((o) => ({
      objective: o,
      live: o === objective,
      lines: ["*", ...STRATA].map((stratum) => {
        const line = { stratum, anchor: `cells-row-${o}-${stratum}`, href: `#cells/row/${o}/${stratum}` };
        const own = sides.map((s) => s.rows?.[o]?.[stratum] ?? null);
        if (stratum !== "*" && collapsible && own.every((e) => e === null)) {
          return { ...line, collapsed: `${stratum}: ${read > 1 ? "no row on either side" : "no row"}, follows *` };
        }
        return { ...line, sides: sides.map((s, i) => cellOf(s, own[i], i)) };
      }),
    })),
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

// The guard's and the Preview fit's TSV blob ids against main's. `alert` is the
// alert while the records are not on main, else null; `note`, in its place, is
// a note under the guard section's heading: a check that could not run is never
// an alert, so an offline cockpit raises none. `main` is the carried read of
// `docs/metrics`, `{ value: { blobs }, readAt, error }`, `blobs` null for a 404.
// A guard that names no blob ids has nothing to compare, and neither has one
// whose cockpit read nothing (`main` null).
function recordsAgainstMain({ read, preview, main, closeoutPr, openPrs }) {
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

  const mine = preview?.status === "ok" ? preview.preview : null;
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
    const said = [guardId === undefined ? null : fitId === guardId ? `the guard and the Preview fit read ${blob8(guardId)}` : `the guard read ${blob8(guardId)}`,
      fitId === undefined || fitId === guardId ? null : `the Preview fit read ${blob8(fitId)}`].filter(Boolean);
    lines.push(`${path}: ${said.join(", ")}; main holds ${onMain === undefined ? "none" : blob8(onMain)}`);
  }
  if (lines.length === 0) return none;

  const both = guardDiffers && fitDiffers;
  const subject = both ? "the guard and the Preview fit" : guardDiffers ? "the guard" : "the Preview fit";
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
    if (!Number.isFinite(built)) return unchecked(`the ${guardDiffers ? "guard" : "Preview fit"} records no time it was computed`);
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
 * `modelRoles` the carried `{ value, readAt, error }` or null — `error` being
 * `{ at, message }`, and `pulls` this run's Pulls, one per card with a Cell line:
 * `{ issue, cell, mark, targets: [{ cell, generation }] }` (compute-board.mjs's
 * cellLine). `table` is the installed router table `validateTable` accepted or
 * null, `install` the install's `{ name, version, repository, error }`
 * (`repository` its url), `repoUrl` the workspace's, `objective` the live
 * run's Objective or null between runs, and `preview` the Preview fit as gather
 * read `.fleet/router-preview.json`: `{ status: "ok", preview: { computed_at,
 * guard_computed_at, tsv_blobs, prior, table } }`, `{ status: "missing" }` or
 * `{ status: "unreadable", why }`. An input left out reads as nothing
 * read: a missing guard, no receipt, no definitions, no `modelRoles` read, no
 * Pull, no table, no install, no Objective, no Preview fit.
 */
export function computeCellEvidence({ guard, receipts, agents, modelRoles = null, pulls = [], table = null, install = null, repoUrl = null, objective = null, preview = null,
  guardJson = null, mainMetrics = null, closeoutPr = null, openPrs = null, checkoutTable = null }) {
  const routed = guard?.status === "ok" ? readGuard(guard.guard) : null;
  const routes = routesNow({ table, guard: routed, modelRoles, install, repoUrl, checkout: checkoutTable });
  const favours = evidenceFavours({ preview, guard, routed, table, modelRoles, mark: superscript(routes.footnotes.length + 1) });
  const records = recordsAgainstMain({ read: guard, preview, main: mainMetrics, closeoutPr, openPrs });
  return {
    alerts: [records.alert, noRulingAlert(guard), readersAlert(guardJson)].filter((a) => a !== null),
    policy: policyRowsView({ sides: [routes, favours], objective }),
    guard: guardSection(guard, receipts, modelRoles, pulls, records.note),
    declared: declaredSection(agents, modelRoles),
  };
}
