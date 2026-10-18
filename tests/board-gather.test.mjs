// board-gather.mjs's raw-input half, in process: the `gh` row-shape guards, the
// per-PR CI read and its warn-once gate, the batched merged-PR query, mapCi(),
// and the member-spend layer under it (the phase-0 receipt's session, and
// gatherSpend()).
//
// gather() takes every argv answer as a parameter, so the drivers below call it
// in this process. The harness is the one shared rig for this file: `gh` and
// `node` resolve through PATH, which points at a stub bin for the length of one
// test (gatherHere() sets it and restores it in `t.after()`), and gather()'s
// stderr is read off this process's stream while it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, readFileSync, symlinkSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapCi, receiptSpendDir, gatherSpend, gather } from "../plugin/scripts/board-gather.mjs";
import { RECEIPT } from "../plugin/scripts/ledger-grammar.mjs";
import { computeBoard } from "../plugin/scripts/compute-board.mjs";
import { encodeProjectDir, readOmpMember } from "../plugin/scripts/member-record.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { TURN, fixture, withStderr } from "./support/board-rig.mjs";

const GATHER = fileURLToPath(new URL("../plugin/scripts/board-gather.mjs", import.meta.url));

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

// gather() takes every argv answer as a parameter, so the drivers below call it
// in this process. `gh` and `node` resolve through PATH, which points at the
// test's stub bin until the test ends, and gather()'s stderr — its own lines
// and the ones it re-emits from its children — is read off this process's
// stream while the gather runs. `spendDir: null` is the "no session yet"
// answer, so no row reads this machine's transcript tree.
async function gatherHere(t, bin, opts, ticks = 1) {
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = `${bin}:${savedPath}`;
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    rest.find((a) => typeof a === "function")?.();
    return true;
  };
  let r;
  try {
    for (let i = 0; i < ticks; i++) r = await gather({ interval: 15, spendDir: null, ...opts });
  } finally {
    process.stderr.write = write;
  }
  return { r, stderr: chunks.join("") };
}

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
// gather() degrades through tryRun().
//
// `ticks` defaults to the single gather() every arm below needs; the warn-once
// row is the one that raises it, and the one that names two PRs, because a gate
// that spends one line per process and one that spends one per tick are
// indistinguishable inside a single-tick, single-PR run.
//
// Every row names its own PR, and no two rows that assert a warn-once line share
// one: the gate's state lives as long as this process, so a PR an earlier row
// already warned about would print nothing here.
async function gatherCi(t, { ciStateBody, prevCi, prs, ticks = 1 }) {
  const cwd = tempDir("board-gather-");
  const bin = tempDir("board-gather-bin-");
  const scriptDir = tempDir("board-gather-scripts-");
  writeFileSync(join(scriptDir, "ci-state.mjs"), ciStateBody);
  const rows = JSON.stringify(prs.map((n) => ({ number: n, state: "OPEN", labels: [], title: "t" })));
  writeExecStub(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"pr list") echo '${rows}' ;;\n*) exit 1 ;;\nesac\n`);
  writeFileSync(join(cwd, "prev.json"), JSON.stringify({ tickets: prs.map((n) => ({ pr: n, ci: prevCi })) }));
  // The tick loop's shape, not a loop for its own sake: gather() called again
  // per tick in one process, which is the only place a warn-once gate is
  // observable.
  const { r, stderr } = await gatherHere(t, bin, {
    ledgerFile: join(cwd, "nope.md"), prevFile: join(cwd, "prev.json"), scriptDir,
  }, ticks);
  // stderr comes back too: gather() reports through it. mapCi's own
  // PR-in-the-warn-text wiring is no longer observable from here, though:
  // since #1593 runCiState() only ever hands mapCi an already-parseable
  // payload, so mapCi's JSON.parse catch — the only code that reads its `pr`
  // argument — can never fire through this call site. That argument's
  // presence at the real call site is pinned as source text instead (see the
  // #605 test below); what IS observable here is runCiState()'s own two
  // salvage arms, each carrying the PR and exit disposition in its own
  // stderr line.
  return { ci: r.ci[prs[0]], ciAll: r.ci, stderr };
}

// The regression itself. This payload is what ci-state.mjs emits on a quota
// refusal: it carries no `status`, so if it ever reaches mapCi the answer is
// "unknown" and the previous red is gone.
const RATE_LIMITED_EXIT_2 = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["quota"] }) + "\\n");
process.exit(2);`;

