import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between, phrase } from "./prose-pin.mjs";

// A dimension that crashed and a dimension that ran clean returned BYTE-
// IDENTICAL shapes: `findings: []` either way, with the key listed in
// `dimensionsRun` regardless (#137, #138). Nothing in this suite could see
// that mode — no test touched `FINDINGS_SCHEMA` or the verify stage's falsy-
// review branch at all — so a green run said nothing about it. This file is
// that missing eye.
//
// Pins read CODE, not SOURCE, wherever they read source text at all:
// `stripComments` exists because two pins in this directory were MEASURED
// vacuous against a field commented out with `/* */` (see strip-comments.mjs),
// and a schema pin written against raw source passes with the field dead under
// `additionalProperties: false`.
//
// That stripper is LINE-BASED, though, and its ceiling was measured here too: an
// entry commented out INSIDE an array literal — `["dimension", /* "x", */ …]` —
// survives stripping, so a `required:\s*\[([^\]]*)\]` match still sees the
// quoted text while the real array has lost it. So the schema pins below read no
// text at all. They EVALUATE the declaration and assert against the object,
// which is the one reader a comment cannot fool.
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
const CODE = stripComments(SOURCE);

// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported, so
// the seam is lifted out of the source text — the same technique
// `review-pr-testcmd.test.mjs` uses for `resolveTestCmd`. It only works while
// these stay PURE: a free variable (`testCmd`, `snap`) would throw a
// ReferenceError here on the branch that reads it, which is a property worth
// having anyway. All three go into ONE scope because each calls the one before
// it — `unrunEntries` wraps `unrunReason`, `unrunCrashed` wraps `unrunEntries`.
//
// Does NOT route through lift.mjs's single-function lift(), even for
// `unrunReason` alone: every one of these three is exercised directly by a
// test below, and `unrunEntries`/`unrunCrashed` call their callee BY NAME in
// the lifted source text, so each needs every function it calls present in
// its own `new Function` eval scope — measured, isolating `unrunEntries`
// through `lift(CODE, "unrunEntries", "review, dimension")` alone throws
// "unrunReason is not defined" the first time the returned function runs.
// Same class of incompatibility as `selectDimensions`/`verifiersFor` below in
// select-dimensions.test.mjs, just interdependence instead of a closed-over
// const or an injected parameter.
const SEAM = ["unrunReason(review)", "unrunEntries(review, dimension)", "unrunCrashed(reviewed, dimensions)"];
function liftSeam() {
  const bodies = SEAM.map((sig) => {
    const m = CODE.match(new RegExp(`^function ${sig.replace(/[()]/g, "\\$&")} \\{[\\s\\S]*?^\\}$`, "m"));
    assert.ok(m, `review-pr.js no longer declares ${sig} at top level — update this test`);
    return m[0];
  });
  return new Function(`${bodies.join("\n")}\nreturn { ${SEAM.map((sig) => sig.slice(0, sig.indexOf("("))).join(", ")} };`)();
}
const { unrunReason, unrunEntries, unrunCrashed } = liftSeam();

// #138's case. The `review &&` guard the ticket cites proves the author already
// expects a falsy return here — spend limit, timeout, terminal error — and the
// `[]` it produced was indistinguishable from a clean pass.
test("a reviewer that returned nothing is unrun, and says why it might have", () => {
  for (const dead of [null, undefined, false, 0, ""]) {
    const reason = unrunReason(dead);
    assert.equal(typeof reason, "string", `a falsy review (${JSON.stringify(dead)}) must yield a reason`);
    assert.match(reason, /returned nothing/, "the reason no longer names a reviewer that returned nothing");
  }
});

// #137's case: the `'tests 0'` reading rule the specialist prompt already
// states, given somewhere to land. The reason names the COMMAND, because
// "0 tests" without it sends a reader hunting for which command produced them.
test("a zero-test run is unrun, naming the command that produced no tests", () => {
  const reason = unrunReason({
    dimension: "tests",
    scope_searched: "the whole snapshot",
    findings: [],
    test_run: { command: "npm test --", tests: 0, pass: 0, fail: 0 },
  });
  assert.equal(typeof reason, "string", "a zero-test run must yield a reason");
  assert.match(reason, /npm test --/, "the reason no longer names the command that produced no tests");
});

