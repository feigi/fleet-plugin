// Tests for the heartbeat — #357, the periodic resync that survives a drained
// queue. The two pure functions carry the back-off arithmetic; the CLI cases
// pin the things a reader would otherwise have to trust: that a long interval
// really does survive being served by several short holds, and that this script
// cannot clobber fleet-tick's half of the shared state file.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { interval, heldThisCall } from "./fleet-heartbeat.mjs";

const SCRIPT = fileURLToPath(new URL("./fleet-heartbeat.mjs", import.meta.url));

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

test("heldThisCall: serves the remainder of the interval, never more than the hold", () => {
  assert.equal(heldThisCall({ elapsed: 0, target: 1200, hold: 240 }), 240);
  assert.equal(heldThisCall({ elapsed: 1080, target: 1200, hold: 240 }), 120);
  assert.equal(heldThisCall({ elapsed: 0, target: 60, hold: 240 }), 60);
});

test("heldThisCall: an elapsed total past the target holds zero, not a negative", () => {
  // Reachable without a bug: lower --ceiling between two holds (or let a
  // quiet-streak reset shorten the target) and the persisted elapsed can exceed
  // it. A negative would reach Atomics.wait as a negative timeout.
  assert.equal(heldThisCall({ elapsed: 500, target: 300, hold: 240 }), 0);
});

test("CLI: a long interval survives being served by several short holds", () => {
  // The invariant that makes a 20-minute ceiling work at all, since neither
  // harness lets one command block that long. First call holds and reports the
  // remainder; the second completes the interval and resets.
  const first = run(["--base", "2", "--ceiling", "8", "--hold", "1"]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /1s of 2s remain/);
  assert.match(first.stdout, /do not end your turn/);
  assert.equal(first.state.elapsed, 1);

  const second = run(["--base", "2", "--ceiling", "8", "--hold", "1"],
    { state: JSON.stringify({ elapsed: 1 }) });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /interval elapsed/);
  assert.match(second.stdout, /run fleet-tick/);
  // Reset on fire, so the next interval starts from zero rather than from a
  // total already spent.
  assert.equal(second.state.elapsed, 0);
});

test("CLI: the quiet streak it reads comes from fleet-tick and lengthens the interval", () => {
  const r = run(["--base", "2", "--ceiling", "64", "--hold", "1"],
    { state: JSON.stringify({ quiet: 4, elapsed: 0 }) });
  assert.equal(r.status, 0);
  // 2 * 2**4 = 32, under the ceiling.
  assert.match(r.stdout, /31s of 32s remain \(quiet=4\)/);
});

test("CLI: writing elapsed preserves fleet-tick's keys", () => {
  // Key ownership is what lets two scripts share one file without a lock. A
  // whole-object rewrite here would drop `digest`, which reads as "the output
  // changed" on the next tick and silently un-folds a quiet night — the
  // cheap-per-wake half of the design, lost with nothing printed about it.
  const r = run(["--base", "9", "--hold", "1"],
    { state: JSON.stringify({ quiet: 3, elapsed: 0, digest: "abc123" }) });
  assert.equal(r.status, 0);
  assert.equal(r.state.digest, "abc123");
  assert.equal(r.state.quiet, 3);
  assert.equal(r.state.elapsed, 1);
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
  // is 0: read as a real zero it turns the hold into a no-op that still prints
  // a working-looking heartbeat line.
  const r = run(["--base", ""]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base must be a non-negative integer/);
});

