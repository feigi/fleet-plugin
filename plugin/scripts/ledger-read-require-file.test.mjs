// The cockpit half of #816.
//
// `ledger.mjs read` answered an absent ledger and a real empty one identically
// — same stdout, same empty stderr, same exit 0 — and `read` is the subcommand
// board.mjs consumes. tryParse's fallback on a failed read is that same empty
// shape besides, so three distinct states (no ledger, an empty ledger, a read
// whose answer would not parse) reached the page as one empty board.
//
// ledger.test.mjs pins the CLI's half: the flag is honoured, and a real empty
// ledger is still accepted. This file pins the wiring and the rendering — that
// board.mjs actually passes the flag, that it keeps the three answers apart,
// and that the page draws two of them differently from the third.
//
// A separate file rather than more of board.test.mjs: the fleet runs several
// implementers at once and two PRs appending to one test file conflict, which
// costs the PR its CI entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));
const REAL_SCRIPTS = fileURLToPath(new URL("./", import.meta.url));
const HTML = readFileSync(new URL("./board.html", import.meta.url), "utf8");

const EMPTY_LEDGER = "# Fleet run ledger\n\n## Rows\n\n\n## Filed\n\n\n## Ruled\n\n";

// gather() is driven out of process because it reads process.argv and would
// otherwise read the test runner's. `gh` is stubbed to fail for every read:
// those all degrade through tryRun to empty lists, they are not what this
// measures, and an unstubbed `gh` would put this repo's live issue list and the
// machine's network in the assertion path.
//
// `scriptDir` defaults to the REAL scripts directory, so the end-to-end arms
// spawn the real ledger.mjs. A stub there is free to honour a flag the real
// script ignores — which is the whole defect — so the two arms that decide
// whether the fix works must not use one.
function gatherLedger({ ledgerBody = null, scriptDir = REAL_SCRIPTS } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "board-ledger-"));
  const bin = mkdtempSync(join(tmpdir(), "board-ledger-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const ledgerFile = join(cwd, "ledger.md");
  if (ledgerBody !== null) writeFileSync(ledgerFile, ledgerBody);

  const driver = `const { gather } = await import(${JSON.stringify(BOARD)});
    const r = gather({ ledgerFile: ${JSON.stringify(ledgerFile)},
                       scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify(r.ledger));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, `the driver itself must not fail\n${r.stdout}${r.stderr}`);
  return { ledger: JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
}

// A stub ledger.mjs whose body is supplied per test, plus an argv sentinel so a
// test can assert what board.mjs actually spawned rather than inferring it.
function stubScripts(body) {
  const dir = mkdtempSync(join(tmpdir(), "board-ledger-stub-"));
  const argvFile = join(dir, "argv.txt");
  writeFileSync(join(dir, "ledger.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join("\\n"));\n${body}`);
  return { scriptDir: dir, argvFile };
}

// ── the wiring ───────────────────────────────────────────────────────────────

// Without this the fix is one token from being disconnected while every state
// test below still passes: the stub's exit code decides the answer, so a
// gather() that dropped the flag would keep giving the right answer TO THE STUB
// and the wrong one to the real ledger.mjs, which is where it matters.
test("gather spawns `read` WITH --require-file (#816)", () => {
  const { scriptDir, argvFile } = stubScripts(`console.log(JSON.stringify({ rows: [], filed: [], ruled: [] }));`);
  gatherLedger({ scriptDir });
  assert.equal(existsSync(argvFile), true, "the stub ledger was never spawned — this test measured nothing");
  const argv = readFileSync(argvFile, "utf8").split("\n");
  assert.ok(argv.includes("--require-file"), `board.mjs must pass the flag; got ${JSON.stringify(argv)}`);
  assert.ok(argv.includes("read"), `board.mjs must still ask for read; got ${JSON.stringify(argv)}`);
});

// ── the three states, end to end against the real ledger.mjs ─────────────────

test("gather: no ledger file at all is `unread`, not an empty ledger (#816)", () => {
  const { ledger } = gatherLedger({ ledgerBody: null });
  assert.equal(ledger.state, "unread");
  // The lists stay the shape computeBoard reads, so nothing downstream crashes
  // on a state it cannot render — the state is additive, not a replacement.
  assert.deepEqual({ rows: ledger.rows, filed: ledger.filed, ruled: ledger.ruled }, { rows: [], filed: [], ruled: [] });
});

// The discriminating half. These two produced identical `ledger` objects before
// the fix, which is the defect stated as an assertion: without this arm a
// gather() that reported "unread" for every ledger would pass the one above.
test("gather: a real EMPTY ledger is `read`, and still carries its empty lists (#816)", () => {
  const { ledger } = gatherLedger({ ledgerBody: EMPTY_LEDGER });
  assert.equal(ledger.state, "read");
  assert.deepEqual({ rows: ledger.rows, filed: ledger.filed, ruled: ledger.ruled }, { rows: [], filed: [], ruled: [] });
});

