// run-team's end-of-run metrics duty. The phase-2 tier-guard step tells the
// controller to produce files under `docs/metrics/` and says none commits
// itself; what it must also say is that the controller commits them and opens a
// PR, because habit alone strands them — three measured strandings, one shape:
// the artifacts ended up outside `main` behind a question nobody owned.
//
// The duty is generic: the plugin ships to repositories that have their own
// branch conventions, so the branch name is the repository's choice and the
// prose must not mandate one. (This repository's own convention lives in its
// AGENTS.md, which does not ship.) Three rules carry it, and this file pins all
// three:
//
//   1. the controller commits the metrics files and opens a PR at end of run,
//      for a stated reason (a stranded data row is lost);
//   2. the branch name is the repository's choice — the plugin names no branch;
//   3. the `ready-to-merge`-by-reviewer-only invariant does not reach a
//      controller-authored metrics PR, stated in that invariant's own bullet so
//      the next controller does not re-derive a blocker from it.
//
// WHY THE SLICES ARE PARAGRAPH- AND BULLET-TIGHT. A positive regex over a whole
// markdown section is a vacuous pin: this document says `docs/metrics/` in
// multiple other places, so a file-wide match is bought by prose that has
// nothing to do with the rule and survives the rule's deletion. Slice size is
// what anchors a prose pin. Rules 1 and 2 share one slice bounded by two
// landmark phrases — the sentence that introduces them and the next unrelated
// bolded lead — never `paragraph`'s blank-line bound. Rule 3 lives in a list
// item with no blank line before the next one, so it is bounded by its own
// landmark phrase and cut at the next top-level bullet (`\n- `), built from the
// same `anchorAt` uniqueness check rather than a local copy of `paragraph`'s
// slicer — the shape `quiet-payload-prose.test.mjs` already uses for an end
// bound that is not a blank line.
//
// WHY EACH RULE HAS A BAN BESIDE ITS PHRASE. A presence check is satisfied by a
// sentence that repudiates it from elsewhere in the same slice, so the hazards
// that keep a phrase pin green while gutting the rule are banned structurally:
// a negated commit duty (rule 1), a mandated branch name anywhere in the
// document (rule 2 — a negative pin, so it is never vacuous), and a reviewer
// requirement on the controller's own metrics PR (rule 3).
//
// THE ONE REGEX THIS FILE MUST NOT HAVE is a bare /is not exempt/ for rule 3's
// inversion. The invariant's own tail says "a PR is not exempt from being
// wrong" — the true half that keeps the exemption narrow, settled by phase 0's
// fold-in — so that regex reds the correct document. The inversion is caught
// by the phrase pin instead, and the fixture for it is below.
//
// THE CEILING: this proves the three rules are stated and not contradicted from
// inside their own slices. It cannot prove a controller follows them, and it
// does not touch the `fleet-tick.mjs` backlog filter, which
// `fleet-tick-prose.test.mjs` and `fleet-tick.test.mjs` pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Rules 1 and 2 share one slice, bounded by two landmarks NEITHER rule owns:
// the sentence that introduces them and the bolded lead of the next unrelated
// paragraph. Anchoring each rule on its OWN bolded lead, the obvious shape,
// puts the slice anchor inside the text every deletion fixture replaces:
// `betweenPhrases` THROWS on the mutant instead of the pin reddening, which is
// not a pin discriminating, it is the harness losing its footing — and a thrown
// anchor reads as "re-anchor this test" to whoever next deletes the rule.
//
// Both bounds go through `phrase`, so a reflow of either cannot move them, and
// both are proven single-hit by `betweenPhrases`' exactly-once guard.
const ARTIFACT_FROM = "The metrics files are the run's own artifacts and none commits itself";
const ARTIFACT_TO = "**Why not decide inside one run.**";
const artifactRules = (text = RUN_TEAM) => Pin.of(text, "text").betweenPhrases(ARTIFACT_FROM, ARTIFACT_TO, "run-team metrics-PR rules").text;

// Rule 3's bullet under `## Invariants`, bounded at the next top-level list
// item. Not `paragraph`: the bullets are adjacent, so a blank-line bound would
// swallow the rest of the section and every pin below would be satisfiable from
// a neighbouring invariant. Continuation lines are indented, so `\n- ` is the
// item boundary and cannot match inside the item itself.
const invariant = (text = RUN_TEAM) => {
  const what = "run-team ready-to-merge invariant";
  const rest = text.slice(Pin.of(text, "text").anchorAt("`ready-to-merge` is added by a reviewer only", what));
  const end = rest.search(/\n- /);
  return end === -1 ? rest : rest.slice(0, end);
};

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

