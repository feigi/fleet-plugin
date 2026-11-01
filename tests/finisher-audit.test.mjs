// Regression gate for finisher-audit.mjs, the finisher's worktree audit as one
// command. Zero deps: `node --test tests/finisher-audit.test.mjs`.
//
// Every case runs against a REAL repository: a bare origin, a clone, and a
// linked worktree on its own branch, with `worktree-audit.sh` read through the
// script exactly as the finisher runs it. Each cause is made the way it happens
// in a run - a file edited, a branch rebased, a commit made - not by stubbing
// the read the script derives it from.
//
// Each case holds every input at the baseline except the one under test, so
// removing a step reds the case named after it. The baseline is a worktree on
// a pushed branch, one commit past origin/main, clean, with that commit as the
// pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/finisher-audit.mjs", import.meta.url));

// Cut the developer's ~/.gitconfig and any ambient GIT_DIR out of what these
// fixtures see, as worktree-audit.test.mjs does.
const ENV = {
  ...process.env,
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

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const commit = (cwd, msg, file = `${msg}.txt`) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};

// The baseline fixture. `root` is realpath'd once, before any path is derived
// from it: macOS reaches a tmpdir as /var/... and git reports /private/var/...,
// so a raw path never string-equals a row's.
function fixture() {
  const root = realpathSync(tempDir("finisher-audit-"));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "ignore" });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  const wt = join(w, ".worktrees", "feat");
  git(w, "worktree", "add", "-q", wt, "-b", "feat", "origin/main");
  const pin = commit(wt, "work");
  git(wt, "push", "-q", "-u", "origin", "feat");
  return { root, origin, w, wt, pin };
}

// Run the script. `cwd` defaults to the main checkout, where the finisher's
// controller stands; `env` overrides the scrubbed baseline.
function audit(f, args = [], { cwd = f.w, env = {} } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...ENV, ...env }, encoding: "utf8" });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // a usage refusal prints no verdict
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out, ms: Date.now() - t0 };
}

const std = (f, extra = [], opts) => audit(f, ["--worktree", f.wt, "--pin", f.pin, "--sample-seconds", "0", ...extra], opts);

test("exit 0: a clean worktree at the pin is cause null, with the row it matched", () => {
  const f = fixture();
  const r = std(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.out), ["worktree", "realpath", "pin", "head", "cause", "evidence"]);
  assert.equal(r.out.worktree, f.wt);
  assert.equal(r.out.realpath, f.wt);
  assert.equal(r.out.pin, f.pin);
  assert.equal(r.out.head, f.pin);
  assert.equal(r.out.cause, null);
  assert.deepEqual(r.out.evidence.audit.row, { worktree: f.wt, branch: "feat", ahead: 1, dirty: 0, dirtyFiles: [], readable: true });
  assert.equal(r.stdout.trim().split("\n").length, 1, "the verdict is one line");
});

test("exit 0: a pin in capitals is the same pin", () => {
  const f = fixture();
  const r = audit(f, ["--worktree", f.wt, "--pin", f.pin.toUpperCase(), "--sample-seconds", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.pin, f.pin);
});

test("exit 0: a rebase sitting at the pin is that head's provenance, not divergence — the reflog is never read", () => {
  const f = fixture();
  commit(f.w, "main-moves");
  git(f.w, "push", "-q", "origin", "main");
  git(f.w, "fetch", "-q", "origin");
  git(f.wt, "rebase", "-q", "origin/main");
  const pin = git(f.wt, "rev-parse", "HEAD");
  assert.notEqual(pin, f.pin, "fixture: the rebase moved the head");
  const r = audit(f, ["--worktree", f.wt, "--pin", pin, "--sample-seconds", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.cause, null);
  assert.equal(r.out.evidence.reflog, undefined);
  assert.equal(r.out.evidence.replay, undefined);
  assert.equal(r.out.evidence.rangeDiff, undefined);
});

test("live-editor: a dirty tree halts with both diff --stat samples, exit 1", () => {
  const f = fixture();
  appendFileSync(join(f.wt, "work.txt"), "more\n");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "live-editor");
  assert.equal(r.out.evidence.samples.length, 2);
  for (const s of r.out.evidence.samples) assert.match(s, /work\.txt \| 1 \+/);
  assert.equal(r.out.evidence.audit.row.dirty, 1);
  assert.match(r.out.evidence.status[0], /^ M work\.txt/);
});

test("live-editor: dirt at the pin still halts — the dirty check runs before head-equality", () => {
  const f = fixture();
  appendFileSync(join(f.wt, "work.txt"), "more\n");
  assert.equal(git(f.wt, "rev-parse", "HEAD"), f.pin);
  assert.equal(std(f).out.cause, "live-editor");
});

test("live-editor: an untracked file alone is dirt", () => {
  const f = fixture();
  writeFileSync(join(f.wt, "scratch.txt"), "x\n");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "live-editor");
  assert.match(r.out.evidence.status[0], /\?\? scratch\.txt/);
});

