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
// runCiState reads as "no answer" (board.test.mjs's RATE_LIMITED_EXIT_2 pins
// that reading). Some route into the carry-forward arm is what these tests
// need, not this one in particular — since #875 a salvaged payload that will
// not parse reaches it too — and a payload at exit 2 is the route with the
// least of its own machinery: one write and one exit code, no truncation to
// stage. Without SOME such route every ci value comes from mapCi and the
// previous board is never consulted, so an empty carry-forward would be
// indistinguishable from a consulted one.
const CI_READ_FAILS = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["quota"] }) + "\\n");
process.exit(2);`;

// `prevBody` is written RAW, not through JSON.stringify: half the cases below
// are payloads JSON.stringify cannot produce (`not json`) or would launder.
//
// The gather has to COMPLETE, not merely not-throw: a driver that died on the
// prevCi TypeError exits non-zero with no stdout, and every value assertion
// below would read `undefined` from a parse of nothing. Asserting status here
// keeps that failure legible at the one place it can happen.
function gathered(prevBody) {
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
    const r = await gather({ ledgerFile: ${JSON.stringify(join(cwd, "nope.md"))},
                       prevFile: ${JSON.stringify(prevFile)},
                       scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify({ ci: r.ci, prev: r.prev }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0,
    `the gather refused a previous board it promises to ignore\n${r.stderr}`);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr, prevFile };
}

const ignoreLines = (stderr) =>
  stderr.split("\n").filter((l) => l.includes("ignoring unreadable prev board"));

// ── the invalid-shape class ──────────────────────────────────────────────────
//
// One row per DISTINCT route into the defect, not per value: a wrong-typed
// container, a wrong-typed entry, and a wrong-typed payload are three
// different reads, and the three kind words below are the three branches of
// the guard's own naming expression — a `typeof`-only version reports both
// `null` and `[]` as "object", which is the diagnostic the operator cannot act
// on. Every row asserts the gather COMPLETED (inside `gathered`) with an empty
// carry-forward and exactly one diagnostic naming the file.
const REFUSED = [
  // `{"tickets": 5}` is the ticket's own reproduction (#1192): a wrong-typed
  // container reached the prevCi map's `.filter` and crashed gather() before
  // this guard existed.
  ['{"tickets": 5}', /expected tickets to be an array, got number/],
  // The case an `Array.isArray` check alone lets straight through: `[null]`
  // IS an array, so it clears the container check and throws on the per-entry
  // `t.pr` read inside the prevCi map instead. The whole payload is refused
  // rather than the bad entry filtered out — a board with one unreadable
  // ticket is not a board whose OTHER tickets can be trusted to carry CI
  // state forward.
  ['{"tickets": [null]}', /expected tickets\[0\] to be a JSON object, got null/],
  ['{"tickets": "5"}', /expected tickets to be an array, got string/],
  ['{"tickets": {"42": "red"}}', /expected tickets to be an array, got object/],
  ['{"tickets": [1]}', /expected tickets\[0\] to be a JSON object, got number/],
  ['{"tickets": [{"pr": 42, "ci": "red"}, "x"]}', /expected tickets\[1\] to be a JSON object, got string/],
  ['{"tickets": [[]]}', /expected tickets\[0\] to be a JSON object, got array/],
  // Top-level faults. These four did NOT crash before the guard — `prev?.x`
  // reads undefined off all of them — so the defect here is the silence: the
  // operator passed a file that is not a board and the run said nothing, then
  // carried nothing forward. Ignoring them is unchanged; SAYING so is new.
  ["null", /expected a JSON object, got null/],
  ["5", /expected a JSON object, got number/],
  ['"a board"', /expected a JSON object, got string/],
  ["[]", /expected a JSON object, got array/],
];

for (const [body, reason] of REFUSED) {
  test(`gather: an unusable previous board ${body} is ignored with one named diagnostic (#1192)`, () => {
    const r = gathered(body);
    assert.equal(r.ci[42], "unknown", "an unusable previous board must carry nothing forward");
    // Nothing reaches the payload's other three readers either — `prev?.repo`,
    // `prev?.repoUrl` and compute-board.mjs's dwell tracking, which reads the
    // returned `prev` through the same `(prev?.tickets || []).map` shape.
    assert.equal(r.prev, null);
    const lines = ignoreLines(r.stderr);
    assert.equal(lines.length, 1, `expected exactly one diagnostic, got:\n${r.stderr}`);
    assert.ok(lines[0].includes(r.prevFile), `diagnostic must name the file: ${lines[0]}`);
    assert.match(lines[0], reason);
  });
}

