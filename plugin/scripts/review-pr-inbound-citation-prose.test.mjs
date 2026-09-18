// #1130. Two documents cited `workflows/review-pr.js` BY LINE and both numbers
// rotted, in two different ways, without either document being touched:
//
// - `docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md`
//   pointed at `:364-370` for an UNVERIFIED note about `opts.model` vs
//   `agentType` frontmatter. The range was already off by one when it was
//   written (the note sat at 363-369), PR #1126's `readRules` hunk pushed it ten
//   lines further, and the 2026-09-09 omp port (#1349) then deleted the note
//   outright along with `specialistModel`. Three states, and re-reading the
//   number distinguishes none of them.
// - `.out-of-scope/prose-rule-as-derivation.md` pointed at `:404` for the
//   retired "faces refuters" rationale surviving only as a negation. That line
//   moved too — and the QUOTATION moved with it: #218 put `comments` on the
//   size-tier floor, so "NOT because those four alone face refuters" became
//   "NOT because those face refuters" and the recorded quote stopped matching
//   the source at all.
//
// The second failure is the one a line-number fix does not reach, and it is why
// this file pins the quotation rather than the position. A citation that
// resolves to the WRONG paragraph reads as verified; one whose quoted anchor has
// been reworded reads as verified too, right up until someone greps it and finds
// nothing. Both halves are asserted here, in the manner #317 established for the
// outbound direction.
//
// NOT part of `review-pr-citation-prose.test.mjs`, deliberately: that file pins
// the OUTBOUND direction — review-pr.js citing `commands/review-and-fix.md` —
// and reads exactly those two files. These citations run the other way, from two
// root-level documents INTO review-pr.js and its tests, so neither the corpus
// nor the ban belongs in that file. The convention is the same and is why this
// one exists in its shape; the scope is disjoint.
//
// TWO BOUNDS, each doing work:
//
// - The BAN, on the citing side: no `<file>:<digits>` citation of review-pr.js
//   or select-dimensions.test.mjs may come back. This is the original defect
//   class, and it is the half that survives a rewrite of everything below.
// - The ANCHOR, both sides: each document must still quote its fragment
//   verbatim, AND that fragment must still live inside the BLOCK the document
//   names — not merely somewhere in the target file. Checking only the target
//   stays green with the citation deleted; checking only the document stays
//   green after the source is reworded. The pair is what caught #1130's two
//   failures, one each.
//
// Slices are bounded by CODE at both ends, never by a blank line: a comment
// block ends at its first non-`//` line, well before the next blank one, and a
// blank-line bound runs on into live code where a decoy satisfies the pin
// (measured in #695, in `quiet-payload-prose.test.mjs`'s own source site). The
// declaration is the anchor for the same reason — it moves only when the code
// does, where a phrase anchor inside the pinned prose reads every edit to that
// prose as a moved anchor.
//
// THE CEILING: this pins that each citation still resolves. It does not pin that
// the surrounding claim is TRUE — that the item is still open, that the rule is
// still retired — and it cannot: those are judgements about the source, and the
// spec bullet above was wrong about one of them for months while its line number
// was merely stale. It also covers only the documents named below; another
// document citing review-pr.js by line is not caught here, and neither is any
// `<file>:NNN` citation the 2026-08-06 spec keeps into a file OTHER than
// review-pr.js, nor the bare `:NNN` self-references in its own Edits
// changelist — #1188 scoped itself to `review-pr.js:NNN` and left that sibling
// class to a follow-up. Named as a class and not by its members on purpose: an
// enumeration here reads as the whole of what is uncovered, and the document
// gaining one sibling citation is enough to make it a lie.
//
// This file names every source by path and globs nothing, so its own text is not
// in the corpus and cannot satisfy the pins it carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorAt, between, paragraph } from "./prose-pin.mjs";

const PLUGIN = join(import.meta.dirname, "..");
const ROOT = join(PLUGIN, "..");
const readPlugin = (p) => readFileSync(join(PLUGIN, ...p.split("/")), "utf8");
const readRoot = (p) => readFileSync(join(ROOT, ...p.split("/")), "utf8");

const OOS = ".out-of-scope/prose-rule-as-derivation.md";
const SPEC = "docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md";
const SPEC_0806 = "docs/specs/2026-08-06-review-pr-cost-and-apply-policy-design.md";
const SOURCE = "workflows/review-pr.js";
const SELECT = "scripts/select-dimensions.test.mjs";

// A `//` block wraps at the gutter, so `\s+` alone does not join a fragment
// broken across two comment lines — strip the markers first, exactly as
// review-pr-citation-prose.test.mjs does over this same file. Markdown needs
// only the wrap removed.
const code = (s) => s.replace(/^[ \t]*\/\/ ?/gm, "").replace(/\s+/g, " ");
const prose = (s) => s.replace(/\s+/g, " ");

