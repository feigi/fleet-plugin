// #1347, hand-off from #1294: commands/review-and-fix.md step 6 used to
// document the release-label gate as CONDITIONAL — "a repo defining none of
// them does not gate on one" — true before this repo had any release
// pipeline to gate. #1347 ports `release-label.yml`/`release.yml`
// (agent-brain's shape): `release-label.yml`'s `auto-label-bots` job adds
// `patch` when no release label is present and `validate-release-label`
// hard-fails on more than one, so every PR on this repo now carries exactly
// one release label by the time it reaches step 6 — the conditional clause
// is stale and this ticket flips it to state the gate as required.
//
// Kept to line 11 ONLY — #1361 is in flight on this same file at line ~37
// (the Specialists section); this pin's slice starts and ends inside step
// 6's own paragraph, nowhere near it.
//
// Mutation-tested by hand, 2026-09-09, against a scratch copy of
// commands/review-and-fix.md (never the real checkout): (1) reverting
// "required on every PR" back to the old "a repo defining none of them does
// not gate on one" wording reddened this file's presence pin and left the
// count/label-name pins (already covered by release-label-split-prose.test.mjs)
// unaffected; (2) deleting the `release-label.yml` citation entirely also
// reddened it; (3) the unrelated Specialists section at line ~37 was
// untouched throughout, confirming the slice below cannot see that far.
//
// CEILING: a presence pin over a bounded slice, same shape and same limits
// as every other prose test here (release-label-split-prose.test.mjs's own
// header states them) — this proves the required-gate clause is PRESENT in
// step 6's own paragraph, not that no later edit could dilute it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

// Bounded to step 6's own paragraph — starts at the step's own opening
// clause, ends at the `ready-to-merge` label command that closes its first
// sentence. Never widened past that, so #1361's in-flight Specialists edit
// at line ~37 is out of this slice's reach in either direction.
const step6ReleaseLabelClause = () =>
  between(
    REVIEW_AND_FIX,
    "the PR carrying exactly one release label",
    "gh pr edit <pr> --add-label ready-to-merge",
    "review-and-fix.md step 6",
  );

test("review-and-fix.md step 6 states the release-label gate as required, not conditional on the repo defining one", () => {
  const slice = step6ReleaseLabelClause();
  assert.match(slice, phrase("required on every PR"));
  assert.match(slice, phrase("release-label.yml"));
  assert.match(slice, phrase("auto-adds `patch` when none is present and hard-fails on more than one"));
});

test("review-and-fix.md step 6 no longer states the old conditional wording", () => {
  const slice = step6ReleaseLabelClause();
  assert.doesNotMatch(slice, phrase("a repo defining none of them does not gate on one"));
});

test("review-and-fix.md step 6 still names the exact three release labels, unchanged by the flip", () => {
  const slice = step6ReleaseLabelClause();
  assert.match(slice, phrase("patch"));
  assert.match(slice, phrase("minor"));
  assert.match(slice, phrase("major"));
  assert.match(slice, phrase("counting only those three"));
});
