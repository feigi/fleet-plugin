// Regression gate for no-undo-audit.sh's refusal condition. Zero deps:
// `node --test skills/fleet/scripts/no-undo-audit.test.mjs`.
//
// The audit answers one question — is this worktree safe to rebase — and the
// only thing that can make it unsafe is uncommitted work in the worktree. It
// used to also refuse on a nonzero repo-global stash count, which is unrelated
// to that question: a rebase cannot reach refs/stash, so the count refused every
// run in a repo holding any entry while proving nothing about the branch.
//
// Both directions are pinned here, because a fix for a false refusal is one
// keystroke from deleting the true one.
//
// Real git throughout: a shell script that reasons about git state can only be
// tested against real git state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./no-undo-audit.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixtures, so a
// local pull.rebase or hook cannot change what these repos look like. BASE_REF
// is unset because the fleet harness is exactly the caller that has it set, and
// inheriting it would point every fixture at a local main while the suite stayed
// green.
const ENV = {
  ...process.env,
  BASE_REF: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Bare origin + clone with `main` and a pushed feature branch, checked out. */
function repo(t, branch = "fix/1-thing") {
  const root = mkdtempSync(join(tmpdir(), "no-undo-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  writeFileSync(join(w, "f.txt"), "root\n");
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  git(w, "checkout", "-q", "-b", branch);
  writeFileSync(join(w, "g.txt"), "branch work\n");
  git(w, "add", "g.txt");
  git(w, "commit", "-q", "-m", "branch work");
  git(w, "push", "-q", "-u", "origin", branch);
  return { w, branch };
}

/** Leave a stash entry behind without leaving the worktree dirty. */
function stashSomething(w, name = "h.txt") {
  writeFileSync(join(w, name), "stashed\n");
  git(w, "add", name);
  git(w, "stash", "push", "-q", "-m", `pre-existing ${name}`);
}

const audit = ({ w, branch }) => {
  const r = spawnSync("sh", [SCRIPT, w, branch], { cwd: w, env: ENV, encoding: "utf8" });
  return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null };
};

test("a pre-existing stash does not refuse a clean worktree", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture must leave the worktree clean");
  assert.equal(git(c.w, "stash", "list").split("\n").filter(Boolean).length, 1, "fixture must leave one stash");

  const r = audit(c);
  assert.equal(r.status, 0, `a stash the rebase cannot reach must not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
  assert.equal(r.json.stash, 1, "the count is still reported, just not gated on");
  assert.doesNotMatch(r.stderr, /REFUSED/);
});

test("several pre-existing stashes still do not refuse", (t) => {
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  stashSomething(c.w, "h2.txt");
  stashSomething(c.w, "h3.txt");

  const r = audit(c);
  assert.equal(r.status, 0, "the refusal must not scale with the count either");
  assert.equal(r.json.stash, 3);
});

test("a dirty worktree still refuses, and names the worktree not the stash", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work that exists nowhere else\n");

  const r = audit(c);
  assert.equal(r.status, 1, "uncommitted work is the whole point of this audit");
  assert.equal(r.json.clean, false);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /commit the worktree before rebasing/);
  // The old message told the caller to clear the stash list and forbade
  // `git stash drop` two lines later. Removing the gate must remove the
  // instruction, or the contradiction outlives the bug.
  assert.doesNotMatch(r.stderr, /stash-list-clear/);
});

test("a dirty worktree refuses with an empty stash stack", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");
  assert.equal(git(c.w, "stash", "list"), "", "fixture must leave no stash");

  const r = audit(c);
  assert.equal(r.status, 1, "clean is the sole gate — it must fire on its own");
  assert.equal(r.json.stash, 0);
});

test("a clean worktree with no stash passes", (t) => {
  const c = repo(t);
  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.json.clean, true);
  assert.equal(r.json.stash, 0);
});

test("a dirty worktree refuses even when a stash is also present", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");

  const r = audit(c);
  assert.equal(r.status, 1, "the stash must not mask the dirty check, in either direction");
  assert.equal(r.json.clean, false);
  assert.equal(r.json.stash, 1);
});
