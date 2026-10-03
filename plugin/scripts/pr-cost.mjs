#!/usr/bin/env node
// $ per merged PR, per implementer cell, and the cost guard over it.
//
//   pr-cost.mjs [--guard] [--json] [--member-outcomes <tsv>] [--tier-outcomes <tsv>]
//               [--ticket-features <tsv>] [--pricing <json>] [--out <json>]
//
// Inputs: the three metrics TSVs (docs/metrics/ by default, relative to the
// working directory) and ONE `gh pr list --state all`, scoped to PRs created
// in the window, for merged state, which tier-outcomes.tsv does not record. A
// PR that list does not return is counted pending. Output: a TSV per cell on stdout
// (`--json` prints the whole report instead). `--guard` also writes the
// verdict to `.fleet/cost-guard.json` (`--out` overrides) and exits on it:
//
//   0  ok — no cell tripped
//   3  at least one cell tripped; `tripped[]` names each
//   4  no verdict — the baseline cell has fewer than MIN_N merged PRs
//   2  input error — nothing is written
//
// The exit status is the guard's carrier: the verdict never lives only in
// prose. The router reads the file; a missing or unparseable file means the
// default cell only, so deleting it cannot evade the guard.
//
// BOOKING. A Pull is a ticket-features.tsv row; its $ is the cost of the
// member-outcomes.tsv row with the same `session` + `agent`, plus every member
// that one dispatched (an `agent` path nested under it). A PR's $ is every
// Pull of its ticket(s) up to the ruling — superseded re-dispatches included —
// plus every member whose NAME carries the PR (`review-pr-<n>`, `fix-pr-<n>`,
// the finisher spellings, the review fan-out labels; member-record.mjs's
// parseMemberName decides), with their own nested members. `merge-bot-*`,
// `memory` and `__advisor` are booked nowhere: their cost does not vary with
// the implementer's cell. Only omp rows are read; a blank `cost` books 0 and
// is counted as unpriced.
//
// A ticket's RULING is its last tier-outcomes.tsv row dated on or after its
// first Pull in the window; that row names the PR and carries the quality
// verdict. The PR's CELL is the `chosen_cell` of the last Pull dated on or
// before the ruling, cross-checked against that Pull's member row: a
// `subagent_type` other than `fleet-implementer-<cell>`, or an `effort` other
// than the cell's level, lists the PR under `mismatch` and books it to no cell
// at all. A PR still OPEN is pending and booked nowhere yet. A Pull with no
// ruling books to its own `chosen_cell` as unmerged spend — unless its member
// opened a PR that is still open, which is pending too.
//
// PER CELL: `n_pulls`; `n_merged`; `n_pass` (merged PRs passing the quality
// floor — failure is `minted_false_claim=yes` or `closed_own_ticket=no`);
// `fail_rate` = failed / merged; `mean_usd` = every $ booked to the cell —
// merged, unmerged and superseded — / merged, so a cell that abandons work
// carries that spend; `median_usd` over merged PRs alone, descriptive;
// `router_usd`, the Pulls' own routing cost, summed. `usd_diff_ci95` is a
// bootstrap 95% interval on `mean_usd` minus the baseline's — printed to be
// read, never judged on.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, isDigits } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { CELL } from "./ledger-grammar.mjs";
import { parseMemberName } from "./member-record.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { parseTierOutcomes } from "./tier-outcomes.mjs";

const NAME = "pr-cost";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// The guard's window opens here and never rolls: it is reset only by editing
// this constant in a reviewed change.
export const WINDOW_START = "2026-10-03";
export const BASELINE_CELL = "slow-high";
// Stage 1 is the model axis at fixed `high`.
export const STAGE_1 = ["slow-high", "task-high", "smol-high"];
export const MIN_N = 20;
// A cell trips when its fail rate is at least this many points above the
// baseline's, or its mean $ is at least the baseline's.
export const TRIP_POINTS = 15;
export const EXIT = { ok: 0, tripped: 3, none: 4 };
export const GH_PR_LIMIT = 1000;

