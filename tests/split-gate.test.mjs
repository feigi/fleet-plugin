// The split gate (plugin/scripts/split-gate.mjs): the search over a group's recorded inputs, the two tests a split
// must pass and the two-Fit standing, on small Pulls whose figures are worked by hand. The gate's rates over
// many seeded histories are in split-gate-flip.test.mjs and split-gate-chance.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCells, mulberry32 } from "../plugin/scripts/pull-attribution.mjs";
import { NULL_SHUFFLES, searchSplits, standing } from "../plugin/scripts/split-gate.mjs";

const MIN_N = 20;
const CELLS = ["slow-high", "task-high"];
const INPUTS = [
  { name: "criteria", cuts: "percentiles" },
  { name: "paths", cuts: "percentiles" },
  { name: "kind", cuts: "values", values: ["bug", "enhancement", "documentation"] },
  { name: "parent", cuts: "presence" },
];
// A Pull of `cell` that cost `usd` and merged, assigned its Cell with probability 1/2; `held` its ticket's inputs, where
// one left out is one the ticket lacks.
const pull = (cell, usd, held = {}, over = {}) => ({
  cell, usd, merged: 1, claims: 1, failed: 0, prob: 0.5,
  inputs: { criteria: null, paths: null, kind: null, parent: null, ...held }, ...over,
});
const search = (pulls, over = {}) => searchSplits({ pulls, cells: CELLS, inputs: INPUTS, minN: MIN_N, seed: 7, ...over });
const alternating = (n, held) => Array.from({ length: n }, (_, i) => pull(i % 2 ? "slow-high" : "task-high", 5, held(i)));

// `n` Pulls of each Cell on each of two sides of `criteria`, 0 and 5; each Cell's $ on each side as given. Task-high
// saves $6 on the low side and costs $4 more on the high side: its pooled $9 beats slow-high's $10, so the one-Cell
// choice is task-high, and the high side would do better on slow-high. `over(cell, side, i)` amends the i-th Pull.
function flip({ n = 40, low = [10, 4], high = [10, 14], held = () => ({}), over = () => ({}) } = {}) {
  const pulls = [];
  for (const [side, [slow, task]] of [[0, low], [5, high]]) {
    for (let i = 0; i < n; i++) {
      pulls.push(pull("slow-high", slow, { criteria: side, ...held(side, i) }, over("slow-high", side, i)));
      pulls.push(pull("task-high", task, { criteria: side, ...held(side, i) }, over("task-high", side, i)));
    }
  }
  return pulls;
}

test("a numeric input is cut at its 25th, 50th and 75th percentile, floored; cuts that make one split are one cut, and a cut with an empty side is none", () => {
  // Half the Pulls hold 0 and half 5: the 25th percentile is 0, the 50th 2.5 and the 75th 5. `> 0` and `> 2` are the
  // same split, and `> 5` puts every Pull on one side.
  const found = search(flip());
  assert.deepEqual(found.cuts.filter((c) => c.input === "criteria"), [{ input: "criteria", cut: 0, below: 80, above: 80 }]);
  // Percentiles interpolate between the Pulls that hold them: 1 .. 200, one each, has its 25th at 50.75, its 50th at
  // 100.5 and its 75th at 150.25, floored.
  const ramp = alternating(200, (i) => ({ criteria: i + 1 }));
  assert.deepEqual(search(ramp).cuts.map((c) => c.cut), [50, 100, 150]);
});

test("a cut whose smaller side holds fewer than 2 x MIN_N Pulls is dropped, and one with exactly 2 x MIN_N is searched", () => {
  const sides = (below, above) => alternating(below + above, (i) => ({ criteria: i < below ? 0 : 9 }));
  assert.deepEqual(search(sides(2 * MIN_N - 1, 100)).cuts, [], "39 Pulls on the lower side");
  assert.deepEqual(search(sides(2 * MIN_N, 100)).cuts.map(({ below, above }) => [below, above]), [[2 * MIN_N, 100]]);
  assert.deepEqual(search(sides(100, 2 * MIN_N - 1)).cuts, [], "the smaller side may be either");
  assert.deepEqual(search(sides(100, 2 * MIN_N)).cuts.map(({ below, above }) => [below, above]), [[100, 2 * MIN_N]]);
});

