import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { commandBudget } from "../plugin/scripts/recipe-prove.mjs";

// recipe-prove.mjs is the Recipe derivation step's proof and the ONE writer of
// the Recipe cache: the deriving agent chooses the Install step and the Test
// entrypoint by reading the repository, and this script is what turns that
// guess into a cache — or refuses to. These fixtures stand in for two
// ecosystems the plugin keeps no knowledge of: a Maven-shaped repo and a
// Go-shaped one, each run through a stub of its own toolchain on PATH, so the
// suite needs neither `mvn` nor `go` and still exercises a command the
// plugin never names.
const SCRIPT = join(import.meta.dirname, "..", "plugin", "scripts", "recipe-prove.mjs");
const READER = join(import.meta.dirname, "..", "plugin", "scripts", "derive-testcmd.sh");

// Fixture construction must not inherit an ambient GIT_DIR: under one, `git
// init` re-inits whatever it names and the fixture is built nowhere.
const FIXTURE_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

// A stub `mvn`: `test` counts the @Test methods under src/test/java, prints
// Surefire's own summary line, and fails when a test asserts 1 == 2. Any other
// goal stands in for a dependency fetch and writes into `target/`, which the
// fixture ignores — the build output a real install leaves behind.
const MVN = `#!/bin/sh
if [ "$1" = -q ]; then shift; fi
case $1 in
test)
  n=0; fail=0
  for f in $(find src/test/java -name '*Test.java' 2>/dev/null); do
    c=$(grep -c '@Test' "$f"); n=$((n + c))
    if grep -q 'assertEquals(1, 2)' "$f"; then fail=1; fi
  done
  if [ "$n" -eq 0 ]; then echo "No tests to run."; exit 0; fi
  echo "Tests run: $n, Failures: $fail, Errors: 0, Skipped: 0"
  if [ "$fail" -ne 0 ]; then echo "BUILD FAILURE"; exit 1; fi
  echo "BUILD SUCCESS" ;;
*) mkdir -p target && : > target/deps ;;
esac
`;

// A stub `go`: `go test ./...` reports "[no test files]" and passes when no
// _test.go is tracked — the vacuous green the real one gives — and otherwise
// passes only while Add still adds. It prints no test count, like the real
// one without -v: the mutation proof is the only proof this fixture offers.
const GO = `#!/bin/sh
[ "$1" = test ] || exit 0
if [ -z "$(find . -name '*_test.go' -not -path './.git/*')" ]; then
  printf '?   \\texample.com/calc\\t[no test files]\\n'; exit 0
fi
if grep -q 'return a + b' calc.go; then printf 'ok  \\texample.com/calc\\t0.001s\\n'; exit 0; fi
printf -- '--- FAIL: TestAdd\\nFAIL\\texample.com/calc\\n'; exit 1
`;

function toolchain() {
  const bin = tempDir("recipe-prove-bin-");
  writeExecStub(join(bin, "mvn"), MVN);
  writeExecStub(join(bin, "go"), GO);
  return bin;
}
const BIN = toolchain();

const MAVEN_FILES = {
  "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>foo</artifactId><version>1</version></project>\n",
  ".gitignore": "target/\n",
  "src/main/java/x/Foo.java": "package x; public class Foo { public int one() { return 1; } }\n",
  "src/test/java/x/FooTest.java":
    "package x;\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n" +
    "class FooTest {\n  @Test void one() { assertEquals(1, new Foo().one()); }\n}\n",
};

const GO_FILES = {
  "go.mod": "module example.com/calc\n\ngo 1.22\n",
  "calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n",
  "calc_test.go":
    'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("Add")\n\t}\n}\n',
};

function git(dir, ...a) {
  return execFileSync("git", a, { cwd: dir, stdio: "pipe", env: FIXTURE_ENV, encoding: "utf8" }).trim();
}

