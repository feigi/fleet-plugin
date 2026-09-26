// The answers repo-root.mjs exists to keep apart, pinned directly rather than
// through a sub-suite.
//
// The sweep suites that import it (muted-git-guard-sweep, unattended-git-sweep,
// worktree-listing-sweep) skip themselves where there is no ambient working
// tree, and a skip is an ABSENCE of coverage. Nothing inside a skipped file can
// pin the condition that skipped it — so the pin lives here, where every answer
// is reachable in one process: `null` where the root lookup cannot answer, a
// path where it can, and a throw where it finds a repository whose own git
// does not TRACK this file (#1339, then twice more in #1354's review).
// Without the second half the guard could fire everywhere and the whole gate
// would be silently gone (#1149); without the third, a non-empty wrong root —
// a DIFFERENT checkout of this same plugin that merely shares its name, or an
// installed copy sitting untracked inside an ambient repository — would sail
// through as though it were a real answer.
//
// Several tests below need `repoRoot` to answer YES about a fixture, which
// tracked-ness makes harder to fake than either of the checks tried before
// it: a fixture has to actually TRACK a copy of repo-root.mjs and its
// manifest, at the same relative layout this file ships in, and the test
// then imports THAT copy rather than the module under test.
// `selfContainedFixture` builds the simple case; the #1339-precise tests
// build the installed-cache shape by hand.
//
// Zero deps: `node --test plugin/scripts/repo-root.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownPluginName, repoRoot, skipWithoutRepo, trackedNodeScripts, trackedShellScripts } from "./repo-root.mjs";

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
 * A fixture `repoRoot` can genuinely accept, post-#1354's tracked-ness check:
 * a git repository that TRACKS a copy of repo-root.mjs at the same relative
 * layout this file ships in (`scripts/repo-root.mjs` beside
 * `.claude-plugin/plugin.json`), so the copy's own `import.meta.url` resolves
 * inside the fixture AND `git ls-files --error-unmatch` finds it there.
 *
 * Returns the copy's own exports via dynamic `import()` — the module UNDER
 * TEST (`./repo-root.mjs`) is never itself tracked by a disposable fixture,
 * so asking it to answer for one always fails by construction. Every caller
 * of this fixture is therefore exercising the SAME contract through a
 * second, disposable instance of the module rather than a special case.
 */