test("live-editor: an untracked file is still dirt under status.showUntrackedFiles = no", () => {
  const f = fixture();
  git(f.w, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(f.wt, "scratch.txt"), "x\n");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "live-editor");
});

test("live-editor: the status cross-check alone sees dirt the audit row reads as zero, under status.showUntrackedFiles = no", () => {
  const f = fixture();
  git(f.w, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(f.wt, "scratch.txt"), "x\n");
  // A git on PATH that answers the audit's own `status --porcelain -uall` with
  // nothing, so the row's dirty count is 0 over a tree that is dirty, and only
  // the script's own `-unormal` status read can tell.
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { env: ENV, encoding: "utf8" }).trim();
  writeExecStub(
    join(bin, "git"),
    `#!/bin/sh
case " $* " in
*" status --porcelain -uall "*) exit 0 ;;
esac
exec ${real} "$@"
`,
  );
  const r = std(f, [], { env: { PATH: `${bin}:${ENV.PATH}` } });
  assert.equal(r.out?.evidence.audit.row.dirty, 0, "the stub made the row read the dirty tree as clean");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "live-editor");
  assert.match(r.out.evidence.status[0], /\?\? scratch\.txt/);
});

test("live-editor: the two samples are read --sample-seconds apart, and a growing diff shows in the second", () => {
  const f = fixture();
  appendFileSync(join(f.wt, "work.txt"), "more\n");
  // A git on PATH that grows the file just before the second `diff --stat`
  // answers, so the gap between the reads is observable without a race.
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { env: ENV, encoding: "utf8" }).trim();
  writeExecStub(
    join(bin, "git"),
    `#!/bin/sh
d="\${0%/*}"
case " $* " in
*" diff --stat "*)
  echo x >> "$d/n"
  if [ $(wc -l < "$d/n") -eq 2 ]; then echo more >> "${f.wt}/work.txt"; fi ;;
esac
exec ${real} "$@"
`,
  );
  const r = std(f, [], { env: { PATH: `${bin}:${ENV.PATH}` } });
  assert.equal(r.status, 1, r.stderr);
  const [a, b] = r.out.evidence.samples;
  assert.match(a, /work\.txt \| 1 \+/);
  assert.match(b, /work\.txt \| 2 \+\+/);
  const slow = audit(f, ["--worktree", f.wt, "--pin", f.pin, "--sample-seconds", "2"], { env: { PATH: `${bin}:${ENV.PATH}` } });
  const fast = std(f, [], { env: { PATH: `${bin}:${ENV.PATH}` } });
  assert.ok(slow.ms - fast.ms >= 1500, `--sample-seconds 2 waited ${slow.ms} ms against ${fast.ms} ms for 0`);
});

// Main gains a commit, and the branch's replay onto it is the rebase under test.
// `fetch` brings origin/main up to it. `file` is the path main's commit writes,
// so a test can make main's change collide with the branch's own.
function moveMain(f, file = "main-moves.txt") {
  commit(f.w, "main-moves", file);
  git(f.w, "push", "-q", "origin", "main");
  git(f.w, "fetch", "-q", "origin");
}

test("rebase: a branch replayed onto a new base halts, and its replay reads pure", () => {
  const f = fixture();
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  const head = git(f.wt, "rev-parse", "HEAD");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.head, head);
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: rebase/);
  assert.equal(r.out.evidence.replay, "pure");
  assert.match(r.out.evidence.rangeDiff, /^1:\s+\S+ = 1:\s+\S+ work$/m);
  assert.equal(r.out.evidence.remote.state, "differs");
});

