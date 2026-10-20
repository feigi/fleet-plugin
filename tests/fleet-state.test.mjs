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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readState, writeState, assessBeat, isStalled, isReported, stallOwner, stallReport, stallsAt, BEAT_GRACE, DEFAULT_CEILING_S } from "../plugin/scripts/fleet-state.mjs";
import { ProcUnreadable } from "../plugin/scripts/proc.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/fleet-state.mjs", import.meta.url));

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

// A degraded file of each kind readState announces: not JSON, not an object, a
// controller record that cannot be judged, and a path that exists but cannot be
// read as a file.
function degradedFiles(dir) {
  const files = {
    "not JSON": "{nope",
    "not an object": "[]",
    "an unjudgeable controller": JSON.stringify({ controller: { pid: "x" } }),
  };
  const out = {};
  for (const [label, body] of Object.entries(files)) {
    out[label] = join(dir, `${label.replace(/\W+/g, "-")}.json`);
    writeFileSync(out[label], body);
  }
  out["unreadable"] = join(dir, "a-directory");
  mkdirSync(out["unreadable"]);
  return out;
}

test("readState: with no sink, every degraded read still warns on console.error", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-warn-"));
  const err = console.error;
  const lines = [];
  console.error = (m) => lines.push(m);
  try {
    for (const [label, path] of Object.entries(degradedFiles(dir))) {
      lines.length = 0;
      const state = readState(path, "sink-test");
      assert.ok(state.degraded, label);
      assert.equal(lines.length, 1, label);
      assert.match(lines[0], /^sink-test: WARNING /, label);
    }
  } finally {
    console.error = err;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readState: a supplied sink receives the warning and console.error does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-sink-"));
  const err = console.error;
  const stderrLines = [];
  console.error = (m) => stderrLines.push(m);
  try {
    for (const [label, path] of Object.entries(degradedFiles(dir))) {
      const sunk = [];
      const state = readState(path, "sink-test", (m) => sunk.push(m));
      assert.ok(state.degraded, label);
      assert.equal(sunk.length, 1, label);
      assert.match(sunk[0], /^sink-test: WARNING /, label);
    }
    const sunk = [];
    readState(join(dir, "absent.json"), "sink-test", (m) => sunk.push(m));
    assert.deepEqual(sunk, [], "an absent file is no fault and reaches no sink");
    assert.deepEqual(stderrLines, []);
  } finally {
    console.error = err;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statePath: an ambient GIT_COMMON_DIR is not canonicalised — this caller does not opt in (#1658)", () => {
  // git-env.mjs's own docstring: `canonicalise` is board-server.mjs's opt-in alone
  // (#1582, a symlinked cockpit route deriving a second port); ledger.mjs and
  // fleet-state.mjs stay on the default because both PRINT the path they
  // resolve, and realpath would change that output without changing which
  // file either reaches. board-server.test.mjs pins board-server.mjs's OPPOSITE choice;
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
      "statePath() must keep the symlinked spelling — canonicalising here is board-server.mjs's opt-in alone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("statePath: outside any repository it warns with git's reason and falls back to the cwd-relative heartbeat file", () => {
  // A ceiling at the fixture's parent, so a temp directory that happens to sit
  // inside some repository cannot answer for it.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "fleet-state-norepo-")));
  try {
    const cwd = join(parent, "bare");
    mkdirSync(cwd);
    const r = spawnSync(process.execPath,
      ["-e", 'import(process.argv[1]).then((m) => { process.stdout.write(m.statePath("fleet-state-test")); });', SCRIPT],
      { cwd, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: parent } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, join(".fleet", "heartbeat.json"), "the fallback is the cwd-relative file the beat used before it was resolved");
    assert.match(r.stderr, /fleet-state-test: WARNING could not resolve --git-common-dir: \S/, "the warning names the cause, not only the failure");
    assert.match(r.stderr, /using cwd-relative \.fleet\/heartbeat\.json/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------------
// The liveness mark — #1597. `beat` is fleet-heartbeat's key and fleet-tick
// and board-gather.mjs are its readers, so the contract that matters is what a
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

test("readState: a file it cannot use is flagged with its cause, a `controller` key it cannot judge among them, and a usable file carries no flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-degraded-"));
  const path = join(dir, "heartbeat.json");
  const flag = (text) => {
    writeFileSync(path, text);
    return readState(path, "fleet-state-test").degraded;
  };
  assert.equal(readState(join(dir, "absent.json"), "fleet-state-test").degraded, undefined, "an absent file is a fresh run");
  assert.equal(flag("{ \"controller\": {"), "is not JSON");
  assert.equal(flag("[1,2,3]"), "is not a JSON object");
  // A parseable file is degraded for a `controller` key that fails the record's
  // validation, whatever the key holds — `null` and a scalar included — because
  // the next write would drop the key and the record with it.
  const junk = [{ pid: "29405", lstart: "x" }, { pid: 0, lstart: "x" }, { pid: 2 ** 31, lstart: "x" }, { pid: 1, lstart: "" }, { lstart: "x" }, null, "29405", []];
  for (const controller of junk) {
    assert.equal(flag(JSON.stringify({ quiet: 2, controller })), "holds a controller record that cannot be judged", JSON.stringify(controller));
  }
  assert.equal(flag(JSON.stringify({ quiet: 2, controller: { pid: 1, lstart: "x" } })), undefined, "a record it can judge is no fault");
  assert.equal(flag(JSON.stringify({ quiet: 2 })), undefined, "no `controller` key is no record, not a fault");
  rmSync(path);
  mkdirSync(path);
  assert.equal(readState(path, "fleet-state-test").degraded, "exists but cannot be read");
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

test("writeState: `ticked` survives a heartbeat write the same way `beat` survives a tick write", () => {
  // The mirror of the test above, other direction: fleet-heartbeat patches
  // elapsed/beat on every hold, so a write that dropped `ticked` would erase
  // fleet-tick's own liveness key the first time a heartbeat lands after a
  // busy stretch — silently reopening the #1597 follow-up this key exists to
  // close.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-ticked-carry-"));
  const path = join(dir, "heartbeat.json");
  const ticked = { at: 1_700_000_500_000 };
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ticked }));
  const prev = readState(path, "fleet-state-test");
  assert.deepEqual(prev.ticked, ticked, "readState did not parse a well-formed ticked mark");
  const beat = { at: 1_700_000_000_000, interval: 300, stopped: "" };
  assert.equal(writeState(path, "fleet-state-test", prev, { elapsed: 5, beat }), true);
  const after = readState(path, "fleet-state-test");
  assert.deepEqual(after.ticked, ticked, "fleet-heartbeat's mark write erased fleet-tick's ticked key");
  assert.deepEqual(after.beat, beat);

  // A junk `ticked` degrades to absent, never to a false zero: `at: 0` is a
  // decades-old occurrence, not "no occurrence", and would falsely rescue a
  // stale beat forever.
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ticked: { at: "soon" } }));
  assert.equal(readState(path, "fleet-state-test").ticked, null);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: `controller` survives a tick write and a heartbeat write, and a patch of undefined removes it", () => {
  // #2966. ledger.mjs rotate is the key's one writer; fleet-tick and
  // fleet-heartbeat rewrite the file on every tick and hold, and a key either
  // of them dropped would leave the next run judging no record at all.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-controller-"));
  const path = join(dir, "heartbeat.json");
  const controller = { pid: 29405, lstart: "Fri Oct  9 14:26:16 2026", prior: "dead", at: 1_700_000_000_000 };
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", controller, note: "not ours" }));
  const prev = readState(path, "fleet-state-test");
  assert.deepEqual(prev.controller, controller);
  assert.deepEqual(prev.rest, { note: "not ours" }, "`controller` must be destructured out, not left in `rest`");
  assert.equal(writeState(path, "fleet-state-test", prev, { quiet: 1, digest: "d" }), true);
  assert.deepEqual(readState(path, "fleet-state-test").controller, controller, "a tick write erased the controller record");
  const beat = { at: 1_700_000_000_000, interval: 300, stopped: "" };
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { elapsed: 5, beat }), true);
  assert.deepEqual(readState(path, "fleet-state-test").controller, controller, "a heartbeat write erased the controller record");

  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { controller: undefined }), true);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal("controller" in raw, false);
  assert.deepEqual(raw, { note: "not ours", quiet: 1, elapsed: 5, digest: "d", beat });
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: `seen` survives a heartbeat write and a controller write, is read per entry, and a patch of undefined removes it", () => {
  // fleet-tick is the key's one writer; fleet-heartbeat and ledger.mjs rotate
  // rewrite the file on every hold and every rotation, and a key either of
  // them dropped would restart every live token's age.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-seen-"));
  const path = join(dir, "heartbeat.json");
  const seen = { "fix-pr-5": 1_700_000_000_000, "review:PR#6": 1_700_000_100_000 };
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", seen, note: "not ours" }));
  const prev = readState(path, "fleet-state-test");
  assert.deepEqual(prev.seen, seen);
  assert.deepEqual(prev.rest, { note: "not ours" }, "`seen` must be destructured out, not left in `rest`");
  const beat = { at: 1_700_000_000_000, interval: 300, stopped: "" };
  assert.equal(writeState(path, "fleet-state-test", prev, { elapsed: 5, beat }), true);
  assert.deepEqual(readState(path, "fleet-state-test").seen, seen, "a heartbeat write erased `seen`");
  const controller = { pid: 29405, lstart: "Fri Oct  9 14:26:16 2026", prior: "ancestor", at: 1_700_000_000_000 };
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { controller }), true);
  assert.deepEqual(readState(path, "fleet-state-test").seen, seen, "a rotate write erased `seen`");

  // A tick write replaces the whole map: the pruned set is what it passes.
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { seen: { "fix-pr-5": seen["fix-pr-5"] } }), true);
  assert.deepEqual(readState(path, "fleet-state-test").seen, { "fix-pr-5": seen["fix-pr-5"] });

  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { seen: undefined }), true);
  assert.equal("seen" in JSON.parse(readFileSync(path, "utf8")), false);
  assert.deepEqual(readState(path, "fleet-state-test").seen, {});
  rmSync(dir, { recursive: true, force: true });
});

