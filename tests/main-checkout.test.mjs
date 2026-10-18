// Regression gate for main-checkout.mjs (#2210), the tick's main-checkout
// dirty check. Zero deps:
//   node --test tests/main-checkout.test.mjs
//
// Every case runs in a real temporary repository: what is under test is how
// git's porcelain, the gitignore, a linked worktree and the filesystem answer,
// and a stubbed git would answer whatever the stub was told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMainCheckout, recordBaseline, baselinePath, describe } from "../plugin/scripts/main-checkout.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/main-checkout.mjs", import.meta.url));
// Permission cases mean nothing to root, which reads through any mode bits.
const ROOT = process.getuid?.() === 0;

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// A fleet-shaped main checkout on `main`: one tracked file, `.fleet/` and
// `.worktrees/` ignored the way a fleet repo's .gitignore ignores them, and a
// bare origin holding `main` — `origin/main` is what HEAD is judged against.
function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-")));
  const origin = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-origin-")));
  t.after(() => {
    // Restore what a case took away, or rmSync cannot clear it.
    for (const p of [join(dir, ".fleet"), join(dir, "locked.txt")]) try { chmodSync(p, 0o755); } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".fleet/\n.worktrees/\n.agent-brain/\n");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}

const record = (cwd, env) => {
  const r = recordBaseline({ cwd, env });
  assert.equal(r.ok, true, r.why);
  return r;
};
const check = (cwd, env) => checkMainCheckout({ cwd, env });

test("a clean tree recorded and left alone is clean", (t) => {
  const dir = repo(t);
  record(dir);
  assert.equal(check(dir).state, "clean");
});

test("uncommitted work present at run start is in the baseline and holds nothing", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "mine, uncommitted\n");
  writeFileSync(join(dir, "notes.md"), "untracked, mine\n");
  record(dir);
  assert.equal(check(dir).state, "clean");
});

test("a new untracked file is dirty, and named", (t) => {
  const dir = repo(t);
  record(dir);
  mkdirSync(join(dir, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(dir, "plugin", "scripts", "stray.mjs"), "x\n");
  const c = check(dir);
  assert.equal(c.state, "dirty");
  // -uall: the file itself, never only its new directory.
  assert.deepEqual(c.changed, ["plugin/scripts/stray.mjs"]);
});

test("an untracked file is dirty even where status.showUntrackedFiles=no would silence it (#730)", (t) => {
  const dir = repo(t);
  git(dir, "config", "status.showUntrackedFiles", "no");
  record(dir);
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(dir).changed, ["stray.txt"]);
});

test("a modified tracked file is dirty", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "tracked.txt"), "two\n");
  assert.deepEqual(check(dir), { state: "dirty", root: dir, baseline: baselinePath(dir), changed: ["tracked.txt"] });
});

test("a further edit to a file already dirty at the baseline is dirty — the hash, not the status line, catches it", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "mine\n");
  writeFileSync(join(dir, "notes.md"), "mine\n");
  record(dir);
  appendFileSync(join(dir, "tracked.txt"), "a member's line\n");
  assert.deepEqual(check(dir).changed, ["tracked.txt"]);
  appendFileSync(join(dir, "notes.md"), "a member's line\n");
  assert.deepEqual(check(dir).changed, ["notes.md", "tracked.txt"]);
});

test("a deleted tracked file, and an entry that leaves porcelain, are both dirty", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "notes.md"), "mine\n");
  record(dir);
  unlinkSync(join(dir, "tracked.txt"));
  unlinkSync(join(dir, "notes.md"));
  assert.deepEqual(check(dir).changed, ["notes.md", "tracked.txt"]);
});

test("staging a change is a change", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "mine\n");
  record(dir);
  git(dir, "add", "tracked.txt");
  assert.deepEqual(check(dir).changed, ["tracked.txt"]);
});

// A repository nested in the main checkout, with one committed file `f`:
// untracked, porcelain lists it as `nested/`; `gitlink: true` commits it to
// the main checkout as a submodule's gitlink, listed as `nested` once dirty.
function nested(dir, { gitlink = false } = {}) {
  const sub = join(dir, "nested");
  mkdirSync(sub);
  git(sub, "init", "-q");
  writeFileSync(join(sub, "f"), "committed\n");
  git(sub, "add", "f");
  git(sub, "commit", "-qm", "init");
  if (gitlink) {
    git(dir, "-c", "advice.addEmbeddedRepo=false", "add", "nested");
    git(dir, "commit", "-qm", "gitlink");
  }
  return sub;
}