export const FEATURE_COLUMNS = [
  "run_date", "session", "agent", "ticket", "policy_cell", "chosen_cell", "exploration_draw",
  "sizing_src", "sizing_pre", "router_usd", "brief_chars", "criteria", "comments", "age_days",
  "paths", "test_paths", "xrefs", "kind",
];

// ticket-features.tsv: one bare header line naming the columns, then rows.
// Read by header name; a row whose width differs from the header's is refused.
export function parseFeatures(text) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("ticket-features.tsv has no header line");
  const header = lines[0].split("\t");
  const missing = FEATURE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`ticket-features.tsv header lacks ${missing.join(", ")}`);
  return lines.slice(1).map((l, i) => {
    const cells = l.split("\t");
    if (cells.length !== header.length) {
      throw new Error(`ticket-features.tsv row ${i + 1}: ${cells.length} fields, expected ${header.length} — ${l.slice(0, 60)}`);
    }
    const row = Object.fromEntries(header.map((c, j) => [c, cells[j]]));
    if (!isDigits(row.ticket)) throw new Error(`ticket-features.tsv row ${i + 1}: ticket ${JSON.stringify(row.ticket)} is not a number`);
    if (!CELL.test(row.chosen_cell)) throw new Error(`ticket-features.tsv row ${i + 1}: chosen_cell ${JSON.stringify(row.chosen_cell)} is not a cell`);
    return row;
  });
}

const EXCLUDED_MEMBER = /^(?:merge-?bot|memory$|__advisor$)/i;
const lastSegment = (agent) => String(agent).split("/").at(-1);
const usd = (r) => (r.cost === "" || r.cost === undefined ? 0 : Number(r.cost));
const isMerged = (pr) => pr?.state === "MERGED";
const failed = (tier) => tier.minted_false_claim === "yes" || tier.closed_own_ticket === "no";
const round = (x, d = 4) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Deterministic, so a re-run prints the same interval.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each unit is one booked group: `{ usd, merged }`. mean_usd is Σusd / Σmerged.
export function bootstrapDiffCI(cellUnits, baseUnits, { iterations = 2000, seed = 1 } = {}) {
  if (!cellUnits.length || !baseUnits.length) return null;
  const rand = mulberry32(seed);
  const resample = (units) => {
    let u = 0, m = 0;
    for (let i = 0; i < units.length; i++) {
      const x = units[Math.floor(rand() * units.length)];
      u += x.usd; m += x.merged;
    }
    return m ? u / m : null;
  };
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    const a = resample(cellUnits), b = resample(baseUnits);
    if (a !== null && b !== null) diffs.push(a - b);
  }
  if (diffs.length < iterations / 2) return null;
  diffs.sort((x, y) => x - y);
  return [round(diffs[Math.floor(0.025 * (diffs.length - 1))], 2), round(diffs[Math.ceil(0.975 * (diffs.length - 1))], 2)];
}

// The trip rule, in integer counts so a 3-of-20 difference is exactly 15
// points rather than 14.999… in floating point.
export function trips(cell, base) {
  const failC = cell.n - cell.n_pass, failB = base.n - base.n_pass;
  const failRise = (failC * base.n - failB * cell.n) * 100 >= TRIP_POINTS * cell.n * base.n;
  return failRise || cell.mean_usd >= base.mean_usd;
}

