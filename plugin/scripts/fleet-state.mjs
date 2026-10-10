// The heartbeat's shared state file, owned jointly by fleet-tick.mjs,
// fleet-heartbeat.mjs and ledger.mjs rotate — so the path and the file's shape
// live here rather than in spellings that drift. Same rule arg.mjs states for
// the digits guard: what travels between scripts is the rule, never a copy of
// it.
//
// KEY OWNERSHIP, which is the whole reason several scripts can share one file
// without a lock:
//
//   quiet    fleet-tick only. Consecutive ticks that asked the controller for
//            nothing. Drives the back-off interval.
//   digest   fleet-tick only. The last tick's own output, so an unchanged
//            quiet tick can fold to one line instead of three.
//   elapsed  fleet-heartbeat only. Seconds already held toward the current
//            interval, because no harness lets one command block long enough
//            to serve a twenty-minute interval in a single call.
//   beat     fleet-heartbeat only. The liveness mark: when the beat
//            was last seen, the interval that was in effect when it was, and
//            a deliberate stop's reason if one was recorded. Written by the
//            heartbeat and by nothing else — fleet-tick READS it at the start
//            of a run and the cockpit READS it every tick, and a key two
//            scripts wrote would need the lock this file exists to avoid.
//   ticked   fleet-tick only. When fleet-tick itself last ran, no interval
//            attached — fleet-tick fires on live edges, not a schedule, so it
//            has no promise to be judged against the way `beat` does. Exists
//            because `beat` is only written when the queue drains ("beat when
//            there is nothing to do" — SKILL.md); a busy stretch can run for
//            longer than `beat`'s own grace window while fleet-tick itself
//            keeps firing on every completion, and without this key that
//            healthy busy run reads as a dead one the moment the OLD beat
//            ages past the interval it recorded before the stretch started.
//   controller  ledger.mjs rotate only. {pid, lstart, prior, at}: the omp
//            process that owns this run, its start time, the verdict rotate
//            judged on the record it replaced (dead, ancestor or none), and
//            when rotate wrote it — a mark older than `at` is the previous
//            run's. Removed, not left stale, by a rotate that finds no omp
//            ancestor.
//
// One writer per key. A key two scripts wrote would need locking to be
// correct, and none of them is in a position to hold one. That holds per key,
// not per write: a writer carries every key it does not own from the view it
// read, so a read that lands before another script's write and a write that
// lands after it put the older value back. The windows are the gap between a
// script's own read and its own write, and the next write of that key
// corrects it, but until then a stale `controller` can be judged by a rotate.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { judgeRecord, ProcUnreadable } from "./proc.mjs";

// The filename, in one place, because the liveness mark gave this file a SECOND resolver.
// board.mjs already resolves the run's workspace for itself — it has to, since
// its own `canonicalise` opt-in is what keeps a symlinked route from deriving
// a second port — so it reaches the state file by joining onto the
// `.fleet` directory it already holds rather than resolving it again.
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
// worktree happened to call last. fleet-dir.mjs's fleetFile() resolves it the
// way it resolves the ledger, scrubbed and bounded: a `git` that never answers
// is killed rather than holding the beat. Only the warning and the fallback
// below are this caller's own.
export function statePath(name) {
  try {
    return stateFileIn(fleetFile(null));
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    // Announced, never silent: a cwd-relative fallback re-opens exactly the
    // per-worktree split this resolution exists to close.
    console.error(`${name}: WARNING ${e.message}; using cwd-relative .fleet/heartbeat.json`);
    return stateFileIn(".fleet");
  }
}

// A plain JSON object: not null, not an array, not a scalar.
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A recorded `prior` is one of these; anything else degrades to "none".
const PRIORS = ["dead", "ancestor", "none"];