test("a further edit inside a nested repository already dirty at the baseline is dirty", (t) => {
  for (const gitlink of [false, true]) {
    const dir = repo(t);
    const sub = nested(dir, { gitlink });
    writeFileSync(join(sub, "f"), "mine, uncommitted\n");
    record(dir);
    assert.equal(check(dir).state, "clean");
    appendFileSync(join(sub, "f"), "a member's line\n");
    assert.deepEqual(check(dir).changed, [gitlink ? "nested" : "nested/"]);
  }
});

test("a commit inside a nested repository is dirty, though its status reads the same", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  record(dir);
  git(sub, "commit", "-q", "--allow-empty", "-m", "a member's commit");
  assert.deepEqual(check(dir).changed, ["nested/"]);
});

test("a nested repository left alone is clean, a commitless one too", (t) => {
  const dir = repo(t);
  nested(dir);
  const bare = join(dir, "fresh");
  mkdirSync(bare);
  git(bare, "init", "-q");
  writeFileSync(join(bare, "draft.txt"), "x\n");
  record(dir);
  assert.equal(check(dir).state, "clean");
  appendFileSync(join(bare, "draft.txt"), "y\n");
  assert.deepEqual(check(dir).changed, ["fresh/"]);
});

test("the run's bookkeeping exemption is the main checkout's paths, not a nested repository's", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  record(dir);
  mkdirSync(join(sub, "docs", "metrics"), { recursive: true });
  writeFileSync(join(sub, "docs", "metrics", "tier-outcomes.tsv"), "x\n");
  assert.deepEqual(check(dir).changed, ["nested/"]);
});

test("a nested repository whose .git is a file — a linked worktree, a submodule — is hashed like one whose .git is a directory", (t) => {
  const dir = repo(t);
  const wt = join(dir, "wt");
  git(dir, "worktree", "add", "-q", "-b", "wtb", wt);
  const src = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-src-")));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  git(src, "init", "-q");
  writeFileSync(join(src, "f"), "committed\n");
  git(src, "add", "f");
  git(src, "commit", "-qm", "init");
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sm");
  git(dir, "commit", "-qm", "sm");
  writeFileSync(join(wt, "tracked.txt"), "mine, uncommitted\n");
  writeFileSync(join(dir, "sm", "f"), "mine, uncommitted\n");
  for (const p of [join(wt, ".git"), join(dir, "sm", ".git")]) assert.ok(lstatSync(p).isFile(), `${p} is not a file`);
  record(dir);
  assert.equal(check(dir).state, "clean");
  appendFileSync(join(wt, "tracked.txt"), "a member's line\n");
  appendFileSync(join(dir, "sm", "f"), "a member's line\n");
  assert.deepEqual(check(dir).changed, ["sm", "wt/"]);
});

test("a nested repository git cannot read is unknown, never clean", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  writeFileSync(join(sub, "f"), "mine, uncommitted\n");
  record(dir);
  writeFileSync(join(sub, ".git", "index"), "not an index");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^cannot hash nested\/: git status --porcelain -uall exited \d+/);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
});

test("a nested repository whose HEAD git cannot resolve is unknown, never clean", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  record(dir);
  // HEAD names a branch git rejects as a ref name: `git status` still answers
  // (`nested/` clean), while `rev-parse HEAD` and `symbolic-ref HEAD` both fail.
  writeFileSync(join(sub, ".git", "HEAD"), "ref: refs/heads/..bad\n");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^cannot hash nested\/: git symbolic-ref HEAD exited \d+/);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
});

test("a nested repository whose branch ref exists but names no readable commit is unknown, never unborn", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  record(dir);
  // `git status` still answers with the ref pointing at a tree, while
  // `rev-parse HEAD^{commit}` fails; the ref exists, so this is not the unborn
  // case.
  const ref = git(sub, "symbolic-ref", "HEAD").trim();
  const tree = git(sub, "rev-parse", "HEAD^{tree}").trim();
  writeFileSync(join(sub, ".git", ...ref.split("/")), `${tree}\n`);
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.equal(c.why, `cannot hash nested/: HEAD points to ${ref} but the commit cannot be resolved`);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
});

test("a nested repository whose unborn probe fails is unknown, never unborn", (t) => {
  const dir = repo(t);
  const fresh = join(dir, "fresh");
  mkdirSync(fresh);
  git(fresh, "init", "-q");
  record(dir);
  assert.equal(check(dir).state, "clean");
  // A git first on PATH that fails `show-ref` as a killed or broken one would
  // and runs everything else as the real git.
  const shim = join(dir, ".fleet", "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "git"), [
    "#!/bin/sh",
    'if [ "$1" = show-ref ]; then echo "fatal: injected" >&2; exit 128; fi',
    'PATH="$REAL_PATH" exec git "$@"',
    "",
  ].join("\n"));
  chmodSync(join(shim, "git"), 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, REAL_PATH: process.env.PATH };
  const c = check(dir, env);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.equal(c.why, "cannot hash fresh/: git show-ref --verify exited 128: fatal: injected");
});

