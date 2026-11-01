#!/usr/bin/env node
// The finisher's verification tree as one command: the detached worktree duty 2
// runs the acceptance mutation in, with the Install step already run in it, so
// the suite can start on a consumer whose dependencies are untracked.
//
//   finisher-tree.mjs --worktree <abs> --pin <sha> --pr <N> --member <name> --scratch <abs>
//
// `--worktree` is the path the finisher was dispatched with: git runs there, and
// every worktree of that repository shares its refs and Recipe cache. `--pin` is
// the full 40-hex head it was dispatched against. `--scratch` is the absolute
// scratch root the dispatch prompt names. The tree is
// `<scratch>/pr<N>/finish-<member>`: the member name is in the path because the
// scratch root is shared with every sibling, so `pr<N>` alone collides whenever
// a PR gets a second finisher. Reached through the Resolver:
// `~/.fleet/bin/fleet-run finisher-tree.mjs ...`.
//
// In order, each step only once every earlier one held:
//
//   1 The path. Anything already at it - a tree, a file, an empty directory -
//     fails closed: git alone would accept an empty directory, and a tree
//     built over somebody's leftover is not the pin's.
//   2 `git worktree add --detach <tree> <pin>`, then `HEAD` read back: it must
//     equal the pin, never the PR's pushed tip.
//   3 The Install step, by evict.mjs's `installIn()`: read with
//     `derive-testcmd.sh <tree> install --at origin/main`, run in the tree
//     through `sh -c` with `CI` unset, no timeout, under no suite slot, with a
//     clean `git status --porcelain -uall` required before it and after it. 126
//     or 127 is a Recipe that no longer runs, any other non-zero exit a failed
//     install, and a change to the tree an Install step that changed it.
//
// Stdout is one JSON line, the receipt, whatever happened after the arguments
// parsed:
//
//   {tree, member, pr, pin, head, install, kind, exit, message}
//
// tree     the path the tree was, or would have been, built at
// head     `git -C <tree> rev-parse HEAD`, null when never read
// install  the Install step's command, null when never read
// kind     `installed`, or what stopped the build: `occupied`, `unreadable`,
//          `add-failed`, `head-unreadable`, `head-mismatch`, or one of
//          evict.mjs's `installIn()` kinds: `derive`, `status-before`,
//          `dirty-before`, `not-run`, `failed`, `status-after`, `dirtied`
// exit     the Install step's own exit status, null when it produced none
// message  null when installed, else the refusal in words
//
// Exit vocabulary, each its own code so the receipt's `kind` is not needed to
// tell the three install failures apart:
//
//   0  installed and clean: the tree is at the pin with its dependencies in it
//   1  no usable tree, nothing the Install step did: an occupied path, a failed
//      add, a head that is not the pin, a Recipe that could not be read, a
//      status that could not be read before the Install step, or a tree dirty
//      before it
//   2  a refusal on stderr with no receipt: a usage refusal, as in every other
//      script, or a receipt that could not be written to stdout
//   3  the Install step did not run: exit 126 or 127, or it could not be started
//   4  the Install step failed: another non-zero exit, or a signal
//   5  the Install step ran and left the tree changed, or left its state
//      unreadable
//
// Any non-zero exit leaves the tree where it stands, and the finisher removes
// it with `git worktree remove --force` on every path as it always did: this
// script removes nothing. Where the exit is 1 on an occupied path, nothing was
// built at all.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineFlags, makeDie, writeAll } from "./arg.mjs";
import { how } from "./evict-mark.mjs";
import { installIn } from "./evict.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "finisher-tree";
const die = makeDie(NAME);
const USAGE = "usage: finisher-tree.mjs --worktree <abs> --pin <sha> --pr <N> --member <name> --scratch <abs>";
const SHA = /^[0-9a-f]{40}$/;
// A member name is one path segment: dispatch names (`finisher-pr-12`,
// `finisher-pr-12-b`) and nothing that could climb out of `pr<N>/`. The
// alphanumeric first character is what rules out `.` and `..`.
const MEMBER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The installIn() refusal kinds an Install step that ran or tried to run
// answers for; every other refusal is exit 1.
const EXIT = {
  "not-run": 3,
  failed: 4,
  "status-after": 5,
  dirtied: 5,
};

