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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    // Seeded, so a reason left by an earlier probe would show through.
    const p = probe(r.w, `wt_why=stale; if wt_holds_cwd "$1" "$2"; then echo 0; else echo 1; fi; printf 'why=%s\\n' "$wt_why"`, dir, cwd);
    assert.equal(p.out, `${want}\nwhy=\n`, `${why}: a match and a non-match both leave no reason: ${p.err}`);
  }
});

test("wt_holds_cwd fails closed when `[` cannot evaluate -ef (rc 2 or more), and names that fault", (t) => {
  // No input makes a real `[` answer 2 for `-ef`, and `[` cannot be a function
  // in every /bin/sh. An alias names the stand-in before the library is read,
  // so every `[` the library parses is the stand-in: -ef answers 2 when its
  // left side is `$WT_EF_FAULT` (every left side when that is empty), all else
  // is the real builtin.
  const r = repo(t);
  const wt = linked(r, "feat");
  const run = (cwd, fault = "") =>
    spawnSync("/bin/sh", ["-c", `wt_stub() { case "$2" in -ef) case "$WT_EF_FAULT" in "" | "$1") return 2 ;; esac ;; esac; command [ "$@"; }
alias [=wt_stub
. "$0" || exit 99
unalias [
wt_why=stale
if wt_holds_cwd "$1" "$2"; then echo 0; else echo 1; fi
printf 'why=%s\\n' "$wt_why"`, LIB, wt, cwd], { cwd: r.w, env: { ...ENV, WT_EF_FAULT: fault }, encoding: "utf8", timeout: 30_000 });
  for (const cwd of [wt, join(wt, "no", "such", "dir"), "relative-no-slash"]) {
    const p = run(cwd);
    assert.equal(
      p.stdout,
      `0\nwhy=could not compare ${cwd} with ${wt} (test -ef exited 2), so whether removing ${wt} would delete the working directory is unknown\n`,
      `cwd ${JSON.stringify(cwd)}: refused, with the compare named in place of a match: ${p.stderr}`,
    );
  }
  // The fault on an ANCESTOR compare: the first compare answers "not this
  // one", and the reason names the parent that could not be compared.
  const p = run(join(r.w, "elsewhere"), r.w);
  assert.equal(
    p.stdout,
    `0\nwhy=could not compare ${r.w} with ${wt} (test -ef exited 2), so whether removing ${wt} would delete the working directory is unknown\n`,
    p.stderr,
  );
});

// The probe body most `wt_linkage` tests run: the verdict, and the reason on a refusal.
const LINKAGE_PROBE = `if wt_linkage "$1"; then echo rc=0; else echo "rc=$?"; printf 'why=%s\\n' "$wt_why"; fi`;

// --- wt_linkage

test("wt_linkage accepts a healthy worktree and refuses a symlink to a different worktree (#2074)", (t) => {
  const r = repo(t);
  const a = linked(r, "a");
  const b = linked(r, "b");
  const ok = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$? why=$wt_why"; fi`, b);
  assert.equal(ok.out.trim(), "rc=0", ok.err);

  rmSync(a, { recursive: true, force: true });
  symlinkSync(b, a);
  const bad = probe(r.w, LINKAGE_PROBE, a);
  assert.match(bad.out, /^rc=1$/m);
  assert.ok(bad.out.includes(`why=${a} is a symbolic link to another worktree's directory — its .git linkage reaches the admin dir registered for ${b}, not for ${a}`), bad.out);
});

