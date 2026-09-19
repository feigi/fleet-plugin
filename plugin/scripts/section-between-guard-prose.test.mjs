// #753. `section()` was a name-invisible twin of prose-pin.mjs's exported
// `between(text, from, to, what)`, duplicated byte-for-byte in
// implementer-model-tier.test.mjs and review-path-default.test.mjs, and with
// `RUN_TEAM` closed over instead of taken as an argument in
// fleet-tick-prose.test.mjs, within-run-pair-prose.test.mjs, and
// member-outcomes-prose.test.mjs. All five survived #751's own extraction
// because every sweep of that PR searched for the NAME `between` — this one
// searches for the SHAPE instead: `indexOf` -> `assert.notEqual(_, -1)` ->
// `indexOf(_, at + from.length)` -> `assert.notEqual(_, -1)` -> `return
// src.slice(at, end)`, the five statements `between()`'s body is built from,
// independent of what the function, its parameters, or its captured
// variables are called.
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
// Two near-misses in this same directory are NOT twins, and must not match,
// because each changes what the function DOES relative to `between()`
// (measured against this file's own detector, not asserted):
//
//   dispatch-block-pins-prose.test.mjs's `region()` and
//   finisher-pin-race-prose.test.mjs's `causeBlock()` both return
//   `SRC.slice(at + START.length, end)` — the start anchor STRIPPED, not
//   kept. `member-prompt-prose.test.mjs`'s inlined `memberBlocks()` was the
//   same divergence when #753 cited it: `between()` keeps the start anchor;
//   these need it gone, and swapping in `between()` un-stripped changes their
//   output. #1465 rewrote `memberBlocks()` onto `anchorAt()`/`phrase()`, so it
//   no longer has an `indexOf`/`assert.notEqual` shape at all and is excluded
//   from this file's own detector by construction, not by this near-miss.
//
//   finisher-own-tree-prose.test.mjs's `between()` returns
//   `flat(RUN_TEAM.slice(at, to))` — flattened before return, not a bare
//   slice. Its own caller needs the flattening; a shared `between()` does not
//   do it and could not without changing every other caller's output too.
//
//   cross-repo-citation-prose.test.mjs's `slice(text, startAnchor,
//   endAnchor, what, { endsFile })` threads an `if (end === -1 && endsFile)
//   return text.slice(at);` branch between the second `indexOf` and the
//   second `assert.notEqual` — the five statements are no longer adjacent,
//   and the function does something (`endsFile`'s EOF tolerance) `between()`
//   cannot.
//
// finisher-pin-race-prose.test.mjs's `fallbackSection()` and
// review-pr-citation-prose.test.mjs's `specialists()` looked like two more —
// a search from `at` instead of `at + start.length`, and a literal-anchor
// call this detector cannot even see, respectively — but a before/after
// byte comparison against their real inputs (RUN_TEAM / REVIEW_AND_FIX)
// proved both output-identical to `between()`: neither pair's end anchor
// ever occurs inside its own start anchor's text, so the narrower contract
// `fallbackSection()`'s own header once claimed never actually diverges.
// Both are now `import { between }` call sites like every other consumer,
// not documented exceptions.
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
import { stripComments } from "./strip-comments.mjs";

const DIR = import.meta.dirname;
const SELF = "section-between-guard-prose.test.mjs";
const PROSE_PIN = "prose-pin.mjs";

