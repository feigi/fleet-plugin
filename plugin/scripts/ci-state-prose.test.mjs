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
// THE CEILING: a sentence added beside an intact span that negates it stays
// green. And these do not run ci-state.mjs — ci-state.test.mjs owns its
// behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, phrase, unemphasized } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
const RUN_MERGE_BOT = readFileSync(join(REPO, "commands", "run-merge-bot.md"), "utf8");

// The reason string belongs to ci-state.mjs, so read it from ci-state.mjs: renaming
// it there reddens these pins too, instead of leaving both documents quoting a
// string the source no longer emits. Captures the template's literal head only —
// everything before the `${missing…}` interpolation, which no document can contain.
const CI_STATE = readFileSync(join(import.meta.dirname, "ci-state.mjs"), "utf8");
const ABSENT_REASON = (CI_STATE.match(/reasons\.push\(`([^`$]+)\$\{missing\./) ?? [])[1];

// Each claim is ONE contiguous span (prose-pin.mjs's convention), because
// keywords bound only by the slice were not enough: with the `pending`
// sentence gutted and its phrases restated as a second sentence in the same
// paragraph, meaning inverted, three independent checks (two regexes and a
// substring match) stayed green (#491,
// measured — both documents). The slice still does its own half: it bounds
// WHERE the span may be found. Both documents discuss `pending`, cancelled runs
// and force-pushes in neighbouring paragraphs, so each slice stops at the end
// of its own PARAGRAPH, not at the next section marker: without that bound a
// gutted sentence stays pinned by a fresh paragraph inserted before the marker
// (measured — both documents, suite green).
//
// The shared bound, not a local copy of it (#1372). What it closes that a local
// copy could not: a blank line carrying whitespace, which a literal `\n\n`
// search runs straight past into the next paragraph, and an anchor occurring
// more than once, which binds the pin to whichever copy of the anchored block
// comes first. What it does NOT close is a blank line deleted outright — the
// paragraphs then merge and the slice takes both, a hole that predates this
// bound and is open still (#1377).
//
// The local copy this replaced took a SECOND bound, the opening of the next
// paragraph, and used the blank line only as a tightener. In both documents the
// blank line already falls where that opening begins, so the migrated slices are
// byte-identical to what the local copy returned. But the local copy also
// ASSERTED that opening was reachable, and that assert is the one thing that
// sees the merge — so it is kept, as its own check rather than as a bound.
const reviewAndFix = () =>
  paragraph(REVIEW_AND_FIX, "Its job-presence check is what catches the case above", "review-and-fix job-presence sentence");

const runMergeBot = () =>
  paragraph(RUN_MERGE_BOT, "That presence requirement is what catches the case above", "run-merge-bot presence-requirement sentence");

// The blank line each slice stops at is a bound only while it is there: delete
// it and the following paragraph merges into the slice, where a copy of the
// gutted clause satisfies every assertion in this file (measured — either
// document, whole suite green without this check). `paragraph` cannot tell a
// merged paragraph from a genuine one, so the opening of the next paragraph is
// asserted here, with the blank line that separates it included in the literal.
const NEXT_PARAGRAPH = [
  ["review-and-fix", REVIEW_AND_FIX, "\n\n**A repo with no workflow files"],
  ["run-merge-bot", RUN_MERGE_BOT, "\n\n   **Why twice: a conclusion can invert under a fixed run id.**"],
];

test("each pinned paragraph is still followed by a blank line and the paragraph that opened after it", () => {
  for (const [label, doc, opening] of NEXT_PARAGRAPH) {
    assert.ok(
      doc.includes(opening),
      `${label}: ${JSON.stringify(opening)} is gone. If the blank line went, the pinned slice now runs on into that paragraph and a gutted clause reads as pinned; if the paragraph itself moved or was reworded, re-anchor this check`,
    );
  }
});

// Both documents carry both claims, but each words the aftermath its own way,
// so the force-push span is per-document and the `pending` span is shared.
// Pinning either claim against one document only leaves the other free to lose
// it. Matched through `unemphasized()` so a `**` move stays green, and through
// `phrase()` so a reflow does.
const DOCS = [
  ["review-and-fix", reviewAndFix, "a force-push cancels the run under you, its finished jobs keep the conclusions they already reached"],
  ["run-merge-bot", runMergeBot, "a force-push cancels the run under you, its finished jobs go on reporting what they concluded"],
];

test("both documents name the force-push that cancels the run whose finished jobs keep reporting", () => {
  for (const [label, slice, span] of DOCS) {
    assert.match(
      unemphasized(slice()),
      phrase(span),
      `${label}: lost or reworded the span "${span}" — the claim that a force-push cancels the run and its finished jobs go on reporting. If the claim still stands in new words, re-pin this span deliberately`,
    );
  }
});

test("both documents scope `pending` to the aggregating view, never to ci-state.mjs", () => {
  assert.ok(ABSENT_REASON, "ci-state.mjs no longer pushes a reason built from `missing` — update this test");
  const span = `reads as \`pending\` in an aggregating checks summary, never here: \`ci-state.mjs\` names it in the reason \`${ABSENT_REASON}…\` and refuses green`;
  for (const [label, slice] of DOCS) {
    assert.match(
      unemphasized(slice()),
      phrase(span),
      `${label}: lost or reworded the span "${span}" — the claim that \`pending\` belongs to an aggregating checks summary while ci-state.mjs names the absent job in its actual reason string and withholds green. If the claim still stands in new words, re-pin this span deliberately`,
    );
  }
});
