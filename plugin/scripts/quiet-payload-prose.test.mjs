// #677. `run-team/SKILL.md` stated what `--quiet` drops twice, and only one of
// the two was complete: the CI-Monitor paragraph named `jobs` and `missing`,
// the finisher-duty paragraph named `jobs` alone. The incomplete copy is the
// one that costs — it is the paragraph an agent reads when deciding whether it
// holds the per-job state a `ready-to-merge` label rests on, and `missing` is
// exactly the field separating "the expected job is absent" from "the expected
// job failed". `review-and-fix.md`'s twin of that same gate was complete
// throughout, so the outlier was visible only to a reader holding all three
// paragraphs open at once. That is what this file is for.
//
// #701. That sentence used to state the gap between those two paragraphs as a
// line count. Nothing pinned it, and it drifted on SKILL.md edits between the
// two anchors that touched neither this file nor ci-state.mjs: written 345, it
// measured 353 when #701 was filed and 375 when #701 was fixed. A fresh number
// would rot the same way, so the paragraphs are named rather than located. Do
// not restore one.
//
// THE FIELD LIST IS READ OUT OF ci-state.mjs, never restated here. `--quiet`'s
// effect on the payload is one assignment, and a field added to or renamed in
// it silently un-completes all four sites at once. Deriving the list means that
// edit reddens here instead, which is the only way the four stay agreed with the
// source rather than merely with each other.
//
// TWO BOUNDS, each measured against the mutation it exists to catch, in the
// manner of `staleness-qualifier-prose.test.mjs`:
//
// - The PARAGRAPH bound. SKILL.md carries two of the four statements, so
//   matched over the whole file each is the other's false green: measured, with
//   the finisher-duty clause gutted a file-wide variant went green off the
//   CI-Monitor copy alone, and stayed green with a decoy line appended too.
// - The CLAUSE bound: the `--quiet` sentence, from its `drops` to that
//   sentence's end. Two mutations shape it, one at each edge. Widening it to the
//   paragraph: the finisher-duty paragraph names `jobs` a second time for an
//   unrelated reason ("or its `jobs`"), so a paragraph-wide match is satisfiable
//   from outside the statement — measured, with the clause narrowed to `missing`
//   alone a paragraph-wide variant went green while this file went red. That
//   same reason is why the clause STARTS at `drops`: the `--quiet` anchoring it
//   is matched, never captured, since capturing it drags the preamble back in.
//   Narrowing it to the first `drops` in the paragraph: any earlier `drops`
//   sentence about some other effect then satisfies the pin instead, and the
//   stderr stream `--quiet` also suppresses is exactly such a sentence, already
//   written in this shape in ci-state.mjs's own header — measured, with a decoy
//   stderr sentence inserted ahead of a gutted statement, a first-match variant
//   went green on the pre-#677 text verbatim while this file went red.
//
// A moved anchor reddens instead of silently widening the slice back to the file.
//
// #690 added the fourth site, the only one in source rather than in a document:
// ci-state.mjs's own header, far above the assignment it describes. It is sliced
// the other way round from the three document sites, and #695 is why. #690 gave
// it a document-shaped slice — anchor on a phrase of the statement, cut forward
// to the next blank line — and BOTH bounds were wrong in source:
//
// - The END bound. A blank line ends a markdown paragraph; a comment block ends
//   at its first non-`//` line, well before that. The slice ran on into live
//   code, so with the header statement gutted, one decoy sentence naming both
//   fields — pasted anywhere from `const quiet = has("quiet");` down to the
//   blank line under the `vlog` block — took the whole suite GREEN (measured;
//   the same decoy past that blank line stays red).
// - The START bound. A document site anchors on a heading OUTSIDE the sentence
//   it pins; in source the pinned sentence opens the block, so a phrase anchor
//   sits INSIDE what it pins and every edit to it reads as a moved anchor.
//   Measured: rewrapping the header at 36 cols — content byte-identical, both
//   fields still named — reported "slice anchor moved", and so did dropping
//   `missing` while rewording "suppresses", which named the wrong fault and hid
//   a real defect behind an instruction to edit this test.
//
// So this site anchors on the DECLARATION the header documents and takes the
// `//` block above it. Both bounds are code, the anchor moves only when the code
// does, and the pin covers exactly the comment. What the site still owes the
// clause bound is the BACKTICKED `--quiet`: bare, as the header read before
// #690, the slice is right and the clause is what fails, reporting an unpinned
// site (measured in both spellings).
//
// This file names its four sources by path and globs nothing, so its own text
// is not in the corpus and cannot satisfy the pins it carries.
//
// THE CEILING: this pins that each paragraph names every dropped field, and
// nothing else — not that the surrounding rule is right, not the prose around
// the clause, and it does not run ci-state.mjs (ci-state.test.mjs owns its
// behavior). It says nothing about the stderr stream `--quiet` also suppresses:
// a separate effect, and where a site states it — ci-state.mjs's header states
// it in the same sentence, ahead of the `drops` — the clause bound starts at
// `drops` and leaves it outside the pin. And it covers four sites, not every
// statement in the repo: the script-surface row in
// `docs/specs/2026-07-23-fleet-plugin-design.md` names both fields correctly
// today and is left to the pattern its siblings already use —
// `worktree-audit.test.mjs` and `no-undo-audit.test.mjs` each check their
// script's Out cell against a real run of that script, which for ci-state.mjs
// means standing up `gh` fixtures and is not the cheap check this one is.
//
// Reflow-safe by construction: `phrase()` joins the anchor's words on `\s+`, so
// SKILL.md (hard-wrapped ~80 cols) and review-and-fix.md (one long line per
// numbered step) take the identical anchor. Measured: the finisher-duty
// paragraph rewrapped at 55 cols stays green. `\s+` does NOT cross the `// ` a
// wrapped comment inserts, which is the other half of why the source site
// anchors on a one-line declaration instead: measured, the header rewrapped at
// 36 cols is green on the code anchor and reported a moved anchor on #690's
// phrase anchor, in the same run where all three document sites stayed green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorAt, paragraph } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(REPO, ...p.split("/")), "utf8");

