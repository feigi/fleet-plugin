// #528. Phase 3's pool-empty event is the only place in the loop that dispatches
// phase 2's tier guard, so whatever it says the gate is IS the gate. It used to
// state one of its own — "once three or more `class=routine` PRs have been ruled
// since the last check" — which failed twice over: it is a second threshold
// beside phase 2's, free to drift from it, and it keys on a set nothing on disk
// records. A grep for any last-check marker over `skills` and `docs` returned
// only that sentence itself, and `docs/metrics/tier-outcomes.tsv` has no
// check-state column, so no controller could evaluate it and no marker would
// survive a compaction.
//
// The same document already ruled against this shape one phase earlier: the
// phase-2 guard rejects concluding inside one run and fires on the accumulated
// file instead. This pins phase 3 to that same floor.
//
// Both directions are pinned, because a presence-only pin over a markdown
// section is vacuous — the slice is what does the anchoring, and the mutant
// that matters here is not deletion but a threshold creeping back in. The
// refuse pins are therefore negative and the accept pin is a rewrap plus an
// unrelated edit, which must stay green.
//
// THE CEILING: this proves phase 3 defers to phase 2's floor. It cannot prove
// the floor itself is the right one — that lives in phase 2 and #528 left it
// deliberately untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// Paragraph-tight, and bounded at both ends: widen this to the phase and the
// tier-guard prose living elsewhere in phase 3 satisfies the pins on its own.
const gate = (text = RUN_TEAM) =>
  between(text, "- **Pool empty**", "**Run the reconcile on the merge-side edges.", "run-team phase 3 pool-empty event");

// A threshold of the step's own, in any of the shapes prose states one in. The
// gate the ticket removed opened "once three or more"; a restatement of phase
// 2's own numbers would be the same defect wearing the right numbers.
const OWN_THRESHOLD = /\b(?:one|two|three|four|five|ten|\d+)\s+or\s+more\b/i;
// A set nothing persists, named however. The literal that shipped was "since
// the last check"; "since the previous run" and "since an earlier check" are
// the same unenumerable set.
const UNPERSISTED_SET = /\bsince\s+(?:the\s+|an?\s+)?(?:last|previous|prior|earlier)\b/i;

test("the pool-empty event dispatches the tier guard against phase 2's floor", () => {
  const slice = gate();
  // Positive control against a vacuous pin: a stale start anchor that matched an
  // empty slice would pass every doesNotMatch below while asserting nothing.
  assert.ok(slice.length > "- **Pool empty**".length, "the pool-empty slice is no longer than its anchor — the extractor is broken, not the docs");
  assert.match(slice, /tier\s+guard/, "no phase 3 event dispatches the tier guard — it is stated in phase 2 and never reached");
  // Named by owner, not restated: one definition, in phase 2, and this step
  // points at it. Restating it here is what lets the two drift.
  assert.match(slice, /phase\s+2/, "the pool-empty gate no longer defers to phase 2 for the floor");
  assert.match(slice, /floor/, "the pool-empty gate no longer names the floor as what it reads");
  // The floor's defining half. Without this, "on phase 2's floor" survives a
  // rewrite that scopes it to the run in front of the controller — which is the
  // conclusion phase 2's guard exists to forbid.
  assert.match(slice, /accumulated/, "the pool-empty gate no longer reads the floor over the ACCUMULATED file");
});

test("the pool-empty gate states no threshold of its own", () => {
  // The drift direction: a second threshold here is a second definition, and
  // nothing makes the two move together.
  assert.doesNotMatch(gate(), OWN_THRESHOLD, "the pool-empty gate has grown a threshold of its own beside phase 2's");
});

test("the pool-empty gate keys on nothing that has to be remembered between runs", () => {
  assert.doesNotMatch(gate(), UNPERSISTED_SET, "the pool-empty gate names a set nothing on disk records");
});

test("the incremental gate reddens if it comes back", () => {
  // The refuse direction, built from the text that actually shipped rather than
  // from an invented mutant — this is the sentence #528 removed.
  const regressed = RUN_TEAM.replace(
    "- **Pool empty**",
    "- **Pool empty** → run the guard once three or more `class=routine` PRs have been ruled since the last check.\n- **Pool empty**",
  );
  assert.notEqual(regressed, RUN_TEAM, "the regression fixture no longer matches the bullet — update it");
  assert.match(gate(regressed), OWN_THRESHOLD);
  assert.match(gate(regressed), UNPERSISTED_SET);
});

test("rewrapping the bullet and editing it elsewhere stays green", () => {
  // The accept direction. A pin that reddens on any edit to the section has
  // discriminated nothing, and would be deleted by whoever next reflows this
  // paragraph. `between` returns raw text, so the pins above must tolerate a
  // line break landing anywhere in the prose they read.
  const benign = RUN_TEAM
    .replace("- **Pool empty** → phase 0 again, subject to queue depth.", "- **Pool empty**\n  → phase 0 again,\n  subject to queue depth. Re-enter phase 1 for each slot it opens.");
  assert.notEqual(benign, RUN_TEAM, "the benign-edit fixture no longer matches the bullet — update it");
  const slice = gate(benign);
  assert.match(slice, /tier\s+guard/);
  assert.match(slice, /phase\s+2/);
  assert.match(slice, /floor/);
  assert.match(slice, /accumulated/);
  assert.doesNotMatch(slice, OWN_THRESHOLD);
  assert.doesNotMatch(slice, UNPERSISTED_SET);
});