const git = (dir, args) =>
  spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(), timeout: GIT_TIMEOUT_MS });

function main() {
  const { arg, sweep, stray } = defineFlags(die, {
    flags: { worktree: "value", pin: "value", pr: "value", member: "value", scratch: "value" },
  });
  // The sweep runs before the required-flag check so a misspelled flag is
  // named as that, not buried under a missing-flag usage line.
  sweep();
  stray();
  const worktree = arg("worktree");
  const pinArg = arg("pin");
  const pr = arg("pr");
  const member = arg("member");
  const scratch = arg("scratch");
  if ([worktree, pinArg, pr, member, scratch].includes(null)) die(USAGE);
  if (!isAbsolute(worktree)) die(`--worktree needs an absolute path, got ${worktree}`);
  if (!isAbsolute(scratch)) die(`--scratch needs an absolute path, got ${scratch}`);
  const pin = pinArg.toLowerCase();
  if (!SHA.test(pin)) die(`--pin needs a full 40-character commit SHA, got ${pinArg}`);
  if (!/^[1-9][0-9]*$/.test(pr)) die(`--pr needs a PR number, got ${pr}`);
  if (!MEMBER.test(member)) die(`--member needs one path segment of letters, digits, '.', '_' and '-', got ${JSON.stringify(member)}`);

  const tree = join(scratch, `pr${pr}`, `finish-${member}`);
  const receipt = { tree, member, pr: Number(pr), pin, head: null, install: null, kind: null, exit: null, message: null };
  const finish = (code, kind, message = null) => {
    receipt.kind = kind;
    receipt.message = message;
    // A receipt lost on its way to stdout must not leave its exit standing: an
    // exit 0 with no receipt names no tree to work in, so a lost write is the
    // no-receipt exit.
    if (!writeAll(1, `${JSON.stringify(receipt)}\n`)) die("the receipt could not be written to stdout");
    process.exitCode = code;
  };

  // 1: the path. An entry of any kind, a dangling symlink included, is an
  // occupied path; only ENOENT is free.
  try {
    lstatSync(tree);
    return finish(1, "occupied", `${tree} already exists — a tree built over it would not be the pin's`);
  } catch (e) {
    if (e.code !== "ENOENT") return finish(1, "unreadable", `cannot look at ${tree} (${e.code ?? e.message})`);
  }

  // 2: the tree, at the pin.
  const added = git(worktree, ["worktree", "add", "--detach", tree, pin]);
  if (added.error || added.status !== 0) return finish(1, "add-failed", `git worktree add --detach ${tree} ${pin} failed (${how(added)})`);
  const head = git(tree, ["rev-parse", "HEAD"]);
  const at = String(head.stdout ?? "").trim();
  if (head.error || head.status !== 0 || at === "") return finish(1, "head-unreadable", `could not read HEAD in ${tree} (${how(head)})`);
  receipt.head = at;
  if (at !== pin) return finish(1, "head-mismatch", `HEAD in ${tree} is ${at}, not the pin ${pin}`);

  // 3: the Install step. No retry in a dirty-before refusal: the finisher runs
  // none of this script's steps by hand to get past one.
  const done = installIn(tree, true, { verb: "install", retry: false });
  if (done.refusal) {
    const { kind, message, install, exit } = done.refusal;
    receipt.install = install;
    receipt.exit = exit;
    return finish(EXIT[kind] ?? 1, kind, message);
  }
  receipt.install = done.install;
  receipt.exit = 0;
  finish(0, "installed");
}

if (isCLI(import.meta.url)) main();
