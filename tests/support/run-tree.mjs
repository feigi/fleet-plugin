// A git tree the way a review run leaves one: tracked files committed, then an
// installed dependency directory git ignores written over it. Shared by the
// suites that measure an eviction: reclaim-scratch.test.mjs's `--pr` pass,
// evict-tree.test.mjs and review-core-run-end-eviction.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
delete ENV.GIT_DIR;
delete ENV.GIT_WORK_TREE;

/** `git <args>` in `cwd`, stdout trimmed; a failure fails the test. */
export function gitIn(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: ENV, encoding: "utf8",
  });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A git repository at `dir` holding the tracked files `.gitignore`, `tracked.txt`
 * and `sub/tracked.txt`, committed, then each of `installed` (relative paths)
 * written as a file — ignored by `.gitignore` — and each of `untracked` written
 * as a file git does not ignore. The ignore rules cover `node_modules/` at any
 * depth, `.cache/` and every `*.log`.
 */
export function makeTree(dir, { installed = ["node_modules/pkg/index.js"], untracked = [] } = {}) {
  mkdirSync(join(dir, "sub"), { recursive: true });
  gitIn(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.cache/\n*.log\n");
  writeFileSync(join(dir, "tracked.txt"), "tracked\n");
  writeFileSync(join(dir, "sub", "tracked.txt"), "tracked\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "tree");
  for (const rel of [...installed, ...untracked]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "x\n");
  }
  return dir;
}
