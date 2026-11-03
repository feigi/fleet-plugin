#!/usr/bin/env node
// The per-ticket router: which implementer cell a Pull dispatches. One script
// for dispatch and for the offline fit, because the walk from a ticket's inputs
// to its group is the one function that must never read differently between
// the two.
//
//   route [--session <dir|id>] [--objective cost|speed] --ticket <N> --arm A|B
//         --impl-row <k> --issue <issue.json> --guard <cost-guard.json>
//         [--sizing <sizing.json>] [--table <router-table.json>]
//         [--chain-head] [--pending <tsv>]
//     Prints one line, the Pull's Routing (ledger-grammar.mjs owns its
//     grammar): `POLICY=<cell> CELL=<cell> DRAW=<k/K|-> BY=<burn-in|every-5th|->
//     STRATUM=<rule path> BRIEF=<chars|-> CRITERIA=<n|-> PARENT=<N|->
//     SIZED=<light|heavy|-> OBJECTIVE=<cost|speed> TRIPPED=<cell,…|->
//     REASON=<reason>`,
//     routing by the objective's row set, and appends the Pull's
//     ticket-features row to the pending TSV (by default
//     `ticket-features.pending.tsv` beside `--guard`, in the run's `.fleet/`).
//     With no `--table` it routes by the Fit, `router-fit.json` beside
//     `--guard`, which metrics-refresh.mjs writes at phase 0. A Fit that is
//     absent, unreadable, unparseable or fails validateTable routes by the
//     starting table beside the script instead, and `REASON` names why:
//     `fit-missing`, `fit-unreadable` or `fit-invalid`. A missing guard routes
//     the default cell whatever the table, so it names no Fit there.
//     The paths its brief names are looked up under the working directory,
//     the checkout, for `named_lines`. Exit 0 on every data degradation — a
//     missing or unreadable issue, sizing or guard file degrades the line,
//     never the exit. Exit 2 only on a usage error or
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

import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isCLI } from "./is-cli.mjs";
import { gitEnv } from "./git-env.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { CELL, OBJECTIVES, POLICY_CELL, drawCell, formatRouting, isRulePath, parseMember } from "./ledger-grammar.mjs";
import { objectiveFromReceipt, sessionFromReceipt } from "./phase0-receipt.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import {
  AttributionError, FEATURE_COLUMNS, OPTIONAL_COLUMNS, TRIP_POINTS, attribute, bootUnit, bootstrapDiffCI, generations, parseFeatures, tally, underFloor,
} from "./pull-attribution.mjs";
import { RulingError, parseTierOutcomes } from "./tier-outcomes.mjs";
import { LINE_REF, briefPaths, briefText } from "./ticket-text.mjs";

const NAME = "ticket-router";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TABLE = join(SCRIPT_DIR, "router-table.json");
// The install's own package.json, whose `version` names the plugin a Pull was routed by.
export const INSTALL_PACKAGE = join(SCRIPT_DIR, "..", "package.json");

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

/** The install's `package.json` `version`, or null when it names none or cannot be read. */
export function installVersion(path = INSTALL_PACKAGE) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"))?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// The directory a brief path names: its parent once a line reference and any
// trailing `/` are dropped, or the path itself when it ended in `/`; `.` for a
// bare filename.
function pathDir(token) {
  const t = token.replace(LINE_REF, "");
  const q = t.replace(/\/+$/, "");
  return posix.normalize(q === t ? posix.dirname(q) : q || "/");
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
    // briefPaths' tokens hold no whitespace, so one space separates them unambiguously.
    named_paths: paths.join(" "),
    dirs: paths.length === 0 ? "" : String(new Set(paths.map(pathDir)).size),
    title: typeof issue.title === "string" ? issue.title : "",
  };
}

// Whether `abs` is `root` or lies below it. Posix `relative` resolves both
// first and never answers with an absolute path.
function within(root, abs) {
  const r = relative(root, abs);
  return r !== ".." && !r.startsWith(`..${sep}`);
}

