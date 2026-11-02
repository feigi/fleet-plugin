// Regression gate for unique-in-upstream.mjs, the shared "what does HEAD hold
// that the upstream lacks" verdict. Zero deps: `node --test tests/unique-in-upstream.test.mjs`.
//
// Every case runs against a REAL repository: a bare origin, a clone, and a
// linked worktree on its own branch, with the upstream the remote-tracking ref
// the merge bot reads. Each shape is made the way it happens in a run - a
// commit made, a branch rebased and force-pushed from a second clone - not by
// stubbing the read the verdict is derived from. The finisher's own use of the
// same helper is pinned in finisher-audit.test.mjs.
//
// The verdict is asked through the CLI for the exit codes and the JSON shape,
// and through the exported function for the error it throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";
import { UniqueReadError, uniqueIn } from "../plugin/scripts/unique-in-upstream.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/unique-in-upstream.mjs", import.meta.url));

// Cut the developer's ~/.gitconfig and any ambient GIT_DIR out of what these
// fixtures see.
const ENV = {
  ...process.env,
  LC_ALL: "C",
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
const commitText = (cwd, file, text, msg) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};
const commit = (cwd, msg, file = `${msg}.txt`) => commitText(cwd, file, `${msg}\n`, msg);

// A worktree on a pushed branch, one commit past origin/main, with `w` the
// clone it hangs off and `origin/feat` fetched into it.
function fixture() {
  const root = realpathSync(tempDir("unique-in-upstream-"));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "ignore" });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  const wt = join(w, ".worktrees", "feat");
  git(w, "worktree", "add", "-q", wt, "-b", "feat", "origin/main");
  const pushed = commit(wt, "work");
  git(wt, "push", "-q", "-u", "origin", "feat");
  return { root, origin, w, wt, pushed, upstream: "origin/feat" };
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

// Run the CLI. `env` overrides the scrubbed baseline.
function ask(f, args = ["--worktree", f.wt, "--upstream", f.upstream], { env = {}, cwd = f.w } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...ENV, ...env }, encoding: "utf8" });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // a usage refusal prints no verdict
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

const cherryLines = (r) => r.out.listing.split("\n").filter((l) => l !== "");
const treeOf = (f, rev) => git(f.w, "rev-parse", `${rev}^{tree}`);

// --- The patch test is not enough alone -------------------------------------------------
// A file of two identical blocks, each with a line of its own: the same change to either
// block has the same lines around it, so it is one patch by id.
const twoBlocks = (first, second) => ["a", "b", "c", first, "e", "f", "g", "a", "b", "c", second, "e", "f", "g", ""].join("\n");

// The remote branch and the worktree's own commit are siblings on one base that holds
// `blocks.txt`. The remote branch is pushed and fetched; the commit is not pushed.
function siblings(remoteText, ownText) {
  const f = fixture();
  const base = commitText(f.w, "blocks.txt", twoBlocks("TARGET", "TARGET"), "blocks");
  git(f.w, "push", "-q", "origin", "main");
  git(f.wt, "reset", "-q", "--hard", base);
  f.remote = commitText(f.wt, "blocks.txt", remoteText, "remote");
  git(f.wt, "push", "-q", "--force", "origin", "feat");
  git(f.wt, "reset", "-q", "--hard", base);
  f.own = commitText(f.wt, "blocks.txt", ownText, "own");
  git(f.w, "fetch", "-q", "origin");
  return f;
}

test("unique: the remote's change to one block and an unpushed change to the other are one patch by id and two contents", () => {
  const f = siblings(twoBlocks("NEW", "TARGET"), twoBlocks("TARGET", "NEW"));
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.out), ["worktree", "upstream", "listing", "merges", "content", "unique"]);
  assert.equal(r.out.worktree, f.wt);
  assert.equal(r.out.upstream, "origin/feat");
  assert.deepEqual(cherryLines(r), [`- ${f.own}`], "the patch test reads the commit as the remote's own");
  assert.equal(r.out.merges, 0);
  assert.equal(r.out.unique, true);
  const { tree, conflict, paths } = r.out.content;
  assert.equal(conflict, false);
  assert.deepEqual(paths, ["blocks.txt"]);
  assert.equal(git(f.w, "show", `${tree}:blocks.txt`), twoBlocks("NEW", "NEW").trim(), "the tree is what merging the worktree into the upstream makes");
});

