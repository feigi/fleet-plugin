// Regression gate for worktree-audit.sh, the read-only report run before
// dispatching a replacement for a killed member. Zero deps:
// `node --test plugin/scripts/worktree-audit.test.mjs`.
//
// Three states, never two: present-and-readable (real counts), established
// absent (zero counts — a measurement), unknown (null counts, readable:false).
// Every negative case here asserts the SPECIFIC state, not merely
// readable:false — a fix that collapses "gone" and "unknown" into one
// direction is as broken as the bug it replaces (#82, #128).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./worktree-audit.sh", import.meta.url));

// Same identity pin as reap.test.mjs / release-ticket.test.mjs, for the same
// reason: cut the developer's ~/.gitconfig and any ambient GIT_DIR out of
// what these fixtures see.
const ENV = {
  ...process.env,
  // Every `sh $SCRIPT` invocation below inherits the script's own
  // `export LC_ALL=C` (worktree-audit.sh) regardless of what ENV carries —
  // but the two direct `awk` calls in the C-quote-escape test bypass the
  // script and its export entirely, so the pin has to live here. Without it,
  // gawk under an ambient UTF-8 locale (CI's default) double-encodes the
  // `\303\251` octal escape instead of decoding it to a single byte.
  LC_ALL: "C",
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

/**
 * Re-point the registration for `wt` at `dest` and take the real directory away.
 *
 * `git worktree list --porcelain` derives the worktree path from the entry's
 * `gitdir` file, so rewriting that file is how a fixture gets git to name a
 * path whose FIRST component under `/` does not exist — the one shape
 * `git worktree add` cannot produce, since it has to create the directory. In
 * production this is the hand-added worktree outside the checkout whose
 * ancestor chain was removed (`git worktree add /scratch/wt`, then
 * `rm -rf /scratch`). The registry entry itself survives, so any
 * listed-vs-registered count stays balanced.
 */
function relocate(w, wt, dest) {
  const admin = join(w, ".git", "worktrees");
  // realpathSync: git canonicalises what it writes into `gitdir`, and on macOS
  // a tmpdir path reaches this suite as /var/... while git recorded
  // /private/var/... — the scan matches nothing without resolving first.
  const target = join(realpathSync(wt), ".git");
  const name = readdirSync(admin).find(
    (n) => readFileSync(join(admin, n, "gitdir"), "utf8").trim() === target,
  );
  assert.ok(name, `fixture: no registry entry points at ${wt}`);
  writeFileSync(join(admin, name, "gitdir"), `${dest}/.git\n`);
  rmSync(wt, { recursive: true, force: true });
  return dest;
}

// `env` overrides ENV's scrub for the two #1020 cases below and nothing else:
// ENV deletes GIT_DIR and GIT_WORK_TREE for every fixture in this file, so a
// suite run under a poisoned environment cannot go vacuous, and the only way
// to exercise the path that scrub makes unreachable is to opt one case back in.
function runAudit(cwd, { env = {} } = {}) {
  const r = spawnSync("sh", [SCRIPT], { cwd, env: { ...ENV, ...env }, encoding: "utf8" });
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

test("a local ref shadowing `origin/main` does not read the ahead count as 0 (#1329)", (t) => {
  // release-ticket.sh (#1320) already measured this class: `origin/main` is a
  // SHORTHAND, and git resolves a shorthand through its own disambiguation
  // order (gitrevisions: refs/<name>, refs/tags/<name>, refs/heads/<name>,
  // refs/remotes/<name>, …), in which refs/remotes/origin/main comes LAST. A
  // local TAG literally named `origin/main` outranks the real remote-tracking
  // branch, so `rev-list --count "$base"..HEAD` against the bare shorthand
  // answers about the tag's target instead — silently, at rc 0, with nothing
  // on stderr distinguishing it from a genuinely clean worktree. This script's
  // own header comment (#82, #128) says an ahead:0/dirty:0 entry tells the fleet
  // controller "nothing here", so a wrong 0 is not just an inaccurate number,
  // it is a false "safe to discard" for a worktree that genuinely carries
  // unpushed work.
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  commit(wt, "work that exists nowhere else");

  // Pointed at the worktree's own tip, the cheapest way to plant a colliding
  // ref that makes the bare shorthand resolve to a commit already equal to
  // HEAD — the shape that reads `ahead: 0` if the measurement is not
  // requalified.
  git(w, "tag", "origin/main", "refs/heads/fix/9-x");
  assert.equal(
    git(w, "rev-parse", "origin/main"),
    git(w, "rev-parse", "refs/heads/fix/9-x"),
    "fixture: the shorthand now resolves to the worktree's own tip",
  );
  assert.notEqual(
    git(w, "rev-parse", "refs/remotes/origin/main"),
    git(w, "rev-parse", "refs/heads/fix/9-x"),
    "fixture: the real upstream is still a different, older commit",
  );

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.equal(e.ahead, 1, "must measure against refs/remotes/origin/main, not the shadowing tag");
  assert.doesNotMatch(stderr, /UNREADABLE|MISSING/);
});

test("BASE_REF already qualified as refs/remotes/<name> is used as-is, not double-prefixed (#1329)", (t) => {
  // The qualify step's `refs/remotes/*) base_rev=$base;;` arm exists to avoid
  // turning an already-qualified BASE_REF into the nonsense
  // `refs/remotes/refs/remotes/origin/main`. Nothing above this test ever set
  // BASE_REF to a refs/remotes/-qualified value, so this arm ran on every
  // fixture only by falling through the OTHER arm never firing — a bug that
  // silently double-prefixed here would still show every other test green.
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  commit(wt, "work that exists nowhere else");

  const { code, json, stderr } = runAudit(w, { env: { BASE_REF: "refs/remotes/origin/main" } });
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.equal(e.ahead, 1, "an already-qualified BASE_REF must resolve, not be rejected or double-prefixed");
  assert.doesNotMatch(stderr, /UNREADABLE|MISSING/);
});

test("BASE_REF spelled outside the remote-tracking namespace is refused, not silently mis-qualified (#1329)", (t) => {
  // Before the accept-list, the qualify step below unconditionally prepended
  // `refs/remotes/` to whatever BASE_REF was. A caller-supplied `refs/heads/
  // main` — a shape sibling scripts (reap.sh, release-ticket.sh) also reject —
  // turned into `refs/remotes/refs/heads/main`, which resolves nowhere, and
  // the die message named the ORIGINAL `refs/heads/main` as "does not
  // resolve" even though `refs/heads/main` itself resolves fine — the
  // qualification this script chose to make was the actual cause, misspelled
  // as a bad guess by the caller. The accept-list turns that into a refusal
  // naming the real constraint before the qualify step ever runs.
  const w = repo(t);
  addWorktree(w, "fix/9-x");

  const { code, json, stderr } = runAudit(w, { env: { BASE_REF: "refs/heads/main" } });
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /BASE_REF must be a remote-tracking ref, got 'refs\/heads\/main'/);
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

// #730 (see reap.sh's branch sweep for the full explanation) — a bare
// `--porcelain` reads `dirty: 0, dirtyFiles: []` over a dirty tree under
// `status.showUntrackedFiles = no`. This report is what a fleet controller
// reads to decide whether a replacement member would REDO work or DESTROY
// it, so a false clean here misinforms exactly the decision the audit
// exists to inform.
test("a dirty worktree is still reported dirty under status.showUntrackedFiles=no (#730)", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");
  git(w, "config", "status.showUntrackedFiles", "no");
  // The fixture's own positive control: without it a git that stopped honouring
  // the config would leave this test green while pinning nothing.
  assert.equal(git(wt, "status", "--porcelain"), "",
    "fixture: the config must really silence the unpinned probe, or this test measures nothing");

  const { json } = runAudit(w);
  const e = entryFor(json, wt);
  // `readable: true` alongside the count: a fix that turned the silenced answer
  // into an UNKNOWN would also stop reporting 0, and unknown is a different —
  // and here wrong — verdict about a worktree git answered for perfectly well.
  assert.deepEqual(e, { worktree: wt, branch: "fix/9-x", ahead: 0, dirty: 1, dirtyFiles: ["scratch.txt"], readable: true });
});

// `-uall`, not `-unormal`: proves the granularity `-uall` buys is real, not
// just asserted in the script's comment. An untracked file inside an
// untracked SUBDIRECTORY is named on its own line — `-unormal` would
// collapse it to one entry for the directory (`sub/`), which is what
// reap.sh's `--ignored` reason-string probe switched to, same PR, because
// nothing downstream there reads per-file detail. Here something does:
// `dirtyFiles[]` is what a fleet controller reads to decide REDO vs DESTROY.
test("a dirty file inside an untracked subdirectory is named, not collapsed to the directory", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  mkdirSync(join(wt, "sub"));
  writeFileSync(join(wt, "sub", "deep.txt"), "uncommitted\n");

  const { json } = runAudit(w);
  const e = entryFor(json, wt);
  assert.deepEqual(e.dirtyFiles, ["sub/deep.txt"]);
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
  //
  // The third rename, into a tab-holding destination, is the #617 interaction
  // (survived-finding-adjacent suggestion 1): `jesc` runs on `p` unconditionally
  // at the print below, rename or not, so a destination needing real escape
  // translation (not just quote-stripping around a bare space) must round-trip
  // through the rename-split path too.
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "old.txt"), "x\n");
  writeFileSync(join(wt, "a -> b.txt"), "x\n");
  writeFileSync(join(wt, "third.txt"), "x\n");
  git(wt, "add", "-A");
  commit(wt, "files to rename");
  git(wt, "mv", "old.txt", "new name.txt");
  git(wt, "mv", "a -> b.txt", "c.txt");
  git(wt, "mv", "third.txt", "ta\tb2.txt");

  const { code, json } = runAudit(w);
  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.equal(e.readable, true);
  assert.equal(e.dirty, 3);
  assert.deepEqual([...e.dirtyFiles].sort(), ["c.txt", "new name.txt", "ta\tb2.txt"].sort());
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

test("a worktree with no surviving ancestor below / is MISSING, never unknown (#178)", (t) => {
  // The escalation of the case above: there the parent could not be SEARCHED,
  // which is genuinely unknown. Here every ancestor below `/` is absent — but
  // `${p%/*}` on `/x` yields the empty string rather than `/`, so the walk fell
  // out on "" and `[ -x "" ]` answered unknown about a path that is provably
  // absent with a searchable root. Reported as UNREADABLE it sends a debugger
  // at permissions that are fine, and hides the entry a prune would clear.
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  const dest = relocate(w, wt, "/nonexistent-top-level-178/wt");

  const { code, json, stderr } = runAudit(w);

  assert.equal(code, 0);
  const e = entryFor(json, dest);
  assert.deepEqual(e, { worktree: dest, branch: "fix/9-x", ahead: 0, dirty: 0, dirtyFiles: [], readable: false });
  assert.match(stderr, /MISSING on disk: \/nonexistent-top-level-178\/wt/);
  assert.doesNotMatch(stderr, /UNREADABLE/, "an absent path with a searchable root is not an unknown one");
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

/** The design spec's script-surface row for this script, as one line. */
function specRow() {
  const spec = readFileSync(
    fileURLToPath(new URL("../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `worktree-audit.sh` |"));
  assert.ok(row, "the script-surface table must still carry a worktree-audit.sh row");
  return row;
}

// Sibling pin, same table, same reason: no-undo-audit.test.mjs. The design
// spec's script-surface row for this script named `commits` — a field that has
// never existed — and typed `dirty` as an array when it is a count, so a caller
// reading `.dirty[0]` off the table got a number-index on an integer (#48).
// Derived from a real run, never from a hand-written key list: a list typed
// here drifts from the script exactly the way the table did.
test("the design spec's script-surface row names every field the payload actually emits", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { json } = runAudit(w);
  const e = entryFor(json, wt);

  const row = specRow();

  // Both halves read the Out cell alone, since the rest of the row legitimately
  // names things that are not keys: scanning the whole row let the Script cell's
  // `worktree-audit.sh` satisfy `worktree` and the `Non-zero when` prose's "a
  // worktree that is dirty" satisfy `dirty`, so either could be dropped from the
  // type signature with this test green — and `dirty` is one of the two fields
  // the row got wrong (#48).
  const out = row.split("|")[3];

  // Word-boundary match, so `dirty` cannot be satisfied by `dirtyFiles` sitting
  // elsewhere in the cell — the exact substring trap that would let the shorter
  // key be dropped again while this test stayed green.
  const missing = Object.keys(e).filter((k) => !new RegExp(`\\b${k}\\b`).test(out));
  assert.deepEqual(missing, [], `the spec row omits fields the script emits: ${missing.join(", ")}`);

  // The other direction: a field the row invents is as wrong as one it drops,
  // and only this half catches `commits`.
  const invented = (out.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).filter((k) => !(k in e));
  assert.deepEqual(invented, [], `the spec row names fields the script never emits: ${invented.join(", ")}`);
});

// --- #119: the payload's own string fields.
//
// `$wt` and `$short` are spliced raw. Both are reachable and by different
// routes: a branch name accepts a `"` (git rejects `\` in a ref), while a
// worktree path is a filename and accepts both. This script's whole output is
// one JSON array, so a single unescaped byte costs the caller every entry, not
// just the offending one.
//
// `dirtyFiles[]` was left out of #119 because git C-quotes those paths itself,
// conditionally, and translating that form is a second and different problem.
// #617 settled it — see the test below and the `jesc` comment in the script.
test("a quote in a branch name still emits parseable JSON", (t) => {
  const w = repo(t);
  addWorktree(w, 'evil"branch');

  const { code, json } = runAudit(w);

  assert.equal(code, 0);
  const e = entryFor(json, join(w, ".worktrees", 'evil"branch'));
  assert.equal(e.branch, 'evil"branch', "the branch field round-trips to the name that went in");
});

test("a quote and a backslash in a worktree PATH still emit parseable JSON", (t) => {
  // The vector a branch name cannot reach: git refuses `\` in a ref but a
  // directory name carries one fine, so the path is the only field here that
  // exercises the backslash rule.
  const w = repo(t);
  const wt = join(w, '.worktrees/od"d\\path');
  git(w, "worktree", "add", "-q", wt, "-b", "fix/odd-path", "origin/main");

  const { code, json } = runAudit(w);

  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.equal(e.worktree, wt, "the path round-trips through both the quote and the backslash rule");
  assert.equal(e.branch, "fix/odd-path");
});

test("an ordinary worktree is byte-identical — the escaping accepts what it should", (t) => {
  // The false-positive half: nothing here has anything to escape.
  const w = repo(t);
  const wt = addWorktree(w, "fix/119-json-sh-extract");

  const { code, json } = runAudit(w);

  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.deepEqual(e, { worktree: wt, branch: "fix/119-json-sh-extract", ahead: 0, dirty: 0, dirtyFiles: [], readable: true });
});

// #617: `dirtyFiles[]` carries git's C-quoting, which is not JSON's. One
// `caf\u00e9.txt` used to emit the literal `"caf\\303\\251.txt"` — `\\3` is not a JSON
// escape — and took the WHOLE array down with it, every other worktree's entry
// included, which is why the sibling assertion at the end is the real gate.
//
// The remedy chosen is translate-then-emit: the payload names the file that is
// on disk, so a controller reading it can hand the string straight back to the
// filesystem. Every branch of that translation is exercised here:
//   - an octal escape with the high bit set (`caf\u00e9.txt`)
//   - an octal escape for a C0 byte with NO named short form in either format
//     (`\\016`, SO) — the branch a mutation could break silently while every
//     other case here stayed green, since BEL/VT below reach `jesc` by the
//     letter branch, never the octal one (survived finding 2)
//   - the two verbatim short forms (`\\"`, `\\\\`)
//   - all four JSON-legal short forms git also spells with a letter
//     (`\\b`, `\\f`, `\\r`, `\\t`) — only `\\t` was covered before this
//   - BEL, which git spells `\\a` (a git short form JSON has none for)
//   - VT, which git spells `\\v` (the other git-only short form, untested
//     before this — survived finding 3)
// `jesc` treats BEL and VT alike: replaced with a space, the same treatment
// json.sh's `tr` gives every short-form-less C0 byte.
//
// Node re-encodes every JS string as UTF-8 on the way to the filesystem, so a
// source-literal `\u00e9` lands as the two bytes git C-quotes as `\\303\\251` — the
// exact input the bug needs. That route reaches VALID UTF-8 only: an invalid
// byte cannot be written from a JS string at all, and APFS refuses to hold one
// either; #582 covers that shape one script over. Every control byte here is
// spelled `\\uXXXX` rather than embedded, to keep a raw control byte out of
// this source file.
test("dirty filenames that git C-quotes round-trip to the real names", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  const names = [
    "caf\u00e9.txt",
    'q"q.txt',
    "b\\s.txt",
    "so\u000e.txt",
    "bs\u0008.txt",
    "ff\u000c.txt",
    "cr\u000d.txt",
    "ta\tb.txt",
    "bel\u0007.txt",
    "vt\u000b.txt",
  ];
  for (const n of names) writeFileSync(join(wt, n), "uncommitted\n");

  const { code, json } = runAudit(w);

  assert.equal(code, 0);
  const e = entryFor(json, wt);
  assert.equal(e.dirty, names.length);
  // Sorted rather than in git's order: git orders by raw bytes and JS by UTF-16
  // code unit, so pinning the order here would pin the wrong thing.
  assert.deepEqual(
    [...e.dirtyFiles].sort(),
    [
      "b\\s.txt",
      "so .txt",
      "bs\u0008.txt",
      "ff\u000c.txt",
      "cr\u000d.txt",
      "bel .txt",
      "vt .txt",
      "caf\u00e9.txt",
      'q"q.txt',
      "ta\tb.txt",
    ].sort(),
    "a C-quoted dirty filename no longer round-trips to the name on disk",
  );
  assert.equal(entryFor(json, w).readable, true, "one bad element must not cost the caller every other entry");
});

// #614: the BEHAVIOURAL twin of locale-pin-prose.test.mjs' source assertion for
// this script. That file checks the pin is PRESENT; this one checks it is
// LOAD-BEARING — with `export LC_ALL=C` deleted, the answer below changes.
//
// The ambient locale has to reach the child genuinely, not merely differ from
// `C`: a POSIX shell keeps a variable's export attribute once it is already in
// the environment, so seeding `LC_ALL: "en_US.UTF-8"` here would let a mutant
// that drops the `export` keyword still propagate `C` to every child. `LANG`
// with `LC_ALL` and `LC_CTYPE` absent is what an unset `LC_ALL` actually looks
// like — the shape #599's own regression test got wrong.
const AMBIENT_UTF8 = { LANG: "en_US.UTF-8", LC_ALL: undefined, LC_CTYPE: undefined };

/** Like runAudit, but byte-exact: an invalid UTF-8 byte cannot survive a utf8 decode. */
function runAuditBytes(cwd, envOverrides) {
  const r = spawnSync("sh", [SCRIPT], { cwd, env: { ...ENV, ...envOverrides } });
  return { code: r.status, stdout: r.stdout.toString("latin1"), stderr: r.stderr.toString("latin1") };
}

// Unlike every sibling fixture in this class, this one is vacuous on NEITHER
// platform — both halves of the payload below kill the mutant, on a different
// tool each:
//   - macOS (BWK awk, BSD paste): `jesc` decodes `\377` back to the raw byte,
//     and `paste -sd, -` then truncates its whole output at it, exit 0, stderr
//     empty. Measured: `"dirtyFiles":["b` — an unterminated JSON string that
//     takes the rest of the payload with it.
//   - Linux CI (gawk 5.4.1): awk survives, but `sprintf("%c", 195)` emits the
//     two-byte UTF-8 encoding of U+00C3 instead of the byte. Measured, mutant:
//     `["b\303\277ad.txt","caf\303\203\302\251.txt"]` — every non-ASCII dirty
//     filename double-encoded, and the payload no longer names a file the
//     caller can hand back to the filesystem.
// Pinned, both awks answer `["b\377ad.txt","caf\303\251.txt"]`.
//
// The `\377` entry goes in through `update-index --cacheinfo` with no working
// tree write: APFS refuses the name outright, and git reports the index-only
// blob as `AD` — deleted from the worktree — which is dirty all the same. The
// name is spelled as a `printf` FORMAT because node re-encodes every JS string
// as UTF-8 on the way to argv, which would turn `\377` into valid UTF-8 and
// reproduce nothing.
test("dirty filenames survive an ambient UTF-8 locale byte-for-byte (#614)", (t) => {
  const w = repo(t);
  const wt = addWorktree(w, "fix/9-x");
  writeFileSync(join(wt, "caf\u00e9.txt"), "uncommitted\n");
  execFileSync("sh", ["-c",
    'b=$(printf x | git hash-object -w --stdin) && git update-index --add --cacheinfo "100644,$b,$(printf "b\\377ad.txt")"'],
    { cwd: wt, env: ENV });

  const { code, stdout, stderr } = runAuditBytes(w, AMBIENT_UTF8);

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(
    stdout.includes('"dirtyFiles":["b\u00ffad.txt","caf\u00c3\u00a9.txt"]'),
    `the pin must hold both names whole and undecoded, got: ${JSON.stringify(stdout)}`,
  );
});

// #617 survived finding 1: the unrecognized-escape fallback used to be
// `else out=out c` — a silently dropped backslash with the following byte
// passed through unescaped, no error, no non-zero exit. Dead code under real
// git 2.50.1 (the enumeration above is exhaustive against it), so this drives
// `jesc`'s own awk program directly with a synthetic C-quoted string rather
// than trying to make real git emit an escape it never does. The program text
// is extracted from the shipped script at test time, never hand-copied, so
// this cannot drift from what actually ships.
function extractJescAwkProgram() {
  const src = readFileSync(SCRIPT, "utf8");
  const anchor = src.indexOf("function jesc");
  assert.ok(anchor > -1, "fixture: worktree-audit.sh must still define jesc");
  const startMarker = "awk '";
  const start = src.lastIndexOf(startMarker, anchor) + startMarker.length;
  const end = src.indexOf("'); then", anchor);
  assert.ok(start > startMarker.length - 1 && end > start, "fixture: could not locate jesc's awk program bounds");
  return src.slice(start, end);
}

test("jesc fails loud on an unrecognized C-quote escape, never corrupting the output", () => {
  const program = extractJescAwkProgram();
  const bad = spawnSync("awk", [program], { input: ' M "weird\\efile.txt"\n', env: ENV, encoding: "utf8" });
  assert.notEqual(bad.status, 0, "an unrecognized escape must fail the awk program, not emit a corrupted string");
  assert.equal(bad.stdout, "", "no corrupted string on stdout once the program has refused");
  assert.match(bad.stderr, /unrecognized C-quote escape/);

  // ACCEPT: the same program must still pass ordinary input, so the refusal
  // above is discrimination, not a program that fails unconditionally.
  const good = spawnSync("awk", [program], { input: ' M "caf\\303\\251.txt"\n', env: ENV, encoding: "utf8" });
  assert.equal(good.status, 0);
  assert.equal(good.stdout, '"caf\u00e9.txt"\n');
});

// #525: this script parses no positional argument — an argument was silently
// discarded, so a caller who thought they were scoping the audit to one
// worktree got a full audit of every worktree back at exit 0, first row the
// main checkout. Refuse instead, same contract as the missing-json.sh case
// below: exit 2, nothing on stdout.
test("a worktree path holding a newline is refused, never truncated (#551)", (t) => {
  // The plain porcelain ends every attribute with a newline, so a path holding
  // one split into two records: `substr($0,10)` stopped at the newline, and the
  // `while IFS=<TAB> read -r` loop below it stopped there a second time. This
  // script then reported `ahead=0 dirty=0 readable:true` about a path not on
  // disk — a clean, confident answer, which is what the fleet controller reads
  // to decide whether a replacement member would redo work or destroy it.
  //
  // The branch name cannot carry the newline (git rejects a control byte in a
  // ref), so the worktree is added by hand rather than through addWorktree.
  const w = repo(t);
  const ordinary = addWorktree(w, "plain-77");
  const wt = join(w, ".worktrees", "fix-33\nslug");
  git(w, "worktree", "add", "-q", wt, "-b", "fix/33-slug", "origin/main");

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0, "one unreadable entry must not take the whole audit down");
  assert.match(stderr, /path holds a newline/, "the refusal names the problem");

  // jstr renders the substituted byte as a space — the treatment every C0 byte
  // without a JSON short form gets — so the reported path is WHOLE with the
  // newline neutralised, never cut at it.
  const reported = json.map((e) => e.worktree);
  assert.ok(
    reported.some((x) => x.startsWith(`${w}/.worktrees/fix-33`) && x.endsWith("slug")),
    `the whole path must survive to the payload: ${JSON.stringify(reported)}`,
  );
  assert.ok(
    !reported.includes(join(w, ".worktrees", "fix-33")),
    "the truncated path is what this ticket exists to stop being reported",
  );
  const cut = json.find((e) => e.worktree.endsWith("slug"));
  assert.deepEqual(
    { readable: cut.readable, ahead: cut.ahead, dirty: cut.dirty },
    { readable: false, ahead: null, dirty: null },
    "nothing on disk was checked through that path, so nothing may be claimed about it",
  );

  // ACCEPT. A sibling ordinary worktree in the SAME listing must be audited
  // exactly as before — otherwise this pins that the guard refuses, not that it
  // discriminates, and a `nl_path` hard-wired true would pass every line above.
  assert.deepEqual(
    (({ worktree, ahead, dirty, readable }) => ({ worktree, ahead, dirty, readable }))(entryFor(json, ordinary)),
    { worktree: ordinary, ahead: 0, dirty: 0, readable: true },
  );
});

test("a dangling symlink at a worktree path is occupied, not MISSING on disk (#725)", (t) => {
  // `gone()` used `-e`, which STATS, so a dangling link was `-e` false and read
  // as established-absent — and this script reported `MISSING on disk` with
  // zero counts for a path `git worktree add` treats as occupied. Measured
  // before the fix, exactly that. The wording stays hedged: such a link is
  // rc-0 residue OR release-ticket.sh's rc-255 halt path with the branch and
  // the in-progress label still alive, and only the hedge is true of both (#728).
  const w = repo(t);
  const wt = addWorktree(w, "33-slug");
  rmSync(wt, { recursive: true, force: true });
  symlinkSync(join(w, "nowhere"), wt);

  const { code, json, stderr } = runAudit(w);
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /MISSING on disk/, "a link IS there — absence is the one thing this is not");
  assert.match(stderr, /exists but is not a directory/);
  const e = entryFor(json, wt);
  assert.deepEqual(
    { readable: e.readable, ahead: e.ahead, dirty: e.dirty },
    { readable: false, ahead: null, dirty: null },
    "null counts, never the 0/0 that reads as a clean worktree holding no work",
  );
});

