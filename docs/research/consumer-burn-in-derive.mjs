#!/usr/bin/env node
// Derivation script for issue #4119 (map #4118): how long burn-in takes at a
// consumer's pace, and what it costs against routing every Pull at slow-high.
//
// Zero dependencies beyond the Router's own modules, imported from this checkout
// (plugin/scripts/*.mjs): every figure about a Cell comes from pull-attribution /
// pr-cost / ticket-router, never from a hand re-derivation. Node >= 18.
//
//   node docs/research/consumer-burn-in-derive.mjs [flags]
//
//   --sims N       simulations per scenario at the primary run size (default 4000)
//   --sens-sims N  simulations per scenario per sensitivity row (default 1500)
//   --seed S       PRNG seed (default 4119)
//   --refresh      refetch docs/research/consumer-burn-in-prs.json with `gh pr list`
//                  (otherwise the committed snapshot is read; `gh` is also needed for
//                  § 2, which runs pr-cost, and pr-cost calls `gh pr list` itself)
//   --json FILE    also write the computed numbers as JSON
//
// Sections printed: § 0 inputs and cross-checks, § 1 `route` on a repository with
// no guard and with a guard that trips nothing, § 2 pr-cost on a truncated corpus,
// § 3 per-Cell figures, § 4 the pace simulation, § 5 the cost of burn-in.

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const imp = (p) => import(join(ROOT, "plugin/scripts", p));
const { readPrs, computeReport, guardFile, trips, GH_PR_LIMIT, EXIT, MIN_N: GUARD_MIN_N, WINDOW_START } = await imp("pr-cost.mjs");
const { parseTsv: parseMembers } = await imp("member-outcomes.mjs");
const { parseTierOutcomes } = await imp("tier-outcomes.mjs");
const { parseFeatures, attribute, tally, TRIP_POINTS, underFloor } = await imp("pull-attribution.mjs");
const { fitTable, readGuard, MIN_N } = await imp("ticket-router.mjs");
const { drawCell, POLICY_CELL } = await imp("ledger-grammar.mjs");

// ---------------------------------------------------------------- flags ----
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const SIMS = Number(flag("sims", 4000));
const SENS_SIMS = Number(flag("sens-sims", 1500));
const SEED = Number(flag("seed", 4119));
const REFRESH = argv.includes("--refresh");
const JSON_OUT = flag("json", null);

const out = {};
const h = (t) => console.log(`\n## ${t}\n`);
const rd = (rel) => readFileSync(join(ROOT, rel), "utf8");
const r2 = (x) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(2)));
const r4 = (x) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(4)));

// ------------------------------------------------------------ § 0 inputs ----
h("0. Inputs");
const members = parseMembers(rd("docs/metrics/member-outcomes.tsv"));
const verdicts = parseTierOutcomes(rd("docs/metrics/tier-outcomes.tsv"));
const featuresText = rd("docs/metrics/ticket-features.tsv");
const features = parseFeatures(featuresText);
const pricing = JSON.parse(rd("docs/metrics/pricing.json"));
const prior = JSON.parse(rd("plugin/scripts/router-table.json"));

const PRS_FILE = join(HERE, "consumer-burn-in-prs.json");
const gh = (created) =>
  JSON.parse(execFileSync("gh", ["pr", "list", "--state", "all", "--search", `created:${created}`, "--limit", String(GH_PR_LIMIT), "--json", "number,state,mergedAt"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT }));
if (REFRESH || !existsSync(PRS_FILE)) {
  const fetched = readPrs(gh).sort((a, b) => a.number - b.number);
  writeFileSync(PRS_FILE, `${JSON.stringify({ fetched_at: new Date().toISOString(), window_start: WINDOW_START, prs: fetched })}\n`);
}
const prSnapshot = JSON.parse(readFileSync(PRS_FILE, "utf8"));
const prs = prSnapshot.prs;

const report = computeReport({ members, tiers: verdicts, features, prs, routerTable: prior, pricing });
const guardJson = JSON.parse(JSON.stringify(guardFile(report, prSnapshot.fetched_at)));
const fit = fitTable({ prior, features, members, verdicts, guard: readGuard(guardJson), commit: null });
const units = attribute({ features, members, tiers: verdicts, prs, windowStart: WINDOW_START });
const tallies = tally(units);

