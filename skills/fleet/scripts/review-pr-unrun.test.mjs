import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

// A dimension that crashed and a dimension that ran clean returned BYTE-
// IDENTICAL shapes: `findings: []` either way, with the key listed in
// `dimensionsRun` regardless (#137, #138). Nothing in this suite could see
// that mode — no test touched `FINDINGS_SCHEMA` or the verify stage's falsy-
// review branch at all — so a green run said nothing about it. This file is
// that missing eye.
//
// Every pin runs against CODE, not SOURCE: `stripComments` exists because two
// pins in this directory were MEASURED vacuous against a field commented out
// with `/* */` (see strip-comments.mjs). A schema pin written against raw
// source passes with the field dead under `additionalProperties: false`.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
const CODE = stripComments(SOURCE);

// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported,
// so the classifier is lifted out of the source text — the same technique
// `review-pr-testcmd.test.mjs` uses for `resolveTestCmd`. It only works while
// `unrunReason` stays PURE: a free variable (`testCmd`, `snap`) would throw a
// ReferenceError here on the branch that reads it, which is a property worth
// having anyway.
function liftUnrunReason() {
  const m = CODE.match(/^function unrunReason\(review\) \{[\s\S]*?^\}$/m);
  assert.ok(m, "review-pr.js no longer declares unrunReason(review) at top level — update this test");
  return new Function(`${m[0]}\nreturn unrunReason;`)();
}
const unrunReason = liftUnrunReason();

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

function findingsSchema() {
  const at = CODE.indexOf("const FINDINGS_SCHEMA = {");
  assert.notEqual(at, -1, "review-pr.js no longer declares FINDINGS_SCHEMA — update this test");
  const end = CODE.indexOf("const VERDICT_SCHEMA", at);
  assert.notEqual(end, -1, "VERDICT_SCHEMA no longer follows FINDINGS_SCHEMA — update this test");
  return CODE.slice(at, end);
}

// #139: the description at `:37` called `scope_searched` **Required** while the
// `required` array omitted it, so a specialist that skipped it validated clean —
// reproducing the exact failure the description exists to prevent. Both halves
// pinned, because either one alone re-opens the ticket.
test("scope_searched is in the required array, not only in its own description", () => {
  const schema = findingsSchema();
  const required = schema.match(/required:\s*\[([^\]]*)\]/);
  assert.ok(required, "FINDINGS_SCHEMA no longer has a top-level required array — update this test");
  assert.match(required[1], /"scope_searched"/, "scope_searched is documented Required and is not in the required array (#139)");
  assert.match(required[1], /"test_run"/, "test_run is not required, so an unrun dimension can still return a clean-looking object (#137)");
});

// `additionalProperties: false` REJECTS an undeclared field, so a `required`
// entry whose property is not declared is worse than neither: the specialist is
// forced to send a field the schema then drops. Both halves, one pin.
test("test_run is declared, carries the command and count, and does not force pass/fail", () => {
  const schema = findingsSchema();
  const at = schema.indexOf("test_run:");
  assert.notEqual(at, -1, "test_run is not declared in FINDINGS_SCHEMA's properties — additionalProperties:false drops it");
  const block = schema.slice(at, schema.indexOf("findings:", at) === -1 ? undefined : schema.indexOf("findings:", at));
  for (const field of ["command", "tests", "pass", "fail"]) {
    assert.match(block, new RegExp(`^\\s*${field}:`, "m"), `test_run no longer declares ${field}`);
  }
  const inner = block.match(/required:\s*\[([^\]]*)\]/);
  assert.ok(inner, "test_run no longer names which of its fields are required — update this test");
  assert.match(inner[1], /"command"/, "test_run.command must be required — a count with no command bounds nothing");
  assert.match(inner[1], /"tests"/, "test_run.tests must be required — it is the field the unrun rule reads");
  // A runner whose output does not split pass from fail must not be forced to
  // invent numbers: an unanswerable required field is answered with a guess,
  // and a guessed count is worse than an absent one.
  assert.doesNotMatch(inner[1], /"pass"|"fail"/, "pass/fail must stay optional — see the comment above this assertion");
});

// Wiring, not classification. `unrunReason` can be correct and reach nobody:
// the review object it reads is in scope for exactly one closure — the verify
// stage's `(review, d)` — and `reviewed` below is findings, flattened, with the
// per-dimension envelope already gone. If the recording is not in that closure
// it cannot be anywhere.
function verifyStage() {
  const at = CODE.indexOf("(review, d) =>");
  assert.notEqual(at, -1, "the verify stage's (review, d) closure moved — update this test");
  const end = CODE.indexOf("const n = verifiersFor", at);
  assert.notEqual(end, -1, "the verify stage no longer reaches verifiersFor — update this test");
  return CODE.slice(at, end);
}

test("the verify stage records the unrun reason, and does so BEFORE the review is dereferenced", () => {
  const stage = verifyStage();
  const asked = stage.indexOf("unrunReason(review)");
  assert.notEqual(asked, -1, "the verify stage never calls unrunReason — the classifier reaches nobody");
  assert.match(stage, /dimensionsUnrun\.push/, "the verify stage never records what it classified");
  // The ORDER is the pin, and it is #138's whole case. `review && review.findings`
  // is the expression that treats a dead reviewer as a clean one; tucking the
  // recording inside a `review &&` guard — or after an early return on falsy —
  // would classify every dimension EXCEPT the crashed one, which is the only
  // dimension this half of the ticket is about.
  const deref = stage.indexOf("review && review.findings");
  assert.notEqual(deref, -1, "the findings guard moved — update this test");
  assert.ok(
    asked < deref,
    "unrunReason is called after the falsy-review guard, so a crashed reviewer is never classified (#138)",
  );
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
  const at = CODE.indexOf("READ ONLY FROM THE SNAPSHOT");
  assert.notEqual(at, -1, "the specialist prompt moved — update this test");
  const end = CODE.indexOf("Scratch files go in", at);
  assert.notEqual(end, -1, "the specialist prompt's scratch line moved — update this test");
  const prompt = CODE.slice(at, end);
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
  const doc = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
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
