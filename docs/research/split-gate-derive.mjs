#!/usr/bin/env node
// Derivation script for issue #4160: when would a self-splitting grouping first
// split, and how often does it split by chance?
//
// The corpus is loaded exactly as router-inputs-derive.mjs (#4150) loads it,
// through the Router's own modules in plugin/scripts/: `attribute`,
// `generations`, `tally` (pull-attribution.mjs) over docs/metrics/*.tsv, window
// 2026-10-03, filtered as ticket-router.mjs:382-385 (`fitPulls`) does; the
// quality floor is `underFloor`, the per-group minimum n is `MIN_N`. The
// grouping-gain engine (candidate cuts, pick, value, gain) and the row-shuffle
// permutation null are router-inputs-derive.mjs's, re-implemented with typed
// arrays for speed (router-inputs' `Engine`, `candidates`, `scan`). § 1 runs
// that engine on the real record without the six free inputs; its depth-1 and
// depth-2 best gains (0.00, 0.08) are router-inputs' (§ 5.1 there), the port's
// only check against the original.
//
// node docs/research/split-gate-derive.mjs [--sims a,b,c,d,e,f,g] [--nulls B]
//     [--workers W] [--seed S] [--ref M] [--real-perms P] [--real-halves H]
//     [--ns n1,n2,...] [--deltas d1,d2,...] [--dec-sims s] [--only fam]
//   --sims    simulated records per N in the `coupled` family (one number, or one
//             per entry of --ns); default 400,400,400,300,200,100,50
//   --ns      record sizes (default 268,500,1000,2000,5000,10000,20000; the issue's
//             grid is the first five)
//   --deltas  injected effects in $ per Pull on task-high (default 0,2,4,5,6,8)
//   --nulls   shuffles per record for the G1 null (default 99, so p <= 0.05 is
//             "at most 4 of 99 shuffles reach the real best gain")
//   --workers worker threads (default 8)
//   --seed    master seed (default 20261101)
//   --ref     rows of the reference sample that scores realised gain
//             (default 200000)
//   --real-perms  shuffles for the real record's G1 null (default 1999)
//   --real-halves random train/test halves for the real record's G2h (200)
//   --dec-sims    simulated records per N in the `decoupled` and `padded` families
//             (default: same as --sims; 0 skips them)
//   --only    coupled | decoupled | padded: run one family
//   --base-sims   records per row in the one-Cell baseline diagnostic (§ 5; default 400)
//   --only-base   print §§ 0 and 5 only (no search, seconds)
// Stdout is markdown. Deterministic for a fixed seed, whatever --workers is.
// Zero dependencies beyond the repo's own modules; Node >= 18.

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
const Z95 = 1.644854; // one-sided 95%
const EPS = 1e-12;
// Simulated record families. `coupled` is the issue's design; `decoupled` draws each Pull's nine
// recorded inputs from another Pull (every decoy a true null); `padded` is `coupled` plus 4 fair-coin
// inputs, which brings the search to router-inputs' 25 cuts.
const FAMS = {
  coupled: { id: 1, base: "coupled", noise: 0, title: "Decoy inputs resampled with their Pulls (the issue's design)" },
  decoupled: { id: 2, base: "decoupled", noise: 0, title: "Decoys decoupled from outcomes (each Pull's nine inputs taken from another Pull, so every decoy is a true null)" },
  padded: { id: 3, base: "coupled", noise: 4, title: "Decoys resampled with their Pulls, plus 4 fair-coin decoys (a search as wide as router-inputs': 25 cuts)" },
};

// ------------------------------------------------------------------ small helpers
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1)); };
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

// ================================================================== data -> records
/**
 * `D` is the pool the simulation resamples: every counted newest-generation
 * slow-high (cell 0) and task-high (cell 1) Pull, with `period` 0 = A (K=3) /
 * 1 = B (K=2), `pools[period][cell]` the row indices, `pA` the share of
 * period A among them.
 */
function sample(n, rng, D, fam, K = 0) {
  const R = {
    n, cell: new Int8Array(n), usd: new Float64Array(n), claims: new Float64Array(n), failed: new Float64Array(n),
    num: NUM.map(() => new Float64Array(n)), kind: new Int8Array(n), parent: new Int8Array(n), bit: new Int8Array(n),
    noise: Array.from({ length: K }, () => new Int8Array(n)),
  };
  for (let i = 0; i < n; i++) {
    const per = rng() < D.pA ? 0 : 1, c = rng() < 0.5 ? 0 : 1; // Cell drawn uniformly, as burn-in does
    const pool = D.pools[per][c];
    const j = pool[Math.floor(rng() * pool.length)];
    // coupled: the Pull's own recorded inputs travel with it. decoupled: the inputs
    // come from another Pull drawn from the whole pool, so no input carries information about the outcome.
    const jf = fam === "coupled" ? j : Math.floor(rng() * D.nAll);
    R.cell[i] = c; R.usd[i] = D.usd[j]; R.claims[i] = D.claims[j]; R.failed[i] = D.failed[j];
    for (let k = 0; k < NUM.length; k++) R.num[k][i] = D.num[k][jf];
    R.kind[i] = D.kind[jf]; R.parent[i] = D.parent[jf];
    R.bit[i] = rng() < 0.5 ? 1 : 0; // the injected input: a fair coin, independent of everything
    for (let k = 0; k < K; k++) R.noise[k][i] = rng() < 0.5 ? 1 : 0; // padding: further fair-coin inputs, so the search is as wide as router-inputs'
  }
  return R;
}
const outcomesFor = (R, delta) => { // Delta $ per Pull added to task-high on the injected side
  const usd = new Float64Array(R.n);
  for (let i = 0; i < R.n; i++) usd[i] = R.usd[i] + (delta !== 0 && R.cell[i] === 1 && R.bit[i] === 1 ? delta : 0);
  return { cell: R.cell, usd, claims: R.claims, failed: R.failed };
};

