import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./support/strip-comments.mjs";
import { Pin } from "./support/prose-pin.mjs";
import { suiteVerdictOf, unrunCrashed, sharedRunNote, FINDINGS_SCHEMA, CRASHED_REASON } from "../plugin/scripts/review-core.mjs";

// A dimension that crashed and a dimension that ran clean returned BYTE-
// IDENTICAL shapes: `findings: []` either way, with the key listed in
// `dimensionsRun` regardless (#137, #138). Nothing in this suite could see
// that mode — no test touched `FINDINGS_SCHEMA` or the verify stage's falsy-
// review branch at all — so a green run said nothing about it. This file is
// that missing eye.
//
// #2315: every run-quality verdict reads the review's ONE shared test run —
// `suiteVerdictOf(run)` — because no specialist runs the full suite any more.
// The fixtures below are that run's shape: the caller's `command` plus the
// test-run agent's exit status and counts. The verdict reads the run ALONE: no
// finding from any dimension can make a run usable or unusable, and no verdict
// on the run makes a dimension unrun (#3048).
//
// Pins read CODE, not SOURCE, wherever they read source text at all:
// `stripComments` exists because two pins in this directory were MEASURED
// vacuous against a field commented out with `/* */` (see strip-comments.mjs),
// and a schema pin written against raw source passes with the field dead under
// `additionalProperties: false`.
const REPO = join(import.meta.dirname, "..", "plugin");
const SOURCE = Pin.file(join(REPO, "scripts", "review-core.mjs"));
const CODE = stripComments(SOURCE.text);

// What the verdict says about a run, in one place: `{usable, reason}`, `reason`
// null exactly when the run is usable.
const reasonOf = (run) => suiteVerdictOf(run).reason;

// #2315's no-counts case, from its two causes: the test-run dispatch returned
// nothing at all, or it returned without a count (crash, deadline, no
// summary). Neither is ever a pass.
test("a shared run that returned nothing is not usable, and says why", () => {
  for (const dead of [null, undefined, false, 0, ""]) {
    const verdict = suiteVerdictOf(dead);
    assert.equal(verdict.usable, false, `a falsy shared run (${JSON.stringify(dead)}) must not be usable`);
    assert.equal(typeof verdict.reason, "string");
    assert.match(verdict.reason, /returned nothing/, "the reason no longer names a test run that returned nothing");
  }
});

// #137's case: the `'tests 0'` reading rule, given somewhere to land. The
// reason names the COMMAND, because "0 tests" without it sends a reader
// hunting for which command produced them.
test("a zero-test run is not usable, naming the command that produced no tests", () => {
  const verdict = suiteVerdictOf({ command: "npm test --", tests: 0, pass: 0, fail: 0 });
  assert.equal(verdict.usable, false, "a zero-test run must not be usable");
  assert.match(verdict.reason, /npm test --/, "the reason no longer names the command that produced no tests");
  assert.match(verdict.reason, /0 tests/);
});

// ABSENT or null is "no counts", not `tests: 0`: the test-run agent is told to
// omit a count the log does not state, so an absent one is a run that printed
// no summary — and its `error` says why, which the reason must carry.
test("a shared run that reported no count at all is not usable, carrying the agent's error", () => {
  for (const run of [{ command: "npm test --" }, { command: "npm test --", tests: null }]) {
    const verdict = suiteVerdictOf(run);
    assert.equal(verdict.usable, false, `a countless run (${JSON.stringify(run)}) must not be usable`);
    assert.match(verdict.reason, /no counts/);
  }
  assert.match(reasonOf({ command: "npm test --", error: "hit the 1800 s deadline" }), /hit the 1800 s deadline/);
});

// #3048: a run the review never started is not usable either, each with its OWN
// reason — the controller reads the no-slot one off `suiteVerdict.reason` to
// re-review under the next runner letter, so that text must stay what it keys
// on, and the install-skipped one must say which install failed.
test("a run that never started is not usable, the install-skipped and no-slot runs each with their own reason", () => {
  const skipped = suiteVerdictOf({ command: "npm test --", logPath: "/r/test-run.log", unprovisioned: "the Install step `sh ./install.sh` exited 3" });
  assert.deepEqual(skipped, { usable: false, reason: "the Install step `sh ./install.sh` exited 3" });
  const noSlot = suiteVerdictOf({ command: "npm test --", exitCode: 75, error: "suite-slot: no slot after 1800s" });
  assert.equal(noSlot.usable, false);
  assert.match(noSlot.reason, /^no suite slot within 1800 s/, "run-team/SKILL.md tells the controller this reason begins \"no suite slot\"");
  assert.notEqual(noSlot.reason, skipped.reason);
  // A run that printed counts and happened to exit 75 is the suite's own
  // answer, judged like any other — not a no-slot run.
  assert.doesNotMatch(reasonOf({ command: "npm test --", exitCode: 75, tests: 9, pass: 9, fail: 0 }) ?? "", /no suite slot/);
});