export function computeReport({ members, tiers, features, prs, routerTable = null, pricing = null, windowStart = WINDOW_START }) {
  const omp = members.filter((r) => r.harness === "omp");
  const memberKey = (session, agent) => `${session}\0${agent}`;
  const prState = new Map(prs.map((p) => [String(p.number), p]));

  // Direct bookings, keyed by the member row they name.
  const pulls = features.filter((f) => f.run_date >= windowStart);
  const pullByKey = new Map(pulls.map((p) => [memberKey(p.session, p.agent), p]));
  const prMemberKeys = new Map();
  for (const r of omp) {
    if (EXCLUDED_MEMBER.test(lastSegment(r.member))) continue;
    if (pullByKey.has(memberKey(r.session, r.agent))) continue;
    const { pr } = parseMemberName(r.member);
    if (pr) prMemberKeys.set(memberKey(r.session, r.agent), pr);
  }
  // Every omp row books to its nearest booked ancestor (itself included).
  const pullUsd = new Map(), prMemberUsd = new Map();
  const memberOfPull = new Map();
  const booked = []; // [row, pull | null, pr | null]
  for (const r of omp) {
    if (EXCLUDED_MEMBER.test(lastSegment(r.member))) continue;
    const segs = String(r.agent).split("/");
    for (let i = segs.length; i > 0; i--) {
      const k = memberKey(r.session, segs.slice(0, i).join("/"));
      const pull = pullByKey.get(k);
      const pr = prMemberKeys.get(k);
      if (!pull && !pr) continue;
      booked.push([r, pull ?? null, pull ? null : pr]);
      if (pull) {
        pullUsd.set(pull, (pullUsd.get(pull) ?? 0) + usd(r));
        if (i === segs.length) memberOfPull.set(pull, r);
      } else prMemberUsd.set(pr, (prMemberUsd.get(pr) ?? 0) + usd(r));
      break;
    }
  }

  // Rulings: per ticket, the last tier-outcomes row on or after its first Pull.
  const pullsByTicket = new Map();
  for (const p of pulls) {
    if (!pullsByTicket.has(p.ticket)) pullsByTicket.set(p.ticket, []);
    pullsByTicket.get(p.ticket).push(p);
  }
  const groups = new Map(); // pr -> { pr, tier, pulls[] }
  const unruled = [];
  for (const [ticket, ps] of pullsByTicket) {
    const first = ps[0].run_date;
    const ruling = tiers.filter((t) => t.ticket.split("+").includes(ticket) && t.run_date >= first).at(-1);
    if (!ruling) { unruled.push(...ps); continue; }
    const g = groups.get(ruling.pr) ?? { pr: ruling.pr, tier: ruling, pulls: [] };
    if (ruling.run_date > g.tier.run_date) g.tier = ruling;
    for (const p of ps) (p.run_date <= ruling.run_date ? g.pulls : unruled).push(p);
    groups.set(ruling.pr, g);
  }

  const cells = new Map();
  const cellOf = (c) => {
    if (!cells.has(c)) {
      cells.set(c, { cell: c, n_pulls: 0, n_merged: 0, n_pass: 0, usd: 0, router_usd: 0, merged_usd: [], units: [] });
    }
    return cells.get(c);
  };
  const routerUsd = (p) => (p.router_usd === "" ? 0 : Number(p.router_usd));
  const mismatch = [], pending = [];

  for (const g of groups.values()) {
    if (g.pulls.length === 0) continue;
    const carrier = g.pulls.at(-1);
    const cell = carrier.chosen_cell;
    const m = memberOfPull.get(carrier);
    const level = cell.split("-").slice(1).join("-");
    if (m && (m.subagentType !== `fleet-implementer-${cell}` || m.effort !== level)) {
      mismatch.push({ pr: g.pr, cell, subagent_type: m.subagentType, effort: m.effort });
      continue;
    }
    const state = prState.get(g.pr);
    if (!state || state.state === "OPEN") { pending.push(g.pr); continue; }
    const total = g.pulls.reduce((s, p) => s + (pullUsd.get(p) ?? 0), 0) + (prMemberUsd.get(g.pr) ?? 0);
    const c = cellOf(cell);
    for (const p of g.pulls) { cellOf(p.chosen_cell).n_pulls++; c.router_usd += routerUsd(p); }
    c.usd += total;
    const merged = isMerged(state) ? 1 : 0;
    c.units.push({ usd: total, merged });
    if (merged) {
      c.n_merged++;
      c.merged_usd.push(total);
      if (!failed(g.tier)) c.n_pass++;
    }
  }
  for (const p of unruled) {
    const opened = memberOfPull.get(p)?.pr;
    if (opened && prState.get(opened)?.state === "OPEN") { pending.push(opened); continue; }
    const c = cellOf(p.chosen_cell);
    c.n_pulls++;
    c.router_usd += routerUsd(p);
    const spent = pullUsd.get(p) ?? 0;
    c.usd += spent;
    c.units.push({ usd: spent, merged: 0 });
  }

  const base = cells.get(BASELINE_CELL) ?? null;
  const figures = [...cells.values()].sort((a, b) => a.cell.localeCompare(b.cell)).map((c) => ({
    cell: c.cell,
    n_pulls: c.n_pulls,
    n_merged: c.n_merged,
    n_pass: c.n_pass,
    fail_rate: c.n_merged ? round((c.n_merged - c.n_pass) / c.n_merged) : null,
    mean_usd: c.n_merged ? round(c.usd / c.n_merged, 2) : null,
    median_usd: round(median(c.merged_usd), 2),
    router_usd: round(c.router_usd, 4),
    usd_diff_ci95: c.cell === BASELINE_CELL || !base ? null : bootstrapDiffCI(c.units, base.units),
  }));

  // The guard.
  const byCell = new Map(figures.map((f) => [f.cell, f]));
  const b = byCell.get(BASELINE_CELL) ?? { n_merged: 0, n_pass: 0, mean_usd: null, fail_rate: null };
  const baseline = { cell: BASELINE_CELL, n: b.n_merged, mean_usd: b.mean_usd, fail_rate: b.fail_rate };
  const tripped = [];
  if (baseline.n >= MIN_N) {
    for (const f of figures) {
      if (f.cell === BASELINE_CELL || f.n_merged < MIN_N) continue;
      if (trips({ n: f.n_merged, n_pass: f.n_pass, mean_usd: f.mean_usd }, { n: b.n_merged, n_pass: b.n_pass, mean_usd: b.mean_usd })) tripped.push(f.cell);
    }
  }
  const verdict = baseline.n < MIN_N ? "none" : tripped.length ? "tripped" : "ok";
  // Retire: every non-default stage-1 cell tripped before any stratum adopted one.
  const adopted = Object.values(routerTable?.rows ?? {}).some((c) => c !== BASELINE_CELL);
  const retire = !adopted && STAGE_1.filter((c) => c !== BASELINE_CELL).every((c) => tripped.includes(c));
  // The member rows this report books: every windowed Pull's, and those of
  // PR-named members whose PR a windowed ticket was ruled on.
  const inReport = booked.filter(([, pull, pr]) => pull || groups.has(pr)).map(([r]) => r);

  return {
    window_start: windowStart,
    baseline,
    cells: figures,
    tripped,
    verdict,
    retire,
    mismatch,
    pending: [...new Set(pending)].sort((x, y) => Number(x) - Number(y)),
    unpriced: inReport.filter((r) => r.cost === "").length,
    ab: abReport(groups, pulls, prState, pullUsd, prMemberUsd),
    cross_check: crossCheck(inReport, pricing),
  };
}

