// #2315. A review runs the repo's test command ONCE and hands the result to
// every dimension, instead of every dimension specialist running the full
// suite itself — up to six full sweeps of one immutable snapshot per review.
//
// Driven through runReview over a scripted host, as review-in-run-retry.test.mjs
// is: `agent`/`pipeline`/`parallel`/`phase`/`log` are exactly what runReview
// takes off `host`, so the dispatch count, the prompts and the unrun verdicts
// below are review-core.mjs's own wiring, never a re-derived copy of it.
//
// THE CEILING: a scripted host answers for the agents, so nothing here proves
// a live specialist obeys "do NOT run that full command yourself". What it
// does prove is that review-core.mjs launches the command once (the first
// test executes the test-run prompt's command block for real against a
// counter file) and that no specialist prompt hands the command out to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, DEFAULT_DIMENSIONS, CRASHED_REASON } from "../plugin/scripts/review-core.mjs";
import { pipeline, parallel, ARGS, SNAP, review, finding, vote, scriptedHost } from "./support/review-host-fixture.mjs";

const ALL = DEFAULT_DIMENSIONS.map((d) => d.key);
const ALL_ARGS = { ...ARGS, dimensions: ALL };
const run = (host, args = ALL_ARGS) => runReview({ ...host, pipeline, parallel }, args);
// Every one of the six specialists returning the same clean review, plus
// whatever the case under test scripts on top.
const script = (extra) => ({
  snapshot: [SNAP],
  ...Object.fromEntries(ALL.map((k) => [`review:${k}`, [review([])]])),
  ...extra,
});

// The one command line the test-run prompt hands its agent, run the way that
// agent is told to: once, in the foreground, through a POSIX shell. The counts
// come from the log the block wrote, as the agent is told to read them.
function obeyTestRun(prompt) {
  const block = prompt.split("\n").find((l) => /^ {4}\{ cd /.test(l));
  assert.ok(block, "the test-run prompt carries no `{ cd … }` command block");
  const out = execFileSync("/bin/sh", ["-c", block.trim()], { encoding: "utf8" });
  const exit = Number(/TEST_RUN_EXIT=(\d+)/.exec(out)?.[1]);
  const logPath = /> "([^"]+)" 2>&1/.exec(block)[1];
  const log = readFileSync(logPath, "utf8");
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, "m").exec(log)?.[1]);
  return { exitCode: exit, tests: count("tests"), pass: count("pass"), fail: count("fail") };
}

