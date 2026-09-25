// Regression gate for the reconcile tick. Zero deps:
//   node --test plugin/scripts/fleet-tick.test.mjs
//
// The pure half locks the guard table and the ledger reading — the whole point
// of #3 is that the table stops being prose the controller must remember, and
// the whole point of #1803 is that the counts stop being numbers the controller
// recites. A "simplification" that drops a row, or a reading that counts a
// settled member live, has to go red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, formatLines, actionable, deriveRun, parseShortlist, unclaimed, refreshWhy } from "./fleet-tick.mjs";

// Every field named, so a test that cares about one number still states the
// rest — a defaulted field is a guard nobody is pinning.
const state = (over = {}) => ({
  implCap: 2, reviewerCap: 6, maxReviews: 6,
  implLive: 0, draining: null, tierMismatch: [],
  heads: [], supply: 0, shortlistStatus: "ok", refresh: null,
  reviewsLive: 0, fixLive: 0, fixDue: [], reviewDue: [],
  mergeBotLive: 0, mergeQueue: 0, mergeHeld: 0,
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
  for (const over of [{}, { implLive: 2 }, { tierMismatch: ["impl-4"] }, { reviewDue: [1], fixLive: 6 }]) {
    const r = row(state({ heads: [7], draining: "maintainer asked", ...over }), "implementers");
    assert.equal(r.action, "HOLD (draining)", JSON.stringify(over));
    assert.equal(r.acts, false);
  }
});

test("implementers: a tier mismatch holds the row, names the member, and asks the controller to act", () => {
  const r = row(state({ heads: [7], tierMismatch: ["impl-412"] }), "implementers");
  assert.equal(r.action, "HOLD (tier mismatch impl-412)");
  assert.equal(r.acts, true, "the controller fixes a mismatch unattended — backing off on it is a stall");
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
// Reading the run: deriveRun() over `ledger.mjs read`'s payload and the open
// PR list. Rows are spelled the way ledger.mjs dispatch/settle write them.

const pr = (number, labels = [], closes = [number + 1000]) => ({
  number, labels: labels.map((name) => ({ name })),
  closingIssuesReferences: closes.map((n) => ({ number: n })),
});
const run = (ledger, prs = []) => deriveRun({ rows: [], dispatched: [], drain: null, ...ledger }, prs);

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

test("deriveRun: fix-pr is due on a returned review with survivors and no fix-applier since", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#20 → PR#20 · review=wf:a reviewed=abc1234:2/0/0",
      "#11 impl-11=PR#21 → PR#21 · review=wf:b reviewed=abc1234:0/3/1",
      "#12 impl-12=PR#22 → PR#22 · review=wf:c reviewed=abc1234:1/0/0 · fix-pr-22=applied:def5678",
      // Re-reviewed after its fix, and the second review found more.
      "#13 impl-13=PR#23 → PR#23 · review=wf:d reviewed=abc1234:1/0/0 · fix-pr-23=applied:def5678 review=wf:e reviewed=def5678:1/0/0",
      // A closed PR is nobody's work.
      "#14 impl-14=PR#24 → PR#24 · review=wf:f reviewed=abc1234:4/0/0",
    ],
    dispatched: ["fix-pr-22=applied:def5678", "fix-pr-23=applied:def5678"],
  }, [pr(20), pr(21), pr(22), pr(23)]);
  assert.deepEqual(r.fixDue, [20, 23]);
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

test("deriveRun: excluded rows claim their ticket and carry their premises", () => {
  const r = run({ rows: ["#50 excluded · behind-pr:#44", "#51 excluded · behind-issue:#9 behind-pr:feat/x"] });
  assert.ok(r.claimed.has(50) && r.claimed.has(51));
  assert.deepEqual(r.excluded, [
    { n: 50, premises: [{ kind: "pr", target: "44" }] },
    { n: 51, premises: [{ kind: "issue", target: "9" }, { kind: "pr", target: "feat/x" }] },
  ]);
});