test("gather: a ledger with rows is `read` and its rows arrive (#816)", () => {
  const { ledger } = gatherLedger({ ledgerBody: EMPTY_LEDGER.replace("## Rows\n", "## Rows\n\n- #7 impl-7 · class=routine") });
  assert.equal(ledger.state, "read");
  assert.deepEqual(ledger.rows, ["#7 impl-7 · class=routine"]);
});

// The third state, which no real ledger.mjs can produce on demand — a stub is
// the only way to hand board.mjs stdout that arrives at exit 0 and will not
// parse. That is board.mjs's own branch under test, not ledger.mjs's flag.
test("gather: stdout that will not parse is `unparsed`, not `unread` and not an empty ledger (#816)", () => {
  const { scriptDir } = stubScripts(`console.log("warning: something\\n{\\"rows\\": [");`);
  const { ledger, stderr } = gatherLedger({ scriptDir });
  assert.equal(ledger.state, "unparsed");
  assert.deepEqual({ rows: ledger.rows, filed: ledger.filed, ruled: ledger.ruled }, { rows: [], filed: [], ruled: [] });
  assert.match(stderr, /ledger read parse failed/, "a failed parse must still say so on stderr");
});

// A refusal and an unreachable node arrive the same way — no usable stdout —
// and both mean the same thing to the page: this board was not built from a
// ledger. The distinction that matters is against `read`, not between them.
test("gather: a non-zero exit from ledger.mjs is `unread` (#816)", () => {
  const { scriptDir } = stubScripts(`process.exit(2);`);
  assert.equal(gatherLedger({ scriptDir }).ledger.state, "unread");
});

// ── the rendering ────────────────────────────────────────────────────────────
//
// board.html is served as one self-contained file with an inline script, so the
// decision is lifted out of its source text and evaluated, the same technique
// spend-view.test.mjs uses. The declaration-count guard comes first: a second
// top-level declaration wins at runtime by hoisting and the lift below would
// still read the first one.