test("one review with all six dimensions launches the test command exactly once, from the snapshot's root", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "shared-test-run-"));
  try {
    const runRoot = join(tmp, "pr7", "run-ab12");
    const snap = { ...SNAP, runRoot, path: join(runRoot, "snapshot-abc123") };
    mkdirSync(snap.path, { recursive: true });
    const counter = join(tmp, "launches");
    // The caller-supplied override is what the shared run runs: each launch
    // appends one line (its cwd) to the counter file.
    const testCmd = `pwd >> "${counter}"; echo "# tests 3"; echo "# pass 3"; echo "# fail 0"`;
    const { host, calls, prompts } = scriptedHost(script({ snapshot: [snap] }));
    const scripted = host.agent;
    host.agent = async (prompt, opts) => {
      if (opts.label !== `test-run:pr${ARGS.pr}`) return scripted(prompt, opts);
      calls["test-run"] = (calls["test-run"] ?? 0) + 1;
      return obeyTestRun(prompt);
    };
    const result = await run(host, { ...ALL_ARGS, scratch: tmp, testCmd });

    const launches = readFileSync(counter, "utf8").trim().split("\n");
    assert.equal(launches.length, 1, `one review launched the test command ${launches.length} times`);
    assert.equal(launches[0], execFileSync("/bin/sh", ["-c", `cd "${snap.path}" && pwd`], { encoding: "utf8" }).trim());
    assert.equal(calls["test-run"], 1);
    assert.ok(existsSync(join(runRoot, "test-run.log")), "the shared run's log is not where the specialists are pointed");
    for (const k of ALL) {
      assert.equal(calls[`review:${k}`], 1);
      // No specialist prompt hands the command over as something to run.
      assert.doesNotMatch(prompts[`review:${k}`][0], /run exactly this/);
      assert.match(prompts[`review:${k}`][0], /Do NOT run that full command yourself/);
    }
    assert.deepEqual(result.dimensionsUnrun, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("every dispatched specialist receives the shared run's command, counts and log path", async () => {
  const { host, prompts } = scriptedHost(script({ "test-run": [{ exitCode: 0, tests: 41, pass: 40, fail: 0, skipped: 1 }] }));
  await run(host);
  for (const k of ALL) {
    const p = prompts[`review:${k}`]?.[0];
    assert.ok(p, `the ${k} specialist was never dispatched`);
    assert.match(p, /command: node --test\n/, `${k}'s prompt lacks the shared run's command`);
    assert.match(p, /counts: {2}tests 41, pass 40, fail 0, skipped 1\n/, `${k}'s prompt lacks the shared run's counts`);
    assert.match(p, new RegExp(`log: {5}${SNAP.runRoot}/test-run\\.log\\n`), `${k}'s prompt lacks the shared run's log path`);
  }
});

// The override precedence #142 settled, carried onto the one prompt that runs
// the command: a caller's override wins, the derivation is used without one.
test("the shared run runs the caller's override, and the snapshot's derived command only without one", async () => {
  for (const [args, expected] of [
    [{ ...ARGS, testCmd: "npm test -- --ci" }, "npm test -- --ci"],
    [{ ...ARGS, testCmd: undefined }, SNAP.testCmd],
  ]) {
    const { host, prompts } = scriptedHost(script({}));
    await run(host, args);
    assert.ok(prompts["test-run"][0].includes(`&& ${expected}; }`), `the test-run prompt does not run ${expected}`);
  }
});

test("a shared run reporting tests 0 makes every selected dimension unrun", async () => {
  const { host, calls } = scriptedHost(script({ "test-run": [{ exitCode: 0, tests: 0, pass: 0, fail: 0 }] }));
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun.map((u) => u.dimension), ALL);
  for (const u of result.dimensionsUnrun) assert.match(u.reason, /produced 0 tests/);
  // Still a review: the specialists were dispatched and their findings verified.
  for (const k of ALL) assert.equal(calls[`review:${k}`], 1);
});

test("a shared run that yields no counts reports every selected dimension unrun, never a pass", async () => {
  for (const answer of [null, new Error("spend limit"), {}, { exitCode: 124, error: "hit the 1800 s deadline" }]) {
    const { host, calls, prompts } = scriptedHost(script({ "test-run": [answer] }));
    const result = await run(host);
    const where = answer instanceof Error ? "a thrown dispatch" : JSON.stringify(answer);
    assert.equal(calls["test-run"], 1, `${where}: the shared run was dispatched again — a second full-suite launch`);
    assert.deepEqual(result.dimensionsUnrun.map((u) => u.dimension), ALL, `${where}: not every dimension is unrun`);
    for (const u of result.dimensionsUnrun) assert.match(u.reason, /no counts/, `${where}: ${u.reason}`);
    assert.match(prompts["review:correctness"][0], /This run is NOT usable/);
  }
});

// Failing tests are the REVIEW's, not each dimension's: the first selected
// dimension is told to file them and every other one not to duplicate it.
test("a shared run with failures: one dimension's finding leaves no dimension unrun, and the others are told not to duplicate it", async () => {
  const failing = { exitCode: 1, tests: 10, pass: 8, fail: 2 };
  const { host, prompts } = scriptedHost(
    script({ "test-run": [failing], "review:correctness": [review([finding("suggestion")])] }),
  );
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun, [], "a sibling's finding about the failures must satisfy every dimension");
  assert.match(prompts["review:correctness"][0], /filing them is YOUR job/);
  for (const k of ALL.filter((k) => k !== "correctness")) {
    const p = prompts[`review:${k}`][0];
    assert.match(p, /the correctness dimension files the finding\s+about them\. Do not file a duplicate/, `${k} is not told to leave the failures to correctness`);
    assert.doesNotMatch(p, /YOUR job/, `${k} is told to file the failures too — a duplicate per dimension`);
  }
  // The accept side: ownership is a duplicate-avoidance rule, not a verdict
  // key — a finding from a NON-owner satisfies the check just as well.
  const other = scriptedHost(script({ "test-run": [failing], "review:types": [review([finding("suggestion")])] }));
  assert.deepEqual((await run(other.host)).dimensionsUnrun, []);
});