test("readState: `seen` keeps each valid stamp and drops each junk one, never the whole map", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-seen-shape-"));
  const path = join(dir, "heartbeat.json");
  const read = (seen) => {
    writeFileSync(path, JSON.stringify({ quiet: 3, seen }));
    return readState(path, "fleet-state-test");
  };
  for (const bad of [undefined, null, "x", 7, [1_700_000_000_000]]) assert.deepEqual(read(bad).seen, {}, JSON.stringify(bad));
  assert.deepEqual(read({ a: 1_700_000_000_000, b: 0, c: -5, d: 1.5, e: "1700000000000", f: null }).seen, { a: 1_700_000_000_000 });
  // A junk `seen` costs ages, never the streak beside it.
  assert.equal(read("junk").quiet, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: `applied` is written only by the tick, and survives a heartbeat write and a controller write", () => {
  // fleet-tick --apply is the key's one writer. A heartbeat or rotate write
  // that dropped it would have the next --apply tick reap again after every
  // merge pass it already reaped after.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-applied-"));
  const path = join(dir, "heartbeat.json");
  const applied = { run: 1_700_000_000_000, reapAfter: [1, 3] };
  writeFileSync(path, JSON.stringify({ quiet: 2, applied, note: "not ours" }));
  const prev = readState(path, "fleet-state-test");
  assert.deepEqual(prev.applied, applied);
  assert.deepEqual(prev.rest, { note: "not ours" }, "`applied` must be destructured out, not left in `rest`");

  // The real heartbeat's own write, not a stand-in for it.
  const heartbeat = fileURLToPath(new URL("../plugin/scripts/fleet-heartbeat.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [heartbeat, "--stop", "test over", "--state", path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after.beat?.stopped, "test over", "the heartbeat wrote no mark, so this case measured nothing");
  assert.deepEqual(after.applied, applied, "a heartbeat write erased `applied`");
  const controller = { pid: 29405, lstart: "Fri Oct  9 14:26:16 2026", prior: "ancestor", at: 1_700_000_000_000 };
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { controller }), true);
  assert.deepEqual(readState(path, "fleet-state-test").applied, applied, "a rotate write erased `applied`");
  rmSync(dir, { recursive: true, force: true });

  // Of every script that writes this file, only fleet-tick names `applied`
  // in a patch. Each writeState call is read up to its closing `);`.
  const scripts = fileURLToPath(new URL("../plugin/scripts/", import.meta.url));
  const writers = readdirSync(scripts).filter((f) => f.endsWith(".mjs") && f !== "fleet-state.mjs").filter((f) => {
    const src = readFileSync(join(scripts, f), "utf8");
    return [...src.matchAll(/\bwriteState\(/g)].some((m) => /\bapplied\s*:/.test(src.slice(m.index, src.indexOf(");", m.index))));
  });
  assert.deepEqual(writers, ["fleet-tick.mjs"]);
});

test("readState: `applied` is read against a run or not at all; a junk entry costs that entry alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-applied-shape-"));
  const path = join(dir, "heartbeat.json");
  const read = (applied) => {
    writeFileSync(path, JSON.stringify({ quiet: 3, applied }));
    return readState(path, "fleet-state-test");
  };
  for (const bad of [undefined, null, "x", [1], { reapAfter: [1] }, { run: null, reapAfter: [2] }, { run: 0, reapAfter: [1] }, { run: "5", reapAfter: [1] }, { run: 5 }, { run: 5, reapAfter: "1" }]) {
    assert.equal(read(bad).applied, null, JSON.stringify(bad));
  }
  assert.deepEqual(read({ run: 5, reapAfter: [1, 0, -2, 1.5, "3", null, 4] }).applied, { run: 5, reapAfter: [1, 4] });
  assert.equal(read("junk").quiet, 3, "a junk `applied` costs the streak beside it");
  rmSync(dir, { recursive: true, force: true });
});

