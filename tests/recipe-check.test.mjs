// `recipe-check.mjs` records that the Recipe's Check step and the Test
// entrypoint passed on the staged tree, and `ledger.mjs settle --from-report`
// refuses an implementer's or a fix-applier's report whose head has no such
// record. Every record and settle case runs the real scripts against a
// throwaway origin + clone holding a Recipe cache, with a `gh` stub on PATH for
// the PR reads.
//
// The Check step and the Test entrypoint are two tracked scripts that append
// to an ignored `ran.log`, so a case can tell which command ran and how often:
// ignored `check.fail` / `test.fail` files make the matching one exit 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { slotHome, SUITE_SLOT } from "./support/suite-slot-home.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { ref, prUrl } from "./support/queue-gh.mjs";
import { parseCounts } from "../plugin/scripts/recipe-check.mjs";

const RECIPE_CHECK = fileURLToPath(new URL("../plugin/scripts/recipe-check.mjs", import.meta.url));
const LEDGER = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const TEST_CMD = "sh ./t.sh";

function fixture({ check = "sh ./check.sh" } = {}) {
  const root = tempDir("recipe-check-");
  const env = { ...process.env, ...GIT_ENV };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GH_REPO"]) delete env[k];
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "-c", "init.defaultBranch=main", "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(work, "check.sh"), "[ -f check.fail ] && { echo 'check red'; exit 1; }\necho check >> ran.log\n");
  writeFileSync(join(work, "t.sh"), "[ -f test.fail ] && { printf '# tests 3\\n# pass 2\\n# fail 1\\n'; exit 1; }\necho test >> ran.log\nprintf '# tests 3\\n# pass 3\\n# fail 0\\n'\n");
  // What a case leaves untracked in the worktree — the Recipe cache, the run
  // log, the failure markers — is ignored, as a real checkout ignores `.fleet/`.
  writeFileSync(join(work, ".gitignore"), ".fleet/\nran.log\n*.fail\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "root");
  git(work, "push", "-q", "-u", "origin", "main");
  const main = git(work, "rev-parse", "HEAD");
  mkdirSync(join(work, ".fleet"));
  const recipe = (over = {}) => ({
    install: "true",
    check,
    ...(check === true ? {} : { checkMutation: "break check.sh" }),
    test: TEST_CMD,
    derivedAt: main,
    installClean: true,
    testCount: 3,
    uncovered: [],
    ...over,
  });
  const writeRecipe = (over) => writeFileSync(join(work, ".fleet", "recipe.json"), JSON.stringify(recipe(over)));
  writeRecipe();

  const reports = join(root, "reports");
  mkdirSync(reports);
  const ghDir = join(root, "gh");
  mkdirSync(ghDir);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), `#!/bin/sh
[ "$1 $2" = "pr view" ] || { echo "gh stub: unexpected gh $*" >&2; exit 64; }
f='${ghDir}'/"$3.json"
[ -r "$f" ] || { echo "gh stub: no PR $3" >&2; exit 1; }
cat "$f"
`);
  // git, with a fetch and a tree read each made to fail on request.
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeExecStub(join(bin, "git"), `#!/bin/sh
for a in "$@"; do
  case $a in
    fetch) [ -f '${join(root, "fetch-fails")}' ] && { echo "git stub: fetch refused" >&2; exit 128; } ;;
    *'^{tree}') [ -f '${join(root, "tree-fails")}' ] && { echo "git stub: tree refused" >&2; exit 128; } ;;
  esac
done
exec '${realGit}' "$@"
`);
  env.PATH = `${bin}:${process.env.PATH}`;

  const file = join(work, ".fleet", "ledger.md");
  const ledger = (...args) => spawnSync(process.execPath, [LEDGER, "--file", file, ...args], { cwd: work, env, encoding: "utf8" });
  const cli = rendering(join(work, ".fleet"), ledger);
  const settle = (member) => ledger("settle", member, "--from-report", "--reports", reports);
  const settled = (member) => {
    const r = settle(member);
    assert.equal(r.status, 0, `settle ${member}: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const refused = (member, code, why) => {
    const r = settle(member);
    assert.equal(r.status, code, `settle ${member}: got exit ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "", "a refusal emits no receipt");
    return r;
  };
  const record = (member, { cwd = work, testCmd = TEST_CMD, more = [], extraEnv = {} } = {}) =>
    spawnSync(process.execPath, [RECIPE_CHECK, "--member", member, "--testCmd", testCmd, "--reports", reports, ...more], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const recordFile = (member) => join(reports, `${member}.check.json`);
  const readRecord = (member) => JSON.parse(readFileSync(recordFile(member), "utf8"));
  const ran = (dir = work) => (existsSync(join(dir, "ran.log")) ? readFileSync(join(dir, "ran.log"), "utf8").trim().split("\n") : []);
  const implReport = (head, over = {}) => writeFileSync(join(reports, "impl-5.json"), JSON.stringify({
    member: "impl-5", outcome: "pr", pr: 6, head, branch: "feat",
    sizing: { verdict: "light", signal: "one file", ranBeforePr: true },
    bailCause: null, bailDetail: null, confirmation: [], ...over,
  }));
  const fixReport = (head, over = {}) => writeFileSync(join(reports, "fix-pr-6.json"), JSON.stringify({
    member: "fix-pr-6", outcome: "applied", head, branch: "feat",
    applied: [], deferred: [], filed: [], unrecorded: [], dispositionsRecord: join(root, "dispositions-fix-pr-6.json"),
    testRun: { cmd: "./agent-test", exit: 0, tests: 3, cancelled: 0 }, confirmation: [], ...over,
  }));
  writeFileSync(join(ghDir, "6.json"), JSON.stringify({ state: "OPEN", closingIssuesReferences: [ref(5)], url: prUrl(6) }));

  // The member's own steps: a branch with a staged change, ready to record.
  git(work, "checkout", "-q", "-b", "feat");
  const stage = (body = "v1\n", name = "src.txt") => {
    writeFileSync(join(work, name), body);
    git(work, "add", name);
  };
  const commitAndPush = (message = "the work") => {
    git(work, "commit", "-q", "-m", message);
    git(work, "push", "-q", "--force", "origin", "feat");
    return git(work, "rev-parse", "HEAD");
  };
  return {
    root, env, work, origin, main, reports, git, writeRecipe, cli, ledger, settle, settled, refused, record, recordFile,
    readRecord, ran, implReport, fixReport, stage, commitAndPush, bin, file,
    clone: (name) => {
      const dir = join(root, name);
      git(root, "clone", "-q", origin, dir);
      return dir;
    },
    dispatch: (n, member) => {
      const r = cli("dispatch", n, member);
      assert.equal(r.status, 0, `dispatch ${member}: ${r.stderr}`);
    },
  };
}

