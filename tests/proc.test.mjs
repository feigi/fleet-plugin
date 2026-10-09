// proc.mjs: the one liveness predicate, and the process tree and start times
// the controller record is judged by. The real `ps` source is measured here
// on whatever platform runs the suite — macOS locally, Linux in CI — because
// a start time compared as an opaque string is only as good as `ps` printing
// the same string for the same process every time it is asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDead, processSource, ancestry, controllerOf, judgeController, ProcUnreadable } from "../plugin/scripts/proc.mjs";

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("isDead: only a process that is gone is dead", () => {
  assert.equal(isDead(process.pid), false);
  assert.equal(isDead(deadPid()), true);
  // pid 1 is never ours to signal: EPERM, which is a live process.
  assert.equal(isDead(1), false);
});

test("the ledger lock and the controller record share proc.mjs's isDead, never a copy", () => {
  const ledger = readFileSync(fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url)), "utf8");
  assert.match(ledger, /^import \{[^}]*\bisDead\b[^}]*\} from "\.\/proc\.mjs";$/m);
  assert.doesNotMatch(ledger, /function isDead\b/);
  // Positive control: the pattern finds a definition where one exists.
  assert.match(readFileSync(fileURLToPath(new URL("../plugin/scripts/proc.mjs", import.meta.url)), "utf8"), /function isDead\b/);
});

test("ps: a live process's start time is a non-empty string, the same on every read and under every caller's TZ and locale", () => {
  const plain = processSource().startTime(process.pid);
  assert.equal(typeof plain, "string");
  assert.notEqual(plain, "");
  assert.equal(processSource().startTime(process.pid), plain);
  // Twenty-four hours apart: an unpinned zone prints a different date.
  const east = processSource({ ...process.env, TZ: "Pacific/Kiritimati" }).startTime(process.pid);
  const west = processSource({ ...process.env, TZ: "Pacific/Pago_Pago" }).startTime(process.pid);
  assert.equal(east, plain);
  assert.equal(west, plain);
  // Measured on macOS: a German locale prints `Fr.  9 Okt.` for `Fri Oct  9`.
  const german = processSource({ ...process.env, LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" }).startTime(process.pid);
  assert.equal(german, plain);
});

test("ps: a gone process has no start time", () => {
  assert.equal(processSource().startTime(deadPid()), null);
});

test("ps: two processes started apart have different start times", async (t) => {
  const first = processSource().startTime(process.pid);
  await new Promise((r) => setTimeout(r, 1100));
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  assert.notEqual(processSource().startTime(child.pid), first);
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
    const source = processSource({ ...process.env, PATH: dir });
    assert.throws(() => source.startTime(process.pid), ProcUnreadable);
    assert.throws(() => source.parentOf(process.pid), ProcUnreadable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
