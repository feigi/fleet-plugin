#!/usr/bin/env node
// A host-wide bound on concurrent FULL test-suite runs.
//
//   suite-slot.mjs '<entrypoint>' [args…]
//
// Runs `sh -c '<entrypoint> "$@"' suite-slot args…` — the entrypoint is a shell
// COMMAND, so a compound one (`cd sub && make test`) keeps its meaning and the
// caller's own arguments land after it, argv-preserved: a path with a space or
// a shell metacharacter in it reaches the entrypoint as one word, never
// re-split by a shell.
//
// Which runs take a slot is decided by ARITY, never by what the entrypoint is:
//   - no appended arguments: the full suite. It takes one of N slots, waiting
//     for one if all are held.
//   - appended arguments: a narrowed run. It takes no slot and queues behind
//     nothing, so a verifier's narrowed run never waits on a full one.
//   - FLEET_SUITE_SLOT already set: an enclosing wrapper holds a slot and
//     exported its lock path, so this call is nested inside it. It runs
//     straight through, arguments and all, and takes no second slot — a
//     wrapped command inside a wrapped command is one run, not a deadlock.
//
// A slot is `<home>/.fleet/suite-slots/<i>.lock` for `i` in 1..N: a
// pid-stamped O_EXCL lock, the very primitive the ledger's write lock is
// (pid-lock.mjs owns the protocol, the dead-holder takeover included). Under
// the home directory rather than a workspace's `.fleet/` because the bound is
// host-wide and a review's snapshot is no repository. The holder stamps its own
// pid and releases on exit; a holder killed without releasing is taken over by
// the next waiter, so a SIGKILLed wrapper never wedges a slot. The takeover
// does not stop the dead holder's test run, so a wrapper killed with SIGKILL
// alone leaves its run going uncounted and the host over its bound until that
// run ends; stop a wrapper with SIGTERM, which it forwards to the run before
// releasing its slot. What the takeover cannot clear — an empty or partial
// lock whose writer died before stamping its pid, and a leftover
// `<i>.lock.reap` — is named on the way out of an expired wait, for the
// operator to remove by hand once nothing is running.
//
// Environment:
//   FLEET_SUITE_SLOTS   number of slots N, a positive integer. Default 2.
//   FLEET_SUITE_WAIT_S  seconds to wait for a slot, a non-negative integer.
//                       Default 1800. Waiting never counts against the run.
//   FLEET_SUITE_SLOT    set by the holder for its child; see re-entry above.
//   HOME                where `.fleet/suite-slots/` lives.
//
// Exit status: the entrypoint's own, with a child killed by signal N read as
// 128+N. 2 is a refusal of this script's own (usage, a malformed variable, a
// slot directory it cannot create); 75 is an expired wait, having launched
// nothing, with `suite-slot: no slot after <n>s` on stderr. On acquisition it
// prints `SUITE_SLOT_WAIT_MS=<n>` to stderr — the milliseconds the wait took,
// a few at most when a slot was free.
//
// A waiter cycles the slots every 2 s. While the entrypoint runs, SIGTERM,
// SIGINT and SIGHUP are forwarded to it and the wrapper exits when it does.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import { makeDie, isFlagLike, isDigits, writeAll } from "./arg.mjs";
import { attemptLock, releaseLockFile, reapPathOf } from "./pid-lock.mjs";

const NAME = "suite-slot";
const die = makeDie(NAME);

const DEFAULT_SLOTS = 2;
const DEFAULT_WAIT_S = 1800;
const CYCLE_MS = 2000;
const EXIT_NO_SLOT = 75;
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"];

const [entrypoint, ...args] = process.argv.slice(2);
if (entrypoint === undefined || isFlagLike(entrypoint)) {
  const why = entrypoint === undefined || entrypoint.trim() === "" ? "no entrypoint given" : `${JSON.stringify(entrypoint)} is a flag, not an entrypoint`;
  die(`usage: suite-slot.mjs '<entrypoint>' [args…] — ${why}`);
}

