// The heartbeat's shared state file, owned jointly by fleet-tick.mjs and
// fleet-heartbeat.mjs — so the path and the file's shape live here rather than
// in two spellings that drift. Same rule arg.mjs states for the digits guard:
// what travels between scripts is the rule, never a copy of it.
//
// KEY OWNERSHIP, which is the whole reason two scripts can share one file
// without a lock:
//
//   quiet    fleet-tick only. Consecutive ticks that asked the controller for
//            nothing. Drives the back-off interval.
//   digest   fleet-tick only. The last tick's own output, so an unchanged
//            quiet tick can fold to one line instead of three.
//   elapsed  fleet-heartbeat only. Seconds already held toward the current
//            interval, because no harness lets one command block long enough
//            to serve a twenty-minute interval in a single call.
//   beat     fleet-heartbeat only (#1597). The liveness mark: when the beat
//            was last seen, the interval that was in effect when it was, and
//            a deliberate stop's reason if one was recorded. Written by the
//            heartbeat and by nothing else — fleet-tick READS it at the start
//            of a run and the cockpit READS it every tick, and a key two
//            scripts wrote would need the lock this file exists to avoid.
//
// One writer per key. A key both scripts wrote would need locking to be
// correct, and neither script is in a position to hold one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { workspaceDirFromGitCommonDir } from "./git-env.mjs";

// The filename, in one place, because #1597 gave this file a SECOND resolver.
// board.mjs already resolves the run's workspace for itself — it has to, since
// its own `canonicalise` opt-in is what keeps a symlinked route from deriving
// a second port (#1582) — so it reaches the state file by joining onto the
// `.fleet` directory it already holds rather than re-running the probe below.
// What it must NOT do is spell `heartbeat.json` a second time: a filename in
// two places is the drift this module's header exists to prevent, and a
// cockpit reading a file the heartbeat does not write is a liveness panel
// that is permanently, silently empty.
export function stateFileIn(fleetDir) {
  return join(fleetDir, "heartbeat.json");
}

// There is ONE heartbeat per run and its state lives in the main checkout.
// Members run from their own worktrees, where a cwd-relative `.fleet/` does not
// exist, so a cwd-relative path would give every worktree a private back-off
// streak and a private elapsed total — the run's beat would be whichever
// worktree happened to call last.
//
// This is ledger.mjs's defaultLedgerPath() resolution applied to a second file
// for the same reason (there, a cwd-local ledger silently degraded the
// duplicate-filing guard). The third file this comment used to predict arrived
// with #1656 — board.mjs's resolveCockpitInstance() — so the resolution itself
// moved, as promised, though into git-env.mjs beside gitEnv() rather than into
// this module: board.mjs and ledger.mjs both already import that one, and a
// cockpit reaching into the heartbeat's state module for a path rule would be
// a stranger dependency than either has now (#1658). Only the filename and the
// warning below are this caller's own.
export function statePath(name) {
  // GIT_DIR and GIT_WORK_TREE scrubbed, never inherited: an ambient GIT_DIR
  // answers `--git-common-dir` for a DIFFERENT repository, which relocates the
  // ONE file this whole design rests on. It fails in exactly the direction the
  // common-dir resolution exists to close — a private streak and a private
  // elapsed total per environment — and it fails SILENTLY, because a resolved
  // path inside another repo looks like any other resolved path. Same scrub
  // run-merge-bot.md performs on the identical command in shell (`env -u
  // GIT_DIR -u GIT_WORK_TREE git rev-parse --git-common-dir`); spelled as an
  // env object here because there is no shell to spell it in.
  // Migrating this inline scrub to gitEnv() — imported in this file since
  // #1658 for the path rule above, not for the env — stays out of scope: it is
  // recorded with its own measurement and its own behavioural fixture in
  // ambient-git-vars-mjs-prose.test.mjs's MJS_LEGACY_INLINE list.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", env });
  // No separate `r.status === 0` gate: every failure mode reproducible here
  // (no repository, an unresolvable GIT_DIR, a permission-denied `.git`, a
  // corrupt worktree pointer, a missing `git` binary) leaves `r.stdout`
  // empty, which workspaceDirFromGitCommonDir() already reads as `null` on
  // its own — see its own docstring for that contract.
  const workspace = workspaceDirFromGitCommonDir(r.stdout);
  if (workspace === null) {
    // Announced, never silent: a cwd-relative fallback re-opens exactly the
    // per-worktree split this resolution exists to close.
    console.error(`${name}: WARNING could not resolve --git-common-dir; using cwd-relative .fleet/heartbeat.json`);
    return stateFileIn(".fleet");
  }
  return stateFileIn(join(workspace, ".fleet"));
}

