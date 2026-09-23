// Smoke test for the HTTP layer, plus the transcript-reading layer underneath
// the spend panel — no gh, no build loop. Boots the static server against a temp
// dir and asserts it serves board.json and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, chmodSync, rmSync, readFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createBoardServer, mapCi, encodeProjectDir, findSubagentsDir, spendDirPin, gatherSpend, faultText, resolveCockpitInstance, cockpitPorts, probeCockpitWorkspace } from "./board.mjs";
import { stripComments } from "./strip-comments.mjs";
import { gitEnv } from "./git-env.mjs";

const SCRIPT = fileURLToPath(new URL("./board.mjs", import.meta.url));

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
  const cwd = mkdtempSync(join(tmpdir(), "board-gather-"));
  const bin = mkdtempSync(join(tmpdir(), "board-gather-bin-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "board-gather-scripts-"));
  writeFileSync(join(scriptDir, "ci-state.mjs"), ciStateBody);
  const rows = JSON.stringify(prs.map((n) => ({ number: n, state: "OPEN", labels: [], title: "t" })));
  writeFileSync(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"pr list") echo '${rows}' ;;\n*) exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
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
  const markerDir = mkdtempSync(join(tmpdir(), "board-dualarm-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "board-gather-rows-"));
  const bin = mkdtempSync(join(tmpdir(), "board-gather-rows-bin-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "board-gather-rows-scripts-"));
  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeFileSync(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"issue list") echo '${issuesJson}' ;;\n"pr list") echo '${prsJson}' ;;\n*) exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
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
  const dir = mkdtempSync(join(tmpdir(), "board-"));
  writeFileSync(join(dir, "board.json"), JSON.stringify({ generatedAt: 1, tickets: [], attention: [] }));
  writeFileSync(join(dir, "board.html"), "<!doctype html><title>cockpit</title>");
  const server = createBoardServer(dir);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const j = await fetch(`http://localhost:${port}/board.json`);
  assert.equal(j.status, 200);
  assert.equal((await j.json()).generatedAt, 1);

  const h = await fetch(`http://localhost:${port}/`);
  assert.equal(h.status, 200);
  assert.match(await h.text(), /cockpit/);

  const nf = await fetch(`http://localhost:${port}/nope`);
  assert.equal(nf.status, 404);

  await new Promise((res) => server.close(res));
});

// ── the spend transcript layer ────────────────────────────────────────────────
// Both bugs this file now pins were invisible to the pure-module tests, because
// both live in the I/O that feeds them: a wrong path and a wrong summation. Each
// failed silently as "panel hidden" or "plausible but 3x too big".

test("encodeProjectDir replaces dots as well as slashes", () => {
  // Regression: replacing only `/` produced `-Users-x-.claude`, which never
  // exists, so the panel silently vanished for every dotted cwd — including the
  // repo the fleet skills themselves run out of.
  assert.equal(encodeProjectDir("/Users/x/.claude"), "-Users-x--claude");
  assert.equal(encodeProjectDir("/Users/x/dev/repo"), "-Users-x-dev-repo");
  assert.equal(encodeProjectDir("/Users/x/dev/repo/.claude/worktrees/a"), "-Users-x-dev-repo--claude-worktrees-a");
});

test("findSubagentsDir resolves a dotted cwd and picks the newest session", () => {
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-Users-x--claude");
  const older = join(proj, "11111111-aaaa", "subagents");
  const newer = join(proj, "22222222-bbbb", "subagents");
  mkdirSync(older, { recursive: true });
  mkdirSync(newer, { recursive: true });
  // Ranking reads the newest *.jsonl mtime, so stamp the TRANSCRIPTS, not the
  // dirs. Stamp both explicitly rather than sleeping for a clock tick: both are
  // created inside the same millisecond on a fast filesystem, `mtimeMs` ties,
  // and the sort is stable — a tie would resolve to readdir order and
  // `11111111-aaaa` would win on name.
  writeFileSync(join(older, "agent-a.jsonl"), "");
  utimesSync(join(older, "agent-a.jsonl"), new Date(1000), new Date(1000));
  writeFileSync(join(newer, "agent-b.jsonl"), "");
  utimesSync(join(newer, "agent-b.jsonl"), new Date(9000), new Date(9000));

  assert.equal(findSubagentsDir(home, "/Users/x/.claude"), newer);
  // Unresolvable path is a bug, not an empty run — it must be distinguishable.
  assert.ok(findSubagentsDir(home, "/Users/x/nonexistent").error);
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
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  const busy = join(proj, "aaaa", "subagents");   // spawned its agents early, still appending
  const idle = join(proj, "bbbb", "subagents");   // spawned one last agent, then went quiet
  mkdirSync(busy, { recursive: true });
  mkdirSync(idle, { recursive: true });
  writeFileSync(join(busy, "agent-b.jsonl"), "");
  writeFileSync(join(idle, "agent-i.jsonl"), "");
  utimesSync(join(busy, "agent-b.jsonl"), new Date(9000), new Date(9000)); // newest TRANSCRIPT
  utimesSync(join(idle, "agent-i.jsonl"), new Date(1000), new Date(1000));
  utimesSync(busy, new Date(1000), new Date(1000));
  utimesSync(idle, new Date(9000), new Date(9000));                        // newest DIRECTORY

  assert.equal(findSubagentsDir(home, "/x"), busy);
});

test("one unreadable session directory loses the ranking instead of sinking the lookup", () => {
  // Regression: newestTranscriptMs' readdirSync sat outside its per-file try and
  // inside findSubagentsDir's, so one bad sibling turned the WHOLE lookup into
  // { error } and the board rendered "spend unavailable" over a perfectly
  // readable live session — a blackout where the per-file catch beside it
  // already chose degradation. A candidate we cannot read must score 0 and lose.
  //
  // `subagents` as a regular FILE rather than a chmod 000 dir: ENOTDIR is the
  // same uncaught throw and, unlike a permission bit, it still throws when the
  // suite runs as root.
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  const good = join(proj, "aaaa", "subagents");
  mkdirSync(good, { recursive: true });
  mkdirSync(join(proj, "bbbb"), { recursive: true });
  writeFileSync(join(proj, "bbbb", "subagents"), "not a directory");
  writeFileSync(join(good, "agent-a.jsonl"), "");

  assert.equal(findSubagentsDir(home, "/x"), good);
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
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  const mine = join(proj, "sess-a", "subagents");
  const theirs = join(proj, "sess-b", "subagents");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(mine, "agent-a.jsonl"), "");
  writeFileSync(join(theirs, "agent-b.jsonl"), "");
  // Both predate the pin below — stamped well in the past, the same as a
  // session that was already running before this server launched.
  utimesSync(join(mine, "agent-a.jsonl"), new Date(Date.now() - 100000), new Date(Date.now() - 100000));
  utimesSync(join(theirs, "agent-b.jsonl"), new Date(Date.now() - 200000), new Date(Date.now() - 200000));

  const pin = spendDirPin(undefined, home, "/x");
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
  assert.equal(findSubagentsDir(home, "/x"), mine, "the fixture really did flip — this test proves nothing otherwise");
});

