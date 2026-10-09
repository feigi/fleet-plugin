// Smoke test for the HTTP layer, plus the transcript-reading layer underneath
// the spend panel — no gh, no build loop. Boots the static server against a temp
// dir and asserts it serves board.json and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, statSync, chmodSync, rmSync, readFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from "./support/temp-dir.mjs";
import { dirname, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { createBoardServer, renderRefusedHost, mapCi, encodeProjectDir, findSubagentsDir, spendDirPin, gatherSpend, faultText, resolveCockpitInstance, cockpitPorts, probeCockpitWorkspace } from "../plugin/scripts/board.mjs";
import { readOmpMember } from "../plugin/scripts/member-record.mjs";
import { stripComments } from "./support/strip-comments.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/board.mjs", import.meta.url));

// mapCi regression gate — pins the ci-state verdict mapping, incl. the two paths
// an "empty repo" live test cannot reach: a completed not-green run → red, and a
// no-run-yet / still-running state → unknown (never a false red).
test("mapCi: completed green → green", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "green" })), "green");
});
test("mapCi: completed not-green → red", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "not-green" })), "red");
});
test("mapCi: still-running → unknown (never a false red)", () => {
  assert.equal(mapCi(JSON.stringify({ status: "in_progress", verdict: "not-green" })), "unknown");
});
test("mapCi: no run yet (status null) → unknown, not red", () => {
  assert.equal(mapCi(JSON.stringify({ status: null, verdict: "not-green" })), "unknown");
});
// ci-state.mjs (#111) added verdict: "no-ci" for a repo with no workflow
// configured. mapCi has no branch for that string, so what protects the board
// is the trailing `return "unknown"` — and only a payload that gets PAST the
// status gate can reach it. A real no-ci payload carries status null, which the
// gate swallows before it; written that way this test took the same
// branch as its sibling above and stayed green while `verdict === "no-ci"` was
// mutated to return "green". `status: "completed"` is the whole pin: it is the
// shape that reaches the last line, so a silent no-ci→green mapping fails here
// and nowhere else.
test("mapCi: no-ci verdict past the status gate → unknown, not silently mapped", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "no-ci" })), "unknown");
});
// A non-empty payload that will not parse is a THIRD state, and the return
// value cannot carry it: "unknown" is pinned above and stays pinned — a false
// red is worse than no verdict — so the distinction leaves through stderr or
// not at all. Before #1593 runCiState()'s EXIT-0 arm handed a payload like
// this straight through untested, so a write cut mid-JSON on a green verdict
// reached mapCi looking exactly like a PR whose first run has not started,
// and that PR's red-ci flag — the top of the attention strip — stayed down
// with nothing said. #1593 closed that arm the same way #875 closed the
// non-zero one: an unparseable exit-0 payload is now a failed read, refused
// by runCiState() itself and never handed to mapCi at all. This test still
// earns its line because mapCi() is exported and total over any string a
// caller hands it, not just this file's own runCiState()/gather() wiring —
// see the direct-call comment below the gatherCi() driver.
test("mapCi: an unparseable payload → unknown, and says so on stderr, naming the PR", () => {
  let v;
  const errs = withStderr(() => { v = mapCi("not json", 6051); });
  assert.equal(v, "unknown");
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /6051/, "the line has to name the PR whose flag is suppressed");
});

// An ABSENT payload is not a garbage one, and the difference is why the warn
// sits after this guard rather than before it: every path that reaches mapCi
// with null went through runCiState()'s own stderr line first, so warning here
// would report the same failed read twice.
test("mapCi: an absent payload (null) → unknown, silently — runCiState already reported it", () => {
  let v;
  const errs = withStderr(() => { v = mapCi(null, 6052); });
  assert.equal(v, "unknown");
  assert.deepEqual(errs, []);
});

// The other half of that split, and the whole reason the guard above tests
// null rather than falsiness. An EMPTY payload used to be a failed read that
// nobody reported: before #1593, runCiState() returned stdout unconditionally
// at exit 0, emptiness untested, so a lost stdout write on a green verdict
// came back as "" and reached here having said nothing. A `!ciJson` guard
// cannot tell that from the null above and answers "unknown" in silence — the
// same disappearance #605 exists to end, one arm over from the arm it fixed.
// #1593 closed that path too: runCiState()'s exit-0 guard now parse-checks
// `out` before emptiness even gets here (JSON.parse("") throws), refuses it
// as a failed read, and says so on stderr with its own wording ("never
// answered" — see the gather()-level test for that below), so this exact
// disappearance can no longer happen through the real call site. This test
// pins mapCi()'s own contract for that input regardless — a `!ciJson` guard
// swallowing "" as though it had been reported would still be wrong for any
// OTHER caller of an exported function — and is the only thing separating the
// two guards below: the pair above and below it both pass under either guard.
test("mapCi: an empty payload → unknown, and says so — a lost write is not an absent one", () => {
  let v;
  const errs = withStderr(() => { v = mapCi("", 6056); });
  assert.equal(v, "unknown");
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /6056/, "the line has to name the PR whose flag is suppressed");
});

// The false-positive half, and the reason it is a test rather than an argument.
// "no run yet", "still running" and "no-ci" are the states this mapping is
// DESIGNED to answer unknown for — they are readings, not read failures. A warn
// that cannot tell them from a garbage payload prints a line for every PR
// awaiting its first run, on every ~15s tick, and the useful line drowns in it.
test("mapCi: a legitimately unknown state — status null, in_progress, no-ci — stays silent", () => {
  const errs = withStderr(() => {
    mapCi(JSON.stringify({ status: null, verdict: "not-green" }), 6053);
    mapCi(JSON.stringify({ status: "in_progress", verdict: "not-green" }), 6053);
    mapCi(JSON.stringify({ status: "completed", verdict: "no-ci" }), 6053);
  });
  assert.deepEqual(errs, []);
});

// #1170: JSON.parse("null") succeeds and yields d === null, and null alone
// among parsed payloads has no properties to read — every other one boxes and
// reads its status as undefined — so the status gate threw a TypeError back
// out of mapCi. mapCi runs inside gather()'s per-PR loop, so a bare "null" for
// one PR would take out that tick's whole board.json rewrite: under `serve`
// the throw is uncaught until the whole-tick catch, which logs and leaves the
// previous board.json standing, while the one-shot build path exits through
// main().catch and dies loudly. Written as a conditional because this repo's
// ci-state.mjs puts nothing on stdout but JSON.stringify of an object literal,
// so it cannot emit a bare "null" — the guard is defence in depth against a
// producer that can. Silence is the pin the comment claims and the assertion
// nobody wrote: every parseable payload with no status to read answers without
// a line, and the guard has to join that class rather than start warning.
test("mapCi: a JSON payload that parses to null → unknown, not a thrown TypeError", () => {
  let v;
  const errs = withStderr(() => { v = mapCi("null", 1170); });
  assert.equal(v, "unknown");
  assert.deepEqual(errs, [], "silent, like every other payload with no status to read");
});
// The other half: a payload that already answered "unknown" still does, so the
// guard narrowed nothing. It does not discriminate an over-guard — one
// rejecting every non-plain-object answers exactly as this guard does for every
// JSON value, since reaching a verdict at all takes a plain object such a guard
// passes through, so no fixture separates the two.
test("mapCi: parsed payloads with no status still classify unknown, not thrown", () => {
  let v, w;
  const errs = withStderr(() => { v = mapCi("true", 1170); w = mapCi("[]", 1170); });
  assert.equal(v, "unknown");
  assert.equal(w, "unknown");
  assert.deepEqual(errs, [], "silent, like every other payload with no status to read");
});

// `serve` rebuilds every ~15s and calls mapCi once per PR per tick, so a broken
// payload is broken on every tick and the gate is the whole difference between
// one line and a flood. Keyed per PR rather than globally, because a global
// gate would let the first broken PR mask every later one for the rest of the
// run — silence that looks identical to the bug being fixed here.
test("an unparseable payload warns ONCE per PR across ticks, and a second PR is not masked", () => {
  assert.equal(withStderr(() => mapCi("not json", 6054)).length, 1, "tick 1 reports");
  assert.deepEqual(withStderr(() => mapCi("not json", 6054)), [], "tick 2 stays quiet");
  assert.equal(withStderr(() => mapCi("{ trunc", 6055)).length, 1, "another PR still gets its line");
});

// #262 put a payload on stdout at exit 2 for a quota refusal, and runCiState()
// was reading "stdout is non-empty" as "a verdict was read". mapCi alone cannot
// see that: it is handed a string and never learns which exit code produced it,
// so every pin above stayed green while a rate-limited outage overwrote a PR's
// last-known-good CI with "unknown" — the carry-forward gather() documents as
// "On failure, carry the previous board's value for that PR". The seam is
// gather(), so the gate has to sit there.
//
// scriptDir is injected, so both arms drive the REAL runCiState()/gather()
// against a ci-state whose exit code and stdout are exactly what the arm needs;
// the stub `gh` only has to feed the PR loop, since every other gh read in
// gather() degrades through tryRun(). Out of process, because gather() reads
// process.argv and would otherwise read the test runner's.
//
// `prs` and `ticks` default to the single PR and the single gather() every arm
// below needs; the warn-once row is the one that raises them, because a gate
// that spends one line per process and one that spends one per tick are
// indistinguishable inside a single-tick, single-PR run.
function gatherCi({ ciStateBody, prevCi, prs = [42], ticks = 1 }) {
  const cwd = tempDir("board-gather-");
  const bin = tempDir("board-gather-bin-");
  const scriptDir = tempDir("board-gather-scripts-");
  writeFileSync(join(scriptDir, "ci-state.mjs"), ciStateBody);
  const rows = JSON.stringify(prs.map((n) => ({ number: n, state: "OPEN", labels: [], title: "t" })));
  writeExecStub(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"pr list") echo '${rows}' ;;\n*) exit 1 ;;\nesac\n`);
  writeFileSync(join(cwd, "prev.json"), JSON.stringify({ tickets: prs.map((n) => ({ pr: n, ci: prevCi })) }));
  // serve()'s shape, not a loop for its own sake: one process, gather() called
  // again per tick, which is the only place a warn-once gate is observable.
  const driver = `const { gather } = await import(${JSON.stringify(SCRIPT)});
    let r;
    for (let i = 0; i < ${ticks}; i++) r = await gather({ ledgerFile: ${JSON.stringify(join(cwd, "nope.md"))},
                       prevFile: ${JSON.stringify(join(cwd, "prev.json"))},
                       scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify(r.ci));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // stderr comes back too: gather() reports through it. mapCi's own
  // PR-in-the-warn-text wiring is no longer observable from here, though:
  // since #1593 runCiState() only ever hands mapCi an already-parseable
  // payload, so mapCi's JSON.parse catch — the only code that reads its `pr`
  // argument — can never fire through this call site. That argument's
  // presence at the real call site is pinned as source text instead (see the
  // #605 test below); what IS observable here is runCiState()'s own two
  // salvage arms, each carrying the PR and exit disposition in its own
  // stderr line.
  const ci = JSON.parse(r.stdout.trim().split("\n").pop());
  return { ci: ci[42], ciAll: ci, stderr: r.stderr };
}

// The regression itself. This payload is what ci-state.mjs emits on a quota
// refusal: it carries no `status`, so if it ever reaches mapCi the answer is
// "unknown" and the previous red is gone.
const RATE_LIMITED_EXIT_2 = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["quota"] }) + "\\n");
process.exit(2);`;

test("gather: a rate-limited ci-state — exit 2 WITH a payload — carries the previous board's CI value", () => {
  assert.equal(gatherCi({ ciStateBody: RATE_LIMITED_EXIT_2, prevCi: "red" }).ci, "red");
});

// The other direction, and the reason this pair is not one test: a runCiState()
// that returned null for every non-zero exit would satisfy the arm above and
// make the board blind to red CI, which is the failure the carry-forward exists
// to prevent. Exit 1 is a real verdict and must still beat the previous value —
// prev is "green" here precisely so a passing "red" can only have come from
// mapCi reading this payload, never from the carry-forward.
const NOT_GREEN_EXIT_1 = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, status: "completed", verdict: "not-green", reasons: ["x"] }) + "\\n");
process.exit(1);`;

test("gather: exit 1 is a verdict, not a failed read — it still overrides the previous value", () => {
  assert.equal(gatherCi({ ciStateBody: NOT_GREEN_EXIT_1, prevCi: "green" }).ci, "red");
});

// ── the salvage arm: an exit code alone never made a payload a verdict ───────
//
// #875. The gate reads the exit code because #262 retired "stdout is non-empty"
// as the proxy for "the child answered". The exit code is the other half of
// that same proxy: it says the child reached its own exit path, not that its
// payload arrived whole. Measured against stubs shaped like ci-state.mjs,
// `e.status !== 2 && out.trim()` accepted all four rows that reach it —
// not-green and no-ci, the real exit-1 verdicts, alongside the exit-1 write cut
// mid-JSON and the signal kill mid-payload — while parsing the salvaged bytes
// separates them exactly, which is why the parse is the discriminator. The
// exit-0 row is not a fifth here: this gate lives in runCiState()'s catch
// block, and a child that exits 0 never throws into it. Since #1593 exit 0
// gets the mirroring check on runCiState()'s success path instead (see the
// UNPARSEABLE_EXIT_0 test below) — a second gate, not this one widened.
//
// The accept side first, and the reason the discriminator is a PARSE rather
// than the exit status. no-ci is a REAL verdict that shares exit 1 — ci-state
// only moves it to exit 0 under --declare-no-ci, which this call never passes —
// and its `status` is null. So the other candidate remedy, "treat an abnormal
// status the way exit 2 is treated", is not merely insufficient (the cut-off
// row below exits 1 with no signal at all); tightened far enough to catch that
// row it starts refusing THIS one, resurrecting a red for a PR that has no run
// behind it any more. prev is "red" precisely so only a refusal could produce
// it: the answer this tick owns is its own "unknown".
const NO_CI_EXIT_1 = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, status: null, verdict: "no-ci", reasons: ["no workflows configured"] }) + "\\n");
process.exit(1);`;

test("gather: a complete no-ci verdict at exit 1 is an answer, not a failed read — it is not carried forward (#875)", () => {
  assert.equal(gatherCi({ ciStateBody: NO_CI_EXIT_1, prevCi: "red" }).ci, "unknown");
});

// The refuse side. One write, cut mid-JSON, under two dispositions: the bytes
// are held apart from the exit code deliberately, because the bytes are all
// these two rows share and the disposition is the whole difference between them
// — exit 1 is the salvage arm #875 narrowed; exit 0 (further down) got the
// same narrowing from #1593, closing the arm #875 had deliberately left alone.
const TRUNCATED_WRITE = `import { writeSync } from "node:fs";
writeSync(1, "warning: gh took the slow path\\n{\\"pr\\": 42, \\"status\\": \\"comp");`;
const UNPARSEABLE_EXIT_1 = `${TRUNCATED_WRITE}
process.exit(1);`;

// prev="red" is the assertion: the payload is unusable, so this tick has no
// reading of its own and #262's carry-forward is the entire point. Returning
// the bytes anyway spends a PR's last-known red on an "unknown" nobody
// measured — the regression the exit-code gate was added to prevent, arriving
// through the gate itself. The stderr line has to name the PR and say the
// payload was refused: "ci-state failed" alone cannot be told apart from the
// read never having happened, and an operator looking at a carried-forward
// value needs to know a payload arrived and was thrown away.
test("gather: a payload cut mid-JSON at exit 1 is not a verdict — the previous CI value stands (#875)", () => {
  const r = gatherCi({ ciStateBody: UNPARSEABLE_EXIT_1, prevCi: "red" });
  assert.equal(r.ci, "red");
  assert.match(r.stderr, /--pr 42/);
  assert.match(r.stderr, /parse/);
});

// The signal half of the same class, and its own row because `status` is null
// here rather than a number: the diagnostic has to say the child was KILLED,
// since "exit null" is not a thing an operator can act on, and a fix that
// keyed only on nonzero exit codes would let this row through on a falsy
// status. SIGKILL rather than SIGTERM so the stub cannot handle it and exit
// cleanly instead.
const KILLED_MID_PAYLOAD = `import { writeSync } from "node:fs";
writeSync(1, '{"pr": 42, "status": "comp');
process.kill(process.pid, "SIGKILL");`;

test("gather: a signal-killed ci-state that wrote half a payload carries the previous value forward (#875)", () => {
  const r = gatherCi({ ciStateBody: KILLED_MID_PAYLOAD, prevCi: "red" });
  assert.equal(r.ci, "red");
  assert.match(r.stderr, /SIGKILL/);
});

// The cost of the refusal line, which the single-tick rows above cannot see.
// serve() re-gathers on a timer in ONE process, and a truncation has a cause
// that outlives the tick that hit it, so an ungated line is spent again on
// every tick for as long as the cause lasts — the flood mapCi's `ci-parse` pin
// near the top of this file exists to prevent, arriving through the arm #875
// added. Two PRs because the gate's key is the other half of it: keyed on its
// channel alone, the first refused payload would silence every later PR's line
// for the rest of the run, which is the silence the sibling gate was written
// against. Both PRs still carry their previous value forward — the gate is
// about what is SAID, never about what is read.
test("gather: a refused salvage payload warns ONCE per PR across ticks, and a second PR is not masked", () => {
  const r = gatherCi({ ciStateBody: UNPARSEABLE_EXIT_1, prevCi: "red", prs: [42, 43], ticks: 3 });
  assert.deepEqual(r.ciAll, { 42: "red", 43: "red" });
  const refusals = r.stderr.split("\n").filter((l) => /will not parse/.test(l));
  assert.equal(refusals.length, 2, `expected one line per PR, got ${JSON.stringify(refusals)}`);
  assert.ok(refusals.some((l) => /--pr 42/.test(l)), r.stderr);
  assert.ok(refusals.some((l) => /--pr 43/.test(l)), r.stderr);
});

// #1593. Before this fix, exit 0 was the one arm #875 had deliberately left
// alone: runCiState() returned stdout unconditionally on a successful exit —
// emptiness untested, parseability untested — so this same truncated write,
// delivered at exit 0 instead of exit 1, was the one unparseable payload that
// still reached mapCi, which mapped it to "unknown" and discarded the PR's
// last-known CI value — the #262 regression the salvage gate exists to
// prevent, surviving on the one arm #875 left alone. This used to be #605's
// wiring pin too (the only vehicle that reached mapCi's PR-keyed warn through
// gather() rather than a direct unit call) — that vehicle is gone now that
// runCiState() salvages both arms: mapCi is never called at all on this path
// any more, so the assertion below pins the carry-forward outcome #1593 fixes,
// not the #605 wiring. The #605 pin itself is restored separately, as a
// source-text assertion (see the test after this one) — the only way left to
// catch the PR argument being dropped from a call that can no longer be
// driven to observably differ by argument alone.
const UNPARSEABLE_EXIT_0 = `${TRUNCATED_WRITE}
process.exit(0);`;

test("gather: a payload cut mid-JSON at exit 0 is not a verdict either — the previous CI value stands (#1593)", () => {
  const r = gatherCi({ ciStateBody: UNPARSEABLE_EXIT_0, prevCi: "red" });
  assert.equal(r.ci, "red");
  assert.match(r.stderr, /--pr 42/);
  assert.match(r.stderr, /exit 0/);
  assert.match(r.stderr, /parse/);
});

// #1593, empty half: an empty payload at exit 0 is not a corrupted one — the
// child never answered at all — and "left a payload that will not parse" is
// the wrong diagnosis for it, the same distinction the empty/status-2 branch
// draws for a non-zero exit (see runCiState()). Measured before this fix: an
// empty `out` at exit 0 fell into the same JSON.parse catch as truncated
// bytes and got the same "left a payload that will not parse" wording, even
// though nothing arrived to leave.
const EMPTY_EXIT_0 = `process.exit(0);`;
test("gather: an empty payload at exit 0 says the child never answered, not that it left unparseable bytes", () => {
  const r = gatherCi({ ciStateBody: EMPTY_EXIT_0, prevCi: "red" });
  assert.equal(r.ci, "red");
  assert.match(r.stderr, /--pr 42/);
  assert.match(r.stderr, /exit 0/);
  assert.match(r.stderr, /never answered/);
  assert.doesNotMatch(r.stderr, /will not parse/);
});

// #605, restored: runCiState() now guarantees mapCi only ever receives an
// already-parseable payload from this call site (#1593 closed the exit-0 gap
// #875 had left mapCi's own parse-catch to cover), so mapCi's JSON.parse catch
// — the only code that reads its `pr` argument — can never fire through
// gather(), and no assertion on gather()'s board output can any longer tell
// `mapCi(out, p.number)` apart from `mapCi(out)`. A source-text pin is the
// only remaining way to catch that argument being dropped by accident.
test("gather: the real call site still hands mapCi the PR number, not just the payload (#605)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /\bmapCi\(out, p\.number\)/);
});

// The channel-collision regression: runCiState()'s two salvage arms — the
// catch block's non-zero-exit gate and #1593's exit-0 gate — used to share the
// SAME warnOnce channel ("ci-salvage"), keyed only on the PR. That let a PR
// that hit one arm on an early tick silence a later, structurally different
// failure on the OTHER arm for the rest of the run: no stderr line, no other
// signal. Driven here with a stateful stub that answers exit-1-truncated on
// its first invocation and exit-0-truncated on its second, for the SAME PR —
// both warnings must print.
test("gather: a PR that hits the exit-1 salvage then the exit-0 guard gets BOTH warnings, not just the first", () => {
  const markerDir = tempDir("board-dualarm-");
  const marker = join(markerDir, "tick");
  const DUAL_ARM = `import { writeSync, existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const first = !existsSync(marker);
if (first) writeFileSync(marker, "1");
writeSync(1, "warning: gh took the slow path\\n{\\"pr\\": 42, \\"status\\": \\"comp");
process.exit(first ? 1 : 0);`;
  const r = gatherCi({ ciStateBody: DUAL_ARM, prevCi: "red", ticks: 2 });
  assert.equal(r.ci, "red", "both arms are refusals; the carry-forward value must survive both ticks");
  assert.match(r.stderr, /\(exit 1\) left a payload that will not parse/, "tick 1's salvage warning must print");
  assert.match(r.stderr, /\(exit 0\) left a payload that will not parse/,
    "tick 2's exit-0 warning must print too, not be swallowed by a shared channel");
});

