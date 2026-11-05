// `evict-tree.mjs`: what an eviction removes from a tree, driven directly. The
// `--pr` pass of reclaim-scratch.mjs and the end of a review run it through
// their own suites; the cases here are the ones neither reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evictTrees } from "../plugin/scripts/evict-tree.mjs";
import { gitIn, makeTree } from "./support/run-tree.mjs";

function base(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "evict-tree-")));
  t.after(() => {
    // A case may leave a mode-000 directory behind.
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  });
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

test("a directory with nothing under it, and one that does not exist, evict nothing, fail nothing and skip nothing", (t) => {
  const dir = base(t);
  mkdirSync(join(dir, "empty"));

  assert.deepEqual(evictTrees(join(dir, "empty"), { apply: true }), { evicted: [], failed: [], skipped: [] });
  assert.deepEqual(evictTrees(join(dir, "gone"), { apply: true }), { evicted: [], failed: [], skipped: [] });
});

test("a directory git lists as ignored is named once, whole, even when git also lists an ignored directory inside it", (t) => {
  const dir = base(t);
  // A directory holding nothing but an ignored one that carries its own
  // .gitignore: git lists both `deps/` and `deps/node_modules/`.
  const tree = makeTree(join(dir, "snapshot"), { installed: ["deps/node_modules/pkg/index.js", "deps/node_modules/.gitignore"] });

  const r = evictTrees(tree, { apply: true });

  assert.deepEqual(r, { evicted: [{ path: tree, ignored: ["deps/"] }], failed: [], skipped: [] });
  assert.ok(!existsSync(join(tree, "deps")));
});

// A directory the walk cannot evaluate is skipped and named in `skipped`, never
// in `failed`: evicting a tree whose .git git will not answer for, or one under
// a directory nobody can list, is out of scope, but saying nothing is not.
const asRoot = process.getuid?.() === 0 && "root reads a mode-000 directory";
const installedAt = (tree) => join(tree, "node_modules", "pkg", "index.js");

for (const [shape, break_, reason] of [
  ["its .git mode 000", (tree) => chmodSync(join(tree, ".git"), 0), /^git rev-parse --show-toplevel did not answer for it \(exit 128: /],
  ["its .git/HEAD missing", (tree) => renameSync(join(tree, ".git", "HEAD"), join(tree, ".git", "HEAD.moved")), /^git rev-parse --show-toplevel did not answer for it \(exit 128: /],
]) {
  test(`a tree with ${shape} is skipped with git's own answer, fails nothing and keeps its ignored paths`, { skip: shape.includes("mode 000") && asRoot }, (t) => {
    const dir = base(t);
    const run = join(dir, "run");
    const tree = makeTree(join(run, "copy"));
    break_(tree);

    for (const apply of [true, false]) {
      const r = evictTrees(run, { apply });

      assert.deepEqual(r.failed, [], `apply ${apply}`);
      assert.deepEqual(r.evicted, [], `apply ${apply}`);
      assert.equal(r.skipped.length, 1, `apply ${apply}: ${JSON.stringify(r.skipped)}`);
      assert.equal(r.skipped[0].path, tree);
      assert.match(r.skipped[0].reason, reason);
    }
    assert.ok(existsSync(installedAt(tree)), "an ignored path of a tree git would not answer for was removed");
  });
}

test("a tree whose .git is present but resolves to an enclosing repository is skipped naming that top-level, and is never stripped", (t) => {
  const dir = base(t);
  const outer = makeTree(join(dir, "outer"));
  const run = join(outer, "run");
  const broken = join(run, "broken");
  mkdirSync(join(broken, ".git"), { recursive: true });
  mkdirSync(join(broken, "node_modules", "x"), { recursive: true });
  writeFileSync(join(broken, "node_modules", "x", "i.js"), "x");

  const r = evictTrees(run, { apply: true });

  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.evicted, []);
  assert.deepEqual(r.skipped, [{ path: broken, reason: `git resolves it to the top-level ${outer}, not to itself` }]);
  assert.ok(existsSync(join(broken, "node_modules", "x", "i.js")));
  assert.ok(existsSync(installedAt(outer)), "the enclosing repository was stripped");
});

test("a tree whose git names a top-level realpath cannot resolve is skipped with the comparison's code, and keeps its ignored paths", (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  const tree = makeTree(join(run, "copy"));
  // rev-parse prints core.worktree as the top-level, exit 0, whether or not it exists.
  const gone = join(dir, "gone");
  gitIn(tree, "config", "core.worktree", gone);

  const r = evictTrees(run, { apply: true });

  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.evicted, []);
  assert.deepEqual(r.skipped, [{ path: tree, reason: `comparing git's top-level ${gone} with it failed (ENOENT)` }]);
  assert.ok(existsSync(installedAt(tree)));
});

test("a tree under a mode-000 directory gives failed [] and a skip naming that directory with its EACCES or EPERM code", { skip: asRoot }, (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  const locked = join(run, "locked");
  const tree = makeTree(join(locked, "copy"));
  chmodSync(locked, 0);

  for (const apply of [true, false]) {
    const r = evictTrees(run, { apply });

    assert.deepEqual(r.failed, [], `apply ${apply}`);
    assert.deepEqual(r.evicted, [], `apply ${apply}`);
    assert.equal(r.skipped.length, 1, `apply ${apply}: ${JSON.stringify(r.skipped)}`);
    assert.equal(r.skipped[0].path, locked);
    assert.match(r.skipped[0].reason, /\((EACCES|EPERM)\)/);
  }
  chmodSync(locked, 0o755);
  assert.ok(existsSync(installedAt(tree)));
});