// -- parseCounts --------------------------------------------------------------

test("parseCounts reads node:test's summary lines, TAP's and jest's, and the last one wins", () => {
  assert.deepEqual(parseCounts("ℹ tests 5\nℹ pass 4\nℹ fail 1\n"), { pass: 4, fail: 1 });
  assert.deepEqual(parseCounts("# tests 5\n# pass 5\n# fail 0\n"), { pass: 5, fail: 0 });
  assert.deepEqual(parseCounts("# pass 1\n# pass 7\n"), { pass: 7, fail: null });
  assert.deepEqual(parseCounts("Tests: 2 failed, 10 passed, 12 total"), { pass: 10, fail: 2 });
  assert.deepEqual(parseCounts("  12 passing (3s)\n  1 failing\n"), { pass: 12, fail: 1 });
  assert.deepEqual(parseCounts("\x1b[32m3 passed\x1b[0m"), { pass: 3, fail: null });
});

test("parseCounts answers null for a runner that printed no count", () => {
  assert.deepEqual(parseCounts("ok\n"), { pass: null, fail: null });
  assert.deepEqual(parseCounts("passed the gate"), { pass: null, fail: null });
});

// -- the record -----------------------------------------------------------------

test("a green run records the staged tree, both commands and the counts, and exits 0", () => {
  const f = fixture();
  f.stage();
  const r = f.record("impl-5");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.readRecord("impl-5"), {
    member: "impl-5",
    tree: f.git(f.work, "write-tree"),
    check: { command: "sh ./check.sh", ran: true, exitCode: 0, pass: null, fail: null },
    test: { command: TEST_CMD, ran: true, exitCode: 0, pass: 3, fail: 0 },
  });
  assert.deepEqual(f.ran(), ["check", "test"]);
});

test("an unstaged edit or an untracked file is a refusal that runs nothing and writes nothing", () => {
  const f = fixture();
  f.stage();
  const checkSh = join(f.work, "check.sh");
  const original = readFileSync(checkSh, "utf8");
  writeFileSync(checkSh, `${original}# edited, never staged\n`);
  const unstaged = f.record("impl-5");
  assert.equal(unstaged.status, 2, unstaged.stderr);
  assert.match(unstaged.stderr, /the working tree is not the staged tree — unstaged or untracked: check\.sh\. /);
  writeFileSync(checkSh, original);
  writeFileSync(join(f.work, "untracked.txt"), "x\n");
  const untracked = f.record("impl-5");
  assert.equal(untracked.status, 2, untracked.stderr);
  assert.match(untracked.stderr, /the working tree is not the staged tree — unstaged or untracked: untracked\.txt\. /);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.deepEqual(f.ran(), []);
  rmSync(join(f.work, "untracked.txt"));
  assert.equal(f.record("impl-5").status, 0, "an ignored file is no stray");
});

