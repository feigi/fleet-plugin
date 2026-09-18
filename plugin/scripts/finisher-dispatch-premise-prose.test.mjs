// #1499. #1053 corrected one falsified premise — that the finisher edge fires
// on the fix-applier's own push, so green alone licenses a dispatch — at three
// sites. Two are pinned by `ci-completes-premise-prose.test.mjs` (the phase-3
// **Monitor: CI run completes** bullet and the narrative finisher paragraph,
// both in `skills/run-team/SKILL.md`). The third is this file's subject:
// `commands/review-and-fix.md` step 4, the copy a fix-applier actually reads.
// That sibling's own comment already says its slices do not reach here, and
// nothing else did either — the premise closed at two sites and stayed open at
// the third, which is the exact shape of the loophole #1053 was filed for.
//
// THE CLASS, enumerated. `dispatch(es) a finisher` occurs at four prose sites
// besides the two already pinned:
//   - `commands/review-and-fix.md` step 4 — the dispatch GATE. COVERED here.
//   - `skills/run-team/SKILL.md` "which dispatches a finisher against" (inside
//     the quoted fix-applier dispatch block) — a SHA-pinning instruction, not
//     the green gate; already held byte-for-byte by
//     `dispatch-block-golden-prose.test.mjs`'s golden fixture. Left.
//   - `skills/run-team/SKILL.md` "a tree to dispatch a finisher against" —
//     worktree lifetime, a different claim entirely. Left.
//   - `head-moved-after-label-prose.test.mjs`'s own comment — a test comment,
//     not instruction prose. Left.
// Re-pinning the two sibling sites is out of scope (#1499 says so); this file
// adds the third guard and touches neither.
//
// WHY ONE CONTIGUOUS SPAN, not two presence checks. Both halves of the gate are
// load-bearing — the report having arrived, and CI being green — and the rule
// lives in their JOIN. Pinning the halves separately stays green on a mutant
// that keeps both phrases and swaps the conjunction ("arrived OR CI is green"),
// which is the pre-#1053 defect restored with more words. One exact span refuses
// all four mutations below, so that is the shape used, with the reflow control
// alongside it as the proof it is not thereby over-tight.
//
// Mutation-tested by hand, 2026-09-18, against a scratch copy of
// `commands/review-and-fix.md` under `/tmp/fleet-scratch/impl-1499/` (never the
// real checkout), each substitution asserted to have applied before the run was
// believed. Family = `plugin/scripts/*prose*.test.mjs` + `prose-pin.test.mjs`.
//
// BEFORE this file, 601/601 green on every one of:
//   (M1) the clause reverted to the pre-#1053 "dispatches a finisher on green"
//   (M2) only the report-arrival half dropped ("once CI is green")
//   (M3) only the CI half dropped ("once your report has arrived")
// Nothing reddened — the reversion was invisible to the whole family, which is
// the defect this file exists to remove. (Triage measured the same on a
// 570-test family; it has grown to 601 since, same result.)
//
// AFTER this file, 606/606 green clean, and each mutation reds exactly the pins
// that own it, by test NAME — never a raw failure count, which `node --test`
// prints twice per red:
//   (M1) "dispatches a finisher on green"      → 3 red: span pin, reverted-
//                                                 wording pin, reflow control
//   (M2) "once CI is green"                    → 2 red: span pin, reflow control
//   (M3) "once your report has arrived"        → 2 red: span pin, reflow control
//   (M4) "...has arrived OR CI is green"       → 2 red: span pin, reflow control
//                                                 — the mutant half-pins miss
//   (C1) step 4 rewrapped at 53 cols, meaning identical → every pin in this
//                                                 file green
// M2/M3 reddening on their own is what proves each half is separately
// load-bearing; only M1 additionally trips the reverted-wording pin, which is
// that pin owning exactly its one claim. The reflow control reds alongside the
// span pin on all four because it is derived from the LIVE slice rather than a
// quoted copy of today's line — the property that makes it a reflow control and
// not a second fixture to keep in sync.
//
// C1 also reddens ONE pin outside this file — `pointer-target-prose.test.mjs`'s
// "every pointer clause in the document is still recognised", which extracts
// `see **…**` clauses per physical line and finds 3 instead of 5 once step 4
// wraps. That is pre-existing brittleness in another file's pin, not fallout
// from this one: with this file deleted, the same rewrap reds the same single
// test (measured, 598/599). Not touched here — #1499 scopes this ticket to the
// third site's guard and explicitly out of migrating anything else.
//
// THE CEILING: a prose pin. It proves the two-condition gate is STATED where a
// fix-applier reads it, bounded to the step that states it. It cannot prove a
// controller obeys it, nothing here calls `gh`, and — matching the sibling pins'
// strictness rather than exceeding it — the span is matched against raw bytes,
// so a `**` moved INTO the pinned words would red it. No emphasis sits inside
// that span today and `#1465`/`#1492`'s helper migrations are explicitly not
// this ticket's to make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorAt, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const DOC = "commands/review-and-fix.md";
const reviewAndFix = () => readFileSync(join(REPO, ...DOC.split("/")), "utf8");