// ABSENT or null is the same fact as `tests: 0` — nothing ran — and it is the
// whole reason the check is `!run.tests` rather than `run.tests === 0`. Measured
// unpinned: the narrower comparison passed all 737 tests in the repo.
test("a test_run that reported no count at all is unrun", () => {
  for (const run of [{ command: "npm test --" }, { command: "npm test --", tests: null }]) {
    const reason = unrunReason({ dimension: "tests", scope_searched: "x", findings: [], test_run: run });
    assert.equal(typeof reason, "string", `a countless test_run (${JSON.stringify(run)}) must yield a reason`);
  }
});

// A specialist that ignored the schema is the same fact from a different
// cause, and must not read as covered because the field it skipped is the one
// being tested.
test("a review reporting no test run at all is unrun", () => {
  const reason = unrunReason({ dimension: "types", scope_searched: "src/", findings: [] });
  assert.equal(typeof reason, "string", "a missing test_run must yield a reason");
  assert.match(reason, /no test run/, "the reason no longer says the reviewer reported no test run");
});

// THE REFUSAL SURFACE, and the half a suite fed only broken input cannot pin.
// A new required field and a new unrun predicate are both refusal surfaces: a
// specialist that legitimately has nothing to report must still come back
// clean. Marking a genuinely clean dimension unrun re-runs work that was done
// and teaches a controller to ignore the field — the same end state as not
// having it.
test("a clean review with an empty findings list is NOT unrun", () => {
  assert.equal(
    unrunReason({
      dimension: "silent-failure",
      scope_searched: "grep -rn 'catch' over the diff's 4 files",
      findings: [],
      test_run: { command: "npm test --", tests: 12, pass: 12, fail: 0 },
    }),
    null,
    "a dimension that ran the suite and found nothing is clean, not unrun",
  );
});

// A suite with real failures RAN. Reading `fail > 0` as unrun would hide the
// one class of test result that most needs reporting.
test("a run with failing tests is NOT unrun", () => {
  assert.equal(
    unrunReason({
      dimension: "tests",
      scope_searched: "the snapshot's own suite",
      findings: [{ severity: "critical", claim: "x", evidence: "y" }],
      test_run: { command: "npm test --", tests: 14, pass: 11, fail: 3 },
    }),
    null,
    "a suite that reported failures still ran",
  );
});

// #143's all-skipped case, and the reason the clause reads `pass === 0 && !fail`
// rather than the bare "zero passes" #143's body proposes. `skipped` is NOT a
// declared field of `test_run` (see the schema pin below), and whether
// `additionalProperties: false` drops such a field or rejects the whole object
// is stated BOTH ways in this directory and is not settled here — either way it
// never reaches this classifier, so a run where every test skipped can only
// arrive as `pass: 0` with `fail` zero or absent. Nothing passed and nothing
// failed is no work done.
// BOTH arms of `findings`, because this clause is findings-INDEPENDENT by
// design and only a non-empty fixture says so. The sibling `fail > 0` clause
// below is the one that reads `findings`; ANDing `!review.findings?.length` in
// here too would let a specialist that reports 0 passes and 0 fails and attaches
// one filler finding read as clean — the loophole #143 exists to close. Every
// fixture here sent `[]`, so that mutation survived the whole suite.
test("a run where nothing passed and nothing failed is unrun — every test skipped", () => {
  for (const findings of [[], [{ severity: "suggestion", claim: "x", evidence: "y" }]]) {
    for (const run of [
      { command: "node --test", tests: 2, pass: 0, fail: 0 },
      { command: "node --test", tests: 2, pass: 0 },
    ]) {
      const reason = unrunReason({ dimension: "tests", scope_searched: "x", findings, test_run: run });
      const where = `${JSON.stringify(run)} with ${findings.length} findings`;
      assert.equal(typeof reason, "string", `an all-skipped run (${where}) must yield a reason`);
      assert.match(reason, /node --test/, "the reason no longer names the command that did no work");
    }
  }
});

// #651: the clause above fired at EXACTLY zero, so one executed test bought a
// clean read — `tests 937 / pass 1 / fail 0` is a crash mid-suite, not a pass.
// The `pass` variants are the two shapes a no-failure run arrives in (`fail: 0`
// and `fail` absent, both falsy); the fixture with a finding attached is there
// for the same reason the all-skipped one is — this clause is findings-
// INDEPENDENT, and every fixture sending `[]` is how that mutation survives.
test("a run that executed a fraction of what it collected is unrun, not clean", () => {
  for (const findings of [[], [{ severity: "suggestion", claim: "x", evidence: "y" }]]) {
    for (const run of [
      { command: "node --test", tests: 937, pass: 1, fail: 0 },
      { command: "node --test", tests: 937, pass: 1 },
      { command: "node --test", tests: 937, pass: 468, fail: 0 },
    ]) {
      const reason = unrunReason({ dimension: "tests", scope_searched: "x", findings, test_run: run });
      const where = `${JSON.stringify(run)} with ${findings.length} findings`;
      assert.equal(typeof reason, "string", `a mostly-unexecuted run (${where}) must yield a reason`);
      assert.match(reason, /node --test/, "the reason no longer names the command that ran a fraction of its collection");
      assert.match(reason, new RegExp(`${run.pass}\\b.*\\b${run.tests}\\b`), "the reason no longer reports both counts");
    }
  }
});