test("unique: a commit that differs from a remote commit by whitespace alone conflicts with it", () => {
  const f = siblings(twoBlocks("NEW", "TARGET"), twoBlocks("  NEW", "TARGET"));
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(cherryLines(r), [`- ${f.own}`], "the patch test reads the commit as the remote's own");
  assert.equal(r.out.unique, true);
  assert.equal(r.out.content.conflict, true);
  assert.match(r.out.content.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(r.out.content.paths, ["blocks.txt"]);
});

test("unique: two edits to the same line conflict, and a conflict is a finding rather than a failed read", () => {
  const f = siblings(twoBlocks("REMOTE", "TARGET"), twoBlocks("OWN", "TARGET"));
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out.listing, /^\+ /m);
  assert.equal(r.out.unique, true);
  assert.equal(r.out.content.conflict, true);
});

test("unique: an unpushed commit the remote does not carry is a `+` line", () => {
  const f = fixture();
  commit(f.wt, "unpushed");
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out.listing, /^\+ [0-9a-f]{40}$/m);
  assert.equal(r.out.unique, true);
  assert.deepEqual(r.out.content.paths, ["unpushed.txt"]);
});

// A merge commit past the upstream that adds a file of its own, both of whose
// parents' patches the upstream already holds: `git cherry` lists nothing but `-`
// lines, and the merge's own file is invisible to it.
test("unique: a merge commit with a file of its own is unique even when every parent patch is upstream", () => {
  const f = fixture();
  git(f.wt, "checkout", "-q", "-b", "side", "origin/main");
  commit(f.wt, "s");
  git(f.wt, "checkout", "-q", "feat");
  git(f.wt, "cherry-pick", "side");
  git(f.wt, "push", "-q", "origin", "feat");
  git(f.w, "fetch", "-q", "origin");
  git(f.wt, "reset", "-q", "--hard", f.pushed);
  git(f.wt, "merge", "-q", "--no-ff", "--no-commit", "side");
  writeFileSync(join(f.wt, "merged.txt"), "evil\n");
  git(f.wt, "add", "merged.txt");
  git(f.wt, "commit", "-q", "-m", "merge side");
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.merges, 1);
  assert.equal(r.out.unique, true);
});

// --- What it must ACCEPT --------------------------------------------------------------
test("not unique: a worktree at the upstream", () => {
  const f = fixture();
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.unique, false);
  assert.equal(r.out.merges, 0);
  assert.equal(r.out.listing, "");
  assert.deepEqual(r.out.content, { tree: treeOf(f, f.upstream), conflict: false, paths: [] });
});

test("not unique: a worktree behind the upstream", () => {
  const f = fixture();
  const o = otherClone(f);
  commit(o, "remote-ahead");
  git(o, "push", "-q", "origin", "feat");
  git(f.w, "fetch", "-q", "origin");
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.unique, false);
  assert.deepEqual(r.out.content, { tree: treeOf(f, f.upstream), conflict: false, paths: [] });
});

// The owned worktree holds `late`, pushed; the branch is then rebased onto an
// advanced main and force-pushed from the other clone.
function supersededByRebase() {
  const f = fixture();
  f.late = commit(f.wt, "late");
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

test("not unique: a worktree that has not fetched since the remote rebase reads an empty cherry", () => {
  const f = supersededByRebase();
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.listing, "");
  assert.equal(r.out.unique, false);
});

