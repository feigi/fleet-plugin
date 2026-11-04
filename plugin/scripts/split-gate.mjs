// The split gate: whether a group of tickets should be split on what is known of a ticket at dispatch.
//
// `searchSplits` takes one group's counted Pulls, each with the inputs its ticket held at dispatch, the Cell it ran,
// what it cost and the probability the router assigned it that Cell, and answers with the best way to cut the group
// and whether the cut has earned a place. `standing` says whether it stands yet.
//
// THE SEARCH. A numeric input is cut at its 25th, 50th and 75th percentile, a `values` input on each of its values
// (the Pulls holding it against the other Pulls that hold some value) and a `presence` input on whether it is above
// zero. A Pull that lacks an input has no side of a cut on it: a blank is the input's missing value, never a value of
// its own, so no cut asks whether the input was recorded. A cut whose smaller side holds fewer than twice the
// minimum Pulls is dropped, and so is one that cuts its input as an earlier cut does. A partition is one cut, or two
// cuts on two different inputs: depth two, the most the search reaches. A Pull lacking an input of the partition is
// outside it, and the gate scores it as keeping the group's one-Cell choice. In the tree, one lacking the first cut's
// input routes by the group's own row, and one holding it but lacking the second's by the row of its side of the
// first cut, which no leaf of the partition scores.
//
// THE GAIN. Each side of a partition (a leaf, for two cuts) takes the cheapest Cell it can: one with the minimum
// merged PRs there that is not under the quality floor against the default Cell, the default Cell itself needing
// the minimum merged PRs there too. The gain of a partition is the $ per merged PR of the group's one-Cell choice
// less the $ per merged PR of the leaves' choices, each leaf weighted by its share of the group's Pulls. A partition
// that moves no leaf off the one-Cell choice gains exactly zero.
//
// THE GATE. The best partition by gain splits only if it passes both tests:
//   - the shuffled null: the same search, run on outcomes shuffled against the inputs inside each set of Pulls with
//     the same assignment probability, reaches the real gain in at most 5% of the shuffles;
//   - the off-policy bound: a doubly robust estimate of the one-Cell choice's value less the leaves' value, each
//     Pull weighted by the probability the router assigned its own Cell, has a one-sided 95% lower bound above zero.
//     The outcome model is a leaf-by-Cell mean fitted on the other folds of a five-fold split, so no Pull is
//     predicted by itself.
// Everything is a function of the Pulls and the seed: the same record and seed give the same answer.
//
// THE FIGURES ARE PLAIN. A leaf's figure for a Cell is the Cell's own $ per merged PR over the leaf's Pulls, and the
// floor is the integer cross-product over their claims, not the time-matched comparison the table's rows are judged
// by. The gate asks whether an input changes which Cell wins; the bound weighs each Pull by the probability its Cell
// was drawn with, which is what keeps a change in the draw from reading as an input's effect. The rows of a split
// that stands are judged by the time-matched comparison, as every row is.

import { TRIP_POINTS, mulberry32 } from "./pull-attribution.mjs";

/** The shuffles the null runs: with 99, at most 4 reaching the real gain is the 5% test. */
export const NULL_SHUFFLES = 99;

const ALPHA = 0.05;
const Z95 = 1.644854; // one-sided 95%
const EPS = 1e-12;
const FOLDS = 5;
const PERCENTILES = Object.freeze([0.25, 0.5, 0.75]);
// What a leaf's tally holds for one Cell, in this order: Pulls, merged PRs, $, claims, false claims.
const STRIDE = 5;
// The most leaves a partition has: two cuts, two sides each.
const MOST_LEAVES = 4;

