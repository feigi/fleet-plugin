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

import { computeBoard } from "./compute-board.mjs";

const baseInputs = () => ({
  ledger: {
    rows: [
      "#332 impl-332 → PR#344 → MERGED 73b356de",
      "#324 impl-324 → PR#346 · review-pr-346 · held-behind:#313",
      "#340 impl-340",
    ],
    filed: ["#351 flaky retry marker in ci logs"],
    ruled: ["#346 6-applies keep the fallback"],
  },
  issues: [{ number: 341, title: "add a --json flag", labels: ["ready-for-agent"] }],
  prs: [
    { number: 344, state: "MERGED", labels: [], title: "impl 332" },
    { number: 346, state: "OPEN", labels: [], title: "impl 324" },
  ],
  ci: { 344: "green", 346: "red" },
  prev: null,
  now: 1000,
  repo: "owner/repo",
  repoUrl: "https://example.test/owner/repo",
});

test("computeBoard: one ticket per column, POOL from an unrowed ready issue", () => {
  const b = computeBoard(baseInputs());
  const col = (n) => b.tickets.find((t) => t.issue === n).column;
  assert.equal(col(332), "MERGED");
  assert.equal(col(324), "REVIEW");
  assert.equal(col(340), "IMPLEMENTING");
  assert.equal(col(341), "POOL");
});

// #786 review: board.mjs used to default a PR row's missing `state` to
// "UNKNOWN" before handing it here. That default was inert — `pr.state ===
// "OPEN"` (below) is already false for `undefined`, same as for "UNKNOWN" —
// so board.mjs now passes `state` through raw. Pin the OBSERVABLE effect
// rather than the internal sentinel value: a PR row with no `state` at all
// still lands in REVIEW like any other open-PR ticket, not crashed or
// silently misplaced by the missing field.
test("computeBoard: a PR row with no state still lands in REVIEW", () => {
  const b = computeBoard({
    ...baseInputs(),
    prs: [{ number: 344, labels: [], title: "impl 332" }],
    ledger: { rows: ["#332 impl-332 → PR#344"], filed: [], ruled: [] },
  });
  assert.equal(b.tickets.find((t) => t.issue === 332).column, "REVIEW");
});

test("computeBoard: ruling attaches to the PR ticket", () => {
  const b = computeBoard(baseInputs());
  assert.equal(b.tickets.find((t) => t.issue === 324).ruling, "6-applies keep the fallback");
});

test("computeBoard: attention holds only flagged tickets, red-ci before held-behind", () => {
  const b = computeBoard(baseInputs());
  assert.deepEqual(b.attention.map((t) => t.issue), [324]); // red-ci + held-behind
  assert.ok(b.attention[0].flags.includes("red-ci"));
});

test("computeBoard: filed follow-ups are parsed to {issue,subject}", () => {
  const b = computeBoard(baseInputs());
  assert.deepEqual(b.filed, [{ issue: 351, subject: "flaky retry marker in ci logs" }]);
});

test("computeBoard: dwell carries forward while the column is unchanged", () => {
  const first = computeBoard({ ...baseInputs(), now: 1000 });
  const second = computeBoard({ ...baseInputs(), prev: first, now: 5000 });
  // #340 stayed IMPLEMENTING → keep the original entry time
  assert.equal(second.tickets.find((t) => t.issue === 340).sinceEnteredStage, 1000);
});

test("computeBoard: dwell resets when the column changes", () => {
  const first = computeBoard({ ...baseInputs(), now: 1000 });
  const moved = baseInputs();
  moved.ledger.rows[2] = "#340 impl-340 → PR#360"; // now REVIEW
  moved.prs.push({ number: 360, state: "OPEN", labels: [], title: "impl 340" });
  const second = computeBoard({ ...moved, prev: first, now: 5000 });
  assert.equal(second.tickets.find((t) => t.issue === 340).sinceEnteredStage, 5000);
});

test("computeBoard: queue counts pool and review-backlog", () => {
  const b = computeBoard(baseInputs());
  assert.equal(b.queue.pool, 1);
  // #324 has a reviewer token, so it is NOT backlog
  assert.equal(b.queue.reviewBacklog, 0);
});

test("computeBoard: repo and repoUrl are echoed to the model", () => {
  const b = computeBoard(baseInputs());
  assert.equal(b.repo, "owner/repo");
  assert.equal(b.repoUrl, "https://example.test/owner/repo");
});

test("computeBoard: a PR with no CI entry is unknown, not null (null means no PR)", () => {
  const inp = baseInputs();
  delete inp.ci[346];                       // #324's PR exists but CI has not reported
  const t = computeBoard(inp).tickets.find((x) => x.issue === 324);
  assert.equal(t.ci, "unknown");
  // a genuinely PR-less ticket still reports null
  assert.equal(computeBoard(inp).tickets.find((x) => x.issue === 340).ci, null);
});

test("computeBoard: ledgerState reflects gather()'s read outcome", () => {
  for (const state of ["unread", "unparsed", "read"]) {
    const inp = baseInputs();
    inp.ledger = { ...inp.ledger, state };
    assert.equal(computeBoard(inp).ledgerState, state);
  }
});

test("computeBoard: ledgerState defaults to read when gather() reports none", () => {
  const inp = baseInputs(); // ledger has no `state` key
  assert.equal(computeBoard(inp).ledgerState, "read");
});