// #786: `gh issue list`/`gh pr list` rows had no per-row shape guard. A row
// missing `number` is the real "reaches the page as literal `undefined`" case
// — compute-board.mjs joins rows to the ledger BY number, so a numberless row
// collided with every other one on the shared `undefined` key. A row missing
// `title` was never that: compute-board.mjs's titleFor() already falls
// through a falsy PR title to the real issue title, and an issue row with no
// title already fell through to the `#<number>` placeholder — both worked
// before this fix. `labels`, unguarded either way, was the real regression:
// a non-array or null-containing `labels` array crashes gather() outright,
// worse than any `undefined` on the page.
//
// Stubs both `gh` reads directly rather than reusing gatherCi's fixed PR row,
// and stubs ci-state.mjs to answer "unknown" unconditionally — the PR loop
// only needs to complete without throwing, its verdict is not what these
// tests pin. Out of process for the same reason as gatherCi: gather() reads
// process.argv and would otherwise read the test runner's.
function gatherRows({ issuesJson, prsJson }) {
  const cwd = tempDir("board-gather-rows-");
  const bin = tempDir("board-gather-rows-bin-");
  const scriptDir = tempDir("board-gather-rows-scripts-");
  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeExecStub(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"issue list") echo '${issuesJson}' ;;\n"pr list") echo '${prsJson}' ;;\n*) exit 1 ;;\nesac\n`);
  const driver = `const { gather } = await import(${JSON.stringify(SCRIPT)});
    const r = await gather({ ledgerFile: ${JSON.stringify(join(cwd, "nope.md"))},
                       prevFile: null, scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify({ issues: r.issues, prs: r.prs }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
}

// tryParse only checks that gh's stdout is valid JSON, not that it is an
// array — a syntactically-valid object payload used to reach withNumber's
// `for...of` and throw "rows is not iterable", contrary to this PR's own
// premise that tryParse "establishes... that it is an array" (#786 review).
test("gather: a non-array gh payload degrades to an empty list, not a crash", () => {
  const r = gatherRows({ issuesJson: JSON.stringify({ not: "an array" }), prsJson: "[]" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: expected an array of rows/);
});

test("gather: a well-formed issue/PR row passes through unchanged", () => {
  const r = gatherRows({
    issuesJson: JSON.stringify([{ number: 9, title: "real title", labels: [] }]),
    prsJson: JSON.stringify([{ number: 10, state: "OPEN", title: "real pr title", labels: [] }]),
  });
  assert.deepEqual(r.issues, [{ number: 9, title: "real title", labels: [] }]);
  assert.deepEqual(r.prs, [{ number: 10, state: "OPEN", title: "real pr title", labels: [] }]);
});

test("gather: an issue row with no number is dropped, loudly, not placed as undefined", () => {
  const r = gatherRows({ issuesJson: JSON.stringify([{ title: "orphan" }]), prsJson: "[]" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: dropping row with no usable number/);
});

test("gather: an issue row missing its title reads as its number, not undefined", () => {
  const r = gatherRows({ issuesJson: JSON.stringify([{ number: 55 }]), prsJson: "[]" });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].number, 55);
  assert.equal(r.issues[0].title, "#55");
});

test("gather: a PR row with no number is dropped, loudly, not placed as undefined", () => {
  const r = gatherRows({ issuesJson: "[]", prsJson: JSON.stringify([{ title: "orphan pr", state: "OPEN" }]) });
  assert.deepEqual(r.prs, []);
  assert.match(r.stderr, /gh pr list: dropping row with no usable number/);
});

// #2108. gh stops a `list` read at `--limit` — 30 when the flag is absent —
// with exit 0 and no warning, so this stub does the same: it holds `issues`
// ready-for-agent tickets and `prs` open PRs and hands back at most the limit
// it was asked for. A gather() that dropped its --limit would be cut at 30
// here exactly as it would be against GitHub, and one that stopped checking
// for a full page would render the cut list as the whole one. The driver runs
// the real computeBoard() over gather()'s answer: the board is the subject.
function gatherCapped({ issues, prs }) {
  const cwd = tempDir("board-gather-capped-");
  const bin = tempDir("board-gather-capped-bin-");
  const scriptDir = tempDir("board-gather-capped-scripts-");
  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeFileSync(join(scriptDir, "ledger.mjs"),
    `process.stdout.write(${JSON.stringify(JSON.stringify({ rows: [], filed: [], ruled: [] }))});\n`);
  writeExecStub(join(bin, "gh"), `#!/usr/bin/env node
const a = process.argv.slice(2);
const i = a.indexOf("--limit");
const limit = i === -1 ? 30 : Number(a[i + 1]);
const rows = (n, row) => Array.from({ length: Math.min(n, limit) }, (_, k) => row(k + 1));
if (a[0] === "issue" && a[1] === "list") process.stdout.write(JSON.stringify(rows(${issues}, (n) => ({ number: n, title: "t", labels: [] }))));
else if (a[0] === "pr" && a[1] === "list") process.stdout.write(JSON.stringify(rows(${prs}, (n) => ({ number: 1000 + n, state: "OPEN", title: "t", labels: [] }))));
else process.exit(1);
`);
  const driver = `const { gather } = await import(${JSON.stringify(SCRIPT)});
    const { computeBoard } = await import(${JSON.stringify(fileURLToPath(new URL("../plugin/scripts/compute-board.mjs", import.meta.url)))});
    const inputs = await gather({ ledgerFile: ${JSON.stringify(join(cwd, "ledger.md"))},
                       prevFile: null, scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    const b = computeBoard(inputs);
    console.log(JSON.stringify({ prs: inputs.prs.length, poolCards: b.tickets.filter((t) => t.column === "POOL").length,
      queue: b.queue, capNotice: b.capNotice }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("#2108: a pool read that fills its --limit renders as a floor and says so, never as an exact count", () => {
  const b = gatherCapped({ issues: 150, prs: 0 });
  assert.equal(b.poolCards, 100, "gather() no longer asks for 100 ready-for-agent tickets");
  assert.equal(b.queue.pool, "100+", "a full page of the pool read was rendered as the exact pool size");
  assert.equal(b.queue.supply, "100+");
  assert.match(b.capNotice ?? "", /ready-for-agent read hit its --limit/);
  assert.doesNotMatch(b.capNotice, /open-PR/, "a pool cap was reported as an open-PR cap too");
});

test("#2108: an open-PR read that fills its --limit is disclosed on the board", () => {
  const b = gatherCapped({ issues: 0, prs: 150 });
  assert.equal(b.prs, 100, "gather() no longer asks for 100 open PRs");
  assert.match(b.capNotice ?? "", /open-PR read hit its --limit/);
  assert.doesNotMatch(b.capNotice, /ready-for-agent/, "an open-PR cap was reported as a pool cap too");
  assert.equal(b.queue.pool, 0, "an open-PR cap turned the pool count into a floor");
});

test("#2108: reads one short of their limit, and past gh's bare default of 30, are exact and silent", () => {
  // The input the guard must ACCEPT: 99 is a complete answer, not a capped
  // one, and 35 is more than gh returns when `--limit` goes missing.
  const b = gatherCapped({ issues: 99, prs: 35 });
  assert.equal(b.queue.pool, 99);
  assert.equal(b.prs, 35, "the open-PR read fell back to gh's default of 30");
  assert.equal(b.capNotice, null, "a read under its limit raised the capped-read notice");
});

test("#2108: a pool read AND an open-PR read that both fill their --limit are both disclosed", () => {
  const b = gatherCapped({ issues: 150, prs: 150 });
  assert.equal(b.queue.pool, "100+", "a simultaneous pool cap was not rendered as a floor");
  assert.equal(b.prs, 100, "gather() no longer asks for 100 open PRs");
  assert.match(b.capNotice ?? "", /ready-for-agent read hit its --limit/, "a simultaneous pool cap was not disclosed");
  assert.match(b.capNotice ?? "", /open-PR read hit its --limit/, "a simultaneous open-PR cap was not disclosed");
  // The two substring matches above would both still pass if the two phrases
  // ran together with no separator, or a different one, between them — this
  // pins the exact joined string so that gap cannot hide behind them.
  assert.equal(b.capNotice,
    "the ready-for-agent read hit its --limit, so POOL may be missing tickets" +
    "; the open-PR read hit its --limit, so a PR past it shows REVIEW with CI unknown",
    "capNotice must join simultaneous cap messages with '; ', not run them together or use a different separator");
});

// #1820 read MERGED from gh; #1840 scoped that read to the ledger's own row
// PRs. One batched `gh api graphql` query asks about exactly the row PRs that
// need it — absent from the open list, carrying no `MERGED <sha>` token, and
// not carried forward as MERGED by #1841 — whatever their merge age. That
// replaced `gh pr list --state merged --limit 100`, which covered only the
// repo's 100 most recent merges (about six days, measured 2026-09-25).
//
// The stub `gh` is a fake GitHub, not an echo of gather(): `api graphql`
// answers every `ALIAS: pullRequest(number: N)` field in the query from
// `states`, and a number missing there reads the way GitHub answers a number
// that is not a PR (measured 2026-09-26, gh 2.101.0): the alias comes back
// null beside a NOT_FOUND error, and gh exits 1 with the whole body on
// stdout. `pr list --state merged` still answers with `window`, the most
// recent merges, so a read that fell back to the window would be caught
// missing the old PR rather than passing by accident. Every invocation's
// argv is logged, so a test can count merged reads. The driver runs the real
// computeBoard() over gather()'s answer: the card's column is the subject.
function gatherMerged({ rows, prs = [], prev = null, states = {}, fail = false, emptyRepo = false }) {
  const cwd = tempDir("board-gather-merged-");
  const bin = tempDir("board-gather-merged-bin-");
  const scriptDir = tempDir("board-gather-merged-scripts-");
  const log = join(cwd, "gh-calls.jsonl");
  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeFileSync(join(scriptDir, "ledger.mjs"),
    `process.stdout.write(${JSON.stringify(JSON.stringify({ rows, filed: [], ruled: [] }))});\n`);
  const window = Array.from({ length: 100 }, (_, i) => ({ number: 5000 + i, state: "MERGED" }));
  const config = { prs: prs.map((n) => ({ number: n, state: "OPEN", title: "t", labels: [] })), window, states, fail, emptyRepo, log };
  writeExecStub(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const c = ${JSON.stringify(config)};
const a = process.argv.slice(2);
fs.appendFileSync(c.log, JSON.stringify(a) + "\\n");
const out = (v) => process.stdout.write(JSON.stringify(v));
if (a[0] === "issue" && a[1] === "list") out([]);
else if (a[0] === "pr" && a[1] === "list" && a.includes("merged")) out(c.window);
else if (a[0] === "pr" && a[1] === "list") out(c.prs);
else if (a[0] === "api" && a[1] === "graphql") {
  if (c.fail) { process.stderr.write("gh: HTTP 502: Bad Gateway\\n"); process.exit(1); }
  if (c.emptyRepo) { out({ data: { repository: {} } }); process.exit(0); }
  const q = a[a.indexOf("-f") + 1];
  const repository = {}; const errors = [];
  for (const [, alias, n] of q.matchAll(/(\\w+)\\s*:\\s*pullRequest\\s*\\(\\s*number\\s*:\\s*(\\d+)\\s*\\)/g)) {
    const state = c.states[n];
    repository[alias] = state ? { number: Number(n), state } : null;
    if (!state) errors.push({ type: "NOT_FOUND", path: ["repository", alias], message: "Could not resolve to a PullRequest with the number of " + n + "." });
  }
  out(errors.length ? { data: { repository }, errors } : { data: { repository } });
  if (errors.length) { process.stderr.write("gh: " + errors.map((e) => e.message).join("\\n") + "\\n"); process.exit(1); }
}
else process.exit(1);
`);
  const prevFile = join(cwd, "prev.json");
  if (prev) writeFileSync(prevFile, JSON.stringify(prev));
  const driver = `const { gather } = await import(${JSON.stringify(SCRIPT)});
    const { computeBoard } = await import(${JSON.stringify(fileURLToPath(new URL("../plugin/scripts/compute-board.mjs", import.meta.url)))});
    const inputs = await gather({ ledgerFile: ${JSON.stringify(join(cwd, "ledger.md"))},
                       prevFile: ${JSON.stringify(prevFile)}, scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    const b = computeBoard(inputs);
    console.log(JSON.stringify({ merged: inputs.merged, columns: Object.fromEntries(b.tickets.map((t) => [t.pr, t.column])) }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // Any read that could answer "merged": the scoped query, or a fallback to
  // the old window. Both count, so a regression to the window cannot hide.
  const mergedReads = calls.filter((c) => c[0] === "api" || c.includes("merged"));
  const asked = (c) => [...c[c.indexOf("-f") + 1].matchAll(/pullRequest\s*\(\s*number\s*:\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), mergedReads, asked, stderr: r.stderr };
}

test("#1840: a row PR merged outside the most-recent-100 window renders MERGED with no previous board", () => {
  const r = gatherMerged({ rows: ["#907 impl-907=PR#930"], states: { 930: "MERGED" } });
  assert.equal(r.columns[930], "MERGED", r.stderr);
  assert.deepEqual(r.merged, [930]);
  assert.equal(r.mergedReads.length, 1);
  assert.deepEqual(r.asked(r.mergedReads[0]), [930]);
});

test("#1840: a tick whose row PRs are all open, token-MERGED or carried forward makes no merged read", () => {
  const r = gatherMerged({
    rows: [
      "#901 impl-901=PR#931",
      "#902 impl-902=PR#932 → MERGED 73b356de",
      "#903 impl-903=PR#933",
      "#904 impl-904",
      "#905 excluded · behind-pr:#931",
    ],
    prs: [931],
    prev: { tickets: [{ issue: 903, pr: 933, column: "MERGED", sinceEnteredStage: 1 }] },
  });
  assert.deepEqual(r.mergedReads, [], "nothing needed a merged read, so none was made");
  assert.deepEqual(r.merged, []);
  assert.equal(r.columns[931], "REVIEW");
  assert.equal(r.columns[932], "MERGED");
  assert.equal(r.columns[933], "MERGED");
});

test("#1840: the merged lookup is ONE gh invocation asking about exactly the row PRs that need it", () => {
  const r = gatherMerged({
    rows: [
      "#901 impl-901=PR#931",
      "#902 impl-902=PR#932 → MERGED 73b356de",
      "#903 impl-903=PR#933",
      "#906 impl-906=PR#930",
      "#907 impl-907=PR#940",
      "#908 impl-908=PR#950",
      "#909 impl-909=PR#960",
    ],
    prs: [931],
    prev: { tickets: [{ issue: 903, pr: 933, column: "MERGED", sinceEnteredStage: 1 }] },
    states: { 930: "MERGED", 940: "CLOSED", 950: "MERGED", 960: "OPEN" },
  });
  assert.equal(r.mergedReads.length, 1, JSON.stringify(r.mergedReads));
  assert.deepEqual(r.asked(r.mergedReads[0]).sort((a, b) => a - b), [930, 940, 950, 960],
    "open 931, token-MERGED 932 and carried-forward 933 are not asked about");
  assert.deepEqual(r.merged, [930, 950]);
  assert.equal(r.columns[930], "MERGED");
  assert.equal(r.columns[940], "REVIEW", "closed unmerged stays REVIEW");
  assert.equal(r.columns[950], "MERGED");
  assert.equal(r.columns[960], "REVIEW", "open but beyond the open list is not merged");
});

test("#1840: a failed merged lookup keeps #1841's rule — carried forward stays MERGED, the rest reads REVIEW", () => {
  const r = gatherMerged({
    rows: ["#903 impl-903=PR#933", "#907 impl-907=PR#930"],
    prev: { tickets: [{ issue: 903, pr: 933, column: "MERGED", sinceEnteredStage: 1 }] },
    states: { 930: "MERGED" },
    fail: true,
  });
  assert.equal(r.mergedReads.length, 1);
  assert.deepEqual(r.merged, []);
  assert.equal(r.columns[933], "MERGED");
  assert.equal(r.columns[930], "REVIEW");
  assert.match(r.stderr, /merged read .*failed/);
});

// A row whose PR number GitHub cannot resolve as a PR — a typo, or an
// amendment-2a row keyed by an issue number — makes gh exit 1, but the body
// still answers every other number. Refusing the whole answer would let one
// bad row put every cold-start merged PR back in REVIEW on every tick.
test("#1840: one unresolvable number does not poison the batch — the PRs gh did answer still count", () => {
  const r = gatherMerged({
    rows: ["#907 impl-907=PR#930", "#908 impl-908=PR#1840"],
    states: { 930: "MERGED" },
  });
  assert.equal(r.mergedReads.length, 1);
  assert.deepEqual(r.merged, [930]);
  assert.equal(r.columns[930], "MERGED");
  assert.equal(r.columns[1840], "REVIEW");
});

// #1840 review: real GitHub always answers every requested `p<N>` alias
// (null or an object), never omits one — so `data.repository` present with
// NONE of the requested keys is not a shape the API produces, only a
// corrupted/truncated one, and readMerged() must not read it as "checked,
// nothing merged": it has to fail loudly (log + carry-forward/REVIEW) the
// same as any other unusable answer, not silently.
test("#1840: an object data.repository naming none of the requested PRs is a failed read, not a clean zero-merged answer", () => {
  const r = gatherMerged({
    rows: ["#907 impl-907=PR#930", "#908 impl-908=PR#931"],
    emptyRepo: true,
  });
  assert.equal(r.mergedReads.length, 1);
  assert.deepEqual(r.merged, []);
  assert.match(r.stderr, /merged read \(2 PRs\) failed \(exit 0\) with no usable answer/,
    "an empty-but-object repository must still log a failed-read line, not read as a clean empty answer");
  assert.equal(r.columns[930], "REVIEW");
  assert.equal(r.columns[931], "REVIEW");
});

// `state` and `title` used to default to a sentinel ("UNKNOWN" / `#<number>`)
// on a PR row. Both defaults are gone: `state`'s only consumer is
// `pr.state === "OPEN"` (compute-board.mjs), already false for `undefined`
// exactly as it was for "UNKNOWN" — an inert guard. `title`'s default made a
// titleless PR row unconditionally truthy, which SILENTLY DISABLED titleFor()'s
// existing fallback to the real issue title (see compute-board.test.mjs for
// the column-placement pin this can't reach — `open`, the boolean `state`
// feeds, is itself never read past that comparison). Raw passthrough, pinned
// here as gather()'s actual output shape.
test("gather: a PR row missing state/title passes through raw, not coerced to a sentinel", () => {
  const r = gatherRows({ issuesJson: "[]", prsJson: JSON.stringify([{ number: 77 }]) });
  assert.equal(r.prs.length, 1);
  // Round-tripped through JSON (gatherRows' driver), so an undefined value
  // survives as an absent key, not a key holding `undefined` — same as what
  // JSON.stringify(model) already does to board.json on every real tick.
  assert.deepEqual(r.prs[0], { number: 77, labels: [] });
});

// The #786 regression review reproduced this live: `labels` was the one field
// this PR's own guard comment claimed was covered ("a row without a usable
// field... doesn't fail the tick") but was never actually guarded — a
// non-array `labels` throws `TypeError: ... .map is not a function`, crashing
// gather() entirely rather than degrading the row.
test("gather: a non-array labels field degrades to [], not a TypeError crash", () => {
  const r = gatherRows({
    issuesJson: JSON.stringify([{ number: 1, title: "t", labels: "not-an-array" }]),
    prsJson: JSON.stringify([{ number: 2, title: "t", state: "OPEN", labels: "not-an-array" }]),
  });
  assert.deepEqual(r.issues[0].labels, []);
  assert.deepEqual(r.prs[0].labels, []);
});

// The second reproduced crash: a `labels` array whose elements are the right
// TYPE (an array) but a WRONG-shaped or null element throws reading `.name`.
test("gather: a malformed element inside labels is dropped, not the whole row", () => {
  const r = gatherRows({
    issuesJson: JSON.stringify([{ number: 1, title: "t", labels: [{ name: "keep" }, null, {}] }]),
    prsJson: "[]",
  });
  assert.deepEqual(r.issues[0].labels, ["keep"]);
});

test("createBoardServer serves board.json and the page", async () => {
  const dir = tempDir("board-");
  writeFileSync(join(dir, "board.json"), JSON.stringify({ generatedAt: 1, tickets: [], attention: [] }));
  writeFileSync(join(dir, "board.html"), "<!doctype html><title>cockpit</title>");
  const server = createBoardServer(dir);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const j = await fetch(`http://127.0.0.1:${port}/board.json`);
  assert.equal(j.status, 200);
  assert.equal((await j.json()).generatedAt, 1);

  const h = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(h.status, 200);
  assert.match(await h.text(), /cockpit/);

  const nf = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(nf.status, 404);

  await new Promise((res) => server.close(res));
});

// The Host-header guard is a socket-level property, so these tests speak raw
// HTTP over a real TCP connection to the loopback bind: a client library would
// normalise or refuse the very headers under test (a missing Host, an
// uppercase name). Every request goes out as HTTP/1.0, the one version where
// Host is optional, so the no-Host case can be sent at all (Node answers an
// HTTP/1.1 request without one 400 itself) and the reply is unchunked.
async function rawStatus(port, path, host) {
  const lines = [`GET ${path} HTTP/1.0`];
  if (host !== undefined) lines.push(`Host: ${host}`);
  lines.push("", "");
  const socket = connect({ host: "127.0.0.1", port });
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (c) => { raw += c; });
  // latin1, so a char in U+0080..U+00FF goes out as the one obs-text byte a
  // header value may carry, which is how Node hands it back to the handler.
  socket.write(lines.join("\r\n"), "latin1");
  await new Promise((res, rej) => { socket.once("close", res); socket.once("error", rej); });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  assert.ok(status, `no HTTP status line in ${JSON.stringify(raw)}`);
  return { status: Number(status[1]), body: raw.slice(raw.indexOf("\r\n\r\n") + 4) };
}

// The server runs in this process, so its refusal log lands on this
// console.error: every Host-guard test captures it, hands the lines to `fn`,
// and keeps them off the test runner's stderr. The once-per-Host gate is
// process-wide, so each test refuses Host values no other test sends.
async function withBoardServer(fn) {
  const dir = tempDir("board-host-");
  writeFileSync(join(dir, "board.json"), JSON.stringify({ generatedAt: 1, tickets: [], attention: [] }));
  writeFileSync(join(dir, "board.html"), "<!doctype html><title>cockpit</title>");
  const server = createBoardServer(dir);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); };
  try { await fn(server.address().port, logged); } finally {
    console.error = original;
    await new Promise((res) => server.close(res));
  }
}

