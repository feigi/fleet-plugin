import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorAt, between, paragraph, phrase, stripSlashGutter, pairSlices } from "./prose-pin.mjs";

// The 14 consumer files exercise only between()'s HAPPY path: every one of them
// slices a document that still holds both anchors. Measured on this PR: deleting
// BOTH `assert.notEqual` guards left the full suite at 1035 pass / 0 fail, exit
// 0 — byte-identical to baseline. The guards are the entire reason this module
// was extracted rather than left inline, and nothing was pinning them.
//
// Fixtures here are short literal strings on purpose. Pinning the guards against
// a real document would re-couple this file to whatever review-pr.js or a SKILL.md
// happens to say today, which is the rot the name-based citations elsewhere in
// this repo exist to avoid.

test("between returns the slice bounded by both anchors, start inclusive, end exclusive", () => {
  assert.equal(between("xxSTARTmiddleENDyy", "START", "END", "the fixture"), "STARTmiddle");
  // The start anchor is KEPT, the end anchor dropped — callers that need it
  // stripped do their own `.slice(from.length)`.
  assert.equal(between("aXbXc", "X", "c", "the fixture"), "XbX");
});

test("between throws when the text no longer contains the start anchor", () => {
  assert.throws(
    () => between("no anchors here", "START", "END", "the fixture"),
    /the fixture no longer contains "START" — update this test/,
  );
});

// The both-ends contract, stated in prose-pin.mjs's own comment and unverified
// until now: the end anchor is searched from `at + from.length`, never from 0.
// An unbounded `text.indexOf(to)` finds the EARLIER occurrence, returns
// `text.slice(at, 0)` === "" and throws nothing — the false green the module
// exists to kill. Both this test and the one above red if either guard is
// deleted; this one ALSO reds if the end search loses its offset.
test("between throws when the end anchor exists only BEFORE the start anchor", () => {
  assert.throws(
    () => between("ENDzzSTARTzz", "START", "END", "the fixture"),
    /the fixture no longer contains "END" after "START" — update this test/,
  );
  // And the same when the end anchor is absent outright.
  assert.throws(() => between("zzSTARTzz", "START", "END", "the fixture"), /no longer contains "END" after "START"/);
});

// `\s+` between words, never a literal space: the prose these match against is
// hard-wrapped, so any inter-word space in the source may be a newline plus
// indent. Replacing the join with " " passes a single-line fixture and fails
// this one.
test("phrase matches a hard-wrapped phrase across a newline and indent", () => {
  assert.match("a paragraph that refuses\n  rather than passing, wrapped", phrase("refuses rather than passing"));
  assert.match("tab-indented:\trefuses\n\t\trather than\n\tpassing", phrase(" refuses rather than passing "));
});

// Escaping is what keeps an anchor a LITERAL. Each negative assertion below is
// the whole point: unescaped, `(b)` is a capture group that matches "a b c",
// `.` matches any character, and `$` is an end-of-input anchor that matches
// nothing after it. Drop the escape and the regex silently matches text the
// anchor does not appear in — a pin that passes against the wrong prose.
test("phrase escapes regex metacharacters taken from its input", () => {
  assert.match("call exit (2) now", phrase("exit (2)"));
  assert.doesNotMatch("call exit 2 now", phrase("exit (2)"));

  assert.match("pinned at v1.2 today", phrase("v1.2"));
  assert.doesNotMatch("pinned at v1x2 today", phrase("v1.2"));

  assert.match("costs $5 per run", phrase("costs $5"));
  assert.doesNotMatch("costs 5 per run", phrase("costs $5"));

  // `*` and `+` are quantifiers, and a leading one is a SyntaxError rather than
  // a wrong match — so an unescaped anchor starting with either throws at
  // construction instead of failing an assertion.
  assert.doesNotThrow(() => phrase("*.mjs"));
  assert.match("run node --test *.mjs here", phrase("*.mjs"));
});

// #1346/#1361: the third gutter shape, exercised nowhere else until a real
// `.js` comment-form pair lands. Written here rather than left for that
// consumer, per this file's own header: a guard with no dedicated test is a
// guard nobody is pinning.
test("stripSlashGutter strips a leading `// ` and leaves everything else untouched", () => {
  assert.equal(stripSlashGutter("// CLAUDE: dispatch it"), "CLAUDE: dispatch it");
  assert.equal(stripSlashGutter("  //CLAUDE: no space after slash"), "CLAUDE: no space after slash");
  // A trailing comment is not a marked line's gutter — stripping mid-line
  // would turn code-with-a-note into a false marker.
  assert.equal(stripSlashGutter('const x = 1; // CLAUDE: not a marked line'), 'const x = 1; // CLAUDE: not a marked line');
  assert.equal(stripSlashGutter("plain code\nmore code"), "plain code\nmore code");
});

// pairSlices' four throw guards, each isolated — #1346's acceptance
// criterion ("a pin that matches both lines is rejected at construction")
// is one of these four, demonstrated again in `marked-pairs.test.mjs`
// against the divergence-check module; here each guard gets its OWN case,
// independent of that module ever existing.
const SECTION = (claude, omp) => `## S\n\nCLAUDE: ${claude}\nOMP: ${omp}\n\n## Next`;

