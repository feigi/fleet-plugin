#!/usr/bin/env node
// $ per merged PR, per implementer cell, and the cost guard over it.
//
//   pr-cost.mjs [--guard] [--json] [--member-outcomes <tsv>] [--tier-outcomes <tsv>]
//               [--ticket-features <tsv>] [--pricing <json>] [--out <json>]
//
// Inputs: the three metrics TSVs (docs/metrics/ by default, relative to the
// working directory; ticket-features.tsv is written by the router script at
// dispatch and must exist, else exit 2 — pricing.json and the router-table.json
// beside this script are optional, though a `--pricing` named but absent is
// exit 2 too) and ONE `gh pr list --state all`, scoped to PRs created in the
// window, for merged state, which tier-outcomes.tsv does not record. A PR that
// list does not return is counted pending. Output: a TSV per cell on stdout
// (`--json` prints the whole report instead). `--guard` also writes the
// verdict to `.fleet/cost-guard.json` in the main workspace — where fleet-tick
// reads it, wherever this runs from; `--out` overrides — and exits on it:
//
//   0  ok — no cell tripped
//   3  at least one cell tripped; `tripped[]` names each
//   4  no verdict — the baseline cell has fewer than MIN_N merged PRs
//   2  input error — nothing is written
//
// The exit status is the guard's carrier: the verdict never lives only in
// prose. The router (not in the tree yet) is to read the file, and
// fleet-tick's `router` row prints it today; a missing or unparseable file
// means the default cell only, so deleting it cannot evade the guard.
//
// BOOKING is pull-attribution.mjs's, the one the router's fit reads too: each
// Pull in the window is a unit booked as routed to its `chosen_cell`, with
// every implementer under it, its PR's review, fix and finisher members and
// their nested members, and its merge through its Ruling — merged when that
// PR's state is MERGED. A Pull is counted, or excluded (no Admissible row),
// pending (its PR still open, or not in the list), left out (never merged, no
// `fixed` bail, and every ending the ticket's or neither's) or unpriced (a
// booked row with a blank `cost`, or a Ruling whose PR none of its
// implementers carries); only counted Pulls enter a cell's figures. A `cost`
// that is neither blank nor a number is an input error (exit 2), as is a
// ticket-features `run_date` that is neither blank nor YYYY-MM-DD, or a ruling
// of a windowed Pull's ticket whose run_date is not YYYY-MM-DD or whose verdict
// is not yes or no.
//
// PER CELL, over its counted Pulls: `n_pulls`; `n_merged`; `n_claims` (merged
// PRs plus every `bail:fixed` or `bail:fixed-refuted` ending); `n_failed`
// (merged PRs ruled `minted_false_claim=yes` or `closed_own_ticket=no`, plus
// every `bail:fixed-refuted`); `fail_rate` = failed / claims; `mean_usd` = the
// Pulls' spend — merged or not — / merged, so a cell that abandons work carries
// that spend; `median_usd` over the merged Pulls alone, descriptive;
// `router_usd`, the Pulls' own routing cost, summed and never in their spend.
// `usd_diff_ci95` is a bootstrap 95% interval on `mean_usd` minus the
// baseline's — printed to be read, never judged on. Then the cell's
// `excluded`, `left_out` and `unpriced` Pull counts.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { isCLI } from "./is-cli.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { AttributionError, attribute, parseFeatures, tally } from "./pull-attribution.mjs";
import { RulingError, parseTierOutcomes } from "./tier-outcomes.mjs";

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

const routerUsd = (pull) => (pull.router_usd === "" ? 0 : Number(pull.router_usd));
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
// points rather than 14.999… in floating point. `n` is a cell's claims and
// `n_pass` the claims among them that held.
export function trips(cell, base) {
  const failC = cell.n - cell.n_pass, failB = base.n - base.n_pass;
  const failRise = (failC * base.n - failB * cell.n) * 100 >= TRIP_POINTS * cell.n * base.n;
  return failRise || cell.mean_usd >= base.mean_usd;
}