test("rebase: a replay pushed over the pin reads pushed, the remote at the replayed head", () => {
  const f = fixture();
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  const head = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "push", "-q", "--force", "origin", "feat");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.replay, "pure");
  assert.equal(r.out.evidence.remote.state, "pushed");
  assert.equal(r.out.evidence.remote.sha, head);
});

test("rebase: a replayed commit with an empty subject still pairs, and reads pure", () => {
  const f = fixture();
  writeFileSync(join(f.wt, "e.txt"), "e\n");
  git(f.wt, "add", "e.txt");
  git(f.wt, "commit", "-q", "--allow-empty-message", "-m", "");
  f.pin = git(f.wt, "rev-parse", "HEAD");
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.rangeDiff, /^2:\s+\S+ = 2:\s+\S+$/m);
  assert.equal(r.out.evidence.replay, "pure");
});

test("rebase: an unreadable remote reads the remote state unknown, never differs", () => {
  const f = fixture();
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  git(f.wt, "remote", "set-url", "origin", join(f.root, "no-such.git"));
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.remote.state, "unknown");
  assert.equal(r.out.evidence.remote.ref, "refs/heads/feat");
});

test("rebase: a remote ref that only ends in the row's branch ref is not the row's, and reads differs", () => {
  const f = fixture();
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  // `ls-remote` matches its pattern against the tail of each ref, so it lists
  // this decoy for `refs/heads/feat` too, at the replayed head.
  git(f.wt, "push", "-q", "origin", "HEAD:refs/heads/x/refs/heads/feat");
  git(f.wt, "push", "-q", "origin", ":refs/heads/feat");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.remote.state, "differs");
  assert.equal(r.out.evidence.remote.sha, null);
});

test("rebase: a commit dropped from the replay reads changed, and the kept commit still pairs", () => {
  const f = fixture();
  const dropped = f.pin;
  f.pin = commit(f.wt, "work2");
  moveMain(f);
  git(f.wt, "rebase", "-q", "--onto", "origin/main", dropped);
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.replay, "changed");
  assert.match(r.out.evidence.rangeDiff, /^1:\s+\S+ < -:\s+-+ work$/m);
  assert.match(r.out.evidence.rangeDiff, /^2:\s+\S+ = 1:\s+\S+ work2$/m);
});

test("rebase: a conflict resolved to main's side reads changed, though the replay leaves no commit", () => {
  const f = fixture();
  moveMain(f, "work.txt");
  const conflict = spawnSync("git", ["-C", f.wt, "rebase", "-q", "origin/main"], { env: ENV, encoding: "utf8" });
  assert.notEqual(conflict.status, 0, "fixture: main's commit must conflict with the branch's");
  git(f.wt, "checkout", "origin/main", "--", "work.txt");
  execFileSync("git", ["-C", f.wt, "rebase", "--continue"], { env: { ...ENV, GIT_EDITOR: "true" }, encoding: "utf8" });
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.replay, "changed");
  assert.match(r.out.evidence.rangeDiff, /^1:\s+\S+ < -:\s+-+ work$/m);
});

test("rebase: a whitespace-only edit made while replaying reads changed", () => {
  const f = fixture();
  moveMain(f);
  git(f.wt, "rebase", "-q", "--exec", "printf 'work \\n' > work.txt && git commit -q -a --amend --no-edit", "origin/main");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.replay, "changed");
  assert.match(r.out.evidence.rangeDiff, /^-:\s+-+ > 1:\s+\S+ work$/m);
});

test("rebase: a small content edit made while replaying pairs the commit with !, lists no diff body, and reads changed", () => {
  const f = fixture();
  // A one-line edit in a file of many lines leaves most of the commit's diff
  // intact, so range-diff pairs the edited commit with its original instead of
  // listing the two unpaired.
  writeFileSync(join(f.wt, "big.txt"), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""));
  git(f.wt, "add", "big.txt");
  git(f.wt, "commit", "-q", "-m", "big");
  f.pin = git(f.wt, "rev-parse", "HEAD");
  moveMain(f);
  git(f.wt, "rebase", "-q", "--exec", "if [ -f big.txt ]; then sed 's/line 3$/line three/' big.txt > big.tmp && mv big.tmp big.txt && git commit -q -a --amend --no-edit; fi", "origin/main");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.rangeDiff, /^2:\s+\S+ ! 2:\s+\S+ big$/m);
  assert.doesNotMatch(r.out.evidence.rangeDiff, /^\s+@@/m);
  assert.equal(r.out.evidence.replay, "changed");
});

