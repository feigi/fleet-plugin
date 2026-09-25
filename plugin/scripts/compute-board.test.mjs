// Regression gate for the pure board core. Zero deps:
//   node --test plugin/scripts/compute-board.test.mjs
// Locks stage-derivation and the red-vs-stale distinction — the only tricky
// logic — against a "simplification" silently breaking it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRow, deriveColumn, deriveFlags, STALE_MS } from "./compute-board.mjs";

test("parseRow: a merged row", () => {
  const r = parseRow("#332 impl-332=PR#344 → PR#344 → MERGED 73b356de");
  assert.equal(r.issue, 332);
  assert.equal(r.impl, "impl-332");
  assert.equal(r.pr, 344);
  assert.equal(r.merged, true);
  assert.equal(r.sha, "73b356de");
  assert.equal(r.agent, null, "impl-332 settled at PR#344 — nobody is live on this row");
  assert.equal(r.heldBehind, null);
});

test("parseRow: an in-review row with a live review runner, ruling and held-behind", () => {
  const r = parseRow("#324 impl-324=PR#346 → PR#346 · review=member:review-pr-346-b · ports=16324 · ruled:6-applies · held-behind:#313");
  assert.equal(r.issue, 324);
  assert.equal(r.impl, "impl-324");
  assert.equal(r.agent, "review-pr-346-b");
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
  const p = parseRow("#332 impl-332=PR#344 → PR#344 → MERGED 73b356de");
  assert.equal(deriveColumn(p, { open: false, labels: [] }), "MERGED");
});

test("deriveColumn: READY when the PR carries ready-to-merge", () => {
  const p = parseRow("#324 impl-324=PR#346 → PR#346 · review=member:review-pr-346");
  assert.equal(deriveColumn(p, { open: true, labels: ["ready-to-merge"] }), "READY");
});

test("deriveColumn: REVIEW when a PR exists without the label", () => {
  const p = parseRow("#324 impl-324=PR#346 → PR#346 · review=member:review-pr-346");
  assert.equal(deriveColumn(p, { open: true, labels: [] }), "REVIEW");
});

test("deriveColumn: IMPLEMENTING when there is no PR yet", () => {
  const p = parseRow("#340 impl-340");
  assert.equal(deriveColumn(p, null), "IMPLEMENTING");
});

const MIN = 60 * 1000;

test("deriveFlags: red CI flags red-ci", () => {
  const p = parseRow("#324 impl-324=PR#346 → PR#346");
  const f = deriveFlags(p, { ci: "red", column: "REVIEW", sinceEnteredStage: null, now: 0 });
  assert.ok(f.includes("red-ci"));
});

test("deriveFlags: unknown CI never flags red", () => {
  const p = parseRow("#324 impl-324=PR#346 → PR#346");
  const f = deriveFlags(p, { ci: "unknown", column: "REVIEW", sinceEnteredStage: null, now: 0 });
  assert.ok(!f.includes("red-ci"));
});

