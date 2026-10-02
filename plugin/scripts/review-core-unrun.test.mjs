import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between, paragraph, phrase, stripSlashGutter } from "./prose-pin.mjs";
import { unrunReason, unrunEntries, unrunCrashed, sharedRunNote, FINDINGS_SCHEMA, CRASHED_REASON } from "./review-core.mjs";

// A dimension that crashed and a dimension that ran clean returned BYTE-
// IDENTICAL shapes: `findings: []` either way, with the key listed in
// `dimensionsRun` regardless (#137, #138). Nothing in this suite could see
// that mode — no test touched `FINDINGS_SCHEMA` or the verify stage's falsy-
// review branch at all — so a green run said nothing about it. This file is
// that missing eye.
//
// #2315: every run-quality verdict reads the review's ONE shared test run —
// `unrunReason(run, findings)`, `findings` being every finding that reached
// the payload, across all selected dimensions — because no specialist runs the
// full suite any more. The fixtures below are that run's shape: the caller's
// `command` plus the test-run agent's exit status and counts.
//
// Pins read CODE, not SOURCE, wherever they read source text at all:
// `stripComments` exists because two pins in this directory were MEASURED
// vacuous against a field commented out with `/* */` (see strip-comments.mjs),
// and a schema pin written against raw source passes with the field dead under
// `additionalProperties: false`.
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "scripts", "review-core.mjs"), "utf8");
const CODE = stripComments(SOURCE);

// #2315's no-counts case, from its two causes: the test-run dispatch returned
// nothing at all, or it returned without a count (crash, deadline, no
// summary). Neither is ever a pass.
test("a shared run that returned nothing is unrun, and says why", () => {
  for (const dead of [null, undefined, false, 0, ""]) {
    const reason = unrunReason(dead, []);
    assert.equal(typeof reason, "string", `a falsy shared run (${JSON.stringify(dead)}) must yield a reason`);
    assert.match(reason, /returned nothing/, "the reason no longer names a test run that returned nothing");
  }
});

// #137's case: the `'tests 0'` reading rule, given somewhere to land. The
// reason names the COMMAND, because "0 tests" without it sends a reader
// hunting for which command produced them.
test("a zero-test run is unrun, naming the command that produced no tests", () => {
  const reason = unrunReason({ command: "npm test --", tests: 0, pass: 0, fail: 0 }, []);
  assert.equal(typeof reason, "string", "a zero-test run must yield a reason");
  assert.match(reason, /npm test --/, "the reason no longer names the command that produced no tests");
  assert.match(reason, /0 tests/);
});

// ABSENT or null is "no counts", not `tests: 0`: the test-run agent is told to
// omit a count the log does not state, so an absent one is a run that printed
// no summary — and its `error` says why, which the reason must carry.
test("a shared run that reported no count at all is unrun, carrying the agent's error", () => {
  for (const run of [{ command: "npm test --" }, { command: "npm test --", tests: null }]) {
    const reason = unrunReason(run, [{ severity: "critical", claim: "x", evidence: "y" }]);
    assert.equal(typeof reason, "string", `a countless run (${JSON.stringify(run)}) must yield a reason`);
    assert.match(reason, /no counts/);
  }
  assert.match(unrunReason({ command: "npm test --", error: "hit the 1800 s deadline" }, []), /hit the 1800 s deadline/);
});

// THE REFUSAL SURFACE, and the half a suite fed only broken input cannot pin.
// A new required field and a new unrun predicate are both refusal surfaces: a
// review that legitimately has nothing to report must still come back
// clean. Marking a genuinely clean dimension unrun re-runs work that was done
// and teaches a controller to ignore the field — the same end state as not
// having it.
test("a clean run with every dimension's findings list empty is NOT unrun", () => {
  assert.equal(
    unrunReason({ command: "npm test --", exitCode: 0, tests: 12, pass: 12, fail: 0 }, []),
    null,
    "a review whose shared run passed and found nothing is clean, not unrun",
  );
});

// A suite with real failures RAN. Reading `fail > 0` as unrun would hide the
// one class of test result that most needs reporting.
test("a run with failing tests is NOT unrun", () => {
  assert.equal(
    unrunReason({ command: "npm test --", exitCode: 1, tests: 14, pass: 11, fail: 3 }, [{ severity: "critical", claim: "x", evidence: "y" }]),
    null,
    "a suite that reported failures still ran",
  );
});

