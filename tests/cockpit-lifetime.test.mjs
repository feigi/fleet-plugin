// The cockpit lives as long as the controller its run recorded (#3875): armed
// the first time the Controller record in the heartbeat file judges alive,
// stopped by the first tick after that which judges it dead, re-read every
// tick, and never moved by a drain or by a file or process table it cannot
// read.
//
// Two layers. cockpit-lifetime.mjs holds the decision as a pure function and
// the read as a thin wrapper over proc.mjs's judgeController, both called
// directly below. The CLI rows then run a REAL `board.mjs serve` against a
// heartbeat file and a FLEET_PROC_TABLE fixture, with a real child process as
// the "controller" so that its death is a death the cockpit's own kill(pid, 0)
// sees — a test run from inside a live omp session must never judge that one.
// A separate file, for the reason cockpit-tick-nonblocking.test.mjs gives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { offlineBoardBin } from "./support/board-rig.mjs";
import { cockpitLifetime, controllerVerdict } from "../plugin/scripts/cockpit-lifetime.mjs";
import { processSource } from "../plugin/scripts/proc.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/board.mjs", import.meta.url));

// --- the decision, as a pure function -----------------------------------------

test("cockpitLifetime: a live controller arms the cockpit and keeps it serving", () => {
  for (const verdict of ["alive", "ancestor"]) {
    assert.deepEqual(cockpitLifetime(false, verdict), { armed: true, exit: false }, verdict);
    assert.deepEqual(cockpitLifetime(true, verdict), { armed: true, exit: false }, verdict);
  }
});

test("cockpitLifetime: a dead controller ends an armed cockpit and nothing else", () => {
  assert.deepEqual(cockpitLifetime(true, "dead"), { armed: true, exit: true });
  // A hand launch between runs finds the last run's record: no exit, and it
  // stays unarmed.
  assert.deepEqual(cockpitLifetime(false, "dead"), { armed: false, exit: false });
});

test("cockpitLifetime: no verdict neither arms nor ends, whichever way the cockpit stood", () => {
  assert.deepEqual(cockpitLifetime(false, null), { armed: false, exit: false });
  assert.deepEqual(cockpitLifetime(true, null), { armed: true, exit: false });
});

// --- the read ------------------------------------------------------------------

const table = (entries) => {
  const path = join(tempDir("cockpit-lifetime-table-"), "procs.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
};
const sourceOf = (path) => () => processSource({ FLEET_PROC_TABLE: path });

test("controllerVerdict: the pid + start-time test — alive, a different start time, and a pid that is gone", async () => {
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => gone.on("exit", resolve));
  const path = table({
    [process.pid]: { ppid: 1, argv: ["bun", "/x/omp"], lstart: "start-A" },
    [gone.pid]: { ppid: 1, argv: ["bun", "/x/omp"], lstart: "start-A" },
  });
  const source = sourceOf(path);
  assert.equal(controllerVerdict({ pid: process.pid, lstart: "start-A", prior: "none", at: 1 }, source), "alive");
  assert.equal(controllerVerdict({ pid: process.pid, lstart: "start-B", prior: "none", at: 1 }, source), "dead",
    "a live pid with another start time is a reused pid");
  assert.equal(controllerVerdict({ pid: gone.pid, lstart: "start-A", prior: "none", at: 1 }, source), "dead");
});

test("controllerVerdict: no record, and a process table that cannot be read, give no verdict", () => {
  assert.equal(controllerVerdict(null, sourceOf(table({}))), null);
  const told = [];
  const missing = join(tempDir("cockpit-lifetime-missing-"), "no-such-table.json");
  const verdict = controllerVerdict({ pid: process.pid, lstart: "start-A", prior: "none", at: 1 }, sourceOf(missing), (why) => told.push(why));
  assert.equal(verdict, null);
  assert.equal(told.length, 1, "the reason is handed on once");
  assert.match(told[0], /cannot read the process table/);
});

// Only an unreadable table is a non-verdict: any other fault is a bug, and the
// tick's own catch is where it belongs, never a silent "keeps serving".
test("controllerVerdict: a fault that is not an unreadable process table propagates", () => {
  const told = [];
  const fault = new TypeError("not a table fault");
  assert.throws(
    () => controllerVerdict({ pid: process.pid, lstart: "start-A", prior: "none", at: 1 }, () => { throw fault; }, (why) => told.push(why)),
    (e) => e === fault);
  assert.deepEqual(told, [], "a fault that is not an unreadable table is not handed on as one");
});

// --- a real cockpit -------------------------------------------------------------

