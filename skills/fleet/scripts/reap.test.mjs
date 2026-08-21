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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
 *
 * `wt` overrides that home. reap.sh exempts `.worktrees/` from the
 * `--ignored` keep, so a test that exercises that keep has to put its
 * worktree somewhere else and pass the path in.
 */
function mergedGoneBranchWithWorktree(w, name, msg, wt = join(w, ".worktrees", name)) {
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
 * Re-point the registration for `wt` at `dest` and take the real directory away.
 *
 * `git worktree list --porcelain` derives the worktree path from the entry's
 * `gitdir` file, so rewriting that file is how a fixture gets git to name a
 * path whose FIRST component under `/` does not exist — the one shape
 * `git worktree add` cannot produce, since it has to create the directory. In
 * production this is the hand-added worktree outside the checkout whose
 * ancestor chain was removed (`git worktree add /scratch/wt`, then
 * `rm -rf /scratch`). The registry entry itself survives, so any
 * listed-vs-registered count stays balanced.
 */
function relocate(w, wt, dest) {
  const admin = join(w, ".git", "worktrees");
  // realpathSync: git canonicalises what it writes into `gitdir`, and on macOS
  // a tmpdir path reaches this suite as /var/... while git recorded
  // /private/var/... — the scan matches nothing without resolving first.
  const target = join(realpathSync(wt), ".git");
  const name = readdirSync(admin).find(
    (n) => readFileSync(join(admin, n, "gitdir"), "utf8").trim() === target,
  );
  assert.ok(name, `fixture: no registry entry points at ${wt}`);
  writeFileSync(join(admin, name, "gitdir"), `${dest}/.git\n`);
  rmSync(wt, { recursive: true, force: true });
  return dest;
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

/** A PATH `git` that fails only the subcommand `match` names; everything else is real. */
function failOnlyShim(t, match, stderr, code = 1) {
  const bin = mkdtempSync(join(tmpdir(), "reap-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if ${match}; then\n` +
      // Shell-quoted, not `JSON.stringify`: that escapes for JSON, but the
      // splice lands in shell, where a `$` in a fixture line would expand
      // instead of reaching git's stderr as data.
      stderr.map((l) => `  printf '%s\\n' '${l.replace(/'/g, `'\\''`)}' >&2\n`).join("") +
      `  exit ${code}\n` +
      `fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A PATH dir whose `git` fails only `cherry`, matching the ticket's real repro:
 * multi-line stderr, exit 128 (one unreadable loose object suffices in the
 * wild). Everything else execs the real git, unshimmed.
 */
function cherryShim(t) {
  return failOnlyShim(
    t,
    `[ "$1" = cherry ]`,
    ["error: unable to open loose object deadbeefcafe: Permission denied", "fatal: revision walk setup failed"],
    128,
  );
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

  // The warning goes in the `match`, not the stderr array: a false match falls
  // THROUGH to `exec ${REAL_GIT}`, so the shim warns and the merge check still
  // reads a genuine `git cherry` run's stdout rather than an empty one.
  // `git cherry` SUCCEEDS here — rc 0, no commit lines on stdout — but writes a
  // diagnostic containing a `+` to stderr, which the capture's 2>&1 folds into
  // the value the merge check matches. Only the line-start `+` is a commit, so
  // this branch must still be reaped. An unanchored match keeps it forever.
  const bin = failOnlyShim(t, `[ "$1" = cherry ] && { printf '%s\\n' "warning: unable to access '/x/c++/lib/.gitattributes'" >&2; false; }`, []);

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
  return failOnlyShim(t, `[ "$1" = worktree ] && [ "$2" = prune ]`, ["fatal: unable to prune worktrees: permission denied"]);
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


test("a worktree with no surviving ancestor below / is reaped, never kept as unanswerable (#178)", (t) => {
  // The escalation of the case above: there the parent could not be SEARCHED,
  // which is genuinely unknown and must keep. Here every ancestor below `/` is
  // absent — but `${p%/*}` on `/x` yields the empty string rather than `/`, so
  // the walk fell out on "" and `[ -x "" ]` answered unknown for a path that is
  // provably absent with a searchable root. That kept a merged branch forever
  // on a directory holding nothing, which is the refusal `gone` exists to end.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  const dest = relocate(w, wt, "/nonexistent-top-level-178/wt");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, [], `an absent path with a searchable root is not an unknown one: ${JSON.stringify(json.kept)}`);
  // The keep's own wording, not just an empty `kept`: any other keep reason
  // would also leave `reaped` short, so the pair alone does not say which
  // question was answered wrong.
  assert.doesNotMatch(stderr, /cannot tell whether worktree/);
  assert.ok(!stderr.includes(`dirty worktree ${dest}`), "and it is never guessed dirty either");
  assert.equal(branchExists(w, "feature/merged"), false);
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

test("a non-fleet worktree holding an ignored file is kept, never reaped", (t) => {
  // The one keep the worktree-present branch owns that nothing else here
  // reaches. `git worktree remove` refuses on modified and untracked files but
  // deletes IGNORED ones silently, so outside `.worktrees/` — where an ignored
  // file is a .env or a scratch note that exists nowhere else — the
  // `--ignored` probe is the only thing left between a merged, linked,
  // tracked-clean worktree and `git branch -D`. Every earlier guard passes by
  // construction, which is what makes this test see that probe and only it.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  // Deliberately NOT under `.worktrees/`: that home is what the case statement
  // keys the fleet exemption on, and a fleet worktree is reaped WITH its
  // machine-generated ignored files.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  writeFileSync(join(wt, ".env"), "SECRET=exists nowhere else\n");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the --ignored probe can keep it");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  // The reason, not just the keep: every other guard in this branch also
  // leaves `reaped` empty, so the pair alone does not say which one answered.
  assert.match(json.kept[0].reason, /^ignored files present in .*: \.env$/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "SECRET=exists nowhere else\n", "the precious file must survive the run");
});

test("a non-fleet worktree with NO ignored file is reaped — the control for the case above", (t) => {
  // Without this, the test above passes on a reap.sh that keeps every
  // non-fleet worktree unconditionally: it would be pinning the `.worktrees/`
  // arm of the case, not the `--ignored` probe inside it. Same fixture, one
  // difference — the ignored file — and the opposite verdict.
  //
  // It is also the exit-status control for this branch. Reached with
  // `$ignored` empty, the `if [ -n "$ignored" ]` is the last command of the
  // worktree-present branch, and a condition that tests false leaves an `if`
  // with no `else` at status 0. Under `set -eu` any other answer would abort
  // the sweep here, after the earlier branches were already deleted.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  // Deliberately NOT under `.worktrees/`, same as the case above.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  // and NO .env written this time

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0, "the sweep must not abort under set -eu on the branch's own last command");
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.equal(existsSync(wt), false, "the worktree directory goes with it");
});

test("a FLEET worktree under `.worktrees/` is reaped, ignored file and all", (t) => {
  // The other arm of `case "$wt" in */.worktrees/*) : ;; *) ...ignored-check... ;; esac`.
  // The pair above reaches the `--ignored` keep from OUTSIDE that home, so both
  // pin the `*)` arm; nothing pinned the exemption itself. Measured BEFORE this
  // test existed: mutating the pattern to one that never matches — routing every
  // fleet worktree through the keep and stranding all of them, the regression the
  // comment at reap.sh's case statement warns about — left this file 37/37 green.
  // It now fails here, and only here.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  // The home is the ONLY difference from the pair above: same ignored file, same
  // tracked-clean worktree, opposite verdict.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, ".env"), "AGENT_TEST=machine-generated\n");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the --ignored probe could keep it");
  assert.match(git(wt, "status", "--porcelain", "--ignored"), /^!! \.env$/m, "fixture: the file really is ignored, or the exemption is untested");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.equal(existsSync(wt), false, "the exemption reaps a fleet worktree WITH its machine-generated ignored files");
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

// --- #119: the payload's own string fields.
//
// `keep()` splices its two arguments raw, and five call sites reach it: the
// branch name, `dirty worktree $wt`, `ignored files present in $wt: $ignored`,
// the `reaped` accumulator, and `cherry probe failed …: $cherry`, which routes
// arbitrary git stderr. The branch name is the demonstrated trigger — measured
// on the pre-fix script, an unmerged `[gone]` branch named `feat/has"quote`
// produced `{"branch":"feat/has"quote",…}` at exit 0 and `JSON.parse` failed at
// position 56. The script's decision was correct throughout; what broke was the
// sole machine-readable record of it.
test("a quote in a [gone] branch name still emits parseable JSON", (t) => {
  const w = repo(t);
  unmergedGoneBranch(w, 'feat/has"quote', "work nobody merged");

  const { code, json, stderr } = runReap(w, []);

  assert.equal(code, 0, "a kept branch is a finding at exit 0, quote or no quote");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, 'feat/has"quote',
    "the field round-trips to the name that went in — `runReap` JSON.parses stdout, so an unescaped splice fails here before this assert runs");
  assert.equal(json.kept[0].reason, "unmerged commits");
  assert.ok(branchExists(w, 'feat/has"quote'), "and it is still there: escaping must not change what gets deleted");
  assert.match(stderr, /KEEP feat\/has"quote/, "the human line stays raw — it is prose, not JSON");
});

test("git's own stderr reaches the payload escaped, not raw", (t) => {
  // The fifth interpolation, and the only one that carries text neither this
  // repo nor its operator chose. Real `git cherry` corruption output happens to
  // carry no quote, which makes this the least likely of the five to fire —
  // and the one with the least control over what it splices when it does.
  const w = repo(t);
  unmergedGoneBranch(w, "feature/onlyhere", "work");
  // `failOnlyShim` emits each line through `printf '%s\n'`, so the `"` this test
  // exists to chase reaches git's stderr as data — the payload has something
  // real to escape.
  const bin = failOnlyShim(t, `[ "$1" = cherry ]`, ['error: unable to open loose object "deadbeef cafe": Permission denied'], 128);

  const { code, json } = runReap(w, [], { PATH: `${bin}:${ENV.PATH ?? process.env.PATH}` });

  assert.equal(code, 0);
  assert.match(json.kept[0].reason, /cherry probe failed/);
  assert.match(json.kept[0].reason, /"deadbeef cafe"/,
    "the quotes survive as data rather than terminating the JSON string");
});

test("an ordinary branch name is untouched — the escaping accepts what it should", (t) => {
  // The false-positive half. Nothing here has anything to escape, so the
  // payload must be exactly what this script has always emitted.
  const w = repo(t);
  unmergedGoneBranch(w, "fix/119-json-sh-extract", "work");

  const { code, json } = runReap(w, []);

  assert.equal(code, 0);
  assert.deepEqual(json, {
    applied: false,
    reaped: [],
    kept: [{ branch: "fix/119-json-sh-extract", reason: "unmerged commits" }],
  });
});

test("a reaped branch name is escaped too — the other accumulator", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, 'chore/re"aped', "work that landed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ['chore/re"aped'],
    "`reaped` is built by its own accumulator, not by keep() — escaping one and not the other leaves half the payload broken");
  assert.equal(branchExists(w, 'chore/re"aped'), false, "and it really was deleted");
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run. This script's
// contract is exit 0 or exit 2 with no exit 1 at all (#265), and the guard sits
// ahead of the fetch, so a missing library refuses before anything is deleted.
test("a missing json.sh is exit 2, before any branch is deleted", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "chore/landed", "work that landed");
  const lone = mkdtempSync(join(tmpdir(), "reap-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "reap.sh"));

  const r = spawnSync("sh", [join(lone, "reap.sh"), "--apply"], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2, "a missing library is a refusal — this script has no exit 1 to be confused with");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the fetch or the base ref");
  assert.equal(r.stdout, "", "no payload: nothing happened");
  assert.ok(branchExists(w, "chore/landed"),
    "and the branch is still there — the guard fires ahead of every deletion, so this is a clean refusal");
});

// --- #391: the reason a keep carries, on the three calls that derived it from
// an exit code and sent git's own diagnosis to /dev/null.
//
// Measured before this suite existed, by mutating each arm and re-running the
// file: garbling the `worktree remove` reason and garbling the `branch -D`
// reason each left all 24 tests green. Both arms were invisible.

/**
 * Put a symlink where the worktree directory was, keeping the registration
 * pointed at the symlink's path — the shape that makes `git worktree remove`
 * fail AFTER it has already cleared the admin entry.
 *
 * Measured, git 2.50.1 (Apple Git-155): rc 255,
 * `error: failed to delete '<wt>': Not a directory`, the porcelain no longer
 * lists the entry, and both the symlink and its target survive on disk.
 *
 * Chosen over a `chmod 555` parent, which produces the same deregistered state
 * by a different route: this one reproduces as any user, needs no permission
 * bits, and so carries none of the euid-0 vacuity the `0o000` fixtures in this
 * file already have to skip around (#184). Every guard ahead of the removal
 * still passes through it — `.git` is a regular file and `git -C` follows the
 * link, so the linkage guard and the status probe both answer about the real
 * worktree.
 */
function symlinkStandIn(wt) {
  const real = `${wt}-real`;
  renameSync(wt, real);
  symlinkSync(real, wt);
  return real;
}

const withShim = (bin) => ({ PATH: `${bin}:${ENV.PATH}` });

// Every shim test above and below routes through this helper, and a PATH it
// builds WRONG fails silently rather than loudly: the shim still shadows `git`
// (it is first), so the shape of a broken tail is a reap.sh that cannot find
// its other tools, not a red assertion here. Pinned in both directions — the
// shim goes on the front, the real PATH survives on the back — and pinned as
// the ONLY key, because runReap spreads this over ENV and a second key here
// would silently clobber one of ENV's git-scrubbing entries. The tail asserts
// against `process.env.PATH`, not `ENV.PATH`: ENV spreads process.env and
// never sets PATH, and that identity is exactly what lets this helper spell
// the tail without the `?? process.env.PATH` fallback its call sites used to.
test("withShim prepends the shim dir, keeps the real PATH, and sets nothing else", () => {
  assert.equal(withShim("/x/bin").PATH, `/x/bin:${process.env.PATH}`);
  assert.deepEqual(Object.keys(withShim("/x/bin")), ["PATH"]);
});

test("a refusal that CLEARED the registration is reported as a partial removal, not as a no-op (#391)", (t) => {
  // The worst of the two: git unregistered the worktree and then failed to
  // delete it, so the run reported `worktree remove refused` — indistinguishable
  // from "nothing happened" — while leaving an orphaned directory behind and
  // the branch standing as though it had been deliberately retained.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  const real = symlinkStandIn(wt);

  // A second registration whose path merely BEGINS with the refused one. The
  // probe has to match a whole porcelain line, not a substring: without the
  // anchor this entry keeps matching after the refused one is gone, and the
  // run reports "registration intact" for a registration that was cleared —
  // measured, an unanchored grep survived every other test here. Its branch
  // has no upstream, so it is not [gone] and reap never touches it.
  git(w, "worktree", "add", "-q", `${wt}-sibling`, "-b", "scratch/sibling", "main");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0, "a refusal is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(
    json.kept[0].reason,
    /registration cleared/,
    `a refusal that unregistered the worktree must not read as a no-op: ${json.kept[0].reason}`,
  );
  assert.match(json.kept[0].reason, /Not a directory/, "git's own diagnosis must reach the payload");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "git's stderr is multi-line; the reason must be flattened");
  assert.match(stderr, /KEEP feature\/merged — worktree remove refused/);

  // The registration really is gone — the state the reason claims, measured.
  // Compared whole-line, for the reason the script's own probe is: a substring
  // test against this porcelain matches the sibling entry below and would call
  // a cleared registration intact. (This assertion was written unanchored
  // first, and the sibling caught it.)
  const reg = git(w, "worktree", "list", "--porcelain").split("\n");
  assert.ok(!reg.includes(`worktree ${wt}`), `the refused worktree's registration must be gone: ${reg.join(" | ")}`);
  assert.ok(reg.includes(`worktree ${wt}-sibling`), "fixture: the prefix-sharing sibling must still be registered");
  // ...and nothing on disk was removed by this script, under any path.
  assert.ok(lstatSync(wt).isSymbolicLink(), "the stand-in symlink must survive");
  assert.equal(existsSync(real), true, "the orphaned directory is not this script's to delete");
  assert.equal(branchExists(w, "feature/merged"), true, "and the branch is still kept");
});

test("a refusal that LEFT the registration in place is reported as such, distinctly (#391)", (t) => {
  // The other half, and the half the old message happened to describe
  // correctly — asserted so the two outcomes cannot collapse back into one
  // string. A locked worktree exits 128 with the admin entry untouched
  // (measured, git 2.50.1). Per the brief this needs no dedicated arm: once
  // git's stderr is quoted, the lock names itself and its own remedy.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  git(w, "worktree", "lock", wt);

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(
    json.kept[0].reason,
    /registration intact/,
    `a refusal that changed nothing must say so: ${json.kept[0].reason}`,
  );
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the two outcomes must not collapse into one reason");
  assert.match(json.kept[0].reason, /locked working tree/, "git's message names the fault and the remedy");
  assert.match(json.kept[0].reason, /remove -f -f/, "including the remedy, which only git can supply");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "git's message here really is two lines — it must arrive flattened");
  assert.match(stderr, /KEEP feature\/merged/);

  assert.match(git(w, "worktree", "list", "--porcelain"), /feature\/merged/, "the registration really did survive");
  assert.equal(existsSync(wt), true);
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("a refusal whose registration a PEER cleared claims nothing about the directory (#391)", (t) => {
  // The registry and the directory are INDEPENDENT facts, and the reason may
  // only carry the one that was read. Shape: a concurrent session finishes the
  // same removal between this run's lookup and its own `git worktree remove`
  // — the concurrency reap.sh's own header documents — so the registration is
  // cleared, our removal fails, and NOTHING is left behind. A reason that
  // hard-codes "removal was partial — $wt is still on disk" reports an orphan
  // that does not exist, and this ticket exists because a reason that names
  // something other than what was measured is the defect.
  //
  // Neither arm above can catch that: in the symlink shape the directory
  // happens to survive, so both stay green with the false clause in place —
  // measured, 907/907, which is why this arm is here at all.
  //
  // The shim runs the PEER's removal with the real git and then returns false,
  // so the `exec` below it runs OUR removal for real and it fails in git's own
  // words. No permission bits, hence none of the euid-0 vacuity the `0o000`
  // fixtures in this file have to skip around (#184).
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = worktree ] && [ "$2" = remove ] && { ${REAL_GIT} worktree remove "$3" >/dev/null 2>&1; false; }`,
    [],
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  // Both halves of the fixture, asserted before the reason is read: the peer
  // really did finish the job, so "still on disk" would be false and
  // "registration cleared" true.
  assert.equal(existsSync(wt), false, "fixture: the peer's removal must leave nothing on disk");
  assert.ok(
    !git(w, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${wt}`),
    "fixture: the peer's removal must clear the registration",
  );

  assert.equal(code, 0, "a refusal is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(
    json.kept[0].reason,
    /registration cleared/,
    `the registry is what was read, and it says cleared: ${json.kept[0].reason}`,
  );
  assert.doesNotMatch(
    json.kept[0].reason,
    /on disk|orphan|removal was partial/,
    `nothing stat'd the directory, so the reason must claim nothing about it: ${json.kept[0].reason}`,
  );
  assert.match(json.kept[0].reason, /is not a working tree/, "git's own diagnosis still reaches the payload");
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("the sweep continues past a worktree-removal refusal and still reaps the branches AFTER it (#391)", (t) => {
  // The constraint that separates this ticket's ruling from #208's: reap.sh
  // sweeps every [gone] branch unattended in one pass, so one orphan must not
  // strand the rest. The new registry re-read runs inside that loop, which is
  // exactly where an added git call could introduce a bail.
  //
  // The `a-`/`b-` names are load-bearing, not decoration. `git for-each-ref`
  // sorts by refname, so a healthy branch named to sort FIRST is already
  // reaped before the refusal happens and the test passes under a `break`
  // just as happily as under a `continue`. Measured both ways on this branch,
  // rather than carrying a count that drifts every time a test is added: under
  // the alternative spelling the whole file stays green with the mutant in
  // place, and under the shipped one exactly this test reds.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/a-locked", "work behind a lock");
  git(w, "worktree", "lock", wt);
  mergedGoneBranch(w, "feature/b-healthy", "work that landed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/b-healthy"], "the refusal must not strand the branches after it");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/a-locked");
  assert.equal(branchExists(w, "feature/b-healthy"), false, "reached only by continuing past the refusal");
  assert.equal(branchExists(w, "feature/a-locked"), true);
});

test("a `git branch -D` failure carries git's own message, not just the label (#391)", (t) => {
  // `>/dev/null 2>&1` sent the cause to the void and reported "branch delete
  // failed". The real message names the fault outright — the shim reproduces
  // the one measured in the wild, plus a second line, since the reason has to
  // survive as a single JSON string.
  //
  // The shim is scoped to one branch, and a healthy branch sorts after it, so
  // this also pins the other half of "the sweep continues past EITHER failure".
  const w = repo(t);
  mergedGoneBranch(w, "feature/a-broken", "merged work");
  mergedGoneBranch(w, "feature/b-healthy", "work that landed");
  const bin = failOnlyShim(
    t,
    `[ "$1" = branch ] && [ "$2" = -D ] && [ "$3" = feature/a-broken ]`,
    [`error: cannot delete branch 'feature/a-broken' used by worktree at '/some/where'`, "fatal: could not update ref"],
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/b-healthy"], "a branch that was not deleted must not be reported as reaped, and the sweep goes on");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/a-broken");
  assert.match(json.kept[0].reason, /^branch delete failed: /, "the label stays — it is the reason that gains a cause");
  assert.match(json.kept[0].reason, /used by worktree at/, "git's diagnosis must reach the payload");
  assert.match(json.kept[0].reason, /could not update ref/, "both lines, not just the first");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "flattened into one JSON string");
  assert.match(stderr, /KEEP feature\/a-broken — branch delete failed/);
  assert.equal(branchExists(w, "feature/a-broken"), true);
  assert.equal(branchExists(w, "feature/b-healthy"), false, "reached only by continuing past the failure");
});

test("a dying `git worktree list` still reaps what it can, and quotes git for what it cannot (#391)", (t) => {
  // The pipeline into awk takes awk's status, never git's, so a dying list
  // leaves $wt empty: every check under `[ -n "$wt" ]` is skipped and flow
  // falls through to `git branch -D`. That was #391's visible symptom — the
  // payload blamed the branch delete for a failure two steps earlier, under a
  // bare label, while git's own `fatal:` reached the terminal and never the
  // JSON the caller parses.
  //
  // Fixed here as the MESSAGE change #391 asked for: the branch git refuses
  // now carries git's reason, which names the worktree still holding it — the
  // only thing that tells an operator which remedy applies.
  //
  // What is deliberately NOT changed is which branches get reaped. Measured:
  // `git branch -D` needs no answer from the registry to delete a branch that
  // has no worktree, so `feature/b-merged` goes exactly as it did before.
  // Making the lookup fail closed would keep the whole sweep instead — a
  // control-flow ruling #391 reserved for the maintainer, filed as
  // #622. This test is the pin that a fix for it would have to move
  // deliberately.
  const w = repo(t);
  mergedGoneBranchWithWorktree(w, "feature/a-merged", "merged work");
  mergedGoneBranch(w, "feature/b-merged", "more merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = worktree ] && [ "$2" = list ]`,
    ["fatal: worktree list exploded"],
    128,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "a branch git refuses to delete is a finding, not a script failure");
  assert.deepEqual(
    json.reaped,
    ["feature/b-merged"],
    "a lookup nobody could answer must not change what gets reaped — that ruling is not this ticket's",
  );
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/a-merged");
  assert.match(json.kept[0].reason, /^branch delete failed: /, "the label stays — it is the reason that gains a cause");
  assert.match(json.kept[0].reason, /used by worktree at/, "git's diagnosis must reach the payload, not just the terminal");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "flattened into one JSON string");
  assert.match(stderr, /KEEP feature\/a-merged — branch delete failed: /);
  assert.equal(branchExists(w, "feature/a-merged"), true, "the branch git refused to delete survives");
  assert.equal(branchExists(w, "feature/b-merged"), false);
});

test("quotes and backslashes in git's stderr still round-trip through the new reasons (#391, #119)", (t) => {
  // These three reasons now carry text neither this repo nor its operator
  // chose. `keep()` escapes through json.sh, which landed in #119 — before it,
  // routing git's stderr here would have emitted a payload no parser accepts.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = branch ] && [ "$2" = -D ]`,
    [`error: cannot delete branch "feat" used by worktree at 'C:\\path\\to\\wt'`],
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.equal(
    json.kept[0].reason,
    `branch delete failed: error: cannot delete branch "feat" used by worktree at 'C:\\path\\to\\wt'`,
    "the quotes and backslashes survive as data — runReap JSON.parses stdout, so a raw splice fails before this assert",
  );
});

test("an ordinary run's payload is byte-for-byte what it has always been (#391)", (t) => {
  // The false-positive half. Nothing here fails, so nothing has a cause to
  // quote and the whole payload must be unchanged — a fix that starts
  // decorating healthy reasons is as wrong as one that reports none.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json, { applied: true, reaped: ["feature/merged"], kept: [] });
  assert.doesNotMatch(stderr, /KEEP/);
  assert.doesNotMatch(stderr, /registration/, "a successful removal says nothing about registrations");
  assert.equal(existsSync(wt), false);
});

test("the dry run removes nothing, and still cannot predict a refusal (#391)", (t) => {
  // The brief keeps this asymmetry deliberately: a dry run prints
  // `would remove worktree $wt` WITHOUT attempting the removal, so it cannot
  // foresee a refusal — performing it is the only way to know. This resembles
  // the dry/apply mismatch class of #86, #385 and #386 but is not an instance
  // of it, and the fix above must not have quietly turned it into one by
  // teaching the dry run to probe.
  //
  // BOTH fixtures are load-bearing. The locked one pins the unpredicted
  // refusal; the healthy one pins that no removal was attempted at all, and
  // only it can. Measured: with the locked worktree alone, a dry run taught to
  // call `git worktree remove` left this test green — the lock made the
  // attempt fail, so the fixture could not tell an attempt from an abstention.
  const w = repo(t);
  const healthy = mergedGoneBranchWithWorktree(w, "feature/a-healthy", "work that landed");
  const locked = mergedGoneBranchWithWorktree(w, "feature/b-locked", "work behind a lock");
  git(w, "worktree", "lock", locked);

  const { code, json, stderr } = runReap(w, []);

  assert.equal(code, 0);
  assert.deepEqual(
    json,
    { applied: false, reaped: ["feature/a-healthy", "feature/b-locked"], kept: [] },
    "the dry run still promises the reap it cannot know will be refused",
  );
  assert.ok(stderr.includes(`    would remove worktree ${healthy}`), `the dry run's own line is unchanged: ${stderr}`);
  assert.ok(stderr.includes(`    would remove worktree ${locked}`));
  assert.ok(stderr.includes("    would reap feature/a-healthy"));
  assert.doesNotMatch(stderr, /KEEP/, "a dry run predicts no refusal — it never ran the removal");
  assert.doesNotMatch(stderr, /registration/, "and it probes no registry either");

  // Nothing was touched: directories, registrations and branches all intact.
  assert.equal(existsSync(healthy), true, "a dry run must not remove the worktree it COULD have removed");
  assert.equal(existsSync(locked), true);
  const reg = git(w, "worktree", "list", "--porcelain");
  assert.match(reg, /feature\/a-healthy/);
  assert.match(reg, /feature\/b-locked/);
  assert.equal(branchExists(w, "feature/a-healthy"), true);
  assert.equal(branchExists(w, "feature/b-locked"), true);
});

test("a registry probe that itself fails is reported as unknown, never as 'cleared' (#391)", (t) => {
  // The registration probe this fix adds is a git call of its own, and it can
  // fail. Spelling it `git worktree list … | grep -q` would take GREP's exit
  // status, never git's, and report a registry it never managed to read as
  // CLEARED — this ticket's own defect, reintroduced inside its own fix, and
  // pointed at the more alarming of the two states. Measured: that spelling
  // survived every other test in this file.
  //
  // The shim starves `worktree list` only from its SECOND call onward, so the
  // lookup at the top of the loop still finds the worktree and reaches the
  // removal; only the post-refusal probe is denied an answer. The lock makes
  // the removal refuse without disturbing anything, so the registration really
  // is intact — and the point is that the script must NOT claim to know that.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  git(w, "worktree", "lock", wt);

  // The counter needs its own tmpdir: `failOnlyShim` creates the shim dir
  // itself, so the path has to exist before the match string that writes to it
  // can be built. Putting the count in the match is what lets this reuse the
  // helper — the match runs exactly once per `git`, ahead of the shim's single
  // `exec`.
  const countDir = mkdtempSync(join(tmpdir(), "reap-count-"));
  t.after(() => rmSync(countDir, { recursive: true, force: true }));
  const counter = join(countDir, "n");
  const bin = failOnlyShim(
    t,
    `[ "$1" = worktree ] && [ "$2" = list ] && ` +
      `{ n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); printf '%s' "$n" > "${counter}"; [ "$n" -ge 2 ]; }`,
    ["fatal: worktree list exploded"],
    128,
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(
    json.kept[0].reason,
    /cannot tell whether the registration survived/,
    `an unread registry is unknown, not a measurement: ${json.kept[0].reason}`,
  );
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the alarming state must never be guessed");
  assert.doesNotMatch(json.kept[0].reason, /registration intact/, "nor the reassuring one");
  assert.match(json.kept[0].reason, /locked working tree/, "git's reason for the refusal still reaches the payload");
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(counter, "utf8"), "2", "fixture: the probe really was the call that got starved");
});

// Same reason as the cherry-probe pin above, and the same derivation: the
// script-surface table is what a reader trusts about a script settings.json's
// autoMode allowlist runs unattended, and #264 spent its whole life with that
// table asserting the bug as the behaviour. The two state phrases are the part
// a reader would otherwise have to guess at, so they are taken from real runs
// rather than typed here — a hand-copied phrase drifts exactly the way the row
// did.
test("the design spec's script-surface row carries both refusal states this script emits (#391)", (t) => {
  const states = ["locked", "symlink"].map((shape) => {
    const w = repo(t, `w-${shape}`);
    const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
    if (shape === "locked") git(w, "worktree", "lock", wt);
    else symlinkStandIn(wt);

    const { json } = runReap(w, ["--apply"]);
    assert.equal(json.kept.length, 1, `fixture (${shape}) must reach the removal refusal`);
    // The parenthesised state only — the path and git's message are the
    // machine's to vary and no document can carry them.
    const m = /^worktree remove refused \(([^)]*?)(?: —.*)?\)/.exec(json.kept[0].reason);
    assert.ok(m, `fixture (${shape}) must produce the refusal reason: ${json.kept[0].reason}`);
    return m[1];
  });

  assert.notEqual(states[0], states[1], "the two refusals must not report the same state");

  const spec = readFileSync(
    fileURLToPath(new URL("../../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `reap.sh` |"));
  assert.ok(row, "the script-surface table must still carry a reap.sh row");
  for (const state of states) {
    assert.ok(row.includes(state), `the spec row must quote the refusal state verbatim, and does not carry "${state}".\nrow: ${row}`);
  }
});
