// Regression gate for reap.sh, the merge probe that authorizes deleting a
// [gone] branch. Zero deps: `node --test skills/fleet/scripts/reap.test.mjs`.
//
// The load-bearing case is the failed-probe one: a `git cherry` that dies
// (issue #264) must KEEP the branch, never reap it. `cmd | grep -q` takes
// grep's exit status, never cmd's, so a dead cherry read as "nothing
// unmerged" and `--apply` force-deleted a branch whose commits existed
// nowhere else, at exit 0. The two control cases pin the other direction —
// a fix that keeps everything is as broken as one that deletes everything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./reap.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like.
const ENV = {
  ...process.env,
  // reap.sh reads BASE_REF and defaults to origin/main; the fleet harness is
  // exactly the caller that would have it set, and inheriting it here would
  // point every fixture at local `main` instead.
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

// Absolute path to the real git, for the one test that shadows `git` on PATH.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Empty commit on the current branch; returns its sha. */
const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t, dir = "w") {
  // realpathSync: macOS resolves /var through /private, so a path built from
  // the raw mkdtemp result would never string-equal what git itself reports
  // in `worktree list --porcelain` (git canonicalises). Resolved once here,
  // before any worktree path is derived from it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reap-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, dir);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

/**
 * Like `mergedGoneBranch`, but the commit lands in a LINKED worktree under
 * `.worktrees/` instead of the main checkout — reap.sh's worktree-removal
 * path had no fixture at all before this file (a dry run and `--apply` could
 * each mispredict the other and nothing here would notice). Returns the
 * worktree's absolute path.
 */
function mergedGoneBranchWithWorktree(w, name, msg) {
  const wt = join(w, ".worktrees", name);
  git(w, "worktree", "add", "-q", wt, "-b", name, "main");
  commit(wt, msg);
  git(wt, "push", "-q", "-u", "origin", name);
  git(w, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
  git(w, "push", "-q", "origin", "main");
  git(w, "push", "-q", "origin", "--delete", name);
  git(w, "fetch", "-q", "--prune", "origin");
  return wt;
}

/**
 * Branch `name` off main, merged back into main with a real merge commit,
 * then given an upstream and dropped on the remote so `%(upstream:track)`
 * reads `[gone]` — the exact state reap.sh's for-each-ref filter selects.
 * git cherry sees no unique commits: the merge already carries them.
 */
function mergedGoneBranch(w, name, msg) {
  git(w, "checkout", "-q", "-b", name, "main");
  commit(w, msg);
  git(w, "push", "-q", "-u", "origin", name);
  git(w, "checkout", "-q", "main");
  git(w, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
  git(w, "push", "-q", "origin", "main");
  git(w, "push", "-q", "origin", "--delete", name);
  git(w, "fetch", "-q", "--prune", "origin");
}

/**
 * Branch `name` off main with one commit, never merged, given an upstream
 * and then dropped on the remote — `[gone]`, but its commit exists nowhere
 * else. Returns the commit's sha.
 */
function unmergedGoneBranch(w, name, msg) {
  git(w, "checkout", "-q", "-b", name, "main");
  const sha = commit(w, msg);
  git(w, "push", "-q", "-u", "origin", name);
  git(w, "checkout", "-q", "main");
  git(w, "push", "-q", "origin", "--delete", name);
  git(w, "fetch", "-q", "--prune", "origin");
  return sha;
}

/**
 * A PATH dir whose `git` fails only `cherry`, matching the ticket's real repro:
 * multi-line stderr, exit 128 (one unreadable loose object suffices in the
 * wild). Everything else execs the real git, unshimmed.
 */
function cherryShim(t) {
  const bin = mkdtempSync(join(tmpdir(), "reap-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = cherry ]; then\n` +
      `  echo "error: unable to open loose object deadbeefcafe: Permission denied" >&2\n` +
      `  echo "fatal: revision walk setup failed" >&2\n` +
      `  exit 128\n` +
      `fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

function runReap(cwd, args, envOverrides = {}) {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    cwd,
    env: { ...ENV, ...envOverrides },
    encoding: "utf8",
  });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

function branchExists(w, name) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: w, env: ENV }).status === 0;
}

test("an uncorrupted repo still reaps a genuinely merged [gone] branch", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /KEEP/);
  assert.equal(branchExists(w, "feature/merged"), false, "a genuinely merged branch must still be deleted");
});

test("an uncorrupted repo keeps an unmerged [gone] branch for unmerged commits", (t) => {
  const w = repo(t);
  unmergedGoneBranch(w, "feature/unmerged", "solo work");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/unmerged");
  assert.equal(json.kept[0].reason, "unmerged commits");
  assert.match(stderr, /KEEP feature\/unmerged — unmerged commits/);
  assert.equal(branchExists(w, "feature/unmerged"), true, "unmerged commits keep the branch alive");
});

test("a git cherry that dies is KEPT, never reaped — an unanswerable probe authorizes nothing (#264)", (t) => {
  const w = repo(t);
  const sha = unmergedGoneBranch(w, "feature/onlyhere", "sole copy, nowhere else");

  const bin = cherryShim(t);

  const { code, json, stderr } = runReap(w, ["--apply"], { PATH: `${bin}:${ENV.PATH ?? process.env.PATH}` });

  assert.equal(code, 0, "an unanswerable probe is not a script failure");
  assert.deepEqual(json.reaped, [], "the sole-copy commit must not be deleted on a probe that could not answer");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/onlyhere");
  assert.match(json.kept[0].reason, /cherry probe failed/, "the reason must name the probe failure, not read as a clean merge");
  assert.match(json.kept[0].reason, /revision walk setup failed/, "git's own message must reach the reason, not just a generic label");
  assert.doesNotMatch(
    json.kept[0].reason,
    /\n/,
    "git's stderr is multi-line; an embedded newline would break the JSON payload — the reason must be flattened",
  );
  assert.match(stderr, /cherry probe failed/);

  assert.equal(branchExists(w, "feature/onlyhere"), true, "the branch — and its only copy of the commit — must survive");
  assert.equal(git(w, "rev-parse", "feature/onlyhere"), sha, "the commit itself is untouched");
});

test("a `+` inside git's stderr is not a commit line — a merged branch is still reaped", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const bin = mkdtempSync(join(tmpdir(), "reap-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // `git cherry` SUCCEEDS here — rc 0, no commit lines on stdout — but writes a
  // diagnostic containing a `+` to stderr, which the capture's 2>&1 folds into
  // the value the merge check matches. Only the line-start `+` is a commit, so
  // this branch must still be reaped. An unanchored match keeps it forever.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = cherry ]; then\n` +
      `  echo "warning: unable to access '/x/c++/lib/.gitattributes'" >&2\n` +
      `fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );

  const { code, json } = runReap(w, ["--apply"], { PATH: `${bin}:${ENV.PATH ?? process.env.PATH}` });

  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], "a `+` inside a diagnostic is not an unmerged commit");
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.equal(branchExists(w, "feature/merged"), false, "noisy stderr must not strand a merged branch");
});

/**
 * A PATH dir whose `git` fails only `worktree prune`, standing in for the
 * repo-level faults that do exit non-zero — an unreadable `.git/config`, a
 * `GIT_DIR` off the repo — never a filesystem one: an unwritable
 * `.git/worktrees` prints `error: failed to delete …` and still exits 0, and
 * prune skips a locked entry at 0. Everything else, including
 * `git worktree remove`, execs the real git, unshimmed.
 */
function pruneShim(t) {
  const bin = mkdtempSync(join(tmpdir(), "reap-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = worktree ] && [ "$2" = prune ]; then\n` +
      `  echo "fatal: unable to prune worktrees: permission denied" >&2\n` +
      `  exit 1\n` +
      `fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

// #265: `git worktree prune` used to be the last command of an AND-OR list
// after the branch loop, so under `set -eu` its own failure — not just a
// false `[ apply = true ]` — reached -e and aborted the script before the
// payload printed, after the branches above were already deleted. The
// caller lost the only record of what had happened, at exit 1: the code the
// fleet's script contract reserves for a verdict, from a script with none.
test("a failing `git worktree prune` still prints the payload and refuses on 2, never 1 (#265)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const bin = pruneShim(t);

  const { code, json, stderr } = runReap(w, ["--apply"], { PATH: `${bin}:${ENV.PATH ?? process.env.PATH}` });

  assert.equal(code, 2, "a failing prune must refuse loudly on 2, never fall through to the -e default of 1");
  assert.ok(json, "the payload must still print even though the prune below it failed");
  assert.deepEqual(json.reaped, ["feature/merged"], "branches already deleted must still be recorded");
  assert.deepEqual(json.kept, []);
  assert.match(stderr, /git worktree prune/, "the refusal must name the command that failed");
});

// Accept-side control for the fix above: a run where nothing fails must be
// completely unchanged — same payload shape, exit 0, and the prune must
// still actually run (not just get skipped to dodge the -e trap).
test("a successful --apply run still reaps, still prunes, and exits 0 unchanged", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  // A worktree whose directory is gone but whose registration survives until
  // `git worktree prune` runs — proof the prune still executes post-fix.
  const wtDir = join(w, "..", "stale-wt");
  git(w, "worktree", "add", "-q", "-b", "scratch/stale", wtDir, "main");
  rmSync(wtDir, { recursive: true, force: true });
  assert.match(git(w, "worktree", "list"), /stale-wt/, "fixture must start with a prunable registration");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(git(w, "worktree", "list"), /stale-wt/, "the prune must still run and clear the stale registration");
});

// The other half of the same guard, and the half no test had: the default
// mode runs no prune at all, but the guard is the script's last statement, so
// the guard's SHAPE decides the dry run's exit status. Every other test here
// passes --apply, which is exactly how an AND-OR form regressed this path from
// 0 to a bare 1 under a fully green suite (#265).
test("the default dry run reports its verdict and exits 0, never a bare 1 (#265)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const { code, json } = runReap(w, []);

  assert.equal(code, 0, "a dry run with nothing to report must exit 0, not the -e default of 1");
  assert.equal(json.applied, false);
  assert.deepEqual(json.reaped, ["feature/merged"], "a dry run still reports what it would reap");
  assert.equal(branchExists(w, "feature/merged"), true, "a dry run must not delete anything");
});

// The design spec's script-surface table states this script's exit-0 contract in
// prose, and it spent the whole life of #264 asserting the bug as the behaviour:
// "the merged check reads a `git cherry` that failed as 'no unmerged commits'
// and reaps the branch". Fixing that is one edited row; this is the part that
// keeps the next one from rotting silently — a reader trusting the table would
// draw the opposite safety conclusion about a script settings.json's autoMode
// allowlist runs unattended. Derived from a real run, never from a phrase typed
// here: a hand-copied phrase drifts from the script exactly the way the row did.
// Sibling pin, same table, same reason: no-undo-audit.test.mjs.
test("the design spec's script-surface row carries the keep reason this script actually emits", (t) => {
  const w = repo(t);
  unmergedGoneBranch(w, "feature/onlyhere", "sole copy, nowhere else");
  const bin = cherryShim(t);

  const { json } = runReap(w, ["--apply"], { PATH: `${bin}:${ENV.PATH ?? process.env.PATH}` });

  // Everything up to the first colon: the label reap.sh chose, without git's
  // own message, which is the machine's to vary and no doc can carry.
  const label = json.kept[0].reason.split(":")[0].trim();
  assert.match(label, /^cherry probe failed/, "fixture must reach the failed-probe keep, not some other one");

  const spec = readFileSync(
    fileURLToPath(new URL("../../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `reap.sh` |"));
  assert.ok(row, "the script-surface table must still carry a reap.sh row");
  assert.ok(
    row.includes(label),
    `the spec row must quote the keep reason verbatim, and does not carry "${label}".\nrow: ${row}`,
  );
});

// Worktree-removal coverage (#83, #128). Before this file, reap.sh's
// worktree-removal path had NO fixture at all: a merged [gone] branch was
// always tested without a worktree, so the dirty check, the linkage guard and
// the absent-directory path never ran under test.

test("a healthy clean worktree on a merged [gone] branch is reaped, directory and all", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  assert.ok(existsSync(wt), "fixture");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /KEEP/);
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.equal(existsSync(wt), false, "the worktree directory itself must be removed");
});

test("a dirty worktree on an otherwise-mergeable [gone] branch is kept, not reaped", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^dirty worktree /);
  assert.match(stderr, /KEEP feature\/merged — dirty worktree/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true, "a dirty worktree must survive untouched");
});

test("a [gone] branch whose worktree directory was deleted by hand is reaped, never kept as dirty (#83)", (t) => {
  // The bug: `|| echo dirty` folds ANY failed status — including one that
  // failed because the directory is not there at all — into "dirty", pinning
  // the branch forever. A deleted worktree holds nothing to protect.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  rmSync(wt, { recursive: true, force: true });
  assert.match(git(w, "worktree", "list"), /feature\/merged/, "fixture: the stale registration must still be listed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"], "a directory that is not there holds no work to protect");
  assert.deepEqual(json.kept, []);
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.doesNotMatch(git(w, "worktree", "list"), /feature\/merged/, "the stale registration must not survive the run");
});

test("a dry run and --apply agree about a deleted worktree directory (#128)", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  rmSync(wt, { recursive: true, force: true });

  const dry = runReap(w, []);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.json.reaped, ["feature/merged"], "a dry run must predict the same outcome --apply produces");
  assert.deepEqual(dry.json.kept, []);

  const applied = runReap(w, ["--apply"]);
  assert.deepEqual(applied.json.reaped, ["feature/merged"]);
});

test("a [gone] branch checked out in the MAIN checkout is kept, with the reason that is true", (t) => {
  // The enumeration does not exclude the main worktree: `worktree list
  // --porcelain` emits a `branch refs/heads/...` line for it, so a [gone]
  // branch checked out there binds $wt to the main checkout. Its `.git` is a
  // DIRECTORY, so the `-f` linkage guard read it as "no .git linkage" — false;
  // git answers about that repo correctly through it. Both halves matter and
  // are asserted separately: the reason must be true, and the dry run must not
  // promise a reap that `git worktree remove` and `git branch -D` both refuse.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  git(w, "checkout", "-q", "feature/merged");

  const dry = runReap(w, []);
  const applied = runReap(w, ["--apply"]);

  for (const { json } of [dry, applied]) {
    assert.deepEqual(json.reaped, []);
    assert.equal(json.kept.length, 1);
    assert.equal(json.kept[0].branch, "feature/merged");
    assert.match(json.kept[0].reason, /is the main checkout/);
    assert.doesNotMatch(json.kept[0].reason, /no \.git linkage/, "git answers correctly through a .git directory");
  }
  assert.deepEqual(dry.json.kept, applied.json.kept, "a dry run must predict what --apply produces");
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("a worktree behind an unreadable parent is kept, never reaped as clean", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "precious.txt"), "work that exists nowhere else\n");
  const parent = join(w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code, json, stderr } = runReap(w, ["--apply"]);
  chmodSync(parent, 0o755);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /cannot tell whether worktree/);
  assert.doesNotMatch(json.kept[0].reason, /dirty/, "an unanswerable probe must not be misreported as a dirty one");
  assert.match(stderr, /KEEP feature\/merged — cannot tell whether worktree/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a worktree whose .git file is gone is kept, never reaped as clean (#128)", (t) => {
  // The directory EXISTS (so a bare `[ -e ]` says present) and `git -C` does
  // not fail on a missing `.git` — it walks UP to the enclosing repo and
  // answers about THAT at rc 0. `.worktrees/` gitignored and the parent clean
  // makes the leaked answer empty: a positive "clean" produced without ever
  // looking at the worktree, which the old code would have reaped on.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "precious.txt"), "work that exists nowhere else\n");
  rmSync(join(wt, ".git"));
  assert.equal(git(w, "status", "--porcelain"), "", "fixture: the leaked answer really is an empty one");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /no \.git linkage/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true, "the worktree directory and its work must survive untouched");
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a worktree whose .git is a dangling symlink is kept, never reaped as clean (#128)", (t) => {
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  rmSync(join(wt, ".git"));
  symlinkSync(join(wt, "nowhere"), join(wt, ".git"));

  const { json } = runReap(w, ["--apply"]);

  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /no \.git linkage/);
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("a repo path containing a space still finds and reaps the branch's worktree", (t) => {
  const w = repo(t, "my repos");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.equal(existsSync(wt), false);
});

test("a repo path containing a space still finds a dirty worktree and keeps it", (t) => {
  const w = repo(t, "my repos");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /^dirty worktree /);
  assert.ok(json.kept[0].reason.includes("/my repos/.worktrees/feature/merged"), json.kept[0].reason);
});