test("a write under a gitignored directory is clean — run state, agent-brain's cache", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, ".fleet", "ledger.md"), "# ledger\n");
  mkdirSync(join(dir, ".agent-brain"));
  writeFileSync(join(dir, ".agent-brain", "index.md"), "x\n");
  assert.equal(check(dir).state, "clean");
});

test("the run's own bookkeeping is not a stray write: the controller's metrics appends stay clean, anything beside them does not", (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, "docs", "metrics"), { recursive: true });
  writeFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), "# header\n");
  writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), "# header\n");
  writeFileSync(join(dir, "docs", "metrics", "ticket-features.tsv"), "# header\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "metrics");
  record(dir);
  // What the controller does mid-run: `tier-outcomes.mjs append` per ruled
  // PR, the member-facts scrape rewriting its file, the pending-rows drain
  // appending to the features file. Twice, as a run does.
  for (const row of ["2026-10-01\t2298\n", "2026-10-01\t2302\n"]) {
    appendFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), row);
    writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), `# header\n${row}`);
    appendFileSync(join(dir, "docs", "metrics", "ticket-features.tsv"), row);
    assert.equal(check(dir).state, "clean", "the controller's own append held the run");
  }
  // Three named files, never the directory, and a stray beside them is named alone.
  writeFileSync(join(dir, "docs", "metrics", "stray.tsv"), "x\n");
  writeFileSync(join(dir, "tracked.txt"), "a member's\n");
  assert.deepEqual(check(dir).changed, ["docs/metrics/stray.tsv", "tracked.txt"]);
});

test("a write inside .worktrees/<x>/ is clean, and the check run from that worktree still answers for the main checkout", (t) => {
  const dir = repo(t);
  git(dir, "worktree", "add", "-q", "-b", "impl/1", join(dir, ".worktrees", "1-x"));
  record(dir);
  const wt = join(dir, ".worktrees", "1-x");
  writeFileSync(join(wt, "tracked.txt"), "a member's own work\n");
  writeFileSync(join(wt, "new.mjs"), "x\n");
  assert.equal(check(dir).state, "clean");
  const fromWt = check(wt);
  assert.equal(fromWt.state, "clean");
  assert.equal(fromWt.root, dir, "resolved the worktree as the main checkout — --show-toplevel's answer, not the common dir's");
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(wt).changed, ["stray.txt"], "a stray write is invisible from a member's worktree");
});

test("paths that would split or blur the line are quoted in it", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "plain.txt"), "x\n");
  writeFileSync(join(dir, "a b.txt"), "x\n");
  writeFileSync(join(dir, 'q"uote.txt'), "x\n");
  writeFileSync(join(dir, "back\\slash.txt"), "x\n");
  writeFileSync(join(dir, "ctl\x01.txt"), "x\n");
  writeFileSync(join(dir, "new\nline.txt"), "x\n");
  const c = check(dir);
  assert.deepEqual(c.changed, ["a b.txt", "back\\slash.txt", "ctl\x01.txt", "new\nline.txt", "plain.txt", 'q"uote.txt']);
  const said = describe(c, ["impl-7"]);
  assert.ok(said.startsWith(`MAIN-CHECKOUT-DIRTY "a b.txt" "back\\\\slash.txt" "ctl\\u0001.txt" "new\\nline.txt" plain.txt "q\\"uote.txt" — `), said);
  assert.doesNotMatch(said, /[\x00-\x1f]/, "a raw control byte reached the printed line");
});

test("a git that fails is unknown, never clean", (t) => {
  const dir = repo(t);
  record(dir);
  // A corrupt index: git status exits non-zero.
  writeFileSync(join(dir, ".git", "index"), "not an index");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /git status --porcelain -uall exited \d+/);
  assert.match(describe(c, []), /^MAIN-CHECKOUT-UNKNOWN could not look: .*NEVER re-baseline over it/);
});

test("a directory that is no repository is unknown, never clean", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-norepo-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = check(dir, { ...process.env, GIT_CEILING_DIRECTORIES: dir });
  assert.equal(c.state, "unknown");
  assert.match(c.why, /git rev-parse --git-common-dir exited 128/);
});

test("a path git names but the check cannot hash is unknown, never clean", { skip: ROOT }, (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "locked.txt"), "x\n");
  chmodSync(join(dir, "locked.txt"), 0o000);
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /cannot hash locked\.txt: EACCES/);
});

