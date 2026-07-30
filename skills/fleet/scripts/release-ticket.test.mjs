// Regression gate for release-ticket.sh, which deletes a claim's worktree and
// branch. Zero deps: `node --test skills/fleet/scripts/release-ticket.test.mjs`.
//
// It is guarded by four preconditions and every one of them is the only thing
// standing between a member's work and a delete, so each has a case here that
// proves it blocks ON ITS OWN — asserting the blocker it emits, not merely that
// the script exited non-zero, since any other precondition firing would satisfy
// that. Deleting a check must fail the case named after it.
//
// Real git throughout: a shell script that reasons about git history can only be
// tested against real git history. `gh` is the one thing stubbed, on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-ticket.sh", import.meta.url));
const INFLIGHT = fileURLToPath(new URL("./inflight.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixtures, so a
// local pull.rebase or hook cannot change what these repos look like. BASE_REF
// is unset for the reason prove-merge.test.mjs unsets it: the fleet harness is
// exactly the caller that has it set, and inheriting it would point every
// fixture at a local main while the suite stayed green.
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

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Commit `content` as f.txt on the current branch; returns its sha. */
const commit = (w, msg, content) => {
  writeFileSync(join(w, "f.txt"), content);
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/**
 * Bare origin + working clone with one commit on main, plus a `gh` stub on
 * PATH. Returns the clone dir, the stub's call log path, and an env builder.
 */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "release-ticket-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root", "root\n");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");

  // The stub answers the two calls release-ticket.sh makes and the two
  // inflight.sh makes, keyed on the whole argument line because both scripts
  // reach GitHub through `gh issue view`. GH_RC turns any call into a failure.
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const log = join(root, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
[ "\${GH_RC:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit "\$GH_RC"; }
case "$*" in
  *closedByPullRequestsReferences*) ;;
  *"--json labels"*) printf '%s\\n' "\${GH_LABELS-in-progress}" ;;
  *"pr list"*) printf '[]\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(log, "");

  return {
    w,
    log,
    env: (extra = {}) => ({ ...ENV, PATH: `${bin}:${ENV.PATH ?? process.env.PATH}`, ...extra }),
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
}

/** What claim-ticket.sh leaves behind: a worktree on a fresh branch off origin/main. */
function claim(w, issue, slug, type = "fix") {
  const branch = `${type}/${issue}-${slug}`;
  const wt = join(w, ".worktrees", `${issue}-${slug}`);
  git(w, "worktree", "add", "-q", wt, "-b", branch, "origin/main");
  return { branch, wt, args: [String(issue), slug, type] };
}

function release(r, c, { apply = true, env = {} } = {}) {
  const argv = apply ? [...c.args, "--apply"] : c.args;
  const res = spawnSync("sh", [SCRIPT, ...argv], {
    cwd: r.w,
    env: r.env(env),
    encoding: "utf8",
  });
  return {
    code: res.status,
    json: res.stdout.trim() ? JSON.parse(res.stdout) : null,
    stderr: res.stderr,
  };
}

/** Does the claim still exist on disk and in git? */
const artefacts = (r, c) => ({
  dir: existsSync(c.wt),
  worktree: git(r.w, "worktree", "list", "--porcelain").includes(`branch refs/heads/${c.branch}`),
  branch: git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes(c.branch),
});

test("a clean undispatched claim releases all three artefacts", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "fixture");

  const { code, json } = release(r, c);
  assert.equal(json.released, true);
  assert.deepEqual(json.blockers, []);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
  assert.ok(
    r.calls().includes(`issue edit 9 --remove-label in-progress`),
    `the label is the half that hides the ticket from candidates.mjs: ${r.calls()}`,
  );
});