test("wt_linkage refuses a path the listing names for two worktrees — a swap under worktree.useRelativePaths", (t) => {
  // With relative back-pointers git resolves the swapped entry to the TARGET's
  // directory, so the listing names that directory twice and the path a caller
  // holds is a real directory, not a link: `-L` never fires on it.
  const r = repo(t);
  git(r.w, "config", "worktree.useRelativePaths", "true");
  const a = linked(r, "a");
  const b = linked(r, "b");
  if (!/^gitdir: \.\.\//.test(readFileSync(join(a, ".git"), "utf8"))) {
    return t.skip("this git does not write relative worktree paths, so the shape cannot exist");
  }
  const body = `wt_listing || exit 3
if wt_linkage "$1"; then echo rc=0; else echo "rc=$?"; fi
printf 'why=%s\\n' "$wt_why"`;
  const ok = probe(r.w, body, b);
  assert.match(ok.out, /^rc=0$/m, ok.out);

  renameSync(a, `${a}-real`);
  symlinkSync(b, a);
  const bad = probe(r.w, body, b);
  assert.match(bad.out, /^rc=1$/m, bad.out);
  assert.ok(bad.out.includes(`why=the worktree listing names ${b} for 2 worktrees — a symbolic link standing in for another worktree's directory`), bad.out);
});

test("wt_linkage accepts a symlink standing in for the worktree's own renamed directory", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  const p = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$? why=$wt_why"; fi`, wt);
  assert.equal(p.out.trim(), "rc=0");
});

test("wt_linkage judges a bare directory name against the cwd — accepts a link for its own renamed directory, refuses a sibling's", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  const b = linked(r, "b");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  const own = probe(r.root, LINKAGE_PROBE, "feat");
  assert.equal(own.out.trim(), "rc=0", own.out);

  const a = linked(r, "a");
  renameSync(a, `${a}-real`);
  symlinkSync(b, a);
  const bad = probe(r.root, LINKAGE_PROBE, "a");
  assert.match(bad.out, /^rc=1$/m, bad.out);
  assert.ok(bad.out.includes("why=a is a symbolic link to another worktree's directory"), bad.out);
});

test("wt_linkage resolves a relative back-pointer against its admin dir — accepts the worktree's own renamed directory, refuses a sibling's", (t) => {
  const r = repo(t);
  git(r.w, "config", "worktree.useRelativePaths", "true");
  const wt = linked(r, "feat");
  const b = linked(r, "b");
  if (!/^\.\.\//.test(readFileSync(join(r.w, ".git", "worktrees", "feat", "gitdir"), "utf8"))) {
    return t.skip("this git does not write relative worktree paths, so the shape cannot exist");
  }
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  const own = probe(r.w, LINKAGE_PROBE, wt);
  assert.equal(own.out.trim(), "rc=0", own.out);

  // No listing read, so the back-pointer compare alone must refuse the swap.
  const a = linked(r, "a");
  renameSync(a, `${a}-real`);
  symlinkSync(b, a);
  const bad = probe(r.w, LINKAGE_PROBE, a);
  assert.match(bad.out, /^rc=1$/m, bad.out);
  assert.ok(bad.out.includes(`why=${a} is a symbolic link to another worktree's directory`), bad.out);
  assert.ok(bad.out.includes(`registered for ${r.w}/.git/worktrees/b/`), bad.out);
  assert.ok(bad.out.includes(`/b, not for ${a}`), bad.out);
});

// `wt_linkage` with and without a listing read first, for each spelling of $1.
const LINKAGE_LISTED = `wt_listing || exit 3\n${LINKAGE_PROBE}`;
// `wt_linkage` behind a `git` shim that `revParseShim` put first on PATH.
const LINKAGE_SHIMMED = `PATH="$2:$PATH"\n${LINKAGE_PROBE}`;
// Trailing slashes and `/.` components, each of which follows a link where the
// bare path would not.
const TRAILING = (p) => [`${p}/`, `${p}//`, `${p}///`, `${p}/.`, `${p}/./`, `${p}/.//.`];

// `a`, swapped for a link to a sibling worktree, is refused with the same
// reason under every spelling, with and without a listing.
function assertSwappedLinkRefused(r, a) {
  for (const body of [LINKAGE_PROBE, LINKAGE_LISTED]) {
    const bare = probe(r.w, body, a);
    assert.match(bare.out, /^rc=1$/m, bare.out);
    assert.ok(bare.out.includes(`why=${a} is a symbolic link to another worktree's directory`), bare.out);
    for (const p of TRAILING(a)) assert.equal(probe(r.w, body, p).out, bare.out, p);
  }
}