test("a positional argument is refused, not silently discarded (#525)", (t) => {
  // No `addWorktree` here on purpose: `repo(t)` alone already yields one
  // auditable worktree (the main checkout), so an un-guarded script still
  // exits 0 with a non-empty array and the refusal assertion still reds.
  // Measured — the added worktree changed neither the red nor the green side.
  const w = repo(t);

  const r = spawnSync("sh", [SCRIPT, ".worktrees/fix/9-x"], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2, `must refuse, not silently audit everything; stdout: ${r.stdout}`);
  assert.equal(r.stdout, "", "no half-written array on a refusal");
  assert.match(r.stderr, /^worktree-audit: takes no arguments; audits every worktree$/m);
});

// --- #884/#894: the escape guard's FATALITY, not the message it carries.
//
// `wt_j=$(jstr "$wt") && short_j=$(jstr "$short") || die` is this script's
// guard; verify-sha.sh's own guard (`branch_j=$(jstr "$branch") &&
// sha_j=$(jstr "$sha") && tip_j=$(jstr "$tip") || die`) shares only the
// jstr/&&/`|| die` structure, not this exact code, and #884 pinned only this
// copy. Downgrade this one to a warning that does not exit and the script
// walks into the `printf` below it, emitting an entry whose escaping it
// never performed — a confident-looking
// but wrong JSON array, on the report a fleet controller reads to decide
// whether a replacement member would redo work or destroy it.
//
// Neither an exit-code nor a wording match can pin that. `die` here is 2, and
// this script defines no exit 1 at all (json.sh's header records why for all
// eight callers): a bare 1 out of it is a code its caller has no reading for.
// Which abort the mutant takes is the SHELL's choice, not this script's —
// measured with the guard downgraded to a non-exiting `printf … >&2`: /bin/sh
// (macOS bash 3.2) aborts at 1 with `short_j: unbound variable`, /bin/dash at 2
// with `short_j: parameter not set`. That 2 is the very status a firing guard
// returns, and CI's `check` job runs on ubuntu-latest, where `sh` IS dash — so
// an exit-code assertion pins this guard on a developer's Mac and waves the
// mutant through on the runner that gates the merge, while a wording match pins
// whichever shell uses that wording. The variable NAME is what discriminates:
// both shells name it first and word the rest however they like.
//
// `short_j` and not `wt_j`: the `&&` short-circuits, so a first capture that
// fails leaves `wt_j` set-and-empty and `short_j` never assigned at all.
//
// `jstr` escapes through a `sed`/`tr` pipeline, so shadowing `sed` reaches the
// escaper and nothing else this run touches: the script itself runs no `sed`
// (its `LC_ALL=C` note inventories that), `wt_listing` reads git's listing
// through `tr`, and `jesc` is awk. The `branch=` status trace the loop prints
// for each entry, just before it escapes that entry, stands in for the progress
// marker this guard would otherwise lack — it proves the run reached the
// escaping rather than an earlier step the shim happened to break, and
// printf-die-sweep.test.mjs pins that trace, so it cannot be reworded out from
// under the assertion below unseen. No assertion here names a `die` message:
// rewording any of them, this guard's own included, leaves the pin standing.

