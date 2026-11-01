#!/usr/bin/env node
// Derivation script for issue #4169: how often does a split pass by chance when the Fit
// re-judges it at every run, and how long does a real one take to be found?
//
// It re-uses split-gate-derive.mjs (#4160, branch research/split-gate): the corpus loading through the
// Router's own modules (plugin/scripts/: `attribute`, `generations`, `tally`, `underFloor`, `MIN_N`), the
// resampling, the decoy design, the candidate cuts, the gain engine, G1 (shuffled null) and G2 (cross-fitted
// doubly robust lower bound) are split-gate-derive.mjs's, copied as they are, except where this ticket asks
// otherwise: (1) a history is grown run by run, and the gates are judged at every run boundary on the prefix
// grown so far; (2) after burn-in the draw follows the real rule (4/5 to the policy Cell, 1/5 to the other),
// so G2's propensities are the real ones and G1's shuffle stays inside propensity strata. Decoy inputs are
// the `decoupled` family's (each Pull's nine recorded inputs come from another, independently drawn Pull).
//
// node docs/research/split-looks-derive.mjs [--hist-null a] [--hist-real b] [--hist-once c]
//     [--pulls-null P] [--pulls-real P] [--run-pulls 17] [--burn-in 102] [--delta 6] [--nulls 99]
//     [--workers W] [--seed S]
//   --hist-null   histories with no effect (Delta 0) per arm (default 300)
//   --hist-real   histories with the injected effect (Delta, default 6) per arm (default 160)
//   --hist-once   histories of the `once` arm, judged only at the end (default 1000 per Delta)
//   --pulls-null  Pulls grown per Delta-0 history (default 2000)
//   --pulls-real  Pulls grown per injected-effect history (default 2500)
//   --run-pulls   Pulls per run (default 17, this repository's median)
//   --burn-in     Pulls drawn uniformly before the real rule (default 102)
//   --nulls       G1 shuffles per look (default 99: p <= 0.05 is at most 4 of 99 shuffles reaching the real gain)
// Arms:
//   rule     the real rule. Pulls 1..burn-in are uniform over slow-high and task-high; after that 4/5 go to the
//            policy Cell and 1/5 to the other. The policy Cell is the previous look's one-Cell choice (the
//            split-gate engine's `pick` over one group: the cheaper Cell if it clears the floor with >= MIN_N
//            Pulls each, else slow-high). Every run boundary is a look. G2 uses the known propensities, G1
//            shuffles within propensity strata.
//   uniform  the record of uniform-draw Pulls only, as split-gate counted them: the burn-in Pulls and then 1 Pull in
//            5 as a random draw. Propensity 1/2 everywhere. Every run boundary is a look; the x axis stays in real Pulls.
//   once     as `rule`, but no Fit adopts anything between burn-in and the end (the policy Cell stays slow-high),
//            and the gates are judged once, at the end. `oncet`: the same with task-high as the policy Cell throughout
//            (the state a real-rule history ends in).
// Stdout is markdown. Deterministic for a fixed seed, whatever --workers is. Node >= 18.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const S = path.join(ROOT, "plugin/scripts");
const { underFloor, TRIP_POINTS } = await import(`${S}/pull-attribution.mjs`);

const NUM = ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs"];
const KINDS = ["bug", "enhancement", "documentation", ""];
const INPUTS = [...NUM, "kind", "parent", "inj"]; // bit k of a look's input mask = INPUTS[k]
const INJ = 1 << INPUTS.indexOf("inj");
const Z95 = 1.644854; // one-sided 95%
const EPS = 1e-12;
const FOLDS = 5;
const ARM_ID = { rule: 1, uniform: 2, once: 3, oncet: 4 };

