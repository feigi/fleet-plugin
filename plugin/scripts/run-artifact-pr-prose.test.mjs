// #944. run-team's phase-2 tier-guard step tells the controller to produce two
// files under `docs/metrics/` and said only that neither commits itself. What it
// never said was where they go: `grep -niE 'run-artifacts|tier-rows|chore/'
// plugin/skills/run-team/SKILL.md` returned nothing before this ticket, so the
// branch convention every close-out has actually used existed on controller
// habit alone — and habit strands things. Three measured strandings, one shape:
// the artifacts ended up outside `main` behind a question nobody owned.
//
// Three rules now carry it, and this file pins all three. None is a new
// decision; each is settled by prose already in the same document, which is why
// each pin below cites where it is settled rather than asserting it fresh:
//
//   1. the branch is `chore/run-artifacts-<date>` — the shape phase 0's own
//      fast-forward step already tells the next controller to look for ("the
//      PREVIOUS run's own close-out PR: it lands the rules THIS run needs");
//   2. data rows and rule-doc prose never share a PR, and the data branch
//      carries the two `docs/metrics/` files and nothing else — the load-bearing
//      one, because the two halves have opposite cost profiles and bundling
//      makes the cheap-to-strand half gate the expensive one;
//   3. the `ready-to-merge`-by-reviewer-only invariant does not reach a
//      controller-authored artifact PR, stated in that invariant's own bullet so
//      the next controller does not re-derive a blocker from it.
//
// WHY THE SLICES ARE PARAGRAPH- AND BULLET-TIGHT. A positive regex over a whole
// markdown section is a vacuous pin: this document says "chore PR" in phase 0
// and again under `## Queue depth`, and it says `docs/metrics/tier-outcomes.tsv`
// in five places, so a file-wide match is bought by prose that has nothing to do
// with the rule and survives the rule's deletion. Slice size is what anchors a
// prose pin. Rules 1 and 2 get `paragraph` (blank-line bound); rule 3 lives in a
// list item with no blank line before the next one, so it gets a bullet bound
// built from the same `anchorAt` uniqueness check rather than a local copy of
// `paragraph`'s slicer — the shape `quiet-payload-prose.test.mjs` already uses
// for an end bound that is not a blank line.
//
// WHY EACH RULE HAS A BAN BESIDE ITS PHRASE. A presence check is satisfied by a
// sentence that repudiates it from elsewhere in the same slice, so the three
// hazards that keep a phrase pin green while gutting the rule are banned
// structurally: permission to bundle (rule 2), a reviewer requirement on the
// controller's own artifact PR (rule 3), and a negated commit duty (rule 1).
//
// THE ONE REGEX THIS FILE MUST NOT HAVE is a bare /is not exempt/ for rule 3's
// inversion. The invariant's own tail says "a chore PR is not exempt from being
// wrong" — the true half that keeps the exemption narrow, settled by phase 0's
// step 0 (#1222, #1237) — so that regex reds the correct document. The inversion
// is caught by the phrase pin instead, and the fixture for it is below.
//
// THE CEILING: this proves the three rules are stated and not contradicted from
// inside their own slices. It cannot prove a controller follows them, and it
// does not touch rule 3-of-the-ticket, the `fleet-tick.mjs` backlog filter —
// that one was already implemented, already pinned by "CLI: a PR that closes no
// issue is not review backlog (#590)" in `fleet-tick.test.mjs`, and needed no
// change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorAt, paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Rules 1 and 2 share one slice, bounded by two landmarks NEITHER rule owns:
// the sentence that introduces them (which #944 did not write — it already said
// the files do not commit themselves and stopped there) and the bolded lead of
// the next unrelated paragraph. This is deliberate and it is the second thing
// this file got wrong. Anchoring each rule on its OWN bolded lead, the obvious
// shape, puts the slice anchor inside the text every deletion fixture replaces:
// `anchorAt` then THROWS on the mutant instead of the pin reddening, which is
// not a pin discriminating, it is the harness losing its footing — and a thrown
// anchor reads as "re-anchor this test" to whoever next deletes the rule.
//
// Both bounds go through `phrase`, so a reflow of either cannot move them, and
// both are proven single-hit:
//   grep -cF "Both files are the run's own artifacts and neither commits itself" → 1
//   grep -cF '**Why not decide inside one run.**'                                → 1
//
// The cost of one slice for two rules is the fat-slice hazard: rule 2's
// paragraph could in principle satisfy a pin on rule 1. That is not left to
// judgement — the "branch name is dropped" and "split rule is deleted" fixtures
// below each red exactly one pin, which is what proves the two rules are pinned
// separately inside a shared bound.
const ARTIFACT_FROM = "Both files are the run's own artifacts and neither commits itself";
const ARTIFACT_TO = phrase("**Why not decide inside one run.**");
const artifactRules = (text = RUN_TEAM) => {
  const what = "run-team artifact-PR rules";
  const rest = text.slice(anchorAt(text, ARTIFACT_FROM, what));
  const end = rest.search(ARTIFACT_TO);
  assert.notEqual(end, -1, `${what}: the paragraph after the artifact-PR rules moved — re-anchor this test, never widen it to the whole file`);
  return rest.slice(0, end);
};

