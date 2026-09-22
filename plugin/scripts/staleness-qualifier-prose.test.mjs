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
// Reflow-safe by construction, against WHITESPACE reflow: `phrase()` joins
// the words on `\s+`, so SKILL.md (hard-wrapped ~80 cols) and
// review-and-fix.md (one long line per numbered step) take the identical
// regex, and a rewrap of either is a no-op. The slice anchors go through
// `phrase()` for that same reason — a literal `indexOf` anchor would break on
// a rewrap the clause itself survives, turning a reflow into a red — but that
// protection stops exactly where the pinned clauses' does too: see THE REFLOW
// CEILING below and the paragraph after it, which together reach an anchor the
// same way they reach CLAUSE and MECHANISM. Measured: each of the qualifier's
// six inter-word gaps broken on its own, and all six broken at once, still
// match, and both
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
// The same split reaches the slice ANCHOR, not only the clause it bounds —
// `anchorAt` resolves an anchor through this same `phrase()`, so a hyphenated
// anchor carries the identical vulnerability one level up. Both anchors this
// file uses carry one: STEP_6 is `6. Diff-check green`, and the SKILL.md
// anchor is `**The fix-applier pushes and exits`. The symptom differs from
// CLAUSE and MECHANISM's, though: a split anchor does not fail the comparison
// it bounds, it fails to resolve at all — provided the anchor is unique; a
// second, unsplit copy elsewhere in the document would mask a split occurrence
// and bind the slice to that copy instead, which neither anchor here has — so
// `anchorAt` throws its own `slice anchor "…" moved` refusal before
// `paragraph()` ever returns a slice to compare against anything. The suite
// still reds — this is not a silent false green — but the message
// misattributes the cause: a reader who hits `slice anchor "…" moved` goes
// looking for an edit that moved the anchor, and there is none to find — the
// anchor text is unchanged; a rewrap split it across the line break instead.
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
//
// THE FOURTH PIN (#1218) — step 4's OWN instance of the same qualifier. Step 4
// says "a `rebase-check` red or heavy jobs `skipped` **solely from a non-zero
// behind-count** never clears by waiting", and until #1218 nothing pinned it:
// measured, `solely` → `mostly` at step 4 with step 6 and SKILL.md untouched
// left this suite at tests 3 / pass 3 / fail 0. Same load-bearing word, third
// site — a `rebase-check` red has several causes and only the behind-count one
// is benign, so weakening it there turns "this staleness is not a failure" into
// "staleness is not a failure" and licenses waiting-out, or labelling past, a
// genuine red.
//
// It is NOT sliced by `rule()`, and that is not a style choice. `paragraph()`
// ends at the next blank line, and this document writes one long line per
// numbered step with NO blank line between them — so the first blank line after
// step 4 sits below step SIX. Measured: a blank-line slice anchored at step 4
// returns 10043 bytes carrying steps 4, 5 and 6, against step 6's own 2138.
// Step 6 only works with this bound because it is the LAST item before the
// blank line. The over-slice is not theoretical here: `a `rebase-check` red or
// heavy jobs `skipped`` occurs TWICE in this document — once opening step 4's
// clause, once as step 6's MECHANISM — so a step-4 pin bounded by the blank
// line is answerable by step 6's copy, exactly the "second copy of a clause
// lying around" the SLICE SIZE note above names as this suite's own history.
// `finisher-dispatch-premise-prose.test.mjs` reached the same conclusion for a
// different span of this same step 4; this imports the `betweenPhrases` bound
// it uses (`\n\d+\.\s`, the next ordered-list marker at column 0) rather than
// hand-rolling a second copy — a local copy is the defect, not a style choice.
//
// Both bounds sit OUTSIDE the pinned clause by construction, as that sibling's
// do: a mutant that rewrote a bound makes the slice THROW rather than the pin
// redden, which is the harness losing its footing, not a pin discriminating.
// Both are single-hit in this document:
//   grep -cF "**Staleness is not a failure:**"       → 1
//   grep -cF "below for what it looks like and why"  → 1
//
// Both are also DIGIT-FREE, and that is load-bearing rather than incidental —
// it is the one thing measured here that the sibling's note does not already
// cover. This bound reads `\n\d+\.\s` as "the next ordered-list item", which is
// true of the document as authored and FALSE of a reflowed copy: a wrap point
// landing before any `<digit>.` puts that digit at column 0, where the bound
// cannot tell a wrapped continuation from a new list item and cuts the scope
// there. Step 4's prose is full of them — it says "repeat from 3", "go to 6",
// "straight to 6". Measured, the first anchors tried here were `fix a
// **genuine** failure and repeat from 3` and `Stop watching and go to 6`: a
// plain WHITESPACE-only rewrap at 80 cols (`break_on_hyphens=False`, the wrap
// this file's header promises is a no-op) pushed `3.` to column 0, the bound
// cut immediately after the start anchor, and the pin reddened with `slice end
// anchor "…" moved` — a false red, wearing the exact misattributing message
// THE REFLOW CEILING above warns a reader about. The anchors below span the
// stretch of step 4 that contains no digit at all, so no wrap point inside this
// slice can manufacture a list marker. Verified green under whitespace-only
// rewraps at 60/72/80/100/140/200/400 cols.
//
// THE REFLOW CEILING above reaches this pin too, through its CLAUSE half only:
// QUALIFIER carries three hyphenated tokens (`rebase-check`, `non-zero`,
// `behind-count`), any one of which a hyphen-breaking wrapper splits out of the
// match. Its two ANCHORS carry none — unlike STEP_6's `6. Diff-check green` and
// SKILL.md's `**The fix-applier pushes and exits`, both of which do — so the
// anchor half of that ceiling is closed here by the choice of anchor rather
// than by luck, and a hyphen-breaking rewrap reds this pin through the clause
// (a plain comparison failure) instead of through `slice anchor "…" moved`,
// which is the message that misattributes the cause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { betweenPhrases, paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(REPO, ...p.split("/")), "utf8");

