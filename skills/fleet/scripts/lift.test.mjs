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
test("lift refuses with a message naming the function and signature when nothing matches", () => {
  const code = `function double(n) { return n * 2; }`;
  assert.throws(
    () => lift(code, "triple", "n"),
    /review-pr\.js no longer declares triple\(n\) at top level — update this test/,
  );
  assert.throws(
    () => lift(code, "double", "n, extra"),
    /review-pr\.js no longer declares double\(n, extra\) at top level — update this test/,
  );
});

// AC-4 (#533): "the helper must not quietly return a stale or wrong
// function." Extracting this restructures every one of the five call sites
// to route through ONE `.match`/`new Function` pair instead of five separate
// copies — so lift.mjs's own first-match ceiling (documented in its header,
// measured 2026-08-17 on PR #536) is now a property of one module instead of
// five, and is worth pinning here directly rather than trusting the header
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
