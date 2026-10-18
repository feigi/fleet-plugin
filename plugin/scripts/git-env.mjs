// Shared by every `.mjs` script under this directory that shells out to git —
// two exports, one per half of the same spawn. `gitEnv()` builds the env the
// git child is given; `workspaceDirFromGitCommonDir()` turns what the most
// common of those children answers with, `rev-parse --git-common-dir`, into
// the workspace directory a run's files live under. The first half's
// reasoning is below; the second's sits beside its own function.
//
// GIT_DIR and GIT_WORK_TREE outrank both the child's cwd and an explicit `-C`
// argument — measured directly: a `git rev-parse`/`ls-files` call
// pointed at a repository via `cwd` or `-C` still answers for whichever
// repository an ambient GIT_DIR or GIT_WORK_TREE names, silently, often at
// exit 0. The shell scripts under this directory close the identical class
// with one line, `unset GIT_DIR GIT_WORK_TREE`; there is no shell to unset in
// here, so the child's env has to be built instead — and the reasons
// net.sh/worktree.sh are exempt from that line ("a library... unset there would
// reach back into the caller's environment") do not transfer: a spawned
// child's env object is already private to it, never the calling process's.
//
// `ledger.mjs`'s tracker-query probe spells the same three lines inline —
// `{ ...process.env }` then two `delete`s — predating this module, and a
// hand-spelled copy per call site is exactly the duplication this module
// replaces. A shared helper also turns "does this call scrub the ambient
// vars" back into a one-name grep, `gitEnv(`, the way `unset GIT_DIR
// GIT_WORK_TREE` is one for shell.
//
// That pre-existing inline site is deliberately NOT migrated to call this. It
// is already fixed and covered by a test of its own ("an inherited GIT_DIR or
// GH_REPO cannot retarget the query…"), and touching it to satisfy a detector
// would be churn with no behavioural change. The suite's census of
// ambient-var scrubs carries it by name instead of by import.

/**
 * `base` (defaulting to `process.env`) with GIT_DIR and GIT_WORK_TREE
 * removed, so a git child spawned with the result cannot be retargeted by
 * whichever repository an ambient invocation — a git hook, `rebase --exec`,
 * `bisect run` — happened to set either to.
 *
 * `overrides` are applied AFTER the copy of `base` and BEFORE the two
 * deletes below, so a caller can add its own keys (`LC_ALL`, `GH_REPO`) in
 * the same call without a second object spread, and an override that itself
 * names GIT_DIR or GIT_WORK_TREE cannot smuggle either back in.
 */
export function gitEnv(overrides = {}, base = process.env) {
  const env = { ...base, ...overrides };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

// Every fleet script that needs to know WHERE the run's files live asks git
// the same question — `rev-parse --git-common-dir` — and then resolves the
// answer the same way, because the answer is the same shape wherever it is
// asked: the common dir is shared by every worktree of one repository (git
// answers with the MAIN checkout's git dir from inside a linked worktree), so
// every worktree of one repository resolves to ONE workspace, whichever
// worktree asked. That is why a member running from `.worktrees/<n>-slug` and
// the controller running from the checkout root agree about the run's single
// ledger, its single heartbeat and its single board.
//
// The workspace is the directory holding a checkout's `.git`, which is the
// common dir's parent. A common dir that is NOT a checkout's `.git` is its own
// workspace — a bare repository's, a submodule's or a `--separate-git-dir`
// clone's git dir — so two such dirs sharing a parent do not collapse onto
// one workspace. The `.bare` layout is the exception that keeps the parent.
// The rule's full statement sits beside `resolveWorkspace()` below.
//
// For a run's `.fleet/` files the question is asked in one place,
// fleet-dir.mjs's fleetFile(), which spawns the probe and hands its answer to
// this module. What is NOT shared is the part each caller owns: the
// filename it joins on, the wording of the warning it degrades with, and what
// its own degraded answer is. Hence the seam: this module answers the
// directory or `null`, and every caller composes the rest around it.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// A `rev-parse` answers in milliseconds; this bound exists so a git that never
// answers cannot hang its caller, not to time a healthy one.
export const DEFAULT_GIT_TIMEOUT_MS = 10_000;

// Thrown when the one probe the rule needs beyond `--git-common-dir` could not
// run to an answer: git missing, or killed at its bound. Not thrown for a git
// that ran and refused — that is an answer, and the rule reads it as "no".
export class WorkspaceProbeFailed extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceProbeFailed";
  }
}

