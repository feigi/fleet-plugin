// release-ticket.sh's comment above its branch delete contrasts the release's
// pairing (the `ahead` and `git cherry` guards, the recount at the delete, the
// fresh worktree check) with reap.sh's. It said reap.sh authorizes its own
// [gone] deletes with `git cherry` ALONE, but reap.sh also re-reads the
// worktree listing and keeps any branch `wt_holding` reports held or cannot
// resolve, before the same kind of compare-and-swap delete. What reap.sh does
// lack is the `ahead` count and the recount: `git cherry` is the only check
// there that asks whether the branch is merged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phrase, runAbove, stripHashGutter } from "./prose-pin.mjs";

const RELEASE = readFileSync(join(import.meta.dirname, "release-ticket.sh"), "utf8");
// reap.sh's code lines only: a whole-line `#` comment that mentions a command
// is neither a call nor a guard, so it must satisfy no check below and fail none.
const REAP = readFileSync(join(import.meta.dirname, "reap.sh"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const deleteComment = () => {
  const comment = stripHashGutter(
    runAbove(RELEASE, 'echo "\\$ git update-ref -d refs/heads/$branch $tip" >&2', "release-ticket.sh branch delete", "#"),
  );
  // runAbove returns "" rather than throwing when no comment run sits directly
  // above the anchor; without this the negative pin would pass on nothing.
  assert.notEqual(comment, "", "no comment run sits directly above release-ticket.sh's branch delete — the pins have nothing to read");
  return comment;
};

test("release-ticket.sh: the delete comment does not say reap.sh deletes on `git cherry` alone", () => {
  assert.doesNotMatch(
    deleteComment(),
    new RegExp(phrase("deletes with `git cherry` alone").source, "i"),
    "release-ticket.sh's delete comment says reap.sh authorizes its [gone] deletes with `git cherry` alone — reap.sh also re-checks the worktree with `wt_holding` before its delete",
  );
});

test("release-ticket.sh: the delete comment still says how reap.sh's pairing differs", () => {
  // Input the pin above must ACCEPT: the contrast the sentence exists for —
  // reap.sh has no `ahead` count and no recount — survives, beside the
  // worktree check reap.sh shares with the release.
  const comment = deleteComment();
  assert.match(comment, phrase("with `git cherry` alone — no `ahead` count, no recount"));
  assert.match(comment, phrase("re-checks the worktree with `wt_holding`"));
});

test("reap.sh: the branch delete still follows a `wt_holding` check and has no `ahead` recount", () => {
  // The target side of the comment's claim, so a change to reap.sh that makes
  // it false reds here rather than leaving release-ticket.sh's prose stale.
  const held = REAP.indexOf('if wt_holding "refs/heads/$b"');
  const del = REAP.indexOf('git update-ref --no-deref -d "refs/heads/$b" "$tip"');
  assert.ok(held !== -1, "reap.sh no longer checks `wt_holding` on the [gone] branch");
  assert.ok(del !== -1, "reap.sh no longer deletes the [gone] branch with a compare-and-swap `update-ref -d`");
  assert.ok(held < del, "reap.sh's `wt_holding` check no longer runs before its branch delete");
  assert.doesNotMatch(
    REAP,
    /rev-list\b[^\n]*--count|--count[^\n]*rev-list/,
    "reap.sh now counts commits ahead — release-ticket.sh's comment says it has no `ahead` count",
  );
});
