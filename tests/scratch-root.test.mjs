// Regression gate for scratch-root.mjs and fleet-dir.mjs's scratchRoot() /
// scratchRootRefusal() (ADR 0027): the fleet's scratch root is ONE fixed path
// per repository, `~/.fleet/scratch/<basename>-<8 hex>/`, computed and never
// recorded.
//
// Real git throughout — the properties under test are what `rev-parse
// --git-common-dir` and `check-ignore` answer, which a stub would only restate.
// HOME is a temp directory per case, so nothing here touches the real
// `~/.fleet`; `os.homedir()` follows HOME on POSIX, which is what the script
// reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH_KEY_SHAPE, scratchRoot, scratchRootRefusal } from "../plugin/scripts/fleet-dir.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { tempDir } from "./support/temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/scratch-root.mjs", import.meta.url));

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository named `name` under a fresh parent, with one commit. */
function repo(name) {
  const dir = join(realpathSync(tempDir("scratch-root-")), name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "f"), "x\n");
  git(dir, "add", "f");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function run(cwd, home, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
}

const keyOf = (dir) => `${dir.split("/").pop()}-${createHash("sha256").update(realpathSync(dir)).digest("hex").slice(0, 8)}`;

test("prints ~/.fleet/scratch/<basename>-<8 hex of the sha256 of the workspace realpath>, creates it, and exits 0", () => {
  const dir = repo("some-repo");
  const home = realpathSync(tempDir("scratch-home-"));
  const r = run(dir, home);
  assert.equal(r.status, 0, r.stderr);
  const want = join(home, ".fleet", "scratch", keyOf(dir));
  assert.equal(r.stdout, `${want}\n`);
  assert.ok(existsSync(want), "the root was printed but not created");
  assert.equal(r.stderr, "");
});

test("a linked worktree prints the same path as its main checkout", () => {
  const dir = repo("wt-repo");
  const home = realpathSync(tempDir("scratch-home-"));
  const linked = join(dir, ".worktrees", "1-slug");
  git(dir, "worktree", "add", "-q", "-b", "feat", linked);
  const fromMain = run(dir, home);
  const fromLinked = run(linked, home);
  assert.equal(fromLinked.status, 0, fromLinked.stderr);
  assert.equal(fromLinked.stdout, fromMain.stdout);
});

test("a second clone with the same folder name gets a different root", () => {
  const a = repo("same-name");
  const b = repo("same-name");
  assert.notEqual(a, b);
  const home = realpathSync(tempDir("scratch-home-"));
  const ra = run(a, home);
  const rb = run(b, home);
  assert.equal(ra.status, 0, ra.stderr);
  assert.equal(rb.status, 0, rb.stderr);
  assert.notEqual(ra.stdout, rb.stdout);
  assert.ok(ra.stdout.includes("/same-name-") && rb.stdout.includes("/same-name-"));
});

test("a symlinked route to one workspace is not a second root", () => {
  const dir = repo("linked-route");
  const alias = join(realpathSync(tempDir("scratch-alias-")), "alias");
  spawnSync("ln", ["-s", dir, alias]);
  const home = realpathSync(tempDir("scratch-home-"));
  assert.equal(run(alias, home).stdout, run(dir, home).stdout);
});