// The slice. Not `paragraph()`: this document writes one long line per numbered
// step with no blank line between them, so the next `\n[ \t]*\n` after step 4
// sits below step 6 — a blank-line bound would hand back three steps, and a pin
// on the gate would then be satisfiable from step 6's own green/label prose.
//
// Bounded instead by two landmarks NEITHER half of the gate owns: step 4's own
// opening imperative, and the instruction the premise justifies. Both sit
// OUTSIDE every mutation above by construction — a mutant that rewrote a bound
// would make `anchorAt` throw instead of the pin reddening, which is the harness
// losing its footing rather than a pin discriminating. Both go through
// `phrase()` (`anchorAt` does it for the start, `STEP4_TO` for the end), so a
// reflow moves neither, and both are single-hit in this file:
//   grep -cF "Under the fleet, do not hold this wait"     → 1
//   grep -cF "so push, then report to the controller a"    → 1
const STEP4_FROM = "Under the fleet, do not hold this wait";
const STEP4_TO = phrase("so push, then report to the controller a");
const WHAT = `${DOC} step 4 finisher-dispatch premise`;

// Throws rather than widening at BOTH ends — `anchorAt` on a moved or
// duplicated start anchor, the assert below on a moved end anchor. Silently
// falling back to the whole document is the false green this bound exists to
// deny, and the bound-integrity test at the bottom holds that claim.
const dispatchPremise = (text = reviewAndFix()) => {
  const rest = text.slice(anchorAt(text, STEP4_FROM, WHAT));
  const end = rest.search(STEP4_TO);
  assert.notEqual(
    end,
    -1,
    `${WHAT}: the instruction closing step 4's premise moved — re-anchor this test, never widen it to the whole file`,
  );
  return rest.slice(0, end);
};

// The gate, as ONE span: the dispatch, the report having arrived, and CI being
// green, in the order and with the conjunction the corrected prose uses.
const GATE = "dispatches a finisher once your report has arrived and CI is green";

// The pre-#1053 wording, verbatim from the commit that removed it (1be2080).
// Narrow on purpose: it must not match the corrected clause, whose "finisher"
// is followed by "once", not "on".
const REVERTED = "dispatches a finisher on green";

test("review-and-fix.md step 4 gates the finisher on the member's report AND CI, never on green alone", () => {
  assert.match(
    dispatchPremise(),
    phrase(GATE),
    `${DOC} step 4 no longer says "${GATE}". This is the sentence every fix-applier reads before pushing: with either half dropped it licenses a dispatch onto a SHA the member may still move, or onto a PR whose report has not arrived — the falsified premise #1053 corrected at two other sites.`,
  );
});

// The negative, deliberately at the WIDEST scope this file owns — the whole
// document, not the slice. A copy of the pre-#1053 premise surviving anywhere in
// the member-facing command is the defect back, whether or not it sits in step
// 4. The positive companion on the same scope is what keeps this from passing
// vacuously: alone, a `doesNotMatch` is satisfied by a document that has
// degenerated to nothing, and this one would then pass while the sentence was
// gone. The companion is deliberately the DISPATCH CLAUSE only, never the whole
// gate — pinning the gate here too would red this test on every mutation that
// drops a half, duplicating the span pin above and destroying the per-pin
// discrimination the mutation evidence in the header reports. This test owns
// exactly one claim: the pre-#1053 wording is not back.
test("no sentence anywhere in review-and-fix.md licenses a finisher on green alone", () => {
  const live = reviewAndFix();
  assert.match(live, phrase("dispatches a finisher"), `${DOC} no longer says "dispatches a finisher" at all — the negative below would pass on a document that had lost the sentence entirely`);
  assert.doesNotMatch(
    live,
    phrase(REVERTED),
    `${DOC} says "${REVERTED}" again — that is the #1053 defect verbatim. The implementer's own push fires the CI edge first for every PR, so green arrives before any review has returned and this wording dispatches a finisher into it.`,
  );
});