test("wt_linkage gives a path spelled with trailing slashes or `/.` the verdict and reason of the bare path", (t) => {
  const r = repo(t);
  const a = linked(r, "a");
  const b = linked(r, "b");
  for (const body of [LINKAGE_PROBE, LINKAGE_LISTED]) {
    for (const p of TRAILING(b)) {
      assert.equal(probe(r.w, body, p).out.trim(), "rc=0", `${p}: a real linked worktree`);
    }
  }

  renameSync(a, `${a}-real`);
  symlinkSync(b, a);
  assertSwappedLinkRefused(r, a);

  // A bare name judged against the cwd, spelled the same ways.
  const rel = probe(r.root, LINKAGE_PROBE, "a");
  assert.match(rel.out, /^rc=1$/m, rel.out);
  for (const p of TRAILING("a")) assert.equal(probe(r.root, LINKAGE_PROBE, p).out, rel.out, p);
});

test("wt_linkage gives trailing-slash and `/.` spellings the bare path's verdict under worktree.useRelativePaths", (t) => {
  const r = repo(t);
  git(r.w, "config", "worktree.useRelativePaths", "true");
  const a = linked(r, "a");
  const b = linked(r, "b");
  if (!/^\.\.\//.test(readFileSync(join(r.w, ".git", "worktrees", "a", "gitdir"), "utf8"))) {
    return t.skip("this git does not write relative worktree paths, so the shape cannot exist");
  }
  renameSync(a, `${a}-real`);
  symlinkSync(b, a);
  // The link itself, refused on its back-pointer with or without a listing.
  assertSwappedLinkRefused(r, a);
  // The target's real directory, which the listing now names twice.
  const twice = probe(r.w, LINKAGE_LISTED, b);
  assert.match(twice.out, /^rc=1$/m, twice.out);
  assert.ok(twice.out.includes(`why=the worktree listing names ${b} for 2 worktrees`), twice.out);
  for (const p of TRAILING(b)) assert.equal(probe(r.w, LINKAGE_LISTED, p).out, twice.out, p);
});

test("wt_linkage accepts the worktree's own renamed directory spelled with trailing slashes or `/.`, and keeps a lone / as /", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  for (const body of [LINKAGE_PROBE, LINKAGE_LISTED]) {
    for (const p of [wt, ...TRAILING(wt)]) {
      assert.equal(probe(r.w, body, p).out.trim(), "rc=0", `${p}: its own renamed directory`);
    }
  }
  for (const p of ["feat", ...TRAILING("feat")]) {
    assert.equal(probe(r.root, LINKAGE_PROBE, p).out.trim(), "rc=0", `${p}: its own renamed directory`);
  }

  // `/` is no repository, so it is refused naming `/` — never judged as the
  // empty path, which `git -C` would read as the cwd's own repository.
  for (const p of ["/", "//", "///"]) {
    const root = probe(r.w, LINKAGE_PROBE, p);
    assert.match(root.out, /^rc=1$/m, root.out);
    assert.ok(root.out.includes("why=cannot read the git repository at / —"), `${p}: ${root.out}`);
  }
});

test("wt_linkage terminates on an empty path and refuses it, naming the empty path", (t) => {
  const r = repo(t);
  for (const body of [LINKAGE_PROBE, LINKAGE_LISTED]) {
    const empty = probe(r.w, body, "");
    assert.match(empty.out, /^rc=1$/m, empty.out);
    assert.ok(empty.out.includes("why=an empty path names no worktree"), empty.out);
  }
});

test("wt_linkage accepts the worktree's own renamed directory spelled through a symlinked parent", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  const link = `${r.root}-link`;
  symlinkSync(r.root, link);
  t.after(() => rmSync(link, { force: true }));
  const p = probe(r.w, `if wt_linkage "$1"; then echo rc=0; else echo "rc=$? why=$wt_why"; fi`, join(link, "feat"));
  assert.equal(p.out.trim(), "rc=0", p.out);
});

