import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStats } from "./diff-stats.mjs";

// `workflows/review-pr.js` runs a top-level `await pipeline(...)`, so importing it
// executes the workflow. Every value under test is lifted out of the SOURCE TEXT
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

// Every declaration below ends at a column-0 terminator and is the only
// top-level declaration of its name, so these matches are unambiguous.
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
  if (name === "verifiersFor") {
    // Closes over `A` (the workflow args) and `verifiers`, so both are supplied
    // as `new Function` parameters rather than re-declared — this pins the real
    // wiring, not a copy of it. `verifiers` gets a SENTINEL: the claim under test
    // is that the budget is a function of severity, not that the default is 2.
    const m = SOURCE.match(/^const verifiersBySeverity = A\.verifiersBySeverity \|\| \{[\s\S]*?^const verifiersFor = .*;$/m);
    assert.ok(m, "review-pr.js no longer declares verifiersBySeverity then verifiersFor at top level — update this test");
    return new Function("A", "verifiers", `${m[0]}\nreturn verifiersFor;`)({}, 7);
  }
  if (name === "resolveDimensions") {
    const m = SOURCE.match(/^function resolveDimensions\(override, all\) \{[\s\S]*?^\}$/m);
    assert.ok(m, "review-pr.js no longer declares resolveDimensions(override, all) at top level — update this test");
    return new Function(`${m[0]}\nreturn resolveDimensions;`)();
  }
  throw new Error(`liftFromSource: unknown name ${name}`);
}

const DEFAULT_DIMENSIONS = liftFromSource("DEFAULT_DIMENSIONS");
const selectDimensions = liftFromSource("selectDimensions");
const resolveDimensions = liftFromSource("resolveDimensions");

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

