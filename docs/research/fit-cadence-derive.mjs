#!/usr/bin/env node
// Derivation script for issue #4121 (map #4118): what a Fit at every run
// boundary does to routing, against one Fit every 50 merged PRs.
//
//   node docs/research/fit-cadence-derive.mjs [--root DIR] [--n N] [--workers W]
//                                             [--seed S] [--json FILE] [--skip-null]
//
//   --root DIR     a checkout of the repository at the commit named in the note
//                  (default: the checkout this script sits in). The three TSVs
//                  (docs/metrics/{ticket-features,member-outcomes,tier-outcomes}.tsv)
//                  and the Router's own modules under plugin/scripts/ are read
//                  from it; nothing is re-derived by hand.
//   --n N          null-simulation histories (default 30).
//   --workers W    worker threads for the simulation (default 4).
//   --seed S       base seed of the permutations (default 4121); history h uses S + h.
//   --json FILE    also write every figure as JSON.
//   --skip-null    replay only.
//
// Zero dependencies. Node >= 20.
//
// Part 1 — replay. The corpus is cut at each run boundary (a run is a `session`
// of ticket-features.tsv; sessions sort in time order, their ids open with their
// start time). The prefix at boundary b holds:
//   features  rows whose session <= b                       (exact)
//   members   rows whose session <= b                       (exact: a row is written by its own session)
//   verdicts  tier-outcomes rows whose run_date <= the last run_date of any features
//             row of a session <= b                           (APPROXIMATION: a ruling's date
//             is a day, a run a timestamp, so a ruling written by a later run of the same
//             day leaks into the earlier run's boundary; --strict-day below bounds it)
// The prefix guard is pr-cost.mjs's own computeReport + guardFile, run with prs=null:
// no `gh pr list` is read (PR state is not a function of the prefix), so a Pull is
// merged when the prefix holds its Ruling — the same reading fitTable takes. The
// full-corpus guard is checked against the known figures (slow-high n=104, $14.51).
// Each Fit is ticket-router.mjs's own fitTable, its `prior` the previous Fit's table
// on that cadence (stage and cells carry over, exactly as `fit` rewrites the table).
//
// Part 2 — null. The final corpus's Pulls (all but the `excluded` ones) have their
// `chosen_cell` permuted within each stratum, order kept; the Pull's implementer
// member rows are relabelled to the new Cell (subagent_type, effort, and the
// dispatch model that Cell used at that time), so the bundle of outcomes (spend,
// work time, Ruling) stays with the Pull and only its Cell label moves. No Cell is
// then truly different. Both cadences are replayed over the permuted corpus.

import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const OBJECTIVES = ["cost", "speed"];
const STRATA_SLOTS = ["*", "light", "heavy"];
const SLOTS = OBJECTIVES.flatMap((o) => STRATA_SLOTS.map((s) => `${o}/${s}`));
const EVERY = 50;