test("wt_linkage refuses a symlink carrying a worktree's name in another directory", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  mkdirSync(join(r.root, "other"));
  const imposter = join(r.root, "other", "feat");
  symlinkSync(wt, imposter);
  const p = probe(r.w, LINKAGE_PROBE, imposter);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.ok(p.out.includes(`why=${imposter} is a symbolic link to another worktree's directory — its .git linkage reaches the admin dir registered for ${wt}, not for ${imposter}`), p.out);
});

test("wt_linkage refuses a core.worktree redirect, naming the tree git answers for", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  const other = linked(r, "other");
  git(r.w, "config", "extensions.worktreeConfig", "true");
  git(wt, "config", "--worktree", "core.worktree", other);
  const p = probe(r.w, LINKAGE_PROBE, wt);
  assert.match(p.out, /^rc=1$/m);
  assert.ok(p.out.includes(`why=${wt}'s .git linkage does not point at ${wt} — git answers for the working tree at ${other}, not ${wt}`), p.out);
});

test("wt_linkage refuses a .git git cannot resolve, with git's own words", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  writeFileSync(join(wt, ".git"), "gitdir: /nonexistent-admin-dir\n");
  const p = probe(r.w, LINKAGE_PROBE, wt);
  assert.match(p.out, /^rc=1$/m);
  // The probe's own words are pinned, and that a diagnostic from git follows;
  // not which words git chose — older git prints `(null)` where newer git echoes the path.
  assert.match(p.out, /^why=cannot read the git repository at .* — its \.git linkage .* does not resolve: \S/m);
});

test("wt_linkage refuses a symlink whose admin dir's gitdir back-pointer cannot be read, naming the read", (t) => {
  if (isRoot) return t.skip("root reads every file");
  const r = repo(t);
  const wt = linked(r, "feat");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  assert.equal(probe(r.w, LINKAGE_PROBE, wt).out, "rc=0\n", "the link stands for its own renamed directory");
  chmodSync(join(r.w, ".git", "worktrees", "feat", "gitdir"), 0o000);
  const p = probe(r.w, LINKAGE_PROBE, wt);
  assert.equal(p.out, `rc=1\nwhy=${wt} is a symbolic link whose admin dir's gitdir back-pointer could not be read, so which worktree it stands for is unknown\n`, p.err);
});

test("wt_linkage refuses a symlink through which git cannot report the admin dir, naming the lookup with git's own words", (t) => {
  const r = repo(t);
  const wt = linked(r, "feat");
  const plain = linked(r, "plain");
  renameSync(wt, `${wt}-real`);
  symlinkSync(`${wt}-real`, wt);
  const lookup = "symbolic link through which git could not report its admin dir, so which worktree it stands for is unknown";
  const silent = revParseShim(t, "--absolute-git-dir", "exit 1");
  assert.equal(probe(r.w, LINKAGE_SHIMMED, wt, silent).out, `rc=1\nwhy=${wt} is a ${lookup}\n`);
  // Asked only of a link: a plain worktree directory never reaches the lookup.
  assert.equal(probe(r.w, LINKAGE_SHIMMED, plain, silent).out, "rc=0\n");
  const worded = revParseShim(t, "--absolute-git-dir", `printf 'fatal: first\\nhint: second\\n' >&2; exit 1`);
  assert.equal(probe(r.w, LINKAGE_SHIMMED, wt, worded).out, `rc=1\nwhy=${wt} is a ${lookup}: fatal: first hint: second\n`);
});

// --- wt_registry_root

const REGISTRY_ROOT = `if wt_registry_root; then echo rc=0; else echo "rc=$?"; fi
printf 'root=%s\\nwhy=%s\\n' "$wt_root" "$wt_why"`;

