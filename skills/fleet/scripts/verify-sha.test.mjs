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
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // Names the guard that fired, so this cannot pass on some other exit 2 — the
  // fetch failing is also exit 2 with no stdout, which is why the code alone
  // and an empty stdout are not enough to tell these two cases apart.
  assert.match(stderr, /cannot resolve 0{40} to a commit in this repository/);
  assert.match(stderr, /Not a valid object name/, "git's own diagnosis must survive to stderr");
});

test("a failed fetch carries git's own cause, and a bad URL no longer reads like a removed remote", (t) => {
  // #559: these two produced byte-identical output, "cannot fetch origin/main —
  // branch missing, or no network", naming neither failure. The sha is never
  // reached in any of these — the fetch guard fires first — so 40 zeros will do.
  const dead = "0".repeat(40);

  const badUrl = repo(t);
  git(badUrl, "remote", "set-url", "origin", "/nonexistent/path.git");
  const a = verify(badUrl, "main", dead);

  const noRemote = repo(t);
  git(noRemote, "remote", "remove", "origin");
  const b = verify(noRemote, "main", dead);

  for (const r of [a, b]) {
    assert.equal(r.code, 2);
    assert.equal(r.json, null, "no verdict for a question that was never answered");
    assert.match(r.stderr, /cannot fetch origin\/main/);
    assert.doesNotMatch(r.stderr, /branch missing|no network/, "the guard no longer asserts a cause it cannot know");
    assert.match(r.stderr, /does not appear to be a git repository/, "git's own diagnosis must survive to stderr");
  }
  // Only git's line tells the two apart, which is exactly what was discarded.
  assert.match(a.stderr, /'\/nonexistent\/path\.git'/);
  assert.doesNotMatch(b.stderr, /nonexistent/, "two distinct faults must not collapse into one message");

  // The one cause the old list did name is still reported — now by git, and
  // precisely, so dropping the list refuses nothing it used to explain.
  const c = verify(repo(t), "nosuchbranch", dead);
  assert.equal(c.code, 2);
  assert.match(c.stderr, /cannot fetch origin\/nosuchbranch/);
  assert.match(c.stderr, /couldn't find remote ref nosuchbranch/);
});

test("a failed fetch is fatal — the script stops rather than answering off a stale ref", (t) => {
  // #574: the case above asserts exit 2, no JSON, and git's cause on stderr, and
  // every one of those survives downgrading this guard's `die` to a warning. With
  // the guard advisory the script runs ON: `origin/main` still resolves from the
  // tracking ref the clone left behind, and the sha then dies at the `cat-file -e`
  // guard — which independently gives exit 2, no stdout, and leaves the `cannot
  // fetch` line and git's diagnosis sitting on stderr. Exit code, empty stdout and
  // a stderr substring are each reproducible by a later guard, so no conjunction
  // of them can see whether this one was fatal.
  //
  // What only fatality produces is the absence of progress: the `tip =` trace is
  // echoed on the line after this guard, so it appears if and only if execution
  // got past it. That line is pinned verbatim by "a healthy run stays quiet", so
  // it cannot be reworded out from under this assertion unseen — and unlike a
  // `doesNotMatch` on some later guard's message, it does not depend on which of
  // them happens to fire, or on how it is worded.
  const w = repo(t);
  // One fixture: a bad URL and a removed remote both take this guard's `|| die`
  // branch, differing only in git's own line — the distinction #565 pinned next
  // door. This test is about the guard's fatality, not about telling causes apart.
  git(w, "remote", "set-url", "origin", "/nonexistent/path.git");

  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.doesNotMatch(
    stderr,
    /origin\/main tip =/,
    "a fetch that failed must stop the script, not warn and answer against an unupdated ref",
  );
});

test("a fetch that succeeds but leaves origin/<branch> unresolvable is exit 2 at the rev-parse guard", (t) => {
  const w = repo(t);
  // Real git throughout, no shim: with no fetch refspec configured, `git fetch
  // origin main` still succeeds — into FETCH_HEAD — without updating the
  // remote-tracking ref, so deleting that ref leaves the second guard to fire
  // while the first passes. A shim that killed the fetch would measure the
  // wrong failure, since that is also exit 2 with no stdout.
  git(w, "config", "--unset", "remote.origin.fetch");
  git(w, "update-ref", "-d", "refs/remotes/origin/main");

  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /origin\/main does not resolve after fetch/);
  assert.match(stderr, /ambiguous argument 'origin\/main'/, "git's own diagnosis must survive to stderr");
  assert.doesNotMatch(stderr, /cannot fetch/, "the fetch passed — this is the guard after it");
});

test("an object that is present but is not a commit is not reported as absent", (t) => {
  const w = repo(t);
  const tree = git(w, "rev-parse", "HEAD^{tree}");
  const { code, json, stderr } = verify(w, "main", tree);
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /cannot resolve .+ to a commit in this repository/);
  // The old wording asserted this object "is not a commit object in this
  // repository". It is in this repository — git reads it and reports its real
  // type, which is the half the guard was throwing away.
  assert.match(stderr, /dereferences to tree type/, "git's own diagnosis must survive to stderr");
});