// An unreadable or corrupt state file is NOT fatal, and the direction of the
// failure is the argument: a missing streak reads as quiet=0, which is the BASE
// interval — more frequent level checks, never fewer. Dying instead would stop
// the heartbeat, and a stopped heartbeat is the defect.
//
// Absent is the ONLY silent case, because it is the only one that is not a
// fault: a fresh run legitimately has no file yet. An unreadable file and a
// corrupt one are both announced — each discards real state, and silence about
// a degraded read is the failure class this whole ticket exists to close.
export function readState(path, name) {
  // `beat: null` is the absent MARK, and it is not the same value as a mark
  // whose fields are zero: nothing has been seen beating, so there is nothing
  // to judge and nothing to report. A zeroed mark would date the beat to the
  // epoch and read as decades overdue on a run that has simply not started
  // one — the cry-wolf direction this key must never fail in.
  const fresh = { quiet: 0, elapsed: 0, digest: "", beat: null, rest: {} };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT is the only silent one, because it is the only one that is not a
    // fault: a fresh run legitimately has no file yet. Every other errno is a
    // file that EXISTS and could not be read — EACCES on a chmod'ed state
    // file, EISDIR on a path something else claimed, EIO on a bad disk — and
    // each of those discards a real back-off streak and a real elapsed total.
    // Swallowing them with the same bare catch the absent case uses is a
    // degraded read reported as a fresh run, which is the failure class this
    // whole ticket exists to close.
    if (e.code !== "ENOENT") {
      console.error(`${name}: WARNING could not read ${path} (${e.message}) — restarting at the base interval`);
    }
    return fresh;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`${name}: WARNING ${path} is not JSON (${e.message}) — restarting at the base interval`);
    return fresh;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`${name}: WARNING ${path} is not an object — restarting at the base interval`);
    return fresh;
  }
  // Per-field validation, not all-or-nothing: a file carrying a good `quiet`
  // and a junk `elapsed` keeps the streak instead of losing both to one key.
  const num = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  // `rest` is strictly what lies OUTSIDE the schema, which is what makes the
  // patch write below a patch rather than a laundering step. A raw copy of
  // quiet/elapsed/digest in here would be written straight back by whichever
  // script does not own the key, so a junk value would survive every write
  // that sanitized it in memory — validation that only ever holds inside one
  // process is not validation of the file.
  // The MARK is validated as a unit rather than per sub-field, which is the
  // opposite of the rule above and for the reason the rule above gives. The
  // three scalars fail independently because each one alone is still useful;
  // a mark is a TIME judged against the INTERVAL it was promised at, so half
  // of one is not a degraded mark, it is a verdict computed against a number
  // nobody wrote. Both fields must be positive integers or the mark is absent
  // — never "stale", which is the wolf, and never "beating", which is the
  // silence. `stopped` is the exception: a mark with a junk reason is still a
  // mark, and it degrades to "no reason recorded", which is exactly what
  // assessBeat() says about an abrupt death anyway.
  const mark = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const at = num(v.at), interval = num(v.interval);
    if (at === 0 || interval === 0) return null;
    return { at, interval, stopped: typeof v.stopped === "string" ? v.stopped : "" };
  };
  const { quiet, elapsed, digest, beat, ...rest } = parsed;
  return {
    quiet: num(quiet),
    elapsed: num(elapsed),
    digest: typeof digest === "string" ? digest : "",
    beat: mark(beat),
    rest,
  };
}

