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
//         [--model-roles <json>] [--catalog <json>] [--agents <dir>]
//     Prints one line, the Pull's Routing (ledger-grammar.mjs owns its
//     grammar): `POLICY=<cell> CELL=<cell> DRAW=<k/K|-> BY=<burn-in|every-5th|->
//     STRATUM=<rule path> BRIEF=<chars|-> CRITERIA=<n|-> PARENT=<N|->
//     SIZED=<light|heavy|-> OBJECTIVE=<cost|speed> TRIPPED=<cell,…|->
//     UNRUNNABLE=<cell,…|-> REASON=<reason>`,
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
//     is; a receipt that records none is exit 2. Every Pull reads what the
//     install runs, burn-in, chain head and a missing guard included:
//     `modelRoles` (`omp config get modelRoles --json`, or the file
//     `--model-roles` names, holding that record), omp's model catalog
//     (`omp models --json`, or the file `--catalog` names) and the
//     implementer definitions in the agents directory beside the script
//     (or `--agents`). A Cell whose level its role's model does not run is
//     unrunnable (installOf, unrunnableCells): it is worked out from that read
//     on each Pull and kept in neither the guard nor the table, and `route`
//     routes around it — a row naming one routes the default Cell (REASON
//     `table-cell-unrunnable`), it is drawn in no draw, and the Pull's
//     `UNRUNNABLE` lists every defined Cell the install does not run. omp
//     lowers a level its model does not run silently, so a Pull dispatched at
//     one would run at another level.
//     A read that fails, or that `omp` does not answer within
//     OMP_READ_TIMEOUT_MS, warns and checks no Cell against the install: the
//     Pull's policy and burn-in Cells go out unchecked, an every-5th draw has
//     none to draw, and `UNRUNNABLE` is `-`; a read that leaves a role no
//     level to run at, or finds no implementer definition, warns too.
// The script never touches the network: the issue, the sizing verdict and
// the guard are files the caller wrote, and the install reads ask the local `omp`.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, appendFileSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags, isDigits } from "./arg.mjs";
import { CELL, OBJECTIVES, POLICY_CELL, STARTING_CELLS, drawCell, formatRouting, isRulePath, parseMember } from "./ledger-grammar.mjs";
import { objectiveFromReceipt, sessionFromReceipt } from "./phase0-receipt.mjs";
import {
  AttributionError, FEATURE_COLUMNS, OPTIONAL_COLUMNS, TRIP_POINTS, attribute, compareCells, generations, tally,
} from "./pull-attribution.mjs";
import { searchSplits, standing } from "./split-gate.mjs";
import { LINE_REF, briefPaths, briefText } from "./ticket-text.mjs";
import { catalogEntry, implementerCell, readOmpConfigValue, readOmpModelCatalog, resolveRole } from "./tier-roles.mjs";

const NAME = "ticket-router";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TABLE = join(SCRIPT_DIR, "router-table.json");
// The implementer definitions the install ships: the directory an install read names the Cells of unless told another.
export const AGENTS_DIR = join(SCRIPT_DIR, "..", "agents");
// The install's own package.json, whose `version` names the plugin a Pull was routed by.
export const INSTALL_PACKAGE = join(SCRIPT_DIR, "..", "package.json");

// Exploration cadence after burn-in: the Pull that creates `impl-` row 5k.
const EXPLORE_EVERY = 5;
// An `omp` install read that has not answered in this many milliseconds is killed and warns as a failed read: the
// Pull runs `route` with no timeout of its own, so a hung `omp` would otherwise hang the Pull.
const OMP_READ_TIMEOUT_MS = 10_000;
// The fit's adoption floor (merged PRs per side) and margin.
export const MIN_N = 20;
const ADOPT_RATIO = 0.75;
// Whether any starting Cell of `cells` (startingCellsOf's: the starting Cells the install runs) is short of MIN_N
// merged PRs in a guard's `n`: burn-in holds while any is. A Cell the guard has no count for has 0.
const anyStartingCellShort = (n, cells) => cells.some((c) => (n[c] ?? 0) < MIN_N);
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
// node's own row routes it. A number input's column that is neither blank nor a
// plain count (digits alone) is bad input: the walk refuses it. Every node,
// inner nodes and root included, holds a `cost` row and a `speed` row of its
// own, and its estimates and reasons. A table with no split is the one-node
// tree: `*` routes every ticket.

const SEP = "&";
// Each input a split may read, and what it reads as: the columns of a ticket-features row that are known at
// dispatch and are a count or a kind. `parent` reads as the Slice's parent number, and 0 for an issue read that
// names none, so a cut at 0 splits Slices from the rest. The brief's paths, its title and the install's version
// are no input: no cut of theirs is defined.
const INPUTS = Object.freeze({
  brief_chars: "number", criteria: "number", comments: "number", age_days: "number", paths: "number", test_paths: "number", xrefs: "number", dirs: "number",
  parent: "number", kind: "kind",
});

