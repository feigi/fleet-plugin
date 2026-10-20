#!/usr/bin/env node
// The heartbeat: the ONE fleet-tick trigger that
// survives a fully drained queue.
//
// fleet-tick.mjs computes the deficit but only when something invokes it, and
// every other invocation is a wake: a member report, a label, a CI run ending.
// A drained fleet emits no wakes at all — no implementer completions, no merge
// activity — so nothing calls the tick and the stall is silent again. This
// script is the level-check that needs no event: it marks when the controller
// went idle and how long the next level-check may wait, and the controller then
// ends its turn. The alarm (controller-alarm.mjs, an omp extension loaded into
// the controller's own session) starts the next turn once the mark has fallen
// due, and that turn runs the tick.
//
// WHY AN ALARM AND NOT A WATCHER — the ruling, measured before it was made:
//
//   A backgrounded watcher does not wake an idle agent. Measured twice in one
//   run (run-team/references/member-lifecycle.md, "A member runs its test suite in the foreground"):
//   `fix-pr-1184` backgrounded its suite plus a Monitor and sat idle for
//   roughly two hours; neither ever woke it. run-merge-bot.md's CI gate states
//   the same rule as a rule — "whatever wakes you is external and may never
//   come".
//
//   So the alarm is not a Monitor, not a cron entry and not a paragraph of
//   prose. A cron entry that ran the reconcile would print its rows to nobody:
//   the tick reads the run for itself, but only the controller can act
//   on what it prints. Nothing outside the omp process can start a turn in an
//   idle session, which is the one thing the measurement above says an
//   external watcher cannot be trusted to do — so the alarm is an in-process
//   extension, which can.
//
// WHY IT TAKES NO CONTROLLER STATE — every flag below has a default. An alarm
// turn is a wake-up, never a verdict (run-team/SKILL.md, "A monitor event is a wake-up, never a verdict"), so this
// script never reads or reports fleet state: counts captured when the beat was
// marked and printed twenty minutes later are a stale verdict, and a stale
// verdict is how a reconcile prints an ACTION nobody can take. The controller
// runs `fleet-event.mjs heartbeat` itself at wake time, which ticks and so reads the run as it stands then.
// It also makes a late alarm harmless: if a member reports at minute two and
// the controller acts, the alarm that fires afterwards is a free extra tick.
//
// The pure half is interval(); main() does the I/O.

// Back-off. The interval doubles while the fleet has nothing to act on, so a
// quiet night costs a few wakes instead of one every five minutes — and stops
// doubling at a ceiling, because the ceiling IS the worst-case latency for
// noticing work that arrives with no event to announce it.
//
// That case is real and is the reason the ceiling is not simply "long": supply
// grows from OUTSIDE the fleet. A maintainer triages a ticket — including one a
// reviewer filed `needs-triage`, since only triage sets `ready-for-agent` —
// and that emits nothing the controller can observe. An unbounded back-off
// would therefore reintroduce #3's own defect in a form that reads like a
// feature — asleep at a level check, just slower. Twenty minutes bounds it
// while still cutting a quiet eight hours from ~96 wakes to ~26.
export function interval({ quiet, base, ceiling, multiplier }) {
  // Math.min, never a conditional chain: `base * multiplier ** quiet` overflows
  // to Infinity after ~1000 quiet ticks and every comparison against Infinity
  // still resolves correctly through min, where a hand-rolled ladder would have
  // to name that case to survive it.
  return Math.min(base * multiplier ** quiet, ceiling);
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// parse argv or touch the filesystem, or the pure half stops being unit-testable.

import { isCLI } from "./is-cli.mjs";
import { parseArgs } from "node:util";
import { makeDie, isDigits } from "./arg.mjs";
import { statePath, readState, writeState, DEFAULT_CEILING_S } from "./fleet-state.mjs";

const NAME = "fleet-heartbeat";
const die = makeDie(NAME);

// Every flag defaults — see the header. The defaults are declared here rather
// than threaded through int() so they pass through the same guard a
// caller-supplied value does; a hand-passed default goes round it.
const OPTIONS = {
  base: { type: "string", default: "300" },
  // Single source of truth in fleet-state.mjs — assessBeat's own fallback
  // freshness window for a busy run's `ticked` mark is this same number
  // too, and a duplicated "1200" here is the drift the module
  // header's "never a copy of it" rule exists to close.
  ceiling: { type: "string", default: String(DEFAULT_CEILING_S) },
  multiplier: { type: "string", default: "2" },
  // The deliberate stop. No default and no boolean spelling: the flag
  // IS the reason, and a `--stop` that recorded an empty string would be the
  // abrupt-death case wearing a deliberate stop's clothes — a reader would
  // report a recorded reason and then print nothing for it.
  //
  // It lives on THIS script rather than on fleet-tick because the mark is one
  // key with one writer (fleet-state.mjs's ownership rule), and the reason is
  // part of the mark: a stop written from the tick side would be two scripts
  // writing `beat` and would need the lock that file exists to avoid.
  stop: { type: "string" },
  state: { type: "string" },
};

// State path, read and write all come from fleet-state.mjs, which owns the key
// ownership rule this script depends on: it writes `beat` and
// nothing else, so fleet-tick's `quiet` and `digest` survive every call.

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
    // interval into a no-op that looks like a working heartbeat.
    if (!isDigits(raw)) die(`--${name} must be a non-negative integer, got '${values[name]}'`);
    const n = Number(raw);
    if (n < min) die(`--${name} must be at least ${min}, got ${n}`);
    return n;
  };
  const base = int("base", 1);
  const ceiling = int("ceiling", 1);
  const multiplier = int("multiplier", 1);
  // A ceiling under the base is not a slow heartbeat, it is a back-off that
  // runs backwards — min() would clamp every interval to the ceiling and the
  // base would never be honoured. Refuse rather than silently reinterpret.
  if (ceiling < base) die(`--ceiling (${ceiling}) is below --base (${base}) — the back-off would run backwards`);
  // `--stop` is read BELOW the int guards, so a malformed `--base` still
  // refuses on the stop path: a stop is the last thing this script does for a
  // run and it is not an excuse to stop validating.
  //
  // `values.stop` is `undefined` when the flag is absent and `""` when it was
  // given empty — the shape an unset shell variable produces — and only the
  // first is "not stopping". Same distinction every other flag in this file
  // draws, for the same reason.
  if (values.stop !== undefined && values.stop.trim() === "") {
    die("--stop must carry the reason the run is stopping, e.g. --stop 'budget exhausted'");
  }
  return { base, ceiling, multiplier, stop: values.stop?.trim(), state: values.state || statePath(NAME) };
}