// THE ACCEPT SIDE of #651's ratio, and the half a refuse-only pin cannot hold. A
// small suite is not a partial one: 3 of 3 is every test the tree has. The `todo`
// fixture is the MEASURED hazard the issue names — `node --test` counts a todo
// outside `pass` (tests 2 / pass 1 / fail 0 / todo 1), so a strict
// `pass + fail === tests` rule would refuse any host repo carrying one, and a
// floor at exactly half is what keeps it clean. `pass: null` is the optional
// field arriving explicitly empty: `null * 2 < tests` is 0 < tests, so only the
// `typeof` guard stops that from reading as no work.
test("a small-but-complete run, a half-todo run, and one that omitted pass are NOT unrun", () => {
  for (const run of [
    { command: "node --test", tests: 3, pass: 3, fail: 0 },
    { command: "node --test", tests: 937, pass: 937, fail: 0 },
    { command: "node --test", tests: 2, pass: 1, fail: 0 },
    { command: "node --test", tests: 937, pass: null },
  ]) {
    assert.equal(
      unrunReason({ dimension: "tests", scope_searched: "the snapshot's own suite", findings: [], test_run: run }),
      null,
      `a run that did its work (${JSON.stringify(run)}) must stay clean`,
    );
  }
});

// The ratio must not swallow a failing suite that actually EXECUTED its whole
// collection: pass+fail equals tests here, so every test collected ran, and
// refusing it would be the over-refusal #137 removed — reached only because
// this fixture files findings, which is what keeps the sibling clause below
// off it.
test("a fully-executed failing run is NOT unrun by the ratio — a suite that failed ran", () => {
  assert.equal(
    unrunReason({
      dimension: "tests",
      scope_searched: "the snapshot's own suite",
      findings: [{ severity: "critical", claim: "x", evidence: "y" }],
      test_run: { command: "node --test", tests: 10, pass: 4, fail: 6 },
    }),
    null,
    "a suite that reported failures still ran, having executed everything it collected",
  );
});

// #651 CONTINUED: the ratio clause above was gated on `!run.fail`, so a crash
// that left even ONE failing test alongside its one pass skipped it entirely
// and fell to the CONJUNCTION clause below, which one filed finding defeats —
// `{tests:937, pass:1, fail:1}` plus a finding read clean, 935 of 937 never
// run. The ratio now sums pass AND fail against the same half floor, findings-
// INDEPENDENT for the same reason the fail-free ratio test above is.
test("a run that executed a fraction of what it collected through a MIX of pass and fail is unrun", () => {
  for (const findings of [[], [{ severity: "suggestion", claim: "x", evidence: "y" }]]) {
    for (const run of [
      { command: "node --test", tests: 937, pass: 1, fail: 1 },
      { command: "node --test", tests: 937, pass: 200, fail: 200 },
    ]) {
      const reason = unrunReason({ dimension: "tests", scope_searched: "x", findings, test_run: run });
      const where = `${JSON.stringify(run)} with ${findings.length} findings`;
      assert.equal(typeof reason, "string", `a mostly-unexecuted mixed run (${where}) must yield a reason`);
      assert.match(reason, /node --test/, "the reason no longer names the command that ran a fraction of its collection");
    }
  }
});

// THE ACCEPT SIDE of the mixed-ratio test above: pass+fail reaching past half
// of tests is work done, whatever the split between the two. A finding is
// attached so the sibling CONJUNCTION clause (`fail > 0 && no findings`)
// cannot be the thing keeping this clean — only the ratio is under test here.
test("a mixed pass/fail run that executed past half its collection is NOT unrun", () => {
  assert.equal(
    unrunReason({
      dimension: "tests",
      scope_searched: "the snapshot's own suite",
      findings: [{ severity: "critical", claim: "x", evidence: "y" }],
      test_run: { command: "node --test", tests: 937, pass: 300, fail: 300 },
    }),
    null,
    "a mixed run past the half floor did its work",
  );
});

