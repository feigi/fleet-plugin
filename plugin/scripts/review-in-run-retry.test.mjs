// #1802 (spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 3 §2, §6).
// Two changes to the review's own result, made in BOTH copies of the review
// body — review-core.js (omp, imported) and workflows/review-pr.js (Claude,
// executed here as the function body the Workflow harness compiles it as):
//
//   1. Crash repair inside the run. Each crashed specialist is re-dispatched
//      once, and each refuter pair whose every vote died is re-dispatched once
//      as a pair, before the result is assembled. What still fails lands in
//      `dimensionsUnrun` / `unverified` as before, and `resume` now means
//      "crashed again after the in-run retry".
//   2. Digest first. The small fields a controller acts on lead the returned
//      object and the bulky finding arrays trail it, so the digest survives
//      Claude's ~8 KB inline `<result>` cut (before this, `resume` was LAST).
//
// WHY EXECUTE review-pr.js RATHER THAN LIFT FROM IT. Every other review-pr.js
// pin lifts a pure declaration out of the source text. The retry is wiring at
// two dispatch sites inside the top-level script, and a lifted helper proves
// nothing about whether those sites call it. review-pr.js compiles as an
// AsyncFunction body (review-pr-reads.test.mjs's parse check uses the same
// parameter list), so it can be RUN against a scripted host — the harness
// globals (`agent`, `pipeline`, `parallel`, `phase`, `log`) are exactly the
// parameters that compile names. Every scenario below runs through both copies
// with the same script, so the two bodies are held to one behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runReview, DIGEST_KEYS, digestOf } from "./review-core.js";

const REPO = join(import.meta.dirname, "..");
const WORKFLOW = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8").replace(/^export /m, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflowBody = new AsyncFunction("args", "budget", "agent", "parallel", "pipeline", "phase", "log", "workflow", WORKFLOW);

// Claude's pipeline contract as review-pr.js's own comment on `unrunCrashed`
// states it — a null stage-1 result never reaches stage 2 — with a throw
// landing in the same null slot, the shape review-eval.mjs's omp pipeline has.
async function pipeline(items, stage1, stage2) {
  return Promise.all(
    items.map(async (item) => {
      let r1;
      try {
        r1 = await stage1(item);
      } catch {
        r1 = null;
      }
      if (!r1) return null;
      try {
        return await stage2(r1, item);
      } catch {
        return null;
      }
    }),
  );
}
const parallel = (fns) => Promise.all(fns.map((fn) => fn()));

const COPIES = [
  ["review-core.js", (host, args) => runReview({ ...host, pipeline, parallel }, args)],
  ["review-pr.js", (host, args) => workflowBody(args, undefined, host.agent, parallel, pipeline, host.phase, host.log, undefined)],
];

const ARGS = { pr: 7, branch: "feature/x", worktree: "/repo/.worktrees/7-x", scratch: "/scr", testCmd: "node --test", dimensions: ["correctness"] };
const SNAP = {
  runRoot: "/scr/pr7/run-ab12",
  path: "/scr/pr7/run-ab12/snapshot-abc123",
  head: "abc123",
  pathVerified: true,
  repoVerified: true,
  testCmd: "node --test",
};
const RAN = { command: "node --test", tests: 5, pass: 5, fail: 0 };
const review = (findings, testRun = RAN) => ({
  dimension: "correctness",
  scope_searched: "CWD-AUDIT: clean /repo",
  findings,
  test_run: testRun,
});
const finding = (severity) => ({ severity, claim: `a ${severity} claim`, file: "a.js", line: 3, evidence: "line 3 has no else" });
const vote = (refuted) => ({ refuted, reason: "measured. CWD-AUDIT: clean /repo" });

// A host whose `agent()` answers each dispatch label from a script, one entry
// per call in dispatch order (the last entry repeats), and counts the calls.
// An `Error` entry is thrown rather than returned. Counting happens
// synchronously on the call, so the two refuters of one pair are calls 1 and
// 2 of their label, and a re-dispatched pair is calls 3 and 4.
function scriptedHost(script) {
  const calls = {};
  return {
    calls,
    host: {
      agent: async (_prompt, opts) => {
        const n = (calls[opts.label] = (calls[opts.label] ?? 0) + 1);
        const seq = script[opts.label];
        if (!seq) throw new Error(`scriptedHost: unexpected dispatch ${opts.label}`);
        const answer = seq[Math.min(n, seq.length) - 1];
        if (answer instanceof Error) throw answer;
        return answer === null ? null : structuredClone(answer);
      },
      phase: () => {},
      log: () => {},
    },
  };
}

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

  test(`${name}: a specialist that RETURNED but ran no suite is not a crash — never re-dispatched`, async () => {
    const { host, calls } = scriptedHost({
      snapshot: [SNAP],
      "review:correctness": [review([], { command: "node --test", tests: 0, pass: 0, fail: 0 })],
    });
    const result = await run(host, ARGS);
    assert.equal(calls["review:correctness"], 1, "a returned-but-unrun review was re-dispatched as if it had crashed");
    assert.equal(result.dimensionsUnrun.length, 1);
    assert.match(result.dimensionsUnrun[0].reason, /0 tests/);
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
    // The consumer-visible property, not the key list: Claude hands the
    // controller the FIRST ~8 KB of the serialized result, so every digest
    // field has to be serialized before the first byte of a finding array.
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
