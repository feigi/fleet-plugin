// The run-team controller's alarm. An omp extension: `plugin/package.json#omp.extensions`
// names this file beside `member-write-guard.mjs`, and a native install loads it
// into every omp session on the box — the controller's, every member's, and
// every unrelated session's — so it is inert unless its gate passes and it
// never throws.
//
// WHAT IT DOES. Nothing outside the omp process can start a turn in an idle
// session, and a controller that has ended its turn is idle. From inside the
// process `ctx.setInterval` plus `pi.sendUserMessage` can: every 30 s this
// checks whether the controller's beat has fallen due and, when it has, sends
// the one line that tells the controller to run the level-check
// (`fleet-event.mjs heartbeat`). The line is an ordinary user turn, told apart
// from a typed message by its `[fleet-alarm]` marker.
//
// THE GATE, `alarmDue()` — pure, no I/O, no clock read. All of these hold:
//   - the session is idle;
//   - `ctx.agent.kind` is `main`: a subagent's session never alarms;
//   - `.fleet/heartbeat.json`'s `controller.pid` is this process's pid, so two
//     omp sessions in one checkout alarm only the one the ledger recorded, and
//     a session in an unrelated repository alarms nothing;
//   - a `beat` is recorded and its `stopped` is empty: a stopped beat is a run
//     that ended on purpose, and `""` — what every ordinary beat carries — is
//     as empty as `null`;
//   - `now >= beat.at + beat.interval * 1000`;
//   - this beat has not already been alarmed within the last interval. A
//     controller that never re-marks is alarmed again once per interval, not
//     once per poll.
// A poll that cannot read or judge the file is "not due", and writes nothing
// to stderr on any poll: `readState` is handed a sink that drops its warnings,
// because the default would repeat the same line in the TUI every 30 s.
//
// IT NEVER ASKS TO QUEUE. The message goes out only when the session is idle at
// the check, with no `deliverAs`. A queued follow-up is lost when the
// maintainer presses Esc, and a steer backgrounds the controller's running bash
// call. A busy controller is skipped until the next poll, and nothing is held
// for it. omp's `sendUserMessage` still awaits before it dispatches, and a turn
// that starts in that gap takes the line as a steer: idle at the check narrows
// that window and does not close it.
//
// IT ONLY READS `beat`. `fleet-heartbeat.mjs` is the one writer of the mark and
// the one place the back-off is computed; this file never marks, never stops
// and never writes `.fleet/`. It does not suppress itself while the maintainer
// is typing: a draft in the editor survives the turn it starts.
//
// THE PROOF IT IS ARMED. At `session_start`, for the main session only, and
// only AFTER the timer is set, it writes `~/.fleet/alarm/<pid>.json` holding
// `{ pid, lstart, fleet }`: this process's pid, its start time as `proc.mjs`
// reads it, and the `.fleet/` path it resolved. Phase 0's `alarm` step reads
// the file and refuses unless it names this omp and this `.fleet/`. A
// session that set no timer writes no file, so the file proves the timer is
// armed against that repository's `.fleet/` and not only that the extension
// loaded. A start time that cannot be read writes no file, the safe direction:
// a missing file can only read as a timer not armed. The `.fleet/` path is
// resolved once, from `ctx.cwd`; outside a git repository, or where git fails
// or times out, no timer is set and no file is written. A leftover file from a
// dead session is harmless — its start time never matches a live process.
//
// Zero deps: node builtins and sibling scripts only.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { readState, stateFileIn } from "./fleet-state.mjs";
import { processSource } from "./proc.mjs";

export const POLL_MS = 30_000;
export const ALARM_LINE = "[fleet-alarm] run ~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run fleet-event.mjs heartbeat";
// Where the extension running as `pid` records that its timer is armed; phase 0 reads it there.
export const alarmFile = (pid) => join(homedir(), ".fleet", "alarm", `${pid}.json`);

/**
 * Whether the alarm fires now. `beat` is `{ at, interval, stopped }` (`at` in
 * ms, `interval` in seconds) or null; `controller` is `{ pid }` or null;
 * `firedFor` is null or `{ at, firedAt }`, the beat the last fire answered and
 * when.
 */
export function alarmDue({ kind, pid, controller, beat, idle, now, firedFor }) {
  if (idle !== true) return false;
  if (kind !== "main") return false;
  if (pid == null || controller?.pid !== pid) return false;
  if (!beat || beat.stopped) return false;
  const intervalMs = beat.interval * 1000;
  if (!(now >= beat.at + intervalMs)) return false;
  if (firedFor && firedFor.at === beat.at && now < firedFor.firedAt + intervalMs) return false;
  return true;
}

/** The extension factory omp calls once per session. */
export default function controllerAlarm(pi) {
  let latched = false;
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (latched || ctx?.agent?.kind !== "main") return;
      latched = true;
      arm(pi, ctx);
    } catch {
      // Loads into every session on the box: a fault here must cost that
      // session nothing.
    }
  });
}

function arm(pi, ctx) {
  let fleetDir;
  try {
    fleetDir = fleetFile(null, { cwd: ctx.cwd });
  } catch (e) {
    if (e instanceof FleetDirUnresolvable) return;
    throw e;
  }
  const beatFile = stateFileIn(fleetDir);
  let firedFor = null;

  const poll = () => {
    try {
      const { controller, beat } = readState(beatFile, "fleet-alarm", () => {});
      const now = Date.now();
      const due = alarmDue({ kind: ctx.agent.kind, pid: process.pid, controller, beat, idle: ctx.isIdle(), now, firedFor });
      if (!due) return;
      pi.sendUserMessage(ALARM_LINE);
      firedFor = { at: beat.at, firedAt: now };
    } catch {
      // Cannot read, judge or send: not fired, so the next poll tries again.
    }
  };
  ctx.setInterval(poll, POLL_MS);

  let lstart = null;
  try {
    lstart = processSource().startTime(process.pid);
  } catch {
    // An unreadable process table is an unreadable start time.
  }
  if (typeof lstart !== "string" || lstart === "") return;
  const file = alarmFile(process.pid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, lstart, fleet: fleetDir })}\n`);
}
