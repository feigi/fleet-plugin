// controller-alarm.mjs: the pure gate, then the extension exercised the way omp
// runs it — the factory is handed a stand-in `pi`, `session_start` a stand-in
// `ctx`, and the timer callback `ctx.setInterval` was given is called by hand.
// The fixture is a real repository (the `.fleet/` path is resolved through real
// git) and a temp HOME, so the alarm file lands in the test's own directory.
// No omp boots here.
//
// Zero deps: `node --test tests/controller-alarm.test.mjs`.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { fleetFile } from "../plugin/scripts/fleet-dir.mjs";
import controllerAlarm, { alarmDue, ALARM_LINE, POLL_MS } from "../plugin/scripts/controller-alarm.mjs";

const NOW = 2_000_000_000_000;
const INTERVAL = 600;
const BEAT = { at: NOW - INTERVAL * 1000, interval: INTERVAL, stopped: "" };
const PASSING = { kind: "main", pid: 4242, controller: { pid: 4242 }, beat: BEAT, idle: true, now: NOW, firedFor: null };
const due = (over) => alarmDue({ ...PASSING, ...over });

// ── alarmDue ────────────────────────────────────────────────────────────────

test("alarmDue: an idle main session whose controller beat has fallen due fires", () => {
  assert.equal(due({}), true);
});

test("alarmDue: each gate condition negated alone does not fire", () => {
  assert.equal(due({ idle: false }), false, "busy");
  assert.equal(due({ kind: "sub" }), false, "a subagent");
  assert.equal(due({ controller: { pid: 4243 } }), false, "another session's pid");
  assert.equal(due({ controller: null }), false, "no controller recorded");
  assert.equal(due({ beat: null }), false, "no beat recorded");
  assert.equal(due({ beat: { ...BEAT, stopped: "run drained" } }), false, "a stopped beat");
});

test("alarmDue: an absent pid never matches an absent controller", () => {
  assert.equal(due({ pid: undefined, controller: null }), false);
  assert.equal(due({ pid: undefined, controller: {} }), false);
});

test("alarmDue: the due boundary is inclusive at beat.at + interval and not before", () => {
  const dueAt = BEAT.at + INTERVAL * 1000;
  assert.equal(due({ now: dueAt }), true);
  assert.equal(due({ now: dueAt - 1 }), false);
});

test("alarmDue: a fire for this beat blocks until one interval after it, an older beat's fire does not", () => {
  assert.equal(due({ firedFor: { at: BEAT.at, firedAt: NOW - 1000 } }), false, "covered");
  assert.equal(due({ firedFor: { at: BEAT.at - 1, firedAt: NOW - 1000 } }), true, "a fire for an older beat");
  assert.equal(due({ firedFor: { at: BEAT.at, firedAt: NOW - INTERVAL * 1000 + 1 } }), false, "one ms inside the interval");
  assert.equal(due({ firedFor: { at: BEAT.at, firedAt: NOW - INTERVAL * 1000 } }), true, "exactly one interval later");
});

test("alarmDue: a controller idle the moment its beat falls due, whose `stopped` is the empty string, is accepted", () => {
  const beat = { at: NOW - INTERVAL * 1000, interval: INTERVAL, stopped: "" };
  assert.equal(alarmDue({ kind: "main", pid: 7, controller: { pid: 7, lstart: "x" }, beat, idle: true, now: beat.at + INTERVAL * 1000, firedFor: null }), true);
  assert.equal(alarmDue({ kind: "main", pid: 7, controller: { pid: 7 }, beat: { ...beat, stopped: null }, idle: true, now: NOW, firedFor: null }), true, "null reads as empty too");
});

// ── The extension ───────────────────────────────────────────────────────────

const BASE = mkdtempSync(join(tmpdir(), "controller-alarm-"));
after(() => rmSync(BASE, { recursive: true, force: true }));

const ENV = gitEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });
const REPO = join(realpathSync(BASE), "repo");
mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: REPO, env: ENV });
const FLEET = join(REPO, ".fleet");
mkdirSync(FLEET, { recursive: true });
const BEAT_FILE = join(FLEET, "heartbeat.json");

