// worktree-porcelain.mjs against real `git worktree list --porcelain` output.
// Zero deps: `node --test plugin/scripts/worktree-porcelain.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAttribute, worktreeNames } from "./worktree-porcelain.mjs";

const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/**
 * A checkout on `main` whose parent directories spell the attributes the guards
 * look for (`locked`, `prunable`, `detached`) and some of the names they look
 * for (`feature/merged`, `79-brief`), the way an operator's TMPDIR can.
 */
function repoUnder(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-porcelain-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = join(root, "locked", "prunable", "detached", "feature", "merged", "79-brief", "w");
  mkdirSync(w, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", w], { env: ENV });
  git(w, "commit", "-q", "--allow-empty", "-m", "root");
  return w;
}

const listing = (w) => git(w, "worktree", "list", "--porcelain");

test("a name or attribute that is only in a worktree's parent directories is not reported", (t) => {
  const w = repoUnder(t);
  git(w, "worktree", "add", "-q", "-b", "fix/9-x", join(w, ".worktrees", "9-x"), "main");
  const l = listing(w);
  for (const word of ["locked", "prunable", "detached", "feature/merged", "79-brief"]) {
    assert.ok(l.includes(word), `fixture: the listing must carry ${word} in a path: ${l}`);
  }

  assert.deepEqual(worktreeNames(l), ["w", "main", "9-x", "fix/9-x"]);
  for (const attr of ["locked", "prunable", "detached"]) {
    assert.equal(hasAttribute(l, attr), false, `${attr} is only a parent directory here: ${l}`);
  }
});

test("a worktree's own basename, branch and attributes are reported", (t) => {
  const w = repoUnder(t);
  const brief = join(w, ".worktrees", "79-brief");
  git(w, "worktree", "add", "-q", "-b", "feature/merged", brief, "main");
  const lone = join(w, ".worktrees", "lone");
  git(w, "worktree", "add", "-q", "--detach", lone, "main");

  assert.deepEqual(worktreeNames(listing(w)), ["w", "main", "79-brief", "feature/merged", "lone"]);
  assert.equal(hasAttribute(listing(w), "detached"), true, "the bare-word form");

  git(w, "worktree", "lock", brief, "--reason", "held by a review");
  assert.match(listing(w), /^locked held by a review$/m, "fixture: a reason follows the word on its line");
  assert.equal(hasAttribute(listing(w), "locked"), true, "the word-and-reason form");
  git(w, "worktree", "unlock", brief);
  git(w, "worktree", "lock", brief);
  assert.equal(hasAttribute(listing(w), "locked"), true);
  git(w, "worktree", "unlock", brief);
  assert.equal(hasAttribute(listing(w), "locked"), false);

  rmSync(lone, { recursive: true, force: true });
  assert.equal(hasAttribute(listing(w), "prunable"), true);
});

test("a lock reason that spells a guard's prefix is not a name", (t) => {
  const w = repoUnder(t);
  const a = join(w, ".worktrees", "a");
  git(w, "worktree", "add", "-q", "-b", "fix/a", a, "main");
  git(w, "worktree", "lock", a, "--reason", "worktree on usb");
  const b = join(w, ".worktrees", "b");
  git(w, "worktree", "add", "-q", "-b", "fix/b", b, "main");
  git(w, "worktree", "lock", b, "--reason", "branch refs/heads/held");
  const c = join(w, ".worktrees", "c");
  git(w, "worktree", "add", "-q", "-b", "fix/c", c, "main");
  git(w, "worktree", "lock", c, "--reason", "see refs/heads/held");
  const l = listing(w);
  for (const reason of ["worktree on usb", "branch refs/heads/held", "see refs/heads/held"]) {
    assert.match(l, new RegExp(`^locked ${reason}$`, "m"), `fixture: the reason is on its own line: ${l}`);
  }

  assert.deepEqual(worktreeNames(l), ["w", "main", "a", "fix/a", "b", "fix/b", "c", "fix/c"]);
});

test("an attribute git never prints is refused, not answered false", () => {
  assert.throws(() => hasAttribute("worktree /x\nlocked\n", "lock"), /unknown attribute "lock"/);
});
