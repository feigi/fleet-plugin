// #1802 (spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 3 §2, §6).
// Two changes to the review's own result, in review-core.mjs's own body:
//
//   1. Crash repair inside the run. Each crashed specialist is re-dispatched
//      once, and each refuter pair whose every vote died is re-dispatched once
//      as a pair, before the result is assembled. What still fails lands in
//      `dimensionsUnrun` / `unverified` as before, and `resume` now means
//      "crashed again after the in-run retry".
//   2. Digest first. The small fields a controller acts on lead the returned
//      object and the bulky finding arrays trail it, so a large review's
//      digest is available without depending on (or risking truncation from)
//      the finding arrays that follow it (before this, `resume` was LAST).
//
// Driven through a SCRIPTED HOST rather than a mocked runReview: `agent`,
// `pipeline`, `parallel`, `phase`, `log` are exactly the parameters
// runReview takes off `host`, so the retry and the digest ordering are
// exercised as review-core.mjs's own wiring runs them, never a re-derived
// copy of what that wiring is supposed to do. The fixtures below are shared
// with review-path-default.test.mjs's own return-shape pin, via
// review-host-fixture.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, DIGEST_KEYS, digestOf } from "./review-core.mjs";
import { pipeline, parallel, ARGS, SNAP, SHARED, review, finding, vote, scriptedHost } from "./review-host-fixture.mjs";

const COPIES = [["review-core.mjs", (host, args) => runReview({ ...host, pipeline, parallel }, args)]];

