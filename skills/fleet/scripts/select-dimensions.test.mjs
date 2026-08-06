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

// `comments` survives the size trim on any diff touching a docs-CLASSIFIED FILE,
// not just a `docsOnly` one. Both rows below are profile `small` with `docsOnly`
// FALSE — one config file or one source file is enough to falsify it — so before
// the carve-out they lost comment-analyzer entirely. Key ordering follows
// DEFAULT_DIMENSIONS because `.filter()` preserves it. Prose living in a source
// comment is NOT covered: that scores `docs: 0`. See #218.
test("a small mixed docs+config diff keeps comments, which docsOnly alone would miss", () => {
  assert.deepEqual(
    dimensionKeys([f("README.md", 5, 3), f(".github/workflows/ci.yml", 2, 1)]),
    ["correctness", "comments"],
  );
});

test("a small mixed docs+source diff keeps comments alongside silent-failure", () => {
  assert.deepEqual(
    dimensionKeys([f("skills/fleet/scripts/a.mjs", 5, 5), f("README.md", 5, 5)]),
    ["correctness", "silent-failure", "comments"],
  );
});

// Same carve-out shape for `tests`: when the diff's substance IS a test, the
// mutation-discrimination check is the one it most needs. Without this the row
// below trims to correctness + silent-failure.
test("a small diff that adds a test keeps the tests dimension", () => {
  assert.deepEqual(
    dimensionKeys([f("skills/fleet/scripts/a.mjs", 5, 5), f("skills/fleet/scripts/a.test.mjs", 5, 5)]),
    ["correctness", "silent-failure", "tests"],
  );
});

// Fail DIRECTION, not a matrix row. The blob reaches review-pr.js relayed by an
// agent, so a field can go missing without failing JSON.parse. Absence must
// widen — `!== 0` — matching the `=== true` guards. Under `> 0` this row loses
// comments, making a dropped field the one input that narrows coverage.
test("a size-tier stats blob missing `kinds` keeps comments rather than dropping it", () => {
  const stats = { profile: "small", docsOnly: false, hasSrc: true, hasTests: false };
  assert.deepEqual(
    selectDimensions(DEFAULT_DIMENSIONS, stats).map((d) => d.key),
    ["correctness", "silent-failure", "comments"],
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

// Everything above tests a LIFTED COPY of selectDimensions. Nothing above proves
// review-pr.js calls it: replacing the call with `explicitDimensions ||
// DEFAULT_DIMENSIONS` left this file at 12/12 green, disconnecting the entire
// size tier in one token. This is the only assertion that fails on that.
test("review-pr.js actually calls selectDimensions to pick the fan-out", () => {
  assert.match(
    SOURCE,
    /^const dimensions = explicitDimensions \|\| selectDimensions\(DEFAULT_DIMENSIONS, stats\);$/m,
    "the selectDimensions call site changed — every size-tier test above now pins a copy nothing runs",
  );
});

// Slice, then match. A whole-file `assert.match` for this proved nothing: it
// survived commenting the line out, planting the phrase in a comment elsewhere,
// AND moving the `model` option off the review dispatch onto the refuter
// dispatch. Comment lines are stripped so a commented-out option cannot satisfy
// it, and the slice is the review dispatch's options object alone.
function reviewDispatchOptions() {
  const m = SOURCE.match(/\{\s*\n\s*label: `review:\$\{d\.key\}`[\s\S]*?\n\s*\},/);
  assert.ok(m, "review-pr.js no longer passes an options object labelled review:${d.key} — update this test");
  return m[0]
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

test("the review dispatch lets a caller override every dimension's model", () => {
  assert.match(
    reviewDispatchOptions(),
    /model:\s*specialistModel\s*\|\|\s*d\.model/,
    "the review dispatch no longer prefers args.specialistModel over the per-dimension model",
  );
  assert.match(
    SOURCE,
    /^const specialistModel = A\.specialistModel \|\| null;$/m,
    "args.specialistModel is no longer read",
  );
});

// The log is the only runtime evidence the model policy took effect, and
// review-pr.js defers confirming `opts.model` vs agentType frontmatter to a
// first-run read of it. `frontmatter`, never `inherit`: correctness and simplify
// are pinned `model: opus` by the vendored agent definitions, so `inherit` named
// the one behaviour the DEFAULT_DIMENSIONS comment exists to deny.
test("the models log reports what was sent and does not call a vendored pin 'inherit'", () => {
  const m = SOURCE.match(/^\s*`models sent \$\{dimensions[\s\S]*?\n/m);
  assert.ok(m, "the `models sent` log line is gone — nothing then reports the dispatched model tier");
  assert.match(m[0], /\|\| "frontmatter"/, "an unset model is reported as something other than `frontmatter`");
  assert.doesNotMatch(m[0], /"inherit"/, "the log calls an unset model `inherit`, which is false for correctness/simplify");
});
