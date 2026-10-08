#!/usr/bin/env node
// The per-ticket router: which implementer cell a Pull dispatches. One script
// for dispatch and for the offline fit, because the stratum rule is the one
// function that must never read differently between the two.
//
//   route --session <dir|id> --ticket <N> --arm A|B --impl-row <k>
//         --issue <issue.json> --guard <cost-guard.json>
//         [--sizing <sizing.json>] [--table <router-table.json>]
//         [--chain-head] [--pending <tsv>]
//     Prints one line, `POLICY=<cell> CELL=<cell> DRAW=<k/K|->
//     STRATUM=<light|heavy|unknown> REASON=<reason>`, and appends the Pull's
//     ticket-features row to the pending TSV (by default
//     `ticket-features.pending.tsv` beside `--guard`, in the run's `.fleet/`). Exit 0 on
//     every data degradation — a missing or unreadable issue, sizing or guard
//     file degrades the line, never the exit. Exit 2 only on a usage error or
//     an unreadable/invalid table: the caller does not dispatch then.
//   fit --table <json> --features <tsv> --members <tsv> --verdicts <tsv>
//       --guard <cost-guard.json> [--due]
//     Re-fits the table from the three TSVs and the guard and rewrites
//     `--table`. With `--due`, writes nothing and prints `DUE=yes|no
//     MERGED=<n>/<N>`: whether N merged PRs have landed since
//     `fitted_through`.
//   --check --table <json> --features <tsv> --members <tsv> --verdicts <tsv>
//     Re-fits from the rows the table was fitted through, against the guard
//     snapshot the table itself records, and exits 1 when the result is not
//     the table: the table is a code carrier, never hand-edited.
//
// The script never touches the network: the issue, the sizing verdict and
// the guard are files the caller wrote.

import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { CELL, POLICY_CELL, drawCell, parseMember } from "./ledger-grammar.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { DATE, lastPullByTicket, parseTierOutcomes, rulingFor, rulingsByTicket } from "./tier-outcomes.mjs";

const NAME = "ticket-router";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TABLE = join(SCRIPT_DIR, "router-table.json");

// The ticket-features row, one per Pull, in this order.
export const COLUMNS = Object.freeze([
  "run_date", "session", "agent", "ticket", "policy_cell", "chosen_cell",
  "exploration_draw", "sizing_src", "sizing_pre", "router_usd", "brief_chars",
  "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "kind",
]);

export const STRATA = Object.freeze(["light", "heavy", "unknown"]);
// The free classifier's thresholds: heavy past the median brief length of
// the tickets whose sizing verdict is known, or past five criteria.
const HEAVY_BRIEF_CHARS = 3483;
const HEAVY_CRITERIA = 5;
// Exploration cadence after burn-in: the Pull that creates `impl-` row 5k.
const EXPLORE_EVERY = 5;
// The fit's adoption floor (n per side), margin, and cadence.
const MIN_N = 20;
const ADOPT_RATIO = 0.75;
export const FIT_EVERY_MERGED = 50;
// Stage 2 adds the effort cells on the roles whose stage-1 cell survived.
const STAGE2 = Object.freeze([{ cell: "slow-medium", survives: "slow-high" }, { cell: "task-max", survives: "task-high" }]);
const KINDS = new Set(["bug", "enhancement", "documentation"]);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// metrics — every one free, deterministic and known before dispatch
// ---------------------------------------------------------------------------

/** The brief: the last comment carrying an `## Agent Brief` heading line, else the body. */
export function briefText(issue) {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? "");
    if (/^## Agent Brief/m.test(body)) return body;
  }
  return String(issue.body ?? "");
}

