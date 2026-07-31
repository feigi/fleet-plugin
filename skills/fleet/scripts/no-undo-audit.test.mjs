// Regression gate for no-undo-audit.sh's refusal condition. Zero deps:
// `node --test skills/fleet/scripts/no-undo-audit.test.mjs`.
//
// The audit answers one question — is this worktree safe to rebase — and the
// only thing that makes it refuse is uncommitted work in the worktree.
// (Exit 2 is its own outcome: the question could not be answered at all.) It
// used to also refuse on a nonzero repo-global stash count, which is unrelated
// to that question: a rebase never consumes a pre-existing entry, so the count
// refused every run in a repo holding any entry while proving nothing about the
// branch.
//
// Both directions are pinned here, because a fix for a false refusal is one
// keystroke from deleting the true one.
//
// Real git throughout: a shell script that reasons about git state can only be
// tested against real git state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./no-undo-audit.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixtures, so a
// local pull.rebase or hook cannot change what these repos look like. BASE_REF
// is unset because the fleet harness is exactly the caller that would have it
// set, and inheriting it would point every fixture at a local main while the
// suite stayed green.
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
  // GIT_CONFIG_GLOBAL alone does not isolate: these two carry config in through
  // a separate door and outrank the files. A suite run from inside a git hook
  // inherits whatever set them, which is a false red nobody can reproduce by
  // hand.
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Bare origin + clone with `main` and a pushed feature branch, checked out. */
function repo(t, branch = "fix/1-thing", prefix = "no-undo-audit-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  writeFileSync(join(w, "f.txt"), "root\n");
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  git(w, "checkout", "-q", "-b", branch);
  writeFileSync(join(w, "g.txt"), "branch work\n");
  git(w, "add", "g.txt");
  git(w, "commit", "-q", "-m", "branch work");
  git(w, "push", "-q", "-u", "origin", branch);
  return { w, branch };
}

/** Leave a stash entry behind without leaving the worktree dirty. */
function stashSomething(w, name = "h.txt") {
  writeFileSync(join(w, name), "stashed\n");
  git(w, "add", name);
  git(w, "stash", "push", "-q", "-m", `pre-existing ${name}`);
}

