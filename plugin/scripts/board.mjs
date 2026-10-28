#!/usr/bin/env node
// The cockpit's entry point, and only its composition. `build` has gather()
// (board-gather.mjs) read the raw inputs, hands them to the pure computeBoard()
// and prints the board model as JSON to stdout. `serve` has serve()
// (board-server.mjs) own the listener and the cockpit's identity, and runs the
// tick loop that this file hands it: gather() -> computeBoard() -> an atomic
// write of .fleet/board.json.
// The board never depends on the controller feeding it.
//
// What stays here is what neither half owns: argv parsing, the build/serve
// dispatch, the tick loop with its overlap guard and per-tick spend source, and
// the fault path.

import { writeFileSync, renameSync, writeSync } from "node:fs";
import { defineFlags } from "./arg.mjs";
import { NAME, die, warnOnce } from "./board-common.mjs";
import { gather, receiptSpendDir } from "./board-gather.mjs";
import { serve, resolveCockpitInstance, cockpitWorkspace } from "./board-server.mjs";
// The heartbeat's liveness mark path, taken from the module that owns the
// filename rather than spelling `heartbeat.json` a second time. The PATH
// still comes from resolveCockpitInstance() (board-server.mjs), not from
// statePath(): the workspace is already resolved once per launch there, with
// the `canonicalise` opt-in only that caller takes, and a second resolution
// could answer differently.
import { stateFileIn } from "./fleet-state.mjs";
import { cockpitLifetime, controllerVerdict } from "./cockpit-lifetime.mjs";
import { isCLI } from "./is-cli.mjs";
import { join } from "node:path";
import { inspect } from "node:util";

// arg()/has() shared with the other fleet scripts — see arg.mjs for
// the fail-open and pipe-safety rationale.
const { arg, has, sweep, stray } = defineFlags(die, {
  flags: {
    ledger: "value",
    prev: "value",
    port: "value",
    interval: "value",
    "spend-since": "value",
    "spend-dir": "value",
    open: "bool",
  },
  positionals: ["build", "serve"],
});
// `ledger`/`prev`/`spend-since`/`port`/`interval` are all read with `||`/`??`
// fallbacks, so a trailing flag previously substituted a default in total
// silence — `--spend-since` with nothing after it silently widened the spend
// panel to all-time instead of the requested window, and `--ledger` with
// nothing after it silently read the DEFAULT ledger file instead of the one
// asked for.
//
// A guard used to fire only where the flag was actually READ, and that
// was not every subcommand — `port` and `open` are USED in serve() alone, so
// `build --port` (trailing), `build --port abc` and `build --open=1` were all
// IGNORED at exit 0 rather than refused. main() now reads --port and
// --open once, ahead of the build/serve dispatch, so both malformed
// spellings refuse on EVERY subcommand — build just discards the (validated)
// return value, since nothing on that path has a server to bind or a browser
// to open. A WELL-FORMED --port/--open on build still does nothing there,
// same as before this fix: the guard checks the flag's SHAPE, not whether
// this subcommand has a use for it. `ledger`/`prev`/`spend-since`/`interval`
// were already read on the build path and already refused there.
// That last claim held for `ledger`/`spend-since`/`interval`, not for
// `prev` — `prev` was read on `build` alone, and serve() never read it at
// all. Hoisted in main() below, next to the --port/--open reads.


// `Number(x) || default` treated a garbage --port/--interval exactly
// like an absent one — "abc" is NaN, NaN is falsy, so it silently became the
// default with no refusal. Same silent-fallback class as arg()'s own comment
// above and the --spend-since guard. main() is the only caller of either and
// hands gather() and serve() the resolved value, so neither guard runs on an
// already-typed value a caller passed in-process.
function argPort() {
  const raw = arg("port");
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) die(`--port wants an integer 0-65535, got ${raw}`);
  return n; // 0 is a real value — listen(0) binds an ephemeral port
}
// Bounded at BOTH ends, like argPort(). The ceiling is setInterval's 32-bit
// millisecond delay: hand it more and Node clamps the delay to 1ms with only a
// TimeoutOverflowWarning, so `--interval 3000000` (34 days) turns the rebuild
// loop into a spin loop shelling out to gh hundreds of times a second — the
// inverse of what was asked, announced by nothing the board prints.
// 2147483647ms / 1000, floored, is the last WHOLE second that fits;
// the ceiling is a hair under that in fractional seconds, which nobody types.
function argInterval() {
  const raw = arg("interval");
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 2147483) die(`--interval wants seconds > 0 and <= 2147483, got ${raw}`);
  return n;
}

