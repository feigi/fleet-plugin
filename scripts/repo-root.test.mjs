// The answers repo-root.mjs exists to keep apart, pinned directly rather than
// through a sub-suite.
//
// The sweep suites that import it (muted-git-guard-sweep, unattended-git-sweep,
// worktree-listing-sweep) skip themselves where there is no ambient working
// tree, and a skip is an ABSENCE of coverage. Nothing inside a skipped file can
// pin the condition that skipped it — so the pin lives here, where every answer
// is reachable in one process: `null` where the root lookup cannot answer, a
// path where it can, and a throw where it finds a repository that does not
// CONTAIN this file (#1339, then #1354). Without the second half the guard
// could fire everywhere and the whole gate would be silently gone (#1149);
// without the third, a non-empty wrong root — or, per #1354's review, a
// DIFFERENT checkout of this same plugin that merely shares its name — would
// sail through as though it were a real answer.
//
// Several tests below need `repoRoot` to answer YES about a fixture, which
// containment makes harder to fake than the old name-only check: a fixture
// has to actually CONTAIN a copy of repo-root.mjs and its manifest, at the
// same relative layout this file ships in, and the test then imports THAT
// copy rather than the module under test. `selfContainedFixture` builds it.
//
// Zero deps: `node --test scripts/repo-root.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownPluginName, repoRoot, skipWithoutRepo, trackedShellScripts } from "./repo-root.mjs";

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

/**
 * Writes `dir/.claude-plugin/plugin.json` naming the same plugin as this
 * checkout's own — via `ownPluginName()`, not a literal, for the same reason
 * repo-root.mjs itself reads it that way rather than hardcoding "fleet"
 * (#1352 is mid-rename). This alone does NOT make `repoRoot` accept `dir`
 * since #1354: a name match is not containment, and `dir` does not contain
 * this file. That gap is exactly what the same-name-foreign-checkout test
 * below exercises; fixtures that need a root `repoRoot` genuinely accepts use
 * `selfContainedFixture` instead.
 */
function ownManifestFixture(dir) {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: ownPluginName() }));
}

/**
 * A fixture `repoRoot` can genuinely accept, post-#1354's containment check:
 * a git repository that CONTAINS a copy of repo-root.mjs at the same
 * relative layout this file ships in (`scripts/repo-root.mjs` beside
 * `.claude-plugin/plugin.json`), so the copy's own `import.meta.url` resolves
 * inside the fixture.
 *
 * Returns the copy's own exports via dynamic `import()` — the module UNDER
 * TEST (`./repo-root.mjs`) is never itself inside a disposable fixture, so
 * asking it to answer for one always fails containment by construction. Every
 * caller of this fixture is therefore exercising the SAME contract through a
 * second, disposable instance of the module rather than a special case.
 */
async function selfContainedFixture(t) {
  const { dir } = noRepo(t);
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(join(DIR, "repo-root.mjs"), join(scriptsDir, "repo-root.mjs"));
  ownManifestFixture(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  assert.ok(existsSync(join(dir, ".git")), "fixture was not initialised as a repository");
  const mod = await import(pathToFileURL(join(scriptsDir, "repo-root.mjs")).href);
  return { dir, scriptsDir, repoRoot: mod.repoRoot };
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

test("repoRoot answers the root where there IS one, and skipWithoutRepo then declines to skip", async (t) => {
  // Since #1354, a bare `git init` plus a matching manifest is not enough —
  // repoRoot also checks CONTAINMENT, so the fixture has to actually contain
  // a copy of the module being asked about.
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);

  const root = fixtureRepoRoot(scriptsDir);
  assert.equal(root, dir);
  assert.equal(skipWithoutRepo(root, "the tests"), false,
    "a working tree that answers must never skip — that is the condition the sweeps are for");
});

// The half a skip cannot pin from inside itself, and the exact conflation #1149
// forbids: a repository with NOTHING matching. `trackedShellScripts` answers an
// empty list and `skipWithoutRepo` still declines to skip, so the importing
// sweep runs and its own non-vacuity guard is what fails. A skip here would turn
// the nested-under-an-unrelated-repo failure into a silent green.
test("an empty tracked-script list is NOT a skip — the sweep still runs and its guard still judges", async (t) => {
  // The fixture's copy of repo-root.mjs and its manifest are written to disk
  // but never `git add`ed — trackedShellScripts reads `git ls-files`, so the
  // tracked-script list stays empty while the identity check still passes.
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);

  const root = fixtureRepoRoot(scriptsDir);
  assert.notEqual(root, null);
  assert.deepEqual(trackedShellScripts(root), [], "a repository with no tracked shell scripts lists none");
  assert.equal(skipWithoutRepo(root, "the tests"), false,
    "an empty match list inside this plugin's own tree is a broken glob or path join, "
    + "and must reach the caller's guard as a FAILURE");
});

