// Tests for the heartbeat — #357, the periodic resync that survives a drained
// queue. The two pure functions carry the back-off arithmetic; the CLI cases
// pin the things a reader would otherwise have to trust: that a long interval
// really does survive being served by several short holds, and that this script
// cannot clobber fleet-tick's half of the shared state file.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

test("CLI: a state file with a junk field keeps the fields that parsed", () => {
  // Per-field validation, not all-or-nothing: losing a good streak to one bad
  // key would silently reset the back-off to the base every hold.
  const r = run(["--base", "2", "--ceiling", "64", "--hold", "1"],
    { state: JSON.stringify({ quiet: 4, elapsed: "nonsense" }) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(quiet=4\)/);
});
