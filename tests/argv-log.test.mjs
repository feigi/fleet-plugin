// argv-log.mjs: a stub's argv recorded by recordArgv() reads back whole through
// argvRecords(), and a record the parser can see is out of step throws instead
// of quietly dropping every call after the break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { argvRecords, recordArgv } from "./support/argv-log.mjs";
import { tempDir } from "./support/temp-dir.mjs";

// Runs `calls` — sh words after the recording function's name, one call each —
// under /bin/sh, and returns the record's path.
function record(calls) {
  const log = join(tempDir("argv-log-"), "argv");
  const script = [`f() { ${recordArgv(log)}; }`, ...calls.map((c) => `f ${c}`)].join("\n");
  const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return log;
}

test("each call reads back as its own argv, empty and space-bearing arguments kept whole", () => {
  const log = record([`a "" "b c"`, "", "last"]);
  assert.deepEqual(argvRecords(log), [["a", "", "b c"], [], ["last"]]);
});

test("an argument holding a newline throws at the line read as a count, not a shortened list", () => {
  const log = record(["a", `"x\ny" z`, "last"]);
  assert.throws(() => argvRecords(log), /:6: expected an argument count, found "z"/);
});

test("a count that runs past the end of the record throws", () => {
  const log = record([`"x\n5"`]);
  assert.throws(() => argvRecords(log), /:3: a call of 5 arguments runs past the end of the record/);
});
