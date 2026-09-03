// Pins the run-team prose that makes fleet-tick.mjs reachable. The script is
// inert if nothing invokes it: #3's failure was not a missing computation, it
// was a correct table nobody consulted under a merge-side event storm, and a
// reconcile the event loop never names is that failure with an extra file.
//
// THE CEILING EVERY PIN HERE SHARES, same as review-path-default.test.mjs:
// these prove a phrase is PRESENT. None can prove it is not NEGATED — a
// sentence inserted inside the slice granting the opposite reads as fine to all
// of them. Read each as "not vacuous to rewording", never as "this rule cannot
// be subverted".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// SLICE SIZE is what does the anchoring. A regex over a whole section is
// satisfied by incidental prose elsewhere in it, and an unbounded slice runs to
// EOF where the red-flag list restates half of this vocabulary — enough to keep
// every assertion below green with the section deleted outright.
function section(startAnchor, endAnchor, label) {
  const at = RUN_TEAM.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const end = RUN_TEAM.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, `${label}: '${endAnchor}' moved — update this test`);
  return RUN_TEAM.slice(at, end);
}

// The reconcile instruction only, ending where the next standing instruction
// begins. Widened to the whole Phase 3 loop it would be satisfied by the CI
// bullets' own mentions of reconciling, which say nothing about the script.
const reconcileBlock = () =>
  section("**Run the reconcile on the merge-side edges.**", "**Own the CI waits.**", "run-team reconcile block");

test("the reconcile block names the script and the flags a caller must pass", () => {
  const s = reconcileBlock();
  assert.match(s, /fleet-tick\.mjs/);
  // Every required flag, individually. A block naming the script without them
  // is unrunnable prose: the script refuses each missing one at exit 2.
  for (const flag of ["--implementers", "--reviewers", "--merge-bots", "--pool",
    "--reviews-ready", "--merge-holds"]) {
    assert.ok(s.includes(flag), `reconcile block does not name ${flag}`);
  }
});

test("the reconcile block says the live counts are the controller's to state", () => {
  // Without this a reader hunts for a source the repo does not have, or worse
  // invents one from the ledger — the guess whose over-count is the #3 stall.
  assert.match(reconcileBlock(), /refuses rather than\s+defaulting them/);
  assert.match(reconcileBlock(), /a ledger row is a\s+dispatch/);
});

test("the reconcile block says what the two row-suppressing inputs mean", () => {
  // Naming the flags is not enough for these two: a caller who reads
  // `--reviews-ready` as the backlog, or `--merge-holds` as optional, gets back
  // exactly the non-actionable ACTIONs #590 was filed for. The obligation is
  // that the block distinguishes them from the label reads the script makes
  // for itself.
  const s = reconcileBlock();
  assert.match(s, /fix-applier\s+applies findings/);
  assert.match(s, /The backlog is \*\*not\*\* this number/);
  assert.match(s, /held-behind-#<lower>/);
  assert.match(s, /moves no label/);
});

test("the reconcile block admits it is edge-triggered only", () => {
  // The deferred heartbeat. A reader who takes this for the whole cure stops
  // looking for the drained-queue case it cannot reach.
  assert.match(reconcileBlock(), /edge-triggered, so it does\s+not cover a fully drained queue/);
});

// Both merge-side edges, each sliced to its own bullet — the shared vocabulary
// makes a section-wide match worthless here.
test("the merge-bot-wave-done edge invokes the reconcile", () => {
  const bullet = section("- **Merge-bot wave reports done**", "\n- **The run ends", "merge-bot-done edge");
  assert.match(bullet, /run the reconcile/);
});

test("the CI-terminal edge invokes the reconcile", () => {
  const bullet = section("- **Monitor: CI run completes**", "\n- **A fix-applier reports", "CI-terminal edge");
  assert.match(bullet, /run the reconcile/);
});

// The queue-depth table's own slice, ending at the `/triage` note that follows
// it. Anchored to the section heading instead, the pointer would be satisfied
// by the Phase 3 block above, which lives in the same file.
const queueDepthTable = () =>
  section("**Do not re-derive this by hand", "`/triage` is user-invoked only", "queue-depth table");

test("the queue-depth table points at the executable reconcile", () => {
  const s = queueDepthTable();
  assert.match(s, /fleet-tick\.mjs/);
  assert.match(s, /computed, not remembered/);
});

test("the queue-depth table keeps the backlog gate above its four rows", () => {
  // The one ordering the script encodes that the table cannot show: backlog >= 2
  // short-circuits all four pool/supply rows. A table read as authoritative
  // without it re-shortlists under a hold.
  assert.match(queueDepthTable(), /backlog gate outranks all four rows/);
});

test("the pool-0 rows do not overlap — supply 0 has exactly one row", () => {
  // `| 0 | < cap |` next to `| 0 | 0 |` gave two different answers for supply 0,
  // and the script has to pick one. Pinning the disjoint spelling keeps the
  // table and the code from drifting back apart.
  assert.match(queueDepthTable(), /\|\s*0\s*\|\s*0 < supply < cap\s*\|/);
});

test("the review-backlog definition states what the script actually counts", () => {
  // The gate's input. Left as the narrow definition alone, a controller reading
  // a HOLD cannot tell an over-count from a real review-bound pipeline.
  const def = section("- **review backlog**", "\n\n**Reviews are the bottleneck", "review-backlog definition");
  assert.match(def, /open PR without `ready-to-merge`/);
  assert.match(def, /earlier than the definition above, never\s+later/);
  // Both halves of the closing-issue clause. The predicate alone is a rule a
  // reader can only obey; the reason is what stops the next narrowing pass
  // from dropping it as a stray filter, since a PR nothing will ever review
  // floors the gate's input permanently rather than transiently.
  assert.match(def, /that closes an\s+issue/);
  assert.match(def, /nothing in the run can drain/);
  // The exemption is scoped to the chore PR THIS run authors. Unscoped, a reader
  // applies it to an INHERITED chore PR too — which step 0 queues for review, so
  // it has a reviewer and belongs in the count. That under-read is the opposite
  // error from #590's over-read, and the narrow phrase is what separates them.
  assert.match(def, /never one a PRIOR run left open/);
});
