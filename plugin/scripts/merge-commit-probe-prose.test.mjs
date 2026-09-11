// #911. `run-team/SKILL.md`'s five-condition note sends the fix-applier to
// measure the merge-commit condition by hand, because `ci.yml`'s `rebase-check`
// exits on the staleness condition before the merge-commit one is evaluated, so
// the job log cannot name it. That hand-run probe is the whole of the evidence,
// and it shipped broken.
//
// `376c19c` wrote it as `git rev-list --merges --count "$BASE..HEAD"`. `$BASE`
// is assigned nowhere — `grep -rIn --exclude-dir=.git -E '(^|[^A-Z_])BASE=' .`
// prints nothing against this tree — so it expanded to `..HEAD`, which git
// reads as `HEAD..HEAD`: `git rev-list --merges --count "..HEAD"` prints `0` and
// exits 0. The broken probe returned the "no merge commits" answer, silently, at
// success, which is precisely the benign misreading the note exists to deny.
// `7b48720`, landed in the same PR #881 as the bug it fixes, corrected it to
// the angle-bracket placeholder form
// this file pins; that commit also edited
// `staleness-qualifier-prose.test.mjs`, but added no assertion on the command.
//
// WHY A PIN AND NOT A COMMENT: nothing pinned the corrected form. Measured:
// with this file's own test removed from the suite and the `$BASE` range
// reinstated in `SKILL.md`, the full suite
// (`node --test plugin/scripts/*.test.mjs`) still passes at 2202/2202 —
// nothing else in the suite catches the regression. The corrected form had
// no guard, so a dedup pass, a reword, or a "let's make this copy-pasteable"
// edit could restore the silent-zero probe with the suite green.
//
// ONE EXACT SPAN, NOT TWO REGEXES. Both halves of the command are load-bearing
// and they fail in OPPOSITE directions:
//   - the `origin/<base>..HEAD` placeholder shape. A `$VAR` range reads as a
//     variable the reader has already set, and when it is not set the probe is
//     the silent false negative above.
//   - the `git fetch origin &&` prefix. The document states the consequence of
//     dropping it: a stale local `origin/<base>` widens the range over the
//     base's own merge commits, turning the false negative into a false
//     positive.
// Pinned as a single contiguous span because the invariant lives in the JOIN.
// Separate `git fetch origin` and `origin/<base>..HEAD` matches over this slice
// would pin two facts and not their adjacency: a rewrite mentioning the fetch in
// the surrounding prose while leaving the command fetch-less satisfies both and
// says neither. The command's own correctness is #881's, settled there and not
// re-argued here; this asserts only that the corrected text is still the text.
//
// SLICE SIZE IS THE PIN, as in `staleness-qualifier-prose.test.mjs`. The note
// sits inside the fix-applier's blockquoted prompt, and this same document
// carries a near-miss at SKILL.md:149 — `git fetch origin && git rev-list
// --count main..origin/main`, same command family, no `--merges` — so a copy
// of this command left anywhere in the document would satisfy a file-wide
// match with the live one gutted. Measured: with the command replaced by the
// `$BASE` form in place AND a correct copy appended elsewhere in the
// document, in a genuinely separate paragraph with its `>` separator intact,
// this still reds. What it does NOT close is that separator deleted outright
// — the paragraphs then merge and the slice takes both, a hole that predates
// this bound and is open still (#1377).
//
// `stripQuoteGutter` before `paragraph`, which is what makes the shared
// paragraph bound reach into a blockquote at all: the `>`-only lines that fence
// this note become genuinely blank, so `paragraph`'s `\n[ \t]*\n` search finds
// them. It is also the reflow guard. `phrase()` joins on `\s+` and `\s+` does
// not span a `>`, so a rewrap that moved a word of the command onto the next
// blockquote line would red an untouched document without the strip.
//
// REFLOW CONTROL, measured on a scratch copy: the note rewrapped at 60, 72 and
// 100 columns (Python `textwrap.fill`, `break_on_hyphens=False`,
// `break_long_words=False`, `>` gutter re-applied) stays green — and at all
// three the command itself is split across blockquote lines, so this control
// exercises the gutter strip rather than passing on an unchanged line.
//
// THE CEILING is the hyphen-break one `staleness-qualifier-prose.test.mjs`
// records, and here it has exactly ONE carrier: `rev-list` is the only
// hyphenated token inside the pinned span, so it is the only one a wrapper can
// break where `\s+` cannot rejoin. Measured over widths 40-120 with
// `break_on_hyphens` on, this reds at 45, 46, 77, 78, 87 and 88 — precisely the
// widths that split `rev-list`, set-equal, not merely overlapping. The slice's
// other hyphenated tokens are NOT a mechanism: `gh pr update-branch` splits at
// 47, 48, 50 and 94 and this stays green there, because it sits in the note but
// outside the pinned span. `--merges` and `--count` never split — a leading
// double hyphen is not a break point. So the ceiling is a property of the
// wrapper and of one token, not a width to memorise; a Markdown wrapper does
// not break hyphenated words.
//
// THE CEILING on the assertion itself: it pins this command's text and nothing
// else in the note — not the five-condition claim, not the `solely` qualifier
// (`staleness-qualifier-prose.test.mjs` holds that, on a different paragraph of
// this document), not the server-side-rebase consequence. A deliberate reword of
// the command reds this; re-anchor PROBE here rather than deleting the
// assertion, and keep whichever form replaces it honest about both halves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, phrase, stripQuoteGutter } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const SKILL = "skills/run-team/SKILL.md";

// The note, and no more of the document than that. A moved anchor throws rather
// than widening the slice back to the file, which is the false green the bound
// exists to prevent.
const note = () =>
  paragraph(
    stripQuoteGutter(readFileSync(join(REPO, ...SKILL.split("/")), "utf8")),
    "The CI facts in that file apply to you",
    SKILL,
  );

// Backticks included: they are what keeps this a code span the reader can run,
// rather than a sentence describing one.
const PROBE = '`git fetch origin && git rev-list --merges --count "origin/<base>..HEAD"`';

test("the five-condition note measures merge commits with a fetched, origin-relative range", () => {
  assert.match(
    note(),
    phrase(PROBE),
    `${SKILL}'s five-condition note no longer spells the merge-commit probe ${PROBE}.

Both halves are load-bearing, and dropping either is silent:
  - a \`$VAR\` range (the \`"$BASE..HEAD"\` form \`376c19c\` shipped and \`7b48720\` fixed) expands to \`..HEAD\` when unset, which git reads as \`HEAD..HEAD\` — count \`0\`, exit 0, the "no merge commits" answer this note exists to deny.
  - without \`git fetch origin &&\`, a stale local \`origin/<base>\` widens the range over the base's own merge commits and reports one this branch never added.

If the command was reworded on purpose, re-anchor PROBE in this file to the new wording — and keep the angle-bracket placeholder and the fetch, or say in the commit which of the two failure modes you are accepting.`,
  );
});
