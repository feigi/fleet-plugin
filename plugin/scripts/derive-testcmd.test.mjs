import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from "./temp-dir.mjs";
import { join } from "node:path";
import { writeExecStub } from "./exec-stub.mjs";

// derive-testcmd.sh is the ONE reader of a repository's Recipe cache (ADR
// 0015) — reused by claim-ticket.sh and review-core.mjs's snapshot agent. It
// infers nothing: no fixture here carries a package.json, a lockfile or a
// test-file naming convention, because none of them can change its answer.
const SCRIPT = join(import.meta.dirname, "derive-testcmd.sh");

// The frame markers, read from the script itself rather than copied here: a
// behavior-preserving rename of derive-testcmd.sh's `open`/`close` values
// must not break a test whose only job is to prove the guard around them.
const FRAME_MATCH = readFileSync(SCRIPT, "utf8").match(/^open='([^']*)' close='([^']*)'/m);
if (!FRAME_MATCH) throw new Error("could not find the open/close frame markers in derive-testcmd.sh");
const [, FRAME_OPEN, FRAME_CLOSE] = FRAME_MATCH;

// Fixture construction must not inherit an ambient GIT_DIR (the #1020 case
// below sets one deliberately, for the SCRIPT only): under one, `git init`
// re-inits whatever it names and the fixture is built nowhere.
const FIXTURE_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function repo(files = {}) {
  const dir = tempDir("derive-testcmd-");
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
  const r = spawnSync("sh", [SCRIPT, dir, field], { encoding: "utf8", env, cwd, timeout: 30_000 });
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
  const wt = join(tempDir("derive-wt-"), "wt");
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
  const dir = tempDir("derive-testcmd-not-a-repo-");
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

// Both consumers append the runner's own arguments after this string
// textually (`exec sh -c '<cmd> "$@"' agent-test "$@"`), so a command ending
// in `;` or `&` lets a real shell read those arguments as an unrelated
// top-level command, and a `#`-led word swallows everything after it,
// arguments included, as a comment — neither failure is about whether the
// command runs, so it is refused here rather than left to fail at claim time.
test("a command ending in ';' or '&', or carrying a '#' word, refuses — a runner-appended argument would never reach it", () => {
  const { dir, head } = repo({ "run.sh": "#!/bin/sh\nexit 0\n" });
  chmodSync(join(dir, "run.sh"), 0o755);
  for (const cmd of ["sh ./run-tests.sh;", "sh ./run-tests.sh &", "sh ./run-tests.sh # all suites"]) {
    cache(dir, recipe(head, { test: cmd }));
    const r = derive(dir, "test", process.env, tmpdir());
    assert.equal(r.status, 1, `${cmd} must refuse: ${r.out}`);
    assert.match(r.err, /a runner-appended argument/, `${cmd}: ${r.err}`);
  }
});

// --- #2217: the frame above lets a value keep a trailing newline that an
// unframed `$(…)` capture always stripped silently, so a command that used
// to read as `true;` (caught above) now reads as `true;\n` inside the
// frame and must still be caught the same way.
test("a command ending in ';' or '&' followed by a newline still refuses (#2217)", () => {
  const { dir, head } = repo();
  for (const cmd of ["true;\n", "true &\n"]) {
    cache(dir, recipe(head, { test: cmd }));
    const r = derive(dir, "test", process.env, tmpdir());
    assert.equal(r.status, 1, `${JSON.stringify(cmd)} must refuse: ${r.out}`);
    assert.match(r.err, /a runner-appended argument/, `${JSON.stringify(cmd)}: ${r.err}`);
  }
});

test("a command of assignments alone names nothing to run and refuses", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "CI=1 FOO=2" }));
  const r = derive(dir);
  assert.equal(r.status, 1);
  assert.match(r.err, /its test command names no command, only assignments/);
});

// The assignment-skip loop above only accepts `NAME=value` prefixes whose
// name is a valid shell identifier (`[A-Za-z0-9_]` only) — a hyphen breaks
// the inner guard, so `a-b=c` is never skipped as an assignment and is read
// as the leading command word itself instead.
test("an assignment-shaped word with an invalid variable name is read as the command, not skipped", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "a-b=c ./run.sh" }));
  const r = derive(dir);
  assert.equal(r.status, 1);
  assert.match(r.err, /its test command 'a-b=c' is not found or not executable/);
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
  const bin = tempDir("derive-path-");
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

// --- #2217: node's STDOUT is the capture itself, so the stream split above
// does nothing for it. A version-manager or proxy shim prints before exec'ing
// the real node, or — not exec'ing — after it exits, and unframed that chatter
// became part of the command: refused as a stale cache when its first word
// did not resolve, handed on when it did. Every stub runs the real interpreter
// by ABSOLUTE path: re-running `node` through PATH would find the stub again.
function nodeStub(body) {
  const bin = tempDir("derive-stub-");
  writeExecStub(join(bin, "node"), `#!/bin/sh\n${body.replaceAll("NODE", `'${process.execPath}'`)}\n`);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test("stdout chatter around the Recipe value refuses, blaming node's output and never the cache (#2217)", (t) => {
  const { dir, head } = repo();
  cache(dir, recipe(head));
  const stubs = {
    "a banner before exec": ['echo "Now using node v22.0.0"; exec NODE "$@"', "Now using node v22.0.0"],
    "a digit prefix with no newline": ['printf 1; exec NODE "$@"', `1${FRAME_OPEN}`],
    "trailing output from a shim that does not exec": ['NODE "$@"; st=$?; printf done; exit $st', `${FRAME_CLOSE}done`],
    "a shim whose own chatter spells out the sentinel": [`printf "${FRAME_OPEN}SNEAKY-INJECTED"; exec NODE "$@"`, `${FRAME_OPEN}SNEAKY-INJECTED${FRAME_OPEN}`],
  };
  for (const [name, [body, shown]] of Object.entries(stubs)) {
    const env = nodeStub(body);
    for (const field of ["install", "test"]) {
      t.diagnostic(`${name}, ${field}`);
      const r = derive(dir, field, env);
      assert.equal(r.status, 1, `${name}/${field}: ${r.err}`);
      assert.equal(r.out, "", `${name}/${field}: nothing may reach the caller`);
      assert.match(r.err, /^derive-testcmd: node's stdout carried more than the framed Recipe value/);
      assert.ok(r.err.includes(shown), `${name}/${field}: the refusal shows the capture: ${r.err}`);
      assert.doesNotMatch(r.err, /Recipe cache .* is invalid/);
      assert.doesNotMatch(r.err, /Recipe derivation step/);
    }
  }
});

// The must-ACCEPT half: with no stub the frame is invisible, and a value with
// an embedded newline crosses it byte for byte.
test("the framed read hands on the exact value, an embedded newline included (#2217)", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { install: "true\ntrue", test: "sh ./run-tests.sh\n: second line" }));
  const i = derive(dir, "install");
  assert.equal(i.status, 0, i.err);
  assert.equal(i.out, "true\ntrue");
  const t = derive(dir, "test");
  assert.equal(t.status, 0, t.err);
  assert.equal(t.out, "sh ./run-tests.sh\n: second line");
});
