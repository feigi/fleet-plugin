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
// requires: `git show "$SHA" -- <path>`, the colon-free form this section
// prescribes for one named commit, has to stay green. Measured under zsh 5.9,
// `"$SHA:t"` expands to the bare sha — `:t` is taken as a history modifier
// inside double quotes as well as outside — where `"${SHA}:t"` stays literal.
// A positional (`"$1:t"`) mangles identically, and a subscript is no
// protection (`"$refs[1]:t"` expands to the element with the suffix eaten), so
// the pattern lets the parameter name carry one.
//
// #780 widened the verb set to every porcelain measured to take `<rev>:<path>`
// AND still exit 0 once the suffix is eaten — exit 0 is what makes the misread
// silent, and the silent shape is the whole reason this pin exists. Measured
// in a throwaway repo where path `t` does not exist, unbraced rc then braced
// rc: `show` 0 printing the commit / 128; `cat-file -p` 0 printing the commit
// object / 128; `ls-tree` 0 listing the root tree / 128; `rev-parse` 0 echoing
// the sha / 128; `grep` 0 searching the whole tree / 128; `checkout` 0
// detaching HEAD / 1; `diff` 0 printing an empty diff / 128; `restore
// --source` 0 restoring from the commit / 128; `archive` 0 archiving the whole
// tree / 128. A measured list and not `git [a-z-]+`, decided on measurement
// rather than taste: the wildcard reds four real lines in this repo's own
// scripts, plus `git commit -m "$TITLE: ..."` and `git remote add origin
// "$HOST:$REPO.git"`, where the colon is nobody's rev separator. Extending the
// set means measuring the new verb the same way, not appending on resemblance.
//
// Single-quoted forms are pinned on doc quality, not on that silent hazard,
// and the failure message says so rather than claiming a silent read:
// measured, `git show '$SHA:<path>'` and `git show '${SHA}:<path>'` both exit
// 128 `fatal: invalid object name`, single quotes suppressing expansion
// outright. So the unbraced one reds and the braced one stays green on the
// brace rule this section teaches, never on an exit code.
//
// Over-strict in one spot, ruled on in #775 and deliberately untouched here:
// `git show "$SHA":<path>` is safe — the closing quote ends the parameter
// name, so the colon is literal — and reds anyway. Nothing in the tree
// recommends that form and bracing fixes it, so the false positive was
// accepted rather than shipping an unmeasured variant.
//
// Out of this mechanism's reach and NOT fixed by #780: a verb and its ref in
// separate markdown code spans, and a backslash-wrapped example. `[^`\n]`
// crosses neither a backtick nor a newline, and that character class is what
// keeps this pin cheap, so either one needs a different matcher rather than a
// wider class. Both stay measured on #780's record.
const UNBRACED_REF =
  /git (?:show|cat-file|ls-tree|rev-parse|grep|checkout|diff|restore|archive)[^`\n]*?\s["']?\$[A-Za-z_0-9]+(?:\[[^\]\n]+\])?["']?:/;

test("no unbraced variable ref survives in the Specialists section's own examples", () => {
  assert.doesNotMatch(
    specialists(),
    UNBRACED_REF,
    "an example in review-and-fix.md's Specialists section builds a git `<rev>:<path>` argument from an unbraced parameter — bare or double-quoted, zsh eats the `:<path>` suffix as a history modifier and the read can return the commit at exit 0 instead of the blob; single-quoted, the parameter never expands and git exits 128 on `invalid object name`. Only the first is silent, and both are wrong in the one section that tells a reader how to settle a citation",
  );

  // What the pattern must CATCH — one case per verb the alternation names, plus
  // each parameter form. Narrow the verb set or drop the subscript branch and
  // these red, which is what keeps the widening load-bearing instead of
  // decorative: #775 shipped a pattern whose under-match went green in
  // silence, and a pin never mutated in this direction is how that happens.
  const hazardous = [
    'git show "$SHA:<path>"',
    'git cat-file -p "$SHA:<path>"',
    'git ls-tree "$SHA:<path>"',
    'git rev-parse "$SHA:<path>"',
    'git grep needle "$SHA:<path>"',
    'git checkout "$SHA:<path>"',
    'git diff "$SHA:<path>"',
    'git restore --source "$SHA:<path>" -- <path>',
    'git archive --format=tar "$SHA:<path>"',
    'git show "$1:<path>"',
    'git show "$refs[1]:<path>"',
    'git show "$refs[$i]:<path>"',
    "git show '$SHA:<path>'",
  ];
  for (const form of hazardous) {
    assert.match(
      form,
      UNBRACED_REF,
      `the unbraced-ref pin stopped catching a form measured to misread or fail: ${form}`,
    );
  }

  // The other half, and the one that makes the ban worth anything: what this
  // regex must ACCEPT. Fed the braced form the rule prescribes, it has to stay
  // quiet — a pin that forbids its own remedy sends the next editor back to the
  // unbraced form to get the suite green. One case per quoting style and per
  // brace form, because a mis-edit that widens a quote class without carrying
  // the brace exclusion across still passes the double-quoted case on its own
  // (measured); the verb never interacts with bracing, so it is not re-listed.
  const braced = [
    'git show "${SHA}:<path>"',
    "git show '${SHA}:<path>'",
    "git show ${SHA}:<path>",
    'git show "${refs[1]}:<path>"',
  ];
  for (const form of braced) {
    assert.doesNotMatch(
      form,
      UNBRACED_REF,
      `the unbraced-ref pin also rejects the braced form it exists to promote: ${form}`,
    );
  }

  // Colon-free commands, where there is no suffix for a history modifier to
  // eat and so no hazard. `git show "$SHA" -- <path>` and `git diff
  // <base>...<head> -- <path>` are what the section itself prescribes; the
  // `grep` case covers a newly added verb, since widening the verb set is
  // exactly the edit that could start redding a recommended colon-free form.
  const colonFree = [
    'git show "$SHA" -- <path>',
    "git diff <base>...<head> -- <path>",
    'git grep -n "$PATTERN" -- <path>',
  ];
  for (const form of colonFree) {
    assert.doesNotMatch(
      form,
      UNBRACED_REF,
      `the unbraced-ref pin reds ${form}, which carries no colon and no history-modifier hazard`,
    );
  }

  // And colons that are no rev separator at all. The verb set is a measured
  // list rather than any git subcommand precisely so a review doc can still
  // show these; collapsing it to `git [a-z-]+` reds every one (measured).
  const nonRev = [
    'git commit -m "$TITLE: fix the thing"',
    'git remote add origin "$HOST:$REPO.git"',
    'git push "$REMOTE" "$LOCAL:$REMOTE_BRANCH"',
  ];
  for (const form of nonRev) {
    assert.doesNotMatch(
      form,
      UNBRACED_REF,
      `the unbraced-ref pin reds ${form}, where the colon is not a rev separator`,
    );
  }
});