// Downgrade only where a MISS is recoverable, NOT "faces refuters" (#221): the
// refuter budget is keyed on severity, never on a dimension, so `silent-failure`
// findings draw the same refuters `tests` findings do. The omissions split two
// ways — the vendored `model: opus` frontmatter pin and the silent-permanent
// miss — and the rule above `DEFAULT_DIMENSIONS` in review-pr.js owns the why.
test("only the recoverable-miss dimensions carry a model downgrade", () => {
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

// The test above pins WHICH dimensions carry the downgrade. This pins the fact
// its comment rests on: `verifiersFor` is keyed on SEVERITY ALONE, so no
// dimension can draw a different refuter budget and "faces refuters" was never
// able to separate these six (#221). Without this the corrected rationale is
// prose with nothing under it — which is how the retired one survived.
test("the refuter budget is keyed on severity alone, never on a dimension", () => {
  const verifiersFor = liftFromSource("verifiersFor");
  // One parameter, and it is the severity. A dimension-aware budget needs a
  // second one, and passing a dimension anyway must not move the answer.
  assert.equal(verifiersFor.length, 1);
  for (const d of DEFAULT_DIMENSIONS)
    assert.equal(verifiersFor("critical", d.key), 7, `critical/${d.key}`);
  // `silent-failure` and `tests` sit on opposite sides of the model downgrade and
  // still draw the same budget — the whole of why the retired rule did not
  // separate them. `suggestion` is the one band that differs, and it is a
  // SEVERITY, not a dimension.
  assert.equal(verifiersFor("important"), verifiersFor("critical"));
  assert.equal(verifiersFor("suggestion"), 0);
});

// --- args.dimensions normalization (#113). The "Specialists" section of
// `skills/fleet/commands/review-and-fix.md` documents the override as
// accepting "keys or dimension objects"; before this, only objects worked and
// a key array passed through untouched, dereferencing `d.key`, `d.prompt` and
// `d.agentType` to `undefined` with no throw and no warning.
test("no override leaves the size tier in charge", () => {
  assert.equal(resolveDimensions(undefined, DEFAULT_DIMENSIONS), null);
  assert.equal(resolveDimensions(null, DEFAULT_DIMENSIONS), null);
});

// ...but only an ABSENT override does. A falsy-but-present one is a caller
// error, and falling back to the size tier would silently run a DIFFERENT set
// than the one that was pinned, with nothing in the log naming the override.
test("a falsy-but-present override stops the run rather than degrading to the size tier", () => {
  for (const override of ["", 0, false, NaN]) {
    assert.throws(() => resolveDimensions(override, DEFAULT_DIMENSIONS), /must be an array/);
  }
});

test("an object override behaves as it does today — passed through unchanged", () => {
  const objs = [DEFAULT_DIMENSIONS[0], DEFAULT_DIMENSIONS[2]];
  assert.deepEqual(resolveDimensions(objs, DEFAULT_DIMENSIONS), objs);
});

test("a key override resolves against the workflow's own dimension list", () => {
  assert.deepEqual(
    resolveDimensions(["correctness", "comments"], DEFAULT_DIMENSIONS),
    [DEFAULT_DIMENSIONS[0], DEFAULT_DIMENSIONS[3]],
  );
});

test("keys and objects can mix in the same override", () => {
  assert.deepEqual(
    resolveDimensions(["correctness", DEFAULT_DIMENSIONS[2]], DEFAULT_DIMENSIONS),
    [DEFAULT_DIMENSIONS[0], DEFAULT_DIMENSIONS[2]],
  );
});

test("an unknown key stops the run and names the key", () => {
  assert.throws(
    () => resolveDimensions(["not-a-real-dimension"], DEFAULT_DIMENSIONS),
    /unknown key "not-a-real-dimension"/,
  );
});

test("an object override missing a required field stops the run and names the field", () => {
  assert.throws(
    () => resolveDimensions([{ key: "x", agentType: "y" }], DEFAULT_DIMENSIONS),
    /missing required field\(s\): prompt/,
  );
  // All three dereferenced fields are checked, not just one.
  assert.throws(
    () => resolveDimensions([{}], DEFAULT_DIMENSIONS),
    /missing required field\(s\): key, prompt, agentType/,
  );
});

// The `?.` in `!entry?.[f]` is what turns a hole in the array into the named
// error above instead of an uncaught `TypeError: Cannot read properties of
// null (reading 'key')`. Every other negative case here passes an object, so
// nothing else fails when that `?.` is dropped.
test("a null or undefined entry stops the run instead of crashing on the field check", () => {
  for (const entry of [null, undefined]) {
    assert.throws(
      () => resolveDimensions([entry], DEFAULT_DIMENSIONS),
      /missing required field\(s\): key, prompt, agentType/,
    );
  }
});

test("an override resolving to nothing stops the run", () => {
  assert.throws(() => resolveDimensions([], DEFAULT_DIMENSIONS), /resolved to no dimensions/);
});

test("a non-array override stops the run rather than crashing on .map", () => {
  assert.throws(() => resolveDimensions({ key: "correctness" }, DEFAULT_DIMENSIONS), /must be an array/);
});

// Everything above tests a LIFTED COPY. Nothing above proves review-pr.js
// wires resolveDimensions AND selectDimensions into the same call site:
// replacing it with `explicitDimensions || DEFAULT_DIMENSIONS` left this file
// green before (#118) by disconnecting the size tier, and a version that
// dropped resolveDimensions here would do the same to the override
// normalization, silently. This is the only assertion that fails on either.
test("review-pr.js actually calls resolveDimensions, then selectDimensions, to pick the fan-out", () => {
  assert.match(
    SOURCE,
    /^const dimensions = resolveDimensions\(explicitDimensions, DEFAULT_DIMENSIONS\) \|\| selectDimensions\(DEFAULT_DIMENSIONS, stats\);$/m,
    "the dimensions call site changed — override normalization and/or size-tier selection may be disconnected",
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

// `gh pr view --json files` pages at 100 and exits 0, so a truncated list is a
// short MEASUREMENT, not a small PR: `loc` under-counts and `docsOnly` can be
// true only because the src files fell off the end. Either one trims dimensions
// off production code — the docs profile drops four. Widen, the same safe
// direction as an unparseable blob.
test("a truncated file list widens to the full set, whatever it profiles as", () => {
  const docsish = computeStats(
    [
      { path: "docs/a.md", additions: 3, deletions: 0 },
      { path: "docs/b.md", additions: 3, deletions: 0 },
    ],
    124,
  );
  assert.equal(docsish.docsOnly, true, "the short list really does look docs-only — that is the trap");
  assert.equal(docsish.truncated, 124);
  assert.equal(
    selectDimensions(DEFAULT_DIMENSIONS, docsish).length,
    DEFAULT_DIMENSIONS.length,
    "a capped list was sized as a docs PR — four dimensions dropped off code gh never listed",
  );
  // And the widen must not fire when the list is complete, or every review runs
  // the full set forever and the size tier is dead.
  const complete = computeStats(
    [
      { path: "docs/a.md", additions: 3, deletions: 0 },
      { path: "docs/b.md", additions: 3, deletions: 0 },
    ],
    2,
  );
  assert.equal(complete.truncated, undefined);
  assert.deepEqual(
    selectDimensions(DEFAULT_DIMENSIONS, complete).map((d) => d.key),
    ["correctness", "comments"],
    "the docs trim no longer fires on a complete docs-only list",
  );
});
