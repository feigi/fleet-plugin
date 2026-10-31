// Regression gate for instruments.sh, the check that says whether the
// controller's instrument set changed under a run (#436). It certifies the
// live Install root under $HOME (#3845) — an installed package, hashed file
// by file — and refuses a linked checkout at pin and at check (#4037); the
// WORKING DIRECTORY's checkout, never the checkout the script itself lives in
// (#1337), only locates the baseline. The install-only dev loop (ADR 0003)
// means this script normally runs out of a plugin cache; resolving from its
// own location measured whatever git checkout happens to CONTAIN that cache
// path, which was the operator's unrelated personal repo, not the plugin's
// own tree.
//
// The defect it guards is not observable from inside the fleet: a member that
// writes into the Install root — where the controller runs every gate probe
// from — changes what the controller measures with no error, no diff in
// any PR and nothing in the ledger. Measured once, self-caught by the member.
//
// A guard against that has TWO failure classes and this file pins both, because
// a suite that only feeds a guard input it must reject proves it fires, never
// that it discriminates:
//
//   REFUSE — an installed instrument rewritten, deleted, or added; no
//            baseline; an unreadable one; a cwd outside any git checkout; a
//            linked checkout for an Install root.
//   ACCEPT — an ordinary run: nothing touched, a bare `touch`, a
//            fast-forward of the workspace checkout, and any change outside
//            the set. #436's third acceptance criterion is that an unchanged
//            set costs effectively nothing per gate, and a guard that fires
//            on ordinary runs becomes noise the controller learns to ignore,
//            which is the same defect wearing a different hat.
//            One accepted case is NOT an ordinary run: a mode-only change to
//            an instrument, which a content digest cannot see (#1059).
//
// Every case builds a throwaway checkout — the state home — and runs the
// script with its cwd set to it — the script finds the baseline's `.fleet/`
// from $PWD (or --repo) — and with HOME set to a fixture whose
// `@feigi/fleet-ctl` entry is the Install root the script certifies (#3845):
// by default a real directory holding a package, the npm-install shape. A
// fixture repo is measured regardless of where the copy of instruments.sh
// invoked actually lives, and neither the live checkout nor a real omp
// install is ever read: ENV's own HOME is an empty directory, so a spawn that
// names no fixture HOME refuses instead of reaching the machine's install.
//
// Zero deps: `node --test tests/instruments.test.mjs`.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/instruments.sh", import.meta.url));
// #1336 nested the plugin's payload under `plugin/`, so the instrument set is
// that subtree rather than the repo root itself. Every join() below reads as
// "under the set".
const SET = "plugin";

// An empty HOME, removed when the file's cases are done: the default for every
// spawn below, so a case that names no fixture install refuses with "no omp
// plugin" rather than certifying whatever this machine has installed.
const NO_INSTALL = realpathSync(mkdtempSync(join(tmpdir(), "instruments-noinstall-")));
after(() => rmSync(NO_INSTALL, { recursive: true, force: true }));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `core.excludesfile` or hook cannot change what these repos look like.
// The GIT_* redirects would point the fixture out of its own temp dir.
const ENV = {
  ...process.env,
  HOME: NO_INSTALL,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

// The package entry every resolver of the Install root reads, under a HOME.
const entryOf = (home) => join(home, ".omp", "plugins", "node_modules", "@feigi", "fleet-ctl");

/** A fixture HOME with `.omp/plugins/node_modules/@feigi/` in place and no entry yet. */
function fakeHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "instruments-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(entryOf(home), ".."), { recursive: true });
  return home;
}

/** A fixture HOME whose package entry is a link to `to` — a linked install. */
function linkHome(t, to) {
  const home = fakeHome(t);
  symlinkSync(to, entryOf(home));
  return home;
}

// An installed package's payload: four of the five component directories
// (no `workflows/`, which a package may lack) and a `package.json` beside
// them, outside the set.
function writePackage(pkg, version = "3.102.7") {
  for (const d of ["scripts", "skills/run-team", "commands", "agents"]) mkdirSync(join(pkg, d), { recursive: true });
  writeFileSync(join(pkg, "scripts", "ci-state.mjs"), "console.log('green');\n");
  writeFileSync(join(pkg, "skills", "run-team", "SKILL.md"), "# runbook\n");
  writeFileSync(join(pkg, "commands", "run-team.md"), "# command\n");
  writeFileSync(join(pkg, "agents", "fleet-finisher.agent.md"), "# agent\n");
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@feigi/fleet-ctl", version }, null, 2)}\n`);
}

/** A fixture HOME whose package entry is a real directory — an npm install. */
function npmHome(t, version) {
  const home = fakeHome(t);
  const pkg = entryOf(home);
  writePackage(pkg, version);
  return { home, pkg };
}

// Each repo(t)'s own package install: the HOME that names it and the package
// directory itself, so `run(root)` certifies that package and `inst(root, …)`
// reaches its files.
const HOMES = new Map();
const PKGS = new Map();
const inst = (root, ...rel) => join(PKGS.get(root), ...rel);

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

