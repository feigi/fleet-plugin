import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from "./support/temp-dir.mjs";
import { join, dirname } from "node:path";
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
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
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

function run(args, env = process.env, cwd = tmpdir()) {
  const r = spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env, cwd, timeout: 30_000 });
  return { status: r.status, out: r.stdout.replace(/\n$/, ""), err: r.stderr };
}

function derive(dir, field = "test", env = process.env, cwd = tmpdir()) {
  return run([dir, field], env, cwd);
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

  // git's own refusal for a path that does not exist is the same fatal, so it
  // stays a refusal about the repository, never an environment fault.
  const gone = derive(join(dir, "missing"));
  assert.equal(gone.status, 1, gone.err);
  assert.match(gone.err, /^derive-testcmd: .*missing is not a git repository$/m);
});

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// A `git` first on PATH that runs `act` when its arguments end in `call`, and
// otherwise execs the real one — so `git --version` and every other call pass.
function fakeGit(call, act) {
  const bin = tempDir("derive-git-");
  writeExecStub(join(bin, "git"), `#!/bin/sh\ncase "$*" in *"${call}") ${act} ;; esac\nexec '${REAL_GIT}' "$@"\n`);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

// git's own fatal is 128, and only that status is a verdict on the repository.
// Any other — 126 or 127 from a git that cannot be started, 128+N from a
// signal — means git did not run to an answer, so the reader read nothing:
// exit 3, naming the status, on either git call.
const GIT_CALLS = [
  { call: "rev-parse --git-dir", reason: (s) => new RegExp(`^derive-testcmd: git did not answer whether .* is a git repository \\(exit ${s}\\), so the Recipe cache was not read(?: — .*)?$`, "m"), refusal: /^derive-testcmd: .* is not a git repository$/m },
  { call: "rev-parse --path-format=absolute --git-common-dir", reason: (s) => new RegExp(`^derive-testcmd: git did not resolve the common git dir of .* \\(exit ${s}\\), so the Recipe cache was not read`, "m"), refusal: /^derive-testcmd: cannot resolve the common git dir of /m },
];
for (const g of GIT_CALLS) {
  for (const [what, act, status] of [["is killed by SIGKILL", "kill -9 $$", 137], ["exits 126", "exit 126", 126], ["exits 127", "exit 127", 127], ["exits 1", "exit 1", 1]]) {
    test(`a git that passes --version but ${what} on \`${g.call}\` is the environment's refusal, exit 3, never the repository's`, () => {
      const { dir, head } = repo();
      cache(dir, recipe(head, { test: "true" }));
      const env = fakeGit(g.call, `echo 'STUBERR-boom' >&2; ${act}`);
      assert.equal(spawnSync("git", ["--version"], { env }).status, 0, "the fixture is a git that passes --version");
      const r = derive(dir, "test", env);
      assert.equal(r.status, 3, r.err);
      assert.equal(r.out, "");
      assert.match(r.err, g.reason(status));
      assert.match(r.err, /STUBERR-boom/, "git's own stderr says what happened, so it survives into the refusal");
      assert.doesNotMatch(r.err, /is not a git repository|cannot resolve the common git dir/);
    });
  }

  // The controls: the same stub doing nothing reads the cache, and the same
  // stub exiting with git's own 128 is still the refusal about the repository.
  test(`a git stub on \`${g.call}\` that exits 128 is still a refusal about the repository, exit 1 — and one that lets git run reads the cache`, () => {
    const { dir, head } = repo();
    cache(dir, recipe(head, { test: "true" }));
    const ok = derive(dir, "test", fakeGit(g.call, ":"));
    assert.equal(ok.status, 0, ok.err);
    assert.equal(ok.out, "true");
    const r = derive(dir, "test", fakeGit(g.call, "exit 128"));
    assert.equal(r.status, 1, r.err);
    assert.match(r.err, g.refusal);
  });
}

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
  const { dir, head } = repo({ "run.sh": "#!/bin/sh\nexit 0\n", "plugin/scripts/a.test.mjs": "" });
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

// A pattern in the Test entrypoint that matches no tracked file selects no
// tests: `node --test` over a glob that matches nothing reports `tests 0` and
// exits 0, so every member handed the command gets a green run that tested
// nothing. That is a stale Recipe — the suite moved — refused like a missing
// binary. Tracked is the criterion, not present on disk: a fresh worktree has
// only what is tracked.
test("a test command whose glob matches no tracked file refuses as a stale Recipe", () => {
  const { dir, head } = repo({ "plugin/scripts/run.sh": "", "tests/a.test.mjs": "" });
  writeFileSync(join(dir, "untracked.test.mjs"), "");
  for (const [cmd, pattern] of [
    ["node --test plugin/scripts/*.test.mjs", "plugin/scripts/*.test.mjs"],
    ["node --test *.test.mjs", "*.test.mjs"],
    ["node --test tests/*.test.mjs gone/*.test.mjs", "gone/*.test.mjs"],
    ["true && node --test t?sts/[!a].test.mjs", "t?sts/[!a].test.mjs"],
    ["node --test gone/*/", "gone/*/"],
    // A shell operator glued to the pattern is still an operator, so the
    // pattern beside it is a word of its own, probed like any other — and the
    // piece after an operator is no option's value.
    ["node --test nope/*.js;echo", "nope/*.js"],
    ["(node --test gone/*.test.mjs)", "gone/*.test.mjs"],
    ["node --test gone/*.test.mjs|cat", "gone/*.test.mjs"],
    ["node --test -x;gone*", "gone*"],
    // A quoted word between an option and the pattern is not that option's
    // value, so the pattern after it is probed like any other.
    ['node --test --grep "x" gone*', "gone*"],
  ]) {
    cache(dir, recipe(head, { test: cmd }));
    const r = derive(dir);
    assert.equal(r.status, 1, `${cmd} must refuse: ${r.out}`);
    assert.equal(r.out, "", `${cmd}: nothing may reach the caller`);
    assert.ok(r.err.includes(`its test command's pattern '${pattern}' matches no file tracked in`), `${cmd}: ${r.err}`);
    assert.match(r.err, NAMES_STEP, cmd);
  }
});

// `set -f` keeps the scan from globbing the command against the CALLER's
// working directory: a file there that the stale pattern happens to match
// would turn the pattern into its own name and slip past the check.
test("a stale pattern is still refused when the caller's working directory holds a file it matches", () => {
  const { dir, head } = repo({ "tests/a.test.mjs": "" });
  const here = tempDir("derive-testcmd-cwd-");
  writeFileSync(join(here, "nope1.mjs"), "");
  cache(dir, recipe(head, { test: "node --test nope*.mjs" }));
  const r = derive(dir, "test", process.env, here);
  assert.equal(r.status, 1, `nothing in <repo> matches the pattern: ${r.out}`);
  assert.ok(r.err.includes("its test command's pattern 'nope*.mjs' matches no file tracked in"), r.err);
});

// A program's own directory option does not stop the scan: whether it moves
// where the program resolves a pattern is the program's to say, not the
// tree's. `git -C web` resolves a pattern under `web`, so an unquoted one is
// still probed from the repository root and refused, and the refusal says to
// quote it; quoted, it is accepted unprobed.
test("a pattern a program resolves under its own directory option is refused unquoted, with the fix named, and accepted quoted", () => {
  const { dir, head } = repo({ "web/x.test.ts": "" });
  const control = spawnSync("sh", ["-c", "git -C web ls-files -- '*.test.ts'"], { cwd: dir, encoding: "utf8", env: FIXTURE_ENV });
  assert.equal(control.stdout, "x.test.ts\n", "fixture: git resolves the pattern under its -C directory");
  cache(dir, recipe(head, { test: "git -C web ls-files -- *.test.ts" }));
  const r = derive(dir);
  assert.equal(r.status, 1, `nothing tracked at the root matches the pattern: ${r.out}`);
  assert.equal(r.out, "", "nothing may reach the caller");
  assert.ok(r.err.includes("its test command's pattern '*.test.ts' matches no file tracked in"), r.err);
  assert.ok(r.err.includes("a pattern that a program resolves under its own directory option, such as git -C, must be quoted"), r.err);
  assert.match(r.err, NAMES_STEP);
  const quoted = "git -C web ls-files -- '*.test.ts'";
  cache(dir, recipe(head, { test: quoted }));
  const q = derive(dir);
  assert.equal(q.status, 0, q.err);
  assert.equal(q.out, quoted);
  assert.equal(q.err, "");
});

// The must-ACCEPT half. A pattern matching a tracked file at any depth reads
// cleanly. A word the shell does not glob as written — quoted, carrying an
// expansion, an option or an `=` — is the program's own to read and cannot be
// settled without running it, and neither can a path outside the repository
// or a pattern after a `cd`, which no longer resolves from the repository. A
// pattern under a path git ignores names generated output (a build the Install
// step produces), which is never tracked. The Install step is not a Test
// entrypoint, so a pattern there is not checked.
test("a test command whose glob matches a tracked file, or that the tree cannot settle, is accepted", () => {
  const { dir, head } = repo({ ".gitignore": "dist/\n*.gen.*\n", "tests/unit/a.test.mjs": "" });
  for (const cmd of [
    "node --test tests/*/*.test.mjs",
    "node --test tests/**/*.test.mjs",
    "node --test ./tests/unit/[a-z].test.mjs",
    "node --test 'gone/**/*.test.mjs'",
    `node --test "gone/*.test.mjs"`,
    "node --test $SUITE/*.test.mjs",
    "SKIP=gone/* node --test tests/unit/*.test.mjs",
    "node --test --test-name-pattern=* tests/unit/a.test.mjs",
    "node --test --test-name-pattern foo* tests/unit/a.test.mjs",
    "node --test --grep foo* tests/unit/a.test.mjs",
    "node --test tests/*",
    "node --test tests/*/",
    "node --test -x*.js",
    "node --test dist/*.test.js",
    "node --test src/*.gen.test.js",
    "[ -d tests ] && node --test tests/unit/*.test.mjs",
    "cd tests/unit && node --test *.test.mjs",
    "(cd tests/unit && node --test *.test.mjs)",
    "true;cd tests/unit && node --test *.test.mjs",
    "true&&cd tests/unit&&node --test *.test.mjs",
    "true|cd tests/unit && node --test *.test.mjs",
    "true&cd tests/unit && node --test *.test.mjs",
    "echo 'x';cd tests/unit && node --test *.test.mjs",
    "(cd tests/unit && node --test *.test.mjs )",
    "true;pushd tests/unit && node --test *.test.mjs",
    // Led by `true`, not `pushd`: pushd is a bash builtin, absent from dash
    // (Ubuntu's /bin/sh), where a command led by it cannot run at all and is
    // refused by the leading-word probe before the scan is reached.
    "true && pushd tests/unit && node --test *.test.mjs",
    "node --test ../shared/*.test.mjs",
    "node --test /opt/suite/*.test.mjs",
    // A redirection's target is a file the command writes or reads, not a
    // test it selects.
    "node --test tests/unit/*.test.mjs > gone/*.log",
    "node --test tests/unit/*.test.mjs 2> gone/*.log",
    "node --test tests/unit/*.test.mjs >|gone/*.log",
    "node --test tests/unit/*.test.mjs >gone/*.log",
    "node --test tests/unit/*.test.mjs 2>gone/*.log",
    "node --test tests/unit/*.test.mjs <gone/*.log",
    "node --test tests/unit/*.test.mjs >>gone/*.log",
    // The word before a redirection carries quoting or an expansion, so it is
    // accepted whole; what follows it is still the redirection's target.
    "node --test tests/unit/*.test.mjs 'x'> gone/*.log",
    "node --test tests/unit/*.test.mjs $X> gone/*.log",
    // A word carrying quoting or an expansion is not split at its operators,
    // which may be quoted.
    "node --test tests/unit/*.test.mjs 'x';gone/*.js",
    "node --test tests/unit/*.test.mjs $X;gone/*.js",
    "node --test tests/unit/*.test.mjs `x`;gone/*.js",
    "node --test tests/unit/*.test.mjs {x};gone/*.js",
    "node --test tests/unit/*.test.mjs ~;gone/*.js",
    "node --test tests/unit/*.test.mjs x\\;gone/*.js",
  ]) {
    cache(dir, recipe(head, { test: cmd }));
    const r = derive(dir);
    assert.equal(r.status, 0, `${cmd}: ${r.err}`);
    assert.equal(r.out, cmd);
    assert.equal(r.err, "", cmd);
  }
  cache(dir, recipe(head, { install: "cp gone/*.json ." }));
  const i = derive(dir, "install");
  assert.equal(i.status, 0, i.err);
  assert.equal(i.out, "cp gone/*.json .");
});

// An ambient GIT_INDEX_FILE is the third variable that outranks `-C "$repo"`:
// the probe's `ls-files` reads the index it names, which can be another
// repository's or an empty one, and a good Recipe would be refused as stale.
test("an ambient GIT_INDEX_FILE does not refuse a pattern that a tracked file matches", () => {
  const { dir, head } = repo({ "tests/a.test.mjs": "" });
  const cmd = "node --test tests/*.test.mjs";
  cache(dir, recipe(head, { test: cmd }));
  const env = { ...FIXTURE_ENV, GIT_INDEX_FILE: join(tempDir("derive-testcmd-index-"), "empty-index") };
  const control = spawnSync("git", ["-C", dir, "ls-files", "--", ":(glob)tests/*.test.mjs"], { encoding: "utf8", env });
  assert.equal(control.stdout, "", "fixture: the ambient index must change what ls-files lists");
  const r = derive(dir, "test", env);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, cmd);
});

