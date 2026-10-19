// fleet-dir.mjs's one function, through what it returns and what it throws:
// a real `git init`-ed fixture repository and a real linked worktree, never a
// mocked spawn. What the module does inside — the spawn, the scrub, the bound,
// the join — shows only through the path it hands back, which is the point:
// that path is what every caller's file lands at.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { fleetFile, FleetDirUnresolvable, scratchRoot } from "../plugin/scripts/fleet-dir.mjs";
import { BROKEN_GITFILES, bareProject, gitsReason } from "./support/bare-project.mjs";

// realpath'd: on macOS tmpdir() sits under /var, a symlink to /private/var,
// and git answers a linked worktree's `--git-common-dir` in the resolved form
// while the main checkout's answer is a bare `.git` resolved against `cwd`.
// The caller's own cwd is never symlinked in practice (getcwd() resolves it),
// so the fixture's is not either.
function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// GIT_DIR/GIT_WORK_TREE scrubbed off the FIXTURE too: under an ambient one
// `git init` re-inits whichever directory the variable names instead.
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

// Sets process.env keys for the duration of `fn`, restoring each afterwards —
// fleetFile() builds its child's env from process.env, so this is the
// in-process stand-in for an ambient variable.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("the main checkout and a linked worktree resolve one file under the main checkout's .fleet/", (t) => {
  const main = repo(join(tempDir(t, "fleet-dir-"), "main"));
  const wt = join(main, ".worktrees", "7-slug");
  git(main, "worktree", "add", "-q", "--detach", wt);
  const expected = join(main, ".fleet", "ledger.md");
  assert.equal(fleetFile("ledger.md", { cwd: main }), expected);
  assert.equal(fleetFile("ledger.md", { cwd: wt }), expected,
    "a member in its own worktree must name the run's one file, not a private copy under the worktree");
  mkdirSync(join(wt, "sub", "dir"), { recursive: true });
  assert.equal(fleetFile("ledger.md", { cwd: join(wt, "sub", "dir") }), expected,
    "a subdirectory of a worktree is still that worktree's repository");
});

test("an explicit cwd is the repository asked about, not the process's own", (t) => {
  const main = repo(join(tempDir(t, "fleet-dir-cwd-"), "elsewhere"));
  assert.notEqual(process.cwd(), main);
  assert.equal(fleetFile("shortlist.json", { cwd: main }), join(main, ".fleet", "shortlist.json"));
});

test("a null name answers the .fleet/ directory itself", (t) => {
  const main = repo(join(tempDir(t, "fleet-dir-null-"), "main"));
  assert.equal(fleetFile(null, { cwd: main }), join(main, ".fleet"));
});

// The false-positive half: a workspace path with a space in it is an ordinary
// workspace, and must resolve rather than be read as unresolvable.
test("a workspace whose path carries a space resolves like any other", (t) => {
  const main = repo(join(tempDir(t, "fleet-dir-space-"), "my repo"));
  assert.equal(fleetFile("heartbeat.json", { cwd: main }), join(main, ".fleet", "heartbeat.json"));
});

test("outside any repository it throws FleetDirUnresolvable naming git's own reason", (t) => {
  const bare = tempDir(t, "fleet-dir-norepo-");
  // A ceiling at the fixture's parent, so a repository that happens to
  // enclose the temp directory cannot answer for it.
  withEnv({ GIT_CEILING_DIRECTORIES: tmpdir() + ":" + realpathSync(tmpdir()) }, () => {
    assert.throws(() => fleetFile("ledger.md", { cwd: bare }), (e) => {
      assert.ok(e instanceof FleetDirUnresolvable, `expected FleetDirUnresolvable, got ${e}`);
      assert.ok(e instanceof Error);
      assert.equal(e.name, "FleetDirUnresolvable");
      assert.match(e.message, /^could not resolve --git-common-dir: \S/,
        "the message must carry git's reason, not only the fact of the failure");
      assert.match(e.message, /not a git repository/i);
      return true;
    });
  });
});

