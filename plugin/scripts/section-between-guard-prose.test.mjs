// #753. `section()` was a name-invisible twin of prose-pin.mjs's exported
// `between(text, from, to, what)`, duplicated byte-for-byte three times
// (implementer-model-tier.test.mjs, review-path-default.test.mjs) or with
// `RUN_TEAM` closed over instead of taken as an argument
// (fleet-tick-prose.test.mjs). All three survived #751's own extraction
// because every sweep of that PR searched for the NAME `between` — this one
// searches for the SHAPE instead: `indexOf` -> `assert.notEqual(_, -1)` ->
// `indexOf` -> `assert.notEqual(_, -1)` -> `.slice(at, end)`, the five
// statements `between()`'s body is built from, independent of what the
// function or its parameters are called.
//
// SCOPED to a REUSABLE definition, not to every anchor-slicing helper in this
// directory. A parameterized function whose SOURCE TEXT is itself a parameter
// (`section(source, startAnchor, endAnchor, label)`, `between(text, from, to,
// what)`) is interchangeable with `prose-pin.mjs`'s export by a one-line
// import — that substitutability is what makes a second definition a twin
// worth failing on. A function that CLOSES over a module-level constant
// instead (`function section(start, end) { RUN_TEAM.indexOf(start) ... }`, as
// dispatch-block-pins-prose.test.mjs, finisher-own-tree-prose.test.mjs,
// finisher-pin-race-prose.test.mjs and member-outcomes-prose.test.mjs all
// independently do, and as fleet-tick-prose.test.mjs did before this ticket)
// is not: #608 already ruled on this exact pattern ("a file-local test
// fixture: each copy is imported by nobody and called only by its own
// suite... drift produced no false green and no wrong behaviour — it
// produced nothing"), and re-litigating that per file is what #753 itself
// says not to do. Requiring the source-text parameter to be a real parameter
// (checked below, not just assumed from the shape) is what keeps this sweep
// from reproducing #608's own refused pin.
//
// cross-repo-citation-prose.test.mjs's `slice(text, startAnchor, endAnchor,
// what, { endsFile })` is the measured near-miss: it DOES take `text` as a
// parameter, but its body threads an `if (end === -1 && endsFile) return
// text.slice(at);` branch between the second `indexOf` and the second
// `assert.notEqual` — the five statements below are no longer adjacent, so
// the shape regex does not match it, and it must not: that function does
// something `between()` cannot (an EOF-tolerant slice) and is not a copy of
// it. Measured directly against this file's own detector, not asserted.
//
// THE FLOOR: an empty or near-empty directory listing (a broken glob, or this
// file moved to the wrong place) would make the main assertion below pass
// vacuously — nothing scanned, nothing found. `SCRIPTS.length` is asserted
// against a conservative floor to catch that before it hides a real
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
// arrow, with identifiers free to vary (matched by backreference, not by
// name) — `between`, `section`, and any future reintroduction's own choice
// of names all satisfy it identically.
const TWIN_SHAPE = /(?:function\s+\w+\s*\(([^)]*)\)|(?:const|let)\s+\w+\s*=\s*\(([^)]*)\)\s*=>)\s*\{\s*const\s+(\w+)\s*=\s*(\w+)\.indexOf\((\w+)\);\s*assert\.notEqual\(\3,\s*-1,[\s\S]*?\);\s*const\s+(\w+)\s*=\s*\4\.indexOf\((\w+),\s*\3\s*\+\s*\5\.length\);\s*assert\.notEqual\(\6,\s*-1,[\s\S]*?\);\s*return\s+\4\.slice\(\3,\s*\6\);\s*\}/g;

const paramNames = (raw) =>
  (raw ?? "").split(",").map((p) => p.trim().split(/[\s=]/)[0]).filter(Boolean);

/**
 * Every `between()`-shaped definition in `text` whose source-text argument is
 * a real parameter of the enclosing function — the reusable, `import`-able
 * twin this guard exists to catch. A closure over an outer constant (no
 * source-text parameter) never appears here, by construction.
 */
function twinDefinitions(text) {
  const found = [];
  for (const m of text.matchAll(TWIN_SHAPE)) {
    const params = paramNames(m[1] ?? m[2]);
    const src = m[4], from = m[5], to = m[7];
    if (params.includes(src) && params.includes(from) && params.includes(to)) {
      found.push({ src, from, to });
    }
  }
  return found;
}

const SCRIPTS = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && f !== SELF && f !== PROSE_PIN);

test("the sweep sees the scripts it is supposed to police", () => {
  // A floor, not a count: this directory carries ~150 `.mjs` files today and
  // a regression here (an empty/near-empty listing) would make the twin
  // sweep below pass over nothing rather than over the tree.
  assert.ok(SCRIPTS.length >= 100, `expected the plugin/scripts .mjs files, found ${SCRIPTS.length}`);
});

test("the shape detector fires on the exact bodies #753 removed, by construction", () => {
  // Positive control: both named-parameter shapes the three removed copies
  // actually used (`section(source, ...)` and fleet-tick-prose's since-fixed
  // `RUN_TEAM`-closure would NOT fire — see the negative control below — but
  // its sibling two DID take `source` as a parameter).
  const reintroduced = `
function section(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, \`\${label}: '\${startAnchor}' moved\`);
  const end = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, \`\${label}: '\${endAnchor}' moved\`);
  return source.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(reintroduced), [{ src: "source", from: "startAnchor", to: "endAnchor" }]);

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

test("the shape detector does not fire on a closure over an outer constant, the pattern #608 already blessed", () => {
  // Negative control: fleet-tick-prose.test.mjs's OWN pre-fix body — same
  // five statements, but `RUN_TEAM` is a free variable, not a parameter, so
  // this function cannot be swapped for an `import` the way the removed
  // copies could. Matches member-outcomes-prose.test.mjs's still-live
  // `section(start, end)` in every respect that matters here.
  const closure = `
const RUN_TEAM = "…";
function section(startAnchor, endAnchor, label) {
  const at = RUN_TEAM.indexOf(startAnchor);
  assert.notEqual(at, -1, label);
  const end = RUN_TEAM.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, label);
  return RUN_TEAM.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(closure), []);
});

test("no file outside prose-pin.mjs defines a second reusable between()-shaped slicer", () => {
  const offenders = [];
  for (const file of SCRIPTS) {
    const text = readFileSync(join(DIR, file), "utf8");
    for (const twin of twinDefinitions(text)) {
      offenders.push(`${file} (params: ${twin.src}, ${twin.from}, ${twin.to})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `reintroduced a between()-shaped slicer outside prose-pin.mjs — import { between } instead:\n${offenders.join("\n")}`,
  );
});
