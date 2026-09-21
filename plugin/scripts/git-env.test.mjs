// This file covers both of git-env.mjs's exports. `gitEnv()` is the one place
// the scrub #1599 asks every `.mjs` git caller to route through;
// `workspaceDirFromGitCommonDir()` is the one place #1658 asks every caller
// that turns a `--git-common-dir` answer into a workspace directory to route
// through — see git-env.mjs's own header for why each is a helper rather than
// one more hand-spelled copy.
//
// What matters for gitEnv() is observable: the two names are gone from what
// it returns, everything else survives, an override cannot smuggle either
// name back in, and the input is never mutated — a caller passing
// `process.env` itself must not have it silently rewritten out from under
// every OTHER thing in this process that reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

test("GIT_DIR and GIT_WORK_TREE are absent from the result, even when the base carries them", () => {
  const base = { GIT_DIR: "/somewhere/.git", GIT_WORK_TREE: "/somewhere", PATH: "/bin" };
  const env = gitEnv({}, base);
  assert.equal("GIT_DIR" in env, false);
  assert.equal("GIT_WORK_TREE" in env, false);
  assert.equal(env.PATH, "/bin", "an unrelated var must survive the scrub");
});

test("a base carrying neither name is unaffected beyond the copy", () => {
  const base = { PATH: "/bin", LANG: "C" };
  assert.deepEqual(gitEnv({}, base), { PATH: "/bin", LANG: "C" });
});

test("overrides are merged in, alongside the scrub", () => {
  const base = { GIT_DIR: "/somewhere/.git", PATH: "/bin" };
  const env = gitEnv({ LC_ALL: "C", GH_REPO: "" }, base);
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.GH_REPO, "");
  assert.equal(env.PATH, "/bin");
  assert.equal("GIT_DIR" in env, false, "an override alongside the scrub must not resurrect it");
});

test("an override that itself names GIT_DIR or GIT_WORK_TREE cannot smuggle either back in", () => {
  // The deletes run AFTER the merge, precisely so a caller cannot defeat the
  // scrub by accident — an override map built from some other source that
  // happens to carry either key must not undo what this function exists to
  // do.
  const env = gitEnv({ GIT_DIR: "/attacker/.git", GIT_WORK_TREE: "/attacker" }, { PATH: "/bin" });
  assert.equal("GIT_DIR" in env, false);
  assert.equal("GIT_WORK_TREE" in env, false);
});

test("the base object passed in is never mutated", () => {
  const base = { GIT_DIR: "/somewhere/.git", GIT_WORK_TREE: "/somewhere", PATH: "/bin" };
  const before = { ...base };
  gitEnv({}, base);
  assert.deepEqual(base, before, "a caller passing its own long-lived object must get it back unchanged");
});

test("with no base given, process.env itself is read — not a frozen or empty stand-in", () => {
  const hadDir = "GIT_DIR" in process.env;
  const prevDir = process.env.GIT_DIR;
  process.env.GIT_DIR = "/ambient/.git";
  process.env.FLEET_GIT_ENV_PROBE = "present";
  try {
    const env = gitEnv();
    assert.equal("GIT_DIR" in env, false, "the real ambient GIT_DIR must be scrubbed, not merely a fixture's stand-in for it");
    assert.equal(env.FLEET_GIT_ENV_PROBE, "present", "an unrelated real process.env var must still come through by default");
  } finally {
    if (hadDir) process.env.GIT_DIR = prevDir; else delete process.env.GIT_DIR;
    delete process.env.FLEET_GIT_ENV_PROBE;
  }
});

// ---------------------------------------------------------------------------
// workspaceDirFromGitCommonDir() — the resolution the three callers of #1658
// used to hand-spell one apiece: ledger.mjs's defaultLedgerPath(),
// fleet-state.mjs's statePath() and board.mjs's resolveCockpitInstance().
// What is observable: which directory a given `--git-common-dir` answer
// names, that an answer carrying nothing is `null` rather than a
// plausible-looking path, and that canonicalisation is an opt-in the two
// non-board callers deliberately do not take.

test("an absolute --git-common-dir names the directory holding it", () => {
  assert.equal(workspaceDirFromGitCommonDir("/w/repo/.git", "/elsewhere"), "/w/repo");
});

test("a relative --git-common-dir resolves against the passed cwd, never process.cwd()", () => {
  // git answers this RELATIVE — a bare `.git` — when it runs from a
  // checkout's top level. A resolve() that reached for process.cwd() instead
  // would answer with this test runner's own checkout, which is a real path
  // and therefore a silent wrong answer rather than a failure.
  assert.equal(workspaceDirFromGitCommonDir(".git", "/w/repo"), "/w/repo");
});

test("a real git answer's trailing newline still resolves to the parent directory", () => {
  assert.equal(workspaceDirFromGitCommonDir("/w/repo/.git\n", "/w/repo"), "/w/repo");
});

// Three distinct shapes of "git told us nothing usable", one per way a caller
// can arrive here: `git` exited 0 with an empty stdout, it answered with a
// bare newline, and there was no stdout to read at all (a spawn that never
// ran, or one killed by its own timeout). All three must be `null` — the
// signal each call site's degrade arm branches on. A resolved-looking path
// here would put the run's ledger, its heartbeat or its board under whatever
// `dirname("")` happens to name.
for (const [label, value] of [["an empty answer", ""], ["a newline-only answer", "  \n"], ["no answer at all", undefined]]) {
  test(`${label} resolves to null, never a path`, () => {
    assert.equal(workspaceDirFromGitCommonDir(value, "/w/repo"), null);
  });
}

test("by default the answer is NOT canonicalised — a symlinked route keeps the spelling it arrived with", () => {
  // This default is what ledger.mjs and fleet-state.mjs read (#1658): both
  // PRINT the path they resolve — the ledger in `check`'s JSON and both in
  // their degrade warnings — so canonicalising for them would change their
  // output, not merely their code shape.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-ws-")));
  try {
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "repo"), join(root, "link"));
    assert.equal(workspaceDirFromGitCommonDir(join(root, "link", ".git"), root), join(root, "link"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonicalise: true collapses a symlinked route onto the one real workspace", () => {
  // board.mjs's opt-in, and the reason it has one: a second spelling of one
  // workspace derives a second port and a second state directory for a
  // cockpit already being served (#1582).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-ws-link-")));
  try {
    const real = join(root, "repo");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    const viaLink = workspaceDirFromGitCommonDir(join(link, ".git"), root, { canonicalise: true });
    assert.equal(viaLink, real, "the symlinked route must canonicalise onto the real workspace, not merely agree with itself");
    assert.equal(viaLink, workspaceDirFromGitCommonDir(join(real, ".git"), root, { canonicalise: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonicalise: true on a directory that does not exist answers the uncanonicalised path rather than throwing", () => {
  // A workspace removed out from under a running cockpit must not turn
  // resolution into a throw: the caller still gets a usable key, just an
  // uncanonicalised one.
  assert.equal(
    workspaceDirFromGitCommonDir("/no-such-root-1658/repo/.git", "/", { canonicalise: true }),
    "/no-such-root-1658/repo",
  );
});
