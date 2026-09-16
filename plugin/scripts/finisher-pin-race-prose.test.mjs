import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph } from "./prose-pin.mjs";

// #144. The finisher is dispatched pinned to a SHA the reviewer already left
// behind: the reviewer composes a verdict once it has enough, then keeps
// applying late-arriving specialist relays and pushes again. The pin going
// stale isn't the defect — the halt-on-moved-head rule already catches it,
// correctly, every time. The defect is that (a) the controller dispatches
// before every specialist report is relayed, when it holds the receipts to
// know better, and (b) a halt reads only "SHA differs from pin" and gives
// the controller nothing to act on without a fresh audit.
//
// Slice-scoped, not whole-file: a bare presence check anywhere in this
// 1200+ line SKILL.md would stay green even if the text moved somewhere
// that never reaches its reader (measured before, in this same file —
// member-prompt-prose.test.mjs #172). Two different readers here: the
// dispatch gate is controller-facing and lives in the Fallback section, the
// cause-block evidence is finisher-facing and must sit inside a `>` block the
// controller carries verbatim.
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const FALLBACK_START = "#### Fallback: hand-dispatched reviewer member";
const FALLBACK_END = "### Merge bot";

// #753: proven output-identical to `between()` on the real SKILL.md text —
// FALLBACK_END never occurs inside FALLBACK_START's own text, so searching
// from `at` instead of `at + FALLBACK_START.length` never changes the match.
const fallbackSection = () => between(RUN_TEAM, FALLBACK_START, FALLBACK_END, "run-team fallback section");

const CAUSE_BLOCK_START = "instead of asking anyone:";
const CAUSE_BLOCK_END = "Gate on the `check` job";

// Raw slice: keeps the `>` prefixes, needed by the structural (every-line-quoted)
// test below.
function causeBlock() {
  const at = RUN_TEAM.indexOf(CAUSE_BLOCK_START);
  assert.notEqual(at, -1, `cause-block anchor ('${CAUSE_BLOCK_START}') moved — update this test`);
  const end = RUN_TEAM.indexOf(CAUSE_BLOCK_END, at);
  assert.notEqual(end, -1, `the CI-gate paragraph that follows ('${CAUSE_BLOCK_END}') moved — update this test`);
  return RUN_TEAM.slice(at + CAUSE_BLOCK_START.length, end);
}

// Flattened: markdown hard-wraps a `>` block at ~80 columns, so a phrase can
// split across a line with a literal `>` re-injected at the wrap point. A
// phrase match needs the wrap invisible; the structural test needs it intact,
// hence two helpers instead of one.
function causeText() {
  return causeBlock().replace(/\n>?[ \t]*/g, " ");
}

// #997. The lead-in that introduces the list sits OUTSIDE the `>` block, so
// `causeText()` cannot see it — and the count word this ticket removes lived
// there, not in the block. Anchored on the surviving half of that sentence and
// bounded by its own paragraph: `anchorAt` refuses a duplicated or missing
// anchor rather than widening to the whole file, which is the only way a
// "no closed count anywhere" assertion could pass by looking at nothing.
const LEAD_ANCHOR = "A halt at step 1 reads identical from a bare SHA mismatch";
const leadIn = () => paragraph(RUN_TEAM, LEAD_ANCHOR, "run-team halt-cause lead-in");

test("finisher dispatch is gated on outstanding specialist relays, in the section that owns relay receipts", () => {
  const section = fallbackSection();
  assert.match(
    section,
    /receipts gate the finisher dispatch/i,
    "the fallback section no longer gates finisher dispatch on relay receipts — a late relay can again land after dispatch with nothing checking for it",
  );
  assert.match(
    section,
    /unrelayed/,
    "the gate no longer names an unrelayed report as the blocking condition",
  );
  // The scope boundary matters as much as the rule: the workflow path has no
  // async relay at all (`agent()` returns synchronously), so a gate that reads
  // as universal would strand controllers into believing a wait is needed
  // where none exists.
  assert.match(
    section,
    /workflow path/i,
    "the gate doesn't say it's a no-op on the workflow path — a controller reading only this rule may wait on a relay that can never arrive there",
  );
});

test("the cause evidence sits inside a quote block, not only in controller narrative", () => {
  const block = causeBlock();
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  assert.ok(lines.length > 0, "the cause block is empty");
  const stray = lines.filter((l) => !l.startsWith(">"));
  assert.deepEqual(
    stray,
    [],
    "cause text sits outside the `>` block — a finisher only receives this if the controller paraphrases it, same failure #172 already fixed once in this file for the implementer",
  );
});

test("the live-editor and rebase causes are named, with evidence a finisher can gather without asking anyone", () => {
  const text = causeText();

  assert.match(text, /\*\*Live editor\.\*\*/, "the live-editor cause is no longer named");
  assert.match(
    text,
    /git status --porcelain.*dirty/,
    "live editor is no longer tied to a dirty worktree, checkable with a plain git command",
  );
  assert.match(
    text,
    /git diff --stat.*\bapart\b/,
    "the growth check (two samples apart) is missing — a single dirty read can't distinguish a live editor from a one-off leftover",
  );

  assert.match(text, /\*\*Rebase\.\*\*/, "the rebase cause is no longer named");
  assert.match(
    text,
    /git reflog/,
    "the rebase cause no longer points at git reflog — without it a finisher has no self-checkable way to tell a rebase from a live edit on a clean tree",
  );
});

