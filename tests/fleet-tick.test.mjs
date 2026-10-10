// Regression gate for the reconcile tick. Zero deps:
//   node --test tests/fleet-tick.test.mjs
//
// The pure half locks the guard table and the ledger reading — the whole point
// of #3 is that the table stops being prose the controller must remember, and
// the whole point of #1803 is that the counts stop being numbers the controller
// recites. A "simplification" that drops a row, or a reading that counts a
// settled member live, has to go red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, formatLines, actionable, deriveRun, parseShortlist, unclaimed, refreshWhy, dispositionsToken, currentDispositions } from "../plugin/scripts/fleet-tick.mjs";

// Every field named, so a test that cares about one number still states the
// rest — a defaulted field is a guard nobody is pinning.
const state = (over = {}) => ({
  implCap: 2, reviewerCap: 6, maxReviews: 6,
  implLive: 0, draining: null, tierMismatch: [], tierUnchecked: [], implNames: [],
  heads: [], supply: 0, shortlistStatus: "ok", refresh: null,
  reviewsLive: 0, fixLive: 0, fixDue: [], reviewDue: [], unlabelled: [], conflicts: [], conflictEscalate: [],
  mergeBotLive: 0, mergeQueue: 0, mergeHeld: 0, mergeConflictHeld: 0,
  mainCheckout: { state: "clean" },
  ...over,
});
const rowsOf = (s, role) => reconcile(s).filter((r) => r.role === role);
const row = (s, role) => rowsOf(s, role)[0];

// ---------------------------------------------------------------------------
// The implementer row.

test("implementers: free slots PULL the next unclaimed heads, one per slot, oldest first", () => {
  const r = row(state({ heads: [412, 415, 420], supply: 9 }), "implementers");
  assert.equal(r.action, "PULL #412 #415");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 2);
  assert.equal(r.acts, true);
});

test("implementers: a PULL never takes live past the cap", () => {
  for (const implCap of [1, 2, 5, 8]) {
    for (const implLive of [0, 1, 2, 5, 9]) {
      const r = row(state({ implCap, implLive, heads: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), "implementers");
      const n = r.action.startsWith("PULL") ? r.action.split(" ").length - 1 : 0;
      assert.ok(n === 0 || implLive + n <= implCap, `cap ${implCap} live ${implLive} → ${r.action}`);
    }
  }
});

test("implementers: the PULL is bounded by the heads there are, not only by the deficit", () => {
  assert.equal(row(state({ implCap: 5, heads: [7] }), "implementers").action, "PULL #7");
});

test("implementers: at cap nothing is pulled, however many heads are waiting", () => {
  const r = row(state({ implLive: 2, heads: [1, 2, 3] }), "implementers");
  assert.equal(r.action, "AT CAP");
  assert.equal(r.acts, false);
});

test("implementers: nothing unclaimed suggests /triage and holds idle — never actionable", () => {
  const r = row(state({ heads: [] }), "implementers");
  assert.equal(r.action, "SUGGEST /triage, hold idle");
  assert.equal(r.acts, false);
});

test("implementers: the backlog gate holds only when an unreviewed PR is left AND no reviewer slot is free", () => {
  // Saturated: six units live, one PR still owed its review.
  const held = row(state({ heads: [9], reviewsLive: 1, fixLive: 5, reviewDue: [501] }), "implementers");
  assert.equal(held.action, "HOLD (review side saturated)");
  assert.equal(held.acts, false);
  // The narrowing: a deep review backlog with slots free is NOT a hold — the
  // reviewer row dispatches into those slots on this same tick. The old gate
  // held here at backlog >= 2.
  const deep = row(state({ heads: [9], reviewDue: [501, 502, 503] }), "implementers");
  assert.equal(deep.action, "PULL #9");
  // Saturated slots with nothing owed is not a hold either.
  assert.equal(row(state({ heads: [9], fixLive: 6 }), "implementers").action, "PULL #9");
});

test("implementers: the gate counts the slots this tick's own dispatches fill", () => {
  // Five units live, one slot free, two PRs owed: the one free slot takes a
  // review now, one PR is left owed and nothing is free — saturated.
  const s = state({ heads: [9], reviewsLive: 0, fixLive: 5, reviewDue: [501, 502] });
  assert.equal(row(s, "reviewers").action, "DISPATCH review PR#501");
  assert.equal(row(s, "implementers").action, "HOLD (review side saturated)");
});

test("implementers: --max-reviews leaving a PR owed with slots free does not hold implementers", () => {
  // The review side is throttled, not saturated: fix-appliers can still take
  // the free slots, so more PRs are not a pipeline that gains nothing.
  const s = state({ heads: [9], maxReviews: 1, reviewsLive: 1, reviewDue: [501] });
  assert.equal(row(s, "implementers").action, "PULL #9");
});

test("implementers: draining holds the row and outranks every other branch", () => {
  for (const over of [{}, { implLive: 2 }, { tierMismatch: ["impl-4"] }, { tierUnchecked: ["impl-4"] }, { reviewDue: [1], fixLive: 6 }]) {
    const r = row(state({ heads: [7], draining: "maintainer asked", ...over }), "implementers");
    assert.equal(r.action, "HOLD (draining)", JSON.stringify(over));
    assert.equal(r.acts, false);
  }
});

// #2255: a tier hold's detail names the step that clears it, so the row
// carries its own command when SKILL.md's prose is gone from context.
test("implementers: a tier mismatch holds the row, names the member, asks the controller to act, and names the replacement", () => {
  const r = row(state({ heads: [7], tierMismatch: ["impl-412"] }), "implementers");
  assert.equal(r.action, "HOLD (tier mismatch impl-412)");
  assert.equal(r.acts, true, "the controller fixes a mismatch unattended — backing off on it is a stall");
  assert.match(r.detail, /^unclaimed=1 supply=0 unreviewed=0 — /, "the counts stay in front of the clearing step");
  assert.match(r.detail, /dispatch impl-412-b at its row's tier/);
});

test("implementers: a mismatched replacement names the NEXT retry letter, one per held member", () => {
  const r = row(state({ tierMismatch: ["impl-8-b", "impl-9"] }), "implementers");
  assert.equal(r.action, "HOLD (tier mismatch impl-8-b impl-9)");
  assert.match(r.detail, /dispatch impl-8-c, impl-9-b each at its row's tier/);
  assert.doesNotMatch(r.detail, /impl-8-b-b|impl-9-c/);
  // `-z` is the grammar's last letter: no legal replacement name to print, so
  // the row says so instead of naming one ledger.mjs would refuse.
  assert.match(row(state({ tierMismatch: ["impl-8-z"] }), "implementers").detail, /impl-8-z has no retry letter left/);
});

test("implementers: a mismatch batch with some members named and some out of letters prints both clauses, `; `-joined", () => {
  const counts = "unclaimed=0 supply=0 unreviewed=0";
  assert.equal(row(state({ tierMismatch: ["impl-8-b", "impl-9-z"] }), "implementers").detail,
    `${counts} — dispatch impl-8-c at its row's tier; impl-9-z has no retry letter left`);
  assert.equal(row(state({ tierMismatch: ["impl-7-z", "impl-9-z"] }), "implementers").detail,
    `${counts} — impl-7-z, impl-9-z have no retry letter left`);
});

test("implementers: an unchecked implementer holds the row and asks the controller to run the check; a mismatch outranks it", () => {
  const r = row(state({ heads: [7], tierUnchecked: ["impl-412"] }), "implementers");
  assert.equal(r.action, "HOLD (tier unchecked impl-412)");
  assert.equal(r.acts, true, "running tier-check is the controller's own step — backing off on it is a stall");
  assert.ok(r.detail.includes(
    `run ~/.fleet/bin/fleet-run tier-check.mjs --batch <file> with [{"member":"impl-412","session":"<session>"}]`), r.detail);
  const both = row(state({ heads: [7], tierMismatch: ["impl-9"], tierUnchecked: ["impl-412"] }), "implementers");
  assert.equal(both.action, "HOLD (tier mismatch impl-9)");
  assert.doesNotMatch(both.detail, /tier-check/, "the detail names the step for the hold the row prints, not the one it outranks");
});

test("implementers: several unchecked members share one batch file, one entry each", () => {
  const r = row(state({ tierUnchecked: ["impl-7", "impl-8-b"] }), "implementers");
  assert.ok(r.detail.includes(
    `[{"member":"impl-7","session":"<session>"},{"member":"impl-8-b","session":"<session>"}]`), r.detail);
});

test("implementers: no tier hold, no clearing step in the detail", () => {
  for (const over of [{ heads: [7] }, { draining: "x", tierUnchecked: ["impl-4"] }, {}]) {
    assert.doesNotMatch(row(state(over), "implementers").detail, /—/, JSON.stringify(over));
  }
});

test("implementers: the detail carries the numbers the branch turned on", () => {
  const r = row(state({ heads: [4, 5, 6], supply: 57, reviewDue: [1] }), "implementers");
  assert.match(r.detail, /unclaimed=3/);
  assert.match(r.detail, /supply=57/);
  assert.match(r.detail, /unreviewed=0/);
  assert.match(row(state({ supply: null, shortlistStatus: "missing" }), "implementers").detail, /supply=\? unreviewed=0 shortlist=missing$/);
});

// ---------------------------------------------------------------------------
// The reviewer rows.

test("reviewers: nothing owed and nothing in flight is idle", () => {
  const r = row(state(), "reviewers");
  assert.equal(r.action, "IDLE OK");
  assert.equal(r.target, 6);
  assert.equal(r.acts, false);
});

test("reviewers: fix-appliers are named before reviews — finish what is started", () => {
  const rs = rowsOf(state({ fixDue: [346, 348], reviewDue: [350, 351] }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["DISPATCH fix-pr PR#346 PR#348", "DISPATCH review PR#350 PR#351"]);
  assert.ok(rs.every((r) => r.acts));
  // One free slot: the fix-applier takes it and the review waits.
  const one = rowsOf(state({ fixLive: 5, fixDue: [346], reviewDue: [350] }), "reviewers");
  assert.deepEqual(one.map((r) => r.action), ["DISPATCH fix-pr PR#346"]);
});

test("reviewers: dispatches never take live units past the reviewer cap", () => {
  for (const reviewerCap of [1, 3, 6]) {
    for (const [reviewsLive, fixLive] of [[0, 0], [1, 0], [0, 3], [2, 4], [4, 4]]) {
      const rs = rowsOf(state({
        reviewerCap, maxReviews: reviewerCap, reviewsLive, fixLive,
        fixDue: [1, 2, 3, 4], reviewDue: [5, 6, 7, 8],
      }), "reviewers");
      const n = rs.filter((r) => r.action.startsWith("DISPATCH")).reduce((k, r) => k + r.action.match(/PR#/g).length, 0);
      assert.ok(n === 0 || reviewsLive + fixLive + n <= reviewerCap,
        `cap ${reviewerCap} live ${reviewsLive}+${fixLive} → ${rs.map((r) => r.action)}`);
    }
  }
});

test("reviewers: --max-reviews bounds reviews in flight, and a throttled review is a HOLD that says why", () => {
  assert.equal(row(state({ maxReviews: 1, reviewDue: [350, 351] }), "reviewers").action, "DISPATCH review PR#350");
  const held = row(state({ maxReviews: 1, reviewsLive: 1, reviewDue: [351] }), "reviewers");
  assert.equal(held.action, "HOLD (max-reviews 1 in flight)");
  assert.equal(held.acts, false);
  // The bound is on REVIEWS: fix-appliers still take the free slots.
  const rs = rowsOf(state({ maxReviews: 1, reviewsLive: 1, fixDue: [346], reviewDue: [351] }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["DISPATCH fix-pr PR#346"]);
});

test("reviewers: work owed with every slot full is AT CAP", () => {
  assert.equal(row(state({ fixLive: 6, fixDue: [1], reviewDue: [2] }), "reviewers").action, "AT CAP");
});

// #2331: a finisher that settled `labelled` on a PR still lacking
// `ready-to-merge` is repaired by one fresh finisher, and escalated past that.
// Finishers are uncapped, so neither row ever waits on a reviewer slot.
test("reviewers: one labelled finisher on an unlabelled PR dispatches a finisher, uncapped and actionable", () => {
  const unlabelled = [{ pr: 40, labelled: ["finisher-pr-40"] }, { pr: 44, labelled: ["finisher-pr-44-b"] }];
  const rs = rowsOf(state({ unlabelled }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["DISPATCH finisher PR#40 PR#44"], "IDLE OK never prints beside it");
  assert.equal(rs[0].acts, true);
  assert.match(rs[0].detail, /finisher-pr-40, finisher-pr-44-b settled labelled; no ready-to-merge/);
  const full = rowsOf(state({ fixLive: 6, fixDue: [1], unlabelled }), "reviewers");
  assert.deepEqual(full.map((r) => r.action), ["AT CAP", "DISPATCH finisher PR#40 PR#44"], "a full reviewer side holds no finisher");
});

test("reviewers: a second labelled finisher in one stretch escalates instead — never actionable, never a dispatch", () => {
  const rs = rowsOf(state({ unlabelled: [{ pr: 40, labelled: ["finisher-pr-40", "finisher-pr-40-b"] }] }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["ESCALATE unlabelled PR#40"]);
  assert.equal(rs[0].acts, false);
  assert.match(rs[0].detail, /finisher-pr-40, finisher-pr-40-b settled labelled/);
  const both = rowsOf(state({ fixDue: [7], unlabelled: [
    { pr: 40, labelled: ["finisher-pr-40", "finisher-pr-40-b"] }, { pr: 41, labelled: ["finisher-pr-41"] },
  ] }), "reviewers");
  assert.deepEqual(both.map((r) => r.action), ["DISPATCH fix-pr PR#7", "DISPATCH finisher PR#41", "ESCALATE unlabelled PR#40"]);
});

// A tracked PR GitHub reads CONFLICTING, with no hold and nobody on it: the
// controller records the hold itself, so the line carries the exact step.
test("reviewers: a CONFLICT line names the hold to record for each PR, actionable, beside the reviewer row", () => {
  const rs = rowsOf(state({ conflicts: [40, 44] }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["IDLE OK", "CONFLICT PR#40 PR#44"]);
  assert.equal(rs[0].acts, false);
  assert.equal(rs[1].acts, true);
  assert.match(rs[1].detail, /ledger\.mjs read, then .*ledger\.mjs row <key> "<text> · conflict-hold:#40 \(conflict: mergeable=CONFLICTING\)"/);
  assert.match(rs[1].detail, /ledger\.mjs row <key> "<text> · conflict-hold:#44 \(conflict: mergeable=CONFLICTING\)"/);
  assert.equal(actionable(reconcile(state({ conflicts: [40] }))), true, "it counts as a change for the quiet line");
  const busy = rowsOf(state({ fixDue: [7], conflicts: [40] }), "reviewers");
  assert.deepEqual(busy.map((r) => r.action), ["DISPATCH fix-pr PR#7", "CONFLICT PR#40"]);
});

test("reviewers: a conflict past the treadmill cap escalates instead — never actionable, no hold to record", () => {
  const rs = rowsOf(state({ conflictEscalate: [40] }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["IDLE OK", "ESCALATE conflict PR#40"]);
  assert.equal(rs[1].acts, false);
  assert.doesNotMatch(rs[1].detail, /conflict-hold:/);
  assert.equal(actionable(reconcile(state({ conflictEscalate: [40] }))), false);
  const both = rowsOf(state({ conflicts: [41], conflictEscalate: [40] }), "reviewers");
  assert.deepEqual(both.map((r) => r.action), ["IDLE OK", "CONFLICT PR#41", "ESCALATE conflict PR#40"]);
});

test("reviewers: a conflict line still prints with the reviewer side at cap, and sits after the unlabelled rows", () => {
  const full = rowsOf(state({ fixLive: 6, fixDue: [1], reviewDue: [2], conflicts: [40], conflictEscalate: [41] }), "reviewers");
  assert.deepEqual(full.map((r) => r.action), ["AT CAP", "CONFLICT PR#40", "ESCALATE conflict PR#41"], "a full reviewer side holds no conflict line");
  const ordered = rowsOf(state({
    conflicts: [42], conflictEscalate: [43],
    unlabelled: [{ pr: 40, labelled: ["finisher-pr-40", "finisher-pr-40-b"] }, { pr: 41, labelled: ["finisher-pr-41"] }],
  }), "reviewers");
  assert.deepEqual(ordered.map((r) => r.action), [
    "DISPATCH finisher PR#41", "ESCALATE unlabelled PR#40", "CONFLICT PR#42", "ESCALATE conflict PR#43",
  ]);
});

test("reviewers: no conflict, no conflict line", () => {
  assert.deepEqual(rowsOf(state(), "reviewers").map((r) => r.action), ["IDLE OK"]);
});

// ---------------------------------------------------------------------------
// The merge-bot row.

test("merge-bot: a queued, unheld PR with no bot live dispatches one", () => {
  const r = row(state({ mergeQueue: 3 }), "merge-bot");
  assert.equal(r.action, "DISPATCH merge-bot");
  assert.equal(r.acts, true);
  assert.match(r.detail, /merge-queue=3 held=0/);
});

test("merge-bot: never a second bot, an empty queue is idle, a fully held queue holds", () => {
  assert.equal(row(state({ mergeBotLive: 1, mergeQueue: 9 }), "merge-bot").action, "AT CAP");
  assert.equal(row(state({ mergeQueue: 0 }), "merge-bot").action, "IDLE OK");
  const held = row(state({ mergeQueue: 2, mergeHeld: 2 }), "merge-bot");
  assert.equal(held.action, "HOLD");
  assert.equal(held.acts, false);
  assert.equal(row(state({ mergeQueue: 3, mergeHeld: 2 }), "merge-bot").action, "DISPATCH merge-bot");
});

// ---------------------------------------------------------------------------
// The shortlist row.

test("shortlist: a refresh prints REFRESHED with its counts, and is actionable only when it changed the list", () => {
  const changed = reconcile(state({ refresh: { ok: true, entries: 5, lifted: 1, changed: true, trigger: "unclaimed 0 < cap 2" } })).at(-1);
  assert.equal(changed.role, "shortlist");
  assert.equal(changed.action, "REFRESHED shortlist: 5 entries; 1 lifted");
  assert.equal(changed.acts, true);
  // Unchanged: every idle heartbeat tick refreshes while the shortlist is
  // short of the cap, so an unconditionally actionable REFRESHED would pin the
  // beat at its base interval all night — ADR 0008 §6's back-off, undone.
  const same = reconcile(state({ refresh: { ok: true, entries: 0, lifted: 0, changed: false, trigger: "shortlist empty" } })).at(-1);
  assert.equal(same.action, "REFRESHED shortlist: 0 entries; 0 lifted");
  assert.equal(same.acts, false);
  assert.match(same.detail, /unchanged/);
  assert.equal(actionable(reconcile(state({ refresh: { ok: true, entries: 0, lifted: 0, changed: false, trigger: "x" } }))), false);
});

test("shortlist: a failed refresh is named and actionable, never a refusal of the tick", () => {
  const rows = reconcile(state({ mergeQueue: 1, refresh: { ok: false, why: "shortlist.mjs exited 2: boom", trigger: "shortlist missing" } }));
  const r = rows.at(-1);
  assert.equal(r.action, "REFRESH FAILED");
  assert.match(r.detail, /shortlist missing — shortlist\.mjs exited 2: boom/);
  assert.equal(r.acts, true);
  assert.equal(row(state({ mergeQueue: 1 }), "merge-bot").action, "DISPATCH merge-bot");
});

test("no refresh, no shortlist row", () => {
  assert.deepEqual(reconcile(state()).map((r) => r.role), ["implementers", "reviewers", "merge-bot"]);
});

// ---------------------------------------------------------------------------
// The router row: pr-cost.mjs --guard's verdict, read off a guard file the way
// the tick reads it. One case per state, each against a fixture file.

import { routerRows, readCostGuard } from "../plugin/scripts/fleet-tick.mjs";

const BASE = { cell: "slow-high", n: 31, mean_usd: 31, fail_rate: 0.29 };
const guardJson = (over = {}) => JSON.stringify({
  computed_at: "2026-10-03T00:00:00.000Z", window_start: "2026-10-03", baseline: BASE,
  cells: [{ cell: "slow-high", n: 31, mean_usd: 31, fail_rate: 0.29 }, { cell: "task-high", n: 24, mean_usd: 12.3, fail_rate: 0.25 }],
  tripped: [], verdict: "ok", retire: false, min_n: 20, ...over,
});
function routerRowOf(text) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tick-guard-"));
  try {
    const path = join(dir, "cost-guard.json");
    if (text !== null) writeFileSync(path, text);
    const rows = reconcile(state({ router: readCostGuard(path) }));
    assert.equal(actionable(rows), false, "no router state is work for the controller");
    const r = rows.filter((x) => x.role === "router");
    assert.equal(r.length, 1);
    assert.equal(rows.at(-1), r[0], "the router row prints last");
    return { ...r[0], line: formatLines(rows).at(-1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("router: a guard with no cell tripped is OK, naming each cell against the baseline", () => {
  const r = routerRowOf(guardJson());
  assert.equal(r.action, "OK");
  assert.equal(r.acts, false);
  assert.equal(r.line, "router       → OK   (task-high $12.30 vs $31.00, fail 25% vs 29%, n=24/31; guard computed 2026-10-03T00:00:00.000Z)");
});

test("router: the row carries the guard's own computed_at, so a stale OK reads as old", () => {
  const r = routerRowOf(guardJson({ computed_at: "2026-09-01T08:00:00.000Z" }));
  assert.equal(r.action, "OK");
  assert.match(r.detail, /; guard computed 2026-09-01T08:00:00\.000Z$/);
});

test("router: a tripped cell is DEFAULT-ONLY, naming the cost guard and the cell it tripped", () => {
  const r = routerRowOf(guardJson({
    verdict: "tripped", tripped: ["smol-high"],
    cells: [{ ...BASE }, { cell: "smol-high", n: 21, mean_usd: 9.5, fail_rate: 0.45 }, { cell: "task-high", n: 24, mean_usd: 12.3, fail_rate: 0.25 }],
  }));
  assert.equal(r.action, "DEFAULT-ONLY");
  assert.equal(r.detail, "cost guard: smol-high $9.50 vs $31.00, fail 45% vs 29%, n=21/31; guard computed 2026-10-03T00:00:00.000Z");
  const retired = routerRowOf(guardJson({ verdict: "tripped", tripped: ["task-high"], retire: true }));
  assert.match(retired.detail, /^cost guard: task-high .*; every non-default stage-1 cell tripped — the router retires; guard computed /);
});

test("router: a baseline short of its n is NO VERDICT, with the count and the n it needs", () => {
  const r = routerRowOf(guardJson({ verdict: "none", baseline: { ...BASE, n: 7 } }));
  assert.equal(r.action, "NO VERDICT");
  assert.equal(r.line, "router       → NO VERDICT   (baseline n=7/20; guard computed 2026-10-03T00:00:00.000Z)");
});

test("router: no guard file is DEFAULT-ONLY, naming the command that writes one", () => {
  const r = routerRowOf(null);
  assert.equal(r.line, "router       → DEFAULT-ONLY   (cost-guard.json missing — run pr-cost.mjs --guard)");
});

test("router: a guard file that is not a verdict reads DEFAULT-ONLY too — deleting or breaking it cannot evade the guard", () => {
  const cell = { cell: "task-high", n: 24, mean_usd: 1, fail_rate: 0 };
  for (const [text, why] of [["{", "not JSON"], [guardJson({ verdict: "maybe" }), "not a guard verdict"],
    [guardJson({ tripped: "smol-high" }), "not a guard verdict"], [guardJson({ min_n: undefined }), "not a guard verdict"],
    [guardJson({ computed_at: undefined }), "not a guard verdict"],
    [guardJson({ cells: [{ ...cell, n: "24" }] }), "not a guard verdict"],
    [guardJson({ cells: [{ ...cell, mean_usd: "12" }] }), "not a guard verdict"],
    [guardJson({ cells: [{ ...cell, fail_rate: "0.2" }] }), "not a guard verdict"],
    [guardJson({ baseline: { ...BASE, mean_usd: "31" } }), "not a guard verdict"],
    // Self-contradicting files: a verdict that disagrees with tripped[], a tripped cell the file never reports, a non-boolean retire.
    [guardJson({ verdict: "ok", tripped: ["task-high"] }), "not a guard verdict"],
    [guardJson({ verdict: "tripped", tripped: [] }), "not a guard verdict"],
    [guardJson({ verdict: "tripped", tripped: ["ghost"] }), "not a guard verdict"],
    [guardJson({ retire: "yes" }), "not a guard verdict"]]) {
    const r = routerRowOf(text);
    assert.equal(r.action, "DEFAULT-ONLY", text);
    assert.equal(r.detail, `cost-guard.json unreadable (${why}) — run pr-cost.mjs --guard`, text);
  }
});

test("router: with no guard state read at all, no router row", () => {
  assert.deepEqual(routerRows(state()), []);
});

test("formatLines prints role, actual/target and the ACTION on one line each", () => {
  assert.deepEqual(
    formatLines(reconcile(state({
      heads: [412], supply: 57, fixDue: [346], reviewDue: [350], mergeQueue: 2, mergeHeld: 1,
      refresh: { ok: true, entries: 3, lifted: 0, changed: true, trigger: "unclaimed 1 < cap 2" },
    }))),
    [
      "implementers 0/2 → PULL #412   (unclaimed=1 supply=57 unreviewed=0)",
      "reviewers    0/6 → DISPATCH fix-pr PR#346   (reviews=0 fix-pr=0 fix-due=1 review-due=1 max-reviews=6)",
      "reviewers    0/6 → DISPATCH review PR#350   (reviews=0 fix-pr=0 fix-due=1 review-due=1 max-reviews=6)",
      "merge-bot    0/1 → DISPATCH merge-bot   (merge-queue=2 held=1)",
      "shortlist    → REFRESHED shortlist: 3 entries; 0 lifted   (unclaimed 1 < cap 2)",
    ],
  );
});

test("actionable: exactly the rows that name work the controller can do unattended", () => {
  const acts = (over) => actionable(reconcile(state(over)));
  assert.equal(acts({}), false, "an idle tick asks for nothing");
  assert.equal(acts({ heads: [1] }), true, "PULL");
  assert.equal(acts({ fixDue: [1] }), true, "DISPATCH fix-pr");
  assert.equal(acts({ reviewDue: [1] }), true, "DISPATCH review");
  assert.equal(acts({ mergeQueue: 1 }), true, "DISPATCH merge-bot");
  assert.equal(acts({ implLive: 2, heads: [1] }), false, "AT CAP");
  assert.equal(acts({ draining: "x", heads: [1] }), false, "HOLD (draining)");
});

// ---------------------------------------------------------------------------
// The main-checkout hold (#2210): anything but `clean` holds every
// dispatching row.

const BUSY = {
  heads: [412], fixDue: [346], reviewDue: [350], mergeQueue: 1,
  refresh: { ok: true, entries: 3, lifted: 0, changed: true, trigger: "unclaimed 1 < cap 2" },
};
const summary = (s) => reconcile(s).map((r) => [r.role, r.action, r.acts]);

test("main checkout: dirty holds every dispatching row once per role, never actionable; the shortlist row still reports", () => {
  const hold = "HOLD (main checkout dirty)";
  assert.deepEqual(summary(state({ ...BUSY, mainCheckout: { state: "dirty", changed: ["x"] } })), [
    ["implementers", hold, false],
    ["reviewers", hold, false],
    ["merge-bot", hold, false],
    ["shortlist", "REFRESHED shortlist: 3 entries; 0 lifted", true],
  ]);
  const [impl] = reconcile(state({ ...BUSY, implLive: 1, mainCheckout: { state: "dirty", changed: ["x"] } }));
  assert.equal(`${impl.actual}/${impl.target}`, "1/2", "the held row lost its counts");
});

test("main checkout: unknown holds too, never clean; so does a check that gave no answer at all", () => {
  for (const mainCheckout of [{ state: "unknown", cause: "read", why: "boom" }, { state: "unknown", cause: "baseline", why: "x" }, undefined]) {
    assert.deepEqual(summary(state({ ...BUSY, refresh: null, mainCheckout })), [
      ["implementers", "HOLD (main checkout unknown)", false],
      ["reviewers", "HOLD (main checkout unknown)", false],
      ["merge-bot", "HOLD (main checkout unknown)", false],
    ], JSON.stringify(mainCheckout));
  }
});

test("main checkout: no baseline holds every dispatching row and asks the controller to record one", () => {
  const rows = reconcile(state({ ...BUSY, refresh: null, mainCheckout: { state: "absent", baseline: "/x" } }));
  assert.deepEqual(rows.map((r) => r.action), Array(3).fill("HOLD (main checkout no baseline)"));
  assert.equal(actionable(rows), true);
});

test("main checkout: the hold outranks every role's own guards — drain and tier holds included", () => {
  const s = state({ ...BUSY, refresh: null, draining: "x", tierMismatch: ["impl-1"], mainCheckout: { state: "dirty", changed: ["x"] } });
  assert.equal(row(s, "implementers").action, "HOLD (main checkout dirty)");
  assert.equal(actionable(reconcile(s)), false, "a tier mismatch under a dirty checkout still asks the controller to dispatch");
});

test("main checkout: clean holds nothing", () => {
  assert.deepEqual(summary(state({ ...BUSY, refresh: null })).map(([, action]) => action),
    ["PULL #412", "DISPATCH fix-pr PR#346", "DISPATCH review PR#350", "DISPATCH merge-bot"]);
});

// A CONFLICT line only writes a record; the fix-applier it leads to obeys
// every hold through the reviewers row.
test("main checkout: a conflict line still prints under the hold and under a drain — it records, never dispatches", () => {
  for (const mainCheckout of [{ state: "dirty", changed: ["x"] }, { state: "unknown", cause: "read", why: "boom" }, { state: "absent", baseline: "/x" }]) {
    const hold = row(state({ mainCheckout }), "implementers").action;
    const acts = mainCheckout.state === "absent";
    assert.deepEqual(summary(state({ ...BUSY, refresh: null, conflicts: [40], conflictEscalate: [41], mainCheckout })), [
      ["implementers", hold, acts],
      ["reviewers", hold, acts],
      ["reviewers", "CONFLICT PR#40", true],
      ["reviewers", "ESCALATE conflict PR#41", false],
      ["merge-bot", hold, acts],
    ], mainCheckout.state);
  }
  const drained = rowsOf(state({ ...BUSY, refresh: null, draining: "x", conflicts: [40] }), "reviewers");
  assert.deepEqual(drained.map((r) => r.action), ["DISPATCH fix-pr PR#346", "DISPATCH review PR#350", "CONFLICT PR#40"]);
});

// ---------------------------------------------------------------------------
// Reading the run: deriveRun() over `ledger.mjs read`'s payload and the open
// PR list. Rows are spelled the way ledger.mjs dispatch/settle write them.

const HEAD_A = "abc1234" + "0".repeat(33);
const HEAD_B = "def5678" + "0".repeat(33);
const pr = (number, labels = [], closes = [number + 1000], headRefOid = HEAD_B, mergeable = "MERGEABLE") => ({
  number, labels: labels.map((name) => ({ name })),
  closingIssuesReferences: closes.map((n) => ({ number: n })),
  headRefOid, mergeable,
});
const run = (ledger, prs = [], closed, finished) => deriveRun({ rows: [], dispatched: [], drain: null, ...ledger }, prs, closed, finished);

test("deriveRun: live implementers are the unsettled impl- tokens — the #1692 shape, read rather than recited", () => {
  // #1692 was two sources disagreeing about the same fleet. There is one
  // source now: two live tokens are two live implementers, whatever else the
  // file says.
  const r = run({
    rows: ["#412 impl-412 · class=routine", "#415 impl-415", "#300 impl-300=PR#344 → PR#344", "#301 impl-301=bailed"],
    dispatched: ["impl-412", "impl-415", "impl-300=PR#344", "impl-301=bailed"],
  });
  assert.equal(r.implLive, 2);
  assert.deepEqual([...r.claimed].sort((a, b) => a - b), [300, 301, 412, 415]);
});

test("deriveRun: a member settled anywhere is settled, and a -b replacement is its own member", () => {
  const r = run({
    rows: ["#412 impl-412=killed · impl-412-b"],
    dispatched: ["impl-412=killed", "impl-412-b"],
  });
  assert.equal(r.implLive, 1);
  // A hand-edited row still carrying the bare token of a member `## Dispatched`
  // records as settled: settled wins, because `settle` is the one writer of an
  // outcome and a stale bare copy is what a whole-line `row` rewrite leaves.
  assert.equal(run({ rows: ["#9 impl-9"], dispatched: ["impl-9=PR#12"] }).implLive, 0);
});

test("deriveRun: live reviewer units are in-flight reviews plus unsettled fix-appliers", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#20 → PR#20 · review=wf:run1",
      "#11 impl-11=PR#21 → PR#21 · review=wf:run2 reviewed=abc1234:2/1/0 · fix-pr-21",
      "#12 impl-12=PR#22 → PR#22 · review=member:review-pr-22 reviewed=abc1234:0/0/0",
      "#13 impl-13=PR#23 → PR#23 · review=wf:run3=failed",
      "#14 impl-14=PR#24 → PR#24 · review=wf:run4=failed review=fallback:review-pr-24",
    ],
    dispatched: ["fix-pr-21"],
  }, [pr(20), pr(21), pr(22), pr(23), pr(24)]);
  assert.equal(r.reviewsLive, 2, "run1 and the fallback are in flight; run2 returned, run3 is dead");
  assert.equal(r.fixLive, 1);
});

test("deriveRun: live names every unsettled member and each in-flight review by its PR — a review=wf: run has no member token of its own", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#20 → PR#20 · review=wf:run1",
      "#11 impl-11=PR#21 → PR#21 · review=wf:run2 reviewed=abc1234:2/1/0 · fix-pr-21",
      "#13 impl-13=PR#23 → PR#23 · review=wf:run3=failed",
      "#15 impl-15",
    ],
    dispatched: ["fix-pr-21"],
  }, [pr(20), pr(21), pr(23)]);
  assert.deepEqual(r.live, ["fix-pr-21", "impl-15", "review:PR#20"], "run2 returned and run3 is dead, so neither is live");
});

// A review whose own `reviewed=` write never landed stays in flight in the
// ledger forever. The ledger cannot say the PR has since merged; the caller's
// probe can, and hands the merged or closed PR numbers to the fold.
const ZOMBIE_ROWS = [20, 21, 22].map((n) => `#${n - 10} impl-${n - 10}=PR#${n} → PR#${n} · review=member:review-pr-${n}`);

test("deriveRun: an in-flight review whose PR has left the open list is named for a probe, and still counts until the probe answers", () => {
  const r = run({ rows: ZOMBIE_ROWS }, [pr(21)]);
  assert.deepEqual(r.reviewsOffList, [20, 22], "only the in-flight reviews of PRs not on the open list");
  assert.equal(r.reviewsLive, 3, "no probe answer: fail closed, every one still reads as live");
  assert.deepEqual(r.live, ["review:PR#20", "review:PR#21", "review:PR#22"]);
});

test("deriveRun: reviewsOffList is ascending whatever order the ledger rows arrive in", () => {
  const r = run({ rows: [...ZOMBIE_ROWS].reverse() }, [pr(21)]);
  assert.deepEqual(r.reviewsOffList, [20, 22], "rows arrive 22, 21, 20: the sort, not ledger order, makes it ascending");
});

test("deriveRun: a review in flight on a PR the caller found merged or closed is not live", () => {
  const r = run({ rows: ZOMBIE_ROWS }, [pr(21)], undefined, new Set([20, 22]));
  assert.equal(r.reviewsLive, 1, "only PR 21's review, on the open list, is live");
  assert.deepEqual(r.live, ["review:PR#21"]);
});

test("deriveRun: a review in flight on an OPEN PR is live whatever the finished set says", () => {
  // A probe answer that contradicts the open list is not trusted to retire a
  // review: the open list is the fold's own read of which PRs are open.
  const r = run({ rows: ZOMBIE_ROWS }, [pr(20), pr(21), pr(22)], undefined, new Set([20, 21, 22]));
  assert.equal(r.reviewsLive, 3);
  assert.deepEqual(r.reviewsOffList, []);
});

test("deriveRun: a finished PR's returned review and settled members read as before", () => {
  const rows = [...ZOMBIE_ROWS, "#40 impl-40=PR#50 → PR#50 · review=member:review-pr-50 reviewed=abc1234:0/0/0"];
  const r = run({ rows }, [], undefined, new Set([20, 21, 22, 50]));
  assert.deepEqual([r.reviewsLive, r.reviewsOffList, r.live], [0, [20, 21, 22], []]);
  assert.deepEqual(r.reviewed.map((x) => x.pr), [50], "the returned review is still on record");
});

test("deriveRun: fix-pr is due on a returned review with survived or unverified findings and no fix-applier since", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#20 → PR#20 · review=wf:a reviewed=abc1234:2/0/0",
      "#11 impl-11=PR#21 → PR#21 · review=wf:b reviewed=abc1234:0/3/1",
      "#12 impl-12=PR#22 → PR#22 · review=wf:c reviewed=abc1234:1/0/0 · fix-pr-22=applied:def5678",
      // Re-reviewed after its fix, and the second review found more.
      "#13 impl-13=PR#23 → PR#23 · review=wf:d reviewed=abc1234:1/0/0 · fix-pr-23=applied:def5678 review=wf:e reviewed=def5678:1/0/0",
      // A closed PR is nobody's work.
      "#14 impl-14=PR#24 → PR#24 · review=wf:f reviewed=abc1234:4/0/0",
      // Everything refuted: nothing for a fix-applier to rule on.
      "#15 impl-15=PR#25 → PR#25 · review=wf:g reviewed=abc1234:0/3/0",
    ],
    dispatched: ["fix-pr-22=applied:def5678", "fix-pr-23=applied:def5678"],
  }, [pr(20), pr(21), pr(22), pr(23), pr(25)]);
  assert.deepEqual(r.fixDue, [20, 21, 23]);
});

// #2877: `ledger.mjs dispatch` gates a finisher on an unverified finding as
// well as a survived one, and only a review fix-applier's verdict answers it —
// so a review counting only unverified findings must be fix-due, or its PR
// strands with neither a fix-applier nor a finisher ever named.
test("deriveRun: a review counting only unverified findings is fix-due until a review fix-applier lands", () => {
  const at = (tail) => run({ rows: [`#20 impl-20=PR#21 → PR#21 · review=wf:a reviewed=abc1234:0/2/6${tail}`] }, [pr(21)]);
  const due = at("");
  assert.deepEqual(due.fixDue, [21]);
  assert.equal(row(state({ fixDue: due.fixDue }), "reviewers").action, "DISPATCH fix-pr PR#21");
  assert.deepEqual(at(" · fix-pr-21").fixDue, [], "a live fix-applier is not re-offered");
  assert.deepEqual(at(" · fix-pr-21=no-op · dispositions-ok=fix-pr-21:abc1234").fixDue, [], "a landed no-op answers it");
  assert.deepEqual(at(" · fix-pr-21=failed").fixDue, [21], "a dead one leaves it due for a replacement");
});

test("deriveRun: review is due on open PRs that close an issue and carry no review token, oldest first", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#30 → PR#30 · review=wf:a",
      "#11 impl-11=PR#31 → PR#31",
      "#12 impl-12=PR#32 → PR#32 · review=wf:b=failed",
    ],
  }, [
    pr(33), pr(31), pr(30), pr(32),
    pr(34, ["ready-to-merge"]), // signed off — not review work
    pr(35, [], []), // closes no issue — not review work (#590)
  ]);
  assert.deepEqual(r.reviewDue, [31, 32, 33]);
});

