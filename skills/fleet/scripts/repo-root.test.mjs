// The two answers repo-root.mjs exists to keep apart, pinned directly rather
// than through a sub-suite.
//
// The sweep suites that import it (muted-git-guard-sweep, unattended-git-sweep,
// worktree-listing-sweep) skip themselves where there is no ambient working
// tree, and a skip is an ABSENCE of coverage. Nothing inside a skipped file can
// pin the condition that skipped it — so the pin lives here, where both answers
// are reachable in one process: `null` where the root lookup cannot answer, a
// path where it can. Without the second half the guard could fire everywhere
// and the whole gate would be silently gone (#1149).
//
// Zero deps: `node --test skills/fleet/scripts/repo-root.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedShellScripts } from "./repo-root.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// This file's own use of the shape it pins. The last test asserts the answer for
// the tree this file ships in, which is a fact about the ENVIRONMENT, not about
// the code — so it declines in an extraction exactly as the sweeps do, rather
// than reporting the missing working tree as a failure. The three tests above it
// build their own repositories and hold anywhere.
const SKIP_WITHOUT_REPO = skipWithoutRepo(repoRoot(DIR), "the check on THIS checkout below");

// `git init` under an inherited GIT_DIR exits 0 and creates nothing in the
// target, so a fixture built with the ambient environment can be no repository
// at all while every status check passes. Scrubbed here, and the fixtures below
// assert the `.git` they were supposed to create rather than an exit code.
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

/**
 * A directory with no `.git` in it, and no way for git to reach one above it.
 *
 * `GIT_CEILING_DIRECTORIES` set to the PARENT, not to the directory itself:
 * measured, git starts its search in the working directory and only declines to
 * chdir UP into a ceiling entry, so naming the directory itself still lets the
 * walk reach a repository above it — inside a checkout that resolves to the
 * checkout, and the fixture would silently be a repository. Naming the parent is
 * what makes the answer independent of wherever `$TMPDIR` happens to live.
 */
function noRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-root-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { ...ENV, GIT_CEILING_DIRECTORIES: dirname(dir) } };
}

test("repoRoot answers null where there is no ambient working tree", (t) => {
  const { dir, env } = noRepo(t);
  // The fixture first, or the assertion below could pass over a directory that
  // is a repository for some unrelated reason.
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(probe.status, 128,
    `the fixture is not repo-less — git answered ${JSON.stringify(probe.stdout)} at status ${probe.status}`);

  // `repoRoot` reads the ambient environment, which is the whole point of it, so
  // the ceiling has to be ambient too for the fixture to hold here. Restored
  // afterwards — the last test in this file asserts the opposite answer in this
  // very checkout, and a leaked ceiling would make it pass for the wrong reason.
  const saved = ["GIT_CEILING_DIRECTORIES", "GIT_DIR", "GIT_WORK_TREE"].map((k) => [k, process.env[k]]);
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;

  assert.equal(repoRoot(dir), null, "no ambient working tree must answer null, not throw and not a path");
  assert.equal(typeof skipWithoutRepo(repoRoot(dir), "the tests"), "string",
    "and that is the one condition that produces a skip reason");
});

test("repoRoot answers the root where there IS one, and skipWithoutRepo then declines to skip", (t) => {
  const { dir } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  // The artifact, not the exit status: `git init` under an ambient GIT_DIR
  // returns 0 having created nothing here.
  assert.ok(existsSync(join(dir, ".git")), "fixture was not initialised as a repository");

  const root = repoRoot(dir);
  assert.equal(root, dir);
  assert.equal(skipWithoutRepo(root, "the tests"), false,
    "a working tree that answers must never skip — that is the condition the sweeps are for");
});

// The half a skip cannot pin from inside itself, and the exact conflation #1149
// forbids: a repository with NOTHING matching. `trackedShellScripts` answers an
// empty list and `skipWithoutRepo` still declines to skip, so the importing
// sweep runs and its own non-vacuity guard is what fails. A skip here would turn
// the nested-under-an-unrelated-repo failure into a silent green.
test("an empty tracked-script list is NOT a skip — the sweep still runs and its guard still judges", (t) => {
  const { dir } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  assert.ok(existsSync(join(dir, ".git")), "fixture was not initialised as a repository");

  const root = repoRoot(dir);
  assert.notEqual(root, null);
  assert.deepEqual(trackedShellScripts(root), [], "a repository with no tracked shell scripts lists none");
  assert.equal(skipWithoutRepo(root, "the tests"), false,
    "an empty match list is the wrong repository or a broken glob, and must reach the caller's guard as a FAILURE");
});

