// Regression gate for prove-merge.sh, the proof that says which head actually
// landed. Zero deps: `node --test skills/fleet/scripts/prove-merge.test.mjs`.
//
// A shell script that reasons about git history can only be tested against real
// git history, so every case below builds a throwaway origin+clone in a temp dir
// and runs the script for real.
//
// The load-bearing case is `un-rebased head that merged cleanly still proves
// false` — that attack is the whole reason the script exists, and relaxing the
// pre-rebase ancestor gate for the no-rebase path is exactly the change that
// could silently drop it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./prove-merge.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like.
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Empty commit on the current branch; returns its sha. */
const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "prove-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

/** Merge `head` into main with a real merge commit; returns the merge sha. */
function mergeNoFf(w, head, msg) {
  git(w, "checkout", "-q", "main");
  git(w, "merge", "-q", "--no-ff", "-m", msg, head);
  return git(w, "rev-parse", "HEAD");
}

function prove(cwd, pre, post, merge) {
  const r = spawnSync("sh", [SCRIPT, pre, post, merge], { cwd, env: ENV, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("already-current merge (pre == post, behind_by=0) proves true", (t) => {
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, head, head, merge);
  assert.equal(json.proved, true, "an already-current merge must not false-negative");
  assert.equal(json.proofPath, "no-rebase");
  assert.equal(json.headWasCurrent, true);
  assert.equal(json.secondParent, head);
  assert.equal(code, 0);
  // The old leg-1 gate is still reported, and is still unsatisfiable here —
  // which is precisely why it can no longer be required on this path.
  assert.equal(json.preIsAncestor, true);
});

test("rebase-then-merge (pre != post) proves true and keeps all three legs", (t) => {
  const w = repo(t);
  const branchPoint = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "main");
  commit(w, "main moves on");
  git(w, "push", "-q", "origin", "main");

  git(w, "checkout", "-q", "-b", "feat", branchPoint);
  const pre = commit(w, "feature work");
  git(w, "rebase", "-q", "main");
  const post = git(w, "rev-parse", "HEAD");
  assert.notEqual(pre, post, "fixture must actually rebase");

  const merge = mergeNoFf(w, post, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, pre, post, merge);
  assert.equal(json.proved, true);
  assert.equal(json.proofPath, "rebase");
  assert.deepEqual(
    { pre: json.preIsAncestor, post: json.postIsAncestor, second: json.secondParent },
    { pre: false, post: true, second: post },
  );
  assert.equal(code, 0);
});

test("rebase path still fails leg 1 when the branch was updated by merging main in", (t) => {
  // Not a rebase: main was merged *into* the branch, so the pre head survives as
  // an ancestor of main. pre != post, so the leg-1 gate stays mandatory here.
  const w = repo(t);
  const branchPoint = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "main");
  commit(w, "main moves on");
  git(w, "push", "-q", "origin", "main");

  git(w, "checkout", "-q", "-b", "feat", branchPoint);
  const pre = commit(w, "feature work");
  git(w, "merge", "-q", "--no-ff", "-m", "merge main into feat", "main");
  const post = git(w, "rev-parse", "HEAD");

  const merge = mergeNoFf(w, post, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, pre, post, merge);
  assert.equal(json.preIsAncestor, true);
  assert.equal(json.proved, false, "leg 1 must still bite on the rebase path");
  assert.equal(code, 1);
});

test("ATTACK: un-rebased head that merged cleanly still proves false", (t) => {
  // The head was built on an older main, main moved, and it was merged without
  // ever being rebased. The caller then claims "no rebase was needed" by passing
  // pre == post. The no-rebase path must not accept this.
  const w = repo(t);
  const stalePoint = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "stale", stalePoint);
  const head = commit(w, "stale feature work");

  git(w, "checkout", "-q", "main");
  commit(w, "main moved on without the branch");
  const merge = mergeNoFf(w, head, "merge stale branch WITHOUT rebasing");
  git(w, "push", "-q", "origin", "main");

  // Everything the relaxed path looks at except currency is satisfied:
  assert.equal(git(w, "rev-parse", `${merge}^2`), head, "fixture: the stale head really did land");

  const { code, json } = prove(w, head, head, merge);
  assert.equal(json.headWasCurrent, false, "prior main tip is not an ancestor of the merged head");
  assert.equal(json.proved, false, "an un-rebased head must never prove true");
  assert.equal(code, 1);
});