const EXEMPT_DUTY = Pin.phrase("The run's own artifact PR is exempt, and it is exempt because this invariant does not reach it");
// The positive duty the exemption exists to license. A slice that states the
// exemption and then withholds the action is a rule nobody can act on.
const LABEL_DUTY = Pin.phrase("Label and merge that one yourself");
// A reviewer requirement re-imposed on the controller's own metrics PR. Must
// not collide with the bullet's true tail, which sends a LEFTOVER metrics PR
// into the next run's review queue on purpose: that clause says "review queue",
// never that this run's PR needs a review or a reviewer first. Three more
// alternations catch phrasing the keyword list above misses: passive "must
// still be reviewed", "reviewed first/before", and approve/sign-off language —
// none of which collide with "review queue" either.
const NEEDS_REVIEW =
  /\b(?:needs?|requires?|await|awaits|wait\s+for|must\s+(?:get|have|obtain))\b[\s\S]{0,60}\b(?:reviewer|review-pr|a\s+review)\b|\b(?:must|has\s+to|needs?\s+to|should)\b[\s\S]{0,40}\bbe\s+review|\breview(?:ed)?\s+(?:first|before)\b|\b(?:approve[ds]?|approval|sign(?:ed)?[- ]off)\b/i;

// The sentences of `slice` a fault pattern matches. NEEDS_REVIEW is NEGATIVE — a
// match is the failure — so a window cut short is its silent direction, and a
// first-period `[^.]` gap cut one short at every "e.g.", `SKILL.md` or `v1.2`
// between the need word and the review word. The gap tolerates a period now,
// and the SENTENCE, from `sentences()`, is what bounds it: widened over the raw
// slice instead, the gap would pair a modal in one sentence with a verb in the
// next.
const faults = (pattern, slice) => Pin.sentences(slice).filter((s) => pattern.test(s));

// Every pin in one place, so a fixture asserts WHICH pins fire rather than that
// something somewhere went red — a pin that reddens on the wrong mutant has
// discriminated nothing.
const PINS = {
  commit: (t) => !COMMIT_DUTY.test(artifactRules(t)),
  noCommit: (t) => NO_COMMIT.test(artifactRules(t)),
  reason: (t) => !STRANDING_REASON.test(artifactRules(t)),
  branchChoice: (t) => !BRANCH_CHOICE.test(artifactRules(t)),
  branchMandate: (t) => BRANCH_MANDATE.test(t),
  exempt: (t) => !EXEMPT_DUTY.test(invariant(t)),
  label: (t) => !LABEL_DUTY.test(invariant(t)),
  needsReview: (t) => faults(NEEDS_REVIEW, invariant(t)).length > 0,
};
const firing = (text) => Object.keys(PINS).filter((name) => PINS[name](text));

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
});

test("the ready-to-merge invariant states its own metrics-PR exemption", () => {
  const slice = invariant();
  assert.ok(slice.length > 200, `the ready-to-merge invariant sliced down to ${slice.length} chars — the extractor is broken, not the docs`);
  assert.match(slice, EXEMPT_DUTY, "the `ready-to-merge` invariant no longer says the run's own artifact PR is outside it, which is the blocker #619 re-derived");
  assert.match(slice, LABEL_DUTY, "the exemption no longer tells the controller to label and merge that PR itself, so it licenses nothing");
  assert.deepEqual(faults(NEEDS_REVIEW, slice), [], "the invariant re-imposes a reviewer on the controller's own metrics PR");
});

test("the invariant slice stops at its own bullet", () => {
  // The bound is the pin. Widened to the section, the neighbouring invariants
  // would satisfy a phrase pin on their own and the exemption could be deleted
  // green.
  const slice = invariant();
  assert.ok(slice.startsWith("`ready-to-merge` is added by a reviewer only"), "the invariant slice no longer starts at its own bullet");
  assert.doesNotMatch(slice, /Every member acts through the maintainer/, "the invariant slice ran past its bullet into the next one");
});

// The refuse direction. Every mutation asserts it changed the document before it
// is scored, because a mutation that fails to apply is green in exactly the way
// a pin that does not bite is green — and this prose hard-wraps, so every search
// here is a wrap-tolerant `phrase` rather than the line breaks the file happens
// to have today.
const EXEMPT_TAIL = Pin.phrase("is exempt, and it is exempt because this invariant does not reach it");
const appendTo = (anchor, sentence) => (text) => text.replace(anchor, (m) => `${m} ${sentence}`);

