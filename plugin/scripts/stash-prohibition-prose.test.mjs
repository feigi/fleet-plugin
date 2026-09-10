// #1148. The git stash stack is a property of the REPOSITORY, not of a
// worktree or a session: every fleet worktree, the main checkout, and every
// concurrent member share the one `refs/stash`. A bare `git stash pop` takes
// whichever entry is on top regardless of which worktree pushed it — silently
// (rc 0) when the receiving tree is clean on the affected paths, which is
// exactly when a victim would assume it is safe, and loudly (rc 1) only when
// that tree is already dirty there. A bare `git stash` (push) does NOT reach
// into a sibling's tree — that half is unfounded, measured separately in the
// ticket's Agent Brief — so the hazard is entirely on the pop side.
//
// Before this ticket the prohibition lived only in the controller's own
// never-force-a-rebase guard (SKILL.md's "Never force a rebase to start", the
// `git stash` mention run-merge-bot-prose.test.mjs and no-undo-audit.test.mjs
// already pin) and in member-lifecycle.md's refill-recovery checklist. Neither
// reaches the members who actually reach for `git stash` in practice —
// implementers and fix-appliers isolating a mutation-testing pass — because
// neither is copied into a dispatch prompt. This file pins the two new
// paragraphs that close that gap: one in phase 2's implementer block, beside
// the commit-incrementally rule it extends, one in the Reviewers section's
// fix-applier block, beside the commit-before-you-mutate rule it extends.
//
// Measured against this tree before either paragraph existed (i.e. against
// `origin/main`): neither `skills/run-team/SKILL.md`'s phase-2 member prompt
// nor its fix-applier prompt mentioned `git stash` at all —
// `awk 'NR==849,NR==955' skills/run-team/SKILL.md | grep -i stash` and
// `awk 'NR==1483,NR==1642' skills/run-team/SKILL.md | grep -i stash` both hit
// nothing. No test in `*prose*.test.mjs` mentioned `WIP commit` either. This
// file's two anchors are unique file-wide (verified: each of
// "**Never `git stash` or `git stash pop` to shelve" and
// "**Never `git stash` or `git stash pop` here either" occurs exactly once),
// so each block is sliced directly with `between()`, without first narrowing
// through a parent section the way files whose anchor text repeats have to.
//
// SHAPE, matching this suite's convention (`dispatch-block-pins-prose.test.mjs`
// header): each block is its OWN slice, bounded by the neighbouring block's
// opening words on both ends, and a fact that lives in the JOIN between two
// clauses — the pop's silence on a clean tree paired with its refusal on a
// dirty one — is pinned as ONE contiguous span, never two independent
// presence checks that a swap of "clean" and "dirty" between the clauses
// could satisfy separately (`finisher-pin-race-prose.test.mjs`'s "exception
// clause splice" rule: N independent matches pin N facts, never the relation
// between them).
//
// MUTATION-VERIFIED both ways on an isolated scratch copy of this tree
// (method: `dispatch-block-pins-prose.test.mjs`'s own comment, and the
// project's own prose-pin discipline — copy, mutate, run, restore). All four
// mutations below were run against both the implementer AND the fix-applier
// block, independently, restoring the clean file between each:
//   - Deleting either new paragraph outright (the whole `> **Never \`git
//     stash\`...` through the sentence before the next block's opener) reds
//     every test below that reads that block, via `between()`'s own "no
//     longer contains" throw — 6 of this file's 12 tests (5 pins + the
//     block's own rewrap check), 0 elsewhere in this file or in
//     `dispatch-block-pins-prose.test.mjs` / `fix-applier-correction-rules-
//     prose.test.mjs` (their anchors are untouched by this deletion).
//   - Swapping the substitute back out for a bare stash mention — rewriting
//     "take a WIP commit instead: `git commit -m wip`, then amend it or
//     `git reset --soft HEAD^` once you have something real to commit." to
//     "stash it instead: `git stash push -u -m wip`, then `git stash pop`
//     once you are ready to make a real commit." (prohibition wording left
//     intact, so the block's own `between()` anchor still resolves) — reds
//     exactly 2 of 12: the mutated block's "names a WIP commit as the
//     substitute" test and its own rewrap check. The other 10, including
//     that same pair in the untouched block, stay green, because they pin
//     the mechanism paragraph the substitution never touches. This is the
//     correct discrimination: the substitute-naming test is the one whose
//     whole job is catching this mutation, not a side effect of a looser one.
//   - Swapping "clean"/"dirty" between the two halves of the pop-mechanism
//     sentence (silent-when-dirty / refuses-when-clean, the inverted claim)
//     also reds exactly 2 of 12 — the mutated block's single-span
//     pop-mechanism test and its rewrap check — because the contiguous
//     phrase no longer occurs verbatim; two independent presence checks on
//     "clean" and "dirty" separately would NOT have caught this, since both
//     words remain present somewhere in the slice.
//   - The two `rewrapped …` tests below are the accept-side control: on the
//     unmutated file both pass, proving the pins hold the words, not today's
//     line breaks.
//
// THE CEILING, same as every file in this directory: these are pins on text
// being PRESENT and adjacent. A sentence appended after a pinned span that
// carves an exception into it touches no pinned fragment and stays green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// `>` gutter and `**` emphasis stripped, whitespace collapsed — mirrors
// `dispatch-block-pins-prose.test.mjs`'s `flatten`, so a pin here survives the
// same rewrap/bold-move classes that file's does. Backticks are left alone:
// every pinned span below quotes real code (`` `git stash` ``, `` `refs/stash` ``)
// and no `**` occurs inside one of those spans (verified), so nothing here
// needs to learn about a backtick-wrapped `**`.
const flatten = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^\s*>?\s?/, ""))
    .join(" ")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();

