#!/usr/bin/env node
// The per-ticket router: which implementer cell a Pull dispatches. One script
// for dispatch and for the offline fit, because the stratum rule is the one
// function that must never read differently between the two.
//
//   route [--session <dir|id>] [--objective cost|speed] --ticket <N> --arm A|B
//         --impl-row <k> --issue <issue.json> --guard <cost-guard.json>
//         [--sizing <sizing.json>] [--table <router-table.json>]
//         [--chain-head] [--pending <tsv>]
//     Prints one line, the Pull's Routing (ledger-grammar.mjs owns its
//     grammar): `POLICY=<cell> CELL=<cell> DRAW=<k/K|-> BY=<burn-in|every-5th|->
//     STRATUM=<light|heavy|unknown> BRIEF=<chars|-> CRITERIA=<n|-> PARENT=<N|->
//     SIZED=<light|heavy|-> OBJECTIVE=<cost|speed> TRIPPED=<cell,…|->
//     REASON=<reason>`,
//     routing by the objective's row set, and appends the Pull's
//     ticket-features row to the pending TSV (by default
//     `ticket-features.pending.tsv` beside `--guard`, in the run's `.fleet/`). Exit 0 on
//     every data degradation — a missing or unreadable issue, sizing or guard
//     file degrades the line, never the exit. Exit 2 only on a usage error or
//     an unreadable/invalid table: the caller does not dispatch then. With no
//     `--session`, the session is the one the phase-0 receipt
//     `.fleet/phase0.json` records, and with no `--objective` the objective
//     is; a receipt that records none is exit 2.
//   fit --table <json> --features <tsv> --members <tsv> --verdicts <tsv>
//       --guard <cost-guard.json> --commit <rev> [--due]
//     Re-fits the table from the three TSVs as committed at `--commit` (read
//     with `git show`, never from the working tree) and the guard, and
//     rewrites `--table`, recording the commit's sha as `fitted_commit`, then
//     prints the fit and one line per row of each objective's set: its cell
//     and the reason, then each candidate's verdict and range. The TSV flags name paths inside the
//     repository that holds them. With
//     `--due`, writes nothing and prints `DUE=yes|no MERGED=<n>/<N>`: whether
//     N merged PRs have landed since `fitted_commit`, counting the features
//     rows at `--commit` that the fitted commit's features file does not hold.
//   --check --table <json> --features <tsv> --members <tsv> --verdicts <tsv>
//     Re-fits from the commit the table records as `fitted_commit` (an empty
//     corpus while it is null), against the guard snapshot the table itself
//     records, and exits 1 when the result is not the table: the table is a
//     code carrier, never hand-edited. A `fitted_commit` this repository does
//     not hold exits 2 naming the `git fetch` that brings it.
//
// The script never touches the network: the issue, the sizing verdict and
// the guard are files the caller wrote, and a fitted commit is fetched by the
// caller.

import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isCLI } from "./is-cli.mjs";
import { gitEnv } from "./git-env.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { CELL, OBJECTIVES, POLICY_CELL, STRATA, drawCell, formatRouting, parseMember } from "./ledger-grammar.mjs";
import { objectiveFromReceipt, sessionFromReceipt } from "./phase0-receipt.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import {
  AttributionError, FEATURE_COLUMNS, OPTIONAL_COLUMNS, TRIP_POINTS, attribute, bootUnit, bootstrapDiffCI, generations, parseFeatures, tally, underFloor,
} from "./pull-attribution.mjs";
import { RulingError, parseTierOutcomes } from "./tier-outcomes.mjs";
import { briefPaths, briefText } from "./ticket-text.mjs";

const NAME = "ticket-router";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TABLE = join(SCRIPT_DIR, "router-table.json");

// The free classifier's thresholds: heavy past the median brief length of
// the tickets whose sizing verdict is known, or past five criteria.
export const HEAVY_BRIEF_CHARS = 3483;
export const HEAVY_CRITERIA = 5;
// Exploration cadence after burn-in: the Pull that creates `impl-` row 5k.
const EXPLORE_EVERY = 5;
// The fit's adoption floor (merged PRs per side), margin, and cadence.
export const MIN_N = 20;
const ADOPT_RATIO = 0.75;
export const FIT_EVERY_MERGED = 50;
// Stage 2 adds the effort cells on the roles whose stage-1 cell survived.
const STAGE2 = Object.freeze([{ cell: "slow-medium", survives: "slow-high" }, { cell: "task-max", survives: "task-high" }]);
const KINDS = new Set(["bug", "enhancement", "documentation"]);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// metrics — every one free, deterministic and known before dispatch
// ---------------------------------------------------------------------------

// A Slice names its parent at the top of its issue body: `Spec: #<N>` at the
// start of the first non-blank line, or a `## Parent` section the body opens
// with, whose first issue named (`#<N>` or an issue URL) is the parent.
const SPEC_LINE = /^Spec: #([1-9][0-9]*)(?![0-9])/;
const PARENT_HEADING = /^##\s+Parent\s*$/;
const HEADING = /^#{1,6}\s/;
const ISSUE_REF = /(?:^|[^\w/&])#([1-9][0-9]*)(?![0-9])|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/([1-9][0-9]*)(?![0-9])/;

/**
 * A Slice's parent issue number off its issue body, as a string, or "" when
 * the body makes no Slice. The body alone decides: a later `## Agent Brief`
 * comment leaves a Slice a Slice. `Spec #<N>` with no colon, a `## Parent`
 * section naming no issue and a `Part of #<N>` line make none.
 */
