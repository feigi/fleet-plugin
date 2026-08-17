import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #317. `workflows/review-pr.js` cited `review-and-fix.md` by LINE, twice, and
// both citations rotted: `:49` (for "keys or dimension objects", by then at
// `:53`) and `:47` (for the source-of-truth/bounding rule, by then at `:51`).
// Neither failed visibly — the fleet rewrites that file most runs, so a stale
// number lands on real, plausible prose about the same subsystem rather than on
// nothing. That is the whole defect class: a citation that resolves to the
// WRONG paragraph reads as verified, while one that resolves to nothing does
// not. Both are now anchored on the section name plus a quoted fragment, and
// this file is what keeps them that way.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "skills", "fleet", "commands", "review-and-fix.md"), "utf8");

// Comment prose, wrap-invisible: the citations span three or four `//` lines,
// so a fragment only matches once the markers and the hard wrap are gone. Runs
// against comments deliberately — the inverse of `review-pr-reads.test.mjs`,
// which strips them because its pins are about code.
const PROSE = SOURCE.replace(/^[ \t]*\/\/ ?/gm, "").replace(/\s+/g, " ");

// Both bounds hard-asserted: a moved header must red loudly here rather than
// silently widening the slice to the rest of the file, where an incidental
// mention would satisfy every assertion below.
function specialists() {
  const at = REVIEW_AND_FIX.indexOf("## Specialists");
  assert.notEqual(at, -1, "review-and-fix.md no longer has a `## Specialists` header — both citations name it");
  const end = REVIEW_AND_FIX.indexOf("\n## Judging findings", at);
  assert.notEqual(end, -1, "the `## Judging findings` header moved — the Specialists slice is unbounded");
  return REVIEW_AND_FIX.slice(at, end);
}

test("review-pr.js cites review-and-fix.md by section, never by line", () => {
  assert.doesNotMatch(
    SOURCE,
    /review-and-fix\.md:\d+/,
    "a line-numbered citation is back in review-pr.js — the fleet rewrites that file most runs, so the number is stale on arrival and lands on unrelated prose instead of failing",
  );
});

// The other half, and the one that makes the ban worth anything: a citation
// nobody can resolve is no better than a wrong number. Each fragment has to be
// quoted verbatim in review-pr.js AND still live inside the section it names —
// checking only the md would stay green with the citation deleted outright.
for (const fragment of [
  "keys or dimension objects",
  "`git show <sha>:<path>` is the source of truth",
  "Then bound the read",
]) {
  test(`the citation anchored on "${fragment}" still resolves`, () => {
    assert.ok(
      PROSE.includes(`"${fragment}"`),
      `review-pr.js no longer quotes "${fragment}" — the citation lost the fragment half of its anchor, leaving only a section name`,
    );
    assert.ok(
      specialists().includes(fragment),
      `"${fragment}" is gone from review-and-fix.md's Specialists section — review-pr.js quotes it as the anchor, so the citation now resolves to nothing`,
    );
  });
}