// A glob through a tracked symlink to a directory lists nothing (the index
// holds the link, not what is beneath it) and `check-ignore` exits 128 on it
// ("beyond a symbolic link"), yet the shell follows the link and the command
// runs its tests.
test("a test command whose glob goes through a tracked symlink is accepted, not refused as an environment fault", () => {
  const { dir, head } = repo({ "plugin/scripts/real.test.mjs": "" });
  symlinkSync("plugin/scripts", join(dir, "suite"));
  execFileSync("git", ["add", "suite"], { cwd: dir, stdio: "pipe", env: FIXTURE_ENV });
  execFileSync("git", ["commit", "-q", "-m", "link"], { cwd: dir, stdio: "pipe", env: FIXTURE_ENV });
  const cmd = "node --test suite/*.test.mjs";
  const control = spawnSync("git", ["-C", dir, "check-ignore", "-q", "--no-index", "--", "suite/*.test.mjs"], { encoding: "utf8", env: FIXTURE_ENV });
  assert.equal(control.status, 128, "fixture: git must refuse to look beyond the symlink");
  cache(dir, recipe(head, { test: cmd }));
  const r = derive(dir);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, cmd);
});

// A glob into a submodule lists nothing either: the index holds the gitlink
// (`vendor/lib`, mode 160000) and never what is beneath it, which the Install
// step populates (`git submodule update --init`). Real submodule, so the
// gitlink is whatever git itself records.
test("a test command whose glob goes into a submodule is accepted, with and without --at; the same glob under a directory that is no submodule is refused", () => {
  const src = tempDir("derive-testcmd-sub-");
  const gitIn = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: FIXTURE_ENV, encoding: "utf8" });
  gitIn(src, "init", "-q");
  gitIn(src, "config", "user.email", "t@t");
  gitIn(src, "config", "user.name", "t");
  mkdirSync(join(src, "test"));
  writeFileSync(join(src, "test", "s.test.mjs"), "");
  gitIn(src, "add", "-A");
  gitIn(src, "commit", "-q", "-m", "sub");
  const { dir, head } = repo();
  gitIn(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "vendor/lib");
  gitIn(dir, "commit", "-q", "-m", "submodule");
  assert.equal(gitIn(dir, "ls-files", "--", "vendor/lib/test/s.test.mjs").trim(), "", "fixture: the index lists the gitlink, not what is beneath it");
  const into = "node --test vendor/lib/test/*.test.mjs";
  cache(dir, recipe(head, { test: into }));
  const plain = derive(dir);
  assert.equal(plain.status, 0, plain.err);
  assert.equal(plain.out, into);
  const at = deriveAt(dir, "HEAD");
  assert.equal(at.status, 0, at.err);
  assert.equal(at.out, into);

  cache(dir, recipe(head, { test: "node --test vendor/none/test/*.test.mjs" }));
  assert.equal(derive(dir).status, 1, "control: a directory that is no submodule is still probed");
  assert.equal(deriveAt(dir, "HEAD").status, 1, "control, --at: the same");
});

