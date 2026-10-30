// recipe-read.mjs's `readRecipe` bounds each read when its caller gives it
// `timeoutMs`: a read that outlives the bound is killed and reads `broken`,
// the cache's state unknown, rather than holding its caller for as long as
// the reader hangs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecipe } from "../plugin/scripts/recipe-read.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";

test("a read that outlives timeoutMs is killed and reads broken, naming the timeout", () => {
  const root = tempDir("recipe-read-");
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
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
  // `test --at origin/main` refuses before it runs `node`: the repository has
  // no origin/main to resolve.
  for (const read of ["install", "check"]) {
    assert.match(r.output, new RegExp(`^derive-testcmd\\.sh \\. ${read} ETIMEDOUT — the cache's state is unknown, and deriving would not help$`, "m"));
  }
});