// The run of `//` lines directly above a declaration, and the run directly
// below one. Empty is a failure, never an empty slice: a slice that found no
// comment compares a fragment against "" and reports the fragment missing,
// which names the wrong fault — the anchor is what moved.
function commentAbove(text, anchor, what) {
  const run = (text.slice(0, anchorAt(text, anchor, what)).match(/(?:[ \t]*\/\/[^\n]*\n)+$/) ?? [""])[0];
  assert.notEqual(run, "", `${what}: nothing but code sits above \`${anchor}\` — the comment block this citation names is gone, not merely reworded`);
  return code(run);
}
function commentBelow(text, anchor, what) {
  const rest = text.slice(anchorAt(text, anchor, what));
  const run = (rest.slice(rest.indexOf("\n") + 1).match(/^(?:[ \t]*\/\/[^\n]*\n)+/) ?? [""])[0];
  assert.notEqual(run, "", `${what}: nothing but code sits below \`${anchor}\` — the comment block this citation names is gone, not merely reworded`);
  return code(run);
}

// Named so the controls at the bottom of this file can feed it the two inputs
// that decide its scope: a `review-pr.js:NNN` citation must fire it, and the
// sibling `<other-file>:NNN` citations the 2026-08-06 spec still carries must
// not.
const REVIEW_PR_LINE_REF = /review-pr\.js:\d+/;

test("the citing documents cite review-pr.js by content, never by line", () => {
  for (const doc of [OOS, SPEC, SPEC_0806])
    assert.doesNotMatch(
      readRoot(doc),
      REVIEW_PR_LINE_REF,
      `${doc}: a line-numbered citation of review-pr.js is back. #1130 measured three of them rotting in that file without either document being edited — one of them twice over, and once past the deletion of what it pointed at; #1188 measured nine more in the 2026-08-06 spec, eight of them landing on unrelated code. Name the declaration and quote the block instead.`,
    );
  assert.doesNotMatch(
    readRoot(OOS),
    /select-dimensions\.test\.mjs:\d+/,
    `${OOS}: a line-numbered citation of select-dimensions.test.mjs is back — the same defect class as the review-pr.js one beside it, and the same remedy.`,
  );
});

// Each row: the document, the slice of it that must carry the quotation, and the
// block in the target that must still contain the quoted fragment.
const SITES = [
  {
    label: "the retired rationale's negation in review-pr.js",
    doc: OOS,
    docSlice: () => prose(paragraph(readRoot(OOS), "**The drift class cited as motivation is closed.**", OOS)),
    quote: `"NOT because those face refuters"`,
    target: SOURCE,
    names: "the comment above `SIZE_TIER_DIMS`",
    block: () =>
      commentAbove(
        readPlugin(SOURCE),
        `const SIZE_TIER_DIMS = new Set(`,
        SOURCE,
      ),
    fragment: "NOT because those face refuters",
  },
  {
    label: "the retired rationale's negation in select-dimensions.test.mjs",
    doc: OOS,
    docSlice: () => prose(paragraph(readRoot(OOS), "**The drift class cited as motivation is closed.**", OOS)),
    quote: `"was never able to separate these six"`,
    target: SELECT,
    names: `the comment above the "refuter budget is keyed on severity alone" test`,
    block: () =>
      commentAbove(
        readPlugin(SELECT),
        `test("the refuter budget is keyed on severity alone, never on a dimension", () => {`,
        SELECT,
      ),
    fragment: "was never able to separate these six",
  },
  {
    // The one row whose quotation and anchor differ: the document renders the
    // spec's own double quotes as single ones inside its parenthetical, so the
    // quoted bytes are not verbatim. The paragraph OPENER is what it names, and
    // that is what is pinned on the citing side.
    label: "the 2026-08-06 spec's own correction",
    doc: OOS,
    docSlice: () => prose(paragraph(readRoot(OOS), "**The drift class cited as motivation is closed.**", OOS)),
    quote: `"Corrected after implementation (#221)"`,
    target: SPEC_0806,
    names: `the paragraph opening "Corrected after implementation (#221)"`,
    block: () => prose(paragraph(readRoot(SPEC_0806), "Corrected after implementation (#221)", SPEC_0806)),
    fragment: "cannot be what puts one on",
  },
  {
    label: "the #1349 ruling that closed the opts.model unknown",
    doc: SPEC,
    docSlice: () =>
      prose(
        between(
          readRoot(SPEC),
          "- **Whether `opts.model` beats `agentType` frontmatter in workflow `agent()`.**",
          "\n- **Sizing verdict availability.**",
          SPEC,
        ),
      ),
    quote: `"the three per-call tier knobs this block used to expose — are GONE, not renamed"`,
    target: SOURCE,
    names: "the comment under the `verifiers` declaration",
    block: () => commentBelow(readPlugin(SOURCE), "const verifiers = A.verifiers", SOURCE),
    fragment: "the three per-call tier knobs this block used to expose — are GONE, not renamed",
  },
];