test("rebase: a commit half rewritten while replaying still pairs with ! at the creation factor the script passes", () => {
  const f = fixture();
  // Rewriting half the lines a commit adds is a change range-diff still pairs
  // at the script's creation factor; a lower one lists the original and the
  // rewrite unpaired.
  writeFileSync(join(f.wt, "big.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
  git(f.wt, "add", "big.txt");
  git(f.wt, "commit", "-q", "-m", "base8");
  writeFileSync(join(f.wt, "big.txt"), "a\nb\nc\nd\ne\nf\ng\nh\nX1\nX2\nX3\nX4\n");
  git(f.wt, "commit", "-q", "-a", "-m", "work2");
  f.pin = git(f.wt, "rev-parse", "HEAD");
  moveMain(f);
  git(f.wt, "rebase", "-q", "--exec", "if [ \"$(git log -1 --format=%s)\" = work2 ]; then printf 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\nX1\\nX2\\nY3\\nY4\\n' > big.txt && git commit -q -a --amend --no-edit; fi", "origin/main");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.rangeDiff, /^3:\s+\S+ ! 3:\s+\S+ work2$/m);
  assert.equal(r.out.evidence.replay, "changed");
});

test("rebase: a reset to another commit is a rebase entry too, and reads changed", () => {
  const f = fixture();
  git(f.wt, "reset", "-q", "--hard", "origin/main");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: reset/);
  assert.equal(r.out.evidence.replay, "changed");
  assert.match(r.out.evidence.rangeDiff, /^1:\s+\S+ < -:\s+-+ work$/m);
});

test("rebase: a reset to a main that already merged the pin lists nothing, and that empty listing reads changed", () => {
  const f = fixture();
  git(f.w, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
  git(f.w, "push", "-q", "origin", "main");
  moveMain(f);
  git(f.wt, "reset", "-q", "--hard", "origin/main");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.rangeDiff, "");
  assert.equal(r.out.evidence.replay, "changed");
});

// A merge of main into the branch that also adds `evil.txt`: content of the
// merge commit's own, which `range-diff` never lists.
function evilMerge(f) {
  moveMain(f);
  git(f.wt, "merge", "-q", "--no-ff", "--no-commit", "origin/main");
  writeFileSync(join(f.wt, "evil.txt"), "evil\n");
  git(f.wt, "add", "evil.txt");
  git(f.wt, "commit", "-q", "-m", "merge main");
  moveMain(f, "main-moves-2.txt");
}

test("rebase: a pinned merge commit the replay dropped reads changed, though range-diff pairs every other commit", () => {
  const f = fixture();
  evilMerge(f);
  f.pin = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "rebase", "-q", "origin/main");
  assert.notEqual(spawnSync("git", ["-C", f.wt, "cat-file", "-e", "HEAD:evil.txt"], { env: ENV }).status, 0, "fixture: the replay dropped the merge's own content");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.rangeDiff, /^1:\s+\S+ = 1:\s+\S+ work$/m);
  assert.equal(r.out.evidence.replay, "changed");
});

test("rebase: a head reset onto a merge commit with content of its own reads changed, though range-diff pairs every other commit", () => {
  const f = fixture();
  evilMerge(f);
  const merged = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "reset", "-q", "--hard", f.pin);
  git(f.wt, "reset", "-q", "--hard", merged);
  git(f.wt, "cat-file", "-e", "HEAD:evil.txt");
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.rangeDiff, /^1:\s+\S+ = 1:\s+\S+ work$/m);
  assert.equal(r.out.evidence.replay, "changed");
});

test("rebase: a stale origin/main reads changed, since the replay gained a commit the ref lacks", () => {
  const f = fixture();
  const stale = git(f.w, "rev-parse", "origin/main");
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  git(f.wt, "update-ref", "refs/remotes/origin/main", stale);
  const r = std(f);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.replay, "changed");
  assert.match(r.out.evidence.rangeDiff, /^-:\s+-+ > 1:\s+\S+ main-moves$/m);
});

