#!/usr/bin/env node
// The per-ticket router: which implementer cell a Pull dispatches. One script
// for dispatch and for the offline fit, because the stratum rule is the one
// function that must never read differently between the two.
//
//   route [--session <dir|id>] --ticket <N> --arm A|B --impl-row <k>
//         --issue <issue.json> --guard <cost-guard.json>
//         [--sizing <sizing.json>] [--table <router-table.json>]
//         [--chain-head] [--pending <tsv>]
//     Prints one line, `POLICY=<cell> CELL=<cell> DRAW=<k/K|->
//     STRATUM=<light|heavy|unknown> REASON=<reason>`, and appends the Pull's
//     ticket-features row to the pending TSV (by default
//     `ticket-features.pending.tsv` beside `--guard`, in the run's `.fleet/`). Exit 0 on
//     every data degradation — a missing or unreadable issue, sizing or guard
//     file degrades the line, never the exit. Exit 2 only on a usage error or
//     an unreadable/invalid table: the caller does not dispatch then. With no
//     `--session`, the session is the one the phase-0 receipt
//     `.fleet/phase0.json` records; a receipt that records none is exit 2.
//   fit --table <json> --features <tsv> --members <tsv> --verdicts <tsv>
//       --guard <cost-guard.json> --commit <rev> [--due]
//     Re-fits the table from the three TSVs as committed at `--commit` (read
//     with `git show`, never from the working tree) and the guard, and
//     rewrites `--table`, recording the commit's sha as `fitted_commit`. The
//     TSV flags name paths inside the repository that holds them. With
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
import { CELL, POLICY_CELL, drawCell, parseMember } from "./ledger-grammar.mjs";
import { sessionFromReceipt } from "./phase0-receipt.mjs";
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

/** An `## Agent Brief` heading line: what marks the comment the brief is taken from. */
const AGENT_BRIEF = /^## Agent Brief/m;

/** The brief: the last comment carrying an `## Agent Brief` heading line, else the body. */
export function briefText(issue) {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? "");
    if (AGENT_BRIEF.test(body)) return body;
  }
  return String(issue.body ?? "");
}

/** A ruling or triage heading line: what a decision posted outside an `## Agent Brief` comment is headed with. */
const RULING_HEADING = /^## (?:Ruling|Triage).*$/m;

/**
 * The newest comment with a ruling or triage heading line and no `## Agent
 * Brief` heading line that comes after the last comment `briefText` takes the
 * brief from, or after none when there is no such comment, as its first ruling
 * or triage heading line and its `url`; null when none is.
 */
export function strandedRuling(issue) {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? "");
    if (AGENT_BRIEF.test(body)) return null;
    const heading = RULING_HEADING.exec(body);
    if (heading !== null) return { heading: heading[0], url: comments[i].url };
  }
  return null;
}

/** The line span `[at, end)` of `lines`' `Out of scope` section, heading to the next heading of its level or above; null when there is none. */
function outOfScopeSpan(lines) {
  const at = lines.findIndex((l) => /^#{1,6}\s*out of scope\b/i.test(l));
  if (at === -1) return null;
  const level = /^#+/.exec(lines[at])[0].length;
  for (let i = at + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h !== null && h[1].length <= level) return { at, end: i };
  }
  return { at, end: lines.length };
}

/** The `Out of scope` section of `text`, heading to the next heading of its level or above; null when there is none. */
export function outOfScope(text) {
  const all = text.split("\n");
  const span = outOfScopeSpan(all);
  return span === null ? null : all.slice(span.at, span.end).join("\n").trim();
}

/**
 * The file paths a brief names: every backticked token without whitespace that
 * holds a `/` or ends in an extension, in first-seen order, each once. The
 * brief's `Out of scope` section names no target, so its tokens are skipped.
 */
export function briefPaths(brief) {
  const all = brief.split("\n");
  const span = outOfScopeSpan(all);
  const kept = span === null ? brief : [...all.slice(0, span.at), ...all.slice(span.end)].join("\n");
  const paths = new Set();
  for (const m of kept.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1];
    if (/\s/.test(tok)) continue;
    if (tok.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(tok)) paths.add(tok);
  }
  return [...paths];
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
 * Per-ticket input rows: the ticket's features rows inside the window,
 * attributed to its LAST row's (in file order) cell and stratum, restricted to rows the
 * free classifier routed plus exploration rows — a row a live B classifier
 * routed is the A/B's test set, not the fit's. Its verdict rules its last
 * input row. A row with a blank `run_date` (route writes one for a session id
 * with no date) is no input row: it cannot be placed against the window or
 * its ruling, and a window bound drops it anyway. A `run_date` that is
 * neither blank nor YYYY-MM-DD is refused (see `datedRows`).
 * A fit reads everything in the commit it is given: no row is cut by date,
 * because `--check` re-reads that same commit rather than re-cutting the
 * working tree's files.
 */