test("createBoardServer answers 403 to a Host that is not a loopback name, on every path", async () => {
  await withBoardServer(async (port) => {
    const foreign = [`evil.example.com:${port}`, "rebound.attacker.test", `127.0.0.1.evil.test:${port}`, `localhost.evil.test:${port}`, `evil.test:${port}@localhost`, `[::2]:${port}`];
    // Names next to loopback that are not on the allow-list, and a loopback
    // name embedded in a longer value: the allow-list is an exact match on a
    // whole-value hostname, so none of these is a loopback Host.
    const lookalikes = [`0.0.0.0:${port}`, "0.0.0.0", "::1", "evil.test:localhost", "x[::1]"];
    // A loopback name with anything after it: only the end anchor of the Host
    // grammar refuses these, so a regex that stops at the name accepts them.
    const trailing = ["[::1]evil.test", `[::1]:${port}x`, "localhost/x", `localhost:${port}/x`, `localhost:${port} evil`, `127.0.0.1:${port} x`];
    for (const host of [...foreign, ...lookalikes, ...trailing]) {
      for (const path of ["/board.json", "/board.html", "/", "/nope"]) {
        const r = await rawStatus(port, path, host);
        assert.equal(r.status, 403, `${host} ${path}`);
        assert.doesNotMatch(r.body, /generatedAt|cockpit/, `${host} ${path} leaked the board`);
      }
    }
  });
});

test("createBoardServer answers 403 to a request with no Host header, and logs it once under a placeholder", async () => {
  await withBoardServer(async (port, logged) => {
    for (let i = 0; i < 3; i++) {
      const r = await rawStatus(port, "/board.json", undefined);
      assert.equal(r.status, 403);
      assert.equal(r.body, "forbidden");
    }
    assert.deepEqual(logged, ["board: refused a request with no Host header — not a loopback name (127.0.0.1, localhost, [::1]); answered 403"]);
  });
});

test("createBoardServer logs each refused Host once on stderr and still answers 403 forbidden", async () => {
  await withBoardServer(async (port, logged) => {
    const hosts = ["evil.com", "localhost.", `[0:0:0:0:0:0:0:1]:${port}`];
    for (const host of hosts) {
      for (let i = 0; i < 5; i++) {
        const r = await rawStatus(port, i % 2 ? "/nope" : "/board.json", host);
        assert.equal(r.status, 403, host);
        assert.equal(r.body, "forbidden", host);
      }
    }
    assert.deepEqual(logged, hosts.map((h) => `board: refused Host ${JSON.stringify(h)} — not a loopback name (127.0.0.1, localhost, [::1]); answered 403`));
  });
});

test("createBoardServer renders a refused Host escaped and truncated, on one line", async () => {
  await withBoardServer(async (port, logged) => {
    const quoted = 'q"uo\\te\tx';
    // U+0085 is NEL, a C1 control JSON.stringify leaves bare.
    const c1 = "nel\u0085x";
    const long = `${"a".repeat(300)}.test`;
    for (const host of [quoted, c1, long]) assert.equal((await rawStatus(port, "/", host)).status, 403, host);
    assert.equal(logged.length, 3, logged.join("\n"));
    for (const line of logged) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, line);
    assert.match(logged[0], /^board: refused Host "q\\"uo\\\\te\\tx" — /);
    assert.match(logged[1], /^board: refused Host "nel\\u0085x" — /);
    assert.match(logged[2], new RegExp(`^board: refused Host "${"a".repeat(100)}"… \\(305 chars\\) — `));
  });
});

test("renderRefusedHost escapes DEL, every C1 control and both line separators, and nothing next to them", () => {
  // The bytes of a Host header reach the server one code unit each (latin1),
  // so U+2028/U+2029 and DEL cannot arrive through a raw request: the
  // renderer is the only place the full set is pinned.
  for (const c of ["\u007f", "\u0080", "\u0085", "\u009f", "\u2028", "\u2029"]) {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    assert.equal(renderRefusedHost(`a${c}b`), `Host "a\\u${hex}b"`, hex);
  }
  for (const c of ["~", "\u00a0"]) assert.equal(renderRefusedHost(`a${c}b`), `Host "a${c}b"`, c.charCodeAt(0).toString(16));
});

test("createBoardServer cuts a refused Host after exactly 100 characters", async () => {
  await withBoardServer(async (port, logged) => {
    const at100 = `${"b".repeat(95)}.test`;
    const at101 = `${"b".repeat(96)}.test`;
    for (const host of [at100, at101]) assert.equal((await rawStatus(port, "/", host)).status, 403, host);
    assert.equal(logged.length, 2, logged.join("\n"));
    assert.match(logged[0], new RegExp(`^board: refused Host "${"b".repeat(95)}\\.test" — `));
    assert.match(logged[1], new RegExp(`^board: refused Host "${"b".repeat(96)}\\.tes"… \\(101 chars\\) — `));
  });
});

test("createBoardServer keys the once-per-Host gate on the cut rendering, so two Hosts alike for 100 characters and in length log one line", async () => {
  await withBoardServer(async (port, logged) => {
    for (const host of [`${"c".repeat(100)}X.test`, `${"c".repeat(100)}Y.test`]) assert.equal((await rawStatus(port, "/", host)).status, 403, host);
    assert.equal(logged.length, 1, logged.join("\n"));
    assert.match(logged[0], new RegExp(`^board: refused Host "${"c".repeat(100)}"… \\(106 chars\\) — `));
  });
});

test("createBoardServer stops logging new refused Hosts at a fixed cap of 16, with one notice", async () => {
  await withBoardServer(async (port, logged) => {
    // A Host repeated past the cap spends one slot, not twenty: it leaves no
    // notice behind, and the distinct Hosts after it are still logged.
    for (let i = 0; i < 20; i++) assert.equal((await rawStatus(port, "/", "cap-repeat.test")).status, 403);
    assert.equal(logged.length, 1, logged.join("\n"));
    for (let i = 0; i < 100; i++) assert.equal((await rawStatus(port, "/", `cap-${i}.test`)).status, 403);
    const line = (h) => `board: refused Host "${h}" — not a loopback name (127.0.0.1, localhost, [::1]); answered 403`;
    const distinct = Array.from({ length: 15 }, (_, i) => `cap-${i}.test`);
    assert.deepEqual(logged, [
      ...["cap-repeat.test", ...distinct].map(line),
      "board: 16 distinct Hosts refused; further refused Hosts are not logged",
    ]);
    // Past the cap, a Host already logged is still not logged again.
    assert.equal((await rawStatus(port, "/", "cap-0.test")).status, 403);
    assert.equal(logged.length, 17);
  });
});

test("createBoardServer serves every loopback Host name, any port, any case, and logs nothing for them", async () => {
  await withBoardServer(async (port, logged) => {
    // The port is deliberately not compared (an ssh -L forward arrives under a
    // different one), so a mismatched port and a missing port must both pass.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`, `LocalHost:${port}`, `[::1]:1`, "127.0.0.1", "localhost"]) {
      const j = await rawStatus(port, "/board.json", host);
      assert.equal(j.status, 200, host);
      assert.equal(JSON.parse(j.body).generatedAt, 1, host);
      assert.equal((await rawStatus(port, "/board.html", host)).status, 200, host);
      assert.equal((await rawStatus(port, "/nope", host)).status, 404, host);
    }
    assert.deepEqual(logged, []);
  });
});

// ── the spend transcript layer ────────────────────────────────────────────────
// Both bugs this file now pins were invisible to the pure-module tests, because
// both live in the I/O that feeds them: a wrong path and a wrong summation. Each
// failed silently as "panel hidden" or "plausible but 3x too big".