/**
 * What a ticket holds for `input` — a number, or a kind — or null where it lacks it: its issue was not read, or its
 * column is blank. Throws `AttributionError` on a number input's column that is neither blank nor a plain count: digits
 * alone, as `issueMetrics` writes one, with no sign, exponent, radix prefix, fraction or space, and few enough to read
 * as a finite number.
 */
function inputOf(input, m) {
  // A row whose issue was not read has blank metrics, `brief_chars` among them: it holds none of the inputs.
  if (m.brief_chars === undefined || m.brief_chars === "") return null;
  const s = m[input] ?? "";
  if (input === "kind") return s === "" ? null : s;
  if (s === "") return input === "parent" ? 0 : null;
  const n = isDigits(s) ? Number(s) : NaN;
  if (!Number.isFinite(n)) {
    const row = m.ticket === undefined ? "a ticket-features row" : `ticket #${m.ticket}: a ticket-features row`;
    throw new AttributionError(`${row}'s ${input} is '${s}', which a split reads, expected a plain count or blank`);
  }
  return n;
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
  // The starting Cells burn-in counted, which a Fit records and the starting table does not.
  const sc = t.starting_cells;
  if (sc !== undefined && (!Array.isArray(sc) || sc.length === 0 || new Set(sc).size !== sc.length || !sc.every((c) => STARTING_CELLS.includes(c)))) {
    return bad("`starting_cells` is not a non-empty list of starting Cells, each once");
  }
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

// The fleet's roles by price, cheapest first: the model one step along is the bigger one.
const ROLES_BY_PRICE = Object.freeze(["smol", "task", "slow"]);
// The levels a Cell can name, by effort, lowest first: the order a role's ladder is read in.
const LEVELS = Object.freeze(CELL.source.match(/\)-\(([^)]*)\)/)[1].split("|"));
const rank = (level) => LEVELS.indexOf(level);

/**
 * What this install can run: `ladders`, per role, the levels its `modelRoles` target runs at in omp's model catalog,
 * by effort, lowest first ([] for a role that resolves to no model or to one the catalog does not list); `models`,
 * per role, the model it resolves to (null for a role that resolves to none); `defined`, the Cells an implementer
 * definition exists for. `definitions` is the agents directory's file names. A Cell whose level its role's ladder
 * lacks is unrunnable here (isRunnable): omp would lower the level silently.
 */
export function installOf({ modelRoles, catalog, definitions }) {
  const models = Object.fromEntries(ROLES_BY_PRICE.map((role) => [role, resolveRole(role, modelRoles)]));
  const ladders = Object.fromEntries(ROLES_BY_PRICE.map((role) => {
    const thinking = models[role] === null ? null : catalogEntry(models[role], catalog)?.thinking;
    return [role, Array.isArray(thinking) ? LEVELS.filter((l) => thinking.includes(l)) : []];
  }));
  return { ladders, models, defined: new Set(definitions.map(implementerCell).filter((c) => c !== null)) };
}

/**
 * Whether `install` (installOf's, or null where it was not read) runs `cell`: its level is on its role's ladder. An
 * install that was not read holds nothing unrunnable, so every Cell is runnable there. Throws on a string that is no
 * Cell, which no install can answer for.
 */
export function isRunnable(install, cell) {
  const parsed = CELL.exec(cell);
  if (parsed === null) throw new TypeError(`isRunnable: ${JSON.stringify(cell)} is not a Cell`);
  return install === null || install.ladders[parsed[1]].includes(parsed[2]);
}

/** Every Cell `install` has an implementer definition for and does not run, sorted; none where it was not read. */
export const unrunnableCells = (install) => (install === null ? [] : [...install.defined].filter((c) => !isRunnable(install, c)).sort());

/**
 * The starting Cells `install` runs, in their order: the Cells burn-in counts and draws. All three where the install
 * was not read, and where it runs none of them, so that an install that cannot run them is no reason to end burn-in.
 */
export function startingCellsOf(install) {
  const runs = STARTING_CELLS.filter((c) => isRunnable(install, c));
  return runs.length > 0 ? runs : [...STARTING_CELLS];
}

/**
 * The Cell a Pull runs where the router holds no row's Cell back: POLICY_CELL while `install` (installOf's, or null)
 * runs it, else the nearest level of its role that the install runs and has an implementer definition for — downward
 * first, the direction omp lowers to, then upward. POLICY_CELL again when its role has no such level.
 */
export function defaultCellOf(install) {
  if (isRunnable(install, POLICY_CELL)) return POLICY_CELL;
  const [, role, level] = CELL.exec(POLICY_CELL);
  const usable = install.ladders[role].filter((l) => install.defined.has(`${role}-${l}`));
  const at = usable.findLast((l) => rank(l) < rank(level)) ?? usable.find((l) => rank(l) > rank(level));
  return at === undefined ? POLICY_CELL : `${role}-${at}`;
}

/**
 * The exploration Cells of a group whose `cost` row Cell is `centre`, on `ladders` (installOf's): the role's next
 * level above and next level below on its own ladder, the bigger model's next level below, the smaller model's
 * next level above. A rung a ladder does not hold is absent: there is no level above its top, no bigger model
 * above `slow` and no smaller one below `smol`.
 */
