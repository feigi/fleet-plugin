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
import { fleetFile, FleetDirUnresolvable } from "../plugin/scripts/fleet-dir.mjs";

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
