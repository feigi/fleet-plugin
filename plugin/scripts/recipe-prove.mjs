#!/usr/bin/env node
// Prove a repository's Recipe — its Install step and Test entrypoint — and
// write the Recipe cache only if the proof holds. This is the Recipe
// derivation step's proof, and the ONE writer of the cache derive-testcmd.sh
// reads: the deriving agent chooses both commands by reading the repository,
// and this script is what turns that choice into a cache, or refuses to.
//
//   recipe-prove.mjs <repo> --install <cmd> --test <cmd>
//                    [--count-line <literal> --test-count <n>]
//                    [--mutate <cmd> --mutation <description>]
//
// Every check runs in a throwaway worktree of `origin/main`, detached and
// removed afterwards, so neither the caller's checkout nor its uncommitted
// state takes part — `derivedAt` is the commit the proof ran against:
//
//   1. The Install step runs (`sh -c`, from the worktree root) and must exit
//      0, then `git status --porcelain -uall` must print nothing: an install
//      that rewrites a tracked file, or creates one the tree neither tracks
//      nor ignores, corrupts every worktree it later runs in. That is the
//      same check, in the same form, a claim re-asserts on every Install.
//   2. The Test entrypoint runs and must RUN — 126/127 is the shell's "cannot
//      execute"/"not found". A red suite is not a failed proof by itself.
//   3. Real tests must be shown to have executed, by at least one of:
//      - the count proof: `--count-line` is a literal the run's own output
//        must contain (the runner's summary line, read off a previous run),
//        carrying `--test-count`, a positive integer. `tests 0` is a failed
//        proof however honestly the runner reports it.
//      - the mutation proof: the unmutated run must be green; `--mutate` is a
//        shell command that must change a tracked file (the deliberate
//        failing mutation of one test, or of the code one test covers); the
//        run must then go red. A mutation that leaves the run green is a
//        suite that runs nothing that matters.
//   With neither, nothing is proven: the refusal still names where the test
//   run's output is, so the caller can read the count line off it.
//
// On proof, the cache is written atomically to <workspace>/.fleet/recipe.json
// — <workspace> being the directory holding the repository's common git dir,
// the place derive-testcmd.sh reads it from — and then read back through
// derive-testcmd.sh for both fields. A cache the reader refuses is rolled
// back to whatever stood before, so the reader stays the one authority on
// what a usable cache is. A failed proof never touches an existing cache.
//
// Exit 0: proven, cache written (its path and contents on stdout).
// Exit 1: NOT PROVEN — no cache written; the reason on stderr.
// Exit 2: the proof could not be attempted (usage, not a repository,
//         origin/main missing, the worktree could not be made).

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";
import { isDigits } from "./arg.mjs";

const NAME = "recipe-prove";
const USAGE =
  "usage: recipe-prove.mjs <repo> --install <cmd> --test <cmd> [--count-line <literal> --test-count <n>] [--mutate <cmd> --mutation <description>]";
const READER = join(dirname(fileURLToPath(import.meta.url)), "derive-testcmd.sh");

// Scrubbed once, for every child: an ambient GIT_DIR or GIT_WORK_TREE — set
// by a git hook, `rebase --exec` or `bisect run` — would retarget the git
// calls below at another repository, and the Install step and Test entrypoint
// at that repository's tree, while the cache still landed here.
const ENV = gitEnv();

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const cannot = (message) => new Refusal(2, message);
const notProven = (message) => new Refusal(1, message);