test("`kind` is cut on a value and `parent` on presence", () => {
  // 60 bugs, 45 enhancements and 15 documentation tickets; the first 60 name no parent.
  const kinds = [...Array(60).fill("bug"), ...Array(45).fill("enhancement"), ...Array(15).fill("documentation")];
  const cuts = search(alternating(120, (i) => ({ kind: kinds[i], parent: i < 60 ? 0 : 3177 }))).cuts;
  // A value is one side and every other kind the other; documentation is on 15 Pulls, so no cut.
  assert.deepEqual(cuts, [
    { input: "kind", cut: "bug", below: 60, above: 60 },
    { input: "kind", cut: "enhancement", below: 75, above: 45 },
    { input: "parent", cut: 0, below: 60, above: 60 },
  ]);
});

test("a Pull that lacks an input is on neither side of a cut on it, counts toward no side's size, and is no cut of its own", () => {
  // 100 Pulls hold `criteria`, split 50/50 at 0; 100 more, written before the column existed, lack it. Were a blank a
  // value, `criteria` would also be cut on being recorded and its sides would be 50 + 100.
  const held = alternating(100, (i) => ({ criteria: i < 50 ? 0 : 5 }));
  const lacking = alternating(100, () => ({}));
  assert.deepEqual(search([...held, ...lacking]).cuts, [{ input: "criteria", cut: 0, below: 50, above: 50 }]);
  // With 79 holding it the smaller side is 39 and there is no cut, however many lack it.
  assert.deepEqual(search([...held.slice(0, 79), ...lacking]).cuts, []);
});

test("the gain of a split is the one-Cell choice's $ per merged PR less the leaves', each leaf by its share of the group's Pulls", () => {
  // The one-Cell choice is task-high at $9. The low side keeps it ($4); the high side takes slow-high's $10 for task-high's
  // $14, a saving of $4 on half the Pulls.
  const found = search(flip());
  assert.equal(found.base, "task-high");
  assert.equal(found.best.key, "criteria");
  assert.deepEqual(found.best.cuts, [{ input: "criteria", cut: 0 }]);
  assert.deepEqual(found.best.picks, ["task-high", "slow-high"], "the side at or below the cut, then the side above it");
  assert.ok(Math.abs(found.best.gain - 2) < 1e-9, `${found.best.gain}`);
  // Pulls that lack the input route by the group's own row: they are in every leaf's share's denominator and gain
  // nothing, and set on a side they would be Pulls of its leaf. Here task-high costs $14 on the low side and $4 on the
  // high one, so the low leaf takes slow-high at $10 and gains $4 on 80 of the 180 Pulls; the 20 that lack `criteria`,
  // priced as the low side is, dilute that gain and leave the low leaf's share at 80.
  const tipped = flip({ low: [10, 14], high: [10, 4] });
  const lacking = Array.from({ length: 10 }, () => [pull("slow-high", 10), pull("task-high", 14)]).flat();
  const diluted = search([...tipped, ...lacking]);
  assert.equal(diluted.base, "task-high");
  assert.deepEqual(diluted.best.picks, ["slow-high", "task-high"]);
  assert.ok(Math.abs(diluted.best.gain - (80 / 180) * 4) < 1e-9, `${diluted.best.gain}`);
});

test("a record where no input changes which Cell wins has no best split: every partition gains exactly zero", () => {
  const found = search(flip({ low: [10, 8], high: [10, 8] }));
  assert.equal(found.best, null);
  assert.equal(found.base, "task-high");
  assert.deepEqual(found.cuts.map((c) => c.input), ["criteria"], "the cut was searched");
});

test("a leaf chooses a Cell only with MIN_N merged PRs on it there, and only with MIN_N on the default Cell there too", () => {
  // From the `from`th Pull on, the Cell's Pulls on `side` never merged and cost nothing, so the merged count is all that changes.
  const unmerged = (cell, side, from) => (c, s, i) => (c === cell && s === side && i >= from ? { merged: 0, usd: 0 } : {});
  // 20 of task-high's 40 on the high side merged: enough to hold it, though no better than slow-high there.
  assert.notEqual(search(flip({ over: unmerged("task-high", 5, 20) })).best, null);
  // The slow-high Pulls of the high side that merged are 19: nothing can be judged against the default Cell there.
  assert.equal(search(flip({ over: unmerged("slow-high", 5, 19) })).best, null);
  // And the low side's task-high with 19 merged cannot be chosen there, so the leaf falls back to slow-high at $10 and the
  // split loses what the high side wins.
  assert.equal(search(flip({ over: unmerged("task-high", 0, 19) })).best, null);
});