test("a reports directory that cannot be created is a refusal before anything runs", () => {
  const f = fixture();
  f.stage();
  const blocker = join(f.root, "afile");
  writeFileSync(blocker, "");
  const r = spawnSync(process.execPath, [RECIPE_CHECK, "--member", "impl-5", "--testCmd", TEST_CMD, "--reports", join(blocker, "sub")], { cwd: f.work, env: f.env, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /recipe-check: could not create .*afile\/sub: ENOTDIR; nothing run, nothing written/);
  assert.deepEqual(f.ran(), []);
});

test("an ambient GIT_DIR naming another repository does not change the tree the record names", () => {
  const f = fixture();
  f.stage();
  const staged = f.git(f.work, "write-tree");
  const decoy = join(f.root, "decoy");
  mkdirSync(decoy);
  f.git(decoy, "init", "-q");
  writeFileSync(join(decoy, "other.txt"), "other\n");
  f.git(decoy, "add", "other.txt");
  assert.notEqual(f.git(decoy, "write-tree"), staged, "fixture: the decoy's index must differ");
  const r = f.record("impl-5", { extraEnv: { GIT_DIR: join(decoy, ".git") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.readRecord("impl-5").tree, staged);
});

test("a Check step of `true` is recorded green without being run, and the Test entrypoint still runs", () => {
  const f = fixture({ check: true });
  f.stage();
  const r = f.record("impl-5");
  assert.equal(r.status, 0, r.stderr);
  const rec = f.readRecord("impl-5");
  assert.deepEqual(rec.check, { command: "true", ran: false, exitCode: 0, pass: null, fail: null });
  assert.deepEqual(rec.test, { command: TEST_CMD, ran: true, exitCode: 0, pass: 3, fail: 0 });
  assert.deepEqual(f.ran(), ["test"]);
});

test("a Check step of `true` with a failing Test entrypoint records red and exits 1", () => {
  const f = fixture({ check: true });
  f.stage();
  writeFileSync(join(f.work, "test.fail"), "");
  const r = f.record("impl-5");
  assert.equal(r.status, 1);
  assert.deepEqual(f.readRecord("impl-5").test, { command: TEST_CMD, ran: true, exitCode: 1, pass: 2, fail: 1 });
});

test("a failing Check step exits 1, records it red, and does not run the Test entrypoint", () => {
  const f = fixture();
  f.stage();
  writeFileSync(join(f.work, "check.fail"), "");
  const r = f.record("impl-5");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recipe-check: the Check step exited 1/);
  const rec = f.readRecord("impl-5");
  assert.equal(rec.check.exitCode, 1);
  assert.deepEqual(rec.test, { command: TEST_CMD, ran: false, exitCode: null, pass: null, fail: null });
  assert.deepEqual(f.ran(), []);
});

test("a failing Test entrypoint exits 1 and records it red with its counts", () => {
  const f = fixture();
  f.stage();
  writeFileSync(join(f.work, "test.fail"), "");
  const r = f.record("impl-5");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recipe-check: the Test entrypoint exited 1/);
  assert.deepEqual(f.readRecord("impl-5").test, { command: TEST_CMD, ran: true, exitCode: 1, pass: 2, fail: 1 });
});

test("a Test entrypoint killed by a signal records 128 plus the signal number", () => {
  const f = fixture();
  f.stage();
  const r = f.record("impl-5", { testCmd: "kill -TERM $$" });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(f.readRecord("impl-5").test.exitCode, 143);
});

// recipe-check, started asynchronously, sent `signals` in turn once `marker`
// exists — the first `delayMs` after it, each later one 200 ms after the one
// before: its exit status, the signal it died of (null when it exited), its
// stderr, and that stderr's last line. A command runs in a process group of
// its own, which is its `sh -c`'s pid, so the command writes `$$` to
// `groupFile` (the marker itself, by default). A run still going `guardMs`
// after the marker, or with no marker by then, has recipe-check's own group
// and that command group SIGKILLed, and fails here instead of hanging or
// leaving the command behind.
async function killedRun(f, { testCmd, marker, signals, delayMs = 0, groupFile = marker, guardMs = 30_000, env = f.env }) {
  const child = spawn(process.execPath, [RECIPE_CHECK, "--member", "impl-5", "--testCmd", testCmd, "--reports", f.reports], { cwd: f.work, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.resume();
  const exited = new Promise((resolve) => child.on("close", (status, sig) => resolve({ status, sig })));
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const killGroup = (pgid) => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  const killGroups = () => {
    killGroup(child.pid);
    // pgid 1 and below would name every process the user owns, not a group.
    const pgid = existsSync(groupFile) ? Number.parseInt(readFileSync(groupFile, "utf8"), 10) : NaN;
    if (Number.isInteger(pgid) && pgid > 1) killGroup(pgid);
  };
  const deadline = Date.now() + guardMs;
  while (!existsSync(marker) && Date.now() < deadline) await pause(20);
  if (!existsSync(marker)) {
    killGroups();
    await exited;
    assert.fail(`the command never started\n${stderr}`);
  }
  const late = setTimeout(killGroups, guardMs);
  await pause(delayMs);
  for (const [i, signal] of signals.entries()) {
    if (i > 0) await pause(200);
    child.kill(signal);
  }
  const result = await exited;
  clearTimeout(late);
  assert.notEqual(result.sig, "SIGKILL", `recipe-check was still running ${guardMs / 1000} s after the signal\n${stderr}`);
  return { ...result, stderr, last: stderr.trimEnd().split("\n").pop() };
}

// Whether `pidFile`'s process is gone, given a moment for the kernel to reap
// it. A process still there is killed, so a failing assertion leaks nothing.
async function goneAfter(pidFile) {
  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  assert.ok(Number.isInteger(pid) && pid > 1, `${pidFile} holds no pid`);
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return true;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  process.kill(pid, "SIGKILL");
  return false;
}

// A command that is not exec'd: its shell stays, waiting on a `sleep` it
// started in the background, so the shell's own death does not stop the sleep.
// It records the sleep's pid, then its own — the group id — in `marker`, and
// would write `after` only if it ran to its end. Paths are quoted with `q`.
const nonExec = ({ marker, sleepPid, after }, q = "'") =>
  `sleep 600 & echo $! > ${q}${sleepPid}${q}; echo $$ > ${q}${marker}${q}; wait $!; : > ${q}${after}${q}`;

test("a SIGTERM to recipe-check during the Test entrypoint records nothing, exits 143 and says it was killed", async () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  const before = readFileSync(f.recordFile("impl-5"), "utf8");
  const marker = join(f.root, "test-started");
  const r = await killedRun(f, { testCmd: `echo $$ > '${marker}'; exec sleep 600`, marker, signals: ["SIGTERM"] });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(r.sig, null, "the exit status is set, the signal never re-raised");
  assert.equal(readFileSync(f.recordFile("impl-5"), "utf8"), before, "an older record is left byte-identical");
  assert.match(r.last, /^recipe-check: SIGTERM received during the Test entrypoint, which ran \d+ s;/);
  assert.match(r.last, /no test result/);
  assert.match(r.last, /nothing was recorded/);
  assert.match(r.last, /timeout: 0/);
});

test("the kill message reports how long the command ran", async () => {
  const f = fixture();
  f.stage();
  const marker = join(f.root, "test-started");
  const r = await killedRun(f, { testCmd: `echo $$ > '${marker}'; exec sleep 600`, marker, signals: ["SIGTERM"], delayMs: 1500 });
  assert.equal(r.status, 143, r.stderr);
  const ran = Number(/which ran (\d+) s;/.exec(r.last)?.[1]);
  assert.ok(ran >= 1, `the kill message reports ${ran} s for a command signalled 1.5 s after it started: ${r.last}`);
});

test("a SIGINT to recipe-check writes no record and exits 130, a SIGHUP 129", async () => {
  for (const [signal, status] of [["SIGINT", 130], ["SIGHUP", 129]]) {
    const f = fixture();
    f.stage();
    const marker = join(f.root, "test-started");
    const r = await killedRun(f, { testCmd: `echo $$ > '${marker}'; exec sleep 600`, marker, signals: [signal] });
    assert.equal(r.status, status, r.stderr);
    assert.equal(existsSync(f.recordFile("impl-5")), false);
    assert.match(r.last, new RegExp(`^recipe-check: ${signal} `));
  }
});

test("a SIGTERM to recipe-check during the Check step records nothing and never starts the Test entrypoint", async () => {
  const f = fixture({ check: "echo $$ > ../check-started; exec sleep 600" });
  f.stage();
  const marker = join(f.root, "check-started");
  const testMarker = join(f.root, "test-started");
  const r = await killedRun(f, { testCmd: `: > '${testMarker}'`, marker, signals: ["SIGTERM"] });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.equal(existsSync(testMarker), false, "the Test entrypoint never started");
  assert.match(r.last, /^recipe-check: SIGTERM received during the Check step, which ran \d+ s;/);
});

test("a SIGTERM during a Check step that is not exec'd stops its whole group, never starts the Test entrypoint and records nothing", async () => {
  const marker = join(tempDir("recipe-check-paths-"), "check-started");
  const paths = { marker, sleepPid: `${marker}.sleep`, after: `${marker}.after` };
  const f = fixture({ check: nonExec(paths) });
  f.stage();
  const testMarker = join(f.root, "test-started");
  const r = await killedRun(f, { testCmd: `: > '${testMarker}'`, marker, signals: ["SIGTERM"], guardMs: 15_000 });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.equal(existsSync(testMarker), false, "the Test entrypoint never started");
  assert.equal(existsSync(paths.after), false, "the Check step ran on past the signal");
  assert.equal(await goneAfter(paths.sleepPid), true, "the sleep the Check step started outlived the signal");
  assert.match(r.last, /^recipe-check: SIGTERM received during the Check step, which ran \d+ s;/);
});

test("a SIGTERM during a Test entrypoint that is not exec'd stops its whole group and records nothing", async () => {
  const f = fixture();
  f.stage();
  const marker = join(f.root, "test-started");
  const paths = { marker, sleepPid: join(f.root, "sleep-pid"), after: join(f.root, "after") };
  const r = await killedRun(f, { testCmd: nonExec(paths), marker, signals: ["SIGTERM"], guardMs: 15_000 });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(r.sig, null);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.equal(existsSync(paths.after), false, "the Test entrypoint ran on past the signal");
  assert.equal(await goneAfter(paths.sleepPid), true, "the sleep the Test entrypoint started outlived the signal");
  assert.match(r.last, /^recipe-check: SIGTERM received during the Test entrypoint, which ran \d+ s;/);
});

test("a SIGTERM stops the suite-slot chain: no entrypoint or sleep survives, the slot is released and the entrypoint's last command never ran", async () => {
  const f = fixture();
  f.stage();
  const host = slotHome();
  const env = host.env({ PATH: f.env.PATH, ...GIT_ENV });
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GH_REPO"]) delete env[k];
  const marker = join(f.root, "entry-started");
  const paths = { marker, sleepPid: join(f.root, "sleep-pid"), after: join(f.root, "after") };
  const group = join(f.root, "group");
  const testCmd = `echo $$ > '${group}'; '${process.execPath}' '${SUITE_SLOT}' '${nonExec(paths, '"')}'`;
  const r = await killedRun(f, { testCmd, marker, groupFile: group, signals: ["SIGTERM"], guardMs: 15_000, env });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.equal(existsSync(paths.after), false, "the entrypoint ran on past the signal");
  assert.equal(await goneAfter(paths.sleepPid), true, "the sleep the entrypoint started outlived the signal");
  assert.equal(await goneAfter(marker), true, "the entrypoint's shell outlived the signal");
  assert.deepEqual(readdirSync(host.slots), [], "the slot was not released");
});

test("the safety net of the signal helper stops the command's own group, so a run that outlives its guard leaves nothing behind", async () => {
  const f = fixture();
  f.stage();
  const marker = join(f.root, "test-started");
  const paths = { marker, sleepPid: join(f.root, "sleep-pid"), after: join(f.root, "after") };
  await assert.rejects(killedRun(f, { testCmd: nonExec(paths), marker, signals: [], guardMs: 1000 }), /still running/);
  assert.equal(await goneAfter(paths.sleepPid), true, "the helper left the sleep running");
});

test("the safety net of the signal helper stops the command's group when the marker never appears", async () => {
  const f = fixture();
  f.stage();
  const group = join(f.root, "group");
  const sleepPid = join(f.root, "sleep-pid");
  const testCmd = `echo $$ > '${group}'; sleep 600 & echo $! > '${sleepPid}'; wait $!`;
  await assert.rejects(killedRun(f, { testCmd, marker: join(f.root, "never"), groupFile: group, signals: [], guardMs: 1000 }), /never started/);
  assert.equal(await goneAfter(sleepPid), true, "the helper left the sleep running");
});

test("a command that ignores the forwarded signal and exits 0 still leaves the run killed, the Test entrypoint unstarted", async () => {
  const f = fixture({ check: "trap 'exit 0' TERM; echo $$ > ../check-started; while :; do sleep 0.1; done" });
  f.stage();
  const marker = join(f.root, "check-started");
  const testMarker = join(f.root, "test-started");
  const r = await killedRun(f, { testCmd: `: > '${testMarker}'`, marker, signals: ["SIGTERM"] });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.equal(existsSync(testMarker), false);
});

test("the first signal names the kill: a SIGINT after a SIGTERM the command ignored still exits 143", async () => {
  const f = fixture({ check: "trap '' TERM; trap 'exit 0' INT; echo $$ > ../check-started; while :; do sleep 0.1; done" });
  f.stage();
  const marker = join(f.root, "check-started");
  const r = await killedRun(f, { testCmd: "true", marker, signals: ["SIGTERM", "SIGINT"] });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.match(r.last, /^recipe-check: SIGTERM received during the Check step/);
});

test("once the record is written a signal takes its default action, so a stalled stdout reader cannot keep recipe-check alive", async () => {
  const f = fixture();
  f.stage();
  const child = spawn(process.execPath, [RECIPE_CHECK, "--member", "impl-5", "--testCmd", "head -c 8000000 /dev/zero; sh ./t.sh", "--reports", f.reports], { cwd: f.work, env: f.env, stdio: ["ignore", "pipe", "ignore"] });
  // stdout is never read, so the 8 MB the Test entrypoint printed stays queued.
  const exited = new Promise((resolve) => child.on("exit", (status, sig) => resolve({ status, sig })));
  const deadline = Date.now() + 30_000;
  while (!existsSync(f.recordFile("impl-5")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(f.recordFile("impl-5")), "the record was never written");
  child.kill("SIGTERM");
  const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const result = await exited;
  clearTimeout(late);
  child.stdout.destroy();
  assert.deepEqual(result, { status: null, sig: "SIGTERM" }, "recipe-check outlived a SIGTERM sent after its record was written");
});

test("a reader that closes the output early stops only the passthrough: the record is still written", () => {
  const f = fixture();
  f.stage();
  const testCmd = "yes y | head -c 200000; sh ./t.sh";
  const piped = `'${process.execPath}' '${RECIPE_CHECK}' --member impl-5 --testCmd '${testCmd}' --reports '${f.reports}' | head -c 1 >/dev/null`;
  const r = spawnSync("sh", ["-c", piped], { cwd: f.work, env: f.env, encoding: "utf8" });
  assert.doesNotMatch(r.stderr, /EPIPE/);
  assert.deepEqual(f.readRecord("impl-5").test, { command: testCmd, ran: true, exitCode: 0, pass: 3, fail: 0 });
});

test("a red run replaces an older green record", () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  writeFileSync(join(f.work, "test.fail"), "");
  assert.equal(f.record("impl-5").status, 1);
  assert.equal(f.readRecord("impl-5").test.exitCode, 1);
});

test("a Test entrypoint that exits 75 exits 75 and writes nothing, leaving an older record standing", () => {
  const f = fixture();
  f.stage();
  const none = f.record("impl-5", { testCmd: "exit 75" });
  assert.equal(none.status, 75);
  assert.match(none.stderr, /no suite slot was free and nothing was launched/);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.equal(f.record("impl-5").status, 0);
  const before = readFileSync(f.recordFile("impl-5"), "utf8");
  assert.equal(f.record("impl-5", { testCmd: "exit 75" }).status, 75);
  assert.equal(readFileSync(f.recordFile("impl-5"), "utf8"), before);
});

test("a Test entrypoint printing more than the kept tail still has its closing summary's counts recorded", () => {
  const f = fixture();
  f.stage();
  const testCmd = "head -c 400000 /dev/zero | tr '\\000' x; printf '\\n# tests 9\\n# pass 8\\n# fail 1\\n'";
  const r = f.record("impl-5", { testCmd });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.readRecord("impl-5").test, { command: testCmd, ran: true, exitCode: 0, pass: 8, fail: 1 });
});

test("the command's own output passes through", () => {
  const f = fixture();
  f.stage();
  const r = f.record("impl-5");
  assert.match(r.stdout, /# pass 3/);
});

test("a repository with no usable Recipe is a refusal that runs nothing and writes nothing", () => {
  const f = fixture();
  rmSync(join(f.work, ".fleet", "recipe.json"));
  f.stage();
  const r = f.record("impl-5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no usable Recipe/);
  assert.equal(existsSync(f.recordFile("impl-5")), false);
  assert.deepEqual(f.ran(), []);
});

test("a member that is neither an implementer nor a fix-applier, and a missing --testCmd, are refusals", () => {
  const f = fixture();
  f.stage();
  const finisher = f.record("finisher-pr-6");
  assert.equal(finisher.status, 2);
  assert.match(finisher.stderr, /not an impl-<N>\[-x\] or fix-pr-<M>\[-x\] name/);
  const bare = spawnSync(process.execPath, [RECIPE_CHECK, "--member", "impl-5", "--reports", f.reports], { cwd: f.work, env: f.env, encoding: "utf8" });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /usage: recipe-check\.mjs/);
});

// -- settle: the implementer report ------------------------------------------------

function settledImpl(f) {
  f.dispatch("5", "impl-5");
  f.implReport(f.head);
}

test("settle: a head whose tree holds a green record passes, and runs neither command", () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  const recorded = f.ran().length;
  f.head = f.commitAndPush();
  settledImpl(f);
  const receipt = f.settled("impl-5");
  assert.equal(receipt.outcome, "PR#6");
  const tree = f.git(f.work, "rev-parse", `${f.head}^{tree}`);
  assert.deepEqual(receipt.checks.slice(1, -2), [
    { name: `Check-step record ${f.recordFile("impl-5")} exists and parses`, ok: true },
    { name: "the recorded Check step exited 0 (recorded: exit 0)", ok: true },
    { name: "the recorded Test entrypoint exited 0 (recorded: exit 0)", ok: true },
    { name: `the recorded tree ${tree} is ${f.head}'s tree ${tree}`, ok: true },
  ]);
  assert.equal(f.ran().length, recorded, "settle never runs the Check step or the Test entrypoint");
});

test("settle: a message-only amend after recording keeps the record valid", () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  f.commitAndPush("first message");
  f.git(f.work, "commit", "-q", "--amend", "-m", "a better message");
  f.head = f.git(f.work, "rev-parse", "HEAD");
  f.git(f.work, "push", "-q", "--force", "origin", "feat");
  settledImpl(f);
  assert.equal(f.settled("impl-5").outcome, "PR#6");
});

