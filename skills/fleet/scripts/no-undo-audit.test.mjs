// Regression gate for no-undo-audit.sh, all three of its outcomes. Zero deps:
// `node --test skills/fleet/scripts/no-undo-audit.test.mjs`.
//
// The audit answers one question — is this worktree safe to rebase — and the
// only thing that makes it refuse is uncommitted work in the worktree. It used
// to also refuse on a nonzero repo-global stash count, which is unrelated to
// that question: a rebase never consumes a pre-existing entry, so the count
// refused every run in a repo holding any entry while proving nothing about the
// branch. Both directions are pinned, because a fix for a false refusal is one
// keystroke from deleting the true one.
//
// The refusal is only half of it. A clean worktree exits 0 while still
// answering "what would a careless resolution eat", and everything below the
// `conflicts[] and atRisk[]` banner pins that half — the half that had no
// coverage at all while this file called itself the regression gate.
//
// Exit 2 is its own outcome: the question could not be answered. Its rule is
// that no payload is emitted, because a payload is an answer, and every exit-2
// test asserts that as well as the code. Reported safe on a question never
// asked is the one failure this script exists to prevent, so a shape it cannot
// answer must exit 2 rather than exit 0 with an empty `atRisk`.
//
// Real git throughout: a shell script that reasons about git state can only be
// tested against real git state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Two decoys make `atRisk` discriminating rather than merely nonempty. Without
// them every main commit since the fork touches the conflicting path and the
// root commit touches nothing else, so "filtered by path", "filtered by range"
// and "not filtered at all" all return exactly one line — and dropping either
// filter from the script leaves the suite green. DECOY_OLD is on the path but
// before the fork; DECOY_NEW is after the fork but on another file.
function conflictRepo(t, path) {
  const c = repo(t);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, path), "older, already shared\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "DECOY_OLD before the fork");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  git(c.w, "merge", "-q", "main", "-m", "carry main into the branch");
  writeFileSync(join(c.w, path), "branch side\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "branch edits the file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "decoy.txt"), "untouched by the conflict\n");
  git(c.w, "add", "--", "decoy.txt");
  git(c.w, "commit", "-q", "-m", "DECOY_NEW after the fork");
  writeFileSync(join(c.w, path), "MAIN SIDE\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "MAIN COMMIT AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  return c;
}

/** Both sides add `path`; nothing else. Used where the decoys would be noise. */
function bareConflictRepo(t, path) {
  const c = repo(t);
  writeFileSync(join(c.w, path), "branch side\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "branch edits the file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, path), "MAIN SIDE\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "MAIN COMMIT AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  return c;
}

/**
 * A linked worktree NESTED inside the clone, `.worktrees/` gitignored — the
 * fleet's own layout, and the only one where breaking the linkage is dangerous:
 * an enclosing repo is standing by to answer in the worktree's place, and being
 * clean it answers "nothing uncommitted here". A worktree with no repo above it
 * has nothing to walk up to, so git fails there and the script already refuses.
 * `precious.txt` is the uncommitted work that exists nowhere else.
 */
function nestedWorktree(t, branch = "fix/9-nested") {
  const c = repo(t);
  writeFileSync(join(c.w, ".gitignore"), ".worktrees/\n");
  git(c.w, "add", ".gitignore");
  git(c.w, "commit", "-q", "-m", "ignore the nested worktree");
  git(c.w, "push", "-q", "origin", c.branch);
  const w = join(c.w, ".worktrees", "9-x");
  git(c.w, "worktree", "add", "-q", "-b", branch, w);
  git(w, "push", "-q", "-u", "origin", branch);
  writeFileSync(join(w, "precious.txt"), "work that exists nowhere else\n");
  return { parent: c.w, w, branch };
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

/** `atRisk` with the abbreviated SHA stripped, so a test can pin the exact set. */
const subjects = (r) => r.json.atRisk.map((l) => l.replace(/^\S+ /, ""));

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
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"], `ground truth was ${truth}`);
  assert.match(r.stderr, /at risk: /);
});