test("a cheaper Cell 15 or more points of fail rate above the default Cell is no choice, compared in integers", () => {
  // On the low side task-high fails `failed` of 40 claims and slow-high none: 5 is 12.5 points, 6 exactly 15.
  const failing = (failed) => flip({ over: (cell, side, i) => (cell === "task-high" && side === 0 && i < failed ? { failed: 1 } : {}) });
  assert.deepEqual(search(failing(5)).best.picks, ["task-high", "slow-high"]);
  // Under the floor, the low side must take slow-high's $10 for task-high's $4: the split now loses on the leaf it won.
  assert.equal(search(failing(6)).best, null);
  // The margin is the one the comparison of two Cells reads, over one stretch.
  const units = (failed) => Array.from({ length: 40 }, (_, i) => ({ spend: 1, workS: 0, merged: true, claims: 1, falseClaims: i < failed ? 1 : 0, stretch: "s" }));
  assert.deepEqual([5, 6].map((failed) => compareCells(units(failed), units(0)).underFloor), [false, true]);
});

test("two cuts on two different inputs split a group when the pair gains more than either cut alone, and the key names both inputs, not their cuts", () => {
  // Task-high is $4 on three of the four corners of `criteria` x `paths` and $20 on the fourth, slow-high $10 on all.
  // One cut alone: the side holding the fourth corner has task-high at $12 against slow-high's $10, so it moves to
  // slow-high and gains $2 on half the Pulls, $1. The pair puts the corner alone: $10 on a quarter of the Pulls, $2.5.
  const corners = [];
  for (const criteria of [0, 5]) {
    for (const paths of [0, 5]) {
      for (let i = 0; i < 30; i++) {
        corners.push(pull("slow-high", 10, { criteria, paths }), pull("task-high", criteria === 5 && paths === 5 ? 20 : 4, { criteria, paths }));
      }
    }
  }
  const found = search(corners);
  assert.equal(found.base, "task-high");
  assert.equal(found.best.key, "criteria+paths");
  assert.deepEqual(found.best.inputs, ["criteria", "paths"]);
  assert.deepEqual(found.best.cuts, [{ input: "criteria", cut: 0 }, { input: "paths", cut: 0 }]);
  assert.deepEqual(found.best.picks, ["task-high", "task-high", "task-high", "slow-high"], "leaf = criteria side * 2 + paths side");
  assert.ok(Math.abs(found.best.gain - 2.5) < 1e-9, `${found.best.gain}`);
  // The same record with only `criteria` searched: the best cut alone.
  const alone = searchSplits({ pulls: corners, cells: CELLS, inputs: [INPUTS[0]], minN: MIN_N, seed: 7 });
  assert.ok(Math.abs(alone.best.gain - 1) < 1e-9, `${alone.best.gain}`);
});

test("the null shuffles outcomes against inputs only among Pulls with the same probability, so a split that is only the draw's regime does not pass", () => {
  // The high side's Pulls were all drawn after burn-in, at 4 in 5 for slow-high, and its prices are the regime's: what the
  // input tells is when the Pull was drawn. Shuffled inside each probability the outcomes stay with their regime, so the
  // shuffled searches find the same gain; shuffled across all of them they would not.
  const regime = (probs) => flip({ over: (cell, side) => ({ prob: side === 0 ? 0.5 : probs[cell] }) });
  const confounded = search(regime({ "slow-high": 0.8, "task-high": 0.2 })).best;
  assert.equal(confounded.gain, 2);
  assert.equal(confounded.passesNull, false);
  assert.ok(confounded.exceeded > 4, `${confounded.exceeded}`);
  // The same Pulls all at one probability are one set, and the split passes.
  const one = search(regime({ "slow-high": 0.5, "task-high": 0.5 })).best;
  assert.deepEqual([one.gain, one.passesNull, one.exceeded], [2, true, 0]);
});

