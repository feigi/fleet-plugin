// fleet-dir.mjs's workspace rule across the git layouts whose common git dirs
// used to collide on one workspace: submodules of one superproject, bare repos
// in one parent, `--separate-git-dir` clones whose git dirs share a parent, and
// a `.git` symlinked to an external git dir. Each layout is a real `git`
// fixture, never a mocked spawn, and each case asserts BOTH fleetFile(null)
// and scratchRoot(), because the two stores must move together.
//
// The no-move cases pin the layouts that did NOT collide (plain clone, subdir,
// linked worktree, symlinked path, `.bare` project) to the keys the pre-#3091
// formula produced, so the rule cannot silently re-key a working repository.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { fleetFile, scratchRoot, scratchParent } from "../plugin/scripts/fleet-dir.mjs";

// realpath'd for the same reason fleet-dir.test.mjs's tempDir is: macOS
// tmpdir() sits under a symlink, and git answers in the resolved form.
function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// GIT_DIR/GIT_WORK_TREE scrubbed off the fixture, as in fleet-dir.test.mjs.
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  assert.equal(r.status, 0, `test setup: git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function commit(dir) {
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
}

function repo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  commit(dir);
  return dir;
}

function sha8(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

// The scratch key a workspace must produce: `<name>-<8 hex of its realpath>`.
function scratchKeyOf(root) {
  return basename(root);
}

test("two submodules of one superproject resolve to disjoint workspaces; a linked worktree of one shares its stores", (t) => {
  const d = tempDir(t, "fleet-layout-sub-");
  const modA = repo(join(d, "mod-a"));
  const modB = repo(join(d, "mod-b"));
  const sup = repo(join(d, "super"));
  git(sup, "-c", "protocol.file.allow=always", "submodule", "-q", "add", modA, "a");
  git(sup, "-c", "protocol.file.allow=always", "submodule", "-q", "add", modB, "b");
  commit(sup);
  const a = join(sup, "a");
  const b = join(sup, "b");
  const home = tempDir(t, "fleet-layout-home-");

  assert.equal(fleetFile("ledger.md", { cwd: a }), join(sup, ".git", "modules", "a", ".fleet", "ledger.md"));
  assert.equal(fleetFile("ledger.md", { cwd: b }), join(sup, ".git", "modules", "b", ".fleet", "ledger.md"));
  assert.notEqual(fleetFile(null, { cwd: a }), fleetFile(null, { cwd: b }),
    "two submodules of one superproject must not share a .fleet/ directory");
  assert.notEqual(scratchRoot({ cwd: a, home }), scratchRoot({ cwd: b, home }),
    "two submodules of one superproject must not share a scratch root");
  assert.match(scratchKeyOf(scratchRoot({ cwd: a, home })), /^a-[0-9a-f]{8}$/);

  const wt = join(d, "a-wt");
  git(a, "worktree", "add", "-q", "--detach", wt);
  assert.equal(fleetFile(null, { cwd: wt }), fleetFile(null, { cwd: a }),
    "a linked worktree of a submodule shares that submodule's .fleet/");
  assert.equal(scratchRoot({ cwd: wt, home }), scratchRoot({ cwd: a, home }),
    "a linked worktree of a submodule shares that submodule's scratch root");
});

test("two bare repositories in one parent are disjoint, and each bare dir agrees with its linked worktree", (t) => {
  const d = tempDir(t, "fleet-layout-bare-");
  const src = repo(join(d, "src"));
  git(d, "clone", "-q", "--bare", src, join(d, "x.git"));
  git(d, "clone", "-q", "--bare", src, join(d, "y.git"));
  const x = join(d, "x.git");
  const y = join(d, "y.git");
  const home = tempDir(t, "fleet-layout-home-");
  const wx = join(d, "wx");
  git(x, "worktree", "add", "-q", "--detach", wx);

  assert.equal(fleetFile(null, { cwd: x }), join(x, ".fleet"),
    "a bare repository is its own workspace: its .fleet/ lives inside it");
  assert.notEqual(fleetFile(null, { cwd: x }), fleetFile(null, { cwd: y }),
    "two bare repositories in one parent must not share a .fleet/ directory");
  assert.equal(fleetFile(null, { cwd: wx }), fleetFile(null, { cwd: x }),
    "a linked worktree of a bare repository shares its .fleet/");
  assert.notEqual(scratchRoot({ cwd: x, home }), scratchRoot({ cwd: y, home }));
  assert.equal(scratchRoot({ cwd: wx, home }), scratchRoot({ cwd: x, home }));
  assert.match(scratchKeyOf(scratchRoot({ cwd: x, home })), /^x-[0-9a-f]{8}$/,
    "the .git suffix of a bare repository's directory name is not part of its key");
});

test("two --separate-git-dir clones whose git dirs share a parent are disjoint, and so is a plain checkout from a clone inside it", (t) => {
  const d = tempDir(t, "fleet-layout-sep-");
  const home = tempDir(t, "fleet-layout-home-");
  const q1 = join(d, "q1");
  const q2 = join(d, "q2");
  mkdirSync(q1);
  mkdirSync(q2);
  git(q1, "init", "-q", "--separate-git-dir", join(d, "a.git"));
  git(q2, "init", "-q", "--separate-git-dir", join(d, "b.git"));

  assert.equal(fleetFile(null, { cwd: q1 }), join(d, "a.git", ".fleet"));
  assert.notEqual(fleetFile(null, { cwd: q1 }), fleetFile(null, { cwd: q2 }),
    "two clones whose git dirs share a parent must not share a .fleet/ directory");
  assert.notEqual(scratchRoot({ cwd: q1, home }), scratchRoot({ cwd: q2, home }));

  const plain = repo(join(d, "Q"));
  const foo = join(plain, "foo");
  mkdirSync(foo);
  git(foo, "init", "-q", "--separate-git-dir", join(plain, "foo.git"));
  assert.equal(fleetFile(null, { cwd: foo }), join(plain, "foo.git", ".fleet"));
  assert.equal(fleetFile(null, { cwd: plain }), join(plain, ".fleet"));
  assert.notEqual(fleetFile(null, { cwd: foo }), fleetFile(null, { cwd: plain }),
    "a plain checkout and a clone nested inside it must not share a .fleet/ directory");
  assert.notEqual(scratchRoot({ cwd: foo, home }), scratchRoot({ cwd: plain, home }));
});

test("a .git symlinked to an external git dir: the checkout and its linked worktree share one root", (t) => {
  const d = tempDir(t, "fleet-layout-symgit-");
  const home = tempDir(t, "fleet-layout-home-");
  const proj = repo(join(d, "proj"));
  renameSync(join(proj, ".git"), join(d, "g.git"));
  symlinkSync(join(d, "g.git"), join(proj, ".git"));
  const wt = join(d, "proj-wt");
  git(proj, "worktree", "add", "-q", "--detach", wt);

  assert.equal(fleetFile(null, { cwd: proj, canonicalise: true }), join(d, "g.git", ".fleet"));
  assert.equal(fleetFile(null, { cwd: wt, canonicalise: true }), join(d, "g.git", ".fleet"),
    "a linked worktree of a symlinked .git must name the same .fleet/ as its checkout");
  assert.equal(scratchRoot({ cwd: wt, home }), scratchRoot({ cwd: proj, home }));
  assert.match(scratchKeyOf(scratchRoot({ cwd: proj, home })), /^g-[0-9a-f]{8}$/);
});

test("the layouts that did not collide keep the keys the pre-#3091 formula produced", (t) => {
  const d = tempDir(t, "fleet-layout-nomove-");
  const home = tempDir(t, "fleet-layout-home-");
  const scratchOf = (workspace) => join(scratchParent(home), `${basename(workspace)}-${sha8(workspace)}`);

  // Plain clone, its subdirectory and a linked worktree of it.
  const main = repo(join(d, "main"));
  const sub = join(main, "sub", "dir");
  mkdirSync(sub, { recursive: true });
  const wt = join(main, ".worktrees", "7-slug");
  git(main, "worktree", "add", "-q", "--detach", wt);
  for (const cwd of [main, sub, wt]) {
    assert.equal(fleetFile(null, { cwd }), join(main, ".fleet"));
    assert.equal(scratchRoot({ cwd, home }), scratchOf(main));
  }

  // A symlinked route to the plain clone keeps its spelling for fleetFile and
  // collapses onto the real workspace for the scratch root.
  const link = join(d, "link");
  symlinkSync(main, link);
  assert.equal(fleetFile(null, { cwd: link }), join(link, ".fleet"));
  assert.equal(scratchRoot({ cwd: link, home }), scratchOf(main));

  // The `.bare` project: a `.git` file pointing at `.bare`, and two worktrees.
  const proj = join(d, "proj");
  mkdirSync(proj);
  git(d, "clone", "-q", "--bare", repo(join(d, "bare-src")), join(proj, ".bare"));
  writeFileSync(join(proj, ".git"), "gitdir: ./.bare\n");
  const wt1 = join(proj, "wt1");
  const wt2 = join(proj, "wt2");
  git(join(proj, ".bare"), "worktree", "add", "-q", "--detach", wt1);
  git(join(proj, ".bare"), "worktree", "add", "-q", "--detach", wt2);
  for (const cwd of [proj, wt1, wt2]) {
    assert.equal(fleetFile(null, { cwd }), join(proj, ".fleet"),
      "a `.bare` project's root and both worktrees share the project's .fleet/");
    assert.equal(scratchRoot({ cwd, home }), scratchOf(proj));
  }
});

test("a plain clone in a folder whose name ends in .git keeps its key: only a git dir loses the suffix", (t) => {
  const d = tempDir(t, "fleet-layout-dotgit-");
  const home = tempDir(t, "fleet-layout-home-");
  const main = repo(join(d, "x.git"));
  assert.equal(fleetFile(null, { cwd: main }), join(main, ".fleet"));
  assert.match(scratchKeyOf(scratchRoot({ cwd: main, home })), /^x\.git-[0-9a-f]{8}$/);
});
