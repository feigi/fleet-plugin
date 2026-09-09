// The claim → push → merge → reap lifecycle, driven end to end against a real
// bare origin. #760 is a bug about a branch's UPSTREAM, and an upstream is only
// observable through what the other scripts do with it — so pinning the config
// values claim-ticket.sh writes proves nothing about whether reap.sh can see
// the branch or release-ticket.sh can delete it. A first cut of #760 did pin
// exactly those values, went green, and had in fact made a freshly claimed
// branch read `[gone]` immediately: `reap.sh --apply` deleted the worktree and
// the branch before any work was done in them. These tests are the consequence
// coverage that gap needed.
//
// Zero deps: `node --test scripts/claim-lifecycle.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLAIM = fileURLToPath(new URL("./claim-ticket.sh", import.meta.url));
const REAP = fileURLToPath(new URL("./reap.sh", import.meta.url));
const RELEASE = fileURLToPath(new URL("./release-ticket.sh", import.meta.url));

// Cut the developer's ~/.gitconfig out of the fixture: a local `push.default`
// or `branch.autoSetupMerge` decides the very behaviour under test here.
const BASE_ENV = {
  ...process.env,
  BASE_REF: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/**
 * Bare origin + a clone standing in for the fleet's checkout, plus a `gh` stub
 * on PATH. `gh issue view` answers `in-progress` because release-ticket.sh
 * reads the label before it deletes anything.
 */
function fixture(t) {
  // realpathSync: macOS resolves /var through /private, and git canonicalises
  // the paths it reports, so a raw mkdtemp path never string-matches them.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  const bin = join(root, "bin");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: BASE_ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: BASE_ENV });
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$*" in *"issue view"*) echo in-progress;; esac\nexit 0\n', { mode: 0o755 });
  const env = { ...BASE_ENV, PATH: `${bin}:${process.env.PATH}` };
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();
  // claim-ticket.sh refuses to emit a runner for a repo with no test files.
  writeFileSync(join(w, "t.test.mjs"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return { root, origin, w, env, git };
}

const sh = (script, cwd, env, ...args) =>
  spawnSync("sh", [script, ...args], { cwd, env, encoding: "utf8" });

/** What reap.sh's sweep selects on: `%(upstream:track)` for one branch. */
const track = (git, w, branch) =>
  git(w, "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`);

/** Advance origin/main past the claim's base, without merging it locally. */
function staleLocalMain({ origin, root, env, git }) {
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", origin, other], { env });
  git(other, "commit", "-q", "--allow-empty", "-m", "later");
  git(other, "push", "-q", "origin", "HEAD:main");
}

test("a freshly claimed branch is not [gone], and reap.sh leaves it alone", (t) => {
  const f = fixture(t);
  const claim = sh(CLAIM, f.w, f.env, "42", "slug", "fix", "--apply");
  assert.equal(claim.status, 0, claim.stdout + claim.stderr);

  const wt = join(f.w, ".worktrees", "42-slug");
  // #760's own measurement: an upstream of origin/main makes `@{u}` RESOLVE,
  // so every "did my push land?" check answers about main instead. It has to
  // fail loudly, and the failure has to be the missing-upstream one — a claim
  // whose upstream merely names an absent ref resolves here just fine.
  const u = spawnSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "@{u}"], { env: f.env, encoding: "utf8" });
  assert.notEqual(u.status, 0, u.stdout);
  assert.match(u.stderr, /no upstream configured/);

  // An upstream naming a remote ref that has never existed reads `[gone]` here
  // — indistinguishable, to reap.sh, from a merged branch whose remote was
  // deleted. No upstream at all reads empty.
  assert.equal(track(f.git, f.w, "fix/42-slug"), "");

  const reaped = sh(REAP, f.w, f.env, "--apply");
  assert.equal(reaped.status, 0, reaped.stdout + reaped.stderr);
  assert.deepEqual(JSON.parse(reaped.stdout).reaped, []);
  // Positive control on the same run: the branch and its worktree survived.
  assert.equal(f.git(f.w, "rev-parse", "--verify", "refs/heads/fix/42-slug").length, 40);
  assert.match(f.git(f.w, "worktree", "list"), /42-slug/);
});

test("after push -u, merge and prune, reap.sh does see the branch as [gone]", (t) => {
  const f = fixture(t);
  assert.equal(sh(CLAIM, f.w, f.env, "42", "slug", "fix", "--apply").status, 0);
  const wt = join(f.w, ".worktrees", "42-slug");

  // The documented first push (skills/next-ticket/SKILL.md step 7) is what
  // establishes the real upstream — nothing before it should have.
  f.git(wt, "commit", "-q", "--allow-empty", "-m", "work");
  f.git(wt, "push", "-q", "-u", "origin", "HEAD");
  assert.equal(f.git(f.w, "config", "--get", "branch.fix/42-slug.merge"), "refs/heads/fix/42-slug");

  // Merge and delete the remote branch, the way GitHub does.
  f.git(wt, "push", "-q", "origin", "HEAD:main");
  f.git(wt, "push", "-q", "origin", ":refs/heads/fix/42-slug");
  f.git(f.w, "fetch", "-q", "--prune", "origin");
  assert.equal(track(f.git, f.w, "fix/42-slug"), "[gone]");

  const reaped = sh(REAP, f.w, f.env, "--apply");
  assert.equal(reaped.status, 0, reaped.stdout + reaped.stderr);
  assert.deepEqual(JSON.parse(reaped.stdout).reaped, ["fix/42-slug"]);
  assert.equal(
    spawnSync("git", ["-C", f.w, "rev-parse", "--verify", "refs/heads/fix/42-slug"], { env: f.env }).status,
    128,
  );
});

test("release-ticket.sh --apply releases an untouched claim while local main is stale", (t) => {
  const f = fixture(t);
  // ORDER IS THE WHOLE TEST. origin/main advances and is fetched BEFORE the
  // claim, so the branch is cut from a commit local main has never reached.
  // Advance origin AFTER the claim instead and the branch's base still equals
  // local HEAD, `git branch -d` finds it trivially merged, and the test goes
  // green against the very bug it exists to catch — measured, that ordering
  // let a `-d` mutant through.
  staleLocalMain(f);
  f.git(f.w, "fetch", "-q", "origin");
  assert.equal(sh(CLAIM, f.w, f.env, "42", "slug", "fix", "--apply").status, 0);
  // The claim's base is not an ancestor of local HEAD, so `git branch -d`
  // — which falls back to comparing against HEAD once the branch has no
  // resolvable upstream — refuses, half-releasing the claim: worktree deleted,
  // branch stranded, in-progress still on the issue.
  assert.notEqual(f.git(f.w, "rev-parse", "main"), f.git(f.w, "rev-parse", "origin/main"));
  assert.equal(f.git(f.w, "rev-parse", "refs/heads/fix/42-slug"), f.git(f.w, "rev-parse", "origin/main"));

  const rel = sh(RELEASE, f.w, f.env, "42", "slug", "fix", "--apply");
  assert.equal(rel.status, 0, rel.stdout + rel.stderr);
  const receipt = JSON.parse(rel.stdout.trim().split("\n").pop());
  assert.equal(receipt.released, true);
  assert.deepEqual(receipt.blockers, []);
  assert.equal(
    spawnSync("git", ["-C", f.w, "rev-parse", "--verify", "refs/heads/fix/42-slug"], { env: f.env }).status,
    128,
  );
});

test("release-ticket.sh still refuses a claim that carries work", (t) => {
  // The control the previous test needs: `-D` is authorized by the `ahead` and
  // `git cherry` guards, so those guards have to still block. Without this a
  // fix that deletes unconditionally passes the test above.
  const f = fixture(t);
  assert.equal(sh(CLAIM, f.w, f.env, "42", "slug", "fix", "--apply").status, 0);
  f.git(join(f.w, ".worktrees", "42-slug"), "commit", "-q", "--allow-empty", "-m", "work");

  const rel = sh(RELEASE, f.w, f.env, "42", "slug", "fix", "--apply");
  assert.equal(rel.status, 1, rel.stdout + rel.stderr);
  const receipt = JSON.parse(rel.stdout.trim().split("\n").pop());
  assert.equal(receipt.released, false);
  assert.match(receipt.blockers.join(" "), /commit\(s\) ahead/);
  assert.equal(f.git(f.w, "rev-parse", "--verify", "refs/heads/fix/42-slug").length, 40);
});
