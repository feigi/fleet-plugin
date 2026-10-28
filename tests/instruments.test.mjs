// Regression gate for instruments.sh, the check that says whether the
// controller's instrument set changed under a run (#436). It certifies the
// live Install root under $HOME (#3845); the WORKING DIRECTORY's checkout,
// never the checkout the script itself lives in (#1337), only locates the
// baseline. The install-only dev loop (ADR 0003) means this script normally
// runs out of a plugin cache; resolving from its own location measured
// whatever git checkout happens to CONTAIN that cache path, which was the
// operator's unrelated personal repo, not the plugin's own tree.
//
// The defect it guards is not observable from inside the fleet: a member that
// edits a script in the MAIN checkout — where the controller runs every gate
// probe from — changes what the controller measures with no error, no diff in
// any PR and nothing in the ledger. Measured once, self-caught by the member.
//
// A guard against that has TWO failure classes and this file pins both, because
// a suite that only feeds a guard input it must reject proves it fires, never
// that it discriminates:
//
//   REFUSE — a tracked instrument rewritten, deleted, or newly staged; no
//            baseline; an unreadable one; a cwd outside any git checkout.
//   ACCEPT — an ordinary run: nothing touched, an untracked dropping under the
//            set, a bare `touch`, branch and worktree churn in the shared ref
//            store, and any change outside the set. #436's third acceptance
//            criterion is that an unchanged set costs effectively nothing per
//            gate, and a guard that fires on ordinary runs becomes noise the
//            controller learns to ignore, which is the same defect wearing a
//            different hat.
//            One accepted case is NOT an ordinary run: a mode-only change to
//            a tracked instrument, which a content digest cannot see (#1059).
//
// Every case builds a throwaway checkout and runs the script with its cwd set
// to it — the script finds the baseline's `.fleet/` from $PWD (or --repo) —
// and with HOME set to a fixture whose `@feigi/fleet-ctl` entry is the
// Install root the script certifies (#3845): by default a link to that same
// checkout's `plugin/`, the linked-checkout shape. A fixture repo is measured
// regardless of where the copy of instruments.sh invoked actually lives, and
// neither the live checkout nor a real omp install is ever read: ENV's own
// HOME is an empty directory, so a spawn that names no fixture HOME refuses
// instead of reaching the machine's install.
//
// Zero deps: `node --test tests/instruments.test.mjs`.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
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

// Each repo(t)'s own linked install, so `run(root)` certifies that checkout.
const HOMES = new Map();

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

// realpath: on macOS $TMPDIR is a symlink into /private, and `git rev-parse
// --show-toplevel` reports the resolved form. Comparing the two spellings is a
// fixture bug that reads as a script bug.
function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  mkdirSync(join(root, SET, "skills", "run-team"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  // Two stand-ins for the class the digest covers: an executable probe and a
  // runbook. The controller reads the world through both, from this same tree.
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('green');\n");
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# runbook\n");
  writeFileSync(join(root, "unrelated.md"), "outside the set\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  HOMES.set(root, linkHome(t, join(root, SET)));
  return root;
}

// Runs the copy of instruments.sh that lives INSIDE `root`, with cwd set to
// `root` by default — the state home is derived from cwd, never from
// where the script itself sits, so the default here is what an ordinary
// invocation from inside the checkout looks like — and HOME set to `root`'s
// own linked install, so the tree certified is that checkout. `cwd` is
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
// an Install root that is not a fixture checkout's own `plugin/`.
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

test("a rewritten tracked instrument is exit 1, and the refusal says so", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('red');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /instrument set CHANGED/);
  assert.match(r.stderr, /refuse the gate/i);
  // The controller has to be able to name what moved; two digests cannot.
  assert.match(r.stderr, /ci-state\.mjs/);
});

test("a rewritten runbook is exit 1 too — the instructions are read from the same tree", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# rewritten\n");
  assert.equal(run(root).status, 1);
});

