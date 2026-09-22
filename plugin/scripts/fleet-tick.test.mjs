// Regression gate for the reconcile tick. Zero deps:
//   node --test plugin/scripts/fleet-tick.test.mjs
//
// The pure half locks the queue-depth guard table — the whole point of #3 is
// that the table stops being prose the controller must remember, so a
// "simplification" that drops a row has to go red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, formatLines, unpairedFlags, actionable } from "./fleet-tick.mjs";

// Every field named, so a test that cares about one number still states the
// rest — a defaulted field is a guard nobody is pinning.
const state = (over = {}) => ({
  implLive: 0, reviewerLive: 0, mergeBotLive: 0,
  pool: 0, supply: 0, reviewsReady: 0, reviewBacklog: 0, mergeQueue: 0, mergeHeld: 0, mergeIgnored: [],
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
  // supply is deliberately LARGE and the pool deliberately short of the
  // deficit: that is #3's own shape, and the table calls row 1 silent for it.
  // At supply 0 this case cannot tell a bare DISPATCH from one that also
  // suggests re-shortlisting, so the exact-equality below would pin nothing.
  const r = row(state({ implLive: 0, pool: 1, implCap: 5, supply: 57 }), "implementers");
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

test("reviewers: nothing owed and nothing in hand is idle, not a deficit", () => {
  const r = row(state({ reviewerLive: 0, reviewsReady: 0, reviewBacklog: 0 }), "reviewers");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 5);
  assert.equal(r.action, "IDLE OK");
});

test("reviewers: a backlog with no returned review dispatches nothing (#590)", () => {
  // The defect this row was rewritten for. A reviewer slot holds a fix-applier
  // and a fix-applier applies findings, so a PR whose review has not returned
  // — including one the controller's own workflow is running right now — is
  // not something any member can be dispatched against. Every backlog depth,
  // because the old row's answer scaled with it.
  for (const reviewBacklog of [1, 2, 9]) {
    const r = row(state({ reviewerLive: 0, reviewsReady: 0, reviewBacklog }), "reviewers");
    assert.equal(r.action, "HOLD", `backlog ${reviewBacklog}`);
    assert.doesNotMatch(r.action, /DISPATCH/, `backlog ${reviewBacklog} must name no dispatch`);
  }
});

test("reviewers: dispatch is the smaller of the free slots and the reviews in hand", () => {
  // The accept side: a returned review IS dispatchable, and the row must still
  // say so — a fix that only ever holds is a row nobody can use.
  assert.equal(row(state({ reviewerLive: 0, reviewsReady: 2, reviewBacklog: 9 }), "reviewers").action, "DISPATCH 2");
  assert.equal(row(state({ reviewerLive: 4, reviewsReady: 9, reviewBacklog: 9 }), "reviewers").action, "DISPATCH 1");
  assert.equal(row(state({ reviewerLive: 5, reviewsReady: 9, reviewBacklog: 9 }), "reviewers").action, "AT CAP");
});

test("reviewers: dispatch never takes live past the cap", () => {
  for (const reviewerCap of [1, 3, 5]) {
    for (const reviewerLive of [0, 1, 5, 6]) {
      const r = row(state({ reviewerLive, reviewerCap, reviewsReady: 99 }), "reviewers");
      const n = Number((r.action.match(/^DISPATCH (\d+)$/) || [])[1] ?? 0);
      assert.ok(n === 0 || reviewerLive + n <= reviewerCap, `cap ${reviewerCap} live ${reviewerLive} → ${r.action}`);
    }
  }
});

test("reviewers: the detail carries both numbers, so a HOLD can be told from a drained queue", () => {
  const r = row(state({ reviewsReady: 0, reviewBacklog: 4 }), "reviewers");
  assert.match(r.detail, /reviews-ready=0/);
  assert.match(r.detail, /review-backlog=4/);
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

test("merge-bot: a queue whose every candidate is held dispatches nothing (#590)", () => {
  // `ready-to-merge` is a sign-off, not a statement that the hold rule cleared.
  // A second bot against a fully held queue re-derives a verdict already
  // reported and exits, and this is the state a stalled cascade sits in.
  const r = row(state({ mergeBotLive: 0, mergeQueue: 2, mergeHeld: 2 }), "merge-bot");
  assert.equal(r.action, "HOLD");
  assert.doesNotMatch(r.action, /DISPATCH/);
  assert.match(r.detail, /held=2/);
});

test("merge-bot: a partly held queue still dispatches — a hold is not a stop", () => {
  // The accept side. run-merge-bot holds one candidate and MOVES ON, so a
  // queue with anything unheld left in it is still work.
  assert.equal(row(state({ mergeBotLive: 0, mergeQueue: 3, mergeHeld: 2 }), "merge-bot").action, "DISPATCH merge-bot");
  assert.equal(row(state({ mergeBotLive: 0, mergeQueue: 1, mergeHeld: 0 }), "merge-bot").action, "DISPATCH merge-bot");
});

test("merge-bot: a hold the queue does not contain is named in the detail, not swallowed", () => {
  // The accept is deliberate, the silence was not: without `ignored=` a
  // mistyped number and an honest `none` print the same line, so the flag
  // added to suppress DISPATCH prints DISPATCH and says nothing about why.
  const r = row(state({ mergeBotLive: 0, mergeQueue: 1, mergeHeld: 0, mergeIgnored: [610, 590] }), "merge-bot");
  assert.equal(r.action, "DISPATCH merge-bot");
  assert.match(r.detail, /ignored=610,590/);
  // …and an empty set adds no field, so the happy path reads as it always did.
  assert.doesNotMatch(row(state({ mergeBotLive: 0, mergeQueue: 1 }), "merge-bot").detail, /ignored/);
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

// ---------------------------------------------------------------------------
// The pool-derived liveness shape — #1587. The implementer row can take its
// live counts from a dispatch pool's own status instead of from numbers the
// controller recites, and the ROW says which of the two it used.
//
// All of it is the pure half: no pool, no kernel, no network. The shape is the
// FLEET's own vocabulary (`live`/`queued`) and the caller maps its runtime's
// status onto it at the boundary, so nothing here asserts pool internals,
// worker identity or kernel lifetime, and an omp change to pool scheduling
// cannot redden this suite.

// The pool path's own call shape: the controller states no live counts at all,
// because reciting them is the thing the pool replaced. `over` puts them back,
// which is the disagreement case below.
const poolState = (poolLiveness, over = {}) => {
  const s = state();
  delete s.implLive;
  delete s.pool;
  return { ...s, poolLiveness, ...over };
};

test("implementers: the pool path runs the SAME guard table, and the row says where its counts came from", () => {
  // One row per situation the ticket names. What is pinned is that the pool
  // reading enters the EXISTING table — the deficit, the backlog gate and the
  // pool-0 branches are not re-derived for it — and that the ACTION is
  // traceable to the number that produced it.
  const cases = [
    {
      what: "pool state present: free capacity and queued items dispatch",
      status: { live: 0, queued: 3 }, over: { supply: 57 },
      action: "DISPATCH 2", actual: 0, provenance: "pool-derived",
      detail: /^pool=3 supply=57 review-backlog=0 counts=pool-derived$/,
    },
    {
      what: "pool state absent: nothing answered, so nothing is decided",
      status: null, over: { supply: 57 },
      action: "REFUSE", actual: "?", provenance: "unknown",
      detail: /^pool=\? supply=57 review-backlog=0 counts=unknown — pool status absent:/,
    },
    {
      what: "pool state unreadable: a count that is not a non-negative integer",
      status: { live: "1", queued: 3 }, over: { supply: 57 },
      action: "REFUSE", actual: "?", provenance: "unknown",
      detail: /counts=unknown — pool status unreadable: live='1' /,
    },
    {
      what: "pool state disagreeing with the stated flags: the pool decides, both print",
      status: { live: 1, queued: 1 }, over: { implLive: 0, pool: 5 },
      action: "DISPATCH 1", actual: 1, provenance: "pool-derived",
      detail: /^pool=1 supply=0 review-backlog=0 counts=pool-derived stated-unused=live:0,pool:5$/,
    },
    {
      what: "free capacity with an empty supply: a drained pool is not a dispatch",
      status: { live: 0, queued: 0 }, over: { supply: 0 },
      action: "SUGGEST /triage", actual: 0, provenance: "pool-derived",
      detail: /^pool=0 supply=0 review-backlog=0 counts=pool-derived — no supply/,
    },
    {
      what: "full cap with a non-empty supply: the pool's own live count holds the row",
      status: { live: 2, queued: 4 }, over: { supply: 57 },
      action: "AT CAP", actual: 2, provenance: "pool-derived",
      detail: /^pool=4 supply=57 review-backlog=0 counts=pool-derived$/,
    },
    {
      what: "pool state disagreeing on the pool count alone: only that field prints",
      status: { live: 1, queued: 1 }, over: { implLive: 1, pool: 9 },
      action: "DISPATCH 1", actual: 1, provenance: "pool-derived",
      // implLive AGREES with the pool's live count, so a bug that drops the
      // whole stated-unused marker on partial disagreement (rather than
      // reporting only the field that actually disagrees) would either print
      // nothing here or wrongly add a `live:` entry.
      detail: /^pool=1 supply=0 review-backlog=0 counts=pool-derived stated-unused=pool:9$/,
    },
    {
      what: "pool state disagreeing on the live count alone: only that field prints",
      status: { live: 1, queued: 1 }, over: { implLive: 0, pool: 1 },
      action: "DISPATCH 1", actual: 1, provenance: "pool-derived",
      // Mirror of the case above: pool AGREES, only implLive disagrees.
      detail: /^pool=1 supply=0 review-backlog=0 counts=pool-derived stated-unused=live:0$/,
    },
    {
      what: "pool path shares the caller-stated path's review-backlog HOLD gate",
      status: { live: 0, queued: 3 }, over: { reviewBacklog: 2 },
      action: "HOLD", actual: 0, provenance: "pool-derived",
      // A mutant that bypasses HOLD specifically for pool-derived rows
      // (`reviewBacklog >= 2 && provenance !== POOL`) leaves this red.
      detail: /^pool=3 supply=0 review-backlog=2 counts=pool-derived — a review-bound pipeline gains nothing from more PRs$/,
    },
  ];
  for (const c of cases) {
    const r = row(poolState(c.status, c.over), "implementers");
    assert.equal(r.action, c.action, c.what);
    assert.equal(r.actual, c.actual, c.what);
    assert.equal(r.target, 2, c.what);
    assert.equal(r.provenance, c.provenance, c.what);
    assert.match(r.detail, c.detail, `${c.what} — got: ${r.detail}`);
  }
});

test("implementers: a pool reading that did not arrive refuses, and can never be read as 0 live", () => {
  // Both of #3's error directions meet on this row, and the dangerous one is
  // the zero: a lost or reset kernel presenting as 0 live is a full cap's worth
  // of free capacity, which is a DISPATCH off a pool nobody read. The key being
  // PRESENT but empty is the shape that matters — a caller spreading whatever
  // its status read returned must refuse here, never quietly fall back to the
  // stated flags it may also have passed.
  const cases = [
    ["null", null, /pool status absent:/],
    ["an explicit undefined", undefined, /pool status absent:/],
    ["an empty status", {}, /unreadable: live=undefined, queued=undefined/],
    ["a half-filled status", { live: 1 }, /unreadable: queued=undefined/],
    ["a stringified count", { live: "1", queued: 1 }, /unreadable: live='1'/],
    ["a negative count", { live: 0, queued: -1 }, /unreadable: queued=-1/],
    ["a fractional count", { live: 1.5, queued: 0 }, /unreadable: live=1\.5/],
    ["NaN", { live: NaN, queued: 0 }, /unreadable: live=NaN/],
    ["a bare number", 3, /unreadable: live=undefined, queued=undefined/],
  ];
  for (const [what, status, why] of cases) {
    const r = row(poolState(status, { supply: 57, implCap: 2 }), "implementers");
    assert.equal(r.action, "REFUSE", what);
    assert.equal(r.provenance, "unknown", what);
    assert.match(r.detail, why, `${what} — got: ${r.detail}`);
    // Never a zero-live reading. The row carries no number at all, so a
    // consumer that skips the ACTION and does arithmetic gets NaN rather than
    // a plausible count.
    assert.equal(r.actual, "?", what);
    assert.ok(Number.isNaN(Number(r.actual)), what);
    assert.ok(Number.isNaN(r.target - r.actual), what);
    // And it asks for nothing to be written: no dispatch of any size.
    assert.doesNotMatch(r.action, /DISPATCH|RE-SHORTLIST/, what);
    // It names what is missing well enough to act on, and says which way the
    // silence must NOT be read.
    assert.match(r.detail, /Unknown is not zero live/, what);
  }
});

test("implementers: a refused pool reading does not blind the reviewer and merge-bot rows", () => {
  // The pool feeds this one row. A lost kernel must not take the merge side
  // with it: those numbers arrived by the route they always did, and a cascade
  // stalled behind an unmerged PR is exactly when a blank tick costs most.
  const rows = reconcile(poolState(null, { reviewsReady: 1, mergeQueue: 2 }));
  assert.deepEqual(rows.map((r) => r.role), ["implementers", "reviewers", "merge-bot"]);
  assert.equal(rows[1].action, "DISPATCH 1");
  assert.equal(rows[1].detail, "reviews-ready=1 review-backlog=0");
  assert.equal(rows[2].action, "DISPATCH merge-bot");
  assert.equal(rows[2].detail, "merge-queue=2 held=0");
});

test("implementers: a pool reading that agrees with the stated flags says nothing extra", () => {
  // `stated-unused=` is a DISAGREEMENT report, not a second copy of the
  // numbers: printing it when the two agree would bury the one case it exists
  // to make visible.
  const r = row(poolState({ live: 1, queued: 3 }, { implLive: 1, pool: 3 }), "implementers");
  assert.equal(r.detail, "pool=3 supply=0 review-backlog=0 counts=pool-derived");
});

test("implementers: pool-path dispatch never takes a stated-live count past the cap either", () => {
  // #1692: the pool path computed its deficit from the pool's own live count
  // ALONE, so a controller that ALSO states a higher live count — an
  // out-of-pool member the pool cannot see, which the disagreement report
  // above calls legitimate — got a full cap's worth dispatched ON TOP of
  // that already-live member. Same invariant as "dispatch never takes live
  // past the cap" above, run down the pool path instead: a pool reading
  // present, pinned to a live count of 0 so any headroom the row grants can
  // only have come from ignoring the stated count.
  for (const implCap of [1, 2, 5]) {
    for (const implLive of [0, 1, 2, 5]) {
      const r = row(poolState({ live: 0, queued: 99 }, { implLive, implCap }), "implementers");
      const n = Number((r.action.match(/^DISPATCH (\d+)$/) || [])[1] ?? 0);
      assert.ok(n === 0 || implLive + n <= implCap, `cap ${implCap} live ${implLive} → ${r.action}`);
    }
  }
});

test("implementers: the exact #1692 reproduction no longer dispatches past cap", () => {
  // Reproduced by the review: implLive 2 (stated) plus a fresh DISPATCH 2
  // lands at 4 live against a cap of 2, because the pool's OWN live count (0)
  // was the only one the deficit consulted. Pinned verbatim so a regression
  // on this exact shape goes red here, not just in the general sweep above.
  const r = row(state({ implLive: 2, pool: 3, implCap: 2, poolLiveness: { live: 0, queued: 3 } }), "implementers");
  assert.notEqual(r.action, "DISPATCH 2");
  const n = Number((r.action.match(/^DISPATCH (\d+)$/) || [])[1] ?? 0);
  assert.ok(2 + n <= 2, `stated live 2 plus dispatch ${n} exceeds cap 2 — action was ${r.action}`);
  assert.equal(r.action, "AT CAP");
});

test("every row states its provenance, on both paths", () => {
  // Part of the row, not a comment. The two rows no pool feeds say so outright
  // rather than leaving a reader to infer their source from a missing field.
  assert.deepEqual(reconcile(state()).map((r) => [r.role, r.provenance]), [
    ["implementers", "caller-stated"], ["reviewers", "caller-stated"], ["merge-bot", "caller-stated"],
  ]);
  assert.deepEqual(reconcile(poolState({ live: 1, queued: 0 })).map((r) => [r.role, r.provenance]), [
    ["implementers", "pool-derived"], ["reviewers", "caller-stated"], ["merge-bot", "caller-stated"],
  ]);
});

test("the caller-stated path prints byte-identical lines to the ones it printed before the pool shape", () => {
  // Exact strings, because these lines are both the contract a reader already
  // knows and the bytes the fold digest hashes. A provenance marker on this
  // path would change every tick's output to say what it already said, and
  // would un-fold one quiet night on the way through.
  assert.deepEqual(
    formatLines(reconcile(state({
      implLive: 0, pool: 3, supply: 57, reviewBacklog: 1, reviewsReady: 1,
      mergeQueue: 2, mergeHeld: 1, mergeIgnored: [999],
    }))),
    [
      "implementers 0/2 → DISPATCH 2   (pool=3 supply=57 review-backlog=1)",
      "reviewers    0/5 → DISPATCH 1   (reviews-ready=1 review-backlog=1)",
      "merge-bot    0/1 → DISPATCH merge-bot   (merge-queue=2 held=1 ignored=999)",
    ],
  );
  assert.deepEqual(
    formatLines(reconcile(state())),
    [
      "implementers 0/2 → SUGGEST /triage   (pool=0 supply=0 review-backlog=0 — no supply — hold implementer slots idle)",
      "reviewers    0/5 → IDLE OK   (reviews-ready=0 review-backlog=0)",
      "merge-bot    0/1 → IDLE OK   (merge-queue=0 held=0)",
    ],
  );
});

// ---------------------------------------------------------------------------
// The CLI half. What is pinned here is the CONTRACT #3 left open: live member
// counts and the pool arrive as required args (no source in the repo can be
// trusted for them), everything else the script reads for itself, and every
// failed read refuses rather than degrading into a number.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fleet-tick.mjs", import.meta.url));
// Every non-builtin module the copied script needs at startup, direct import
// or transitive, because runCli() below reruns the script from a stub
// directory and an unlisted sibling is a module-not-found at startup — exit 1,
// which is the code the candidates.mjs tests read as "queue empty".
// `git-env.mjs` is here transitively: fleet-state.mjs imports its
// workspaceDirFromGitCommonDir() for the state path (#1658). Add a row here
// whenever the script — or one of these — gains an import.
const SIBLING_MODULES = ["arg.mjs", "fleet-state.mjs", "git-env.mjs"].map(
  (m) => [m, fileURLToPath(new URL(`./${m}`, import.meta.url))],
);

// Answers both reads the tick makes: `gh pr list` for backlog/merge-queue, and
// the `gh issue list --jq …` that candidates.mjs makes on its behalf. The issue
// branch execs the real jq with the expression gh was handed, so candidates.mjs
// runs for real underneath rather than being mocked away — supply is the one
// number this script does not compute itself.
const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "pr list") [ -n "$PR_FAIL" ] && { echo "boom" >&2; exit 1; }; cat "$FIXTURE_PRS" ;;
  "issue list")
    [ -n "$ISSUE_FAIL" ] && { echo "boom" >&2; exit 1; }
    expr=""
    while [ $# -gt 0 ]; do
      case "$1" in --jq) shift; expr="$1" ;; esac
      shift
    done
    exec jq -c "$expr" "$FIXTURE_ISSUES" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

// `closes` defaults to the PR's own number so an ordinary fixture PR is review
// work; pass `[]` for the controller-authored chore PR that closes nothing.
const pr = (number, labels = [], closes = [number]) => ({
  number, labels: labels.map((name) => ({ name })),
  closingIssuesReferences: closes.map((n) => ({ number: n })),
});
const issue = (number) => ({
  number, title: `t${number}`, labels: [{ name: "ready-for-agent" }], body: "",
});

function runCli(args, { prs = [], issues = [], env: extraEnv = {}, candidates, cwd, defaultState = false } = {}) {
  // realpath, because on macOS tmpdir() is /var -> /private/var: a script COPY
  // placed under the unresolved path never runs its own main(), since
  // import.meta.url resolves the symlink and process.argv[1] does not. It exits
  // 0 having printed nothing — the same shape as a passing tick.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-")));
  const gh = join(dir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const prFixture = join(dir, "prs.json");
  const issueFixture = join(dir, "issues.json");
  writeFileSync(prFixture, JSON.stringify(prs));
  writeFileSync(issueFixture, JSON.stringify(issues));
  // Every case gets its own state file unless it names one. The tick writes the
  // back-off streak on every successful run, and its default path resolves
  // against the git common dir — so without this the suite would write the
  // REPO's own `.fleet/heartbeat.json` and each test would inherit the previous
  // test's streak and digest, making the fold cases order-dependent.
  //
  // `defaultState` opts out, for the one case whose subject IS that resolution.
  // It is safe there only because that case runs with a `cwd` inside a
  // throwaway git repository, which is what the common dir then resolves to.
  const stateArg = args.includes("--state") || defaultState
    ? [] : ["--state", join(dir, "heartbeat.json")];
  // supply() resolves candidates.mjs beside fleet-tick.mjs, so a stub sibling
  // means running a copy of the script out of the stub dir — and every module
  // the script imports has to ride along or the copy fails to resolve it at
  // startup: an uncaught MODULE_NOT_FOUND, exit 1, exactly the collision this
  // file's own die() tests below exist to catch. SIBLING_MODULES is that list.
  let script = SCRIPT;
  if (candidates !== undefined) {
    script = join(dir, "fleet-tick.mjs");
    writeFileSync(script, readFileSync(SCRIPT));
    for (const [name, path] of SIBLING_MODULES) writeFileSync(join(dir, name), readFileSync(path));
    writeFileSync(join(dir, "candidates.mjs"), candidates);
  }
  const r = spawnSync(process.execPath, [script, ...args, ...stateArg], {
    cwd, encoding: "utf8",
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`,
      FIXTURE_PRS: prFixture, FIXTURE_ISSUES: issueFixture, ...extraEnv,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const LIVE = ["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "1",
  "--reviews-ready", "0", "--merge-holds", "none"];
// The same six required flags with the merge queue reported as unheld and one
// review in hand — the shape every ACTION-side assertion below needs.
const LIVE_ACTIONABLE = ["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "1",
  "--reviews-ready", "1", "--merge-holds", "none"];

test("a required flag with no rationale of its own is a load-time error, not a borrowed one", () => {
  // Nothing but spelling ties an OPTIONS key to a WHY key, and the miss used
  // to be silent in both directions: a new required flag printed the live-count
  // rationale, and a renamed WHY key printed "is required. undefined". Both at
  // exit 2, both reading like a working refusal.
  assert.deepEqual(unpairedFlags({ "review-backlog": { type: "string" } }, {}), ["review-backlog"]);
  // A flag carrying a default states no reason because it needs none.
  assert.deepEqual(unpairedFlags({ cap: { type: "string", default: "2" } }, {}), []);
  assert.deepEqual(unpairedFlags({ pool: { type: "string" } }, { pool: "why" }), []);
});

test("CLI: a missing live count refuses rather than defaulting", () => {
  // The whole contract in one assertion. A default here is the bug: 0 would
  // dispatch a full cap off a forgotten flag, cap would hold forever, and
  // neither says anything on the way past.
  for (const drop of ["--implementers", "--reviewers", "--merge-bots", "--pool",
    "--reviews-ready", "--merge-holds"]) {
    const args = LIVE.filter((a, i) => a !== drop && LIVE[i - 1] !== drop);
    const r = runCli(args, { prs: [] });
    assert.equal(r.status, 2, `dropping ${drop} should refuse`);
    assert.match(r.stderr, new RegExp(`${drop.slice(2)}.*required`, "s"));
    assert.equal(r.stdout.trim(), "", `dropping ${drop} must print no reconcile line`);
  }
});

test("CLI: a live count that is not a non-negative integer refuses", () => {
  for (const bad of ["x", "-1", "1.5", ""]) {
    // The `=` form, not `--implementers -1`: given a space, parseArgs rejects a
    // leading dash as ambiguous BEFORE the guard runs, so status 2 alone is
    // satisfied by the parser and the negative case pins nothing. The stderr
    // match is what holds every case to this script's own reason for refusing.
    const r = runCli([`--implementers=${bad}`, "--reviewers", "0", "--merge-bots", "0", "--pool", "1",
      "--reviews-ready", "0", "--merge-holds", "none"]);
    assert.equal(r.status, 2, `'${bad}' should refuse`);
    assert.match(r.stderr, /--implementers must be a non-negative integer/,
      `'${bad}' must refuse for the guard's reason, not the parser's`);
  }
});

test("CLI: a flag given no value at all refuses", () => {
  const r = runCli(["--reviewers", "0", "--merge-bots", "0", "--pool", "1",
    "--reviews-ready", "0", "--merge-holds", "none", "--implementers"]);
  assert.equal(r.status, 2);
});

test("CLI: an unrecognised flag refuses instead of being ignored", () => {
  const r = runCli([...LIVE, "--implementor-cap", "3"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /accepted:/);
});

test("CLI: a cap outside run-team's invariant refuses", () => {
  assert.equal(runCli([...LIVE, "--implementer-cap", "6"]).status, 2);
  assert.equal(runCli([...LIVE, "--reviewer-cap", "6"]).status, 2);
  assert.equal(runCli([...LIVE, "--implementer-cap", "0"]).status, 2);
});

test("CLI: a failed gh read refuses — it is not an empty backlog", () => {
  const r = runCli(LIVE, { env: { PR_FAIL: "1" } });
  assert.equal(r.status, 2);
  // The harm being pinned is not the exit code but the line that must NOT have
  // been printed: backlog 0 + merge-queue 0 is a perfectly plausible tick, and
  // an unread pipeline printed as an idle one is the silent stall again.
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /gh pr list/);
});

test("CLI: a failed supply read refuses — unknown supply is not zero supply", () => {
  const r = runCli(["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--merge-holds", "none"], { env: { ISSUE_FAIL: "1" } });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /supply/);
});

test("CLI: a candidates.mjs that dies on its own refuses — Node exit 1 is not an empty queue", () => {
  // The collision this pins: Node exits 1 for a module-not-found, a syntax
  // error and any uncaught throw, and candidates.mjs uses that same code for
  // "query fine, queue empty". Read as the latter, a supply read that never
  // ran prints supply=0 and the exact #3 stall line at exit 0 — this script
  // reporting the stall it exists to end. Only the payload separates them.
  for (const [what, body] of [
    ["an uncaught throw", `throw new Error("boom");`],
    ["a syntax error", "const x = ;"],
  ]) {
    const r = runCli(LIVE, { candidates: body });
    assert.equal(r.status, 2, `${what} must refuse`);
    assert.equal(r.stdout.trim(), "", `${what} must print no reconcile line`);
    assert.match(r.stderr, /supply unknown/, `${what} must say supply is unknown`);
  }

  // …and the benign exit 1 still reads as an empty queue, or the fix above
  // would have bought the refusal by breaking the case it must keep.
  const empty = runCli(LIVE, { candidates: `console.log("[]"); process.exitCode = 1;` });
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /supply=0/);
});

test("CLI: candidates' exit 3 is a supply of 0, not an unknown one (#64)", () => {
  // Exit 3 is "the query worked, rows came back, every one was a to-spec spec".
  // Zero supply either way, so the tick must print it rather than refuse. The
  // gate it goes through special-cased exit 1 alone, so an all-specs
  // ready-for-agent queue — the case #64 exists for — fell through to the
  // refusal and lost the WHOLE tick: main() computes supply before printing
  // anything, so the reviewer and merge-bot rows died with it. Hence the two
  // stdout assertions below, not just the status.
  const allSpecs = runCli(LIVE, { candidates: `console.log("[]"); process.exitCode = 3;` });
  assert.equal(allSpecs.status, 0);
  assert.match(allSpecs.stdout, /supply=0/);
  assert.equal(allSpecs.stdout.trim().split("\n").length, 3, "the whole tick must survive, not just the supply row");

  // A non-`[]` payload is not a zero supply whatever code rides with it, so 3
  // does not become a blanket "treat as empty".
  const lying = runCli(LIVE, { candidates: `console.log("[{}]"); process.exitCode = 3;` });
  assert.equal(lying.status, 2);
  assert.equal(lying.stdout.trim(), "");
  assert.match(lying.stderr, /supply unknown/);
});

test("CLI: a refusal carries candidates' own explanation, not just 'supply unknown'", () => {
  // The reason candidates printed is the only text saying WHY, and it goes to a
  // pipe nothing reads. Dropped, the operator is told a read failed when the
  // read succeeded and named its own cause.
  const r = runCli(LIVE, {
    candidates: `console.error("dropped #10 — to-spec spec, not a ticket"); process.exitCode = 2;`,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /supply unknown/);
  assert.match(r.stderr, /dropped #10 — to-spec spec, not a ticket/);
});

test("CLI: a signal-killed candidates.mjs names the signal, not `exited null`", () => {
  // spawnSync leaves status null and puts the cause in signal, so a refusal
  // interpolating status alone names nothing. Fixed once at candidates.mjs's
  // own gh read and reintroduced here; this is the pin that was missing.
  const r = runCli(LIVE, { candidates: `process.kill(process.pid, "SIGKILL");` });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /killed by SIGKILL/);
});

test("CLI: a PR list at the limit refuses rather than serving a truncated one", () => {
  const prs = Array.from({ length: 200 }, (_, i) => pr(i + 1));
  const r = runCli(LIVE, { prs });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /truncated|capped/i);
});

test("CLI: a drained implementer queue with pool and a merge queue prints all three ACTIONs", () => {
  const r = runCli(LIVE, { prs: [pr(1, ["ready-to-merge"])], issues: [issue(9)] });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^implementers\s+0\/2 → DISPATCH 1\b/);
  assert.match(lines[1], /^reviewers\s+0\/5 → IDLE OK\b/);
  assert.match(lines[2], /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/);
});

test("CLI: the new inputs must still be ABLE to produce an ACTION (#590)", () => {
  // The false-refusal side of the same change. A suppressor that suppresses
  // whatever it is fed is not a fix — it is the row deleted, with a flag.
  const r = runCli(LIVE_ACTIONABLE, { prs: [pr(1, ["ready-to-merge"]), pr(2)], issues: [issue(9)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers\s+0\/5 → DISPATCH 1\b/m);
  assert.match(r.stdout, /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/m);
});

test("CLI: a held candidate suppresses the merge-bot ACTION, an unheld one does not (#590)", () => {
  const prs = [pr(601, ["ready-to-merge"]), pr(599)];
  const held = runCli([...LIVE.slice(0, -1), "601"], { prs, issues: [issue(9)] });
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stdout, /^merge-bot\s+0\/1 → HOLD\b/m);
  assert.match(held.stdout, /held=1/);

  // Two queued, one held: the bot holds a candidate and moves on, so the other
  // is still work.
  const partly = runCli([...LIVE.slice(0, -1), "601"],
    { prs: [pr(601, ["ready-to-merge"]), pr(602, ["ready-to-merge"])], issues: [issue(9)] });
  assert.match(partly.stdout, /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/m);

  // A held number the queue does not contain — the shape left behind when the
  // hold clears and the candidate merges — subtracts nothing rather than
  // refusing the whole tick.
  const stale = runCli([...LIVE.slice(0, -1), "1234"], { prs, issues: [issue(9)] });
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/m);
});

test("CLI: a mistyped hold is not byte-identical to declaring none (#590)", () => {
  // The reproduction the review ran: with one queued PR, `--merge-holds 610`,
  // `--merge-holds 590` (the ISSUE number, the confusion this very workflow
  // invites) and `--merge-holds none` all printed the same DISPATCH line, so
  // nothing on either stream told the caller their number was thrown away.
  const prs = [pr(601, ["ready-to-merge"])];
  const none = runCli([...LIVE.slice(0, -1), "none"], { prs, issues: [issue(9)] });
  assert.equal(none.status, 0, none.stderr);
  for (const typo of ["610", "590"]) {
    const r = runCli([...LIVE.slice(0, -1), typo], { prs, issues: [issue(9)] });
    assert.equal(r.status, 0, r.stderr);
    // Still accepted — a tick that refuses on the ordinary merged-away case is
    // worse than one that subtracts nothing.
    assert.match(r.stdout, /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/m);
    assert.match(r.stdout, new RegExp(`ignored=${typo}`));
    assert.notEqual(r.stdout, none.stdout, `--merge-holds ${typo} must not read as 'none'`);
  }
});

test("CLI: --merge-holds refuses a value that is neither 'none' nor PR numbers", () => {
  // `""` first: that is the shape an unset shell variable produces, and reading
  // it as "nothing is held" is the default this flag exists to refuse.
  for (const bad of ["", "yes", "601;604", "-1", "#"]) {
    const r = runCli([...LIVE.slice(0, -1), bad], { prs: [], issues: [] });
    assert.equal(r.status, 2, `'${bad}' should refuse`);
    assert.equal(r.stdout.trim(), "", `'${bad}' must print no reconcile line`);
  }
  // …and the two accepted spellings still are, or the guard bought its
  // refusals by breaking the flag.
  for (const good of ["none", "601", "601,604", "#601, #604"]) {
    const r = runCli([...LIVE.slice(0, -1), good], { prs: [], issues: [] });
    assert.equal(r.status, 0, `'${good}' should be accepted: ${r.stderr}`);
  }
});

test("CLI: a PR that closes no issue is not review backlog (#590)", () => {
  // The controller's own chore PR: unlabelled by design, never reviewed by any
  // member, so counting it floors the backlog at a number nothing can drain
  // and the implementer gate holds for the rest of the run.
  const chore = pr(2, [], []);
  const r = runCli(LIVE, { prs: [chore, pr(3)], issues: [issue(9)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /review-backlog=1/);
  assert.match(r.stdout, /^implementers\s+0\/2 → DISPATCH 1\b/m);

  // Two chore PRs and nothing else: the gate's own threshold, and the row that
  // used to print HOLD for the rest of the run.
  const both = runCli(LIVE, { prs: [chore, pr(3, [], [])], issues: [issue(9)] });
  assert.match(both.stdout, /review-backlog=0/);
  assert.match(both.stdout, /^implementers\s+0\/2 → DISPATCH 1\b/m);
});

test("CLI: a gh row missing closingIssuesReferences refuses rather than counting as no-issue", () => {
  // Absent, the field reads as an empty list and every open PR silently leaves
  // the backlog — backlog 0 on a full pipeline, which is the #3 stall again.
  const r = runCli(LIVE, { prs: [{ number: 1, labels: [] }], issues: [issue(9)] });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /closingIssuesReferences/);
});

test("CLI: review backlog and merge queue are derived from open PRs by label", () => {
  const prs = [pr(1, ["ready-to-merge"]), pr(2, ["ready-to-merge"]), pr(3), pr(4)];
  const r = runCli(LIVE, { prs, issues: [issue(9)] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /review-backlog=2/);
  assert.match(r.stdout, /merge-queue=2/);
  // Backlog 2 is the gate, so the pool must not be spent.
  assert.match(r.stdout, /^implementers\s+0\/2 → HOLD\b/m);
});

test("CLI: supply comes from candidates.mjs and drives the pool-0 branches", () => {
  const empty = ["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--merge-holds", "none"];
  const one = runCli(empty, { prs: [], issues: [issue(9)] });
  assert.equal(one.status, 0);
  assert.match(one.stdout, /supply=1/);
  assert.match(one.stdout, /RE-SHORTLIST \+ SUGGEST \/triage/);

  const none = runCli(empty, { prs: [], issues: [] });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /supply=0/);
  assert.match(none.stdout, /SUGGEST \/triage/);

  const many = runCli(empty, { prs: [], issues: [issue(9), issue(10), issue(11)] });
  assert.equal(many.status, 0);
  assert.match(many.stdout, /supply=3/);
  assert.match(many.stdout, /^implementers\s+0\/2 → RE-SHORTLIST\s{2}/m);
});

// --------------------------------------------------------------------------
// The heartbeat's half — #357. The tick is the only writer of the back-off
// streak and the fold digest, so these pin the contract fleet-heartbeat.mjs
// reads rather than the heartbeat's own arithmetic (that is its test's job).

test("actionable: DISPATCH, RE-SHORTLIST and REFUSE name work the controller can do", () => {
  const row = (action) => [{ role: "implementers", actual: 0, target: 2, action, detail: "" }];
  assert.equal(actionable(row("DISPATCH 1")), true);
  assert.equal(actionable(row("DISPATCH merge-bot")), true);
  assert.equal(actionable(row("RE-SHORTLIST")), true);
  assert.equal(actionable(row("RE-SHORTLIST + SUGGEST /triage")), true);
  assert.equal(actionable(row("REFUSE")), true);
  assert.equal(actionable(row("AT CAP")), false);
  assert.equal(actionable(row("IDLE OK")), false);
  assert.equal(actionable(row("HOLD")), false);
});

test("actionable: `SUGGEST /triage` alone is not work — nobody is there to ask", () => {
  // The deliberate call, and the one a reader is most likely to invert: this
  // row asks a MAINTAINER to tick tickets. On the unattended overnight run the
  // heartbeat exists for there is nobody to ask, so treating it as actionable
  // would pin the interval at the base all night for a request no one can
  // answer — the back-off would never engage in the one case it was added for.
  const rows = [{ role: "implementers", actual: 0, target: 2, action: "SUGGEST /triage", detail: "" }];
  assert.equal(actionable(rows), false);
});

test("actionable: a REFUSE is work — a blind row must never buy a longer interval", () => {
  // The inverse call to the one above, and for the opposite reason: re-opening
  // the pool, or falling back to the stated counts, is something the controller
  // can do unattended. A refusal that backed off would stretch the beat while
  // the implementer side went unobserved, tick after identical tick — #3's own
  // stall, wearing the pool's name.
  const rows = reconcile(poolState(null));
  assert.equal(rows[0].action, "REFUSE");
  assert.equal(actionable(rows), true);
});

test("actionable: one actionable row carries the whole tick", () => {
  const rows = [
    { role: "implementers", actual: 2, target: 2, action: "AT CAP", detail: "" },
    { role: "reviewers", actual: 0, target: 5, action: "IDLE OK", detail: "" },
    { role: "merge-bot", actual: 0, target: 1, action: "DISPATCH merge-bot", detail: "" },
  ];
  assert.equal(actionable(rows), true);
});

test("CLI: the quiet streak lengthens on an idle tick and resets on an actionable one", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-state-")));
  const path = join(dir, "heartbeat.json");
  // An idle tick: nothing queued, nothing in supply, no reviews in hand.
  const idle = ["--implementers", "2", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--merge-holds", "none", "--state", path];

  runCli(idle, { prs: [], issues: [] });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 1);
  runCli(idle, { prs: [], issues: [] });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 2);

  // Work appears. The streak must reset even though this tick arrived on the
  // same path — an interval still armed at the ceiling after work lands is the
  // stall #357 exists to end, just shorter.
  runCli(["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "1",
    "--reviews-ready", "0", "--merge-holds", "none", "--state", path], { prs: [], issues: [issue(9)] });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: --fold-unchanged folds a repeated idle tick to one line", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-")));
  const path = join(dir, "heartbeat.json");
  const idle = ["--implementers", "2", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--merge-holds", "none", "--fold-unchanged", "--state", path];

  // First tick has nothing to compare against, so it prints in full.
  const first = runCli(idle, { prs: [], issues: [] });
  assert.equal(first.status, 0);
  assert.equal(first.stdout.trim().split("\n").length, 3);

  // Second is byte-identical and asks for nothing — this is what makes an
  // overnight run affordable: a line, not a reconcile.
  const second = runCli(idle, { prs: [], issues: [] });
  assert.equal(second.status, 0);
  const lines = second.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^fleet-tick: unchanged, nothing to act on \(quiet=2\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: --fold-unchanged never folds an actionable tick, even an identical one", () => {
  // The trap the actionable() predicate exists to avoid, and the reason the fold
  // is not keyed on output identity alone. A tick printing `DISPATCH 1` every
  // interval because the controller has not acted on it is identical each time;
  // folding it would hide unclaimed work behind a one-line "nothing to act on",
  // which is #3's stall wearing this ticket's own remedy as a disguise.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-act-")));
  const path = join(dir, "heartbeat.json");
  const args = [...LIVE, "--fold-unchanged", "--state", path];

  const first = runCli(args, { prs: [], issues: [issue(9)] });
  assert.match(first.stdout, /DISPATCH 1/);
  const second = runCli(args, { prs: [], issues: [issue(9)] });
  assert.equal(second.stdout, first.stdout);
  assert.match(second.stdout, /DISPATCH 1/);
  assert.doesNotMatch(second.stdout, /nothing to act on/);
  // And the streak stayed at 0 throughout, so the heartbeat keeps beating at
  // the base interval while the work is outstanding.
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: without --fold-unchanged a repeated idle tick still prints in full", () => {
  // The two shipped merge-side edges pass no new flags, so their output must be
  // exactly what it was before #357 — a folded edge tick would hand a
  // controller that just acted a line instead of the rows it reads.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-nofold-")));
  const path = join(dir, "heartbeat.json");
  const idle = ["--implementers", "2", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--merge-holds", "none", "--state", path];
  runCli(idle, { prs: [], issues: [] });
  const second = runCli(idle, { prs: [], issues: [] });
  assert.equal(second.stdout.trim().split("\n").length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: --fold-unchanged does not fold when the ROWS change, even with nothing to act on", () => {
  // The other half of the fold predicate, and the half every case above leaves
  // untested: each repeats a byte-identical tick, so a digest that was constant
  // — or computed over the wrong thing — folds correctly in all of them. Two
  // non-actionable ticks whose printed rows DIFFER must print in full, or a
  // pipeline that is moving reads as a night where nothing happened.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-differs-")));
  const path = join(dir, "heartbeat.json");
  const idle = ["--implementers", "2", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--fold-unchanged", "--state", path];

  // Nothing queued at all: the merge-bot row is idle.
  const first = runCli([...idle, "--merge-holds", "none"], { prs: [], issues: [] });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^merge-bot\s+0\/1 → IDLE OK\b/m);
  assert.equal(first.stdout.trim().split("\n").length, 3);

  // A queued candidate, held behind a lower PR. Still nothing the controller
  // can act on — a hold is not work — so `actionable()` is false either way and
  // the digest is the only thing that can tell these two ticks apart.
  const held = { prs: [pr(601, ["ready-to-merge"])], issues: [] };
  const second = runCli([...idle, "--merge-holds", "601"], held);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^merge-bot\s+0\/1 → HOLD\b/m);
  assert.equal(second.stdout.trim().split("\n").length, 3,
    "the rows changed, so the tick must print them — the queue gaining a held candidate is the pipeline moving");
  assert.doesNotMatch(second.stdout, /nothing to act on/);

  // Control, because "printed in full" is also what a fold that never fires
  // looks like: repeat that same tick and it does collapse.
  const third = runCli([...idle, "--merge-holds", "601"], held);
  assert.equal(third.stdout.trim().split("\n").length, 1);
  assert.match(third.stdout, /^fleet-tick: unchanged, nothing to act on \(quiet=3\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: with no --state, and with an empty one, the tick resolves the run's shared default", () => {
  // The path both shipped invocations use — neither passes --state — and the
  // one this file's harness injects around on every other case, which is why
  // nothing had exercised it. What it buys is ONE state file per run: a
  // cwd-relative answer would give every member's worktree a private streak and
  // a private digest, and the run's beat would be whichever worktree called
  // last. `--state ""` is the shape an unset shell variable produces, and it is
  // not a path, so it resolves to the same default rather than to `''`.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-default-state-")));
  assert.equal(spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }).status, 0);
  const idle = ["--implementers", "2", "--reviewers", "0", "--merge-bots", "0", "--pool", "0",
    "--reviews-ready", "0", "--merge-holds", "none"];
  const state = join(repo, ".fleet", "heartbeat.json");

  const first = runCli(idle, { prs: [], issues: [], cwd: repo, defaultState: true });
  assert.equal(first.status, 0, first.stderr);
  // Never through the announced cwd-relative fallback: a case that resolved
  // that way would be pinning the degradation while reading like it pinned the
  // resolution.
  assert.doesNotMatch(first.stderr, /WARNING/);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).quiet, 1);

  // The streak it wrote is the streak the next run reads back — persistence,
  // which is the half a "the file appeared" assertion would miss.
  const second = runCli([...idle, "--state", ""], { prs: [], issues: [], cwd: repo });
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /WARNING/);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).quiet, 2);
  rmSync(repo, { recursive: true, force: true });
});