test("settle: a content change after recording is refused, naming the tree mismatch", () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  f.commitAndPush();
  f.stage("v2\n");
  f.head = f.commitAndPush("more work");
  settledImpl(f);
  f.refused("impl-5", 3, /failed: the recorded tree [0-9a-f]{40} is [0-9a-f]{40}'s tree [0-9a-f]{40}/);
});

test("settle: a rebase onto a moved base after recording is refused, naming the tree mismatch", () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  f.commitAndPush();
  f.git(f.work, "checkout", "-q", "main");
  writeFileSync(join(f.work, "other.txt"), "moved\n");
  f.git(f.work, "add", "other.txt");
  f.git(f.work, "commit", "-q", "-m", "main moves");
  f.git(f.work, "push", "-q", "origin", "main");
  f.git(f.work, "checkout", "-q", "feat");
  f.git(f.work, "rebase", "-q", "main");
  f.head = f.git(f.work, "rev-parse", "HEAD");
  f.git(f.work, "push", "-q", "--force", "origin", "feat");
  settledImpl(f);
  f.refused("impl-5", 3, /failed: the recorded tree /);
});

test("settle: no record is refused, naming the missing record", () => {
  const f = fixture();
  f.stage();
  f.head = f.commitAndPush();
  settledImpl(f);
  f.refused("impl-5", 3, /failed: a Check-step record exists at .*impl-5\.check\.json/);
});