test("rebase: a range-diff that cannot read a revision reads unknown, with git's error carried", () => {
  const f = fixture();
  git(f.wt, "reset", "-q", "--hard", "origin/main");
  const gone = "0123456789abcdef0123456789abcdef01234567";
  const r = audit(f, ["--worktree", f.wt, "--pin", gone, "--sample-seconds", "0"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.evidence.replay, "unknown");
  assert.equal(typeof r.out.evidence.rangeDiff.error, "string");
  assert.notEqual(r.out.evidence.rangeDiff.error, "");
});

test("a missing origin/main is refused by the audit at exit 2, never read as a replay verdict", () => {
  const f = fixture();
  git(f.wt, "reset", "-q", "--hard", "origin/main");
  git(f.wt, "update-ref", "-d", "refs/remotes/origin/main");
  const r = std(f);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.cause, null);
  assert.match(r.out.evidence.error, /origin\/main does not resolve/);
});

test("rebase: a user's color.ui=always config does not change the replay verdict", () => {
  const f = fixture();
  git(f.w, "config", "color.ui", "always");
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  const r = std(f);
  assert.equal(r.out.evidence.replay, "pure");
  assert.doesNotMatch(r.out.evidence.rangeDiff, /\x1b/);
});

test("a user's log.decorate or color.ui config does not change how the reflog subject is read", () => {
  // Each config alone puts something ahead of the subject - `(HEAD -> feat)`, or
  // an escape around the abbreviated SHA - that a bare `git reflog` hands the
  // subject match and the evidence line.
  for (const [key, value] of [["log.decorate", "short"], ["color.ui", "always"]]) {
    const f = pastPin();
    git(f.w, "config", key, value);
    const plain = /^[0-9a-f]+ HEAD@\{0\}: commit: late$/;
    assert.doesNotMatch(git(f.wt, "reflog", "-n", "1"), plain, `${key} reached the reflog`);
    const r = std(f);
    assert.equal(r.status, 1, `${key}: ${r.stderr}`);
    assert.equal(r.out.cause, "stray", key);
    assert.match(r.out.evidence.reflog, plain, key);
  }
});

test("exit 2: a --repo whose stat is refused is could-not-look, never a crash with no verdict", (t) => {
  if (process.getuid?.() === 0) t.skip("root is never refused a stat");
  const f = fixture();
  const locked = join(f.root, "locked");
  mkdirSync(join(locked, "sub"), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    const r = audit(f, ["--worktree", f.wt, "--pin", f.pin, "--repo", join(locked, "sub")]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.out, null);
    assert.match(r.stderr, /^\nfinisher-audit: --repo cannot be read: /);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// A commit made in the owned worktree after the dispatch: whether the pin
// lacks anything it holds, and whether anything can reach it.
function pastPin() {
  const f = fixture();
  f.late = commit(f.wt, "late");
  return f;
}

// The same branch worked on from a second clone, as a server-side rebase or a
// push from another machine does it. Nothing reaches the owned worktree's
// object store until `fetch` is run in `f.w`.
function otherClone(f) {
  const o = join(f.root, "other");
  execFileSync("git", ["clone", "-q", f.origin, o], { env: ENV, stdio: "ignore" });
  git(o, "checkout", "-q", "-B", "feat", "origin/feat");
  return o;
}

// The owned worktree holds `late`, pushed; the branch is then rebased onto an
// advanced main and force-pushed from the other clone. The returned pin is the
// rebased head.
function supersededByRebase() {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "feat");
  const o = otherClone(f);
  git(o, "checkout", "-q", "main");
  commit(o, "main-moves");
  git(o, "push", "-q", "origin", "main");
  git(o, "checkout", "-q", "feat");
  git(o, "rebase", "-q", "origin/main");
  git(o, "push", "-q", "--force", "origin", "feat");
  f.rebased = git(o, "rev-parse", "HEAD");
  return f;
}

const auditAt = (f, pin) => std({ ...f, pin });

test("exit 0: a worktree a remote rebase superseded holds nothing the pin lacks, and the cherry read is the evidence", () => {
  const f = supersededByRebase();
  git(f.w, "fetch", "-q", "origin");
  const r = auditAt(f, f.rebased);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.cause, null);
  assert.equal(r.out.head, f.late);
  assert.notEqual(r.out.head, r.out.pin);
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: commit: late/);
  assert.equal(r.out.evidence.cherry.merges, 0);
  const listing = r.out.evidence.cherry.listing.split("\n").filter((l) => l !== "");
  assert.equal(listing.length, 2);
  for (const l of listing) assert.match(l, /^- [0-9a-f]{40}$/);
  assert.equal(r.out.evidence.remote, undefined, "nothing is unique, so the remote is never asked");
});