export function explorationCells(centre, ladders) {
  const [, role, level] = CELL.exec(centre);
  const above = (r) => ladders[r].find((l) => rank(l) > rank(level));
  const below = (r) => ladders[r].findLast((l) => rank(l) < rank(level));
  const at = ROLES_BY_PRICE.indexOf(role);
  const bigger = ROLES_BY_PRICE[at + 1];
  const smaller = ROLES_BY_PRICE[at - 1];
  return [
    [role, above(role)], [role, below(role)],
    [bigger, bigger && below(bigger)], [smaller, smaller && above(smaller)],
  ].filter(([, l]) => l !== undefined).map(([r, l]) => `${r}-${l}`);
}

/**
 * The Cells an exploring Pull may draw, before the guard's tripped Cells and the install's unrunnable ones leave any
 * out: burn-in draws the starting Cells, whatever `cells` the table holds; a draw after it the exploration Cells
 * around `centre`, the group's `cost` row Cell, that `install` (installOf's) can run — none when the install was not
 * read (null). The fit judges `burn_in` over the starting Cells the install runs, so the Cells that end burn-in are
 * the Cells it draws.
 */
const drawPool = (table, centre, install) => {
  if (table.burn_in) return STARTING_CELLS;
  if (install === null) return [];
  return explorationCells(centre, install.ladders).filter((c) => install.defined.has(c));
};

/**
 * What `route` does with one row under one guard, with no per-Pull input.
 * `guard` is readGuard's answer or null. `install` is installOf's answer, or
 * null where it was not read: no Cell is unrunnable there, and an every-5th
 * draw has no Cell. `policy` is the row's Cell, or the default cell
 * (defaultCellOf) when there is no guard, the row's Cell is tripped or the
 * row's Cell is unrunnable; `reason` is `guard-missing`,
 * `table-cell-unrunnable`, `table-cell-tripped` or `ok`, a Cell both
 * unrunnable and tripped being `table-cell-unrunnable`. `draw` is what an
 * exploring Pull picks from — `by` `burn-in` (every Pull) or `every-5th` —
 * over `cells`: drawPool()'s Cells less the tripped and the unrunnable,
 * centred on the `cost` row's Cell for the stratum as the guard and the
 * install leave it (the default cell when that row's Cell is tripped or
 * unrunnable), whichever objective routes the row. `draw` is null with no
 * guard and when no Cell is left.
 * @returns {{ policy: string, reason: "guard-missing"|"table-cell-unrunnable"|"table-cell-tripped"|"ok", draw: null | { by: "burn-in"|"every-5th", cells: string[] } }}
 */