// The state home: a git checkout that tracks its own `plugin/` tree — which is
// NOT the set, the package install is — paired with a package install under a
// fixture HOME. Pass `install` to share another fixture's package.
//
// realpath: on macOS $TMPDIR is a symlink into /private, and `git rev-parse
// --show-toplevel` reports the resolved form. Comparing the two spellings is a
// fixture bug that reads as a script bug.
function repo(t, install = npmHome(t)) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  mkdirSync(join(root, SET, "skills", "run-team"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('green');\n");
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# runbook\n");
  writeFileSync(join(root, "unrelated.md"), "outside the set\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  HOMES.set(root, install.home);
  PKGS.set(root, install.pkg);
  return root;
}

// Runs the copy of instruments.sh that lives INSIDE `root`, with cwd set to
// `root` by default — the state home is derived from cwd, never from
// where the script itself sits, so the default here is what an ordinary
// invocation from inside the checkout looks like — and HOME set to `root`'s
// own package install, so the tree certified is that package. `cwd` is
// overridable for the tests that specifically exercise cwd-vs-script-location
// divergence, and `env` for HOME and for the one #1020 case that has to put
// back a variable ENV scrubs — that scrub is what keeps every other case here
// deterministic, so the opt-in is per-call rather than a hole in ENV.
const run = (root, args = [], { cwd = root, env = {} } = {}) =>
  spawnSync(join(root, SET, "scripts", "instruments.sh"), args, {
    cwd,
    env: { ...ENV, HOME: HOMES.get(root) ?? NO_INSTALL, ...env },
    encoding: "utf8",
  });

// Runs this checkout's instruments.sh from `cwd` under `home` — the shape for
// an Install root that is not a fixture checkout's own package.
const runAt = (cwd, home, args = []) =>
  spawnSync("sh", [SCRIPT, ...args], { cwd, env: { ...ENV, HOME: home }, encoding: "utf8" });

const pin = (root) => {
  const r = run(root, ["--pin"]);
  assert.equal(r.status, 0, `--pin failed: ${r.stderr}`);
  return r.stdout.trim();
};
/** Every directory literally named `.fleet` anywhere under `root`, `.git` never descended. */
function findFleetDirs(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === ".fleet") found.push(p);
      else if (e.name !== ".git") walk(p);
    }
  };
  walk(root);
  return found;
}

test("--pin then an untouched check is exit 0, and reports the same digest", (t) => {
  const root = repo(t);
  const pinned = pin(root);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pinned);
});

test("a rewritten instrument is exit 1, and the refusal says so", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(inst(root, "scripts", "ci-state.mjs"), "console.log('red');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /instrument set CHANGED/);
  assert.match(r.stderr, /refuse the gate/i);
  // The controller has to be able to name what moved; two digests cannot.
  assert.match(r.stderr, /version 3\.102\.7 pinned, 3\.102\.7 now/);
});

test("a rewritten runbook is exit 1 too — the instructions are read from the same tree", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(inst(root, "skills", "run-team", "SKILL.md"), "# rewritten\n");
  assert.equal(run(root).status, 1);
});

test("restoring the bytes restores exit 0 — the digest is content, not history", (t) => {
  const root = repo(t);
  pin(root);
  const f = inst(root, "scripts", "ci-state.mjs");
  writeFileSync(f, "console.log('red');\n");
  assert.equal(run(root).status, 1);
  writeFileSync(f, "console.log('green');\n");
  assert.equal(run(root).status, 0);
});

test("an instrument deleted from the package is exit 1 — the set is what is on disk", (t) => {
  const root = repo(t);
  pin(root);
  rmSync(inst(root, "scripts", "ci-state.mjs"));
  const r = run(root);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /instrument set CHANGED/);
});

test("an instrument that cannot be read refuses exit 2, never 1 — nothing was measured", (t) => {
  if (process.geteuid?.() === 0) return t.skip("root reads a mode-000 file regardless");
  const root = repo(t);
  pin(root);
  const f = inst(root, "scripts", "ci-state.mjs");
  chmodSync(f, 0o000);
  try {
    const r = run(root);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /could not hash every file/);
    assert.match(r.stderr, /ci-state\.mjs/);
    assert.equal(r.stdout, "");
  } finally {
    chmodSync(f, 0o644);
  }
});

test("no baseline refuses with exit 2 — an unpinned run is not an unchanged one", (t) => {
  const root = repo(t);
  const r = run(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pin/);
});

test("an empty baseline refuses rather than matching an empty digest", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, ".fleet", "instruments.sha"), "");
  const r = run(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty/);
});

test("an unreadable baseline refuses with its own message, not the no-baseline one", (t) => {
  if (process.geteuid?.() === 0) return t.skip("root reads a mode-000 file regardless");
  const root = repo(t);
  pin(root);
  // No mode restored afterwards: `repo`'s own cleanup unlinks it, which needs
  // write on the directory and nothing at all on the file.
  chmodSync(join(root, ".fleet", "instruments.sha"), 0o000);
  const r = run(root);
  assert.equal(r.status, 2);
  // Distinct from "no baseline …" and explicit that `--pin` is the wrong
  // remedy here: `--pin` never compares, it overwrites, so re-pinning over an
  // unreadable-but-present baseline would discard evidence instead of
  // explaining the refusal. (#1058)
  assert.match(r.stderr, /exists but is unreadable/);
  assert.match(r.stderr, /do NOT --pin over it/);
  assert.doesNotMatch(r.stderr, /no baseline at/);
});

