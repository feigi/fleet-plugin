// The pid-stamped lock file both the ledger's write lock and the suite slots
// are built on: one attempt to take it, the dead-holder takeover, and the
// release. Waiting is NOT here — how long to wait, and what to do on
// expiry, is the caller's, because the two callers differ (the ledger waits
// on one lock and dies; the suite wrapper cycles several and exits 75). Each
// caller passes its own die(), so every refusal speaks under its own NAME.
//
// `<lock>` is created O_EXCL and holds its owner's pid. Creating it and
// writing the pid are two steps, so a waiter can read an empty or partial
// lock in between: anything that is not a canonical positive integer counts
// as a LIVE holder — keep waiting, and never hand it to process.kill, where
// NaN is a TypeError crash rather than a wait. That empty or partial lock
// never clears on its own, either: nothing revisits and finishes writing it
// — the writer that would have finished died before the second step. Same
// permanent wedge as a leftover reap lock below, same fix: the operator
// removes it by hand once nothing is writing.
//
// A holder that died without releasing — SIGKILL always, and so does any
// signal its process leaves unhandled (SIGQUIT, SIGABRT, a segfault: only a
// normal exit and the signals a caller handles run the `exit` event that
// releases it) — is taken over, but only under a second O_EXCL lock,
// `<lock>.reap`, and only after RE-READING the lock under it, finding
// the same dead pid, and RE-CHECKING that pid is still dead. Unlink-then-
// create, or a bare rename, lets two waiters that both saw the dead pid each
// remove the other's FRESH lock and write at once; the re-read is what makes
// the takeover safe. The re-check narrows the one window the re-read leaves,
// and the order the two run in is what narrows it: isDead(deadPid)
// runs before the re-read, not after, so a live writer that takes the lock in
// the gap between them is caught by the read that follows, not hidden behind
// one taken before it arrived. Read first, and a recycled pid that came back
// to life in that same gap would still read back as itself and still check
// dead — the order this replaces would delete that live holder's fresh lock. A
// recycled pid that became a new writer this same way — dead holder's lock
// reaped by someone else, then re-created by the new owner of that very pid —
// still writes the same content and would still pass the re-read alone, but
// the isDead() ahead of it now catches that writer live, before the read ever
// runs. Only that exact pid reused a second time, inside this narrower gap,
// can still slip through. Under the reap lock no other waiter can replace the
// lock's content outside that gap, so a pid still dead immediately before the
// read that follows it is the dead holder, and a live one is left alone to be
// waited on like any live holder. A reap lock is held for one liveness check,
// one read and one unlink, and one left behind by any of those same abrupt
// deaths in that window is deliberately NOT reclaimed: waiters time out naming
// the holder, and the operator removes it. Fail closed.
//
// A dead holder whose pid was recycled reads as live until the timeout.
// Accepted: an mtime/age heuristic instead would take over a live writer on a
// slow disk, which is the row loss the ledger's lock exists to prevent.
//
// A live-looking holder can also be a zombie: a pid whose process exited but
// whose parent never `wait()`-ed on it. The OS keeps that pid reserved until
// reaped, so `process.kill(pid, 0)` still succeeds and isDead() reads it as
// alive — but unlike the two wedges above, that clears on its own once the
// pid is reaped (the parent's own exit is normally enough to trigger this),
// and the next writer's death check then takes the lock over like any other
// dead holder. No hand removal needed.

import { readFileSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { isDead } from "./proc.mjs";

export const parsePid = (text) => (/^[1-9][0-9]*$/.test(text) ? Number(text) : null);

export const reapPathOf = (lock) => `${lock}.reap`;

// null when there is no lock to read — it was released between a failed
// create and this read, and the next create attempt is the right response.
export function readLock(lock, die) {
  try {
    return readFileSync(lock, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    die(`cannot read ${lock}: ${e.message}`);
  }
}

// true when the takeover ran (whatever it found under the reap lock), so the
// caller retries the create at once; false when another waiter holds the
// reap lock, so the caller waits like any other contended lock.
export function reapDeadHolder(lock, deadPid, die) {
  const reap = reapPathOf(lock);
  let fd;
  try {
    fd = openSync(reap, "wx");
  } catch (e) {
    if (e.code === "EEXIST") return false;
    die(`cannot create ${reap}: ${e.message}`);
  }
  try {
    closeSync(fd);
    // Dead again, not just when the caller looked: that pid may have been
    // reused since, so isDead runs first, fresh, right here — before the
    // exact-match re-read, not after it. Exact match only: a waiter that
    // got here first may already have reaped the dead lock and taken a
    // fresh one of its own.
    if (isDead(deadPid) && readLock(lock, die) === String(deadPid)) {
      // Already gone is already the outcome this call wants: an operator
      // clearing a wedged lock by hand between the read above and here must
      // not turn our own cleanup into an uncaught crash.
      try {
        unlinkSync(lock);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  } finally {
    unlinkSync(reap);
  }
  return true;
}

// One attempt, never a wait. Answers with `state`:
//   "taken"    — the lock is ours, stamped with this process's pid.
//   "vanished" — it existed at the create and was gone at the read: released
//                in between, so the next create attempt is the right response.
//   "reaped"   — its holder was dead and the takeover ran, so create again
//                at once.
//   "held"     — somebody else's. `holder` is the file's text as read, `pid`
//                its parse (null when it is not a canonical pid) and `dead`
//                whether that pid is gone while the takeover could not run —
//                another waiter holds the reap lock.
export function attemptLock(lock, die) {
  let fd = null;
  try {
    fd = openSync(lock, "wx");
  } catch (e) {
    if (e.code !== "EEXIST") die(`cannot create ${lock}: ${e.message}`);
  }
  if (fd !== null) {
    try {
      writeSync(fd, String(process.pid));
    } catch (e) {
      // Ours, and empty or partial: every waiter reads it as live, and
      // releaseLockFile() will not match it, so it goes now or never.
      closeSync(fd);
      unlinkSync(lock);
      die(`cannot write ${lock}: ${e.message}`);
    }
    closeSync(fd);
    return { state: "taken" };
  }
  const holder = readLock(lock, die);
  if (holder === null) return { state: "vanished" };
  const pid = parsePid(holder);
  const dead = pid !== null && isDead(pid);
  if (dead && reapDeadHolder(lock, pid, die)) return { state: "reaped" };
  return { state: "held", holder, pid, dead };
}

// Removes `lock` only while it still names this process. Nothing to release,
// or nothing this process can do about it on its way out: exit handlers cannot
// fail usefully.
export function releaseLockFile(lock) {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {
    // see above
  }
}