test("no session at launch is not an answer to pin — the first one to write on this pin's watch wins, and then holds", () => {
  // The launch path this script actually has: the cockpit starts in run-team
  // phase 0, BEFORE the first agent spawns, so the project directory routinely
  // holds no subagents directory at all. Pinning that `null` would hide the
  // spend panel for the entire run — the existing degradation is "hidden until
  // agents land", not "hidden for good", and this is the assertion that keeps
  // the pin from being written as "whatever the first call returned".
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  mkdirSync(proj, { recursive: true });
  const pin = spendDirPin(undefined, home, "/x");
  assert.equal(pin(), null, "no session yet is the normal state at run start, not a fault");

  const first = join(proj, "sess-first", "subagents");
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

  const second = join(proj, "sess-second", "subagents");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "agent-b.jsonl"), "");
  utimesSync(join(second, "agent-b.jsonl"), new Date(Date.now() + 50000), new Date(Date.now() + 50000));
  assert.equal(pin(), first, "and holds against a newer session exactly as a launch-time pin does");
});

test("an unresolvable transcript tree is never pinned — one stderr line across ticks either way, panel hidden and never zeroed", () => {
  // #1679: `{ error }` is no longer latched (see the recovery test below), so
  // the one-line-per-fault promise can no longer come from caching upstream —
  // it comes from gatherSpend's own warnOnce gate, keyed on the message,
  // which needs nothing cached above it to hold.
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
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
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  const sess = join(proj, "sess-a", "subagents");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "agent-a.jsonl"), "");
  chmodSync(proj, 0o000);
  try {
    const pin = spendDirPin(undefined, home, "/x");
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
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const heuristic = join(home, ".claude", "projects", "-x", "sess-a", "subagents");
  mkdirSync(heuristic, { recursive: true });
  writeFileSync(join(heuristic, "agent-a.jsonl"), "");
  const named = mkdtempSync(join(tmpdir(), "spend-named-"));

  assert.equal(findSubagentsDir(home, "/x"), heuristic, "the heuristic has an answer of its own here");
  const pin = spendDirPin(named, home, "/x");
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
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const live = join(home, ".claude", "projects", encodeProjectDir(process.cwd()), "sess", "subagents");
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spend-pin-cwd-")));
  const home = mkdtempSync(join(tmpdir(), "spend-pin-home-"));
  const bin = mkdtempSync(join(tmpdir(), "spend-pin-bin-"));
  // gh fails on every call and the reads degrade, so this stays offline and off
  // this repo's live issue list. Prepended rather than replacing PATH: gather()
  // shells out to `node` for the ledger read.
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const proj = join(home, ".claude", "projects", encodeProjectDir(cwd));
  const mine = join(proj, "sess-a", "subagents");
  const theirs = join(proj, "sess-b", "subagents");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  // With no sidecar the panel labels an agent by its filename stem, so the
  // board itself names which session it read — no second fixture needed for it.
  const turn = TURN.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(mine, "agent-session-a.jsonl"), turn);
  utimesSync(join(mine, "agent-session-a.jsonl"), new Date(9000), new Date(9000));
  writeFileSync(join(theirs, "agent-session-b.jsonl"), turn);
  utimesSync(join(theirs, "agent-session-b.jsonl"), new Date(1000), new Date(1000));

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
    utimesSync(join(mine, "agent-session-a.jsonl"), new Date(), new Date());
    const minedAt = Date.now();
    const first = await until((b) => b.spend?.ok && b.generatedAt > minedAt, "a tick generated after session-a writes on this server's watch");
    assert.equal(first.spend.top[0].label, "session-a", "the session that wrote on this server's watch is read");

    // The other session writes later: a second run starting, an agent landing.
    utimesSync(join(theirs, "agent-session-b.jsonl"), new Date(), new Date());
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

// One assistant turn, written the way Claude Code actually writes it: three
// lines, same message.id, the SAME usage object repeated on each. Only
// output_tokens varies — it is a streaming snapshot, so the last is the total.
const TURN = [
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 1 }, content: [{ type: "thinking" }] } },
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 300 }, content: [{ type: "tool_use", id: "t2", name: "Read" }] } },
];