test("settle: a record that does not parse is refused, naming why", () => {
  const f = fixture();
  f.stage();
  f.head = f.commitAndPush();
  settledImpl(f);
  writeFileSync(f.recordFile("impl-5"), "not json");
  f.refused("impl-5", 3, /failed: Check-step record .*impl-5\.check\.json parses: \$: not JSON/);
  writeFileSync(f.recordFile("impl-5"), JSON.stringify({ ...{ member: "impl-9", tree: "0".repeat(40) } }));
  f.refused("impl-5", 3, /parses: \$\.member: "impl-9" is not impl-5/);
});

test("settle: a red Check step is refused, naming the red record", () => {
  const f = fixture();
  f.stage();
  writeFileSync(join(f.work, "check.fail"), "");
  assert.equal(f.record("impl-5").status, 1);
  f.head = f.commitAndPush();
  settledImpl(f);
  const r = f.refused("impl-5", 3, /failed: the recorded Check step exited 0 \(recorded: exit 1\)/);
  assert.match(r.stderr, /failed: the recorded Test entrypoint exited 0 \(recorded: not run\)/);
  assert.doesNotMatch(r.stderr, /failed: the recorded tree/);
});

test("settle: a red Test entrypoint is refused, naming the red record", () => {
  const f = fixture();
  f.stage();
  writeFileSync(join(f.work, "test.fail"), "");
  assert.equal(f.record("impl-5").status, 1);
  f.head = f.commitAndPush();
  settledImpl(f);
  f.refused("impl-5", 3, /failed: the recorded Test entrypoint exited 0 \(recorded: exit 1\)/);
});