// ------------------------------------------------------------------ small helpers (split-gate-derive.mjs's)
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const quantile = (sorted, q) => { const k = (sorted.length - 1) * q, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1); return sorted[f] + (sorted[c] - sorted[f]) * (k - f); };
const sortedNum = (xs) => Float64Array.from(xs).sort();
function mulberry32(seed) { // same generator as pull-attribution.mjs's
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix = (...xs) => { let h = 2166136261; for (const x of xs) { h = Math.imul(h ^ (x >>> 0), 16777619); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; } return h >>> 0; };
function shuffleInto(p, rand) { // Fisher-Yates permutation of 0..n-1 into p
  const n = p.length;
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  return p;
}
function wilson(k, n, z = 1.959964) { // 95% Wilson score range of k/n
  if (n === 0) return [NaN, NaN];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

// ================================================================== candidate cuts and partitions (split-gate-derive.mjs's)
/**
 * Candidate cuts over a record: numeric inputs at the record's 25/50/75th percentiles, `kind` as one 4-way
 * partition, `parent` by presence, and the injected bit. A binary cut whose smaller side holds under 2*minN
 * rows is dropped; a cut identical to an earlier one of the same input is dropped.
 */
function buildCands(R, minN) {
  const out = [];
  const add = (input, label, gid, G) => {
    const counts = new Array(G).fill(0);
    for (let i = 0; i < gid.length; i++) counts[gid[i]]++;
    if (G === 2 && counts.some((c) => c < 2 * minN)) return;
    const key = Buffer.from(gid.buffer, gid.byteOffset, gid.length).toString("latin1");
    if (out.some((c) => c.input === input && c.key === key)) return;
    out.push({ input, label, G, gid, key });
  };
  NUM.forEach((nm, k) => {
    const s = sortedNum(R.num[k]);
    for (const q of [0.25, 0.5, 0.75]) {
      const t = quantile(s, q);
      add(nm, `${nm} > ${t}`, Int8Array.from(R.num[k], (v) => (v > t ? 1 : 0)), 2);
    }
  });
  add("kind", "kind", Int8Array.from(R.kind), 4);
  add("parent", "parent", Int8Array.from(R.parent), 2);
  add("inj", "inj", Int8Array.from(R.bit), 2);
  return out;
}
/** depth-1 partitions first (the cuts), then every pair of cuts of two different inputs */
function buildParts(cands, n) {
  const parts = cands.map((c, i) => ({ d: 1, a: i, b: -1, gid: c.gid, G: c.G }));
  const nD1 = parts.length;
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    if (cands[i].input === cands[j].input) continue;
    const gid = new Int8Array(n), gi = cands[i].gid, gj = cands[j].gid, Gj = cands[j].G;
    for (let r = 0; r < n; r++) gid[r] = gi[r] * Gj + gj[r];
    parts.push({ d: 2, a: i, b: j, gid, G: cands[i].G * Gj });
  }
  return { parts, nD1 };
}
const partMask = (p, cands) => (1 << INPUTS.indexOf(cands[p.a].input)) | (p.b < 0 ? 0 : 1 << INPUTS.indexOf(cands[p.b].input));

// ================================================================== the gain engine (split-gate-derive.mjs's)
// Layout of a stats array: group g, Cell c at offset (g*2 + c)*4: [n, usd, claims, failed].
function partStats(gid, G, out, n, s) {
  s.fill(0, 0, G * 8);
  const { cell, usd, claims, failed } = out;
  for (let r = 0; r < n; r++) { const o = ((gid[r] << 1) + cell[r]) << 2; s[o]++; s[o + 1] += usd[r]; s[o + 2] += claims[r]; s[o + 3] += failed[r]; }
}
/** The Cell a group takes: lowest $ per Pull among Cells with >= minN Pulls that clear the floor against Cell 0 (slow-high); `fallback` if none. */
function pick(s, g, minN, fallback) {
  const o0 = g * 8;
  let best = -1, bv = Infinity;
  for (let c = 0; c < 2; c++) {
    const o = o0 + c * 4;
    if (s[o] < minN) continue;
    if (c !== 0) {
      if (s[o0] < minN) continue;
      if (underFloor({ failed: s[o + 3], claims: s[o + 2] }, { failed: s[o0 + 3], claims: s[o0 + 2] })) continue;
    }
    const v = s[o + 1] / s[o];
    if (v < bv) { bv = v; best = c; }
  }
  return best === -1 ? fallback : best;
}
/** gain over one Cell: value(every group at `base`) - value(every group at its pick), groups weighted by their share of Pulls */
function gainOf(s, G, n, minN, base) {
  let vOne = 0, vPol = 0;
  for (let g = 0; g < G; g++) {
    const o = g * 8, gn = s[o] + s[o + 4];
    if (gn === 0) continue;
    const w = gn / n, pooled = (s[o + 1] + s[o + 5]) / gn;
    const ch = pick(s, g, minN, base);
    vPol += w * (s[o + ch * 4] > 0 ? s[o + ch * 4 + 1] / s[o + ch * 4] : pooled);
    vOne += w * (s[o + base * 4] > 0 ? s[o + base * 4 + 1] / s[o + base * 4] : pooled);
  }
  return vOne - vPol;
}
const choicesOf = (s, G, minN, base) => Int8Array.from({ length: G }, (_, g) => pick(s, g, minN, base));
function argmax(gains, from, to) { let b = -1, bv = -Infinity; for (let p = from; p < to; p++) if (gains[p] > bv) { bv = gains[p]; b = p; } return b; }

// ================================================================== G2 with the real propensities
/**
 * Doubly robust difference (value of the base Cell everywhere minus value of `choices`), per Pull, over all
 * rows. mu = group x Cell means from the other folds. split-gate-derive.mjs's `drDiff` with propensity 1/2
 * replaced by the Pull's known propensity of the Cell it is scored on: `pSlow[r]` is P(slow-high) for row r.
 */
function drDiff({ gid, out, mu, choices, base, pSlow }) {
  const { cell, usd } = out;
  const prop = (r, c) => (c === 0 ? pSlow[r] : 1 - pSlow[r]);
  let sd1 = 0, sd2 = 0, m = 0;
  for (let r = 0; r < cell.length; r++) {
    m++;
    const g = gid[r], cb = choices[g];
    if (cb === base) continue;
    const mA = mu(r, g, base), mB = mu(r, g, cb);
    const GA = mA + (cell[r] === base ? (usd[r] - mA) / prop(r, base) : 0), GB = mB + (cell[r] === cb ? (usd[r] - mB) / prop(r, cb) : 0);
    const d = GA - GB;
    sd1 += d; sd2 += d * d;
  }
  const mn = sd1 / m, v = Math.max(0, (sd2 - m * mn * mn) / (m - 1));
  return { mean: mn, se: Math.sqrt(v / m), lcb: mn - Z95 * Math.sqrt(v / m), m };
}
/** G2 on the same record the split was chosen on: the outcome model is cross-fitted over 5 random folds */
function drInSample(part, out, n, fold, choices, base, pSlow) {
  const { gid, G } = part;
  const { cell, usd } = out;
  const sn = new Float64Array(FOLDS * G * 2), su = new Float64Array(FOLDS * G * 2), tn = new Float64Array(G * 2), tu = new Float64Array(G * 2);
  const cnF = new Float64Array(FOLDS * 2), cuF = new Float64Array(FOLDS * 2), cn = new Float64Array(2), cu = new Float64Array(2);
  for (let r = 0; r < n; r++) {
    const f = fold[r], i = (f * G + gid[r]) * 2 + cell[r];
    sn[i]++; su[i] += usd[r]; tn[gid[r] * 2 + cell[r]]++; tu[gid[r] * 2 + cell[r]] += usd[r];
    cnF[f * 2 + cell[r]]++; cuF[f * 2 + cell[r]] += usd[r]; cn[cell[r]]++; cu[cell[r]] += usd[r];
  }
  const mu = (r, g, c) => {
    const f = fold[r], i = (f * G + g) * 2 + c, N1 = tn[g * 2 + c] - sn[i];
    if (N1 > 0) return (tu[g * 2 + c] - su[i]) / N1;
    const N2 = cn[c] - cnF[f * 2 + c];
    return N2 > 0 ? (cu[c] - cuF[f * 2 + c]) / N2 : 0;
  };
  return drDiff({ gid, out, mu, choices, base, pSlow });
}

// ================================================================== one look
/**
 * The gates at one look, on the record prefix `R` (n rows) with outcomes `out` and propensities `pSlow`.
 *   G1: the best gain (depth 1 / <= 2) beats the 95th percentile of the same search on shuffled outcomes;
 *       the shuffle of the whole (Cell, $, claims, failed) tuple is inside propensity strata (rows with the
 *       same P(slow-high)); with one stratum it is split-gate's plain row shuffle. Stops once the depth's
 *       verdict is fixed (the count of shuffles reaching the real gain exceeds what p <= 0.05 allows).
 *   G2: cross-fitted doubly robust one-sided 95% lower bound > 0, with the real propensities (only computed
 *       when G1 passes, since only G1 and G3 are reported).
 *   G3: G1 and G2.
 */
function lookGates({ R, cands, parts, nD1, out, pSlow, strata, minN, B, seed }) {
  const n = R.n, nP = parts.length;
  const s = new Float64Array(64);
  const zero = new Int8Array(n);
  partStats(zero, 1, out, n, s);
  const base = pick(s, 0, minN, 0);
  const gains = new Float64Array(nP);
  for (let p = 0; p < nP; p++) { partStats(parts[p].gid, parts[p].G, out, n, s); gains[p] = gainOf(s, parts[p].G, n, minN, base); }
  const best = [null, argmax(gains, 0, nD1), argmax(gains, 0, nP)];
  const moves = [null, gains[best[1]] > EPS, gains[best[2]] > EPS];
  const maxGe = Math.floor(0.05 * (B + 1)) - 1; // p = (1 + ge)/(B + 1) <= 0.05  <=>  ge <= maxGe
  const ge = [0, 0, 0];
  const alive = [false, moves[1], moves[2]]; // a depth is alive while the verdict is open
  if (alive[1] || alive[2]) {
    const rand = mulberry32(seed), tmp = new Int32Array(n), p = new Int32Array(n);
    const o2 = { cell: new Int8Array(n), usd: new Float64Array(n), claims: new Float64Array(n), failed: new Float64Array(n) };
    for (let b = 0; b < B; b++) {
      for (const L of strata) { // permute within the stratum
        for (let i = 0; i < L.length; i++) tmp[i] = L[i];
        for (let i = L.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t; }
        for (let i = 0; i < L.length; i++) p[L[i]] = tmp[i];
      }
      for (let i = 0; i < n; i++) { const j = p[i]; o2.cell[i] = out.cell[j]; o2.usd[i] = out.usd[j]; o2.claims[i] = out.claims[j]; o2.failed[i] = out.failed[j]; }
      let m1 = -Infinity, m2 = -Infinity;
      for (let q = 0; q < nP; q++) {
        partStats(parts[q].gid, parts[q].G, o2, n, s);
        const g = gainOf(s, parts[q].G, n, minN, base);
        if (g > m2) m2 = g;
        if (q === nD1 - 1) m1 = m2;
      }
      if (alive[1] && m1 >= gains[best[1]] - EPS) { ge[1]++; if (ge[1] > maxGe) alive[1] = false; }
      if (alive[2] && m2 >= gains[best[2]] - EPS) { ge[2]++; if (ge[2] > maxGe) alive[2] = false; }
      if (!alive[1] && !alive[2]) break;
    }
  }
  // folds for G2 (independent of the outcomes)
  const rf = mulberry32(seed ^ 0x5bd1e995);
  let fold = null;
  const res = { base, d: [null, null, null] };
  for (const d of [1, 2]) {
    const q = best[d], part = parts[q];
    const r = { moves: moves[d], g1: false, g3: false, mask: partMask(part, cands), gain: gains[q] };
    r.g1 = r.moves && ge[d] <= maxGe;
    if (r.g1) {
      if (fold === null) { fold = new Int8Array(n); const o = shuffleInto(new Int32Array(n), rf); for (let k = 0; k < n; k++) fold[o[k]] = k % FOLDS; }
      partStats(part.gid, part.G, out, n, s);
      const choices = choicesOf(s, part.G, minN, base);
      r.g3 = drInSample(part, out, n, fold, choices, base, pSlow).lcb > 0;
    }
    res.d[d] = r;
  }
  return res;
}

// ================================================================== histories
/** nU(r): the uniform-draw record's size after r runs: the burn-in Pulls, then 1 Pull in 5 */
const nUniform = (r, runPulls, burn) => (r * runPulls <= burn ? r * runPulls : burn + Math.floor((r * runPulls - burn) / 5));

/**
 * One history. Returns, per look, the bit-packed verdicts: g[gate][depth] = Uint8Array(looks) (0/1) and
 * m[gate][depth] = Uint16Array(looks) (the input mask of the adopted partition), plus the record size per look.
 */
function runHistory({ arm, delta, h, runs, D, o }) {
  const { runPulls, burn, minN, B, seed } = o;
  const rng = mulberry32(mix(seed, ARM_ID[arm], delta, h));
  const cap = arm === "uniform" ? nUniform(runs, runPulls, burn) : runs * runPulls;
  const R = {
    n: 0, cell: new Int8Array(cap), usd: new Float64Array(cap), claims: new Float64Array(cap), failed: new Float64Array(cap),
    num: NUM.map(() => new Float64Array(cap)), kind: new Int8Array(cap), parent: new Int8Array(cap), bit: new Int8Array(cap),
  };
  const pSlow = new Float64Array(cap); // P(slow-high) of the Pull, known at the draw
  const lastOnly = arm === "once" || arm === "oncet";
  const looks = lastOnly ? 1 : runs;
  const rec = { n: new Int32Array(looks), g: [[], [new Uint8Array(looks), new Uint8Array(looks)], [new Uint8Array(looks), new Uint8Array(looks)]], m: [[], [new Uint16Array(looks), new Uint16Array(looks)], [new Uint16Array(looks), new Uint16Array(looks)]], base: new Int8Array(looks) };
  // rec.g[gate][depth-1], gate 1 = G1, 2 = G3
  let policy = arm === "oncet" ? 1 : 0; // slow-high until a look adopts the cheaper Cell (`oncet`: task-high throughout)
  let n = 0;
  for (let r = 1; r <= runs; r++) {
    const target = arm === "uniform" ? nUniform(r, runPulls, burn) : r * runPulls;
    for (; n < target; n++) {
      const uniformDraw = arm === "uniform" || n < burn;
      const ps = uniformDraw ? 0.5 : policy === 0 ? 0.8 : 0.2;
      const per = rng() < D.pA ? 0 : 1, c = rng() < ps ? 0 : 1;
      const pool = D.pools[per][c];
      const j = pool[Math.floor(rng() * pool.length)];
      const jf = Math.floor(rng() * D.nAll); // decoupled: the nine recorded inputs come from another Pull
      R.cell[n] = c; R.claims[n] = D.claims[j]; R.failed[n] = D.failed[j]; pSlow[n] = ps;
      R.kind[n] = D.kind[jf]; R.parent[n] = D.parent[jf];
      for (let k = 0; k < NUM.length; k++) R.num[k][n] = D.num[k][jf];
      R.bit[n] = rng() < 0.5 ? 1 : 0; // the injected input: a fair coin
      R.usd[n] = D.usd[j] + (delta !== 0 && c === 1 && R.bit[n] === 1 ? delta : 0); // Delta $ on the injected side of task-high
    }
    R.n = n;
    if (lastOnly && r < runs) continue;
    const li = lastOnly ? 0 : r - 1;
    const view = {
      n, num: R.num.map((a) => a.subarray(0, n)), kind: R.kind.subarray(0, n), parent: R.parent.subarray(0, n), bit: R.bit.subarray(0, n),
    };
    const out = { cell: R.cell.subarray(0, n), usd: R.usd.subarray(0, n), claims: R.claims.subarray(0, n), failed: R.failed.subarray(0, n) };
    const ps = pSlow.subarray(0, n);
    const cands = buildCands(view, minN);
    const { parts, nD1 } = buildParts(cands, n);
    const byKey = new Map();
    for (let i = 0; i < n; i++) { const k = Math.round(ps[i] * 10); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(i); }
    const strata = [...byKey.values()].map((L) => Int32Array.from(L));
    const res = lookGates({ R: view, cands, parts, nD1, out, pSlow: ps, strata, minN, B, seed: mix(seed, 99, ARM_ID[arm], delta, h, r) });
    rec.n[li] = n; rec.base[li] = res.base;
    for (const d of [1, 2]) {
      const x = res.d[d];
      rec.g[1][d - 1][li] = x.g1 ? 1 : 0; rec.g[2][d - 1][li] = x.g3 ? 1 : 0;
      rec.m[1][d - 1][li] = x.mask; rec.m[2][d - 1][li] = x.mask;
    }
    if (arm === "rule") policy = res.base; // the next run is drawn with the Cell this look chose
  }
  return rec;
}

// ================================================================== worker side
async function workerMain() {
  const { D, opts } = workerData;
  parentPort.on("message", (task) => {
    if (task === null) process.exit(0);
    const t0 = Date.now();
    const rec = runHistory({ arm: task.arm, delta: task.delta, h: task.h, runs: task.runs, D, o: opts });
    parentPort.postMessage({ task, rec, ms: Date.now() - t0 });
  });
}

// ================================================================== main side
async function main() {
  const argv = process.argv.slice(2);
  const flags = { histNull: 300, histReal: 160, histOnce: 1000, pullsNull: 2000, pullsReal: 2500, runPulls: 17, burn: 102, delta: 6, nulls: 99, workers: 8, seed: 20261101 };
  const die = (m) => { process.stderr.write(`split-looks-derive: ${m}\n`); process.exit(1); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => (i + 1 < argv.length ? Number(argv[++i]) : die(`${a} needs a value`));
    if (a === "--hist-null") flags.histNull = v();
    else if (a === "--hist-real") flags.histReal = v();
    else if (a === "--hist-once") flags.histOnce = v();
    else if (a === "--pulls-null") flags.pullsNull = v();
    else if (a === "--pulls-real") flags.pullsReal = v();
    else if (a === "--run-pulls") flags.runPulls = v();
    else if (a === "--burn-in") flags.burn = v();
    else if (a === "--delta") flags.delta = v();
    else if (a === "--nulls") flags.nulls = v();
    else if (a === "--workers") flags.workers = v();
    else if (a === "--seed") flags.seed = v();
    else die(`unknown flag ${a}`);
  }
  if (!(flags.nulls >= 19)) die("--nulls must be at least 19");

  const { attribute, generations, tally, parseFeatures } = await import(`${S}/pull-attribution.mjs`);
  const { parseTsv } = await import(`${S}/member-outcomes.mjs`);
  const { parseTierOutcomes } = await import(`${S}/tier-outcomes.mjs`);
  const { ruleStratum, MIN_N } = await import(`${S}/ticket-router.mjs`);
  const { spawnSync } = await import("node:child_process");

  const out = [];
  const P = (s = "") => out.push(s);
  const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(1));
  const f2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(2));
  const pc = (x) => (Number.isNaN(x) ? "-" : (100 * x).toFixed(0));
  const pc1 = (x) => (Number.isNaN(x) ? "-" : (100 * x).toFixed(1));
  const t0 = Date.now();

  // ---------------------------------------------------------------- corpus, as split-gate-derive.mjs loads it
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const features = parseFeatures(read("docs/metrics/ticket-features.tsv"));
  const members = parseTsv(read("docs/metrics/member-outcomes.tsv"));
  const verdicts = parseTierOutcomes(read("docs/metrics/tier-outcomes.tsv"));
  const WINDOW = "2026-10-03";
  const all = attribute({ features, members, tiers: verdicts, windowStart: WINDOW, stratum: ruleStratum });
  const order = generations(all);
  const units = all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule"); // fitPulls, ticket-router.mjs:382-385
  const tallies = tally(units, order);
  const gitHead = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const kOf = (u) => Number(u.pull.exploration_draw.split("/")[1]);
  const allRows = tallies.flatMap((t) => t.pulls.map((u) => ({ cell: u.cell, K: kOf(u), f: u.pull, usd: u.spend, merged: u.merged ? 1 : 0, claims: u.claims, failed: u.falseClaims })));
  const pairRows = allRows.filter((r) => r.cell !== "smol-high");
  if (pairRows.some((r) => r.merged !== 1)) die("a counted Pull is not merged: the per-Pull and per-merged-PR figures differ");
  const nOf = (c) => pairRows.filter((r) => r.cell === c).length;
  const D = {
    nAll: pairRows.length,
    usd: Float64Array.from(pairRows, (r) => r.usd), claims: Float64Array.from(pairRows, (r) => r.claims), failed: Float64Array.from(pairRows, (r) => r.failed),
    num: NUM.map((nm) => Float64Array.from(pairRows, (r) => Number(r.f[nm]))),
    kind: Int8Array.from(pairRows, (r) => KINDS.indexOf(r.f.kind)), parent: Int8Array.from(pairRows, (r) => (r.f.parent !== "" ? 1 : 0)),
    pools: [0, 1].map((per) => [0, 1].map((c) => pairRows.flatMap((r, i) => ((r.K === 3 ? 0 : 1) === per && (r.cell === "task-high" ? 1 : 0) === c ? [i] : [])))),
    pA: pairRows.filter((r) => r.K === 3).length / pairRows.length,
  };
  if (D.kind.some((k) => k < 0)) die("an unknown `kind` value");
  const pooledMean = (c) => mean(pairRows.filter((r) => r.cell === c).map((r) => r.usd));

  const RP = flags.runPulls, BURN = flags.burn, DELTA = flags.delta;
  const runsOf = (pulls) => Math.ceil(pulls / RP);
  const runsNull = runsOf(flags.pullsNull), runsReal = runsOf(flags.pullsReal);
  if (BURN % RP !== 0) die("--burn-in must be a whole number of runs");
  const opts = { seed: flags.seed, minN: MIN_N, B: flags.nulls, runPulls: RP, burn: BURN };

  P("# split-looks derive output");
  P();
  P(`Repository HEAD ${gitHead}; window start ${WINDOW}; ${all.length} Pulls in the window, ${units.length} in the Fit's set (ticket-router.mjs:382-385); pool ${pairRows.length} counted slow-high (${nOf("slow-high")}) and task-high (${nOf("task-high")}) Pulls, pooled gap ${f2(pooledMean("task-high") - pooledMean("slow-high"))}; MIN_N ${MIN_N}, TRIP_POINTS ${TRIP_POINTS}; seed ${flags.seed}.`);
  P(`Settings: ${RP} Pulls per run, uniform draw to ${BURN} Pulls (${BURN / RP} runs), then 4/5 policy Cell : 1/5 other; histories ${flags.histNull} (Delta 0, ${runsNull} runs = ${runsNull * RP} Pulls) and ${flags.histReal} (Delta ${DELTA}, ${runsReal} runs = ${runsReal * RP} Pulls) per looking arm, ${flags.histOnce} per Delta for the judged-once arm; G1 shuffles per look ${flags.nulls}; workers ${flags.workers}.`);
  P();

  // ---------------------------------------------------------------- simulate
  const tasks = [];
  for (let h = 0; h < flags.histReal; h++) for (const arm of ["rule", "uniform"]) tasks.push({ arm, delta: DELTA, h, runs: runsReal });
  for (let h = 0; h < flags.histNull; h++) for (const arm of ["rule", "uniform"]) tasks.push({ arm, delta: 0, h, runs: runsNull });
  const onceRuns = (delta) => [...new Set([Math.min(runsOf(2000), delta === 0 ? runsNull : runsReal), delta === 0 ? runsNull : runsReal])];
  for (let h = 0; h < flags.histOnce; h++) for (const delta of [0, DELTA]) for (const runs of onceRuns(delta)) for (const arm of ["once", "oncet"]) tasks.push({ arm, delta, h, runs });
  const cost = (t) => t.arm === "once" || t.arm === "oncet" ? t.runs * 0.02 : (t.delta === 0 ? 0.4 : 1) * (t.arm === "uniform" ? 0.3 : 1) * t.runs * t.runs; // dispatch the heavy ones first
  tasks.sort((a, b) => cost(b) - cost(a));
  const results = new Map();
  let cpuMs = 0;
  await new Promise((resolve) => {
    let next = 0, done = 0;
    const nW = Math.min(flags.workers, tasks.length);
    if (tasks.length === 0) return resolve();
    for (let w = 0; w < nW; w++) {
      const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { D, opts }, execArgv: [] });
      const feed = () => { if (next < tasks.length) wk.postMessage(tasks[next++]); else wk.postMessage(null); };
      wk.on("message", ({ task, rec, ms }) => {
        results.set(`${task.arm}|${task.delta}|${task.h}|${task.runs}`, rec); cpuMs += ms; done++;
        if (done % 25 === 0) process.stderr.write(`split-looks-derive: ${done}/${tasks.length} histories, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
        feed();
        if (done === tasks.length) resolve();
      });
      wk.on("error", (e) => { process.stderr.write(`worker error: ${e.stack}\n`); process.exit(1); });
      feed();
    }
  });
  const simWall = (Date.now() - t0) / 1000;

  // ---------------------------------------------------------------- aggregation
  const GATES = [["G1", 1], ["G3", 2]];
  const VARIANTS = [["every look", "H1"], ["2 looks, same inputs", "H2s"], ["2 looks, any split", "H2a"]];
  const recsOf = (arm, delta, runs = null) => [...results].filter(([k]) => k.startsWith(`${arm}|${delta}|`) && (runs === null || k.endsWith(`|${runs}`))).sort((a, b) => Number(a[0].split("|")[2]) - Number(b[0].split("|")[2])).map(([, v]) => v);
  /** does a split stand at look i (0-based) under hysteresis variant v, for gate gi, depth d; `real` also needs the injected input */
  const stands = (rec, gi, d, v, real) => {
    const pass = rec.g[gi][d - 1], mk = rec.m[gi][d - 1], L = pass.length, a = new Uint8Array(L);
    const ok = (i) => pass[i] === 1 && (!real || (mk[i] & INJ) !== 0);
    for (let i = 0; i < L; i++) {
      if (v === "H1") a[i] = ok(i) ? 1 : 0;
      else if (i > 0 && ok(i) && ok(i - 1)) a[i] = v === "H2a" || mk[i] === mk[i - 1] ? 1 : 0;
    }
    return a;
  };
  const streaks = (a) => { const xs = []; let c = 0; for (let i = 0; i <= a.length; i++) { if (i < a.length && a[i]) c++; else if (c) { xs.push(c); c = 0; } } return xs; };
  const fmtP = (k, n) => { const r = wilson(k, n); return `${pc1(k / n)} [${pc(r[0])}-${pc(r[1])}]`; };

  const hRule0 = recsOf("rule", 0), hUni0 = recsOf("uniform", 0);
  const hRuleR = recsOf("rule", DELTA), hUniR = recsOf("uniform", DELTA), onceR = recsOf("once", DELTA, runsReal);

  // ---- 1. chance splits
  const chanceTable = (recs, title, horizonLooks) => {
    P(`**${title}** (${recs.length} histories, looks at runs 1..${horizonLooks} = ${horizonLooks * RP} Pulls; \`mean run\` and \`max run\` are the length in runs of a stretch of consecutive looks at which a split stands, over all stretches of all histories; \`looks split\` is the share of all looks at which a split stands; \`final\` the share split at the last look)`);
    P();
    P("| gate | depth | a split stands when | ever split % [range] | stretches per history | mean run | max run | looks split % | final look % [range] |");
    P("|---|---|---|---|---|---|---|---|---|");
    for (const [gate, gi] of GATES) for (const d of [1, 2]) for (const [vname, v] of VARIANTS) {
      let ever = 0, fin = 0, looksSplit = 0, looks = 0; const runs = [];
      for (const rec of recs) {
        const a = stands(rec, gi, d, v, false).subarray(0, horizonLooks);
        if (a.some((x) => x)) ever++;
        if (a[horizonLooks - 1]) fin++;
        looksSplit += sum(a); looks += a.length;
        runs.push(...streaks(a));
      }
      P(`| ${gate} | ${d} | ${vname} | ${fmtP(ever, recs.length)} | ${f2(runs.length / recs.length)} | ${runs.length ? f1(mean(runs)) : "-"} | ${runs.length ? Math.max(...runs) : "-"} | ${pc1(looksSplit / looks)} | ${fmtP(fin, recs.length)} |`);
    }
    P();
  };
  P("## 1. Chance splits (Delta 0: no input matters)");
  P();
  const horizons = [...new Set([Math.min(runsOf(2000), runsNull), runsNull])];
  for (const hz of horizons) {
    chanceTable(hRule0, `Real draw rule, propensity-weighted gates, ${hz * RP} Pulls`, hz);
  }
  P("**Judged once at the end, against the last look of the looking histories.** `once`: the same record grown without any adoption (4/5 to slow-high after burn-in), judged only at its last Pull. `last look`: the share split at the last look of the real-rule histories above. `uniform record`: the uniform-draw-only record at its last look.");
  P();
  P("| gate | depth | horizon Pulls | once, 4/5 slow-high, split % [range] (n) | once, 4/5 task-high % [range] (n) | last look of the real-rule histories % [range] (n) | uniform-draw record, last look % [range] (n; draws) |");
  P("|---|---|---|---|---|---|---|");
  for (const hz of horizons) for (const [gate, gi] of GATES) for (const d of [1, 2]) {
    const onceFinal = recsOf("once", 0, hz);
    const k1 = onceFinal.filter((rec) => rec.g[gi][d - 1][0] === 1).length;
    const oncetFinal = recsOf("oncet", 0, hz), k1t = oncetFinal.filter((rec) => rec.g[gi][d - 1][0] === 1).length;
    const k2 = hRule0.filter((rec) => rec.g[gi][d - 1][hz - 1] === 1).length;
    const k3 = hUni0.filter((rec) => rec.g[gi][d - 1][hz - 1] === 1).length;
    P(`| ${gate} | ${d} | ${hz * RP} | ${fmtP(k1, onceFinal.length)} (${onceFinal.length}) | ${fmtP(k1t, oncetFinal.length)} (${oncetFinal.length}) | ${fmtP(k2, hRule0.length)} (${hRule0.length}) | ${fmtP(k3, hUni0.length)} (${hUni0.length}; ${hUni0[0].n[hz - 1]}) |`);
  }
  P();
  P("**Chance splits in the uniform-draw-only record** (split-gate's accounting: burn-in Pulls, then 1 Pull in 5 as a random draw; still a look at every run).");
  P();
  chanceTable(hUni0, "Uniform-draw record", runsNull);

  // ---- 2. the real split
  P("**When in a history chance splits stand.** Share of (history, look) pairs at which a split stands (every-look rule), by the Pulls grown at the look.");
  P();
  {
    const edges = [0, 204, 340, 680, 1020, 1360, 1700, 2006, Infinity].filter((e, i, a) => i === 0 || a[i - 1] < runsNull * RP);
    const bucket = (lo, hi) => { const a = []; for (let r = 1; r <= runsNull; r++) if (r * RP > lo && r * RP <= hi) a.push(r - 1); return a; };
    P(`| gate | depth | record | ${edges.slice(0, -1).map((lo, i) => `${lo + 1}-${Math.min(edges[i + 1], runsNull * RP)} Pulls`).join(" | ")} |`);
    P(`|---|---|---|${edges.slice(0, -1).map(() => "---").join("|")}|`);
    for (const [gate, gi] of GATES) for (const d of [1, 2]) for (const [rname, recs] of [["real rule", hRule0], ["uniform draws", hUni0]]) {
      const cells = edges.slice(0, -1).map((lo, i) => { const idx = bucket(lo, edges[i + 1]); let k = 0, t = 0; for (const rec of recs) for (const li of idx) { k += rec.g[gi][d - 1][li]; t++; } return t ? pc1(k / t) : "-"; });
      P(`| ${gate} | ${d} | ${rname} | ${cells.join(" | ")} |`);
    }
  }
  P();
  P("## 2. Time to the real split (Delta " + DELTA + ")");
  P();
  const firstHold = (recs, gi, d, v) => recs.map((rec) => { const a = stands(rec, gi, d, v, true); const i = a.indexOf(1); return i < 0 ? Infinity : i + 1; });
  const share = (fh, r) => fh.filter((x) => x <= r).length / fh.length;
  const crossing = (fh) => { const s = [...fh].sort((a, b) => a - b), k = Math.ceil(0.8 * s.length) - 1; return s[k]; };
  const bootCross = (fh, seed) => { // 95% bootstrap range of the 80% run over histories (1000 resamples)
    const rnd = mulberry32(seed), xs = [];
    for (let b = 0; b < 1000; b++) { const r = Array.from(fh, () => fh[Math.floor(rnd() * fh.length)]); xs.push(crossing(r)); }
    xs.sort((a, b) => a - b);
    return [xs[24], xs[974]];
  };
  P("The real split is held at a look when the gate passes and the adopted partition uses the injected input. `first held` is the first look at which that is so under the hysteresis variant (so `first held by` is cumulative over looks); `held at the look` is the share of histories in which it is held at that one look. `run for 80%` is the first run by which 80% of histories have first held it; `Pulls` = run x " + RP + ". `draws`: the record's size in uniform-draw terms: for the real-rule record, burn-in Pulls + 0.64 per later Pull (4 p (1-p) with p = 4/5); for the uniform-draw record, its actual size. `x` = never reached within the horizon.");
  P();
  const cps = [500, 1000, 1500, 2000, 2500, 3000].filter((p) => p <= runsReal * RP);
  P(`| gate | depth | hysteresis | record | histories | run for 80% [95% bootstrap] | Pulls for 80% | draws at that run | first held by ${cps.join(" / ")} Pulls % | held at the look at those Pulls % |`);
  P("|---|---|---|---|---|---|---|---|---|---|");
  const out80 = new Map();
  for (const [gate, gi] of GATES) for (const d of [1, 2]) for (const [vname, v] of VARIANTS) for (const [rname, recs] of [["real rule, weighted", hRuleR], ["uniform draws only", hUniR]]) {
    const fh = firstHold(recs, gi, d, v), r80 = crossing(fh);
    const hit = Number.isFinite(r80);
    const draws = !hit ? null : rname.startsWith("real") ? Math.round(BURN + 0.64 * Math.max(0, r80 * RP - BURN)) : recs[0].n[r80 - 1];
    const bc = hit ? bootCross(fh, mix(flags.seed, 8080, gi, d, v.length, rname.length)) : null;
    out80.set(`${gate}|${d}|${v}|${rname}`, { r80, hit, draws });
    P(`| ${gate} | ${d} | ${vname} | ${rname} | ${recs.length} | ${hit ? `${r80} [${bc[0]}-${Number.isFinite(bc[1]) ? bc[1] : "x"}]` : "x"} | ${hit ? r80 * RP : `> ${runsReal * RP}`} | ${hit ? draws : "-"} | ${cps.map((p) => pc(share(fh, Math.floor(p / RP)))).join(" / ")} | ${cps.map((p) => { const li = Math.floor(p / RP) - 1; return pc(recs.filter((rec) => stands(rec, gi, d, v, true)[li] === 1).length / recs.length); }).join(" / ")} |`);
  }
  P();
  P("**Looking at one look only, at the end (`once` arm, Delta " + DELTA + ", " + runsReal * RP + " Pulls, no adoption).** Share whose adopted split uses the injected input:");
  P();
  P("| gate | depth | histories | split on the injected input % [range] | any split % |");
  P("|---|---|---|---|---|");
  for (const [gate, gi] of GATES) for (const d of [1, 2]) {
    const ki = onceR.filter((rec) => rec.g[gi][d - 1][0] === 1 && (rec.m[gi][d - 1][0] & INJ)).length, ka = onceR.filter((rec) => rec.g[gi][d - 1][0] === 1).length;
    P(`| ${gate} | ${d} | ${onceR.length} | ${fmtP(ki, onceR.length)} | ${fmtP(ka, onceR.length)} |`);
  }
  P();
  P("**Weighting against the draw-count claim.** Pulls for 80% under the real rule with weighted gates, against the uniform-draw record at 1 draw per 5 Pulls, and the ratio of the two. 'Draws per Pull' = the uniform record's draws at its own 80% point / the Pulls the weighted real-rule record needed for 80%: how many uniform draws one real Pull is worth, burn-in included; the next column leaves the burn-in out. The last column is the real-rule record's size in draws at its 80% point if each Pull after burn-in were worth 0.64 (to set beside the uniform draws).");
  P();
  P(`| gate | depth | hysteresis | Pulls, real rule weighted | Pulls, uniform draws only | uniform draws at its 80% | draws per Pull of the weighted record | the same beyond the burn-in: (draws - ${BURN}) / (Pulls - ${BURN}) | real-rule draws at its 80% by 0.64 per Pull |`);
  P("|---|---|---|---|---|---|---|---|---|");
  for (const [gate] of GATES) for (const d of [1, 2]) for (const [vname, v] of VARIANTS) {
    const a = out80.get(`${gate}|${d}|${v}|real rule, weighted`), b = out80.get(`${gate}|${d}|${v}|uniform draws only`);
    const dpp = a.hit && b.hit ? f2(b.draws / (a.r80 * RP)) : "-";
    const marg = a.hit && b.hit ? f2((b.draws - BURN) / (a.r80 * RP - BURN)) : "-";
    P(`| ${gate} | ${d} | ${vname} | ${a.hit ? a.r80 * RP : "x"} | ${b.hit ? b.r80 * RP : "x"} | ${b.hit ? b.draws : "-"} | ${dpp} | ${marg} | ${a.hit ? a.draws : "-"} |`);
  }
  P();

  // ---- 3. diagnostics: policy Cell and burn-in
  P("## 3. The draw rule the histories followed");
  P();
  {
    const hz = runsNull;
    const share1 = (recs, r) => recs.filter((x) => x.base[r - 1] === 1).length / recs.length;
    P(`Share of real-rule histories (Delta 0) whose look chose task-high as the one-Cell policy (so that slow-high is the 1/5 side), by Pulls: ${[102, 204, 340, 510, 1020, 2006].filter((p) => p <= hz * RP).map((p) => `${p}: ${pc(share1(hRule0, Math.round(p / RP)))}%`).join(", ")}. Delta ${DELTA}: ${[102, 204, 340, 510, 1020, 2006].filter((p) => p <= runsReal * RP).map((p) => `${p}: ${pc(share1(hRuleR, Math.round(p / RP)))}%`).join(", ")}.`);
    P();
    P(`The largest record judged is ${hRule0[0].n[hz - 1]} Pulls (Delta 0) and ${hRuleR[0].n[runsReal - 1]} Pulls (Delta ${DELTA}).`);
  }
  P();
  P(`Compute: ${tasks.length} histories on ${Math.min(flags.workers, tasks.length)} worker threads, ${simWall.toFixed(0)} s wall for the simulation, ${(cpuMs / 1000).toFixed(0)} s of worker time, ${((Date.now() - t0) / 1000).toFixed(0)} s in all.`);
  process.stdout.write(out.join("\n") + "\n");
}

if (isMainThread) await main(); else await workerMain();
