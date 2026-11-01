#!/usr/bin/env node
// Derivation script for issue #4151 (map #4118): the closed-form sample-size
// figures docs/research/self-refining-routing.md quotes against the scale a
// self-refining Router would run at. Zero dependencies. Node >= 18.
//
//   node docs/research/self-refining-routing-derive.mjs
//
// Inputs are constants from the ticket brief (measured 2026-11-01 at
// origin/main e5040b9a; NOT re-read from the repo here): the per-Cell
// newest-generation table and the pull counts. Every formula below is a
// textbook closed form (two-sided normal-approximation power calculation,
// Hoeffding 1963 as restated in Domingos & Hulten 2000 eq. 1, and the
// Li et al. 2011 replay-evaluator length bound); the note cites each source.
// Nothing here is a measurement of the Router.

// --- inputs (ticket brief) ------------------------------------------------
const CELLS = [
  { cell: "slow-high", n: 104, failed: 20, usdMean: 14.51, usdSd: 10.06 },
  { cell: "task-high", n: 104, failed: 28, usdMean: 10.28, usdSd: 6.16 },
  { cell: "smol-high", n: 32, failed: 18, usdMean: 11.06, usdSd: 7.04 },
];
const TOTAL_PULLS = 268; // every one carries an exploration_draw
const Z_ALPHA = 1.959964; // two-sided alpha = 0.05
const Z_BETA = 0.841621; // power = 0.80

const f = (x, d = 1) => x.toFixed(d);
const pad = (s, w) => String(s).padStart(w);

// --- 1. per-arm Pulls for 80% power ---------------------------------------
// Mean cost, relative difference d, per-arm n = (zA+zB)^2 (CV1^2+CV2^2) / d^2.
// Using the brief's slow-high and task-high CVs this lands within 2 Pulls of the
// brief's 73 (d = 0.30) and 163 (d = 0.20): 74 and 165 (the brief's own power
// calculation is not given, so the last digits are not reproduced exactly).
const cv = (c) => c.usdSd / c.usdMean;
const slow = CELLS[0];
const task = CELLS[1];
const nMean = (cv1, cv2, d) =>
  Math.ceil(((Z_ALPHA + Z_BETA) ** 2 * (cv1 ** 2 + cv2 ** 2)) / d ** 2);
// Two proportions with pooled variance: n = (zA+zB)^2 * 2 pbar (1-pbar) / delta^2.
const nProp = (p1, p2) => {
  const pbar = (p1 + p2) / 2;
  return Math.ceil(((Z_ALPHA + Z_BETA) ** 2 * 2 * pbar * (1 - pbar)) / (p1 - p2) ** 2);
};

console.log("## 1. Pulls per arm for 80% power (alpha 0.05 two-sided)");
console.log(`CV slow-high ${f(cv(slow), 3)}, task-high ${f(cv(task), 3)}; CV 0.6 both:`);
for (const d of [0.1, 0.2, 0.3, 0.5]) {
  console.log(
    `  mean $ differs by ${pad(d * 100, 3)}%: brief-CVs ${pad(nMean(cv(slow), cv(task), d), 5)}` +
      `   CV=0.6 both ${pad(nMean(0.6, 0.6, d), 5)}`,
  );
}
console.log("  (brief states 73 for 30% and 163 for 20%)");
for (const [a, b] of [[0.19, 0.29], [0.2, 0.35], [0.2, 0.55], [0.3, 0.45]]) {
  console.log(`  fail rate ${a} vs ${b}: ${pad(nProp(a, b), 5)} per arm`);
}
console.log("  (brief states 286 for 19% vs 29%)");

// --- 2. Pulls per (leaf, Cell) for a tree of depth L ----------------------
// A balanced depth-L tree has 2^L leaves; with uniform random Cell draws each
// (leaf, Cell) cell receives N / (K * 2^L) Pulls. [INFERENCE: balanced leaves
// and uniform draws are the best case.]
console.log("\n## 2. Pulls per (leaf, Cell) at N Pulls, K Cells, depth-L tree, balanced");
console.log("   N     K  L=0   L=1   L=2   L=3");
for (const N of [268, 300, 1000, 5000]) {
  for (const K of [3, 9, 15]) {
    const row = [0, 1, 2, 3].map((L) => pad(f(N / (K * 2 ** L), 1), 5)).join(" ");
    console.log(`${pad(N, 5)} ${pad(K, 3)} ${row}`);
  }
}
console.log("Pulls N needed so every (leaf, Cell) reaches 73 (30% $ effect, brief CVs):");
for (const K of [3, 9, 15]) {
  console.log(
    `  K=${pad(K, 2)}: ` +
      [0, 1, 2, 3].map((L) => `L=${L} N=${pad(73 * K * 2 ** L, 6)}`).join("  "),
  );
}