export function rowDispatch({ table, guard, objective, stratum, install = null }) {
  const fallback = defaultCellOf(install);
  if (guard === null) return { policy: fallback, reason: "guard-missing", draw: null };
  const tripped = new Set(guard.tripped);
  const unrunnable = (cell) => !isRunnable(install, cell);
  const adjust = (cell) => (tripped.has(cell) || unrunnable(cell) ? fallback : cell);
  const row = rowFor(table.rows[objective], stratum);
  const by = table.burn_in ? "burn-in" : "every-5th";
  const cells = drawPool(table, adjust(rowFor(table.rows.cost, stratum)), install).filter((c) => !tripped.has(c) && !unrunnable(c));
  return {
    policy: adjust(row),
    reason: unrunnable(row) ? "table-cell-unrunnable" : tripped.has(row) ? "table-cell-tripped" : "ok",
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

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const fraction = (n, d) => {
  const g = gcd(n, d);
  return d === g ? `${n / g}` : `${n / g}/${d / g}`;
};

/**
 * The probability that a Pull's Cell was assigned to it, as a fraction that reads back exactly: `1`, or `<n>/<d>` in
 * lowest terms. `cell` is the Cell the Pull runs, `policy` its group's Cell, and `cells` the Cells its draw was over
 * (rowDispatch's), [] where there was none to draw — no guard, every candidate tripped or absent — and the Pull's Cell
 * was certain. A burn-in Pull draws, chain head or not, so it is 1/K over the K Cells drawn. After burn-in a chain head
 * never explores, so it is 1. Any other Pull's Cell is the sum of the two ways to it: the share left (4/5) when it is
 * the group's Cell, and the exploring share times 1/K when the draw holds it — both for a group Cell that is also one
 * of the Cells drawn, as under the `speed` Objective, whose Cell can be one of the `cost` row Cell's exploration Cells.
 */
export function assignmentProb({ burnIn, chainHead, cell, policy, cells }) {
  const K = cells.length;
  if (K === 0) return "1";
  if (burnIn) return fraction(1, K);
  if (chainHead) return "1";
  const atPolicy = cell === policy ? (EXPLORE_EVERY - 1) * K : 0;
  return fraction(atPolicy + (cells.includes(cell) ? 1 : 0), EXPLORE_EVERY * K);
}

/**
 * One Pull's routing, by `objective`'s row set. Every input is already read
 * but the paths the brief names, which `named_lines` reads under `root`, the
 * checkout. `version` is the install's, `plugin_version` on the row. The
 * ticket's group is the node the tree's walk ends at (stratumOf), and the row
 * set's row for it routes the Pull. The exploration draw ignores the objective:
 * it is centred on the cell the `cost` set routes the group to, whichever set
 * routes the Pull, so a Pull draws the same cell under both. `install` is
 * installOf's answer, or null where it was not read, which checks no Cell
 * against the install and leaves an every-5th Pull nothing to draw. The
 * Routing's `UNRUNNABLE` is unrunnableCells(install). A live B Pull
 * records its sizing verdict and routes as an A Pull does: a label names no
 * group of the tree. `fallback` is readFitBeside's REASON when `table` is the
 * starting table standing in for a Fit, else null: it is the first thing that
 * went wrong, except beside no guard, where the table routes nothing. The row's
 * `assignment_prob` is the probability the Pull's Cell was assigned with
 * (assignmentProb).
 * @returns {{ line: string, row: Record<string,string> }}
 */
export function route({
  session, ticket, arm, implRow, chainHead = false, issue, sizing = null, guard, table, objective, now = Date.now(),
  root = process.cwd(), version = installVersion(), fallback = null, install = null,
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

  const dispatch = (o) => rowDispatch({ table, guard, objective: o, stratum, install });
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
      if (drawPool(table, drawRow.policy, install).some((c) => guard.tripped.includes(c))) degrade("guard-tripped");
      if (drawRow.draw !== null) {
        // rowDispatch's `cells` never hold the `cost` row's Cell: nothing more to withhold.
        const d = drawCell({ session, ticket, policyCell: null, cells: drawRow.draw.cells });
        cell = d.cell;
        draw = { k: d.k, K: d.K };
        by = drawRow.draw.by;
      }
    }
  }
  reason ??= "ok";
  const prob = assignmentProb({ burnIn: table.burn_in, chainHead, cell, policy, cells: drawRow.draw?.cells ?? [] });

  const row = {
    run_date: sessionDate(session), session, agent: `impl-${ticket}`, ticket: String(ticket),
    policy_cell: policy, chosen_cell: cell, exploration_draw: draw === null ? "" : `${draw.k}/${draw.K}`,
    sizing_src: sizingSrc, sizing_pre: sizingPre, router_usd: routerUsd, ...m, objective, plugin_version: version ?? "",
    assignment_prob: prob,
  };
  const line = formatRouting({
    policy, cell, draw, by, stratum,
    brief: metrics === null ? null : Number(metrics.brief_chars), criteria: metrics === null ? null : Number(metrics.criteria),
    parent: m.parent === "" ? null : Number(m.parent),
    sized: sizingPre === "" ? null : sizingPre, objective, tripped: guard?.tripped ?? [], unrunnable: unrunnableCells(install), reason,
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
 * routed, each to its own row's cell — restricted to rows the free classifier
 * routed plus exploration rows: a row a live B classifier routed is the A/B's
 * test set, not the fit's. The fit sees no PR state, so a Pull with
 * a Ruling is merged. A fit reads everything it is given: no row
 * is cut by date, whatever the working tree's files hold. `order` ranks each cell's generations
 * over every Pull in the window, the restriction aside, so the fit names the
 * same newest generation the guard does. No unit is in a group yet: `book`
 * puts each where a tree walks its features row.
 */
function fitPulls({ features, members, verdicts, window }) {
  const all = attribute({ features, members, tiers: verdicts, windowStart: window || null });
  return { units: all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule"), order: generations(all) };
}

/** `units`, each booked to the group `table`'s tree walks its features row to (stratumOf). */
const book = (units, table) => units.map((u) => ({ ...u, stratum: stratumOf(table, u.pull) }));

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
// minimises (a `compareCells` side's name for it) and the measure its range is
// read in (`range()`'s), its verdict for a candidate past the margin and for
// one with no reliable difference, the key a pair names its better side by,
// and its reasons for a winner every other qualifier was reliably worse than
// and for one ahead on the figure.
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
 * One row's cell under one objective — a node's of the tree — and why. The
 * quality floor is held twice: by the guard over every group's Pulls together,
 * whose trip takes a cell out of every row and out of the exploration draw,
 * and per row by the fit, which refuses a cell under the floor that row alone.
 * The floor is measured against the default cell under both objectives. Every
 * figure read is the cell's newest generation's, the default cell's included,
 * and every comparison is `compareCells`': two cells over the stretches in
 * which both were drawn, the stretches pooled, so a base's other weeks move
 * no verdict and a shift that hits every cell at once cancels in every gap.
 * The one test it does not cancel in is ADOPT_RATIO's, a ratio of the two
 * figures: a shift that raises both by the same amount brings the ratio nearer
 * 1, so it can move a candidate from qualifying to `too-dear` or `too-slow`.
 * `pulls` holds the row's counted Pulls per cell (`estimate()`'s); `baseCell`
 * is the cell the row holds unless a candidate qualifies: the default cell
 * under `cost`, the `cost` row's cell under `speed`. The figure is $ per
 * merged PR under `cost` and minutes of work time per merged PR under `speed`.
 *
 * A candidate is a cell of `cells` other than the base. Its `verdict`, the
 * first that applies: `tripped` by the guard; `too-few`, under MIN_N merged
 * PRs in the row, on either side, in the stretches it shares with the base or
 * with the default cell (none shared, none counted); `under-floor` against the
 * default cell there; `too-dear` (`cost`) or `too-slow` (`speed`), above
 * ADOPT_RATIO of the base's figure, both figures over the stretches it shares
 * with the base; `not-reliably-cheaper` or `not-reliably-faster`, its `range`
 * does not lie wholly below zero (its upper end, as `bootstrapDiffCI` returns
 * it, is not below zero) or there is none; else it `qualifies`. A candidate
 * past `too-few` records whether it is `under_floor`, the floor's `bar` (the
 * default cell's fail rate over the stretches it shares with the candidate,
 * plus TRIP_POINTS, rounded as a fail rate is, for reading only: the floor
 * compares counts) and its `range`, the bootstrap 95% range of (candidate −
 * base) figure over the Pulls of those stretches; the others record null for
 * each.
 *
 * Several qualifiers: each pair records the range of (the better by the
 * figure, else by name − the other) in `pairs`, the pair compared over the
 * stretches it shares, naming the better side `cheaper` or `faster`, and a
 * qualifier another is reliably better than is dropped. Among the rest the
 * lower fail rate wins, then the lower figure, then the name; each is the
 * qualifier's gap to the base over the stretches it shares with it.
 *
 * `reason`, why the row holds `cell`: `unjudged` (the default cell or the
 * base, or every untripped candidate, is under MIN_N merged PRs; `cell` is
 * null), `no-qualifier` (the base), or, for the winner, `sole-qualifier`,
 * `reliably-cheaper` or `reliably-faster` (every other qualifier was
 * dropped), or what put it ahead of the next of the rest: `lower-fail-rate`,
 * `lower-usd` or `fewer-minutes`, or `name`.
 */
function judge(objective, pulls = {}, cells, tripped, baseCell) {
  const { figure, metric, over, unreliable, better, reliably, ahead } = JUDGE[objective];
  const record = unjudged();
  const pullsOf = (c) => pulls[c] ?? [];
  const mergedOf = (c) => pullsOf(c).filter((u) => u.merged).length;
  // A default cell or base short of MIN_N merged PRs has none to give any candidate, whichever stretches they share.
  if (mergedOf(POLICY_CELL) < MIN_N || mergedOf(baseCell) < MIN_N) return record;
  // JSON writes −0 as 0, so a recorded end is 0 either way: normalise it here.
  const range = (m) => m.range(metric)?.map((x) => x + 0) ?? null;
  const reliablyBelow = (r) => r !== null && r[1] < 0;
  // A matched figure as the table prints one, four places; none is unknown, past every figure that is known.
  const printed = (side) => (side[figure] === null ? Infinity : round4(side[figure]));
  const enough = (m) => m.cell.merged >= MIN_N && m.base.merged >= MIN_N;
  const against = new Map();
  const qualifiers = [];
  let judged = false;
  for (const c of cells) {
    if (c === baseCell) continue;
    if (tripped.has(c)) {
      record.cells[c] = { verdict: "tripped", under_floor: null, bar: null, range: null };
      continue;
    }
    const vsBase = compareCells(pullsOf(c), pullsOf(baseCell));
    const vsFloor = baseCell === POLICY_CELL ? vsBase : compareCells(pullsOf(c), pullsOf(POLICY_CELL));
    if (!enough(vsBase) || !enough(vsFloor)) {
      record.cells[c] = { verdict: "too-few", under_floor: null, bar: null, range: null };
      continue;
    }
    judged = true;
    against.set(c, vsBase);
    const under = vsFloor.underFloor;
    const bar = vsFloor.base.fail_rate === null ? null : round4(vsFloor.base.fail_rate + TRIP_POINTS / 100);
    const r = range(vsBase);
    const verdict = under ? "under-floor"
      : printed(vsBase.cell) > ADOPT_RATIO * printed(vsBase.base) ? over
        : reliablyBelow(r) ? "qualifies" : unreliable;
    record.cells[c] = { verdict, under_floor: under, bar, range: r };
    if (verdict === "qualifies") qualifiers.push(c);
  }
  if (!judged) return record;
  if (qualifiers.length === 0) return { ...record, cell: baseCell, reason: "no-qualifier" };

  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // A qualifier's gap to the base in fail rate, and in the figure, over the stretches they share.
  const failGap = (c) => against.get(c).cell.fail_rate - against.get(c).base.fail_rate;
  const figureGap = (c) => printed(against.get(c).cell) - printed(against.get(c).base);
  const named = [...qualifiers].sort(byName);
  const dropped = new Set();
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const pair = compareCells(pullsOf(named[i]), pullsOf(named[j]));
      const flip = printed(pair.base) < printed(pair.cell);
      const [win, other] = flip ? [named[j], named[i]] : [named[i], named[j]];
      const r = range(flip ? compareCells(pullsOf(win), pullsOf(other)) : pair);
      record.pairs.push({ [better]: win, other, range: r });
      if (reliablyBelow(r)) dropped.add(other);
    }
  }
  // The best qualifier, by the figure then name, is never dropped, so the rest is never empty.
  const [win, next] = named.filter((c) => !dropped.has(c))
    .sort((a, b) => byName(failGap(a), failGap(b)) || byName(figureGap(a), figureGap(b)) || byName(a, b));
  const reason = qualifiers.length === 1 ? "sole-qualifier"
    : next === undefined ? reliably
      : failGap(win) !== failGap(next) ? "lower-fail-rate"
        : figureGap(win) !== figureGap(next) ? ahead : "name";
  return { ...record, cell: win, reason };
}

/** A `cost` row: `judge()` from the default cell, by $ per merged PR. */
function judgeRow(pulls, cells, tripped) {
  return judge("cost", pulls, cells, tripped, POLICY_CELL);
}

/** A `speed` row: `judge()` from the `cost` row's cell, by minutes of work time per merged PR. */
function judgeSpeedRow(pulls, cells, tripped, costCell) {
  return judge("speed", pulls, cells, tripped, costCell);
}

/**
 * The re-fit table, over the tree `prior.splits` holds: this makes no split
 * and takes none away (fitTree grows the tree). `guard` is `{ tripped, n, window_start }` (readGuard's
 * shape). `rows` and `reasons` hold one set per
 * objective, and each a row or record for every node. `reasons.cost` holds
 * `judgeRow()`'s record, its `cell` the cell the node's `cost` row holds: a
 * node whose record has no cell holds its parent's `cost` row, as a ticket
 * there follows the parent, and an unjudged root holds the default cell.
 * `reasons.speed` holds `judgeSpeedRow()`'s record for each node with a `cost`
 * row of its own (the root always has one), from that row's cell, the base when
 * the record has no cell; a node with none holds its parent's `speed` row and
 * an `unjudged` record. `cells` is the prior's: the fit adds no Cell. `burn_in`
 * holds until every Cell of `startingCells` has MIN_N merged PRs on its newest
 * generation (`guard.n`, which starts again at 0 when a role's model changes):
 * no other Cell the table holds ends it or holds it, whatever its merged PRs.
 * `startingCells` are the starting Cells the install runs (startingCellsOf) —
 * all three when absent — and the table records them as `starting_cells`, so
 * the records, the guard, the prior and that set fit the same table again.
 * Throws on a `startingCells` that is empty, which would end burn-in on no
 * count at all, or that names a Cell that is no starting Cell.
 */
export function fitTable({ prior, features, members, verdicts, guard, startingCells = STARTING_CELLS }) {
  const window = guard.window_start ?? prior.window_start ?? null;
  return tableOver({ prior, ...fitPulls({ features, members, verdicts, window }), guard, window, startingCells });
}

// The table over the tree `prior.splits` holds, from the fit's Pulls (fitPulls') booked to its groups.
function tableOver({ prior, units: unbooked, order, guard, window, startingCells }) {
  if (startingCells.length === 0 || !startingCells.every((c) => STARTING_CELLS.includes(c))) {
    throw new Error(`startingCells is not a non-empty list of starting Cells: ${JSON.stringify(startingCells)}`);
  }
  const nodes = treeNodes(prior.splits);
  const units = book(unbooked, prior);
  const { estimates, pulls } = estimate(units, order, nodes);
  const tripped = new Set(guard.tripped);

  // The rows and their reasons over the table's `cells`: a fitted table's `reasons` cover exactly its `cells`.
  const rows = { cost: {}, speed: {} };
  const reasons = { cost: {}, speed: {} };
  for (const s of nodes) {
    const up = parentOf(s);
    const cost = judgeRow(pulls[s], prior.cells, tripped);
    const own = cost.cell !== null || up === null;
    const costCell = cost.cell ?? (up === null ? POLICY_CELL : rows.cost[up]);
    const speed = own ? judgeSpeedRow(pulls[s], prior.cells, tripped, costCell) : unjudged();
    const speedCell = speed.cell ?? (own ? costCell : rows.speed[up]);
    rows.cost[s] = costCell;
    rows.speed[s] = speedCell;
    reasons.cost[s] = { ...cost, cell: costCell };
    reasons.speed[s] = { ...speed, cell: speedCell };
  }
  return {
    window_start: window,
    n_rows: units.length,
    cells: prior.cells,
    burn_in: anyStartingCellShort(guard.n, startingCells),
    starting_cells: [...startingCells],
    splits: prior.splits,
    rows,
    classifier: prior.classifier,
    estimates,
    reasons,
    guard: { tripped: [...tripped].sort(), n: Object.fromEntries(Object.keys(guard.n).sort().map((c) => [c, guard.n[c]])) },
  };
}

// ---------------------------------------------------------------------------
// the split gate — which tree the fit grows
// ---------------------------------------------------------------------------

// The inputs the split search reads, in the order it searches them, and how each is cut: a count at its percentiles,
// `kind` on each of its values, `parent` on whether the ticket names one. They are the inputs a split may read.
const SEARCHED = Object.freeze([
  ...Object.keys(INPUTS).filter((name) => INPUTS[name] === "number" && name !== "parent").map((name) => ({ name, cuts: "percentiles" })),
  { name: "kind", cuts: "values", values: [...KINDS] },
  { name: "parent", cuts: "presence" },
]);

const PROBABILITY = /^(?:1|([1-9][0-9]*)\/([1-9][0-9]*))$/;

/**
 * The probability a features row's Cell was assigned with, or null where the row records none, as one written before
 * the column existed does: it is left out of the gate, never read as certain. Throws `AttributionError` on a value that
 * is no probability.
 */
function probabilityOf(row) {
  const text = row.assignment_prob ?? "";
  if (text === "") return null;
  const m = PROBABILITY.exec(text);
  const p = m === null ? NaN : m[1] === undefined ? 1 : Number(m[1]) / Number(m[2]);
  if (!(p > 0 && p <= 1)) throw new AttributionError(`ticket #${row.ticket}: a ticket-features row's assignment_prob is '${text}', expected blank or a probability`);
  return p;
}

// A seed that is a function of which Pulls were scored: a Fit reproduces from its records, and draws other shuffles once they grow.
function seedOf(ids) {
  let h = 2166136261;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 0xff, 16777619);
  }
  return h >>> 0;
}

