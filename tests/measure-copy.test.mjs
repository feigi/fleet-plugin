// `measure-copy.mjs`: the one command that builds every measuring copy. Every
// case runs the real script against a throwaway repository whose dependencies
// are untracked (`node_modules/` is ignored), with a Recipe cache whose Install
// step is a tracked script the case steers through its environment — the shape
// of a consumer whose suite exits 127 in a tracked-files-only tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_ESTABLISHED } from "../plugin/scripts/evict.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/measure-copy.mjs", import.meta.url));
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

// The Install step: it leaves an ignored directory and, unless told not to, one
// untracked file nothing ignores, and fails or cannot run when the case says so.
const INSTALL = `#!/bin/sh
[ -n "\${INSTALL_LOG:-}" ] && printf '%s\\n' "\${CI-unset}" > "$INSTALL_LOG"
[ -n "\${INSTALL_MISSING:-}" ] && exit 127
[ -n "\${INSTALL_KILL:-}" ] && kill -9 $$
mkdir -p node_modules/pkg && echo installed > node_modules/pkg/index.js
[ -z "\${INSTALL_NO_LEFTOVER:-}" ] && echo left > leftover.txt
[ -n "\${INSTALL_REWRITE:-}" ] && echo rewritten > tracked.txt
[ -n "\${INSTALL_DELETE:-}" ] && rm tracked.txt
[ -n "\${INSTALL_RMGIT:-}" ] && rm -rf .git
exit "\${INSTALL_EXIT:-0}"
`;

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "measure-copy-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.fleet/\n");
  writeFileSync(join(repo, "tracked.txt"), "t\n");
  writeFileSync(join(repo, "install.sh"), INSTALL);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "pin"]);
  const pin = git(repo, ["rev-parse", "HEAD"]);
  // The branch tip moves past the pin, as a push after the review does.
  writeFileSync(join(repo, "later.txt"), "later\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "past the pin"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  mkdirSync(join(repo, ".fleet"));
  writeFileSync(join(repo, ".fleet", "recipe.json"), JSON.stringify({
    install: "sh install.sh", test: "true", check: true, derivedAt: pin,
    installClean: true, testCount: 1, uncovered: [],
  }));
  const scratch = join(dir, "scratch");
  const round = join(scratch, "pr7", "fix-ab12cd34");
  mkdirSync(round, { recursive: true });
  return {
    dir, repo, pin, scratch, round,
    dest: join(round, "f1", "tree"),
    run(over = {}, { env = {}, flags = null } = {}) {
      const a = { worktree: repo, pin, dest: join(round, "f1", "tree"), pr: "7", scratch, ...over };
      const args = flags ?? Object.entries(a).flatMap(([k, v]) => [`--${k}`, v]);
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8", env: { ...ENV, ...env } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, receipt: r.stdout === "" ? null : JSON.parse(r.stdout) };
    },
  };
}

test("the copy is the pin's tree in a repository of its own, holds the ignored install, and the receipt lists what is left untracked", (t) => {
  const f = fixture(t);
  const log = join(f.dir, "install.log");

  const r = f.run({}, { env: { CI: "1", INSTALL_LOG: log } });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(f.dest, ["rev-parse", "HEAD^{tree}"]), git(f.repo, ["rev-parse", `${f.pin}^{tree}`]), "the copy's HEAD tree is not the pin's tree");
  assert.equal(lstatSync(join(f.dest, ".git")).isDirectory(), true, "the copy holds no .git of its own");
  assert.equal(realpathSync(git(f.dest, ["rev-parse", "--show-toplevel"])), f.dest);
  assert.equal(readFileSync(join(f.dest, "node_modules", "pkg", "index.js"), "utf8"), "installed\n", "the ignored directory is missing");
  assert.equal(existsSync(join(f.dest, "later.txt")), false, "the copy was cut at the branch tip, not the pin");
  assert.equal(readFileSync(log, "utf8"), "unset\n", "the Install step ran with CI set");
  assert.deepEqual(r.receipt, {
    dest: f.dest, pr: 7, pin: f.pin, head: git(f.dest, ["rev-parse", "HEAD"]), tree: git(f.dest, ["rev-parse", "HEAD^{tree}"]),
    install: "sh install.sh", kind: "built", exit: 0, untracked: ["?? leftover.txt"], untrackedCount: 1, message: null,
  });
});

test("an Install step that leaves nothing untracked reports an empty list and a count of 0, still exit 0", (t) => {
  const f = fixture(t);

  const r = f.run({}, { env: { INSTALL_NO_LEFTOVER: "1" } });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([r.receipt.untracked, r.receipt.untrackedCount], [[], 0]);
});