// THE REFUSAL SURFACE, and the half a suite fed only broken input cannot pin.
// A new required field and a new classifier are both refusal surfaces: a
// review whose run did its work must still come back usable.
test("a clean run is usable, with the reason null", () => {
  assert.deepEqual(
    suiteVerdictOf({ command: "npm test --", exitCode: 0, tests: 12, pass: 12, fail: 0 }),
    { usable: true, reason: null },
    "a shared run that passed is usable",
  );
});

// A suite with real failures RAN. Reading `fail > 0` as unusable would hide the
// one class of test result that most needs reporting — and since #3048 nothing
// else reads the findings either: a usable run is not a green one, so failing
// tests with NO kept finding from any dimension are still a usable run.
test("a run with failing or cancelled tests is usable, whatever any dimension filed", () => {
  assert.deepEqual(suiteVerdictOf({ command: "npm test --", exitCode: 1, tests: 14, pass: 11, fail: 3 }), { usable: true, reason: null });
  assert.deepEqual(suiteVerdictOf({ command: "node --test", exitCode: 1, tests: 744, pass: 738, fail: 6 }), { usable: true, reason: null });
  assert.deepEqual(suiteVerdictOf({ command: "node --test", exitCode: 1, tests: 744, pass: 743, fail: 0, cancelled: 1 }), { usable: true, reason: null });
  assert.deepEqual(suiteVerdictOf({ command: "node --test", exitCode: 1, tests: 10, pass: 9, fail: 1 }), { usable: true, reason: null });
});

// #143's all-skipped case, and the reason the clause reads `pass === 0 && !fail`
// rather than the bare "zero passes" #143's body proposes: a run where every
// test skipped arrives as `pass: 0` with `fail` zero or absent (the shared run
// may also report `skipped`, but the verdict never needs it). Nothing passed
// and nothing failed is no work done.
test("a run where nothing passed and nothing failed is not usable — every test skipped", () => {
  for (const run of [
    { command: "node --test", tests: 2, pass: 0, fail: 0 },
    { command: "node --test", tests: 2, pass: 0 },
  ]) {
    const verdict = suiteVerdictOf(run);
    assert.equal(verdict.usable, false, `an all-skipped run (${JSON.stringify(run)}) must not be usable`);
    assert.match(verdict.reason, /node --test/, "the reason no longer names the command that did no work");
  }
});

// #651: the clause above fired at EXACTLY zero, so one executed test bought a
// clean read — `tests 937 / pass 1 / fail 0` is a crash mid-suite, not a pass.
// The `pass` variants are the two shapes a no-failure run arrives in (`fail: 0`
// and `fail` absent, both falsy).
test("a run that executed a fraction of what it collected is not usable", () => {
  for (const run of [
    { command: "node --test", tests: 937, pass: 1, fail: 0 },
    { command: "node --test", tests: 937, pass: 1 },
    { command: "node --test", tests: 937, pass: 468, fail: 0 },
  ]) {
    const verdict = suiteVerdictOf(run);
    assert.equal(verdict.usable, false, `a mostly-unexecuted run (${JSON.stringify(run)}) must not be usable`);
    assert.match(verdict.reason, /node --test/, "the reason no longer names the command that ran a fraction of its collection");
    assert.match(verdict.reason, new RegExp(`${run.pass}\\b.*\\b${run.tests}\\b`), "the reason no longer reports both counts");
  }
});

// THE ACCEPT SIDE of #651's ratio, and the half a refuse-only pin cannot hold. A
// small suite is not a partial one: 3 of 3 is every test the tree has. The `todo`
// fixture is the MEASURED hazard the issue names — `node --test` counts a todo
// outside `pass` (tests 2 / pass 1 / fail 0 / todo 1), so a strict
// `pass + fail === tests` rule would refuse any host repo carrying one, and a
// floor at exactly half is what keeps it usable. `pass: null` is the optional
// field arriving explicitly empty: `null * 2 < tests` is 0 < tests, so only the
// `typeof` guard stops that from reading as no work.
test("a small-but-complete run, a half-todo run, and one that omitted pass are usable", () => {
  for (const run of [
    { command: "node --test", exitCode: 0, tests: 3, pass: 3, fail: 0 },
    { command: "node --test", exitCode: 0, tests: 937, pass: 937, fail: 0 },
    { command: "node --test", exitCode: 0, tests: 2, pass: 1, fail: 0 },
    { command: "node --test", exitCode: 0, tests: 937, pass: null },
  ]) {
    assert.equal(reasonOf(run), null, `a run that did its work (${JSON.stringify(run)}) must stay usable`);
  }
});

