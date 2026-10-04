// reaping.md's release section names what authorizes release-ticket.sh's
// `git update-ref -d`, ending "and by nothing else". The script halts the
// delete on a fourth thing too: a fresh worktree check (`wt_holding`) re-read
// right before it, which stopped a delete on its own when a worktree took the
// branch inside the window between the checks and the delete. A list that
// closes with "by nothing else" while omitting it is false as written.
//
// Kept apart from reaping-prose.test.mjs, which pins the dirty-check and
// `worktree remove` claims of the same section: this one pins the
// authorizer list only, so the two files can be edited independently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const REAPING = readFileSync(
  join(REPO, "skills", "run-team", "references", "reaping.md"),
  "utf8",
);
const SCRIPT = readFileSync(join(REPO, "scripts", "release-ticket.sh"), "utf8");

const releaseSection = () =>
  between(
    REAPING,
    "## Why reap declines a claim that was never dispatched",
    "## Never reap a branch a live member is on",
    "reaping.md",
  );

// The sentence that lists the authorizers: from "authorized by" to the
// "and by nothing else" that closes it.
const authorizers = () =>
  between(
    releaseSection(),
    "authorized by the `ahead` and `git cherry` checks above",
    "and by nothing else",
    "reaping.md's release section",
  );

test("reaping.md: the release delete's authorizer list names the fresh worktree-holds-branch check", () => {
  // ONE contiguous span, not keywords: "fresh" and the negation each
  // satisfied somewhere in the slice pass a clause with either one gutted
  // ("a check that no worktree holds the branch" has no freshness; "a fresh
  // check ... that a worktree holds the branch" has the opposite meaning).
  // Only a span binds the two to each other.
  assert.match(
    authorizers(),
    phrase("a fresh check, re-read immediately before the delete, that no worktree holds the branch"),
    "reaping.md's release section closes its list of what authorizes the `update-ref` delete with \"and by nothing else\" but no longer names the fresh worktree check — release-ticket.sh halts the delete when any worktree holds the branch, and that check alone stopped a delete in the race window",
  );
});

test("reaping.md: the authorizer list still carries the three checks it always named", () => {
  // Input the new assertion must ACCEPT: naming the worktree check must not
  // cost the list the checks it already had.
  const list = authorizers();
  assert.match(list, phrase("`ahead` and `git cherry` checks above"));
  assert.match(list, phrase("`ahead` recount re-run against `origin/main`"));
});

// release-ticket.sh's executable lines, comments and `echo` diagnostics
// dropped. The delete is logged by an `echo` that spells the command out in
// a form the real call does not take (the real call quotes its arguments),
// and the check's name recurs in comments: an indexOf over the raw text lands
// on either and reads as the code, so a real delete moved above the check, or
// the check commented out, stays green.
const liveLines = () => SCRIPT.split("\n").filter((l) => !/^\s*(?:#|echo\b)/.test(l));

// The one live line matching `re`. Exactly one: a first-hit search would
// bind the pin to whichever copy comes first.
const liveLineOf = (re, what) => {
  const hits = liveLines().flatMap((l, i) => (re.test(l) ? [i] : []));
  assert.equal(hits.length, 1, `release-ticket.sh: expected exactly one live line that ${what}, found ${hits.length}`);
  return hits[0];
};

test("release-ticket.sh: the worktree check the prose names sits before the delete", () => {
  // The prose names a check the script runs; pin that the script still does,
  // and runs it before the delete, so the prose cannot outlive the check.
  const check = liveLineOf(/^\s*if\s+wt_holding\s+"refs\/heads\/\$branch"/, 'runs wt_holding on the branch');
  const del = liveLineOf(/\bgit\s+update-ref\s+-d\s+"refs\/heads\/\$branch"\s+"\$tip"/, 'runs `git update-ref -d` on the branch at its tip');
  assert.ok(check < del, "release-ticket.sh runs its worktree check after the delete, not before it");
});