// An unset variable takes the default; a set one must be a whole number in
// range. A malformed value is refused rather than defaulted: this bound is the
// host's protection, and a typo that quietly widens it or hangs the wait is
// worse than a run that did not start.
function intEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!isDigits(raw) || Number(raw) < min) {
    die(`${name} must be an integer of at least ${min}, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

// Where a signal goes: the running child once there is one, otherwise nowhere
// — the wrapper holds nothing yet, so it simply ends.
let signalTarget = null;
for (const sig of FORWARDED) {
  process.on(sig, () => {
    if (signalTarget) signalTarget.kill(sig);
    else process.exit(128 + osConstants.signals[sig]);
  });
}

// The entrypoint, run to completion with the caller's streams. Resolves to the
// status the wrapper should exit with. Asynchronous on purpose: a blocking
// spawn holds the event loop, so the signal handlers could not run until the
// child had already finished.
function run(env) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `${entrypoint} "$@"`, NAME, ...args], { stdio: "inherit", env });
    signalTarget = child;
    child.on("error", (e) => die(`cannot run ${JSON.stringify(entrypoint)}: ${e.message}`));
    child.on("close", (code, signal) => resolve(signal ? 128 + osConstants.signals[signal] : code));
  });
}

if (process.env.FLEET_SUITE_SLOT !== undefined || args.length > 0) {
  process.exit(await run(process.env));
}

const slots = intEnv("FLEET_SUITE_SLOTS", DEFAULT_SLOTS, 1);
const waitMs = intEnv("FLEET_SUITE_WAIT_S", DEFAULT_WAIT_S, 0) * 1000;
const dir = join(homedir(), ".fleet", "suite-slots");
try {
  mkdirSync(dir, { recursive: true });
} catch (e) {
  die(`cannot create ${dir}: ${e.message}`);
}
const lockOf = (i) => join(dir, `${i}.lock`);

// One pass over the slots. The first one taken is returned as its path; a
// slot whose holder vanished or was reaped is tried once more at once, and
// counts as busy for this pass if it keeps changing under us — the next pass
// is 2 s away, so a path that never settles cannot spin. `held` collects what
// each busy slot answered, for the message an expired wait leaves behind.
function pass(held) {
  held.length = 0;
  for (let i = 1; i <= slots; i++) {
    let seen = null;
    for (let tries = 0; tries < 2; tries++) {
      seen = attemptLock(lockOf(i), die);
      if (seen.state === "taken") return lockOf(i);
      if (seen.state === "held") break;
    }
    held.push({ lock: lockOf(i), ...seen });
  }
  return null;
}

// What an operator needs to act on a wait that expired. A live holder needs
// nothing — the host is simply at its bound — so only the two wedges the
// takeover cannot clear are named.
function wedges(held) {
  const lines = [];
  for (const h of held) {
    if (h.state !== "held") continue;
    if (h.pid === null) {
      lines.push(`${h.lock} holds ${JSON.stringify(h.holder)}, not a pid, so it is never taken over — if nothing is running, remove it by hand`);
    } else if (h.dead) {
      lines.push(`${h.lock} is held by dead pid ${h.pid}; ${reapPathOf(h.lock)} is blocking its takeover — if nothing is running, remove it by hand`);
    }
  }
  return lines;
}

const started = Date.now();
const held = [];
let slotPath = pass(held);
while (slotPath === null) {
  const left = waitMs - (Date.now() - started);
  if (left <= 0) {
    const detail = wedges(held).map((l) => `\n${NAME}: ${l}`).join("");
    writeAll(2, `${NAME}: no slot after ${waitMs / 1000}s${detail}\n`);
    process.exit(EXIT_NO_SLOT);
  }
  await new Promise((r) => setTimeout(r, Math.min(CYCLE_MS, left)));
  slotPath = pass(held);
}
process.on("exit", () => releaseLockFile(slotPath));
writeAll(2, `SUITE_SLOT_WAIT_MS=${Date.now() - started}\n`);

process.exit(await run({ ...process.env, FLEET_SUITE_SLOT: slotPath }));
