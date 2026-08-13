// Pins the #170 addition to run-merge-bot.md's step 4: dropping `in-progress`
// from every issue a merged PR closes. Same discipline as
// issue-tracker-prose.test.mjs — a positive match on a whole file is a
// vacuous pin, so this slices to step 4 alone before asserting.
//
// THE CEILING: this proves the phrase is PRESENT in step 4. It cannot prove
// the rule is not negated by a sentence added beside it, and it does not run
// the step — drop-merged-label.test.mjs owns the script's own behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const DOC = readFileSync(join(REPO, "skills", "fleet", "commands", "run-merge-bot.md"), "utf8");

// Bounded to step 4 alone: unbounded to EOF the slice runs through staleness,
// the no-undo audit and the watcher loop, and a mention of `in-progress`
// anywhere in those would satisfy the assertions with step 4 itself untouched.
function step4() {
  const start = "4. `gh pr merge <pr> --merge`";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("**Staleness fires");
  assert.notEqual(end, -1, "step 4's end marker moved — update this test");
  return start + rest.slice(0, end);
}

test("step 4 drops in-progress from every issue the merged PR closes", () => {
  assert.match(step4(), /Drop `in-progress` from every issue this PR closes/);
  assert.match(step4(), /drop-merged-label\.sh <pr> --apply/);
});

test("step 4 says a failed removal must be reported, never swallowed", () => {
  assert.match(step4(), /a removal failed — report it as `label-drop-failed-#<issue>`, never swallow it/);
});

test("the drop runs only after the merge is confirmed, never before", () => {
  assert.match(step4(), /call this only after the merge is confirmed/);
});

// #303: on `unknown` the runbook used to send the operator to `git stash list`
// alone, which is empty at rc 0 in two of the three states that produce
// `unknown` (measured: `chmod 000` on `refs/stash`, and on `logs/refs/stash`).
// Sliced to the audit section, same discipline as step4(): it pins the text to
// the section that has to carry it, so a later paragraph naming `refs/stash`
// somewhere else in the doc can never stand in for this one.
function noUndoAudit() {
  const start = "## No-undo audit (before every rebase)";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("**4. Take `main`'s side wholesale");
  assert.notEqual(end, -1, "the audit section's end marker moved — update this test");
  return rest.slice(0, end);
}

// THE CEILING: presence of the instruction, not its correctness. The paths are
// pinned as written — `--git-common-dir`, not `.git/` — because a linked
// worktree's `.git` is a file and `.git/refs/stash` reaches nothing there.
test("the `unknown` path sends the operator to both stash files, via the common dir", () => {
  assert.match(noUndoAudit(), /On `unknown` do not stop at that list: two of its three causes leave it empty at rc 0/);
  assert.match(noUndoAudit(), /c=\$\(git rev-parse --git-common-dir\)/);
  assert.match(noUndoAudit(), /ls -l "\$c"\/refs\/stash "\$c"\/logs\/refs\/stash`/);
  assert.match(noUndoAudit(), /cat "\$c"\/logs\/refs\/stash`/);
});

// `----------` alone is under-inclusive: an unreadable logs/refs DIRECTORY
// (`chmod 000 .git/logs/refs`) produces the same `unknown`, but `ls` fails
// before it prints a mode column — `ls: .git/logs/refs/stash: Permission
// denied`, with `refs/stash` beside it at a healthy `-rw-r--r--`. Both halves
// of the tell are pinned, or the second silently rots back out.
test("the fault tell covers a Permission denied from `ls`, not only a `----------` mode", () => {
  assert.match(noUndoAudit(), /a mode of `----------` on either, or a `Permission denied` from `ls` itself, is the fault,/);
});

test("the `unknown` path warns that a missing refs/stash file is not an empty stash", () => {
  assert.match(noUndoAudit(), /A missing `refs\/stash` file is not an empty stash: `git gc` packs it into `packed-refs`/);
});

// #149: step 1 used to rebase locally and `git push --force-with-lease`,
// denied unpredictably by the auto-mode classifier — 2 allowed / 2 denied on
// byte-identical invocations in one session — sometimes stranding a rebased
// head that never reached the remote, so `gh pr merge` landed the stale one.
// settings.json has carried an `autoMode.allow` entry for that exact command
// since 1dadc5d, so adding one is not the fix for a denial here; the classifier
// judges per invocation. Step 1 now rebases server-side first: an API call, not
// a push, so the classifier is never consulted for it.
//
// THE CEILING: same as step4() above — presence, not correctness, and not
// that the fallback runs the way it's written.
function step1() {
  const start = "1. If the PR is behind";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("2. Watch checks settle");
  assert.notEqual(end, -1, "step 1's end marker moved — update this test");
  return start + rest.slice(0, end);
}

test("step 1 rebases server-side first, not with a local force-push", () => {
  assert.match(step1(), /`gh pr update-branch <pr> --rebase`/);
  assert.match(step1(), /no local git command runs/);
});

test("step 1 falls back to a local, unpushed rebase when the server-side path can't run", () => {
  assert.match(step1(), /a real conflict, or `allow_update_branch` off/);
  assert.match(step1(), /Rebase locally, for verification only — this rebase never needs to reach the remote/);
  assert.match(step1(), /Report this path as `rebase-fallback-#<pr>`/);
});

// #408: a controller once told its merge bot to prove a post-rebase stale
// worktree safe with `git cherry origin/main HEAD` — trivially `+` for any
// unmerged PR, since main never had the PR's commits merged rebase or not.
// Measured directly (two local clones, one simulating the server-side rebase
// the other never sees) before writing this: origin/<branch> reads `-`
// (nothing unique), origin/main reads `+` on the identical stale HEAD.
test("step 1 names the correct upstream for proving a post-rebase worktree stale but safe", () => {
  assert.match(step1(), /`git cherry origin\/<branch> HEAD`/);
  assert.match(step1(), /\*\*not\*\* `git cherry origin\/main HEAD`/);
});

test("step 4 expects the fallback path to disprove, not to silently count as proved", () => {
  assert.match(step4(), /A `rebase-fallback-#<pr>` merge is expected to disprove here/);
  assert.match(step4(), /never as `proved`/);
});

// Bounded to the Report line itself. An unbounded whole-file match is the
// vacuous pin this file's header forbids: the token surviving anywhere else in
// the doc would mask its removal from the vocabulary list.
test("the report vocabulary includes rebase-fallback", () => {
  assert.match(DOC, /^Report merged [^\n]*rebase-fallback-#X/m);
});
