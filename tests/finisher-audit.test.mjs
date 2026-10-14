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
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
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
  assert.equal(r.out.evidence.cherry, undefined);
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

test("rebase: a branch replayed onto a new base halts, with the reflog line and git cherry's output", () => {
  const f = fixture();
  commit(f.w, "main-moves");
  git(f.w, "push", "-q", "origin", "main");
  git(f.w, "fetch", "-q", "origin");
  git(f.wt, "rebase", "-q", "origin/main");
  const head = git(f.wt, "rev-parse", "HEAD");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "rebase");
  assert.equal(r.out.head, head);
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: rebase/);
  // The replayed commit is content-identical to the pinned one, which cherry
  // marks with a leading `-` against the upstream (the pin).
  assert.equal(r.out.evidence.cherry.trim(), `- ${head}`);
});

test("rebase: a reset to another commit is a rebase entry too", () => {
  const f = fixture();
  git(f.wt, "reset", "-q", "--hard", "origin/main");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "rebase");
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: reset/);
});

// past-pin: the commit made after the dispatch, and whether anything can reach it.
function pastPin() {
  const f = fixture();
  f.late = commit(f.wt, "late");
  return f;
}

test("past-pin pushed: the remote branch is at the commit", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "feat");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.equal(r.out.head, f.late);
  assert.equal(r.out.evidence.commit, `${f.late.slice(0, 7)} late`);
  assert.equal(r.out.evidence.remote.state, "pushed");
  assert.match(r.out.evidence.reflog, /HEAD@\{0\}: commit: late/);
});

test("past-pin unpushed: the remote branch is behind the commit", () => {
  const f = pastPin();
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.equal(r.out.evidence.remote.state, "unpushed");
  assert.equal(r.out.evidence.remote.sha, f.pin);
});

test("past-pin unpushed: a branch the remote has never heard of is a read that succeeded and found nothing", () => {
  const f = pastPin();
  git(f.wt, "push", "-q", "origin", "--delete", "feat");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.evidence.remote.state, "unpushed");
  assert.equal(r.out.evidence.remote.sha, null);
});

test("past-pin unknown: a failed git ls-remote is never unpushed", () => {
  const f = pastPin();
  git(f.w, "remote", "set-url", "origin", join(f.root, "no-such-origin.git"));
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.equal(r.out.evidence.remote.state, "unknown");
  assert.ok(r.out.evidence.remote.error.length > 0, "the failed read names why");
});

test("past-pin unknown: a detached HEAD has no branch to ask the remote about", () => {
  const f = fixture();
  git(f.wt, "checkout", "-q", "--detach");
  const late = commit(f.wt, "late");
  const r = std(f);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.cause, "past-pin");
  assert.equal(r.out.head, late);
  assert.equal(r.out.evidence.remote.state, "unknown");
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