test("a healthy run stays quiet — the unmuted guards add nothing to stderr", (t) => {
  const w = repo(t);
  // Push from a second clone so `w`'s fetch has real objects to transfer: an
  // already-up-to-date fetch would not exercise the path that could go noisy.
  const other = join(w, "..", "other");
  execFileSync("git", ["clone", "-q", join(w, "..", "origin.git"), other], { env: ENV });
  const head = commit(other, "work that really landed");
  git(other, "push", "-q", "origin", "main");

  const { code, json, stderr } = verify(w, "main", head);
  assert.equal(code, 0);
  assert.equal(json.reachable, true);
  // Exact, not a /fatal:/ sniff. Dropping `2>/dev/null` from three guards is
  // only safe while all three stay silent when they succeed, and this script's
  // stderr is read by the fleet controller. Anything git starts printing on an
  // ordinary run shows up here as a fourth line.
  assert.deepEqual(stderr.split("\n").filter(Boolean), [
    "$ git fetch --quiet origin main",
    `    origin/main tip = ${head}`,
    `    ${head} IS reachable on origin/main`,
  ]);
});

// No git fixture: the argc guard fires before the script runs any git at all,
// so the cwd never has to be a repository.
test("a wrong argument count is exit 2", () => {
  const r = spawnSync("sh", [SCRIPT, "main"], { cwd: tmpdir(), env: ENV, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: verify-sha\.sh/);
});

// --- #119: the payload's own string fields.
//
// `git check-ref-format --branch 'evil"branch'` exits 0 — git accepts a double
// quote in a ref — so pushing a branch is all the access this needs. Spliced
// raw, the script emitted `{"branch":"evil"branch",…}` at **exit 0**: an
// unparseable payload with no signal at all that anything went wrong, while the
// contract row in `docs/specs/2026-07-23-fleet-plugin-design.md` documents the
// exit-0/1 payload as `{branch, sha, reachable, tip}`.
//
// Two of the three are reachable, not one. `$tip` is `git rev-parse`, which
// emits 40 hex characters and nothing else, and is wrapped for uniformity. But
// `$sha` is not: it is argv, and `git cat-file -e "${sha}^{commit}"` resolves
// any rev expression rather than only a hex object name — a REF name included —
// so a tag or branch holding a quote passes that gate and reaches the payload.
// The second test below is that vector, and it fails without the wrapping.
test("a branch name holding a double quote still emits parseable JSON", (t) => {
  const w = repo(t);
  const head = commit(w, "work on a hostile branch name");
  git(w, "branch", 'evil"branch');
  git(w, "push", "-q", "origin", 'evil"branch');

  const r = spawnSync("sh", [SCRIPT, 'evil"branch', head], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 0, "the sha IS on that branch — the quote must not change the verdict");
  const json = JSON.parse(r.stdout);
  assert.equal(json.branch, 'evil"branch', "and the field round-trips to the name that went in");
  assert.equal(json.reachable, true);
  assert.equal(json.tip, head);
});

// The `$sha` half of the same vector. `git cat-file -e 'evil"tag^{commit}'`
// resolves the TAG, so argv reaches the payload carrying a quote and the field
// is emitted as `"sha":"evil"tag"` — unparseable, at exit 0 — with the wrapping
// removed. Pinned separately from `$branch` because the two are independent
// operands of the same `&&` chain and either could be dropped alone.
test("a sha argument naming a quote-bearing ref still emits parseable JSON", (t) => {
  const w = repo(t);
  const head = commit(w, "work reachable by a hostile tag name");
  git(w, "tag", 'evil"tag', head);
  git(w, "push", "-q", "origin", "main");

  const r = spawnSync("sh", [SCRIPT, "main", 'evil"tag'], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 0, "the tag IS reachable on origin/main — the quote must not change the verdict");
  const json = JSON.parse(r.stdout);
  assert.equal(json.sha, 'evil"tag', "and the field round-trips to the argument that went in");
  assert.equal(json.reachable, true);
});

// No backslash case here, deliberately: measured, `git branch 'back\slash'`
// and `git check-ref-format --branch 'back\slash'` both exit 128 — git refuses
// a backslash in a ref outright. A branch name is this script's ONLY string
// input, so `\` is unreachable and a test for it would pin fiction. The
// backslash vector is real on the scripts whose input is a worktree PATH.

test("an ordinary branch name is untouched — the escaping accepts what it should", (t) => {
  // The false-positive half. A guard that mangles or refuses the names this
  // script sees on every healthy run is a different bug from the one above.
  const w = repo(t);
  const head = commit(w, "ordinary");
  git(w, "branch", "fix/119-json-sh-extract");
  git(w, "push", "-q", "origin", "fix/119-json-sh-extract");

  const r = spawnSync("sh", [SCRIPT, "fix/119-json-sh-extract", head], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 0);
  assert.equal(r.stdout, `{"branch":"fix/119-json-sh-extract","sha":"${head}","reachable":true,"tip":"${head}"}\n`,
    "byte-identical to what this script has always emitted for a name with nothing to escape");
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run — measured, /bin/sh
// (macOS bash 3.2), bash 3.2 and `bash --posix` all exit 1 with the guard
// unfired. Exit 1 out of THIS script means `the sha is not reachable`, the one
// distinction it exists to make. A missing file must never be able to say that.
test("a missing json.sh is exit 2, never the exit 1 that means `not reachable`", (t) => {
  const w = repo(t);
  const head = commit(w, "work");
  git(w, "push", "-q", "origin", "main");
  const lone = mkdtempSync(join(tmpdir(), "verify-sha-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "verify-sha.sh"));

  const r = spawnSync("sh", [join(lone, "verify-sha.sh"), "main", head], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2,
    "a missing library is `the question could not be answered`. Exit 1 would report a sha that IS on the branch as missing from it, and the controller would reject a PR that is exactly where it claims to be.");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the fetch or the ref");
  assert.equal(r.stdout, "", "no payload: nothing was answered");
});
