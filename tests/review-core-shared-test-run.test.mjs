// #2315. A review runs the repo's test command ONCE and hands the result to
// every dimension, instead of every dimension specialist running the full
// suite itself — up to six full sweeps of one immutable snapshot per review.
//
// Driven through runReview over a scripted host, as review-in-run-retry.test.mjs
// is: `agent`/`pipeline`/`parallel`/`phase`/`log` are exactly what runReview
// is: `agent`/`pipeline`/`parallel`/`phase`/`log` are exactly what runReview
// takes off `host`, so the dispatch count, the prompts and the digest verdicts
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
import { runReview, DEFAULT_DIMENSIONS, CRASHED_REASON, TEST_RUN_SCHEMA } from "../plugin/scripts/review-core.mjs";
import { pipeline, parallel, ARGS, SNAP, review, finding, vote, scriptedHost } from "./support/review-host-fixture.mjs";
import { slotHome, holdSlots } from "./support/suite-slot-home.mjs";

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
// come from the log the block wrote, as the agent is told to read them. The
// block reaches the suite-slot wrapper through `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run`, so it
// runs under a host of its own (`slotHome()`), never the real `~/.fleet`.
function runBlock(prompt, env) {
  const block = prompt.split("\n").find((l) => /^ {4}\{ cd /.test(l));
  assert.ok(block, "the test-run prompt carries no `{ cd … }` command block");
  const out = execFileSync("/bin/sh", ["-c", block.trim()], { encoding: "utf8", env });
  const exit = Number(/TEST_RUN_EXIT=(\d+)/.exec(out)?.[1]);
  const logPath = /> "([^"]+)" 2>&1/.exec(block)[1];
  return { exit, log: readFileSync(logPath, "utf8") };
}
function obeyTestRun(prompt, env) {
  const { exit, log } = runBlock(prompt, env);
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
      return obeyTestRun(prompt, slotHome().env());
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
    assert.deepEqual(result.suiteVerdict, { usable: true, reason: null });
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
    assert.ok(prompts["test-run"][0].includes(`suite-slot.mjs '${expected}'; }`), `the test-run prompt does not run ${expected} through the suite-slot wrapper`);
  }
});