/** The realpath of `path`, or `path` itself when it does not resolve. */
function realpathOr(path) {
  try { return realpathSync(path); } catch { return path; }
}

/** The realpath of `path`; when `path` itself does not exist, the realpath of its parent joined with its basename. */
function canonicalPath(path) {
  try { return realpathSync(path); } catch { return join(realpathOr(dirname(path)), basename(path)); }
}

// Why a probe that did not answer did not: the spawn error, the signal that
// killed it, or its stderr.
function probeWhy(r) {
  if (r.error && r.error.message) return r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return String(r.stderr ?? "").trim() || (r.status === null ? "no answer" : `exit ${r.status}`);
}

// Does `<parent>/.git` name `gitDir` (a realpath)? `--resolve-git-dir` follows
// a gitfile, so the `.bare` layout's `.git` file answers with `.bare`.
function parentGitDirNames(parent, gitDir, cwd, timeoutMs) {
  const candidate = join(parent, ".git");
  const r = spawnSync("git", ["rev-parse", "--resolve-git-dir", candidate], {
    cwd, encoding: "utf8", timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, env: gitEnv(),
  });
  if (r.error || r.status === null) {
    throw new WorkspaceProbeFailed(`could not resolve ${candidate}: ${probeWhy(r)}`);
  }
  if (r.status !== 0) return false;
  return realpathOr(resolve(parent, r.stdout.trim())) === gitDir;
}

/**
 * The workspace a `git rev-parse --git-common-dir` answer names, resolved
 * against `cwd`, plus `gitDir`: true when the workspace IS the common git dir,
 * false when it is the directory holding a checkout's `.git`. `null` when the
 * answer is empty.
 *
 * The rule, on the common dir `C` (the realpath of the answer):
 *   1. `C` is named `.git`: the workspace is its parent. No spawn.
 *   2. Otherwise `<parent of C>/.git` is probed with `--resolve-git-dir`. If it
 *      names `C`, the workspace is that parent (the `.bare` layout). A git that
 *      refuses, or names something else, is "no".
 *   3. Otherwise the workspace is `C` itself, with `gitDir: true`.
 *
 * `gitDir` is what the scratch root's key reads: a git dir's `.git` suffix
 * (`x.git`) is dropped from the key; a checkout's folder name is not touched,
 * so a plain clone in a folder named `x.git` keeps its key.
 *
 * The answer is resolved against `cwd` (default `process.cwd()`): git answers
 * RELATIVE — `.git` — from a checkout's top level.
 *
 * Return spelling, when `canonicalise` is off: the path as the answer spelled
 * it, resolved against `cwd`. `canonicalise: true` returns the realpath form.
 * The cockpit's key needs the canonical form; the ledger and the heartbeat
 * print the path they resolve, so they keep the spelling. The probe itself
 * always works from the realpath, so a symlinked `.git` and the checkout it
 * serves agree on the shape.
 *
 * A path that does not resolve is not a failure: the caller gets back the
 * uncanonicalised path.
 *
 * Throws WorkspaceProbeFailed only when the step-2 probe could not run to an
 * answer.
 */
export function resolveWorkspace(gitCommonDir, cwd = process.cwd(), { canonicalise = false, timeoutMs } = {}) {
  const common = String(gitCommonDir ?? "").trim();
  if (!common) return null;
  const spelled = resolve(cwd, common);
  const real = canonicalPath(spelled);
  const parentDir = () => (canonicalise ? dirname(real) : dirname(spelled));
  if (basename(real) === ".git") return { dir: parentDir(), gitDir: false };
  if (parentGitDirNames(dirname(real), real, cwd, timeoutMs)) return { dir: parentDir(), gitDir: false };
  return { dir: canonicalise ? real : spelled, gitDir: true };
}

/** `resolveWorkspace()`'s directory, without its shape. Same rule, same throw. */
export function workspaceDirFromGitCommonDir(gitCommonDir, cwd = process.cwd(), options = {}) {
  return resolveWorkspace(gitCommonDir, cwd, options)?.dir ?? null;
}
