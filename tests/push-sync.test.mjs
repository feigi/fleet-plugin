// push-sync.mjs: push `HEAD:refs/heads/<branch>` from wherever the caller
// stands — a `--detach` worktree, usually — then move the worktree that holds
// `refs/heads/<branch>` to the pushed SHA under its two guards. Driven against
// a real bare origin, with the claim worktree made the way claim-ticket.sh
// makes it (`worktree add --no-track -b`) and the detached one the way the
// runbook re-creates an open PR's worktree (`worktree add --detach <path>
// origin/<branch>`).
//
// Every case reads the result back from git — the claim ref, the claim
// worktree's HEAD and `status --porcelain`, origin's ref — never from the
// helper's own words alone.
//
// Zero deps: `node --test tests/push-sync.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { claimHolder } from "../plugin/scripts/push-sync.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/push-sync.mjs", import.meta.url));
const NOT_SYNCED = 3;

// The developer's ~/.gitconfig is cut out: a local `push.default` or a hook
// path would decide the very pushes under test.
const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...a) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const rev = (cwd, ref) => git(cwd, "rev-parse", ref);
const remoteTip = (origin, branch) => git(origin, "rev-parse", `refs/heads/${branch}`);
const status = (cwd) => git(cwd, "status", "--porcelain");

function commit(cwd, file, text, msg) {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return rev(cwd, "HEAD");
}

/**
 * Bare origin, a main checkout, the claim worktree on `fix/9-slug` pushed once
 * to origin, and a detached worktree cut from `origin/fix/9-slug`. `claimDir`
 * lets a case put a byte in the claim worktree's path that a line-wise
 * listing parse would split on.
 */
function fixture({ claimDir = "9-slug" } = {}) {
  const root = realpathSync(tempDir("push-sync-"));
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const branch = "fix/9-slug";
  git(root, "-c", "init.defaultBranch=main", "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, main);
  commit(main, "README.md", "root\n", "root");
  git(main, "branch", "-M", "main");
  git(main, "push", "-q", "-u", "origin", "main");
  const claim = join(main, ".worktrees", claimDir);
  git(main, "worktree", "add", "-q", "--no-track", "-b", branch, claim, "origin/main");
  commit(claim, "a.txt", "one\n", "first");
  git(claim, "push", "-q", "-u", "origin", "HEAD");
  git(main, "fetch", "-q", "origin");
  const detached = join(main, ".worktrees", "9-detached");
  git(main, "worktree", "add", "-q", "--detach", detached, `origin/${branch}`);
  return { root, origin, main, branch, claim, detached };
}

const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: ENV, encoding: "utf8" });

/** stdout's labelled lines, in order: `push:`, `sync:` (one per failed condition on a refusal), `read-back:`. */
const labels = (r) => r.stdout.split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf(":")));

// The defect, reproduced with the command the five prose sites used to give.
// A control: if this ever stops leaving the ref behind, the helper is moving
// nothing git does not already move.
test("control: a bare `git push origin HEAD:<branch>` from the detached worktree leaves refs/heads/<branch> at its old tip", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  const pushed = commit(f.detached, "a.txt", "two\n", "second");
  git(f.detached, "push", "-q", "origin", `HEAD:${f.branch}`);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), old);
  assert.notEqual(old, pushed);
});

test("fast-forward push: the claim ref and the claim worktree end at the pushed SHA, clean", () => {
  const f = fixture();
  const pushed = commit(f.detached, "a.txt", "two\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), pushed);
  assert.equal(rev(f.claim, "HEAD"), pushed);
  assert.equal(status(f.claim), "", "the index and working tree followed the ref");
  assert.equal(readFileSync(join(f.claim, "a.txt"), "utf8"), "two\n");
  assert.deepEqual(labels(r), ["push", "sync", "read-back"]);
  assert.match(r.stdout, /^read-back: .* equals the pushed /m);
});

test("rebase then --force-with-lease (non-fast-forward): synced, and the old tip was the lease value", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  // The lease value of a bare --force-with-lease is the remote-tracking ref.
  assert.equal(rev(f.detached, `refs/remotes/origin/${f.branch}`), old);
  writeFileSync(join(f.detached, "a.txt"), "rewritten\n");
  git(f.detached, "commit", "-q", "-a", "--amend", "-m", "first, rewritten");
  const pushed = rev(f.detached, "HEAD");
  assert.notEqual(git(f.detached, "merge-base", old, pushed), old, "the fixture must be a non-fast-forward");
  const r = run(f.detached, "--branch", f.branch, "--force-with-lease");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), pushed);
  assert.equal(rev(f.claim, "HEAD"), pushed);
  assert.equal(status(f.claim), "");
  assert.equal(readFileSync(join(f.claim, "a.txt"), "utf8"), "rewritten\n");
});

