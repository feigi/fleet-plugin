import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, runnerPrRefusal, runnerScratchRefusal, runnerTestCmdRefusal, runnerWorktreeRefusal } from "../plugin/scripts/review-core.mjs";
import { ARGS, SNAP, parallel, pipeline, review, scriptedHost } from "./support/review-host-fixture.mjs";

// The worktree is interpolated into the snapshot agent's shell, so a value
// that is not a non-blank string snapshots nothing and costs a dispatch.
// Refused, never trimmed or coerced.
const REFUSED = [undefined, "", null, " ", "\n", 7, {}, [], true];
const SNAPSHOT_ONLY = { snapshot: [SNAP], "review:correctness": [review([])] };

test("runnerWorktreeRefusal accepts a non-blank path string", () => {
  assert.equal(runnerWorktreeRefusal("/wt"), null);
  assert.equal(runnerWorktreeRefusal(ARGS.worktree), null);
  // Padding around non-whitespace content is acceptable too: the rule never trims.
  assert.equal(runnerWorktreeRefusal(" /wt "), null);
});

test("runnerWorktreeRefusal refuses every value that is not a non-blank string, naming args.worktree and the value", () => {
  for (const bad of REFUSED) {
    const refusal = runnerWorktreeRefusal(bad);
    assert.equal(typeof refusal, "string", `${JSON.stringify(bad)} was accepted`);
    assert.match(refusal, /^args\.worktree is required — the checkout the review snapshots, got /, JSON.stringify(bad));
    assert.ok(refusal.endsWith(`got ${JSON.stringify(bad)}`), `${refusal} does not end with the offending value`);
  }
});

test("runReview with a blank or non-string worktree refuses before any agent is dispatched, naming args.worktree", async () => {
  for (const worktree of [" ", "\n", 7, {}, [], true]) {
    const run = scriptedHost(SNAPSHOT_ONLY);
    await assert.rejects(
      runReview({ ...run.host, pipeline, parallel }, { ...ARGS, worktree }),
      /^Error: review-pr: args\.worktree is required/,
      `worktree ${JSON.stringify(worktree)} was not refused naming args.worktree`,
    );
    assert.deepEqual(run.labels, [], `worktree ${JSON.stringify(worktree)} dispatched ${run.labels.join(", ")} before refusing`);
  }
});

test("runReview with an absent pr still refuses with the combined required-args message", async () => {
  for (const worktree of [ARGS.worktree, " "]) {
    const run = scriptedHost(SNAPSHOT_ONLY);
    await assert.rejects(
      runReview({ ...run.host, pipeline, parallel }, { ...ARGS, pr: undefined, worktree }),
      (e) => e.message === "review-pr: args.pr and args.worktree are required",
      `worktree ${JSON.stringify(worktree)}`,
    );
    assert.deepEqual(run.labels, []);
  }
});

// Values JSON.stringify cannot serialise to a string: a BigInt and a circular
// object throw, a Symbol and a function answer `undefined`. Each refusal owes
// the caller the message anyway, naming the value.
const circular = () => {
  const o = {};
  o.self = o;
  return o;
};
const UNSERIALISABLE = [
  ["a BigInt", 1n, "1n"],
  ["a circular object", circular(), "[Circular"],
  ["a Symbol", Symbol("s"), "Symbol(s)"],
  ["a function", () => 1, "[Function"],
];

test("every runner refusal returns its message for a value JSON.stringify cannot serialise, naming the value", () => {
  for (const [what, value, named] of UNSERIALISABLE) {
    const refusals = [
      [runnerWorktreeRefusal(value), /^args\.worktree is required — the checkout the review snapshots, got /],
      [runnerTestCmdRefusal(value), /^args\.testCmd is required — the Test entrypoint the shared run executes, got /],
    ];
    // A BigInt is a PR number: `isDigits` coerces it to its digits.
    if (what !== "a BigInt") refusals.push([runnerPrRefusal(value), /^args\.pr must be a PR number, got /]);
    for (const [refusal, shape] of refusals) {
      assert.equal(typeof refusal, "string", `${what} did not yield a refusal`);
      assert.match(refusal, shape, what);
      assert.ok(refusal.includes(`got ${named}`) || refusal.includes(named), `${what}: ${refusal} does not name the value`);
      assert.ok(!refusal.endsWith("got undefined"), `${what}: ${refusal} names undefined`);
    }
  }
});

test("runnerPrRefusal refuses a value the digits test cannot coerce instead of throwing, and still accepts a BigInt", () => {
  assert.match(runnerPrRefusal(Object.create(null)), /^args\.pr must be a PR number, got /);
  assert.equal(runnerPrRefusal(1n), null);
  assert.equal(runnerPrRefusal(7), null);
  assert.equal(runnerPrRefusal("7"), null);
});

test("runnerScratchRefusal still passes every non-string, including the ones JSON.stringify cannot serialise", () => {
  for (const [, value] of UNSERIALISABLE) assert.equal(runnerScratchRefusal(value), null);
  assert.equal(runnerScratchRefusal(7), null);
  assert.equal(runnerScratchRefusal(undefined), null);
});

test("the refusals keep the same text for every value JSON.stringify serialises", () => {
  for (const bad of [undefined, "", null, " ", 7, {}, [], true]) {
    assert.equal(runnerWorktreeRefusal(bad), `args.worktree is required — the checkout the review snapshots, got ${JSON.stringify(bad)}`);
    assert.equal(runnerTestCmdRefusal(bad), `args.testCmd is required — the Test entrypoint the shared run executes, got ${JSON.stringify(bad)}`);
  }
  for (const bad of [undefined, "", null, "x", [], {}, -7]) {
    assert.equal(runnerPrRefusal(bad), `args.pr must be a PR number, got ${JSON.stringify(bad)}`);
  }
});

test("runReview refuses a value JSON.stringify cannot serialise with a review-pr: Error, dispatching nothing", async () => {
  const cases = [
    ["scratch", 1n, /^review-pr: args\.scratch must be an absolute path, got 1n$/],
    ["scratch", circular(), /^review-pr: args\.scratch must be an absolute path, got .*\[Circular/],
    ["scratch", Symbol("s"), /^review-pr: args\.scratch must be an absolute path, got Symbol\(s\)$/],
    ["pr", circular(), /^review-pr: args\.pr must be a PR number, got .*\[Circular/],
    ["pr", Symbol("s"), /^review-pr: args\.pr must be a PR number, got Symbol\(s\)$/],
    ["testCmd", 1n, /^review-pr: args\.testCmd is required.*got 1n$/],
    ["worktree", 1n, /^review-pr: args\.worktree is required.*got 1n$/],
  ];
  for (const [key, value, message] of cases) {
    const run = scriptedHost(SNAPSHOT_ONLY);
    await assert.rejects(
      runReview({ ...run.host, pipeline, parallel }, { ...ARGS, [key]: value }),
      (e) => e instanceof Error && message.test(e.message),
      `${key} ${String(typeof value)} was not refused with its message`,
    );
    assert.deepEqual(run.labels, [], `${key} dispatched ${run.labels.join(", ")} before refusing`);
  }
});
