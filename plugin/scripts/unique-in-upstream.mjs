#!/usr/bin/env node
// What a worktree's HEAD holds that an upstream lacks, as one verdict, so every
// reader that asks "is anything here unpushed or unreviewed?" asks it by the
// same two tests and none of them reads a raw `git cherry` line instead.
// `finisher-audit.mjs` imports `uniqueIn()`; the merge bot runs the command:
//
//   unique-in-upstream.mjs --worktree <path> --upstream <ref>
//
// `--worktree` is the checkout read, `--upstream` the revision HEAD is compared
// with: a branch's remote-tracking ref, or a commit. Reached through the
// Resolver: `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run unique-in-upstream.mjs ...`.
// Nothing is fetched: an `--upstream` the object store lacks fails the read.
//
// Stdout is one JSON line, the verdict:
//
//   {worktree, upstream, listing, merges, content: {tree, conflict, paths}, unique}
//
// listing  `git cherry <upstream> HEAD`, verbatim
// merges   `git rev-list --merges --count <upstream>..HEAD`
// content  the merge-tree read: `tree` is the tree id merging HEAD into
//          `<upstream>` makes, `conflict` a boolean, and `paths` the files where
//          `tree` differs from `<upstream>`'s own tree, none when it is clean
// unique   true when HEAD holds something `<upstream>` lacks
//
// What HEAD holds that `upstream` lacks, by two tests, either of which finds
// it. By patch: `git cherry` prints `+` for a commit whose patch `upstream` does
// not carry, `-` for one it does. It never lists a merge commit, so a merge's
// own content is invisible to it, and a merge in the range counts as unique. By
// content: merging HEAD into `upstream` conflicts or makes a tree other than
// `upstream`'s own. Neither test is enough alone. A patch id ignores line
// numbers and whitespace, so by patch alone a commit that makes `upstream`'s
// change at another place in the file, the same lines around it, or that
// differs from one of its commits by whitespace alone, reads clean though
// `upstream` lacks its content. By content alone, a commit that undoes a change
// `upstream` carries reads clean: merging it in changes nothing, and only its
// `+` line catches it.
//
// `git merge-tree --write-tree` is read by its exit code and the tree id on the
// first line of its stdout. Exit 0 with a tree id is a merge that went through,
// clean or not by the comparison above. Exit 1 with a tree id is a conflict,
// which is a finding, never a failure. Anything else is a failed read: exit 1
// with no tree id (git also exits 1 on a revision it cannot merge), exit 128
// (on unrelated histories, for one), a signal or a spawn error. The merge's
// tree and blob objects are written to the object store; no ref and no file of
// the worktree moves.
//
// Exit vocabulary:
//
//   0  a verdict: read `unique`, which is true or false. Never an exit code for
//      it, so a caller that only reads the exit status cannot take "something
//      unique" for a failure of the read.
//   2  no verdict: a usage refusal, or a read that failed. A failed read prints
//      `{worktree, upstream, error}` on stdout, `error` naming the call, and the
//      same line on stderr. It is never a clean answer.

import { spawnSync } from "node:child_process";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "unique-in-upstream";
// One git child's stdout: far past spawnSync's 1 MiB default for a merge that
// changes many paths.
const BUFFER = 256 * 1024 * 1024;
// The tree id `git merge-tree --write-tree` prints first.
const TREE_ID = /^[0-9a-f]{40}$/;

// A read that could not be made: a call that did not run, was killed, or
// exited with a status that is not an answer. The message names the step and
// the git call, and is what a caller reports.
export class UniqueReadError extends Error {}

// What HEAD of `worktree` holds that `upstream` lacks: `{listing, merges,
// content, unique}`. Throws `UniqueReadError` for any read that could not be
// made - an `upstream` the object store lacks, a merge that could not be read -
// so a failed read is never a clean verdict. `env` is the environment of every
// git child: the ambient one with GIT_DIR and GIT_WORK_TREE scrubbed when
// omitted.
export function uniqueIn(worktree, upstream, { env = gitEnv() } = {}) {
  // A git call inside the worktree. A call that could not run, was killed or
  // exited non-zero throws, unless the caller asked to read the failure itself
  // (`soft`), which then carries the exit status and the stdout the call left.
  const git = (step, args, { soft = false } = {}) => {
    const r = spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8", env, maxBuffer: BUFFER });
    if (r.error || r.signal || r.status !== 0) {
      if (soft) return { ok: false, status: r.status, out: r.stdout ?? "", error: (r.error?.message ?? r.stderr ?? "").trim() || `exit ${r.status ?? r.signal}` };
      const why = r.error?.message ?? (r.signal ? `killed by ${r.signal}` : (r.stderr ?? "").trim() || `exit ${r.status}`);
      throw new UniqueReadError(`${step}: git ${args.join(" ")} failed: ${why}`);
    }
    return { ok: true, out: r.stdout, error: null };
  };

  const listing = git("cherry", ["cherry", upstream, "HEAD"]).out;
  const merges = Number(git("merges", ["rev-list", "--merges", "--count", `${upstream}..HEAD`]).out.trim());

  // Exit 1 with no tree id is git refusing a revision it cannot merge, so the
  // exit code alone cannot tell a conflict from it.
  const mergeArgs = ["merge-tree", "--write-tree", upstream, "HEAD"];
  const merge = git("merge-tree", mergeArgs, { soft: true });
  const tree = merge.out.split("\n")[0];
  if (!TREE_ID.test(tree) || (!merge.ok && merge.status !== 1)) {
    throw new UniqueReadError(`merge-tree: git ${mergeArgs.join(" ")} failed: ${merge.error ?? "no tree id on stdout"}`);
  }
  const paths = git("paths", ["diff-tree", "-r", "--name-only", "-z", `${upstream}^{tree}`, tree]).out.split("\0").filter((p) => p !== "");
  const content = { tree, conflict: !merge.ok, paths };

  const unique = merges > 0 || listing.split("\n").some((l) => l.startsWith("+")) || content.conflict || content.paths.length > 0;
  return { listing, merges, content, unique };
}

function main() {
  const die = makeDie(NAME);
  const { arg, sweep, stray } = defineFlags(die, { flags: { worktree: "value", upstream: "value" } });
  // The sweep runs before the required-flag check so a misspelled flag is named
  // as that, not buried under a missing-flag usage line.
  sweep();
  stray();
  const worktree = arg("worktree");
  const upstream = arg("upstream");
  if (worktree === null || upstream === null) die("usage: unique-in-upstream.mjs --worktree <path> --upstream <ref>");
  try {
    const verdict = uniqueIn(worktree, upstream);
    writeAll(1, `${JSON.stringify({ worktree, upstream, ...verdict })}\n`);
    process.exit(0);
  } catch (e) {
    if (!(e instanceof UniqueReadError)) throw e;
    writeAll(1, `${JSON.stringify({ worktree, upstream, error: e.message })}\n`);
    die(e.message);
  }
}

if (isCLI(import.meta.url)) main();