/** Add/add conflict on `path`, with main holding the later commit that made it. */
function conflictRepo(t, path) {
  const c = repo(t);
  writeFileSync(join(c.w, path), "branch side\n");
  git(c.w, "add", "--", path);
  git(c.w, "commit", "-q", "-m", "branch edits the file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, path), "MAIN SIDE\n");
  git(c.w, "add", "--", path);
  git(c.w, "commit", "-q", "-m", "MAIN COMMIT AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  return c;
}

// The payload is parsed here rather than at the call site: "the audit passed and
// then the caller crashed on its own stdout" is a distinct outcome from "the
// audit refused", and a test cannot tell them apart if the parse throws inside
// the helper that also reports the exit code.
const audit = ({ w, branch }, env = ENV) => {
  const r = spawnSync("sh", [SCRIPT, w, branch], { cwd: w, env, encoding: "utf8" });
  const out = r.stdout.trim();
  let json = null;
  let jsonError = null;
  if (out) {
    try {
      json = JSON.parse(out);
    } catch (e) {
      jsonError = e;
    }
  }
  return { ...r, json, jsonError };
};

test("a pre-existing stash does not refuse a clean worktree", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture must leave the worktree clean");
  assert.equal(git(c.w, "stash", "list").split("\n").filter(Boolean).length, 1, "fixture must leave one stash");

  const r = audit(c);
  assert.equal(r.status, 0, `a stash the rebase will not consume must not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
  assert.equal(r.json.stash, 1, "the count is still reported, just not gated on");
  assert.doesNotMatch(r.stderr, /REFUSED/);
});

test("several pre-existing stashes still do not refuse", (t) => {
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  stashSomething(c.w, "h2.txt");
  stashSomething(c.w, "h3.txt");

  const r = audit(c);
  assert.equal(r.status, 0, "the refusal must not scale with the count either");
  assert.equal(r.json.stash, 3);
});

test("a dirty worktree still refuses, and names the worktree not the stash", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work that exists nowhere else\n");

  const r = audit(c);
  assert.equal(r.status, 1, "uncommitted work is the whole point of this audit");
  assert.equal(r.json.clean, false);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /commit the worktree before rebasing/);
  // The old message told the caller to clear the stash list and forbade
  // `git stash drop` two lines later. Removing the gate must remove the
  // instruction, or the contradiction outlives the bug.
  assert.doesNotMatch(r.stderr, /stash-list-clear/);
  // `git stash`, not `git stash drop`: stashing to clear a dirty worktree now
  // leaves `clean` true, so this line is the only thing in the repo forbidding
  // a maneuver nothing detects. Narrowing it back to `drop` reads like a
  // consistency fix and silently reopens the hole.
  assert.match(r.stderr, /`git stash` to make a rebase start/);
});

test("a dirty worktree refuses with an empty stash stack", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");
  assert.equal(git(c.w, "stash", "list"), "", "fixture must leave no stash");

  const r = audit(c);
  assert.equal(r.status, 1, "clean is the sole gate — it must fire on its own");
  assert.equal(r.json.stash, 0);
});

test("a clean worktree with no stash passes", (t) => {
  const c = repo(t);
  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.json.clean, true);
  assert.equal(r.json.stash, 0);
});

// `clean` is now the sole gate, so a `git status` that fails must not read as a
// clean worktree. It used to have an accidental backstop: a repo holding any
// stash refused anyway, whatever `status` did. That backstop left with the gate.
test("a git status that fails is unanswerable (2), never clean (0)", (t) => {
  if (process.getuid?.() === 0) return; // root reads a 000 file regardless
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work that exists nowhere else\n");
  chmodSync(join(c.w, ".git", "index"), 0o000);

  const r = audit(c);
  assert.equal(r.status, 2, "an unreadable index cannot answer the question — it must not answer 'clean'");
  assert.match(r.stderr, /cannot tell a clean worktree from a dirty one/);
  assert.doesNotMatch(r.stdout, /"clean":true/);
});

test("a dirty worktree refuses even when a stash is also present", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");

  const r = audit(c);
  assert.equal(r.status, 1, "the stash must not mask the dirty check, in either direction");
  assert.equal(r.json.clean, false);
  assert.equal(r.json.stash, 1);
});

// ---------------------------------------------------------------------------
// conflicts[] and atRisk[]. The refusal above is only half the audit: a clean
// worktree still exits 0 while answering "what would a careless resolution
// eat", and that answer had no coverage at all.
// ---------------------------------------------------------------------------

// One path carries both failures, because they compound. The space made the
// pathspec word-split into `has` + `space.txt`, so `atRisk` came back empty on
// a branch that really was about to eat a commit — a false safe, which is the
// one outcome this script exists to prevent. The quote made the payload
// unparseable, on exit 0, so a caller that got as far as reading the answer
// crashed instead. A path that git has to quote also proves the paths reaching
// the caller are real paths and not git's C-quoted rendering of them.
test("a conflicting path with a space and a quote still names the commits at risk", (t) => {
  const path = 'has"quote and space.txt';
  const c = conflictRepo(t, path);

  const fork = git(c.w, "merge-base", "origin/main", `origin/${c.branch}`);
  const truth = git(c.w, "log", "--oneline", `${fork}..origin/main`, "--", path);
  assert.equal(truth.split("\n").filter(Boolean).length, 1, "fixture must put exactly one main commit at risk");

  const r = audit(c);
  assert.equal(r.status, 0, `a clean worktree passes even with conflicts; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `a passing audit must emit parseable JSON; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.deepEqual(r.json.conflicts, [path], "the real path, not git's C-quoted rendering of it");
  assert.equal(r.json.atRisk.length, 1, `main's commit is at risk and must be named; ground truth was ${truth}`);
  assert.match(r.json.atRisk[0], /MAIN COMMIT AT RISK/);
  assert.match(r.stderr, /at risk: /);
});

// Same question, asked the other way: an ordinary path must not regress while
// the quoted one is being fixed.
test("a plain conflicting path names the commits at risk", (t) => {
  const c = conflictRepo(t, "plain.txt");

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.conflicts, ["plain.txt"]);
  assert.equal(r.json.atRisk.length, 1);
});

// A commit subject is free text, so it reaches the payload with whatever the
// author typed. `\` matters as much as `"`: escaping the quote first and the
// backslash second turns `\` into `\\` twice over, so the order is load-bearing
// and only a subject holding both can tell a correct pipeline from that one.
test("a quote and a backslash in a commit subject keep the payload parseable", (t) => {
  const c = conflictRepo(t, "plain.txt");
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "plain.txt"), "MAIN AGAIN\n");
  git(c.w, "commit", "-q", "-am", 'fix: the "quoted" back\\slash case');
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.ok(
    r.json.atRisk.some((l) => l.includes('the "quoted" back\\slash case')),
    `the subject must survive escaping verbatim; got ${JSON.stringify(r.json.atRisk)}`,
  );
});

