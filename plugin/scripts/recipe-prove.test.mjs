import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.mjs";
import { writeExecStub } from "./exec-stub.mjs";

// recipe-prove.mjs is the Recipe derivation step's proof and the ONE writer of
// the Recipe cache: the deriving agent chooses the Install step and the Test
// entrypoint by reading the repository, and this script is what turns that
// guess into a cache — or refuses to. These fixtures stand in for two
// ecosystems the plugin keeps no knowledge of: a Maven-shaped repo and a
// Go-shaped one, each run through a stub of its own toolchain on PATH, so the
// suite needs neither `mvn` nor `go` and still exercises a command the
// plugin never names.
const SCRIPT = join(import.meta.dirname, "recipe-prove.mjs");
const READER = join(import.meta.dirname, "derive-testcmd.sh");

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
  assert.equal(git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
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
  assert.equal(git(half, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1,
    "a refusal at the argument boundary creates no worktree");
});

test("the proof leaves no worktree directory behind in its temp dir", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, MAVEN_PROOF);
  assert.equal(r.status, 0, r.err);
  for (const d of readdirSync(r.tmp)) {
    assert.deepEqual(readdirSync(join(r.tmp, d)).filter((n) => n === "wt"), [], `${d} still holds the throwaway worktree`);
  }
});

test("a git that cannot be started is named as such, not reported as a missing repository", () => {
  const { dir } = repo(MAVEN_FILES);
  const r = prove(dir, MAVEN_PROOF, { env: { PATH: "/nonexistent" } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /^recipe-prove: could not start git: .*ENOENT/);
  assert.doesNotMatch(r.err, /not a git repository/);
});

// A PATH holding only `sh` and a `git` that execs the real one, so the Install
// step can take git away mid-proof by deleting it: every later git call then
// fails to start, in the proof and in the worktree cleanup alike.
test("a git that stops starting mid-proof is no verdict, never NOT PROVEN — and the worktree is still removed", () => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const { dir } = repo(MAVEN_FILES);
  const bin = tempDir("recipe-prove-path-");
  writeExecStub(join(bin, "git"), `#!/bin/sh\nexec '${realGit}' "$@"\n`);
  symlinkSync("/bin/sh", join(bin, "sh"));
  const install = `'${process.execPath}' -e 'require("fs").rmSync(process.argv[1])' '${join(bin, "git")}'`;
  const r = prove(dir, ["--install", install, "--test", "true", "--count-line", "x 1", "--test-count", "1"], { env: { PATH: bin } });
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /could not start git: .*ENOENT/);
  assert.doesNotMatch(r.err, /NOT PROVEN/);
  for (const d of readdirSync(r.tmp)) {
    assert.deepEqual(readdirSync(join(r.tmp, d)).filter((n) => n === "wt"), [], `${d} still holds the throwaway worktree`);
  }
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
  for (const d of readdirSync(r.tmp)) {
    assert.deepEqual(readdirSync(join(r.tmp, d)).filter((n) => n === "wt"), [], `${d} still holds the throwaway worktree`);
  }
  assert.equal(git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
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