test("findSubagentsDir picks the session with the newest transcript", () => {
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  const older = join(proj, "2026-09-08T13-13-27-300Z_11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const newer = join(proj, "2026-09-09T02-00-00-000Z_22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  mkdirSync(older, { recursive: true });
  mkdirSync(newer, { recursive: true });
  // Ranking reads the newest *.jsonl mtime, so stamp the TRANSCRIPTS, not the
  // dirs. Stamp both explicitly rather than sleeping for a clock tick: both are
  // created inside the same millisecond on a fast filesystem, `mtimeMs` ties,
  // and the sort is stable — a tie would resolve to readdir order and the
  // OLDER directory would win on name.
  writeFileSync(join(older, "agent-a.jsonl"), "");
  utimesSync(join(older, "agent-a.jsonl"), new Date(1000), new Date(1000));
  writeFileSync(join(newer, "agent-b.jsonl"), "");
  utimesSync(join(newer, "agent-b.jsonl"), new Date(9000), new Date(9000));

  assert.equal(findSubagentsDir(home, join(home, "x")), newer);
  // Unresolvable path is a bug, not an empty run — it must be distinguishable.
  assert.ok(findSubagentsDir(home, "/nonexistent").error);
});

test("session ranking uses transcript mtime, not directory mtime", () => {
  // Regression: a directory's mtime moves when an entry is CREATED, never when a
  // file inside it is appended to. Ranking on it tracked the last agent spawn,
  // so a session that spawned all its agents early lost to a newer, idle one —
  // and since the cockpit starts before the first agent spawns, that was the
  // common case at run start. The board would show a PREVIOUS run's spend.
  //
  // The two rankings only disagree when the newest DIRECTORY is not the one
  // holding the newest TRANSCRIPT, so the fixture has to build exactly that and
  // nothing weaker. Creating the busy dir's transcript LAST — the shape this
  // test had before — bumps that dir's own mtime as a side effect, so both
  // rankings then pick `busy` for different reasons and the test stayed green
  // with the fix fully reverted. Stamp all four times explicitly, files before
  // dirs: creating a file is the one operation that moves its parent's mtime,
  // and rewriting an existing file's mtime does not.
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  const busy = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");   // spawned its agents early, still appending
  const idle = join(proj, "2026-09-09T02-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");   // spawned one last agent, then went quiet
  mkdirSync(busy, { recursive: true });
  mkdirSync(idle, { recursive: true });
  writeFileSync(join(busy, "agent-b.jsonl"), "");
  writeFileSync(join(idle, "agent-i.jsonl"), "");
  utimesSync(join(busy, "agent-b.jsonl"), new Date(9000), new Date(9000)); // newest TRANSCRIPT
  utimesSync(join(idle, "agent-i.jsonl"), new Date(1000), new Date(1000));
  utimesSync(busy, new Date(1000), new Date(1000));
  utimesSync(idle, new Date(9000), new Date(9000));                        // newest DIRECTORY

  assert.equal(findSubagentsDir(home, join(home, "x")), busy);
});

test("one unreadable session directory loses the ranking instead of sinking the lookup", () => {
  // Regression: newestTranscriptMs' readdirSync sat outside its per-file try and
  // inside findSubagentsDir's, so one bad sibling turned the WHOLE lookup into
  // { error } and the board rendered "spend unavailable" over a perfectly
  // readable live session — a blackout where the per-file catch beside it
  // already chose degradation. A candidate we cannot read must score 0 and lose.
  //
  // The bad sibling is a regular FILE where a directory is expected: EISDIR/
  // ENOTDIR is the same uncaught throw and, unlike a permission bit, it still
  // throws when the suite runs as root.
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  const good = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  mkdirSync(good, { recursive: true });
  writeFileSync(join(good, "agent-a.jsonl"), "");
  const badName = "2026-09-09T02-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  mkdirSync(join(proj, badName, "nested"), { recursive: true });
  chmodSync(join(proj, badName), 0o000);
  try {
    assert.equal(findSubagentsDir(home, join(home, "x")), good);
  } finally {
    chmodSync(join(proj, badName), 0o755);
  }
});

// ── #1716: the omp tree ───────────────────────────────────────────────────────
// Shaped like the real ~/.omp/agent/sessions/<encoded-cwd>/ (the same shape
// member-record.test.mjs's real-tree fixture pins): each session's MAIN
// transcript is a plain `<ISO>_<uuid>.jsonl` FILE sibling to its `<ISO>_<uuid>/`
// DIRECTORY, which holds one `<AgentId>.jsonl` per member, plus a directory
// per member that dispatched members of its own. Lines are the measured
// shapes member-record.mjs's foldOmpTranscript comment records.
const OMP_A = "2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127";
const OMP_B = "2026-09-09T02-00-00-000Z_cafef00d-cafe-cafe-cafe-cafef00dcafe";

function ompTranscript({ agent, task, model = "claude-opus-5", turns = [] } = {}) {
  const lines = [
    { type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd: "/w" },
    { type: "session_init", id: "i1", parentId: null, timestamp: "2026-09-08T15:11:49.495Z", task, agent, resolvedModelIdentity: `anthropic/${model}` },
    ...turns.map((u, i) => ({
      type: "message", id: `m${i}`, parentId: "i1", timestamp: "2026-09-08T15:12:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], model, usage: { ...u, totalTokens: 0, cost: { total: 0.01 } } },
    })),
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// A $HOME whose cwd sits under it, so the encoded project dir is the
// home-relative form (`-dev-repo`) and needs no realpath of a cwd that does
// not exist. encodeProjectDir is the real encoder, not a hand-rolled path.
function ompHome() {
  const home = tempDir("spend-omp-home-");
  const cwd = join(home, "dev", "repo");
  const proj = join(home, ".omp", "agent", "sessions", encodeProjectDir(cwd, { home }));
  mkdirSync(proj, { recursive: true });
  return { home, cwd, proj };
}

// One session: its member transcripts (a `/` in a name nests it, the way a
// member's own members are laid out) stamped `mtime`, and its main-session
// file beside the directory, stamped NOW so it is the newest transcript in
// the whole tree — a lookup or a gather that reads it cannot pass.
function ompSession(proj, name, members, mtime) {
  const dir = join(proj, name);
  mkdirSync(dir, { recursive: true });
  for (const [agent, text] of Object.entries(members)) {
    const file = join(dir, `${agent}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (mtime != null) utimesSync(file, new Date(mtime), new Date(mtime));
  }
  writeFileSync(join(proj, `${name}.jsonl`), ompTranscript({ turns: [{ input: 1, output: 1, cacheRead: 1, cacheWrite: 999_999 }] }));
  return dir;
}

test("findSubagentsDir on omp picks this workspace's newest session DIRECTORY — never the main-session file beside it, never a stray dir", () => {
  const { home, cwd, proj } = ompHome();
  const older = ompSession(proj, OMP_A, { "impl-1": ompTranscript() }, 1000);
  const newer = ompSession(proj, OMP_B, { "impl-2": ompTranscript() }, 9000);
  // Not `<ISO>_<uuid>`, and holding the newest member-shaped transcript of all.
  mkdirSync(join(proj, "notes"));
  writeFileSync(join(proj, "notes", "x.jsonl"), "");
  utimesSync(join(proj, "notes", "x.jsonl"), new Date(20000), new Date(20000));

  // No session tree at all yet: resolves cleanly, does not error.
  assert.equal(findSubagentsDir(home, cwd), newer);
  utimesSync(join(older, "impl-1.jsonl"), new Date(30000), new Date(30000));
  assert.equal(findSubagentsDir(home, cwd), older, "the ranking reads member transcripts, so it follows them");
});

test("findSubagentsDir on omp follows a NESTED member's mtime, not just the session dir's top-level files", () => {
  // #1867 review: a session whose only fresh activity is a member ONE LEVEL
  // DOWN (its own further fan-out — a dispatcher blocked on its task tool
  // while its specialists run) must still outrank a stale sibling session.
  // Regression for a scan bounded to a session dir's direct children only.
  const { home, cwd, proj } = ompHome();
  const liveViaNested = ompSession(proj, OMP_A, { "impl-1": ompTranscript() }, 1000);
  const staleSibling = ompSession(proj, OMP_B, { "impl-2": ompTranscript() }, 5000);
  const nestedFile = join(liveViaNested, "review-pr-9", "Security.jsonl");
  mkdirSync(dirname(nestedFile), { recursive: true });
  writeFileSync(nestedFile, ompTranscript({ agent: "fleet-review-correctness" }));
  utimesSync(nestedFile, new Date(90000), new Date(90000));

  assert.equal(findSubagentsDir(home, cwd), liveViaNested,
    "the nested member's fresher mtime must win the ranking, not lose to staleSibling's stale top-level file");
});

test("findSubagentsDir: an EACCES resolving the omp encoding (not ENOENT) surfaces as an error", () => {
  // #1867 review: ompSessionDirs's catch around encodeProjectDir must only
  // swallow ENOENT ("this cwd doesn't exist" — the documented case). Any
  // other error (EACCES on an ancestor, here) is a real fault and must
  // propagate, never be silently relabelled as "no omp session".
  const home = tempDir("spend-eacces-home-");
  const outer = tempDir("spend-eacces-outer-");
  const blocked = join(outer, "blocked");
  mkdirSync(blocked);
  const cwd = join(blocked, "sub", "repo");
  mkdirSync(cwd, { recursive: true });
  chmodSync(blocked, 0o000);
  try {
    const result = findSubagentsDir(home, cwd);
    assert.ok(result && typeof result === "object" && "error" in result, "it must surface as a lookup error, the same as any other real fault");
  } finally {
    chmodSync(blocked, 0o755);
  }
});

test("with no session tree present the lookup is an error that names where it looked", () => {
  const home = tempDir("spend-omp-home-");
  const r = findSubagentsDir(home, join(home, "dev", "repo"));
  assert.match(r.error, /\.omp[\\/]agent[\\/]sessions/);
});

test("the pin's launchMs gate holds on an omp tree: a session predating launch is followed, the first to write on its watch latches", () => {
  const { home, cwd, proj } = ompHome();
  const mine = ompSession(proj, OMP_A, { "impl-1": ompTranscript() }, Date.now() - 100000);
  const theirs = ompSession(proj, OMP_B, { "impl-2": ompTranscript() }, Date.now() - 200000);
  const pin = spendDirPin(undefined, home, cwd);
  assert.equal(pin(), mine, "before anything writes on this pin's watch, it answers from the heuristic's newest");
  utimesSync(join(theirs, "impl-2.jsonl"), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  assert.equal(pin(), theirs, "and re-picks — neither was trustworthy to cache yet");
  utimesSync(join(mine, "impl-1.jsonl"), new Date(Date.now() + 50000), new Date(Date.now() + 50000));
  assert.equal(pin(), theirs, "and holds, because theirs was first to write on this pin's watch");
  assert.equal(findSubagentsDir(home, cwd), mine, "the fixture really did flip — this test proves nothing otherwise");
});

test("an omp session's per-member rows carry exactly readOmpMember's totals, model and role", () => {
  const { proj } = ompHome();
  const members = {
    "impl-7": ompTranscript({ agent: "fleet-implementer", task: "Implement ticket 7", turns: [
      { input: 3, output: 40, cacheRead: 500, cacheWrite: 7000 },
      { input: 1, output: 60, cacheRead: 9000, cacheWrite: 1100 },
    ] }),
    "review-pr-9": ompTranscript({ task: "Review PR 9", model: "claude-sonnet-5", turns: [{ input: 2, output: 20, cacheRead: 300, cacheWrite: 4000 }] }),
    // Nested one level: a member's own member, which readOmpMember books by depth.
    "review-pr-9/Security": ompTranscript({ task: "Check security", model: "claude-haiku-4-5", turns: [{ input: 1, output: 5, cacheRead: 100, cacheWrite: 2500 }] }),
    // Dispatched this second, no assistant turn yet — readOmpMember answers null.
    Fresh: ompTranscript({ agent: "fleet-implementer", task: "Implement ticket 8" }),
  };
  const dir = ompSession(proj, OMP_A, members);
  const expected = Object.entries(members)
    .map(([agent, text]) => readOmpMember(text, join(dir, `${agent}.jsonl`), agent, agent.split("/").length - 1))
    .filter(Boolean);
  // One member per role, so each role bucket below IS one member's row.
  assert.equal(new Set(expected.map((m) => m.role)).size, 3, `fixture: ${expected.map((m) => m.role)}`);

  const s = gatherSpend({ dir });
  assert.equal(s.ok, true);
  assert.equal(s.skipped, 0);
  const sum = (k) => expected.reduce((n, m) => n + m[k], 0);
  // The main-session file beside the dir (999,999 cache-write) is not a member,
  // and the turn-less one has spent nothing, so neither is in these.
  assert.deepEqual(
    { agents: s.totals.agents, cacheWrite: s.totals.cacheWrite, output: s.totals.output, cacheRead: s.totals.cacheRead },
    { agents: 3, cacheWrite: sum("tokens_cache_create"), output: sum("tokens_out"), cacheRead: sum("tokens_cache_read") },
  );
  for (const m of expected) {
    const row = s.top.find((r) => r.label === m.member);
    assert.ok(row, `no row labelled ${m.member}: ${JSON.stringify(s.top)}`);
    assert.deepEqual({ role: row.role, model: row.model, cacheWrite: row.cacheWrite },
      { role: m.role, model: m.model, cacheWrite: m.tokens_cache_create }, m.member);
    const bucket = s.roles.find((r) => r.role === m.role);
    assert.deepEqual({ cacheWrite: bucket.cacheWrite, output: bucket.output, cacheRead: bucket.cacheRead },
      { cacheWrite: m.tokens_cache_create, output: m.tokens_out, cacheRead: m.tokens_cache_read }, m.member);
  }
});

test("an omp session's tool table is attributed per member and merged (#1717)", () => {
  // Lines in the measured tool shapes member-record.mjs's foldOmpTranscript
  // comment records: a `toolCall` block on the assistant message, and each
  // result a `toolResult` message line of its own.
  const msg = (message) => JSON.stringify({ type: "message", id: "m", parentId: "i1", timestamp: "2026-09-08T15:12:00.000Z", message });
  const turn = (cacheWrite, ...calls) => msg({
    role: "assistant", model: "claude-opus-5",
    content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite, totalTokens: 0, cost: { total: 0.01 } },
  });
  const res = (id, toolName, chars) => msg({
    role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "x".repeat(chars) }], details: {}, isError: false, timestamp: 0,
  });
  const { proj } = ompHome();
  const dir = ompSession(proj, OMP_A, {
    "impl-7": [turn(5000, ["a", "read"]), res("a", "read", 300), turn(600, ["b", "bash"]), res("b", "bash", 100), turn(200)].join("\n") + "\n",
    // A nested member's table merges in too: readOmpSpend books every member at any depth.
    "impl-7/Scout": [turn(4000, ["c", "read"]), res("c", "read", 50), turn(900)].join("\n") + "\n",
  });
  const s = gatherSpend({ dir });
  assert.equal(s.ok, true);
  assert.equal(s.totals.cacheWrite, 10_700);
  assert.deepEqual(s.tools.map((t) => [t.tool, t.calls, t.resultChars, t.cacheWrite]), [["read", 2, 350, 1500], ["bash", 1, 100, 200]]);
  // Only 1,700 of the 10,700 total ends up attributed: each member's FIRST
  // turn follows no result, so both first turns (5,000 + 4,000 = 9,000) stay
  // outside the table.
  assert.equal(s.attributedPct.toFixed(2), "15.89");
});

test("an omp session's damaged count is real, not a hardcoded 0 (#1717 review)", () => {
  // The `damaged` block (#916): a mid-file tear
  // now costs more than its own turn's totals once the same fold also feeds
  // the tool table, so this reader has to count it rather than assume 0.
  const msg = (message) => JSON.stringify({ type: "message", id: "m", parentId: "i1", timestamp: "2026-09-08T15:12:00.000Z", message });
  const turn = (cacheWrite) => msg({ role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite, totalTokens: 0, cost: { total: 0.01 } } });
  const TORN = '{"type":"message","message":{"role":"ass';
  const { proj } = ompHome();
  const dir = ompSession(proj, OMP_A, {
    // The tear sits BETWEEN two good turns, so their spend still counts.
    "impl-7": [turn(1000), TORN, turn(500)].join("\n") + "\n",
  });
  const s = gatherSpend({ dir });
  assert.equal(s.ok, true);
  assert.equal(s.totals.cacheWrite, 1500, "the surrounding turns still fold — only the torn line itself is lost");
  assert.equal(s.damaged, 1);
  assert.equal(s.skipped, 0, "booked, not skipped — a damaged line costs its own turn, never the whole member");
});

test("an omp session's torn LAST line stays silent — the tear a live write legitimately produces", () => {
  const msg = (message) => JSON.stringify({ type: "message", id: "m", parentId: "i1", timestamp: "2026-09-08T15:12:00.000Z", message });
  const turn = (cacheWrite) => msg({ role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite, totalTokens: 0, cost: { total: 0.01 } } });
  const TORN = '{"type":"message","message":{"role":"ass';
  const { proj } = ompHome();
  // No trailing newline: the torn write is the final element of the split,
  // the same discriminator foldOmpTranscript's own `malformedNonLastLines` relies on.
  const dir = ompSession(proj, OMP_A, { "impl-7": [turn(1000), TORN].join("\n") });
  const s = gatherSpend({ dir });
  assert.equal(s.ok, true);
  assert.equal(s.totals.cacheWrite, 1000);
  assert.equal(s.damaged, 0);
});

test("one bad transcript in an omp session is skipped and named, not a blackout of the members beside it", () => {
  // readOmpSession lets a wrong-harness refusal propagate (a whole-tree scrape
  // must refuse loudly); on the live panel that is one transcript's fault, so
  // it lands in `skipped` exactly as a broken transcript does.
  const { proj } = ompHome();
  const dir = ompSession(proj, OMP_A, { "impl-7": ompTranscript({ turns: [{ input: 1, output: 1, cacheRead: 1, cacheWrite: 1000 }] }) });
  writeFileSync(join(dir, "Stray.jsonl"), JSON.stringify({ type: "assistant", sessionId: "x", message: { id: "m", usage: {} } }) + "\n");
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.ok, true);
  assert.equal(s.totals.cacheWrite, 1000, "the good member still counts");
  assert.equal(s.skipped, 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Stray\.jsonl/);
});

// #1894: a transcript foldOmpTranscript reads no assistant-with-usage line out
// of has no model, so ompMemberRecord answers null and readOmpSpend books
// nothing — without a throw, so `skipped` stays 0 as well. `damaged` is then
// the only thing that says the directory held a transcript at all, and the
// `!agents.length` branch used to read `skipped` alone: an --spend-dir
// operator was told the directory "holds no agent transcripts", and the
// heuristic's panel simply hid — a destroyed session rendered as one that had
// not started.
test("an omp session whose only transcript is wholly corrupt reports the damage, not an empty directory (#1894)", () => {
  const { proj } = ompHome();
  // Every line unparseable — the ticket's own reproduction, via --spend-dir.
  const allGarbage = ompSession(proj, OMP_A, { "impl-7": "garbage\n{not json\nmore garbage\n" });
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir: allGarbage, explicit: true }); });
  assert.equal(s?.ok, false, JSON.stringify(s));
  assert.match(s.error, /3 damaged transcript lines/);
  assert.deepEqual(errs.filter((e) => /holds no agent transcripts/.test(e)), [], "the directory holds a transcript; saying otherwise is the defect");
  // Its header parses and only the line its spend lives on is lost — the
  // same null from ompMemberRecord, reached from the heuristic, which used to
  // return the silent `null` that hides the panel.
  const initOnly = JSON.stringify({ type: "session_init", id: "i1", parentId: null, timestamp: "2026-09-08T15:11:49.495Z", task: "t", agent: "fleet-implementer" });
  const headerIntact = ompSession(proj, OMP_B, { "impl-8": `${initOnly}\n{"type":"message","message":{"role":"ass\n` });
  const h = gatherSpend({ dir: headerIntact });
  assert.equal(h?.ok, false, JSON.stringify(h));
  assert.match(h.error, /1 damaged transcript line\b/);
});

test("--spend-dir naming the encoded-cwd PROJECT directory is refused, not silently scraped whole (#1302-style)", () => {
  // gatherSpend's `explicit` path hands readOmpSpend one directory, which
  // ompSessionTranscripts then walks recursively with no name check of its
  // own — so naming the project dir (the parent `-dev-repo` directory
  // findSubagentsDir resolves FROM, never the thing itself) instead of one
  // of its `<ISO>_<uuid>` session children used to be silently accepted
  // whole: every session under it booked as "agents", including the
  // project's own main-session transcript.
  const { proj } = ompHome();
  ompSession(proj, OMP_A, { "impl-1": ompTranscript() });
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir: proj, explicit: true }); });
  assert.equal(s?.ok, false, JSON.stringify(s));
  assert.match(s.error, /is not an omp .* session directory/);
  assert.deepEqual(errs.filter((e) => /is not an omp/.test(e)).length > 0, true, "the refusal must actually reach stderr, not just the return value");
});

test("an omp session losing one transcript whole and another to damaged lines names both, not 'all 1 unreadable' (#1894)", () => {
  // The `skipped`-only wording counts whole files: beside a second transcript
  // lost to damaged lines it would claim one transcript was ALL there was.
  const { proj } = ompHome();
  const dir = ompSession(proj, OMP_A, { "impl-7": "garbage\n{not json\n" });
  writeFileSync(join(dir, "Stray.jsonl"), JSON.stringify({ type: "assistant", sessionId: "x", message: { id: "m", usage: {} } }) + "\n");
  let s;
  withStderr(() => { s = gatherSpend({ dir }); }); // Stray's skip line is the skips gate's, not under test
  assert.equal(s.ok, false);
  assert.doesNotMatch(s.error, /all 1 transcripts/);
  // One assertion pinning both substrings AND their relative order — two
  // independent assert.match calls each pass regardless of which clause
  // comes first, so a swap of the unshift/push that builds `lost` (reversing
  // the skipped-clause and the damaged-clause) would slip through unnoticed.
  assert.match(s.error, /1 transcript unreadable; 2 damaged transcript lines/);
});

test("an omp session whose only transcript is a live write's torn first line is still 'nothing yet', not damage (#1894)", () => {
  // The input the new branch must ACCEPT: a member dispatched this second has
  // one partial line and no newline after it. That tail is exactly what
  // foldOmpTranscript declines to count, so this stays the silent null.
  const { proj } = ompHome();
  const dir = ompSession(proj, OMP_A, { "impl-7": '{"type":"session_init","id":"i1","par' });
  assert.equal(gatherSpend({ dir }), null);
});

// ── #1583/#1679: the pin ──────────────────────────────────────────────────────
//
// Two sessions under ONE project directory is the mode this whole ticket is
// about, and no test above drives it across TIME: every findSubagentsDir() case
// builds its fixture, asks once, and stops. The lookup ran inside gatherSpend()
// on every tick (~15s), so the second session merely had to write to take the
// panel over, with nothing on the page or on stderr saying it had.
//
// #1679 narrowed what counts as a trustworthy first answer: a directory whose
// own newest transcript PREDATES the pin's construction can be a previous
// run's session, so it is never latched, only followed — the tests below now
// drive that distinction directly instead of assuming "the first non-null
// answer" was always safe to cache.
test("the pin does not latch a session that predates it — it keeps following the heuristic until one writes on its watch", () => {
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  const mine = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const theirs = join(proj, "2026-09-09T02-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(mine, "agent-a.jsonl"), "");
  writeFileSync(join(theirs, "agent-b.jsonl"), "");
  // Both predate the pin below — stamped well in the past, the same as a
  // session that was already running before this server launched.
  utimesSync(join(mine, "agent-a.jsonl"), new Date(Date.now() - 100000), new Date(Date.now() - 100000));
  utimesSync(join(theirs, "agent-b.jsonl"), new Date(Date.now() - 200000), new Date(Date.now() - 200000));

  const pin = spendDirPin(undefined, home, join(home, "x"));
  assert.equal(pin(), mine, "before anything writes on this pin's watch, it still answers from the heuristic's newest");

  // `theirs` writes AFTER the pin exists — real activity "on my watch", the
  // one signal the old `??=` pin had no way to ask for.
  utimesSync(join(theirs, "agent-b.jsonl"), new Date(), new Date());
  assert.equal(pin(), theirs, "and re-picks, because neither candidate was trustworthy to cache yet");

  // Now it must hold — touching `mine` again, even to a later mtime than
  // `theirs`, must not flip the pin back: `theirs` was the first to clear
  // the bar and that is what latches, not "whichever is newest this tick".
  utimesSync(join(mine, "agent-a.jsonl"), new Date(Date.now() + 50000), new Date(Date.now() + 50000));
  assert.equal(pin(), theirs, "and now holds, because theirs was first to write on this pin's watch");
  assert.equal(findSubagentsDir(home, join(home, "x")), mine, "the fixture really did flip — this test proves nothing otherwise");
});

test("no session at launch is not an answer to pin — the first one to write on this pin's watch wins, and then holds", () => {
  // The launch path this script actually has: the cockpit starts in run-team
  // phase 0, BEFORE the first agent spawns, so the project directory routinely
  // holds no subagents directory at all. Pinning that `null` would hide the
  // spend panel for the entire run — the existing degradation is "hidden until
  // agents land", not "hidden for good", and this is the assertion that keeps
  // the pin from being written as "whatever the first call returned".
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  mkdirSync(proj, { recursive: true });
  const pin = spendDirPin(undefined, home, join(home, "x"));
  assert.equal(pin(), null, "no session yet is the normal state at run start, not a fault");

  const first = join(proj, "2026-09-08T13-13-27-300Z_11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  mkdirSync(first, { recursive: true });
  // Written after the pin already exists — this run's own first activity,
  // not a stale fixture mtime from before launch. The mtime is SET, not left
  // to the write: Linux stamps it from the kernel's coarse clock, so a file
  // written right after spendDirPin() read Date.now() can carry an mtime
  // BEFORE that launchMs and never latch — measured 2026-09-23 in node:26 on
  // Linux, 2378/5000 writes stamped earlier than a Date.now() taken just
  // before them (the flake in CI runs 35834153934 and 35834344502).
  // utimesSync from a later Date.now() cannot land below launchMs.
  writeFileSync(join(first, "agent-a.jsonl"), "");
  utimesSync(join(first, "agent-a.jsonl"), new Date(), new Date());
  assert.equal(pin(), first, "the first real answer, once it postdates launch, latches");

  const second = join(proj, "2026-09-09T02-00-00-000Z_22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "agent-b.jsonl"), "");
  utimesSync(join(second, "agent-b.jsonl"), new Date(Date.now() + 50000), new Date(Date.now() + 50000));
  assert.equal(pin(), first, "and holds against a newer session exactly as a launch-time pin does");
});

test("a transcript stamped a few ms before launchMs is followed, never latched — the pin latches on the first write at or after launchMs itself", (t) => {
  // #1729: every test above stamps mtimes far from launchMs — 100s before it,
  // or from a Date.now() taken after it (#1722) — so nothing pinned what
  // spendDirPin() does a few milliseconds either side of it. The window is
  // real: a transcript written just ahead of this server's launch lands
  // there, and so can one written just AFTER it, because Linux stamps mtimes
  // from the kernel's coarse clock (#1722 measured writes reading back
  // earlier than a Date.now() taken before them). The rule is a strict
  // `newest < launchMs` with no skew allowance: such a session is still
  // ANSWERED — the panel renders it that tick — but not cached, so it is
  // followed tick by tick and latches on its first write stamped at or
  // after launchMs, which a live session's next append provides.
  //
  // launchMs is one Date.now() read inside spendDirPin(), so the clock is
  // mocked for that read alone: launchMs becomes a known constant and every
  // stamp below is an exact offset from it, with no wall clock anywhere. The
  // stamp AT launchMs must read back as exactly launchMs — one that landed a
  // fraction above it would let a `<=` mutant through — so that is asserted
  // rather than trusted. Node 26 round-trips millisecond stamps exactly on
  // APFS and Linux overlayfs alike (measured, #1729); a whole second is a
  // free hedge, leaving no fractional part for a seconds conversion to lose.
  const launchMs = Date.UTC(2026, 0, 1);
  const stamp = (f, ms) => utimesSync(f, new Date(ms), new Date(ms));
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  const mine = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const theirs = join(proj, "2026-09-09T02-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  const mineLog = join(mine, "agent-a.jsonl");
  const theirsLog = join(theirs, "agent-b.jsonl");
  writeFileSync(mineLog, "");
  writeFileSync(theirsLog, "");
  stamp(mineLog, launchMs - 5);
  stamp(theirsLog, launchMs - 60000);

  const clock = t.mock.method(Date, "now", () => launchMs);
  const pin = spendDirPin(undefined, home, join(home, "x"));
  clock.mock.restore();

  assert.equal(pin(), mine, "5 ms before launch is still this tick's answer — the panel renders it");

  // A second session overtakes it while still 1 ms short of launchMs. A pin
  // that had latched `mine` would ignore this; one that only followed it
  // re-picks, and re-picking at 1 ms is the proof there is no skew allowance
  // either — any tolerance of 1 ms or more would latch `theirs` right here.
  stamp(theirsLog, launchMs - 1);
  assert.equal(pin(), theirs, "and was never cached: a session 1 ms before launch takes the answer over");

  // `mine` appends again, stamped exactly ON launchMs: "at or after" is the
  // latch condition, so this is the write that latches. It is also the
  // heuristic's newest, so this tick alone cannot tell latched from
  // followed — the next assertion is what does.
  stamp(mineLog, launchMs);
  assert.equal(statSync(mineLog).mtimeMs, launchMs, "the stamp sits exactly on launchMs — `<` vs `<=` is untested otherwise");
  assert.equal(pin(), mine, "the write at launchMs makes it the answer again");

  stamp(theirsLog, launchMs + 50000);
  assert.equal(pin(), mine, "and holds against a newer session, which only a latch at launchMs itself explains");
  assert.equal(findSubagentsDir(home, join(home, "x")), theirs, "the fixture really did flip — this test proves nothing otherwise");
});

test("an unresolvable transcript tree is never pinned — one stderr line across ticks either way, panel hidden and never zeroed", () => {
  // #1679: `{ error }` is no longer latched (see the recovery test below), so
  // the one-line-per-fault promise can no longer come from caching upstream —
  // it comes from gatherSpend's own warnOnce gate, keyed on the message,
  // which needs nothing cached above it to hold.
  const home = tempDir("spend-home-");
  const pin = spendDirPin(undefined, home, "/nonexistent");

  let first, second;
  const errs = withStderr(() => {
    first = gatherSpend({ dir: pin() });
    second = gatherSpend({ dir: pin() });
  });
  assert.equal(errs.length, 1, "expected one line across two ticks, got " + JSON.stringify(errs));
  for (const s of [first, second]) {
    assert.equal(s.ok, false, "the tag the page hides on");
    assert.ok(s.error, "and a reason, never a zeroed total");
    assert.equal(s.totals, undefined, "an unresolvable directory must not report spend at all");
  }
});

test("an unresolvable transcript tree recovers on its very next tick, because { error } is never latched", () => {
  // The bug #1679 fixed: the old `pinned ??= findSubagentsDir(...)` treated
  // `{ error }` as a permanent answer, so a TRANSIENT fault (EACCES on a
  // directory mid permission-change, EMFILE, EIO — not just the "project dir
  // absent" case the original comment reasoned about) hid the panel forever
  // even once the tree became readable again.
  const home = tempDir("spend-home-");
  const proj = join(home, ".omp", "agent", "sessions", "-x");
  const sess = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "agent-a.jsonl"), "");
  chmodSync(proj, 0o000);
  try {
    const pin = spendDirPin(undefined, home, join(home, "x"));
    const faulted = pin();
    assert.ok(faulted.error, "a scandir EACCES is exactly the 'unresolvable' shape the old pin latched forever");
    chmodSync(proj, 0o755);
    assert.equal(pin(), sess, "the very next tick recovers, because the fault was never cached");
  } finally {
    chmodSync(proj, 0o755);
  }
});

test("--spend-dir's directory replaces the heuristic outright, including one the heuristic could resolve", () => {
  // The override half of the flag: named explicitly, the session ranking is not
  // a tie-breaker, a fallback, or a second opinion. The fixture gives the
  // heuristic a perfectly resolvable session to pick so that "the explicit one
  // wins" is a real preference and not the absence of an alternative.
  const home = tempDir("spend-home-");
  const heuristic = join(home, ".omp", "agent", "sessions", "-x", "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  mkdirSync(heuristic, { recursive: true });
  writeFileSync(join(heuristic, "agent-a.jsonl"), "");
  const named = tempDir("spend-named-");

  assert.equal(findSubagentsDir(home, join(home, "x")), heuristic, "the heuristic has an answer of its own here");
  const pin = spendDirPin(named, home, join(home, "x"));
  assert.equal(pin(), named);
  assert.equal(pin(), named, "and is not re-decided on a later tick either");
});

test("gatherSpend reads a handed-in null as a resolution, not as an absent argument", () => {
  // `dir ?? findSubagentsDir()` could not tell "my caller resolved this and
  // there is no session yet" from "nobody resolved it", so a pinned null ran
  // the lookup a second time inside the same tick — and answered from it,
  // which is the unpinned source this ticket exists to remove. The fixture
  // makes that observable: $HOME here DOES hold a resolvable session, so a
  // re-resolve would return a panel instead of nothing.
  const home = tempDir("spend-home-");
  const live = join(home, ".omp", "agent", "sessions", encodeProjectDir(process.cwd(), { home }), "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "agent-x.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.ok(gatherSpend({}).ok, "the control: with no dir argument at all, that session IS found");
    assert.equal(gatherSpend({ dir: null }), null, "a resolved-to-nothing caller must not be re-resolved");
  } finally { process.env.HOME = realHome; }
});

// The acceptance criterion end to end, and the only row here that can fail on
// serve() dropping the pin between the resolution and the tick: every
// assertion above is reachable with `spendDir:` never threaded into gather()
// at all. A REAL server, two sessions under one project directory, and the
// second one writing between two ticks — the exact shape the panel used to
// alternate on, at the interval it used to alternate at.
//
// #1679: both fixture sessions predate the server's own launch (ancient
// synthetic mtimes), the same shape as a workspace that already had
// unrelated sessions sitting there when this `serve` started — neither is
// trustworthy to latch on sight any more. So the session that WRITES first
// ON THIS SERVER'S WATCH is what latches, not whichever the heuristic
// happened to already prefer between two equally-untrusted candidates.
test("CLI: a live serve keeps the panel on the session that wrote first on its watch, even as another writes later", async () => {
  // realpath, not the bare mkdtemp path: on darwin $TMPDIR is under /var, a
  // symlink to /private/var, and the child's process.cwd() reports the RESOLVED
  // form — encoding the unresolved one puts the fixture where nothing looks.
  const cwd = realpathSync(tempDir("spend-pin-cwd-"));
  const home = tempDir("spend-pin-home-");
  const bin = tempDir("spend-pin-bin-");
  // gh fails on every call and the reads degrade, so this stays offline and off
  // this repo's live issue list. Prepended rather than replacing PATH: gather()
  // shells out to `node` for the ledger read.
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  const proj = join(home, ".omp", "agent", "sessions", encodeProjectDir(cwd, { home }));
  const mine = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const theirs = join(proj, "2026-09-09T02-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  // With no sidecar the panel labels an agent by its filename stem, so the
  // board itself names which session it read — no second fixture needed for it.
  const turn = TURN.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(mine, "session-a.jsonl"), turn);
  utimesSync(join(mine, "session-a.jsonl"), new Date(9000), new Date(9000));
  writeFileSync(join(theirs, "session-b.jsonl"), turn);
  utimesSync(join(theirs, "session-b.jsonl"), new Date(1000), new Date(1000));

  const p = spawn(process.execPath, serveArgs(["--port", "0", "--interval", "1"]), {
    cwd, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  try {
    const jsonPath = join(cwd, ".fleet", "board.json");
    const until = (pred, what) => withTimeout((async () => {
      for (;;) {
        let b = null;
        try { b = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { /* not written yet, or mid-rename */ }
        if (b && pred(b)) return b;
        await new Promise((r) => setTimeout(r, 50));
      }
    })(), 20000, what);

    // Wait for the server to have ticked at least once before touching either
    // fixture's mtime — this pins spendDirPin()'s launchMs strictly before the
    // touch below, which is the only way the touch can land ON its watch.
    await until((b) => b.spend?.ok, "the first tick that reads a transcript");

    // `mine` writes on this server's watch: this is what latches it, per
    // #1679's rule — not merely being the heuristic's current favorite.
    utimesSync(join(mine, "session-a.jsonl"), new Date(), new Date());
    const minedAt = Date.now();
    const first = await until((b) => b.spend?.ok && b.generatedAt > minedAt, "a tick generated after session-a writes on this server's watch");
    assert.equal(first.spend.top[0].label, "session-a", "the session that wrote on this server's watch is read");

    // The other session writes later: a second run starting, an agent landing.
    utimesSync(join(theirs, "session-b.jsonl"), new Date(), new Date());
    const flippedAt = Date.now();
    assert.equal(findSubagentsDir(home, cwd), theirs,
      "the fixture no longer flips the heuristic — this test would prove nothing");

    // Strictly a board GENERATED after the flip, not merely a different one: a
    // tick that started before it could answer "session-a" for the old reason.
    const later = await until((b) => b.spend?.ok && b.generatedAt > flippedAt, "a tick generated after the flip");
    assert.equal(later.spend.top[0].label, "session-a",
      "a later tick re-picked the newest session instead of answering from the pin");
  } finally { p.kill("SIGKILL"); }
});

test("one unreadable transcript does not take the whole panel down", () => {
  const dir = fixture(TURN);
  mkdirSync(join(dir, "agent-trap.jsonl")); // a directory where a file is expected
  const s = gatherSpend({ dir });
  assert.equal(s.totals.cacheWrite, 1000); // the good agent still counted
  assert.equal(s.skipped, 1);
});

// One assistant turn, the omp envelope's own shape (member-record.mjs's
// foldOmpTranscript comment): one usage object per turn, no fold-back needed.
const TURN = [
  { type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd: "/w" },
  { type: "message", id: "m1", parentId: "s1", timestamp: "2026-09-08T15:12:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5",
      usage: { input: 2, output: 1, cacheRead: 50, cacheWrite: 1000, totalTokens: 0, cost: { total: 0.01 } } } },
];

function fixture(lines) {
  const dir = tempDir("spend-");
  writeFileSync(join(dir, "agent-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

// A pair of tool calls, each its own assistant turn (omp's envelope has no
// notion of "one turn split across several lines" — every JSONL line is
// already a complete, self-contained turn), followed by their results and a
// billing turn. Regression: summing usage across turns inflated totals; the
// tell was the panel disagreeing with itself — by-role total 4.2x the
// by-tool total, both claiming to be the same number.
const TOOL_TURNS = [
  { type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd: "/w" },
  { type: "message", id: "m1", parentId: "s1", timestamp: "2026-09-08T15:11:59.000Z",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "Bash", arguments: {}, intent: "x" }],
      model: "claude-opus-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } },
  { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-08T15:11:59.100Z",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t2", name: "Read", arguments: {}, intent: "x" }],
      model: "claude-opus-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } },
];

test("tool calls across a session's turns are all counted", () => {
  const s = gatherSpend({ dir: fixture(TOOL_TURNS) });
  const by = Object.fromEntries(s.tools.map((t) => [t.tool, t.calls]));
  assert.equal(by.Bash, 1);
  assert.equal(by.Read, 1);
});

test("by-tool attribution never exceeds the cache_creation it is a share of", () => {
  // The invariant the double-count broke: both panels are views of one number.
  const s = gatherSpend({
    dir: fixture([
      ...TOOL_TURNS,
      { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-08T15:11:59.500Z",
        message: { role: "toolResult", toolCallId: "t1", toolName: "Bash", content: [{ type: "text", text: "x".repeat(300) }], details: {}, isError: false, timestamp: 0 } },
      { type: "message", id: "m4", parentId: "m3", timestamp: "2026-09-08T15:11:59.600Z",
        message: { role: "toolResult", toolCallId: "t2", toolName: "Read", content: [{ type: "text", text: "x".repeat(100) }], details: {}, isError: false, timestamp: 0 } },
      { type: "message", id: "m5", parentId: "m4", timestamp: "2026-09-08T15:12:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5",
          usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 400, totalTokens: 0, cost: { total: 0.01 } } } },
    ]),
  });
  const toolTotal = s.tools.reduce((n, t) => n + t.cacheWrite, 0);
  assert.ok(toolTotal <= s.totals.cacheWrite, `${toolTotal} > ${s.totals.cacheWrite}`);
  // The two consecutive result turns both get attributed, 300:100 of the 400.
  const by = Object.fromEntries(s.tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Bash, 300);
  assert.equal(by.Read, 100);
});

test("a toolResult whose content is a STRING does not throw", () => {
  // The trap that once turned into a silently absent panel via the outer catch.
  const s = gatherSpend({
    dir: fixture([
      ...TOOL_TURNS,
      { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-08T15:11:59.500Z",
        message: { role: "toolResult", toolCallId: "t1", toolName: "Bash", content: "plain prose, not an array", details: {}, isError: false, timestamp: 0 } },
      ...TURN,
    ]),
  });
  assert.equal(s.totals.cacheWrite, 1000);
});

// gatherSpend reports through stderr, so read console.error rather than spawning
// the CLI — the transcript tree the CLI resolves lives under $HOME, and these
// fixtures do not.
function withStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.error = real; }
  return lines;
}

function rawFixture(text) {
  const dir = tempDir("spend-");
  writeFileSync(join(dir, "agent-x.jsonl"), text);
  return dir;
}
const oneLineTurn = (id, cw) => JSON.stringify({
  type: "message", id, parentId: "s1", timestamp: "2026-09-08T15:12:00.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5",
    usage: { input: 0, output: 7, cacheRead: 0, cacheWrite: cw, totalTokens: 0, cost: { total: 0 } } },
});
const TORN = '{"type":"message","message":{"role":"ass';
// Hoisted rather than spelled out at each use: several tests below feed the
// SAME mid-file tear, each checking a different fact about it (the count
// itself, the sum across sibling transcripts, the count beside an unrelated
// skip). Spelled out per site, one can be edited and the others stay green —
// measured, the whole suite passes with the copies drifted apart.
const MIDFILE_TEAR = [oneLineTurn("m_a", 1000), TORN, oneLineTurn("m_c", 500)].join("\n") + "\n";

test("a torn LAST line stays silent — the tear every tick legitimately produces", () => {
  // The false-positive half, and the reason the discriminator has to exist at
  // all: `serve` rebuilds every ~15s, so warning per bad line would print a
  // line every tick for every transcript still being appended to. No trailing
  // newline — the torn write is the final element of the split.
  const dir = rawFixture([oneLineTurn("m_a", 1000), TORN].join("\n"));
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.deepEqual(errs, []);
  // ...and everything before the tear still parsed.
  assert.equal(s.totals.cacheWrite, 1000);
});

// #1654: every test above this one holds the `skips` gate's KEY and its
// MESSAGE on the same transcript, in the same directory, so a mutation that
// keys `warnOnce("skips", ...)` on the bare basename (`f`) instead of the
// full path (`file`) — leaving the message's `${file}` untouched — passes
// every one of them: the message still names the right file, and nothing
// above ever gives two DIFFERENT full paths the SAME basename. It is exactly
// the shape a long-lived `serve` process hits in practice: findSubagentsDir()
// re-resolves to a new session directory as fleet runs start and finish, and
// two sessions whose agents both land on a generic transcript name (here
// "agent-x.jsonl", same as every fixture above) are a basename collision
// waiting to happen. Measured: with the key narrowed from `file` to `f`,
// this is the only test in the file that fails — dir B's line never prints,
// because dir A's identical-basename skip already claimed the (mutated) key.
test("two session dirs whose transcripts share a basename each get their own skip line", () => {
  const dirA = tempDir("spend-collide-a-");
  const dirB = tempDir("spend-collide-b-");
  mkdirSync(join(dirA, "agent-x.jsonl")); // directory where a file is expected -> EISDIR, unreadable
  mkdirSync(join(dirB, "agent-x.jsonl")); // same basename, different session dir
  const errs = withStderr(() => {
    gatherSpend({ dir: dirA });
    gatherSpend({ dir: dirB });
  });
  assert.equal(errs.length, 2, "expected one skip line per directory, got " + JSON.stringify(errs));
  assert.equal(errs.filter((e) => e.includes(dirA)).length, 1, "dir A's own path must appear, got " + JSON.stringify(errs));
  assert.equal(errs.filter((e) => e.includes(dirB)).length, 1, "dir B's own path must appear, got " + JSON.stringify(errs));
});

// #1653: two of the skip routes carry the transcript's own path inside
// e.message — Node's errno text (`..., open '<path>'`) and member-record's
// wrong-shape refusal (`...: <path>`) — so `skipping ${file}: ${e.message}`
// printed it twice. A dangling symlink is a deterministic ENOENT at read
// (the transcript scan filters on the `.jsonl` suffix, not file type). A
// third route, EISDIR, carries no path in its message and must print whole.
test("a skip line names its transcript's path exactly once and keeps its cause, on the errno, refusal and path-free routes", () => {
  const dir = tempDir("spend-once-");
  const dangling = join(dir, "agent-d.jsonl");
  const wrongShape = join(dir, "agent-w.jsonl");
  const isDir = join(dir, "agent-e.jsonl");
  symlinkSync(join(dir, "nowhere.jsonl"), dangling);
  writeFileSync(wrongShape, '{"foo":1}\n');
  mkdirSync(isDir); // EISDIR: its message carries no path, so it prints whole
  const errs = withStderr(() => { gatherSpend({ dir }); });
  assert.equal(errs.length, 3, "expected one skip line per transcript, got " + JSON.stringify(errs));
  // The cause is not pinned word for word: a reason must follow the prefix,
  // and the two filesystem routes must still carry their errno code, so a
  // line that lost its reason (or an over-strip of the path-free message)
  // goes red.
  for (const [file, cause] of [[dangling, /ENOENT/], [wrongShape, /\S/], [isDir, /EISDIR/]]) {
    const lines = errs.filter((e) => e.includes(file));
    assert.equal(lines.length, 1, `expected one skip line for ${file}, got ` + JSON.stringify(errs));
    assert.equal(lines[0].split(file).length - 1, 1, `${file} must appear exactly once, got ` + JSON.stringify(lines[0]));
    const prefix = `skipping ${file}: `;
    const at = lines[0].indexOf(prefix);
    assert.ok(at >= 0, `line must carry its prefix, got ${JSON.stringify(lines[0])}`);
    assert.match(lines[0].slice(at + prefix.length), cause, `line must keep its cause, got ${JSON.stringify(lines[0])}`);
  }
});

test("#916: a damaged mid-file line reaches the MODEL as a count, not stderr alone", () => {
  // #916: a damaged mid-file line has no STDERR line at all — readOmpSpend
  // never warns per damaged line, only per whole-unreadable transcript — so
  // stderr is the one channel board.html twice says it does not have: the
  // board is launched backgrounded and the operator is watching the page,
  // which is the argument that put `skipped` in the DOM and then
  // `metaErrors` (#602) beside it. Measured on the tree before this fix,
  // MIDFILE_TEAR: gatherSpend returned
  // totals,roles,top,reviewPct,tools,attributedPct,skipped,metaErrors,since,ok
  // — `skipped` 0, `metaErrors` 0, `error` undefined, no field naming the
  // damage — and spendView's whole decision came back BYTE-FOR-BYTE
  // identical to the intact run's, 1500 cache-write rendered with the same
  // note as 1800. `damaged` is this fault's channel, counted the same way
  // and reaching the browser by the same route.
  const dir = rawFixture(MIDFILE_TEAR);
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 1);
  // Distinct from `skipped`, which is why it is its own field: this
  // transcript CONTRIBUTED, so `skipped` (which means "contributed
  // nothing") may not carry it. Folding the count into it passes without
  // this test.
  assert.equal(s.skipped, 0);
});

test("#916: several damaged lines in one transcript count as several, not as one", () => {
  // The shape that separates a count from a flag — a boolean promoted to
  // `damaged: 1` satisfies every other case in this block. The magnitude is the
  // reason the field exists rather than a `damaged: true`: the stderr gate fires
  // once per PATH, so before this the second tear was invisible on that channel
  // too (measured: two tears in one file, one line, no number anywhere).
  const dir = rawFixture([oneLineTurn("m_a", 1000), TORN, TORN, oneLineTurn("m_c", 500)].join("\n") + "\n");
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 2);
});

test("#916: damaged lines sum across transcripts, the way skipped does", () => {
  // The panel's counts are per-TICK totals over the whole session dir, never
  // per-file: an assignment instead of a sum reads 2 here (the last file's own
  // count) and stays green on every single-transcript case above.
  const dir = rawFixture(MIDFILE_TEAR);
  writeFileSync(join(dir, "agent-y.jsonl"),
    [oneLineTurn("m_d", 100), TORN, TORN, oneLineTurn("m_e", 200)].join("\n") + "\n");
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 3);
});