function fixture(lines, meta) {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  writeFileSync(join(dir, "agent-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (meta) writeFileSync(join(dir, "agent-x.meta.json"), JSON.stringify(meta));
  return dir;
}

test("a turn spanning several jsonl lines is billed ONCE, not once per line", () => {
  // Regression: summing usage per line inflated cache_creation by +206% over
  // 2452 real transcripts. The tell was the panel disagreeing with itself —
  // by-role total 4.2x the by-tool total, both claiming to be the same number.
  const s = gatherSpend({ dir: fixture(TURN, { description: "Review PR 1" }) });
  assert.equal(s.totals.cacheWrite, 1000); // not 3000
  assert.equal(s.totals.cacheRead, 50); // not 150
  assert.equal(s.totals.output, 300); // max, not 1+1+300
  assert.equal(s.totals.maxCtx, 1052); // input + read + write, counted once
  assert.equal(s.totals.agents, 1);
});

test("tool calls split across a turn's lines are all counted", () => {
  const s = gatherSpend({ dir: fixture(TURN) });
  const by = Object.fromEntries(s.tools.map((t) => [t.tool, t.calls]));
  assert.equal(by.Bash, 1);
  assert.equal(by.Read, 1);
});

test("by-tool attribution never exceeds the cache_creation it is a share of", () => {
  // The invariant the double-count broke: both panels are views of one number.
  const s = gatherSpend({
    dir: fixture([
      ...TURN,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(300) }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(100) }] } },
      { type: "assistant", message: { id: "msg_2", usage: { cache_creation_input_tokens: 400, output_tokens: 5 }, content: [{ type: "text" }] } },
    ]),
  });
  const toolTotal = s.tools.reduce((n, t) => n + t.cacheWrite, 0);
  assert.ok(toolTotal <= s.totals.cacheWrite, `${toolTotal} > ${s.totals.cacheWrite}`);
  // The two consecutive result turns both get attributed, 300:100 of the 400.
  const by = Object.fromEntries(s.tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Bash, 300);
  assert.equal(by.Read, 100);
});