// An unreadable or corrupt state file is NOT fatal, and the direction of the
// failure is the argument: a missing streak reads as quiet=0, which is the BASE
// interval — more frequent level checks, never fewer. Dying instead would stop
// the heartbeat, and a stopped heartbeat is the defect.
//
// Absent is the ONLY silent case, because it is the only one that is not a
// fault: a fresh run legitimately has no file yet. An unreadable file and a
// corrupt one are both announced — each discards real state, and silence about
// a degraded read is the failure class this whole ticket exists to close. Both
// come back flagged `degraded`, for the one caller that must not read them as
// a file with nothing in it.
export function readState(path, name) {
  // `beat: null` is the absent MARK, and it is not the same value as a mark
  // whose fields are zero: nothing has been seen beating, so there is nothing
  // to judge and nothing to report. A zeroed mark would date the beat to the
  // epoch and read as decades overdue on a run that has simply not started
  // one — the cry-wolf direction this key must never fail in.
  const fresh = { quiet: 0, elapsed: 0, digest: "", beat: null, ticked: null, controller: null, rest: {} };
  // The same state, flagged: the file EXISTS and could not be used. A caller
  // that acts on the absence of a record — ledger.mjs rotate — must tell this
  // from `fresh`, which is a run that has simply not written one yet.
  const degraded = { ...fresh, degraded: true };
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
      return degraded;
    }
    return fresh;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`${name}: WARNING ${path} is not JSON (${e.message}) — restarting at the base interval`);
    return degraded;
  }
  if (!isRecord(parsed)) {
    console.error(`${name}: WARNING ${path} is not an object — restarting at the base interval`);
    return degraded;
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
  // mark — dropping the whole mark over one corrupt field would blind
  // readers to `at`/`interval`, which ARE still trustworthy. A junk reason
  // degrades to `""`, the same value an ordinary beat carries; assessBeat()
  // only reads it as "no reason recorded" once the mark ALSO goes stale by
  // age — until then it is judged on freshness alone, same as any other
  // beat. A hand-edited or corrupted `stopped` is therefore not announced as
  // a stop AT ALL while the mark is still fresh; it is announced, correctly,
  // once the silence itself earns a verdict.
  const mark = (v) => {
    if (!isRecord(v)) return null;
    const at = num(v.at), interval = num(v.interval);
    if (at === 0 || interval === 0) return null;
    return { at, interval, stopped: typeof v.stopped === "string" ? v.stopped : "" };
  };
  // `ticked` carries no interval — fleet-tick has no promise to fail, only an
  // occurrence — so it is a mark of one field, valid or absent, same "never
  // zero" rule as `mark` above for the same cry-wolf reason.
  const tick = (v) => {
    if (!isRecord(v)) return null;
    const at = num(v.at);
    return at === 0 ? null : { at };
  };
  // `controller` is validated as a unit for the mark's reason: a pid without
  // the start time it was recorded with cannot be told from a reused pid. A
  // pid outside the range a process id can take is no record either, since
  // no process could ever answer for it. `prior` degrades like `stopped`
  // does: a junk verdict proves nothing, so it reads as "none", and the
  // record around it still names a controller to judge. `at` degrades the
  // same way, to null: the record still names a controller, and only when it
  // was written is unknown.
  const ctl = (v) => {
    if (!isRecord(v)) return null;
    if (!Number.isInteger(v.pid) || v.pid < 1 || v.pid > 0x7fffffff) return null;
    if (typeof v.lstart !== "string" || v.lstart === "") return null;
    return {
      pid: v.pid,
      lstart: v.lstart,
      prior: PRIORS.includes(v.prior) ? v.prior : "none",
      at: Number.isInteger(v.at) && v.at > 0 ? v.at : null,
    };
  };
  const { quiet, elapsed, digest, beat, ticked, controller, ...rest } = parsed;
  return {
    quiet: num(quiet),
    elapsed: num(elapsed),
    digest: typeof digest === "string" ? digest : "",
    beat: mark(beat),
    ticked: tick(ticked),
    controller: ctl(controller),
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
//
// The write is a sibling temp file renamed over the target, ledger.mjs save()'s
// convention, because the readers do not hold still for it. A plain
// writeFileSync truncates and then writes, and readState() maps the empty or
// half-written file a reader can land on to the fresh, no-mark state on
// purpose — so a reader racing a live beat read "no mark", and ledger.mjs
// rotate, which with no controller record refuses only while a mark is
// beating, moved a live controller's ledger. rename is atomic on POSIX: a
// reader sees the whole old file or the whole new one. The temp name carries
// the pid for the reason ledger.mjs gives: several scripts write this file,
// and a shared temp name lets one rename another's out from under it. A temp
// that never made it into place is removed rather than left to accumulate,
// one per failed invocation, beside the file it failed to replace.
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
    // Same reason, same shape: fleet-heartbeat patches `elapsed`/`beat` on
    // every hold and would otherwise erase fleet-tick's `ticked` the first
    // time a heartbeat lands after a busy stretch.
    ...(prev.ticked ? { ticked: prev.ticked } : {}),
    // And again for ledger.mjs rotate's `controller`, which both scripts
    // above would otherwise erase on their next write. A patch REMOVES a key
    // by naming it with the value `undefined`, which JSON.stringify drops —
    // the way rotate retires a record no omp ancestor replaces.
    ...(prev.controller ? { controller: prev.controller } : {}),
    ...patch,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch (e) {
    // Best-effort and never fatal: a cleanup that threw would turn a reported,
    // survived write failure into the crash the comment above rules out.
    try { rmSync(tmp, { force: true }); } catch {}
    console.error(`${name}: WARNING could not write ${path} (${e.message}) — back-off progress will not persist`);
    return false;
  }
}

// --------------------------------------------------------------------------
// READING THE MARK. The rule, and the wording, in one place.
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

// fleet-heartbeat.mjs's --ceiling default (1200s = 20 minutes), defined once
// here and imported there: every script that reads or writes the heartbeat
// file already imports this module, and a magic "1200" typed twice is exactly
// the drift the module header's "never a copy of it" rule exists to close.
// It doubles as the freshness window for `ticked` below: fleet-tick's own
// invocations carry no promised interval, so they are judged against the
// worst-case gap this design ever tolerates when only the heartbeat is
// beating, times the same grace multiplier as `beat`.
export const DEFAULT_CEILING_S = 1200;

// What the mark says, as a value. `now` is a parameter so every caller's
// verdict is deterministic and testable — the same reason compute-board.mjs
// takes one.
//
//   none      no mark. A fresh run, or one whose heartbeat never ran. NOT a
//             stall: there is no beat to have stopped, and reporting one here
//             would fire on every first tick and train the reader to ignore
//             the line.
//   beating   seen within the interval it promised, plus grace — OR a recent
//             `ticked` covers for it. `beat` is only refreshed when the queue
//             drains (SKILL.md: "beat when there is nothing to do"), so a
//             busy stretch that outlasts `beat`'s own grace window is not a dead
//             run; fleet-tick's own edge-triggered invocations are the other
//             liveness signal for exactly that case.
//   stopped   a reason was recorded. Reported whatever the age, because a
//             recorded stop IS the end of the run and waiting for it to go
//             stale first would sit on the one report that knows its cause.
//   stale     overdue with no reason recorded AND no recent tick either. The
//             abrupt death: a crashed harness, a closed terminal, an OOM
//             kill. Readers say exactly that rather than naming a cause they
//             cannot know.
export function assessBeat({ beat, ticked, now }) {
  if (!beat) return { kind: "none" };
  // Clamped at zero rather than left signed: a mark from the future is a
  // clock that moved, not a beat that is minus-five-minutes overdue, and a
  // negative age formatted into the line reads as a defect in this code.
  const ageMs = Math.max(0, now - beat.at);
  const intervalMs = beat.interval * 1000;
  const seen = { at: beat.at, ageMs, intervalMs, overdueMs: Math.max(0, ageMs - intervalMs) };
  if (beat.stopped) return { ...seen, kind: "stopped", reason: beat.stopped };
  return { ...seen, kind: now > stallsAt({ beat, ticked }) ? "stale" : "beating", reason: null };
}

// The instant an unstopped mark turns `stale`: past `beat`'s own interval
// plus grace AND past a tick's ceiling window plus grace, whichever ends
// later. An absent `ticked` — a state file fleet-tick has not yet written to
// — contributes nothing, which is `beat` alone deciding it. A present one
// only ever postpones the stall; it can never manufacture a stale verdict
// `beat` alone would not have reached. Exported for the readers that must
// say WHEN a beating mark would stop counting, not only whether it has.
export function stallsAt({ beat, ticked }) {
  const beatEnds = beat.at + beat.interval * 1000 * BEAT_GRACE;
  return ticked ? Math.max(beatEnds, ticked.at + DEFAULT_CEILING_S * 1000 * BEAT_GRACE) : beatEnds;
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
// mark is written once per hold, so its resolution is minutes anyway. That
// holds for production (--base 300, --ceiling 1200 — SKILL.md's only
// documented values) but not for every value the CLI guard actually accepts:
// fleet-heartbeat.mjs's own guard refuses `--ceiling < --base` the same way
// this file refuses other invalid shapes, and mirroring that refusal onto
// sub-60s `--base`/`--ceiling` was the first fix tried for the "0m" floor —
// until the heartbeat's own test suite turned out to lean on 2s/3s/8s/9s/64s intervals
// throughout, deliberately, to keep its real `Atomics.wait` holds fast. A
// CLI-level refusal would force that whole suite onto minute-plus real
// holds for no behavioural gain, so the fix lives here instead: a value
// under a minute is still a real value, not an invalid one, and flooring it
// to "0m" is what read as a division-by-zero defect, not the sub-minute
// input itself.
//
// That fix only moved the floor for values UNDER 60s. A 60-119s value still
// fell on the whole-minutes branch, so a 90-119s interval floors to "1m"
// while its own overdue remainder (usually still under 60s) prints in
// seconds — the line's three numbers stop reconciling the moment any of
// them lands in that band: age=100s, interval=90s reads "1m ago ... 10s
// past the 1m interval", and 1m minus 1m is 0, not 10s. The bug was never
// the floor itself, it was flooring each of the three numbers to its OWN
// unit independently — three independent floors of one piece of exact
// arithmetic (overdueMs = ageMs - intervalMs, held exactly by assessBeat)
// do not have to agree with each other once any one of them crosses a unit
// boundary the others did not. Reporting the full `Xm Ys` breakdown, and
// dropping whichever half is zero, fixes that: the same seconds total
// feeds every one of the three numbers, so minutes-times-60-plus-seconds
// inverts back to the exact millisecond figure every time, which is what
// makes it impossible for the three to imply two different remainders for
// the one subtraction that ties them together. It also happens to leave
// every value that is an exact multiple of a minute — the production case
// above, and every value already pinned byte-for-byte — rendering exactly
// as it did before, because the seconds half is zero and gets dropped.
function mins(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m${s}s`;
}

// Whose stall a reader sees, off the controller record — the mark says only
// that the beat stopped, never whether the run did. No record: unknown, and
// the report keeps the wording it had before there was one.
//
// A mark older than the record's `at` was left by the run BEFORE the one
// that wrote the record: rotate replaced the record after that run's last
// beat and tick. That is a run's first tick, and by then the record names
// this run's own live controller, so judging it would call every previous
// run alive. That stall reads the verdict rotate reached on the record it
// replaced, `prior`: dead is a controller gone whose claims this run resumes,
// ancestor is this same session's earlier run and so alive, none is unknown.
// A mark written since the record — any later tick — is the recorded
// controller's own, so the record itself is judged, through proc.mjs: dead or
// a reused pid is gone and the NEXT run resumes; alive, or an ancestor of the
// reader, is alive. A record with no `at` cannot place the mark and is
// judged too.
//
// `judge` is replaceable for the same reason proc.mjs's process source is: a
// reader under a live omp session would otherwise find that session. A
// process table that cannot be read leaves the stall unattributed, said on
// stderr, rather than calling a controller nobody could judge dead or alive.
export const NO_OWNER = Object.freeze({ kind: "none" });
export function stallOwner({ controller, beat, ticked }, name, judge = judgeRecord) {
  if (!controller) return NO_OWNER;
  const before = (mark) => mark === null || mark.at < controller.at;
  if (controller.at !== null && before(beat) && before(ticked)) {
    if (controller.prior === "dead") return { kind: "gone", resumes: "this run" };
    if (controller.prior === "ancestor") return { kind: "alive", pid: null };
    return NO_OWNER;
  }
  let verdict;
  try {
    verdict = judge(controller);
  } catch (e) {
    if (!(e instanceof ProcUnreadable)) throw e;
    console.error(`${name}: WARNING ${e.message} — the recorded controller pid ${controller.pid} cannot be judged, so the stall report names no controller`);
    return NO_OWNER;
  }
  if (verdict === "dead") return { kind: "gone", resumes: "the next run" };
  if (verdict === "alive" || verdict === "ancestor") return { kind: "alive", pid: controller.pid };
  return NO_OWNER;
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
// `owner` is stallOwner()'s answer and leads the line, because it is what
// the maintainer acts on: a controller alive is a run that stopped beating
// and kept going, never one to restart; a controller gone is a run whose
// claims without a PR the next phase 0 resumes and whose open PRs its fold-in
// queues. No owner keeps the wording the report had before the record existed.
//
// `claimed` and `supply` are `null` for UNKNOWN, never 0. The two readers
// count them from different sources (a gh query on the claim label; the
// cockpit's own cards) and either source can fail, and "0 claimed" off a
// failed read is the same lie as "supply 0" off one — it says the night cost
// nothing when it may have stranded the whole pool.
export function stallReport(verdict, { claimed, supply, owner = NO_OWNER }) {
  if (!isStalled(verdict)) return null;
  const n = (v) => (v == null ? "unknown" : String(v));
  // Present tense for the deliberate stop and past for the abrupt one, because
  // that is the actual difference: one run said why it was going, the other
  // was cut off mid-beat and left nothing behind to ask.
  const why = verdict.kind === "stopped"
    ? `stopped deliberately — recorded reason: ${verdict.reason}`
    : "the beat stopped without a recorded reason";
  const head = owner.kind === "alive"
    ? `heartbeat not beating, controller alive (${owner.pid === null ? "this session's earlier run" : `pid ${owner.pid}`})`
    : owner.kind === "gone" ? "heartbeat STALLED, controller gone" : "heartbeat STALLED";
  const tail = owner.kind === "gone"
    ? `; ${owner.resumes} resumes its claims without a PR, and its open PRs return through the fold-in`
    : "";
  return `${head}: last beat ${new Date(verdict.at).toISOString()}`
    + ` (${mins(verdict.ageMs)} ago, ${mins(verdict.overdueMs)} past the ${mins(verdict.intervalMs)} interval it promised)`
    + ` — ${why}; ${n(claimed)} ticket(s) claimed and in flight, pool supply ${n(supply)}${tail}`;
}
