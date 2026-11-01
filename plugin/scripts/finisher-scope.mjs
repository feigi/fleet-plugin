#!/usr/bin/env node
// The finisher's Inert diff verdict as one command, so duty 2 skips the
// acceptance mutation only on a script's answer and never on a reading of the
// diff.
//
//   finisher-scope.mjs --worktree <abs-path> --pin <sha> [--repo <dir>]
//
// `--pin` is the full 40-hex head the finisher was dispatched against. `--repo`
// is the directory git runs in; it defaults to the worktree, which shares its
// object store with the repository, so either names the same history.
//
// The diff is `git diff-tree` from the merge base of origin/main and the pin to
// the pin, renames disabled, so a rename is a deletion and an addition and both
// paths are classified. It never reads `gh pr view --json files` and never
// reads the worktree's own head or files, so a head that moved past the pin
// does not change the answer.
//
// The diff is an Inert diff only when every rule holds:
//
//   - it is non-empty, and every record was read;
//   - every entry is a regular-file add, modify or delete on each side, with
//     mode 100644 only: no symlink, submodule, type change, mode change or
//     executable bit on either side;
//   - every path, old and new side, is prose or data.
//
//   prose  isDocs() calls it docs, it ends in .md or .markdown, it is not
//          under a test directory, and it is outside the prompt surface: no
//          directory segment named skills, agents or commands, no directory
//          segment that starts with a dot, and no file named AGENTS.md,
//          CLAUDE.md or GEMINI.md, at any depth. A file directly in the root
//          .out-of-scope/, spelled exactly so, is exempt from the dot rule
//          alone
//   data   one of the METRICS paths closeout.mjs names, and no other file
//
// Stdout is one JSON line:
//
//   {verdict, exit, pin, base, paths: [{path, status, class, why}], reason}
//
//   verdict  "inert", "not-inert" or "unknown"
//   exit     0 inert, 1 not inert, 2 could not look
//   class    "prose", "data", or null for a path that is neither
//   reason   `empty diff` for an empty diff (exit 1); null for any other exit 0
//            or 1; on exit 2, what could not be read
//
// Exit vocabulary:
//
//   0  inert: the finisher may skip the acceptance mutation
//   1  not inert: the finisher runs the mutation exactly as today
//   2  could not look: the finisher runs the mutation exactly as today
//
// A usage error (a missing or relative flag, a pin that is not 40 hex) is a
// die() refusal on stderr with no verdict, exit 2. The script only reads: it
// never writes to the worktree.
//
// The verdict is also exported as inertVerdict(), so another finisher script
// can call it in-process; that call never exits the process.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { METRICS } from "./closeout.mjs";
import { isDocs, isMarkdown, isTestDir } from "./diff-stats.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "finisher-scope";
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const ZERO = "000000";
const PLAIN = "100644";
const SHA = /^[0-9a-f]{40}$/;
const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/;
const PROMPT_DIRS = new Set(["skills", "agents", "commands"]);
const RECORDS_DIR = ".out-of-scope";
const PROMPT_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);
const USAGE = "usage: finisher-scope.mjs --worktree <abs-path> --pin <sha> [--repo <dir>]";
const EXIT = { inert: 0, "not-inert": 1, unknown: 2 };

const die = makeDie(NAME);

// One read-only git call. `ok` false carries the reason, never a thrown error,
// and `status` when git ran and exited non-zero.
function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) return { ok: false, why: `git ${args[0]} could not run: ${r.error.code ?? r.error.message}` };
  if (r.signal) return { ok: false, why: `git ${args[0]} killed by ${r.signal}` };
  if (r.status !== 0) return { ok: false, status: r.status, why: `git ${args[0]} exited ${r.status}: ${r.stderr.trim()}` };
  return { ok: true, stdout: r.stdout };
}

// The mode rule. An entry passes only as a plain-file add, delete, or modify
// with the same plain mode on both sides; anything else names what it is.
function modeProblem(status, oldMode, newMode) {
  if (status === "A" && oldMode === ZERO && newMode === PLAIN) return null;
  if (status === "D" && oldMode === PLAIN && newMode === ZERO) return null;
  if (status === "M" && oldMode === PLAIN && newMode === PLAIN) return null;
  if (status === "T") return "type change";
  if (oldMode === "120000" || newMode === "120000") return "symlink";
  if (oldMode === "160000" || newMode === "160000") return "submodule";
  if (oldMode === "100755" || newMode === "100755") return "executable bit";
  return `not a regular-file add, modify or delete (${status})`;
}

// The prompt-surface rule: the harness's names, at any depth. A segment named
// `skills-notes` is not `skills`, so only whole segments count. A dot-directory
// is where omp and the tools it discovers keep what they load as instructions
// (`.omp/rules`, `.omp/RULES.md`, `.omp/SYSTEM.md`, `.claude`, `.cursor`,
// `.github/copilot-instructions.md`), so every one is the prompt surface
// rather than a list of them that drifts as discovery grows. The one exception
// is a file directly in the root `.out-of-scope/`: the triage skill writes a
// rejection record there, read as settled precedent rather than as an
// instruction, so the directory rule passes over it. Nested, elsewhere or
// spelled otherwise, it is a dot-directory like any other, and the file-name
// rule still applies.
function promptSurface(path) {
  const parts = path.split("/");
  const dirs = parts.length === 2 && parts[0] === RECORDS_DIR ? [] : parts.slice(0, -1);
  for (const dir of dirs) {
    if (dir.startsWith(".") || PROMPT_DIRS.has(dir.toLowerCase())) return `prompt surface: directory ${dir}`;
  }
  const file = parts.at(-1).toLowerCase();
  if (PROMPT_FILES.has(file)) return `prompt surface: ${parts.at(-1)}`;
  return null;
}

