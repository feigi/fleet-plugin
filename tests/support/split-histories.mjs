// Seeded histories for the split gate: a repository's Pulls grown run by run, the gate run at every run boundary on the
// Pulls grown so far, as the Fit runs it at every phase 0.
//
// The population is this repository's own: the 208 counted slow-high and task-high Pulls of its first 268
// (tests/fixtures/split-gate-pool.json: Cell, draw-set period, $, claims, false claims and the nine inputs recorded at
// dispatch). A history draws each Pull's period at its real share and its Cell, then a Pull of that period and Cell with
// its $ and claims; its nine inputs come from another Pull drawn from the whole pool, so none of them tells anything of
// the outcome. One more input is a fair coin, independent of everything: with `delta` 0 no input matters, and with `delta`
// $ it is added to each task-high Pull's $ where the coin is 1 — a flip that makes slow-high the cheaper Cell on that side.
//
// The first `burnIn` Pulls draw each Cell at 1 in 2; after that each draws the policy Cell at 4 in 5 and the other at 1 in 5,
// the policy being the Cell the last run's one-Cell choice named. Each Pull records the probability its Cell was drawn with.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { mulberry32 } from "../../plugin/scripts/pull-attribution.mjs";
import { searchSplits, standing } from "../../plugin/scripts/split-gate.mjs";

export const POOL = JSON.parse(readFileSync(new URL("../fixtures/split-gate-pool.json", import.meta.url), "utf8"));
const COL = Object.fromEntries(POOL.columns.map((c, i) => [c, i]));
const NUMERIC = ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs"];
const CELLS = ["slow-high", "task-high"];
const MIN_N = 20;
const INPUTS = [
  ...NUMERIC.map((name) => ({ name, cuts: "percentiles" })),
  { name: "kind", cuts: "values", values: ["bug", "enhancement", "documentation"] },
  { name: "parent", cuts: "presence" },
  { name: "coin", cuts: "presence" },
];

/** The 32-bit hash the histories derive each seed with. */
const mix = (...xs) => {
  let h = 2166136261;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 16777619);
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
  }
  return h >>> 0;
};

// The pool's Pulls by draw-set period and Cell, and the share of period 0.
const byPeriodCell = [0, 1].map((period) => [0, 1].map((cell) => POOL.rows.flatMap((r, i) => (r[COL.period] === period && r[COL.cell] === cell ? [i] : []))));
const periodZero = POOL.rows.filter((r) => r[COL.period] === 0).length / POOL.rows.length;

/**
 * One history of `runs` runs of `runPulls` Pulls, the gate run after each: per run `{ pulls, passed, stands }`, the Pulls so
 * far, the key of the split that passes both tests there (or null) and the key of the split that stands there (or null).
 * `h` numbers the history, so each draws its own Pulls; the same `seed` and `h` draw the same. With `stop` "real" the
 * history ends at the first run the split on the coin stands, with "stand" at the first split that stands.
 */
export function history({ delta, h, runs, seed = 20261101, runPulls = 17, burnIn = 102, shuffles = 99, stop = null }) {
  const rng = mulberry32(mix(seed, 1, delta, h));
  const pulls = [];
  const looks = [];
  let policy = 0;
  let previous = [];
  for (let run = 1; run <= runs; run++) {
    while (pulls.length < run * runPulls) {
      const uniform = pulls.length < burnIn;
      const period = rng() < periodZero ? 0 : 1;
      const cell = rng() < (uniform ? 0.5 : policy === 0 ? 0.8 : 0.2) ? 0 : 1;
      const from = byPeriodCell[period][cell];
      const row = POOL.rows[from[Math.floor(rng() * from.length)]];
      const other = POOL.rows[Math.floor(rng() * POOL.rows.length)];
      const coin = rng() < 0.5 ? 1 : 0;
      pulls.push({
        cell: CELLS[cell], usd: row[COL.usd] + (delta !== 0 && cell === 1 && coin === 1 ? delta : 0), merged: 1, claims: row[COL.claims], failed: row[COL.failed],
        prob: uniform ? 1 / 2 : cell === policy ? 4 / 5 : 1 / 5,
        inputs: {
          ...Object.fromEntries(NUMERIC.map((name) => [name, other[COL[name]]])),
          kind: POOL.kinds[other[COL.kind]] || null, parent: other[COL.parent] === 1 ? 3177 : 0, coin,
        },
      });
    }
    // The bound is cheap and the null is not: a split the bound refuses fails whatever the null says, so the shuffles are
    // run only for one it passes. The verdict is the gate's all the same.
    const look = { pulls, cells: CELLS, inputs: INPUTS, minN: MIN_N, seed: mix(seed, 99, 1, delta, h, run) };
    const bounded = searchSplits({ ...look, shuffles: 0 });
    const found = bounded.best !== null && bounded.best.passesBound ? searchSplits({ ...look, shuffles }) : bounded;
    const { passed, stands } = standing({ best: found.best, previous });
    previous = passed;
    looks.push({ pulls: pulls.length, passed: passed[0] ?? null, stands: stands[0] ?? null });
    policy = CELLS.indexOf(found.base);
    if (stop === "stand" && stands.length > 0) break;
    if (stop === "real" && stands.some((key) => key.split("+").includes("coin"))) break;
  }
  return looks;
}

/** The first run, 1-based, at which a history's split on the coin stands, the real one; Infinity if it never does. */
const firstReal = (looks) => {
  const i = looks.findIndex((l) => l.stands !== null && l.stands.split("+").includes("coin"));
  return i < 0 ? Infinity : i + 1;
};

/**
 * What a history comes to: `first`, the run the split on the coin first stands (Infinity if never); `ever`, whether any split
 * stood at some run; `final`, whether one stands at the last run; `deepest`, the most inputs any split that passed or stood read.
 */
export function summarize(looks) {
  return {
    first: firstReal(looks),
    ever: looks.some((l) => l.stands !== null),
    final: looks.at(-1).stands !== null,
    deepest: Math.max(0, ...looks.flatMap((l) => [l.passed, l.stands]).filter((key) => key !== null).map((key) => key.split("+").length)),
  };
}

/**
 * `count` histories, the numbers 0 .. count - 1, run on worker threads: their summaries in history order, whatever
 * order the threads finish in. Each history is its own seeded draw, so the answer is the same on one thread or many.
 */
export async function histories({ delta, runs, count, stop = null }) {
  const workers = Math.max(1, Math.min(6, availableParallelism() - 1, count));
  const per = Math.ceil(count / workers);
  const parts = await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const from = w * per;
    const to = Math.min(count, from + per);
    if (from >= to) return resolve([]);
    const worker = new Worker(new URL("./split-histories-worker.mjs", import.meta.url), { workerData: { delta, runs, from, to, stop }, execArgv: [] });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`a history worker exited ${code}`)); });
  })));
  return parts.flat();
}

/** The smallest run by which `share` of the histories' first-real-split runs have come (Infinity if they never do). */
export function runForShare(firsts, share = 0.8) {
  const sorted = [...firsts].sort((a, b) => a - b);
  return sorted[Math.ceil(share * sorted.length) - 1];
}

/** The 95% Wilson score range of `k` of `n`, as fractions. */
export function wilson(k, n, z = 1.959964) {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - half) / d), Math.min(1, (c + half) / d)];
}