async function selfContainedFixture(t) {
  const { dir } = noRepo(t);
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(join(DIR, "repo-root.mjs"), join(scriptsDir, "repo-root.mjs"));
  copyFileSync(join(DIR, "git-env.mjs"), join(scriptsDir, "git-env.mjs"));
  ownManifestFixture(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  assert.ok(existsSync(join(dir, ".git")), "fixture was not initialised as a repository");
  // Staged is enough for `git ls-files --error-unmatch` (measured) — no
  // commit needed, and *.sh stays untracked either way since this fixture
  // never writes any.
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  const mod = await import(pathToFileURL(join(scriptsDir, "repo-root.mjs")).href);
  return { dir, scriptsDir, repoRoot: mod.repoRoot };
}

/**
 * A foreign git repository with tracked `hooks/x.sh` and `y.sh` — the shape
 * #1339 measured (the operator's own dotfiles, complete with its own
 * unrelated tracked scripts). Returns `{ dir }`; callers add whatever
 * plugin-cache-like structure their scenario needs inside it.
 */
function foreignRepoWithTrackedScripts(t) {
  const { dir } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir);
  writeFileSync(join(hooksDir, "x.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, "y.sh"), "#!/bin/sh\n");
  execFileSync("git", ["add", "hooks/x.sh", "y.sh"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-q", "-m", "tracked scripts"], { cwd: dir, env: ENV });
  assert.deepEqual(
    execFileSync("git", ["ls-files", "*.sh"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort(),
    ["hooks/x.sh", "y.sh"],
    "fixture must have exactly the two tracked scripts #1339 measured, or the old guard's non-emptiness isn't exercised",
  );
  return { dir };
}

/**
 * Copies THIS checkout's own `scripts/repo-root.mjs` and
 * `.claude-plugin/plugin.json` into
 * `<foreignRoot>/plugins/cache/mkt/fleet/0.1.1/{scripts,.claude-plugin}` —
 * the exact layout an installed plugin's cache directory takes (#1339's own
 * measured shape, `~/.claude/plugins/cache/fleet-plugin/fleet/0.1.1/...`).
 *
 * `tracked` decides whether the copy is committed into `foreignRoot`'s own
 * index. `false` is the real #1339 shape: a cache directory that ships
 * ALONGSIDE the ambient repository's tracked tree, never inside it. `true` is
 * what happens the moment that copy IS committed there — it stops being a
 * foreign file and becomes genuinely that repository's own.
 */
function installedCacheCopy(foreignRoot, { tracked }) {
  const payloadDir = join(foreignRoot, "plugins", "cache", "mkt", "fleet", "0.1.1");
  const scriptsDir = join(payloadDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(payloadDir, ".claude-plugin"), { recursive: true });
  copyFileSync(join(DIR, "repo-root.mjs"), join(scriptsDir, "repo-root.mjs"));
  copyFileSync(join(DIR, "git-env.mjs"), join(scriptsDir, "git-env.mjs"));
  copyFileSync(join(DIR, "..", ".claude-plugin", "plugin.json"), join(payloadDir, ".claude-plugin", "plugin.json"));
  if (tracked) {
    execFileSync("git", ["add", "-A", "plugins"], { cwd: foreignRoot, env: ENV });
    execFileSync("git", ["commit", "-q", "-m", "vendor the plugin payload"], { cwd: foreignRoot, env: ENV });
  }
  return scriptsDir;
}

/**
 * Writes each of `files` (repo-relative, parent directories created) under
 * `dir` and stages it — empty, or `contents[file]` where the caller names one.
 * Staged is enough for `git ls-files` (the same measurement
 * `selfContainedFixture` relies on), so no commit.
 */
function track(dir, files, contents = {}) {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), contents[f] ?? "");
  }
  execFileSync("git", ["add", "--", ...files], { cwd: dir, env: ENV });
}

/**
 * A git repository tracking `files` (written as `track` writes them), plus an
 * UNTRACKED `scratch.mjs` at its top — a module nobody committed is not what
 * ships, so it is on disk for a directory walk to find and must never reach
 * an answer. Returns `{ dir }`.
 */
function repoTracking(t, files, contents = {}) {
  const { dir } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  assert.ok(existsSync(join(dir, ".git")), "fixture was not initialised as a repository");
  track(dir, files, contents);
  writeFileSync(join(dir, "scratch.mjs"), "");
  return { dir };
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
  // repoRoot also checks TRACKED-NESS, so the fixture has to actually track
  // a copy of the module being asked about.
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);

  const root = fixtureRepoRoot(scriptsDir);
  assert.equal(root, dir);
  assert.equal(skipWithoutRepo(root, "the tests"), false,
    "a working tree that answers must never skip — that is the condition the sweeps are for");
});

// #1599: repo-root.mjs's three git calls (isTrackedBy, repoRoot's own
// rev-parse, trackedShellScripts) passed no env at all before this fix, and
// #1020's own census could not see any of them — its scan is `.sh`-only.
// Measured directly against this file: an ambient GIT_DIR or GIT_WORK_TREE
// (a git hook, `rebase --exec`, `bisect run`) corrupts each call in its own
// distinct way, silently, at exit 0. The four fixtures below isolate each
// one, and a fifth reaches the third again through `trackedNodeScripts`;
// `noRepo(t)` doubles as "give me a disposable real repository" here,
// since none of them needs a repo-LESS fixture.
test("repoRoot()'s own rev-parse: an inherited GIT_WORK_TREE substitutes a foreign toplevel for the caller's own", async (t) => {
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);
  const { dir: otherRepo } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", otherRepo], { env: ENV });

  const saved = ["GIT_DIR", "GIT_WORK_TREE"].map((k) => [k, process.env[k]]);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.GIT_DIR;
  process.env.GIT_WORK_TREE = otherRepo;

  assert.equal(fixtureRepoRoot(scriptsDir), dir,
    "an ambient GIT_WORK_TREE must not answer --show-toplevel with a DIFFERENT repository — measured: unscrubbed, this call returns the ambient path itself");
});