// The reasoning test: arm A on an even ticket, B on an odd one. B has run only
// if some odd-ticket Pull carries a `sizing_pre`.
export function abReport(groups, pulls, prState, pullUsd, prMemberUsd) {
  const arm = (ticket) => (Number(ticket) % 2 === 0 ? "A" : "B");
  const bPulls = pulls.filter((p) => arm(p.ticket) === "B");
  if (!bPulls.some((p) => p.sizing_pre !== "")) {
    return { status: "not-run", reason: "B not run — the table has no row a better classifier could change" };
  }
  const arms = { A: { merged: 0, failed: 0, usd: 0 }, B: { merged: 0, failed: 0, usd: 0 } };
  for (const g of groups.values()) {
    if (!g.pulls.length || !isMerged(prState.get(g.pr))) continue;
    const a = arms[arm(g.pulls.at(-1).ticket)];
    a.merged++;
    if (failed(g.tier)) a.failed++;
    a.usd += g.pulls.reduce((s, p) => s + (pullUsd.get(p) ?? 0) + (p.router_usd === "" ? 0 : Number(p.router_usd)), 0)
      + (prMemberUsd.get(g.pr) ?? 0);
  }
  const disagree = bPulls.filter((p) => p.policy_cell !== p.chosen_cell).length;
  const out = {
    A: { n_merged: arms.A.merged, fail_rate: arms.A.merged ? round(arms.A.failed / arms.A.merged) : null, mean_usd: arms.A.merged ? round(arms.A.usd / arms.A.merged, 2) : null },
    B: { n_merged: arms.B.merged, fail_rate: arms.B.merged ? round(arms.B.failed / arms.B.merged) : null, mean_usd: arms.B.merged ? round(arms.B.usd / arms.B.merged, 2) : null },
    disagreement: bPulls.length ? round(disagree / bPulls.length) : null,
  };
  // B can only show an effect through the Pulls where it chose differently.
  if (arms.A.merged < MIN_N || arms.B.merged < MIN_N) return { status: "insufficient", ...out };
  if (disagree < MIN_N) return { status: "underpowered", ...out };
  const bWins = out.B.mean_usd < out.A.mean_usd && arms.B.failed * arms.A.merged <= arms.A.failed * arms.B.merged;
  return { status: bWins ? "B-wins" : "B-off", ...out };
}

