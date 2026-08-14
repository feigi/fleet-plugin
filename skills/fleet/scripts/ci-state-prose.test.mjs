// Pins the two scope words #182's dedup dropped from the `ci-state.mjs`
// paragraph in both fleet command documents (#198). The reference is the
// comment beside the `missing` computation in ci-state.mjs, which carries both:
// force-push as the cause of the cancelled run whose finished jobs keep their
// conclusions, and "reads as pending" scoped to a checks summary — the
// aggregating view — rather than to ci-state.mjs itself. On an absent job
// ci-state.mjs pushes the reason `expected jobs absent from the run: <names>`
// and a non-empty `reasons` is verdict `not-green`, exit 1.
//
// THE CEILING: these prove the clauses are PRESENT in the smallest slice that
// can hold them. They cannot prove a sentence added beside one does not negate
// it, and they do not run ci-state.mjs — ci-state.test.mjs owns its behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const REVIEW_AND_FIX = readFileSync(join(REPO, "skills", "fleet", "commands", "review-and-fix.md"), "utf8");
const RUN_MERGE_BOT = readFileSync(join(REPO, "skills", "fleet", "commands", "run-merge-bot.md"), "utf8");

// SLICE SIZE is what anchors these. Both documents discuss `pending`, cancelled
// runs and force-pushes in neighbouring paragraphs, so a regex over the section
// — let alone the file — stays green with the sentence under test deleted
// outright. Each slice below is the single sentence that makes the claim.
function sentence(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: start anchor '${startAnchor}' moved — update this test`);
  const rest = source.slice(at + startAnchor.length);
  const end = rest.indexOf(endAnchor);
  assert.notEqual(end, -1, `${label}: end anchor '${endAnchor}' moved — update this test`);
  return startAnchor + rest.slice(0, end);
}

const reviewAndFix = () =>
  sentence(
    REVIEW_AND_FIX,
    "Its job-presence check is what catches the case above",
    "\n\n**A repo with no workflow files",
    "review-and-fix job-presence sentence",
  );

const runMergeBot = () =>
  sentence(
    RUN_MERGE_BOT,
    "That presence requirement is what catches the case above",
    "**Re-query at the moment you merge",
    "run-merge-bot presence-requirement sentence",
  );

test("review-and-fix states what cancels the run whose finished jobs keep their conclusions", () => {
  assert.match(reviewAndFix(), /a force-push cancels the run under you/);
  assert.match(reviewAndFix(), /finished jobs keep the conclusions they already reached/);
});

test("both documents scope `pending` to the aggregating view, never to ci-state.mjs", () => {
  for (const [label, slice] of [["review-and-fix", reviewAndFix()], ["run-merge-bot", runMergeBot()]]) {
    assert.match(slice, /reads as `pending` in an aggregating checks summary/, `${label}: \`pending\` is unscoped — it reads as ci-state.mjs's own behavior`);
    assert.match(slice, /expected jobs absent from the run/, `${label}: does not say what ci-state.mjs actually reports for an absent job`);
    assert.match(slice, /refuses green/, `${label}: does not say ci-state.mjs withholds green on an absent job`);
  }
});