for (const { label, doc, docSlice, quote, target, names, block, fragment } of SITES) {
  test(`${doc} — ${label} is quoted, and still resolves in ${target}`, () => {
    assert.ok(
      docSlice().includes(quote),
      `${doc} no longer quotes ${quote} — the citation lost the fragment half of its anchor, leaving only the name of a block, which nothing can check. It names ${names} in ${target}; quote that block's own words back, or re-anchor both sides together.`,
    );
    assert.ok(
      docSlice().includes(fragment),
      `${doc} no longer quotes ${fragment} — the anchored words inside ${quote} have drifted, even though the surrounding quote marks are still present. It names ${names} in ${target}; quote that block's own words back, or re-anchor both sides together.`,
    );
    assert.ok(
      block().includes(fragment),
      `${target}: ${names} no longer contains ${fragment}, which ${doc} quotes as the anchor for ${label} — so that citation now resolves to nothing. This is the failure #1130 measured on the "those four alone" wording: the source was reworded and the recorded quote silently stopped matching. Update the document's quotation in the same commit as the source.`,
    );
  });
}

// #1188. The same defect class, a third citing document, and the half PR #1183
// left behind. Besides the two citations #654 ruled on, the 2026-08-06 spec
// carried NINE bare `review-pr.js:NNN` refs. Read against the current tree —
// which is how that document's citations actually get read, whatever its front
// matter says about resolving them at `8a84402` — eight landed on unrelated
// code (`DEFAULT_DIMENSIONS` `agentType` entries, `evidence`'s description,
// `readRules` comments) while `:31` was still accurate, so nothing could be
// batch-shifted either. All nine are quoted-fragment anchors now, and the ban
// above covers that document too.
//
// The set below is NOT only those nine. Two review-pr.js citations in the same
// document never carried a line number, so #1188's `:NNN` sweep never reached
// them: the "is a FAILED run, not a pass" rule, and the comment above the
// `DEFAULT_DIMENSIONS` declaration. Being content-anchored already is not being
// checked — a phrase reworded out of the source is #1130's second failure, and
// it reads as verified right up until someone greps it — so both are pinned
// here too, or exactly the rot this file exists to stop stays reachable,
// silently, in the document it was extended to cover. A row below holds the
// source half of each — the fragment, occurring exactly once in review-pr.js —
// and the citing half is held apart from it, because what the document spells
// is not the fragment: one of them names a comment and quotes nothing out of
// it, and the other's fragment is a rule the document also restates in its own
// voice.
//
// The ban alone stays green on an anchor that resolves to NOTHING, and that is
// a measured failure rather than a hypothetical: 4323514 fixed a parenthetical
// in this same spec that quoted its rule in markdown backticks while the source
// quoted it with single quotes, so the document's own phrase matched nothing in
// the file it pointed at. Two properties are what make a fragment a locator,
// and both are asserted per anchor:
//
// - EXACTLY ONCE in review-pr.js. Present-somewhere is not enough: a fragment
//   matching twice sends the reader to a coin flip, and one matching zero times
//   is 4323514 again.
// - UNBROKEN on one line of the markdown. These citations get resolved by
//   copying the fragment out of the raw file and grepping it, so a fragment
//   split across a hard wrap greps to 0 and the document's own wrapping is part
//   of whether the citation resolves.
//
// Deliberately NOT the SITES shape above: those rows bound the target slice by
// declaration because their fragments are ordinary prose that could recur
// anywhere in the file. Uniqueness does that work here instead, and uniqueness
// is the property the spec's convention names in the first place.
const SPEC_0806_ANCHORS = [
  "function selectDimensions(all, stats)",
  `required: ["dimension", "scope_searched", "findings", "test_run"]`,
  "dimension: d.key, ...verdictFor(0, [])",
  "dimension: d.key, ...verdictFor(n, votes)",
  `archive HEAD | tar -x -C "$SNAP"`,
  "A simplification that changes observable behavior is a defect",
  "are GONE, not renamed",
  "const verifiers = A.verifiers",
  "never fall back to a guess",
  "function resolveTestCmd(explicit, snap)",
  "is a FAILED run, not a pass",
  "Unknown, unparseable, or empty diff → the full set",
  "function resolveDimensions(override, all)",
  "const explicitDimensions = resolveDimensions(A.dimensions, DEFAULT_DIMENSIONS)",
];