export function computeReport({ members, tiers, features, prs, routerTable = null, pricing = null, windowStart = WINDOW_START }) {
  const units = attribute({ features, members, tiers, prs, windowStart });
  const counted = units.filter((u) => u.status === "counted");
  const tallies = new Map(tally(units).map((t) => [t.cell, t]));
  const countedIn = (cell) => counted.filter((u) => u.cell === cell);
  const bootUnits = (cell) => countedIn(cell).map((u) => ({ usd: u.spend, merged: u.merged ? 1 : 0 }));
  const meanUsd = (t) => (t.merged ? t.spend / t.merged : null);
  const base = tallies.get(BASELINE_CELL) ?? null;
  const figures = [...tallies.values()].map((t) => ({
    cell: t.cell,
    n_pulls: t.n,
    n_merged: t.merged,
    n_claims: t.claims,
    n_failed: t.failed,
    fail_rate: t.claims ? round(t.failed / t.claims) : null,
    mean_usd: round(meanUsd(t), 2),
    median_usd: round(median(countedIn(t.cell).filter((u) => u.merged).map((u) => u.spend)), 2),
    router_usd: round(countedIn(t.cell).reduce((s, u) => s + routerUsd(u.pull), 0), 4),
    usd_diff_ci95: t.cell === BASELINE_CELL || !base ? null : bootstrapDiffCI(bootUnits(t.cell), bootUnits(BASELINE_CELL)),
    excluded: t.excluded,
    left_out: t.left_out,
    unpriced: t.unpriced,
  }));

  // The guard.
  const b = figures.find((f) => f.cell === BASELINE_CELL) ?? { n_merged: 0, mean_usd: null, fail_rate: null };
  const baseline = { cell: BASELINE_CELL, n: b.n_merged, mean_usd: b.mean_usd, fail_rate: b.fail_rate };
  // The $ leg takes the unrounded means: the cent-rounded figures are for
  // display, and a trip is sticky, so a cell cheaper by under half a cent
  // must not trip on rounding alone. The fail leg reads the claims.
  const quality = (t) => ({ n: t.claims, n_pass: t.claims - t.failed, mean_usd: meanUsd(t) });
  const tripped = [];
  if (baseline.n >= MIN_N) {
    for (const t of tallies.values()) {
      if (t.cell !== BASELINE_CELL && t.merged >= MIN_N && trips(quality(t), quality(base))) tripped.push(t.cell);
    }
  }
  const verdict = baseline.n < MIN_N ? "none" : tripped.length ? "tripped" : "ok";
  // Retire: every non-default stage-1 cell tripped before any stratum adopted one.
  const adopted = Object.values(routerTable?.rows ?? {}).some((c) => c !== BASELINE_CELL);
  const retire = !adopted && STAGE_1.filter((c) => c !== BASELINE_CELL).every((c) => tripped.includes(c));

  return {
    window_start: windowStart,
    baseline,
    cells: figures,
    tripped,
    verdict,
    retire,
    pending: [...new Set(units.filter((u) => u.status === "pending").map((u) => u.pendingPr))].sort((x, y) => Number(x) - Number(y)),
    ab: abReport(units),
    cross_check: crossCheck(units.flatMap((u) => u.rows), pricing),
  };
}

