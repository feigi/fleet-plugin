// recipe-read.mjs's `readRecipe` bounds each read when its caller gives it
// `timeoutMs`: a read that outlives the bound is killed and reads `broken`,
// the cache's state unknown, rather than holding its caller for as long as
// the reader hangs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecipe } from "../plugin/scripts/recipe-read.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";

test("a read that outlives timeoutMs is killed and reads broken, naming the timeout", () => {
  const root = tempDir("recipe-read-");
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  // Every read is `--at origin/main`, which must resolve for a read to reach
  // `node` at all.
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFileSync(join(repo, ".fleet", "recipe.json"), "{}\n");
  // derive-testcmd.sh runs `node` before it reads the cache, so a `node` that
  // hangs hangs the read.
  const bin = join(root, "hanging-node");
  mkdirSync(bin);
  writeExecStub(join(bin, "node"), "#!/bin/sh\nsleep 5\n");
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  let r;
  try {
    r = readRecipe(repo, { timeoutMs: 300 });
  } finally {
    process.env.PATH = path;
  }
  for (const read of ["install", "check", "test"]) {
    assert.match(r.output, new RegExp(`^derive-testcmd\\.sh \\. ${read} --at origin/main ETIMEDOUT — the cache's state is unknown, and deriving would not help$`, "m"));
  }
});

// The reader phase 0's `recipe` step and the settle wakes share judges every
// field against origin/main, the tree members' worktrees are cut from: a
// command path the main checkout still holds and origin/main does not reads
// `refused`, each read naming itself, rather than valid (#4048).
test("a command path the main checkout holds and origin/main does not reads refused, for every field", () => {
  const repo = tempDir("recipe-read-lost-");
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { env, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), ".fleet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "root");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo, "run-tests.sh"), "#!/bin/sh\n");
  chmodSync(join(repo, "run-tests.sh"), 0o755);
  git("add", "run-tests.sh");
  git("commit", "-q", "-m", "a script origin/main does not hold");
  mkdirSync(join(repo, ".fleet"));
  const recipe = { install: "./run-tests.sh", check: "./run-tests.sh", checkMutation: "break it", test: "./run-tests.sh", derivedAt: git("rev-parse", "HEAD"), installClean: true, testCount: 3, uncovered: [] };
  writeFileSync(join(repo, ".fleet", "recipe.json"), JSON.stringify(recipe));
  const r = readRecipe(repo);
  assert.equal(r.state, "refused", r.output);
  for (const read of ["install", "check", "test"]) {
    assert.match(r.output, new RegExp(`^derive-testcmd\\.sh \\. ${read} --at origin/main refused:$`, "m"));
    assert.ok(r.output.includes(`its ${read} command './run-tests.sh' is not found or not executable from . at origin/main — `), r.output);
  }
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const valid = readRecipe(repo);
  assert.equal(valid.state, "valid", `once origin/main holds the script the same cache reads valid: ${valid.output}`);
});