test("deriveRun: a PR row keyed by the PR's own number is read as that PR's", () => {
  // A PR this run's implementers did not open: `dispatch 350 fix-pr-350` keys
  // its row `#350`, the same fallback ledger.mjs's memberRowIndex() takes.
  const r = run({ rows: ["#350 review=wf:x reviewed=abc1234:1/0/0"] }, [pr(350)]);
  assert.deepEqual(r.fixDue, [350]);
  assert.deepEqual(r.reviewDue, []);
});

// #2083: a finisher that halts `past-pin` found commits past the head the
// review read. Once a review has RETURNED, `reviewedAny` holds it out of
// review-due for good, so marking the review failed cannot re-queue it —
// the halt itself does, until a new review is running or has returned.
test("deriveRun: a finisher halted past-pin re-queues the review while the head is past the reviewed one", () => {
  const row = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0 · finisher-pr-40=halted:past-pin";
  assert.deepEqual(run({ rows: [row] }, [pr(40, [], [10], HEAD_B)]).reviewDue, [40]);
  // Settled only in `## Dispatched`, a bare copy on the row: settled anywhere is settled.
  assert.deepEqual(run({
    rows: ["#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0 · finisher-pr-40"],
    dispatched: ["finisher-pr-40=halted:past-pin"],
  }, [pr(40, [], [10], HEAD_B)]).reviewDue, [40]);
  // A re-review that died before returning leaves it owed.
  assert.deepEqual(run({ rows: [`${row} review=wf:b=failed`] }, [pr(40, [], [10], HEAD_B)]).reviewDue, [40]);
});

test("deriveRun: a head past reviewed= with no past-pin halt stays not due — a fix-applier's push is finisher duty 2's", () => {
  const base = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:1/0/0 · fix-pr-40=applied:def5678";
  for (const row of [
    base,
    `${base} · finisher-pr-40=labelled`,
    `${base} · finisher-pr-40`,
    `${base} · finisher-pr-40=failed`,
    // Every other halt cause escalates to a human; none re-queues a review.
    `${base} · finisher-pr-40=halted:live-editor`,
    `${base} · finisher-pr-40=halted:rebase`,
    `${base} · finisher-pr-40=halted:other`,
    // A later finisher attempt replaces the halted one, live or settled —
    // by retry suffix (compute-board.mjs's laterAttempt ordering), never by
    // row-text position: a row rewrite can leave `-b` sitting BEFORE the
    // older halted token (#2083).
    `${base} · finisher-pr-40=halted:past-pin · finisher-pr-40-b`,
    `${base} · finisher-pr-40=halted:past-pin · finisher-pr-40-b=halted:live-editor`,
    `${base} · finisher-pr-40-b · finisher-pr-40=halted:past-pin`,
    `${base} · finisher-pr-40-b=halted:live-editor · finisher-pr-40=halted:past-pin`,
    // Another PR's finisher on the row is not this PR's halt.
    `${base} · finisher-pr-41=halted:past-pin`,
  ]) {
    assert.deepEqual(run({ rows: [row] }, [pr(40, [], [10], HEAD_B)]).reviewDue, [], row);
  }
});