function write(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

// A repository whose `origin/main` is the commit holding `files` — the ref the
// proof runs against. Set with update-ref, so no remote is needed.
function repo(files) {
  const dir = tempDir("recipe-prove-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "files");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

function withoutTests(files) {
  return Object.fromEntries(Object.entries(files).filter(([n]) => !/(^src\/test\/|_test\.go$)/.test(n)));
}

const cachePath = (dir) => join(dir, ".fleet", "recipe.json");

function prove(dir, args, { env = {}, cwd = dir } = {}) {
  const tmp = tempDir("recipe-prove-tmp-");
  const r = spawnSync(process.execPath, [SCRIPT, dir, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...FIXTURE_ENV, PATH: `${BIN}:${process.env.PATH}`, TMPDIR: tmp, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr, tmp };
}

function read(dir, field) {
  const r = spawnSync("sh", [READER, dir, field], {
    encoding: "utf8",
    env: { ...FIXTURE_ENV, PATH: `${BIN}:${process.env.PATH}` },
  });
  return { status: r.status, out: r.stdout.replace(/\n$/, ""), err: r.stderr };
}

const MAVEN_PROOF = ["--install", "mvn -q dependency:go-offline", "--test", "mvn -q test", "--count-line", "Tests run: 1,", "--test-count", "1"];
const GO_PROOF = [
  "--install", "go mod download",
  "--test", "go test ./...",
  "--mutate", "printf 'package calc\\n\\nfunc Add(a, b int) int { return a - b }\\n' > calc.go",
  "--mutation", "Add subtracts instead of adding",
];

test("a Maven-shaped repo gets a proven cache: the count proof, derivedAt, installClean — and the reader accepts it", () => {
  const { dir, head } = repo(MAVEN_FILES);
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 0, r.err);
  const cache = JSON.parse(readFileSync(cachePath(dir), "utf8"));
  assert.deepEqual(cache, {
    install: "mvn -q dependency:go-offline",
    test: "mvn -q test",
    derivedAt: head,
    installClean: true,
    testCount: 1,
  });
  assert.deepEqual([read(dir, "install").out, read(dir, "test").out], ["mvn -q dependency:go-offline", "mvn -q test"]);
});

test("a Go-shaped repo gets a proven cache through the mutation proof, which records what turned the run red", () => {
  const { dir, head } = repo(GO_FILES);
  const r = prove(dir, GO_PROOF);
  assert.equal(r.status, 0, r.err);
  const cache = JSON.parse(readFileSync(cachePath(dir), "utf8"));
  assert.equal(cache.install, "go mod download");
  assert.equal(cache.test, "go test ./...");
  assert.equal(cache.derivedAt, head);
  assert.equal(cache.installClean, true);
  assert.equal(cache.testCount, undefined);
  assert.match(cache.mutation, /^Add subtracts instead of adding — turned the run red \(exit 1\); changed calc\.go$/);
  assert.equal(read(dir, "test").out, "go test ./...");
});

test("the Maven fixture with its tests deleted gets NO cache, and the refusal names vacuity", () => {
  const { dir } = repo(withoutTests(MAVEN_FILES));
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — vacuous: the Test entrypoint's output does not contain the count line 'Tests run: 1,'/);
  assert.match(r.err, /No Recipe cache written/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("the Go fixture with its tests deleted gets NO cache: the mutation leaves the run green, which is vacuity", () => {
  const { dir } = repo(withoutTests(GO_FILES));
  const r = prove(dir, GO_PROOF);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — vacuous: the mutation \(Add subtracts instead of adding\) did not turn the run red/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("a count proof of zero tests is a failed proof, even when the runner prints exactly that", () => {
  const { dir } = repo(withoutTests(MAVEN_FILES));
  const r = prove(dir, ["--install", "true", "--test", "echo 'tests 0'", "--count-line", "tests 0", "--test-count", "0"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /NOT PROVEN — vacuous: a test count of 0/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("the claimed count must be the number on the count line, not any number", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "true", "--test", "mvn -q test", "--count-line", "Tests run: 1,", "--test-count", "7"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /the count line 'Tests run: 1,' does not carry the test count 7/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("an Install step that changes a tracked file is not proven", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "echo '<!-- -->' >> pom.xml", ...MAVEN_PROOF.slice(2)]);
  assert.equal(r.status, 1);
  assert.match(r.err, /NOT PROVEN — the Install step changed the tree \(first:  M pom\.xml\)/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("an Install step that creates a file the tree neither tracks nor ignores is not proven", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", ": > deps.lock", ...MAVEN_PROOF.slice(2)]);
  assert.equal(r.status, 1);
  assert.match(r.err, /the Install step changed the tree \(first: \?\? deps\.lock\)/);
});

test("an Install step whose output the repo ignores IS proven — build output is not a dirty tree", () => {
  // The stub mvn's dependency goal writes target/deps; the fixture ignores
  // target/. Refusing here would refuse every repo whose install builds.
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 0, r.err);
});

test("an Install step or Test entrypoint that does not RUN is named as such", () => {
  const { dir } = repo(MAVEN_FILES);
  const i = prove(dir, ["--install", "no-such-installer-xyz", ...MAVEN_PROOF.slice(2)]);
  assert.equal(i.status, 1);
  assert.match(i.err, /NOT PROVEN — the Install step 'no-such-installer-xyz' did not run \(exit 127: not executable or not found\)/);
  const t = prove(dir, ["--install", "true", "--test", "no-such-runner-xyz", "--count-line", "x 1", "--test-count", "1"]);
  assert.equal(t.status, 1);
  assert.match(t.err, /NOT PROVEN — the Test entrypoint 'no-such-runner-xyz' did not run \(exit 127/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("an Install step that fails is not proven", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "exit 3", ...MAVEN_PROOF.slice(2)]);
  assert.equal(r.status, 1);
  assert.match(r.err, /NOT PROVEN — the Install step 'exit 3' failed \(exit 3\)/);
});

test("the mutation proof refuses a red baseline: a mutation turning a red run red proves nothing", () => {
  const { dir } = repo(GO_FILES);
  const r = prove(dir, ["--install", "true", "--test", "go test ./... && exit 1", ...GO_PROOF.slice(4)]);
  assert.equal(r.status, 1);
  assert.match(r.err, /the unmutated run is already red \(exit 1\), so a mutation turning it red proves nothing — use the count proof/);
});

test("a mutation that changes no tracked file is refused, not counted as red", () => {
  const { dir } = repo(GO_FILES);
  const r = prove(dir, ["--install", "true", "--test", "go test ./...", "--mutate", ": > new_test.go", "--mutation", "adds a file"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /the mutation \(adds a file\) changed no tracked file/);
});

test("a mutation that stages its edit still counts as changing a tracked file", () => {
  const { dir } = repo(GO_FILES);
  const r = prove(dir, [...GO_PROOF.slice(0, 4), "--mutate", `${GO_PROOF[5]} && git add calc.go`, "--mutation", "Add subtracts, staged"]);
  assert.equal(r.status, 0, r.err);
  assert.match(JSON.parse(readFileSync(cachePath(dir), "utf8")).mutation, /changed calc\.go$/);
});

test("no proof given is a refusal that still shows where the run's output is", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "true", "--test", "mvn -q test"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /NOT PROVEN — no proof given/);
  const log = r.err.match(/test output: (\S+)/);
  assert.ok(log, r.err);
  assert.match(readFileSync(log[1], "utf8"), /Tests run: 1, Failures: 0/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("the proof runs against origin/main, not the checkout's own HEAD, and derivedAt says so", () => {
  // The local branch has deleted the tests; origin/main still has them. A
  // proof run against the checkout would be vacuous — against origin/main it
  // is not.
  const { dir, head } = repo(MAVEN_FILES);
  rmSync(join(dir, "src", "test"), { recursive: true });
  git(dir, "commit", "-q", "-am", "drop tests locally");
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).derivedAt, head);
});

test("a failed proof leaves an existing cache byte-identical — it never writes on a guess", () => {
  const { dir } = repo(withoutTests(MAVEN_FILES));
  mkdirSync(join(dir, ".fleet"));
  writeFileSync(cachePath(dir), "prior bytes");
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(cachePath(dir), "utf8"), "prior bytes");
});

test("a cache the reader would refuse is not left behind: it is rolled back to what stood before", () => {
  // `mvn -q test;` runs fine under sh -c, but a trailing `;` would let a
  // runner-appended argument run as its own command, so the reader refuses it.
  const { dir } = repo(MAVEN_FILES);
  mkdirSync(join(dir, ".fleet"));
  writeFileSync(cachePath(dir), "prior bytes");
  const r = prove(dir, ["--install", "true", "--test", "mvn -q test;", "--count-line", "Tests run: 1,", "--test-count", "1"]);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — the Recipe cache reader refuses what was proven: .*ends in ';'/);
  assert.equal(readFileSync(cachePath(dir), "utf8"), "prior bytes");

  const { dir: fresh } = repo(MAVEN_FILES);
  const f = prove(fresh, ["--install", "true", "--test", "mvn -q test;", "--count-line", "Tests run: 1,", "--test-count", "1"]);
  assert.equal(f.status, 1);
  assert.equal(existsSync(cachePath(fresh)), false, "no prior cache: the refused one is removed, not left");
});

// The suite moved on origin/main and the main checkout was never updated: its
// index lists `old/a.txt`, origin/main (the tree the proof ran in, and the one
// a claim cuts its worktree from) holds `tests/a.txt`. The glob in the Test
// entrypoint selects a file only in the second.
function movedLayout() {
  const { dir } = repo({ "old/a.txt": "1\n" });
  git(dir, "mv", "old", "tests");
  git(dir, "commit", "-q", "-m", "move the suite");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  return dir;
}
// `true` ignores its arguments, so the run passes whatever the glob selects and
// only the reader's check of the glob can tell the two trees apart.
const GLOB_PROOF = (glob) => ["--install", "true", "--test", `printf 'Tests run: 1, Failures: 0\\n' && true ${glob}`, "--count-line", "Tests run: 1,", "--test-count", "1"];

test("a Recipe proven at origin/main is read back against that tree, so a checkout still on the old layout does not refuse it", () => {
  const dir = movedLayout();
  const r = prove(dir, GLOB_PROOF("tests/*.txt"));
  assert.equal(r.status, 0, r.err);
  const recipe = JSON.parse(readFileSync(cachePath(dir), "utf8"));
  // The claim's own read of the Test entrypoint accepts what was just proven.
  const claimRead = spawnSync("sh", [READER, dir, "test", "--at", "origin/main"], { encoding: "utf8", env: FIXTURE_ENV });
  assert.equal(claimRead.status, 0, claimRead.stderr);
  assert.equal(claimRead.stdout.replace(/\n$/, ""), recipe.test);
});

test("a Test entrypoint whose glob matches nothing at origin/main is not proven, though the checkout's index lists a match", () => {
  const dir = movedLayout();
  const r = prove(dir, GLOB_PROOF("old/*.txt"));
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — the Recipe cache reader refuses what was proven: .*matches no file tracked in .* at /);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("from a linked worktree the cache lands beside the common git dir — the main checkout the reader reads", () => {
  const { dir, head } = repo(MAVEN_FILES);
  const wt = join(tempDir("recipe-prove-wt-"), "wt");
  git(dir, "worktree", "add", "-q", "--detach", wt);
  const r = prove(wt, MAVEN_PROOF);
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).derivedAt, head);
  assert.equal(existsSync(cachePath(wt)), false);
});

test("the throwaway worktree is removed afterwards, proven or not", () => {
  const { dir } = repo(MAVEN_FILES);
  prove(dir, MAVEN_PROOF);
  prove(dir, ["--install", "exit 3", ...MAVEN_PROOF.slice(2)]);
  assert.equal(worktrees(dir), 1);
});

test("an ambient GIT_DIR naming another repository does not change the answer", () => {
  const { dir, head } = repo(MAVEN_FILES);
  const { dir: other } = repo(withoutTests(MAVEN_FILES));
  const r = prove(dir, MAVEN_PROOF, { env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other } });
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).derivedAt, head);
  assert.equal(existsSync(cachePath(other)), false);
});

test("a proof that cannot be attempted exits 2, distinct from a Recipe that is not proven", () => {
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: FIXTURE_ENV });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: recipe-prove\.mjs <repo> --install <cmd> --test <cmd>/);

  const notRepo = prove(tempDir("recipe-prove-norepo-"), MAVEN_PROOF);
  assert.equal(notRepo.status, 2);
  assert.match(notRepo.err, /is not a git repository/);

  const { dir } = repo(MAVEN_FILES);
  git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  const noMain = prove(dir, MAVEN_PROOF);
  assert.equal(noMain.status, 2);
  assert.match(noMain.err, /origin\/main does not resolve to a commit/);

  const { dir: half } = repo(MAVEN_FILES);
  const r = prove(half, ["--install", "true", "--test", "mvn -q test", "--count-line", "Tests run: 1,"]);
  assert.equal(r.status, 2);
  assert.match(r.err, /--count-line and --test-count go together/);

  const nan = prove(half, ["--install", "true", "--test", "mvn -q test", "--count-line", "Tests run: 1,", "--test-count", "1e0"]);
  assert.equal(nan.status, 2);
  assert.match(nan.err, /--test-count must be a whole number, got '1e0'/);

  // A flag where a value belongs is a missing value, never the command. The
  // fixture must be one whose swallowed value would otherwise be ACCEPTED: with
  // `--install --test "mvn -q test"` the later iteration refuses on its own
  // and the guard under test is never what fires.
  const missing = prove(half, ["--install", "--test", "--test", "mvn -q test"]);
  assert.equal(missing.status, 2);
  assert.match(missing.err, /^recipe-prove: usage:/);
  assert.equal(worktrees(half), 1,
    "a refusal at the argument boundary creates no worktree");
});

// The number of worktrees the repository at `dir` has registered, the main checkout included.
const worktrees = (dir) => git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

// Every temp dir the proof made, scanned for the throwaway worktree it names `wt`.
function assertNoWorktreeLeft(tmp) {
  for (const d of readdirSync(tmp)) {
    assert.deepEqual(readdirSync(join(tmp, d)).filter((n) => n === "wt"), [], `${d} still holds the throwaway worktree`);
  }
}

// The log directories the proof made in its TMPDIR.
const logDirs = (tmp) => readdirSync(tmp).filter((n) => n.startsWith("recipe-prove-"));

test("a proof that held leaves neither a worktree nor a log directory behind in its TMPDIR", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(logDirs(r.tmp), []);
});

test("a proof that did not hold keeps its log directory, with the log its refusal names", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "echo fetching deps; exit 3", ...MAVEN_PROOF.slice(2)]);
  assert.equal(r.status, 1, r.err);
  const log = r.err.match(/install output: (\S+)/);
  assert.ok(log, r.err);
  const kept = logDirs(r.tmp);
  assert.equal(kept.length, 1, `log directories in ${r.tmp}: ${kept}`);
  assert.equal(log[1], join(r.tmp, kept[0], "install.log"));
  assert.match(readFileSync(log[1], "utf8"), /fetching deps/);
  assertNoWorktreeLeft(r.tmp);
});

