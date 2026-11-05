#!/usr/bin/env node
// A measuring copy as one command: the tree an agent mutates, runs a suite in
// or reproduces a failure in, built at a pinned commit with the Install step
// already run in it. Every copy a fix-applier, a fix-applier's refuter, a
// review specialist or a review refuter measures in is built by this script,
// so each is a repository of its own (the root sweep evicts only a directory
// that holds a `.git` of its own) and each has what the Install step leaves.
//
//   measure-copy.mjs --worktree <abs> --pin <sha> --dest <abs> --pr <N> --scratch <abs>
//
// `--worktree` is the PR's worktree: git runs there, and every worktree of that
// repository shares its refs and Recipe cache, which a copy of tracked files
// holds none of — so the Install step is read from it, never from the copy or
// from a review snapshot. `--pin` is the full 40-hex commit to copy. `--dest`
// is the copy: a new directory inside a `fix-*` round root or a `run-*` run
// root that sits directly under `<scratch>/pr<N>/`. `--scratch` is the absolute
// scratch root the dispatch prompt names. Reached through the Resolver:
// `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run measure-copy.mjs ...`.
//
// In order, each step only once every earlier one held:
//
//   1 The destination. It is written down from `--scratch` as
//     `<scratch>/pr<N>/<root>/…/<dest>` (`<scratch>` as given or by realpath),
//     `<root>` a directory named `fix-…` or `run-…` that is there, and it has no
//     `.` or `..` segment; nothing from `<scratch>` down to the destination that
//     exists may be a symlink; and nothing may exist at the destination itself,
//     a dangling symlink or an empty directory included. Anything else builds
//     nothing.
//   2 `git -C <worktree> archive <pin> | tar -x -C <dest>`, then `git init`,
//     `git add -A -f` and a commit. The commit's tree must be the pin's tree.
//   3 The Install step, by evict.mjs's `installIn()`: read from the worktree
//     with `derive-testcmd.sh <worktree> install --at origin/main`, run from the
//     copy's root through `sh -c` with `CI` unset, no timeout, under no suite
//     slot, a clean `git status --porcelain -uall` required before it. What the
//     step leaves untracked afterwards is reported, never refused.
//
// Stdout is one JSON line, the receipt, whatever happened after the arguments
// parsed:
//
//   {dest, pr, pin, head, tree, install, kind, exit, untracked, untrackedCount, message}
//
// dest            the path the copy was, or would have been, built at
// head            the copy's commit, null when never read
// tree            the copy's commit tree, null when never read
// install         the Install step's command, null when never read
// kind            `built`, or what stopped it: `outside`, `occupied`,
//                 `unreadable`, `pin-unreadable`, `archive-failed`, `init-failed`,
//                 `tree-mismatch`, or one of evict.mjs's `installIn()` kinds:
//                 `derive`, `status-before`, `dirty-before`, `not-run`,
//                 `failed`, `status-after`
// exit            the Install step's own exit status, null when it produced none
// untracked       the first 20 lines of `git status --porcelain -uall` in the
//                 copy after the Install step, null when it was never read
// untrackedCount  how many lines there are in all
// message         null when built, else the refusal in words
//
// Exit vocabulary:
//
//   0  built: the copy is the pin's tree and its Install step exited 0
//   1  no usable copy, nothing the Install step did: a destination outside a
//      round root or run root, or one that exists; an archive, an init or a
//      commit that failed; a tree that is not the pin's; a Recipe that could
//      not be read; a status that could not be read before the Install step
//   2  a refusal on stderr with no receipt: a usage refusal, as in every other
//      script, or a receipt that could not be written to stdout
//   3  the Install step did not run: exit 126 or 127, or it could not be started
//   4  the Install step failed: another non-zero exit, or a signal
//   5  the Install step ran and the copy's state could not be read after it
//
// Any non-zero exit leaves the copy where it stands: this script removes
// nothing.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { defineFlags, isDigits, makeDie, writeAll } from "./arg.mjs";
import { how } from "./evict-mark.mjs";
import { installIn } from "./evict.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "measure-copy";
const die = makeDie(NAME);
const USAGE = "usage: measure-copy.mjs --worktree <abs> --pin <sha> --dest <abs> --pr <N> --scratch <abs>";
const SHA = /^[0-9a-f]{40}$/;
const ROOT = /^(?:fix|run)-./;
const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The installIn() refusal kinds an Install step that ran or tried to run
// answers for; every other refusal is exit 1.
const EXIT = {
  "not-run": 3,
  failed: 4,
  "status-after": 5,
};

const git = (dir, args) =>
  spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(), timeout: GIT_TIMEOUT_MS });

/**
 * Why `dest` is not a place this script builds, as `{kind, message}`, or null
 * when it is. `scratch` and `pr` are the arguments; no path is created or
 * changed.
 */