test("deriveRun: a past-pin halt is answered once the head is the reviewed one, or a review is running or returned after it", () => {
  const halted = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0 · finisher-pr-40=halted:past-pin";
  const not = (row, head) => assert.deepEqual(run({ rows: [row] }, [pr(40, [], [10], head)]).reviewDue, [], `${row} @ ${head}`);
  not(halted, HEAD_A); // the reviewed head IS the PR head — nothing unread
  not(halted, HEAD_A.toUpperCase());
  not(`${halted} review=wf:b`, HEAD_B); // the re-review is in flight
  not(`${halted} review=wf:b reviewed=def5678:0/0/0`, HEAD_B); // and returned
  // A fix-applier's push after that re-review is duty 2's again, not a second re-review.
  not(`${halted} review=wf:b reviewed=def5678:1/0/0 · fix-pr-40=applied:0123456`, "0123456" + "0".repeat(33));
  // Signed off, or closing no issue, is no review work whatever the halt says.
  assert.deepEqual(run({ rows: [halted] }, [pr(40, ["ready-to-merge"], [10], HEAD_B), pr(41, [], [], HEAD_B)]).reviewDue, []);
});

test("deriveRun: a ticket row settled =PR#M shares PR M's state with M's own row, in either order (#2283)", () => {
  // ledger.mjs's `settle impl-658-c=PR#724` names PR 724 on the ticket row, and
  // a `#724` row can carry that PR's tokens beside it. Both rows are PR 724's:
  // whichever sorts first must not swallow what the other records.
  const prs = [pr(724, [], [658])];
  const ticket = "#658 impl-658-c=PR#724";
  for (const rows of [[ticket, "#724 review=member:review-pr-724"], ["#724 review=member:review-pr-724", ticket]]) {
    const r = run({ rows }, prs);
    assert.equal(r.reviewsLive, 1, `the live review is counted: ${rows}`);
    assert.deepEqual(r.reviewDue, [], `a reviewed PR is not re-offered: ${rows}`);
  }
  for (const rows of [[ticket, "#724 review=member:review-pr-724 reviewed=abc1234:2/1/0"], ["#724 review=member:review-pr-724 reviewed=abc1234:2/1/0", ticket]]) {
    const r = run({ rows }, prs);
    assert.deepEqual([r.reviewsLive, r.fixDue, r.reviewDue], [0, [724], []], `${rows}`);
    assert.ok(r.claimed.has(658), "the ticket row still reads as claimed");
  }
});

// #2888: a prose `PR#` mention on a row carrying an `impl-` token is not the
// row's PR — the settled `impl-<N>=PR#<M>` token is, wherever either sits.
test("deriveRun: a ticket row's review state is its settled impl PR's, whatever PR# its prose mentions", () => {
  const prs = [pr(470, [], [480]), pr(481, [], [490])];
  const other = "#481 review=wf:b reviewed=abc1234:0/0/0";
  for (const ticket of [
    "#480 correction: PR#481 was wrong · impl-480=PR#470 · review=wf:a reviewed=abc1234:1/0/0",
    "#480 impl-480=PR#470 · review=wf:a reviewed=abc1234:1/0/0 · note: the PR#481 guards",
  ]) {
    for (const rows of [[ticket, other], [other, ticket]]) {
      const r = run({ rows }, prs);
      assert.deepEqual(r.reviewed.map((x) => [x.pr, x.survived]).sort((a, b) => a[0] - b[0]), [[470, 1], [481, 0]], `${rows}`);
      assert.deepEqual(r.fixDue, [470], `${rows}`);
      assert.deepEqual(r.reviewDue, [], `${rows}`);
    }
  }
});

test("deriveRun: a live implementer's row is keyed by its ticket, never by a PR# its prose mentions", () => {
  const r = run({ rows: ["#480 impl-480 · PR#481 closed unmerged · review=wf:a reviewed=abc1234:1/0/0"] }, [pr(481, [], [490])]);
  assert.deepEqual(r.reviewed.map((x) => x.pr), [480]);
  assert.deepEqual(r.fixDue, []);
  assert.deepEqual(r.reviewDue, [481], "PR 481 carries no review of its own");
});

// #2331: a finisher can settle `labelled` without ever adding the label. The
// open-PR list the tick already reads says so; a `label-off=<attempt>` token
// marks the controller's own deliberate removals, so they never read as a miss.
const LABELLED = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0 · finisher-pr-40=labelled";

test("deriveRun: a labelled finisher on a PR without ready-to-merge is unlabelled, and the tick dispatches a finisher", () => {
  const r = run({ rows: [LABELLED], dispatched: ["finisher-pr-40=labelled"] }, [pr(40, ["minor"], [10])]);
  assert.deepEqual(r.unlabelled, [{ pr: 40, labelled: ["finisher-pr-40"] }]);
  const rows = reconcile({ ...state(), ...r }).filter((x) => x.role === "reviewers");
  assert.deepEqual(rows.map((x) => x.action), ["DISPATCH finisher PR#40"]);
  // Settled in `## Dispatched` alone, a bare row copy beside it: settled anywhere is settled.
  assert.deepEqual(run({ rows: ["#10 impl-10=PR#40 → PR#40 · finisher-pr-40"], dispatched: ["finisher-pr-40=labelled"] },
    [pr(40, ["minor"], [10])]).unlabelled, [{ pr: 40, labelled: ["finisher-pr-40"] }]);
});

test("deriveRun: a labelled finisher whose PR carries ready-to-merge is nothing — labelled settles exactly as before", () => {
  const r = run({ rows: [LABELLED], dispatched: ["finisher-pr-40=labelled"] }, [pr(40, ["minor", "ready-to-merge"], [10])]);
  assert.deepEqual(r.unlabelled, []);
  assert.deepEqual(reconcile({ ...state(), ...r }).filter((x) => x.role === "reviewers").map((x) => x.action), ["IDLE OK"]);
});

test("deriveRun: only a settled-labelled LATEST attempt is a miss — live, halted, failed and closed PRs are not", () => {
  const base = "#10 impl-10=PR#40 → PR#40";
  const open = [pr(40, ["minor"], [10])];
  for (const row of [
    `${base} · finisher-pr-40`, // live, not yet reported
    `${base} · finisher-pr-40=labelled · finisher-pr-40-b`, // the repair is live
    `${base} · finisher-pr-40-b · finisher-pr-40=labelled`, // the same, by suffix not position
    `${base} · finisher-pr-40=halted:rebase`, // a halt refused to label, and says so
    `${base} · finisher-pr-40=labelled · finisher-pr-40-b=halted:past-pin`,
    `${base} · finisher-pr-40=failed`, // died, no label: the cockpit's to flag, no repair here
    `${base} · finisher-pr-40=killed`,
    `${base} · finisher-pr-40=labelled · finisher-pr-40-b=failed`,
    `${base} · fix-pr-40=applied:def5678`, // no finisher at all
  ]) {
    assert.deepEqual(run({ rows: [row] }, open).unlabelled, [], row);
  }
  assert.deepEqual(run({ rows: [LABELLED] }, []).unlabelled, [], "a PR off the open list is nobody's work");
});

test("deriveRun: a failed or killed latest finisher prints no DISPATCH or ESCALATE finisher line", () => {
  const open = [pr(40, ["minor"], [10])];
  for (const outcome of ["failed", "killed"]) {
    const r = run({ rows: [`${LABELLED} · finisher-pr-40-b=${outcome}`] }, open);
    assert.deepEqual(r.unlabelled, [], outcome);
    assert.deepEqual(reconcile({ ...state(), ...r }).filter((x) => x.role === "reviewers").map((x) => x.action), ["IDLE OK"], outcome);
  }
});

test("deriveRun: a label-off'd attempt is the controller's own removal — nothing until a later attempt labels again", () => {
  const open = [pr(40, ["minor"], [10])];
  for (const row of [
    `${LABELLED} label-off=finisher-pr-40`,
    "#10 label-off=finisher-pr-40 impl-10=PR#40 → PR#40 · finisher-pr-40=labelled", // before the attempt it names
    `${LABELLED} · finisher-pr-40-b=labelled label-off=finisher-pr-40-b`,
    `${LABELLED} · label-off=finisher-pr-40-b · finisher-pr-40-b=labelled`, // suffix order, never position
  ]) {
    assert.deepEqual(run({ rows: [row] }, open).unlabelled, [], row);
  }
  // A label-off resets the stretch: the attempt after it is the stretch's first.
  assert.deepEqual(run({ rows: [`${LABELLED} label-off=finisher-pr-40 · finisher-pr-40-b=labelled`] }, open).unlabelled,
    [{ pr: 40, labelled: ["finisher-pr-40-b"] }]);
  // A label-off for another PR's attempt leaves this one's miss standing, wherever it sits.
  assert.deepEqual(run({ rows: [`${LABELLED} label-off=finisher-pr-41`] }, open).unlabelled,
    [{ pr: 40, labelled: ["finisher-pr-40"] }]);
  // Two label-offs for one PR: the HIGHEST attempt named starts the stretch,
  // whichever token comes first on the row.
  const three = `${LABELLED} · finisher-pr-40-b=labelled · finisher-pr-40-c=labelled`;
  for (const offs of ["label-off=finisher-pr-40-b label-off=finisher-pr-40", "label-off=finisher-pr-40 label-off=finisher-pr-40-b"]) {
    assert.deepEqual(run({ rows: [`${three} ${offs}`] }, open).unlabelled, [{ pr: 40, labelled: ["finisher-pr-40-c"] }], offs);
  }
});

test("deriveRun: two labelled attempts in one stretch escalate rather than dispatch a third", () => {
  const open = [pr(40, ["minor"], [10])];
  const r = run({ rows: [`${LABELLED} · finisher-pr-40-b=labelled`] }, open);
  assert.deepEqual(r.unlabelled, [{ pr: 40, labelled: ["finisher-pr-40", "finisher-pr-40-b"] }]);
  assert.deepEqual(reconcile({ ...state(), ...r }).filter((x) => x.role === "reviewers").map((x) => x.action),
    ["ESCALATE unlabelled PR#40"]);
  // A halt between the two still leaves both labelled ones in the stretch.
  assert.deepEqual(run({ rows: [`${LABELLED} · finisher-pr-40-b=halted:live-editor · finisher-pr-40-c=labelled`] }, open).unlabelled,
    [{ pr: 40, labelled: ["finisher-pr-40", "finisher-pr-40-c"] }]);
});

test("deriveRun: a finisher token on another PR's row is a stray — it neither makes nor masks a miss", () => {
  const prs = [pr(40, ["minor"], [10]), pr(41, ["minor"], [11])];
  const r = run({ rows: ["#10 impl-10=PR#40 → PR#40", "#11 impl-11=PR#41 → PR#41 · finisher-pr-40=labelled"] }, prs);
  assert.deepEqual(r.unlabelled, []);
  const masked = run({ rows: [LABELLED, "#11 impl-11=PR#41 → PR#41 · finisher-pr-40-b"] }, prs);
  assert.deepEqual(masked.unlabelled, [{ pr: 40, labelled: ["finisher-pr-40"] }]);
});

test("deriveRun: a label-off naming no finisher-pr member refuses the ledger, naming the token", () => {
  for (const tok of ["label-off=impl-10", "label-off=", "label-off=finisher-pr-40=labelled", "label-off=merge-bot-1"]) {
    assert.throws(() => run({ rows: [`${LABELLED} ${tok}`] }, [pr(40, [], [10])]), (e) => e.message.includes(`'${tok}'`), tok);
  }
});
test("deriveRun: merge holds are held-behind rows whose premise PR is still open", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#40 → PR#40 · held-behind:#38",
      "#11 impl-11=PR#41 → PR#41 · held-behind:#39",
    ],
  }, [pr(38), pr(40, ["ready-to-merge"]), pr(41, ["ready-to-merge"])]);
  assert.equal(r.mergeQueue, 2);
  assert.equal(r.mergeHeld, 1, "#39 is no longer open, so #41's hold has lifted");
});

// #2064: merge-bot's `conflict-hold:#<pr>` — a conflict its local-rebase
// fallback would not force — feeds the same fix-due list a review's
// survivors do, and holds the merge until a fix-applier AFTER it settles.
const HOLD_ROW = (n, tail) => `#${n - 30} impl-${n - 30}=PR#${n} → PR#${n} · reviewed=abc1234:0/2/0 · ${tail}`;

test("deriveRun: a conflict hold is fix-due until a fix-applier after it lands, whatever settled before it", () => {
  const r = run({
    rows: [
      HOLD_ROW(40, "conflict-hold:#40"),
      HOLD_ROW(41, "conflict-hold:#41 · fix-pr-41=applied:def5678"),
      HOLD_ROW(42, "conflict-hold:#42 · fix-pr-42=no-op"),
      // A settle BEFORE the hold is stale: it cannot clear a newer conflict.
      HOLD_ROW(43, "fix-pr-43=applied:def5678 · conflict-hold:#43"),
      // Cleared once, then held again — the second hold is unresolved.
      HOLD_ROW(44, "conflict-hold:#44 · fix-pr-44=applied:def5678 · conflict-hold:#44"),
      // A fix-applier that died leaves the conflict where it was.
      HOLD_ROW(45, "conflict-hold:#45 · fix-pr-45=failed"),
      // A review after the cleared hold leaves the hold cleared.
      HOLD_ROW(46, "conflict-hold:#46 · fix-pr-46=applied:def5678 · review=wf:x reviewed=def5678:0/1/0"),
      // A closed PR is nobody's work.
      HOLD_ROW(47, "conflict-hold:#47"),
    ],
  }, [40, 41, 42, 43, 44, 45, 46].map((n) => pr(n)));
  assert.deepEqual(r.fixDue, [40, 43, 44, 45]);
});

test("deriveRun: a queued PR under a conflict hold is merge-held until its fix-applier SETTLES — dispatch alone does not lift it", () => {
  const at = (tail) => run({ rows: [HOLD_ROW(40, tail)] }, [pr(40, ["ready-to-merge"])]);
  const held = at("conflict-hold:#40");
  assert.deepEqual([held.fixDue, held.mergeQueue, held.mergeHeld, held.mergeConflictHeld], [[40], 1, 1, 1]);
  const working = at("conflict-hold:#40 · fix-pr-40");
  assert.deepEqual(working.fixDue, [], "a live fix-applier is not re-offered");
  assert.equal(working.mergeHeld, 1, "…and the merge bot does not re-select a PR still being fixed");
  const landed = at("conflict-hold:#40 · fix-pr-40=applied:def5678");
  assert.deepEqual([landed.fixDue, landed.mergeHeld, landed.mergeConflictHeld], [[], 0, 0]);
  // Both sources on one PR count it once.
  const both = run({ rows: [HOLD_ROW(40, "held-behind:#38 · conflict-hold:#40")] }, [pr(38), pr(40, ["ready-to-merge"])]);
  assert.equal(both.mergeHeld, 1);
});

test("deriveRun: a conflict hold with a live review= in flight is not re-offered either — the merge hold still counts it", () => {
  const r = run({ rows: ["#10 impl-10=PR#350 → PR#350 · conflict-hold:#350 review=wf:x"] }, [pr(350, ["ready-to-merge"])]);
  assert.deepEqual(r.fixDue, [], "a review already running claims the row the same as a live fix-applier does");
  assert.deepEqual([r.mergeQueue, r.mergeHeld, r.mergeConflictHeld], [1, 1, 1]);
});

test("deriveRun: a fix-applier settled in ## Dispatched clears a conflict hold even if a later row rewrite drops the =outcome suffix back to bare", () => {
  const r = run({
    rows: [HOLD_ROW(40, "conflict-hold:#40 · fix-pr-40")],
    dispatched: ["fix-pr-40=applied:def5678"],
  }, [pr(40, ["ready-to-merge"])]);
  assert.deepEqual([r.fixDue, r.mergeHeld, r.mergeConflictHeld], [[], 0, 0],
    "the member settled in ## Dispatched, not the row's own stale bare copy");
});

test("deriveRun: a redundant re-hold on an already-unresolved conflict does not re-offer the PR to a second fix-applier while the first is live", () => {
  const r = run({ rows: [HOLD_ROW(40, "conflict-hold:#40 · fix-pr-40 · conflict-hold:#40")] }, [pr(40, ["ready-to-merge"])]);
  assert.deepEqual(r.fixDue, [], "a live fix-applier working the first hold is not re-offered by a duplicate hold token");
  assert.deepEqual([r.mergeHeld, r.mergeConflictHeld], [1, 1], "still held — the duplicate hold changes nothing about the merge gate");
});

// #2328: a fix-applier dispatched on an unresolved hold is the conflict one —
// it rebases and never reads the review file — so its landing clears the hold
// and leaves a returned review's survivors exactly as unanswered as they were.
test("deriveRun: a landed conflict fix-applier clears the hold but not the survivors — a review fix-applier follows", () => {
  const R = (tail) => `#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · ${tail}`;
  const at = (tail, dispatched = []) => run({ rows: [R(tail)], dispatched }, [pr(21, ["ready-to-merge"])]);
  const held = at("conflict-hold:#21");
  assert.deepEqual([held.fixDue, held.conflictHeld], [[21], [21]]);
  const working = at("conflict-hold:#21 · fix-pr-21");
  assert.deepEqual([working.fixDue, working.conflictHeld], [[], [21]], "the live conflict fix-applier is not joined by a review one");
  const landed = at("conflict-hold:#21 · fix-pr-21=applied:def5678");
  assert.deepEqual([landed.fixDue, landed.conflictHeld, landed.mergeHeld], [[21], [], 0], "the survivors are re-offered, the hold is gone");
  // The hold read before the review is the same conflict fix-applier.
  assert.deepEqual(run({ rows: ["#20 impl-20=PR#21 → PR#21 · conflict-hold:#21 · reviewed=abc1234:2/0/0 · fix-pr-21=no-op"] }, [pr(21)]).fixDue, [21]);
  // The review fix-applier that follows answers them.
  assert.deepEqual(at("conflict-hold:#21 · fix-pr-21=applied:def5678 · fix-pr-21-b=applied:0123abc").fixDue, []);
  assert.deepEqual(at("conflict-hold:#21 · fix-pr-21=applied:def5678 · fix-pr-21-b").fixDue, [], "…and is not re-offered while live");
  assert.deepEqual(at("conflict-hold:#21 · fix-pr-21=applied:def5678 · fix-pr-21-b=failed").fixDue, [21], "a dead one leaves them due");
});

test("deriveRun: survivors a review fix-applier already answered stay answered through a later hold and its fix", () => {
  const R = (tail) => `#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · fix-pr-21=applied:def5678 · ${tail}`;
  const held = run({ rows: [R("conflict-hold:#21")] }, [pr(21)]);
  assert.deepEqual([held.fixDue, held.conflictHeld], [[21], [21]], "the hold is due on its own");
  const cleared = run({ rows: [R("conflict-hold:#21 · fix-pr-21-b=applied:0123abc")] }, [pr(21)]);
  assert.deepEqual([cleared.fixDue, cleared.conflictHeld], [[], []], "nothing left: the survivors were answered before the hold");
  // A live review fix-applier when the hold lands is not joined by a conflict one.
  const live = run({ rows: ["#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · fix-pr-21 · conflict-hold:#21"] }, [pr(21)]);
  assert.deepEqual([live.fixDue, live.conflictHeld], [[], [21]]);
});

// A dispositions mismatch is answered by one automatic retry: the PR returns
// to fix-due on the row that already dispatches fix-appliers, once, until the
// retry has been checked. A second failure is escalate, and escalate is a hold
// no fix-applier answers.
const D = (fix, ...tokens) => `#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · ${[...fix, ...tokens].join(" · ")}`;
const MISMATCH = "dispositions-mismatch=fix-pr-21:abc1234";
const dueAt = (tail, prs = [pr(21)]) => run({ rows: [D(["fix-pr-21=applied:def5678"], ...tail)] }, prs).fixDue;

test("deriveRun: a first dispositions mismatch puts the PR back in fixDue, and the reviewers row prints it", () => {
  const r = run({ rows: [D(["fix-pr-21=applied:def5678"], MISMATCH)] }, [pr(21)]);
  assert.deepEqual(r.fixDue, [21]);
  assert.equal(row(state({ fixDue: r.fixDue }), "reviewers").action, "DISPATCH fix-pr PR#21");
  // The survivors alone were answered: with an ok verdict the PR is not due.
  assert.deepEqual(dueAt(["dispositions-ok=fix-pr-21:abc1234"]), []);
  // No other role's row moves on the mismatch.
  const others = (fixDue) => reconcile(state({ fixDue })).filter((x) => x.role !== "reviewers");
  assert.deepEqual(others(r.fixDue), others([]));
});