/** The metric columns for a parsed `gh issue view --json title,body,comments,labels,createdAt`, or null when it is not one. */
export function issueMetrics(issue, now = Date.now()) {
  if (issue === null || typeof issue !== "object" || Array.isArray(issue) || typeof issue.body !== "string") return null;
  const brief = briefText(issue).trim();
  const lines = brief.split(/\r?\n/);
  const paths = new Set();
  for (const m of brief.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1];
    if (/\s/.test(tok)) continue;
    if (tok.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(tok)) paths.add(tok);
  }
  const created = Date.parse(issue.createdAt ?? "");
  const kind = (Array.isArray(issue.labels) ? issue.labels : []).map((l) => l?.name).find((n) => KINDS.has(n)) ?? "";
  return {
    brief_chars: String([...brief].length),
    criteria: String(lines.filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l)).length),
    comments: String(Array.isArray(issue.comments) ? issue.comments.length : 0),
    age_days: Number.isFinite(created) ? String(Math.max(0, Math.floor((now - created) / DAY_MS))) : "",
    paths: String(paths.size),
    test_paths: String([...paths].filter((p) => /\.test\.|(^|\/)tests?\//.test(p)).length),
    xrefs: String(new Set([...brief.matchAll(/#(\d+)/g)].map((m) => m[1])).size),
    kind,
  };
}

/** The `rule` classifier, over a row's metric columns: blank metrics are `unknown`. */
export function ruleStratum({ brief_chars, criteria }) {
  if (brief_chars === "" || brief_chars === undefined || criteria === "" || criteria === undefined) return "unknown";
  return Number(brief_chars) > HEAVY_BRIEF_CHARS || Number(criteria) > HEAVY_CRITERIA ? "heavy" : "light";
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

/** A parsed table, or an Error saying why it is not one. */
export function validateTable(t) {
  const bad = (why) => new Error(`router table: ${why}`);
  if (t === null || typeof t !== "object" || Array.isArray(t)) return bad("not a JSON object");
  if (!Array.isArray(t.cells) || t.cells.length === 0) return bad("`cells` is not a non-empty array");
  for (const c of t.cells) if (typeof c !== "string" || !CELL.test(c)) return bad(`\`cells\` holds ${JSON.stringify(c)}, not a cell token`);
  if (new Set(t.cells).size !== t.cells.length) return bad("`cells` repeats a cell");
  if (t.rows === null || typeof t.rows !== "object" || Array.isArray(t.rows)) return bad("`rows` is not an object");
  if (!Object.hasOwn(t.rows, "*")) return bad("`rows` has no `*` row");
  for (const [k, v] of Object.entries(t.rows)) {
    if (k !== "*" && !STRATA.includes(k)) return bad(`\`rows\` key ${JSON.stringify(k)} is not \`*\` or a stratum`);
    if (typeof v !== "string" || !CELL.test(v)) return bad(`\`rows.${k}\` is ${JSON.stringify(v)}, not a cell token`);
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

/** Arm B runs only once a classifier has passed its gate and some row is not the default. */
export function bArmLive(table) {
  return table.classifier.b !== null && Object.values(table.rows).some((c) => c !== POLICY_CELL);
}

const rowFor = (rows, stratum) => rows[stratum] ?? rows["*"];

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
 * One Pull's routing. Pure: every input is already read.
 * @returns {{ line: string, row: Record<string,string> }}
 */
export function route({ session, ticket, arm, implRow, chainHead = false, issue, sizing = null, guard, table, now = Date.now() }) {
  let reason = null;
  const degrade = (r) => { reason ??= r; };

  const metrics = issueMetrics(issue, now);
  if (metrics === null) degrade("no-issue-json");
  const blank = Object.fromEntries(["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "kind"].map((c) => [c, ""]));
  const m = metrics ?? blank;
  const ruleS = ruleStratum(m);

  let stratum = ruleS;
  let sizingSrc = "rule";
  let sizingPre = "";
  let routerUsd = "";
  const b = arm === "B" && bArmLive(table);
  if (b) {
    const s = readSizing(sizing, table.classifier);
    if (s === null) {
      degrade("no-sizing");
      stratum = "unknown";
      sizingSrc = "";
    } else {
      ({ stratum, src: sizingSrc, label: sizingPre, usd: routerUsd } = s);
    }
  }

  let policy = rowFor(table.rows, ruleS);
  let base = b ? rowFor(table.rows, stratum) : policy;
  let cell;
  let draw = "-";
  if (guard === null) {
    // The guard cannot be evaded by deleting it: no guard, default cell only.
    degrade("guard-missing");
    policy = POLICY_CELL;
    cell = POLICY_CELL;
  } else {
    const tripped = new Set(guard.tripped);
    if (tripped.has(policy) || tripped.has(base)) {
      degrade("table-cell-tripped");
      if (tripped.has(policy)) policy = POLICY_CELL;
      if (tripped.has(base)) base = POLICY_CELL;
    }
    cell = base;
    const exploring = table.burn_in || (implRow % EXPLORE_EVERY === 0 && !chainHead);
    if (exploring) {
      const policyCell = table.burn_in ? null : base;
      if (table.cells.some((c) => c !== policyCell && tripped.has(c))) degrade("guard-tripped");
      const d = drawCell({ session, ticket, policyCell, cells: table.cells.filter((c) => !tripped.has(c)) });
      if (d.K > 0) {
        cell = d.cell;
        draw = `${d.k}/${d.K}`;
      }
    }
  }
  reason ??= "ok";

  const row = {
    run_date: sessionDate(session), session, agent: `impl-${ticket}`, ticket: String(ticket),
    policy_cell: policy, chosen_cell: cell, exploration_draw: draw === "-" ? "" : draw,
    sizing_src: sizingSrc, sizing_pre: sizingPre, router_usd: routerUsd, ...m,
  };
  return { line: `POLICY=${policy} CELL=${cell} DRAW=${draw} STRATUM=${stratum} REASON=${reason}`, row };
}

export function formatFeatureRow(row) {
  return COLUMNS.map((c) => String(row[c] ?? "").replace(/[\t\r\n]/g, " ")).join("\t");
}

/** Data rows of a ticket-features TSV as objects; throws on a missing header or a short row. */
export function parseFeatures(text) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("no header line");
  if (lines[0] !== COLUMNS.join("\t")) throw new Error(`header is not the ${COLUMNS.length} ticket-features columns`);
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    if (cells.length !== COLUMNS.length) throw new Error(`malformed row: ${cells.length} fields, expected ${COLUMNS.length} — ${l.slice(0, 60)}`);
    return Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]));
  });
}

// ---------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------

// Members whose cost does not vary with the implementer cell.
const UNBOOKED = (name) => name.startsWith("merge-bot-") || name === "memory" || name === "__advisor";
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * The verdict on a ticket's Pull dated `pullDate`, `{ pr, fail }`, or null: the
 * ruling `rulingFor` picks. A verdict is a ruled PR; the floor fails on a
 * minted false claim or an unclosed ticket.
 */
function verdictOf(rulings, ticket, pullDate) {
  const r = rulingFor(rulings, ticket, pullDate);
  return r && { pr: String(r.pr ?? ""), fail: r.minted_false_claim === "yes" || r.closed_own_ticket === "no" };
}

/**
 * The features rows with a YYYY-MM-DD `run_date`, the rows that can be placed
 * against the window, the cut and a ruling. A blank `run_date` (route writes one
 * for a session id with no date) is no input row and is left out. Any other
 * date is a hand-edit that cannot be placed and is refused, as `rulingFor`
 * refuses a ruling's: dropping it would shrink the fit unseen.
 */
function datedRows(features) {
  return features.filter((r) => {
    if (DATE.test(r.run_date)) return true;
    if (r.run_date !== "") throw new Error(`ticket #${r.ticket}: a ticket-features row's run_date is '${r.run_date}', expected YYYY-MM-DD or blank`);
    return false;
  });
}

/**
 * Per-ticket input rows: the ticket's features rows inside [window, cutoff],
 * attributed to its LAST row's (in file order) cell and stratum, restricted to rows the
 * free classifier routed plus exploration rows — a row a live B classifier
 * routed is the A/B's test set, not the fit's. Its verdict rules its last
 * input row. A row with a blank `run_date` (route writes one for a session id
 * with no date) is no input row: it cannot be placed against the window, the
 * cut or its ruling, and a window bound drops it anyway. A `run_date` that is
 * neither blank nor YYYY-MM-DD is refused (see `datedRows`).
 * A fit over everything cuts at its latest features row's date;
 * the verdict and member rows are cut at that same date, so `--check`'s
 * re-fit at the recorded `fitted_through` reads the rows the fit read and a
 * verdict or member row that lands later waits for the next fit instead of
 * failing CI.
 */
function fitTickets({ features, members, verdicts, window, cutoff }) {
  const inRange = datedRows(features).filter((r) => (!window || r.run_date >= window)
    && (cutoff === undefined || (cutoff !== null && r.run_date <= cutoff)));
  const through = cutoff === undefined ? inRange.map((r) => r.run_date).sort().at(-1) ?? null : cutoff;
  const upToThrough = (r) => through === null || !r.run_date || r.run_date <= through;
  members = members.filter(upToThrough);
  const byTicket = new Map();
  for (const r of inRange) {
    if (!byTicket.has(r.ticket)) byTicket.set(r.ticket, []);
    byTicket.get(r.ticket).push(r);
  }
  // A ruling whose date is not YYYY-MM-DD cannot be placed against the cut, and
  // a string `<=` would drop 'abc' or '2027' unseen: it is left in, so `rulingFor`
  // refuses it when its ticket is an input, as `fit --due` does.
  const rulings = rulingsByTicket(verdicts.filter((r) => !DATE.test(r.run_date) || upToThrough(r)));
  const lastPulls = lastPullByTicket(inRange);
  const out = [];
  for (const [ticket, rows] of byTicket) {
    const last = lastPulls.get(ticket);
    if (last.exploration_draw === "" && last.sizing_src !== "rule") continue;
    const verdict = verdictOf(rulings, ticket, last.run_date);
    const keys = new Set(rows.map((r) => `${r.session}\0${r.agent}`));
    let cost = 0;
    let costKnown = true;
    let booked = 0;
    let fixRounds = 0;
    for (const mr of members) {
      const name = String(mr.member ?? mr.agent ?? "");
      if (UNBOOKED(name)) continue;
      if (!(keys.has(`${mr.session}\0${mr.agent}`) || mr.ticket === ticket || (verdict && verdict.pr && mr.pr === verdict.pr))) continue;
      booked++;
      // `cost` is a priced member-outcomes column; a row without it makes
      // the ticket's $ unknown, so the fit adopts nothing off a TSV that lacks the column.
      if (mr.cost === undefined || mr.cost === "" || !Number.isFinite(Number(mr.cost))) costKnown = false;
      else cost += Number(mr.cost);
      if (parseMember(name)?.family === "fix-pr") fixRounds++;
    }
    // A ticket with no member row on record has an unknown cost, not a free one.
    if (booked === 0) costKnown = false;
    for (const r of rows) if (r.router_usd !== "") cost += Number(r.router_usd) || 0;
    out.push({ ticket, cell: last.chosen_cell, stratum: ruleStratum(last), verdict, cost, costKnown, fixRounds });
  }
  return { tickets: out, used: inRange };
}

function estimate(tickets) {
  const est = {};
  for (const t of tickets) {
    for (const s of [t.stratum, "*"]) {
      est[s] ??= {};
      const e = (est[s][t.cell] ??= { n: 0, merged: 0, fails: 0, cost: 0, costKnown: true, fix: 0 });
      e.n++;
      e.cost += t.cost;
      e.costKnown &&= t.costKnown;
      if (t.verdict) {
        e.merged++;
        if (t.verdict.fail) e.fails++;
        e.fix += t.fixRounds;
      }
    }
  }
  const out = {};
  for (const s of Object.keys(est).sort()) {
    out[s] = {};
    for (const c of Object.keys(est[s]).sort()) {
      const e = est[s][c];
      out[s][c] = {
        n: e.n,
        merged: e.merged,
        usd_per_merged: e.merged && e.costKnown ? round4(e.cost / e.merged) : null,
        fail_rate: e.merged ? round4(e.fails / e.merged) : null,
        fix_rounds: e.merged ? round4(e.fix / e.merged) : null,
        review_findings: null,
      };
    }
  }
  return out;
}

// Among cells with n >= MIN_N in a stratum and not tripped, the one with the
// lowest $ per merged PR — adopted only at or under ADOPT_RATIO of the
// default cell's. The quality floor is the guard's to enforce, never the
// fit's. null when the stratum cannot decide (no default cell at n, or no
// candidate at n).
function adopt(est, cells, tripped) {
  const base = est?.[POLICY_CELL];
  if (!base || base.n < MIN_N || base.usd_per_merged === null) return null;
  const candidates = cells
    .filter((c) => c !== POLICY_CELL && !tripped.has(c))
    .map((c) => ({ c, e: est[c] }))
    .filter(({ e }) => e && e.n >= MIN_N && e.usd_per_merged !== null)
    .sort((a, b) => a.e.usd_per_merged - b.e.usd_per_merged || (a.c < b.c ? -1 : 1));
  if (candidates.length === 0) return null;
  return candidates[0].e.usd_per_merged <= ADOPT_RATIO * base.usd_per_merged ? candidates[0].c : POLICY_CELL;
}

/**
 * The re-fit table. `guard` is `{ tripped, n, window_start }` (readGuard's
 * shape); `cutoff` limits every input to rows with `run_date <= cutoff`
 * (--check), or is undefined for a fit over everything, which cuts at its
 * latest features row's date.
 */
export function fitTable({ prior, features, members, verdicts, guard, cutoff }) {
  const window = guard.window_start ?? prior.window_start ?? null;
  const { tickets, used } = fitTickets({ features, members, verdicts, window, cutoff });
  const estimates = estimate(tickets);
  const tripped = new Set(guard.tripped);

  let { stage, cells } = prior;
  cells = [...cells];
  const rows = { "*": adopt(estimates["*"], cells, tripped) ?? POLICY_CELL };
  for (const s of STRATA) {
    const a = adopt(estimates[s], cells, tripped);
    if (a !== null) rows[s] = a;
  }
  const atN = (c) => (guard.n[c] ?? 0) >= MIN_N;
  if (stage === 1 && cells.every(atN) && (rows["*"] !== POLICY_CELL || cells.some((c) => tripped.has(c)))) {
    stage = 2;
    for (const { cell, survives } of STAGE2) {
      if (!cells.includes(cell) && cells.includes(survives) && !tripped.has(survives)) cells.push(cell);
    }
  }
  const dates = used.map((r) => r.run_date).sort();
  return {
    window_start: window,
    fitted_through: dates.length ? dates[dates.length - 1] : prior.fitted_through ?? null,
    n_rows: tickets.length,
    stage,
    cells,
    burn_in: !cells.every(atN),
    rows,
    classifier: prior.classifier,
    estimates,
    guard: { tripped: [...tripped].sort(), n: Object.fromEntries(Object.keys(guard.n).sort().map((c) => [c, guard.n[c]])) },
  };
}

/** Merged PRs (tickets with a verdict on their last such row in file order) among the YYYY-MM-DD-dated features rows dated after `fitted_through`. */
export function mergedSince({ table, features, verdicts }) {
  const rulings = rulingsByTicket(verdicts);
  const after = datedRows(features).filter((r) => (!table.window_start || r.run_date >= table.window_start) && (!table.fitted_through || r.run_date > table.fitted_through));
  return [...lastPullByTicket(after)].filter(([ticket, p]) => verdictOf(rulings, ticket, p.run_date)).length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, {
    flags: {
      session: "value", ticket: "value", arm: "value", "impl-row": "value", issue: "value",
      sizing: "value", guard: "value", table: "value", pending: "value", "chain-head": "bool",
      features: "value", members: "value", verdicts: "value", check: "bool", due: "bool",
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
    route: ["session", "ticket", "arm", "impl-row", "issue", "sizing", "guard", "table", "pending", "chain-head"],
    fit: ["table", "features", "members", "verdicts", "guard", "due"],
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
    const sessionArg = need("session").replace(/\/+$/, "");
    const session = basename(sessionArg);
    const ticket = need("ticket");
    if (!/^[1-9][0-9]*$/.test(ticket)) die(`--ticket ${ticket} is not an issue number`);
    const arm = need("arm");
    if (arm !== "A" && arm !== "B") die(`--arm ${arm} is not A or B`);
    const implRowArg = need("impl-row");
    if (!/^[1-9][0-9]*$/.test(implRowArg)) die(`--impl-row ${implRowArg} is not a positive row count`);
    const issuePath = need("issue");
    const guardPath = need("guard");
    const { line, row } = route({
      session, ticket: Number(ticket), arm, implRow: Number(implRowArg), chainHead: F.has("chain-head"),
      issue: readJson(issuePath), sizing: readJson(F.arg("sizing")), guard: readGuard(readJson(guardPath)), table,
    });
    const pending = F.arg("pending") ?? join(dirname(guardPath), "ticket-features.pending.tsv");
    try {
      mkdirSync(dirname(pending), { recursive: true });
      const header = existsSync(pending) ? "" : `${COLUMNS.join("\t")}\n`;
      appendFileSync(pending, `${header}${formatFeatureRow(row)}\n`);
    } catch (e) {
      process.stderr.write(`${NAME}: WARNING could not append to ${pending}: ${e.message} — this Pull's ticket-features row is not recorded\n`);
    }
    process.stdout.write(`${line}\n`);
    return;
  }

  const read = (flag, parse) => {
    const p = need(flag);
    try { return parse(readFileSync(p, "utf8")); } catch (e) { die(`cannot read --${flag} ${p}: ${e.message}`); }
  };
  const features = read("features", parseFeatures);
  const members = read("members", parseMemberTsv);
  const verdicts = read("verdicts", parseTierOutcomes);
  // The join throws on a features row it cannot place and on a ruling of an input ticket it cannot place.
  const joined = (fit) => {
    try { return fit(); } catch (e) { die(`cannot join --features ${need("features")} with --verdicts ${need("verdicts")}: ${e.message}`); }
  };

  if (mode === "check") {
    const refit = joined(() => fitTable({ prior: table, features, members, verdicts, guard: { ...table.guard, window_start: table.window_start }, cutoff: table.fitted_through }));
    const differ = Object.keys({ ...refit, ...table }).filter((k) => !isDeepStrictEqual(refit[k], table[k]));
    if (differ.length) {
      process.stderr.write(`${NAME}: ${tablePath} is not a re-fit of its own rows — differs in ${differ.map((k) => `\`${k}\``).join(", ")}; re-fitted:\n${JSON.stringify(refit, null, 2)}\n`);
      // exitCode, not exit(): a piped stderr is written asynchronously and exit() can cut the payload off.
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${NAME}: ${tablePath} matches a re-fit of ${refit.n_rows} tickets through ${refit.fitted_through ?? "no rows"}\n`);
    return;
  }

  const guardPath = need("guard");
  const guard = readGuard(readJson(guardPath));
  if (guard === null) die(`cannot read --guard ${guardPath} as a cost guard — the fit needs its tripped cells and per-cell n`);
  if (F.has("due")) {
    const n = joined(() => mergedSince({ table, features, verdicts }));
    process.stdout.write(`DUE=${n >= FIT_EVERY_MERGED ? "yes" : "no"} MERGED=${n}/${FIT_EVERY_MERGED}\n`);
    return;
  }
  const next = joined(() => fitTable({ prior: table, features, members, verdicts, guard }));
  writeFileSync(`${tablePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${tablePath}.tmp`, tablePath);
  process.stdout.write(`${NAME}: fitted ${next.n_rows} tickets through ${next.fitted_through ?? "no rows"}; rows ${JSON.stringify(next.rows)}; burn_in ${next.burn_in}; stage ${next.stage}\n`);
}

if (isCLI(import.meta.url)) main();