test("a prose turn whose content is a STRING does not throw", () => {
  // The trap that once turned into a silently absent panel via the outer catch.
  const s = gatherSpend({
    dir: fixture([
      { type: "user", message: { content: "plain prose, not an array" } },
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

test("a meta.json that exists but cannot be read is reported, not swallowed", () => {
  // #325: the catch here was labelled `/* unnamed agent */`, but existsSync
  // already covers that case, so the only thing reaching it is a real fault —
  // here a read torn mid-write. Measured before the fix: role "other", 0 bytes
  // on stderr, and with a reviewer's meta torn this way reviewPct went 80 -> 0.
  const dir = fixture(TURN);
  writeFileSync(join(dir, "agent-x.meta.json"), '{"spawnDepth":0,"descrip');
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.meta\.json/);
  // #686: the {} fallback drops the panel label to the filename stem too, not
  // just the role — the warning must name both consequences, or the operator
  // reading stderr learns the role changed and is never told the row was renamed.
  assert.match(errs[0], /labelling it from its filename/);
  // Still BOOKED, not skipped. The transcript itself is readable, so letting the
  // fault throw would hand it to the per-file catch above and drop this agent's
  // real tokens from the totals — a wrong total in place of a wrong role.
  assert.equal(s.totals.cacheWrite, 1000);
  assert.equal(s.skipped, 0);
  // #602: booked does not mean undetectable. The role/label are still wrong —
  // "other" and the bare filename — and metaErrors is the one field on this
  // return that says so, distinct from a genuinely zero reviewPct.
  assert.equal(s.metaErrors, 1);
  // #686: pin the label fallback itself, not just the warning that announces it.
  assert.equal(s.top[0].label, "x");
});

test("#686: an intact sidecar's description still wins as the label, unaffected", () => {
  // The accept-path guard for #686: a fix aimed at the fallback label's wording
  // must not start affecting the ordinary case where meta.json is fine.
  const s = gatherSpend({ dir: fixture(TURN, { description: "Review PR 1" }) });
  assert.equal(s.top[0].label, "Review PR 1");
});

test("a genuinely absent meta.json — the real unnamed agent — stays silent", () => {
  // The false-positive half. The unnamed-agent path is the existsSync guard, and
  // it must not start emitting a warning: every controller-dispatched agent
  // without a sidecar would print one, every tick.
  let s;
  assert.deepEqual(withStderr(() => { s = gatherSpend({ dir: fixture(TURN) }); }), []);
  // #602: the false-positive half of metaErrors too — an unnamed agent is
  // normal operation, not a fault, and must not inflate the tally.
  assert.equal(s.metaErrors, 0);
});

test("a meta.json holding valid JSON of the wrong SHAPE is a SIDECAR fault", () => {
  // JSON.parse SUCCEEDS on `null`, so the shape check is the only thing between
  // it and `a.meta.description`. Measured without the guard: the agent's 1000
  // cacheWrite left the totals, it was counted `skipped`, and stderr blamed
  // `agent-x.jsonl` — the TRANSCRIPT — for a fault that is the sidecar's.
  const dir = fixture(TURN);
  writeFileSync(join(dir, "agent-x.meta.json"), "null");
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.meta\.json/);
  assert.equal(s.totals.cacheWrite, 1000);
  assert.equal(s.skipped, 0);
  assert.equal(s.metaErrors, 1);
});

test("#602: a reviewer's torn meta sidecar is distinguishable from a genuine zero reviewPct", () => {
  // Reproduces the issue's measured refuter probe: a reviewer + an implementer,
  // the reviewer's sidecar torn. reviewPct still reads 0 — fixing that number is
  // the #325 defect this ticket was explicitly deferred FROM, not this one's
  // business — but metaErrors is the new field that says the 0 is not to be
  // trusted, where before nothing on this return did.
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  const reviewerTurn = JSON.stringify({ type: "assistant", message: { id: "r1", usage: { cache_creation_input_tokens: 4000, output_tokens: 1 }, content: [] } });
  const implTurn = JSON.stringify({ type: "assistant", message: { id: "i1", usage: { cache_creation_input_tokens: 1000, output_tokens: 1 }, content: [] } });
  writeFileSync(join(dir, "agent-reviewer.jsonl"), reviewerTurn + "\n");
  writeFileSync(join(dir, "agent-reviewer.meta.json"), '{"description":"Review PR 1"'); // torn mid-write
  writeFileSync(join(dir, "agent-impl.jsonl"), implTurn + "\n");
  writeFileSync(join(dir, "agent-impl.meta.json"), JSON.stringify({ description: "impl-1" }));
  const s = gatherSpend({ dir });
  assert.equal(s.reviewPct, 0); // unchanged — the fault this ticket does not fix
  assert.equal(s.metaErrors, 1); // but now visible as a fault, not a legitimate zero
  assert.equal(s.skipped, 0); // both transcripts still contributed their tokens
  assert.equal(s.totals.cacheWrite, 5000);
});

test("#602: a legitimately zero reviewPct with no sidecar fault reports no metaErrors — no false positive", () => {
  const s = gatherSpend({ dir: fixture(TURN, { description: "impl-1" }) });
  assert.equal(s.reviewPct, 0); // genuinely no review-side spend this run
  assert.equal(s.metaErrors, 0); // and nothing claims otherwise
});

test("a broken sidecar warns ONCE across ticks, not once per tick", () => {
  // `serve` rebuilds every ~15s and a broken sidecar is broken on every one, so
  // the `meta` gate is the whole difference between one line and a flood.
  // A single call cannot see that gate at all — pinning it takes two.
  const dir = fixture(TURN);
  writeFileSync(join(dir, "agent-x.meta.json"), '{"spawnDepth":0,"descrip');
  const errs = withStderr(() => { gatherSpend({ dir }); gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one line across two ticks, got " + JSON.stringify(errs));
});

// #606: the per-line catch inside readAgent was position-blind. Its comment
// justified the skip with one cause — the torn last line a transcript being
// appended to has on every tick — but applied it to every line in the split.
// Measured before the fix on a 3-turn transcript, cache_creation 100/200/300:
// a mid-file tear read 400 and a tail tear read 300, both with `skipped` 0 and
// zero bytes on stderr, so the never-expected fault and the expected one were
// indistinguishable to anyone watching.
//
// Raw-text sibling of fixture(): these two pin opposite sides of one
// discriminator, and the TRAILING NEWLINE is the whole difference between them
// — fixture() always writes one, which is exactly the case that must stay
// silent. One jsonl line per turn HERE, so a lost line is a lost turn and the
// cacheWrite assertions below are exact. A real multi-line turn degrades instead
// of vanishing: usage is billed once, on the first SURVIVING line carrying that
// message.id, so cache_creation / cache_read / maxCtx come through whole — but
// the tear still costs that line's tool_use blocks, and tearing the line that
// holds the largest output_tokens snapshot drops the turn's output to the
// largest that survived (measured on a 1/1/300 turn: 300 -> 1).
function rawFixture(text) {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  writeFileSync(join(dir, "agent-x.jsonl"), text);
  return dir;
}
const oneLineTurn = (id, cw) => JSON.stringify({
  type: "assistant",
  message: { id, usage: { input_tokens: 0, cache_creation_input_tokens: cw, cache_read_input_tokens: 0, output_tokens: 7 }, content: [{ type: "text" }] },
});
const TORN = '{"type":"assist';
// Hoisted rather than spelled out at each use: three tests below feed the SAME
// mid-file tear, and two of them exist only to re-run the first's exact input.
// Spelled out per site, one can be edited and the others stay green — measured,
// the whole 1158-test suite passes with the copies drifted apart.
const MIDFILE_TEAR = [oneLineTurn("msg_a", 1000), TORN, oneLineTurn("msg_c", 500)].join("\n") + "\n";

test("a transcript line damaged away from the tail is reported, not swallowed", () => {
  // The real-fault half. The damaged line sits BETWEEN two good turns, so the
  // assertion also covers the ticket's second requirement: the surrounding
  // turns' spend is still accounted rather than lost with it.
  const dir = rawFixture(MIDFILE_TEAR);
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.jsonl/);
  assert.equal(s.totals.cacheWrite, 1500);
  // Booked, not skipped — a damaged line costs its own turn, never the agent.
  assert.equal(s.skipped, 0);
});

test("a torn LAST line stays silent — the tear every tick legitimately produces", () => {
  // The false-positive half, and the reason the discriminator has to exist at
  // all: `serve` rebuilds every ~15s, so warning per bad line would print a
  // line every tick for every transcript still being appended to. No trailing
  // newline — the torn write is the final element of the split.
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN].join("\n"));
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.deepEqual(errs, []);
  // ...and everything before the tear still parsed.
  assert.equal(s.totals.cacheWrite, 1000);
});

test("a damaged mid-file line warns ONCE across ticks, not once per tick", () => {
  // Same flood argument as the sidecar's `meta` gate: a transcript that is
  // damaged is damaged on every tick, so a single call cannot see the gate.
  const dir = rawFixture(MIDFILE_TEAR);
  const errs = withStderr(() => { gatherSpend({ dir }); gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one line across two ticks, got " + JSON.stringify(errs));
});

test("two damaged transcripts in one dir each get their own warning", () => {
  // The gate is a Set keyed on the FULL PATH, and the dedup test above cannot
  // see that: it holds ONE path constant across two ticks, which a single
  // module-level boolean satisfies identically. Measured — under that boolean
  // the dedup test still fails, but only because an earlier test in this file
  // already set the flag, so it discriminates by execution order rather than by
  // anything it builds. Two paths in one tick is the shape that actually pins
  // per-path keying: a bare-filename key or a global flag silences the second.
  const dir = rawFixture(MIDFILE_TEAR);
  writeFileSync(join(dir, "agent-y.jsonl"), MIDFILE_TEAR);
  const errs = withStderr(() => { gatherSpend({ dir }); });
  assert.equal(errs.length, 2, "expected one line per damaged transcript, got " + JSON.stringify(errs));
  assert.equal(errs.filter((e) => /agent-x\.jsonl/.test(e)).length, 1, JSON.stringify(errs));
  assert.equal(errs.filter((e) => /agent-y\.jsonl/.test(e)).length, 1, JSON.stringify(errs));
});

test("a tail tear that later moves mid-file is reported on the tick it moves", () => {
  // Where the `lines` gate is CALLED is load-bearing and no test above can see
  // it: all three hold the file's SHAPE constant across ticks, so moving the
  // warnOnce call out of the position check — making a legitimate tail tear
  // consume the file's one warning — leaves the suite green while permanently
  // silencing the real fault. Tick 1 is that legitimate live tail tear (no
  // trailing newline); tick 2 is the SAME tear after the transcript grew, which
  // is the sequence `serve` produces every ~15s.
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN].join("\n"));
  assert.deepEqual(withStderr(() => gatherSpend({ dir })), [], "tick 1: a torn tail is legitimate, stay silent");
  writeFileSync(join(dir, "agent-x.jsonl"), MIDFILE_TEAR);
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line on tick 2, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.jsonl/);
  assert.equal(s.totals.cacheWrite, 1500);
});

// The `lines` and `skips` gates are keyed on the SAME transcript path, and every
// test above feeds each gate a path no other gate has seen — so the whole suite
// stays green under a single warn-once Set with no channel in its key, while a
// torn line permanently silences that file's later skip. Measured: with the
// channel dropped from the key, this is the only test in the file that fails.
//
// Both ticks are faults the operator must see, and they are DIFFERENT faults —
// tick 1 costs one turn out of a booked agent, tick 2 costs the whole agent —
// so neither line may be spent on the other. The directory-where-a-file-is-
// expected trick is the same one the panel-blackout test uses; it produces
// EISDIR out of readAgent's read regardless of who is running the suite, which
// a chmod would not.
test("a torn line and an unreadable read on the SAME transcript each get their own line", () => {
  const dir = rawFixture(MIDFILE_TEAR);
  const file = join(dir, "agent-x.jsonl");
  assert.equal(withStderr(() => gatherSpend({ dir })).length, 1, "tick 1: the mid-file tear");
  rmSync(file);
  mkdirSync(file);
  const errs = withStderr(() => gatherSpend({ dir }));
  assert.equal(errs.length, 1, "tick 2: the unreadable transcript, got " + JSON.stringify(errs));
  // #1191: the message must name the FULL PATH the key uses, not just the
  // basename — otherwise two session dirs sharing "agent-x.jsonl" produce
  // byte-identical stderr lines and the operator cannot tell which broken
  // directory is which. Escaped for RegExp since a tmpdir path is not a
  // literal we can safely embed unescaped.
  const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(errs[0], new RegExp(`skipping ${escapedFile}: `), "the skip gate's line, not the torn-line gate's, and it must name the directory the file lives under, not just the basename");
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
  const dirA = mkdtempSync(join(tmpdir(), "spend-collide-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "spend-collide-b-"));
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

// The mutant every shape above survives: `turnById.clear()` in the per-line
// catch, the plausible "reset state after a bad line" edit. Every tear above is
// on a ONE-LINE turn, where clearing a map that is about to be re-keyed anyway
// costs nothing, and a tear on the FIRST line of a multi-line turn is no better
// — `turnById` is still empty there, so it has zero discriminating power.
// Only a MIDDLE tear leaves a live entry for the clear to drop, which re-bills
// the turn on its next surviving line (measured: 2500, not 1500).
//
// Measured across the tests that exercise foldClaudeTranscript across
// board.test.mjs, member-outcomes.test.mjs, member-record.test.mjs and
// tier-check.test.mjs: the bare clear also reds member-outcomes' "a torn
// final line is skipped, not fatal", but only through `turns: turnById.size`
// — a COUNT, on a torn-LAST-line fixture, which says nothing about spend.
// Keep that count honest (a `turnCount++` at turn creation, the repair
// anyone makes when it reds) and this is the only one of those tests still
// standing.
//
// Deliberately does NOT assert `output`: a tear is not free, and the torn
// line's `tool_use` blocks and its `output_tokens` snapshot are exactly what it
// costs — only cache_creation / cache_read / maxCtx repeat on every line of a
// turn and so survive it (see the rawFixture comment above). Nor does it pin
// the warning's WORDING: a reword leaves it green, by measurement.
test("a turn spanning several lines: a tear on a MIDDLE line does not re-bill the turn", () => {
  const [a, , c] = TURN.map((l) => JSON.stringify(l));
  const dir = rawFixture([a, TORN, c, oneLineTurn("msg_c", 500)].join("\n") + "\n");
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.equal(s.totals.cacheWrite, 1500);
  assert.equal(s.totals.cacheRead, 50);
  assert.equal(s.totals.maxCtx, 1052);
  assert.equal(s.skipped, 0);
});

// #916: every case above pins the mid-file tear's STDERR line, and stderr is the
// one channel board.html twice says it does not have — the board is launched
// backgrounded and the operator is watching the page, which is the argument that
// put `skipped` in the DOM and then `metaErrors` (#602) beside it. Measured on
// the tree before this fix, MIDFILE_TEAR: gatherSpend returned
// totals,roles,top,reviewPct,tools,attributedPct,skipped,metaErrors,since,ok —
// `skipped` 0, `metaErrors` 0, `error` undefined, no field naming the damage —
// and spendView's whole decision came back BYTE-FOR-BYTE identical to the
// intact run's, 1500 cache-write rendered with the same note as 1800. `damaged`
// is this fault's channel, counted the same way and reaching the browser by the
// same route.
test("#916: a damaged mid-file line reaches the MODEL as a count, not stderr alone", () => {
  const dir = rawFixture(MIDFILE_TEAR);
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 1);
  // Distinct from both neighbouring tallies, which is why it is a third field:
  // this transcript CONTRIBUTED, so `skipped` (which means "contributed
  // nothing") may not carry it, and its sidecar is fine, so `metaErrors` may
  // not either. Folding the count into either one passes without these two.
  assert.equal(s.skipped, 0);
  assert.equal(s.metaErrors, 0);
});

test("#916: several damaged lines in one transcript count as several, not as one", () => {
  // The shape that separates a count from a flag — a boolean promoted to
  // `damaged: 1` satisfies every other case in this block. The magnitude is the
  // reason the field exists rather than a `damaged: true`: the stderr gate fires
  // once per PATH, so before this the second tear was invisible on that channel
  // too (measured: two tears in one file, one line, no number anywhere).
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN, TORN, oneLineTurn("msg_c", 500)].join("\n") + "\n");
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
    [oneLineTurn("msg_d", 100), TORN, TORN, oneLineTurn("msg_e", 200)].join("\n") + "\n");
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 3);
});

test("#916: a torn LAST line counts as no damage — the false-positive half", () => {
  // Silence on stderr was never the whole contract: the tear every tick
  // legitimately produces must not inflate the tally either, or every
  // transcript still being appended to parks a permanent "spend may be
  // incomplete" note on the panel and the note stops meaning anything.
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN].join("\n"));
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
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN, oneLineTurn("msg_c", 500), TORN].join("\n"));
  let s;
  withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(s.damaged, 1);
  assert.equal(s.totals.cacheWrite, 1500);
});

