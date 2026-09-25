import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorAt, phrase, stripQuoteGutter } from "./prose-pin.mjs";

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
// The ceiling these six tests have, measured against them: they are PRESENCE
// pins over a slice, which covers the location half and only that half. Moving
// the identity lines back out of the `>` quoting fails the suite (pass 5, fail
// 1), but a sentence APPENDED inside a block that contradicts a pinned one does
// not — a carve-out after the identity block, or a conditional permission after
// `Never apply ready-to-merge`, each left all 6 green.
//
// #1002 closed that half elsewhere rather than by tightening these regexes,
// which was tried and rejected on measurement: asserting the absence of
// arbitrary natural-language negation is unbounded, and a word blacklist
// ("unless", "except") buys a false-positive trap on ordinary prose rather than
// the guarantee. `dispatch-block-golden-prose.test.mjs` compares every block in
// this region — the identity block included — against a whole-block golden
// fixture it owns, so an appended carve-out reds there on the equality.
//
// These pins stay because they say something that file's diff does not: WHICH
// rule went missing, and the one thing a golden cannot express — the ACCEPT
// side of `sizing-a-ticket`'s own conditioning, which lives in another file
// entirely (see the last test below).
//
// #1465. Every multi-word pin below goes through `phrase()`, and so do the two
// slice anchors. A pin carrying a hardcoded single space reds on a pure rewrap
// of the runbook — no wording changed, no rule weakened — and that red is worse
// than a missing pin, because it teaches its reader that this suite reds for no
// reason. Measured before the conversion, against copies of both source files
// reflowed with the gutter preserved: at 55 columns 4 of these 6 tests red, and
// at 45 the START anchor's own `indexOf` misses, so 5 of them throw out of
// `memberBlocks()` without reaching a pin at all. The wrap width only samples
// which pin happens to fire, so the conversion is the whole file's, not the
// three phrases a rewrap was first seen to break.
//
// `phrase()`'s `\s+` cannot cross the `>` gutter that a wrap inside these
// blocks leaves behind, so the phrase pins match `memberProse()` — the region
// with the gutter stripped. `memberBlocks()` keeps the raw bytes for the first
// test, the one place the gutter is the subject rather than an obstacle.
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const SIZING = readFileSync(join(REPO, "skills", "sizing-a-ticket", "SKILL.md"), "utf8");

// #1804: the member-facing text is the BODY of the implementer agent
// definition (spec 2026-09-24 § 2 Decision 2), which each harness injects as
// the member's system prompt — the verbatim carrier the `>` blocks in phase 2
// used to be. Byte-identical in the `-alt` file (within-run-pair-prose.test.mjs
// pins that), so one file stands for both.
const AGENT_FILE = readFileSync(join(REPO, "agents", "fleet-implementer.agent.md"), "utf8");
const memberBlocks = () => AGENT_FILE.split("---").slice(2).join("---");
const memberProse = () => stripQuoteGutter(memberBlocks());
const phase2 = () => RUN_TEAM.slice(anchorAt(RUN_TEAM, "## Phase 2", "run-team phase 2"), anchorAt(RUN_TEAM, "## Phase 3", "run-team phase 3"));

test("every member-facing rule sits in the agent body the harness injects, not in the controller's phase 2", () => {
  assert.ok(memberBlocks().trim().length > 0, "the implementer agent body is empty — the member receives no rules at all");
  // The location defect, restated for the new carrier. A rule the controller
  // reads in phase 2 reaches the member only if the controller retypes it,
  // and a controller that drops it emits no error. A copy left there as well
  // is the other half: two sources free to drift, one of which no member reads.
  for (const opener of ["**You are an unattended fleet member.**", "Run `sizing-a-ticket`", "`next-ticket` **step 7**"]) {
    assert.match(memberProse(), phrase(opener), `the implementer agent body no longer carries "${opener}"`);
    assert.doesNotMatch(phase2(), phrase(opener), `run-team/SKILL.md's phase 2 carries "${opener}" again — the member reads the agent body, so this copy is either dead or a second source to drift`);
  }
});

test("the member is told it is unattended, in text it receives verbatim", () => {
  const prose = memberProse();

  // Without this, `sizing-a-ticket:18`'s `**Fleet member on heavy:**` condition
  // cannot fire. The only prior signal was the incidental word "controller".
  assert.match(
    prose,
    phrase("**You are an unattended fleet member.**"),
    "no block tells the member it is an unattended fleet member — the sizing skill's fleet branch cannot fire",
  );
  assert.match(
    prose,
    phrase("No maintainer is reachable"),
    "the member is not told a maintainer is unreachable, so it can still read a gated skill as worth waiting on",
  );
});

test("the sizing instruction reaches the member verbatim, on either row", () => {
  const prose = memberProse();
  assert.match(prose, phrase("Run `sizing-a-ticket`"), "the sizing instruction is no longer in a verbatim block");
  assert.match(
    prose,
    phrase("**either row**"),
    "the member is not told both rows are workable, so a heavy row reads as a reason to bail",
  );
});

test("the handoff names its destination, and a light-row member cannot read it as the heavy-row entry", () => {
  const prose = memberProse();

  // `next-ticket` steps 1-5 are selection and claiming; step 6 is the sizing run.
  // The pre-fix text said "the member starts there" with no antecedent, and two
  // reviewing specialists bound it differently. So match the number together
  // with the action beside it: bare presence checks for "step 6" and "step 7"
  // BOTH stay green when the two numbers are swapped, and a member reading that
  // runs the PR steps at the sizing checkpoint and vice versa.
  assert.match(
    prose,
    phrase("`next-ticket` **step 6**, which is that sizing run"),
    "step 6 is no longer bound to the sizing run — its destination is a pronoun again, or the number now names another step",
  );
  // The wrong binding, and the one that bites: the nearest place-like phrase was
  // the heavy-row entry point, which would send a LIGHT-row member to plan-writing.
  // Stays a literal regex — one token, so there is no inter-word space for a
  // wrap to land in and nothing for `phrase()` to tolerate.
  assert.doesNotMatch(
    prose,
    /superpowers:writing-plans/,
    "the member prompt names the heavy-row entry point, which a light-row member would follow",
  );
});

test("the PR handoff reaches the member verbatim, including what it must never do", () => {
  const prose = memberProse();
  assert.match(
    prose,
    phrase("`next-ticket` **step 7**: rebase, re-run tests, push"),
    "step 7 is no longer bound to the rebase/push/PR action — the PR step is not carried verbatim, or the number now names another step",
  );
  assert.match(prose, phrase("`Closes #N`"), "the member is not told to close its issue from the PR body");
  assert.match(
    prose,
    phrase("Never apply `ready-to-merge`, never merge"),
    "the two prohibitions the member must never learn by paraphrase are no longer in the block",
  );
});

test("the sizing skill stays conditioned — a solo session still runs the interactive path", () => {
  // The ACCEPT side. #172 was fixed by telling the member what it is, NOT by
  // deleting the distinction: triage rejected making this entry unconditional,
  // because it correctly serves solo sessions, which do have a user to approve.
  assert.match(
    SIZING,
    phrase("**Fleet member on heavy: enter at `superpowers:writing-plans`.**"),
    "the fleet heavy-row entry is no longer conditioned — solo sessions now skip brainstorming too",
  );
  assert.match(
    SIZING,
    phrase("Solo session has a user: run full path"),
    "a solo session no longer runs the full interactive path",
  );
});
