// pid-lock.mjs: the lock primitive the ledger's write lock and the suite slots
// share. What the ledger and the wrapper each do WITH it is pinned in their own
// suites (ledger.test.mjs, suite-slot.test.mjs); this file holds what one
// attempt answers, the shape both callers branch on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { attemptLock, releaseLockFile, reapPathOf } from "../plugin/scripts/pid-lock.mjs";

const die = (msg) => {
  throw new Error(msg);
};
const lockIn = () => join(tempDir("pid-lock-"), "x.lock");
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("a free lock is taken and stamped with this process's pid, and released only by its owner", () => {
  const lock = lockIn();
  assert.deepEqual(attemptLock(lock, die), { state: "taken" });
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  releaseLockFile(lock);
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, String(process.pid + 1));
  releaseLockFile(lock);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid + 1), "released a lock another pid holds");
});

test("a lock a live process holds is held, and is read as such", () => {
  const lock = lockIn();
  writeFileSync(lock, String(process.pid));
  assert.deepEqual(attemptLock(lock, die), { state: "held", holder: String(process.pid), pid: process.pid, dead: false });
});

test("an empty or unparseable lock is held by no pid and never taken over", () => {
  for (const text of ["", "12x", "0", "-5", " 7"]) {
    const lock = lockIn();
    writeFileSync(lock, text);
    assert.deepEqual(attemptLock(lock, die), { state: "held", holder: text, pid: null, dead: false }, JSON.stringify(text));
    assert.equal(readFileSync(lock, "utf8"), text);
  }
});

test("a dead holder's lock is reaped, and the next attempt takes it", () => {
  const lock = lockIn();
  const dead = deadPid();
  writeFileSync(lock, String(dead));
  assert.deepEqual(attemptLock(lock, die), { state: "reaped" });
  assert.equal(existsSync(reapPathOf(lock)), false, "the takeover left its reap lock behind");
  assert.deepEqual(attemptLock(lock, die), { state: "taken" });
});

test("a dead holder is left alone while another waiter holds the reap lock", () => {
  const lock = lockIn();
  const dead = deadPid();
  writeFileSync(lock, String(dead));
  writeFileSync(reapPathOf(lock), "");
  assert.deepEqual(attemptLock(lock, die), { state: "held", holder: String(dead), pid: dead, dead: true });
  assert.equal(readFileSync(lock, "utf8"), String(dead));
});
