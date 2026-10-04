// reaping.md's reap section said reap.sh's `git update-ref -d` is
// "authorized by that cherry check and only by it". The script halts the
// delete on a second thing too: a fresh worktree check (`wt_holding`) over a
// listing re-read right before it, which keeps a `[gone]` branch the cherry
// check cleared whenever a worktree holds it or cannot be resolved. A sentence
// naming the cherry check as the only authorizer is false as written.
//
// The reap-side twin of reaping-release-authorizers-prose.test.mjs, which pins
// the release section's authorizer list. Kept apart so each section's pin can
// be edited independently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, bullet, phrase, unemphasized } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const REAPING = readFileSync(
  join(REPO, "skills", "run-team", "references", "reaping.md"),
  "utf8",
);
const SCRIPT = readFileSync(join(REPO, "scripts", "reap.sh"), "utf8");

const reapSection = () =>
  between(
    REAPING,
    "## Why the reap is shaped the way it is",
    "## Why a second sweep, over worktrees rather than branches",
    "reaping.md",
  );

// The bullet that names the delete, bounded to its own list item: it ends at
// the next list marker, so a sibling bullet (the holder-check bullet sits
// right after it) cannot supply the words, and rewording that sibling does
// not move the bound.
const deleteBullet = () =>
  bullet(
    reapSection(),
    "- **The delete is `git update-ref -d`'s compare-and-swap",
    "\n- ",
    "reaping.md's reap section",
  );

// The clause that lists the authorizers: from "authorized by" to the
// sentence after the bold lead, which explains the compare-and-swap. Sliced
// emphasis-tolerantly, and every assertion below reads it through
// `unemphasized()`, so a `**` moved onto or into the clause stays green: the
// slice only locates the clause, and `phrase()` is matched against raw text.
const authorizers = () =>
  between(
    deleteBullet(),
    "authorized by that cherry check",
    "Tip read before the cherry",
    "reaping.md's reap delete bullet",
    { emphasisTolerant: true },
  );

test("reaping.md: the reap delete's authorizer clause names the fresh worktree-holds-branch check", () => {
  // ONE contiguous span, not keywords: "fresh" and the negation each
  // satisfied somewhere in the slice pass a clause with either one gutted
  // ("a check that no worktree holds the branch" has no freshness; "a fresh
  // check ... that a worktree holds the branch" has the opposite meaning).
  // Only a span binds the two to each other.
  assert.match(
    unemphasized(authorizers()),
    phrase("a fresh check, re-read immediately before the delete, that no worktree holds the branch"),
    "reaping.md's reap section names what authorizes the `update-ref` delete but not the fresh worktree check — reap.sh keeps a branch the cherry check cleared whenever a worktree holds it",
  );
});

test("reaping.md: the reap delete's authorizer clause does not make any one check the only authorizer", () => {
  // The exclusivity the defect carried, in the spellings of it a reword can
  // restore after the new words: "only by it", "only by them", "nothing
  // else", "solely", "alone". Pinned on its own because the presence pin
  // above stays green with any of them restored. A word list, so a spelling
  // outside it goes unseen; `\s+` keeps a reflow between its words green.
  assert.doesNotMatch(
    unemphasized(authorizers()),
    /\bonly\s+by\b|\bnothing\s+else\b|\bsolely\b|\balone\b/,
    "reaping.md's reap section says one check alone authorizes the `update-ref` delete — reap.sh's worktree check stops that delete too",
  );
});

test("reaping.md: the reap delete's authorizer clause still names the cherry check", () => {
  // Input the new assertions must ACCEPT: naming the worktree check must not
  // cost the clause the check it already had.
  assert.match(unemphasized(deleteBullet()), phrase("authorized by that cherry check"));
});

// reap.sh's executable lines, comments and `echo` diagnostics dropped. The
// check's name and the delete command both recur in comments: an indexOf over
// the raw text lands on either and reads as the code, so a real delete moved
// above the check, or the check commented out, stays green. Only whole-line
// comments drop here, so each pattern below is anchored at the start of its
// statement: a command spelled after a `#` inside a live line is not live.
const liveLines = () => SCRIPT.split("\n").filter((l) => !/^\s*(?:#|echo\b)/.test(l));

// The one live line matching `re`. Exactly one: a first-hit search would
// bind the pin to whichever copy comes first.
const liveLineOf = (re, what) => {
  const hits = liveLines().flatMap((l, i) => (re.test(l) ? [i] : []));
  assert.equal(hits.length, 1, `reap.sh: expected exactly one live line that ${what}, found ${hits.length}`);
  return hits[0];
};

test("reap.sh: the worktree check the prose names sits before the delete", () => {
  // The prose names a check the script runs; pin that the script still does,
  // and runs it before the delete, so the prose cannot outlive the check.
  const check = liveLineOf(/^\s*if\s+wt_holding\s+"refs\/heads\/\$b"/, "runs wt_holding on the branch");
  const del = liveLineOf(/^\s*if\s+!\s+err=\$\(git\s+update-ref\s+--no-deref\s+-d\s+"refs\/heads\/\$b"\s+"\$tip"/, "runs `git update-ref -d` on the branch at its tip");
  assert.ok(check < del, "reap.sh runs its worktree check after the delete, not before it");
});