// The reasoning test: arm A on an even ticket, B on an odd one. B has run only
// if some odd-ticket Pull carries a `sizing_pre`. An arm's $ is its counted
// Pulls' spend plus their own `router_usd`, since the arms compare policies,
// not cells.
export function abReport(units) {
  const arm = (ticket) => (Number(ticket) % 2 === 0 ? "A" : "B");
  const bPulls = units.map((u) => u.pull).filter((p) => arm(p.ticket) === "B");
  if (!bPulls.some((p) => p.sizing_pre !== "")) {
    return { status: "not-run", reason: "B not run — the table has no row a better classifier could change" };
  }
  const arms = { A: { merged: 0, claims: 0, failed: 0, usd: 0 }, B: { merged: 0, claims: 0, failed: 0, usd: 0 } };
  for (const u of units) {
    if (u.status !== "counted") continue;
    const a = arms[arm(u.pull.ticket)];
    if (u.merged) a.merged++;
    a.claims += u.claims;
    a.failed += u.falseClaims;
    a.usd += u.spend + routerUsd(u.pull);
  }
  const disagree = bPulls.filter((p) => p.policy_cell !== p.chosen_cell).length;
  const side = (a) => ({
    n_merged: a.merged, fail_rate: a.claims ? round(a.failed / a.claims) : null, mean_usd: a.merged ? round(a.usd / a.merged, 2) : null,
  });
  const out = { A: side(arms.A), B: side(arms.B), disagreement: bPulls.length ? round(disagree / bPulls.length) : null };
  // B can only show an effect through the Pulls where it chose differently.
  if (arms.A.merged < MIN_N || arms.B.merged < MIN_N) return { status: "insufficient", ...out };
  if (disagree < MIN_N) return { status: "underpowered", ...out };
  const bWins = out.B.mean_usd < out.A.mean_usd && arms.B.failed * arms.A.claims <= arms.A.failed * arms.B.claims;
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

const TSV_COLUMNS = [
  "cell", "n_pulls", "n_merged", "n_claims", "n_failed", "fail_rate", "mean_usd", "median_usd", "router_usd", "usd_diff_ci95",
  "excluded", "left_out", "unpriced", "guard",
];

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
  lines.push(`# window_start ${report.window_start}; pending PRs: ${report.pending.length ? report.pending.join(" ") : "none"}`);
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

// `.fleet/cost-guard.json` in the main workspace — fleet-dir.mjs's fleetFile(),
// where fleet-tick reads it — not in the cwd, which from a linked worktree is a
// different directory the tick never looks in. The cwd when git cannot answer,
// announced on stderr rather than degraded to in silence, with git's reason.
function defaultGuardPath() {
  try {
    return fleetFile("cost-guard.json");
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    console.error(`${NAME}: WARNING ${e.message}; writing the guard to cwd-relative .fleet/cost-guard.json`);
    return join(".", ".fleet", "cost-guard.json");
  }
}

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
  const read = (path, ifMissing = "") => {
    try { return readFileSync(path, "utf8"); }
    catch (e) { die(`cannot read ${path}: ${e.code ?? e.message}${e.code === "ENOENT" ? ifMissing : ""}`); }
  };
  const parse = (what, fn) => {
    try { return fn(); }
    catch (e) { die(`${what}: ${e.message}`); }
  };
  const membersPath = arg("member-outcomes") ?? "docs/metrics/member-outcomes.tsv";
  const tiersPath = arg("tier-outcomes") ?? "docs/metrics/tier-outcomes.tsv";
  const featuresPath = arg("ticket-features") ?? "docs/metrics/ticket-features.tsv";
  const pricingArg = arg("pricing");
  const pricingPath = pricingArg ?? "docs/metrics/pricing.json";
  const members = parse(membersPath, () => parseMemberTsv(read(membersPath)));
  const tiers = parse(tiersPath, () => parseTierOutcomes(read(tiersPath)));
  const features = parse(featuresPath, () => parseFeatures(read(featuresPath, " — the router script writes it at dispatch, so there is nothing to price before it has dispatched")));
  // The default pricing.json is optional; one named on the command line is not.
  const pricing = pricingArg === null && !existsSync(pricingPath) ? null : parse(pricingPath, () => JSON.parse(read(pricingPath)));
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

  let report;
  try { report = computeReport({ members, tiers, features, prs, routerTable, pricing }); }
  catch (e) {
    if (e instanceof RulingError) die(`${tiersPath}: ${e.message}`);
    if (e instanceof AttributionError) die(e.message);
    throw e;
  }
  process.stdout.write(has("json") ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  if (!has("guard")) return;
  const file = arg("out") ?? defaultGuardPath();
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