test("readState: `controller` is a record only with a pid and a start time; a junk prior reads as none", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-controller-shape-"));
  const path = join(dir, "heartbeat.json");
  const read = (controller) => {
    writeFileSync(path, JSON.stringify({ quiet: 0, controller }));
    return readState(path, "fleet-state-test").controller;
  };
  for (const bad of [null, "29405", [29405], {}, { pid: 29405 }, { lstart: "x" }, { pid: "29405", lstart: "x" }, { pid: 0, lstart: "x" }, { pid: -1, lstart: "x" }, { pid: 1.5, lstart: "x" }, { pid: 2 ** 31, lstart: "x" }, { pid: 29405, lstart: "" }, { pid: 29405, lstart: 7 }]) {
    assert.equal(read(bad), null, JSON.stringify(bad));
  }
  for (const prior of ["dead", "ancestor", "none"]) assert.deepEqual(read({ pid: 7, lstart: "x", prior }), { pid: 7, lstart: "x", prior, at: null });
  for (const prior of [undefined, "alive", 3]) assert.deepEqual(read({ pid: 7, lstart: "x", prior }), { pid: 7, lstart: "x", prior: "none", at: null });
  // `at` degrades like `prior`: a record without a usable write time still
  // names a controller to judge, and only the time is unknown.
  assert.deepEqual(read({ pid: 7, lstart: "x", prior: "dead", at: 1_700_000_000_000 }), { pid: 7, lstart: "x", prior: "dead", at: 1_700_000_000_000 });
  for (const at of [0, -5, 1.5, "1700000000000", null]) {
    assert.deepEqual(read({ pid: 7, lstart: "x", prior: "dead", at }), { pid: 7, lstart: "x", prior: "dead", at: null }, JSON.stringify(at));
  }
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: the file a reader already opened is replaced whole, never rewritten in place", () => {
  // #2349. readState maps an empty or half-written file to the no-mark state
  // on purpose, so a write that truncated heartbeat.json and then filled it
  // let a reader landing in between see "no mark" on a live run — and
  // ledger.mjs rotate, which refuses only while a mark is beating, moved the
  // live controller's ledger. A hard link stands in for that reader: it holds
  // the inode the reader opened. An in-place write changes what it sees; a
  // rename leaves it the complete old version while the path gets the new.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-atomic-"));
  const path = join(dir, "heartbeat.json");
  const held = join(dir, "held-by-reader");
  const old = { at: 1_700_000_000_000, interval: 300, stopped: "" };
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", beat: old }));
  linkSync(path, held);
  const beat = { at: 1_700_000_300_000, interval: 300, stopped: "" };
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { beat }), true);
  assert.deepEqual(readState(held, "fleet-state-test").beat, old, "the write rewrote the file a reader holds in place");
  assert.deepEqual(readState(path, "fleet-state-test").beat, beat);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: a write that cannot land leaves no temp file behind", () => {
  // The temp is written first and renamed second, so a rename that fails —
  // here the target is a directory — would otherwise strand one
  // `heartbeat.json.<pid>.tmp` per failed invocation beside the file, each
  // heartbeat run a new pid.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-unlandable-"));
  const path = join(dir, "heartbeat.json");
  mkdirSync(path);
  writeFileSync(join(path, "occupant"), "x");
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { quiet: 1 }), false);
  assert.deepEqual(readdirSync(dir), ["heartbeat.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: a failed write names the liveness ages as well as the back-off progress it loses", (t) => {
  // fleet-tick ignores the boolean, so the warning is the only place a failed
  // write is seen. `seen` rides the same write as `quiet`: with the file
  // unwritable the stamps never persist, every tick re-stamps live tokens at
  // `now`, and no CHECK-LIVENESS line is ever printed. A warning naming only
  // the back-off streak would leave that silence unexplained.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-unlandable-"));
  const path = join(dir, "heartbeat.json");
  mkdirSync(path);
  writeFileSync(join(path, "occupant"), "x");
  const lines = [];
  t.mock.method(console, "error", (line) => { lines.push(String(line)); });
  assert.equal(writeState(path, "fleet-state-test", readState(path, "fleet-state-test"), { quiet: 1 }), false);
  rmSync(dir, { recursive: true, force: true });
  const warning = lines.find((l) => l.includes("WARNING could not write"));
  assert.ok(warning, `no write warning among ${JSON.stringify(lines)}`);
  assert.match(warning, /back-off progress/, "the warning keeps naming the back-off streak");
  assert.match(warning, /liveness ages/, "the warning names the liveness ages the tick's seen key holds");
});

test("writeState: two scripts writing the file at once both land — neither takes the other's temp", async () => {
  // fleet-tick and fleet-heartbeat both write heartbeat.json, each its own
  // process. A temp name the two share lets one rename the other's temp out
  // from under it, and the loser's rename fails on ENOENT — a reported write
  // failure that fleet-heartbeat treats as a fire (#531's race, ledger.mjs's
  // own temp). Timing decides only whether the two loops overlap, never
  // whether correct code passes: two pid-named temps cannot collide. Measured
  // with the shared name `${path}.tmp` instead, it failed on each of six runs.
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-concurrent-"));
  const path = join(dir, "heartbeat.json");
  const writer = `
    const { readState, writeState } = await import(${JSON.stringify(new URL("../plugin/scripts/fleet-state.mjs", import.meta.url).href)});
    let fails = 0;
    for (let i = 0; i < 300; i++) {
      if (!writeState(${JSON.stringify(path)}, "writer", readState(${JSON.stringify(path)}, "writer"), { digest: String(i).repeat(500) })) fails++;
    }
    console.log(fails);
  `;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", writer]);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (status) => resolve({ status, out: out.trim(), err }));
  });
  const results = await Promise.all([run(), run()]);
  rmSync(dir, { recursive: true, force: true });
  for (const r of results) {
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "0", `writes failed under a concurrent writer:\n${r.err}`);
  }
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

