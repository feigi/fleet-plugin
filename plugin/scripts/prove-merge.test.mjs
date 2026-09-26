// Regression gate for prove-merge.sh, the proof that says which head actually
// landed. Zero deps: `node --test plugin/scripts/prove-merge.test.mjs`.
//
// A shell script that reasons about git history can only be tested against real
// git history, so the cases below that reason about history build a throwaway
// origin+clone in a temp dir and run the script for real; a case that reasons
// about the script's source text directly does not.
//
// The load-bearing case is `un-rebased head that merged cleanly still proves
// false` — that attack is the whole reason the script exists, and relaxing the
// pre-rebase ancestor gate for the no-rebase path is exactly the change that
// could silently drop it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { slowTransport, SSH_URL, warmStub } from "./slow-transport.mjs";

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
  // Two cases below assert on git's OWN diagnostic text, across three strings,
  // and one of those strings is gettext-translatable: rev-parse's "Needed a
  // single revision" is `die(_("..."))` in builtin/rev-parse.c, and git ships a
  // live German msgstr for it. cat-file's "Not a valid object name" and
  // object-name.c's "dereferences to %s type" are unwrapped today — pinning the
  // locale is what stops any of the three turning on which git build CI runs.
  LANG: "C",
  LC_ALL: "C",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

// Absolute path to the real git, for the one test that shadows `git` on PATH.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// Absolute path to the real sed, for the two cases that shadow `sed` on PATH.
const REAL_SED = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();

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
  const json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  // #18. The `gates` object's entire contract: `proved` is true exactly when
  // every value in it is true. Checked here rather than in one test of its own,
  // so every fixture in this file — each verdict, each attack — pins it, and a
  // gate that stops being load-bearing cannot be added or dropped in silence.
  if (json) {
    assert.equal(
      json.proved,
      Object.values(json.gates).every((v) => v === true),
      "proved must be exactly the conjunction of the gates object",
    );
  }
  return { code: r.status, json, stderr: r.stderr };
}

