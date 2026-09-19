import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorAt, between, paragraph, phrase, quoteBlock, quoteBlocks, runAbove, stripSlashGutter, pairSlices, logicalLines } from "./prose-pin.mjs";

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

// #1492. The anchor-pair primitive's emphasis-tolerant mode, mirroring the one
// `anchorAt` and `quoteBlock` already carry. Every move below is
// meaning-preserving in the rendered document, and every one of them reds a
// literal `indexOf` anchor — the defect class this option closes. The anchor is
// typed WITH `**` here on purpose: that is how this population writes them, and
// it is the direction `anchorAt`'s own tolerant mode does not cover, since it
// strips only the document.
//
// THE CLASS, enumerated. `**` emphasis may, meaning-preservingly: vanish from
// the anchored words, appear on them, narrow onto fewer of them, widen past
// them, or move to a different word boundary inside them. All five are covered
// below. Deliberately LEFT, and out of this option's name: single-asterisk
// `*italic*` and `_underscore_` emphasis, and backtick code spans — the
// acceptance criterion is to reuse `unemphasized`, which is this directory's
// one definition of an emphasis marker and is `**`-only; a second stripper
// here would be the duplicate that criterion forbids. Also left: a lone `*`
// whose pairing differs between the anchor and the document, since `**` pairs
// globally in the document and locally in the anchor. No anchor in this repo
// carries one.
//
// Mutation-tested 2026-09-18 against a scratch copy of `prose-pin.mjs` under
// `/tmp/fleet-scratch/impl-1492/` (never the real module), each substitution
// asserted to have applied before the run was believed — two of the first
// patterns matched `anchorAt`/`quoteBlock` as well and were reported UNAPPLIED
// rather than silently passing as survivors. 11 mutations, 0 survivors. Reds
// by test NAME, not count, so per-pin discrimination is visible:
//   (M1) tolerance ignored, raw document searched — reds 9
//   (M2) start-anchor uniqueness guard deleted — reds the ambiguity pin alone
//   (M3) [superseded by #1613] this session predates the END-anchor guard;
//        symmetrizing it onto the END anchor reded both END pins below at
//        the time and is now the SHIPPED behavior — see `between`'s own doc
//        comment and the end-anchor ambiguity/empty-anchor pins added below
//   (M4) end anchor searched from 0 — reds the both-ends pin, old and new
//   (M5) `rawOffset` dropped, stripped offsets cut raw text — reds 6
//   (M6) tolerant match routed through `phrase()` — reds the whitespace pin
//        alone, and reds NOTHING until that pin covered the start anchor too
//   (M7a/b) document stripped but the anchor left literal — reds 7 / 3
//   (M8) tolerance on by default — reds the pre-existing literal `between`
//        pin, which is the off-by-default criterion holding without an edit
//   (M9) `occurrenceCount` stops at the first hit — reds the ambiguity pin
//   (M10) tolerant slice returned emphasis-stripped — reds 5
//
// Each row states the WHOLE slice it expects, byte for byte, rather than
// matching a phrase inside it. Two contracts ride on that: the bounds moved to
// the right places, and the returned bytes still carry whatever `**` the
// document has — a tolerant anchor locates, it never rewrites what the caller
// gets back. A `phrase()` match inside the slice would see neither, and would
// pass against a slice that had silently swallowed `pad`.
const MOVES = [
  ["emphasis removed", "pad\n\nstart here — the rule.\n\nEND", "start here — the rule.\n\n"],
  ["emphasis narrowed to one word", "pad\n\n**start** here — the rule.\n\nEND", "**start** here — the rule.\n\n"],
  ["emphasis widened past the anchor", "pad\n\n**start here — the** rule.\n\nEND", "**start here — the** rule.\n\n"],
  ["emphasis moved to another word boundary", "pad\n\nstart **here** — the rule.\n\nEND", "start **here** — the rule.\n\n"],
  ["emphasis unchanged", "pad\n\n**start here** — the rule.\n\nEND", "**start here** — the rule.\n\n"],
];