test("after a release the in-flight probe no longer reads the ticket as taken", (t) => {
  // The acceptance criterion, measured against the real consumer rather than
  // against this test's idea of one: inflight.sh, the script phase 0 runs.
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("inflight.sh needs python3");
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const probe = () => spawnSync("sh", [INFLIGHT, "9"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  assert.equal(probe().status, 1, "fixture: the claim really does read as taken first");

  assert.equal(release(r, c).code, 0);
  assert.equal(probe().status, 0, "a released ticket must go back into the pool");
});

test("a commit already upstream-equivalent still blocks: `ahead` catches what `git cherry` cannot", (t) => {
  // The case that proves the two commit checks are not one check written twice.
  // The branch's patch has been cherry-picked onto main, so `git cherry` calls it
  // equivalent and emits `-`; only the ahead count still sees the local commit.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const sha = commit(c.wt, "the member's work", "work\n");
  // -x, so the upstream copy is a distinct commit. A plain cherry-pick here
  // reproduces the branch commit byte for byte — same tree, parent, message and
  // second — and lands on the same sha, which is a different fixture entirely.
  git(r.w, "cherry-pick", "-x", sha);
  git(r.w, "push", "-q", "origin", "main");
  git(r.w, "fetch", "-q", "origin");
  assert.equal(
    git(r.w, "cherry", "origin/main", `refs/heads/${c.branch}`).charAt(0),
    "-",
    "fixture: git cherry really does read this commit as upstream-equivalent",
  );

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `only the ahead check can fire here: ${json.blockers}`);
  assert.match(json.blockers[0], /1 commit\(s\) ahead of/);
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a commit that exists nowhere else blocks, and `git cherry` says so", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "the member's work", "work\n");

  const { code, json } = release(r, c);
  assert.ok(
    json.blockers.some((b) => /unique to .* \(git cherry\)/.test(b)),
    `the cherry check must report the commit as its own finding: ${json.blockers}`,
  );
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a dirty worktree blocks on its own", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `no commit exists, so only the dirty check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /1 uncommitted change\(s\)/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a pushed branch blocks on its own", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "push", "-q", "origin", c.branch);

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `the tree is clean and empty, so only the remote check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /exists on origin/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("an unreachable remote is an unknown answer, never a 'not pushed'", (t) => {
  // Swallowing this failure reads as "no remote branch" and releases a claim
  // whose work is already on the server.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "remote", "set-url", "origin", join(r.w, "..", "definitely-not-a-repo"));

  const { code, json, stderr } = release(r, c);
  assert.equal(json, null);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 1 that means blocked");
  assert.match(stderr, /whether .* was pushed is unknown/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a gh failure aborts before anything is deleted", (t) => {
  // The label is read first on purpose: a release that removes the worktree and
  // branch but leaves in-progress hides the ticket from candidates.mjs entirely.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, stderr } = release(r, c, { env: { GH_RC: "1" } });
  assert.equal(code, 2);
  assert.match(stderr, /in-progress label cannot be released/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("the agent-test runner claim-ticket.sh writes is not dirt", (t) => {
  // Every fleet worktree carries it, and it is gitignored. Treating an ignored
  // file as dirt would block every release the drain step exists to make.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  appendFileSync(join(r.w, ".git", "info", "exclude"), "agent-test\n");
  writeFileSync(join(c.wt, "agent-test"), "#!/bin/sh\nexec npm test -- \"$@\"\n", { mode: 0o755 });

  const { code, json } = release(r, c);
  assert.deepEqual(json.blockers, []);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("a dry run reports the release without performing it", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json, stderr } = release(r, c, { apply: false });
  assert.deepEqual([json.released, json.applied, code], [true, false, 0]);
  assert.match(stderr, /DRY RUN/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true });
  assert.ok(!r.calls().some((l) => l.startsWith("issue edit")), `dry run must not write: ${r.calls()}`);
});

test("a mistyped slug refuses instead of dropping the label off a live claim", (t) => {
  const r = repo(t);
  claim(r.w, 9, "release-ticket");

  const res = spawnSync("sh", [SCRIPT, "9", "relase-tikcet", "fix", "--apply"], {
    cwd: r.w, env: r.env(), encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /check the <slug> and <type> arguments/);
  assert.deepEqual(r.calls(), [], "not even a read, let alone the label edit");
});

test("an already-dropped label still releases the worktree and branch", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c, { env: { GH_LABELS: "" } });
  assert.deepEqual([json.label, json.released, code], [false, true, 0]);
  assert.ok(!r.calls().some((l) => l.startsWith("issue edit")), "nothing to remove, so no write");
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("the script carries no escape hatch", () => {
  // `git worktree remove --force` discards uncommitted work and `git branch -D`
  // deletes commits that exist nowhere else — the two calls that make
  // commit-commands:clean_gone unusable here, and the two a future edit would
  // reach for the first time a precondition refuses.
  const src = readFileSync(fileURLToPath(new URL("./release-ticket.sh", import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(src, /--force/);
  assert.doesNotMatch(src, /branch\s+-D/);
});

test("usage errors exit 2", (t) => {
  const r = repo(t);
  const bad = (...a) => spawnSync("sh", [SCRIPT, ...a], { cwd: r.w, env: r.env(), encoding: "utf8" }).status;
  assert.equal(bad("9"), 2, "too few arguments");
  assert.equal(bad("nine", "slug", "fix"), 2, "issue must be a number");
});
