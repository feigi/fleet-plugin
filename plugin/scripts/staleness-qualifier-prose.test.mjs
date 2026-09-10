// #196. `review-and-fix.md` step 6 and `run-team/SKILL.md`'s finisher-dispatch
// condition are twins: each tells whoever applies `ready-to-merge` that a
// `skipped` heavy job does not block the label. The #182 dedup pass dropped
// `behind-count` from the reviewer-side copy alone, leaving "a `skipped` heavy
// job is staleness" — which names no cause, so the sentence no longer says
// WHICH staleness is the benign one. `skipped` off a non-zero behind-count is;
// a heavy job skipped for any other reason is an unverified suite, and this is
// the clause standing between that and a label.
//
// It happened a second time, the same way round and one document over: PR #881
// reworded the SKILL.md side to add the `solely` qualifier and the pointer to
// the five-condition note, and left review-and-fix.md step 6 — the label gate
// itself — saying neither. CLAUSE pinned only the shared substring, so the
// suite stayed green through exactly the drift it exists to catch. The anchor
// now carries the qualifier, which is what makes a one-sided reword red.
//
// That same commit — `283d985`, `Closes #182` — took a SECOND residue out of
// the same step-6 line: the mechanism behind "which a behind PR never reaches",
// leaving the consequence with nothing to rest on. #196 asked for both back, so
// both are pinned here. The mechanism is single-document by nature: SKILL.md's
// own copy of that gate states the consequence alone ("a behind PR never
// reaches full green, so an exit-0 gate strands it unlabelled"), so there is no
// twin to compare it against and the second test names one document.
//
// The drift was one-sided and silent — `board.mjs` and
// `references/ci-and-staleness.md` both still named the behind-count, and no
// assertion in this suite compared the two documents, so only a reader holding
// both open could see it. That is what this file is for.
//
// SLICE SIZE is what anchors these, as in `ci-state-prose.test.mjs`. Both
// documents talk about `skipped` jobs, behind-counts and staleness in
// neighbouring prose, and a dedup pass like #182 — the very thing that caused
// this ticket — is what leaves a second copy of a clause lying around. Matched
// over the whole file, these assertions are then satisfiable from OUTSIDE the
// rule they guard: measured, with the live clause gutted in both documents and
// one stray line carrying the old wording appended to each, an unbounded suite
// went green — the pass bought entirely by the out-of-clause occurrence. So
// each document is cut to the one paragraph that carries the rule, and a moved
// anchor reddens instead of silently widening the slice back to the file.
//
// THE CEILING: this pins two clauses and nothing else — not the rest of either
// sentence, not that the surrounding rule is right. Both documents word the
// qualifier clause identically today, so one phrase covers both; that is a fact
// about the current text, not a constraint, and a deliberate reword reddens
// this. Re-anchor the phrase here when that happens, rather than dropping the
// qualifier a second time.
//
// Reflow-safe by construction: `phrase()` joins the words on `\s+`, so
// SKILL.md (hard-wrapped ~80 cols) and review-and-fix.md (one long line per
// numbered step) take the identical regex, and a rewrap of either is a no-op.
// The slice anchors go through `phrase()` for that same reason — a literal
// `indexOf` anchor would break on a rewrap the clause itself survives, turning
// a reflow into a red. Measured: each of the qualifier's six inter-word gaps
// broken on its own, and all six broken at once, still match, and both
// containing paragraphs rewrapped across 60-400 cols stay green with Python
// `textwrap`'s `break_on_hyphens` off — which is how a Markdown wrapper wraps.
//
// THE REFLOW CEILING is hyphen-breaking, not any one width. With
// `break_on_hyphens` at its default `textwrap` splits a hyphenated word at the
// break — `behind-count` becomes `behind-` / `count` — and `\s+` does not span
// that, so ANY hyphenated token inside a pinned clause is vulnerable, not one
// named token: CLAUSE carries `behind-count`, MECHANISM carries `behind-count`
// and `rebase-check`.
//
// The slice bound does not protect against this — a split lands inside the
// slice as readily as outside it. Measured, review-and-fix.md rewrapped per
// source line (Python `textwrap.fill`, `break_on_hyphens=True`,
// `break_long_words=False`): at width 60 the only split inside step 6's own
// MECHANISM clause falls on its `behind-count` and that test reds; at width 87
// the only one there is its `rebase-check`, and it reds again. WHICH occurrence
// splits is what decides a red, and that is an offset, so it is not monotonic
// in width.
//
// A width quoted without its wrap discipline and its document is not
// reproducible: per-source-line and per-paragraph rewrapping red at disjoint
// widths, so a reader re-deriving the map builds a different one and reads this
// note as false — which has already happened here. This ticket existed to
// replace a width with a MECHANISM; state the property, and attach the
// discipline and the document to any width kept. Loosening the token to admit
// the split would let `behind- count` read as the qualifier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(REPO, ...p.split("/")), "utf8");

// The paragraph carrying the rule, and no more of the file than that. A missing
// anchor is a failure rather than a wider slice: silently falling back to the
// whole document is the false green this bound exists to prevent.
//
// The shared bound, not a local copy of it (#1372): a copy cannot see the two
// false greens this one closes — a blank line carrying whitespace, which a
// literal `\n\n` search runs straight past into the next paragraph, and an
// anchor occurring more than once, which binds the pin to whichever copy of the
// anchored block comes first.
const rule = (name, anchor) => paragraph(read(name), anchor, name);

const CLAUSE =
  "a `skipped` heavy job is behind-count staleness and fine — **solely** off that count, which is a condition to establish rather than infer";
const MECHANISM = "a `rebase-check` red or heavy jobs `skipped` off the behind-count hold it short of full green";

const REVIEW_AND_FIX = "commands/review-and-fix.md";
const STEP_6 = "6. Diff-check green";

const DOCS = [
  [REVIEW_AND_FIX, STEP_6],
  ["skills/run-team/SKILL.md", "**The fix-applier pushes and exits"],
];

for (const [name, anchor] of DOCS) {
  test(`${name} qualifies the benign \`skipped\` heavy job as behind-count staleness`, () => {
    assert.match(
      rule(name, anchor),
      phrase(CLAUSE),
      `${name} no longer says "${CLAUSE}". Bare "staleness" names no cause, and its twin document still names one — that one-sided drop is exactly #196. Restore the qualifier; if the clause was reworded on purpose, re-anchor CLAUSE in this file to the new wording in BOTH documents at once.`,
    );
  });
}

test(`${REVIEW_AND_FIX} step 6 keeps the mechanism behind "a behind PR never reaches" exit-0 green`, () => {
  assert.match(
    rule(REVIEW_AND_FIX, STEP_6),
    phrase(MECHANISM),
    `${REVIEW_AND_FIX} step 6 no longer says "${MECHANISM}". Stripped of it the line asserts only the consequence — that a behind PR never reaches exit-0 green — and leaves the reader to reconstruct WHY from separated sentences elsewhere. #182 dropped this clause alongside the behind-count qualifier and #196 restored both. Restore it, or re-anchor MECHANISM in this file to the new wording. Unlike CLAUSE this has no twin: SKILL.md's copy of the same gate carries the consequence only.`,
  );
});