// Resolved out here, where PATH is still the real one, and quoted at the exec:
// a `sed` under a path with a space word-splits otherwise, and the passthrough
// shim would then break the escaper it exists to leave working.
const REAL_SED = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();

/** A dir holding a `sed` shim with the given body, prepended to PATH. */
function sedShim(t, body) {
  const bin = mkdtempSync(join(tmpdir(), "worktree-audit-sed-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "sed"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:${ENV.PATH ?? process.env.PATH}`;
}

test("an escaper that cannot run stops the audit, never an entry it failed to escape", (t) => {
  // `repo(t)` alone, no `addWorktree`: git lists the main checkout with its own
  // `branch` line, so the first iteration already reaches the guard.
  const w = repo(t);

  const r = spawnSync("sh", [SCRIPT], {
    cwd: w,
    env: { ...ENV, PATH: sedShim(t, 'echo "sed: outage" >&2\nexit 1') },
    encoding: "utf8",
  });

  // Whether this fixture measured the guard at all is settled before its
  // verdict is read: an assertion that fails masks every one after it, and
  // "the shim broke something else" and "the guard is not fatal" are not
  // interchangeable diagnoses.
  assert.match(r.stderr, /sed: outage/, "the escaper ran and failed, which is the failure under test");
  assert.ok(
    r.stderr.includes(`${w}  branch=main`),
    `the per-entry status trace printed, so the run reached the escaping — that is what failed here, not an earlier step the shim broke; got ${JSON.stringify(r.stderr)}`,
  );
  // And that the name it pins is still the one the shell would print: a rename
  // leaves the `doesNotMatch` below matching nothing and passing over a
  // downgraded guard forever, which is the one way this pin can rot silently.
  // `short_j` appears nowhere else in the script, comments included.
  assert.match(
    readFileSync(SCRIPT, "utf8"),
    /short_j/,
    "worktree-audit.sh no longer names `short_j` — re-derive the second capture's name from its escape guard and update the assertion below, which now pins nothing",
  );

  // The pin itself goes first, ahead of the two contract assertions below it:
  // measured on the mutant, /bin/sh's abort status is 1, so an exit-code
  // assertion placed above this one reds on a developer's Mac with a diagnosis
  // about a bare 1 — and masks the real one — while on dash it passes and
  // leaves this the only assertion that can fire at all.
  assert.doesNotMatch(
    r.stderr,
    /short_j/,
    "the guard must stop the script itself, not warn and leave the `printf` below it reading a name the short-circuited `&&` never assigned. The NAME, never the wording or the status: /bin/sh says `short_j: unbound variable` at exit 1, dash `short_j: parameter not set` at exit 2 — the same 2 a firing guard returns, under the shell CI actually runs.",
  );

  assert.equal(
    r.stdout,
    "[",
    "the opening bracket is already out and that is all a caller may see: a truncated array fails its parse, where an entry carrying escaping that never ran reads as a clean, confident answer. This is what catches the downgrade that defaults the name instead of leaving it unset, which the assertion above cannot see.",
  );
  assert.equal(
    r.status,
    2,
    `an entry that could not be escaped is "the question could not be answered", never the bare 1 this script's caller has no reading for; stdout: ${r.stdout}`,
  );
});

test("a shadowed `sed` that works still escapes the entry — only a real outage refuses", (t) => {
  // The accept half, and the control the case above needs: shadowing `sed` on
  // PATH is not by itself fatal here, so the refusal up there is the escaper
  // failing rather than the shim's mere presence. A path holding a `"` and a
  // `\` rather than an ordinary one, so the sed rules the shim now fronts have
  // something to do — `jstr` returns before it forks at all on an empty value,
  // and an ordinary path exercises no rule.
  const w = repo(t);
  const wt = join(w, '.worktrees/od"d\\path');
  git(w, "worktree", "add", "-q", wt, "-b", "fix/894-shim", "origin/main");

  const r = spawnSync("sh", [SCRIPT], {
    cwd: w,
    env: { ...ENV, PATH: sedShim(t, `exec "${REAL_SED}" "$@"`) },
    encoding: "utf8",
  });

  assert.equal(r.status, 0, `a working escaper must not change the answer; stderr: ${r.stderr}`);
  assert.deepEqual(
    entryFor(JSON.parse(r.stdout), wt),
    { worktree: wt, branch: "fix/894-shim", ahead: 0, dirty: 0, dirtyFiles: [], readable: true },
    "both escape rules ran through the shim to the entry the unshimmed run emits — the refusal above is an outage, not a shadowed name",
  );
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run. This script's
// contract is exit 0 or exit 2; a missing library must reach the 2.
test("a missing json.sh is exit 2, with no half-written array", (t) => {
  const w = repo(t);
  addWorktree(w, "fix/1-thing");
  const lone = mkdtempSync(join(tmpdir(), "worktree-audit-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "worktree-audit.sh"));

  const r = spawnSync("sh", [join(lone, "worktree-audit.sh")], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2, "a missing library is `the question could not be answered`");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the base ref");
  assert.equal(r.stdout, "",
    "and not even the opening `[` — the guard fires before the array is started, so no caller can see a truncated one");
});

// --- #1020: the ambient git variables, one fixture each.
//
// Deliberately NOT one fixture setting both. PR #1015 measured the cost of
// that shortcut on release-ticket.sh: a case overriding only one of the pair
// leaves the other half of `unset GIT_DIR GIT_WORK_TREE` unpinned and green,
// and the two halves break this script in two different directions anyway —
// GIT_DIR swaps the repository, GIT_WORK_TREE swaps the tree the dirty check
// answers about. One detector cannot see both.

test("an ambient GIT_WORK_TREE does not report a dirty worktree as clean (#1020)", (t) => {
  // The silent-failure half. GIT_WORK_TREE outranks `-C`, so the loop's
  // `git -C "$wt" status --porcelain -uall` reads the ambient tree's status
  // against $wt's index and answers EMPTY at rc 0 — a false clean on a
  // worktree that genuinely holds uncommitted work.
  //
  // `.gitignore` naming `.worktrees/` is not decoration: it is the fleet's own
  // layout, and it is what makes the leaked answer an EMPTY one rather than a
  // noisy `?? .worktrees/`. Without it the poisoned status still reports
  // SOMETHING and the false clean never forms, so the fixture would pass
  // pre-fix while pinning nothing.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore worktrees");
  git(w, "push", "-q", "origin", "main");
  const wt = addWorktree(w, "fix/1020-x");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  // The fixture's own positive control, in both directions — the same standard
  // the #730 case above holds itself to. Without the first, a git that stopped
  // honouring GIT_WORK_TREE would leave this green while measuring nothing;
  // without the second, the case could be passing because the worktree was
  // never dirty.
  assert.equal(
    git(wt, "status", "--porcelain"),
    "?? scratch.txt",
    "fixture: the worktree must really be dirty, or this case measures nothing",
  );
  assert.equal(
    execFileSync("git", ["-C", wt, "status", "--porcelain"], {
      cwd: w, env: { ...ENV, GIT_WORK_TREE: w }, encoding: "utf8",
    }),
    "",
    "fixture: the ambient GIT_WORK_TREE must really silence that answer, or the leak this pins no longer exists",
  );

  const { code, json, stderr } = runAudit(w, { env: { GIT_WORK_TREE: w } });

  assert.equal(code, 0, stderr);
  // `readable: true` alongside the count, for #730's reason: a fix that turned
  // the poisoned answer into an UNKNOWN would also stop reporting 0, and
  // unknown is a different — and here wrong — verdict about a worktree git can
  // answer for perfectly well once the variable is out of the way.
  assert.deepEqual(
    entryFor(json, wt),
    { worktree: wt, branch: "fix/1020-x", ahead: 0, dirty: 1, dirtyFiles: ["scratch.txt"], readable: true },
    "an ambient GIT_WORK_TREE must not make a dirty worktree report as clean — this report is what decides REDO vs DESTROY",
  );
});

test("an ambient GIT_DIR does not audit a different repository (#1020)", (t) => {
  // The correctness half, and it cannot use the dirty check as its detector:
  // GIT_DIR does not misdirect the `git -C "$wt"` calls at all. What it
  // retargets is every BARE git call above the loop — `rev-parse --git-dir`,
  // `rev-parse --verify "$base"`, and the `worktree list` behind `wt_listing`
  // — so the audit is assembled from the other repository's registry and never
  // mentions this one. Measured pre-fix: rc 0, a well-formed array, nothing on
  // stderr.
  const w = repo(t);
  const wt = addWorktree(w, "fix/1020-here");
  const other = repo(t, "other");
  const otherWt = addWorktree(other, "fix/1020-there");

  const { code, json, stderr } = runAudit(w, { env: { GIT_DIR: join(other, ".git") } });

  assert.equal(code, 0, stderr);
  // Both directions asserted, and either alone would already go red pre-fix.
  // The pair is what says the answer is about the WRONG REPOSITORY rather than
  // merely incomplete: a truncated listing loses `wt`, a retargeted one gains
  // `otherWt`, and only the second distinguishes them.
  assert.ok(
    json.some((e) => e.worktree === wt),
    `the audit must describe this checkout's own worktrees: ${JSON.stringify(json)}`,
  );
  assert.deepEqual(
    json.filter((e) => e.worktree === otherWt),
    [],
    `an ambient GIT_DIR must not make the audit answer for another checkout: ${JSON.stringify(json)}`,
  );
});

// --- #1108: the exit-2 cause census.
//
// The design spec's script-surface row states this script's failures as a
// CLOSED enumeration — `exit 2 only — A, B, C` — and until this block nothing
// in the repo read that cell. Two PRs in one fleet run each left a row asserting an
// enumeration its script had outgrown with the suite green (#1104/#525,
// #1105/#482), and on `main` this row was silent about three refusals the
// script reaches: the worktree-readers library guard, either library failing
// to load, and a worktree listing that could not be read. All three are
// measured below by running the script, never read off its source.
//
// Two pins, closing opposite directions:
//
//   TOO NARROW — the script grows a refusal the row does not carry. `CAUSES`
//   binds every `die` site to the phrase that represents it, and the census
//   test asserts that binding is EXACTLY the set of sites the script has. Add
//   a `die` and it reds on an unbound site; delete one and it reds on a
//   binding whose cause the script can no longer produce. The set is derived
//   from the script, so the binding cannot rot silently the way the row did —
//   a reworded message reds too, which is the point: the row is what then has
//   to be revisited.
//
//   TOO BROAD — the row grows a cause no `die` produces. The census cannot see
//   that; a phrase added to the cell binds to nothing and no assert notices.
//   `EXIT2_ENUMERATION` is the pin that does: the whole closed list, byte for
//   byte, in the `UNKNOWN_LINE`/`ORPHAN_LINE` verbatim-constant discipline
//   no-undo-audit.test.mjs already uses on this same table.
//
// The span pin's cost is deliberate, and it was #1108's ruling: it reds on
// EVERY edit to the enumeration, a legitimate rewording included. A structural
// assertion loose enough to survive rewording cannot red on a rewrite that
// quietly drops a real cause, which is the defect that was measured twice.
//
// Scoped to this script's own suite beside its siblings rather than lifted
// into one shared table over every row: `.out-of-scope/cli-guard-test-
// consolidation.md` refuses that consolidation for the CLI-guard pins, and its
// reason holds unchanged here — a file no single script's suite runs recreates
// the blind spot these pins exist to close.

/** The `Non-zero when` cell of this script's row, and no more of the row. */
const exit2Cell = () => specRow().split("|")[4];

/**
 * The row's exit-2 enumeration, verbatim: from `exit 2 only` to the end of the
 * sentence that closes the list. The cell's remaining sentence states the
 * exit-0 findings and is read by the `Out`-cell test above, so the span stops
 * where the closed list does — the slice is the size of the claim.
 */
const EXIT2_ENUMERATION =
  "exit 2 only — any argument at all (#525), not a repository, `BASE_REF` does not name a remote-tracking ref (#1329), `${BASE_REF:-origin/main}` does not resolve, `json.sh` or `worktree.sh` is missing, unreadable or failed to load (both guards fire above the opening `[`, so nothing is emitted), the `git worktree list` the audit is assembled from could not be read (#551), or an entry could not be escaped (#119) — that one fires inside the emitting loop, so stdout carries the array truncated mid-element and unparseable, which the exit 2 and the named stderr line are what distinguish from a complete answer.";

/**
 * The clause that collapses this script's four library refusals into one
 * cause. Named because four bindings below share it and a phrase typed four
 * times drifts three ways.
 */
const LIBRARY_CLAUSE = "`json.sh` or `worktree.sh` is missing, unreadable or failed to load";

/**
 * Every `die` site in worktree-audit.sh, bound to the phrase in the row that
 * represents it.
 *
 * The KEY is the message as the script spells it, interpolations and all.
 * `die` is this script's only exit-2 path — `dieSites` asserts that of the
 * definition itself — so the message set IS the cause set, and keying on it is
 * what makes this derived rather than a third hand-written copy of the
 * contract sitting beside the script and the row.
 *
 * Sites share a phrase where the ROW collapses them, which is the row's
 * editorial call and not a looseness here: a reader who meets any of the four
 * library refusals does the same thing about it. The phrases are the short
 * load-bearing labels; their exact wording is `EXIT2_ENUMERATION`'s job.
 */
const CAUSES = new Map([
  ["takes no arguments; audits every worktree", "any argument at all (#525)"],
  ["cannot read $json_lib — refusing to audit without the JSON escaping helpers", LIBRARY_CLAUSE],
  ["$json_lib failed to load", LIBRARY_CLAUSE],
  ["cannot read $wt_lib — refusing to audit without the worktree readers", LIBRARY_CLAUSE],
  ["$wt_lib failed to load", LIBRARY_CLAUSE],
  ["not inside a git repository", "not a repository"],
  ["BASE_REF must be a remote-tracking ref, got '$base'", "`BASE_REF` does not name a remote-tracking ref (#1329)"],
  ["$base does not resolve", "`${BASE_REF:-origin/main}` does not resolve"],
  ["$wt_err", "the `git worktree list` the audit is assembled from could not be read (#551)"],
  ["could not escape the entry for $wt", "an entry could not be escaped (#119)"],
]);

/**
 * The message of every `die` call in the script, read off the script.
 *
 * Comment lines are dropped: prose quoting a `die "…"` is not a call site, and
 * minting a cause out of one would red this suite over a comment. Greedy to
 * the last quote on the line, so a message carrying a nested `"$…"`
 * substitution arrives whole rather than truncated at its first inner quote.
 */
function dieSites() {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(
    src,
    /^die\(\) \{ printf '%s: %s\\n' "\$NAME" "\$1" >&2; exit 2; \}$/m,
    "the census derives its cause set from one `die` that exits 2 — that definition has changed, so re-derive before trusting this file",
  );
  const sites = src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => [...l.matchAll(/(?:^|[;&|(\s])die "(.*)"/g)].map((m) => m[1]));
  assert.ok(sites.length > 1, `the scan found ${sites.length} die sites, so its spelling has drifted off the script`);
  assert.equal(new Set(sites).size, sites.length, `two die sites share a message, so one of them cannot be bound: ${sites.join(" / ")}`);
  return sites;
}

test("the design spec's row represents every exit-2 cause this script can reach, and none it cannot (#1108)", () => {
  // Both directions in one equality: an unbound site is a cause the row may be
  // silent about, and a binding with no site is a cause the row claims while
  // the script can no longer produce it.
  assert.deepEqual([...dieSites()].sort(), [...CAUSES.keys()].sort());

  const cell = exit2Cell();
  for (const phrase of new Set(CAUSES.values())) {
    assert.equal(
      cell.split(phrase).length - 1,
      1,
      `the \`Non-zero when\` cell must carry "${phrase}" exactly once.\ncell: ${cell}`,
    );
  }
});

test("the design spec's row states this script's exit-2 causes as a closed list, byte for byte (#1108)", () => {
  // A prefix, not a search: a cause smuggled in ahead of the list would sit
  // outside an `includes`, and this cell opens on the list.
  assert.equal(exit2Cell().trim().slice(0, EXIT2_ENUMERATION.length), EXIT2_ENUMERATION);
});

// The worktree-readers guard had no fixture at all before #1108, which is how
// its absence from the row survived: the missing-json.sh case above reaches the
// json guard, which fires first, so a lone copy of this script can never reach
// this one. json.sh travels with the copy; worktree.sh does not.
test("a missing worktree.sh is exit 2, and the design spec's row names the library it blames (#1108)", (t) => {
  const w = repo(t);
  addWorktree(w, "fix/1-thing");
  const lone = mkdtempSync(join(tmpdir(), "worktree-audit-nowtlib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "worktree-audit.sh"));
  copyFileSync(fileURLToPath(new URL("./json.sh", import.meta.url)), join(lone, "json.sh"));

  const r = spawnSync("sh", [join(lone, "worktree-audit.sh")], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2, `a missing library is \`the question could not be answered\`: ${r.stderr}`);
  assert.equal(r.stdout, "",
    "and not even the opening `[` — the guard fires before the array is started, so no caller can see a truncated one");
  assert.match(r.stderr, /refusing to audit without the worktree readers/,
    "the fixture must reach the worktree-readers guard rather than the json.sh one above it");

  // The library NAME off the real refusal, never typed here: the path around it
  // is the machine's to vary and no document can carry it. Pre-#1108 this row
  // named json.sh alone, so this assert is what demonstrates the omission by
  // running the script rather than by reading it.
  const blamed = /^worktree-audit: cannot read \S*\/([^/ ]+) —/m.exec(r.stderr);
  assert.ok(blamed, `the refusal must name the library it could not read: ${r.stderr}`);
  assert.ok(
    exit2Cell().includes(`\`${blamed[1]}\``),
    `the spec row must name the library this refusal blames, and does not carry \`${blamed[1]}\`.\ncell: ${exit2Cell()}`,
  );
});