test("restoring the bytes restores exit 0 — the digest is content, not history", (t) => {
  const root = repo(t);
  pin(root);
  const f = join(root, SET, "scripts", "ci-state.mjs");
  writeFileSync(f, "console.log('red');\n");
  assert.equal(run(root).status, 1);
  writeFileSync(f, "console.log('green');\n");
  assert.equal(run(root).status, 0);
});

test("a tracked instrument deleted from the worktree refuses, and names the file", (t) => {
  const root = repo(t);
  pin(root);
  rmSync(join(root, SET, "scripts", "ci-state.mjs"));
  const r = run(root);
  // Exit 2, not 1: the digest could not be computed at all. Both refuse; only
  // this one is honest that nothing was measured.
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ci-state\.mjs/);
});

test("a newly staged file under the set is exit 1", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", "smuggled.sh"), "#!/bin/sh\nexit 0\n");
  git(root, "add", join(SET, "scripts", "smuggled.sh"));
  assert.equal(run(root).status, 1);
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
  const r = run(root, ["--pin"]);
  assert.equal(r.status, 2);
  // The status alone does not reach this guard. Delete it and the run falls
  // through to `git ls-files`, which fails on the same non-git path and dies
  // with the same code — so the message is what tells the two apart, and the
  // ABSENCE of the downstream one is what says execution stopped here.
  assert.match(r.stderr, /not inside a git checkout/);
  assert.doesNotMatch(r.stderr, /ls-files failed/);
});

test("a checkout with no tracked file under the set refuses to certify it", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-empty-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  writeFileSync(join(root, "only.md"), "x\n");
  git(root, "add", "only.md");
  git(root, "commit", "-qm", "fixture");
  const r = run(root, ["--pin"], { env: { HOME: linkHome(t, join(root, SET)) } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty instrument set/);
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
// it. A run with no marker 10 s after it started, or still going 10 s after
// the signal, has its group SIGKILLed and fails here rather than hanging or
// leaving the sleep behind.
test("INT, HUP and TERM mid-check exit 2, never 1 — a signalled check could not answer", async (t) => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    await t.test(signal, async (st) => {
      const root = repo(st);
      pin(root);
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "instruments-signal-")));
      st.after(() => rmSync(scratch, { recursive: true, force: true }));
      const bin = join(scratch, "bin");
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
      try {
        const deadline = Date.now() + 10_000;
        while (!existsSync(marker) && !done && Date.now() < deadline) await pause(20);
        assert.ok(existsSync(marker), `the stub shasum never started\n${output}`);
        guard = setTimeout(killGroup, 10_000);
        process.kill(-child.pid, signal);
        const r = await exited;
        assert.notEqual(r.sig, "SIGKILL", `instruments.sh was still running 10 s after ${signal}\n${output}`);
        assert.equal(r.sig, null, `${signal} killed instruments.sh instead of its trap exiting\n${output}`);
        assert.equal(r.status, 2, `${signal}: ${output}`);
        assert.deepEqual(readdirSync(tmp), [], "the trap removed its temp file");
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

test("an untracked dropping under the set is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", ".DS_Store"), "\0junk\n");
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs.swp"), "editor\n");
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

test("a bare touch is accepted — content is hashed, not the stat cache", (t) => {
  const root = repo(t);
  pin(root);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, SET, "scripts", "ci-state.mjs"), later, later);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

// The gap instruments.sh's own header now names, pinned from the accept side
// so that folding modes into the digest goes red HERE and sends whoever does
// it at that paragraph, rather than leaving the file claiming a coverage it
// stopped having. Both halves of #1059's repro: the worktree bit and the
// index entry.
test("a mode-only change to a tracked instrument is accepted — modes are not in the digest", (t) => {
  const root = repo(t);
  pin(root);
  const rel = join(SET, "scripts", "ci-state.mjs");
  chmodSync(join(root, rel), 0o755);
  // `diff --summary` rather than `status --porcelain`: this file's `git`
  // helper trims, and porcelain's worktree-only column IS a leading space.
  assert.match(
    git(root, "diff", "--summary", "--", rel),
    /^mode change 100644 => 100755 /,
    "git sees the worktree mode flip",
  );
  const worktreeHalf = run(root);
  assert.equal(worktreeHalf.status, 0, worktreeHalf.stderr);
  // Through the index: the blob is identical, only the entry's mode moves.
  const before = git(root, "ls-files", "-s", "--", rel);
  git(root, "update-index", "--chmod=+x", "--", rel);
  const after = git(root, "ls-files", "-s", "--", rel);
  assert.match(after, /^100755 /);
  assert.equal(after.split(/\s+/)[1], before.split(/\s+/)[1], "the blob is untouched");
  const indexHalf = run(root);
  assert.equal(indexHalf.status, 0, indexHalf.stderr);
});

test("branch and worktree churn in the shared ref store is accepted", (t) => {
  const root = repo(t);
  pin(root);
  // Exactly what claim-ticket.sh and reap.sh do to the main checkout during
  // every fleet run. A ref digest would refuse here, several times per run.
  git(root, "branch", "fix/42-slug");
  git(root, "worktree", "add", "-q", join(root, "wt"), "fix/42-slug");
  assert.equal(run(root).status, 0);
  git(root, "worktree", "remove", "--force", join(root, "wt"));
  git(root, "branch", "-D", "fix/42-slug");
  assert.equal(run(root).status, 0);
});

test("a change outside the set is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, "unrelated.md"), "rewritten by the run\n");
  writeFileSync(join(root, "brand-new.md"), "an output the fleet wrote\n");
  assert.equal(run(root).status, 0);
});

test("a commit that does not change the bytes is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, "unrelated.md"), "rewritten\n");
  git(root, "commit", "-qam", "an ordinary commit outside the set");
  assert.equal(run(root).status, 0);
});