test("an ambient GIT_DIR naming another repository does not move the answer", (t) => {
  const root = tempDir(t, "fleet-dir-ambient-");
  const mine = repo(join(root, "mine"));
  const other = repo(join(root, "other"));
  const got = withEnv({ GIT_DIR: join(other, ".git") }, () => fleetFile("ledger.md", { cwd: mine }));
  assert.equal(got, join(mine, ".fleet", "ledger.md"),
    "an ambient GIT_DIR relocated the run's file into the repository it names");
});

// git resolves a symlinked cwd itself, so the symlinked spelling has to reach
// the answer another way: GIT_COMMON_DIR, which git echoes back verbatim and
// which gitEnv() does not scrub.
test("canonicalise: true resolves a symlinked route to its real twin; the default keeps the spelling", (t) => {
  const root = tempDir(t, "fleet-dir-link-");
  const real = repo(join(root, "repo"));
  const link = join(root, "link");
  symlinkSync(real, link);
  // A plain repository to run FROM: a GIT_COMMON_DIR override from inside a
  // linked worktree collides with that worktree's own admin files.
  const cwdRepo = repo(join(root, "cwd-repo"));
  withEnv({ GIT_COMMON_DIR: join(link, ".git") }, () => {
    assert.equal(fleetFile(null, { cwd: cwdRepo, canonicalise: true }), join(real, ".fleet"));
    assert.equal(fleetFile(null, { cwd: cwdRepo }), join(link, ".fleet"),
      "canonicalising is opt-in; the default must keep the path git answered with");
  });
});

test("a git that never answers is killed at timeoutMs and reported as unresolvable", (t) => {
  const bin = tempDir(t, "fleet-dir-hang-");
  const shim = join(bin, "git");
  writeFileSync(shim, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(shim, 0o755);
  const started = Date.now();
  withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
    assert.throws(() => fleetFile("ledger.md", { cwd: bin, timeoutMs: 300 }), (e) => {
      assert.ok(e instanceof FleetDirUnresolvable, `expected FleetDirUnresolvable, got ${e}`);
      assert.match(e.message, /ETIMEDOUT/, "a stall must name itself, not read like an instant refusal");
      return true;
    });
  });
  assert.ok(Date.now() - started < 10_000, "the probe was not held to timeoutMs");
});

// A fake `git` first on PATH, answering `rev-parse` with `body` (a /bin/sh
// script). The module under test spawns the real binary by name, so this is
// the only way to give it a git that fails in a chosen way.
function shimGit(t, prefix, body) {
  const bin = tempDir(t, prefix);
  const shim = join(bin, "git");
  writeFileSync(shim, `#!/bin/sh\n${body}\n`);
  chmodSync(shim, 0o755);
  return bin;
}

function unresolvable(bin, options) {
  let thrown = null;
  withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
    try {
      fleetFile("ledger.md", { cwd: bin, ...options });
    } catch (e) {
      thrown = e;
    }
  });
  assert.ok(thrown instanceof FleetDirUnresolvable, `expected FleetDirUnresolvable, got ${thrown}`);
  return thrown;
}

test("a git that fails silently still has its exit status named", (t) => {
  const e = unresolvable(shimGit(t, "fleet-dir-exit-", "exit 7"));
  assert.match(e.message, /exit 7/, "a silent non-zero exit would otherwise leave the message naming no cause");
});

test("a git killed by a signal has the signal named", (t) => {
  const e = unresolvable(shimGit(t, "fleet-dir-signal-", "kill -9 $$"));
  assert.match(e.message, /SIGKILL/, "a kill that is not the bound's own timeout must still say how git ended");
});

test("whitespace-only stderr falls through to the exit status rather than naming nothing", (t) => {
  const e = unresolvable(shimGit(t, "fleet-dir-blank-", "printf '  \\n\\n' >&2\nexit 3"));
  assert.match(e.message, /exit 3/);
});