/** A `git` ahead of the real one on PATH that runs `onOption` (a /bin/sh snippet) for a `rev-parse` carrying `option` and passes everything else through. */
function revParseShim(t, option, onOption) {
  const bin = mkdtempSync(join(tmpdir(), "wt-probe-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"),
    `#!/bin/sh\ncase "$*" in *rev-parse*${option}*)\n${onOption}\n;; esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 });
  return bin;
}

test("wt_registry_root refuses outside a repository with git's own words on the reason's line", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "wt-probe-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, "not-a-repo");
  mkdirSync(dir);
  const env = { ...ENV, GIT_CEILING_DIRECTORIES: parent };
  // Git's words as this git prints them, so no version's wording is pinned.
  const g = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(g.status, 0, "the fixture directory must be outside any repository");
  const gitWords = g.stderr.replace(/\n+$/, "").replace(/\n/g, " ");
  assert.notEqual(gitWords, "", "git explains why it cannot answer");
  const p = probe(dir, `GIT_CEILING_DIRECTORIES="$1"; export GIT_CEILING_DIRECTORIES\n${REGISTRY_ROOT}`, parent);
  assert.equal(p.out, `rc=1\nroot=\nwhy=cannot resolve the git common directory: ${gitWords}\n`);
});

test("wt_registry_root refuses with the bare reason when git fails without a word", (t) => {
  const r = repo(t);
  const bin = revParseShim(t, "--git-common-dir", "exit 1");
  const p = probe(r.w, `PATH="$1:$PATH"\n${REGISTRY_ROOT}`, bin);
  assert.equal(p.out, "rc=1\nroot=\nwhy=cannot resolve the git common directory\n");
});

test("wt_registry_root flattens a multi-line message from git onto the reason's one line", (t) => {
  const r = repo(t);
  const bin = revParseShim(t, "--git-common-dir", `printf 'fatal: first\\nhint: second\\n' >&2; exit 1`);
  const p = probe(r.w, `PATH="$1:$PATH"\n${REGISTRY_ROOT}`, bin);
  assert.equal(p.out, "rc=1\nroot=\nwhy=cannot resolve the git common directory: fatal: first hint: second\n");
});

test("wt_registry_root keeps a warning git prints at exit 0 out of the path it answers", (t) => {
  const r = repo(t);
  const bin = revParseShim(t, "--git-common-dir", `echo "warning: noise on stderr" >&2`);
  const p = probe(r.w, `PATH="$1:$PATH"\n${REGISTRY_ROOT}`, bin);
  assert.equal(p.out, `rc=0\nroot=${r.w}/.git/worktrees\nwhy=\n`);
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

/** A linked worktree in the fleet's own layout, `<checkout>/.worktrees/<name>`, on a new branch `<name>`. */
function fleetLinked(r, name, ...flags) {
  const wt = join(r.w, ".worktrees", name);
  git(r.w, "worktree", "add", "-q", ...flags, "-b", name, wt, "main");
  writeFileSync(join(wt, "untracked.txt"), "work that exists nowhere else\n");
  return wt;
}

/** The admin dir `wt`'s `.git` pointer names, a relative one prefixed with `wt/` unnormalised, as the probe spells it. */
function pointed(wt) {
  const to = readFileSync(join(wt, ".git"), "utf8").trim().replace(/^gitdir: /, "");
  return to.startsWith("/") ? to : `${wt}/${to}`;
}

test("wt_counts refuses a live .worktrees pointer once the whole registry is removed", (t) => {
  const r = repo(t);
  const wt = fleetLinked(r, "1-held");
  rmSync(join(r.w, ".git", "worktrees"), { recursive: true, force: true });
  const p = probe(r.w, COUNTS);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.ok(p.out.includes(`why=worktree pointer ${wt}/.git names admin dir ${pointed(wt)}, which is missing from the worktree registry ${r.w}/.git/worktrees`), p.out);
});

for (const flags of [[], ["--relative-paths"]]) {
  test(`wt_counts refuses a live .worktrees pointer whose admin entry alone is removed${flags.length ? ", spelled relative" : ""}`, (t) => {
    const r = repo(t);
    fleetLinked(r, "2-other");
    let wt;
    try {
      wt = fleetLinked(r, "1-held", ...flags);
    } catch {
      return t.skip("this git cannot write relative worktree paths");
    }
    if (flags.length && readFileSync(join(wt, ".git"), "utf8").startsWith("gitdir: /")) return t.skip("this git wrote an absolute path");
    const admin = pointed(wt);
    rmSync(admin, { recursive: true, force: true });
    const p = probe(r.w, COUNTS);
    assert.match(p.out, /^rc=1$/m, p.out);
    assert.match(p.out, /^registered=1 linked=1$/m, "the counts agree — the pointer is what refuses");
    assert.ok(p.out.includes(`why=worktree pointer ${wt}/.git names admin dir ${admin}, which is missing from the worktree registry`), p.out);
  });
}

test("wt_counts refuses a live .worktrees pointer whose admin entry was emptied, which git ignores like a removed one", (t) => {
  const r = repo(t);
  const wt = fleetLinked(r, "1-held");
  const admin = pointed(wt);
  rmSync(admin, { recursive: true, force: true });
  mkdirSync(admin);
  const p = probe(r.w, COUNTS);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.ok(p.out.includes(`why=worktree pointer ${wt}/.git names admin dir ${admin}, an empty directory git does not list`), p.out);
});

test("wt_counts refuses an unlisted .worktrees directory or pointer it cannot read or parse", (t) => {
  if (isRoot) return t.skip("root reads every file");
  const r = repo(t);
  const wt = fleetLinked(r, "1-held");
  rmSync(pointed(wt), { recursive: true, force: true });
  const dotgit = join(wt, ".git");
  chmodSync(dotgit, 0o000);
  let p = probe(r.w, COUNTS);
  chmodSync(dotgit, 0o644);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.ok(p.out.includes(`why=worktree pointer ${dotgit} could not be read`), p.out);

  chmodSync(wt, 0o000);
  p = probe(r.w, COUNTS);
  chmodSync(wt, 0o755);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.ok(p.out.includes(`why=worktree directory ${wt} is not in git's listing and could not be searched`), p.out);

  writeFileSync(dotgit, "not a pointer\n");
  p = probe(r.w, COUNTS);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.ok(p.out.includes(`why=worktree pointer ${dotgit} names no admin dir`), p.out);
});