const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
const exitOf = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.on("exit", resolve)));
async function reap(child) {
  child.kill("SIGKILL");
  await exitOf(child);
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

// One cockpit on its own state directory (the cwd is no git checkout, so that
// is the cwd's `.fleet`), ticking every second, offline: gh and omp fail on
// every call and the reads degrade.
function cockpit() {
  const cwd = realpathSync(tempDir("cockpit-lifetime-cwd-"));
  const bin = offlineBoardBin("cockpit-lifetime-bin-");
  const stateDir = join(cwd, ".fleet");
  mkdirSync(stateDir, { recursive: true });
  const procs = join(tempDir("cockpit-lifetime-procs-"), "procs.json");
  const heartbeat = join(stateDir, "heartbeat.json");
  const jsonPath = join(stateDir, "board.json");
  const rig = {
    jsonPath, children: [], process: null, stderr: "", exit: null,
    // The controller record names `child`, and the process table gives it the
    // start identity the record carries — or, with `lstart`, another one.
    record(child, { lstart = "start-A", beat = null } = {}) {
      writeFileSync(heartbeat, JSON.stringify({
        controller: { pid: child.pid, lstart: "start-A", prior: "none", at: Date.now() },
        ...(beat ? { beat } : {}),
      }));
      rig.table({ [child.pid]: { ppid: 1, argv: ["bun", "/x/omp"], lstart } });
    },
    table(entries) { writeFileSync(procs, JSON.stringify(entries)); },
    corrupt(path) { writeFileSync(path, "{ not json"); },
    heartbeat, procs,
    spawnChild() { const c = sleeper(); rig.children.push(c); return c; },
    start() {
      rig.process = spawn(process.execPath, [SCRIPT, "serve", "--port", "0", "--interval", "1"], {
        cwd, stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HOME: tempDir("cockpit-lifetime-home-"), PATH: `${bin}:${process.env.PATH}`, FLEET_PROC_TABLE: procs },
      });
      rig.process.stderr.on("data", (d) => { rig.stderr += d; });
      rig.exit = new Promise((resolve) => rig.process.on("exit", (code, signal) => resolve({ code, signal })));
    },
    // Resolves once `n` ticks have written a board the caller has not seen,
    // and fails fast, with the cockpit's stderr, if it exits meanwhile.
    async ticks(n) {
      const seen = new Set([readJson(jsonPath)?.generatedAt]);
      const deadline = Date.now() + 40000;
      while (seen.size <= n) {
        if (rig.process.exitCode !== null) throw new Error(`the cockpit exited (${rig.process.exitCode}) while waiting for ${n} ticks: ${rig.stderr}`);
        if (Date.now() > deadline) throw new Error(`${n} ticks did not happen: ${rig.stderr}`);
        const at = readJson(jsonPath)?.generatedAt;
        if (at !== undefined) seen.add(at);
        await new Promise((r) => setTimeout(r, 50));
      }
      // The judgement runs in the same turn as the write that is seen above;
      // this leaves it room before the caller acts on the board.
      await new Promise((r) => setTimeout(r, 250));
    },
    async exits() {
      const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error(`the cockpit did not exit: ${rig.stderr}`)), 25000).unref());
      return Promise.race([rig.exit, deadline]);
    },
    async cleanup() {
      rig.process?.kill("SIGKILL");
      await Promise.all(rig.children.map(reap));
    },
  };
  return rig;
}

test("CLI: an armed cockpit whose controller dies writes its board and exits 0", async () => {
  const rig = cockpit();
  try {
    const controller = rig.spawnChild();
    rig.record(controller);
    rig.start();
    // Two ticks after the first board: the first tick's judgement has armed
    // the cockpit by then, whatever the timing of the kill below.
    await rig.ticks(2);
    // Read just before the kill: the exit tick judges the controller dead, so
    // it runs after the kill and the board it writes is strictly newer than
    // this one. A cockpit that exited before writing would leave this board,
    // unless a tick landed in the instant between this read and the kill.
    const before = readJson(rig.jsonPath)?.generatedAt;
    await reap(controller);
    const { code } = await rig.exits();
    assert.equal(code, 0, rig.stderr);
    assert.match(rig.stderr, /controller of this run \(pid \d+\) is gone/);
    const left = readJson(rig.jsonPath)?.generatedAt;
    assert.ok(typeof before === "number" && left > before,
      `the board it leaves is the exit tick's own: generatedAt ${left}, last seen before the kill ${before}`);
  } finally { await rig.cleanup(); }
});

