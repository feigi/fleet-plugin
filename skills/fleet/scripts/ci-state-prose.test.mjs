// Pins the two scope words #182's dedup dropped from the `ci-state.mjs`
// paragraph in both fleet command documents (#198). The reference is the
// comment beside the `missing` computation in ci-state.mjs, which carries both:
// force-push as the cause of the cancelled run whose finished jobs keep their
// conclusions, and "reads as pending" scoped to a checks summary — the
// aggregating view — rather than to ci-state.mjs itself. On an absent job
// ci-state.mjs pushes a reason naming the absent jobs — read out of ci-state.mjs
// below rather than restated here — and a non-empty `reasons` is verdict
// `not-green`, exit 1.
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

// The reason string belongs to ci-state.mjs, so read it from ci-state.mjs: renaming
// it there reddens these pins too, instead of leaving both documents quoting a
// string the source no longer emits. Captures the template's literal head only —
// everything before `${missing.join(...)}`, which no document can contain.
const CI_STATE = readFileSync(join(import.meta.dirname, "ci-state.mjs"), "utf8");
const ABSENT_REASON = (CI_STATE.match(/reasons\.push\(`([^`$]+)\$\{missing\.join/) ?? [])[1];

// SLICE SIZE is what anchors these. Both documents discuss `pending`, cancelled
// runs and force-pushes in neighbouring paragraphs, so a regex over the section
// — let alone the file — stays green with the sentence under test deleted
// outright. So each slice stops at the end of its own PARAGRAPH, not at the next
// section marker: without that bound a gutted sentence stays pinned by a fresh
// paragraph inserted before the marker (measured — both documents, suite green).
function sentence(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: start anchor '${startAnchor}' moved — update this test`);
  const rest = source.slice(at + startAnchor.length);
  const end = rest.indexOf(endAnchor);
  assert.notEqual(end, -1, `${label}: end anchor '${endAnchor}' moved — update this test`);
  const para = rest.indexOf("\n\n");
  return startAnchor + rest.slice(0, para !== -1 && para < end ? para : end);
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

// Both documents carry both clauses, but each words the aftermath its own way,
// so the shared cause is one regex and the aftermath is per-document. Pinning
// either clause against one document only leaves the other free to lose it.
const DOCS = [
  ["review-and-fix", reviewAndFix, /finished jobs keep the conclusions they already reached/],
  ["run-merge-bot", runMergeBot, /finished jobs go on reporting what they concluded/],
];

test("both documents name the force-push that cancels the run whose finished jobs keep reporting", () => {
  for (const [label, slice, aftermath] of DOCS) {
    assert.match(slice(), /a force-push cancels the run under you/, `${label}: does not name a force-push as what cancels the run`);
    assert.match(slice(), aftermath, `${label}: does not say the cancelled run's finished jobs go on reporting`);
  }
});

test("both documents scope `pending` to the aggregating view, never to ci-state.mjs", () => {
  for (const [label, slice] of DOCS) {
    assert.match(slice(), /reads as `pending` in an aggregating checks summary/, `${label}: \`pending\` is unscoped — it reads as ci-state.mjs's own behavior`);
    assert.ok(ABSENT_REASON, "ci-state.mjs no longer pushes a reason built from `missing` — update this test");
    assert.ok(slice().includes(ABSENT_REASON), `${label}: does not quote ci-state.mjs's actual reason string \`${ABSENT_REASON}\``);
    assert.match(slice(), /refuses green/, `${label}: does not say ci-state.mjs withholds green on an absent job`);
  }
});
