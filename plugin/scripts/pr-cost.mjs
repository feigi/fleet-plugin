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
// exit 2 too) and `gh pr list --state all` over the PRs created in the window,
// for merged state, which tier-outcomes.tsv does not record. GitHub search
// returns at most GH_PR_LIMIT results whatever `--limit` says, so the window is
// read in `created:` date slices (`readPrs`): the whole window first, and any
// slice that comes back full is halved by day and read again, until every
// slice is short of the cap. A one-day slice that is still full cannot be
// split and is exit 2, as is any failed slice: a PR that merged but past a
// truncated read would be counted pending, silently. A PR the slices do not
// return is counted pending. Output: a TSV per cell on stdout
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
// `fixed` bail, and every ending the ticket's or neither's), unpriced (a
// booked row with a blank `cost`, or a Ruling whose PR none of its
// implementers carries) or untimed (a booked row whose `agent` names no
// parent with a blank `work_s`); only counted Pulls enter a cell's figures. A
// `cost` or `work_s` that is neither blank nor a number is an input error
// (exit 2), as is a ticket-features `run_date` that is neither blank nor
// YYYY-MM-DD, or a ruling of a windowed Pull's ticket whose run_date is not
// YYYY-MM-DD or whose verdict is not yes or no.
//
// PER CELL GENERATION (pull-attribution.mjs's GENERATION), over its counted
// Pulls: `generation`, the dispatch model; `n_pulls`; `n_merged`; `n_claims`
// (merged PRs plus every `bail:fixed` or `bail:fixed-refuted` ending);
// `n_failed` (merged PRs ruled `minted_false_claim=yes` or
// `closed_own_ticket=no`, plus every `bail:fixed-refuted`); `fail_rate` =
// failed / claims; `mean_usd` = the Pulls' spend — merged or not — / merged,
// so a cell that abandons work carries that spend; `median_usd` over the
// merged Pulls alone, descriptive; `router_usd`, the Pulls' own routing cost,
// summed and never in their spend. `usd_diff_ci95` is a bootstrap 95% interval
// on `mean_usd` minus the baseline's — printed to be read, never judged on.
// Then the `left_out`, `unpriced` and `untimed` Pull counts, and the cell's
// `excluded` count, which no generation owns. The baseline, the guard file's
// cells and every trip are each cell's newest generation alone, so a cell
// whose model changed is judged afresh once its new generation reaches MIN_N
// merged PRs. Each older generation prints on its own line beside the newest,
// with no verdict and no interval.
//
// THE GUARD FILE keeps each cell's whole entry as the report computed it —
// `n` (its `n_merged`, which readers key on) beside every figure above and its
// older generations nested under `older`, never as extra `cells[]` entries,
// since a reader keys entries by cell — and, per generation, three counts
// that never enter its figures: `by_hand`, the counted merged Pulls whose
// Ruling's note is not one `tier-outcomes.mjs append` derives (`isDerivedNote`);
// `no_ruling`, the Pulls whose PR merged on GitHub with no Ruling, which stay
// not merged; and `pending`, the Pulls whose PR is still open or not in the
// list. `no_ruling_prs` and `pending_prs` name the PRs behind the last two,
// ascending, as the report's top-level `pending` list does: a `no_ruling`
// Pull contributes the implementer PRs that make it one. Beside `min_n` it
// records `trip_points`, the floor's margin, and
// `tsv_blobs`: the git blob id of each TSV it read, by the path it read it at.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { isCLI } from "./is-cli.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { AttributionError, TRIP_POINTS, attribute, bootUnit, bootstrapDiffCI, parseFeatures, tally, underFloor } from "./pull-attribution.mjs";
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
export const EXIT = { ok: 0, tripped: 3, none: 4 };
export const GH_PR_LIMIT = 1000;

// A slice of the window that cannot be proven fully read.
export class PrListIncomplete extends Error {}

const DAY_MS = 86_400_000;
const dayNumber = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const dayOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Every PR created from `windowStart` on, as `listSlice(created)` returns them,
 * proven complete. GitHub search answers at most `limit` rows however many
 * match, so a slice that returns `limit` is cut off, not whole: it is halved
 * by day and both halves read again. The top slice stays open-ended (`>=A`),
 * so a PR created after `today` by the local clock is still inside it. A
 * single day that is still full cannot be split further and throws
 * `PrListIncomplete`; a `listSlice` that fails is its own to refuse, by
 * throwing or exiting, and is never read as an empty slice. A short slice is
 * the whole of its days. Slices are disjoint by day; a PR is kept once by number.
 */