test("--pin re-baselines after a deliberate edit — the controller's own tooling-fix path", (t) => {
  const root = repo(t);
  const first = pin(root);
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# fixed mid-run\n");
  assert.equal(run(root).status, 1);
  const second = pin(root);
  assert.notEqual(second, first);
  assert.equal(run(root).status, 0);
});

// ---------------------------------------------------------------------------
// THE PIN COMMIT (#3780). `--pin` records the audited tree's HEAD as a third
// line, so a refusal can say WHAT moved: advanced, rewound, diverged or
// unmoved. The commit decides no verdict — the digest still does.
// ---------------------------------------------------------------------------

const baselineLines = (root) =>
  readFileSync(join(root, ".fleet", "instruments.sha"), "utf8").split("\n");
const RELATION = /HEAD (advanced|rewound|diverged|unmoved)/;
const editSet = (root, text, message) => {
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), text);
  git(root, "commit", "-qam", message);
};

test("--pin writes digest, root and commit in that order, and a re-pin rewrites all three", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const first = git(root, "rev-parse", "HEAD");
  assert.deepEqual(baselineLines(root), [digest, `root=${root}`, `commit=${first}`, ""]);

  editSet(root, "# fixed mid-run\n", "a deliberate tooling fix");
  const second = git(root, "rev-parse", "HEAD");
  const redigest = pin(root);
  assert.notEqual(redigest, digest);
  assert.deepEqual(baselineLines(root), [redigest, `root=${root}`, `commit=${second}`, ""]);
});

test("--pin on an unborn HEAD writes no commit line, and the check still passes", (t) => {
  const root = repo(t);
  git(root, "update-ref", "-d", "refs/heads/main");
  const digest = pin(root);
  assert.deepEqual(baselineLines(root), [digest, `root=${root}`, ""]);
  assert.equal(run(root).status, 0);
});