const sessions = new Map();
for (const line of featuresText.trim().split("\n").slice(1)) {
  const s = line.split("\t")[1];
  sessions.set(s, (sessions.get(s) ?? 0) + 1);
}
const sizes = [...sessions.values()].sort((a, b) => a - b);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const firstDate = [...sessions.keys()].sort()[0].slice(0, 10);
const lastDate = [...sessions.keys()].sort().at(-1).slice(0, 10);
const pace = {
  pulls: units.length,
  runs: sessions.size,
  run_sizes: sizes,
  median_pulls_per_run: median(sizes),
  mean_pulls_per_run: r2(sizes.reduce((a, b) => a + b, 0) / sizes.length),
  first_run: firstDate,
  last_run: lastDate,
  window_start: WINDOW_START,
};
const days = (Date.parse("2026-11-01") - Date.parse(WINDOW_START)) / 86_400_000;
pace.pulls_per_week_since_window_start = r2((units.length / days) * 7);
pace.runs_per_week_since_window_start = r2((sessions.size / days) * 7);
out.inputs = { units: units.length, prs: prs.length, pr_snapshot: prSnapshot.fetched_at, pace };

console.log(`units (Pulls dated >= ${WINDOW_START}): ${units.length}; PR snapshot ${prs.length} PRs fetched ${prSnapshot.fetched_at}`);
console.log(`runs (distinct sessions in ticket-features.tsv): ${sessions.size}; Pulls per run sorted: ${sizes.join(",")}`);
console.log(`median Pulls/run ${pace.median_pulls_per_run}, mean ${pace.mean_pulls_per_run}; first run ${firstDate}, last ${lastDate}`);
console.log(`this repo's pace since ${WINDOW_START} (${days} days to 2026-11-01): ${pace.pulls_per_week_since_window_start} Pulls/week, ${pace.runs_per_week_since_window_start} runs/week`);
console.log(`guard verdict ${report.verdict}; tripped ${JSON.stringify(report.tripped)}; baseline ${JSON.stringify(report.baseline)}`);
console.log(`fit: stage ${fit.stage}, cells ${JSON.stringify(fit.cells)}, burn_in ${fit.burn_in}, n_rows ${fit.n_rows}, rows ${JSON.stringify(fit.rows)}`);
console.log(`installed table: stage ${prior.stage}, cells ${JSON.stringify(prior.cells)}, burn_in ${prior.burn_in}, fitted_commit ${prior.fitted_commit}`);