export function readPrs(listSlice, { windowStart = WINDOW_START, today = new Date().toISOString().slice(0, 10), limit = GH_PR_LIMIT } = {}) {
  const byNumber = new Map();
  const todo = [{ from: windowStart, to: null }];
  while (todo.length) {
    const { from, to } = todo.pop();
    const rows = listSlice(to === null ? `>=${from}` : `${from}..${to}`);
    if (rows.length < limit) {
      for (const row of rows) byNumber.set(row.number, row);
      continue;
    }
    const last = to ?? today;
    if (from >= last) {
      throw new PrListIncomplete(`gh pr list created:${to === null ? `>=${from}` : from} returned ${rows.length} PRs, its cap, and one day cannot be split further — merged state may be truncated`);
    }
    const midN = Math.floor((dayNumber(from) + dayNumber(last)) / 2);
    todo.push({ from: dayOf(midN + 1), to }, { from, to: dayOf(midN) });
  }
  return [...byNumber.values()];
}

const routerUsd = (pull) => (pull.router_usd === "" ? 0 : Number(pull.router_usd));
const round = (x, d = 4) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The trip rule: the quality floor (pull-attribution.mjs's `underFloor`, in
// integer counts), or a mean $ at least the baseline's. Each side is
// `{ claims, failed, mean_usd }`.
export function trips(cell, base) {
  return underFloor(cell, base) || cell.mean_usd >= base.mean_usd;
}

export function computeReport({ members, tiers, features, prs, routerTable = null, pricing = null, windowStart = WINDOW_START }) {
  const units = attribute({ features, members, tiers, prs, windowStart });
  const tallies = new Map(tally(units).map((t) => [t.cell, t]));
  const bootUnits = (g) => g.pulls.map((u) => bootUnit(u));
  const meanUsd = (t) => (t.merged ? t.spend / t.merged : null);
  const base = tallies.get(BASELINE_CELL) ?? null;
  // The PRs behind each generation's `no_ruling` and `pending` counts, as the
  // top-level `pending` list prints them: ascending, each once.
  const behind = new Map();
  for (const u of units) {
    if (u.status === "excluded") continue;
    const k = `${u.cell}\0${u.generation}`;
    const held = behind.get(k) ?? behind.set(k, { no_ruling_prs: new Set(), pending_prs: new Set() }).get(k);
    for (const pr of u.noRulingPrs) held.no_ruling_prs.add(pr);
    if (u.status === "pending") held.pending_prs.add(u.pendingPr);
  }
  const prList = (set = []) => [...set].sort((x, y) => Number(x) - Number(y));
  // One generation's figures. The interval is the newest generation's against
  // the baseline's newest; an older generation is printed, never compared.
  const figuresOf = (cell, g, newest) => {
    const held = behind.get(`${cell}\0${g.generation}`);
    return {
      cell,
      generation: g.generation,
      n_pulls: g.n,
      n_merged: g.merged,
      n_claims: g.claims,
      n_failed: g.failed,
      fail_rate: g.claims ? round(g.failed / g.claims) : null,
      mean_usd: round(meanUsd(g), 2),
      median_usd: round(median(g.pulls.filter((u) => u.merged).map((u) => u.spend)), 2),
      by_hand: g.by_hand,
      no_ruling: g.no_ruling,
      no_ruling_prs: prList(held?.no_ruling_prs),
      pending: g.pending,
      pending_prs: prList(held?.pending_prs),
      router_usd: round(g.pulls.reduce((s, u) => s + routerUsd(u.pull), 0), 4),
      usd_diff_ci95: !newest || cell === BASELINE_CELL || !base ? null : bootstrapDiffCI(bootUnits(g), bootUnits(base)),
      left_out: g.left_out,
      unpriced: g.unpriced,
      untimed: g.untimed,
    };
  };
  const figures = [...tallies.values()].map((t) => ({
    ...figuresOf(t.cell, t, true),
    excluded: t.excluded,
    older: t.older.map((o) => figuresOf(t.cell, o, false)),
  }));

  // The guard, over each cell's newest generation alone.
  const b = figures.find((f) => f.cell === BASELINE_CELL) ?? { generation: null, n_merged: 0, mean_usd: null, fail_rate: null };
  const baseline = { cell: BASELINE_CELL, generation: b.generation, n: b.n_merged, mean_usd: b.mean_usd, fail_rate: b.fail_rate };
  // The $ leg takes the unrounded means: the cent-rounded figures are for
  // display, and a trip is sticky, so a cell cheaper by under half a cent
  // must not trip on rounding alone. The fail leg reads the claims.
  const quality = (t) => ({ claims: t.claims, failed: t.failed, mean_usd: meanUsd(t) });
  const tripped = [];
  if (baseline.n >= MIN_N) {
    for (const t of tallies.values()) {
      if (t.cell !== BASELINE_CELL && t.merged >= MIN_N && trips(quality(t), quality(base))) tripped.push(t.cell);
    }
  }
  const verdict = baseline.n < MIN_N ? "none" : tripped.length ? "tripped" : "ok";
  // Retire: every non-default stage-1 cell tripped before any row of either
  // objective's set adopted one.
  const adopted = Object.values(routerTable?.rows ?? {}).some((set) => Object.values(set).some((c) => c !== BASELINE_CELL));
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
  "cell", "generation", "n_pulls", "n_merged", "n_claims", "n_failed", "fail_rate", "mean_usd", "median_usd", "router_usd", "usd_diff_ci95",
  "excluded", "left_out", "unpriced", "untimed", "guard",
];

// One line per cell's newest generation, carrying the guard's verdict on it,
// then one per older generation of that cell, which carries none.
export function formatReport(report) {
  const guardOf = (f) => {
    if (f.cell === BASELINE_CELL) return "baseline";
    if (report.tripped.includes(f.cell)) return "tripped";
    return f.n_merged >= MIN_N && report.verdict !== "none" ? "ok" : `n<${MIN_N}`;
  };
  const cell = (v) => (v === null || v === undefined ? "" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
  const line = (f, guard) => TSV_COLUMNS.map((c) => (c === "guard" ? guard : cell(f[c]))).join("\t");
  const lines = [TSV_COLUMNS.join("\t")];
  for (const f of report.cells) {
    lines.push(line(f, guardOf(f)));
    for (const o of f.older) lines.push(line(o, "older"));
  }
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

// The git blob id of `bytes` — what `git hash-object` prints for a file of them.
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// `tsvBlobs` is the blob id of each TSV the guard read, keyed by path.
export function guardFile(report, computedAt, tsvBlobs = {}) {
  return {
    computed_at: computedAt,
    window_start: report.window_start,
    baseline: report.baseline,
    cells: report.cells.map((f) => {
      const { cell, generation, ...rest } = f;
      return { cell, generation, n: f.n_merged, ...rest };
    }),
    tripped: report.tripped,
    verdict: report.verdict,
    retire: report.retire,
    // The n the baseline and every judged cell need, and the margin the fail
    // leg applies, so a reader prints them rather than restating them.
    min_n: MIN_N,
    trip_points: TRIP_POINTS,
    tsv_blobs: Object.fromEntries(Object.entries(tsvBlobs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
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
  const tsvBlobs = {};
  // `blobbed` records the file's git blob id, off the bytes as read.
  const read = (path, ifMissing = "", blobbed = false) => {
    try {
      const bytes = readFileSync(path);
      if (blobbed) tsvBlobs[path] = blobId(bytes);
      return bytes.toString("utf8");
    }
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
  const members = parse(membersPath, () => parseMemberTsv(read(membersPath, "", true)));
  const tiers = parse(tiersPath, () => parseTierOutcomes(read(tiersPath, "", true)));
  const features = parse(featuresPath, () => parseFeatures(read(featuresPath, " — the router script writes it at dispatch, so there is nothing to price before it has dispatched", true)));
  // The default pricing.json is optional; one named on the command line is not.
  const pricing = pricingArg === null && !existsSync(pricingPath) ? null : parse(pricingPath, () => JSON.parse(read(pricingPath)));
  const tablePath = join(SCRIPT_DIR, "router-table.json");
  const routerTable = existsSync(tablePath) ? parse(tablePath, () => JSON.parse(read(tablePath))) : null;

  // One slice of the window: `created:` takes `>=A` or `A..B`, whole days, both ends in.
  const listSlice = (created) => {
    let out;
    try {
      out = execFileSync("gh", ["pr", "list", "--state", "all", "--search", `created:${created}`,
        "--limit", String(GH_PR_LIMIT), "--json", "number,state,mergedAt"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: gitEnv(),
      });
    } catch (e) {
      die(`gh pr list failed: ${e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)}`);
    }
    const rows = parse("gh pr list", () => JSON.parse(out));
    if (!Array.isArray(rows) || rows.some((p) => !p || typeof p.number !== "number" || typeof p.state !== "string")) {
      die("gh pr list did not return {number,state} rows");
    }
    return rows;
  };
  let prs;
  try { prs = readPrs(listSlice); }
  catch (e) {
    if (e instanceof PrListIncomplete) die(e.message);
    throw e;
  }

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
    writeFileSync(`${file}.tmp`, JSON.stringify(guardFile(report, new Date().toISOString(), tsvBlobs), null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    die(`cannot write ${file}: ${e.code ?? e.message}`);
  }
  process.exitCode = EXIT[report.verdict];
}

if (isCLI(import.meta.url)) main();
