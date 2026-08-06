import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStats } from "./diff-stats.mjs";

// `workflows/review-pr.js` runs a top-level `await pipeline(...)`, so importing it
// executes the workflow. Both values under test are lifted out of the SOURCE TEXT
// instead — the same technique as `review-pr-testcmd.test.mjs:23-33`, and the
// reason #118 existed: every count claim about `selectDimensions` had to be
// hand-derived, and two hand-derived comments were wrong.
//
// Extraction is deliberately NOT a module move. That would require `import` to
// resolve inside the Workflow sandbox ("no filesystem or Node.js API access"),
// which nothing in `workflows/` does today, and a failed import bricks the
// fleet's DEFAULT review path. Coupling to the literal spelling is the cheaper
// risk: it breaks loudly, here, with the message below.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Both declarations end at a column-0 terminator and are the only top-level
// declaration of their name, so these matches are unambiguous.
function liftFromSource(name) {
  if (name === "DEFAULT_DIMENSIONS") {
    const m = SOURCE.match(/^const DEFAULT_DIMENSIONS = \[[\s\S]*?^\];$/m);
    assert.ok(m, "review-pr.js no longer declares DEFAULT_DIMENSIONS as a top-level array — update this test");
    return new Function(`${m[0]}\nreturn DEFAULT_DIMENSIONS;`)();
  }
  if (name === "selectDimensions") {
    const m = SOURCE.match(/^function selectDimensions\(all, stats\) \{[\s\S]*?^\}$/m);
    assert.ok(m, "review-pr.js no longer declares selectDimensions(all, stats) — update this test");
    return new Function(`${m[0]}\nreturn selectDimensions;`)();
  }
  throw new Error(`liftFromSource: unknown name ${name}`);
}

const DEFAULT_DIMENSIONS = liftFromSource("DEFAULT_DIMENSIONS");
const selectDimensions = liftFromSource("selectDimensions");

// Drive the matrix from REAL file lists through the real classifier, not from
// hand-written profile strings. A `diff-stats` classifier change that silently
// shifts a profile then fails here instead of silently retuning the fan-out.
const dimensionKeys = (files) => selectDimensions(DEFAULT_DIMENSIONS, computeStats(files)).map((d) => d.key);
const f = (path, additions = 5, deletions = 5) => ({ path, additions, deletions });

test("the lifted values have the shape the rest of this file assumes", () => {
  assert.equal(DEFAULT_DIMENSIONS.length, 6);
  assert.deepEqual(
    DEFAULT_DIMENSIONS.map((d) => d.key),
    ["correctness", "silent-failure", "tests", "comments", "types", "simplify"],
  );
});

test("unknown or unparseable stats widen to the full set", () => {
  assert.equal(selectDimensions(DEFAULT_DIMENSIONS, null).length, 6);
  assert.equal(selectDimensions(DEFAULT_DIMENSIONS, undefined).length, 6);
  // An empty `files` array is NOT a signal to trim: `gh` can report no files for
  // a real PR, and treating that as "nothing to review" would drop FOUR
  // dimensions on production code.
  assert.equal(dimensionKeys([]).length, 6);
});

test("a docs-only diff runs correctness + comments", () => {
  assert.deepEqual(dimensionKeys([f("README.md")]), ["correctness", "comments"]);
});

test("a tests-only diff drops types, silent-failure and simplify", () => {
  assert.deepEqual(dimensionKeys([f("skills/fleet/scripts/foo.test.mjs")]), ["correctness", "tests", "comments"]);
});

test("a production diff runs everything, less `tests` when the diff has none", () => {
  const withTests = [f("workflows/review-pr.js", 100, 50), f("skills/fleet/scripts/a.test.mjs", 30, 10)];
  assert.equal(dimensionKeys(withTests).length, 6);

  const noTests = [f("workflows/review-pr.js", 100, 50), f("skills/fleet/scripts/b.mjs", 40, 20)];
  const keys = dimensionKeys(noTests);
  assert.equal(keys.length, 5);
  assert.ok(!keys.includes("tests"));
});

// --- The three rows Task 2 flips. Current behaviour, asserted so the change is
// --- visible as a diff rather than assumed.
test("CURRENT: a single-file source diff still runs five dimensions", () => {
  assert.equal(dimensionKeys([f("workflows/review-pr.js", 3, 2)]).length, 5);
});

test("CURRENT: a single-file config diff still runs two dimensions", () => {
  assert.deepEqual(dimensionKeys([f(".github/workflows/ci.yml", 2, 1)]), ["correctness", "comments"]);
});

test("CURRENT: a small multi-file source diff still runs five dimensions", () => {
  assert.equal(dimensionKeys([f("skills/fleet/scripts/a.mjs", 5, 5), f("skills/fleet/scripts/b.mjs", 5, 4)]).length, 5);
});