export function destRefusal(dest, scratch, pr) {
  const outside = (message) => ({ kind: "outside", message });
  if (dest.split(sep).some((s) => s === "." || s === "..")) return outside(`${dest} has a '.' or '..' segment`);
  const bases = [resolve(scratch)];
  try {
    bases.push(realpathSync(scratch));
  } catch (e) {
    return { kind: "unreadable", message: `cannot resolve --scratch ${scratch} (${e.code ?? e.message})` };
  }
  const base = bases.find((b) => dest.startsWith(join(b, `pr${pr}`) + sep));
  if (base === undefined) return outside(`${dest} is not inside <scratch>/pr${pr}/ (${scratch})`);
  const parts = dest.slice(join(base, `pr${pr}`).length + 1).split(sep);
  if (parts.some((s) => s === "")) return outside(`${dest} has an empty segment`);
  if (parts.length < 2 || !ROOT.test(parts[0])) {
    return outside(`${dest} is not inside a fix-* round root or a run-* run root directly under ${join(base, `pr${pr}`)}`);
  }
  let at = base;
  for (const [i, part] of [`pr${pr}`, ...parts].entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch (e) {
      if (e.code !== "ENOENT") return { kind: "unreadable", message: `cannot look at ${at} (${e.code ?? e.message})` };
      // The round root or run root is made before any copy: a missing one is
      // a typo, not a place to create. Below it, nothing exists to refuse.
      return i <= 1 ? outside(`${at} does not exist — make the round root or run root before the copy`) : null;
    }
    // Anything at the destination, a symlink included, is an occupied path.
    if (at === dest) return { kind: "occupied", message: `${dest} already exists — a copy built over it would not be the pin's` };
    if (st.isSymbolicLink()) return outside(`${at} is a symlink`);
    if (!st.isDirectory()) return outside(`${at} is not a directory`);
  }
  return null;
}

function main() {
  const { arg, sweep, stray } = defineFlags(die, {
    flags: { worktree: "value", pin: "value", dest: "value", pr: "value", scratch: "value" },
  });
  // The sweep runs before the required-flag check so a misspelled flag is
  // named as that, not buried under a missing-flag usage line.
  sweep();
  stray();
  const worktree = arg("worktree");
  const pinArg = arg("pin");
  const destArg = arg("dest");
  const pr = arg("pr");
  const scratchArg = arg("scratch");
  if ([worktree, pinArg, destArg, pr, scratchArg].includes(null)) die(USAGE);
  if (!isAbsolute(worktree)) die(`--worktree needs an absolute path, got ${worktree}`);
  if (!isAbsolute(destArg)) die(`--dest needs an absolute path, got ${destArg}`);
  if (!isAbsolute(scratchArg)) die(`--scratch needs an absolute path, got ${scratchArg}`);
  const pin = pinArg.toLowerCase();
  if (!SHA.test(pin)) die(`--pin needs a full 40-character commit SHA, got ${pinArg}`);
  if (!isDigits(pr) || Number(pr) < 1) die(`--pr needs a PR number, got ${pr}`);

  // Only a trailing slash is forgiven; every other oddity is a refusal below.
  const dest = destArg.length > 1 ? destArg.replace(/\/+$/, "") : destArg;
  const receipt = { dest, pr: Number(pr), pin, head: null, tree: null, install: null, kind: null, exit: null, untracked: null, untrackedCount: null, message: null };
  const finish = (code, kind, message = null) => {
    receipt.kind = kind;
    receipt.message = message;
    // A receipt lost on its way to stdout must not leave its exit standing: an
    // exit 0 with no receipt names no copy to work in, so a lost write is the
    // no-receipt exit.
    if (!writeAll(1, `${JSON.stringify(receipt)}\n`)) die("the receipt could not be written to stdout");
    process.exitCode = code;
  };

  // 1: the destination.
  const refusal = destRefusal(dest, scratchArg, pr);
  if (refusal !== null) return finish(1, refusal.kind, refusal.message);

  // 2: the copy, at the pin, as its own repository. The pin's tree is read
  // first: a pin the worktree does not hold builds nothing, and the comparison
  // at the end is against what git says the pin is, never against the copy.
  const want = git(worktree, ["rev-parse", "--verify", "--end-of-options", `${pin}^{tree}`]);
  const wanted = String(want.stdout ?? "").trim();
  if (want.error || want.status !== 0 || wanted === "") return finish(1, "pin-unreadable", `could not read the tree of ${pin} in ${worktree} (${how(want)})`);
  try {
    mkdirSync(dest, { recursive: true });
  } catch (e) {
    return finish(1, "unreadable", `cannot make ${dest} (${e.code ?? e.message})`);
  }
  const archived = spawnSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", worktree, pin, dest], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: gitEnv(),
  });
  if (archived.error || archived.status !== 0) return finish(1, "archive-failed", `git -C ${worktree} archive ${pin} | tar -x -C ${dest} failed (${how(archived)})`);
  const made = [
    ["init", "-q"],
    ["add", "-A", "-f"],
    ["-c", "user.name=fleet", "-c", "user.email=fleet@invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", `measuring copy of ${pin}`],
  ];
  for (const args of made) {
    const step = git(dest, args);
    if (step.error || step.status !== 0) return finish(1, "init-failed", `git ${args.filter((a) => a !== "-c" && !a.includes("=")).join(" ")} failed in ${dest} (${how(step)})`);
  }
  const head = git(dest, ["rev-parse", "HEAD", "HEAD^{tree}"]);
  const [at, tree] = String(head.stdout ?? "").trim().split("\n");
  if (head.error || head.status !== 0 || !at || !tree) return finish(1, "init-failed", `could not read HEAD in ${dest} (${how(head)})`);
  receipt.head = at;
  receipt.tree = tree;
  if (tree !== wanted) return finish(1, "tree-mismatch", `the copy's tree ${tree} is not the tree ${wanted} of ${pin}`);

  // 3: the Install step, read from the worktree, run in the copy. No retry in a
  // dirty-before refusal: the caller runs none of this script's steps by hand
  // to get past one.
  const done = installIn(dest, true, { verb: "install", retry: false, source: worktree, untracked: true });
  if (done.refusal) {
    const { kind, message, install, exit } = done.refusal;
    receipt.install = install;
    receipt.exit = exit;
    return finish(EXIT[kind] ?? 1, kind, message);
  }
  receipt.install = done.install;
  receipt.exit = 0;
  receipt.untracked = done.untracked.first;
  receipt.untrackedCount = done.untracked.count;
  finish(0, "built");
}

if (isCLI(import.meta.url)) main();