test("deriveRun: a mismatch is due whether the review counted survivors or only unverified findings", () => {
  const unverifiedOnly = run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:0/0/2 · fix-pr-21=applied:def5678 · ${MISMATCH}`] }, [pr(21)]);
  assert.deepEqual(unverifiedOnly.fixDue, [21]);
});

test("deriveRun: the retry is not re-offered while live, nor before its own check has run, nor after any verdict of its own", () => {
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b"]), [], "live");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc"]), [], "settled, its check not yet run: the earlier mismatch is not the retry's answer");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc", "dispositions-ok=fix-pr-21-b:abc1234"]), [], "ok ends it");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc", "dispositions-escalate=fix-pr-21-b:abc1234"]), [], "escalate is never due");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=failed"]), [21], "a retry that died leaves the mismatch for a replacement");
});

test("deriveRun: a landed conflict fix-applier does not answer a mismatch — the retry is still due", () => {
  assert.deepEqual(dueAt([MISMATCH, "conflict-hold:#21", "fix-pr-21-b"]), [], "the conflict one is live: nothing is re-offered");
  assert.deepEqual(dueAt([MISMATCH, "conflict-hold:#21", "fix-pr-21-b=applied:0123abc"]), [21], "hold cleared by -b, the mismatch still stands");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc"]), [], "control: a review -b that landed is awaiting its own check");
});

test("deriveRun: a dispositions verdict on a row that never recorded a review head answers nothing", () => {
  const r = run({ rows: [`#20 impl-20=PR#21 → PR#21 · review=wf:x · fix-pr-21=applied:def5678 · ${MISMATCH}`] }, [pr(21)]);
  assert.deepEqual(r.fixDue, []);
});

test("deriveRun: the verdict is read by review head and highest retry, never by position in the row", () => {
  const escalated = ["dispositions-escalate=fix-pr-21-b:abc1234", MISMATCH];
  assert.deepEqual(dueAt(["fix-pr-21-b=applied:0123abc", ...escalated]), [], "the -b escalate answers, wherever it sits");
  // A mismatch on an older review does not answer a newer one.
  const newer = run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · fix-pr-21=applied:def5678 · ${MISMATCH} · review=wf:x reviewed=fedcba9:0/1/0`] }, [pr(21)]);
  assert.deepEqual(newer.fixDue, [], "the new review has no verdict and no survivors");
  const rev = run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · fix-pr-21=applied:def5678 · ${MISMATCH} · review=wf:x`] }, [pr(21)]);
  assert.deepEqual(rev.fixDue, [], "a review running on the PR holds it off");
  assert.deepEqual(dueAt([MISMATCH], []), [], "a PR no longer open is nobody's work");
});

test("currentDispositions: escalate parses, and outranks mismatch which outranks ok at one retry suffix", () => {
  assert.deepEqual(dispositionsToken("dispositions-escalate=fix-pr-21-b:abc1234")?.verdict, "escalate");
  assert.equal(dispositionsToken("dispositions-escalate=finisher-pr-21:abc1234"), null);
  const heads = (...s) => currentDispositions(s.map(dispositionsToken), "abc1234");
  assert.deepEqual(heads("dispositions-ok=fix-pr-21:abc1234", "dispositions-escalate=fix-pr-21:abc1234"), { verdict: "escalate", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-escalate=fix-pr-21:abc1234", "dispositions-mismatch=fix-pr-21:abc1234"), { verdict: "escalate", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-escalate=fix-pr-21:abc1234", "dispositions-ok=fix-pr-21-b:abc1234"), { verdict: "ok", member: "fix-pr-21-b" });
});

test("currentDispositions: unchecked parses, outranks ok and is outranked by mismatch at one retry suffix, and is never fix-due", () => {
  assert.deepEqual(dispositionsToken("dispositions-unchecked=fix-pr-21-b:abc1234")?.verdict, "unchecked");
  assert.equal(dispositionsToken("dispositions-unchecked=finisher-pr-21:abc1234"), null);
  const heads = (...s) => currentDispositions(s.map(dispositionsToken), "abc1234");
  assert.deepEqual(heads("dispositions-ok=fix-pr-21:abc1234", "dispositions-unchecked=fix-pr-21:abc1234"), { verdict: "unchecked", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-unchecked=fix-pr-21:abc1234", "dispositions-mismatch=fix-pr-21:abc1234"), { verdict: "mismatch", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-unchecked=fix-pr-21:abc1234", "dispositions-ok=fix-pr-21-b:abc1234"), { verdict: "ok", member: "fix-pr-21-b" });
  // A landed fix-applier whose check could not read the tracker is answered
  // by running the check again, never by another fix-applier.
  const due = (verdict) => run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · fix-pr-21=applied:abc1234 · dispositions-${verdict}=fix-pr-21:abc1234`] }, [pr(21)]).fixDue;
  assert.deepEqual(due("mismatch"), [21], "control: a mismatch on the same row is fix-due");
  assert.deepEqual(due("unchecked"), []);
});

test("deriveRun: a newer review's survivors are not offered beside a live fix-applier, and are due once it settles", () => {
  // `dispatch` would refuse a second live one. Settled, it was dispatched
  // before that review, so it never answered the newer survivors.
  const rereviewed = (fix) => run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0 · ${fix} · review=wf:x reviewed=def5678:1/0/0`] }, [pr(21)]).fixDue;
  assert.deepEqual(rereviewed("fix-pr-21"), []);
  assert.deepEqual(rereviewed("fix-pr-21=applied:def5678"), [21]);
  assert.deepEqual(rereviewed("fix-pr-21=failed"), [21]);
});

// One fix-applier does one job, so its landing folds once per PR however many
// copies of its token the rows carry — a whole-line `row` rewrite leaves bare
// copies wherever it chose, and the in-place settled copy is the one that says
// where it was dispatched.
test("deriveRun: duplicate copies of one fix-applier's token land it once — a conflict fix-applier never also answers the survivors", () => {
  const R = "#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0";
  const F = "fix-pr-21=applied:def5678";
  const D = [F];
  const due = (rows, dispatched = []) => {
    const r = run({ rows, dispatched }, [pr(21)]);
    return [r.fixDue, r.conflictHeld];
  };
  // A bare copy on the PR's own row, after the hold-clearing settled one.
  assert.deepEqual(due([`${R} · conflict-hold:#21 · ${F}`, "#21 fix-pr-21"]), [[21], []]);
  assert.deepEqual(due([`${R} · conflict-hold:#21 · ${F}`, "#21 fix-pr-21"], D), [[21], []]);
  // The settled copy twice on one row.
  assert.deepEqual(due([`${R} · conflict-hold:#21 · ${F} · ${F}`]), [[21], []]);
  // A stale bare copy BEFORE the hold, the in-place settled one after it:
  // the settled one cleared the hold, whatever `## Dispatched` says.
  assert.deepEqual(due([`${R} · fix-pr-21 · conflict-hold:#21`, `#21 ${F}`]), [[21], []]);
  assert.deepEqual(due([`${R} · fix-pr-21 · conflict-hold:#21`, `#21 ${F}`], D), [[21], []]);
  // A review fix-applier that landed before a hold: a stale bare copy of it
  // after the hold does not clear that hold.
  assert.deepEqual(due([`${R} · ${F} · conflict-hold:#21 · fix-pr-21`], D), [[21], [21]]);
  // Liveness is read off the member once every row is read: a bare copy on an
  // earlier row of one a later row settled `failed` is dead, not live.
  assert.deepEqual(due([`${R} · fix-pr-21`, "#21 fix-pr-21=failed"]), [[21], []]);
  // Must accept: a DIFFERENT member after the conflict one still answers them.
  assert.deepEqual(due([`${R} · conflict-hold:#21 · ${F} · fix-pr-21-b=no-op`, "#21 fix-pr-21"]), [[], []]);
});

// #2329: a fix-applier answers the PR its token names, like the finisher-pr
// rule beside it. `dispatch`/`settle` only ever put `fix-pr-<M>` on PR #M's
// row, so a foreign one there is a hand-written stray — it must read as if
// absent, never clear that PR's hold, answer its survivors or hold it off.
test("deriveRun: a fix-pr token for another PR leaves this PR's hold and survivors exactly as if it were absent", () => {
  const H = "#20 impl-20=PR#21 · conflict-hold:#21";
  const due = (rows, dispatched = [], prs = [pr(21)]) => {
    const r = run({ rows, dispatched }, prs);
    return [r.fixDue, r.conflictHeld];
  };
  assert.deepEqual(due([H]), [[21], [21]], "control: the hold stands and is due");
  assert.deepEqual(due([`${H} · fix-pr-99=applied:def5678`]), [[21], [21]], "a foreign landed fix-applier does not clear the hold");
  assert.deepEqual(due([`${H} · fix-pr-99-b=no-op`]), [[21], [21]], "…a retry-suffixed one neither");
  assert.deepEqual(due([`${H} · fix-pr-99`]), [[21], [21]], "a foreign live fix-applier does not hold off this PR's own");
  // The real fix-pr-99 settled elsewhere: a stray bare copy on #21's row
  // inherits nothing from it.
  assert.deepEqual(due([`${H} · fix-pr-99`], ["fix-pr-99=applied:def5678"]), [[21], [21]]);
  assert.deepEqual(due([`${H} · fix-pr-99`, "#98 impl-98=PR#99 · fix-pr-99=applied:def5678"], [], [pr(21), pr(99)]), [[21], [21]]);
  // Nor does a settled stray on #21's row stand in for PR #99's own in-place
  // copy: #99's bare token, the only one on #99's row, still lands its member.
  assert.deepEqual(
    due(["#20 impl-20=PR#21 · fix-pr-99=applied:def5678", "#98 impl-98=PR#99 · conflict-hold:#99 · fix-pr-99"],
      ["fix-pr-99=applied:def5678"], [pr(21), pr(99)]),
    [[], []], "a foreign settled copy does not keep the owner's bare copy from landing");
  // …and lends it no outcome: a settled stray of fix-pr-21 on #99's row, read
  // before #21's own row, does not land #21's bare copy and clear its hold.
  assert.deepEqual(run({ rows: ["#98 impl-98=PR#99 · fix-pr-21=applied:abc1234", `${H} · fix-pr-21`] }, [pr(21), pr(99)]).conflictHeld,
    [21], "a foreign settled copy does not clear the owner's hold");
  // A row naming no PR at all (no `#<n>` key, no `PR#`) is no PR's row, so a
  // settled copy there is a stray as well: the owner's bare copy still lands.
  assert.deepEqual(due(["notes fix-pr-21=applied:def5678", `${H} · fix-pr-21`], ["fix-pr-21=applied:def5678"]),
    [[], []], "a settled copy on a PR-less row does not keep the owner's bare copy from landing");
  // A row's PR is its `PR#` mention even where its key names the token's
  // number: `fix-pr-21` on `#21 …=PR#22` is a stray on PR #22's row, neither
  // clearing #22's hold nor standing in for PR #21's own copies.
  const K = "#21 impl-21=PR#22 · conflict-hold:#22";
  assert.deepEqual(due([`${K} · fix-pr-21=applied:def5678`], [], [pr(22)]), [[22], [22]], "the key does not make it #22's own");
  assert.deepEqual(due([`${K} · fix-pr-21=applied:def5678`, `${H} · fix-pr-21`], ["fix-pr-21=applied:def5678"], [pr(21), pr(22)]),
    [[22], [22]], "…nor keep PR #21's bare copy from landing");
  // Nor does a foreign one answer a returned review's survivors.
  assert.deepEqual(due(["#20 impl-20=PR#21 · reviewed=abc1234:2/0/0 · fix-pr-99=applied:def5678"]), [[21], []]);
  // Must accept: the PR's own fix-applier, live and landed.
  assert.deepEqual(due([`${H} · fix-pr-21`]), [[], [21]], "own live: not re-offered, still held");
  assert.deepEqual(due([`${H} · fix-pr-21=applied:def5678`]), [[], []], "own landed: the hold is cleared");
  // …and on the PR's own `#21` row, which names no `PR#` — its key is its PR.
  assert.deepEqual(due([H, "#21 fix-pr-21=applied:def5678"]), [[], []]);
  // An in-place settled copy on the ticket row, whose key is the ticket's and
  // whose PR is its `PR#` mention, is the PR's own: it still says where its
  // member landed, so a stale bare copy read first does not land it instead.
  assert.deepEqual(
    due(["#21 fix-pr-21", "#20 impl-20=PR#21 · reviewed=abc1234:2/0/0 · conflict-hold:#21 · fix-pr-21=applied:def5678"],
      ["fix-pr-21=applied:def5678"]),
    [[21], []], "own in-place copy on the ticket row: it cleared the hold and answered no survivor");
});

// #2391: the other direction of #2329 — a settled stray reaching its OWNER
// through the member record `fixRunning`/`fixLive` (and a finisher's
// `past-pin` read) share. A PR-bound member's outcome counts off `##
// Dispatched` and its own PR's row only, whichever order the rows sit in.
test("deriveRun: a settled stray of a PR-bound member on another PR's row does not settle its owner's live one", () => {
  const own = "#20 impl-20=PR#21 · conflict-hold:#21 · fix-pr-21";
  const stray = "#98 impl-98=PR#99 · fix-pr-21=applied:abc1234";
  const seen = (rows, dispatched = []) => {
    const r = run({ rows, dispatched }, [pr(21), pr(99)]);
    return [r.fixDue, r.fixLive, r.reviewed.flatMap((x) => x.fixLive)];
  };
  for (const rows of [[own, stray], [stray, own], [own]]) {
    const [due, n] = seen(rows);
    assert.deepEqual([due, n], [[], 1], `fix-pr-21 is still working #21: ${JSON.stringify(rows)}`);
  }
  // The same reading through `reviewed.fixLive`, which gates the finisher.
  const reviewed = "#20 impl-20=PR#21 · reviewed=abc1234:0/0/0 · fix-pr-21";
  assert.deepEqual(seen([stray, reviewed])[2], ["fix-pr-21"]);
  // Must accept: the member's real settle — in `## Dispatched` or on its own
  // PR's row — still settles it, and a stray's own PR is unaffected.
  assert.deepEqual(seen([own], ["fix-pr-21=applied:abc1234"]).slice(0, 2), [[], 0], "settled in ## Dispatched");
  assert.deepEqual(seen(["#20 impl-20=PR#21 · conflict-hold:#21 · fix-pr-21=failed"]).slice(0, 2), [[21], 0], "settled on its own row");
  // A stray's token still counts as a live member when nothing settles it.
  assert.equal(seen(["#98 impl-98=PR#99 · fix-pr-21"])[1], 1);

  // A finisher's `halted:past-pin` read follows the same rule: a settled stray
  // on PR #99's row must not read PR #21's live finisher as halted past-pin,
  // wherever the rows sit.
  const fin = "#20 impl-20=PR#21 · reviewed=abc1234:0/0/0 · finisher-pr-21";
  const finStray = "#98 impl-98=PR#99 · finisher-pr-21=halted:past-pin";
  for (const rows of [[fin, finStray], [finStray, fin], [fin]]) {
    assert.deepEqual(run({ rows }, [pr(21), pr(99)]).reviewDue, [99], `live finisher, no halt: ${JSON.stringify(rows)}`);
  }
  assert.deepEqual(
    run({ rows: ["#20 impl-20=PR#21 · reviewed=abc1234:0/0/0 · finisher-pr-21=halted:past-pin"] }, [pr(21)]).reviewDue,
    [21], "own-row halted:past-pin still re-offers the review");
});

test("deriveRun: a conflict hold is read in either spelling and on a PR-keyed row", () => {
  assert.deepEqual(run({ rows: [HOLD_ROW(40, "conflict-hold-#40")] }, [pr(40)]).fixDue, [40]);
  assert.deepEqual(run({ rows: ["#350 review=wf:x reviewed=abc1234:0/1/0 · conflict-hold:#350"] }, [pr(350)]).fixDue, [350]);
  // `held-behind` rows and prose that merely mentions a conflict are not holds.
  const prose = run({ rows: [HOLD_ROW(40, "(conflict vs #38, resolved by rebase-pr-40) merge-conflict-resolved:ef82065a")] }, [pr(40, ["ready-to-merge"])]);
  assert.deepEqual([prose.fixDue, prose.mergeHeld], [[], 0]);
});

test("deriveRun: a conflict hold's hash is optional and the token is read whole, never by prefix", () => {
  assert.deepEqual(run({ rows: [HOLD_ROW(40, "conflict-hold:40")] }, [pr(40)]).fixDue, [40]);
  assert.deepEqual(run({ rows: [HOLD_ROW(40, "conflict-hold-40")] }, [pr(40)]).fixDue, [40]);
  assert.deepEqual(run({ rows: [HOLD_ROW(40, "conflict-hold:#40x")] }, [pr(40)]).fixDue, [], "trailing text makes it prose, not a hold");
});

// GitHub's `mergeable` off the open list, read every tick: a tracked PR it
// reads CONFLICTING, with no hold yet and nobody working it, is a hold the
// controller records.
const conflicting = (n, labels = []) => pr(n, labels, [n + 1000], HEAD_B, "CONFLICTING");
const TRACKED = (n, tail = "") => `#${n - 30} impl-${n - 30}=PR#${n} → PR#${n} · reviewed=abc1234:0/0/0${tail ? ` · ${tail}` : ""}`;
const conflictsOf = (rows, prs, dispatched = []) => {
  const r = run({ rows, dispatched }, prs);
  return [r.conflicts, r.conflictEscalate];
};

test("deriveRun: a tracked open PR GitHub reads CONFLICTING is a conflict to record — no other mergeable value is", () => {
  assert.deepEqual(conflictsOf([TRACKED(40)], [conflicting(40)]), [[40], []]);
  for (const mergeable of ["UNKNOWN", "BEHIND", "MERGEABLE", "conflicting", ""]) {
    assert.deepEqual(conflictsOf([TRACKED(40)], [pr(40, [], [1040], HEAD_B, mergeable)]), [[], []], mergeable);
  }
  // Ascending whatever order the rows arrive in.
  assert.deepEqual(conflictsOf([TRACKED(44), TRACKED(40)], [conflicting(44), conflicting(40)]), [[40, 44], []]);
});

test("deriveRun: a CONFLICTING PR the ledger does not track is no conflict to record — a human's or a chore PR", () => {
  assert.deepEqual(conflictsOf([], [conflicting(40)]), [[], []]);
  assert.deepEqual(conflictsOf(["#9 impl-9"], [conflicting(40)]), [[], []]);
});

test("deriveRun: a CONFLICTING PR already on an unresolved conflict hold is not recorded twice — the hold is the record", () => {
  const r = run({ rows: [TRACKED(40, "conflict-hold:#40")] }, [conflicting(40)]);
  assert.deepEqual([r.conflicts, r.conflictEscalate, r.fixDue], [[], [], [40]]);
  // Cleared by a landed fix-applier and CONFLICTING again: a fresh conflict.
  assert.deepEqual(conflictsOf([TRACKED(40, "conflict-hold:#40 · fix-pr-40=applied:def5678")], [conflicting(40)]), [[40], []]);
});

test("deriveRun: a live fix-applier, finisher or implementer on the PR holds the conflict line off; a settled one does not", () => {
  for (const [tail, dispatched] of [
    ["fix-pr-40", ["fix-pr-40"]],
    ["finisher-pr-40", ["finisher-pr-40"]],
    ["impl-10-b", ["impl-10-b"]],
  ]) {
    assert.deepEqual(conflictsOf([TRACKED(40, tail)], [conflicting(40)], dispatched), [[], []], tail);
  }
  for (const tail of ["fix-pr-40=failed", "finisher-pr-40=failed", "impl-10-b=bailed"]) {
    assert.deepEqual(conflictsOf([TRACKED(40, tail)], [conflicting(40)]), [[40], []], tail);
  }
  // Another PR's member is no one working this PR.
  assert.deepEqual(conflictsOf([TRACKED(40), TRACKED(41, "fix-pr-41")], [conflicting(40), pr(41)], ["fix-pr-41"]), [[40], []]);
});

test("deriveRun: a review in flight does not hold the conflict line off", () => {
  assert.deepEqual(conflictsOf([TRACKED(40, "review=wf:x")], [conflicting(40)]), [[40], []]);
  assert.deepEqual(conflictsOf(["#10 impl-10=PR#40 → PR#40 · review=wf:x"], [conflicting(40)]), [[40], []], "never reviewed yet");
});

test("deriveRun: a queued CONFLICTING PR is left to a live merge bot, and recorded when none is live", () => {
  const queued = [conflicting(40, ["ready-to-merge"])];
  assert.deepEqual(conflictsOf([TRACKED(40)], queued, ["merge-bot-1"]), [[], []]);
  assert.deepEqual(conflictsOf([TRACKED(40)], queued, ["merge-bot-1=done"]), [[40], []]);
  assert.deepEqual(conflictsOf([TRACKED(40)], [conflicting(40)], ["merge-bot-1"]), [[40], []], "an unqueued PR is not the bot's");
});