// One `named_lines` entry: a line reference dropped, the path resolved against
// `root`, absolute, whose realpath is `realRoot`. One that is absolute, starts
// with `~` or lies outside `root` — as spelled, or once its symlinks are
// followed — is `-` and never read; so is one that does not exist, a file
// named with a trailing `/`, or one that is neither a file nor a directory.
function lineEntry(token, root, realRoot) {
  const t = token.replace(LINE_REF, "");
  if (isAbsolute(t) || t.startsWith("~")) return "-";
  const at = join(root, t);
  if (!within(root, at)) return "-";
  try {
    const real = realpathSync(at);
    if (!within(realRoot, real)) return "-";
    // `at`, not `real`: realpath drops a trailing `/`, which stat keeps, so a
    // file named as a directory is ENOTDIR here.
    const st = statSync(at);
    if (st.isDirectory()) return "dir";
    if (!st.isFile()) return "-";
    const bytes = readFileSync(real);
    let n = 0;
    for (const b of bytes) if (b === 0x0a) n += 1;
    return String(bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? n + 1 : n);
  } catch {
    return "-";
  }
}

/**
 * The `named_lines` value for `named`, a `named_paths` value, resolved against
 * the checkout `root`: per path, aligned and space-separated, the file's line
 * count (its `\n`s, plus one when its last line has none), `dir` for a
 * directory, `-` for anything else (lineEntry). Blank when `named` is.
 */
export function namedLines(named, root) {
  if (named === "") return "";
  const paths = named.split(" ");
  let realRoot;
  // A root that cannot be resolved — null when the CLI's working directory is
  // gone — reads every path `-`.
  try { realRoot = realpathSync(root); } catch { return paths.map(() => "-").join(" "); }
  const abs = resolve(root);
  return paths.map((p) => lineEntry(p, abs, realRoot)).join(" ");
}

// ---------------------------------------------------------------------------
// the tree — which group a ticket falls in
// ---------------------------------------------------------------------------

// The table's groups are the nodes of a tree of splits on what is known of a
// ticket at dispatch. A group is named by its rule path (ledger-grammar.mjs
// says how a path reads): `*` is the root, the group of every ticket before any
// split, and a node's two children are named by the node's path and the test
// each takes, joined by `&`. `splits` holds the tree, keyed by the path of the
// node a split sits at:
//
//   "splits": { "*": { "input": "brief_chars", "cut": 4047 } }
//
// A split reads one input, a ticket-features column, and sends a ticket to one
// of its two children. For an input that reads as a number, a ticket past the
// cut goes to `<input>><cut>` and any other to `<input><=<cut>`; for `kind`, a
// ticket of the cut's kind goes to `kind=<cut>` and any other to
// `kind!=<cut>`. A ticket that lacks the input a split reads — its issue was not
// read, or its column is blank — goes no further than that node, and the
// node's own row routes it. Every node, inner nodes and root included, holds a
// `cost` row and a `speed` row of its own, and its estimates and reasons. A
// table with no split is the one-node tree: `*` routes every ticket.

const SEP = "&";
// Each input a split may read, and what it reads as: the columns of a ticket-features row that are known at
// dispatch and are a count or a kind. `parent` reads as the Slice's parent number, and 0 for an issue read that
// names none, so a cut at 0 splits Slices from the rest. The brief's paths, its title and the install's version
// are no input: no cut of theirs is defined.
const INPUTS = Object.freeze({
  brief_chars: "number", criteria: "number", comments: "number", age_days: "number", paths: "number", test_paths: "number", xrefs: "number", dirs: "number",
  parent: "number", kind: "kind",
});