// The paragraph carrying the rule, and no more of the file than that. A missing
// anchor is a failure rather than a wider slice: silently falling back to the
// whole document is the false green this bound exists to prevent.
//
// The shared bound, not a local copy of it (#1372). What it closes that a local
// copy could not: a blank line carrying whitespace, which a literal `\n\n`
// search runs straight past into the next paragraph, and an anchor occurring
// more than once, which binds the pin to whichever copy of the anchored block
// comes first. What it does NOT close is a blank line deleted outright — the
// paragraphs then merge and the slice takes both, a hole that predates this
// bound and is open still (#1377).
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

// Step 4's own staleness sentence, bounded inside step 4's list item — see THE
// FOURTH PIN in the header for why this is not `rule()`.
const STEP_4_FROM = "**Staleness is not a failure:**";
const STEP_4_TO = "below for what it looks like and why";
const STEP_4_WHAT = `${REVIEW_AND_FIX} step 4 staleness qualifier`;

const step4Staleness = (text = read(REVIEW_AND_FIX)) =>
  betweenPhrases(text, STEP_4_FROM, STEP_4_TO, STEP_4_WHAT, { bound: /\n\d+\.\s/ });

// The qualifier as ONE span, cause through consequence. Never the bare word:
// `solely` occurs twice in this document, so a keyword pin would be answered by
// step 6's own `**solely** off that count` — the same out-of-clause pass the
// slice bound exists to deny, reached through the regex instead.
const QUALIFIER =
  "a `rebase-check` red or heavy jobs `skipped` **solely from a non-zero behind-count** never clears by waiting";

test(`${REVIEW_AND_FIX} step 4 qualifies the never-clearing staleness as solely a non-zero behind-count`, () => {
  assert.match(
    step4Staleness(),
    phrase(QUALIFIER),
    `${STEP_4_WHAT}: step 4 no longer says "${QUALIFIER}". This is the sentence telling a standalone reviewer WHICH red to stop watching rather than fix: only the behind-count cause is benign, so dropping or weakening \`solely\` turns "this staleness is not a failure" into "staleness is not a failure" and licenses stopping the watch on a genuine red. That is #182/#196's drift at a third site (#1218), and step 6 and SKILL.md carrying their copies is exactly what makes a one-sided drop here silent. Restore the qualifier, or re-anchor QUALIFIER in this file to the new wording.`,
  );
});
