// #753. `section()` was a name-invisible twin of prose-pin.mjs's exported
// `between(text, from, to, what)`, duplicated byte-for-byte in
// implementer-model-tier.test.mjs and review-path-default.test.mjs, and with
// `RUN_TEAM` closed over instead of taken as an argument in
// fleet-tick-prose.test.mjs and within-run-pair-prose.test.mjs. All four
// survived #751's own extraction because every sweep of that PR searched for
// the NAME `between` — this one searches for the SHAPE instead: `indexOf` ->
// `assert.notEqual(_, -1)` -> `indexOf(_, at + from.length)` ->
// `assert.notEqual(_, -1)` -> `return src.slice(at, end)`, the five
// statements `between()`'s body is built from, independent of what the
// function, its parameters, or its captured variables are called.
//
// NOT scoped to a reusable (parameterized) definition — an earlier revision
// of this file was, on the theory that a closure over a module-level
// constant is a distinct, already-blessed pattern (#608: "a file-local test
// fixture... drift produced no false green and no wrong behaviour"). That
// theory under-caught: within-run-pair-prose.test.mjs's own closure-shaped
// `section(startAnchor, endAnchor, label)` is exactly as much a twin of
// `between()` as the two parameterized copies were, and #608's own reasoning
// is about a fixture with ONE consumer, not about whether the five
// statements happen to close over an outer name instead of taking it as an
// argument. The shape below no longer cares which.
//
// Three near-misses in this same directory are NOT twins, and must not
// match, because each changes what the function DOES relative to `between()`
// (measured against this file's own detector, not asserted):
//
//   dispatch-block-pins-prose.test.mjs's `region()` and
//   finisher-pin-race-prose.test.mjs's `causeBlock()` both return
//   `SRC.slice(at + START.length, end)` — the start anchor STRIPPED, not
//   kept. `member-prompt-prose.test.mjs`'s inlined `memberBlocks()` is the
//   same divergence, cited in #753 itself: `between()` keeps the start
//   anchor; these need it gone, and swapping in `between()` un-stripped
//   changes their output.
//
//   finisher-own-tree-prose.test.mjs's `between()` returns
//   `flat(RUN_TEAM.slice(at, to))` — flattened before return, not a bare
//   slice. Its own caller needs the flattening; a shared `between()` does not
//   do it and could not without changing every other caller's output too.
//
//   finisher-pin-race-prose.test.mjs's `fallbackSection()` searches for its
//   end anchor from `at` — the START match's own position — never adding
//   `+ FALLBACK_START.length`. `between()` always searches from AFTER the
//   start anchor; a call whose end anchor could legally sit inside the start
//   anchor's own text is a different, narrower contract, not a copy.
//
//   cross-repo-citation-prose.test.mjs's `slice(text, startAnchor,
//   endAnchor, what, { endsFile })` threads an `if (end === -1 && endsFile)
//   return text.slice(at);` branch between the second `indexOf` and the
//   second `assert.notEqual` — the five statements are no longer adjacent,
//   and the function does something (`endsFile`'s EOF tolerance) `between()`
//   cannot.
//
// THE FLOOR: an empty or near-empty directory listing (a broken glob, or
// this file moved to the wrong place) would make the main assertion below
// pass vacuously — nothing scanned, nothing found. `SCRIPTS.length` is
// asserted against a conservative floor to catch that before it hides a real
// regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;
const SELF = "section-between-guard-prose.test.mjs";
const PROSE_PIN = "prose-pin.mjs";

// The five statements `between()`'s body is built from, as one pattern:
//   const AT = SRC.indexOf(FROM);
//   assert.notEqual(AT, -1, ...);
//   const END = SRC.indexOf(TO, AT + FROM.length);
//   assert.notEqual(END, -1, ...);
//   return SRC.slice(AT, END);
// captured over both a `function name(...)` declaration and a `(...) => {`
// arrow, with every identifier free to vary (matched by backreference, not
// by name) and free to be either a parameter or a closed-over outer
// constant — `between`, `section`, and any future reintroduction's own
// choice of names and scoping all satisfy it identically. The exact offset
// (`AT + FROM.length`) and the bare slice return are what the three
// near-misses above fail on, deliberately.
const TWIN_SHAPE = /(?:function\s+\w+\s*\(([^)]*)\)|(?:const|let)\s+\w+\s*=\s*\(([^)]*)\)\s*=>)\s*\{\s*const\s+(\w+)\s*=\s*(\w+)\.indexOf\((\w+)\);\s*assert\.notEqual\(\3,\s*-1,[\s\S]*?\);\s*const\s+(\w+)\s*=\s*\4\.indexOf\((\w+),\s*\3\s*\+\s*\5\.length\);\s*assert\.notEqual\(\6,\s*-1,[\s\S]*?\);\s*return\s+\4\.slice\(\3,\s*\6\);\s*\}/g;

