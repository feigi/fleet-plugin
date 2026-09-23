// Regression gate for the pure board core. Zero deps:
//   node --test plugin/scripts/compute-board.test.mjs
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
  workspace: "/w/one",
  port: 8337,
});

test("computeBoard: one ticket per column, POOL from an unrowed ready issue", () => {
  const b = computeBoard(baseInputs());
  const col = (n) => b.tickets.find((t) => t.issue === n).column;
  assert.equal(col(332), "MERGED");
  assert.equal(col(324), "REVIEW");
  assert.equal(col(340), "IMPLEMENTING");
  assert.equal(col(341), "POOL");
});

// #1331: candidates.mjs's EXCLUDE negates all five wayfinder:* labels so a
// wayfinder ticket never enters the DISPATCH scan regardless of triage role,
// but the POOL loop below used to show one anyway — a ready-for-agent
// wayfinder ticket (#1293's shape) rendered as an undispatchable POOL card,
// inflating the operator's read of available work. Filtered by label prefix
// here, in the POOL loop itself, not by narrowing gather()'s gh query —
// narrowing the query also strips the ticket from `issues`, which titleFor()
// below reads for ledger rows that have nothing to do with POOL (see the next
// test).
test("computeBoard: an unrowed wayfinder:* issue never becomes a POOL card", () => {
  const b = computeBoard({
    ...baseInputs(),
    issues: [{ number: 341, title: "add a --json flag", labels: ["ready-for-agent", "wayfinder:task"] }],
  });
  assert.equal(b.tickets.find((t) => t.issue === 341), undefined);
});

