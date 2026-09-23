// The shared state module — #357. Both of its callers have a CLI test file of
// their own, and almost everything this module does shows through one of them:
// the corrupt-file announcements, the per-field validation, the patch write, the
// failed-write return value.
//
// One thing does not, and it is a contract rather than an output: `rest` is the
// fields OUTSIDE the schema, never a second unvalidated copy of the fields
// inside it. Two copies of one key — one sanitized, one raw — is a trap for the
// next caller (#1597's `beat` would have arrived in `rest` had it not been
// destructured out), and it leaves
// writeState's key ORDER as the only thing standing between a junk value and
// the disk. No CLI output differs on that, so it is pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readState, writeState, assessBeat, isStalled, stallReport, BEAT_GRACE } from "./fleet-state.mjs";

const SCRIPT = fileURLToPath(new URL("./fleet-state.mjs", import.meta.url));

test("readState: `rest` is what lies outside the schema, never a second copy of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: "bogus", elapsed: 5, digest: "abc", note: "not ours" }));
  const state = readState(path, "fleet-state-test");
  rmSync(dir, { recursive: true, force: true });

  // The validated view, per field: a junk `quiet` sanitizes to 0 without taking
  // the good `elapsed` down with it.
  assert.equal(state.quiet, 0);
  assert.equal(state.elapsed, 5);
  assert.equal(state.digest, "abc");
  // And `rest` carries the foreign key alone. A raw `quiet: "bogus"` sitting in
  // here is the value writeState would spread back onto the disk — the script
  // that owns neither key re-persisting a fault the read had already repaired.
  assert.deepEqual(state.rest, { note: "not ours" });
});