test("wt_counts agrees over .worktrees entries that are not this registry's lost worktrees", (t) => {
  if (isRoot) return t.skip("root reads every file");
  const r = repo(t);
  const held = fleetLinked(r, "1-held");
  let relative;
  try {
    relative = fleetLinked(r, "2-relative", "--relative-paths");
  } catch {
    relative = fleetLinked(r, "2-relative");
  }
  const wts = join(r.w, ".worktrees");
  // A directory with no `.git` at all, and one whose `.git` is a directory: neither is a linked worktree.
  mkdirSync(join(wts, "3-stray"));
  execFileSync("git", ["init", "-q", join(wts, "4-clone")], { env: ENV });
  // A pointer into ANOTHER repo's registry, at an entry that repo does not hold: not this registry's to answer for.
  const foreign = join(r.root, "foreign");
  execFileSync("git", ["init", "-q", foreign], { env: ENV });
  mkdirSync(join(foreign, ".git", "worktrees"));
  mkdirSync(join(wts, "5-foreign"));
  writeFileSync(join(wts, "5-foreign", ".git"), `gitdir: ${foreign}/.git/worktrees/5-foreign\n`);
  // Unlisted copies whose pointers name admin dirs the registry still holds, in endings git accepts (git 2.50.1): CRLF, and no newline at all.
  mkdirSync(join(wts, "6-copy"));
  writeFileSync(join(wts, "6-copy", ".git"), `gitdir: ${pointed(held)}\r\n`);
  mkdirSync(join(wts, "7-copy"));
  writeFileSync(join(wts, "7-copy", ".git"), `gitdir: ../../.git/worktrees/2-relative`);
  for (const copy of ["6-copy", "7-copy"]) {
    assert.equal(git(join(wts, copy), "rev-parse", "--path-format=absolute", "--git-common-dir"), join(r.w, ".git"), `fixture: git reads ${copy}'s pointer`);
  }
  // A worktree git still LISTS, its pointer redirected at an entry the registry does not hold: the listing holds its branch.
  writeFileSync(join(held, ".git"), `gitdir: ${r.w}/.git/worktrees/nope\n`);
  // A plain file standing where a worktree would.
  writeFileSync(join(wts, "8-file"), "not a worktree\n");
  assert.equal(probe(r.w, COUNTS).out, "rc=0\nregistered=2 linked=2\nwhy=\n");
  // From inside a member's worktree, the cwd every member runs these scripts from.
  assert.equal(probe(relative, COUNTS).out, "rc=0\nregistered=2 linked=2\nwhy=\n");
  // And a `.worktrees` that cannot be listed is left to the callers' per-worktree guards.
  chmodSync(wts, 0o000);
  const p = probe(r.w, COUNTS);
  chmodSync(wts, 0o755);
  assert.equal(p.out, "rc=0\nregistered=2 linked=2\nwhy=\n");
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

/** A `git` ahead of the real one on PATH that answers `worktree list` through `listing` (a /bin/sh snippet) and passes everything else through. */
function listShim(t, listing) {
  const bin = mkdtempSync(join(tmpdir(), "wt-probe-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ]; then\nREAL='${realGit}'\n${listing}\nfi\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 });
  return bin;
}

const COUNTS = `if wt_counts; then echo rc=0; else echo "rc=$?"; fi
printf 'registered=%s linked=%s\\nwhy=%s\\n' "$wt_registered" "$wt_linked" "$wt_why"`;

test("wt_counts re-takes a pair that disagreed once and answers the agreeing one", (t) => {
  const r = repo(t);
  linked(r, "feat");
  const state = join(r.root, "calls");
  // First listing drops the linked worktree (a sibling's `add` landing between the two reads); every later one is git's own.
  const bin = listShim(t, `n=$(cat '${state}' 2>/dev/null || echo 0)
echo $((n + 1)) >'${state}'
if [ "$n" = 0 ]; then printf 'worktree /main\\000HEAD 1111111111111111111111111111111111111111\\000branch refs/heads/main\\000\\000'; exit 0; fi`);
  const p = probe(r.w, `PATH="$2:$PATH"\n${COUNTS}`, "", bin);
  assert.match(p.out, /^rc=0$/m, p.out);
  assert.match(p.out, /^registered=1 linked=1$/m);
});

test("wt_counts refuses a listing that holds MORE worktrees than the registry, naming the registry read", (t) => {
  const r = repo(t);
  const bin = listShim(t, `"$REAL" "$@"; rc=$?
printf 'worktree /nowhere\\000HEAD 2222222222222222222222222222222222222222\\000detached\\000\\000'
exit $rc`);
  const p = probe(r.w, `PATH="$2:$PATH"\n${COUNTS}`, "", bin);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.match(p.out, /^registered=0 linked=1$/m);
  assert.match(p.out, /^why=git listed 1 worktrees but only 0 registry entries were counted in .*registry read missed entries/m);
});

test("wt_counts refuses a listing with no worktree at all, not even the main checkout", (t) => {
  const r = repo(t);
  const bin = listShim(t, `exit 0`);
  const p = probe(r.w, `PATH="$2:$PATH"\n${COUNTS}`, "", bin);
  assert.match(p.out, /^rc=1$/m, p.out);
  assert.match(p.out, /^why=git listed no worktrees at all — not even the main checkout/m);
});

test("wt_occupied answers for anything standing at the path, a dangling symlink included", (t) => {
  const r = repo(t);
  const dangling = join(r.root, "dangling");
  symlinkSync(join(r.root, "nowhere"), dangling);
  const body = `if wt_occupied "$1"; then echo occupied; else echo free; fi`;
  assert.equal(probe(r.w, body, dangling).out.trim(), "occupied");
  assert.equal(probe(r.w, body, r.w).out.trim(), "occupied");
  assert.equal(probe(r.w, body, join(r.root, "absent")).out.trim(), "free");
});