test("git's stderr is trimmed before it is named", (t) => {
  const e = unresolvable(shimGit(t, "fleet-dir-trim-", "printf '\\n  boom-reason  \\n\\n' >&2\nexit 128"));
  assert.equal(e.message, "could not resolve --git-common-dir: boom-reason");
});

test("a long stderr is capped, keeping the END where git says why it stopped", (t) => {
  const e = unresolvable(shimGit(t, "fleet-dir-long-",
    "printf 'HEADMARK%s' \"$(awk 'BEGIN{for(i=0;i<1500;i++)printf \"x\"}')\" >&2\nprintf 'TAILMARK' >&2\nexit 128"));
  const prefix = "could not resolve --git-common-dir: ";
  assert.ok(e.message.startsWith(prefix));
  assert.ok(e.message.length - prefix.length <= 500, `the cause was not capped: ${e.message.length - prefix.length} chars`);
  assert.ok(e.message.endsWith("TAILMARK"), "the cap must keep the tail, not the head");
  assert.ok(!e.message.includes("HEADMARK"), "the head of a long stderr must be dropped");
});

// The one case that has to pay the default bound in full: a shim that would
// outlive it by a wide margin, with no `timeoutMs` passed. Raising the default
// to a practically unbounded value turns the ETIMEDOUT into a 20 s wait that
// ends in a different error.
test("with no timeoutMs a git that never answers is still killed, by the default bound", (t) => {
  const bin = shimGit(t, "fleet-dir-default-hang-", "exec sleep 20");
  const started = Date.now();
  const e = unresolvable(bin, {});
  assert.match(e.message, /ETIMEDOUT/, "the default bound must fire and name itself");
  assert.ok(Date.now() - started < 18_000, "the default bound did not hold the probe");
});

// `--git-common-dir` answers; the rule's second probe, `--resolve-git-dir`,
// is the one that dies. A `.bare` project's common dir is not named `.git`
// and the `.git` beside it exists, so that probe runs. Both stores refuse,
// naming that probe — never the common dir as a guessed workspace.
test("a step-2 probe that cannot answer leaves fleetFile() and scratchRoot() unresolvable, naming that probe", (t) => {
  const top = tempDir(t, "fleet-dir-step2-");
  const { proj } = bareProject(top, gitEnv());
  const bare = join(proj, ".bare");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = shimGit(t, "fleet-dir-step2-bin-", `case "$*" in *--resolve-git-dir*) kill -9 $$ ;; esac\nexec '${realGit}' "$@"`);
  const want = `could not resolve the workspace: could not resolve ${join(proj, ".git")}: killed by SIGKILL`;
  withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
    for (const [what, call] of [["fleetFile()", () => fleetFile(null, { cwd: bare })], ["scratchRoot()", () => scratchRoot({ cwd: bare, home: top })]]) {
      assert.throws(call, (e) => {
        assert.ok(e instanceof FleetDirUnresolvable, `${what}: expected FleetDirUnresolvable, got ${e}`);
        assert.equal(e.message, want, `${what}'s refusal`);
        return true;
      });
    }
  });
  // The control: the real git answers, and the workspace is the project.
  assert.equal(fleetFile(null, { cwd: bare }), join(proj, ".fleet"));
});

test("a .bare project gives the same stores from the root and from two linked worktrees", (t) => {
  const top = tempDir(t, "fleet-dir-bare-");
  const { proj, worktrees } = bareProject(top, gitEnv());
  const cwds = [proj, ...worktrees];
  const files = cwds.map((cwd) => fleetFile(null, { cwd }));
  assert.deepEqual(files, cwds.map(() => join(proj, ".fleet")), "every cwd of one project names the project's one .fleet/");
  const roots = cwds.map((cwd) => scratchRoot({ cwd, home: top }));
  assert.equal(new Set(roots).size, 1, `every cwd of one project names one scratch root, got ${roots}`);
  assert.match(roots[0], /\/p-[0-9a-f]{8}$/, "the key is the project's folder, never `.bare`");
});

