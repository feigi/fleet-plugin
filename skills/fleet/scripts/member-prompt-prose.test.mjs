import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #172. A fleet member learns what it is, and what to run, only from the blocks
// run-team phase 2 carries VERBATIM. Everything else in that section is
// controller-facing prose the member sees only if the controller paraphrases it
// — and `sizing-a-ticket`'s fleet entry point is CONDITIONED on the reader being
// an unattended fleet member. Take that condition's evidence away and the member
// reads itself as a solo session, takes `superpowers:brainstorming`, and parks on
// its <HARD-GATE> waiting for an approval no unattended member can ever obtain.
//
// So the pin is on LOCATION, not vocabulary. Moving these words back out into
// prose IS the defect, and every word would still be somewhere in the file — a
// pin that only searched the section would stay green through the whole bug.
//
// Known ceiling, measured against this file's 6 tests. These are PRESENCE pins
// over a slice, which covers the location half and only that half: moving the
// identity lines back out of the `>` quoting fails the suite (pass 5, fail 1),
// but a sentence APPENDED inside a block that contradicts a pinned one does
// not — a carve-out after the identity block, or a conditional permission
// after `Never apply ready-to-merge`, each leaves all 6 green. Left open on
// purpose: asserting the absence of arbitrary natural-language negation is
// unbounded, and a word blacklist ("unless", "except") buys a false-positive
// trap on ordinary prose rather than the guarantee.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
const SIZING = readFileSync(join(REPO, "skills", "fleet", "skills", "sizing-a-ticket", "SKILL.md"), "utf8");

const START = "and each of these verbatim:";
const END = "Each rule in the enumerate-and-declare block";

// Inlined rather than importing a `section()` helper: two other test files carry
// their own copy and neither exports it, and this file needs exactly one slice.
function memberBlocks() {
  const at = RUN_TEAM.indexOf(START);
  assert.notEqual(at, -1, `phase 2's verbatim-blocks intro ('${START}') moved — update this test`);
  const end = RUN_TEAM.indexOf(END, at);
  assert.notEqual(end, -1, `the rationale anchor ('${END}') moved — update this test`);
  return RUN_TEAM.slice(at + START.length, end);
}

test("every member-facing rule sits inside a quote block, where the controller carries it verbatim", () => {
  const lines = memberBlocks().split("\n").filter((l) => l.trim() !== "");
  assert.ok(lines.length > 0, "the member prompt region is empty");

  // The whole defect in one assertion. An unquoted line here reaches the member
  // only if the controller retypes it, and a controller that drops it emits no
  // error — the member simply runs without the rule.
  const stray = lines.filter((l) => !l.startsWith(">"));
  assert.deepEqual(
    stray,
    [],
    "member-prompt text sits outside the `>` blocks — the controller carries only the blocks, so this reaches the member by paraphrase or not at all",
  );
});

test("the member is told it is unattended, in text it receives verbatim", () => {
  const blocks = memberBlocks();

  // Without this, `sizing-a-ticket:18`'s `**Fleet member on heavy:**` condition
  // cannot fire. The only prior signal was the incidental word "controller".
  assert.match(
    blocks,
    /\*\*You are an unattended fleet member\.\*\*/,
    "no block tells the member it is an unattended fleet member — the sizing skill's fleet branch cannot fire",
  );
  assert.match(
    blocks,
    /No maintainer is reachable/,
    "the member is not told a maintainer is unreachable, so it can still read a gated skill as worth waiting on",
  );
});

test("the sizing instruction reaches the member verbatim, on either row", () => {
  const blocks = memberBlocks();
  assert.match(blocks, /Run `sizing-a-ticket`/, "the sizing instruction is no longer in a verbatim block");
  assert.match(
    blocks,
    /\*\*either row\*\*/,
    "the member is not told both rows are workable, so a heavy row reads as a reason to bail",
  );
});

test("the handoff names its destination, and a light-row member cannot read it as the heavy-row entry", () => {
  const blocks = memberBlocks();

  // `next-ticket` steps 1-5 are selection and claiming; step 6 is the sizing run.
  // The pre-fix text said "the member starts there" with no antecedent, and two
  // reviewing specialists bound it differently. So match the number together
  // with the action beside it: bare presence checks for "step 6" and "step 7"
  // BOTH stay green when the two numbers are swapped, and a member reading that
  // runs the PR steps at the sizing checkpoint and vice versa.
  assert.match(
    blocks,
    /`next-ticket` \*\*step 6\*\*, which is that sizing run/,
    "step 6 is no longer bound to the sizing run — its destination is a pronoun again, or the number now names another step",
  );
  // The wrong binding, and the one that bites: the nearest place-like phrase was
  // the heavy-row entry point, which would send a LIGHT-row member to plan-writing.
  assert.doesNotMatch(
    blocks,
    /superpowers:writing-plans/,
    "the member prompt names the heavy-row entry point, which a light-row member would follow",
  );
});

test("the PR handoff reaches the member verbatim, including what it must never do", () => {
  const blocks = memberBlocks();
  assert.match(
    blocks,
    /`next-ticket` \*\*step 7\*\*: rebase, re-run tests, push/,
    "step 7 is no longer bound to the rebase/push/PR action — the PR step is not carried verbatim, or the number now names another step",
  );
  assert.match(blocks, /`Closes #N`/, "the member is not told to close its issue from the PR body");
  assert.match(
    blocks,
    /Never apply `ready-to-merge`, never merge/,
    "the two prohibitions the member must never learn by paraphrase are no longer in the block",
  );
});

test("the sizing skill stays conditioned — a solo session still runs the interactive path", () => {
  // The ACCEPT side. #172 was fixed by telling the member what it is, NOT by
  // deleting the distinction: triage rejected making this entry unconditional,
  // because it correctly serves solo sessions, which do have a user to approve.
  assert.match(
    SIZING,
    /\*\*Fleet member on heavy: enter at `superpowers:writing-plans`\.\*\*/,
    "the fleet heavy-row entry is no longer conditioned — solo sessions now skip brainstorming too",
  );
  assert.match(
    SIZING,
    /Solo session has a user: run full path/,
    "a solo session no longer runs the full interactive path",
  );
});
