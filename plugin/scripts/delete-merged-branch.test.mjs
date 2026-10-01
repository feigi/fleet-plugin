// Regression gate for delete-merged-branch.sh — the merge bot's own branch
// deletion (#2196), replacing the repo setting "Automatically delete head
// branches" the fleet used to lean on.
//
// Zero deps: `node --test plugin/scripts/delete-merged-branch.test.mjs`.
//
// Every fixture is a REAL bare origin and a real clone; only `gh` is stubbed.
// The assertion that matters is always read off the bare origin itself
// (`ls-remote`), never off the script's exit status or payload: #2196's trap
// is a merge step that reports success while the branch survives underneath
// it, so a test that only checked "exit 0" or "the delete was issued" would
// pass on exactly the broken implementation the ticket describes.
//
// The headline case puts the branch where every fleet-claimed ticket's branch
// lives — checked out in a linked worktree at `.worktrees/<issue>-<slug>` —
// which is where `gh pr merge --delete-branch`'s local cleanup dies with
// `fatal: 'main' is already used by worktree`. It then runs reap.sh over the
// result, so the whole post-merge chain is proved to leave no branch behind,
// remote or local.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./delete-merged-branch.sh", import.meta.url));
const REAP = fileURLToPath(new URL("./reap.sh", import.meta.url));
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// Pinned identity, no developer config, no inherited repo pointers.
const ENV = {
  ...process.env,
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

const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + clone with one commit on main, `.worktrees/` ignored as §2.5 requires. */
function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delete-merged-branch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "pipe" });
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n.fleet/\n");
  git(w, "add", ".gitignore");
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return { root, origin, w };
}

/** Whether refs/heads/<name> exists on the bare origin — the ground truth. */
const onOrigin = (origin, name) =>
  spawnSync("git", ["ls-remote", "--exit-code", "--heads", origin, `refs/heads/${name}`], { env: ENV }).status === 0;
const originTip = (origin, name) => git(origin, "rev-parse", `refs/heads/${name}`);

/**
 * A fleet-claimed ticket, merged: branch `name` checked out in the linked
 * worktree `.worktrees/<wtName>`, pushed, merged `--no-ff` into main on origin
 * the way `gh pr merge --merge` does, and the remote branch LEFT IN PLACE — the
 * state a repo with auto-delete off is in after the merge. Returns the head
 * GitHub would report as `headRefOid`, and the worktree path.
 */
function mergedInWorktree(w, name, wtName) {
  const wt = join(w, ".worktrees", wtName);
  git(w, "worktree", "add", "-q", wt, "-b", name, "main");
  const oid = commit(wt, `work on ${name}`);
  git(wt, "push", "-q", "-u", "origin", name);
  git(w, "merge", "-q", "--no-ff", "-m", `Merge ${name}`, name);
  git(w, "push", "-q", "origin", "main");
  return { oid, wt };
}

/**
 * A `gh` stub answering the one `pr view` call the script makes, from env
 * vars. Returns a call log reader and an env builder.
 */
function ghStub(t, root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  "pr view "*" --json state,isCrossRepository,headRefName,headRefOid,baseRefName --jq "*)
    [ "\${GH_FAIL:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit 1; }
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${PR_STATE:-MERGED}" "\${PR_CROSS:-false}" "\$PR_HEAD" "\$PR_OID" "\${PR_BASE:-main}"
    ;;
  *) echo "gh: unstubbed call: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    env: (extra = {}) => ({ ...ENV, PATH: `${bin}:${ENV.PATH}`, ...extra }),
  };
}

function run(cwd, args, env) {
  const r = spawnSync("sh", [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("a merged branch checked out in a .worktrees/<issue>-<slug> worktree is deleted from origin, and reap.sh then reaps it locally", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/2196-delete-branch";
  const { oid, wt } = mergedInWorktree(w, branch, "2196-delete-branch");
  assert.ok(onOrigin(origin, branch), "fixture: the branch must still be on origin after the merge");
  const gh = ghStub(t, root);

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 7, branch, deleted: true });
  assert.equal(onOrigin(origin, branch), false, "the branch must actually be gone from origin, not merely reported deleted");
  // Remote-only: the worktree and its local branch are untouched, so a held
  // worktree can neither make this step fail nor lose anything to it.
  assert.ok(existsSync(wt), "the worktree must survive this step — it is reap.sh's to remove");
  assert.equal(git(wt, "rev-parse", "HEAD"), oid);
  assert.doesNotMatch(r.stderr, /already used by worktree/);

  // The rest of the chain: the controller reaps on the merge bot's report.
  const reap = spawnSync("sh", [REAP, "--apply"], { cwd: w, env: ENV, encoding: "utf8" });
  assert.equal(reap.status, 0, reap.stderr);
  assert.deepEqual(JSON.parse(reap.stdout).reaped, [branch]);
  assert.equal(
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: w, env: ENV }).status,
    1,
    "the local branch must be gone once reap.sh has run",
  );
  assert.equal(existsSync(wt), false, "the worktree must be gone once reap.sh has run");
});

