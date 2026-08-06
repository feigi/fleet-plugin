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
    // Widened to start at SIZE_TIER_PROFILES, not just `function selectDimensions`:
    // that Set and SIZE_TIER_DIMS are module-level consts selectDimensions closes
    // over, declared immediately above it by construction. Lifting the function
    // alone leaves them out of the `new Function` eval scope — a ReferenceError,
    // not a wrong answer, so it fails loud rather than pinning a stale result.
    const m = SOURCE.match(/^const SIZE_TIER_PROFILES = new Set[\s\S]*?^function selectDimensions\(all, stats\) \{[\s\S]*?^\}$/m);
    assert.ok(m, "review-pr.js no longer declares SIZE_TIER_PROFILES/selectDimensions(all, stats) as expected — update this test");
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

test("unknown, unparseable or empty stats widen to the full set", () => {
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

// --- Size tier. `profile` is assigned through an else-if chain in computeStats,
// --- so these values are mutually exclusive and cannot race `docsOnly`.
test("a single-file source diff trims to correctness + silent-failure", () => {
  assert.deepEqual(dimensionKeys([f("workflows/review-pr.js", 3, 2)]), ["correctness", "silent-failure"]);
});

// The size tier INTERSECTS what the content guards left; it is not an early
// return. A single .github/workflows/ci.yml change is profile "single-file" with
// hasSrc false — an early return would run silent-failure on YAML, which the
// hasSrc guard exists to prevent.
test("a single-file config diff trims to correctness alone, never silent-failure", () => {
  assert.deepEqual(dimensionKeys([f(".github/workflows/ci.yml", 2, 1)]), ["correctness"]);
});

test("a small multi-file source diff trims to correctness + silent-failure", () => {
  assert.deepEqual(
    dimensionKeys([f("skills/fleet/scripts/a.mjs", 5, 5), f("skills/fleet/scripts/b.mjs", 5, 4)]),
    ["correctness", "silent-failure"],
  );
});

// Downgrade only dimensions whose findings face refuters. verifiersBySeverity
// gives `suggestion` 0, and simplify's prompt forces every finding to
// `suggestion` — so a cheaper simplify finder has nothing checking it. The other
// two omissions are open-ended searches where a MISS is the cost, and a refuter
// pass catches false positives, never false negatives.
test("only the refuter-backed dimensions carry a model downgrade", () => {
  const models = Object.fromEntries(DEFAULT_DIMENSIONS.map((d) => [d.key, d.model]));
  assert.equal(models.tests, "sonnet");
  assert.equal(models.comments, "sonnet");
  assert.equal(models.types, "sonnet");
  // Undefined, not a string: `undefined` inherits. correctness and simplify keep
  // their vendored `model: opus` frontmatter pin; silent-failure follows the
  // session model.
  assert.equal(models.correctness, undefined);
  assert.equal(models["silent-failure"], undefined);
  assert.equal(models.simplify, undefined);
});

test("the review dispatch lets a caller override every dimension's model", () => {
  assert.match(
    SOURCE,
    /model:\s*specialistModel\s*\|\|\s*d\.model/,
    "the review dispatch no longer prefers args.specialistModel over the per-dimension model",
  );
  assert.match(
    SOURCE,
    /const specialistModel = A\.specialistModel \|\| null;/,
    "args.specialistModel is no longer read",
  );
});
