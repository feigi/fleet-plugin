// Tests for the heartbeat — #357, the periodic resync that survives a drained
// queue. interval() carries the back-off arithmetic; the CLI cases pin the
// things a reader would otherwise have to trust: that a call returns at once,
// that it never tells the controller to end its turn unless the mark it just
// took is on disk, and that it cannot clobber fleet-tick's half of the shared
// state file.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { interval } from "../plugin/scripts/fleet-heartbeat.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/fleet-heartbeat.mjs", import.meta.url));

// What a controller must never be told unless the mark is recorded.
const END_TURN = /end your turn/;

function run(args, { state } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-"));
  const path = join(dir, "heartbeat.json");
  if (state !== undefined) writeFileSync(path, state);
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--state", path], { encoding: "utf8" });
  const after = (() => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  })();
  rmSync(dir, { recursive: true, force: true });
  return { ...r, state: after };
}

// The whole-file assertions below predate #1597's liveness mark, and that key
// carries a clock. Dropping it here keeps each of them pinning what it was
// written to pin — the patch/replace shape of the file — without either
// pinning a timestamp no test can know or loosening into a field-by-field
// check that a new stray key would pass straight through.
const withoutMark = ({ beat, ...rest }) => rest;

test("interval: doubles per quiet tick and then stops at the ceiling", () => {
  const p = { base: 300, ceiling: 1200, multiplier: 2 };
  assert.equal(interval({ ...p, quiet: 0 }), 300);
  assert.equal(interval({ ...p, quiet: 1 }), 600);
  assert.equal(interval({ ...p, quiet: 2 }), 1200);
  // The ceiling is the point of the whole design: supply grows from outside the
  // fleet with no event to announce it, so the ceiling IS the worst-case
  // latency for noticing work. An unbounded back-off would reintroduce #3.
  assert.equal(interval({ ...p, quiet: 3 }), 1200);
  assert.equal(interval({ ...p, quiet: 40 }), 1200);
});

test("interval: a quiet streak long enough to overflow still clamps, never NaN", () => {
  // `base * multiplier ** quiet` is Infinity past ~1000 quiet ticks. Math.min
  // resolves that correctly; a hand-rolled comparison ladder would have to name
  // the case, and an overnight run at the ceiling reaches four digits of quiet
  // ticks in a few days of uptime.
  const got = interval({ quiet: 5000, base: 300, ceiling: 1200, multiplier: 2 });
  assert.equal(got, 1200);
});