test("a refusal after HEAD advanced names the pin commit, says advanced, and lists the commits between", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const pinned = git(root, "rev-parse", "HEAD");
  editSet(root, "# one\n", "first move");
  editSet(root, "# two\n", "second move");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.notEqual(r.stdout.trim(), digest);
  assert.match(r.stderr, /instrument set CHANGED/);
  assert.match(r.stderr, new RegExp(`pin commit ${pinned}`));
  assert.match(r.stderr, /HEAD advanced/);
  assert.match(r.stderr, /^[0-9a-f]{7,} second move$/m);
  assert.match(r.stderr, /^[0-9a-f]{7,} first move$/m);
  assert.doesNotMatch(r.stderr, /rewound|diverged|unmoved/);
  assert.doesNotMatch(r.stderr, /more$/m, "two commits is under the cap");
});

test("a refusal after HEAD rewound behind the pin commit says rewound", (t) => {
  const root = repo(t);
  editSet(root, "# pinned state\n", "the state the run pinned");
  pin(root);
  git(root, "reset", "-q", "--hard", "HEAD~1");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /HEAD rewound/);
  assert.doesNotMatch(r.stderr, /HEAD (advanced|diverged|unmoved)/);
});

test("a refusal with HEAD on a diverged branch says diverged", (t) => {
  const root = repo(t);
  editSet(root, "# pinned state\n", "the state the run pinned");
  pin(root);
  git(root, "checkout", "-q", "-b", "other", "HEAD~1");
  editSet(root, "# another session's edit\n", "elsewhere");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /HEAD diverged/);
  assert.doesNotMatch(r.stderr, /HEAD (advanced|rewound|unmoved)/);
});

test("a history git cannot read between the pin and HEAD says the relation is unknown, never diverged", (t) => {
  const root = repo(t);
  const pinned = git(root, "rev-parse", "HEAD");
  pin(root);
  editSet(root, "# one\n", "first move");
  const middle = git(root, "rev-parse", "HEAD");
  editSet(root, "# two\n", "second move");
  // The true relation is advanced; with the middle commit's object gone, git
  // cannot walk from HEAD back to the pin and `--is-ancestor` exits 128.
  rmSync(join(root, ".git", "objects", middle.slice(0, 2), middle.slice(2)));
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`pin commit ${pinned}`));
  assert.match(r.stderr, new RegExp(middle), "git's own error, naming the object it could not read, comes through");
  assert.match(r.stderr, /HEAD relation unknown/);
  assert.doesNotMatch(r.stderr, RELATION);
});

test("a refusal with HEAD on the pin commit says unmoved, and the porcelain line names the edit", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /HEAD unmoved/);
  assert.match(r.stderr, new RegExp(` M ${SET}/scripts/ci-state\\.mjs`));
  assert.doesNotMatch(r.stderr, /HEAD (advanced|rewound|diverged)/);
});

test("more than twenty commits between the pin and HEAD print twenty log lines, then how many more", (t) => {
  const root = repo(t);
  pin(root);
  for (let i = 1; i <= 25; i++) editSet(root, `# move ${i}\n`, `move ${i}`);
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /HEAD advanced/);
  assert.equal(r.stderr.match(/^[0-9a-f]{7,} move \d+$/gm).length, 20);
  assert.match(r.stderr, /^… 5 more$/m);
  assert.match(r.stderr, /^[0-9a-f]{7,} move 25$/m, "the newest commits are the ones listed");
  assert.doesNotMatch(r.stderr, / move 5$/m);
});

test("exactly twenty commits between print twenty log lines and no more-line", (t) => {
  const root = repo(t);
  pin(root);
  for (let i = 1; i <= 20; i++) editSet(root, `# move ${i}\n`, `move ${i}`);
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stderr.match(/^[0-9a-f]{7,} move \d+$/gm).length, 20);
  assert.doesNotMatch(r.stderr, /… \d+ more/);
});