test("exit 2: a worktree a remote rebase superseded, with the rebased pin absent from the object store, is could-not-look", () => {
  const f = supersededByRebase();
  const r = auditAt(f, f.rebased);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.cause, null);
  assert.match(r.out.evidence.error, /^cherry: git cherry /);
});

test("exit 0: an owned HEAD that is an ancestor of the pin holds nothing the pin lacks", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "feat");
  const o = otherClone(f);
  const ahead = commit(o, "ahead");
  git(o, "push", "-q", "origin", "feat");
  git(f.w, "fetch", "-q", "origin");
  const r = auditAt(f, ahead);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.cause, null);
  assert.equal(r.out.head, f.late);
  assert.deepEqual(r.out.evidence.cherry, { listing: "", merges: 0 });
});

test("past-pin pushed: the remote branch carries the commit", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "feat");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.equal(r.out.head, f.late);
  assert.equal(r.out.evidence.commit, `${f.late.slice(0, 7)} late`);
  assert.deepEqual(r.out.evidence.remote, { ref: "refs/heads/feat", sha: f.late, carries: true });
  assert.equal(r.out.evidence.cherry.merges, 0);
  assert.match(r.out.evidence.cherry.listing, new RegExp(`^\\+ ${f.late}$`, "m"));
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: commit: late/);
});

test("past-pin: a remote branch ahead of the commit still carries it", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "feat");
  const o = otherClone(f);
  const ahead = commit(o, "ahead");
  git(o, "push", "-q", "origin", "feat");
  git(f.w, "fetch", "-q", "origin");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.deepEqual(r.out.evidence.remote, { ref: "refs/heads/feat", sha: ahead, carries: true });
});

test("stray: the remote branch is still at the pin, behind the commit", () => {
  const f = pastPin();
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "stray");
  assert.equal(r.out.head, f.late);
  assert.equal(r.out.evidence.commit, `${f.late.slice(0, 7)} late`);
  assert.deepEqual(r.out.evidence.remote, { ref: "refs/heads/feat", sha: f.pin, carries: false });
  assert.match(r.out.evidence.cherry.listing, new RegExp(`^\\+ ${f.late}$`, "m"));
});

test("stray: a branch the remote has never heard of is a read that succeeded and found nothing", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "--delete", "feat");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "stray");
  assert.deepEqual(r.out.evidence.remote, { ref: "refs/heads/feat", sha: null, carries: false });
});

test("stray: a remote ref that only ends in the row's branch ref is not the row's", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "HEAD:refs/heads/x/refs/heads/feat");
  git(f.wt, "push", "-q", "origin", ":refs/heads/feat");
  const r = std(f);
  assert.equal(r.out.cause, "stray");
  assert.deepEqual(r.out.evidence.remote, { ref: "refs/heads/feat", sha: null, carries: false });
});

test("stray, carries null: a failed git ls-remote is never read as not carried", () => {
  const f = pastPin();
  git(f.w, "remote", "set-url", "origin", join(f.root, "no-such-origin.git"));
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "stray");
  assert.equal(r.out.evidence.remote.carries, null);
  assert.equal(r.out.evidence.remote.ref, "refs/heads/feat");
  assert.ok(r.out.evidence.remote.error.length > 0, "the failed read names why");
});

test("stray, carries null: a detached HEAD has no branch to ask the remote about", () => {
  const f = fixture();
  git(f.wt, "checkout", "-q", "--detach");
  const late = commit(f.wt, "late");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "stray");
  assert.equal(r.out.head, late);
  assert.equal(r.out.evidence.remote.carries, null);
  assert.ok(r.out.evidence.remote.error.length > 0);
});

test("stray, carries null: a remote SHA the object store lacks cannot be tested", () => {
  const f = pastPin();
  const o = otherClone(f);
  const elsewhere = commit(o, "elsewhere");
  git(o, "push", "-q", "origin", "feat");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "stray");
  assert.equal(r.out.evidence.remote.sha, elsewhere);
  assert.equal(r.out.evidence.remote.carries, null);
  assert.ok(r.out.evidence.remote.error.length > 0);
});