test("the bound weighs each Pull by the probability its own Cell was assigned: the same $ at a rare Cell's probability do not clear it", () => {
  // Eight task-high Pulls on the high side, half $0.5 above their leaf's mean and half $0.5 below, each drawn with
  // probability 0.005 rather than 0.5: 1 / 0.005 = 200 times what they say, which swamps the estimate's error.
  const noisy = (rare) => {
    const pulls = [];
    for (const [side, slow, task] of [[0, 10, 4], [5, 10, 14]]) {
      for (let i = 0; i < 40; i++) {
        const noise = i % 2 === 0 ? 0.5 : -0.5;
        pulls.push(pull("slow-high", slow + noise, { criteria: side }));
        pulls.push(pull("task-high", task + noise, { criteria: side }, side === 5 && i < 8 ? { prob: rare } : {}));
      }
    }
    return pulls;
  };
  const common = search(noisy(0.5)).best;
  assert.deepEqual([common.passesNull, common.passesBound, common.passes], [true, true, true]);
  assert.ok(common.lowerBound > 1.5, `${common.lowerBound}`);
  const rare = search(noisy(0.005)).best;
  assert.equal(rare.gain, common.gain, "the gain is the same: it is the null and the bound that read probabilities");
  assert.deepEqual([rare.passesNull, rare.passesBound, rare.passes], [true, false, false]);
  assert.ok(rare.lowerBound < 0, `${rare.lowerBound}`);
  // The same for the Cell the leaf is moved to: eight slow-high Pulls of the high side drawn at 1 in 200.
  const toward = noisy(0.5).map((p, i) => (p.cell === "slow-high" && i >= 80 && i % 10 === 0 ? { ...p, prob: 0.005 } : p));
  assert.equal(toward.filter((p) => p.prob === 0.005).length, 8);
  const moved = search(toward).best;
  assert.deepEqual([moved.passesNull, moved.passesBound], [true, false]);
});