test("the 2026-08-06 spec's review-pr.js anchors resolve, uniquely and unwrapped", () => {
  const doc = readRoot(SPEC_0806);
  const lines = doc.split("\n");
  const src = readPlugin(SOURCE);
  for (const fragment of SPEC_0806_ANCHORS) {
    assert.ok(
      prose(doc).includes(fragment),
      `${SPEC_0806} no longer quotes ${JSON.stringify(fragment)}, one of the anchors its review-pr.js citations resolve through. A citation reworded out of its fragment has no resolvable half left, so re-anchor both sides together — or drop this row if the citation itself is gone.`,
    );
    assert.ok(
      lines.some((l) => l.includes(fragment)),
      `${SPEC_0806}: the anchor ${JSON.stringify(fragment)} is no longer contiguous on one line of the markdown. These citations are resolved by copying the fragment out of the raw file and grepping it, and \`grep -F\` over a fragment split across a hard wrap returns 0 — rewrap the line so the quoted bytes stay together.`,
    );
    const hits = src.split(fragment).length - 1;
    assert.equal(
      hits,
      1,
      `${SOURCE}: ${JSON.stringify(fragment)} occurs ${hits} times, not once. ${SPEC_0806} quotes it as the anchor for one of its review-pr.js citations, so that citation now resolves to ${hits === 0 ? "nothing — the source was reworded and the recorded quote stopped matching, #1130's own failure" : "more than one place, which is a coin flip and not a locator"}. Update the document's quotation in the same commit as the source.`,
    );
  }
});

// The citing half of those two. A row above is satisfied by its fragment
// WHEREVER the document carries it, and this document carries the FAILED-run
// rule twice — once as the citation into review-pr.js, once restated in its own
// voice on the next line. Measured: with only the row, rewording the CITATION
// left this file green on the restatement, which is the original defect back
// with a pin sitting over it. So the row holds the source half and this holds
// the citing half — the form the document spells the citation in, which must
// occur exactly once: zero means it was reworded away, and more than one means
// a pin here binds whichever copy comes first while the other rots.
//
// `DEFAULT_DIMENSIONS`'s citation gets no row at all, because it names a
// comment without quoting a phrase out of it and the fragment half does not
// exist. What it resolves through is the declaration and the comment above it,
// and `commentAbove` asserts both: `anchorAt` refuses a declaration occurring
// other than exactly once, and an empty `//` run fails rather than returning a
// slice every fragment "matches". Whether that comment still carries the rule
// the spec says it carries is THE CEILING above, not this.
const SPEC_0806_CITATIONS = [
  `the "is a FAILED run, not a pass" rule`,
  "`review-pr.js`'s comment above `DEFAULT_DIMENSIONS`",
];

test("the 2026-08-06 spec still spells the citations its pre-#1188 anchors hang on", () => {
  const doc = prose(readRoot(SPEC_0806));
  for (const citation of SPEC_0806_CITATIONS) {
    const hits = doc.split(citation).length - 1;
    assert.equal(
      hits,
      1,
      `${SPEC_0806}: the citation ${JSON.stringify(citation)} occurs ${hits} times, not once. ${hits === 0 ? "It was reworded out of the form its anchor hangs on, and the anchor above can stay green on a copy of that fragment the document carries elsewhere — so re-anchor both sides together, or drop this row along with the citation if it is gone" : "A pin here would bind whichever copy comes first and leave the other free to rot, which is the coin flip the per-anchor uniqueness rule exists to refuse"}.`,
    );
  }
  // Asserts both halves and throws on either. The returned comment text is not
  // compared against anything, because the document quotes none of it.
  commentAbove(readPlugin(SOURCE), "const DEFAULT_DIMENSIONS = [", SOURCE);
});

// The mode the ban is meant to see, fed to it verbatim. Row 1 is the exact
// sentence #1188 deleted from the spec: a pattern typo that matched nothing
// would leave the ban green forever on documents that simply never regress, so
// it has to be shown firing on the real defect at least once. Row 2 is the
// CEILING as an input — the sibling citations that document still carries have
// to stay ACCEPTABLE, because #1188 left them to a follow-up ticket, so a
// widened pattern that reds them is a scope decision and not a bug fix.
test("the ban fires on the citation #1188 removed, and spares the siblings it left", () => {
  assert.match(
    "requires `dimension` (`review-pr.js:31`) and every returned finding carries it",
    REVIEW_PR_LINE_REF,
    "the ban above no longer recognises the citation form #1188 removed, so it can never fire on a regression either.",
  );
  assert.doesNotMatch(
    "workflow arg (`run-team/SKILL.md:287`), no longer defaulted but DERIVED from the",
    REVIEW_PR_LINE_REF,
    "the ban above now claims the sibling `<other-file>:NNN` citations the 2026-08-06 spec still carries. They are the same defect class and deliberately out of #1188's scope; widening the ban means converting them in the same change, not reddening a document nobody has fixed yet.",
  );
});