/** A per-test HOME, and a process table that knows this process's start time (or does not). */
function world(t, { lstart = "Mon Oct 19 10:00:00 2026" } = {}) {
  const home = mkdtempSync(join(BASE, "home-"));
  const table = join(home, "proc-table.json");
  writeFileSync(table, JSON.stringify(lstart === null ? {} : { [process.pid]: { ppid: 1, argv: ["omp"], lstart } }));
  const saved = { HOME: process.env.HOME, FLEET_PROC_TABLE: process.env.FLEET_PROC_TABLE };
  process.env.HOME = home;
  process.env.FLEET_PROC_TABLE = table;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { home, alarmFile: join(home, ".fleet", "alarm", `${process.pid}.json`) };
}

/** The stand-in session: records timers, messages, and the order they happened in. */
function session({ kind = "main", cwd = REPO, idle = true, send } = {}) {
  const log = [];
  const state = { idle, timers: [], sent: [] };
  const handlers = {};
  const pi = {
    on: (event, fn) => { handlers[event] = fn; },
    sendUserMessage: (...args) => { state.sent.push(args); log.push("send"); return send?.(...args); },
  };
  const ctx = {
    cwd,
    agent: { kind },
    isIdle: () => state.idle,
    setInterval: (fn, ms) => { state.timers.push({ fn, ms }); log.push("setInterval"); return state.timers.length; },
  };
  controllerAlarm(pi);
  return { state, log, ctx, start: () => handlers.session_start({}, ctx) };
}

const writeBeat = (record) => writeFileSync(BEAT_FILE, JSON.stringify(record));
const dueRecord = (over = {}) => ({
  controller: { pid: process.pid, lstart: "x", prior: "none", at: 1 },
  beat: { at: Date.now() - 3_600_000, interval: 60, stopped: "" },
  ...over,
});

test("extension: a main session in a repository sets the timer, then writes {pid, lstart, fleet}", async (t) => {
  const w = world(t);
  const s = session();
  await s.start();
  assert.deepEqual(s.log, ["setInterval"]);
  assert.equal(s.state.timers[0].ms, POLL_MS);
  assert.equal(POLL_MS, 30_000);
  assert.deepEqual(JSON.parse(readFileSync(w.alarmFile, "utf8")), { pid: process.pid, lstart: "Mon Oct 19 10:00:00 2026", fleet: fleetFile(null, { cwd: REPO }) });
  assert.equal(fleetFile(null, { cwd: REPO }), FLEET);
});

test("extension: the file is written only after setInterval was called", async (t) => {
  const w = world(t);
  const s = session();
  s.ctx.setInterval = (fn, ms) => {
    assert.equal(existsSync(w.alarmFile), false, "no file while the timer is being set");
    s.state.timers.push({ fn, ms });
    return 1;
  };
  await s.start();
  assert.equal(s.state.timers.length, 1);
  assert.equal(existsSync(w.alarmFile), true);
});

test("extension: a subagent session sets no timer and writes no alarm file", async (t) => {
  const w = world(t);
  const s = session({ kind: "sub" });
  await s.start();
  assert.deepEqual(s.state.timers, []);
  assert.equal(existsSync(w.alarmFile), false);
});

test("extension: a cwd outside any git repository sets no timer and writes no alarm file", async (t) => {
  const w = world(t);
  const s = session({ cwd: join(BASE, "no-such-dir") });
  await s.start();
  assert.deepEqual(s.state.timers, []);
  assert.equal(existsSync(w.alarmFile), false);
});

test("extension: a git that cannot run is FleetDirUnresolvable too: no timer, no file", async (t) => {
  const w = world(t);
  const empty = mkdtempSync(join(BASE, "nopath-"));
  const savedPath = process.env.PATH;
  process.env.PATH = empty;
  t.after(() => { process.env.PATH = savedPath; });
  const s = session();
  await s.start();
  assert.deepEqual(s.state.timers, []);
  assert.equal(existsSync(w.alarmFile), false);
});

