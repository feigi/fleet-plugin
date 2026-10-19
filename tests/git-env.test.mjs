// This file covers git-env.mjs's exports. `gitEnv()` is the one place the
// scrub #1599 asks every `.mjs` git caller to route through;
// `resolveWorkspace()` (with `workspaceDirFromGitCommonDir()`, its directory
// alone) is the one place #1658 asks every caller that turns a
// `--git-common-dir` answer into the run's workspace to route through, and
// `mainCheckoutDirFromGitCommonDir()` the one for the main checkout's work
// tree — see git-env.mjs's own header for why each is a helper rather than
// one more hand-spelled copy.
//
// What matters for gitEnv() is observable: the two names are gone from what
// it returns, everything else survives, an override cannot smuggle either
// name back in, and the input is never mutated — a caller passing
// `process.env` itself must not have it silently rewritten out from under
// every OTHER thing in this process that reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, renameSync, symlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { FleetDirUnresolvable, fleetFile, scratchRoot } from "../plugin/scripts/fleet-dir.mjs";
import { WorkspaceProbeFailed, gitEnv, mainCheckoutDirFromGitCommonDir, resolveWorkspace, workspaceDirFromGitCommonDir } from "../plugin/scripts/git-env.mjs";
import { BROKEN_GITFILES, bareProject, gitsReason } from "./support/bare-project.mjs";

test("GIT_DIR and GIT_WORK_TREE are absent from the result, even when the base carries them", () => {
  const base = { GIT_DIR: "/somewhere/.git", GIT_WORK_TREE: "/somewhere", PATH: "/bin" };
  const env = gitEnv({}, base);
  assert.equal("GIT_DIR" in env, false);
  assert.equal("GIT_WORK_TREE" in env, false);
  assert.equal(env.PATH, "/bin", "an unrelated var must survive the scrub");
});

test("a base carrying neither name is unaffected beyond the copy", () => {
  const base = { PATH: "/bin", LANG: "C" };
  assert.deepEqual(gitEnv({}, base), { PATH: "/bin", LANG: "C" });
});

test("overrides are merged in, alongside the scrub", () => {
  const base = { GIT_DIR: "/somewhere/.git", PATH: "/bin" };
  const env = gitEnv({ LC_ALL: "C", GH_REPO: "" }, base);
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.GH_REPO, "");
  assert.equal(env.PATH, "/bin");
  assert.equal("GIT_DIR" in env, false, "an override alongside the scrub must not resurrect it");
});

test("an override that itself names GIT_DIR or GIT_WORK_TREE cannot smuggle either back in", () => {
  // The deletes run AFTER the merge, precisely so a caller cannot defeat the
  // scrub by accident — an override map built from some other source that
  // happens to carry either key must not undo what this function exists to
  // do.
  const env = gitEnv({ GIT_DIR: "/attacker/.git", GIT_WORK_TREE: "/attacker" }, { PATH: "/bin" });
  assert.equal("GIT_DIR" in env, false);
  assert.equal("GIT_WORK_TREE" in env, false);
});

test("the base object passed in is never mutated", () => {
  const base = { GIT_DIR: "/somewhere/.git", GIT_WORK_TREE: "/somewhere", PATH: "/bin" };
  const before = { ...base };
  gitEnv({}, base);
  assert.deepEqual(base, before, "a caller passing its own long-lived object must get it back unchanged");
});

test("with no base given, process.env itself is read — not a frozen or empty stand-in", () => {
  const hadDir = "GIT_DIR" in process.env;
  const prevDir = process.env.GIT_DIR;
  process.env.GIT_DIR = "/ambient/.git";
  process.env.FLEET_GIT_ENV_PROBE = "present";
  try {
    const env = gitEnv();
    assert.equal("GIT_DIR" in env, false, "the real ambient GIT_DIR must be scrubbed, not merely a fixture's stand-in for it");
    assert.equal(env.FLEET_GIT_ENV_PROBE, "present", "an unrelated real process.env var must still come through by default");
  } finally {
    if (hadDir) process.env.GIT_DIR = prevDir; else delete process.env.GIT_DIR;
    delete process.env.FLEET_GIT_ENV_PROBE;
  }
});

// ---------------------------------------------------------------------------
// resolveWorkspace() and workspaceDirFromGitCommonDir() — the resolution the
// three callers of #1658 used to hand-spell one apiece (ledger.mjs,
// fleet-state.mjs, board.mjs), now reached through fleet-dir.mjs's
// fleetFile() for every `.fleet/` file. What is observable: which directory a
// given `--git-common-dir` answer names, that an answer carrying nothing is
// `null` rather than a plausible-looking path, that canonicalisation is an
// opt-in only the cockpit among those callers takes, and that a step-2 probe
// which cannot answer throws rather than guessing.

