import { test } from "node:test";
import assert from "node:assert/strict";
import { lift } from "./lift.mjs";

// The ACCEPT path (#533's own suite only ever fed lift() functions it must
// find — nothing pinned that a genuine match is actually extracted AND
// evaluated, as opposed to merely not throwing).
test("lift extracts and evaluates a matching top-level function", () => {
  const code = `
function double(n) {
  return n * 2;
}
`;
  const double = lift(code, "double", "n");
  assert.equal(double(21), 42);
});

// The REFUSAL path: every one of #533's five callers hands lift() a function
// that genuinely exists in review-pr.js, so none of them ever reaches the
// `assert.ok(m, ...)` branch — a suite built only from those call sites pins
// nothing about it. Two ways to miss: wrong name, and right name but wrong
// signature (the regex anchors on `name(signature)` together).
//
// The fixture spans lines on purpose: lift()'s pattern ends at `^\}$`, so a
// one-line `function double(n) { ... }` cannot match it whatever name or
// signature is asked for, and a refusal forced by that anchor pins neither
// sub-case. Measured on this file: with `name` and `signature` dropped from
// the pattern entirely, a one-line fixture leaves this test green.
test("lift refuses with a message naming the function and signature when nothing matches", () => {
  const code = `
function double(n) {
  return n * 2;
}
`;
  assert.throws(
    () => lift(code, "triple", "n"),
    /review-pr\.js no longer declares triple\(n\) at top level — update this test/,
  );
  assert.throws(
    () => lift(code, "double", "n, extra"),
    /review-pr\.js no longer declares double\(n, extra\) at top level — update this test/,
  );
});

// `name` and `signature` are interpolated into a RegExp, so both go through
// `RegExp.escape` — a metachar in either matches only itself. Unescaped, the
// `.` of a rest parameter stood in for any character: the pin
// `pick(a, ...rest)` was satisfied by the declaration `pick(a, b, rest)`, so
// the wrong-signature refusal above returned a function of a signature nobody
// asked for instead of throwing.
test("regex metachars in a signature match literally, not as pattern syntax", () => {
  const wrongShape = `
function pick(a, b, rest) {
  return "wrong shape";
}
`;
  assert.throws(
    () => lift(wrongShape, "pick", "a, ...rest"),
    /review-pr\.js no longer declares pick\(a, \.\.\.rest\) at top level — update this test/,
  );
  // The control: escaping must not also break the match it is meant to make.
  const realShape = `
function pick(a, ...rest) {
  return rest.length;
}
`;
  assert.equal(lift(realShape, "pick", "a, ...rest")(1, 2, 3), 2);
});

// The pattern's two `^` anchors, one per end, are what make "top level" mean
// anything. Neither was pinned: dropping the leading `^`, and dropping the
// `^...$` around the closing brace, each left the whole suite green. Both
// mutants below die here instead — named, in this file — rather than as an
// opaque module-scope `assert.ok` crash in whichever caller imports next,
// which is the failure mode lift.mjs's header says it exists to avoid.
test("a declaration nested inside another function is not top level, and is refused", () => {
  const code = `
function outer() {
  function inner(n) {
    return n * 2;
  }
  return inner;
}
`;
  assert.throws(
    () => lift(code, "inner", "n"),
    /review-pr\.js no longer declares inner\(n\) at top level — update this test/,
  );
});

test("the body ends at a column-0 `}`, not at the first `}` nested inside it", () => {
  const code = `
function classify(n) {
  if (n > 0) {
    return "positive";
  }
  return "other";
}
`;
  const classify = lift(code, "classify", "n");
  assert.equal(classify(1), "positive");
  assert.equal(classify(-1), "other", "the lift must not stop at the if-block's closing brace");
});

// AC-4 (#533): "the helper must not quietly return a stale or wrong
// function." Extracting this replaces each converted file's own private
// `.match`/`new Function` copy with the one shared pair in lift.mjs — so that
// module's first-match ceiling (documented in its header, measured 2026-08-17
// on PR #536) is now a property of the shared helper rather than of every
// caller's copy, and is worth pinning here directly rather than trusting the header
// comment: `.match` (non-global) takes the FIRST declaration in `code`, but
// JS function-declaration hoisting means the LAST one wins at runtime. A
// duplicate pasted in AFTER the real one must not silently swap which
// function every caller gets.
test("a duplicate declaration placed after the real one still returns the first (documented ceiling)", () => {
  const code = `
function pick(n) {
  return "real";
}
function pick(n) {
  return "shadow";
}
`;
  const pick = lift(code, "pick", "n");
  assert.equal(pick(1), "real", "lift() must return the first (real) declaration, not the last (shadow) one");
});