// Bounded by the new rule's own opening words and the NEXT block's opening
// words — the same two-sided bound every block in `dispatch-block-pins-
// prose.test.mjs` uses, and for the same reason: an unbounded end lets the
// scratch-discipline block's own vocabulary ("scratch root", "sibling")
// satisfy an assertion with this block's real text gone.
const implementerStashBlock = () =>
  flatten(
    between(
      RUN_TEAM,
      "**Never `git stash` or `git stash pop` to shelve",
      "**Every scratch file",
      "phase 2's stash-prohibition block",
    ),
  );

const fixApplierStashBlock = () =>
  flatten(
    between(
      RUN_TEAM,
      "**Never `git stash` or `git stash pop` here either",
      "**Report LAST",
      "the fix-applier's stash-prohibition block",
    ),
  );

test("the implementer's stash rule forbids a bare stash/pop and names a WIP commit as the substitute", () => {
  const b = implementerStashBlock();
  assert.match(
    b,
    phrase(
      "Never `git stash` or `git stash pop` to shelve your own progress — take a WIP commit instead: `git commit -m wip`, then amend it or `git reset --soft HEAD^` once you have something real to commit.",
    ),
    "the implementer block no longer forbids a bare stash/pop with the WIP-commit substitute bound to it",
  );
});

test("the implementer's stash rule states the stack is repo-global, shared by every worktree and session", () => {
  const b = implementerStashBlock();
  assert.match(
    b,
    phrase(
      "The stash stack is repo-global, not per-worktree or per-session — the same `refs/stash` is shared by every worktree, the main checkout, and every concurrent member.",
    ),
    "the implementer block no longer states the stash stack is repo-global and shared by every worktree/session",
  );
});

// ONE contiguous span, not two presence checks — see the header's mutation
// note. Independent `clean` / `dirty` checks would both stay green under a
// swap of which state is silent and which refuses.
test("the implementer's stash rule binds the pop's silence on a clean tree to its refusal on a dirty one", () => {
  const b = implementerStashBlock();
  assert.match(
    b,
    phrase(
      "A bare pop takes whichever entry is on top, from any worktree, and it is silent about it — rc 0, no error — exactly when the tree receiving it is clean on the affected paths, which is the moment you would assume it is safe; it refuses loudly only when that tree is already dirty on them.",
    ),
    "the implementer block no longer binds the pop's clean-tree silence to its dirty-tree refusal in one span",
  );
});

test("the implementer's stash rule states a bare push does not reach into a sibling worktree", () => {
  const b = implementerStashBlock();
  assert.match(
    b,
    phrase(
      "A bare `git stash` (push) does not reach into a sibling worktree's uncommitted work — that half is unfounded, it acts on your own tree only — so the hazard is entirely on the pop side",
    ),
    "the implementer block no longer states that a bare stash push does not reach a sibling's tree",
  );
});

test("the implementer's stash rule says nothing partitions the stack, so the prohibition is the whole protection", () => {
  const b = implementerStashBlock();
  assert.match(
    b,
    phrase(
      "Nothing partitions the stack the way the scratch root below is partitioned — one `refs/stash` per repository, with no per-member address for it — so this prohibition is the whole of the protection, not a stopgap standing in for one.",
    ),
    "the implementer block no longer says nothing partitions the stack or drops the whole-protection close",
  );
});

test("the fix-applier's stash rule forbids a bare stash/pop and names a WIP commit as the substitute", () => {
  const b = fixApplierStashBlock();
  assert.match(
    b,
    phrase(
      "Never `git stash` or `git stash pop` here either — a WIP commit is the substitute, not a second scratch mechanism: `git commit -m wip`, then restore or amend once you're back to real work.",
    ),
    "the fix-applier block no longer forbids a bare stash/pop with the WIP-commit substitute bound to it",
  );
});

