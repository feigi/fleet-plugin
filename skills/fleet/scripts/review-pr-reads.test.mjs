import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `workflows/review-pr.js` runs a top-level `await pipeline(...)`, so importing
// it executes the workflow. Both functions under test are lifted out of the
// SOURCE TEXT instead — the same technique as `select-dimensions.test.mjs:23-40`
// and `review-pr-testcmd.test.mjs:23-33`, and for the same reason: extraction to
// a module would need `import` to resolve inside the Workflow sandbox ("no
// filesystem or Node.js API access"), which nothing in `workflows/` does, and a
// failed import bricks the fleet's DEFAULT review path.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Each declaration is a top-level `function` whose body contains no line
// starting at column 0 with `}`, so the non-greedy match ends on its own
// closing brace.
function lift(name, signature) {
  const re = new RegExp(`^function ${name}\\(${signature}\\) \\{[\\s\\S]*?^\\}$`, "m");
  const m = SOURCE.match(re);
  assert.ok(m, `review-pr.js no longer declares ${name}(${signature}) at top level — update this test`);
  return new Function(`${m[0]}\nreturn ${name};`)();
}

const usableDiff = lift("usableDiff", "snap");

// A diff that is empty, or that describes a commit other than the snapshot's,
// is worse than no diff: the specialist reads it as authoritative.
test("usableDiff rejects a diff that would lie about the snapshot", () => {
  assert.equal(usableDiff({ head: "aaa" }), null, "no diffPath");
  assert.equal(
    usableDiff({ head: "aaa", diffLines: 40 }),
    null,
    "diffPath absent but diffLines truthy — isolates the diffPath guard from the diffLines guard",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 0 }),
    null,
    "0-byte diff — `gh pr diff` exits 1 and still leaves the file",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, prHead: "bbb" }),
    null,
    "prHead present and unequal — the diff describes another commit",
  );
});

// The inversion this guard is most likely to get wrong. `gh pr view` can fail
// while `gh pr diff` succeeded; dropping a good diff over a MISSING cross-check
// lets absent input narrow coverage — the `=== true` convention at
// review-pr.js:255-257, inverted.
test("usableDiff accepts when prHead is absent or matching", () => {
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40 }),
    "/s/pr.diff",
    "missing prHead must not suppress an otherwise good diff",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, prHead: "aaa" }),
    "/s/pr.diff",
  );
});

const readRules = lift("readRules", "diffPath, stats");

const PATHS = {
  paths: [
    { path: "workflows/review-pr.js", kind: "src", loc: 115 },
    { path: "docs/specs/a.md", kind: "docs", loc: 393 },
  ],
};

