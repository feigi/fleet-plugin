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
//        must contain (text off the runner's summary line, read off a
//        previous run), carrying `--test-count`, a positive integer, as its
//        one number. `tests 0` is a failed proof however honestly the runner
//        reports it.
//      - the mutation proof: the unmutated run must be green; `--mutate` is a
//        shell command that must change a tracked file (the deliberate
//        failing mutation of one test, or of the code one test covers) — run
//        against the tree restored to HEAD, so a file the unmutated run itself
//        rewrote is not credited to it; the run must then go red. A mutation
//        that leaves the run green is a suite that runs nothing that matters.
//   With neither, nothing is proven: the refusal still names where the test
//   run's output is, so the caller can read the count line off it.
//
// Each of those commands — the Install step, both Test runs, the mutation —
// runs under a time bound of its own, 20 minutes, that RECIPE_PROVE_TIMEOUT
// (whole seconds) can shorten and never lengthen. A command still running at
// the bound is killed, and the proof is NOT PROVEN for it, the refusal naming
// the bound and the command's log.
//
// On proof, the cache is written atomically to <workspace>/.fleet/recipe.json
// — <workspace> being the directory holding the repository's common git dir,
// the place derive-testcmd.sh reads it from — and then read back through
// derive-testcmd.sh for both fields, the Test entrypoint against `derivedAt`'s
// tree (`--at`): the tree the proof ran in, and the one a claim probes, so a
// main checkout still on an older layout cannot refuse a Recipe that holds
// where it runs. A cache the reader refuses is rolled
// back to whatever stood before, as is one whose read-back is no verdict, so
// the reader stays the one authority on what a usable cache is. A failed
// proof never touches an existing cache.
//
// Exit 0: proven, cache written (its path and contents on stdout); the log
//         directory under $TMPDIR is removed.
// Exit 1: NOT PROVEN — no cache written; the reason on stderr. The log
//         directory under $TMPDIR is kept when the reason names a log in it,
//         and removed when it names none (the Recipe cache reader's refusal).
// Exit 2: no verdict on the proof — it could not be attempted (usage, not a
//         repository, origin/main missing, the worktree could not be made), or
//         a git or filesystem fault stopped it before the cache was settled
//         (a git command could not be started, the reader's own git
//         included, or that git started and could not run; the reader's `sh`,
//         `node`, `mktemp` or `cat` could not be started, its `mktemp` could
//         not create its temp file, its `sh` was killed by a signal, or its
//         `node` died mid-read or exited without a reason and a status other
//         than 2 — a `cat` that ran and failed stays the reader's refusal,
//         exit 1; the cache or its temp file could not be written). The log
//         directory under $TMPDIR is removed.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
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

// The bound on each Recipe command. A command that never returns — a stalled
// fetch, a watch-mode runner — would otherwise hang the Recipe derivation,
// which a run waits on before its first claim, with no refusal ever printed.
// 20 minutes is chosen against the false failure: far above a healthy install
// or suite, and still a bound.
//
// The bound is per command, never for the whole proof: the longest a proof
// can take is every command it runs taking its full bound.
//
// RECIPE_PROVE_TIMEOUT can only SHORTEN it: a knob that could lengthen the
// bound is one more way for configuration to remove it. A value that is not a
// positive whole number of seconds below the default is not an error and not
// a bound either — the default stands, in silence. isDigits() is arg.mjs's
// own predicate, so `3.5`, `-5` and `5e3` are refused flat, never coerced.
const COMMAND_DEFAULT_SECONDS = 20 * 60;
export function commandBudget(override) {
  const seconds = isDigits(String(override)) ? Number(override) : 0;
  return (seconds > 0 && seconds < COMMAND_DEFAULT_SECONDS ? seconds : COMMAND_DEFAULT_SECONDS) * 1000;
}
const COMMAND_TIMEOUT_MS = commandBudget(process.env.RECIPE_PROVE_TIMEOUT);

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const cannot = (message) => new Refusal(2, message);
const notProven = (message) => new Refusal(1, message);

// The exit status derive-testcmd.sh uses for a refusal about its own
// environment — a tool it needs would not start, git did not run to an answer,
// or node died mid-read or failed without a reason —
// where every refusal about the cache is 1.
const READER_COULD_NOT_RUN = 3;

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