// A merge commit past the pin that adds a file of its own, both of whose
// parents' patches the pin already holds: `git cherry` lists nothing but `-`
// lines, and the merge's own file is invisible to it.
function mergePastPin() {
  const f = fixture();
  git(f.wt, "checkout", "-q", "-b", "side", "origin/main");
  commit(f.wt, "s");
  git(f.wt, "checkout", "-q", "feat");
  git(f.wt, "cherry-pick", "side");
  const pin = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "reset", "-q", "--hard", f.pin);
  git(f.wt, "merge", "-q", "--no-ff", "--no-commit", "side");
  writeFileSync(join(f.wt, "merged.txt"), "evil\n");
  git(f.wt, "add", "merged.txt");
  git(f.wt, "commit", "-q", "-m", "merge side");
  f.merge = git(f.wt, "rev-parse", "HEAD");
  f.mergePin = pin;
  return f;
}

test("stray: a merge commit with a file of its own is unique even when every parent patch is in the pin", () => {
  const f = mergePastPin();
  const r = auditAt(f, f.mergePin);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "stray");
  assert.equal(r.out.head, f.merge);
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: commit \(merge\)/);
  assert.doesNotMatch(r.out.evidence.cherry.listing, /^\+/m, "the merge's parents' patches are all in the pin");
  assert.equal(r.out.evidence.cherry.merges, 1);
  assert.equal(r.out.evidence.remote.carries, false);
});

test("past-pin: the same merge commit, pushed, is carried", () => {
  const f = mergePastPin();
  git(f.wt, "push", "-q", "origin", "feat");
  const r = auditAt(f, f.mergePin);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.deepEqual(r.out.evidence.remote, { ref: "refs/heads/feat", sha: f.merge, carries: true });
});

test("stray: a remote tip holding every parent patch of a merge commit does not carry the merge's own file", () => {
  const f = mergePastPin();
  git(f.wt, "push", "-q", "-f", "origin", `${f.mergePin}:refs/heads/feat`);
  const r = auditAt(f, f.pin);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.head, f.merge);
  assert.match(r.out.evidence.cherry.listing, /^\+/m, "pin..HEAD holds a patch the pin lacks");
  assert.equal(r.out.evidence.remote.sha, f.mergePin);
  assert.equal(r.out.cause, "stray", JSON.stringify(r.out.evidence));
  assert.equal(r.out.evidence.remote.carries, false);
});

test("other: a move that is neither a rebase nor a commit halts with both status reads, the reflog line and both SHAs", () => {
  const f = fixture();
  git(f.wt, "checkout", "-q", "--detach", "origin/main");
  const head = git(f.wt, "rev-parse", "HEAD");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "other");
  assert.deepEqual(r.out.evidence.status, ["", ""]);
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: checkout/);
  assert.deepEqual(r.out.evidence.shas, { pin: f.pin, head });
});

// The pin is the branch's replay onto an advanced main; the owned worktree
// holds the pre-replay commit, so `pin..HEAD` holds nothing the pin lacks, and
// the move that put HEAD there is whatever the caller makes it next.
function patchCleanBehindPin() {
  const f = fixture();
  moveMain(f);
  git(f.wt, "rebase", "-q", "origin/main");
  f.replayed = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "reset", "-q", "--hard", f.pin);
  assert.match(git(f.wt, "cherry", f.replayed, "HEAD"), /^- [0-9a-f]{40}$/, "fixture: the range is patch-clean");
  return f;
}

test("other: a checkout stays other even when pin..HEAD holds nothing the pin lacks", () => {
  const f = patchCleanBehindPin();
  git(f.wt, "checkout", "-q", "--detach");
  const r = auditAt(f, f.replayed);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "other");
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: checkout/);
  assert.equal(r.out.evidence.cherry, undefined);
});

test("rebase: a newest move that is a reset or rebase stays rebase even when pin..HEAD holds nothing the pin lacks", () => {
  const f = patchCleanBehindPin();
  const r = auditAt(f, f.replayed);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: reset/);
  assert.equal(r.out.evidence.cherry, undefined);
});

