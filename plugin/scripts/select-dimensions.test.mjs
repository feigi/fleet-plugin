import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStats } from "./diff-stats.mjs";
import { lift } from "./lift.mjs";
import { stripComments } from "./strip-comments.mjs";

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
const REPO = join(import.meta.dirname, "..");
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
// STRIPPED text, not raw SOURCE (#1125). lift() matches with a non-global
// `.match`, so the FIRST `function resolveDimensions(override, all)` in the
// text it is given wins — and in raw source a block-commented copy is still
// text it can match. Measured on a scratch copy of the tree: with the live
// declaration's `override == null` guard reverted to `!override` AND a correct
// copy of the whole function parked in a `/* */` block above it, this file ran
// 40 pass / 0 fail against raw SOURCE — the pin was satisfied by the dead copy
// while review-pr.js shipped the regression. Passing stripComments(SOURCE)
// blanks the parked copy, so the same mutation reds "a falsy-but-present
// override stops the run" below. The three lifts above are deliberately left
// on raw SOURCE by this ticket and are unchanged.
const resolveDimensions = lift(stripComments(SOURCE), "resolveDimensions", "override, all");

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
  assert.deepEqual(dimensionKeys([f("scripts/foo.test.mjs")]), ["correctness", "tests", "comments"]);
});