// One entry's class, or null with the reason it is neither. Exported for the
// test that pins each rule separately.
export function classifyEntry(path, status, oldMode, newMode) {
  const mode = modeProblem(status, oldMode, newMode);
  if (mode !== null) return { class: null, why: mode };
  if (METRICS.includes(path)) return { class: "data", why: "run metrics file" };
  if (isTestDir(path)) return { class: null, why: "under a test directory" };
  if (!isMarkdown(path)) return { class: null, why: isDocs(path) ? "docs, but not .md or .markdown" : "not prose or data" };
  const surface = promptSurface(path);
  if (surface !== null) return { class: null, why: surface };
  return { class: "prose", why: "plain markdown outside the prompt surface" };
}

// `git diff-tree -z --raw` output as entries, or null when a record is not
// the shape the command writes.
export function parseRaw(text) {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = RAW.exec(parts[i]);
    if (m === null || i + 1 >= parts.length) return null;
    entries.push({ oldMode: m[1], newMode: m[2], status: m[5], path: parts[i + 1] });
  }
  return entries;
}

// The verdict for one PR. Never exits the process: a caller in-process gets
// the same object the command prints. `repo` absent or null is the worktree.
export function inertVerdict({ worktree, pin, repo }) {
  const lowered = typeof pin === "string" ? pin.toLowerCase() : "";
  const sha = SHA.test(lowered) ? lowered : null;
  // Every result is built here, so `exit` is always the one its verdict names.
  const result = (verdict, fields) => ({ verdict, exit: EXIT[verdict], pin: sha, base: null, paths: [], reason: null, ...fields });
  const fail = (reason, base = null) => result("unknown", { base, reason });
  if (typeof worktree !== "string" || !isAbsolute(worktree)) return fail("worktree is not an absolute path");
  if (sha === null) return fail("pin is not a full 40-hex commit SHA");
  const cwd = repo ?? worktree;

  // `rev-parse --verify --quiet` exits 1 for a name that resolves to nothing;
  // any other failure is git's own, and its reason is the one reported.
  const origin = git(cwd, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]);
  if (!origin.ok) {
    return fail(origin.status === 1 ? "no origin/main to take the merge base against" : `could not read origin/main: ${origin.why}`);
  }
  const head = git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  if (!head.ok) return fail(head.status === 1 ? "pin names no commit" : `could not read the pin: ${head.why}`);
  const mb = git(cwd, ["merge-base", "--all", "refs/remotes/origin/main", sha]);
  if (!mb.ok) return fail(`no merge base: ${mb.why}`);
  const bases = mb.stdout.trim().split("\n").filter(Boolean);
  if (bases.length !== 1) return fail(`ambiguous merge base: ${bases.length} candidates`);
  const base = bases[0];

  const d = git(cwd, [
    "diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "--no-commit-id", base, sha,
  ]);
  if (!d.ok) return fail(`diff could not be read: ${d.why}`, base);
  const entries = parseRaw(d.stdout);
  if (entries === null) return fail("diff output could not be parsed", base);
  if (entries.length === 0) return result("not-inert", { base, reason: "empty diff" });

  const paths = entries.map((e) => {
    const c = classifyEntry(e.path, e.status, e.oldMode, e.newMode);
    return { path: e.path, status: e.status, class: c.class, why: c.why };
  });
  return result(paths.some((p) => p.class === null) ? "not-inert" : "inert", { base, paths });
}

// A path stat cannot read at all (EACCES on a parent) is a usage refusal like a
// missing one: uncaught, it would exit 1, the not-inert code, about a diff
// nobody read.
function isDirectory(p) {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (e) {
    return die(`cannot stat ${p}: ${e.code ?? e.message}`);
  }
}

function main() {
  const { arg, sweep, stray } = defineFlags(die, {
    flags: { worktree: "value", pin: "value", repo: "value" },
  });
  // The sweep runs before the required-flag check, so a misspelt flag is named
  // as that and not buried under a missing-flag usage line.
  sweep();
  stray();
  const worktree = arg("worktree");
  const pin = arg("pin");
  const repoArg = arg("repo");
  if (worktree === null || pin === null) die(USAGE);
  if (!isAbsolute(worktree)) die(`--worktree must be an absolute path, got ${worktree}`);
  if (!isDirectory(worktree)) die(`--worktree is not a directory: ${worktree}`);
  if (!SHA.test(pin.toLowerCase())) die(`--pin needs a full 40-character commit SHA, got ${pin}`);
  if (repoArg !== null && !isDirectory(resolve(repoArg))) die(`--repo is not a directory: ${repoArg}`);

  const v = inertVerdict({ worktree, pin, repo: repoArg === null ? null : resolve(repoArg) });
  // Exit 0 is the only code that skips the mutation, so a verdict that never
  // reached stdout must not leave it set: a lost write is the could-not-look exit.
  if (!writeAll(1, `${JSON.stringify(v)}\n`)) die("the verdict could not be written to stdout");
  process.exitCode = v.exit;
}

if (isCLI(import.meta.url)) main();