// The ratio must not swallow a failing suite that actually EXECUTED its whole
// collection: pass+fail equals tests here, so every test collected ran, and
// refusing it would be the over-refusal #137 removed.
test("a fully-executed failing run is usable by the ratio — a suite that failed ran", () => {
  assert.equal(reasonOf({ command: "node --test", exitCode: 1, tests: 10, pass: 4, fail: 6 }), null);
});

// #651 CONTINUED: the ratio sums pass AND fail against the half floor, so a
// crash that left even ONE failing test alongside its one pass still reads as
// a run that never got through its collection.
test("a run that executed a fraction of what it collected through a MIX of pass and fail is not usable", () => {
  for (const run of [
    { command: "node --test", tests: 937, pass: 1, fail: 1 },
    { command: "node --test", tests: 937, pass: 200, fail: 200 },
  ]) {
    const verdict = suiteVerdictOf(run);
    assert.equal(verdict.usable, false, `a mostly-unexecuted mixed run (${JSON.stringify(run)}) must not be usable`);
    assert.match(verdict.reason, /node --test/, "the reason no longer names the command that ran a fraction of its collection");
  }
});

// THE ACCEPT SIDE of the mixed-ratio test above: pass+fail reaching past half
// of tests is work done, whatever the split between the two.
test("a mixed pass/fail run that executed past half its collection is usable", () => {
  assert.equal(reasonOf({ command: "node --test", exitCode: 1, tests: 937, pass: 300, fail: 300 }), null);
});

// THE ACCEPT SIDE of the all-skipped clause, and the case a bare `pass 0` rule
// gets wrong: a suite where every test failed also reports zero passes, and it
// is the run that most needs reporting — refusing it is the over-refusal #137
// removed. Only a fixture with BOTH zero passes and failures can tell
// `pass === 0` from `pass === 0 && !fail` apart.
test("a run where every test failed is usable, even though nothing passed", () => {
  assert.equal(reasonOf({ command: "npm test --", exitCode: 1, tests: 3, pass: 0, fail: 3 }), null);
});

// #2879: vitest prints an `it.fails` test as its own `N expected fail` token,
// not as a failure. It ran, so it counts toward what the run executed; it
// failed by design, so it is nothing for the review to file. The `tests: 4`
// fixture clears the half floor ONLY through its expected fails (1 pass of 4
// collected), and the `pass: 0` fixture clears the all-skipped clause only
// through them — so dropping `expectedFail` from the executed sum reads each
// fixture unusable.
test("a run whose only non-pass is an expected fail is usable, and its expected fails count as executed", () => {
  for (const run of [
    { command: "vitest run", exitCode: 0, tests: 121, pass: 120, fail: 0, expectedFail: 1 },
    { command: "vitest run", exitCode: 0, tests: 4, pass: 1, fail: 0, expectedFail: 2 },
    { command: "vitest run", exitCode: 0, tests: 1, pass: 0, expectedFail: 1 },
  ]) {
    assert.equal(reasonOf(run), null, `a run whose non-passes are all expected fails (${JSON.stringify(run)}) must stay usable`);
  }
});

// The expected fails weigh one each against the half floor: 2 passes and 2
// expected fails of 10 collected is 4 executed and unusable, 3 and 2 is exactly
// half and usable — a weight other than one moves one of the two.
test("an expected fail counts once toward the half floor", () => {
  assert.match(reasonOf({ command: "vitest run", exitCode: 0, tests: 10, pass: 2, fail: 0, expectedFail: 2 }) ?? "", /most of what it collected never ran/);
  assert.equal(reasonOf({ command: "vitest run", exitCode: 0, tests: 10, pass: 3, fail: 0, expectedFail: 2 }), null);
});

