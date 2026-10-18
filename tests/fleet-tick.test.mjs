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
import { reconcile, formatLines, actionable, deriveRun, LedgerError, parseShortlist, unclaimed, refreshWhy, dispositionsToken, currentDispositions, reapDue, reapedAfter, reapSummary, reclaimSummary } from "../plugin/scripts/fleet-tick.mjs";

// Every field named, so a test that cares about one number still states the
// rest — a defaulted field is a guard nobody is pinning.
const state = (over = {}) => ({
  bound: 5, inFlight: 0, inFlightImpl: 0, inFlightPrs: 0, owedCounted: [],
  draining: null, tierMismatch: [], tierUnchecked: [], implNames: [],
  heads: [], supply: 0, shortlistStatus: "ok", refresh: null, dropped: [], pulls: new Map(),
  reviewsLive: 0, fixLive: 0, fixDue: [], reviewDue: [], unlabelled: [], conflicts: [], conflictEscalate: [],
  mergeBotLive: 0, mergeQueue: 0, mergeHeld: 0, mergeConflictHeld: 0,
  mainCheckout: { state: "clean" }, phase0: { held: false, line: null, session: null },
  ...over,
});
const rowsOf = (s, role) => reconcile(s).filter((r) => r.role === role);
const row = (s, role) => rowsOf(s, role)[0];

// ---------------------------------------------------------------------------
// The implementer row.