test("an ambient GIT_DIR naming another repository does not change the answer (#1599)", (t) => {
  const dir = repo(t);
  const decoy = repo(t);
  writeFileSync(join(decoy, "decoy-stray.txt"), "x\n");
  const env = { ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy };
  record(dir, env);
  assert.equal(readFileSync(baselinePath(dir), "utf8").includes("decoy-stray"), false, "the baseline recorded the decoy's tree");
  assert.equal(check(dir, env).state, "clean");
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(dir, env).changed, ["stray.txt"]);
});

test("no baseline is its own refusal, never clean", (t) => {
  const dir = repo(t);
  const c = check(dir);
  assert.deepEqual(c, { state: "absent", root: dir, baseline: baselinePath(dir) });
  assert.match(describe(c, []), /^MAIN-CHECKOUT-NO-BASELINE no baseline at .*main-checkout\.sha — .*record it at run start/);
});

test("a baseline that exists but cannot be read is its own unknown, never clean and never 'no baseline'", { skip: ROOT }, (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);

  chmodSync(base, 0o000);
  let c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "baseline");
  assert.match(c.why, /exists but cannot be read: EACCES/);
  assert.match(describe(c, []), /^MAIN-CHECKOUT-UNKNOWN baseline unreadable: .*NEVER re-baseline over it/);
  chmodSync(base, 0o644);

  // An unsearchable .fleet/ hides the file from stat: EACCES, not ENOENT.
  chmodSync(join(dir, ".fleet"), 0o600);
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "baseline");
  chmodSync(join(dir, ".fleet"), 0o755);

  unlinkSync(base);
  symlinkSync(join(dir, "gone"), base);
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /dangling symlink/);
  unlinkSync(base);

  writeFileSync(base, "deadbeef\n");
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /not a baseline main-checkout\.mjs --record wrote/);
});

test("--record overwrites rather than compares: after the stray paths are resolved it clears, and it clears a dirty tree too", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.equal(check(dir).state, "dirty");
  // Re-baselining while dirty certifies the tree as it stands — which is why
  // the runbook says resolve FIRST.
  record(dir);
  assert.equal(check(dir).state, "clean");
  unlinkSync(join(dir, "stray.txt"));
  assert.equal(check(dir).state, "dirty", "removing a path the baseline recorded is a change");
});

test("--record refuses over a baseline it cannot read, and leaves it in place", { skip: ROOT }, (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);
  chmodSync(base, 0o000);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /do NOT --record over it, --record overwrites rather than compares/);
  chmodSync(base, 0o644);
  writeFileSync(base, "not a baseline\n");
  assert.equal(recordBaseline({ cwd: dir }).ok, false);
  assert.equal(readFileSync(base, "utf8"), "not a baseline\n");
});

test("--record refuses when git cannot look, and writes nothing", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, ".git", "index"), "not an index");
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /could not look, so there is nothing to record/);
  assert.equal(check(dir).state, "absent");
});

test("CLI: --record then --check, with the exit codes the header names", (t) => {
  const dir = repo(t);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  let r = run("--check");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^MAIN-CHECKOUT-NO-BASELINE /);
  r = run("--record");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^main-checkout: recorded 0 porcelain entries at /);
  r = run("--check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^main-checkout: clean against /);
  writeFileSync(join(dir, "stray.txt"), "x\n");
  r = run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MAIN-CHECKOUT-DIRTY stray\.txt — /);
  writeFileSync(join(dir, ".git", "index"), "not an index");
  r = run("--check");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^MAIN-CHECKOUT-UNKNOWN /);
  r = run("--record");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^main-checkout: .*could not look/m);
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: main-checkout\.mjs --record \| --check/);
  r = run("--record", "--check");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: main-checkout\.mjs --record \| --check/);
  r = run("--recrod");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--recrod/, "a misspelt flag must be refused by name, never run as a check");
});

// ---------------------------------------------------------------------------
// HEAD is part of the protected set: the symbolic ref and the commit.
// ---------------------------------------------------------------------------

const head = (dir) => git(dir, "rev-parse", "--short=7", "HEAD").trim();
const originOf = (dir) => git(dir, "remote", "get-url", "origin").trim();

// A second commit, pushed: gives `reset --hard HEAD~1` somewhere to land.
function secondCommit(dir) {
  writeFileSync(join(dir, "second.txt"), "two\n");
  git(dir, "add", "second.txt");
  git(dir, "commit", "-qm", "second");
  git(dir, "push", "-q", "origin", "main");
}