/** Every `between()`-shaped definition in `text`, wherever it lives. */
function twinDefinitions(text) {
  return [...text.matchAll(TWIN_SHAPE)].map((m) => ({ src: m[4], from: m[5], to: m[7] }));
}

const SCRIPTS = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && f !== SELF && f !== PROSE_PIN);

test("the sweep sees the scripts it is supposed to police", () => {
  // A floor, not a count: this directory carries ~150 `.mjs` files today and
  // a regression here (an empty/near-empty listing) would make the twin
  // sweep below pass over nothing rather than over the tree.
  assert.ok(SCRIPTS.length >= 100, `expected the plugin/scripts .mjs files, found ${SCRIPTS.length}`);
});

test("the shape detector fires on the exact bodies #753 removed, by construction", () => {
  // Positive control, parameterized form (implementer-model-tier.test.mjs
  // and review-path-default.test.mjs's own removed shape).
  const parameterized = `
function section(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, \`\${label}: '\${startAnchor}' moved\`);
  const end = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, \`\${label}: '\${endAnchor}' moved\`);
  return source.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(parameterized), [{ src: "source", from: "startAnchor", to: "endAnchor" }]);

  // Positive control, closure form (fleet-tick-prose.test.mjs and
  // within-run-pair-prose.test.mjs's own removed shape) — the source text is
  // a free variable, not a parameter, and must fire exactly as readily.
  const closure = `
const RUN_TEAM = "…";
function section(startAnchor, endAnchor, label) {
  const at = RUN_TEAM.indexOf(startAnchor);
  assert.notEqual(at, -1, label);
  const end = RUN_TEAM.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, label);
  return RUN_TEAM.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(closure), [{ src: "RUN_TEAM", from: "startAnchor", to: "endAnchor" }]);

  // prose-pin.mjs's own `between` — an arrow-function reintroduction under a
  // different name must be caught exactly as readily as a `function` one.
  const arrowForm = `
const clone = (text, from, to, what) => {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, what);
  const end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, what);
  return text.slice(at, end);
};`;
  assert.deepEqual(twinDefinitions(arrowForm), [{ src: "text", from: "from", to: "to" }]);
});

test("the shape detector does not fire on the three measured near-misses", () => {
  // Each changes one thing between() does not: stripped start anchor,
  // flattened return, or a missing offset. See the header for which file
  // each is modeled on.
  const strippedStart = `
function region() {
  const at = RUN_TEAM.indexOf(START);
  assert.notEqual(at, -1, "x");
  const end = RUN_TEAM.indexOf(END, at);
  assert.notEqual(end, -1, "y");
  return RUN_TEAM.slice(at + START.length, end);
}`;
  assert.deepEqual(twinDefinitions(strippedStart), []);

  const flattenedReturn = `
function between(start, end) {
  const at = RUN_TEAM.indexOf(start);
  assert.notEqual(at, -1, "x");
  const to = RUN_TEAM.indexOf(end, at);
  assert.notEqual(to, -1, "y");
  return flat(RUN_TEAM.slice(at, to));
}`;
  assert.deepEqual(twinDefinitions(flattenedReturn), []);

  const missingOffset = `
function fallbackSection() {
  const at = RUN_TEAM.indexOf(FALLBACK_START);
  assert.notEqual(at, -1, "x");
  const end = RUN_TEAM.indexOf(FALLBACK_END, at);
  assert.notEqual(end, -1, "y");
  return RUN_TEAM.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(missingOffset), []);
});

test("no file outside prose-pin.mjs defines a second between()-shaped slicer", () => {
  const offenders = [];
  for (const file of SCRIPTS) {
    const text = readFileSync(join(DIR, file), "utf8");
    for (const twin of twinDefinitions(text)) {
      offenders.push(`${file} (src: ${twin.src}, from: ${twin.from}, to: ${twin.to})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `reintroduced a between()-shaped slicer outside prose-pin.mjs — import { between } instead:\n${offenders.join("\n")}`,
  );
});
