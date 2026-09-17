// #1192: the `--prev` read guarded only the PARSE, so a previous board that
// parsed as JSON but carried a wrong-typed `tickets` crashed the gather its own
// comment promises it cannot ("a corrupt/partial board.json is ignored, not
// fatal"). `{"tickets": 5}` reached the prevCi map's `.filter` and left gather()
// as a TypeError through main()'s handler — the build refused, and the message
// named an "intermediate value" rather than the file the operator passed, so
// `--prev` was not implicated in the failure it caused.
//
// The guard rejects the SHAPE where the payload enters, next to the parse, and
// both faults take the one existing ignore path. Not per-read defaults: the
// prevCi expression's `|| []` is exactly the wrong seam and shows why — it
// defends against an ABSENT `tickets` and not against a present one of the
// wrong type, and it is one of three reads of this payload (`prev?.repo`,
// `prev?.repoUrl`, and compute-board.mjs's dwell tracking, which consumes the
// whole `prev` gather() returns).
//
// Driven through the exported `gather()` and through the real CLI: the value
// half (carry-forward present or empty) is only observable at gather()'s
// return, and the contract half (exit code unchanged, nothing on stdout) is
// only observable at the process boundary. Out of process either way, for the
// reason board.test.mjs's own gather drivers give — gather() reads process.argv
// and would otherwise read the test runner's.
//
// A separate file rather than more of board.test.mjs, the same reason
// board-tryparse-null.test.mjs gives: the fleet runs several implementers at
// once and two PRs appending to one test file conflict, which costs the PR its
// CI entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));

// What ci-state.mjs emits on a quota refusal: a payload at exit 2, which
// runCiState reads as "no answer" and is the ONLY way into the carry-forward
// arm (board.test.mjs's RATE_LIMITED_EXIT_2 pins that reading). Without it
// every ci value comes from mapCi and the previous board is never consulted, so
// an empty carry-forward would be indistinguishable from a consulted one.
const CI_READ_FAILS = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["quota"] }) + "\\n");
process.exit(2);`;

// `prevBody` is written RAW, not through JSON.stringify: half the cases below
// are payloads JSON.stringify cannot produce (`not json`) or would launder.
function gatherPrev(prevBody) {
  const cwd = mkdtempSync(join(tmpdir(), "board-prevshape-"));
  const bin = mkdtempSync(join(tmpdir(), "board-prevshape-bin-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "board-prevshape-scripts-"));

  writeFileSync(join(scriptDir, "ci-state.mjs"), CI_READ_FAILS);
  // A real ledger answer, so the only unusual read on this stderr is the one
  // under test — the assertions below count lines.
  writeFileSync(join(scriptDir, "ledger.mjs"),
    `console.log(JSON.stringify({ rows: [], filed: [], ruled: [] }));`);
  writeFileSync(join(bin, "gh"),
    '#!/bin/sh\ncase "$1 $2" in\n"pr list") echo \'[{"number":42,"state":"OPEN","labels":[],"title":"t"}]\' ;;\n*) exit 1 ;;\nesac\n');
  chmodSync(join(bin, "gh"), 0o755);

  const prevFile = join(cwd, "prev.json");
  writeFileSync(prevFile, prevBody);

  const driver = `const { gather } = await import(${JSON.stringify(BOARD)});
    const r = gather({ ledgerFile: ${JSON.stringify(join(cwd, "nope.md"))},
                       prevFile: ${JSON.stringify(prevFile)},
                       scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify({ ci: r.ci, prev: r.prev }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, prevFile };
}

// The gather has to COMPLETE, not merely not-throw: a driver that died on the
// prevCi TypeError exits non-zero with no stdout, and every value assertion
// below would read `undefined` from a parse of nothing. Asserting status and
// parsing here keeps that failure legible at the one place it can happen.
function gathered(prevBody) {
  const r = gatherPrev(prevBody);
  assert.equal(r.status, 0,
    `the gather refused a previous board it promises to ignore\n${r.stderr}`);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr, prevFile: r.prevFile };
}

const ignoreLines = (stderr) =>
  stderr.split("\n").filter((l) => l.includes("ignoring unreadable prev board"));

test("gather: a previous board whose `tickets` is a number is ignored, not fatal (#1192)", () => {
  const r = gathered('{"tickets": 5}');
  // The carry-forward is EMPTY, not absent-and-crashed: PR 42's CI read failed,
  // so this value is what the carry-forward answered. "unknown" is gather()'s
  // no-previous-value fallback, the same answer a run with no --prev gives.
  assert.equal(r.ci[42], "unknown");
  const lines = ignoreLines(r.stderr);
  assert.equal(lines.length, 1, `expected exactly one diagnostic, got:\n${r.stderr}`);
  // The file the operator passed, and what was wrong with it — the crash named
  // an "intermediate value" and implicated nothing the caller typed.
  assert.ok(lines[0].includes(r.prevFile), `diagnostic must name the file: ${lines[0]}`);
  assert.match(lines[0], /expected tickets to be an array, got number/);
});