// The value `q` of the way along `sorted`, between the two Pulls it falls between.
function quantile(sorted, q) {
  const k = (sorted.length - 1) * q;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

// Fisher-Yates over the first `length` entries of `list`, in place.
function shuffle(list, length, rand) {
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
}

/**
 * The cuts of the group's inputs that the search keeps, in search order: each `{ input, cut, side, below, above }`,
 * `side` a Pull's side of the cut, 1 above it (or holding the value), 0 the other side, -1 for a Pull lacking the
 * input, `below` and `above` the Pulls on each side. A percentile is floored: an input is a count, so a Pull is above
 * the percentile exactly when it is above the whole number under it, which is the cut a table can name.
 */
function cutsOf(pulls, inputs, minN) {
  const cuts = [];
  for (const { name, cuts: how, values } of inputs) {
    const held = pulls.map((p) => p.inputs[name] ?? null);
    const present = held.filter((v) => v !== null);
    if (present.length === 0) continue;
    let thresholds = values;
    if (how === "presence") thresholds = [0];
    else if (how === "percentiles") {
      const sorted = Float64Array.from(present).sort();
      thresholds = PERCENTILES.map((q) => Math.floor(quantile(sorted, q)));
    }
    const kept = new Set();
    for (const cut of thresholds) {
      const side = Int8Array.from(held, (v) => (v === null ? -1 : (how === "values" ? v === cut : v > cut) ? 1 : 0));
      const above = side.reduce((n, s) => n + (s === 1 ? 1 : 0), 0);
      const below = present.length - above;
      if (Math.min(above, below) < 2 * minN) continue;
      const key = Buffer.from(side.buffer, side.byteOffset, side.length).toString("latin1");
      if (kept.has(key)) continue;
      kept.add(key);
      cuts.push({ input: name, cut, side, below, above });
    }
  }
  return cuts;
}

/** Every partition of one cut, then of every pair of cuts on two different inputs, with `gid` each Pull's leaf (-1: outside). */
function partitionsOf(cuts, n) {
  const parts = cuts.map((c, i) => ({ cuts: [i], gid: c.side, leaves: 2 }));
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      if (cuts[i].input === cuts[j].input) continue;
      const gid = new Int8Array(n);
      const a = cuts[i].side;
      const b = cuts[j].side;
      for (let r = 0; r < n; r++) gid[r] = a[r] < 0 || b[r] < 0 ? -1 : a[r] * 2 + b[r];
      parts.push({ cuts: [i, j], gid, leaves: MOST_LEAVES });
    }
  }
  return parts;
}

// Each Cell's tally in each leaf of a partition, from Pulls `o` (parallel columns), into `s`: `s[(leaf * C + cell) * STRIDE + k]`.
function tallyInto(s, gid, leaves, C, o) {
  s.fill(0, 0, leaves * C * STRIDE);
  const { cell, merged, usd, claims, failed } = o;
  for (let i = 0; i < gid.length; i++) {
    const g = gid[i];
    if (g < 0) continue;
    const at = (g * C + cell[i]) * STRIDE;
    s[at] += 1;
    s[at + 1] += merged[i];
    s[at + 2] += usd[i];
    s[at + 3] += claims[i];
    s[at + 4] += failed[i];
  }
}

// Whether the Cell tallied at `at` is under the quality floor against the default Cell tallied at `base`: its fail rate
// TRIP_POINTS or more points above, compared in integers so a gap of exactly the margin reads as one.
function underFloor(s, at, base) {
  const [claims, failed, baseClaims, baseFailed] = [s[at + 3], s[at + 4], s[base + 3], s[base + 4]];
  return claims > 0 && baseClaims > 0 && (failed * baseClaims - baseFailed * claims) * 100 >= TRIP_POINTS * claims * baseClaims;
}

// The Cell leaf `g` takes: the cheapest per merged PR of those the leaf can judge, the default Cell (index 0) first and
// winning a tie. With too few merged PRs on the default Cell there is nothing to hold the floor against, so no Cell is
// judged and the leaf keeps `fallback`.
function pick(s, g, C, minN, fallback) {
  const at0 = g * C * STRIDE;
  if (s[at0 + 1] < minN) return fallback;
  let best = 0;
  let cheapest = s[at0 + 2] / s[at0 + 1];
  for (let c = 1; c < C; c++) {
    const at = at0 + c * STRIDE;
    if (s[at + 1] < minN || underFloor(s, at, at0)) continue;
    const v = s[at + 2] / s[at + 1];
    if (v < cheapest) {
      cheapest = v;
      best = c;
    }
  }
  return best;
}