// Same question, asked the other way: an ordinary path must not regress while
// the quoted one is being fixed.
test("a plain conflicting path names the commits at risk", (t) => {
  const c = conflictRepo(t, "plain.txt");

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.conflicts, ["plain.txt"]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"]);
});

// `--` ends the options, not the pathspec magic, so a real file named
// `:colon.txt` is parsed as a pathspec expression and matches nothing. Same
// false safe as the space, reached by a different byte, and `:(literal)` is
// what closes it.
test("a conflicting path that looks like pathspec magic names the commits at risk", (t) => {
  const path = ":colon.txt";
  const c = conflictRepo(t, path);

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.deepEqual(r.json.conflicts, [path]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"], "a leading `:` must be matched literally, not as magic");
});

// A commit subject is free text, so it reaches the payload with whatever the
// author typed. `\` matters as much as `"`: escaping the quote first and the
// backslash second turns `\` into `\\` twice over, so the order is load-bearing
// and only a subject holding both can tell a correct pipeline from that one.
// The \x01 rides along because git stores control bytes in a subject happily and
// JSON forbids them unescaped — dropping the scrub leaves the payload
// unparseable, which is this PR's own defect class one byte over.
test("a quote, a backslash and a control byte in a commit subject keep the payload parseable", (t) => {
  const c = conflictRepo(t, "plain.txt");
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "plain.txt"), "MAIN AGAIN\n");
  git(c.w, "commit", "-q", "-am", 'fix: the "quoted" back\\slash \x01 case');
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  assert.match(git(c.w, "log", "-1", "--pretty=%s", "origin/main"), /\x01/, "fixture must keep the control byte in the subject");

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.ok(
    r.json.atRisk.some((l) => l.includes('the "quoted" back\\slash   case')),
    `the subject must survive escaping verbatim, the control byte scrubbed to a space; got ${JSON.stringify(r.json.atRisk)}`,
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
// The section split reads an empty line as the end of the filename list, so a
// path holding a literal newline manufactures that marker: the list comes back
// short — sometimes empty — and the audit exits 0 saying nothing is at risk.
// git C-quoted such a path before `-z`, which at least emitted JSON the caller
// choked on, so answering "safe" here would be a strict downgrade. A shell
// variable cannot hold NUL, so the only honest answer is that there isn't one.
test("a conflicting path containing a newline is unanswerable (2), never safe (0)", (t) => {
  const c = bareConflictRepo(t, "lead\nline.txt");
  writeFileSync(join(c.w, "zz.txt"), "branch side\n");
  git(c.w, "add", "--", "zz.txt");
  git(c.w, "commit", "-q", "-m", "branch adds a second file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "zz.txt"), "MAIN SIDE\n");
  git(c.w, "add", "--", "zz.txt");
  git(c.w, "commit", "-q", "-m", "MAIN ALSO AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);

  const r = audit(c);
  assert.equal(r.status, 2, `got ${r.status} with stdout ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /contains a newline/);
});

// merge-tree refuses unrelated histories at exit 128. Note what this does NOT
// pin: that refusal also writes nothing, so `[ -s ]` alone catches it and the
// `mt_rc` half of the guard can be deleted with the suite staying green
// (measured). No reachable input produces a bad exit code AND output, so the
// code check is there for a git that prints the tree OID and then fails.
test("unrelated histories are unanswerable (2), never safe (0)", (t) => {
  const c = repo(t);
  git(c.w, "checkout", "-q", "--orphan", "orphan");
  git(c.w, "rm", "-rq", "--cached", ".");
  writeFileSync(join(c.w, "o.txt"), "no shared ancestor\n");
  git(c.w, "add", "--", "o.txt");
  git(c.w, "commit", "-q", "-m", "orphan root");
  git(c.w, "push", "-q", "origin", "orphan");
  git(c.w, "checkout", "-qf", "main");
  git(c.w, "clean", "-qfd");

  const r = audit({ w: c.w, branch: "orphan" });
  assert.equal(r.status, 2, `got ${r.status} with stdout ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /cannot determine conflicts/);
});

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

// The `is not a git worktree` case in the preconditions above passes a plain
// directory with no repo ANYWHERE above it, so `rev-parse --git-dir` fails and
// the script refuses. That is the harmless half. These two are the other half:
// `rev-parse --git-dir` WALKS UP, so with an enclosing repo present the gate
// passes at rc 0 having resolved a git dir that is not this worktree's, and
// `status --porcelain` then answers for that repo — empty, at rc 0, because the
// enclosing repo is clean and `.worktrees/` is gitignored. `clean:true` for a
// tree the script never looked at, with the work still sitting on disk. The
// `die` on a failing status is the wrong side of this: the command SUCCEEDS,
// it just answers about somewhere else.
//
// Both assert the refusal lands BEFORE the audit reports anything. Exit 2 alone
// would not pin it — a script that audits, prints "clean", and refuses
// afterwards has already put the wrong answer on the caller's screen.
function refusedAsUnknownBeforeAnySay(c) {
  assert.ok(existsSync(join(c.w, "precious.txt")), "fixture: the uncommitted work must still be on disk");
  assert.equal(git(c.parent, "status", "--porcelain"), "", "fixture: a CLEAN enclosing repo is what makes the leak answer 'clean'");
  assert.doesNotThrow(
    () => git(c.w, "rev-parse", "--git-dir"),
    "fixture: the script's own gate must still pass here, or this test pins nothing",
  );
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture: git answers for the enclosing repo — the manufactured clean this must refuse");

  const r = audit(c);
  assert.equal(r.status, 2, `got ${r.status} with stdout ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.doesNotMatch(r.stderr, /status --porcelain/, "the refusal must land before the audit runs, let alone reports");
  assert.match(r.stderr, /has no \.git of its own/);
}

test("a worktree whose .git was deleted is unanswerable (2), never clean (0)", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, ".git"));

  refusedAsUnknownBeforeAnySay(c);
});

// One byte over, and the reason the sibling guard in release-ticket.sh is `-f`
// rather than `-e`: an EMPTY `.git` DIRECTORY is something `-e` calls present,
// and git walks up past it exactly as it does past an absent one. `-f` alone
// cannot be borrowed here — `$wt` is whatever worktree the caller names, and a
// main checkout's `.git` is a directory, which is what every fixture in this
// file is.
test("a worktree whose .git is an empty directory is unanswerable (2), never clean (0)", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, ".git"));
  mkdirSync(join(c.w, ".git"));
  assert.ok(existsSync(join(c.w, ".git")), "fixture: `-e` must call this .git present, or it pins the case above again");

  refusedAsUnknownBeforeAnySay(c);
});

// ---------------------------------------------------------------------------
// Dirty means dirty. Every fixture above leaves an untracked file, which is the
// one form `status --porcelain` reports with no index involved at all.
// ---------------------------------------------------------------------------

// A payload that could not be written is not an answer, but the script's exit
// code is spent before the write: without a guard the failing `printf` exits 1
// under `set -e`, and 1 is "REFUSED, worktree dirty" — a clean worktree
// reported as dirty, with no payload to contradict it. Same shape as the guard
// inflight.sh carries on its own final printf.
test("a payload that cannot be written is unanswerable (2), never a refusal (1)", (t) => {
  const c = repo(t);

  // node cannot hand a child a closed fd 1, so sh closes it after the fork.
  const r = spawnSync("sh", ["-c", '"$0" "$@" >&-', SCRIPT, c.w, c.branch], {
    cwd: c.w,
    env: ENV,
    encoding: "utf8",
  });
  assert.equal(r.status, 2, `got ${r.status}; 1 would claim the worktree is dirty`);
});

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