// How far each booked row's recorded `cost` sits from its token columns priced
// at pricing.json's rates — a ratio, never a $.
export function crossCheck(rows, pricing) {
  if (!pricing) return null;
  let recorded = 0, expected = 0, n = 0, skipped = 0;
  for (const r of rows) {
    const p = pricing.models?.[r.model];
    const tok = (k) => Number(r[k] || 0);
    const w1h = r.tokensCacheWrite1h === "" ? null : Number(r.tokensCacheWrite1h);
    const parts = [
      [tok("tokensIn"), p?.input], [tok("tokensOut"), p?.output], [tok("tokensCacheRead"), p?.cache_read],
      [w1h, p?.cache_write_1h], [w1h === null ? null : tok("tokensCacheCreate") - w1h, p?.cache_write_5m],
    ];
    if (!p || r.cost === "" || parts.some(([t, price]) => t === null || (t > 0 && typeof price !== "number"))) { skipped++; continue; }
    recorded += Number(r.cost);
    expected += parts.reduce((s, [t, price]) => s + (t > 0 ? t * price : 0), 0) / 1e6;
    n++;
  }
  return { rows: n, skipped, ratio: expected > 0 ? round(recorded / expected) : null };
}

const TSV_COLUMNS = ["cell", "n_pulls", "n_merged", "n_pass", "fail_rate", "mean_usd", "median_usd", "router_usd", "usd_diff_ci95", "guard"];