// The $ per merged PR of Cell `c` in leaf `g`, or the leaf's own over every Cell where `c` merged none.
function valueOf(s, g, c, C) {
  const at = (g * C + c) * STRIDE;
  if (s[at + 1] > 0) return s[at + 2] / s[at + 1];
  let usd = 0;
  let merged = 0;
  for (let k = 0; k < C; k++) {
    usd += s[(g * C + k) * STRIDE + 2];
    merged += s[(g * C + k) * STRIDE + 1];
  }
  return merged > 0 ? usd / merged : 0;
}

// What a partition gains over every leaf taking Cell `base`: each leaf's share of the group's `n` Pulls times the
// $ per merged PR it saves.
function gainOf(s, leaves, C, n, minN, base) {
  let gain = 0;
  for (let g = 0; g < leaves; g++) {
    let pulls = 0;
    for (let c = 0; c < C; c++) pulls += s[(g * C + c) * STRIDE];
    if (pulls === 0) continue;
    const chosen = pick(s, g, C, minN, base);
    if (chosen !== base) gain += (pulls / n) * (valueOf(s, g, base, C) - valueOf(s, g, chosen, C));
  }
  return gain;
}

/**
 * How many of `shuffles` shuffles of the outcomes reach `gain` in some partition, counting only up to one past
 * `allowed`, where the answer is settled. A shuffle permutes the outcomes (Cell, $, merged, claims, false claims) among
 * the Pulls of each set in `sets`, the rows of Pulls with the same probability, against inputs that stay where they are.
 */
function shuffledReach({ parts, sets, o, C, minN, base, gain, shuffles, allowed, rand }) {
  const n = o.cell.length;
  const s = new Float64Array(MOST_LEAVES * C * STRIDE);
  const list = new Int32Array(n);
  const perm = new Int32Array(n);
  const shuf = { cell: new Int32Array(n), merged: new Float64Array(n), usd: new Float64Array(n), claims: new Float64Array(n), failed: new Float64Array(n) };
  let reached = 0;
  for (let b = 0; b < shuffles && reached <= allowed; b++) {
    for (const set of sets) {
      list.set(set);
      shuffle(list, set.length, rand);
      for (let i = 0; i < set.length; i++) perm[set[i]] = list[i];
    }
    for (let i = 0; i < n; i++) {
      const j = perm[i];
      shuf.cell[i] = o.cell[j];
      shuf.merged[i] = o.merged[j];
      shuf.usd[i] = o.usd[j];
      shuf.claims[i] = o.claims[j];
      shuf.failed[i] = o.failed[j];
    }
    for (const part of parts) {
      tallyInto(s, part.gid, part.leaves, C, shuf);
      if (gainOf(s, part.leaves, C, n, minN, base) >= gain - EPS) {
        reached++;
        break;
      }
    }
  }
  return reached;
}

/**
 * The one-sided 95% lower bound of the one-Cell choice's value less the leaves' value, per Pull, by the doubly robust
 * estimate. `picks` is each leaf's Cell; `z` a Pull's outcome; `fold` its fold; `o.prob` the probability its own Cell was
 * assigned with. A Pull outside the partition, or in a leaf that keeps `base`, adds nothing, but counts in the mean.
 */
