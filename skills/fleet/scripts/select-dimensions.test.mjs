import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStats } from "./diff-stats.mjs";
import { lift } from "./lift.mjs";

// `workflows/review-pr.js` runs a top-level `await pipeline(...)`, so importing it
// executes the workflow. Every value under test is lifted out of the SOURCE TEXT
// instead — the same technique as `review-pr-testcmd.test.mjs`'s lift of
// `resolveTestCmd`, and the
// reason #118 existed: every count claim about `selectDimensions` had to be
// hand-derived, and two hand-derived comments were wrong.
//
// Extraction is deliberately NOT a module move. That would require `import` to
// resolve inside the Workflow sandbox, which #538 measured it does not — the
// verdict and its controls are recorded beside `snapshotMissing` in
// review-pr.js. A failed import bricks the fleet's DEFAULT review path, so
// coupling to the literal spelling is the cheaper risk: it breaks loudly, here.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Every declaration below ends at a column-0 terminator and is the only
// top-level declaration of its name, so these matches are unambiguous.
//
// Only `resolveDimensions` routes through the shared lift() in lift.mjs — it
// is a plain top-level `function name(signature) { ... }` with no free
// variables, the shape lift() generalizes. The other three stay local,
// each for a reason lift()'s single-function signature cannot express:
function liftFromSource(name) {
  if (name === "DEFAULT_DIMENSIONS") {
    // An array literal, not a function — there is no signature for lift() to
    // anchor on.
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
    // lift()'s regex anchors on one `function name(signature)` declaration and
    // has no way to widen its start to a preceding const.
    const m = SOURCE.match(/^const SIZE_TIER_PROFILES = new Set[\s\S]*?^function selectDimensions\(all, stats\) \{[\s\S]*?^\}$/m);
    assert.ok(m, "review-pr.js no longer declares SIZE_TIER_PROFILES/selectDimensions(all, stats) as expected — update this test");
    return new Function(`${m[0]}\nreturn selectDimensions;`)();
  }
  if (name === "verifiersFor") {
    // Closes over `A` (the workflow args) and `verifiers`, so both are supplied
    // as `new Function` parameters rather than re-declared — this pins the real
    // wiring, not a copy of it. `verifiers` gets a SENTINEL: the claim under test
    // is that the budget is a function of severity, not that the default is 2.
    // lift() has no parameter channel — it always calls `new Function(body)()`
    // with zero arguments.
    const m = SOURCE.match(/^const verifiersBySeverity = A\.verifiersBySeverity \|\| \{[\s\S]*?^const verifiersFor = .*;$/m);
    assert.ok(m, "review-pr.js no longer declares verifiersBySeverity then verifiersFor at top level — update this test");
    return new Function("A", "verifiers", `${m[0]}\nreturn verifiersFor;`)({}, 7);
  }
  throw new Error(`liftFromSource: unknown name ${name}`);
}

const DEFAULT_DIMENSIONS = liftFromSource("DEFAULT_DIMENSIONS");
const selectDimensions = liftFromSource("selectDimensions");
const resolveDimensions = lift(SOURCE, "resolveDimensions", "override, all");

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
// #218: `comments` is part of the size-tier floor, so this row carries it. This
// single `.js` file whose whole substance is prose scores `docs: 0`, because
// `classify()` returns `src` for any code extension before it checks `isDocs`
// — one shape of the diffs #218 measured in production (four of them, below).
test("a single-file source diff trims to correctness + silent-failure + comments", () => {
  assert.deepEqual(dimensionKeys([f("workflows/review-pr.js", 3, 2)]), [
    "correctness",
    "silent-failure",
    "comments",
  ]);
});

// The measured instances, as file lists, driven through the real classifier: a
// comment-only `.mjs` (#682), a comment-only `.mjs` (#710), a `.sh` + its test
// (#1091), and a majority-comment `.sh` + test at `small` (#1172). Every one
// scores `docs: 0` and every one now keeps `comments`. Under the old
// `stats.kinds?.docs !== 0` carve-out all four returned without it.
test("the diffs #218 measured in production all keep comments — none of them has a docs file", () => {
  for (const files of [
    [f("skills/fleet/scripts/board.mjs", 1, 1)],
    [f("skills/fleet/scripts/arg.mjs", 2, 1)],
    [f("skills/fleet/scripts/no-undo-audit.sh", 1, 1), f("skills/fleet/scripts/no-undo-audit.test.mjs", 1, 1)],
    [f("skills/fleet/scripts/claim-ticket.sh", 7, 0), f("skills/fleet/scripts/claim-ticket.test.mjs", 20, 2)],
  ]) {
    const stats = computeStats(files);
    assert.equal(stats.kinds.docs, 0, `${files.map((x) => x.path)} unexpectedly scores a docs file`);
    assert.ok(
      dimensionKeys(files).includes("comments"),
      `${files.map((x) => x.path)} lost the comments dimension`,
    );
  }
});

// The size-tier floor OUTRANKS the hasSrc guard for `silent-failure` (#236). A
// single `.github/workflows/ci.yml` change is profile "single-file" with hasSrc
// false, so the guard had already removed silent-failure before the tier ran and
// the documented floor did not exist: PR #226 reviewed CI's own gating logic with
// `dimensionsRun: ["correctness"]`. A CI workflow diff is mostly shell, which is
// what the silent-failure hunter is for, and it is where this fleet got bitten.
test("a single-file config diff keeps the silent-failure floor", () => {
  assert.deepEqual(dimensionKeys([f(".github/workflows/ci.yml", 2, 1)]), [
    "correctness",
    "silent-failure",
    "comments",
  ]);
  // Shell under `.github/` is the ticket's other named case, and it classifies
  // `config` for the same reason. A `.sh` ANYWHERE ELSE is classify()'s `src`
  // residue, so it always had silent-failure and is not part of this class.
  assert.deepEqual(dimensionKeys([f(".github/scripts/release.sh", 4, 2)]), [
    "correctness",
    "silent-failure",
    "comments",
  ]);
});

// AC-2: `small` is the other size-tier profile and gets the same floor. Two
// config files at 6 loc — `single-file` needs files === 1, so this row can only
// reach the tier through `small`, and it went in as [correctness] alone too.
test("a small config-only diff keeps the silent-failure floor", () => {
  assert.deepEqual(
    dimensionKeys([f(".github/workflows/ci.yml", 2, 1), f(".github/workflows/release.yml", 2, 1)]),
    ["correctness", "silent-failure", "comments"],
  );
});

// The floor's own boundary, and the half a widening test cannot pin: OUTSIDE the
// size tier the hasSrc guard still drops silent-failure. Five config files at 50
// loc profile `production`, so nothing re-admits it. Without this the fix reads
// as "hasSrc no longer gates silent-failure at all", which is not what shipped.
test("a large config-only diff still drops silent-failure — the floor is the size tier's, not a repeal", () => {
  const keys = dimensionKeys([
    f(".github/workflows/a.yml", 6, 4),
    f(".github/workflows/b.yml", 6, 4),
    f(".github/workflows/c.yml", 6, 4),
    f("tsconfig.json", 6, 4),
    f("package.json", 6, 4),
  ]);
  assert.deepEqual(keys, ["correctness", "comments"]);
});

// AC-3: the floor must not reach a diff with nothing for it to do, and the ORDER
// is the whole guarantee — `docsOnly` returns BEFORE the tier. A file list cannot
// pin that: computeStats assigns profile `docs` ahead of `files === 1`, so a docs
// diff never matches SIZE_TIER_PROFILES, both branches agree on [correctness,
// comments], and `a docs-only diff runs correctness + comments` above already
// pins that agreement. Pin the DIRECTION instead, on the one blob where the two
// disagree — the same shape as the missing-`kinds` row below. Measured: leaking
// the tier into the docsOnly filter, and deleting that branch outright, each
// passed all 1030 tests without this.
test("docsOnly returns before the size tier — the floor never reaches a docs diff", () => {
  const docsInTier = { profile: "single-file", docsOnly: true, hasSrc: false, hasTests: false };
  assert.deepEqual(
    selectDimensions(DEFAULT_DIMENSIONS, docsInTier).map((d) => d.key),
    ["correctness", "comments"],
  );
});

test("a small multi-file source diff trims to correctness + silent-failure + comments", () => {
  assert.deepEqual(
    dimensionKeys([f("skills/fleet/scripts/a.mjs", 5, 5), f("skills/fleet/scripts/b.mjs", 5, 4)]),
    ["correctness", "silent-failure", "comments"],
  );
});

// Same carve-out shape for `tests`: when the diff's substance IS a test, the
// mutation-discrimination check is the one it most needs. Without this the row
// below trims to whatever else the size tier keeps (`SIZE_TIER_DIMS`) — not
// restated here as a count, which is exactly what went stale last time (#218).
test("a small diff that adds a test keeps the tests dimension", () => {
  assert.deepEqual(
    dimensionKeys([f("skills/fleet/scripts/a.mjs", 5, 5), f("skills/fleet/scripts/a.test.mjs", 5, 5)]),
    ["correctness", "silent-failure", "tests", "comments"],
  );
});

// Fail DIRECTION, not a matrix row. The blob reaches review-pr.js relayed by an
// agent, so a field can go missing without failing JSON.parse, and absence must
// widen rather than narrow — the `=== true` guards elsewhere in selectDimensions
// exist for that. `comments` no longer reads any field at all since #218, so what
// this row pins is the surviving half: `tests` is `=== true`, so a blob without
// `hasTests` loses it, while `comments` cannot be lost to a missing field.
test("a size-tier stats blob missing `kinds` and `hasTests` still keeps comments", () => {
  const stats = { profile: "small", docsOnly: false, hasSrc: true };
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

// The invariant that made two `x.length ? x : all` fallbacks dead code, deleted
// in #669. This is the pin that has to hold for the deletion to stay safe: with
// `all = DEFAULT_DIMENSIONS` — which is what the ONE call site passes, an
// `args.dimensions` override having short-circuited via `resolveDimensions` —
// no combination of stats can empty the set. Sweeping the stats SHAPE rather
// than a file list on purpose: the fallbacks guarded against a corrupt or
// unforeseen blob, so the values under test include the non-booleans and
// unknown profiles a real payload could carry, not only what computeStats emits.
test("no stats shape empties the dimension set — `correctness` survives every filter", () => {
  // `""` stands in for the whole falsy family (`undefined`, `null`, `""`) plus
  // `"empty"`: all four hit `!stats.profile || stats.profile === "empty"` and
  // return `all` before any other field is read, so they are one outcome, not
  // four — verified by re-reading that guard, not assumed from this trim.
  const profiles = ["", "docs", "tests-only", "single-file", "small", "production", "bogus"];
  const values = [true, false, undefined, null, "yes", 0, 1];
  for (const profile of profiles)
    for (const docsOnly of values)
      for (const hasSrc of values)
        for (const hasTests of values)
          for (const truncated of values) {
            const stats = { profile, docsOnly, hasSrc, hasTests, truncated };
            assert.ok(
              selectDimensions(DEFAULT_DIMENSIONS, stats).some((d) => d.key === "correctness"),
              `correctness was filtered out by ${JSON.stringify(stats)}`,
            );
          }
  // The non-object arms of the same guard.
  for (const stats of [null, undefined, 0, "", false])
    assert.equal(selectDimensions(DEFAULT_DIMENSIONS, stats).length, DEFAULT_DIMENSIONS.length);
});