test("CLI: a pid that is alive with a different start time is a dead controller", async () => {
  const rig = cockpit();
  try {
    const controller = rig.spawnChild();
    rig.record(controller);
    rig.start();
    await rig.ticks(2);
    // The same pid, now another process: the table's start identity moves.
    rig.table({ [controller.pid]: { ppid: 1, argv: ["bun", "/x/omp"], lstart: "start-B" } });
    const { code } = await rig.exits();
    assert.equal(code, 0, rig.stderr);
  } finally { await rig.cleanup(); }
});

test("CLI: a live controller keeps the cockpit serving, drained or not", async () => {
  const rig = cockpit();
  try {
    const controller = rig.spawnChild();
    // A drain: the beat's `stopped` reason is set, and ends nothing.
    rig.record(controller, { beat: { at: Date.now(), interval: 1200, stopped: "queue drained" } });
    rig.start();
    await rig.ticks(3);
    assert.equal(rig.process.exitCode, null, rig.stderr);
  } finally { await rig.cleanup(); }
});

test("CLI: launched while the record names a dead controller, it serves on, then arms on a live one", async () => {
  const rig = cockpit();
  try {
    const old = rig.spawnChild();
    rig.record(old);
    await reap(old);
    rig.start();
    await rig.ticks(3);
    assert.equal(rig.process.exitCode, null, `a hand launch between runs must not exit on the last run's record: ${rig.stderr}`);

    const next = rig.spawnChild();
    rig.record(next);
    await rig.ticks(2);
    assert.equal(rig.process.exitCode, null, rig.stderr);

    await reap(next);
    const { code } = await rig.exits();
    assert.equal(code, 0, rig.stderr);
  } finally { await rig.cleanup(); }
});

test("CLI: an armed cockpit whose record is replaced by a new live controller keeps serving", async () => {
  const rig = cockpit();
  try {
    const first = rig.spawnChild();
    rig.record(first);
    rig.start();
    await rig.ticks(2);

    const second = rig.spawnChild();
    rig.record(second);
    await reap(first);
    await rig.ticks(3);
    assert.equal(rig.process.exitCode, null, `the record is re-read every tick, never latched: ${rig.stderr}`);

    await reap(second);
    const { code } = await rig.exits();
    assert.equal(code, 0, rig.stderr);
  } finally { await rig.cleanup(); }
});

test("CLI: an unreadable heartbeat file or process table is not a death", async () => {
  const rig = cockpit();
  try {
    const controller = rig.spawnChild();
    rig.record(controller);
    rig.start();
    await rig.ticks(2);
    // The controller is about to be gone, but what says so cannot be read. The
    // unreadable file goes first each time: a readable one beside a dead
    // controller is what an armed cockpit exits on. First the process table.
    rig.corrupt(rig.procs);
    await reap(controller);
    await rig.ticks(3);
    assert.equal(rig.process.exitCode, null, rig.stderr);
    // Then the heartbeat file that holds the record, with a process table that
    // reads again and says the controller is gone.
    rig.corrupt(rig.heartbeat);
    rig.table({});
    await rig.ticks(3);
    assert.equal(rig.process.exitCode, null, rig.stderr);
  } finally { await rig.cleanup(); }
});

test("CLI: a process table that cannot be read never arms the cockpit", async () => {
  const rig = cockpit();
  try {
    const controller = rig.spawnChild();
    rig.record(controller);
    rig.corrupt(rig.procs);
    rig.start();
    await rig.ticks(2);
    await reap(controller);
    // The table reads again, and says the controller is gone: a cockpit that a
    // null verdict had armed would exit on this, one that stayed unarmed does
    // not.
    rig.table({});
    await rig.ticks(3);
    assert.equal(rig.process.exitCode, null, rig.stderr);
    assert.match(rig.stderr, /cannot read the process table/);
  } finally { await rig.cleanup(); }
});

test("CLI: a process table that cannot be read is said once per outage, and again after it reads", async () => {
  const rig = cockpit();
  try {
    const said = () => rig.stderr.match(/cannot read the process table/g)?.length ?? 0;
    const controller = rig.spawnChild();
    rig.record(controller);
    rig.corrupt(rig.procs);
    rig.start();
    await rig.ticks(3);
    assert.equal(said(), 1, `one outage, said once over every tick it lasts: ${rig.stderr}`);
    // The table reads again, the controller alive in it, then fails again.
    rig.record(controller);
    await rig.ticks(2);
    rig.corrupt(rig.procs);
    await rig.ticks(3);
    assert.equal(said(), 2, `a second outage is said too: ${rig.stderr}`);
  } finally { await rig.cleanup(); }
});