test("repoRoot()'s own rev-parse: an inherited GIT_DIR alone answers with cwd itself, not the tree's real root", async (t) => {
  // GIT_DIR set with no GIT_WORK_TREE makes git assume the CURRENT directory
  // is the top level — measured, called from a subdirectory (scriptsDir, the
  // realistic shape: this function's caller is rarely sitting at the tree's
  // own root) this answers with scriptsDir itself, not dir.
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);
  const { dir: otherRepo } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", otherRepo], { env: ENV });

  const saved = ["GIT_DIR", "GIT_WORK_TREE"].map((k) => [k, process.env[k]]);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.GIT_DIR = join(otherRepo, ".git");
  delete process.env.GIT_WORK_TREE;

  assert.equal(fixtureRepoRoot(scriptsDir), dir,
    "an ambient GIT_DIR must not answer --show-toplevel with cwd unresolved to the tree's real root");
});

test("assertOwnRoot's tracked-ness check: an inherited GIT_DIR must not make isTrackedBy answer falsely for the caller's own tracked file", async (t) => {
  // Called at the tree's OWN root (not a subdirectory), so the rev-parse
  // half above answers correctly regardless of this fix — measured, an
  // ambient GIT_DIR alone leaves --show-toplevel unaffected when cwd is
  // already the toplevel. That isolates the SECOND git call repoRoot makes,
  // isTrackedBy() inside assertOwnRoot, from the first: unscrubbed, `git
  // ls-files --error-unmatch` under this ambient GIT_DIR answers for the
  // OTHER repository's index, so a file this plugin's own git genuinely
  // tracks comes back "did not match any files" — a false negative that
  // makes repoRoot() throw on its own legitimate root.
  const { dir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);
  const { dir: otherRepo } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", otherRepo], { env: ENV });

  const saved = ["GIT_DIR", "GIT_WORK_TREE"].map((k) => [k, process.env[k]]);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.GIT_DIR = join(otherRepo, ".git");
  delete process.env.GIT_WORK_TREE;

  assert.equal(fixtureRepoRoot(dir), dir,
    "an ambient GIT_DIR must not make the tracked-ness check refuse this plugin's own root");
});

test("trackedShellScripts: an inherited GIT_DIR must not substitute another repository's tracked *.sh list for this one", (t) => {
  const { dir } = foreignRepoWithTrackedScripts(t);
  const { dir: otherRepo } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", otherRepo], { env: ENV });

  const saved = ["GIT_DIR", "GIT_WORK_TREE"].map((k) => [k, process.env[k]]);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.GIT_DIR = join(otherRepo, ".git");
  delete process.env.GIT_WORK_TREE;

  assert.deepEqual(trackedShellScripts(dir).sort(), ["hooks/x.sh", "y.sh"],
    "an ambient GIT_DIR must not substitute the OTHER repository's tracked *.sh list for this one");
});

// The same call reached through the sibling export — both lists come out of
// one `trackedFiles` — so this pins the scrub for the node-script answer
// rather than a second site. The other repository tracks a module of its own:
// the realistic shape (a hook's GIT_DIR names a repository with files in it),
// and the one where the substituted list is non-empty, i.e. the one a caller's
// non-vacuity guard lets through. No GIT_WORK_TREE twin: measured inert for
// this call (see `trackedFiles`), so a fixture for it could not red.
test("trackedNodeScripts: an inherited GIT_DIR must not substitute another repository's tracked list for this one", (t) => {
  const { dir } = repoTracking(t, ["a.mjs", "a.test.mjs"]);
  const { dir: otherRepo } = repoTracking(t, ["foreign.mjs"]);

  const saved = ["GIT_DIR", "GIT_WORK_TREE"].map((k) => [k, process.env[k]]);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.GIT_DIR = join(otherRepo, ".git");
  delete process.env.GIT_WORK_TREE;

  assert.deepEqual(trackedNodeScripts(dir), ["a.mjs"],
    "an ambient GIT_DIR must not substitute the OTHER repository's tracked list for this one");
});

