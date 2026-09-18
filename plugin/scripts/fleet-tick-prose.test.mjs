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
import { between as section } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// SLICE SIZE is what does the anchoring. A regex over a whole section is
// satisfied by incidental prose elsewhere in it, and an unbounded slice runs to
// EOF where the red-flag list restates half of this vocabulary — enough to keep
// every assertion below green with the section deleted outright.
// The reconcile instruction only, ending where the next standing instruction
// begins. Widened to the whole Phase 3 loop it would be satisfied by the CI
// bullets' own mentions of reconciling, which say nothing about the script.
const reconcileBlock = () =>
  section(RUN_TEAM, "**Run the reconcile on the merge-side edges.**", "**Own the CI waits.**", "run-team reconcile block");

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

test("the reconcile block admits the edges miss a drained queue, and says whose case that is", () => {
  // A reader who takes the two edges for the whole cure stops looking for the
  // drained-queue case they cannot reach. Before #357 that case was deferred and
  // the block said so; now it has an owner, and the pointer is the part that
  // must not rot — an admission with nowhere to go is how #3 lost item 2.
  const s = reconcileBlock();
  assert.match(s, /neither\s+covers a fully drained queue/);
  assert.match(s, /fleet-heartbeat\.mjs/);
});

// Both merge-side edges, each sliced to its own bullet — the shared vocabulary
// makes a section-wide match worthless here.
test("the merge-bot-wave-done edge invokes the reconcile", () => {
  const bullet = section(RUN_TEAM, "- **Merge-bot wave reports done**", "\n- **The run ends", "merge-bot-done edge");
  assert.match(bullet, /run the reconcile/);
});

test("the CI-terminal edge invokes the reconcile", () => {
  const bullet = section(RUN_TEAM, "- **Monitor: CI run completes**", "\n- **A fix-applier reports", "CI-terminal edge");
  assert.match(bullet, /run the reconcile/);
});

// The queue-depth table's own slice, ending at the `/triage` note that follows
// it. Anchored to the section heading instead, the pointer would be satisfied
// by the Phase 3 block above, which lives in the same file.
const queueDepthTable = () =>
  section(RUN_TEAM, "**Do not re-derive this by hand", "`/triage` is user-invoked only", "queue-depth table");

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
  const def = section(RUN_TEAM, "- **review backlog**", "\n\n**Reviews are the bottleneck", "review-backlog definition");
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
  // a reader counts it BY HAND. The reviewBacklog number excludes it either way:
  // a PR closing no issue fails the closing-issue test whichever run left it
  // open, so nothing here is a claim about the script's output. That under-read
  // is the opposite error from #590's over-read, and the narrow phrase separates
  // them.
  //
  // Finding 2: \s+ between every pinned word, matching this file's own
  // convention above. The pinned clause spans a line break in SKILL.md, so
  // literal spaces red on a whitespace-only reflow — a false failure naming a
  // regression that did not happen.
  assert.match(def, /never\s+one\s+a\s+PRIOR\s+run\s+left\s+open/);
  // The corrected half: the prose must keep saying the mechanical number
  // excludes such a PR, or the by-hand reading silently becomes a claim about
  // fleet-tick.mjs again.
  assert.match(def, /number\s+still\s+excludes\s+it/);
  assert.match(def, /BY\s+HAND/);
});

// The step-0 fold-in bullet only, ending where the numbered candidate scan
// begins. Widened to the whole of phase 0 it would be satisfied by the
// candidate-scan and in-flight bullets, which talk about queueing and review
// without saying inherited PRs are in scope at all.
const foldInBlock = () =>
  section(
    RUN_TEAM,
    "**Fold in every PR a prior run left open, before shortlisting.**",
    "1. **Candidate scan**",
    "run-team step-0 fold-in block",
  );

test("the fold-in block says inherited PRs are queued before shortlisting, as ordinary review work", () => {
  // #1237's own review found this bullet unpinned while its sibling addition in
  // the same PR was pinned. Unpinned, a reword silently reverts phase 0 to
  // scanning ISSUES only and inherited PRs go unreviewed again — the #1222
  // pattern this bullet cites as its own motivation.
  const s = foldInBlock();
  assert.match(s, /before\s+shortlisting/);
  // The three roles individually. "Queue it for review" without them reads as a
  // note to self; naming them is what makes it the same pipeline as ticket work.
  for (const role of ["review workflow", "fix-applier", "finisher"]) {
    assert.ok(s.includes(role), `fold-in block does not name the ${role}`);
  }
  // The #590 tie-back is the reason the rule survives a narrowing pass: a PR
  // that is both unreviewable and uncounted is what strands the gate.
  assert.match(s, /unreviewable AND uncounted/);
});

// --------------------------------------------------------------------------
// The heartbeat's prose — #357. It belongs in this file for the reason the
// header gives: these pins exist because a reconcile nothing invokes is #3 with
// an extra file, and on a drained queue the heartbeat is the ONLY thing that
// invokes it. The slice is the standing instruction, ending where the CI-wait
// instruction begins.
const heartbeatBlock = () =>
  section(RUN_TEAM, "**Beat when there is nothing to do", "**Own the CI waits.**", "run-team heartbeat block");

test("the event loop tells the controller to arm the beat instead of ending its turn", () => {
  // The entry point. Every word of the block below is unreachable if the loop
  // never says to run it, which is exactly how item 2 of #3 went missing.
  const bullet = section(RUN_TEAM, "- **Nothing to do right now**", "- **Implementer completes**",
    "nothing-to-do event");
  assert.match(bullet, /do not end your turn/);
});

test("the heartbeat block names the script and the re-issue protocol", () => {
  const s = heartbeatBlock();
  assert.match(s, /fleet-heartbeat\.mjs/);
  // The partial-hold branch IS the mechanism on both harnesses: no harness lets
  // one command block a whole interval, so a reader who stops at the first line
  // ends the turn mid-interval and the beat dies there. Prose that names the
  // script without the re-issue rule is a heartbeat with one beat.
  assert.match(s, /re-issue this command now, do not end your turn/);
  assert.match(s, /one blocking call per turn/);
});

test("the heartbeat block says why the ceiling is bounded", () => {
  // Without the reason, 20 minutes reads as arbitrary and the next reader
  // raises it to an hour — reintroducing #3's blindness at a slower rate, which
  // is the one failure this design can still be tuned into.
  assert.match(heartbeatBlock(), /supply grows from OUTSIDE the fleet/);
  assert.match(heartbeatBlock(), /Do not raise it past 30\s+minutes/);
});

test("the heartbeat block forbids stopping on an idle queue", () => {
  // The unattended-overnight ruling. A beat that ends when supply empties
  // terminates the run at 01:00 and misses every ticket triaged after it.
  assert.match(heartbeatBlock(), /does not stop on idleness/);
});
