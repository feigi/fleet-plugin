// #859. The fix-applier dispatch block (phase 3) is a `>` blockquote pasted
// VERBATIM into the fix-applier's prompt — the controller copies those lines
// as-is, it does not paraphrase them, and it does not chase a cross-reference
// out of the block. Before this ticket the block carried the mutation-testing
// rule and the re-derive-the-pin rule, but none of the three prose-discipline
// rules the implementer block carries, even though a fix-applier's whole job
// is writing prose after review — commit messages, deferral-issue rationale,
// its final report — on a snapshot nothing downstream re-reviews.
//
// Measured against `origin/main` before this file existed: an
// implementer-only search of the fix-applier's prompt slice —
// `awk 'NR==1483,NR==1631' skills/run-team/SKILL.md | grep -iE
// "settling command|positional|COUNT|tally"` — hit nothing but unrelated CI
// behind-count prose. No test in this suite pinned any of the three rules
// inside the fix-applier's own prompt slice either; the two files that pin
// this text (`immutable-body-claim-prose.test.mjs`,
// `cross-repo-citation-prose.test.mjs`) both scope to the IMPLEMENTER'S copy,
// which sits under `### Reviewers` before the fix-applier prompt even opens.
//
// SHAPE, matching the convention every file beside this one uses. Each rule
// gets its own ordered-span assertion, gaps sized to the punctuation that
// actually separates the anchors today (a handful of characters) so a
// deletion of the connecting clause reds without a loose `.{0,N}?` papering
// over it. A positive regex over the whole fix-applier prompt — 1200+ chars —
// would be satisfied by the SAME wording surviving in the implementer's copy
// further up the section; these slices are bounded to the fix-applier
// prompt specifically (`section()` below, mirroring
// `review-path-default.test.mjs`'s `fixApplierPrompt()`, duplicated rather
// than imported for the reason `implementer-model-tier.test.mjs` gives for
// its own copy: two files, seven lines, nothing detects drift between them).
//
// THE CEILING these pins share with every prose pin in this directory: they
// prove a phrase is PRESENT and ADJACENT to its neighbor. A sentence
// appended after a pinned span that carves out an exception touches no
// pinned fragment and stays green — closing that needs a different
// mechanism (an LLM judge, a schema'd rule format), tracked separately, not
// attempted here.
//
// #859's own third acceptance criterion — the candidates.test.mjs live-count
// clause restated as a property — is NOT covered by this file. Verified
// against this tree: neither "62 tests" nor "61 unrelated tests" appears
// anywhere in `plugin/scripts/candidates.test.mjs` today. Commit `7eed0a8`
// ("docs(candidates.test): drop three claims the tree contradicts from the
// pin's comments") already replaced both clauses with measured, count-free
// prose before this branch started, so there is nothing left there for this
// ticket to fix or to pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Scoped to the Reviewers section first, for the reason `indexOf` demands it:
// "You are ALREADY in worktree" also opens phase 2's implementer worktree
// block earlier in the file, and a file-wide anchor would silently pin that
// one instead of the fix-applier's own prompt.
const reviewersSection = () =>
  between(RUN_TEAM, "### Reviewers", "#### Fallback: hand-dispatched reviewer", "run-team Reviewers section");

const PROMPT_ANCHOR = "> You are ALREADY in worktree";
const PROMPT_END = "\n**Put the standing CI facts";
const fixApplierPrompt = () =>
  between(reviewersSection(), PROMPT_ANCHOR, PROMPT_END, "run-team fix-applier prompt");

// The implementer's own copy of the count rule, the OTHER seat #859 requires
// the qualification to reach. Bounded to the two-line span that opens on
// "give them to every implementer regardless of class" and closes on the
// immutable-body rule that follows it, so a rewording anywhere else in the
// correction-ticket block cannot satisfy this slice by accident.
const implementerCountRule = () =>
  between(
    RUN_TEAM,
    "Two of the rules above are what caught both",
    "The immutable-body rule earns the same",
    "run-team implementer count-rule paragraph",
  );

// `**` emphasis and the `>` blockquote gutter are stripped and whitespace
// collapsed before matching, so a pin survives a bold move or a rewrap.
// Single `*`/backtick are left alone — this slice's only single-`*` and
// backtick usage is code-quoted (`` `the closing/second/last X` ``,
// `` `every other test in the file` ``), never italics, so nothing here
// depends on preserving it.
const flatten = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^\s*>?\s?/, ""))
    .join(" ")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();