test("a merged branch that was never checked out locally is deleted the same way — a hand-opened PR or the controller's own chore PR", (t) => {
  const { root, origin, w } = repo(t);
  // Pushed from a second clone, so this checkout has no worktree and no local
  // branch for it at all. The quote is legal in a refname and must survive
  // into the JSON payload escaped.
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", origin, other], { env: ENV });
  const branch = 'chore/run-artifacts-"x"';
  git(other, "switch", "-q", "-c", branch);
  const oid = commit(other, "artifacts");
  git(other, "push", "-q", "origin", branch);
  git(other, "switch", "-q", "main");
  git(other, "merge", "-q", "--no-ff", "-m", "merge", branch);
  git(other, "push", "-q", "origin", "main");
  const gh = ghStub(t, root);

  const r = run(w, ["8"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 8, branch, deleted: true });
  assert.equal(onOrigin(origin, branch), false);
});

// What this change must ACCEPT: a repo that still has auto-delete on (GitHub
// removed the branch at the merge instant) must not turn every merge into a
// failure report.
test("a branch already gone from origin is success, and no delete is pushed", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "feat/9-gone";
  const { oid } = mergedInWorktree(w, branch, "9-gone");
  git(w, "push", "-q", "origin", "--delete", branch);
  const gh = ghStub(t, root);

  const r = run(w, ["9"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 9, branch, deleted: false, alreadyGone: true });
  assert.doesNotMatch(r.stderr, /git push/);
  assert.equal(onOrigin(origin, branch), false);
});

test("a branch whose tip moved after the merge is NOT deleted — the lease refuses, exit 1", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/10-moved";
  const { oid, wt } = mergedInWorktree(w, branch, "10-moved");
  const later = commit(wt, "pushed after the merge");
  git(wt, "push", "-q", "origin", branch);
  const gh = ghStub(t, root);

  const r = run(w, ["10"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.deleted, false);
  assert.equal(r.json.tip, later);
  assert.match(r.json.reason, /a push landed after the merge/);
  assert.equal(originTip(origin, branch), later, "commits main never received must survive");
});

// The trap #2196 names: the delete is issued, reports success, and the
// branch is still there. A `git` that swallows `push` at exit 0 is exactly
// that, and only the read-back can catch it.
test("a delete that exits 0 but leaves the branch on origin is a failure, never a success", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/11-silent";
  const { oid } = mergedInWorktree(w, branch, "11-silent");
  const gh = ghStub(t, root);
  writeFileSync(
    join(gh.bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = push ] && exit 0; done\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );

  const r = run(w, ["11"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.deleted, false);
  assert.match(r.json.reason, /exited 0 and the branch is still on origin/);
  assert.ok(onOrigin(origin, branch));
});

test("a delete the remote refuses is exit 1 with the branch still reported", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/12-refused";
  const { oid } = mergedInWorktree(w, branch, "12-refused");
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'deletes are protected' >&2\nexit 1\n", { mode: 0o755 });
  const gh = ghStub(t, root);

  const r = run(w, ["12"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.tip, oid);
  assert.match(r.json.reason, /git push --delete exited [1-9]/);
  assert.ok(onOrigin(origin, branch));
});

test("a PR that is not merged is refused before any git call, branch untouched", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/13-open";
  const { oid } = mergedInWorktree(w, branch, "13-open");
  const gh = ghStub(t, root);

  for (const state of ["OPEN", "CLOSED"]) {
    const r = run(w, ["13"], gh.env({ PR_STATE: state, PR_HEAD: branch, PR_OID: oid }));
    assert.equal(r.code, 2, state);
    assert.match(r.stderr, new RegExp(`not merged \\(state=${state}\\)`));
    assert.doesNotMatch(r.stderr, /ls-remote|git push/);
    assert.equal(r.json, null);
  }
  assert.ok(onOrigin(origin, branch));
});

test("a fork PR is skipped — a same-named branch on our origin is not its head", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/14-fork";
  const { oid } = mergedInWorktree(w, branch, "14-fork");
  const gh = ghStub(t, root);

  const r = run(w, ["14"], gh.env({ PR_CROSS: "true", PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 14, branch, deleted: false, skipped: "cross-repository" });
  assert.ok(onOrigin(origin, branch));
});

test("a head that names the base branch is refused, base untouched", (t) => {
  const { root, origin, w } = repo(t);
  const gh = ghStub(t, root);
  const main = originTip(origin, "main");

  const r = run(w, ["15"], gh.env({ PR_HEAD: "main", PR_OID: main }));

  assert.equal(r.code, 2);
  assert.match(r.stderr, /is its base branch 'main'/);
  assert.equal(originTip(origin, "main"), main);
});

test("usage errors refuse before calling gh", (t) => {
  const { root, w } = repo(t);
  const gh = ghStub(t, root);
  for (const args of [[], ["abc"], ["007"], ["01"], ["1", "2"]]) {
    const r = run(w, args, gh.env());
    assert.equal(r.code, 2, JSON.stringify(args));
  }
  assert.deepEqual(gh.calls(), []);
});

test("a failed gh read is exit 2, not a verdict", (t) => {
  const { root, w } = repo(t);
  const gh = ghStub(t, root);
  const r = run(w, ["16"], gh.env({ GH_FAIL: "1" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /gh pr view 16 failed/);
  assert.equal(r.json, null);
});

test("an unreachable origin is exit 2, never read as an already-gone branch", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/17-unreachable";
  const { oid } = mergedInWorktree(w, branch, "17-unreachable");
  git(w, "remote", "set-url", "origin", join(root, "nowhere.git"));
  const gh = ghStub(t, root);

  const r = run(w, ["17"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 2);
  assert.match(r.stderr, /git ls-remote failed/);
  assert.equal(r.json, null);
  assert.ok(onOrigin(origin, branch));
});