test("already-current merge (pre == post, behind_by=0) proves true", (t) => {
  const w = repo(t);
  // Advance main first and cut the branch from the new tip. Branching off the
  // root instead would make headWasCurrent hold trivially — every commit
  // descends from the root — and the case would pass without measuring currency.
  commit(w, "main moves on before the branch is cut");
  git(w, "push", "-q", "origin", "main");
  const mainTip = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");
  assert.equal(git(w, "rev-parse", `${merge}^1`), mainTip, "fixture: main really had moved");

  const { code, json } = prove(w, head, head, merge);
  assert.equal(json.proved, true, "an already-current merge must not false-negative");
  assert.equal(json.proofPath, "no-rebase");
  assert.equal(json.headWasCurrent, true);
  assert.equal(json.secondParent, head);
  assert.equal(json.firstParent, mainTip, "the main tip the merge was built on");
  assert.equal(code, 0);
  // Leg 1 wants this false, and here it cannot be: the merge landed, so leg 2
  // makes pre — the same commit — an ancestor too. Legs 1 and 2 are jointly
  // unsatisfiable when pre == post, which is why leg 1 is dropped on this path.
  assert.equal(json.preIsAncestor, true);
  // #18: and that true reading sits next to proved:true without contradiction
  // only because it is an observation here, not a gate. Its ABSENCE from `gates`
  // is the machine-readable form of "leg 1 was dropped on this path" — the thing
  // a consumer previously had to infer from `proofPath`.
  assert.deepEqual(json.gates, {
    postIsAncestor: true,
    secondParentIsHead: true,
    exactlyTwoParents: true,
    headWasCurrent: true,
  });
  assert.ok(!("preDidNotLand" in json.gates), "leg 1 is not a gate when pre == post");
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
  // Not `notEqual(pre, post)` — that only proves the sha moved, which an amend
  // would also do. The rebase is real only if the head now sits on the main tip.
  assert.equal(git(w, "rev-parse", `${post}^`), git(w, "rev-parse", "main"));

  const merge = mergeNoFf(w, post, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, pre, post, merge);
  assert.equal(json.proved, true);
  assert.equal(json.proofPath, "rebase");
  assert.deepEqual(
    { pre: json.preIsAncestor, post: json.postIsAncestor, second: json.secondParent },
    { pre: false, post: true, second: post },
  );
  // #18. Leg 1 IS a gate here, and the gate reads true while the observation it
  // is derived from reads false — the polarity a bare list of gate NAMES could
  // not carry, and the reason `gates` holds booleans rather than field names.
  assert.deepEqual(json.gates, {
    preDidNotLand: true,
    postIsAncestor: true,
    secondParentIsHead: true,
    exactlyTwoParents: true,
    headWasCurrent: true,
  });
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

test("gates.postIsAncestor is false when the claimed head never landed", (t) => {
  // No existing fixture drives a false postIsAncestor through to the payload:
  // the only way `post` itself fails to be an ancestor while `merge` still
  // lands is to hand the script a `post` that is not the merge's real second
  // parent at all — every fixture where they DO match has post_anc forced true
  // by transitivity (post is a parent of merge, merge lands, so post lands).
  const w = repo(t);
  // A real, unrelated merge that landed on main.
  git(w, "checkout", "-q", "-b", "feat");
  const realHead = commit(w, "feature work");
  const merge = mergeNoFf(w, realHead, "merge feat");
  git(w, "push", "-q", "origin", "main");

  // A head that never merged anywhere, passed as the claimed post/pre.
  git(w, "checkout", "-q", "-b", "unmerged", "main");
  const claimedHead = commit(w, "an unmerged head passed as the claimed post");

  const { code, json } = prove(w, claimedHead, claimedHead, merge);
  assert.equal(json.postIsAncestor, false, "fixture: the claimed head really never landed");
  assert.equal(json.gates.postIsAncestor, false);
  assert.equal(json.proved, false);
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
  // Leg 3 is the only false gate, so the object names the cause on its own —
  // without the caller diffing `secondParent` against a head it has to remember.
  assert.equal(json.gates.secondParentIsHead, false);
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

test("a git failure reading the parents is an error, never a silent disproof", (t) => {
  // `set -- $(cmd)` discards cmd's status, and an empty result trips `shift`
  // under `set -e` — exit 1 with no stdout, which a caller cannot tell apart
  // from a legitimate proved=false. Shim only `rev-list`; everything else is
  // real git, so the script gets all the way to the parents read.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const bin = mkdtempSync(join(tmpdir(), "prove-merge-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Ask the shell where git is, rather than deriving it from `--exec-path`:
  // that answer is `<prefix>/libexec/git-core` on macOS but `/usr/lib/git-core`
  // on Debian, where a `libexec` rewrite matches nothing and the shim execs a
  // DIRECTORY — "Permission denied", the fetch fails first, and the parents are
  // never read, so this test measures the wrong failure. Resolved out here,
  // where PATH is still the real one; inside the shim, `git` is the shim.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n[ "$1" = rev-list ] && exit 128\nexec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );

  const r = spawnSync("sh", [SCRIPT, head, head, merge], {
    cwd: w,
    env: { ...ENV, PATH: `${bin}:${ENV.PATH ?? process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.stdout.trim(), "", "fixture: the shim really did break the parents read");
  assert.equal(r.status, 2, "a git failure is exit 2, not the exit 1 that means disproved");
  assert.match(r.stderr, /cannot read the parents of/);
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
  // The gate, not just the observation: `parentCount >= 2` is a precondition
  // that dies at exit 2, while `== 2` is what decides this verdict, and only the
  // second one belongs in `gates`.
  assert.equal(json.gates.exactlyTwoParents, false);
  assert.equal(json.proved, false, "only a two-parent merge can be proved");
  assert.equal(code, 1);
});

test("post-fetch: a correct merge stays true once origin/main has moved past it", (t) => {
  // The script fetches before it checks, so by the time it runs the merge is
  // already in the base ref — and when one merge-bot run merges several PRs,
  // main has moved on again. Neither may, by itself, flip a correct merge to
  // false.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  // A later merge in the same merge-bot run lands on top.
  git(w, "checkout", "-q", "-b", "feat2");
  const head2 = commit(w, "the next PR in the same run");
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

test("a base ref the probe cannot answer for reports the probe failure, not a disproof", (t) => {
  // #267. `die` inside `$(...)` exits the subshell only, and `[ ]` throws that
  // status away — `set -e` never fires, control falls through to the outer die,
  // and "that merge did not land" is printed for a merge-base that never
  // answered. The honest cause prints first, but the *verdict* is the wrong one.
  //
  // A tree as BASE_REF is the way in, with no fault injection and no PATH shim:
  // $base is only `rev-parse --verify`'d and never commit-checked, so a tree
  // clears the gate and reaches the probe, where git exits 128 rather than 1.
  // Every commit already carries one, so no file has to be written to get it.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const tree = git(w, "rev-parse", `${head}^{tree}`);
  assert.equal(git(w, "cat-file", "-t", tree), "tree", "fixture: BASE_REF really names a tree");

  const r = spawnSync("sh", [SCRIPT, head, head, merge], {
    cwd: w,
    env: { ...ENV, BASE_REF: tree },
    encoding: "utf8",
  });
  assert.match(r.stderr, /failed — cannot prove anything/, "fixture: the probe really did fail");
  assert.doesNotMatch(
    r.stderr,
    /did not land/,
    "a probe that could not answer must never be reported as a disproof it never established",
  );
  assert.equal(r.stdout.trim(), "", "a probe that did not answer emits no proof");
  // Not the discriminator: `die` is `exit 2` unconditionally, so this held before
  // the fix too. The stderr assertion above is what separates the two messages.
  assert.equal(r.status, 2, "a die is exit 2 — the question was not answered, so no exit 1 for a `no`");

  // The other half: the same fixture, with a base that CAN answer, must still be
  // accepted. Assigning the probe first makes `set -e` live on this line, so a
  // suite that only ever fed it a failing probe would not notice it aborting on
  // a good one — the false positive that a fix for a false negative invites.
  const { code, json } = prove(w, head, head, merge);
  assert.equal(json.proved, true, "a merge that did land must still prove true");
  assert.equal(code, 0);
});

test("an object that is present but is not a commit is not reported as absent", (t) => {
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");

  // A tree, so the object really is in this repository. Every commit already
  // carries one, so no file has to be written to get it.
  const tree = git(w, "rev-parse", `${head}^{tree}`);
  // <merge-commit> is `head`, not a merge: the cat-file loop dies on its FIRST
  // element, so the third argument is never reached and a real merge here would
  // only be scenery.
  const { code, json, stderr } = prove(w, tree, head, head);
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /cannot resolve .+ to a commit in this repository/);
  // The old wording asserted this object "is not a commit in this repository".
  // It is in this repository — git reads it and reports its real type, which is
  // the half `2>/dev/null` was throwing away.
  assert.match(stderr, /dereferences to tree type/, "git's own diagnosis must survive to stderr");
  // Names which guard fired: the two guards above are also exit 2 with no stdout.
  assert.doesNotMatch(stderr, /fetch failed|does not resolve/, "the guards above this one passed");

  // The discriminator the old message threw away: a sha that really is absent
  // used to print the identical die line, and now carries a different git line.
  const absent = prove(w, "0".repeat(40), head, head);
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /Not a valid object name 0{40}/);
  assert.doesNotMatch(
    absent.stderr,
    /dereferences to/,
    "an absent sha and a present non-commit must not collapse into one message",
  );
});

test("ATTACK: an annotated tag is refused at the guard, not silently mishandled into a false disproof (#585)", (t) => {
  // cat-file -e peels a tag to the commit underneath, so the existence guard
  // above accepted a tag on its own — and then bare `git rev-parse` handed
  // back the TAG's own sha, not the commit's, which the identity test later in
  // this script could never match. Every other leg still read healthy, so a
  // perfectly good merge came back proved=false with no hint the mismatch was
  // in argument handling rather than history. The guard now also checks
  // $obj's own (unpeeled) type and refuses anything that is not itself a
  // commit, so the tag never reaches that comparison at all.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  // Load-bearing, not scenery: without the merge on origin, the PRE-fix script
  // dies at `not reachable from origin/main` — exit 2, no proof — and every
  // `code === 2` below passes on the bug it exists to catch.
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", "-a", "v1", "-m", "annotated", head);

  const { code, json, stderr } = prove(w, "v1", "v1", merge);
  assert.equal(code, 2, "could not answer — never the 1 that means disproved, and not 0");
  assert.equal(json, null, "a refused input must not emit a proof at all");
  assert.match(stderr, /v1 is a tag, not a commit/, "the message names the object and its type");

  // The tag in the SECOND position alone: the call above dies on the loop's
  // first element, so it never reaches $post — and $post_full is the one value
  // `[ "$second" = "$post_full" ]` compares, the mismatch #585 is made of. A
  // real commit in position 1 is what carries the loop that far.
  const postOnly = prove(w, head, "v1", merge);
  assert.equal(postOnly.code, 2);
  assert.equal(postOnly.json, null);
  assert.match(postOnly.stderr, /v1 is a tag, not a commit/);

  // Same refusal in the third position: the merge-commit argument is never
  // handed to bare rev-parse downstream, but the guard's contract is that it
  // proves things about commits, uniformly, on all three positions.
  git(w, "tag", "-a", "vm", "-m", "annotated", merge);
  const merged = prove(w, head, head, "vm");
  assert.equal(merged.code, 2);
  assert.equal(merged.json, null);
  assert.match(merged.stderr, /vm is a tag, not a commit/);
});

test("a lightweight tag is accepted exactly like a sha — it resolves directly to a commit", (t) => {
  // The control for the refusal above: a lightweight tag is a ref pointing
  // straight at a commit, with no tag object in between, so it must clear the
  // new type check exactly as a sha or branch name does, and the proof must
  // come back byte-identical to the sha-driven control.
  const w = repo(t);
  commit(w, "main moves on before the branch is cut");
  git(w, "push", "-q", "origin", "main");
  const mainTip = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", "lw", head);

  const { code, json } = prove(w, "lw", "lw", merge);
  assert.equal(code, 0);
  assert.equal(json.proved, true);
  assert.equal(json.proofPath, "no-rebase");
  assert.equal(json.secondParent, head);
  assert.equal(json.firstParent, mainTip);
});

test("a base ref that does not resolve carries git's own cause", (t) => {
  // Real git throughout, no shim: the fetch succeeds against a live origin, so
  // the guard under test is the only one that can fire. BASE_REF is the
  // caller-facing way in, and needs no fault injection.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");

  // <merge-commit> is `head`, not a merge: this guard runs before the cat-file
  // loop, so the third argument is never reached and a real merge here would
  // only be scenery.
  const r = spawnSync("sh", [SCRIPT, head, head, head], {
    cwd: w,
    env: { ...ENV, BASE_REF: "nosuchref" },
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "no proof for a question that was never answered");
  assert.match(r.stderr, /nosuchref does not resolve/);
  // `--quiet` made this guard exit 1 with zero bytes of explanation attached.
  assert.match(r.stderr, /Needed a single revision/, "git's own diagnosis must survive to stderr");
  // Names which guard fired: the fetch above is also exit 2 with no stdout.
  assert.doesNotMatch(r.stderr, /fetch failed/, "the fetch passed — this is the guard after it");
});

test("a healthy run stays quiet — the unmuted guards add nothing to stderr", (t) => {
  const w = repo(t);
  // Build and push the merge from a SECOND clone, so `w`'s own fetch has real
  // objects to transfer: an already-up-to-date fetch would not exercise the
  // path that could go noisy.
  const other = join(w, "..", "other");
  git(w, "clone", "-q", git(w, "remote", "get-url", "origin"), other);
  git(other, "checkout", "-q", "-b", "feat");
  const head = commit(other, "feature work");
  const merge = mergeNoFf(other, head, "merge feat");
  git(other, "push", "-q", "origin", "main");
  const first = git(other, "rev-parse", `${merge}^1`);

  const { code, json, stderr } = prove(w, head, head, merge);
  assert.equal(code, 0);
  assert.equal(json.proved, true);
  // Exact, not a /fatal:/ sniff. Dropping `--quiet` from one guard and
  // `2>/dev/null` from another is only safe while both stay silent when they
  // succeed, and this script's stderr is what the merge bot reads. Anything git
  // starts printing on an ordinary run shows up here as a fourteenth line.
  assert.deepEqual(stderr.split("\n").filter(Boolean), [
    "$ git fetch --quiet origin",
    `$ git merge-base --is-ancestor ${merge} origin/main`,
    `$ git merge-base --is-ancestor ${head} origin/main`,
    "    pre  is-ancestor = true",
    `$ git merge-base --is-ancestor ${head} origin/main  # expect SUCCESS`,
    "    post is-ancestor = true (want true)",
    `    ${merge}^1 = ${first}  (2 parents)`,
    `    ${merge}^2 = ${head}`,
    `    claimed head = ${head}`,
    `$ git merge-base --is-ancestor ${first} ${head}`,
    "    no rebase (pre == post) — leg 1 dropped, headWasCurrent carries it",
    "    headWasCurrent = true (want true, both paths)",
    "prove-merge: proved=true (path=no-rebase)",
  ]);
});

test("no probe in prove-merge.sh has its status discarded by `[ ]`", () => {
  // A cheap lint for the one spelling this file uses, not for the whole class:
  // `test "$(...)"` and `x=$(...) || true` discard the status just as thoroughly
  // and this regex never sees them. What closes the class is the behavioural test
  // directly above, which is fault-agnostic; this one catches the same mistake at
  // the spelling, before anyone has to write a fixture for it.
  //
  // `die` inside a substitution can only kill the subshell, so the status has to
  // land somewhere `set -e` reads it. A bare assignment does; the word-expansion
  // slot of `[ ]` does not. This script has no legitimate `[ "$(...)" ]`: "a
  // proof must never read a failure as a leg it likes" is the reason is_ancestor
  // dies at all. Split any new one into an assignment and a test, the way every
  // is_ancestor call does.
  const offenders = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trimStart().startsWith("#"))
    .filter(([, line]) => /(^|\s)\[\s/.test(line) && line.includes("$("));
  assert.deepEqual(offenders, [], "assign the substitution to a variable first");
});

// --- #119: the payload's string fields, wrapped for uniformity.
//
// No reachability fixture here, and that is a measurement rather than an
// omission. `$secondParent` and `$firstParent` come from `git rev-parse`, which
// emits 40 hex characters and nothing else, and `$proofPath` is this script's
// own `rebase`/`no-rebase` literal. None of the three can carry a quote today.
// They go through `jstr` anyway, the same reason inflight.sh wraps `$pr`:
// uniformity against a later edit that changes where a field comes from, at no
// cost. Inventing a fixture that "proves" an unreachable vector would pin
// fiction; what is pinned instead is that wrapping them changed no byte of the
// payload, and that the library's absence is a refusal rather than a verdict.
//
// Byte-identical is exactly why the test below it cannot discriminate: measured,
// stripping all three `jstr` calls and interpolating the raw values leaves the
// whole suite green. So the unwrap vector is pinned at the SOURCE
// instead — the one place a regression here is visible without a fixture that
// does not exist.
test("wrapping the string fields left the payload byte-identical", (t) => {
  const w = repo(t);
  commit(w, "main moves on before the branch is cut");
  git(w, "push", "-q", "origin", "main");
  const mainTip = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = prove(w, head, head, merge);

  assert.equal(code, 0);
  assert.equal(json.secondParent, head, "40 hex characters, unchanged by the escaping");
  assert.equal(json.firstParent, mainTip);
  assert.equal(json.proofPath, "no-rebase", "the script's own literal, unchanged");
  assert.equal(json.proved, true);
});

// Source-level, because no payload fixture can tell the two apart. Deleting the
// escaping line also deletes its `|| die`, so this pins the guard as well.
test("the printf still reads the ESCAPED proof fields, not the raw ones", () => {
  const src = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));

  const escaped = src.filter((line) => /second_j=\$\(jstr/.test(line));
  assert.equal(escaped.length, 1, "the three proof fields are escaped in one `&&` chain");
  assert.match(escaped[0], /\|\| die|\\$/, "and that chain carries or continues to a `|| die`");

  const call = src.find((line) => line.includes('"$second_j"'));
  assert.ok(call, "printf's argument list interpolates $second_j, never $second directly");
  assert.match(call, /"\$first_j"/, "and $first_j");
  assert.match(call, /"\$path_j"/, "and $path_j");
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run — measured, /bin/sh
// (macOS bash 3.2), bash 3.2 and `bash --posix` all exit 1 with the guard
// unfired. Exit 1 out of THIS script means "the proof is a no", which the merge
// bot reads as a reason to refuse a merge. A missing file must not be able to
// say that.
test("a missing json.sh is exit 2, never the exit 1 that means `not proved`", (t) => {
  const w = repo(t);
  commit(w, "main moves on");
  git(w, "push", "-q", "origin", "main");
  git(w, "checkout", "-q", "-b", "feat");
  const pre = commit(w, "feature work");
  const merge = mergeNoFf(w, pre, "merge feat");
  git(w, "push", "-q", "origin", "main");
  const lone = mkdtempSync(join(tmpdir(), "prove-merge-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "prove-merge.sh"));

  const r = spawnSync("sh", [join(lone, "prove-merge.sh"), pre, pre, merge], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2,
    "a missing library is `the question could not be answered`. Exit 1 would report a genuinely good merge as unproved and the bot would refuse it.");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming a gate that never ran");
  assert.equal(r.stdout, "", "no payload: nothing was proved either way");
});

// --- #896: that guard's FATALITY, which neither case above reaches. Both of
// them assert what a WORKING escaper produces, so nothing here runs the
// `|| die` covering the escaper itself failing — measured, downgrading it to a
// message-preserving warning left this whole file green.
//
// The downgrade does not emit a malformed payload. `second_j`, `first_j` and
// `path_j` are assigned by one `&&` chain, so the first `jstr` that fails
// short-circuits the rest and leaves those names unset; with the guard advisory
// the payload `printf` reads one and `set -u` aborts the shell instead.
//
// Exit 1 out of THIS script is a verdict — "the proof is a no", the answer the
// merge bot reads as a reason to refuse. The fixture below is a merge that
// genuinely proves TRUE, every gate already answered `true` on stderr before
// the escaping runs, so under a bash-family `sh` the downgrade is a false
// DISPROOF: a good merge refused over a `sed` that was not on PATH.
//
// Which abort it is, though, is the shell's to choose and not this script's,
// and dash's lands on 2 — the very status a firing guard returns. This file
// spawns a bare `sh`, and `.github/workflows/ci.yml`'s `check` job runs on
// `ubuntu-latest`, where that name resolves to dash: an exit-code assertion
// therefore pins this guard on a developer's Mac and waves the mutant through
// on the runner that gates the merge, and a wording assertion pins whichever
// shell uses that wording. `first_j` is what discriminates instead — both
// shells name it, and it reaches stderr only from that nounset abort: no
// healthy run, no genuine `proved=false` and no firing of this guard puts it
// there.
//
// `jstr` escapes through a `sed`/`tr` pipeline and this script calls `sed`
// nowhere else, so shadowing `sed` breaks the escaper and nothing ahead of it.
// The `proved=` trace is echoed only once every gate has answered, so it proves
// the run cleared them all, and the shim's own line proves the escaper is what
// failed; between them no other failure can produce this signature. That trace
// is pinned verbatim by "a healthy run stays quiet", so it cannot be reworded
// out from under this assertion unseen, and no assertion here names a `die`
// message — rewording any of them, this guard's own included, leaves the pin
// standing.

/** A dir holding a `sed` shim with the given body, prepended to PATH. */
function sedShim(t, body) {
  const bin = mkdtempSync(join(tmpdir(), "prove-merge-sed-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "sed"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:${ENV.PATH ?? process.env.PATH}`;
}

/** The fixture both cases below share: a merge that really does prove true. */
function provenMerge(t) {
  const w = repo(t);
  commit(w, "main moves on before the branch is cut");
  git(w, "push", "-q", "origin", "main");
  const mainTip = git(w, "rev-parse", "main");
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");
  const merge = mergeNoFf(w, head, "merge feat");
  git(w, "push", "-q", "origin", "main");
  return { w, head, merge, mainTip };
}

test("an escaper that cannot run is exit 2, never the exit 1 that means `not proved`", (t) => {
  const { w, head, merge } = provenMerge(t);

  const r = spawnSync("sh", [SCRIPT, head, head, merge], {
    cwd: w,
    env: { ...ENV, PATH: sedShim(t, 'echo "sed: outage" >&2\nexit 1') },
    encoding: "utf8",
  });

  // Whether this fixture measured the guard at all is settled before its
  // verdict is read: an assertion that fails masks every one after it, and
  // "the shim broke something else" and "the guard is not fatal" are not
  // interchangeable diagnoses.
  assert.match(r.stderr, /sed: outage/, "the escaper ran and failed, which is the failure under test");
  assert.match(r.stderr, /proved=true \(path=no-rebase\)/,
    "every gate answered — this is the guard after them, not an earlier one the shim happened to break");

  assert.equal(r.status, 2,
    "a proof that could not be escaped is `the question could not be answered`. Exit 1 would report a merge that passed every gate as unproved, and the merge bot refuses on that answer.");
  assert.equal(r.stdout, "", "no proof may be printed for a payload that was never escaped");
  assert.doesNotMatch(r.stderr, /first_j/,
    "the guard must stop the script, not warn and leave the payload `printf` reading names the `&&` chain never assigned. The NAME, never the wording: bash says `first_j: unbound variable` at exit 1 and dash `first_j: parameter not set` at exit 2, so the exit-2 assertion above and any wording match each pass on the mutant under the shell CI actually runs.");
});

test("a shadowed `sed` that works still proves the merge — the guard refuses only a real outage", (t) => {
  // The false-positive half, and the control the case above needs: shadowing
  // `sed` on PATH is not by itself fatal to this script. Same fixture and the
  // same shadowed name, a passthrough body — so the exit 2 up there is the
  // escaper failing, not the shim's mere presence. Without this, that case
  // could be measuring a PATH it broke wholesale and still read green.
  const { w, head, merge, mainTip } = provenMerge(t);

  const r = spawnSync("sh", [SCRIPT, head, head, merge], {
    cwd: w,
    env: { ...ENV, PATH: sedShim(t, `exec "${REAL_SED}" "$@"`) },
    encoding: "utf8",
  });

  assert.equal(r.status, 0, "the merge IS proved — a working escaper must not change the verdict");
  const json = JSON.parse(r.stdout);
  assert.equal(json.proved, true);
  assert.equal(json.secondParent, head, "and the escaped fields carry the real shas, not the empty slots a failed chain leaves");
  assert.equal(json.firstParent, mainTip);
  assert.equal(json.proofPath, "no-rebase");
});

// #1039. The bounded-fetch pattern's coverage used to stop at the shared
// helper: net.sh's budget, its stalled-signal arm and its kill-tree walk are
// each pinned, and unattended-git-sweep.test.mjs pins that this script still
// sources net.sh and still reaches net_git — but nothing ever ran this
// script's OWN stalled-versus-failed wrapper. Measured on #1030's head:
// replacing `${fetch_budget}` in the stalled branch with an unbound variable,
// so `set -eu` aborts where `die` was meant to render, left this suite at its
// baseline pass count, byte-identical.
//
// One pair, the shape net.test.mjs uses for verify-sha.sh and
// inflight.test.mjs for probe 2: one real slow transport, a budget above its
// delay and a budget under it. The WORDING is the assertion target, because
// this script's `die` gives a killed fetch and a refused one the same exit 2 —
// the status alone cannot tell them apart, which is the whole reason the
// branch exists.
test("a slow but working fetch still proves the merge — the budget is not a stopwatch on success", (t) => {
  const { w, head, merge, mainTip } = provenMerge(t);
  // provenMerge's own `git push origin main` above already advanced this
  // clone's local `origin/main` past the merge, so the ancestor gate below
  // would already pass before the bounded fetch ever runs. Moving the local
  // tracking ref back to the pre-merge tip makes `proved` reachable only
  // through a fetch that genuinely lands, not through the fixture's own
  // prior push (#1039 review, finding 3).
  git(w, "update-ref", "refs/remotes/origin/main", mainTip);
  // Read back rather than rebuilt: `repo` returns the clone alone, and a
  // second spelling of the origin path is a fixture that can point the stub at
  // a repo the clone never used.
  const origin = git(w, "remote", "get-url", "origin");
  const stub = slowTransport(origin);
  git(w, "remote", "set-url", "origin", SSH_URL);
  warmStub(stub, ENV);

  const r = spawnSync("sh", [SCRIPT, head, head, merge], {
    cwd: w,
    env: { ...ENV, GIT_SSH_COMMAND: stub, FLEET_NET_TIMEOUT: "20" },
    encoding: "utf8",
    timeout: 60_000,
  });

  assert.equal(r.error, undefined, `the run did not come back: ${JSON.stringify(r)}`);
  assert.equal(r.status, 0,
    `a budget above the delay must leave the verdict alone — exit 2 here is an outage invented on a link that worked: ${JSON.stringify(r)}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.proved, true, "the refs really came back, so the proof is the one an unbounded fetch reaches");
  assert.equal(json.firstParent, mainTip,
    "and it is established from the history the slow transport actually returned, not from a stale ref");
  assert.doesNotMatch(r.stderr, /did not finish within/,
    "and nothing claims a budget elapsed, which is the wording the failure path owns");
});

test("a fetch killed by its budget refuses to prove a merge on stale refs, in this script's own words", (t) => {
  const { w, head, merge } = provenMerge(t);
  const origin = git(w, "remote", "get-url", "origin");
  const stub = slowTransport(origin);
  git(w, "remote", "set-url", "origin", SSH_URL);

  const r = spawnSync("sh", [SCRIPT, head, head, merge], {
    cwd: w,
    env: { ...ENV, GIT_SSH_COMMAND: stub, FLEET_NET_TIMEOUT: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });

  assert.equal(r.error, undefined, `the run did not come back: ${JSON.stringify(r)}`);
  assert.equal(r.status, 2,
    "`the question could not be answered`, never the exit 1 that means `not proved` — the merge bot refuses on that answer");
  assert.match(
    r.stderr,
    /prove-merge: git fetch did not finish within 1s and was killed — refusing to prove a merge on stale refs/,
    "this script's own decline, rendered, with the budget named in it: collapsing the stalled arm into the generic `fetch failed` decline keeps the same exit 2, so only this wording — not the status check — catches it",
  );
  assert.doesNotMatch(r.stderr, /fetch failed — refusing to prove a merge/,
    "and not the refused-fetch wording, which names a cause this run never observed");
  assert.equal(r.stdout, "", "no proof may be printed off refs the script could not refresh");
});
