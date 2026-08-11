// Regression gate for the reconcile tick. Zero deps:
//   ./agent-test skills/fleet/scripts/fleet-tick.test.mjs
//
// The pure half locks the queue-depth guard table — the whole point of #3 is
// that the table stops being prose the controller must remember, so a
// "simplification" that drops a row has to go red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, formatLines } from "./fleet-tick.mjs";

// Every field named, so a test that cares about one number still states the
// rest — a defaulted field is a guard nobody is pinning.
const state = (over = {}) => ({
  implLive: 0, reviewerLive: 0, mergeBotLive: 0,
  pool: 0, supply: 0, reviewBacklog: 0, mergeQueue: 0,
  implCap: 2, reviewerCap: 5,
  ...over,
});
const row = (s, role) => reconcile(s).find((r) => r.role === role);

test("implementers: drained queue with pool and no backlog dispatches", () => {
  const r = row(state({ implLive: 0, pool: 3, reviewBacklog: 0 }), "implementers");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 2);
  assert.equal(r.action, "DISPATCH 2");
});

test("implementers: dispatch is capped by the pool, not just the deficit", () => {
  const r = row(state({ implLive: 0, pool: 1, implCap: 5 }), "implementers");
  assert.equal(r.action, "DISPATCH 1");
});

test("implementers: dispatch never takes live past the cap", () => {
  for (const implCap of [1, 2, 5]) {
    for (const implLive of [0, 1, 2, 5]) {
      const r = row(state({ implLive, pool: 99, implCap }), "implementers");
      const n = Number((r.action.match(/^DISPATCH (\d+)$/) || [])[1] ?? 0);
      // Either dispatch nothing, or land at or under the cap. Stated as an
      // alternative rather than `live + n <= cap` because a controller that
      // already reports MORE live than the cap must not have its overshoot
      // read as licence to dispatch, nor the row assert its way out of it.
      assert.ok(n === 0 || implLive + n <= implCap, `cap ${implCap} live ${implLive} → ${r.action}`);
    }
  }
});

test("implementers: review backlog of 2 holds the refill even with pool left", () => {
  const r = row(state({ implLive: 0, pool: 3, reviewBacklog: 2 }), "implementers");
  assert.equal(r.action, "HOLD");
  assert.match(r.detail, /review-backlog=2/);
});

test("implementers: backlog 1 is below the gate and still dispatches", () => {
  const r = row(state({ implLive: 0, pool: 3, reviewBacklog: 1 }), "implementers");
  assert.equal(r.action, "DISPATCH 2");
});

test("implementers: the backlog hold outranks every pool-0 branch", () => {
  // Re-shortlisting to enable a dispatch that is being held buys nothing, and a
  // /triage suggestion under a hold is noise the controller would act on.
  for (const supply of [0, 1, 99]) {
    const r = row(state({ implLive: 0, pool: 0, supply, reviewBacklog: 2 }), "implementers");
    assert.equal(r.action, "HOLD", `supply ${supply}`);
  }
});

test("implementers: at cap, nothing is dispatched however deep the pool", () => {
  const r = row(state({ implLive: 2, implCap: 2, pool: 99 }), "implementers");
  assert.equal(r.action, "AT CAP");
});

test("implementers: over cap still refuses, and the row shows the overshoot", () => {
  const r = row(state({ implLive: 3, implCap: 2, pool: 99 }), "implementers");
  assert.equal(r.action, "AT CAP");
  assert.equal(r.actual, 3);
  assert.equal(r.target, 2);
});

test("implementers: pool 0, supply >= cap re-shortlists without suggesting triage", () => {
  const r = row(state({ pool: 0, supply: 2, implCap: 2 }), "implementers");
  assert.equal(r.action, "RE-SHORTLIST");
  assert.doesNotMatch(r.action, /triage/);
});

test("implementers: pool 0, 0 < supply < cap re-shortlists AND suggests triage", () => {
  const r = row(state({ pool: 0, supply: 1, implCap: 2 }), "implementers");
  assert.equal(r.action, "RE-SHORTLIST + SUGGEST /triage");
});

test("implementers: pool 0 and supply 0 suggests triage and holds idle", () => {
  const r = row(state({ pool: 0, supply: 0 }), "implementers");
  assert.equal(r.action, "SUGGEST /triage");
  assert.match(r.detail, /idle/);
});

test("implementers: detail always carries the three numbers the branch turned on", () => {
  const r = row(state({ pool: 4, supply: 57, reviewBacklog: 1 }), "implementers");
  assert.match(r.detail, /pool=4/);
  assert.match(r.detail, /supply=57/);
  assert.match(r.detail, /review-backlog=1/);
});

test("reviewers: no PRs queued for review is idle, not a deficit", () => {
  const r = row(state({ reviewerLive: 0, reviewBacklog: 0 }), "reviewers");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 5);
  assert.equal(r.action, "IDLE OK");
});

test("reviewers: dispatch is the smaller of the free slots and the backlog", () => {
  assert.equal(row(state({ reviewerLive: 0, reviewBacklog: 2 }), "reviewers").action, "DISPATCH 2");
  assert.equal(row(state({ reviewerLive: 4, reviewBacklog: 9 }), "reviewers").action, "DISPATCH 1");
  assert.equal(row(state({ reviewerLive: 5, reviewBacklog: 9 }), "reviewers").action, "AT CAP");
});

test("merge-bot: a queued ready-to-merge PR with no bot live dispatches one", () => {
  const r = row(state({ mergeBotLive: 0, mergeQueue: 3 }), "merge-bot");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 1);
  assert.equal(r.action, "DISPATCH merge-bot");
  assert.match(r.detail, /merge-queue=3/);
});

test("merge-bot: never a second bot, however deep the merge queue", () => {
  assert.equal(row(state({ mergeBotLive: 1, mergeQueue: 9 }), "merge-bot").action, "AT CAP");
});

test("merge-bot: an empty merge queue is idle", () => {
  assert.equal(row(state({ mergeBotLive: 0, mergeQueue: 0 }), "merge-bot").action, "IDLE OK");
});

test("merge-queue depth never gates the implementer refill", () => {
  // run-team is explicit that the refill gate is the REVIEW backlog and never
  // the merge queue; a deep ready-to-merge queue costs no extra rebases per PR.
  const shallow = row(state({ pool: 3, mergeQueue: 0 }), "implementers");
  const deep = row(state({ pool: 3, mergeQueue: 20 }), "implementers");
  assert.equal(shallow.action, deep.action);
});

test("reconcile returns exactly the three roles, in a stable order", () => {
  assert.deepEqual(reconcile(state()).map((r) => r.role), ["implementers", "reviewers", "merge-bot"]);
});

test("formatLines prints role, actual/target and the ACTION on one line each", () => {
  const lines = formatLines(reconcile(state({ implLive: 0, pool: 1, mergeQueue: 2 })));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^implementers\s+0\/2 → DISPATCH 1\b/);
  assert.match(lines[2], /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/);
});
