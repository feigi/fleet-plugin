#!/usr/bin/env node
// Run the Recipe's Check step and the Test entrypoint against the staged tree,
// and record that both passed — the record `ledger.mjs settle --from-report`
// requires before it settles an implementer's or a fix-applier's report.
//
//   recipe-check.mjs --member <name> --testCmd <command> [--reports <dir>]
//
// Run from the member's worktree, after `git add` and before the commit and
// push, and again after any content change or rebase. Reached through the
// Resolver: `~/.fleet/bin/fleet-run recipe-check.mjs ...`.
//
// `--member` is the `impl-<N>[-x]` or `fix-pr-<M>[-x]` name the member was
// dispatched as. `--testCmd` is the Test entrypoint exactly as the member was
// handed it, a shell command run from the worktree root: the member's runner
// already goes through the suite-slot wrapper, so this script adds none of its
// own and never runs the suite a second time. The Check step is not an
// argument: it is read off the repository's Recipe cache, through
// derive-testcmd.sh, the one reader of it. `--reports` is the directory the
// member's report is written to, `<scratch>/reports`; omitted, the default
// scratch root's.
//
// Steps, in this order:
//
//   1  read the Check step and the Test entrypoint off the Recipe cache. A
//      repository with no usable Recipe has no Check step to run: exit 2,
//      nothing run, nothing written. Settle applies no gate to such a
//      repository either.
//   2  `git write-tree`: the tree id of the staged index. The working tree
//      is never hashed, so an untracked or unstaged file is no part of the key.
//   3  the Check step, `sh -c` from the worktree root. A Check step of
//      `true` is recorded as green without being run.
//   4  the Test entrypoint, the same way — only when the Check step passed.
//
// The commands' own output passes through on stdout and stderr as it arrives.
//
// THE RECORD is `<reports>/<member>.check.json`, beside the member's report
// (report-files.mjs names the path and reads it back), written whole and
// atomically once both commands have settled:
//
//   { member, tree, check: {command, ran, exitCode, pass, fail},
//                   test:  {command, ran, exitCode, pass, fail} }
//
//   tree       the `git write-tree` of step 2. Settle compares it with the
//              reported head's own tree, so a message-only amend keeps the
//              record valid and a rebase onto a moved base, or any content
//              change, does not.
//   ran        false for a Check step of `true`, and for a command skipped
//              because the Check step failed (its exitCode is then null).
//   exitCode   the command's status, a signal's number plus 128.
//   pass, fail the counts the runner's summary printed — a `# pass N` /
//              `ℹ fail N` line, or `N passed`/`N failed`/`N passing`/`N
//              failing` — null where it printed none.
//
// A record is written whenever a command ran and failed, so a red run
// replaces an older record rather than leaving it standing; it records the
// failure, and settle refuses on it. A record is a claim, no attestation: the
// member produces it, and nothing here stops a forged one.
//
// Exit status: 0 both commands passed and the record is written; 1 a command
// failed — the record says which, and the script's stderr names it; 2 a
// refusal that ran nothing and wrote nothing (usage, no usable Recipe, git
// could not be read); 75 the Test entrypoint printed exit 75 — the suite
// wrapper found no slot and launched nothing, which is no test result — so
// nothing is written, and the same command is to be run again.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { FleetDirUnresolvable } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { parseMember } from "./ledger-grammar.mjs";
import { checkRecordPathIn, defaultScratch, reportsDir } from "./report-files.mjs";

const NAME = "recipe-check";
const USAGE = "usage: recipe-check.mjs --member <name> --testCmd <command> [--reports <dir>]";
const DERIVE = join(dirname(fileURLToPath(import.meta.url)), "derive-testcmd.sh");
const GIT_TIMEOUT_MS = 30_000;
// What the suite wrapper exits with when it found no slot and launched nothing.
const NO_SLOT = 75;
// The tail of a command's output kept for the counts: a runner prints its
// summary last.
const TAIL_BYTES = 256 * 1024;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** `{pass, fail}` the output's summary printed, each null where it printed no
 * count. The last count of a kind wins: a summary follows the lines it sums. */
export function parseCounts(output) {
  const text = output.replace(ANSI, "");
  const last = (patterns) => {
    for (const re of patterns) {
      const all = [...text.matchAll(re)];
      if (all.length > 0) return Number(all.at(-1)[1]);
    }
    return null;
  };
  const count = (word, loose) => last([new RegExp(`^[ \\t]*(?:#|ℹ)[ \\t]+${word}[ \\t]+(\\d+)[ \\t]*$`, "gm"), loose]);
  return {
    pass: count("pass", /\b(\d+)[ \t]+(?:passed|passing)\b/g),
    fail: count("fail", /\b(\d+)[ \t]+(?:failed|failing)\b/g),
  };
}