// What lands on origin/main while a run is going: another clone pushes, then
// the main checkout fetches — which moves `origin/main` and nothing else.
function advanceOrigin(t, dir) {
  const other = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-clone-")));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, "clone", "-q", originOf(dir), ".");
  writeFileSync(join(other, "landed.txt"), "landed\n");
  git(other, "add", "landed.txt");
  git(other, "commit", "-qm", "landed");
  git(other, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
}

const headEntry = (was, ref, now) => `HEAD refs/heads/main@${was} → ${ref}@${now}`;

test("a stray commit, a branch switch, a detach, a reset and an amend each move HEAD: dirty, and the entry names HEAD", (t) => {
  const moves = {
    "git commit": (dir) => {
      writeFileSync(join(dir, "stray.txt"), "s\n");
      git(dir, "add", "stray.txt");
      git(dir, "commit", "-qm", "stray");
    },
    "git checkout -b": (dir) => git(dir, "checkout", "-q", "-b", "other"),
    "git switch --detach": (dir) => git(dir, "switch", "-q", "--detach"),
    "git reset --hard HEAD~1": (dir) => git(dir, "reset", "-q", "--hard", "HEAD~1"),
    // A changed message, so the oid moves even within the same second.
    "git commit --amend": (dir) => git(dir, "commit", "-q", "--amend", "-m", "a different message"),
  };
  for (const [name, move] of Object.entries(moves)) {
    const dir = repo(t);
    secondCommit(dir);
    record(dir);
    const was = head(dir);
    move(dir);
    const c = check(dir);
    assert.equal(c.state, "dirty", `${name} read ${c.state}`);
    assert.equal(c.changed.length, 1, `${name}: ${JSON.stringify(c.changed)}`);
    assert.equal(c.headMove, c.changed[0], name);
    assert.match(describe(c, []), /^MAIN-CHECKOUT-DIRTY HEAD refs\/heads\/main@[0-9a-f]{7} → \S+@[0-9a-f]{7} — changed since the run's baseline/, name);
    assert.ok(c.changed[0].startsWith(`HEAD refs/heads/main@${was} → `), `${name}: ${c.changed[0]}`);
  }
});

test("the HEAD entry shows both ends, and sits beside the paths that changed", (t) => {
  const dir = repo(t);
  record(dir);
  const was = head(dir);
  git(dir, "checkout", "-q", "-b", "other");
  writeFileSync(join(dir, "stray.txt"), "x\n");
  const c = check(dir);
  assert.deepEqual(c.changed, [headEntry(was, "refs/heads/other", was), "stray.txt"]);
  assert.match(describe(c, []), new RegExp(`^MAIN-CHECKOUT-DIRTY HEAD refs/heads/main@${was} → refs/heads/other@${was} stray\\.txt — `));
  git(dir, "switch", "-q", "--detach");
  assert.equal(check(dir).changed[0], headEntry(was, "(detached)", was));
});

test("origin/main advancing and a fast-forward to it reads clean, before the merge and after", (t) => {
  const dir = repo(t);
  record(dir);
  advanceOrigin(t, dir);
  assert.equal(check(dir).state, "clean", "the fetch alone moved something");
  git(dir, "merge", "-q", "--ff-only", "origin/main");
  assert.equal(check(dir).state, "clean", "a fast-forward to origin/main held the run");
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(dir).changed, ["stray.txt"]);
});

test("a commit already unpushed at --record is allowed; one beyond it is not", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "mine.txt"), "the maintainer's, committed, unpushed\n");
  git(dir, "add", "mine.txt");
  git(dir, "commit", "-qm", "mine");
  record(dir);
  assert.equal(check(dir).state, "clean");
  writeFileSync(join(dir, "stray.txt"), "s\n");
  git(dir, "add", "stray.txt");
  git(dir, "commit", "-qm", "stray");
  const c = check(dir);
  assert.equal(c.state, "dirty");
  assert.match(c.changed[0], /^HEAD /);
});

test("the controller's close-out round trip — branch, commit, back to main — holds only while it is on the branch", (t) => {
  const dir = repo(t);
  record(dir);
  git(dir, "checkout", "-q", "-b", "chore/run-artifacts-1");
  writeFileSync(join(dir, "run.md"), "artifacts\n");
  git(dir, "add", "run.md");
  git(dir, "commit", "-qm", "close-out");
  assert.equal(check(dir).state, "dirty");
  git(dir, "checkout", "-q", "main");
  assert.equal(check(dir).state, "clean", "back on main, the hold did not clear itself");
});