for (const [kind, breakIt] of BROKEN_GITFILES) {
  // A root reads a file any mode away; there is no refusal to observe.
  const skip = kind === "chmod 000" && process.getuid?.() === 0 ? "running as root" : false;
  test(`a ${kind} p/.git fails a linked worktree's stores closed, never onto .bare`, { skip }, (t) => {
    const top = tempDir(t, "fleet-dir-broken-");
    const { proj, worktrees } = bareProject(top, gitEnv());
    const gitfile = join(proj, ".git");
    breakIt(gitfile);
    const want = `could not resolve the workspace: could not resolve ${gitfile}: ${gitsReason(gitEnv(), worktrees[0], gitfile)}`;
    for (const wt of worktrees) {
      for (const [what, call] of [["fleetFile()", () => fleetFile(null, { cwd: wt })], ["scratchRoot()", () => scratchRoot({ cwd: wt, home: top })]]) {
        assert.throws(call, (e) => {
          assert.ok(e instanceof FleetDirUnresolvable, `${what}: expected FleetDirUnresolvable, got ${e}`);
          assert.equal(e.message, want, `${what}'s refusal`);
          assert.doesNotMatch(e.message, /\.bare\/\.fleet/);
          return true;
        });
      }
    }
  });
}

// The other half: what the guard must ACCEPT. Each layout below has a git dir
// not named `.git`, and none has a `.git` beside it that git refuses.
test("two bare repositories sharing a parent with no .git beside them each resolve to their own git dir", (t) => {
  const top = tempDir(t, "fleet-dir-two-bare-");
  const a = join(top, "a.git");
  const b = join(top, "b.git");
  git(top, "init", "-q", "--bare", a);
  git(top, "init", "-q", "--bare", b);
  assert.equal(fleetFile(null, { cwd: a }), join(a, ".fleet"));
  assert.equal(fleetFile(null, { cwd: b }), join(b, ".fleet"));
  assert.notEqual(scratchRoot({ cwd: a, home: top }), scratchRoot({ cwd: b, home: top }));
});

test("two submodules of one superproject each resolve to their own git dir", (t) => {
  const top = tempDir(t, "fleet-dir-submodules-");
  const sub = (name) => repo(join(top, "origin-" + name));
  const [a, b] = [sub("a"), sub("b")];
  const parent = repo(join(top, "parent"));
  for (const [name, origin] of [["a", a], ["b", b]]) {
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, name);
  }
  const gitDirOf = (name) => realpathSync(join(parent, ".git", "modules", name));
  const roots = new Set();
  for (const name of ["a", "b"]) {
    const cwd = join(parent, name);
    assert.equal(fleetFile(null, { cwd }), join(gitDirOf(name), ".fleet"));
    roots.add(scratchRoot({ cwd, home: top }));
  }
  assert.equal(roots.size, 2, "the two submodules keep disjoint scratch roots");
});

test("two --separate-git-dir siblings each resolve to their own git dir", (t) => {
  const top = tempDir(t, "fleet-dir-separate-");
  const roots = new Set();
  for (const name of ["one", "two"]) {
    const work = join(top, `w-${name}`);
    const gitDir = join(top, `g-${name}`);
    mkdirSync(work);
    git(work, "init", "-q", "--separate-git-dir", gitDir);
    assert.equal(fleetFile(null, { cwd: work }), join(gitDir, ".fleet"));
    roots.add(scratchRoot({ cwd: work, home: top }));
  }
  assert.equal(roots.size, 2);
});

test("a plain repository with a nested clone keeps disjoint stores: git exits 0 naming another dir", (t) => {
  const top = tempDir(t, "fleet-dir-nested-");
  const q = repo(join(top, "Q"));
  const nested = join(q, "foo.git");
  git(top, "clone", "-q", "--bare", q, nested);
  assert.equal(fleetFile(null, { cwd: q }), join(q, ".fleet"));
  assert.equal(fleetFile(null, { cwd: nested }), join(nested, ".fleet"));
  assert.notEqual(scratchRoot({ cwd: q, home: top }), scratchRoot({ cwd: nested, home: top }));
});
