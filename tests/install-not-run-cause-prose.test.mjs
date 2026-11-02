import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// An Install step that exits 126 or 127 did not run: the shell could not
// execute the command, or could not find it, and says nothing about why. The
// Recipe reader probed only the command's first word, and a path in it only
// against origin/main, so the tree's own change, a tree behind origin/main and
// a later word of the command can each produce the exit, and a re-derivation
// proves the same Recipe on origin/main again. installIn's message says so
// (evict.test.mjs and finisher-tree.test.mjs hold it); this file holds the
// prose around it, which called the exit a Recipe that no longer runs.
//
// Left as it was on purpose: claim-ticket.sh's own 126/127 refusal. The claim's
// tree is origin/main itself, so neither the tree's own change nor a tree
// behind origin/main can be the cause there, and the derivation, which runs all
// three commands on origin/main, is the remedy.
const ROOT = join(import.meta.dirname, "..");
const PLUGIN = join(ROOT, "plugin");
const EVICT = Pin.file(join(PLUGIN, "scripts", "evict.mjs"));
const FINISHER_TREE = Pin.file(join(PLUGIN, "scripts", "finisher-tree.mjs"));
const PHASE0 = Pin.file(join(PLUGIN, "skills", "run-team", "references", "phase-0.md"));
const ADR_0036 = Pin.file(join(ROOT, "docs", "adr", "0036-an-idle-claim-tree-is-evicted-its-dependencies-go-the-claim-stays.md"));

// The Recipe the text blames, which is no more at fault than the tree.
const BLAMES_THE_RECIPE = /Recipe that no longer runs|broken Recipe|Recipe cache is invalid/;

test("evict.mjs's restore paragraph says an exit 126 or 127 refuses as an Install step that did not run, its cause not established", () => {
  const text = EVICT.between("// RESTORE. `--restore <abs tree>`", "// That install sequence is `installIn()`", "evict.mjs's restore paragraph").stripGutter("//").text;
  assert.match(
    text,
    Pin.phrase("Exit 126 or 127 refuses as an Install step that did not run, its cause not established, any other non-zero as a failed install"),
    "evict.mjs's header no longer says what a restore's exit 126 or 127 is",
  );
  assert.match(
    text,
    Pin.phrase("each with the claim's own words, but for the 126 or 127, which names no cause"),
    "evict.mjs's header says the restore words an exit 126 or 127 as the claim does",
  );
  assert.doesNotMatch(text, BLAMES_THE_RECIPE, "evict.mjs's header blames the Recipe for an exit 126 or 127 again");
});

test("installIn's doc comment says its message is the claim's words but for an exit 126 or 127", () => {
  const doc = EVICT.runAbove("export function installIn", "evict.mjs's installIn doc comment", "*").text.replace(/^[ \t]*\*\/?[ \t]?/gm, "");
  assert.match(
    doc,
    Pin.phrase("`message` the claim's own words but for an exit 126 or 127, which names no cause"),
    "installIn's doc comment no longer says its message is the claim's own words except for an exit 126 or 127",
  );
});

test("REDERIVE's comment names the refusals that keep it, and an exit 126 or 127 is not one", () => {
  const comment = EVICT.runAbove("export const REDERIVE", "evict.mjs's REDERIVE comment").stripGutter("//").text;
  assert.match(
    comment,
    Pin.phrase("The refusals that send their reader to the derivation keep it: an Install step that could not be started and one that changed the tree. An exit 126 or 127 does not."),
    "the REDERIVE comment no longer says which refusals keep the claim's re-derive words",
  );
  assert.doesNotMatch(comment, /a restore refuses as the claim\s+does/, "the REDERIVE comment says a restore refuses as the claim does, though an exit 126 or 127 does not");
});

test("finisher-tree.mjs's header says an exit 126 or 127 is an Install step that did not run, its cause not established", () => {
  const text = FINISHER_TREE.between("//   3 The Install step, by evict.mjs's `installIn()`", "// Stdout is one JSON line", "finisher-tree.mjs's Install step paragraph").stripGutter("//").text;
  assert.match(
    text,
    Pin.phrase("126 or 127 is an Install step that did not run, its cause not established, any other non-zero exit a failed install"),
    "finisher-tree.mjs's header no longer says what an exit 126 or 127 is",
  );
  assert.doesNotMatch(text, BLAMES_THE_RECIPE, "finisher-tree.mjs's header blames the Recipe for an exit 126 or 127 again");
});

test("phase 0's restore paragraph says a restore refuses as a claim does except on an exit 126 or 127, which names no cause", () => {
  const p = PHASE0.paragraph("**An evicted tree is restored before a member runs code there.**", "phase-0.md's restore paragraph", "## Derive the Recipe").text;
  assert.match(
    p,
    Pin.phrase("It runs the Install step in the tree as a claim does and refuses as a claim does, except that an exit 126 or 127 names no cause."),
    "phase-0.md's restore paragraph says a restore refuses as a claim does on every exit",
  );
  assert.match(p, Pin.phrase("A refused restore leaves the tree evicted: dispatch nothing into it, report the restore's message"), "the restore paragraph no longer says what a refused restore does");
});

test("ADR 0036's Status line amends decision 6 for an exit 126 or 127, and decision 6 stands as ruled", () => {
  const status = ADR_0036.paragraph("**Status:**", "ADR 0036 Status", "## Context").text;
  assert.match(
    status,
    Pin.phrase("Amended by #4228: the restore no longer reports an Install step's exit 126/127 as a Recipe that no longer runs, as decision 6 below words it; that exit names no cause by itself."),
    "ADR 0036's Status line lost the amendment",
  );
  const six = ADR_0036.bullet("6. **Restore.**", "7. **Refusal at dispatch.**", "ADR 0036 decision 6").text;
  assert.match(
    six,
    Pin.phrase("refuses as the claim does: exit 126/127 as a Recipe that no longer runs, any other non-zero as a failed install"),
    "decision 6's body was rewritten, though the amendment is the Status line's",
  );
});