// The other half: an expected fail is never failing, so it does not account
// for a non-zero exit, and a zero count of them leaves an all-skipped run
// unusable exactly as an absent one does.
test("an expected fail beside a non-zero exit, or as a zero count, changes no verdict", () => {
  const exitOnly = { command: "vitest run", exitCode: 1, tests: 10, pass: 9, fail: 0, expectedFail: 1 };
  assert.match(reasonOf(exitOnly) ?? "", /exited 1 but reported no failing or cancelled tests/, "an expected fail accounted for a non-zero exit");
  const skipped = { command: "vitest run", exitCode: 0, tests: 2, pass: 0, fail: 0, expectedFail: 0 };
  assert.match(reasonOf(skipped) ?? "", /every test skipped/, "a zero expected-fail count read an all-skipped run usable");
  // ...and beside a real failure the run is still usable: it ran.
  assert.equal(reasonOf({ command: "vitest run", exitCode: 1, tests: 10, pass: 8, fail: 1, expectedFail: 1 }), null);
});

// `pass`/`fail` are optional, so a run that reported only a count must still
// come back usable rather than tripping the predicate on a field the runner
// never printed.
test("a run that reported tests but not pass/fail is usable", () => {
  assert.equal(reasonOf({ command: "node --test", exitCode: 0, tests: 7 }), null, "an optional field's absence must not make a real run unusable");
});

// The exit status is the command's own verdict, and the counts must account
// for it. A run reporting none, or exiting non-zero with nothing failing or
// cancelled, is unusable whatever its counts say.
test("a run whose exit status is missing, or non-zero with no failing count, is not usable", () => {
  for (const [run, pattern] of [
    [{ command: "node --test", tests: 10, pass: 10, fail: 0 }, /no exit status/],
    [{ command: "node --test", exitCode: null, tests: 10, pass: 10 }, /no exit status/],
    [{ command: "node --test", exitCode: 1, tests: 10, pass: 10, fail: 0 }, /exited 1 but reported no failing or cancelled tests/],
    [{ command: "node --test", exitCode: 137, tests: 10, pass: 10 }, /exited 137/],
  ]) {
    const verdict = suiteVerdictOf(run);
    assert.equal(verdict.usable, false, `${JSON.stringify(run)} must not be usable`);
    assert.match(verdict.reason, pattern);
    assert.match(verdict.reason, /node --test/, "the reason no longer names the command");
  }
});

// #139: the description at `:37` called `scope_searched` **Required** while the
// `required` array omitted it, so a specialist that skipped it validated clean —
// reproducing the exact failure the description exists to prevent. Both halves
// pinned, because either one alone re-opens the ticket.
test("scope_searched is in the required array, not only in its own description", () => {
  const { required } = FINDINGS_SCHEMA;
  assert.ok(Array.isArray(required), "FINDINGS_SCHEMA no longer has a top-level required array — update this test");
  assert.ok(required.includes("scope_searched"), "scope_searched is documented Required and is not in the required array (#139)");
});

// The review's ONE shared run is the single record of the test run: a
// specialist is not asked to copy it, so the payload neither requires nor
// declares a field for the copy. Both halves pinned together, because under
// `additionalProperties: false` either one re-added alone is a contract the
// specialist cannot meet — a required field the schema rejects, or a declared
// one nothing reads.
test("FINDINGS_SCHEMA neither requires nor declares a specialist copy of the test run", () => {
  assert.deepEqual(
    [...FINDINGS_SCHEMA.required].sort(),
    ["dimension", "findings", "scope_searched"],
    "FINDINGS_SCHEMA's required list changed — a specialist must return exactly these",
  );
  assert.ok(!Object.hasOwn(FINDINGS_SCHEMA.properties, "test_run"), "FINDINGS_SCHEMA declares test_run again — nothing reads a specialist's copy of the shared run");
  assert.equal(FINDINGS_SCHEMA.additionalProperties, false);
});

// The verdict's shape, which the digest carries verbatim: `usable` is a boolean
// and `reason` is a string exactly when it is false, never undefined — a
// reader of the digest keys off `usable` and prints `reason`.
test("suiteVerdictOf returns {usable, reason} with reason null exactly when usable", () => {
  for (const run of [
    null,
    { command: "npm test --" },
    { command: "npm test --", exitCode: 0, tests: 9, pass: 9, fail: 0 },
    { command: "npm test --", exitCode: 1, tests: 9, pass: 6, fail: 3 },
    { command: "npm test --", logPath: "/r/test-run.log", unprovisioned: "install skipped" },
  ]) {
    const verdict = suiteVerdictOf(run);
    assert.deepEqual(Object.keys(verdict), ["usable", "reason"], "the verdict's keys changed");
    assert.equal(typeof verdict.usable, "boolean");
    assert.equal(verdict.reason === null, verdict.usable, `reason must be null exactly when usable (${JSON.stringify(run)})`);
    if (!verdict.usable) assert.equal(typeof verdict.reason, "string");
  }
});

