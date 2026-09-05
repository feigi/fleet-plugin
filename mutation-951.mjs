#!/usr/bin/env node
// TEMPORARY mutation check for #951 — deleted before the PR opens.
//
// The unskipped gate must RED against the pre-fix die(), not merely go green
// against the fixed one. Copies the scripts dir, reverts arg.mjs's die() to the
// console.error shape #367 replaced, runs board-cli.test.mjs out of the copy
// (BOARD resolves relative to the test file's own URL, so the copy drives the
// mutant), and requires a non-zero exit.

import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "skills/fleet/scripts");
const dir = mkdtempSync(join(tmpdir(), "mutation-951-"));
cpSync(SCRIPTS, dir, { recursive: true });

const argPath = join(dir, "arg.mjs");
const src = readFileSync(argPath, "utf8");
const patched = src.replace(
  /export function makeDie\(name\) \{[\s\S]*?\n\}/,
  'export function makeDie(name) {\n  return function die(msg) {\n    console.error(`${name}: ${msg}`);\n    process.exit(2);\n  };\n}',
);
if (patched === src) throw new Error("mutation did not apply — makeDie shape changed");
if (/writeSync\(2/.test(patched.match(/export function makeDie[\s\S]*?\n\}/)[0])) {
  throw new Error("mutation did not remove writeSync");
}
writeFileSync(argPath, patched);

// TAP, not the default spec reporter: spec prints "✖ name" and no machine-
// readable per-test status, so a detector matching "not ok" against it finds
// nothing and misreports a correct red as the wrong red.
const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "board-cli.test.mjs")], {
  encoding: "utf8",
  env: process.env,
});
const out = (r.stdout ?? "") + (r.stderr ?? "");

const GATE = "pushed past the pipe buffer";
const gateFailed = new RegExp(`^not ok \\d+ - .*${GATE}`, "m").test(out);

console.log(`mutant test exit: ${r.status}`);
console.log(out.split("\n").filter((l) => /^# (pass|fail|skip)|^not ok /.test(l)).join("\n"));

if (r.status === 0) {
  console.error(`\nFAIL: the suite passed against the pre-fix die(). The gate is vacuous.`);
  process.exit(1);
}
if (!gateFailed) {
  console.error(`\nFAIL: the suite went red, but not at the ${GATE} gate — something else broke.`);
  process.exit(1);
}
console.log(`\nOK: the ${GATE} gate reds against the pre-fix die(), and it is that gate that reds.`);