for (const [move, doc, expected] of MOVES) {
  test(`between with emphasisTolerant still finds its anchor when ${move}`, () => {
    assert.equal(between(doc, "**start here**", "END", "the fixture", { emphasisTolerant: true }), expected);
  });
}

// The over-widening case, and the reason the tolerant mode needs a guard the
// literal one does not. Stripping `**` can only ADD matches, so a tolerant
// START anchor can land EARLIER than the literal one did — here on a decoy
// stating the rule in plain text ABOVE the real, emphasized one. Taking the
// first hit slices from the decoy and pulls in everything between, which no
// assertion inside the slice can see: the pinned words are all still there,
// just sourced from the wrong copy. A green pin over the wrong region is worse
// than the red it replaces, so it throws.
//
// The literal call on the SAME fixture is asserted alongside it, and that
// pairing is what makes this a widening test rather than a duplicate-anchor
// test: the exact-match anchor resolves to ONE place and returns the narrow,
// correct slice, so the region the tolerant mode refuses to guess at is
// demonstrably real and demonstrably wider.
const TWO_STATES = "decoy: the RULE — and then it drifts.\n\n**never slice me**\n\nreal: the **RULE** — and then it holds.\n\nEND";

test("between throws on an ambiguous tolerant start anchor rather than slicing from the wrong occurrence", () => {
  assert.throws(
    () => between(TWO_STATES, "the **RULE** —", "END", "the fixture", { emphasisTolerant: true }),
    /the fixture: emphasis-tolerant slice anchor "the \*\*RULE\*\* —" occurs 2 times once `\*\*` is ignored/,
  );
  // Exact-match, same fixture, same anchors: one hit, and the slice the
  // tolerant mode declined to widen past.
  assert.equal(between(TWO_STATES, "the **RULE** —", "END", "the fixture"), "the **RULE** — and then it holds.\n\n");
});

// The END anchor now gets the SAME guard, symmetric with the START — added
// by #1613 after review found the asymmetry could silently narrow OR widen a
// tolerant slice (see `between`'s own doc comment). Here the end anchor's
// text appears twice AFTER the start in two different emphasis states, which
// is exactly the shape the START guard refuses; the END guard now refuses it
// too, rather than resolving to the first and silently dropping whatever sat
// between the two.
//
// The literal call on the SAME fixture is asserted alongside it: literal
// mode never gets this guard (see `between`'s own doc comment for why) and
// still resolves to the first occurrence — proving the guard is scoped to
// `emphasisTolerant` and did not regress the literal path.
const REPEATED_END = "HEAD one\n\nthe STOP mark, plain.\n\nmiddle\n\nthe **STOP** mark, bold.\n\nEND";

test("between throws on an ambiguous tolerant end anchor rather than stopping at the first occurrence", () => {
  assert.throws(
    () => between(REPEATED_END, "HEAD one", "the **STOP** mark", "the fixture", { emphasisTolerant: true }),
    /the fixture: emphasis-tolerant slice end anchor "the \*\*STOP\*\* mark" occurs 2 times after the start once `\*\*` is ignored/,
  );
  assert.equal(between(REPEATED_END, "HEAD one", "the **STOP** mark", "the fixture"), "HEAD one\n\nthe STOP mark, plain.\n\nmiddle\n\n");
});

// `occurrenceCount`'s own contract, unverified until now: cursor-bounded
// (`i = hit + 1`) rather than chained off the previous hit's length, so an
// anchor that strips to "" under `emphasisTolerant` terminates instead of
// spinning forever on `indexOf("", i)`'s clamped return. Confirmed by
// reverting to the chained form (`i = hit + needle.length`): every other
// test in this file still passes, and only this fixture hangs, because
// `needle.length` is 0 and the cursor never advances.
test("between throws rather than hanging when a tolerant anchor strips to empty", () => {
  assert.throws(
    () => between("pad\n\n**start here**\n\nEND", "**", "END", "the fixture", { emphasisTolerant: true }),
    /the fixture: emphasis-tolerant slice anchor "\*\*" occurs \d+ times once `\*\*` is ignored/,
  );
});