// Rule 3's bullet under `## Invariants`, bounded at the next top-level list
// item. Not `paragraph`: the bullets are adjacent, so a blank-line bound would
// swallow the rest of the section and every pin below would be satisfiable from
// a neighbouring invariant. Continuation lines are indented, so `\n- ` is the
// item boundary and cannot match inside the item itself. The anchor here is the
// invariant's original sentence, which #944 left untouched and no fixture below
// rewrites — the same stability the artifact bounds above are chosen for.
const invariant = (text = RUN_TEAM) => {
  const what = "run-team ready-to-merge invariant";
  const rest = text.slice(anchorAt(text, "`ready-to-merge` is added by a reviewer only", what));
  const end = rest.search(/\n- /);
  return end === -1 ? rest : rest.slice(0, end);
};

// Each duty as a wrap-tolerant PHRASE, never as the words it is built from.
// `phrase` puts `\s+` at every word gap, so a hard wrap landing anywhere inside
// is fine while a negation, a rescoping or a restatement is not.
//
// BRANCH_DUTY deliberately carries the branch name INSIDE the pinned phrase.
// The imperative alone ("commit both and open a PR") is the part that was
// already true in spirit and is not what #944 fixed; the NAME is the
// deliverable, because a close-out PR the next controller cannot find by shape
// is the stranding this rule ends.
const BRANCH_DUTY = phrase("Commit both to `chore/run-artifacts-<date>` and open a PR");
// The belt for a negation that keeps the capital and so slips past BRANCH_DUTY's
// leading `Commit`. Scoped to this paragraph's own verbs.
const NO_COMMIT = /(?:\bnot|\bnever|n't)\s+(?:commit|open|push)\b/i;

const SPLIT_DUTY = phrase("Data rows and rule-doc prose never share a PR — one branch each");
// Rule 2's operative half: what the data branch is allowed to carry. Without
// this, "never share a PR" survives while the branch quietly grows a prose
// exception, which is exactly the bundling the rule forbids.
const ONLY_METRICS = phrase("carries the two `docs/metrics/` files and nothing else");
// Permission to bundle, however it is spelled. Bans the modal reaching a
// sharing verb rather than a list of wordings — enumerating wordings catches the
// one it was written from and nothing adjacent. `own PR`/`own branch` are the
// rule's own words for the opposite arrangement and are not modals, so they do
// not collide.
const MAY_BUNDLE = /\b(?:may|can|could|might)\b[^.]{0,60}\b(?:share|bundle|bundled|accompany|travel|ride)\b/i;

const EXEMPT_DUTY = phrase("The run's own artifact PR is exempt, and it is exempt because this invariant does not reach it");
// The positive duty the exemption exists to license. A slice that states the
// exemption and then withholds the action is a rule nobody can act on.
const LABEL_DUTY = phrase("Label and merge that one yourself");
// A reviewer requirement re-imposed on the controller's own artifact PR. Must
// not collide with the bullet's true tail, which sends a LEFTOVER artifact PR
// into the next run's review queue on purpose: that clause says "review queue",
// never that this run's PR needs a review or a reviewer first.
const NEEDS_REVIEW =
  /\b(?:needs?|requires?|await|awaits|wait\s+for|must\s+(?:get|have|obtain))\b[^.]{0,60}\b(?:reviewer|review-pr|a\s+review)\b/i;

// Every pin in one place, so a fixture asserts WHICH pins fire rather than that
// something somewhere went red — a pin that reddens on the wrong mutant has
// discriminated nothing.
const PINS = {
  branch: (t) => !BRANCH_DUTY.test(artifactRules(t)),
  noCommit: (t) => NO_COMMIT.test(artifactRules(t)),
  split: (t) => !SPLIT_DUTY.test(artifactRules(t)),
  onlyMetrics: (t) => !ONLY_METRICS.test(artifactRules(t)),
  mayBundle: (t) => MAY_BUNDLE.test(artifactRules(t)),
  exempt: (t) => !EXEMPT_DUTY.test(invariant(t)),
  label: (t) => !LABEL_DUTY.test(invariant(t)),
  needsReview: (t) => NEEDS_REVIEW.test(invariant(t)),
};
const firing = (text) => Object.keys(PINS).filter((name) => PINS[name](text));

test("the artifact PR gets a branch name, not just an instruction to commit", () => {
  const slice = artifactRules();
  // Positive control against a vacuous pin: a stale bound matching an empty or
  // anchor-length slice would satisfy every doesNotMatch below while asserting
  // nothing.
  assert.ok(slice.length > 400, `the artifact-PR rules sliced down to ${slice.length} chars — the extractor is broken, not the docs`);
  assert.match(slice, BRANCH_DUTY, "the phase-2 step no longer names `chore/run-artifacts-<date>` as the branch both metrics files go to — renamed the convention on purpose? update BRANCH_DUTY. Do not delete it");
  assert.doesNotMatch(slice, NO_COMMIT, "the artifact-PR rules now say NOT to commit or open the PR they exist to require");
});

test("data rows and rule-doc prose are kept to separate PRs, and the data branch to the metrics files", () => {
  const slice = artifactRules();
  assert.match(slice, SPLIT_DUTY, "the load-bearing rule — data rows and rule-doc prose never share a PR — is no longer stated word for word");
  assert.match(slice, ONLY_METRICS, "the artifact branch is no longer scoped to the two `docs/metrics/` files, so 'never share a PR' has nothing left to bite on");
  assert.doesNotMatch(slice, MAY_BUNDLE, "the split rule now licenses the bundling it forbids");
});

test("the ready-to-merge invariant states its own artifact-PR exemption", () => {
  const slice = invariant();
  assert.ok(slice.length > 200, `the ready-to-merge invariant sliced down to ${slice.length} chars — the extractor is broken, not the docs`);
  assert.match(slice, EXEMPT_DUTY, "the `ready-to-merge` invariant no longer says the run's own artifact PR is outside it, which is the blocker #619 re-derived");
  assert.match(slice, LABEL_DUTY, "the exemption no longer tells the controller to label and merge that PR itself, so it licenses nothing");
  assert.doesNotMatch(slice, NEEDS_REVIEW, "the invariant re-imposes a reviewer on the controller's own artifact PR");
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
const BRANCH_TAIL = phrase("`chore/run-artifacts-<date>` and open a PR");
const EXEMPT_TAIL = phrase("is exempt, and it is exempt because this invariant does not reach it");
const RULE_CHANGE_COST = phrase("Stranding a rule change costs the status quo, which is where it already was.");
const appendTo = (anchor, sentence) => (text) => text.replace(anchor, (m) => `${m} ${sentence}`);

const mutants = [
  ["the branch name is dropped for a generic instruction to commit", ["branch"],
    (text) => text.replace(BRANCH_TAIL, "a branch of your own and open a PR")],
  ["the branch is renamed to a shape nothing goes looking for", ["branch"],
    (text) => text.replace(BRANCH_TAIL, "`chore/metrics` and open a PR")],
  ["the commit duty is negated while keeping the branch name", ["branch", "noCommit"],
    (text) => text.replace(phrase("Commit both to"), "Do not commit both to")],
  ["the split rule is deleted outright", ["split"],
    (text) => text.replace(SPLIT_DUTY, "Data rows and rule-doc prose are both the run's own output")],
  ["the split rule is inverted", ["split", "mayBundle"],
    (text) => text.replace(SPLIT_DUTY, "Data rows and rule-doc prose may share a PR — one branch for both")],
  ["bundling is licensed by an added sentence the phrase pin survives", ["mayBundle"],
    appendTo(RULE_CHANGE_COST, "A one-line rule fix may ride along with the rows when the run is short.")],
  ["the data branch is allowed to carry prose too", ["onlyMetrics"],
    (text) => text.replace(ONLY_METRICS, "carries the two `docs/metrics/` files and any rule fix the run made")],
  ["the exemption is removed from the invariant", ["exempt"],
    (text) => text.replace(EXEMPT_TAIL, "is no different, and this invariant reaches it like any other")],
  ["the exemption is inverted rather than removed", ["exempt"],
    (text) => text.replace(EXEMPT_TAIL, "is not exempt, and this invariant reaches it too")],
  ["the exemption is stated but the action it licenses is withheld", ["label"],
    (text) => text.replace(LABEL_DUTY, "Leave that one unlabelled for the maintainer")],
  ["a reviewer is re-imposed on the run's own artifact PR", ["needsReview"],
    appendTo(LABEL_DUTY, "It still needs a reviewer before the label goes on.")],
];

for (const [what, expected, mutate] of mutants) {
  test(`the pins redden when ${what}`, () => {
    const mutated = mutate(RUN_TEAM);
    assert.notEqual(mutated, RUN_TEAM, `the "${what}" fixture no longer matches the prose and applied nothing — update the fixture, do not delete it`);
    assert.deepEqual(firing(mutated), expected, `the "${what}" fixture did not fire exactly the pins it is here to exercise`);
  });
}

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
  // Three unrelated rewords, one inside each slice — the sentence that explains
  // the rule, never the sentence that states it.
  benign = benign
    .replace(phrase("a name of your own invention still merges and still cannot be found"),
      "an invented name merges just as well and is findable by nobody")
    .replace(RULE_CHANGE_COST, "An unmerged rule change simply leaves the rule as it was.")
    .replace(phrase("stranding the rows behind it"), "rather than leaving the rows stranded behind a question nobody owns");
  assert.notEqual(benign, RUN_TEAM, "the benign-edit fixture applied nothing — update it");
  assert.deepEqual(firing(benign), [], "a reflow plus unrelated rewords reddened a pin — the pins are over-tight, not the docs wrong");
});