test("settle: no 75 run leaves a record, so the report is refused for the missing one", () => {
  const f = fixture();
  f.stage();
  assert.equal(f.record("impl-5", { testCmd: "exit 75" }).status, 75);
  f.head = f.commitAndPush();
  settledImpl(f);
  f.refused("impl-5", 3, /failed: a Check-step record exists at/);
});

test("settle: a Check step of `true` with a passing Test entrypoint passes", () => {
  const f = fixture({ check: true });
  f.stage();
  assert.equal(f.record("impl-5").status, 0);
  f.head = f.commitAndPush();
  settledImpl(f);
  assert.equal(f.settled("impl-5").outcome, "PR#6");
});

test("settle: a repository with no usable Recipe applies no gate", () => {
  const f = fixture();
  rmSync(join(f.work, ".fleet", "recipe.json"));
  f.stage();
  f.head = f.commitAndPush();
  settledImpl(f);
  const receipt = f.settled("impl-5");
  assert.equal(receipt.outcome, "PR#6");
  assert.deepEqual(receipt.checks.map((c) => c.name), [`verify-sha.sh feat ${f.head} exits 0`, "PR #6 reads OPEN", "PR #6 closes #5"]);
});

test("settle: a bailed report is not gated", () => {
  const f = fixture();
  f.dispatch("5", "impl-5");
  f.implReport(null, { outcome: "bailed", pr: null, bailCause: "undecided", bailDetail: "x" });
  const r = f.settle("impl-5");
  assert.equal(r.status, 0, r.stderr);
});