// A git that cannot be started is no verdict, as for `sh` below: read as a
// failed git command, it would surface as whatever that command's failure
// means to its caller — a missing repository, an unfetched origin/main, a
// proof that did not hold. Only a spawn that produced no process counts:
// spawnSync also sets `error` for a git that ran and was killed — ENOBUFS,
// when its output outgrows the default maxBuffer — and that is a failed git
// command, never a git that could not be started.
//
// A git killed by a signal (that buffer kill, an OOM kill, a timeout wrapper)
// is still a failed command, never a throw: each caller maps a failed git to
// its own refusal. But it has no exit status — `status` is null — and mostly
// no stderr, so `err` names the kill, after whatever git did write — a caller
// quoting `err` would otherwise quote an empty reason.
//
// A git that ignores the buffer kill can still exit 0, with no signal, after
// its output was cut off: any `error` on a git that ran fails it, whatever its
// exit status, and `err` names that error without claiming a kill.
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
  if (r.error && !r.pid) throw cannot(`could not start git: ${r.error.message}`);
  const err = (r.stderr ?? "").trim();
  const failed = r.signal ? `git was killed by ${r.signal}` : r.error && `git exited ${r.status} after an error`;
  const note = failed && `${failed}${errorCause(r.error)}`;
  return { ok: r.status === 0 && !r.error, status: r.status, out: (r.stdout ?? "").replace(/\n$/, ""), err: [err, note].filter(Boolean).join("; ") };
}

function errorCause(error) {
  if (!error) return "";
  if (error.code === "ENOBUFS") return " (ENOBUFS: its output outgrew the spawn buffer)";
  return ` (${error.code ?? error.message})`;
}

