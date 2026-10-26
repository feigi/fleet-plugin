import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";
import { HALT_CAUSES } from "../plugin/scripts/ledger-grammar.mjs";

// The finisher is dispatched pinned to a SHA, and a head that moves after the
// pin is a halt: the halt-on-moved-head rule catches it, correctly, every time.
// The defect was that a halt read only "SHA differs from pin" and gave the
// controller nothing to act on without a fresh audit; the cure was a halt-cause
// block naming each cause and the evidence it owes (#144, #997).
//
// That block was four kilobytes of prose a finisher followed by hand, and three
// finishers in one run adjudicated a reflog the head-equality check had already
// answered. The derivation is now `finisher-audit.mjs`, whose own test drives
// every cause against real fixture repositories (finisher-audit.test.mjs), and
// the block is the call to it plus what each exit code means. So what these pins
// hold is what only the prose can: the call itself, the exit vocabulary the
// finisher reads, the dispatch pin as the operand, and the rule that every
// cause halts. The per-cause evidence pins that used to sit here moved into the
// script's test, where a mutation of the derivation reds a behaviour instead of
// a sentence.
//
// Slice-scoped, not whole-file: a bare presence check anywhere in the member
// prompt would stay green even if the text moved somewhere that never reaches
// its reader (measured before, in this same file — member-prompt-prose.test.mjs
// #172). The block is finisher-facing: it lives in the finisher's agent body,
// which the harness injects as the member's system prompt, and SKILL.md carries
// no copy of it for the controller to paraphrase.
const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));

const CAUSE_BLOCK_START = "**Duty 1 is one script, and its exit code is your verdict.**";
// The paragraph that follows the block opens the instrument re-check; it is
// no part of the halt-cause text.
const CAUSE_BLOCK_END = "**Re-check the instrument set before you act on what duty 1 or duty 2 read";

// The finisher's member prompt sliced to the cause block, whitespace-collapsed:
// a phrase match needs the wrap invisible.
function causeBlock() {
  return Pin.of(memberPrompt("finisher", "fresh"), "the finisher's member prompt")
    .between(CAUSE_BLOCK_START, CAUSE_BLOCK_END, "the finisher's halt-cause block")
    .text;
}

function causeText() {
  return causeBlock().replace(/\s+/g, " ");
}

// The paragraph that says the cause list is open sits in the controller-facing
// halt resolution, outside the block, so `causeText()` cannot see it — and the
// closed-count wording #997 removed lived in prose like it. Anchored on the
// surviving half of that sentence and bounded by its own paragraph:
// `paragraph` refuses a duplicated or missing anchor rather than widening to
// the whole file, which is the only way a "no closed count anywhere" assertion
// could pass by looking at nothing.
// The lead-in is rationale, so it lives in the finisher reference, ahead of the
// past-pin section that follows it there.
const FINISHER_REF = Pin.file(join(REPO, "skills", "run-team", "references", "finisher.md"));
const LEAD_ANCHOR = "A halt at duty 1 reads identical from a bare SHA mismatch";
const leadIn = () => FINISHER_REF.paragraph(LEAD_ANCHOR, "run-team halt-cause lead-in", "## Why a `past-pin` halt needs the tick").text;

const list = (words) => `${words.slice(0, -1).map((w) => `\`${w}\``).join(", ")} or \`${words.at(-1)}\``;
// `human` is duty 3's exit 5 and no verdict of duty 1's audit, so the audit block does not name it.
const AUDIT_CAUSES = HALT_CAUSES.filter((c) => c !== "human");

test("the cause evidence reaches the finisher through its agent body, and SKILL.md carries no copy of it", () => {
  const block = causeBlock();
  assert.ok(block.trim().length > 0, "the cause block is empty");
  assert.doesNotMatch(
    RUN_TEAM.text,
    Pin.phrase("Every cause halts, always"),
    "SKILL.md carries the halt-cause rule again — a second copy beside the finisher's body is free to drift from the one the member reads",
  );
});