// Operator input at a trust boundary, so it fails loud. `Number(x) || null`
// silently turned every bad value into "no filter at all": a typo, or the
// natural mistake of passing seconds instead of milliseconds, produced a panel
// that rendered confidently over the WHOLE session while the operator believed
// it was scoped to one run. That is the same silent-zero failure the comment
// on gatherSpend describes; an earlier pass removed the `|| null` default but
// left the footgun, and the guard below is what actually closes it.
//
// Gate on PRESENCE, not on the value: `arg()` yields undefined for a trailing
// `--spend-since`, and `sinceRaw == null` read that as "flag absent", so the
// guard never fired. And on RANGE, not just finiteness: a seconds-magnitude
// epoch (~1.7e9) is finite, so the very mistake named above sailed through,
// counted every agent, and shipped its own bogus value into board.json's
// `since`. 1e12 ms is 2001-09-09, below any real run; a future boundary
// matches nothing at all.
//
// Pulled out of gather() into its own function, like argPort()/
// argInterval() above, so main() can call it too (below) ahead of the
// build/serve dispatch and ahead of both branches' stray() call — before
// this fix the read sat inline inside gather(), below every stray() call on
// every path that reaches it, so a trailing `--spend-since` ahead of a stray
// positional refused under stray()'s generic wording instead of this one.
// main() is now its only caller: gather() takes the resolved value as
// `spendSince`.
function argSpendSince() {
  const sinceRaw = arg("spend-since");
  if (sinceRaw === null) return null;
  const sinceMs = Number(sinceRaw);
  if (!Number.isFinite(sinceMs) || sinceMs < 1e12 || sinceMs > Date.now()) {
    die(`--spend-since wants epoch milliseconds, got ${sinceRaw}`);
  }
  return sinceMs;
}

// The operator's override for the session the phase-0 receipt records
// (receiptSpendDir() in board-gather.mjs). A PATH, so there is no range or
// magnitude to check the way
// --spend-since and --interval have one — every malformed SHAPE this flag can
// take is already arg()'s: a trailing `--spend-dir`, an empty or whitespace
// value, a following flag eaten as the value, and the `--spend-dir=` form.
// What this read buys is that all four refuse under THIS flag's name instead
// of stray()'s generic "unexpected argument", and they do so before gather()
// shells out to anything — which is what declaring it in the flag table above
// and calling it from main() below are for, exactly as for
// --spend-since. A named read rather than a bare arg() at each call site so
// the flag is spelled in one place and this reasoning has a home.
//
// Existence is deliberately NOT checked, and refusing an absent directory
// would refuse the one invocation this flag exists for: a session's own
// directory does not exist until that session's first agent spawns, and the
// cockpit launches in run-team phase 0, BEFORE that. An
// operator pinning THIS run's transcripts therefore names a directory that is
// not there yet, and it appears seconds later. A directory that never appears
// degrades per tick through gatherSpend's catch and hides the panel; it never
// renders zeroes and never dies.
//
// `null` for an absent flag, like argPort()/argInterval()/argSpendSince().
function argSpendDir() {
  return arg("spend-dir");
}

// What gather() reads the spend panel from: the operator's --spend-dir, else
// the session the phase-0 receipt in `stateDir` records, read on every call
// and never held. `spendDirExplicit` is decided here, beside the choice it
// describes, so build and every serve tick cannot tell the two apart
// differently.
function spendSource(spendDir, stateDir) {
  return spendDir != null
    ? { spendDir, spendDirExplicit: true }
    : { spendDir: receiptSpendDir(stateDir), spendDirExplicit: false };
}

