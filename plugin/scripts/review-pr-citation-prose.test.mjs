import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between } from "./prose-pin.mjs";

// #317. `workflows/review-pr.js` cited `review-and-fix.md` by LINE, twice, and
// both citations rotted: `:49` (for "keys or dimension objects", by then at
// `:53`) and `:47` (for the source-of-truth/bounding rule, by then at `:51`).
// Neither failed visibly — the fleet rewrites that file most runs, so a stale
// number lands on real, plausible prose about the same subsystem rather than on
// nothing. That is the whole defect class: a citation that resolves to the
// WRONG paragraph reads as verified, while one that resolves to nothing does
// not. Both are now anchored on the section name plus a quoted fragment, and
// this file is what keeps them that way.
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

// Comment prose, wrap-invisible: the citations span three or four `//` lines,
// so a fragment only matches once the markers and the hard wrap are gone. Runs
// against comments deliberately — the inverse of `review-pr-reads.test.mjs`,
// which strips them because its pins are about code.
const PROSE = SOURCE.replace(/^[ \t]*\/\/ ?/gm, "").replace(/\s+/g, " ");

// Both bounds hard-asserted: a moved header must red loudly here rather than
// silently widening the slice to the rest of the file, where an incidental
// mention would satisfy every assertion below.
// #753: proven output-identical to `between()` on the real review-and-fix.md
// text — "\n## Judging findings" never occurs inside "## Specialists" itself,
// so searching from `at` instead of `at + "## Specialists".length` never
// changes the match.
const specialists = () => between(REVIEW_AND_FIX, "## Specialists", "\n## Judging findings", "review-and-fix Specialists section");

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

// #283. The `git show <sha>:<path>` instruction above is the review path's one
// place that tells a reader how to settle a citation, so it is also where the
// rule for building that argument out of a shell parameter belongs — and this
// is where it gets pinned. Not the repo's only such place: run-team's phase-0
// "Still live?" block instructs the same read. Its refs are literal and so
// unaffected, and #283 wants the rule stated once, so nothing was added there;
// whether that block needs a pointer to this one is #779. Anchoring the slice
// on the rule's own opening is deliberate: delete the rule and the anchor
// assertion reds before any content assertion runs. The fix and the reason
// quoting is NOT the fix are pinned as one contiguous span rather than as two
// fragments, because two fragments in one sentence still leave the join open
// to a spliced exception clause — and "quote it" is precisely the
// plausible-looking remedy that does not work here, so a mutation that keeps
// only that half must red.
function braceRule() {
  const section = specialists();
  const at = section.indexOf("Brace a ref held in a variable");
  assert.notEqual(
    at,
    -1,
    "review-and-fix.md's Specialists section no longer states the brace rule — its `git show <sha>:<path>` instruction then reads as safe for a ref held in a variable, which under zsh it is not, quoted or otherwise",
  );
  const end = section.indexOf("\n\n", at);
  assert.notEqual(end, -1, "the brace rule now runs to the end of the Specialists section — the slice is unbounded and unrelated prose could satisfy the assertions below");
  return section.slice(at, end).replace(/\s+/g, " ");
}

test("the Specialists section says to brace a variable ref, and that quoting is not the fix", () => {
  assert.ok(
    braceRule().includes(
      'Brace a ref held in a variable — `git show "${SHA}:<path>"` — because quoting is not what fixes it.',
    ),
    'the brace rule lost part of its span. All three halves are load-bearing together: the instruction to brace, the worked `git show "${SHA}:<path>"` form a reader copies, and the clause denying that quoting is the fix. Any one of them alone leaves a reader who quotes and does not brace believing the read is settled',
  );
});

// The colon is what makes this a hazard, so the colon is what the pattern
// requires: `git show "$SHA" -- <path>` is prescribed two sentences up in the
// same section and has to stay green. `cat-file` and a positional `$1` are in
// because they produce the identical silent shape — measured, `git cat-file -p
// "$SHA:t"` prints the tree object at exit 0 where the braced form exits 128.
// Deliberately over-strict in one spot: `git show "$SHA":<path>` is safe (the
// closing quote ends the parameter name) and reds anyway. Five further blind
// spots — other porcelain, a ref in its own code span, a wrapped line, `$a[1]`,
// and single-quoted forms, which fail loudly rather than silently — are
// measured and filed as #780 rather than guessed at here.
const UNBRACED_REF = /git (?:show|cat-file)[^`\n]*?\s["']?\$[A-Za-z_0-9]+["']?:/;

test("no unbraced variable ref survives in the Specialists section's own examples", () => {
  assert.doesNotMatch(
    specialists(),
    UNBRACED_REF,
    "an example in review-and-fix.md's Specialists section builds a `git show` or `git cat-file` object argument from an unbraced parameter — zsh takes the `:<path>` suffix as a history modifier, inside double quotes too, and the read can return the commit at exit 0 instead of the blob",
  );

  // The other half: what this regex must ACCEPT. Fed the braced form the rule
  // prescribes, it has to stay quiet — a pin that forbids its own remedy sends
  // the next editor back to the unbraced form to get the suite green. Both
  // quoting styles, because a plausible mis-edit that widens this to single
  // quotes without carrying the brace exclusion across passes the double-quoted
  // case on its own (measured).
  const braced = ['git show "${SHA}:<path>"', "git show '${SHA}:<path>'"];
  for (const form of braced) {
    assert.doesNotMatch(
      form,
      UNBRACED_REF,
      `the unbraced-ref pin also rejects the braced form it exists to promote: ${form}`,
    );
  }

  // And the colon-free form the same section prescribes for one named commit,
  // where there is no suffix for a history modifier to eat and so no hazard.
  assert.doesNotMatch(
    'git show "$SHA" -- <path>',
    UNBRACED_REF,
    'the unbraced-ref pin reds `git show "$SHA" -- <path>`, which carries no colon and no history-modifier hazard and is what the section prescribes for one named commit',
  );
});