// Each of the probe's git calls has a refusal for git itself failing, in
// the script's own words with git's reason appended. The stub fails one
// subcommand and hands every other call to the real git, so the cache read
// before the probe is unaffected and only the call under test breaks.
function gitFailing(subcommand) {
  const bin = tempDir("derive-testcmd-git-");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeExecStub(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = '${subcommand}' ]; then echo 'git: injected ${subcommand} failure' >&2; exit 128; fi\ndone\nexec '${real}' "$@"\n`);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test("a git that cannot list the tracked files refuses, naming its exit status and reason", () => {
  const { dir, head } = repo({ "tests/a.test.mjs": "" });
  cache(dir, recipe(head, { test: "node --test tests/*.test.mjs" }));
  const control = derive(dir);
  assert.equal(control.status, 0, `fixture: without the stub the pattern is accepted: ${control.err}`);
  const r = derive(dir, "test", gitFailing("ls-files"));
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "", "nothing may reach the caller");
  assert.match(r.err, /^derive-testcmd: cannot list the files tracked in .* to check its test command's pattern 'tests\/\*\.test\.mjs' \(git ls-files exit 128\): git: injected ls-files failure$/m);
});

test("a git that cannot say whether a path is ignored refuses, naming its exit status and reason", () => {
  const { dir, head } = repo({ "tests/a.test.mjs": "" });
  cache(dir, recipe(head, { test: "node --test gone/*.test.mjs" }));
  const control = derive(dir);
  assert.equal(control.status, 1, "fixture: without the stub the pattern is refused as stale");
  assert.ok(control.err.includes("matches no file tracked in"), control.err);
  const r = derive(dir, "test", gitFailing("check-ignore"));
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "", "nothing may reach the caller");
  assert.match(r.err, /^derive-testcmd: cannot ask git whether .* ignores its test command's pattern 'gone\/\*\.test\.mjs' \(git check-ignore exit 128\): git: injected check-ignore failure$/m);
});

// `-s` is the `ls-files -s` that asks whether a leading directory is a symlink
// or a submodule; no other git call in the script carries that flag.
test("a git that cannot say whether a leading directory is a symlink or a submodule refuses, naming its exit status and reason", () => {
  const { dir, head } = repo({ "tests/a.test.mjs": "" });
  cache(dir, recipe(head, { test: "node --test gone/*.test.mjs" }));
  const control = derive(dir);
  assert.equal(control.status, 1, "fixture: without the stub the pattern is refused as stale");
  assert.ok(control.err.includes("matches no file tracked in"), control.err);
  const r = derive(dir, "test", gitFailing("-s"));
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "", "nothing may reach the caller");
  assert.match(r.err, /^derive-testcmd: cannot ask git whether 'gone' is a symlink or a submodule in .*, to check its test command's pattern 'gone\/\*\.test\.mjs' \(git ls-files exit 128\): git: injected -s failure$/m);
  assert.doesNotMatch(r.err, /matches no file tracked/, "a git that cannot answer is not a stale Recipe");
});

// `--at <rev>`: the vacuous-suite probe against the tree the command will run
// in, not <repo>'s own index. claim-ticket.sh cuts its worktree from
// origin/main, which can hold a suite the main checkout does not yet list
// (the suite moved upstream and nobody updated the checkout). `moved` is that
// commit: the checkout is left on the old layout, `moved` holds the new one,
// and a symlink `suite` -> tests exists only there.
function movedSuite() {
  const { dir, head } = repo({ "plugin/scripts/a.test.mjs": "" });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: FIXTURE_ENV, encoding: "utf8" });
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  git("checkout", "-q", "-b", "moved");
  mkdirSync(join(dir, "tests"));
  git("mv", "plugin/scripts/a.test.mjs", "tests/a.test.mjs");
  symlinkSync("tests", join(dir, "suite"));
  git("add", "suite");
  git("commit", "-q", "-m", "moved");
  git("checkout", "-q", branch);
  return { dir, head, git };
}

function deriveAt(dir, rev, env = process.env) {
  return run([dir, "test", "--at", rev], env);
}

test("--at refuses a pattern the named tree no longer holds, though the checkout's index still lists it", () => {
  const { dir, head, git } = movedSuite();
  const stale = "node --test plugin/scripts/*.test.mjs";
  cache(dir, recipe(head, { test: stale }));
  assert.equal(git("ls-files").trim(), "plugin/scripts/a.test.mjs", "fixture: the checkout lists the old layout");
  const control = derive(dir);
  assert.equal(control.status, 0, `fixture: without --at the checkout's index accepts it: ${control.err}`);
  const r = deriveAt(dir, "moved");
  assert.equal(r.status, 1, r.err);
  assert.equal(r.out, "", "nothing may reach the caller");
  assert.ok(r.err.includes("its test command's pattern 'plugin/scripts/*.test.mjs' matches no file tracked in"), r.err);
  assert.ok(r.err.includes(" at moved"), `the refusal names the tree it read: ${r.err}`);
  assert.match(r.err, NAMES_STEP);
});