// #997, measured 2026-08-28 on #983: the working tree was clean (sampled twice
// a minute apart, empty diffstat both times), the reflog head was a plain
// `commit` past the dispatch pin, and the `reset`/rebase entries sat BEHIND the
// pin — the implementer's own pre-push replay, which the block already excuses
// as provenance. So it matched neither named cause, and the block's own count
// word said that was impossible. The finisher halted on its own judgement,
// which is luck: the block's whole purpose is that an unattended finisher
// DERIVES the cause, and the block itself calls a bare "head moved" an
// inadequate report — so a closed list that excludes the live case leaves
// "unexplained" as the only remaining output, and that is the state where
// labelling over a moved head starts looking reasonable.
test("the commit-past-the-pin cause is named, with a discriminator neither other cause matches", () => {
  const text = causeText();
  assert.match(
    text,
    /\*\*Work past the pin\.\*\*/,
    "the commit-past-the-pin cause is no longer named — a finisher meeting a clean tree with a plain `commit` past its pin is back to a list that excludes the thing it is looking at",
  );
  // ONE contiguous span, because the discriminator IS the join. The rebase
  // bullet opens on the same clean-tree-and-head-differs read and is told apart
  // only by what the reflog says at the move, so a bare `/plain `commit`/`
  // matches the rebase bullet's own "not a plain `commit`" exclusion and buys
  // the green with this cause deleted.
  assert.match(
    text,
    /`git status --porcelain -unormal` is clean, head still differs from your pin, and `git reflog` in the worktree reads a plain `commit` at the move/,
    "the discriminator no longer separates this cause from the rebase one — either the clean-tree-and-head-differs read went, or the reflog test stopped keying on a plain `commit` at the move",
  );
  // The provenance carve-out the block already grants rebase entries at or
  // behind the pin has to stay attached to THIS cause too, or a finisher that
  // sees any rebase entry in the reflog routes back to `rebase` and reports the
  // replay instead of the commit that actually moved the head.
  assert.match(
    text,
    /no `reset`\/rebase entry there, any of those sitting at or behind the pin as provenance/,
    "the reflog entries behind the pin are no longer excused inside this cause — a stale rebase entry anywhere in the reflog sends the finisher back to `rebase` and the commit past the pin goes unreported",
  );
});

test("the commit-past-the-pin report names the commit and whether it is pushed, unpushed, or unknown", () => {
  const text = causeText();
  // Pushed, unpushed, and unknown need different controller moves, so a report
  // shape that collapses any two of them is a report of a different cause.
  // Contiguous: the report verb, the cause's own name, and the three facts it
  // owes travel together, and splitting them lets a mutant keep the halt
  // while dropping what the halt is worth.
  assert.match(
    text,
    /Halt, name `commit past the pin`, and report \*\*the commit, and whether it is pushed, unpushed, or unknown\*\*/,
    "the report shape no longer owes all three facts — a halt naming the commit without saying pushed/unpushed/unknown leaves the controller unable to tell an unreviewed push from a commit no reviewer can even fetch, or from a check that never got an answer",
  );
  // Both commands, because "whether it is pushed" is only self-checkable if the
  // block says what to run. The remote read is `ls-remote`, not the PR object's
  // head: that field lags a ref move, which is why `run-merge-bot.md` refuses
  // to poll it, and a lagging read answers "unpushed" for a commit that is
  // already on the branch.
  assert.match(
    text,
    /`git log -1 --format='%h %s'` names it/,
    "the commit is no longer named by a command the finisher can run — a report shape that owes a SHA and a subject with no way to read them is a request, not an instruction",
  );
  assert.match(
    text,
    /`git ls-remote origin <branch>` answers the rest/,
    "the pushed read is gone or moved off `git ls-remote` — the PR object's head lags a ref move, so asking it reports an already-pushed commit as local-only",
  );
  // #997 finding: a FAILED `git ls-remote` (unreachable origin, non-zero exit)
  // used to read as "anything else" — the same shape as a genuinely absent
  // ref — which folds an unknown answer into "unpushed" and reports an
  // already-pushed commit as local-only. This is the unknown-answer-as-a-"no"
  // hole `release-ticket.sh` (1157-1179) and `reaping.md` (55) both forbid;
  // pinning that this bullet now matches them.
  assert.match(
    text,
    /a non-zero exit or any other failed read is \*\*unknown\*\*, never folded into "unpushed"/,
    "a failed `ls-remote` (unreachable origin, non-zero exit) no longer names a third, unknown answer — it reads as indistinguishable from a successful read finding no matching ref, reporting an unreachable-origin failure as 'unpushed'",
  );
  // The consequence, in all three directions. Without it the answers read as
  // trivia and the next reader deletes one of them as redundant.
  assert.match(
    text,
    /Only a successful read settles pushed vs not: equal to that commit means pushed, and a fresh finisher can audit it; a successful read that comes back without it means the commit exists only in that worktree, where no reviewer can reach it/,
    "the pushed/unpushed answers no longer say what each one means for the controller, or no longer require a successful read to reach either — the distinction survives as a fact nobody can act on, or a failed read can satisfy the unpushed branch again",
  );
});