async function main() {
  // A misspelled flag was never looked for, so `serve --prot 9000`
  // served on the default 8123 in silence. In main(), not at module scope:
  // the test files for this module import from it, so a
  // module-scope sweep would read the TEST RUNNER's argv.
  //
  // One set for both subcommands, deliberately. `--port`/`--open` are USED
  // only by serve() and `--prev` only by build, so a WELL-FORMED `build
  // --port 5` is accepted and its value simply unused — narrowing the set per
  // subcommand would close that too, but that is a larger design question
  // (per-subcommand arg schemas) this ticket does not take; refusing a flag
  // this file does accept somewhere is not this ticket's business. What
  // build no longer does is stay silent on a MALFORMED one — see the argPort()/has("open") note below.
  //
  // Above `cmd`, so `board.mjs --prot 9000` names the stray rather than
  // printing the usage line for a missing subcommand. `build`/`serve` carry
  // no `--` and are never the sweep's business.
  sweep();
  const cmd = process.argv[2];
  // No default applied here any more — `build` and `serve` now each
  // apply their own. `build` has no workspace instance to default against
  // (no state directory, no board), so it keeps today's cwd-relative literal
  // below. `serve` defaults against `resolveCockpitInstance()`'s stateDir
  // instead, so an absent --ledger still points at the SAME workspace the
  // served state directory does, rather than the caller's raw cwd.
  const ledgerFile = arg("ledger");

  // argPort()/has("open") used to run only inside serve(), so `build
  // --port abc` and `build --open=1` were accepted and silently ignored — the
  // malformed spellings these guards exist to refuse never ran on that path.
  // Called here, once, ahead of the build/serve dispatch (and ahead of both
  // branches' own stray() call, so a malformed value still wins the specific
  // wording over stray()'s generic one, same ordering rule arg.mjs documents
  // for every other value guard in this file). Ahead of the `cmd` check too,
  // so `board.mjs --port abc` with NO subcommand names the flag rather than
  // falling through to the usage die below — the same precedence the
  // sweep note above claims for a stray, now true of these two guards as
  // well. Both orderings are pinned in the board tests; before this fix the
  // no-subcommand shape printed the usage line (measured). The values reach
  // serve() alone: build has no server to bind or browser to open, so a
  // WELL-FORMED --port/--open still does nothing there, exactly like before
  // this fix — only the malformed spellings now refuse. serve() reads no argv
  // of its own; these reads are the only ones.
  // --prev: unlike --port/--open (never read on `build` before they were hoisted) or
  // --ledger/--spend-since/--interval (already read on `build`, per the
  // header comment above), --prev was read on exactly one subcommand and it
  // was the wrong one to skip: `arg("prev")` sat inside the `build` branch
  // alone, and serve()'s own signature carries no `prev` parameter at all —
  // so `serve --prev`, `serve --prev=x` and `serve --prev --port 9000` all
  // fell through with no guard ever firing (measured), the last one blaming
  // --port's innocent value once stray() reached it instead. Hoisted here
  // for the same reason argPort()/has("open") were hoisted below it — ahead
  // of the dispatch and both branches' stray() calls — and ahead of argPort()
  // itself so a caller who gets BOTH flags wrong at once (`--port --prev`,
  // each trailing with no value) still hears about --prev specifically,
  // rather than whichever guard happens to run first. The old in-branch read
  // inside `build` is gone; this is now the only read, and its value reaches
  // gather() exactly as before — discarded on serve, same as --port/--open
  // are discarded on build.
  const prevFile = arg("prev");
  const port = argPort();
  const open = has("open");

  // Same fail-open shape as --port/--open above — this closes
  // the two flags that hoisting left standing. `argInterval()`'s read had
  // two call sites — inside serve() directly, and embedded in gather()'s
  // return (`interval ?? argInterval() ?? 15`), which build's dispatch below
  // reaches too — and the --spend-since read sat inside gather() (now
  // `argSpendSince()`, extracted above for exactly this reason); all three
  // sat below every stray() call on every path that reaches them. A trailing
  // `--interval`/`--spend-since` ahead of a stray positional therefore
  // refused under stray()'s generic wording, naming the next token instead
  // of the flag actually given wrong — measured, `serve --interval --open x`
  // said `unexpected argument 'x'` before this hoist, and `build --interval
  // --open x` / `build --spend-since --open x` likewise. Same fix, same
  // place: call both here, once, ahead of the build/serve dispatch and
  // ahead of both branches' own stray() call, exactly where
  // argPort()/has("open") already sit. These are now the only reads:
  // gather() and serve() take the resolved values, and the branch below that
  // runs hands them on.
  const interval = argInterval() ?? 15;
  const spendSince = argSpendSince();
  // `--spend-dir` joins them for the same two reasons, from the day it
  // ships rather than one ticket later — it reaches both subcommands (gather()
  // on build, every tick on serve), and a trailing
  // `--spend-dir` ahead of a stray positional has to name itself instead of
  // the token behind it.
  const spendDir = argSpendDir();

  // sweep() above only refuses a `--`-prefixed token; a bare or
  // single-dash stray alongside a valid subcommand (`build --ledger x junk`)
  // rode along in silence the same way. Below the `cmd` check, deliberately
  // unlike sweep() above it: `board.mjs junk` is an unknown SUBCOMMAND, which
  // the usage die below already names as such, and stray() has no business
  // relitigating that with its own generic wording.
  //
  // Each branch guards itself rather than one call covering both: hoisting
  // stray() above the `cmd` check the way sweep() sits above it would make
  // `board.mjs junk --bogus` refuse the stray instead of falling through to
  // the usage die below, which is `cmd`'s wrong-subcommand case to name, not
  // stray()'s to relitigate.
  if (cmd === "build") {
    stray();
    const { computeBoard } = await import("./compute-board.mjs");
    // A snapshot printed here outlives the process that printed it —
    // redirected to a file, pasted into a ticket, read back by the next
    // launch — so it says which workspace it describes and which port that
    // workspace's cockpit answers on. The same seam serve() uses, so the two
    // subcommands can never name different instances from one cwd.
    //
    // No `port:` argument, deliberately: --port is read and DISCARDED on this
    // path (see argPort()/has("open") above), and honouring it here would give the flag a meaning
    // on `build` it has never had. The DERIVED port is the identity anyway —
    // it is the port this workspace is reachable on, which is what a stray
    // snapshot needs to name; the port some one-shot invocation happened to
    // ask for is not.
    //
    // The default ledger stays the cwd-relative literal that serve() used to share. That
    // is not an oversight to fix in passing: `build` prints to stdout and
    // writes no state directory, so the argument that moved serve()'s default
    // onto the workspace does not reach it, and changing it would change what
    // an existing `build` reads.
    const instance = resolveCockpitInstance({ cwd: process.cwd(), ...cockpitWorkspace(process.cwd()) });
    const model = computeBoard(await gather({
      ledgerFile: ledgerFile || ".fleet/ledger.md", prevFile,
      // The heartbeat's file, from the SAME instance the identity
      // fields below come from — not the cwd-relative literal the ledger
      // default keeps. That literal is `build`'s own back-compatibility (see
      // the note above); the mark has no existing `build` behaviour to
      // preserve, so it starts out resolved, and a snapshot printed from a
      // worktree names the run's real beat instead of a file that is not
      // there.
      stateFile: stateFileIn(instance.stateDir),
      workspace: instance.workspace, port: instance.port,
      interval, ...spendSource(spendDir, instance.stateDir), spendSince,
    }));
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  if (cmd === "serve") {
    stray();
    await serve({ port, interval, open, tick: await boardTick({ ledgerFile, interval, spendDir, spendSince }) });
    return;
  }
  die("usage: board.mjs build|serve [--ledger <path>] [--port N] [--interval N] [--open] [--spend-since <epoch-ms>] [--spend-dir <path>]");
}

// The tick serve() runs on its timer — gather() → computeBoard() → board.json —
// built by main() and handed to serve(), which calls it with the port it bound
// and the state directory, board.json path and workspace it resolved. serve()
// owns the socket, the timer and the identity handshake; what a tick reads and
// writes is owned here.
//
// The tick answers `true` when the cockpit is to exit: it has just written its
// board and the Controller record in the heartbeat file names a controller
// that is gone (cockpit-lifetime.mjs says when). serve() stops through its own
// stop() on that answer. Nothing else is ever signalled.
//
// The spend source is settled per TICK, never held across ticks: with no
// --spend-dir, every tick reads the session the phase-0 receipt records now.
// A cockpit lives as long as its run's controller, and a new run from the same
// omp session — or a phase-0 relaunch that reuses a running server — has to be
// followed through its receipt.
async function boardTick({ ledgerFile, interval, spendDir, spendSince }) {
  const { computeBoard } = await import("./compute-board.mjs");
  // One tick at a time, and the flag is load-bearing rather than defensive.
  // The timer's callback used to be synchronous, so node could not start
  // a second tick while the first was still inside gather() — it just fired
  // late. An async tick has no such floor: a gather that outruns `interval`
  // (a `gh` outage riding out its own timeouts, an operator's `--interval 1`)
  // would let the timer stack ticks on top of each other, and each of those
  // reads `prevFile` at its start and renames over it at its end. Two in
  // flight means double the `gh` and `ci-state.mjs` children — the very load
  // that made the tick slow — and, worse, a LATER-started tick can finish
  // first and be overwritten by the older one's payload, walking every
  // ticket's dwell clock and carried-forward CI value backwards.
  //
  // SKIPPED, not queued: a tick recomputes the whole board from scratch, so
  // the one that would have been queued has nothing in it the next one does
  // not redo. Announced once per process through the same warn-once gate
  // every other repeating condition in this file uses — a board falling
  // behind its interval is worth saying, and worth saying only once.
  let ticking = false;
  // The one thing carried from tick to tick besides `ticking`: whether this
  // cockpit has yet seen its run's controller alive. The record itself is
  // read afresh every tick — a latched controller would end a cockpit whose
  // record a new run had replaced.
  let armed = false;
  // `served` is the port this process actually BOUND, handed in rather than
  // closed over: it is not knowable until listen() returns (--port 0 is an
  // ephemeral bind, and serve()'s port loop may also land past a
  // candidate it could not take), and a tick that reached for the port asked
  // for instead would stamp every board served on an ephemeral port with a
  // `port: 0` no browser could ever reach. A parameter makes that
  // unreachable rather than merely unlikely — there is no earlier value in
  // scope for it to pick up.
  return async ({ served, stateDir, jsonPath, workspace }) => {
    if (ticking) {
      warnOnce("tick-overlap", String(interval),
        `a board tick is still running after ${interval}s; skipping this one — the board will be older than its interval until the reads it is waiting on return`);
      return;
    }
    ticking = true;
    try {
      // The identity a second launch's handshake reads off this
      // cockpit. It rides the board payload deliberately, rather than a
      // lockfile or a second endpoint: a payload exists only while the
      // process serving it does, so nothing written here can outlive this
      // cockpit and send the next launch at a port nobody holds. It is null
      // on the degrade arm — no workspace was established — which is exactly
      // the value no launch may ever match on.
      //
      // Joined at gather(), not stamped onto the finished model. The
      // assignment that used to sit below this line wrote a field the pure
      // model did not declare, so `build` printed a board with no identity
      // at all and only the served copy carried one.
      const gathered = await gather({
        // The ledger's own default (ledger.mjs's defaultLedgerPath()) is
        // never reached here — board.mjs always passes an explicit --file — so an
        // absent --ledger has to be defaulted against the SAME instance the state
        // directory came from, not a cwd-relative literal. A worktree or a
        // subdirectory cwd previously left this pointing at a ledger.md that does
        // not exist there, while the state directory had already moved to
        // the workspace: the board and the ledger could disagree about which run
        // they belonged to, exactly what resolveCockpitInstance() exists to rule
        // out.
        ledgerFile: ledgerFile || join(stateDir, "ledger.md"), prevFile: jsonPath, interval,
        // Beside the ledger and out of the same state directory, so
        // the board, the ledger and the heartbeat cannot disagree about which
        // run they belong to — the invariant resolveCockpitInstance() exists
        // for. Re-derived per tick rather than closed over, exactly like
        // the ledger default: a pure join on a directory settled at bind time.
        stateFile: stateFileIn(stateDir),
        workspace, port: served,
        // The operator's --spend-dir, else the receipt as it stands at this
        // tick, read from the same state directory as the ledger and heartbeat.
        ...spendSource(spendDir, stateDir), spendSince,
      });
      const model = computeBoard(gathered);
      const tmp = `${jsonPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(model));   // atomic: write tmp, rename over target
      renameSync(tmp, jsonPath);
      // After the board is written, so the last board an exiting cockpit
      // leaves is this tick's. A record or process table that cannot be read
      // gives no verdict, and a drain (the Liveness mark's `stopped`) is not
      // read at all.
      const verdict = controllerVerdict(gathered.controller, undefined, (why) =>
        warnOnce("controller-unreadable", "", `${why} — the cockpit cannot tell whether its run's controller is alive, so it keeps serving`));
      const next = cockpitLifetime(armed, verdict);
      armed = next.armed;
      if (next.exit) {
        console.error(`${NAME}: the controller of this run (pid ${gathered.controller.pid}) is gone — the cockpit exits`);
        return true;
      }
    } catch (e) { console.error(`${NAME}: build tick failed: ${e.message}`); }
    finally { ticking = false; }
  };
}

// An internal FAULT is not a refusal, and until this they were one
// line. Every guard in this file refuses through die(), which writes its own
// line and calls process.exit(2) itself (arg.mjs) rather than throwing, so
// nothing a caller can type unwinds as far as the catch below. Re-checked
// against the tree rather than taken from the ticket: every `throw` in this
// file — readOmpSpend's per-transcript catch, and the three prev-board shape guards
// gather() gained — is caught by the try that raises it, so the whole
// population reaching this handler is this script breaking. Handing that
// to die() printed a bug under the wording and the exit code a typo gets — one
// `board: <text>` line, exit 2, no stack — and an operator could not tell the
// two apart.
//
// So the entry point gets its own path and its own code, and die() is left
// exactly as the other nine scripts have it. 70 is sysexits.h's EX_SOFTWARE,
// "an internal software error has been detected", and it spends nothing the
// fleet's exit vocabulary already means: 0 is the answer, 1 is a verdict (this
// script has none to give), 2 is every refusal here, 3 is candidates.mjs's
// minted verdict, and 126+ is the band a shell mints for itself.
const FAULT_EXIT = 70;

// The diagnostic, and it can never come back empty. Read off `stack` rather
// than `instanceof Error`: the stack is what a fault owes the operator, and
// asking for it directly needs no error TYPE — the hierarchy this rules out.
// A thrown non-Error has no stack and used to arrive as `e.message ===
// undefined`, so the CLI printed the literal `board: undefined`; inspect()
// renders every value there is — `undefined`, `null`, `""`, a circular object
// — as something with bytes in it.
export function faultText(e) {
  return typeof e?.stack === "string" && e.stack !== "" ? e.stack : `non-Error rejection: ${inspect(e)}`;
}

// writeSync and the leading newline for die()'s own reasons (arg.mjs): tryRun
// re-emits gh's stderr through this process's async stream, so a stack queued
// behind it on a pipe is what process.exit() discards. The empty catch is
// die()'s too — the message can be lost, the exit code cannot.
//
// A single writeSync call can also short-write — return the count it
// managed and throw nothing at all — or throw EAGAIN outright, the same
// failure arg.mjs's writeAll() has a bounded retry loop for. board.mjs has
// exactly one writeSync call site — this one — and arg.mjs's die() and
// staleness.mjs's verdict() use the shared writeAll() while
// ci-state.mjs has no emit() of its own, so fault() is now the only script-level
// function left hand-rolling this loop directly: it carries the largest
// single payload of any of them, a full stack, not a one-line refusal — so
// it is the one most likely to collide with a saturated pipe and lose the
// diagnostic silently. The loop below mirrors writeAll()'s shape: resume a
// short write where writeSync left off, and retry
// EAGAIN after a 1ms Atomics.wait, capped at MAX_EAGAIN_RETRIES so a reader
// that never drains still reaches process.exit() below instead of hanging
// forever. A sibling script that wants a fault path adopts this shape
// rather than spelling a second one; it is deliberately not in arg.mjs,
// which exists to hold the helpers that already had copies to collapse.
const MAX_EAGAIN_RETRIES = 200;

// Shared across every retry: Atomics.wait never writes or notifies it, so one
// instance times out exactly as a fresh one would, without allocating a
// SharedArrayBuffer on every EAGAIN.
const IDLE = new Int32Array(new SharedArrayBuffer(4));

function fault(e) {
  try {
    let buf = Buffer.from(`\n${NAME}: internal fault (exit ${FAULT_EXIT}) — a bug in ${NAME}.mjs, not in what you typed\n${faultText(e)}\n`);
    let retries = 0;
    while (buf.length) {
      try {
        buf = buf.subarray(writeSync(2, buf));
      } catch (writeErr) {
        if (writeErr.code !== "EAGAIN" || ++retries > MAX_EAGAIN_RETRIES) break;
        Atomics.wait(IDLE, 0, 0, 1);
      }
    }
  } catch {
    // Message may be lost; the exit code below must not be.
  }
  process.exit(FAULT_EXIT);
}

// Only run main() as a CLI, never when imported by a test (see is-cli.mjs).
if (isCLI(import.meta.url)) main().catch(fault);
