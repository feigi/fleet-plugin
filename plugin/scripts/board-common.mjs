// What board.mjs's gather side, its server side and its tick loop all use: the
// script's NAME and die(), the one warn-once gate, and the asynchronous child
// read. warnOnce's set is the only mutable state among them, and all three
// sides spend keys on it, so it lives here rather than with any one of them.
import { execFile } from "node:child_process";
import { makeDie } from "./arg.mjs";

export const NAME = "board";
// die() shared with the other fleet scripts — see arg.mjs for the fail-open
// and pipe-safety rationale.
export const die = makeDie(NAME);

// Every warn-once gate in board.mjs routes through here. The stored key is the
// CHANNEL joined to the caller's key, never the caller's key alone: gates share
// key values — ci-salvage-nonzero, ci-salvage-exit0 and ci-parse are all keyed
// on the same PR — so a bare-key Set would let one channel's warning consume
// another's line for that PR, a behaviour change, not a refactor. NUL joins
// them because no channel name holds one, so the joined string splits back to
// exactly one (channel, key) pair whatever the key holds. Returns whether it
// wrote, for a caller that bounds how many keys it spends.
const warnedOnce = new Set();
export function warnOnce(channel, key, msg) {
  const k = `${channel}\0${key}`;
  if (warnedOnce.has(k)) return false;
  warnedOnce.add(k);
  console.error(`${NAME}: ${msg}`);
  return true;
}

// Node's default stdout cap is 1 MiB and a capped child read FAILS past it
// rather than truncating. Here that failure is indistinguishable from an
// unreachable tool: the read degrades to the caller's empty default and the
// cockpit is served a BLANK board at HTTP 200 with only a stderr line — the
// same blank-board symptom the old pipe-buffer limit produced, which the raised
// ceiling moved up rather than removed.
// The ledger is append-mostly and shared by every fleet script, so the ceiling
// arms itself over the life of a run and gives no second warning. Bounded, not
// Infinity: a runaway child should still be stopped rather than allowed to
// exhaust the box. Same headroom staleness.mjs takes, for the same reason.
//
// Both child reads in board-gather.mjs take it. `tryRun` is NOT the single funnel —
// runCiState() spawns its own, because it needs the exit code that a plain
// tryRun discards — so a fix applied only there would leave that one uncapped.
export const READ_OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// Every child read in board-gather.mjs is ASYNCHRONOUS, and that is
// load-bearing rather than stylistic. serve() ticks on a timer inside the same
// process that answers HTTP, so a SYNCHRONOUS read holds the event loop for as
// long as the child runs — measured at 4.72–4.91s for one board — and during
// that window this cockpit answers nothing at all. A relaunch's identity probe
// (PROBE_TIMEOUT_MS, one retry, ~2s in total) landing inside it therefore got
// no answer, read the port as foreign, and started a SECOND cockpit on this
// workspace's state directory: the duplicate the launch handshake and the identity stub exist to prevent,
// reached through timing rather than through a missing handshake. The browser
// page stalled for the same reason and the same duration, every tick.
//
// One thing execFileSync did that this has to keep doing by hand: given no
// `stdio` of its own it re-emits the child's captured stderr onto this
// process's stderr (node's own `process.stderr.write(ret.stderr)`) BEFORE it
// throws. That write is spelled out below, and on both arms, because the sync
// one wrote whether or not it went on to throw.
//
// This never throws; a failure is REPORTED in the record, in the field names
// execFileSync's throw used — `status` for an exit code, `signal` for a kill,
// `code` for a libuv/node fault. That translation is the whole reason this is
// not a bare `promisify(execFile)`: the async error carries the EXIT CODE in
// `err.code` (measured: `3`, a number), where the sync one carried `ENOENT` /
// `ENOBUFS` there and the exit code in `status`, and board-gather.mjs's runCiState()
// reads all three to tell those causes apart.
//
// `opts` joins READ_OPTS for one read, e.g. a `timeout`: a child killed by it
// is reported like any other kill, its `signal` set.
export function execRead(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...READ_OPTS, ...opts }, (err, stdout, stderr) => {
      if (stderr) process.stderr.write(stderr);
      resolve(err
        ? {
          stdout, error: err,
          status: typeof err.code === "number" ? err.code : null,
          code: typeof err.code === "string" ? err.code : null,
          signal: err.signal ?? null,
        }
        : { stdout, error: null, status: 0, code: null, signal: null });
    });
  });
}
