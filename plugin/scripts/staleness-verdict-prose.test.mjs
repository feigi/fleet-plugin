// #823, deferred from PR #813's review (issue #238). PR #813 added run-team's
// phase-0 liveness machinery as PROSE — the `staleness.mjs` usage block, the
// exit-code table, and the instruction to annotate a survivor whose probe came
// back `could not check` — and shipped it unpinned, in a repo whose convention
// is to pin exactly this kind of load-bearing instructional clause. Settled on
// the pushed head before writing this file:
//
//   git grep -lF 'could not check' origin/main -- 'plugin/scripts/*.test.mjs'
//     → no output, exit 1
//
// `staleness-qualifier-prose.test.mjs` is the near neighbour and does NOT cover
// this: it pins #196's `review-and-fix.md` / SKILL.md finisher-dispatch twins,
// a different clause about a `skipped` heavy job. `staleness.test.mjs` exercises
// the script's behaviour and reads no SKILL.md text at all (settled: it contains
// neither `SKILL.md` nor `readFileSync`). So nothing stood between this block
// and a silent reword.
//
// WHAT IS PINNED, and what is deliberately not. The block states more than the
// rules pinned here — where the probe sits in phase 0 and why, the `--`
// end-of-options separator #240 needs, the fold-into-a-neighbour hazard behind
// the third value, the `origin/main`-only read, the absent-and-never-changed
// positive control, and the refusal to run a reproduction. This file pins the
// clauses a reader must obey to use the tool correctly — the flag the script
// actually accepts, which direction flag means what, that exactly one is
// given, what each exit code's verdict does to supply, and that a
// `could not check` survivor is annotated as one. The rest is
// rationale for those rules; it is left unpinned on purpose, so a rewrite of the
// reasoning is not a red. The `origin/main`-only paragraph also names
// `claim-ticket.sh`, and no slice here reaches it.
//
// THE SLICE ANCHOR IS WHAT ANCHORS. Matched over the whole document these
// assertions are satisfiable from OUTSIDE the clauses they guard: this SKILL.md
// discusses exit codes, verdicts, offering and annotating survivors across many
// neighbouring paragraphs, and phase 0's own prose quotes the member prompt back
// at itself. Measured — with every pinned clause gutted in place and one stray
// line carrying the original wording appended to the end of the file, an
// unbounded suite went green on all of them, the pass bought entirely by the
// decoy. `paragraph()` cuts each to the one block carrying its rule, and a moved
// anchor reddens instead of silently widening back to the file.
//
// MUTATION-TESTED BOTH WAYS, because a pin that reds on any edit discriminates
// nothing. Reds measured on token-PRESERVING semantic flips, never on
// vocabulary deletion — swapping the two verdict rows' supply actions, swapping
// the `--gone` and `--present` glosses, moving the annotate instruction onto a
// different verdict, and renaming the invocation's flag to one the script
// rejects (`--path` → `--file`) each keep every pinned word and flip only the
// meaning, and each reds its own assertion and no other. Greens measured on the containing
// paragraphs rewrapped across 60-400 columns: `phrase()` joins words on `\s+`,
// so a rewrap is a no-op.
//
// THE REFLOW CEILING is hyphen-breaking, as `staleness-qualifier-prose.test.mjs`
// records for its own pins: a wrapper splitting a hyphenated word at the break
// puts a hyphen-newline where `\s+` cannot span. It does not bite here — no
// clause pinned in this file carries a hyphenated token — and that is a fact
// about the current wording, not a guarantee, so a reword that introduces one
// inherits the ceiling.
//
// THE OTHER CEILING is that these are positive pins: they see a clause deleted
// or reworded, never a contradiction added beside it. A sentence appended after
// "Give exactly one" permitting both flags leaves this suite green. Pinning the
// absence of an unwritten future sentence is not something a positive match can
// do; the guard against it is review, not this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, phrase } from "./prose-pin.mjs";

const SKILL = "skills/run-team/SKILL.md";
const text = readFileSync(join(import.meta.dirname, "..", ...SKILL.split("/")), "utf8");

