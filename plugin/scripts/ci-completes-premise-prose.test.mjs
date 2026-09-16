// #1053. The phase-3 **Monitor: CI run completes** bullet stated one
// precondition — that the edge fires on the fix-applier's own push — and
// derived its whole guard from it: empty your outbox *to it*, a final report
// from *it* is not proof it stopped. Both presuppose a fix-applier exists.
//
// Measured against the artifacts, not the ticket body (`gh api
// repos/feigi/fleet-plugin/actions/runs/<id>`): every run the three PRs of
// that wave produced carried `event=pull_request`, and each PR's first run was
// created 3-4 seconds after `gh pr create` — so the implementer's own firing
// is first for every PR, arriving before any review has returned. A fourth
// firing on PR #1052 (`33306306230`, head `fa65476`) came from a fix-applier
// that had pushed and not yet reported. The stated guard catches neither: the
// first has no fix-applier to owe anything to, so the outbox is *vacuously*
// empty; the second owed nothing, so it is *genuinely* empty.
//
// The root cause is that the gate was phrased over WHO PUSHED rather than over
// WHAT MUST BE TRUE, and that phrasing appears at two sites — this bullet
// (where the controller acts) and the narrative finisher paragraph (where the
// same condition is restated at length). Correcting one leaves the other
// reachable, so both are pinned here.
//
// The ACCEPT side is the half a new gate breaks: "the fix-applier has
// reported" must not hold a PR that never got one. Two such PRs exist — the
// **Review slot free** bullet's nothing-survived case, and the sibling
// **A fix-applier reports `no-op`** bullet, whose head's CI edge has already
// fired and will never fire again. Both are pinned as input the gate must
// accept.
//
// THE CEILING: these are prose pins. They prove the corrected premise and the
// two-condition gate are stated where the controller reads them; they cannot
// prove a controller obeys them, and nothing here calls `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// One bullet each. The phase-3 loop is a flat list of `- **...**` items and
// `finisher`, `dispatch`, `push` and `report` all recur through every one of
// them, so a slice spanning two bullets is satisfied by either — which is
// exactly the false green the pair-coherence test below has to deny.
const ciEdge = () =>
  between(RUN_TEAM, "- **Monitor: CI run completes**", "- **A fix-applier reports", "run-team CI-completes edge");

const noOpEdge = () =>
  between(RUN_TEAM, "- **A fix-applier reports", '- **`ci-state.mjs --pr <N>` reads', "run-team no-op edge");

// The nothing-survived route to a finisher, which bypasses the fix-applier
// entirely. Bounded by the next bullet: unbounded it runs into the CI edge
// below and the accept-side assertion passes off the very text it is meant to
// be independent of.
const reviewSlotEdge = () =>
  between(RUN_TEAM, "- **Review slot free, PR queued**", "- **Reviewer labels a PR**", "run-team review-slot edge");

// The second site stating the same gate, in the narrative rather than the
// loop. Its start anchor is the paragraph opener; its end anchor is the
// following paragraph, so the slice cannot widen into the duty list.
const narrativeGate = () =>
  between(
    RUN_TEAM,
    "**The fix-applier pushes and exits",
    "**An unanswered question from the member",
    "run-team narrative finisher gate",
  );

test("no sentence anywhere claims the edge fires on the fix-applier's push", () => {
  // Deliberately file-wide, the mirror image of every positive pin here: a
  // negative wants the WIDEST scope, because a copy of the false premise
  // surviving just outside a narrow slice is the whole defect back again.
  // Matched on the claim rather than the original sentence, so a splice mutant
  // that keeps every pinned word below and appends the premise back in — the
  // mutant this ticket's PR body states — still reds.
  assert.doesNotMatch(
    RUN_TEAM,
    /edge\s+fires\s+on\s+the\s+fix-applier/,
    "the falsified premise is back: the edge fires on every CI run the PR produces, and the implementer's own firing is first for every PR",
  );
});

test("the premise names every firing, with the implementer's stated as the ordinary first one", () => {
  const s = ciEdge();
  assert.match(
    s,
    phrase("This edge fires for every CI run the PR produces, and the implementer's own firing comes first for every PR"),
    "the edge's premise no longer covers the implementer's push, which is the firing every PR produces first",
  );
  // The mechanism, or the corrected premise reads as an assertion to take on
  // trust and the next editor narrows it back to the fix-applier.
  assert.match(s, phrase("`ci.yml` triggers on `pull_request`"));
  // The consequence is what makes it a defect rather than a detail.
  assert.match(
    s,
    phrase("no review has run at all when it arrives"),
    "the bullet no longer says what is true at the first firing — that nothing has reviewed the PR",
  );
});