// Run a Recipe command through `sh -c` from the worktree root, its output to
// a log file rather than a pipe: a real suite's output has no useful size
// bound, and the log is what the caller reads a count line off. A command
// killed by a signal (an OOM kill, a timeout wrapper) has no exit status, so
// it is refused here and never reported as one: a crashed run must not count
// as a red suite.
//
// A command that overruns COMMAND_TIMEOUT_MS is killed with SIGKILL, never the
// default SIGTERM: a command that traps or ignores SIGTERM would keep spawnSync
// waiting on it forever. spawnSync reports that kill as an ETIMEDOUT `error`
// alongside the signal, so the timeout is read first: through the `error`
// branch it would be a `sh` that could not start, and through the `signal`
// one a kill with no cause named. Whatever it printed before the kill stays in
// the log, which is opened for append. Only the `sh` itself is killed:
// spawnSync cannot kill a process tree, so a child the command started may
// outlive the refusal.
function sh(cmd, cwd, log) {
  const fd = openSync(log, "a");
  try {
    const r = spawnSync("sh", ["-c", cmd], {
      cwd, env: ENV, stdio: ["ignore", fd, fd], timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    if (r.error?.code === "ETIMEDOUT") {
      throw notProven(`'${cmd}' timed out: still running after ${COMMAND_TIMEOUT_MS / 1000}s, the bound on each Recipe command, so it was stopped; output: ${log}`);
    }
    if (r.error) throw cannot(`could not start sh: ${r.error.message}`);
    if (r.signal) throw notProven(`'${cmd}' was killed by ${r.signal}, so it has no exit status to read; output: ${log}`);
    return r.status;
  } finally {
    closeSync(fd);
  }
}

const didNotRun = (rc) => rc === 126 || rc === 127;

// `-uall` for the reason the header gives: an untracked, unignored file an
// install creates dirties the tree as surely as a rewrite, and the untracked
// mode is config — under status.showUntrackedFiles=no it is invisible unless
// pinned.
function treeChanges(wt, log) {
  const s = git(["status", "--porcelain", "-uall"], wt);
  if (!s.ok) throw notProven(`could not read the tree state in the throwaway worktree: ${s.err}; install output: ${log}`);
  return s.out;
}

function prove(o, wt, logs) {
  const installLog = join(logs, "install.log");
  const irc = sh(o.install, wt, installLog);
  if (didNotRun(irc)) {
    throw notProven(`the Install step '${o.install}' did not run (exit ${irc}: not executable or not found); install output: ${installLog}`);
  }
  if (irc !== 0) throw notProven(`the Install step '${o.install}' failed (exit ${irc}); install output: ${installLog}`);
  const dirty = treeChanges(wt, installLog);
  if (dirty) {
    throw notProven(`the Install step changed the tree (first: ${dirty.split("\n")[0]}); it must leave every file as checked out; install output: ${installLog}`);
  }

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
    // The claim must be the line's ONE number, never merely one of its numbers:
    // a summary line carrying several can carry the claim as its skipped count
    // while the run itself executed none. Its first number is no rule either —
    // a runner may print its skips before its count.
    const numbers = o.countLine.match(/[0-9]+/g) ?? [];
    if (numbers.length !== 1 || BigInt(numbers[0]) !== BigInt(o.testCount)) {
      throw notProven(`the count line '${o.countLine}' does not carry the test count ${o.testCount} as its one number (it carries ${numbers.length ? numbers.join(", ") : "none"}) — trim it to the number of tests that ran; ${where}`);
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
    // What the unmutated Test run rewrote is not the mutation's work: restore
    // every tracked file first, so the change read below is the mutation's alone.
    const reset = git(["reset", "--hard", "-q", "HEAD"], wt);
    if (!reset.ok) throw notProven(`could not restore the tree before the mutation: ${reset.err}; ${where}`);
    const mutateLog = join(logs, "mutate.log");
    const mrc = sh(o.mutate, wt, mutateLog);
    if (mrc !== 0) throw notProven(`the mutation command '${o.mutate}' failed (exit ${mrc}); its output: ${mutateLog}`);
    // Against HEAD, not the index: a mutation that stages its edit (`git mv`,
    // `git add`) changed a tracked file just as surely.
    const changed = git(["diff", "HEAD", "--name-only"], wt);
    if (!changed.ok) throw notProven(`could not read what the mutation changed: ${changed.err}; its output: ${mutateLog}`);
    if (!changed.out) throw notProven(`the mutation (${o.mutation}) changed no tracked file — mutate a test, or the code a test covers; its output: ${mutateLog}`);
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
// the prior bytes restored, or the file removed when none stood before. The
// cache is undone just the same when the read-back is no verdict: an `sh` that
// could not be started read nothing; an `sh` killed by a signal has no exit
// status and reached no verdict; a reader that exits READER_COULD_NOT_RUN
// could not start its git, `node`, `mktemp` or `cat`, could not create its
// temp file, saw git end on any status but git's own 128, or lost its `node`
// mid-read or saw it exit without a reason on a status other than 2; and the
// reader reads a git that ends on 128 as no repository at
// all, so its refusal is a verdict on what was proven only while git still
// runs. `git --version` is the probe for that exit-1 refusal: a working git
// always passes it, so a git that cannot be started fails it, and so does one
// that starts and cannot run — one that exits 128 on every call, or one that
// stopped running after the reader's own git calls answered. A git that exits
// 126 or 127, or is killed, on those calls never reaches the probe: the reader
// exits READER_COULD_NOT_RUN first.
function writeCache(cache, recipe, repo) {
  mkdirSync(dirname(cache), { recursive: true });
  const prior = existsSync(cache) ? readFileSync(cache) : null;
  const tmp = `${cache}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(recipe)}\n`);
    renameSync(tmp, cache);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  for (const field of ["install", "test"]) {
    const r = spawnSync("sh", [READER, repo, field, ...(field === "test" ? ["--at", recipe.derivedAt] : [])], { env: ENV, encoding: "utf8" });
    if (r.status === 0 && r.stdout.replace(/\n$/, "") === recipe[field]) continue;
    if (prior === null) unlinkSync(cache);
    else writeFileSync(cache, prior);
    if (r.error && !r.pid) throw cannot(`could not start sh to read the Recipe cache back: ${r.error.message}`);
    if (r.status === READER_COULD_NOT_RUN) throw cannot(`${r.stderr.trim()} — the Recipe cache reader could not run a tool it needs, so its refusal is no verdict on what was proven`);
    if (r.signal) throw cannot(`the Recipe cache reader's sh was killed by ${r.signal}${errorCause(r.error)}, so it reached no verdict on what was proven`);
    const noVerdict = (why) => cannot(`${why} — the Recipe cache reader runs git, so its refusal is no verdict on what was proven`);
    let probe;
    try {
      probe = git(["--version"]);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      throw noVerdict(e.message);
    }
    if (!probe.ok) {
      const exit = probe.status === null ? "did not exit 0" : `exited ${probe.status}`;
      const stderrNote = probe.err ? `: ${probe.err}` : " and wrote nothing to stderr";
      throw noVerdict(`git started but does not run: \`git --version\` ${exit}${stderrNote}`);
    }
    const said = r.stderr.trim() || r.stdout.trim();
    throw notProven(`the Recipe cache reader refuses what was proven: ${said || `it wrote nothing and exited with status ${r.status}`}`);
  }
}

// Best-effort, and never allowed to replace the proof's own outcome — a proof
// that held, or a Refusal that names why it did not, is what the caller reads.
// An Install step that leaves read-only directories behind (a Go module cache
// is the usual one; the repo ignores them) makes both git's removal and a
// plain recursive delete fail, so the fallback makes the tree writable first.
// The prune always runs: it is what drops the registration of a worktree
// whose directory is gone. A git that cannot be started is reported and
// skipped here, since this runs in the proof's `finally`.
function removeWorktree(wt, repo) {
  const tryGit = (args) => {
    try {
      return git(args, repo).ok;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      process.stderr.write(`${NAME}: skipped git ${args.join(" ")}: ${e.message}\n`);
      return false;
    }
  };
  if (!tryGit(["worktree", "remove", "--force", wt])) {
    spawnSync("chmod", ["-R", "u+w", wt], { stdio: "ignore" });
    try {
      rmSync(wt, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`${NAME}: could not remove the throwaway worktree ${wt}: ${e.message}\n`);
    }
  }
  tryGit(["worktree", "prune"]);
}

// The log directory outlives the run only for a refusal that names it, so the
// caller can read the log it points at. A proof that held has its evidence
// summarised in the cache, a run with no verdict was stopped by a fault no log
// records, and a refusal that names no log (the Recipe cache reader's) has
// nothing in the directory to point at. Best-effort, as removeWorktree is.
function removeLogs(logs) {
  try {
    rmSync(logs, { recursive: true, force: true });
  } catch (e) {
    process.stderr.write(`${NAME}: could not remove the log directory ${logs}: ${e.message}\n`);
  }
}

function main(argv) {
  const o = parseArgs(argv);
  const gitDir = git(["rev-parse", "--git-dir"], o.repo);
  if (!gitDir.ok) throw cannot(`${o.repo} is not a git repository: ${gitDir.err}`);
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], o.repo);
  const workspace = common.ok ? workspaceDirFromGitCommonDir(common.out, o.repo) : null;
  if (!workspace) throw cannot(`cannot resolve the common git dir of ${o.repo}: ${common.err}`);
  const sha = git(["rev-parse", "--verify", "origin/main^{commit}"], o.repo);
  if (!sha.ok) throw cannot(`origin/main does not resolve to a commit (${sha.err}) — fetch it; the proof runs against it`);

  const logs = mkdtempSync(join(tmpdir(), `${NAME}-`));
  const cache = join(workspace, ".fleet", "recipe.json");
  let recipe;
  try {
    const wt = join(logs, "wt");
    const add = git(["worktree", "add", "--detach", wt, sha.out], o.repo);
    if (!add.ok) throw cannot(`could not create the throwaway worktree: ${add.err}`);
    let proof;
    try {
      proof = prove(o, wt, logs);
    } finally {
      removeWorktree(wt, o.repo);
    }

    recipe = { install: o.install, test: o.test, derivedAt: sha.out, installClean: true, ...proof };
    writeCache(cache, recipe, o.repo);
  } catch (e) {
    if (!(e instanceof Refusal && e.message.includes(logs))) removeLogs(logs);
    throw e;
  }
  removeLogs(logs);
  process.stdout.write(`${NAME}: PROVEN — Recipe cache written to ${cache}\n${JSON.stringify(recipe)}\n`);
}

// Only run main() as a CLI, never when imported by a test (see is-cli.mjs).
if (isCLI(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // A fault outside the proof — the cache or its temp file could not be
    // written — is "no verdict" (2), never the NOT PROVEN (1) a stack trace's
    // exit status would read as.
    if (!(e instanceof Refusal)) {
      process.stderr.write(`${NAME}: ${e.message}\n`);
      process.exit(2);
    }
    // The closing sentence on a line of its own: most reasons end in a log path,
    // and a `.` riding on one would read as part of it.
    const msg = e.code === 1 ? `NOT PROVEN — ${e.message}\nNo Recipe cache written.` : e.message;
    process.stderr.write(`${NAME}: ${msg}\n`);
    process.exit(e.code);
  }
}