// The answer itself, for a root repoRoot vouched for: every tracked file the
// consumer's own `node` executes, and nothing else — a `.mjs` by its
// extension, any other file by a node shebang on its first line. #1855's own
// case is `scripts/fleet-tool`, the shape of this repository's extensionless
// entrypoints (`fleet-run`, `fleet-bootstrap`, `fleet-provenance`), which an
// extension-only rule never listed. `eval-only.js` is the other half of that
// ticket: review-pr.js's shape, ESM in a `.js` with no shebang, run only by a
// harness and never by plain node, so no extension rule may pull it in. Each
// test file sits beside a shipped module its name extends — one carries a
// node shebang, and is still a test. `latest.mjs` is the boundary on the other
// side — it ends in `test.mjs` without being a test file, so a rule keyed on
// that looser suffix drops a shipped module — and the untracked `scratch.mjs`
// and `scratch-tool` are what a directory walk standing in for git would
// wrongly add.
test("trackedNodeScripts answers the shipped node-script set for a verified root — .mjs and node-shebang files, test files excluded", async (t) => {
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);
  track(dir, [
    "scripts/latest.mjs", "scripts/lib/deep.mjs", "scripts/repo-root.test.mjs", "scripts/lib/deep.test.mjs",
    "scripts/fleet-tool", "workflows/eval-only.js",
  ], {
    "scripts/lib/deep.test.mjs": "#!/usr/bin/env node\n",
    "scripts/fleet-tool": "#!/usr/bin/env node\n\"use strict\";\n",
    "workflows/eval-only.js": "export const meta = {};\n",
  });
  writeFileSync(join(scriptsDir, "scratch.mjs"), "");
  writeFileSync(join(scriptsDir, "scratch-tool"), "#!/usr/bin/env node\n");

  const root = fixtureRepoRoot(scriptsDir);
  assert.equal(root, dir);
  assert.deepEqual(trackedNodeScripts(root).sort(),
    ["scripts/fleet-tool", "scripts/git-env.mjs", "scripts/latest.mjs", "scripts/lib/deep.mjs", "scripts/repo-root.mjs"],
    "the shipped set is every tracked *.mjs and node-shebang file, at any depth, less the *.test.mjs beside them");
});

// Which first lines hand a file to node. Through `env`, through `env -S` with
// the interpreter's own flags, through an `env` option that takes its OWN
// following bare argument (`-u FOO`, `--unset FOO`, `-C DIR`, `--chdir DIR`)
// rather than being the command itself, and by a direct interpreter path are
// all node, whatever the file's extension; `sh`, `bun` and `nodemon` are
// other programs — including where reached past an `-u`/`--unset`/`-C`/
// `--chdir` argument, which does not make the command after it any less "not
// node", and including where a flag that takes NO argument of its own
// (`-S`, `-i`) is immediately followed by a non-node command that is itself
// followed by the word `node` — that flag must not swallow the real command
// as if it were its own argument and let the non-node interpreter through. A
// shebang that is not the FIRST line is no shebang at all. An empty file,
// and one with no shebang, are simply not scripts.
test("trackedNodeScripts reads a non-.mjs file's first line: node by any shebang spelling, nothing else", (t) => {
  const node = {
    "bin/env": "#!/usr/bin/env node\n",
    "bin/env-flags": "#!/usr/bin/env -S node --no-warnings\n",
    "bin/env-assign": "#!/usr/bin/env FOO=bar node\n",
    "bin/env-unset": "#!/usr/bin/env -u FOO node\n",
    "bin/env-unset-long": "#!/usr/bin/env --unset FOO node\n",
    "bin/env-unset-multi": "#!/usr/bin/env -u FOO -u BAR node\n",
    "bin/env-chdir": "#!/usr/bin/env -C DIR node\n",
    "bin/env-chdir-long": "#!/usr/bin/env --chdir DIR node\n",
    "bin/direct": "#!/usr/local/bin/node\n",
    "bin/hook.js": "#!/usr/bin/env node\n",
  };
  const other = {
    "bin/check.sh": "#!/bin/sh\n",
    "bin/bun-tool": "#!/usr/bin/env bun\n",
    "bin/watch": "#!/usr/bin/env nodemon\n",
    "bin/env-unset-other": "#!/usr/bin/env -u FOO bun\n",
    "bin/env-split-other": "#!/usr/bin/env -S bun node\n",
    "bin/env-ignore-other": "#!/usr/bin/env -i sh node\n",
    "docs/notes.md": "# notes\n#!/usr/bin/env node\n",
    "LICENSE": "MIT\n",
    "bin/empty": "",
  };
  const files = { ...node, ...other };
  const { dir } = repoTracking(t, Object.keys(files), files);

  assert.deepEqual(trackedNodeScripts(dir).sort(), Object.keys(node).sort(),
    "exactly the files whose first line runs node — no other interpreter, no later line, no extension rule");
});

