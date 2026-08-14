// Regression gate for worktree-audit.sh, the read-only report run before
// dispatching a replacement for a killed member. Zero deps:
// `node --test skills/fleet/scripts/worktree-audit.test.mjs`.
//
// Three states, never two: present-and-readable (real counts), established
// absent (zero counts — a measurement), unknown (null counts, readable:false).
// Every negative case here asserts the SPECIFIC state, not merely
// readable:false — a fix that collapses "gone" and "unknown" into one
// direction is as broken as the bug it replaces (#82, #128).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./worktree-audit.sh", import.meta.url));

// Same identity pin as reap.test.mjs / release-ticket.test.mjs, for the same
// reason: cut the developer's ~/.gitconfig and any ambient GIT_DIR out of
// what these fixtures see.
const ENV = {
  ...process.env,
  BASE_REF: undefined,
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

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t, dir = "w") {
  // realpathSync: macOS resolves /var through /private, so a path built from
  // the raw mkdtemp result would never string-equal what git itself reports
  // (git canonicalises). Resolving once here, before any other path is
  // derived from it, is what lets every assertion below use exact equality
  // instead of a fragile `.endsWith` on every entry.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, dir);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

/** A linked worktree on a fresh branch off origin/main, under .worktrees/. */
function addWorktree(w, name, base = "origin/main") {
  const wt = join(w, ".worktrees", name);
  git(w, "worktree", "add", "-q", wt, "-b", name, base);
  return wt;
}

function runAudit(cwd) {
  const r = spawnSync("sh", [SCRIPT], { cwd, env: ENV, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

/** The one entry in the payload for this exact worktree path. */
function entryFor(json, wt) {
  const e = json.find((x) => x.worktree === wt);
  assert.ok(e, `no entry for ${wt} in ${JSON.stringify(json)}`);
  return e;
}

test("a clean readable worktree ahead of base is reported with real counts", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  commit(wt, "work");

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.deepEqual(e, { worktree: wt, branch: "fix/9-x", ahead: 1, dirty: 0, dirtyFiles: [], readable: true });
  assert.doesNotMatch(stderr, /UNREADABLE|MISSING/);
});

test("a dirty worktree lists its dirty files and their count", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { json } = runAudit(w);
  const e = entryFor(json, wt);
  assert.equal(e.readable, true);
  assert.equal(e.dirty, 1);
  assert.deepEqual(e.dirtyFiles, ["scratch.txt"]);
});

test("a dirty file whose own name holds a space is not truncated", (t) => {
  // Porcelain v1 is "XY<space>PATH" — always three bytes before the path, so
  // the fourth byte on is the whole rest of the line. Reading it as awk's $2
  // stops at the file's own internal space and reports "a" for "a b.txt".
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "a b.txt"), "uncommitted\n");

  const { json } = runAudit(w);
  const e = entryFor(json, wt);
  assert.deepEqual(e.dirtyFiles, ["a b.txt"]);
});

test("a staged rename reports its destination and leaves the payload parseable", (t) => {
  // git prints a rename as `R  <src> -> <dst>` and C-quotes either half on its
  // own whenever it holds a space. Reading the whole line as one path wrapped
  // the quotes git had already added inside a second pair, and the ONE bad
  // element made the entire array unparseable — every other worktree entry
  // destroyed with it, which is why this asserts the sibling entry too and why
  // runAudit's JSON.parse of the full payload is the real gate here.
  // `a -> b.txt` pins the split itself: gating on the literal " -> " instead of
  // on the R status byte cuts that source name in half mid-path.
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "old.txt"), "x\n");
  writeFileSync(join(wt, "a -> b.txt"), "x\n");
  git(wt, "add", "-A");
  commit(wt, "files to rename");
  git(wt, "mv", "old.txt", "new name.txt");
  git(wt, "mv", "a -> b.txt", "c.txt");

  const { code, json } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.equal(e.readable, true);
  assert.equal(e.dirty, 2);
  assert.deepEqual(e.dirtyFiles, ["c.txt", "new name.txt"]);
  assert.equal(entryFor(json, w).readable, true);
});

test("a genuinely deleted worktree is reported missing, with zero counts", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  rmSync(wt, { recursive: true, force: true });

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.deepEqual(e, { worktree: wt, branch: "fix/9-x", ahead: 0, dirty: 0, dirtyFiles: [], readable: false });
  assert.match(stderr, /MISSING on disk: .*fix\/9-x/);
  assert.doesNotMatch(stderr, /UNREADABLE/);
});