function parseArgs(argv) {
  const [repo, ...rest] = argv;
  if (!repo || repo.startsWith("--")) throw cannot(USAGE);
  const flags = new Set(["--install", "--test", "--count-line", "--test-count", "--mutate", "--mutation"]);
  const a = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    // A value that is itself one of these flags is a missing value — `--install
    // --test x` would otherwise run `--test` as the Install step.
    if (!flags.has(flag) || value === undefined || flags.has(value)) throw cannot(USAGE);
    if (flag in a) throw cannot(`${flag} given twice`);
    a[flag] = value;
  }
  for (const f of ["--install", "--test"]) {
    if (!a[f] || !a[f].trim()) throw cannot(`${f} needs a non-empty command — ${USAGE}`);
  }
  if (("--count-line" in a) !== ("--test-count" in a)) throw cannot("--count-line and --test-count go together");
  if ("--test-count" in a && !isDigits(a["--test-count"])) {
    throw cannot(`--test-count must be a whole number, got '${a["--test-count"]}'`);
  }
  if (("--mutate" in a) !== ("--mutation" in a)) throw cannot("--mutate and --mutation go together");
  return {
    repo,
    install: a["--install"],
    test: a["--test"],
    countLine: a["--count-line"],
    testCount: a["--test-count"],
    mutate: a["--mutate"],
    mutation: a["--mutation"],
  };
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: (r.stderr ?? "").trim() };
}

// Run a Recipe command through `sh -c` from the worktree root, its output to
// a log file rather than a pipe: a real suite's output has no useful size
// bound, and the log is what the caller reads a count line off.
function sh(cmd, cwd, log) {
  const fd = openSync(log, "a");
  try {
    const r = spawnSync("sh", ["-c", cmd], { cwd, env: ENV, stdio: ["ignore", fd, fd] });
    if (r.error) throw cannot(`could not start sh: ${r.error.message}`);
    return r.status ?? 128;
  } finally {
    closeSync(fd);
  }
}

const didNotRun = (rc) => rc === 126 || rc === 127;

// `-uall` for the reason the header gives: an untracked, unignored file an
// install creates dirties the tree as surely as a rewrite, and the untracked
// mode is config — under status.showUntrackedFiles=no it is invisible unless
// pinned.
function treeChanges(wt) {
  const s = git(["status", "--porcelain", "-uall"], wt);
  if (!s.ok) throw notProven(`could not read the tree state in the throwaway worktree: ${s.err}`);
  return s.out;
}

function prove(o, wt, logs) {
  const installLog = join(logs, "install.log");
  const irc = sh(o.install, wt, installLog);
  if (didNotRun(irc)) {
    throw notProven(`the Install step '${o.install}' did not run (exit ${irc}: not executable or not found); install output: ${installLog}`);
  }
  if (irc !== 0) throw notProven(`the Install step '${o.install}' failed (exit ${irc}); install output: ${installLog}`);
  const dirty = treeChanges(wt);
  if (dirty) throw notProven(`the Install step changed the tree (first: ${dirty.split("\n")[0]}); it must leave every file as checked out`);

  const testLog = join(logs, "test.log");
  const trc = sh(o.test, wt, testLog);
  const where = `test output: ${testLog}`;
  if (didNotRun(trc)) {
    throw notProven(`the Test entrypoint '${o.test}' did not run (exit ${trc}: not executable or not found); ${where}`);
  }
  if (o.countLine === undefined && o.mutate === undefined) {
    throw notProven(`no proof given — pass --count-line/--test-count or --mutate/--mutation (the run exited ${trc}); ${where}`);
  }

  const proof = {};
  if (o.countLine !== undefined) {
    const n = Number(o.testCount);
    if (n === 0) throw notProven(`vacuous: a test count of 0 is a run that executed no tests; ${where}`);
    if (!new RegExp(`(^|[^0-9])0*${n}([^0-9]|$)`).test(o.countLine)) {
      throw notProven(`the count line '${o.countLine}' does not carry the test count ${n}`);
    }
    if (!readFileSync(testLog, "utf8").includes(o.countLine)) {
      throw notProven(`vacuous: the Test entrypoint's output does not contain the count line '${o.countLine}' — no evidence any test ran; ${where}`);
    }
    proof.testCount = n;
  }
  if (o.mutate !== undefined) {
    if (trc !== 0) {
      throw notProven(`the unmutated run is already red (exit ${trc}), so a mutation turning it red proves nothing — use the count proof; ${where}`);
    }
    const mutateLog = join(logs, "mutate.log");
    const mrc = sh(o.mutate, wt, mutateLog);
    if (mrc !== 0) throw notProven(`the mutation command '${o.mutate}' failed (exit ${mrc}); its output: ${mutateLog}`);
    const changed = git(["diff", "--name-only"], wt);
    if (!changed.ok) throw notProven(`could not read what the mutation changed: ${changed.err}`);
    if (!changed.out) throw notProven(`the mutation (${o.mutation}) changed no tracked file — mutate a test, or the code a test covers`);
    const mutatedLog = join(logs, "test-mutated.log");
    const red = sh(o.test, wt, mutatedLog);
    if (didNotRun(red)) throw notProven(`the Test entrypoint did not run on the mutated tree (exit ${red}); test output: ${mutatedLog}`);
    if (red === 0) {
      throw notProven(`vacuous: the mutation (${o.mutation}) did not turn the run red — the suite ran nothing it changed; test output: ${mutatedLog}`);
    }
    proof.mutation = `${o.mutation} — turned the run red (exit ${red}); changed ${changed.out.split("\n").join(", ")}`;
  }
  return proof;
}

