// #1347, hand-off from #1294: commands/review-and-fix.md step 6 used to
// document the release-label gate as CONDITIONAL — "a repo defining none of
// them does not gate on one" — true before this repo had any release
// pipeline to gate. #1347 ports `release-label.yml`/`release.yml`
// (agent-brain's shape): `release-label.yml`'s `auto-label-bots` job adds
// `patch` to a dependabot or renovate PR with no release label, and
// `validate-release-label` hard-fails any PR with none or more than one, so
// the gate is required on every PR — the conditional clause is stale and
// this ticket flips it to state the gate as required. Step 6 once said the
// job auto-adds `patch` to every PR with none; it does so for bot PRs only.
//
// Cited by step NAME, not by line — this repo's own convention
// (ci.yml: "a refactor that shifts that file silently re-points a line
// number at unrelated code"): #1361 is in flight on this same file, inside
// its Specialists section, well below step 6; this pin's slice starts and
// ends inside step 6's own paragraph and cannot reach that section either
// way, regardless of which lines either one currently sits on.
//
// Mutation-tested by hand, 2026-09-09, against a scratch copy of
// commands/review-and-fix.md (never the real checkout): (1) reverting
// "required on every PR" back to the old "a repo defining none of them does
// not gate on one" wording reddened this file's presence pin and left the
// count/label-name pins (already covered by release-label-split-prose.test.mjs)
// unaffected; (2) deleting the `release-label.yml` citation entirely also
// reddened it; (3) the unrelated Specialists section was untouched
// throughout, confirming the slice below cannot see that far.
//
// CEILING: a presence pin over a bounded slice, same shape and same limits
// as every other prose test here (release-label-split-prose.test.mjs's own
// header states them) — this proves the required-gate clause is PRESENT in
// step 6's own paragraph, not that no later edit could dilute it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const REVIEW_AND_FIX = Pin.file(join(REPO, "commands", "review-and-fix.md"));

// Bounded to step 6's own paragraph — starts at the step's own opening
// clause, ends at the `ready-to-merge` label command that closes its first
// sentence. Never widened past that, so #1361's in-flight Specialists
// section is out of this slice's reach in either direction, wherever it
// currently sits.
const step6ReleaseLabelClause = () =>
  REVIEW_AND_FIX.between(
    "the PR carrying exactly one release label",
    "gh pr edit <pr> --add-label ready-to-merge",
    "review-and-fix.md step 6",
  ).text;

test("review-and-fix.md step 6 states the release-label gate as required, not conditional on the repo defining one", () => {
  const slice = step6ReleaseLabelClause();
  assert.match(slice, Pin.phrase("required on every PR"));
  assert.match(slice, Pin.phrase("release-label.yml"));
  assert.match(slice, Pin.phrase("auto-adds `patch` only to a dependabot or renovate PR that has none, and hard-fails any PR with none or more than one"));
});

test("review-and-fix.md step 6 no longer says release-label.yml labels every PR with none", () => {
  const slice = step6ReleaseLabelClause();
  assert.doesNotMatch(slice, Pin.phrase("auto-adds `patch` when none is present"));
});

test("review-and-fix.md step 6 no longer states the old conditional wording", () => {
  const slice = step6ReleaseLabelClause();
  assert.doesNotMatch(slice, Pin.phrase("a repo defining none of them does not gate on one"));
});

test("review-and-fix.md step 6 still names the exact three release labels, unchanged by the flip", () => {
  const slice = step6ReleaseLabelClause();
  assert.match(slice, Pin.phrase("patch"));
  assert.match(slice, Pin.phrase("minor"));
  assert.match(slice, Pin.phrase("major"));
  assert.match(slice, Pin.phrase("counting only those three"));
});