// The PULL actions the implementer rows print: one row per head pulled.
const pulledHeads = (s) => rowsOf(s, "implementers").map((r) => r.action).filter((a) => a.startsWith("PULL")).map((a) => Number(/^PULL #(\d+)/.exec(a)[1]));

test("implementers: free slots PULL the next unclaimed heads, one per slot, oldest first", () => {
  const rows = rowsOf(state({ bound: 2, heads: [412, 415, 420], supply: 9 }), "implementers");
  assert.deepEqual(rows.map((r) => r.action), ["PULL #412 — pull.mjs next --head 412", "PULL #415 — pull.mjs next --head 415"]);
  for (const r of rows) {
    assert.equal(r.actual, 0);
    assert.equal(r.target, 2);
    assert.equal(r.acts, true);
  }
});

test("implementers: a PULL never takes In flight past the bound", () => {
  const heads = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const bound of [1, 2, 5, 8]) {
    for (const inFlight of [0, 1, 2, 5, 9]) {
      const pulled = pulledHeads(state({ bound, inFlight, heads })).length;
      assert.equal(pulled, Math.max(0, Math.min(heads.length, bound - inFlight)), `bound ${bound} in flight ${inFlight} → ${pulled}`);
      assert.ok(pulled === 0 || inFlight + pulled <= bound, `bound ${bound} in flight ${inFlight} → ${pulled}`);
    }
  }
});

test("implementers: PULL takes B − n heads, never more than the heads there are", () => {
  assert.deepEqual(pulledHeads(state({ bound: 5, inFlight: 3, heads: [1, 2, 3, 4] })), [1, 2]);
  assert.deepEqual(pulledHeads(state({ bound: 5, inFlight: 4, heads: [1, 2] })), [1]);
  assert.deepEqual(pulledHeads(state({ bound: 5, heads: [7] })), [7]);
});

test("implementers: at the bound nothing is pulled, however many heads are waiting", () => {
  const r = row(state({ inFlight: 5, heads: [1, 2, 3] }), "implementers");
  assert.equal(r.action, "HOLD (in-flight 5/5)");
  assert.equal(r.acts, false);
});

test("implementers: at the bound with a killed implementer's replacement owed, the hold acts and names the dispatch; a tier mismatch outranks it", () => {
  const owed = row(state({ inFlight: 5, inFlightImpl: 1, inFlightPrs: 4, owedCounted: ["impl-7"], implNames: ["impl-7"], heads: [1] }), "implementers");
  assert.equal(owed.action, "HOLD (in-flight 5/5)");
  assert.equal(owed.acts, true, "no merge can clear a ticket with no PR: the replacement is the controller's move");
  assert.match(owed.detail, / — dispatch impl-7-b at its row's tier$/);
  const several = row(state({ inFlight: 5, owedCounted: ["impl-7", "impl-8"], implNames: ["impl-7", "impl-8"] }), "implementers");
  assert.match(several.detail, / — dispatch impl-7-b, impl-8-b each at its row's tier$/);
  const quiet = row(state({ inFlight: 5, heads: [1] }), "implementers");
  assert.equal(quiet.acts, false, "with none owed the hold stays quiet");
  assert.doesNotMatch(quiet.detail, /dispatch/);
  assert.equal(row(state({ inFlight: 4, owedCounted: ["impl-7"], implNames: ["impl-7"], heads: [1] }), "implementers").action, "PULL #1 — pull.mjs next --head 1", "below the bound it still pulls");
  const mismatch = row(state({ inFlight: 5, owedCounted: ["impl-7"], implNames: ["impl-7"], tierMismatch: ["impl-7"] }), "implementers");
  assert.equal(mismatch.action, "HOLD (tier mismatch impl-7)");
});

test("implementers: HOLD (in-flight n/B) whenever n ≥ B — the wording, n/B on the row, acts false, an inherited n over B printed as 7/5", () => {
  for (const [bound, inFlight] of [[1, 1], [2, 2], [5, 5], [5, 6], [5, 7], [9, 12]]) {
    const r = row(state({ bound, inFlight, heads: [1] }), "implementers");
    assert.equal(r.action, `HOLD (in-flight ${inFlight}/${bound})`);
    assert.equal(`${r.actual}/${r.target}`, `${inFlight}/${bound}`);
    assert.equal(r.acts, false);
  }
  assert.equal(row(state({ bound: 5, inFlight: 4, heads: [1] }), "implementers").action, "PULL #1 — pull.mjs next --head 1", "one below the bound still pulls");
  assert.equal(formatLines(reconcile(state({ inFlight: 7, inFlightImpl: 2, inFlightPrs: 5, heads: [4, 5, 6], supply: 57 })))[0],
    "implementers 7/5 → HOLD (in-flight 7/5)   (implementers=2 prs=5 unclaimed=3 supply=57)");
});

test("implementers: the in-flight hold ranks below the overlays, draining and both tier holds — and the tier holds stay actionable", () => {
  const held = { inFlight: 5, heads: [7] };
  const act = (over) => row(state({ ...held, ...over }), "implementers");
  assert.equal(act({}).action, "HOLD (in-flight 5/5)");
  assert.equal(act({ phase0: { held: true, line: "x", session: null } }).action, "HOLD (phase 0 incomplete)");
  assert.equal(act({ mainCheckout: { state: "dirty", changed: ["x"] } }).action, "HOLD (main checkout dirty)");
  assert.equal(act({ draining: "x", tierMismatch: ["impl-4"], tierUnchecked: ["impl-5"] }).action, "HOLD (draining)");
  const mismatch = act({ tierMismatch: ["impl-4"], tierUnchecked: ["impl-5"] });
  assert.equal(mismatch.action, "HOLD (tier mismatch impl-4)");
  assert.equal(mismatch.acts, true, "the tier hold stays visible and actionable while the bound also holds");
  const unchecked = act({ tierUnchecked: ["impl-5"] });
  assert.equal(unchecked.action, "HOLD (tier unchecked impl-5)");
  assert.equal(unchecked.acts, true);
  assert.equal(actionable(reconcile(state({ ...held }))), false, "the bound hold alone is quiet");
  assert.equal(actionable(reconcile(state({ ...held, tierMismatch: ["impl-4"] }))), true);
});

test("implementers: draining holds the row and outranks every other branch", () => {
  for (const over of [{}, { inFlight: 5 }, { inFlight: 9 }, { tierMismatch: ["impl-4"] }, { tierUnchecked: ["impl-4"] }, { reviewDue: [1], fixLive: 6 }]) {
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
  assert.match(r.detail, /^implementers=0 prs=0 unclaimed=1 supply=0 — /, "the counts stay in front of the clearing step");
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
  const counts = "implementers=0 prs=0 unclaimed=0 supply=0";
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

test("implementers: with the phase-0 receipt naming the session, the tier step's batch entries carry no <session> placeholder", () => {
  const r = row(state({ heads: [7], tierUnchecked: ["impl-412", "impl-9"], phase0: { held: false, line: null, session: "/s/run" } }), "implementers");
  assert.ok(r.detail.includes(
    `run ~/.fleet/bin/fleet-run tier-check.mjs --batch <file> with [{"member":"impl-412"},{"member":"impl-9"}]`), r.detail);
  assert.doesNotMatch(r.detail, /<session>/);
});

test("implementers: no tier hold, no clearing step in the detail", () => {
  for (const over of [{ heads: [7] }, { draining: "x", tierUnchecked: ["impl-4"] }, {}]) {
    assert.doesNotMatch(row(state(over), "implementers").detail, /—/, JSON.stringify(over));
  }
});

test("implementers: the detail is implementers=<i> prs=<p> unclaimed=<k> supply=<s>, with no unreviewed=", () => {
  const r = row(state({ inFlight: 5, inFlightImpl: 2, inFlightPrs: 3, heads: [4, 5, 6], supply: 57, reviewDue: [1] }), "implementers");
  assert.equal(r.detail, "implementers=2 prs=3 unclaimed=3 supply=57");
  assert.equal(row(state({ supply: null, shortlistStatus: "missing" }), "implementers").detail, "implementers=0 prs=0 unclaimed=0 supply=? shortlist=missing");
  const tier = row(state({ inFlight: 2, inFlightImpl: 1, inFlightPrs: 1, tierMismatch: ["impl-412"] }), "implementers");
  assert.match(tier.detail, /^implementers=1 prs=1 unclaimed=0 supply=0 — dispatch impl-412-b at its row's tier$/);
  for (const over of [{}, { reviewDue: [1, 2], fixLive: 6 }, { inFlight: 5 }, { tierUnchecked: ["impl-4"] }]) {
    assert.doesNotMatch(row(state(over), "implementers").detail, /unreviewed/, JSON.stringify(over));
  }
});

// The rows candidates.mjs's to-spec filter removed never reach `supply`, so
// without this an all-specs queue reads `supply=0` and `SUGGEST /triage` —
// "no work" — while a ready-for-agent ticket sits there.
const TO_SPEC = "to-spec: User Stories heading";
test("implementers: every to-spec drop is named by number and reason, whatever the action, and never makes the row actionable", () => {
  const all = row(state({ dropped: [{ n: 2151, reason: TO_SPEC }] }), "implementers");
  assert.equal(all.action, "SUGGEST /triage, hold idle");
  assert.equal(all.acts, false);
  assert.equal(all.detail, `implementers=0 prs=0 unclaimed=0 supply=0 specs-dropped=#2151 (${TO_SPEC})`);
  // A partial drop: survivors are Pulled and the drops still named.
  const partial = row(state({ heads: [7], supply: 1, dropped: [{ n: 6, reason: TO_SPEC }, { n: 9, reason: TO_SPEC }] }), "implementers");
  assert.equal(partial.action, "PULL #7 — pull.mjs next --head 7");
  assert.match(partial.detail, new RegExp(`^implementers=0 prs=0 unclaimed=1 supply=1 specs-dropped=#6 #9 \\(${TO_SPEC}\\)$`));
  // One clause per reason, in the order the reasons first appear.
  const mixed = row(state({ dropped: [{ n: 3, reason: "b" }, { n: 4, reason: "a" }, { n: 5, reason: "b" }] }), "implementers");
  assert.match(mixed.detail, /specs-dropped=#3 #5 \(b\), #4 \(a\)$/);
});

test("implementers: a genuinely empty queue carries no specs-dropped text", () => {
  const r = row(state(), "implementers");
  assert.equal(r.action, "SUGGEST /triage, hold idle");
  assert.equal(r.detail, "implementers=0 prs=0 unclaimed=0 supply=0");
});

// ---------------------------------------------------------------------------
// The reviewer rows.

test("reviewers: nothing owed and nothing in flight is idle", () => {
  const r = row(state(), "reviewers");
  assert.equal(r.action, "IDLE OK");
  assert.equal(r.target, 5);
  assert.equal(r.acts, false);
});

test("reviewers: fix-appliers are named before reviews — finish what is started", () => {
  const rs = rowsOf(state({ fixDue: [346, 348], reviewDue: [350, 351] }), "reviewers");
  assert.deepEqual(rs.map((r) => r.action), ["DISPATCH fix-pr PR#346 PR#348", "DISPATCH review PR#350 PR#351"]);
  assert.ok(rs.every((r) => r.acts));
  // No cap: a reviewer side with units already live still takes both.
  const live = rowsOf(state({ fixLive: 5, fixDue: [346], reviewDue: [350] }), "reviewers");
  assert.deepEqual(live.map((r) => r.action), ["DISPATCH fix-pr PR#346", "DISPATCH review PR#350"]);
});

test("reviewers: every due fix and every due review is dispatched with no cap, fix-appliers first", () => {
  for (const bound of [1, 5]) {
    for (const [reviewsLive, fixLive] of [[0, 0], [1, 0], [0, 3], [2, 4], [4, 4], [9, 9]]) {
      const rs = rowsOf(state({ bound, reviewsLive, fixLive, fixDue: [1, 2, 3, 4], reviewDue: [5, 6, 7, 8] }), "reviewers");
      assert.deepEqual(rs.map((r) => r.action), ["DISPATCH fix-pr PR#1 PR#2 PR#3 PR#4", "DISPATCH review PR#5 PR#6 PR#7 PR#8"],
        `bound ${bound} live ${reviewsLive}+${fixLive}`);
      assert.ok(rs.every((r) => r.acts));
    }
  }
});

test("reviewers: the row prints <units>/<B>, an inherited run over B printing the overflow", () => {
  const r = row(state({ bound: 5, reviewsLive: 2, fixLive: 1 }), "reviewers");
  assert.equal(`${r.actual}/${r.target}`, "3/5");
  const inherited = row(state({ bound: 5, inFlight: 7, inFlightPrs: 7, reviewsLive: 5, fixLive: 2, reviewDue: [9] }), "reviewers");
  assert.equal(`${inherited.actual}/${inherited.target}`, "7/5");
  assert.equal(inherited.action, "DISPATCH review PR#9");
  assert.equal(formatLines(reconcile(state({ reviewDue: [350, 351], reviewsLive: 1 })))[1],
    "reviewers    1/5 → DISPATCH review PR#350 PR#351   (reviews=1 fix-pr=0 fix-due=0 review-due=2)");
});

test("reviewers: no state prints AT CAP, HOLD (max-reviews …) or HOLD (review side saturated)", () => {
  const bad = /AT CAP|max-reviews|saturated/;
  let seen = 0;
  for (const bound of [1, 5]) {
    for (const inFlight of [0, 5, 9]) {
      for (const [reviewsLive, fixLive] of [[0, 0], [3, 0], [0, 9], [9, 9]]) {
        for (const [fixDue, reviewDue] of [[[], []], [[1], []], [[], [2]], [[1, 2], [3, 4]]]) {
          for (const heads of [[], [7]]) {
            const rows = reconcile(state({ bound, inFlight, reviewsLive, fixLive, fixDue, reviewDue, heads }))
              .filter((r) => r.role !== "merge-bot");
            for (const r of rows) {
              assert.doesNotMatch(`${r.action} ${r.detail}`, bad, JSON.stringify({ bound, inFlight, reviewsLive, fixLive, fixDue, reviewDue, heads }));
              seen += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(seen > 0);
  assert.equal(row(state({ mergeBotLive: 1, mergeQueue: 3 }), "merge-bot").action, "AT CAP", "the merge-bot row keeps its AT CAP");
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
  const over = rowsOf(state({ fixLive: 6, fixDue: [1], unlabelled }), "reviewers");
  assert.deepEqual(over.map((r) => r.action), ["DISPATCH fix-pr PR#1", "DISPATCH finisher PR#40 PR#44"], "units live never hold a finisher");
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

test("reviewers: a conflict line prints beside every owed dispatch, and sits after the unlabelled rows", () => {
  const full = rowsOf(state({ fixLive: 6, fixDue: [1], reviewDue: [2], conflicts: [40], conflictEscalate: [41] }), "reviewers");
  assert.deepEqual(full.map((r) => r.action), ["DISPATCH fix-pr PR#1", "DISPATCH review PR#2", "CONFLICT PR#40", "ESCALATE conflict PR#41"]);
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
  const changed = reconcile(state({ refresh: { ok: true, entries: 5, lifted: 1, changed: true, trigger: "unclaimed 0 < in-flight bound 5" } })).at(-1);
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
      refresh: { ok: true, entries: 3, lifted: 0, changed: true, trigger: "unclaimed 1 < in-flight bound 5" },
    }))),
    [
      "implementers 0/5 → PULL #412 — pull.mjs next --head 412   (implementers=0 prs=0 unclaimed=1 supply=57)",
      "reviewers    0/5 → DISPATCH fix-pr PR#346   (reviews=0 fix-pr=0 fix-due=1 review-due=1)",
      "reviewers    0/5 → DISPATCH review PR#350   (reviews=0 fix-pr=0 fix-due=1 review-due=1)",
      "merge-bot    0/1 → DISPATCH merge-bot   (merge-queue=2 held=1)",
      "shortlist    → REFRESHED shortlist: 3 entries; 0 lifted   (unclaimed 1 < in-flight bound 5)",
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
  assert.equal(acts({ inFlight: 5, heads: [1] }), false, "HOLD (in-flight 5/5)");
  assert.equal(acts({ draining: "x", heads: [1] }), false, "HOLD (draining)");
});

// ---------------------------------------------------------------------------
// The main-checkout hold (#2210): anything but `clean` holds every
// dispatching row.

const BUSY = {
  heads: [412], fixDue: [346], reviewDue: [350], mergeQueue: 1,
  refresh: { ok: true, entries: 3, lifted: 0, changed: true, trigger: "unclaimed 1 < in-flight bound 5" },
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
  const [impl] = reconcile(state({ ...BUSY, inFlight: 1, mainCheckout: { state: "dirty", changed: ["x"] } }));
  assert.equal(`${impl.actual}/${impl.target}`, "1/5", "the held row lost its counts");
});

test("main checkout: unknown holds too, never clean; so does a check that gave no answer at all", () => {
  for (const mainCheckout of [{ state: "unknown", cause: "read", why: "boom" }, { state: "unknown", cause: "baseline", why: "x" }, { state: "unknown", cause: "missing", why: "y" }, undefined]) {
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
    ["PULL #412 — pull.mjs next --head 412", "DISPATCH fix-pr PR#346", "DISPATCH review PR#350", "DISPATCH merge-bot"]);
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

test("phase 0: an unfinished phase 0 holds every dispatching row, keeps their counts, and lets the conflict rows print", () => {
  const phase0 = { held: true, line: "PHASE0-INCOMPLETE recipe", session: null };
  assert.deepEqual(summary(state({ ...BUSY, refresh: null, conflicts: [40], phase0 })), [
    ["implementers", "HOLD (phase 0 incomplete)", false],
    ["reviewers", "HOLD (phase 0 incomplete)", false],
    ["reviewers", "CONFLICT PR#40", true],
    ["merge-bot", "HOLD (phase 0 incomplete)", false],
  ]);
  const [impl] = reconcile(state({ ...BUSY, inFlight: 1, phase0 }));
  assert.equal(`${impl.actual}/${impl.target}`, "1/5", "the held row lost its counts");
});

test("phase 0: its hold outranks the main-checkout reason and every role's guards; a missing baseline under it still asks to act", () => {
  const phase0 = { held: true, line: "x", session: null };
  const dirty = state({ ...BUSY, refresh: null, draining: "x", tierMismatch: ["impl-1"], phase0, mainCheckout: { state: "dirty", changed: ["x"] } });
  assert.deepEqual(reconcile(dirty).map((r) => r.action), Array(3).fill("HOLD (phase 0 incomplete)"));
  assert.equal(actionable(reconcile(dirty)), false);
  const absent = reconcile(state({ ...BUSY, refresh: null, phase0, mainCheckout: { state: "absent", baseline: "/x" } }));
  assert.deepEqual(absent.map((r) => r.action), Array(3).fill("HOLD (phase 0 incomplete)"));
  assert.equal(actionable(absent), true);
});

test("phase 0: a gate that gave no answer holds, never reads as finished", () => {
  assert.deepEqual(reconcile(state({ ...BUSY, refresh: null, phase0: undefined })).map((r) => r.action), Array(3).fill("HOLD (phase 0 incomplete)"));
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
      "#11 impl-11=PR#21 → PR#21 · review=wf:run2 reviewed=abc1234:2/1/0:run-abc1234r · fix-pr-21",
      "#12 impl-12=PR#22 → PR#22 · review=member:review-pr-22 reviewed=abc1234:0/0/0:run-abc1234r",
      "#13 impl-13=PR#23 → PR#23 · review=wf:run3=failed",
      "#14 impl-14=PR#24 → PR#24 · review=wf:run4=failed review=member:review-pr-24",
    ],
    dispatched: ["fix-pr-21"],
  }, [pr(20), pr(21), pr(22), pr(23), pr(24)]);
  assert.equal(r.reviewsLive, 2, "run1 and the runner are in flight; run2 returned, run3 is dead");
  assert.equal(r.fixLive, 1);
});

test("deriveRun: live names every unsettled member and each in-flight review by its PR — a review=wf: run has no member token of its own", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#20 → PR#20 · review=wf:run1",
      "#11 impl-11=PR#21 → PR#21 · review=wf:run2 reviewed=abc1234:2/1/0:run-abc1234r · fix-pr-21",
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
  const rows = [...ZOMBIE_ROWS, "#40 impl-40=PR#50 → PR#50 · review=member:review-pr-50 reviewed=abc1234:0/0/0:run-abc1234r"];
  const r = run({ rows }, [], undefined, new Set([20, 21, 22, 50]));
  assert.deepEqual([r.reviewsLive, r.reviewsOffList, r.live], [0, [20, 21, 22], []]);
  assert.deepEqual(r.reviewed.map((x) => x.pr), [50], "the returned review is still on record");
});

test("deriveRun: fix-pr is due on a returned review with survived or unverified findings and no fix-applier since", () => {
  const r = run({
    rows: [
      "#10 impl-10=PR#20 → PR#20 · review=wf:a reviewed=abc1234:2/0/0:run-abc1234r",
      "#11 impl-11=PR#21 → PR#21 · review=wf:b reviewed=abc1234:0/3/1:run-abc1234r",
      "#12 impl-12=PR#22 → PR#22 · review=wf:c reviewed=abc1234:1/0/0:run-abc1234r · fix-pr-22=applied:def5678",
      // Re-reviewed after its fix, and the second review found more.
      "#13 impl-13=PR#23 → PR#23 · review=wf:d reviewed=abc1234:1/0/0:run-abc1234r · fix-pr-23=applied:def5678 review=wf:e reviewed=def5678:1/0/0:run-def5678r",
      // A closed PR is nobody's work.
      "#14 impl-14=PR#24 → PR#24 · review=wf:f reviewed=abc1234:4/0/0:run-abc1234r",
      // Everything refuted: nothing for a fix-applier to rule on.
      "#15 impl-15=PR#25 → PR#25 · review=wf:g reviewed=abc1234:0/3/0:run-abc1234r",
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
  const at = (tail) => run({ rows: [`#20 impl-20=PR#21 → PR#21 · review=wf:a reviewed=abc1234:0/2/6:run-abc1234r${tail}`] }, [pr(21)]);
  const due = at("");
  assert.deepEqual(due.fixDue, [21]);
  assert.equal(row(state({ fixDue: due.fixDue }), "reviewers").action, "DISPATCH fix-pr PR#21");
  assert.deepEqual(at(" · fix-pr-21").fixDue, [], "a live fix-applier is not re-offered");
  assert.deepEqual(at(" · fix-pr-21=no-op · dispositions-ok=fix-pr-21:run-abc1234r").fixDue, [], "a landed no-op answers it");
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
  const r = run({ rows: ["#350 review=wf:x reviewed=abc1234:1/0/0:run-abc1234r"] }, [pr(350)]);
  assert.deepEqual(r.fixDue, [350]);
  assert.deepEqual(r.reviewDue, []);
});

// #2083: a finisher that halts `past-pin` found commits past the head the
// review read. Once a review has RETURNED, `reviewedAny` holds it out of
// review-due for good, so marking the review failed cannot re-queue it —
// the halt itself does, until a new review is running or has returned.
test("deriveRun: a finisher halted past-pin re-queues the review while the head is past the reviewed one", () => {
  const row = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-40=halted:past-pin";
  assert.deepEqual(run({ rows: [row] }, [pr(40, [], [10], HEAD_B)]).reviewDue, [40]);
  // Settled only in `## Dispatched`, a bare copy on the row: settled anywhere is settled.
  assert.deepEqual(run({
    rows: ["#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-40"],
    dispatched: ["finisher-pr-40=halted:past-pin"],
  }, [pr(40, [], [10], HEAD_B)]).reviewDue, [40]);
  // A re-review that died before returning leaves it owed.
  assert.deepEqual(run({ rows: [`${row} review=wf:b=failed`] }, [pr(40, [], [10], HEAD_B)]).reviewDue, [40]);
});

test("deriveRun: a head past reviewed= with no past-pin halt stays not due — a fix-applier's push is finisher duty 2's", () => {
  const base = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:1/0/0:run-abc1234r · fix-pr-40=applied:def5678";
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
  const halted = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-40=halted:past-pin";
  const not = (row, head) => assert.deepEqual(run({ rows: [row] }, [pr(40, [], [10], head)]).reviewDue, [], `${row} @ ${head}`);
  not(halted, HEAD_A); // the reviewed head IS the PR head — nothing unread
  not(halted, HEAD_A.toUpperCase());
  not(`${halted} review=wf:b`, HEAD_B); // the re-review is in flight
  not(`${halted} review=wf:b reviewed=def5678:0/0/0:run-def5678r`, HEAD_B); // and returned
  // A fix-applier's push after that re-review is duty 2's again, not a second re-review.
  not(`${halted} review=wf:b reviewed=def5678:1/0/0:run-def5678r · fix-pr-40=applied:0123456`, "0123456" + "0".repeat(33));
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
  for (const rows of [[ticket, "#724 review=member:review-pr-724 reviewed=abc1234:2/1/0:run-abc1234r"], ["#724 review=member:review-pr-724 reviewed=abc1234:2/1/0:run-abc1234r", ticket]]) {
    const r = run({ rows }, prs);
    assert.deepEqual([r.reviewsLive, r.fixDue, r.reviewDue], [0, [724], []], `${rows}`);
    assert.ok(r.claimed.has(658), "the ticket row still reads as claimed");
  }
});

// #2888: a prose `PR#` mention on a row carrying an `impl-` token is not the
// row's PR — the settled `impl-<N>=PR#<M>` token is, wherever either sits.
test("deriveRun: a ticket row's review state is its settled impl PR's, whatever PR# its prose mentions", () => {
  const prs = [pr(470, [], [480]), pr(481, [], [490])];
  const other = "#481 review=wf:b reviewed=abc1234:0/0/0:run-abc1234r";
  for (const ticket of [
    "#480 correction: PR#481 was wrong · impl-480=PR#470 · review=wf:a reviewed=abc1234:1/0/0:run-abc1234r",
    "#480 impl-480=PR#470 · review=wf:a reviewed=abc1234:1/0/0:run-abc1234r · note: the PR#481 guards",
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
  const r = run({ rows: ["#480 impl-480 · PR#481 closed unmerged · review=wf:a reviewed=abc1234:1/0/0:run-abc1234r"] }, [pr(481, [], [490])]);
  assert.deepEqual(r.reviewed.map((x) => x.pr), [480]);
  assert.deepEqual(r.fixDue, []);
  assert.deepEqual(r.reviewDue, [481], "PR 481 carries no review of its own");
});

// #2331: a finisher can settle `labelled` without ever adding the label. The
// open-PR list the tick already reads says so; a `label-off=<attempt>` token
// marks the controller's own deliberate removals, so they never read as a miss.
const LABELLED = "#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-40=labelled";

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
const HOLD_ROW = (n, tail) => `#${n - 30} impl-${n - 30}=PR#${n} → PR#${n} · reviewed=abc1234:0/2/0:run-abc1234r · ${tail}`;

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
      HOLD_ROW(46, "conflict-hold:#46 · fix-pr-46=applied:def5678 · review=wf:x reviewed=def5678:0/1/0:run-def5678r"),
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
  const R = (tail) => `#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · ${tail}`;
  const at = (tail, dispatched = []) => run({ rows: [R(tail)], dispatched }, [pr(21, ["ready-to-merge"])]);
  const held = at("conflict-hold:#21");
  assert.deepEqual([held.fixDue, held.conflictHeld], [[21], [21]]);
  const working = at("conflict-hold:#21 · fix-pr-21");
  assert.deepEqual([working.fixDue, working.conflictHeld], [[], [21]], "the live conflict fix-applier is not joined by a review one");
  const landed = at("conflict-hold:#21 · fix-pr-21=applied:def5678");
  assert.deepEqual([landed.fixDue, landed.conflictHeld, landed.mergeHeld], [[21], [], 0], "the survivors are re-offered, the hold is gone");
  // The hold read before the review is the same conflict fix-applier.
  assert.deepEqual(run({ rows: ["#20 impl-20=PR#21 → PR#21 · conflict-hold:#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-21=no-op"] }, [pr(21)]).fixDue, [21]);
  // The review fix-applier that follows answers them.
  assert.deepEqual(at("conflict-hold:#21 · fix-pr-21=applied:def5678 · fix-pr-21-b=applied:0123abc").fixDue, []);
  assert.deepEqual(at("conflict-hold:#21 · fix-pr-21=applied:def5678 · fix-pr-21-b").fixDue, [], "…and is not re-offered while live");
  assert.deepEqual(at("conflict-hold:#21 · fix-pr-21=applied:def5678 · fix-pr-21-b=failed").fixDue, [21], "a dead one leaves them due");
});

test("deriveRun: survivors a review fix-applier already answered stay answered through a later hold and its fix", () => {
  const R = (tail) => `#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-21=applied:def5678 · ${tail}`;
  const held = run({ rows: [R("conflict-hold:#21")] }, [pr(21)]);
  assert.deepEqual([held.fixDue, held.conflictHeld], [[21], [21]], "the hold is due on its own");
  const cleared = run({ rows: [R("conflict-hold:#21 · fix-pr-21-b=applied:0123abc")] }, [pr(21)]);
  assert.deepEqual([cleared.fixDue, cleared.conflictHeld], [[], []], "nothing left: the survivors were answered before the hold");
  // A live review fix-applier when the hold lands is not joined by a conflict one.
  const live = run({ rows: ["#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-21 · conflict-hold:#21"] }, [pr(21)]);
  assert.deepEqual([live.fixDue, live.conflictHeld], [[], [21]]);
});

// A dispositions mismatch is answered by one automatic retry: the PR returns
// to fix-due on the row that already dispatches fix-appliers, once, until the
// retry has been checked. A second failure is escalate, and escalate is a hold
// no fix-applier answers.
const D = (fix, ...tokens) => `#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · ${[...fix, ...tokens].join(" · ")}`;
const MISMATCH = "dispositions-mismatch=fix-pr-21:run-abc1234r";
const dueAt = (tail, prs = [pr(21)]) => run({ rows: [D(["fix-pr-21=applied:def5678"], ...tail)] }, prs).fixDue;

test("deriveRun: a first dispositions mismatch puts the PR back in fixDue, and the reviewers row prints it", () => {
  const r = run({ rows: [D(["fix-pr-21=applied:def5678"], MISMATCH)] }, [pr(21)]);
  assert.deepEqual(r.fixDue, [21]);
  assert.equal(row(state({ fixDue: r.fixDue }), "reviewers").action, "DISPATCH fix-pr PR#21");
  // The survivors alone were answered: with an ok verdict the PR is not due.
  assert.deepEqual(dueAt(["dispositions-ok=fix-pr-21:run-abc1234r"]), []);
  // No other role's row moves on the mismatch.
  const others = (fixDue) => reconcile(state({ fixDue })).filter((x) => x.role !== "reviewers");
  assert.deepEqual(others(r.fixDue), others([]));
});

test("deriveRun: a mismatch is due whether the review counted survivors or only unverified findings", () => {
  const unverifiedOnly = run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:0/0/2:run-abc1234r · fix-pr-21=applied:def5678 · ${MISMATCH}`] }, [pr(21)]);
  assert.deepEqual(unverifiedOnly.fixDue, [21]);
});

test("deriveRun: the retry is not re-offered while live, nor before its own check has run, nor after any verdict of its own", () => {
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b"]), [], "live");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc"]), [], "settled, its check not yet run: the earlier mismatch is not the retry's answer");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc", "dispositions-ok=fix-pr-21-b:run-abc1234r"]), [], "ok ends it");
  assert.deepEqual(dueAt([MISMATCH, "fix-pr-21-b=applied:0123abc", "dispositions-escalate=fix-pr-21-b:run-abc1234r"]), [], "escalate is never due");
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

test("deriveRun: the verdict is read by review run and highest retry, never by position in the row", () => {
  const escalated = ["dispositions-escalate=fix-pr-21-b:run-abc1234r", MISMATCH];
  assert.deepEqual(dueAt(["fix-pr-21-b=applied:0123abc", ...escalated]), [], "the -b escalate answers, wherever it sits");
  // A mismatch on an older review does not answer a newer one.
  const newer = run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-21=applied:def5678 · ${MISMATCH} · review=wf:x reviewed=fedcba9:0/1/0:run-fedcba9r`] }, [pr(21)]);
  assert.deepEqual(newer.fixDue, [], "the new review has no verdict and no survivors");
  const rev = run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-21=applied:def5678 · ${MISMATCH} · review=wf:x`] }, [pr(21)]);
  assert.deepEqual(rev.fixDue, [], "a review running on the PR holds it off");
  assert.deepEqual(dueAt([MISMATCH], []), [], "a PR no longer open is nobody's work");
});

// #2886: two reviews at one head are two runs. Round 1's verdict answered round
// 1's findings only, so round 2's survivors are owed a fix-applier and its
// gate reads no verdict yet.
test("deriveRun: a second review at the same head is answered by none of the first review's verdicts", () => {
  const round1 = "reviewed=abc1234:2/0/0:run-Round1aa · fix-pr-21=applied:def5678 · dispositions-ok=fix-pr-21:run-Round1aa";
  const r = run({ rows: [`#20 impl-20=PR#21 → PR#21 · ${round1} · review=wf:x reviewed=abc1234:1/0/0:run-Round2bb`] }, [pr(21)]);
  assert.deepEqual(r.reviewed, [{ pr: 21, head: "abc1234", run: "run-Round2bb", survived: 1, unverified: 0, dispositions: null, fixLive: [] }]);
  assert.deepEqual(r.fixDue, [21]);
  // Control: the same verdict answers the review whose run it names.
  const once = run({ rows: [`#20 impl-20=PR#21 → PR#21 · ${round1}`] }, [pr(21)]);
  assert.deepEqual(once.reviewed[0].dispositions, { verdict: "ok", member: "fix-pr-21" });
  assert.deepEqual(once.fixDue, []);
});

// A verdict naming a run that is not the eight characters `mktemp` chose is no
// verdict token at all, not one that merely answers another review: at the
// gate the two read alike, so only the token's own shape tells them apart.
test("dispositionsToken: a run that is not run- and eight characters, whole, is not a verdict", () => {
  assert.deepEqual(dispositionsToken("dispositions-ok=fix-pr-21:run-abc1234r")?.run, "run-abc1234r");
  for (const bad of ["run-abc1234", "run-abc1234rs", "run-abc1234r:x", "abc1234r", "run-abc1234!"]) {
    assert.equal(dispositionsToken(`dispositions-ok=fix-pr-21:${bad}`), null, bad);
  }
});

test("currentDispositions: escalate parses, and outranks mismatch which outranks ok at one retry suffix", () => {
  assert.deepEqual(dispositionsToken("dispositions-escalate=fix-pr-21-b:run-abc1234r")?.verdict, "escalate");
  assert.equal(dispositionsToken("dispositions-escalate=finisher-pr-21:run-abc1234r"), null);
  const heads = (...s) => currentDispositions(s.map(dispositionsToken), "run-abc1234r");
  assert.deepEqual(heads("dispositions-ok=fix-pr-21:run-abc1234r", "dispositions-escalate=fix-pr-21:run-abc1234r"), { verdict: "escalate", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-escalate=fix-pr-21:run-abc1234r", "dispositions-mismatch=fix-pr-21:run-abc1234r"), { verdict: "escalate", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-escalate=fix-pr-21:run-abc1234r", "dispositions-ok=fix-pr-21-b:run-abc1234r"), { verdict: "ok", member: "fix-pr-21-b" });
});

test("currentDispositions: unchecked parses, outranks ok and is outranked by mismatch at one retry suffix, and is never fix-due", () => {
  assert.deepEqual(dispositionsToken("dispositions-unchecked=fix-pr-21-b:run-abc1234r")?.verdict, "unchecked");
  assert.equal(dispositionsToken("dispositions-unchecked=finisher-pr-21:run-abc1234r"), null);
  const heads = (...s) => currentDispositions(s.map(dispositionsToken), "run-abc1234r");
  assert.deepEqual(heads("dispositions-ok=fix-pr-21:run-abc1234r", "dispositions-unchecked=fix-pr-21:run-abc1234r"), { verdict: "unchecked", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-unchecked=fix-pr-21:run-abc1234r", "dispositions-mismatch=fix-pr-21:run-abc1234r"), { verdict: "mismatch", member: "fix-pr-21" });
  assert.deepEqual(heads("dispositions-unchecked=fix-pr-21:run-abc1234r", "dispositions-ok=fix-pr-21-b:run-abc1234r"), { verdict: "ok", member: "fix-pr-21-b" });
  // A landed fix-applier whose check could not read the tracker is answered
  // by running the check again, never by another fix-applier.
  const due = (verdict) => run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-21=applied:abc1234 · dispositions-${verdict}=fix-pr-21:run-abc1234r`] }, [pr(21)]).fixDue;
  assert.deepEqual(due("mismatch"), [21], "control: a mismatch on the same row is fix-due");
  assert.deepEqual(due("unchecked"), []);
});

test("deriveRun: a newer review's survivors are not offered beside a live fix-applier, and are due once it settles", () => {
  // `dispatch` would refuse a second live one. Settled, it was dispatched
  // before that review, so it never answered the newer survivors.
  const rereviewed = (fix) => run({ rows: [`#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · ${fix} · review=wf:x reviewed=def5678:1/0/0:run-def5678r`] }, [pr(21)]).fixDue;
  assert.deepEqual(rereviewed("fix-pr-21"), []);
  assert.deepEqual(rereviewed("fix-pr-21=applied:def5678"), [21]);
  assert.deepEqual(rereviewed("fix-pr-21=failed"), [21]);
});

// One fix-applier does one job, so its landing folds once per PR however many
// copies of its token the rows carry — a whole-line `row` rewrite leaves bare
// copies wherever it chose, and the in-place settled copy is the one that says
// where it was dispatched.
test("deriveRun: duplicate copies of one fix-applier's token land it once — a conflict fix-applier never also answers the survivors", () => {
  const R = "#20 impl-20=PR#21 → PR#21 · reviewed=abc1234:2/0/0:run-abc1234r";
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
  assert.deepEqual(due(["#20 impl-20=PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-99=applied:def5678"]), [[21], []]);
  // Must accept: the PR's own fix-applier, live and landed.
  assert.deepEqual(due([`${H} · fix-pr-21`]), [[], [21]], "own live: not re-offered, still held");
  assert.deepEqual(due([`${H} · fix-pr-21=applied:def5678`]), [[], []], "own landed: the hold is cleared");
  // …and on the PR's own `#21` row, which names no `PR#` — its key is its PR.
  assert.deepEqual(due([H, "#21 fix-pr-21=applied:def5678"]), [[], []]);
  // An in-place settled copy on the ticket row, whose key is the ticket's and
  // whose PR is its `PR#` mention, is the PR's own: it still says where its
  // member landed, so a stale bare copy read first does not land it instead.
  assert.deepEqual(
    due(["#21 fix-pr-21", "#20 impl-20=PR#21 · reviewed=abc1234:2/0/0:run-abc1234r · conflict-hold:#21 · fix-pr-21=applied:def5678"],
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
  const reviewed = "#20 impl-20=PR#21 · reviewed=abc1234:0/0/0:run-abc1234r · fix-pr-21";
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
  const fin = "#20 impl-20=PR#21 · reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-21";
  const finStray = "#98 impl-98=PR#99 · finisher-pr-21=halted:past-pin";
  for (const rows of [[fin, finStray], [finStray, fin], [fin]]) {
    assert.deepEqual(run({ rows }, [pr(21), pr(99)]).reviewDue, [99], `live finisher, no halt: ${JSON.stringify(rows)}`);
  }
  assert.deepEqual(
    run({ rows: ["#20 impl-20=PR#21 · reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-21=halted:past-pin"] }, [pr(21)]).reviewDue,
    [21], "own-row halted:past-pin still re-offers the review");
});

test("deriveRun: a conflict hold is read in either spelling and on a PR-keyed row", () => {
  assert.deepEqual(run({ rows: [HOLD_ROW(40, "conflict-hold-#40")] }, [pr(40)]).fixDue, [40]);
  assert.deepEqual(run({ rows: ["#350 review=wf:x reviewed=abc1234:0/1/0:run-abc1234r · conflict-hold:#350"] }, [pr(350)]).fixDue, [350]);
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
const TRACKED = (n, tail = "") => `#${n - 30} impl-${n - 30}=PR#${n} → PR#${n} · reviewed=abc1234:0/0/0:run-abc1234r${tail ? ` · ${tail}` : ""}`;
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
  const reviewFix = run({ rows: [`#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:2/0/0:run-abc1234r · fix-pr-40=applied:def5678 · conflict-hold:#40 · fix-pr-40-b=no-op`] }, [conflicting(40)]);
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
    ["a reviewed= in the format before it named a run", { rows: ["#9 review=wf:a reviewed=abc1234:1/0/0"] }, /'reviewed=abc1234:1\/0\/0' names no review run/],
    ["a reviewed= whose run is not a run-XXXXXXXX name", { rows: ["#9 review=wf:a reviewed=abc1234:1/0/0:/tmp/pr9/run-abc1234r"] }, /is not reviewed=<head>:<survived>\/<refuted>\/<unverified>:<run>/],
    ["a reviewed= whose run is longer than the eight characters mktemp chose", { rows: ["#9 review=wf:a reviewed=abc1234:1/0/0:run-abc1234rs"] }, /is not reviewed=<head>:<survived>\/<refuted>\/<unverified>:<run>/],
    ["a reviewed= whose run is shorter than the eight characters mktemp chose", { rows: ["#9 review=wf:a reviewed=abc1234:1/0/0:run-abc1234"] }, /is not reviewed=<head>:<survived>\/<refuted>\/<unverified>:<run>/],
    ["a reviewed= whose run is followed by more text", { rows: ["#9 review=wf:a reviewed=abc1234:1/0/0:run-abc1234r:x"] }, /is not reviewed=<head>:<survived>\/<refuted>\/<unverified>:<run>/],
    ["a review= of no known kind", { rows: ["#9 review=bogus"] }, /review=bogus/],
    ["a conflict hold naming another PR", { rows: ["#10 impl-10=PR#40 → PR#40 · conflict-hold:#38"] }, /conflict-hold:#38.*PR #40/],
    ["a conflict hold on a row with no PR mention or PR-keyed impl token at all", { rows: ["conflict-hold:#40"] }, /no PR's/],
  ]) {
    assert.throws(() => run(ledger), why, what);
  }
});

// ---------------------------------------------------------------------------
// The In-flight count: n = i + p, read off the ledger and the open-PR list on
// every tick. Every case runs through `flight`, so n = i + p is asserted on
// each fixture below.

const flight = (ledger, prs = [], closed) => {
  const r = run(ledger, prs, closed);
  assert.equal(r.inFlight, r.inFlightImpl + r.inFlightPrs, "n = i + p");
  return r;
};
const memberRow = (n, outcome, tail = "") => ({
  rows: [`#${n} impl-${n}${outcome ? `=${outcome}` : ""}${tail}`], dispatched: [`impl-${n}${outcome ? `=${outcome}` : ""}`],
});
const counts = (r) => [r.inFlight, r.inFlightImpl, r.inFlightPrs];

test("deriveRun: an open issue-closing PR is In flight once, however many issues it closes", () => {
  assert.deepEqual(counts(flight({}, [pr(50, [], [7, 8])])), [1, 0, 1]);
  assert.deepEqual(counts(flight({}, [pr(50, [], [7]), pr(51, [], [8, 9, 10])])), [2, 0, 2]);
  // A live implementer on either issue is absorbed into the one PR.
  const both = flight({ rows: ["#7 impl-7", "#8 impl-8"], dispatched: ["impl-7", "impl-8"] }, [pr(50, [], [7, 8])]);
  assert.deepEqual(counts(both), [1, 0, 1]);
});

test("deriveRun: a live implementer with no open PR is In flight; with its PR open and unreported it counts once, as the PR", () => {
  assert.deepEqual(counts(flight(memberRow(7))), [1, 1, 0]);
  assert.deepEqual(counts(flight(memberRow(7), [pr(60, [], [7])])), [1, 0, 1], "the PR absorbs its ticket: no double count at the hand-off");
  assert.deepEqual(counts(flight(memberRow(7, "PR#60", " → PR#60"), [pr(60, [], [7])])), [1, 0, 1], "reported: still the one PR");
  assert.equal(run(memberRow(7)).implLive, 1, "implLive stays what it was");
  assert.deepEqual(counts(flight({ rows: ["#7 impl-7", "#8 impl-8", "#9 impl-9"], dispatched: ["impl-7", "impl-8", "impl-9"] }, [pr(60, [], [8])])), [3, 2, 1]);
});

test("deriveRun: a replacement owed — newest impl settled killed or tier-mismatch on an open issue — counts, and its live replacement counts the same one", () => {
  for (const outcome of ["killed", "tier-mismatch"]) {
    const owed = flight(memberRow(7, outcome));
    assert.deepEqual(counts(owed), [1, 1, 0], outcome);
    assert.deepEqual(owed.owedReplacement, ["impl-7"], outcome);
    const replaced = flight({ rows: [`#7 impl-7=${outcome} · impl-7-b`], dispatched: [`impl-7=${outcome}`, "impl-7-b"] });
    assert.deepEqual(counts(replaced), [1, 1, 0], `${outcome}: the replacement is the same ticket, n does not move`);
    assert.deepEqual(replaced.owedReplacement, [], `${outcome}: the newest member is live, so none is owed`);
  }
  // The replacement settles killed too: the ticket is owed again, still one.
  const again = flight({ rows: ["#7 impl-7=killed · impl-7-b=killed"], dispatched: ["impl-7=killed", "impl-7-b=killed"] });
  assert.deepEqual(counts(again), [1, 1, 0]);
  assert.deepEqual(again.owedReplacement, ["impl-7-b"]);
  // An open PR closing the ticket absorbs it: nothing is owed.
  const absorbed = flight(memberRow(7, "killed"), [pr(60, [], [7])]);
  assert.deepEqual(counts(absorbed), [1, 0, 1]);
  assert.deepEqual(absorbed.owedReplacement, []);
});

test("deriveRun: a newest impl settled blocked, bailed, released, or PR#M with PR M merged counts nothing", () => {
  for (const [what, ledger] of [
    ["blocked", memberRow(7, "blocked")],
    ["bailed", memberRow(7, "bailed")],
    ["released", memberRow(7, "released")],
    ["PR#M with PR M merged", memberRow(7, "PR#60", " → PR#60")],
    ["blocked replacement over a killed member", { rows: ["#7 impl-7=killed · impl-7-b=blocked"], dispatched: ["impl-7=killed", "impl-7-b=blocked"] }],
  ]) {
    const r = flight(ledger);
    assert.deepEqual(counts(r), [0, 0, 0], what);
    assert.deepEqual(r.owedReplacement, [], what);
    assert.ok(r.claimed.has(7), `${what}: the claim stands`);
  }
});

test("deriveRun: held and halted PRs count — conflict-hold, held-behind, halted:past-pin, dispositions-escalate, finisher failed, finisher killed", () => {
  const rowWith = (tail) => `#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:0/0/0:run-abc1234r · ${tail}`;
  for (const [what, tail, extra] of [
    ["conflict-hold", "conflict-hold:#40", {}],
    ["held-behind", "held-behind:#38", {}],
    ["halted:past-pin", "finisher-pr-40=halted:past-pin", {}],
    ["dispositions-escalate", "fix-pr-40=applied:def5678 · dispositions-escalate=fix-pr-40:run-abc1234r", {}],
    ["finisher failed", "finisher-pr-40=failed", {}],
    ["finisher killed", "finisher-pr-40=killed", {}],
    ["queued", "finisher-pr-40=labelled", { labels: ["ready-to-merge"] }],
  ]) {
    const r = flight({ rows: [rowWith(tail)] }, [pr(40, extra.labels ?? [], [10])]);
    assert.deepEqual(counts(r), [1, 0, 1], what);
  }
});

test("deriveRun: an Exclusion row counts nothing, and the PR it waits behind counts in its own right", () => {
  const r = flight({ rows: ["#50 excluded · behind-pr:#44", "#51 excluded · behind-issue:#9"] }, [pr(44)]);
  assert.deepEqual(counts(r), [1, 0, 1], "only PR 44 counts, and only because it closes an issue");
  assert.ok(r.claimed.has(50) && r.claimed.has(51), "the exclusions still gate their claims");
  assert.deepEqual(counts(flight({ rows: ["#50 excluded · behind-pr:#44"] }, [pr(44, [], [])])), [0, 0, 0], "a PR closing nothing is no premise worth counting");
});

test("deriveRun: inherited, human-authored and draft issue-closing PRs count from the first tick; a chore PR closing nothing never does", () => {
  assert.deepEqual(counts(flight({}, [pr(70)])), [1, 0, 1], "inherited: no ledger row at all");
  assert.deepEqual(counts(flight({}, [{ ...pr(71), isDraft: true }])), [1, 0, 1], "draft");
  assert.deepEqual(counts(flight({}, [{ ...pr(72), author: { login: "a-human", is_bot: false } }])), [1, 0, 1], "human-authored");
  assert.deepEqual(counts(flight({}, [pr(73, [], []), { ...pr(74, [], []), isDraft: true }])), [0, 0, 0], "chore PRs, this run's or inherited");
  assert.deepEqual(counts(flight(memberRow(7, "PR#75", " → PR#75"), [pr(75, [], [])])), [0, 0, 0], "this run's own PR, closing nothing");
  assert.deepEqual(counts(flight({}, [pr(70), pr(73, [], []), pr(76)])), [2, 0, 2]);
});

test("deriveRun: two open PRs closing one issue count two", () => {
  assert.deepEqual(counts(flight({}, [pr(80, [], [7]), pr(81, [], [7])])), [2, 0, 2]);
  assert.deepEqual(counts(flight(memberRow(7), [pr(80, [], [7]), pr(81, [], [7])])), [2, 0, 2], "and the implementer on that issue is absorbed into them");
});

test("deriveRun: an owed replacement whose issue is in closed counts nothing; unprobed it counts", () => {
  for (const outcome of ["killed", "tier-mismatch"]) {
    const ledger = memberRow(7, outcome);
    const probed = flight(ledger, [], new Set([7]));
    assert.deepEqual(counts(probed), [0, 0, 0], `${outcome}, issue CLOSED`);
    assert.deepEqual(probed.owedReplacement, ["impl-7"], `${outcome}: still owed, so still the probe's input`);
    assert.deepEqual(counts(flight(ledger, [], new Set([8]))), [1, 1, 0], `${outcome}: another ticket's closed state does not uncount it`);
    assert.deepEqual(counts(flight(ledger)), [1, 1, 0], `${outcome}, unprobed`);
  }
  // A closed set never uncounts a live implementer or an open PR.
  assert.deepEqual(counts(flight(memberRow(7), [pr(60, [], [8])], new Set([7, 8]))), [2, 1, 1]);
});

test("deriveRun: owedCounted names the owed replacements that count — not a live replacement's, an absorbed ticket's or a closed issue's", () => {
  for (const outcome of ["killed", "tier-mismatch"]) {
    assert.deepEqual(flight(memberRow(7, outcome)).owedCounted, ["impl-7"], outcome);
    assert.deepEqual(flight(memberRow(7, outcome), [], new Set([7])).owedCounted, [], `${outcome}: closed, so none counts`);
    assert.deepEqual(flight(memberRow(7, outcome), [pr(60, [], [7])]).owedCounted, [], `${outcome}: the PR absorbs it`);
  }
  assert.deepEqual(flight({ rows: ["#7 impl-7=killed · impl-7-b"], dispatched: ["impl-7=killed", "impl-7-b"] }).owedCounted, []);
  assert.deepEqual(flight(memberRow(7)).owedCounted, [], "a live implementer owes nothing");
});

test("deriveRun: a ticket counts once however many members it has had", () => {
  const r = flight({
    rows: ["#7 impl-7=killed · impl-7-b=tier-mismatch · impl-7-c"], dispatched: ["impl-7=killed", "impl-7-b=tier-mismatch", "impl-7-c"],
  });
  assert.deepEqual(counts(r), [1, 1, 0]);
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
  assert.deepEqual(parseShortlist('{"scanned":3,"shortlist":[{"n":7,"t":"a"}],"dropped":[{"n":5,"reason":"to-spec: x"}]}'),
    { status: "ok", scanned: 3, entries: [{ n: 7, t: "a" }], dropped: [{ n: 5, reason: "to-spec: x" }] });
  // A file written before `dropped` existed reads as no drops, never as an error.
  assert.deepEqual(parseShortlist('{"scanned":3,"shortlist":[{"n":7,"t":"a"}]}'),
    { status: "ok", scanned: 3, entries: [{ n: 7, t: "a" }], dropped: [] });
  for (const bad of ["", "{", "[]", '{"shortlist":[]}', '{"scanned":1,"shortlist":{}}', '{"scanned":1,"shortlist":[{"n":"7","t":"a"}]}',
    '{"scanned":1,"shortlist":[{"n":0,"t":"a"}]}', '{"scanned":1,"shortlist":[{"n":-1,"t":"a"}]}',
    '{"scanned":1,"shortlist":[],"dropped":{}}', '{"scanned":1,"shortlist":[],"dropped":null}',
    '{"scanned":1,"shortlist":[],"dropped":[{"n":0,"reason":"x"}]}',
    '{"scanned":1,"shortlist":[],"dropped":[{"n":5}]}', '{"scanned":1,"shortlist":[],"dropped":[null]}']) {
    assert.deepEqual(parseShortlist(bad), { status: "unparsable", scanned: null, entries: [], dropped: [] }, bad);
  }
});

test("refreshWhy: unclaimed below the bound refreshes, held refreshes nothing, draining nothing", () => {
  const base = { draining: null, held: false, status: "ok", entries: 5, unclaimed: 2, bound: 2 };
  assert.equal(refreshWhy(base), null);
  assert.equal(refreshWhy({ ...base, unclaimed: 1 }), "unclaimed 1 < in-flight bound 2");
  assert.equal(refreshWhy({ ...base, status: "missing", entries: 0, unclaimed: 0 }), "shortlist missing");
  assert.equal(refreshWhy({ ...base, status: "unparsable", entries: 0, unclaimed: 0 }), "shortlist unparsable");
  assert.equal(refreshWhy({ ...base, entries: 0, unclaimed: 0, bound: 1 }), "shortlist empty");
  assert.equal(refreshWhy({ ...base, status: "missing", draining: "x" }), null);
  // Held: no trigger refreshes — the low-water mark, a missing, unparsable or empty list.
  for (const over of [{ unclaimed: 1 }, { status: "missing", entries: 0, unclaimed: 0 }, { status: "unparsable", entries: 0, unclaimed: 0 }, { entries: 0, unclaimed: 0 }]) {
    assert.equal(refreshWhy({ ...base, ...over, held: true }), null, JSON.stringify(over));
    assert.notEqual(refreshWhy({ ...base, ...over }), null, `control, unheld: ${JSON.stringify(over)}`);
  }
});

// ---------------------------------------------------------------------------
// The CLI half. Every case runs a COPY of the script from a stub directory,
// inside its own throwaway git repository, so the ledger and shortlist it
// reads are the case's own `.fleet/` files, resolved the way the real run
// resolves them — against the git common dir.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/fleet-tick.mjs", import.meta.url));
// Every non-builtin module the copied script needs at startup, direct import
// or transitive — and ledger.mjs with its own, because the tick reads the
// ledger through `ledger.mjs read`. An unlisted sibling is a module-not-found
// at startup: exit 1, a shape no case below expects.
const SIBLING_MODULES = ["arg.mjs", "fleet-dir.mjs", "fleet-state.mjs", "git-env.mjs", "is-cli.mjs", "ledger.mjs", "ledger-grammar.mjs", "main-checkout.mjs", "phase0-receipt.mjs", "pid-lock.mjs", "proc.mjs", "report-files.mjs", "report-schema.mjs"].map(
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
// claimed count, and `issue list --search` for candidates.mjs's query when a
// case runs the real shortlist.mjs. `GH_HANG` names one of those (`pr list`, `issue view`, …) to
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
    fixture="$FIXTURE_CLAIMED"
    while [ $# -gt 0 ]; do
      case "$1" in --jq) shift; expr="$1" ;; --search) fixture="$FIXTURE_CANDIDATES" ;; esac
      shift
    done
    exec jq -c "$expr" "$fixture" ;;
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
// Stands in for a controller dispatching while the tick runs: its ledger
// entry first, then the transcript its \`task\` call makes.
if (process.env.MID_TICK_LEDGER) {
  writeFileSync(join(process.cwd(), ".fleet", "ledger.md"), process.env.MID_TICK_LEDGER);
  writeFileSync(join(process.cwd(), "..", "session", process.env.MID_TICK_TRANSCRIPT + ".jsonl"), "");
}
// Stands in for the heartbeat rewriting the state file between the tick's
// top-of-tick read and its late one.
if (process.env.MID_TICK_STATE) writeFileSync(join(process.cwd(), "..", "heartbeat.json"), process.env.MID_TICK_STATE);
const payload = readFileSync(process.env.FIXTURE_REFRESH, "utf8");
const file = join(process.cwd(), ".fleet", "shortlist.json");
mkdirSync(join(process.cwd(), ".fleet"), { recursive: true });
writeFileSync(file, payload);
console.log(JSON.stringify({ file, ...JSON.parse(payload) }));
`;

// The ledger on disk, in the layout ledger.mjs's save() writes.
const ledgerText = ({ rows = [], dispatched = [], drain = null, retired = [] } = {}) => {
  const list = (xs) => xs.map((x) => `- ${x}`).join("\n");
  return `# Fleet run ledger\n\n## Rows\n\n${list(rows)}\n\n## Dispatched\n\n${list(dispatched)}\n\n## Filed\n\n\n\n## Ruled\n\n`
    + (drain === null ? "" : `\n\n## Drain\n\n- ${drain}`)
    + (retired.length === 0 ? "" : `\n\n## Retired\n\n${list(retired)}`) + "\n";
};
const shortlistText = (ns, scanned = ns.length, dropped) =>
  JSON.stringify({ scanned, shortlist: ns.map((n) => ({ n, t: `t${n}` })), ...(dropped === undefined ? {} : { dropped }) });

// For a case that runs the REAL shortlist.mjs (`candidates` given): the
// scripts it spawns, and an in-flight check that answers every ticket free.
const REAL_SHORTLIST = ["shortlist.mjs", "candidates.mjs"].map(
  (m) => [m, fileURLToPath(new URL(`../plugin/scripts/${m}`, import.meta.url))],
);
const INFLIGHT_FREE = `#!/bin/sh
printf '{"issue":%s,"taken":false,"hits":[],"unknown":[]}\\n' "$1"
`;

// phase0.mjs's steps, every one present as its receipt always carries them.
const PHASE0_STEPS = ["branch", "fast-forward", "pin", "baseline", "preflight", "ruleset", "tier-roles", "metrics",
  "cockpit", "rotate", "reclaim", "recipe", "fold-in", "stranded", "shortlist"];
// A receipt in phase0.mjs's shape with every step `ok`; `steps` overrides
// individual steps.
const receiptOf = ({ run = null, session = "/s", steps = {} } = {}) => ({
  run, session, scratch: "/scratch",
  steps: Object.fromEntries(PHASE0_STEPS.map((name) => [name, { status: "ok", at: "2026-10-15T00:00:00.000Z", output: "", ...steps[name] }])),
});

// `baseline` records the run's main-checkout baseline the way Phase 0 does,
// after `beforeRun`; `afterBaseline` is a stray write landing mid-run. The
// repo ignores `.fleet/` and `.worktrees/` as a fleet repo's .gitignore does,
// through info/exclude so no tracked file says so. `phase0` is the run's
// phase-0 receipt, written after `afterBaseline`: by default every step `ok`
// and `run` the `at` of the controller record in the state file the tick
// reads, so the gate lets dispatch through; `false` writes none; a function
// maps that default receipt to the case's own. `transcripts`, when given, are
// the stems of the `<stem>.jsonl` files in that receipt's session directory,
// `<dir>/session`, which is created only when `transcripts` is given: without
// it the receipt names a directory that does not exist. `bound` is the
// In-flight bound a case runs under unless its args name `--in-flight`
// themselves: 2, so the fixtures sized for two slots read as they always did.
// `null` passes none, which is the tick's own default.
function runCli(args = [], {
  prs = [], ledger, shortlist, refresh = shortlistText([]), refreshFail = false,
  issueStates = {}, prStates = {}, claimed = [], candidates, env: extraEnv = {}, defaultState = false, keep = false, beforeRun = () => {},
  baseline = true, afterBaseline = () => {}, phase0 = (receipt) => receipt, transcripts, bound = 2,
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
    // The baseline records HEAD and judges it against `origin/main`: both must exist.
    const sh = (...a) => assert.equal(spawnBounded("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo }).status, 0, a.join(" "));
    sh("commit", "-q", "--allow-empty", "-m", "init");
    sh("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(repo, ".git", "info", "exclude"), ".fleet/\n.worktrees/\n");
    writeExecStub(join(bin, "gh"), GH_STUB);
    const script = join(bin, "fleet-tick.mjs");
    writeFileSync(script, readFileSync(SCRIPT));
    for (const [name, path] of SIBLING_MODULES) writeFileSync(join(bin, name), readFileSync(path));
    if (candidates === undefined) writeFileSync(join(bin, "shortlist.mjs"), SHORTLIST_STUB);
    else {
      for (const [name, path] of REAL_SHORTLIST) writeFileSync(join(bin, name), readFileSync(path));
      writeFileSync(join(bin, "inflight.sh"), INFLIGHT_FREE);
    }
    const fx = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };
    if (ledger !== undefined) writeFileSync(join(repo, ".fleet", "ledger.md"), ledgerText(ledger));
    if (shortlist !== undefined) writeFileSync(join(repo, ".fleet", "shortlist.json"), shortlist);
    beforeRun(repo);
    if (transcripts !== undefined) {
      mkdirSync(join(dir, "session"));
      for (const stem of transcripts) writeFileSync(join(dir, "session", `${stem}.jsonl`), "");
    }
    if (baseline) {
      const rec = spawnBounded(process.execPath, [join(bin, "main-checkout.mjs"), "--record"], { cwd: repo });
      assert.equal(rec.status, 0, rec.stderr);
    }
    afterBaseline(repo);
    if (phase0 !== false) {
      const statePathOf = args.includes("--state") ? args[args.indexOf("--state") + 1]
        : defaultState ? join(repo, ".fleet", "heartbeat.json") : join(dir, "heartbeat.json");
      let at = null;
      try { at = JSON.parse(readFileSync(statePathOf, "utf8")).controller?.at ?? null; } catch { /* no record: run null */ }
      writeFileSync(join(repo, ".fleet", "phase0.json"),
        JSON.stringify(phase0(receiptOf({ run: at, session: join(dir, "session") }))));
    }
    const refreshLog = fx("refresh.log", "");
    const issueViewLog = fx("issue-view.log", "");
    const prViewLog = fx("pr-view.log", "");
    // Every case gets its own state file unless it names one: the default path
    // resolves against the git common dir, and a shared streak and digest would
    // make the fold cases order-dependent. `defaultState` opts out for the case
    // whose subject IS that resolution.
    const stateArg = args.includes("--state") || defaultState ? [] : ["--state", join(dir, "heartbeat.json")];
    const boundArg = bound === null || args.some((a) => a === "--in-flight" || a.startsWith("--in-flight=")) ? [] : ["--in-flight", String(bound)];
    const r = spawnBounded(process.execPath, [script, ...boundArg, ...args, ...stateArg], {
      cwd: repo,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_PRS: fx("prs.json", JSON.stringify(prs)),
        FIXTURE_CLAIMED: fx("claimed.json", JSON.stringify(claimed)),
        FIXTURE_CANDIDATES: fx("candidates.json", JSON.stringify(candidates ?? [])),
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
// The fresh PULL rows a tick prints for `heads`, one line each and in that
// order, as one multiline regex: `prefix` is the row's role and n/B, `detail`
// what must follow each row's action, both regex sources ("" leaves it open).
const pullRows = (prefix, heads, detail = "") =>
  new RegExp(heads.map((n) => `^${prefix} → PULL #${n} — pull\\.mjs next --head ${n} {3}${detail}`).join("[^\\n]*\\n"), "m");

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

test("CLI: the #1692 shape, read off the ledger — two live implementers at bound 2 pull nothing", () => {
  const r = runCli(["--in-flight", "2"], {
    ledger: { rows: ["#412 impl-412 · tier-ok=impl-412:fleet-implementer", "#415 impl-415 · tier-ok=impl-415:fleet-implementer"], dispatched: ["impl-412", "impl-415"] },
    shortlist: shortlistText([412, 415, 420, 421, 422]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 2\/2 → HOLD \(in-flight 2\/2\) {3}\(implementers=2 prs=0 unclaimed=3 supply=5\)$/m);
  assert.doesNotMatch(r.stdout, /PULL/);
  assert.equal(r.refreshed, 0, "a held tick refreshes nothing");

  // One settles to a PR that has left the open list: exactly one slot frees,
  // and the next unclaimed head fills it.
  const one = runCli(["--in-flight", "2"], {
    ledger: { rows: ["#412 impl-412=PR#500 → PR#500 · tier-ok=impl-412:fleet-implementer", "#415 impl-415 · tier-ok=impl-415:fleet-implementer"], dispatched: ["impl-412=PR#500", "impl-415"] },
    shortlist: shortlistText([412, 415, 420, 421, 422]),
  });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, pullRows(String.raw`implementers 1\/2`, [420], String.raw`\(`));
});

test("CLI: a fresh run with no ledger reads zero live members, and no shortlist is depth 0 plus a refresh", () => {
  const r = runCli([], { refresh: shortlistText([7, 8, 9], 12) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  // Pulled from the file the refresh just wrote — not a tick of waiting.
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [7, 8], String.raw`\(implementers=0 prs=0 unclaimed=3 supply=12 shortlist=missing\)`));
  assert.match(r.stdout, /^shortlist {4}→ REFRESHED shortlist: 3 entries; 0 lifted {3}\(shortlist missing\)$/m);
});

test("CLI: an unparsable shortlist is depth 0 plus a refresh, never a refusal", () => {
  const r = runCli([], { shortlist: "{not json", refresh: shortlistText([]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  assert.match(r.stdout, /^implementers 0\/2 → SUGGEST \/triage, hold idle {3}\(implementers=0 prs=0 unclaimed=0 supply=0 shortlist=unparsable\)/m);
  assert.match(r.stdout, /REFRESHED shortlist: 0 entries; 0 lifted {3}\(shortlist unparsable; unchanged\)/);
});

// candidates.mjs's to-spec drops, from the gh row to the printed tick. The
// REAL shortlist.mjs and candidates.mjs run here against a gh that returns one
// ready-for-agent row carrying to-spec's `## User Stories` heading: before the
// drops were carried, this exact input printed `supply=0` and `SUGGEST
// /triage` with nothing naming the ticket.
const specIssue = (number) => ({ number, title: `t${number}`, labels: [{ name: "ready-for-agent" }], body: "## User Stories\n\n1. As a user, I want…\n" });
const plainIssue = (number) => ({ number, title: `t${number}`, labels: [{ name: "ready-for-agent" }], body: "## What to build\n\nx\n" });

test("CLI: one spec-shaped ready-for-agent row through the real shortlist.mjs is named on the tick with its number and reason", () => {
  const r = runCli([], { candidates: [specIssue(2151)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → SUGGEST \/triage, hold idle {3}\(implementers=0 prs=0 unclaimed=0 supply=0 shortlist=missing specs-dropped=#2151 \(to-spec: User Stories heading\)\)$/m);
  assert.match(r.stdout, /^shortlist {4}→ REFRESHED shortlist: 0 entries; 0 lifted/m);
});

test("CLI: a partial drop through the real shortlist.mjs is named beside the PULL it leaves", () => {
  const r = runCli([], { candidates: [specIssue(2151), plainIssue(2160)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [2160], String.raw`\(implementers=0 prs=0 unclaimed=1 supply=1 shortlist=missing specs-dropped=#2151 \(to-spec: User Stories heading\)\)$`));
});

test("CLI: a tick that does not refresh still names the drops, read back from shortlist.json", () => {
  const dropped = [{ n: 2151, reason: "to-spec: User Stories heading" }];
  // Two unclaimed at cap 2: nothing short, so no refresh runs this tick.
  const r = runCli([], { shortlist: shortlistText([7, 8], 2, dropped) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [7, 8], String.raw`\(implementers=0 prs=0 unclaimed=2 supply=2 specs-dropped=#2151 \(to-spec: User Stories heading\)\)$`));
});

test("CLI: a refresh's drops replace the ones the file held before it", () => {
  const r = runCli([], {
    shortlist: shortlistText([], 0, [{ n: 1, reason: "to-spec: User Stories heading" }]),
    refresh: shortlistText([], 0, [{ n: 2, reason: "to-spec: User Stories heading" }]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  assert.match(r.stdout, /specs-dropped=#2 \(to-spec: User Stories heading\)\)$/m);
  assert.doesNotMatch(r.stdout, /#1 \(/);
});

test("CLI: a shortlist.json written before `dropped` existed still reads ok, with no drops named", () => {
  const r = runCli([], { shortlist: shortlistText([7, 8]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [7, 8], String.raw`\(implementers=0 prs=0 unclaimed=2 supply=2\)$`));
  assert.doesNotMatch(r.stdout, /specs-dropped|shortlist=/);
});

test("CLI: a genuinely empty queue prints no specs-dropped text", () => {
  const r = runCli([], { shortlist: shortlistText([], 0, []), refresh: shortlistText([], 0, []) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 0\/2 → SUGGEST \/triage, hold idle {3}\(implementers=0 prs=0 unclaimed=0 supply=0\)$/m);
  assert.doesNotMatch(r.stdout, /specs-dropped/);
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

test("CLI: PULL names unclaimed heads only — claimed, bailed and excluded tickets are skipped; an open issue-closing PR holds a slot", () => {
  const r = runCli(["--in-flight", "3"], {
    ledger: { rows: ["#1 impl-1=bailed · tier-ok=impl-1:fleet-implementer", "#2 impl-2 · tier-ok=impl-2:fleet-implementer", "#3 excluded · behind-pr:#99"], dispatched: ["impl-1=bailed", "impl-2"] },
    shortlist: shortlistText([1, 2, 3, 4, 5, 6]),
    prs: [pr(99)],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, pullRows(String.raw`implementers 2\/3`, [4], String.raw`\(implementers=1 prs=1 unclaimed=3 supply=6\)$`), "impl-2 and PR 99 each hold a slot: one left");
  assert.equal(r.refreshed, 0, "three unclaimed at bound 3 is not short");
});

test("CLI: reviewer rows are named per PR, fix-appliers first, reviews oldest first", () => {
  const r = runCli([], {
    ledger: {
      rows: [
        "#10 impl-10=PR#346 → PR#346 · review=wf:a reviewed=abc1234:2/0/0:run-abc1234r",
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
    "reviewers    0/2 → DISPATCH fix-pr PR#346",
    "reviewers    0/2 → DISPATCH review PR#349 PR#350",
  ]);
});

test("CLI: a deep review backlog never holds the implementer row", () => {
  const r = runCli(["--in-flight", "5"], { shortlist: shortlistText([7, 8, 9, 10, 11]), prs: [pr(51), pr(52), pr(53)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, pullRows(String.raw`implementers 3\/5`, [7, 8]), "its three fixture PRs close issues, so they count");
  assert.match(r.stdout, /^reviewers {4}0\/5 → DISPATCH review PR#51 PR#52 PR#53 /m, "every due review is dispatched, no cap");
  // Live reviews with a PR still owed one: the review side is as full as it
  // gets, and the implementer row still pulls.
  const busy = runCli(["--in-flight", "5"], {
    ledger: { rows: ["#51 review=wf:x"] }, shortlist: shortlistText([7, 8, 9, 10, 11]), prs: [pr(51), pr(52)],
  });
  assert.match(busy.stdout, pullRows(String.raw`implementers 2\/5`, [7, 8, 9]));
  assert.match(busy.stdout, /^reviewers {4}1\/5 → DISPATCH review PR#52 /m);
  assert.doesNotMatch(busy.stdout, /saturated/);
});

test("CLI: drain holds the implementer row, stops refreshing, and keeps the review and merge rows firing", () => {
  const r = runCli([], {
    ledger: { rows: ["#9 impl-9=released"], dispatched: ["impl-9=released"], drain: "maintainer asked" },
    prs: [pr(51), pr(60, ["ready-to-merge"])],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 2\/2 → HOLD \(draining\)/m);
  assert.equal(r.refreshed, 0, "a draining run's missing shortlist is not a reason to restart supply");
  assert.doesNotMatch(r.stdout, /REFRESH/);
  assert.match(r.stdout, /^reviewers {4}0\/2 → DISPATCH review PR#51 /m);
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
    ledger: { rows: [`#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:0/2/0:run-abc1234r · ${tail}`], dispatched: ["merge-bot-1=done", ...dispatched] },
    shortlist: shortlistText([]), prs: [pr(40, ["ready-to-merge"])],
  }).stdout;
  const held = tick("conflict-hold:#40", []);
  assert.match(held, /^reviewers +0\/2 → DISPATCH fix-pr PR#40 /m);
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

test("CLI: a ## Retired line naming no member or reviewer refuses the tick, naming the line and printing no row", () => {
  const r = runCli([], { ledger: { retired: ["impl-1", "garbage-name"] }, shortlist: shortlistText([]) });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /^fleet-tick: ## Retired line 'garbage-name' names no member or reviewer — fix the ledger by hand before the tick can count from it$/m);
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
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\) +\(.* — dispatch impl-7-b at its row's tier\)$/m);
});

test("CLI: an implementer with no tier verdict on the ledger holds the implementer row until tier-check writes one", () => {
  const r = runCli([], { ledger: { rows: ["#7 impl-7 · class=routine"], dispatched: ["impl-7"] }, shortlist: shortlistText([8, 9]) });
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier unchecked impl-7\) +\(.* — run ~\/\.fleet\/bin\/fleet-run tier-check\.mjs --batch <file> with \[\{"member":"impl-7"\}\]\)$/m);
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
  // `full` omits #50: an open issue on a ticket the file does not carry
  // stands, and asks for no refresh.
  const openIssue = runCli([], { ...full, ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "OPEN" } });
  assert.equal(openIssue.refreshed, 0);
  // Already back on the current file: the refresh that lifted it has run.
  const reflected = runCli([], {
    shortlist: shortlistText([1, 2, 50]), ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" },
  });
  assert.equal(reflected.refreshed, 0);
  assert.deepEqual(reflected.issueViews, ["9"], "the file already carries the ticket: one probe, to learn the premise has lifted");
});

test("CLI: a lifted behind-pr exclusion names its ticket in the PULL row, with no refresh needed", () => {
  const r = runCli(["--in-flight", "1"], {
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
  const r = runCli(["--in-flight", "3"], {
    shortlist: shortlistText([1, 2, 50]), ledger: { rows: ["#50 excluded · behind-issue:#9"] }, issueStates: { 9: "CLOSED" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "already reflected — no refresh needed to admit it");
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/3`, [1, 2, 50]));
});

// A behind-issue exclusion on a ticket the current file still carries: the
// file may predate the row, so the tick probes the issue once, and any answer
// short of CLOSED or MERGED asks for the refresh whose own probe decides. The
// cap of 3 leaves #50 a head of the file, so only that refresh can hold it out.
const ISSUE_HELD = { rows: ["#50 excluded · behind-issue:#9"] };

test("CLI: a behind-issue exclusion with an open issue on a ticket in the shortlist refreshes and holds the ticket out of the PULL", () => {
  const r = runCli(["--in-flight", "3"], {
    shortlist: shortlistText([1, 2, 50]), refresh: shortlistText([1, 2]), ledger: ISSUE_HELD, issueStates: { 9: "OPEN" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1, "an open issue does not lift the exclusion: the refresh's own probe decides");
  assert.deepEqual(r.issueViews, ["9"]);
  assert.match(r.stdout, /REFRESHED shortlist: 2 entries; 0 lifted {3}\(behind-issue:#9 not closed, #50 still on the shortlist\)/);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/3`, [1, 2], String.raw`\(implementers=0 prs=0 unclaimed=2 supply=2\)`));
  assert.doesNotMatch(r.stdout, /PULL[^\n]*#50/);
});

test("CLI: a behind-issue exclusion whose refresh fails leaves the PULL as it was and reports the failure", () => {
  const r = runCli(["--in-flight", "3"], {
    shortlist: shortlistText([1, 2, 50]), ledger: ISSUE_HELD, issueStates: { 9: "OPEN" }, refreshFail: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/3`, [1, 2, 50], String.raw`\(implementers=0 prs=0 unclaimed=3 supply=3\)`));
  assert.match(r.stdout, /REFRESH FAILED/);
});

test("CLI: a behind-issue probe that cannot answer never lifts the exclusion, and on a ticket in the file it refreshes", () => {
  const down = runCli(["--in-flight", "3"], {
    shortlist: shortlistText([1, 2, 50]), refresh: shortlistText([1, 2]), ledger: ISSUE_HELD, env: { ISSUE_VIEW_FAIL: "1" },
  });
  assert.equal(down.status, 0, down.stderr);
  assert.equal(down.refreshed, 1, "an unanswered probe is not a lift: the refresh's own probe decides");
  assert.match(down.stderr, /fleet-tick: gh issue view 9 exited 1: gh: issue view failed — behind-issue:#9 premise unconfirmed, exclusion stands/);
  assert.match(down.stdout, pullRows(String.raw`implementers 0\/3`, [1, 2], String.raw`\(implementers=0 prs=0 unclaimed=2 supply=2\)`));
  const noState = runCli(["--in-flight", "3"], {
    shortlist: shortlistText([1, 2, 50]), refresh: shortlistText([1, 2]), ledger: ISSUE_HELD,
    issueStates: { 9: "CLOSED" }, env: { ISSUE_VIEW_BODY: "<html>rate limited</html>" },
  });
  assert.equal(noState.status, 0, noState.stderr);
  assert.equal(noState.refreshed, 1, "a body with no state is no lift either");
  assert.match(noState.stderr, /fleet-tick: gh issue view 9 printed no state — behind-issue:#9 premise unconfirmed, exclusion stands/);
  assert.match(noState.stdout, pullRows(String.raw`implementers 0\/3`, [1, 2], String.raw`\(implementers=0 prs=0 unclaimed=2 supply=2\)`));
});

test("CLI: a behind-issue exclusion whose issue is MERGED on a ticket in the shortlist asks for no refresh", () => {
  const r = runCli(["--in-flight", "3"], {
    shortlist: shortlistText([1, 2, 50]), ledger: ISSUE_HELD, issueStates: { 9: "MERGED" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "MERGED lifts the premise, as CLOSED does");
  assert.deepEqual(r.issueViews, ["9"]);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/3`, [1, 2, 50]));
});

test("CLI: a behind-issue exclusion with a non-numeric target is never handed to gh, on a ticket in the shortlist or not", () => {
  for (const target of ["feature-x", "--web"]) {
    const ledger = { rows: [`#50 excluded · behind-issue:${target}`] };
    const inFile = runCli(["--in-flight", "3"], { shortlist: shortlistText([1, 2, 50]), ledger });
    assert.equal(inFile.status, 0, inFile.stderr);
    assert.deepEqual(inFile.issueViews, [], target);
    assert.equal(inFile.refreshed, 0, target);
    assert.doesNotMatch(inFile.stderr, /premise unconfirmed/, target);
    const absent = runCli(["--in-flight", "2"], { shortlist: shortlistText([1, 2, 3]), ledger });
    assert.deepEqual(absent.issueViews, [], target);
  }
});

// A branch-named `behind-pr` is the Exclusion the skill allows until its PR
// exists. The current file predates the row, so the tick refreshes to let
// shortlist.mjs's own probe drop the ticket, and takes its PULL from that.
const BRANCH = "implementer/2151-impl-2151";
const branchExcluded = { rows: [`#2305 excluded · behind-pr:#${BRANCH}`] };

test("CLI: a branch-named behind-pr exclusion holds its ticket out of the PULL row once the refresh drops it", () => {
  const r = runCli([], {
    shortlist: shortlistText([2305, 10, 11]), refresh: shortlistText([10, 11]), ledger: branchExcluded, prStates: {},
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1, "the file still carries #2305 and no PR exists yet: only a refresh can drop it");
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [10, 11], String.raw`.*unclaimed=2 supply=2`));
  assert.doesNotMatch(r.stdout, /PULL[^\n]*#2305/);
});

test("CLI: a branch-named behind-pr exclusion whose refresh fails leaves the PULL as it was and reports the failure", () => {
  const r = runCli([], {
    shortlist: shortlistText([2305, 10, 11]), ledger: branchExcluded, prStates: {}, refreshFail: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 1);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [2305, 10], String.raw`\(implementers=0 prs=0 unclaimed=3 supply=3\)`));
  assert.match(r.stdout, /REFRESH FAILED/);
});

test("CLI: a branch-named behind-pr exclusion lifts, with a refresh, once its PR is MERGED or CLOSED", () => {
  const full = { shortlist: shortlistText([10, 11, 12]), refresh: shortlistText([10, 11, 12, 2305]), ledger: branchExcluded };
  for (const state of ["MERGED", "CLOSED"]) {
    const r = runCli([], { ...full, prStates: { [BRANCH]: state } });
    assert.equal(r.refreshed, 1, state);
    assert.deepEqual(r.prViews, [BRANCH]);
    assert.match(r.stdout, new RegExp(`REFRESHED shortlist: 4 entries; 1 lifted {3}\\(behind-pr:#${BRANCH} ${state}\\)`));
  }
  for (const [name, prStates] of [["open", { [BRANCH]: "OPEN" }], ["not yet created", {}]]) {
    const r = runCli([], { ...full, prStates });
    assert.equal(r.refreshed, 0, `${name}: the exclusion stands, nothing to refresh`);
    assert.deepEqual(r.prViews, [BRANCH], `${name}: probed once`);
  }
});

test("CLI: a branch-named behind-pr exclusion already reflected in the current file triggers no refresh", () => {
  const r = runCli([], {
    shortlist: shortlistText([2305, 10, 11]), ledger: branchExcluded, prStates: { [BRANCH]: "MERGED" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0, "the file already carries the lifted ticket — nothing to refresh");
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [2305, 10]));
});

test("CLI: a branch-named behind-pr probe that cannot answer never lifts the exclusion, and on a ticket in the file it refreshes", () => {
  const away = { shortlist: shortlistText([10, 11, 12]), refresh: shortlistText([10, 11, 12, 2305]), ledger: branchExcluded };
  const down = runCli([], { ...away, prStates: { [BRANCH]: "MERGED" }, env: { PR_VIEW_FAIL: "1" } });
  assert.equal(down.status, 0, down.stderr);
  assert.equal(down.refreshed, 0);
  assert.match(down.stderr, new RegExp(`fleet-tick: gh pr view ${BRANCH} exited 1: gh: pr view failed — behind-pr:#${BRANCH} premise unconfirmed, exclusion stands`));
  for (const body of ["<html>proxy error</html>", "{}", "null"]) {
    const r = runCli([], { ...away, prStates: { [BRANCH]: "MERGED" }, env: { PR_VIEW_BODY: body } });
    assert.equal(r.refreshed, 0, body);
    assert.match(r.stderr, new RegExp(`fleet-tick: gh pr view ${BRANCH} printed no state — behind-pr:#${BRANCH} premise unconfirmed, exclusion stands`), body);
  }
  const inFile = runCli([], {
    shortlist: shortlistText([2305, 10, 11]), refresh: shortlistText([10, 11]), ledger: branchExcluded, env: { PR_VIEW_FAIL: "1" },
  });
  assert.equal(inFile.refreshed, 1, "an unanswered probe is not a lift: the refresh's own probe decides");
  assert.match(inFile.stdout, pullRows(String.raw`implementers 0\/2`, [10, 11]));
});

test("CLI: a behind-issue probe answering exit 0 with no state is disclosed and the exclusion stands", () => {
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), refresh: shortlistText([1, 2, 3, 50]), ledger: { rows: ["#50 excluded · behind-issue:#9"] },
    issueStates: { 9: "CLOSED" }, env: { ISSUE_VIEW_BODY: "<html>rate limited</html>" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refreshed, 0);
  assert.match(r.stderr, /fleet-tick: gh issue view 9 printed no state — behind-issue:#9 premise unconfirmed, exclusion stands/);
});

// #2485: the mismatch hold is lifted by the mismatched ticket's own issue
// being CLOSED, probed live; an open one, or a probe that cannot answer, holds.
test("CLI: a tier mismatch on a CLOSED ticket no longer holds the implementer row", () => {
  const mismatch = { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] };
  const base = { shortlist: shortlistText([1, 2, 3]) };
  const closed = runCli([], { ...base, ledger: mismatch, issueStates: { 7: "CLOSED" } });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, pullRows(String.raw`implementers 0\/2`, [1, 2]));
  assert.doesNotMatch(closed.stdout, /tier mismatch/);
  assert.deepEqual(closed.issueViews, ["7"]);
  const open = runCli([], { ...base, ledger: mismatch, issueStates: { 7: "OPEN" } });
  assert.match(open.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\)/m);
  const none = runCli([], { ...base, ledger: { rows: ["#7 impl-7 · tier-ok=impl-7:fleet-implementer"], dispatched: ["impl-7"] } });
  assert.deepEqual(none.issueViews, [], "nothing mismatched: no probe");
});

test("CLI: a failed probe of a mismatched ticket is disclosed and the hold stands", () => {
  const r = runCli([], {
    shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
    issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_FAIL: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\)/m);
  assert.match(r.stderr, /fleet-tick: gh issue view 7 exited 1: gh: issue view failed — tier mismatch on #7 unconfirmed closed, hold stands/);
});

test("CLI: a probe answering exit 0 with no issue state is disclosed and the hold stands", () => {
  for (const body of ["<html>rate limited</html>", "{}", "null"]) {
    const r = runCli([], {
      shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] },
      issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_BODY: body },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\)/m, body);
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
    assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\)/m, state);
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
    assert.match(r.stderr, /accepted: --in-flight, --fold-unchanged, --apply, --state/, flag);
    assert.equal(r.stdout.trim(), "", flag);
  }
});

test("CLI: the three retired flags refuse as unknown", () => {
  for (const flag of ["--implementer-cap", "--reviewer-cap", "--max-reviews"]) {
    for (const args of [[flag, "3"], [`${flag}=3`]]) {
      const r = runCli(args, { shortlist: shortlistText([]) });
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stdout.trim(), "", args.join(" "));
      assert.match(r.stderr, new RegExp(`Unknown option '${flag}[^']*' — accepted: --in-flight, --fold-unchanged, --apply, --state`), args.join(" "));
    }
  }
});

test("CLI: --in-flight must be a positive integer, with no upper bound", () => {
  const refused = (args) => runCli(args, { shortlist: shortlistText([]) });
  const zero = refused(["--in-flight", "0"]);
  assert.equal(zero.status, 2);
  assert.equal(zero.stdout.trim(), "");
  assert.match(zero.stderr, /--in-flight must be at least 1, got 0/);
  for (const [args, raw] of [[["--in-flight=x"], "x"], [["--in-flight="], ""], [["--in-flight", "3 6"], "3 6"], [["--in-flight=-1"], "-1"], [["--in-flight", "1.5"], "1.5"]]) {
    const r = refused(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout.trim(), "", args.join(" "));
    assert.match(r.stderr, new RegExp(`--in-flight must be a non-negative integer, got '${raw}'`), args.join(" "));
  }
  for (const n of ["9", "100"]) {
    const big = runCli(["--in-flight", n], { shortlist: shortlistText([]) });
    assert.equal(big.status, 0, big.stderr);
    assert.match(big.stdout, new RegExp(`^implementers 0/${n} `, "m"));
    assert.match(big.stdout, new RegExp(`^reviewers {4}0/${n} `, "m"));
  }
});

test("CLI: --in-flight defaults to 5 and prints n/B", () => {
  const r = runCli([], { bound: null, shortlist: shortlistText([7, 8, 9, 10, 11, 12, 13]), prs: [pr(51), pr(52)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, pullRows(String.raw`implementers 2\/5`, [7, 8, 9], String.raw`\(implementers=0 prs=2 unclaimed=7 supply=7\)$`));
  assert.match(r.stdout, /^reviewers {4}0\/5 → DISPATCH review PR#51 PR#52 /m);
});

test("CLI: an inherited run over B starts fully held — seven open issue-closing PRs at B = 5", () => {
  const prs = [1, 2, 3, 4, 5, 6, 7].map((n) => pr(100 + n));
  const r = runCli(["--in-flight", "5"], { prs, shortlist: shortlistText([7, 8, 9]) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^implementers 7\/5 → HOLD \(in-flight 7\/5\) {3}\(implementers=0 prs=7 unclaimed=3 supply=3\)$/m);
  assert.doesNotMatch(r.stdout, /PULL/);
  assert.match(r.stdout, /^reviewers {4}0\/5 → DISPATCH review PR#101 PR#102 PR#103 PR#104 PR#105 PR#106 PR#107 /m, "the reviewer row still dispatches every due review");
  assert.equal(r.refreshed, 0, "three unclaimed is short of 5, and a held tick still refreshes nothing");
});

test("CLI: a held tick refreshes no shortlist; the same fixture one merge later does", () => {
  const fixture = { shortlist: undefined, refresh: shortlistText([7, 8]) };
  const held = runCli(["--in-flight", "2"], { ...fixture, prs: [pr(51), pr(52)] });
  assert.equal(held.status, 0, held.stderr);
  assert.equal(held.refreshed, 0, "n = 2 = B: a missing shortlist is not a reason to refresh while the bound holds");
  assert.match(held.stdout, /^implementers 2\/2 → HOLD \(in-flight 2\/2\) {3}\(implementers=0 prs=2 unclaimed=0 supply=\? shortlist=missing\)$/m);
  assert.doesNotMatch(held.stdout, /REFRESH/);
  const merged = runCli(["--in-flight", "2"], { ...fixture, prs: [pr(51)] });
  assert.equal(merged.refreshed, 1, "one merge brings n below B: the refresh runs");
  assert.match(merged.stdout, /^shortlist {4}→ REFRESHED shortlist: 2 entries; 0 lifted {3}\(shortlist missing\)$/m);
  assert.match(merged.stdout, /^implementers 1\/2 → PULL #7 /m, "the refresh and the Pull land in the same tick");
  // The low-water mark is the bound itself: one unclaimed head under B = 2 refreshes.
  const low = runCli(["--in-flight", "2"], { shortlist: shortlistText([7]), refresh: shortlistText([7, 8]) });
  assert.equal(low.refreshed, 1);
  assert.match(low.stdout, /REFRESHED shortlist: 2 entries; 0 lifted {3}\(unclaimed 1 < in-flight bound 2\)/);
  // …and a held tick holds back even a lifted exclusion premise's refresh.
  const lifted = runCli(["--in-flight", "2"], {
    shortlist: shortlistText([1, 2, 3]), refresh: shortlistText([1, 2, 3, 50]), ledger: { rows: ["#50 excluded · behind-pr:#44"] }, prs: [pr(51), pr(52)],
  });
  assert.equal(lifted.refreshed, 0, "held: the exclusion's lift waits for the first unheld tick");
});

test("CLI: a held tick is quiet — the state file's quiet increments", () => {
  const reviewed = (n, ticket) => `#${ticket} impl-${ticket}=PR#${n} → PR#${n} · tier-ok=impl-${ticket}:fleet-implementer · review=wf:r${n} reviewed=abc1234:0/0/0:run-abc1234r`;
  const held = { bound: 2, ledger: { rows: [reviewed(51, 10), reviewed(52, 11)], dispatched: ["impl-10=PR#51", "impl-11=PR#52"] }, prs: [pr(51), pr(52)], shortlist: shortlistText([7, 8, 9]) };
  const ticks = foldTicks(held);
  for (const t of ticks) assert.equal(t.status, 0, t.stderr);
  assert.match(ticks[0].stdout, /^implementers 2\/2 → HOLD \(in-flight 2\/2\)/m);
  assert.deepEqual(ticks.map((t) => t.quiet), [1, 2, 3], "a held tick asks for nothing, so quiet rises every tick");
  for (const [i, t] of ticks.slice(1).entries()) {
    assert.equal(t.stdout.trim(), `fleet-tick: unchanged, nothing to act on (quiet=${i + 2}) — full rows on the next change`);
  }
  const free = foldTicks({ ...held, prs: [pr(51)] });
  assert.match(free[0].stdout, /^implementers 1\/2 → PULL #7 /m);
  assert.deepEqual(free.map((t) => t.quiet), [0, 0, 0], "control: an unheld tick names a PULL, which resets quiet");
});

test("CLI: an owed replacement on a CLOSED issue is not In flight; a probe that cannot answer leaves it counted and is disclosed on stderr", () => {
  const killed = { rows: ["#7 impl-7=killed · tier-ok=impl-7:fleet-implementer"], dispatched: ["impl-7=killed"] };
  const base = { shortlist: shortlistText([1, 2, 3]), ledger: killed };
  const closed = runCli([], { ...base, issueStates: { 7: "CLOSED" } });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, pullRows(String.raw`implementers 0\/2`, [1, 2], String.raw`\(implementers=0 prs=0 `));
  assert.deepEqual(closed.issueViews, ["7"], "a killed ticket is probed, not only a tier-mismatched one");
  const open = runCli([], { ...base, issueStates: { 7: "OPEN" } });
  assert.match(open.stdout, pullRows(String.raw`implementers 1\/2`, [1], String.raw`\(implementers=1 prs=0 `), "an open issue's owed replacement is In flight");
  const failed = runCli([], { ...base, issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_FAIL: "1" } });
  assert.match(failed.stdout, /^implementers 1\/2 → PULL #1 /m, "a probe that cannot answer never uncounts");
  assert.match(failed.stderr, /fleet-tick: gh issue view 7 exited 1: gh: issue view failed — replacement owed on #7 unconfirmed closed, ticket stays counted/);
  for (const body of ["<html>rate limited</html>", "{}", "null"]) {
    const r = runCli([], { ...base, issueStates: { 7: "CLOSED" }, env: { ISSUE_VIEW_BODY: body } });
    assert.match(r.stdout, /^implementers 1\/2 → PULL #1 /m, body);
    assert.match(r.stderr, /fleet-tick: gh issue view 7 printed no state — replacement owed on #7 unconfirmed closed, ticket stays counted/, body);
  }
  // A tier-mismatched ticket is probed once, though it is both held and owed.
  const mismatch = runCli([], { shortlist: shortlistText([1, 2, 3]), ledger: { rows: ["#7 impl-7=tier-mismatch"], dispatched: ["impl-7=tier-mismatch"] }, issueStates: { 7: "CLOSED" } });
  assert.deepEqual(mismatch.issueViews, ["7"]);
  // One merge-bound PR closing the ticket absorbs it: nothing is owed, nothing probed, one slot held.
  const absorbed = runCli([], { ...base, prs: [pr(60, ["ready-to-merge"], [7])], issueStates: { 7: "CLOSED" } });
  assert.deepEqual(absorbed.issueViews, []);
  assert.match(absorbed.stdout, pullRows(String.raw`implementers 1\/2`, [1], String.raw`\(implementers=0 prs=1 `));
  // Two owed tickets: one probe each.
  const two = runCli([], {
    shortlist: shortlistText([1, 2, 3]), issueStates: { 7: "CLOSED", 8: "OPEN" },
    ledger: { rows: ["#7 impl-7=killed · tier-ok=impl-7:fleet-implementer", "#8 impl-8=killed · tier-ok=impl-8:fleet-implementer"], dispatched: ["impl-7=killed", "impl-8=killed"] },
  });
  assert.deepEqual(two.issueViews, ["7", "8"]);
  assert.match(two.stdout, pullRows(String.raw`implementers 1\/2`, [1], String.raw`\(implementers=1 prs=0 `), "#7 is closed and uncounted, #8 still owes its replacement");
});

test("CLI: a ledger carrying impl-<N>=blocked counts nothing for N — no In-flight slot, no PULL held on its account", () => {
  const blocked = { rows: ["#7 impl-7=blocked · tier-ok=impl-7:fleet-implementer"], dispatched: ["impl-7=blocked"] };
  const r = runCli([], { shortlist: shortlistText([7, 1, 2]), ledger: blocked });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [1, 2], String.raw`\(implementers=0 prs=0 unclaimed=2 supply=3\)$`), "a blocked ticket keeps its claim: it is no head, and no slot");
  assert.deepEqual(r.issueViews, [], "no replacement is owed, so nothing is probed");
  // A settled blocked member is still a member for the tier hold: no verdict holds the row, and still counts nothing.
  const unchecked = runCli([], { shortlist: shortlistText([1, 2]), ledger: { rows: ["#7 impl-7=blocked"], dispatched: ["impl-7=blocked"] } });
  assert.match(unchecked.stdout, /^implementers 0\/2 → HOLD \(tier unchecked impl-7\) {3}\(implementers=0 prs=0 /m);
});

test("CLI: a replacement is never a Pull and never held — owed, then dispatched, the ticket stays the one slot at the bound", () => {
  const owed = { rows: ["#7 impl-7=killed · tier-ok=impl-7:fleet-implementer"], dispatched: ["impl-7=killed"] };
  const replaced = {
    rows: ["#7 impl-7=killed · tier-ok=impl-7:fleet-implementer · impl-7-b · tier-ok=impl-7-b:fleet-implementer"],
    dispatched: ["impl-7=killed", "impl-7-b"],
  };
  const base = { shortlist: shortlistText([1, 2, 3]), issueStates: { 7: "OPEN" } };
  const before = runCli(["--in-flight", "1"], { ...base, ledger: owed });
  assert.match(before.stdout, /^implementers 1\/1 → HOLD \(in-flight 1\/1\) {3}\(implementers=1 prs=0 /m, "the owed ticket fills the one slot: no Pull takes it");
  const after = runCli(["--in-flight", "1"], { ...base, ledger: replaced });
  assert.match(after.stdout, /^implementers 1\/1 → HOLD \(in-flight 1\/1\) {3}\(implementers=1 prs=0 /m, "dispatching the replacement moves n by nothing");
  // Past the bound outright: the replacement of an owed ticket beside an inherited PR over B.
  const over = runCli(["--in-flight", "1"], { ...base, ledger: replaced, prs: [pr(50)] });
  assert.match(over.stdout, /^implementers 2\/1 → HOLD \(in-flight 2\/1\) {3}\(implementers=1 prs=1 /m);
  assert.doesNotMatch(over.stdout, /PULL/);
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

test("CLI: an issue-closing reference with no integer number refuses the tick rather than miscounting it", () => {
  for (const ref of [{}, { number: "7" }, { number: null }, { number: 7.5 }, null, { title: "no number" }]) {
    const r = runCli([], { prs: [{ ...pr(1), closingIssuesReferences: [{ number: 1001 }, ref] }], shortlist: shortlistText([]) });
    assert.equal(r.status, 2, JSON.stringify(ref));
    assert.equal(r.stdout.trim(), "", JSON.stringify(ref));
    assert.match(r.stderr, /gh pr list did not return .*closingIssuesReferences\[\{number\}\]/, JSON.stringify(ref));
  }
  const ok = runCli([], { prs: [{ ...pr(1), closingIssuesReferences: [{ number: 1001 }, { number: 1002 }] }], shortlist: shortlistText([]) });
  assert.equal(ok.status, 0, ok.stderr);
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
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:0/0/0:run-abc1234r"] },
    shortlist: shortlistText([]), prs: [pr(40, [], [10], HEAD_B, "CONFLICTING"), pr(41, [], [], HEAD_B, "UNKNOWN")],
    env: { PR_LIST_LOG: log },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers {4}0\/2 → CONFLICT PR#40 +\(.* — .*ledger\.mjs row <key> "<text> · conflict-hold:#40 \(conflict: mergeable=CONFLICTING\)".*\)$/m);
  assert.doesNotMatch(r.stdout, /PR#41/);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1, "no extra gh call");
  assert.match(calls[0], /--json \S*\bmergeable\b/);
});

test("CLI: a past-pin halt prints DISPATCH review for its PR (#2083)", () => {
  const r = runCli([], {
    ledger: { rows: ["#10 impl-10=PR#40 → PR#40 · review=wf:a reviewed=abc1234:0/0/0:run-abc1234r · finisher-pr-40=halted:past-pin"] },
    shortlist: shortlistText([]), prs: [pr(40, [], [10], HEAD_B)],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers {4}0\/2 → DISPATCH review PR#40 /m);
});

test("CLI: an ambient GIT_DIR naming another repository cannot move the shortlist read", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  mkdirSync(join(decoy, ".fleet"));
  writeFileSync(join(decoy, ".fleet", "shortlist.json"), shortlistText([666]));
  const r = runCli([], { shortlist: shortlistText([7, 8]), env: { GIT_DIR: join(decoy, ".git") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [7, 8]));
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
  assert.doesNotMatch(r.stdout, /PULL #[78] /, "the shortlist on disk was unreachable, so its entries must not be pulled");
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
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\)/m, "#7 is OPEN in the case's own repository - the hold stands");
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
// after its PR merges. Each such row counts as one review unit unless the tick
// asks gh about the PR and finds it finished.
const zombieRows = (numbers) => numbers.map((n) => `#${n - 90} impl-${n - 90}=PR#${n} → PR#${n} · review=member:review-pr-${n}`);
const ZOMBIES = Array.from({ length: 10 }, (_, i) => 101 + i);
const REVIEW_DUE = pr(500, [], [1500], HEAD_B);

test("CLI: dangling in-flight reviews of merged PRs are no review units, and dispatch is never starved", () => {
  const r = runCli([], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows(ZOMBIES) },
    prStates: Object.fromEntries(ZOMBIES.map((n) => [n, "MERGED"])),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews.map(Number).sort((a, b) => a - b), ZOMBIES, "each off-list PR is asked about");
  assert.match(r.stdout, /^reviewers +0\/2 → DISPATCH review PR#500/m);
});

test("CLI: a CLOSED PR's dangling review is no review unit either", () => {
  const r = runCli([], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "CLOSED" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers +0\/2 → DISPATCH review PR#500/m);
});

test("CLI: an in-flight review on an open PR counts as a unit and is never probed", () => {
  const r = runCli([], {
    shortlist: shortlistText([]), prs: [pr(101, [], [1101]), REVIEW_DUE], ledger: { rows: zombieRows([101]) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews, [], "an open PR needs no probe");
  assert.match(r.stdout, /^reviewers +1\/2 → DISPATCH review PR#500/m, "the unit counts, and the due review is still dispatched: no cap");
});

test("CLI: a PR off the open list that gh still calls OPEN keeps its review counted as a unit", () => {
  const r = runCli([], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "OPEN" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews, ["101"]);
  assert.match(r.stdout, /^reviewers +1\/2 → DISPATCH review PR#500/m);
});

test("CLI: a PR gh cannot answer for is not read as merged - the unit stays counted and the failure disclosed", () => {
  const cases = [
    ["a nonzero exit", { PR_VIEW_FAIL: "1" }, /gh pr view 101 exited 1: gh: pr view failed/],
    ["a reply with no state", { PR_VIEW_BODY: "<html>proxy error</html>" }, /gh pr view 101 printed no PR state/],
    ["a state that is not MERGED or CLOSED", { PR_VIEW_BODY: JSON.stringify({ state: "merged" }) }, /gh pr view 101 printed no PR state/],
  ];
  for (const [what, env, shown] of cases) {
    const r = runCli([], {
      shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "MERGED" }, env,
    });
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.match(r.stderr, shown, what);
    assert.match(r.stdout, /^reviewers +1\/2 → DISPATCH review PR#500/m, what);
  }
});

test("CLI: an inherited GIT_DIR cannot retarget the merged-PR review probe", (t) => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-decoy-pr-")));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  spawnBounded("git", ["init", "-q", decoy]);
  const r = runCli([], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "OPEN" },
    env: { GIT_DIR: join(decoy, ".git"), GH_REPO: "someone/else" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.prViews, ["101"], "the probe must still run");
  assert.match(r.stdout, /^reviewers +1\/2 → DISPATCH review PR#500/m, "101 is OPEN in the case's own repository - its review stays a counted unit");
});

// #2210, end to end: a real repo, a real baseline, a real stray write.
const LIVE = {
  ledger: { rows: ["#412 impl-412 · tier-ok=impl-412:fleet-implementer"], dispatched: ["impl-412"] },
  shortlist: shortlistText([412, 420, 421, 422]),
};
// One more tick over a kept runCli fixture, as the next wake would run it — under the same bound.
const tickAgain = (r, bound = 2) => spawnBounded(process.execPath, [join(r.dir, "bin", "fleet-tick.mjs"), "--in-flight", String(bound), "--state", join(r.dir, "hb.json")], {
  cwd: r.repo,
  env: { ...process.env, PATH: `${join(r.dir, "bin")}:${process.env.PATH}`, FIXTURE_PRS: join(r.dir, "prs.json") },
});

test("CLI: a stray write after the baseline prints MAIN-CHECKOUT-DIRTY first, naming the path and the live members, and holds every dispatching row", (t) => {
  const r = runCli([], {
    ...LIVE, prs: [pr(350)], bound: 3, keep: true,
    afterBaseline: (repo) => writeFileSync(join(repo, "stray.mjs"), "x\n"),
  });
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^MAIN-CHECKOUT-DIRTY stray\.mjs — changed since the run's baseline; live members: impl-412 — dispatch held: resolve the stray paths FIRST, then re-baseline with ~\/\.fleet\/bin\/fleet-run main-checkout\.mjs --record/);
  assert.match(r.stdout, /^implementers 2\/3 → HOLD \(main checkout dirty\)/m);
  assert.match(r.stdout, /^reviewers +0\/3 → HOLD \(main checkout dirty\)/m);
  assert.match(r.stdout, /^merge-bot +0\/1 → HOLD \(main checkout dirty\)/m);
  assert.doesNotMatch(r.stdout, /PULL|DISPATCH/);

  // Not a one-tick warning: the next tick holds the same way, and only an
  // explicit re-baseline after the path is resolved lets dispatch through.
  assert.match(tickAgain(r, 3).stdout, /^MAIN-CHECKOUT-DIRTY stray\.mjs /m);
  rmSync(join(r.repo, "stray.mjs"));
  const rec = spawnBounded(process.execPath, [join(r.dir, "bin", "main-checkout.mjs"), "--record"], { cwd: r.repo });
  assert.equal(rec.status, 0, rec.stderr);
  const after = tickAgain(r, 3);
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stdout, /MAIN-CHECKOUT|main checkout/);
  assert.match(after.stdout, /^implementers 2\/3 → PULL #420 /m);
});

test("CLI: a branch switch in the main checkout after the baseline holds the run, naming HEAD, and clears itself on the switch back", (t) => {
  const r = runCli([], {
    ...LIVE, prs: [pr(350)], bound: 3, keep: true,
    afterBaseline: (repo) => assert.equal(spawnBounded("git", ["checkout", "-q", "-b", "other"], { cwd: repo }).status, 0),
  });
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim().split("\n")[0], /^MAIN-CHECKOUT-DIRTY HEAD refs\/heads\/\S+@[0-9a-f]{7} → refs\/heads\/other@[0-9a-f]{7} — changed since the run's baseline; live members: impl-412 — dispatch held/);
  assert.match(r.stdout, /^implementers 2\/3 → HOLD \(main checkout dirty\)/m);
  const back = spawnBounded("git", ["switch", "-q", "-"], { cwd: r.repo });
  assert.equal(back.status, 0, back.stderr);
  const after = tickAgain(r, 3);
  assert.doesNotMatch(after.stdout, /MAIN-CHECKOUT|main checkout/);
  assert.match(after.stdout, /^implementers 2\/3 → PULL #420 /m);
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
      const t = spawnBounded(process.execPath, [join(first.dir, "bin", "fleet-tick.mjs"), "--in-flight", String(fixture.bound ?? 2), "--fold-unchanged", "--state", state], {
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

// The phase-0 receipt the tick gates on. Every case holds all three
// dispatching rows and prints the line naming why above them.
const PHASE0_LIVE = { ...LIVE, prs: [pr(350)], bound: 3 };
const withStep = (name, step) => (r) => ({ ...r, steps: { ...r.steps, [name]: { ...r.steps[name], ...step } } });
const CONTROLLER_AT = 1_760_000_000_000;
// A controller record in the case's own state file, the one the tick reads.
const controllerRecord = (record = {}) => (repo) => writeFileSync(join(repo, "..", "heartbeat.json"),
  JSON.stringify({ quiet: 0, elapsed: 0, digest: "", controller: { pid: process.pid, lstart: "runner-start", prior: "none", at: CONTROLLER_AT, ...record } }));
const withController = controllerRecord();
// The process table the tick judges that record against: this runner is the
// tick's parent, and the table's omp is above it.
const procEnv = (t, extra = {}) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-proc-")));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return { FLEET_PROC_TABLE: procTable(d, extra) };
};
for (const [what, fixture, named] of [
  ["no receipt", { phase0: false }, /^PHASE0-INCOMPLETE no receipt at \S+\/\.fleet\/phase0\.json — dispatch held: run ~\/\.fleet\/bin\/fleet-run phase0\.mjs --session <session> and act on what it prints$/],
  ["a receipt of another run", {
    beforeRun: withController,
    phase0: (r) => ({ ...r, run: CONTROLLER_AT - 1 }),
  }, new RegExp(`^PHASE0-INCOMPLETE receipt \\S+/\\.fleet/phase0\\.json is another run's: run ${CONTROLLER_AT - 1}, controller record ${CONTROLLER_AT} — dispatch held: `)],
  ["a failed step", { phase0: withStep("recipe", { status: "failed", output: "derive-testcmd.sh exited 3" }) }, /^PHASE0-INCOMPLETE recipe — dispatch held: run ~\/\.fleet\/bin\/fleet-run phase0\.mjs --session \S+\/session and act on what it prints$/],
  ["a pending step", { phase0: withStep("stranded", { status: "pending", output: "NEED resume #5 /w b" }) }, /^PHASE0-INCOMPLETE stranded — dispatch held: /],
  ["a step the receipt lacks", { phase0: (r) => { const { recipe: _recipe, ...steps } = r.steps; return { ...r, steps }; } }, /^PHASE0-INCOMPLETE recipe — dispatch held: /],
]) {
  test(`CLI: ${what} prints PHASE0-INCOMPLETE first, naming it, and holds every dispatching row`, () => {
    const r = runCli([], { ...PHASE0_LIVE, ...fixture });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    const at = lines.findIndex((l) => l.startsWith("PHASE0-"));
    assert.match(lines[at] ?? "", named, r.stdout);
    assert.ok(at < lines.findIndex((l) => l.startsWith("implementers")), "the line prints above the rows");
    assert.match(r.stdout, /^implementers 2\/3 → HOLD \(phase 0 incomplete\)/m);
    assert.match(r.stdout, /^reviewers +0\/3 → HOLD \(phase 0 incomplete\)/m);
    assert.match(r.stdout, /^merge-bot +0\/1 → HOLD \(phase 0 incomplete\)/m);
    assert.doesNotMatch(r.stdout, /PULL|DISPATCH/);
  });
}

test("CLI: a receipt of this run with every step ok prints nothing extra and holds nothing", (t) => {
  const r = runCli([], PHASE0_LIVE);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /PHASE0|phase 0/);
  assert.match(r.stdout, /^implementers 2\/3 → PULL #420 /m);
  assert.match(r.stdout, /^merge-bot +0\/1 → (?!HOLD)/m);
  // The controller record's `at` is what `run` must equal, and its process
  // is this tick's ancestor.
  const ctl = runCli([], { ...PHASE0_LIVE, beforeRun: withController, env: procEnv(t) });
  assert.equal(ctl.status, 0, ctl.stderr);
  assert.doesNotMatch(ctl.stdout, /PHASE0|phase 0/);
});

test("CLI: a finished receipt whose run's controller has exited holds every dispatching row, and one whose controller is alive does not", (t) => {
  const gone = runCli([], { ...PHASE0_LIVE, beforeRun: controllerRecord({ pid: deadPid() }), env: procEnv(t) });
  assert.equal(gone.status, 0, gone.stderr);
  const line = gone.stdout.trim().split("\n").find((l) => l.startsWith("PHASE0-"));
  assert.match(line ?? "", new RegExp(`^PHASE0-INCOMPLETE receipt \\S+/\\.fleet/phase0\\.json is run ${CONTROLLER_AT}'s and its controller has exited: not this session's finished phase 0 — dispatch held: run \\S+ phase0\\.mjs --session <session> `), gone.stdout);
  assert.match(gone.stdout, /^implementers 2\/3 → HOLD \(phase 0 incomplete\)/m);
  assert.match(gone.stdout, /^reviewers +0\/3 → HOLD \(phase 0 incomplete\)/m);
  assert.match(gone.stdout, /^merge-bot +0\/1 → HOLD \(phase 0 incomplete\)/m);
  assert.doesNotMatch(gone.stdout, /PULL|DISPATCH/);
  const foreign = liveForeign(t);
  const alive = runCli([], {
    ...PHASE0_LIVE, beforeRun: controllerRecord({ pid: foreign, lstart: "foreign-start" }),
    env: procEnv(t, { [foreign]: { ppid: 1, argv: ["bun", "/x/omp"], lstart: "foreign-start" } }),
  });
  assert.equal(alive.status, 0, alive.stderr);
  assert.doesNotMatch(alive.stdout, /PHASE0|phase 0/);
  assert.match(alive.stdout, /^implementers 2\/3 → PULL #420 /m);
});

test("CLI: ruleset drift and a fold-in NEED print as advice on a PHASE0-ADVICE line and hold nothing", () => {
  const r = runCli([], {
    ...PHASE0_LIVE,
    phase0: (x) => withStep("fold-in", { output: "queued 0 PR(s), 0 already on a carried row, 1 closing no issue\nNEED review PR#77 (closes no issue)" })(
      withStep("ruleset", { status: "drift", output: "- required_approving_review_count" })(x)),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n")[0], "PHASE0-ADVICE ruleset drift, fold-in NEED review PR#77 (closes no issue)");
  assert.doesNotMatch(r.stdout, /phase 0 incomplete|PHASE0-INCOMPLETE/);
  assert.match(r.stdout, /^implementers 2\/3 → PULL #420 /m);
});

test("CLI: --fold-unchanged under an unfinished phase 0 folds to one line naming the hold, quiet rising every tick", () => {
  const ticks = foldTicks({ ...LIVE, phase0: withStep("recipe", { status: "pending", output: "NEED derive-recipe" }) });
  for (const t of ticks) assert.equal(t.status, 0, t.stderr);
  assert.match(ticks[0].stdout, /^PHASE0-INCOMPLETE recipe — /);
  assert.match(ticks[0].stdout, /^implementers 1\/2 → HOLD \(phase 0 incomplete\)/m);
  assert.deepEqual(ticks.map((t) => t.quiet), [1, 2, 3]);
  for (const [i, t] of ticks.slice(1).entries()) {
    assert.deepEqual(t.stdout.trim().split("\n"), [
      `fleet-tick: unchanged, nothing to act on (quiet=${i + 2}); HOLD (phase 0 incomplete) persists — full rows on the next change`,
    ]);
  }
});

test("CLI: an unfinished phase 0 over a dirty main checkout prints the phase-0 line above the main-checkout line, and the fold names both holds", () => {
  const both = {
    ...LIVE, phase0: withStep("recipe", { status: "pending", output: "NEED derive-recipe" }),
    afterBaseline: (repo) => writeFileSync(join(repo, "stray.mjs"), "x\n"),
  };
  const ticks = foldTicks(both);
  for (const t of ticks) assert.equal(t.status, 0, t.stderr);
  const lines = ticks[0].stdout.trim().split("\n");
  const phase0At = lines.findIndex((l) => l.startsWith("PHASE0-INCOMPLETE "));
  const mainAt = lines.findIndex((l) => l.startsWith("MAIN-CHECKOUT-DIRTY "));
  assert.ok(phase0At >= 0 && mainAt >= 0, ticks[0].stdout);
  assert.ok(phase0At < mainAt, "the phase-0 line prints above the main-checkout line");
  assert.match(ticks[0].stdout, /^implementers 1\/2 → HOLD \(phase 0 incomplete\)/m);
  for (const [i, t] of ticks.slice(1).entries()) {
    assert.deepEqual(t.stdout.trim().split("\n"), [
      `fleet-tick: unchanged, nothing to act on (quiet=${i + 2}); HOLD (phase 0 incomplete) persists; HOLD (main checkout dirty) persists — full rows on the next change`,
    ]);
  }
});

test("CLI: the tier hold's step names no <session> when this run's receipt records one, and keeps the placeholder without it", () => {
  const UNCHECKED = { ledger: { rows: ["#412 impl-412"], dispatched: ["impl-412"] }, shortlist: shortlistText([420]) };
  const step = (entries) => `run ~/.fleet/bin/fleet-run tier-check.mjs --batch <file> with ${JSON.stringify(entries)}`;
  const withReceipt = runCli([], UNCHECKED);
  assert.equal(withReceipt.status, 0, withReceipt.stderr);
  assert.ok(lineOf(withReceipt, "implementers")[0].includes(step([{ member: "impl-412" }])), withReceipt.stdout);
  const without = runCli([], { ...UNCHECKED, phase0: false });
  assert.equal(without.status, 0, without.stderr);
  assert.ok(lineOf(without, "implementers")[0].includes(step([{ member: "impl-412", session: "<session>" }])), without.stdout);
});

// ---------------------------------------------------------------------------
// --apply. reap.sh, reclaim-scratch.mjs and tier-check.mjs are stubs beside the
// script — the directory it runs its siblings from, and on PATH — each logging
// one line per call to `apply.log` in the fixture dir.
const REAP_STUB = `#!/bin/sh
echo "reap.sh $*" >> "$(dirname "$0")/../apply.log"
[ -n "$REAP_FAIL" ] && { echo "reap.sh: git worktree prune failed: simulated" >&2; exit 2; }
[ -n "$REAP_CORRUPT" ] && echo '{ not json' > "$(dirname "$0")/../heartbeat.json"
echo '{"applied":true,"reaped":["a","b"],"worktreesRemoved":["/w/a"],"kept":[{"ref":"c","reason":"r"}],"warnings":[]}'
`;
const RECLAIM_STUB = `import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
appendFileSync(join(dirname(process.argv[1]), "..", "apply.log"), "reclaim-scratch.mjs " + process.argv.slice(2).join(" ") + "\\n");
if (process.env.RECLAIM_FAIL) { console.error("reclaim-scratch: simulated refusal"); process.exit(2); }
console.log(JSON.stringify({ applied: true, ledger: null, removed: [{ path: "a", reason: "r" }], kept: [], failed: [{ path: "b", error: "e" }] }));
`;
// The batch file's content is the logged line. A verdict lands as the token
// the real check writes on the member's row; exit 2 writes nothing, and
// TIER_CRASH exits 1 writing nothing, as a node throw does.
const TIER_STUB = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const batch = readFileSync(process.argv[process.argv.indexOf("--batch") + 1], "utf8");
appendFileSync(join(dirname(process.argv[1]), "..", "apply.log"), "tier-check.mjs " + batch + "\\n");
const [{ member }] = JSON.parse(batch);
if (process.env.TIER_CRASH) { console.error("tier-check: boom"); process.exit(1); }
const code = Number(process.env.TIER_EXIT ?? 0);
if (code === 2) { console.error(member + ": no " + member + ".jsonl found under the session"); process.exit(2); }
const token = { 0: "tier-ok=" + member + ":fleet-implementer-slow-high", 1: "tier-mismatch=" + member + ":fleet-implementer-slow-high", 3: "tier-unverifiable=" + member + ":no-transcript" }[code];
const ledger = join(process.cwd(), ".fleet", "ledger.md");
writeFileSync(ledger, readFileSync(ledger, "utf8").replace("- #412 " + member, "- #412 " + member + " " + token));
process.exit(code);
`;

// Ticks over one kept fixture and one state file. Each tick is `{args, env,
// before}`: `before(repo)` runs ahead of it. Returns each tick's output, the
// stub calls it made, and the state file's `applied` after it.
function applyTicks(fixture, ticks) {
  const [head, ...rest] = ticks;
  const first = runCli(head.args, {
    ...fixture, env: head.env ?? {}, keep: true,
    beforeRun: (repo) => {
      const bin = join(repo, "..", "bin");
      writeExecStub(join(bin, "reap.sh"), REAP_STUB);
      writeFileSync(join(bin, "reclaim-scratch.mjs"), RECLAIM_STUB);
      writeFileSync(join(bin, "tier-check.mjs"), TIER_STUB);
      (fixture.beforeRun ?? (() => {}))(repo);
    },
  });
  try {
    const log = join(first.dir, "apply.log");
    const state = join(first.dir, "heartbeat.json");
    let seen = 0;
    const calls = () => {
      const all = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      const mine = all.slice(seen);
      seen = all.length;
      return mine;
    };
    const stateText = () => readFileSync(state, "utf8");
    // A state file a stub corrupted reads as no list at all: its text is the evidence.
    const applied = () => {
      try {
        return JSON.parse(stateText()).applied;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        return undefined;
      }
    };
    const out = [{ stdout: first.stdout, stderr: first.stderr, status: first.status, calls: calls(), applied: applied(), stateText: stateText() }];
    for (const t of rest) {
      (t.before ?? (() => {}))(first.repo);
      const r = spawnBounded(process.execPath, [join(first.dir, "bin", "fleet-tick.mjs"), "--in-flight", String(fixture.bound ?? 2), ...t.args, "--state", state], {
        cwd: first.repo,
        env: {
          ...process.env, PATH: `${join(first.dir, "bin")}:${process.env.PATH}`,
          FIXTURE_PRS: join(first.dir, "prs.json"), FIXTURE_CLAIMED: join(first.dir, "claimed.json"),
          FIXTURE_ISSUE_STATES: join(first.dir, "issue-states.json"), FIXTURE_PR_STATES: join(first.dir, "pr-states.json"),
          FIXTURE_REFRESH: join(first.dir, "refresh.json"), REFRESH_LOG: join(first.dir, "refresh.log"),
          ISSUE_VIEW_LOG: join(first.dir, "issue-view.log"), PR_VIEW_LOG: join(first.dir, "pr-view.log"),
          ...(t.env ?? {}),
        },
      });
      out.push({ stdout: r.stdout, stderr: r.stderr, status: r.status, calls: calls(), applied: applied(), stateText: stateText() });
    }
    return { ticks: out, dir: first.dir };
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
  }
}
const APPLY = { args: ["--apply"] };
// The controller record is what a list recorded by --apply is read against.
const MERGED = (dispatched, extra = {}) => ({ ledger: { rows: [], dispatched }, shortlist: shortlistText([7, 8]), beforeRun: controllerRecord(), ...extra });
// The controller record plus a list recorded by an earlier --apply tick.
const withApplied = (applied) => (repo) => {
  controllerRecord()(repo);
  const state = join(repo, "..", "heartbeat.json");
  writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), applied }));
};
const REAP_CALL = "reap.sh --apply";
const isReclaim = (line) => /^reclaim-scratch\.mjs --root \/\S+ --apply$/.test(line);

test("CLI --apply: one `done` merge bot reaps and reclaims once across two ticks, and a second one applies again", () => {
  const { ticks: [one, two, three] } = applyTicks(MERGED(["merge-bot-1=done"]), [APPLY, APPLY, {
    ...APPLY,
    before: (repo) => writeFileSync(join(repo, ".fleet", "ledger.md"), ledgerText({ dispatched: ["merge-bot-1=done", "merge-bot-2=done"] })),
  }]);
  for (const t of [one, two, three]) assert.equal(t.status, 0, t.stderr);
  assert.equal(one.calls.length, 2, JSON.stringify(one.calls));
  assert.equal(one.calls[0], REAP_CALL);
  assert.ok(isReclaim(one.calls[1]), one.calls[1]);
  assert.match(one.stdout, /^APPLIED reap after merge-bot-1: reaped 2, kept 1, worktreesRemoved 1$/m);
  assert.match(one.stdout, /^APPLIED reclaim: removed 1, kept 0, failed 1$/m);
  assert.deepEqual(one.applied, { run: CONTROLLER_AT, reapAfter: [1] });

  assert.deepEqual(two.calls, [], "the second tick reaped again after a pass already reaped after");
  assert.doesNotMatch(two.stdout, /APPLIED/);
  assert.deepEqual(two.applied, { run: CONTROLLER_AT, reapAfter: [1] });

  assert.equal(three.calls.length, 2, JSON.stringify(three.calls));
  assert.match(three.stdout, /^APPLIED reap after merge-bot-2: /m);
  assert.deepEqual(three.applied, { run: CONTROLLER_AT, reapAfter: [1, 2] });
});

test("CLI --apply: a failing reap or reclaim retries on the next tick and records nothing until both apply", () => {
  const { ticks: [one, two, three] } = applyTicks(MERGED(["merge-bot-1=done"]), [
    { ...APPLY, env: { REAP_FAIL: "1" } }, { ...APPLY, env: { RECLAIM_FAIL: "1" } }, APPLY,
  ]);
  for (const t of [one, two, three]) assert.equal(t.status, 0, t.stderr);
  assert.match(one.stdout, /^APPLY FAILED reap: reap\.sh exited 2: reap\.sh: git worktree prune failed: simulated$/m);
  assert.match(one.stdout, /^APPLIED reclaim: /m, "reclaim runs whether or not reap did");
  assert.equal(one.applied, undefined, "a failed reap recorded merge-bot-1");
  assert.equal(two.calls[0], REAP_CALL, "the next tick did not retry the reap");
  assert.match(two.stdout, /^APPLY FAILED reclaim: reclaim-scratch\.mjs exited 2: reclaim-scratch: simulated refusal$/m);
  assert.equal(two.applied, undefined, "a failed reclaim recorded merge-bot-1");
  assert.equal(three.calls.length, 2, JSON.stringify(three.calls));
  assert.deepEqual(three.applied, { run: CONTROLLER_AT, reapAfter: [1] });
});

test("CLI --apply: a list recorded against this run's controller record is read, another run's names nothing", () => {
  // Merge-bot numbering restarts with a run that carries no bot forward, and
  // the state file outlives the rotation: the previous run's `merge-bot-1`
  // must not stand in for this run's.
  const same = applyTicks(MERGED(["merge-bot-1=done"], { beforeRun: withApplied({ run: CONTROLLER_AT, reapAfter: [1] }) }), [APPLY]).ticks[0];
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(same.calls, [], "a list recorded under this run's record was not read");
  assert.deepEqual(same.applied, { run: CONTROLLER_AT, reapAfter: [1] });
  const other = applyTicks(MERGED(["merge-bot-1=done"], { beforeRun: withApplied({ run: 1_700_000_000_000, reapAfter: [1] }) }), [APPLY]).ticks[0];
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.calls[0], REAP_CALL);
  assert.deepEqual(other.applied, { run: CONTROLLER_AT, reapAfter: [1] });
});

test("CLI --apply: with no controller record nothing is recorded and every tick runs both again", () => {
  // Nothing tells this run's `merge-bot-1` from the next run's, so a list
  // recorded without a record would swallow the next run's first passes.
  const { ticks: [one, two] } = applyTicks(MERGED(["merge-bot-1=done"], { beforeRun: () => {} }), [APPLY, APPLY]);
  for (const t of [one, two]) {
    assert.equal(t.status, 0, t.stderr);
    assert.equal(t.calls.length, 2, JSON.stringify(t.calls));
    assert.equal(t.calls[0], REAP_CALL);
    assert.equal(t.applied, undefined, "a list was recorded with no controller record to read it against");
  }
});

test("CLI --apply: only a merge bot settled `done` is a merge pass to reap after", () => {
  const owed = applyTicks(MERGED(["merge-bot-1", "merge-bot-2=killed", "merge-bot-3=done"]), [APPLY]).ticks[0];
  assert.equal(owed.status, 0, owed.stderr);
  assert.match(owed.stdout, /^APPLIED reap after merge-bot-3: /m, "a live or killed merge bot counted as a pass");
  assert.deepEqual(owed.applied, { run: CONTROLLER_AT, reapAfter: [3] });
  const none = applyTicks(MERGED(["merge-bot-1", "merge-bot-2=killed"]), [APPLY]).ticks[0];
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(none.calls, []);
  assert.doesNotMatch(none.stdout, /APPLIED/);
});

test("CLI --apply: a state file the reap left unreadable is not written over", () => {
  const { ticks: [one] } = applyTicks(MERGED(["merge-bot-1=done"]), [{ ...APPLY, env: { REAP_CORRUPT: "1" } }]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.calls.length, 2, "the reap and the reclaim both ran, so the record was owed");
  assert.equal(one.stateText, "{ not json\n", "the tick wrote a list onto a file it could not read");
});

test("reapDue: a list counts only against the controller record it was written under", () => {
  assert.deepEqual(reapDue([1, 2], { run: 5, reapAfter: [1] }, 5), [2]);
  assert.deepEqual(reapDue([1, 2], { run: 5, reapAfter: [1] }, 6), [1, 2], "another run's list named this run's merge-bot-1");
  assert.deepEqual(reapDue([1, 2], { run: 5, reapAfter: [1] }, null), [1, 2], "a list named a run with no record");
  assert.deepEqual(reapDue([1, 2], { run: null, reapAfter: [1, 2] }, undefined), [1, 2], "no record then and none now is not the same run");
  assert.deepEqual(reapDue([3], null, 5), [3]);
  assert.deepEqual(reapedAfter({ run: 5, reapAfter: [1] }, 6), []);
});

test("reapSummary / reclaimSummary: a receipt's counts, null for a stdout carrying none", () => {
  assert.equal(reapSummary('warning first\n{"applied":true,"reaped":[1],"worktreesRemoved":[],"kept":[1,2],"warnings":[]}\n'),
    "reaped 1, kept 2, worktreesRemoved 0");
  const warned = JSON.stringify({ applied: true, reaped: [1], worktreesRemoved: [], kept: [], warnings: [{ branch: "b", note: "branch config section was left: boom" }, { branch: "c", note: "x" }] });
  assert.equal(reapSummary(warned), "reaped 1, kept 0, worktreesRemoved 0, warnings 2: branch config section was left: boom");
  assert.equal(reapSummary(warned.replace(/"warnings":.*\}$/, '"warnings":[{"branch":"b"}]}')), "reaped 1, kept 0, worktreesRemoved 0, warnings 1");
  assert.equal(reclaimSummary('{"applied":true,"ledger":null,"removed":[],"kept":[1],"failed":[1,2,3]}'), "removed 0, kept 1, failed 3");
  for (const junk of ["", "not json", "null", '{"reaped":[]}', '{"removed":[],"kept":[],"failed":"x"}']) {
    assert.equal(reapSummary(junk), null, junk);
    assert.equal(reclaimSummary(junk), null, junk);
  }
});

const UNCHECKED_412 = { ledger: { rows: ["#412 impl-412"], dispatched: ["impl-412"] }, shortlist: shortlistText([420]), refresh: shortlistText([420]) };

test("CLI --apply: without it no stub runs and nothing is recorded, whatever is owed", () => {
  const { ticks: [one] } = applyTicks({
    ledger: { rows: ["#412 impl-412"], dispatched: ["impl-412", "merge-bot-1=done"] }, shortlist: shortlistText([420]),
  }, [{ args: [] }]);
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(one.calls, []);
  assert.equal(one.applied, undefined);
  assert.doesNotMatch(one.stdout, /APPLIED|APPLY FAILED/);
  assert.match(one.stdout, /^implementers 1\/2 → HOLD \(tier unchecked impl-412\)/m);
});

test("CLI --apply: an unchecked implementer gets one batch call with the receipt's session, and a verdict lifts the hold", () => {
  const { ticks: [one], dir } = applyTicks(UNCHECKED_412, [APPLY]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.calls.length, 1, JSON.stringify(one.calls));
  assert.deepEqual(JSON.parse(one.calls[0].slice("tier-check.mjs ".length)), [{ member: "impl-412", session: join(dir, "session") }]);
  assert.match(one.stdout, /^APPLIED tier-check impl-412: tier-ok$/m);
  assert.match(one.stdout, /^implementers 1\/2 → PULL #420/m, "the verdict the check wrote was not read back");
});

test("CLI --apply: a check that exits 1 having written no mismatch failed, and one that wrote it is a verdict", () => {
  // Node exits 1 on a throw, as the check does on a mismatch: only the
  // ledger tells them apart.
  const crashed = applyTicks(UNCHECKED_412, [{ ...APPLY, env: { TIER_CRASH: "1" } }]).ticks[0];
  assert.equal(crashed.status, 0, crashed.stderr);
  assert.match(crashed.stdout, /^APPLY FAILED tier-check impl-412: tier-check\.mjs exited 1: tier-check: boom$/m);
  assert.doesNotMatch(crashed.stdout, /APPLIED tier-check/);
  assert.match(crashed.stdout, /^implementers 1\/2 → HOLD \(tier unchecked impl-412\)/m);
  const mismatch = applyTicks(UNCHECKED_412, [{ ...APPLY, env: { TIER_EXIT: "1" } }]).ticks[0];
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stdout, /^APPLIED tier-check impl-412: tier-mismatch$/m);
  assert.doesNotMatch(mismatch.stdout, /APPLY FAILED/);
  assert.match(mismatch.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-412\)/m, "the verdict the check wrote was not read back");
});

test("CLI --apply: a check that exits 3 is the unverifiable verdict, which lifts the hold", () => {
  const { ticks: [one] } = applyTicks(UNCHECKED_412, [{ ...APPLY, env: { TIER_EXIT: "3" } }]);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^APPLIED tier-check impl-412: tier-unverifiable$/m);
  assert.match(one.stdout, /^implementers 1\/2 → PULL #420/m, "the verdict the check wrote was not read back");
});

test("CLI --apply: a receipt that records no session sends the member alone, and the batch file is removed after", (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-tmpdir-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { ticks: [one] } = applyTicks({
    ...UNCHECKED_412, phase0: (receipt) => ({ ...receipt, session: "" }),
  }, [{ ...APPLY, env: { TMPDIR: tmp } }]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.calls.length, 1, JSON.stringify(one.calls));
  assert.deepEqual(JSON.parse(one.calls[0].slice("tier-check.mjs ".length)), [{ member: "impl-412" }]);
  assert.deepEqual(readdirSync(tmp), [], "the batch file's directory was left behind");
});

test("CLI --apply: a check that exits 2 prints its line and the hold stays", () => {
  const { ticks: [one, two] } = applyTicks(UNCHECKED_412, [{ ...APPLY, env: { TIER_EXIT: "2" } }, { ...APPLY, env: { TIER_EXIT: "2" } }]);
  for (const t of [one, two]) {
    assert.equal(t.status, 0, t.stderr);
    assert.equal(t.calls.length, 1, "each tick checks the still-unchecked member again");
    assert.match(t.stdout, /^APPLIED tier-check impl-412: no verdict — impl-412: no impl-412\.jsonl found under the session$/m);
    assert.match(t.stdout, /^implementers 1\/2 → HOLD \(tier unchecked impl-412\)/m);
  }
});

test("CLI --apply: no check runs where another hold outranks the unchecked one", () => {
  // Phase 0 unfinished holds the implementer row first, and a mismatch on
  // another ticket does too: the row would not print the unchecked hold.
  const held = applyTicks({ ...UNCHECKED_412, phase0: false }, [APPLY]).ticks[0];
  assert.equal(held.status, 0, held.stderr);
  assert.deepEqual(held.calls, []);
  assert.match(held.stdout, /^implementers 1\/2 → HOLD \(phase 0 incomplete\)/m);
  const mismatch = applyTicks({
    ledger: { rows: ["#412 impl-412", "#9 impl-9=tier-mismatch"], dispatched: ["impl-412", "impl-9=tier-mismatch"] },
    shortlist: shortlistText([420]), issueStates: { 9: "OPEN" },
  }, [APPLY]).ticks[0];
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.deepEqual(mismatch.calls, []);
  assert.match(mismatch.stdout, /^implementers 2\/2 → HOLD \(tier mismatch impl-9\)/m, "impl-412 is live and impl-9 is owed a replacement: both are In flight");
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

// The to-spec drops are advice, like a stale member: an idle tick that names
// them still folds and still counts toward `quiet`, so the heartbeat backs off
// as it would without them — and the folded line keeps naming them.
test("CLI: --fold-unchanged folds an idle tick with to-spec drops and the folded line still names them", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-drop-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const text = shortlistText([], 0, [{ n: 2151, reason: "to-spec: User Stories heading" }]);
  const fixture = { shortlist: text, refresh: text };
  const first = runCli(["--fold-unchanged", "--state", path], fixture);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /specs-dropped=#2151 \(to-spec: User Stories heading\)\)$/m);
  const second = runCli(["--fold-unchanged", "--state", path], fixture);
  assert.deepEqual(second.stdout.trim().split("\n"), [
    "fleet-tick: unchanged, nothing to act on (quiet=2); specs-dropped=#2151 (to-spec: User Stories heading) persists — full rows on the next change",
  ]);
});

test("CLI: --fold-unchanged never folds an actionable tick, even an identical one", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-fold-act-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const busy = { shortlist: shortlistText([9, 10]) };
  const first = runCli(["--fold-unchanged", "--state", path], busy);
  const second = runCli(["--fold-unchanged", "--state", path], busy);
  assert.equal(second.stdout, first.stdout);
  assert.match(second.stdout, pullRows(String.raw`implementers 0\/2`, [9, 10]));
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
  assert.match(r.stdout, /^implementers 2\/2 → HOLD \(in-flight 2\/2\)/m);
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

test("CLI: a run's first tick does not report the previous run's unstopped beat — this run is judged from its own marks", (t) => {
  // The record names this runner and was written a second ago, after the
  // previous run's last beat: that beat is the previous run's, whatever `prior`.
  for (const prior of ["dead", "ancestor", "none"]) {
    const { line } = stallLine(t, { pid: process.pid, lstart: "runner-start", prior, at: FIRST() });
    assert.doesNotMatch(line, /heartbeat|previous run/, `prior ${prior}`);
  }
});

test("CLI: the previous run's recorded stop prints once, on this run's first tick, as that run's end — never as this run's stall", (t) => {
  // The shape measured on a live run: the previous run drained and stopped,
  // this run's rotate wrote a later record, and this run is busy writing its
  // ledger without ever beating.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-prior-stop-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const now = Date.now();
  writeFileSync(path, JSON.stringify({
    quiet: 0, elapsed: 0, digest: "",
    beat: { at: now - 20 * 60 * 60_000, interval: 1200, stopped: "run drained, all PRs merged" },
    controller: { pid: process.pid, lstart: "runner-start", prior: "dead", at: now - 5 * 60 * 60_000 },
    acted: { at: now - 5 * 60_000 },
  }));
  const opts = { ...IDLE, env: { FLEET_PROC_TABLE: procTable(dir) } };
  const first = runCli(["--state", path], opts);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout.split("\n")[0], /^previous run stopped deliberately at \S+Z \(\S+ ago\) — recorded reason: run drained, all PRs merged$/);
  assert.doesNotMatch(first.stdout, /STALLED|not beating/);
  for (let i = 0; i < 2; i++) {
    const later = runCli(["--state", path], opts);
    assert.equal(later.status, 0, later.stderr);
    assert.doesNotMatch(later.stdout, /previous run|STALLED|not beating|stopped deliberately/);
  }
});

test("CLI: a tick refused by the gh or the ledger read still records `ticked`, and leaves `quiet` and `digest` as they were", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-refused-ticked-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  const refusals = {
    "gh pr list": { ...IDLE, env: { PR_FAIL: "1" } },
    "ledger.mjs read": {
      ...IDLE,
      beforeRun: (repo) => writeFileSync(join(repo, ".fleet", "ledger.md"), `${ledgerText({ drain: "budget" })}- a second marker\n`),
    },
  };
  for (const [what, opts] of Object.entries(refusals)) {
    writeFileSync(path, JSON.stringify({ quiet: 3, elapsed: 0, digest: "old", ticked: { at: 1_000 } }));
    const before = Date.now();
    const r = runCli(["--state", path], opts);
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(what.replace(".", "\\.")));
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(after.ticked.at >= before && after.ticked.at <= Date.now(), `${what}: ticked.at ${after.ticked.at} is not this tick`);
    assert.equal(after.quiet, 3, what);
    assert.equal(after.digest, "old", what);
  }
  // A usage refusal never reached the state file.
  const untouched = JSON.stringify({ quiet: 3, elapsed: 0, digest: "old", ticked: { at: 1_000 } });
  writeFileSync(path, untouched);
  const r = runCli(["--state", path, "--in-flight", "0"], IDLE);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(readFileSync(path, "utf8"), untouched);
});

test("CLI: a tick refused over a heartbeat file it cannot read leaves the file as it was; one that completes also leaves it unchanged to let rotate still refuse", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-degraded-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  // A record fragment a later rotate must still be able to refuse on.
  const corrupt = '{ "controller": {"pid": 1, "lstart"';
  writeFileSync(path, corrupt);
  const refused = runCli(["--state", path], { ...IDLE, env: { PR_FAIL: "1" } });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /gh pr list/);
  assert.equal(readFileSync(path, "utf8"), corrupt, "a refused tick must not replace a file it could not read");

  // A completed tick also leaves degraded files unchanged, so a later rotate still refuses
  const done = runCli(["--state", path], IDLE);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(path, "utf8"), corrupt, "a completed tick must not replace a degraded heartbeat file, so rotate can still refuse");
});

test("CLI: a tick over a heartbeat file whose controller cannot be judged warns and leaves it byte-identical, refused or completed", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-junk-controller-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  // A parseable file, so the fault is the record and not the JSON: dropping the
  // key on a write would be a lost record that nothing announced.
  for (const controller of [{ pid: "29405", lstart: "x" }, null]) {
    const junk = JSON.stringify({ quiet: 3, elapsed: 0, digest: "old", ticked: { at: 1_000 }, controller });
    const label = JSON.stringify(controller);
    writeFileSync(path, junk);
    const refused = runCli(["--state", path], { ...IDLE, env: { PR_FAIL: "1" } });
    assert.equal(refused.status, 2, `${label}: ${refused.stderr}`);
    assert.match(refused.stderr, /WARNING .* holds a controller record that cannot be judged/, label);
    assert.equal(readFileSync(path, "utf8"), junk, `${label}: a refused tick must not replace the record`);
    const done = runCli(["--state", path], IDLE);
    assert.equal(done.status, 0, `${label}: ${done.stderr}`);
    assert.equal(readFileSync(path, "utf8"), junk, `${label}: a completed tick must not replace the record`);
  }
});

test("CLI: a draining run with no open PR and no live implementer ends on the run-over ACTION, folded or not", (t) => {
  const settled = { rows: ["#5 impl-5=PR#9 · tier-ok=impl-5:fleet-implementer"], dispatched: ["impl-5=PR#9"] };
  const last = (r) => r.stdout.trimEnd().split("\n").at(-1);
  const over = runCli([], { ...IDLE, ledger: { ...settled, drain: "budget" } });
  assert.equal(over.status, 0, over.stderr);
  assert.equal(last(over), `ACTION: run over → fleet-heartbeat.mjs --stop "<reason>"`);
  // An open PR, a live implementer, or no drain marker: the run is not over.
  const notOver = {
    "an open PR": { ...IDLE, ledger: { ...settled, drain: "budget" }, prs: [pr(9)] },
    "a live implementer": { ...IDLE, ledger: { rows: ["#5 impl-5 · tier-ok=impl-5:fleet-implementer"], dispatched: ["impl-5"], drain: "budget" } },
    "no drain marker": { ...IDLE, ledger: settled },
  };
  for (const [what, opts] of Object.entries(notOver)) {
    const r = runCli([], opts);
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /run over/, what);
  }
  // Actionable, so an unchanged heartbeat tick never folds it away.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-run-over-fold-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "heartbeat.json");
  for (let i = 0; i < 2; i++) {
    const r = runCli(["--state", path, "--fold-unchanged"], { ...IDLE, ledger: { ...settled, drain: "budget" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(last(r), `ACTION: run over → fleet-heartbeat.mjs --stop "<reason>"`);
  }
  assert.equal(JSON.parse(readFileSync(path, "utf8")).quiet, 0);
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
  assert.match(r.stdout, /^implementers 1\/2 → HOLD \(tier mismatch impl-7\)/m);
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

test("CLI: a hung probe of a PR off the open list is disclosed at the bound and its review stays a counted unit", () => {
  const r = runCli([], {
    shortlist: shortlistText([]), prs: [REVIEW_DUE], ledger: { rows: zombieRows([101]) }, prStates: { 101: "MERGED" },
    env: hang("pr view"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /fleet-tick: gh pr view 101 timed out after 1s — review on PR#101 unconfirmed finished, its unit stands/);
  assert.match(r.stdout, /^reviewers +1\/2 → DISPATCH review PR#500/m);
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
  assert.match(r.stdout, pullRows(String.raw`implementers 0\/2`, [1, 2]), "the slow CLOSED answer was read and lifted the hold");
});

// The cases above pin the gh spawns the tick has today; this pins the next
// one, on the script's code with its comments blanked. Every call through
// spawnSync or execFileSync that does not name process.execPath, git or a
// sibling script (`join(SCRIPT_DIR, …)`, which is no gh) must
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
  const calls = [...code.matchAll(/\b(?:spawnSync|execFileSync)\(\s*(?=\S)(?!process\.execPath\b|["']git["']|join\(SCRIPT_DIR\b)/g)];
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

// ---------------------------------------------------------------------------
// The tick after phase 0's rotate. A same-session re-invoked run rotates with
// prior `ancestor`, and its earlier members may still be running inside the
// same omp process: the tick must keep counting them, or it dispatches onto
// their work. Each case writes the earlier run's ledger, rotates it with the
// real ledger.mjs under a FLEET_PROC_TABLE record — this runner, the rotate's
// parent, for `ancestor`; a reaped pid for `dead` — and then ticks. The dead
// case is the control: it shows the same ledger does dispatch once nothing
// is carried.
const ANCESTOR_RECORD = { pid: process.pid, lstart: "runner-start", prior: "dead" };
// `extra` is state written into the file rotate rewrites, before it runs: the
// keys a real earlier run left there (the tick's `seen` stamps).
const rotateWith = (extra, controller, ...after) => (repo) => {
  const fleet = join(repo, ".fleet");
  const ledger = (...args) => spawnBounded(process.execPath, [join(repo, "..", "bin", "ledger.mjs"), "--file", join(fleet, "ledger.md"), ...args], {
    cwd: repo, env: { ...process.env, FLEET_PROC_TABLE: procTable(join(repo, "..")) },
  });
  writeFileSync(join(fleet, "heartbeat.json"), JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ...extra, controller }));
  const r = ledger("rotate");
  assert.equal(r.status, 0, r.stderr);
  for (const args of after) {
    const w = ledger(...args);
    assert.equal(w.status, 0, `${args.join(" ")}: ${w.stderr}`);
  }
};
const rotateAs = (controller, ...after) => rotateWith({}, controller, ...after);

test("CLI: a live review=member:review-pr-5 carried across an ancestor rotate is not dispatched again", () => {
  const ledger = { rows: ["#5 review=member:review-pr-5"] };
  const carried = runCli([], { ...IDLE, prs: [pr(5)], ledger, beforeRun: rotateAs(ANCESTOR_RECORD) });
  assert.equal(carried.status, 0, carried.stderr);
  assert.match(carried.stdout, /^reviewers +1\/2 → IDLE OK/m);
  assert.doesNotMatch(carried.stdout, /DISPATCH review PR#5/);

  const dead = runCli([], { ...IDLE, prs: [pr(5)], ledger, beforeRun: rotateAs({ pid: deadPid(), lstart: "x", prior: "ancestor" }) });
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(dead.stdout, /^reviewers +0\/2 → DISPATCH review PR#5/m);
});

test("CLI: live fix-pr, finisher-pr, merge-bot and impl members carried across an ancestor rotate cause no new dispatch", () => {
  const ledger = {
    rows: [
      "#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · review=wf:r1 · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-5",
      "#4 impl-4=PR#6 → PR#6 · tier-ok=impl-4:fleet-implementer-slow-high · review=wf:r2 · reviewed=abc1234:0/0/0:run-bcdefghi · finisher-pr-6",
      "#12 impl-12 · tier-ok=impl-12:fleet-implementer-slow-high",
      "#13 impl-13 · tier-ok=impl-13:fleet-implementer-slow-high",
    ],
    dispatched: ["impl-3=PR#5", "impl-4=PR#6", "fix-pr-5", "finisher-pr-6", "merge-bot-1", "impl-12", "impl-13"],
  };
  const fixture = { shortlist: shortlistText([20, 21]), refresh: shortlistText([20, 21]), prs: [pr(5), pr(6), pr(8, ["ready-to-merge"])], ledger };
  const carried = runCli(["--in-flight", "5"], { ...fixture, beforeRun: rotateAs(ANCESTOR_RECORD) });
  assert.equal(carried.status, 0, carried.stderr);
  assert.match(carried.stdout, /^implementers 5\/5 → HOLD \(in-flight 5\/5\)/m, "two live implementers and three open issue-closing PRs");
  assert.match(carried.stdout, /^merge-bot +1\/1 → AT CAP/m);
  assert.doesNotMatch(carried.stdout, /DISPATCH|PULL/);

  const dead = runCli(["--in-flight", "5"], { ...fixture, beforeRun: rotateAs({ pid: deadPid(), lstart: "x", prior: "ancestor" }) });
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(dead.stdout, pullRows(String.raw`implementers 3\/5`, [20, 21]));
  assert.match(dead.stdout, /DISPATCH review PR#5 PR#6/);
  assert.match(dead.stdout, /^merge-bot +0\/1 → DISPATCH merge-bot/m);
});

test("CLI: a carried reviewer recorded dead with =failed frees its PR, and the next tick dispatches a review for it", () => {
  const r = runCli([], {
    ...IDLE, prs: [pr(5)], ledger: { rows: ["#5 review=member:review-pr-5"] },
    beforeRun: rotateAs(ANCESTOR_RECORD, ["review", "5", "review=member:review-pr-5=failed"]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reviewers +0\/2 → DISPATCH review PR#5/m);
});

// ---------------------------------------------------------------------------
// CHECK-LIVENESS: a live token that has stayed live past its family's
// threshold. Advisory only — the tick prints a pointer, and settles, kills
// and frees nothing.
import { stampSeen, livenessLines, LIVENESS_DEFAULTS } from "../plugin/scripts/fleet-tick.mjs";
import { MEMBER_FAMILIES } from "../plugin/scripts/ledger-grammar.mjs";

const MIN = 60_000;
// A live fix-applier on PR 5 and a live `review=` launch on PR 6: two tokens
// of two families, one of them a launch that carries no member token.
const AGED = {
  shortlist: shortlistText([]), refresh: shortlistText([]), prs: [pr(5), pr(6)],
  ledger: {
    rows: [
      "#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-5",
      "#4 impl-4=PR#6 → PR#6 · tier-ok=impl-4:fleet-implementer-slow-high · review=wf:r2",
    ],
    dispatched: ["impl-3=PR#5", "impl-4=PR#6", "fix-pr-5"],
  },
  // Every member it dispatched wrote its transcript.
  transcripts: ["impl-3", "impl-4", "fix-pr-5"],
};
// The state file the fixture's tick reads, written before it runs: `seen`
// stamps `agoMin` minutes old, and whatever else the case needs.
const seedState = (extra) => (repo) => writeFileSync(join(repo, "..", "heartbeat.json"), JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ...extra }));
const seenAgo = (ages) => ({ seen: Object.fromEntries(Object.entries(ages).map(([name, min]) => [name, Date.now() - min * MIN])) });
const withoutLiveness = (stdout) => stdout.split("\n").filter((l) => !l.startsWith("CHECK-LIVENESS")).join("\n");
const stateOf = (r) => JSON.parse(readFileSync(join(r.dir, "heartbeat.json"), "utf8"));

test("CLI: a live fix-pr and a live review= launch past their threshold print CHECK-LIVENESS; fresh ones print none; rows and quiet are the same either way", () => {
  const stale = runCli([], { ...AGED, keep: true, beforeRun: seedState(seenAgo({ "fix-pr-5": 60, "review:PR#6": 90 })) });
  const fresh = runCli([], { ...AGED, keep: true, beforeRun: seedState(seenAgo({ "fix-pr-5": 5, "review:PR#6": 5 })) });
  try {
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(stale.stdout.split("\n").filter((l) => l.startsWith("CHECK-LIVENESS")), [
      "CHECK-LIVENESS fix-pr-5 (fix-pr > p99 56m)",
      "CHECK-LIVENESS review:PR#6 (review > p99 78m)",
    ]);
    assert.doesNotMatch(fresh.stdout, /CHECK-LIVENESS/);
    // The rows — actual, target, action — and the quiet streak are the same
    // either way: the line is advice, never a row.
    assert.equal(withoutLiveness(stale.stdout), withoutLiveness(fresh.stdout));
    assert.match(stale.stdout, /^reviewers +\d+\/2 /m);
    assert.equal(stateOf(stale).quiet, stateOf(fresh).quiet);
  } finally {
    rmSync(stale.dir, { recursive: true, force: true });
    rmSync(fresh.dir, { recursive: true, force: true });
  }
});

test("CLI: the tick stamps a token it sees first, keeps the stamp it already has, and prunes every name no longer live", () => {
  const old = Date.now() - 90 * MIN;
  const r = runCli([], {
    ...AGED, keep: true,
    beforeRun: seedState({ seen: { "fix-pr-5": old, "impl-99": old, "merge-bot-7": old, "review:PR#99": old } }),
  });
  try {
    const before = Date.now();
    const { seen } = stateOf(r);
    assert.equal(seen["fix-pr-5"], old, "a stamp already held is the token's age and must survive the tick");
    assert.ok(seen["review:PR#6"] > before - 60_000 && seen["review:PR#6"] <= before, "a token first seen now is stamped now");
    assert.deepEqual(Object.keys(seen).sort(), ["fix-pr-5", "review:PR#6"], "stamps of names that are not live are pruned");
    assert.match(r.stdout, /^CHECK-LIVENESS fix-pr-5 \(fix-pr > p99 56m\)$/m);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("CLI: a settled member is never flagged, however old its stamp, and a ledger with no live token leaves no `seen` key", () => {
  const ledger = { rows: ["#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · fix-pr-5=applied:def5678"], dispatched: ["impl-3=PR#5", "fix-pr-5=applied:def5678"] };
  const r = runCli([], { ...IDLE, prs: [pr(5)], ledger, keep: true, beforeRun: seedState(seenAgo({ "fix-pr-5": 600 })) });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /CHECK-LIVENESS/);
    assert.equal("seen" in stateOf(r), false);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("CLI: the tick never writes the ledger, whatever it flags", () => {
  const r = runCli([], { ...AGED, keep: true, beforeRun: seedState(seenAgo({ "fix-pr-5": 600, "review:PR#6": 600 })) });
  try {
    assert.match(r.stdout, /CHECK-LIVENESS/);
    assert.equal(readFileSync(join(r.repo, ".fleet", "ledger.md"), "utf8"), ledgerText(AGED.ledger));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("CLI: --liveness-<family> sets that family's threshold, and the line shows the age only as a multiple of it", () => {
  const impl = { shortlist: shortlistText([]), refresh: shortlistText([]), ledger: { rows: ["#12 impl-12 · tier-ok=impl-12:fleet-implementer-slow-high"], dispatched: ["impl-12"] } };
  const line = (flag, minutes, ago) => {
    const r = runCli(flag === null ? [] : [flag, String(minutes)], { ...impl, beforeRun: seedState(seenAgo({ "impl-12": ago })) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n").filter((l) => l.startsWith("CHECK-LIVENESS"));
  };
  assert.deepEqual(line("--liveness-impl", 5, 12), ["CHECK-LIVENESS impl-12 (impl > 2×p99 10m)"]);
  // The same age is nothing under the default, and one threshold in is the
  // first bucket — no multiple shown.
  assert.deepEqual(line(null, 0, 12), []);
  assert.deepEqual(line(null, 0, 79), ["CHECK-LIVENESS impl-12 (impl > p99 78m)"]);
  assert.deepEqual(line("--liveness-impl", 5, 4), []);
});

for (const flag of ["--liveness-impl", "--liveness-fix-pr", "--liveness-finisher", "--liveness-merge-bot", "--liveness-review"]) {
  test(`CLI: ${flag} refuses 0 and a non-integer, and accepts a positive whole number`, () => {
    for (const bad of ["0", "-3", "1.5", "abc", ""]) {
      const r = runCli([flag, bad], IDLE);
      assert.equal(r.status, 2, `${flag} ${JSON.stringify(bad)}`);
      assert.equal(r.stdout.trim(), "");
    }
    const ok = runCli([flag, "30"], IDLE);
    assert.equal(ok.status, 0, ok.stderr);
  });
}

// One tick, then more over the same kept fixture and state file.
const ticksOver = (args, fixture, again = 1, between = () => {}) => {
  const first = runCli(args, { ...fixture, keep: true });
  try {
    const state = join(first.dir, "heartbeat.json");
    const out = [{ stdout: first.stdout, status: first.status, stderr: first.stderr, state: stateOf(first) }];
    for (let i = 0; i < again; i++) {
      between(first.dir, i);
      const t = spawnBounded(process.execPath, [join(first.dir, "bin", "fleet-tick.mjs"), ...(args.includes("--in-flight") ? [] : ["--in-flight", String(fixture.bound ?? 2)]), ...args, "--state", state], {
        cwd: first.repo,
        env: {
          ...process.env, PATH: `${join(first.dir, "bin")}:${process.env.PATH}`,
          FIXTURE_PRS: join(first.dir, "prs.json"), FIXTURE_CLAIMED: join(first.dir, "claimed.json"),
          FIXTURE_ISSUE_STATES: join(first.dir, "issue-states.json"), FIXTURE_PR_STATES: join(first.dir, "pr-states.json"),
          FIXTURE_REFRESH: join(first.dir, "refresh.json"),
          REFRESH_LOG: join(first.dir, "refresh.log"), ISSUE_VIEW_LOG: join(first.dir, "issue-view.log"), PR_VIEW_LOG: join(first.dir, "pr-view.log"),
        },
      });
      out.push({ stdout: t.stdout, status: t.status, stderr: t.stderr, state: stateOf(first) });
    }
    return out;
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
  }
};

test("CLI: --fold-unchanged with a stale member and nothing else changed folds to one line carrying `CHECK-LIVENESS <member> persists`, without resetting quiet", () => {
  const ticks = ticksOver(["--fold-unchanged"], { ...AGED, beforeRun: seedState(seenAgo({ "fix-pr-5": 60, "review:PR#6": 5 })) }, 2);
  for (const t of ticks) assert.equal(t.status, 0, t.stderr);
  // The tick that finds it stale is a change, so it prints in full.
  assert.match(ticks[0].stdout, /^CHECK-LIVENESS fix-pr-5 \(fix-pr > p99 56m\)$/m);
  for (const t of ticks.slice(1)) {
    assert.deepEqual(t.stdout.trim().split("\n"), [
      `fleet-tick: unchanged, nothing to act on (quiet=${ticks.indexOf(t) + 1}); CHECK-LIVENESS fix-pr-5 persists — full rows on the next change`,
    ]);
  }
});

test("CLI: a folded tick names every stale member, beside a main-checkout hold", () => {
  const ticks = ticksOver(["--fold-unchanged"], {
    ...AGED, beforeRun: seedState(seenAgo({ "fix-pr-5": 60, "review:PR#6": 90 })),
    afterBaseline: (repo) => writeFileSync(join(repo, "stray.mjs"), "x\n"),
  }, 1);
  assert.equal(ticks[1].stdout.trim(),
    "fleet-tick: unchanged, nothing to act on (quiet=2); HOLD (main checkout dirty) persists; CHECK-LIVENESS fix-pr-5 persists; CHECK-LIVENESS review:PR#6 persists — full rows on the next change");
});

test("CLI: the digest is the same anywhere in one threshold bucket and differs in the next, so a fold holds inside a bucket and unfolds across one", () => {
  // fix-pr threshold 56 min: 60 and 100 min old are both the first bucket,
  // 115 min old is the second.
  const digestAt = (ago) => ticksOver([], { ...AGED, beforeRun: seedState(seenAgo({ "fix-pr-5": ago, "review:PR#6": 5 })) }, 0)[0].state.digest;
  assert.equal(digestAt(60), digestAt(100));
  assert.notEqual(digestAt(60), digestAt(115));
});

// The controller guard, through the state file the tick reads. A stamp is the
// token's age, so it survives only where the token it stamps is this run's.
const guarded = (controller, ago = 120) => {
  const r = runCli([], {
    shortlist: shortlistText([]), refresh: shortlistText([]),
    ledger: { rows: ["#9 impl-9 · tier-ok=impl-9:fleet-implementer-slow-high"], dispatched: ["merge-bot-1"] },
    keep: true,
    beforeRun: seedState({ ...seenAgo({ "merge-bot-1": ago }), controller }),
  });
  try {
    assert.equal(r.status, 0, r.stderr);
    return { flagged: /CHECK-LIVENESS merge-bot-1/.test(r.stdout), stamp: stateOf(r).seen["merge-bot-1"] };
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
};

test("CLI: an ancestor rotation keeps the stamp of a carried token; dead and none discard a stamp older than the record, and keep one written since", () => {
  const record = (prior, atAgoMin) => ({ pid: process.pid, lstart: "runner-start", prior, at: Date.now() - atAgoMin * MIN });
  // The merge bot is stamped 120 min ago, past its 101-minute threshold; the
  // record was written 10 min ago, so the stamp predates it.
  assert.equal(guarded(record("ancestor", 10)).flagged, true, "ancestor: a carried token is old and its age must survive");
  for (const prior of ["dead", "none"]) {
    const g = guarded(record(prior, 10));
    assert.equal(g.flagged, false, `${prior}: a stamp from before the record is the previous run's token`);
    assert.ok(g.stamp > Date.now() - 60_000, `${prior}: a same-name token of the new run starts at zero age`);
  }
  // The record is older than the stamp, so the stamp is this run's own and
  // stands, whatever `prior` says.
  for (const prior of ["dead", "none"]) assert.equal(guarded(record(prior, 150)).flagged, true, prior);
  // No record to compare against: the stamp stands.
  assert.equal(guarded(undefined).flagged, true);
});

test("stampSeen: stamps live names, carries what it can trust, and drops names no longer live", () => {
  const now = 1_000_000_000_000;
  const live = ["impl-1", "fix-pr-2", "review:PR#3"];
  const prev = { "impl-1": now - 50 * MIN, "fix-pr-2": now - 5 * MIN, "gone-4": now - 9 * MIN };
  assert.deepEqual(stampSeen({ live, prev, controller: null, now }), { "impl-1": now - 50 * MIN, "fix-pr-2": now - 5 * MIN, "review:PR#3": now });
  const at = now - 20 * MIN;
  const ctl = (prior, over = {}) => ({ pid: 1, lstart: "x", prior, at, ...over });
  assert.deepEqual(stampSeen({ live, prev, controller: ctl("ancestor"), now }), { "impl-1": now - 50 * MIN, "fix-pr-2": now - 5 * MIN, "review:PR#3": now });
  for (const prior of ["dead", "none"]) {
    assert.deepEqual(stampSeen({ live, prev, controller: ctl(prior), now }), { "impl-1": now, "fix-pr-2": now - 5 * MIN, "review:PR#3": now }, prior);
  }
  // The boundary: a stamp written in the record's own millisecond is this
  // run's — "older than the record" is strict — one millisecond earlier is not.
  for (const prior of ["dead", "none"]) {
    assert.deepEqual(stampSeen({ live: ["impl-1"], prev: { "impl-1": at }, controller: ctl(prior), now }), { "impl-1": at }, `${prior}: a stamp at the record's own instant stands`);
    assert.deepEqual(stampSeen({ live: ["impl-1"], prev: { "impl-1": at - 1 }, controller: ctl(prior), now }), { "impl-1": now }, `${prior}: a stamp one millisecond before the record restarts`);
  }
  assert.deepEqual(stampSeen({ live, prev, controller: ctl("dead", { at: null }), now }), { "impl-1": now - 50 * MIN, "fix-pr-2": now - 5 * MIN, "review:PR#3": now });
});

test("livenessLines: one line per live name past its family's threshold, age bucketed to multiples, a name with no stamp or no family silent", () => {
  const now = 1_000_000_000_000;
  const t = { ...LIVENESS_DEFAULTS };
  const lines = (seen, live) => livenessLines({ live, seen, thresholds: t, now }).map((x) => x.line);
  assert.deepEqual(lines({ "finisher-pr-4": now - 57 * MIN }, ["finisher-pr-4"]), ["CHECK-LIVENESS finisher-pr-4 (finisher > p99 57m)"]);
  assert.deepEqual(lines({ "finisher-pr-4": now - 57 * MIN + 1 }, ["finisher-pr-4"]), [], "one millisecond short of the threshold");
  assert.deepEqual(lines({ "merge-bot-2": now - 3 * 101 * MIN - 1 }, ["merge-bot-2"]), ["CHECK-LIVENESS merge-bot-2 (merge-bot > 3×p99 303m)"]);
  assert.deepEqual(lines({ "merge-bot-2": now - 101 * MIN }, ["merge-bot-2", "impl-7"]), ["CHECK-LIVENESS merge-bot-2 (merge-bot > p99 101m)"]);
  assert.deepEqual(lines({ "impl-7": now + 5 * MIN }, ["impl-7"]), [], "a stamp from the future is age zero, never negative");
  assert.deepEqual(lines({ "not-a-member": 1 }, ["not-a-member"]), []);
});

test("LIVENESS_DEFAULTS: one threshold per member family the ledger grammar parses, plus review — a family without one would print a NaN line", () => {
  // The two lists are written by hand in different modules. livenessLines
  // divides by `thresholds[family]`, so a family parseMember yields that has no
  // entry here reads `NaN` and prints a malformed advisory for every live
  // token of it.
  assert.deepEqual(Object.keys(LIVENESS_DEFAULTS).sort(), [...MEMBER_FAMILIES, "review"].sort());
});

test("CLI: a real ancestor rotation carries the heartbeat's `seen` through, so a carried live token keeps its age; a dead controller's rotation carries no token and no stamp", () => {
  // The stamps are seeded INTO the file rotate rewrites, and the tick reads
  // that same file (the default state path, not a --state of its own): a
  // rotate that dropped `seen` would hand the tick a file without it.
  const ages = seenAgo({ "fix-pr-5": 60, "review:PR#6": 90 });
  const stateIn = (r) => JSON.parse(readFileSync(join(r.repo, ".fleet", "heartbeat.json"), "utf8"));
  const carried = runCli([], { ...AGED, keep: true, defaultState: true, beforeRun: rotateWith(ages, ANCESTOR_RECORD) });
  try {
    assert.equal(carried.status, 0, carried.stderr);
    assert.match(carried.stdout, /^CHECK-LIVENESS fix-pr-5 \(fix-pr > p99 56m\)$/m);
    assert.match(carried.stdout, /^CHECK-LIVENESS review:PR#6 \(review > p99 78m\)$/m);
    assert.equal(stateIn(carried).seen["fix-pr-5"], ages.seen["fix-pr-5"]);
  } finally {
    rmSync(carried.dir, { recursive: true, force: true });
  }
  const dead = runCli([], { ...AGED, keep: true, defaultState: true, beforeRun: rotateWith(ages, { pid: deadPid(), lstart: "x", prior: "ancestor" }) });
  try {
    assert.equal(dead.status, 0, dead.stderr);
    assert.doesNotMatch(dead.stdout, /CHECK-LIVENESS/);
    assert.equal("seen" in stateIn(dead), false, "nothing was carried, so nothing is live and no stamp survives");
  } finally {
    rmSync(dead.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SETTLE: a live member whose report file is on disk. The message carrying a
// report can be dropped or delayed; the file cannot. Advisory only — the tick
// prints the settle it is for and runs none of it.
import { utimesSync } from "node:fs";
import { reportLines, readReports } from "../plugin/scripts/fleet-tick.mjs";
import { SCHEMAS, validate } from "../plugin/scripts/report-schema.mjs";

// A live fix-applier on PR 5 and a live merge-bot, an in-flight
// `review=member:` runner on PR 6, a `review=wf:` run on PR 7, and implementers
// already settled.
const REPORTED = {
  shortlist: shortlistText([]), refresh: shortlistText([]), prs: [pr(5), pr(6), pr(7)],
  ledger: {
    rows: [
      "#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-5",
      "#4 impl-4=PR#6 → PR#6 · tier-ok=impl-4:fleet-implementer-slow-high · review=member:review-pr-6",
      "#8 impl-8=PR#7 → PR#7 · tier-ok=impl-8:fleet-implementer-slow-high · review=wf:r7",
    ],
    dispatched: ["impl-3=PR#5", "impl-4=PR#6", "impl-8=PR#7", "fix-pr-5", "merge-bot-1"],
  },
};
// The smallest report that validates against its member family's schema, for a
// name in one of the four families; a name no schema covers holds `{member}`.
const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const validReport = (name) => {
  if (/^impl-/.test(name)) return { member: name, outcome: "pr", pr: 5, head: SHA40, branch: "b", sizing: null, bailCause: null, bailDetail: null, confirmation: [] };
  if (/^fix-pr-/.test(name)) return { member: name, outcome: "no-op", head: SHA40, branch: "b", applied: [], deferred: [], filed: [], unrecorded: [], dispositionsRecord: "/r", testRun: { cmd: "t", exit: 0, tests: 1, cancelled: 0 }, confirmation: [] };
  if (/^finisher-pr-/.test(name)) return { member: name, outcome: "labelled", cause: null, evidence: null, pin: SHA40, labelsReadBack: [], kill: null, filed: [], unrecorded: [], confirmation: [] };
  if (/^merge-bot-/.test(name)) return { member: name, merged: [], held: [], conflictHold: [], refused: [], branchKept: [] };
  return { member: name };
};
// A scratch root of its own holding `<root>/reports/<name>.json` for each
// entry of `files` — `{name: {member, agoMin, body, text, dir}}`, the file
// `agoMin` minutes old and holding the valid report of `name` (its `member`
// field set to `member` when that is given), or `body` as JSON, or `text`
// verbatim, or a directory in its place when `dir` is set.
const scratchWith = (files) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-scratch-")));
  mkdirSync(join(root, "reports"));
  for (const [name, { member = name, agoMin = 0, body, text, dir = false }] of Object.entries(files)) {
    const path = join(root, "reports", `${name}.json`);
    if (dir) {
      mkdirSync(path);
      continue;
    }
    writeFileSync(path, text ?? JSON.stringify(body ?? { ...validReport(name), member }));
    const t = new Date(Date.now() - agoMin * MIN);
    utimesSync(path, t, t);
  }
  return root;
};
// The phase-0 receipt naming `root` as the scratch root, or naming none.
const receiptScratch = (root) => (r) => {
  const { scratch, ...rest } = r;
  return root === null ? rest : { ...rest, scratch: root };
};
// One tick over REPORTED with the given report files, the receipt naming their
// root unless `receipt` is false; `args` maps that root to the tick's argv.
const reportTick = (files, { receipt = true, args = () => [], fixture = {} } = {}) => {
  const root = scratchWith(files);
  try {
    return runCli(args(root), { ...REPORTED, phase0: receiptScratch(receipt ? root : null), ...fixture, keep: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const reportLinesOf = (stdout) => stdout.split("\n").filter((l) => /^(?:SETTLE|REPORT-MISMATCH|REPORT-UNREADABLE|REPORT-INVALID) /.test(l));
const settleLine = (member, age, reportsFrom = "") => `SETTLE ${member} (report on disk since ${age}m — ledger.mjs settle ${member} --from-report${reportsFrom && ` --reports ${reportsFrom}`})`;
const NO_SCRATCH = "fleet-tick: report files and Pull records not checked — no scratch in the phase-0 receipt and no --scratch";

test("CLI: a live token with a report file prints SETTLE above the rows; a settled token with a file, a live token without one and an in-flight review runner with one print nothing; rows, quiet and the ledger are untouched", () => {
  const r = reportTick({
    "fix-pr-5": { member: "fix-pr-5", agoMin: 7 },
    "merge-bot-1": { member: "merge-bot-1", agoMin: 2 },
    "review-pr-6": { member: "review-pr-6", agoMin: 2 },
    "impl-3": { member: "impl-3", agoMin: 30 },
  });
  const bare = reportTick({});
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bare.status, 0, bare.stderr);
    assert.deepEqual(reportLinesOf(r.stdout), [settleLine("fix-pr-5", 7), settleLine("merge-bot-1", 2)]);
    const out = r.stdout.split("\n");
    assert.ok(out.findIndex((l) => l.startsWith("SETTLE ")) < out.findIndex((l) => /^implementers /.test(l)), "printed above the rows");
    // The same live tokens with no file on disk: nothing.
    assert.deepEqual(reportLinesOf(bare.stdout), []);
    assert.doesNotMatch(r.stderr + bare.stderr, /Pull records not checked/);
    // Advice, never a row: the rest of the output and the quiet streak are the
    // same either way, and the ledger is never written.
    const withoutReports = (s) => s.split("\n").filter((l) => !l.startsWith("SETTLE ")).join("\n");
    assert.equal(withoutReports(r.stdout), bare.stdout);
    assert.equal(stateOf(r).quiet, stateOf(bare).quiet);
    assert.equal(readFileSync(join(r.repo, ".fleet", "ledger.md"), "utf8"), ledgerText(REPORTED.ledger));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(bare.dir, { recursive: true, force: true });
  }
});

test("CLI: a report file whose `member` is not its filename prints REPORT-MISMATCH once, naming the file and what it names, and no SETTLE; a file that is there and cannot be read prints REPORT-UNREADABLE with its error code, and no SETTLE", () => {
  let mismatchRoot, unreadableRoot;
  const r = reportTick({ "fix-pr-5": { member: "fix-pr-9" }, "merge-bot-1": { text: "not json" } }, { args: (at) => { mismatchRoot = at; return []; } });
  const unreadable = reportTick({ "fix-pr-5": { dir: true } }, { args: (at) => { unreadableRoot = at; return []; } });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(reportLinesOf(r.stdout), [
      `REPORT-MISMATCH ${join(mismatchRoot, "reports", "fix-pr-5.json")} (member: fix-pr-9)`,
      `REPORT-MISMATCH ${join(mismatchRoot, "reports", "merge-bot-1.json")} (member: none)`,
    ]);
    assert.equal(unreadable.status, 0, unreadable.stderr);
    assert.deepEqual(reportLinesOf(unreadable.stdout), [`REPORT-UNREADABLE ${join(unreadableRoot, "reports", "fix-pr-5.json")} (EISDIR)`]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(unreadable.dir, { recursive: true, force: true });
  }
});

test("CLI: --fold-unchanged with a report waiting and nothing else changed folds to one line carrying `SETTLE <member> persists`, without resetting quiet", () => {
  const root = scratchWith({ "fix-pr-5": { member: "fix-pr-5", agoMin: 3 } });
  try {
    const ticks = ticksOver(["--fold-unchanged"], { ...REPORTED, phase0: receiptScratch(root) }, 2);
    for (const t of ticks) assert.equal(t.status, 0, t.stderr);
    // The tick that finds it is a change, so it prints in full.
    assert.match(ticks[0].stdout, new RegExp(`^${RegExp.escape(settleLine("fix-pr-5", 3))}$`, "m"));
    for (const t of ticks.slice(1)) {
      assert.deepEqual(t.stdout.trim().split("\n"), [
        `fleet-tick: unchanged, nothing to act on (quiet=${ticks.indexOf(t) + 1}); SETTLE fix-pr-5 persists — full rows on the next change`,
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: the digest leaves a report's age out, so one waiting on disk folds however long it waits, and its arrival is a change", () => {
  const digestOf = (files) => {
    const r = reportTick(files);
    try {
      assert.equal(r.status, 0, r.stderr);
      return stateOf(r).digest;
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  };
  const at = (agoMin) => digestOf({ "fix-pr-5": { member: "fix-pr-5", agoMin } });
  assert.equal(at(1), at(40));
  assert.notEqual(at(1), digestOf({}));
});

test("CLI: with no scratch in the receipt the tick reads --scratch and its SETTLE names that root's reports for the settle to read; with neither it skips the check with one stderr line; the receipt's scratch outranks --scratch", () => {
  const files = { "fix-pr-5": { member: "fix-pr-5" } };
  const run = (opts) => {
    let root;
    const r = reportTick(files, { ...opts, args: (at) => { root = at; return (opts.args ?? (() => []))(at); } });
    try {
      assert.equal(r.status, 0, r.stderr);
      return {
        lines: reportLinesOf(r.stdout).map((l) => l.replaceAll(root, "<root>")),
        skipped: r.stderr.split("\n").filter((l) => /Pull records not checked/.test(l)),
      };
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(run({ receipt: false, args: (root) => ["--scratch", root] }), { lines: [settleLine("fix-pr-5", 0, "<root>/reports")], skipped: [] });
  assert.deepEqual(run({ fixture: { phase0: false }, args: (root) => ["--scratch", root] }), { lines: [settleLine("fix-pr-5", 0, "<root>/reports")], skipped: [] },
    "no receipt at all reads --scratch the same way");
  assert.deepEqual(run({ receipt: false }), { lines: [], skipped: [NO_SCRATCH] });
  // The receipt's root is the one ledger.mjs reads unaided, so no --reports.
  assert.deepEqual(run({ args: () => ["--scratch", join(tmpdir(), "fleet-tick-no-such-scratch")] }), { lines: [settleLine("fix-pr-5", 0)], skipped: [] });
});

test("reportLines: SETTLE for a live name whose file names it, REPORT-MISMATCH once for one that names another, REPORT-UNREADABLE for one that cannot be read, nothing for a name with no file; the key drops the age", () => {
  const now = 1_000_000_000_000;
  const file = (member, agoMin) => ({ path: `/s/reports/${member}.json`, since: now - agoMin * MIN, member });
  const reports = new Map([
    ["impl-12", file("impl-12", 9)],
    ["merge-bot-2", { ...file("merge-bot-2", 1), member: "merge-bot-3" }],
    ["finisher-pr-4", { ...file("finisher-pr-4", 1), member: undefined }],
    ["fix-pr-5", file("fix-pr-5", -5)],
    ["impl-14", { path: "/s/reports/impl-14.json", unreadable: "EACCES" }],
  ]);
  assert.deepEqual(reportLines({ reporters: ["impl-12", "impl-12", "merge-bot-2", "finisher-pr-4", "fix-pr-5", "impl-13", "impl-14"], reports, now }), [
    { member: "impl-12", settle: true, key: "SETTLE impl-12", line: settleLine("impl-12", 9) },
    { member: "merge-bot-2", settle: false, key: "REPORT-MISMATCH /s/reports/merge-bot-2.json (member: merge-bot-3)", line: "REPORT-MISMATCH /s/reports/merge-bot-2.json (member: merge-bot-3)" },
    { member: "finisher-pr-4", settle: false, key: "REPORT-MISMATCH /s/reports/finisher-pr-4.json (member: none)", line: "REPORT-MISMATCH /s/reports/finisher-pr-4.json (member: none)" },
    { member: "fix-pr-5", settle: true, key: "SETTLE fix-pr-5", line: settleLine("fix-pr-5", 0) },
    { member: "impl-14", settle: false, key: "REPORT-UNREADABLE /s/reports/impl-14.json (EACCES)", line: "REPORT-UNREADABLE /s/reports/impl-14.json (EACCES)" },
  ]);
  // A name that is not live is never looked up, whatever is on disk for it.
  assert.deepEqual(reportLines({ reporters: [], reports, now }), []);
  assert.equal(reportLines({ reporters: ["impl-12"], reports: new Map([["impl-12", { ...file("impl-12", 0), member: 12 }]]), now })[0].line,
    "REPORT-MISMATCH /s/reports/impl-12.json (member: 12)");
  // `reportsFrom` names the reports directory the settle reads, as one shell word.
  const settleFrom = (reportsFrom) => reportLines({ reporters: ["impl-12"], reports, now, reportsFrom })[0];
  assert.equal(settleFrom("/r/reports").line, settleLine("impl-12", 9, "/r/reports"));
  assert.equal(settleFrom("/r/reports").key, "SETTLE impl-12", "the key does not carry the directory");
  assert.equal(settleFrom("/a b/it's").line, settleLine("impl-12", 9, "'/a b/it'\\''s'"));
});

test("the report fixtures every SETTLE test relies on validate against their family's schema", () => {
  for (const [name, family] of [["impl-3", "impl"], ["fix-pr-5", "fix-pr"], ["finisher-pr-4", "finisher"], ["merge-bot-1", "merge-bot"]]) {
    assert.equal(validate(SCHEMAS[family], validReport(name)), null, `${name} fixture is not a valid ${family} report`);
  }
});

test("reportLines: a file that names its member and fails the schema prints REPORT-INVALID with the violation, never settleable, keyed on the line itself; a mismatch or an unreadable file outranks it; an entry with no violation, as a member no schema covers has, is unaffected", () => {
  const now = 1_000_000_000_000;
  const violation = '$: missing required field "outcome"';
  const file = (member, agoMin, extra = {}) => ({ path: `/s/reports/${member}.json`, since: now - agoMin * MIN, member, ...extra });
  const invalid = `REPORT-INVALID /s/reports/fix-pr-5.json (${violation})`;
  const reports = new Map([
    ["fix-pr-5", file("fix-pr-5", 9, { violation })],
    ["merge-bot-2", file("merge-bot-2", 1, { member: "merge-bot-3", violation })],
    ["impl-12", file("impl-12", 4)],
    ["review-pr-6", file("review-pr-6", 3)],
  ]);
  assert.deepEqual(reportLines({ reporters: ["fix-pr-5", "merge-bot-2", "impl-12", "review-pr-6"], reports, now }), [
    { member: "fix-pr-5", settle: false, invalid: true, key: invalid, line: invalid },
    { member: "merge-bot-2", settle: false, key: "REPORT-MISMATCH /s/reports/merge-bot-2.json (member: merge-bot-3)", line: "REPORT-MISMATCH /s/reports/merge-bot-2.json (member: merge-bot-3)" },
    { member: "impl-12", settle: true, key: "SETTLE impl-12", line: settleLine("impl-12", 4) },
    { member: "review-pr-6", settle: true, key: "SETTLE review-pr-6", line: settleLine("review-pr-6", 3) },
  ]);
  const unreadable = new Map([["fix-pr-5", { path: "/s/reports/fix-pr-5.json", unreadable: "EACCES", violation }]]);
  assert.equal(reportLines({ reporters: ["fix-pr-5"], reports: unreadable, now })[0].line, "REPORT-UNREADABLE /s/reports/fix-pr-5.json (EACCES)");
  // The age is not in the line, so the digest does not move while it waits.
  const aged = (agoMin) => reportLines({ reporters: ["fix-pr-5"], reports: new Map([["fix-pr-5", file("fix-pr-5", agoMin, { violation })]]), now })[0];
  assert.deepEqual(aged(1), aged(40));
});

test("readReports: a file that fails its family's schema carries the violation, one that validates carries none, a name no schema covers is read for its member and never looked up, and a name with no file has no entry", () => {
  const root = scratchWith({
    "fix-pr-5": { body: { member: "fix-pr-5" } },
    "merge-bot-1": {},
    "impl-12": { text: "not json" },
    "review-pr-6": {},
  });
  try {
    const read = readReports(root, ["fix-pr-5", "merge-bot-1", "impl-12", "review-pr-6", "finisher-pr-4"]);
    assert.equal(read.get("fix-pr-5").violation, '$: missing required field "outcome"');
    assert.equal(read.get("fix-pr-5").member, "fix-pr-5");
    assert.equal("violation" in read.get("merge-bot-1"), false);
    assert.match(read.get("impl-12").violation, /^\$: not JSON/);
    assert.equal(read.get("impl-12").member, undefined);
    assert.equal(read.get("review-pr-6").member, "review-pr-6");
    assert.equal("violation" in read.get("review-pr-6"), false);
    assert.equal(read.has("finisher-pr-4"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: a report file that names its member and fails its family's schema prints REPORT-INVALID with the file and the violation and no SETTLE; a fully valid report prints SETTLE; the tick still exits 0 and writes no ledger row", () => {
  let root;
  const r = reportTick({ "fix-pr-5": { body: { member: "fix-pr-5" }, agoMin: 4 }, "merge-bot-1": { body: { member: "merge-bot-1" } } }, { args: (at) => { root = at; return []; } });
  const valid = reportTick({ "fix-pr-5": { agoMin: 4 }, "merge-bot-1": {} });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(reportLinesOf(r.stdout), [
      `REPORT-INVALID ${join(root, "reports", "fix-pr-5.json")} ($: missing required field "outcome")`,
      `REPORT-INVALID ${join(root, "reports", "merge-bot-1.json")} ($: missing required field "merged")`,
    ]);
    assert.doesNotMatch(r.stdout, /^SETTLE /m);
    assert.equal(readFileSync(join(r.repo, ".fleet", "ledger.md"), "utf8"), ledgerText(REPORTED.ledger));
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(reportLinesOf(valid.stdout), [settleLine("fix-pr-5", 4), settleLine("merge-bot-1", 0)]);
    assert.doesNotMatch(valid.stdout, /^REPORT-INVALID /m);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(valid.dir, { recursive: true, force: true });
  }
});

test("CLI: --fold-unchanged with an invalid report waiting folds to one line carrying `REPORT-INVALID <member> persists` and not `SETTLE <member> persists`, without resetting quiet; the age is not in the digest", () => {
  const root = scratchWith({ "fix-pr-5": { body: { member: "fix-pr-5" }, agoMin: 3 } });
  try {
    const ticks = ticksOver(["--fold-unchanged"], { ...REPORTED, phase0: receiptScratch(root) }, 3);
    for (const t of ticks) assert.equal(t.status, 0, t.stderr);
    assert.match(ticks[0].stdout, /^REPORT-INVALID .*fix-pr-5\.json \(\$: missing required field "outcome"\)$/m);
    for (const t of ticks.slice(1)) {
      assert.deepEqual(t.stdout.trim().split("\n"), [
        `fleet-tick: unchanged, nothing to act on (quiet=${ticks.indexOf(t) + 1}); REPORT-INVALID fix-pr-5 persists — full rows on the next change`,
      ]);
      assert.doesNotMatch(t.stdout, /SETTLE/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: the digest of a waiting invalid report leaves its age out, and the report turning valid is a change", () => {
  const root = scratchWith({ "fix-pr-5": { body: { member: "fix-pr-5" }, agoMin: 1 } });
  const path = join(root, "reports", "fix-pr-5.json");
  const digest = () => {
    const r = runCli([], { ...REPORTED, phase0: receiptScratch(root), keep: true });
    try {
      assert.equal(r.status, 0, r.stderr);
      return stateOf(r).digest;
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  };
  try {
    const young = digest();
    const old = new Date(Date.now() - 40 * MIN);
    utimesSync(path, old, old);
    assert.equal(digest(), young);
    writeFileSync(path, JSON.stringify(validReport("fix-pr-5")));
    assert.notEqual(digest(), young);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveRun: reporters are every unsettled member token — never a settled token, a review runner, a wf: run, or a review that returned or failed", () => {
  const run = deriveRun({
    rows: [
      "#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-5",
      "#4 impl-4=PR#6 → PR#6 · tier-ok=impl-4:fleet-implementer-slow-high · review=member:review-pr-6",
      "#8 impl-8=PR#7 → PR#7 · tier-ok=impl-8:fleet-implementer-slow-high · review=wf:r7",
      "#9 impl-9=PR#10 → PR#10 · tier-ok=impl-9:fleet-implementer-slow-high · review=member:review-pr-10 · reviewed=abc1234:0/0/0:run-abcdefgh",
      "#11 impl-11=PR#12 → PR#12 · tier-ok=impl-11:fleet-implementer-slow-high · review=member:review-pr-12=failed",
      "#13 impl-13 · tier-ok=impl-13:fleet-implementer-slow-high",
    ],
    dispatched: ["impl-3=PR#5", "impl-4=PR#6", "impl-8=PR#7", "impl-9=PR#10", "impl-11=PR#12", "impl-13", "fix-pr-5", "merge-bot-1"],
    drain: null,
  }, [pr(5), pr(6), pr(7), pr(10), pr(12)]);
  assert.deepEqual([...run.reporters].sort(), ["fix-pr-5", "impl-13", "merge-bot-1"]);
});

// ---------------------------------------------------------------------------
// UNRECORDED / NO-TRANSCRIPT: the session directory's listing against the
// ledger's tokens. Advisory, like CHECK-LIVENESS: no row, no `quiet`, no slot.
import { transcriptStems, unrecordedLines, noTranscriptLines, ageChecks } from "../plugin/scripts/fleet-tick.mjs";

test("transcriptStems: the stem of every .jsonl name, sorted; nothing else in the listing", () => {
  assert.deepEqual(transcriptStems(["impl-9.jsonl", "impl-12-b.jsonl", "notes.txt", "agent-abc123.jsonl", "impl-3.json"]),
    ["agent-abc123", "impl-12-b", "impl-9"]);
});

test("unrecordedLines: a member-named stem the ledger records nowhere prints UNRECORDED, any family and retry letters included; a recorded stem and a stem that is no member's name print nothing", () => {
  const recorded = new Set(["impl-3", "fix-pr-5", "impl-7"]);
  const stems = ["agent-abc123", "finisher-pr-4", "fix-pr-5", "impl-12-b", "impl-3", "impl-7", "merge-bot-2", "review-pr-6"];
  assert.deepEqual(unrecordedLines({ stems, recorded }), ["finisher-pr-4", "impl-12-b", "merge-bot-2"].map((name) => ({
    kind: "UNRECORDED", name, line: `UNRECORDED ${name} (transcript exists, no ledger token)`, key: `UNRECORDED ${name} (transcript exists, no ledger token)`,
  })));
  assert.deepEqual(unrecordedLines({ stems: ["impl-3", "fix-pr-5"], recorded }), [], "every stem the ledger records is accepted");
});

test("deriveRun: recorded is every member name on a row, in ## Dispatched and in ## Retired, settled or live; a ledger with no ## Retired records the rest", () => {
  const ledger = { rows: ["#3 impl-3=PR#5 → PR#5 · fix-pr-5=applied:abc1234"], dispatched: ["impl-3=PR#5", "merge-bot-1"], drain: null };
  const prs = [pr(5)];
  assert.deepEqual([...deriveRun({ ...ledger, retired: ["impl-2", "review-pr-4"] }, prs).recorded].sort(), ["fix-pr-5", "impl-2", "impl-3", "merge-bot-1", "review-pr-4"]);
  assert.deepEqual([...deriveRun(ledger, prs).recorded].sort(), ["fix-pr-5", "impl-3", "merge-bot-1"]);
});

test("deriveRun: a ## Retired line with an outcome records its name, the text before the first `=`", () => {
  const ledger = { rows: [], dispatched: [], drain: null, retired: ["impl-5=killed", "review-pr-9=failed"] };
  assert.deepEqual([...deriveRun(ledger, []).recorded].sort(), ["impl-5", "review-pr-9"]);
});

test("deriveRun: a ## Retired line naming no member or reviewer throws LedgerError naming it", () => {
  const ledger = { rows: [], dispatched: [], drain: null, retired: ["impl-1", "garbage-name"] };
  assert.throws(() => deriveRun(ledger, []), (e) => e instanceof LedgerError
    && e.message === "## Retired line 'garbage-name' names no member or reviewer — fix the ledger by hand before the tick can count from it");
});

test("noTranscriptLines: a live member token first seen more than `after` minutes ago with no transcript prints NO-TRANSCRIPT; one with a transcript, one at the threshold and a review launch print nothing; the key drops the age", () => {
  const now = 1_000_000_000_000;
  const seen = { "impl-12": now - 6 * MIN, "fix-pr-5": now - 60 * MIN, "merge-bot-1": now - 5 * MIN, "review:PR#6": now - 60 * MIN, "impl-13": now - 5 * MIN - 1 };
  const live = ["impl-12", "fix-pr-5", "merge-bot-1", "review:PR#6", "impl-13", "impl-14"];
  assert.deepEqual(noTranscriptLines({ live, seen, stems: ["fix-pr-5"], session: "/s/run", after: 5, now }), [
    { kind: "NO-TRANSCRIPT", name: "impl-12", key: "NO-TRANSCRIPT impl-12", line: "NO-TRANSCRIPT impl-12 (live 6m, no /s/run/impl-12.jsonl)" },
    { kind: "NO-TRANSCRIPT", name: "impl-13", key: "NO-TRANSCRIPT impl-13", line: "NO-TRANSCRIPT impl-13 (live 5m, no /s/run/impl-13.jsonl)" },
  ]);
  assert.deepEqual(noTranscriptLines({ live, seen, stems: ["fix-pr-5"], session: "/s/run", after: 10, now }), [],
    "a longer threshold names nobody under it");
  assert.deepEqual(noTranscriptLines({ live: ["impl-14"], seen: { "impl-14": now - 5 * MIN - 40_000 }, stems: [], session: "/s/run", after: 5, now }).map((n) => n.line),
    ["NO-TRANSCRIPT impl-14 (live 5m, no /s/run/impl-14.jsonl)"], "the age is whole minutes, rounded down");
});

// A live implementer with no transcript, a live fix-applier with one, a
// settled implementer, a retired name, a member-named stem the ledger lacks
// (`impl-20`) and a non-member stem (`agent-abc123`) in the session directory.
const SESSIONED = {
  shortlist: shortlistText([]), refresh: shortlistText([]), prs: [pr(5)],
  ledger: {
    rows: ["#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-5", "#12 impl-12 · tier-ok=impl-12:fleet-implementer-slow-high"],
    dispatched: ["impl-3=PR#5", "fix-pr-5", "impl-12"],
    retired: ["impl-7"],
  },
  transcripts: ["impl-3", "fix-pr-5", "impl-7", "impl-20", "agent-abc123"],
};
const transcriptLinesOf = (stdout) => stdout.split("\n").filter((l) => /^(UNRECORDED|NO-TRANSCRIPT) /.test(l));
const withoutTranscripts = (stdout) => stdout.split("\n").filter((l) => !/^(UNRECORDED|NO-TRANSCRIPT) /.test(l)).join("\n");

test("CLI: with a session directory, an unrecorded member stem prints UNRECORDED and a live token with no file prints NO-TRANSCRIPT only past the threshold, above the rows; a retired stem, a stranger's stem and a live token with a file print nothing; rows and quiet are the same either way", () => {
  const old = runCli([], { ...SESSIONED, keep: true, beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })) });
  const fresh = runCli([], { ...SESSIONED, keep: true, beforeRun: seedState(seenAgo({ "impl-12": 2, "fix-pr-5": 10 })) });
  try {
    assert.equal(old.status, 0, old.stderr);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(transcriptLinesOf(old.stdout), [
      "UNRECORDED impl-20 (transcript exists, no ledger token)",
      `NO-TRANSCRIPT impl-12 (live 10m, no ${join(old.dir, "session", "impl-12.jsonl")})`,
    ]);
    assert.deepEqual(transcriptLinesOf(fresh.stdout), ["UNRECORDED impl-20 (transcript exists, no ledger token)"]);
    const lines = old.stdout.split("\n");
    assert.ok(lines.findIndex((l) => l.startsWith("NO-TRANSCRIPT")) < lines.findIndex((l) => l.startsWith("implementers")), "printed above the rows");
    assert.equal(withoutTranscripts(old.stdout), withoutTranscripts(fresh.stdout));
    assert.equal(stateOf(old).quiet, stateOf(fresh).quiet);
    assert.equal(old.stderr, "", "a listed session directory says nothing on stderr");
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(fresh.dir, { recursive: true, force: true });
  }
});

test("CLI --fold-unchanged: UNRECORDED and NO-TRANSCRIPT fold to the one line, each named on it, without resetting quiet", () => {
  const ticks = ticksOver(["--fold-unchanged"], { ...SESSIONED, beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })) }, 2);
  for (const t of ticks) assert.equal(t.status, 0, t.stderr);
  assert.match(ticks[0].stdout, /^UNRECORDED impl-20 /m, "the tick that finds them is a change, so it prints in full");
  for (const t of ticks.slice(1)) {
    assert.deepEqual(t.stdout.trim().split("\n"), [
      `fleet-tick: unchanged, nothing to act on (quiet=${ticks.indexOf(t) + 1}); UNRECORDED impl-20 persists; NO-TRANSCRIPT impl-12 persists — full rows on the next change`,
    ]);
  }
});

test("CLI --fold-unchanged: a transcript that appears between ticks is a change and prints in full, then folds again naming it", () => {
  const ticks = ticksOver(["--fold-unchanged"], {
    ...SESSIONED, transcripts: ["impl-3", "fix-pr-5", "agent-abc123"], beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })),
  }, 3, (dir, i) => {
    if (i === 1) writeFileSync(join(dir, "session", "impl-30.jsonl"), "");
  });
  for (const t of ticks) assert.equal(t.status, 0, t.stderr);
  assert.match(ticks[1].stdout, /^fleet-tick: unchanged, nothing to act on/, "nothing new, so it folds");
  assert.match(ticks[2].stdout, /^UNRECORDED impl-30 \(transcript exists, no ledger token\)$/m, "the new stem is a change, so it prints in full");
  assert.doesNotMatch(ticks[2].stdout, /unchanged, nothing to act on/);
  assert.match(ticks[3].stdout, /^fleet-tick: unchanged, nothing to act on .*; UNRECORDED impl-30 persists/);
});

test("CLI: a dispatch that lands while the tick runs, its ledger entry written before its transcript, is not UNRECORDED", () => {
  const during = ledgerText({
    ...SESSIONED.ledger,
    rows: [...SESSIONED.ledger.rows, "#30 impl-30 · tier-ok=impl-30:fleet-implementer-slow-high"],
    dispatched: [...SESSIONED.ledger.dispatched, "impl-30"],
  });
  const r = runCli([], {
    ...SESSIONED, keep: true, bound: 5, env: { MID_TICK_LEDGER: during, MID_TICK_TRANSCRIPT: "impl-30" },
    beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })),
  });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(r.dir, "session", "impl-30.jsonl")), "the dispatch did land while the tick ran");
    assert.match(readFileSync(join(r.repo, ".fleet", "ledger.md"), "utf8"), /- impl-30$/m, "and its ledger entry with it");
    assert.deepEqual(transcriptLinesOf(r.stdout).filter((l) => l.startsWith("UNRECORDED")), ["UNRECORDED impl-20 (transcript exists, no ledger token)"]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("CLI: the session is this run's receipt's, else --session; with neither the check is skipped with one stderr line; the receipt's directory not there yet lists no transcript, and a --session one that is missing, or cannot be listed, skips the check", () => {
  const SKIPPED = "fleet-tick: transcripts not checked — no session in this run's phase-0 receipt and no --session";
  const aged = { ...SESSIONED, beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })) };
  const tick = (args, fixture) => {
    const r = runCli(args, { ...aged, ...fixture });
    assert.equal(r.status, 0, r.stderr);
    return { lines: transcriptLinesOf(r.stdout).map((l) => l.replace(/\(live \d+m, no .*\)$/, "(…)")), stderr: r.stderr.trim().split("\n").filter((l) => l.startsWith("fleet-tick: transcripts")) };
  };
  const other = mkdtempSync(join(tmpdir(), "fleet-tick-session-"));
  try {
    writeFileSync(join(other, "impl-12.jsonl"), "");
    writeFileSync(join(other, "fix-pr-5.jsonl"), "");
    const both = ["UNRECORDED impl-20 (transcript exists, no ledger token)", "NO-TRANSCRIPT impl-12 (…)"];
    assert.deepEqual(tick(["--session", other], {}), { lines: both, stderr: [] }, "the receipt's session outranks --session");
    const noSession = (r) => ({ ...r, session: "" });
    assert.deepEqual(tick(["--session", other], { phase0: noSession }), { lines: [], stderr: [] }, "--session when the receipt names none");
    assert.deepEqual(tick([], { phase0: noSession }), { lines: [], stderr: [SKIPPED] });
    assert.deepEqual(tick([], { phase0: false }), { lines: [], stderr: [SKIPPED] }, "no receipt at all");
    assert.deepEqual(tick([], { transcripts: undefined }), { lines: ["NO-TRANSCRIPT fix-pr-5 (…)", "NO-TRANSCRIPT impl-12 (…)"], stderr: [] },
      "a session directory not there yet holds no transcript");
    const file = join(other, "impl-12.jsonl");
    const unlisted = tick(["--session", file], { phase0: noSession });
    assert.deepEqual(unlisted.lines, []);
    assert.deepEqual(unlisted.stderr, [`fleet-tick: transcripts not checked — cannot list ${file} (ENOTDIR)`]);
    const missing = join(other, "no-such-dir");
    const typo = tick(["--session", missing], { phase0: noSession });
    assert.deepEqual(typo.lines, [], "a --session directory that is not there is a typo, not a directory not there yet");
    assert.deepEqual(typo.stderr, [`fleet-tick: transcripts not checked — cannot list ${missing} (ENOENT)`]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("CLI: with no --no-transcript-after the NO-TRANSCRIPT threshold is 5 minutes", () => {
  const named = (ago) => transcriptLinesOf(runCli([], { ...SESSIONED, beforeRun: seedState(seenAgo({ "impl-12": ago, "fix-pr-5": ago })) }).stdout)
    .filter((l) => l.startsWith("NO-TRANSCRIPT")).length;
  assert.equal(named(5.5), 1);
  assert.equal(named(4), 0);
});

test("CLI: --no-transcript-after sets the NO-TRANSCRIPT threshold in minutes, and must be at least 1", () => {
  const aged = { ...SESSIONED, beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })) };
  const named = (args) => transcriptLinesOf(runCli(args, aged).stdout).filter((l) => l.startsWith("NO-TRANSCRIPT")).length;
  assert.equal(named(["--no-transcript-after", "9"]), 1);
  assert.equal(named(["--no-transcript-after", "11"]), 0);
  const zero = runCli(["--no-transcript-after", "0"], aged);
  assert.notEqual(zero.status, 0);
  assert.match(zero.stderr, /--no-transcript-after must be at least 1, got 0/);
});

// ---------------------------------------------------------------------------
// The Pull records. Each head a PULL row names is read off its
// `<scratch>/impl-<N>/pull.json`, pull.mjs's record: a question standing is a
// Pull in progress, and the fresh row there would have it asked twice.
import { pullOf } from "../plugin/scripts/fleet-tick.mjs";

const PULL_SESSION = "/pull-session";
// A record in pull.mjs's shape: `over` sets where it stands.
const pullRecord = (n, over = {}) => ({
  ticket: n, member: `impl-${n}`, started: "2026-10-16T00:00:00.000Z", status: "running", stage: "decided",
  pending: null, commands: [], questions: [], answers: [], staleness: [], close: null, addedPaths: [], scans: [],
  session: PULL_SESSION, commented: null, route: null, dispatch: null, outcome: null, ...over,
});
const pendingOn = (n, qid, over = {}) => pullRecord(n, { pending: { qid, at: "2026-10-16T00:00:00.000Z" }, ...over });
const ROW_COMMAND = { at: "2026-10-16T00:00:00.000Z", step: "row", cmd: ["ledger.mjs", "row", "7", "impl-7 · tier=task-high"], exit: 0, stdout: "" };
const dispatchedRecord = (n, commands = [ROW_COMMAND]) => pullRecord(n, {
  status: "dispatched", stage: "done", commands,
  dispatch: { name: `impl-${n}`, agent: "fleet-implementer-task-high", brief: "/b.md" }, outcome: { exit: 0, at: "2026-10-16T00:00:00.000Z" },
});
const pullOpts = (over = {}) => ({ session: PULL_SESSION, since: 0, now: 0, staleMinutes: 120, ...over });
const pullActions = (s) => rowsOf(s, "implementers").map((r) => r.action);

test("implementers: each head a free slot Pulls is its own row, the fresh one naming `pull.mjs next --head N`, and every one acts", () => {
  const rows = rowsOf(state({ bound: 3, inFlight: 1, heads: [412, 415, 420] }), "implementers");
  assert.deepEqual(rows.map((r) => r.action), ["PULL #412 — pull.mjs next --head 412", "PULL #415 — pull.mjs next --head 415"]);
  assert.ok(rows.every((r) => r.acts && r.actual === 1 && r.target === 3));
  assert.deepEqual(formatLines(reconcile(state({ heads: [7], supply: 4 }))).filter((l) => l.startsWith("implementers")),
    ["implementers 0/5 → PULL #7 — pull.mjs next --head 7   (implementers=0 prs=0 unclaimed=1 supply=4)"]);
});

test("implementers: a head whose Pull has a question standing prints it in place of the fresh row, (stale) appended once it is stale", () => {
  const pulls = new Map([[7, { kind: "pending", qid: "decided", stale: false }], [8, { kind: "pending", qid: "collision", stale: true }]]);
  assert.deepEqual(pullActions(state({ heads: [7, 8, 9], pulls })), [
    "PULL #7 (Q2 pending — pull.mjs answer 7 decided …)",
    "PULL #8 (Q3 pending — pull.mjs answer 8 collision …) (stale)",
    "PULL #9 — pull.mjs next --head 9",
  ]);
  for (const [qid, q] of [["staleness", "Q1"], ["close", "Q1b"], ["decided", "Q2"], ["collision", "Q3"], ["later", "later"]]) {
    assert.equal(pullActions(state({ heads: [5], pulls: new Map([[5, { kind: "pending", qid, stale: false }]]) }))[0],
      `PULL #5 (${q} pending — pull.mjs answer 5 ${qid} …)`, `the question ${qid}`);
  }
  assert.ok(rowsOf(state({ heads: [7, 8], pulls }), "implementers").every((r) => r.acts), "a Pull in progress is work waiting on the controller");
});

test("implementers: a head whose Pull dispatched prints the row it is missing, never a fresh Pull", () => {
  const row = (text) => pullActions(state({ heads: [7], pulls: new Map([[7, { kind: "dispatched", text }]]) }))[0];
  assert.equal(row("impl-7 · tier=task-high"), `PULL #7 (dispatched, row missing — ledger.mjs row 7 "impl-7 · tier=task-high")`);
  assert.equal(row(null), "PULL #7 (dispatched, row missing — ledger.mjs row 7 …)");
});

test("implementers: a head whose Pull ended in this run takes no slot, the next head fills it, and with no head left the row is the idle one", () => {
  const ended = { kind: "ended" };
  assert.deepEqual(pullActions(state({ bound: 3, inFlight: 1, heads: [5, 6, 7], pulls: new Map([[5, ended]]) })),
    ["PULL #6 — pull.mjs next --head 6", "PULL #7 — pull.mjs next --head 7"]);
  assert.deepEqual(pullActions(state({ heads: [5, 6], pulls: new Map([[5, ended], [6, ended]]) })), ["SUGGEST /triage, hold idle"]);
});

test("implementers: unclaimed= leaves out the heads whose Pull ended, and after a refresh whose trigger names a count it prints that count", () => {
  const ended = { kind: "ended" };
  const detail = (over) => row(state({ bound: 3, heads: [5, 6, 7], pulls: new Map([[5, ended]]), ...over }), "implementers").detail;
  assert.equal(detail({}), "implementers=0 prs=0 unclaimed=2 supply=0");
  const refreshed = { ok: true, entries: 3, lifted: 0, changed: true, trigger: "unclaimed 1 < in-flight bound 3" };
  assert.equal(detail({ refresh: { ...refreshed, unclaimed: 1 } }), "implementers=0 prs=0 unclaimed=1 supply=0");
  assert.equal(detail({ refresh: { ...refreshed, trigger: "shortlist missing" } }), "implementers=0 prs=0 unclaimed=2 supply=0",
    "a trigger that names no count leaves the row its own heads' count");
  assert.equal(detail({ inFlight: 3 }), "implementers=0 prs=0 unclaimed=2 supply=0", "the held row's count leaves them out too");
});

test("implementers: a Pull record changes no hold — the bound, the tier holds and draining still print one HOLD row", () => {
  const pulls = new Map([[1, { kind: "pending", qid: "decided", stale: true }]]);
  for (const over of [{ inFlight: 5 }, { draining: "x" }, { tierMismatch: ["impl-4"] }, { tierUnchecked: ["impl-4"] }, { phase0: { held: true, line: "x", session: null } }]) {
    const rows = rowsOf(state({ heads: [1, 2], pulls, ...over }), "implementers");
    assert.equal(rows.length, 1, JSON.stringify(over));
    assert.match(rows[0].action, /^HOLD /);
  }
});

test("pullOf: a question standing is pending, stale only once the record is older than the stale minutes", () => {
  const minutes = (m) => m * 60_000;
  assert.deepEqual(pullOf(pendingOn(7, "decided"), pullOpts({ since: 0, now: minutes(120) })), { kind: "pending", qid: "decided", stale: false });
  assert.deepEqual(pullOf(pendingOn(7, "decided"), pullOpts({ since: 0, now: minutes(120) + 1 })), { kind: "pending", qid: "decided", stale: true });
  assert.equal(pullOf(pendingOn(7, "close"), pullOpts({ now: minutes(30), staleMinutes: 20 })).stale, true);
});

test("pullOf: a dispatched record carries the text its own ledger.mjs row wrote, the last one that exited 0", () => {
  const failed = { ...ROW_COMMAND, cmd: ["ledger.mjs", "row", "7", "impl-7 · tier=wrong"], exit: 2 };
  const earlier = { ...ROW_COMMAND, cmd: ["ledger.mjs", "row", "7", "impl-7"] };
  assert.deepEqual(pullOf(dispatchedRecord(7, [earlier, ROW_COMMAND, failed]), pullOpts()), { kind: "dispatched", text: "impl-7 · tier=task-high" });
  assert.deepEqual(pullOf(dispatchedRecord(7, []), pullOpts()), { kind: "dispatched", text: null });
  const claim = { ...ROW_COMMAND, step: "claim", cmd: ["claim-ticket.sh", "7", "impl-7", "implementer"] };
  assert.deepEqual(pullOf(dispatchedRecord(7, [ROW_COMMAND, claim]), pullOpts()), { kind: "dispatched", text: "impl-7 · tier=task-high" }, "a later command of another step is no row");
  const odd = { ...ROW_COMMAND, cmd: ["ledger.mjs", "row", "7", 42] };
  assert.deepEqual(pullOf(dispatchedRecord(7, [odd]), pullOpts()), { kind: "dispatched", text: null }, "a row command whose fourth word is no string wrote no text");
});

test("pullOf: no record of this run's in progress is the fresh row — another session's, one between steps, not a record", () => {
  assert.equal(pullOf(pendingOn(7, "decided", { session: "/another" }), pullOpts()), null, "pull.mjs starts another run's record afresh");
  assert.equal(pullOf(dispatchedRecord(7), pullOpts({ session: "/another" })), null);
  for (const status of ["left", "released"]) assert.equal(pullOf(pullRecord(7, { status, session: "/another" }), pullOpts()), null, `another run's ${status} Pull is started over`);
  assert.equal(pullOf(pullRecord(7, { stage: "claim" }), pullOpts()), null, "a step that failed resumes with `next`, as the fresh row says");
  for (const junk of [null, [], "x", 3]) assert.equal(pullOf(junk, pullOpts()), null, JSON.stringify(junk));
});

test("pullOf: a Pull that left or was released in this run is ended, whatever question it still carries; only a running Pull is pending", () => {
  for (const status of ["left", "released"]) {
    assert.deepEqual(pullOf(pullRecord(7, { status }), pullOpts()), { kind: "ended" }, status);
    assert.deepEqual(pullOf(pendingOn(7, "decided", { status }), pullOpts()), { kind: "ended" }, `${status} with a question recorded`);
  }
  assert.deepEqual(pullOf(pullRecord(7, { status: "left", session: "/any" }), pullOpts({ session: null })), { kind: "ended" }, "with no session in the receipt, pull.mjs skips an ended Pull of any session");
  assert.deepEqual(pullOf(pendingOn(7, "decided", { status: "dispatched" }), pullOpts()), { kind: "dispatched", text: null }, "a dispatched Pull is not pending");
  assert.equal(pullOf(pendingOn(7, "decided", { status: "unknown" }), pullOpts()), null, "only a running Pull is pending");
});

test("pullOf: with no session in the receipt, a record is read whatever session it names, as pull.mjs reads it", () => {
  assert.deepEqual(pullOf(pendingOn(7, "decided", { session: "/any" }), pullOpts({ session: null })), { kind: "pending", qid: "decided", stale: false });
});

// A scratch root holding `<root>/impl-<n>/pull.json` for each entry of
// `records` — `{n: {record, agoMin, text}}`, `text` written verbatim in place
// of the record — the file `agoMin` minutes old.
const pullScratch = (records) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-pulls-")));
  for (const [n, { record, agoMin = 0, text }] of Object.entries(records)) {
    mkdirSync(join(root, `impl-${n}`));
    const path = join(root, `impl-${n}`, "pull.json");
    writeFileSync(path, text ?? JSON.stringify(record));
    const t = new Date(Date.now() - agoMin * MIN);
    utimesSync(path, t, t);
  }
  return root;
};
// Ticks over a shortlist of `heads` with the Pull records given, the receipt
// naming their root and PULL_SESSION unless `receipt` maps it otherwise.
const pullTicks = (records, { heads = [7, 8], args = [], again = 0, receipt = (root) => (r) => ({ ...r, scratch: root, session: PULL_SESSION }) } = {}) => {
  const root = pullScratch(records);
  try {
    return ticksOver(args, { shortlist: shortlistText(heads), refresh: shortlistText(heads), phase0: receipt(root) }, again);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const pullLines = (stdout) => stdout.split("\n").filter((l) => l.startsWith("implementers"));
const actionOf = (line) => line.slice(line.indexOf("→ ") + 2, line.lastIndexOf("   ("));

test("CLI: a pending question, a stale one, a dispatched Pull with no row and no record each print their row, one per head", () => {
  const [t] = pullTicks({
    7: { record: pendingOn(7, "decided"), agoMin: 1 },
    8: { record: pendingOn(8, "staleness"), agoMin: 121 },
    9: { record: dispatchedRecord(9, [{ ...ROW_COMMAND, cmd: ["ledger.mjs", "row", "9", "impl-9 · tier=task-high"] }]) },
  }, { heads: [7, 8, 9, 10], args: ["--in-flight", "4"] });
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(pullLines(t.stdout), [
    "implementers 0/4 → PULL #7 (Q2 pending — pull.mjs answer 7 decided …)   (implementers=0 prs=0 unclaimed=4 supply=4)",
    "implementers 0/4 → PULL #8 (Q1 pending — pull.mjs answer 8 staleness …) (stale)   (implementers=0 prs=0 unclaimed=4 supply=4)",
    `implementers 0/4 → PULL #9 (dispatched, row missing — ledger.mjs row 9 "impl-9 · tier=task-high")   (implementers=0 prs=0 unclaimed=4 supply=4)`,
    "implementers 0/4 → PULL #10 — pull.mjs next --head 10   (implementers=0 prs=0 unclaimed=4 supply=4)",
  ]);
});

test("CLI: --pull-stale-minutes sets when a standing question reads stale, 120 without it, and must be at least 1", () => {
  const aged = { 7: { record: pendingOn(7, "decided"), agoMin: 90 } };
  const first = (args) => actionOf(pullLines(pullTicks(aged, { heads: [7], args })[0].stdout)[0]);
  assert.equal(first([]), "PULL #7 (Q2 pending — pull.mjs answer 7 decided …)");
  assert.equal(first(["--pull-stale-minutes", "60"]), "PULL #7 (Q2 pending — pull.mjs answer 7 decided …) (stale)");
  const zero = runCli(["--pull-stale-minutes", "0"], { shortlist: shortlistText([7]) });
  assert.notEqual(zero.status, 0);
  assert.match(zero.stderr, /--pull-stale-minutes must be at least 1, got 0/);
});

test("CLI: none of the PULL rows folds — a pending, a stale and a dispatched row print in full on every --fold-unchanged tick, quiet held at 0", () => {
  const ticks = pullTicks({
    7: { record: pendingOn(7, "decided"), agoMin: 200 },
    8: { record: dispatchedRecord(8) },
  }, { args: ["--fold-unchanged"], again: 2 });
  for (const t of ticks) {
    assert.equal(t.status, 0, t.stderr);
    assert.deepEqual(pullLines(t.stdout).map(actionOf), [
      "PULL #7 (Q2 pending — pull.mjs answer 7 decided …) (stale)",
      `PULL #8 (dispatched, row missing — ledger.mjs row 8 "impl-7 · tier=task-high")`,
    ]);
    assert.doesNotMatch(t.stdout, /unchanged, nothing to act on/);
    assert.equal(t.state.quiet, 0);
  }
});

test("CLI: a record the tick cannot use prints the fresh row — not JSON, another session's, another run's ended Pull — and the tick still exits 0", () => {
  const [t] = pullTicks({
    7: { text: "{not json" },
    8: { record: pendingOn(8, "decided", { session: "/another-run" }) },
    9: { record: pullRecord(9, { status: "left", session: "/another-run", outcome: { exit: 1, reason: "taken" } }) },
  }, { heads: [7, 8, 9], args: ["--in-flight", "3"] });
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), [7, 8, 9].map((n) => `PULL #${n} — pull.mjs next --head ${n}`));
});

test("CLI: a head whose Pull left or was released in this run takes no slot, and a head past the free slots is read for its own record when one fills it", () => {
  const [t] = pullTicks({
    7: { record: pullRecord(7, { status: "left", outcome: { exit: 1, reason: "taken" } }) },
    8: { record: pullRecord(8, { status: "released", outcome: { exit: 2, reason: "router refused" } }) },
    10: { record: pendingOn(10, "close"), agoMin: 1 },
  }, { heads: [7, 8, 9, 10, 11], args: ["--in-flight", "2"] });
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), ["PULL #9 — pull.mjs next --head 9", "PULL #10 (Q1b pending — pull.mjs answer 10 close …)"]);
});

test("CLI: the records are read under --scratch when the receipt names no scratch root, and the receipt's root wins when it does", () => {
  const records = { 7: { record: pendingOn(7, "decided") } };
  const noRoot = (root) => (r) => { const { scratch, ...rest } = r; return { ...rest, session: PULL_SESSION }; };
  const root = pullScratch(records);
  try {
    const [flagged] = ticksOver(["--scratch", root], { shortlist: shortlistText([7]), refresh: shortlistText([7]), phase0: noRoot(root) }, 0);
    assert.equal(actionOf(pullLines(flagged.stdout)[0]), "PULL #7 (Q2 pending — pull.mjs answer 7 decided …)");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "fleet-tick-pulls-empty-")));
    try {
      const [wins] = ticksOver(["--scratch", root], { shortlist: shortlistText([7]), refresh: shortlistText([7]), phase0: (r) => ({ ...r, scratch: elsewhere, session: PULL_SESSION }) }, 0);
      assert.equal(actionOf(pullLines(wins.stdout)[0]), "PULL #7 — pull.mjs next --head 7");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: a receipt whose session is empty names no session, so a record is read whatever session it carries", () => {
  const [t] = pullTicks({ 7: { record: pendingOn(7, "decided", { session: "/any" }) } },
    { heads: [7], receipt: (root) => (r) => ({ ...r, scratch: root, session: "" }) });
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), ["PULL #7 (Q2 pending — pull.mjs answer 7 decided …)"]);
});

// The short-queue refresh counts only the heads a PULL row could name: a head
// whose Pull ended in this run's session is no such head. Ticks at
// `--in-flight <bound>` over the shortlist `file`, the refresh writing
// `refresh`, with a `left` record in this run's session for each of `ended`,
// and `records` (pullScratch's shape) beside them.
const LEFT = (n) => ({ record: pullRecord(n, { status: "left", outcome: { exit: 1, reason: "taken" } }) });
const endedTicks = ({ file, refresh, ended = [], records = {}, bound = 3, again = 0, receipt, ...fixture }) => {
  const root = pullScratch({ ...Object.fromEntries(ended.map((n) => [n, LEFT(n)])), ...records });
  try {
    const phase0 = (receipt ?? ((at) => (r) => ({ ...r, scratch: at, session: PULL_SESSION })))(root);
    return ticksOver(["--in-flight", String(bound)], { shortlist: shortlistText(file), refresh: shortlistText(refresh), phase0, ...fixture }, again);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
// The count in a tick's `REFRESHED` short-queue trigger text, or null when the tick has none.
const triggerCount = (stdout) => {
  const m = /^shortlist {4}→ REFRESHED [^\n]*\(unclaimed (\d+) < in-flight bound \d+/m.exec(stdout);
  return m === null ? null : Number(m[1]);
};
// Every `unclaimed=` the implementer rows of a tick print.
const rowCounts = (stdout) => pullLines(stdout).map((l) => Number(/ unclaimed=(\d+) /.exec(l)[1]));
const refreshedRow = /^shortlist {4}→ REFRESHED /m;

test("CLI: a head whose Pull ended this run is not counted, so two pullable heads under B = 3 refresh and the third slot Pulls the new head", () => {
  const [t] = endedTicks({ file: [1, 2, 50], ended: [50], refresh: [1, 2, 60] });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^shortlist {4}→ REFRESHED shortlist: 3 entries; 0 lifted {3}\(unclaimed 2 < in-flight bound 3\)$/m);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), [1, 2, 60].map((n) => `PULL #${n} — pull.mjs next --head ${n}`));
  assert.deepEqual(rowCounts(t.stdout), [2, 2, 2], "the row prints the count its trigger read");
});

test("CLI: every head's Pull ended this run — the tick refreshes before any idle row, and Pulls what the refresh finds", () => {
  const [found] = endedTicks({ file: [1, 2, 3], ended: [1, 2, 3], refresh: [60] });
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /\(unclaimed 0 < in-flight bound 3\)$/m);
  assert.deepEqual(pullLines(found.stdout).map(actionOf), ["PULL #60 — pull.mjs next --head 60"]);
  assert.deepEqual(rowCounts(found.stdout), [0]);
  // A refresh that finds only the same ended heads leaves nothing to Pull: idle, after the refresh.
  const [none] = endedTicks({ file: [1, 2, 3], ended: [1, 2, 3], refresh: [1, 2, 3] });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, refreshedRow);
  assert.deepEqual(pullLines(none.stdout).map(actionOf), ["SUGGEST /triage, hold idle"]);
  assert.deepEqual(rowCounts(none.stdout), [triggerCount(none.stdout)]);
});

test("CLI: control — no Pull records, two heads under B = 3 refresh and Pull the new head as before", () => {
  const [t] = endedTicks({ file: [1, 2], refresh: [1, 2, 60] });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /\(unclaimed 2 < in-flight bound 3\)$/m);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), [1, 2, 60].map((n) => `PULL #${n} — pull.mjs next --head ${n}`));
  assert.deepEqual(rowCounts(t.stdout), [2, 2, 2]);
});

test("CLI: B = 2, both heads' Pulls ended this run — one left, one released — the refresh runs", () => {
  const released = { 2: { record: pullRecord(2, { status: "released", outcome: { exit: 2, reason: "router refused" } }) } };
  const [t] = endedTicks({ file: [1, 2], ended: [1], records: released, refresh: [60], bound: 2 });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /\(unclaimed 0 < in-flight bound 2\)$/m);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), ["PULL #60 — pull.mjs next --head 60"]);
});

test("CLI: every head ended, over several ticks — each tick refreshes before its row, and prints the one count its trigger read", () => {
  for (const refresh of [[1, 2, 3], [60]]) {
    const ticks = endedTicks({ file: [1, 2, 3], ended: [1, 2, 3], refresh, again: 2 });
    for (const [i, t] of ticks.entries()) {
      assert.equal(t.status, 0, t.stderr);
      assert.match(t.stdout, refreshedRow, `refresh ${refresh}, tick ${i}`);
      const k = triggerCount(t.stdout);
      assert.notEqual(k, null, `refresh ${refresh}, tick ${i}`);
      for (const c of rowCounts(t.stdout)) assert.equal(c, k, `refresh ${refresh}, tick ${i}`);
    }
  }
});

test("CLI: three pullable heads beside an ended one at B = 3 are not short — no refresh", () => {
  const [t] = endedTicks({ file: [1, 2, 3, 50], ended: [50], refresh: [60] });
  assert.equal(t.status, 0, t.stderr);
  assert.doesNotMatch(t.stdout, /REFRESH/);
  assert.deepEqual(pullLines(t.stdout).map(actionOf), [1, 2, 3].map((n) => `PULL #${n} — pull.mjs next --head ${n}`));
  assert.deepEqual(rowCounts(t.stdout), [3, 3, 3]);
});

test("CLI: a record the tick does not read as ended still counts toward the trigger, and with no scratch root no record is read", () => {
  const records = {
    1: { text: "{not json" },
    2: { record: pullRecord(2, { status: "left", session: "/another-run" }) },
    3: { record: pendingOn(3, "decided") },
    4: { record: dispatchedRecord(4) },
  };
  const [t] = endedTicks({ file: [1, 2, 3, 4], records, refresh: [60], bound: 4 });
  assert.equal(t.status, 0, t.stderr);
  assert.doesNotMatch(t.stdout, /REFRESH/, "four heads a PULL row can name at B = 4 are not short");
  assert.deepEqual(rowCounts(t.stdout), [4, 4, 4, 4]);
  const [noRoot] = endedTicks({ file: [1, 2, 50], ended: [50], refresh: [60], receipt: () => (r) => ({ ...r, scratch: "", session: PULL_SESSION }) });
  assert.equal(noRoot.status, 0, noRoot.stderr);
  assert.doesNotMatch(noRoot.stdout, /REFRESH/, "no records read: the plain unclaimed count, 3, is not short of 3");
  assert.deepEqual(pullLines(noRoot.stdout).map(actionOf), [1, 2, 50].map((n) => `PULL #${n} — pull.mjs next --head ${n}`));
  assert.deepEqual(rowCounts(noRoot.stdout), [3, 3, 3]);
});

test("CLI: draining, or held at the bound, with ended heads — no refresh, the same HOLD row, its count without the ended heads", () => {
  const held = endedTicks({ file: [1, 2, 50], ended: [50], refresh: [60], prs: [pr(51), pr(52), pr(53)] })[0];
  assert.equal(held.status, 0, held.stderr);
  assert.doesNotMatch(held.stdout, /REFRESH/);
  assert.deepEqual(pullLines(held.stdout), ["implementers 3/3 → HOLD (in-flight 3/3)   (implementers=0 prs=3 unclaimed=2 supply=3)"]);
  const draining = endedTicks({ file: [1, 2, 50], ended: [50], refresh: [60], ledger: { drain: "budget" } })[0];
  assert.equal(draining.status, 0, draining.stderr);
  assert.doesNotMatch(draining.stdout, /REFRESH/);
  assert.deepEqual(pullLines(draining.stdout), ["implementers 0/3 → HOLD (draining)   (implementers=0 prs=0 unclaimed=2 supply=3)"]);
});

// The age-based checks a degraded heartbeat file silences: its `seen` stamps
// cannot be read, so every live token reads as first seen now.
test("ageChecks: CHECK-LIVENESS for a live token of a known family, NO-TRANSCRIPT for a live member token with no transcript in a listed session", () => {
  assert.deepEqual(ageChecks({ live: ["fix-pr-5", "impl-12", "review:PR#6"], stems: ["fix-pr-5"] }), ["CHECK-LIVENESS", "NO-TRANSCRIPT"]);
  assert.deepEqual(ageChecks({ live: ["fix-pr-5", "impl-12"], stems: null }), ["CHECK-LIVENESS"], "no session listing, so no NO-TRANSCRIPT");
  assert.deepEqual(ageChecks({ live: ["fix-pr-5", "impl-12"], stems: ["fix-pr-5", "impl-12"] }), ["CHECK-LIVENESS"], "every member has its transcript");
  assert.deepEqual(ageChecks({ live: ["review:PR#6"], stems: [] }), ["CHECK-LIVENESS"], "a review launch is no member and has no transcript named after it");
  assert.deepEqual(ageChecks({ live: ["agent-abc123"], stems: [] }), [], "a name of no family is in neither check");
  assert.deepEqual(ageChecks({ live: [], stems: [] }), []);
});

test("CLI: a degraded heartbeat file prints one stderr line naming the age checks it silences, prints no age-based line, leaves the file byte-identical and stdout otherwise unchanged; a valid file prints no such line", () => {
  const corrupt = '{ "seen": {"impl-12"';
  const writeCorrupt = (repo) => writeFileSync(join(repo, "..", "heartbeat.json"), corrupt);
  const skipped = (r, checks) => `fleet-tick: ${checks} not checked — ${join(r.dir, "heartbeat.json")} is not JSON, so first-seen ages are unavailable`;
  const agelessOf = (r) => r.stderr.split("\n").filter((l) => l.includes(" not checked — ") && l.endsWith("first-seen ages are unavailable"));
  const ageBased = /^(CHECK-LIVENESS|NO-TRANSCRIPT) /;
  const withoutAgeBased = (stdout) => stdout.split("\n").filter((l) => !ageBased.test(l)).join("\n");
  const degraded = runCli([], { ...SESSIONED, keep: true, beforeRun: writeCorrupt });
  const valid = runCli([], { ...SESSIONED, keep: true, beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })) });
  try {
    assert.equal(degraded.status, 0, degraded.stderr);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(agelessOf(degraded), [skipped(degraded, "CHECK-LIVENESS and NO-TRANSCRIPT")]);
    assert.equal(degraded.stdout.split("\n").filter((l) => ageBased.test(l)).length, 0, "nothing age-based prints off a degraded file");
    assert.equal(readFileSync(join(degraded.dir, "heartbeat.json"), "utf8"), corrupt, "the degraded file is left byte-identical");
    assert.deepEqual(agelessOf(valid), []);
    assert.match(valid.stdout, /^NO-TRANSCRIPT impl-12 /m, "the valid file's ages do reach the check");
    assert.equal(withoutAgeBased(degraded.stdout), withoutAgeBased(valid.stdout));
  } finally {
    rmSync(degraded.dir, { recursive: true, force: true });
    rmSync(valid.dir, { recursive: true, force: true });
  }
});

test("CLI: over a degraded heartbeat file the line names only the age checks that would have run, and none prints with no live token", () => {
  const writeCorrupt = (repo) => writeFileSync(join(repo, "..", "heartbeat.json"), "{");
  const agelessOf = (r) => {
    assert.equal(r.status, 0, r.stderr);
    return r.stderr.split("\n").filter((l) => l.endsWith("first-seen ages are unavailable")).map((l) => l.replace(/ not checked — .*$/, ""));
  };
  assert.deepEqual(agelessOf(runCli([], { ...SESSIONED, beforeRun: writeCorrupt, phase0: (r) => ({ ...r, session: "" }) })), ["fleet-tick: CHECK-LIVENESS"],
    "no session to list, so NO-TRANSCRIPT would not have run");
  assert.deepEqual(agelessOf(runCli([], { ...AGED, beforeRun: writeCorrupt })), ["fleet-tick: CHECK-LIVENESS"],
    "every live member has its transcript, so NO-TRANSCRIPT would not have named one");
  assert.deepEqual(agelessOf(runCli([], { ...IDLE, beforeRun: writeCorrupt })), [], "no live token, nothing to check");
});

test("CLI: the not-checked line follows the state file's late re-read, not the top-of-tick one: valid then corrupt prints it, corrupt then valid does not", () => {
  const valid = JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ...seenAgo({ "impl-12": 10, "fix-pr-5": 10 }) });
  const agelessOf = (r) => {
    assert.equal(r.status, 0, r.stderr);
    return r.stderr.split("\n").filter((l) => l.endsWith("first-seen ages are unavailable"));
  };
  const wasValid = runCli([], { ...SESSIONED, bound: 5, beforeRun: seedState(seenAgo({ "impl-12": 10, "fix-pr-5": 10 })), env: { MID_TICK_STATE: "{" } });
  assert.equal(agelessOf(wasValid).length, 1, "the file read at the top of the tick was valid, the one read late was not");
  const wasCorrupt = runCli([], { ...SESSIONED, bound: 5, beforeRun: (repo) => writeFileSync(join(repo, "..", "heartbeat.json"), "{"), env: { MID_TICK_STATE: valid } });
  assert.deepEqual(agelessOf(wasCorrupt), [], "the file read at the top of the tick was corrupt, the one read late was valid");
  assert.match(wasCorrupt.stdout, /^NO-TRANSCRIPT impl-12 /m, "and its ages did reach the check");
});
