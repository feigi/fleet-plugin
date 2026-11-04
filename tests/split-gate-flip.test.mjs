// The split gate on a repository where an input really matters: how many runs a real flip takes to stand. The histories
// are seeded (tests/support/split-histories.mjs), so the same seeds draw the same Pulls and give the same answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { POOL, histories, runForShare } from "./support/split-histories.mjs";

test("the population the histories draw from is this repository's 104 slow-high and 104 task-high Pulls, task-high $4.23 cheaper", () => {
  const mean = (cell) => {
    const usd = POOL.rows.filter((r) => r[POOL.columns.indexOf("cell")] === cell).map((r) => r[POOL.columns.indexOf("usd")]);
    return { n: usd.length, mean: usd.reduce((a, b) => a + b, 0) / usd.length };
  };
  const [slow, task] = [mean(0), mean(1)];
  assert.deepEqual([slow.n, task.n], [104, 104]);
  assert.equal((task.mean - slow.mean).toFixed(2), "-4.23");
});

// A fair coin no ticket's outcome depends on is added $6 to each task-high Pull's $ where it is 1: slow-high becomes the
// cheaper Cell on that side, a flip worth about 6.5% of the one-Cell choice's $ per merged PR.
test("a real flip worth 6.5% stands by the 37th run of 17 Pulls in 80% of histories, within the notes' range of 33 to 43 runs", async (t) => {
  // docs/research/split-looks.md, the depth-2, two-looks, weighted row: 80% by run 37, bootstrap range 33-43 over 160 histories.
  const found = await histories({ delta: 6, runs: 44, count: 160, stop: "real" });
  assert.equal(found.length, 160);
  const run80 = runForShare(found.map((h) => h.first));
  t.diagnostic(`80% of ${found.length} histories held the split on the coin by run ${run80}`);
  assert.ok(run80 >= 33 && run80 <= 43, `80% of the histories held the split on the coin by run ${run80}, outside 33-43`);
  // The split on the coin stands for runs, never earlier than two passes: the earliest run of a standing split is the second look.
  assert.ok(found.every((h) => h.first >= 2), "a split stands only at the second of two consecutive Fits");
  assert.ok(found.every((h) => h.deepest <= 2), "depth two is the most any history reaches");
});