test("the fix-applier prompt carries the settling-command rule, tied to its citation caveat", () => {
  const prompt = flatten(fixApplierPrompt());
  assert.match(
    prompt,
    /Every factual claim your diff restates needs a settling command run against the tree first.{0,15}?the issue body is a lead, never a citation/,
    "the fix-applier prompt no longer requires a settling command for every restated claim, or drops the caveat that the issue body is a lead and not a citation",
  );
});

test("the fix-applier prompt carries the no-positional-references rule with its own example", () => {
  const prompt = flatten(fixApplierPrompt());
  assert.match(
    prompt,
    /No positional references.{0,15}?the closing\/second\/last X.{0,15}?name the thing semantically/,
    "the fix-applier prompt no longer forbids a positional reference, or dropped the example/remedy pair that makes the rule actionable",
  );
});

test("the fix-applier prompt's count rule is qualified — a live property is restated, a past-tense measurement is not", () => {
  const prompt = flatten(fixApplierPrompt());
  // One ordered span, not four presence checks. The failure this guards is
  // not deletion of the rule — it is deleting only the qualification and
  // leaving the bare "never write a COUNT" behind, which is exactly the
  // unsafe, unqualified rule #859 measured minting a false claim once
  // already (rewriting a correct past-tense record as a property).
  assert.match(
    prompt,
    /Never write a COUNT or a tally into prose; state the property instead.{0,15}?unless it is a past-tense record of a measurement you performed, which stays as written.{0,10}?a present-tense claim about a live property must be restated as a property.{0,60}?true at any count/,
    "the fix-applier prompt's count rule lost its past-tense/live-property qualification, its ordering, or one of its two halves",
  );
});

test("the implementer's own count rule carries the identical past-tense/live-property qualification", () => {
  // #859's ruling is explicit that BOTH seats need this, not only the new
  // copy — this is the pre-existing rule, being re-derived rather than left
  // as the unsafe unqualified form the fix-applier copy above no longer has.
  const rule = flatten(implementerCountRule());
  assert.match(
    rule,
    /never write a COUNT or a tally into prose; state the property instead.{0,15}?unless it is a past-tense record of a measurement you performed, which stays as written.{0,10}?a present-tense claim about a live property must be restated as a property.{0,60}?true at any count/,
    "the implementer's own count rule lost its past-tense/live-property qualification — #859 requires both seats to carry it, not only the fix-applier's new copy",
  );
});

test("a rewrapped fix-applier prompt still matches all three rules — these pins refuse drift, not reflow", () => {
  // ACCEPT side. The fixture is DERIVED from the live text, never a quoted
  // line, so a meaning-preserving reword of the surrounding prompt is not
  // what this test measures — only that re-wrapping the pinned paragraph at
  // a column width nothing here assumes leaves every ordered span intact.
  const raw = between(
    fixApplierPrompt(),
    "Every factual claim your diff restates",
    "\n>\n> **Apply",
    "the fix-applier's new prose-discipline paragraph",
  );
  const body = flatten(raw);
  const words = body.split(/\s+/).filter(Boolean);
  const lines = words.reduce((acc, w) => {
    const last = acc[acc.length - 1];
    if (last && `${last} ${w}`.length <= 40) acc[acc.length - 1] = `${last} ${w}`;
    else acc.push(w);
    return acc;
  }, []);
  const narrow = lines.map((l) => `> ${l}`).join("\n");
  assert.notEqual(narrow, raw, "the rewrap fixture no longer changes the paragraph's wrapping — update it");
  const rewrappedFile = RUN_TEAM.replace(raw, () => narrow);
  const rewrappedReviewers = between(
    rewrappedFile,
    "### Reviewers",
    "#### Fallback: hand-dispatched reviewer",
    "rewrapped run-team Reviewers section",
  );
  const prompt = flatten(between(rewrappedReviewers, PROMPT_ANCHOR, PROMPT_END, "rewrapped fix-applier prompt"));
  assert.match(prompt, phrase("Every factual claim your diff restates needs a settling command run against the tree first"));
  assert.match(prompt, phrase("No positional references"));
  assert.match(prompt, phrase("unless it is a past-tense record of a measurement you performed"));
});