// Every refusal the proof stage throws names a log in the directory it keeps,
// so a kept directory is never one the caller has no path to.
const KEPT_REFUSALS = [
  {
    name: "an Install step that changed the tree",
    files: MAVEN_FILES,
    args: ["--install", ": > deps.lock", ...MAVEN_PROOF.slice(2)],
    reason: /the Install step changed the tree/,
    log: "install.log",
  },
  {
    name: "a count line that lacks the claimed count",
    files: MAVEN_FILES,
    args: ["--install", "true", "--test", "mvn -q test", "--count-line", "Tests run: 1,", "--test-count", "7"],
    reason: /does not carry the test count 7/,
    log: "test.log",
  },
  {
    name: "a mutation that changed no tracked file",
    files: GO_FILES,
    args: ["--install", "true", "--test", "go test ./...", "--mutate", ": > new_test.go", "--mutation", "adds a file"],
    reason: /changed no tracked file/,
    log: "mutate.log",
  },
];

for (const c of KEPT_REFUSALS) {
  test(`${c.name} keeps its log directory, and the refusal names the log in it`, () => {
    const { dir } = repo(c.files);
    const r = prove(dir, c.args);
    assert.equal(r.status, 1, r.err);
    assert.match(r.err, c.reason);
    const kept = logDirs(r.tmp);
    assert.equal(kept.length, 1, `log directories in ${r.tmp}: ${kept}`);
    const log = join(r.tmp, kept[0], c.log);
    assert.ok(r.err.includes(log), `${log} not named in: ${r.err}`);
    assert.ok(existsSync(log), `${log} does not exist`);
  });
}

test("a refusal that names no log leaves no log directory behind", () => {
  // The Recipe cache reader refuses a Test entrypoint ending in `;` after the
  // proof held, so no log in the directory is what the refusal is about.
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "true", "--test", "mvn -q test;", "--count-line", "Tests run: 1,", "--test-count", "1"]);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /the Recipe cache reader refuses what was proven/);
  assert.deepEqual(logDirs(r.tmp), []);
});

test("a throwaway worktree that cannot be made is exit 2 and leaves no log directory behind", () => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const { dir } = repo(MAVEN_FILES);
  const bin = tempDir("recipe-prove-path-");
  writeExecStub(join(bin, "git"), `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then echo 'fatal: no worktree here' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`);
  const r = prove(dir, MAVEN_PROOF, { env: { PATH: `${bin}:${BIN}:${process.env.PATH}` } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /could not create the throwaway worktree: fatal: no worktree here/);
  assert.deepEqual(logDirs(r.tmp), []);
});

test("a git that cannot be started is named as such, not reported as a missing repository", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, MAVEN_PROOF, { env: { PATH: "/nonexistent" } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /^recipe-prove: could not start git: .*ENOENT/);
  assert.doesNotMatch(r.err, /not a git repository/);
});