test("HEAD equal to the baseline's commit skips the ancestry calls; any other commit makes them", (t) => {
  const dir = repo(t);
  record(dir);
  const trace = join(dir, ".fleet", "trace.log");
  const traced = { ...process.env, GIT_TRACE: trace };
  assert.equal(check(dir, traced).state, "clean");
  const first = readFileSync(trace, "utf8");
  assert.doesNotMatch(first, /merge-base|rev-list/, "the fast path ran an ancestry call");
  advanceOrigin(t, dir);
  git(dir, "merge", "-q", "--ff-only", "origin/main");
  assert.equal(check(dir, traced).state, "clean");
  const second = readFileSync(trace, "utf8").slice(first.length);
  assert.match(second, /merge-base/);
  assert.match(second, /rev-list/);
});

test("--record writes the symbolic ref and the commit, and overwrites on another branch without comparing", (t) => {
  const dir = repo(t);
  git(dir, "checkout", "-q", "-b", "other");
  record(dir);
  const text = readFileSync(baselinePath(dir), "utf8");
  assert.match(text, /^fleet main-checkout baseline v2\nref refs\/heads\/other\noid [0-9a-f]{40,64}\n/);
  assert.equal(check(dir).state, "clean");
  git(dir, "checkout", "-q", "main");
  assert.equal(check(dir).state, "dirty");
  record(dir);
  assert.equal(check(dir).state, "clean");
});

test("--record refuses a detached HEAD, which names no symbolic ref, and writes nothing", (t) => {
  const dir = repo(t);
  git(dir, "switch", "-q", "--detach");
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /detached/);
  assert.equal(check(dir).state, "absent");
});

test("a v1 baseline is unknown — re-record — and --record overwrites it", (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, ".fleet"));
  writeFileSync(baselinePath(dir), "fleet main-checkout baseline v1\n");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "outdated");
  assert.match(c.why, /baseline v1 — re-record/);
  const said = describe(c, []);
  assert.match(said, /^MAIN-CHECKOUT-UNKNOWN baseline v1 — re-record.*re-record with .*main-checkout\.mjs --record/);
  assert.doesNotMatch(said, /NEVER re-baseline/, "an unknown whose remedy is --record");
  record(dir);
  assert.match(readFileSync(baselinePath(dir), "utf8"), /^fleet main-checkout baseline v2\n/);
  assert.equal(check(dir).state, "clean");
});

// The version --record writes now, read off the file rather than pinned, so
// these rows survive the next bump.
const HEADER_RE = /^fleet main-checkout baseline v(\d+)\n/;
const recordedVersion = (dir) => Number(HEADER_RE.exec(readFileSync(baselinePath(dir), "utf8"))[1]);

test("an older baseline other than v1 is outdated by its number — re-record — and --record overwrites it", (t) => {
  const dir = repo(t);
  record(dir);
  const current = recordedVersion(dir);
  writeFileSync(baselinePath(dir), "fleet main-checkout baseline v0\n");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "outdated");
  assert.equal(c.why, "baseline v0 — re-record");
  const said = describe(c, []);
  assert.match(said, /^MAIN-CHECKOUT-UNKNOWN baseline v0 — re-record; live members: none — .*re-record with .*main-checkout\.mjs --record/);
  record(dir);
  assert.equal(recordedVersion(dir), current);
  assert.equal(check(dir).state, "clean");
});

test("a baseline a newer plugin wrote is unknown — run that plugin — and --record refuses it, leaving the file unchanged", (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);
  const newer = recordedVersion(dir) + 1;
  const text = readFileSync(base, "utf8").replace(HEADER_RE, `fleet main-checkout baseline v${newer}\n`);
  writeFileSync(base, text);
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "newer");
  assert.equal(c.why, `baseline v${newer} written by a newer plugin`);
  assert.equal(describe(c, ["impl-1"]), `MAIN-CHECKOUT-UNKNOWN baseline v${newer} written by a newer plugin; live members: impl-1 — dispatch held: run the plugin that wrote it`);
  assert.equal(describe(c), `MAIN-CHECKOUT-UNKNOWN baseline v${newer} written by a newer plugin — dispatch held: run the plugin that wrote it`);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, new RegExp(`^baseline v${newer} written by a newer plugin — .*do NOT --record over it`));
  assert.equal(readFileSync(base, "utf8"), text);
});