test("a root that is itself mode 000 is skipped", { skip: asRoot }, (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  makeTree(join(run, "copy"));
  chmodSync(run, 0);

  const r = evictTrees(run, { apply: true });

  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.skipped.map((s) => s.path), [run]);
});

test("a tree the walk can list but cannot look in for its .git is skipped naming its EACCES or EPERM code, and keeps its ignored paths", { skip: asRoot }, (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  // A flat tree, no subdirectory but its .git: readdir lists a mode-444
  // directory, so only the lookup of its .git can fail.
  const tree = join(run, "copy");
  mkdirSync(tree, { recursive: true });
  gitIn(tree, "init", "-q");
  writeFileSync(join(tree, ".gitignore"), "*.log\n");
  writeFileSync(join(tree, "a.txt"), "a\n");
  gitIn(tree, "add", "-A");
  gitIn(tree, "commit", "-q", "-m", "tree");
  writeFileSync(join(tree, "big.log"), "x\n");
  chmodSync(tree, 0o444);

  for (const apply of [true, false]) {
    const r = evictTrees(run, { apply });

    assert.deepEqual(r.failed, [], `apply ${apply}`);
    assert.deepEqual(r.evicted, [], `apply ${apply}`);
    assert.equal(r.skipped.length, 1, `apply ${apply}: ${JSON.stringify(r.skipped)}`);
    assert.equal(r.skipped[0].path, tree);
    assert.match(r.skipped[0].reason, /^cannot look for a \.git in it \((EACCES|EPERM)\)$/);
  }
  chmodSync(tree, 0o755);
  assert.ok(existsSync(join(tree, "big.log")));
});

test("a directory with a .git git will not answer for, which the walk also cannot list, is named once with both reasons", { skip: asRoot }, (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  const tree = makeTree(join(run, "copy"));
  renameSync(join(tree, ".git", "HEAD"), join(tree, ".git", "HEAD.moved"));
  chmodSync(tree, 0o100);

  const r = evictTrees(run, { apply: true });

  assert.deepEqual(r.failed, []);
  assert.equal(r.skipped.length, 1, JSON.stringify(r.skipped));
  assert.equal(r.skipped[0].path, tree);
  assert.match(r.skipped[0].reason, /^git rev-parse --show-toplevel did not answer for it \(exit 128: .*; cannot list it \((EACCES|EPERM)\)$/s);
});

test("a skipped directory does not stop the walk: the healthy trees around it are evicted, and skipped is sorted by path", { skip: asRoot }, (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  const before = makeTree(join(run, "aa-healthy"));
  const brokenTree = makeTree(join(run, "bb-broken"));
  chmodSync(join(brokenTree, ".git"), 0);
  const locked = join(run, "cc-locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0);
  const after = makeTree(join(run, "dd-healthy"));
  // A healthy tree nested under the skipped tree is still reached.
  const inner = makeTree(join(brokenTree, "inner"));

  const r = evictTrees(run, { apply: true });

  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.evicted.map((e) => e.path), [before, after, inner].sort());
  assert.deepEqual(r.skipped.map((s) => s.path), [brokenTree, locked]);
  assert.ok(!existsSync(join(before, "node_modules")) && !existsSync(join(after, "node_modules")));
  assert.ok(existsSync(installedAt(brokenTree)));
});

test("a directory with no .git of its own, and a listing that fails with ENOENT or ENOTDIR, are not skipped, and ENOTDIR is no failure", (t) => {
  const dir = base(t);
  const run = join(dir, "run");
  mkdirSync(join(run, "plain", "deeper"), { recursive: true });
  writeFileSync(join(run, "file.txt"), "x");

  assert.deepEqual(evictTrees(run, { apply: true }).skipped, []);
  assert.deepEqual(evictTrees(join(run, "gone"), { apply: true }).skipped, []);
  assert.deepEqual(evictTrees(join(run, "file.txt"), { apply: true }), { evicted: [], failed: [], skipped: [] });
});

test("a repository inside an ignored directory the walk removes, or would remove, is neither evicted nor skipped", (t) => {
  const dir = base(t);
  const tree = makeTree(join(dir, "snapshot"));
  // An empty .git resolves to the enclosing tree, which is what would be skipped were it walked.
  mkdirSync(join(tree, "node_modules", "dep", ".git"), { recursive: true });

  for (const apply of [false, true]) {
    const r = evictTrees(tree, { apply });

    assert.deepEqual(r, { evicted: [{ path: tree, ignored: ["node_modules/"] }], failed: [], skipped: [] }, `apply ${apply}`);
  }
});

test("a healthy tree is not skipped", (t) => {
  const dir = base(t);
  makeTree(join(dir, "run", "copy"));

  assert.deepEqual(evictTrees(join(dir, "run"), { apply: true }).skipped, []);
});
