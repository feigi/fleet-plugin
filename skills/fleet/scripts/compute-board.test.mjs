// Regression gate for the pure board core. Zero deps:
//   node --test skills/fleet/scripts/compute-board.test.mjs
// Locks stage-derivation and the red-vs-stale distinction — the only tricky
// logic — against a "simplification" silently breaking it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRow, deriveColumn, deriveFlags, STALE_MS } from "./compute-board.mjs";

test("parseRow: a merged row", () => {
  const r = parseRow("#332 impl-332 → PR#344 → MERGED 73b356de");
  assert.equal(r.issue, 332);
  assert.equal(r.impl, "impl-332");
  assert.equal(r.pr, 344);
  assert.equal(r.merged, true);
  assert.equal(r.sha, "73b356de");
  assert.equal(r.reviewer, null);
  assert.equal(r.heldBehind, null);
});

test("parseRow: an in-review row with reviewer, ruling and held-behind", () => {
  const r = parseRow("#324 impl-324 → PR #346 · review-pr-346-b · ports=16324 · ruled:6-applies · held-behind:#313");
  assert.equal(r.issue, 324);
  assert.equal(r.impl, "impl-324");
  assert.equal(r.reviewer, "review-pr-346-b");
  assert.equal(r.pr, 346);
  assert.equal(r.merged, false);
  assert.equal(r.heldBehind, 313);
});

test("parseRow: implementing row, no PR yet", () => {
  const r = parseRow("#340 impl-340");
  assert.equal(r.pr, null);
  assert.equal(r.merged, false);
  assert.deepEqual(r.causes, []);
});

test("parseRow: enrichment cause tokens are lowercased", () => {
  const r = parseRow("#319 impl-319 KILLED");
  assert.deepEqual(r.causes, ["killed"]);
});

test("parseRow: a non-ticket line returns null", () => {
  assert.equal(parseRow("## Rows"), null);
});

test("deriveColumn: MERGED wins from the ledger alone", () => {
  const p = parseRow("#332 impl-332 → PR#344 → MERGED 73b356de");
  assert.equal(deriveColumn(p, { open: false, labels: [] }), "MERGED");
});

test("deriveColumn: READY when the PR carries ready-to-merge", () => {
  const p = parseRow("#324 impl-324 → PR#346 · review-pr-346");
  assert.equal(deriveColumn(p, { open: true, labels: ["ready-to-merge"] }), "READY");
});

test("deriveColumn: REVIEW when a PR exists without the label", () => {
  const p = parseRow("#324 impl-324 → PR#346 · review-pr-346");
  assert.equal(deriveColumn(p, { open: true, labels: [] }), "REVIEW");
});

test("deriveColumn: IMPLEMENTING when there is no PR yet", () => {
  const p = parseRow("#340 impl-340");
  assert.equal(deriveColumn(p, null), "IMPLEMENTING");
});

const MIN = 60 * 1000;

test("deriveFlags: red CI flags red-ci", () => {
  const p = parseRow("#324 impl-324 → PR#346");
  const f = deriveFlags(p, { ci: "red", column: "REVIEW", sinceEnteredStage: null, now: 0 });
  assert.ok(f.includes("red-ci"));
});

test("deriveFlags: unknown CI never flags red", () => {
  const p = parseRow("#324 impl-324 → PR#346");
  const f = deriveFlags(p, { ci: "unknown", column: "REVIEW", sinceEnteredStage: null, now: 0 });
  assert.ok(!f.includes("red-ci"));
});

test("deriveFlags: held-behind carries the blocker number", () => {
  const p = parseRow("#324 impl-324 → PR#346 · held-behind:#313");
  const f = deriveFlags(p, { ci: "green", column: "REVIEW", sinceEnteredStage: null, now: 0 });
  assert.ok(f.includes("held-behind:#313"));
});

test("deriveFlags: stale when dwell exceeds the column threshold", () => {
  const p = parseRow("#340 impl-340");
  const now = 100 * MIN;
  const f = deriveFlags(p, { ci: null, column: "IMPLEMENTING", sinceEnteredStage: now - (STALE_MS.IMPLEMENTING + MIN), now });
  assert.ok(f.includes("stale"));
});

test("deriveFlags: fresh dwell is not stale", () => {
  const p = parseRow("#340 impl-340");
  const now = 100 * MIN;
  const f = deriveFlags(p, { ci: null, column: "IMPLEMENTING", sinceEnteredStage: now - MIN, now });
  assert.ok(!f.includes("stale"));
});

test("deriveFlags: cause tokens surface as flags", () => {
  const p = parseRow("#319 impl-319 KILLED");
  const f = deriveFlags(p, { ci: null, column: "IMPLEMENTING", sinceEnteredStage: 0, now: 0 });
  assert.ok(f.includes("killed"));
});