test("extension: a start time that cannot be read writes no file, though the timer is set", async (t) => {
  for (const lstart of [null, ""]) {
    const w = world(t, { lstart });
    const s = session();
    await s.start();
    assert.equal(s.state.timers.length, 1, `lstart ${JSON.stringify(lstart)}`);
    assert.equal(existsSync(w.alarmFile), false, `lstart ${JSON.stringify(lstart)}`);
  }
});

test("extension: an unreadable process table writes no file and throws nothing", async (t) => {
  const w = world(t);
  process.env.FLEET_PROC_TABLE = join(w.home, "no-such-table.json");
  const s = session();
  await s.start();
  assert.equal(s.state.timers.length, 1);
  assert.equal(existsSync(w.alarmFile), false);
});

test("extension: session_start arms once; a second one sets no second timer", async (t) => {
  world(t);
  const s = session();
  await s.start();
  await s.start();
  assert.equal(s.state.timers.length, 1);
});

test("extension: a due poll sends the one-line message once, with no second argument", async (t) => {
  world(t);
  writeBeat(dueRecord());
  const s = session();
  await s.start();
  s.state.timers[0].fn();
  assert.deepEqual(s.state.sent, [["[fleet-alarm] run ~/.fleet/bin/fleet-run fleet-event.mjs heartbeat"]]);
  assert.equal(ALARM_LINE, s.state.sent[0][0]);
  s.state.timers[0].fn();
  assert.equal(s.state.sent.length, 1, "the same beat, inside its interval, is not fired again");
});

test("extension: a busy poll sends nothing, a later idle poll does", async (t) => {
  world(t);
  writeBeat(dueRecord());
  const s = session({ idle: false });
  await s.start();
  s.state.timers[0].fn();
  assert.deepEqual(s.state.sent, []);
  s.state.idle = true;
  s.state.timers[0].fn();
  assert.equal(s.state.sent.length, 1);
});

test("extension: another session's controller pid, a stopped beat, and a beat not yet due send nothing", async (t) => {
  world(t);
  const s = session();
  await s.start();
  const poll = s.state.timers[0].fn;
  writeBeat(dueRecord({ controller: { pid: process.pid + 1, lstart: "x", prior: "none", at: 1 } }));
  poll();
  writeBeat(dueRecord({ beat: { at: Date.now() - 3_600_000, interval: 60, stopped: "run drained" } }));
  poll();
  writeBeat(dueRecord({ beat: { at: Date.now(), interval: 600, stopped: "" } }));
  poll();
  assert.deepEqual(s.state.sent, []);
});

test("extension: a poll that cannot read the file is not due and writes nothing to stderr", async (t) => {
  world(t);
  const s = session();
  await s.start();
  const lines = [];
  const err = console.error;
  console.error = (m) => lines.push(m);
  t.after(() => { console.error = err; });
  const poll = s.state.timers[0].fn;
  rmSync(BEAT_FILE, { force: true });
  poll();
  writeFileSync(BEAT_FILE, "{not json");
  poll();
  writeFileSync(BEAT_FILE, "[]");
  poll();
  writeFileSync(BEAT_FILE, JSON.stringify({ controller: { pid: "x" } }));
  poll();
  rmSync(BEAT_FILE, { force: true });
  mkdirSync(BEAT_FILE);
  t.after(() => rmSync(BEAT_FILE, { recursive: true, force: true }));
  poll();
  assert.deepEqual(s.state.sent, []);
  assert.deepEqual(lines, []);
});

test("extension: a throwing idle probe, a throwing send and a rejecting send never escape the poll", async (t) => {
  world(t);
  writeBeat(dueRecord());
  const throwingIdle = session();
  throwingIdle.ctx.isIdle = () => { throw new Error("session gone"); };
  await throwingIdle.start();
  assert.doesNotThrow(() => throwingIdle.state.timers[0].fn());

  const throwingSend = session({ send: () => { throw new Error("send failed"); } });
  await throwingSend.start();
  assert.doesNotThrow(() => throwingSend.state.timers[0].fn());

  const rejectingSend = session({ send: () => Promise.reject(new Error("send failed")) });
  await rejectingSend.start();
  assert.doesNotThrow(() => rejectingSend.state.timers[0].fn());
  await new Promise((resolve) => setImmediate(resolve));
});
