import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from "./support/temp-dir.mjs";
import { join } from "node:path";
import { writeExecStub } from "./support/exec-stub.mjs";

// derive-testcmd.sh is the ONE reader of a repository's Recipe cache (ADR
// 0015) — reused by claim-ticket.sh and review-core.mjs's snapshot agent. It
// infers nothing: no fixture here carries a package.json, a lockfile or a
// test-file naming convention, because none of them can change its answer.
const SCRIPT = join(import.meta.dirname, "..", "plugin", "scripts", "derive-testcmd.sh");

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
const NAMES_STEP = /run the Recipe derivation step \(run-team phase 0, before the first claim\)/;

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
function shimPath({ node, omit }) {
  const bin = tempDir("derive-path-");
  for (const name of SHIMMED) {
    if (name === omit) continue;
    const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, name));
  }
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}

// Exit 3, where every refusal about the cache, the repository or the arguments
// is exit 1: the reader read nothing, so a caller can tell its own
// environment's fault from a verdict on the cache.
test("an unusable interpreter refuses in this script's own voice, never the cache's", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const absent = derive(dir, "test", { ...process.env, PATH: shimPath({ node: false }) });
  assert.equal(absent.status, 3);
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

// The reader's other tools, taken away the same way. The control above is the
// same stripped PATH with every tool present.
for (const [tool, reason] of [
  ["mktemp", /^derive-testcmd: cannot create a temporary file to read the Recipe cache$/m],
  ["cat", /^derive-testcmd: cat could not be started \(exit 127\), so the Recipe cache cannot be read$/m],
]) {
  test(`a ${tool} that cannot be started is the environment's refusal, exit 3, never the cache's`, () => {
    const { dir, head } = repo();
    cache(dir, recipe(head, { test: "true" }));
    const r = derive(dir, "test", { ...process.env, PATH: shimPath({ node: true, omit: tool }) });
    assert.equal(r.status, 3, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, reason);
    assert.doesNotMatch(r.err, /is unusable|byte-count/);
  });
}

// The reader asks mktemp twice, and a mktemp that starts and then fails — a
// full or unwritable temp directory — is the same environment fault as one
// that is missing, on either call.
test("a mktemp that runs and fails on its second call is exit 3, never the cache's", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const bin = shimPath({ node: true, omit: "mktemp" });
  const real = execFileSync("sh", ["-c", "command -v mktemp"], { encoding: "utf8" }).trim();
  const mark = join(bin, "called");
  writeExecStub(join(bin, "mktemp"), `#!/bin/sh\nif [ -e '${mark}' ]; then echo 'mktemp: no space left' >&2; exit 1; fi\n: > '${mark}'\nexec '${real}' "$@"\n`);
  const r = derive(dir, "test", { ...process.env, PATH: bin });
  assert.equal(r.status, 3, r.err);
  assert.match(r.err, /^derive-testcmd: cannot create a temporary file to read the Recipe cache$/m);
});

// The reader's `node -e 0` probe passes, and then the interpreter dies during
// the real read — killed, or no longer runnable. Nothing was read, so that is
// exit 3 as well. Node's own refusal of the cache (its exit 2) and an uncaught
// fault of its own (exit 1) are still the cache's exit 1, with node's reason.
// The stripped PATH has no cat: node's reason is read back WITHOUT it, so every
// refusal row also proves that. The rows that give a reason a shape (several
// lines, no final newline, trailing newlines, a backslash and leading space)
// pin what the read-back must still do as cat did.
for (const [what, body, status, reason] of [
  ["is killed", "kill -9 $$", 3, /^derive-testcmd: node did not finish reading the Recipe cache \(exit 137\)/m],
  ["can no longer be run", "exit 127", 3, /^derive-testcmd: node did not finish reading the Recipe cache \(exit 127\)/m],
  ["refuses the cache itself", "echo 'it does not parse: boom' >&2; exit 2", 1, /is unusable: it does not parse: boom/],
  ["faults on its own", "echo 'TypeError: boom' >&2; exit 1", 1, /is unusable: TypeError: boom/],
  ["refuses with a multi-line reason", "echo 'first line' >&2; echo 'second line' >&2; exit 2", 1, /is unusable: first line\nsecond line — run the Recipe/],
  ["refuses with a last line without a newline", "printf 'no newline' >&2; exit 2", 1, /is unusable: no newline — run the Recipe/],
  ["refuses with trailing newlines", "printf 'reason\\n\\n\\n' >&2; exit 2", 1, /is unusable: reason — run the Recipe/],
  ["refuses with a backslash and leading space", "printf '  a\\\\nb\\n' >&2; exit 2", 1, /is unusable:   a\\nb — run the Recipe/],
]) {
  test(`a node that passes the probe and then ${what} is exit ${status}`, () => {
    const { dir, head } = repo();
    cache(dir, recipe(head, { test: "true" }));
    const bin = shimPath({ node: false, omit: "cat" });
    writeExecStub(join(bin, "node"), `#!/bin/sh\nif [ "$1" = -e ] && [ "$2" = 0 ]; then exit 0; fi\n${body}\n`);
    const r = derive(dir, "test", { ...process.env, PATH: bin });
    assert.equal(r.status, status, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, reason);
  });
}