// #138's ACTUAL case, and the one its first attempt could not reach. `pipeline()`
// short-circuits between stages — the harness runs `if (result === null) break`
// before the next stage — so a reviewer that returned null never enters the verify
// closure, and a recording living there sees every dimension except the dead one.
// The pipeline's RESULT still shows it: one slot per dimension, in order, null
// where the chain died. This runs that derivation rather than reading it.
test("a dimension whose chain died is recorded unrun, by index, from the pipeline result", () => {
  const dimensions = [{ key: "correctness" }, { key: "tests" }, { key: "types" }];
  const unrun = unrunCrashed([[], null, []], dimensions);
  assert.deepEqual(
    unrun.map((u) => u.dimension),
    ["tests"],
    "a null pipeline slot must record ITS dimension unrun, and only it (#138)",
  );
  assert.equal(unrun[0].reason, CRASHED_REASON, "the crashed dimension's reason no longer names a reviewer that returned nothing");
  assert.match(CRASHED_REASON, /returned nothing/);
  assert.deepEqual(
    unrunCrashed([[], [], []], dimensions),
    [],
    "a dimension that reached the verify stage is not crashed — this must not re-refuse a clean run",
  );
  // An empty findings array is the SHAPE a clean dimension returns, and it is
  // falsy nowhere; reading emptiness as death is the over-refusal #137 removed.
  assert.deepEqual(unrunCrashed([[]], [{ key: "types" }]), [], "an empty findings list from a live dimension is not a crash");
});

// The adjacent case, which is about this derivation rather than about a reviewer:
// it runs after every specialist and refuter has finished, so a throw here costs
// the entire run's findings. A slot it cannot name must still come back named.
test("a null slot the dimension list cannot explain is still reported, never thrown on", () => {
  const unrun = unrunCrashed([null], []);
  assert.equal(unrun.length, 1, "a slot with no matching dimension must still be recorded unrun");
  assert.match(unrun[0].dimension, /slot 0/, "an unnameable slot must say which slot it was");
});

// Wiring, not classification — and textual, because it has to be. Both are
// executable above; whether runReview calls them is pinned here. Stated
// ceiling: this sees a call deleted or moved, and does not see one wrapped in a
// guard of its own. That is why the classification moved behind lifted
// functions — the pin it replaced had source positions as its only evidence.
// runReview's own behaviour over a scripted host is review-core-shared-test-run.test.mjs's.
test("the crash writer is wired in AFTER the pipeline, and the suite verdict is read off the shared run alone", () => {
  // AFTER the pipeline returns, never inside a stage: a stage cannot observe its
  // own absence (#138).
  const call = CODE.indexOf("const reviewed = await pipeline(");
  assert.notEqual(call, -1, "the pipeline call moved — update this test");
  const writer = "dimensionsUnrun.push(...unrunCrashed(reviewed, dimensions))";
  const at = CODE.indexOf(writer);
  assert.notEqual(at, -1, `\`${writer}\` is gone — a crashed dimension is unreachable again`);
  assert.ok(call < at, `\`${writer}\` runs before the pipeline returns, where its input does not exist yet`);
  assert.ok(CODE.includes("const suiteVerdict = suiteVerdictOf(sharedRun)"), "the suite verdict is no longer read off the shared run alone");
  // The shared run never marks a dimension unrun (#3048): neither classifier
  // that did is allowed back.
  assert.doesNotMatch(CODE, /\bunrunReason\b|\bunrunEntries\b/, "a classifier that reported a shared-run verdict as a dimension's is back");
});