/** What a ticket holds for `input` — a number, or a kind — or null where it lacks it: its issue was not read, or its column is blank. */
function inputOf(input, m) {
  // A row whose issue was not read has blank metrics, `brief_chars` among them: it holds none of the inputs.
  if (m.brief_chars === undefined || m.brief_chars === "") return null;
  const s = m[input] ?? "";
  if (input === "kind") return s === "" ? null : s;
  if (input === "parent" && s === "") return 0;
  const n = s === "" ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

const child = (node, test) => (node === "*" ? test : `${node}${SEP}${test}`);
/** The two children of the split at `node`, the group a test holds for first. */
function childrenOf(node, { input, cut }) {
  return (INPUTS[input] === "kind" ? [`kind=${cut}`, `kind!=${cut}`] : [`${input}>${cut}`, `${input}<=${cut}`]).map((test) => child(node, test));
}
/** The path of `node`'s parent, null for the root. */
const parentOf = (node) => (node === "*" ? null : node.includes(SEP) ? node.slice(0, node.lastIndexOf(SEP)) : "*");

/** The nodes of the tree `splits` holds, root first, then each split's two children, depth first. */
function treeNodes(splits) {
  const nodes = [];
  const down = (node) => {
    nodes.push(node);
    if (Object.hasOwn(splits, node)) for (const c of childrenOf(node, splits[node])) down(c);
  };
  down("*");
  return nodes;
}

/**
 * The group a ticket falls in: from the root, each split sends it to the child
 * its input says, until a node has no split or the ticket lacks the input the
 * node's split reads. `m` is the ticket's metrics row, the columns `issueMetrics`
 * makes or a ticket-features file holds, as strings.
 */
export function stratumOf(table, m) {
  let node = "*";
  while (Object.hasOwn(table.splits, node)) {
    const split = table.splits[node];
    const v = inputOf(split.input, m);
    if (v === null) break;
    const [holds, other] = childrenOf(node, split);
    node = (INPUTS[split.input] === "kind" ? v === split.cut : v > split.cut) ? holds : other;
  }
  return node;
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

const shown = (x) => (typeof x === "number" ? String(x) : JSON.stringify(x));

/** A parsed table, or an Error saying why it is not one. */
export function validateTable(t) {
  const bad = (why) => new Error(`router table: ${why}`);
  const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObject(t)) return bad("not a JSON object");
  if (!Array.isArray(t.cells) || t.cells.length === 0) return bad("`cells` is not a non-empty array");
  for (const c of t.cells) if (typeof c !== "string" || !CELL.test(c)) return bad(`\`cells\` holds ${JSON.stringify(c)}, not a cell token`);
  if (new Set(t.cells).size !== t.cells.length) return bad("`cells` repeats a cell");
  // The tree: each split reads an input a split may read, at a cut that input can take, and sits at a node of the
  // tree the other splits make.
  if (!isObject(t.splits)) return bad("`splits` is not an object");
  for (const [path, s] of Object.entries(t.splits)) {
    const at = `splits[${JSON.stringify(path)}]`;
    if (!isObject(s)) return bad(`\`${at}\` is not \`{ input, cut }\``);
    if (typeof s.input !== "string" || !Object.hasOwn(INPUTS, s.input)) return bad(`\`${at}\` reads ${shown(s.input)}, which no split can read`);
    const number = INPUTS[s.input] === "number";
    // A number is a cut when the rule path it makes is one the Routing line can carry: no NaN, sign or exponent.
    if (number ? typeof s.cut !== "number" || !isRulePath(childrenOf("*", s)[0]) : !KINDS.has(s.cut)) {
      return bad(`\`${at}\` cuts ${s.input} at ${shown(s.cut)}, which is not ${number ? "a non-negative number" : "a ticket kind"}`);
    }
    if (Object.keys(s).length !== 2) return bad(`\`${at}\` is not \`{ input, cut }\``);
  }
  const nodes = treeNodes(t.splits);
  // The first key of `o` that names no node of the tree.
  const offTree = (o) => Object.keys(o).find((key) => !nodes.includes(key));
  const unreached = offTree(t.splits);
  if (unreached !== undefined) return bad(`\`splits[${JSON.stringify(unreached)}]\` sits at no node of the tree`);
  // `rows` and `reasons` are each keyed by objective, then by the nodes of the tree.
  for (const field of ["rows", "reasons"]) {
    if (!isObject(t[field])) return bad(`\`${field}\` is not an object`);
    const stray = Object.keys(t[field]).find((o) => !OBJECTIVES.includes(o));
    if (stray !== undefined) return bad(`\`${field}\` key ${JSON.stringify(stray)} is not an objective (${OBJECTIVES.join(", ")})`);
    for (const o of OBJECTIVES) {
      const set = t[field][o];
      if (!isObject(set)) return bad(`\`${field}.${o}\` is not an object`);
      const k = offTree(set);
      if (k !== undefined) return bad(`\`${field}.${o}\` key ${JSON.stringify(k)} is not a node of the tree`);
    }
  }
  if (isObject(t.estimates)) {
    const k = offTree(t.estimates);
    if (k !== undefined) return bad(`\`estimates\` key ${JSON.stringify(k)} is not a node of the tree`);
  }
  for (const o of OBJECTIVES) {
    for (const node of nodes) {
      if (!Object.hasOwn(t.rows[o], node)) return bad(node === "*" ? `\`rows.${o}\` has no \`*\` row` : `\`rows.${o}\` has no row for ${JSON.stringify(node)}`);
    }
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

/** The row a group routes by: its own, else the `*` row's — as a name no node of the table holds does, such as a group a Routing filed under another table names. */
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

/**
 * `cost-guard.json` as the router reads it: `{ ok: true, guard }`, reduced to
 * what the router reads, or `{ ok: false, why }` when it refuses the file. `raw` is the parsed
 * file, `null` for one that is missing or will not parse.
 */
export function parseGuard(raw) {
  if (raw === null || typeof raw !== "object") return { ok: false, why: "not a JSON object" };
  if (!Array.isArray(raw.tripped)) return { ok: false, why: "`tripped` is not a list" };
  if (!Array.isArray(raw.cells)) return { ok: false, why: "`cells` is not a list" };
  const tripped = raw.tripped.map((t) => (typeof t === "string" ? t : t?.cell));
  const bad = tripped.findIndex((t) => typeof t !== "string" || !CELL.test(t));
  if (bad !== -1) return { ok: false, why: `\`tripped\` names ${JSON.stringify(raw.tripped[bad])}, which is not a Cell` };
  const n = {};
  for (const c of raw.cells) {
    if (typeof c?.cell !== "string" || !Number.isFinite(c?.n)) return { ok: false, why: "a `cells` entry has no string `cell` or no finite `n`" };
    n[c.cell] = c.n;
  }
  return { ok: true, guard: { tripped: [...new Set(tripped)].sort(), n, window_start: typeof raw.window_start === "string" ? raw.window_start : null } };
}

/** `cost-guard.json` reduced to what the router reads, or null when missing or unparseable. */
export function readGuard(raw) {
  const r = parseGuard(raw);
  return r.ok ? r.guard : null;
}

/** The Fit's file name: metrics-refresh.mjs writes it beside the cost guard, and `route` reads it there. */
export const FIT_FILE = "router-fit.json";

/**
 * The table the Fit beside `guardPath` holds, `{ table, fallback: null }`, or `{ table: null, fallback }` when
 * there is none to route by: `fallback` is the Routing `REASON` that names why — `fit-missing` for no file,
 * `fit-unreadable` for one that will not read or parse, `fit-invalid` for one whose `table` validateTable refuses.
 */
export function readFitBeside(guardPath) {
  let text;
  try {
    text = readFileSync(join(dirname(guardPath), FIT_FILE), "utf8");
  } catch (e) {
    return { table: null, fallback: e.code === "ENOENT" ? "fit-missing" : "fit-unreadable" };
  }
  let fit;
  try { fit = JSON.parse(text); } catch { return { table: null, fallback: "fit-unreadable" }; }
  const table = validateTable(fit?.table);
  return table instanceof Error ? { table: null, fallback: "fit-invalid" } : { table, fallback: null };
}

/** The sizing verdict on a live B Pull: `{ src, label, usd }`, or null when it is unusable. */
function readSizing(raw, classifier) {
  if (raw === null || typeof raw !== "object" || raw.source !== classifier.b) return null;
  const label = raw.label === "light" || raw.label === "heavy" ? raw.label : null;
  if (label === null) return null;
  return {
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
 * One Pull's routing, by `objective`'s row set. Every input is already read
 * but the paths the brief names, which `named_lines` reads under `root`, the
 * checkout. `version` is the install's, `plugin_version` on the row. The
 * ticket's group is the node the tree's walk ends at (stratumOf), and the row
 * set's row for it routes the Pull. The exploration draw ignores the objective:
 * it leaves out the cell the `cost` set routes the group to, whichever set
 * routes the Pull, so a Pull draws the same cell under both. A live B Pull
 * records its sizing verdict and routes as an A Pull does: a label names no
 * group of the tree. `fallback` is readFitBeside's REASON when `table` is the
 * starting table standing in for a Fit, else null: it is the first thing that
 * went wrong, except beside no guard, where the table routes nothing.
 * @returns {{ line: string, row: Record<string,string> }}
 */
export function route({
  session, ticket, arm, implRow, chainHead = false, issue, sizing = null, guard, table, objective, now = Date.now(),
  root = process.cwd(), version = installVersion(), fallback = null,
}) {
  let reason = null;
  const degrade = (r) => { reason ??= r; };
  if (fallback !== null && guard !== null) degrade(fallback);

  const metrics = issueMetrics(issue, now);
  if (metrics === null) degrade("no-issue-json");
  const blank = Object.fromEntries(FEATURE_COLUMNS
    .slice(FEATURE_COLUMNS.indexOf("brief_chars"), FEATURE_COLUMNS.indexOf("plugin_version"))
    .filter((c) => c !== "objective").map((c) => [c, ""]));
  const m = metrics === null ? blank : { ...metrics, named_lines: namedLines(metrics.named_paths, root) };
  const stratum = stratumOf(table, m);

  let sizingSrc = "rule";
  let sizingPre = "";
  let routerUsd = "";
  if (arm === "B" && bArmLive(table, objective)) {
    const sized = readSizing(sizing, table.classifier);
    if (sized === null) {
      degrade("no-sizing");
      sizingSrc = "";
    } else {
      ({ src: sizingSrc, label: sizingPre, usd: routerUsd } = sized);
    }
  }

  const dispatch = (o) => rowDispatch({ table, guard, objective: o, stratum });
  const policyRow = dispatch(objective);
  const drawRow = dispatch("cost");
  if (policyRow.reason !== "ok") degrade(policyRow.reason);
  // With no guard the default cell is the only one: the guard cannot be
  // evaded by deleting it.
  const policy = policyRow.policy;
  let cell = policy;
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
    sizing_src: sizingSrc, sizing_pre: sizingPre, router_usd: routerUsd, ...m, objective, plugin_version: version ?? "",
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
 * routed, each to its own row's cell and group, `stratum` the walk from a
 * features row to its group — restricted to rows the free classifier routed
 * plus exploration rows: a row a live B classifier routed is the A/B's test
 * set, not the fit's. The fit sees no PR state, so a Pull with
 * a Ruling is merged. A fit reads everything in the commit it is given: no row
 * is cut by date, because `--check` re-reads that same commit rather than
 * re-cutting the working tree's files. `order` ranks each cell's generations
 * over every Pull in the window, the restriction aside, so the fit names the
 * same newest generation the guard does.
 */
function fitPulls({ features, members, verdicts, window, stratum }) {
  const all = attribute({ features, members, tiers: verdicts, windowStart: window || null, stratum });
  return { units: all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule"), order: generations(all) };
}

// Per node of the tree, per cell, its newest generation's figures: `n` counted
// Pulls, `merged`, $ per merged PR, minutes of work time per merged PR, false
// claims over claims, fix rounds per merged PR, `by_hand` (the counted merged Pulls whose
// Ruling was given by hand), and its left-out, unpriced and
// untimed Pull counts. Both per merged PR figures take every counted Pull,
// merged or not, over the merged ones. Beside them the cell's
// excluded Pull count, `generation` naming the newest generation's model, and
// `older`, each older generation's model to its figures, newest first. A node's
// Pulls are those that went through it: the Pulls of its own group and of each
// group below it, so the root's are every Pull's. A node no Pull went through
// has none. Beside `estimates`, `pulls`: per node, per cell, the newest
// generation's counted Pulls those figures are over.
function estimate(units, order, nodes) {
  const estimates = {};
  const pulls = {};
  for (const s of nodes) {
    const mine = s === "*" ? units : units.filter((u) => u.stratum === s || u.stratum.startsWith(`${s}${SEP}`));
    if (mine.length === 0) continue;
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
 * One row's cell under one objective — a node's of the tree — and
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
 * The re-fit table, over the tree `prior.splits` holds: the fit makes no split
 * and takes none away. `guard` is `{ tripped, n, window_start }` (readGuard's
 * shape); `commit` is the sha of the commit the inputs were read from, or null
 * for the empty corpus before any fit. `rows` and `reasons` hold one set per
 * objective, and each a row or record for every node. `reasons.cost` holds
 * `judgeRow()`'s record, its `cell` the cell the node's `cost` row holds: a
 * node whose record has no cell holds its parent's `cost` row, as a ticket
 * there follows the parent, and an unjudged root holds the default cell.
 * `reasons.speed` holds `judgeSpeedRow()`'s record for each node with a `cost`
 * row of its own (the root always has one), from that row's cell, the base when
 * the record has no cell; a node with none holds its parent's `speed` row and
 * an `unjudged` record.
 */
export function fitTable({ prior, features, members, verdicts, guard, commit = null }) {
  const window = guard.window_start ?? prior.window_start ?? null;
  const nodes = treeNodes(prior.splits);
  const { units, order } = fitPulls({ features, members, verdicts, window, stratum: (row) => stratumOf(prior, row) });
  const { estimates, pulls } = estimate(units, order, nodes);
  const tripped = new Set(guard.tripped);

  let { stage, cells } = prior;
  cells = [...cells];
  // The rows and their reasons over `cells`: a fitted table's `reasons` cover exactly its `cells`.
  const judgeRows = () => {
    const rows = { cost: {}, speed: {} };
    const reasons = { cost: {}, speed: {} };
    for (const s of nodes) {
      const up = parentOf(s);
      const cost = judgeRow(estimates[s], pulls[s], cells, tripped);
      const own = cost.cell !== null || up === null;
      const costCell = cost.cell ?? (up === null ? POLICY_CELL : rows.cost[up]);
      const speed = own ? judgeSpeedRow(estimates[s], pulls[s], cells, tripped, costCell) : unjudged();
      const speedCell = speed.cell ?? (own ? costCell : rows.speed[up]);
      rows.cost[s] = costCell;
      rows.speed[s] = speedCell;
      reasons.cost[s] = { ...cost, cell: costCell };
      reasons.speed[s] = { ...speed, cell: speedCell };
    }
    return { rows, reasons };
  };
  let { rows, reasons } = judgeRows();
  const atN = (c) => (guard.n[c] ?? 0) >= MIN_N;
  const adopted = Object.values(rows).some((set) => set["*"] !== POLICY_CELL);
  if (stage === 1 && cells.every(atN) && (adopted || cells.some((c) => tripped.has(c)))) {
    stage = 2;
    for (const { cell, survives } of STAGE2) {
      if (!cells.includes(cell) && cells.includes(survives) && !tripped.has(survives)) cells.push(cell);
    }
    // The stage-2 cells were added after the rows were judged: judge the rows again over the new `cells`.
    ({ rows, reasons } = judgeRows());
  }
  return {
    window_start: window,
    fitted_commit: commit,
    n_rows: units.length,
    stage,
    cells,
    burn_in: !cells.every(atN),
    splits: prior.splits,
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

// Each cell's Pull counts over every Pull, the root's, as the fit prints them: its
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

// One line per row the fit judged, per objective: its cell and its reason,
// then each candidate's verdict and range.
function rowLines(reasons) {
  const range = (r) => (r === null ? "" : ` [${r.map((x) => x.toFixed(2)).join(", ")}]`);
  return Object.entries(reasons).flatMap(([o, set]) => Object.entries(set).map(([s, r]) => {
    const cells = Object.entries(r.cells).map(([c, x]) => `${c} ${x.verdict}${range(x.range)}`).join(", ");
    return `${NAME}: row ${o} ${s} ${r.cell} ${r.reason}${cells ? ` (${cells})` : ""}\n`;
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

  // `route` with no `--table` routes by the Fit beside `--guard`, else by the starting table.
  const fit = mode === "route" && F.arg("table") === null && F.arg("guard") !== null ? readFitBeside(F.arg("guard")) : null;
  const tablePath = mode === "route" ? (F.arg("table") ?? DEFAULT_TABLE) : need("table");
  let table = fit?.table ?? null;
  if (table === null) {
    try { table = JSON.parse(readFileSync(tablePath, "utf8")); } catch (e) { die(`cannot read the router table ${tablePath}: ${e.message}`); }
    const valid = validateTable(table);
    if (valid instanceof Error) die(`${tablePath}: ${valid.message}`);
  }

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
    // A working directory removed under the run, or an install `package.json`
    // with no readable version, degrades the row and warns, never the exit.
    let root = null;
    try { root = process.cwd(); } catch (e) {
      process.stderr.write(`${NAME}: WARNING cannot resolve the working directory: ${e.message} — every named path reads \`-\`\n`);
    }
    const version = installVersion();
    if (version === null) process.stderr.write(`${NAME}: WARNING ${INSTALL_PACKAGE} names no readable version — plugin_version is blank\n`);
    const { line, row } = route({
      session, ticket: Number(ticket), arm, implRow: Number(implRowArg), chainHead: F.has("chain-head"),
      issue: readJson(issuePath), sizing: readJson(F.arg("sizing")), guard: readGuard(readJson(guardPath)), table, objective, root, version,
      fallback: fit?.fallback ?? null,
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
