// #239. `decided?` is a correct test that was running in the wrong seat.
// `review-and-fix.md` step 5 sent the FILER to `run-team/SKILL.md` phase 0's
// criterion, importing phase 0's cost model — where implementer divergence
// costs a claim, a worktree and a dispatch — into a seat where divergence costs
// one PR review the maintainer already runs. Same test, two seats, opposite
// correct answers. The ruling and its reasoning are ADR 0001.
//
// What this pins is the SPLIT, which lives in the join between two documents
// read by two different agents. Neither file is wrong on its own after a
// revert: step 5 can go back to delegating and phase 0 will still be a
// perfectly good consumption gate, and nothing else in the tree notices. That
// is why the pin is here rather than inside either file's existing suite.
//
// Slices are flattened. `run-team/SKILL.md` hard-wraps at ~80 columns, so every
// literal space in these phrases may be a newline plus indent; `review-and-fix.md`
// authors one long line per step today, which makes `flat()` a no-op there
// until the day someone wraps it. Reflow-brittleness is a class defect in this
// repo's prose pins, so both are flattened whether or not a width reds today.
//
// CEILING: presence and adjacency over bounded slices. These prove the rule is
// stated and that its inverse is not; they cannot prove a later sentence in the
// same slice does not carve out an exception.
//
// Measured as of this commit, on an isolated copy of the four files: 12 semantic
// mutations — both label branches inverted, the torn tie-break deleted and
// exception-spliced, the delegation restored, the gate sentence deleted and
// stripped of its seat pricing, the ADR pointer renamed on one side, the guard
// floor and trigger each retuned, complements swapped to supersedes, and the
// apply/label roles swapped — each reddened its own pin and no other. Nine
// controls stayed green: the gate paragraph rewrapped at 70/100/140 and by
// `fmt(1)`, the guard bullets and step 5 rewrapped, an unpinned step-5 sentence
// reworded, and an ADR heading reworded. Re-derive after any edit to these
// slices; a rationale indexed to wording rots with the wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "fleet", "skills", "run-team", "SKILL.md");
const REVIEW_AND_FIX = read("skills", "fleet", "commands", "review-and-fix.md");

const flat = (s) => s.replace(/\s+/g, " ");

const step5 = () => flat(between(REVIEW_AND_FIX, "5. File each deferred finding", "\n6. Diff-check green", "review-and-fix step 5"));
// Bounded by the two phase-0 markers that bracket the note, never by the note
// itself: anchoring on the sentence under test turns its deletion into a
// slicing error rather than a failed assertion.
const decidedNote = () => flat(between(RUN_TEAM, "**Torn → surface, never guess**", "**Class?**", "run-team phase 0 decided? note"));

test("step 5 routes a confirmed defect with an open remedy to ready-for-agent", () => {
  const s = step5();
  // The MAPPING, not the two labels. Both label strings occur in this slice
  // whichever way the rule points, so a pin on either alone stays green with
  // the branches swapped. `needs-triage` is excluded from the gap and `[^.]`
  // keeps the match inside one sentence.
  assert.match(
    s,
    /Confirmed defect with the remedy still open(?:(?!needs-triage)[^.])*?ready-for-agent/,
    "step 5 no longer sends a confirmed defect with an open remedy to `ready-for-agent`",
  );
  // The tie-break and its narrowed meaning are ONE claim: `torn → needs-triage`
  // survived the reprice only because torn was redefined to "unsure anything is
  // broken". Pinned as a contiguous span, because two separate matches would
  // leave the join open — an exception clause spliced between them reverses the
  // rule and satisfies both.
  assert.match(
    s,
    phrase("Torn → `needs-triage`, narrowed: torn means **unsure anything is broken**, not unsure how to fix it."),
    "step 5 lost the narrowed torn tie-break, so `needs-triage` is back to meaning `unsure how to fix it`",
  );
});

test("step 5 states its own bar instead of delegating to phase 0's criterion", () => {
  const s = step5();
  // The positive companion. A bare negative on `decided?` would be vacuous here
  // by construction — step 5 names the test deliberately, in order to rule it
  // out — so what is pinned is the sentence that rules it out.
  assert.match(
    s,
    phrase("Do **not** reach for phase 0's **decided?** test here."),
    "step 5 no longer tells the filer to leave phase 0's `decided?` test alone",
  );
  // The superseded delegation, verbatim from the text 6d0c1f6 replaced.
  // Verified zero occurrences in the current file.
  assert.doesNotMatch(
    s,
    phrase("read the criterion there rather than re-deriving it here"),
    "step 5 delegates the label choice back to phase 0 — the two seats have re-collided",
  );
});

test("phase 0 marks decided? as a consumption gate and names an ADR that exists", () => {
  const s = decidedNote();
  // Contiguous span again: "consumption gate" and "the filing-time counterpart
  // was repriced" pin nothing apart. The gate label is only meaningful bound to
  // the seat it is priced for and to the counterpart that is priced differently.
  assert.match(
    s,
    phrase(
      "**This is a consumption gate**, priced for the seat where implementer divergence costs a claim, a worktree and a dispatch; the filing-time counterpart was repriced to *is the defect confirmed* and states its own bar inline",
    ),
    "phase 0's `decided?` note no longer marks it a consumption gate with a repriced filing-time counterpart",
  );
  // Read the path out of the prose rather than restating it, so a rename that
  // updates only one side reds. A pointer into a document that is not there
  // fails silently for every reader.
  const [, adr] = s.match(/see `(docs\/adr\/[^`]+)`/) ?? [];
  assert.ok(adr, "phase 0's `decided?` note no longer points at an ADR under `docs/adr/`");
  assert.ok(existsSync(join(REPO, adr)), `phase 0 points at \`${adr}\`, which does not exist`);
});

test("the ADR keeps its pre-chosen guard and its #211 relationship", () => {
  const adr = flat(read("docs", "adr", "0001-filing-label-bar-is-defect-confirmed.md"));
  // Floor and trigger as one span. Chosen before any data, on the tier guard's
  // precedent, so that a later run cannot derive a threshold that happens to
  // clear the number in front of it. Separate pins would let either be retuned
  // alone.
  assert.match(
    adr,
    phrase(
      "**Floor:** 20 deferrals filed across at least 3 distinct run dates after this decision lands. - **Trigger:** `needs-triage` still taking more than half of them.",
    ),
    "the ADR's guard floor or trigger moved — a pre-chosen guard that is retuned later is not a guard",
  );
  // The conflation this ADR exists to stop, pinned in both halves: the verdict
  // and the division of labour it rests on. Swapping `applied` and `labelled`
  // reds the second while the first stays green, so both are asserted.
  assert.match(
    adr,
    phrase("This decision **complements #211 and does not supersede it.**"),
    "the ADR no longer states that it complements #211 rather than superseding it",
  );
  assert.match(
    adr,
    phrase("#211 governs what gets **applied**; this governs what gets **labelled**"),
    "the ADR no longer separates #211's apply policy from this decision's label policy",
  );
});
