#!/usr/bin/env node
// The heartbeat. #3's item 2, filed as #357: the ONE fleet-tick trigger that
// survives a fully drained queue.
//
// fleet-tick.mjs computes the deficit but only when something invokes it, and
// the two shipped invocations are both merge-side EDGES. A drained fleet emits
// no edges at all — no implementer completions, no merge activity — so nothing
// calls the reconcile and the stall is silent again, which is the state #3 was
// filed about. This script is the level-check that needs no event: it holds the
// controller's turn for an interval and then tells it to run the reconcile.
//
// WHY A HOLD AND NOT A WATCHER — the ruling, measured before it was made:
//
//   A backgrounded watcher does not wake an idle agent. Measured twice in one
//   run (run-team/SKILL.md, "A member runs its test suite in the foreground"):
//   `fix-pr-1184` backgrounded its suite plus a Monitor and sat idle for
//   roughly two hours; neither ever woke it. run-merge-bot.md's CI gate states
//   the same rule as a rule — "whatever wakes you is external and may never
//   come" — and cures it the same way this file does, by holding the wait
//   inside one blocking command and re-issuing it.
//
//   So the heartbeat is not a Monitor, not a cron entry and not a paragraph of
//   prose. A cron entry could not run the reconcile even if it fired:
//   fleet-tick refuses without six controller-stated counts that nothing in the
//   repo records. An external scheduler can only WAKE the controller, which is
//   the one thing the measurement above says it cannot be trusted to do.
//
// WHY IT TAKES NO CONTROLLER STATE — every flag below has a default, unlike
// fleet-tick's six. That asymmetry is the design, not an omission: a monitor
// event is a wake-up, never a verdict (SKILL.md's Monitor rules), so this
// script never reads or reports fleet state. Counts captured before a
// twenty-minute hold and fed to a tick firing after it are a stale verdict, and
// a stale verdict is how a reconcile prints an ACTION nobody can take. The
// controller restates its counts at wake time and runs fleet-tick itself. It
// also makes a late hold harmless: if a member reports at minute two and the
// controller acts, the hold that fires afterwards is a free extra tick.
//
// The pure half is interval() and heldThisCall(); main() does the I/O.

// Back-off. The interval doubles while the fleet has nothing to act on, so a
// quiet night costs a few wakes instead of one every five minutes — and stops
// doubling at a ceiling, because the ceiling IS the worst-case latency for
// noticing work that arrives with no event to announce it.
//
// That case is real and is the reason the ceiling is not simply "long": supply
// grows from OUTSIDE the fleet. A maintainer triages a ticket, or a reviewer
// files a correction ticket carrying `ready-for-agent`, and neither emits
// anything the controller can observe. An unbounded back-off would therefore
// reintroduce #3's own defect in a form that reads like a feature — asleep at a
// level check, just slower. Twenty minutes bounds it while still cutting a
// quiet eight hours from ~96 wakes to ~26.
export function interval({ quiet, base, ceiling, multiplier }) {
  // Math.min, never a conditional chain: `base * multiplier ** quiet` overflows
  // to Infinity after ~1000 quiet ticks and every comparison against Infinity
  // still resolves correctly through min, where a hand-rolled ladder would have
  // to name that case to survive it.
  return Math.min(base * multiplier ** quiet, ceiling);
}