// -- settle: the fix-applier report ------------------------------------------------

// A fix-applier's push from a clone of its own: the head's object is on
// origin and not in the clone the ledger lives in.
function pushedElsewhere(f, { green = true } = {}) {
  const other = f.clone("other");
  f.git(other, "checkout", "-q", "-b", "feat");
  mkdirSync(join(other, ".fleet"), { recursive: true });
  writeFileSync(join(other, ".fleet", "recipe.json"), readFileSync(join(f.work, ".fleet", "recipe.json"), "utf8"));
  writeFileSync(join(other, "src.txt"), "fixed\n");
  f.git(other, "add", "src.txt");
  if (!green) writeFileSync(join(other, "test.fail"), "");
  const r = f.record("fix-pr-6", { cwd: other });
  assert.equal(r.status, green ? 0 : 1, r.stderr);
  f.git(other, "commit", "-q", "-m", "fix");
  f.git(other, "push", "-q", "origin", "feat");
  const head = f.git(other, "rev-parse", "HEAD");
  assert.throws(() => f.git(f.work, "cat-file", "-e", `${head}^{commit}`), "the ledger's checkout lacks the head's object");
  f.dispatch("6", "fix-pr-6");
  f.fixReport(head);
  return head;
}

test("settle: a fix-applier head the checkout lacks is fetched, and its green record passes", () => {
  const f = fixture();
  const head = pushedElsewhere(f);
  const receipt = f.settled("fix-pr-6");
  assert.equal(receipt.outcome, `applied:${head}`);
  const tree = f.git(f.work, "rev-parse", `${head}^{tree}`);
  assert.deepEqual(receipt.checks.at(-1), { name: `the recorded tree ${tree} is ${head}'s tree ${tree}`, ok: true });
  assert.equal(receipt.checks.length, 5);
});

