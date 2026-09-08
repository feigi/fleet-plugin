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
// HOW THIS FILE WAS WRONG THE FIRST TIME (PR #1122 review, dimensions
// `correctness` and `tests`, both reproduced by refuters). It pinned the duty as
// four word-presence checks — /tier\s+guard/, /phase\s+2/, /floor/,
// /accumulated/ — and banned two literal wordings. Measured GREEN against that:
// a sentence NEGATING the duty ("Do NOT run phase 2's tier guard here, on the
// floor phase 2 defines over the accumulated `…tsv` or otherwise"); one
// rescoping the floor to the run in front of the controller ("over this run's
// rows only rather than the accumulated `…tsv`"); phase 2's floor restated here
// in a one-word paraphrase; an incremental key phrased "after the most recent
// check"; and the counts "at least four", "more than three", "six or more" and
// "3+". Every one of those is a fixture below now — but the lesson is the shape,
// not the list: a presence check is satisfied by the sentence that repudiates
// it, and a wording ban catches the wording it was written from and nothing
// adjacent to it.
//
// So the duty is pinned as one wrap-tolerant PHRASE, and the two defect classes
// are banned structurally — any count, not any comparator.
//
// THE PHRASE PIN IS DELIBERATELY TIGHT. Reflowing the paragraph stays green (the
// accept test at the bottom flattens every wrap in the bullet and proves it);
// rewording the sentence does not. That clause is #528's whole deliverable, so a
// reword is exactly the moment someone should read this file. Reworded on
// purpose → update the string in DUTY. Do not delete the pin to clear the red.
//
// THE CEILING: this proves phase 3 defers to phase 2's floor. It cannot prove
// the floor itself is the right one — that lives in phase 2 and #528 left it
// deliberately untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Paragraph-tight, and bounded at both ends: widen this to the phase and the
// tier-guard prose living elsewhere in phase 3 satisfies the pins on its own.
// The start anchor is single-hit, so the slice cannot silently start elsewhere:
//   grep -c -- '- \*\*Pool empty\*\*' skills/run-team/SKILL.md → 1
const gate = (text = RUN_TEAM) =>
  between(text, "- **Pool empty**", "**Run the reconcile on the merge-side edges.", "run-team phase 3 pool-empty event");

