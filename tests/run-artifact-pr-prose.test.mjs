// run-team's end-of-run metrics duty. The phase-2 tier-guard step tells the
// controller to produce files under `docs/metrics/` and says none commits
// itself; what it must also say is that the controller commits them and opens a
// PR, because habit alone strands them — three measured strandings, one shape:
// the artifacts ended up outside `main` behind a question nobody owned.
//
// The duty is generic: the plugin ships to repositories that have their own
// branch conventions, so the branch name is the repository's choice and the
// prose must not mandate one. (This repository's own convention lives in its
// AGENTS.md, which does not ship.) Two rules carry it, and this file pins both:
//
//   1. the controller commits the metrics files and opens a PR at end of run,
//      for a stated reason (a stranded data row is lost);
//   2. the branch name is the repository's choice — the plugin names no branch.
//
// WHY THE SLICE IS SECTION-TIGHT. A positive regex over a whole markdown
// document is a vacuous pin: this document says `docs/metrics/` in multiple
// other places, so a file-wide match is bought by prose that has nothing to do
// with the rule and survives the rule's deletion. Slice size is what anchors a
// prose pin. Both rules share one slice, the commit section of the close-out
// reference file, bounded by its own heading and the end of that file — the
// duty moved there from SKILL.md, and a heading bound is not one a rewrap can
// move.
//
// WHY EACH RULE HAS A BAN BESIDE ITS PHRASE. A presence check is satisfied by a
// sentence that repudiates it from elsewhere in the same slice, so the hazards
// that keep a phrase pin green while gutting the rule are banned structurally:
// a negated commit duty (rule 1), and a mandated branch name anywhere in the
// document (rule 2 — a negative pin, so it is never vacuous).
//
// THE CEILING: this proves the two rules are stated and not contradicted from
// inside their slice. It cannot prove a controller follows them, and it
// does not touch the `fleet-tick.mjs` backlog filter, which
// `fleet-tick-prose.test.mjs` and `fleet-tick.test.mjs` pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
// The commit duty and its reasons moved with the rest of the close-out metrics
// steps into the reference file. The document under test is that file,
// SKILL.md and references/invariants.md, and each mutant says which it edits.
const CLOSE_OUT = readFileSync(join(REPO, "skills", "run-team", "references", "close-out.md"), "utf8");
const INVARIANTS = readFileSync(join(REPO, "skills", "run-team", "references", "invariants.md"), "utf8");

// Rules 1 and 2 share one slice: the close-out file's whole commit section,
// which opens on the paragraph that says the metrics files are the run's own
// artifacts and none commits itself and ends at the end of the file. Taken by
// heading, never anchored on the text every deletion fixture replaces, for the
// reason that a thrown anchor on the mutant reads as "re-anchor this test" to
// whoever next deletes the rule instead of the pin reddening.
const ARTIFACT_HEADING = "## Commit the metrics files and open a PR";
// The body below the heading line, so a reflow of the slice cannot fold the
// heading into the paragraph that follows it.
const artifactRules = (text = CLOSE_OUT) => Pin.of(text, "close-out.md").section(ARTIFACT_HEADING, "run-team metrics-PR rules").text.split("\n").slice(1).join("\n");