test("--at accepts a pattern the named tree holds, though the checkout's index does not", () => {
  const { dir, head } = movedSuite();
  const cmd = "node --test tests/*.test.mjs";
  cache(dir, recipe(head, { test: cmd }));
  const control = derive(dir);
  assert.equal(control.status, 1, "fixture: without --at the checkout's index refuses it");
  const r = deriveAt(dir, "moved");
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, cmd);
  assert.equal(r.err, "");
});

test("--at leaves the checkout's index and working tree as they were", () => {
  const { dir, head, git } = movedSuite();
  cache(dir, recipe(head, { test: "node --test tests/*.test.mjs" }));
  const before = git("ls-files", "-s");
  assert.equal(deriveAt(dir, "moved").status, 0);
  assert.equal(git("ls-files", "-s"), before);
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
});

// The private index file lives beside the script's other temp files and goes
// with them on every exit: leaked, it would cost one file per probe, silently.
// A stub `mktemp` on PATH makes the script's temp files land in a directory of
// the test's own, and it logs each call, so an empty directory afterwards
// cannot be a stub the script never reached.
test("--at leaves no temporary file behind, on the accepted path or the refused one", () => {
  const { dir, head } = movedSuite();
  const real = execFileSync("sh", ["-c", "command -v mktemp"], { encoding: "utf8" }).trim();
  for (const [test, status] of [["node --test tests/*.test.mjs", 0], ["node --test plugin/scripts/*.test.mjs", 1]]) {
    cache(dir, recipe(head, { test }));
    const bin = tempDir("derive-testcmd-mktemp-");
    const tmp = tempDir("derive-testcmd-tmp-");
    writeExecStub(join(bin, "mktemp"), `#!/bin/sh\necho called >> '${bin}/calls'\nexec '${real}' '${tmp}/tmp.XXXXXXXX'\n`);
    const r = deriveAt(dir, "moved", { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, status, r.err);
    assert.ok(readFileSync(join(bin, "calls"), "utf8").length > 0, "the stub mktemp was never called");
    assert.deepEqual(readdirSync(tmp), [], `exit ${status} left files behind`);
  }
});

test("--at reads a symlink in the named tree, not the checkout's disk", () => {
  const { dir, head } = movedSuite();
  const cmd = "node --test suite/*.test.mjs";
  cache(dir, recipe(head, { test: cmd }));
  const r = deriveAt(dir, "moved");
  assert.equal(r.status, 0, `a glob through a symlink the tree holds is accepted: ${r.err}`);
  assert.equal(r.out, cmd);
  const absent = derive(dir);
  assert.equal(absent.status, 1, "fixture: no such link in the checkout, so without --at it is stale");
});

// `git ls-files -s -- :d` would read the colon as pathspec magic, so the probe
// names the directory with `:(literal)`; a directory whose name starts with a
// colon is the one case that tells the two forms apart.
test("--at reads a symlink in the named tree whose name begins with a colon", () => {
  const { dir, head } = repo({ "tests/a.test.mjs": "" });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: FIXTURE_ENV, encoding: "utf8" });
  symlinkSync("tests", join(dir, ":d"));
  git("add", "--", "./:d");
  git("commit", "-q", "-m", "colon link");
  const linked = git("rev-parse", "HEAD").trim();
  git("reset", "-q", "--hard", "HEAD~1");
  const cmd = "node --test :d/*.test.mjs";
  cache(dir, recipe(head, { test: cmd }));
  const r = deriveAt(dir, linked);
  assert.equal(r.status, 0, `a glob through a symlink the tree holds is accepted: ${r.err}`);
  assert.equal(r.out, cmd);
  assert.equal(derive(dir).status, 1, "fixture: the checkout holds no such link, so without --at it is stale");
});