// --- 3. Hoeffding bound (Domingos & Hulten 2000, eq. 1) -------------------
// eps = sqrt(R^2 ln(1/delta) / (2 n)); a split needs Delta-G > eps, G in [0, R].
// n needed for eps <= g: n = R^2 ln(1/delta) / (2 g^2). R = 1 (a rate).
console.log("\n## 3. Hoeffding eps for a quantity of range R = 1");
const eps = (n, delta) => Math.sqrt(Math.log(1 / delta) / (2 * n));
console.log("      n   delta=1e-7   delta=0.05");
for (const n of [25, 50, 100, 200, 268, 1000, 5000]) {
  console.log(`${pad(n, 7)}   ${pad(f(eps(n, 1e-7), 3), 10)}   ${pad(f(eps(n, 0.05), 3), 10)}`);
}
const nFor = (g, delta) => Math.ceil(Math.log(1 / delta) / (2 * g ** 2));
console.log("n at one leaf to push eps <= g:");
for (const g of [0.3, 0.2, 0.15, 0.1]) {
  console.log(
    `  g=${g}: delta=1e-7 -> ${pad(nFor(g, 1e-7), 5)}   delta=0.05 -> ${pad(nFor(g, 0.05), 5)}`,
  );
}

// --- 4. Replay evaluator length (Li et al. 2011, Theorem 1) ---------------
// Uniformly random logging over K arms: the evaluator consumes L events to
// build a length-T history with E[L] = K T and L <= 2K(T + ln(1/delta)) w.p.
// 1-delta. Inverting: a log of N events yields a history of T ~ N / K.
console.log("\n## 4. Replay evaluator: history length T from N uniformly-logged Pulls");
for (const K of [3, 9, 15]) {
  console.log(
    `  K=${pad(K, 2)}: ` +
      [268, 300, 1000, 5000].map((N) => `N=${N} -> T~${f(N / K, 0)}`).join("  "),
  );
}

// --- 5. Linear-payoff bandits: coefficients per Pull ----------------------
// LinUCB with disjoint models fits K*d coefficients (Li et al. 2010 sec 3.1);
// d = recorded pre-dispatch metrics (brief: 9) + intercept.
console.log("\n## 5. Disjoint LinUCB coefficients vs Pulls (d = 9 metrics + 1)");
const d = 10;
for (const K of [3, 9, 15]) {
  console.log(
    `  K=${pad(K, 2)}: ${K * d} coefficients; Pulls per coefficient at N=` +
      [268, 300, 1000, 5000].map((N) => `${N}: ${f(N / (K * d), 1)}`).join("  "),
  );
}

// --- 6. Fit-to-fit scale of policy-tree regret ----------------------------
// Athey & Wager 2021 bound the regret at O_P(sqrt(VC(Pi)/n)); constants are not
// stated in the abstract, so only the ratio between sample sizes is derived.
console.log("\n## 6. sqrt(1/n) ratio of the policy-tree regret bound, vs n = 300");
for (const n of [268, 300, 1000, 5000]) {
  console.log(`  n=${pad(n, 5)}: ${f(Math.sqrt(300 / n), 3)} x the n=300 bound`);
}

// --- 7. policytree exact-search term --------------------------------------
// The policytree docs give the amortised runtime O(p^k n^k (log n + d) + p n log n)
// (p features, n distinct observations, d actions, k depth). Constants are not
// stated, so only the operation-count term is printed, as a ratio to the n = 268,
// d = 3, p = 9, k = 2 case.
console.log("\n## 7. policytree exact-search term p^k n^k (ln n + d), ratio to p=9,n=268,d=3,k=2");
const term = (p, n, dd, k) => p ** k * n ** k * (Math.log(n) + dd);
const base = term(9, 268, 3, 2);
for (const [n, dd, k] of [[268, 3, 2], [1000, 9, 2], [5000, 15, 2], [268, 3, 3], [1000, 9, 3]]) {
  console.log(`  n=${pad(n, 5)} d=${pad(dd, 2)} k=${k}: ${f(term(9, n, dd, k) / base, 1)}x`);
}

// --- 8. The brief's table, for reference ----------------------------------
console.log("\n## 8. Inputs (ticket brief)");
console.log(`total Pulls ${TOTAL_PULLS}`);
for (const c of CELLS) {
  console.log(
    `  ${c.cell}: n ${c.n}, failed ${c.failed} (${f((100 * c.failed) / c.n, 1)}%), ` +
      `$ mean ${c.usdMean} sd ${c.usdSd} (CV ${f(cv(c), 3)})`,
  );
}
