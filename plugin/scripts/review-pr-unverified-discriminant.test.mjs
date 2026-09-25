import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { lift } from "./lift.mjs";
import { between, phrase } from "./prose-pin.mjs";

// The band `unverified` had two producers and one shape. A `suggestion` skips
// the adversarial pass because the workflow budgets that band 0 refuters, and a
// finding whose refuters were all dispatched and all died reaches the same band
// with the same empty vote list — so a consumer read "nothing looked, on
// purpose" and "nothing looked, by accident" off byte-identical objects (#591).
//
// Nothing in this suite could see that: both shapes were produced inside the
// verify closure, which no test can reach, and the two were equal anyway, so
// even a test that reached them would have had nothing to assert a difference
// against. This file is that missing eye — it drives BOTH shapes and asserts
// they differ.
//
// Pins that read source read CODE, not SOURCE: `stripComments` exists because
// pins in this directory were measured vacuous against a field commented out
// (see strip-comments.mjs), and a pin written against raw source passes with
// the thing it pins dead.
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
const CODE = stripComments(SOURCE);

// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported, so
// the seam is lifted out of the source text — the convention this repo's test
// headers call text-lift pinning, and the reason `verdictFor` is a top-level
// PURE function rather than an expression inline in the closure. A free
// variable would throw a ReferenceError here on whichever branch read it, which
// is a property worth having: the verdict decision depends on the dispatched
// count and the votes and on nothing else in the run.
const verdictFor = lift(CODE, "verdictFor", "dispatched, votes");
const resumeFor = lift(CODE, "resumeFor", "unverified");

// --- the discriminant -----------------------------------------------------

// #591's case, and the only assertion that would have caught the defect: both
// calls are the `unverified` band, both carry no surviving vote, and a consumer
// must still be able to tell them apart from the payload alone.
test("a policy skip and a crash reach the same band and differ on refutersDispatched", () => {
  const skipped = verdictFor(0, []);
  const crashed = verdictFor(2, [null, null]);

  assert.equal(skipped.verdict, "unverified", "a band with 0 refuters budgeted is not unverified");
  assert.equal(crashed.verdict, "unverified", "every refuter died and the finding did not land in unverified");

  // The vote list is what a consumer had BEFORE this field, and it is equal on
  // both — pinned here so the discriminant cannot quietly become "read the
  // votes", which is the read that could not tell them apart.
  assert.deepEqual(skipped.votes, [], "a policy skip carries votes that were never cast");
  assert.deepEqual(crashed.votes, [], "a crashed refuter left a vote behind — `votes` no longer filters the dead");

  assert.equal(skipped.refutersDispatched, 0, "a policy skip reports refuters it never dispatched");
  assert.ok(
    crashed.refutersDispatched > 0,
    "a finding whose refuters all crashed reports none dispatched — indistinguishable from a policy skip again (#591)",
  );
  assert.notDeepEqual(
    skipped,
    crashed,
    "the two populations are byte-identical again — this is the defect #591 fixed, restored",
  );
});

// The other half, and the one a suite of only-crashed fixtures would not pin:
// what this must still ACCEPT. Routing both `unverified` producers through one
// function is a restructure, and a restructure that changed the majority rule
// would pass every assertion above while silently re-banding real findings.
test("the majority rule survives the extraction — a live vote list still bands as it did", () => {
  const yes = { refuted: false };
  const no = { refuted: true };

  assert.equal(verdictFor(2, [yes, yes]).verdict, "survived", "an unrefuted finding no longer survives");
  assert.equal(verdictFor(2, [no, no]).verdict, "refuted", "a unanimously refuted finding no longer refutes");
  // The tie is `refuted * 2 >= live.length`, so a 1-1 split refutes. Pinned
  // because it is the branch an inverted comparison keeps green on every other
  // input, and because it is the one the controller is told to read the votes
  // on rather than the band.
  assert.equal(verdictFor(2, [yes, no]).verdict, "refuted", "a 1-1 split no longer refutes");
  // A dead refuter alongside live ones is filtered, so it neither votes nor
  // changes the denominator: one live unrefuted vote out of two dispatched is
  // survived, not a tie.
  assert.equal(verdictFor(2, [yes, null]).verdict, "survived", "a crashed refuter is being counted as a vote");
  assert.equal(
    verdictFor(3, [yes, null]).refutersDispatched,
    3,
    "refutersDispatched reports the surviving votes rather than the dispatch — the count that makes a crash visible",
  );
});

// --- the call sites -------------------------------------------------------