// A tracked file missing from the working tree — an `rm` not yet committed —
// has no first line to read. That is not a node script in this tree, and must
// not throw: every sweep calls this at module scope, where a throw fails the
// whole file over an unrelated deleted document.
test("trackedNodeScripts passes over a tracked file the working tree no longer has", (t) => {
  const { dir } = repoTracking(t, ["a.mjs", "NOTES"], { "NOTES": "notes\n" });
  rmSync(join(dir, "NOTES"));

  assert.deepEqual(trackedNodeScripts(dir), ["a.mjs"],
    "a tracked file absent from the working tree is no node script here, and no reason to fail the listing");
});

// The half a skip cannot pin from inside itself, and the exact conflation #1149
// forbids: a repository with NOTHING matching. `trackedShellScripts` answers an
// empty list and `skipWithoutRepo` still declines to skip, so the importing
// sweep runs and its own non-vacuity guard is what fails. A skip here would turn
// the nested-under-an-unrelated-repo failure into a silent green.
test("an empty tracked-script list is NOT a skip — the sweep still runs and its guard still judges", async (t) => {
  // The fixture's copy of repo-root.mjs and its manifest ARE tracked (the
  // identity check needs that), but no *.sh file is — trackedShellScripts
  // reads a disjoint glob, so its list stays empty regardless.
  const { dir, scriptsDir, repoRoot: fixtureRepoRoot } = await selfContainedFixture(t);

  const root = fixtureRepoRoot(scriptsDir);
  assert.notEqual(root, null);
  assert.deepEqual(trackedShellScripts(root), [], "a repository with no tracked shell scripts lists none");
  assert.equal(skipWithoutRepo(root, "the tests"), false,
    "an empty match list inside this plugin's own tree is a broken glob or path join, "
    + "and must reach the caller's guard as a FAILURE");
});

// The sibling's empty answer: a repository whose only tracked `.mjs` are test
// files, and whose only other file runs `sh`, ships no node script, and says so
// with `[]` — not `null`, not a throw, not a skip. Judging that emptiness is
// the importing sweep's non-vacuity guard's job, exactly as for the shell list
// above. The untracked `scratch.mjs` beside them keeps "none tracked" from
// passing for "none on disk".
test("trackedNodeScripts: a repository that ships no node script answers an empty list, not a skip", (t) => {
  const { dir } = repoTracking(t, ["a.test.mjs", "lib/b.test.mjs", "run.sh"], { "run.sh": "#!/bin/sh\n" });

  assert.deepEqual(trackedNodeScripts(dir), [], "a repository with only test *.mjs and a sh script tracked ships none");
  assert.equal(skipWithoutRepo(dir, "the tests"), false,
    "an empty match list inside a real repository is a broken glob or path join, "
    + "and must reach the caller's guard as a FAILURE");
});

