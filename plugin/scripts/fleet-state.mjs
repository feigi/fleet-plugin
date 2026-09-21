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
import { dirname, join } from "node:path";
import { workspaceDirFromGitCommonDir } from "./git-env.mjs";

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
  const workspace = r.status === 0 ? workspaceDirFromGitCommonDir(r.stdout) : null;
  if (workspace === null) {
    // Announced, never silent: a cwd-relative fallback re-opens exactly the
    // per-worktree split this resolution exists to close.
    console.error(`${name}: WARNING could not resolve --git-common-dir; using cwd-relative .fleet/heartbeat.json`);
    return join(".fleet", "heartbeat.json");
  }
  return join(workspace, ".fleet", "heartbeat.json");
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
  const fresh = { quiet: 0, elapsed: 0, digest: "", rest: {} };
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
  const { quiet, elapsed, digest, ...rest } = parsed;
  return {
    quiet: num(quiet),
    elapsed: num(elapsed),
    digest: typeof digest === "string" ? digest : "",
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