function lowerBound({ gid, leaves }, picks, base, o, z, fold, C) {
  const n = o.cell.length;
  // The sums of $ by fold, leaf and Cell, and their totals, so a Pull's model is the mean of the other folds.
  const inFold = new Float64Array(FOLDS * leaves * C);
  const sumFold = new Float64Array(FOLDS * leaves * C);
  const inLeaf = new Float64Array(leaves * C);
  const sumLeaf = new Float64Array(leaves * C);
  const inCellFold = new Float64Array(FOLDS * C);
  const sumCellFold = new Float64Array(FOLDS * C);
  const inCell = new Float64Array(C);
  const sumCell = new Float64Array(C);
  for (let i = 0; i < n; i++) {
    const f = fold[i];
    const c = o.cell[i];
    inCellFold[f * C + c] += 1;
    sumCellFold[f * C + c] += z[i];
    inCell[c] += 1;
    sumCell[c] += z[i];
    if (gid[i] < 0) continue;
    const at = (f * leaves + gid[i]) * C + c;
    inFold[at] += 1;
    sumFold[at] += z[i];
    inLeaf[gid[i] * C + c] += 1;
    sumLeaf[gid[i] * C + c] += z[i];
  }
  // The leaf's mean for the Cell over the other folds, else the Cell's over them, else nothing known.
  const model = (i, g, c) => {
    const f = fold[i];
    const left = inLeaf[g * C + c] - inFold[(f * leaves + g) * C + c];
    if (left > 0) return (sumLeaf[g * C + c] - sumFold[(f * leaves + g) * C + c]) / left;
    const rest = inCell[c] - inCellFold[f * C + c];
    return rest > 0 ? (sumCell[c] - sumCellFold[f * C + c]) / rest : 0;
  };
  let total = 0;
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    if (g < 0 || picks[g] === base) continue;
    const chosen = picks[g];
    const own = o.cell[i];
    const [mBase, mChosen] = [model(i, g, base), model(i, g, chosen)];
    const d = (mBase + (own === base ? (z[i] - mBase) / o.prob[i] : 0)) - (mChosen + (own === chosen ? (z[i] - mChosen) / o.prob[i] : 0));
    total += d;
    squares += d * d;
  }
  const mean = total / n;
  const variance = Math.max(0, (squares - n * mean * mean) / (n - 1));
  return mean - Z95 * Math.sqrt(variance / n);
}

/**
 * Search `pulls`, one group's counted Pulls, for the best split and judge it. `pulls` are
 * `{ cell, usd, merged, claims, failed, prob, inputs }`: the Cell the Pull ran (one of `cells`), the $ it cost, whether
 * its PR merged (0 or 1), its claims and false claims, the probability (0..1] it was assigned its Cell, and its ticket's
 * inputs by name, a number, a string or null where the ticket lacks it. `cells` names the Cells to choose among, the
 * default Cell first; `inputs` the inputs to search, each `{ name, cuts }` with `cuts` `percentiles`, `presence` or
 * `values` (then listing the values); `minN` the merged PRs a Cell needs in a leaf to be chosen there.
 *
 * @returns {{
 *   scored: number, base: string|null, cuts: { input: string, cut: number|string, below: number, above: number }[],
 *   best: null | {
 *     inputs: string[], cuts: { input: string, cut: number|string }[], key: string, gain: number, picks: string[],
 *     exceeded: number, passesNull: boolean, lowerBound: number, passesBound: boolean, passes: boolean,
 *   },
 * }} `base` is the Cell the group's one-Cell choice names. `best` is null where no partition moves a leaf off it.
 * `exceeded` counts the shuffles whose best gain reached `best.gain`, stopping once there are too many for the null to
 * pass; with `shuffles` 0 none is run and `passesNull` is false, which leaves the bound and the gain. `picks` names each leaf's Cell: leaf 0 is the side at or below the cut, 1 the side above it; for two cuts leaf
 * `2a + b` is side `a` of the first and side `b` of the second.
 */
