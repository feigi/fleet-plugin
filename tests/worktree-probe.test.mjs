// The Registration probe in worktree.sh, sourced into a fresh /bin/sh and
// asked directly. Zero deps: `node --test tests/worktree-probe.test.mjs`.
//
// The scripts that call the probe are covered in their own suites
// (reap.test.mjs, release-ticket.test.mjs, inflight.test.mjs,
// no-undo-audit.test.mjs), which spawn whole scripts in fixture repos. This
// file is for the inputs no script can hand the probe — an empty branch name,
// a listing carrying the substituted newline byte, a cwd with no slash — and
// for verdicts cheaper to pin once at the seam than once per caller: the
// registry count over an empty and an unlistable entry, and each landing shape
// a refused `git worktree remove` leaves for `wt_outcome` to measure.
//
// It observes what the contract names — exit status, `$wt_why`, `$wt_path`,
// `$wt_outcome` and the counts — never the awk text or the order of internal
// calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../plugin/scripts/worktree.sh", import.meta.url));

const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).replace(/\n$/, "");

/** A repo with one commit on `main`, its root realpath'd the way git spells it. */
function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-probe-")));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+rwX", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", w], { env: ENV });
  git(w, "commit", "-q", "--allow-empty", "-m", "root");
  return { root, w };
}

/** A linked worktree at `<root>/<name>` on a new branch `<name>`. */
function linked(r, name) {
  const wt = join(r.root, name);
  git(r.w, "worktree", "add", "-q", "-b", name, wt, "main");
  return wt;
}

/**
 * Source worktree.sh in a fresh /bin/sh at `cwd`, run `body`, and return its
 * exit status and stdout. `$1` in the body is the first of `args`.
 */