test("an unreadable .fleet directory refuses with its own message, not the no-baseline one", (t) => {
  if (process.geteuid?.() === 0) return t.skip("root searches a mode-600 directory regardless");
  const root = repo(t);
  pin(root);
  const dir = join(root, ".fleet");
  // Missing +x hides everything under `dir` from stat(2): `[ -e "$base" ]`
  // reads FALSE the same as if the baseline were never pinned. Restored
  // right after the assertions rather than in t.after — node:test runs
  // t.after callbacks in REGISTRATION order, so a later-registered restore
  // would fire after repo(t)'s own cleanup already tried (and failed) to
  // recurse into a directory it cannot search.
  chmodSync(dir, 0o600);
  try {
    const r = run(root);
    assert.equal(r.status, 2);
    // Same distinct-from-absent contract as the file-level case, one level
    // up the path — the fix stops here at the file and misses the
    // directory without this. (#1058)
    assert.match(r.stderr, /\.fleet exists but is unreadable/);
    assert.match(r.stderr, /do NOT --pin over it/);
    assert.doesNotMatch(r.stderr, /no baseline at/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("a dangling symlink baseline refuses with its own message, not the no-baseline one", (t) => {
  const root = repo(t);
  pin(root);
  const base = join(root, ".fleet", "instruments.sha");
  rmSync(base);
  // `-e` dereferences: a symlink whose target is gone reads FALSE, same as
  // an absent baseline, even though the link entry itself is present. `-L`
  // is what tells the two apart. (#1058)
  symlinkSync(join(root, ".fleet", "missing-target"), base);
  const r = run(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exists but is unreadable/);
  assert.match(r.stderr, /do NOT --pin over it/);
  assert.doesNotMatch(r.stderr, /no baseline at/);
});

test("cwd outside a git checkout refuses instead of certifying nothing", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-bare-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  // A package is installed under the fixture HOME, so the Install root
  // resolves and only the missing checkout can be what refuses.
  const r = run(root, ["--pin"], { env: { HOME: npmHome(t).home } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not inside a git checkout/);
  assert.doesNotMatch(r.stderr, /no omp plugin/);
});

test("a bad argument refuses rather than falling through to a check", (t) => {
  const root = repo(t);
  pin(root);
  const r = run(root, ["--pn"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("--repo with a missing path argument refuses with usage", (t) => {
  const root = repo(t);
  pin(root);
  const r = run(root, ["--repo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("--repo with an empty path or a non-repo directory refuses, and writes nothing", (t) => {
  const root = repo(t);

  const empty = run(root, ["--pin", "--repo", ""]);
  assert.equal(empty.status, 2, empty.stderr);
  assert.match(empty.stderr, /--repo requires a non-empty path/);

  const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "instruments-not-a-repo-")));
  t.after(() => rmSync(notARepo, { recursive: true, force: true }));
  const nonRepo = run(root, ["--pin", "--repo", notARepo]);
  assert.equal(nonRepo.status, 2, nonRepo.stderr);
  assert.match(nonRepo.stderr, /not inside a git checkout/);

  // Neither refusal writes anything: not into cwd's own repo — the silent
  // fallback an empty --repo took before this guard existed, measured in
  // PR #1350 review — and not into the directory named by the bad --repo
  // path either.
  assert.deepEqual(findFleetDirs(root), []);
  assert.deepEqual(findFleetDirs(notARepo), []);
});

// A signal mid-check is "could not answer", never "changed": merge-gate reads
// exit 1 as instrument-set-changed and any other failure as
// instruments-unanswerable, so INT, HUP and TERM must leave at exit 2 (#3914).
// A stub `shasum` first on PATH writes a marker, then sleeps in the script's
// foreground, so the signal lands mid-hash. sh defers a trap until its
// foreground child returns, so the signal goes to the script's whole process
// group — spawned `detached`, the group is its own — and the sleep dies with
// it. A run with no marker 10 s after it started, or not finished 10 s after
// the signal — the script still running, or anything holding its output open —
// has its group SIGKILLed and fails here rather than hanging or leaving the
// sleep behind.
test("INT, HUP and TERM mid-check exit 2, never 1 — a signalled check could not answer", async (t) => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    await t.test(signal, async (st) => {
      const root = repo(st);
      pin(root);
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "instruments-signal-")));
      st.after(() => rmSync(scratch, { recursive: true, force: true }));
      const bin = join(scratch, "bin");
      // TMPDIR keeps the script's temp file inside this scratch dir wherever
      // mktemp honours it. macOS mktemp with no template ignores TMPDIR, so
      // the file's removal is not asserted here: on macOS the check would pass
      // whether or not anything removed it.
      const tmp = join(scratch, "tmp");
      const marker = join(scratch, "hashing");
      mkdirSync(bin);
      mkdirSync(tmp);
      writeFileSync(join(bin, "shasum"), `#!/bin/sh\n: > '${marker}'\nexec sleep 600\n`);
      chmodSync(join(bin, "shasum"), 0o755);

      const child = spawn(join(root, SET, "scripts", "instruments.sh"), [], {
        cwd: root,
        env: { ...ENV, HOME: HOMES.get(root), PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (d) => (output += d));
      }
      let done = false;
      const exited = new Promise((resolve) =>
        child.on("close", (status, sig) => {
          done = true;
          resolve({ status, sig });
        }),
      );
      const killGroup = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      };
      let guard;
      let guardFired = false;
      try {
        const deadline = Date.now() + 10_000;
        while (!existsSync(marker) && !done && Date.now() < deadline) await pause(20);
        assert.ok(existsSync(marker), `the stub shasum never started\n${output}`);
        guard = setTimeout(() => {
          guardFired = true;
          killGroup();
        }, 10_000);
        process.kill(-child.pid, signal);
        const r = await exited;
        assert.ok(!guardFired, `instruments.sh, or something holding its output open, was still running 10 s after ${signal}\n${output}`);
        assert.equal(r.sig, null, `${signal} killed instruments.sh instead of its trap exiting\n${output}`);
        assert.equal(r.status, 2, `${signal}: ${output}`);
      } finally {
        clearTimeout(guard);
        if (!done) {
          killGroup();
          await exited;
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// ACCEPT. Everything below is an ordinary run, and every one of them must stay
// exit 0. These are what keep the guard from becoming noise.
// ---------------------------------------------------------------------------

test("a bare touch is accepted — content is hashed, not the stat cache", (t) => {
  const root = repo(t);
  pin(root);
  const later = new Date(Date.now() + 60_000);
  utimesSync(inst(root, "scripts", "ci-state.mjs"), later, later);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

// The gap instruments.sh's own header names, pinned from the accept side
// so that folding modes into the digest goes red HERE and sends whoever does
// it at that paragraph, rather than leaving the file claiming a coverage it
// stopped having (#1059).
test("a mode-only change to an instrument is accepted — modes are not in the digest", (t) => {
  const root = repo(t);
  pin(root);
  const f = inst(root, "scripts", "ci-state.mjs");
  chmodSync(f, 0o755);
  assert.equal(statSync(f).mode & 0o777, 0o755, "fixture: the mode really flipped");
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

test("a change outside the set is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, "unrelated.md"), "rewritten by the run\n");
  writeFileSync(join(root, "brand-new.md"), "an output the fleet wrote\n");
  assert.equal(run(root).status, 0);
});

// The acceptance case for dropping the commit relation: the workspace
// checkout moving under a run is ordinary — the pin certifies the installed
// package, which a fast-forward does not touch — so it must not refuse,
// however many tracked files move, `plugin/…` included.
test("a fast-forward of the workspace checkout after the pin is exit 0, silently", (t) => {
  const root = repo(t);
  const digest = pin(root);
  git(root, "checkout", "-q", "-b", "ahead");
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('a newer main');\n");
  writeFileSync(join(root, "unrelated.md"), "merged by another session\n");
  git(root, "commit", "-qam", "a newer main");
  git(root, "checkout", "-q", "main");
  const before = git(root, "rev-parse", "HEAD");
  git(root, "merge", "-q", "--ff-only", "ahead");
  assert.notEqual(git(root, "rev-parse", "HEAD"), before, "fixture: HEAD really moved");
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, `${digest}\n`);
  assert.equal(r.stderr, "");
});

test("--pin re-baselines after a deliberate edit — the controller's own tooling-fix path", (t) => {
  const root = repo(t);
  const first = pin(root);
  writeFileSync(inst(root, "skills", "run-team", "SKILL.md"), "# fixed mid-run\n");
  assert.equal(run(root).status, 1);
  const second = pin(root);
  assert.notEqual(second, first);
  assert.equal(run(root).status, 0);
});

// ---------------------------------------------------------------------------
// THE BASELINE. `--pin` writes the digest, the Install root it certified and
// the package's version, in that order. Only the digest decides a verdict;
// the root decides a refusal to look, and the version only names what moved.
// ---------------------------------------------------------------------------

const baselineLines = (root) =>
  readFileSync(join(root, ".fleet", "instruments.sha"), "utf8").split("\n");

test("--pin writes digest, root and version in that order, and a re-pin rewrites all three", (t) => {
  const root = repo(t);
  const digest = pin(root);
  assert.deepEqual(baselineLines(root), [digest, `root=${PKGS.get(root)}`, "version=3.102.7", ""]);

  writeFileSync(inst(root, "package.json"), `${JSON.stringify({ name: "@feigi/fleet-ctl", version: "3.103.0" })}\n`);
  writeFileSync(inst(root, "skills", "run-team", "SKILL.md"), "# a newer release\n");
  const redigest = pin(root);
  assert.notEqual(redigest, digest);
  assert.deepEqual(baselineLines(root), [redigest, `root=${PKGS.get(root)}`, "version=3.103.0", ""]);
});

test("stdout is the digest alone on exit 0 and on exit 1, whatever the refusal prints", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const ok = run(root);
  assert.equal(ok.stdout, `${digest}\n`);
  writeFileSync(inst(root, "skills", "run-team", "SKILL.md"), "# moved\n");
  const hit = run(root);
  assert.equal(hit.status, 1);
  assert.match(hit.stdout, /^[0-9a-f]{64}\n$/);
  assert.notEqual(hit.stdout, `${digest}\n`);
});

test("a refusal names the pinned and the current version and prints no git output — a package has no HEAD", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(inst(root, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /HEAD|pin commit|commit=/);
  assert.doesNotMatch(r.stderr, / M plugin\//, "no `git status` porcelain line");
});

// ---------------------------------------------------------------------------
// CWD CONTRACT (#1337). The state home — the checkout whose `.fleet/` holds
// the baseline — comes from $PWD (or --repo), never from where the invoked
// copy of instruments.sh happens to live; the tree it certifies is the
// Install root under $HOME. Every test below places the SCRIPT somewhere
// other than the repo whose baseline it must use, which the tests above never
// do — proving the state-home resolution is cwd-driven, not merely untested
// against $0.
// ---------------------------------------------------------------------------

// A plugin-cache-shaped fixture: instruments.sh nested several directories
// deep inside a FOREIGN git repository — the shape a plugin cache directory
// takes when it is itself nested inside the operator's personal dotfiles
// checkout (#1337's own report, measured pre-cutover). Built with `git init`
// in a fresh temp dir, never the real checkout or a real cache directory.
function foreignAncestorCache(t) {
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), "instruments-foreign-")));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  git(foreign, "init", "-q", "-b", "main");
  writeFileSync(join(foreign, "foreign.md"), "the operator's unrelated repo\n");
  git(foreign, "add", "-A");
  git(foreign, "commit", "-qm", "foreign root");
  const cacheDir = join(foreign, "plugins", "cache", "fleet-plugin", "fleet", "0.1.1", "scripts");
  mkdirSync(cacheDir, { recursive: true });
  const script = join(cacheDir, "instruments.sh");
  copyFileSync(SCRIPT, script);
  return { foreign, script };
}

test("(1) run from an installed cache nested in a foreign repo, cwd inside a separate repo, keeps its baseline in the cwd repo", (t) => {
  const cwdRepo = repo(t);
  const { foreign, script } = foreignAncestorCache(t);
  const r = spawnSync(script, ["--pin"], { cwd: cwdRepo, env: { ...ENV, HOME: HOMES.get(cwdRepo) }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // The tree it reports is the Install root — here the cwd repo's package —
  // never the cache the script itself ran out of.
  assert.match(r.stderr, /pinned/);
  assert.ok(
    r.stderr.includes(`over npm-install ${PKGS.get(cwdRepo)} (`),
    `expected the pin report to name ${PKGS.get(cwdRepo)}, got: ${r.stderr}`,
  );
  assert.ok(existsSync(join(cwdRepo, ".fleet", "instruments.sha")));
  assert.equal(findFleetDirs(foreign).length, 0, "the foreign ancestor must never gain a .fleet directory");
});

test("(2) cwd outside any git repository refuses, non-zero, and writes nothing anywhere in the temp tree", (t) => {
  const { foreign, script } = foreignAncestorCache(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "instruments-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const r = spawnSync(script, ["--pin"], { cwd: outside, env: ENV, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not inside a git checkout/);
  assert.deepEqual(findFleetDirs(outside), []);
  assert.deepEqual(findFleetDirs(foreign), []);
});

test("(3) --repo names the state home regardless of the working directory", (t) => {
  const target = repo(t);
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "instruments-elsewhere-")));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  git(elsewhere, "init", "-q", "-b", "main");
  writeFileSync(join(elsewhere, "x.md"), "a repo that must not be audited\n");
  git(elsewhere, "add", "-A");
  git(elsewhere, "commit", "-qm", "elsewhere");

  const r = run(target, ["--pin", "--repo", target], { cwd: elsewhere });
  assert.equal(r.status, 0, r.stderr);
  const pinnedDigest = r.stdout.trim();
  assert.ok(existsSync(join(target, ".fleet", "instruments.sha")));
  assert.deepEqual(findFleetDirs(elsewhere), []);

  // And the reverse: cwd IS a DIFFERENT repo but --repo points at the
  // already-pinned target — the flag wins either way, not merely when it
  // agrees with cwd, and the check reads the target's own baseline, not
  // anything under `other`, against the same Install root.
  const other = repo(t);
  const r2 = run(other, ["--repo", target], { env: { HOME: HOMES.get(target) } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout.trim(), pinnedDigest);
  assert.deepEqual(findFleetDirs(other), []);
});

test("(4) --pin from a directory nested inside a foreign git repo never writes into that ancestor", (t) => {
  // The foreign repo is the ANCESTOR directory tree, holding BOTH a
  // plugin-cache-shaped copy of instruments.sh AND, elsewhere under the same
  // ancestor, a SEPARATE nested git checkout used as cwd — the shape the
  // operator's dotfiles checkout takes when it is itself a git repo, the
  // plugin cache sits under one of its subdirectories, and a fleet-plugin
  // checkout is ALSO nested somewhere under that same dotfiles tree. Script
  // location and cwd deliberately differ here — same discriminating shape as
  // test (1), but with the audited repo an ANCESTOR-DESCENDANT of the
  // foreign repo rather than a disjoint tree, which is what "whose ancestor
  // is a foreign git repo" names. Old own-location resolution would walk up
  // from the cache script to the foreign root and pin there; this pins that
  // --pin never does.
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), "instruments-nest-foreign-")));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  git(foreign, "init", "-q", "-b", "main");
  writeFileSync(join(foreign, "foreign.md"), "the ancestor repo\n");
  git(foreign, "add", "-A");
  git(foreign, "commit", "-qm", "foreign root");

  const cacheDir = join(foreign, "plugins", "cache", "fleet-plugin", "fleet", "0.1.1", "scripts");
  mkdirSync(cacheDir, { recursive: true });
  const script = join(cacheDir, "instruments.sh");
  copyFileSync(SCRIPT, script);

  const nestedDir = join(foreign, "dev", "fleet-plugin");
  mkdirSync(nestedDir, { recursive: true });
  git(nestedDir, "init", "-q", "-b", "main");
  mkdirSync(join(nestedDir, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(nestedDir, "plugin", "scripts", "ci-state.mjs"), "console.log('green');\n");
  git(nestedDir, "add", "-A");
  git(nestedDir, "commit", "-qm", "nested fixture");

  const r = spawnSync(script, ["--pin"], {
    cwd: nestedDir,
    env: { ...ENV, HOME: npmHome(t).home },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(nestedDir, ".fleet", "instruments.sha")));
  // Only the nested repo's own .fleet exists; the foreign ancestor's own root
  // never gains one, and no other .fleet appears anywhere under it either —
  // in particular not one sitting directly in the foreign root, which is
  // where the old own-location contract would have written it.
  assert.deepEqual(findFleetDirs(foreign), [join(nestedDir, ".fleet")]);
});

// --- #1020: the ambient GIT_WORK_TREE that moves the state home.
//
// One case, not two, and that is a measurement rather than an omission.
// GIT_DIR is unset by the script alongside GIT_WORK_TREE, but it is INERT
// here: the only git call is `rev-parse --show-toplevel`, and both the digest
// and the baseline are read from the FILES ON DISK, so pointing the object
// database elsewhere changes neither. A fixture for that half could only be
// vacuous — precisely the shape PR #1015 warned about — so the line's GIT_DIR
// half is pinned as source by ambient-git-vars-prose.test.mjs instead.
test("(5) an ambient GIT_WORK_TREE cannot certify a tampered Install root from a twin's baseline (#1020)", (t) => {
  // #1337's defect through the environment. That ticket established that the
  // state home is the WORKING DIRECTORY's checkout; `rev-parse
  // --show-toplevel` answers with the ambient work tree the moment one is
  // set, so the baseline path moves — and a baseline that LOOKS coherent is
  // exactly what makes the result worse than none.
  //
  // Both checkouts share ONE package install, so their roots agree and only
  // the digests differ: `here` pinned the honest package, `twin` pinned it
  // after the tamper.
  const here = repo(t);
  const twin = repo(t, { home: HOMES.get(here), pkg: PKGS.get(here) });
  const honest = pin(here);
  writeFileSync(inst(here, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const tampered = pin(twin);
  assert.notEqual(honest, tampered, "fixture: the twin's baseline must hold the tampered digest");

  const control = run(here);
  assert.equal(control.status, 1, `fixture: the tamper must really be detectable\n${control.stderr}`);
  assert.match(control.stderr, /instrument set CHANGED/);
  assert.equal(run(twin).status, 0,
    "fixture: the twin's baseline must genuinely certify the tampered package, or the poisoned run could not pass for its sake");

  const r = run(here, [], { env: { GIT_WORK_TREE: twin } });

  assert.equal(r.status, 1,
    `an ambient GIT_WORK_TREE must not let a tampered Install root be certified from another checkout's baseline — a gate that passes on a tree nobody looked at is worse than no gate; got ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /instrument set CHANGED/,
    "and it must refuse for the real reason rather than tripping over the variable");
});

// --- #3845: the certified tree is the live Install root ---
//
// fleet-run executes `<Install root>/scripts/<name>` and omp loads the
// runbooks from the same tree, so that is the tree the pin certifies — never
// the checkout the run stands in, which only `.fleet/` is taken from. Three
// install kinds, told apart the way fleet-provenance tells them: a real
// directory (npm-install) and a link into omp's plugin cache
// (marketplace-install) are hashed file by file; any other link
// (linked-checkout) is refused at pin and at check (#4037). The check
// compares the baseline's `root=` with the live root and never follows it.

// A consumer workspace: a real git checkout with no plugin/ tree at all.
function wsRepo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-ws-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "consumer workspace — no plugin/ tree\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

const baselineOf = (dir) => readFileSync(join(dir, ".fleet", "instruments.sha"), "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rootChanged = (live, kind, rec) =>
  `instruments: Install root now resolves to ${live} (${kind}), pinned ${rec} — the installed plugin changed under this run; the maintainer adopts it (re-pin) or restores the pinned install\n`;

test("a package install pins its realpath and version from a workspace that tracks no plugin/, and a missing workflows/ is tolerated", (t) => {
  const { home, pkg } = npmHome(t, "3.102.7");
  assert.equal(existsSync(join(pkg, "workflows")), false, "fixture: the package has no workflows/");
  const ws = wsRepo(t);
  const r = runAt(ws, home, ["--pin"]);
  assert.equal(r.status, 0, r.stderr);
  const digest = r.stdout.trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(r.stdout, `${digest}\n`, "stdout is the digest alone");
  assert.equal(baselineOf(ws), `${digest}\nroot=${pkg}\nversion=3.102.7\n`);
  assert.equal(r.stderr, `instruments: pinned ${digest} over npm-install ${pkg} (version 3.102.7)\n`);
  assert.deepEqual(findFleetDirs(home), [], "the certified tree gains no state of its own");
  const ok = runAt(ws, home);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${digest}\n`);
});

test("a package with no readable version pins without a version= line, and says so", (t) => {
  const { home, pkg } = npmHome(t);
  // A nested "version" must not answer for the package.
  writeFileSync(join(pkg, "package.json"), `{"name": "@feigi/fleet-ctl", "engines": {"version": "9.9.9"}}\n`);
  const ws = wsRepo(t);
  const r = runAt(ws, home, ["--pin"]);
  assert.equal(r.status, 0, r.stderr);
  const digest = r.stdout.trim();
  assert.equal(baselineOf(ws), `${digest}\nroot=${pkg}\n`);
  assert.equal(r.stderr, `instruments: pinned ${digest} over npm-install ${pkg} (version ?)\n`);
  rmSync(join(pkg, "package.json"));
  assert.equal(runAt(ws, home).status, 0, "no package.json at all is no refusal either");
});

test("a one-byte change under a package's scripts/ is exit 1, naming the versions and printing no git output", (t) => {
  const { home, pkg } = npmHome(t, "3.102.7");
  const ws = wsRepo(t);
  const digest = runAt(ws, home, ["--pin"]).stdout.trim();
  writeFileSync(join(pkg, "scripts", "ci-state.mjs"), "console.log('greeN');\n");
  const r = runAt(ws, home);
  assert.equal(r.status, 1, r.stderr);
  assert.notEqual(r.stdout.trim(), digest);
  assert.equal(r.stderr, [
    `instruments: instrument set CHANGED under this run — expected ${digest}`,
    "instruments: refuse the gate and report. Do NOT re-read the instrument.",
    `instruments: npm-install ${pkg}: version 3.102.7 pinned, 3.102.7 now`,
    "instruments: the installed package changed or was reinstalled — the maintainer adopts it (re-pin) or restores version 3.102.7",
    "",
  ].join("\n"));

  // A reinstall of another release in place: the same root, other bytes.
  writePackage(pkg, "3.103.0");
  writeFileSync(join(pkg, "scripts", "ci-state.mjs"), "console.log('upgraded');\n");
  const upgraded = runAt(ws, home);
  assert.equal(upgraded.status, 1, upgraded.stderr);
  assert.match(upgraded.stderr, /: version 3\.102\.7 pinned, 3\.103\.0 now$/m);
  assert.match(upgraded.stderr, /restores version 3\.102\.7$/m);
});

test("under a package install the workspace checkout's own plugin/ is not the set, and moving the workspace with its .fleet/ does not refuse", (t) => {
  const { home } = npmHome(t);
  const ws = repo(t); // a workspace that DOES track plugin/
  const digest = runAt(ws, home, ["--pin"]).stdout.trim();
  writeFileSync(join(ws, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = runAt(ws, home);
  assert.equal(r.status, 0, `the checkout is not what executes, so its bytes are not the verdict\n${r.stderr}`);
  assert.equal(r.stdout, `${digest}\n`);

  const moved = `${ws}-moved`;
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  renameSync(ws, moved);
  const after = runAt(moved, home);
  assert.equal(after.status, 0, `the baseline records the Install root, not the workspace\n${after.stderr}`);
  assert.equal(after.stdout, `${digest}\n`);
});

test("files mode: an added file under skills/ and a changed dotfile are exit 1; a changed package.json is exit 0", (t) => {
  const { home, pkg } = npmHome(t);
  const ws = wsRepo(t);
  writeFileSync(join(pkg, "scripts", ".env"), "A=1\n");
  const digest = runAt(ws, home, ["--pin"]).stdout.trim();

  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@feigi/fleet-ctl", version: "3.102.7", description: "rewritten" })}\n`);
  const pj = runAt(ws, home);
  assert.equal(pj.status, 0, `package.json is outside the set\n${pj.stderr}`);
  assert.equal(pj.stdout, `${digest}\n`);

  writeFileSync(join(pkg, "scripts", ".env"), "A=2\n");
  assert.equal(runAt(ws, home).status, 1, "a dotfile is in the set");
  writeFileSync(join(pkg, "scripts", ".env"), "A=1\n");
  assert.equal(runAt(ws, home).status, 0, "control: restoring the dotfile restores the pin");

  writeFileSync(join(pkg, "skills", "run-team", "extra.md"), "# smuggled\n");
  assert.equal(runAt(ws, home).status, 1, "an added file under skills/ is in the set — nothing in a package is untracked");
});

test("files mode: a package with none of the five directories, or only empty ones, refuses to pin, exit 2", (t) => {
  const home = fakeHome(t);
  const pkg = entryOf(home);
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), `{"version": "1.0.0"}\n`);
  writeFileSync(join(pkg, "README.md"), "top level only\n");
  const ws = wsRepo(t);
  const message = `instruments: no file under ${pkg} for: commands scripts skills agents workflows — refusing to certify an empty instrument set\n`;
  const none = runAt(ws, home, ["--pin"]);
  assert.equal(none.status, 2, none.stdout + none.stderr);
  assert.equal(none.stderr, message);
  mkdirSync(join(pkg, "scripts"));
  const empty = runAt(ws, home, ["--pin"]);
  assert.equal(empty.status, 2, empty.stdout + empty.stderr);
  assert.equal(empty.stderr, message);
  assert.deepEqual(findFleetDirs(ws), [], "a refused pin writes no baseline");
});

test("files mode: a symlink is hashed by its target's bytes; a dangling one, or one to a directory, refuses exit 2", (t) => {
  const { home, pkg } = npmHome(t);
  const ws = wsRepo(t);
  writeFileSync(join(pkg, "lib.mjs"), "export const x = 1;\n");
  const link = join(pkg, "scripts", "lib.mjs");
  symlinkSync("../lib.mjs", link);
  const digest = runAt(ws, home, ["--pin"]).stdout.trim();

  writeFileSync(join(pkg, "lib.mjs"), "export const x = 2;\n");
  assert.equal(runAt(ws, home).status, 1, "the link's target changed, so the set did");
  writeFileSync(join(pkg, "lib.mjs"), "export const x = 1;\n");
  // The link's own text is not what is hashed: a regular file holding the
  // target's bytes in its place digests the same.
  rmSync(link);
  writeFileSync(link, "export const x = 1;\n");
  const same = runAt(ws, home);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.stdout, `${digest}\n`);

  symlinkSync("missing.mjs", join(pkg, "scripts", "gone.mjs"));
  const dangling = runAt(ws, home);
  assert.equal(dangling.status, 2, dangling.stdout + dangling.stderr);
  assert.match(dangling.stderr, /gone\.mjs/);
  assert.match(dangling.stderr, /could not hash every file/);
  assert.equal(dangling.stdout, "");
  rmSync(join(pkg, "scripts", "gone.mjs"));

  symlinkSync("../skills", join(pkg, "scripts", "dir-link"));
  const dir = runAt(ws, home, ["--pin"]);
  assert.equal(dir.status, 2, dir.stdout + dir.stderr);
  assert.match(dir.stderr, /dir-link/);
  assert.equal(baselineOf(ws).split("\n")[0], digest, "a refused re-pin leaves the baseline it could not replace");
});

test("a link into $HOME/.omp/plugins/cache/ is a marketplace install, pinned in files mode", (t) => {
  const home = fakeHome(t);
  const cache = join(home, ".omp", "plugins", "cache", "fleet-ctl", "3.102.7");
  writePackage(cache, "3.102.7");
  symlinkSync(cache, entryOf(home));
  const ws = wsRepo(t);
  const r = runAt(ws, home, ["--pin"]);
  assert.equal(r.status, 0, r.stderr);
  const digest = r.stdout.trim();
  assert.equal(baselineOf(ws), `${digest}\nroot=${cache}\nversion=3.102.7\n`);
  assert.equal(r.stderr, `instruments: pinned ${digest} over marketplace-install ${cache} (version 3.102.7)\n`);
  // Files mode digests the payload, not where it is installed.
  const npm = npmHome(t, "3.102.7");
  assert.equal(runAt(wsRepo(t), npm.home, ["--pin"]).stdout.trim(), digest);
});

test("a package's pin is its files-mode digest byte for byte: every file under the five directories, in byte order, then the digest of those lines", (t) => {
  const { home, pkg } = npmHome(t, "3.102.7");
  // `B.mjs` sorts before `a.mjs` in byte order and after it in a locale
  // collation, and the list as a whole reads differently backwards, so only
  // the byte-order sort the digest is defined over reproduces it.
  writeFileSync(join(pkg, "scripts", "B.mjs"), "upper\n");
  writeFileSync(join(pkg, "scripts", "a.mjs"), "lower\n");
  const r = runAt(wsRepo(t), home, ["--pin"]);
  assert.equal(r.status, 0, r.stderr);
  // The digest recomputed from its definition: `shasum -a 256` over every
  // file under the component directories, paths relative to the realpath,
  // in byte order, then the digest of those lines.
  const listed = [
    "agents/fleet-finisher.agent.md",
    "commands/run-team.md",
    "scripts/B.mjs",
    "scripts/a.mjs",
    "scripts/ci-state.mjs",
    "skills/run-team/SKILL.md",
  ];
  const lines = listed.map((p) => `${sha256(readFileSync(join(pkg, p)))}  ${p}`);
  const digest = sha256(Buffer.from(`${lines.join("\n")}\n`));
  assert.equal(r.stdout, `${digest}\n`);
});

// The checkout a link points into, for the refusal cases below.
const linkTargets = (t) => {
  const checkout = repo(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "instruments-nocheckout-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writePackage(outside);
  return [
    ["a checkout's plugin/", join(checkout, SET)],
    ["a checkout's root", checkout],
    ["a directory outside any checkout", outside],
  ];
};
const linkedRefusal = (to) =>
  `instruments: Install root ${to} is a linked checkout (omp plugin link) — a fleet run executes an installed package; omp plugin uninstall @feigi/fleet-ctl, then omp plugin install @feigi/fleet-ctl, and restart.\n`;

test("a linked checkout refuses exit 2 at pin and at check, naming the link and the install instruction, with nothing on stdout — whatever the link points at", (t) => {
  const root = repo(t);
  pin(root); // a good baseline, so the check reaches the resolution
  const before = baselineOf(root);
  for (const [what, to] of linkTargets(t)) {
    const home = linkHome(t, to);
    for (const args of [["--pin"], []]) {
      const r = run(root, args, { env: { HOME: home } });
      const where = `${what}, ${args.join(" ") || "check"}`;
      assert.equal(r.status, 2, `${where}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr, linkedRefusal(to), where);
      assert.equal(r.stdout, "", `${where}: nothing on stdout`);
      assert.equal(baselineOf(root), before, `${where}: a refusal rewrites nothing`);
    }
  }
});

test("a linked checkout refuses a pin from a workspace with no baseline yet, and writes none", (t) => {
  const ws = wsRepo(t);
  const [, [, to]] = linkTargets(t);
  const r = runAt(ws, linkHome(t, to), ["--pin"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stderr, linkedRefusal(to));
  assert.equal(r.stdout, "");
  assert.deepEqual(findFleetDirs(ws), [], "a refused pin writes no baseline");
});

test("an Install root that changed under the run — a package reinstalled elsewhere, a package moved into omp's cache — refuses exit 2 naming both, and hashes nothing", (t) => {
  const root = repo(t);
  const other = npmHome(t);
  const cacheHome = fakeHome(t);
  const cache = join(cacheHome, ".omp", "plugins", "cache", "fleet-ctl", "3.102.7");
  writePackage(cache, "3.102.7");
  symlinkSync(cache, entryOf(cacheHome));
  // Each live tree is booby-trapped so that hashing it could only fail loudly:
  // a check that hashed before comparing would print that failure instead.
  for (const pkg of [other.pkg, cache]) symlinkSync("nowhere.mjs", join(pkg, "scripts", "trap.mjs"));
  pin(root);
  const cases = [
    ["a package reinstalled elsewhere", other.home, other.pkg, "npm-install"],
    ["a package moved into omp's cache", cacheHome, cache, "marketplace-install"],
  ];
  for (const [what, liveHome, liveRoot, liveKind] of cases) {
    const r = run(root, [], { env: { HOME: liveHome } });
    assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, rootChanged(liveRoot, liveKind, PKGS.get(root)), what);
    assert.equal(r.stdout, "", `${what}: no digest — nothing was hashed`);
  }
});

test("a forged root= naming a byte-identical clone refuses exit 2, and the clone is never certified", (t) => {
  // The attack review measured: tamper the installed instrument, keep the
  // HONEST run-start digest on line 1, set root= to a pristine clone whose
  // bytes hash to exactly that digest. A check that followed the pointer
  // would exit 0 over a tree nobody read.
  const home = repo(t);
  const digest = pin(home);
  const clone = repo(t);
  assert.equal(digest, pin(clone), "fixture: the clone must really match line 1");
  writeFileSync(inst(home, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  writeFileSync(join(home, ".fleet", "instruments.sha"), `${digest}\nroot=${PKGS.get(clone)}\n`);
  const r = run(home);
  assert.equal(r.status, 2, `a forged root= must refuse, not certify the clone\n${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "", "no digest: nothing was hashed, the clone least of all");
  assert.equal(r.stderr, rootChanged(PKGS.get(home), "npm-install", PKGS.get(clone)));
});

test("a legacy one-line baseline refuses exit 2 — it records no root to compare the live one with", (t) => {
  const root = repo(t);
  const digest = pin(root);
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\n`);
  const r = run(root);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stderr, rootChanged(PKGS.get(root), "npm-install", "<none recorded>"));
  assert.equal(r.stdout, "");
});

test("a legacy three-line git-mode baseline refuses exit 2 the same way — its root is a checkout, and its commit= line is read by nothing", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\nroot=${root}\ncommit=${head}\n`);
  const r = run(root);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stderr, rootChanged(PKGS.get(root), "npm-install", root));
  assert.equal(r.stdout, "");
});

test("an Install root that cannot be resolved refuses exit 2, never 1 — no entry, a dangling link, HOME unset or empty", (t) => {
  const root = repo(t);
  pin(root);
  const before = baselineOf(root);
  const empty = fakeHome(t);
  const dangling = fakeHome(t);
  symlinkSync(join(dangling, "gone"), entryOf(dangling));
  const unset = "instruments: HOME is unset — cannot resolve the Install root\n";
  const cases = [
    ["no entry", { HOME: empty }, `instruments: no omp plugin "@feigi/fleet-ctl" at ${entryOf(empty)}\n`],
    ["a dangling link", { HOME: dangling }, `instruments: omp plugin "@feigi/fleet-ctl" link ${entryOf(dangling)} is dangling\n`],
    ["HOME unset", { HOME: undefined }, unset],
    ["HOME empty", { HOME: "" }, unset],
  ];
  for (const [what, env, message] of cases) {
    for (const args of [[], ["--pin"]]) {
      const r = run(root, args, { env });
      assert.equal(r.status, 2, `${what}, ${args.join(" ") || "check"}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr, message, what);
      assert.equal(baselineOf(root), before, `${what}: a refusal rewrites nothing`);
    }
  }
});

test("root= is the Install root fleet-run resolves under the same HOME", (t) => {
  const fleetRun = fileURLToPath(new URL("../plugin/scripts/fleet-run", import.meta.url));
  const resolverRoot = (home) => {
    const r = spawnSync(process.execPath, [fleetRun, "--root"], { env: { ...ENV, HOME: home }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const { home } = npmHome(t);
  const ws = wsRepo(t);
  assert.equal(runAt(ws, home, ["--pin"]).status, 0);
  assert.equal(baselineOf(ws).split("\n")[1], `root=${resolverRoot(home)}`);
});

test("--audit is gone: it refuses as an unknown argument and writes nothing", (t) => {
  const root = repo(t);
  const r = run(root, ["--pin", "--audit", root]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: instruments\.sh \[--pin\] \[--repo <path>\]/);
  assert.deepEqual(findFleetDirs(root), []);
});
