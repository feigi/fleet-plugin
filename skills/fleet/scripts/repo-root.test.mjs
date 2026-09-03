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
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedShellScripts } from "./repo-root.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));

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
  assert.equal(typeof skipWithoutRepo(repoRoot(dir)), "string",
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
  assert.equal(skipWithoutRepo(root), false,
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
  assert.equal(skipWithoutRepo(root), false,
    "an empty match list is the wrong repository or a broken glob, and must reach the caller's guard as a FAILURE");
});

// And the guard must not fire in the tree it ships in.
test("this checkout resolves, so the sweeps that import this are not skipped here", () => {
  const root = repoRoot(DIR);
  assert.notEqual(root, null, "no ambient working tree for a file that is itself tracked in one");
  assert.equal(skipWithoutRepo(root), false);
  assert.ok(trackedShellScripts(root).length > 0,
    "this repository tracks shell scripts — an empty list here means a broken glob, not a missing repo");
});
