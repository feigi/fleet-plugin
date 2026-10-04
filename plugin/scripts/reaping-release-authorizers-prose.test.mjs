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
  assert.match(
    authorizers(),
    /(?:fresh|re-read|recheck|re-check)[^.]{0,160}worktree[^.]{0,80}holds?\s+the\s+branch|no\s+worktree\s+holds\s+the\s+branch/,
    "reaping.md's release section closes its list of what authorizes the `update-ref` delete with \"and by nothing else\" but no longer names the worktree check — release-ticket.sh halts the delete when any worktree holds the branch, and that check alone stopped a delete in the race window",
  );
});

test("reaping.md: the authorizer list still carries the three checks it always named", () => {
  // Input the new assertion must ACCEPT: naming the worktree check must not
  // cost the list the checks it already had.
  const list = authorizers();
  assert.match(list, phrase("`ahead` and `git cherry` checks above"));
  assert.match(list, phrase("`ahead` recount re-run against `origin/main`"));
});

test("release-ticket.sh: the worktree check the prose names sits before the delete", () => {
  // The prose names a check the script runs; pin that the script still does,
  // and runs it before the delete, so the prose cannot outlive the check.
  const check = SCRIPT.indexOf('wt_holding "refs/heads/$branch"');
  const del = SCRIPT.indexOf('git update-ref -d refs/heads/$branch $tip');
  assert.notEqual(check, -1, "release-ticket.sh no longer runs wt_holding on the branch");
  assert.notEqual(del, -1, "release-ticket.sh no longer runs `git update-ref -d` on the branch");
  assert.ok(check < del, "release-ticket.sh runs its worktree check after the delete, not before it");
});
