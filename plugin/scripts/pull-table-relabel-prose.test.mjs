// #1804's Pull table (ADR 0013 Decision 2 and 4) states, for each verdict a
// Pull can reach, the one action that verdict takes — and for the three
// relabel rows, which of the two relabel-by-cause labels applies. Nothing
// tied a cause to its label: confirmed live, swapping `needs-triage` <->
// `ready-for-human` on the "brief names no *what*" row left every run-team
// prose test green, because no test read the table's own text at all.
//
// WHAT IS PINNED. The three relabel rows, each as one bounded phrase running
// cause through label through "next entry" — so a swap on any one row, in
// either direction, breaks its own row's pin and no other row's. Everything
// else the table states (the drop rows, the close row, the exclude rows, the
// taken row, the dispatch row) is out of scope for this file; a future file
// can add them the same way if they start drifting.
//
// THE SLICE ANCHOR IS WHAT ANCHORS. `pullTable()` bounds the table between its
// own opening sentence and the paragraph that follows it, never the whole
// document — a positive match over `RUN_TEAM` wholesale would be satisfiable
// from the "Relabel by cause" paragraph, which restates the
// same two labels in prose and would launder a table-row swap as a pass.
//
// MUTATION-TESTED. Swapping the label on the "brief names no *what*" row (the
// exploit three independent refuters used against #1804) reds this file's
// first assertion and no other; verified live before writing this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const pullTable = () =>
  between(
    RUN_TEAM,
    "**The Pull table**",
    "**The shortlist runs out",
    "run-team/SKILL.md Pull table",
  );

test("run-team/SKILL.md: the Pull table ties each relabel cause to its own label", () => {
  const table = pullTable();
  assert.match(
    table,
    phrase("| brief names no *what* | relabel `needs-triage`, next entry |"),
    "a brief that names no *what* no longer relabels to `needs-triage` in the Pull table",
  );
  assert.match(
    table,
    phrase("| genuine fork — options named, none ruled | relabel `ready-for-human`, next entry |"),
    "a genuine fork no longer relabels to `ready-for-human` in the Pull table",
  );
  assert.match(
    table,
    phrase(
      "| needs human hands — external access, manual testing, judgment during the work | relabel `ready-for-human`, next entry |",
    ),
    "needing human hands no longer relabels to `ready-for-human` in the Pull table",
  );
});
