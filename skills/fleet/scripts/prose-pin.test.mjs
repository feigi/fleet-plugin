import { test } from "node:test";
import assert from "node:assert/strict";
import { between, phrase } from "./prose-pin.mjs";

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
