// #400. Phase 2 hands the controller a run of `>` blocks and says to carry each
// one VERBATIM into every implementer prompt. Those blocks are not prose about
// the fleet — they are the only text a member ever sees, so a block that goes
// missing does not misinform the member, it silently stops governing it.
//
// Measured against `origin/main` before this file existed: deleting the
// enumerate-the-class block outright left the suite green, and no test file
// mentioned `Commit incrementally` at all. `member-prompt-prose.test.mjs` pins
// the identity block and the two `next-ticket` step handoffs;
// `tracker-block-copy-prose.test.mjs` pins the issue-read block by comparing it
// whole against `docs/agents/issue-tracker.md`. This file covers the blocks
// between those, and adds a content pin to the issue-read block for the one
// case the copy comparison cannot see: an identical gutting of BOTH files
// agrees with itself and passes there.
//
// SHAPE, and the thing to preserve when editing these tests. A positive regex
// over the whole member-prompt region is a vacuous pin — every word of every
// block is somewhere in it, so the assertion passes with the block it names
// deleted. Two things do the work instead:
//
//   1. Each block gets its OWN slice, bounded at both ends by the neighbouring
//      block's opening words. Slice size is what anchors a prose pin; assertion
//      count over a large slice does not.
//   2. Each pinned fragment is bound to the content beside it, never asserted
//      alone. Independent presence checks pin N facts and never the relation
//      between them: two such checks on `**step 6**` and `**step 7**` stayed
//      green through a swap of the two numbers, which told a member to open its
//      PR at the sizing checkpoint. So a rule is pinned together with the
//      command that carries it out, and an instruction together with the
//      alternative it excludes — a swap then reds where presence would not.
//
// A word blacklist was tried for this and rejected on measurement, so do not
// reach for one when this file next feels too loose: `doesNotMatch(/\bunless\b|
// \bexcept\b/i)` scoped to a pinned sentence does not kill its own mutant,
// broadened enough to kill it four trivial rewordings preserve the defect and
// stay green, and it reddens on a legitimate edit this repo is likely to make —
// a standing rule containing the word "unless" is exactly the kind of text that
// belongs in a verbatim block.
//
// THE CEILING, and it is the same one `member-prompt-prose.test.mjs` records:
// these are pins on text being PRESENT and adjacent. A sentence APPENDED inside
// a block that carves an exception out of a pinned rule touches no pinned
// fragment and stays green. Closing that half needs a mechanism other than a
// regex — an LLM judge over the instruction file, or a schema'd rule format —
// and is tracked separately. Do not read a green run here as "no exception
// could have been added to these blocks".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

const START = "and each of these verbatim:";
const END = "Each rule in the enumerate-and-declare block";

// Scoped to the member-prompt region first, for the reason `indexOf` demands
// it: "You are ALREADY in worktree" also opens the fix-applier prompt further
// down the file, and a file-wide anchor would silently pin that one instead.
function region() {
  const at = RUN_TEAM.indexOf(START);
  assert.notEqual(at, -1, `phase 2's verbatim-blocks intro ('${START}') moved — update this test`);
  const end = RUN_TEAM.indexOf(END, at);
  assert.notEqual(end, -1, `the rationale anchor ('${END}') moved — update this test`);
  return RUN_TEAM.slice(at + START.length, end);
}

// Quote markers are stripped and whitespace collapsed before matching, so a
// pinned span may cross a `>` gutter and a rewrap is not a failure. `phrase()`
// alone cannot do this: its `\s+` joins do not span a `>`, so every multi-line
// pin here would red on the wrap points rather than on the meaning.
const flatten = (s) => s.split("\n").map((l) => l.replace(/^>\s?/, "")).join(" ").split(/\s+/).join(" ").trim();

// Each block is bounded by the opening words of the block that follows it, so a
// block deleted outright reds on its own anchor and names itself. A closing
// phrase would anchor on today's last sentence instead, leaving anything
// appended after it outside the slice entirely.
const block = (from, to, what) => flatten(between(region(), from, to, what));

const worktreeBlock = () => block("You are ALREADY in worktree", "Read the issue with", "phase 2's worktree block");
const issueReadBlock = () => block("Read the issue with", "**Re-derive the ticket", "phase 2's issue-read block");
const rederiveBlock = () => block("**Re-derive the ticket", "Commit incrementally", "phase 2's re-derive block");
const commitBlock = () => block("Commit incrementally", "Your ticket names the cases", "phase 2's commit-incrementally block");
const enumerateBlock = () => block("Your ticket names the cases", "Run `sizing-a-ticket`", "phase 2's enumerate-the-class block");

test("the worktree block forbids a second worktree and carries the check that settles it", () => {
  const b = worktreeBlock();
  // Prohibition bound to the command that verifies it. Alone, "Do NOT create
  // another worktree" is an instruction a member cannot act on: what it needs
  // is the pair of `rev-parse` calls that tell it where it already is.
  assert.match(
    b,
    phrase("Do NOT create another worktree. Verify with `git rev-parse --git-dir` and `git rev-parse --git-common-dir`"),
    "the no-second-worktree rule is no longer carried with the rev-parse check that settles it",
  );
  assert.match(
    b,
    phrase("Skip the using-git-worktrees skill's Step 1"),
    "the block no longer names which step of using-git-worktrees the member skips",
  );
});