test("CLI: a corrupt state file beats at the base interval and says so", () => {
  // Fail-open, deliberately, and in the safe direction: dying here would stop
  // the heartbeat, and a stopped heartbeat is the defect. More frequent level
  // checks are the harmless error.
  const r = run(["--base", "1", "--hold", "1"], { state: "not json" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING .* is not JSON/);
  assert.match(r.stdout, /interval elapsed/);
});

test("CLI: a state file with a junk field keeps the fields that parsed, and a foreign key rides along", () => {
  // Per-field validation, not all-or-nothing: losing a good streak to one bad
  // key would silently reset the back-off to the base every hold.
  const r = run(["--base", "2", "--ceiling", "64", "--hold", "1"],
    { state: JSON.stringify({ quiet: 4, elapsed: "nonsense", digest: "abc123", note: "not ours" }) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(quiet=4\)/);
  // And the file it leaves behind, which is the half a stdout-only assertion
  // cannot see: `note` is outside the schema and belongs to nobody here, so it
  // rides along untouched. Patch, never replace, is what lets two scripts share
  // one file without a lock, and a key this script does not know about is
  // exactly the case that rule exists for (#1597's stage-2 keys land here).
  // #1597 added a fourth key, and it carries a clock — so it is lifted out
  // here and asserted on its own shape rather than pinned to a timestamp a
  // test cannot know. The mark's own behaviour has its own cases at the foot
  // of this file; what this one still owes is the whole-file shape around it.
  assert.deepEqual(withoutMark(r.state), { note: "not ours", quiet: 4, elapsed: 1, digest: "abc123" });
  assert.equal(r.state.beat.stopped, "");
});

test("CLI: the value it writes back is the SANITIZED one, not the junk it read", () => {
  // The junk has to sit in a key this script does not patch, or the assertion
  // is vacuous: a bad `elapsed` is overwritten by the write either way, so only
  // a bad `quiet` or `digest` can show whether the file was rebuilt from the
  // validated view or from the raw parse. `quiet` is fleet-tick's, and this
  // script must neither own it nor launder it.
  //
  // Rebuilt from the raw parse, `quiet: "bogus"` goes back to disk verbatim and
  // the sanitizing only ever happened in memory — so every later reader repairs
  // it again, and the one field that decides the interval stays corrupt in the
  // file for the rest of the run.
  const r = run(["--base", "100", "--ceiling", "200", "--hold", "1"],
    { state: JSON.stringify({ quiet: "bogus", elapsed: 5, digest: "abc123", note: "not ours" }) });
  assert.equal(r.status, 0);
  // A junk streak reads as 0, which is the base interval — the fail-open
  // direction, more level checks rather than fewer.
  assert.match(r.stdout, /94s of 100s remain \(quiet=0\)/);
  assert.deepEqual(withoutMark(r.state), { note: "not ours", quiet: 0, elapsed: 6, digest: "abc123" });
});

test("CLI: a JSON array state file is announced and beats at the base interval", () => {
  // `[1,2,3]` is JSON, and `typeof [] === "object"`, so the array guard is the
  // only thing between it and reading `parsed.quiet` off an array — which is
  // `undefined`, sanitizes to 0, and would have this run silently agree that
  // the file was fine.
  const r = run(["--base", "1", "--hold", "1"], { state: "[1,2,3]" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING .* is not an object/);
  assert.match(r.stdout, /interval elapsed/);
  // Replaced by a real object, not patched as one: an array `rest` spread into
  // the write would persist `{"0":1,"1":2,"2":3,…}` and the next read would
  // announce the same fault forever.
  assert.deepEqual(withoutMark(r.state), { quiet: 0, elapsed: 0, digest: "" });
});

test("CLI: a state file it cannot READ is announced, never silently discarded", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  // The absent file is silent because a fresh run legitimately has none. An
  // EACCES on a file that EXISTS is a different event: it discards a real
  // streak and a real elapsed total. Sharing the absent case's silence is a
  // degraded read reported as a fresh run, which is the failure class this
  // ticket exists to close — and the direction of the damage is the long way
  // round, since quiet=15 here is a ceiling-length interval read as the base.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-unreadable-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: 15, elapsed: 10, digest: "abc" }));
  chmodSync(path, 0o000);
  const r = spawnSync(process.execPath,
    [SCRIPT, "--base", "2", "--ceiling", "64", "--hold", "1", "--state", path], { encoding: "utf8" });
  chmodSync(path, 0o644);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING could not read .*heartbeat\.json .*EACCES/);
  assert.match(r.stdout, /\(quiet=0\)/);
});

test("CLI: a state write that cannot land FIRES rather than holding the same remainder forever", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes every directory");
  // The livelock, and the reason a failed write cannot simply be survived: the
  // remainder is counted in a file, so with nothing persisting it every
  // invocation reads the same total, holds the same seconds and prints the same
  // `2s of 3s remain`. The interval never completes, fleet-tick is never run,
  // and the controller re-issues a command that reads like a working heartbeat
  // for the rest of the night — #357's own defect, wearing its remedy's line.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-unwritable-"));
  chmodSync(dir, 0o555);
  try {
    // Two invocations, because one could not tell a fire from progress. Both
    // are fresh processes reading the same state that never landed.
    for (const nth of ["first", "second"]) {
      const r = spawnSync(process.execPath,
        [SCRIPT, "--base", "3", "--ceiling", "8", "--hold", "1", "--state", join(dir, "heartbeat.json")],
        { encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /WARNING could not write/, `${nth}: a failed write is announced, never silent`);
      assert.match(r.stdout, /interval elapsed/, `${nth}: unpersisted progress fires instead of accumulating`);
      assert.doesNotMatch(r.stdout, /remain/, `${nth}: a remainder nothing is keeping is not a remainder`);
    }
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a fleet-tick that runs DURING the hold is not reverted when the hold ends", async () => {
  // The hold is up to 240s by default, and fleet-tick runs on merge-side edges
  // that owe this script nothing — so the file it wrote at the end of a hold is
  // not the file it read at the start. Patching the pre-hold snapshot back
  // reverts both of fleet-tick's keys: the streak it just reset on a busy wave
  // is restored, re-arming the ceiling-length interval the wave had shortened,
  // and the restored `digest` reads as "the output changed" on the next tick,
  // un-folding the quiet night the digest exists to fold.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-race-"));
  const path = join(dir, "heartbeat.json");
  // A long streak, so the interval is at the ceiling and one hold cannot serve
  // it — which is the state a quiet night is in when work finally arrives.
  writeFileSync(path, JSON.stringify({ quiet: 6, elapsed: 0, digest: "old" }));
  const child = spawn(process.execPath,
    [SCRIPT, "--base", "600", "--ceiling", "1200", "--hold", "3", "--state", path], { stdio: "ignore" });
  const exited = new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  // Well inside the hold, and after the read it opens with.
  await new Promise((r) => setTimeout(r, 700));
  writeFileSync(path, JSON.stringify({ quiet: 0, elapsed: 0, digest: "fresh" }));
  assert.equal(await exited, 0);

  const after = JSON.parse(readFileSync(path, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(after.quiet, 0, "the streak fleet-tick reset during the hold must survive the hold");
  assert.equal(after.digest, "fresh", "the digest fleet-tick wrote during the hold must survive the hold");
  // And this script's own key still advanced by the hold it actually served.
  assert.equal(after.elapsed, 3);
});

test("CLI: with no --state, and with an empty one, it resolves the run's shared default", () => {
  // The path the shipped invocation actually uses — SKILL.md's block passes no
  // --state at all — and `--state ""` is the shape an unset shell variable
  // produces, which `??` would let through as a real, empty path. Every read
  // and write against `''` then fails, which is the livelock above reached by
  // a second route, printed as a working heartbeat.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-default-"));
  assert.equal(spawnSync("git", ["init", "-q", dir], { encoding: "utf8" }).status, 0);
  const expected = join(dir, ".fleet", "heartbeat.json");
  for (const extra of [[], ["--state", ""]]) {
    rmSync(join(dir, ".fleet"), { recursive: true, force: true });
    const r = spawnSync(process.execPath,
      [SCRIPT, "--base", "2", "--ceiling", "8", "--hold", "1", ...extra], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // Never through the announced cwd-relative fallback: that path is the
    // degraded one, and a case that resolved through it would be pinning the
    // degradation while looking like it pinned the resolution.
    assert.doesNotMatch(r.stderr, /WARNING/, `--state ${JSON.stringify(extra[1] ?? "(absent)")} degraded`);
    assert.match(r.stdout, /1s of 2s remain/);
    assert.equal(JSON.parse(readFileSync(expected, "utf8")).elapsed, 1);
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
    [SCRIPT, "--base", "2", "--ceiling", "8", "--hold", "1"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".fleet", "heartbeat.json"), "utf8")).elapsed, 1);
  assert.equal(existsSync(join(other, ".fleet", "heartbeat.json")), false,
    "the state file followed an ambient GIT_DIR into another repository");
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});


// --------------------------------------------------------------------------
// The liveness mark — #1597. This script is the ONLY writer of `beat`, so
// everything below is about what it leaves on disk for two readers it never
// talks to: fleet-tick at the next run's start, and the cockpit every tick.

test("CLI: every beat marks the time and the interval that was in effect", () => {
  // The interval travels WITH the time because it is not a constant — the
  // back-off stretches it toward the ceiling — so a reader comparing an age
  // against a fixed threshold cries wolf on a quiet night or misses a death
  // on a busy one. `quiet: 4` here makes the recorded interval the BACKED-OFF
  // one (2 × 2⁴ = 32, under the 64s ceiling), not the base: a mark that
  // recorded --base would be recording a promise this beat did not make.
  const before = Date.now();
  const r = run(["--base", "2", "--ceiling", "64", "--hold", "1"],
    { state: JSON.stringify({ quiet: 4, elapsed: 0, digest: "abc" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.beat.interval, 32, "the mark must carry the interval in effect, not the base");
  assert.ok(r.state.beat.at >= before && r.state.beat.at <= Date.now(), "the mark must be dated by this beat");
  assert.equal(r.state.beat.stopped, "", "an ordinary beat records no stop reason");
  // And fleet-tick's keys still survive the write that added it — the mark is
  // a fourth key under the same one-writer rule, not a rewrite of the file.
  assert.equal(r.state.quiet, 4);
  assert.equal(r.state.digest, "abc");
});

test("CLI: --stop records the reason without holding or touching the back-off", () => {
  // A deliberate stop is not a beat: nothing is held, `elapsed` is left where
  // it was, and the invocation returns immediately. `--base 600` would be a
  // ten-minute interval if this path held at all, so the wall clock below is
  // the assertion that it does not.
  const started = Date.now();
  const r = run(["--base", "600", "--ceiling", "1200", "--stop", "budget exhausted"],
    { state: JSON.stringify({ quiet: 1, elapsed: 7, digest: "abc" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 30_000, "--stop must not hold");
  assert.equal(r.state.beat.stopped, "budget exhausted");
  assert.equal(r.state.elapsed, 7, "a stop is not a beat and must not spend the interval");
  assert.equal(r.state.quiet, 1);
  assert.match(r.stdout, /stop recorded \(budget exhausted\)/);
  // The line says who will report it, because a controller that stops without
  // knowing anything reads it has to wait for the next run to find out.
  assert.match(r.stdout, /the next run's start and the cockpit will report it/);
});

test("CLI: a beat after a stop clears the reason rather than carrying it forward", () => {
  // A run that recorded a stop and then kept beating did not stop. A reason
  // surviving into a live beat has every reader announcing a death that
  // already un-happened — and since a recorded stop outranks staleness, that
  // announcement would never age out on its own.
  const r = run(["--base", "2", "--ceiling", "4", "--hold", "1"], {
    state: JSON.stringify({ quiet: 0, elapsed: 0, digest: "",
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

test("CLI: a mark that cannot be written is announced and the heartbeat keeps beating", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes every directory");
  // The acceptance criterion this ticket states in its own words: a liveness
  // mark that killed the beat it measures would be #357's defect wearing a new
  // hat. So the write is made to FAIL — an unwritable state directory, the
  // same fixture the elapsed-write case above uses — and what is pinned is
  // that the process survives it, says so, and still prints the line that
  // keeps the controller's turn alive.
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-mark-unwritable-"));
  chmodSync(dir, 0o555);
  try {
    const r = spawnSync(process.execPath,
      [SCRIPT, "--base", "3", "--ceiling", "8", "--hold", "1", "--state", join(dir, "heartbeat.json")],
      { encoding: "utf8" });
    assert.equal(r.status, 0, "a failed mark write must never be fatal");
    assert.match(r.stderr, /WARNING could not write/, "a failed mark write is announced, never silent");
    assert.match(r.stdout, /run fleet-tick/, "the beat goes on: the controller is still told what to do next");
    assert.equal(existsSync(join(dir, "heartbeat.json")), false);

    // The same policy on the stop path, which has no next beat to keep going:
    // it announces on stdout as well, because writeState's stderr warning
    // names the file and not the consequence — that the next reader will see
    // a beat which stopped with no reason recorded.
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

test("CLI: an unreadable mark degrades to no mark and does not stop the beat", () => {
  // A corrupt `beat` must not be a corrupt heartbeat. readState repairs the
  // key to absent, which every reader renders as "nothing to report" — loud
  // in the safe direction, since the alternative is a live run announced as
  // dead off a field nobody can parse.
  const r = run(["--base", "2", "--ceiling", "4", "--hold", "1"],
    { state: JSON.stringify({ quiet: 0, elapsed: 0, digest: "", beat: "yesterday" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /interval elapsed|remain/);
  // Replaced by this beat's own mark, never left as the junk it read.
  assert.equal(typeof r.state.beat, "object");
  assert.equal(r.state.beat.stopped, "");
});