// The mark: when this beat was seen and the interval that was in effect
// when it was. Built here rather than inline at each write so the two writes
// below cannot disagree about the shape of a key only this script owns.
//
// The interval travels WITH the time because a reader comparing an age
// against a fixed threshold either cries wolf on a quiet night at the ceiling
// or misses a death during a busy one at the base. It is the beat the run
// actually promised: the alarm fires once `at` plus the interval has passed.
function mark(target, stopped) {
  return { at: Date.now(), interval: target, stopped };
}

function main() {
  const { base, ceiling, multiplier, stop, state: path } = args();
  const state = readState(path, NAME);
  const target = interval({ quiet: state.quiet, base, ceiling, multiplier });

  if (stop !== undefined) {
    // This invocation is not a beat, it is the run saying why there will not
    // be another one. Leave degraded files byte-identical, so a same-session
    // rotate still refuses rather than judges none.
    if (state.degraded) {
      console.log(`heartbeat: stop NOT recorded (${stop}) — the heartbeat file is degraded and was left as it is, so a same-session rotate refuses on it until it is repaired`);
      return;
    }
    const persisted = writeState(path, NAME, state, { beat: mark(target, stop) });
    // Announced on stdout as well as through writeState's own stderr warning,
    // and still exit 0. An unrecorded stop is a real degradation — the next
    // run will report a beat that stopped without a reason, which is the
    // abrupt-death wording for a death that named itself — but it is not
    // grounds to fail the command: the controller is stopping either way and
    // a non-zero exit here only adds noise to a run that is already ending.
    console.log(persisted
      ? `heartbeat: stop recorded (${stop}) — the next run's start and the cockpit will report it`
      : `heartbeat: WARNING stop NOT recorded (${stop}) — the next reader will see a beat that stopped with no reason`);
    return;
  }

  // Leave degraded files byte-identical, so a same-session rotate still
  // refuses rather than judges none — a skipped write is a mark that was not
  // recorded, like a failed one.
  //
  // `stopped: ""` on every ordinary beat, never carried forward: a run that
  // recorded a stop and then kept beating is a run that did not stop, and a
  // stale reason surviving into a live beat would have the next reader
  // announcing a death that already un-happened.
  const persisted = !state.degraded && writeState(path, NAME, state, { beat: mark(target, "") });

  // One line either way, and never zero lines. Silence is the failure mode this
  // whole script is about: a heartbeat that printed nothing would be
  // indistinguishable from a heartbeat that died, which is the same
  // "indistinguishable from a working one" the member-idle measurement names.
  //
  // The line that tells the controller to end its turn is printed ONLY when
  // the mark is on disk. The alarm's gate reads `beat`; with none recorded it
  // never passes, so that line would send the controller idle into a session
  // nothing will wake — the drained-queue stall, reached through a line that
  // reads like a working heartbeat. A mark that failed to land says so, says
  // no alarm is armed, and exits 0 like the stop path: writeState has already
  // said so on stderr, and the controller can repair the file and beat again.
  //
  // `quiet=` is the streak the interval was DERIVED from, printed beside the
  // number it explains.
  if (persisted) {
    console.log(`heartbeat: beat marked, alarm due in ${target}s (quiet=${state.quiet}) → end your turn`);
  } else if (state.degraded) {
    console.log(`heartbeat: WARNING beat NOT marked — the heartbeat file is degraded and was left as it is, so no alarm is armed; repair the file and run this again`);
  } else {
    console.log(`heartbeat: WARNING beat NOT marked — the heartbeat file could not be written, so no alarm is armed; fix the write and run this again`);
  }
}

if (isCLI(import.meta.url)) main();