// A cat that exits 126 — the status a shell gives a command it found but could
// not execute — is the environment's fault like one that is missing (127). The
// stub exits 126 itself: whether a shell reports an unexecutable file as 126
// depends on the shell and its options, and this pins the reader's reading of
// the status, not the shell's.
test("a cat that exits 126 is exit 3, never the cache's", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const bin = shimPath({ node: true, omit: "cat" });
  writeExecStub(join(bin, "cat"), "#!/bin/sh\nexit 126\n");
  const r = derive(dir, "test", { ...process.env, PATH: bin });
  assert.equal(r.status, 3, r.err);
  assert.equal(r.out, "");
  assert.match(r.err, /^derive-testcmd: cat could not be started \(exit 126\), so the Recipe cache cannot be read$/m);
});

// A cat that starts and fails while reading node's byte-count file is the
// cache refusal, exit 1, and carries cat's own reason.
test("a cat that runs and fails on the byte-count file is exit 1, carrying its reason", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const bin = shimPath({ node: true, omit: "cat" });
  const real = execFileSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).trim();
  const mark = join(bin, "called");
  writeExecStub(join(bin, "cat"), `#!/bin/sh\nif [ ! -e '${mark}' ]; then : > '${mark}'; echo 'cat: I/O error' >&2; exit 1; fi\nexec '${real}' "$@"\n`);
  const r = derive(dir, "test", { ...process.env, PATH: bin });
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "");
  assert.match(r.err, /cat failed reading node's byte-count file \(exit 1\): cat: I\/O error/);
  assert.doesNotMatch(r.err, /could not be started/);
});

// node's refusal of the cache is read back WITHOUT cat: a cat that cannot be
// started must not turn a cache node really refuses into a refusal with an
// empty reason. The cache is refused either way (exit 1), and node's own reason
// survives, with no shell complaint about cat.
const REFUSED = /is unusable: `installClean` is not true — the Install step was never proven to leave the tree clean — run the Recipe derivation step/;
for (const [what, stub] of [
  ["is missing", null],
  ["exits 127", "exit 127"],
  ["exits 126", "exit 126"],
]) {
  test(`a cat that ${what} still lets a refused cache carry node's reason, exit 1`, () => {
    const { dir, head } = repo();
    cache(dir, recipe(head, { installClean: false }));
    const bin = shimPath({ node: true, omit: "cat" });
    if (stub) writeExecStub(join(bin, "cat"), `#!/bin/sh\n${stub}\n`);
    const r = derive(dir, "test", { ...process.env, PATH: bin });
    assert.equal(r.status, 1, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, REFUSED);
    assert.doesNotMatch(r.err, /command not found|could not be started/);
  });
}

// The control: the same stripped PATH with every tool present, same cache.
test("the same refused cache with cat present carries the same reason", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { installClean: false }));
  const r = derive(dir, "test", { ...process.env, PATH: shimPath({ node: true }) });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, REFUSED);
});