// #1149's own defect class, and the one place it could reappear inside the fix
// for it: a probe that could not look must never read as an answer. Every
// fixture below either HAS a repository or leaves the question unasked, so none
// of them is the absent working tree that licenses a skip — each must throw.
//
// The unreadable `.git` is why the answer cannot come from git's stderr alone:
// git steps over a `.git` it cannot enter and prints the same
// no-repository-anywhere message as a walk that genuinely found none (measured,
// git 2.50.1). Only the filesystem separates those two.
// Its own test because the fixture is not one every user can build: `chmod 000`
// is no barrier to root, and the repo's own convention for that is to decline
// rather than to assert over a fixture that is not the fault it means to be.
test("an unreadable .git is loud — the one fault git's own message cannot distinguish", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");

  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-root-")));
  t.after(() => {
    if (existsSync(join(dir, ".git"))) chmodSync(join(dir, ".git"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  assert.ok(existsSync(join(dir, ".git")), "fixture was not initialised as a repository");
  chmodSync(join(dir, ".git"), 0o000);

  // The fixture's whole point: git says the same thing here as it does over an
  // extraction, so a reading of stderr alone answers "no repository" for a
  // repository that is right there.
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"],
    { cwd: dir, env: { ...ENV, LC_ALL: "C" }, encoding: "utf8" });
  assert.match(probe.stderr, /not a git repository \(or any /,
    "fixture is not the indistinguishable case — git gave a message that already separates it");

  assert.throws(() => repoRoot(dir), /could not answer whether/,
    "a `.git` git refuses to read is a repository, not an extraction");
});

test("git failures that are not an absent working tree are LOUD, never a skip", (t) => {
  const notAnAnswer = /could not answer whether/;

  const stale = noRepo(t).dir;
  writeFileSync(join(stale, ".git"), "gitdir: /nonexistent/parent/.git/worktrees/wt1\n");
  assert.throws(() => repoRoot(stale), notAnAnswer,
    "a `.git` naming a gitdir that is not there is a broken pointer, not an absent tree");

  const bare = join(noRepo(t).dir, "bare.git");
  execFileSync("git", ["init", "-q", "--bare", bare], { env: ENV });
  assert.throws(() => repoRoot(bare), notAnAnswer,
    "a bare repository is a repository — git declines for want of a WORK TREE, which is a different sentence");

  const noGit = noRepo(t).dir;
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = "/nonexistent";
  assert.throws(() => repoRoot(noGit), notAnAnswer,
    "no git binary means the question was never put — spawnSync reports that as `error`, with no status and no stderr");
});

// The other direction, and the one this must not cost: the condition the skip
// exists for still answers `null` and still yields a reason.
test("a genuinely absent working tree still answers null, and still names why", (t) => {
  const { dir, env } = noRepo(t);
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(probe.status, 128, "the fixture is not repo-less");

  const saved = process.env.GIT_CEILING_DIRECTORIES;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  });
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);

  assert.equal(repoRoot(dir), null, "no working tree anywhere above is the one condition that may answer null");
  assert.match(skipWithoutRepo(repoRoot(dir), "the sweep"), /the sweep did not run/,
    "and the reason names what did not run, in the caller's own words");
});

// `trackedShellScripts` cannot tell a null root from a good one on its own:
// `execFileSync` reads `cwd: null` as "inherit the calling process's
// directory", so an absorbed null answers some other repository's scripts.
test("trackedShellScripts refuses a root repoRoot did not answer", () => {
  assert.throws(() => trackedShellScripts(null), /must come from repoRoot/);
  assert.throws(() => trackedShellScripts(undefined), /must come from repoRoot/);
});

// And the guard must not fire in the tree it ships in.
test("this checkout resolves, so the sweeps that import this are not skipped here", { skip: SKIP_WITHOUT_REPO }, () => {
  const root = repoRoot(DIR);
  assert.notEqual(root, null, "no ambient working tree for a file that is itself tracked in one");
  assert.equal(skipWithoutRepo(root, "the tests"), false);
  assert.ok(trackedShellScripts(root).length > 0,
    "this repository tracks shell scripts — an empty list here means a broken glob, not a missing repo");
});