// Write, then read back through the one reader. A cache it refuses is undone:
// the prior bytes restored, or the file removed when none stood before.
function writeCache(cache, recipe, repo) {
  mkdirSync(dirname(cache), { recursive: true });
  const prior = existsSync(cache) ? readFileSync(cache) : null;
  const tmp = `${cache}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(recipe)}\n`);
  renameSync(tmp, cache);
  for (const field of ["install", "test"]) {
    const r = spawnSync("sh", [READER, repo, field], { env: ENV, encoding: "utf8" });
    if (r.status !== 0 || r.stdout.replace(/\n$/, "") !== recipe[field]) {
      if (prior === null) unlinkSync(cache);
      else writeFileSync(cache, prior);
      throw notProven(`the Recipe cache reader refuses what was proven: ${(r.stderr || r.stdout).trim()}`);
    }
  }
}

function main(argv) {
  const o = parseArgs(argv);
  if (!git(["rev-parse", "--git-dir"], o.repo).ok) throw cannot(`${o.repo} is not a git repository`);
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], o.repo);
  const workspace = common.ok ? workspaceDirFromGitCommonDir(common.out, o.repo) : null;
  if (!workspace) throw cannot(`cannot resolve the common git dir of ${o.repo}: ${common.err}`);
  const sha = git(["rev-parse", "--verify", "origin/main^{commit}"], o.repo);
  if (!sha.ok) throw cannot("origin/main does not resolve to a commit — fetch it; the proof runs against it");

  const logs = mkdtempSync(join(tmpdir(), `${NAME}-`));
  const wt = join(logs, "wt");
  const add = git(["worktree", "add", "--detach", wt, sha.out], o.repo);
  if (!add.ok) throw cannot(`could not create the throwaway worktree: ${add.err}`);
  let proof;
  try {
    proof = prove(o, wt, logs);
  } finally {
    if (!git(["worktree", "remove", "--force", wt], o.repo).ok) {
      rmSync(wt, { recursive: true, force: true });
      git(["worktree", "prune"], o.repo);
    }
  }

  const recipe = { install: o.install, test: o.test, derivedAt: sha.out, installClean: true, ...proof };
  const cache = join(workspace, ".fleet", "recipe.json");
  writeCache(cache, recipe, o.repo);
  process.stdout.write(`${NAME}: PROVEN — Recipe cache written to ${cache}\n${JSON.stringify(recipe)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  // The closing sentence on a line of its own: most reasons end in a log path,
  // and a `.` riding on one would read as part of it.
  const msg = e.code === 1 ? `NOT PROVEN — ${e.message}\nNo Recipe cache written.` : e.message;
  process.stderr.write(`${NAME}: ${msg}\n`);
  process.exit(e.code);
}