test("the issue-read block carries the command, the caveat that motivates it, and which text wins", () => {
  const b = issueReadBlock();
  // The `--json` form bound to the fields it must request. `gh issue view <N>`
  // on its own is satisfied by the very invocation the next sentence forbids.
  assert.match(
    b,
    phrase("Read the issue with `gh issue view <N> --json title,body,comments"),
    "the issue-read command no longer requests title, body and comments together",
  );
  // The caveat bound to its consequence. The defect is silent — exit 0 — so the
  // reason is the load-bearing half: a member told only "not `--comments`" has
  // no way to recognise the failure when it sees it.
  assert.match(
    b,
    /`gh issue view <N> --comments`.{0,200}?so the loss is silent/,
    "the bare --comments caveat is no longer bound to the silent-loss consequence it exists to explain",
  );
  // The precedence rule, and the direction it runs in. Asserting the two nouns
  // separately would pass with the precedence reversed.
  assert.match(
    b,
    phrase("The `## Agent Brief` comment is authoritative over the issue body"),
    "the block no longer says the Agent Brief outranks the issue body, or now says the reverse",
  );
});

test("the re-derive block names origin/main as the reference, and says a contradicted criterion is a bail", () => {
  const b = rederiveBlock();
  // Reference bound to the alternatives it excludes. `origin/main` present
  // anywhere in the block satisfies a bare presence check even after the
  // sentence has been rewritten to send the member at its own working tree.
  assert.match(
    b,
    phrase("against `origin/main` before implementing** — not the working tree, and not the ticket's line numbers"),
    "re-derivation is no longer pinned to origin/main against the working tree and the ticket's line numbers",
  );
  assert.match(
    b,
    phrase("Already fixed → report that with the commit and do NOT invent work"),
    "the already-fixed exit no longer tells the member to report the commit instead of inventing work",
  );
  // Bail bound to its trigger, and to the thing it is NOT. Swapping the two
  // halves — "is a thing to implement, not a bail" — is the reading that turns
  // a stale ticket into a shipped regression, and it reds here.
  assert.match(
    b,
    phrase("is a bail, not a thing to implement"),
    "a criterion the tree contradicts no longer reads as a bail, or now reads as a thing to implement",
  );
});

test("the commit-incrementally block carries the instruction with the loss that justifies it", () => {
  const b = commitBlock();
  assert.match(
    b,
    phrase("Commit incrementally as you go. Do not accumulate a large uncommitted diff"),
    "the commit-incrementally instruction is no longer carried verbatim to the member",
  );
  // The reason, bound to the instruction by the slice being this one paragraph.
  // `SKILL.md` calls this block not optional because a member that goes idle
  // leaves a diff the controller can neither see nor reap; a member told to
  // commit often, with no reason, treats it as style.
  assert.match(
    b,
    phrase("uncommitted work is invisible to the controller and effectively unrecoverable"),
    "the block no longer says why incremental commits are not optional — the stall consequence is gone",
  );
});

test("the enumerate-the-class block carries all three of its halves, each with its own instruction", () => {
  const b = enumerateBlock();
  // Half one: enumerating bound to declaring. Enumerating privately and fixing
  // the named cases is the exact failure the block exists to stop, and it
  // satisfies a pin on "enumerate" alone.
  assert.match(
    b,
    /enumerate every member of that class.{0,120}?say which you cover and which you deliberately leave/,
    "enumerating the class is no longer bound to declaring what is covered and what is left",
  );
  // The ordering, as one span: prose FIRST, mechanism second. Two independent
  // presence checks pass with the two sources swapped, which is precisely the
  // enumeration order that missed a case its own ticket named in passing.
  assert.match(
    b,
    phrase("Build that list from **the ticket's own prose first**, then from the mechanism"),
    "the enumeration order no longer runs from the ticket's prose to the mechanism",
  );
  // Half two: the false-positive question bound to the test it demands. The
  // question alone is answerable on paper; the test is what makes it evidence.
  assert.match(
    b,
    /what can this change wrongly REFUSE\?.{0,300}?leave one test behind that feeds it input it must ACCEPT/,
    "the wrongly-REFUSE half no longer asks for a test feeding input the change must accept",
  );
  // Half three, and the one most easily read as a restatement of half one: it
  // is about the EDIT, not the bug class. Bound to the instruction that makes
  // it actionable, or it degenerates into advice.
  assert.match(
    b,
    phrase("The third is about YOUR EDIT: enumerate what your change newly does"),
    "the third half no longer distinguishes the edit's own effects from the bug class",
  );
  assert.match(
    b,
    phrase("Ask which of the ticket's own acceptance criteria your restructuring could newly violate, and test that path"),
    "the third half no longer names the acceptance criteria a restructuring can newly violate",
  );
  // The closing rule, bound to what a green suite does and does not prove.
  assert.match(
    b,
    /check the suite can even see the mode you changed.{0,400}?A green suite is evidence only about the paths it exercises/,
    "the suite-visibility rule is no longer bound to what a green suite is evidence of",
  );
});

test("a rewrapped block still matches — these pins refuse drift, not reflow", () => {
  // The ACCEPT side, and the only thing holding `flatten` open: a suite of
  // already-matching inputs passes with the normalization deleted. Re-wrapping
  // a paragraph is not drift, and a pin that reddened on it would be deleted by
  // the next person who reflowed this file.
  const target = "> Commit incrementally as you go. Do not accumulate a large uncommitted diff — if";
  assert.ok(RUN_TEAM.includes(target), "the rewrap fixture no longer matches the commit block — update it");
  const rewrapped = RUN_TEAM.replace(target, "> Commit incrementally as you go. Do not accumulate a large\n> uncommitted diff — if");
  const flat = flatten(between(rewrapped.slice(rewrapped.indexOf(START)), "Commit incrementally", "Your ticket names the cases", "rewrapped commit block"));
  assert.match(flat, phrase("Commit incrementally as you go. Do not accumulate a large uncommitted diff"));
});