// THE ACCEPT SIDE of the clause above, and the case a bare `pass 0` rule gets
// wrong: a suite where every test failed also reports zero passes, and it is the
// run that most needs reporting — refusing it is the over-refusal #137 removed.
// The `fail > 0` pin above cannot stand in for this one. Its fixture passes 11
// tests, so it stays clean whether the clause reads `pass === 0` or
// `pass === 0 && !fail`; only a fixture with BOTH zero passes and failures can
// tell those two apart.
test("a run where every test failed is NOT unrun, even though nothing passed", () => {
  assert.equal(
    unrunReason({
      dimension: "tests",
      scope_searched: "the snapshot's own suite",
      findings: [{ severity: "critical", claim: "x", evidence: "y" }],
      test_run: { command: "npm test --", tests: 3, pass: 0, fail: 3 },
    }),
    null,
    "a suite that reported only failures still ran",
  );
});

// #143's third case, deferred there from the #526 review. `fail > 0` on its own
// is a suite that ran, pinned clean above and deliberately so; the contradiction
// is the CONJUNCTION with an empty findings list — the suite ran, it reported
// failures, and the reviewer filed nothing about them. `findings` is required by
// the schema, so the undefined arm covers a specialist that ignored it rather
// than a shape the schema permits.
test("a run with failing tests and no findings at all is unrun", () => {
  for (const findings of [[], undefined]) {
    const reason = unrunReason({
      dimension: "tests",
      scope_searched: "the snapshot's own suite",
      findings,
      test_run: { command: "node --test", tests: 744, pass: 738, fail: 6 },
    });
    assert.equal(typeof reason, "string", `fail>0 with findings ${JSON.stringify(findings)} must yield a reason`);
    assert.match(reason, /6 failing tests/, "the reason no longer says how many tests failed unreported");
  }
});

// `pass`/`fail` are optional (see the schema pin below), so a run that reported
// only a count must still come back clean rather than tripping the predicate on
// a field it was never required to send.
test("a run that reported tests but not pass/fail is NOT unrun", () => {
  assert.equal(
    unrunReason({
      dimension: "comments",
      scope_searched: "every added comment in the diff",
      findings: [],
      test_run: { command: "node --test", tests: 7 },
    }),
    null,
    "an optional field's absence must not mark a real run unrun",
  );
});

// SOURCE, not CODE: `new Function` is a real parser and drops every comment form
// unconditionally, which is the whole point of reading the object rather than
// the text (see the header). Stripping first would only re-narrow it.
//
// Not routed through lift.mjs's lift(): FINDINGS_SCHEMA is a `const` object
// literal, not a `function name(signature)` declaration — same reason
// DEFAULT_DIMENSIONS stays local in select-dimensions.test.mjs.
function findingsSchema() {
  const src = between(SOURCE, "const FINDINGS_SCHEMA = {", "const VERDICT_SCHEMA", "review-pr.js");
  return new Function(`${src}\nreturn FINDINGS_SCHEMA;`)();
}

// #139: the description at `:37` called `scope_searched` **Required** while the
// `required` array omitted it, so a specialist that skipped it validated clean —
// reproducing the exact failure the description exists to prevent. Both halves
// pinned, because either one alone re-opens the ticket.
test("scope_searched is in the required array, not only in its own description", () => {
  const { required } = findingsSchema();
  assert.ok(Array.isArray(required), "FINDINGS_SCHEMA no longer has a top-level required array — update this test");
  assert.ok(required.includes("scope_searched"), "scope_searched is documented Required and is not in the required array (#139)");
  assert.ok(required.includes("test_run"), "test_run is not required, so an unrun dimension can still return a clean-looking object (#137)");
});

// `additionalProperties: false` REJECTS an undeclared field, so a `required`
// entry whose property is not declared is worse than neither: the specialist is
// forced to send a field the schema then drops. Both halves, one pin.
test("test_run is declared, carries the command and count, and does not force pass/fail", () => {
  const testRun = findingsSchema().properties.test_run;
  assert.ok(testRun, "test_run is not declared in FINDINGS_SCHEMA's properties — additionalProperties:false drops it");
  for (const field of ["command", "tests", "pass", "fail"]) {
    assert.ok(testRun.properties[field], `test_run no longer declares ${field}`);
  }
  assert.ok(Array.isArray(testRun.required), "test_run no longer names which of its fields are required — update this test");
  assert.ok(testRun.required.includes("command"), "test_run.command must be required — a count with no command bounds nothing");
  assert.ok(testRun.required.includes("tests"), "test_run.tests must be required — it is the field the unrun rule reads");
  // A runner whose output does not split pass from fail must not be forced to
  // invent numbers: an unanswerable required field is answered with a guess,
  // and a guessed count is worse than an absent one.
  for (const optional of ["pass", "fail"]) {
    assert.ok(!testRun.required.includes(optional), `${optional} must stay optional — see the comment above this assertion`);
  }
});