test("statePath: an ambient GIT_COMMON_DIR is not canonicalised — this caller does not opt in (#1658)", () => {
  // git-env.mjs's own docstring: `canonicalise` is board.mjs's opt-in alone
  // (#1582, a symlinked cockpit route deriving a second port); ledger.mjs and
  // fleet-state.mjs stay on the default because both PRINT the path they
  // resolve, and realpath would change that output without changing which
  // file either reaches. board.test.mjs pins board.mjs's OPPOSITE choice;
  // git-env.test.mjs pins the HELPER's own default, which cannot see whether
  // THIS caller opted in — nothing before this test pinned that fact, so an
  // accidental `{ canonicalise: true }` added here would break no test.
  //
  // statePath() shells out to real `git`, which resolves a symlinked cwd
  // itself (the OS's own getcwd() never carries a symlink component), so the
  // vector has to be an ambient answer git echoes back verbatim instead:
  // GIT_COMMON_DIR, which statePath()'s scrub does not touch (only GIT_DIR
  // and GIT_WORK_TREE are). Measured directly: `GIT_COMMON_DIR=<symlinked
  // path>/.git git rev-parse --git-common-dir` from inside a repository
  // answers with that exact string, unresolved.
  const root = mkdtempSync(join(tmpdir(), "fleet-state-link-"));
  try {
    const real = join(root, "repo");
    assert.equal(spawnSync("git", ["init", "-q", real], { stdio: "ignore" }).status, 0);
    const link = join(root, "link");
    symlinkSync(real, link);
    // A plain repository to run FROM, not this suite's own (linked) worktree:
    // a GIT_COMMON_DIR override from inside a linked worktree collides with
    // that worktree's own admin files (measured: git then reports "not a git
    // repository", expecting GIT_DIR to name the worktree too).
    const cwdRepo = join(root, "cwd-repo");
    mkdirSync(cwdRepo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: cwdRepo, stdio: "ignore" }).status, 0);
    const r = spawnSync(process.execPath,
      ["-e", 'import(process.argv[1]).then((m) => { process.stdout.write(m.statePath("fleet-state-test")); });', SCRIPT],
      { cwd: cwdRepo, encoding: "utf8", env: { ...process.env, GIT_COMMON_DIR: join(link, ".git") } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, join(link, ".fleet", "heartbeat.json"),
      "statePath() must keep the symlinked spelling — canonicalising here is board.mjs's opt-in alone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------------
// The liveness mark — #1597. `beat` is fleet-heartbeat's key and fleet-tick
// and board.mjs are its readers, so the contract that matters is what a
// READER is handed for a file it did not write, and what a NON-OWNER's write
// leaves behind. Both are invisible to either CLI's own output.

test("readState: a half-written mark is no mark, never a stale one", () => {
  // The failure DIRECTION is the whole point. A mark is a time judged against
  // the interval it was promised at, so a record carrying one without the
  // other cannot be judged at all — and the two ways of pretending otherwise
  // are both worse than saying nothing. Defaulting the missing interval to 0
  // makes every mark instantly overdue, which reports a live fleet as dead;
  // defaulting the missing time to now makes a dead one look fresh forever.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-beat-"));
  const path = join(dir, "heartbeat.json");
  const read = (beat) => {
    writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", beat }));
    return readState(path, "fleet-state-test").beat;
  };
  assert.equal(read({ at: 1_700_000_000_000 }), null, "a time with no interval cannot be judged");
  assert.equal(read({ interval: 300 }), null, "an interval with no time is not a sighting");
  assert.equal(read({ at: 0, interval: 300 }), null, "the epoch is not a beat");
  assert.equal(read("1700000000000"), null, "a scalar is not a mark");
  assert.equal(read([1, 2]), null, "an array is not a mark");
  // But a junk REASON does not take the mark down with it: the reason is the
  // one field whose absence already has a meaning the readers state out loud
  // ("stopped without a recorded reason"), so degrading to it loses nothing.
  assert.deepEqual(read({ at: 1_700_000_000_000, interval: 300, stopped: 7 }),
    { at: 1_700_000_000_000, interval: 300, stopped: "" });
  rmSync(dir, { recursive: true, force: true });
});

test("readState: a junk mark does not ride back to disk through `rest`", () => {
  // The same trap the file's header names for quiet/elapsed/digest, one key
  // later. If `beat` were left in `rest`, fleet-tick's streak write would
  // spread the RAW record straight back over the sanitized one, and a mark
  // this read repaired would survive every write that repaired it.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-beat-rest-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: 1, elapsed: 0, digest: "d", beat: { at: "soon" }, note: "not ours" }));
  const state = readState(path, "fleet-state-test");
  assert.equal(state.beat, null);
  assert.deepEqual(state.rest, { note: "not ours" }, "`beat` must be destructured out, not left in `rest`");
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: a non-owner's patch carries the mark instead of erasing it", () => {
  // One writer per key is only true if the OTHER writers preserve it.
  // fleet-tick patches quiet/digest on every tick — every five minutes on a
  // busy run — so a write that dropped `beat` would delete the heartbeat's
  // mark almost immediately, and the absence is indistinguishable from a run
  // that never beat: readers would go silent on exactly the run that died.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-beat-carry-"));
  const path = join(dir, "heartbeat.json");
  const beat = { at: 1_700_000_000_000, interval: 600, stopped: "" };
  writeFileSync(path, JSON.stringify({ quiet: 2, elapsed: 5, digest: "old", beat }));
  const prev = readState(path, "fleet-state-test");
  assert.equal(writeState(path, "fleet-state-test", prev, { quiet: 0, digest: "new" }), true);
  const after = readState(path, "fleet-state-test");
  assert.deepEqual(after.beat, beat, "fleet-tick's streak write erased the heartbeat's mark");
  assert.equal(after.quiet, 0);
  assert.equal(after.digest, "new");

  // And the absent mark is OMITTED rather than written as an explicit null,
  // so a file that has never been beaten into stays the shape it was.
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "" }));
  const fresh = readState(path, "fleet-state-test");
  assert.equal(writeState(path, "fleet-state-test", fresh, { quiet: 1 }), true);
  assert.equal("beat" in JSON.parse(readFileSync(path, "utf8")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("assessBeat: staleness is judged against the RECORDED interval, not a constant", () => {
  // The whole reason the mark carries an interval. A quiet night backs off to
  // the ceiling, so the same twenty-minute silence is a healthy beat at
  // --ceiling 1200 and a dead run at --base 300. A fixed threshold has to
  // pick one and be wrong about the other, every night.
  const now = 2_000_000_000_000;
  const at = now - 20 * 60 * 1000;
  assert.equal(assessBeat({ beat: { at, interval: 1200, stopped: "" }, now }).kind, "beating",
    "a quiet run at the back-off ceiling must not be reported as dead");
  assert.equal(assessBeat({ beat: { at, interval: 300, stopped: "" }, now }).kind, "stale",
    "the same silence at the base interval IS overdue");

  // The grace is a multiplier on the promise, so the boundary moves with it.
  // Pinned on both sides of the edge rather than at one point: a check that
  // only ever asserts "far past" passes for any threshold at all.
  const edge = 300 * 1000 * BEAT_GRACE;
  assert.equal(assessBeat({ beat: { at: now - edge, interval: 300, stopped: "" }, now }).kind, "beating");
  assert.equal(assessBeat({ beat: { at: now - edge - 1, interval: 300, stopped: "" }, now }).kind, "stale");

  // No mark is not a stall: a fresh run legitimately has none, and a banner
  // that fires on every first tick is a banner nobody reads by the second.
  assert.equal(assessBeat({ beat: null, now }).kind, "none");
  assert.equal(isStalled(assessBeat({ beat: null, now })), false);
  // A mark from the future is a clock that moved, not a negative overdue.
  const ahead = assessBeat({ beat: { at: now + 60_000, interval: 300, stopped: "" }, now });
  assert.equal(ahead.ageMs, 0);
  assert.equal(ahead.overdueMs, 0);
});

test("assessBeat: a recorded stop is reported whatever its age, and outranks staleness", () => {
  // A stop that had to wait two intervals to be believed is a stop reported
  // after the only window in which anyone could act on it — and it is the one
  // verdict that knows its own cause, so it is the last one to sit on.
  const now = 2_000_000_000_000;
  const fresh = assessBeat({ beat: { at: now - 1000, interval: 300, stopped: "budget" }, now });
  assert.equal(fresh.kind, "stopped");
  assert.equal(isStalled(fresh), true);
  assert.equal(fresh.reason, "budget");
  // And an OLD stop stays `stopped`, never degrading into the reasonless
  // wording — the cause does not expire just because the silence grew.
  assert.equal(assessBeat({ beat: { at: now - 86_400_000, interval: 300, stopped: "budget" }, now }).kind, "stopped");
});

test("stallReport: names the four facts, and says `unknown` rather than guessing a zero", () => {
  const now = 2_000_000_000_000;
  const at = now - 90 * 60 * 1000;
  const stale = assessBeat({ beat: { at, interval: 1200, stopped: "" }, now });
  const line = stallReport(stale, { claimed: 7, supply: 3 });
  // When it was last seen, how overdue against the interval it PROMISED, what
  // is claimed, and whether there is still supply. A bare "stale" tells the
  // maintainer nothing they can act on, which is why each is asserted rather
  // than the line merely being non-empty.
  assert.match(line, /last beat 2033-05-18T02:03:20\.000Z/);
  assert.match(line, /90m ago/);
  assert.match(line, /70m past the 20m interval it promised/);
  assert.match(line, /7 ticket\(s\) claimed and in flight/);
  assert.match(line, /pool supply 3/);
  // No reason recorded: say exactly that, never a cause it cannot know.
  assert.match(line, /stopped without a recorded reason/);

  const stopped = assessBeat({ beat: { at, interval: 1200, stopped: "context ceiling reached" }, now });
  assert.match(stallReport(stopped, { claimed: 0, supply: 0 }),
    /stopped deliberately — recorded reason: context ceiling reached/);

  // Unknown is not zero. A failed claim query reporting "0 claimed" says the
  // dead run stranded nothing, which is the one answer that makes the whole
  // report safe to ignore — the same refusal fleet-tick's own NOT_ZERO wording
  // makes about a pool it could not read.
  const unknown = stallReport(stale, { claimed: null, supply: null });
  assert.match(unknown, /unknown ticket\(s\) claimed and in flight/);
  assert.match(unknown, /pool supply unknown/);
  assert.doesNotMatch(unknown, /\b0 ticket/);

  // And a healthy verdict has no report at all, so a caller that skipped
  // isStalled() cannot print a death for a beating run by accident.
  assert.equal(stallReport(assessBeat({ beat: { at: now, interval: 300, stopped: "" }, now }), { claimed: 1, supply: 1 }), null);
  assert.equal(stallReport(assessBeat({ beat: null, now }), { claimed: 1, supply: 1 }), null);
});
