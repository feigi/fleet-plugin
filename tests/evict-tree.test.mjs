// `evict-tree.mjs`: what an eviction removes from a tree, driven directly. The
// `--pr` pass of reclaim-scratch.mjs and the end of a review run it through
// their own suites; the cases here are the ones neither reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evictTrees } from "../plugin/scripts/evict-tree.mjs";
import { gitIn, makeTree } from "./support/run-tree.mjs";

function base(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "evict-tree-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a tree is evicted whatever git status says: a modified tracked file and an untracked one stay as they are", (t) => {
  const dir = base(t);
  const tree = makeTree(join(dir, "run", "copy"), { untracked: ["mutant.txt"] });
  writeFileSync(join(tree, "tracked.txt"), "mutated\n");

  const r = evictTrees(join(dir, "run"), { apply: true });

  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.evicted, [{ path: tree, ignored: ["node_modules/"] }]);
  assert.equal(readFileSync(join(tree, "tracked.txt"), "utf8"), "mutated\n");
  assert.ok(existsSync(join(tree, "mutant.txt")));
  assert.ok(!existsSync(join(tree, "node_modules")));
  assert.equal(gitIn(tree, "status", "--porcelain"), "M tracked.txt\n?? mutant.txt");
});

test("the root itself is a tree when it holds a .git of its own", (t) => {
  const dir = base(t);
  const tree = makeTree(join(dir, "snapshot"));

  const r = evictTrees(tree, { apply: true });

  assert.deepEqual(r.evicted, [{ path: tree, ignored: ["node_modules/"] }]);
  assert.ok(!existsSync(join(tree, "node_modules")));
});

test("an ambient GIT_DIR and GIT_WORK_TREE naming another repository change nothing about which paths are listed or removed", (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  const tree = makeTree(join(run, "copy"));
  // The other repository ignores `.cache/`, which the tree holds none of: a git
  // call that answered for it would list `.cache/` and leave node_modules.
  const other = makeTree(join(dir, "other"), { installed: [".cache/z.js"] });
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  let r;
  try {
    r = evictTrees(run, { apply: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.evicted, [{ path: tree, ignored: ["node_modules/"] }]);
  assert.ok(!existsSync(join(tree, "node_modules")));
  assert.ok(existsSync(join(other, ".cache", "z.js")), "another repository's ignored path was removed");
});

test("a directory with nothing under it, and one that does not exist, evict nothing and fail nothing", (t) => {
  const dir = base(t);
  mkdirSync(join(dir, "empty"));

  assert.deepEqual(evictTrees(join(dir, "empty"), { apply: true }), { evicted: [], failed: [] });
  assert.deepEqual(evictTrees(join(dir, "gone"), { apply: true }), { evicted: [], failed: [] });
});

test("a directory git lists as ignored is named once, whole, even when git also lists an ignored directory inside it", (t) => {
  const dir = base(t);
  // A directory holding nothing but an ignored one that carries its own
  // .gitignore: git lists both `deps/` and `deps/node_modules/`.
  const tree = makeTree(join(dir, "snapshot"), { installed: ["deps/node_modules/pkg/index.js", "deps/node_modules/.gitignore"] });

  const r = evictTrees(tree, { apply: true });

  assert.deepEqual(r, { evicted: [{ path: tree, ignored: ["deps/"] }], failed: [] });
  assert.ok(!existsSync(join(tree, "deps")));
});