// A PATH holding only `sh` and a `git` that execs the real one, so the Install
// step can take git away by deleting it: every later git call then
// fails to start, in the proof and in the worktree cleanup alike.
test("a git that stops starting during the Install step is no verdict, never NOT PROVEN — and the worktree is still removed", () => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const { dir } = repo(MAVEN_FILES);
  const bin = tempDir("recipe-prove-path-");
  writeExecStub(join(bin, "git"), `#!/bin/sh\nexec '${realGit}' "$@"\n`);
  symlinkSync("/bin/sh", join(bin, "sh"));
  const install = `'${process.execPath}' -e 'require("fs").rmSync(process.argv[1])' '${join(bin, "git")}'`;
  const r = prove(dir, ["--install", install, "--test", "true", "--count-line", "x 1", "--test-count", "1"], { env: { PATH: bin } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /could not start git: .*ENOENT/);
  assert.match(r.err, /skipped git worktree remove/);
  assert.doesNotMatch(r.err, /NOT PROVEN/);
  assert.deepEqual(logDirs(r.tmp), [], "no verdict keeps no logs");
});

// A git that started and ran is never "could not start": here its status
// output outgrows spawnSync's default 1 MiB buffer, which kills it and sets
// `error` (ENOBUFS) on a process that did run. The tree the Install step left
// is unreadable, so the proof does not hold — NOT PROVEN, exit 1.
test("a git whose output outgrows the spawn buffer is a failed command, not a git that could not be started", () => {
  const { dir } = repo(MAVEN_FILES);
  const flood = 'const fs = require("fs"); for (let i = 0; i < 7000; i++) fs.writeFileSync("f".repeat(200) + i, "")';
  const install = `'${process.execPath}' -e '${flood}'`;
  const r = prove(dir, ["--install", install, "--test", "true", "--count-line", "x 1", "--test-count", "1"]);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — could not read the tree state in the throwaway worktree/);
  assert.doesNotMatch(r.err, /could not start git/);
});

// A `git` first on PATH that runs `act` when its arguments match the sh `case`
// pattern `when`, and otherwise execs the real one.
function fakeGit(when, act) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = tempDir("recipe-prove-path-");
  writeExecStub(join(bin, "git"), `#!/bin/sh\ncase "$*" in ${when}) ${act} ;; esac\nexec '${realGit}' "$@"\n`);
  return `${bin}:${BIN}:${process.env.PATH}`;
}

const COUNT_PROOF = ["--install", "true", "--test", "echo 'tests 1'", "--count-line", "tests 1", "--test-count", "1"];

// A git that ran and was killed has no exit status and, mostly, no stderr: its
// failure must name the kill, or every caller quoting git's reason quotes an
// empty one. Each caller keeps its own refusal class — NOT PROVEN (1) inside
// the proof, no verdict (2) for the probes that come before it.
const KILLED_GIT = [
  {
    name: "a git killed by SIGKILL reading the tree state",
    when: "status*", act: "kill -9 $$",
    status: 1, reason: /NOT PROVEN — could not read the tree state in the throwaway worktree: git was killed by SIGKILL; install output: /,
  },
  {
    name: "a git killed by SIGTERM reading the tree state",
    when: "status*", act: "kill -TERM $$",
    status: 1, reason: /NOT PROVEN — could not read the tree state in the throwaway worktree: git was killed by SIGTERM; install output: /,
  },
  {
    name: "a git killed for outgrowing the spawn buffer reading the tree state",
    when: "status*", act: "yes | head -c 2000000; exit 0",
    status: 1, reason: /NOT PROVEN — could not read the tree state in the throwaway worktree: git was killed by SIGTERM \(ENOBUFS: its output outgrew the spawn buffer\); install output: /,
  },
  {
    name: "a git that wrote to stderr and was then killed",
    when: "status*", act: "echo boom >&2; kill -9 $$",
    status: 1, reason: /NOT PROVEN — could not read the tree state in the throwaway worktree: boom; git was killed by SIGKILL; install output: /,
  },
  {
    name: "a git killed restoring the tree before the mutation",
    when: "reset*", act: "kill -9 $$", files: GO_FILES, args: GO_PROOF,
    status: 1, reason: /NOT PROVEN — could not restore the tree before the mutation: git was killed by SIGKILL; test output: /,
  },
  {
    name: "a git killed reading what the mutation changed",
    when: "diff*", act: "kill -9 $$", files: GO_FILES, args: GO_PROOF,
    status: 1, reason: /NOT PROVEN — could not read what the mutation changed: git was killed by SIGKILL; its output: /,
  },
  {
    name: "a git killed probing for the repository",
    when: '"rev-parse --git-dir"', act: "kill -9 $$",
    status: 2, reason: /^recipe-prove: .* is not a git repository: git was killed by SIGKILL$/m,
  },
  {
    name: "a git killed resolving the common git dir",
    when: '"rev-parse --path-format=absolute --git-common-dir"', act: "kill -9 $$",
    status: 2, reason: /^recipe-prove: cannot resolve the common git dir of .*: git was killed by SIGKILL$/m,
  },
  {
    name: "a git killed resolving origin/main",
    when: '"rev-parse --verify"*', act: "kill -9 $$",
    status: 2, reason: /^recipe-prove: origin\/main does not resolve to a commit \(git was killed by SIGKILL\) — fetch it/m,
  },
  {
    name: "a git killed creating the throwaway worktree",
    when: '"worktree add"*', act: "kill -9 $$",
    status: 2, reason: /^recipe-prove: could not create the throwaway worktree: git was killed by SIGKILL$/m,
  },
];

for (const c of KILLED_GIT) {
  test(`${c.name} names the signal in its refusal`, () => {
    const { dir } = repo(c.files ?? MAVEN_FILES);
    const r = prove(dir, c.args ?? COUNT_PROOF, { env: { PATH: fakeGit(c.when, c.act) } });
    assert.equal(r.status, c.status, r.err);
    assert.match(r.err, c.reason);
    assert.doesNotMatch(r.err, /could not start git/);
    if (c.status === 2) assert.doesNotMatch(r.err, /NOT PROVEN/);
  });
}

// The control: a git that ran and exited non-zero is quoted as it wrote, with
// no kill named.
test("a git that exits non-zero is refused with exactly its stderr, naming no signal", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, COUNT_PROOF, { env: { PATH: fakeGit("status*", "echo boom >&2; exit 3") } });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — could not read the tree state in the throwaway worktree: boom; install output: /);
  assert.doesNotMatch(r.err, /killed/);
});

// A `status` stub that ignores SIGTERM — and so does every command it starts —
// writes `?? ` and then `bytes` x's, and exits 0.
const trapTermStatus = (bytes) => `trap '' TERM; printf '?? '; head -c ${bytes} /dev/zero | tr '\\0' x; exit 0`;

// Past spawnSync's default 1 MiB buffer the kill that ENOBUFS sends is
// ignored: git exits 0 with no signal, but its output was cut off. That is a
// failed git, refused with a reason naming the overrun — read as ok, the
// truncated status would pass for a dirty tree.
test("a git that exits 0 after outgrowing the spawn buffer is refused, naming the overrun", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, COUNT_PROOF, { env: { PATH: fakeGit("status*", trapTermStatus(2_000_000)) } });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — could not read the tree state in the throwaway worktree: git exited 0 after an error \(ENOBUFS: its output outgrew the spawn buffer\); install output: /);
  assert.doesNotMatch(r.err, /killed|could not start git/);
});