test("#916: a torn LAST line counts as no damage — the false-positive half", () => {
  // Silence on stderr was never the whole contract: the tear every tick
  // legitimately produces must not inflate the tally either, or every
  // transcript still being appended to parks a permanent "spend
  // under-reported" note on the panel and the note stops meaning anything.
  const dir = rawFixture([oneLineTurn("m_a", 1000), TORN].join("\n"));
  let s;
  assert.deepEqual(withStderr(() => { s = gatherSpend({ dir }); }), []);
  assert.equal(s.damaged, 0);
});

test("#916: a mid-file tear and a torn tail in ONE file count only the mid-file one", () => {
  // The position boundary, re-drawn now that the answer is a number rather than
  // a flag: the two tests above hold one tear per file, so each is satisfied by
  // a count that has dropped the `i !== lines.length - 1` discriminator
  // entirely — one file carrying BOTH tears is the only shape that reads 2
  // under that mutation. No trailing newline, so the last TORN is genuinely the
  // final element of the split.
  const dir = rawFixture([oneLineTurn("m_a", 1000), TORN, oneLineTurn("m_c", 500), TORN].join("\n"));
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 1);
  assert.equal(s.totals.cacheWrite, 1500);
});

test("#916: a damaged transcript beside an unreadable one reports both tallies", () => {
  // Two different faults in one tick, and the panel names them separately. Also
  // the invariant the increment's PLACEMENT carries: `damaged` is summed
  // past the throw-capable work and before the agent is pushed,
  // so a transcript that ends up `skipped` — "contributed nothing" — can never
  // also report damaged lines. Incrementing inside the per-file catch, or
  // hoisting the sum above attributeTools, breaks that and reds here.
  // Directory-where-a-file-is-expected for EISDIR, as above.
  const dir = rawFixture(MIDFILE_TEAR);
  mkdirSync(join(dir, "agent-y.jsonl"));
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 1);
  assert.equal(s.skipped, 1);
});

// Repeat calls with the SAME dir object must stay quiet: gatherSpend being
// called again on an unchanged fault is not a new fault. The test below this
// one covers the complementary axis — two calls with DIFFERENT `dir.error`
// values must both reach stderr, which only a message-keyed gate (not a
// channel-keyed or empty-keyed one) can tell apart from this one.
test("the no-spend-dir gate warns once per distinct fault, not once per tick", () => {
  const dir = { error: "no session directory under ~/.omp/agent/sessions for this cwd" };
  assert.equal(withStderr(() => gatherSpend({ dir })).length, 1, "tick 1 reports");
  assert.deepEqual(withStderr(() => gatherSpend({ dir })), [], "tick 2 stays quiet");
});

// #1190: the gate used to key on the empty string, so its composite key was
// the constant `no-spend-dir\0` regardless of `dir.error`'s text. The FIRST
// spend-dir fault in a process consumed that slot, and a later fault with a
// genuinely different message never reached stderr for the rest of the run.
// The test above binds one `dir` object and calls twice, which discriminates
// once-per-process from once-per-tick but is silent on this axis — both the
// empty key and a message key pass it. This one calls with two DIFFERENT
// `dir.error` values, which only a message key can tell apart.
test("the no-spend-dir gate keys on the message, so a second, different fault also reaches stderr", () => {
  const a = { error: "no transcript dir for cwd /tmp/impl-1190-a (looked in /tmp/impl-1190-a/.omp/agent/sessions/x)" };
  const b = { error: "transcript lookup failed: EACCES: permission denied, scandir '/tmp/impl-1190-b'" };
  const first = withStderr(() => gatherSpend({ dir: a }));
  assert.equal(first.length, 1, "first fault reports");
  assert.match(first[0], /looked in \/tmp\/impl-1190-a/, "first fault's own message reaches stderr");
  const second = withStderr(() => gatherSpend({ dir: b }));
  assert.equal(second.length, 1, "second, different fault also reports");
  assert.match(second[0], /EACCES: permission denied/, "second fault's own message reaches stderr");
  // Steady state is unchanged: the SAME fault repeating still costs one line
  // per process, not one per tick.
  assert.deepEqual(withStderr(() => gatherSpend({ dir: a })), [], "repeating the first fault stays quiet");
  assert.deepEqual(withStderr(() => gatherSpend({ dir: b })), [], "repeating the second fault stays quiet");
});

test("an unreadable dir reports an error rather than posing as an empty run", () => {
  // The distinction that hid the path bug: a hidden panel meant both "nothing
  // yet" and "this is broken", so the broken case never surfaced.
  const s = gatherSpend({ dir: join(tmpdir(), "definitely-not-here-12345") });
  assert.ok(s.error, "expected an error object, got " + JSON.stringify(s));
  // The TAG, not the message: the page routes on `ok` alone (#959), so a
  // producer that stops emitting it hides the panel no matter what `error` says.
  assert.equal(s.ok, false);
});

test("every gatherSpend return carries the tag the page routes on (#959)", () => {
  // One test over all four returns, because the defect was a MISSING tag on one
  // of them, and a per-return test is what leaves the next one untagged.
  // The unresolvable-dir return.
  assert.equal(gatherSpend({ dir: { error: "no session directory for this cwd" } }).ok, false);
  // The all-unreadable return: a dir holding only a transcript that cannot be read.
  const allBad = tempDir("spend-");
  mkdirSync(join(allBad, "agent-trap.jsonl")); // a directory where a file is expected
  let bad;
  withStderr(() => { bad = gatherSpend({ dir: allBad }); }); // it warns; the warning is not what is under test
  assert.equal(bad.ok, false);
  assert.match(bad.error, /all 1 transcripts unreadable/);
  // The success return.
  assert.equal(gatherSpend({ dir: fixture(TURN) }).ok, true);
  // And the one return that is deliberately NOT an object: nothing yet.
  assert.equal(gatherSpend({ dir: tempDir("spend-") }), null);
});

// #169: `arg()` is CLI-internal (not exported), so this pins the trailing-flag
// refusal at the process boundary. `ledger`/`prev`/`spend-since`/`port`/
// `interval` all read via `arg(n) || default` or `?? `, so a trailing flag
// previously fell straight through to the default in total silence —
// `--spend-since` with nothing after it silently widened the spend panel to
// all-time; `--ledger` with nothing after it silently read the wrong file.
// Dies before any gh call, so no PATH stub is needed here.
test("CLI: trailing --ledger (no value) dies (exit 2) rather than silently falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

test("CLI: --ledger=path form dies by name, not silently read as absent", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger=/tmp/x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a space-separated value/);
});

// The other two branches of the same guard, neither of which the tests above
// reach: a flag eating the NEXT FLAG as its value (mutating away
// `value.startsWith("--")` left board/ci-state/diff-stats 100% green), and an
// explicit empty/whitespace value (`value.trim() === ""` was unpinned in all
// five scripts that then carried it — board, candidates, ci-state, diff-stats,
// pr-overlap — simultaneously). Both die before any gh call.
test("CLI: --ledger followed by another flag is rejected, not read as the string \"--prev\"", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", "--prev", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

// #463 fallout, and the one ordering nothing else pins: `--ledger` is read
// above stray() and always was, so none of the cases above reaches the new
// guard at all. `--prev` is read once, ahead of BOTH branches' stray() calls
// (hoisted by #1092 — see main()) — with the read moved back below either
// stray() call, this invocation refuses with `unexpected argument '9000'`,
// naming --port's innocent value instead of the flag actually given wrong
// (measured). Moving the read back below stray() is what this reds on.
test("CLI: trailing --prev names --prev, not the innocent value of the flag behind it", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--prev", "--port", "9000"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--prev needs a value/);
});

// #1092: unlike the case above, `--prev` was not merely ORDERED wrong on one
// subcommand — it was never read on `serve` at all. serve()'s own signature
// (`{ ledgerFile, port, interval, open }`) carries no `prev` parameter, and
// main()'s `serve` branch called only `stray()`, so a trailing `--prev` on
// `serve` never reached ANY guard: measured, pre-fix, `serve --prev` and
// `serve --prev=x` both fell straight through to gather()'s first `gh` call
// (a real network attempt, not a refusal), and `serve --prev --port 9000`
// refused with `unexpected argument '9000'` once stray() got to it — naming
// --port's innocent value rather than the flag actually given wrong, the
// exact harm the build-side pin above exists for. Hoisting `arg("prev")`
// above the dispatch (next to argPort()/has("open")) closes all three: every
// case below now dies inside main(), before `serve()` is ever called, so
// none of these needs board-cli.test.mjs's gh-stub/PATH rig — same as the
// build-side cases above and the --port/--open hoist cases below.
test("CLI: serve refuses a trailing --prev (no value), same message as build", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--prev"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a value/);
});

test("CLI: serve refuses --prev=x, the same shape --ledger=path is refused", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--prev=x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a space-separated value, not --prev=/);
});

test("CLI: serve refuses --prev --port 9000, naming --prev not --port's innocent value", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--prev", "--port", "9000"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a value/);
});

// #1092: the --prev-before-argPort() ordering pinned above (`serve --prev
// --port 9000`) only exercises --prev going wrong while --port's value is
// well-formed — it never exercises BOTH flags malformed at once, which is
// the actual case the hoist comment above `arg("prev")` in main() claims to
// handle ("a caller who gets BOTH flags wrong at once ... still hears about
// --prev specifically"). With `arg("prev")` read before argPort() in the
// hoist (as it is), a trailing --port immediately followed by a trailing
// --prev — neither given a value — refuses on --prev, since --prev's read
// runs first and sweep() never reaches --port's dangling flag. Swap the
// hoist order (argPort() ahead of `arg("prev")`) and this reds: the error
// names --port instead (measured).
test("CLI: build refuses --port --prev with both flags trailing, naming --prev not --port", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "--prev"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a value/);
});

test("CLI: --ledger given an empty value dies rather than falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", ""], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

// #468: argPort()/has("open") used to run only inside serve(), so build never
// evaluated them — `build --port abc` and `build --open=1` were silently
// IGNORED at exit 0 rather than refused, the one silent-default shape
// ledger/prev/spend-since/interval (pinned above and in board-cli.test.mjs)
// did not share. main() now calls both once, ahead of the build/serve
// dispatch, so these refuse on build too, with the exact wording serve
// already refuses them with. All three die before gather()'s first gh read
// (the guard moved above the dispatch, not just above serve()'s own call),
// so — like the --ledger/--prev cases above — none of these need the gh-stub
// rig board-cli.test.mjs carries for the guards that fire mid-gather().
test("CLI: build refuses a trailing --port, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a value/);
});

test("CLI: build refuses a non-numeric --port, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

test("CLI: build refuses --open=1, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--open=1"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--open is a boolean flag, not --open=/);
});

// The ordering half of the same fix, and the one the three cases above cannot
// see: they pass a malformed flag ALONE, so nothing distinguishes a guard that
// runs ahead of the build branch's stray() from one that runs after it. Add a
// stray positional and it does: with the guard moved below that stray() call,
// this invocation refused with `unexpected argument 'extra'` (measured),
// naming a trailing token instead of the malformed value the caller actually
// got wrong. Both orderings still exit 2 — only which real mistake gets named
// differs, which is exactly what the --prev case above pins for its own flag.
test("CLI: build refuses a malformed --port ahead of a stray token, naming --port not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "abc", "extra"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

// #1076: same ordering gap as the --prev/--port cases above, for the two
// flags PR #1090 (#468) left standing — argInterval()'s read had two call
// sites (serve() directly, and embedded in gather()'s return, which build's
// dispatch reaches too), and the --spend-since read sat inside gather();
// all three sat below every stray() call on every path that reaches them.
// With any of those reads left below the guard, the invocation refused
// with `unexpected argument 'x'` (measured), naming the value flag's own
// innocent trailing token instead of the flag actually given wrong — true
// of build+interval as much as the serve+interval and build+spend-since
// cases below cover. Hoisting both into main(), the same place and the
// same way #468 hoisted argPort()/has("open"), is what these two red on
// if reverted.
test("CLI: serve refuses a trailing --interval ahead of a stray token, naming --interval not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--interval", "--open", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--interval needs a value/);
});