// The lift proves `verdictFor` classifies correctly; it cannot prove the script
// calls it. Both producers of the band are pinned as text, because a call site
// is the half no lifted function can see — and one of the two calling it while
// the other keeps its own inline copy is exactly the state #591 describes.
//
// Each is pinned as the WHOLE returned expression, spread included, and not as
// a span that any mention of `verdictFor` inside it satisfies. A span is the
// weaker pin and it does not hold: `stripComments` documents its own ceiling —
// an inline `/* */` and a trailing `//` keep their text — so a revert that
// rebuilds the object inline and leaves the call named in a surviving comment
// puts the pinned token back where the span reads it. Measured on both spans
// while they were still written that way: each revert passed with its comment
// and failed without it, which is the pin discriminating on comment text.
test("both producers of the unverified band route through verdictFor", () => {
  assert.match(
    CODE,
    /if \(n === 0\) return Promise\.resolve\(\{ \.\.\.f, dimension: d\.key, \.\.\.verdictFor\(0, \[\]\) \}\);/,
    "the policy-skip branch builds its own verdict again instead of routing through verdictFor (#591)",
  );

  // #1813 (crash isolation) turned the single-argument `.then((votes) => {...})`
  // into a two-argument `.then(onFulfilled, onRejected)`: a `retryCrashed`
  // rejection (both dispatches of the refuter pair crashed) must still land
  // in `unverified` through `verdictFor`, not propagate into the shared
  // `Promise.all` and erase every OTHER finding in the dimension. Both
  // branches are pinned in the SAME `.then(...)` call — a revert that keeps
  // the rejected branch but drops the fulfilled one (or the reverse) fails
  // this just as a revert to the old single-argument shape does.
  assert.match(
    CODE,
    /\.then\(\s*\(votes\) => \{\s*return \{ \.\.\.f, dimension: d\.key, \.\.\.verdictFor\(n, votes\) \};\s*\},\s*\(\) => \(\{ \.\.\.f, dimension: d\.key, \.\.\.verdictFor\(n, \[\]\) \}\),\s*\);/,
    "the post-refuter .then() no longer routes both the fulfilled and the crashed-refuter branch through verdictFor (#591, #1813)",
  );
  // The dispatched count is what the discriminant IS, so a call passing a
  // literal or a re-derived value would pin nothing. `n` is the value the
  // policy-skip branch tests, which is what makes the field free.
  assert.match(CODE, /const n = verifiersFor\(f\.severity\)/, "the dispatched count is no longer `n` — update this test");
});

// --- the resume path ------------------------------------------------------

// A crash-heavy `unverified` is RESUMABLE: the Workflow tool replays the
// unchanged prefix of agent() calls from cache and re-runs only the ones that
// died, so the response is resume, not defer. That was true before this ticket
// and was written down nowhere a reader of the result would meet it.
test("the returned object carries resume alongside the three bands", () => {
  const tail = CODE.slice(CODE.lastIndexOf("return {"));
  for (const key of ["survived", "refuted", "unverified"]) {
    assert.match(tail, new RegExp(`\\b${key}\\b`), `the return no longer surfaces ${key} — an existing consumer just broke`);
  }
  assert.match(tail, /\bresume\b/, "the return never surfaces resume — the recovery path dies in the script (#591)");
  assert.match(
    CODE,
    /resumeFromRunId/,
    "the resume string no longer names the parameter that performs the resume — a reader is told to resume and not how",
  );
});

// The field being present is not the field being right. This drives the real
// classification over both populations of the band — the half `resume` exists
// for and the half it must stay quiet on — because a source-text pin on the
// predicate that separates them passes against its own deletion: measured while
// the filter was still inline at the report block, deleting it left this file's
// tests green.
test("the crash population is the dispatched-refuter half of unverified, and only it arms resume", () => {
  const skipped = { severity: "suggestion", verdict: "unverified", votes: [], refutersDispatched: 0 };
  const crashed = { severity: "critical", verdict: "unverified", votes: [], refutersDispatched: 2 };

  const quiet = resumeFor([skipped]);
  assert.deepEqual(quiet.crashed, [], "a policy skip counts as a crashed refuter — the two populations read alike again (#591)");
  assert.equal(quiet.resume, null, "a run where nothing died is told to relaunch — the instruction is boilerplate, not a signal");

  const armed = resumeFor([skipped, crashed]);
  assert.deepEqual(armed.crashed, [crashed], "the crash population no longer separates a dead refuter from a policy skip (#591)");
  assert.match(
    armed.resume,
    /resumeFromRunId/,
    "refuters died and the payload names no way to recover them — the findings nobody looked at get deferred instead",
  );

  // The classification above is reachable from a test whether or not the report
  // block still calls it, so the call is pinned too — dropping the call is the
  // mutation this file stayed green against.
  assert.match(
    CODE,
    /const \{ crashed, resume \} = resumeFor\(unverified\);/,
    "the report no longer derives its crash population and resume from resumeFor (#591)",
  );
});

// --- the reading rules ----------------------------------------------------

// The rule that saves a reader — a finding whose refuters ran and crashed
// always defers — predates the field it can now be checked against, and it
// lived in more than one file. A rule re-expressed in one copy and left resting
// on the reader in the other is the defect moved, not fixed.
const RULE_FILES = [
  ["commands/review-and-fix.md", "A finding in `unverified` whose refuters ran and", "Only a `survived` finding"],
  ["skills/run-team/SKILL.md", "Apply `survived` findings. A finding in `unverified`", "Severity records how much"],
];

for (const [rel, from, to] of RULE_FILES) {
  test(`${rel}'s crashed-refuter rule cites the discriminant`, () => {
    const doc = readFileSync(join(REPO, rel), "utf8");
    const rule = between(doc, from, to, rel);
    assert.match(
      rule,
      phrase("refutersDispatched"),
      `${rel} still asks the reader to remember which population a finding is in — the rule names no field to check (#591)`,
    );
  });
}

// The controller is the other reader, and it meets the return shape rather than
// the apply rule. A field nobody is told to read is a field nobody reads.
test("run-team's Reviewers section documents the discriminant and the resume path", () => {
  const doc = readFileSync(join(REPO, "skills/run-team/SKILL.md"), "utf8");
  const shape = between(doc, "It returns `{pr, head, resume, testEnvironment,", "**`dimensionsRun` is the dispatch", "run-team/SKILL.md");
  assert.match(shape, phrase("refutersDispatched"), "run-team/SKILL.md documents a return shape whose two unverified populations still read alike");
  assert.match(shape, phrase("resume"), "run-team/SKILL.md documents the crashed band without the recovery it has");
});