/**
 * Candidate cuts over a record: numeric inputs at the record's 25/50/75th
 * percentiles, `kind` as one 4-way partition, `parent` by presence, and the
 * injected bit when `withInj`. A binary cut whose smaller side holds under
 * 2*minN rows is dropped; a cut identical to an earlier one of the same input
 * is dropped (router-inputs-derive.mjs `candidates`).
 */
function buildCands(R, minN, withInj) {
  const out = [];
  const add = (input, label, gid, G, spec) => {
    const counts = new Array(G).fill(0);
    for (let i = 0; i < gid.length; i++) counts[gid[i]]++;
    if (G === 2 && counts.some((c) => c < 2 * minN)) return;
    const key = Buffer.from(gid.buffer, gid.byteOffset, gid.length).toString("latin1");
    if (out.some((c) => c.input === input && c.key === key)) return;
    out.push({ input, label, G, gid, key, spec });
  };
  NUM.forEach((nm, k) => {
    const s = sortedNum(R.num[k]);
    for (const q of [0.25, 0.5, 0.75]) {
      const t = quantile(s, q);
      add(nm, `${nm} > ${t}`, Int8Array.from(R.num[k], (v) => (v > t ? 1 : 0)), 2, { t: "num", k, thr: t });
    }
  });
  add("kind", "kind", Int8Array.from(R.kind), 4, { t: "kind" });
  add("parent", "parent", Int8Array.from(R.parent), 2, { t: "parent" });
  if (withInj) add("inj", "inj", Int8Array.from(R.bit), 2, { t: "inj" });
  R.noise.forEach((col, k) => add(`noise${k + 1}`, `noise${k + 1}`, Int8Array.from(col), 2, { t: "noise", k }));
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
const partLabel = (p, cands) => (p.b < 0 ? cands[p.a].label : `${cands[p.a].label} & ${cands[p.b].label}`);
const partInputs = (p, cands) => (p.b < 0 ? [cands[p.a].input] : [cands[p.a].input, cands[p.b].input]);

// ================================================================== the gain engine
// Layout of a stats array: group g, Cell c at offset (g*2 + c)*4: [n, usd, claims, failed].
// Every counted Pull is merged (asserted in main), so $ per merged PR = $ per Pull and a
// group's share is its share of Pulls.
function partStats(gid, G, out, n, s) {
  s.fill(0, 0, G * 8);
  const { cell, usd, claims, failed } = out;
  for (let r = 0; r < n; r++) { const o = ((gid[r] << 1) + cell[r]) << 2; s[o]++; s[o + 1] += usd[r]; s[o + 2] += claims[r]; s[o + 3] += failed[r]; }
}
function partStatsIdx(gid, G, out, idx, s) {
  s.fill(0, 0, G * 8);
  const { cell, usd, claims, failed } = out;
  for (let k = 0; k < idx.length; k++) { const r = idx[k], o = ((gid[r] << 1) + cell[r]) << 2; s[o]++; s[o + 1] += usd[r]; s[o + 2] += claims[r]; s[o + 3] += failed[r]; }
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

/** Doubly robust difference (value of the base Cell everywhere minus value of `choices`), per Pull, over rows `idx` (or all rows). mu = group x Cell means from the training Pulls; propensity 1/2. */
function drDiff({ gid, G, out, rows, mu, choices, base }) {
  // mu(g, c): function giving the outcome model for the row's fold; rows: Int32Array of rows or null
  const { cell, usd } = out;
  let sd1 = 0, sd2 = 0, m = 0;
  const each = (r) => {
    m++;
    const g = gid[r], cb = choices[g];
    if (cb === base) return;
    const mA = mu(r, g, base), mB = mu(r, g, cb);
    const GA = mA + (cell[r] === base ? (usd[r] - mA) * 2 : 0), GB = mB + (cell[r] === cb ? (usd[r] - mB) * 2 : 0);
    const d = GA - GB;
    sd1 += d; sd2 += d * d;
  };
  if (rows === null) for (let r = 0; r < out.cell.length; r++) each(r); else for (let k = 0; k < rows.length; k++) each(rows[k]);
  const mn = sd1 / m, v = Math.max(0, (sd2 - m * mn * mn) / (m - 1));
  return { mean: mn, se: Math.sqrt(v / m), lcb: mn - Z95 * Math.sqrt(v / m), m };
}
const FOLDS = 5;
/** G2 on the same record the split was chosen on: the outcome model is cross-fitted over 5 random folds */
function drInSample(part, out, n, fold, choices, base) {
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
  return drDiff({ gid, G, out, rows: null, mu, choices, base });
}

/** Real-record scan: gains of every partition, best at depth 1 and at depth <= 2 */
function scanGains(parts, out, n, minN, base, gains, s) {
  for (let p = 0; p < parts.length; p++) { partStats(parts[p].gid, parts[p].G, out, n, s); gains[p] = gainOf(s, parts[p].G, n, minN, base); }
}
function argmax(gains, from, to) { let b = -1, bv = -Infinity; for (let p = from; p < to; p++) if (gains[p] > bv) { bv = gains[p]; b = p; } return b; }

/** reference-sample value of a policy: groups from the cuts' own rules, per-group Cell from `choices`; returns gain over `base` everywhere */
function refGainOf(ref, outRef, cands, part, choices, base) {
  const gidOf = (c) => {
    const g = new Int8Array(ref.n), sp = c.spec;
    if (sp.t === "num") { const col = ref.num[sp.k]; for (let i = 0; i < ref.n; i++) g[i] = col[i] > sp.thr ? 1 : 0; }
    else if (sp.t === "kind") g.set(ref.kind); else if (sp.t === "parent") g.set(ref.parent); else if (sp.t === "noise") g.set(ref.noise[sp.k]); else g.set(ref.bit);
    return g;
  };
  const ga = gidOf(cands[part.a]);
  let gid = ga;
  if (part.b >= 0) { const gb = gidOf(cands[part.b]), Gb = cands[part.b].G; gid = new Int8Array(ref.n); for (let i = 0; i < ref.n; i++) gid[i] = ga[i] * Gb + gb[i]; }
  const s = new Float64Array(part.G * 8);
  partStats(gid, part.G, outRef, ref.n, s);
  let vOne = 0, vPol = 0;
  for (let g = 0; g < part.G; g++) {
    const o = g * 8, gn = s[o] + s[o + 4];
    if (gn === 0) continue;
    const w = gn / ref.n, pooled = (s[o + 1] + s[o + 5]) / gn, ch = choices[g];
    vPol += w * (s[o + ch * 4] > 0 ? s[o + ch * 4 + 1] / s[o + ch * 4] : pooled);
    vOne += w * (s[o + base * 4] > 0 ? s[o + base * 4 + 1] / s[o + base * 4] : pooled);
  }
  return vOne - vPol;
}

/**
 * Everything one gate decision needs from one record + outcome set:
 *   real best gain at depth 1 / <= 2 and the partition; the G1 null (row shuffle
 *   of the whole outcome tuple against the inputs, `B` shuffles, the same search);
 *   G2 (cross-fitted doubly robust, same record); G2h (choose on a random half,
 *   score on the other half). `ref` (optional) scores each adopted policy.
 */
function decide({ R, cands, parts, nD1, out, minN, B, seed, ref, outRef, wantNull = true }) {
  const n = R.n, nP = parts.length;
  const s = new Float64Array(64);
  const zero = new Int8Array(n);
  partStats(zero, 1, out, n, s);
  const base = pick(s, 0, minN, 0);
  const gains = new Float64Array(nP);
  scanGains(parts, out, n, minN, base, gains, s);
  const best = [null, argmax(gains, 0, nD1), argmax(gains, 0, nP)];
  // ---- G1 null
  const nullMax = [null, new Float64Array(B), new Float64Array(B)];
  if (wantNull) {
    const rand = mulberry32(seed), p = new Int32Array(n);
    const o2 = { cell: new Int8Array(n), usd: new Float64Array(n), claims: new Float64Array(n), failed: new Float64Array(n) };
    for (let b = 0; b < B; b++) {
      shuffleInto(p, rand);
      for (let i = 0; i < n; i++) { const j = p[i]; o2.cell[i] = out.cell[j]; o2.usd[i] = out.usd[j]; o2.claims[i] = out.claims[j]; o2.failed[i] = out.failed[j]; }
      let m1 = -Infinity, m2 = -Infinity;
      for (let q = 0; q < nP; q++) {
        partStats(parts[q].gid, parts[q].G, o2, n, s);
        const g = gainOf(s, parts[q].G, n, minN, base);
        if (g > m2) m2 = g;
        if (q === nD1 - 1) m1 = m2;
      }
      nullMax[1][b] = m1; nullMax[2][b] = m2;
    }
  }
  // ---- folds for G2, halves for G2h (independent of the outcomes, so identical across Delta for one seed)
  const rf = mulberry32(seed ^ 0x5bd1e995);
  const fold = new Int8Array(n);
  { const o = shuffleInto(new Int32Array(n), rf); for (let k = 0; k < n; k++) fold[o[k]] = k % FOLDS; }
  const half = shuffleInto(new Int32Array(n), rf);
  const A = half.slice(0, n >> 1), Bt = half.slice(n >> 1);
  const sA = new Float64Array(64);
  const gainsA = new Float64Array(nP);
  { partStatsIdx(zero, 1, out, A, sA); }
  const baseA = pick(sA, 0, minN, 0);
  for (let q = 0; q < nP; q++) { partStatsIdx(parts[q].gid, parts[q].G, out, A, sA); gainsA[q] = gainOf(sA, parts[q].G, A.length, minN, baseA); }
  const bestA = [null, argmax(gainsA, 0, nD1), argmax(gainsA, 0, nP)];
  const res = { base, depth: [null, null, null] };
  for (const d of [1, 2]) {
    const q = best[d], part = parts[q], gain = gains[q];
    const r = { gain, label: partLabel(part, cands), inputs: partInputs(part, cands) };
    if (wantNull) {
      const nm = nullMax[d], ge = nm.reduce((a, x) => a + (x >= gain - EPS ? 1 : 0), 0);
      r.p = (1 + ge) / (B + 1);
      r.null95 = quantile(sortedNum(nm), 0.95);
    }
    partStats(part.gid, part.G, out, n, s);
    r.choices = choicesOf(s, part.G, minN, base);
    r.moves = gain > EPS;
    if (r.moves) { const dr = drInSample(part, out, n, fold, r.choices, base); r.lcb = dr.lcb; r.drMean = dr.mean; } else { r.lcb = -Infinity; r.drMean = 0; }
    if (ref) r.refGain = r.moves ? refGainOf(ref, outRef, cands, part, r.choices, base) : 0;
    // G2h: choose on half A, score on half B
    const qa = bestA[d], pa = parts[qa], ga = gainsA[qa];
    const h = { label: partLabel(pa, cands), inputs: partInputs(pa, cands), moves: ga > EPS };
    if (h.moves) {
      partStatsIdx(pa.gid, pa.G, out, A, sA);
      const chA = choicesOf(sA, pa.G, minN, baseA);
      const cnA = [0, 0], cuA = [0, 0];
      for (let g = 0; g < pa.G; g++) for (let c = 0; c < 2; c++) { cnA[c] += sA[g * 8 + c * 4]; cuA[c] += sA[g * 8 + c * 4 + 1]; }
      const mu = (_r, g, c) => (sA[g * 8 + c * 4] > 0 ? sA[g * 8 + c * 4 + 1] / sA[g * 8 + c * 4] : cnA[c] > 0 ? cuA[c] / cnA[c] : 0);
      const dr = drDiff({ gid: pa.gid, G: pa.G, out, rows: Bt, mu, choices: chA, base: baseA });
      h.lcb = dr.lcb; h.choices = chA; h.base = baseA;
      if (ref) h.refGain = refGainOf(ref, outRef, cands, pa, chA, baseA);
    } else { h.lcb = -Infinity; h.refGain = 0; }
    res.depth[d] = { ...r, h };
  }
  return res;
}

// ================================================================== worker side
function makeRef(D, fam, M, seed) {
  const f = FAMS[fam];
  return sample(M, mulberry32(mix(seed, 777, f.id)), D, f.base, f.noise);
}
async function workerMain() {
  const { D, opts } = workerData;
  const refs = new Map();
  const plan = { coupled: opts.deltasCoupled, decoupled: opts.deltasDecoupled, padded: opts.deltasDecoupled };
  parentPort.on("message", (task) => {
    if (task === null) { process.exit(0); }
    const { fam, N, sim } = task;
    const rng = mulberry32(mix(opts.seed, FAMS[fam].id, N, sim));
    const R = sample(N, rng, D, FAMS[fam].base, FAMS[fam].noise);
    const cands = buildCands(R, opts.minN, true);
    const { parts, nD1 } = buildParts(cands, N);
    if (!refs.has(fam)) refs.set(fam, makeRef(D, fam, opts.refM, opts.seed));
    const ref = refs.get(fam);
    const out = { nCands: cands.length, nParts: parts.length, nCandsDecoy: cands.filter((c) => c.input !== "inj").length, rows: [] };
    for (const delta of plan[fam]) {
      const o = outcomesFor(R, delta), oRef = outcomesFor(ref, delta);
      const res = decide({ R, cands, parts, nD1, out: o, minN: opts.minN, B: opts.nulls, seed: mix(opts.seed, 99, N, sim), ref, outRef: oRef });
      out.rows.push({ delta, base: res.base, d1: res.depth[1], d2: res.depth[2] });
    }
    parentPort.postMessage({ task, out });
  });
}

// ================================================================== main side
async function main() {
  const argv = process.argv.slice(2);
  const flags = { sims: [400, 400, 400, 300, 200, 100, 50], ns: [268, 500, 1000, 2000, 5000, 10000, 20000], deltas: [0, 2, 4, 5, 6, 8], nulls: 99, workers: 8, seed: 20261101, ref: 200000, realPerms: 1999, realHalves: 200, decSims: null, only: null, baseSims: 400, onlyBase: false };
  const die = (m) => { process.stderr.write(`split-gate-derive: ${m}\n`); process.exit(1); };
  const list = (v) => v.split(",").map(Number);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => (i + 1 < argv.length ? argv[++i] : die(`${a} needs a value`));
    if (a === "--sims") flags.sims = list(v());
    else if (a === "--ns") flags.ns = list(v());
    else if (a === "--deltas") flags.deltas = list(v());
    else if (a === "--nulls") flags.nulls = Number(v());
    else if (a === "--workers") flags.workers = Number(v());
    else if (a === "--seed") flags.seed = Number(v());
    else if (a === "--ref") flags.ref = Number(v());
    else if (a === "--real-perms") flags.realPerms = Number(v());
    else if (a === "--real-halves") flags.realHalves = Number(v());
    else if (a === "--dec-sims") flags.decSims = list(v());
    else if (a === "--only") flags.only = v();
    else if (a === "--base-sims") flags.baseSims = Number(v());
    else if (a === "--only-base") flags.onlyBase = true;
    else die(`unknown flag ${a}`);
  }
  if (flags.sims.length === 1) flags.sims = flags.ns.map(() => flags.sims[0]);
  if (flags.sims.length !== flags.ns.length) die("--sims needs one entry or one per --ns entry");
  if (flags.decSims === null) flags.decSims = flags.sims; else if (flags.decSims.length === 1) flags.decSims = flags.ns.map(() => flags.decSims[0]);
  if (!(flags.nulls >= 19)) die("--nulls must be at least 19");
  const simsOf = (fam, ni) => (fam === "coupled" ? flags.sims[ni] : flags.decSims[ni]);

  const { attribute, generations, tally, parseFeatures } = await import(`${S}/pull-attribution.mjs`);
  const { parseTsv } = await import(`${S}/member-outcomes.mjs`);
  const { parseTierOutcomes } = await import(`${S}/tier-outcomes.mjs`);
  const { ruleStratum, MIN_N } = await import(`${S}/ticket-router.mjs`);
  const { spawnSync } = await import("node:child_process");

  const out = [];
  const P = (s = "") => out.push(s);
  const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(1));
  const f2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(2));
  const pc = (x) => (100 * x).toFixed(0);
  const t0 = Date.now();

  // ---------------------------------------------------------------- corpus, as router-inputs-derive.mjs loads it
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
  const CELLS = ["slow-high", "task-high", "smol-high"];
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

  P("# split-gate derive output");
  P();
  P(`Repository HEAD ${gitHead}; window start ${WINDOW}; ${all.length} Pulls in the window, ${units.length} in the Fit's set (ticket-router.mjs:382-385); ${allRows.length} counted newest-generation Pulls, of which ${pairRows.length} slow-high or task-high (slow-high ${nOf("slow-high")}, task-high ${nOf("task-high")}); MIN_N ${MIN_N}, TRIP_POINTS ${TRIP_POINTS}; seed ${flags.seed}.`);
  P(`Settings: sims per N ${flags.ns.map((n, i) => `${n}:${flags.sims[i]}`).join(" ")}; decoupled-decoy sims ${flags.ns.map((n, i) => `${n}:${flags.decSims[i]}`).join(" ")}; G1 shuffles per record ${flags.nulls}; reference sample ${flags.ref} Pulls; workers ${flags.workers}; deltas ${flags.deltas.join(",")}.`);
  P();

  // ---------------------------------------------------------------- 0. the pool
  P("## 0. The pool the simulation resamples");
  P();
  P("Counted newest-generation slow-high and task-high Pulls, by draw-set period (A: K=3, B: K=2; the period is each Pull's recorded K). $ = $/Pull (= $/merged PR: all merged); fail = falseClaims/claims.");
  P();
  P("| period | Cell | n | $/Pull mean (sd) | failed/claims |");
  P("|---|---|---|---|---|");
  for (const [name, K] of [["A (K=3)", 3], ["B (K=2)", 2]]) for (const c of ["slow-high", "task-high"]) {
    const rs = pairRows.filter((r) => r.K === K && r.cell === c);
    P(`| ${name} | ${c} | ${rs.length} | ${f2(mean(rs.map((r) => r.usd)))} (${f2(sd(rs.map((r) => r.usd)))}) | ${sum(rs.map((r) => r.failed))}/${sum(rs.map((r) => r.claims))} |`);
  }
  const pooledMean = (c) => mean(pairRows.filter((r) => r.cell === c).map((r) => r.usd));
  const popMean = (c) => { let m = 0; for (let per = 0; per < 2; per++) { const pool = D.pools[per][c === "slow-high" ? 0 : 1]; m += (per === 0 ? D.pA : 1 - D.pA) * mean([...pool].map((i) => D.usd[i])); } return m; };
  P();
  P(`Pooled over both periods (the pairs' Pull mean): slow-high ${f2(pooledMean("slow-high"))}, task-high ${f2(pooledMean("task-high"))}, gap task-high - slow-high ${f2(pooledMean("task-high") - pooledMean("slow-high"))}. Simulated population (period A share ${f2(D.pA)}, each Cell drawn at 1/2, Pull resampled within period and Cell): slow-high ${f2(popMean("slow-high"))}, task-high ${f2(popMean("task-high"))}, gap ${f2(popMean("task-high") - popMean("slow-high"))} (router-inputs reports a pooled gap of -4.23).`);
  P(`Per-Pull $ sd / mean: slow-high ${f2(sd(pairRows.filter((r) => r.cell === "slow-high").map((r) => r.usd)) / pooledMean("slow-high"))}, task-high ${f2(sd(pairRows.filter((r) => r.cell === "task-high").map((r) => r.usd)) / pooledMean("task-high"))} (coefficient of variation).`);

  // ---------------------------------------------------------------- 5. the one-Cell baseline (cheap; printed last, or alone with --only-base)
  const baseDiag = () => {
    P();
    P("## 5. The one-Cell baseline, by N and Delta");
    P();
    P(`${flags.baseSims} fresh records per row from the coupled design; no search, one group. \`cost\` = share in which task-high's in-sample $/Pull is below slow-high's; \`floor\` = share in which task-high is under the quality floor against slow-high (underFloor, ${TRIP_POINTS} points) with both Cells at >= ${MIN_N} Pulls; \`one-Cell = slow-high\` = share whose one-group choice is slow-high (slow-high is also the choice when neither Cell qualifies). The realised gain in § 3 is scored against this one-Cell choice.`);
    P();
    P("| N | Delta | task-high cheaper in-sample % | task-high under the floor % | one-Cell = slow-high % |");
    P("|---|---|---|---|---|");
    for (const N of flags.ns) for (const delta of flags.deltas) {
      let cheaper = 0, floor = 0, slow = 0;
      for (let i = 0; i < flags.baseSims; i++) {
        const R = sample(N, mulberry32(mix(flags.seed, 31337, N, i)), D, "coupled", 0), o = outcomesFor(R, delta), s = new Float64Array(8);
        partStats(new Int8Array(N), 1, o, N, s);
        if (s[0] > 0 && s[4] > 0 && s[5] / s[4] < s[1] / s[0]) cheaper++;
        if (s[0] >= MIN_N && s[4] >= MIN_N && underFloor({ failed: s[7], claims: s[6] }, { failed: s[3], claims: s[2] })) floor++;
        if (pick(s, 0, MIN_N, 0) === 0) slow++;
      }
      P(`| ${N} | ${delta} | ${pc(cheaper / flags.baseSims)} | ${pc(floor / flags.baseSims)} | ${pc(slow / flags.baseSims)} |`);
    }
  };
  if (flags.onlyBase) { baseDiag(); process.stdout.write(out.join("\n") + "\n"); return; }

  // ---------------------------------------------------------------- the real record
  P();
  P("## 1. The real record");
  P();
  {
    // build a real-record R in the sample() layout
    const n = pairRows.length;
    const R = { n, cell: Int8Array.from(pairRows, (r) => (r.cell === "task-high" ? 1 : 0)), usd: D.usd, claims: D.claims, failed: D.failed, num: D.num, kind: D.kind, parent: D.parent, bit: new Int8Array(n), noise: [] };
    const cands = buildCands(R, MIN_N, false);
    const { parts, nD1 } = buildParts(cands, n);
    const o = { cell: R.cell, usd: R.usd, claims: R.claims, failed: R.failed };
    P(`${n} Pulls (slow-high ${nOf("slow-high")}, task-high ${nOf("task-high")}); no injected input; ${cands.length} candidate cuts over ${new Set(cands.map((c) => c.input)).size} of the nine recorded inputs (router-inputs, with six free inputs added: 25 cuts over 15 inputs), ${nD1} one-cut and ${parts.length - nD1} two-cut partitions. The router-inputs gain engine, $ per merged PR, minN ${MIN_N}.`);
    const res = decide({ R, cands, parts, nD1, out: o, minN: MIN_N, B: flags.realPerms, seed: mix(flags.seed, 4242), ref: null, outRef: null });
    P();
    P(`G1 null: ${flags.realPerms} shuffles of the whole outcome tuple against the inputs, the same search. G2: cross-fitted doubly robust difference (5 folds, propensity 1/2), one-sided 95% lower bound. G2h: the split is chosen on a random half and scored on the other half; the row below is the share of ${flags.realHalves} random halves that pass.`);
    P();
    P("| depth | best split | in-sample gain $/merged | null 95th pct | G1 p | G2 DR gain [LCB] | G1 | G2 | G3 |");
    P("|---|---|---|---|---|---|---|---|---|");
    for (const d of [1, 2]) {
      const r = res.depth[d];
      const g1 = r.moves && r.p <= 0.05, g2 = r.moves && r.lcb > 0;
      P(`| ${d} | ${r.moves ? r.label : "(none moves a group)"} | ${f2(r.gain)} | ${f2(r.null95)} | ${r.p.toFixed(3)} | ${f2(r.drMean)} [${r.lcb === -Infinity ? "-" : f2(r.lcb)}] | ${g1 ? "split" : "no"} | ${g2 ? "split" : "no"} | ${g1 && g2 ? "split" : "no"} |`);
    }
    // G2h over many halves
    const pass = { 1: 0, 2: 0 };
    const labels = { 1: new Map(), 2: new Map() };
    for (let h = 0; h < flags.realHalves; h++) {
      const rr = decide({ R, cands, parts, nD1, out: o, minN: MIN_N, B: 1, seed: mix(flags.seed, 5151, h), ref: null, outRef: null, wantNull: false });
      for (const d of [1, 2]) { const x = rr.depth[d].h; if (x.moves && x.lcb > 0) pass[d]++; }
    }
    P();
    P(`G2h over ${flags.realHalves} random train/test halves: depth 1 passes ${pass[1]}, depth 2 passes ${pass[2]}.`);
    P();
    P(`Baseline Cell (one group, lowest $ clearing the floor): ${CELLS[res.base]}.`);
    // the Router's own router-inputs check: best gain and null 95th pct re-derived from the same engine, row null
    P(`(Cross-check against router-inputs § 5.1, whose search also had six free inputs: depth-1 best $ gain 0.00, null 95th pct 0.22; depth-2 best 0.08, 0.60.)`);
  }

  // ---------------------------------------------------------------- simulation
  const deltasCoupled = flags.deltas, deltasDecoupled = flags.deltas.filter((d) => d === 0 || d === 6);
  const opts = { seed: flags.seed, minN: MIN_N, nulls: flags.nulls, refM: flags.ref, deltasCoupled, deltasDecoupled };
  const tasks = [];
  const fams = flags.only ? [flags.only] : ["coupled", "decoupled", "padded"];
  for (const fam of fams) flags.ns.forEach((N, ni) => { const k = simsOf(fam, ni); for (let sim = 0; sim < k; sim++) tasks.push({ fam, N, sim }); });
  tasks.sort((a, b) => b.N - a.N || a.sim - b.sim || (a.fam < b.fam ? -1 : 1));
  const results = new Map();
  await new Promise((resolve) => {
    let next = 0, running = 0, done = 0;
    const nW = Math.min(flags.workers, tasks.length);
    if (tasks.length === 0) return resolve();
    for (let w = 0; w < nW; w++) {
      const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { D, opts }, execArgv: [] });
      const feed = () => { if (next < tasks.length) { running++; wk.postMessage(tasks[next++]); } else wk.postMessage(null); };
      wk.on("message", ({ task, out: o }) => {
        results.set(`${task.fam}|${task.N}|${task.sim}`, o); running--; done++;
        if (done % 50 === 0) process.stderr.write(`split-gate-derive: ${done}/${tasks.length} records, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
        feed();
        if (done === tasks.length) resolve();
      });
      wk.on("error", (e) => { process.stderr.write(`worker error: ${e.stack}\n`); process.exit(1); });
      feed();
    }
  });
  const simWall = (Date.now() - t0) / 1000;

  // ---------------------------------------------------------------- aggregate
  const GATES = [
    ["G1", (r) => r.moves && r.p <= 0.05, (r) => r],
    ["G2", (r) => r.moves && r.lcb > 0, (r) => r],
    ["G3", (r) => r.moves && r.p <= 0.05 && r.lcb > 0, (r) => r],
    ["G2h", (r) => r.h.moves && r.h.lcb > 0, (r) => r.h],
  ];
  const cell = (fam, N, delta, depth, gate) => {
    const [, passes, adopted] = GATES.find((g) => g[0] === gate);
    const recs = [];
    flags.ns.forEach((n, ni) => { if (n !== N) return; const k = simsOf(fam, ni); for (let s = 0; s < k; s++) { const o = results.get(`${fam}|${N}|${s}`); const row = o.rows.find((x) => x.delta === delta); if (row) recs.push(row[`d${depth}`]); } });
    if (!recs.length) return null;
    let inj = 0, dec = 0, any = 0, decOnly = 0; const gains = [];
    for (const r of recs) {
      const ok = passes(r);
      const a = adopted(r);
      const ui = a.inputs.includes("inj"), ud = a.inputs.some((x) => x !== "inj");
      if (ok) { any++; if (ui) inj++; if (ud) dec++; if (ud && !ui) decOnly++; }
      gains.push(ok ? a.refGain : 0);
    }
    const n = recs.length;
    return {
      n, inj, dec, any, decOnly, injR: wilson(inj, n), decR: wilson(dec, n), anyR: wilson(any, n), decOnlyR: wilson(decOnly, n),
      gain: mean(gains), gainSe: n > 1 ? sd(gains) / Math.sqrt(n) : NaN,
      bestGain: mean(recs.map((r) => r.gain)), null95: recs[0].null95 === undefined ? NaN : mean(recs.map((r) => r.null95)),
    };
  };

  // ---------------------------------------------------------------- 2. the oracle
  P();
  P("## 2. What the injected effect is worth");
  P();
  {
    // oracle on the reference sample: split by the injected bit, each side its cheaper Cell, against the best single Cell
    const ref = makeRef(D, "coupled", flags.ref, flags.seed);
    P(`Reference sample ${flags.ref} Pulls drawn like the records (coupled decoys). Per side of the injected bit: task-high - slow-high $ gap; one-Cell choice; best-split gain over it (the gain an unlimited-data split on the injected bit would realise, $ per merged PR, groups weighted by Pull share).`);
    P();
    P("| Delta | gap bit=0 | gap bit=1 | one-Cell choice | split picks (bit=0 / bit=1) | oracle gain $ | % of one-Cell value |");
    P("|---|---|---|---|---|---|---|");
    for (const delta of flags.deltas) {
      const o = outcomesFor(ref, delta);
      const st = new Float64Array(2 * 8);
      partStats(ref.bit, 2, o, ref.n, st);
      const gapOf = (g) => st[g * 8 + 4 + 1] / st[g * 8 + 4] - st[g * 8 + 1] / st[g * 8];
      const one = new Float64Array(8); partStats(new Int8Array(ref.n), 1, o, ref.n, one);
      const base = one[1] / one[0] <= one[5] / one[4] ? 0 : 1;
      const ch = [gapOf(0) < 0 ? 1 : 0, gapOf(1) < 0 ? 1 : 0];
      const cand = { spec: { t: "inj" }, input: "inj", G: 2 };
      const og = refGainOf(ref, o, [cand], { a: 0, b: -1, G: 2 }, ch, base);
      const vOne = (one[base * 4 + 1] / one[base * 4]);
      P(`| ${delta} | ${f2(gapOf(0))} | ${f2(gapOf(1))} | ${CELLS[base]} | ${CELLS[ch[0]]} / ${CELLS[ch[1]]} | ${f2(og)} | ${(100 * og / vOne).toFixed(1)}% |`);
    }
    P();
    P("Slow-high is the cheapest Cell on the injected side once Delta exceeds the pooled gap (about 4.2). Below it the split changes no group's Cell, so its true gain is 0 and a split on it is a chance split that buys nothing.");
  }

  // ---------------------------------------------------------------- 3. simulation tables
  P();
  P("## 3. Detection and false-split tables");
  P();
  const sizeOf = (fam) => { const rs = [...results].filter(([k]) => k.startsWith(`${fam}|`)).map(([, o]) => o); return rs.length ? `${f1(mean(rs.map((o) => o.nCands)))} cuts (${f1(mean(rs.map((o) => o.nCandsDecoy)))} on the nine recorded inputs and the coins) and ${f1(mean(rs.map((o) => o.nParts)))} partitions` : null; };
  P(`Records built as in the issue: N Pulls, each period drawn at its real share, Cell drawn 1/2 per Pull, the Pull resampled with replacement within that period and Cell (its $, minutes, failed and its nine recorded inputs stay together). A fair-coin injected input is added; on its side 1 each task-high Pull's $ rises by Delta. Search size per record, mean: ${fams.map((f) => `${f}: ${sizeOf(f)}`).join("; ")}; router-inputs' search was 25 cuts over 15 inputs. G1: p = (1 + #shuffles whose best gain >= the real best)/(${flags.nulls} + 1) <= 0.05 (the real best beats the 95th percentile of the same search on shuffled inputs). G2: one-sided 95% lower bound of the cross-fitted doubly robust difference (one Cell minus the split) > 0, estimated on the record the split was chosen on. G3: G1 and G2. G2h: as G2, but the split is chosen on a random half and scored on the other.`);
  P();
  P("Columns: `inj` = share of simulated records whose adopted split uses the injected input; `decoy` = share whose adopted split uses at least one recorded (decoy) input; `any` = share that split at all; `decoy-only` = split on decoys and not on the injected input; `gain` = mean realised gain in $ per merged PR (± 1 s.e.) of the adopted policy over the record's one-Cell choice, scored on the reference sample, 0 when no split; ranges are 95% Wilson ranges. `best` = mean in-sample best gain; `null95` = mean G1 null 95th percentile (depth <= d).");
  const fmtP = (k, n, r) => `${pc(k / n)} [${pc(r[0])}-${pc(r[1])}]`;
  for (const fam of fams) {
    P();
    P(`### 3.${fams.indexOf(fam) + 1} ${FAMS[fam].title}`);
    const deltas = fam === "coupled" ? deltasCoupled : deltasDecoupled;
    for (const depth of [1, 2]) for (const [gate] of GATES) {
      P();
      P(`**${gate}, depth ${depth}**`);
      P();
      P("| N | Delta | sims | inj % [range] | decoy % [range] | any % | decoy-only % | gain $ (s.e.) | best | null95 |");
      P("|---|---|---|---|---|---|---|---|---|---|");
      for (const N of flags.ns) for (const delta of deltas) {
        const c = cell(fam, N, delta, depth, gate);
        if (!c) continue;
        P(`| ${N} | ${delta} | ${c.n} | ${fmtP(c.inj, c.n, c.injR)} | ${fmtP(c.dec, c.n, c.decR)} | ${pc(c.any / c.n)} | ${pc(c.decOnly / c.n)} | ${f2(c.gain)} (${f2(c.gainSe)}) | ${f2(c.bestGain)} | ${f2(c.null95)} |`);
      }
    }
  }

  // ---------------------------------------------------------------- 4. weeks
  P();
  P("## 4. Pulls and weeks to the first real split");
  P();
  {
    const B = 102; // consumer-burn-in: stage-1 burn-in ends at a boundary of 102 Pulls (median)
    const pullsFor = (N) => (N <= B ? N : B + (N - B) * 5);
    P(`For each gate and depth, the smallest simulated N at which the gate splits on the injected input in at least 80% of records (point estimate; whether the Wilson lower end also reaches 80% is shown), and the N at which 80% is crossed when the P(inj) points are joined by straight lines on log N ([INFERENCE]: the curve between grid points is not simulated). N counts random-draw Pulls. Assumption: all Pulls are random draws until burn-in ends (taken at ${B} Pulls, consumer-burn-in's stage-1 boundary median; [INFERENCE] its 3-Cell draws are counted as 2-Cell draws), then 1 Pull in 5 is (ticket-router.mjs:72, EXPLORE_EVERY), so Pulls needed = N for N <= ${B}, else ${B} + 5 (N - ${B}); weeks = Pulls / (10, 30, 90 a week). The last two columns are the grid N's weeks at 30 a week if every Pull were at 1 in 5 (5 N) or all were random draws (N).`);
    P();
    P("| design | Delta | gate | depth | P(inj) % by N | grid N at >= 80% | Wilson low >= 80%? | Pulls | weeks @10 | @30 | @90 | interpolated N | Pulls | weeks @10 | @30 | @90 | @30, 5 N | @30, N |");
    P("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const wkf = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
    for (const fam of fams) for (const delta of (fam === "coupled" ? deltasCoupled : deltasDecoupled).filter((d) => d >= 5)) for (const [gate] of GATES) for (const depth of [1, 2]) {
      const pts = flags.ns.map((N) => { const c = cell(fam, N, delta, depth, gate); return c ? { N, p: c.inj / c.n, lo: c.injR[0] } : null; }).filter(Boolean);
      const byN = pts.map((x) => `${x.N}:${pc(x.p)}`).join(" ");
      const hit = pts.find((x) => x.p >= 0.8);
      let interp = null;
      for (let i = 1; i < pts.length; i++) if (pts[i - 1].p < 0.8 && pts[i].p >= 0.8) { const a = pts[i - 1], b = pts[i], t = (0.8 - a.p) / (b.p - a.p); interp = Math.exp(Math.log(a.N) + t * (Math.log(b.N) - Math.log(a.N))); break; }
      if (pts.length && pts[0].p >= 0.8) interp = pts[0].N;
      if (!hit) { P(`| ${fam} | ${delta} | ${gate} | ${depth} | ${byN} | not reached by ${pts.at(-1)?.N} | - | - | - | - | - | - | - | - | - | - | - | - |`); continue; }
      const Nn = hit.N, pu = pullsFor(Nn), Ni = interp === null ? null : Math.round(interp), pi = Ni === null ? null : pullsFor(Ni);
      P(`| ${fam} | ${delta} | ${gate} | ${depth} | ${byN} | ${Nn} | ${hit.lo >= 0.8 ? "yes" : "no"} | ${pu} | ${wkf(pu / 10)} | ${wkf(pu / 30)} | ${wkf(pu / 90)} | ${Ni ?? "-"} | ${pi ?? "-"} | ${pi === null ? "-" : wkf(pi / 10)} | ${pi === null ? "-" : wkf(pi / 30)} | ${pi === null ? "-" : wkf(pi / 90)} | ${wkf((5 * Nn) / 30)} | ${wkf(Nn / 30)} |`);
    }
  }

  baseDiag();
  P();
  P(`Compute: ${tasks.length} simulated records on ${Math.min(flags.workers, tasks.length)} worker threads, ${simWall.toFixed(0)} s wall for the simulation, ${((Date.now() - t0) / 1000).toFixed(0)} s in all.`);
  process.stdout.write(out.join("\n") + "\n");
}

if (isMainThread) await main(); else await workerMain();