// ------------------------------------------------- § 1 route, real CLI ----
h("1. `ticket-router.mjs route` on synthetic inputs");
const tmp = mkdtempSync(join(tmpdir(), "consumer-burn-in-"));
const issuePath = join(tmp, "issue.json");
writeFileSync(issuePath, JSON.stringify({
  title: "Add retry to the fetch helper",
  body: "The fetch helper should retry on 503.\n\n- [ ] retries three times\n- [ ] backs off\n",
  labels: [], comments: [], createdAt: "2026-10-30T00:00:00Z",
}));
const SESSION = "2026-11-01T10-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000001";
const pendingPath = join(tmp, "pending.tsv");
const route = (guardPath, ticket) => {
  const r = spawnSync("node", [join(ROOT, "plugin/scripts/ticket-router.mjs"), "route", "--objective", "cost", "--session", SESSION,
    "--ticket", String(ticket), "--arm", "A", "--impl-row", String(ticket - 100), "--issue", issuePath, "--guard", guardPath, "--pending", pendingPath],
  { encoding: "utf8", cwd: ROOT });
  return { exit: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
};
const noGuard = join(tmp, "absent-guard.json");
const nothingGuard = join(tmp, "guard-trips-nothing.json");
writeFileSync(nothingGuard, JSON.stringify({ tripped: [], cells: [] }));
const STAGE1_NAMES = ["slow-high", "task-high", "smol-high"];
out.route = { no_guard: [], trips_nothing: [] };
for (const [label, path, key] of [["(a) no guard file", noGuard, "no_guard"], ["(b) minimal guard {tripped:[],cells:[]}", nothingGuard, "trips_nothing"]]) {
  console.log(label);
  for (const t of [101, 102, 103, 104, 105, 106]) {
    const r = route(path, t);
    out.route[key].push({ ticket: t, ...r });
    console.log(`  ticket ${t}: exit ${r.exit}  ${r.stdout}${r.stderr ? `  [stderr ${r.stderr}]` : ""}`);
  }
}
// (c) a guard whose every stage-1 Cell has 500 merged PRs: `route` reads the installed table's `burn_in`, never the guard's `n`.
const plentyGuard = join(tmp, "guard-n500.json");
writeFileSync(plentyGuard, JSON.stringify({ tripped: [], cells: STAGE1_NAMES.map((cell) => ({ cell, n: 500 })) }));
console.log("(c) guard with n=500 merged on every stage-1 Cell, nothing tripped");
out.route.n500 = [];
for (const t of [101, 102, 103]) {
  const r = route(plentyGuard, t);
  out.route.n500.push({ ticket: t, ...r });
  console.log(`  ticket ${t}: exit ${r.exit}  ${r.stdout}`);
}

// ----------------------------------- § 2 pr-cost on a truncated corpus ----
h("2. pr-cost --guard on a truncated corpus (verdict none)");
const lines = featuresText.trim().split("\n");
const header = lines[0];
const sessionList = [...new Set(lines.slice(1).map((l) => l.split("\t")[1]))];
out.prcost = [];
for (const k of [1, 2]) {
  const keep = new Set(sessionList.slice(0, k));
  const body = lines.slice(1).filter((l) => keep.has(l.split("\t")[1]));
  const fpath = join(tmp, `features-first-${k}-runs.tsv`);
  writeFileSync(fpath, `${header}\n${body.join("\n")}\n`);
  const gpath = join(tmp, `guard-first-${k}-runs.json`);
  const r = spawnSync("node", [join(ROOT, "plugin/scripts/pr-cost.mjs"), "--guard", "--json", "--ticket-features", fpath, "--out", gpath],
    { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const written = existsSync(gpath);
  const g = written ? JSON.parse(readFileSync(gpath, "utf8")) : null;
  const rec = {
    first_runs: k, feature_rows: body.length, exit: r.status, exit_means: Object.entries(EXIT).find(([, v]) => v === r.status)?.[0] ?? "?",
    guard_written: written, verdict: g?.verdict ?? null, tripped: g?.tripped ?? null, baseline: g?.baseline ?? null,
    cells: g?.cells.map((c) => ({ cell: c.cell, n_pulls: c.n_pulls, n: c.n })) ?? null,
  };
  out.prcost.push(rec);
  console.log(`first ${k} run(s): ${body.length} features rows -> exit ${r.status} (${rec.exit_means}); guard written: ${written}; verdict ${rec.verdict}; tripped ${JSON.stringify(rec.tripped)}`);
  console.log(`  baseline ${JSON.stringify(rec.baseline)}; cells ${JSON.stringify(rec.cells)}`);
  const rr = [];
  for (const t of [101, 102, 103]) {
    const x = route(gpath, t);
    rr.push({ ticket: t, ...x });
    console.log(`  route against it, ticket ${t}: exit ${x.exit}  ${x.stdout}`);
  }
  rec.route = rr;
}

// ------------------------------------------------ § 3 per-Cell figures ----
h("3. Per-Cell figures (newest generation), as the guard and the Fit compute them");
const base = tallies.find((t) => t.cell === "slow-high");
const baseQ = { claims: base.claims, failed: base.failed, mean_usd: base.spend / base.merged };
const cellFig = {};
for (const t of tallies) {
  const g = guardJson.cells.find((c) => c.cell === t.cell);
  const est = fit.estimates["*"][t.cell];
  // All Pulls routed to the Cell on its newest generation, whatever their status,
  // plus the Pulls no generation owns (`excluded`).
  const booked = t.n + t.left_out + t.unpriced + t.untimed + t.pending + t.excluded;
  const olderPulls = t.older.reduce((s, o) => s + o.n + o.left_out + o.unpriced + o.untimed + o.pending, 0);
  const q = { claims: t.claims, failed: t.failed, mean_usd: t.spend / t.merged };
  cellFig[t.cell] = {
    generation: t.generation, n_counted: t.n, merged: t.merged, claims: t.claims, failed: t.failed,
    booked_newest_incl_excluded: booked, older_generation_pulls: olderPulls,
    merge_fraction: r4(t.merged / booked),
    usd_per_merged: r4(q.mean_usd), usd_per_counted_pull: r4(t.spend / t.n),
    fail_rate: r4(t.failed / t.claims), failed_per_counted_pull: r4(t.failed / t.n),
    minutes_per_merged: r2(t.workS / 60 / t.merged),
    guard_n: g.n, guard_mean_usd: g.mean_usd, guard_fail_rate: g.fail_rate, fit_usd_per_merged: est.usd_per_merged, fit_fail_rate: est.fail_rate,
    under_floor: t.cell === "slow-high" ? null : underFloor(q, baseQ),
    cost_leg: t.cell === "slow-high" ? null : q.mean_usd >= baseQ.mean_usd,
    trips: t.cell === "slow-high" ? null : trips(q, baseQ),
    outcomes: t.pulls.map((u) => ({ usd: u.spend, failed: u.falseClaims })),
  };
}
for (const [c, f] of Object.entries(cellFig)) {
  const { outcomes, ...show } = f;
  console.log(`${c}: ${JSON.stringify(show)}`);
}
console.log(`guard tripped: ${JSON.stringify(report.tripped)}; quality floor = slow-high fail rate + ${TRIP_POINTS} points = ${r4(cellFig["slow-high"].fail_rate + TRIP_POINTS / 100)}`);
console.log("slow-medium, task-max: no Pull of either in this repo's corpus — no figure (units by chosen_cell: " +
  JSON.stringify(Object.fromEntries([...new Set(units.map((u) => u.cell))].map((c) => [c, units.filter((u) => u.cell === c).length]))) + ")");

out.cells = Object.fromEntries(Object.entries(cellFig).map(([c, f]) => [c, { ...f, outcomes: undefined }]));

// --------------------------------------------------- § 4 pace simulation ----
h("4. Pace: Pulls until the guard can trip, stage 1 ends, stage 2 ends");

// A seeded PRNG: the synthetic session ids and ticket numbers, the merge coin and
// the outcome bootstrap all draw from it, so a re-run reproduces the table.
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
const hex = (rng, n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
const synthSession = (rng, run) => `2026-11-${String(1 + (run % 28)).padStart(2, "0")}T10-00-00-000Z_${hex(rng, 8)}-${hex(rng, 4)}-7${hex(rng, 3)}-${hex(rng, 4)}-${hex(rng, 12)}`;

const STAGE1 = ["slow-high", "task-high", "smol-high"];
const STAGE2_ADDS = [{ cell: "slow-medium", survives: "slow-high" }, { cell: "task-max", survives: "task-high" }];
const CAP = 4000; // Pulls: a run that has not finished by here is censored

/**
 * One consumer, run by run. Run 1 has no guard: every Pull is slow-high. From run
 * 2 the guard exists (verdict `none` is still written, § 2) and every Pull draws
 * with the real `drawCell` over the table's Cells less the tripped. The guard is
 * refreshed at each run's start (phase 0) from the merged PRs of the runs before.
 * `fixedTripped`: Cells the scenario holds tripped throughout (never drawn).
 * `dynamic`: trips come from the real `trips()` over outcomes bootstrapped from
 * this repo's counted Pulls of the Cell, and stage 2 opens when stage 1 is full.
 * `frac`: a Cell's merge fraction (probability a Pull is a counted merged PR).
 * Returns the milestones, as Pull counts, and per-Cell Pull counts at each.
 */
function consumer({ rng, R, cells0, fixedTripped = [], dynamic = false, frac, unmeasuredOutcome }) {
  let cells = [...cells0]; // the table's Cells
  const merged = {}, pulls = {}, failed = {}, spend = {};
  const bump = (c) => { merged[c] ??= 0; pulls[c] ??= 0; failed[c] ??= 0; spend[c] ??= 0; };
  cells.forEach(bump);
  const tripped = new Set(fixedTripped);
  const ms = {}; // milestone -> { pulls, byCell }
  const snap = () => ({ pulls: total, byCell: { ...pulls } });
  let total = 0;
  let stage2Open = !dynamic;
  let tripEval = null; // Pull count at which smol-high first became evaluable (boundary)
  const evaluable = () => { // a non-baseline Cell and slow-high both at MIN_N merged
    if (merged["slow-high"] < MIN_N) return [];
    return cells.filter((c) => c !== "slow-high" && !tripped.has(c) && merged[c] >= MIN_N);
  };
  const full = (set) => set.every((c) => merged[c] >= MIN_N);
  const stage1Set = () => STAGE1.filter((c) => cells.includes(c));
  const checkExact = () => {
    if (!ms.trip_exact && evaluable().length) ms.trip_exact = snap();
    if (!ms.smol_exact && merged["slow-high"] >= MIN_N && merged["smol-high"] >= MIN_N) ms.smol_exact = snap();
    if (!ms.end1_exact && full(stage1Set().filter((c) => !fixedTripped.includes(c)))) ms.end1_exact = snap();
    if (stage2Open && !ms.end2_exact && full(cells.filter((c) => !fixedTripped.includes(c)))) ms.end2_exact = snap();
  };
  const refresh = () => { // phase 0: the guard re-reads the TSVs
    // The guard can trip a Cell from this refresh on, so the milestone is read before the trip itself empties `evaluable()`.
    if (!ms.trip_boundary && evaluable().length) ms.trip_boundary = snap();
    if (dynamic) {
      const baseTally = { claims: merged["slow-high"], failed: failed["slow-high"], mean_usd: spend["slow-high"] / merged["slow-high"] };
      if (merged["slow-high"] >= MIN_N) {
        for (const c of cells) {
          if (c === "slow-high" || tripped.has(c) || merged[c] < MIN_N || !cellFig[c]) continue; // unmeasured Cells never trip
          if (trips({ claims: merged[c], failed: failed[c], mean_usd: spend[c] / merged[c] }, baseTally)) {
            tripped.add(c);
            ms[`tripped_${c}`] = snap();
          }
        }
      }
      if (!stage2Open && full(stage1Set())) {
        stage2Open = true;
        ms.stage2_opens = { ...snap(), tripped_at_open: [...tripped] };
        for (const { cell, survives } of STAGE2_ADDS) {
          if (!cells.includes(cell) && !tripped.has(survives)) { cells.push(cell); bump(cell); }
        }
      }
    }

    if (!ms.smol_boundary && merged["slow-high"] >= MIN_N && merged["smol-high"] >= MIN_N) ms.smol_boundary = snap();
    if (!ms.end1_boundary && full(stage1Set().filter((c) => !fixedTripped.includes(c)))) ms.end1_boundary = snap();
    if (stage2Open && !ms.end2_boundary && full(cells.filter((c) => !fixedTripped.includes(c)))) ms.end2_boundary = snap();
  };
  const doPull = (cell, ticket, run) => {
    void ticket; void run;
    total++;
    bump(cell);
    pulls[cell]++;
    if (rng() < (frac[cell] ?? 1)) {
      merged[cell]++;
      if (dynamic) {
        const pool = cellFig[cell]?.outcomes ?? unmeasuredOutcome(cell);
        const o = pool[Math.floor(rng() * pool.length)];
        spend[cell] += o.usd;
        failed[cell] += o.failed;
      }
    }
    checkExact();
  };
  const done = () => ms.end2_boundary !== undefined || total >= CAP;
  let nextTicket = 1000 + Math.floor(rng() * 1000);
  for (let run = 1; !done(); run++) {
    const session = synthSession(rng, run);
    if (run > 1) refresh();
    if (done()) break;
    for (let i = 0; i < R; i++) {
      nextTicket += 1 + Math.floor(rng() * 7);
      if (run === 1) { doPull(POLICY_CELL, nextTicket, run); continue; }
      const drawable = cells.filter((c) => !tripped.has(c));
      const d = drawCell({ session, ticket: nextTicket, policyCell: null, cells: drawable });
      doPull(d.cell ?? POLICY_CELL, nextTicket, run);
    }
  }
  return { ms, total, tripped: [...tripped] };
}

const pct = (xs, p) => {
  const s = xs.filter((x) => x !== undefined && x !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const summarize = (xs) => {
  const ok = xs.filter((x) => x !== undefined);
  return { n: ok.length, censored: xs.length - ok.length, p10: r2(pct(ok, 0.1)), median: r2(pct(ok, 0.5)), p90: r2(pct(ok, 0.9)), mean: r2(ok.reduce((a, b) => a + b, 0) / (ok.length || 1)) };
};

const FRAC = Object.fromEntries(Object.entries(cellFig).map(([c, f]) => [c, f.merge_fraction]));
const fracWith = (unmeasured) => ({ ...FRAC, "slow-medium": unmeasured, "task-max": unmeasured });
const SCENARIOS = {
  "(i) stage 1: slow-high, task-high, smol-high": { cells0: STAGE1, fixedTripped: [] },
  "(ii) stage 2 as #4115 leaves it: + slow-medium, task-max; smol-high tripped": { cells0: [...STAGE1, "slow-medium", "task-max"], fixedTripped: ["smol-high"] },
  "(iii) all five untripped": { cells0: [...STAGE1, "slow-medium", "task-max"], fixedTripped: [] },
};
// Unmeasured Cells' outcome pools: only used by the dynamic scenario, where they
// stand in for their same-role stage-1 Cell ([INFERENCE]; no corpus Pull exists).
const unmeasuredOutcome = (cell) => cellFig[cell === "slow-medium" ? "slow-high" : "task-high"].outcomes;

function runScenario(spec, R, sims, seed, frac, dynamic = false) {
  const rng = mulberry32(seed);
  const res = [];
  for (let s = 0; s < sims; s++) res.push(consumer({ rng, R, ...spec, frac, dynamic, unmeasuredOutcome }));
  return res;
}
const first = (res, key) => res.map((r) => r.ms[key]?.pulls);

// Which milestones a scenario reports: (i) has no stage 2; (ii) and (iii) start with
// every Cell in the table, so their one burn-in is `end2`; (iv) walks both stages.
const KEYS = {
  i: { "guard can first trip a Cell": "trip", "stage-1 burn-in ends (all 3 Cells at 20 merged)": "end1" },
  all: { "guard can first trip a Cell": "trip", "burn-in ends (every drawn Cell at 20 merged)": "end2" },
  iv: { "guard can first trip a Cell": "trip", "stage-1 burn-in ends": "end1", "stage-2 burn-in ends (cumulative from run 1)": "end2" },
};
function table(res, keys) {
  const rows = {};
  for (const [label, k] of Object.entries(keys)) {
    rows[label] = { exact: summarize(first(res, `${k}_exact`)), boundary: summarize(first(res, `${k}_boundary`)) };
  }
  return rows;
}
const PACES = [10, 30, 100];
const weeks = (s, p) => (s.median === null ? null : { median: r2(s.median / p), p10: r2(s.p10 / p), p90: r2(s.p90 / p) });
const fmt = (s) => (s.median === null ? "n/a" : `${s.median} [${s.p10}, ${s.p90}]${s.censored ? ` (${s.censored} censored)` : ""}`);
function show(t) {
  for (const [label, v] of Object.entries(t)) {
    console.log(`  ${label}: exact ${fmt(v.exact)}; boundary ${fmt(v.boundary)}`);
    console.log(`      boundary in weeks: ${PACES.map((p) => { const w = weeks(v.boundary, p); return `${p}/wk ${w ? `${w.median} [${w.p10}, ${w.p90}]` : "n/a"}`; }).join("; ")}`);
  }
}

const R0 = Math.round(pace.median_pulls_per_run); // primary run size: this repo's median Pulls per run
out.sim = { run_size_primary: R0, sims: SIMS, seed: SEED, scenarios: {} };
console.log(`Primary run size R = ${R0} Pulls/run (this repo's median, ${pace.median_pulls_per_run}); runs/week = pace / R; run 1 all slow-high; ${SIMS} simulations per scenario, seed ${SEED}.`);
console.log("Each entry: Pulls dispatched, median [p10, p90]. `exact` = the Pull on which the condition becomes true; `boundary` = Pulls dispatched before the first run whose phase-0 guard can see it.");

const SPEC_I = SCENARIOS["(i) stage 1: slow-high, task-high, smol-high"];
const SPEC_II = SCENARIOS["(ii) stage 2 as #4115 leaves it: + slow-medium, task-max; smol-high tripped"];
const SPEC_III = SCENARIOS["(iii) all five untripped"];
const runs = {};
for (const [name, spec, keys] of [
  ["(i) stage 1: slow-high, task-high, smol-high", SPEC_I, KEYS.i],
  ["(ii) stage 2 as #4115 leaves it: + slow-medium, task-max; smol-high tripped", SPEC_II, KEYS.all],
  ["(iii) all five untripped", SPEC_III, KEYS.all],
]) {
  const res = runScenario(spec, R0, SIMS, SEED, FRAC);
  runs[name] = res;
  const t = table(res, keys);
  out.sim.scenarios[name] = { table: t };
  console.log(`\n${name}`);
  show(t);
}

// (iv) the path a consumer actually takes: stage 1 until it is full, then stage 2.
console.log("\n(iv) sequential: stage 1 draws until every stage-1 Cell has 20 merged; stage 2 then opens (slow-medium if slow-high untripped, task-max if task-high untripped); trips by the real trips() over outcomes bootstrapped from this repo's counted Pulls; slow-medium/task-max: merge fraction 1.0 and outcomes of their same-role stage-1 Cell [INFERENCE]");
const dyn = runScenario({ cells0: STAGE1, fixedTripped: [] }, R0, SIMS, SEED + 1, fracWith(1), true);
const dynT = table(dyn, KEYS.iv);
show(dynT);
const smolTripped = dyn.filter((r) => r.ms["tripped_smol-high"]).length;
const anyTrippedAtOpen = dyn.filter((r) => r.ms.stage2_opens?.tripped_at_open.length).length;
const opens = summarize(dyn.map((r) => r.ms.stage2_opens?.pulls));
out.sim.scenarios["(iv) sequential"] = { table: dynT, p_smol_high_tripped: r4(smolTripped / dyn.length), p_some_cell_tripped_when_stage2_opens: r4(anyTrippedAtOpen / dyn.length), stage2_opens: opens };
console.log(`  smol-high tripped by the real guard rule in ${r4(smolTripped / dyn.length)} of simulations; some Cell tripped at the moment stage 2 opens in ${r4(anyTrippedAtOpen / dyn.length)}`);
console.log(`  stage 2 opens at Pull ${fmt(opens)} (boundary)`);
runs["(iv) sequential"] = dyn;

// --- sensitivity: the run size, and every Cell's merge fraction at 1.0.
console.log("\nSensitivity (boundary medians [p10, p90], Pulls)");
out.sim.sensitivity = [];
const ALL_ONE = Object.fromEntries(Object.keys(FRAC).map((c) => [c, 1]));
for (const [label, R, frac] of [["R=5", 5, FRAC], ["R=10", 10, FRAC], ["R=17 (primary)", 17, FRAC], ["R=40", 40, FRAC], ["R=17, all merge fractions 1.0", 17, ALL_ONE]]) {
  for (const [name, spec, keys] of [["(i)", SPEC_I, KEYS.i], ["(ii)", SPEC_II, KEYS.all], ["(iii)", SPEC_III, KEYS.all]]) {
    const t = table(runScenario(spec, R, SENS_SIMS, SEED + 2, { ...fracWith(1), ...frac }), keys);
    console.log(`  ${label} ${name}: ${Object.entries(t).map(([k, v]) => `${k.split(" ").slice(0, 3).join(" ")}: ${fmt(v.boundary)}`).join(" | ")}`);
    out.sim.sensitivity.push({ label, scenario: name, table: t });
  }
}

// ------------------------------------------------------ § 5 cost of burn-in ----
h("5. What burn-in costs against routing every Pull at slow-high");
const usd = (c) => cellFig[c].usd_per_counted_pull;
const fpp = (c) => cellFig[c].failed_per_counted_pull;
console.log("Per-Pull figures used: $ per counted Pull and floor failures per counted Pull (newest generation; every counted Pull here is merged, so these equal $ per merged PR and failed / merged).");
for (const c of Object.keys(cellFig)) console.log(`  ${c}: $${usd(c)} per Pull, ${fpp(c)} failures per Pull, ${cellFig[c].fail_rate} fail rate, $${cellFig[c].usd_per_merged} per merged PR`);
// slow-medium and task-max have no Pull in the corpus, hence no figure. [INFERENCE] stand-in:
// the same-role stage-1 Cell's per-Pull figures, to show the size of the term, never measured.
const STAND_IN = { "slow-medium": "slow-high", "task-max": "task-high" };
const costOf = (byCellMean, total) => {
  let dUsd = 0, dFail = 0, unmeasuredPulls = 0, sUsd = 0, sFail = 0;
  const parts = {};
  for (const [c, n] of Object.entries(byCellMean)) {
    if (cellFig[c]) {
      const du = n * (usd(c) - usd("slow-high")), df = n * (fpp(c) - fpp("slow-high"));
      dUsd += du; dFail += df;
      parts[c] = { pulls: r2(n), d_usd: r2(du), d_failures: r2(df) };
    } else {
      unmeasuredPulls += n;
      const s = STAND_IN[c];
      sUsd += n * (usd(s) - usd("slow-high")); sFail += n * (fpp(s) - fpp("slow-high"));
      parts[c] = { pulls: r2(n), d_usd: null, d_failures: null };
    }
  }
  return {
    total_pulls: r2(total), all_slow_high_usd: r2(total * usd("slow-high")), all_slow_high_failures: r2(total * fpp("slow-high")),
    extra_usd_measured_cells: r2(dUsd), extra_failures_measured_cells: r2(dFail), pulls_on_unmeasured_cells: r2(unmeasuredPulls),
    extra_usd_with_stand_in: r2(dUsd + sUsd), extra_failures_with_stand_in: r2(dFail + sFail), by_cell: parts,
  };
};
const meanBy = (res, key) => {
  const ok = res.filter((r) => r.ms[key]);
  const cells = new Set(ok.flatMap((r) => Object.keys(r.ms[key].byCell)));
  const m = {};
  for (const c of cells) m[c] = ok.reduce((s, r) => s + (r.ms[key].byCell[c] ?? 0), 0) / ok.length;
  return { byCell: m, total: ok.reduce((s, r) => s + r.ms[key].pulls, 0) / ok.length, n: ok.length };
};
out.cost = {};
for (const [label, res, key] of [
  ["stage-1 burn-in, scenario (i)", runs["(i) stage 1: slow-high, task-high, smol-high"], "end1_boundary"],
  ["stage-2 burn-in, scenario (ii)", runs["(ii) stage 2 as #4115 leaves it: + slow-medium, task-max; smol-high tripped"], "end2_boundary"],
  ["stage-2 burn-in, scenario (iii)", runs["(iii) all five untripped"], "end2_boundary"],
  ["stage-1 burn-in, scenario (iv)", dyn, "end1_boundary"],
  ["stage-2 burn-in, scenario (iv), cumulative from run 1", dyn, "end2_boundary"],
]) {
  const m = meanBy(res, key);
  const c = costOf(m.byCell, m.total);
  out.cost[label] = c;
  console.log(`\n${label}: mean ${c.total_pulls} Pulls through the boundary (n=${m.n} sims)`);
  console.log(`  all slow-high would cost $${c.all_slow_high_usd} and ${c.all_slow_high_failures} floor failures`);
  console.log(`  extra over that, measured Cells: $${c.extra_usd_measured_cells}, ${c.extra_failures_measured_cells} floor failures; Pulls on Cells with no corpus figure: ${c.pulls_on_unmeasured_cells}`);
  if (c.pulls_on_unmeasured_cells) console.log(`  [INFERENCE] with slow-medium as slow-high and task-max as task-high: extra $${c.extra_usd_with_stand_in}, ${c.extra_failures_with_stand_in} floor failures`);
  console.log(`  by Cell: ${JSON.stringify(c.by_cell)}`);
}

// Pulls that land on smol-high before the guard could trip it.
console.log("\nPulls on smol-high before a consumer's guard could first trip it (both smol-high and slow-high at 20 merged):");
out.smol = {};
for (const [label, res] of [["(i)", runs["(i) stage 1: slow-high, task-high, smol-high"]], ["(iii)", runs["(iii) all five untripped"]], ["(iv) sequential", dyn]]) {
  const exact = summarize(res.map((r) => r.ms.smol_exact?.byCell["smol-high"]));
  const boundary = summarize(res.map((r) => r.ms.smol_boundary?.byCell["smol-high"]));
  out.smol[label] = { exact, boundary };
  console.log(`  ${label}: at the Pull itself ${fmt(exact)} (mean ${exact.mean}); at the guard refresh that can trip it ${fmt(boundary)} (mean ${boundary.mean})`);
}
const smolTotal = summarize(dyn.map((r) => r.ms.end2_boundary?.byCell["smol-high"]));
console.log(`  (iv) smol-high Pulls through stage 2's end, a tripped smol-high no longer drawn: ${fmt(smolTotal)} (mean ${smolTotal.mean})`);
out.smol["(iv) total through end2"] = smolTotal;

if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(out, null, 2)}\n`);