// #1339's measured shape, broadly: a foreign git repository (the operator's
// own dotfiles, in the field) with tracked *.sh files, and inside it a
// directory that looks like an installed plugin's own scripts/ — no .git, no
// copy of repo-root.mjs at all — so the discovery walk that starts there
// lands on the foreign root. Before the fix, repoRoot returned that root
// because its only guard was non-vacuity, and the foreign repo's tracked
// scripts are a non-empty list; the caller's own non-vacuity guard never even
// got a chance to be wrong, because there was nothing vacuous about the
// answer.
//
// Measured against the pre-fix repoRoot (this file's repo-root.mjs copied to
// a scratch path before this commit and imported from there — `git stash` is
// forbidden by this repo's convention): `node prefix-repro.mjs` against that
// copy printed `BUG REPRODUCED: repoRoot did NOT throw. root =
// /private/var/.../repo-root-foreign-fhzHMH` and `trackedShellScripts(root) =
// [ 'hooks/x.sh', 'y.sh' ]` — the assertion below would have failed against
// it. Against the fixed repoRoot below: PASSES, and the thrown message names
// the foreign root and the file it does not track.
test("a foreign git repository with tracked scripts is refused, not returned — #1339", (t) => {
  const { dir: foreignRoot } = foreignRepoWithTrackedScripts(t);

  // The plugin-cache-like nested directory: no .git, no copy of this module,
  // exactly what an installed copy's PARENT looks like when it lands inside
  // an ambient working tree that is not its own (the shape #1339 measured
  // under `~/.claude`). The more precise test below places an actual copy of
  // this file there and asks IT about itself.
  const nested = join(foreignRoot, "plugins", "cache", "fleet-plugin", "fleet", "0.1.1", "scripts");
  mkdirSync(nested, { recursive: true });

  const saved = process.env.GIT_CEILING_DIRECTORIES;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  });
  process.env.GIT_CEILING_DIRECTORIES = dirname(foreignRoot);

  assert.throws(
    () => repoRoot(nested),
    (err) => err instanceof Error && err.message.includes(foreignRoot) && /does not TRACK/.test(err.message),
    "a wrong root that is non-empty must be refused as loudly as an empty one — #1339",
  );
});

// #1339's shape, PRECISELY: not merely "some foreign repo with tracked
// scripts" but the actual installed-cache layout — a real copy of THIS file
// at `plugins/cache/mkt/fleet/0.1.1/scripts/repo-root.mjs`, UNTRACKED by the
// ambient repository it happens to sit inside (a cache directory is never
// committed there). This is the exact configuration #1339 measured under
// `~/.claude`: self genuinely lives inside the foreign repository — so a
// CONTAINMENT check (tried and reverted between #1354's first two rounds)
// wrongly accepts it, and only tracked-ness tells them apart.
//
// Mutation-tested by hand: reverted `assertOwnRoot` to the containment-only
// shape (`self.startsWith(realRoot + sep)`, no `isTrackedBy`) in a scratch
// copy laid out at the same relative depth as a real checkout, then ran this
// exact fixture shape against it — printed `MUTATION CONFIRMED LOAD-BEARING:
// containment-only wrongly accepted /private/tmp/true1339-mut-BzsU`, i.e. the
// untracked cache copy was answered about. Against the real, tracked-ness
// based repoRoot below: throws.
test("an untracked installed-cache copy inside a foreign repository is refused — #1339 (precise)", async (t) => {
  const { dir: foreignRoot } = foreignRepoWithTrackedScripts(t);
  const scriptsDir = installedCacheCopy(foreignRoot, { tracked: false });

  const mod = await import(pathToFileURL(join(scriptsDir, "repo-root.mjs")).href);
  assert.throws(
    () => mod.repoRoot(scriptsDir),
    (err) => err instanceof Error && err.message.includes(foreignRoot) && /does not TRACK/.test(err.message),
    "an untracked cache copy must be refused even though it sits genuinely INSIDE the ambient repository — #1339",
  );
});