function fitTickets({ features, members, verdicts, window }) {
  const inRange = datedRows(features).filter((r) => !window || r.run_date >= window);
  const byTicket = new Map();
  for (const r of inRange) {
    if (!byTicket.has(r.ticket)) byTicket.set(r.ticket, []);
    byTicket.get(r.ticket).push(r);
  }
  // `rulingFor` refuses a ruling whose date is not YYYY-MM-DD when its ticket
  // is an input ticket. An input ticket is one the fit reads — its last
  // in-window row is an exploration row or has `sizing_src` `rule`, which the
  // skip below keeps — not every ticket with an in-window features row.
  // `fit --due` also refuses for a ticket the skip drops: `mergedSince` calls
  // `verdictOf` on every ticket with an in-window row the fitted commit does
  // not hold, with no such skip.
  const rulings = rulingsByTicket(verdicts);
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
  return out;
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
 * shape); `commit` is the sha of the commit the inputs were read from, or null
 * for the empty corpus before any fit.
 */
export function fitTable({ prior, features, members, verdicts, guard, commit = null }) {
  const window = guard.window_start ?? prior.window_start ?? null;
  const tickets = fitTickets({ features, members, verdicts, window });
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
  return {
    window_start: window,
    fitted_commit: commit,
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

/**
 * Merged PRs (tickets with a verdict on their last such row in file order)
 * among the YYYY-MM-DD-dated features rows on or after `window_start` that the
 * fitted commit's features file (`fitted`, parsed rows; empty before any fit)
 * does not hold, matched by `session` and `agent`.
 */
export function mergedSince({ table, features, verdicts, fitted }) {
  const rulings = rulingsByTicket(verdicts);
  const read = new Set(fitted.map((r) => `${r.session}\0${r.agent}`));
  const after = datedRows(features).filter((r) => (!table.window_start || r.run_date >= table.window_start) && !read.has(`${r.session}\0${r.agent}`));
  return [...lastPullByTicket(after)].filter(([ticket, p]) => verdictOf(rulings, ticket, p.run_date)).length;
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
      session: "value", ticket: "value", arm: "value", "impl-row": "value", issue: "value",
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
    route: ["session", "ticket", "arm", "impl-row", "issue", "sizing", "guard", "table", "pending", "chain-head"],
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
    const { line, row } = route({
      session, ticket: Number(ticket), arm, implRow: Number(implRowArg), chainHead: F.has("chain-head"),
      issue: readJson(issuePath), sizing: readJson(F.arg("sizing")), guard: readGuard(readJson(guardPath)), table,
    });
    const pending = F.arg("pending") ?? join(dirname(guardPath), "ticket-features.pending.tsv");
    // The header decision and the append are not atomic and take no lock. That is
    // safe only while the run's controller is the only process that routes or
    // drains on a checkout, doing both serially: one controller per checkout is
    // the rule, and neither this append nor the drain checks it.
    try {
      mkdirSync(dirname(pending), { recursive: true });
      const header = statSync(pending, { throwIfNoEntry: false })?.size > 0 ? "" : `${COLUMNS.join("\t")}\n`;
      appendFileSync(pending, `${header}${formatFeatureRow(row)}\n`);
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
  // The join throws on a features row it cannot place and on a ruling of an input ticket it cannot place.
  // For `fit` and `--check` an input ticket is one `fitTickets` reads (its last in-window row is an
  // exploration row or has `sizing_src` `rule`), not every ticket with an in-window features row. `fit --due` also
  // covers a ticket `fitTickets` skips, because `mergedSince` calls `verdictOf` on every ticket with an in-window
  // row the fitted commit does not hold, with no such skip.
  const joined = (fit) => {
    try { return fit(); } catch (e) { die(`cannot join --features ${need("features")} with --verdicts ${need("verdicts")}: ${e.message}`); }
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
    process.stdout.write(`${NAME}: ${tablePath} matches a re-fit of ${refit.n_rows} tickets at ${short(fitted)}\n`);
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
    const n = joined(() => mergedSince({ table, features, verdicts, fitted: read }));
    process.stdout.write(`DUE=${n >= FIT_EVERY_MERGED ? "yes" : "no"} MERGED=${n}/${FIT_EVERY_MERGED}\n`);
    return;
  }
  const next = joined(() => fitTable({ prior: table, features, members, verdicts, guard, commit: sha }));
  writeFileSync(`${tablePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${tablePath}.tmp`, tablePath);
  process.stdout.write(`${NAME}: fitted ${next.n_rows} tickets at ${short(sha)}; rows ${JSON.stringify(next.rows)}; burn_in ${next.burn_in}; stage ${next.stage}\n`);
}

if (isCLI(import.meta.url)) main();