// The slice is step 4's own sentence and cannot reach its neighbours. Without
// this, a drifted end bound would let the gate pin above be satisfied from step
// 5 or step 6 — both of which talk about green, labels and reporting — and the
// pin would go on passing with step 4's premise reverted.
test("the pinned span is bounded to step 4 — neither neighbouring step is inside it", () => {
  const slice = dispatchPremise();
  assert.doesNotMatch(slice, phrase("Run `testCmd` before you commit"), `${WHAT}: the slice reaches back into step 3`);
  assert.doesNotMatch(slice, phrase("File each deferred finding"), `${WHAT}: the slice runs forward into step 5`);
  assert.doesNotMatch(slice, phrase("Diff-check green"), `${WHAT}: the slice runs forward into step 6`);
});

// ACCEPT SIDE — reflow. Derived from the LIVE slice, never a quoted copy of
// today's line, so a reword of neighbouring prose is not what this measures.
// Re-wrapped at a width nothing here assumes and rejoined with the newline plus
// list indent a markdown wrap actually produces: the span pin must still hold,
// because what it refuses is drift in the gate, not where the lines break. The
// inequality assert first — a fixture that has stopped changing the wrapping
// proves nothing and must be updated rather than left passing.
test("a rewrapped step 4 is ACCEPTED — the gate pin refuses drift, not line breaks", () => {
  const live = dispatchPremise();
  const rewrapped = live
    .split(/\s+/)
    .filter(Boolean)
    .reduce((acc, w) => {
      const last = acc[acc.length - 1];
      if (last && `${last} ${w}`.length <= 41) acc[acc.length - 1] = `${last} ${w}`;
      else acc.push(w);
      return acc;
    }, [])
    .join("\n   ");
  assert.notEqual(rewrapped, live, "the rewrap fixture no longer changes the wrapping — update it");
  assert.match(rewrapped, phrase(GATE), "the gate pin reds on a pure reflow — it is over-tight, not strict");
  assert.doesNotMatch(rewrapped, phrase(REVERTED));
});

// The bound's failure mode, asserted rather than assumed. #1499's own acceptance
// criterion: if an anchor moves, this slicer must THROW — a slicer that fell
// back to the whole document would leave the gate pin passing off step 6's
// prose, which is the vacuous green every bound in this directory exists to
// prevent. Both ends and both `anchorAt` failure directions are covered: a
// start anchor that is gone, one that occurs twice (a restatement above the real
// one would otherwise bind the pin to the wrong copy), and a moved end anchor.
//
// Each fixture is cut with a `phrase()` REGEX, never a literal `replace()`, and
// every one is asserted to have changed the document before it is believed.
// Measured, and the reason this is not a style preference: with literal
// substrings here, the end-anchor fixture silently no-ops the moment step 4 is
// rewrapped — the words are still there, just with a newline among them — so
// `dispatchPremise` does not throw, and the assertion fails claiming the BOUND
// is broken when only the fixture was. A no-op fixture that reports as a
// finding is worse than one that reds honestly.
const cut = (text, target, replacement, label) => {
  const mutant = text.replace(phrase(target), replacement);
  assert.notEqual(mutant, text, `the ${label} fixture no longer changes the document — update it, do not trust a result measured against it`);
  return mutant;
};

test("the slice bound throws rather than widening when an anchor moves", () => {
  const live = reviewAndFix();
  assert.throws(
    () => dispatchPremise(cut(live, STEP4_FROM, "Under the fleet, do not sit on this wait", "vanished start anchor")),
    /slice anchor .* moved — re-anchor this test, never widen it/,
    "a vanished start anchor widened the slice instead of throwing",
  );
  assert.throws(
    () => dispatchPremise(`${live}\n\n${STEP4_FROM} — a restatement below.\n`),
    /occurs 2 times/,
    "a duplicated start anchor bound the pin to one copy instead of throwing",
  );
  assert.throws(
    () => dispatchPremise(cut(live, "so push, then report to the controller a", "so push and then report a", "moved end anchor")),
    /the instruction closing step 4's premise moved/,
    "a moved end anchor ran the slice past step 4 instead of throwing",
  );
});