// A record where no input matters: costs are the Cell's own, lognormal, and every input is drawn at random.
function chance(seed, n = 240) {
  const rand = mulberry32(seed);
  const int = (k) => Math.floor(rand() * k);
  const gauss = () => {
    const u = 1 - rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  return Array.from({ length: n }, () => {
    const cell = rand() < 0.5 ? "slow-high" : "task-high";
    const usd = Math.max(0.5, (cell === "slow-high" ? 10 : 8) * Math.exp(0.6 * gauss() - 0.18));
    return pull(cell, usd, { criteria: int(8), paths: int(12), kind: ["bug", "enhancement", "documentation"][int(3)], parent: rand() < 0.2 ? 3000 + int(5) : 0 });
  });
}

test("a split stands only if it passes both tests: of 300 records with no effect, some pass the null alone, some the bound alone, and none passes unless both do", () => {
  const seen = { nullOnly: [], boundOnly: [], both: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const { best } = search(chance(seed), { seed });
    if (best === null) continue;
    assert.equal(best.passes, best.passesNull && best.passesBound, `record ${seed}`);
    // The null is at most 4 of 99 shuffles reaching the gain: the count stops at 5, where it is settled.
    assert.equal(best.passesNull, best.exceeded <= 4, `record ${seed}: ${best.exceeded} of ${NULL_SHUFFLES} shuffles`);
    assert.ok(best.exceeded <= 5, `record ${seed}`);
    if (best.passes) seen.both++;
    else if (best.passesNull) seen.nullOnly.push(seed);
    else if (best.passesBound) seen.boundOnly.push(seed);
  }
  assert.ok(seen.nullOnly.length > 0 && seen.boundOnly.length > 0, JSON.stringify(seen));
  // Chance splits are rare with both tests: the research's single-look rate for both is 0-3%.
  assert.ok(seen.both / 300 < 0.08, `${seen.both} of 300`);
});

test("the same Pulls and the same seed give the same search; the seed draws the null's shuffles and the bound's folds, never the cuts or the gain", () => {
  const pulls = chance(11);
  assert.deepEqual(search(pulls, { seed: 3 }), search(pulls, { seed: 3 }));
  const [a, b] = [search(pulls, { seed: 3 }), search(pulls, { seed: 4 })];
  assert.deepEqual([a.base, a.cuts, a.best.key, a.best.gain], [b.base, b.cuts, b.best.key, b.best.gain]);
  assert.notEqual(a.best.lowerBound, b.best.lowerBound, "another seed folds the Pulls another way");
  // And shuffles them another way: among the records whose best split passes the null, the count of shuffles that reach
  // its gain moves with the seed.
  const passing = [];
  for (let k = 1; k <= 300 && passing.length < 8; k++) if (search(chance(k), { seed: 3 }).best?.passesNull) passing.push(k);
  assert.equal(passing.length, 8);
  const reached = (seed) => passing.map((k) => search(chance(k), { seed }).best.exceeded);
  assert.notDeepEqual(reached(3), reached(4));
});

// `size` Pulls of `input` 1 .. `size`, one each, task-high at $4 up to the input's median and $14 above it, slow-high at
// $10 throughout: the best split is the 50th percentile's, and where it falls moves with `size`.
function median(input, size) {
  return Array.from({ length: size }, (_, i) => pull(i % 2 ? "slow-high" : "task-high", i % 2 ? 10 : i + 1 <= size / 2 ? 4 : 14, { [input]: i + 1 }));
}

test("a split stands after two consecutive passes on the same input, and the cut may move between them", () => {
  const first = search(median("paths", 200)).best;
  const second = search(median("paths", 240)).best;
  assert.deepEqual([first.cuts, second.cuts], [[{ input: "paths", cut: 100 }], [{ input: "paths", cut: 120 }]], "the percentile moved with the record");
  const one = standing({ best: first, previous: [] });
  assert.deepEqual(one, { passed: ["paths"], stands: [] }, "a first pass is kept for the next Fit and stands nowhere");
  assert.deepEqual(standing({ best: second, previous: one.passed }), { passed: ["paths"], stands: ["paths"] });
});

test("a pass on other inputs than the last Fit's starts the count again", () => {
  const paths = search(median("paths", 200)).best;
  const criteria = search(median("criteria", 200)).best;
  const next = standing({ best: criteria, previous: standing({ best: paths, previous: [] }).passed });
  assert.deepEqual(next, { passed: ["criteria"], stands: [] });
  assert.deepEqual(standing({ best: criteria, previous: next.passed }).stands, ["criteria"], "its second pass on the new input stands");
  // Two inputs are an identity of their own: passing on `criteria` before is no pass of `criteria+paths`.
  assert.deepEqual(standing({ best: { key: "criteria+paths", passes: true }, previous: ["criteria"] }), { passed: ["criteria+paths"], stands: [] });
});

test("a split merges back at the first Fit it fails: nothing is kept, and the count starts again", () => {
  const best = search(median("paths", 200)).best;
  const standingNow = standing({ best, previous: ["paths"] });
  assert.deepEqual(standingNow.stands, ["paths"]);
  const failed = standing({ best: { ...best, passes: false, passesNull: true, passesBound: false }, previous: standingNow.passed });
  assert.deepEqual(failed, { passed: [], stands: [] }, "passing one of the two tests is a failure");
  assert.deepEqual(standing({ best, previous: failed.passed }), { passed: ["paths"], stands: [] }, "its next pass is a first");
  assert.deepEqual(standing({ best: null, previous: ["paths"] }), { passed: [], stands: [] }, "no best split at all is a failure too");
});

test("the search never reaches a third input: with three inputs that each matter, the best split reads at most two", () => {
  // Task-high costs $4 more for each of `criteria` high, `paths` high and `kind` bug, so all three inputs matter; a partition
  // on all three would gain most, and the search offers pairs at most.
  const pulls = [];
  for (const criteria of [0, 5]) {
    for (const paths of [0, 5]) {
      for (const kind of ["bug", "enhancement"]) {
        for (let i = 0; i < 12; i++) {
          const dear = (criteria === 5 ? 1 : 0) + (paths === 5 ? 1 : 0) + (kind === "bug" ? 1 : 0);
          pulls.push(pull("slow-high", 10, { criteria, paths, kind }), pull("task-high", 4 + 4 * dear, { criteria, paths, kind }));
        }
      }
    }
  }
  const { best } = search(pulls);
  assert.ok(best.cuts.length <= 2 && best.inputs.length <= 2, best.key);
  assert.equal(best.key.split("+").length, best.cuts.length);
});

test("two cuts of one input are no partition: a band between two cuts of `criteria` is found by neither cut alone, and not by the pair", () => {
  // Task-high is $4 on `criteria` 1 and 4 and $14 on 2 and 3, slow-high $10 throughout. The cuts are at 1, 2 and 3. A pair
  // at 1 and 3 would isolate the band 2-3 and gain $2; the best single cut gains $0.5, moving 3 of 4 values to slow-high.
  const band = [];
  for (const criteria of [1, 2, 3, 4]) {
    for (let i = 0; i < 40; i++) band.push(pull("slow-high", 10, { criteria }), pull("task-high", criteria === 2 || criteria === 3 ? 14 : 4, { criteria }));
  }
  const found = search(band);
  assert.deepEqual(found.cuts.map((c) => c.cut), [1, 2, 3]);
  assert.equal(found.best.key, "criteria");
  assert.ok(Math.abs(found.best.gain - 0.5) < 1e-9, `${found.best.gain}`);
});

test("a leaf where the one-Cell choice merged nothing is valued at the leaf's own $ per merged PR over every Cell", () => {
  // Task-high is $4 on the low side and, on the high side, costs $2 a Pull and merges none: its $6 a merged PR overall
  // is the one-Cell choice. The high leaf cannot judge it, takes slow-high's $10 and is credited what it saves against
  // the leaf's own $12 a merged PR ($400 + $80 over 40): $2 on half the Pulls.
  const found = search(flip({ low: [10, 4], high: [10, 2], over: (cell, side) => (cell === "task-high" && side === 5 ? { merged: 0 } : {}) }));
  assert.equal(found.base, "task-high");
  assert.deepEqual(found.best.picks, ["task-high", "slow-high"]);
  assert.ok(Math.abs(found.best.gain - 1) < 1e-9, `${found.best.gain}`);
});

test("a Pull that never merged counts for what it cost: at the same $ per merged PR it gains the same, and the bound values it less", () => {
  // On the low side task-high is $5.33 a merged PR against slow-high's $8 either way: 40 Pulls all merged, or 30 merged at $4
  // and 10 that cost $4 and merged nothing. On the high side it is $14. Slow-high is the one-Cell choice at $8 a merged PR.
  const record = (unmerged) => {
    const task = unmerged
      ? [...Array.from({ length: 30 }, () => pull("task-high", 4, { criteria: 0 })), ...Array.from({ length: 10 }, () => pull("task-high", 4, { criteria: 0 }, { merged: 0 }))]
      : Array.from({ length: 40 }, () => pull("task-high", 16 / 3, { criteria: 0 }));
    return [
      ...Array.from({ length: 40 }, () => pull("slow-high", 8, { criteria: 0 })), ...task,
      ...Array.from({ length: 80 }, (_, i) => pull(i % 2 ? "slow-high" : "task-high", i % 2 ? 8 : 14, { criteria: 5 })),
    ];
  };
  const [merged, partly] = [search(record(false)).best, search(record(true)).best];
  assert.deepEqual([merged.picks, partly.picks], [["task-high", "slow-high"], ["task-high", "slow-high"]]);
  assert.ok(Math.abs(merged.gain - 4 / 3) < 1e-9 && Math.abs(partly.gain - 4 / 3) < 1e-9, `${merged.gain} ${partly.gain}`);
  // A task-high Pull that merged worth $2.67 less than slow-high's, one that did not worth what it cost: the mixture is less
  // sure of what the Cell saves.
  assert.ok(partly.lowerBound < merged.lowerBound - 0.5, `${partly.lowerBound} against ${merged.lowerBound}`);
});

test("a group with no Pulls, or no Cells to choose among, searches nothing; a Pull of a Cell not searched is refused", () => {
  assert.deepEqual(search([]), { scored: 0, base: "slow-high", cuts: [], best: null });
  assert.deepEqual(searchSplits({ pulls: [], cells: [], inputs: INPUTS, minN: MIN_N }), { scored: 0, base: null, cuts: [], best: null });
  assert.throws(() => search([pull("smol-high", 1)]), /Pull 0 ran smol-high, which is not one of the Cells searched/);
});