test("the returned object carries suiteVerdict and dimensionsUnrun alongside dimensionsRun, in digest order", () => {
  assert.match(CODE, /const dimensionsUnrun = \[\]/, "dimensionsUnrun is never declared — the return would throw");
  const at = CODE.lastIndexOf("return {");
  assert.notEqual(at, -1, "review-core.mjs no longer ends in a return literal — update this test");
  const tail = CODE.slice(at);
  // `dimensionsRun` keeps its meaning and its value — the dispatched set after
  // the size trim — because a consumer diffing it against DEFAULT_DIMENSIONS to
  // spot a trim would otherwise read a crashed dimension as a trimmed one: the
  // same conflation this ticket set closes, one field over. The unrun list is
  // what subtracts from it, which only works if it ships too.
  assert.match(tail, /dimensionsRun: dimensions\.map\(\(d\) => d\.key\)/, "dimensionsRun no longer reports the dispatched set");
  assert.match(tail, /dimensionsUnrun/, "the return never surfaces dimensionsUnrun — the classification dies in the script (#137, #138)");
  assert.match(tail, /\n\s+suiteVerdict,\n/, "the return never surfaces suiteVerdict — the verdict dies in the script (#3048)");
  const order = ["testEnvironment", "suiteVerdict", "dimensionsRun", "dimensionsUnrun", "cwdAudit"].map((k) => tail.search(new RegExp(`\\n\\s+${k}\\b`)));
  assert.ok(order.every((n, i) => n !== -1 && (i === 0 || order[i - 1] < n)), `the return's digest keys are out of order: ${order}`);
});

// The note hands every specialist the shared run and tells it not to run the
// full command itself — and nothing more about the run: the shared run is the
// single record of it, so no specialist is told to report or copy it anywhere.
// Every rendering the note has is checked — usable, each reason a run is NOT
// usable (each reason's own text is interpolated into that paragraph), and
// failing or cancelled tests for the owner and for a non-owner — because each
// appends a different paragraph to the same opening one.
//
// The no-copy check reads the whole note with its line wrapping flattened, so
// a request appended after the opening paragraph, or one the hard wrap splits
// across two lines, is still one sentence to it. It is a bounded word list, not
// a proof: a request worded with a verb or noun outside the lists passes it.
// COPY_REQUEST matches three shapes: a copy verb followed within a few words
// by the run, its counts, its log or its result; a copy verb followed in the
// same sentence by a destination in the specialist's own output ("in your
// result", "to the payload"); and the run, counts or log said to "must be"
// reported, returned, included and the like. The verbs are whole words, so
// inflected ones never match as written — and must not be widened to
// inflections, because the "no exit status" rendering's own "reported counts
// but no exit status" would then match. The word window is what keeps the
// opening paragraph's "your own copy of the snapshot are still yours to run"
// green: it uses `copy` as a noun and ends on `run` in the same sentence.
// Every rendering below must pass it. The run-is-null reason ("returned
// nothing") is not rendered here: sharedRunNote dereferences run.command, and
// that text reaches a note only as the "(the test-run agent returned nothing)"
// error suffix runReview sets.
const COPY_VERB = "report|copy|echo|record|return|repeat|restate|include|paste|attach|quote|put|add|list";
const COPY_OBJECT = "run|counts?|logs?|results?";
const COPY_REQUEST = new RegExp(
  [
    String.raw`\b(?:${COPY_VERB})\b(?:\s+[^\s.]+){0,4}?\s+(?:${COPY_OBJECT})\b`,
    String.raw`\b(?:${COPY_VERB})\b[^.]*\b(?:in|to|into)\s+(?:your|the)\s+(?:\w+\s+)?(?:result|payload|scope_searched|summary|findings?)\b`,
    String.raw`\b(?:${COPY_OBJECT})\b(?:\s+[^\s.]+){0,3}?\s+(?:must|should|shall)\s+be\s+(?:report|return|includ|record|cop|attach|quot|past|echo|list|add|put)\w*`,
  ].join("|"),
  "i",
);
test("the shared-run note hands over the run and forbids a rerun, and asks for no copy of it in any rendering", () => {
  const base = { command: "node --test", logPath: "/r/test-run.log" };
  const usable = { ...base, exitCode: 0, tests: 5, pass: 5, fail: 0 };
  const failing = { ...base, exitCode: 1, tests: 5, pass: 3, fail: 2 };
  const cancelled = { ...base, exitCode: 1, tests: 5, pass: 4, fail: 0, cancelled: 1 };
  const unusable = (why) => new RegExp(`This run is NOT usable: \`node --test\` ${why}`);
  for (const [name, run, key, paragraph] of [
    ["usable", usable, "tests", null],
    ["no counts", { ...base, error: "no summary" }, "tests", unusable("produced no counts")],
    ["0 tests", { ...base, exitCode: 0, tests: 0, pass: 0, fail: 0 }, "tests", unusable("produced 0 tests")],
    ["every test skipped", { ...base, exitCode: 0, tests: 5, pass: 0, fail: 0 }, "tests", unusable("passed nothing and failed nothing")],
    ["most never ran", { ...base, exitCode: 0, tests: 10, pass: 2, fail: 0 }, "tests", unusable("passed 2 and failed 0 of the 10")],
    ["no exit status", { ...base, tests: 5, pass: 5, fail: 0 }, "tests", unusable("reported counts but no exit status")],
    ["non-zero exit, nothing failing", { ...base, exitCode: 1, tests: 5, pass: 5, fail: 0 }, "tests", unusable("exited 1 but reported no failing")],
    ["failing, owner", failing, "correctness", /filing them is YOUR job in this review/],
    ["failing, non-owner", failing, "tests", /the correctness dimension files the finding/],
    ["cancelled, owner", cancelled, "correctness", /cancelled tests, and filing them is YOUR job/],
    ["cancelled, non-owner", cancelled, "tests", /cancelled tests, and the correctness dimension files/],
  ]) {
    const note = sharedRunNote(run, "correctness", key);
    assert.doesNotMatch(note, /test_run/, `${name}: the note still names test_run`);
    // #3048: a shared run never makes a dimension unrun, so no rendering says
    // so — the NOT-usable one says the review's suite verdict is not usable.
    assert.doesNotMatch(note, /unrun/i, `${name}: the note says a dimension is reported unrun for the shared run`);
    assert.match(note, /Do NOT run that full command yourself/, `${name}: the note no longer forbids a rerun`);
    assert.match(note, /\n {2}command: node --test\n/, `${name}: the note lacks the command line`);
    assert.match(note, /\n {2}counts: {2}\S/, `${name}: the note lacks the counts line`);
    assert.match(note, /\n {2}exit: {4}\S/, `${name}: the note lacks the exit line`);
    assert.match(note, /\n {2}log: {5}\/r\/test-run\.log\n/, `${name}: the note lacks the log line`);
    // The opening paragraph ends on the log instruction: nothing after it
    // asks the specialist to report the run.
    const first = note.split(/\n(?=This run is NOT usable|It has )/)[0];
    assert.match(first, /Read the log for anything the counts do not say\.$/, `${name}: the opening paragraph says more after the log instruction`);
    // ...and no paragraph this rendering appends asks for one either.
    assert.doesNotMatch(note.replace(/\s+/g, " "), COPY_REQUEST, `${name}: the note asks the specialist to report or copy the run`);
    if (paragraph) assert.match(note, paragraph, `${name}: the paragraph this rendering appends is missing`);
  }
});

