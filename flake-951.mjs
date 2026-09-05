#!/usr/bin/env node
// TEMPORARY flake measurement for #951 — deleted before the PR opens.
//
// Unskipping a gate that reds at random is a worse defect than the gate never
// running. The 25-run probe showed the FIXED build losing the refusal 1/25 on
// Linux, so measure the shipped test's own red rate before committing to the
// unskip. Runs board-cli.test.mjs end to end N times and reports how often the
// pipe-buffer gate fails.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST = join(dirname(fileURLToPath(import.meta.url)), "skills/fleet/scripts/board-cli.test.mjs");
const N = Number(process.env.FLAKE_N ?? 30);
const GATE = "pushed past the pipe buffer";
const gateRe = new RegExp(`^not ok \\d+ - .*${GATE}`, "m");

let gateRed = 0;
let otherRed = 0;
const failures = [];

for (let i = 0; i < N; i++) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", TEST], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status === 0) continue;
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (gateRe.test(out)) {
    gateRed++;
    const detail = out.split("\n").find((l) => /gh's flood must overrun|refusal|AssertionError|actual:|expected:/.test(l));
    failures.push(`run ${i}: GATE — ${detail?.trim() ?? "(no detail)"}`);
  } else {
    otherRed++;
    failures.push(`run ${i}: OTHER — ${out.split("\n").filter((l) => /^not ok /.test(l)).join("; ")}`);
  }
}

console.log(`\n=== #951 flake rate, board-cli.test.mjs end to end ===`);
console.log(`platform=${process.platform} node=${process.version} runs=${N}`);
console.log(`pipe-buffer gate red: ${gateRed}/${N}`);
console.log(`any other test red:   ${otherRed}/${N}`);
if (failures.length) console.log(`\n${failures.join("\n")}`);
console.log("");

// A gate that reds on a correct build is not coverage, it is noise. Fail the
// step so this cannot be merged on an unread green.
if (gateRed > 0) {
  console.error(`FAIL: the gate red ${gateRed}/${N} times against the SHIPPED build — unskipping it would flake CI.`);
  process.exit(1);
}