// The five statements `between()`'s body is built from, as one pattern:
//   const AT = SRC.indexOf(FROM);
//   assert.notEqual(AT, -1, ...);
//   const END = SRC.indexOf(TO, AT + FROM.length);
//   assert.notEqual(END, -1, ...);
//   return SRC.slice(AT, END);
// captured over a `function name(...)` declaration, a `(...) => {` arrow
// bound with `const`, `let`, or `var`, or a bare method-shorthand
// `name(...) {` (the name position excludes the JS control-flow keywords —
// `if`/`for`/`while`/`switch`/`catch`/`do`/`with`/`else` — so an ordinary
// control-flow block is never mistaken for a twin), with every identifier
// free to vary (matched by backreference, not by name) and free to be
// either a parameter or a closed-over outer constant — `between`,
// `section`, and any future reintroduction's own choice of names and
// scoping all satisfy it identically. `const`, `let`, and `var` are all
// accepted for the two inner declarations for the same reason: nothing
// about the shape depends on which keyword binds `at` and `end`.
// The exact offset (`AT + FROM.length`) is what a dedicated near-miss fixture
// below fails on, isolated from the bare-slice-return check by keeping the
// return identical to `between()`'s; the bare slice return is what the two
// other near-misses fail on, deliberately. #1422: before that dedicated
// fixture existed, both `strippedStart` and `flattenedReturn` were excluded
// by their return-shape divergence alone — measured directly, restoring
// each one's offset to the exact `AT + FROM.length` shape and re-running
// still produced no match, because the return-shape divergence rejects them
// first. The offset backreference itself had zero fixture coverage: a
// mutation making it optional (accepting any or no second `indexOf`
// argument) survived every existing test. `fallbackSection()`'s own
// historical shape — a search from `AT` instead of `AT + FROM.length` — is
// exactly what the new dedicated fixture below models, so the guard now
// actually exercises the divergence that shape once took.
//
// Comments are stripped before matching (`strip-comments.mjs`, the same
// helper candidates.test.mjs and the review-pr-*.test.mjs pins already
// share): this repo's own style routinely puts a `//` line between two of
// the five statements (cross-repo-citation-prose.test.mjs), and the `\s*`
// separators above do not span a real comment's text — measured directly,
// an un-stripped scan misses a reintroduced twin written that way.
// `strip-comments.mjs` only blanks WHOLE-LINE comments by design (its own
// header's documented ceiling — candidates.test.mjs and the review-pr-*
// pins depend on trailing comment text surviving); a TRAILING `stmt; //
// note` therefore reaches TWIN_SHAPE unstripped. #1422: measured live, a
// trailing-commented twin appended to a real scanned file passed the sweep
// below undetected. Fixed here, not in the shared helper, with an optional
// `(?:[ \t]*\/\/[^\n]*)?` after each of the five statements' own `;` —
// scoped to this file's own separator so the shared helper's ceiling, and
// everything measured against it, is untouched.
//
// SCOPE, and not reopened after this round: the shape above is matched
// under function, const/let/var arrow, and method-shorthand declarations
// and no others — generator functions, computed method names, decorators,
// and any spelling past those are deliberately unattempted, because a
// regex-based structural guard cannot enumerate every JS declaration syntax
// and only needs to outlast the spellings a reintroduction has actually
// taken, not every one it could someday take.
const TWIN_SHAPE = /(?:function\s+\w+\s*\(([^)]*)\)|(?:const|let|var)\s+\w+\s*=\s*\(([^)]*)\)\s*=>|\b(?!function\b|if\b|for\b|while\b|switch\b|catch\b|do\b|with\b|else\b)\w+\s*\((?:[^)]*)\))\s*\{\s*(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\.indexOf\((\w+)\);(?:[ \t]*\/\/[^\n]*)?\s*assert\.notEqual\(\3,\s*-1,[\s\S]*?\);(?:[ \t]*\/\/[^\n]*)?\s*(?:const|let|var)\s+(\w+)\s*=\s*\4\.indexOf\((\w+),\s*\3\s*\+\s*\5\.length\);(?:[ \t]*\/\/[^\n]*)?\s*assert\.notEqual\(\6,\s*-1,[\s\S]*?\);(?:[ \t]*\/\/[^\n]*)?\s*return\s+\4\.slice\(\3,\s*\6\);(?:[ \t]*\/\/[^\n]*)?\s*\}/g;

/** Every `between()`-shaped definition in `text`, wherever it lives. */
function twinDefinitions(text) {
  return [...stripComments(text).matchAll(TWIN_SHAPE)].map((m) => ({ src: m[4], from: m[5], to: m[7] }));
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

  // Positive control, closure form (fleet-tick-prose.test.mjs,
  // within-run-pair-prose.test.mjs, and member-outcomes-prose.test.mjs's own
  // removed shape) — the source text is a free variable, not a parameter,
  // and must fire exactly as readily.
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

  // A `//` comment between two of the five statements, and `let` instead of
  // `const` for both inner declarations — this repo's own style
  // (cross-repo-citation-prose.test.mjs) and a measured miss: an earlier
  // revision of TWIN_SHAPE matched none of this against the unstripped
  // source.
  const commented = `
function twin(text, from, to, what) {
  let at = text.indexOf(from);
  // explain why this search runs first
  assert.notEqual(at, -1, what);
  let end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, what);
  return text.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(commented), [{ src: "text", from: "from", to: "to" }]);

  // #1422: a TRAILING `//` comment on one of the five statement lines, not
  // a comment on its own line — `strip-comments.mjs` only blanks whole-line
  // comments (its own documented ceiling), so this reaches TWIN_SHAPE with
  // the comment text still attached to the statement. Measured miss: an
  // earlier revision of TWIN_SHAPE matched none of this.
  const trailingComment = `
function twin(text, from, to, what) {
  let at = text.indexOf(from); // note
  assert.notEqual(at, -1, what);
  let end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, what);
  return text.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(trailingComment), [{ src: "text", from: "from", to: "to" }]);

  // Positive control, method-shorthand form — no real removed twin took
  // this shape, but a bare `name(...) { ... }` inside an object literal or
  // class must fire exactly as readily as a `function` declaration or an
  // arrow, and must not be confused with an ordinary control-flow block
  // (see the "does not fire" test below for that half of the guard).
  const methodShorthand = `
const helper = {
  grab(text, from, to, what) {
    const at = text.indexOf(from);
    assert.notEqual(at, -1, what);
    const end = text.indexOf(to, at + from.length);
    assert.notEqual(end, -1, what);
    return text.slice(at, end);
  },
};`;
  assert.deepEqual(twinDefinitions(methodShorthand), [{ src: "text", from: "from", to: "to" }]);

  // Positive control, `var`-declared form — both the arrow-style
  // declaration and the two inner offset variables must fire when bound
  // with `var` instead of `const`/`let`, the same reasoning carried one
  // keyword further.
  const varForm = `
var twin = (text, from, to, what) => {
  var at = text.indexOf(from);
  assert.notEqual(at, -1, what);
  var end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, what);
  return text.slice(at, end);
};`;
  assert.deepEqual(twinDefinitions(varForm), [{ src: "text", from: "from", to: "to" }]);
});

test("the shape detector does not fire on the measured near-misses", () => {
  // Each changes one thing between() does not: stripped start anchor, or a
  // flattened return. See the header for which file each is modeled on.
  // Neither isolates the offset backreference: restoring each one's second
  // `indexOf` to the exact `AT + FROM.length` shape still leaves it
  // excluded, by the same return-shape divergence — see `offsetOnly` below
  // for the fixture that isolates the offset check on its own.
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

  // #1422: isolates the offset backreference on its own — everywhere else
  // identical to `between()`, including a bare `text.slice(at, end)`
  // return, so this cannot be excluded by the return-shape check the two
  // fixtures above are actually excluded by. Models `fallbackSection()`'s
  // own historical shape (a search from `at` instead of `at +
  // from.length`) — see the header. Mutation-tested: making the offset
  // backreference optional (accepting any or no second `indexOf` argument)
  // makes this fixture match while leaving `strippedStart` and
  // `flattenedReturn` correctly excluded for their own separate reasons.
  const offsetOnly = `
function offsetless(text, from, to, what) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, what);
  const end = text.indexOf(to, at);
  assert.notEqual(end, -1, what);
  return text.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(offsetOnly), []);

  // A control-flow block shaped exactly like the five statements must not
  // be mistaken for a method-shorthand twin — the third TWIN_SHAPE
  // alternative excludes JS keywords from the name position for exactly
  // this reason.
  const ifBlock = `
if (x) {
  const at = RUN_TEAM.indexOf(x);
  assert.notEqual(at, -1, "x");
  const end = RUN_TEAM.indexOf(y, at + x.length);
  assert.notEqual(end, -1, "y");
  return RUN_TEAM.slice(at, end);
}`;
  assert.deepEqual(twinDefinitions(ifBlock), []);
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
