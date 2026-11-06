import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, runnerWorktreeRefusal } from "../plugin/scripts/review-core.mjs";
import { ARGS, SNAP, parallel, pipeline, review, scriptedHost } from "./support/review-host-fixture.mjs";

// The worktree is interpolated into the snapshot agent's shell, so a value
// that is not a non-blank string snapshots nothing and costs a dispatch.
// Refused, never trimmed or coerced.
const REFUSED = [undefined, "", null, " ", "\n", 7, {}, [], true];
const SNAPSHOT_ONLY = { snapshot: [SNAP], "review:correctness": [review([])] };

test("runnerWorktreeRefusal accepts a non-blank path string", () => {
  assert.equal(runnerWorktreeRefusal("/wt"), null);
  assert.equal(runnerWorktreeRefusal(ARGS.worktree), null);
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