// ------------------------------------------------------------------ args ---
function parseArgs(argv) {
  const a = { root: resolve(HERE, "../.."), n: 30, workers: 4, seed: 4121, json: null, skipNull: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--skip-null") a.skipNull = true;
    else if (["--root", "--n", "--workers", "--seed", "--json"].includes(f)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${f} needs a value`);
      if (f === "--root") a.root = resolve(v);
      else if (f === "--json") a.json = v;
      else a[f.slice(2)] = Number(v);
    } else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

// ---------------------------------------------------------------- modules --
async function load(root) {
  const imp = (p) => import(pathToFileURL(join(root, "plugin/scripts", p)).href);
  const [pa, mo, to, tr, pc, lg] = await Promise.all([
    imp("pull-attribution.mjs"), imp("member-outcomes.mjs"), imp("tier-outcomes.mjs"),
    imp("ticket-router.mjs"), imp("pr-cost.mjs"), imp("ledger-grammar.mjs"),
  ]);
  const read = (p) => readFileSync(join(root, p), "utf8");
  const raw = {
    features: read("docs/metrics/ticket-features.tsv"),
    members: read("docs/metrics/member-outcomes.tsv"),
    tiers: read("docs/metrics/tier-outcomes.tsv"),
  };
  return {
    pa, mo, to, tr, pc, lg, raw,
    features: pa.parseFeatures(raw.features),
    members: mo.parseTsv(raw.members),
    tiers: to.parseTierOutcomes(raw.tiers),
    prior: JSON.parse(read("plugin/scripts/router-table.json")),
  };
}

// ------------------------------------------------------------ prefix corpus -
// Boundaries: the window's sessions in time order, each with the date its
// prefix's verdicts may carry.
function boundaries(M, features) {
  const rows = features.filter((r) => r.run_date >= M.pc.WINDOW_START);
  const sessions = [...new Set(rows.map((r) => r.session))].sort();
  let date = "";
  return sessions.map((session) => {
    for (const r of rows) if (r.session === session && r.run_date > date) date = r.run_date;
    return { session, date };
  }).concat([END]);
}

// The corpus as committed, every Ruling and member row in it: the state a Fit at the
// corpus's own commit reads (the Rulings of the last runs land after their run's date).
const END = { session: "\uffff", date: "9999-12-31", end: true };

function prefix(corpus, b, { strictDay = false } = {}) {
  const lastOfDay = (b.lastOfDay ?? true);
  const cut = strictDay && !lastOfDay ? (d) => d < b.date : (d) => d <= b.date;
  return {
    features: corpus.features.filter((r) => r.session <= b.session),
    members: corpus.members.filter((r) => r.session <= b.session),
    verdicts: corpus.tiers.filter((r) => cut(r.run_date)),
  };
}

// ------------------------------------------------------------------ a look -
function effectiveRows(table) {
  const out = {};
  for (const o of OBJECTIVES) for (const s of STRATA_SLOTS) out[`${o}/${s}`] = table.rows[o][s] ?? table.rows[o]["*"];
  return out;
}

const keyOf = (u) => `${u.pull.session}\0${u.pull.agent}`;

// The prefix guard and the merged-PR count of a prefix, both off the Router's own modules.
function prefixFacts(M, pre) {
  const { pa, pc, tr } = M;
  const report = pc.computeReport({ members: pre.members, tiers: pre.verdicts, features: pre.features, prs: null });
  const guard = tr.readGuard(pc.guardFile(report, "replay"));
  const units = pa.attribute({ features: pre.features, members: pre.members, tiers: pre.verdicts, windowStart: pc.WINDOW_START, stratum: tr.ruleStratum });
  const mergedKeys = new Set(units.filter((u) => u.status === "counted" && u.merged).map(keyOf));
  return { guard, report, pulls: units.length, mergedKeys };
}

function fitAt(M, prior, pre, facts) {
  return M.tr.fitTable({ prior, features: pre.features, members: pre.members, verdicts: pre.verdicts, guard: facts.guard, commit: null });
}

// Cadence rules over the sequence of boundaries' facts. Each returns the indices of its looks.
//   A      every boundary
//   B      boundaries where cumulative merged PRs cross a multiple of 50 (the task's definition)
//   B-due  `ticket-router.mjs fit --due`: merged PRs not in the last Fit's features >= 50
function lookSets(facts) {
  const A = facts.map((_, i) => i);
  const B = [];
  let prevMerged = 0;
  facts.forEach((f, i) => {
    const m = f.mergedKeys.size;
    if (Math.floor(m / EVERY) > Math.floor(prevMerged / EVERY)) B.push(i);
    prevMerged = m;
  });
  const due = [];
  let fitted = new Set();
  facts.forEach((f, i) => {
    let fresh = 0;
    for (const k of f.mergedKeys) if (!fitted.has(k)) fresh++;
    if (fresh >= EVERY) { due.push(i); fitted = f.allKeys; }
  });
  return { A, B, "B-due": due };
}

// Replay one chain: Fit at each look in `idx`, prior carried.
function chain(M, pres, facts, idx) {
  let prior = M.prior;
  const looks = [];
  for (const i of idx) {
    const t0 = performance.now();
    const fit = fitAt(M, prior, pres[i], facts[i]);
    const ms = performance.now() - t0;
    prior = fit;
    const n = (c) => fit.guard.n[c] ?? 0;
    const informative = n("slow-high") >= M.tr.MIN_N && fit.cells.some((c) => c !== "slow-high" && n(c) >= M.tr.MIN_N);
    looks.push({ i, informative, stage: fit.stage, burn_in: fit.burn_in, cells: [...fit.cells], eff: effectiveRows(fit), margin: margin(fit), ms });
  }
  return looks;
}

// What the cost rows weighed at one look: per candidate Cell, the verdict, its $ per merged PR
// against 0.75 x slow-high's, and the bootstrap range. Reads fitTable's own `reasons` and `estimates`.
function margin(fit) {
  const out = {};
  for (const s of ["*", "light", "heavy"]) {
    const r = fit.reasons.cost[s];
    const e = fit.estimates[s] ?? {};
    const base = e["slow-high"];
    if (!r || !base) continue;
    out[s] = Object.entries(r.cells).map(([c, x]) => {
      const f = e[c];
      const ratio = f?.usd_per_merged != null && base.usd_per_merged ? (f.usd_per_merged / base.usd_per_merged).toFixed(2) : "-";
      return `${c} ${x.verdict} n=${f?.merged ?? 0}/${base.merged} ratio ${ratio}${x.range ? ` CI[${x.range.join(",")}]` : ""}`;
    }).filter((t) => !/(slow-medium|task-max)/.test(t)).join("; ");
  }
  return out;
}

// Row changes and adoption episodes of one chain, from the slot sequences. The
// row before the first Fit is the shipped table's: every row slow-high.
function churn(looks, policy = "slow-high") {
  let changes = 0, adoptions = 0, undone = 0, undoneToDefault = 0, held = 0;
  const perSlot = {};
  const seqs = {};
  for (const s of SLOTS) {
    let prev = policy;
    let open = null; // the adopted cell the slot holds now
    let n = 0;
    seqs[s] = [];
    for (const l of looks) {
      const cur = l.eff[s];
      seqs[s].push(cur);
      if (cur !== prev) {
        changes++; n++;
        if (open !== null) { undone++; if (cur === policy) undoneToDefault++; open = null; }
        if (cur !== policy) { adoptions++; open = cur; }
      }
      prev = cur;
    }
    if (open !== null) held++;
    perSlot[s] = n;
  }
  return { looks: looks.length, changes, adoptions, undone, undoneToDefault, heldAtEnd: held, perSlot, seqs };
}

// ------------------------------------------------------------ replay (real) -
function replay(M, corpus, opts = {}) {
  const bs = boundaries(M, corpus.features);
  bs.forEach((b, i) => { b.lastOfDay = !bs.slice(i + 1).some((c) => c.date === b.date); });
  const pres = bs.map((b) => prefix(corpus, b, opts));
  const t0 = performance.now();
  const facts = pres.map((p) => prefixFacts(M, p));
  const guardMs = (performance.now() - t0) / bs.length;
  // mergedSince compares against the FITTED features rows, merged or not: the prefix's own window rows.
  facts.forEach((f, i) => { f.allKeys = new Set(pres[i].features.filter((r) => r.run_date >= M.pc.WINDOW_START).map((r) => `${r.session}\0${r.agent}`)); });
  const sets = lookSets(facts);
  const out = { bs, facts, pres, sets, guardMs, chains: {} };
  for (const [name, idx] of Object.entries(sets)) out.chains[name] = chain(M, pres, facts, idx);
  return out;
}

// ---------------------------------------------------------- permutation ----
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

// The Cell's dispatch model at `session`: the model of that Cell's latest original Pull
// started at or before it, else its earliest one's. Keeps each Cell on one model line.
function modelTimeline(units) {
  const by = new Map();
  for (const u of units) {
    if (!u.generation) continue;
    (by.get(u.cell) ?? by.set(u.cell, []).get(u.cell)).push({ session: u.pull.session, model: u.generation });
  }
  for (const l of by.values()) l.sort((x, y) => (x.session < y.session ? -1 : x.session > y.session ? 1 : 0));
  return (cell, session) => {
    const l = by.get(cell);
    let m = l[0].model;
    for (const e of l) { if (e.session <= session) m = e.model; else break; }
    return m;
  };
}

function permuted(M, corpus, base, timeline, seed) {
  const rand = mulberry32(seed);
  const { CELL } = M.lg;
  const newCell = new Map(); // unit index -> cell
  for (const s of ["light", "heavy", "unknown"]) {
    const idx = base.map((u, i) => [u, i]).filter(([u]) => u.stratum === s && u.status !== "excluded").map(([, i]) => i);
    const labels = idx.map((i) => base[i].cell);
    for (let k = labels.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [labels[k], labels[j]] = [labels[j], labels[k]]; }
    idx.forEach((i, k) => newCell.set(i, labels[k]));
  }
  const featureRow = new Map(); // original features row -> permuted row
  const memberRow = new Map(); // original member row -> relabelled row
  base.forEach((u, i) => {
    const c = newCell.get(i);
    if (c === undefined || c === u.cell) return;
    featureRow.set(u.pull, { ...u.pull, chosen_cell: c });
    const level = CELL.exec(c)[2];
    for (const r of u.rows) {
      if (!M.mo.isImplementer(r.member) || !M.pa.admissibleRow(r, u.cell)) continue;
      memberRow.set(r, { ...r, subagentType: `fleet-implementer-${c}`, effort: level, dispatchModel: timeline(c, u.pull.session) });
    }
  });
  return {
    ...corpus,
    features: corpus.features.map((r) => featureRow.get(r) ?? r),
    members: corpus.members.map((r) => memberRow.get(r) ?? r),
    moved: featureRow.size,
  };
}

// One null history: both cadences over the permuted corpus.
function nullHistory(M, corpus, base, timeline, seed) {
  const t0 = performance.now();
  const pc = permuted(M, corpus, base, timeline, seed);
  const r = replay(M, pc);
  const res = { seed, moved: pc.moved, ms: performance.now() - t0, cadence: {} };
  for (const name of Object.keys(r.chains)) {
    const looks = r.chains[name];
    const slotAdopt = (pred) => looks.some((l) => SLOTS.filter(pred).some((s) => l.eff[s] !== "slow-high"));
    const c = churn(looks);
    res.cadence[name] = {
      looks: looks.length,
      any: slotAdopt(() => true),
      cost: slotAdopt((s) => s.startsWith("cost/")),
      speed: slotAdopt((s) => s.startsWith("speed/")),
      lookBoundaries: looks.map((l) => l.i + 1),
      informativeLooks: looks.filter((l) => l.informative).length,
      adoptionBoundaries: looks.filter((l) => SLOTS.some((s) => l.eff[s] !== "slow-high")).map((l) => l.i + 1),
      looksWithAdoption: looks.filter((l) => SLOTS.some((s) => l.eff[s] !== "slow-high")).length,
      firstAdoptBoundary: (() => { const l = looks.find((x) => SLOTS.some((s) => x.eff[s] !== "slow-high")); return l ? l.i + 1 : null; })(),
      adoptedCells: [...new Set(looks.flatMap((l) => SLOTS.map((s) => l.eff[s]).filter((c) => c !== "slow-high")))],
      changes: c.changes, adoptions: c.adoptions, undone: c.undone, heldAtEnd: c.heldAtEnd,
      stageAtEnd: looks.at(-1)?.stage ?? null,
      mergedAtEnd: r.facts.at(-1).mergedKeys.size,
    };
  }
  return res;
}

// ------------------------------------------------------------------ stats --
// Exact (Clopper-Pearson) 95% interval for x successes of n, by bisection on the binomial tail.
function binomTail(x, n, p) { // P(X >= x)
  let s = 0, c = 1;
  const lp = Math.log(p), lq = Math.log(1 - p);
  for (let k = 0; k <= n; k++) {
    if (k >= x) {
      let lc = 0;
      for (let i = 1; i <= k; i++) lc += Math.log((n - k + i) / i);
      s += Math.exp(lc + k * lp + (n - k) * lq);
    }
  }
  return s;
}
export function clopperPearson(x, n, alpha = 0.05) {
  // lower: smallest p with P(X >= x) >= alpha/2; upper: largest p with P(X <= x) >= alpha/2.
  const search = (ok) => { let lo = 1e-12, hi = 1 - 1e-12; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; } return (lo + hi) / 2; };
  const lower = x === 0 ? 0 : search((p) => binomTail(x, n, p) >= alpha / 2);
  const upper = x === n ? 1 : search((p) => 1 - binomTail(x + 1, n, p) < alpha / 2);
  return [lower, upper];
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;

// ------------------------------------------------------------------ print --
function printReplay(M, label, r) {
  console.log(`\n### ${label}\n`);
  console.log(`prefix guard+merged-count time: ${r.guardMs.toFixed(0)} ms per boundary (mean of ${r.bs.length})\n`);
  console.log("| b | session | date | Pulls | merged | cells n (guard) | tripped |");
  console.log("|--:|---|---|--:|--:|---|---|");
  r.bs.forEach((b, i) => {
    const f = r.facts[i];
    const cells = f.report.cells.map((c) => `${c.cell}:${c.n_merged}`).join(" ");
    console.log(`| ${i + 1} | ${b.end ? "end of corpus" : b.session.slice(0, 19)} | ${b.end ? "all" : b.date} | ${f.pulls} | ${f.mergedKeys.size} | ${cells} | ${f.report.tripped.join(" ") || "-"} |`);
  });
  for (const [name, looks] of Object.entries(r.chains)) {
    const c = churn(looks);
    console.log(`\n**Cadence ${name}** — ${looks.length} looks at boundaries ${looks.map((l) => l.i + 1).join(",")} (informative: ${looks.filter((l) => l.informative).map((l) => l.i + 1).join(",") || "none"}); mean ${(looks.reduce((s, l) => s + l.ms, 0) / Math.max(1, looks.length)).toFixed(0)} ms per Fit\n`);
    console.log("| look | b | stage | burn_in | " + SLOTS.join(" | ") + " |");
    console.log("|--:|--:|--:|---|" + SLOTS.map(() => "---").join("|") + "|");
    looks.forEach((l, k) => console.log(`| ${k + 1} | ${l.i + 1} | ${l.stage} | ${l.burn_in} | ${SLOTS.map((s) => l.eff[s]).join(" | ")} |`));
    if (name === "A") {
      console.log("\ncost rows' weighing at each look (candidate verdict, $/merged ratio to slow-high, bootstrap 95% range of the $ difference):\n");
      looks.forEach((l, k) => console.log(`- look ${k + 1} (b${l.i + 1}): ${Object.entries(l.margin).map(([s, t]) => `\`${s}\` ${t}`).join(" · ")}`));
    }
    console.log(`\nrow changes ${c.changes} (per slot: ${SLOTS.map((s) => `${s}=${c.perSlot[s]}`).join(", ")}); adoptions (slot moves to a non-slow-high Cell) ${c.adoptions}; undone later ${c.undone} (to slow-high ${c.undoneToDefault}); held at the last look ${c.heldAtEnd}`);
  }
}

// ------------------------------------------------------------------- main --
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const M = await load(args.root);
  const corpus = { features: M.features, members: M.members, tiers: M.tiers };
  const blob = (s) => createHash("sha1").update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest("hex");
  console.log("## Inputs\n");
  console.log(`root ${args.root}; features ${M.features.length} rows (blob ${blob(M.raw.features).slice(0, 10)}), members ${M.members.length} (blob ${blob(M.raw.members).slice(0, 10)}), verdicts ${M.tiers.length} (blob ${blob(M.raw.tiers).slice(0, 10)})`);

  // Sanity: the full-corpus fit and guard against the known figures.
  const full = replay(M, corpus);
  const last = full.facts.at(-1);
  const sh = last.report.cells.find((c) => c.cell === "slow-high");
  console.log(`\nfull-corpus guard (prs=null): ${last.report.cells.map((c) => `${c.cell} n=${c.n_merged} fail ${c.n_failed}/${c.n_claims} $${c.mean_usd}/merged`).join("; ")}; tripped ${last.report.tripped.join(",") || "none"}; verdict ${last.report.verdict}`);
  const ff = fitAt(M, M.prior, full.pres.at(-1), last);
  console.log(`full-corpus fit from the shipped table: ${ff.n_rows} Pulls, stage ${ff.stage}, burn_in ${ff.burn_in}, cells ${ff.cells.join(",")}, rows ${JSON.stringify(ff.rows)}`);
  console.log(`(slow-high: n=${sh.n_merged}, merged $/PR ${sh.mean_usd})`);

  {
    const u = M.pa.attribute({ features: M.features, members: M.members, tiers: M.tiers, windowStart: M.pc.WINDOW_START, stratum: M.tr.ruleStratum });
    const by = {};
    for (const x of u) by[x.status] = (by[x.status] ?? 0) + 1;
    console.log(`\ncorpus: ${u.length} Pulls in the window, ${new Set(u.map((x) => x.pull.session)).size} runs; statuses ${JSON.stringify(by)}; ${u.filter((x) => x.ruling && x.ruling.run_date > x.pull.run_date).length} of the ${u.filter((x) => x.ruling).length} ruled Pulls hold a Ruling dated after the Pull's own run_date; first Pull ${u.map((x) => x.pull.run_date).sort()[0]}`);
  }

  printReplay(M, "Replay, verdicts cut at run_date <= the boundary's last run_date", full);
  const strict = replay(M, corpus, { strictDay: true });
  printReplay(M, "Replay, sensitivity: verdicts cut at run_date < the boundary's date when a later run shares that date", strict);

  const result = { inputs: { rows: [M.features.length, M.members.length, M.tiers.length] }, replay: {}, replayStrict: {}, null: null };
  const pack = (r) => Object.fromEntries(Object.entries(r.chains).map(([n, looks]) => {
    const c = churn(looks);
    return [n, { looks: looks.map((l) => ({ b: l.i + 1, stage: l.stage, burn_in: l.burn_in, eff: l.eff, margin: l.margin, ms: Math.round(l.ms) })), changes: c.changes, adoptions: c.adoptions, undone: c.undone, undoneToDefault: c.undoneToDefault, heldAtEnd: c.heldAtEnd, perSlot: c.perSlot }];
  }));
  result.replay = pack(full);
  result.replayStrict = pack(strict);

  if (!args.skipNull) {
    const base = M.pa.attribute({ features: M.features, members: M.members, tiers: M.tiers, windowStart: M.pc.WINDOW_START, stratum: M.tr.ruleStratum });
    const timeline = modelTimeline(base);
    // Sanity: a permuted corpus keeps every Pull's status and the per-Cell counts.
    {
      const pc = permuted(M, corpus, base, timeline, args.seed);
      const after = M.pa.attribute({ features: pc.features, members: pc.members, tiers: M.tiers, windowStart: M.pc.WINDOW_START, stratum: M.tr.ruleStratum });
      const sameStatus = after.every((u, i) => u.status === base[i].status && u.stratum === base[i].stratum && u.merged === base[i].merged);
      const countBy = (us) => { const o = {}; for (const u of us.filter((x) => x.status !== "excluded")) { const k = `${u.stratum}/${u.cell}`; o[k] = (o[k] ?? 0) + 1; } return JSON.stringify(Object.entries(o).sort()); };
      console.log(`\npermutation check: ${pc.moved} Pulls moved Cell; statuses/strata/merged unchanged ${sameStatus}; per stratum x Cell counts of the non-excluded Pulls preserved ${countBy(after) === countBy(base)}`);
      console.log(`generations after permutation per Cell: ${JSON.stringify(Object.fromEntries([...M.pa.generations(after)]))}`);
      console.log(`generations before: ${JSON.stringify(Object.fromEntries([...M.pa.generations(base)]))}`);
    }
    const t0 = performance.now();
    const results = await runPool(args, base.length);
    const wall = (performance.now() - t0) / 1000;
    results.sort((a, b) => a.seed - b.seed);
    console.log(`\n## Null simulation: ${results.length} histories, ${args.workers} workers, wall ${wall.toFixed(0)} s, mean ${(results.reduce((s, r) => s + r.ms, 0) / results.length / 1000).toFixed(1)} s CPU per history (both cadences, all prefixes)\n`);
    const summary = {};
    const rows1 = [], rows2 = [];
    for (const name of Object.keys(results[0].cadence)) {
      const xs = results.map((r) => r.cadence[name]);
      const x = xs.filter((c) => c.any).length, n = xs.length;
      const [lo, hi] = clopperPearson(x, n);
      const sum = (f) => xs.reduce((t, c) => t + f(c), 0);
      const mean = (f) => (sum(f) / n).toFixed(2);
      summary[name] = { n, any: x, cost: xs.filter((c) => c.cost).length, speed: xs.filter((c) => c.speed).length, ci: [lo, hi] };
      rows1.push(`| ${name} | ${xs[0].looks} | ${mean((c) => c.informativeLooks)} | ${x}/${n} | ${pct(x / n)} | ${pct(lo)}–${pct(hi)} | ${summary[name].cost} | ${summary[name].speed} |`);
      const held = xs.filter((c) => c.heldAtEnd > 0).length, und = xs.filter((c) => c.undone > 0).length;
      rows2.push(`| ${name} | ${held}/${n} (${pct(held / n)}) | ${und}/${n} (${pct(und / n)}) | ${sum((c) => c.looksWithAdoption)}/${sum((c) => c.informativeLooks)} (${pct(sum((c) => c.looksWithAdoption) / sum((c) => c.informativeLooks))}) | ${mean((c) => c.changes)} | ${mean((c) => c.adoptions)} | ${mean((c) => c.undone)} |`);
    }
    console.log("| cadence | looks/history | informative looks per history (mean) | histories with a false adoption (any row, any look) | share | exact 95% CI | of them in a cost row | in a speed row |");
    console.log("|---|--:|--:|--:|--:|---|--:|--:|");
    rows1.forEach((l) => console.log(l));
    console.log("\n| cadence | histories whose last look still holds a false adoption | histories with an adoption later undone | looks with a false adoption / informative looks | row changes per history | adoptions per history | adoptions undone per history |");
    console.log("|---|---|---|---|--:|--:|--:|");
    rows2.forEach((l) => console.log(l));
    // Per boundary: the share of histories whose cadence-A Fit at that boundary holds a false adoption.
    const per = Array.from({ length: results[0].cadence.A.looks }, (_, i) => results.filter((r) => r.cadence.A.adoptionBoundaries.includes(i + 1)).length);
    console.log(`\ncadence A, histories holding a false adoption at the Fit of boundary b (of ${results.length}): ${per.map((c, i) => `b${i + 1}=${c}`).join(" ")}`);
    for (const name of ["B", "B-due"]) {
      const at = results[0].cadence[name].lookBoundaries;
      console.log(`cadence ${name}, same at its own looks: ${at.map((i) => `b${i}=${results.filter((r) => r.cadence[name].adoptionBoundaries.includes(i)).length}`).join(" ")}`);
    }
    const both = (a, b) => results.filter((r) => r.cadence[a].any && r.cadence[b].any).length;
    console.log(`\npaired: A only ${results.filter((r) => r.cadence.A.any && !r.cadence.B.any).length}, B only ${results.filter((r) => !r.cadence.A.any && r.cadence.B.any).length}, both ${both("A", "B")}, neither ${results.filter((r) => !r.cadence.A.any && !r.cadence.B.any).length}`);
    const adopted = {};
    for (const r of results) for (const [name, c] of Object.entries(r.cadence)) for (const cell of c.adoptedCells) adopted[`${name}/${cell}`] = (adopted[`${name}/${cell}`] ?? 0) + 1;
    console.log(`Cells adopted (histories): ${JSON.stringify(adopted)}`);
    console.log(`stage at the end (A): ${JSON.stringify(results.reduce((o, r) => { const k = r.cadence.A.stageAtEnd; o[k] = (o[k] ?? 0) + 1; return o; }, {}))}; mergedAtEnd ${[...new Set(results.map((r) => r.cadence.A.mergedAtEnd))].join(",")}`);
    result.null = { n: results.length, summary, results };
  }
  if (args.json) (await import("node:fs")).writeFileSync(args.json, JSON.stringify(result, null, 1));
}

// ---------------------------------------------------------------- workers ---
function runPool(args) {
  return new Promise((resolveAll, reject) => {
    const out = [];
    let live = args.workers;
    for (let w = 0; w < args.workers; w++) {
      const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { ...args, w } });
      wk.on("message", (m) => out.push(m));
      wk.on("error", reject);
      wk.on("exit", () => { if (--live === 0) resolveAll(out); });
    }
  });
}

async function workerMain() {
  const args = workerData;
  const M = await load(args.root);
  const corpus = { features: M.features, members: M.members, tiers: M.tiers };
  const base = M.pa.attribute({ features: M.features, members: M.members, tiers: M.tiers, windowStart: M.pc.WINDOW_START, stratum: M.tr.ruleStratum });
  const timeline = modelTimeline(base);
  for (let h = args.w; h < args.n; h += args.workers) parentPort.postMessage(nullHistory(M, corpus, base, timeline, args.seed + h));
}

if (isMainThread) await main();
else await workerMain();