// The fix for the regression above must not reach into gather()'s gh query:
// doing so also drops the wayfinder-labelled issue from `issues`, which
// titleFor() reads for every non-PR ledger row (e.g. #340, IMPLEMENTING, no
// PR yet) whose issue happens to carry a wayfinder label for an unrelated
// reason. Losing that lookup regresses #340's card to a bare `#340` even
// though only the POOL column was ever supposed to change.
test("computeBoard: a ledger-row ticket linked to a wayfinder-labelled issue keeps its real title", () => {
  const b = computeBoard({
    ...baseInputs(),
    issues: [
      { number: 341, title: "add a --json flag", labels: ["ready-for-agent"] },
      { number: 340, title: "real ledger-row title", labels: ["wayfinder:task"] },
    ],
  });
  assert.equal(b.tickets.find((t) => t.issue === 340).title, "real ledger-row title");
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

test("computeBoard: the instance identity — repo, repoUrl, workspace, port — is echoed, never derived", () => {
  const b = computeBoard(baseInputs());
  assert.equal(b.repo, "owner/repo");
  assert.equal(b.repoUrl, "https://example.test/owner/repo");
  // #1584: gather() joins these from resolveCockpitInstance(); this module
  // reads no cwd, no git and no socket, so an echo is the whole contract.
  assert.equal(b.workspace, "/w/one");
  assert.equal(b.port, 8337);
});

// A caller with no instance to name — every hand-built inputs object, and the
// gather() drivers in board-prev-shape.test.mjs — must still produce a board
// carrying both KEYS. `undefined` disappears from JSON.stringify, and the
// launch handshake #1585 added reads `workspace` straight off the served
// JSON: a board with the key missing is a board it can never match.
test("computeBoard: absent workspace/port are null, not missing keys", () => {
  const inp = baseInputs();
  delete inp.workspace;
  delete inp.port;
  const b = computeBoard(inp);
  assert.equal(b.workspace, null);
  assert.equal(b.port, null);
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

// --------------------------------------------------------------------------
// The liveness surface — #1597. `beat` is telemetry beside `spend`, under the
// same rule: it can only ever POPULATE or OMIT `liveness`, never move a
// ticket. The cockpit is one renderer of the heartbeat's mark, never the
// thing that holds it.

// `now` in baseInputs is 1000ms past the epoch, which is a fine clock for
// dwell but useless for an age in minutes — so the liveness cases move it
// somewhere a 20-minute-old mark can exist behind it.
const NOW = 2_000_000_000_000;
const livenessInputs = (beat) => ({ ...baseInputs(), now: NOW, beat });

test("computeBoard: a stalled beat populates `liveness` with what is stranded", () => {
  const b = computeBoard(livenessInputs({ at: NOW - 90 * 60_000, interval: 1200, stopped: "" }));
  assert.equal(b.liveness.kind, "stale");
  // Counted off THIS model rather than re-queried: a ticket past POOL and
  // short of MERGED is one the ledger placed and nothing landed — the same
  // population the claim label marks, reached from the ledger the cockpit
  // already read. #324 (REVIEW) and #340 (IMPLEMENTING); #332 merged, #341 is
  // still pool.
  assert.equal(b.liveness.claimed, 2);
  assert.equal(b.liveness.supply, b.queue.pool);
  // The rendered line rides the payload because board.html is served as one
  // self-contained file and cannot import the rule. A second wording on the
  // page is a second answer to "is this run dead".
  assert.match(b.liveness.text, /heartbeat STALLED/);
  assert.match(b.liveness.text, /2 ticket\(s\) claimed and in flight/);
  assert.match(b.liveness.text, /70m past the 20m interval it promised/);
});

test("computeBoard: a failed ledger or pool read reports `unknown`, never a false zero", () => {
  // #1597 follow-up. `claimed`/`supply` derive from `ledger.rows`/`issues`,
  // which both collapse to the SAME empty array on a genuinely-drained read
  // and on a failed one (gather()'s tryRun/tryParse fallback) — the exact
  // collapse `ledgerState` exists to undo elsewhere on this same board. A
  // stall banner that quietly prints "0 claimed, pool supply 0" off a read
  // that never happened is the one report an operator has no reason to
  // distrust, and it also outranks and hides the ledger-read-failed banner
  // that would have explained the zeros.
  const stale = { at: NOW - 90 * 60_000, interval: 1200, stopped: "" };

  // Ledger read failed — the ticket-derived half must go unknown, and the
  // pool half, which never depended on the ledger, must stay a real count.
  const noLedger = computeBoard({
    ...livenessInputs(stale), ledger: { rows: [], filed: [], ruled: [], state: "unread" },
  });
  assert.equal(noLedger.liveness.claimed, null);
  assert.equal(noLedger.liveness.supply, noLedger.queue.pool);
  assert.match(noLedger.liveness.text, /unknown ticket\(s\) claimed and in flight/);

  // Pool read failed — the reverse split.
  const noPool = computeBoard({ ...livenessInputs(stale), poolOk: false });
  assert.equal(noPool.liveness.claimed, 2);
  assert.equal(noPool.liveness.supply, null);
  assert.match(noPool.liveness.text, /pool supply unknown/);

  // Both failed at once.
  const both = computeBoard({
    ...livenessInputs(stale), ledger: { rows: [], filed: [], ruled: [], state: "unparsed" }, poolOk: false,
  });
  assert.equal(both.liveness.claimed, null);
  assert.equal(both.liveness.supply, null);

  // A read that genuinely succeeded and came back empty is still a real 0,
  // never smuggled into `unknown` by an over-broad guard.
  const emptyOk = computeBoard({
    ...livenessInputs(stale), ledger: { rows: [], filed: [], ruled: [], state: "read" },
  });
  assert.equal(emptyOk.liveness.claimed, 0);
});

test("computeBoard: a healthy or absent beat omits the surface rather than rendering an empty one", () => {
  // Null, not an `{ ok: true }`-shaped nothing: the page hides the banner on
  // null, and a banner that fires on every healthy tick is a banner the
  // operator learns to read past — which would cost exactly the one night it
  // was built for.
  assert.equal(computeBoard(livenessInputs({ at: NOW - 60_000, interval: 300, stopped: "" })).liveness, null);
  assert.equal(computeBoard(livenessInputs(null)).liveness, null);
  // And a caller that passes no `beat` at all — every hand-built test driver,
  // and any board.json written before this key existed — gets the same null
  // rather than a crash or an undefined key.
  const inp = baseInputs();
  delete inp.beat;
  assert.equal(computeBoard(inp).liveness, null);
});

test("computeBoard: a deliberate stop reaches the page with its reason", () => {
  const b = computeBoard(livenessInputs({ at: NOW - 60_000, interval: 300, stopped: "budget exhausted" }));
  assert.equal(b.liveness.kind, "stopped");
  assert.match(b.liveness.text, /recorded reason: budget exhausted/);
});

test("computeBoard: a liveness input can never change a ticket's stage", () => {
  // The constraint the ticket states in its own words, and the one a
  // populate/omit assertion alone would not catch: a stall must not flag,
  // re-column, re-dwell or promote anything. The dead controller is the
  // reason nobody is moving the tickets; it is not itself a ticket movement.
  const quiet = computeBoard(livenessInputs(null));
  for (const beat of [
    { at: NOW - 90 * 60_000, interval: 1200, stopped: "" },
    { at: NOW - 60_000, interval: 300, stopped: "budget exhausted" },
    { at: NOW - 60_000, interval: 300, stopped: "" },
  ]) {
    const b = computeBoard(livenessInputs(beat));
    assert.deepEqual(b.tickets, quiet.tickets, "a liveness input moved a ticket");
    assert.deepEqual(b.attention, quiet.attention, "a liveness input raised an attention row");
    assert.deepEqual(b.queue, quiet.queue, "a liveness input changed the queue counts");
  }
});
