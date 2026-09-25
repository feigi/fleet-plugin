// #1597: the cockpit half of the liveness mark — the banner board.html draws
// from a run's liveness verdict, and the wiring that carries a mark written by
// fleet-heartbeat.mjs through to the board board.mjs builds.
//
// The wiring half drives the real scripts out of process, in a throwaway
// repository.
//
// A separate file rather than more of board.test.mjs, for the reason
// ledger-read-require-file.test.mjs gives: the fleet runs several implementers
// at once and two PRs appending to one test file conflict, which costs the PR
// its CI entirely. These tests first landed at the end of that file, whose
// header scopes it to #816 — which is the same conflict, one file over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));
const HTML = readFileSync(new URL("./board.html", import.meta.url), "utf8");

// ── the liveness banner (#1597) ──────────────────────────────────────────────
//
// Same lift technique and the same reason as ledgerBanner in
// ledger-read-require-file.test.mjs: the page is one self-contained file and
// its decisions are reachable only through their source text. The
// declaration-count guard comes first for the same hoisting reason.

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
  // The gh stub fails every read and there is no ledger file at all — both
  // inputs `claimed`/`supply` derive from never actually read, so the report
  // must say `unknown`, not smuggle a false "0" past a failure that never
  // happened to land on a real empty state (#1732 follow-up: the old
  // behaviour here silently reported "0 claimed, pool supply 0" off exactly
  // this failure, indistinguishable from a genuinely empty, healthy read).
  assert.equal(model.liveness.claimed, null);
  assert.equal(model.liveness.supply, null);
  assert.match(model.liveness.text, /unknown ticket\(s\) claimed and in flight/);
  assert.match(model.liveness.text, /pool supply unknown/);
});