test("a shared run with failures and no finding from any dimension makes every selected dimension unrun", async () => {
  const { host } = scriptedHost(script({ "test-run": [{ exitCode: 1, tests: 10, pass: 8, fail: 2 }] }));
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun.map((u) => u.dimension), ALL);
  for (const u of result.dimensionsUnrun) assert.match(u.reason, /2 failing tests and no selected dimension filed a finding/);
});

// The failing-tests check reads what reached the payload, never what a
// specialist returned before its findings were verified: an unrelated finding
// the refuters threw out, or the findings of a dimension whose verify stage
// died, would otherwise stand in for failures nobody reported — and the
// failures would reach neither the report nor dimensionsUnrun.
test("a shared run with failures is not satisfied by a refuted finding, nor by a dimension whose verify stage died", async () => {
  const failing = { exitCode: 1, tests: 10, pass: 8, fail: 2 };
  const refuted = scriptedHost(
    script({ "test-run": [failing], "review:correctness": [review([finding("critical")])], "verify:correctness": [vote(true)] }),
  );
  const r1 = await run(refuted.host);
  assert.equal(r1.refuted.length, 1, "the fixture's finding was not refuted — this case tests nothing");
  assert.deepEqual(r1.dimensionsUnrun.map((u) => u.dimension), ALL, "a refuted finding satisfied the failing-tests check");
  for (const u of r1.dimensionsUnrun) assert.match(u.reason, /2 failing tests and no selected dimension filed a finding/);

  // A malformed finding throws inside the verify stage: the slot dies, so its
  // dimension is crashed and its findings never reach the payload.
  const died = scriptedHost(script({ "test-run": [failing], "review:correctness": [review([null])] }));
  const r2 = await run(died.host);
  assert.equal(r2.dimensionsUnrun.find((u) => u.dimension === "correctness")?.reason, CRASHED_REASON);
  assert.deepEqual(
    r2.dimensionsUnrun.filter((u) => u.dimension !== "correctness").map((u) => u.dimension),
    ALL.filter((k) => k !== "correctness"),
    "a dead dimension's unverified findings satisfied the failing-tests check",
  );

  // The accept side: a finding that survived its refuters settles it.
  const kept = scriptedHost(
    script({ "test-run": [failing], "review:correctness": [review([finding("critical")])], "verify:correctness": [vote(false)] }),
  );
  assert.deepEqual((await run(kept.host)).dimensionsUnrun, []);
});

// The exit status is the command's verdict: clean-looking counts beside a
// non-zero or missing exit are not a pass, and every specialist is told so.
test("a shared run whose exit is non-zero with nothing failing, or missing, makes every selected dimension unrun", async () => {
  for (const answer of [{ exitCode: 137, tests: 5, pass: 5, fail: 0 }, { exitCode: 1, tests: 5, pass: 5 }, { tests: 5, pass: 5, fail: 0 }]) {
    const { host, prompts } = scriptedHost(script({ "test-run": [answer], "review:correctness": [review([finding("suggestion")])] }));
    const result = await run(host);
    const where = JSON.stringify(answer);
    assert.deepEqual(result.dimensionsUnrun.map((u) => u.dimension), ALL, `${where}: not every dimension is unrun`);
    for (const u of result.dimensionsUnrun) assert.match(u.reason, /exited \d+ but reported no failing|no exit status/, `${where}: ${u.reason}`);
    assert.match(prompts["review:tests"][0], /This run is NOT usable/, `${where}: a specialist was not told the run is unusable`);
  }
});

// node's runner counts a test that never finished as `cancelled`, not `fail`,
// and exits 1: that is a failure for the owner to file, not an unusable run.
test("a shared run with cancelled tests and no failing count hands the owner the cancelled tests to file", async () => {
  const cancelled = { exitCode: 1, tests: 10, pass: 9, fail: 0, cancelled: 1 };
  const { host, prompts } = scriptedHost(script({ "test-run": [cancelled] }));
  const result = await run(host);
  assert.match(prompts["review:correctness"][0], /It has 0 failing and 1 cancelled tests, and filing them is YOUR job/);
  assert.doesNotMatch(prompts["review:correctness"][0], /NOT usable/);
  assert.deepEqual(result.dimensionsUnrun.map((u) => u.dimension), ALL);
  for (const u of result.dimensionsUnrun) assert.match(u.reason, /1 cancelled tests and no selected dimension filed a finding/);
  const filed = scriptedHost(script({ "test-run": [cancelled], "review:correctness": [review([finding("suggestion")])] }));
  assert.deepEqual((await run(filed.host)).dimensionsUnrun, []);
});