test("CLI: a plain call returns at once with one line that says to end the turn, and the mark is on disk", () => {
  // `--base 600` was a blocking call for 240s when this script held; a call
  // that returns inside the bound below is not holding.
  const started = Date.now();
  const r = run(["--base", "600", "--ceiling", "1200"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 30_000, "a plain call must not block");
  assert.equal(r.stdout.trim().split("\n").length, 1, "one line, never zero and never two");
  assert.match(r.stdout, /heartbeat: beat marked, alarm due in 600s \(quiet=0\) → end your turn/);
  assert.deepEqual(Object.keys(r.state.beat).sort(), ["at", "interval", "stopped"]);
  assert.equal(r.state.beat.interval, 600);
  assert.equal(r.state.beat.stopped, "");
  assert.equal(typeof r.state.beat.at, "number");
});

test("CLI: --hold is an unknown flag and refuses like any other", () => {
  const r = run(["--hold", "1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option '--hold'/);
  assert.match(r.stderr, /accepted: --base, --ceiling, --multiplier, --stop, --state/);
  assert.equal(r.state, null, "a refused call writes nothing at all");
});

test("CLI: the quiet streak it reads comes from fleet-tick and lengthens the interval", () => {
  const r = run(["--base", "2", "--ceiling", "64"], { state: JSON.stringify({ quiet: 4 }) });
  assert.equal(r.status, 0);
  // 2 * 2**4 = 32, under the ceiling.
  assert.match(r.stdout, /alarm due in 32s \(quiet=4\) → end your turn/);
  assert.equal(r.state.beat.interval, 32);
});

test("CLI: writing the mark preserves fleet-tick's keys", () => {
  // Key ownership is what lets two scripts share one file without a lock. A
  // whole-object rewrite here would drop `digest`, which reads as "the output
  // changed" on the next tick and silently un-folds a quiet night — the
  // cheap-per-wake half of the design, lost with nothing printed about it.
  const r = run(["--base", "9"], { state: JSON.stringify({ quiet: 3, digest: "abc123" }) });
  assert.equal(r.status, 0);
  assert.equal(r.state.digest, "abc123");
  assert.equal(r.state.quiet, 3);
});

test("CLI: a ceiling below the base refuses rather than silently clamping", () => {
  // min() would pin every interval to the ceiling and never honour the base, so
  // the back-off would run backwards while looking configured.
  const r = run(["--base", "600", "--ceiling", "60"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ceiling \(60\) is below --base \(600\)/);
});

test("CLI: an empty flag value refuses — it is not a zero", () => {
  // `--base ""` is the shape an unset shell variable produces, and Number("")
  // is 0: read as a real zero it turns the interval into a no-op that still
  // prints a working-looking heartbeat line.
  const r = run(["--base", ""]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base must be a non-negative integer/);
});

test("CLI: a corrupt state file is announced, left as it is, and no alarm is armed", () => {
  // Never `→ end your turn` here: the file holds no readable `beat`, so the
  // alarm's gate never passes, and that line would send the controller idle
  // into a session nothing will wake. Exit 0 all the same, like the stop path.
  const r = run(["--base", "1"], { state: "not json" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING .* is not JSON/);
  assert.match(r.stdout, /beat NOT marked .*degraded.*no alarm is armed/);
  assert.doesNotMatch(r.stdout, END_TURN);
});

test("CLI: a state file with a junk field keeps the fields that parsed, and a foreign key rides along", () => {
  // Per-field validation, not all-or-nothing: losing a good streak to one bad
  // key would silently reset the back-off to the base on every beat.
  const r = run(["--base", "2", "--ceiling", "64"],
    { state: JSON.stringify({ quiet: 4, digest: 7, note: "not ours" }) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(quiet=4\)/);
  // And the file it leaves behind, which is the half a stdout-only assertion
  // cannot see: `note` is outside the schema and belongs to nobody here, so it
  // rides along untouched. Patch, never replace, is what lets two scripts share
  // one file without a lock, and a key this script does not know about is
  // exactly the case that rule exists for.
  // The mark carries a clock, so it is lifted out here and asserted on its own
  // shape rather than pinned to a timestamp a test cannot know.
  assert.deepEqual(withoutMark(r.state), { note: "not ours", quiet: 4, digest: "" });
  assert.equal(r.state.beat.stopped, "");
});

test("CLI: a state file still carrying `elapsed` is read without error and the key is not made up", () => {
  // `elapsed` belonged to the hold. A file written before it left is read as
  // before — the key is outside the schema now, so it rides along like any
  // other foreign key — and a file that never had it never gets one.
  const old = run(["--base", "2", "--ceiling", "64"],
    { state: JSON.stringify({ quiet: 1, elapsed: 5, digest: "abc" }) });
  assert.equal(old.status, 0, old.stderr);
  assert.equal(old.stderr, "");
  assert.match(old.stdout, /alarm due in 4s \(quiet=1\) → end your turn/);
  assert.equal(old.state.elapsed, 5, "carried untouched, never advanced or reset");

  const fresh = run(["--base", "2", "--ceiling", "64"], { state: JSON.stringify({ quiet: 1, digest: "abc" }) });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal("elapsed" in fresh.state, false);
});

test("CLI: the value it writes back is the SANITIZED one, not the junk it read", () => {
  // The junk has to sit in a key this script does not patch, or the assertion
  // is vacuous: `beat` is overwritten by the write either way, so only a bad
  // `quiet` or `digest` can show whether the file was rebuilt from the
  // validated view or from the raw parse. `quiet` is fleet-tick's, and this
  // script must neither own it nor launder it.
  //
  // Rebuilt from the raw parse, `quiet: "bogus"` goes back to disk verbatim and
  // the sanitizing only ever happened in memory — so every later reader repairs
  // it again, and the one field that decides the interval stays corrupt in the
  // file for the rest of the run.
  const r = run(["--base", "100", "--ceiling", "200"],
    { state: JSON.stringify({ quiet: "bogus", digest: "abc123", note: "not ours" }) });
  assert.equal(r.status, 0);
  // A junk streak reads as 0, which is the base interval — the fail-open
  // direction, more level checks rather than fewer.
  assert.match(r.stdout, /alarm due in 100s \(quiet=0\)/);
  assert.deepEqual(withoutMark(r.state), { note: "not ours", quiet: 0, digest: "abc123" });
});

test("CLI: a JSON array state file is announced, and the file is not replaced — no alarm is armed", () => {
  const corrupt = "[1,2,3]";
  const r = run(["--base", "1"], { state: corrupt });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING .* is not an object/);
  assert.match(r.stdout, /beat NOT marked .*no alarm is armed/);
  assert.doesNotMatch(r.stdout, END_TURN);
  assert.deepEqual(r.state, [1, 2, 3], "degraded file should not be written, so [1,2,3] is preserved");
});

// The bytes the file holds after the call, which `run` cannot give: it parses,
// and a file that is not JSON parses to null.
function runBytes(args, state) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-bytes-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, state);
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--state", path], { encoding: "utf8" });
  const bytes = readFileSync(path, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { ...r, bytes };
}

test("CLI: --stop over a degraded file leaves it byte-identical and says the stop was not recorded", () => {
  for (const [label, state] of [
    ["not JSON", "not json"],
    ["a JSON array", "[1,2,3]"],
    ["a controller that cannot be judged", JSON.stringify({ quiet: 3, controller: { pid: 0, lstart: "x" } })],
  ]) {
    const r = runBytes(["--stop", "budget exhausted"], state);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.match(r.stdout, /stop NOT recorded .* degraded/, label);
    assert.equal(r.bytes, state, `${label}: a degraded file is not replaced by a stop`);
  }
});

test("CLI: a beat over a file whose controller record cannot be judged warns, arms no alarm, and leaves the file byte-identical", () => {
  for (const controller of [{ pid: "29405", lstart: "x" }, null]) {
    const state = JSON.stringify({ quiet: 3, controller });
    const r = runBytes(["--base", "1"], state);
    const label = JSON.stringify(controller);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /WARNING .* holds a controller record that cannot be judged/, label);
    assert.match(r.stdout, /beat NOT marked .*degraded.*no alarm is armed/, `${label}: a skipped write says why`);
    assert.doesNotMatch(r.stdout, END_TURN, label);
    assert.equal(r.bytes, state, `${label}: the beat must not replace the record`);
  }
});

test("CLI: a state file it cannot READ is announced, never silently discarded, and arms no alarm", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  // The absent file is silent because a fresh run legitimately has none. An
  // EACCES on a file that EXISTS is a different event: it discards a real
  // streak. Sharing the absent case's silence is a degraded read reported as a
  // fresh run, which is the failure class this ticket exists to close — and
  // the file is left as it is, so no mark lands and no alarm is armed.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-unreadable-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: 15, digest: "abc" }));
  chmodSync(path, 0o000);
  const r = spawnSync(process.execPath,
    [SCRIPT, "--base", "2", "--ceiling", "64", "--state", path], { encoding: "utf8" });
  chmodSync(path, 0o644);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING could not read .*heartbeat\.json .*EACCES/);
  assert.match(r.stdout, /beat NOT marked .*no alarm is armed/);
  assert.doesNotMatch(r.stdout, END_TURN);
});

test("CLI: a state write that cannot land says no alarm is armed, never to end the turn", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes every directory");
  // The silent stall, and the reason a failed write cannot print the success
  // line: the alarm's gate reads `beat`, and with nothing persisted it never
  // passes. `→ end your turn` over an unwritten mark idles the controller into
  // a session nothing will wake — #357's own defect, wearing its remedy's line.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-unwritable-"));
  chmodSync(dir, 0o555);
  try {
    // Two invocations, because one could not tell a stable refusal from a
    // lucky one. Both are fresh processes reading a state that never landed.
    for (const nth of ["first", "second"]) {
      const r = spawnSync(process.execPath,
        [SCRIPT, "--base", "3", "--ceiling", "8", "--state", join(dir, "heartbeat.json")],
        { encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /WARNING could not write/, `${nth}: a failed write is announced, never silent`);
      assert.match(r.stdout, /beat NOT marked .*could not be written.*no alarm is armed/, `${nth}: the line names the failure`);
      assert.doesNotMatch(r.stdout, END_TURN, `${nth}: an unrecorded mark never says to end the turn`);
      assert.equal(existsSync(join(dir, "heartbeat.json")), false);
    }
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: with no --state, and with an empty one, it resolves the run's shared default", () => {
  // The path the shipped invocation actually uses — SKILL.md's block passes no
  // --state at all — and `--state ""` is the shape an unset shell variable
  // produces, which `??` would let through as a real, empty path. Every read
  // and write against `''` then fails, and the mark never lands.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-default-"));
  assert.equal(spawnSync("git", ["init", "-q", dir], { encoding: "utf8" }).status, 0);
  const expected = join(dir, ".fleet", "heartbeat.json");
  for (const extra of [[], ["--state", ""]]) {
    rmSync(join(dir, ".fleet"), { recursive: true, force: true });
    const r = spawnSync(process.execPath,
      [SCRIPT, "--base", "2", "--ceiling", "8", ...extra], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // Never through the announced cwd-relative fallback: that path is the
    // degraded one, and a case that resolved through it would be pinning the
    // degradation while looking like it pinned the resolution.
    assert.doesNotMatch(r.stderr, /WARNING/, `--state ${JSON.stringify(extra[1] ?? "(absent)")} degraded`);
    assert.match(r.stdout, /alarm due in 2s .*→ end your turn/);
    assert.equal(JSON.parse(readFileSync(expected, "utf8")).beat.interval, 2);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: an ambient GIT_DIR cannot relocate the run's one state file", () => {
  // There is ONE heartbeat per run and one file behind it, shared by every
  // worktree — which is why the path resolves against the git common dir
  // instead of the cwd. An inherited GIT_DIR answers that question for a
  // DIFFERENT repository, and the answer is a perfectly ordinary-looking
  // absolute path, so the run splits into private streaks in silence. Same
  // scrub run-merge-bot.md applies to this exact git command in shell.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-gitdir-"));
  const other = mkdtempSync(join(tmpdir(), "fleet-heartbeat-elsewhere-"));
  assert.equal(spawnSync("git", ["init", "-q", dir], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["init", "-q", other], { encoding: "utf8" }).status, 0);
  const env = { ...process.env, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other };

  // Positive control first: the injected variables really do reach a child and
  // really do change this command's answer. Without it, a state file landing in
  // the right place proves only that nothing was injected.
  const control = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8", env });
  assert.equal(control.stdout.trim(), join(other, ".git"));

  const r = spawnSync(process.execPath,
    [SCRIPT, "--base", "2", "--ceiling", "8"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".fleet", "heartbeat.json"), "utf8")).beat.interval, 2);
  assert.equal(existsSync(join(other, ".fleet", "heartbeat.json")), false,
    "the state file followed an ambient GIT_DIR into another repository");
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});


// --------------------------------------------------------------------------
// The liveness mark — #1597. This script is the ONLY writer of `beat`, so
// everything below is about what it leaves on disk for the readers it never
// talks to: the alarm every 30s, fleet-tick at the next run's start, and the
// cockpit every tick.

test("CLI: every beat marks the time and the interval that was in effect", () => {
  // The interval travels WITH the time because it is not a constant — the
  // back-off stretches it toward the ceiling — so a reader comparing an age
  // against a fixed threshold cries wolf on a quiet night or misses a death
  // on a busy one. `quiet: 4` here makes the recorded interval the BACKED-OFF
  // one (2 × 2⁴ = 32, under the 64s ceiling), not the base: a mark that
  // recorded --base would be recording a promise this beat did not make.
  const before = Date.now();
  const r = run(["--base", "2", "--ceiling", "64"],
    { state: JSON.stringify({ quiet: 4, digest: "abc" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.beat.interval, 32, "the mark must carry the interval in effect, not the base");
  assert.ok(r.state.beat.at >= before && r.state.beat.at <= Date.now(), "the mark must be dated by this beat");
  assert.equal(r.state.beat.stopped, "", "an ordinary beat records no stop reason");
  // And fleet-tick's keys still survive the write that added it — the mark is
  // a fourth key under the same one-writer rule, not a rewrite of the file.
  assert.equal(r.state.quiet, 4);
  assert.equal(r.state.digest, "abc");
});

test("CLI: --stop records the reason without touching the back-off", () => {
  // A deliberate stop is not a beat: the streak is left where it was.
  const r = run(["--base", "600", "--ceiling", "1200", "--stop", "budget exhausted"],
    { state: JSON.stringify({ quiet: 1, digest: "abc" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.beat.stopped, "budget exhausted");
  assert.equal(r.state.quiet, 1);
  assert.match(r.stdout, /stop recorded \(budget exhausted\)/);
  assert.doesNotMatch(r.stdout, END_TURN, "a stop is not an instruction to wait for an alarm");
  // The line says who will report it, because a controller that stops without
  // knowing anything reads it has to wait for the next run to find out.
  assert.match(r.stdout, /the next run's start and the cockpit will report it/);
});

test("CLI: a beat after a stop clears the reason rather than carrying it forward", () => {
  // A run that recorded a stop and then kept beating did not stop. A reason
  // surviving into a live beat has every reader announcing a death that
  // already un-happened — and since a recorded stop outranks staleness, that
  // announcement would never age out on its own.
  const r = run(["--base", "2", "--ceiling", "4"], {
    state: JSON.stringify({ quiet: 0, digest: "",
      beat: { at: 1_700_000_000_000, interval: 300, stopped: "budget exhausted" } }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.beat.stopped, "");
  assert.ok(r.state.beat.at > 1_700_000_000_000, "the mark must be re-dated by the live beat");
});

test("CLI: --stop refuses an empty reason", () => {
  // `--stop ""` is the shape an unset shell variable produces, and recording
  // it would be the abrupt-death case wearing a deliberate stop's clothes: a
  // reader would report a recorded reason and then print nothing for it.
  const r = run(["--stop", ""]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--stop must carry the reason the run is stopping/);
  assert.equal(r.state, null, "a refused stop writes nothing at all");
});

test("CLI: a stop whose write cannot land is announced on stdout too", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes every directory");
  // writeState's stderr warning names the file and not the consequence — that
  // the next reader will see a beat which stopped with no reason recorded.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-stop-unwritable-"));
  chmodSync(dir, 0o555);
  try {
    const s = spawnSync(process.execPath,
      [SCRIPT, "--stop", "budget exhausted", "--state", join(dir, "heartbeat.json")],
      { encoding: "utf8" });
    assert.equal(s.status, 0);
    assert.match(s.stdout, /WARNING stop NOT recorded/);
    assert.match(s.stdout, /the next reader will see a beat that stopped with no reason/);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: an unreadable mark degrades to no mark, is replaced by this beat's own, and the call still arms the alarm", () => {
  // A corrupt `beat` must not be a corrupt heartbeat. readState repairs the
  // key to absent, which every reader renders as "nothing to report" — loud
  // in the safe direction, since the alternative is a live run announced as
  // dead off a field nobody can parse. The file itself is not degraded, so the
  // write lands and the line may say to end the turn.
  const r = run(["--base", "2", "--ceiling", "4"],
    { state: JSON.stringify({ quiet: 0, digest: "", beat: "yesterday" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, END_TURN);
  // Replaced by this beat's own mark, never left as the junk it read.
  assert.equal(typeof r.state.beat, "object");
  assert.equal(r.state.beat.stopped, "");
});
