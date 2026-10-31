// `finisher-tree.mjs`: the finisher's verification tree, built at the dispatch
// pin with the Install step run in it. Every case runs the real script against
// a throwaway repository whose dependencies are untracked (`node_modules/` is
// ignored), with a Recipe cache whose Install step is a tracked script the case
// steers through its environment, and a test command that cannot pass without
// what the install leaves — the shape of a consumer whose suite exits 127 in a
// tracked-files-only tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REDERIVE } from "../plugin/scripts/evict.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/finisher-tree.mjs", import.meta.url));
const SOURCE = readFileSync(SCRIPT, "utf8");

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
delete ENV.GIT_DIR;
delete ENV.GIT_WORK_TREE;
delete ENV.CI;

const git = (cwd, args) => execFileSync("git", ["-c", "maintenance.auto=false", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();

// The Install step: it logs what `CI` read as, leaves the dependencies the test
// command needs, and fails or dirties the tree when the case says so.
const INSTALL = `#!/bin/sh
[ -n "\${INSTALL_LOG:-}" ] && printf '%s\\n' "\${CI-unset}" > "$INSTALL_LOG"
[ -n "\${INSTALL_MISSING:-}" ] && exit 127
mkdir -p node_modules/pkg && echo installed > node_modules/pkg/index.js
[ -n "\${INSTALL_DIRTY:-}" ] && echo dirty >> tracked.txt
exit "\${INSTALL_EXIT:-0}"
`;
// The suite: green only with the installed dependency, 127 without it, as
// `vitest: command not found` is.
const SUITE = `#!/bin/sh
[ -f node_modules/pkg/index.js ] || { echo "sh: pkg: command not found" >&2; exit 127; }
echo "tests 1"
`;

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "finisher-tree-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.fleet/\n");
  writeFileSync(join(repo, "tracked.txt"), "t\n");
  writeFileSync(join(repo, "install.sh"), INSTALL);
  writeFileSync(join(repo, "suite.sh"), SUITE);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "pin"]);
  const pin = git(repo, ["rev-parse", "HEAD"]);
  // The branch tip moves past the pin, as a member's push after dispatch does.
  writeFileSync(join(repo, "later.txt"), "later\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "past the pin"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  mkdirSync(join(repo, ".fleet"));
  writeFileSync(join(repo, ".fleet", "recipe.json"), JSON.stringify({
    install: "sh install.sh", test: "sh suite.sh", check: true, derivedAt: pin,
    installClean: true, testCount: 1, uncovered: [],
  }));
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  return {
    dir, repo, pin, scratch,
    tip: git(repo, ["rev-parse", "HEAD"]),
    tree: (member = "finisher-pr-7") => join(scratch, "pr7", `finish-${member}`),
    run(extra = {}, { env = {}, flags = null } = {}) {
      const args = flags ?? ["--worktree", repo, "--pin", pin, "--pr", "7", "--member", "finisher-pr-7", "--scratch", scratch];
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8", env: { ...ENV, ...env, ...extra } });
      let receipt = null;
      if (r.stdout !== "") receipt = JSON.parse(r.stdout);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, receipt };
    },
  };
}

test("the tree is at the pin, carries the member name, holds the installed dependency dir, and the suite runs green in it", (t) => {
  const f = fixture(t);
  const log = join(f.dir, "install.log");

  const r = f.run({}, { env: { CI: "1", INSTALL_LOG: log } });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.receipt, {
    tree: f.tree(), member: "finisher-pr-7", pr: 7, pin: f.pin, head: f.pin,
    install: "sh install.sh", kind: "installed", exit: 0, message: null,
  });
  assert.match(f.tree(), /\/pr7\/finish-finisher-pr-7$/);
  assert.equal(git(f.tree(), ["rev-parse", "HEAD"]), f.pin);
  assert.notEqual(f.pin, f.tip, "the fixture's branch tip did not move past the pin");
  assert.equal(existsSync(join(f.tree(), "later.txt")), false, "the tree was cut at the branch tip");
  assert.equal(readFileSync(log, "utf8"), "unset\n", "the Install step ran with CI set");
  assert.equal(readFileSync(join(f.tree(), "node_modules", "pkg", "index.js"), "utf8"), "installed\n");
  assert.equal(git(f.tree(), ["status", "--porcelain", "-uall"]), "");
  const suite = spawnSync("sh", ["suite.sh"], { cwd: f.tree(), encoding: "utf8" });
  assert.equal(suite.status, 0, suite.stderr);
  assert.match(suite.stdout, /tests 1/);
});

