import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// derive-testcmd.sh is the ONE reader of a repository's Recipe cache (ADR
// 0015) — reused by claim-ticket.sh and review-core.mjs's snapshot agent. It
// infers nothing: no fixture here carries a package.json, a lockfile or a
// test-file naming convention, because none of them can change its answer.
const SCRIPT = join(import.meta.dirname, "derive-testcmd.sh");

// Fixture construction must not inherit an ambient GIT_DIR (the #1020 case
// below sets one deliberately, for the SCRIPT only): under one, `git init`
// re-inits whatever it names and the fixture is built nowhere.
const FIXTURE_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: FIXTURE_ENV, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git("commit", "-q", "--allow-empty", "-m", "x");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "files");
  return { dir, head: git("rev-parse", "HEAD").trim() };
}

// A proven Recipe: every field the reader requires, the proof included.
const recipe = (head, over = {}) => ({
  install: "true",
  test: "sh ./run-tests.sh",
  derivedAt: head,
  installClean: true,
  testCount: 3,
  ...over,
});

function cache(dir, body) {
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  writeFileSync(join(dir, ".fleet", "recipe.json"), typeof body === "string" ? body : JSON.stringify(body));
}

function derive(dir, field = "test", env = process.env, cwd = tmpdir()) {
  const r = spawnSync("sh", [SCRIPT, dir, field], { encoding: "utf8", env, cwd });
  return { status: r.status, out: r.stdout.replace(/\n$/, ""), err: r.stderr };
}

// Every refusal that sends its reader to re-derive must say WHICH step does
// that — the controller or reviewer reading it has no other pointer.
const NAMES_STEP = /run the Recipe derivation step \(run-team phase 0, before the first claim — ADR 0015\)/;

test("a proven cache yields the requested command, verbatim, and nothing on stderr", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { install: "true", test: `sh -c 'echo "a b"'` }));
  const t = derive(dir, "test");
  assert.equal(t.status, 0, t.err);
  assert.equal(t.out, `sh -c 'echo "a b"'`, "quotes and spaces reach the caller untouched");
  assert.equal(t.err, "");
  const i = derive(dir, "install");
  assert.equal(i.status, 0, i.err);
  assert.equal(i.out, "true");
});

test("an absent cache refuses, naming the derivation step — never an inference", () => {
  // A tree that the pre-ADR-0015 inference would have ACCEPTED (a Node test
  // file) is refused all the same: nothing about the tree is consulted.
  const { dir } = repo({ "t.test.mjs": "" });
  const r = derive(dir);
  assert.equal(r.status, 1);
  assert.equal(r.out, "", "no command it could not read");
  assert.match(r.err, /^derive-testcmd: no Recipe cache at .*\/\.fleet\/recipe\.json — refusing to infer/);
  assert.match(r.err, NAMES_STEP);
});

test("a linked worktree reads the main checkout's cache, not a private one", () => {
  // The two consumers both hand a WORKTREE in: review-core's snapshot agent
  // passes the PR's worktree, and a claim's tree is one. The cache lives
  // once, beside the common git dir, like the ledger.
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const wt = join(mkdtempSync(join(tmpdir(), "derive-wt-")), "wt");
  execFileSync("git", ["worktree", "add", "-q", "--detach", wt], { cwd: dir, stdio: "pipe", env: FIXTURE_ENV });
  const r = derive(wt);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "true");
});

test("wrong argument count and an unknown field refuse with a usage message", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head));
  for (const argv of [[], [dir], [dir, "test", "extra"]]) {
    const r = spawnSync("sh", [SCRIPT, ...argv], { encoding: "utf8" });
    assert.equal(r.status, 1, JSON.stringify(argv));
    assert.match(r.stderr, /usage: derive-testcmd\.sh <repo> <install\|test>/);
  }
  const r = derive(dir, "derivedAt");
  assert.equal(r.status, 1);
  assert.match(r.err, /unknown Recipe field 'derivedAt' — expected install or test/);
});

test("a non-repository directory refuses cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-not-a-repo-"));
  const r = derive(dir);
  assert.equal(r.status, 1);
  assert.match(r.err, /is not a git repository/);
});

