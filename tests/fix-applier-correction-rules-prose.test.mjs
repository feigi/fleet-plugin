// #859. The fix-applier's member prompt — its agent body, which the harness
// injects as the member's system prompt, and the brief the renderer prints for
// a review fix-applier — carries the three prose-discipline rules the
// implementer's body carries, because a fix-applier's whole job is writing
// prose after review — commit messages, deferral-issue rationale, its final
// report — on a snapshot nothing downstream re-reviews. The controller pastes
// none of it: SKILL.md carries no copy of the prompt, so a pin here reads the
// text where the member reads it.
//
// Measured against `origin/main` before this file existed: an
// implementer-only search of the fix-applier's prompt slice hit nothing but
// unrelated CI behind-count prose, and no test in this suite pinned any of the
// three rules inside the fix-applier's own prompt either; the two files that
// pin this text (`immutable-body-claim-prose.test.mjs`,
// `cross-repo-citation-prose.test.mjs`) both scope to the IMPLEMENTER'S copy,
// which lives in `plugin/agents/fleet-implementer-<cell>.agent.md`.
//
// SHAPE, matching the convention every file beside this one uses. Each rule
// gets its own ordered-span assertion, gaps sized to the punctuation that
// actually separates the anchors today (a handful of characters) so a
// deletion of the connecting clause reds without a loose `.{0,N}?` papering
// over it. A positive regex over a section of text a dozen other sentences
// could satisfy would be satisfied by equivalent wording elsewhere in it; the
// member prompt is one member's text only, so the ordered spans below are
// read against the whole of it (`fixApplierPrompt()` below).
//
// THE CEILING these pins have: they prove a phrase is PRESENT and ADJACENT
// to its neighbor. A sentence appended after a pinned span that carves out
// an exception touches no pinned fragment and stays green, and so does a
// clause inserted inside one of the gaps above while it has headroom.
//
// #1002 closed that half for this prompt, with a mechanism that is not a
// regex: `dispatch-block-golden-prose.test.mjs` holds a whole-block golden
// fixture for the fix-applier prompt — its nested refuter prompt included —
// and any insertion reds there, because the prompt no longer equals its
// known-good copy. An LLM judge and a schema'd rule format were the two
// candidates considered there and both were rejected.
//
// These pins were kept, not replaced. A golden red says the prompt changed
// and hands the reader a diff; a red here names the correction rule that
// went missing. Editing this prompt now reds both, deliberately: the golden
// is re-blessed in the same change, which is the review point these pins do
// not have.
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
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");

// The member prompt as a whole: the fix-applier's agent body, then its rendered
// review brief. Nothing in it is another member's text, so no slice is needed
// to keep an implementer's identical sentence from satisfying a pin.
const fixApplierPrompt = () => memberPrompt("fix-applier", "review");

// The implementer's own copy of the count rule, the OTHER seat #859 requires
// the qualification to reach. It lives in the claim-discipline block of the
// implementer agent body, which the harness injects as every implementer's
// system prompt; bounded to that block so a rewording anywhere else in the
// body cannot satisfy this slice by accident.
const AGENT = Pin.file(join(REPO, "agents", "fleet-implementer-slow-high.agent.md"));
const implementerCountRule = () =>
  AGENT.between(
    "**Claim discipline, on every ticket:**",
    "Commit incrementally as you go",
    "the implementer agent body's claim-discipline block",
  ).text;

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

test("the fix-applier prompt's settling grep takes -F over literal text and trusts a zero only after a known match", () => {
  // #1087. One span, both halves: `-F` alone still lets a command that can
  // never return non-zero write "absent" under `Verified:`, and the positive
  // control alone leaves the pattern-reading of literal prose as the default.
  assert.match(
    flatten(fixApplierPrompt()),
    Pin.phrase("A settling grep over literal text takes `grep -F`, and its zero counts only after the same command finds a line known to match"),
    "the fix-applier prompt no longer tells a settling grep over literal text to take -F, or dropped the positive control that has to pass before its zero is trusted",
  );
});

test("the implementer's own count rule carries the identical past-tense/live-property qualification", () => {
  // #859's ruling is explicit that BOTH seats need this, not only the new
  // copy — this is the pre-existing rule, being re-derived rather than left
  // as the unsafe unqualified form the fix-applier copy above no longer has.
  const rule = flatten(implementerCountRule());
  assert.match(
    rule,
    /Never write a count or tally into present-tense prose; state the property instead.{0,40}?A past-tense record of a measurement you performed stays as written/,
    "the implementer's own count rule lost its past-tense/live-property qualification — #859 requires both seats to carry it, not only the fix-applier's new copy",
  );
});

test("a rewrapped fix-applier prompt still matches every pinned rule — these pins refuse drift, not reflow", () => {
  // ACCEPT side. The fixture is DERIVED from the live text, never a quoted
  // line, so a meaning-preserving reword of the surrounding prompt is not
  // what this test measures — only that re-wrapping the pinned paragraph at
  // a column width nothing here assumes leaves every ordered span intact.
  const raw = Pin.of(fixApplierPrompt(), "fixApplierPrompt()").between(
    "Every factual claim your diff restates",
    "\n\n**Apply",
    "the fix-applier's prose-discipline paragraph",
  ).text;
  const body = flatten(raw);
  const words = body.split(/\s+/).filter(Boolean);
  const lines = words.reduce((acc, w) => {
    const last = acc[acc.length - 1];
    if (last && `${last} ${w}`.length <= 40) acc[acc.length - 1] = `${last} ${w}`;
    else acc.push(w);
    return acc;
  }, []);
  const narrow = lines.join("\n");
  assert.notEqual(narrow, raw, "the rewrap fixture no longer changes the paragraph's wrapping — update it");
  const rewrapped = fixApplierPrompt().replace(raw, () => narrow);
  assert.notEqual(rewrapped, fixApplierPrompt(), "the rewrap never landed in the prompt — this control did not run");
  const prompt = flatten(rewrapped);
  assert.match(prompt, Pin.phrase("Every factual claim your diff restates needs a settling command run against the tree first"));
  assert.match(prompt, Pin.phrase("No positional references"));
  assert.match(prompt, Pin.phrase("unless it is a past-tense record of a measurement you performed"));
  assert.match(prompt, Pin.phrase("its zero counts only after the same command finds a line known to match"));
});