test("the cause list is open — no count is asserted, and an unmatched cause is named rather than called unexplained", () => {
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
    /\b(two|three|four|five|\d+)\b(?:\s+\w+){0,3}\s+causes\b/i,
    "the lead-in asserts a fixed number of causes again — the enumeration is closed, and the cause that is not on the list reads as impossible to the finisher deriving it",
  );
  assert.match(
    lead,
    /not a closed list/,
    "the lead-in no longer says the list is open — silence there is the closed reading restored, since a list with no disclaimer is read as complete",
  );
  // Same widening, same reason: `which of \w+ things happened` only forbids a
  // single word between "of" and "things", so "which of the three things
  // happened" (two words: "the three") passed it clean — measured, mutate.py
  // M3.
  assert.doesNotMatch(
    text,
    /\b(two|three|four|five|\d+)\b(?:\s+\w+){0,3}\s+things\b/i,
    "the block the finisher reads counts the causes again — the count word inside the `>` block is the one that reaches the finisher verbatim",
  );
  assert.match(
    text,
    /`anything else` is a cause too, not a gap/,
    "the block no longer tells the finisher that an unmatched cause is still a cause — without it the fallback bullet reads as a note about incompleteness rather than an instruction",
  );

  // The fallback itself, and the report it forbids. `unexplained` is the exact
  // output the block exists to make unnecessary: it is the one verdict from
  // which waving the mismatch through is the cheapest next step.
  assert.match(
    text,
    /\*\*Anything else\.\*\*/,
    "the open-ended cause is gone — a fourth shape now has no bullet at all, which is the state #997 was filed from",
  );
  assert.match(
    text,
    /not a licence to report the mismatch as unexplained/,
    "the fallback no longer forbids the unexplained report — an open list whose escape hatch is 'unexplained' is the closed list with extra words",
  );
  assert.match(
    text,
    /name what you did find: both `git status --porcelain -unormal` samples, the `git reflog` line at the move, and both SHAs/,
    "the fallback no longer says what to put in the report — 'name whatever you find' with no named evidence is the bare \"head moved\" this block already rejects",
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

test("the head-equality short-circuit compares against the dispatch pin, on a clean tree", () => {
  const text = causeText();
  // The short-circuit exists to stop finishers adjudicating a reflog that
  // head-equality had already settled. WHICH head it compares to is the whole
  // rule: this block is ENTERED on a mismatch against the dispatch pin, so a
  // comparison against `PR headRefOid` answers a different question — "is the
  // local tree in sync with the pushed tip?" — and a member that kept working
  // and pushed after the pin passes it while holding commits no reviewer read.
  // ONE contiguous span, not two matches: the operand and the clean-tree scope
  // have to stay joined, since either half alone is satisfiable by the broken
  // form.
  assert.match(
    text,
    /head-equality first: `worktree HEAD == the SHA you were dispatched against` on a clean tree settles it\./,
    "the head-equality short-circuit no longer reads as pin-equality scoped to a clean tree — either the operand moved off the dispatch pin, or the clean-tree scope was dropped",
  );
  // The superseded operand, verbatim. `headRefOid` still appears in the block
  // as the SECOND, separate read (pushed vs unpushed), so only this exact
  // equality can be excluded here, not the identifier.
  assert.doesNotMatch(
    text,
    /`worktree HEAD == PR headRefOid`/,
    "the short-circuit is back to comparing the worktree head to the pushed branch tip — a member that pushed after the pin reads as 'settled' and gets labelled over commits no reviewer saw",
  );
  // The clean-tree scope is what keeps the live-editor cause reachable at all:
  // a dirty tree is never settled by the short-circuit, and the bullet opens
  // directly on the dirty read with no head predicate to fail. Contiguous, so
  // splicing a head condition in front of that read reds this — the loose
  // `git status --porcelain.*dirty` pin above walks straight through it.
  assert.match(
    text,
    /\*\*Live editor\.\*\* `git status --porcelain -unormal` is dirty\./,
    "the live-editor cause is no longer keyed on a dirty tree alone — a head predicate in front of the dirty read strands the mid-mutation case with no named cause",
  );
});

test("the pre-existing ruling-owed gate for the fix-applier is untouched", () => {
  // ACCEPT side: this run's edit sits right next to the fix-applier dispatch
  // paragraph. This pins that the older, unrelated rule wasn't clipped or
  // reworded by mistake while adding the new one beside it.
  assert.match(
    RUN_TEAM,
    /Never dispatch\s*\n?one while you still owe the fix-applier a ruling/,
    "the fix-applier ruling-owed gate no longer reads as before — check it wasn't altered while adding the specialist-relay gate nearby",
  );
});