test("not unique: a worktree that has fetched the remote rebase reads a `-` per rebased commit", () => {
  const f = supersededByRebase();
  git(f.w, "fetch", "-q", "origin");
  assert.equal(git(f.w, "rev-parse", f.upstream), f.rebased, "fixture: the upstream is the rebased head");
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.merges, 0);
  const listing = cherryLines(r);
  assert.equal(listing.length, 2);
  for (const l of listing) assert.match(l, /^- [0-9a-f]{40}$/);
  assert.equal(r.out.unique, false);
  assert.deepEqual(r.out.content, { tree: treeOf(f, f.rebased), conflict: false, paths: [] });
});

test("not unique: a commit that differs from the upstream's only in its message", () => {
  const f = fixture();
  git(f.wt, "commit", "-q", "--amend", "-m", "work, reworded");
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(cherryLines(r).map((l) => l[0]), ["-"]);
  assert.equal(r.out.unique, false);
});

// --- Both tests count ---------------------------------------------------------------
test("unique: a revert of a change the rebased upstream carries has an empty tree comparison and a `+` line", () => {
  const f = supersededByRebase();
  git(f.w, "fetch", "-q", "origin");
  // The worktree is still at the pre-rebase head, and takes `late` back out.
  git(f.wt, "revert", "--no-commit", "HEAD");
  git(f.wt, "commit", "-q", "-m", "undo late");
  const undo = git(f.wt, "rev-parse", "HEAD");
  const r = ask(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out.listing, new RegExp(`^\\+ ${undo}$`, "m"));
  assert.deepEqual(r.out.content, { tree: treeOf(f, f.rebased), conflict: false, paths: [] }, "the tree comparison alone passes");
  assert.equal(r.out.unique, true);
});

// --- A read that failed is never a clean answer ----------------------------------------
test("exit 2: an upstream the object store lacks is a failed read naming the cherry call", () => {
  const f = fixture();
  const r = ask(f, ["--worktree", f.wt, "--upstream", "origin/never-fetched"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.unique, undefined);
  assert.match(r.out.error, /^cherry: git cherry origin\/never-fetched HEAD failed: /);
  assert.deepEqual(Object.keys(r.out), ["worktree", "upstream", "error"]);
  assert.match(r.stderr, /^\nunique-in-upstream: cherry: /);
});

test("exit 2: a worktree re-rooted onto an unrelated history has nothing to merge, whatever its patches say", () => {
  const f = fixture();
  // The same two patches on a new root: the patch test reads every one as upstream's own.
  git(f.wt, "checkout", "-q", "--orphan", "rerooted");
  git(f.wt, "rm", "-rfq", ".");
  commitText(f.wt, "root.txt", "root\n", "root, again");
  commitText(f.wt, "work.txt", "work\n", "work, again");
  const listing = git(f.wt, "cherry", f.upstream, "HEAD").split("\n");
  assert.equal(listing.length, 2, "fixture: every commit of the new history is listed");
  assert.ok(listing.every((l) => l.startsWith("- ")), "fixture: the patch test reads the range clean");
  const r = ask(f);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.unique, undefined);
  assert.match(r.out.error, /^merge-tree: git merge-tree --write-tree origin\/feat HEAD failed: .*unrelated histories/);
});

// A git on PATH that answers a `merge-tree` the way `body` says, and everything
// else for real.
function mergeTreeStub(f, body) {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { env: ENV, encoding: "utf8" }).trim();
  writeExecStub(
    join(bin, "git"),
    `#!/bin/sh
real="${real}"
case " $* " in
*" merge-tree "*)
${body}
  ;;
esac
exec "$real" "$@"
`,
  );
  return { PATH: `${bin}:${ENV.PATH}` };
}

test("exit 2: a merge-tree that exits 1 with no tree id is a failed read, never a conflict", () => {
  const f = fixture();
  const env = mergeTreeStub(f, `  echo "merge-tree: x - not something we can merge" >&2; exit 1`);
  const r = ask(f, undefined, { env });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.unique, undefined);
  assert.equal(r.out.error, "merge-tree: git merge-tree --write-tree origin/feat HEAD failed: merge-tree: x - not something we can merge");
});