// Patch, never replace. Each script writes only the keys it owns, and rewriting
// the whole object from one script's view would drop the other's — a dropped
// `digest` reads as "the output changed" on the next tick, which un-folds a
// quiet night and silently undoes the cheap-per-wake half of the design.
//
// A failed write is reported and SURVIVED, never fatal, for the same reason a
// failed read is. But survived is not the same as ignored: it returns whether
// the write landed, because the two cases call for different behaviour from
// the caller and only the caller can act. An unpersisted `elapsed` means the
// next invocation re-reads the same total, holds again and reports the same
// remainder — an interval that can never complete — so fleet-heartbeat treats
// a failed write as a fire instead of counting progress that nothing is
// keeping.
export function writeState(path, name, prev, patch) {
  // Built from the VALIDATED view plus the fields outside the schema, never
  // from the raw parse: see `rest` in readState above.
  const next = {
    ...(prev.rest ?? {}),
    quiet: prev.quiet, elapsed: prev.elapsed, digest: prev.digest,
    // Carried like the other three, and omitted rather than written as
    // `null` when there is none: fleet-tick patches `quiet`/`digest` on every
    // tick and would otherwise erase the heartbeat's mark on the first tick
    // after it was written — one script deleting another's key, which is the
    // failure the ownership rule exists to prevent and which no reader could
    // tell from a run that never beat.
    ...(prev.beat ? { beat: prev.beat } : {}),
    ...patch,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (e) {
    console.error(`${name}: WARNING could not write ${path} (${e.message}) — back-off progress will not persist`);
    return false;
  }
}

// --------------------------------------------------------------------------
// READING THE MARK — #1597. The rule, and the wording, in one place.
//
// Two readers consume this key and neither of them writes it: fleet-tick at
// the start of a run (so a run that died overnight announces itself even when
// no cockpit survived it) and board.mjs on every cockpit tick (the better
// surface, the weaker guarantee — whether a backgrounded cockpit outlives the
// session that spawned it is unmeasured and harness-dependent, so the mark is
// the artifact and the cockpit is one renderer of it).
//
// Both live here for the reason the module header already gives about the
// path and the shape: what travels between scripts is the rule, never a copy
// of it. Two staleness thresholds would be two different answers to "is this
// run dead" from one file, and two wordings would let a rewrite of the
// cockpit's banner leave the tick's line saying something else.

// Staleness is judged against the interval the mark RECORDS, never against a
// constant. The interval is not a constant — back-off stretches it from
// --base toward --ceiling — so a fixed threshold either cries wolf on a quiet
// night at the ceiling or misses a death during a busy one at the base.
//
// The grace multiplier is the only constant, and it is a multiplier ON the
// recorded interval rather than a duration added to it, so it scales with the
// promise instead of drowning it. One whole extra interval of silence: a beat
// is served by SEVERAL holds (see fleet-heartbeat.mjs's heldThisCall), the
// controller's own turn sits between the last hold and the next invocation,
// and neither is bounded tightly enough to call a run dead the second one
// interval lapses. It is the same shape board.html already uses to call its
// own data stale (`interval * 1000 * 2`), kept deliberately: an operator
// reading two "stale" verdicts on one page should not have to learn two rules.
export const BEAT_GRACE = 2;

// What the mark says, as a value. `now` is a parameter so every caller's
// verdict is deterministic and testable — the same reason compute-board.mjs
// takes one.
//
//   none      no mark. A fresh run, or one whose heartbeat never ran. NOT a
//             stall: there is no beat to have stopped, and reporting one here
//             would fire on every first tick and train the reader to ignore
//             the line.
//   beating   seen within the interval it promised, plus grace.
//   stopped   a reason was recorded. Reported whatever the age, because a
//             recorded stop IS the end of the run and waiting for it to go
//             stale first would sit on the one report that knows its cause.
//   stale     overdue with no reason recorded. The abrupt death: a crashed
//             harness, a closed terminal, an OOM kill. Readers say exactly
//             that rather than naming a cause they cannot know.
export function assessBeat({ beat, now }) {
  if (!beat) return { kind: "none" };
  // Clamped at zero rather than left signed: a mark from the future is a
  // clock that moved, not a beat that is minus-five-minutes overdue, and a
  // negative age formatted into the line reads as a defect in this code.
  const ageMs = Math.max(0, now - beat.at);
  const intervalMs = beat.interval * 1000;
  const seen = { at: beat.at, ageMs, intervalMs, overdueMs: Math.max(0, ageMs - intervalMs) };
  if (beat.stopped) return { ...seen, kind: "stopped", reason: beat.stopped };
  return { ...seen, kind: ageMs > intervalMs * BEAT_GRACE ? "stale" : "beating", reason: null };
}

// Whether this verdict is something to report. Exported because both readers
// have work to do BEFORE they can render one — the tick runs a gh query for
// the claimed count, the cockpit counts its own cards — and neither should
// pay for that on a healthy run.
export function isStalled(verdict) {
  return verdict.kind === "stopped" || verdict.kind === "stale";
}

// Whole minutes, floored, because the numbers here are tens of minutes to
// hours and a seconds-precise age in a stall line is false precision: the
// mark is written once per hold, so its resolution is minutes anyway.
function mins(ms) {
  return `${Math.floor(ms / 60000)}m`;
}

// The report. Returns null for anything isStalled() rejects, so a caller that
// skipped the predicate cannot print a stall for a healthy run by accident.
//
// What it names is the acceptance criterion itself: a bare "stale" tells the
// maintainer nothing they can act on, so the line carries when the beat was
// last seen, how overdue that is against the interval it PROMISED, whether a
// reason was recorded, and — the part that makes it actionable — what is
// stranded. A dead run leaves its tickets labelled in-progress, and the
// candidate scan excludes that label, so those tickets are invisible to the
// next run's scans and to the maintainer's both.
//
// `claimed` and `supply` are `null` for UNKNOWN, never 0. The two readers
// count them from different sources (a gh query on the claim label; the
// cockpit's own cards) and either source can fail, and "0 claimed" off a
// failed read is the same lie as "supply 0" off one — it says the night cost
// nothing when it may have stranded the whole pool.
export function stallReport(verdict, { claimed, supply }) {
  if (!isStalled(verdict)) return null;
  const n = (v) => (v == null ? "unknown" : String(v));
  // Present tense for the deliberate stop and past for the abrupt one, because
  // that is the actual difference: one run said why it was going, the other
  // was cut off mid-beat and left nothing behind to ask.
  const why = verdict.kind === "stopped"
    ? `stopped deliberately — recorded reason: ${verdict.reason}`
    : "the beat stopped without a recorded reason";
  return `heartbeat STALLED: last beat ${new Date(verdict.at).toISOString()}`
    + ` (${mins(verdict.ageMs)} ago, ${mins(verdict.overdueMs)} past the ${mins(verdict.intervalMs)} interval it promised)`
    + ` — ${why}; ${n(claimed)} ticket(s) claimed and in flight, pool supply ${n(supply)}`;
}
