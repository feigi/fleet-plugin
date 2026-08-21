import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// derive-testcmd.sh is the ONE place the test-entrypoint inference lives —
// reused by claim-ticket.sh (ref origin/main, worktree setup) and by
// review-pr.js's snapshot agent (ref HEAD, the repo under review), so the
// decision cannot drift between two independently-maintained copies (#142).
const SCRIPT = join(import.meta.dirname, "derive-testcmd.sh");

// A repo that is NOT claude-config. #142's own acceptance criterion is
// explicit that an archive OF this repo cannot prove the inference is
// portable — `claim-ticket.test.mjs`'s `repo()` already never checks out this
// repo either, for the same reason. Every fixture here is a synthetic tree.
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git("add", "-A");
  git("commit", "-qm", "x");
  return dir;
}

function derive(dir, ref = "HEAD") {
  const r = spawnSync("sh", [SCRIPT, dir, ref], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

const pkg = (o) => JSON.stringify(o);
const PASSES = 'import { test } from "node:test";\ntest("ok", () => {});\n';

test("a manifest declaring scripts.test wins", () => {
  const dir = repo({ "package.json": pkg({ scripts: { test: "vitest" } }) });
  const { status, out } = derive(dir);
  assert.equal(status, 0);
  assert.equal(out, "npm test --");
});

test("no scripts.test but test files present falls back to node --test", () => {
  const dir = repo({ "t.test.mjs": PASSES });
  const { status, out } = derive(dir);
  assert.equal(status, 0);
  assert.equal(out, "node --test");
});

test("neither a test script nor test files refuses rather than passing vacuously", () => {
  const dir = repo({ "README.md": "" });
  const { status, err } = derive(dir);
  assert.notEqual(status, 0);
  assert.match(err, /pass vacuously/);
});

test("a manifest with an empty scripts object falls back to the test-file check", () => {
  const dir = repo({ "package.json": pkg({ scripts: {} }), "t.test.mjs": PASSES });
  const { status, out } = derive(dir);
  assert.equal(status, 0);
  assert.equal(out, "node --test");
});

test("a non-repository directory refuses cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-not-a-repo-"));
  const { status, err } = derive(dir);
  assert.notEqual(status, 0);
  assert.match(err, /not a git repository/);
});

test("wrong argument count refuses with a usage message", () => {
  const dir = repo({ "README.md": "" });
  const r = spawnSync("sh", [SCRIPT, dir], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: derive-testcmd\.sh <repo> <ref>/);
});

// `node --test` marks its children with these; inherited, a nested run's
// stdout arrives empty and reads as `tests 0` — a false red for a run that
// never happened. FORCE_COLOR goes for the same reason and is the same fix
// claim-ticket.test.mjs applies to its own spawns: inherited, it reaches the
// child's `node --test`, which SGR-wraps its summary even into a pipe
// (`\x1b[34mℹ pass 1\x1b[39m`), and the `^(?:ℹ|#) …$` assertions below read
// that summary literally. A developer with FORCE_COLOR set is what these
// assertions have to survive, not exercise.
function withoutNestedTestMarkers() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.FORCE_COLOR;
  return env;
}