// #2879: vitest's `expected fail` is reported in its own field — the counts
// line carries it, and with `fail 0` there is nothing for the owner to file,
// so the review is clean without a finding.
test("a shared run whose only non-pass is an expected fail reads fail 0 and hands no one a failure to file", async () => {
  const { host, prompts } = scriptedHost(script({ "test-run": [{ exitCode: 0, tests: 121, pass: 120, fail: 0, expectedFail: 1 }] }));
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun, []);
  for (const k of ALL) {
    const p = prompts[`review:${k}`][0];
    assert.match(p, /counts: {2}tests 121, pass 120, fail 0, expectedFail 1\n/, `${k}'s prompt lacks the expected-fail count`);
    assert.doesNotMatch(p, /failing tests|NOT usable/, `${k}'s prompt reads an expected fail as a failure`);
  }
});

// A crashed specialist is named once, with its own reason — never a second
// entry for the shared run's verdict on top.
test("a crashed dimension is listed once, with its crash reason, beside the shared run's verdict for the rest", async () => {
  const { host } = scriptedHost(
    script({ "test-run": [{ exitCode: 0, tests: 0 }], "review:types": [null] }),
  );
  const result = await run(host);
  const keys = result.dimensionsUnrun.map((u) => u.dimension);
  assert.equal(keys.length, new Set(keys).size, `a dimension is listed twice: ${keys.join(", ")}`);
  assert.deepEqual([...keys].sort(), [...ALL].sort());
  assert.equal(result.dimensionsUnrun.find((u) => u.dimension === "types").reason, CRASHED_REASON);
});

// The shared run alone decides. A specialist whose payload still carries its
// own `test_run` — from a prompt that predates the field's removal — is
// ignored: a count that disagrees with the shared run changes no verdict, and
// leaves no trace in the result. The baseline is the same script with no stray
// field, so the comparison is the whole result, not a chosen key.
test("a specialist's stray test_run never changes the result, and the shared run alone decides", async () => {
  const stray = (r, testRun) => ({ ...r, test_run: testRun });
  const cases = [
    // The shared run counted nothing; a stray copy claims a full suite ran.
    ["shared tests 0, stray 9999", { exitCode: 0, tests: 0, pass: 0, fail: 0 }, { command: "MARKER-CMD", tests: 9999, pass: 9999, fail: 0 }, {}],
    // The shared run is clean; a stray copy claims nothing ran. Findings on
    // three dimensions put an entry in survived, refuted and unverified.
    [
      "shared clean, stray 0",
      { exitCode: 0, tests: 5, pass: 5, fail: 0 },
      { command: "MARKER-CMD", tests: 0 },
      {
        "review:correctness": [review([finding("critical")])],
        "verify:correctness": [vote(false)],
        "review:types": [review([finding("important")])],
        "verify:types": [vote(true)],
        "review:tests": [review([finding("suggestion")])],
      },
    ],
  ];
  for (const [name, shared, testRun, extra] of cases) {
    const base = script({ "test-run": [shared], ...extra });
    const withStray = Object.fromEntries(
      Object.entries(base).map(([label, seq]) => [label, label.startsWith("review:") ? seq.map((r) => stray(r, testRun)) : seq]),
    );
    const expected = await run(scriptedHost(base).host);
    const actual = await run(scriptedHost(withStray).host);
    assert.deepEqual(actual, expected, `${name}: a stray test_run changed the result`);
    const text = JSON.stringify(actual);
    assert.doesNotMatch(text, /MARKER-CMD|test_run/, `${name}: the stray test_run reached the result`);
    if (shared.tests === 0) {
      assert.deepEqual(actual.dimensionsUnrun.map((u) => u.dimension), ALL, `${name}: not every live dimension is unrun`);
      assert.doesNotMatch(text, /9999/, `${name}: the stray count reached the result`);
    } else {
      assert.deepEqual(actual.dimensionsUnrun, [], `${name}: a stray count of 0 made a dimension unrun`);
      for (const key of ["survived", "refuted", "unverified"]) assert.equal(actual[key].length, 1, `${name}: ${key} holds no finding — this case tests nothing`);
    }
  }
});