// Each duty as a wrap-tolerant PHRASE, never as the words it is built from.
// `phrase` puts `\s+` at every word gap, so a hard wrap landing anywhere inside
// is fine while a negation, a rescoping or a restatement is not.
const COMMIT_DUTY = Pin.phrase("**Commit the metrics files and open a PR — at end of run.**");
// The belt for a negation that keeps the capital and so slips past COMMIT_DUTY's
// leading `Commit`. Scoped to this paragraph's own verbs. KNOWN GAP: the
// negation must sit immediately before the verb (`\s+`, nothing between) — one
// placed elsewhere in the sentence, semantically identical, evades this.
// Widening to scan the whole paragraph is unsafe: an undirected match would
// pair an unrelated "not" with a later "commit" and redden the correct
// document. See the "KNOWN GAP" test below the mutants loop.
const NO_COMMIT = /(?:\bnot|\bnever|n't)\s+(?:commit|open|push)\b/i;
// Why the duty exists: without it the duty reads as ceremony and the next
// editor deletes it as such.
const STRANDING_REASON = Pin.phrase("Stranding a data row loses it");
// Rule 2: the plugin leaves the branch to the repository.
const BRANCH_CHOICE = Pin.phrase("The branch name is the repository's choice");
// Rule 2's ban: this repository's own branch convention, mandated or even
// mentioned, anywhere in shipped prose.
const BRANCH_MANDATE = /chore\/run-artifacts/;

// Every pin in one place, so a fixture asserts WHICH pins fire rather than that
// something somewhere went red — a pin that reddens on the wrong mutant has
// discriminated nothing.
const DOC = { skill: RUN_TEAM, closeOut: CLOSE_OUT, invariants: INVARIANTS };
const PINS = {
  commit: (d) => !COMMIT_DUTY.test(artifactRules(d.closeOut)),
  noCommit: (d) => NO_COMMIT.test(artifactRules(d.closeOut)),
  reason: (d) => !STRANDING_REASON.test(artifactRules(d.closeOut)),
  branchChoice: (d) => !BRANCH_CHOICE.test(artifactRules(d.closeOut)),
  branchMandate: (d) => BRANCH_MANDATE.test(d.skill) || BRANCH_MANDATE.test(d.closeOut) || BRANCH_MANDATE.test(d.invariants),
};
const firing = (doc) => Object.keys(PINS).filter((name) => PINS[name](doc));
// The document with `edit` applied to the one file it names.
const withEdit = (target, edit) => ({ ...DOC, [target]: edit(DOC[target]) });

test("the metrics PR is a stated duty with a stated reason, not just an instruction to leave files in the checkout", () => {
  const slice = artifactRules();
  // Positive control against a vacuous pin: a stale bound matching an empty or
  // anchor-length slice would satisfy every doesNotMatch below while asserting
  // nothing.
  assert.ok(slice.length > 400, `the metrics-PR rules sliced down to ${slice.length} chars — the extractor is broken, not the docs`);
  assert.match(slice, COMMIT_DUTY, "the end-of-run step no longer tells the controller to commit the metrics files and open a PR");
  assert.match(slice, STRANDING_REASON, "the end-of-run step no longer says why a data row must not be left stranded");
  assert.doesNotMatch(slice, NO_COMMIT, "the metrics-PR rules now say NOT to commit or open the PR they exist to require");
});

test("the plugin leaves the metrics PR's branch name to the repository and mandates none", () => {
  assert.match(artifactRules(), BRANCH_CHOICE, "the end-of-run step no longer says the branch name is the repository's choice");
  assert.doesNotMatch(RUN_TEAM, BRANCH_MANDATE, "run-team prose names this repository's own metrics branch convention — that belongs in the repo's AGENTS.md, not the shipped plugin");
  assert.doesNotMatch(CLOSE_OUT, BRANCH_MANDATE, "the close-out reference names this repository's own metrics branch convention — that belongs in the repo's AGENTS.md, not the shipped plugin");
});

// The refuse direction. Every mutation asserts it changed the document before it
// is scored, because a mutation that fails to apply is green in exactly the way
// a pin that does not bite is green — and this prose hard-wraps, so every search
// here is a wrap-tolerant `phrase` rather than the line breaks the file happens
// to have today.
const appendTo = (anchor, sentence) => (text) => text.replace(anchor, (m) => `${m} ${sentence}`);

const mutants = [
  ["the commit duty is reduced to advice", ["commit"], "closeOut",
    (text) => text.replace(COMMIT_DUTY, "**Consider keeping the metrics files.**")],
  ["the commit duty is negated while keeping the lead's capital", ["commit", "noCommit"], "closeOut",
    (text) => text.replace(COMMIT_DUTY, "**Do not commit the metrics files and open a PR — at end of run.**")],
  ["the stranding reason is deleted", ["reason"], "closeOut",
    (text) => text.replace(STRANDING_REASON, "A data row is cheap")],
  ["the branch is left to the repository no longer", ["branchChoice"], "closeOut",
    (text) => text.replace(BRANCH_CHOICE, "The branch name is set by the fleet")],
  ["the branch name is mandated in the duty", ["branchChoice", "branchMandate"], "closeOut",
    (text) => text.replace(BRANCH_CHOICE, "The branch name is `chore/run-artifacts-<date>`")],
  ["this repository's branch name is mentioned elsewhere in the document", ["branchMandate"], "skill",
    (text) => `${text}\nSee chore/run-artifacts-<date>.\n`],
  ["this repository's branch name is mentioned in the close-out reference", ["branchMandate"], "closeOut",
    (text) => `${text}\nSee chore/run-artifacts-<date>.\n`],
  ["this repository's branch name is mentioned in the invariants reference", ["branchMandate"], "invariants",
    (text) => `${text}\nSee chore/run-artifacts-<date>.\n`],
];

for (const [what, expected, target, mutate] of mutants) {
  test(`the pins redden when ${what}`, () => {
    const doc = withEdit(target, mutate);
    assert.notEqual(doc[target], DOC[target], `the "${what}" fixture no longer matches the prose and applied nothing — update the fixture, do not delete it`);
    assert.deepEqual(firing(doc), expected, `the "${what}" fixture did not fire exactly the pins it is here to exercise`);
  });
}

// KNOWN GAP: NO_COMMIT only fires when the negation sits immediately before
// the verb (`\s+`, nothing between). A negation placed elsewhere in the same
// sentence, semantically identical, evades it. Documented here as an accepted
// limitation rather than left silently unpinned.
test("KNOWN GAP: a negation of the commit duty placed away from the verb evades NO_COMMIT", () => {
  const doc = withEdit("closeOut", appendTo(COMMIT_DUTY, "On reflection, don't actually do any of that."));
  assert.notEqual(doc.closeOut, DOC.closeOut, "the fixture no longer matches the prose — update it");
  assert.deepEqual(firing(doc), [], "NO_COMMIT now catches a non-adjacent negation — if intentional, narrow this comment/test rather than deleting them silently");
});

// The accept direction, and the half that decides whether these pins survive
// contact with an editor. A pin that reddens on any edit near the rule has
// discriminated nothing and gets deleted by whoever next reflows the paragraph.
// Both moves at once: the pinned slice is reflowed to one long line, AND an
// unpinned sentence inside it is reworded.
test("reflowing the slice and rewording an unpinned sentence inside it stays green", () => {
  // The reflow is the control that proves the pinned phrases are not bound to
  // the line breaks the file happens to have today. It flattens EVERY wrap in
  // the slice, blank lines included, which is a harsher edit than any real
  // rewrap and is the point.
  const rules = artifactRules();
  // The reword is the sentence that explains the rule, never the sentence that
  // states it.
  const closeOut = CLOSE_OUT.replace(rules, () => rules.replace(/\n/g, " "))
    .replace(Pin.phrase("is how it gets discarded by the next `git checkout` with nothing to show it ever ran"),
      "is how it gets lost at the next `git checkout`");
  assert.notEqual(closeOut, CLOSE_OUT, "the benign-edit fixture applied nothing to the close-out file — update it");
  assert.deepEqual(firing({ ...DOC, closeOut }), [], "a reflow plus an unrelated reword reddened a pin — the pins are over-tight, not the docs wrong");
});
