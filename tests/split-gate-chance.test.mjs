// The split gate on a repository where no input matters: how often a split stands by chance when the Fit re-judges it at every
// run. The histories are seeded (tests/support/split-histories.mjs), so the same seeds draw the same Pulls and give the
// same answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { histories, wilson } from "./support/split-histories.mjs";

test("with no input mattering, no more than 19% of histories hold a chance split at some run and no more than 3% at the end", async (t) => {
  // docs/research/split-looks.md, the depth-2, two-looks, weighted row: 15.0% [11-19] of histories ever, 1.0% [0-3] at the
  // last of 118 runs of 17 Pulls. The limits here are the upper ends of those ranges.
  const found = await histories({ delta: 0, runs: 118, count: 100 });
  assert.equal(found.length, 100);
  const ever = found.filter((h) => h.ever).length;
  const final = found.filter((h) => h.final).length;
  const range = (k) => wilson(k, found.length).map((x) => `${(100 * x).toFixed(0)}`).join("-");
  t.diagnostic(`${ever} of ${found.length} histories held a chance split at some run (95% range ${range(ever)}%), ${final} at the last (${range(final)}%)`);
  assert.ok(ever <= 19, `${ever} of 100 histories held a chance split at some run (95% range ${range(ever)}%), over 19%`);
  assert.ok(final <= 3, `${final} of 100 held one at the last run (95% range ${range(final)}%), over 3%`);
  assert.ok(found.every((h) => h.deepest <= 2), "depth two is the most any history reaches");
});