test("assessBeat: a busy run's own `ticked` covers for a `beat` the busy stretch never let refresh", () => {
  // #1597 follow-up. `beat` only refreshes when the queue drains ("beat when
  // there is nothing to do") — a fully-staffed fleet that has been busy for
  // eleven straight minutes never touches it, so the recorded interval stays
  // whatever it was when the stretch started (base, if it started right after a
  // dispatch) and the OLD mark ages straight past its own grace window. A
  // reconcile tick fires on every completion during that same stretch, though,
  // and now leaves its own mark behind — that is the evidence this asserts.
  const now = 2_000_000_000_000;
  const beat = { at: now - 11 * 60 * 1000, interval: 300, stopped: "" };
  assert.equal(assessBeat({ beat, now }).kind, "stale",
    "no ticked evidence at all is exactly the #1597 bug — still correctly overdue");
  assert.equal(assessBeat({ beat, ticked: { at: now - 2 * 60 * 1000 }, now }).kind, "beating",
    "a tick two minutes ago is a busy run working, not a dead one");

  // The reverse never happens: a stale `ticked` cannot rescue a genuinely
  // dead run, and a healthy `beat` needs no help from `ticked` at all.
  assert.equal(assessBeat({ beat, ticked: { at: now - 3 * DEFAULT_CEILING_S * 1000 }, now }).kind, "stale");
  const healthyBeat = { at: now - 60 * 1000, interval: 300, stopped: "" };
  assert.equal(assessBeat({ beat: healthyBeat, now }).kind, "beating");

  // `stopped` still outranks everything, ticked included: a run that named
  // its own death is not un-dead because fleet-tick happened to fire once on
  // the way out.
  const stopped = { at: now - 11 * 60 * 1000, interval: 300, stopped: "budget" };
  assert.equal(assessBeat({ beat: stopped, ticked: { at: now - 1000 }, now }).kind, "stopped");
});

