#!/usr/bin/env node
// TEMPORARY measurement probe for #951 — deleted before the PR opens.
//
// Drives board-cli.test.mjs's flooded-child scenario against three builds and
// prints what this platform delivers. Run it on darwin and on ubuntu-latest;
// the pair decides whether the #363 gate's "darwin-only" premise holds.
//
//   fixed   — the shipped writeSync die()
//   mutant  — die() reverted to console.error + process.exit, the pre-#367 shape
//   filefd  — the mutant with the reader's end a FILE instead of a pipe, the
//             vacuous-green control: if this one keeps the refusal while
//             `mutant` loses it, the pipe is what does the losing.

import { mkdtempSync, writeFileSync, chmodSync, readFileSync, cpSync, openSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(ROOT, "skills/fleet/scripts");

const FLOOD_BYTES = 200_000;
const FLOOD_GH_STUB = `#!/bin/sh\nyes F | head -c ${FLOOD_BYTES} >&2\nexit 0\n`;
const REFUSAL = /board: --spend-since wants epoch milliseconds, got notanumber/;

function ghBin() {
  const bin = mkdtempSync(join(tmpdir(), "probe-bin-"));
  writeFileSync(join(bin, "gh"), FLOOD_GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function args(board, cwd) {
  return [board, "build", "--ledger", join(cwd, "nope.md"), "--spend-since", "notanumber"];
}

// Exactly runBoardFlooded()'s shape: default-ish pipe stdio, drained async,
// resolved on `close` so every byte the stream ever sees is counted.
function runPiped(board) {
  const cwd = mkdtempSync(join(tmpdir(), "probe-cwd-"));
  const bin = ghBin();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args(board, cwd), {
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

// The trap the brief names: fd 2 is a real file, so the write is synchronous
// and process.exit() cannot discard it.
function runFileFd(board) {
  const cwd = mkdtempSync(join(tmpdir(), "probe-cwd-"));
  const bin = ghBin();
  const out = join(cwd, "stderr.txt");
  const fd = openSync(out, "w");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args(board, cwd), {
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "ignore", fd],
    });
    child.on("close", (status) => resolve({ status, stderr: rf(out, "utf8") }));
  });
}

// Copy the whole scripts dir so board.mjs's sibling resolution still works,
// then revert arg.mjs's die() to the console.error shape #367 replaced.
function mutantBoard() {
  const dir = mkdtempSync(join(tmpdir(), "probe-mutant-"));
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
  return join(dir, "board.mjs");
}

const rows = [];
const fixed = join(SCRIPTS, "board.mjs");
const mutant = mutantBoard();

rows.push(["fixed  (writeSync die, PIPE) ", await runPiped(fixed)]);
rows.push(["mutant (console.error, PIPE) ", await runPiped(mutant)]);
rows.push(["mutant (console.error, FILE) ", await runFileFd(mutant)]);

console.log(`\n=== #951 flooded-child probe ===`);
console.log(`platform=${process.platform} arch=${process.arch} node=${process.version} FLOOD_BYTES=${FLOOD_BYTES}\n`);
console.log(`build                          | exit | stderr bytes | refusal | < FLOOD_BYTES`);
console.log(`-------------------------------|------|--------------|---------|--------------`);
for (const [name, r] of rows) {
  console.log(
    `${name} | ${String(r.status).padStart(4)} | ${String(r.stderr.length).padStart(12)} | ${REFUSAL.test(r.stderr) ? "PRESENT" : "LOST   "} | ${r.stderr.length < FLOOD_BYTES}`,
  );
}
console.log("");
