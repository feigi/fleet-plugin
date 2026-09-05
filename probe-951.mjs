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

// A probabilistic failure needs repeated runs; one run is uninformative in
// either direction (#299/#322's lesson). N=25 per arm.
const N = Number(process.env.PROBE_N ?? 25);
const fixed = join(SCRIPTS, "board.mjs");
const mutant = mutantBoard();

async function arm(label, board, runner) {
  const sizes = [];
  let lost = 0;
  let badExit = 0;
  let wouldPassGuard = 0;
  for (let i = 0; i < N; i++) {
    const r = await runner(board);
    sizes.push(r.stderr.length);
    if (!REFUSAL.test(r.stderr)) lost++;
    if (r.status !== 2) badExit++;
    if (r.stderr.length < FLOOD_BYTES) wouldPassGuard++;
  }
  sizes.sort((a, b) => a - b);
  return { label, lost, badExit, wouldPassGuard, min: sizes[0], max: sizes[sizes.length - 1], uniq: new Set(sizes).size };
}

const rows = [
  await arm("fixed  (writeSync die, PIPE) ", fixed, runPiped),
  await arm("mutant (console.error, PIPE) ", mutant, runPiped),
  await arm("mutant (console.error, FILE) ", mutant, runFileFd),
];

console.log(`\n=== #951 flooded-child probe ===`);
console.log(`platform=${process.platform} arch=${process.arch} node=${process.version} FLOOD_BYTES=${FLOOD_BYTES} runs=${N}\n`);
console.log(`build                          | refusal LOST | exit!=2 | stderr min | stderr max | distinct | guard(<FLOOD) passes`);
console.log(`-------------------------------|--------------|---------|------------|------------|----------|---------------------`);
for (const r of rows) {
  console.log(
    `${r.label} | ${String(r.lost + "/" + N).padStart(12)} | ${String(r.badExit + "/" + N).padStart(7)} | ${String(r.min).padStart(10)} | ${String(r.max).padStart(10)} | ${String(r.uniq).padStart(8)} | ${r.wouldPassGuard}/${N}`,
  );
}
console.log("");
