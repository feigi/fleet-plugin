// #2881. A refuter whose own check could produce neither a valid red nor a
// valid green abstains: it returns `inconclusive: true` instead of voting.
// Before this, a run that could not decide fell under the refuter's "default to
// refuted=true if uncertain" bias, and `verdictFor` sends a tie to `refuted` —
// so one inconclusive run under load could vote out a finding that a test fails
// to catch a mutant, and the weak test shipped.
//
// An abstention is not a crash. `verdictFor` leaves it out of the tally the way
// it leaves out a dead refuter, but crash accounting — `resumeFor`'s crashed
// bucket and the digest's `counts.crashed` — counts only the dead (`null`)
// refuters, and the finding records how many abstained so the two all-out
// cases stay apart in the payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, verdictFor, resumeFor, VERDICT_SCHEMA } from "../plugin/scripts/review-core.mjs";
import { pipeline, parallel, ARGS, SNAP, review, finding, vote, scriptedHost } from "./support/review-host-fixture.mjs";

const abstain = () => ({ refuted: true, inconclusive: true, reason: "red: node --test → exit 1, fail 0; baseline: node --test → exit 1. CWD-AUDIT: clean /repo" });
const run = (host) => runReview({ ...host, pipeline, parallel }, ARGS);

test("VERDICT_SCHEMA carries an optional boolean `inconclusive`", () => {
  assert.deepEqual(VERDICT_SCHEMA.properties.inconclusive?.type, "boolean");
  assert.ok(!VERDICT_SCHEMA.required.includes("inconclusive"), "a verdict without `inconclusive` must stay valid");
});

test("an abstaining vote is left out of the tally, and the abstain count is reported every time", () => {
  const survives = verdictFor(2, [abstain(), vote(false)]);
  assert.equal(survives.verdict, "survived", "an abstention counted as a refuting vote — the 1-1 tie refuted the finding");
  assert.equal(survives.refutersInconclusive, 1);

  const refutes = verdictFor(2, [abstain(), vote(true)]);
  assert.equal(refutes.verdict, "refuted");
  assert.equal(refutes.refutersInconclusive, 1);

  const out = verdictFor(2, [abstain(), abstain()]);
  assert.equal(out.verdict, "unverified", "every vote abstained and the finding was still ruled on");
  assert.equal(out.refutersInconclusive, 2);
  assert.equal(out.refutersDispatched, 2);

  // What it must ACCEPT: votes that decide are ruled exactly as before, and an
  // explicit `inconclusive: false` is a decided vote.
  const decided = verdictFor(2, [vote(false), { ...vote(false), inconclusive: false }]);
  assert.equal(decided.verdict, "survived");
  assert.equal(decided.refutersInconclusive, 0);
  assert.equal(verdictFor(2, [vote(false), vote(true)]).verdict, "refuted", "the 1-1 tie between decided votes no longer refutes");
  assert.equal(verdictFor(0, []).refutersInconclusive, 0, "a policy skip does not report its abstain count");
  assert.equal(verdictFor(2, [null, null]).refutersInconclusive, 0, "a crashed refuter counted as an abstention");
});

test("resumeFor's crashed bucket holds a finding whose refuters crashed, never one whose refuters all abstained", () => {
  const abstained = { claim: "a", ...verdictFor(2, [abstain(), abstain()]) };
  const crashed = { claim: "b", ...verdictFor(2, [null, null]) };
  const mixed = { claim: "c", ...verdictFor(2, [abstain(), null]) };
  const skipped = { claim: "d", ...verdictFor(0, []) };

  const out = resumeFor([abstained, crashed, mixed, skipped]);
  assert.deepEqual(out.crashed.map((f) => f.claim), ["b", "c"]);
  assert.equal(resumeFor([abstained, skipped]).crashed.length, 0);
  assert.equal(resumeFor([abstained, skipped]).resume, null, "an all-abstained finding reads as a crash to resume");
});

test("a review whose refuter pair all abstained is unverified but not crashed, and resume stays null", async () => {
  const { host, calls } = scriptedHost({
    snapshot: [SNAP],
    "review:correctness": [review([finding("critical")])],
    "verify:correctness": [abstain()],
  });
  const result = await run(host);
  assert.equal(calls["verify:correctness"], 2, "an abstaining pair was re-dispatched as though it had crashed");
  assert.equal(result.unverified.length, 1);
  assert.equal(result.unverified[0].refutersDispatched, 2);
  assert.equal(result.unverified[0].refutersInconclusive, 2);
  assert.deepEqual(result.counts, { survived: 0, refuted: 0, unverified: 1, crashed: 0 });
  assert.equal(result.resume, null);
});

test("a review whose refuter pair all crashed is still counted crashed", async () => {
  const { host } = scriptedHost({
    snapshot: [SNAP],
    "review:correctness": [review([finding("critical")])],
    "verify:correctness": [null],
  });
  const result = await run(host);
  assert.equal(result.unverified[0].refutersInconclusive, 0);
  assert.deepEqual(result.counts, { survived: 0, refuted: 0, unverified: 1, crashed: 1 });
  assert.notEqual(result.resume, null);
});