test("CLI: build refuses a trailing --spend-since ahead of a stray token, naming --spend-since not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--spend-since", "--open", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since needs a value/);
});

// #1583: the same four spellings for --spend-dir, and the same ordering. A
// PATH has no range to check, so arg() IS this flag's whole refusal — which
// makes the two things this ticket wrote the only things standing between an
// operator and a silent wrong answer: the "value" entry in the flag table, and
// the read hoisted into main(). Drop it from the table and sweep() calls the
// flag unknown; drop the hoisted read and the stray case below blames `x`.
test("CLI: every malformed --spend-dir spelling is refused under its own name", () => {
  const cases = [
    [["build", "--spend-dir"], /--spend-dir needs a value/],                                   // trailing
    [["build", "--spend-dir="], /--spend-dir needs a space-separated value, not --spend-dir=/], // = form
    [["build", "--spend-dir", ""], /--spend-dir needs a value/],                               // empty value
    [["build", "--spend-dir", "--prev", "x"], /--spend-dir needs a value/],                    // eats the next flag, naming --spend-dir not the stray
  ];
  for (const [args, message] of cases) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `expected exit 2 for ${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, message, `for ${args.join(" ")}`);
  }
});

// The other two malformed spellings arg.mjs refuses, which the hoist closes on
// build alongside the three above. Pinned because a NARROWED hoist keeps the
// three green while dropping these: measured, `if (process.argv.includes(
// "--port")) argPort();` — a plausible "only bother when the flag was given" —
// leaves `build --port=9000` at exit 0 with every other case still refusing.
test("CLI: build refuses --port=9000, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port=9000"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a space-separated value, not --port=/);
});

test("CLI: build refuses an empty --port value rather than falling back to the default port", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", ""], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a value/);
});

// The hoist sits above the `cmd` dispatch, not just above serve()'s own call,
// so it also changed the no-subcommand path: `board.mjs --port abc` printed
// the usage line before this fix and names the flag after it (measured, both
// sides). Sanctioned by #468's Option A ruling — a malformed flag is refused
// wherever it is written — and unpinned until now: the same narrowing that
// moves the guards into the `build` branch restores the usage line here while
// leaving all four `build` cases above green.
test("CLI: a malformed --port with no subcommand names the flag, not the usage line", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--port", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

// The offline rig every serve spawn below shares. PATH is stripped to an
// empty dir so every gh/git/node child fails fast into tryRun's catch: the
// tick degrades, `git rev-parse --git-common-dir` answers nothing, and the
// instance degrades with it to a cwd-relative `.fleet` on PORT_BASE — which
// is what makes 8123 the deterministic derived port for these spawns, and a
// fresh mkdtemp cwd what keeps them from sharing a state directory.
const serveArgs = (args) => [SCRIPT, "serve", ...args];
const serveOpts = () => ({
  cwd: tempDir("board-serve-"),
  env: { ...process.env, PATH: tempDir("board-nobin-") },
  encoding: "utf8",
  timeout: 20000,
});

// #1660 review: the git-enabled reuse/scan CLI rows below (which need a
// real `bin` with git shimmed and a real `repo` cwd, so serveOpts()'s
// offline empty-PATH rig doesn't fit) repeated this option literal
// verbatim across four call sites, differing only in the timeout.
const serveSync = (repo, bin, args, timeout = 20000) =>
  spawnSync(process.execPath, serveArgs(args), { cwd: repo, env: { ...process.env, PATH: bin }, encoding: "utf8", timeout });

// A net server that accepts a connection and then says nothing — the holder
// no HTTP status describes, and the only one the probe's timer alone can
// end. Its sockets are tracked because a socket nobody ever reads from
// never notices the peer hanging up: plain `server.close()` would then wait
// on it forever and keep this whole test process alive past the last test
// (measured — the suite ran to the harness timeout with every test green).
function muteHolder() {
  const conns = [];
  const server = createServer((s) => conns.push(s));
  const close = () => {
    for (const s of conns) s.destroy();
    return new Promise((res) => server.close(res));
  };
  return { server, close };
}

// #1660 review: the row that used to stand here pinned the opposite of what
// #1656 closed. This cwd is not a git checkout, so its workspace is null,
// and a null workspace can never be confirmed against a handshake no
// matter what answers on the other end — there is no identity to scan for.
// Stepping past a held port there re-admits the exact dual-cockpit hazard
// #1656 fixed: two processes sharing one derived window and one state
// directory, neither aware the other exists. A held derived port on the
// degrade arm has to stay fatal, exactly as it was before #1585 introduced
// scanning at all.
//
// The blocker is a bare net server, and it has to be OURS: a port some
// outside process already holds can be let go between this bind and
// board's own, and board then binds 8123 and serves (#2522). The degrade
// arm derives no port but 8123, so there is none to move to: when an
// outside process holds it, the row skips rather than ride that process's
// timing.
test("CLI: a derived port held by anything is fatal on the degrade arm — there is no identity to scan for", async (t) => {
  const blocker = createServer();
  const failure = await new Promise((res) => { blocker.once("error", res); blocker.listen(8123, () => res(null)); });
  if (failure?.code === "EADDRINUSE") return t.skip(heldOutside(8123));
  if (failure) throw failure;
  const nobin = tempDir("board-nobin-");
  const cwd = tempDir("board-serve-");
  try {
    const r = serveSync(cwd, nobin, ["--interval", "3600"]);
    assert.equal(r.status, 2, `a held derived port on the degrade arm must refuse, not scan past it: ${r.stderr}`);
    assert.match(r.stderr, /port 8123 in use/, r.stderr);
    assert.doesNotMatch(r.stderr, /cockpit on http/,
      `a second server was started with no identity it could ever have matched on: ${r.stderr}`);
  } finally {
    blocker.close(() => {});
    for (const d of [nobin, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

// #1656 critical (survived review): tick() used to run and write board.json
// BEFORE listen() confirmed the bind, so a process that loses this exact
// race against another cockpit on the same shared state directory still got
// one full write in before dying on EADDRINUSE — overwriting whatever the
// live cockpit had just written. Binding first (server.listen()'s success
// callback now owns tick()/setInterval()) is what this test pins: the loser
// must leave the state directory exactly as untouched as a process that
// never ran at all.
//
// The blocker names no host, so it holds every interface. On macOS/BSD a
// 127.0.0.1 bind succeeds beside a listener like that rather than failing
// EADDRINUSE, so the refusal pinned here — an explicit port is never scanned
// off, it dies "in use" — has to come from somewhere other than the bind.
test("CLI: a port already in use must not write board.json before the process dies", async () => {
  const blocker = createServer();
  const port = await new Promise((res) => blocker.listen(0, () => res(blocker.address().port)));
  const opts = serveOpts();
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", String(port)]), opts);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`port ${port} in use`), r.stderr);
    assert.ok(!existsSync(join(opts.cwd, ".fleet", "board.json")),
      "the bind loser ticked and wrote board.json before dying on EADDRINUSE");
  } finally { blocker.close(() => {}); }
});

// #366: `Number(x) || default` treated a non-numeric --port/--interval exactly
// like an absent one — silently substituting the default with no refusal.
// These pin the refusal itself, before listen() is ever reached.
test("CLI: serve refuses a non-numeric --port by name, not silently substituting the default", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "abc"]), serveOpts());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

test("CLI: serve refuses an out-of-range or non-integer --port", () => {
  for (const v of ["-1", "70000", "1.5"]) {
    const r = spawnSync(process.execPath, serveArgs(["--port", v]), serveOpts());
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, /--port wants an integer 0-65535/, `for ${v}: ${r.stderr}`);
  }
});

// The named case that must NOT be refused: listen(0) binds an ephemeral port,
// a real use, and 0 is falsy — the exact value the old `|| null` idiom lost.
// serve() only exits on SIGINT/SIGTERM once bound, so a timeout here is the
// expected shape of success; the refusal this guards against dies with
// status 2 almost instantly and never reaches listen() at all.
//
// Accepting 0 is only half of it: the announced URL has to be one the operator
// can open. Echoing the REQUESTED port printed http://localhost:0 — reachable
// by nothing — while the board sat on the kernel's pick, so pin that the
// number announced is the one bound, not the one asked for (#435 review).
test("CLI: serve accepts --port 0 (ephemeral bind), announces the port it actually bound, and opens nothing unasked", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600"]), { ...serveOpts(), timeout: 2000 });
  assert.notEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /--port wants/);
  const announced = r.stderr.match(/cockpit on http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(announced, `no cockpit line: ${r.stderr}`);
  assert.notEqual(announced[1], "0", `announced the requested port, not the bound one: ${r.stderr}`);
  // …and the ABSENT half of #364's has() control rides this spawn rather than
  // paying for a second one byte-identical to it: no --open was passed, so
  // nothing may try to open. The --open test below carries the present half,
  // and explains why a launcher that could not run surfaces on stderr at all.
  assert.doesNotMatch(r.stderr, /could not open a browser/, r.stderr);
});

// #1679: every other argv-read option `serve` takes has both an in-process
// override AND a CLI test driving it end to end; --spend-dir had neither
// until now — every existing --spend-dir test drove `build` (one gather per
// process, no pin) or spendDirPin() directly, never `serve`'s own tick loop.
test("CLI: serve --spend-dir reads the named directory's spend into every tick, not just build", () => {
  const opts = serveOpts();
  // A real `<ISO>_<uuid>` leaf name: gatherSpend's `explicit` path now
  // refuses a --spend-dir whose own basename is not an omp session dir
  // (#1302-style guard), so this fixture must look like one to keep testing
  // what it says it tests — the named directory's data reaching the panel.
  const root = tempDir("spend-named-");
  const dir = join(root, "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "named.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--spend-dir", dir]), { ...opts, timeout: 2000 });
  assert.notEqual(r.status, 2, r.stderr);
  const body = JSON.parse(readFileSync(join(opts.cwd, ".fleet", "board.json"), "utf8"));
  assert.equal(body.spend.ok, true, r.stderr);
  assert.equal(body.spend.totals.cacheWrite, 1000, "the served panel must come from the named directory, not the (absent) heuristic");
  assert.equal(body.spend.top[0].label, "named");
});

test("CLI: serve refuses a non-numeric or non-positive --interval by name", () => {
  for (const v of ["abc", "0", "-5"]) {
    const r = spawnSync(process.execPath, serveArgs(["--interval", v]), serveOpts());
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--interval wants seconds > 0 and <= 2147483, got ${v}`), `for ${v}: ${r.stderr}`);
  }
});

// Both boundaries, both flags — an untested edge is an edge a later mutation
// walks straight through: `n > 65535` weakened to `n >= 65535` (rejecting the
// legal maximum port) survived the whole suite (#435 review). 65535 may well
// be free here and may not, so pin the ABSENCE of the refusal rather than a
// successful bind: an occupied port dies with "port 65535 in use", a rejected
// one with "--port wants", and only the second is this guard's doing.
test("CLI: serve accepts the maximum legal --port 65535 and refuses 65536", () => {
  const ok = spawnSync(process.execPath, serveArgs(["--port", "65535", "--interval", "3600"]), { ...serveOpts(), timeout: 2000 });
  assert.doesNotMatch(ok.stderr, /--port wants/, ok.stderr);
  const over = spawnSync(process.execPath, serveArgs(["--port", "65536"]), serveOpts());
  assert.equal(over.status, 2, over.stderr);
  assert.match(over.stderr, /--port wants an integer 0-65535, got 65536/);
});

// The interval ceiling is setInterval's, so pin it where it bites: at the max
// the timer must be armed normally, one second past it the flag is refused.
// Without the ceiling, 2147484s becomes a 1ms tick and the rebuild loop spins
// on gh instead of sleeping ~25 days — announced only by Node's own warning.
test("CLI: serve arms the maximum --interval 2147483 without overflowing, and refuses 2147484", () => {
  const ok = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "2147483"]), { ...serveOpts(), timeout: 2000 });
  assert.doesNotMatch(ok.stderr, /--interval wants/, ok.stderr);
  assert.doesNotMatch(ok.stderr, /TimeoutOverflowWarning/, ok.stderr);
  const over = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "2147484"]), serveOpts());
  assert.equal(over.status, 2, over.stderr);
  assert.match(over.stderr, /--interval wants seconds > 0 and <= 2147483, got 2147484/);
});

// #364: has() used exact argv.includes, so a boolean flag written --open=value
// (in any form the value takes) silently read as absent. Boolean-specific
// wording, distinct from arg()'s "needs a space-separated value" above: a
// boolean has no value to give. Dies before listen(), same as the port/interval
// guards above — nothing this reaches ever shells out.
for (const v of ["=true", "=false", "="]) {
  test(`CLI: serve refuses --open${v} as a boolean flag, not silently read as absent`, () => {
    const r = spawnSync(process.execPath, serveArgs([`--open${v}`]), serveOpts());
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--open is a boolean flag, not --open=/);
  });
}

// Position, not just spelling: `serve` is fixed and every case in the loop
// above passes its flag alone, so all three land at exactly process.argv[3] —
// and a guard narrowed to that one index passes all three. Measured (#462
// review): has() rewritten to `process.argv[3].startsWith(...)` kept this file
// green at 34/34 while `serve --port 0 --interval 3600 --open=true` started
// the server, dropped the flag in silence and never opened a browser — #364
// itself, alive under a green suite. The real invocation always carries
// --port/--interval, so pin the flag where an operator actually types it.
// The MESSAGE is the load-bearing assertion, not `status`: spawnSync reports
// status 2 on a timeout too, so a serve left running would satisfy the code
// alone.
test("CLI: serve refuses --open=true behind other flags, not only as the first argument", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open=true"]), { ...serveOpts(), timeout: 2000 });
  assert.match(r.stderr, /--open is a boolean flag, not --open=/, r.stderr);
  assert.equal(r.status, 2, r.stderr);
});

// The control: the new `=` guard must not touch the bare spelling. Observable
// effect is the browser launcher firing — PATH is stripped to an empty dir
// (serveOpts), so every launcher this platform would try is missing and the
// warning naming the URL shows up on stderr rather than a browser opening.
// #1714's rows further down put stub launchers on PATH to see which one ran.
// The other half of the control — absence still reading as absent — is
// asserted on the --port 0 test above, whose spawn is byte-identical to the
// one this would otherwise repeat.
test("CLI: serve --open (bare) still reads as present, not swallowed by the `=` guard", () => {
  const opened = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open"]), { ...serveOpts(), timeout: 2000 });
  assert.match(opened.stderr, /could not open a browser .*http:\/\/127\.0\.0\.1:\d+\//, opened.stderr);
});

// #463: sweep() only ever refuses a `--`-prefixed token, so a bare stray
// alongside a valid subcommand rode through in silence the same way
// `board.mjs build junk` did — this pins the `serve` side of that fix.
// stray() sits at the top of the `serve` branch, ahead of serve()'s own
// port/interval/open reads, so this dies before ever calling listen() —
// same reasoning as every guard above it in this file, and why serveOpts()'s
// 20s timeout is a backstop here rather than the expected path.
test("CLI: serve refuses a stray positional the same way build does", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "junk"]), serveOpts());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument 'junk'/);
});

// ---------------------------------------------------------------------------
// #1582: cockpit instance resolution. A cockpit instance is identified by its
// WORKSPACE — the directory holding the shared git dir, resolved by
// fleet-dir.mjs's fleetFile() exactly as the run's one ledger is — so two
// workspaces get two boards on two ports and one workspace gets the SAME port
// on every run, making the URL bookmarkable across runs, reboots and node
// versions.
//
// resolveCockpitInstance() takes the already-resolved workspace as an
// ARGUMENT rather than resolving it, which is what turns the resolved case
// and the resolution-failed case into plain rows here instead of fixture
// repositories apiece. How a `--git-common-dir` answer becomes a workspace —
// a relative answer, the trailing newline, a linked worktree, a symlinked
// route — is git-env.test.mjs's and fleet-dir.test.mjs's to pin.
//
// Why these rows and not only a live probe: every serve() spawn above runs
// with PATH stripped to an empty dir, so git is unreachable and all of them
// take the DEGRADE arm. A green CLI section above is evidence about that arm
// and no other — the resolved arm is reached in the rows below, and
// end-to-end by the spawns further down, which put a git shim back on PATH on
// purpose.
// ---------------------------------------------------------------------------

test("resolveCockpitInstance: the state directory follows the workspace, never the cwd", () => {
  const r = resolveCockpitInstance({ cwd: "/w/repo/.worktrees/t", workspace: "/w/repo" });
  assert.equal(r.stateDir, "/w/repo/.fleet");
  assert.equal(r.workspace, "/w/repo");
});

// The window is written out literally rather than imported from board.mjs:
// these two numbers ARE the contract. BASE is the port the cockpit served on
// before any of this existed, so a silent change to it breaks every bookmark
// the ticket exists to preserve, and a test that read both from the module
// under test could not notice either one moving.
const PORT_BASE = 8123, PORT_SPAN = 512;

for (const dir of ["/w/one", "/w/two", "/srv/fleet-plugin", "/Users/x/dev/repo"]) {
  test(`resolveCockpitInstance: ${dir} derives one stable port inside [${PORT_BASE}, ${PORT_BASE + PORT_SPAN})`, () => {
    const first = resolveCockpitInstance({ cwd: dir, workspace: dir });
    // Same workspace, different cwd: the port follows the workspace, so a
    // member running from elsewhere in the tree must land on the same board.
    const again = resolveCockpitInstance({ cwd: "/somewhere/else", workspace: dir });
    assert.equal(first.port, again.port, "the port must follow the workspace, not the cwd");
    assert.equal(first.derived, true, "nothing forced this port, so it is a derived one");
    assert.ok(first.port >= PORT_BASE && first.port < PORT_BASE + PORT_SPAN,
      `${dir} derived ${first.port}, outside [${PORT_BASE}, ${PORT_BASE + PORT_SPAN}) — the unsigned coercion on the hash is what keeps it in the window`);
  });
}

// The other half of "two workspaces, two boards": a hash that collapses to a
// constant keeps every row above green while putting every workspace on one
// port — this test catches that. It does NOT reliably catch a precision-
// losing variant (Math.imul replaced by a plain `*`): for these six fixed
// paths that variant still lands on six distinct ports, so this row would
// pass vacuously against it (mutation-verified, #1656 review). The dedicated
// pinned-value test below exists to catch that case. Fixed paths, so both
// tests are deterministic: they cannot flake, they can only be wrong.
test("resolveCockpitInstance: different workspaces derive different ports", () => {
  const seen = new Map();
  for (const dir of ["/w/one", "/w/two", "/w/three", "/w/four", "/w/five", "/w/six"]) {
    const { port } = resolveCockpitInstance({ cwd: dir, workspace: dir });
    assert.ok(!seen.has(port),
      `${dir} and ${seen.get(port)} both derived ${port} — a hash that cannot separate two workspaces cannot give them two boards`);
    seen.set(port, dir);
  }
});

// workspaceHash() is not exported, so this pins the algorithm indirectly
// through resolveCockpitInstance()'s derived port. 8337 was hand-computed by
// re-deriving FNV-1a-with-Math.imul for the key "/fixed/workspace" in two
// independent scripts (JS and Python, the latter with explicit 32-bit
// unsigned-multiply/wrap semantics) and cross-checked against the real
// function — it is NOT copied from this file's own module under test. A
// Math.imul -> `*` mutation changes this key's hash and port (8337 -> 8355),
// so — unlike the uniqueness test above — this one does catch it.
test("resolveCockpitInstance: a fixed workspace pins the FNV-1a-with-Math.imul port exactly", () => {
  const { port } = resolveCockpitInstance({ cwd: "/fixed/workspace", workspace: "/fixed/workspace" });
  assert.equal(port, 8337,
    "port drifted off the hand-computed FNV-1a value for this fixed key — the hash algorithm itself changed");
});

// The false-positive half of this ticket. Deriving is the new behaviour, and
// the way to get it wrong is to derive over the top of a port the caller
// chose. 0 is a row on purpose: it is a legal ephemeral bind (#366/#435) and
// it is FALSY, so any truthiness test in place of `port != null` silently
// replaces it with a derived port and `--port 0` stops meaning anything.
// 8123 is a row for the opposite reason — it is the base, so only `derived`
// can tell a forced one from a derived one there.
for (const port of [0, 8123, 65535]) {
  test(`resolveCockpitInstance: --port ${port} is returned verbatim and marked not derived`, () => {
    const r = resolveCockpitInstance({ cwd: "/w/cwd", workspace: "/w/repo", port });
    assert.equal(r.port, port);
    assert.equal(r.derived, false);
    // Forcing the port forces the port — the state directory still follows
    // the workspace.
    assert.equal(r.stateDir, "/w/repo/.fleet");
  });
}

// No resolved workspace degrades to a cwd-relative state directory with a
// null workspace and says so; a non-git or otherwise unusual checkout never
// dies for it. The wording is the ledger's own — one dialect for one failure,
// so an operator who has seen the ledger's line recognises this one rather
// than learning a second phrasing of it.
for (const [name, workspace] of [
  ["the workspace could not be resolved", null],
  ["no workspace was passed at all", undefined],
  ["the empty string is not an identity", ""],
]) {
  test(`resolveCockpitInstance: ${name} — degrades to cwd, warns, never throws`, () => {
    let r;
    const errs = withStderr(() => { r = resolveCockpitInstance({ cwd: "/w/cwd", workspace }); });
    assert.equal(r.workspace, null, "no workspace was established, so none may be claimed");
    assert.equal(r.stateDir, "/w/cwd/.fleet", "the fallback is cwd-relative — the behaviour this file had before #1582");
    assert.equal(r.port, PORT_BASE, "with no workspace to hash there is nothing to derive from, so the port is the familiar default");
    assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
    assert.match(errs[0], /WARNING could not resolve --git-common-dir/,
      "the ledger's existing fail-loud wording, not a second dialect for the same failure");
    assert.match(errs[0], /using cwd-relative/);
  });
}

// The reason fleetFile() gave rides on the warning, as it does on the ledger's.
test("resolveCockpitInstance: the degrade warning carries the reason it was handed", () => {
  const errs = withStderr(() => {
    resolveCockpitInstance({ cwd: "/w/cwd", workspace: null, why: "could not resolve --git-common-dir: spawnSync git ETIMEDOUT" });
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /WARNING could not resolve --git-common-dir: spawnSync git ETIMEDOUT; using cwd-relative/);
});

// The degrade arm has its own copy of the forced/derived decision, so a
// mutation that drops it there is invisible to the rows above: a caller who
// passed --port outside a git checkout would silently get 8123 instead.
test("resolveCockpitInstance: an explicit port survives the degrade path too", () => {
  let r;
  const errs = withStderr(() => { r = resolveCockpitInstance({ cwd: "/w/cwd", workspace: null, port: 4242 }); });
  assert.equal(r.port, 4242);
  assert.equal(r.derived, false);
  assert.equal(errs.length, 1, "the state directory still degraded, so the warning still belongs");
});

// A PATH carrying git and nothing else. The resolved arm needs a real
// `git rev-parse`, while gh and node must stay unreachable so these spawns
// remain offline and fast — the same intent serveOpts()'s empty PATH has.
function gitOnlyPath() {
  const bin = tempDir("board-gitbin-");
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "test setup: no git on PATH to shim, so the resolved arm cannot be reached");
  symlinkSync(real.stdout.trim(), join(bin, "git"));
  return bin;
}

function gitRepo(prefix) {
  const dir = tempDir(prefix);
  // GIT_DIR/GIT_WORK_TREE scrubbed off the FIXTURE too: under an ambient one
  // `git init` exits 0 having re-inited whichever directory the variable
  // names, leaving this one silently not a repository (ledger.test.mjs hit
  // exactly that) — and the status check alone cannot see it.
  const env = gitEnv();
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", env });
  assert.equal(init.status, 0, "test setup: git init must succeed");
  assert.ok(existsSync(join(dir, ".git")), "test setup: git init must have created a repository HERE");
  return dir;
}

// The behavioural fixture ambient-git-vars-mjs-prose.test.mjs's census
// requires of every file it lists in COVERED_MJS, measured for board.mjs
// rather than copied from another script's reason: GIT_DIR outranks the
// child's cwd, so an ambient one makes `git rev-parse --git-common-dir`
// answer for a DIFFERENT repository — and this cockpit would then serve, and
// write board.json into, someone else's workspace, at exit 0 and in silence.
// gitEnv() on the probe is what prevents it.
test("CLI: an ambient GIT_DIR cannot move the cockpit into another repository's workspace", () => {
  const bin = gitOnlyPath(), mine = gitRepo("board-ws-mine-"), other = gitRepo("board-ws-other-");
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600"]), {
      cwd: mine,
      env: { ...process.env, PATH: bin, GIT_DIR: join(other, ".git") },
      encoding: "utf8",
      timeout: 5000,
    });
    // Without this the test passes vacuously: a probe that FAILED also keeps
    // the board out of `other`, by degrading to the cwd rather than by
    // scrubbing anything.
    assert.doesNotMatch(r.stderr, /could not resolve --git-common-dir/,
      `the probe had to succeed, or this proves nothing about which repo it answered for: ${r.stderr}`);
    assert.match(r.stderr, /cockpit on http/, r.stderr);
    assert.ok(existsSync(join(mine, ".fleet", "board.json")),
      "the board belongs in the caller's own workspace");
    assert.ok(!existsSync(join(other, ".fleet")),
      "an ambient GIT_DIR relocated the whole cockpit into the repository it names");
  } finally { for (const d of [bin, mine, other]) rmSync(d, { recursive: true, force: true }); }
});

const withTimeout = (pr, ms, what) => Promise.race([
  pr,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref()),
]);

function serveProcess(cwd, bin, args = ["--port", "0", "--interval", "3600"], node = [], env = {}) {
  const p = spawn(process.execPath, [...node, ...serveArgs(args)],
    { cwd, env: { ...process.env, ...env, PATH: bin }, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.setEncoding("utf8");
  let buf = "";
  const url = new Promise((res, rej) => {
    p.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/cockpit on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) res(m[1]);
    });
    p.on("exit", (code) => rej(new Error(`serve exited (${code}) before announcing: ${buf}`)));
  });
  return { p, url, stderr: () => buf };
}

// #1713: the cockpit now answers HTTP while its first tick is still
// computing, so the first payload on this wire is #1660's identity stub —
// `{workspace, port}`, no `tickets` — and only the tick behind it is a board.
// Before the tick ran asynchronously this process could not answer at all
// until it had finished, which is the only reason a bare fetch here used to
// land on a built board. `generatedAt` is the discriminant because only
// computeBoard() produces it; board-identity.test.mjs polls on the same field
// for the same reason.
async function untilBuiltBoard(url) {
  const ms = 20000, deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(`${url}/board.json`);
      if (res.ok) {
        const body = await res.json();
        if (typeof body.generatedAt === "number") return body;
      } else { await res.arrayBuffer(); }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`no built board at ${url} after ${ms}ms`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// The `canonicalise` opt-in is this caller's alone: without it a symlinked
// route to one workspace — a symlinked home, /var vs /private/var on this very
// platform — derives a SECOND port and a second state directory for a
// workspace already being served (#1582). How fleetFile() canonicalises is
// fleet-dir.test.mjs's to pin; this pins that the cockpit ASKS for it. git
// resolves a symlinked cwd itself, so the symlinked spelling reaches the
// answer through GIT_COMMON_DIR instead, which git echoes back verbatim — run
// from a plain repository of its own, since that override from inside a
// linked worktree collides with the worktree's own admin files.
test("CLI: a symlinked route to the workspace is served under the canonical workspace's identity", async () => {
  const bin = gitOnlyPath(), real = gitRepo("board-ws-real-"), from = gitRepo("board-ws-from-");
  const link = `${real}-link`;
  symlinkSync(real, link);
  const server = serveProcess(from, bin, undefined, [], { GIT_COMMON_DIR: join(link, ".git") });
  try {
    const body = await untilBuiltBoard(await withTimeout(server.url, 20000, "the cockpit to announce its URL"));
    assert.equal(body.workspace, realpathSync(real),
      `the symlinked route must canonicalise onto the real workspace key: ${server.stderr()}`);
  } finally {
    server.p.kill();
    for (const d of [bin, real, from, link]) rmSync(d, { recursive: true, force: true });
  }
});

// The end-to-end claim, and the one no pure row can make: two workspaces
// served AT ONCE are two live boards, each writing only its own state
// directory — and the one started from a linked worktree writes its MAIN
// checkout's, not the worktree's.
//
// `--port 0` on both, deliberately. What needs two real processes is the
// state-directory separation; that two workspaces derive two DIFFERENT ports
// is already pinned deterministically in the rows above, and binding the
// derived ports here would make the test depend on whether this machine
// happens to hold either of them.
//
// Unlike every other `gitOnlyPath()` consumer, this test also symlinks node
// onto the shim PATH (gh stays unreachable): gather()'s ledger read shells
// out to a `node ledger.mjs` subprocess, and with node unreachable that read
// always fails and every board here would show `tickets: []` regardless of
// which ledger.md — or none at all — actually got read, making the ledger
// fixture below assert nothing (#1656 review).
test("CLI: two workspaces serve two live boards at once, each writing only its own state directory", async () => {
  const bin = gitOnlyPath(), repoA = gitRepo("board-ws-a-"), repoB = gitRepo("board-ws-b-");
  symlinkSync(process.execPath, join(bin, "node"));
  const procs = [];
  try {
    const env = gitEnv();
    const git = (cwd, args) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore", env });
      assert.equal(r.status, 0, `test setup: git ${args.join(" ")} must succeed`);
    };
    // `worktree add` needs a commit to branch from.
    git(repoA, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const worktree = join(repoA, "wt");
    git(repoA, ["worktree", "add", "-q", worktree, "-b", "side"]);

    // #1656 critical (survived review): the served state directory moved to
    // the workspace, but an unfixed default ledger path stayed cwd-relative
    // — so a cockpit started from this worktree found no ledger there and
    // silently served an EMPTY board into repoA's shared board.json. A row
    // written into repoA's OWN `.fleet/ledger.md` (never the worktree's) is
    // the only way to tell "read the right ledger" apart from "read no
    // ledger and get an empty board either way": both look like `tickets: []`
    // without it.
    mkdirSync(join(repoA, ".fleet"), { recursive: true });
    writeFileSync(join(repoA, ".fleet", "ledger.md"),
      "# Fleet run ledger\n\n## Rows\n\n- #42 impl-1 build the thing\n\n## Filed\n\n## Ruled\n\n");

    const a = serveProcess(worktree, bin), b = serveProcess(repoB, bin);
    procs.push(a.p, b.p);
    const [urlA, urlB] = await withTimeout(Promise.all([a.url, b.url]), 20000, "both cockpits to announce");

    for (const [label, url] of [["worktree-of-A", urlA], ["B", urlB]]) {
      const board = await untilBuiltBoard(url);
      assert.ok(Array.isArray(board.tickets), `${label} served something that is not a board`);
    }
    assert.notEqual(urlA, urlB, "two concurrent boards cannot share one URL");

    const boardA = await (await fetch(`${urlA}/board.json`)).json();
    assert.ok(boardA.tickets.some((t) => t.issue === 42),
      "the worktree's cockpit must read the MAIN checkout's ledger, not a cwd-relative one that does not exist under the worktree");

    assert.ok(existsSync(join(repoA, ".fleet", "board.json")),
      "the worktree's cockpit must write its MAIN checkout's state directory");
    assert.ok(!existsSync(join(worktree, ".fleet")),
      "the worktree got a state directory of its own — one repo, one board, one ledger");
    assert.ok(existsSync(join(repoB, ".fleet", "board.json")),
      "the second workspace must write its own state directory");
  } finally {
    for (const p of procs) p.kill("SIGKILL");
    for (const d of [bin, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  }
});

// ── #1585: the launch is idempotent ─────────────────────────────────────────

// The pure half of the scan, reachable with no socket at all.
test("cockpitPorts: an explicit port is a list of one — there is nothing to scan", () => {
  assert.deepEqual(cockpitPorts({ port: 9000, derived: false }), [9000]);
  // 0 is the row that catches a truthiness test in place of the `derived`
  // flag: it is a legal ephemeral bind (#366) and it is falsy.
  assert.deepEqual(cockpitPorts({ port: 0, derived: false }), [0]);
});

test("cockpitPorts: a derived port leads a bounded, contiguous window inside the range", () => {
  const ports = cockpitPorts({ port: 8200, derived: true });
  assert.equal(ports[0], 8200, "the scan must start at the stable, bookmarkable port, not one past it");
  assert.ok(ports.length > 1, "a derived port with no fallback is the failure this ticket exists to remove");
  // Every attempt can cost a bind plus a probe timeout, so the bound is what
  // keeps an exhausted range a refusal an operator waits seconds for rather
  // than minutes.
  assert.ok(ports.length <= 16, `${ports.length} attempts is not a bounded scan`);
  assert.deepEqual(ports, ports.map((_, i) => 8200 + i), "the window must be contiguous from the derived port");
});

// The top of the range is exactly where a naive `derived + i` walks out of
// the window resolveCockpitInstance() promises — onto ports this scheme
// never claimed, where no other workspace's cockpit could ever be found.
test("cockpitPorts: the window wraps at the top of the range rather than leaving it", () => {
  const top = PORT_BASE + PORT_SPAN - 1;
  const ports = cockpitPorts({ port: top, derived: true });
  assert.equal(ports[0], top);
  assert.equal(ports[1], PORT_BASE, "the port after the last one in the range is the first one");
  for (const p of ports) {
    assert.ok(p >= PORT_BASE && p < PORT_BASE + PORT_SPAN, `${p} escaped [${PORT_BASE}, ${PORT_BASE + PORT_SPAN})`);
  }
});

// A holder serving `dir` on a real ephemeral port, through the same
// server-creation seam the cockpit itself uses — no second I/O surface, in
// the tests either. A port someone else already holds comes back as
// `port: null`; any other bind failure rejects.
async function holderOn(dir, port = 0) {
  const server = createBoardServer(dir);
  const bound = await new Promise((res, rej) => {
    server.once("error", (e) => (e.code === "EADDRINUSE" ? res(null) : rej(e)));
    server.listen(port, () => res(server.address().port));
  });
  return { server, port: bound };
}

// The skip reason for a row that could not bind its fixed port itself
// (#2522): the outside process holding it can let go before the launch
// binds, and the launch then takes the port the row needed held.
function heldOutside(port) {
  return `port ${port} is held by a process outside this test, which can release it before the launch binds`;
}

const boardDir = (payload) => {
  const dir = tempDir("board-holder-");
  if (payload !== undefined) writeFileSync(join(dir, "board.json"), payload);
  return dir;
};

// holderOn's other half: only EADDRINUSE reads as "someone else holds it". A
// listen() that fails for any other reason must reject, not come back as
// `port: null`, which the rows that skip on a null port would then report as
// a port held from outside. A unix-socket path under a directory that does
// not exist fails through the same 'error' event without privileges; the
// code it fails with differs by platform, and that it is not EADDRINUSE is
// the point.
test("holderOn: a bind failure that is not EADDRINUSE rejects instead of reading as a held port", async () => {
  const dir = boardDir();
  try {
    await assert.rejects(
      holderOn(dir, join(dir, "no-such-dir", "s.sock")),
      (e) => e instanceof Error && e.code !== undefined && e.code !== "EADDRINUSE",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The half that must ACCEPT: a real board payload naming a workspace is the
// one answer the probe has to believe, and everything below is a way of not
// believing it. A probe that only ever returns null passes every negative
// row and turns the reuse path off entirely.
test("probeCockpitWorkspace: a live board's payload answers with its workspace", async () => {
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: "/w/mine" }));
  const { server, port } = await holderOn(dir);
  try {
    assert.equal(await probeCockpitWorkspace(port), "/w/mine");
  } finally { server.close(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

// Every way of failing to prove "this is my cockpit" is one answer: foreign.
// The 404 row is the live one — an empty state directory is what a cockpit
// whose first tick failed actually serves — and the rest are what a holder
// that is not a cockpit at all returns.
for (const [name, payload] of [
  ["no board.json at all (404)", undefined],
  ["a body that is not JSON", "<html>not a board</html>"],
  ["a payload with no workspace field", JSON.stringify({ tickets: [] })],
  ["a workspace that is not a string", JSON.stringify({ tickets: [], workspace: 42 })],
  ["an empty workspace", JSON.stringify({ tickets: [], workspace: "" })],
  ["a bare null payload", "null"],
]) {
  test(`probeCockpitWorkspace: ${name} reads as foreign`, async () => {
    const dir = boardDir(payload);
    const { server, port } = await holderOn(dir);
    try {
      assert.equal(await probeCockpitWorkspace(port), null);
    } finally { server.close(() => {}); rmSync(dir, { recursive: true, force: true }); }
  });
}

// #1660 review: every foreign row above happens to be a 404, which a
// mutation to `res.statusCode >= 400` would also reject — the guard must
// require exactly 200, not merely "not a client/server error". A non-200
// status carrying an otherwise-valid, matching workspace body is what tells
// the two apart: the real guard has to refuse it on status alone, without
// ever reading a body that would answer "yes" if it got that far.
test("probeCockpitWorkspace: a non-200 status with an otherwise-valid matching body still reads as foreign", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const body = JSON.stringify({ tickets: [], workspace: "/w/mine" });
      socket.end(`HTTP/1.1 301 Moved Permanently\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  const port = await new Promise((res) => server.listen(0, () => res(server.address().port)));
  try {
    assert.equal(await probeCockpitWorkspace(port), null,
      "a non-200 status must be refused on the status alone, even carrying a real workspace body");
  } finally { server.close(); }
});

// The case no HTTP status covers: a holder that accepts the connection and
// then says nothing. Only the probe's own timer ends this, and the injected
// timeout is what proves the timer is the thing that ended it — a probe that
// ignored its argument and used the ~1s default would sit here ten times
// longer than the bound below.
test("probeCockpitWorkspace: a holder that never answers is bounded, and a refused connection is immediate", async () => {
  const mute = muteHolder();
  const port = await new Promise((res) => mute.server.listen(0, () => res(mute.server.address().port)));
  try {
    const started = Date.now();
    assert.equal(await probeCockpitWorkspace(port, 100), null);
    const waited = Date.now() - started;
    assert.ok(waited < 700, `the probe waited ${waited}ms past its 100ms budget — the launch's bound is this one`);
  } finally { await mute.close(); }
  // Same answer by the other road: nothing is listening there any more, so
  // the connect is refused rather than hung.
  assert.equal(await probeCockpitWorkspace(port, 100), null);
});

// The first candidate this machine can actually bind — the derived port
// itself unless something outside this suite is sitting on it.
async function firstFreePort(ports) {
  for (const p of ports) {
    const free = await new Promise((res) => {
      const probe = createServer();
      probe.once("error", () => res(false));
      probe.listen(p, () => probe.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error(`test setup: no free port among ${ports.join(", ")}`);
}

async function untilBoardJson(url) {
  const ms = 15000, deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(`${url}/board.json`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`no readable board at ${url} after ${ms}ms`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// #1714: stub browser launchers. Each appends its own name and argv to one
// log and exits with the code it was given, so a row reads which launcher
// ran, at what URL and how many times — and no real browser is ever reached.
// Written into gitOnlyPath()'s directory, so git still resolves beside them.
const ALL_LAUNCHERS = { open: 0, "xdg-open": 0, wslview: 0 };
function launcherBin(launchers) {
  const bin = gitOnlyPath();
  const log = join(bin, "launched.log");
  for (const [name, code] of Object.entries(launchers)) {
    writeExecStub(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit ${code}\n`);
  }
  return { bin, launched: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

async function untilLaunched(rig, count) {
  const deadline = Date.now() + 20000;
  while (rig.launched().length < count) {
    if (Date.now() > deadline) throw new Error(`no launcher ran within 20000ms: ${JSON.stringify(rig.launched())}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// The reuse path end to end, and the claim no unit row can make: a second
// launch against a LIVE cockpit for the same workspace starts no server,
// says where the board already is, and exits 0. The exit code is the whole
// point — the documented launch is `serve --open &`, so a backgrounded
// non-zero exit is read by nobody and the operator just waits for a tab.
//
// The first launch's own landing rides this spawn rather than paying for one
// byte-identical to it: nothing is held, so it must take the port its
// workspace DERIVES. Every other row here only asserts where a launch did
// not land, so a scan that skipped the derived port entirely — or probed
// before it tried to bind — would pass all of them and move every
// bookmarked URL by one.
//
// #1714: both launches pass --open, the way run-team's phase 0 relaunches on
// every re-shortlist, with every launcher stubbed on PATH. The first bound
// the port, so it opens exactly one tab; the second found that cockpit
// already running (the held-port arm), so it opens none — before #1714 it
// opened the existing board again, one more tab per pass.
test("CLI: a second launch for the same workspace reuses the live cockpit, opens nothing, and exits 0", async () => {
  const rig = launcherBin(ALL_LAUNCHERS), repo = gitRepo("board-ws-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const expected = await firstFreePort(cockpitPorts(instance));
  const first = serveProcess(repo, rig.bin, ["--interval", "3600", "--open"]);
  try {
    const url = await withTimeout(first.url, 20000, "the first cockpit to announce");
    assert.equal(url, `http://127.0.0.1:${expected}`,
      "a launch with nothing in its way must take the port its workspace derives — that URL is the bookmarkable one");
    // The handshake reads the payload, so the first tick has to have landed.
    await untilBoardJson(url);
    assert.equal((await (await fetch(`${url}/board.json`)).json()).workspace, realpathSync(repo),
      "the board payload is what the handshake reads — a cockpit that does not name its workspace cannot be recognised");
    await untilLaunched(rig, 1);

    const second = serveSync(repo, rig.bin, ["--interval", "3600", "--open"]);
    assert.equal(second.status, 0, `the reuse path must exit 0 — a backgrounded launch reports nothing else: ${second.stderr}`);
    assert.match(second.stderr, new RegExp(`already running for this workspace on ${url}/`), second.stderr);
    assert.doesNotMatch(second.stderr, /cockpit on http/, `a second server was started for one workspace: ${second.stderr}`);
    // Read only once the second launch has exited, so anything it launched
    // is already in the log: still the first launch's one line, at its URL.
    const launched = rig.launched();
    assert.equal(launched.length, 1, `the launch that bound opens one tab and the reuse opens none: ${JSON.stringify(launched)}`);
    assert.ok(launched[0].endsWith(` ${url}/`), `the one tab is not the served board: ${launched[0]}`);
    assert.doesNotMatch(second.stderr, /could not open a browser/, second.stderr);
  } finally { first.p.kill("SIGKILL"); for (const d of [rig.bin, repo]) rmSync(d, { recursive: true, force: true }); }
});

// #1714: the reuse arm the row above cannot reach. That one's cockpit holds
// the derived port, so the second launch's bind fails and it handshakes the
// holder; here the derived port is FREE and this workspace's cockpit sits
// one candidate further along — the shape a departed squatter leaves — so
// the launch binds first and finds the match in its post-bind scan. That arm
// had its own copy of the open, and has to open nothing just the same. The
// stand-in cockpit answers from THIS process, so the launch is spawned
// asynchronously: a spawnSync would block the loop it answers on, and the
// probe would read it as silent rather than as this workspace's.
test("CLI: a launch whose post-bind scan finds this workspace's cockpit further along opens nothing", async () => {
  const rig = launcherBin(ALL_LAUNCHERS), repo = gitRepo("board-ws-scan-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const ports = cockpitPorts(instance);
  const free = await firstFreePort(ports);
  const further = await firstFreePort(ports.slice(ports.indexOf(free) + 1));
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: instance.workspace }));
  const { server, port } = await holderOn(dir, further);
  const p = spawn(process.execPath, serveArgs(["--interval", "3600", "--open"]),
    { cwd: repo, env: { ...process.env, PATH: rig.bin }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => { stderr += d; });
  try {
    assert.equal(port, further, "test setup: the stand-in cockpit must hold the later candidate");
    const status = await withTimeout(new Promise((res) => p.on("close", res)), 20000, "the launch to exit");
    assert.equal(status, 0, `the reuse path must exit 0: ${stderr}`);
    assert.match(stderr, new RegExp(`already running for this workspace on http://127\\.0\\.0\\.1:${further}/`), stderr);
    assert.doesNotMatch(stderr, /cockpit on http/, stderr);
    assert.deepEqual(rig.launched(), [], "a launch that found this workspace's cockpit already running opened a tab for it");
  } finally {
    p.kill("SIGKILL");
    server.close(() => {});
    for (const d of [rig.bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// #1714: which launcher a launch that bound its port runs, per platform (ADR
// 0009) — `open` on macOS; elsewhere `xdg-open`, then `wslview` (WSL) only
// when `xdg-open` is not on PATH at all, since one that ran and failed is the
// right program meeting a real fault. process.platform is forced in the
// child through a preload, so every platform's order is exercised on
// whichever one runs the suite, and each row's PATH also carries a launcher
// the forced platform must NOT reach for. A launch with no working launcher
// warns with the URL and keeps serving: it still answers after warning and
// exits 0 on the SIGTERM that ends it, exactly like one whose launcher
// worked — the status a missing `open` produced before #1714.
//
// Each row waits on --open's own outcome, not on a clock: read at a fixed
// deadline (the 2s spawnSync timeout this used to be), a launch slowed by a
// loaded machine had not reached its launcher yet and failed a row the code
// passes. openBrowser() warns only once it is done with the launcher list, so
// a warning row is complete the moment that line lands. A launcher that
// worked announces nothing, so a row expecting one waits for its log line and
// then LAUNCHER_SETTLE_MS more: a wrong second launcher, or a warning after
// all, would follow the one that worked within a turn of the loop, and this
// is the time it gets to show up. That wait can only miss a fault, never
// invent one.
const LAUNCHER_SETTLE_MS = 1000;
const WARNED = /could not open a browser.*\n/;
const serveOn = (platform, cwd, bin) => serveProcess(cwd, bin, ["--port", "0", "--interval", "3600", "--open"], [
  "--import", `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`)}`,
]);

async function untilWarned(launch) {
  const deadline = Date.now() + 20000;
  while (!WARNED.test(launch.stderr())) {
    if (Date.now() > deadline) throw new Error(`no --open warning within 20000ms: ${launch.stderr()}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

for (const [platform, launchers, ran, warns] of [
  ["darwin", ALL_LAUNCHERS, ["open"], false],
  ["linux", ALL_LAUNCHERS, ["xdg-open"], false],
  ["linux", { open: 0, wslview: 0 }, ["wslview"], false],
  ["linux", { "xdg-open": 3, wslview: 0 }, ["xdg-open"], true],
  ["linux", { open: 0 }, [], true],
  ["darwin", { "xdg-open": 0, wslview: 0 }, [], true],
]) {
  const onPath = Object.entries(launchers).map(([n, c]) => (c ? `${n} (exit ${c})` : n)).join(", ");
  test(`CLI: a fresh --open launch on ${platform} with ${onPath} on PATH runs ${ran.join(" ") || "no launcher"}${warns ? " and warns with the URL" : ""}`, async () => {
    const rig = launcherBin(launchers), cwd = tempDir("board-open-");
    const launch = serveOn(platform, cwd, rig.bin);
    const exited = new Promise((res) => launch.p.on("exit", (code, signal) => res({ code, signal })));
    try {
      const url = await withTimeout(launch.url, 20000, "the cockpit to announce");
      if (warns) {
        await untilWarned(launch);
        assert.match(launch.stderr(), new RegExp(`WARNING --open could not open a browser \\(.*\\) — the cockpit is on ${url}/`), launch.stderr());
      } else {
        await untilLaunched(rig, ran.length);
        await new Promise((res) => setTimeout(res, LAUNCHER_SETTLE_MS));
        assert.doesNotMatch(launch.stderr(), /could not open a browser/, launch.stderr());
      }
      assert.deepEqual(rig.launched(), ran.map((cmd) => `${cmd} ${url}/`), launch.stderr());
      const serving = await fetch(`${url}/board.json`).then((res) => res.ok, () => false);
      assert.ok(serving, `the cockpit stopped serving instead of running until signalled: ${launch.stderr()}`);
      launch.p.kill("SIGTERM");
      assert.deepEqual(await withTimeout(exited, 20000, "the cockpit to exit on SIGTERM"), { code: 0, signal: null }, launch.stderr());
    } finally {
      launch.p.kill("SIGKILL");
      for (const d of [rig.bin, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });
}

// The false-match half. This holder answers, parses, and serves a real board
// payload on the exact port this workspace derives — nothing but the
// workspace field distinguishes it from the cockpit reused above. A
// handshake that asks "did anyone answer" rather than "whose board is this"
// adopts it, and this run gets no board of its own at all.
//
// holderOn() names no host, so this stranger holds every interface — the
// shape of a dev server on the port. On macOS/BSD a 127.0.0.1 bind succeeds
// beside it instead of failing EADDRINUSE, and a launch that took the port
// that way would shadow the stranger on 127.0.0.1 rather than step over it.
// So the stranger has to still be the one answering there afterwards.
test("CLI: a holder reporting a different workspace is not adopted — the launch serves elsewhere", async (t) => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-foreign-");
  const { port: derived } = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: "/some/other/workspace" }));
  const { server, port: held } = await holderOn(dir, derived);
  const launch = held === null ? null : serveProcess(repo, bin, ["--interval", "3600"]);
  try {
    if (!launch) return t.skip(heldOutside(derived));
    const url = await withTimeout(launch.url, 20000, "the launch to step over the foreign holder");
    assert.notEqual(url, `http://127.0.0.1:${derived}`, "the launch adopted a board belonging to another workspace");
    const window = cockpitPorts({ port: derived, derived: true });
    assert.ok(window.includes(Number(url.split(":")[2])), `${url} is outside the bounded scan window ${window.join(", ")}`);
    // …and it is really serving its OWN board there, not merely announcing a
    // port it stepped onto.
    await untilBoardJson(url);
    assert.equal((await (await fetch(`${url}/board.json`)).json()).workspace, realpathSync(repo));
    assert.equal((await (await fetch(`http://127.0.0.1:${derived}/board.json`)).json()).workspace, "/some/other/workspace",
      "the launch bound 127.0.0.1 beside the stranger and took its traffic there");
  } finally {
    launch?.p.kill("SIGKILL");
    server.close(() => {});
    for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// The same-workspace half of the row above, with the holder bound the way a
// cockpit from before the loopback-only bind was: no host, every interface.
// A 127.0.0.1 bind beside it succeeds on macOS/BSD, so the bind failing is
// not what reports this cockpit; the launch has to find and reuse it anyway,
// exit 0 and open nothing. The holder answers from THIS process, so the
// launch is spawned asynchronously, for the reason the post-bind-scan row
// above gives.
test("CLI: this workspace's cockpit holding every interface on the derived port is reused, not shadowed", async (t) => {
  const rig = launcherBin(ALL_LAUNCHERS), repo = gitRepo("board-ws-wild-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: instance.workspace }));
  const { server, port: held } = await holderOn(dir, instance.port);
  const p = held === null ? null : spawn(process.execPath, serveArgs(["--interval", "3600", "--open"]),
    { cwd: repo, env: { ...process.env, PATH: rig.bin }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p?.stderr.setEncoding("utf8");
  p?.stderr.on("data", (d) => { stderr += d; });
  try {
    if (!p) return t.skip(heldOutside(instance.port));
    const status = await withTimeout(new Promise((res) => p.on("close", res)), 20000, "the launch to exit");
    assert.equal(status, 0, `the reuse path must exit 0: ${stderr}`);
    assert.match(stderr, new RegExp(`already running for this workspace on http://127\\.0\\.0\\.1:${instance.port}/`), stderr);
    assert.doesNotMatch(stderr, /cockpit on http/, `a second server was started beside this workspace's cockpit: ${stderr}`);
    assert.deepEqual(rig.launched(), [], "a launch that found this workspace's cockpit already running opened a tab for it");
  } finally {
    p?.kill("SIGKILL");
    server.close(() => {});
    for (const d of [rig.bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// The cockpit binds 127.0.0.1 and nothing else: its board is a read-only
// mirror of the ledger, and no other machine on the network has a reason to
// read it. A listen() with no host binds `::` dual-stack, which answers on
// 127.0.0.1 as well, so the half that tells the two apart is `[::1]`
// refusing. Skipped only on a host with no ::1 to refuse on.
test("CLI: serve binds 127.0.0.1 alone — 127.0.0.1 answers and [::1] refuses", async (t) => {
  const v6 = createServer();
  const noV6 = await new Promise((res) => { v6.once("error", res); v6.listen(0, "::1", () => v6.close(() => res(null))); });
  if (noV6) return t.skip(`this host has no ::1 to refuse on: ${noV6.code}`);
  const bin = gitOnlyPath(), cwd = tempDir("board-bind-");
  const launch = serveProcess(cwd, bin);
  try {
    const url = await withTimeout(launch.url, 20000, "the cockpit to announce");
    const port = Number(url.split(":")[2]);
    await untilBoardJson(`http://127.0.0.1:${port}`);
    const v6Answer = await new Promise((res) => {
      const s = connect({ host: "::1", port });
      s.once("connect", () => { s.destroy(); res("connected"); });
      s.once("error", (e) => res(e.code));
    });
    assert.equal(v6Answer, "ECONNREFUSED", `the cockpit answered on [::1]:${port}, so it is bound beyond 127.0.0.1`);
  } finally {
    launch.p.kill("SIGKILL");
    for (const d of [bin, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

// The two branches of the pre-bind connect check that no real listener can
// produce on demand: a connect that fails with something other than a
// refusal, and one that never completes. A loopback connect to a port
// nobody holds is always refused, and a holder whose accept backlog is full
// drops the SYN only on the kernel's schedule — so the launch runs with
// net.connect replaced, through the CJS exports (a module that imported the
// name picks the replacement up after syncBuiltinESMExports). The stub is
// in the child, so the port never has to be held: a launch that wrongly
// reads the stubbed answer as "free" goes on to bind `port` and serve, and
// the row sees a launch that never exits with 2.
//
// The replacement's answer reaches the assertion through board's own output
// — the EPERM text below, the "in use" line — so a stub that never landed
// reads as a failure of the row, not as a pass.
function serveWithConnect(stubBody, port, extraPreload = "") {
  const preload = `import { createRequire, syncBuiltinESMExports } from "node:module";
const net = createRequire(process.cwd() + "/")("node:net");
net.connect = () => { ${stubBody} };
${extraPreload}
syncBuiltinESMExports();`;
  const opts = serveOpts();
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, ...serveArgs(["--port", String(port), "--interval", "3600"])], { ...opts, timeout: 10000 });
  return { r, cwd: opts.cwd };
}

// A port nobody holds, for a launch whose connect is stubbed: only a launch
// that wrongly decides the port is free ever binds it.
async function unheldPort() {
  const probe = createServer();
  const port = await new Promise((res) => probe.listen(0, "127.0.0.1", () => res(probe.address().port)));
  await new Promise((res) => probe.close(res));
  return port;
}

// ECONNREFUSED is the one connect error that means "free". Any other —
// EPERM from a sandbox that denies loopback connects, say — is a fault of
// the launch's own, and binding anyway would answer a question the check
// could not ask. It dies naming the check, with the error's own text after
// it, and starts nothing.
test("CLI: a pre-bind connect that fails with anything but a refusal is fatal, not read as a free port", async () => {
  const port = await unheldPort();
  const { r, cwd } = serveWithConnect(
    `const s = new net.Socket(); setImmediate(() => s.emit("error", Object.assign(new Error("connect EPERM 127.0.0.1:${port}"), { code: "EPERM" }))); return s;`,
    port,
  );
  assert.equal(r.status, 2, `a connect fault must refuse, not bind: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`cannot check whether port ${port} is held: connect EPERM 127\\.0\\.0\\.1:${port}`), `the refusal must name the held-check and carry the stubbed error: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /in use/, `a connect fault is not a held port: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /cockpit on http/, `the launch bound after a connect fault: ${r.stderr}`);
  assert.ok(!existsSync(join(cwd, ".fleet")), "the launch created a state directory after a connect fault");
});

// The code a connect error carries does not decide whose fault it is: one
// that says EADDRINUSE — a connect that cannot get a local port — is still
// the check's own failure, not the held-port answer the check resolves for a
// connect that succeeds or times out.
test("CLI: a pre-bind connect error carrying EADDRINUSE dies naming the check, not as a held port", async () => {
  const port = await unheldPort();
  const { r, cwd } = serveWithConnect(
    `const s = new net.Socket(); setImmediate(() => s.emit("error", Object.assign(new Error("connect EADDRINUSE 127.0.0.1:${port}"), { code: "EADDRINUSE" }))); return s;`,
    port,
  );
  assert.equal(r.status, 2, `a connect fault must refuse: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`cannot check whether port ${port} is held: connect EADDRINUSE 127\\.0\\.0\\.1:${port}`), `the refusal must name the held-check and carry the stubbed error: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /in use/, `a connect fault is not a held port: ${r.stderr}`);
  assert.ok(!existsSync(join(cwd, ".fleet")), "the launch created a state directory after a connect fault");
});

// The other side of that wording: a bind that fails with a fault of its own
// — EACCES here, past a connect that was refused — dies with the bind's text
// as it came, never attributed to the held-check that let it through.
test("CLI: a bind fault after a refused pre-bind connect dies with the bind's own message", async () => {
  const port = await unheldPort();
  const { r } = serveWithConnect(
    `const s = new net.Socket(); setImmediate(() => s.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:${port}"), { code: "ECONNREFUSED" }))); return s;`,
    port,
    `net.Server.prototype.listen = function () { setImmediate(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:${port}"), { code: "EACCES" }))); return this; };`,
  );
  assert.equal(r.status, 2, `a bind fault must refuse: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`listen EACCES: permission denied 127\\.0\\.0\\.1:${port}`), `the stubbed bind error never reached the launch: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /cannot check whether port/, `a bind fault was reported as the held-check's: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /in use/, `a bind fault is not a held port: ${r.stderr}`);
});

// A holder whose accept backlog is full drops the SYN instead of refusing
// it, so "nothing answered within the timeout" has to count as held — read
// as free, the launch would bind beside a live holder on macOS/BSD. The
// stub's socket never connects and never errors; the check's own timer is
// the only thing that can end it. The keep-alive interval stands in for the
// kernel's pending connect, which keeps a real process alive; without it a
// never-resolving promise lets the process exit 0 with nothing said.
test("CLI: a pre-bind connect that never completes counts as a held port", async () => {
  const port = await unheldPort();
  const { r, cwd } = serveWithConnect(
    `const s = new net.Socket(); const keep = setInterval(() => {}, 100); s.once("close", () => clearInterval(keep)); return s;`,
    port,
  );
  assert.equal(r.status, 2, `an unanswered connect must read as held: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`port ${port} in use`), r.stderr);
  assert.doesNotMatch(r.stderr, /cockpit on http/, `the launch bound beside a port it could not prove free: ${r.stderr}`);
  assert.ok(!existsSync(join(cwd, ".fleet")), "the launch created a state directory for a port it did not take");
});

// The only hard failure left on a derived port, and the shape it has to
// have. Non-zero, because an exhausted range is a real refusal where reuse
// is not — and a message naming every port tried, because an operator told
// only "no free port" cannot tell a crowded range from a broken derivation.
//
// The blockers serve an empty directory, so each one 404s /board.json — one
// of the foreign shapes no launch may adopt. They cannot actually answer
// during the spawn below, though: spawnSync blocks this runner's event loop,
// so every probe runs out its full timeout, retries once (#1660 — a timeout
// alone does not prove foreign), and the row costs ~16s (measured, up from
// ~8s pre-#1660: PORT_ATTEMPTS candidates times two attempts times
// PROBE_TIMEOUT_MS). That is the bound doing its job rather than a hang,
// and it is why this row is the only slow one here — the rows that need a
// holder to really answer use serveProcess(), which leaves the loop free.
test("CLI: an exhausted derived range exits non-zero and names the ports it tried", async (t) => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-full-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const ports = cockpitPorts(instance);
  const dir = boardDir(undefined);
  const blockers = [];
  try {
    // The range full of OUR sockets: a port something else already holds
    // can be let go before the launch binds, and the launch then serves.
    for (const p of ports) {
      const holder = await holderOn(dir, p);
      if (holder.port === null) return t.skip(heldOutside(p));
      blockers.push(holder.server);
    }
    const r = serveSync(repo, bin, ["--interval", "3600"], 30000);
    assert.equal(r.status, 2, `an exhausted range must refuse, not hang and not succeed: ${r.stderr}`);
    for (const p of ports) assert.match(r.stderr, new RegExp(`\\b${p}\\b`), `the refusal does not name ${p}: ${r.stderr}`);
    assert.match(r.stderr, /--port/, "the refusal has to point at the way out of it");
    assert.doesNotMatch(r.stderr, /cockpit on http/, r.stderr);
  } finally {
    for (const s of blockers) s.close(() => {});
    for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// Neither half of the new behaviour may touch a port the operator named, and
// this replaces the narrower row that pinned only the bind error's wording
// there (its other assertion, the absence of the "(default)" marker, pins a
// string no path can print any more). The holder here is not a stranger: it
// serves a payload naming THIS workspace, the exact thing the derived path
// reuses at exit 0 above. A handshake not gated on `instance.derived` adopts
// it and exits 0, silently serving a board the operator did not ask for on
// the port they did.
test("CLI: an explicit port neither scans nor handshakes — a bind failure on it is fatal", async () => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-explicit-");
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: realpathSync(repo) }));
  const { server, port } = await holderOn(dir);
  try {
    const r = serveSync(repo, bin, ["--interval", "3600", "--port", String(port)]);
    assert.equal(r.status, 2, `a bind failure on a chosen port is a hard error: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`port ${port} in use`), r.stderr);
    assert.doesNotMatch(r.stderr, /already running/, "an explicit port was handshaked and reused");
    assert.doesNotMatch(r.stderr, /trying the next port/, "an explicit port was scanned off");
  } finally { server.close(() => {}); for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true }); }
});

// #1093: the CLI's top-level handler printed `e.message`, which is `undefined`
// for a rejection that is not an `Error` — so the whole diagnostic was the
// literal `board: undefined`. Nothing in this file throws a non-Error today,
// which is why this is the unit half of board-cli.test.mjs's fault case: the
// text the handler writes has to carry bytes for every value a rejection can
// arrive as, including the four that render as nothing under a naive
// `String(e)`/`e.message` read.
test("faultText renders any rejected value, so no fault prints an empty diagnostic", () => {
  for (const v of [undefined, null, "", 0, false, { a: 1 }]) {
    const t = faultText(v);
    assert.match(t, /\S/, `faultText(${String(v)}) has nothing in it`);
    assert.notEqual(t, "undefined", "the `board: undefined` diagnostic is exactly what this replaces");
  }
  // The rejected value is NAMED, not merely non-empty: a constant string would
  // satisfy the loop above and tell the reader nothing.
  assert.match(faultText(undefined), /undefined/);
  assert.match(faultText({ a: 1 }), /a: 1/);
  // Why inspect() and not JSON.stringify: a self-referential rejection is a
  // value like any other, and stringify THROWS on it — inside the fault
  // handler, which is the one place left that can still report anything.
  const circular = {};
  circular.self = circular;
  assert.match(faultText(circular), /Circular/);
  // An Error keeps its stack verbatim. That is the whole point of the path:
  // a message alone is what made a fault indistinguishable from a refusal.
  const e = new Error("boom");
  assert.equal(faultText(e), e.stack);
  assert.match(faultText(e), /\n\s+at /);
});

// #1547: fault() writes a full stack trace in a single writeSync(2, ...) call
// — the same unlooped shape die()'s pre-#889 bug had (arg.mjs). board.mjs has
// exactly one writeSync call site — this is it, not the largest of four in
// this file — but it is one of four across the fleet (arg.mjs's die(),
// board.mjs's fault(), ci-state.mjs's emit(), staleness.mjs's verdict()) and
// carries the largest single payload of the four: a full stack, not a
// one-line refusal. A short write returns the count it actually wrote and
// throws nothing at all, so a bare try/catch around one call never sees it
// and the diagnostic is silently truncated with no error — the class
// ci-state.mjs's emit() had before #885, and the reason #889 gave
// die()/verdict() a bounded retry loop.
//
// A source-shape pin alone cannot tell a retry loop from a bare call that
// happens to fit in one write, and the pin below used to stop at the resumed
// writeSync call itself — the EAGAIN check, the MAX_EAGAIN_RETRIES cap and
// the Atomics.wait backoff that follow were unanchored, so a mutant that
// collapses the whole catch block to a bare `break;` — deleting the retry
// this PR exists to add — still passed it (measured). The regex below now
// anchors through those lines too, and board-cli.test.mjs pairs this with an
// EXECUTED companion: a real non-blocking stderr pipe that starts fully
// saturated and is never drained, the same rig staleness.test.mjs's verdict()
// test and arg.test.mjs's die() test use — but timed, not just bounded, since
// a doomed single call and a 200-retry loop against a pipe that never drains
// both write nothing and both still reach process.exit() well inside any
// generous bound; only the loop spends real time doing it.
//
// A body that still calls writeSync once and discards the count — `try {
// writeSync(2, ...) } catch {}` — satisfies a pin that stops at `try {`, so
// this one requires the loop that resumes from writeSync's own return value,
// and now the retry/backoff that follows it too. Each fragment is anchored at
// a line start and joined with `\s*^\s*`, and no fragment is terminated with
// `$`, so a comment line added inside fault() does not redden this and a
// trailing comment cannot satisfy it — the anchoring candidates.test.mjs's
// die() pin documents in full.
test("fault()'s writeSync loop consumes its own return value and retries EAGAIN with a capped backoff, not just a bare call", () => {
  assert.equal(
    stripComments(readFileSync(SCRIPT, "utf8")).match(/^\s*function fault\(/gm)?.length,
    1,
    "board.mjs declares fault() more than once, or not at all — the pin below reads the first",
  );
  assert.match(
    stripComments(readFileSync(SCRIPT, "utf8")),
    /^\s*function fault\(e\) \{\s*^\s*try \{\s*^\s*let buf = Buffer\.from\(`[^`]*`\);\s*^\s*let retries = 0;\s*^\s*while \(buf\.length\) \{\s*^\s*try \{\s*^\s*buf = buf\.subarray\(writeSync\(2, buf\)\);\s*^\s*\} catch \(writeErr\) \{\s*^\s*if \(writeErr\.code !== "EAGAIN" \|\| \+\+retries > MAX_EAGAIN_RETRIES\) break;\s*^\s*Atomics\.wait\(IDLE, 0, 0, 1\);/m,
  );
});

// board.mjs had no row in the design spec's script-surface table, so neither of
// its exit codes was written down anywhere a consumer reads. Derived from the
// script rather than restated here: the fault code is read out of board.mjs's
// own declaration, so changing it there and leaving the document behind reddens
// this — the drift #407 caught the hard way for candidates.mjs's exit 3.
test("the design spec's board row names both exit codes the script can produce", () => {
  const declared = readFileSync(SCRIPT, "utf8").match(/^const FAULT_EXIT = (\d+);$/m);
  assert.ok(declared, "board.mjs no longer declares FAULT_EXIT — update this test");
  const spec = readFileSync(
    fileURLToPath(new URL("../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `board.mjs` |"));
  assert.ok(row, "the design spec's script-surface table has no `board.mjs` row");
  for (const code of ["2", declared[1]]) {
    assert.match(row, new RegExp(`exit ${code}\\b`, "i"), `the board row does not name exit ${code}`);
  }
});