test("the block runs the audit as one script through the Resolver, its exit code the verdict, and spells no step of it", () => {
  const text = causeText();
  assert.match(
    text,
    Pin.phrase("**Duty 1 is one script, and its exit code is your verdict.** `~/.fleet/bin/fleet-run finisher-audit.mjs --worktree <abs-path> --pin <your dispatch pin>`"),
    "the block no longer runs `finisher-audit.mjs` through the Resolver with --worktree and --pin — a finisher that reaches the audit by another route, or by hand, skips the derivation the script owns",
  );
  // The steps are the script's. A git command spelled again here is the by-hand
  // path back: a finisher that can read the reflog from the block reads it, and
  // adjudicates what the head-equality check had already answered.
  assert.doesNotMatch(
    text,
    /git (status|reflog|diff|ls-remote|cherry|log|rev-parse)\b/,
    "the block spells a git step of the audit again — the steps are separable by hand once more, which is the adjudication the script exists to remove",
  );
});

test("the exit vocabulary: 0 alone is clean, 1 names a cause from the ledger's vocabulary, 2 is a halt too", () => {
  const text = causeText();
  assert.match(
    text,
    Pin.phrase("Exit 0, with `cause` null, is the only code that means the worktree is clean at your pin."),
    "the block no longer says exit 0 with a null cause is the only clean result — a finisher can read any other code as a pass",
  );
  assert.match(
    text,
    Pin.phrase(`Exit 1 means \`cause\` is non-null: you are halted, and \`cause\` is the word you name — ${list(AUDIT_CAUSES)}, and \`other\` is a cause too, not a gap.`),
    "the block's causes are no longer the ledger's `halted:<cause>` vocabulary, or it no longer says a non-null cause halts — the ledger refuses a word it does not know, and a cause the block does not name reads as impossible",
  );
  assert.match(
    text,
    Pin.phrase("Exit 2 means the script could not look: you are halted with cause `other`, with the line it printed on stderr as the evidence."),
    "the block no longer halts a finisher on exit 2 — a script that could not look prints a verdict with a null cause, which reads as clean",
  );
});

test("the pin is the dispatch pin, never the PR's headRefOid", () => {
  const text = causeText();
  // The short-circuit exists to stop finishers adjudicating a reflog that
  // head-equality had already settled. WHICH head it compares to is the whole
  // rule: the audit is ENTERED on a mismatch against the dispatch pin, so a
  // comparison against `PR headRefOid` answers a different question — "is the
  // local tree in sync with the pushed tip?" — and a member that kept working
  // and pushed after the pin passes it while holding commits no reviewer read.
  // ONE contiguous span, not two matches: the operand and its reason have to
  // stay joined, since either half alone is satisfiable by the broken form.
  assert.match(
    text,
    Pin.phrase(
      "The pin is the SHA you were dispatched against, never `PR headRefOid`: a member that kept working and pushed after the pin matches the branch tip on a clean tree, so a headRefOid comparison reports \"settled\" over commits no reviewer read — the exact divergence this halt exists to catch.",
    ),
    "the block no longer says the pin is the dispatch SHA and not `PR headRefOid` — a member that pushed after the pin reads as 'settled' and gets labelled over commits no reviewer saw",
  );
  assert.doesNotMatch(
    text,
    /--pin <(PR )?headRefOid>/,
    "the block hands the script the pushed branch tip as its pin — the comparison the script makes is then always against the tip the member itself moved",
  );
});

test("a finisher never replays the script's steps by hand, and reports the verdict as printed", () => {
  const text = causeText();
  assert.match(
    text,
    Pin.phrase("You do not run any of the script's steps by hand to get past a halt or to second-guess it."),
    "the block lets a finisher run the steps by hand — a halt it does not like is then one `git status` away from a label",
  );
  assert.match(
    text,
    Pin.phrase("Put the verdict, the JSON line it printed, in your report as printed: its `evidence` is what the controller resolves the halt from."),
    "the block no longer has the finisher report the verdict as printed — the cause's evidence (the replay verdict and range-diff listing, the pushed/unpushed/unknown read) never reaches the controller",
  );
});

