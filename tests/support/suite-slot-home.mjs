// A throwaway host for any test that runs something reaching the suite slots.
//
// The slots live under the running user's `~/.fleet/suite-slots/`, and a live
// fleet run on the same machine is using that directory. A test that took,
// waited on or removed a lock there would hold up — or free — a real run's
// suite, so nothing in the suite may reach it: every test that runs
// suite-slot.mjs, or anything that execs it (a claim's runner, the review's
// test-run block, this repository's `agent-test`), builds its environment from
// `slotHome()`, whose HOME is a fresh directory of its own. The default the
// wrapper resolves is HOME-relative, so that is the whole of the isolation, and
// `slotHome()` refuses to hand back a directory that is the real one.
//
// The Package entry is laid into that home too —
// `~/.omp/plugins/node_modules/@feigi/fleet-ctl`, pointing at this checkout's
// `plugin/` — because the runner a claim writes and the review's block both
// reach the wrapper through the Resolver under it.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./temp-dir.mjs";

export const PLUGIN = join(import.meta.dirname, "..", "..", "plugin");
export const SUITE_SLOT = join(PLUGIN, "scripts", "suite-slot.mjs");

// Every module suite-slot.mjs reaches, for a fixture that runs a wrapper from
// its own copy of a checkout (`agent-test` looks for it beside itself).
const WRAPPER_FILES = ["suite-slot.mjs", "arg.mjs", "pid-lock.mjs", "proc.mjs"];

// Variables a test run inherits that would change what a wrapper does: an
// enclosing slot holder's marker makes every wrapper a nested one, and the
// others override the bound under test. `node --test` marks the processes it
// spawns, and an inherited mark makes a nested `node --test` report to a parent
// that is not listening — status 0 and not a byte of stdout — and FORCE_COLOR
// SGR-wraps its summary even into a pipe.
const SCRUBBED = ["FLEET_SUITE_SLOT", "FLEET_SUITE_SLOTS", "FLEET_SUITE_WAIT_S", "NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "FORCE_COLOR"];

export function slotHome() {
  const home = tempDir("slot-home-");
  if (realpathSync(home) === realpathSync(homedir())) {
    throw new Error("slotHome: the fixture home is the real home — refusing, a test must never touch the real ~/.fleet");
  }
  const slots = join(home, ".fleet", "suite-slots");
  mkdirSync(join(home, ".fleet"));
  const linked = join(home, ".omp", "plugins", "node_modules", "@feigi");
  mkdirSync(linked, { recursive: true });
  symlinkSync(PLUGIN, join(linked, "fleet-ctl"));
  return {
    home,
    slots,
    lock: (i) => join(slots, `${i}.lock`),
    // A run's environment: this process's, with HOME pointed at the fixture
    // and the inherited wrapper state scrubbed, then `extra` on top.
    env: (extra = {}) => {
      const env = { ...process.env, HOME: home };
      for (const k of SCRUBBED) delete env[k];
      return { ...env, ...extra };
    },
  };
}

// Takes slots `1..n` for a holder that is alive for as long as this test
// process is: its own pid.
export function holdSlots(host, n, pid = process.pid) {
  mkdirSync(host.slots, { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(host.lock(i), String(pid));
}

// A pid that was a process a moment ago and is not one now.
export function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

// Copies the wrapper and the modules it imports into `<dir>/plugin/scripts/`,
// where `agent-test` looks for the wrapper relative to itself.
export function installWrapper(dir) {
  const scripts = join(dir, "plugin", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const f of WRAPPER_FILES) copyFileSync(join(PLUGIN, "scripts", f), join(scripts, f));
}