test("stallsAt: a tick's window ends at the ceiling times grace, and only ever postpones `beat`'s own end", () => {
  const now = 2_000_000_000_000;
  // A beat already past its own window, so the tick alone decides — pinned on
  // both sides of the edge, the same pair the beat boundary above uses.
  const beat = { at: now - 11 * 60 * 1000, interval: 300, stopped: "" };
  const tickEdge = DEFAULT_CEILING_S * 1000 * BEAT_GRACE;
  assert.equal(stallsAt({ beat, ticked: { at: now - tickEdge } }), now);
  assert.equal(assessBeat({ beat, ticked: { at: now - tickEdge }, now }).kind, "beating");
  assert.equal(assessBeat({ beat, ticked: { at: now - tickEdge - 1 }, now }).kind, "stale");

  // The later of the two windows wins: a long recorded interval outlives an
  // old tick, so the tick must not cut that beat short.
  const long = { at: now - 30 * 60 * 1000, interval: 1200, stopped: "" };
  const oldTick = { at: now - 2 * tickEdge };
  assert.equal(stallsAt({ beat: long, ticked: oldTick }), long.at + 1200 * 1000 * BEAT_GRACE);
  assert.equal(assessBeat({ beat: long, ticked: oldTick, now }).kind, "beating");
  assert.equal(stallsAt({ beat: long }), long.at + 1200 * 1000 * BEAT_GRACE, "no tick is `beat` alone");
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

test("stallReport: a sub-60s interval renders as seconds, not a floored 0m", () => {
  // #1735: mins() floors to whole minutes, and the CLI guard for --base/
  // --ceiling only requires >= 1 (fleet-heartbeat.test.mjs relies on that —
  // its CLI cases use 2s/3s/8s intervals throughout to keep real
  // Atomics.wait holds fast), so a sub-minute mark is a real, reachable
  // shape here, not an input this module gets to refuse. Flooring it to
  // "0m" read as a division-by-zero defect rather than the true value.
  const now = 2_000_000_000_000;
  const at = now - 45_000;
  const verdict = assessBeat({ beat: { at, interval: 30, stopped: "smoke test" }, now });
  const line = stallReport(verdict, { claimed: 0, supply: 0 });
  assert.match(line, /45s ago/);
  assert.match(line, /15s past the 30s interval it promised/);
  assert.doesNotMatch(line, /\b0m\b/);

  // The boundary itself: exactly 60s reports as "1m", never "60s" — mins()
  // has exactly one branch point and this pins which side 60000ms falls on.
  const boundary = assessBeat({ beat: { at: now - 60_000, interval: 30, stopped: "smoke test" }, now });
  assert.match(stallReport(boundary, { claimed: 0, supply: 0 }), /1m ago/);
});

test("stallReport: a 60-119s band value does not silently break the trio's arithmetic (#1797)", () => {
  // #1735 only moved the floor for values UNDER 60s. mins() still floored
  // every value >= 60s to whole minutes independently of the other two, so
  // an interval landing in 60-119s (a real, CLI-reachable shape — see the
  // comment above mins()) floored to "1m" or "2m" while its own overdue
  // remainder kept printing in seconds, and the three displayed numbers
  // stopped agreeing with each other. These are the exact reviewer repros.
  const now = 2_000_000_000_000;
  const line = (ageS, intervalS) =>
    stallReport(
      assessBeat({ beat: { at: now - ageS * 1000, interval: intervalS, stopped: "smoke test" }, now }),
      { claimed: 0, supply: 0 },
    );

  // interval=90s, age=100s: overdue=10s. Old output read "1m ago ... 10s
  // past the 1m interval" — 1m minus 1m is 0, not 10s.
  assert.match(line(100, 90), /\(1m40s ago, 10s past the 1m30s interval it promised\)/);

  // interval=90s, age=200s: overdue=110s. Old output read "3m ago ... 1m
  // past the 1m interval" — 3m minus 1m is 2m, not 1m.
  assert.match(line(200, 90), /\(3m20s ago, 1m50s past the 1m30s interval it promised\)/);

  // interval=120s, age=150s: overdue=30s. Old output happened to print "2m
  // ago ... 30s past the 2m interval" only because 120s floors to an exact
  // "2m" with nothing dropped — fragile, not a fix, and now stated to full
  // precision like every other case in this band.
  assert.match(line(150, 120), /\(2m30s ago, 30s past the 2m interval it promised\)/);
});

test("stallReport: age always reconciles to overdue+interval, across every unit boundary the CLI can produce", () => {
  // Property check standing in for the two hand-picked repros above: for a
  // spread of intervals that straddle every unit boundary mins() has (under
  // 60s, the 60-119s band, and clean multi-minute values), and a spread of
  // deltas layered on top so age also straddles those same boundaries, the
  // three numbers stallReport prints must parse back to millisecond figures
  // that satisfy overdue + interval === age — never merely "doesn't crash".
  const now = 2_000_000_000_000;
  const parseDur = (s) => {
    const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    assert.ok(m, `unparseable duration: ${s}`);
    return ((m[1] ? Number(m[1]) : 0) * 60 + (m[2] ? Number(m[2]) : 0)) * 1000;
  };
  const lineShape = /\((\S+) ago, (\S+) past the (\S+) interval it promised\)/;

  const intervals = [30, 60, 90, 100, 119, 120, 150, 300];
  const deltas = [1, 15, 29, 30, 31, 59, 60, 61, 89, 90, 91, 119, 120, 121, 200, 599, 3600];
  for (const intervalS of intervals) {
    for (const delta of deltas) {
      const ageS = intervalS + delta;
      const verdict = assessBeat({ beat: { at: now - ageS * 1000, interval: intervalS, stopped: "smoke test" }, now });
      const line = stallReport(verdict, { claimed: 0, supply: 0 });
      const m = lineShape.exec(line);
      assert.ok(m, `line did not match expected shape: ${line}`);
      const [, ageStr, overdueStr, intervalStr] = m;
      const ageMs = parseDur(ageStr);
      const overdueMs = parseDur(overdueStr);
      const intervalMs = parseDur(intervalStr);
      assert.equal(
        overdueMs + intervalMs,
        ageMs,
        `interval=${intervalS}s age=${ageS}s: "${overdueStr}" + "${intervalStr}" != "${ageStr}" (line: ${line})`,
      );
    }
  }
});

// ── stallOwner: whose stall it is ───────────────────────────────────────────
//
// Whose stall it is comes off the record, judged through `judge`: stallOwner
// is handed the record alone, so neither a mark's age against the record's
// `at` nor `prior` can decide it. `judge` is injected so no reader finds the
// omp session running this suite.
const RECORD_AT = 1_000_000;
const recordWith = (prior) => ({ pid: 4242, lstart: "x", prior, at: RECORD_AT });

test("stallOwner: the owner is the record's judged verdict, whatever `prior` says", () => {
  const verdicts = {
    dead: { kind: "gone" },
    alive: { kind: "alive", pid: 4242 },
    ancestor: { kind: "alive", pid: 4242 },
    none: { kind: "none" },
  };
  for (const prior of ["dead", "ancestor", "none"]) {
    for (const [verdict, owner] of Object.entries(verdicts)) {
      assert.deepEqual(stallOwner(recordWith(prior), "t", () => verdict), owner, `prior ${prior}, judge ${verdict}`);
    }
  }
});

test("stallOwner: no controller record is no owner, and the judge is never asked", () => {
  const neverJudged = () => assert.fail("judge was called with no controller record");
  for (const missing of [null, undefined]) {
    assert.deepEqual(stallOwner(missing, "t", neverJudged), { kind: "none" }, `record ${missing}`);
  }
});

test("stallOwner: a judge failure that is not an unreadable process table propagates", () => {
  const controller = { pid: 1, lstart: "x", prior: "none", at: 1 };
  const bug = new TypeError("a programming error");
  assert.throws(() => stallOwner(controller, "t", () => { throw bug; }), (e) => e === bug);
  const err = console.error;
  const lines = [];
  console.error = (m) => lines.push(m);
  try {
    assert.deepEqual(stallOwner(controller, "t", () => { throw new ProcUnreadable("table gone"); }), { kind: "none" });
  } finally {
    console.error = err;
  }
  assert.match(lines[0], /cannot be judged/);
});

// ── #2968: a run judged from its own marks ──────────────────────────────────
const WINDOW = DEFAULT_CEILING_S * 1000 * BEAT_GRACE;
const MIN = 60_000;

test("readState/writeState: `acted` is read as a one-field mark and carried by every other writer's patch", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-acted-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: 1, acted: { at: 1_700_000_000_000, junk: 1 } }));
  const prev = readState(path, "t");
  assert.deepEqual(prev.acted, { at: 1_700_000_000_000 });
  assert.equal("acted" in prev.rest, false, "`acted` is schema, never a raw copy riding in `rest`");
  writeState(path, "t", prev, { quiet: 2, ticked: { at: 5 } });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).acted, { at: 1_700_000_000_000 });
  for (const junk of [0, -1, "x", null, { at: "1" }]) {
    writeFileSync(path, JSON.stringify({ acted: junk }));
    assert.equal(readState(path, "t").acted, null, JSON.stringify(junk));
  }
});