// git accepts `"` in a ref name and every byte but NUL and `/` in a path
// component, so both of these are names a caller can really hand over. `\` is
// rejected in a ref but legal in a path, which is why the backslash rides on
// the worktree.
test("a quote in the branch and a backslash in the worktree path keep the payload parseable", (t) => {
  const c = repo(t, 'fix/1-say"hi', 'no-undo-audit-back\\slash-say"hi-');

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.branch, 'fix/1-say"hi');
  assert.equal(r.json.worktree, c.w);
});

// ---------------------------------------------------------------------------
// Exit 2. Every one of these is "the question could not be answered"; none of
// them may reach the payload, because a payload is an answer.
// ---------------------------------------------------------------------------

// `rev-parse --verify` resolves a tag to an object of ANY type, so a tag on a
// blob walks straight past it and into merge-tree, which refuses to merge it.
// git 2.50.1 spends exit 1 on that refusal — the same code it spends on "ran
// fine, found conflicts" — so the exit code alone cannot tell them apart and
// the audit used to print `"conflicts":[],"atRisk":[]` and exit 0. Safe, on a
// question it never asked.
test("a BASE_REF that dereferences to a blob is unanswerable (2), never safe (0)", (t) => {
  const c = repo(t);
  const blob = git(c.w, "hash-object", "-w", "f.txt");
  git(c.w, "tag", "blobtag", blob);
  assert.equal(git(c.w, "rev-parse", "--verify", "--quiet", "blobtag"), blob, "fixture must pass the rev-parse guard");

  const r = audit(c, { ...ENV, BASE_REF: "blobtag" });
  assert.equal(r.status, 2, `merge-tree could not answer; got ${r.status} with stdout ${r.stdout}`);
  assert.doesNotMatch(r.stdout, /"conflicts"/, "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /cannot determine conflicts/);
});

test("every unanswerable precondition exits 2 and emits no payload", (t) => {
  const c = repo(t);
  const plain = mkdtempSync(join(tmpdir(), "no-undo-audit-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));

  const cases = [
    ["too few arguments", [c.w], ENV, /usage:/],
    ["too many arguments", [c.w, c.branch, "extra"], ENV, /usage:/],
    ["worktree does not exist", [join(c.w, "nope"), c.branch], ENV, /does not exist/],
    ["not a git worktree", [plain, c.branch], ENV, /is not a git worktree/],
    ["branch never pushed", [c.w, "never-pushed"], ENV, /origin\/never-pushed does not resolve/],
    ["BASE_REF does not resolve", [c.w, c.branch], { ...ENV, BASE_REF: "no/such/ref" }, /does not resolve/],
  ];

  for (const [why, args, env, re] of cases) {
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: c.w, env, encoding: "utf8" });
    assert.equal(r.status, 2, `${why}: expected 2, got ${r.status} — ${r.stderr}`);
    assert.match(r.stderr, re, why);
    assert.equal(r.stdout, "", `${why}: an unanswerable audit must not emit a payload`);
  }
});

// ---------------------------------------------------------------------------
// Dirty means dirty. Every fixture above leaves an untracked file, which is the
// one form `status --porcelain` reports with no index involved at all.
// ---------------------------------------------------------------------------

test("a modified tracked file refuses, like an untracked one", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "f.txt"), "edited in place, committed nowhere\n");
  // `git` trims, and porcelain spends its first column on the index — so the
  // status this fixture needs is ` M`, read here with that column already gone.
  assert.equal(git(c.w, "status", "--porcelain"), "M f.txt", "fixture must modify a tracked file, unstaged");

  const r = audit(c);
  assert.equal(r.status, 1, "an edit to a tracked file exists nowhere else either");
  assert.equal(r.json.clean, false);
});

test("a staged change refuses", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "staged.txt"), "staged, never committed\n");
  git(c.w, "add", "staged.txt");
  assert.equal(git(c.w, "status", "--porcelain"), "A  staged.txt", "fixture must stage without committing");

  const r = audit(c);
  assert.equal(r.status, 1, "the index is not a commit — a rebase does not carry it");
  assert.equal(r.json.clean, false);
});