// The control: the same stub writing 1000 bytes is a git that succeeded, its
// output read whole — here, one untracked path the Install step left.
test("the same SIGTERM-trapping git with small output is ok, its output intact", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, COUNT_PROOF, { env: { PATH: fakeGit("status*", trapTermStatus(997)) } });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — the Install step changed the tree \(first: \?\? x{997}\); /);
  assert.doesNotMatch(r.err, /ENOBUFS|could not read the tree state/);
});

// A killed `worktree remove` is a failed one: cleanup falls back to the plain
// delete, and the proof's own NOT PROVEN — which keeps its log directory,
// the throwaway worktree's parent — stands.
test("a git killed removing the throwaway worktree still leaves it deleted", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "false", "--test", "true", "--count-line", "x 1", "--test-count", "1"], {
    env: { PATH: fakeGit('"worktree remove"*', "kill -9 $$") },
  });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN — the Install step 'false' failed/);
  assert.doesNotMatch(r.err, /skipped git/);
  const kept = logDirs(r.tmp);
  assert.equal(kept.length, 1, `log directories in ${r.tmp}: ${kept}`);
  assert.equal(existsSync(join(r.tmp, kept[0], "wt")), false, "the throwaway worktree is gone");
  assert.equal(git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "only the main worktree stays registered");
});

// A git that starts for the worktree removal and not for the prune after it:
// the stub deletes itself once `worktree remove` has run. The proof's own
// outcome is NOT PROVEN (the Install step fails), and the prune that cannot
// start must not replace it.
test("a git that stops starting during cleanup does not replace the proof's own NOT PROVEN", () => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const { dir } = repo(MAVEN_FILES);
  const bin = tempDir("recipe-prove-path-");
  const stub = join(bin, "git");
  writeExecStub(stub, `#!/bin/sh\n'${realGit}' "$@"\nrc=$?\nif [ "$2" = remove ]; then /bin/rm -f '${stub}'; fi\nexit $rc\n`);
  symlinkSync("/bin/sh", join(bin, "sh"));
  const r = prove(dir, ["--install", "false", "--test", "true", "--count-line", "x 1", "--test-count", "1"], { env: { PATH: bin } });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /NOT PROVEN/);
  assert.match(r.err, /skipped git worktree prune: could not start git/);
});

// A PATH holding exactly what the proof and the Recipe cache reader run — `sh`,
// a `git` that execs the real one, `node`, and the reader's `mktemp`, `cat`
// and `rm` — so the Test entrypoint can take git away by deleting it. With the
// count proof no proof step runs git after the Test entrypoint, so the first
// thing to meet the missing git is the reader, during the read-back.
function readerPath() {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = tempDir("recipe-prove-path-");
  writeExecStub(join(bin, "git"), `#!/bin/sh\nexec '${realGit}' "$@"\n`);
  symlinkSync("/bin/sh", join(bin, "sh"));
  symlinkSync(process.execPath, join(bin, "node"));
  for (const tool of ["mktemp", "cat", "rm"]) {
    symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  return bin;
}

test("a git that stops starting before the cache is read back is no verdict, never NOT PROVEN — and the prior cache is restored", () => {
  // The control: the same PATH with git left in place is a proof that holds.
  const kept = repo(MAVEN_FILES);
  const ok = prove(kept.dir, ["--install", "true", "--test", "echo 'tests 1'", "--count-line", "tests 1", "--test-count", "1"], { env: { PATH: readerPath() } });
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.out, /^recipe-prove: PROVEN/);

  const { dir } = repo(MAVEN_FILES);
  mkdirSync(join(dir, ".fleet"));
  writeFileSync(cachePath(dir), "prior bytes");
  const bin = readerPath();
  const r = prove(dir, ["--install", "true", "--test", `rm '${join(bin, "git")}'; echo 'tests 1'`, "--count-line", "tests 1", "--test-count", "1"], { env: { PATH: bin } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /^recipe-prove: could not start git: .*ENOENT — the Recipe cache reader runs git, so its refusal is no verdict/m);
  assert.doesNotMatch(r.err, /NOT PROVEN/);
  assert.doesNotMatch(r.err, /not a git repository/);
  assert.equal(readFileSync(cachePath(dir), "utf8"), "prior bytes", "a cache the reader never settled is rolled back");
});

// A git that starts and cannot run fails the reader's own `git rev-parse` just
// as a git that will not start does, so its refusal is no verdict either. Each
// stub stands in for one such git: a wrapper whose target is gone exits 126 or
// 127, and a killed git has no exit status at all. The message names the exit
// status when there is one, and quotes what the stub wrote to stderr when
// there is anything to quote. The control — the same PATH with git left in
// place proves — is the unstartable-git test's. The Test entrypoint rewrites
// the stub's body, never the stub: that is a hard link to exec-stub.mjs's
// shared, read-only trampoline.
const GIT_THAT_CANNOT_RUN = [
  { name: "exits 126 and writes nothing", body: "exit 126", cause: "exited 126 and wrote nothing to stderr" },
  { name: "exits 127 and writes to stderr", body: "echo boom >&2; exit 127", cause: "exited 127: boom" },
  { name: "is killed by a signal", body: "kill -9 $$", cause: "did not exit 0: git was killed by SIGKILL" },
];
for (const c of GIT_THAT_CANNOT_RUN) {
  test(`a git that starts but ${c.name} before the cache is read back is no verdict, never NOT PROVEN — and the prior cache is restored`, () => {
    const { dir } = repo(MAVEN_FILES);
    mkdirSync(join(dir, ".fleet"));
    writeFileSync(cachePath(dir), "prior bytes");
    const bin = readerPath();
    const r = prove(dir, ["--install", "true", "--test", `printf '#!/bin/sh\\n${c.body}\\n' > '${join(bin, ".stub-git")}'; echo 'tests 1'`, "--count-line", "tests 1", "--test-count", "1"], { env: { PATH: bin } });
    assert.equal(r.status, 2, r.err);
    assert.ok(r.err.includes(`recipe-prove: git started but does not run: \`git --version\` ${c.cause} — the Recipe cache reader runs git, so its refusal is no verdict on what was proven`), r.err);
    assert.doesNotMatch(r.err, /NOT PROVEN/);
    assert.doesNotMatch(r.err, /not a git repository/);
    assert.equal(readFileSync(cachePath(dir), "utf8"), "prior bytes", "a cache the reader never settled is rolled back");
  });
}

// The reader's own `sh`, taken away the same way: a read-back that never ran
// read nothing, so it is no verdict either.
test("an sh that stops starting before the cache is read back is no verdict, never NOT PROVEN — and no cache is left", () => {
  const { dir } = repo(MAVEN_FILES);
  const bin = readerPath();
  const r = prove(dir, ["--install", "true", "--test", `rm '${join(bin, "sh")}'; echo 'tests 1'`, "--count-line", "tests 1", "--test-count", "1"], { env: { PATH: bin } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /^recipe-prove: could not start sh to read the Recipe cache back: .*ENOENT/m);
  assert.doesNotMatch(r.err, /NOT PROVEN/);
  assert.equal(existsSync(cachePath(dir)), false, "a cache the reader never read is rolled back");
});

// An `sh` first on PATH that runs `act` when it is asked to run the Recipe
// cache reader, and otherwise execs the real one — so the Install step and
// Test entrypoint run as before and only the read-back meets `act`.
function fakeReaderSh(act) {
  const realSh = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
  const bin = tempDir("recipe-prove-path-");
  writeExecStub(join(bin, "sh"), `#!/bin/sh\ncase "$1" in *derive-testcmd.sh) ${act} ;; esac\nexec '${realSh}' "$@"\n`);
  return `${bin}:${BIN}:${process.env.PATH}`;
}

// The control: the same `sh` in front of the reader, doing nothing to it, is
// a proof that holds — so the refusals below are about the kill, not the stub.
test("an sh stub in front of the Recipe cache reader that lets it run still proves", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, COUNT_PROOF, { env: { PATH: fakeReaderSh(":") } });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^recipe-prove: PROVEN/);
  assert.equal(existsSync(cachePath(dir)), true);
});

