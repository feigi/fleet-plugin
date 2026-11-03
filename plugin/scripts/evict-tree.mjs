// What an Evict removes from a git tree, and the one removal sequence every
// removal here and in Reclaim goes through. evict.mjs (a claim tree),
// reclaim-scratch.mjs (a review run's snapshot and copies, in its `--pr` pass)
// and review-core.mjs (the same trees, when a review ends) all import it; a
// module of its own so none of the three loads another's CLI, and so the
// enumeration of "every path git ignores" is written once.
//
// IGNORED PATHS. `ignoredPaths(tree)` is every path `git ls-files --others
// --ignored --exclude-standard --directory` lists in the tree, but the
// `agent-test` runner: a directory is listed whole, once, and nothing inside
// one already listed. Tracked files, the tree's .git and untracked files git
// does not ignore are not in it.
//
// A TREE, for `evictTrees(root)`, is a directory that holds `.git` at its own
// top level and whose `git rev-parse --show-toplevel` resolves, by realpath,
// to that same directory. A directory that resolves to an enclosing repository
// — one with no `.git` of its own, or with one git cannot read — is never
// stripped, and git is never asked about a directory with no `.git`. The walk
// goes down from `root` at any depth and never follows a symlink, never enters
// a `.git`, and never enters a path it removes (or, in a dry run, would
// remove) as ignored, so a repository inside `node_modules` goes with that
// directory and is not a tree of its own.
//
// No status check, no mark, no restore: a tree is evicted whatever `git status`
// says. A claim tree's status check and its mark are evict.mjs's own.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { how } from "./evict-mark.mjs";
import { gitEnv } from "./git-env.mjs";

export const RUNNER = "agent-test";
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The one removal sequence. `$1` is the entry. A symlink entry is unlinked
// before anything else runs, so no chmod or chflags ever sees it: whether a
// recursive chmod dereferences a link given as its operand differs between
// BSD and GNU, and either would change the mode or flags of a target outside
// the entry being removed. Links met inside a directory are left to `rm`,
// which unlinks them without following. `chmod -R` fails
// on a flagged directory, and `chflags -R` cannot read a mode-000 directory it
// has just unflagged, so when the first pass fails each directory's flag and
// mode come off together, top-down, before anything inside it is read.
const REMOVE = [
  'd=$1',
  'if [ -L "$d" ]; then rm -f "$d"; exit $?; fi',
  'chmod -R u+rwx "$d" 2>/dev/null; m=$?',
  'if command -v chflags >/dev/null 2>&1; then',
  '  [ $m -eq 0 ] || { chflags nouchg,nouappnd "$d"; chmod u+rwx "$d"; find "$d" -type d -exec chflags nouchg,nouappnd {} ";" -exec chmod u+rwx {} ";"; } 2>/dev/null',
  '  chflags -R nouchg,nouappnd "$d" 2>/dev/null',
  'fi',
  'rm -rf "$d"',
].join("\n");

/** Remove `path` through REMOVE; null on success, else the reason. */
export function removeEntry(path) {
  const r = spawnSync("sh", ["-c", REMOVE, "sh", path], { encoding: "utf8" });
  return r.error || r.status !== 0 ? how(r) : null;
}

const git = (tree, args) =>
  spawnSync("git", ["-C", tree, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(), timeout: GIT_TIMEOUT_MS });

/** Every path the tree ignores, relative to it, but the runner; throws what git cannot answer. */
export function ignoredPaths(tree) {
  const r = git(tree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (r.error || r.status !== 0) throw new Error(`git ls-files --ignored failed (${how(r)})`);
  const out = [];
  for (const p of r.stdout.split("\0").filter(Boolean).sort()) {
    const bare = p.replace(/\/$/, "");
    if (bare === RUNNER) continue;
    if (out.some((q) => q.endsWith("/") && p.startsWith(q))) continue;
    out.push(p);
  }
  return out;
}

/** Remove each of `ignored` (relative to `tree`); null, or every error in one string. */
export function removeIgnored(tree, ignored) {
  const errors = [];
  for (const p of ignored) {
    const error = removeEntry(join(tree, p.replace(/\/$/, "")));
    if (error !== null) errors.push(`${p}: ${error}`);
  }
  return errors.length ? `could not remove ${errors.join("; ")}` : null;
}

// Whether `dir` is a tree: a `.git` of its own, and git answering for this
// directory rather than for an enclosing repository.
function isTree(dir) {
  try {
    lstatSync(join(dir, ".git"));
  } catch {
    return false;
  }
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.error || r.status !== 0) return false;
  try {
    return realpathSync(r.stdout.replace(/\n$/, "")) === realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * Evict every tree under `root`, `root` itself included: `{evicted, failed}`.
 * `evicted` is `[{path, ignored}]` for each tree that held ignored paths — in a
 * dry run, what `apply` would remove — and a tree holding none is in neither.
 * `failed` is `[{path, error}]`: a tree whose ignored paths cannot be listed or
 * all removed, or a directory whose listing fails for any reason but its being
 * gone, not a directory, or unreadable. Best-effort: the walk goes on.
 */
export function evictTrees(root, { apply }) {
  const evicted = [];
  const failed = [];
  const skip = new Set();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (isTree(dir)) {
      let ignored;
      try {
        ignored = ignoredPaths(dir);
      } catch (e) {
        failed.push({ path: dir, error: e.message });
        continue;
      }
      for (const p of ignored) skip.add(join(dir, p.replace(/\/$/, "")));
      if (ignored.length > 0) {
        const error = apply ? removeIgnored(dir, ignored) : null;
        if (error === null) evicted.push({ path: dir, ignored });
        else failed.push({ path: dir, error });
      }
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // A directory the walk cannot list or search holds no tree it can reach:
      // skipped, as freshUnder() skips one it cannot read, and never a failure.
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(e.code)) failed.push({ path: dir, error: `cannot list it (${e.code ?? e.message})` });
      continue;
    }
    for (const e of entries) {
      if (e.name === ".git" || !e.isDirectory()) continue;
      const path = join(dir, e.name);
      if (!skip.has(path)) stack.push(path);
    }
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { evicted: evicted.sort(byPath), failed: failed.sort(byPath) };
}
