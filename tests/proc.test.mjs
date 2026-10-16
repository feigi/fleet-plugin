// proc.mjs: the one liveness predicate, and the process tree and start
// identities the controller record is judged by. A start identity is compared
// as an opaque string, so it is only as good as the reader giving the same
// string for the same process every time it is asked, and a different one for
// a reused pid. Both readers are measured here on whatever platform runs the
// suite: `ps` everywhere, procfs against a fake root everywhere and against
// the real /proc on Linux. The real-system tests go through processSource(),
// so CI's Linux and macOS jobs each measure the reader their platform uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDead, processSource, psSource, procfsStartTime, ancestry, controllerOf, judgeController, ProcUnreadable } from "../plugin/scripts/proc.mjs";

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("isDead: only a process that is gone is dead", () => {
  assert.equal(isDead(process.pid), false);
  assert.equal(isDead(deadPid()), true);
  // pid 1 is never ours to signal: EPERM, which is a live process.
  assert.equal(isDead(1), false);
});

test("the ledger lock, the suite slots and the controller record share proc.mjs's isDead, never a copy", () => {
  const script = (name) => readFileSync(fileURLToPath(new URL(`../plugin/scripts/${name}`, import.meta.url)), "utf8");
  // The ledger and the slot wrapper take their locks through pid-lock.mjs, which
  // is the one place that asks whether a holder is dead — through proc.mjs.
  assert.match(script("pid-lock.mjs"), /^import \{[^}]*\bisDead\b[^}]*\} from "\.\/proc\.mjs";$/m);
  for (const name of ["pid-lock.mjs", "ledger.mjs", "suite-slot.mjs"]) {
    assert.doesNotMatch(script(name), /function isDead\b|function isProcessDead\b/, `${name} carries its own liveness predicate`);
  }
  for (const name of ["ledger.mjs", "suite-slot.mjs"]) {
    assert.match(script(name), /^import \{[^}]*\} from "\.\/pid-lock\.mjs";$/m, `${name} takes its lock by a copy, not through pid-lock.mjs`);
  }
  // Positive control: the pattern finds a definition where one exists.
  assert.match(script("proc.mjs"), /function isDead\b/);
});