test("exit 2: a merge-tree killed by a signal is a failed read", () => {
  const f = fixture();
  const r = ask(f, undefined, { env: mergeTreeStub(f, "  kill -KILL $$") });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.out.error, /^merge-tree: git merge-tree /);
});

test("exit 2: a merge-tree that prints a tree id and then exits 128 is a failed read, never a conflict", () => {
  const f = fixture();
  const r = ask(f, undefined, { env: mergeTreeStub(f, `  "$real" "$@"; exit 128`) });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.error, "merge-tree: git merge-tree --write-tree origin/feat HEAD failed: exit 128");
});

test("exit 2: a merge-tree whose first line is a tree id with characters after it is a failed read", () => {
  for (const line of ["0123456789abcdef0123456789abcdef01234567a", "0123456789abcdef0123456789abcdef01234567 extra"]) {
    const f = fixture();
    const r = ask(f, undefined, { env: mergeTreeStub(f, `  echo "${line}"; exit 0`) });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.out.error, "merge-tree: git merge-tree --write-tree origin/feat HEAD failed: no tree id on stdout");
  }
});

test("exit 2: a worktree that is not a repository is a failed read", () => {
  const f = fixture();
  const r = ask(f, ["--worktree", join(f.root, "nowhere"), "--upstream", f.upstream]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.unique, undefined);
  assert.match(r.out.error, /^cherry: git cherry origin\/feat HEAD failed: /);
});

// --- The exported function -----------------------------------------------------------
test("uniqueIn() returns the verdict the CLI prints, and throws UniqueReadError for a failed read", () => {
  const f = siblings(twoBlocks("NEW", "TARGET"), twoBlocks("TARGET", "NEW"));
  const verdict = uniqueIn(f.wt, f.upstream, { env: ENV });
  assert.equal(verdict.unique, true);
  assert.deepEqual(verdict.content.paths, ["blocks.txt"]);
  assert.deepEqual(verdict, (({ worktree, upstream, ...rest }) => rest)(ask(f).out));
  assert.throws(() => uniqueIn(f.wt, "origin/never-fetched", { env: ENV }), (e) => e instanceof UniqueReadError && /^cherry: /.test(e.message));
});

test("the read leaves HEAD, every ref and the worktree as they were, a conflict's read included", () => {
  const f = siblings(twoBlocks("NEW", "TARGET"), twoBlocks("  NEW", "TARGET"));
  const state = () => [git(f.wt, "rev-parse", "HEAD"), git(f.wt, "for-each-ref"), git(f.wt, "status", "--porcelain", "-uall")].join("\n--\n");
  const before = state();
  const r = ask(f);
  assert.equal(r.out.content.conflict, true, "the read that wrote the most");
  assert.equal(state(), before);
});

// --- Invocation ----------------------------------------------------------------------
test("an inherited GIT_DIR naming another repository cannot retarget the read", () => {
  const f = fixture();
  const other = fixture();
  commit(f.wt, "unpushed");
  const r = ask(f, undefined, { env: { GIT_DIR: join(other.w, ".git"), GIT_WORK_TREE: other.w } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.unique, true);
  assert.deepEqual(r.out.content.paths, ["unpushed.txt"]);
});

test("exit 2: a missing flag, an unknown flag or a stray argument is refused with no verdict", () => {
  const f = fixture();
  const ok = ["--worktree", f.wt, "--upstream", f.upstream];
  for (const args of [[], ["--upstream", f.upstream], ["--worktree", f.wt], [...ok, "--bogus"], [...ok, "stray"], ["--worktree", f.wt, "--upstream"]]) {
    const r = ask(f, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.out, null, `${args.join(" ")} printed a verdict`);
    assert.match(r.stderr, /^\nunique-in-upstream: /);
  }
});