test("a two-line baseline still refuses a changed set, says it has no pin commit, and prints no relation", (t) => {
  const root = repo(t);
  const digest = pin(root);
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\nroot=${root}\n`);
  assert.equal(run(root).status, 0, "an unchanged set under a legacy baseline still passes");
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /pin commit not recorded/);
  assert.doesNotMatch(r.stderr, RELATION);
  assert.match(r.stderr, new RegExp(` M ${SET}/scripts/ci-state\\.mjs`));
});

test("a pin commit absent from the repository says so, prints no relation, and still refuses", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const missing = "0".repeat(40);
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\nroot=${root}\ncommit=${missing}\n`);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`pin commit ${missing} is not in the repository`));
  assert.doesNotMatch(r.stderr, RELATION);
});

test("a commit= line that is not a hex id is treated as absent, never handed to git as an option", (t) => {
  const root = repo(t);
  const digest = pin(root);
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\nroot=${root}\ncommit=--output=${join(root, "pwned")}\n`);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is not in the repository/);
  assert.doesNotMatch(r.stderr, RELATION);
  assert.equal(existsSync(join(root, "pwned")), false);
});

test("an abbreviated commit= id is treated as absent, never read as a relation", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const short = git(root, "rev-parse", "--short", "HEAD");
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\nroot=${root}\ncommit=${short}\n`);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`pin commit ${short} is not in the repository`));
  assert.doesNotMatch(r.stderr, RELATION);
});