test("deriveRun: the row text it does not own is accepted as it stands", () => {
  // The accept side of every refusal below: freeform row text, the arrow, the
  // board's own tokens and an empty ledger are the ordinary case.
  assert.doesNotThrow(() => run({
    rows: ["#324 impl-324=PR#346 → PR#346 · fix-pr-346=no-op · ruled:6-applies · ci=123:1:success · ports=16324 · tier=alt"],
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
  ]) {
    assert.throws(() => run(ledger), why, what);
  }
});

test("unclaimed: shortlist entries with no impl- or excluded row, in the file's order", () => {
  const r = run({ rows: ["#2 impl-2", "#4 excluded · behind-pr:#1", "#5 impl-5=bailed"] });
  assert.deepEqual(unclaimed([1, 2, 3, 4, 5, 6].map((n) => ({ n, t: `t${n}` })), r), [1, 3, 6]);
});

test("parseShortlist: shortlist.mjs's payload reads; anything else is unparsable, never a refusal", () => {
  assert.deepEqual(parseShortlist('{"scanned":3,"shortlist":[{"n":7,"t":"a"}]}'),
    { status: "ok", scanned: 3, entries: [{ n: 7, t: "a" }] });
  for (const bad of ["", "{", "[]", '{"shortlist":[]}', '{"scanned":1,"shortlist":{}}', '{"scanned":1,"shortlist":[{"n":"7","t":"a"}]}']) {
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fleet-tick.mjs", import.meta.url));
// Every non-builtin module the copied script needs at startup, direct import
// or transitive — and ledger.mjs with its own, because the tick reads the
// ledger through `ledger.mjs read`. An unlisted sibling is a module-not-found
// at startup: exit 1, a shape no case below expects.
const SIBLING_MODULES = ["arg.mjs", "fleet-state.mjs", "git-env.mjs", "ledger.mjs", "ledger-grammar.mjs"].map(
  (m) => [m, fileURLToPath(new URL(`./${m}`, import.meta.url))],
);

// `pr list` for the open PRs, `issue view` for a behind-issue premise's state,
// `issue list --label in-progress` for the stall report's claimed count.
const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "pr list") [ -n "$PR_FAIL" ] && { echo "boom" >&2; exit 1; }; cat "$FIXTURE_PRS" ;;
  "issue view")
    echo "$3" >> "$ISSUE_VIEW_LOG"
    # Real gh answers for the repository an inherited GIT_DIR or GH_REPO names;
    # this one answers CLOSED for every issue there, so a probe that forgot to
    # scrub them lifts an exclusion the case's own repository still holds.
    [ -n "$GIT_DIR$GIT_WORK_TREE$GH_REPO" ] && { echo '{"state":"CLOSED"}'; exit 0; }
    exec jq -c --arg n "$3" '{state: (.[$n] // error("no such issue"))}' "$FIXTURE_ISSUE_STATES" ;;
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

function runCli(args = [], {
  prs = [], ledger, shortlist, refresh = shortlistText([]), refreshFail = false,
  issueStates = {}, claimed = [], env: extraEnv = {}, defaultState = false, keep = false,
} = {}) {
  // realpath, because on macOS tmpdir() is /var -> /private/var: a script COPY
  // under the unresolved path never runs its own main(), since import.meta.url
  // resolves the symlink and process.argv[1] does not.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-")));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }).status, 0);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  const script = join(bin, "fleet-tick.mjs");
  writeFileSync(script, readFileSync(SCRIPT));
  for (const [name, path] of SIBLING_MODULES) writeFileSync(join(bin, name), readFileSync(path));
  writeFileSync(join(bin, "shortlist.mjs"), SHORTLIST_STUB);
  const fx = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };
  if (ledger !== undefined) writeFileSync(join(repo, ".fleet", "ledger.md"), ledgerText(ledger));
  if (shortlist !== undefined) writeFileSync(join(repo, ".fleet", "shortlist.json"), shortlist);
  const refreshLog = fx("refresh.log", "");
  const issueViewLog = fx("issue-view.log", "");
  // Every case gets its own state file unless it names one: the default path
  // resolves against the git common dir, and a shared streak and digest would
  // make the fold cases order-dependent. `defaultState` opts out for the case
  // whose subject IS that resolution.
  const stateArg = args.includes("--state") || defaultState ? [] : ["--state", join(dir, "heartbeat.json")];
  const r = spawnSync(process.execPath, [script, ...args, ...stateArg], {
    cwd: repo, encoding: "utf8",
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      FIXTURE_PRS: fx("prs.json", JSON.stringify(prs)),
      FIXTURE_CLAIMED: fx("claimed.json", JSON.stringify(claimed)),
      FIXTURE_ISSUE_STATES: fx("issue-states.json", JSON.stringify(issueStates)),
      FIXTURE_REFRESH: fx("refresh.json", refresh),
      REFRESH_LOG: refreshLog, ISSUE_VIEW_LOG: issueViewLog,
      ...(refreshFail ? { REFRESH_FAIL: "1" } : {}),
      ...extraEnv,
    },
  });
  r.refreshed = readFileSync(refreshLog, "utf8").split("\n").filter(Boolean).length;
  r.issueViews = readFileSync(issueViewLog, "utf8").split("\n").filter(Boolean);
  r.repo = repo;
  r.dir = dir;
  if (!keep) rmSync(dir, { recursive: true, force: true });
  return r;
}
const lineOf = (r, role) => r.stdout.split("\n").filter((l) => l.startsWith(role));