test("gather: a rate-limited ci-state — exit 2 WITH a payload — carries the previous board's CI value", async (t) => {
  assert.equal((await gatherCi(t, { ciStateBody: RATE_LIMITED_EXIT_2, prevCi: "red", prs: [42] })).ci, "red");
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

test("gather: exit 1 is a verdict, not a failed read — it still overrides the previous value", async (t) => {
  assert.equal((await gatherCi(t, { ciStateBody: NOT_GREEN_EXIT_1, prevCi: "green", prs: [42] })).ci, "red");
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

test("gather: a complete no-ci verdict at exit 1 is an answer, not a failed read — it is not carried forward (#875)", async (t) => {
  assert.equal((await gatherCi(t, { ciStateBody: NO_CI_EXIT_1, prevCi: "red", prs: [42] })).ci, "unknown");
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
test("gather: a payload cut mid-JSON at exit 1 is not a verdict — the previous CI value stands (#875)", async (t) => {
  const r = await gatherCi(t, { ciStateBody: UNPARSEABLE_EXIT_1, prevCi: "red", prs: [42] });
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

test("gather: a signal-killed ci-state that wrote half a payload carries the previous value forward (#875)", async (t) => {
  const r = await gatherCi(t, { ciStateBody: KILLED_MID_PAYLOAD, prevCi: "red", prs: [44] });
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
test("gather: a refused salvage payload warns ONCE per PR across ticks, and a second PR is not masked", async (t) => {
  const r = await gatherCi(t, { ciStateBody: UNPARSEABLE_EXIT_1, prevCi: "red", prs: [45, 46], ticks: 3 });
  assert.deepEqual(r.ciAll, { 45: "red", 46: "red" });
  const refusals = r.stderr.split("\n").filter((l) => /will not parse/.test(l));
  assert.equal(refusals.length, 2, `expected one line per PR, got ${JSON.stringify(refusals)}`);
  assert.ok(refusals.some((l) => /--pr 45/.test(l)), r.stderr);
  assert.ok(refusals.some((l) => /--pr 46/.test(l)), r.stderr);
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

test("gather: a payload cut mid-JSON at exit 0 is not a verdict either — the previous CI value stands (#1593)", async (t) => {
  const r = await gatherCi(t, { ciStateBody: UNPARSEABLE_EXIT_0, prevCi: "red", prs: [47] });
  assert.equal(r.ci, "red");
  assert.match(r.stderr, /--pr 47/);
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
test("gather: an empty payload at exit 0 says the child never answered, not that it left unparseable bytes", async (t) => {
  const r = await gatherCi(t, { ciStateBody: EMPTY_EXIT_0, prevCi: "red", prs: [48] });
  assert.equal(r.ci, "red");
  assert.match(r.stderr, /--pr 48/);
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
  const src = readFileSync(GATHER, "utf8");
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
test("gather: a PR that hits the exit-1 salvage then the exit-0 guard gets BOTH warnings, not just the first", async (t) => {
  const markerDir = tempDir("board-dualarm-");
  const marker = join(markerDir, "tick");
  const DUAL_ARM = `import { writeSync, existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const first = !existsSync(marker);
if (first) writeFileSync(marker, "1");
writeSync(1, "warning: gh took the slow path\\n{\\"pr\\": 42, \\"status\\": \\"comp");
process.exit(first ? 1 : 0);`;
  const r = await gatherCi(t, { ciStateBody: DUAL_ARM, prevCi: "red", prs: [49], ticks: 2 });
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
// tests pin.
async function gatherRows(t, { issuesJson, prsJson }) {
  const cwd = tempDir("board-gather-rows-");
  const bin = tempDir("board-gather-rows-bin-");
  const scriptDir = tempDir("board-gather-rows-scripts-");
  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeExecStub(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"issue list") echo '${issuesJson}' ;;\n"pr list") echo '${prsJson}' ;;\n*) exit 1 ;;\nesac\n`);
  const { r, stderr } = await gatherHere(t, bin, { ledgerFile: join(cwd, "nope.md"), prevFile: null, scriptDir });
  return { ...JSON.parse(JSON.stringify({ issues: r.issues, prs: r.prs })), stderr };
}

// tryParse only checks that gh's stdout is valid JSON, not that it is an
// array — a syntactically-valid object payload used to reach withNumber's
// `for...of` and throw "rows is not iterable", contrary to this PR's own
// premise that tryParse "establishes... that it is an array" (#786 review).
test("gather: a non-array gh payload degrades to an empty list, not a crash", async (t) => {
  const r = await gatherRows(t, { issuesJson: JSON.stringify({ not: "an array" }), prsJson: "[]" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: expected an array of rows/);
});

test("gather: a well-formed issue/PR row passes through unchanged", async (t) => {
  const r = await gatherRows(t, {
    issuesJson: JSON.stringify([{ number: 9, title: "real title", labels: [] }]),
    prsJson: JSON.stringify([{ number: 10, state: "OPEN", title: "real pr title", labels: [] }]),
  });
  assert.deepEqual(r.issues, [{ number: 9, title: "real title", labels: [] }]);
  assert.deepEqual(r.prs, [{ number: 10, state: "OPEN", title: "real pr title", labels: [] }]);
});

test("gather: an issue row with no number is dropped, loudly, not placed as undefined", async (t) => {
  const r = await gatherRows(t, { issuesJson: JSON.stringify([{ title: "orphan" }]), prsJson: "[]" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: dropping row with no usable number/);
});

test("gather: an issue row missing its title reads as its number, not undefined", async (t) => {
  const r = await gatherRows(t, { issuesJson: JSON.stringify([{ number: 55 }]), prsJson: "[]" });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].number, 55);
  assert.equal(r.issues[0].title, "#55");
});

test("gather: a PR row with no number is dropped, loudly, not placed as undefined", async (t) => {
  const r = await gatherRows(t, { issuesJson: "[]", prsJson: JSON.stringify([{ title: "orphan pr", state: "OPEN" }]) });
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
async function gatherCapped(t, { issues, prs }) {
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
  const { r: inputs } = await gatherHere(t, bin, { ledgerFile: join(cwd, "ledger.md"), prevFile: null, scriptDir });
  const b = computeBoard(inputs);
  return JSON.parse(JSON.stringify({ prs: inputs.prs.length, poolCards: b.tickets.filter((t) => t.column === "POOL").length,
    queue: b.queue, capNotice: b.capNotice }));
}

test("#2108: a pool read that fills its --limit renders as a floor and says so, never as an exact count", async (t) => {
  const b = await gatherCapped(t, { issues: 150, prs: 0 });
  assert.equal(b.poolCards, 100, "gather() no longer asks for 100 ready-for-agent tickets");
  assert.equal(b.queue.pool, "100+", "a full page of the pool read was rendered as the exact pool size");
  assert.equal(b.queue.supply, "100+");
  assert.match(b.capNotice ?? "", /ready-for-agent read hit its --limit/);
  assert.doesNotMatch(b.capNotice, /open-PR/, "a pool cap was reported as an open-PR cap too");
});

test("#2108: an open-PR read that fills its --limit is disclosed on the board", async (t) => {
  const b = await gatherCapped(t, { issues: 0, prs: 150 });
  assert.equal(b.prs, 100, "gather() no longer asks for 100 open PRs");
  assert.match(b.capNotice ?? "", /open-PR read hit its --limit/);
  assert.doesNotMatch(b.capNotice, /ready-for-agent/, "an open-PR cap was reported as a pool cap too");
  assert.equal(b.queue.pool, 0, "an open-PR cap turned the pool count into a floor");
});

test("#2108: reads one short of their limit, and past gh's bare default of 30, are exact and silent", async (t) => {
  // The input the guard must ACCEPT: 99 is a complete answer, not a capped
  // one, and 35 is more than gh returns when `--limit` goes missing.
  const b = await gatherCapped(t, { issues: 99, prs: 35 });
  assert.equal(b.queue.pool, 99);
  assert.equal(b.prs, 35, "the open-PR read fell back to gh's default of 30");
  assert.equal(b.capNotice, null, "a read under its limit raised the capped-read notice");
});

test("#2108: a pool read AND an open-PR read that both fill their --limit are both disclosed", async (t) => {
  const b = await gatherCapped(t, { issues: 150, prs: 150 });
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
async function gatherMerged(t, { rows, prs = [], prev = null, states = {}, fail = false, emptyRepo = false }) {
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
  const { r: inputs, stderr } = await gatherHere(t, bin, { ledgerFile: join(cwd, "ledger.md"), prevFile, scriptDir });
  const b = computeBoard(inputs);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // Any read that could answer "merged": the scoped query, or a fallback to
  // the old window. Both count, so a regression to the window cannot hide.
  const mergedReads = calls.filter((c) => c[0] === "api" || c.includes("merged"));
  const asked = (c) => [...c[c.indexOf("-f") + 1].matchAll(/pullRequest\s*\(\s*number\s*:\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
  return { ...JSON.parse(JSON.stringify({ merged: inputs.merged, columns: Object.fromEntries(b.tickets.map((t) => [t.pr, t.column])) })), mergedReads, asked, stderr };
}

test("#1840: a row PR merged outside the most-recent-100 window renders MERGED with no previous board", async (t) => {
  const r = await gatherMerged(t, { rows: ["#907 impl-907=PR#930"], states: { 930: "MERGED" } });
  assert.equal(r.columns[930], "MERGED", r.stderr);
  assert.deepEqual(r.merged, [930]);
  assert.equal(r.mergedReads.length, 1);
  assert.deepEqual(r.asked(r.mergedReads[0]), [930]);
});

test("#1840: a tick whose row PRs are all open, token-MERGED or carried forward makes no merged read", async (t) => {
  const r = await gatherMerged(t, {
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

test("#1840: the merged lookup is ONE gh invocation asking about exactly the row PRs that need it", async (t) => {
  const r = await gatherMerged(t, {
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

test("#1840: a failed merged lookup keeps #1841's rule — carried forward stays MERGED, the rest reads REVIEW", async (t) => {
  const r = await gatherMerged(t, {
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
test("#1840: one unresolvable number does not poison the batch — the PRs gh did answer still count", async (t) => {
  const r = await gatherMerged(t, {
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
test("#1840: an object data.repository naming none of the requested PRs is a failed read, not a clean zero-merged answer", async (t) => {
  const r = await gatherMerged(t, {
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
test("gather: a PR row missing state/title passes through raw, not coerced to a sentinel", async (t) => {
  const r = await gatherRows(t, { issuesJson: "[]", prsJson: JSON.stringify([{ number: 77 }]) });
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
test("gather: a non-array labels field degrades to [], not a TypeError crash", async (t) => {
  const r = await gatherRows(t, {
    issuesJson: JSON.stringify([{ number: 1, title: "t", labels: "not-an-array" }]),
    prsJson: JSON.stringify([{ number: 2, title: "t", state: "OPEN", labels: "not-an-array" }]),
  });
  assert.deepEqual(r.issues[0].labels, []);
  assert.deepEqual(r.prs[0].labels, []);
});

// The second reproduced crash: a `labels` array whose elements are the right
// TYPE (an array) but a WRONG-shaped or null element throws reading `.name`.
test("gather: a malformed element inside labels is dropped, not the whole row", async (t) => {
  const r = await gatherRows(t, {
    issuesJson: JSON.stringify([{ number: 1, title: "t", labels: [{ name: "keep" }, null, {}] }]),
    prsJson: "[]",
  });
  assert.deepEqual(r.issues[0].labels, ["keep"]);
});

// ── the spend transcript layer ────────────────────────────────────────────────
// Both bugs this file now pins were invisible to the pure-module tests, because
// both live in the I/O that feeds them: a wrong path and a wrong summation. Each
// failed silently as "panel hidden" or "plausible but 3x too big".

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
// the whole tree — a gather that reads it cannot pass.
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
// default panel simply hid — a destroyed session rendered as one that had
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
  // same null from ompMemberRecord, reached without --spend-dir, which used to
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
  // own — so naming the project dir (the parent `-dev-repo` directory, the
  // encoded-cwd directory every session lives under) instead of one
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

// ── #3127: the phase-0 receipt names the session ──────────────────────────────
//
// One project directory can hold several sessions at once, so the panel reads
// the session the run's phase-0 receipt records, never the newest one in the
// tree. Each test here builds a project dir where a sibling session holds the
// NEWER transcripts, so a newest-mtime pick would read the wrong one.
const writeRunReceipt = (stateDir, session) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RECEIPT), JSON.stringify({ run: null, session, scratch: "/scratch", inFlight: 5, steps: {} }));
};

const BILLED = [{ input: 1, output: 1, cacheRead: 1, cacheWrite: 10 }];
function twoSessions() {
  const { proj } = ompHome();
  const mine = ompSession(proj, OMP_A, { "impl-mine": ompTranscript({ turns: BILLED }) }, 1000);
  const theirs = ompSession(proj, OMP_B, { "impl-theirs": ompTranscript({ turns: BILLED }) }, Date.now() + 60_000);
  return { proj, mine, theirs, stateDir: join(tempDir("spend-state-"), ".fleet") };
}

test("the receipt's session is read, even when a sibling session in the same project dir holds newer transcripts", () => {
  const { mine, stateDir } = twoSessions();
  writeRunReceipt(stateDir, mine);
  assert.equal(receiptSpendDir(stateDir), mine);
  const s = gatherSpend({ dir: receiptSpendDir(stateDir) });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(s.top.map((t) => t.label), ["impl-mine"]);
});

test("a receipt rewritten between two reads is followed on the second — nothing is held", () => {
  const { mine, theirs, stateDir } = twoSessions();
  writeRunReceipt(stateDir, theirs);
  assert.deepEqual(gatherSpend({ dir: receiptSpendDir(stateDir) }).top.map((t) => t.label), ["impl-theirs"]);
  writeRunReceipt(stateDir, mine);
  assert.deepEqual(gatherSpend({ dir: receiptSpendDir(stateDir) }).top.map((t) => t.label), ["impl-mine"]);
});

test("a recorded session whose directory does not exist yet, or holds no transcripts, is the quiet null", () => {
  const { proj, stateDir } = twoSessions();
  const notYet = join(proj, "2026-10-01T00-00-00-000Z_cccccccc-cccc-cccc-cccc-cccccccccccc");
  writeRunReceipt(stateDir, notYet);
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir: receiptSpendDir(stateDir) }); });
  assert.equal(s, null, JSON.stringify(s));
  assert.deepEqual(errs, [], "no `spend read failed` line for a session not created yet");

  mkdirSync(notYet);
  const errs2 = withStderr(() => { s = gatherSpend({ dir: receiptSpendDir(stateDir) }); });
  assert.equal(s, null, JSON.stringify(s));
  assert.deepEqual(errs2, [], "no `holds no agent transcripts` line for a session with no member yet");
});

test("no receipt, or one recording no session, is a panel saying so — never a guessed session", () => {
  const { stateDir } = twoSessions();
  const none = "no session recorded — run phase 0 or pass --spend-dir";
  assert.deepEqual(receiptSpendDir(stateDir), { error: none });
  writeRunReceipt(stateDir, "");
  assert.deepEqual(receiptSpendDir(stateDir), { error: none });
  let s;
  withStderr(() => { s = gatherSpend({ dir: receiptSpendDir(stateDir) }); });
  assert.deepEqual(s, { ok: false, error: none });
});

test("an unreadable receipt is a panel naming the receipt, one stderr line across ticks, never zeroed", () => {
  const { stateDir } = twoSessions();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RECEIPT), "{not json");
  let first, second;
  const errs = withStderr(() => {
    first = gatherSpend({ dir: receiptSpendDir(stateDir) });
    second = gatherSpend({ dir: receiptSpendDir(stateDir) });
  });
  assert.equal(errs.length, 1, "expected one line across two ticks, got " + JSON.stringify(errs));
  for (const s of [first, second]) {
    assert.equal(s.ok, false, "the tag the page routes on");
    assert.match(s.error, /^no session recorded — run phase 0 or pass --spend-dir \(phase-0 receipt .*phase0\.json unreadable: not JSON/);
    assert.equal(s.totals, undefined, "an unreadable receipt must not report spend at all");
  }
});

test("one unreadable transcript does not take the whole panel down", () => {
  const dir = fixture(TURN);
  mkdirSync(join(dir, "agent-trap.jsonl")); // a directory where a file is expected
  const s = gatherSpend({ dir });
  assert.equal(s.totals.cacheWrite, 1000); // the good agent still counted
  assert.equal(s.skipped, 1);
});

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
// the shape a long-lived `serve` process hits in practice: the receipt it
// reads names a new session directory as fleet runs start and finish, and
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

test("an unreadable --spend-dir reports an error rather than posing as an empty run", () => {
  // The distinction that hid the path bug: a hidden panel meant both "nothing
  // yet" and "this is broken", so the broken case never surfaced. Explicit
  // only: a receipt's session not created yet is the quiet null (above).
  const absent = join(tempDir("spend-absent-"), "2026-08-26T09-00-00-000Z_01a08126-ee04-7095-a695-14e3249f1128");
  let s;
  withStderr(() => { s = gatherSpend({ dir: absent, explicit: true }); }); // it warns; the warning is not what is under test
  assert.ok(s.error, "expected an error object, got " + JSON.stringify(s));
  // The TAG, not the message: the page routes on `ok` alone (#959), so a
  // producer that stops emitting it hides the panel no matter what `error` says.
  assert.equal(s.ok, false);
});

test("every gatherSpend return carries the tag the page routes on (#959)", () => {
  // One test over all four returns, because the defect was a MISSING tag on one
  // of them, and a per-return test is what leaves the next one untagged.
  // The unresolvable-dir return.
  assert.equal(gatherSpend({ dir: { error: "no session recorded for this test" } }).ok, false);
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
