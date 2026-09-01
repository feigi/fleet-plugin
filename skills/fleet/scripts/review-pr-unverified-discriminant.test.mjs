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
const REPO = join(import.meta.dirname, "..", "..", "..");
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
test("both producers of the unverified band route through verdictFor", () => {
  const skip = CODE.match(/if \(n === 0\) return Promise\.resolve\(\{[^}]*\}\);/);
  assert.ok(skip, "review-pr.js no longer returns early on a 0-refuter band — update this test");
  assert.match(
    skip[0],
    /verdictFor\(0, \[\]\)/,
    "the policy-skip branch builds its own verdict again instead of routing through verdictFor (#591)",
  );

  assert.match(
    CODE,
    /\.then\(\(votes\) => \{[\s\S]*?verdictFor\(n, votes\)/,
    "the post-refuter branch builds its own verdict again instead of routing through verdictFor (#591)",
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

// --- the reading rules ----------------------------------------------------

// The rule that saves a reader — a finding whose refuters ran and crashed
// always defers — predates the field it can now be checked against, and it
// lived in more than one file. A rule re-expressed in one copy and left resting
// on the reader in the other is the defect moved, not fixed.
const RULE_FILES = [
  ["skills/fleet/commands/review-and-fix.md", "A finding in `unverified` whose refuters ran and", "Only a `survived` finding"],
  ["skills/fleet/skills/run-team/SKILL.md", "Apply `survived` findings. A finding in `unverified`", "Severity records how much"],
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
  const doc = readFileSync(join(REPO, "skills/fleet/skills/run-team/SKILL.md"), "utf8");
  const shape = between(doc, "It returns `{pr, head, snapshot,", "**`dimensionsRun` is the dispatch", "run-team/SKILL.md");
  assert.match(shape, phrase("refutersDispatched"), "run-team/SKILL.md documents a return shape whose two unverified populations still read alike");
  assert.match(shape, phrase("resume"), "run-team/SKILL.md documents the crashed band without the recovery it has");
});
