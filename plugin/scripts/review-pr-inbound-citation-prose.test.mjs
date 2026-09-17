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
// was merely stale. It also covers these two documents and no others; a third
// document citing review-pr.js by line is not caught here.
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

test("the two documents cite review-pr.js by content, never by line", () => {
  for (const doc of [OOS, SPEC])
    assert.doesNotMatch(
      readRoot(doc),
      /review-pr\.js:\d+/,
      `${doc}: a line-numbered citation of review-pr.js is back. #1130 measured three of them rotting in that file without either document being edited — one of them twice over, and once past the deletion of what it pointed at. Name the declaration and quote the block instead.`,
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