test("a moved head still halts, always — the cause decides what the report says, never whether it halts", () => {
  const text = causeText();
  // ONE exact contiguous span, not two independent phrase matches. The
  // invariant lives in the join: splicing an exception clause between
  // "halts, always" and "you never verify the dirt is harmless" reverses the
  // rule while leaving both phrases intact, and two separate `assert.match`
  // calls stayed green through exactly that mutation (measured, #488 review).
  // The tail is the explicit rejection of issue option 3 ("accept a
  // fast-forward") — the controller ruling took options 2+4, not 3, and a
  // finisher that treats a clean rebase as auto-approved is what triage
  // rejected. Whitespace is already normalised by causeText(), so this is
  // literal text, not a shape.
  // #997 widened this from "Either cause", which quantified over exactly two.
  // The open list creates a false-negative the two-valued form could not
  // cover: an unmatched cause with no halt rule quantifying over it reads as
  // the one case where naming what you found might substitute for halting.
  // Hence `named or not`, inside the same contiguous span.
  assert.match(
    text,
    /Every cause halts, always — named or not, you never verify the dirt is harmless and label over it, a rebase is not a fast-forward you get to accept, a commit past the pin is not one either, and a cause you could not name is the least settled of the lot\./,
    "the always-halts invariant no longer reads verbatim in the block the finisher reads — either it's gone, or a clause was inserted into it that makes the halt conditional, or it stopped quantifying over the unnamed cause, or the ban on labelling over a moved head was dropped",
  );
});

test("the cause list is open — no count is asserted, and `other` is a cause rather than a gap", () => {
  const lead = leadIn();
  const text = causeText();

  // Generic over the number word, in both slices that carried one. A count
  // that has been wrong once will be wrong again, so a rewrite to "exactly
  // three causes" is this defect again and not a fix of it — that is why
  // these pins do not name `two`.
  //
  // Wide, not `exactly \w+ causes`: that narrower gap only forbade the literal
  // word "exactly" immediately before the count, so restoring a closed count
  // as "the three causes below" (no "exactly", one extra word before "causes")
  // passed it clean — measured, mutate.py M4. `(?:\s+\w+){0,3}` spans the
  // count word forward to "causes"/"things" through up to three filler words,
  // which is what both slices' surrounding prose needs room for.
  assert.doesNotMatch(
    lead,
    /\b(two|three|four|five|six|seven|eight|\d+)\b(?:\s+\w+){0,3}\s+causes\b/i,
    "the lead-in asserts a fixed number of causes again — the enumeration is closed, and the cause that is not on the list reads as impossible to the finisher deriving it",
  );
  assert.match(
    lead,
    Pin.phrase("the causes `finisher-audit.mjs` names are the ones seen so far, not a closed list"),
    "the lead-in no longer says the list is open — silence there is the closed reading restored, since a list with no disclaimer is read as complete",
  );
  assert.doesNotMatch(
    text,
    /\b(two|three|four|five|six|seven|eight|\d+)\b(?:\s+\w+){0,3}\s+(causes|things)\b/i,
    "the block the finisher reads counts the causes again — the count word inside the finisher's halt-cause block is the one that reaches the finisher verbatim",
  );
});

test("the lead-in names the script the member's body runs", () => {
  assert.match(
    leadIn(),
    Pin.phrase("the finisher's agent body gives it the cause from one script instead of asking anyone"),
    "the lead-in no longer says the cause comes from one script — a controller reading it paraphrases the steps back in",
  );
});

test("the reply-owed gate for the fix-applier is still in the dispatch rules", () => {
  // The rule that the controller never dispatches a finisher while it still
  // owes the fix-applier a reply is its own sentence, independent of the
  // halt-cause block above; this pins that it wasn't clipped or reworded.
  assert.match(
    RUN_TEAM.text,
    /Never dispatch\s*\n?one while you still owe the fix-applier a reply/,
    "the fix-applier reply-owed gate no longer reads as before — check it wasn't altered",
  );
});