const mutants = [
  ["the commit duty is reduced to advice", ["commit"],
    (text) => text.replace(COMMIT_DUTY, "**Consider keeping the metrics files.**")],
  ["the commit duty is negated while keeping the lead's capital", ["commit", "noCommit"],
    (text) => text.replace(COMMIT_DUTY, "**Do not commit the metrics files and open a PR — at end of run.**")],
  ["the stranding reason is deleted", ["reason"],
    (text) => text.replace(STRANDING_REASON, "A data row is cheap")],
  ["the branch is left to the repository no longer", ["branchChoice"],
    (text) => text.replace(BRANCH_CHOICE, "The branch name is set by the fleet")],
  ["the branch name is mandated in the duty", ["branchChoice", "branchMandate"],
    (text) => text.replace(BRANCH_CHOICE, "The branch name is `chore/run-artifacts-<date>`")],
  ["this repository's branch name is mentioned elsewhere in the document", ["branchMandate"],
    (text) => `${text}\nSee chore/run-artifacts-<date>.\n`],
  ["the exemption is removed from the invariant", ["exempt"],
    (text) => text.replace(EXEMPT_TAIL, "is no different, and this invariant reaches it like any other")],
  ["the exemption is inverted rather than removed", ["exempt"],
    (text) => text.replace(EXEMPT_TAIL, "is not exempt, and this invariant reaches it too")],
  ["the exemption is stated but the action it licenses is withheld", ["label"],
    (text) => text.replace(LABEL_DUTY, "Leave that one unlabelled for the maintainer")],
  ["a reviewer is re-imposed on the run's own metrics PR", ["needsReview"],
    appendTo(LABEL_DUTY, "It still needs a reviewer before the label goes on.")],
  ["a reviewer is re-imposed on the run's own metrics PR via passive phrasing NEEDS_REVIEW's old keyword list missed", ["needsReview"],
    appendTo(LABEL_DUTY, "It must still be reviewed before the label goes on.")],
  // A period in the gap — an abbreviation, a filename — ended the old `[^.]`
  // window before the review word, and each of these was green.
  ["a reviewer is re-imposed with an abbreviation between the need and the reviewer", ["needsReview"],
    appendTo(LABEL_DUTY, "It still needs, i.e. before the label goes on, a reviewer.")],
  ["a reviewer is re-imposed passively with a filename in the gap", ["needsReview"],
    appendTo(LABEL_DUTY, "It must, per SKILL.md, still be reviewed.")],
];

for (const [what, expected, mutate] of mutants) {
  test(`the pins redden when ${what}`, () => {
    const mutated = mutate(RUN_TEAM);
    assert.notEqual(mutated, RUN_TEAM, `the "${what}" fixture no longer matches the prose and applied nothing — update the fixture, do not delete it`);
    assert.deepEqual(firing(mutated), expected, `the "${what}" fixture did not fire exactly the pins it is here to exercise`);
  });
}

// The accept half of the period-tolerant gap: it tolerates a period now, so the
// SENTENCE is all that keeps a need word in one sentence from pairing with a
// review word in the next. The fixture is benign and reds the moment the scan
// reads the raw slice instead of `sentences()`.
test("a need word in one sentence does not pair with the next sentence's review word", () => {
  const mutated = appendTo(Pin.phrase("stranding the rows behind it."), "Nothing here needs one. A reviewer is for ticket work.")(RUN_TEAM);
  assert.notEqual(mutated, RUN_TEAM, "an accept fixture no longer matches the prose and applied nothing — update it");
  assert.deepEqual(firing(mutated), [], "a need word paired with a word in the NEXT sentence");
});

// KNOWN GAP: NO_COMMIT only fires when the negation sits immediately before
// the verb (`\s+`, nothing between). A negation placed elsewhere in the same
// sentence, semantically identical, evades it. Documented here as an accepted
// limitation rather than left silently unpinned.
test("KNOWN GAP: a negation of the commit duty placed away from the verb evades NO_COMMIT", () => {
  const mutated = appendTo(COMMIT_DUTY, "On reflection, don't actually do any of that.")(RUN_TEAM);
  assert.notEqual(mutated, RUN_TEAM, "the fixture no longer matches the prose — update it");
  assert.deepEqual(firing(mutated), [], "NO_COMMIT now catches a non-adjacent negation — if intentional, narrow this comment/test rather than deleting them silently");
});

// The accept direction, and the half that decides whether these pins survive
// contact with an editor. A pin that reddens on any edit near the rule has
// discriminated nothing and gets deleted by whoever next reflows the paragraph.
// Both moves at once: every pinned slice is reflowed to one long line, AND an
// unpinned sentence inside each slice is reworded.
test("reflowing both slices and rewording unpinned sentences inside them stays green", () => {
  // The reflow is the control that proves the pinned phrases are not bound to
  // the line breaks the file happens to have today. It flattens EVERY wrap in
  // the slice, blank lines included, which is a harsher edit than any real
  // rewrap and is the point.
  const rules = artifactRules();
  let benign = RUN_TEAM.replace(rules, () => rules.replace(/\n/g, " "));
  const bullet = invariant();
  benign = benign.replace(bullet, () => bullet.replace(/\n {2}/g, " "));
  // Two unrelated rewords: one inside the metrics-PR slice and one inside the
  // invariant slice — the sentence that explains the rule, never the sentence
  // that states it.
  benign = benign
    .replace(Pin.phrase("is how it gets discarded by the next `git checkout` with nothing to show it ever ran"),
      "is how it gets lost at the next `git checkout`")
    .replace(Pin.phrase("stranding the rows behind it"), "rather than leaving the rows stranded behind a question nobody owns");
  assert.notEqual(benign, RUN_TEAM, "the benign-edit fixture applied nothing — update it");
  assert.deepEqual(firing(benign), [], "a reflow plus unrelated rewords reddened a pin — the pins are over-tight, not the docs wrong");
});
