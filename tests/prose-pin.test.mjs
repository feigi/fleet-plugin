import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { tempDir } from "./support/temp-dir.mjs";

// The 14 consumer files exercise only between()'s HAPPY path: every one of them
// slices a document that still holds both anchors. Measured on this PR: deleting
// BOTH `assert.notEqual` guards left the full suite at 1035 pass / 0 fail, exit
// 0 — byte-identical to baseline. The guards are the entire reason this module
// was extracted rather than left inline, and nothing was pinning them.
//
// Fixtures here are short literal strings on purpose. Pinning the guards against
// a real document would re-couple this file to whatever review-core.mjs or a SKILL.md
// happens to say today, which is the rot the name-based citations elsewhere in
// this repo exist to avoid.

test("between returns the slice bounded by both anchors, start inclusive, end exclusive", () => {
  assert.equal(Pin.of("xxSTARTmiddleENDyy", "the fixture").between("START", "END", "the fixture").text, "STARTmiddle");
  // The start anchor is KEPT, the end anchor dropped — callers that need it
  // stripped do their own `.slice(from.length)`.
  assert.equal(Pin.of("aXbXc", "the fixture").between("X", "c", "the fixture").text, "XbX");
});

test("between throws when the text no longer contains the start anchor", () => {
  assert.throws(
    () => Pin.of("no anchors here", "the fixture").between("START", "END", "the fixture").text,
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
    () => Pin.of("ENDzzSTARTzz", "the fixture").between("START", "END", "the fixture").text,
    /the fixture no longer contains "END" after "START" — update this test/,
  );
  // And the same when the end anchor is absent outright.
  assert.throws(() => Pin.of("zzSTARTzz", "the fixture").between("START", "END", "the fixture").text, /no longer contains "END" after "START"/);
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
    assert.equal(Pin.of(doc, "doc").between("**start here**", "END", "the fixture", { emphasisTolerant: true }).text, expected);
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
    () => Pin.of(TWO_STATES, "TWO_STATES").between("the **RULE** —", "END", "the fixture", { emphasisTolerant: true }).text,
    /the fixture: emphasis-tolerant slice anchor "the \*\*RULE\*\* —" occurs 2 times once `\*\*` is ignored/,
  );
  // Exact-match, same fixture, same anchors: one hit, and the slice the
  // tolerant mode declined to widen past.
  assert.equal(Pin.of(TWO_STATES, "TWO_STATES").between("the **RULE** —", "END", "the fixture").text, "the **RULE** — and then it holds.\n\n");
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
    () => Pin.of(REPEATED_END, "REPEATED_END").between("HEAD one", "the **STOP** mark", "the fixture", { emphasisTolerant: true }).text,
    /the fixture: emphasis-tolerant slice end anchor "the \*\*STOP\*\* mark" occurs 2 times after the start once `\*\*` is ignored/,
  );
  assert.equal(Pin.of(REPEATED_END, "REPEATED_END").between("HEAD one", "the **STOP** mark", "the fixture").text, "HEAD one\n\nthe STOP mark, plain.\n\nmiddle\n\n");
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
    () => Pin.of("pad\n\n**start here**\n\nEND", "the fixture").between("**", "END", "the fixture", { emphasisTolerant: true }).text,
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
    Pin.of("**EDGE** early\n\nHEAD\n\nbody here\n\nEDGE late", "the fixture").between("HEAD", "**EDGE**", "the fixture", { emphasisTolerant: true }).text,
    "HEAD\n\nbody here\n\n",
  );
  assert.throws(
    () => Pin.of("**EDGE** early\n\nHEAD\n\nbody here", "the fixture").between("HEAD", "**EDGE**", "the fixture", { emphasisTolerant: true }).text,
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
  assert.equal(Pin.of("HEAD one **Put** two\n**Put the rest", "the fixture").between("HEAD", "\n**Put", "the fixture", { emphasisTolerant: true }).text, "HEAD one **Put** two");
  assert.equal(Pin.of("pad **HEAD** inline\nHEAD at line start\n\nEND", "the fixture").between("\n**HEAD**", "END", "the fixture", { emphasisTolerant: true }).text, "\nHEAD at line start\n\n");
});

// #491: a sibling item inserted between the anchors is the hole `bullet`
// closes, whatever marker it opens with — the #747 clamp this replaced looked
// only for `- **`, so a plain `- ` or numbered sibling still joined the slice.
test("bullet ends the item at the next sibling, whatever its marker, and never past the end anchor", () => {
  const list = (sibling) => `intro\n- **Edge A** first line\n  wraps here.\n${sibling} carries the words\n- **Edge B** more\n\nEND`;
  for (const sibling of ["- **Inserted**", "- inserted", "* inserted", "+ inserted", "3. inserted", "3) inserted"]) {
    assert.equal(Pin.of(list(sibling), "list()").bullet("- **Edge A**", "END", "the fixture").text, "- **Edge A** first line\n  wraps here.", sibling);
  }
  // No sibling before the end anchor: the end anchor bounds it, exclusive.
  assert.equal(Pin.of("- **Edge A** only item\nEND tail", "the fixture").bullet("- **Edge A**", "END", "the fixture").text, "- **Edge A** only item\n");
});

// The half a clamp can wrongly REFUSE: an item's own nested list, and its own
// wrapped lines, belong to it. A clamp at any `\n- ` or at any list marker
// regardless of indent cuts the item at its first child and drops the rest.
test("bullet keeps the item's own deeper-indented children and continuation lines", () => {
  const text = "- **Edge A** lead\n  continues\n  - child one\n    - grandchild\n  1. numbered child\n  tail line\n- **Edge B**\nEND";
  assert.equal(
    Pin.of(text, "text").bullet("- **Edge A**", "END", "the fixture").text,
    "- **Edge A** lead\n  continues\n  - child one\n    - grandchild\n  1. numbered child\n  tail line",
  );
  // An indented item's siblings are at ITS indent: a shallower marker ends it
  // too, a same-indent one ends it, a deeper one is its child.
  const nested = "1. step\n   - **Item** body\n     - child\n   - sibling\n2. next step\nEND";
  assert.equal(Pin.of(nested, "nested").bullet("- **Item**", "END", "the fixture").text, "- **Item** body\n     - child");
  assert.equal(Pin.of("1. step\n   - **Item** body\n2. next\nEND", "the fixture").bullet("- **Item**", "END", "the fixture").text, "- **Item** body");
});

test("bullet throws rather than widening when either anchor is gone", () => {
  assert.throws(() => Pin.of("- a\n- b\nEND", "the fixture").bullet("- **Edge A**", "END", "the fixture").text, /the fixture no longer contains "- \*\*Edge A\*\*" — update this test/);
  assert.throws(() => Pin.of("- **Edge A**\n- b\n", "the fixture").bullet("- **Edge A**", "END", "the fixture").text, /no longer contains "END" after "- \*\*Edge A\*\*"/);
});

// The item's content column is read off the anchor's own line, so an anchor
// on a line with no list marker has no item to bound: a wrapped line of an
// item, or a plain paragraph.
test("bullet throws when the anchor is not on a list-item line", () => {
  for (const text of ["- a\n  **A** wrapped\n- b\nEND", "intro\n\n**A** paragraph\nEND"]) {
    assert.throws(() => Pin.of(text, "text").bullet("**A**", "END", "the fixture").text, /the fixture: anchor is not on a list-item line: "\*\*A\*\*" — update this test/, text);
  }
});

// A marker with nothing after it on its own line is still a list-item line: its
// content starts on the next line, one column past the marker, so the indented
// line under it is the item's own and the next sibling marker ends it.
test("bullet takes a bare-marker anchor as a list-item line", () => {
  assert.equal(Pin.of("-\n  **A** body\n- b\nEND", "the fixture").bullet("-\n  **A**", "END", "the fixture").text, "-\n  **A** body");
  assert.equal(Pin.of("1.\n   **A** body\n2. b\nEND", "the fixture").bullet("1.\n   **A**", "END", "the fixture").text, "1.\n   **A** body");
  assert.equal(Pin.of("-  \n  **A** body\n\n  - deep child\n- b\nEND", "the fixture").bullet("-  \n  **A**", "END", "the fixture").text, "-  \n  **A** body\n\n  - deep child");
});

// Every marker character reads as a list-item line, not only `-` and `1.`.
test("bullet takes a `*` or `+` anchor as a list-item line", () => {
  assert.equal(Pin.of("* **A** body\n* b\nEND", "the fixture").bullet("* **A**", "END", "the fixture").text, "* **A** body");
  assert.equal(Pin.of("+ **A** body\n+ b\nEND", "the fixture").bullet("+ **A**", "END", "the fixture").text, "+ **A** body");
});

// #2077: a restatement need not be a list item to escape the item. A paragraph
// after a blank line, or a heading, quote, fence or rule, written shallower than
// the item's content ends the item in markdown, so it ends the slice too —
// otherwise the claim gutted from the item and restated there stays green.
test("bullet ends the item at a shallower non-list block, not only at a sibling marker", () => {
  const after = (block) => `intro\n- **Edge A** first line\n  wraps here.\n${block}\nrestates the words\n\nEND`;
  for (const block of ["\nPlain paragraph", "\n### Some other section", "### Some other section", "> quoted", "```", "~~~", "---", "***", " ## one-space heading"]) {
    assert.equal(Pin.of(after(block), "after()").bullet("- **Edge A**", "END", "the fixture").text, "- **Edge A** first line\n  wraps here.", block);
  }
  // Shallower than the CONTENT column is outside the item, even when deeper
  // than its marker: one space under a `- ` item is not its paragraph.
  assert.equal(Pin.of("- **Edge A** body\n\n Para at column one\nEND", "the fixture").bullet("- **Edge A**", "END", "the fixture").text, "- **Edge A** body");
  // A nested item's paragraph-level peer belongs to the PARENT item.
  assert.equal(Pin.of("1. step\n   - **Item** body\n\n   parent's paragraph\nEND", "the fixture").bullet("- **Item**", "END", "the fixture").text, "- **Item** body");
});

// The half the new bound can wrongly REFUSE: blocks written at the item's
// content column are the item's own, and a shallower plain line with no blank
// before it is a lazy continuation of the item's paragraph, which markdown
// renders inside the item.
test("bullet keeps the item's own paragraphs, blocks and lazy continuation lines", () => {
  const own = "- **Edge A** body\nlazy continuation\n\n  second paragraph\nlazy again\n\n  > own quote\n  ### own heading\n  ```\n  code\n\n  more code\n  ```\n- sibling\nEND";
  assert.equal(
    Pin.of(own, "own").bullet("- **Edge A**", "END", "the fixture").text,
    "- **Edge A** body\nlazy continuation\n\n  second paragraph\nlazy again\n\n  > own quote\n  ### own heading\n  ```\n  code\n\n  more code\n  ```",
  );
  // The content column follows the marker's width and the gap after it — and
  // a gap over 4 counts as 1, the rest being an indented code block.
  assert.equal(Pin.of("10.  **Item** body\n\n     own paragraph\n11. next\nEND", "the fixture").bullet("**Item**", "END", "the fixture").text, "**Item** body\n\n     own paragraph");
  assert.equal(Pin.of("-     **Item** code\n\n  own paragraph\n- next\nEND", "the fixture").bullet("**Item**", "END", "the fixture").text, "**Item** code\n\n  own paragraph");
  // A tab-indented child of a space-indented item is still its child.
  assert.equal(Pin.of("- **Edge A** body\n\t- tab child\n- sibling\nEND", "the fixture").bullet("- **Edge A**", "END", "the fixture").text, "- **Edge A** body\n\t- tab child");
  // A blank line, then a nested item at or past the content column: the
  // item's own child, not the end of it.
  assert.equal(Pin.of("- **A** body\n\n  - deep child\nEND", "the fixture").bullet("- **A**", "END", "fixture").text, "- **A** body\n\n  - deep child\n");
  assert.equal(Pin.of("- **A** body\n\n   - deeper child\nEND", "the fixture").bullet("- **A**", "END", "fixture").text, "- **A** body\n\n   - deeper child\n");
});