export function sliceParent(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() !== "");
  if (at === -1) return "";
  const spec = SPEC_LINE.exec(lines[at]);
  if (spec !== null) return spec[1];
  if (!PARENT_HEADING.test(lines[at])) return "";
  const end = lines.findIndex((l, i) => i > at && HEADING.test(l));
  const ref = ISSUE_REF.exec(lines.slice(at + 1, end === -1 ? undefined : end).join("\n"));
  return ref === null ? "" : ref[1] ?? ref[2];
}

/** The metric columns for a parsed `gh issue view --json title,body,comments,labels,createdAt`, or null when it is not one. */
export function issueMetrics(issue, now = Date.now()) {
  if (issue === null || typeof issue !== "object" || Array.isArray(issue) || typeof issue.body !== "string") return null;
  const brief = briefText(issue).trim();
  const lines = brief.split(/\r?\n/);
  const paths = briefPaths(brief);
  const created = Date.parse(issue.createdAt ?? "");
  const kind = (Array.isArray(issue.labels) ? issue.labels : []).map((l) => l?.name).find((n) => KINDS.has(n)) ?? "";
  return {
    brief_chars: String([...brief].length),
    criteria: String(lines.filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l)).length),
    comments: String(Array.isArray(issue.comments) ? issue.comments.length : 0),
    age_days: Number.isFinite(created) ? String(Math.max(0, Math.floor((now - created) / DAY_MS))) : "",
    paths: String(paths.length),
    test_paths: String(paths.filter((p) => /\.test\.|(^|\/)tests?\//.test(p)).length),
    xrefs: String(new Set([...brief.matchAll(/#(\d+)/g)].map((m) => m[1])).size),
    kind,
    parent: sliceParent(issue.body),
  };
}

/**
 * The `rule` classifier, over a row's metric columns: blank metrics are
 * `unknown`, a Slice (a row with a `parent`) is `heavy`, and any other row is
 * `heavy` past the brief length or the criteria count. A Slice whose metrics
 * are blank stays `unknown`, as it was routed: its issue was not read then.
 */
export function ruleStratum({ brief_chars, criteria, parent }) {
  if (brief_chars === "" || brief_chars === undefined || criteria === "" || criteria === undefined) return "unknown";
  if (parent) return "heavy";
  return Number(brief_chars) > HEAVY_BRIEF_CHARS || Number(criteria) > HEAVY_CRITERIA ? "heavy" : "light";
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

/** A parsed table, or an Error saying why it is not one. */
export function validateTable(t) {
  const bad = (why) => new Error(`router table: ${why}`);
  const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObject(t)) return bad("not a JSON object");
  if (!Array.isArray(t.cells) || t.cells.length === 0) return bad("`cells` is not a non-empty array");
  for (const c of t.cells) if (typeof c !== "string" || !CELL.test(c)) return bad(`\`cells\` holds ${JSON.stringify(c)}, not a cell token`);
  if (new Set(t.cells).size !== t.cells.length) return bad("`cells` repeats a cell");
  // `rows` and `reasons` are each keyed by objective, then by `*` or a stratum.
  for (const field of ["rows", "reasons"]) {
    if (!isObject(t[field])) return bad(`\`${field}\` is not an object`);
    const stray = Object.keys(t[field]).find((o) => !OBJECTIVES.includes(o));
    if (stray !== undefined) return bad(`\`${field}\` key ${JSON.stringify(stray)} is not an objective (${OBJECTIVES.join(", ")})`);
    for (const o of OBJECTIVES) {
      const set = t[field][o];
      if (!isObject(set)) return bad(`\`${field}.${o}\` is not an object`);
      for (const k of Object.keys(set)) {
        if (k !== "*" && !STRATA.includes(k)) return bad(`\`${field}.${o}\` key ${JSON.stringify(k)} is not \`*\` or a stratum`);
      }
    }
  }
  for (const o of OBJECTIVES) {
    if (!Object.hasOwn(t.rows[o], "*")) return bad(`\`rows.${o}\` has no \`*\` row`);
    for (const [k, v] of Object.entries(t.rows[o])) {
      if (typeof v !== "string" || !CELL.test(v)) return bad(`\`rows.${o}.${k}\` is ${JSON.stringify(v)}, not a cell token`);
    }
  }
  if (typeof t.burn_in !== "boolean") return bad("`burn_in` is not a boolean");
  if (!Number.isInteger(t.stage) || t.stage < 1) return bad("`stage` is not a positive integer");
  const cl = t.classifier;
  if (cl === null || typeof cl !== "object") return bad("`classifier` is not an object");
  if (cl.b !== null && cl.b !== "haiku" && cl.b !== "jev") return bad("`classifier.b` is not null, \"haiku\" or \"jev\"");
  if (cl.tau !== null && typeof cl.tau !== "number") return bad("`classifier.tau` is not null or a number");
  const g = t.guard;
  if (g === null || typeof g !== "object" || !Array.isArray(g.tripped) || g.n === null || typeof g.n !== "object") {
    return bad("`guard` is not `{ tripped: [], n: {} }`");
  }
  return t;
}

/**
 * Arm B runs only once a classifier has passed its gate and some row of the
 * run's own objective's set is not the default: it decides a paid classifier
 * call for one Pull, which the other set's rows never route.
 */
export function bArmLive(table, objective) {
  return table.classifier.b !== null && Object.values(table.rows[objective]).some((c) => c !== POLICY_CELL);
}

/** The row a stratum routes by: its own, else the `*` row's. */
export const rowFor = (rows, stratum) => rows[stratum] ?? rows["*"];

/**
 * What `route` does with one row under one guard, with no per-Pull input.
 * `guard` is readGuard's answer or null. `policy` is the row's Cell, or the
 * default cell when there is no guard or the row's Cell is tripped; `reason`
 * is `guard-missing`, `table-cell-tripped` or `ok`. `draw` is what an
 * exploring Pull picks from — `by` `burn-in` (every Pull) or `every-5th` —
 * over `cells`: the table's Cells less the tripped, and on an every-5th draw
 * less the `cost` row's Cell for the stratum too, as the guard leaves it (the
 * default cell when that row's Cell is tripped), whichever objective routes
 * the row. It is null with no guard and when no Cell is left to draw.
 * @returns {{ policy: string, reason: "guard-missing"|"table-cell-tripped"|"ok", draw: null | { by: "burn-in"|"every-5th", cells: string[] } }}
 */
export function rowDispatch({ table, guard, objective, stratum }) {
  if (guard === null) return { policy: POLICY_CELL, reason: "guard-missing", draw: null };
  const tripped = new Set(guard.tripped);
  const adjust = (cell) => (tripped.has(cell) ? POLICY_CELL : cell);
  const row = rowFor(table.rows[objective], stratum);
  const by = table.burn_in ? "burn-in" : "every-5th";
  const left = table.cells.filter((c) => !tripped.has(c));
  const cells = table.burn_in ? left : left.filter((c) => c !== adjust(rowFor(table.rows.cost, stratum)));
  return {
    policy: adjust(row),
    reason: tripped.has(row) ? "table-cell-tripped" : "ok",
    draw: cells.length > 0 ? { by, cells } : null,
  };
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

function readJson(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** `cost-guard.json` reduced to what the router reads, or null when missing or unparseable. */
export function readGuard(raw) {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.tripped) || !Array.isArray(raw.cells)) return null;
  const tripped = raw.tripped.map((t) => (typeof t === "string" ? t : t?.cell));
  if (tripped.some((t) => typeof t !== "string" || !CELL.test(t))) return null;
  const n = {};
  for (const c of raw.cells) {
    if (typeof c?.cell !== "string" || !Number.isFinite(c?.n)) return null;
    n[c.cell] = c.n;
  }
  return { tripped: [...new Set(tripped)].sort(), n, window_start: typeof raw.window_start === "string" ? raw.window_start : null };
}

/** The sizing verdict on a live B Pull: `{ stratum, src, label, usd }`, or null when it is unusable. */
function readSizing(raw, classifier) {
  if (raw === null || typeof raw !== "object" || raw.source !== classifier.b) return null;
  const label = raw.label === "light" || raw.label === "heavy" ? raw.label : null;
  if (label === null) return null;
  const abstains = raw.source === "jev" && classifier.tau !== null && !(Number(raw.confidence) >= classifier.tau);
  return {
    stratum: abstains ? "unknown" : label,
    src: raw.source === "jev" ? `jev:${raw.model ?? ""}` : "haiku",
    label,
    usd: Number.isFinite(raw.usd) ? String(raw.usd) : "",
  };
}

/** The UTC date an omp session id (`<ISO>_<uuid>`) starts with, else blank. */
export function sessionDate(session) {
  return /^(\d{4}-\d{2}-\d{2})T/.exec(session)?.[1] ?? "";
}

/**
 * One Pull's routing, by `objective`'s row set. Pure: every input is already
 * read. The exploration draw ignores the objective: it leaves out the cell
 * the `cost` set routes the Pull to — by the sizing when arm B is live for
 * the `cost` set, whichever set routes the Pull — so a Pull draws the same
 * cell under both.
 * @returns {{ line: string, row: Record<string,string> }}
 */
export function route({ session, ticket, arm, implRow, chainHead = false, issue, sizing = null, guard, table, objective, now = Date.now() }) {
  let reason = null;
  const degrade = (r) => { reason ??= r; };

  const metrics = issueMetrics(issue, now);
  if (metrics === null) degrade("no-issue-json");
  const blank = Object.fromEntries(["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "kind", "parent"].map((c) => [c, ""]));
  const m = metrics ?? blank;
  const ruleS = ruleStratum(m);

  let stratum = ruleS;
  let sizingSrc = "rule";
  let sizingPre = "";
  let routerUsd = "";
  const sized = arm === "B" ? readSizing(sizing, table.classifier) : null;
  const b = arm === "B" && bArmLive(table, objective);
  if (b) {
    const s = sized;
    if (s === null) {
      degrade("no-sizing");
      stratum = "unknown";
      sizingSrc = "";
    } else {
      ({ stratum, src: sizingSrc, label: sizingPre, usd: routerUsd } = s);
    }
  }

  const dispatch = (o, s) => rowDispatch({ table, guard, objective: o, stratum: s });
  const policyRow = dispatch(objective, ruleS);
  const baseRow = b ? dispatch(objective, stratum) : policyRow;
  const costB = arm === "B" && bArmLive(table, "cost");
  const drawRow = dispatch("cost", costB ? sized?.stratum ?? "unknown" : ruleS);
  for (const r of [policyRow.reason, baseRow.reason]) if (r !== "ok") degrade(r);
  // With no guard the default cell is the only one: the guard cannot be
  // evaded by deleting it.
  const policy = policyRow.policy;
  let cell = baseRow.policy;
  let draw = null;
  let by = null;
  if (guard !== null) {
    const exploring = table.burn_in || (implRow % EXPLORE_EVERY === 0 && !chainHead);
    if (exploring) {
      const policyCell = table.burn_in ? null : drawRow.policy;
      if (table.cells.some((c) => c !== policyCell && guard.tripped.includes(c))) degrade("guard-tripped");
      if (drawRow.draw !== null) {
        // rowDispatch already left the policy Cell out of `cells`: nothing more to withhold.
        const d = drawCell({ session, ticket, policyCell: null, cells: drawRow.draw.cells });
        cell = d.cell;
        draw = { k: d.k, K: d.K };
        by = drawRow.draw.by;
      }
    }
  }
  reason ??= "ok";

  const row = {
    run_date: sessionDate(session), session, agent: `impl-${ticket}`, ticket: String(ticket),
    policy_cell: policy, chosen_cell: cell, exploration_draw: draw === null ? "" : `${draw.k}/${draw.K}`,
    sizing_src: sizingSrc, sizing_pre: sizingPre, router_usd: routerUsd, ...m, objective,
  };
  const line = formatRouting({
    policy, cell, draw, by, stratum,
    brief: metrics === null ? null : Number(metrics.brief_chars), criteria: metrics === null ? null : Number(metrics.criteria),
    parent: m.parent === "" ? null : Number(m.parent),
    sized: sizingPre === "" ? null : sizingPre, objective, tripped: guard?.tripped ?? [], reason,
  });
  return { line, row };
}

// `columns` is the header of the file the row joins: a pending file a run
// began before a column was added keeps its own width.
export function formatFeatureRow(row, columns = FEATURE_COLUMNS) {
  return columns.map((c) => String(row[c] ?? "").replace(/[\t\r\n]/g, " ")).join("\t");
}

// ---------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------

const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * The fit's Pulls: pull-attribution.mjs's units over the window — booked as
 * routed, each to its own row's cell and stratum — restricted to rows the free
 * classifier routed plus exploration rows: a row a live B classifier routed is
 * the A/B's test set, not the fit's. The fit sees no PR state, so a Pull with
 * a Ruling is merged. A fit reads everything in the commit it is given: no row
 * is cut by date, because `--check` re-reads that same commit rather than
 * re-cutting the working tree's files. `order` ranks each cell's generations
 * over every Pull in the window, the restriction aside, so the fit names the
 * same newest generation the guard does.
 */
function fitPulls({ features, members, verdicts, window }) {
  const all = attribute({ features, members, tiers: verdicts, windowStart: window || null, stratum: ruleStratum });
  return { units: all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule"), order: generations(all) };
}

// Per stratum and `*`, per cell, its newest generation's figures: `n` counted
// Pulls, `merged`, $ per merged PR, minutes of work time per merged PR, false
// claims over claims, fix rounds per merged PR, `by_hand` (the counted merged Pulls whose
// Ruling was given by hand), and its left-out, unpriced and
// untimed Pull counts. Both per merged PR figures take every counted Pull,
// merged or not, over the merged ones. Beside them the cell's
// excluded Pull count, `generation` naming the newest generation's model, and
// `older`, each older generation's model to its figures, newest first. Beside
// `estimates`, `pulls`: per stratum and `*`, per cell, the newest generation's
// counted Pulls those figures are over.
function estimate(units, order) {
  const estimates = {};
  const pulls = {};
  for (const s of units.length ? [...new Set([...units.map((u) => u.stratum), "*"])].sort() : []) {
    const mine = s === "*" ? units : units.filter((u) => u.stratum === s);
    estimates[s] = {};
    pulls[s] = {};
    for (const t of tally(mine, order)) {
      const figures = (g) => {
        const fix = g.pulls.filter((u) => u.merged)
          .reduce((n, u) => n + u.rows.filter((r) => parseMember(r.member)?.family === "fix-pr").length, 0);
        return {
          n: g.n,
          merged: g.merged,
          by_hand: g.by_hand,
          claims: g.claims,
          failed: g.failed,
          usd_per_merged: g.merged ? round4(g.spend / g.merged) : null,
          minutes_per_merged: g.merged ? round4(g.workS / 60 / g.merged) : null,
          fail_rate: g.claims ? round4(g.failed / g.claims) : null,
          fix_rounds: g.merged ? round4(fix / g.merged) : null,
          review_findings: null,
          left_out: g.left_out,
          unpriced: g.unpriced,
          untimed: g.untimed,
        };
      };
      estimates[s][t.cell] = {
        generation: t.generation,
        ...figures(t),
        excluded: t.excluded,
        older: Object.fromEntries(t.older.map((o) => [o.generation, figures(o)])),
      };
      pulls[s][t.cell] = t.pulls;
    }
  }
  return { estimates, pulls };
}

// What each objective's judge reads and says: the figure per merged PR it
// minimises (`estimate()`'s name and its bootstrap metric), its verdict for a
// candidate past the margin and for one with no reliable difference, the key
// a pair names its better side by, and its reasons for a winner every other
// qualifier was reliably worse than and for one ahead on the figure.
const JUDGE = Object.freeze({
  cost: {
    figure: "usd_per_merged", metric: "usd", over: "too-dear", unreliable: "not-reliably-cheaper",
    better: "cheaper", reliably: "reliably-cheaper", ahead: "lower-usd",
  },
  speed: {
    figure: "minutes_per_merged", metric: "minutes", over: "too-slow", unreliable: "not-reliably-faster",
    better: "faster", reliably: "reliably-faster", ahead: "fewer-minutes",
  },
});

// A row's record with no cell: a fresh object each time, since judge() fills
// in `cells` and `pairs`.
const unjudged = () => ({ cell: null, reason: "unjudged", cells: {}, pairs: [] });

/**
 * One row's cell under one objective — the `*` row's or a stratum's — and
 * why. The quality floor is held twice: pooled by the guard, whose trip takes
 * a cell out of every row and out of the exploration draw, and per row by the
 * fit, which refuses a cell under the floor that row alone. The floor is
 * measured against the default cell under both objectives. Every figure read
 * is the cell's newest generation's, the default cell's included. `est` and
 * `pulls` are the row's `estimate()` figures and counted Pulls; `baseCell` is
 * the cell the row holds unless a candidate qualifies: the default cell under
 * `cost`, the `cost` row's cell under `speed`. The figure is $ per merged PR
 * under `cost` and minutes of work time per merged PR under `speed`.
 *
 * A candidate is a cell of `cells` other than the base. Its `verdict`, the
 * first that applies: `tripped` by the guard; `too-few`, under MIN_N merged
 * PRs in the row; `under-floor` against the default cell there; `too-dear`
 * (`cost`) or `too-slow` (`speed`), above ADOPT_RATIO of the base's figure;
 * `not-reliably-cheaper` or `not-reliably-faster`, its `range` does not lie
 * wholly below zero (its upper end, as `bootstrapDiffCI` returns it, is not
 * below zero) or there is none; else it `qualifies`. A candidate past
 * `too-few` records whether it is `under_floor`, the floor's `bar` (the
 * default cell's fail rate plus TRIP_POINTS, rounded as a fail rate is, for
 * reading only: the floor compares counts) and its `range`, the bootstrap 95%
 * range of (candidate − base) figure over those Pulls; the others record null
 * for each.
 *
 * Several qualifiers: each pair records the range of (the better by the
 * figure, else by name − the other) in `pairs`, naming the better side
 * `cheaper` or `faster`, and a qualifier another is reliably better than is
 * dropped. Among the rest the lower fail rate, compared in counts, wins, then
 * the lower figure, then the name.
 *
 * `reason`, why the row holds `cell`: `unjudged` (the default cell or the
 * base, or every untripped candidate, is under MIN_N merged PRs; `cell` is
 * null), `no-qualifier` (the base), or, for the winner, `sole-qualifier`,
 * `reliably-cheaper` or `reliably-faster` (every other qualifier was
 * dropped), or what put it ahead of the next of the rest: `lower-fail-rate`,
 * `lower-usd` or `fewer-minutes`, or `name`.
 */
function judge(objective, est = {}, pulls, cells, tripped, baseCell) {
  const { figure, metric, over, unreliable, better, reliably, ahead } = JUDGE[objective];
  const record = unjudged();
  const floor = est[POLICY_CELL];
  const base = est[baseCell];
  if (!floor || floor.merged < MIN_N || !base || base.merged < MIN_N) return record;
  // JSON writes −0 as 0, so a recorded end is 0 either way; `--check` compares the two.
  const units = (c) => pulls[c].map((u) => bootUnit(u, metric));
  const range = (a, b) => bootstrapDiffCI(units(a), units(b))?.map((x) => x + 0) ?? null;
  const reliablyBelow = (r) => r !== null && r[1] < 0;
  const bar = round4(floor.failed / floor.claims + TRIP_POINTS / 100);
  const qualifiers = [];
  let judged = false;
  for (const c of cells) {
    if (c === baseCell) continue;
    const e = est[c];
    if (tripped.has(c) || !e || e.merged < MIN_N) {
      record.cells[c] = { verdict: tripped.has(c) ? "tripped" : "too-few", under_floor: null, bar: null, range: null };
      continue;
    }
    judged = true;
    const under = underFloor(e, floor);
    const r = range(c, baseCell);
    const verdict = under ? "under-floor"
      : e[figure] > ADOPT_RATIO * base[figure] ? over
        : reliablyBelow(r) ? "qualifies" : unreliable;
    record.cells[c] = { verdict, under_floor: under, bar, range: r };
    if (verdict === "qualifies") qualifiers.push(c);
  }
  if (!judged) return record;
  if (qualifiers.length === 0) return { ...record, cell: baseCell, reason: "no-qualifier" };

  const of = (c) => est[c][figure];
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const failCmp = (a, b) => est[a].failed * est[b].claims - est[b].failed * est[a].claims;
  const named = [...qualifiers].sort(byName);
  const dropped = new Set();
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [win, other] = of(named[j]) < of(named[i]) ? [named[j], named[i]] : [named[i], named[j]];
      const r = range(win, other);
      record.pairs.push({ [better]: win, other, range: r });
      if (reliablyBelow(r)) dropped.add(other);
    }
  }
  // The best qualifier, by the figure then name, is never dropped, so the rest is never empty.
  const [win, next] = named.filter((c) => !dropped.has(c)).sort((a, b) => failCmp(a, b) || of(a) - of(b) || byName(a, b));
  const reason = qualifiers.length === 1 ? "sole-qualifier"
    : next === undefined ? reliably
      : failCmp(win, next) !== 0 ? "lower-fail-rate"
        : of(win) !== of(next) ? ahead : "name";
  return { ...record, cell: win, reason };
}

/** A `cost` row: `judge()` from the default cell, by $ per merged PR. */
function judgeRow(est, pulls, cells, tripped) {
  return judge("cost", est, pulls, cells, tripped, POLICY_CELL);
}

/** A `speed` row: `judge()` from the `cost` row's cell, by minutes of work time per merged PR. */
function judgeSpeedRow(est, pulls, cells, tripped, costCell) {
  return judge("speed", est, pulls, cells, tripped, costCell);
}

/**
 * The re-fit table. `guard` is `{ tripped, n, window_start }` (readGuard's
 * shape); `commit` is the sha of the commit the inputs were read from, or null
 * for the empty corpus before any fit. `rows` and `reasons` hold one set per
 * objective. `reasons.cost` holds `judgeRow()`'s record for `*` and for each
 * stratum with Pulls; a stratum whose record has no cell gets no `cost` row
 * and follows `*`, and an unjudged `*` is the default cell. `reasons.speed`
 * holds `judgeSpeedRow()`'s record for each row with a `cost` row, from that
 * row's cell, and an `unjudged` record with no cell for each stratum with no
 * `cost` row: a row with a `cost` row holds a `speed` row, the base when the
 * record has no cell, and a stratum with no `cost` row has no `speed` row
 * and follows `*`.
 */
export function fitTable({ prior, features, members, verdicts, guard, commit = null }) {
  const window = guard.window_start ?? prior.window_start ?? null;
  const { units, order } = fitPulls({ features, members, verdicts, window });
  const { estimates, pulls } = estimate(units, order);
  const tripped = new Set(guard.tripped);

  let { stage, cells } = prior;
  cells = [...cells];
  const star = judgeRow(estimates["*"], pulls["*"], cells, tripped);
  const rows = { cost: { "*": star.cell ?? POLICY_CELL }, speed: {} };
  const reasons = { cost: { "*": { ...star, cell: rows.cost["*"] } }, speed: {} };
  for (const s of STRATA) {
    if (!estimates[s]) continue;
    reasons.cost[s] = judgeRow(estimates[s], pulls[s], cells, tripped);
    if (reasons.cost[s].cell !== null) rows.cost[s] = reasons.cost[s].cell;
  }
  for (const s of Object.keys(reasons.cost)) {
    const costCell = rows.cost[s];
    if (costCell === undefined) {
      reasons.speed[s] = unjudged();
      continue;
    }
    const record = judgeSpeedRow(estimates[s], pulls[s], cells, tripped, costCell);
    rows.speed[s] = record.cell ?? costCell;
    reasons.speed[s] = { ...record, cell: rows.speed[s] };
  }
  const atN = (c) => (guard.n[c] ?? 0) >= MIN_N;
  const adopted = Object.values(rows).some((set) => set["*"] !== POLICY_CELL);
  if (stage === 1 && cells.every(atN) && (adopted || cells.some((c) => tripped.has(c)))) {
    stage = 2;
    for (const { cell, survives } of STAGE2) {
      if (!cells.includes(cell) && cells.includes(survives) && !tripped.has(survives)) cells.push(cell);
    }
  }
  return {
    window_start: window,
    fitted_commit: commit,
    n_rows: units.length,
    stage,
    cells,
    burn_in: !cells.every(atN),
    rows,
    classifier: prior.classifier,
    estimates,
    reasons,
    guard: { tripped: [...tripped].sort(), n: Object.fromEntries(Object.keys(guard.n).sort().map((c) => [c, guard.n[c]])) },
  };
}

/**
 * Merged PRs since the fit: pull-attribution.mjs's counted, merged Pulls on or
 * after `window_start` whose features row the fitted commit's features file
 * (`fitted`, parsed rows; empty before any fit) does not hold, matched by
 * `session` and `agent`.
 */
export function mergedSince({ table, features, members, verdicts, fitted }) {
  const read = new Set(fitted.map((r) => `${r.session}\0${r.agent}`));
  return attribute({ features, members, tiers: verdicts, windowStart: table.window_start || null })
    .filter((u) => u.status === "counted" && u.merged && !read.has(`${u.pull.session}\0${u.pull.agent}`)).length;
}

// Each cell's Pull counts over every stratum, as the fit prints them: its
// newest generation, then each older one.
function cellCounts(estimates) {
  const two = (x) => (x === null ? "-" : x.toFixed(2));
  const counts = (e) => `n=${e.n} merged=${e.merged} failed=${e.failed} usd_per_merged=${two(e.usd_per_merged)} minutes_per_merged=${two(e.minutes_per_merged)}`;
  return Object.entries(estimates["*"] ?? {})
    .map(([c, e]) => [
      `${c} ${e.generation ?? "-"} ${counts(e)} excluded=${e.excluded} left_out=${e.left_out} unpriced=${e.unpriced} untimed=${e.untimed}`,
      ...Object.entries(e.older).map(([g, o]) => `${c} ${g} (older) ${counts(o)}`),
    ].join(", "))
    .join(", ") || "none";
}

// One line per row the fit judged or skipped, per objective: its cell (`-`
// for a stratum that follows `*`) and its reason, then each candidate's
// verdict and range.
function rowLines(reasons) {
  const range = (r) => (r === null ? "" : ` [${r.map((x) => x.toFixed(2)).join(", ")}]`);
  return Object.entries(reasons).flatMap(([o, set]) => Object.entries(set).map(([s, r]) => {
    const cells = Object.entries(r.cells).map(([c, x]) => `${c} ${x.verdict}${range(x.range)}`).join(", ");
    return `${NAME}: row ${o} ${s} ${r.cell ?? "-"} ${r.reason}${cells ? ` (${cells})` : ""}\n`;
  })).join("");
}

// ---------------------------------------------------------------------------
// the commit a fit reads
// ---------------------------------------------------------------------------

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// `git` run in the directory holding `path`, so `path` names a file of the
// repository around it whichever directory the caller is in.
function gitBeside(path, args) {
  const r = spawnSync("git", ["-C", dirname(resolve(path)), ...args], { encoding: "utf8", env: gitEnv(), maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return r;
}

/**
 * The full sha `rev` names as a commit in the repository holding `path`, or null when it names none there.
 * Throws when git itself fails (not a repository, unreadable config, no git): that is not an answer about `rev`.
 */
export function resolveCommit(path, rev) {
  if (rev.startsWith("-")) return null;
  const r = gitBeside(path, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (r.status === 0) return r.stdout.trim();
  // `--verify --quiet` exits 1, silently, for a rev that names no commit; any other status is git failing.
  if (r.status === 1) return null;
  throw new Error(r.stderr.trim() || `git rev-parse exited ${r.status}`);
}

/** `path` as committed at `sha`; throws when the commit does not hold it. */
export function showAt(sha, path) {
  const r = gitBeside(path, ["show", `${sha}:./${basename(path)}`]);
  if (r.status !== 0) throw new Error(r.stderr.trim() || `git show exited ${r.status}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, {
    flags: {
      session: "value", objective: "value", ticket: "value", arm: "value", "impl-row": "value", issue: "value",
      sizing: "value", guard: "value", table: "value", pending: "value", "chain-head": "bool",
      features: "value", members: "value", verdicts: "value", commit: "value", check: "bool", due: "bool",
    },
    positionals: ["route", "fit"],
  });
  F.sweep();
  F.stray();
  const argv = process.argv.slice(2);
  const mode = F.has("check") ? "check" : argv.find((a) => a === "route" || a === "fit");
  if (!mode || (F.has("check") && argv.some((a) => a === "route" || a === "fit"))) {
    die("usage: ticket-router.mjs route … | fit … | --check … — exactly one mode");
  }
  const allowed = {
    route: ["session", "objective", "ticket", "arm", "impl-row", "issue", "sizing", "guard", "table", "pending", "chain-head"],
    fit: ["table", "features", "members", "verdicts", "guard", "commit", "due"],
    check: ["check", "table", "features", "members", "verdicts"],
  }[mode];
  const given = argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")[0]);
  const foreign = given.find((g) => !allowed.includes(g));
  if (foreign) die(`--${foreign} does not apply to ${mode === "check" ? "--check" : mode}`);
  const need = (name) => F.arg(name) ?? die(`${mode === "check" ? "--check" : mode} needs --${name}`);

  const tablePath = mode === "route" ? (F.arg("table") ?? DEFAULT_TABLE) : need("table");
  let table;
  try { table = JSON.parse(readFileSync(tablePath, "utf8")); } catch (e) { die(`cannot read the router table ${tablePath}: ${e.message}`); }
  const valid = validateTable(table);
  if (valid instanceof Error) die(`${tablePath}: ${valid.message}`);

  if (mode === "route") {
    const ticket = need("ticket");
    if (!/^[1-9][0-9]*$/.test(ticket)) die(`--ticket ${ticket} is not an issue number`);
    const arm = need("arm");
    if (arm !== "A" && arm !== "B") die(`--arm ${arm} is not A or B`);
    const implRowArg = need("impl-row");
    if (!/^[1-9][0-9]*$/.test(implRowArg)) die(`--impl-row ${implRowArg} is not a positive row count`);
    const issuePath = need("issue");
    const guardPath = need("guard");
    // `--session` omitted is the session directory the phase-0 receipt
    // records; a receipt that records none is a usage error naming it.
    let sessionArg = F.arg("session");
    if (sessionArg === null) {
      try { sessionArg = sessionFromReceipt(); } catch (e) { die(e.message); }
    }
    const session = basename(sessionArg.replace(/\/+$/, ""));
    // `--objective` omitted is the one the receipt records, likewise.
    let objective = F.arg("objective");
    if (objective === null) {
      try { objective = objectiveFromReceipt(); } catch (e) { die(e.message); }
    } else if (!OBJECTIVES.includes(objective)) {
      die(`--objective ${objective} is not ${OBJECTIVES.join(" or ")}`);
    }
    const { line, row } = route({
      session, ticket: Number(ticket), arm, implRow: Number(implRowArg), chainHead: F.has("chain-head"),
      issue: readJson(issuePath), sizing: readJson(F.arg("sizing")), guard: readGuard(readJson(guardPath)), table, objective,
    });
    const pending = F.arg("pending") ?? join(dirname(guardPath), "ticket-features.pending.tsv");
    // The header decision and the append are not atomic and take no lock. That is
    // safe only while the run's controller is the only process that routes or
    // drains on a checkout, doing both serially: one controller per checkout is
    // the rule, and neither this append nor the drain checks it. A pending file
    // already begun keeps its header's columns, so a plugin updated mid-run
    // never appends a row wider or narrower than the file. A first line that is
    // no features header — a required column missing, or a name no features
    // file carries — is refused, not appended against.
    try {
      mkdirSync(dirname(pending), { recursive: true });
      const had = statSync(pending, { throwIfNoEntry: false })?.size > 0 ? readFileSync(pending, "utf8").split("\n", 1)[0].split("\t") : null;
      if (had !== null) {
        const missing = FEATURE_COLUMNS.filter((c) => !had.includes(c) && !OPTIONAL_COLUMNS.has(c));
        const unknown = had.filter((c) => !FEATURE_COLUMNS.includes(c));
        if (missing.length || unknown.length) {
          const why = [missing.length ? `lacks ${missing.join(", ")}` : "", unknown.length ? `names ${unknown.map((c) => JSON.stringify(c)).join(", ")}` : ""];
          throw new Error(`its first line is no ticket-features header: it ${why.filter(Boolean).join(" and ")}`);
        }
      }
      const header = had === null ? `${FEATURE_COLUMNS.join("\t")}\n` : "";
      appendFileSync(pending, `${header}${formatFeatureRow(row, had ?? FEATURE_COLUMNS)}\n`);
    } catch (e) {
      process.stderr.write(`${NAME}: WARNING could not append to ${pending}: ${e.message} — this Pull's ticket-features row is not recorded\n`);
    }
    process.stdout.write(`${line}\n`);
    return;
  }

  const short = (sha) => (sha === null ? "no commit" : sha.slice(0, 8));
  const fileAt = (sha, flag, parse) => {
    const p = need(flag);
    try { return parse(showAt(sha, p)); } catch (e) { die(`cannot read --${flag} ${p} at commit ${short(sha)}: ${e.message}`); }
  };
  // The three TSVs as committed at `sha`, never the working tree's copies.
  const corpusAt = (sha) => ({
    features: fileAt(sha, "features", parseFeatures),
    members: fileAt(sha, "members", parseMemberTsv),
    verdicts: fileAt(sha, "verdicts", parseTierOutcomes),
  });
  // The commit `rev` names in the repository holding --features, or null; git itself failing is a die, not "no such commit".
  const commitOf = (rev) => {
    try { return resolveCommit(need("features"), rev); } catch (e) { die(`cannot resolve ${rev} in the repository holding --features ${need("features")}: ${e.message}`); }
  };
  // The commit the table records: null before any fit, else a sha this repository holds.
  const fittedCommit = () => {
    const sha = table.fitted_commit;
    if (sha === null) return null;
    if (typeof sha !== "string" || !SHA.test(sha)) die(`${tablePath}: \`fitted_commit\` is not null or a full commit sha`);
    if (commitOf(sha) === null) {
      die(`${tablePath} was fitted from commit ${sha}, which this repository does not hold — run \`git fetch --depth=1 origin ${sha}\``);
    }
    return sha;
  };
  // The join throws on a features row it cannot date, a booked member row whose `cost` or `work_s` is not a number, and a
  // ruling of a windowed Pull's ticket it cannot place — for `fit` and `--check` too on a Pull the fit then skips
  // as a live B classifier's, since every windowed Pull is booked before that skip. Anything else it throws is a
  // bug, never bad input, so it surfaces with its stack.
  const joined = (fit) => {
    try { return fit(); } catch (e) {
      if (!(e instanceof RulingError || e instanceof AttributionError)) throw e;
      die(`cannot join --features ${need("features")}, --members ${need("members")} and --verdicts ${need("verdicts")}: ${e.message}`);
    }
  };

  if (mode === "check") {
    for (const flag of ["features", "members", "verdicts"]) need(flag);
    const fitted = fittedCommit();
    const { features, members, verdicts } = fitted === null ? { features: [], members: [], verdicts: [] } : corpusAt(fitted);
    const refit = joined(() => fitTable({ prior: table, features, members, verdicts, guard: { ...table.guard, window_start: table.window_start }, commit: fitted }));
    const differ = Object.keys({ ...refit, ...table }).filter((k) => !isDeepStrictEqual(refit[k], table[k]));
    if (differ.length) {
      process.stderr.write(`${NAME}: ${tablePath} is not a re-fit of its own rows — differs in ${differ.map((k) => `\`${k}\``).join(", ")}; re-fitted:\n${JSON.stringify(refit, null, 2)}\n`);
      // exitCode, not exit(): a piped stderr is written asynchronously and exit() can cut the payload off.
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${NAME}: ${tablePath} matches a re-fit of ${refit.n_rows} Pulls at ${short(fitted)}\n`);
    return;
  }

  const commitArg = need("commit");
  const sha = commitOf(commitArg);
  if (sha === null) die(`--commit ${commitArg} is not a commit of the repository holding --features ${need("features")}`);
  const { features, members, verdicts } = corpusAt(sha);
  const guardPath = need("guard");
  const guard = readGuard(readJson(guardPath));
  if (guard === null) die(`cannot read --guard ${guardPath} as a cost guard — the fit needs its tripped cells and per-cell n`);
  if (F.has("due")) {
    const fitted = fittedCommit();
    const read = fitted === null ? [] : fileAt(fitted, "features", parseFeatures);
    const n = joined(() => mergedSince({ table, features, members, verdicts, fitted: read }));
    process.stdout.write(`DUE=${n >= FIT_EVERY_MERGED ? "yes" : "no"} MERGED=${n}/${FIT_EVERY_MERGED}\n`);
    return;
  }
  const next = joined(() => fitTable({ prior: table, features, members, verdicts, guard, commit: sha }));
  writeFileSync(`${tablePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${tablePath}.tmp`, tablePath);
  process.stdout.write(`${NAME}: fitted ${next.n_rows} Pulls at ${short(sha)}; rows ${JSON.stringify(next.rows)}; burn_in ${next.burn_in}; stage ${next.stage}; cells ${cellCounts(next.estimates)}\n${rowLines(next.reasons)}`);
}

if (isCLI(import.meta.url)) main();