test("deriveFlags: held-behind carries the blocker number", () => {
  const p = parseRow("#324 impl-324=PR#346 → PR#346 · held-behind:#313");
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
      "#332 impl-332=PR#344 → PR#344 → MERGED 73b356de",
      "#324 impl-324=PR#346 → PR#346 · review=member:review-pr-346 · held-behind:#313",
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
    ledger: { rows: ["#332 impl-332=PR#344 → PR#344"], filed: [], ruled: [] },
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
  moved.ledger.rows[2] = "#340 impl-340=PR#360 → PR#360"; // now REVIEW
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

// --------------------------------------------------------------------------
// #1820: the Pull-era ledger. The rows below are #1820's own reproduction
// rows, verbatim, measured on main @ 9b147b2 as stale IMPLEMENTING/REVIEW
// cards that all counted in the stall report's `claimed`. PRs 920, 931 and
// 932 are open; 930 is not in the open list, and gh reports it merged.
const REPRO_ROWS = [
  "#901 excluded · behind-pr:#880",
  "#902 excluded · behind-issue:#870",
  "#903 impl-903=bailed",
  "#904 impl-904=killed",
  "#905 impl-905=PR#920 · fix-pr-920=failed",
  "#906 impl-906",
  "#907 impl-907=PR#930",
  "#908 impl-908=PR#931 · review=wf:r123",
  "#909 impl-909=PR#932 · review=member:review-pr-932",
];
const openPr = (number, labels = []) => ({ number, state: "OPEN", labels, title: `pr ${number}` });
const HOUR = 60 * MIN;
// A prior stage entry 1 h old for every row, in the column each row showed on
// main — the measurement's setup, so every non-terminal card is past its
// dwell threshold and any `stale` a card should not carry would show.
const reproInputs = (over = {}) => {
  const now = 10 * HOUR;
  const rows = over.rows ?? REPRO_ROWS;
  const was = (n) => ([905, 907, 908, 909].includes(n) ? "REVIEW" : "IMPLEMENTING");
  return {
    ...baseInputs(),
    ledger: { rows, filed: [], ruled: [] },
    issues: [],
    prs: [openPr(920), openPr(931), openPr(932)],
    merged: [930],
    ci: {},
    prev: { tickets: rows.map((r) => Number(r.slice(1).split(" ")[0])).map((issue) => ({ issue, column: was(issue), sinceEnteredStage: now - HOUR })) },
    now,
    ...over,
  };
};
const card = (b, n) => b.tickets.find((t) => t.issue === n);

test("#1820: an Exclusion is a POOL card with its premise as a badge — never stale, never in attention", () => {
  const b = computeBoard(reproInputs());
  for (const [n, badge] of [[901, "excluded:#880"], [902, "excluded:#870"]]) {
    assert.equal(card(b, n).column, "POOL");
    assert.deepEqual(card(b, n).flags, [badge]);
    assert.equal(card(b, n).agent, null);
    assert.ok(!b.attention.some((t) => t.issue === n), `#${n} is supply, not a stranded claim`);
  }
  assert.equal(b.queue.pool, 2, "both Exclusions count as pool supply");
  assert.equal(b.queue.supply, 2);
});

test("#1820: a branch-named behind-pr premise is its own badge, not a number", () => {
  // Live-ledger shape: the premise is the branch name recorded before its PR existed.
  const b = computeBoard(reproInputs({ rows: ["#1716 excluded · behind-pr:implementer/1715-impl-1715", "#1717 excluded · behind-pr:#implementer/1690-slug"] }));
  assert.deepEqual(card(b, 1716).flags, ["excluded:implementer/1715-impl-1715"]);
  assert.deepEqual(card(b, 1717).flags, ["excluded:implementer/1690-slug"]);
  assert.equal(card(b, 1716).column, "POOL");
});

test("#1820: `excluded` only as the row's first word makes an Exclusion", () => {
  const b = computeBoard(reproInputs({ rows: ["#1705 impl-1705 · previously excluded · behind-pr:#60"] }));
  assert.equal(card(b, 1705).column, "IMPLEMENTING");
  assert.equal(card(b, 1705).agent, "impl-1705");
  assert.ok(!card(b, 1705).flags.some((f) => f.startsWith("excluded")));
});

test("#1820: a released or bailed implementer is a POOL card while ready-for-agent, else no card", () => {
  const gone = computeBoard(reproInputs());
  assert.equal(card(gone, 903), undefined, "#903 bailed and left the ready-for-agent list — relabelled out by cause");
  const rows = ["#903 impl-903=bailed", "#910 impl-910=released"];
  const back = computeBoard(reproInputs({
    rows,
    issues: [{ number: 903, title: "t903", labels: ["ready-for-agent"] }, { number: 910, title: "t910", labels: ["ready-for-agent"] }],
  }));
  for (const n of [903, 910]) {
    assert.equal(card(back, n).column, "POOL");
    assert.deepEqual(card(back, n).flags, []);
  }
  assert.equal(back.tickets.length, 2, "one card per ticket, not a row card beside the pool card");
});

test("#1820: a killed or tier-mismatch implementer stays IMPLEMENTING, flagged in attention", () => {
  const b = computeBoard(reproInputs({ rows: ["#904 impl-904=killed", "#911 impl-911=tier-mismatch"] }));
  assert.equal(card(b, 904).column, "IMPLEMENTING");
  assert.ok(card(b, 904).flags.includes("killed"));
  assert.equal(card(b, 911).column, "IMPLEMENTING");
  assert.ok(card(b, 911).flags.includes("tier-mismatch"));
  assert.deepEqual(b.attention.map((t) => t.issue).sort(), [904, 911]);
  assert.equal(card(b, 904).agent, null, "a settled member is not live");
});

test("#1820: the uppercase enrichment causes keep working, and KILLED beside =killed flags once", () => {
  const b = computeBoard(reproInputs({ rows: ["#912 impl-912 BLOCKED", "#913 impl-913=PR#931 SHA-OFF-BRANCH", "#914 impl-914=killed KILLED"] }));
  assert.ok(card(b, 912).flags.includes("blocked"));
  assert.ok(card(b, 913).flags.includes("sha-off-branch"));
  assert.equal(card(b, 914).flags.filter((f) => f === "killed").length, 1);
});

test("#1820: the row's LAST impl token decides, retry suffix included", () => {
  const b = computeBoard(reproInputs({
    rows: ["#915 impl-915=killed · impl-915-b", "#916 impl-916=bailed · impl-916-b=PR#931", "#917 impl-917=PR#920 · impl-917-b"],
  }));
  assert.equal(card(b, 915).column, "IMPLEMENTING");
  assert.equal(card(b, 915).agent, "impl-915-b");
  assert.ok(!card(b, 915).flags.includes("killed"), "the killed attempt was replaced");
  assert.equal(card(b, 916).column, "REVIEW");
  assert.equal(card(b, 916).pr, 931);
  assert.equal(card(b, 917).column, "IMPLEMENTING", "a live retry after a settled PR is back at work");
  assert.equal(card(b, 917).pr, null);
});

test("#1820: a live implementer is IMPLEMENTING, and still earns stale", () => {
  const b = computeBoard(reproInputs());
  assert.equal(card(b, 906).column, "IMPLEMENTING");
  assert.equal(card(b, 906).agent, "impl-906");
  assert.ok(card(b, 906).flags.includes("stale"));
});

test("#1820: MERGED comes from gh for a row PR absent from the open list", () => {
  const b = computeBoard(reproInputs());
  assert.equal(card(b, 907).column, "MERGED");
  assert.deepEqual(card(b, 907).flags, [], "MERGED is terminal — never stale");
});

test("#1820: a closed-unmerged PR keeps today's REVIEW column", () => {
  const b = computeBoard(reproInputs({ merged: [] }));
  assert.equal(card(b, 907).column, "REVIEW");
  // `merged` absent entirely — a hand-built caller — means none known.
  const inp = reproInputs();
  delete inp.merged;
  assert.equal(card(computeBoard(inp), 907).column, "REVIEW");
});

test("#1820: an explicit MERGED token still wins, over the open list and gh alike", () => {
  const b = computeBoard(reproInputs({
    rows: ["#918 impl-918=PR#931 → PR#931 → MERGED 73b356de"],
    prs: [openPr(931, ["ready-to-merge"])],
    merged: [],
  }));
  assert.equal(card(b, 918).column, "MERGED");
});

test("#1820: the merged read is consulted only for PRs absent from the open list", () => {
  const b = computeBoard(reproInputs({ rows: ["#919 impl-919=PR#931"], merged: [931] }));
  assert.equal(card(b, 919).column, "REVIEW", "the open list is gh's fresher answer for an open PR");
});

test("#1820: review=wf/member, or a live fix-pr/finisher-pr, is under review; agent is the latest live member", () => {
  const b = computeBoard(reproInputs());
  assert.equal(card(b, 908).column, "REVIEW");
  assert.equal(card(b, 908).agent, null, "a Workflow review names no member");
  assert.equal(card(b, 909).agent, "review-pr-932");
  assert.equal(card(b, 905).agent, null, "fix-pr-920 settled failed — nobody is live");
  assert.equal(b.queue.reviewBacklog, 1, "only #905 has neither review= nor reviewed=");

  const live = computeBoard(reproInputs({
    rows: [
      "#920 impl-920=PR#931 · fix-pr-931",
      "#921 impl-921=PR#932 · review=member:review-pr-932 reviewed=abc1234:1/0/0 · finisher-pr-932",
      "#922 impl-922=PR#920 · review=wf:r1=failed review=fallback:review-pr-920-b",
      "#923 impl-923=PR#931 · review=member:review-pr-931 reviewed=abc1234:0/0/0",
    ],
  }));
  assert.equal(card(live, 920).agent, "fix-pr-931");
  assert.equal(card(live, 921).agent, "finisher-pr-932");
  assert.equal(card(live, 922).agent, "review-pr-920-b");
  assert.equal(card(live, 923).agent, null, "reviewed= settles the runner that produced it");
  assert.equal(live.queue.reviewBacklog, 0);
});

test("#1820: live-ledger PR rows — settled finisher, fallback runner", () => {
  const b = computeBoard(reproInputs({
    rows: [
      "#1715 impl-1715=PR#1824 · class=correction · reviewed=41901d4c:0/1/0 · finisher-pr-1824=labelled",
      "#1721 impl-1721=PR#1825 · class=correction · review=fallback:review-pr-1825-b",
      "#1755 impl-1755=PR#1830 · class=routine",
    ],
    prs: [openPr(1824, ["ready-to-merge"]), openPr(1825), openPr(1830)],
  }));
  assert.equal(card(b, 1715).column, "READY");
  assert.equal(card(b, 1715).agent, null);
  assert.equal(card(b, 1721).agent, "review-pr-1825-b");
  assert.equal(b.queue.reviewBacklog, 1, "only #1755 is waiting on a reviewer");
});

test("#1820: the reproduction's stall report counts only the real claims", () => {
  const b = computeBoard({ ...reproInputs(), beat: { at: 10 * HOUR - 90 * MIN, interval: 1200, stopped: "" } });
  // #904 killed, #905/#908/#909 in review, #906 live — Exclusions, the bailed
  // #903 and the merged #907 are nobody's outstanding claim.
  assert.equal(b.liveness.claimed, 5);
  assert.deepEqual(b.attention.map((t) => t.issue).sort(), [904, 905, 906, 908, 909]);
});

test("#1820: `## Dispatched` is not read — row tokens alone decide", () => {
  const b = computeBoard(reproInputs({
    rows: ["#906 impl-906"],
    ledger: { rows: ["#906 impl-906"], dispatched: ["impl-906=bailed", "impl-950"], filed: [], ruled: [] },
  }));
  assert.equal(card(b, 906).column, "IMPLEMENTING");
  assert.equal(card(b, 906).agent, "impl-906");
  assert.equal(card(b, 950), undefined);
});

test("#1820: a malformed member outcome is never fatal and never counted live", () => {
  const b = computeBoard(reproInputs({ rows: ["#924 impl-924=PR#931 · fix-pr-931=exploded"] }));
  assert.equal(card(b, 924).column, "REVIEW");
  assert.equal(card(b, 924).agent, null);
});