/** The tree a standing split makes: its first cut at the root, its second, if it has one, at each child of the root. */
function treeOf(cuts) {
  const splits = { "*": { ...cuts[0] } };
  if (cuts.length > 1) for (const node of childrenOf("*", cuts[0])) splits[node] = { ...cuts[1] };
  return splits;
}

/**
 * The tree the fit grows, and what the gate found. The group searched is every counted Pull of the table's Cells the
 * guard has not tripped, that records the probability its Cell was assigned with (the rest are `left_out`): the gate
 * weighs each Pull by it. `previous` is the `gate` record of the last Fit that computed, or null. The tree is the root
 * and, when the best split passes both tests and passed on the same input or inputs at the last Fit too, that split;
 * the starting table's own tree is not read. `gate.records` is a digest of the Cells and Pulls searched: a Fit whose
 * digest is the last Fit's searched what that Fit searched and finds what it found, so it is no look at the gate — it
 * keeps that Fit's `passed` and `stands`, and a first pass cannot stand on the same records twice. `gate.passed`,
 * `gate.stands` and `gate.records` are what the next Fit reads.
 */
function growTree({ prior, units, order, tripped, previous }) {
  const cells = prior.cells.includes(POLICY_CELL) ? [POLICY_CELL, ...prior.cells.filter((c) => c !== POLICY_CELL && !tripped.has(c))] : [];
  const pulls = [];
  let leftOut = 0;
  for (const { pulls: counted } of tally(units, order).filter((t) => cells.includes(t.cell))) {
    for (const u of counted) {
      const prob = probabilityOf(u.pull);
      if (prob === null) {
        leftOut++;
        continue;
      }
      pulls.push({
        cell: u.cell, usd: u.spend, merged: u.merged ? 1 : 0, claims: u.claims, failed: u.falseClaims, prob,
        inputs: Object.fromEntries(SEARCHED.map(({ name }) => [name, inputOf(name, u.pull)])), id: `${u.pull.session}\0${u.pull.agent}`,
      });
    }
  }
  const found = searchSplits({ pulls, cells, inputs: SEARCHED, minN: MIN_N, seed: seedOf(pulls.map((p) => p.id)) });
  const records = createHash("sha256").update(JSON.stringify({ cells, pulls })).digest("hex");
  const kept = Array.isArray(previous?.passed) ? previous.passed : [];
  const { passed, stands } = previous?.records === records
    ? { passed: kept, stands: (Array.isArray(previous.stands) ? previous.stands : []).filter((key) => key === found.best?.key) }
    : standing({ best: found.best, previous: kept });
  const best = found.best;
  const gate = {
    records,
    scored: found.scored,
    left_out: leftOut,
    best: best === null ? null : {
      inputs: best.inputs, cuts: best.cuts, gain: round4(best.gain), exceeded: best.exceeded, passes_null: best.passesNull,
      lower_bound: round4(best.lowerBound), passes_bound: best.passesBound,
    },
    passed,
    stands,
  };
  return { gate, splits: stands.length > 0 ? treeOf(best.cuts) : {} };
}