test("a dirty claim worktree: the push lands, nothing moves, a named refusal, exit 3", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  writeFileSync(join(f.claim, "a.txt"), "uncommitted\n");
  const pushed = commit(f.detached, "b.txt", "b\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, NOT_SYNCED, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed, "the push itself landed");
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), old);
  assert.equal(readFileSync(join(f.claim, "a.txt"), "utf8"), "uncommitted\n", "the worktree was not touched");
  assert.equal(status(f.claim), "M a.txt");
  assert.match(r.stdout, /^sync: refused \(claim-worktree-dirty\): .*the push itself landed/m);
  assert.doesNotMatch(r.stdout, /claim-ref-diverged/, "the ref condition held, so only the dirty one is named");
  assert.deepEqual(labels(r), ["push", "sync", "read-back"]);
  assert.match(r.stdout, /^read-back: .* differs from the pushed /m);
});

test("an untracked file counts as dirty too", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  writeFileSync(join(f.claim, "scratch.txt"), "x\n");
  commit(f.detached, "b.txt", "b\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, NOT_SYNCED, r.stderr);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), old);
  assert.match(r.stdout, /claim-worktree-dirty/);
});

test("a claim ref that is neither origin's pre-push head nor an ancestor of the push: no move, a named refusal", () => {
  const f = fixture();
  const local = commit(f.claim, "c.txt", "local only\n", "unpushed");
  const pushed = commit(f.detached, "b.txt", "b\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, NOT_SYNCED, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), local, "the unpushed commit is still the claim ref");
  assert.equal(status(f.claim), "");
  assert.match(r.stdout, /^sync: refused \(claim-ref-diverged\): .*the push itself landed/m);
  assert.doesNotMatch(r.stdout, /claim-worktree-dirty/);
});

test("both guards failing names both conditions", () => {
  const f = fixture();
  commit(f.claim, "c.txt", "local only\n", "unpushed");
  writeFileSync(join(f.claim, "c.txt"), "dirty\n");
  commit(f.detached, "b.txt", "b\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, NOT_SYNCED, r.stderr);
  assert.match(r.stdout, /claim-worktree-dirty/);
  assert.match(r.stdout, /claim-ref-diverged/);
});

test("an ancestry check git cannot answer refuses as ancestry-check-failed, with git's error, never as a divergence", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  commit(f.detached, "b.txt", "b\n", "second");
  // A bare push strands the claim ref at an ancestor of the push, so only the
  // ancestry check can let the sync through — and a shim on PATH makes that
  // one git call fail the way a corrupt or shallow object store does.
  git(f.detached, "push", "-q", "origin", `HEAD:${f.branch}`);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { env: ENV, encoding: "utf8" }).trim();
  const shims = tempDir("push-sync-shim-");
  writeFileSync(
    join(shims, "git"),
    `#!/bin/sh\nif [ "$1" = merge-base ]; then echo 'fatal: simulated object-store fault' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const r = spawnSync(process.execPath, [SCRIPT, "--branch", f.branch], {
    cwd: f.detached,
    env: { ...ENV, PATH: `${shims}:${ENV.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, NOT_SYNCED, r.stderr);
  assert.match(r.stdout, /^sync: refused \(ancestry-check-failed\): .*simulated object-store fault.*the push itself landed/m);
  assert.doesNotMatch(r.stdout, /claim-ref-diverged/, "a check that did not answer is no evidence of a divergence");
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), old, "nothing moved");
});

test("an unreadable origin head leaves only the ancestor alternative: a rebased push is refused, the unread head named", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  writeFileSync(join(f.detached, "a.txt"), "rewritten\n");
  git(f.detached, "commit", "-q", "-a", "--amend", "-m", "first, rewritten");
  const pushed = rev(f.detached, "HEAD");
  // `ls-remote origin` reads the url, the push the pushurl.
  git(f.main, "config", "remote.origin.pushurl", f.origin);
  git(f.main, "config", "remote.origin.url", join(f.root, "nonexistent.git"));
  const r = run(f.detached, "--branch", f.branch, "--force-with-lease");
  assert.equal(r.status, NOT_SYNCED, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed, "the push itself landed");
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), old, "nothing moved");
  assert.match(r.stdout, /^sync: refused \(claim-ref-diverged\): .*\(unread: [^)]/m);
});

