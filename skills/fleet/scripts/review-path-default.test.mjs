import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The fleet's default review path is the controller running `review-pr.js`
// itself. Only the controller can: subagents have no `Workflow` tool, so on the
// hand-dispatch path `selectDimensions` and the severity-budgeted verify pass
// never execute (review-pr.js:143 — "the full set ran on every PR"), and every
// specialist report needs a controller relay to reach the reviewer at all.
//
// Both halves rot silently. A default demoted back to a preference reads as
// still-documented; relay prose left in the Phase 3 event loop reads as an
// obligation on every run, including the path where `agent()` returns into the
// script and no relay can ever occur. Neither shows up as an error.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "skills", "fleet", "commands", "review-and-fix.md"), "utf8");

// Slice by named anchors, and fail loudly when one moves. An unbounded slice
// runs to EOF, where the red-flag list restates enough of this vocabulary to
// satisfy every assertion below with the section itself deleted.
function section(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const end = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, `${label}: '${endAnchor}' moved — update this test`);
  return source.slice(at, end);
}

const FALLBACK_ANCHOR = "#### Fallback: hand-dispatched reviewer";

test("the Reviewers section names the workflow call as the default, ahead of the fallback", () => {
  const dflt = section(RUN_TEAM, "### Reviewers", FALLBACK_ANCHOR, "run-team Reviewers");
  assert.match(
    dflt,
    /Workflow\(\{\s*name: "review-pr"/,
    "run-team no longer names the review-pr Workflow call on the default path",
  );
  assert.match(
    dflt,
    /\bdefault\b/i,
    "the workflow call is no longer marked as the default review path",
  );
});

test("the fix-applier dispatch is specified: named, no suggestions applied, push and report and exit", () => {
  const dflt = section(RUN_TEAM, "### Reviewers", FALLBACK_ANCHOR, "run-team Reviewers");
  assert.match(dflt, /fix-pr-<pr#>/, "the fix-applier's member name is unspecified");
  // The apply/defer split is review-and-fix step 2's, and `suggestion` is the
  // band no adversarial pass checks — review-pr.js budgets it 0 verifiers. A
  // dispatch prompt that omits this applies claims nothing verified.
  assert.match(
    dflt,
    /suggestion/,
    "the fix-applier prompt no longer excludes `suggestion` findings from the apply pass",
  );
  assert.match(dflt, /push/i, "the fix-applier prompt no longer says to push");
  assert.match(dflt, /SHA/, "the fix-applier prompt no longer says to report the SHA");
});

test("relay and reconciliation live under the fallback, not in the Phase 3 event loop", () => {
  const loop = section(RUN_TEAM, "## Phase 3", "### Reviewers", "run-team Phase 3");
  assert.doesNotMatch(
    loop,
    /relay/i,
    "the Phase 3 event loop still carries a relay obligation — on the default path `agent()` returns into the script and no relay ever occurs",
  );
  const fallback = section(RUN_TEAM, FALLBACK_ANCHOR, "\n### ", "run-team fallback");
  assert.match(fallback, /relay/i, "the fallback lost the relay duty");
  assert.match(
    fallback,
    /reconcile/i,
    "the fallback lost the verdict-vs-receipts reconciliation rule",
  );
});

test("review-and-fix agrees the workflow is the controller's default, not its preference", () => {
  const specialists = section(REVIEW_AND_FIX, "## Specialists", "\n- **Spawn unnamed", "review-and-fix Specialists");
  assert.doesNotMatch(
    specialists,
    /should prefer/,
    "review-and-fix still frames the workflow as a controller preference, contradicting run-team's default",
  );
  assert.match(
    specialists,
    /\bdefault\b/i,
    "review-and-fix no longer states the workflow is the fleet's default review path",
  );
  assert.match(
    specialists,
    /fallback/i,
    "review-and-fix no longer marks its hand-dispatch rules as the fallback",
  );
});