test("pairSlices: a clean pair returns both one-line slices", () => {
  const { claude, omp } = pairSlices(SECTION("`SendMessage` wakes it.", "`hub send` wakes it."), "## S", "## Next");
  assert.equal(claude, "CLAUDE: `SendMessage` wakes it.");
  assert.equal(omp, "OMP: `hub send` wakes it.");
});

test("pairSlices throws when the CLAUDE line names no recognized dialect token", () => {
  assert.throws(
    () => pairSlices(SECTION("nothing tool-shaped here.", "`hub send` wakes it."), "## S", "## Next"),
    /CLAUDE line names no recognized dialect token/,
  );
});

test("pairSlices throws when the OMP line names no recognized dialect token", () => {
  assert.throws(
    () => pairSlices(SECTION("`SendMessage` wakes it.", "nothing tool-shaped here."), "## S", "## Next"),
    /OMP line names no recognized dialect token/,
  );
});

test("pairSlices throws when the CLAUDE line's own token also matches the OMP line", () => {
  assert.throws(
    () => pairSlices(SECTION("`SendMessage` wakes it.", "`hub send` and `SendMessage` both wake it."), "## S", "## Next"),
    /the CLAUDE line's "send\/wake channel" token also matches the OMP line/,
  );
});

test("pairSlices throws when the OMP line's own token also matches the CLAUDE line", () => {
  assert.throws(
    () => pairSlices(SECTION("`SendMessage` and `hub send` both wake it.", "`hub send` wakes it."), "## S", "## Next"),
    /the OMP line's "send\/wake channel" token also matches the CLAUDE line/,
  );
});

// `paragraph`'s two halves are its bound and its anchor, and each has its own
// false green. The bound: without the blank-line cut the slice runs to the end
// of the document and a decoy copy of the wording anywhere below satisfies the
// pin. The anchor: routed through `phrase()` rather than a literal `indexOf`,
// so a rewrap that the pinned clause survives does not red the pin — the
// false POSITIVE that a literal anchor introduces. Two throws keep the anchor
// honest: a moved one never widens the slice back to the whole file, and a
// duplicated one never binds the pin to the wrong copy.
test("paragraph cuts at the blank line, so a decoy below the rule cannot satisfy a pin", () => {
  const doc = "intro\n\nTHE RULE says do X.\nstill the rule.\n\nlater prose.\n\na stray copy says do X.\n";
  assert.equal(paragraph(doc, "THE RULE", "the fixture"), "THE RULE says do X.\nstill the rule.");
  // The decoy is real: unbounded, the whole document contains the wording twice.
  assert.doesNotMatch(paragraph("THE RULE says do Y.\n\na stray copy says do X.\n", "THE RULE", "the fixture"), phrase("do X"));
});

// The decoy above sits below a CLEAN blank line, so it passes both before and
// after the bound moved off the literal `\n\n` — it cannot see that
// regression. This one can: an editor keeping a list item's indent writes a
// blank line carrying whitespace, which `indexOf("\n\n")` does not find, and
// the slice then runs past the paragraph onto the decoy.
test("paragraph cuts at a blank line that carries whitespace", () => {
  assert.doesNotMatch(paragraph("THE RULE says do Y.\n   \na stray copy says do X.\n", "THE RULE", "the fixture"), phrase("do X"));
});

// The bound's mirror image: an anchor matching twice binds the pin to
// whichever copy comes first, so the real rule below can be gutted with the
// suite green. Same standard `markedLine` already holds its own marker to.
test("paragraph throws when its anchor matches twice, rather than binding the wrong copy", () => {
  assert.throws(
    () => paragraph("THE RULE says do X.\n\nprose.\n\nTHE RULE says do X.\n", "THE RULE", "the fixture"),
    /the fixture: slice anchor "THE RULE" occurs 2 times — a pin would bind the wrong copy; narrow the anchor/,
  );
});

test("paragraph anchors reflow-safely — a hard-wrapped anchor still matches", () => {
  const doc = "**a long anchor\n   spanning a wrap** and the rule.\n\nnext.\n";
  assert.match(paragraph(doc, "**a long anchor spanning a wrap**", "the fixture"), phrase("and the rule"));
});

test("paragraph throws when its anchor moved, rather than widening to the whole file", () => {
  assert.throws(
    () => paragraph("no anchor here\n\nGONE\n", "MISSING ANCHOR", "the fixture"),
    /the fixture: slice anchor "MISSING ANCHOR" moved — re-anchor this test, never widen it to the whole file/,
  );
});

// A document with no blank line at all is one paragraph, not a failure.
test("paragraph returns the remainder when the rule's block ends the document", () => {
  assert.equal(paragraph("x\n\nTHE RULE ends here.", "THE RULE", "the fixture"), "THE RULE ends here.");
});

// `anchorAt` returns the offset where the anchor STARTS, not where it ends.
// `paragraph` slices forward from it, so either offset would look right there;
// `quiet-payload-prose`'s source site slices BACKWARD from it to take the `//`
// block above a declaration, and there the two are a whole anchor apart. Written
// here rather than left to that consumer, per this file's own header: a guard with
// no dedicated test is a guard nobody is pinning, and a consumer can stop needing
// the contract it happens to pin today.
test("anchorAt returns the offset where the anchor starts, not where it ends", () => {
  assert.equal(anchorAt("pad\n\nTHE RULE says X.", "THE RULE", "the fixture"), 5);
});