test("an absolute --git-common-dir names the directory holding it", () => {
  assert.equal(workspaceDirFromGitCommonDir("/w/repo/.git", "/elsewhere"), "/w/repo");
});

test("a relative --git-common-dir resolves against the passed cwd, never process.cwd()", () => {
  // git answers this RELATIVE — a bare `.git` — when it runs from a
  // checkout's top level. A resolve() that reached for process.cwd() instead
  // would answer with this test runner's own checkout, which is a real path
  // and therefore a silent wrong answer rather than a failure.
  assert.equal(workspaceDirFromGitCommonDir(".git", "/w/repo"), "/w/repo");
});

test("a real git answer's trailing newline still resolves to the parent directory", () => {
  assert.equal(workspaceDirFromGitCommonDir("/w/repo/.git\n", "/w/repo"), "/w/repo");
});

// Three distinct shapes of "git told us nothing usable", one per way a caller
// can arrive here: `git` exited 0 with an empty stdout, it answered with a
// bare newline, and there was no stdout to read at all (a spawn that never
// ran, or one killed by its own timeout). All three must be `null` — the
// signal each call site's degrade arm branches on. A resolved-looking path
// here would put the run's ledger, its heartbeat or its board under whatever
// `dirname("")` happens to name.
for (const [label, value] of [["an empty answer", ""], ["a newline-only answer", "  \n"], ["no answer at all", undefined]]) {
  test(`${label} resolves to null, never a path`, () => {
    assert.equal(workspaceDirFromGitCommonDir(value, "/w/repo"), null);
  });
}

