// Regression gate for instruments.sh, the check that says whether the
// controller's instrument set changed under a run (#436), re-contracted to
// audit the WORKING DIRECTORY's checkout rather than the checkout the script
// itself lives in (#1337). The install-only dev loop (ADR 0003) means this
// script normally runs out of a plugin cache; resolving from its own
// location measured whatever git checkout happens to CONTAIN that cache
// path, which was the operator's unrelated personal repo, not the plugin's
// own tree.
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
// to it — the script resolves the tree to measure from $PWD (or --repo), so a
// fixture repo is measured regardless of where the copy of instruments.sh
// invoked actually lives, and the live checkout is never touched.
//
// Zero deps: `node --test plugin/scripts/instruments.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./instruments.sh", import.meta.url));
// #1336 nested the plugin's payload under `plugin/`, so the instrument set is
// that subtree rather than the repo root itself. Every join() below reads as
// "under the set".
const SET = "plugin";

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `core.excludesfile` or hook cannot change what these repos look like.
// The GIT_* redirects would point the fixture out of its own temp dir.
const ENV = {
  ...process.env,
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
  return root;
}

// Runs the copy of instruments.sh that lives INSIDE `root`, with cwd set to
// `root` by default — the audited repo is now derived from cwd, never from
// where the script itself sits, so the default here is what an ordinary
// invocation from inside the checkout looks like. `cwd` is overridable for
// the tests that specifically exercise cwd-vs-script-location divergence, and
// `env` for the one #1020 case that has to put back a variable ENV scrubs —
// that scrub is what keeps every other case here deterministic, so the opt-in
// is per-call rather than a hole in ENV.
const run = (root, args = [], { cwd = root, env = {} } = {}) =>
  spawnSync(join(root, SET, "scripts", "instruments.sh"), args, {
    cwd,
    env: { ...ENV, ...env },
    encoding: "utf8",
  });

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
  const r = run(root, ["--pin"]);
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
  // Exactly what claim-ticket.sh and reap.sh do to the main checkout every
  // wave. A ref digest would refuse here, several times per wave.
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
// CWD CONTRACT (#1337). The audited repository comes from $PWD (or --repo),
// never from where the invoked copy of instruments.sh happens to live. Every
// test below places the SCRIPT somewhere other than the repo it must audit,
// which the tests above never do — proving the resolution is cwd-driven, not
// merely untested against $0.
// ---------------------------------------------------------------------------

// A plugin-cache-shaped fixture: instruments.sh nested several directories
// deep inside a FOREIGN git repository — the shape `~/.claude/plugins/cache/
// fleet-plugin/fleet-ctl/<version>/scripts/instruments.sh` takes when `~/.claude`
// is itself the operator's personal dotfiles checkout (#1337's own report).
// Built with `git init` in a fresh temp dir, never the real checkout or
// `~/.claude`.
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

test("(1) run from an installed cache nested in a foreign repo, cwd inside a separate repo, audits the cwd repo", (t) => {
  const cwdRepo = repo(t);
  const { foreign, script } = foreignAncestorCache(t);
  const r = spawnSync(script, ["--pin"], { cwd: cwdRepo, env: ENV, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // The baseline path it reports names the cwd repo, not the cache's own tree.
  assert.match(r.stderr, /pinned/);
  assert.ok(
    r.stderr.includes(`over ${cwdRepo} (`),
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

test("(3) --repo audits the named repository regardless of the working directory", (t) => {
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
  // agrees with cwd, and the check reports the target's own digest, not
  // anything derived from `other`.
  const other = repo(t);
  const r2 = run(other, ["--repo", target]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout.trim(), pinnedDigest);
  assert.deepEqual(findFleetDirs(other), []);
});

test("(4) --pin from a directory nested inside a foreign git repo never writes into that ancestor", (t) => {
  // The foreign repo is the ANCESTOR directory tree, holding BOTH a
  // plugin-cache-shaped copy of instruments.sh AND, elsewhere under the same
  // ancestor, a SEPARATE nested git checkout used as cwd — the shape
  // `~/.claude` takes when it is itself a git repo, the plugin cache sits
  // under `~/.claude/plugins/cache/...`, and a fleet-plugin checkout is
  // ALSO nested somewhere under `~/.claude` (e.g. `~/.claude/dev/`). Script
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
    env: ENV,
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