// The reader's `sh` killed mid-read has no exit status to read, so it reached
// no verdict: exit 2, and the message names the signal rather than quoting an
// empty reason.
for (const signal of ["SIGKILL", "SIGTERM"]) {
  test(`a reader sh killed by ${signal} is no verdict naming the signal, never NOT PROVEN — and the prior cache is restored`, () => {
    const { dir } = repo(MAVEN_FILES);
    mkdirSync(join(dir, ".fleet"));
    writeFileSync(cachePath(dir), "prior bytes");
    const path = fakeReaderSh(`kill -${signal.slice(3)} $$`);
    const r = prove(dir, COUNT_PROOF, { env: { PATH: path } });
    assert.equal(r.status, 2, r.err);
    assert.match(r.err, new RegExp(`^recipe-prove: the Recipe cache reader's sh was killed by ${signal}, so it reached no verdict on what was proven$`, "m"));
    assert.doesNotMatch(r.err, /NOT PROVEN/);
    assert.equal(readFileSync(cachePath(dir), "utf8"), "prior bytes", "a cache the reader never settled is rolled back");
    assert.deepEqual(logDirs(r.tmp), [], "no verdict keeps no logs");

    const { dir: fresh } = repo(MAVEN_FILES);
    const f = prove(fresh, COUNT_PROOF, { env: { PATH: path } });
    assert.equal(f.status, 2, f.err);
    assert.equal(existsSync(cachePath(fresh)), false, "no prior cache: the unsettled one is removed, not left");
  });
}

// A reader whose output outgrows spawnSync's buffer is killed by it: SIGTERM
// with an ENOBUFS `error`. The refusal names the signal and that cause, so it
// does not read as an outside kill.
test("a reader sh killed by an output overrun is no verdict naming the signal and ENOBUFS, never NOT PROVEN", () => {
  const { dir } = repo(MAVEN_FILES);
  const path = fakeReaderSh("head -c 2000000 /dev/zero | tr '\\0' x; exit 0");
  const r = prove(dir, COUNT_PROOF, { env: { PATH: path } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /^recipe-prove: the Recipe cache reader's sh was killed by SIGTERM \(ENOBUFS: its output outgrew the spawn buffer\), so it reached no verdict on what was proven$/m);
  assert.doesNotMatch(r.err, /NOT PROVEN/);
  assert.equal(existsSync(cachePath(dir)), false, "a cache the reader never settled is removed");
});

// A reader that refuses in silence is still the reader's refusal, but the
// message names its exit status instead of ending on an empty reason. Two
// codes, neither READER_COULD_NOT_RUN (which is no verdict): one code alone
// cannot tell the reader's real status from a hardcoded one.
for (const code of [1, 4]) {
  test(`a reader that exits ${code} and writes nothing is NOT PROVEN naming its exit status, never an empty reason`, () => {
    const { dir } = repo(MAVEN_FILES);
    const r = prove(dir, COUNT_PROOF, { env: { PATH: fakeReaderSh(`exit ${code}`) } });
    assert.equal(r.status, 1, r.err);
    assert.match(r.err, new RegExp(`^recipe-prove: NOT PROVEN — the Recipe cache reader refuses what was proven: it wrote nothing and exited with status ${code}$`, "m"));
    assert.equal(existsSync(cachePath(dir)), false);
  });
}

// A reader whose stderr is only whitespace but whose stdout holds a reason did
// write something: the reason is quoted, never the silent-refusal wording.
test("a reader that writes whitespace to stderr and a reason to stdout is NOT PROVEN quoting the reason", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, COUNT_PROOF, { env: { PATH: fakeReaderSh("printf '  \\n' >&2; echo 'a real reason'; exit 1") } });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /^recipe-prove: NOT PROVEN — the Recipe cache reader refuses what was proven: a real reason$/m);
  assert.doesNotMatch(r.err, /it wrote nothing/);
  assert.equal(existsSync(cachePath(dir)), false);
});

// The reader's other external tools, taken away the same way after the proof's
// last step. The control is the same PATH with the tool left in place, which
// proves — so the no verdict below is about the missing tool, not a PATH too
// thin for the reader to run at all. `rm` is the reader's cleanup only: it
// decides nothing about the cache, so the verdict stands without it.
const READER_TOOLS = [
  { tool: "node", reason: /derive-testcmd: node is unusable, refusing to read the Recipe cache without the interpreter/ },
  { tool: "mktemp", reason: /derive-testcmd: cannot create a temporary file to read the Recipe cache/ },
  { tool: "cat", reason: /derive-testcmd: cat could not be started/ },
];
for (const c of READER_TOOLS) {
  test(`a ${c.tool} that stops starting before the cache is read back is no verdict, never NOT PROVEN — and the prior cache is restored`, () => {
    const args = (cmd) => ["--install", "true", "--test", cmd, "--count-line", "tests 1", "--test-count", "1"];
    const kept = repo(MAVEN_FILES);
    const ok = prove(kept.dir, args(`echo 'tests 1'`), { env: { PATH: readerPath() } });
    assert.equal(ok.status, 0, ok.err);
    assert.match(ok.out, /^recipe-prove: PROVEN/);

    const { dir } = repo(MAVEN_FILES);
    mkdirSync(join(dir, ".fleet"));
    writeFileSync(cachePath(dir), "prior bytes");
    const bin = readerPath();
    const r = prove(dir, args(`rm '${join(bin, c.tool)}'; echo 'tests 1'`), { env: { PATH: bin } });
    assert.equal(r.status, 2, r.err);
    assert.match(r.err, c.reason);
    assert.match(r.err, /the Recipe cache reader could not run a tool it needs, so its refusal is no verdict/);
    assert.doesNotMatch(r.err, /NOT PROVEN/);
    assert.equal(readFileSync(cachePath(dir), "utf8"), "prior bytes", "a cache the reader never settled is rolled back");
    assert.deepEqual(logDirs(r.tmp), [], "no verdict keeps no logs");
  });
}

test("an rm that stops starting before the cache is read back leaves the proof standing — the reader's verdict never depended on it", () => {
  const { dir } = repo(MAVEN_FILES);
  const bin = readerPath();
  // `echo` leads the command: the reader refuses a Test entrypoint whose first word does not resolve, and `rm` would not once the PATH link is gone.
  const r = prove(dir, ["--install", "true", "--test", `echo 'tests 1'; rm '${join(bin, "rm")}'`, "--count-line", "tests 1", "--test-count", "1"], { env: { PATH: bin } });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^recipe-prove: PROVEN/);
  assert.equal(existsSync(cachePath(dir)), true);
});

// Whether the process ignores file modes: root writes into a 0555 directory.
const IGNORES_MODES = process.getuid?.() === 0 && "root ignores file modes";