test("by default the answer is NOT canonicalised — a symlinked route keeps the spelling it arrived with", () => {
  // This default is what ledger.mjs and fleet-state.mjs read (#1658): both
  // PRINT the path they resolve — the ledger in `check`'s JSON and both in
  // their degrade warnings — so canonicalising for them would change their
  // output, not merely their code shape.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-ws-")));
  try {
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "repo"), join(root, "link"));
    assert.equal(workspaceDirFromGitCommonDir(join(root, "link", ".git"), root), join(root, "link"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonicalise: true collapses a symlinked route onto the one real workspace", () => {
  // board-server.mjs's opt-in, and the reason it has one: a second spelling of one
  // workspace derives a second port and a second state directory for a
  // cockpit already being served (#1582).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-ws-link-")));
  try {
    const real = join(root, "repo");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    const viaLink = workspaceDirFromGitCommonDir(join(link, ".git"), root, { canonicalise: true });
    assert.equal(viaLink, real, "the symlinked route must canonicalise onto the real workspace, not merely agree with itself");
    assert.equal(viaLink, workspaceDirFromGitCommonDir(join(real, ".git"), root, { canonicalise: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonicalise: true on a directory that does not exist answers the uncanonicalised path rather than throwing", () => {
  // A workspace removed out from under a running cockpit must not turn
  // resolution into a throw: the caller still gets a usable key, just an
  // uncanonicalised one.
  assert.equal(
    workspaceDirFromGitCommonDir("/no-such-root-1658/repo/.git", "/", { canonicalise: true }),
    "/no-such-root-1658/repo",
  );
});

test("an ambient GIT_DIR naming another repository does not move the step-2 probe", () => {
  // Measured: `git rev-parse --resolve-git-dir` answers the path it is given
  // whatever GIT_DIR names, so the scrub in the probe is defensive. This pins
  // the answer a `.bare` layout gets while GIT_DIR points elsewhere.
  const top = mkdtempSync(join(tmpdir(), "git-env-ambient-"));
  try {
    const proj = join(top, "p");
    mkdirSync(proj);
    execFileSync("git", ["init", "-q", "--bare", join(proj, ".bare")], { stdio: "pipe" });
    writeFileSync(join(proj, ".git"), "gitdir: ./.bare\n");
    execFileSync("git", ["init", "-q", "--bare", join(top, "other.git")], { stdio: "pipe" });
    const had = "GIT_DIR" in process.env;
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(top, "other.git");
    try {
      assert.deepEqual(resolveWorkspace(join(proj, ".bare"), proj), { dir: proj, gitDir: false });
    } finally {
      if (had) process.env.GIT_DIR = prev; else delete process.env.GIT_DIR;
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// A `.bare` project reached through a symlinked parent that the test spells
// itself, so step 2's probe is pinned whatever `os.tmpdir()` is. Handed the
// spelled gitDir instead of its realpath, the probe's answer never matches
// and the workspace re-keys to the spelled `.bare` with `gitDir: true`.
test("a .bare project reached through a symlinked parent resolves to the spelled route, canonical only on request", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-link-")));
  try {
    const proj = join(top, "p");
    mkdirSync(proj);
    execFileSync("git", ["init", "-q", "--bare", join(proj, ".bare")], { stdio: "pipe", env: gitEnv() });
    writeFileSync(join(proj, ".git"), "gitdir: ./.bare\n");
    const link = join(top, "link");
    symlinkSync(proj, link);
    assert.deepEqual(resolveWorkspace(join(link, ".bare"), link), { dir: link, gitDir: false });
    assert.deepEqual(resolveWorkspace(join(link, ".bare"), link, { canonicalise: true }), { dir: proj, gitDir: false });
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// A `git` first on PATH that does `body` on the step-2 probe and is the real
// git for everything else, so that probe is the only thing that differs.
function withStep2Probe(top, body, fn) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(top, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *--resolve-git-dir*) ${body} ;; esac\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}

// Real git, with the ambient repository variables scrubbed off the FIXTURE too.
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  assert.equal(r.status, 0, `test setup: git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function repo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

function commonDirOf(cwd) {
  return git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
}

test("a step-2 probe that cannot answer throws WorkspaceProbeFailed naming the probe, never a guessed workspace", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-probe-")));
  try {
    const { proj } = bareProject(top, gitEnv());
    const bare = join(proj, ".bare");
    withStep2Probe(top, "kill -9 $$", () => {
      assert.throws(() => resolveWorkspace(bare, top), (e) => {
        assert.ok(e instanceof WorkspaceProbeFailed, `expected WorkspaceProbeFailed, got ${e}`);
        assert.equal(e.message, `could not resolve ${join(proj, ".git")}: killed by SIGKILL`);
        return true;
      });
    });
    // The control: the same answer with the real git is a workspace, not a throw.
    assert.deepEqual(resolveWorkspace(bare, top), { dir: proj, gitDir: false });
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a step-2 probe that exits non-zero with nothing on stderr names its exit status", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-silent-")));
  try {
    const { proj } = bareProject(top, gitEnv());
    withStep2Probe(top, "exit 7", () => {
      assert.throws(() => resolveWorkspace(join(proj, ".bare"), top), (e) => {
        assert.ok(e instanceof WorkspaceProbeFailed, `expected WorkspaceProbeFailed, got ${e}`);
        assert.equal(e.message, `could not resolve ${join(proj, ".git")}: git exited 7`);
        return true;
      });
    });
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("an absent <parent>/.git is no, and git is never spawned for it", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-absent-")));
  try {
    const bare = join(top, "x.git");
    git(top, "init", "-q", "--bare", bare);
    const marker = join(top, "spawned");
    withStep2Probe(top, `: > '${marker}'; exit 9`, () => {
      assert.deepEqual(resolveWorkspace(bare, top), { dir: bare, gitDir: true });
    });
    assert.equal(existsSync(marker), false, "the probe must not have been spawned");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a <parent>/.git that cannot be examined throws WorkspaceProbeFailed naming why", { skip: process.getuid?.() === 0 ? "running as root" : false }, () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-lstat-")));
  try {
    const bare = join(top, "x.git");
    git(top, "init", "-q", "--bare", bare);
    chmodSync(top, 0o000);
    try {
      assert.throws(() => resolveWorkspace(bare, "/"), (e) => {
        assert.ok(e instanceof WorkspaceProbeFailed, `expected WorkspaceProbeFailed, got ${e}`);
        assert.ok(e.message.startsWith(`could not resolve ${join(top, ".git")}: EACCES`), e.message);
        return true;
      });
    } finally {
      chmodSync(top, 0o755);
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a .bare project gives the same stores from the root and from two linked worktrees", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-bare-")));
  try {
    const { proj, worktrees } = bareProject(top, gitEnv());
    const cwds = [proj, ...worktrees];
    for (const cwd of cwds) {
      assert.deepEqual(resolveWorkspace(commonDirOf(cwd), cwd), { dir: proj, gitDir: false }, `from ${cwd}`);
    }
    assert.deepEqual(cwds.map((cwd) => fleetFile(null, { cwd })), cwds.map(() => join(proj, ".fleet")));
    assert.equal(new Set(cwds.map((cwd) => scratchRoot({ cwd, home: top }))).size, 1);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// git answers `--resolve-git-dir p/.git` as spelled, `p/.git`, when `.git` is
// a symlink to `.bare`: only step 2's realpath of that answer matches it to
// the git dir, so without it the workspace would re-key to `p/.bare`.
test("a .git symlinked to a sibling .bare resolves to the project, not the git dir", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-bare-symlink-")));
  try {
    const proj = join(top, "p");
    mkdirSync(proj);
    git(proj, "init", "-q", "--bare", join(proj, ".bare"));
    symlinkSync(".bare", join(proj, ".git"));
    assert.deepEqual(resolveWorkspace(realpathSync(join(proj, ".bare")), proj), { dir: proj, gitDir: false });
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

for (const [kind, breakIt] of BROKEN_GITFILES) {
  const skip = kind === "chmod 000" && process.getuid?.() === 0 ? "running as root" : false;
  test(`a ${kind} p/.git from a linked worktree throws, naming .git and git's reason, never resolving to .bare`, { skip }, () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-broken-")));
    try {
      const { proj, worktrees } = bareProject(top, gitEnv());
      const gitfile = join(proj, ".git");
      breakIt(gitfile);
      const reason = `could not resolve ${gitfile}: ${gitsReason(gitEnv(), worktrees[0], gitfile)}`;
      for (const wt of worktrees) {
        assert.throws(() => resolveWorkspace(commonDirOf(wt), wt), (e) => {
          assert.ok(e instanceof WorkspaceProbeFailed, `expected WorkspaceProbeFailed, got ${e}`);
          assert.equal(e.message, reason);
          return true;
        });
        for (const call of [() => fleetFile(null, { cwd: wt }), () => scratchRoot({ cwd: wt, home: top })]) {
          assert.throws(call, (e) => {
            assert.ok(e instanceof FleetDirUnresolvable, `expected FleetDirUnresolvable, got ${e}`);
            assert.equal(e.message, `could not resolve the workspace: ${reason}`);
            return true;
          });
        }
      }
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });
}

// What the fail-closed probe must still ACCEPT: git dirs not named `.git`
// whose parent holds no `.git` that git refuses.
test("two bare repositories in one parent each resolve to their own git dir", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-two-bare-")));
  try {
    for (const name of ["a.git", "b.git"]) git(top, "init", "-q", "--bare", join(top, name));
    for (const name of ["a.git", "b.git"]) {
      const dir = join(top, name);
      assert.deepEqual(resolveWorkspace(commonDirOf(dir), dir), { dir, gitDir: true });
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("two submodules resolve to their own git dirs", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-submodules-")));
  try {
    const parent = repo(join(top, "parent"));
    for (const name of ["a", "b"]) {
      git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", repo(join(top, `origin-${name}`)), name);
    }
    for (const name of ["a", "b"]) {
      const cwd = join(parent, name);
      assert.deepEqual(
        resolveWorkspace(commonDirOf(cwd), cwd),
        { dir: realpathSync(join(parent, ".git", "modules", name)), gitDir: true },
      );
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("two --separate-git-dir siblings resolve to their own git dirs", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-separate-")));
  try {
    for (const name of ["one", "two"]) {
      const work = join(top, `w-${name}`);
      mkdirSync(work);
      git(work, "init", "-q", "--separate-git-dir", join(top, `g-${name}`));
      assert.deepEqual(resolveWorkspace(commonDirOf(work), work), { dir: join(top, `g-${name}`), gitDir: true });
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a plain repository with a nested clone: git exits 0 naming another dir, and the two stay disjoint", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-nested-")));
  try {
    const q = repo(join(top, "Q"));
    const nested = join(q, "foo.git");
    git(top, "clone", "-q", "--bare", q, nested);
    assert.deepEqual(resolveWorkspace(commonDirOf(q), q), { dir: q, gitDir: false });
    assert.deepEqual(resolveWorkspace(commonDirOf(nested), nested), { dir: nested, gitDir: true });
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a .git symlinked to a git dir elsewhere: the workspace follows the link, the main checkout's work tree stays", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "git-env-symgit-")));
  try {
    const proj = join(top, "proj");
    const gitDir = join(top, "g.git");
    execFileSync("git", ["init", "-q", proj], { stdio: "pipe", env: gitEnv() });
    renameSync(join(proj, ".git"), gitDir);
    symlinkSync(gitDir, join(proj, ".git"));
    const answer = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: proj, encoding: "utf8", env: gitEnv() });
    assert.equal(mainCheckoutDirFromGitCommonDir(answer, proj), proj);
    assert.equal(mainCheckoutDirFromGitCommonDir(answer, proj, { canonicalise: true }), proj);
    assert.equal(workspaceDirFromGitCommonDir(answer, proj, { canonicalise: true }), gitDir);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