test("the receipt carries the first 20 untracked lines and their count", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "install.sh"), `${INSTALL}`.replace("exit \"${INSTALL_EXIT:-0}\"", 'for i in $(seq 1 25); do echo x > "u$i.txt"; done\nexit 0'));
  git(f.repo, ["add", "-A"]);
  git(f.repo, ["commit", "-q", "-m", "many"]);
  const pin = git(f.repo, ["rev-parse", "HEAD"]);

  const r = f.run({ pin });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.receipt.untracked.length, 20);
  assert.equal(r.receipt.untrackedCount, 26);
});

test("a destination that would be outside a fix-* or run-* root of this PR is refused with exit 1, a receipt, and nothing built or installed", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.scratch, "pr8", "fix-ab12cd34"), { recursive: true });
  mkdirSync(join(f.scratch, "pr7", "other-root"), { recursive: true });
  mkdirSync(join(f.scratch, "pr7", "run-ab12cd34"), { recursive: true });
  const outside = join(f.dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.round, "link"));
  symlinkSync(outside, join(f.scratch, "pr7", "run-linked"));
  const cases = {
    "a .. segment": `${f.round}/f1/../../../../x`,
    "an empty segment": `${f.round}//f1/copy`,
    "the PR directory itself": join(f.scratch, "pr7"),
    "a directory straight under the PR directory": join(f.scratch, "pr7", "copy"),
    "a root that is neither fix-* nor run-*": join(f.scratch, "pr7", "other-root", "copy"),
    "the round root itself": f.round,
    "another PR's round root": join(f.scratch, "pr8", "fix-ab12cd34", "copy"),
    "a symlinked directory below the round root": join(f.round, "link", "copy"),
    "a symlinked round root": join(f.scratch, "pr7", "run-linked", "copy"),
    "a round root that does not exist": join(f.scratch, "pr7", "fix-nothere", "copy"),
    "a path outside the scratch root": join(f.dir, "elsewhere", "pr7", "fix-ab12cd34", "copy"),
  };
  for (const [what, dest] of Object.entries(cases)) {
    const r = f.run({ dest });

    assert.equal(r.status, 1, `${what}: ${r.stderr}${r.stdout}`);
    assert.equal(r.receipt.kind, "outside", what);
    assert.equal(r.receipt.dest, dest, what);
    assert.equal(r.receipt.install, null, `${what}: the Install step was read`);
  }
  assert.equal(existsSync(join(outside, "copy")), false, "a copy was built through a symlink");
  assert.equal(existsSync(join(f.scratch, "pr7", "copy")), false);
  assert.equal(existsSync(join(f.dir, "elsewhere")), false, "a path was made outside the scratch root");
});

test("a destination that already exists — a directory, an empty one, a file, a dangling symlink — is refused with exit 1 and left as it was", (t) => {
  const f = fixture(t);
  const log = join(f.dir, "install.log");
  const make = {
    "a directory with a file": (p) => { mkdirSync(p); writeFileSync(join(p, "mine.txt"), "mine\n"); },
    "an empty directory": (p) => mkdirSync(p),
    "a file": (p) => writeFileSync(p, "mine\n"),
    "a dangling symlink": (p) => symlinkSync(join(f.dir, "nothing"), p),
  };
  for (const [what, build] of Object.entries(make)) {
    const dest = join(f.round, what.replaceAll(" ", "-"));
    build(dest);

    const r = f.run({ dest }, { env: { INSTALL_LOG: log } });

    assert.equal(r.status, 1, what);
    assert.equal(r.receipt.kind, "occupied", what);
    assert.equal(existsSync(log), false, `${what}: the Install step ran`);
    assert.equal(existsSync(join(dest, ".git")), false, `${what}: a repository was made over it`);
  }
  assert.equal(readFileSync(join(f.round, "a-directory-with-a-file", "mine.txt"), "utf8"), "mine\n");
});