test("a first line that is no baseline header stays unreadable, even over a well-formed body, and --record refuses it", (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);
  const current = recordedVersion(dir);
  const body = readFileSync(base, "utf8").replace(HEADER_RE, "");
  for (const header of [
    "fleet main-checkout baseline v",
    "fleet main-checkout baseline vX",
    "fleet main-checkout baseline v-1",
    `fleet main-checkout baseline v${current + 1} `,
    `fleet main-checkout baseline v0${current}`,
    `Fleet main-checkout baseline v${current}`,
    `x fleet main-checkout baseline v${current + 1}`,
  ]) {
    const text = `${header}\n${body}`;
    writeFileSync(base, text);
    const c = check(dir);
    assert.equal(c.state, "unknown", header);
    assert.equal(c.cause, "baseline", header);
    assert.match(c.why, /not a baseline main-checkout\.mjs --record wrote/, header);
    assert.equal(recordBaseline({ cwd: dir }).ok, false, header);
    assert.equal(readFileSync(base, "utf8"), text, header);
  }
  writeFileSync(base, `fleet main-checkout baseline v${current}\n${body}`);
  assert.equal(check(dir).state, "clean", "the current header over the same body");
});

test("a missing origin/main is unknown, never clean — with HEAD where it was and with HEAD moved", (t) => {
  const dir = repo(t);
  record(dir);
  git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  let c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /origin\/main/);
  assert.match(describe(c, []), /^MAIN-CHECKOUT-UNKNOWN could not look: origin\/main/);
  writeFileSync(join(dir, "stray.txt"), "s\n");
  git(dir, "add", "stray.txt");
  git(dir, "commit", "-qm", "stray");
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /origin\/main/);
});

test("an unborn HEAD is unknown, never clean, and --record refuses it", (t) => {
  const dir = repo(t);
  record(dir);
  git(dir, "symbolic-ref", "HEAD", "refs/heads/unborn");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /unborn/);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /could not look, so there is nothing to record/);
});

test("--record refuses a checkout with no origin/main and writes no baseline, since the check could only answer unknown to it", (t) => {
  const dir = repo(t);
  git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /origin\/main is missing or unreadable .* — could not look, so there is nothing to record/);
  assert.throws(() => lstatSync(baselinePath(dir)), { code: "ENOENT" });
});

test("a baseline commit git cannot find is unknown, never dirty: a failed ancestry read is not 'no'", (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);
  writeFileSync(base, readFileSync(base, "utf8").replace(/^oid .*$/m, `oid ${"1".repeat(40)}`));
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /^baseline commit 1111111 is missing from this repository/);
});

test("a baseline commit an amend and gc pruned is its own unknown: examine HEAD first, then --record clears it", (t) => {
  const dir = repo(t);
  // Unpushed, so once amended nothing but the reflog reaches it.
  writeFileSync(join(dir, "tracked.txt"), "local\n");
  git(dir, "commit", "-qam", "local");
  const recorded = record(dir).head.oid;
  git(dir, "commit", "-q", "--amend", "-m", "amended");
  git(dir, "reflog", "expire", "--expire=now", "--all");
  git(dir, "gc", "-q", "--prune=now");
  // The check answers before it compares the tree, so this is never reported.
  writeFileSync(join(dir, "STRAY.txt"), "mine\n");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.changed, undefined, "the stray path is not named");
  assert.equal(c.cause, "missing");
  assert.match(c.why, new RegExp(`^baseline commit ${recorded.slice(0, 7)} is missing from this repository; HEAD is refs/heads/main@[0-9a-f]{7}$`));
  const said = describe(c, []);
  assert.match(said, new RegExp(`^MAIN-CHECKOUT-UNKNOWN baseline commit ${recorded.slice(0, 7)} is missing from this repository`));
  assert.match(said, /examine HEAD against origin\/main FIRST/);
  assert.match(said, /resolve any stray paths/);
  assert.match(said, /re-record with ~\/\.fleet\/bin\/fleet-run main-checkout\.mjs --record \(it overwrites, it does not compare\)/);
  assert.doesNotMatch(said, /NEVER re-baseline/);
  const cli = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: dir, encoding: "utf8" });
  assert.equal(cli.status, 2, "exit 2, like every other unknown");
  assert.equal(cli.stdout, `${describe(c)}\n`);
  record(dir);
  assert.equal(check(dir).state, "clean");
});

test("a baseline commit whose probe read fails for another reason than absence stays could-not-look", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "local\n");
  git(dir, "commit", "-qam", "local");
  const recorded = record(dir).head.oid;
  git(dir, "commit", "-q", "--amend", "-m", "amended");
  git(dir, "reflog", "expire", "--expire=now", "--all");
  git(dir, "gc", "-q", "--prune=now");
  // Control: real git answers exit 1 with nothing on stderr for the absent commit.
  assert.equal(check(dir).cause, "missing");
  // A git first on PATH that fails the probe's `rev-parse` of the baseline
  // commit with 128, as a broken one would, and runs everything else as the
  // real git, `originMain`'s `rev-parse` included.
  const shim = join(dir, ".fleet", "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "git"), [
    "#!/bin/sh",
    'if [ "$1" = rev-parse ]; then for a in "$@"; do',
    '  if [ "$a" = "$BASELINE_OID^{commit}" ]; then echo "fatal: injected" >&2; exit 128; fi',
    "done; fi",
    'PATH="$REAL_PATH" exec git "$@"',
    "",
  ].join("\n"));
  chmodSync(join(shim, "git"), 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, REAL_PATH: process.env.PATH, BASELINE_OID: recorded };
  const c = check(dir, env);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^git merge-base --is-ancestor exited 128/);
});