// Parsing which form the derivation picked is the same bet #142 exists to
// close — RUN what it derived, against a repo that is not this one, and read
// the actual count. Mirrors the rigor `claim-ticket.test.mjs` and the old
// `review-pr-testcmd.test.mjs` applied to this repo's own suite.
test("the derived npm command actually runs the manifest's tests", () => {
  const dir = repo({
    "package.json": pkg({ scripts: { test: "node --test" } }),
    "t.test.mjs": PASSES,
  });
  const { out } = derive(dir);
  assert.equal(out, "npm test --");
  const r = spawnSync(out, { cwd: dir, shell: true, encoding: "utf8", env: withoutNestedTestMarkers() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 1$/m);
});

test("the derived node --test command actually runs the repo's test files", () => {
  const dir = repo({ "t.test.mjs": PASSES, "sub/u.test.mjs": PASSES });
  const { out } = derive(dir);
  assert.equal(out, "node --test");
  const r = spawnSync(out, { cwd: dir, shell: true, encoding: "utf8", env: withoutNestedTestMarkers() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ran = r.stdout.match(/^(?:ℹ|#) tests (\d+)$/m);
  assert.ok(ran && Number(ran[1]) > 0, `ran no tests:\n${r.stdout}`);
});

// The ref argument is not decoration — a caller can point this at any commit
// in the repo, not only the working tree's checkout.
test("derives from the given ref, not just the latest commit", () => {
  const dir = repo({ "README.md": "" });
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "t.test.mjs"), PASSES);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "add tests"], { cwd: dir });

  const atBefore = derive(dir, before);
  assert.notEqual(atBefore.status, 0);
  assert.match(atBefore.err, /pass vacuously/);

  const atHead = derive(dir, "HEAD");
  assert.equal(atHead.status, 0);
  assert.equal(atHead.out, "node --test");
});

// A ref this repo cannot list is a DIFFERENT failure from "this ref has no
// tests", and the refusal has to say which. Piped into `grep -q`, a dying
// `ls-tree` was swallowed — the pipeline reports grep's status — so a repo
// that demonstrably HAS test files got the vacuous-pass refusal, naming a
// cause that is not the cause. review-pr.js forwards this stderr verbatim as
// `testCmdError`, so the review then refuses for the wrong reason.
test("a ref that cannot be listed names THAT, not a missing test suite", () => {
  const dir = repo({ "t.test.mjs": PASSES });
  const { status, err } = derive(dir, "nosuchref");
  assert.notEqual(status, 0);
  assert.match(err, /derive-testcmd: cannot list nosuchref/);
  assert.doesNotMatch(err, /pass vacuously/);
});

test("an unborn HEAD names the listing failure too", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-unborn-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const { status, err } = derive(dir, "HEAD");
  assert.notEqual(status, 0);
  assert.match(err, /derive-testcmd: cannot list HEAD/);
  assert.doesNotMatch(err, /pass vacuously/);
});

// A manifest that does not parse is not evidence of a manifest without a test
// script. Swallowed, this repo's real entrypoint (`vitest run`) was silently
// replaced by `node --test` and reported as a success — review-pr.js has no
// install step to trip over the same corruption later, so nothing downstream
// catches it. claim-ticket.sh already refuses on this same file for the
// dependency count it reads; both readers now agree.
test("a manifest that does not parse refuses instead of degrading to node --test", () => {
  const dir = repo({ "package.json": '{"scripts":{"test":"vitest run"},}', "t.test.mjs": PASSES });
  const { status, out, err } = derive(dir);
  assert.notEqual(status, 0);
  assert.equal(out, "");
  assert.match(err, /could not read HEAD:package\.json/);
  assert.doesNotMatch(err, /pass vacuously/);
});

// The two `testfile_re` literals cannot be one — claim-ticket.sh needs a shell
// string inside the runner heredoc it writes, not a git query — so the comment
// on each says "kept in sync by hand". This turns that promise into a checked
// invariant: adding a suffix to one copy alone previously left all 55 tests in
// this file, claim-ticket.test.mjs and review-pr-testcmd.test.mjs green, so
// "does a suite exist at all" could drift from "which files the runner picks
// up" in silence. Exactly the drift #142 exists to remove for testCmd itself.
test("derive-testcmd.sh and claim-ticket.sh declare the same testfile_re", () => {
  const literal = (file) => {
    const m = readFileSync(join(import.meta.dirname, file), "utf8").match(/^testfile_re=(.+)$/m);
    assert.ok(m, `${file} no longer declares testfile_re at the start of a line — update this test`);
    return m[1];
  };
  assert.equal(literal("derive-testcmd.sh"), literal("claim-ticket.sh"));
});