// A cache holding a NUL byte is quoted back, NUL and all, in node's parse
// error. A `read` loop stops at a NUL where cat kept the rest, so the reason
// must reach the shell without one. Only a sh whose `read` stops there (the
// bash 3.2 that is /bin/sh on macOS) loses the tail without that, so the pin
// bites on such a host and passes elsewhere.
test("a NUL byte in the cache does not cut node's parse reason short", () => {
  const { dir } = repo();
  cache(dir, '{"install":\u0000"x"}');
  const r = derive(dir, "test");
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /is unusable: it does not parse: [^\n]*JSON[^\n]* — run the Recipe/);
  assert.doesNotMatch(r.err, /\0/);
});

// Nothing on the way to the refusal may end the script before it: the file
// node's reason was written to is the script's own mktemp, and one that cannot
// be read back must still end in this script's refusal (exit 1, naming the
// Recipe derivation step), not in the shell's own redirect error — which under
// dash is an exit outside the documented 0/1/3.
function mktempShim(bin, { firstArgs = "" } = {}) {
  const real = execFileSync("sh", ["-c", "command -v mktemp"], { encoding: "utf8" }).trim();
  const mark = join(bin, "errf-path");
  writeExecStub(join(bin, "mktemp"), `#!/bin/sh\nif [ ! -e '${mark}' ]; then p=$('${real}' ${firstArgs} "$@") || exit $?; printf '%s' "$p" > '${mark}'; printf '%s\\n' "$p"; exit 0; fi\nexec '${real}' "$@"\n`);
  return mark;
}

test("a stderr file that cannot be opened for the read-back still reaches the refusal", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const bin = shimPath({ node: false, omit: "mktemp" });
  const mark = mktempShim(bin);
  // node writes its reason and then removes the file it wrote it to.
  writeExecStub(join(bin, "node"), `#!/bin/sh\nif [ "$1" = -e ] && [ "$2" = 0 ]; then exit 0; fi\necho 'real reason' >&2\nread -r f < '${mark}'\nrm -f "$f"\nexit 2\n`);
  const r = derive(dir, "test", { ...process.env, PATH: bin });
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "");
  assert.match(r.err, /^derive-testcmd: the Recipe cache at .* is unusable: \(node's reason could not be read back from [^)]+\) — /m);
  assert.match(r.err, NAMES_STEP);
  assert.doesNotMatch(r.err, /No such file|cannot open/);
});

// A stderr file that is a directory: bash's `read` fails there without
// assigning `line`, and `set -u` then trips on the unbound variable inside the
// read-back. The refusal must still be reached, with no complaint about it.
test("a stderr file that is a directory still reaches the refusal", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const bin = shimPath({ node: true, omit: "mktemp" });
  mktempShim(bin, { firstArgs: "-d" });
  const r = derive(dir, "test", { ...process.env, PATH: bin });
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "");
  assert.match(r.err, /^derive-testcmd: the Recipe cache at .* is unusable: /m);
  assert.match(r.err, NAMES_STEP);
  assert.doesNotMatch(r.err, /unbound variable/);
});

// `rm` is the reader's cleanup only, so it must not decide the outcome: with
// it gone a good cache still reads cleanly — status 0 and nothing on stderr,
// the success-path invariant claim-ticket.sh relies on — and a refused cache
// keeps its own status.
test("an rm that cannot be started changes neither the value read nor the refusal's status", () => {
  const { dir, head } = repo();
  cache(dir, recipe(head, { test: "true" }));
  const ok = derive(dir, "test", { ...process.env, PATH: shimPath({ node: true, omit: "rm" }) });
  assert.equal(ok.status, 0, ok.err);
  assert.equal(ok.out, "true");
  assert.equal(ok.err, "");

  cache(dir, "not json");
  const refused = derive(dir, "test", { ...process.env, PATH: shimPath({ node: true, omit: "rm" }) });
  assert.equal(refused.status, 1, refused.err);
});

// The false-positive class: a cache the reader really refuses stays exit 1
// under the same stripped PATH, so exit 3 is not "any refusal".
test("a cache that is refused stays exit 1 under the stripped PATH", () => {
  const { dir } = repo();
  cache(dir, "not json");
  const r = derive(dir, "test", { ...process.env, PATH: shimPath({ node: true }) });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /is unusable/);
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