// Wiring, not classification. `unrunReason` can be correct and reach nobody:
// the review object it reads is in scope for exactly one closure — the verify
// stage's `(review, d)` — and `reviewed` below is findings, flattened, with the
// per-dimension envelope already gone. If the recording is not in that closure
// it cannot be anywhere.
function verifyStage() {
  return between(CODE, "(review, d) =>", "const n = verifiersFor", "the verify stage");
}

// The entry, not the call site. `unrunEntries` returns zero or one, so both
// writers `push(...)` it with no guard of their own — and a guard is exactly what
// the predecessor of this test could not see: it compared the source positions of
// two substrings, so wrapping the recording in `if (review && why)` left both in
// place, kept the suite green, and silently dropped every crashed dimension.
test("an unrun classification becomes an entry with no guard for a caller to get wrong", () => {
  const entries = unrunEntries(null, "tests");
  assert.equal(entries.length, 1, "a falsy review must yield exactly one entry — nothing else records #138's cause");
  assert.equal(entries[0].dimension, "tests", "the entry no longer names the dimension it was asked about");
  assert.match(entries[0].reason, /returned nothing/, "the entry no longer carries the classifier's reason");
  assert.deepEqual(
    unrunEntries(
      { dimension: "tests", scope_searched: "x", findings: [], test_run: { command: "npm test --", tests: 9 } },
      "tests",
    ),
    [],
    "a covered dimension must yield NO entry — an empty push is what lets both call sites stay unguarded",
  );
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
  assert.match(unrun[0].reason, /returned nothing/, "the crashed dimension's reason no longer names a reviewer that returned nothing");
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

// Wiring, not classification — and textual, because it has to be. Both writers
// are executable above; whether the SCRIPT calls them is not, since the file is a
// workflow body the harness executes and nothing here can run it. Stated ceiling:
// this sees a call deleted or moved, and does not see one wrapped in a guard of
// its own. That is why the classification moved behind two lifted functions —
// the pin it replaced had source positions as its only evidence.
test("both halves are wired in: the verify stage, and the pipeline result the stage cannot see", () => {
  const stage = verifyStage();
  const asked = stage.indexOf("dimensionsUnrun.push(...unrunEntries(review, d.key))");
  assert.notEqual(asked, -1, "the verify stage no longer records #137's half — a reviewer that ran no suite reads clean");
  const deref = stage.indexOf("review && review.findings");
  assert.notEqual(deref, -1, "the findings guard moved — update this test");
  assert.ok(asked < deref, "the recording sits behind the falsy-review guard, which already reads a dead reviewer as clean (#138)");
  // AFTER the pipeline returns, never inside a stage: a stage cannot observe its
  // own absence, which is the entire reason #138 shipped as dead code once.
  const call = CODE.indexOf("const reviewed = await pipeline(");
  assert.notEqual(call, -1, "the pipeline call moved — update this test");
  const derived = CODE.indexOf("dimensionsUnrun.push(...unrunCrashed(reviewed, dimensions))");
  assert.notEqual(derived, -1, "nothing derives the crashed dimensions from the pipeline result — #138 is unreachable again");
  assert.ok(call < derived, "the derivation runs before the pipeline returns, where its result does not exist yet");
});

test("the returned object carries dimensionsUnrun alongside dimensionsRun", () => {
  assert.match(CODE, /const dimensionsUnrun = \[\]/, "dimensionsUnrun is never declared — the return would throw");
  const at = CODE.lastIndexOf("return {");
  assert.notEqual(at, -1, "review-pr.js no longer ends in a return literal — update this test");
  const tail = CODE.slice(at);
  // BOTH, adjacent. `dimensionsRun` keeps its meaning and its value — the
  // dispatched set after the size trim — because a consumer diffing it against
  // DEFAULT_DIMENSIONS to spot a trim would otherwise read a crashed dimension
  // as a trimmed one: the same conflation this ticket set closes, one field over.
  // The new list is what subtracts from it, which only works if it ships too.
  assert.match(tail, /dimensionsRun: dimensions\.map\(\(d\) => d\.key\)/, "dimensionsRun no longer reports the dispatched set");
  assert.match(tail, /dimensionsUnrun/, "the return never surfaces dimensionsUnrun — the classification dies in the script (#137, #138)");
});

// The schema field is inert unless the prompt points at it — the specialists
// are what fill it in, and a field nothing asks for comes back absent from
// every one of them.
//
// #143 records the gap this pin closes: `review-pr-testcmd.test.mjs` pins the
// RULING (`'tests 0' is a FAILED run`) and nothing pins the FOLLOW-THROUGH, so
// the sentence saying what to DO about a zero-test run could be deleted with
// the suite green. This edit rewrites that sentence; pin it where it now lands.
test("the specialist prompt names test_run as where a zero-test run gets reported", () => {
  const prompt = between(CODE, "READ ONLY FROM THE SNAPSHOT", "Scratch files go in", "the specialist prompt");
  assert.match(prompt, /test_run/, "the prompt never names test_run, so nothing fills the field the schema requires");
  // The instruction that matters is reporting the run that produced NOTHING. A
  // specialist that reports only successful runs leaves `test_run` absent in
  // exactly the case the field exists for.
  assert.match(
    prompt,
    /even when it (failed|produced)|produced nothing/,
    "the prompt no longer tells specialists to report a run that failed or produced nothing",
  );
});

// The workflow's return shape is documented in one place a controller actually
// reads, and this repo's recurring defect is a second copy disconnecting in one
// token. A `dimensionsUnrun` nobody is told to read is a field nobody reads.
test("run-team's Reviewers section documents dimensionsUnrun, not only dimensionsRun", () => {
  const doc = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
  assert.match(doc, /dimensionsUnrun/, "run-team/SKILL.md still documents a return shape without dimensionsUnrun");
  // The superseded workaround must be GONE, not merely accompanied. It reads
  // every zero-finding dimension as unrun — including one that ran clean — so
  // leaving it in place next to the real field teaches the opposite rule.
  assert.doesNotMatch(
    doc,
    /a dimension listed\s+in `dimensionsRun` with nothing in `survived`\/`refuted`\/`unverified` is \*\*unrun,\s+not clean\*\*/,
    "run-team/SKILL.md still states the pre-#137 workaround, which marks a clean dimension unrun",
  );
});

// What the absence of an unrun classification ESTABLISHES is that a suite ran —
// never that the dimension is covered. `unrunReason` above reads `test_run`'s
// counts and quotes `command` into its message; it never compares that command
// against the one the dispatch handed out, so a specialist that substituted a
// narrower runner reports a non-zero count, is not classified unrun, and reads
// as covered having validated a fraction of the suite. Comparing the two was
// refuted 2-0 and stays refuted (#535) — the doc claiming only what the
// classifier can see is the remedy, and nothing pinned the word it turns on.
//
// The positive pin carries the claim: sliced to the paragraph so a failure
// prints it rather than the whole 2000-line doc, matched through `phrase` so a
// reflow of the hard wrap cannot fire it, and run out to the sentence's `;` so
// the clause has to END there. That terminator is what catches the likelier
// regression — an editor softening rather than reverting, `ran a suite AND IS
// THEREFORE COVERED` — which a pin on the anchor alone reads as still present.
// The exclusion then has nothing left to guess at, so it stays whole-doc and
// case-insensitive: the retracted claim is caught wherever in the file it comes
// back, and in the lowercase paraphrase a `phrase` pin on `NOT` walks past.
// Measured both ways — each form reds, and a reflow, a `; every` → `; each`
// reword, and a correctly negated coverage sentence in the paragraph stay green.
test("run-team claims a suite RAN from a key's absence from dimensionsUnrun, never that it is covered", () => {
  const doc = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
  const para = between(doc, "**`dimensionsRun` is the dispatch", "The rule this replaces", "run-team/SKILL.md");
  assert.match(
    para,
    phrase("and NOT in `dimensionsUnrun` ran a suite;"),
    "run-team/SKILL.md no longer says a key absent from dimensionsUnrun ran a suite, full stop",
  );
  assert.doesNotMatch(
    doc,
    /in\s+`dimensionsUnrun`\s+is\s+covered/i,
    "run-team/SKILL.md reads a key's absence from dimensionsUnrun as coverage — the classifier never checked the command that ran",
  );
});