export function formatReport(report) {
  const guardOf = (f) => {
    if (f.cell === BASELINE_CELL) return "baseline";
    if (report.tripped.includes(f.cell)) return "tripped";
    return f.n_merged >= MIN_N && report.verdict !== "none" ? "ok" : `n<${MIN_N}`;
  };
  const cell = (v) => (v === null || v === undefined ? "" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
  const lines = [TSV_COLUMNS.join("\t")];
  for (const f of report.cells) lines.push(TSV_COLUMNS.map((c) => (c === "guard" ? guardOf(f) : cell(f[c]))).join("\t"));
  const b = report.baseline;
  lines.push(`# verdict: ${report.verdict} (baseline ${b.cell} n=${b.n}/${MIN_N}${report.tripped.length ? `; tripped ${report.tripped.join(" ")}` : ""})${report.retire ? " — retire: every non-default stage-1 cell tripped" : ""}`);
  lines.push(`# window_start ${report.window_start}; pending PRs: ${report.pending.length ? report.pending.join(" ") : "none"}; unpriced member rows: ${report.unpriced}`);
  if (report.mismatch.length) {
    lines.push(`# mismatch (excluded from every cell): ${report.mismatch.map((m) => `PR#${m.pr} ${m.cell} vs ${m.subagent_type || "(none)"}/${m.effort || "(none)"}`).join("; ")}`);
  }
  const ab = report.ab;
  lines.push(ab.status === "not-run"
    ? `# A/B: ${ab.reason}`
    : `# A/B: ${ab.status} — A n=${ab.A.n_merged} $${cell(ab.A.mean_usd)} fail ${cell(ab.A.fail_rate)}; B n=${ab.B.n_merged} $${cell(ab.B.mean_usd)} fail ${cell(ab.B.fail_rate)}; disagreement ${cell(ab.disagreement)}`);
  const x = report.cross_check;
  lines.push(x ? `# cross-check: recorded cost / pricing.json = ${x.ratio ?? "n/a"} over ${x.rows} rows; ${x.skipped} skipped` : "# cross-check: no pricing.json");
  return lines.join("\n") + "\n";
}

export function guardFile(report, computedAt) {
  return {
    computed_at: computedAt,
    window_start: report.window_start,
    baseline: report.baseline,
    cells: report.cells.map((f) => ({ cell: f.cell, n: f.n_merged, mean_usd: f.mean_usd, fail_rate: f.fail_rate })),
    tripped: report.tripped,
    verdict: report.verdict,
    retire: report.retire,
    // The n the baseline and every judged cell need, so a reader prints it
    // rather than restating it.
    min_n: MIN_N,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const die = makeDie(NAME);
  const { arg, has, sweep, stray } = defineFlags(die, {
    flags: {
      guard: "bool", json: "bool", "member-outcomes": "value", "tier-outcomes": "value",
      "ticket-features": "value", pricing: "value", out: "value",
    },
  });
  sweep();
  stray();
  const read = (path) => {
    try { return readFileSync(path, "utf8"); }
    catch (e) { die(`cannot read ${path}: ${e.code ?? e.message}`); }
  };
  const parse = (what, fn) => {
    try { return fn(); }
    catch (e) { die(`${what}: ${e.message}`); }
  };
  const membersPath = arg("member-outcomes") ?? "docs/metrics/member-outcomes.tsv";
  const tiersPath = arg("tier-outcomes") ?? "docs/metrics/tier-outcomes.tsv";
  const featuresPath = arg("ticket-features") ?? "docs/metrics/ticket-features.tsv";
  const pricingPath = arg("pricing") ?? "docs/metrics/pricing.json";
  const members = parse(membersPath, () => parseMemberTsv(read(membersPath)));
  const tiers = parse(tiersPath, () => parseTierOutcomes(read(tiersPath)));
  const features = parse(featuresPath, () => parseFeatures(read(featuresPath)));
  const pricing = existsSync(pricingPath) ? parse(pricingPath, () => JSON.parse(read(pricingPath))) : null;
  const tablePath = join(SCRIPT_DIR, "router-table.json");
  const routerTable = existsSync(tablePath) ? parse(tablePath, () => JSON.parse(read(tablePath))) : null;

  let out;
  try {
    out = execFileSync("gh", ["pr", "list", "--state", "all", "--search", `created:>=${WINDOW_START}`,
      "--limit", String(GH_PR_LIMIT), "--json", "number,state,mergedAt"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: gitEnv(),
    });
  } catch (e) {
    die(`gh pr list failed: ${e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)}`);
  }
  const prs = parse("gh pr list", () => JSON.parse(out));
  if (!Array.isArray(prs) || prs.some((p) => !p || typeof p.number !== "number" || typeof p.state !== "string")) {
    die("gh pr list did not return {number,state} rows");
  }
  // Merged state for a PR past the cap would read as missing — pending —
  // silently, so a full page is refused rather than trusted.
  if (prs.length >= GH_PR_LIMIT) die(`gh pr list returned ${prs.length} PRs, its cap — merged state may be truncated`);

  const report = computeReport({ members, tiers, features, prs, routerTable, pricing });
  process.stdout.write(has("json") ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  if (!has("guard")) return;
  const file = arg("out") ?? join(".fleet", "cost-guard.json");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(guardFile(report, new Date().toISOString()), null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    die(`cannot write ${file}: ${e.code ?? e.message}`);
  }
  process.exitCode = EXIT[report.verdict];
}

if (isCLI(import.meta.url)) main();