test("nothing is written into the repository, its `.fleet/` included", () => {
  const dir = repo("clean-repo");
  const home = realpathSync(tempDir("scratch-home-"));
  assert.equal(run(dir, home).status, 0);
  assert.equal(existsSync(join(dir, ".fleet")), false);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("an ambient GIT_DIR cannot retarget the key onto another repository", () => {
  const dir = repo("target");
  const decoy = repo("decoy");
  const home = realpathSync(tempDir("scratch-home-"));
  const r = run(dir, home, { GIT_DIR: join(decoy, ".git") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${join(home, ".fleet", "scratch", keyOf(dir))}\n`);
});

test("outside any repository it exits 2, naming git's reason, and prints nothing", () => {
  const plain = realpathSync(tempDir("scratch-plain-"));
  const home = realpathSync(tempDir("scratch-home-"));
  const r = run(plain, home);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /scratch-root: could not resolve --git-common-dir/);
});

test("a root inside a git work tree that does not ignore it is refused: exit 1, the work tree named, nothing created", () => {
  const dir = repo("enclosing");
  const home = join(dir, "home");
  mkdirSync(home);
  const r = run(dir, home);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^scratch-root: scratch root .* is inside the git work tree .*enclosing/m);
  assert.equal(existsSync(join(home, ".fleet")), false, "a refused root still created a directory in the repository");
});

// A directory mode does not bind root, so there is nothing to observe as uid 0.
test("a root that cannot be created exits 2, not the refusal's exit 1, with no stack trace", { skip: process.getuid?.() === 0 }, () => {
  const dir = repo("unwritable");
  const home = realpathSync(tempDir("scratch-home-"));
  chmodSync(home, 0o555);
  try {
    const r = run(dir, home);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^scratch-root: could not create .*EACCES/m);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  } finally {
    chmodSync(home, 0o755);
  }
});

test("an ambient GIT_DIR cannot turn the refusal of an enclosing, unignoring repository into a pass", () => {
  const dir = repo("enclosing-ambient");
  // A bare repository has no work tree, so an unscrubbed probe would read the
  // enclosing repository as "not in a work tree" and let the root through.
  const decoy = join(realpathSync(tempDir("scratch-bare-")), "bare.git");
  git(dir, "init", "-q", "--bare", decoy);
  const home = join(dir, "home");
  mkdirSync(home);
  const r = run(dir, home, { GIT_DIR: decoy });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /inside the git work tree .*enclosing-ambient/);
});

test("a root inside an outer repository whose ignore rules cover it is accepted: exit 0, root printed", () => {
  const dir = repo("dotfiles-home");
  writeFileSync(join(dir, ".gitignore"), ".fleet/\n");
  const home = dir;
  const worker = repo("worker");
  const r = run(worker, home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${join(home, ".fleet", "scratch", keyOf(worker))}\n`);
  assert.ok(existsSync(r.stdout.trim()));
});

test("scratchRoot() is pure: the same answer from any cwd of one repository, and nothing is created", () => {
  const dir = repo("pure");
  const home = realpathSync(tempDir("scratch-home-"));
  mkdirSync(join(dir, "sub"));
  const a = scratchRoot({ cwd: dir, home });
  assert.equal(scratchRoot({ cwd: join(dir, "sub"), home }), a);
  assert.equal(a, join(home, ".fleet", "scratch", keyOf(dir)));
  assert.equal(existsSync(a), false);
});

// The sibling pass of `reclaim-scratch.mjs --siblings` judges only the
// directories SCRATCH_KEY_SHAPE matches, so a key scratchRoot() builds that the
// shape misses is a key no sibling pass ever reclaims. The keys come from
// scratchRoot() itself, never typed in, so a format change made here and in
// keyOf() together still fails this test until the shape follows.
test("SCRATCH_KEY_SHAPE matches the key scratchRoot() builds, hyphenated basename and bare repository included", () => {
  const home = realpathSync(tempDir("scratch-home-"));
  const plain = repo("plain");
  const hyphenated = repo("impl-tool");
  const bare = join(dirname(hyphenated), "impl-tool.git");
  git(dirname(hyphenated), "clone", "-q", "--bare", hyphenated, bare);
  for (const cwd of [plain, hyphenated, bare]) {
    const key = basename(scratchRoot({ cwd, home }));
    assert.match(key, SCRATCH_KEY_SHAPE,
      `scratchRoot() built the key ${key} for ${cwd}, which SCRATCH_KEY_SHAPE ${SCRATCH_KEY_SHAPE} does not match — the sibling pass would never judge it`);
  }
});

test("scratchRootRefusal() answers null outside any work tree and a reason inside an unignoring one", () => {
  const plain = realpathSync(tempDir("scratch-plain-"));
  assert.equal(scratchRootRefusal(join(plain, ".fleet", "scratch", "x")), null);
  const dir = repo("refusal");
  const bad = join(dir, "scratch", "x");
  assert.match(scratchRootRefusal(bad), /inside the git work tree/);
  writeFileSync(join(dir, ".gitignore"), "scratch/\n");
  assert.equal(scratchRootRefusal(bad), null);
});

test("scratchRootRefusal() asks git with the trailing slash: a directory-only ignore pattern covers a root that is not on disk yet", () => {
  const dir = repo("dir-only-ignore");
  const root = join(dir, "key");
  writeFileSync(join(dir, ".gitignore"), "key/\n");
  assert.equal(existsSync(root), false);
  assert.equal(scratchRootRefusal(root), null);
  // Control: the same pattern is not an answer for the path without the slash,
  // so the pass above is the slash's doing and not the root's absence.
  const bare = spawnSync("git", ["check-ignore", "-q", root], { cwd: dir, env: gitEnv() });
  assert.equal(bare.status, 1);
});

// A fake `git` first on PATH: it answers the invocation `argv0 argv1` (by
// default `rev-parse --show-toplevel`) with `body` and hands every other
// invocation to the real git, so the rest of the probe is untouched.
function withFakeGit(body, fn, [argv0, argv1] = ["rev-parse", "--show-toplevel"]) {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "no real git on PATH to delegate to");
  const bin = realpathSync(tempDir("scratch-fakegit-"));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = ${argv0} ] && [ "$2" = ${argv1} ]; then\n${body}\nfi\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was}`;
  try {
    return fn();
  } finally {
    process.env.PATH = was;
  }
}

test("scratchRootRefusal() reads only git's own not-a-work-tree answer as one: any other failure is refused", () => {
  const plain = realpathSync(tempDir("scratch-plain-"));
  const root = join(plain, ".fleet", "scratch", "x");
  // Control: git's real not-a-work-tree words, through the same fake, pass —
  // so the refusals below are the failure's doing, not the fake's.
  assert.equal(
    withFakeGit(`echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128`, () => scratchRootRefusal(root)),
    null,
  );
  assert.equal(
    withFakeGit(`echo "fatal: this operation must be run in a work tree" >&2\nexit 128`, () => scratchRootRefusal(root)),
    null,
  );
  assert.match(
    withFakeGit(`echo "fatal: detected dubious ownership in repository at '/x'" >&2\nexit 128`, () => scratchRootRefusal(root)),
    /could not ask git whether .* is inside a work tree: .*dubious ownership/,
  );
  assert.match(
    withFakeGit(`kill -9 $$`, () => scratchRootRefusal(root)),
    /could not ask git whether .* is inside a work tree: killed by SIGKILL/,
  );
  assert.match(
    withFakeGit(`exit 3`, () => scratchRootRefusal(root)),
    /could not ask git whether .* is inside a work tree: exit 3/,
  );
  // A timed-out git leaves status null, an error, and whatever it had already
  // written: stderr that matches is no answer, so the error is read first.
  assert.match(
    withFakeGit(`echo "fatal: not a git repository" >&2\nexec sleep 5`, () => scratchRootRefusal(root, { timeoutMs: 300 })),
    /could not ask git whether .* is inside a work tree: .*ETIMEDOUT/,
  );
});

test("scratchRootRefusal() names why `git check-ignore` could not say the root is ignored: its own words, else how it ended", () => {
  const dir = repo("ignore-fails");
  const root = join(dir, "x");
  const checkIgnore = ["check-ignore", "-q"];
  // Control: the real answer for an unignored root, through no fake.
  assert.match(scratchRootRefusal(root), /inside the git work tree .*ignore-fails, which does not ignore it — /);
  assert.match(
    withFakeGit(`echo "fatal: bad ignore file" >&2\nexit 128`, () => scratchRootRefusal(root), checkIgnore),
    /inside the git work tree .*ignore-fails, fatal: bad ignore file — /,
  );
  assert.match(
    withFakeGit(`exit 5`, () => scratchRootRefusal(root), checkIgnore),
    /inside the git work tree .*ignore-fails, exit 5 — /,
  );
  assert.match(
    withFakeGit(`kill -9 $$`, () => scratchRootRefusal(root), checkIgnore),
    /inside the git work tree .*ignore-fails, killed by SIGKILL — /,
  );
});