test("a baseline commit present but unreadable under a chmod 000 fan-out dir is could-not-look, never missing", { skip: ROOT }, (t) => {
  const dir = repo(t);
  // Re-commit until the baseline commit's fan-out dir holds its object alone:
  // any other object there is read before the ancestry read, and would fail
  // the check earlier with another `why`.
  let recorded, fanout;
  for (let i = 0; ; i++) {
    // Unpushed, so `origin/main` never reads it: only the ancestry read does.
    writeFileSync(join(dir, "tracked.txt"), `local ${i}\n`);
    git(dir, "commit", "-qam", "local");
    recorded = record(dir).head.oid;
    writeFileSync(join(dir, "tracked.txt"), `next ${i}\n`);
    git(dir, "commit", "-qam", "next");
    fanout = join(dir, ".git", "objects", recorded.slice(0, 2));
    if (readdirSync(fanout).join() === recorded.slice(2)) break;
    // Drop this round's loose objects: reachable ones go into a pack.
    git(dir, "reset", "-q", "--hard", "origin/main");
    git(dir, "reflog", "expire", "--expire=now", "--all");
    git(dir, "gc", "-q", "--prune=now");
  }
  chmodSync(fanout, 0o000);
  let c;
  try { c = check(dir); } finally { chmodSync(fanout, 0o755); }
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^git rev-parse --verify exited 1: error: unable to open loose object/);
  assert.match(describe(c, []), /NEVER re-baseline over it/);
});

test("a baseline commit present only in an alternate that has moved away is could-not-look, never missing", (t) => {
  const dir = repo(t);
  // Unpushed, so `origin/main` never reads it: only the ancestry read does.
  writeFileSync(join(dir, "tracked.txt"), "local\n");
  git(dir, "commit", "-qam", "local");
  const recorded = record(dir).head.oid;
  // Only the baseline's loose commit object moves into the alternate; HEAD,
  // `origin/main` and the worktree stay in local objects.
  const alt = join(dir, ".fleet", "alt");
  mkdirSync(join(alt, "objects", recorded.slice(0, 2)), { recursive: true });
  renameSync(
    join(dir, ".git", "objects", recorded.slice(0, 2), recorded.slice(2)),
    join(alt, "objects", recorded.slice(0, 2), recorded.slice(2)),
  );
  mkdirSync(join(dir, ".git", "objects", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "objects", "info", "alternates"), `${join(alt, "objects")}\n`);
  writeFileSync(join(dir, "tracked.txt"), "two\n");
  git(dir, "commit", "-qam", "next");
  renameSync(alt, join(dir, ".fleet", "alt-gone"));
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^git rev-parse --verify exited 1: error: unable to normalize alternate/);
});

test("a baseline commit present but corrupt stays could-not-look: only an absent object is the missing cause", (t) => {
  const dir = repo(t);
  // Unpushed, so `origin/main` never reads it: only the ancestry read does.
  writeFileSync(join(dir, "tracked.txt"), "local\n");
  git(dir, "commit", "-qam", "local");
  const recorded = record(dir).head.oid;
  writeFileSync(join(dir, "tracked.txt"), "two\n");
  git(dir, "commit", "-qam", "next");
  // Loose and read-only as git wrote it: garbage where the commit was.
  const object = join(dir, ".git", "objects", recorded.slice(0, 2), recorded.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, "garbage");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^git merge-base --is-ancestor exited 128/);
  assert.match(describe(c, []), /^MAIN-CHECKOUT-UNKNOWN could not look: .* — dispatch held: fix the failure and tick again; NEVER re-baseline over it/);
});

test("CLI: a HEAD move prints MAIN-CHECKOUT-DIRTY naming HEAD, exit 1, and the same --record clears it", (t) => {
  const dir = repo(t);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(run("--record").status, 0);
  git(dir, "checkout", "-q", "-b", "other");
  const r = run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MAIN-CHECKOUT-DIRTY HEAD refs\/heads\/main@[0-9a-f]{7} → refs\/heads\/other@[0-9a-f]{7} — /);
  assert.equal(run("--record").status, 0);
  assert.equal(run("--check").status, 0);
});