// The duty as a phrase, not as the words it is built from. `phrase` puts `\s+`
// at every word gap, so a hard wrap landing anywhere inside it is fine, while
// any rewriting of the claim — negation, rescoping, restatement — is not.
const DUTY = phrase(
  "Run phase 2's tier guard here, on the floor phase 2 defines over the accumulated `docs/metrics/tier-outcomes.tsv` and on no gate of this event's own",
);
// DUTY pins the imperative with its leading capital, so a mid-sentence "…do not
// run phase 2's tier guard here" already fails it. This is the belt, for a
// negation that capitalises.
const NEGATED = /(?:\bnot|\bnever|n't)\s+run\b/i;

// A count of the step's own. Every threshold is a count, whatever comparator it
// wears — "at least three", "more than two", "six or more", "3+", "a further
// four" — so ban the numbers and not the wordings; enumerating comparators is
// what let four of those five through. Three spans in this bullet are counts of
// nothing and are removed before the check, and nothing else is exempt:
//   `phase N`            — how this step names the owner it defers to;
//   a backticked span    — a path or identifier (`tier-outcomes.tsv`, `run_date`);
//   "the one that/which" — the pronoun, as in "drift from the one that governs".
// CEILING: a count written inside backticks is exempt with them, and a threshold
// stated with no number at all ("once a handful have queued") is not covered by
// this or by any regex over prose.
const countable = (text) =>
  text
    .replace(/`[^`]*`/g, " ")
    .replace(/\bphase\s+\d+\b/gi, " ")
    .replace(/\bthe one\s+(?=that\b|which\b)/gi, " ");
const OWN_COUNT = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i;

// A set nothing persists. The literal that shipped was "since the last check";
// the shapes measured green against that literal were "since it was last
// checked" (words between the halves) and "after the most recent check" (a
// different preposition and a different recency word).
// CEILING: this covers a since/after clause reaching a recency word, and a
// "not yet <verb>ed" set. A recency set named without either — "the rows this
// run appended" — is caught only when it displaces DUTY, which is where the
// review's own within-run mutant was caught.
const UNPERSISTED_SET =
  /\b(?:since|after)\b[^.]{0,40}\b(?:last|previous|prior|earlier|latest|most\s+recent)\b|\bnot\s+yet\s+\w+ed\b/i;

// Every pin in one place, so a fixture can assert WHICH ones fire rather than
// that something somewhere went red — a pin that reddens on the wrong mutant has
// discriminated nothing.
const PINS = {
  duty: (slice) => !DUTY.test(slice),
  negation: (slice) => NEGATED.test(slice),
  count: (slice) => OWN_COUNT.test(countable(slice)),
  unpersisted: (slice) => UNPERSISTED_SET.test(slice),
};
const firing = (slice) => Object.keys(PINS).filter((name) => PINS[name](slice));

test("the pool-empty event dispatches phase 2's tier guard against phase 2's floor", () => {
  const slice = gate();
  // Positive control against a vacuous pin: a stale start anchor that matched an
  // empty slice would pass every doesNotMatch below while asserting nothing.
  assert.ok(slice.length > "- **Pool empty**".length, "the pool-empty slice is no longer than its anchor — the extractor is broken, not the docs");
  assert.match(slice, DUTY, "the pool-empty event no longer states, word for word, that it runs phase 2's tier guard on phase 2's accumulated floor and on no gate of its own — reworded on purpose? update DUTY. Do not delete it");
  assert.doesNotMatch(slice, NEGATED, "the pool-empty event now says NOT to run the guard it is the only step that dispatches");
});

test("the pool-empty gate states no count of its own", () => {
  // The drift direction: a second threshold here is a second definition, and
  // nothing makes the two move together.
  assert.doesNotMatch(countable(gate()), OWN_COUNT, "the pool-empty gate has grown a count of its own beside phase 2's floor");
});

test("the pool-empty gate keys on nothing that has to be remembered between runs", () => {
  assert.doesNotMatch(gate(), UNPERSISTED_SET, "the pool-empty gate names a set nothing on disk records");
});

// The refuse direction. Entry one is the sentence #528 actually removed; the
// rest are the shapes the PR #1122 review measured green against this file's
// first pins. Each mutation asserts it changed the document before it is scored,
// because a mutation that fails to apply is green in exactly the way a pin that
// does not bite is green — and this file's prose wraps, so every search here is
// a wrap-tolerant `phrase` rather than the line breaks it has today.
const append = (sentence) => (text) =>
  text.replace("- **Pool empty**", `- **Pool empty** ${sentence}\n- **Pool empty**`);
// Built with `phrase`, not written out with the wraps the file happens to have
// today: a fixture that hardcodes "\n  " applies nothing the moment someone
// reflows the paragraph, and its own notEqual guard then reddens a reflow the
// accept test at the bottom promises is green.
const PREDICATE_TAIL = phrase("on the floor phase 2 defines over the accumulated `docs/metrics/tier-outcomes.tsv` and on no gate of this event's own");
const IMPERATIVE = phrase("Run phase 2's tier guard here");

const mutants = [
  ["the incremental gate #528 removed comes back", ["count", "unpersisted"],
    append("→ run the guard once three or more `class=routine` PRs have been ruled since the last check.")],
  ["phase 2's floor is restated here in a paraphrase", ["duty", "count"],
    (text) => text.replace(PREDICATE_TAIL, "on the floor over the accumulated `docs/metrics/tier-outcomes.tsv`: it holds at least three `class=routine` PRs spanning two distinct `run_date`s")],
  ["the duty is negated outright", ["duty", "negation"],
    (text) => text.replace(IMPERATIVE, "Do NOT run phase 2's tier guard here")],
  ["the floor is rescoped to the run in front of the controller", ["duty"],
    (text) => text.replace(PREDICATE_TAIL, "on the floor phase 2 defines over this run's rows only rather than the accumulated `docs/metrics/tier-outcomes.tsv` it was written for")],
  ["an incremental key comes back in fresh wording", ["unpersisted"],
    append("Re-run it only for rows appended after the most recent check.")],
  ["a count no comparator list reaches", ["count"],
    append("Run it once six or more `class=routine` PRs have been ruled, or 3+ in a day.")],
];

for (const [what, expected, mutate] of mutants) {
  test(`the pins redden when ${what}`, () => {
    const mutated = mutate(RUN_TEAM);
    assert.notEqual(mutated, RUN_TEAM, `the "${what}" fixture no longer matches the bullet and applied nothing — update the fixture, do not delete it`);
    assert.deepEqual(firing(gate(mutated)), expected, `the "${what}" fixture did not fire exactly the pins it is here to exercise`);
  });
}

test("reflowing the bullet and editing it elsewhere stays green", () => {
  // The accept direction. A pin that reddens on any edit to the section has
  // discriminated nothing, and would be deleted by whoever next reflows this
  // paragraph. `between` returns raw text, so every pin above must tolerate a
  // line break landing anywhere in the prose it reads — this flattens all of
  // them at once — and `phase 1` must not read as a count.
  const bullet = gate();
  const benign = RUN_TEAM.replace(bullet, () =>
    bullet
      .replace(/\n {2}/g, " ")
      .replace("Nothing else in the loop owns it.", "Nothing else in the loop owns it. Re-enter phase 1 for each slot it opens."));
  assert.notEqual(benign, RUN_TEAM, "the benign-edit fixture no longer matches the bullet — update it");
  assert.deepEqual(firing(gate(benign)), [], "a reflow plus an unrelated edit reddened a pin — the pins are over-tight, not the docs wrong");
});