// `between`'s both-ends contract has to survive the new search view: the end
// anchor is still searched from `at + start.length`, measured in the STRIPPED
// document, never from 0. A tolerant search that lost that offset finds the
// copy above the start anchor and returns "", the false green this module
// exists to kill — and the throw below is the same guard one document later.
// The message names the anchor as the caller TYPED it, `**` and all, so it can
// be grepped for.
test("between's tolerant END anchor is still searched only after the start anchor", () => {
  assert.equal(
    between("**EDGE** early\n\nHEAD\n\nbody here\n\nEDGE late", "HEAD", "**EDGE**", "the fixture", { emphasisTolerant: true }),
    "HEAD\n\nbody here\n\n",
  );
  assert.throws(
    () => between("**EDGE** early\n\nHEAD\n\nbody here", "HEAD", "**EDGE**", "the fixture", { emphasisTolerant: true }),
    /the fixture no longer contains "\*\*EDGE\*\*" after "HEAD" — update this test/,
  );
});

// Emphasis tolerance and WHITESPACE tolerance are separate axes, and this pin
// is the one that keeps them separate. The obvious implementation mirrors
// `anchorAt` and runs the stripped anchor through `phrase()`; `phrase()` is
// `s.trim().split(/\s+/)`, so it discards the leading newline — and this
// family's anchors carry load-bearing ones, e.g.
// `fix-applier-correction-rules-prose.test.mjs`'s `PROMPT_END`,
// `"\n**Put the standing CI facts"`: the leading `\n` ties it to the line
// where that phrase starts, not to any earlier occurrence of the same words
// mid-line. `phrase()`'s `.trim()` would strip that newline before matching.
//
// Both fixtures reproduce that shape: the anchor's word appears inline earlier
// and at a line start later, and only the line-start one is the bound. Route
// either anchor through `phrase()` and it binds the inline copy instead —
// widening the slice at the start bound, cutting it short at the end bound.
// Both anchors are pinned because either one alone leaves the other free to
// pick up `phrase()` on the next edit.
test("between's tolerant mode leaves whitespace literal at both anchors, so a leading newline still bounds the slice", () => {
  assert.equal(between("HEAD one **Put** two\n**Put the rest", "HEAD", "\n**Put", "the fixture", { emphasisTolerant: true }), "HEAD one **Put** two");
  assert.equal(between("pad **HEAD** inline\nHEAD at line start\n\nEND", "\n**HEAD**", "END", "the fixture", { emphasisTolerant: true }), "\nHEAD at line start\n\n");
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
// `runAbove` slices BACKWARD from it to take the comment block above a
// declaration, and there the two are a whole anchor apart — an end offset
// would leave the anchor's own bytes at the tail of the slice, where they stop
// the `$`-bound run from matching and hand back "" on a comment that is
// present. Written here rather than left to either consumer, per this file's
// own header: a guard with no dedicated test is a guard nobody is pinning, and
// a consumer can stop needing the contract it happens to pin today.
test("anchorAt returns the offset where the anchor starts, not where it ends", () => {
  assert.equal(anchorAt("pad\n\nTHE RULE says X.", "THE RULE", "the fixture"), 5);
});

// `runAbove` is the backward bound, for source files where `paragraph`'s blank
// line is the wrong cut: in source the blank line after a comment block sits
// BELOW the code the block documents, so a blank-line slice runs past the
// prose into live code. Its own two halves, each with its own false green. The
// bound: a run that did not stop at code would take an earlier comment block,
// or the code between, and a decoy in either satisfies the pin. The anchor:
// routed through `anchorAt`, so a restated declaration reds rather than
// handing back the comment above the wrong copy. Three consumer files
// hand-rolled this before #1604 and one of them is a `#` gutter, so the marker
// is a parameter and both dialects are exercised here.
test("runAbove takes the run immediately above the anchor, not an earlier one", () => {
  const src = "// a decoy block\nconst other = 1;\n// the real block\n// still it\nconst TARGET = 2;\n";
  assert.equal(runAbove(src, "const TARGET", "the fixture", "//"), "// the real block\n// still it\n");
});

// The ACCEPT side: a run this bound must not refuse. Shell gutter, indented
// run, an anchor carrying regex metacharacters — `reap.sh`'s own
// `gp_sep=$(printf '\002')`, which reaches the match only because `anchorAt`
// routes it through `phrase()` — and an INDENTED ANCHOR, the case every
// hand-rolled copy refused before #1604: their run ended at `$`, so text
// ending in the declaration's own indent matched nothing and the caller was
// told the comment was gone. The expected value pins the other half of that
// fix: the indent is tolerated, never returned as part of the run.
test("runAbove accepts an indented `#` run below an indented anchor", () => {
  const sh = "setup() {\n  # the note\n  # and its second line\n  gp_sep=$(printf '\\002')\n}\n";
  assert.equal(runAbove(sh, "gp_sep=$(printf '\\002')", "the fixture", "#"), "  # the note\n  # and its second line\n");
});

// #1622: the mirror of the indented-anchor case above, but on the SAME line
// as the anchor rather than beneath it. `const TARGET` anchors inside
// `export const TARGET = 2;`, so the text ending right before the anchor is
// `"...export "` — not whitespace — and the old `[ \t]*$` tail could not
// match, handing back "" with the comment sitting right there. The expected
// value pins the fix: the keyword prefix is tolerated, never returned as
// part of the run.
test("runAbove accepts a same-line keyword prefix before the anchor", () => {
  const src = "// doc\n// still\nexport const TARGET = 2;\n";
  assert.equal(runAbove(src, "const TARGET", "the fixture", "//"), "// doc\n// still\n");
});

// #1622: the tail bound's keyword-chain tolerance is `)*$`, not `)?$` — the
// PR's own rationale names multi-keyword prefixes like `export default async
// function` and `export abstract class` as the intended case, not just a
// single modifier. A narrowed quantifier that only tolerated one token would
// still pass the single-keyword fixture above while silently regressing
// this one.
test("runAbove accepts a same-line chain of multiple keyword prefixes", () => {
  const src = "// doc\n// still\nexport default async function TARGET() {}\n";
  assert.equal(runAbove(src, "TARGET", "the fixture", "//"), "// doc\n// still\n");
});

// #1622: `DECLARATION_PREFIX_KEYWORDS` is a closed, bounded list, not
// arbitrary text tolerated before the anchor. A same-line token that is not
// one of the declaration/modifier keywords must still refuse the run, or
// the guard this PR advertises is unenforced and any prefix would slip
// through.
test("runAbove refuses a same-line prefix that is not a declaration keyword", () => {
  const src = "// doc\n// still\nsomeCode TARGET = 2;\n";
  assert.equal(runAbove(src, "TARGET", "the fixture", "//"), "");
});

// Empty, never a throw: `gp-sep-invariant-prose.test.mjs` slices at module load
// and names the empty case in a test of its own, which an import-time throw
// would pre-empt. Three shapes here return "" — plain code, code carrying
// the marker MID-LINE (which is the one that would quietly swallow a line and
// a decoy in it if the gutter were matched anywhere but at a line's start),
// and a comment block separated from the anchor by a blank line: the `$`
// bound is `[ \t]*$`, not `\s*$`, so a blank line between the block and the
// declaration is not adjacency and the block is not adopted.
test('runAbove returns "" when nothing but code sits above the anchor', () => {
  assert.equal(runAbove("const other = 1;\nconst TARGET = 2;\n", "const TARGET", "the fixture", "//"), "");
  assert.equal(runAbove('// a decoy\nconst u = "http://x";\nconst TARGET = 2;\n', "const TARGET", "the fixture", "//"), "");
  assert.equal(runAbove("// the doc block\n\nconst TARGET = 2;\n", "const TARGET", "the fixture", "//"), "");
});

// The other half of the run's start bound: `(?:^|\n)` also matches at the
// absolute start of the sliced text, for a comment block with nothing above
// it — not just mid-document, preceded by a newline.
test("runAbove takes a comment block that starts at the beginning of the text", () => {
  assert.equal(runAbove("// only comment\nconst TARGET = 2;\n", "const TARGET", "the fixture", "//"), "// only comment\n");
});

// The half `anchorAt` owns, asserted through this caller because a slicer that
// took the FIRST hit would look right on every fixture above.
test("runAbove throws when the anchor matches twice, rather than taking the comment above the wrong copy", () => {
  assert.throws(
    () => runAbove("// the real block\nconst TARGET = 2;\n\n// a restatement\nconst TARGET = 3;\n", "const TARGET", "the fixture", "//"),
    /the fixture: slice anchor "const TARGET" occurs 2 times — a pin would bind the wrong copy; narrow the anchor/,
  );
});

// The marker is a LITERAL. Unescaped, a `+` gutter is a quantifier with
// nothing to repeat, and the RegExp constructor throws rather than handing
// back the block above the anchor. This pins marker-escaping only —
// `runAbove` has no `/* ... */` block-comment dialect; every live gutter in
// this repo is `#` or `//`.
test("runAbove escapes the marker, so a gutter carrying a regex metacharacter still matches literally", () => {
  const src = "const other = 1;\n+ the block\n+ still it\nconst TARGET = 2;\n";
  assert.equal(runAbove(src, "const TARGET", "the fixture", "+"), "+ the block\n+ still it\n");
});

// An empty marker is not a narrower gutter — it is no gutter at all, and the
// regex above would match every line above the anchor, comment or not. That
// silent total widening is worse than a throw, so runAbove refuses it up front.
test("runAbove throws on an empty marker, rather than silently matching every line above the anchor", () => {
  assert.throws(
    () => runAbove("some prose line\nanother arbitrary line\nconst TARGET = 2;\n", "const TARGET", "the fixture", ""),
    /the fixture: runAbove needs a non-empty marker/,
  );
});

// `quoteBlocks` and `quoteBlock` are the bound a whole-block golden fixture
// needs (#1002), and the one thing they must never do is what every slicer in
// this directory did before them: return a slice that is not exactly one block.
// Fixtures here are short literal strings for this file's standing reason —
// pinning them against `run-team/SKILL.md` would re-couple them to whatever that
// file's blocks say today.
const QUOTED = "intro\n\n> first block, line one\n> line two\n>\n> second paragraph, same block\n\nprose between\n\n> second block\n\ntail";

// A blank quote line continues the block; a line with no gutter ends it. Both
// halves matter to a golden: the first decides whether a two-paragraph block is
// one fixture or two, and the second is the whole reason a block spliced in
// after this one cannot be absorbed into its slice.
test("quoteBlocks returns each maximal quote run, and a bare `>` line does not split one", () => {
  assert.deepEqual(quoteBlocks(QUOTED), [
    "> first block, line one\n> line two\n>\n> second paragraph, same block",
    "> second block",
  ]);
});

// Nothing before the first quote line and nothing after the last may leak in: an
// unquoted line inside the slice is text the controller does not carry, so a
// fixture holding one would be blessing prose the member never sees.
test("quoteBlocks returns no unquoted line, including at a run that ends the text", () => {
  assert.deepEqual(quoteBlocks("> only\nprose"), ["> only"]);
  assert.deepEqual(quoteBlocks("prose\n> last"), ["> last"]);
});

// The identifier names the block by what it BEGINS with. A later block that
// merely contains the same words is the copy a `text.indexOf(opener)` bound
// would have taken — this is the assertion that keeps `quoteBlock` from being
// that bound with extra steps.
test("quoteBlock returns the run that BEGINS with the opener, never one that merely contains it", () => {
  const text = "> a rule about stashing\n\n> never stash: a rule about stashing is above";
  assert.equal(quoteBlock(text, "never stash", "the fixture"), "> never stash: a rule about stashing is above");
  // The case above never exercises the `^` anchor: "never stash" is not a
  // substring of the non-matching block at all, so an unanchored
  // `new RegExp(phrase(opener).source)` would pass it exactly as the anchored
  // form does. This puts the opener MID-block instead, where only the `^`
  // anchor tells the two regexes apart.
  assert.throws(
    () => quoteBlock("> intro sentence never stash mid-block words", "never stash", "the fixture"),
    /no quote block opens/,
  );
});

// Reflow-safe for `paragraph`'s reason, one bound over: an opener that the
// source has wrapped is still that block's opener, and a literal `indexOf`
// would throw "block deleted" on a reflow the block survived intact.
test("quoteBlock finds a block whose opener is hard-wrapped across two lines", () => {
  assert.equal(quoteBlock("> Read the\n> issue first\n> and only then", "Read the issue first", "the fixture"), "> Read the\n> issue first\n> and only then");
});

// The two throws, and the false green each one denies. A golden mechanism whose
// extractor returns "" for a block it cannot find compares nothing against
// nothing and a DELETED block passes; one that returns the first of two takes
// the decoy and lets the real block be gutted.
test("quoteBlock throws when no block opens on the identifier, rather than returning nothing", () => {
  assert.throws(
    () => quoteBlock("> some other rule\n\nRead the issue first — unquoted now", "Read the issue first", "the fixture"),
    /the fixture: no quote block opens on "Read the issue first"/,
  );
});

test("quoteBlock throws when two blocks open on the identifier, rather than binding the first", () => {
  assert.throws(
    () => quoteBlock("> Read the issue first\n\n> Read the issue first, again", "Read the issue first", "the fixture"),
    /the fixture: 2 quote blocks open on "Read the issue first"/,
  );
});

// #1609. `logicalLines` exists for the pins that DERIVE their subjects from a
// document rather than look for words they already know, and every fixture
// below is a single-line scan of the shape that forced it —
// `see \*\*([^*\n]+)\*\*`, whose literal space and `\n`-free class are both
// load-bearing and both defeated by a wrap the reader cannot see.
const SEE = /see \*\*([^*\n]+)\*\*/g;
const names = (s) => [...s.matchAll(SEE)].map((m) => m[1]);

test("logicalLines joins a paragraph's wrapped lines and stops at the paragraph bound", () => {
  assert.deepEqual(names("see\n**Target**"), []);
  assert.deepEqual(names(logicalLines("see\n**Target**").text), ["Target"]);
  // The bound, and the false green losing it buys: a `see` ending one
  // paragraph would bind the `**Bold**` opening the NEXT one, and the scan
  // would report a pointer clause the document does not contain.
  assert.equal(logicalLines("tail see\n\n**Other**").text, "tail see\n\n**Other**");
});

test("logicalLines rejoins on exactly one space, whatever indent and trailing space the wrap left", () => {
  // Both trims matter to a literal-space scan and neither is visible in a
  // rendered document: the continuation's indent on one side, the trailing
  // whitespace an editor leaves behind on the other. Either one surviving
  // puts two spaces after `see` and the clause stops matching.
  assert.equal(logicalLines("see\n      **Target**").text, "see **Target**");
  assert.equal(logicalLines("see \n**Target**").text, "see **Target**");
  // A tab is whitespace an editor leaves, not markdown's hard break, so this
  // joins — `HARD_BREAK` is two SPACES, and the test above it holds that half.
  assert.equal(logicalLines("see \t\n\t **Target**").text, "see **Target**");
});

test("lineAt answers the PHYSICAL line a hit in the joined view came from", () => {
  // The whole reason the joined text is returned with a mapper rather than
  // alone: a pin that reports an offset into the joined copy names a line
  // number no reader can open. One-based, like an editor and like `grep -n`.
  const { text, lineAt } = logicalLines("# Heading\n\nfirst para\nwrapped on\nthree lines\n\nsee\n**Target**");
  assert.equal(lineAt(text.indexOf("# Heading")), 1);
  assert.equal(lineAt(text.indexOf("first para")), 3);
  assert.equal(lineAt(text.indexOf("wrapped on")), 4);
  assert.equal(lineAt(text.indexOf("three lines")), 5);
  assert.equal(lineAt(text.indexOf("**Target**")), 8);
  // The bisect's tie: an offset landing exactly ON a line's first character
  // answers that line, never the one before or after it.
  assert.equal(lineAt(0), 1);
  assert.equal(lineAt(text.length - 1), 8);
});

test("lineAt throws on an offset outside the joined view, rather than clamping it", () => {
  // A clamp returns a plausible-looking WRONG line number for a caller's own
  // bug — the same silent-wide-match failure `between`, `anchorAt` and
  // `quoteBlock` all refuse elsewhere in this file, by throwing instead of
  // guessing. `lineAt` only ever receives an offset a match on `text`
  // actually produced, so anything outside `[0, text.length)` is a defect
  // at the call site, not a document to open.
  const { lineAt } = logicalLines("a\nb\nc");
  assert.throws(() => lineAt(-5), /out of range/);
  assert.throws(() => lineAt(9999), /out of range/);
});

test("logicalLines never joins a line the reader sees as a new block", () => {
  // Joining only ever ADDS matches, so every one of these is a potential
  // pointer clause invented out of two unrelated blocks. A heading, a list
  // item, a blockquote, a table row and a thematic break each terminate their
  // predecessor on the page, so each must terminate it here.
  for (const next of ["## Heading", "- item", "* item", "+ item", "3. item", "> quoted", "| cell |", "---", "```js"]) {
    assert.equal(logicalLines(`see\n${next}`).text, `see\n${next}`, `joined a new block: ${next}`);
  }
});

test("logicalLines continues a list item but never a heading or a thematic break", () => {
  // The asymmetry, and the reason there are two regexes rather than one. A
  // list item and a blockquote take lazy continuation lines — that is where
  // the #1609 pointers actually live, inside a wrapped numbered step — while
  // a heading and a thematic break are complete on their own line. Collapsing
  // the two sets either loses every list-item wrap or swallows the paragraph
  // under a heading into the heading itself.
  assert.equal(logicalLines("1. step see\n   **Target**").text, "1. step see **Target**");
  assert.equal(logicalLines("- step see\n  **Target**").text, "- step see **Target**");
  assert.equal(logicalLines("> quoted see\n> more").text, "> quoted see\n> more");
  assert.equal(logicalLines("# Heading\nbody").text, "# Heading\nbody");
  assert.equal(logicalLines("---\ndescription: x").text, "---\ndescription: x");
});

test("logicalLines leaves fenced code exactly as written", () => {
  // A wrap inside prose is not semantic; a line break inside code is. Joining
  // a fenced block would hand any pin scanning code through this view a single
  // line that no shell, and no reader, would recognise.
  const fence = "prose see\n\n```sh\nfirst --flag\nsecond --flag\n```\n\nmore prose";
  assert.equal(logicalLines(fence).text, fence);
});

test("logicalLines keeps an authored hard line break", () => {
  // Two trailing spaces and a trailing backslash are markdown's line break —
  // the author asked for it, so it is not a wrap point to undo.
  assert.equal(logicalLines("see  \n**Target**").text, "see  \n**Target**");
  assert.equal(logicalLines("see\\\n**Target**").text, "see\\\n**Target**");
});

test("logicalLines keeps a block-leading span at column 0 and takes a wrap-leading one off it", () => {
  // The mirror direction, and the silent one. A `/^\*\*/m` scan means "leads a
  // block", and on raw bytes a reflow that happens to push a mid-paragraph
  // bold to column 0 mints a target the author never wrote — so a pointer
  // resolves to a block the wrap invented and the pin passes for free.
  const lead = /^\*\*([^*\n]+)\*\*/gm;
  const wrapped = "a sentence ending here\n**Not A Block** but mid-paragraph prose";
  assert.deepEqual([...wrapped.matchAll(lead)].map((m) => m[1]), ["Not A Block"]);
  assert.deepEqual([...logicalLines(wrapped).text.matchAll(lead)].map((m) => m[1]), []);
  // And the half that must still be ACCEPTED: a span that genuinely opens its
  // block stays at column 0 even when the rest of that block is wrapped, so
  // tightening `^` this way costs no real target.
  const real = "**A Real Block** whose own paragraph\nwraps onto a second line";
  assert.deepEqual([...logicalLines(real).text.matchAll(lead)].map((m) => m[1]), ["A Real Block"]);
});