// A review's one run goes through the wrapper, so the block must hand it a
// command that survives a shell: the command is single-quoted into the block,
// and a quote inside it has to be closed, escaped and reopened.
test("a test command holding single quotes runs as written through the slot wrapper", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "shared-test-run-quote-"));
  try {
    const runRoot = join(tmp, "pr7", "run-ab12");
    const snap = { ...SNAP, runRoot, path: join(runRoot, "snapshot-abc123") };
    mkdirSync(snap.path, { recursive: true });
    const testCmd = `echo "it's a 'quoted' run"; echo "# tests 1"; echo "# pass 1"; echo "# fail 0"`;
    const { host, prompts } = scriptedHost(script({ snapshot: [snap] }));
    await run(host, { ...ALL_ARGS, scratch: tmp, testCmd });
    const { exit, log } = runBlock(prompts["test-run"][0], slotHome().env());
    assert.equal(exit, 0, log);
    assert.match(log, /^it's a 'quoted' run$/m);
    assert.match(log, /^SUITE_SLOT_WAIT_MS=\d+$/m, "the run never took a slot");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The two ends of an expired wait, joined: the block run against a host whose
// slots are all held exits 75 and says so in its log, and a test-run agent that
// reports that exit makes the suite verdict not usable for the bound — not a
// dimension unrun, and not a crash.
test("a wait for a suite slot that expires makes the suite verdict not usable for the bound, and no dimension unrun", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "shared-test-run-nosl-"));
  try {
    const runRoot = join(tmp, "pr7", "run-ab12");
    const snap = { ...SNAP, runRoot, path: join(runRoot, "snapshot-abc123") };
    mkdirSync(snap.path, { recursive: true });
    const host = slotHome();
    holdSlots(host, 2);
    const first = scriptedHost(script({ snapshot: [snap] }));
    await run(first.host, { ...ALL_ARGS, scratch: tmp, testCmd: "echo SHOULD-NOT-RUN" });
    const { exit, log } = runBlock(first.prompts["test-run"][0], host.env({ FLEET_SUITE_WAIT_S: "1" }));
    assert.equal(exit, 75, log);
    assert.doesNotMatch(log, /SHOULD-NOT-RUN/, "the command ran without a slot");
    const line = /^suite-slot: no slot after \d+s$/m.exec(log)?.[0];
    assert.ok(line, log);
    const { host: h2, calls } = scriptedHost(script({ snapshot: [snap], "test-run": [{ exitCode: 75, error: line }] }));
    const result = await run(h2, { ...ALL_ARGS, scratch: tmp, testCmd: "echo SHOULD-NOT-RUN" });
    assert.deepEqual(result.dimensionsUnrun, [], "the bound made a dimension unrun — every specialist returned a review");
    assert.deepEqual(result.suiteVerdict, {
      usable: false,
      reason: "no suite slot within 1 s — the host is at its suite bound; not a test failure",
    });
    assert.equal(calls["test-run"], 1, "an expired wait was run a second time");
    for (const k of ALL) assert.equal(calls[`review:${k}`], 1, `${k}: the specialist was not dispatched after the expired wait`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// 75 is only the wrapper's word when it printed no counts: a suite that ran
// and happened to exit 75 is judged like any other run.
test("a run that printed counts and exited 75 is judged as a run, not as an expired wait", async () => {
  const { host } = scriptedHost(script({ "test-run": [{ exitCode: 75, tests: 4, pass: 3, fail: 1 }] }));
  const result = await run(host);
  assert.deepEqual(result.suiteVerdict, { usable: true, reason: null }, "a suite that ran and failed is a usable run");
  assert.deepEqual(result.dimensionsUnrun, []);
});

test("the test-run schema carries the wait the wrapper printed, as an optional integer", () => {
  assert.equal(TEST_RUN_SCHEMA.properties.slotWaitMs?.type, "integer");
  assert.equal(TEST_RUN_SCHEMA.required, undefined, "a required wait would force a 0 the log never stated");
});

test("a shared run reporting tests 0 makes the suite verdict not usable, and no dimension unrun", async () => {
  const { host, calls } = scriptedHost(script({ "test-run": [{ exitCode: 0, tests: 0, pass: 0, fail: 0 }] }));
  const result = await run(host);
  assert.equal(result.suiteVerdict.usable, false);
  assert.match(result.suiteVerdict.reason, /produced 0 tests/);
  assert.deepEqual(result.dimensionsUnrun, [], "an unusable shared run made a dimension unrun");
  // Still a review: the specialists were dispatched and their findings verified.
  for (const k of ALL) assert.equal(calls[`review:${k}`], 1);
});

test("a shared run that yields no counts has a suite verdict that is not usable, never a pass", async () => {
  for (const answer of [null, new Error("spend limit"), {}, { exitCode: 124, error: "hit the 1800 s deadline" }]) {
    const { host, calls, prompts } = scriptedHost(script({ "test-run": [answer] }));
    const result = await run(host);
    const where = answer instanceof Error ? "a thrown dispatch" : JSON.stringify(answer);
    assert.equal(calls["test-run"], 1, `${where}: the shared run was dispatched again — a second full-suite launch`);
    assert.equal(result.suiteVerdict.usable, false, `${where}: the verdict is usable`);
    assert.match(result.suiteVerdict.reason, /no counts/, `${where}: ${result.suiteVerdict.reason}`);
    assert.deepEqual(result.dimensionsUnrun, [], `${where}: a dimension is unrun for the shared run`);
    assert.match(prompts["review:correctness"][0], /This run is NOT usable/);
  }
});

// Failing tests are the REVIEW's, not each dimension's: the first selected
// dimension is told to file them and every other one not to duplicate it. The
// run is usable either way — usable is not green.
test("a shared run with failures: a usable verdict, no dimension unrun, and the others told not to duplicate the owner's finding", async () => {
  const failing = { exitCode: 1, tests: 10, pass: 8, fail: 2 };
  const { host, prompts } = scriptedHost(
    script({ "test-run": [failing], "review:correctness": [review([finding("suggestion")])] }),
  );
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun, []);
  assert.deepEqual(result.suiteVerdict, { usable: true, reason: null });
  assert.match(prompts["review:correctness"][0], /filing them is YOUR job/);
  for (const k of ALL.filter((k) => k !== "correctness")) {
    const p = prompts[`review:${k}`][0];
    assert.match(p, /the correctness dimension files the finding\s+about them\. Do not file a duplicate/, `${k} is not told to leave the failures to correctness`);
    assert.doesNotMatch(p, /YOUR job/, `${k} is told to file the failures too — a duplicate per dimension`);
  }
});

// #3048: nothing in the shared run's verdict reads a finding. Failing tests with
// no kept finding from any dimension — none filed, or every one refuted — are
// the owner's duty unmet, not an unusable run and not an unrun dimension. Pinned
// both ways, because the heuristic this replaced read exactly these inputs.
test("a shared run with failures and no kept finding is still usable, and the owner's duty is unchanged", async () => {
  const failing = { exitCode: 1, tests: 10, pass: 8, fail: 2 };
  const none = scriptedHost(script({ "test-run": [failing] }));
  const r0 = await run(none.host);
  assert.deepEqual(r0.suiteVerdict, { usable: true, reason: null });
  assert.deepEqual(r0.dimensionsUnrun, []);
  assert.deepEqual([r0.survived, r0.refuted, r0.unverified], [[], [], []], "the fixture filed a finding — this case tests nothing");
  assert.match(none.prompts["review:correctness"][0], /filing them is YOUR job/);
  assert.doesNotMatch(none.prompts["review:correctness"][0], /reported unrun|unrun/i, "the owner's note still threatens an unrun review");

  const refuted = scriptedHost(
    script({ "test-run": [failing], "review:correctness": [review([finding("critical")])], "verify:correctness": [vote(true)] }),
  );
  const r1 = await run(refuted.host);
  assert.equal(r1.refuted.length, 1, "the fixture's finding was not refuted — this case tests nothing");
  assert.deepEqual(r1.suiteVerdict, { usable: true, reason: null }, "a refuted finding changed the verdict on the run");
  assert.deepEqual(r1.dimensionsUnrun, []);
});

// A malformed finding throws inside the verify stage: the slot dies, so its
// dimension is crashed and named with CRASHED_REASON — whatever the shared run
// says — and no sibling is named with it.
test("a dimension whose verify stage died is the only one unrun, with the shared run usable or not", async () => {
  for (const [name, shared, usable] of [
    ["failing", { exitCode: 1, tests: 10, pass: 8, fail: 2 }, true],
    ["zero tests", { exitCode: 0, tests: 0, pass: 0, fail: 0 }, false],
  ]) {
    const died = scriptedHost(script({ "test-run": [shared], "review:correctness": [review([null])] }));
    const result = await run(died.host);
    assert.deepEqual(result.dimensionsUnrun, [{ dimension: "correctness", reason: CRASHED_REASON }], `${name}: unrun is not exactly the crashed dimension`);
    assert.equal(result.suiteVerdict.usable, usable, `${name}: the verdict depends on the crash`);
  }
});

// The exit status is the command's verdict: clean-looking counts beside a
// non-zero or missing exit are not a pass, and every specialist is told so.
test("a shared run whose exit is non-zero with nothing failing, or missing, has a suite verdict that is not usable", async () => {
  for (const answer of [{ exitCode: 137, tests: 5, pass: 5, fail: 0 }, { exitCode: 1, tests: 5, pass: 5 }, { tests: 5, pass: 5, fail: 0 }]) {
    const { host, prompts } = scriptedHost(script({ "test-run": [answer], "review:correctness": [review([finding("suggestion")])] }));
    const result = await run(host);
    const where = JSON.stringify(answer);
    assert.equal(result.suiteVerdict.usable, false, `${where}: the verdict is usable`);
    assert.match(result.suiteVerdict.reason, /exited \d+ but reported no failing|no exit status/, `${where}: ${result.suiteVerdict.reason}`);
    assert.deepEqual(result.dimensionsUnrun, [], `${where}: a dimension is unrun for the shared run`);
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
  assert.deepEqual(result.suiteVerdict, { usable: true, reason: null });
  assert.deepEqual(result.dimensionsUnrun, []);
});

// #2879: vitest's `expected fail` is reported in its own field — the counts
// line carries it, and with `fail 0` there is nothing for the owner to file,
// so the review is clean without a finding.
test("a shared run whose only non-pass is an expected fail reads fail 0 and hands no one a failure to file", async () => {
  const { host, prompts } = scriptedHost(script({ "test-run": [{ exitCode: 0, tests: 121, pass: 120, fail: 0, expectedFail: 1 }] }));
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun, []);
  assert.deepEqual(result.suiteVerdict, { usable: true, reason: null });
  for (const k of ALL) {
    const p = prompts[`review:${k}`][0];
    assert.match(p, /counts: {2}tests 121, pass 120, fail 0, expectedFail 1\n/, `${k}'s prompt lacks the expected-fail count`);
    assert.doesNotMatch(p, /failing tests|NOT usable/, `${k}'s prompt reads an expected fail as a failure`);
  }
});

// A crashed specialist is named once, with its own reason, and ONLY it: the
// shared run's verdict lives in suiteVerdict, never as a second entry — or an
// entry per sibling — in dimensionsUnrun.
test("a crashed dimension is listed once, with its crash reason, beside an unusable suite verdict", async () => {
  const { host } = scriptedHost(
    script({ "test-run": [{ exitCode: 0, tests: 0 }], "review:types": [null] }),
  );
  const result = await run(host);
  assert.deepEqual(result.dimensionsUnrun, [{ dimension: "types", reason: CRASHED_REASON }]);
  assert.equal(result.suiteVerdict.usable, false);
  assert.match(result.suiteVerdict.reason, /produced 0 tests/);
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
      assert.equal(actual.suiteVerdict.usable, false, `${name}: the shared run's verdict is usable`);
      assert.deepEqual(actual.dimensionsUnrun, [], `${name}: a dimension is unrun for the shared run`);
      assert.doesNotMatch(text, /9999/, `${name}: the stray count reached the result`);
    } else {
      assert.deepEqual(actual.suiteVerdict, { usable: true, reason: null }, `${name}: a stray count of 0 made the verdict not usable`);
      assert.deepEqual(actual.dimensionsUnrun, [], `${name}: a stray count of 0 made a dimension unrun`);
      for (const key of ["survived", "refuted", "unverified"]) assert.equal(actual[key].length, 1, `${name}: ${key} holds no finding — this case tests nothing`);
    }
  }
});