// #143's all-skipped case, and the reason the clause reads `pass === 0 && !fail`
// rather than the bare "zero passes" #143's body proposes: a run where every
// test skipped arrives as `pass: 0` with `fail` zero or absent (the shared run
// may also report `skipped`, but the verdict never needs it). Nothing passed
// and nothing failed is no work done.
// BOTH arms of `findings`, because this clause is findings-INDEPENDENT by
// design and only a non-empty fixture says so. The sibling `fail > 0` clause
// below is the one that reads `findings`; ANDing a findings check in here too
// would let a review that reports 0 passes and 0 fails and attaches one filler
// finding read as clean — the loophole #143 exists to close. Every fixture
// here once sent `[]`, so that mutation survived the whole suite.
test("a run where nothing passed and nothing failed is unrun — every test skipped", () => {
  for (const findings of [[], [{ severity: "suggestion", claim: "x", evidence: "y" }]]) {
    for (const run of [
      { command: "node --test", tests: 2, pass: 0, fail: 0 },
      { command: "node --test", tests: 2, pass: 0 },
    ]) {
      const reason = unrunReason(run, findings);
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
      const reason = unrunReason(run, findings);
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
    { command: "node --test", exitCode: 0, tests: 3, pass: 3, fail: 0 },
    { command: "node --test", exitCode: 0, tests: 937, pass: 937, fail: 0 },
    { command: "node --test", exitCode: 0, tests: 2, pass: 1, fail: 0 },
    { command: "node --test", exitCode: 0, tests: 937, pass: null },
  ]) {
    assert.equal(
      unrunReason(run, []),
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
    unrunReason({ command: "node --test", exitCode: 1, tests: 10, pass: 4, fail: 6 }, [{ severity: "critical", claim: "x", evidence: "y" }]),
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
      const reason = unrunReason(run, findings);
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
    unrunReason({ command: "node --test", exitCode: 1, tests: 937, pass: 300, fail: 300 }, [{ severity: "critical", claim: "x", evidence: "y" }]),
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
    unrunReason({ command: "npm test --", exitCode: 1, tests: 3, pass: 0, fail: 3 }, [{ severity: "critical", claim: "x", evidence: "y" }]),
    null,
    "a suite that reported only failures still ran",
  );
});

// #143's third case, deferred there from the #526 review. `fail > 0` on its own
// is a suite that ran, pinned clean above and deliberately so; the contradiction
// is the CONJUNCTION with no findings — the suite ran, it reported failures,
// and nobody filed anything about them. #2315 widened "nobody" from one
// dimension to the whole review: the shared run's failures are the review's,
// so EVERY finding that reached the payload is read — and a refuted one does
// not count, because the review rejected it (an unrelated claim its verifiers
// threw out is not a report of the failures). Cancelled tests are failures
// too: node's runner exits 1 on one with `fail 0`.
test("a run with failing or cancelled tests and no kept finding from ANY dimension is unrun", () => {
  const refutedOnly = [{ severity: "critical", claim: "x", evidence: "y", verdict: "refuted" }];
  for (const findings of [[], [null], refutedOnly]) {
    const reason = unrunReason({ command: "node --test", exitCode: 1, tests: 744, pass: 738, fail: 6 }, findings);
    assert.equal(typeof reason, "string", `fail>0 with findings ${JSON.stringify(findings)} must yield a reason`);
    assert.match(reason, /6 failing tests/, "the reason no longer says how many tests failed unreported");
    assert.match(reason, /no selected dimension/);
  }
  const cancelled = unrunReason({ command: "node --test", exitCode: 1, tests: 744, pass: 743, fail: 0, cancelled: 1 }, refutedOnly);
  assert.match(cancelled ?? "", /0 failing and 1 cancelled tests and no selected dimension/, "a cancelled test nobody reported must not read clean");
});

// The ACCEPT side, and #2315's ownership rule: one finding from ANY dimension
// satisfies the check for the whole review — the other dimensions are told not
// to file a duplicate, so reading each dimension's own list would mark every
// one of them unrun for obeying that.
test("a run with failing tests and a finding from ONE dimension is NOT unrun", () => {
  const run = { command: "node --test", exitCode: 1, tests: 744, pass: 738, fail: 6 };
  for (const verdict of [undefined, "survived", "unverified"]) {
    const one = [{ severity: "critical", claim: "x", evidence: "y", verdict }];
    assert.equal(unrunReason(run, one), null, `a ${verdict ?? "bare"} finding about the failures must satisfy every dimension`);
    assert.deepEqual(unrunEntries(run, one, ["correctness", "tests", "types"]), []);
  }
  // A cancelled test routes the same way: one kept finding settles it.
  assert.equal(unrunReason({ ...run, fail: 0, cancelled: 2, pass: 742 }, [{ severity: "suggestion", claim: "x", evidence: "y", verdict: "unverified" }]), null);
});

// `pass`/`fail` are optional, so a run that reported only a count must still
// come back clean rather than tripping the predicate on a field the runner
// never printed.
test("a run that reported tests but not pass/fail is NOT unrun", () => {
  assert.equal(unrunReason({ command: "node --test", exitCode: 0, tests: 7 }, []), null, "an optional field's absence must not mark a real run unrun");
});

// The exit status is the command's own verdict, and the counts must account
// for it. A run reporting none, or exiting non-zero with nothing failing or
// cancelled, is unusable whatever its counts say — and findings cannot buy it
// clean, because nothing in it names a failure to report.
test("a run whose exit status is missing, or non-zero with no failing count, is unrun", () => {
  const finding = [{ severity: "critical", claim: "x", evidence: "y", verdict: "survived" }];
  for (const [run, pattern] of [
    [{ command: "node --test", tests: 10, pass: 10, fail: 0 }, /no exit status/],
    [{ command: "node --test", exitCode: null, tests: 10, pass: 10 }, /no exit status/],
    [{ command: "node --test", exitCode: 1, tests: 10, pass: 10, fail: 0 }, /exited 1 but reported no failing or cancelled tests/],
    [{ command: "node --test", exitCode: 137, tests: 10, pass: 10 }, /exited 137/],
  ]) {
    for (const findings of [[], finding]) {
      const reason = unrunReason(run, findings);
      assert.equal(typeof reason, "string", `${JSON.stringify(run)} must yield a reason`);
      assert.match(reason, pattern);
      assert.match(reason, /node --test/, "the reason no longer names the command");
    }
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
  assert.ok(required.includes("test_run"), "test_run is not required, so an unrun dimension can still return a clean-looking object (#137)");
});

// `additionalProperties: false` REJECTS an undeclared field, so a `required`
// entry whose property is not declared is worse than neither: the specialist is
// forced to send a field the schema then drops. Both halves, one pin.
test("test_run is declared, carries the command and count, and does not force pass/fail", () => {
  const testRun = FINDINGS_SCHEMA.properties.test_run;
  assert.ok(testRun, "test_run is not declared in FINDINGS_SCHEMA's properties — additionalProperties:false drops it");
  for (const field of ["command", "tests", "pass", "fail"]) {
    assert.ok(testRun.properties[field], `test_run no longer declares ${field}`);
  }
  assert.ok(Array.isArray(testRun.required), "test_run no longer names which of its fields are required — update this test");
  assert.ok(testRun.required.includes("command"), "test_run.command must be required — a count with no command bounds nothing");
  assert.ok(testRun.required.includes("tests"), "test_run.tests must be required — it is the count every specialist copies from the shared run");
  // A runner whose output does not split pass from fail must not be forced to
  // invent numbers: an unanswerable required field is answered with a guess,
  // and a guessed count is worse than an absent one.
  for (const optional of ["pass", "fail"]) {
    assert.ok(!testRun.required.includes(optional), `${optional} must stay optional — see the comment above this assertion`);
  }
});

// The entry, not the call site. `unrunEntries` returns zero entries or one per
// key, so its writer `push(...)`es it with no guard of its own — and a guard is
// exactly what the predecessor of this test could not see: it compared the
// source positions of two substrings, so wrapping the recording in
// `if (review && why)` left both in place, kept the suite green, and silently
// dropped every crashed dimension.
test("an unrun classification becomes one entry per key, with no guard for a caller to get wrong", () => {
  const entries = unrunEntries(null, [], ["correctness", "tests"]);
  assert.deepEqual(entries.map((e) => e.dimension), ["correctness", "tests"], "a dead shared run must name EVERY key it was asked about");
  for (const e of entries) assert.match(e.reason, /returned nothing/, "the entry no longer carries the classifier's reason");
  assert.deepEqual(
    unrunEntries({ command: "npm test --", exitCode: 0, tests: 9 }, [], ["tests"]),
    [],
    "a covered review must yield NO entry — an empty push is what lets the call site stay unguarded",
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

// Wiring, not classification — and textual, because it has to be. Both writers
// are executable above; whether runReview calls them is pinned here. Stated
// ceiling: this sees a call deleted or moved, and does not see one wrapped in a
// guard of its own. That is why the classification moved behind lifted
// functions — the pin it replaced had source positions as its only evidence.
// runReview's own behaviour over a scripted host is review-core-shared-test-run.test.mjs's.
test("both writers are wired in AFTER the pipeline, the failing-tests check reading the payload's findings", () => {
  // AFTER the pipeline returns, never inside a stage: a stage cannot observe its
  // own absence (#138), and the failing-tests check needs every dimension's
  // findings at once (#2315).
  const call = CODE.indexOf("const reviewed = await pipeline(");
  assert.notEqual(call, -1, "the pipeline call moved — update this test");
  for (const writer of [
    "dimensionsUnrun.push(...unrunEntries(sharedRun, all, live))",
    "dimensionsUnrun.push(...unrunCrashed(reviewed, dimensions))",
  ]) {
    const at = CODE.indexOf(writer);
    assert.notEqual(at, -1, `\`${writer}\` is gone — a half of dimensionsUnrun is unreachable again`);
    assert.ok(call < at, `\`${writer}\` runs before the pipeline returns, where its input does not exist yet`);
  }
});

test("the returned object carries dimensionsUnrun alongside dimensionsRun", () => {
  assert.match(CODE, /const dimensionsUnrun = \[\]/, "dimensionsUnrun is never declared — the return would throw");
  const at = CODE.lastIndexOf("return {");
  assert.notEqual(at, -1, "review-core.mjs no longer ends in a return literal — update this test");
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
// every one of them. #2315 moved the instruction into `sharedRunNote`, the
// Tests paragraph every specialist prompt interpolates, and what it says now is
// to COPY the shared run — including a run that stated no counts.
test("the shared-run note names test_run as where the shared run gets reported, even one with no counts", () => {
  for (const run of [
    { command: "node --test", logPath: "/r/test-run.log", tests: 5, pass: 5, fail: 0 },
    { command: "node --test", logPath: "/r/test-run.log", error: "no summary" },
  ]) {
    const note = sharedRunNote(run, "correctness", "tests");
    assert.match(note, /`test_run`/, "the note never names test_run, so nothing fills the field the schema requires");
    assert.match(note, /`tests: 0` when it states\s+none/, "the note no longer says what to report for a run with no counts");
    assert.match(note, /never a run of your own/);
  }
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
// `stripSlashGutter` first, and it buys BOTH halves: the clause wraps
// mid-sentence at a `// ` that `phrase`'s `\s+` cannot span, and the block's
// bare `//` separator line becomes a real blank line — which is what lets the
// SHARED `paragraph` bound apply here instead of a local copy of
// quiet-payload-prose.test.mjs's comment-block-above slicer, `paragraph`'s own
// doc-comment being where this repo says a local copy is the defect, not a
// style choice. Slice and anchor are then the sibling pin's exactly:
// `anchorAt`'s exactly-once guarantee, and an end bound at the paragraph rather
// than one running past the block into the `return` below it.
//
// The positive pin runs out through `(#535).` for the SKILL.md pin's reason —
// the likelier regression is an editor softening rather than reverting, and a
// pin stopping at `ran a suite` reads `ran a suite and is therefore covered` as
// still present. The exclusion is whole-file and case-insensitive so the
// retracted wording is caught wherever it comes back, and it targets `only
// thing that means covered` rather than `covered` alone so the paragraph's own
// correct denials — which must keep saying the word — stay green.
test("review-core.mjs's own comment claims a suite RAN from a key's absence from dimensionsUnrun, never that it is covered", () => {
  const prose = stripSlashGutter(SOURCE);
  const para = paragraph(prose, "`dimensionsRun` names what was DISPATCHED", "review-core.mjs");
  assert.match(
    para,
    phrase("A key in the first and NOT in the second ran a suite — not that it is covered (#535)."),
    "review-core.mjs's dimensionsRun/dimensionsUnrun comment no longer says a key absent from dimensionsUnrun ran a suite, full stop",
  );
  assert.doesNotMatch(
    prose,
    /only\s+thing\s+that\s+means\s+covered/i,
    "review-core.mjs is back to reading a key's absence from dimensionsUnrun as coverage — `unrunReason` never compares `run.command` against the command the dispatch handed out (#535)",
  );
});