function probe(cwd, body, ...args) {
  const r = spawnSync("/bin/sh", ["-c", `. "$0" || exit 99\n${body}`, LIB, ...args], {
    cwd, env: ENV, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(r.signal, null, `the probe must terminate: ${r.signal}`);
  assert.notEqual(r.status, 99, `worktree.sh failed to load: ${r.stderr}`);
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const isRoot = process.getuid?.() === 0;

// --- wt_find_branch

test("wt_find_branch refuses an empty branch name rather than answering \"no worktree\"", (t) => {
  const r = repo(t);
  const p = probe(r.w, `wt_listing || exit 3
if wt_find_branch ""; then echo "rc=0"; else echo "rc=$?"; fi
printf 'path=[%s]\\nwhy=%s\\n' "$wt_path" "$wt_why"`);
  assert.match(p.out, /^rc=1$/m);
  assert.match(p.out, /^path=\[\]$/m);
  assert.match(p.out, /^why=no branch name was given/m);
});

test("wt_find_branch refuses a listing that was never read rather than answering \"no worktree\"", (t) => {
  const r = repo(t);
  const p = probe(r.w, `wt_list=
if wt_find_branch main; then echo "rc=0"; else echo "rc=$?"; fi
printf 'why=%s\\n' "$wt_why"`);
  assert.match(p.out, /^rc=1$/m);
  assert.match(p.out, /^why=the worktree listing was not read/m);
});

test("wt_find_branch hands back a path carrying the substituted newline byte whole", (t) => {
  // A listing as `wt_listing` delivers a newline inside a path: swapped for
  // \001, one record per path. The lookup must return the whole path for a
  // caller's `nl_path` to refuse, never the part before the byte.
  const r = repo(t);
  const p = probe(r.w, `wt_root=/nonexistent-registry
wt_list=$(printf 'worktree /m\\nHEAD 1111111111111111111111111111111111111111\\nbranch refs/heads/main\\n\\nworktree /wt/fix-33\\001slug\\nHEAD 2222222222222222222222222222222222222222\\nbranch refs/heads/fix/33-slug\\n')
if wt_find_branch fix/33-slug; then echo "rc=0"; else echo "rc=$?"; fi
printf 'path=[%s]\\n' "$wt_path"
nl_path "$wt_path" && echo nl=yes`);
  assert.match(p.out, /^rc=0$/m);
  assert.ok(p.out.includes("path=[/wt/fix-33\u0001slug]"), p.out);
  assert.match(p.out, /^nl=yes$/m);
});

test("wt_find_branch answers every holder in listing order, the main checkout included, and none for an absent branch", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  const p = probe(r.w, `wt_listing || exit 3
wt_find_branch main && printf 'main=[%s]\\n' "$wt_path"
wt_find_branch feat && printf 'feat=[%s]\\n' "$wt_path"
wt_find_branch nope && printf 'nope=[%s]\\n' "$wt_path"`);
  assert.ok(p.out.includes(`main=[${r.w}]`), p.out);
  assert.ok(p.out.includes(`feat=[${wt}]`), p.out);
  assert.ok(p.out.includes("nope=[]"), p.out);
});

test("wt_find_branch refuses a holder git lists inside its own registry — a garbage gitdir (#2144)", (t) => {
  const r = repo(t);
  linked(r, "feat");
  writeFileSync(join(r.w, ".git", "worktrees", "feat", "gitdir"), "not a path\n");
  const p = probe(r.w, `wt_listing || exit 3
if wt_find_branch feat; then echo "rc=0"; else echo "rc=$?"; fi
printf 'path=[%s]\\nwhy=%s\\n' "$wt_path" "$wt_why"`);
  assert.match(p.out, /^rc=1$/m);
  assert.match(p.out, /^path=\[\]$/m);
  assert.match(p.out, /^why=git lists feat's worktree at .*\/\.git\/worktrees\/feat\/not a path, inside the worktree registry/m);
});

// --- wt_holds_cwd

test("wt_holds_cwd matches the directory and anything beneath it, by inode, and terminates on every input", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  mkdirSync(join(wt, "sub", "deeper"), { recursive: true });
  symlinkSync(r.root, join(r.root, "..", `${r.root.split("/").pop()}-link`));
  const link = join(r.root, "..", `${r.root.split("/").pop()}-link`);
  t.after(() => rmSync(link, { force: true }));
  const cases = [
    [wt, wt, 0, "the worktree itself"],
    [wt, join(wt, "sub", "deeper"), 0, "a directory nested in it"],
    [wt, join(link, "feat", "sub"), 0, "the same directory through a symlinked parent"],
    [wt, r.w, 1, "a sibling checkout"],
    [wt, "", 1, "no cwd at all"],
    [wt, "relative-no-slash", 1, "a cwd with no slash: compared once, never spun on"],
  ];
  for (const [dir, cwd, want, why] of cases) {
    const p = probe(r.w, `if wt_holds_cwd "$1" "$2"; then echo 0; else echo 1; fi`, dir, cwd);
    assert.equal(p.out.trim(), String(want), `${why}: ${p.err}`);
  }
});

// --- wt_linkage

test("wt_linkage accepts a healthy worktree and refuses a symlink to a different worktree (#2074)", (t) => {
  const r = repo(t);
  const a = linked(r, "a");
  const b = linked(r, "b");
  const ok = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$? why=$wt_why"; fi`, b);
  assert.equal(ok.out.trim(), "rc=0", ok.err);

  rmSync(a, { recursive: true, force: true });
  symlinkSync(b, a);
  const bad = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$?"; printf 'why=%s\\n' "$wt_why"; fi`, a);
  assert.match(bad.out, /^rc=1$/m);
  assert.ok(bad.out.includes(`why=${a} is a symbolic link to another worktree's directory — its .git linkage reaches the admin dir registered for ${b}, not for ${a}`), bad.out);
});

test("wt_linkage accepts a symlink standing in for the worktree's own renamed directory", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  const p = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$? why=$wt_why"; fi`, wt);
  assert.equal(p.out.trim(), "rc=0");
});

test("wt_linkage refuses a core.worktree redirect, naming the tree git answers for", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  const other = linked(r, "other");
  git(r.w, "config", "extensions.worktreeConfig", "true");
  git(wt, "config", "--worktree", "core.worktree", other);
  const p = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$?"; printf 'why=%s\\n' "$wt_why"; fi`, wt);
  assert.match(p.out, /^rc=1$/m);
  assert.ok(p.out.includes(`why=${wt}'s .git linkage does not point at ${wt} — git answers for the working tree at ${other}, not ${wt}`), p.out);
});

test("wt_linkage refuses a .git git cannot resolve, with git's own words", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  writeFileSync(join(wt, ".git"), "gitdir: /nonexistent-admin-dir\n");
  const p = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$?"; printf 'why=%s\\n' "$wt_why"; fi`, wt);
  assert.match(p.out, /^rc=1$/m);
  assert.match(p.out, /^why=cannot read the git repository at .* — its \.git linkage .* does not resolve: .*nonexistent-admin-dir/m);
});

// --- wt_counts