test("deriveRun: CONFLICTING again after two landed conflict fix-appliers escalates instead of recording a third hold", () => {
  const twice = "conflict-hold:#40 · fix-pr-40=applied:def5678 · conflict-hold:#40 · fix-pr-40-b=no-op";
  assert.deepEqual(conflictsOf([TRACKED(40, twice)], [conflicting(40)]), [[], [40]]);
  const twiceAt = (n) => `conflict-hold:#${n} · fix-pr-${n}=applied:def5678 · conflict-hold:#${n} · fix-pr-${n}-b=no-op`;
  assert.deepEqual(conflictsOf([TRACKED(44, twiceAt(44)), TRACKED(40, twiceAt(40))], [conflicting(44), conflicting(40)]), [[], [40, 44]],
    "ascending whatever order the rows arrive in");
  assert.deepEqual(conflictsOf([TRACKED(40, "conflict-hold:#40 · fix-pr-40=applied:def5678")], [conflicting(40)]), [[40], []], "one landed is not the cap");
  // It clears once GitHub stops reading CONFLICTING, or the PR leaves the list.
  assert.deepEqual(conflictsOf([TRACKED(40, twice)], [pr(40)]), [[], []]);
  assert.deepEqual(conflictsOf([TRACKED(40, twice)], []), [[], []]);
  // The same guards: a live member on it, or a hold already standing.
  assert.deepEqual(conflictsOf([TRACKED(40, `${twice} · fix-pr-40-c`)], [conflicting(40)], ["fix-pr-40-c"]), [[], []]);
  assert.deepEqual(conflictsOf([TRACKED(40, `${twice} · conflict-hold:#40`)], [conflicting(40)]), [[], []]);
  // A review fix-applier's landing is no conflict fix-applier's.
  const reviewFix = run({ rows: [`#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:2/0/0 · fix-pr-40=applied:def5678 · conflict-hold:#40 · fix-pr-40-b=no-op`] }, [conflicting(40)]);
  assert.deepEqual([reviewFix.conflicts, reviewFix.conflictEscalate], [[40], []]);
});

test("deriveRun: the hold the CONFLICT line names, appended to the row, is a conflict hold the fold reads", () => {
  const [line] = rowsOf(state({ conflicts: [40] }), "reviewers").filter((r) => r.action.startsWith("CONFLICT"));
  const token = /"<text> · (conflict-hold:#40 [^"]*)"/.exec(line.detail)[1];
  const r = run({ rows: [TRACKED(40, token)] }, [conflicting(40)]);
  assert.deepEqual([r.conflictHeld, r.fixDue, r.conflicts], [[40], [40], []]);
  const held = run({ rows: [TRACKED(44, "conflict-hold:#44"), TRACKED(40, "conflict-hold:#40")] }, [conflicting(44), conflicting(40)]);
  assert.deepEqual(held.conflictHeld, [40, 44], "ascending whatever order the rows arrive in");
});

test("deriveRun: the merge bot is live while its ## Dispatched entry is unsettled", () => {
  assert.equal(run({ dispatched: ["merge-bot-1"] }).mergeBotLive, 1);
  assert.equal(run({ dispatched: ["merge-bot-1=done"] }).mergeBotLive, 0);
  assert.equal(run({ dispatched: ["merge-bot-1=done", "merge-bot-2=killed", "merge-bot-3"] }).mergeBotLive, 1);
});

test("deriveRun: drain and tier mismatches come off the file", () => {
  const r = run({
    rows: ["#7 impl-7=tier-mismatch", "#8 impl-8=tier-mismatch · impl-8-b"],
    dispatched: ["impl-7=tier-mismatch", "impl-8=tier-mismatch", "impl-8-b"],
    drain: "maintainer asked",
  });
  assert.equal(r.draining, "maintainer asked");
  assert.deepEqual(r.tierMismatch, ["impl-7"], "#8's replacement is the fix");
});

// #2485: a mismatch on a ticket whose issue is CLOSED holds nothing.
test("deriveRun: a tier mismatch on a closed ticket stops holding; one on an open ticket still does", () => {
  const ledger = { rows: ["#7 impl-7=tier-mismatch", "#8 impl-8 · tier-mismatch=impl-8:fleet-implementer"], dispatched: ["impl-7=tier-mismatch", "impl-8"] };
  assert.deepEqual(run(ledger).tierMismatch, ["impl-7", "impl-8"], "no probe answer: every mismatch holds");
  const r = run(ledger, [], new Set([7]));
  assert.deepEqual(r.tierMismatch, ["impl-8"], "#7 is closed, #8 is not");
  assert.deepEqual(r.tierUnchecked, [], "a lifted mismatch does not fall through to unchecked");
  assert.deepEqual(run(ledger, [], new Set([7, 8])).tierMismatch, []);
});

test("deriveRun: a closed ticket lifts only its own mismatch, not a replacement's on another ticket", () => {
  const r = run({ rows: ["#7 impl-7=tier-mismatch · impl-7-b=tier-mismatch", "#9 impl-9=tier-mismatch"] }, [], new Set([9]));
  assert.deepEqual(r.tierMismatch, ["impl-7-b"]);
});

test("deriveRun: tier mismatch holds while the LATEST replacement is also tier-mismatch", () => {
  const r = run({
    rows: ["#8 impl-8=tier-mismatch · impl-8-b=tier-mismatch"],
    dispatched: ["impl-8=tier-mismatch", "impl-8-b=tier-mismatch"],
  });
  assert.deepEqual(r.tierMismatch, ["impl-8-b"], "a replacement that is ALSO tier-mismatch keeps the row held");
});

// #1398: tier-check.mjs writes `tier-ok=<member>:<definition>` on a pass;
// the newest implementer of a ticket with no verdict holds as unchecked,
// live or settled alike.
test("deriveRun: the newest implementer with no tier verdict is unchecked, live or settled; tier-ok clears it", () => {
  assert.deepEqual(run({ rows: ["#7 impl-7 · class=routine"] }).tierUnchecked, ["impl-7"]);
  assert.deepEqual(run({ rows: ["#7 impl-7=bailed"] }).tierUnchecked, ["impl-7"], "a settled member is still owed its check");
  const ok = run({ rows: ["#7 impl-7 · class=routine · tier-ok=impl-7:fleet-implementer"] });
  assert.deepEqual([ok.tierUnchecked, ok.tierMismatch], [[], []]);
  // A verdict names ITS member: another member's tier-ok clears nothing.
  assert.deepEqual(run({ rows: ["#7 impl-7 · tier-ok=impl-17:fleet-implementer"] }).tierUnchecked, ["impl-7"]);
});

test("deriveRun: a settled tier-mismatch keeps its own hold and is never also unchecked", () => {
  const r = run({ rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] });
  assert.deepEqual([r.tierMismatch, r.tierUnchecked], [["impl-7"], []]);
  // A member settled some other way before its check found the mismatch
  // carries the verdict as a row token instead.
  const token = run({ rows: ["#7 impl-7=bailed · tier-mismatch=impl-7:fleet-implementer"] });
  assert.deepEqual([token.tierMismatch, token.tierUnchecked], [["impl-7"], []]);
});

test("deriveRun: tier-unverifiable is a verdict for its own member — it clears unchecked, never reads as a mismatch, and a mismatch still outranks it", () => {
  const r = run({ rows: ["#7 impl-7=killed · tier-unverifiable=impl-7:no-transcript"] });
  assert.deepEqual([r.tierUnchecked, r.tierMismatch], [[], []]);
  const both = run({ rows: ["#7 impl-7=tier-mismatch · tier-unverifiable=impl-7:no-transcript"] });
  assert.deepEqual([both.tierMismatch, both.tierUnchecked], [["impl-7"], []]);
  assert.deepEqual(run({ rows: ["#7 impl-7=killed · tier-unverifiable=impl-17:no-transcript"] }).tierUnchecked, ["impl-7"]);
});

test("deriveRun: only the newest member of a ticket counts toward the tier holds", () => {
  const replaced = run({ rows: ["#8 impl-8=tier-mismatch · impl-8-b"], dispatched: ["impl-8=tier-mismatch", "impl-8-b"] });
  assert.deepEqual([replaced.tierMismatch, replaced.tierUnchecked], [[], ["impl-8-b"]], "the replacement is what is owed a check now");
  const checked = run({ rows: ["#8 impl-8=tier-mismatch · impl-8-b · tier-ok=impl-8-b:fleet-implementer"] });
  assert.deepEqual([checked.tierMismatch, checked.tierUnchecked], [[], []]);
  // The predecessor's own pass does not stand in for its replacement's.
  const stale = run({ rows: ["#8 impl-8=killed · tier-ok=impl-8:fleet-implementer · impl-8-b"] });
  assert.deepEqual(stale.tierUnchecked, ["impl-8-b"]);
  // Nor does a predecessor killed before it was ever checked hold the row
  // once its replacement has passed.
  assert.deepEqual(run({ rows: ["#8 impl-8=killed · impl-8-b · tier-ok=impl-8-b:fleet-implementer"] }).tierUnchecked, []);
});

// PR #2302 review: the replacement climbs past the HIGHEST letter the ticket
// has used, not the held member's own — `-c` dispatched before `-b` left the
// tick naming `impl-7-c`, which ledger.mjs refuses as already dispatched.
test("deriveRun → implementers: a mismatch's replacement skips every retry letter the ticket already used", () => {
  const step = (rows) => {
    const d = run({ rows });
    return row(state({ tierMismatch: d.tierMismatch, implNames: d.implNames }), "implementers").detail.split(" — ")[1];
  };
  assert.equal(step(["#7 impl-7=killed · impl-7-c=killed · impl-7-b=tier-mismatch"]), "dispatch impl-7-d at its row's tier");
  assert.equal(step(["#7 impl-7-z=killed · impl-7-c=tier-mismatch"]), "impl-7-c has no retry letter left");
  // Another ticket's letters are not this one's.
  assert.equal(step(["#7 impl-7=tier-mismatch", "#8 impl-8-c=killed"]), "dispatch impl-7-b at its row's tier");
});

test("deriveRun: excluded rows claim their ticket while their premise still holds, and carry their premises", () => {
  const r = run({ rows: ["#50 excluded · behind-pr:#44", "#51 excluded · behind-issue:#9 behind-pr:feat/x"] }, [pr(44)]);
  assert.ok(r.claimed.has(50) && r.claimed.has(51));
  assert.deepEqual(r.excluded, [
    { n: 50, premises: [{ kind: "pr", target: "44" }] },
    { n: 51, premises: [{ kind: "issue", target: "9" }, { kind: "pr", target: "feat/x" }] },
  ]);
});

test("deriveRun: a behind-pr premise no longer open lifts the claim, but the row is still reported excluded", () => {
  const r = run({ rows: ["#50 excluded · behind-pr:#44"] }, []);
  assert.equal(r.claimed.has(50), false, "#44 is not in the open list — the premise has lifted");
  assert.deepEqual(r.excluded, [{ n: 50, premises: [{ kind: "pr", target: "44" }] }]);
});

test("deriveRun: one still-open premise among several keeps the claim, even if another has lifted", () => {
  const r = run({ rows: ["#50 excluded · behind-pr:#44 behind-pr:#45"] }, [pr(45)]);
  assert.ok(r.claimed.has(50), "#45 is still open — #44 alone lifting is not enough");
});

test("deriveRun: the row text it does not own is accepted as it stands", () => {
  // The accept side of every refusal below: freeform row text, the arrow, the
  // board's own tokens and an empty ledger are the ordinary case.
  assert.doesNotThrow(() => run({
    rows: ["#324 impl-324=PR#346 → PR#346 · fix-pr-346=no-op · ruled:6-applies · ci=123:1:success · ports=16324 · tier=task-high"],
    dispatched: ["impl-324=PR#346", "fix-pr-346=no-op"],
  }, [pr(346)]));
  const empty = run({});
  assert.equal(empty.implLive + empty.reviewsLive + empty.fixLive + empty.mergeBotLive, 0);
});

test("deriveRun: a token it cannot read refuses by naming it, never counts it live or gone", () => {
  for (const [what, ledger, why] of [
    ["an outcome outside the vocabulary", { rows: ["#9 impl-9=merged"] }, /impl-9.*'merged' is not an outcome/],
    ["a malformed ## Dispatched entry", { dispatched: ["impl-9 oops"] }, /## Dispatched entry 'impl-9 oops'/],
    ["a reviewed= with no counts", { rows: ["#9 review=wf:a reviewed=abc1234"] }, /reviewed=abc1234/],
    ["a review= of no known kind", { rows: ["#9 review=bogus"] }, /review=bogus/],
    ["a conflict hold naming another PR", { rows: ["#10 impl-10=PR#40 → PR#40 · conflict-hold:#38"] }, /conflict-hold:#38.*PR #40/],
    ["a conflict hold on a row with no PR mention or PR-keyed impl token at all", { rows: ["conflict-hold:#40"] }, /no PR's/],
  ]) {
    assert.throws(() => run(ledger), why, what);
  }
});

test("unclaimed: shortlist entries with no impl- or excluded row, in the file's order", () => {
  const r = run({ rows: ["#2 impl-2", "#4 excluded · behind-pr:#1", "#5 impl-5=bailed"] }, [pr(1)]);
  assert.deepEqual(unclaimed([1, 2, 3, 4, 5, 6].map((n) => ({ n, t: `t${n}` })), r), [1, 3, 6]);
});

test("unclaimed: a lifted behind-pr exclusion no longer claims its ticket, once it reaches the heads", () => {
  const r = run({ rows: ["#4 excluded · behind-pr:#1"] }, []);
  assert.deepEqual(unclaimed([1, 2, 3, 4].map((n) => ({ n, t: `t${n}` })), r), [1, 2, 3, 4]);
});

test("unclaimed: a behind-issue exclusion still claims its ticket while absent from entries", () => {
  const r = run({ rows: ["#9 excluded · behind-issue:#5"] });
  assert.deepEqual(unclaimed([1, 2, 3].map((n) => ({ n, t: `t${n}` })), r), [1, 2, 3]);
});

test("unclaimed: a behind-issue exclusion's ticket reappearing in entries is admitted — the ledger row is stale, the scan is not", () => {
  const r = run({ rows: ["#9 excluded · behind-issue:#5"] });
  assert.deepEqual(unclaimed([1, 9].map((n) => ({ n, t: `t${n}` })), r), [1, 9]);
});

test("unclaimed: a still-open behind-pr exclusion blocks its ticket even if it appears in entries", () => {
  const r = run({ rows: ["#9 excluded · behind-pr:#44"] }, [pr(44)]);
  assert.deepEqual(unclaimed([1, 9].map((n) => ({ n, t: `t${n}` })), r), [1]);
});

test("parseShortlist: shortlist.mjs's payload reads; anything else is unparsable, never a refusal", () => {
  assert.deepEqual(parseShortlist('{"scanned":3,"shortlist":[{"n":7,"t":"a"}]}'),
    { status: "ok", scanned: 3, entries: [{ n: 7, t: "a" }] });
  for (const bad of ["", "{", "[]", '{"shortlist":[]}', '{"scanned":1,"shortlist":{}}', '{"scanned":1,"shortlist":[{"n":"7","t":"a"}]}',
    '{"scanned":1,"shortlist":[{"n":0,"t":"a"}]}', '{"scanned":1,"shortlist":[{"n":-1,"t":"a"}]}']) {
    assert.deepEqual(parseShortlist(bad), { status: "unparsable", scanned: null, entries: [] }, bad);
  }
});

test("refreshWhy: short of the cap, missing or empty refreshes; draining never does", () => {
  const base = { draining: null, status: "ok", entries: 5, unclaimed: 2, implCap: 2 };
  assert.equal(refreshWhy(base), null);
  assert.equal(refreshWhy({ ...base, unclaimed: 1 }), "unclaimed 1 < cap 2");
  assert.equal(refreshWhy({ ...base, status: "missing", entries: 0, unclaimed: 0 }), "shortlist missing");
  assert.equal(refreshWhy({ ...base, status: "unparsable", entries: 0, unclaimed: 0 }), "shortlist unparsable");
  assert.equal(refreshWhy({ ...base, entries: 0, unclaimed: 0, implCap: 0 }), "shortlist empty");
  assert.equal(refreshWhy({ ...base, status: "missing", draining: "x" }), null);
});

// ---------------------------------------------------------------------------
// The CLI half. Every case runs a COPY of the script from a stub directory,
// inside its own throwaway git repository, so the ledger and shortlist it
// reads are the case's own `.fleet/` files, resolved the way the real run
// resolves them — against the git common dir.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/fleet-tick.mjs", import.meta.url));
// Every non-builtin module the copied script needs at startup, direct import
// or transitive — and ledger.mjs with its own, because the tick reads the
// ledger through `ledger.mjs read`. An unlisted sibling is a module-not-found
// at startup: exit 1, a shape no case below expects.
const SIBLING_MODULES = ["arg.mjs", "fleet-dir.mjs", "fleet-state.mjs", "git-env.mjs", "is-cli.mjs", "ledger.mjs", "ledger-grammar.mjs", "main-checkout.mjs", "proc.mjs"].map(
  (m) => [m, fileURLToPath(new URL(`../plugin/scripts/${m}`, import.meta.url))],
);

// Every subprocess below is spawned synchronously, so a hung one blocks this
// file's event loop: no per-test or runner timeout can fire, and only the
// runner's wall-clock kill ends it, as a cancelled file that reads like a hang
// somewhere else (#2320). Every spawn goes through `spawnBounded`, which kills
// the child at the bound and fails its own test naming the timeout and the
// command. The bound is per spawn and generous on purpose: #2320's triage
// measured the slowest whole case at ~1.5s solo on an idle host and ~3.85x
// that under the full suite, but on a host loaded by other agents the slowest
// case has taken ~13s solo, and a case can run several spawns.
const SPAWN_TIMEOUT_MS = 60_000;
const spawnBounded = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts, timeout: SPAWN_TIMEOUT_MS });
  if (r.error) {
    const what = [cmd, ...args].join(" ");
    throw new Error(r.error.code === "ETIMEDOUT"
      ? `timed out after ${SPAWN_TIMEOUT_MS}ms, killed with ${r.signal}: ${what}`
      : `could not run ${what}: ${r.error.message}`);
  }
  return r;
};

// The bound holds only while every spawn takes it: a raw synchronous spawn
// added anywhere else in this file brings #2320's unbounded hang back, and
// every case still passes until the day that child hangs. So this reads the
// file's own source and names any `spawnSync`/`execFileSync`/`execSync` call
// outside the helper. A comment spelling one of them with its call paren fails
// it too (the loud direction); an import renamed with `as` walks past it.
test("CLI: every synchronous spawn in this file goes through spawnBounded (#2320)", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const start = src.indexOf("const spawnBounded = ");
  assert.ok(start > 0, "the spawnBounded helper is gone; this sweep has nothing to measure against");
  const end = src.indexOf("\n};\n", start);
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  const raw = [...src.matchAll(/\b(?:spawnSync|execFileSync|execSync)\s*\(/g)]
    .filter((m) => m.index < start || m.index > end)
    .map((m) => `line ${lineOf(m.index)}: ${m[0]}`);
  assert.deepEqual(raw, []);
});

// `pr list` for the open PRs, `issue view` for a behind-issue premise's state,
// `pr view` for the state of a PR an in-flight review names that is no longer
// on the open list, `issue list --label in-progress` for the stall report's
// claimed count. `GH_HANG` names one of those (`pr list`, `issue view`, …) to
// stall for `GH_HANG_S` seconds before answering as usual, so a tick that waits
// a hang out still reads a normal reply. The sleep holds none of the stub's
// pipes: killed at the tick's bound, the stub leaves no child keeping the
// tick's read open.
const GH_STUB = `#!/bin/sh
[ -n "$GH_HANG" ] && [ "$1 $2" = "$GH_HANG" ] && sleep "$GH_HANG_S" </dev/null >/dev/null 2>&1
case "$1 $2" in
  "pr list") [ -n "$PR_LIST_LOG" ] && echo "$*" >> "$PR_LIST_LOG"; [ -n "$PR_FAIL" ] && { echo "boom" >&2; exit 1; }; cat "$FIXTURE_PRS" ;;
  "issue view")
    echo "$3" >> "$ISSUE_VIEW_LOG"
    [ -n "$ISSUE_VIEW_FAIL" ] && { echo "gh: issue view failed" >&2; exit 1; }
    [ -n "$ISSUE_VIEW_BODY" ] && { printf '%s\n' "$ISSUE_VIEW_BODY"; exit 0; }
    # Real gh answers for the repository an inherited GIT_DIR or GH_REPO names;
    # this one answers CLOSED for every issue there, so a probe that forgot to
    # scrub them lifts an exclusion the case's own repository still holds.
    [ -n "$GIT_DIR$GIT_WORK_TREE$GH_REPO" ] && { echo '{"state":"CLOSED"}'; exit 0; }
    exec jq -c --arg n "$3" '{state: (.[$n] // error("no such issue"))}' "$FIXTURE_ISSUE_STATES" ;;
  "pr view")
    echo "$3" >> "$PR_VIEW_LOG"
    [ -n "$PR_VIEW_FAIL" ] && { echo "gh: pr view failed" >&2; exit 1; }
    [ -n "$PR_VIEW_BODY" ] && { printf '%s\n' "$PR_VIEW_BODY"; exit 0; }
    # Real gh answers for the repository an inherited GIT_DIR or GH_REPO names;
    # this one answers MERGED for every PR there, so a probe that forgot to
    # scrub them retires a review the case's own repository still holds.
    [ -n "$GIT_DIR$GIT_WORK_TREE$GH_REPO" ] && { echo '{"state":"MERGED"}'; exit 0; }
    exec jq -c --arg n "$3" '{state: (.[$n] // error("no such pull request"))}' "$FIXTURE_PR_STATES" ;;
  "issue list")
    [ -n "$CLAIMED_FAIL" ] && { echo "boom" >&2; exit 1; }
    expr=""
    while [ $# -gt 0 ]; do
      case "$1" in --jq) shift; expr="$1" ;; esac
      shift
    done
    exec jq -c "$expr" "$FIXTURE_CLAIMED" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

// Stands in for shortlist.mjs, whose own suite is shortlist.test.mjs: logs
// that it ran, then either fails or writes the case's refreshed payload to the
// file the real one writes, and prints it with \`file\` the way the real one does.
const SHORTLIST_STUB = `import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(process.env.REFRESH_LOG, "ran\\n");
if (process.env.REFRESH_FAIL) { console.error("shortlist: could not answer"); process.exit(2); }
const payload = readFileSync(process.env.FIXTURE_REFRESH, "utf8");
const file = join(process.cwd(), ".fleet", "shortlist.json");
mkdirSync(join(process.cwd(), ".fleet"), { recursive: true });
writeFileSync(file, payload);
console.log(JSON.stringify({ file, ...JSON.parse(payload) }));
`;

// The ledger on disk, in the layout ledger.mjs's save() writes.
const ledgerText = ({ rows = [], dispatched = [], drain = null } = {}) => {
  const list = (xs) => xs.map((x) => `- ${x}`).join("\n");
  return `# Fleet run ledger\n\n## Rows\n\n${list(rows)}\n\n## Dispatched\n\n${list(dispatched)}\n\n## Filed\n\n\n\n## Ruled\n\n`
    + (drain === null ? "" : `\n\n## Drain\n\n- ${drain}`) + "\n";
};
const shortlistText = (ns, scanned = ns.length) => JSON.stringify({ scanned, shortlist: ns.map((n) => ({ n, t: `t${n}` })) });