// #2077: the item line is the one `from`'s first non-whitespace character sits
// on, and the walk starts after `from`'s trailing whitespace. Read off `from`'s
// first CHARACTER, a leading-`\n` anchor measures the previous line; started at
// `from.length`, a trailing-`\n` anchor has already eaten the newline the next
// line's check needs. Each probe widened or narrowed the slice silently.
test("bullet measures the item from the anchor's text, not its surrounding newlines", () => {
  assert.equal(Pin.of("- parent\n  - **A** body\n  - sibling\n- next\nEND", "the fixture").bullet("\n  - **A**", "END", "the fixture").text, "\n  - **A** body");
  assert.equal(Pin.of("intro\n  indented prose\n- **A** body\n  - child\n- sib\nEND", "the fixture").bullet("\n- **A**", "END", "the fixture").text, "\n- **A** body\n  - child");
  assert.equal(Pin.of("- **A** body\n- sib\nEND", "the fixture").bullet("- **A** body\n", "END", "the fixture").text, "- **A** body\n");
});

// #2077: indent is compared in visual columns, a tab advancing to the next
// multiple of 4 (CommonMark's tab stop). Counted in characters, a one-tab item
// read a two-space sibling as its own deeper child and kept it. The items sit
// under a parent item so CommonMark reads them as a list: after a plain `intro`
// line the tab item is continuation text of that paragraph, and after a blank
// line it is indented code.
test("bullet compares tab and space indentation by column, not by character count", () => {
  assert.equal(Pin.of("- parent\n\t- **A** body\n  - two-space sibling\n\t- **B**\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, "- **A** body");
  // The tab puts this item's text at column 6; four spaces is 3 characters
  // deeper than the tab by count, and still a sibling by column.
  assert.equal(Pin.of("- parent\n\t- **A** body\n    - four-space sibling\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, "- **A** body");
});

// #2091 (hand-dispatched review, correctness): a marker with nothing after
// it on its own line — content on the next, indented line — is still a
// separate list item in CommonMark, not a lazy continuation of the item
// above it. `[ \t]` alone missed this shape; `(?:[ \t]|$)` catches the
// marker whether or not anything follows it on the same line.
test("bullet ends the item at a bare-marker sibling, with nothing after the marker on its own line", () => {
  assert.equal(Pin.of("- **A** body\n-\n  restated claim\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, "- **A** body");
  assert.equal(Pin.of("- **A** body\n2.\n   restated claim\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, "- **A** body");
});

// #2091 (hand-dispatched review, correctness): a thematic break may space its
// repeated character out (CommonMark), not only run it together. `-`-spaced
// forms already end the item via ITEM_MARKER; `_`/`*` have no such fallback.
test("bullet ends the item at a spaced thematic break, not only a run-together one", () => {
  assert.equal(Pin.of("- **A** body\n_ _ _\nafter\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, "- **A** body");
  assert.equal(Pin.of("- **A** body\n* * *\nafter\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, "- **A** body");
});

// #2100: a line 4+ columns past the item's marker, with no blank line before
// it, cannot open a heading, quote, fence, break or list item there — it is
// lazy continuation of the item's paragraph. Reachable only when the content
// column is past marker column + 4 (a `100.` marker, or a 4-space gap). Every
// expected slice here was checked against the `commonmark` npm package (0.31).
test("bullet keeps a marker or interrupt line 4+ columns past the item's marker as lazy continuation", () => {
  for (const [text, expected] of [
    ["100. **Item** body\n    # x\nEND", "**Item** body\n    # x\n"],
    ["-    **Item** body\n    # x\nEND", "**Item** body\n    # x\n"],
    ["100. **Item** body\n    ```x\nEND", "**Item** body\n    ```x\n"],
    ["100. **Item** body\n    > x\nEND", "**Item** body\n    > x\n"],
    ["1. a\n   100. **Item** body\n       # x\nEND", "**Item** body\n       # x\n"],
    ["1. a\n\n   100. **Item** body\n       # x\nEND", "**Item** body\n       # x\n"],
    ["100. **Item** body\n    - x\nEND", "**Item** body\n    - x\n"],
    ["100. **Item** body\n\t# x\nEND", "**Item** body\n\t# x\n"],
  ]) {
    assert.equal(Pin.of(text, "text").bullet("**Item**", "END", "the fixture").text, expected, text);
  }
});

// The half the #2100 cap must not wrongly KEEP: short of marker column + 4 the
// line still ends the item, and a blank line before it ends the item at any
// depth. Same commonmark check.
test("bullet still ends the item at a marker or interrupt line short of its marker column + 4, or after a blank line", () => {
  for (const text of [
    "100. **Item** body\n   # x\nEND",
    "1. a\n   - b\n     - **Item** body\n    # x\nEND",
    "1. a\n\n   100. **Item** body\n      # x\nEND",
    "100. **Item** body\n\n    # x\nEND",
  ]) {
    assert.equal(Pin.of(text, "text").bullet("**Item**", "END", "the fixture").text, "**Item** body", text);
  }
});

// A list-item anchor is a start anchor, never a "nearest" bound, so a second
// copy means the item would be read off whichever comes first.
test("bullet throws when the item anchor occurs more than once", () => {
  assert.throws(() => Pin.of("- **A** one\n- **A** two\nEND", "the fixture").bullet("- **A**", "END", "the fixture").text, /the fixture: list-item anchor "- \*\*A\*\*" occurs 2 times/);
});

// `\s+` between words, never a literal space: the prose these match against is
// hard-wrapped, so any inter-word space in the source may be a newline plus
// indent. Replacing the join with " " passes a single-line fixture and fails
// this one.
test("phrase matches a hard-wrapped phrase across a newline and indent", () => {
  assert.match("a paragraph that refuses\n  rather than passing, wrapped", Pin.phrase("refuses rather than passing"));
  assert.match("tab-indented:\trefuses\n\t\trather than\n\tpassing", Pin.phrase(" refuses rather than passing "));
});

// Escaping is what keeps an anchor a LITERAL. Each negative assertion below is
// the whole point: unescaped, `(b)` is a capture group that matches "a b c",
// `.` matches any character, and `$` is an end-of-input anchor that matches
// nothing after it. Drop the escape and the regex silently matches text the
// anchor does not appear in — a pin that passes against the wrong prose.
test("phrase escapes regex metacharacters taken from its input", () => {
  assert.match("call exit (2) now", Pin.phrase("exit (2)"));
  assert.doesNotMatch("call exit 2 now", Pin.phrase("exit (2)"));

  assert.match("pinned at v1.2 today", Pin.phrase("v1.2"));
  assert.doesNotMatch("pinned at v1x2 today", Pin.phrase("v1.2"));

  assert.match("costs $5 per run", Pin.phrase("costs $5"));
  assert.doesNotMatch("costs 5 per run", Pin.phrase("costs $5"));

  // `*` and `+` are quantifiers, and a leading one is a SyntaxError rather than
  // a wrong match — so an unescaped anchor starting with either throws at
  // construction instead of failing an assertion.
  assert.doesNotThrow(() => Pin.phrase("*.mjs"));
  assert.match("run node --test *.mjs here", Pin.phrase("*.mjs"));
});

// #1940: the shared sentence bound, at both of the ends the first-period
// `[^.]*` scan it replaced got wrong — it ran on past `?` and `!`, and it
// stopped at every period, a word's or an abbreviation's included. The
// closing marks are the case that scan happened to get right and a bare
// `[.!?]\s` split does not: a bold lead-in sentence, a shape run-team's
// SKILL.md uses throughout, would otherwise join the sentence after it.
test("sentences ends a sentence at `?` and `!`, and at a terminator behind closing marks", () => {
  assert.deepEqual(Pin.sentences("Why pin now? It is late! Pin it."), ["Why pin now?", "It is late!", "Pin it."]);
  assert.deepEqual(
    Pin.sentences('**Pin first.** Then read. (Both run.) Next. "Say it." After. _Done._ End'),
    ["**Pin first.**", "Then read.", "(Both run.)", "Next.", '"Say it."', "After.", "_Done._", "End"],
  );
  // A hard wrap is whitespace like any other, so a rewrap moves no end.
  assert.deepEqual(Pin.sentences("Pin it.\n   Then\n   read."), ["Pin it.", "Then\n   read."]);
});

test("sentences does not end one at an abbreviation, closing marks or not, nor at a period inside a word", () => {
  for (const s of [
    "Pin it, e.g. now, then read.",
    "Pin it early (e.g.) and then read.",
    "Pin it, i.e. first, cf. the rule, viz. step 0, vs. later.",
    "Run instruments.sh at v1.2 first.",
  ]) {
    assert.deepEqual(Pin.sentences(s), [s]);
  }
  // "etc." is deliberately off the list: it ends a sentence as often as not.
  assert.deepEqual(Pin.sentences("Pin, read, etc. Then go."), ["Pin, read, etc.", "Then go."]);
});

// #1899: the abbreviations are matched lowercase only. Folded case, a sentence
// really ending in a word that shares their letters — a proper noun "Vs." —
// was read as the abbreviation and joined to the next, two real sentences one.
test("sentences ends one at a capitalized abbreviation lookalike, and still skips the lowercase abbreviation", () => {
  for (const word of ["Vs.", "VS.", "E.g.", "E.G.", "I.e.", "Cf.", "CF.", "Viz.", "VIZ."]) {
    assert.deepEqual(Pin.sentences(`Pin it for the ${word} Then read.`), [`Pin it for the ${word}`, "Then read."], word);
  }
  // The accept side, in the same fixture shape: lowercase stays one sentence.
  for (const abbr of ["vs.", "e.g.", "i.e.", "cf.", "viz."]) {
    const s = `Pin it for the ${abbr} Then read.`;
    assert.deepEqual(Pin.sentences(s), [s], abbr);
  }
});

// #2053: the guard before the abbreviation was a `\b`, which reads `_` as a
// word character, so an italic abbreviation ended its own sentence
// mid-abbreviation. Only a letter or digit glued on disqualifies one — the
// guard citation-sweep's SENTENCE_END and jsonCountFault's re-split carry.
test("sentences does not end one at an italic abbreviation, and still ends one at a word merely ending in its letters", () => {
  for (const abbr of ["e.g.", "i.e.", "cf.", "viz.", "vs."]) {
    const s = `Pin it, _${abbr}_ now, then read.`;
    assert.deepEqual(Pin.sentences(s), [s], abbr);
  }
  for (const word of ["Xvs.", "26vs.", "gcf.", "Xe.g."]) {
    assert.deepEqual(Pin.sentences(`Pin it for the ${word} Then read.`), [`Pin it for the ${word}`, "Then read."], word);
  }
  // The disclosed cost, in the same fixture shape as #1899's own accepted
  // one above: a bare snake_case word ending in the abbreviation's letters —
  // no italic markup, just an underscore glued on — now joins too. Locked in
  // here so a future narrowing or widening of the guard cannot drift this
  // cost silently.
  for (const abbr of ["e.g.", "i.e.", "cf.", "viz.", "vs."]) {
    const s = `Pin it for the snake_${abbr} Then read.`;
    assert.deepEqual(Pin.sentences(s), [s], abbr);
  }
});

// #1987: a footnote-style marker between a terminator and the whitespace
// after it — `.[1]`, `![note]`, `.[^1]`, a run of them — ended no sentence,
// so two real ones merged and a pin scoped to the first could borrow a word
// from the second. The marker stays with the sentence it annotates, a closing
// mark after it still counts, and whatever closes the word before the
// terminator — a letter in any script, a digit, a code span, a paren, a curly
// quote — lets it end one, whatever closed it. It still counts with combining
// marks on it (#2041): an NFD "é" is `e` + U+0301 and Devanagari "हिंदी" ends
// in the vowel sign U+0940, so the word's last code point is a mark, not a
// letter, and before the fix both merged.
test("sentences ends a sentence behind a footnote-style bracket marker", () => {
  assert.deepEqual(
    Pin.sentences("Pass `--quiet`; ci-state.mjs drops `jobs`.[1] Elsewhere, `missing` is unaffected."),
    ["Pass `--quiet`; ci-state.mjs drops `jobs`.[1]", "Elsewhere, `missing` is unaffected."],
  );
  for (const end of [
    "late![note]",
    "late?[^1]",
    "late.[1][2]",
    "late.[1])",
    "late.[12]\u201d",
    "late.[1]",
    "(late).[1]",
    "\u201clate\u201d.[1]",
    "\u2018late\u2019.[1]",
    "at 12.[1]",
    "at the caf\u00e9.[1]",
    "at the cafe\u0301.[1]",
    "\u092f\u0939 \u0939\u093f\u0902\u0926\u0940.[1]",
    "v\u1ec7.[1]",
    "ve\u0323\u0302.[1]",
    "at 1\u20e3.[1]",
  ]) {
    assert.deepEqual(Pin.sentences(`Pin it ${end}\nThen read.`), [`Pin it ${end}`, "Then read."], end);
  }
  // #2041's own repros, verbatim.
  assert.deepEqual(Pin.sentences("At the cafe\u0301.[1] Then read."), ["At the cafe\u0301.[1]", "Then read."]);
  assert.deepEqual(
    Pin.sentences("\u092f\u0939 \u0939\u093f\u0902\u0926\u0940.[1] Then read."),
    ["\u092f\u0939 \u0939\u093f\u0902\u0926\u0940.[1]", "Then read."],
  );
});

// The accept side of #1987: a bracket only ends a sentence as a marker — one
// that holds something and no whitespace, straight behind a terminator that
// closes a word, with whitespace after it. Code quoted in prose carries the
// other shapes: a jq path or filter, an optional-chained index, a glob, an
// array index mid-sentence; and a link after a period is no marker either.
test("sentences does not end one at a bracket that is code, a link or an index, nor at an abbreviation's marker", () => {
  for (const s of [
    "Read `.[].number` from each, then stop.",
    "Read `gh api -q '.[] | .name'` first, then stop.",
    "Read `'.[0] | .x'` first, then stop.",
    "Read `.jobs.[] | .name` first, then stop.",
    "Read `.jobs.[0, 1] | .name` first, then stop.",
    'Read `jq ".[0] | .x"` first, then stop.',
    "Read `m?.[1] || null` first, then stop.",
    "Read `git tag --list 'v[0-9]*.[0-9]*' | sort` first, then stop.",
    "Read `jobs[1] and more` first, then stop.",
    "Read it.[the docs](https://example.com) first, then stop.",
    "Read it.[1]: first, then stop.",
    "Read it, e.g.[1] first, then stop.",
    // #2041: a combining mark only counts atop one of the bases above — one
    // with no accepted base under it, straight after a space or another
    // rejected character, closes no word, however many marks pile onto it.
    "Read it \u0301.[1] first, then stop.",
    "Read it,\u0301\u0302.[1] first, then stop.",
  ]) {
    assert.deepEqual(Pin.sentences(s), [s], s);
  }
});

// #1346/#1361/#1619: the `.mjs`-header-comment gutter shape, exercised by
// candidates-exit3-prose.test.mjs and review-core-unrun.test.mjs against a
// real header, but pinned here as its own dedicated guard: a guard with no
// dedicated test is a guard nobody is pinning.
test("stripSlashGutter strips a leading `// ` and leaves everything else untouched", () => {
  assert.equal(Pin.of("// dispatch it", "the fixture").stripGutter("//").text, "dispatch it");
  assert.equal(Pin.of("  //no space after slash", "the fixture").stripGutter("//").text, "no space after slash");
  // A trailing comment is not a whole-line gutter — stripping mid-line
  // would turn code-with-a-note into a false comment line.
  assert.equal(Pin.of('const x = 1; // not a comment line', "the fixture").stripGutter("//").text, 'const x = 1; // not a comment line');
  assert.equal(Pin.of("plain code\nmore code", "the fixture").stripGutter("//").text, "plain code\nmore code");
});

// `paragraph`'s halves are its bound, its anchor and the block it says follows,
// and each has its own false green. The bound: without the blank-line cut the
// slice runs to the end of the document and a decoy copy of the wording
// anywhere below satisfies the pin. The anchor: routed through `phrase()`
// rather than a literal `indexOf`, so a rewrap that the pinned clause survives
// does not red the pin — the false POSITIVE that a literal anchor introduces.
// Two throws keep the anchor honest: a moved one never widens the slice back to
// the whole file, and a duplicated one never binds the pin to the wrong copy.
// The next block: see the tests on `next` below.
test("paragraph cuts at the blank line, so a decoy below the rule cannot satisfy a pin", () => {
  const doc = "intro\n\nTHE RULE says do X.\nstill the rule.\n\nlater prose.\n\na stray copy says do X.\n";
  assert.equal(Pin.of(doc, "doc").paragraph("THE RULE", "the fixture", "later prose.").text, "THE RULE says do X.\nstill the rule.");
  // The decoy is real: unbounded, the whole document contains the wording twice.
  assert.doesNotMatch(Pin.of("THE RULE says do Y.\n\na stray copy says do X.\n", "the fixture").paragraph("THE RULE", "the fixture", "a stray copy").text, Pin.phrase("do X"));
});

// The decoy above sits below a CLEAN blank line, so it passes both before and
// after the bound moved off the literal `\n\n` — it cannot see that
// regression. This one can: an editor keeping a list item's indent writes a
// blank line carrying whitespace, which `indexOf("\n\n")` does not find, and
// the slice then runs past the paragraph onto the decoy.
test("paragraph cuts at a blank line that carries whitespace", () => {
  assert.doesNotMatch(Pin.of("THE RULE says do Y.\n   \na stray copy says do X.\n", "the fixture").paragraph("THE RULE", "the fixture", "a stray copy").text, Pin.phrase("do X"));
});

// The bound's mirror image: an anchor matching twice binds the pin to
// whichever copy comes first, so the real rule below can be gutted with the
// suite green.
test("paragraph throws when its anchor matches twice, rather than binding the wrong copy", () => {
  assert.throws(
    () => Pin.of("THE RULE says do X.\n\nprose.\n\nTHE RULE says do X.\n", "the fixture").paragraph("THE RULE", "the fixture", "prose.").text,
    /the fixture: slice anchor "THE RULE" occurs 2 times — a pin would bind the wrong copy; narrow the anchor/,
  );
});

test("paragraph anchors reflow-safely — a hard-wrapped anchor still matches", () => {
  const doc = "**a long anchor\n   spanning a wrap** and the rule.\n\nnext.\n";
  assert.match(Pin.of(doc, "doc").paragraph("**a long anchor spanning a wrap**", "the fixture", "next.").text, Pin.phrase("and the rule"));
});

test("paragraph throws when its anchor moved, rather than widening to the whole file", () => {
  assert.throws(
    () => Pin.of("no anchor here\n\nGONE\n", "the fixture").paragraph("MISSING ANCHOR", "the fixture", "GONE").text,
    /the fixture: slice anchor "MISSING ANCHOR" moved — re-anchor this test, never widen it to the whole file/,
  );
});

// The hole `next` closes. The pinned clause gutted, its words restated in the
// next paragraph, and the blank line between the two deleted: the paragraphs
// merge, so the slice takes both and the restated copy satisfies the pin. The
// intact document is the control — the copy in the next block is outside the
// slice there.
test("paragraph throws when a deleted blank line merged the next block into the slice", () => {
  assert.doesNotMatch(Pin.of("THE RULE says do Y.\n\nlater prose. To be clear, do X.\n", "the fixture").paragraph("THE RULE", "the fixture", "later prose.").text, Pin.phrase("do X"));
  // No blank line left anywhere after the anchor: the slice would run to the end.
  assert.throws(
    () => Pin.of("THE RULE says do Y.\nlater prose. To be clear, do X.\n", "the fixture").paragraph("THE RULE", "the fixture", "later prose.").text,
    /the fixture: no blank line follows "THE RULE" — the slice would run to the end of the document; name END if this is the last block/,
  );
  // A blank line further down: the slice ends there, but not before `next`.
  assert.throws(
    () => Pin.of("THE RULE says do Y.\nlater prose. To be clear, do X.\n\nother block.\n", "the fixture").paragraph("THE RULE", "the fixture", "later prose.").text,
    /the fixture: the text after the blank line following "THE RULE" no longer opens with "later prose\."/,
  );
});

// A blank line carrying whitespace is a blank line, so the next block opening
// right after it, indented or not, is the expected shape and not a refusal.
test("paragraph accepts the next block after a blank line that carries whitespace, and an indented opening", () => {
  assert.equal(Pin.of("THE RULE says do Y.\n  \n  later prose.\n", "the fixture").paragraph("THE RULE", "the fixture", "later prose.").text, "THE RULE says do Y.");
});

// A reflow of `next` is not a moved block: `phrase()` joins its words on `\s+`.
test("paragraph matches next reflow-safely", () => {
  assert.equal(Pin.of("THE RULE says do Y.\n\nlater\n   prose here.\n", "the fixture").paragraph("THE RULE", "the fixture", "later prose here.").text, "THE RULE says do Y.");
});

// Stricter than "the next block starts somewhere after the blank line": a
// decoy paragraph inserted between the block and its `next` is an accepted
// loud red, since tolerating it would reopen the hole in two steps (insert a
// decoy, then delete the blank line before it).
test("paragraph throws when a paragraph was inserted between the block and its next", () => {
  assert.throws(
    () => Pin.of("THE RULE says do Y.\n\ndecoy paragraph.\n\nlater prose. do X.\n", "the fixture").paragraph("THE RULE", "the fixture", "later prose.").text,
    /the fixture: the text after the blank line following "THE RULE" no longer opens with "later prose\."/,
  );
});

test("paragraph throws when next is omitted, or is an options object from an unmigrated caller", () => {
  const doc = "THE RULE says do Y.\n\nlater prose.\n";
  assert.throws(() => Pin.of(doc, "doc").paragraph("THE RULE", "the fixture").text, /the fixture: paragraph\(\) needs `next`/);
  assert.throws(() => Pin.of(doc, "doc").paragraph("THE RULE", "the fixture", { emphasisTolerant: true }).text, /the fixture: paragraph\(\) needs `next`/);
  assert.throws(() => Pin.of(doc, "doc").paragraph("THE RULE", "the fixture", "").text, /the fixture: paragraph\(\) needs `next`/);
});

// A tolerant caller's anchor survives a `**` move; its `next` must too, or a
// document that merely loses the emphasis in the next block's opening reds.
test("paragraph with emphasisTolerant reads next through the same emphasis stripping as the anchor", () => {
  const doc = "**THE RULE** says do Y.\n\n**Later** prose.\n";
  assert.equal(Pin.of(doc, "doc").paragraph("THE RULE", "the fixture", "Later prose.", { emphasisTolerant: true }).text, "**THE RULE** says do Y.");
  assert.throws(() => Pin.of(doc, "doc").paragraph("THE RULE", "the fixture", "Later prose.").text, /no longer opens with "Later prose\."/);
});

// `END` names the last block: nothing but whitespace may follow its slice, so a
// block appended after it is an accepted loud red, while a document ending with
// no blank line, or with trailing blank lines, is the last block as written.
test("paragraph with END returns the last block, and throws when a block follows it", () => {
  assert.equal(Pin.of("x\n\nTHE RULE ends here.", "the fixture").paragraph("THE RULE", "the fixture", Pin.END).text, "THE RULE ends here.");
  assert.equal(Pin.of("x\n\nTHE RULE ends here.\n", "the fixture").paragraph("THE RULE", "the fixture", Pin.END).text, "THE RULE ends here.\n");
  assert.equal(Pin.of("THE RULE ends here.\n\n\n", "the fixture").paragraph("THE RULE", "the fixture", Pin.END).text, "THE RULE ends here.");
  assert.throws(
    () => Pin.of("THE RULE ends here.\n\nan appended paragraph.\n", "the fixture").paragraph("THE RULE", "the fixture", Pin.END).text,
    /the fixture: slice anchor "THE RULE" is declared the last block \(END\), but text follows its blank line/,
  );
});

// `betweenPhrases`'s two halves are `paragraph`'s bound (an `anchorAt` start)
// and a phrase end instead of a blank line — so it has `paragraph`'s anchor
// false green (a moved or duplicated `from`) plus a matching pair on `to`:
// unbounded, a `to` reworded away and restated later silently widens the
// slice into whatever follows; duplicated inside `bound`, the slice binds
// the wrong copy. Extracted (#1611) from `finisher-dispatch-premise-prose
// .test.mjs`'s hand-rolled `dispatchPremise`.
test("betweenPhrases returns the slice bounded by a phrase start and a phrase end, from inclusive, to exclusive", () => {
  const doc = "intro\nSTART here.\nmiddle text spans\n   two lines.\nCUT it here.\nmore after.\n";
  assert.equal(Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture").text, "START here.\nmiddle text spans\n   two lines.\n");
});

test("betweenPhrases throws when the from anchor moved, rather than widening to the whole file", () => {
  assert.throws(
    () => Pin.of("no anchors here", "the fixture").betweenPhrases("START here", "CUT it", "the fixture").text,
    /the fixture: slice anchor "START here" moved — re-anchor this test, never widen it to the whole file/,
  );
});

test("betweenPhrases throws when the to phrase no longer occurs after the from anchor", () => {
  assert.throws(
    () => Pin.of("START here.\nno closing phrase follows.\n", "the fixture").betweenPhrases("START here", "CUT it", "the fixture").text,
    /the fixture: slice end anchor "CUT it" moved — re-anchor this test, never widen it to the whole file/,
  );
});

test("betweenPhrases throws when the to phrase occurs more than once, rather than binding the wrong copy", () => {
  assert.throws(
    () => Pin.of("START here.\nCUT it once.\nCUT it twice.\n", "the fixture").betweenPhrases("START here", "CUT it", "the fixture").text,
    /the fixture: slice end anchor "CUT it" occurs 2 times — a pin would bind the wrong copy; narrow the anchor/,
  );
});

// Same duplicate, but with a `bound` supplied — the message names the bound
// here because the caller gave one; the unbounded test above must NOT, or a
// bound-scoped failure and a whole-document failure read identically.
test("betweenPhrases throws when the to phrase occurs more than once inside the bound, naming the bound in the message", () => {
  const doc = "START here.\nCUT it once.\nCUT it twice.\n---\nafter the bound.\n";
  assert.throws(
    () => Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound: /\n---\n/ }).text,
    /the fixture: slice end anchor "CUT it" occurs 2 times inside the bound — a pin would bind the wrong copy; narrow the anchor/,
  );
});

// `bound` exists so a `to` reworded away cannot silently resolve to a LATER,
// unrelated copy past a structural boundary — the same false green `between`'s
// own header describes for an unbounded end anchor. Unbounded, this fixture's
// only copy of `to` sits past the boundary and the slice silently widens past
// it; bounded, that copy falls outside the search and the throw fires instead.
test("betweenPhrases: a bound stops the search there, rather than reaching a later copy of `to`", () => {
  const doc = "START here.\nreal middle before bound.\n---\nCUT it after the bound.\n";
  assert.throws(
    () => Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound: /\n---\n/ }).text,
    /the fixture: slice end anchor "CUT it" lies past the end bound, which first matched at line 3 \("---"\)/,
  );
  assert.equal(
    Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture").text,
    "START here.\nreal middle before bound.\n---\n",
  );
});

// A bound that matches BEFORE an intact `to` — here a wrap that put
// `3.` at column 0, which CommonMark renders as a new list item — used to
// report `slice end anchor "…" moved`, sending a reader after an edit to an
// anchor nobody touched. The anchor did not move; the bound did. Still a
// throw either way, so the message is the whole of the change: it names the
// line the bound first matched. A `to` found NOWHERE after `from` keeps
// "moved", and a `to` the bound cuts through the middle of counts as past it.
test("betweenPhrases names the bound's line, not a moved anchor, when the bound matches before an intact `to`", () => {
  const doc = "1. START here, fix it and repeat from\n3. then CUT it here.\n4. the next item.\n";
  const bound = /\n\d+\.\s/;
  const pastBound = /the fixture: slice end anchor "(CUT it|from 3\. then)" lies past the end bound, which first matched at line 2 \("3\. then CUT it here\."\)/;
  assert.throws(() => Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound }).text, pastBound);
  assert.throws(() => Pin.of(doc, "doc").betweenPhrases("START here", "from 3. then", "the fixture", { bound }).text, pastBound);
  assert.throws(
    () => Pin.of(doc.replace("CUT it", "SNIP it"), "the fixture").betweenPhrases("START here", "CUT it", "the fixture", { bound }).text,
    /the fixture: slice end anchor "CUT it" moved — re-anchor this test, never widen it to the whole file/,
  );
});

// The excerpt truncates a long bound-matched line rather than dumping it
// whole — every existing fixture in this bound-scoped family is short enough
// to pass through `line.length > 72` untouched, so nothing else in this
// suite would catch the threshold, or the truncate-with-ellipsis format,
// silently drifting or being dropped.
test("betweenPhrases truncates a long bound-matched line in its excerpt", () => {
  const line2 =
    "3. then CUT it here, followed by enough filler words to push this line well past seventy two characters total.";
  const doc = `1. START here, fix it and repeat from\n${line2}\n4. the next item.\n`;
  assert.throws(
    () => Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound: /\n\d+\.\s/ }).text,
    /the fixture: slice end anchor "CUT it" lies past the end bound, which first matched at line 2 \("3\. then CUT it here, followed by enough filler words to push this line w…"\)/,
  );
});

// Every bound above opens with `\n` and then a content character, so the
// named line is where that content sits. A bound made of line breaks — a
// blank line (`\n\n`), a whitespace-only line (`\n\s*\n`), a zero-width
// `^$` — has no content character to land on, and #2268 measured the message
// skipping past every blank line to the next paragraph's text, a line the
// bound never touched. The line named is the blank line itself: the match's
// leading `\n` terminates the text before the match and is skipped, but only
// that one.
test("betweenPhrases names the blank line a line-break bound matched, not the next paragraph's text", () => {
  const pastBound = (line, excerpt) =>
    new RegExp(`the fixture: slice end anchor "CUT it" lies past the end bound, which first matched at line ${line} \\("${excerpt}"\\)`);
  const run = (doc, bound) => () => Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound }).text;
  assert.throws(run("START here.\nmiddle.\n\n\n\nnext para, CUT it here.\n", /\n\n/), pastBound(3, ""));
  assert.throws(run("START here.\nmiddle.\n   \nnext para, CUT it here.\n", /\n\s*\n/), pastBound(3, "   "));
  assert.throws(run("START here.\nmiddle.\n\nnext para, CUT it here.\n", /^$/m), pastBound(3, ""));
});

// A `bound` that never matches the remaining text is a caller error, not an
// invitation to fall back to an unbounded search — that fallback is exactly
// the false green `bound` exists to prevent: a `to` reworded away could still
// be satisfied by an unrelated LATER decoy once the search reopens the whole
// document. This fixture's only `to` copy sits BEFORE where the bound would
// have been, so the old unbounded fallback would find it and return silently;
// the fix must throw instead, before ever searching for `to`.
test("betweenPhrases throws when the bound never matches, rather than silently searching the whole document", () => {
  const doc = "START here.\nCUT it once.\n";
  assert.throws(
    () => Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound: /\n---\n/ }).text,
    /the fixture: end bound no longer matches after "START here" — re-anchor this test, never widen it to the whole document/,
  );
});

// The "occurs more than once" assert is scoped to `bound`, not the whole rest
// of the document: a restatement of `to` PAST the bound must not count, or a
// pin could never pass once any later, unrelated copy of the same phrase
// exists anywhere below it. This fixture has exactly one `to` inside the
// bound and a second, decoy copy after it.
test("betweenPhrases does not count a `to` phrase restated past the bound as a duplicate", () => {
  const doc = "START here.\nCUT it once.\n---\nCUT it again, but after the bound.\n";
  assert.equal(
    Pin.of(doc, "doc").betweenPhrases("START here", "CUT it", "the fixture", { bound: /\n---\n/ }).text,
    "START here.\n",
  );
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
  assert.equal(Pin.of("pad\n\nTHE RULE says X.", "the fixture").anchorAt("THE RULE", "the fixture"), 5);
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
  assert.equal(Pin.of(src, "src").runAbove("const TARGET", "the fixture", "//").text, "// the real block\n// still it\n");
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
  assert.equal(Pin.of(sh, "sh").runAbove("gp_sep=$(printf '\\002')", "the fixture", "#").text, "  # the note\n  # and its second line\n");
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
  assert.equal(Pin.of(src, "src").runAbove("const TARGET", "the fixture", "//").text, "// doc\n// still\n");
});

// #1622: the tail bound's keyword-chain tolerance is `)*$`, not `)?$` — the
// PR's own rationale names multi-keyword prefixes like `export default async
// function` and `export abstract class` as the intended case, not just a
// single modifier. A narrowed quantifier that only tolerated one token would
// still pass the single-keyword fixture above while silently regressing
// this one.
test("runAbove accepts a same-line chain of multiple keyword prefixes", () => {
  const src = "// doc\n// still\nexport default async function TARGET() {}\n";
  assert.equal(Pin.of(src, "src").runAbove("TARGET", "the fixture", "//").text, "// doc\n// still\n");
});

// #1622: `DECLARATION_PREFIX_KEYWORDS` is a closed, bounded list, not
// arbitrary text tolerated before the anchor. A same-line token that is not
// one of the declaration/modifier keywords must still refuse the run, or
// the guard this PR advertises is unenforced and any prefix would slip
// through.
test("runAbove refuses a same-line prefix that is not a declaration keyword", () => {
  const src = "// doc\n// still\nsomeCode TARGET = 2;\n";
  assert.equal(Pin.of(src, "src").runAbove("TARGET", "the fixture", "//").text, "");
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
  assert.equal(Pin.of("const other = 1;\nconst TARGET = 2;\n", "the fixture").runAbove("const TARGET", "the fixture", "//").text, "");
  assert.equal(Pin.of('// a decoy\nconst u = "http://x";\nconst TARGET = 2;\n', "the fixture").runAbove("const TARGET", "the fixture", "//").text, "");
  assert.equal(Pin.of("// the doc block\n\nconst TARGET = 2;\n", "the fixture").runAbove("const TARGET", "the fixture", "//").text, "");
});

// The other half of the run's start bound: `(?:^|\n)` also matches at the
// absolute start of the sliced text, for a comment block with nothing above
// it — not just mid-document, preceded by a newline.
test("runAbove takes a comment block that starts at the beginning of the text", () => {
  assert.equal(Pin.of("// only comment\nconst TARGET = 2;\n", "the fixture").runAbove("const TARGET", "the fixture", "//").text, "// only comment\n");
});

// The half `anchorAt` owns, asserted through this caller because a slicer that
// took the FIRST hit would look right on every fixture above.
test("runAbove throws when the anchor matches twice, rather than taking the comment above the wrong copy", () => {
  assert.throws(
    () => Pin.of("// the real block\nconst TARGET = 2;\n\n// a restatement\nconst TARGET = 3;\n", "the fixture").runAbove("const TARGET", "the fixture", "//").text,
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
  assert.equal(Pin.of(src, "src").runAbove("const TARGET", "the fixture", "+").text, "+ the block\n+ still it\n");
});

// An empty marker is not a narrower gutter — it is no gutter at all, and the
// regex above would match every line above the anchor, comment or not. That
// silent total widening is worse than a throw, so runAbove refuses it up front.
test("runAbove throws on an empty marker, rather than silently matching every line above the anchor", () => {
  assert.throws(
    () => Pin.of("some prose line\nanother arbitrary line\nconst TARGET = 2;\n", "the fixture").runAbove("const TARGET", "the fixture", "").text,
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
  assert.deepEqual(Pin.of(QUOTED, "QUOTED").quoteBlocks().map((run) => run.text), [
    "> first block, line one\n> line two\n>\n> second paragraph, same block",
    "> second block",
  ]);
});

// Nothing before the first quote line and nothing after the last may leak in: an
// unquoted line inside the slice is text the controller does not carry, so a
// fixture holding one would be blessing prose the member never sees.
test("quoteBlocks returns no unquoted line, including at a run that ends the text", () => {
  assert.deepEqual(Pin.of("> only\nprose", "the fixture").quoteBlocks().map((run) => run.text), ["> only"]);
  assert.deepEqual(Pin.of("prose\n> last", "the fixture").quoteBlocks().map((run) => run.text), ["> last"]);
});

// The identifier names the block by what it BEGINS with. A later block that
// merely contains the same words is the copy a `text.indexOf(opener)` bound
// would have taken — this is the assertion that keeps `quoteBlock` from being
// that bound with extra steps.
test("quoteBlock returns the run that BEGINS with the opener, never one that merely contains it", () => {
  const text = "> a rule about stashing\n\n> never stash: a rule about stashing is above";
  assert.equal(Pin.of(text, "text").quoteBlock("never stash", "the fixture").text, "> never stash: a rule about stashing is above");
  // The case above never exercises the `^` anchor: "never stash" is not a
  // substring of the non-matching block at all, so an unanchored
  // `new RegExp(phrase(opener).source)` would pass it exactly as the anchored
  // form does. This puts the opener MID-block instead, where only the `^`
  // anchor tells the two regexes apart.
  assert.throws(
    () => Pin.of("> intro sentence never stash mid-block words", "the fixture").quoteBlock("never stash", "the fixture").text,
    /no quote block opens/,
  );
});

// Reflow-safe for `paragraph`'s reason, one bound over: an opener that the
// source has wrapped is still that block's opener, and a literal `indexOf`
// would throw "block deleted" on a reflow the block survived intact.
test("quoteBlock finds a block whose opener is hard-wrapped across two lines", () => {
  assert.equal(Pin.of("> Read the\n> issue first\n> and only then", "the fixture").quoteBlock("Read the issue first", "the fixture").text, "> Read the\n> issue first\n> and only then");
});

// The two throws, and the false green each one denies. A golden mechanism whose
// extractor returns "" for a block it cannot find compares nothing against
// nothing and a DELETED block passes; one that returns the first of two takes
// the decoy and lets the real block be gutted.
test("quoteBlock throws when no block opens on the identifier, rather than returning nothing", () => {
  assert.throws(
    () => Pin.of("> some other rule\n\nRead the issue first — unquoted now", "the fixture").quoteBlock("Read the issue first", "the fixture").text,
    /the fixture: no quote block opens on "Read the issue first"/,
  );
});

test("quoteBlock throws when two blocks open on the identifier, rather than binding the first", () => {
  assert.throws(
    () => Pin.of("> Read the issue first\n\n> Read the issue first, again", "the fixture").quoteBlock("Read the issue first", "the fixture").text,
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
  assert.deepEqual(names(Pin.logicalLines("see\n**Target**").text), ["Target"]);
  // The bound, and the false green losing it buys: a `see` ending one
  // paragraph would bind the `**Bold**` opening the NEXT one, and the scan
  // would report a pointer clause the document does not contain.
  assert.equal(Pin.logicalLines("tail see\n\n**Other**").text, "tail see\n\n**Other**");
});

test("logicalLines rejoins on exactly one space, whatever indent and trailing space the wrap left", () => {
  // Both trims matter to a literal-space scan and neither is visible in a
  // rendered document: the continuation's indent on one side, the trailing
  // whitespace an editor leaves behind on the other. Either one surviving
  // puts two spaces after `see` and the clause stops matching.
  assert.equal(Pin.logicalLines("see\n      **Target**").text, "see **Target**");
  assert.equal(Pin.logicalLines("see \n**Target**").text, "see **Target**");
  // A tab is whitespace an editor leaves, not markdown's hard break, so this
  // joins — `HARD_BREAK` is two SPACES, and the test above it holds that half.
  assert.equal(Pin.logicalLines("see \t\n\t **Target**").text, "see **Target**");
});

test("lineAt answers the PHYSICAL line a hit in the joined view came from", () => {
  // The whole reason the joined text is returned with a mapper rather than
  // alone: a pin that reports an offset into the joined copy names a line
  // number no reader can open. One-based, like an editor and like `grep -n`.
  const { text, lineAt } = Pin.logicalLines("# Heading\n\nfirst para\nwrapped on\nthree lines\n\nsee\n**Target**");
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
  const { lineAt } = Pin.logicalLines("a\nb\nc");
  assert.throws(() => lineAt(-5), /out of range/);
  assert.throws(() => lineAt(9999), /out of range/);
});

test("logicalLines never joins a line the reader sees as a new block", () => {
  // Joining only ever ADDS matches, so every one of these is a potential
  // pointer clause invented out of two unrelated blocks. A heading, a list
  // item, a blockquote, a table row and a thematic break each terminate their
  // predecessor on the page, so each must terminate it here.
  for (const next of ["## Heading", "- item", "* item", "+ item", "3. item", "> quoted", "| cell |", "---", "```js"]) {
    assert.equal(Pin.logicalLines(`see\n${next}`).text, `see\n${next}`, `joined a new block: ${next}`);
  }
});

test("logicalLines continues a list item but never a heading or a thematic break", () => {
  // The asymmetry, and the reason there are two regexes rather than one. A
  // list item and a blockquote take lazy continuation lines — that is where
  // the #1609 pointers actually live, inside a wrapped numbered step — while
  // a heading and a thematic break are complete on their own line. Collapsing
  // the two sets either loses every list-item wrap or swallows the paragraph
  // under a heading into the heading itself.
  assert.equal(Pin.logicalLines("1. step see\n   **Target**").text, "1. step see **Target**");
  assert.equal(Pin.logicalLines("- step see\n  **Target**").text, "- step see **Target**");
  assert.equal(Pin.logicalLines("> quoted see\n> more").text, "> quoted see\n> more");
  assert.equal(Pin.logicalLines("# Heading\nbody").text, "# Heading\nbody");
  assert.equal(Pin.logicalLines("---\ndescription: x").text, "---\ndescription: x");
});

test("logicalLines leaves fenced code exactly as written", () => {
  // A wrap inside prose is not semantic; a line break inside code is. Joining
  // a fenced block would hand any pin scanning code through this view a single
  // line that no shell, and no reader, would recognise.
  const fence = "prose see\n\n```sh\nfirst --flag\nsecond --flag\n```\n\nmore prose";
  assert.equal(Pin.logicalLines(fence).text, fence);
});

test("logicalLines keeps an authored hard line break", () => {
  // Two trailing spaces and a trailing backslash are markdown's line break —
  // the author asked for it, so it is not a wrap point to undo.
  assert.equal(Pin.logicalLines("see  \n**Target**").text, "see  \n**Target**");
  assert.equal(Pin.logicalLines("see\\\n**Target**").text, "see\\\n**Target**");
});

test("logicalLines keeps a block-leading span at column 0 and takes a wrap-leading one off it", () => {
  // The mirror direction, and the silent one. A `/^\*\*/m` scan means "leads a
  // block", and on raw bytes a reflow that happens to push a mid-paragraph
  // bold to column 0 mints a target the author never wrote — so a pointer
  // resolves to a block the wrap invented and the pin passes for free.
  const lead = /^\*\*([^*\n]+)\*\*/gm;
  const wrapped = "a sentence ending here\n**Not A Block** but mid-paragraph prose";
  assert.deepEqual([...wrapped.matchAll(lead)].map((m) => m[1]), ["Not A Block"]);
  assert.deepEqual([...Pin.logicalLines(wrapped).text.matchAll(lead)].map((m) => m[1]), []);
  // And the half that must still be ACCEPTED: a span that genuinely opens its
  // block stays at column 0 even when the rest of that block is wrapped, so
  // tightening `^` this way costs no real target.
  const real = "**A Real Block** whose own paragraph\nwraps onto a second line";
  assert.deepEqual([...Pin.logicalLines(real).text.matchAll(lead)].map((m) => m[1]), ["A Real Block"]);
});

// `Pin`. One chain per test; every new piece of logic —
// roots, marker inference, gutters, `.section` — gets the input it must
// ACCEPT beside the input it must REFUSE.

const PIN_DIR = tempDir("prose-pin-");
const fixtureFile = (name, text) => {
  const path = join(PIN_DIR, name);
  writeFileSync(path, text);
  return path;
};

test("Pin.of roots a string under a label, and the node's text is that string", () => {
  assert.equal(Pin.of("some text", "the fixture").text, "some text");
  assert.equal(Pin.of("", "an empty fixture").text, "");
});

test("Pin.of refuses a text that is not a string and a missing or blank label", () => {
  assert.throws(() => Pin.of(undefined, "the fixture"), /Pin\.of\(\) roots a string, not undefined/);
  assert.throws(() => Pin.of(Buffer.from("text"), "the fixture"), /Pin\.of\(\) roots a string, not object/);
  assert.throws(() => Pin.of("text"), /Pin\.of\(\) needs a label/);
  assert.throws(() => Pin.of("text", "  "), /Pin\.of\(\) needs a label/);
});

test("a Pin node is immutable, and only Pin.file or Pin.of mints one", () => {
  const node = Pin.of("abc", "the fixture");
  assert.throws(() => {
    node.text = "changed";
  }, TypeError);
  assert.throws(() => {
    node.extra = 1;
  }, TypeError);
  assert.equal(node.text, "abc");
  assert.throws(() => new Pin(undefined, "abc", "the fixture"), /never `new Pin`/);
});

test("Pin.file reads a file once per resolved path, so two spellings of one file share its root", () => {
  const dir = join(PIN_DIR, "cache");
  mkdirSync(dir);
  const path = join(dir, "doc.md");
  writeFileSync(path, "first");
  const root = Pin.file(path);
  assert.equal(root.text, "first");
  writeFileSync(path, "second");
  assert.equal(Pin.file(relative(process.cwd(), path)), root);
  assert.equal(Pin.file(join(dir, "..", basename(dir), "doc.md")).text, "first");
  // ACCEPT: another file is another key, read on its own.
  const other = join(dirname(path), "other.md");
  writeFileSync(other, "other");
  assert.equal(Pin.file(other).text, "other");
});

test("Pin.file throws Node's own ENOENT for a missing path", () => {
  assert.throws(() => Pin.file(join(PIN_DIR, "missing.md")), { code: "ENOENT" });
});

test("Pin.file throws Node's own ENOTDIR for a file path written with a trailing slash, rather than reading the file", () => {
  const path = fixtureFile("slashed.md", "text\n");
  assert.throws(() => Pin.file(`${path}/`), { code: "ENOTDIR" });
});

test("Pin.file infers runAbove's marker from .sh, .mjs and .js, and a node sliced from the root keeps it", () => {
  const sh = fixtureFile("probe.sh", "# says what probe does\n# over two lines\nprobe() {\n  :\n}\n");
  assert.equal(Pin.file(sh).runAbove("probe() {", "the fixture").text, "# says what probe does\n# over two lines\n");
  for (const ext of [".mjs", ".js"]) {
    const js = fixtureFile(`mod${ext}`, "// says what X is\nexport const X = 1;\n");
    assert.equal(Pin.file(js).runAbove("const X", "the fixture").text, "// says what X is\n", ext);
  }
  assert.equal(Pin.file(sh).between("# over", "}", "the fixture").runAbove("probe() {", "the fixture").text, "# over two lines\n");
  // Every method that returns a node hands it the root's marker, not just
  // `.between`. `runAbove` on each result needs one, and refuses without it.
  // The comment line carries no space after `#` so `.section`'s heading scan
  // does not end the section there.
  const derive = fixtureFile("derive.sh", "## Sec\n\n#says a\nprobe_a() {\n  :\n}\n\n- # item b\n  probe_b() {\n\n> # c quoted\n> probe_c() {\n\ntail\n");
  const root = Pin.file(derive);
  const derived = [
    ["between", root.between("## Sec", "tail", "the fixture"), "probe_a() {"],
    ["paragraph", root.paragraph("#says a", "the fixture", "- # item b"), "probe_a() {"],
    ["bullet", root.bullet("- # item b", "> # c quoted", "the fixture"), "probe_b() {"],
    ["betweenPhrases", root.betweenPhrases("## Sec", "tail", "the fixture"), "probe_a() {"],
    ["quoteBlock", root.quoteBlock("# c quoted", "the fixture"), "probe_c() {"],
    ["quoteBlocks", root.quoteBlocks()[0], "probe_c() {"],
    ["section", root.section("## Sec", "the fixture"), "probe_a() {"],
    ["stripGutter", root.stripGutter(">"), "probe_a() {"],
    ["runAbove", root.runAbove("probe_a() {", "the fixture"), "#says a"],
  ];
  for (const [method, node, anchor] of derived) {
    assert.doesNotThrow(() => node.runAbove(anchor, "the fixture"), `${method} keeps the root's marker`);
  }
});

test("runAbove takes an explicit marker over the inferred one, and on a Pin.of root", () => {
  assert.equal(Pin.of("# a shell note\nprobe() {\n", "a shell fixture").runAbove("probe() {", "the fixture", "#").text, "# a shell note\n");
  const sh = fixtureFile("explicit.sh", "// not a shell comment\nprobe() {\n");
  assert.equal(Pin.file(sh).runAbove("probe() {", "the fixture", "//").text, "// not a shell comment\n");
});

test("runAbove refuses to run without a marker on a Pin.of root, or on a file root of any other extension", () => {
  assert.throws(
    () => Pin.of("# a note\nprobe() {\n", "a shell fixture").runAbove("probe() {", "the fixture"),
    /the fixture: runAbove needs a marker — a shell fixture is not a \.sh, \.mjs or \.js file root/,
  );
  assert.throws(
    () => Pin.of("x\n# a note\nprobe() {\n", "a shell fixture").between("# a note", "{", "the fixture").runAbove("probe()", "the fixture"),
    /runAbove needs a marker — a shell fixture is not/,
  );
  const md = fixtureFile("notes.md", "# Heading\nprobe() {\n");
  assert.throws(() => Pin.file(md).runAbove("probe() {", "the fixture"), /runAbove needs a marker — \S*notes\.md is not/);
});

test("Pin.file infers no marker from any extension but .sh, .mjs and .js", () => {
  for (const ext of [".ts", ".cjs", ".mts", ".bash", ".zsh", ".py", ".txt", ""]) {
    const path = fixtureFile(`other${ext}`, "# a note\n// a note\nprobe() {\n");
    assert.throws(() => Pin.file(path).runAbove("probe() {", "the fixture"), /runAbove needs a marker/, `extension "${ext}"`);
  }
});

test("runAbove's refusal names a file root by its resolved path, on the root and on a node sliced from it", () => {
  const path = fixtureFile("named.md", "# Heading\nprobe() {\n");
  const root = Pin.file(relative(process.cwd(), path));
  for (const node of [root, root.between("# Heading", "{", "the fixture")]) {
    assert.throws(
      () => node.runAbove("probe()", "the fixture"),
      (error) => error.message.includes(`runAbove needs a marker — ${path} is not`),
    );
  }
});

test("stripGutter('#') strips each line's indent, `#` and one space, leaves a mid-line `#`, and joins with \\n", () => {
  assert.equal(Pin.of("  # one\n#two\n#  three\ncode # trailing", "the fixture").stripGutter("#").text, "one\ntwo\n three\ncode # trailing");
});

test("stripGutter('//') strips each line's indent, `//` and one space, leaves a mid-line `//`, and joins with \\n", () => {
  assert.equal(Pin.of("  // one\n//two\n//  three\ncode // trailing", "the fixture").stripGutter("//").text, "one\ntwo\n three\ncode // trailing");
});

test("stripGutter('>') strips each line's indent, a run of `>` and one space, leaves a mid-line `>`, and joins with \\n", () => {
  assert.equal(
    Pin.of("  > one\n>>two\n> > three\n>  four\ncode > trailing", "the fixture").stripGutter(">").text,
    "one\ntwo\n> three\n four\ncode > trailing",
  );
});

test("stripGutter takes a tab as indent or as the one space after the marker, and one `#` or `//`, but a run of `>`", () => {
  assert.equal(Pin.of("\t# one\n#\ttwo\n## three", "the fixture").stripGutter("#").text, "one\ntwo\n# three");
  assert.equal(Pin.of("\t// one\n//\ttwo\n/// three", "the fixture").stripGutter("//").text, "one\ntwo\n/ three");
  assert.equal(Pin.of("\t> one\n>\ttwo\n>> three", "the fixture").stripGutter(">").text, "one\ntwo\nthree");
});

test("stripGutter leaves a line without its marker, a blank line, a \\r and trailing whitespace exactly as written", () => {
  for (const marker of ["#", "//", ">"]) {
    const text = `${marker} one  \r\n  no gutter here\r\n\n${marker} two\t`;
    assert.equal(Pin.of(text, "the fixture").stripGutter(marker).text, "one  \r\n  no gutter here\r\n\ntwo\t", marker);
  }
});

test("stripGutter refuses any marker but #, // and >", () => {
  const node = Pin.of("# x", "the fixture");
  for (const marker of ["", "*", "##", "/", undefined]) {
    assert.throws(() => node.stripGutter(marker), /stripGutter\(\) takes "#", "\/\/" or ">"/, String(marker));
  }
});

test(".section matches one whole heading line, so a heading that only starts the same way is not it", () => {
  const doc = "# Top\n## Shell traps\nother\n## Shell\nbody\n## Shell \nnot it either\n";
  assert.equal(Pin.of(doc, "the fixture").section("## Shell", "the fixture").text, "## Shell\nbody\n");
});

test(".section throws when no line is exactly the heading", () => {
  assert.throws(
    () => Pin.of("## Shell traps\nbody\n", "the fixture").section("## Shell", "the fixture"),
    /the fixture: section heading "## Shell" moved — re-anchor this test, never widen it to the whole file/,
  );
});

test(".section takes only one whole heading line as its heading", () => {
  const node = Pin.of("Shell\n## Shell\n", "the fixture");
  for (const heading of ["Shell", "####### Shell", "##Shell", "## Shell\nbody", "    ## Shell", undefined]) {
    assert.throws(() => node.section(heading, "the fixture"), /the fixture: section\(\) takes one whole heading line/, String(heading));
  }
  // ACCEPT: six `#`, a bare `#`, and an indent of up to three spaces.
  assert.equal(Pin.of("###### Deep\nx\n", "the fixture").section("###### Deep", "the fixture").text, "###### Deep\nx\n");
  assert.equal(Pin.of("a\n#\nx\n", "the fixture").section("#", "the fixture").text, "#\nx\n");
  assert.equal(Pin.of("a\n   ## A\nx\n", "the fixture").section("   ## A", "the fixture").text, "   ## A\nx\n");
});

test(".section throws when its heading occurs more than once outside fences", () => {
  assert.throws(
    () => Pin.of("## A\none\n## A\ntwo\n", "the fixture").section("## A", "the fixture"),
    /the fixture: section heading "## A" occurs 2 times — a pin would bind the wrong copy; narrow the heading/,
  );
  // ACCEPT: the same words at another depth are another heading.
  assert.equal(Pin.of("## A\none\n### A\ntwo\n", "the fixture").section("## A", "the fixture").text, "## A\none\n### A\ntwo\n");
});

test(".section skips headings inside fenced blocks, at its start and at its end", () => {
  const doc = "```md\n## A\n```\n## A\nbody\n~~~sh\n# a shell comment\n## B\n~~~\nmore\n## C\n";
  assert.equal(Pin.of(doc, "the fixture").section("## A", "the fixture").text, "## A\nbody\n~~~sh\n# a shell comment\n## B\n~~~\nmore\n");
  assert.throws(() => Pin.of("```\n## A\n```\n", "the fixture").section("## A", "the fixture"), /section heading "## A" moved/);
});

test(".section: a backtick run whose info string holds a backtick is inline code, not a fence", () => {
  // REFUSE as a fence: the heading after it still ends the slice.
  assert.equal(Pin.of("## A\n```x``` is inline code\n## B\ny\n", "the fixture").section("## A", "the fixture").text, "## A\n```x``` is inline code\n");
  // REFUSE as a fence: the heading after it is still found.
  assert.equal(Pin.of("```x``` inline\n## A\nbody\n", "the fixture").section("## A", "the fixture").text, "## A\nbody\n");
  // ACCEPT: a tilde fence may carry a backtick in its info string.
  assert.equal(Pin.of("## A\n~~~x`y\n## in\n~~~\n## B\n", "the fixture").section("## A", "the fixture").text, "## A\n~~~x`y\n## in\n~~~\n");
});

test(".section's fence closes only on its opener's character, at least as long, with nothing after it", () => {
  const doc = [
    "## A",
    "````md",
    "```",
    "## not an end: a shorter run is fence content",
    "~~~~",
    "## not an end: the other fence character is fence content",
    "```` text",
    "## not an end: a run with text after it is fence content",
    "````",
    "    ```",
    "## B",
  ].join("\n");
  // The four-space line is indented code, not a fence, so `## B` ends the slice.
  assert.equal(Pin.of(doc, "the fixture").section("## A", "the fixture").text, doc.slice(0, doc.indexOf("## B")));
  // ACCEPT: an opener indented two spaces, closed by a longer run indented
  // three, with trailing whitespace.
  assert.equal(Pin.of("## A\n  ```\n## no end\n   ````  \n## B\n", "the fixture").section("## A", "the fixture").text, "## A\n  ```\n## no end\n   ````  \n");
});

test(".section's fence opens on three or more backticks or tildes indented up to three spaces, and its closer is indented up to three with only spaces or tabs after it", () => {
  // ACCEPT: an opener indented three spaces, and a closer followed by a tab.
  assert.equal(Pin.of("## A\n   ```\n## in\n```\t\n## B\n", "the fixture").section("## A", "the fixture").text, "## A\n   ```\n## in\n```\t\n");
  // REFUSE as an opener: a run of two.
  assert.equal(Pin.of("## A\n``\n## B\n", "the fixture").section("## A", "the fixture").text, "## A\n``\n");
  assert.equal(Pin.of("## A\n~~\n## B\n", "the fixture").section("## A", "the fixture").text, "## A\n~~\n");
  // REFUSE as a closer: one indented four spaces, and one followed by a no-break space.
  const doc = "## A\n```\n    ```\n## in\n```\u00a0\n## in\n```\n## B\n";
  assert.equal(Pin.of(doc, "the fixture").section("## A", "the fixture").text, doc.slice(0, doc.indexOf("## B")));
});

test(".section runs through deeper headings and ends just before the `#` of the next same-or-shallower one", () => {
  assert.equal(Pin.of("## A\nx\n### Sub\ny\n## B\nz\n## C\n", "the fixture").section("## A", "the fixture").text, "## A\nx\n### Sub\ny\n");
  assert.equal(Pin.of("## A\nx\n# Top\nz\n", "the fixture").section("## A", "the fixture").text, "## A\nx\n");
  assert.equal(Pin.of("## A\nx\n  ## B\n", "the fixture").section("## A", "the fixture").text, "## A\nx\n  ");
  // A `#` run that opens no heading ends nothing.
  assert.equal(Pin.of("## A\n#hashtag\n####### seven\n## B\n", "the fixture").section("## A", "the fixture").text, "## A\n#hashtag\n####### seven\n");
});

test(".section runs to the node's end when no later heading closes it", () => {
  assert.equal(Pin.of("# Top\nintro\n## A\nx\n### Sub\ny", "the fixture").section("## A", "the fixture").text, "## A\nx\n### Sub\ny");
});

test(".section ends at a heading whose `#` run a tab follows, and not at one any other whitespace follows", () => {
  assert.equal(Pin.of("## A\nx\n##\tB\n", "the fixture").section("## A", "the fixture").text, "## A\nx\n");
  assert.equal(Pin.of("## A\n##\u00a0x\n", "the fixture").section("## A", "the fixture").text, "## A\n##\u00a0x\n");
});

test(".section on a CRLF text splits on \\n only, so its heading carries the line's \\r", () => {
  assert.equal(Pin.of("## A\r\nx\r\n## B\r\n", "the fixture").section("## A\r", "the fixture").text, "## A\r\nx\r\n");
});

test("Pin's .between slices the node's text, emphasis tolerance off unless asked", () => {
  const doc = "a **START** b END c";
  assert.equal(Pin.of(doc, "the fixture").between("START", "END", "the fixture", { emphasisTolerant: true }).text, "**START** b ");
  assert.equal(Pin.of(doc, "the fixture").between("START", "END", "the fixture").text, "START** b ");
});

test("Pin's .paragraph slices the node's text, Pin.END and emphasis tolerance included", () => {
  const doc = "intro\n\n**THE RULE** says X.\n\n**next** para.\n";
  assert.equal(Pin.of(doc, "the fixture").paragraph("THE RULE", "the fixture", "next", { emphasisTolerant: true }).text, "**THE RULE** says X.");
  assert.throws(() => Pin.of(doc, "the fixture").paragraph("THE RULE", "the fixture", "next"), /no longer opens with "next"/);
  assert.equal(Pin.of("intro\n\nTHE RULE says X.\n", "the fixture").paragraph("THE RULE", "the fixture", Pin.END).text, "THE RULE says X.\n");
});

test("Pin's .bullet slices the node's text, ending the item at its next sibling", () => {
  const doc = "- one\n- two\n- three\n";
  assert.equal(Pin.of(doc, "the fixture").bullet("- one", "- three", "the fixture").text, "- one");
});

test("Pin's .betweenPhrases slices the node's text, bound included", () => {
  assert.equal(Pin.of("start here then stop\n\nlater stop", "the fixture").betweenPhrases("start here", "stop", "the fixture", { bound: /\n\n/ }).text, "start here then ");
  assert.throws(() => Pin.of("start here then\n\nlater stop", "the fixture").betweenPhrases("start here", "stop", "the fixture", { bound: /\n\n/ }), /lies past the end bound/);
});

test("Pin's .anchorAt returns an offset into the node's text, emphasis tolerance off unless asked", () => {
  assert.equal(Pin.of("x **an anchor** y", "the fixture").anchorAt("an anchor", "the fixture", { emphasisTolerant: true }), 2);
  assert.equal(Pin.of("x **an anchor** y", "the fixture").anchorAt("an anchor", "the fixture"), 4);
});

test("Pin's .quoteBlock slices the node's text, emphasis tolerance off unless asked", () => {
  const quoted = Pin.of("> one block\n> here\n\n> **two** block\n", "the fixture");
  assert.equal(quoted.quoteBlock("two block", "the fixture", { emphasisTolerant: true }).text, "> **two** block");
  assert.throws(() => quoted.quoteBlock("two block", "the fixture"), /no quote block opens on "two block"/);
});

test("Pin's .quoteBlocks returns each run of the node's text as a node", () => {
  const nodes = Pin.of("> one block\n> here\n\ntext\n> two\n", "the fixture").quoteBlocks();
  assert.ok(nodes.every((node) => node instanceof Pin));
  assert.deepEqual(nodes.map((node) => node.text), ["> one block\n> here", "> two"]);
});

test("Pin is the module's only export, and its static members work on plain strings", async () => {
  assert.deepEqual(Object.keys(await import("./support/prose-pin.mjs")), ["Pin"]);
  assert.equal(typeof Pin.END, "symbol");
  assert.ok(Pin.phrase("a b").test("a\n   b"));
  assert.equal(Pin.unemphasized("**a** b"), "a b");
  assert.deepEqual(Pin.sentences("One. Two."), ["One.", "Two."]);
  assert.equal(Pin.logicalLines("a\nb\n\nc").text, "a b\n\nc");
});

// Fixtures below close the survivors a mutation pass over a scratch copy of the
// module found once this suite stopped calling the module's functions directly.
// Each one is an input on which the mutated line and the real one disagree, and
// each states the direction the real line takes.

test("an emphasis-tolerant anchor that overlaps itself counts as more than one", () => {
  // `aa` sits at offsets 1 and 2 of `xaaax`: counting past each hit by one
  // finds both, counting past it by two finds one and slices from the first.
  assert.throws(() => Pin.of("xaaax", "the fixture").between("aa", "x", "the fixture", { emphasisTolerant: true }), /occurs 2 times/);
});

test("an emphasis-tolerant anchor that strips to empty counts one hit per offset, the end of the text included", () => {
  // The stripped text is `a`, one character, so the empty anchor sits at
  // offsets 0 and 1. Stopping short of the end counts one and slices.
  assert.throws(() => Pin.of("**a", "the fixture").between("**", "a", "the fixture", { emphasisTolerant: true }), /occurs 2 times/);
});

test("a literal between takes the first end anchor after the start even when it occurs again", () => {
  // ACCEPT: the exactly-once rule on the end anchor is the tolerant path's price only.
  assert.equal(Pin.of("S a E b E", "the fixture").between("S", "E", "the fixture").text, "S a ");
});

test("paragraph reads `next` literally unless emphasis tolerance is on, and through the strip when it is", () => {
  const doc = "RULE a.\n\n**next** b";
  assert.equal(Pin.of(doc, "the fixture").paragraph("RULE", "the fixture", "**next**").text, "RULE a.");
  assert.equal(Pin.of(doc, "the fixture").paragraph("RULE", "the fixture", "**next**", { emphasisTolerant: true }).text, "RULE a.");
  assert.throws(() => Pin.of(doc, "the fixture").paragraph("RULE", "the fixture", "next"), /no longer opens with "next"/);
  assert.equal(Pin.of(doc, "the fixture").paragraph("RULE", "the fixture", "next", { emphasisTolerant: true }).text, "RULE a.");
});

test("paragraph refuses a `next` that is only whitespace", () => {
  assert.throws(() => Pin.of("RULE a.\n\nnext", "the fixture").paragraph("RULE", "the fixture", " "), /needs `next`/);
});

test("phrase escapes `?`, `^` and `|` taken from its input", () => {
  assert.equal(Pin.phrase("a?b").test("b"), false);
  assert.equal(Pin.phrase("a?b").test("a?b"), true);
  assert.equal(Pin.phrase("^a").test("a"), false);
  assert.equal(Pin.phrase("^a").test("x ^a"), true);
  assert.equal(Pin.phrase("a|b").test("a"), false);
  assert.equal(Pin.phrase("a|b").test("a|b"), true);
});

test("Pin.END names itself", () => {
  assert.equal(Pin.END.description, "END");
});

test("bullet reads a bare `.` or `)` as no marker, whether it opens the item or follows it", () => {
  assert.throws(() => Pin.of(". a\nEND", "the fixture").bullet(". a", "END", "the fixture"), /not on a list-item line/);
  // A `. x` line is lazy continuation text, so it stays inside the item.
  assert.equal(Pin.of("- a\n. x\nEND", "the fixture").bullet("- a", "END", "the fixture").text, "- a\n. x\n");
});

test("bullet reads the anchor's own line whole when it is the last line of the text", () => {
  // `-b` is no list item: a marker needs a space after it. Reading the line one
  // character short would see a bare `-` and accept it.
  assert.throws(() => Pin.of("-b", "the fixture").bullet("-", "b", "the fixture"), /not on a list-item line/);
});

test("bullet sees a bare-marker sibling on the last line of the slice", () => {
  assert.equal(Pin.of("- a\n-END", "the fixture").bullet("- a", "END", "the fixture").text, "- a");
});

test("bullet measures a tab against its own column, so a tab-indented line is a child only from the content column", () => {
  // `10. ` puts the content at column 4, exactly where one tab lands.
  assert.equal(Pin.of("10. a\n\t- x\nEND", "the fixture").bullet("10. a", "END", "the fixture").text, "10. a\n\t- x\n");
  // `1.   ` puts it at column 5: after a blank line, a tab (column 4) and a
  // space-then-tab (also column 4) are both shallower than the item's text.
  assert.equal(Pin.of("1.   a\n\n\t- x\nEND", "the fixture").bullet("1.   a", "END", "the fixture").text, "1.   a");
  assert.equal(Pin.of("1.   a\n\n \t- x\nEND", "the fixture").bullet("1.   a", "END", "the fixture").text, "1.   a");
  // A tab advances to the next multiple of 4 from wherever it starts: three
  // spaces then a tab is column 4, four spaces then a tab is column 8.
  assert.equal(Pin.of("1.   a\n\n   \t- x\nEND", "the fixture").bullet("1.   a", "END", "the fixture").text, "1.   a");
  assert.equal(Pin.of("1.   a\n\n    \t- x\nEND", "the fixture").bullet("1.   a", "END", "the fixture").text, "1.   a\n\n    \t- x\n");
});

test("an emphasis-tolerant anchorAt maps its offset back past every earlier `**`, and stops before a marker at the anchor", () => {
  assert.equal(Pin.of("**a** x **an anchor** y", "the fixture").anchorAt("an anchor", "the fixture", { emphasisTolerant: true }), 8);
  assert.equal(Pin.of("**a** b END", "the fixture").between("b", "END", "the fixture", { emphasisTolerant: true }).text, "b ");
});

test("bullet puts the content column at the marker's gap, a gap of 4 included, and one past the marker for a bare marker or a gap past 4", () => {
  // Gap 4: content at column 4, so a paragraph at column 3 after a blank line is not the item's.
  assert.equal(Pin.of("-    x\n\n   z\nEND", "the fixture").bullet("-    x", "END", "the fixture").text, "-    x");
  // Gap 5: the rest is an indented code block and the content is one past the marker, so a paragraph at column 2 is the item's.
  assert.equal(Pin.of("-     x\n\n  z\nEND", "the fixture").bullet("-     x", "END", "the fixture").text, "-     x\n\n  z\n");
  // A bare marker: content one past the marker, so a paragraph at column 1 after a blank line is not the item's.
  assert.equal(Pin.of("-\n\n z\nEND", "the fixture").bullet("-", "END", "the fixture").text, "-");
  // An ordinary gap of 1: content at column 2, so a paragraph at column 1 is not the item's.
  assert.equal(Pin.of("- a\n\n y\nEND", "the fixture").bullet("- a", "END", "the fixture").text, "- a");
});

test("betweenPhrases takes a global bound regex, and names the bound's line whole up to 72 characters and cut beyond", () => {
  assert.equal(Pin.of("start a late\n\nz", "the fixture").betweenPhrases("start", "late", "the fixture", { bound: /\n\n/g }).text, "start a ");
  const lineOf = (length) => `## late ${"y".repeat(length - "## late ".length)}`;
  const named = (text) => {
    try {
      Pin.of(text, "the fixture").betweenPhrases("start", "late", "the fixture", { bound: /\n##/ });
    } catch (error) {
      return error.message;
    }
    return "";
  };
  // The text ends on the named line with no trailing newline, so a line read
  // one character short shows.
  assert.match(named(`start a\n${lineOf(72)}`), new RegExp(`line 2 \\("${lineOf(72)}"\\)`));
  assert.match(named(`start a\n${lineOf(73)}`), new RegExp(`line 2 \\("${lineOf(73).slice(0, 72)}…"\\)`));
  // A leading blank line moves the count, and the first character is not the one the count drops.
  assert.match(named(`\nstart a\n${lineOf(10)}`), /line 3 \("## late yy"\)/);
});

test("quoteBlock opens on a run whose first line carries no space after `>`, or several", () => {
  assert.equal(Pin.of(">one two\n> three", "the fixture").quoteBlock("one two", "the fixture").text, ">one two\n> three");
  assert.equal(Pin.of(">    indented opener words\n> x", "the fixture").quoteBlock("indented opener words", "the fixture").text, ">    indented opener words\n> x");
});

// `logicalLines` joins a physical line to the one before it unless one of them
// is a block of its own. These tables pin each shape the two block regexes
// name, at the width and indent where it starts and the one where it stops.
const joins = (previous, next) => !Pin.logicalLines(`${previous}\n${next}`).text.includes("\n");

test("logicalLines starts a block at each shape BLOCK_START names, and joins every near-miss", () => {
  for (const line of ["# h", "###### h", "   # h", "- x", "* x", "+ x", "-", "1. x", "10) x", ">", "> q", "| t |", "```", "~~~", "---", "***", "___", "--- ", "   ---"]) {
    assert.equal(joins("para", line), false, `${JSON.stringify(line)} starts a block`);
  }
  for (const line of ["####### h", "#h", "    # h", "-x", "1.x", ". x", "1 x", "--", "**", "__", "---x", "***x", "___x", "a # h", "a - b", "a > b", "a | b", "x ```", "    ```"]) {
    assert.equal(joins("para", line), true, `${JSON.stringify(line)} continues the paragraph`);
  }
});

test("logicalLines lets nothing continue a line BLOCK_END names, and lets a near-miss continue", () => {
  for (const line of ["# h", "###### h", "   # h", "| t |", "---", "***", "___", "--- ", "   ***"]) {
    assert.equal(joins(line, "para"), false, `${JSON.stringify(line)} is complete in itself`);
  }
  for (const line of ["####### h", "#h", "    # h", "a # h", "--", "**", "__", "---x", "***x", "___x", "- x", "> q", "word"]) {
    assert.equal(joins(line, "para"), true, `${JSON.stringify(line)} takes a continuation`);
  }
  // A closing fence ends a block too, so the text after it is not joined onto it.
  assert.equal(Pin.logicalLines("```\nx\n```\ntext").text, "```\nx\n```\ntext");
  assert.equal(Pin.logicalLines("~~~\nx\n~~~\ntext").text, "~~~\nx\n~~~\ntext");
});

test("logicalLines opens a fence at up to three spaces of indent, on a line that starts with the run", () => {
  assert.equal(Pin.logicalLines("a\n   ```\nb\nc\n   ```\nd").text, "a\n   ```\nb\nc\n   ```\nd");
  assert.equal(Pin.logicalLines("```\nb\nc\n```").text, "```\nb\nc\n```");
  // Four spaces is indented code, and a run mid-line is not a fence: both leave the lines to join.
  assert.equal(Pin.logicalLines("    ```\nb\nc").text, "    ``` b c");
  assert.equal(Pin.logicalLines("x ```\nb\nc").text, "x ``` b c");
});

test("logicalLines keeps the indent of a line it does not join, and the first and last lines' own whitespace", () => {
  assert.equal(Pin.logicalLines("  a\nb").text, "  a b");
  assert.equal(Pin.logicalLines("a\nb ").text, "a b ");
  assert.equal(Pin.logicalLines("a\n\n   b").text, "a\n\n   b");
  assert.equal(Pin.logicalLines("a\nb c").text, "a b c");
  assert.equal(Pin.logicalLines("a b\nc").text, "a b c");
});

test("logicalLines.lineAt refuses an offset at the end of the view and before its start", () => {
  const view = Pin.logicalLines("a\nb");
  assert.equal(view.lineAt(0), 1);
  assert.equal(view.lineAt(view.text.length - 1), 2);
  assert.throws(() => view.lineAt(view.text.length), /out of range/);
  assert.throws(() => view.lineAt(-1), /out of range/);
});

test(".section's fence closes on a run as long as its opener, indented up to three spaces, and not on a shorter one", () => {
  const sectionOf = (doc) => Pin.of(doc, "the fixture").section("## A", "the fixture").text;
  assert.equal(sectionOf("## A\n```\n## in\n``\n## still in\n```\n## B\n"), "## A\n```\n## in\n``\n## still in\n```\n");
  assert.equal(sectionOf("## A\n~~~\n## in\n~~\n## still in\n~~~\n## B\n"), "## A\n~~~\n## in\n~~\n## still in\n~~~\n");
  assert.equal(sectionOf("## A\n```\n## in\n   ```\n## B\n"), "## A\n```\n## in\n   ```\n");
  assert.equal(sectionOf("## A\n````\n## in\n   ```\n## still in\n````\n## B\n"), "## A\n````\n## in\n   ```\n## still in\n````\n");
});

test("a bullet stops at a thematic break of any marker and a heading of any depth up to 6, and not at a near-miss", () => {
  const item = (next) => Pin.of(`- a\n${next}\nEND`, "the fixture").bullet("- a", "END", "the fixture").text;
  for (const next of ["---", "***", "___", "- - -", "* * *", "_ _ _", "# h", "###### h", "```", "~~~", "> q"]) {
    assert.equal(item(next), "- a", `${JSON.stringify(next)} ends the item`);
  }
  for (const next of ["--", "**", "__", "_ _", "---x", "***x", "_ _ _x", "####### h", "#h"]) {
    assert.equal(item(next), `- a\n${next}\n`, `${JSON.stringify(next)} is lazy continuation text`);
  }
});