test("the fix-applier's stash rule states the stack is repo-global, shared by every worktree and session", () => {
  const b = fixApplierStashBlock();
  assert.match(
    b,
    phrase(
      "The stash stack is repo-global too, not per-worktree or per-session — the same `refs/stash` every concurrent member and the main checkout share, not partitioned the way `<scratch>/pr<N>/mutate/` above is.",
    ),
    "the fix-applier block no longer states the stash stack is repo-global and shared by every worktree/session",
  );
});

test("the fix-applier's stash rule binds the pop's silence on a clean tree to its refusal on a dirty one", () => {
  const b = fixApplierStashBlock();
  assert.match(
    b,
    phrase(
      "A bare pop takes whichever entry is on top, from any worktree, silently — rc 0, no error — when the tree receiving it is clean on the affected paths, and refuses only when that tree is already dirty there.",
    ),
    "the fix-applier block no longer binds the pop's clean-tree silence to its dirty-tree refusal in one span",
  );
});

test("the fix-applier's stash rule states a bare push does not reach into a sibling's tree", () => {
  const b = fixApplierStashBlock();
  assert.match(
    b,
    phrase(
      "A bare `git stash` (push) does not reach into a sibling's tree, so that half is not the risk — the pop is.",
    ),
    "the fix-applier block no longer states that a bare stash push does not reach a sibling's tree",
  );
});

test("the fix-applier's stash rule says nothing partitions the stack, so the prohibition is the whole protection", () => {
  const b = fixApplierStashBlock();
  assert.match(
    b,
    phrase("Nothing partitions the stack; this prohibition is the whole of the protection."),
    "the fix-applier block no longer says nothing partitions the stack or drops the whole-protection close",
  );
});

// ACCEPT side, mirroring `dispatch-block-pins-prose.test.mjs`'s own rewrap
// test: re-wrapping either paragraph at a column width nothing here assumes
// must not red a single assertion above. The fixture is DERIVED from the live
// block, never a quoted line, so a future reword of the surrounding prose is
// not what this test measures. Flattening `narrow` directly (rather than
// splicing it back into RUN_TEAM and re-locating it with `between()`) sidesteps
// a real bug the first draft of this helper hit: this block's own opening
// anchor is 9 words / ~50 characters, longer than the 45-character rewrap
// width, so a `between()` search for it against the SPLICED file broke across
// the very line break the rewrap introduced. `narrow` already IS the
// rewrapped block; there is nothing left to re-locate.
function assertSurvivesRewrap(startAnchor, endAnchor, what, assertions) {
  const raw = between(RUN_TEAM, startAnchor, endAnchor, what);
  const body = raw.replace(/\n*>?\s*$/, "");
  const words = body.replace(/\n>\s?/g, " ").split(/\s+/).filter(Boolean);
  const lines = words.reduce((acc, w) => {
    const last = acc[acc.length - 1];
    if (last && `${last} ${w}`.length <= 45) acc[acc.length - 1] = `${last} ${w}`;
    else acc.push(w);
    return acc;
  }, []);
  const narrow = lines.join("\n> ");
  assert.notEqual(narrow, raw, `${what}: the rewrap fixture no longer changes the block's wrapping — update it`);
  const rewrapped = flatten(narrow);
  for (const a of assertions) assert.match(rewrapped, a);
}

test("a rewrapped implementer stash block still matches every pin above — these pins refuse drift, not reflow", () => {
  assertSurvivesRewrap(
    "**Never `git stash` or `git stash pop` to shelve",
    "**Every scratch file",
    "phase 2's stash-prohibition block",
    [
      phrase("Never `git stash` or `git stash pop` to shelve your own progress — take a WIP commit instead"),
      phrase("The stash stack is repo-global, not per-worktree or per-session"),
      phrase("it refuses loudly only when that tree is already dirty on them"),
      phrase("Nothing partitions the stack the way the scratch root below is partitioned"),
    ],
  );
});

test("a rewrapped fix-applier stash block still matches every pin above — these pins refuse drift, not reflow", () => {
  assertSurvivesRewrap(
    "**Never `git stash` or `git stash pop` here either",
    "**Report LAST",
    "the fix-applier's stash-prohibition block",
    [
      phrase("Never `git stash` or `git stash pop` here either — a WIP commit is the substitute"),
      phrase("The stash stack is repo-global too, not per-worktree or per-session"),
      phrase("refuses only when that tree is already dirty there"),
      phrase("Nothing partitions the stack; this prohibition is the whole of the protection"),
    ],
  );
});