// `baseline` records the run's main-checkout baseline the way Phase 0 does,
// after `beforeRun`; `afterBaseline` is a stray write landing mid-run. The
// repo ignores `.fleet/` and `.worktrees/` as a fleet repo's .gitignore does,
// through info/exclude so no tracked file says so.
function runCli(args = [], {
  prs = [], ledger, shortlist, refresh = shortlistText([]), refreshFail = false,
  issueStates = {}, prStates = {}, claimed = [], env: extraEnv = {}, defaultState = false, keep = false, beforeRun = () => {},
  baseline = true, afterBaseline = () => {},
} = {}) {
  // On macOS tmpdir() is /var -> /private/var; resolving it up front makes
  // every path below the resolved one. (A symlinked path no longer stops a
  // copy running its own main(): is-cli.mjs compares by realpath.)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-")));
  // Everything from here to the return can throw: a failed `git init` or
  // `--record`, or spawnBounded's timeout (#2320). The dir goes whenever that
  // happens, `keep` or not — a throw hands the caller no `r.dir` to remove.
  // `keep` only spares it on a normal return.
  let returned = false;
  try {
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    mkdirSync(bin);
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    assert.equal(spawnBounded("git", ["init", "-q", repo]).status, 0);
    writeFileSync(join(repo, ".git", "info", "exclude"), ".fleet/\n.worktrees/\n");
    writeExecStub(join(bin, "gh"), GH_STUB);
    const script = join(bin, "fleet-tick.mjs");
    writeFileSync(script, readFileSync(SCRIPT));
    for (const [name, path] of SIBLING_MODULES) writeFileSync(join(bin, name), readFileSync(path));
    writeFileSync(join(bin, "shortlist.mjs"), SHORTLIST_STUB);
    const fx = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };
    if (ledger !== undefined) writeFileSync(join(repo, ".fleet", "ledger.md"), ledgerText(ledger));
    if (shortlist !== undefined) writeFileSync(join(repo, ".fleet", "shortlist.json"), shortlist);
    beforeRun(repo);
    if (baseline) {
      const rec = spawnBounded(process.execPath, [join(bin, "main-checkout.mjs"), "--record"], { cwd: repo });
      assert.equal(rec.status, 0, rec.stderr);
    }
    afterBaseline(repo);
    const refreshLog = fx("refresh.log", "");
    const issueViewLog = fx("issue-view.log", "");
    const prViewLog = fx("pr-view.log", "");
    // Every case gets its own state file unless it names one: the default path
    // resolves against the git common dir, and a shared streak and digest would
    // make the fold cases order-dependent. `defaultState` opts out for the case
    // whose subject IS that resolution.
    const stateArg = args.includes("--state") || defaultState ? [] : ["--state", join(dir, "heartbeat.json")];
    const r = spawnBounded(process.execPath, [script, ...args, ...stateArg], {
      cwd: repo,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_PRS: fx("prs.json", JSON.stringify(prs)),
        FIXTURE_CLAIMED: fx("claimed.json", JSON.stringify(claimed)),
        FIXTURE_ISSUE_STATES: fx("issue-states.json", JSON.stringify(issueStates)),
        FIXTURE_PR_STATES: fx("pr-states.json", JSON.stringify(prStates)),
        FIXTURE_REFRESH: fx("refresh.json", refresh),
        REFRESH_LOG: refreshLog, ISSUE_VIEW_LOG: issueViewLog, PR_VIEW_LOG: prViewLog,
        ...(refreshFail ? { REFRESH_FAIL: "1" } : {}),
        ...extraEnv,
      },
    });
    r.refreshed = readFileSync(refreshLog, "utf8").split("\n").filter(Boolean).length;
    r.issueViews = readFileSync(issueViewLog, "utf8").split("\n").filter(Boolean);
    r.prViews = readFileSync(prViewLog, "utf8").split("\n").filter(Boolean);
    r.repo = repo;
    r.dir = dir;
    returned = true;
    return r;
  } finally {
    if (!returned || !keep) rmSync(dir, { recursive: true, force: true });
  }
}
const lineOf = (r, role) => r.stdout.split("\n").filter((l) => l.startsWith(role));

// A throw inside runCli (a failed `git init`/`--record` assert, spawnBounded's
// timeout) used to leave its `fleet-tick-*` fixture in the tmpdir.
// `beforeRun` runs after the dir exists, so it stands in for any such throw.
for (const keep of [false, true]) {
  test(`CLI: runCli removes its fixture dir when it throws mid-helper, keep: ${keep}`, () => {
    let dir;
    assert.throws(() => runCli([], { keep, beforeRun: (repo) => { dir = join(repo, ".."); throw new Error("boom"); } }), /boom/);
    assert.ok(dir, "beforeRun never ran, so the throw happened before the dir existed");
    assert.equal(existsSync(dir), false);
  });
}

test("CLI: runCli with keep: true hands back a fixture dir that still exists", () => {
  const r = runCli([], { keep: true });
  try {
    assert.equal(existsSync(r.dir), true);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(runCli([]).dir), false, "without keep the dir is gone on return");
});

