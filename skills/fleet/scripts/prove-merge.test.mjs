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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./prove-merge.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like.
const ENV = {
  ...process.env,
  // The script reads BASE_REF, and the fleet harness is exactly the caller that
  // would have it set — inheriting it points every fixture at local `main` and
  // the suite stays green while measuring the wrong ref. Same for the GIT_* vars,
  // which redirect the fixtures out of their own temp dirs.
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
  // Leg 1 wants this false, and here it cannot be: the merge landed, so leg 2
  // makes pre — the same commit — an ancestor too. Legs 1 and 2 are jointly
  // unsatisfiable when pre == post, which is why leg 1 is dropped on this path.
  assert.equal(json.preIsAncestor, true);
});

test("rebase-then-merge (pre != post) proves true on the rebase path", (t) => {
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

test("ATTACK: a merge commit the caller fabricated is an error, not a proof", (t) => {
  // Every gate that reads structure reads it off <merge>. Hand over an object
  // built to satisfy them — first parent an ancestor of the head, second parent
  // the head itself — and without the reachability anchor it proves true.
  const w = repo(t);
  const branchPoint = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  mergeNoFf(w, head, "the real merge");
  git(w, "push", "-q", "origin", "main");

  const tree = git(w, "rev-parse", `${head}^{tree}`);
  const fake = git(w, "commit-tree", tree, "-p", branchPoint, "-p", head, "-m", "fabricated");
  assert.equal(
    spawnSync("git", ["merge-base", "--is-ancestor", fake, "origin/main"], { cwd: w, env: ENV }).status,
    1,
    "fixture: the fabricated merge really is unreachable from the base ref",
  );

  const { code, json, stderr } = prove(w, head, head, fake);
  assert.equal(json, null, "an unreachable merge must not emit a proof at all");
  assert.equal(code, 2, "that merge did not land — an error, not a disproof");
  assert.match(stderr, /is not reachable from/);
});

test("currency is required on the rebase path too, not just the no-rebase one", (t) => {
  // Rebased early onto B, then a sibling landed C, then merged without re-rebasing.
  // Leg 1 is satisfied — the pre head really was orphaned — so only headWasCurrent
  // can catch that the merged head was stale at merge time.
  const w = repo(t);
  const branchPoint = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "main");
  commit(w, "main -> B");
  git(w, "push", "-q", "origin", "main");

  git(w, "checkout", "-q", "-b", "feat", branchPoint);
  const pre = commit(w, "feature work");
  git(w, "rebase", "-q", "main");
  const post = git(w, "rev-parse", "HEAD");

  git(w, "checkout", "-q", "main");
  commit(w, "a sibling lands -> C");
  const merge = mergeNoFf(w, post, "merge feat WITHOUT re-rebasing onto C");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, pre, post, merge);
  assert.deepEqual(
    { path: json.proofPath, pre: json.preIsAncestor, second: json.secondParent },
    { path: "rebase", pre: false, second: post },
    "leg 1 passes here, so only headWasCurrent can explain the disproof",
  );
  assert.equal(json.headWasCurrent, false);
  assert.equal(json.proved, false, "a head that went stale between rebase and merge is not proved");
  assert.equal(code, 1);
});

test("ATTACK: a dishonest `pre` cannot downgrade the proof to the weaker path", (t) => {
  // Same stale un-rebased merge the ATTACK case above pins at false. The caller
  // claims a rebase happened by passing any commit that never landed as `pre`,
  // which routes to the rebase path and satisfies leg 1. headWasCurrent is the
  // only gate left that is derived from history rather than from the arguments.
  const w = repo(t);
  const stalePoint = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "stale", stalePoint);
  const head = commit(w, "stale feature work");
  git(w, "checkout", "-q", "-b", "junk", stalePoint);
  const junk = commit(w, "an abandoned attempt that never landed");

  git(w, "checkout", "-q", "main");
  commit(w, "main moved on without the branch");
  const merge = mergeNoFf(w, head, "merge stale branch WITHOUT rebasing");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, junk, head, merge);
  assert.equal(json.proofPath, "rebase", "fixture: the lie really does route to the rebase path");
  assert.equal(json.preIsAncestor, false, "fixture: leg 1 really is satisfied by the lie");
  assert.equal(json.proved, false, "the same merge must not prove true just because `pre` changed");
  assert.equal(code, 1);
});

test("a <merge-commit> that also names a file is read as a revision", (t) => {
  // `git rev-list --parents -n 1 mrg` is fatal when `mrg` is both a ref and a
  // path. The old code read `${merge}^2`, where the suffix disambiguated for free.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "branch", "mrg", merge);
  writeFileSync(join(w, "mrg"), "a file with the same name as the branch\n");
  git(w, "add", "mrg");
  commit(w, "add a file named mrg");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, head, head, "mrg");
  assert.equal(json?.proved, true, "an ambiguous name must resolve as a revision, not error out");
  assert.equal(code, 0);
});

test("a non-merge commit as <merge-commit> is a usage error, not a disproof", (t) => {
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const { code, json, stderr } = prove(w, head, head, head);
  assert.equal(json, null);
  assert.equal(code, 2);
  assert.match(stderr, /has no second parent/);
});

test("pre and post are compared as commits, not as the strings the caller typed", (t) => {
  // `feat` and its sha are the same commit, so this is the already-current case
  // and must take the no-rebase path. Comparing raw arguments would read it as a
  // rebase and reintroduce exactly the false negative this script was fixed for.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  for (const spelling of ["feat", head.slice(0, 8)]) {
    const { code, json } = prove(w, spelling, head, merge);
    assert.equal(json.proofPath, "no-rebase", `\`${spelling}\` names the same commit as its sha`);
    assert.equal(json.proved, true);
    assert.equal(code, 0);
  }
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