// Each row breaks exactly one requirement of a PROVEN Recipe; each must be
// refused with its own reason and the derivation step, and none may leak a
// command out of a cache the checks did not pass.
test("an unparseable or unproven cache refuses, naming what is missing", (t) => {
  const { dir, head } = repo();
  const rows = [
    ["{not json", /it does not parse/],
    ["[]", /it is not a JSON object/],
    [recipe(head, { install: undefined }), /`install` is not a non-empty command string/],
    [recipe(head, { test: "   " }), /`test` is not a non-empty command string/],
    [recipe(head, { test: 7 }), /`test` is not a non-empty command string/],
    [recipe(head, { derivedAt: "main" }), /`derivedAt` is not a full commit id/],
    [recipe(head, { derivedAt: head.slice(0, 12) }), /`derivedAt` is not a full commit id/],
    [recipe(head, { installClean: undefined }), /`installClean` is not true/],
    [recipe(head, { installClean: "true" }), /`installClean` is not true/],
    [recipe(head, { testCount: 0 }), /no proof of real tests/],
    [recipe(head, { testCount: 2.5 }), /no proof of real tests/],
    [recipe(head, { testCount: undefined, mutation: "" }), /no proof of real tests/],
  ];
  for (const [body, why] of rows) {
    cache(dir, body);
    for (const field of ["test", "install"]) {
      const r = derive(dir, field);
      const label = `${field} from ${typeof body === "string" ? body : JSON.stringify(body)}`;
      assert.equal(r.status, 1, label);
      assert.equal(r.out, "", label);
      assert.match(r.err, /the Recipe cache at .* is unusable: /, label);
      assert.match(r.err, why, label);
      assert.match(r.err, NAMES_STEP, label);
    }
  }
});

// The must-ACCEPT half of the proof rules: either proof alone is enough, and
// a sha256 repository's 64-hex commit id is a full id too.
test("either proof alone is accepted, and so is a 64-hex commit id", () => {
  const { dir, head } = repo();
  for (const over of [
    { testCount: undefined, mutation: "flipped assert in t/a.test.js; suite went red" },
    { testCount: 1 },
    { derivedAt: head.padEnd(64, "0") },
  ]) {
    cache(dir, recipe(head, { ...over, test: "true" }));
    const r = derive(dir);
    assert.equal(r.status, 0, `${JSON.stringify(over)}: ${r.err}`);
    assert.equal(r.out, "true");
  }
});

// Invalid on failure to RUN (ADR 0015): a leading word that does not resolve
// from the repo is a stale Recipe, refused with the invalidation message.
test("a command whose binary is missing or not executable refuses as an invalid cache", () => {
  const { dir, head } = repo({ "run.sh": "#!/bin/sh\n" });
  chmodSync(join(dir, "run.sh"), 0o644);
  for (const [field, over, word] of [
    ["test", { test: "no-such-binary-2117 --all" }, "no-such-binary-2117"],
    ["install", { install: "no-such-installer-2117 ci" }, "no-such-installer-2117"],
    ["test", { test: "./run.sh" }, "./run.sh"],
    ["test", { test: "./missing.sh" }, "./missing.sh"],
    ["test", { test: "CI=1 LANG=C no-such-binary-2117" }, "no-such-binary-2117"],
  ]) {
    cache(dir, recipe(head, over));
    const r = derive(dir, field);
    assert.equal(r.status, 1, `${JSON.stringify(over)} must refuse`);
    assert.equal(r.out, "");
    assert.match(r.err, new RegExp(`is invalid: its ${field} command '${word.replace(/[.*]/g, "\\$&")}' is not found or not executable`));
    assert.match(r.err, NAMES_STEP);
  }
});