test("CLI: the router row reads the run's .fleet/cost-guard.json, and prints DEFAULT-ONLY without one", () => {
  const none = runCli([], { shortlist: shortlistText([]) });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(lineOf(none, "router"), ["router       → DEFAULT-ONLY   (cost-guard.json missing — run pr-cost.mjs --guard)"]);
  const ok = runCli([], {
    shortlist: shortlistText([]),
    beforeRun: (repo) => writeFileSync(join(repo, ".fleet", "cost-guard.json"), guardJson({ verdict: "none", baseline: { ...BASE, n: 12 } })),
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(lineOf(ok, "router"), ["router       → NO VERDICT   (baseline n=12/20; guard computed 2026-10-03T00:00:00.000Z)"]);
});

test("CLI: the #1692 shape, read off the ledger — two live implementers at cap 2 pull nothing", () => {
  const r = runCli([], {
    ledger: { rows: ["#412 impl-412 · tier-ok=impl-412:fleet-implementer", "#415 impl-415 · tier-ok=impl-415:fleet-implementer"], dispatched: ["impl-412", "impl-415"] },
    shortlist: shortlistText([412, 415, 420, 421, 422]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 2\/2 → AT CAP/m);
  assert.doesNotMatch(r.stdout, /PULL/);
  assert.equal(r.refreshed, 0, "three unclaimed at cap 2 is not short of the cap");

  // One settles: exactly one slot frees, and the next unclaimed head fills it.
  const one = runCli([], {
    ledger: { rows: ["#412 impl-412=PR#500 → PR#500 · tier-ok=impl-412:fleet-implementer", "#415 impl-415 · tier-ok=impl-415:fleet-implementer"], dispatched: ["impl-412=PR#500", "impl-415"] },
    shortlist: shortlistText([412, 415, 420, 421, 422]),
  });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^implementers 1\/2 → PULL #420 {3}\(/m);
});

test("CLI: a fresh run with no ledger reads zero live members, and no shortlist is depth 0 plus a refresh", () => {
  const r = runCli([], { refresh: shortlistText([7, 8, 9], 12) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  // Pulled from the file the refresh just wrote — not a tick of waiting.
  assert.match(r.stdout, /^implementers 0\/2 → PULL #7 #8 {3}\(unclaimed=3 supply=12 unreviewed=0 shortlist=missing\)/m);
  assert.match(r.stdout, /^shortlist {4}→ REFRESHED shortlist: 3 entries; 0 lifted {3}\(shortlist missing\)$/m);
});

test("CLI: an unparsable shortlist is depth 0 plus a refresh, never a refusal", () => {
  const r = runCli([], { shortlist: "{not json", refresh: shortlistText([]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  assert.match(r.stdout, /^implementers 0\/2 → SUGGEST \/triage, hold idle {3}\(unclaimed=0 supply=0 unreviewed=0 shortlist=unparsable\)/m);
  assert.match(r.stdout, /REFRESHED shortlist: 0 entries; 0 lifted {3}\(shortlist unparsable; unchanged\)/);
});

test("CLI: a permission-denied shortlist reads as unreadable, not unparsable — the fault is the filesystem's, not the JSON's", () => {
  const r = runCli([], {
    shortlist: shortlistText([1]), refresh: shortlistText([]),
    beforeRun: (repo) => chmodSync(join(repo, ".fleet", "shortlist.json"), 0o000),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1, "unreadable, like unparsable, is a refresh trigger — never a refusal");
  assert.match(r.stdout, /shortlist=unreadable/, "EACCES must not be mislabeled as malformed JSON");
  assert.doesNotMatch(r.stdout, /shortlist=unparsable/);
});

test("CLI: a failed refresh prints REFRESH FAILED and every other row, at exit 0", () => {
  const r = runCli([], { refreshFail: true, prs: [pr(60, ["ready-to-merge"])] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^shortlist {4}→ REFRESH FAILED {3}\(shortlist missing — shortlist\.mjs exited 2: shortlist: could not answer\)$/m);
  assert.match(r.stdout, /^merge-bot {4}0\/1 → DISPATCH merge-bot/m);
});

test("CLI: PULL names unclaimed heads only — claimed, bailed and excluded tickets are skipped", () => {
  const r = runCli(["--implementer-cap", "3"], {
    ledger: { rows: ["#1 impl-1=bailed · tier-ok=impl-1:fleet-implementer", "#2 impl-2 · tier-ok=impl-2:fleet-implementer", "#3 excluded · behind-pr:#99"], dispatched: ["impl-1=bailed", "impl-2"] },
    shortlist: shortlistText([1, 2, 3, 4, 5, 6]),
    prs: [pr(99)],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 1\/3 → PULL #4 #5 /m);
  assert.equal(r.refreshed, 0, "three unclaimed at cap 3 is not short");
});

test("CLI: reviewer rows are named per PR, fix-appliers first, reviews oldest first", () => {
  const r = runCli([], {
    ledger: {
      rows: [
        "#10 impl-10=PR#346 → PR#346 · review=wf:a reviewed=abc1234:2/0/0",
        "#11 impl-11=PR#350 → PR#350",
        "#12 impl-12=PR#349 → PR#349",
      ],
      dispatched: ["impl-10=PR#346", "impl-11=PR#350", "impl-12=PR#349"],
    },
    shortlist: shortlistText([]),
    prs: [pr(350), pr(349), pr(346)],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lineOf(r, "reviewers").map((l) => l.replace(/ {3}\(.*$/, "")), [
    "reviewers    0/6 → DISPATCH fix-pr PR#346",
    "reviewers    0/6 → DISPATCH review PR#349 PR#350",
  ]);
});

test("CLI: --max-reviews bounds the reviews one tick starts", () => {
  const r = runCli(["--max-reviews", "1"], { shortlist: shortlistText([]), prs: [pr(51), pr(52), pr(53)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers {4}0\/6 → DISPATCH review PR#51 {3}\(.*max-reviews=1\)$/m);
  const busy = runCli(["--max-reviews", "1"], {
    ledger: { rows: ["#51 review=wf:x"] }, shortlist: shortlistText([]), prs: [pr(51), pr(52)],
  });
  assert.match(busy.stdout, /^reviewers {4}1\/6 → HOLD \(max-reviews 1 in flight\)/m);
  // Default = the reviewer cap.
  const open = runCli(["--reviewer-cap", "2"], { shortlist: shortlistText([]), prs: [pr(51), pr(52), pr(53)] });
  assert.match(open.stdout, /^reviewers {4}0\/2 → DISPATCH review PR#51 PR#52 /m);
});

test("CLI: the narrowed backlog gate — a deep backlog with free reviewer slots still pulls", () => {
  const r = runCli([], { shortlist: shortlistText([7, 8]), prs: [pr(51), pr(52), pr(53)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → PULL #7 #8 /m);
  const saturated = runCli(["--reviewer-cap", "1"], {
    ledger: { rows: ["#51 review=wf:x"] }, shortlist: shortlistText([7, 8]), prs: [pr(51), pr(52)],
  });
  assert.match(saturated.stdout, /^implementers 0\/2 → HOLD \(review side saturated\)/m);
});

test("CLI: drain holds the implementer row, stops refreshing, and keeps the review and merge rows firing", () => {
  const r = runCli([], {
    ledger: { rows: ["#9 impl-9=released"], dispatched: ["impl-9=released"], drain: "maintainer asked" },
    prs: [pr(51), pr(60, ["ready-to-merge"])],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → HOLD \(draining\)/m);
  assert.equal(r.refreshed, 0, "a draining run's missing shortlist is not a reason to restart supply");
  assert.doesNotMatch(r.stdout, /REFRESH/);
  assert.match(r.stdout, /^reviewers {4}0\/6 → DISPATCH review PR#51 /m);
  assert.match(r.stdout, /^merge-bot {4}0\/1 → DISPATCH merge-bot /m);
});

test("CLI: merge-bot liveness and holds come off the ledger", () => {
  const prs = [pr(38), pr(40, ["ready-to-merge"])];
  const live = runCli([], { ledger: { dispatched: ["merge-bot-1"] }, shortlist: shortlistText([]), prs });
  assert.match(live.stdout, /^merge-bot {4}1\/1 → AT CAP/m);
  const held = runCli([], {
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · held-behind:#38"], dispatched: ["merge-bot-1=done"] },
    shortlist: shortlistText([]), prs,
  });
  assert.match(held.stdout, /^merge-bot {4}0\/1 → HOLD {3}\(merge-queue=1 held=1/m);
  const lifted = runCli([], {
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · held-behind:#38"], dispatched: ["merge-bot-1=done"] },
    shortlist: shortlistText([]), prs: [pr(40, ["ready-to-merge"])],
  });
  assert.match(lifted.stdout, /^merge-bot {4}0\/1 → DISPATCH merge-bot {3}\(merge-queue=1 held=0\)/m);
});

test("CLI: a merge hold accepts both the held-behind:#M and held-behind-#M spellings", () => {
  const colon = runCli([], {
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · held-behind:#38"], dispatched: ["merge-bot-1=done"] },
    shortlist: shortlistText([]), prs: [pr(38), pr(40, ["ready-to-merge"])],
  });
  assert.match(colon.stdout, /^merge-bot {4}0\/1 → HOLD {3}\(merge-queue=1 held=1/m);
  const hyphen = runCli([], {
    ledger: { rows: ["#11 impl-11=PR#41 → PR#41 · held-behind-#38"], dispatched: ["merge-bot-1=done"] },
    shortlist: shortlistText([]), prs: [pr(38), pr(41, ["ready-to-merge"])],
  });
  assert.match(hyphen.stdout, /^merge-bot {4}0\/1 → HOLD {3}\(merge-queue=1 held=1/m,
    "run-merge-bot.md's own documented report format (#38) must be recognized too");
});

test("CLI: a conflict hold prints DISPATCH fix-pr and holds the merge bot until the fix-applier settles", () => {
  const tick = (tail, dispatched) => runCli([], {
    ledger: { rows: [`#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:0/2/0 · ${tail}`], dispatched: ["merge-bot-1=done", ...dispatched] },
    shortlist: shortlistText([]), prs: [pr(40, ["ready-to-merge"])],
  }).stdout;
  const held = tick("conflict-hold:#40", []);
  assert.match(held, /^reviewers +0\/6 → DISPATCH fix-pr PR#40 /m);
  assert.match(held, /^merge-bot {4}0\/1 → HOLD {3}\(merge-queue=1 held=1 — every queued candidate is held behind a lower PR or on a merge conflict no fix-pr has cleared\)$/m);
  const working = tick("conflict-hold:#40 · fix-pr-40", ["fix-pr-40"]);
  assert.doesNotMatch(working, /DISPATCH fix-pr/);
  assert.match(working, /^merge-bot {4}0\/1 → HOLD {3}\(merge-queue=1 held=1/m);
  const landed = tick("conflict-hold:#40 · fix-pr-40=applied:def5678", ["fix-pr-40=applied:def5678"]);
  assert.doesNotMatch(landed, /DISPATCH fix-pr/);
  assert.match(landed, /^merge-bot {4}0\/1 → DISPATCH merge-bot {3}\(merge-queue=1 held=0\)$/m);
});

test("CLI: a ledger token outside the grammar refuses the tick, printing no row", () => {
  const r = runCli([], { ledger: { rows: ["#9 impl-9=merged"] }, shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /^fleet-tick: .*impl-9.*'merged' is not an outcome/m);
});

test("CLI: a ledger ledger.mjs itself refuses is a refusal here too", (t) => {
  // Two drain markers: ledger.mjs read exits 2 on the broken invariant.
  const dir = runCli([], { shortlist: shortlistText([]), keep: true });
  t.after(() => rmSync(dir.dir, { recursive: true, force: true }));
  writeFileSync(join(dir.repo, ".fleet", "ledger.md"), `${ledgerText({ drain: "a" })}\n- b\n`);
  const r = spawnBounded(process.execPath, [join(dir.dir, "bin", "fleet-tick.mjs"), "--state", join(dir.dir, "hb.json")], {
    cwd: dir.repo,
    env: { ...process.env, PATH: `${join(dir.dir, "bin")}:${process.env.PATH}`, FIXTURE_PRS: join(dir.dir, "prs.json") },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /fleet-tick: ledger\.mjs read exited 2/);
});

test("CLI: a tier mismatch holds the implementer row until a replacement is dispatched", () => {
  const r = runCli([], { ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] }, shortlist: shortlistText([8, 9]) });
  assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\) +\(.* — dispatch impl-7-b at its row's tier\)$/m);
});

test("CLI: an implementer with no tier verdict on the ledger holds the implementer row until tier-check writes one", () => {
  const r = runCli([], { ledger: { rows: ["#7 impl-7 · class=routine"], dispatched: ["impl-7"] }, shortlist: shortlistText([8, 9]) });
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier unchecked impl-7\) +\(.* — run ~\/\.fleet\/bin\/fleet-run tier-check\.mjs --batch <file> with \[\{"member":"impl-7","session":"<session>"\}\]\)$/m);
  const ok = runCli([], {
    ledger: { rows: ["#7 impl-7 · class=routine · tier-ok=impl-7:fleet-implementer"], dispatched: ["impl-7"] },
    shortlist: shortlistText([8, 9]),
  });
  assert.match(ok.stdout, /^implementers 1\/2 → PULL #8 /m);
});

test("CLI: a lifted exclusion premise triggers a refresh even with the shortlist full", () => {
  const full = { shortlist: shortlistText([1, 2, 3]), refresh: shortlistText([1, 2, 3, 50]) };
  const standing = runCli([], { ...full, ledger: { rows: ["#50 excluded · behind-pr:#44"] }, prs: [pr(44)] });
  assert.equal(standing.refreshed, 0, "#44 is still open — the exclusion stands");
  const lifted = runCli([], { ...full, ledger: { rows: ["#50 excluded · behind-pr:#44"] }, prs: [] });
  assert.equal(lifted.refreshed, 1);
  assert.match(lifted.stdout, /REFRESHED shortlist: 4 entries; 1 lifted {3}\(behind-pr:#44 no longer open\)/);
  const issue = runCli([], { ...full, ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" } });
  assert.equal(issue.refreshed, 1);
  assert.deepEqual(issue.issueViews, ["9"]);
  const openIssue = runCli([], { ...full, ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "OPEN" } });
  assert.equal(openIssue.refreshed, 0);
  // Already back on the current file: the refresh that lifted it has run.
  const reflected = runCli([], {
    shortlist: shortlistText([1, 2, 50]), ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" },
  });
  assert.equal(reflected.refreshed, 0);
  assert.deepEqual(reflected.issueViews, [], "no probe for a premise the file already reflects");
});

test("CLI: a lifted behind-pr exclusion names its ticket in the PULL row, with no refresh needed", () => {
  const r = runCli(["--implementer-cap", "1"], {
    shortlist: shortlistText([50]), ledger: { rows: ["#50 excluded · behind-pr:#44"] }, prs: [],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "the open-PR list already proves #44 is gone — no refresh needed to know it");
  assert.match(r.stdout, /^implementers 0\/1 → PULL #50 /m);
});

test("CLI: a behind-issue exclusion already reflected in the current file names its ticket in the PULL row", () => {
  // The confirmed live bug (#1803 review): a prior tick already refreshed and
  // printed "lifted", so the file has #50 back — but the ledger's `excluded`
  // row is untouched until a Pull rewrites it. This tick gets no refresh
  // trigger at all (the file already carries #50), so the fix has to live in
  // how a claim from that stale row is read, not in another gh call.
  const r = runCli(["--implementer-cap", "3"], {
    shortlist: shortlistText([1, 2, 50]), ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "already reflected — no refresh needed to admit it");
  assert.match(r.stdout, /^implementers 0\/3 → PULL #1 #2 #50 /m);
});

// #2485: the mismatch hold is lifted by the mismatched ticket's own issue
// being CLOSED, probed live; an open one, or a probe that cannot answer, holds.
test("CLI: a tier mismatch on a CLOSED ticket no longer holds the implementer row", () => {
  const mismatch = { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] };
  const base = { shortlist: shortlistText([1, 2, 3]) };
  const closed = runCli([], { ...base, ledger: mismatch, issueStates: { 7: "CLOSED" } });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /^implementers 0\/2 → PULL #1 #2 /m);
  assert.doesNotMatch(closed.stdout, /tier mismatch/);
  assert.deepEqual(closed.issueViews, ["7"]);
  const open = runCli([], { ...base, ledger: mismatch, issueStates: { 7: "OPEN" } });
  assert.match(open.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m);
  const none = runCli([], { ...base, ledger: { rows: ["#7 impl-7 · tier-ok=impl-7:fleet-implementer"], dispatched: ["impl-7"] } });
  assert.deepEqual(none.issueViews, [], "nothing mismatched: no probe");
});

test("CLI: a failed probe of a mismatched ticket is disclosed and the hold stands", () => {
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
    issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_FAIL: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m);
  assert.match(r.stderr, /fleet-tick: gh issue view 7 exited 1: gh: issue view failed — tier mismatch on #7 unconfirmed closed, hold stands/);
});

test("CLI: a probe answering exit 0 with no issue state is disclosed and the hold stands", () => {
  for (const body of ["<html>rate limited</html>", "{}", "null"]) {
    const r = runCli([], {
      shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
      issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_BODY: body },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m, body);
    assert.match(r.stderr, /fleet-tick: gh issue view 7 printed no state — tier mismatch on #7 unconfirmed closed, hold stands/, body);
  }
});

// Only the exact string CLOSED lifts the hold: another casing, a prefix, or a
// state an issue never has (MERGED) is a state, but not a closed one.
test("CLI: a state other than exactly CLOSED leaves the mismatch hold standing", () => {
  for (const state of ["closed", "REOPENED", "MERGED", "CLOSED_AS_DUPLICATE"]) {
    const r = runCli([], {
      shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
      issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_BODY: JSON.stringify({ state }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m, state);
  }
});

// Every mismatched ticket is probed on its own: one CLOSED does not lift, and
// one failed or OPEN does not hold back, another.
test("CLI: each mismatched ticket is probed and released or held on its own issue", () => {
  const two = { rows: ["#7 impl-7=tier-mismatch", "#8 impl-8=tier-mismatch"], dispatched: ["impl-7=tier-mismatch", "impl-8=tier-mismatch"] };
  const base = { shortlist: shortlistText([1, 2, 3]), ledger: two };
  const mixed = runCli([], { ...base, issueStates: { 7: "CLOSED", 8: "OPEN" } });
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.deepEqual(mixed.issueViews, ["7", "8"]);
  assert.match(mixed.stdout, /HOLD \(tier mismatch impl-8\)/);
  assert.doesNotMatch(mixed.stdout, /impl-7/);
  const reversed = runCli([], { ...base, issueStates: { 7: "OPEN", 8: "CLOSED" } });
  assert.deepEqual(reversed.issueViews, ["7", "8"]);
  assert.match(reversed.stdout, /HOLD \(tier mismatch impl-7\)/);
  assert.doesNotMatch(reversed.stdout, /impl-8/);
  const both = runCli([], { ...base, issueStates: { 7: "CLOSED", 8: "CLOSED" } });
  assert.deepEqual(both.issueViews, ["7", "8"]);
  assert.doesNotMatch(both.stdout, /tier mismatch/);
  const failed = runCli([], { ...base, issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_FAIL: "1" } });
  assert.deepEqual(failed.issueViews, ["7", "8"], "a failed probe of #7 does not stop the probe of #8");
});

test("CLI: a failed gh issue view probe is disclosed, not silently swallowed", () => {
  const full = { shortlist: shortlistText([1, 2, 3]), refresh: shortlistText([1, 2, 3, 50]) };
  const r = runCli([], {
    ...full, ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" },
    env: { ISSUE_VIEW_FAIL: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "a failed probe cannot confirm the lift — the exclusion stands");
  assert.match(r.stderr, /fleet-tick: gh issue view 9 exited 1: gh: issue view failed — behind-issue:#9 premise unconfirmed, exclusion stands/);
});

test("CLI: the six caller-stated flags are gone — each refuses as unknown", () => {
  for (const flag of ["--implementers", "--reviewers", "--merge-bots", "--pool", "--reviews-ready", "--merge-holds"]) {
    const r = runCli([flag, "1"], { shortlist: shortlistText([]) });
    assert.equal(r.status, 2, flag);
    assert.match(r.stderr, /accepted: --implementer-cap, --reviewer-cap, --max-reviews, --fold-unchanged, --state/, flag);
    assert.equal(r.stdout.trim(), "", flag);
  }
});

test("CLI: caps must be positive integers, with no upper bound", () => {
  for (const bad of [["--implementer-cap", "0"], ["--reviewer-cap", "0"], ["--max-reviews", "0"], ["--implementer-cap=x"], ["--max-reviews="]]) {
    const r = runCli(bad, { shortlist: shortlistText([]) });
    assert.equal(r.status, 2, bad.join(" "));
    assert.equal(r.stdout.trim(), "");
  }
  const big = runCli(["--implementer-cap", "9", "--reviewer-cap", "12"], { shortlist: shortlistText([]) });
  assert.equal(big.status, 0, big.stderr);
  assert.match(big.stdout, /^implementers 0\/9 /m);
  assert.match(big.stdout, /^reviewers {4}0\/12 /m);
});

test("CLI: a failed gh read refuses — it is not an empty backlog", () => {
  const r = runCli([], { env: { PR_FAIL: "1" }, shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /gh pr list/);
});

test("CLI: a PR list at the limit refuses rather than serving a truncated one", () => {
  const r = runCli([], { prs: Array.from({ length: 200 }, (_, i) => pr(i + 1)), shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /truncated|capped/i);
});

test("CLI: a gh row missing closingIssuesReferences refuses rather than counting as no-issue", () => {
  const r = runCli([], { prs: [{ number: 1, labels: [] }], shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /closingIssuesReferences/);
});

test("CLI: a gh row missing headRefOid refuses rather than reading every past-pin halt as moved", () => {
  const { headRefOid, ...headless } = pr(1);
  const r = runCli([], { prs: [headless], shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /headRefOid/);
});

test("CLI: a gh row with no mergeable, or one outside GitHub's enum, refuses rather than reading every conflict as absent", () => {
  const { mergeable, ...unknown } = pr(1);
  const r = runCli([], { prs: [unknown], shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /mergeable/);
  const wrong = runCli([], { prs: [{ ...pr(1), mergeable: null }], shortlist: shortlistText([]) });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /mergeable/);
  for (const drifted of ["conflicting", "", "DIRTY"]) {
    const r = runCli([], { prs: [{ ...pr(1), mergeable: drifted }], shortlist: shortlistText([]) });
    assert.equal(r.status, 2, JSON.stringify(drifted));
    assert.match(r.stderr, /mergeable one of MERGEABLE, CONFLICTING, UNKNOWN/);
  }
  for (const known of ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) {
    const r = runCli([], { prs: [{ ...pr(1), mergeable: known }], shortlist: shortlistText([]) });
    assert.equal(r.status, 0, `${known}: ${r.stderr}`);
  }
});

test("CLI: a tracked PR GitHub reads CONFLICTING prints CONFLICT on the reviewers role, off the one gh pr list it already makes", (t) => {
  const logDir = mkdtempSync(join(tmpdir(), "fleet-tick-prlist-"));
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const log = join(logDir, "pr-list.log");
  const r = runCli([], {
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:0/0/0"] },
    shortlist: shortlistText([]), prs: [pr(40, [], [10], HEAD_B, "CONFLICTING"), pr(41, [], [], HEAD_B, "UNKNOWN")],
    env: { PR_LIST_LOG: log },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers {4}0\/6 → CONFLICT PR#40 +\(.* — .*ledger\.mjs row <key> "<text> · conflict-hold:#40 \(conflict: mergeable=CONFLICTING\)".*\)$/m);
  assert.doesNotMatch(r.stdout, /PR#41/);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1, "no extra gh call");
  assert.match(calls[0], /--json \S*\bmergeable\b/);
});

test("CLI: a past-pin halt prints DISPATCH review for its PR (#2083)", () => {
  const r = runCli([], {
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0 · finisher-pr-40=halted:past-pin"] },
    shortlist: shortlistText([]), prs: [pr(40, [], [10], HEAD_B)],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers {4}0\/6 → DISPATCH review PR#40 /m);
});

test("CLI: an ambient GIT_DIR naming another repository cannot move the shortlist read", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  mkdirSync(join(decoy, ".fleet"));
  writeFileSync(join(decoy, ".fleet", "shortlist.json"), shortlistText([666]));
  const r = runCli([], { shortlist: shortlistText([7, 8]), env: { GIT_DIR: join(decoy, ".git") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → PULL #7 #8 /m);
});

// A missing shortlist is also what an empty queue looks like, so a workspace
// the tick could not resolve has to say so — once, not once per retry — or an
// operator watching a stalled run cannot tell "outside a repository" from "no
// candidates yet". The git shim answers every call but the workspace probe,
// and lands after the baseline so the record itself still resolves.
test("CLI: a workspace the tick cannot resolve is announced once, and the shortlist reads as missing", () => {
  const realGit = spawnBounded("sh", ["-c", "command -v git"]).stdout.trim();
  assert.ok(realGit, "test setup: no git on PATH to wrap");
  const r = runCli([], {
    shortlist: shortlistText([7, 8]),
    afterBaseline: (repo) => writeExecStub(join(repo, "..", "bin", "git"), [
      "#!/bin/sh",
      `[ "$1 $2" = "rev-parse --git-common-dir" ] && { echo "fatal: simulated unresolvable workspace" >&2; exit 128; }`,
      `exec '${realGit}' "$@"`,
    ].join("\n") + "\n"),
  });
  const warnings = r.stderr.split("\n").filter((l) => l.startsWith("fleet-tick: WARNING could not resolve --git-common-dir"));
  assert.deepEqual(warnings, ["fleet-tick: WARNING could not resolve --git-common-dir: fatal: simulated unresolvable workspace; reading the shortlist as missing"],
    `expected exactly one warning naming git's reason: ${r.stderr}`);
  assert.equal(r.refreshed, 1, "a missing shortlist must still trigger the refresh");
  assert.doesNotMatch(r.stdout, /PULL #7 #8/, "the shortlist on disk was unreachable, so its entries must not be pulled");
});

test("CLI: an inherited GIT_DIR cannot retarget the tier-mismatch closed-ticket probe", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-tier-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
    issueStates: { 7: "OPEN" }, env: { GIT_DIR: join(decoy, ".git"), GH_REPO: "someone/else" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.issueViews, ["7"], "the probe must still run");
  assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m, "#7 is OPEN in the case's own repository - the hold stands");
});

test("CLI: an inherited GIT_DIR cannot retarget the behind-issue premise probe", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-gh-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "OPEN" },
    env: { GIT_DIR: join(decoy, ".git"), GH_REPO: "someone/else" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.issueViews, ["9"], "the probe must still run");
  assert.equal(r.refreshed, 0, "#9 is OPEN in the case's own repository — the exclusion stands");
});

// A review whose `reviewed=` write never landed stays in flight in the ledger
// after its PR merges. Each such row holds one reviewer slot unless the tick
// asks gh about the PR and finds it finished.
const zombieRows = (numbers) => numbers.map((n) => `#${n - 90} impl-${n - 90}=PR#${n} → PR#${n} · review=member:review-pr-${n}`);
const ZOMBIES = Array.from({ length: 10 }, (_, i) => 101 + i);
const REVIEW_DUE = pr(500, [], [1500], HEAD_B);
const CAPS = ["--reviewer-cap", "10", "--max-reviews", "10"];

test("CLI: dangling in-flight reviews of merged PRs do not starve review dispatch", () => {
  const r = runCli(CAPS, {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows(ZOMBIES) },
    prStates: Object.fromEntries(ZOMBIES.map((n) => [n, "MERGED"])),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews.map(Number).sort((a, b) => a - b), ZOMBIES, "each off-list PR is asked about");
  assert.match(r.stdout, /^reviewers +0\/10 → DISPATCH review PR#500/m);
});

test("CLI: a CLOSED PR's dangling review is released too", () => {
  const r = runCli(["--reviewer-cap", "1", "--max-reviews", "1"], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "CLOSED" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers +0\/1 → DISPATCH review PR#500/m);
});

test("CLI: an in-flight review on an open PR keeps its slot and is never probed", () => {
  const r = runCli(["--reviewer-cap", "1", "--max-reviews", "1"], {
    shortlist: shortlistText([]), prs: [pr(101, [], [1101]), REVIEW_DUE], ledger: { rows: zombieRows([101]) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews, [], "an open PR needs no probe");
  assert.match(r.stdout, /^reviewers +1\/1 → AT CAP/m);
  assert.doesNotMatch(r.stdout, /DISPATCH review/);
});

test("CLI: a PR off the open list that gh still calls OPEN keeps its review's slot", () => {
  const r = runCli(["--reviewer-cap", "1", "--max-reviews", "1"], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "OPEN" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews, ["101"]);
  assert.match(r.stdout, /^reviewers +1\/1 → AT CAP/m);
  assert.doesNotMatch(r.stdout, /DISPATCH review/);
});

test("CLI: a PR gh cannot answer for is not read as merged - the slot is held and the failure disclosed", () => {
  const cases = [
    ["a nonzero exit", { PR_VIEW_FAIL: "1" }, /gh pr view 101 exited 1: gh: pr view failed/],
    ["a reply with no state", { PR_VIEW_BODY: "<html>proxy error</html>" }, /gh pr view 101 printed no PR state/],
    ["a state that is not MERGED or CLOSED", { PR_VIEW_BODY: JSON.stringify({ state: "merged" }) }, /gh pr view 101 printed no PR state/],
  ];
  for (const [what, env, shown] of cases) {
    const r = runCli(["--reviewer-cap", "1", "--max-reviews", "1"], {
      shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "MERGED" }, env,
    });
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.match(r.stderr, shown, what);
    assert.match(r.stdout, /^reviewers +1\/1 → AT CAP/m, what);
    assert.doesNotMatch(r.stdout, /DISPATCH review/, what);
  }
});

test("CLI: an inherited GIT_DIR cannot retarget the merged-PR review probe", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-pr-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  const r = runCli(["--reviewer-cap", "1", "--max-reviews", "1"], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "OPEN" },
    env: { GIT_DIR: join(decoy, ".git"), GH_REPO: "someone/else" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews, ["101"], "the probe must still run");
  assert.match(r.stdout, /^reviewers +1\/1 → AT CAP/m, "101 is OPEN in the case's own repository - its review keeps the slot");
});

// #2210, end to end: a real repo, a real baseline, a real stray write.
const LIVE = {
  ledger: { rows: ["#412 impl-412 · tier-ok=impl-412:fleet-implementer"], dispatched: ["impl-412"] },
  shortlist: shortlistText([412, 420, 421]),
};
// One more tick over a kept runCli fixture, as the next wake would run it.
const tickAgain = (r) => spawnBounded(process.execPath, [join(r.dir, "bin", "fleet-tick.mjs"), "--state", join(r.dir, "hb.json")], {
  cwd: r.repo,
  env: { ...process.env, PATH: `${join(r.dir, "bin")}:${process.env.PATH}`, FIXTURE_PRS: join(r.dir, "prs.json") },
});

test("CLI: a stray write after the baseline prints MAIN-CHECKOUT-DIRTY first, naming the path and the live members, and holds every dispatching row", (t) => {
  const r = runCli([], {
    ...LIVE, prs: [pr(350)], keep: true,
    afterBaseline: (repo) => writeFileSync(join(repo, "stray.mjs"), "x\n"),
  });
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^MAIN-CHECKOUT-DIRTY stray\.mjs — changed since the run's baseline; live members: impl-412 — dispatch held: resolve the stray paths FIRST, then re-baseline with ~\/\.fleet\/bin\/fleet-run main-checkout\.mjs --record/);
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(main checkout dirty\)/m);
  assert.match(r.stdout, /^reviewers +0\/6 → HOLD \(main checkout dirty\)/m);
  assert.match(r.stdout, /^merge-bot +0\/1 → HOLD \(main checkout dirty\)/m);
  assert.doesNotMatch(r.stdout, /PULL|DISPATCH/);

  // Not a one-tick warning: the next tick holds the same way, and only an
  // explicit re-baseline after the path is resolved lets dispatch through.
  assert.match(tickAgain(r).stdout, /^MAIN-CHECKOUT-DIRTY stray\.mjs /m);
  rmSync(join(r.repo, "stray.mjs"));
  const rec = spawnBounded(process.execPath, [join(r.dir, "bin", "main-checkout.mjs"), "--record"], { cwd: r.repo });
  assert.equal(rec.status, 0, rec.stderr);
  const after = tickAgain(r);
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stdout, /MAIN-CHECKOUT|main checkout/);
  assert.match(after.stdout, /^implementers 1\/2 → PULL #420 /m);
});

test("CLI: uncommitted work in the main checkout at run start does not hold the run", () => {
  const r = runCli([], {
    ...LIVE,
    beforeRun: (repo) => writeFileSync(join(repo, "my-notes.md"), "the maintainer's own\n"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /MAIN-CHECKOUT|main checkout/);
  assert.match(r.stdout, /^implementers 1\/2 → PULL #420 /m);
});

test("CLI: a run that never recorded a baseline is held, never read as clean", () => {
  const r = runCli([], { ...LIVE, baseline: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^MAIN-CHECKOUT-NO-BASELINE no baseline at .*\.fleet\/main-checkout\.sha — dispatch held: record it at run start with /);
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(main checkout no baseline\)/m);
});

test("CLI: a main checkout git cannot read is MAIN-CHECKOUT-UNKNOWN and held, never clean", () => {
  const r = runCli([], {
    ...LIVE,
    afterBaseline: (repo) => writeFileSync(join(repo, ".git", "index"), "not an index"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^MAIN-CHECKOUT-UNKNOWN could not look: git status --porcelain -uall exited \d+.*; live members: impl-412 — .*NEVER re-baseline over it/);
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(main checkout unknown\)/m);
});

// #2307: a folded tick under a dirty or unknown hold still names the hold, and
// the hold stays non-actionable — `quiet` rises on every tick, the fold fires.
// Three `--fold-unchanged` ticks over one kept fixture and one state file.
const foldTicks = (fixture) => {
  const first = runCli(["--fold-unchanged"], { ...fixture, keep: true });
  try {
    const state = join(first.dir, "heartbeat.json");
    const quiet = () => JSON.parse(readFileSync(state, "utf8")).quiet;
    const ticks = [{ stdout: first.stdout, status: first.status, stderr: first.stderr, quiet: quiet() }];
    for (let i = 0; i < 2; i++) {
      const t = spawnBounded(process.execPath, [join(first.dir, "bin", "fleet-tick.mjs"), "--fold-unchanged", "--state", state], {
        cwd: first.repo,
        env: {
          ...process.env, PATH: `${join(first.dir, "bin")}:${process.env.PATH}`,
          FIXTURE_PRS: join(first.dir, "prs.json"), FIXTURE_CLAIMED: join(first.dir, "claimed.json"),
          FIXTURE_ISSUE_STATES: join(first.dir, "issue-states.json"), FIXTURE_REFRESH: join(first.dir, "refresh.json"),
          REFRESH_LOG: join(first.dir, "refresh.log"), ISSUE_VIEW_LOG: join(first.dir, "issue-view.log"),
        },
      });
      ticks.push({ stdout: t.stdout, status: t.status, stderr: t.stderr, quiet: quiet() });
    }
    return ticks;
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
  }
};

// foldTicks keeps its fixture across three ticks, so a throw after the first
// run (here: `heartbeat.json` is a directory, so reading the state fails)
// must still remove the dir — the caller never gets it back.
test("CLI: foldTicks removes its kept fixture dir when a tick throws", () => {
  let dir;
  assert.throws(() => foldTicks({
    ...LIVE,
    afterBaseline: (repo) => { dir = join(repo, ".."); mkdirSync(join(dir, "heartbeat.json")); },
  }), /EISDIR/);
  assert.ok(dir, "afterBaseline never ran, so the throw happened before the dir existed");
  assert.equal(existsSync(dir), false);
});

for (const [state, afterBaseline] of [
  ["dirty", (repo) => writeFileSync(join(repo, "stray.mjs"), "x\n")],
  ["unknown", (repo) => writeFileSync(join(repo, ".git", "index"), "not an index")],
]) {
  test(`CLI: --fold-unchanged under a ${state} main checkout folds to one line naming the hold, quiet rising every tick`, () => {
    const ticks = foldTicks({ ...LIVE, afterBaseline });
    for (const t of ticks) assert.equal(t.status, 0, t.stderr);
    assert.match(ticks[0].stdout, new RegExp(`^implementers 1/2 → HOLD \\(main checkout ${state}\\)`, "m"));
    assert.deepEqual(ticks.map((t) => t.quiet), [1, 2, 3]);
    for (const [i, t] of ticks.slice(1).entries()) {
      assert.deepEqual(t.stdout.trim().split("\n"), [
        `fleet-tick: unchanged, nothing to act on (quiet=${i + 2}); HOLD (main checkout ${state}) persists — full rows on the next change`,
      ]);
    }
  });
}

test("CLI: --fold-unchanged never folds a missing-baseline hold — it asks the controller to act", () => {
  const ticks = foldTicks({ ...LIVE, baseline: false });
  for (const t of ticks) {
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^MAIN-CHECKOUT-NO-BASELINE /);
    assert.match(t.stdout, /^implementers 1\/2 → HOLD \(main checkout no baseline\)/m);
    assert.doesNotMatch(t.stdout, /nothing to act on/);
    assert.equal(t.quiet, 0);
  }
  assert.equal(ticks[2].stdout, ticks[1].stdout);
});

test("CLI: an in-flight review with no member token is named as review:PR#<n> on the MAIN-CHECKOUT line", () => {
  const r = runCli([], {
    ledger: { rows: ["#51 review=wf:x"] }, shortlist: shortlistText([]), prs: [pr(51)],
    afterBaseline: (repo) => writeFileSync(join(repo, "stray.mjs"), "x\n"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^MAIN-CHECKOUT-DIRTY stray\.mjs — changed since the run's baseline; live members: review:PR#51 — /m);
});

test("CLI: an ambient GIT_DIR naming a dirty repository does not move the main-checkout check", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-mc-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  writeFileSync(join(decoy, "decoy-stray.txt"), "x\n");
  const r = runCli([], { ...LIVE, env: { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /MAIN-CHECKOUT/);
  assert.match(r.stdout, /^implementers 1\/2 → PULL #420 /m);
});

// ---------------------------------------------------------------------------
// The heartbeat's half - #357. The tick is the only writer of the back-off
// streak and the fold digest, so these pin the contract fleet-heartbeat.mjs
// reads rather than the heartbeat's own arithmetic (that is its test's job).

const IDLE = { shortlist: shortlistText([]), refresh: shortlistText([]) };

test("CLI: the quiet streak lengthens on an idle tick and resets on an actionable one", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-state-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  runCli(["--state", path], IDLE);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 1);
  runCli(["--state", path], IDLE);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 2);
  runCli(["--state", path], { ...IDLE, shortlist: shortlistText([9]) });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
});

test("CLI: --fold-unchanged folds a repeated idle tick to one line", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const first = runCli(["--fold-unchanged", "--state", path], IDLE);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.trim().split("\n").length >= 3);
  const second = runCli(["--fold-unchanged", "--state", path], IDLE);
  assert.deepEqual(second.stdout.trim().split("\n"), ["fleet-tick: unchanged, nothing to act on (quiet=2) — full rows on the next change"]);
});

test("CLI: --fold-unchanged never folds an actionable tick, even an identical one", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-act-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const busy = { shortlist: shortlistText([9, 10]) };
  const first = runCli(["--fold-unchanged", "--state", path], busy);
  const second = runCli(["--fold-unchanged", "--state", path], busy);
  assert.equal(second.stdout, first.stdout);
  assert.match(second.stdout, /PULL #9 #10/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
});

test("CLI: --fold-unchanged does not fold when the rows change, even with nothing to act on", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-differs-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  runCli(["--fold-unchanged", "--state", path], IDLE);
  // A queued candidate, held behind a lower PR: still nothing to act on.
  const held = {
    ...IDLE, ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · held-behind:#38 · tier-ok=impl-10:fleet-implementer"] },
    prs: [pr(38, [], []), pr(40, ["ready-to-merge"])],
  };
  const second = runCli(["--fold-unchanged", "--state", path], held);
  assert.match(second.stdout, /^merge-bot {4}0\/1 → HOLD\b/m);
  assert.doesNotMatch(second.stdout, /nothing to act on/);
  const third = runCli(["--fold-unchanged", "--state", path], held);
  assert.match(third.stdout, /^fleet-tick: unchanged, nothing to act on \(quiet=3\)/);
});

test("CLI: with no --state, the tick resolves the run's shared default", (t) => {
  const r = runCli([], { ...IDLE, defaultState: true, keep: true });
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const state = join(r.repo, ".fleet", "heartbeat.json");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.ok(existsSync(state));
  assert.equal(JSON.parse(readFileSync(state, "utf8")).quiet, 1);
});

// The prior run's liveness - #1597.
const beat = (ms, interval, stopped = "") =>
  JSON.stringify({ quiet: 0, elapsed: 0, digest: "", beat: { at: Date.now() - ms, interval, stopped } });

test("CLI: a stale prior beat is reported, and reported FIRST, with the stranded claims and the supply", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { shortlist: shortlistText([9], 1), claimed: [{ number: 41 }, { number: 42 }, { number: 43 }] });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^heartbeat STALLED/);
  assert.match(lines[1], /^implementers/);
  assert.match(lines[0], /3 ticket\(s\) claimed and in flight/);
  assert.match(lines[0], /pool supply 1/);
});

test("CLI: an unreadable shortlist makes the stall report's supply unknown, never zero", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-supply-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { shortlist: "{" });
  assert.match(r.stdout.split("\n")[0], /pool supply unknown/);
});

test("CLI: the stall is announced even when the reconcile then refuses", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-refuse-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { ...IDLE, claimed: [{ number: 41 }], env: { PR_FAIL: "1" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gh pr list failed/);
  assert.match(r.stdout, /heartbeat STALLED/);
});

test("CLI: an unreadable claim count is `unknown`, never zero", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-unknown-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { ...IDLE, env: { CLAIMED_FAIL: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unknown ticket\(s\) claimed and in flight/);
  assert.match(r.stderr, /claimed ticket count unknown/);
  assert.match(r.stderr, /boom/);
});

// The claimed-count query is capped at CLAIMED_LIMIT (200). At exactly the cap
// the list may be truncated, so the report must say the count is a floor
// (`200+`); one below the cap it is exact and must carry no `+`. The stub
// answers `--jq length` over the fixture array, so the array's size is the
// count the tick reads. #1760.
// Mutation-checked both ways against claimed()'s truncation branch: making it
// `return n;` reds the 200 case ("…; 200 ticket(s) claimed and in flight…"
// did not match /; 200\+ ticket/), and making it always return `${n}+` reds the
// 199 case ("…; 199+ ticket(s) claimed and in flight…" did not match
// /; 199 ticket/). The literal `199 ticket(s)` adjacency — no `+` allowed
// between the digits and the space — is what refuses `199+`; the `; ` prefix
// only anchors the match to the claimed-count field.
test("CLI: a claim count AT the query cap is disclosed as a floor (`200+`); one below it is exact", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-cap-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const stalled = (count) => {
    // Re-staled every call: each run records its own tick in the state file.
    writeFileSync(path, beat(90 * 60_000, 1200));
    const claimed = Array.from({ length: count }, (_, i) => ({ number: i + 1 }));
    const r = runCli(["--state", path], { ...IDLE, claimed });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split("\n")[0];
    assert.match(line, /^heartbeat STALLED/);
    return line;
  };
  assert.match(stalled(200), /; 200\+ ticket\(s\) claimed and in flight/);
  assert.match(stalled(199), /; 199 ticket\(s\) claimed and in flight/);
});

test("CLI: a beat within the interval it promised is not reported at all", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-quiet-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(20 * 60_000, 1200));
  assert.doesNotMatch(runCli(["--state", path], IDLE).stdout, /STALLED/);
  writeFileSync(path, beat(20 * 60_000, 300));
  assert.match(runCli(["--state", path], IDLE).stdout, /STALLED/);
});

test("CLI: the streak write carries the heartbeat's mark instead of erasing it, and writes its own", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-mark-carry-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const mark = { at: Date.now() - 60_000, interval: 300, stopped: "" };
  writeFileSync(path, JSON.stringify({ quiet: 3, elapsed: 7, digest: "old", beat: mark }));
  const r = runCli(["--state", path], IDLE);
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(after.beat, mark);
  assert.equal(after.quiet, 4);
  assert.ok(after.ticked && after.ticked.at >= Date.now() - 5000);
});

test("CLI: a deliberate stop is reported with its reason, and a run that never beat says nothing", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stopped-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(6 * 60_000, 300, "context ceiling reached"));
  const r = runCli(["--state", path], IDLE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopped deliberately — recorded reason: context ceiling reached/);
  assert.doesNotMatch(r.stdout, /without a recorded reason/);
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "" }));
  assert.doesNotMatch(runCli(["--state", path], IDLE).stdout, /STALLED/);
});

test("CLI: a busy, fully-staffed fleet is not reported STALLED just because the queue never drained", (t) => {
  // `beat` refreshes only when the queue drains; a tick two minutes ago on a
  // completion edge is what tells a busy run from a dead one.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-busy-not-stalled-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({
    quiet: 0, elapsed: 0, digest: "",
    beat: { at: Date.now() - 11 * 60_000, interval: 300, stopped: "" },
    ticked: { at: Date.now() - 2 * 60_000 },
  }));
  const r = runCli(["--state", path], {
    ledger: { rows: ["#1 impl-1 · tier-ok=impl-1:fleet-implementer", "#2 impl-2 · tier-ok=impl-2:fleet-implementer"], dispatched: ["impl-1", "impl-2"] },
    shortlist: shortlistText([3, 4, 5]), claimed: [{ number: 41 }],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /STALLED/);
  assert.match(r.stdout, /^implementers 2\/2 → AT CAP/m);
});

// The Stall report names which kind of stall it sees, off the controller
// record rotate leaves in the same file. The process tree comes from a
// FLEET_PROC_TABLE fixture, never `ps`: this suite runs under live omp
// sessions, whose omp a real walk would find. The tick's parent is this
// runner, so the table's walk starts at process.pid.
import { spawn } from "node:child_process";

const TABLE_OMP = 2_000_000_001;
const procTable = (dir, extra = {}) => {
  const path = join(dir, "proc-table.json");
  writeFileSync(path, JSON.stringify({
    [process.pid]: { ppid: TABLE_OMP, argv: [process.execPath, "--test"], lstart: "runner-start" },
    [TABLE_OMP]: { ppid: 1, argv: ["bun", "/home/u/.bun/bin/omp"], lstart: "omp-start" },
    ...extra,
  }));
  return path;
};
// A live process that is no ancestor of the tick, and a pid whose process has
// exited and been reaped.
const liveForeign = (t) => {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  return child.pid;
};
const deadPid = () => spawnBounded(process.execPath, ["-e", ""]).pid;
// A beat 90 minutes old against a 20-minute promise, and a record written
// `recordAgoMs` ago: older than the beat is a record this run's own beat
// followed (a later tick), newer is a record rotate wrote after the previous
// run's last beat (the run's first tick).
const STALL_AGO = 90 * 60_000;
const stalledState = (controller) => JSON.stringify({
  quiet: 0, elapsed: 0, digest: "",
  beat: { at: Date.now() - STALL_AGO, interval: 1200, stopped: "" },
  ...(controller ? { controller } : {}),
});
const LATER = () => Date.now() - STALL_AGO - 60_000;
const FIRST = () => Date.now() - 1_000;
const stallLine = (t, controller, table = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-owner-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, stalledState(controller));
  const tableFile = table === null ? join(dir, "no-such-table.json") : procTable(dir, table);
  const r = runCli(["--state", path], { ...IDLE, claimed: [{ number: 41 }], env: { FLEET_PROC_TABLE: tableFile } });
  assert.equal(r.status, 0, r.stderr);
  return { line: r.stdout.split("\n")[0], stderr: r.stderr };
};
const TAIL = /; 1 ticket\(s\) claimed and in flight, pool supply \S+/;

test("CLI: Stall report, recorded controller alive with a matching start time — not beating, controller alive (pid N); a later tick reads the record, never prior", (t) => {
  const foreign = liveForeign(t);
  const table = { [foreign]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  // `prior: dead` on both: a later tick that read prior would say gone.
  for (const [pid, lstart] of [[foreign, "foreign-start"], [process.pid, "runner-start"]]) {
    const { line } = stallLine(t, { pid, lstart, prior: "dead", at: LATER() }, table);
    assert.match(line, new RegExp(`^heartbeat not beating, controller alive \\(pid ${pid}\\): last beat `));
    assert.match(line, TAIL);
    assert.doesNotMatch(line, /STALLED|resumes/);
  }
});

test("CLI: Stall report, recorded controller dead or its start time mismatched — stalled, controller gone, and the next run resumes its claims", (t) => {
  const foreign = liveForeign(t);
  const table = { [foreign]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  for (const [pid, lstart] of [[deadPid(), "whatever"], [foreign, "an earlier process"]]) {
    // `prior: ancestor`: a later tick that read prior would say alive.
    const { line } = stallLine(t, { pid, lstart, prior: "ancestor", at: LATER() }, table);
    assert.match(line, /^heartbeat STALLED, controller gone: last beat /);
    assert.match(line, /; the next run resumes its claims without a PR, and its open PRs return through the fold-in$/);
    assert.match(line, TAIL);
  }
});

test("CLI: Stall report with no controller record keeps today's wording", (t) => {
  const { line } = stallLine(t, null);
  assert.match(line, /^heartbeat STALLED: last beat .* — the beat stopped without a recorded reason; 1 ticket\(s\) claimed and in flight, pool supply \S+$/);
  assert.doesNotMatch(line, /controller|resumes/);
});

test("CLI: a run's first tick reports the previous run's stall off the record's prior — dead, ancestor, none — never off the record itself", (t) => {
  // The record names this runner, a live ancestor of the tick: judged, it
  // would read alive every time.
  const ours = (prior) => ({ pid: process.pid, lstart: "runner-start", prior, at: FIRST() });
  const dead = stallLine(t, ours("dead")).line;
  assert.match(dead, /^heartbeat STALLED, controller gone: last beat /);
  assert.match(dead, /; this run resumes its claims without a PR, and its open PRs return through the fold-in$/);
  const ancestor = stallLine(t, ours("ancestor")).line;
  assert.match(ancestor, /^heartbeat not beating, controller alive \(this session's earlier run\): last beat /);
  assert.doesNotMatch(ancestor, /resumes/);
  const none = stallLine(t, ours("none")).line;
  assert.match(none, /^heartbeat STALLED: last beat /);
  assert.doesNotMatch(none, /controller|resumes/);
});

test("CLI: a record whose controller cannot be judged keeps today's wording and says why on stderr", (t) => {
  const { line, stderr } = stallLine(t, { pid: process.pid, lstart: "runner-start", prior: "dead", at: LATER() }, null);
  assert.match(line, /^heartbeat STALLED: last beat /);
  assert.doesNotMatch(line, /controller/);
  assert.match(stderr, /cannot be judged/);
});

// Every gh spawn in the tick carries a bound: a gh that never answers is a
// failed read on that call's own failure path, never a tick that hangs. Each
// case stalls one gh call for 30s under a 1s override, so a spawn that lost its
// bound waits the stall out, reads the stub's normal reply, and fails the
// assertions on the disclosed timeout — inside spawnBounded's own backstop.
import { ghBudget } from "../plugin/scripts/fleet-tick.mjs";

const hang = (call, seconds = "30", budget = "1") => ({ GH_HANG: call, GH_HANG_S: seconds, FLEET_TICK_GH_TIMEOUT: budget });

test("CLI: a hung gh pr list refuses the tick at the bound — a read that timed out is not an empty queue", () => {
  const r = runCli([], { shortlist: shortlistText([]), env: hang("pr list") });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /gh pr list failed: timed out after 1s — a failed read is not an empty queue/);
});

test("CLI: a hung probe of a mismatched ticket is disclosed at the bound and the hold stands", () => {
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
    issueStates: { 7: "CLOSED" }, env: hang("issue view"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m);
  assert.match(r.stderr, /fleet-tick: gh issue view 7 timed out after 1s — tier mismatch on #7 unconfirmed closed, hold stands/);
});

test("CLI: a hung behind-issue probe is disclosed at the bound and the exclusion stands", () => {
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), refresh: shortlistText([1, 2, 3, 50]),
    ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" }, env: hang("issue view"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "a probe that timed out cannot confirm the lift");
  assert.match(r.stderr, /fleet-tick: gh issue view 9 timed out after 1s — behind-issue:#9 premise unconfirmed, exclusion stands/);
});

test("CLI: a hung probe of a PR off the open list is disclosed at the bound and its review keeps the slot", () => {
  const r = runCli(["--reviewer-cap", "1", "--max-reviews", "1"], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "MERGED" },
    env: hang("pr view"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /fleet-tick: gh pr view 101 timed out after 1s — review on PR#101 unconfirmed finished, its slot stands/);
  assert.match(r.stdout, /^reviewers +1\/1 → AT CAP/m);
});

test("CLI: a hung claimed-count read makes the stall report's count unknown at the bound", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-hung-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { ...IDLE, claimed: [{ number: 41 }], env: hang("issue list") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unknown ticket\(s\) claimed and in flight/);
  assert.match(r.stderr, /fleet-tick: gh timed out after 1s — claimed ticket count unknown/);
});

// The one case that proves the DEFAULT is a bound, and pays it in full: an
// override past the default is refused, so the hang is cut at 20s rather than
// waited out at 40s.
test("CLI: FLEET_TICK_GH_TIMEOUT cannot lengthen the default bound", () => {
  const r = runCli([], { shortlist: shortlistText([]), env: hang("pr list", "40", "600") });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /gh pr list failed: timed out after 20s/);
});

// What the bound must ACCEPT: a gh that answers slowly, inside the bound, is a
// normal read, not a failure.
test("CLI: a slow gh that answers inside the bound is read as usual", () => {
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
    issueStates: { 7: "CLOSED" }, env: hang("issue view", "2", "10"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /timed out/);
  assert.deepEqual(r.issueViews, ["7"]);
  assert.match(r.stdout, /^implementers 0\/2 → PULL #1 #2 /m, "the slow CLOSED answer was read and lifted the hold");
});

// The cases above pin the gh spawns the tick has today; this pins the next
// one, on the script's code with its comments blanked. Every call through
// spawnSync or execFileSync that does not name process.execPath or git must
// pass the shared bound — as `timeout: GH_TIMEOUT_MS` closed by a comma or a
// brace, never a longer expression — before its call closes. A gh spawned
// through any other function must name child_process again, and the import pin
// fails on every line that does.
test("CLI: every gh spawn in fleet-tick.mjs passes the shared bound", () => {
  const code = readFileSync(SCRIPT, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
  assert.deepEqual(code.split("\n").map((l) => l.trimEnd()).filter((l) => l.includes("child_process")),
    ['import { execFileSync, spawnSync } from "node:child_process";'],
    "the script spawns through something new — extend this sweep to it");
  const lineOf = (i) => code.slice(0, i).split("\n").length;
  const calls = [...code.matchAll(/\b(?:spawnSync|execFileSync)\(\s*(?=\S)(?!process\.execPath\b|["']git["'])/g)];
  assert.ok(calls.length > 0, "no gh spawn found; this sweep has nothing to measure");
  const unbounded = calls
    .filter((m) => !/\btimeout:\s*GH_TIMEOUT_MS\s*[,}]/.test(code.slice(m.index, code.indexOf(");", m.index))))
    .map((m) => `line ${lineOf(m.index)}`);
  assert.deepEqual(unbounded, []);
});

test("ghBudget: the override only ever shortens, and anything but digits leaves the default", () => {
  const cases = [
    [undefined, 20_000], ["", 20_000], ["5", 5_000], ["1", 1_000], ["19", 19_000],
    ["20", 20_000], ["600", 20_000], ["0", 20_000], ["-1", 20_000], ["3.5", 20_000], ["1e1", 20_000], [" 5", 20_000], ["abc", 20_000],
  ];
  for (const [override, ms] of cases) assert.equal(ghBudget(20, override), ms, JSON.stringify(override));
});