test("the premise: a bare detached tree at the pin cannot start the suite", (t) => {
  const f = fixture(t);
  const bare = join(f.dir, "bare");
  git(f.repo, ["worktree", "add", "-q", "--detach", bare, f.pin]);
  const suite = spawnSync("sh", ["suite.sh"], { cwd: bare, encoding: "utf8" });
  assert.equal(suite.status, 127);
});

test("an Install step that cannot run, one that fails, and one that dirties the tree each get their own exit and a receipt", (t) => {
  const cases = [
    [{ INSTALL_EXIT: "127" }, 3, "not-run", 127, (tree) => `the Install step 'sh install.sh' did not run in ${tree} (exit 127: not executable or not found) — ${REDERIVE}`],
    [{ INSTALL_EXIT: "126" }, 3, "not-run", 126, (tree) => `the Install step 'sh install.sh' did not run in ${tree} (exit 126: not executable or not found) — ${REDERIVE}`],
    [{ INSTALL_EXIT: "1" }, 4, "failed", 1, (tree) => `install failed in ${tree} (exit 1)`],
    [{ INSTALL_EXIT: "9" }, 4, "failed", 9, (tree) => `install failed in ${tree} (exit 9)`],
    [{ INSTALL_DIRTY: "1" }, 5, "dirtied", 0, (tree) => `the Install step 'sh install.sh' changed the tree in ${tree} (first:  M tracked.txt) — ${REDERIVE}`],
  ];
  const seen = new Set();
  for (const [env, code, kind, exit, said] of cases) {
    const f = fixture(t);

    const r = f.run({}, { env });

    assert.equal(r.status, code, JSON.stringify(env));
    assert.deepEqual(r.receipt, {
      tree: f.tree(), member: "finisher-pr-7", pr: 7, pin: f.pin, head: f.pin,
      install: "sh install.sh", kind, exit, message: said(f.tree()),
    }, JSON.stringify(env));
    assert.ok(existsSync(f.tree()), "the script removed the tree the finisher is to remove");
    seen.add(`${kind}:${code}`);
  }
  assert.deepEqual([...seen].sort(), ["dirtied:5", "failed:4", "not-run:3"]);
});

test("a path with anything at it fails closed with a receipt and leaves what was there", (t) => {
  for (const make of [
    (p) => mkdirSync(p, { recursive: true }),
    (p) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "mine\n"); },
    (p) => { mkdirSync(p, { recursive: true }); writeFileSync(join(p, "keep.txt"), "mine\n"); },
  ]) {
    const f = fixture(t);
    const log = join(f.dir, "install.log");
    make(f.tree());
    const before = snap(f.tree());

    const r = f.run({}, { env: { INSTALL_LOG: log } });

    assert.equal(r.status, 1);
    assert.equal(r.receipt.kind, "occupied");
    assert.equal(r.receipt.tree, f.tree());
    assert.equal(r.receipt.head, null);
    assert.equal(existsSync(log), false, "the Install step ran");
    assert.deepEqual(snap(f.tree()), before, "what was at the path changed");
    assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]).includes("finish-"), false, "git registered a tree at the occupied path");
  }
});

// What is at `p`: a directory's entries, or a file's content.
function snap(p) {
  return lstatSync(p).isDirectory() ? readdirSync(p) : readFileSync(p, "utf8");
}

test("a second finisher on the same PR gets its own path", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);

  const r = f.run({}, { flags: ["--worktree", f.repo, "--pin", f.pin, "--pr", "7", "--member", "finisher-pr-7-b", "--scratch", f.scratch] });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.receipt.tree, f.tree("finisher-pr-7-b"));
});