test("a worktree behind an unreadable parent is unknown, never missing or clean", (t) => {
  // Same worktree, holding real uncommitted work, is byte-identical to a
  // deleted one under a bare `[ -d ]` test — the defect this script shipped
  // with. `chmod 000` on the PARENT: the walk in `gone()` stops at the
  // nearest ancestor that exists, so this is the ancestor that must read as
  // unsearchable, not the worktree directory itself (which stays stat-able
  // from outside were the parent readable).
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "precious.txt"), "work that exists nowhere else\n");
  const parent = join(w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code, json, stderr } = runAudit(w);
  chmodSync(parent, 0o755);

  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.deepEqual(e, { worktree: wt, branch: "fix/9-x", ahead: null, dirty: null, dirtyFiles: [], readable: false });
  assert.match(stderr, /UNREADABLE: .*ancestor could not be read/);
  assert.doesNotMatch(stderr, /MISSING/);
});

test("a worktree whose .git file is gone is unknown, never clean", (t) => {
  // The directory EXISTS (so -d is true) and `git -C` does not fail on a
  // missing .git — it walks UP to the enclosing repo and answers about THAT
  // at rc 0. `.worktrees/` gitignored and the parent clean makes the leaked
  // answer empty: a positive assertion of clean, produced without ever having
  // looked at the worktree.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "precious.txt"), "work that exists nowhere else\n");
  rmSync(join(wt, ".git"));
  assert.equal(git(w, "status", "--porcelain"), "", "fixture: the leaked answer really is an empty one");

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.deepEqual(e, { worktree: wt, branch: "fix/9-x", ahead: null, dirty: null, dirtyFiles: [], readable: false });
  assert.match(stderr, /UNREADABLE: .*no \.git linkage/);
});

test("a worktree whose .git is an empty directory is unknown, never clean", (t) => {
  // Same leak, different shape: -e is true for a .git DIRECTORY too, so only
  // -f (not -e) tells the two apart.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = addWorktree(w, "fix/9-x");
  rmSync(join(wt, ".git"));
  mkdirSync(join(wt, ".git"));

  const { json, stderr } = runAudit(w);
  const e = entryFor(json, wt);
  assert.equal(e.readable, false);
  assert.equal(e.ahead, null);
  assert.match(stderr, /UNREADABLE: .*no \.git linkage/);
});

test("a worktree whose .git is a dangling symlink is unknown, never clean", (t) => {
  // The other shape a broken linkage takes, preferred here over another chmod
  // fixture: -e is false through a dangling link exactly as it is for an
  // absent file, so this exercises the same -f branch by construction rather
  // than by permission bits.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = addWorktree(w, "fix/9-x");
  rmSync(join(wt, ".git"));
  symlinkSync(join(wt, "nowhere"), join(wt, ".git"));

  const { json, stderr } = runAudit(w);
  const e = entryFor(json, wt);
  assert.equal(e.readable, false);
  assert.equal(e.ahead, null);
  assert.match(stderr, /UNREADABLE: .*no \.git linkage/);
});

test("a worktree path that is a file, not a directory, is unknown — and says so", (t) => {
  // git still LISTS a registered worktree whose directory was replaced by a
  // regular file, branch line and all, so this loop still sees it. `-d` is
  // false and `gone()` is false (the path plainly exists), which lands it in
  // the final else — whose reason blamed an ancestor that read fine. The
  // state is right either way; the cause was not. Same class, measured: a
  // symlink to a file and a FIFO land here too.
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  rmSync(wt, { recursive: true, force: true });
  writeFileSync(wt, "not a directory\n");

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.deepEqual(e, { worktree: wt, branch: "fix/9-x", ahead: null, dirty: null, dirtyFiles: [], readable: false });
  assert.match(stderr, /UNREADABLE: .*exists but is not a directory/);
  assert.doesNotMatch(stderr, /ancestor could not be read/, "no ancestor failed to read here");
  assert.doesNotMatch(stderr, /MISSING/, "the path is plainly there — this is unknown, not absent");
});

test("a repo path containing a space does not truncate the worktree it reads", (t) => {
  const w = repo(t, "my repos");
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { json } = runAudit(w);
  const match = json.find((x) => x.worktree.endsWith("/my repos/.worktrees/fix/9-x"));
  assert.ok(match, `no untruncated entry in ${JSON.stringify(json)}`);
  assert.equal(match.readable, true);
  assert.equal(match.dirty, 1);
  assert.deepEqual(match.dirtyFiles, ["scratch.txt"]);
});