test("board.html declares ledgerBanner exactly once at top level", () => {
  assert.equal(HTML.match(/^function\s+ledgerBanner\s*\(/gm)?.length, 1,
    "ledgerBanner must be declared exactly once — a second declaration wins at runtime and the lift below would still read the first");
});

const BANNER_SRC = HTML.match(/^function\s+ledgerBanner\s*\(\w+\)\s*\{[\s\S]*?^\}$/m);

test("board.html still declares ledgerBanner in the shape this file lifts", () => {
  // Named and outside the lift: an assertion thrown during the lift itself runs
  // before node registers any test in this file, which reports one opaque
  // file-level error instead of naming the claim that stopped holding.
  assert.ok(BANNER_SRC, "board.html no longer declares ledgerBanner as a top-level function — update this test");
});

const ledgerBanner = BANNER_SRC
  ? new Function(`${BANNER_SRC[0]}\nreturn ledgerBanner;`)()
  : () => { throw new Error("ledgerBanner could not be lifted from board.html — see the shape test above"); };

test("ledgerBanner draws the two failure states differently from each other (#816)", () => {
  const unread = ledgerBanner("unread");
  const unparsed = ledgerBanner("unparsed");
  assert.ok(unread, "an unread ledger must say so");
  assert.ok(unparsed, "an unparseable ledger must say so");
  // Two banners with the same words are one rendering wearing two names, which
  // is the defect this ticket is about.
  assert.notEqual(unread, unparsed, "the two failures must not render as the same message");
});

test("ledgerBanner stays silent for a ledger that was read (#816)", () => {
  // The accept side. A run that has just started has an empty ledger and no
  // rows, and a warning on every first tick trains the operator to ignore this
  // strip — which would cost the two messages above their whole point.
  assert.equal(ledgerBanner("read"), null, "a ledger read empty is the ordinary state, not a warning");
  assert.equal(ledgerBanner(undefined), null, "a board.json written before this field existed must not warn either");
});

// The call site. Without this the whole decision can be disconnected in one
// token and every case above still passes against a function the page never
// calls — and the ordering claim is the other half: a stale board is stale
// whatever its ledger state, so the ledger message must not preempt it.
test("board.html routes the freshness banner through ledgerBanner, with stale still first (#816)", () => {
  const render = HTML.match(/^function\s+render\s*\((\w+)\)\s*\{[\s\S]*?^\}$/m);
  assert.ok(render, "board.html no longer declares render as a top-level function — update this test");
  const body = render[0].split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(body, /=\s*ledgerBanner\(\w+\.ledgerState\)/, "render must call ledgerBanner with the model's ledgerState");
  // #1597 put a third arm between the two this pin was written for, and a
  // non-greedy `else if` after "data stale" would happily match THAT one and
  // go on reading like it still proved the ledger's position. So the order is
  // asserted by INDEX over the whole chain rather than by one adjacency: a
  // stale board is stale whatever else is true, a dead run outranks a
  // degraded read of one input, and neither may hide the other.
  const stale = body.indexOf("data stale");
  const stall = body.search(/else if \(stallMsg\)/);
  const ledger = body.search(/else if \(ledgerMsg\)/);
  assert.ok(stale !== -1 && stall !== -1 && ledger !== -1,
    "board.html no longer renders all three banner arms — update this test");
  assert.ok(stale < stall, "a stale board must outrank the liveness stall it can no longer vouch for");
  assert.ok(stall < ledger, "a stopped run must outrank a degraded read of one of its inputs");
});

// ── the liveness banner (#1597) ──────────────────────────────────────────────
//
// Same lift technique and the same reason as ledgerBanner above: the page is
// one self-contained file and its decisions are reachable only through their
// source text. The declaration-count guard comes first for the same hoisting
// reason too.

test("board.html declares livenessBanner exactly once at top level", () => {
  assert.equal(HTML.match(/^function\s+livenessBanner\s*\(/gm)?.length, 1,
    "livenessBanner must be declared exactly once — a second declaration wins at runtime and the lift below would still read the first");
});

const LIVENESS_SRC = HTML.match(/^function\s+livenessBanner\s*\(\w+\)\s*\{[\s\S]*?^\}$/m);

test("board.html still declares livenessBanner in the shape this file lifts", () => {
  assert.ok(LIVENESS_SRC, "board.html no longer declares livenessBanner as a top-level function — update this test");
});

const livenessBanner = LIVENESS_SRC
  ? new Function(`${LIVENESS_SRC[0]}\nreturn livenessBanner;`)()
  : () => { throw new Error("livenessBanner could not be lifted from board.html — see the shape test above"); };

test("livenessBanner renders the verdict's own words and composes none of its own", () => {
  // The page must not phrase this. compute-board.mjs builds `text` through
  // fleet-state.mjs's stallReport(), the same function fleet-tick prints, so
  // a rewrite of one surface cannot leave the other describing the same dead
  // run differently. A banner that reworded here would be a second answer.
  const text = "heartbeat STALLED: last beat 2026-01-01T00:00:00.000Z (90m ago, 70m past the 20m interval it promised)"
    + " — the beat stopped without a recorded reason; 3 ticket(s) claimed and in flight, pool supply 4";
  assert.equal(livenessBanner({ kind: "stale", text }), "⚠ " + text);
});

test("livenessBanner stays silent for a run with nothing to report", () => {
  // Null is the healthy verdict AND the run that never beat — computeBoard
  // collapses both, because a banner that fires on a beating fleet is a
  // banner the operator learns to read past, which costs it the one night it
  // exists for.
  assert.equal(livenessBanner(null), null);
  assert.equal(livenessBanner(undefined), null,
    "a board.json written before this field existed must render, not warn");
  // And a payload carrying the key with no words is not a banner either: an
  // empty amber strip claims a verdict the board does not hold.
  assert.equal(livenessBanner({ kind: "stale" }), null);
  assert.equal(livenessBanner({ kind: "stale", text: "" }), null);
});

// ── the mark's wiring, end to end (#1597) ────────────────────────────────────
//
// Everything above tests the cockpit's halves in isolation, and the one
// failure none of them can see is the one that matters most here: the
// heartbeat and the board agreeing on WHICH FILE. A cockpit reading a path
// nothing writes renders a permanently empty liveness surface, and every
// other test in this repo stays green while it does — the panel is supposed
// to be empty on a healthy run, so "no banner" is indistinguishable from
// "wired to nowhere".
//
// So this drives the real fleet-heartbeat.mjs and the real board.mjs through
// their own default path resolution, in a throwaway repository, and asserts
// the mark one wrote reaches the board the other built.
test("a mark written by the real heartbeat reaches the real board (#1597)", () => {
  const repo = mkdtempSync(join(tmpdir(), "board-liveness-e2e-"));
  assert.equal(spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }).status, 0);
  const bin = mkdtempSync(join(tmpdir(), "board-liveness-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  // `--stop` rather than a beat: a deliberate stop is reported at once, where
  // a live beat would have to be backdated by hand — and backdating means
  // writing the file this test is trying to prove nobody has to write by hand.
  // No --state either, on purpose: the default resolution IS the subject.
  const heartbeat = fileURLToPath(new URL("./fleet-heartbeat.mjs", import.meta.url));
  const stop = spawnSync(process.execPath, [heartbeat, "--stop", "budget exhausted"],
    { cwd: repo, encoding: "utf8", env });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(existsSync(join(repo, ".fleet", "heartbeat.json")), true,
    "the heartbeat did not write where this test expected — the premise is gone, not the wiring");

  const build = spawnSync(process.execPath, [BOARD, "build"], { cwd: repo, encoding: "utf8", env });
  assert.equal(build.status, 0, build.stderr);
  const model = JSON.parse(build.stdout);
  assert.ok(model.liveness, "the board found no mark — the two scripts disagree about the state file's path");
  assert.equal(model.liveness.kind, "stopped");
  assert.match(model.liveness.text, /recorded reason: budget exhausted/);
  // The gh stub fails every read, so there are no tickets and no pool — and
  // the report says so honestly rather than omitting the counts it could not
  // find anything for.
  assert.equal(model.liveness.claimed, 0);
  assert.match(model.liveness.text, /pool supply 0/);
});