// A parse fault is the path that already worked, and its wording is not the
// shape fault's: re-using one message for both would put a reader who sees
// "expected a JSON object" in front of a file that never parsed.
test("gather: a previous board that is not JSON still takes the ignore path with its own message (#1192)", () => {
  const r = gathered("not json at all");
  assert.equal(r.ci[42], "unknown");
  const lines = ignoreLines(r.stderr);
  assert.equal(lines.length, 1, `expected exactly one diagnostic, got:\n${r.stderr}`);
  assert.match(lines[0], /is not valid JSON/);
  assert.doesNotMatch(lines[0], /expected a JSON object/,
    "a parse fault must not be reported as a shape fault");
});

// ── the accept side: what this guard must NOT refuse ─────────────────────────

test("gather: a well-formed previous board still supplies the carry-forward (#1192)", () => {
  // The behaviour the guard exists to protect, not merely to leave alone: PR
  // 42's own CI read fails here, so "red" can only have come from this file.
  // A guard that refused the payload — or nulled `prev` on its way past —
  // would show up here as "unknown" and nowhere else.
  const r = gathered('{"tickets": [{"pr": 42, "ci": "red"}]}');
  assert.equal(r.ci[42], "red");
  assert.deepEqual(r.prev, { tickets: [{ pr: 42, ci: "red" }] },
    "an accepted payload must reach gather()'s callers whole — compute-board.mjs reads it for dwell");
  assert.deepEqual(ignoreLines(r.stderr), [], "a usable previous board must draw no diagnostic");
});

// The rows a stricter guard gets wrong. `prev?.tickets || []` reads all three
// as the empty carry-forward today, so all three are USABLE payloads, and a
// guard written as `!Array.isArray(p.tickets)` or `"tickets" in p` would
// start refusing boards that work — printing a diagnostic about a file whose
// only fault is having no tickets on it, and throwing away the `repo`/`repoUrl`
// the same payload still carries.
const ACCEPTED = ['{}', '{"tickets": null}', '{"tickets": []}', '{"repo": "o/r"}'];

for (const body of ACCEPTED) {
  test(`gather: a previous board with no usable tickets, ${body}, is accepted in silence (#1192)`, () => {
    const r = gathered(body);
    assert.equal(r.ci[42], "unknown");
    assert.deepEqual(r.prev, JSON.parse(body), "a payload with nothing to carry is still a payload");
    assert.deepEqual(ignoreLines(r.stderr), [],
      "nullish/empty tickets is an empty carry-forward, not a fault");
  });
}

// ── the process contract: an ignored previous board is not an error ──────────
//
// Only observable out here: `gather()`'s return says nothing about the exit
// code, and the diagnostic's CHANNEL is the thing a cockpit consuming
// `board build` stdout depends on. The stub `gh` fails every call — each gh
// read degrades through tryRun — so the board still builds with no network and
// no read of this repo's live issue list.
function runBuild(prevArgs) {
  const cwd = mkdtempSync(join(tmpdir(), "board-prevshape-cli-"));
  const home = mkdtempSync(join(tmpdir(), "board-prevshape-home-"));
  const bin = mkdtempSync(join(tmpdir(), "board-prevshape-cli-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  return spawnSync(process.execPath, [BOARD, "build", "--ledger", join(cwd, "nope.md"), ...prevArgs], {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("build: an ignored previous board changes neither the exit code nor stdout (#1192)", () => {
  const prevFile = join(mkdtempSync(join(tmpdir(), "board-prevshape-file-")), "prev.json");
  writeFileSync(prevFile, '{"tickets": 5}');
  const withPrev = runBuild(["--prev", prevFile]);
  // The baseline is measured in the same run rather than asserted as a
  // constant: "whatever it would have been with no --prev at all" is the
  // criterion, and a rig that started failing for its own reasons would
  // otherwise read as this fix regressing.
  const without = runBuild([]);
  assert.equal(withPrev.status, without.status,
    `--prev changed the exit code: ${withPrev.status} vs ${without.status}\n${withPrev.stderr.slice(-400)}`);
  // Pinned absolutely too, so a rig broken in both arms cannot pass by
  // agreeing with itself. 70 was the pre-fix answer — main()'s internal-fault
  // handler (#1093) — and 2 is a refusal.
  assert.equal(withPrev.status, 0, withPrev.stderr.slice(-400));
  // stderr carries it, and only once.
  assert.equal(ignoreLines(withPrev.stderr).length, 1, withPrev.stderr);
  // stdout stays the board and nothing else: the cockpit parses this whole.
  const board = JSON.parse(withPrev.stdout);
  assert.ok(Array.isArray(board.tickets), "stdout must still be a board model");
  assert.doesNotMatch(withPrev.stdout, /ignoring unreadable prev board/,
    "a diagnostic on stdout would break every consumer that parses it");
});