test("a copy whose tree is not the pin's is refused with exit 1 and the Install step never runs", (t) => {
  const f = fixture(t);
  const log = join(f.dir, "install.log");
  // A tracked file whose content the checkout and the add do not carry back
  // unchanged: a blob stored with CRLF line endings under a `text` attribute
  // is normalized to LF when the copy adds it, so the copy's tree differs. The
  // blob is written unfiltered and staged by id, so no add here normalizes it.
  writeFileSync(join(f.repo, "crlf.txt"), "a\r\nb\r\n");
  const blob = git(f.repo, ["hash-object", "-w", "--no-filters", "crlf.txt"]);
  writeFileSync(join(f.repo, ".gitattributes"), "crlf.txt text\n");
  git(f.repo, ["add", ".gitattributes"]);
  git(f.repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},crlf.txt`]);
  git(f.repo, ["commit", "-q", "-m", "crlf"]);
  const pin = git(f.repo, ["rev-parse", "HEAD"]);

  const r = f.run({ pin }, { env: { INSTALL_LOG: log } });

  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "tree-mismatch");
  assert.equal(existsSync(log), false, "the Install step ran on a copy that is not the pin's");
  assert.equal(r.receipt.install, null);
});

test("a pin whose tree is empty still makes the copy's commit, and the Install step it cannot hold is not run", (t) => {
  const f = fixture(t);
  const empty = git(f.repo, ["hash-object", "-t", "tree", "-w", "/dev/null"]);
  const pin = git(f.repo, ["commit-tree", empty, "-m", "empty"]);

  const r = f.run({ pin });

  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "not-run");
  assert.equal(r.receipt.tree, empty);
  assert.equal(git(f.dest, ["rev-parse", "HEAD^{tree}"]), empty);
});

test("a pin holding a submodule gitlink, an export-ignore path and an export-subst file still copies as the pin's tree", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".gitattributes"), "gone.txt export-ignore\nsubst.txt export-subst\n");
  writeFileSync(join(f.repo, "gone.txt"), "kept\n");
  writeFileSync(join(f.repo, "subst.txt"), "id: $Format:%H$\n");
  git(f.repo, ["add", "-A"]);
  git(f.repo, ["update-index", "--add", "--cacheinfo", `160000,${f.pin},sub`]);
  git(f.repo, ["commit", "-q", "-m", "gitlink and export attributes"]);
  const pin = git(f.repo, ["rev-parse", "HEAD"]);

  const r = f.run({ pin });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "built");
  assert.equal(git(f.dest, ["rev-parse", "HEAD^{tree}"]), git(f.repo, ["rev-parse", `${pin}^{tree}`]), "the copy's HEAD tree is not the pin's tree");
  assert.equal(git(f.dest, ["ls-files", "-s", "sub"]).split(/\s/)[0], "160000", "the gitlink is not in the copy's index");
  assert.equal(readFileSync(join(f.dest, "gone.txt"), "utf8"), "kept\n", "an export-ignore path is missing from the copy");
  assert.equal(readFileSync(join(f.dest, "subst.txt"), "utf8"), "id: $Format:%H$\n", "an export-subst file was rewritten in the copy");
});

test("a pin whose objects cannot all be fetched is refused as fetch-failed with git's own words, never as a tree mismatch", (t) => {
  const f = fixture(t);
  const blob = git(f.repo, ["rev-parse", `${f.pin}:tracked.txt`]);
  rmSync(join(f.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  const r = f.run();

  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "fetch-failed");
  assert.match(r.receipt.message, /^git fetch .* failed in .* \(exit \d+: .+\)$/);
  assert.equal(r.receipt.install, null);
});

test("a pin the worktree does not hold is refused with exit 1", (t) => {
  const f = fixture(t);

  const r = f.run({ pin: "0123456789abcdef0123456789abcdef01234567" });

  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "pin-unreadable");
  assert.equal(existsSync(f.dest), false, "a copy was started for a pin that is not there");
});

test("an Install step that cannot run is exit 3, one that fails or changes a tracked file is exit 4, one that hides the copy's state is exit 5, each with a receipt", (t) => {
  const cases = [
    [{ INSTALL_MISSING: "1" }, 3, "not-run", 127],
    [{ INSTALL_EXIT: "126" }, 3, "not-run", 126],
    [{ INSTALL_EXIT: "1" }, 4, "failed", 1],
    [{ INSTALL_EXIT: "9" }, 4, "failed", 9],
    [{ INSTALL_KILL: "1" }, 4, "failed", null],
    [{ INSTALL_REWRITE: "1" }, 4, "dirtied", 0],
    [{ INSTALL_DELETE: "1" }, 4, "dirtied", 0],
    [{ INSTALL_RMGIT: "1" }, 5, "status-after", 0],
  ];
  for (const [env, code, kind, exit] of cases) {
    const f = fixture(t);

    const r = f.run({}, { env });

    assert.equal(r.status, code, JSON.stringify(env));
    assert.equal(r.receipt.kind, kind, JSON.stringify(env));
    assert.equal(r.receipt.exit, exit, JSON.stringify(env));
    assert.equal(r.receipt.install, "sh install.sh");
    assert.equal(r.receipt.untracked, null, "a refused copy reports untracked paths it never read");
    assert.equal(existsSync(f.dest), true, "the script removed the copy");
  }
  const f = fixture(t);
  const said = f.run({}, { env: { INSTALL_EXIT: "127" } }).receipt.message;
  assert.match(said, new RegExp(NOT_ESTABLISHED.slice(0, 40)));
});

test("an Install step the Recipe cannot supply is exit 1 with no Install step read, and a stray or missing flag is exit 2 with no receipt", (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, ".fleet", "recipe.json"));

  const r = f.run();

  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(r.receipt.kind, "derive");
  assert.equal(r.receipt.install, null);

  for (const flags of [["--worktree", f.repo], ["--bogus", "1"], []]) {
    const bad = f.run({}, { flags });
    assert.equal(bad.status, 2, JSON.stringify(flags));
    assert.equal(bad.stdout, "");
  }
  for (const over of [{ pin: "abc" }, { pr: "0" }, { pr: "x" }, { dest: "rel/path" }, { worktree: "rel" }, { scratch: "rel" }]) {
    const bad = f.run(over);
    assert.equal(bad.status, 2, JSON.stringify(over));
    assert.equal(bad.stdout, "");
  }
});

test("a run-* run root takes a copy too, at any depth, and two copies of one pin sit side by side", (t) => {
  const f = fixture(t);
  const run = join(f.scratch, "pr7", "run-Zq81xK2m");
  mkdirSync(run);

  const a = f.run({ dest: join(run, "correctness", "copy") });
  const b = f.run({ dest: join(run, "correctness", "copy-2") });

  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  assert.notEqual(a.receipt.dest, b.receipt.dest);
});

test("a destination written with a trailing slash builds at the path without it", (t) => {
  const f = fixture(t);

  const r = f.run({ dest: `${f.dest}/` });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.receipt.dest, f.dest);
  assert.equal(git(f.dest, ["rev-parse", "HEAD^{tree}"]), git(f.repo, ["rev-parse", `${f.pin}^{tree}`]));
});

test("a scratch root named through a symlink takes a destination written either way", (t) => {
  const f = fixture(t);
  const link = join(f.dir, "scratch-link");
  symlinkSync(f.scratch, link);

  const viaLink = f.run({ scratch: link, dest: join(link, "pr7", "fix-ab12cd34", "a") });
  const viaReal = f.run({ scratch: link, dest: join(f.round, "b") });

  assert.equal(viaLink.status, 0, viaLink.stderr + viaLink.stdout);
  assert.equal(viaReal.status, 0, viaReal.stderr + viaReal.stdout);
});

test("the script runs the install sequence through evict.mjs's installIn and carries no copy of it", () => {
  assert.match(SOURCE, /import \{ installIn \} from "\.\/evict\.mjs";/);
  assert.match(SOURCE, /installIn\(dest, true,/);
  assert.doesNotMatch(SOURCE.replace(/^\/\/.*$/gm, ""), /derive-testcmd\.sh/, "the script reads the Install step itself instead of through installIn");
});

test("an inherited GIT_DIR naming another repository cannot retarget the fetch, the init or the commit", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other");
  git(f.dir, ["-c", "init.defaultBranch=main", "init", "-q", other]);

  const r = f.run({}, { env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other } });

  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(f.dest, ["rev-parse", "HEAD^{tree}"]), git(f.repo, ["rev-parse", `${f.pin}^{tree}`]));
  assert.equal(lstatSync(join(f.dest, ".git")).isDirectory(), true);
  assert.equal(spawnSync("git", ["-C", other, "rev-parse", "--verify", "HEAD"], { env: ENV, encoding: "utf8" }).status !== 0, true, "the other repository got a commit");
});

test("a receipt that cannot be written to stdout is exit 2, never the build's own exit", (t) => {
  const f = fixture(t);
  const run = (dest, stdio) =>
    spawnSync(process.execPath, [SCRIPT, "--worktree", f.repo, "--pin", f.pin, "--dest", dest, "--pr", "7", "--scratch", f.scratch], { cwd: f.repo, encoding: "utf8", env: ENV, stdio });
  assert.equal(run(join(f.round, "ok"), ["ignore", "pipe", "pipe"]).status, 0, "control: the same build writes its receipt and exits 0");
  const readOnly = openSync("/dev/null", "r");
  try {
    const r = run(join(f.round, "lost"), ["ignore", readOnly, "pipe"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /measure-copy: the receipt could not be written to stdout/);
  } finally {
    closeSync(readOnly);
  }
});

test("the script carries no copy of the install sequence's own pieces", () => {
  const code = SOURCE.replace(/^\s*\/\/.*$/gm, "");
  for (const copy of ["derive-testcmd", "status\", \"--porcelain\"", "\"CI\"", "REDERIVE"]) {
    assert.equal(code.includes(copy), false, `measure-copy.mjs carries its own ${copy}`);
  }
});