test("ATTACK: wrong head — merge second parent is not the verified-green head", (t) => {
  // Leg 3 has to be the *only* gate that bites here, or this test proves nothing
  // about leg 3. So the green head really does land (leg 2 passes) and the wrong
  // merge's first parent really is an ancestor of it (headWasCurrent passes).
  const w = repo(t);
  const base = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "green", base);
  const green = commit(w, "the head that was verified green");
  git(w, "checkout", "-q", "-b", "other", base);
  const other = commit(w, "a different head entirely");
  const wrongMerge = mergeNoFf(w, other, "merge the wrong branch");
  mergeNoFf(w, green, "merge the green branch too, later");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, green, green, wrongMerge);
  assert.deepEqual(
    { post: json.postIsAncestor, current: json.headWasCurrent, parents: json.parentCount },
    { post: true, current: true, parents: 2 },
    "every other gate must pass, so only leg 3 can explain the disproof",
  );
  assert.equal(json.secondParent, other);
  assert.equal(json.proved, false);
  assert.equal(code, 1);
});

test("leg 2 still bites: a head that never landed cannot be proved", (t) => {
  // The merge is real but lives on a side branch that was never pushed, so the
  // head is not an ancestor of the base ref. Every other gate passes, which is
  // what makes this a test of leg 2 rather than of whatever fires first.
  const w = repo(t);
  const base = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat", base);
  const head = commit(w, "work that never reached main");
  git(w, "checkout", "-q", "-b", "side", base);
  git(w, "merge", "-q", "--no-ff", "-m", "merge feat into a branch that is not main", head);
  const merge = git(w, "rev-parse", "HEAD");

  git(w, "checkout", "-q", "main");
  commit(w, "main moves on without either of them");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, head, head, merge);
  assert.deepEqual(
    { second: json.secondParent, current: json.headWasCurrent, parents: json.parentCount },
    { second: head, current: true, parents: 2 },
    "every other gate must pass, so only leg 2 can explain the disproof",
  );
  assert.equal(json.postIsAncestor, false);
  assert.equal(json.proved, false, "a merge that never reached the base ref proves nothing");
  assert.equal(code, 1);
});

test("ATTACK: octopus merge dragging in an unreviewed third parent proves false", (t) => {
  const w = repo(t);
  const base = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat", base);
  const head = commit(w, "feature work");
  git(w, "checkout", "-q", "-b", "smuggled", base);
  commit(w, "unreviewed code riding along");

  git(w, "checkout", "-q", "main");
  git(w, "merge", "-q", "--no-ff", "-m", "octopus", "feat", "smuggled");
  const merge = git(w, "rev-parse", "HEAD");
  git(w, "push", "-q", "origin", "main");

  assert.equal(git(w, "rev-parse", `${merge}^2`), head, "fixture: ^2 still looks right");

  const { code, json } = prove(w, head, head, merge);
  assert.equal(json.parentCount, 3);
  assert.equal(json.proved, false, "only a two-parent merge can be proved");
  assert.equal(code, 1);
});

test("post-fetch: a correct merge stays true once origin/main has moved past it", (t) => {
  // The script fetches before it checks, so by the time it runs the merge is
  // already in the base ref — and in a cascade wave main has moved on again.
  // Neither may, by itself, flip a correct merge to false.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  // A later merge in the same wave lands on top.
  git(w, "checkout", "-q", "-b", "feat2");
  const head2 = commit(w, "the next PR in the wave");
  mergeNoFf(w, head2, "merge feat2");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, head, head, merge);
  assert.equal(json.proved, true, "a correct merge must survive the base ref moving past it");
  assert.equal(code, 0);
});

test("exit code tracks proved; usage errors exit 2", (t) => {
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const ok = prove(w, head, head, merge);
  assert.deepEqual([ok.json.proved, ok.code], [true, 0]);

  const priorTip = git(w, "rev-parse", `${merge}^1`);
  const bad = prove(w, priorTip, priorTip, merge);
  assert.deepEqual([bad.json.proved, bad.code], [false, 1]);

  const usage = spawnSync("sh", [SCRIPT, head], { cwd: w, env: ENV, encoding: "utf8" });
  assert.equal(usage.status, 2);
  const unknown = prove(w, head, head, "0".repeat(40));
  assert.equal(unknown.code, 2, "an unresolvable commit is an error, not a disproof");
});
