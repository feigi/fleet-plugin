import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Implementers dispatch at `sonnet` unless the ticket is a correction ticket.
// The rule is prose in one file and rots the expensive way: drop the phase-0
// class judgement and phase 2 has nothing to read, so every member silently
// inherits the session's top tier again — no error, no red test, just the bill.
// Drop the guard instead and the first bad wave gets reverted wholesale rather
// than per class, which is how a saving that worked for four ticket classes
// gets thrown away over one.
//
// Slice by named anchors and fail loudly when one moves; slice size is what
// does the anchoring. `section()` is duplicated from
// review-path-default.test.mjs rather than shared — two callers, seven lines.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

function section(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const end = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, `${label}: '${endAnchor}' moved — update this test`);
  return source.slice(at, end);
}

// Step 4 only, never the whole phase: the dispatch rule in phase 2 names both
// tiers too, and a file-wide slice stays green with the classification deleted.
const step4 = () =>
  section(RUN_TEAM, "4. **Read each survivor in full", "5. **Collision scan", "run-team phase 0 step 4");
const phase2 = () => section(RUN_TEAM, "## Phase 2", "## Phase 3", "run-team phase 2");

test("phase 0 step 4 classifies each survivor by ticket class, in the read it already pays for", () => {
  const slice = step4();
  // The class name is the criterion's handle — phase 2 and the ledger both
  // spell it. Without it the "everything else" branch has no complement.
  assert.match(slice, /correction ticket/i, "step 4 no longer names the correction-ticket class");
  // The criterion, not the label: what makes a ticket a correction ticket has
  // to be checkable by the controller reading the issue, or the class is a
  // coin flip. A bare /correction ticket/ passes with the criterion deleted.
  // Not /docs|comments/ — this slice opens with `--json title,body,comments`,
  // so either alternative is green with the criterion gone.
  assert.match(
    slice,
    /bad citations/,
    "step 4 names the class but not what puts a ticket in it",
  );
  assert.match(
    slice,
    /sonnet/,
    "step 4 no longer records the model the non-correction classes dispatch at",
  );
});

test("phase 2 dispatches on the recorded class — sonnet by default, inherited top tier for corrections", () => {
  const slice = phase2();
  assert.match(
    slice,
    /model: "sonnet"/,
    "phase 2 no longer passes `model: \"sonnet\"` on the Agent call for the default class",
  );
  // Anchored to the omission, not the word "inherit": the correction class gets
  // top tier by NOT passing `model`, and "correction tickets run at top tier"
  // with no mechanism is exactly the instruction-names-no-mechanism defect the
  // skill's own tooling-fix triggers list calls out.
  assert.match(
    slice,
    /omit\s+`?model`?/i,
    "phase 2 no longer says HOW a correction ticket gets top tier — omitting `model` is the mechanism",
  );
  // Written before dispatch like every other ledger field, or a compacted
  // controller cannot tell which wave ran at which tier — and the guard below
  // compares waves.
  // `/ledger/i` alone is satisfied by any passing mention of `ledger.mjs`; the
  // obligation is the CLASS reaching the row, so pin both halves.
  assert.match(slice, /ledger row/, "phase 2 no longer writes the ticket's class to the ledger row");
  assert.match(
    slice,
    /class=/,
    "the ledger row no longer carries the class — after a compaction nothing records which wave ran at which tier",
  );
});

test("phase 2 carries the guard: measure the wave, revert per class", () => {
  const slice = phase2();
  // Name the tool, not "measure the spend" — the rollup exists and a guard that
  // does not say which one reads as advice.
  assert.match(
    slice,
    /compute-spend|board\.mjs/,
    "the guard no longer names the spend rollup that measures the wave",
  );
  // Findings/fix-rounds are the counter-signal: review runs 3-5x implementation,
  // so extra fix-rounds are what would eat the saving. A guard on spend alone
  // measures the wrong side.
  assert.match(
    slice,
    /findings|fix-round/i,
    "the guard measures spend without the finding/fix-round count that would eat the saving",
  );
  // The revert UNIT. `/revert/` alone stays green through "revert the rule",
  // which is the wholesale revert this sentence exists to forbid.
  assert.match(
    slice,
    /per class|that class|not wholesale/i,
    "the guard no longer scopes the revert to the affected class",
  );
});