// The workflow's return shape is documented in one place a controller actually
// reads, and this repo's recurring defect is a second copy disconnecting in one
// token. A `dimensionsUnrun` or a `suiteVerdict` nobody is told to read is a
// field nobody reads.
test("run-team's Reviewers section documents dimensionsUnrun and suiteVerdict, not only dimensionsRun", () => {
  const doc = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
  assert.match(doc, /dimensionsUnrun/, "run-team/SKILL.md still documents a return shape without dimensionsUnrun");
  assert.match(doc, /`suiteVerdict`/, "run-team/SKILL.md still documents a return shape without suiteVerdict");
  // The superseded workaround must be GONE, not merely accompanied. It reads
  // every zero-finding dimension as unrun — including one that ran clean — so
  // leaving it in place next to the real field teaches the opposite rule.
  assert.doesNotMatch(
    doc,
    /a dimension listed\s+in `dimensionsRun` with nothing in `survived`\/`refuted`\/`unverified` is \*\*unrun,\s+not clean\*\*/,
    "run-team/SKILL.md still states the pre-#137 workaround, which marks a clean dimension unrun",
  );
});

// What the absence of an unrun entry ESTABLISHES is that the specialist
// RETURNED a review — never that the dimension is covered. `suiteVerdictOf` above
// reads the shared run's counts and quotes its `command` into its message; it
// never judges what that command covers, and a key's absence from
// `dimensionsUnrun` says nothing about the suite at all. Comparing the command
// against the dispatched one was refuted 2-0 and stays refuted (#535) — the doc
// claiming only what the field can see is the remedy, and nothing pinned the
// word it turns on.
//
// The positive pin carries the claim: sliced to the paragraph so a failure
// prints it rather than the whole 2000-line doc, matched through `phrase` so a
// reflow of the hard wrap cannot fire it, and run out to the sentence's `;` so
// the clause has to END there. That terminator is what catches the likelier
// regression — an editor softening rather than reverting, `returned a review AND
// IS THEREFORE COVERED` — which a pin on the anchor alone reads as still present.
// The exclusion then has nothing left to guess at, so it stays whole-doc and
// case-insensitive: the retracted claim is caught wherever in the file it comes
// back, and in the lowercase paraphrase a `phrase` pin on `NOT` walks past.
test("run-team claims a review RETURNED from a key's absence from dimensionsUnrun, never that it is covered", () => {
  const doc = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
  const para = Pin.of(doc, "doc").between("**`dimensionsRun` is the dispatch", "The rule this replaces", "run-team/SKILL.md").text;
  assert.match(
    para,
    Pin.phrase("and NOT in `dimensionsUnrun` returned a review;"),
    "run-team/SKILL.md no longer says a key absent from dimensionsUnrun returned a review, full stop",
  );
  assert.doesNotMatch(
    doc,
    /in\s+`dimensionsUnrun`\s+is\s+covered/i,
    "run-team/SKILL.md reads a key's absence from dimensionsUnrun as coverage — nothing checked what the specialist covered",
  );
});

