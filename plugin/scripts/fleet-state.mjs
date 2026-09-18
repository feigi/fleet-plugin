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
//
// One writer per key. A key both scripts wrote would need locking to be
// correct, and neither script is in a position to hold one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

// There is ONE heartbeat per run and its state lives in the main checkout.
// Members run from their own worktrees, where a cwd-relative `.fleet/` does not
// exist, so a cwd-relative path would give every worktree a private back-off
// streak and a private elapsed total — the run's beat would be whichever
// worktree happened to call last.
//
// This is ledger.mjs's defaultLedgerPath() resolution applied to a second file
// for the same reason (there, a cwd-local ledger silently degraded the
// duplicate-filing guard). If a third file ever needs it, the resolution itself
// should move here and ledger.mjs should import it; two callers did not justify
// reaching into a 982-line module and re-testing it.
export function statePath(name) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) {
    // Announced, never silent: a cwd-relative fallback re-opens exactly the
    // per-worktree split this resolution exists to close.
    console.error(`${name}: WARNING could not resolve --git-common-dir; using cwd-relative .fleet/heartbeat.json`);
    return join(".fleet", "heartbeat.json");
  }
  return join(dirname(resolve(r.stdout.trim())), ".fleet", "heartbeat.json");
}

// An unreadable or corrupt state file is NOT fatal, and the direction of the
// failure is the argument: a missing streak reads as quiet=0, which is the BASE
// interval — more frequent level checks, never fewer. Dying instead would stop
// the heartbeat, and a stopped heartbeat is the defect.
//
// Absent is silent, because a fresh run legitimately has no file yet. Corrupt
// is announced, because that one is a fault, and silence about a degraded read
// is the failure class this whole ticket exists to close.
export function readState(path, name) {
  const fresh = { quiet: 0, elapsed: 0, digest: "", rest: {} };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
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
  return {
    quiet: num(parsed.quiet),
    elapsed: num(parsed.elapsed),
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
    rest: parsed,
  };
}

// Patch, never replace. Each script writes only the keys it owns, and rewriting
// the whole object from one script's view would drop the other's — a dropped
// `digest` reads as "the output changed" on the next tick, which un-folds a
// quiet night and silently undoes the cheap-per-wake half of the design.
//
// A failed write is reported and survived for the same reason a failed read is:
// without persistence the interval restarts every hold, which beats more often,
// not less.
export function writeState(path, name, prev, patch) {
  const next = { ...(prev.rest ?? {}), ...patch };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    console.error(`${name}: WARNING could not write ${path} (${e.message}) — back-off progress will not persist`);
  }
}