test("assessBeat: a ledger write within the window keeps a busy run beating, past `beat` and `ticked` both", () => {
  const now = 2_000_000_000_000;
  const controller = { pid: 1, lstart: "x", prior: "dead", at: now - 300 * MIN };
  const beat = { at: now - 120 * MIN, interval: 300, stopped: "" };
  const ticked = { at: now - 50 * MIN };
  assert.equal(assessBeat({ beat, ticked, controller, now }).kind, "stale", "no ledger write: the beat and the tick alone are past their windows");
  assert.equal(assessBeat({ beat, ticked, acted: { at: now - 5 * MIN }, controller, now }).kind, "beating");
  assert.equal(stallsAt({ beat, ticked, acted: { at: now - 5 * MIN }, controller }), now - 5 * MIN + WINDOW);
  assert.equal(assessBeat({ beat, ticked, acted: { at: now - WINDOW }, controller, now }).kind, "beating");
  assert.equal(assessBeat({ beat, ticked, acted: { at: now - WINDOW - 1 }, controller, now }).kind, "stale");
  // No record to partition by: `acted` still extends the beat.
  assert.equal(assessBeat({ beat, acted: { at: now - 5 * MIN }, now }).kind, "beating");
});

test("assessBeat: the previous run's recorded stop is that run's end, reported only until this run first ticks", () => {
  const now = 2_000_000_000_000;
  const controller = { pid: 1, lstart: "x", prior: "dead", at: now - 5 * 60 * MIN };
  const beat = { at: controller.at - 20 * 60 * MIN, interval: 1200, stopped: "run drained" };
  const acted = { at: now - 10 * MIN };
  // This run has ticked: the prior stop says nothing about it.
  const later = assessBeat({ beat, ticked: { at: now - 30 * MIN }, acted, controller, now });
  assert.equal(later.kind, "beating");
  assert.equal(isReported(later), false);
  // This run has not ticked yet: the stop is reported once, as the previous run's.
  const first = assessBeat({ beat, ticked: null, acted, controller, now });
  assert.equal(first.kind, "ended");
  assert.equal(isStalled(first), false, "the previous run's end is not this run's stall");
  assert.equal(isReported(first), true);
  const line = stallReport(first, { claimed: 3, supply: 4 });
  assert.match(line, /^previous run stopped deliberately at \S+Z \(\S+ ago\) — recorded reason: run drained$/);
  assert.doesNotMatch(line, /STALLED|claimed|this run's/);
  // A tick left by the previous run is not this run's first tick.
  assert.equal(assessBeat({ beat, ticked: { at: controller.at - MIN }, acted, controller, now }).kind, "ended");
  // The previous run's unstopped beat is never reported by this run.
  assert.equal(assessBeat({ beat: { ...beat, stopped: "" }, ticked: null, acted, controller, now }).kind, "beating");
  // This run's own stop is this run's verdict, as before.
  assert.equal(assessBeat({ beat: { ...beat, at: now - MIN }, ticked: null, acted, controller, now }).kind, "stopped");
});

test("assessBeat: a run with a controller record and no beat of its own goes stale off its latest mark, the record the floor", () => {
  const now = 2_000_000_000_000;
  const controller = (at) => ({ pid: 1, lstart: "x", prior: "none", at });
  assert.equal(assessBeat({ beat: null, controller: controller(now - WINDOW), now }).kind, "beating");
  const stale = assessBeat({ beat: null, controller: controller(now - WINDOW - 1), now });
  assert.equal(stale.kind, "stale");
  assert.equal(isStalled(stale), true);
  // A newer tick or ledger write pushes the stall out.
  const old = controller(now - 3 * WINDOW);
  assert.equal(assessBeat({ beat: null, ticked: { at: now - 10 * MIN }, controller: old, now }).kind, "beating");
  assert.equal(assessBeat({ beat: null, acted: { at: now - 10 * MIN }, controller: old, now }).kind, "beating");
  // A beat older than the record is the previous run's, so it cannot.
  assert.equal(assessBeat({ beat: { at: old.at - MIN, interval: 1200, stopped: "" }, controller: old, now }).kind, "stale");
  // The line names the latest mark and the window it was judged against.
  const line = stallReport(assessBeat({ beat: null, ticked: { at: now - 50 * MIN }, controller: old, now }), { claimed: 1, supply: 2 });
  assert.match(line, /^heartbeat STALLED: no beat this run, last tick \S+Z \(50m ago, 10m past the 40m window\) — no beat, tick or ledger write since, and no recorded reason; 1 ticket\(s\) claimed and in flight, pool supply 2$/);
  // No record and no beat stays `none`: there is no run to judge.
  assert.equal(assessBeat({ beat: null, ticked: { at: now - 3 * WINDOW }, now }).kind, "none");
  // And a fresh tick or ledger write beside no record and no beat is still
  // `none`: the board shows no panel without a record, and rotate's own
  // no-record gate reads the marks itself rather than moving this verdict.
  assert.equal(assessBeat({ beat: null, ticked: { at: now - MIN }, now }).kind, "none");
  assert.equal(assessBeat({ beat: null, acted: { at: now - MIN }, now }).kind, "none");
});

test("assessBeat: a controller record that cannot place a mark, beside no mark at all, judges no run — and one beside a mark still does", () => {
  const now = 2_000_000_000_000;
  const controller = { pid: 1, lstart: "x", prior: "none", at: null };
  assert.deepEqual(assessBeat({ beat: null, controller, now }), { kind: "none" });
  assert.equal(stallsAt({ beat: null, controller }), null);
  // With a mark the record cannot partition it away, so it is judged.
  assert.equal(assessBeat({ beat: null, ticked: { at: now - 5 * MIN }, controller, now }).kind, "beating");
  assert.equal(assessBeat({ beat: null, ticked: { at: now - WINDOW - 1 }, controller, now }).kind, "stale");
});