test("no worktree holds the branch: the push stands, `no worktree holds <branch>`, exit 0", () => {
  const f = fixture();
  git(f.main, "worktree", "remove", f.claim);
  const pushed = commit(f.detached, "b.txt", "b\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.match(r.stdout, new RegExp(`^sync: no worktree holds ${f.branch}$`, "m"));
  assert.deepEqual(labels(r), ["push", "sync", "read-back"]);
});

test("a denied lease: the push's own exit status, no sync attempted, no --force retry", () => {
  const f = fixture();
  const old = rev(f.claim, "HEAD");
  // Someone else lands on the branch after the detached worktree's last fetch,
  // so its remote-tracking ref — the lease value — is stale.
  const other = join(f.root, "other");
  git(f.root, "clone", "-q", "-b", f.branch, f.origin, other);
  const theirs = commit(other, "theirs.txt", "theirs\n", "theirs");
  git(other, "push", "-q", "origin", "HEAD");
  git(f.detached, "commit", "-q", "--amend", "-m", "first, reworded");
  const control = spawnSync("git", ["push", "--force-with-lease", "--dry-run", "origin", `HEAD:refs/heads/${f.branch}`], { cwd: f.detached, env: ENV });
  assert.notEqual(control.status, 0, "the fixture's lease must be denied");
  const r = run(f.detached, "--branch", f.branch, "--force-with-lease");
  assert.equal(r.status, control.status, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), theirs, "their commit is still origin's head — nothing forced over it");
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), old);
  assert.deepEqual(labels(r), ["push"], "no sync and no read-back after a failed push");
  assert.match(r.stdout, /^push: failed/m);
  assert.match(r.stderr, /stale info|rejected/);
});

test("a push git itself aborts exits with git's own status, not a fixed one", () => {
  const f = fixture();
  commit(f.detached, "b.txt", "b\n", "second");
  git(f.detached, "remote", "set-url", "origin", join(f.root, "nonexistent.git"));
  const control = spawnSync("git", ["push", "origin", `HEAD:refs/heads/${f.branch}`], { cwd: f.detached, env: ENV });
  assert.equal(control.status, 128, "the fixture's push must die the way git's fatal errors do");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, 128, r.stderr);
  assert.match(r.stdout, /^push: failed \(exit 128\)/m);
});

test("an ambient GIT_DIR and GIT_WORK_TREE naming another repository do not move the push or the sync", () => {
  const f = fixture();
  const other = join(f.root, "other");
  git(f.root, "-c", "init.defaultBranch=main", "init", "-q", other);
  commit(other, "o.txt", "o\n", "other");
  const pushed = commit(f.detached, "a.txt", "two\n", "second");
  const r = spawnSync(process.execPath, [SCRIPT, "--branch", f.branch], {
    cwd: f.detached,
    env: { ...ENV, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), pushed);
  assert.equal(status(f.claim), "");
});

// What the guards must ACCEPT.

test("an up-to-date push still moves a claim ref an earlier bare push stranded", () => {
  const f = fixture();
  const pushed = commit(f.detached, "b.txt", "b\n", "second");
  git(f.detached, "push", "-q", "origin", `HEAD:${f.branch}`);
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Everything up-to-date/);
  assert.equal(rev(f.main, `refs/heads/${f.branch}`), pushed);
  assert.equal(status(f.claim), "");
});

test("run from the attached claim worktree itself, dirty: nothing to move, exit 0", () => {
  const f = fixture();
  const pushed = commit(f.claim, "b.txt", "b\n", "second");
  writeFileSync(join(f.claim, "notes.txt"), "untracked\n");
  const r = run(f.claim, "--branch", f.branch);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(f.origin, f.branch), pushed);
  assert.equal(rev(f.claim, "HEAD"), pushed);
  assert.match(r.stdout, /^sync: .* already at /m);
  assert.equal(readFileSync(join(f.claim, "notes.txt"), "utf8"), "untracked\n");
});

test("a branch origin does not have yet: the claim ref is an ancestor of the push, so it moves", () => {
  const f = fixture();
  const fresh = "fix/10-new";
  const claim = join(f.main, ".worktrees", "10-new");
  git(f.main, "worktree", "add", "-q", "--no-track", "-b", fresh, claim, "origin/main");
  git(f.detached, "checkout", "-q", "--detach", "origin/main");
  const pushed = commit(f.detached, "n.txt", "n\n", "new");
  const r = run(f.detached, "--branch", fresh);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(f.origin, fresh), pushed);
  assert.equal(rev(f.main, `refs/heads/${fresh}`), pushed);
  assert.equal(status(claim), "");
});