async function cli() {
  const die = makeDie(NAME);
  const { arg, sweep, stray } = defineFlags(die, { flags: { member: "value", testCmd: "value", reports: "value" } });
  sweep();
  stray();
  const member = arg("member");
  const testCmd = arg("testCmd");
  let reports = arg("reports");
  if (member === null || testCmd === null) die(USAGE);
  const parsed = parseMember(member);
  if (parsed === null || (parsed.family !== "impl" && parsed.family !== "fix-pr")) {
    die(`--member '${member}' is not an impl-<N>[-x] or fix-pr-<M>[-x] name — ${USAGE}`);
  }
  if (testCmd.trim() === "") die(`--testCmd is empty — ${USAGE}`);
  if (reports === null) {
    try {
      reports = reportsDir(defaultScratch());
    } catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      die(`no --reports, and the scratch root could not be resolved — ${e.message}`);
    }
  }

  const env = gitEnv();
  const git = (args) => spawnSync("git", args, { encoding: "utf8", env, timeout: GIT_TIMEOUT_MS });
  const gitOut = (what, args) => {
    const r = git(args);
    if (r.status !== 0) {
      const why = (r.error?.message ?? r.stderr ?? "").trim();
      die(`${what} did not answer${r.status === null ? "" : ` (exit ${r.status})`}${why ? `: ${why}` : ""}; nothing run, nothing written`);
    }
    return r.stdout.trim();
  };
  const top = gitOut("git rev-parse --show-toplevel", ["rev-parse", "--show-toplevel"]);

  // 1: the Recipe. Exit 1 is derive-testcmd.sh's refusal about the cache; any
  // other failure is a reader that could not run.
  const field = (name) => {
    const r = spawnSync("sh", [DERIVE, top, name], { encoding: "utf8", env, timeout: GIT_TIMEOUT_MS });
    if (r.status === 0) return r.stdout.replace(/\n$/, "");
    const why = (r.error?.message ?? r.stderr ?? "").trim();
    if (r.status === 1) {
      die(`this repository has no usable Recipe, so there is no Check step to run and settle applies no gate to it; nothing run, nothing written — ${why}`);
    }
    die(`derive-testcmd.sh ${name} did not answer${r.status === null ? "" : ` (exit ${r.status})`}${why ? `: ${why}` : ""}; nothing run, nothing written`);
  };
  const checkCmd = field("check");
  field("test");

  // 2: the staged tree.
  const tree = gitOut("git write-tree", ["write-tree"]);

  // 3 and 4: the commands.
  const check = checkCmd.trim() === "true"
    ? { command: checkCmd, ran: false, exitCode: 0, pass: null, fail: null }
    : await runCommand(checkCmd, top, env);
  const test = check.exitCode === 0
    ? await runCommand(testCmd, top, env)
    : { command: testCmd, ran: false, exitCode: null, pass: null, fail: null };

  // process.exitCode, never process.exit(): the command's own output is still
  // draining through async pipe writes, and exit discards what is queued.
  const say = (line) => writeAll(2, `\n${NAME}: ${line}\n`);
  if (test.exitCode === NO_SLOT) {
    say(`the Test entrypoint exited ${NO_SLOT}: no suite slot was free and nothing was launched — run the same command again; nothing written`);
    process.exitCode = NO_SLOT;
    return;
  }

  mkdirSync(reports, { recursive: true });
  const path = checkRecordPathIn(reports, member);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ member, tree, check, test })}\n`);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    die(`could not write ${path}: ${e.code ?? e.message}`);
  }

  if (check.exitCode !== 0) {
    say(`the Check step exited ${check.exitCode}; red record written to ${path}, so settle refuses it — fix the cause and run again`);
    process.exitCode = 1;
  } else if (test.exitCode !== 0) {
    say(`the Test entrypoint exited ${test.exitCode}; red record written to ${path}, so settle refuses it — fix the cause and run again`);
    process.exitCode = 1;
  } else {
    say(`green on tree ${tree}; record written to ${path}`);
  }
}

if (isCLI(import.meta.url)) await cli();

// One command, `sh -c` from `cwd`, its output passed through and its tail kept
// for the counts. A signal that stops it is its number plus 128.
function runCommand(command, cwd, env) {
  return new Promise((resolve) => {
    let tail = "";
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-TAIL_BYTES);
    };
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const forward = (sig) => () => child.kill(sig);
    const handlers = ["SIGTERM", "SIGINT", "SIGHUP"].map((sig) => [sig, forward(sig)]);
    for (const [sig, h] of handlers) process.on(sig, h);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      keep(d);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      keep(d);
      process.stderr.write(d);
    });
    const done = (exitCode) => {
      for (const [sig, h] of handlers) process.off(sig, h);
      const { pass, fail } = parseCounts(tail);
      resolve({ command, ran: true, exitCode, pass, fail });
    };
    // A spawn that never started (a missing `sh`) is the command not passing.
    child.on("error", (e) => {
      process.stderr.write(`${NAME}: could not start sh: ${e.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) => done(code ?? 128 + (osConstants.signals[signal] ?? 0)));
  });
}
