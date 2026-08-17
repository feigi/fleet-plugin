// Regression gate for verify-sha.sh, the check that says whether a member's
// reported SHA is really on the branch it claims. Zero deps:
// `node --test skills/fleet/scripts/verify-sha.test.mjs`.
//
// A shell script that reasons about git history can only be tested against real
// git history, so every case below builds a throwaway origin+clone in a temp dir
// and runs the script for real.
//
// The load-bearing case is `a merge-base that fails rather than answers is exit
// 2, never reachable:false` (#266). Every non-zero status used to collapse into
// the definite verdict reachable:false at exit 1, so "the repository could not
// answer" and "the SHA is not on the branch" — the one distinction this script
// exists to make — were indistinguishable to the controller. Its two neighbours
// here, the reachable and the genuinely-not-reachable cases, are what keep the
// guard from over-firing: exit 1 has to survive as a real answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./verify-sha.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like. The
// GIT_* redirects would point the fixtures out of their own temp dirs.
const ENV = {
  ...process.env,
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

// Absolute path to the real git, for the one test that shadows `git` on PATH.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Empty commit on the current branch; returns its sha. */
const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "verify-sha-"));
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

function verify(cwd, branch, sha, env = ENV) {
  const r = spawnSync("sh", [SCRIPT, branch, sha], { cwd, env, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("a sha on the branch is reachable — exit 0", (t) => {
  const w = repo(t);
  const head = commit(w, "work that really landed");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = verify(w, "main", head);
  assert.equal(code, 0);
  assert.equal(json.reachable, true);
  assert.equal(json.sha, head);
  assert.equal(json.tip, head);
});

test("a sha on a stray branch is not reachable — exit 1, the answer the script exists to give", (t) => {
  const w = repo(t);
  // The nested-worktree scenario from the script's header: a real commit in this
  // repository that never made it onto the branch the member claims.
  git(w, "checkout", "-q", "-b", "stray");
  const stray = commit(w, "committed somewhere else");
  git(w, "checkout", "-q", "main");
  const tip = commit(w, "main moves on without it");
  git(w, "push", "-q", "origin", "main");

  const { code, json, stderr } = verify(w, "main", stray);
  assert.equal(code, 1, "a real negative stays exit 1 — it is an answer, not a failure");
  assert.equal(json.reachable, false);
  assert.equal(json.tip, tip);
  // Dropping `2>/dev/null` from the probe must not start leaking git noise onto
  // the ordinary negative path: git says nothing at all when the answer is "no".
  assert.doesNotMatch(stderr, /error:/, "a plain negative answer prints no git error");
});

test("a merge-base that fails rather than answers is exit 2, never reachable:false", (t) => {
  // The #266 defect: `git merge-base --is-ancestor` exits 128 when it cannot walk
  // the history — a corrupt or unreadable object — and every non-zero status used
  // to collapse into the definite verdict reachable:false at exit 1. Shim only
  // `merge-base`; everything else is real git, so the fetch and both preconditions
  // pass exactly as they do in the field and none of the existing exit-2 guards
  // fires. This is the same collapse #17 fixed in the sibling prove-merge.sh.
  const w = repo(t);
  const head = commit(w, "work that really landed");
  git(w, "push", "-q", "origin", "main");

  const bin = mkdtempSync(join(tmpdir(), "verify-sha-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Ask the shell where git is, rather than deriving it from `--exec-path`: that
  // answer is `<prefix>/libexec/git-core` on macOS but `/usr/lib/git-core` on
  // Debian, where a `libexec` rewrite matches nothing and the shim execs a
  // DIRECTORY — the fetch then fails first and this test measures the wrong
  // failure. Resolved out here, where PATH is still the real one, and quoted at
  // the exec: a git under a path with a space word-splits otherwise, and the
  // fetch then dies first — which still satisfies the exit-2 and null-json
  // assertions below, so only the stderr match would catch it.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n[ "$1" = merge-base ] && { echo "error: could not parse commit deadbeef" >&2; exit 128; }\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );

  const { code, json, stderr } = verify(w, "main", head, {
    ...ENV,
    PATH: `${bin}:${ENV.PATH ?? process.env.PATH}`,
  });
  assert.equal(json, null, "no verdict may be printed for a question that was never answered");
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 1 that means definitely-not-reachable");
  assert.match(stderr, /cannot tell reachable from unanswerable/);
  // The cause has to reach the operator, which is why the probe drops 2>/dev/null.
  assert.match(stderr, /could not parse commit/, "git's own diagnosis must survive to stderr");
});

test("a sha that is not a commit in this repository is exit 2, not a negative verdict", (t) => {
  // repo(t)'s root commit is enough: the 40-zero sha dies at the `cat-file -e`
  // guard before merge-base runs, so where the tip sits is unobservable here.
  const w = repo(t);
  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /is not a commit object in this repository/);
});

// No git fixture: the argc guard fires before the script runs any git at all,
// so the cwd never has to be a repository.
test("a wrong argument count is exit 2", () => {
  const r = spawnSync("sh", [SCRIPT, "main"], { cwd: tmpdir(), env: ENV, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: verify-sha\.sh/);
});