test("a commit= line naming a tree object is treated as absent", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\nroot=${root}\ncommit=${tree}\n`);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`pin commit ${tree} is not in the repository`));
  assert.doesNotMatch(r.stderr, RELATION);
});

test("a refusal with HEAD unreadable names the pin commit, says HEAD cannot be read, and prints no relation", (t) => {
  const root = repo(t);
  pin(root);
  const pinned = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "--orphan", "fresh");
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /HEAD \?$/m);
  assert.match(r.stderr, new RegExp(`pin commit ${pinned}; HEAD cannot be read`));
  assert.doesNotMatch(r.stderr, RELATION);
});

test("stdout is the digest alone on exit 0 and on exit 1, whatever the refusal prints", (t) => {
  const root = repo(t);
  const digest = pin(root);
  const ok = run(root);
  assert.equal(ok.stdout, `${digest}\n`);
  editSet(root, "# moved\n", "a move");
  const hit = run(root);
  assert.equal(hit.status, 1);
  assert.match(hit.stdout, /^[0-9a-f]{64}\n$/);
  assert.notEqual(hit.stdout, `${digest}\n`);
});

test("a commit that changes no byte in the set still exits 0 and prints nothing on stderr under a three-line baseline", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, "unrelated.md"), "rewritten\n");
  git(root, "commit", "-qam", "an ordinary commit outside the set");
  const r = run(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
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
  // The tree it reports is the Install root — here the cwd repo, linked —
  // never the cache the script itself ran out of.
  assert.match(r.stderr, /pinned/);
  assert.ok(
    r.stderr.includes(`over linked-checkout ${cwdRepo} (`),
    `expected the pin report to name ${cwdRepo}, got: ${r.stderr}`,
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
    env: { ...ENV, HOME: linkHome(t, join(nestedDir, "plugin")) },
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

// --- #1020: the ambient GIT_WORK_TREE that moves the audited tree.
//
// One case, not two, and that is a measurement rather than an omission.
// GIT_DIR is unset by the script alongside GIT_WORK_TREE, but it is INERT
// here: `ls-files` only names paths, and both the digest and the baseline are
// read from the FILES ON DISK under `$root`, so pointing the object database
// elsewhere changes neither. Measured against a clean twin holding the exact
// pre-tamper content, the tampered digest came back unchanged and the gate
// still refused. A fixture for that half could only be vacuous — precisely
// the shape PR #1015 warned about — so the line's GIT_DIR half is pinned as
// source by ambient-git-vars-prose.test.mjs instead.
test("(5) an ambient GIT_WORK_TREE cannot certify a tampered tree from a clean twin (#1020)", (t) => {
  // #1337's defect through the environment. That ticket established that the
  // audited tree is the WORKING DIRECTORY's checkout; `rev-parse
  // --show-toplevel` answers with the ambient work tree the moment one is
  // set, so the digest, the `ls-files` listing and the baseline path all move
  // together — which is exactly what makes the result LOOK coherent.
  const here = repo(t);
  const twin = repo(t);

  // Both trees are byte-identical, so they pin to the same digest. That is
  // what makes the twin a usable decoy rather than an obvious mismatch, and
  // asserting it is the fixture's own control: if the two ever diverged, the
  // poisoned run would fail for a reason that is not the retarget.
  assert.equal(pin(here), pin(twin),
    "fixture: the twin must pin to the same digest, or the decoy would be caught by arithmetic rather than by the fix");

  writeFileSync(join(here, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");

  const control = run(here);
  assert.equal(control.status, 1, `fixture: the tamper must really be detectable\n${control.stderr}`);
  assert.match(control.stderr, /instrument set CHANGED/);
  assert.equal(run(twin).status, 0,
    "fixture: the twin must be a tree that genuinely WOULD certify, or the poisoned run could not pass for its sake");

  const r = run(here, [], { env: { GIT_WORK_TREE: twin } });

  assert.equal(r.status, 1,
    `an ambient GIT_WORK_TREE must not let a tampered checkout be certified from a clean one — a gate that passes on a tree nobody looked at is worse than no gate; got ${r.stdout}${r.stderr}`);
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
// (linked-checkout) must point at a checkout's `plugin/` and is hashed as that
// checkout, exactly as a checkout always was. The check compares the
// baseline's `root=` with the live root and never follows it.

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
  assert.match(dangling.stderr, /could not hash every tracked file/);
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

test("a linked checkout's pin is a checkout's pin byte for byte: the tracked set's digest, its toplevel, its HEAD", (t) => {
  const root = repo(t);
  const r = run(root, ["--pin"]);
  assert.equal(r.status, 0, r.stderr);
  // The digest recomputed from its definition: `shasum -a 256` over every
  // tracked file under the five `plugin/…` pathspecs, in `ls-files` order,
  // then the digest of those lines.
  const pathspecs = ["commands", "scripts", "skills", "agents", "workflows"].map((d) => `${SET}/${d}`);
  const listed = git(root, "ls-files", "-z", "--", ...pathspecs).split("\0").filter(Boolean);
  const lines = listed.map((p) => `${sha256(readFileSync(join(root, p)))}  ${p}`);
  const digest = sha256(Buffer.from(`${lines.join("\n")}\n`));
  const head = git(root, "rev-parse", "HEAD");
  assert.equal(r.stdout, `${digest}\n`);
  assert.equal(baselineOf(root), `${digest}\nroot=${root}\ncommit=${head}\n`);
  assert.equal(r.stderr, `instruments: pinned ${digest} over linked-checkout ${root} (commit ${head})\n`);
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

test("a link that is not a checkout's plugin/ refuses exit 2 at pin and at check — the checkout's root, a nested copy, a directory outside any checkout", (t) => {
  const root = repo(t);
  const nested = join(root, "vendor", "plugin");
  cpSync(join(root, SET), nested, { recursive: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "instruments-nocheckout-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  cpSync(join(root, SET), join(outside, "plugin"), { recursive: true });
  pin(root); // a good baseline, so the check reaches the resolution
  const before = baselineOf(root);
  for (const [what, to] of [["the checkout's root", root], ["a nested copy", nested], ["a directory outside any checkout", join(outside, "plugin")]]) {
    const home = linkHome(t, to);
    for (const args of [["--pin"], []]) {
      const r = run(root, args, { env: { HOME: home } });
      assert.equal(r.status, 2, `${what}, ${args.join(" ") || "check"}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr, `instruments: Install root ${to} is not the plugin/ directory of a git checkout — a linked install must point at <checkout>/plugin\n`);
      assert.equal(r.stdout, "");
      assert.equal(baselineOf(root), before, "a refusal rewrites nothing");
    }
  }
});

test("an Install root that changed under the run — package to link, link to package, a link retargeted — refuses exit 2 naming both, and hashes nothing", (t) => {
  const root = repo(t);
  const other = repo(t);
  const { home: npm, pkg } = npmHome(t);
  // Each live tree is booby-trapped so that hashing it could only fail loudly:
  // a check that hashed before comparing would print that failure instead.
  const trapLink = (checkout) => {
    const f = join(checkout, SET, "scripts", "ci-state.mjs");
    renameSync(f, `${f}.away`);
    return () => renameSync(`${f}.away`, f);
  };
  const trapPackage = () => {
    const f = join(pkg, "scripts", "trap.mjs");
    symlinkSync("nowhere.mjs", f);
    return () => rmSync(f);
  };
  const cases = [
    ["package to link", npm, HOMES.get(root), pkg, root, "linked-checkout", () => trapLink(root)],
    ["link to package", HOMES.get(root), npm, root, pkg, "npm-install", trapPackage],
    ["link retargeted", HOMES.get(root), HOMES.get(other), root, other, "linked-checkout", () => trapLink(other)],
  ];
  for (const [what, pinnedHome, liveHome, pinnedRoot, liveRoot, liveKind, trap] of cases) {
    const pinned = run(root, ["--pin"], { env: { HOME: pinnedHome } });
    assert.equal(pinned.status, 0, `${what}: fixture pin\n${pinned.stderr}`);
    const untrap = trap();
    const r = run(root, [], { env: { HOME: liveHome } });
    untrap();
    assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, rootChanged(liveRoot, liveKind, pinnedRoot), what);
    assert.equal(r.stdout, "", `${what}: no digest — nothing was hashed`);
  }
});

test("a forged root= naming a byte-identical clone refuses exit 2, and the clone is never certified", (t) => {
  // The attack review measured: tamper the workspace's instrument (uncommitted),
  // keep the HONEST run-start digest on line 1, set root= to a pristine clone
  // whose bytes hash to exactly that digest. A check that followed the
  // pointer would exit 0 over a tree nobody read.
  const home = repo(t);
  const digest = pin(home);
  const clone = repo(t);
  assert.equal(digest, pin(clone), "fixture: the clone must really match line 1");
  writeFileSync(join(home, SET, "scripts", "ci-state.mjs"), "console.log('TAMPERED');\n");
  writeFileSync(join(home, ".fleet", "instruments.sha"), `${digest}\nroot=${clone}\n`);
  const r = run(home);
  assert.equal(r.status, 2, `a forged root= must refuse, not certify the clone\n${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "", "no digest: nothing was hashed, the clone least of all");
  assert.equal(r.stderr, rootChanged(home, "linked-checkout", clone));
});

test("a legacy one-line baseline refuses exit 2 — it records no root to compare the live one with", (t) => {
  const root = repo(t);
  const digest = pin(root);
  writeFileSync(join(root, ".fleet", "instruments.sha"), `${digest}\n`);
  const r = run(root);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stderr, rootChanged(root, "linked-checkout", "<none recorded>"));
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

test("root= is the Install root fleet-run resolves under the same HOME — the package itself, or the linked checkout's toplevel", (t) => {
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

  const root = repo(t);
  pin(root);
  assert.equal(baselineOf(root).split("\n")[1], `root=${git(resolverRoot(HOMES.get(root)), "rev-parse", "--show-toplevel")}`);
});

test("--audit is gone: it refuses as an unknown argument and writes nothing", (t) => {
  const root = repo(t);
  const r = run(root, ["--pin", "--audit", root]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: instruments\.sh \[--pin\] \[--repo <path>\]/);
  assert.deepEqual(findFleetDirs(root), []);
});
