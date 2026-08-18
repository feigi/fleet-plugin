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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // Three cases below assert on git's OWN diagnostic text, and one of those
  // strings is gettext-translatable: rev-parse's "Needed a single revision" is
  // `die(_("..."))` in builtin/rev-parse.c and git ships a live German msgstr
  // for it. cat-file's "Not a valid object name" and object-name.c's
  // "dereferences to %s type" are unwrapped today — pinning the locale is what
  // stops all three depending on which git build CI happens to run.
  LANG: "C",
  LC_ALL: "C",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

// Absolute path to the real git, for the one test that shadows `git` on PATH.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

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
  // <merge-commit> is `head`, not a merge: this guard dies before the script
  // ever reads the third argument, so a real merge here would only be scenery.
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

test("a base ref that does not resolve carries git's own cause", (t) => {
  // Real git throughout, no shim: the fetch succeeds against a live origin, so
  // the guard under test is the only one that can fire. BASE_REF is the
  // caller-facing way in, and needs no fault injection.
  const w = repo(t);
  git(w, "checkout", "-q", "-b", "feat");
  const head = commit(w, "feature work");

  // <merge-commit> is `head`, not a merge: this guard dies before the script
  // ever reads the third argument, so a real merge here would only be scenery.
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