// The same claim on the OTHER surface, and the half nothing was watching. The
// pin above reads run-team/SKILL.md only, so when #535 corrected the doc, the
// classifier's own comment kept asserting the retracted equivalence — "a key in
// the first and not the second is the only thing that means covered" — and this
// suite stayed green on it (#1143). Source is where a reader arrives BEFORE the
// doc, so it is the copy that gets to mislead first.
//
// Reads SOURCE, not CODE — inverting this file's header rule, for that rule's
// own reason. `stripComments` exists so that no pin can be satisfied by
// commented-out text; here the comment IS the subject, and CODE has it stripped
// to nothing, which would make this pin unsatisfiable rather than vacuous.
//
// `.stripGutter("//")` first, and it buys BOTH halves: the clause wraps
// mid-sentence at a `// ` that `phrase`'s `\s+` cannot span, and the block's
// bare `//` separator line becomes a real blank line — which is what lets the
// SHARED `paragraph` bound apply here instead of a local copy of
// quiet-payload-prose.test.mjs's comment-block-above slicer, `paragraph`'s own
// doc-comment being where this repo says a local copy is the defect, not a
// style choice. Slice and anchor are then the sibling pin's exactly:
// `anchorAt`'s exactly-once guarantee, and an end bound at the paragraph rather
// than one running past the block into the `return` below it.
//
// The positive pin runs out through `covered.` for the SKILL.md pin's reason —
// the likelier regression is an editor softening rather than reverting, and a
// pin stopping at `returned a review` reads `returned a review and is therefore
// covered` as still present. The exclusion is whole-file and case-insensitive so
// the retracted wording is caught wherever it comes back, and it targets `only
// thing that means covered` rather than `covered` alone so the paragraph's own
// correct denials — which must keep saying the word — stay green.
test("review-core.mjs's own comment claims a review RETURNED from a key's absence from dimensionsUnrun, never that it is covered", () => {
  const prose = SOURCE.stripGutter("//").text;
  const para = Pin.of(prose, "prose").paragraph("`dimensionsRun` names what was DISPATCHED", "review-core.mjs", "`suiteVerdict` is the review's one judgement").text;
  assert.match(
    para,
    Pin.phrase("A key in the first and NOT in the second returned a review — not that it is covered."),
    "review-core.mjs's dimensionsRun/dimensionsUnrun comment no longer says a key absent from dimensionsUnrun returned a review, full stop",
  );
  assert.doesNotMatch(
    prose,
    /only\s+thing\s+that\s+means\s+covered/i,
    "review-core.mjs is back to reading a key's absence from dimensionsUnrun as coverage (#535)",
  );
});

// #3048: the two words the digest now keeps apart are defined where the
// project's language lives, each saying what the other does not: an unrun
// dimension is a crash and never the suite's state; a suite verdict is a
// judgement on the run and never on whether a dimension reviewed.
test("CONTEXT.md defines Unrun dimension and Suite verdict, each excluding the other's case", () => {
  const context = Pin.file(join(REPO, "..", "CONTEXT.md"));
  const unrunTerm = context.paragraph("**Unrun dimension**:", "CONTEXT.md's Unrun dimension", "**Suite verdict**:").text;
  assert.match(unrunTerm, Pin.phrase("A dispatched specialist that returned nothing, even after the review's in-run retry."));
  assert.match(unrunTerm, Pin.phrase("the state of the test suite never makes a dimension unrun"));
  const verdictTerm = context.paragraph("**Suite verdict**:", "CONTEXT.md's Suite verdict", "### Release outcome").text;
  assert.match(verdictTerm, Pin.phrase("Usable does not mean green: a usable run can have failing tests."));
  assert.match(verdictTerm, Pin.phrase("The verdict says nothing about whether any dimension reviewed."));
});