test("--at refuses what it cannot read: an unresolvable rev, a non-test field, a malformed flag, a git that cannot read the tree", () => {
  const { dir, head } = movedSuite();
  cache(dir, recipe(head, { test: "node --test tests/*.test.mjs" }));
  const gone = deriveAt(dir, "no-such-ref");
  assert.equal(gone.status, 1, gone.err);
  assert.equal(gone.out, "");
  assert.match(gone.err, /--at 'no-such-ref' does not resolve to a commit/);
  assert.match(gone.err, /^fatal: Needed a single revision$/m, "git's own reason reaches the terminal beside the refusal");
  const dash = deriveAt(dir, "-x");
  assert.equal(dash.status, 1, dash.err);
  assert.match(dash.err, /--at needs a commit, got '-x'/);
  const inst = run([dir, "install", "--at", "moved"]);
  assert.equal(inst.status, 1, inst.err);
  assert.equal(inst.out, "");
  assert.match(inst.err, /--at applies to the test field only, not 'install'/);
  const flag = run([dir, "test", "--on", "moved"]);
  assert.equal(flag.status, 1, flag.err);
  assert.match(flag.err, /usage: derive-testcmd\.sh <repo> <install\|test>/);
  const broken = deriveAt(dir, "moved", gitFailing("read-tree"));
  assert.equal(broken.status, 1, broken.err);
  assert.equal(broken.out, "");
  assert.match(broken.err, /^derive-testcmd: cannot read the tree of moved in .* \(git read-tree exit 128\): git: injected read-tree failure$/m);
});