// Emitting both the diff pointer and the file list doubles the block on exactly
// the PRs where prompt size matters most. The branches are exclusive.
test("readRules names the diff and does not also list files", () => {
  const out = readRules("/s/pr.diff", PATHS);
  assert.match(out, /\/s\/pr\.diff/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

test("readRules falls back to the changed-file list with each file's loc", () => {
  const out = readRules(null, PATHS);
  assert.match(out, /No diff file was captured/);
  assert.match(out, /workflows\/review-pr\.js \(115\)/);
  assert.match(out, /docs\/specs\/a\.md \(393\)/);
});

// `stats` is null whenever diff-stats.mjs errored or its blob was unparseable
// (review-pr.js:399-406). Saying so beats emitting an empty list, which reads
// as "the PR touched no files".
test("readRules says so when it has neither a diff nor a file list", () => {
  const out = readRules(null, null);
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// A `stats` object whose `paths` is empty must NOT fall into branch 2 — that
// would print the header with nothing under it. `.length` is the guard.
test("readRules treats an empty paths array as no file list", () => {
  const out = readRules(null, { paths: [] });
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// A `stats` object that is truthy but carries no `paths` key at all (distinct
// from an empty array) must hit the same fallback. `stats.paths` is its own
// conjunct in the guard, separate from `.length`, and nothing above isolates
// it: every other test's `stats` either has a real `paths` array or is `null`
// outright, so a middle-conjunct deletion (`stats && stats.paths.length`,
// dropping `stats.paths &&`) reads `undefined.length` — a real production
// crash if diff-stats.mjs ever returns a blob without `paths` — and every
// existing test still passes around it.
test("readRules treats a stats object with no paths key as no file list", () => {
  const out = readRules(null, {});
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// The rule is the whole point of the block; it must survive every branch, not
// just the happy one. Assert the imperative and the counting clause, not a word
// that also appears in the surrounding rationale.
test("every branch carries the bounding rule", () => {
  for (const out of [readRules("/s/pr.diff", PATHS), readRules(null, PATHS), readRules(null, null)]) {
    assert.match(out, /BOUND EVERY READ/);
    assert.match(out, /'wc -l' says it is small/);
  }
});

// Bound the slice at BOTH ends. `indexOf` returns -1 when absent and `slice(-1)`
// is a truthy one-character string, so asserting on an unbounded slice passes
// with the whole block deleted — and an unbounded end runs to EOF, where the
// specialist and refuter prompts can satisfy the same assertions. This is the
// defect `review-pr-testcmd.test.mjs:99-107` records having shipped.
function slice(from, to) {
  const at = SOURCE.indexOf(from);
  assert.notEqual(at, -1, `review-pr.js no longer contains "${from}" — update this test`);
  const end = SOURCE.indexOf(to, at + from.length);
  assert.notEqual(end, -1, `review-pr.js no longer contains "${to}" after "${from}" — update this test`);
  return SOURCE.slice(at, end);
}

// `additionalProperties: false` at :300 REJECTS an undeclared field, so a prompt
// that asks for these three while the schema omits them silently yields nothing.
// Both halves have to be pinned or the feature disconnects in one token.
test("the snapshot agent asks for the diff facts AND declares them in its schema", () => {
  const snapshot = slice("const snap = await agent(", "if (!snap");
  assert.match(snapshot, /gh pr diff \$\{pr\} > \$\{scratch\}\/pr\.diff/, "no diff capture");
  // `/headRefOid/` alone also matches the prose ("Report `prHead` = the
  // headRefOid") a few lines down, so deleting this command left the suite
  // green — pin the command line itself, not a word it shares with prose.
  assert.match(
    snapshot,
    /gh pr view \$\{pr\} --json headRefOid -q \.headRefOid/,
    "no PR head to cross-check against the snapshot's",
  );
  assert.match(snapshot, /wc -l < \$\{scratch\}\/pr\.diff/, "no line count — a 0-byte diff would pass as usable");
  for (const field of ["diffPath", "diffLines", "prHead"]) {
    // Anchored past `^(?!\s*\/\/)` so a commented-out declaration — text a
    // reader's eye skips but an unanchored regex still matches — reds. Same
    // vacuous-pin class recorded against this file in PR #216 (`select-dimensions`
    // pin): a whole/sliced-source assert.match satisfied by dead text.
    assert.match(
      snapshot,
      new RegExp(`^(?!\\s*//)\\s*${field}:\\s*\\{\\s*type:`, "m"),
      `${field} is not declared in the schema — additionalProperties:false drops it`,
    );
  }
  // The review must survive a gh failure. These three stay out of `required`.
  assert.match(snapshot, /required:\s*\["path",\s*"head"\]/, "required must stay path+head only");
});

// The functions are worthless if nothing calls them, and a text-lift pin tests a
// COPY: it stays green while the feature disconnects. Pin the CALL SITES.
test("the specialist prompt interpolates the read rules", () => {
  const prompt = slice("READ ONLY FROM THE SNAPSHOT", "Scratch files go in");
  assert.match(prompt, /\$\{readRules\(usableDiff\(snap\), stats\)\}/);
});

test("the refuter prompt interpolates the same read rules", () => {
  const prompt = slice("Try to REFUTE this finding", "Scratch: ");
  assert.match(prompt, /\$\{readRules\(usableDiff\(snap\), stats\)\}/);
});

// A second declaration would let one call site silently bind a different body.
test("each function is declared exactly once at top level", () => {
  for (const name of ["usableDiff", "readRules"]) {
    const hits = SOURCE.match(new RegExp(`^function ${name}\\(`, "gm")) || [];
    assert.equal(hits.length, 1, `${name} is declared ${hits.length} times`);
  }
});