test("a tree already dirty before the Install step fails before it runs", (t) => {
  const f = fixture(t);
  const log = join(f.dir, "install.log");
  // A post-checkout hook that leaves a file behind: the tree is dirty when
  // `worktree add` returns, which is no Install step's doing.
  const hook = join(f.repo, ".git", "hooks", "post-checkout");
  mkdirSync(join(f.repo, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\necho stray > stray.txt\n");
  chmodSync(hook, 0o755);

  const r = f.run({}, { env: { INSTALL_LOG: log } });

  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "dirty-before");
  assert.match(r.receipt.message, /is not clean before the install \(first: \?\? stray\.txt\) — the Install step did not run/);
  assert.equal(r.receipt.exit, null);
  assert.equal(existsSync(log), false, "the Install step ran");
});

test("a pin the repository does not hold, or a missing Recipe cache, exits 1 with a receipt", (t) => {
  const f = fixture(t);
  const none = "0".repeat(40);
  const added = f.run({}, { flags: ["--worktree", f.repo, "--pin", none, "--pr", "7", "--member", "finisher-pr-7", "--scratch", f.scratch] });
  assert.equal(added.status, 1);
  assert.equal(added.receipt.kind, "add-failed");
  assert.equal(added.receipt.pin, none);

  rmSync(join(f.repo, ".fleet", "recipe.json"));
  const derived = f.run();
  assert.equal(derived.status, 1);
  assert.equal(derived.receipt.kind, "derive");
  assert.equal(derived.receipt.head, f.pin);
  assert.equal(derived.receipt.install, null);
});

test("an inherited GIT_DIR naming another repository cannot retarget the tree", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other");
  git(f.dir, ["-c", "init.defaultBranch=main", "init", "-q", other]);

  const r = f.run({ GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.receipt.head, f.pin);
  assert.equal(git(f.tree(), ["rev-parse", "HEAD"]), f.pin);
  assert.equal(git(other, ["worktree", "list", "--porcelain"]).includes("finish-"), false);
});

test("usage refusals exit 2 on stderr with no receipt", (t) => {
  const f = fixture(t);
  const base = ["--worktree", f.repo, "--pin", f.pin, "--pr", "7", "--member", "finisher-pr-7", "--scratch", f.scratch];
  const swap = (flag, value) => base.map((a, i) => (base[i - 1] === flag ? value : a));
  const cases = [
    [[], /usage: finisher-tree\.mjs/],
    [swap("--pin", "abc123"), /--pin needs a full 40-character commit SHA/],
    [swap("--pr", "07"), /--pr needs a PR number/],
    [swap("--pr", "x"), /--pr needs a PR number/],
    [swap("--member", "../escape"), /--member needs one path segment/],
    [swap("--member", ".."), /--member needs one path segment/],
    [swap("--member", "a/b"), /--member needs one path segment/],
    [swap("--scratch", "relative/scratch"), /--scratch needs an absolute path/],
    [swap("--worktree", "relative/repo"), /--worktree needs an absolute path/],
    [[...base, "--bogus"], /bogus/],
  ];
  for (const [flags, said] of cases) {
    const r = f.run({}, { flags });
    assert.equal(r.status, 2, flags.join(" "));
    assert.equal(r.stdout, "", flags.join(" "));
    assert.match(r.stderr, said, flags.join(" "));
  }
  assert.equal(existsSync(join(f.scratch, "pr7")), false, "a refusal built a tree");
});

test("the install sequence is evict.mjs's installIn(), not a copy of it", () => {
  assert.match(SOURCE, /import \{ installIn \} from "\.\/evict\.mjs";/);
  for (const copy of ["derive-testcmd", "status\", \"--porcelain\"", "\"CI\"", "REDERIVE"]) {
    assert.equal(SOURCE.replace(/^\s*\/\/.*$/gm, "").includes(copy), false, `finisher-tree.mjs carries its own ${copy}`);
  }
});