// claim-ticket.sh appends the runner's own arguments after this string
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

// The other half of the same line: the vacuous-suite probe asks git whether a
// pattern is ignored, and an ambient GIT_WORK_TREE naming another directory
// answers from that directory's ignore rules — the control shows it does —
// refusing a pattern this repository's own .gitignore covers.
test("an ambient GIT_WORK_TREE does not refuse a pattern under this repository's ignored output", () => {
  const here = repo({ ".gitignore": "dist/\n" });
  const cmd = "node --test dist/*.test.js";
  cache(here.dir, recipe(here.head, { test: cmd }));
  const elsewhere = tempDir("derive-testcmd-worktree-");
  const env = { ...FIXTURE_ENV, GIT_WORK_TREE: elsewhere };
  const control = spawnSync("git", ["-C", here.dir, "check-ignore", "-q", "--no-index", "--", "dist/x.test.js"], { env });
  assert.equal(control.status, 1, "fixture: the ambient work tree must change git's answer");

  const r = derive(here.dir, "test", env);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, cmd);
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
// Only status 2 is node's verdict on the cache, so a non-2 status that leaves
// no reason is exit 3 too: node failed without saying anything about the cache.
// The stripped PATH has no cat: node's reason is read back WITHOUT it, so every
// refusal row also proves that. The rows that give a reason a shape (several
// lines, no final newline, trailing newlines, a backslash and leading space)
// pin what the read-back must still do as cat did; the exit 2 rows whose
// stderr is empty, newline-only or blank-only (spaces, a tab, a CR) pin the
// "(node gave no reason, exit 2)" placeholder that stands in for it, and the
// exit 1 and exit 5 rows with an empty or blank-only stderr pin exit 3. The
// exit 125 row is the same shape one status below the 126 cut-off, so it pins
// that a status under it is still read as node's own and never as the shell's.
for (const [what, body, status, reason] of [
  ["is killed", "kill -9 $$", 3, /^derive-testcmd: node did not finish reading the Recipe cache \(exit 137\)/m],
  ["can no longer be run", "exit 127", 3, /^derive-testcmd: node did not finish reading the Recipe cache \(exit 127\)/m],
  ["exits 126", "exit 126", 3, /^derive-testcmd: node did not finish reading the Recipe cache \(exit 126\)/m],
  ["refuses the cache itself", "echo 'it does not parse: boom' >&2; exit 2", 1, /is unusable: it does not parse: boom/],
  ["faults on its own", "echo 'TypeError: boom' >&2; exit 1", 1, /is unusable: TypeError: boom/],
  ["refuses with a multi-line reason", "echo 'first line' >&2; echo 'second line' >&2; exit 2", 1, /is unusable: first line\nsecond line — run the Recipe/],
  ["refuses with a last line without a newline", "printf 'no newline' >&2; exit 2", 1, /is unusable: no newline — run the Recipe/],
  ["refuses with trailing newlines", "printf 'reason\\n\\n\\n' >&2; exit 2", 1, /is unusable: reason — run the Recipe/],
  ["refuses with a backslash and leading space", "printf '  a\\\\nb\\n' >&2; exit 2", 1, /is unusable:   a\\nb — run the Recipe/],
  ["exits 1 with nothing on stderr", "exit 1", 3, /^derive-testcmd: node exited 1 without a reason, so its usability is unknown — an environment fault, not a verdict on the cache$/m],
  ["exits 1 with only blanks on stderr", "printf '  \\n\\t\\r\\n' >&2; exit 1", 3, /^derive-testcmd: node exited 1 without a reason, so its usability is unknown/m],
  ["exits 5 with nothing on stderr", "exit 5", 3, /^derive-testcmd: node exited 5 without a reason, so its usability is unknown/m],
  ["exits 125 with nothing on stderr", "exit 125", 3, /^derive-testcmd: node exited 125 without a reason, so its usability is unknown/m],
  ["exits 2 with nothing on stderr", "exit 2", 1, /is unusable: \(node gave no reason, exit 2\) — run the Recipe/],
  ["exits 2 with only blank lines on stderr", "printf '\\n\\n' >&2; exit 2", 1, /is unusable: \(node gave no reason, exit 2\) — run the Recipe/],
  ["exits 2 with only spaces and a tab on stderr", "printf '   \\t\\n' >&2; exit 2", 1, /is unusable: \(node gave no reason, exit 2\) — run the Recipe/],
  ["exits 2 with only a carriage return on stderr", "printf '\\r\\n' >&2; exit 2", 1, /is unusable: \(node gave no reason, exit 2\) — run the Recipe/],
  ["exits 2 with only blanks spread over several lines on stderr", "printf '  \\n\\t\\n \\n' >&2; exit 2", 1, /is unusable: \(node gave no reason, exit 2\) — run the Recipe/],
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
    if (status === 3) assert.doesNotMatch(r.err, /is unusable|run the Recipe derivation step/);
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