test("the finisher gate names both conditions and distinguishes pushed from reported", () => {
  const s = ciEdge();
  assert.match(
    s,
    phrase("dispatch a finisher only once the PR's review has returned AND its fix-applier, if one was dispatched, has sent its report"),
    "the finisher gate no longer names both conditions — green alone is back to being sufficient",
  );
  // The mid-work firing is the shape an empty outbox cannot see, and a gate
  // saying only "the fix-applier has finished" reads as satisfied by a push.
  assert.match(
    s,
    phrase("pushed is not reported"),
    "the gate no longer separates a member that pushed from one that reported — the mid-work SHA passes again",
  );
  assert.match(s, phrase("mid-work on a SHA the member may still move"));
  // Both failure shapes, and WHY the outbox is blind to each: without them the
  // two-condition gate reads as a belt-and-braces restatement of the outbox
  // rule and gets cut as duplication.
  assert.match(s, phrase("vacuously"));
  assert.match(s, phrase("genuinely"));
});

test("the outbox rule survives, as the last test rather than the only one", () => {
  const s = ciEdge();
  assert.match(
    s,
    phrase("The outbox is the last test, not the only one, and it stands wherever a fix-applier exists"),
    "the outbox rule was demoted or dropped — it is correct wherever a fix-applier exists and this ticket does not weaken it",
  );
  assert.match(
    s,
    /never dispatch off it while you do/i,
    "the CI-completes edge lost the outstanding-ruling gate itself, not just its premise",
  );
  assert.match(s, phrase("including any ruling you have withdrawn or reversed"));
  assert.match(s, phrase("a final report is not proof it stopped"));
});

test("the controller records the bound run identifier, not just that CI was green", () => {
  const s = ciEdge();
  assert.match(
    s,
    phrase('record the bound `<run-id>:<attempt>:<conclusion>`, not just "CI green"'),
    "the bullet no longer tells the controller to record the bound run identifier",
  );
  assert.match(
    s,
    phrase("That key cannot be reconstructed once the head is superseded"),
    "the reason the whole key has to be recorded is gone, which is what stops it being cut as bookkeeping",
  );
});

test("the pair stays coherent — a PR needing no fixes still reaches a finisher", () => {
  // ACCEPT side, and the stranding hazard this ticket's own brief names: the
  // head's CI edge has already fired, so a second event never arrives and this
  // bullet is that PR's only remaining route.
  assert.match(
    ciEdge(),
    phrase("A PR that needs nothing fixed reaches a finisher through the **fix-applier reports `no-op`** bullet below"),
    "the CI edge no longer points at its sibling, so a clean PR reads as gated on an event that will never fire",
  );
  const sibling = noOpEdge();
  assert.match(
    sibling,
    phrase("a `no-op` report satisfies the gate above by itself"),
    "the sibling no longer says a no-op report meets the new gate — the clean PR is stranded behind a condition it has already met",
  );
  assert.match(
    sibling,
    phrase("dispatch the finisher **now**"),
    "the sibling's dispatch-now instruction was weakened while the gate above was tightened",
  );
  // The gate must not reach the route that never had a fix-applier at all.
  assert.match(
    reviewSlotEdge(),
    phrase("skip the fix-applier and dispatch the **finisher** directly"),
    "the nothing-survived route to a finisher was gated on a fix-applier report it will never get",
  );
});

test("the narrative dispatch site states the same gate as the bullet", () => {
  // The bullet is where the controller acts, but this paragraph is where the
  // dispatch conditions are stated at length — the site whose `check`-green
  // trigger carried the same defect. Pinned so the two cannot drift apart,
  // which is how one gets corrected and the other keeps licensing the
  // unreviewed dispatch.
  const s = narrativeGate();
  assert.match(
    s,
    phrase("once the PR's review has returned and its fix-applier, if one was dispatched, has sent its report"),
    "the narrative finisher dispatch is back to `check`-green alone, contradicting the corrected bullet",
  );
  // Without this, the OUTBOX sentence below reads as denying that the member's
  // report is part of the gate at all — the reading the corrected bullet
  // contradicts.
  assert.match(
    s,
    phrase("That is the test of THIS condition only"),
    "the outbox test is unscoped again, so it reads as ruling the member's report out of the gate",
  );
  assert.match(s, /Never dispatch\s*\n?one while you still owe the fix-applier a ruling/);
});

test("the CI-edge slice is one bullet — a drifted end anchor would satisfy the pair test from inside it", () => {
  // The sibling assertions above are the ones a widened slice would answer, so
  // this is not a cosmetic bound: `edge-keyed` occurs only in the sibling.
  assert.doesNotMatch(
    ciEdge(),
    /edge-keyed/,
    "ciEdge() has widened across the sibling bullet, so the pair-coherence test can pass without the sibling saying anything",
  );
});