test("a symlinked worktree path matches its row by realpath", () => {
  const f = fixture();
  const link = join(f.root, "link");
  symlinkSync(f.wt, link);
  const r = audit(f, ["--worktree", link, "--pin", f.pin, "--sample-seconds", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.worktree, link);
  assert.equal(r.out.realpath, f.wt);
  assert.equal(r.out.cause, null);
  assert.equal(r.out.evidence.audit.row.worktree, f.wt);
});

test("a symlinked ancestor of a removed worktree still matches its row, as missing", () => {
  const f = fixture();
  const link = join(f.root, "link");
  symlinkSync(join(f.w, ".worktrees"), link);
  rmSync(f.wt, { recursive: true });
  const r = audit(f, ["--worktree", join(link, "feat"), "--pin", f.pin, "--sample-seconds", "0"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "missing");
  assert.equal(r.out.realpath, f.wt);
});

test("unreadable: a worktree whose .git linkage is gone halts, with the audit's stderr line quoted", () => {
  const f = fixture();
  rmSync(join(f.wt, ".git"));
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "unreadable");
  assert.equal(r.out.head, null);
  assert.equal(r.out.evidence.audit.row.readable, false);
  assert.equal(r.out.evidence.audit.row.ahead, null);
  assert.match(r.out.evidence.audit.stderr, new RegExp(`^UNREADABLE: ${f.wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(no \\.git linkage`));
});

test("missing: a removed worktree directory halts, with the audit's stderr line quoted", () => {
  const f = fixture();
  rmSync(f.wt, { recursive: true });
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "missing");
  assert.equal(r.out.head, null);
  assert.equal(r.out.evidence.audit.row.readable, false);
  assert.equal(r.out.evidence.audit.row.ahead, 0);
  assert.equal(r.out.evidence.audit.stderr, `MISSING on disk: ${f.wt}`);
});

test("absent: a path no row names halts, listing the rows it did see", () => {
  const f = fixture();
  const stray = join(f.root, "elsewhere");
  mkdirSync(stray);
  const r = audit(f, ["--worktree", stray, "--pin", f.pin, "--sample-seconds", "0"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "absent");
  assert.equal(r.out.head, null);
  assert.deepEqual(r.out.evidence.audit.rows, [f.w, f.wt]);
});

test("exit 2: a repository the audit cannot read is could-not-look, not a cause", () => {
  const f = fixture();
  const notRepo = tempDir("finisher-audit-norepo-");
  const r = audit(f, ["--worktree", f.wt, "--pin", f.pin], { cwd: notRepo });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.cause, null);
  assert.match(r.out.evidence.error, /worktree-audit\.sh failed/);
  assert.match(r.stderr, /finisher-audit: worktree-audit\.sh failed/);
});

test("exit 2: an audit whose BASE_REF does not resolve is could-not-look", () => {
  const f = fixture();
  const r = std(f, [], { env: { BASE_REF: "origin/nosuchref" } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.out.evidence.error, /worktree-audit\.sh failed/);
});

test("--repo names the repository the audit runs in, and the cwd is the default", () => {
  const f = fixture();
  const elsewhere = tempDir("finisher-audit-cwd-");
  const withRepo = audit(f, ["--worktree", f.wt, "--pin", f.pin, "--repo", f.w], { cwd: elsewhere });
  assert.equal(withRepo.status, 0, withRepo.stderr);
  const bare = audit(f, ["--worktree", f.wt, "--pin", f.pin], { cwd: f.w });
  assert.equal(bare.status, 0, bare.stderr);
  const lost = audit(f, ["--worktree", f.wt, "--pin", f.pin], { cwd: elsewhere });
  assert.equal(lost.status, 2, "no --repo and a cwd outside the repository is could-not-look");
});

test("an inherited GIT_DIR cannot retarget the head read", () => {
  const f = fixture();
  const other = fixture();
  const r = std(f, [], { env: { GIT_DIR: join(other.w, ".git"), GIT_WORK_TREE: other.w } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.head, f.pin);
});

test("exit 2: a missing flag, an unknown flag, a short pin, a relative path and a bad --repo or --sample-seconds are refused with no verdict", () => {
  const f = fixture();
  const ok = ["--worktree", f.wt, "--pin", f.pin];
  for (const args of [
    ["--pin", f.pin],
    ["--worktree", f.wt],
    [...ok, "--bogus"],
    [...ok, "--repo"],
    [...ok, "--repo", join(f.root, "nope")],
    [...ok, "--sample-seconds", "abc"],
    ["--worktree", f.wt, "--pin", f.pin.slice(0, 12)],
    ["--worktree", "relative/path", "--pin", f.pin],
    [...ok, "stray"],
  ]) {
    const r = audit(f, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.out, null, `${args.join(" ")} printed a verdict`);
    assert.match(r.stderr, /^\nfinisher-audit: /);
  }
});