// The must-ACCEPT half of the run probe, which is where a guard like this
// goes wrong: every one of these RUNS, so refusing any would strand a repo on
// a Recipe that is fine. A failing suite (`false`) is a finding, not a stale
// Recipe — this script never runs the command, so it cannot tell and must
// not try. A relative script resolves from <repo>, not from the caller's cwd.
test("a runnable command is accepted, however it is spelled — and a failing suite is not a stale Recipe", () => {
  const { dir, head } = repo({ "run.sh": "#!/bin/sh\nexit 0\n" });
  chmodSync(join(dir, "run.sh"), 0o755);
  for (const cmd of [
    "./run.sh",
    "sh ./run-tests.sh",
    "false",
    "FOO=1 BAR=x ./run.sh --flag",
    "cd sub && make test",
    `"./my tests.sh"`,
    "$HOME/bin/runner",
    "node --test plugin/scripts/*.test.mjs",
  ]) {
    cache(dir, recipe(head, { test: cmd }));
    const r = derive(dir, "test", process.env, tmpdir());
    assert.equal(r.status, 0, `${cmd}: ${r.err}`);
    assert.equal(r.out, cmd);
  }
});

test("a command of assignments alone names nothing to run and refuses", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "CI=1 FOO=2" }));
  const r = derive(dir);
  assert.equal(r.status, 1);
  assert.match(r.err, /its test command names no command, only assignments/);
});

// --- #1020: the ambient GIT_DIR that outranks `-C "$repo"`. Under it,
// `--git-common-dir` answers for the OTHER repository, and the cache read is
// that repository's Recipe reported as this one's.
test("an ambient GIT_DIR does not read another repository's Recipe (#1020)", () => {
  const here = repo();
  cache(here.dir, recipe(here.head, { test: "true" }));
  const elsewhere = repo();
  cache(elsewhere.dir, recipe(elsewhere.head, { test: "false" }));
  assert.equal(derive(elsewhere.dir).out, "false", "fixture: the other repo must answer differently");

  const r = derive(here.dir, "test", { ...process.env, GIT_DIR: join(elsewhere.dir, ".git") });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "true", "an ambient GIT_DIR must not answer for another repository");
});

// --- #1175: the cross-file invariant claim-ticket.sh's captures rest on. It
// captures THIS script with stderr merged and runs the result on its success
// path, so any byte this script writes to stderr on success becomes part of
// the Install step it runs and the Test entrypoint it bakes into the runner.
// NODE_DEBUG makes the validator's own interpreter chatty; the positive
// control proves the env is not inert.
test("the success path writes nothing to stderr, even when node is chatty (#1175)", () => {
  const CHATTY = { ...process.env, NODE_DEBUG: "module" };
  const control = spawnSync("node", ["-e", "0"], { encoding: "utf8", env: CHATTY });
  assert.ok(control.stderr.length > 0, "fixture: NODE_DEBUG=module must make node write to stderr");

  const { dir, head } = repo();
  cache(dir, recipe(head, { install: "true", test: "true" }));
  for (const field of ["install", "test"]) {
    const r = derive(dir, field, CHATTY);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "true");
    assert.equal(r.err, "", `the ${field} success path must write nothing to stderr`);
  }
});

// --- #1141: an unusable interpreter is named as itself, never as a corrupt
// cache. PATH is REPLACED with links to exactly what the script runs, so the
// interpreter is really unreachable rather than shadowed.
const SHIMMED = ["sh", "git", "mktemp", "cat", "rm"];
function shimPath({ node }) {
  const bin = mkdtempSync(join(tmpdir(), "derive-path-"));
  for (const name of SHIMMED) {
    const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, name));
  }
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}

test("an unusable interpreter refuses in this script's own voice, never the cache's", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const absent = derive(dir, "test", { ...process.env, PATH: shimPath({ node: false }) });
  assert.equal(absent.status, 1);
  assert.equal(absent.out, "");
  assert.match(absent.err, /^derive-testcmd: node is unusable/);
  assert.doesNotMatch(absent.err, /is unusable: it does not parse/);

  // The false-positive control: the same stripped PATH with the interpreter
  // present reads the cache to completion, so the refusal above is about node
  // and not about a PATH too thin for the script to run at all.
  const present = derive(dir, "test", { ...process.env, PATH: shimPath({ node: true }) });
  assert.equal(present.status, 0, present.err);
  assert.equal(present.out, "true");
});