/**
 * The Fit: the table fitted over the tree the split gate grows, and the gate's record. `previous` is the `gate` record
 * of the last Fit that computed, or null where there is none; the rest is fitTable's. A split stands in the table
 * once it has passed the gate at two consecutive Fits on the same input or inputs, over other records each time — a
 * Fit over the records the last one searched is no look, and keeps what that one found — and is gone from it at the
 * first Fit it fails; that Fit's `gate` is the whole of what the next one reads of this. `startingCells` is
 * fitTable's.
 * @returns {{ table: object, gate: { records: string, scored: number, left_out: number, best: object|null, passed: string[], stands: string[] } }}
 */
export function fitTree({ prior, features, members, verdicts, guard, previous = null, startingCells = STARTING_CELLS }) {
  const window = guard.window_start ?? prior.window_start ?? null;
  const fitted = fitPulls({ features, members, verdicts, window });
  const { gate, splits } = growTree({ prior, ...fitted, tripped: new Set(guard.tripped), previous });
  return { table: tableOver({ prior: { ...prior, splits }, ...fitted, guard, window, startingCells }), gate };
}

/**
 * What the install runs, off `modelRoles` (`omp config get modelRoles --json`, or the JSON file `modelRoles` names),
 * omp's model catalog (`omp models --json`, or the JSON file `catalog` names) and the implementer definitions in the
 * `agents` directory: `{ install, why: null }` with installOf's answer, or `{ install: null, why }` where a read fails
 * or does not answer in OMP_READ_TIMEOUT_MS, `modelRoles` is no record or the catalog has no `models` list. Never
 * throws.
 */