test("CLI: the #1692 shape, read off the ledger — two live implementers at cap 2 pull nothing", () => {
  const r = runCli([], {
    ledger: { rows: ["#412 impl-412", "#415 impl-415"], dispatched: ["impl-412", "impl-415"] },
    shortlist: shortlistText([412, 415, 420, 421, 422]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 2\/2 → AT CAP/m);
  assert.doesNotMatch(r.stdout, /PULL/);
  assert.equal(r.refreshed, 0, "three unclaimed at cap 2 is not short of the cap");

  // One settles: exactly one slot frees, and the next unclaimed head fills it.
  const one = runCli([], {
    ledger: { rows: ["#412 impl-412=PR#500 → PR#500", "#415 impl-415"], dispatched: ["impl-412=PR#500", "impl-415"] },
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

test("CLI: a failed refresh prints REFRESH FAILED and every other row, at exit 0", () => {
  const r = runCli([], { refreshFail: true, prs: [pr(60, ["ready-to-merge"])] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^shortlist {4}→ REFRESH FAILED {3}\(shortlist missing — shortlist\.mjs exited 2: shortlist: could not answer\)$/m);
  assert.match(r.stdout, /^merge-bot {4}0\/1 → DISPATCH merge-bot/m);
});

test("CLI: PULL names unclaimed heads only — claimed, bailed and excluded tickets are skipped", () => {
  const r = runCli(["--implementer-cap", "3"], {
    ledger: { rows: ["#1 impl-1=bailed", "#2 impl-2", "#3 excluded · behind-pr:#99"], dispatched: ["impl-1=bailed", "impl-2"] },
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

test("CLI: a ledger token outside the grammar refuses the tick, printing no row", () => {
  const r = runCli([], { ledger: { rows: ["#9 impl-9=merged"] }, shortlist: shortlistText([]) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /^fleet-tick: .*impl-9.*'merged' is not an outcome/m);
});

test("CLI: a ledger ledger.mjs itself refuses is a refusal here too", () => {
  // Two drain markers: ledger.mjs read exits 2 on the broken invariant.
  const dir = runCli([], { shortlist: shortlistText([]), keep: true });
  writeFileSync(join(dir.repo, ".fleet", "ledger.md"), `${ledgerText({ drain: "a" })}\n- b\n`);
  const r = spawnSync(process.execPath, [join(dir.dir, "bin", "fleet-tick.mjs"), "--state", join(dir.dir, "hb.json")], {
    cwd: dir.repo, encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir.dir, "bin")}:${process.env.PATH}`, FIXTURE_PRS: join(dir.dir, "prs.json") },
  });
  rmSync(dir.dir, { recursive: true, force: true });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /fleet-tick: ledger\.mjs read exited 2/);
});

test("CLI: a tier mismatch holds the implementer row until a replacement is dispatched", () => {
  const r = runCli([], { ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] }, shortlist: shortlistText([8, 9]) });
  assert.match(r.stdout, /^implementers 0\/2 → HOLD \(tier mismatch impl-7\)/m);
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

test("CLI: an ambient GIT_DIR naming another repository cannot move the shortlist read", () => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-")));
  spawnSync("git", ["init", "-q", decoy]);
  mkdirSync(join(decoy, ".fleet"));
  writeFileSync(join(decoy, ".fleet", "shortlist.json"), shortlistText([666]));
  const r = runCli([], { shortlist: shortlistText([7, 8]), env: { GIT_DIR: join(decoy, ".git") } });
  rmSync(decoy, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → PULL #7 #8 /m);
});

test("CLI: an inherited GIT_DIR cannot retarget the behind-issue premise probe", () => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-gh-")));
  spawnSync("git", ["init", "-q", decoy]);
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "OPEN" },
    env: { GIT_DIR: join(decoy, ".git"), GH_REPO: "someone/else" },
  });
  rmSync(decoy, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.issueViews, ["9"], "the probe must still run");
  assert.equal(r.refreshed, 0, "#9 is OPEN in the case's own repository — the exclusion stands");
});

// ---------------------------------------------------------------------------
// The heartbeat's half - #357. The tick is the only writer of the back-off
// streak and the fold digest, so these pin the contract fleet-heartbeat.mjs
// reads rather than the heartbeat's own arithmetic (that is its test's job).

const IDLE = { shortlist: shortlistText([]), refresh: shortlistText([]) };

test("CLI: the quiet streak lengthens on an idle tick and resets on an actionable one", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-state-")));
  const path = join(dir, "heartbeat.json");
  runCli(["--state", path], IDLE);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 1);
  runCli(["--state", path], IDLE);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 2);
  runCli(["--state", path], { ...IDLE, shortlist: shortlistText([9]) });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: --fold-unchanged folds a repeated idle tick to one line", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-")));
  const path = join(dir, "heartbeat.json");
  const first = runCli(["--fold-unchanged", "--state", path], IDLE);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.trim().split("\n").length >= 3);
  const second = runCli(["--fold-unchanged", "--state", path], IDLE);
  assert.deepEqual(second.stdout.trim().split("\n"), ["fleet-tick: unchanged, nothing to act on (quiet=2) — full rows on the next change"]);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: --fold-unchanged never folds an actionable tick, even an identical one", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-act-")));
  const path = join(dir, "heartbeat.json");
  const busy = { shortlist: shortlistText([9, 10]) };
  const first = runCli(["--fold-unchanged", "--state", path], busy);
  const second = runCli(["--fold-unchanged", "--state", path], busy);
  assert.equal(second.stdout, first.stdout);
  assert.match(second.stdout, /PULL #9 #10/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: --fold-unchanged does not fold when the rows change, even with nothing to act on", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-differs-")));
  const path = join(dir, "heartbeat.json");
  runCli(["--fold-unchanged", "--state", path], IDLE);
  // A queued candidate, held behind a lower PR: still nothing to act on.
  const held = {
    ...IDLE, ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · held-behind:#38"] },
    prs: [pr(38, [], []), pr(40, ["ready-to-merge"])],
  };
  const second = runCli(["--fold-unchanged", "--state", path], held);
  assert.match(second.stdout, /^merge-bot {4}0\/1 → HOLD\b/m);
  assert.doesNotMatch(second.stdout, /nothing to act on/);
  const third = runCli(["--fold-unchanged", "--state", path], held);
  assert.match(third.stdout, /^fleet-tick: unchanged, nothing to act on \(quiet=3\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: with no --state, the tick resolves the run's shared default", () => {
  const r = runCli([], { ...IDLE, defaultState: true, keep: true });
  const state = join(r.repo, ".fleet", "heartbeat.json");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.ok(existsSync(state));
  assert.equal(JSON.parse(readFileSync(state, "utf8")).quiet, 1);
  rmSync(r.dir, { recursive: true, force: true });
});

// The prior run's liveness - #1597.
const beat = (ms, interval, stopped = "") =>
  JSON.stringify({ quiet: 0, elapsed: 0, digest: "", beat: { at: Date.now() - ms, interval, stopped } });

test("CLI: a stale prior beat is reported, and reported FIRST, with the stranded claims and the supply", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { shortlist: shortlistText([9], 1), claimed: [{ number: 41 }, { number: 42 }, { number: 43 }] });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^heartbeat STALLED/);
  assert.match(lines[1], /^implementers/);
  assert.match(lines[0], /3 ticket\(s\) claimed and in flight/);
  assert.match(lines[0], /pool supply 1/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: an unreadable shortlist makes the stall report's supply unknown, never zero", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-supply-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { shortlist: "{" });
  assert.match(r.stdout.split("\n")[0], /pool supply unknown/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: the stall is announced even when the reconcile then refuses", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-refuse-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { ...IDLE, claimed: [{ number: 41 }], env: { PR_FAIL: "1" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gh pr list failed/);
  assert.match(r.stdout, /heartbeat STALLED/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: an unreadable claim count is `unknown`, never zero", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stall-unknown-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(90 * 60_000, 1200));
  const r = runCli(["--state", path], { ...IDLE, env: { CLAIMED_FAIL: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unknown ticket\(s\) claimed and in flight/);
  assert.match(r.stderr, /claimed ticket count unknown/);
  assert.match(r.stderr, /boom/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: a beat within the interval it promised is not reported at all", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-quiet-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(20 * 60_000, 1200));
  assert.doesNotMatch(runCli(["--state", path], IDLE).stdout, /STALLED/);
  writeFileSync(path, beat(20 * 60_000, 300));
  assert.match(runCli(["--state", path], IDLE).stdout, /STALLED/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: the streak write carries the heartbeat's mark instead of erasing it, and writes its own", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-mark-carry-")));
  const path = join(dir, "heartbeat.json");
  const mark = { at: Date.now() - 60_000, interval: 300, stopped: "" };
  writeFileSync(path, JSON.stringify({ quiet: 3, elapsed: 7, digest: "old", beat: mark }));
  const r = runCli(["--state", path], IDLE);
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(after.beat, mark);
  assert.equal(after.quiet, 4);
  assert.ok(after.ticked && after.ticked.at >= Date.now() - 5000);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: a deliberate stop is reported with its reason, and a run that never beat says nothing", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-stopped-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, beat(6 * 60_000, 300, "context ceiling reached"));
  const r = runCli(["--state", path], IDLE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopped deliberately — recorded reason: context ceiling reached/);
  assert.doesNotMatch(r.stdout, /without a recorded reason/);
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "" }));
  assert.doesNotMatch(runCli(["--state", path], IDLE).stdout, /STALLED/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: a busy, fully-staffed fleet is not reported STALLED just because the queue never drained", () => {
  // `beat` refreshes only when the queue drains; a tick two minutes ago on a
  // completion edge is what tells a busy run from a dead one.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-busy-not-stalled-")));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({
    quiet: 0, elapsed: 0, digest: "",
    beat: { at: Date.now() - 11 * 60_000, interval: 300, stopped: "" },
    ticked: { at: Date.now() - 2 * 60_000 },
  }));
  const r = runCli(["--state", path], {
    ledger: { rows: ["#1 impl-1", "#2 impl-2"], dispatched: ["impl-1", "impl-2"] },
    shortlist: shortlistText([3, 4, 5]), claimed: [{ number: 41 }],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /STALLED/);
  assert.match(r.stdout, /^implementers 2\/2 → AT CAP/m);
  rmSync(dir, { recursive: true, force: true });
});