const USAGE = "**`staleness.mjs` runs that check";
const TABLE = "| Exit | Verdict |";
const SURVIVORS = "Annotate every survivor with its class";

// The flag itself, not just the glosses around it: `--path` sits inside this
// same paragraph and was asserted by nothing, so the doc could drift to a flag
// the script does not accept with no red — measured green on
// `--path` → `--file`. Pinned to the flag alone rather than the whole
// invocation, so renaming the `<path>` placeholder stays a no-op.
const INVOCATION = "staleness.mjs --path";

const DIRECTIONS =
  "`--gone` is a defect the fix must remove, the wording the ticket quotes as wrong; `--present` is what the fix must add, the assertion a pin ticket asks for";
const EXACTLY_ONE =
  "Give exactly one — the direction is not inferable from the string, and the wrong one answers the opposite verdict with full confidence";
const ANNOTATE =
  "Annotate any survivor whose liveness probe came back **could not check** with that verdict and the reason its payload gave";

// Each row binds a verdict to what it does to SUPPLY, which is the whole
// content of the table — a verdict name alone prescribes nothing. Pinned per
// row rather than as one blob so a first failure cannot mask the others.
const VERDICT_ROWS = [
  ["0", "| 0 | still reproduces | offer it |"],
  ["1", "| 1 | provably fixed | do not offer; close citing the payload's `commit` and `subject` |"],
  ["2", "| 2 | could not check | offer it, **and say the probe could not check** |"],
];

test(`${SKILL} keeps the invocation on the flag \`staleness.mjs\` actually accepts`, () => {
  assert.match(
    paragraph(text, USAGE, SKILL),
    phrase(INVOCATION),
    `${SKILL} no longer spells the invocation "${INVOCATION}". A reader who copies a flag the script does not accept gets \`staleness: --path <path> is required\` at exit 2 — a could-not-check indistinguishable from a real one, which the table below then says to offer and annotate. Restore it, or re-anchor INVOCATION in this file to the new wording.`,
  );
});

test(`${SKILL} keeps \`--gone\` and \`--present\` bound to the direction each one means`, () => {
  assert.match(
    paragraph(text, USAGE, SKILL),
    phrase(DIRECTIONS),
    `${SKILL} no longer says "${DIRECTIONS}". The direction is not recoverable from the needle itself, so a reader who loses this gloss picks a flag by guess and the wrong one answers the OPPOSITE verdict with full confidence — a live defect reported fixed, or a fixed one reported live. Restore it, or re-anchor DIRECTIONS in this file to the new wording.`,
  );
});

test(`${SKILL} keeps the probe to exactly one direction per invocation`, () => {
  assert.match(
    paragraph(text, USAGE, SKILL),
    phrase(EXACTLY_ONE),
    `${SKILL} no longer says "${EXACTLY_ONE}". Without it the usage block reads as if both flags may be passed together, which no verdict in the table below describes. Restore it, or re-anchor EXACTLY_ONE in this file to the new wording.`,
  );
});

for (const [code, row] of VERDICT_ROWS) {
  test(`${SKILL} keeps exit ${code}'s verdict bound to what it does to supply`, () => {
    assert.match(
      paragraph(text, TABLE, SKILL),
      phrase(row),
      `${SKILL}'s exit-code table no longer carries "${row}". A verdict whose supply action drifts is worse than a missing one: the reader still acts, on the wrong instruction. Restore the row, or re-anchor VERDICT_ROWS in this file to the new wording.`,
    );
  });
}

test(`${SKILL} makes a \`could not check\` survivor arrive annotated as one`, () => {
  assert.match(
    paragraph(text, SURVIVORS, SKILL),
    phrase(ANNOTATE),
    `${SKILL} no longer says "${ANNOTATE}". The survivor list is where the third value has to land — a probe that could not look answers exactly like one that looked and found nothing, so a survivor presented without the verdict reads as one the probe checked and found live, which is the collapse into a neighbour that the third value exists to prevent. Restore it, or re-anchor ANNOTATE in this file to the new wording.`,
  );
});