// How long THIS invocation may block, which is not the same as the interval.
//
// Neither harness lets one command block for twenty minutes. Measured: omp
// auto-backgrounds any foreground command at 60s (`bash.autoBackground`), and
// its command deadline defaults to 300s; Claude Code kills a command at its own
// shell timeout, which run-merge-bot.md:195 already records as shorter than a
// ~5-6 minute CI cycle ("if `gh run watch` outlives your shell timeout,
// re-issue it — that is still one blocking call per turn, not an idle turn").
//
// So a long interval is served by SEVERAL holds, and the elapsed total is
// persisted rather than counted in prose. That is the same remedy the CI gate
// reached for, made mechanical: the script says how much remains, so the
// controller re-issues without tracking arithmetic across turns.
export function heldThisCall({ elapsed, target, hold }) {
  return Math.min(hold, Math.max(0, target - elapsed));
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// parse argv or touch the filesystem, or the pure half stops being unit-testable.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { makeDie, isDigits } from "./arg.mjs";
import { statePath, readState, writeState } from "./fleet-state.mjs";

const NAME = "fleet-heartbeat";
const die = makeDie(NAME);

// Every flag defaults — see the header. The defaults are declared here rather
// than threaded through int() so they pass through the same guard a
// caller-supplied value does; a hand-passed default goes round it.
const OPTIONS = {
  base: { type: "string", default: "300" },
  ceiling: { type: "string", default: "1200" },
  multiplier: { type: "string", default: "2" },
  // Per-invocation blocking budget, under both harnesses' defaults. 240s leaves
  // headroom below omp's 300s deadline and below the Claude Code timeout that
  // run-merge-bot.md:195 measures as shorter than a 5-6 minute CI cycle. Raise
  // it only together with the tool call's own timeout.
  hold: { type: "string", default: "240" },
  state: { type: "string" },
};

// State path, read and write all come from fleet-state.mjs, which owns the key
// ownership rule this script depends on: it writes `elapsed` and nothing else,
// so fleet-tick's `quiet` and `digest` survive every hold. main() re-reads the
// file after its hold to keep that true across the hold itself, and treats a
// write that did not land as a fire rather than as progress.

// A blocking sleep, not a poll loop. Atomics.wait on a SharedArrayBuffer parks
// the thread; `while (Date.now() < end) {}` would burn a core for the whole
// hold, and setTimeout would need the event loop to stay alive and would let
// anything else queued run first.
function block(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function args() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS }));
  } catch (e) {
    // Unconditional catch, as in fleet-tick: parseArgs throws on the FIRST
    // offending argument, so keying off an error code disables the guard for
    // every argv where something else comes earlier.
    die(`${e.message} — accepted: ${Object.keys(OPTIONS).map((f) => `--${f}`).join(", ")}`);
  }
  const int = (name, min) => {
    const raw = String(values[name]).trim();
    // Digits, not Number(): `Number("")` is 0, so `--base ""` — the shape an
    // unset shell variable produces — would read as a real zero and turn the
    // hold into a no-op that looks like a working heartbeat.
    if (!isDigits(raw)) die(`--${name} must be a non-negative integer, got '${values[name]}'`);
    const n = Number(raw);
    if (n < min) die(`--${name} must be at least ${min}, got ${n}`);
    return n;
  };
  const base = int("base", 1);
  const ceiling = int("ceiling", 1);
  const multiplier = int("multiplier", 1);
  const hold = int("hold", 1);
  // A ceiling under the base is not a slow heartbeat, it is a back-off that
  // runs backwards — min() would clamp every interval to the ceiling and the
  // base would never be honoured. Refuse rather than silently reinterpret.
  if (ceiling < base) die(`--ceiling (${ceiling}) is below --base (${base}) — the back-off would run backwards`);
  return { base, ceiling, multiplier, hold, state: values.state || statePath(NAME) };
}

function main() {
  const { base, ceiling, multiplier, hold, state: path } = args();
  const state = readState(path, NAME);
  const target = interval({ quiet: state.quiet, base, ceiling, multiplier });
  const held = heldThisCall({ elapsed: state.elapsed, target, hold });

  block(held);
  // Re-read AFTER the hold, and patch THAT rather than the pre-hold snapshot.
  // fleet-tick can run while this call is blocked — up to --hold seconds, 240
  // by default — and it owns both keys this script must not touch. Writing the
  // snapshot back reverts them: a busy wave that reset `quiet` to 0 would find
  // the long interval re-armed the moment the hold ended, and a reverted
  // `digest` reads as "the output changed" on the next tick, un-folding the
  // quiet night the digest exists to fold. `elapsed` is still the only key
  // this script writes; it is now read fresh rather than remembered across a
  // hold long enough for the file to have moved underneath it.
  const now = readState(path, NAME);
  const elapsed = now.elapsed + held;
  const reached = elapsed >= target;
  // Reset on fire, so the next interval starts from zero rather than from a
  // total that has already elapsed. Only `elapsed` is written — fleet-tick owns
  // `quiet` and `digest`, and fleet-state.mjs's patch write preserves them.
  const persisted = writeState(path, NAME, now, { elapsed: reached ? 0 : elapsed });
  // A failed write is itself a fire. With nothing persisting the remainder,
  // every invocation reads the same elapsed total, holds the same seconds and
  // prints the same remainder: the interval can never complete, so fleet-tick
  // is never run at all — #357's own defect, reached through a line that reads
  // like a working heartbeat. Beating too often is the harmless direction;
  // never beating is the one this script exists to prevent.
  const done = reached || !persisted;

  // One line either way, and never zero lines. Silence is the failure mode this
  // whole ticket is about: a heartbeat that printed nothing would be
  // indistinguishable from a heartbeat that died, which is the same
  // "indistinguishable from a working one" the member-idle measurement names.
  // The partial line says what to do next in the imperative, because the one
  // thing that must not happen here is the controller ending its turn.
  //
  // `quiet=` is the pre-hold streak, the one the interval was DERIVED from: a
  // fresh streak printed beside a target computed from the old one would be two
  // numbers that do not explain each other.
  console.log(done
    ? `heartbeat: held ${held}s, ${target}s interval elapsed (quiet=${state.quiet}) → restate your live counts and run fleet-tick`
    : `heartbeat: held ${held}s, ${target - elapsed}s of ${target}s remain (quiet=${state.quiet}) → re-issue this command now, do not end your turn`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