test("ps: a live process's start time is a non-empty string, the same on every read and under every caller's TZ and locale", () => {
  const plain = psSource(process.env).startTime(process.pid);
  assert.equal(typeof plain, "string");
  assert.notEqual(plain, "");
  assert.equal(psSource(process.env).startTime(process.pid), plain);
  // Twenty-four hours apart: an unpinned zone prints a different date.
  const east = psSource({ ...process.env, TZ: "Pacific/Kiritimati" }).startTime(process.pid);
  const west = psSource({ ...process.env, TZ: "Pacific/Pago_Pago" }).startTime(process.pid);
  assert.equal(east, plain);
  assert.equal(west, plain);
  // Measured on macOS: a German locale prints `Fr.  9 Okt.` for `Fri Oct  9`.
  const german = psSource({ ...process.env, LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" }).startTime(process.pid);
  assert.equal(german, plain);
});

test("ps: a gone process has no start time", () => {
  assert.equal(psSource(process.env).startTime(deadPid()), null);
});

test("processSource: a live process's start identity is a non-empty string, the same on every read", () => {
  const first = processSource().startTime(process.pid);
  assert.equal(typeof first, "string");
  assert.notEqual(first, "");
  assert.equal(processSource().startTime(process.pid), first);
});

test("processSource: a gone process has no start identity", () => {
  assert.equal(processSource().startTime(deadPid()), null);
});

test("processSource reads the start identity from procfs on Linux and from ps on every other platform", () => {
  const linux = process.platform === "linux";
  const expected = linux ? procfsStartTime(process.pid) : psSource(process.env).startTime(process.pid);
  assert.equal(processSource().startTime(process.pid), expected);
  if (linux) assert.match(expected, /^[0-9a-f-]{36} \d+$/);
});

// `ps -o lstart=` prints whole seconds, so the second process starts more than
// a second after the first.
test("two processes started apart have different start identities, from ps and from processSource()", async (t) => {
  const ps = psSource(process.env);
  const first = { ps: ps.startTime(process.pid), source: processSource().startTime(process.pid) };
  await new Promise((r) => setTimeout(r, 1100));
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  assert.notEqual(ps.startTime(child.pid), first.ps);
  const second = processSource().startTime(child.pid);
  assert.equal(typeof second, "string");
  assert.notEqual(second, first.source);
});

test("ps: the ancestry starts at the caller's parent and walks up through each parent", (t) => {
  const source = processSource();
  const chain = ancestry(source);
  assert.equal(chain[0].pid, process.ppid);
  assert.ok(chain.every((e) => Array.isArray(e.argv) && e.argv.length > 0 && e.argv[0] !== ""), JSON.stringify(chain));
  for (let i = 1; i < chain.length; i++) assert.equal(source.parentOf(chain[i - 1].pid).ppid, chain[i].pid);

  // A child's own chain names this process, with its argv split.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { processSource, ancestry } from ${JSON.stringify(new URL("../plugin/scripts/proc.mjs", import.meta.url).href)};
    console.log(JSON.stringify(ancestry(processSource())[0]));
  `], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parent = JSON.parse(r.stdout);
  assert.equal(parent.pid, process.pid);
  assert.equal(parent.argv[0].split("/").pop(), process.execPath.split("/").pop());
});

test("ps: an unrunnable ps is unreadable, never an empty tree or a gone process", () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-nops-"));
  try {
    assert.throws(() => psSource({ ...process.env, PATH: dir }).startTime(process.pid), ProcUnreadable);
    // The process tree is read by `ps` on every platform.
    assert.throws(() => processSource({ ...process.env, PATH: dir }).parentOf(process.pid), ProcUnreadable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A `ps` that runs and fails is a `ps` that did not answer — not a gone
// process and not an empty tree. Only exit 1 with nothing on either stream is
// `ps` selecting no process.
function stubPs(t, status, { stdout = "", stderr = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "proc-stubps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const echo = (text, fd) => (text === "" ? "" : `echo '${text}'${fd}\n`);
  writeFileSync(join(dir, "ps"), `#!/bin/sh\n${echo(stdout, "")}${echo(stderr, " >&2")}exit ${status}\n`, { mode: 0o755 });
  return psSource({ ...process.env, PATH: dir });
}

test("ps: exit 1 with nothing printed is a gone process; any other answer is unreadable", (t) => {
  assert.equal(stubPs(t, 1).startTime(1), null);
  assert.throws(() => stubPs(t, 2).startTime(1), ProcUnreadable);
  assert.throws(() => stubPs(t, 1, { stderr: "ps: boom" }).startTime(1), ProcUnreadable);
  assert.throws(() => stubPs(t, 1, { stdout: "x" }).startTime(1), ProcUnreadable);
  assert.throws(() => stubPs(t, 0).startTime(1), ProcUnreadable);
  assert.equal(stubPs(t, 0, { stdout: "Mon Jan  1 00:00:00 2024" }).startTime(1), "Mon Jan  1 00:00:00 2024");
});

test("ps: a failing process listing is unreadable, never an empty tree", (t) => {
  assert.throws(() => stubPs(t, 1).parentOf(1), ProcUnreadable);
  assert.throws(() => stubPs(t, 2, { stderr: "ps: boom" }).parentOf(1), ProcUnreadable);
  assert.deepEqual(stubPs(t, 0, { stdout: "  1     0 /sbin/init" }).parentOf(1), { ppid: 0, argv: ["/sbin/init"] });
});

// A fake procfs root: `boot_id` unless it is null, and a `<pid>/stat` for
// each entry of `stats`.
function fakeProc(t, { bootId = "0b3c9e4a-6f1d-4e2b-9a7c-5d8e1f2a3b4c", stats = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "proc-fakeroot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (bootId !== null) {
    mkdirSync(join(root, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(join(root, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
  }
  for (const [pid, line] of Object.entries(stats)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "stat"), line);
  }
  return root;
}

// A /proc/<pid>/stat line whose field 22 is `ticks`. Its neighbours are
// numbers of their own, so a parse off by a field reads a different one.
const statLine = (pid, comm, ticks) =>
  `${pid} (${comm}) S 1 41 41 0 -1 4194560 113 0 0 0 7 3 0 0 20 0 1 0 ${ticks} 987654 321 18446744073709551615\n`;

test("procfs: the start identity is the boot id and field 22, counted after the last `)` of comm", (t) => {
  const root = fakeProc(t, { stats: { 42: statLine(42, "a) b (c", 2084), 43: statLine(43, "sleep", 3347) } });
  assert.equal(procfsStartTime(42, root), "0b3c9e4a-6f1d-4e2b-9a7c-5d8e1f2a3b4c 2084");
  assert.equal(procfsStartTime(43, root), "0b3c9e4a-6f1d-4e2b-9a7c-5d8e1f2a3b4c 3347");
});

test("procfs: a pid with no stat file is a gone process", (t) => {
  assert.equal(procfsStartTime(42, fakeProc(t)), null);
});

test("procfs: a missing or blank boot id is unreadable, never a gone process or a ps fallback", (t) => {
  assert.throws(() => procfsStartTime(42, fakeProc(t, { bootId: null, stats: { 42: statLine(42, "sleep", 2084) } })), ProcUnreadable);
  assert.throws(() => procfsStartTime(42, fakeProc(t, { bootId: null })), ProcUnreadable);
  assert.throws(() => procfsStartTime(42, fakeProc(t, { bootId: "  ", stats: { 42: statLine(42, "sleep", 2084) } })), ProcUnreadable);
});

test("procfs: a stat file that cannot be read or parsed is unreadable", (t) => {
  for (const line of ["", "42 (sleep S 1 41", "42 (sleep) S 1 41 41 0", statLine(42, "sleep", "x")]) {
    assert.throws(() => procfsStartTime(42, fakeProc(t, { stats: { 42: line } })), ProcUnreadable, JSON.stringify(line));
  }
  const root = fakeProc(t);
  mkdirSync(join(root, "42", "stat"), { recursive: true });
  assert.throws(() => procfsStartTime(42, root), ProcUnreadable);
});

test("procfs: the same start ticks under another boot id are another process", (t) => {
  const stats = { 42: statLine(42, "sleep", 2084) };
  const before = procfsStartTime(42, fakeProc(t, { stats }));
  const after = procfsStartTime(42, fakeProc(t, { bootId: "7e1d2c3b-4a5f-4e6d-8c7b-9a0f1e2d3c4b", stats }));
  assert.notEqual(after, before);
});

function tableFile(t, table) {
  const dir = mkdtempSync(join(tmpdir(), "proc-table-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "table.json");
  writeFileSync(path, typeof table === "string" ? table : JSON.stringify(table));
  return path;
}

test("FLEET_PROC_TABLE replaces ps whole; an unreadable table is unreadable", (t) => {
  const path = tableFile(t, { 10: { ppid: 20, argv: ["node", "x"], lstart: "a" }, 20: { ppid: 1, argv: ["bun", "/b/omp"], lstart: "b" } });
  const source = processSource({ FLEET_PROC_TABLE: path });
  assert.deepEqual(ancestry(source, 10), [{ pid: 10, argv: ["node", "x"] }, { pid: 20, argv: ["bun", "/b/omp"] }]);
  assert.equal(source.startTime(20), "b");
  assert.equal(source.startTime(30), null);
  assert.throws(() => processSource({ FLEET_PROC_TABLE: tableFile(t, "{not json") }), ProcUnreadable);
  assert.throws(() => processSource({ FLEET_PROC_TABLE: join(tmpdir(), "no-such-proc-table.json") }), ProcUnreadable);
});

test("FLEET_PROC_TABLE of any other shape is unreadable, never a crash or an empty table", (t) => {
  for (const table of ["null", "5", "[]", '"x"', '{"1":7}', '{"1":{"argv":["a"]}}', '{"1":{"ppid":"x","argv":["a"]}}', '{"1":{"ppid":1}}', '{"1":{"ppid":1,"argv":"bun omp"}}', '{"1":{"ppid":1,"argv":[5]}}', '{"1":{"ppid":1,"argv":["a"],"lstart":5}}']) {
    assert.throws(() => processSource({ FLEET_PROC_TABLE: tableFile(t, table) }), ProcUnreadable, table);
  }
});

test("ancestry stops on a cycle rather than looping", (t) => {
  const source = processSource({ FLEET_PROC_TABLE: tableFile(t, { 10: { ppid: 20, argv: ["a"] }, 20: { ppid: 10, argv: ["b"] } }) });
  assert.deepEqual(ancestry(source, 10).map((e) => e.pid), [10, 20]);
});

test("controllerOf: the nearest omp; none is null", (t) => {
  const source = processSource({ FLEET_PROC_TABLE: tableFile(t, {
    10: { ppid: 20, argv: ["sh", "-c", "omp"], lstart: "a" },
    20: { ppid: 30, argv: ["/usr/local/bin/omp"], lstart: "b" },
    30: { ppid: 1, argv: ["bun", "/home/u/.bun/bin/omp"], lstart: "c" },
  }) });
  assert.deepEqual(controllerOf(source, ancestry(source, 10)), { pid: 20, lstart: "b" });
  assert.deepEqual(controllerOf(source, ancestry(source, 30)), { pid: 30, lstart: "c" });
  assert.equal(controllerOf(source, ancestry(source, 10).slice(0, 1)), null);
});

test("controllerOf: an omp whose start time the source cannot give is no record", (t) => {
  const source = processSource({ FLEET_PROC_TABLE: tableFile(t, { 10: { ppid: 20, argv: ["sh"], lstart: "a" }, 20: { ppid: 1, argv: ["bun", "/b/omp"] } }) });
  assert.equal(controllerOf(source, ancestry(source, 10)), null);
});

test("judgeController: none, dead, reused, ancestor, alive", (t) => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const source = processSource({ FLEET_PROC_TABLE: tableFile(t, {
    [process.pid]: { ppid: 1, argv: ["node"], lstart: "me" },
    [child.pid]: { ppid: 1, argv: ["sleep"], lstart: "child" },
  }) });
  const chain = ancestry(source, process.pid);
  assert.equal(judgeController(null, source, chain), "none");
  assert.equal(judgeController({ pid: deadPid(), lstart: "x" }, source, chain), "dead");
  assert.equal(judgeController({ pid: child.pid, lstart: "earlier" }, source, chain), "dead");
  assert.equal(judgeController({ pid: process.pid, lstart: "me" }, source, chain), "ancestor");
  assert.equal(judgeController({ pid: child.pid, lstart: "child" }, source, chain), "alive");
});