const CI_STATE_PATH = "scripts/ci-state.mjs";
const SKILL = "skills/run-team/SKILL.md";
const REVIEW_AND_FIX = "commands/review-and-fix.md";

// The one assignment `--quiet` gates the payload on — now also gated on
// `!noCi` (#927: the no-ci arm never binds a run, so it drops `jobs`/`missing`
// unconditionally, the same way `emitRateLimited()` already does; `--quiet`'s
// own effect, which is what this file pins, is unchanged by that addition).
// The derivation's absence is a failure rather than an empty field list: an
// empty list would pass every site vacuously. Measured (#695): rewrite that
// assignment and the guard below is the one red while all four sites go green
// on zero assertions — so the guard is where a broken derivation is
// diagnosed, and the sites are left saying nothing rather than each
// repeating it.
const CI_STATE = read(CI_STATE_PATH);
const FIELDS = ((CI_STATE.match(/if \(!quiet && !noCi\) Object\.assign\(payload, \{([^}]*)\}\)/) ?? [])[1] ?? "")
  .split(",").map((f) => f.trim()).filter(Boolean);

test("the dropped-field list is still readable out of ci-state.mjs", () => {
  assert.ok(
    FIELDS.length,
    "ci-state.mjs no longer gates payload fields through `if (!quiet && !noCi) Object.assign(payload, { ... })` — re-derive FIELDS here from whatever replaced it, never hard-code the list",
  );
});

// The paragraph carrying the statement, and no more of the file than that. A
// missing anchor is a failure rather than a wider slice: silently falling back
// to the whole document is the false green this bound exists to prevent.
//
// The shared bound, not a local copy of it (#1372). What it closes that a local
// copy could not: a blank line carrying whitespace, which a literal `\n\n`
// search runs straight past into the next paragraph, and an anchor occurring
// more than once, which binds the pin to whichever copy of the anchored block
// comes first. What it does NOT close is a blank line deleted outright — the
// paragraphs then merge and the slice takes both, a hole that predates this
// bound and is open still (#1377).
//
// The source site takes the other bound and so cannot use `paragraph`: in source
// the anchor is the declaration BELOW the block, and the slice is the run of
// `//` lines above it — code at both ends, so no edit to the prose it holds can
// move either bound, where a blank-line bound would run past the end of the
// comment into that code (the false green measured in #695). It takes the anchor
// through `anchorAt` all the same, so the uniqueness half is shared rather than
// copied for the sake of an end bound that differs.
function siteSlice(name, anchor) {
  const text = read(name);
  if (!name.endsWith(".mjs")) return paragraph(text, anchor, name);
  return (text.slice(0, anchorAt(text, anchor, name)).match(/(?:[ \t]*\/\/[^\n]*\n)+$/) ?? [""])[0];
}

// The `--quiet` sentence, from its `drops` to the end of that sentence. The
// surrounding paragraphs each mention at least one dropped field for other
// reasons, so the clause bound is what makes a gutted statement red rather than
// green on its neighbours — and the `--quiet` prefix is what keeps this the
// sentence ABOUT the flag rather than whichever sentence says `drops` first.
// It is matched and discarded, not captured: a clause starting at `--quiet`
// would swallow the preamble the bound exists to exclude.
function dropsClause(name, anchor) {
  const clause = siteSlice(name, anchor).match(/`--quiet`[^.]*?(drops[^.]*)/);
  assert.ok(clause, `${name}: the "${anchor}" paragraph no longer has a \`--quiet\` sentence saying what it drops`);
  return clause[1];
}

const SITES = [
  [SKILL, "**Own the CI waits.**", "the CI-Monitor read"],
  [SKILL, "Gate on the `check` job", "the finisher-duty read"],
  [REVIEW_AND_FIX, "6. Diff-check green", "step 6's finisher read"],
  [CI_STATE_PATH, `const quiet = has("quiet");`, "the source-comment read"],
];

for (const [name, anchor, label] of SITES) {
  test(`${name} — ${label} names every field \`--quiet\` drops`, () => {
    const clause = dropsClause(name, anchor);
    for (const field of FIELDS) {
      assert.ok(
        clause.includes(`\`${field}\``),
        `${name}: ${label} says "${clause}", which does not name \`${field}\`. ci-state.mjs drops ${FIELDS.map((f) => `\`${f}\``).join(" and ")} under \`--quiet\`, and a reader arriving at this paragraph alone has no reason to see the other statements. Name every field here, or — if ci-state.mjs's payload changed — update all ${SITES.length} sites together.`,
      );
    }
  });
}