// #1339's exact measured shape: a foreign git repository (the operator's own
// dotfiles, in the field) with tracked *.sh files, and inside it a directory
// that looks like an installed plugin's own scripts/ — no .git, no manifest —
// so the discovery walk that starts there lands on the foreign root. Before
// the fix, repoRoot returned that root because its only guard was
// non-vacuity, and the foreign repo's tracked scripts are a non-empty list;
// the caller's own non-vacuity guard never even got a chance to be wrong,
// because there was nothing vacuous about the answer.
//
// Measured against the pre-fix repoRoot (this file's repo-root.mjs copied to
// a scratch path before this commit and imported from there — `git stash` is
// forbidden by this repo's convention): `node prefix-repro.mjs` against that
// copy printed `BUG REPRODUCED: repoRoot did NOT throw. root =
// /private/var/.../repo-root-foreign-fhzHMH` and `trackedShellScripts(root) =
// [ 'hooks/x.sh', 'y.sh' ]` — the assertion below would have failed against
// it. Against the fixed repoRoot below: PASSES, and the thrown message names
// the foreign root and the file it fails to contain.
test("a foreign git repository with tracked scripts is refused, not returned — #1339", (t) => {
  const foreignRoot = realpathSync(mkdtempSync(join(tmpdir(), "repo-root-foreign-")));
  t.after(() => rmSync(foreignRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", foreignRoot], { env: ENV });
  const hooksDir = join(foreignRoot, "hooks");
  mkdirSync(hooksDir);
  writeFileSync(join(hooksDir, "x.sh"), "#!/bin/sh\n");
  writeFileSync(join(foreignRoot, "y.sh"), "#!/bin/sh\n");
  execFileSync("git", ["add", "hooks/x.sh", "y.sh"], { cwd: foreignRoot, env: ENV });
  execFileSync("git", ["commit", "-q", "-m", "tracked scripts"], { cwd: foreignRoot, env: ENV });

  // The plugin-cache-like nested directory: no .git, no manifest, exactly what
  // an installed copy looks like when it lands inside an ambient working tree
  // that is not its own (the shape #1339 measured under `~/.claude`).
  const nested = join(foreignRoot, "plugins", "cache", "fleet-plugin", "fleet", "0.1.1", "scripts");
  mkdirSync(nested, { recursive: true });

  assert.deepEqual(
    execFileSync("git", ["ls-files", "*.sh"], { cwd: foreignRoot, encoding: "utf8" }).trim().split("\n").sort(),
    ["hooks/x.sh", "y.sh"],
    "fixture must have exactly the two tracked scripts #1339 measured, or the old guard's non-emptiness isn't exercised",
  );

  const saved = process.env.GIT_CEILING_DIRECTORIES;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  });
  process.env.GIT_CEILING_DIRECTORIES = dirname(foreignRoot);

  assert.throws(
    () => repoRoot(nested),
    (err) => err instanceof Error && err.message.includes(foreignRoot) && /does not contain/.test(err.message),
    "a wrong root that is non-empty must be refused as loudly as an empty one — #1339",
  );
});

// #1354's review of the first fix: comparing the resolved root's OWN manifest
// name against this file's caught #1339's shape but missed a DIFFERENT
// checkout of this same plugin sitting above some unrelated caller directory
// — same name, wrong tree, still accepted. This fixture is exactly that: a
// foreign repository whose `.claude-plugin/plugin.json` genuinely matches
// this checkout's own plugin name, but which does not contain this file.
//
// Mutation-tested by hand against a scratch copy of the fixed repo-root.mjs
// with BOTH `startsWith(realRoot + sep)` containment checks in
// `assertOwnRoot` deleted (own manifest + own file left as the only signal,
// i.e. the pre-#1354 shape without even a name comparison to fall back on):
// running this fixture's shape against that mutant printed `MUTATION
// CONFIRMED LOAD-BEARING: without containment, repoRoot wrongly returned
// /private/var/.../foreign-same-name-M030YF` — the mutant answered a foreign
// root. Against the real, unmutated repoRoot below: throws, naming the
// foreign root and this file.
test("a different checkout of this same plugin, not containing this file, is refused — #1354", (t) => {
  const { dir } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  // Same plugin NAME as this checkout's own — the exact condition a
  // name-only check would have accepted.
  ownManifestFixture(dir);

  const self = realpathSync(join(DIR, "repo-root.mjs"));
  assert.throws(
    () => repoRoot(dir),
    (err) => err instanceof Error && err.message.includes(dir) && err.message.includes(self)
      && /another checkout, not this one/.test(err.message),
    "a foreign tree that merely shares this plugin's name must be refused exactly as an unnamed one is — #1354",
  );
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