export function searchSplits({ pulls, cells, inputs, minN, shuffles = NULL_SHUFFLES, seed = 1 }) {
  const n = pulls.length;
  const C = cells.length;
  const out = { scored: n, base: null, cuts: [], best: null };
  if (C === 0) return out;
  const index = new Map(cells.map((c, i) => [c, i]));
  const o = {
    cell: new Int32Array(n), merged: new Float64Array(n), usd: new Float64Array(n),
    claims: new Float64Array(n), failed: new Float64Array(n), prob: new Float64Array(n),
  };
  pulls.forEach((p, i) => {
    const c = index.get(p.cell);
    if (c === undefined) throw new RangeError(`Pull ${i} ran ${p.cell}, which is not one of the Cells searched`);
    [o.cell[i], o.merged[i], o.usd[i], o.claims[i], o.failed[i], o.prob[i]] = [c, p.merged, p.usd, p.claims, p.failed, p.prob];
  });

  const cuts = cutsOf(pulls, inputs, minN);
  const parts = partitionsOf(cuts, n);
  const s = new Float64Array(MOST_LEAVES * C * STRIDE);
  const whole = new Int8Array(n);
  tallyInto(s, whole, 1, C, o);
  const base = pick(s, 0, C, minN, 0);
  const ratio = s[base * STRIDE + 1] > 0 ? s[base * STRIDE + 2] / s[base * STRIDE + 1] : 0;
  out.base = cells[base];
  out.cuts = cuts.map(({ input, cut, below, above }) => ({ input, cut, below, above }));

  let top = -1;
  let gain = 0;
  for (let q = 0; q < parts.length; q++) {
    tallyInto(s, parts[q].gid, parts[q].leaves, C, o);
    const g = gainOf(s, parts[q].leaves, C, n, minN, base);
    if (g > gain) [top, gain] = [q, g];
  }
  if (gain <= EPS) return out;
  const best = parts[top];

  const strata = new Map();
  for (let i = 0; i < n; i++) (strata.get(o.prob[i]) ?? strata.set(o.prob[i], []).get(o.prob[i])).push(i);
  const allowed = Math.floor(ALPHA * (shuffles + 1)) - 1;
  const exceeded = shuffledReach({
    parts, sets: [...strata.values()].map((l) => Int32Array.from(l)), o, C, minN, base, gain, shuffles, allowed, rand: mulberry32(seed),
  });
  const passesNull = exceeded <= allowed;

  // The bound's outcome is a Pull's $ less the one-Cell choice's $ per merged PR for each PR that merged, so a Pull that
  // never merged counts for what it cost. With every Pull merged that is the $ shifted, which the estimate ignores.
  const z = Float64Array.from(o.usd, (u, i) => u - ratio * o.merged[i]);
  const fold = new Int8Array(n);
  const order = Int32Array.from({ length: n }, (_, i) => i);
  shuffle(order, n, mulberry32(seed ^ 0x5bd1e995));
  for (let k = 0; k < n; k++) fold[order[k]] = k % FOLDS;
  tallyInto(s, best.gid, best.leaves, C, o);
  const picks = Array.from({ length: best.leaves }, (_, g) => pick(s, g, C, minN, base));
  const bound = lowerBound(best, picks, base, o, z, fold, C);

  const used = best.cuts.map((i) => cuts[i]);
  out.best = {
    inputs: used.map((c) => c.input),
    cuts: used.map(({ input, cut }) => ({ input, cut })),
    key: used.map((c) => c.input).join("+"),
    gain,
    picks: picks.map((c) => cells[c]),
    exceeded,
    passesNull,
    lowerBound: bound,
    passesBound: bound > 0,
    passes: passesNull && bound > 0,
  };
  return out;
}

/**
 * Where a candidate stands. `best` is `searchSplits`'s answer and `previous` the keys that passed at the last Fit that
 * computed. `passed` is the keys that pass now, to be kept for the next Fit, and `stands` those that also passed then,
 * on the same input or inputs, whatever their cuts: a split that fails at a Fit is in neither, so it merges back, and
 * one that passes on other inputs than before starts its count again.
 * @returns {{ passed: string[], stands: string[] }}
 */
export function standing({ best, previous }) {
  const passed = best !== null && best.passes ? [best.key] : [];
  return { passed, stands: passed.filter((key) => previous.includes(key)) };
}