test("#916: a damaged transcript beside an unreadable one reports both tallies", () => {
  // Two different faults in one tick, and the panel names them separately. Also
  // the invariant the increment's PLACEMENT carries: `damaged` is summed beside
  // `metaErrors`, past the throw-capable work and before the agent is pushed,
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
  const dir = { error: "no session directory under ~/.claude/projects for this cwd" };
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
  const a = { error: "no transcript dir for cwd /tmp/impl-1190-a (looked in /tmp/impl-1190-a/.claude/projects/x)" };
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
  const allBad = mkdtempSync(join(tmpdir(), "spend-"));
  mkdirSync(join(allBad, "agent-trap.jsonl")); // a directory where a file is expected
  let bad;
  withStderr(() => { bad = gatherSpend({ dir: allBad }); }); // it warns; the warning is not what is under test
  assert.equal(bad.ok, false);
  assert.match(bad.error, /all 1 transcripts unreadable/);
  // The success return.
  assert.equal(gatherSpend({ dir: fixture(TURN) }).ok, true);
  // And the one return that is deliberately NOT an object: nothing yet.
  assert.equal(gatherSpend({ dir: mkdtempSync(join(tmpdir(), "spend-")) }), null);
});

test("encodeProjectDir covers every non-alphanumeric character", () => {
  assert.equal(encodeProjectDir("/Users/x/my_repo"), "-Users-x-my-repo");
  assert.equal(encodeProjectDir("/Users/x/a b"), "-Users-x-a-b");
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
// operator and a silent wrong answer: the name in VALUE_FLAGS, and the read
// hoisted into main(). Drop it from VALUE_FLAGS and sweep() calls the flag
// unknown; drop the hoisted read and the stray case below blames `x`.
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
  cwd: mkdtempSync(join(tmpdir(), "board-serve-")),
  env: { ...process.env, PATH: mkdtempSync(join(tmpdir(), "board-nobin-")) },
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
// 8123 just has to be held by SOMEONE — us, or whatever already had it —
// so the blocker is a bare net server.
test("CLI: a derived port held by anything is fatal on the degrade arm — there is no identity to scan for", async () => {
  const blocker = createServer();
  await new Promise((res) => { blocker.once("error", res); blocker.listen(8123, res); });
  const nobin = mkdtempSync(join(tmpdir(), "board-nobin-"));
  const cwd = mkdtempSync(join(tmpdir(), "board-serve-"));
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
test("CLI: a port already in use must not write board.json before the process dies", async () => {
  const blocker = createServer();
  const port = await new Promise((res) => blocker.listen(0, () => res(blocker.address().port)));
  const opts = serveOpts();
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", String(port)]), opts);
    assert.equal(r.status, 2, r.stderr);
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
  const announced = r.stderr.match(/cockpit on http:\/\/localhost:(\d+)/);
  assert.ok(announced, `no cockpit line: ${r.stderr}`);
  assert.notEqual(announced[1], "0", `announced the requested port, not the bound one: ${r.stderr}`);
  // …and the ABSENT half of #364's has() control rides this spawn rather than
  // paying for a second one byte-identical to it: no --open was passed, so
  // nothing may try to open. The --open test below carries the present half,
  // and explains why a failed tryRun("open", …) surfaces on stderr at all.
  assert.doesNotMatch(r.stderr, /open http:\/\/localhost:\d+\/ failed/, r.stderr);
});

// #1679: every other argv-read option `serve` takes has both an in-process
// override AND a CLI test driving it end to end; --spend-dir had neither
// until now — every existing --spend-dir test drove `build` (one gather per
// process, no pin) or spendDirPin() directly, never `serve`'s own tick loop.
test("CLI: serve --spend-dir reads the named directory's spend into every tick, not just build", () => {
  const opts = serveOpts();
  const dir = mkdtempSync(join(tmpdir(), "spend-named-"));
  writeFileSync(join(dir, "agent-named.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
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
// effect is tryRun("open", …) firing — PATH is stripped to an empty dir
// (serveOpts), so the attempt itself fails ENOENT and shows up on stderr
// rather than actually opening a browser. The other half of the control —
// absence still reading as absent — is asserted on the --port 0 test above,
// whose spawn is byte-identical to the one this would otherwise repeat.
test("CLI: serve --open (bare) still reads as present, not swallowed by the `=` guard", () => {
  const opened = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open"]), { ...serveOpts(), timeout: 2000 });
  assert.match(opened.stderr, /open http:\/\/localhost:\d+\/ failed/, opened.stderr);
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
// WORKSPACE — the directory holding the shared git dir, the same
// `--git-common-dir` rule ledger.mjs's defaultLedgerPath() already resolves
// the run's one ledger with — so two workspaces get two boards on two ports
// and one workspace gets the SAME port on every run, making the URL
// bookmarkable across runs, reboots and node versions.
//
// resolveCockpitInstance() takes the git-common-dir string as an ARGUMENT
// rather than reading it, which is what turns the worktree case and the
// resolution-failed case into plain rows here instead of two fixture
// repositories apiece.
//
// Why these rows and not only a live probe: every serve() spawn above runs
// with PATH stripped to an empty dir, so git is unreachable and all of them
// take the DEGRADE arm. A green CLI section above is evidence about that arm
// and no other — the resolved arm is reached in the rows below, and
// end-to-end by the two spawns at the bottom, which put a git shim back on
// PATH on purpose.
// ---------------------------------------------------------------------------

for (const [name, args, stateDir, workspace] of [
  ["an absolute --git-common-dir names the checkout holding it",
    { cwd: "/w/repo", gitCommonDir: "/w/repo/.git" }, "/w/repo/.fleet", "/w/repo"],
  // git answers RELATIVE from a checkout's top level, and the cwd it is
  // relative to is an argument here — a resolve() that reached for
  // process.cwd() instead would put the board under the test runner.
  ["a relative --git-common-dir resolves against the passed cwd, not process.cwd()",
    { cwd: "/w/repo", gitCommonDir: ".git" }, "/w/repo/.fleet", "/w/repo"],
  // Not a `.trim()` pin, despite the name's old claim: `dirname()` discards
  // the newline together with the rest of the final path segment it rides
  // on, wholesale, whether or not `.trim()` ran first — mutation-verified
  // (#1656 review: removing `.trim()` here leaves every row in this table
  // green). `.trim()`'s one load-bearing case is a value that is WHOLLY
  // whitespace, pinned by the degrade rows below instead. Kept as a
  // realistic-shape check: git really does answer `--git-common-dir` with a
  // trailing newline, and this is what that answer resolves to.
  ["a real git answer's trailing newline still resolves to the parent directory",
    { cwd: "/w/repo", gitCommonDir: "/w/repo/.git\n" }, "/w/repo/.fleet", "/w/repo"],
  // `--git-common-dir` answers with the MAIN checkout's git dir from inside a
  // linked worktree — that is the whole reason the rule is this one and not
  // `--git-dir`, which names the worktree's own admin directory. Two
  // worktrees therefore share one state directory, matching the ledger's
  // one-run-one-workspace model rather than giving every member its own board.
  ["a linked worktree resolves to the main checkout, never its own directory",
    { cwd: "/w/repo/.worktrees/t", gitCommonDir: "/w/repo/.git" }, "/w/repo/.fleet", "/w/repo"],
]) {
  test(`resolveCockpitInstance: ${name}`, () => {
    const r = resolveCockpitInstance(args);
    assert.equal(r.stateDir, stateDir);
    assert.equal(r.workspace, workspace);
  });
}

// The window is written out literally rather than imported from board.mjs:
// these two numbers ARE the contract. BASE is the port the cockpit served on
// before any of this existed, so a silent change to it breaks every bookmark
// the ticket exists to preserve, and a test that read both from the module
// under test could not notice either one moving.
const PORT_BASE = 8123, PORT_SPAN = 512;

for (const dir of ["/w/one", "/w/two", "/srv/fleet-plugin", "/Users/x/dev/repo"]) {
  test(`resolveCockpitInstance: ${dir} derives one stable port inside [${PORT_BASE}, ${PORT_BASE + PORT_SPAN})`, () => {
    const first = resolveCockpitInstance({ cwd: dir, gitCommonDir: join(dir, ".git") });
    // Same workspace, different cwd: the port follows the workspace, so a
    // member running from elsewhere in the tree must land on the same board.
    const again = resolveCockpitInstance({ cwd: "/somewhere/else", gitCommonDir: join(dir, ".git") });
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
    const { port } = resolveCockpitInstance({ cwd: dir, gitCommonDir: join(dir, ".git") });
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
  const { port } = resolveCockpitInstance({ cwd: "/fixed/workspace", gitCommonDir: join("/fixed/workspace", ".git") });
  assert.equal(port, 8337,
    "port drifted off the hand-computed FNV-1a value for this fixed key — the hash algorithm itself changed");
});

// Without the realpath, a route to the workspace through a symlink — a
// symlinked home, /var vs /private/var on this very platform — derives a
// SECOND port and a second state directory for a workspace already being
// served, which is the collision this ticket exists to prevent.
test("resolveCockpitInstance: a symlinked route to one workspace derives the canonical form's port", () => {
  const root = mkdtempSync(join(tmpdir(), "board-ws-link-"));
  try {
    const real = join(root, "repo");
    mkdirSync(join(real, ".git"), { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);
    const direct = resolveCockpitInstance({ cwd: real, gitCommonDir: join(real, ".git") });
    const viaLink = resolveCockpitInstance({ cwd: link, gitCommonDir: join(link, ".git") });
    assert.equal(viaLink.workspace, direct.workspace, "the symlinked route must canonicalise onto the same workspace key");
    assert.equal(viaLink.port, direct.port);
    assert.equal(viaLink.stateDir, direct.stateDir);
    // …and the key is the CANONICAL path, not merely the two sides agreeing
    // because neither was canonicalised at all.
    assert.equal(direct.workspace, realpathSync(real));
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const r = resolveCockpitInstance({ cwd: "/w/cwd", gitCommonDir: "/w/repo/.git", port });
    assert.equal(r.port, port);
    assert.equal(r.derived, false);
    // Forcing the port forces the port — the state directory still follows
    // the workspace.
    assert.equal(r.stateDir, "/w/repo/.fleet");
  });
}

// An unresolvable shared git dir degrades to a cwd-relative state directory
// with a null workspace and says so; a non-git or otherwise unusual checkout
// never dies for it. The wording is defaultLedgerPath()'s own — one dialect
// for one failure, so an operator who has seen the ledger's line recognises
// this one rather than learning a second phrasing of it.
for (const [name, gitCommonDir] of [
  ["git exited non-zero, so the probe handed back nothing", ""],
  ["no probe ran at all", undefined],
  ["whitespace is not a path", "  \n "],
]) {
  test(`resolveCockpitInstance: ${name} — degrades to cwd, warns, never throws`, () => {
    let r;
    const errs = withStderr(() => { r = resolveCockpitInstance({ cwd: "/w/cwd", gitCommonDir }); });
    assert.equal(r.workspace, null, "no workspace was established, so none may be claimed");
    assert.equal(r.stateDir, "/w/cwd/.fleet", "the fallback is cwd-relative — the behaviour this file had before #1582");
    assert.equal(r.port, PORT_BASE, "with no workspace to hash there is nothing to derive from, so the port is the familiar default");
    assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
    assert.match(errs[0], /WARNING could not resolve --git-common-dir/,
      "the ledger's existing fail-loud wording, not a second dialect for the same failure");
    assert.match(errs[0], /using cwd-relative/);
  });
}

// The degrade arm has its own copy of the forced/derived decision, so a
// mutation that drops it there is invisible to the rows above: a caller who
// passed --port outside a git checkout would silently get 8123 instead.
test("resolveCockpitInstance: an explicit port survives the degrade path too", () => {
  let r;
  const errs = withStderr(() => { r = resolveCockpitInstance({ cwd: "/w/cwd", gitCommonDir: "", port: 4242 }); });
  assert.equal(r.port, 4242);
  assert.equal(r.derived, false);
  assert.equal(errs.length, 1, "the state directory still degraded, so the warning still belongs");
});

// A PATH carrying git and nothing else. The resolved arm needs a real
// `git rev-parse`, while gh and node must stay unreachable so these spawns
// remain offline and fast — the same intent serveOpts()'s empty PATH has.
function gitOnlyPath() {
  const bin = mkdtempSync(join(tmpdir(), "board-gitbin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "test setup: no git on PATH to shim, so the resolved arm cannot be reached");
  symlinkSync(real.stdout.trim(), join(bin, "git"));
  return bin;
}

function gitRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

function serveProcess(cwd, bin, args = ["--port", "0", "--interval", "3600"]) {
  const p = spawn(process.execPath, serveArgs(args),
    { cwd, env: { ...process.env, PATH: bin }, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.setEncoding("utf8");
  let buf = "";
  const url = new Promise((res, rej) => {
    p.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/cockpit on (http:\/\/localhost:\d+)/);
      if (m) res(m[1]);
    });
    p.on("exit", (code) => rej(new Error(`serve exited (${code}) before announcing: ${buf}`)));
  });
  return { p, url };
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
// the tests either.
async function holderOn(dir, port = 0) {
  const server = createBoardServer(dir);
  const bound = await new Promise((res) => { server.once("error", () => res(null)); server.listen(port, () => res(server.address().port)); });
  return { server, port: bound };
}

const boardDir = (payload) => {
  const dir = mkdtempSync(join(tmpdir(), "board-holder-"));
  if (payload !== undefined) writeFileSync(join(dir, "board.json"), payload);
  return dir;
};

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
test("CLI: a second launch for the same workspace reuses the live cockpit, opens it, and exits 0", async () => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, gitCommonDir: join(repo, ".git") });
  const expected = await firstFreePort(cockpitPorts(instance));
  const first = serveProcess(repo, bin, ["--interval", "3600"]);
  try {
    const url = await withTimeout(first.url, 20000, "the first cockpit to announce");
    assert.equal(url, `http://localhost:${expected}`,
      "a launch with nothing in its way must take the port its workspace derives — that URL is the bookmarkable one");
    // The handshake reads the payload, so the first tick has to have landed.
    await untilBoardJson(url);
    assert.equal((await (await fetch(`${url}/board.json`)).json()).workspace, realpathSync(repo),
      "the board payload is what the handshake reads — a cockpit that does not name its workspace cannot be recognised");

    const second = serveSync(repo, bin, ["--interval", "3600", "--open"]);
    assert.equal(second.status, 0, `the reuse path must exit 0 — a backgrounded launch reports nothing else: ${second.stderr}`);
    assert.match(second.stderr, new RegExp(`already running for this workspace on ${url}/`), second.stderr);
    assert.doesNotMatch(second.stderr, /cockpit on http/, `a second server was started for one workspace: ${second.stderr}`);
    // --open honoured on the reuse path: PATH carries git and nothing else,
    // so the attempt fails ENOENT on stderr instead of opening a browser —
    // the same control the bare --open row above uses. It must point at the
    // EXISTING board, which is the only URL there is.
    assert.match(second.stderr, new RegExp(`open ${url}/ failed`), second.stderr);

    // #1660 review: the `if (open)` guard around the reuse-match branch's
    // tryRun("open", …) had no row exercising the FALSE case — a mutant
    // that always attempted an open on reuse, regardless of the flag,
    // passed every existing row and was only caught here.
    const third = serveSync(repo, bin, ["--interval", "3600"]);
    assert.equal(third.status, 0, `the reuse path must exit 0 regardless of --open: ${third.stderr}`);
    assert.match(third.stderr, new RegExp(`already running for this workspace on ${url}/`), third.stderr);
    assert.doesNotMatch(third.stderr, /open .* failed/,
      `an open was attempted with --open omitted: ${third.stderr}`);
  } finally { first.p.kill("SIGKILL"); for (const d of [bin, repo]) rmSync(d, { recursive: true, force: true }); }
});

// The false-match half. This holder answers, parses, and serves a real board
// payload on the exact port this workspace derives — nothing but the
// workspace field distinguishes it from the cockpit reused above. A
// handshake that asks "did anyone answer" rather than "whose board is this"
// adopts it, and this run gets no board of its own at all.
test("CLI: a holder reporting a different workspace is not adopted — the launch serves elsewhere", async () => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-foreign-");
  const { port: derived } = resolveCockpitInstance({ cwd: repo, gitCommonDir: join(repo, ".git") });
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: "/some/other/workspace" }));
  const { server } = await holderOn(dir, derived);
  const launch = serveProcess(repo, bin, ["--interval", "3600"]);
  try {
    const url = await withTimeout(launch.url, 20000, "the launch to step over the foreign holder");
    assert.notEqual(url, `http://localhost:${derived}`, "the launch adopted a board belonging to another workspace");
    const window = cockpitPorts({ port: derived, derived: true });
    assert.ok(window.includes(Number(url.split(":")[2])), `${url} is outside the bounded scan window ${window.join(", ")}`);
    // …and it is really serving its OWN board there, not merely announcing a
    // port it stepped onto.
    await untilBoardJson(url);
    assert.equal((await (await fetch(`${url}/board.json`)).json()).workspace, realpathSync(repo));
  } finally {
    launch.p.kill("SIGKILL");
    server.close(() => {});
    for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
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
test("CLI: an exhausted derived range exits non-zero and names the ports it tried", async () => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-full-");
  const instance = resolveCockpitInstance({ cwd: repo, gitCommonDir: join(repo, ".git") });
  const ports = cockpitPorts(instance);
  const dir = boardDir(undefined);
  const blockers = [];
  try {
    // A port already held by something else is held either way — what this
    // row needs is the range full, not our own socket on every port in it.
    for (const p of ports) blockers.push((await holderOn(dir, p)).server);
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
    fileURLToPath(new URL("../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `board.mjs` |"));
  assert.ok(row, "the design spec's script-surface table has no `board.mjs` row");
  for (const code of ["2", declared[1]]) {
    assert.match(row, new RegExp(`exit ${code}\\b`, "i"), `the board row does not name exit ${code}`);
  }
});