for (const [name, run] of COPIES) {
  test(`${name}: a specialist that crashes once is re-dispatched, and its review lands`, async () => {
    const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [null, review([])] });
    const result = await run(host, ARGS);
    assert.equal(calls["review:correctness"], 2, "a crashed specialist was not re-dispatched in-run");
    assert.deepEqual(result.dimensionsUnrun, [], "the re-dispatched specialist's review was not used");
    assert.equal(result.cwdAudit.length, 1);
  });

  test(`${name}: a thrown specialist dispatch is a crash too, and is re-dispatched`, async () => {
    const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [new Error("spend limit"), review([])] });
    const result = await run(host, ARGS);
    assert.equal(calls["review:correctness"], 2);
    assert.deepEqual(result.dimensionsUnrun, []);
  });

  test(`${name}: a specialist that crashes twice is dispatched exactly twice, then named unrun`, async () => {
    const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [null] });
    const result = await run(host, ARGS);
    assert.equal(calls["review:correctness"], 2, "the retry is ONE re-dispatch, not a loop");
    assert.equal(result.dimensionsUnrun.length, 1);
    assert.equal(result.dimensionsUnrun[0].dimension, "correctness");
    assert.match(result.dimensionsUnrun[0].reason, /returned nothing/);
  });

  // #2315: the suite is the review's one shared run now, and it is never
  // re-dispatched either — a crashed test-run agent may already have launched
  // the command, so a retry would be a second full run.
  test(`${name}: a specialist that RETURNED over a shared run that ran nothing is not a crash — never re-dispatched`, async () => {
    const { host, calls } = scriptedHost({
      snapshot: [SNAP],
      "test-run": [{ exitCode: 0, tests: 0, pass: 0, fail: 0 }],
      "review:correctness": [review([])],
    });
    const result = await run(host, ARGS);
    assert.equal(calls["review:correctness"], 1, "a returned-but-unrun review was re-dispatched as if it had crashed");
    assert.equal(calls["test-run"], 1);
    assert.equal(result.dimensionsUnrun.length, 1);
    assert.match(result.dimensionsUnrun[0].reason, /0 tests/);
  });

  test(`${name}: a crashed shared test run is dispatched once, never retried, and every dimension is unrun`, async () => {
    for (const crash of [null, new Error("spend limit")]) {
      const { host, calls } = scriptedHost({
        snapshot: [SNAP],
        "test-run": [crash, SHARED],
        "review:correctness": [review([])],
        "review:tests": [review([])],
      });
      const result = await run(host, { ...ARGS, dimensions: ["correctness", "tests"] });
      assert.equal(calls["test-run"], 1, "the shared test run was re-dispatched — a second full-suite launch");
      assert.deepEqual(
        result.dimensionsUnrun.map((u) => u.dimension),
        ["correctness", "tests"],
      );
      for (const u of result.dimensionsUnrun) assert.match(u.reason, /no counts|returned nothing/);
    }
  });

  test(`${name}: a refuter pair whose every vote died is re-dispatched once, as a pair`, async () => {
    const { host, calls } = scriptedHost({
      snapshot: [SNAP],
      "review:correctness": [review([finding("critical")])],
      "verify:correctness": [null, null, vote(false), vote(false)],
    });
    const result = await run(host, ARGS);
    assert.equal(calls["verify:correctness"], 4, "a wholly crashed refuter pair was not re-dispatched as a pair");
    assert.equal(result.survived.length, 1);
    assert.equal(result.survived[0].refutersDispatched, 2);
    assert.deepEqual(result.counts, { survived: 1, refuted: 0, unverified: 0, crashed: 0 });
    assert.equal(result.resume, null, "a pair the retry recovered still reads as crashed");
  });

  test(`${name}: a pair that crashes again after the retry is unverified, counted crashed, and resume says so`, async () => {
    const { host, calls } = scriptedHost({
      snapshot: [SNAP],
      "review:correctness": [review([finding("critical")])],
      "verify:correctness": [null],
    });
    const result = await run(host, ARGS);
    assert.equal(calls["verify:correctness"], 4, "the pair retry is ONE re-dispatch, not a loop");
    assert.equal(result.unverified.length, 1);
    assert.equal(result.unverified[0].refutersDispatched, 2);
    assert.deepEqual(result.counts, { survived: 0, refuted: 0, unverified: 1, crashed: 1 });
    assert.match(result.resume, /in-run retry/, "resume no longer says the crash survived the in-run retry");
  });

  // #1813: a REJECTED dispatch (not a resolved `null`) is the shape every
  // real `parallel()`/`agent()` failure actually takes on omp — see
  // `retryCrashed`'s own doc comment: "that second answer is final, THROWN or
  // not". Before this fix, a finding whose refuter pair rejected on both
  // `retryCrashed` attempts propagated that rejection into the shared,
  // findings-level `parallel()` (a bare `Promise.all`), which discarded every
  // OTHER finding under the same dimension — including ones whose refuters
  // fully succeeded — and reported the whole dimension `dimensionsUnrun`
  // with the misleading "the reviewer returned nothing" reason, even though
  // the specialist's review DID come back with real findings.
  test(`${name}: a finding whose refuter pair rejects on both retry attempts does not erase its dimension-mates' verdicts`, async () => {
    const crashing = finding("critical");
    const surviving = finding("important");
    const calls = { crashing: 0, surviving: 0 };
    const host = {
      agent: async (prompt, opts) => {
        if (opts.label === "snapshot") return structuredClone(SNAP);
        if (opts.label === "test-run") return structuredClone(SHARED);
        if (opts.label === "review:correctness") return structuredClone(review([crashing, surviving]));
        if (opts.label === "verify:correctness") {
          if (prompt.includes(crashing.claim)) {
            calls.crashing++;
            throw new Error(`refuter crash ${calls.crashing}`);
          }
          if (prompt.includes(surviving.claim)) {
            calls.surviving++;
            return structuredClone(vote(false));
          }
          throw new Error("scriptedHost: unexpected verify prompt");
        }
        throw new Error(`scriptedHost: unexpected dispatch ${opts.label}`);
      },
      phase: () => {},
      log: () => {},
    };
    const result = await run(host, ARGS);
    assert.equal(calls.crashing, 4, "the crashing pair is dispatched twice per attempt, across both retryCrashed attempts");
    assert.equal(calls.surviving, 2, "the surviving pair's own refuters are undisturbed by the other finding's crash");
    assert.equal(result.survived.length, 1, "a fully-verified sibling finding must not be erased by another finding's crash");
    assert.equal(result.survived[0].claim, surviving.claim);
    assert.equal(result.unverified.length, 1, "the crashed finding is reported unverified, not silently dropped");
    assert.equal(result.unverified[0].claim, crashing.claim);
    assert.equal(result.unverified[0].refutersDispatched, 2);
    assert.deepEqual(result.dimensionsUnrun, [], "the dimension itself ran and returned real findings — it must not read as unrun");
    assert.deepEqual(result.counts, { survived: 1, refuted: 0, unverified: 1, crashed: 1 });
  });

  test(`${name}: a pair with one live vote did not crash — it is ruled on that vote, not re-dispatched`, async () => {
    const { host, calls } = scriptedHost({
      snapshot: [SNAP],
      "review:correctness": [review([finding("important")])],
      "verify:correctness": [null, vote(true)],
    });
    const result = await run(host, ARGS);
    assert.equal(calls["verify:correctness"], 2, "a pair with a surviving vote was re-dispatched as if every refuter had died");
    assert.equal(result.refuted.length, 1);
    assert.deepEqual(result.counts, { survived: 0, refuted: 1, unverified: 0, crashed: 0 });
  });

  test(`${name}: a suggestion's 0-refuter budget is policy, not a crash — nothing is dispatched for it`, async () => {
    const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [review([finding("suggestion")])] });
    const result = await run(host, ARGS);
    assert.equal(calls["verify:correctness"], undefined, "a 0-refuter suggestion bought a refuter dispatch");
    assert.equal(result.unverified.length, 1);
    assert.equal(result.unverified[0].refutersDispatched, 0);
    assert.deepEqual(result.counts, { survived: 0, refuted: 0, unverified: 1, crashed: 0 });
    assert.equal(result.resume, null);
  });

  test(`${name}: the digest leads the returned object, so it is a prefix of the serialized result`, async () => {
    const { host } = scriptedHost({
      snapshot: [SNAP],
      "review:correctness": [review([finding("critical"), finding("suggestion")])],
      "verify:correctness": [vote(false)],
    });
    const result = await run(host, ARGS);
    assert.deepEqual(Object.keys(result), [...DIGEST_KEYS, "snapshot", "survived", "refuted", "unverified"]);
    // The consumer-visible property, not the key list: the pre-cutover
    // harness hands the controller the FIRST ~8 KB of the serialized result,
    // so every digest field has to be serialized before the first byte of a
    // finding array.
    const whole = JSON.stringify(result);
    const digest = JSON.stringify(digestOf(result));
    assert.ok(whole.startsWith(digest.slice(0, -1) + ","), "a bulk field is serialized ahead of the digest — a large review truncates it away");
  });
}

// The accept half of the digest helper: every digest key, nothing else, and in
// the result's own order — a digest that dropped `resume` is the defect this
// reorder exists to fix, one layer up.
test("digestOf keeps exactly the digest keys, in order, and leaves the finding arrays behind", async () => {
  const { host } = scriptedHost({ snapshot: [SNAP], "review:correctness": [review([finding("suggestion")])] });
  const result = await runReview({ ...host, pipeline, parallel }, ARGS);
  const digest = digestOf(result);
  assert.deepEqual(Object.keys(digest), DIGEST_KEYS);
  for (const bulk of ["snapshot", "survived", "refuted", "unverified"]) assert.equal(bulk in digest, false, bulk);
});