test("wt_counts agrees on a repo with no registry and on one with a linked worktree", (t) => {
  const r = repo(t);
  const body = `if wt_counts; then echo rc=0; else echo "rc=$? why=$wt_why"; fi
printf 'registered=%s linked=%s\\n' "$wt_registered" "$wt_linked"`;
  assert.equal(probe(r.w, body).out, "rc=0\nregistered=0 linked=0\n");
  linked(r, "feat");
  assert.equal(probe(r.w, body).out, "rc=0\nregistered=1 linked=1\n");
});

test("wt_counts skips an empty registry directory and counts one it cannot list", (t) => {
  if (isRoot) return t.skip("root lists every directory");
  const r = repo(t);
  linked(r, "feat");
  const reg = join(r.w, ".git", "worktrees");
  mkdirSync(join(reg, "stray-mkdir"));
  const body = `if wt_counts; then echo rc=0; else echo "rc=$?"; fi
printf 'registered=%s linked=%s\\nwhy=%s\\n' "$wt_registered" "$wt_linked" "$wt_why"`;
  // The empty one alone: an operator's stray `mkdir`, which git ignores too.
  assert.match(probe(r.w, body).out, /^rc=0\nregistered=1 linked=1\n/);

  // Now an entry nothing can list: it is counted, git drops it, and the counts
  // refuse in the dropped-entry direction.
  const hidden = join(reg, "hidden");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "gitdir"), "/nowhere/.git\n");
  chmodSync(hidden, 0o000);
  const p = probe(r.w, body);
  chmodSync(hidden, 0o755);
  assert.match(p.out, /^rc=1$/m);
  assert.match(p.out, /^registered=2 linked=1$/m);
  assert.match(p.out, /^why=git listed 1 worktrees for 2 registry entries in .* — the listing is incomplete/m);
});

test("wt_counts refuses a registry replaced by a searchable file", (t) => {
  const r = repo(t);
  const reg = join(r.w, ".git", "worktrees");
  writeFileSync(reg, "not a directory\n", { mode: 0o755 });
  const p = probe(r.w, `if wt_counts; then echo rc=0; else echo "rc=$?"; printf 'why=%s\\n' "$wt_why"; fi`);
  assert.match(p.out, /^rc=1$/m);
  assert.match(p.out, /^why=worktree registry .* could not be read$/m);
});

// --- wt_outcome

test("wt_outcome measures each landing shape of a refused `git worktree remove`, and restores $wt_list", (t) => {
  const r = repo(t);
  const body = `wt_listing || exit 3
before=$wt_list
git worktree remove "$1" >/dev/null 2>&1 && echo removed=yes
wt_outcome "$1"
printf 'outcome=%s\\nwhy=%s\\n' "$wt_outcome" "$wt_why"
[ "$wt_list" = "$before" ] && echo restored=yes`;

  // Dirty: git refuses at rc 128 with the registration and directory kept.
  const dirty = linked(r, "dirty");
  writeFileSync(join(dirty, "untracked.txt"), "work\n");
  let p = probe(r.w, body, dirty);
  assert.doesNotMatch(p.out, /removed=yes/);
  assert.match(p.out, /^outcome=Unreleased$/m);
  assert.match(p.out, /^restored=yes$/m);

  // A symlink standing in for the directory: rc 255, the registration cleared
  // and the path kept.
  const standin = linked(r, "standin");
  renameSync(standin, `${standin}-real`);
  symlinkSync(`${standin}-real`, standin);
  p = probe(r.w, body, standin);
  assert.doesNotMatch(p.out, /removed=yes/);
  assert.match(p.out, /^outcome=Deregistered$/m);
  assert.match(p.out, /^restored=yes$/m);

  // A removal that landed whole: registration and directory both gone.
  const clean = linked(r, "clean");
  p = probe(r.w, body, clean);
  assert.match(p.out, /^removed=yes$/m);
  assert.match(p.out, /^outcome=Released$/m);
  assert.match(p.out, /^why=$/m);
});

test("wt_outcome is Indeterminate, with git's reason, when the fresh listing cannot be read", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  const bin = mkdtempSync(join(tmpdir(), "wt-probe-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"),
    `#!/bin/sh\n[ "$1" = worktree ] && [ "$2" = list ] && { echo "fatal: listing exploded" >&2; exit 128; }\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 });
  const p = probe(r.w, `PATH="$2:$PATH"; wt_list=kept
wt_outcome "$1"
printf 'outcome=%s\\nwhy=%s\\nlist=%s\\n' "$wt_outcome" "$wt_why" "$wt_list"`, wt, bin);
  assert.match(p.out, /^outcome=Indeterminate$/m);
  assert.match(p.out, /^why=fatal: listing exploded/m);
  assert.match(p.out, /^list=kept$/m);
});