test("a production diff runs everything, less `tests` when the diff has none", () => {
  const withTests = [f("workflows/review-pr.js", 100, 50), f("scripts/a.test.mjs", 30, 10)];
  assert.equal(dimensionKeys(withTests).length, 6);

  const noTests = [f("workflows/review-pr.js", 100, 50), f("scripts/b.mjs", 40, 20)];
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
    [f("scripts/board.mjs", 1, 1)],
    [f("scripts/arg.mjs", 2, 1)],
    [f("scripts/no-undo-audit.sh", 1, 1), f("scripts/no-undo-audit.test.mjs", 1, 1)],
    [f("scripts/claim-ticket.sh", 7, 0), f("scripts/claim-ticket.test.mjs", 20, 2)],
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

// #739. `tests-only` is assigned AHEAD of `single-file`/`small` in computeStats'
// else-if chain, so a config diff that also touches a test file never reaches
// SIZE_TIER_PROFILES and the #236 floor could not re-admit silent-failure. That
// made coverage NON-MONOTONIC: `ci.yml` alone kept the hunter and `ci.yml` + a
// test SUBTRACTED it — adding a file to a diff removed a specialist, on #236's
// own motivating class (CI gating logic, no src). The gate's other half — a pure
// test diff has no config, so it must still lose silent-failure — is already
// pinned above by `a tests-only diff drops types, silent-failure and simplify`.
test("a tests-only diff keeps the silent-failure floor when it also carries config", () => {
  const configPlusTest = [
    f(".github/workflows/ci.yml", 2, 1),
    f("scripts/ci-vacuous-green.test.mjs", 3, 1),
  ];
  assert.equal(computeStats(configPlusTest).profile, "tests-only");
  assert.deepEqual(dimensionKeys(configPlusTest), ["correctness", "silent-failure", "tests", "comments"]);
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
    dimensionKeys([f("scripts/a.mjs", 5, 5), f("scripts/b.mjs", 5, 4)]),
    ["correctness", "silent-failure", "comments"],
  );
});

// Same carve-out shape for `tests`: when the diff's substance IS a test, the
// mutation-discrimination check is the one it most needs. Without this the row
// below trims to whatever else the size tier keeps (`SIZE_TIER_DIMS`) — not
// restated here as a count, which is exactly what went stale last time (#218).
test("a small diff that adds a test keeps the tests dimension", () => {
  assert.deepEqual(
    dimensionKeys([f("scripts/a.mjs", 5, 5), f("scripts/a.test.mjs", 5, 5)]),
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

// #1349 removed the per-call `model` field entirely (per #1303's gap 3): no
// `agent()` call may carry `model`/`effort`, so DEFAULT_DIMENSIONS carries
// only `key`/`prompt`/`agentType` now, and tier lives in each fleet-owned
// `fleet-review-<key>` definition's own frontmatter instead — see
// review-core-parity.test.mjs for the parity pin between review-pr.js's
// namespaced copy and review-core.js's bare one. This replaces the retired
// "only the recoverable-miss dimensions carry a model downgrade" test, which
// pinned a field that no longer exists.
test("every dimension names a distinct fleet-owned agentType and carries no model field", () => {
  const byKey = Object.fromEntries(DEFAULT_DIMENSIONS.map((d) => [d.key, d]));
  for (const key of ["correctness", "silent-failure", "tests", "comments", "types", "simplify"]) {
    assert.equal(byKey[key].agentType, `fleet-ctl:fleet-review-${key}`);
    assert.equal(byKey[key].model, undefined, `${key} still carries a model field`);
  }
  assert.equal(new Set(DEFAULT_DIMENSIONS.map((d) => d.agentType)).size, DEFAULT_DIMENSIONS.length);
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
  // `silent-failure` and `tests` are dispatched under different fleet-owned
  // agent tiers (frontmatter, not a per-call field) and still draw the same
  // budget — the whole of why the retired rule did not
  // separate them. `suggestion` is the one band that differs, and it is a
  // SEVERITY, not a dimension.
  assert.equal(verifiersFor("important"), verifiersFor("critical"));
  assert.equal(verifiersFor("suggestion"), 0);
});

// --- args.dimensions normalization (#113). The "Specialists" section of
// `commands/review-and-fix.md` documents the override as
// accepting "keys or dimension objects"; before this, only objects worked and
// a key array passed through untouched, dereferencing `d.key`, `d.prompt`,
// `d.model` and `d.agentType` to `undefined` with no throw and no warning.
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
  // All three REQUIRED fields are checked, not just one. `model` is not among
  // them — #1349 retired it entirely (dispatch tier lives only in the agent
  // definition's own frontmatter now), and a caller that still sends one is
  // refused outright — see the dedicated test below, not this one.
  assert.throws(
    () => resolveDimensions([{}], DEFAULT_DIMENSIONS),
    /missing required field\(s\): key, prompt, agentType/,
  );
  assert.deepEqual(
    resolveDimensions([{ key: "x", prompt: "p", agentType: "a" }], DEFAULT_DIMENSIONS),
    [{ key: "x", prompt: "p", agentType: "a" }],
  );
});

// Presence alone let a non-string field (a number, an object, ...) straight
// through to the specialist dispatch machinery with no throw, contradicting
// this function's own job of validating the boundary. Mutation-verified: with
// the `wrongType` check in resolveDimensions loosened back to the
// presence-only `missing` check, this test reds.
test("a required field of the wrong type stops the run and names the field and the type it got", () => {
  assert.throws(
    () => resolveDimensions([{ key: 42, prompt: "p", agentType: "a" }], DEFAULT_DIMENSIONS),
    /review-pr: args\.dimensions\[0\] field "key" must be a string, got number$/,
  );
  // `0`, `""`, `null` etc are already caught as MISSING (falsy) above — a
  // truthy non-string, like an object, is the case the presence check lets
  // through unnoticed.
  assert.throws(
    () => resolveDimensions([{ key: "x", prompt: {}, agentType: "a" }], DEFAULT_DIMENSIONS),
    /review-pr: args\.dimensions\[0\] field "prompt" must be a string, got object$/,
  );
  assert.deepEqual(
    resolveDimensions([{ key: "x", prompt: "p", agentType: "a" }], DEFAULT_DIMENSIONS),
    [{ key: "x", prompt: "p", agentType: "a" }],
  );
});

// #1349 (per #1303's gap 3): `model` used to be a fourth, optional field on a
// dimension override, dereferenced at dispatch to override the tier. Now it
// is refused OUTRIGHT — any value, not just a wrong-typed one — because tier
// lives only in the fleet-owned agent definition's frontmatter, never per
// call. A caller-facing knob that silently worked on one harness and not the
// other is the exact shape #1349 exists to close, so this is loud rather than
// a silent no-op.
test("a dimension override carrying a model field is refused outright, regardless of its type", () => {
  assert.throws(
    () => resolveDimensions([{ key: "x", prompt: "p", agentType: "a", model: "opus" }], DEFAULT_DIMENSIONS),
    /review-pr: args\.dimensions\[0\] field "model" is no longer supported/,
  );
  assert.throws(
    () => resolveDimensions([{ key: "x", prompt: "p", agentType: "a", model: 7 }], DEFAULT_DIMENSIONS),
    /review-pr: args\.dimensions\[0\] field "model" is no longer supported/,
  );
  // A missing `model` is still fine — there is nothing left to demand.
  assert.deepEqual(
    resolveDimensions([{ key: "x", prompt: "p", agentType: "a" }], DEFAULT_DIMENSIONS),
    [{ key: "x", prompt: "p", agentType: "a" }],
  );
});

// #279. These five all used to produce "object is missing required field(s):
// key, prompt, agentType" — a message asserting the entry IS an object and
// sending the caller off to add three fields to a `42`. The type is the defect;
// say so. `null` and `undefined` are the case the old `!entry?.[f]` optional
// chain covered by accident: it kept the run from dying on an uncaught
// `TypeError: Cannot read properties of null (reading 'key')`, but it answered
// with the wrong diagnosis. The explicit type check answers with the right one.
test("a non-object entry is reported as the wrong TYPE, not as an object missing fields", () => {
  for (const [entry, name] of [
    [42, "number"],
    [null, "null"],
    [undefined, "undefined"],
    [true, "boolean"],
    [["x"], "array"],
  ]) {
    // Deliberately NOT anchored on the `[0]` index here — index coverage for
    // THIS type-mismatch branch is a dedicated assertion below, not this one:
    // dropping `[${i}]` from the throw does not fail #281's "identifies which
    // entry" test either, since that test only exercises the missing-field
    // and unknown-key branches. "Reverting one must red one" does not hold
    // for this branch without that dedicated assertion.
    assert.throws(
      () => resolveDimensions([entry], DEFAULT_DIMENSIONS),
      new RegExp(`review-pr: args\\.dimensions\\[0\\] must be a key string or a dimension object, got ${name}$`),
      `a ${name} entry no longer names its own type, and not as an object missing fields`,
    );
  }
});

// The loop above only ever indexes ONE entry ([0]), so it cannot pin the
// index for a multi-entry override — and separately from #281's "identifies
// which entry" test above, which never exercises this branch at all. Dropping
// `[${i}]` from the type-mismatch throw (workflows/review-pr.js) fails no
// test above. Mutation-verified: reverting the `${i}` in that throw back to a
// fixed string reds this assertion.
test("a type-mismatch entry error identifies which entry of a multi-entry override failed", () => {
  assert.throws(
    () => resolveDimensions(["correctness", 42], DEFAULT_DIMENSIONS),
    /review-pr: args\.dimensions\[1\] must be a key string or a dimension object, got number$/,
  );
});

// #281. With a multi-entry override the field names alone do not say WHICH
// entry is short — and the map callback has the index already. Both throwing
// branches carry it, so an unknown key in a long list is locatable too.
test("an entry error identifies which entry of a multi-entry override failed", () => {
  assert.throws(
    () => resolveDimensions(["correctness", "comments", { key: "x", agentType: "y" }], DEFAULT_DIMENSIONS),
    /args\.dimensions\[2\] is missing required field\(s\): prompt/,
  );
  assert.throws(
    () => resolveDimensions(["correctness", "not-a-real-dimension"], DEFAULT_DIMENSIONS),
    /args\.dimensions\[1\] named an unknown key "not-a-real-dimension"/,
  );
});

// #274. A repeated key resolved to two entries pointing at ONE dimension
// object: the fan-out dispatched the same specialist twice against a single
// scratch dir, and the coverage record double-counted it — which
// `run-team/SKILL.md` reads AS coverage. Redundant-but-valid input WHEN THE
// ENTRIES AGREE, so it dedupes silently in that case; throwing would refuse a
// request whose meaning is not in doubt. A DIVERGENT collision is a different
// case — see the dedicated test below.
test("a repeated key resolves once, and does not throw", () => {
  assert.deepEqual(
    resolveDimensions(["correctness", "comments", "correctness"], DEFAULT_DIMENSIONS),
    [DEFAULT_DIMENSIONS[0], DEFAULT_DIMENSIONS[3]],
  );
  // A key and the object it names are the same dimension; first occurrence wins.
  assert.deepEqual(
    resolveDimensions(["correctness", DEFAULT_DIMENSIONS[0]], DEFAULT_DIMENSIONS),
    [DEFAULT_DIMENSIONS[0]],
  );
  // Dedupe must not empty a set that had entries: an all-duplicate override
  // resolves to one dimension, not to the "resolved to no dimensions" throw.
  assert.equal(resolveDimensions(["types", "types", "types"], DEFAULT_DIMENSIONS).length, 1);
});

// A second entry sharing a key but DIVERGING (different `prompt`/`agentType`)
// used to dedupe SILENTLY too, discarding a caller's real attempt to
// override or customize a catalog entry with zero signal — the one silent
// exception to what this whole function exists to do (#279/#281 turn silent/
// ambiguous failures into loud, indexed ones). Mutation-verified: comparing
// only `d.key` in the dedupe loop (the old behaviour) reds this test; the
// identical-duplicate cases above stay green either way, so this is
// independent of them, not a replacement. `model` used to be a third
// divergence field here too, before #1349 retired it outright (see the
// dedicated "refused regardless of its type" test above) — a `model`-only
// divergence can no longer reach this comparison at all, since the field is
// refused before resolveDimensions ever gets to dedupe.
test("a repeated key with different fields throws — a divergent collision is not silently dropped", () => {
  const dup = { key: "correctness", prompt: "other", agentType: "code-reviewer" };
  assert.throws(
    () => resolveDimensions([DEFAULT_DIMENSIONS[0], dup], DEFAULT_DIMENSIONS),
    /review-pr: args\.dimensions\[1\] repeats key "correctness" with different fields$/,
  );
});

test("an override resolving to nothing stops the run", () => {
  assert.throws(() => resolveDimensions([], DEFAULT_DIMENSIONS), /resolved to no dimensions/);
});

test("a non-array override stops the run rather than crashing on .map", () => {
  assert.throws(() => resolveDimensions({ key: "correctness" }, DEFAULT_DIMENSIONS), /must be an array/);
});

// #278. The header claimed "the three fields the fan-out actually dereferences"
// and enumerated three; four were dereferenced, back when `model` was a
// fourth optional field. #1349 retired `model` entirely, so the
// dereferenced set is three again — `key`, `prompt`, `agentType` — and this
// pin now confirms the header says exactly that rather than re-asserting the
// four-field count #278 corrected. Derived from the source rather than
// hand-listed, because hand-derived count claims about this function have
// been wrong before (#118) — a fifth dereferenced field reds this and forces
// the prose to be updated with it.
test("the resolveDimensions header states the dereferenced-field situation correctly", () => {
  const m = SOURCE.match(/((?:^\/\/.*\n)+)^function resolveDimensions\(/m);
  assert.ok(m, "resolveDimensions no longer carries a header comment block — update this test");
  const header = m[1];
  // Comments stripped BEFORE deriving the dereferenced set: the header's own
  // prose lists `d.key`, `d.prompt`, `d.model`, `d.agentType` in backticks,
  // which matches the same `\bd\.` pattern used to derive the set. Deriving
  // from raw SOURCE would let the header vote for its own claim — it could
  // catch the header UNDER-counting a field the code dereferences, but never
  // OVER-counting one the code no longer does, since the header's mention
  // would keep padding the derived set to match itself.
  const dereferenced = [...new Set([...stripComments(SOURCE).matchAll(/\bd\.([a-zA-Z]+)/g)].map((x) => x[1]))].sort();
  assert.deepEqual(dereferenced, ["agentType", "key", "prompt"], "the dereferenced field set changed");
  for (const f of dereferenced) {
    assert.match(header, new RegExp("`d\\." + f + "`"), `the header no longer enumerates d.${f}`);
  }
  assert.doesNotMatch(header, /three fields the fan-out actually dereferences/, "the header undercounts again");
  assert.doesNotMatch(header, /absent means inherit/i, "the refuted reword is back — see the models-sent log");
});

// Everything above tests a LIFTED COPY. Nothing above proves review-pr.js
// wires resolveDimensions AND selectDimensions into the same call site:
// replacing it with `explicitDimensions || DEFAULT_DIMENSIONS` left this file
// green before (#118) by disconnecting the size tier, and a version that
// dropped resolveDimensions here would do the same to the override
// normalization, silently. This is the only assertion that fails on either.
//
// The two halves now sit ~570 lines apart (#275 moved normalization up to the
// required-args guard), so this pin is TWO pins — one per line. Weakening either
// to a looser match, or dropping one because the other still passes, restores
// exactly the hole #118 opened.
test("review-pr.js actually calls resolveDimensions, then selectDimensions, to pick the fan-out", () => {
  assert.match(
    SOURCE,
    /^const explicitDimensions = resolveDimensions\(A\.dimensions, DEFAULT_DIMENSIONS\);$/m,
    "the args.dimensions normalization changed — the override may be passed through unresolved",
  );
  assert.match(
    SOURCE,
    /^const dimensions = explicitDimensions \|\| selectDimensions\(DEFAULT_DIMENSIONS, stats\);$/m,
    "the dimensions call site changed — override normalization and/or size-tier selection may be disconnected",
  );
});

// #275, AC: "refused with no agent dispatched and no snapshot directory
// created". Both are pinned by ONE ordering fact, because the snapshot
// directory is `mkdir -p`'d inside the snapshot agent's own bash — the dispatch
// is the only thing that creates it. Asserting the message alone would stay
// green with the throw back below the snapshot, which is the whole defect.
//
// The workflow cannot be imported to test this by execution: it runs a
// top-level `await pipeline(...)` and compiles as a function body (#538), so
// source position is the observable. Same shape as
// review-pr-snapshot-path.test.mjs's guard-ordering pin.
test("an unresolvable override is refused before the snapshot agent is dispatched", () => {
  const resolveAt = SOURCE.indexOf("const explicitDimensions = resolveDimensions(A.dimensions, DEFAULT_DIMENSIONS);");
  const guardAt = SOURCE.indexOf('if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");');
  const snapshotAt = SOURCE.indexOf("const snap = await agent(");
  const mkdirAt = SOURCE.indexOf('mkdir -p "${runRootParent}"');
  assert.ok(resolveAt !== -1 && guardAt !== -1 && snapshotAt !== -1, "one of the three sites moved — update this test");
  assert.ok(guardAt < resolveAt, "the required-args guard no longer runs first — args.pr errors are now masked");
  assert.ok(
    resolveAt < snapshotAt,
    "args.dimensions is validated after the snapshot agent — a typo'd key pays for a snapshot agent first (#275)",
  );
  // The directory is created by that dispatch, not before it, so "no snapshot
  // directory" follows from "no dispatch" only while the mkdir stays inside.
  assert.ok(
    mkdirAt > snapshotAt,
    "the run-root mkdir moved out of the snapshot agent's bash — 'no directory created' no longer follows from 'no agent dispatched'",
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

// #1349 (per #1303's gap 3) retired the whole per-call override this test
// used to pin: `args.specialistModel`/per-dimension `model` are both gone,
// and no `agent()` call anywhere in review-pr.js may carry a `model` option
// at all — review-tier-audit.test.mjs is the general-purpose guard for that;
// this pin is the SPECIFIC regression check that the review dispatch's own
// options object never grows one back.
test("the review dispatch never carries a model option — tier lives only in agentType's definition", () => {
  assert.doesNotMatch(
    reviewDispatchOptions(),
    /\bmodel\s*:/,
    "the review dispatch carries a `model` option again — #1349 ruled that out entirely",
  );
  assert.doesNotMatch(
    stripComments(SOURCE),
    /specialistModel/,
    "args.specialistModel is back in CODE — #1349 retired this per-call override entirely (a comment explaining the removal is fine and expected)",
  );
});

// The log is the only runtime evidence of WHICH fleet-owned definition each
// dimension dispatched to — the tier itself is no longer runtime-visible
// here at all (#1349): it lives in that definition's own frontmatter, read
// off the definition file or the dispatch transcript, never off this log.
test("the dispatch log reports the agentType sent for each dimension, not a model tier", () => {
  const m = SOURCE.match(/^\s*`agents dispatched \$\{dimensions[\s\S]*?\n/m);
  assert.ok(m, "the `agents dispatched` log line is gone — nothing then reports which definition each dimension used");
  assert.match(m[0], /d\.agentType/, "the log no longer names the dispatched agentType");
  assert.doesNotMatch(m[0], /"frontmatter"|"inherit"/, "the log still reasons about a model tier that no agent() call carries anymore");
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
