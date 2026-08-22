// Regression gate for staleness.mjs, the phase-0 probe that decides whether a
// shortlisted ticket is still live. Zero deps:
// `node --test skills/fleet/scripts/staleness.test.mjs`.
//
// A script that reasons about git history can only be tested against real git
// history, so every case below builds a throwaway bare origin plus a clone in
// a temp dir and runs the script for real — the same fixture idiom as
// `prove-merge.test.mjs`.
//
// THE LOAD-BEARING CASES ARE THE ONES THAT MUST STILL OFFER. A wrong `fixed`
// silently retires real supply, which is the harm #238's evidence criterion
// exists to prevent, and it is invisible: the ticket simply stops being
// shortlisted and nobody is told. So `never at this path answers unknown`,
// `untracked in origin/main answers unknown`, and `a fix that is only local
// answers live` each pin a case the probe must NOT report as fixed. The last
// of those is the one a probe written against the working tree passes anyway.
//
// `git unavailable answers unknown, never fixed` guards the exit code from the
// other end: Node exits 1 on an uncaught throw and 1 is `fixed` here, so any
// failure that escapes must not land there. staleness.mjs's outer catch is the
// backstop for the throws no CLI input can reach today — the reachable ones
// each have their own guard, and this case exercises the git-is-not-there
// branch of that set.
//
// THE CEILING: this pins the verdict each input earns and the evidence the
// `fixed` verdict carries. It does not pin the `why` wording, which is prose
// for a reader and is meant to be rewritable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./staleness.mjs", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase`, hook or template cannot change what these repos look
// like. The GIT_* redirects would point the fixtures out of their own temp
// dirs; the fleet harness is exactly the caller that has them set.
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
  LANG: "C",
  LC_ALL: "C",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Write `body` to `rel`, commit it, and return the commit sha. */
function commitFile(w, rel, body, msg) {
  writeFileSync(join(w, rel), body);
  git(w, "add", rel);
  git(w, "commit", "-q", "-m", msg);
  return git(w, "rev-parse", "HEAD");
}

/** Bare origin + working clone whose `main` is pushed. Returns the clone dir. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "staleness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commitFile(w, "src.mjs", "const keep = 1;\n", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

const push = (w) => git(w, "push", "-q", "origin", "main");

// process.execPath, not "node": one case runs with an empty PATH, and a bare
// "node" there is not found — the runner would die before the script does and
// the case would pass for the wrong reason.
function probe(cwd, args, env = ENV) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("a --present string the tree carries is fixed, and names the commit that added it", (t) => {
  const w = repo(t);
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nfunction decodeArgs() {}\n", "add the guard");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--present", "decodeArgs"]);
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "fixed");
  assert.equal(r.json.commit, sha, "the payload must name the commit a close would cite");
  assert.equal(r.json.subject, "add the guard", "the subject is what tells the reader the commit is about this");
});

// MUST STILL OFFER. A pin ticket whose assertion has not landed under this
// spelling stays live — including the case where an equivalent rewording did
// land, which reads the same way here and is a reason to offer, not to close.
test("a --present string the tree lacks is live", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--present", "decodeArgs"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.found, false);
});

test("a --gone string the tree still carries is live", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.found, true);
});

test("a --gone string a commit removed is fixed, and names the commit that removed it", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nconst right = 3;\n", "fix it in passing");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "fixed");
  assert.equal(r.json.commit, sha);
  assert.equal(r.json.subject, "fix it in passing");
});

// MUST STILL OFFER, and this is the positive control. Absent from the current
// file is the same output whether the fix landed or the probe was pointed at a
// spelling this file never used — so absent-AND-never-here is unknown, never
// fixed. Without this the probe closes a live ticket on a typo.
test("a --gone string that was never at this path answers unknown, never fixed", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "a spelling this file never had"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
  assert.equal(r.json.found, false);
});

// MUST STILL OFFER. The generated-artifact case: the file is right there on
// disk and untracked in origin/main, which is what `agent-test` looks like in
// every claimed worktree. Reading the on-disk copy would measure a snapshot
// frozen at claim time; reading the absence as a clean tree would close the
// ticket. Neither: unknown.
test("a path untracked in origin/main answers unknown even though the file is on disk", (t) => {
  const w = repo(t);
  writeFileSync(join(w, "generated"), "const wrong = 2;\n");
  assert.ok(existsSync(join(w, "generated")), "the fixture must put the decoy on disk");

  const r = probe(w, ["--path", "generated", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
  assert.equal(r.json.tracked, false, "the payload must say the path is untracked, not that the string is gone");
});

// MUST STILL OFFER. `origin/main`, never the working tree — a fix committed
// locally and not pushed is not in the tree the fleet dispatches against, and a
// probe that read the checkout would retire the ticket on work nobody else can
// see.
test("a --gone fix that is only local, never pushed, is still live", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);
  commitFile(w, "src.mjs", "const keep = 1;\nconst right = 3;\n", "local fix, unpushed");

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.found, true, "the string must be read out of origin/main, where it is still present");
});

// A tree read as a file greps a list of FILENAMES, and a needle absent from
// that list reads as clean.
test("a path that names a directory answers unknown", (t) => {
  const w = repo(t);
  mkdirSync(join(w, "sub"));
  commitFile(w, "sub/inner.mjs", "const wrong = 2;\n", "a file in a directory");
  push(w);

  const r = probe(w, ["--path", "sub", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
});

// The exit code from the other end: 1 means "provably fixed", and Node's own
// default for an uncaught throw is also 1. A probe that cannot run git at all
// must not land there.
test("git unavailable answers unknown, never fixed", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "const keep = 1;"], { ...ENV, PATH: "" });
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
});

// Neither mode given is a question the caller did not ask. Refusing beats
// picking a direction, because the wrong direction reports the opposite
// verdict with full confidence.
test("neither --gone nor --present refuses at exit 2 with no payload", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null, "a refusal must print no verdict at all");
  assert.match(r.stderr, /^\nstaleness: /m);
});

test("both --gone and --present refuses at exit 2 with no payload", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "a", "--present", "b"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null);
  assert.match(r.stderr, /opposite questions/);
});