test("a claim worktree whose path holds a newline is still found: the listing is parsed NUL-delimited", (t) => {
  let f;
  try {
    f = fixture({ claimDir: "9\nslug" });
  } catch (e) {
    t.skip(`this filesystem refused a newline in a path: ${e.message}`);
    return;
  }
  const pushed = commit(f.detached, "a.txt", "two\n", "second");
  const r = run(f.detached, "--branch", f.branch);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rev(f.claim, "HEAD"), pushed);
});

test("an empty --branch — `$(git branch --show-current)` in a detached worktree — refuses with exit 2 before pushing", () => {
  const f = fixture();
  const before = remoteTip(f.origin, f.branch);
  commit(f.detached, "b.txt", "b\n", "second");
  assert.equal(git(f.detached, "branch", "--show-current"), "");
  for (const args of [["--branch", ""], []]) {
    const r = run(f.detached, ...args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
  assert.equal(remoteTip(f.origin, f.branch), before, "nothing was pushed");
});

test("an invalid --branch refuses with exit 2 before pushing", () => {
  const f = fixture();
  const before = remoteTip(f.origin, f.branch);
  commit(f.detached, "b.txt", "b\n", "second");
  const r = run(f.detached, "--branch", "a..b");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /'a\.\.b' is not a valid branch name/);
  assert.equal(remoteTip(f.origin, f.branch), before, "nothing was pushed");
});

test("a git that cannot run, or a cwd outside any repository, is named as such — not as a bad branch or an unborn HEAD", () => {
  const noGit = spawnSync(process.execPath, [SCRIPT, "--branch", "fix/1-x"], {
    cwd: tempDir("push-sync-nogit-"),
    env: { ...ENV, PATH: "/nonexistent" },
    encoding: "utf8",
  });
  assert.equal(noGit.status, 2, noGit.stderr);
  assert.match(noGit.stderr, /git could not run: .*ENOENT/);
  const outside = run(tempDir("push-sync-norepo-"), "--branch", "fix/1-x");
  assert.equal(outside.status, 2, outside.stderr);
  assert.match(outside.stderr, /cannot read HEAD: .*not a git repository/);
});

test("claimHolder reads `worktree list --porcelain -z` by record, never by line", () => {
  const listing = [
    "worktree /r", "HEAD aaaa", "branch refs/heads/main", "",
    "worktree /r/.worktrees/x\nbranch refs/heads/fix/9", "HEAD bbbb", "detached", "",
    "worktree /r/.worktrees/y", "HEAD cccc", "branch refs/heads/fix/9", "locked", "",
  ].join("\0");
  assert.equal(claimHolder(listing, "fix/9"), "/r/.worktrees/y");
  assert.equal(claimHolder(listing, "main"), "/r");
  assert.equal(claimHolder(listing, "fix"), null, "a prefix of a branch is not the branch");
  const suffixed = ["worktree /r", "HEAD aaaa", "branch refs/heads/x/fix/9", ""].join("\0");
  assert.equal(claimHolder(suffixed, "fix/9"), null, "a branch ending in the wanted name is not the branch");
  assert.equal(claimHolder("", "main"), null);
});

// Every prose site that pushes from a detached worktree names the helper as
// many times as the table says — once per push there, and once in
// reviewers.md, which shows it as the worked example of binding `--branch`
// rather than pushing — and none still shows a bare refspec push, in
// backticks, in a fenced block or as plain text.
test("each detached-push prose site names the helper and shows no bare `git push … HEAD:<branch>`", () => {
  const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
  const SITES = [
    ["skills/next-ticket/SKILL.md", 1],
    ["skills/run-team/briefs/fix-applier.md", 2],
    ["commands/review-and-fix.md", 1],
    ["agents/fleet-fix-applier.agent.md", 1],
    ["skills/run-team/references/reviewers.md", 1],
  ];
  for (const [rel, mentions] of SITES) {
    const text = readFileSync(join(PLUGIN, rel), "utf8").replace(/\s+/g, " ");
    const named = text.split("~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run push-sync.mjs --branch ").length - 1;
    assert.equal(named, mentions, `${rel} names the helper ${named} time(s), expected ${mentions}`);
    assert.doesNotMatch(text, /git push\b[^.]*\bHEAD:/, `${rel} still shows a bare refspec push`);
  }
});