// An Install step whose output the repo ignores and leaves read-only — a Go
// module cache is the usual one. git's own removal of the worktree fails on it.
const READ_ONLY_INSTALL = "mkdir -p build/x && : > build/x/f && chmod 555 build/x";
const IGNORING_BUILD = { ...MAVEN_FILES, ".gitignore": "target/\nbuild/\n" };

test("read-only install output cannot turn a proof that held into a crash", { skip: IGNORES_MODES }, () => {
  const { dir, head } = repo(IGNORING_BUILD);
  const r = prove(dir, ["--install", READ_ONLY_INSTALL, ...MAVEN_PROOF.slice(2)]);
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).derivedAt, head);
  assert.deepEqual(logDirs(r.tmp), []);
  assert.equal(worktrees(dir), 1);
});

test("read-only install output does not replace a refusal's reason with a stack trace", { skip: IGNORES_MODES }, () => {
  const { dir } = repo(IGNORING_BUILD);
  const r = prove(dir, ["--install", READ_ONLY_INSTALL, "--test", "echo 'tests 0'", "--count-line", "tests 0", "--test-count", "0"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /NOT PROVEN — vacuous: a test count of 0/);
  assert.doesNotMatch(r.err, /ENOTEMPTY/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("a cache that cannot be written is exit 2 with its reason, never a stack trace or a NOT PROVEN", { skip: IGNORES_MODES }, () => {
  const { dir } = repo(MAVEN_FILES);
  mkdirSync(join(dir, ".fleet"));
  chmodSync(join(dir, ".fleet"), 0o555);
  try {
    const r = prove(dir, MAVEN_PROOF);
    assert.equal(r.status, 2, r.err);
    assert.match(r.err, /^recipe-prove: EACCES/);
    assert.doesNotMatch(r.err, /\n\s+at /);
    assert.doesNotMatch(r.err, /NOT PROVEN/);
    assert.equal(r.out, "");
    assert.deepEqual(logDirs(r.tmp), [], "no verdict keeps no logs");
  } finally {
    chmodSync(join(dir, ".fleet"), 0o755);
  }
});

test("a command killed by a signal is refused, never counted as a red or a green run", () => {
  // The count proof: the output carries the count line, then the run dies.
  const { dir } = repo(MAVEN_FILES);
  const t = prove(dir, ["--install", "true", "--test", "echo 'tests 3'; kill -9 $$", "--count-line", "tests 3", "--test-count", "3"]);
  assert.equal(t.status, 1, t.err);
  assert.match(t.err, /NOT PROVEN — 'echo 'tests 3'; kill -9 \$\$' was killed by SIGKILL/);
  assert.equal(existsSync(cachePath(dir)), false);

  // The mutation proof: the unmutated run is green, the mutated one dies — a
  // crash is not a test failing.
  const { dir: go } = repo(GO_FILES);
  const dies = "if grep -q 'a - b' calc.go; then kill -9 $$; else go test ./...; fi";
  const m = prove(go, ["--install", "true", "--test", dies, ...GO_PROOF.slice(4)]);
  assert.equal(m.status, 1, m.err);
  assert.match(m.err, /NOT PROVEN — '.*kill -9 \$\$.*' was killed by SIGKILL/);
  assert.equal(existsSync(cachePath(go)), false);
});

test("an untracked file an Install step creates is seen even under status.showUntrackedFiles=no", () => {
  const { dir } = repo(MAVEN_FILES);
  git(dir, "config", "status.showUntrackedFiles", "no");
  const r = prove(dir, ["--install", ": > deps.lock", ...MAVEN_PROOF.slice(2)]);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /the Install step changed the tree \(first: \?\? deps\.lock\)/);
  assert.equal(existsSync(cachePath(dir)), false);
});

test("the claimed count is a whole number on the count line, leading zeros aside", () => {
  const claim = (line, n) => {
    const { dir } = repo(MAVEN_FILES);
    return { dir, ...prove(dir, ["--install", "true", "--test", `echo '${line}'`, "--count-line", line, "--test-count", n]) };
  };
  // 1 is a substring of 11 and of 21, and is not the number either line carries.
  for (const line of ["Tests run: 11", "21 passed"]) {
    const r = claim(line, "1");
    assert.equal(r.status, 1, `${line}: ${r.err}`);
    assert.match(r.err, /does not carry the test count 1/);
    assert.equal(existsSync(cachePath(r.dir)), false);
  }
  // A runner that zero-pads its count still carries it.
  const padded = claim("tests 01", "1");
  assert.equal(padded.status, 0, padded.err);
  assert.equal(JSON.parse(readFileSync(cachePath(padded.dir), "utf8")).testCount, 1);
});

test("the Install step and the Test entrypoint run against their own worktree whatever GIT_DIR the caller exports", () => {
  // Each command asks git where it is: with an ambient GIT_DIR/GIT_WORK_TREE
  // reaching the `sh -c` child, the answer is the other repository.
  const here = 'test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"';
  const args = ["--install", here, "--test", `${here} && mvn -q test`, "--count-line", "Tests run: 1,", "--test-count", "1"];
  const { dir } = repo(MAVEN_FILES);
  const control = prove(dir, args);
  assert.equal(control.status, 0, `the commands pass without an ambient GIT_DIR: ${control.err}`);

  const { dir: other } = repo(withoutTests(MAVEN_FILES));
  const { dir: dir2 } = repo(MAVEN_FILES);
  const r = prove(dir2, args, { env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other } });
  assert.equal(r.status, 0, r.err);
});

test("exit 126 and 127 both mean a command did not RUN, in the Install step and in the Test entrypoint", () => {
  const { dir } = repo({ ...MAVEN_FILES, "t.sh": "echo 'Tests run: 1,'\n" });
  // t.sh is committed 0644: `sh -c ./t.sh` exits 126, "found but not executable".
  const i = prove(dir, ["--install", "./t.sh", ...MAVEN_PROOF.slice(2)]);
  assert.equal(i.status, 1);
  assert.match(i.err, /the Install step '\.\/t\.sh' did not run \(exit 126/);
  const t = prove(dir, ["--install", "true", "--test", "./t.sh", "--count-line", "Tests run: 1,", "--test-count", "1"]);
  assert.equal(t.status, 1);
  assert.match(t.err, /the Test entrypoint '\.\/t\.sh' did not run \(exit 126/);
});

test("a mutation command that fails, or that leaves nothing runnable, or that breaks git itself, is refused for that reason", () => {
  const { dir } = repo(GO_FILES);
  const failing = prove(dir, ["--install", "true", "--test", "go test ./...", "--mutate", "exit 3", "--mutation", "x"]);
  assert.equal(failing.status, 1);
  assert.match(failing.err, /the mutation command 'exit 3' failed \(exit 3\)/);

  // The Test entrypoint is an executable the mutation deletes: the mutated run
  // exits 127, which is not a red suite.
  const { dir: tool } = repo({ tool: "#!/bin/sh\necho 'Tests run: 1,'\n" });
  git(tool, "update-index", "--chmod=+x", "tool");
  git(tool, "commit", "-q", "--amend", "--no-edit");
  git(tool, "update-ref", "refs/remotes/origin/main", "HEAD");
  const gone = prove(tool, ["--install", "true", "--test", "./tool", "--mutate", "rm tool", "--mutation", "delete the runner"]);
  assert.equal(gone.status, 1);
  assert.match(gone.err, /the Test entrypoint did not run on the mutated tree \(exit 127\)/);

  // A mutation that removes the worktree's link to its repository leaves
  // git unable to say what changed.
  const { dir: blind } = repo(GO_FILES);
  const lost = prove(blind, ["--install", "true", "--test", "go test ./...", "--mutate", "rm .git", "--mutation", "orphan the tree"]);
  assert.equal(lost.status, 1);
  assert.match(lost.err, /could not read what the mutation changed/);
});

test("the mutation is credited only with what it changed, never with what the unmutated Test run rewrote", () => {
  // t.sh is red while state.txt holds anything, and otherwise writes into it:
  // the unmutated run rewrites a tracked file.
  const files = { "state.txt": "", "t.sh": "if [ -s state.txt ]; then exit 1; fi\necho run > state.txt\n" };
  const { dir } = repo(files);
  const noop = prove(dir, ["--install", "true", "--test", "sh t.sh", "--mutate", "true", "--mutation", "no-op"]);
  assert.equal(noop.status, 1, noop.err);
  assert.match(noop.err, /the mutation \(no-op\) changed no tracked file/);
  assert.equal(existsSync(cachePath(dir)), false);

  // A genuine mutation of a file the run also rewrites is still a mutation.
  const { dir: real } = repo(files);
  const r = prove(real, ["--install", "true", "--test", "sh t.sh", "--mutate", "echo x > state.txt", "--mutation", "poison the state"]);
  assert.equal(r.status, 0, r.err);
  assert.match(JSON.parse(readFileSync(cachePath(real), "utf8")).mutation, /changed state\.txt$/);
});

// Every Recipe command runs under a time bound, shortened here through
// RECIPE_PROVE_TIMEOUT so a hang costs seconds. Each case below hangs one of
// the four commands the proof runs; a bound that missed one would leave that
// case to the helper's own 60s spawn timeout, which reads as status null.
const timedOut = (cmd, seconds) =>
  new RegExp(`NOT PROVEN — '${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' timed out: still running after ${seconds}s, the bound on each Recipe command`);

const HANGS = [
  {
    name: "an Install step",
    files: MAVEN_FILES,
    seconds: 1,
    hung: "echo fetching deps; exec sleep 30",
    args: (hung) => ["--install", hung, ...MAVEN_PROOF.slice(2)],
    log: "install.log",
    output: /fetching deps/,
  },
  {
    name: "a Test entrypoint",
    files: MAVEN_FILES,
    seconds: 1,
    hung: "echo 'Tests run: 1,'; exec sleep 30",
    args: (hung) => ["--install", "true", "--test", hung, "--count-line", "Tests run: 1,", "--test-count", "1"],
    log: "test.log",
    output: /Tests run: 1,/,
  },
  // The two below run a healthy command first, so their bound leaves it room.
  {
    name: "a mutation command",
    files: GO_FILES,
    seconds: 3,
    hung: "echo mutating; exec sleep 30",
    args: (hung) => [...GO_PROOF.slice(0, 4), "--mutate", hung, "--mutation", "never finishes"],
    log: "mutate.log",
    output: /mutating/,
  },
  {
    name: "a mutated Test run",
    files: GO_FILES,
    seconds: 3,
    hung: "if grep -q 'a - b' calc.go; then echo mutated; exec sleep 30; else go test ./...; fi",
    args: (hung) => ["--install", "true", "--test", hung, ...GO_PROOF.slice(4)],
    log: "test-mutated.log",
    output: /mutated/,
  },
];

for (const c of HANGS) {
  test(`${c.name} that never finishes is refused as timed out, NOT PROVEN, naming the bound and its log`, () => {
    const { dir } = repo(c.files);
    // A cache from an earlier proof: a refusal must leave its bytes alone.
    mkdirSync(join(dir, ".fleet"));
    writeFileSync(cachePath(dir), '{"earlier":"cache"}\n');
    const start = Date.now();
    const r = prove(dir, c.args(c.hung), { env: { RECIPE_PROVE_TIMEOUT: String(c.seconds) } });
    const elapsed = Date.now() - start;
    assert.equal(r.status, 1, `status ${r.status} after ${elapsed} ms: ${r.err}`);
    assert.match(r.err, timedOut(c.hung, c.seconds));
    assert.doesNotMatch(r.err, /could not start sh/);
    assert.doesNotMatch(r.err, /was killed by/, "a timeout is named as one, not as a bare signal");
    assert.ok(elapsed < 20_000, `the 30s command was not cut at the ${c.seconds}s bound: ${elapsed} ms`);
    // The log the refusal names is kept, with what the command printed before the kill.
    const log = r.err.match(/output: (\S+)$/m);
    assert.ok(log, r.err);
    assert.ok(log[1].endsWith(`/${c.log}`), `${log[1]} is not the ${c.log}`);
    assert.match(readFileSync(log[1], "utf8"), c.output);
    // The throwaway worktree is removed and unregistered, and the cache untouched.
    assertNoWorktreeLeft(r.tmp);
    assert.equal(worktrees(dir), 1, git(dir, "worktree", "list"));
    assert.equal(readFileSync(cachePath(dir), "utf8"), '{"earlier":"cache"}\n');
  });
}

// SIGTERM, the default kill signal, is one a command can trap: spawnSync then
// waits on it forever. The bound must not depend on the command's consent.
test("a command that ignores SIGTERM is still refused at the bound, not waited on", () => {
  const { dir } = repo(MAVEN_FILES);
  const hung = "trap '' TERM; while :; do sleep 1; done";
  const start = Date.now();
  const r = prove(dir, ["--install", "true", "--test", hung, "--count-line", "x", "--test-count", "1"], { env: { RECIPE_PROVE_TIMEOUT: "1" } });
  const elapsed = Date.now() - start;
  assert.equal(r.status, 1, `status ${r.status} after ${elapsed} ms: ${r.err}`);
  assert.match(r.err, timedOut(hung, 1));
  assert.ok(elapsed < 20_000, `the bound did not stop a command that traps SIGTERM: ${elapsed} ms`);
  assert.equal(existsSync(cachePath(dir)), false);
  assert.equal(worktrees(dir), 1, git(dir, "worktree", "list"));
});

// The bound is per command, never one budget for the whole proof: two
// commands each under it, together over it, still prove.
test("commands that each finish inside the bound still prove, whatever their total", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, ["--install", "sleep 3", "--test", "sleep 3; mvn -q test", ...MAVEN_PROOF.slice(4)], { env: { RECIPE_PROVE_TIMEOUT: "5" } });
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).testCount, 1);
});

// RECIPE_PROVE_TIMEOUT may only shorten the 20-minute default: a value that is
// not a whole number of seconds strictly between 0 and the default leaves the
// default standing. `3.5` and `-5` are numbers Number() would take; a bound
// they set would be configuration lengthening or removing nothing it may.
test("RECIPE_PROVE_TIMEOUT can only shorten the default bound", () => {
  const DEFAULT_MS = 20 * 60 * 1000;
  assert.equal(commandBudget(undefined), DEFAULT_MS);
  for (const ignored of ["", "0", "abc", "3.5", "-5", " 5", "5e3", "1200", "1201", "86400"]) {
    assert.equal(commandBudget(ignored), DEFAULT_MS, `RECIPE_PROVE_TIMEOUT=${JSON.stringify(ignored)} changed the bound`);
  }
  assert.equal(commandBudget("1"), 1000);
  assert.equal(commandBudget("1199"), 1_199_000);
  assert.equal(commandBudget("007"), 7000);
});
