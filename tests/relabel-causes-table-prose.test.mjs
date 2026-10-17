// #3086's two implementer bail causes, `fixed` and `covered`, are rows of
// run-team/SKILL.md's *Implementer bails before implementing* table, which the
// controller acts by and the implementer bodies point at. `fleet-event.mjs
// impl-report` carries the same mapping in code and tests/fleet-event.test.mjs
// pins that; nothing read the table's own text, so a row could drift from the
// script it describes and every test stayed green.
//
// WHAT IS PINNED. For each of the two rows, one bounded phrase running cause
// through `bailCause` through `bailDetail` format, and for `fixed` the three
// `verify-sha.sh` answers, each bound to its action; for `covered`, its
// relabel. The `undecided`, `fork` and `hands` rows are out of scope here.
//
// THE SLICE. `relabelCauses()` bounds the table between its heading and the
// paragraph that follows it, so a copy of a row's text anywhere else in
// SKILL.md cannot satisfy a pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const RUN_TEAM = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"));

const relabelCauses = () => RUN_TEAM.between("### Relabel causes", "The call comments the cause", "Relabel causes table").text;

test("run-team/SKILL.md: the bail table's `fixed` row names its cause, its bailDetail format and the action for each verify-sha.sh answer", () => {
  const table = relabelCauses();
  assert.match(
    table,
    Pin.phrase("| already fixed on main | `fixed` | `<sha> — <how origin/main's tree meets the acceptance>` | `verify-sha.sh main <sha>` first."),
    "the `fixed` row no longer ties the already-fixed cause to `fixed`, its `<sha> — <how>` detail and a verify-sha.sh check first",
  );
  assert.match(
    table,
    Pin.phrase("Exit 0: close N with the `fixed` comment"),
    "verify-sha.sh exit 0 on a `fixed` bail no longer closes N with the `fixed` comment",
  );
  assert.match(
    table,
    Pin.phrase("Exit 1: relabel `needs-triage`, comment `<sha> not on origin/main`. Exit 2: `NEED`, N untouched."),
    "verify-sha.sh exit 1 no longer relabels `needs-triage`, or exit 2 no longer leaves N untouched behind a NEED",
  );
});

test("run-team/SKILL.md: the bail table's `covered` row names its cause, its bailDetail format and its relabel", () => {
  assert.match(
    relabelCauses(),
    Pin.phrase("| covered by an open PR M | `covered` | `PR#M — <how M's diff meets N's acceptance>` | relabel `ready-for-human` with the `covered` comment"),
    "the `covered` row no longer ties the open-PR cause to `covered`, its `PR#M — <how>` detail and a `ready-for-human` relabel",
  );
});