test("settle: a fix-applier's red Test entrypoint is refused the same way", () => {
  const f = fixture();
  pushedElsewhere(f, { green: false });
  f.refused("fix-pr-6", 3, /failed: the recorded Test entrypoint exited 0 \(recorded: exit 1\)/);
});

test("settle: a fix-applier head without a record is refused", () => {
  const f = fixture();
  pushedElsewhere(f);
  rmSync(f.recordFile("fix-pr-6"));
  f.refused("fix-pr-6", 3, /failed: a Check-step record exists at .*fix-pr-6\.check\.json/);
});

test("settle: a fix-applier head whose tree differs from the record's is refused, naming the mismatch", () => {
  const f = fixture();
  pushedElsewhere(f);
  const rec = f.readRecord("fix-pr-6");
  writeFileSync(f.recordFile("fix-pr-6"), JSON.stringify({ ...rec, tree: "1".repeat(40) }));
  f.refused("fix-pr-6", 3, /failed: the recorded tree 1{40} is [0-9a-f]{40}'s tree [0-9a-f]{40}/);
});

test("settle: a fetch that fails is could-not-look, never a tree mismatch", () => {
  const f = fixture();
  pushedElsewhere(f);
  writeFileSync(join(f.root, "fetch-fails"), "");
  const r = f.refused("fix-pr-6", 2, /could not look — verify-sha\.sh feat [0-9a-f]{40} exited 2/);
  assert.doesNotMatch(r.stderr, /recorded tree/);
});

test("settle: a head whose tree git cannot read is could-not-look, never a tree mismatch", () => {
  const f = fixture();
  pushedElsewhere(f);
  writeFileSync(join(f.root, "tree-fails"), "");
  const r = f.refused("fix-pr-6", 2, /could not look — git rev-parse --verify [0-9a-f]{40}\^\{tree\} exited 128/);
  assert.doesNotMatch(r.stderr, /recorded tree/);
});

test("settle: a fix-applier no-op or failed report is not gated", () => {
  const f = fixture();
  f.dispatch("6", "fix-pr-6");
  f.fixReport(f.main, { outcome: "failed" });
  const r = f.settle("fix-pr-6");
  assert.equal(r.status, 0, r.stderr);
});

test("settle: a fix-applier report in a repository with no usable Recipe makes no fetch and applies no gate", () => {
  const f = fixture();
  pushedElsewhere(f);
  rmSync(join(f.work, ".fleet", "recipe.json"));
  writeFileSync(join(f.root, "fetch-fails"), "");
  const receipt = f.settled("fix-pr-6");
  assert.equal(receipt.checks.length, 1);
});