export function readInstall({ modelRoles: modelRolesPath = null, catalog: catalogPath = null, agents = AGENTS_DIR } = {}) {
  const kind = (v) => (v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`);
  try {
    const modelRoles = modelRolesPath === null
      ? readOmpConfigValue("modelRoles", { timeout: OMP_READ_TIMEOUT_MS })
      : JSON.parse(readFileSync(modelRolesPath, "utf8"));
    const catalog = catalogPath === null
      ? readOmpModelCatalog({ timeout: OMP_READ_TIMEOUT_MS })
      : JSON.parse(readFileSync(catalogPath, "utf8"));
    if (typeof modelRoles !== "object" || modelRoles === null || Array.isArray(modelRoles)) {
      throw new Error(`modelRoles is ${kind(modelRoles)}, not a record of role to model`);
    }
    if (!Array.isArray(catalog?.models)) throw new Error(`omp's model catalog has no models list (models: ${kind(catalog?.models)})`);
    return { install: installOf({ modelRoles, catalog, definitions: readdirSync(agents) }), why: null };
  } catch (e) {
    return { install: null, why: e.message };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, {
    flags: {
      session: "value", objective: "value", ticket: "value", arm: "value", "impl-row": "value", issue: "value",
      sizing: "value", guard: "value", table: "value", pending: "value", "chain-head": "bool", "model-roles": "value", catalog: "value", agents: "value",
    },
    positionals: ["route"],
  });
  F.sweep();
  F.stray();
  if (!process.argv.slice(2).includes("route")) die("usage: ticket-router.mjs route …");
  const need = (name) => F.arg(name) ?? die(`route needs --${name}`);

  // With no `--table`, routes by the Fit beside `--guard`, else by the starting table.
  const fit = F.arg("table") === null && F.arg("guard") !== null ? readFitBeside(F.arg("guard")) : null;
  const tablePath = F.arg("table") ?? DEFAULT_TABLE;
  let table = fit?.table ?? null;
  if (table === null) {
    try { table = JSON.parse(readFileSync(tablePath, "utf8")); } catch (e) { die(`cannot read the router table ${tablePath}: ${e.message}`); }
    const valid = validateTable(table);
    if (valid instanceof Error) die(`${tablePath}: ${valid.message}`);
  }

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
  const guard = readGuard(readJson(guardPath));
  const chainHead = F.has("chain-head");
  // Every Pull reads what the install runs: which Cells it runs gates the row's Cell and each draw, and the Cells it
  // draws after burn-in are the group's exploration Cells. A read that fails or does not answer in OMP_READ_TIMEOUT_MS,
  // a `modelRoles` that is no record and a catalog with no `models` list leave the Pull's Cells unchecked and its
  // every-5th draw empty, and warn, never the exit; so does a read that holds nothing to run: a role that runs at no
  // level, no implementer definition, or no level of the default Cell's role that is both run and defined.
  const warn = (what) => process.stderr.write(`${NAME}: WARNING ${what}\n`);
  const agents = F.arg("agents") ?? AGENTS_DIR;
  const { install, why } = readInstall({ modelRoles: F.arg("model-roles"), catalog: F.arg("catalog"), agents });
  if (install === null) {
    warn(`cannot read what this install runs: ${why} — no Cell is checked against it and no exploration Cell is drawn`);
  } else {
    const unrun = ROLES_BY_PRICE.filter((role) => install.ladders[role].length === 0);
    if (unrun.length > 0) {
      warn(`this install runs ${unrun.join(", ")} at no level (modelRoles names no model for it, or one omp's catalog lists at none) — no Cell of ${unrun.length === 1 ? "that role" : "those roles"} is routed or drawn`);
    }
    if (install.defined.size === 0) warn(`${agents} holds no implementer definition — no exploration Cell is drawn`);
    if (!isRunnable(install, POLICY_CELL) && defaultCellOf(install) === POLICY_CELL) {
      warn(`no level of ${POLICY_CELL}'s role runs here with an implementer definition — ${POLICY_CELL} stays the default Cell`);
    }
  }
  const { line, row } = route({
    session, ticket: Number(ticket), arm, implRow: Number(implRowArg), chainHead,
    issue: readJson(issuePath), sizing: readJson(F.arg("sizing")), guard, table, objective, root, version,
    fallback: fit?.fallback ?? null, install,
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
}

if (isCLI(import.meta.url)) main();