// The other half: once the SAME copy is committed into the foreign
// repository's own index, it genuinely IS that repository's file — this is
// no longer a foreign root being mistaken for the answer, it is the
// vendoring repository's own tree, and repoRoot must accept it exactly as it
// would this checkout.
test("a committed installed-cache copy inside a foreign repository is accepted as that repository's own", async (t) => {
  const { dir: foreignRoot } = foreignRepoWithTrackedScripts(t);
  const scriptsDir = installedCacheCopy(foreignRoot, { tracked: true });

  const mod = await import(pathToFileURL(join(scriptsDir, "repo-root.mjs")).href);
  assert.equal(mod.repoRoot(scriptsDir), foreignRoot,
    "once the copy is committed it IS that repository's own file, and repoRoot must say so");
});

// #1336's planned re-nesting of the whole payload under `plugin/`, simulated
// by committing this file's own scripts/ and .claude-plugin/ under a
// `plugin/` subdirectory of a fresh repository, so the git toplevel no
// longer has `.claude-plugin` directly beneath it. The self-relative
// manifest lookup (`dirname(thisFile)/../.claude-plugin/plugin.json`) must
// still find it regardless of how many levels separate it from the toplevel,
// and repoRoot must still accept the checkout as its own.
test("a plugin/-nested layout (#1336) is still accepted as this file's own tree", async (t) => {
  const { dir } = noRepo(t);
  const pluginDir = join(dir, "plugin");
  const scriptsDir = join(pluginDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  copyFileSync(join(DIR, "repo-root.mjs"), join(scriptsDir, "repo-root.mjs"));
  copyFileSync(join(DIR, "git-env.mjs"), join(scriptsDir, "git-env.mjs"));
  copyFileSync(join(DIR, "..", ".claude-plugin", "plugin.json"), join(pluginDir, ".claude-plugin", "plugin.json"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-q", "-m", "nested payload"], { cwd: dir, env: ENV });

  const mod = await import(pathToFileURL(join(scriptsDir, "repo-root.mjs")).href);
  assert.equal(mod.repoRoot(scriptsDir), dir,
    "a hardcoded root/.claude-plugin/plugin.json would refuse this; the self-relative lookup must not — #1336");
});

// #1354's review of the first fix: comparing the resolved root's OWN manifest
// name against this file's caught #1339's shape but missed a DIFFERENT
// checkout of this same plugin sitting above some unrelated caller directory
// — same name, wrong tree, still accepted. This fixture is exactly that: a
// foreign repository whose `.claude-plugin/plugin.json` genuinely matches
// this checkout's own plugin name, but which does not track this file.
test("a different checkout of this same plugin, not tracking this file, is refused — #1354", (t) => {
  const { dir } = noRepo(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  // Same plugin NAME as this checkout's own — the exact condition a
  // name-only check would have accepted.
  ownManifestFixture(dir);

  const self = realpathSync(join(DIR, "repo-root.mjs"));
  assert.throws(
    () => repoRoot(dir),
    (err) => err instanceof Error && err.message.includes(dir) && err.message.includes(self)
      && /does not TRACK/.test(err.message),
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

// The same guard for the sibling, which shares it — and needs it for the same
// reason: an absorbed null lists whatever repository the process sits in.
test("trackedNodeScripts refuses a root repoRoot did not answer", () => {
  assert.throws(() => trackedNodeScripts(null), /must come from repoRoot/);
  assert.throws(() => trackedNodeScripts(undefined), /must come from repoRoot/);
});

// And the guard must not fire in the tree it ships in.
test("this checkout resolves, so the sweeps that import this are not skipped here", { skip: SKIP_WITHOUT_REPO }, () => {
  const root = repoRoot(DIR);
  assert.notEqual(root, null, "no ambient working tree for a file that is itself tracked in one");
  assert.equal(skipWithoutRepo(root, "the tests"), false);
  assert.ok(trackedShellScripts(root).length > 0,
    "this repository tracks shell scripts — an empty list here means a broken glob, not a missing repo");
});
