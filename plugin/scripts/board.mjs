#!/usr/bin/env node
// The cockpit's I/O layer. `build` gathers ledger + gh + CI state, calls the
// pure computeBoard(), and prints board.json. `serve` (below) loops build,
// atomic-writes .fleet/board.json, and serves board.html. The board never
// depends on the controller feeding it.
//
// Pipeline state is a pure function of ledger + GitHub. The spend panel adds a
// THIRD input that is neither — the local Claude Code transcript tree under
// ~/.claude/projects — so the "f(ledger, gh)" property no longer covers the
// whole model. It is telemetry, kept strictly to the side: it can only ever
// populate or omit `spend`, never change a ticket's stage.
//
// That transcript tree is keyed by PROJECT DIRECTORY, not by session, and one
// directory can hold several sessions at once. `serve` therefore resolves ONE
// session's transcript directory and keeps it for its whole life (#1583) — see
// spendDirPin() below — rather than re-picking the newest on every tick and
// alternating between two live runs' numbers in silence.
//
// LIMITATION, stated rather than solved: the session it keeps is whichever
// FIRST writes a transcript at or after the pin's own construction (#1679).
// Before that, a session that was already active when the pin was built —
// this run's own, mid-EACCES-fault, or a genuinely previous run's — is never
// latched; the pin keeps re-asking findSubagentsDir() every tick instead,
// which is what lets a transient fault or a stale session recover instead of
// freezing the panel for the server's whole life. What is not solved: two
// sessions that BOTH start writing after the pin exists, in the same project
// directory, are still indistinguishable — the board is scoped to a
// workspace and a workspace does not know that (#39) — so the first of them
// to pass the newest-transcript check wins and keeps winning. `--spend-dir
// <path>` is how an operator names the right one: it overrides the
// heuristic outright.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, readdirSync, statSync, writeSync } from "node:fs";
import { classifyRole, computeSpend, attributeTools, mergeTools } from "./compute-spend.mjs";
import { encodeClaudeProjectDir as encodeProjectDir, foldClaudeTranscript, claudeRoleSignals } from "./member-record.mjs";
import { makeDie, makeArg, makeHas, makeSweep, makeStray } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";
// #1597: the heartbeat's liveness mark, read here and never written. The
// cockpit is a READER of that key — the heartbeat is its only writer — and it
// reaches the file through the module that owns the filename rather than
// spelling `heartbeat.json` a second time. The PATH still comes from this
// file's own resolveCockpitInstance(), not from statePath(): that probe is
// already run once per launch here, with the `canonicalise` opt-in only this
// caller takes (#1582), and a second probe could answer differently.
import { readState, stateFileIn } from "./fleet-state.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { inspect } from "node:util";

const NAME = "board";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// die()/arg()/has() shared with the other fleet scripts — see arg.mjs for
// the fail-open (#61/#169/#364) and pipe-safety (#176/#328/#363) rationale.
const die = makeDie(NAME);
const arg = makeArg(die);
const has = makeHas(die);
const sweep = makeSweep(die);
const stray = makeStray(die);
// `ledger`/`prev`/`spend-since`/`port`/`interval` are all read with `||`/`??`
// fallbacks, so a trailing flag previously substituted a default in total
// silence — `--spend-since` with nothing after it silently widened the spend
// panel to all-time instead of the requested window, and `--ledger` with
// nothing after it silently read the DEFAULT ledger file instead of the one
// asked for.
//
// #468: a guard used to fire only where the flag was actually READ, and that
// was not every subcommand — `port` and `open` are USED in serve() alone, so
// `build --port` (trailing), `build --port abc` and `build --open=1` were all
// IGNORED at exit 0 rather than refused. main() now calls argPort()/
// has("open") once, ahead of the build/serve dispatch, so both malformed
// spellings refuse on EVERY subcommand — build just discards the (validated)
// return value, since nothing on that path has a server to bind or a browser
// to open. A WELL-FORMED --port/--open on build still does nothing there,
// same as before this fix: the guard checks the flag's SHAPE, not whether
// this subcommand has a use for it. `ledger`/`prev`/`spend-since`/`interval`
// were already read on the build path and already refused there.
// #1092: that last claim held for `ledger`/`spend-since`/`interval`, not for
// `prev` — `prev` was read on `build` alone, and serve() never read it at
// all. Hoisted in main() below, next to argPort()/has("open").

// #1546: the "is this a plain JSON object" predicate and its kind word, one
// copy for the three reads in this file that reject a parsed-but-wrong payload
// WHOLE — readAgent's sidecar-meta read, gather's `--prev` payload, and
// gather's per-entry `tickets[i]` check. Each carried its own inline copy of
// both halves before, which is three places for one policy to drift in.
//
// TWO functions and not one, because `typeof` alone cannot name the fault the
// predicate rejects: it answers "object" for `null` and for `[]` alike, and
// those are exactly two of the three shapes turned away here, so a
// `typeof`-only diagnostic distinguishes neither from a real object. That is
// the same three-arm naming review-core.js's resolveDimensions keeps, for the
// same reason.
//
// Not every payload-shape check in this file is one of these, and the others
// are not oversights: mapCi's and tryParse's are both null-only, neither
// refusing a payload for being an array or a scalar. A settled, deliberately
// different policy — not a fourth caller waiting to be converted.
function isJsonObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonKind(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

// #366: `Number(x) || default` treated a garbage --port/--interval exactly
// like an absent one — "abc" is NaN, NaN is falsy, so it silently became the
// default with no refusal. Same silent-fallback class as arg()'s own comment
// above and #361's --spend-since guard. `interval` is read from argv in two
// places (serve(), and gather()'s build payload); both call argInterval() so
// the check lives once, not as two copies that can drift apart. Neither
// guard runs on an already-typed value a caller passed in-process — arg()
// only fires when the caller falls through to reading raw argv.
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
// inverse of what was asked, announced by nothing the board prints (#435
// review). 2147483647ms / 1000, floored, is the last WHOLE second that fits;
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
// #1076: pulled out of gather() into its own function, like argPort()/
// argInterval() above, so main() can call it too (below) ahead of the
// build/serve dispatch and ahead of both branches' stray() call — before
// this fix the read sat inline inside gather(), below every stray() call on
// every path that reaches it, so a trailing `--spend-since` ahead of a stray
// positional refused under stray()'s generic wording instead of this one.
// gather() still calls this itself, in the same spot, so nothing about WHEN
// it validates changes for a caller that skips main() (same reasoning #468
// gives for argPort()/has("open") staying in serve() too).
function argSpendSince() {
  const sinceRaw = arg("spend-since");
  if (!has("spend-since")) return null;
  const sinceMs = Number(sinceRaw);
  if (!Number.isFinite(sinceMs) || sinceMs < 1e12 || sinceMs > Date.now()) {
    die(`--spend-since wants epoch milliseconds, got ${sinceRaw}`);
  }
  return sinceMs;
}

// #1583: the operator's override for the session heuristic (findSubagentsDir()
// below). A PATH, so there is no range or magnitude to check the way
// --spend-since and --interval have one — every malformed SHAPE this flag can
// take is already arg()'s: a trailing `--spend-dir`, an empty or whitespace
// value, a following flag eaten as the value, and the `--spend-dir=` form.
// What this read buys is that all four refuse under THIS flag's name instead
// of stray()'s generic "unexpected argument", and they do so before gather()
// shells out to anything — which is what declaring it in VALUE_FLAGS and
// calling it from main() (both below) is for, exactly as #1076 did for
// --spend-since. A named read rather than a bare arg() at each call site so
// the flag is spelled in one place and this reasoning has a home.
//
// Existence is deliberately NOT checked, and refusing an absent directory
// would refuse the one invocation this flag exists for: a session's
// `subagents/` directory does not exist until that session's first agent
// spawns, and the cockpit launches in run-team phase 0, BEFORE that. An
// operator pinning THIS run's transcripts therefore names a directory that is
// not there yet, and it appears seconds later. A directory that never appears
// degrades per tick through gatherSpend's catch and hides the panel; it never
// renders zeroes and never dies.
//
// `undefined` for an absent flag, not the `null` argPort()/argInterval()/
// argSpendSince() return: `null` is a transcript-directory RESOLUTION in this
// file ("resolved, no session yet" — findSubagentsDir() below), and the
// absence of an override must not read as one.
function argSpendDir() {
  return arg("spend-dir") ?? undefined;
}

// Node's default stdout cap is 1 MiB and execFileSync THROWS (ENOBUFS) past it
// rather than truncating (#807). Here that throw is indistinguishable from an
// unreachable tool: the read degrades to the caller's empty default and the
// cockpit is served a BLANK board at HTTP 200 with only a stderr line — the
// #246 symptom, which #803 moved up from the pipe buffer rather than removed.
// The ledger is append-mostly and shared by every fleet script, so the ceiling
// arms itself over the life of a run and gives no second warning. Bounded, not
// Infinity: a runaway child should still be stopped rather than allowed to
// exhaust the box. Same headroom staleness.mjs takes, for the same reason.
//
// Both child reads in this file take it. `tryRun` is NOT the single funnel —
// runCiState() spawns its own, because it needs the exit code that a plain
// tryRun discards — so a fix applied only here would leave that one uncapped.
const READ_OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// Every external read is wrapped: a failure returns null and the caller keeps a
// last-known value. Partial board beats a crashed loop or a false alarm.
function tryRun(cmd, args) {
  try { return execFileSync(cmd, args, READ_OPTS); }
  catch (e) { console.error(`${NAME}: ${cmd} ${args.join(" ")} failed: ${e.message}`); return null; }
}

// Parse tool stdout defensively: a tool can exit 0 yet print malformed or
// warning-prefixed stdout. Treat that like a failed read (fall back to the
// caller's empty default), never let it crash the tick.
//
// A nullish INPUT and a null PARSED VALUE are two faults, and the first guard
// does not cover the second: `JSON.parse("null")` succeeds and yields null, so
// without the second guard a bare `null` payload arrives at the caller as its
// answer. Strictly `=== null`, never falsiness — `0`, `false` and `""` are all
// answers a caller can read, and refusing them would substitute a shape
// judgement this helper is not in a position to make.
//
// Null is guarded here and shape is not, because null is the only parse result
// no caller of this helper can use: every other one boxes and reads, null alone
// has no properties, whatever shape the caller wanted. Shape is the caller's
// question and keeps the caller's answer — withNumber below rejects a non-array
// for the `gh ... list` reads, readAgent parses its own sidecar so it can demand
// an object, and gather()'s ledger branch takes any shape ledger.mjs emits,
// deliberately, for the reason stated there. A shape policy could not be written
// in here anyway: `fallback` is `[]` where ghRows calls this and null where the
// ledger read does, so the helper is never told what its caller wanted — only
// that null is not it.
//
// Reported, and never as "parse failed": the parse succeeded, and keeping the
// state a read reached apart from the state it failed at is what #816 was about.
function tryParse(json, fallback, what) {
  if (json == null) return fallback;
  let parsed;
  try { parsed = JSON.parse(json); }
  catch (e) { console.error(`${NAME}: ${what} parse failed: ${e.message}`); return fallback; }
  if (parsed === null) {
    console.error(`${NAME}: ${what}: payload is JSON null, not a usable answer; falling back`);
    return fallback;
  }
  return parsed;
}

// A row without a usable `number` cannot be placed: compute-board.mjs joins
// issues/PRs to ledger rows and to each other BY number (Map keys, Set
// membership, `.find`), so a numberless row does not fail to render on its
// own — it collides with every other numberless row on the shared `undefined`
// key. Drop it, loudly. candidates.mjs's row guard is a different shape —
// comprehensive and hard-failing (die() on the first bad row) — this one is
// narrower: it only checks `number`, the one field whose absence corrupts
// OTHER rows, and degrades instead of dying (#786).
//
// `rows` itself can be the wrong shape too: `tryParse` only checks that its
// input is valid JSON, not that it is an array, so a syntactically-valid
// object or scalar from `gh` would otherwise reach the `for...of` below and
// throw "rows is not iterable" — an uncaught throw that reaches main()'s
// build path or serve()'s tick catch, exactly the crash-instead-of-degrade
// failure this guard exists to prevent for individual rows.
function withNumber(rows, what) {
  if (!Array.isArray(rows)) {
    console.error(`${NAME}: ${what}: expected an array of rows, got ${JSON.stringify(rows)}`);
    return [];
  }
  const kept = [];
  for (const r of rows) {
    if (r && typeof r.number === "number") kept.push(r);
    else console.error(`${NAME}: ${what}: dropping row with no usable number: ${JSON.stringify(r)}`);
  }
  return kept;
}

// tryParse + withNumber are always paired for a `gh ... list` read — one
// helper rather than the same two-call chain typed twice for issues and PRs.
function ghRows(json, what) {
  return withNumber(tryParse(json, [], what), what);
}

// labels: gh emits an array of {name,...} objects, but a malformed row can
// hand back a non-array `labels` (`.map` throws) or an array containing a
// null/malformed element (`.name` throws) — reproduced live: either crashes
// gather() entirely, reaching main()'s `die()` on the build path or freezing
// the board on its last-known value on the serve path. Strictly worse than
// this ticket's original "shows undefined on the page" bug. Drop-and-continue,
// like withNumber above: a bad label never takes its row's whole labels array
// down, and a bad labels field never takes the row down.
function labelsOf(row) {
  if (!Array.isArray(row.labels)) return [];
  return row.labels
    .map((l) => (l && typeof l.name === "string") ? l.name : null)
    .filter(Boolean);
}

// ci-state.mjs exits 0 for green, 1 for not-green or no-ci, 2 for a hard
// failure — no-ci is its own verdict and shares exit 1 because this call omits
// --declare-no-ci, the only thing that would move it to exit 0 — and on
// exit 1 it has ALREADY printed its verdict JSON to stdout before exiting, so a
// thrown exit 1 carries a real verdict. Feed that to mapCi: discarding e.stdout,
// as a plain tryRun would, makes red/still-running CI unreachable — every
// non-green PR reads as "unknown" and the red-ci flag, the top of the attention
// strip, never fires.
//
// What separates a verdict from a failed read is the EXIT CODE. Emptiness of
// stdout was only ever a proxy for it, and #262 retired the proxy: a quota
// refusal now names its cause on stdout on the way out at exit 2, so "non-empty
// stdout" began reading an outage as a reading. That payload carries no
// `status`, so mapCi answered "unknown" and gather()'s prevCi carry-forward —
// which only a null return reaches — was skipped, overwriting a PR's
// last-known-good CI state during a blip that clears itself. Exit 2 means the
// question could not be answered, whatever the script printed while saying so.
//
// The exit code is not sufficient on its own either (#875), for the symmetric
// reason: it reports that the child reached its own exit path, never that its
// payload arrived whole. `e.status !== 2` is also true of a signal kill, where
// `status` is null, and of a write cut mid-JSON at exit 1 — emit() over in
// ci-state.mjs abandons a short write it cannot retry, which keeps the exit
// code intact while losing the tail of the line. Those bytes were returned AS a
// verdict, mapCi could not parse them, and the non-null return skipped the very
// carry-forward #262 added: the #262 regression re-entering through the gate
// built to stop it. So both halves have to hold — a non-2 exit AND bytes that
// parse.
//
// The parse is the discriminator rather than "any abnormal termination", the
// other candidate, because only the parse gets both directions right. It
// catches the cut-off exit-1 write, which carries status 1 and no signal at all
// (measured), and it goes on ACCEPTING a complete payload from a child killed
// after writing it, as well as no-ci — a real exit-1 verdict whose own `status`
// field is null, so a status-shaped guard tightened far enough to catch a
// truncation starts refusing it and resurrects a red for a PR with no run
// behind it. Wholeness is the only question asked here; SHAPE stays mapCi's,
// which is total over every payload that parses.
function runCiState(scriptDir, pr) {
  let out;
  try {
    out = execFileSync("node", [join(scriptDir, "ci-state.mjs"), "--pr", String(pr), "--quiet"], READ_OPTS);
  } catch (e) {
    const errOut = e.stdout ? e.stdout.toString() : "";
    if (e.status === 2 || !errOut.trim()) {
      console.error(`${NAME}: ci-state --pr ${pr} failed: ${e.message}`);
      return null;
    }
    // Its own line, not the one above: "failed" reads as "the child never
    // answered", and an operator looking at a carried-forward CI value needs to
    // know a payload DID arrive and was thrown away, and why.
    //
    // `how` reads e.code first — the three-way ci-state.mjs already uses at its
    // own child reads — because one cause of this shape is OURS: overrunning
    // READ_OPTS.maxBuffer is enforced by node killing the child, and that
    // arrives as signal SIGTERM carrying code ENOBUFS (measured). A
    // signal-first `how` renders it "killed by SIGTERM", billing a cap this
    // file sets to an outside killer and sending the operator after an OOM kill
    // or a stray `kill -TERM`. The signal arm stays ahead of the exit arm
    // behind it: `status` is null on a real signal kill, where "exit null"
    // would name nothing to act on.
    //
    // Through the warn-once gate, keyed on the PR exactly as mapCi's
    // `ci-parse` gate is and for the same reason: serve() re-gathers on a
    // timer, so a payload truncated by a cause that persists is truncated
    // again on every tick, and an ungated line spends one per PR per tick for
    // as long as the cause lasts. Its own channel, `ci-salvage-nonzero`,
    // distinct from both `ci-parse` and the exit-0 guard's `ci-salvage-exit0`
    // below: for any one payload the three are mutually exclusive — bytes
    // refused here return null and never reach mapCi — so a channel shared
    // between any two of them would buy nothing, and would let whichever arm
    // a PR happened to hit FIRST silence a later, structurally different
    // failure on another arm for the rest of the run — measured: driving the
    // same PR through this arm then the exit-0 guard below printed only the
    // first tick's warning until the channels were split.
    try { JSON.parse(errOut); }
    catch (pe) {
      const how = e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`);
      warnOnce("ci-salvage-nonzero", pr, `ci-state --pr ${pr} (${how}) left a payload that will not parse (${pe.message}); carrying the previous CI value forward rather than reading this as a verdict`);
      return null;
    }
    return errOut;
  }
  // #1593: exit 0 was never covered by any of the checks above — they only run
  // once execFileSync throws, and a child that exits 0 does not throw. So the
  // same write cut mid-JSON that the catch block above salvages at exit 1 rode
  // straight through here and into mapCi at exit 0, where an unparseable
  // string maps to "unknown" and gather()'s carry-forward — which only a null
  // return reaches — was skipped, discarding the PR's last-known CI value
  // exactly as #262 did before the exit-2 case was fixed. Same parse check,
  // same null return as the catch block above — but its OWN channel,
  // `ci-salvage-exit0`, not the catch block's `ci-salvage-nonzero`: a
  // zero-exit child does not get a looser contract than a non-zero one, and
  // the two arms are structurally different failures that must not silence
  // each other (see the channel-split comment above).
  //
  // Emptiness is checked before the parse, and gets its own wording: an empty
  // `out` is not a corrupted payload, it is no payload at all — "left a
  // payload that will not parse" is a true diagnosis of truncated JSON and a
  // false one of a child that printed nothing, the same distinction the
  // empty/status-2 branch above draws for a non-zero exit.
  try { JSON.parse(out); }
  catch (pe) {
    const msg = out.trim()
      ? `ci-state --pr ${pr} (exit 0) left a payload that will not parse (${pe.message}); carrying the previous CI value forward rather than reading this as a verdict`
      : `ci-state --pr ${pr} (exit 0) never answered; carrying the previous CI value forward rather than reading this as a verdict`;
    warnOnce("ci-salvage-exit0", pr, msg);
    return null;
  }
  return out;
}

// Every warn-once gate in this file routes through here. The stored key is the
// CHANNEL joined to the caller's key, never the caller's key alone: the gates
// below are keyed on paths, and two of them are keyed on the SAME transcript
// path, so a bare-key Set would let one channel's warning consume the other's
// line for that file — a behaviour change, not a refactor. NUL joins them
// because no channel name or path can hold one, so no two distinct (channel,
// key) pairs can collide. Every caller keys on a PR, a path, or the fault's
// own message, so `key` is never empty.
const warnedOnce = new Set();
function warnOnce(channel, key, msg) {
  const k = `${channel}\0${key}`;
  if (warnedOnce.has(k)) return;
  warnedOnce.add(k);
  console.error(`${NAME}: ${msg}`);
}

// The `ci-parse` gate is keyed on the PR, not on the payload: `serve` rebuilds
// every ~15s and calls mapCi once per PR per tick, so a payload that is broken
// is broken on every tick, and a payload-keyed gate would flood anyway the
// moment the garbage varies between ticks. A single global flag is the other
// wrong answer — it would let the first broken PR mask every later one for the
// rest of the run, which is the silence this gate exists to end.

// ci-state's verdict already excludes behind-count staleness. Map it, and treat
// anything not cleanly green-or-completed-red as unknown — never a false red.
//
// `pr` is carried for the warn below and nothing else: an unparseable payload
// has no field to identify itself by, and "some PR's CI payload was garbage" is
// not actionable. The caller has the number in hand.
export function mapCi(ciJson, pr) {
  // A NULL payload, which is a failed read runCiState() has already reported
  // on stderr. Warning again here would report one failure twice. Null
  // strictly, not falsiness: an EMPTY payload is not that case. Since #1593
  // runCiState() parse-checks its exit-0 return too, so its own callers never
  // hand this an empty string any more — but mapCi() is exported and total
  // over any caller, not just this file's, so a `!ciJson` guard that swallowed
  // "" as though it had been reported would still be wrong. It falls through
  // to the parse below instead, which is where it earns its line.
  if (ciJson == null) return "unknown";
  let d;
  // A payload that will not parse is a THIRD state, and the return value cannot
  // carry it: "unknown" is what the regression gate pins, since a false red is
  // worse than no verdict. So the distinction leaves through stderr or not at
  // all. #875 closed this for runCiState()'s catch block (a payload that will
  // not parse there is a failed read, reaching gather()'s carry-forward);
  // #1593 closed it for the exit-0 arm the same way (see runCiState() above),
  // so a write cut mid-JSON no longer reaches mapCi from gather() on EITHER
  // arm — a lost write now reads as a failed read there too, and that PR's
  // last-known CI value stands instead of reverting to "unknown". This catch
  // stays live regardless: mapCi() is exported and total over any string
  // handed to it, parseable or not, and its own tests drive it directly
  // without going through runCiState() at all.
  try { d = JSON.parse(ciJson); }
  catch (e) {
    warnOnce("ci-parse", pr, `PR ${pr} ci-state payload is not JSON (${e.message}); reading its CI as unknown, so its red-ci flag stays down`);
    return "unknown";
  }
  // JSON.parse("null") succeeds and yields d === null. Nullishness, not
  // object-ness, is the discriminator: `[]` and `{}` are typeof "object" just
  // as null is, but null alone has no properties to read, so the status gate
  // throws a TypeError on it where every other parsed payload boxes and reads
  // its status as undefined. Hence a guard with its own return, rather than a
  // payload that reaches the status gate and answers "unknown" there. Silent,
  // not warned: the status gate already answers every parseable payload it
  // cannot read a status from without a line, and a bare "null" is no more
  // corrupt than those.
  if (d === null) return "unknown";
  if (d.status !== "completed") return "unknown"; // still running, or no run yet (status null)
  if (d.verdict === "green") return "green";
  if (d.verdict === "not-green") return "red";
  return "unknown";
}

// Where this session's subagent transcripts live: Claude Code writes them to
// ~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/. The encoder
// itself now lives in member-record.mjs (#1342), shared with the omp reader
// and with member-outcomes.mjs; re-exported here under its original name so
// nothing importing `encodeProjectDir` from this file needs to change.
export { encodeProjectDir };

// The session uuid is not knowable from here, so take the most recently active
// one. Rank on the newest TRANSCRIPT mtime, not on the subagents directory's
// own: a directory's mtime moves when an entry is created or removed, never
// when a file inside it is appended to. Ranking on the directory therefore
// tracked the last agent SPAWN rather than the last agent activity — and since
// the cockpit launches in run-team phase 0, before the first agent spawns, the
// live session has no subagents dir yet and a PREVIOUS session won. The board
// would render a prior run's spend as this run's, then silently switch when the
// first agent landed. That is the one failure mode here that produces
// confidently wrong numbers rather than no numbers.
//
// Returns { error } when the project dir cannot be resolved at all — a bug that
// never fixes itself — and null when it resolves but holds no sessions yet,
// which is normal at run start. Collapsing those two into one bare null is what
// hid the encoding bug above.
export function findSubagentsDir(home = process.env.HOME, cwd = process.cwd()) {
  try {
    const projects = join(home, ".claude", "projects", encodeProjectDir(cwd));
    if (!existsSync(projects)) return { error: `no transcript dir for cwd ${cwd} (looked in ${projects})` };
    const cands = readdirSync(projects)
      .map((s) => join(projects, s, "subagents"))
      .filter((d) => existsSync(d))
      .map((d) => ({ d, m: newestTranscriptMs(d) }))
      .sort((a, b) => b.m - a.m);
    return cands.length ? cands[0].d : null;
  } catch (e) { return { error: `transcript lookup failed: ${e.message}` }; }
}

// Newest *.jsonl mtime in a subagents dir, 0 if it holds none. A dir whose
// transcripts are all unreadable loses to one that is readable, which is the
// behaviour we want when picking "the live session".
//
// The scan is wrapped for the same reason the per-file stat below is. This runs
// once per CANDIDATE, so an uncaught throw here does not just lose one dir — it
// escapes findSubagentsDir's try and turns the whole lookup into { error },
// blacking out every readable session over one bad sibling. Scoring 0 is what
// the comment above already promises: a dir we cannot read simply loses.
function newestTranscriptMs(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let newest = 0;
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch { /* raced away */ }
  }
  return newest;
}

// #1583: the transcript directory a `serve` process is bound to, resolved
// once it can be trusted and reused by every tick after it. findSubagentsDir()
// above ranks sessions by newest transcript mtime and gather() reached it
// through gatherSpend() on EVERY tick (~15s by default), so two sessions live
// under one project directory took turns winning: the panel alternated
// between two runs' numbers with nothing on the page or on stderr to say it
// had switched.
//
// The pin holds the first answer that COULD BE THIS RUN'S, not the first
// non-null answer and not the first call (#1679). findSubagentsDir() has
// three returns and none of them is safe to latch on sight: a directory
// resolved at pin-construction time can be a PREVIOUS run's session — newer
// than nothing else that exists yet, so it wins the ranking, but not this
// run's — and `{ error }` can be a transient fault (EACCES on a directory
// mid-permission-change, EMFILE, EIO) recovering on the very next tick just
// as easily as it can be the truly unresolvable "bug that never fixes
// itself" the ticket originally reasoned about. Latching either one turns
// the self-correcting degradation this file's header describes into a
// permanent one: measured (#1679), a chmod'd-then-restored projects dir left
// the OLD `??=` pin stuck on `{ error }` forever while the unpinned lookup
// recovered on its very next tick, and a prior run's `subagents/` dir
// present at launch left the old pin on yesterday's numbers for the whole of
// today's run, even once today's first agent had written its own transcript.
//
// So `launchMs`, captured once at construction, is the boundary: `null` (no
// session anywhere yet) and `{ error }` (unresolvable OR transiently
// unreadable — indistinguishable from here, so neither is trusted) both keep
// re-asking, same one scan per tick the `null` case always cost. A resolved
// directory whose own newest transcript predates `launchMs` is treated the
// same way — returned as this tick's best-effort answer, so the panel still
// renders it, but not cached — because a transcript that stopped moving
// before this pin existed cannot be evidence of THIS run's activity. Only a
// directory whose newest transcript is at or after `launchMs` latches, which
// is the one fact available here that says "something is writing to this
// session on my watch", never a previous run's signature.
//
// An explicit directory skips the heuristic entirely — never resolved, never
// re-picked, and findSubagentsDir() is never called at all, so a tree it could
// not read cannot degrade a panel the operator has already named the source
// for. `home`/`cwd` are captured HERE rather than read per call for the same
// reason the resolution is: a pin that could answer for a different workspace
// later is not a pin.
//
// The limitation this leaves is stated at the top of this file: two sessions
// that both start writing after the pin exists are still indistinguishable.
// --spend-dir is the way out.
export function spendDirPin(explicit, home = process.env.HOME, cwd = process.cwd()) {
  if (explicit != null) return () => explicit;
  const launchMs = Date.now();
  let pinned = null;
  return () => {
    if (pinned !== null) return pinned;
    const answer = findSubagentsDir(home, cwd);
    if (typeof answer !== "string") return answer; // null or { error }: neither is a trustworthy answer to latch
    if (newestTranscriptMs(answer) < launchMs) return answer; // predates this pin — could be a previous run's
    return (pinned = answer);
  };
}

// Read one agent transcript into the shape the pure module wants. Single pass —
// a long review agent's transcript is megabytes and this runs every tick.
// Malformed lines are skipped rather than fatal: a transcript being appended to
// WHILE we read it will have a torn last line, every tick. That reason reaches
// the FINAL element of the split and no other, so only that one is skipped in
// silence. A line anywhere earlier can never be completed by a later append, so
// it is still malformed on every tick after — a real fault, and one that costs
// spend rather than nothing.
//
// #916: it costs spend, so stderr was never enough for it. board.html says
// twice that stderr is not a channel here — the board is launched backgrounded
// and the operator is watching the page — which is the argument that put
// `skipped` in the DOM and then `metaErrors` (#602) beside it. So the count
// comes back as `damaged` and takes that same route, and this warning becomes
// the SECOND channel rather than the only one. Measured before it did: a
// mid-file tear billed 1500 where an intact file billed 1800, `skipped` 0,
// `metaErrors` 0, `error` undefined, and spendView's whole decision identical
// to the intact run's — and a transcript whose ONLY turn was the torn line
// hid the panel outright, a destroyed run rendered as an idle one.
//
// Warn-once is now safe here for exactly the reason the `skips` gate gives,
// where before #916 it needed its own: this message carries a COUNT, and a
// count in a suppressed line can go stale — a second tear on a later tick
// leaves the printed number one short. What keeps that honest is `damaged`
// reaching the browser every tick, the same live channel `skipped` relies on.
// The stderr number is the magnitude at FIRST sighting, deliberately: it tells
// an operator reading a log how much to care, and the panel owns the live one.
// Ceiling: a transcript whose writer has already exited has no legitimate torn
// last line either, but readAgent cannot tell a live writer from a finished one,
// so that line keeps passing in silence. Strictly better than warning on none.
//
// ONE assistant API turn is written as SEVERAL jsonl lines — one per content
// block (thinking, text, each tool_use) — and every one of those lines repeats
// the SAME `message.id` and the SAME `message.usage` object. Summing usage per
// LINE therefore counts each turn's cache_creation once per block: measured
// across 2452 real transcripts, +206% (535M counted vs 175M actual), with
// 2445 of them affected. So fold lines back into turns on `message.id` and take
// each turn's usage exactly once.
//
// `output_tokens` is the one field that genuinely differs across a turn's lines:
// it is a streaming snapshot, so the LARGEST value is the final one. Summing it
// double-counts too, though only by ~1.5%.
//
// The meta read below is guarded by existsSync, so the UNNAMED-AGENT case never
// runs the guarded read — it simply leaves `meta` at {}. Everything that does
// reach the catch is a real fault: a sidecar read torn mid-write,
// EACCES/EISDIR, a delete racing the existsSync, or valid JSON of the wrong
// SHAPE (guard below). Swallowing those booked the agent's whole spend as
// `other` with nothing on stderr, which moves reviewPct — the review headline
// compute-spend.mjs calls the one number anyone acts on. Measured on a
// two-agent fixture: an intact reviewer sidecar gives reviewPct 80, the same
// sidecar truncated gives 0, in silence (#325).
//
// Keep the {} fallback rather than rethrowing. The TRANSCRIPT is still readable,
// so a throw would land in gatherSpend's per-file catch and drop this agent's
// real tokens from the totals — a wrong total in place of a wrong role, and one
// the panel would then also count as `skipped`. The `meta` gate warns once per
// PATH, for the reason the `skips` gate gives below: `serve` rebuilds every
// ~15s, and a broken sidecar is broken on every tick. The `lines` gate is keyed
// on the transcript's FULL PATH for that same reason.
function readAgent(file, metaFile) {
  let meta = {};
  // Set only inside the catch below — never for the existsSync-false path,
  // which is the ordinary unnamed agent, not a fault. This is #602's signal:
  // `meta` staying `{}` already made the fault survive (role "other", label
  // the bare filename), but nothing carried it past this function, so a
  // corrupt sidecar and a genuinely absent one were the same return shape.
  let metaFault = false;
  try {
    if (existsSync(metaFile)) {
      // JSON.parse SUCCEEDS on `null`, a bare number, a string, an array — none
      // of which classifyRole or `meta.description` can read. Reject the shape
      // here, so it takes the warn path below like any other sidecar fault. Left
      // to reach `a.meta.description`, it throws into gatherSpend's per-file
      // catch instead, which drops this agent's real tokens, counts it
      // `skipped`, and names the TRANSCRIPT in a fault that is the sidecar's.
      const m = JSON.parse(readFileSync(metaFile, "utf8"));
      if (!isJsonObject(m)) throw new TypeError(`expected a JSON object, got ${jsonKind(m)}`);
      meta = m;
    }
  }
  catch (e) {
    metaFault = true;
    warnOnce("meta", metaFile, `${metaFile} unusable, classifying agent as "other" and labelling it from its filename: ${e.message}`);
  }

  const folded = foldClaudeTranscript(readFileSync(file, "utf8"));
  const damaged = folded.malformedNonLastLines;
  if (damaged) {
    // The position check lives in foldClaudeTranscript now: a legitimate torn
    // tail must not reach warnOnce at all, or it consumes this file's one
    // `lines` line and permanently silences the real fault when the tear
    // later moves. It must not reach `damaged` either — a note reading "spend
    // may be incomplete" on every transcript still being written to is a note
    // nobody reads by the second tick.
    // "first parse error", not "the" one: the count can exceed 1 and only the
    // first cause is carried, so the line says which number it is quoting.
    warnOnce("lines", file, `${file} has ${damaged} unparseable line${damaged === 1 ? "" : "s"} away from its tail; that much of its spend may be missing from the panel (first parse error: ${folded.malformedNonLastLineError})`);
  }
  return {
    meta, cacheWrite: folded.cacheWrite, output: folded.output,
    cacheRead: folded.cacheRead, maxCtx: folded.maxCtx, entries: folded.entries,
    metaFault, damaged,
  };
}

// The `no-spend-dir` gate warns at most once per process PER DISTINCT ERROR.
// `dir.error` is not constant — findSubagentsDir words an unresolvable project
// dir differently from a lookup that threw — so it is keyed on the message
// itself, not the empty string this gate used to key on: an empty key
// collapsed both wordings onto the one `no-spend-dir\0` slot, so whichever
// fault landed first for a process consumed the slot and a later, genuinely
// different fault never reached stderr again for the rest of the run. Keying
// on `dir.error` fixes that without losing the steady-state behaviour: `cwd`
// and `HOME` are fixed for the life of `serve`, so a repeating identical fault
// still costs one line, not one per tick. Either way this gate only ever
// controlled the repeated stderr LINE — a fault that differs still reaches the
// browser on the tick it happens, through the `{ error }` gatherSpend returns
// for it, which board.html renders as the panel's text. The board gathers
// every ~15s and a line repeating at that rate just trains the eye to ignore
// it.
//
// The `skips` gate is the same rule, per transcript: a file that is broken is
// broken every tick, and at the default 15s interval three of them are 720 lines
// an hour. Keyed on the FULL PATH, not the bare filename — gatherSpend
// re-resolves its dir on every tick, so a bare-filename key would silence a
// genuinely different broken file living under a second session directory. The
// count still reaches the browser every tick via `skipped`, which is the route
// that matters here.

// Scope is the SESSION directory, which is the closest thing to a run boundary
// that actually exists on disk — one Claude Code session, one folder.
//
// `sinceMs` is opt-in and defaults to no filter. An earlier attempt defaulted it
// to the ledger's mtime as a "run start" marker; that is wrong and silently
// reported zero, because the controller rewrites ledger rows continuously, so the
// mtime is always ~now and every transcript sorts as older than it. Kept as an
// explicit option for the one case the session scope cannot cover: a single
// session that spans two fleet runs, where the caller knows the boundary and the
// board does not.
//
// Three returns, deliberately distinct — collapsing them into one bare null is
// what let the path-encoding bug live: `{ ok: false, error }` is a bug the
// operator must act on and the UI shows it; `null` is the normal "nothing yet"
// and the UI hides the panel; `{ ok: true, ... }` is data.
//
// `ok` is an explicit TAG, and it is what the page switches on — never the
// presence or the truthiness of any other field. Reading the error case off
// `error`'s truthiness is what #959 was: `e.message` is "" for an error thrown
// without one and `undefined` for a thrown non-Error, so two shapes the catch
// below can emit matched neither the error branch nor a success shape, and the
// panel HID — a fault rendered as an idle run, the one conflation this panel
// exists to remove. A presence check would have fixed the "" case and still
// mis-routed the `undefined` one, and either is a refactor away from a
// truthiness check returning, because nothing in the data says which field is
// the tag. This follows `ledger.mjs`'s `tracker`: a boolean checked before any
// success-only field is read.
export function gatherSpend({ dir = findSubagentsDir(), sinceMs = null, topN = 8, explicit = false } = {}) {
  try {
    // #1583: a caller-supplied `null` is a RESOLUTION from one that owns a pin
    // (spendDirPin() above) — the project directory is there and holds no
    // session yet — and must not run the heuristic a second time; only an
    // omitted `dir` (every gatherSpend test driver, and `build`, which is one
    // gather per process and so needs no pin) defaults to it. A default
    // parameter fires on `undefined` alone, never `null`, which is exactly
    // that distinction — the hand-rolled `if (dir === undefined) dir =
    // findSubagentsDir();` this used to spell out is redundant with it.
    //
    // `explicit` (#1679) is true only when `dir` came from the operator's
    // own --spend-dir, never from the heuristic or an unresolved pin — see
    // its one use below, at the empty-directory branch.
    const dirError = dir?.error;
    if (dirError) {
      warnOnce("no-spend-dir", dirError, dirError);
      return { ok: false, error: dirError };
    }
    if (!dir) return null; // resolved, but this session has spawned no agents yet

    const agents = [];
    const toolTables = [];
    let skipped = 0;
    // #602: a corrupt meta sidecar does not throw past readAgent — the agent is
    // still booked, under role "other" and its bare filename as label, which is
    // indistinguishable on the page from a genuinely unnamed agent. `skipped`
    // cannot carry this: that count means "contributed nothing", and this agent
    // still does. A second tally, reaching the browser the same way `skipped`
    // does — via this return and spendView's note — is the channel #325 shipped
    // for the transcript half of this exact fault but not the sidecar half.
    let metaErrors = 0;
    // #916: the transcript-side sibling of the tally above, and the third
    // distinct lie this panel can tell. `skipped` means a transcript
    // contributed NOTHING; `metaErrors` means it contributed under a degraded
    // role and label; `damaged` means it contributed but part of its spend is
    // simply gone — the only one of the three that makes the NUMBERS beside it
    // wrong. Folding it into either of the others would say something false,
    // so it is its own count, summed over the whole dir per tick exactly as
    // they are.
    let damaged = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      const file = join(dir, f);
      // One unreadable transcript must not take the whole panel down with it.
      // The file-level equivalent of the torn-line skip below: a transcript can
      // vanish between readdir and read while an agent is being cleaned up, and
      // losing every other agent's numbers over it would be a blackout, not
      // degradation.
      try {
        // Filter on the transcript's own mtime, not on any timestamp inside it —
        // an agent that ran before this run is simply not this run's cost.
        if (sinceMs != null && statSync(file).mtimeMs < sinceMs) continue;
        const a = readAgent(file, join(dir, f.replace(/\.jsonl$/, ".meta.json")));
        // Both halves computed before either is recorded, so `skipped++` below
        // always means "this transcript contributed nothing" — which is what the
        // UI's "N transcripts skipped" claims. Pushing the agent first would let
        // a throw from the tool half bill the agent AND count it as skipped.
        // Unreachable today: nothing readAgent emits can make attributeTools
        // throw, and readAgent's own throws land here before anything is pushed.
        // Ordering, not a guard — keep it if this block is edited again.
        const tools = attributeTools(a.entries);
        if (a.metaFault) metaErrors++;
        // Beside metaErrors deliberately: past the throw-capable work above and
        // ahead of the push, so the invariant that comment states keeps holding
        // — a transcript that ends up `skipped` ("contributed nothing") can
        // never also report damaged lines on top of it.
        damaged += a.damaged;
        agents.push({
          label: a.meta.description ?? f.replace(/^agent-|\.jsonl$/g, ""),
          role: classifyRole(claudeRoleSignals(a.meta)),
          cacheWrite: a.cacheWrite, output: a.output, cacheRead: a.cacheRead, maxCtx: a.maxCtx,
        });
        toolTables.push(tools);
      } catch (e) {
        skipped++;
        warnOnce("skips", file, `skipping ${file}: ${e.message}`);
      }
    }
    if (!agents.length) {
      if (skipped) return { ok: false, error: `all ${skipped} transcripts unreadable` };
      // #1679: only for an EXPLICIT override — never the heuristic's own
      // "resolved, no session yet" `null` case two arms up, which is the
      // normal state at launch and must stay silent. An operator who named
      // this exact directory has a panel that just went quiet with nothing
      // saying whether that is the normal "not written yet" wait or a typo'd
      // / mis-levelled path (e.g. the session dir instead of its `subagents/`
      // child) that will never resolve.
      if (explicit) warnOnce("empty-spend-dir", dir, `--spend-dir ${dir} exists but holds no agent transcripts`);
      return null;
    }
    const spend = computeSpend({ agents, topN });
    const tools = mergeTools(toolTables);
    // What fraction of cache_creation the tool table actually explains. It is
    // never 100%: only a turn that FOLLOWS a tool result can be attributed to a
    // tool, and an agent's first turn — usually its largest single write, the
    // system prompt and context — follows nothing. Surfacing the coverage keeps
    // the two columns honest about being different bases; without it the tool
    // percentages silently read as shares of the headline number, which they
    // are not.
    const attributed = tools.reduce((n, t) => n + t.cacheWrite, 0);
    const attributedPct = spend.totals.cacheWrite > 0 ? (attributed / spend.totals.cacheWrite) * 100 : 0;
    // `ok` last, so a future field named `ok` on computeSpend's return cannot
    // silently untag a success (a later spread key always wins over an earlier one).
    return { ...spend, tools, attributedPct, skipped, metaErrors, damaged, since: sinceMs, ok: true };
  } catch (e) {
    // A real bug, not an empty run — say so rather than hiding the panel, which
    // is what turned the last type surprise in here into "no panel appeared".
    // `e.message` is carried as-is, including the "" and `undefined` a
    // message-less throw would give it: the tag above is what routes this to the
    // error panel, so an unhelpful message costs wording, never the panel.
    // #1679: an explicit --spend-dir naming a directory that does not exist
    // YET (the legitimate, tested case) throws ENOENT here on every tick
    // until it appears, and this catch used to print unconditionally — one
    // line per ~15s tick, forever. Routed through warnOnce, keyed on the
    // message the same way the `{ error }` arm above it already is, so a
    // repeating fault costs one stderr line, not one per tick.
    warnOnce("spend-read-failed", e.message, `spend read failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// `workspace`/`port` are the caller's answers, never read in here (#1584):
// resolveCockpitInstance() already decided both, and a second derivation in
// this function could disagree with the one the server actually bound. They
// join the payload HERE, alongside the repo fields above, because this is the
// boundary where every impure input meets the pure model — computeBoard() only
// echoes them. Defaulted to null, which is also the degrade arm's workspace
// and the value #1585's handshake refuses to match on, so a caller with no
// instance to name (every gather() test driver) says so rather than omitting
// the fields.
//
// `spendDir` is the caller's PINNED transcript directory (#1583) and is the one
// parameter here whose ABSENCE is not a default to fill in: serve() hands the
// same pin's answer to every tick, and its three shapes — a directory, `null`
// for "resolved, no session yet", `{ error }` for unresolvable — all have to
// reach gatherSpend() as themselves. Only a caller that passed nothing at all
// falls through to the default below, which reads the override flag directly:
// `build` is one gather per process, so it needs the override but never a pin,
// and that read sits here for the same reason argSpendSince()'s does — a
// caller that skips main() still validates its own argv. With neither the pin
// nor the flag, gatherSpend() resolves for itself exactly as it did before
// this ticket, which is what keeps `build`'s output unchanged by it.
//
// `spendDirExplicit` (#1679) is read the same way, independently of
// `spendDir` itself: serve() always passes a resolved `spendDir` (the pin's
// answer), never leaving it to default, so `spendDir`'s own presence cannot
// say whether an operator named it. Whether --spend-dir was given is a fact
// about argv, unrelated to which of gatherSpend's three shapes the pin
// currently holds.
export function gather({ ledgerFile, prevFile, stateFile = null, scriptDir = SCRIPT_DIR, interval, workspace = null, port = null, spendDir = argSpendDir(), spendDirExplicit = argSpendDir() != null }) {
  // The one read that must not crash the gather: a corrupt/partial board.json
  // (the fallback safety net itself) is ignored, not fatal. That holds for a
  // SHAPE fault as much as a parse fault (#1192) — the guard below rejects the
  // payload here so both leave through the one catch, which names the file the
  // operator passed. A wrong-typed `tickets` left to reach the prevCi map
  // instead throws `.filter is not a function` out of gather(), which made a
  // corrupt prev board fatal after all and blamed an "intermediate value".
  //
  // Validated HERE and not per-read, deliberately: this payload has three more
  // readers (`prev?.repo`/`prev?.repoUrl` below, and compute-board.mjs's dwell
  // tracking, which consumes the whole `prev` this returns), and the prevCi
  // expression's `|| []` is the demonstration — it defends against an ABSENT
  // `tickets`, never a present one of the wrong type. This guard covers that one
  // shape — `prev` is an object, `tickets` is an array of objects — not every
  // field those three readers go on to trust: a wrong-typed `repo`, `repoUrl`, or
  // `sinceEnteredStage` still reaches them unchanged. Those `?.`/`|| []` defaults
  // stay as the belt to these braces.
  let prev = null;
  if (prevFile && existsSync(prevFile)) {
    try {
      // JSON.parse SUCCEEDS on `null`, a bare number, a string and an array,
      // none of which is a board; `null` in particular is absent, not an
      // object, and `typeof null` alone would wave it through. Same check and
      // same wording as readAgent's sidecar-meta read, which is this repo's
      // precedent for rejecting a parsed-but-wrong payload at its own read —
      // since #1546 literally the same, both calling the shared predicate.
      const p = JSON.parse(readFileSync(prevFile, "utf8"));
      if (!isJsonObject(p)) throw new TypeError(`expected a JSON object, got ${jsonKind(p)}`);
      // Nullish `tickets` is ABSENT and stays usable: `|| []` reads it as the
      // empty carry-forward, which is what a board with no PRs on it says.
      // Only a present-and-wrong-typed one is a fault.
      if (p.tickets != null) {
        if (!Array.isArray(p.tickets))
          throw new TypeError(`expected tickets to be an array, got ${typeof p.tickets}`);
        // Per ENTRY too, and not because a `[null]` is exotic: `Array.isArray`
        // is satisfied by an array of anything, and the very next thing the
        // prevCi map does is read `t.pr` off each element. The whole payload
        // goes, not the bad entry — a board with one unreadable ticket is not a board
        // whose others can be trusted to carry CI state forward, and filtering here
        // (drop the bad entry, keep the rest) would make this a new, fourth policy for
        // one payload class in this file — mapCi's null-only guard and tryParse's
        // unguarded read are the other two — rather than the reject-whole-payload
        // policy this guard already shares with readAgent's sidecar-meta read.
        const bad = p.tickets.findIndex((t) => !isJsonObject(t));
        if (bad !== -1)
          throw new TypeError(`expected tickets[${bad}] to be a JSON object, got ${jsonKind(p.tickets[bad])}`);
      }
      prev = p;
    }
    catch (e) { console.error(`${NAME}: ignoring unreadable prev board ${prevFile}: ${e.message}`); }
  }

  // `--require-file` turns an absent ledger into a refusal at exit 2 rather
  // than the empty payload a real empty ledger returns (#816). Without it the
  // two are byte-identical on stdout, and tryParse's fallback is that same
  // empty shape besides — so an unread ledger, one read empty, and a read whose
  // answer would not parse were three states with one rendering, on the one
  // subcommand this cockpit consumes.
  //
  // The three stay three here because each is a different observation, not a
  // different value of one: null from tryRun is a read that did not happen (the
  // refusal, or an unreachable node), null from tryParse is a read whose answer
  // was unusable, and anything else is the ledger. `tryParse`'s fallback is
  // null rather than the empty shape for exactly that reason — the empty shape
  // is a real answer and must not double as the failure.
  const ledgerJson = tryRun("node", [join(scriptDir, "ledger.mjs"), "--file", ledgerFile, "--require-file", "read"]);
  // "read" means ledgerJson parsed as JSON, not that it conforms to the
  // {rows,filed,ruled} shape — tryParse only checks syntax, so a
  // syntactically-valid-but-wrong-shape payload from ledger.mjs would still
  // be labelled "read" here. ledger.mjs is this repo's own, already-tested
  // producer of this JSON, so that gap is accepted rather than guarded.
  const parsedLedger = tryParse(ledgerJson, null, "ledger read");
  // Strictly `!== null`, never falsiness — a ledger payload that parses to
  // `0`, `false` or `""` is a real answer tryParse already forwarded (see
  // tryParse's own comment above), and treating it as falsy here would
  // silently discard it into `unparsed`, the exact bug class tryParse's
  // guard exists to prevent, one caller downstream of the fix.
  const ledger = parsedLedger !== null
    ? { ...parsedLedger, state: "read" }
    : { rows: [], filed: [], ruled: [], state: ledgerJson == null ? "unread" : "unparsed" };

  const issuesJson = tryRun("gh", ["issue", "list", "--label", "ready-for-agent",
    "--state", "open", "--limit", "100", "--json", "number,title,labels"]);
  // title: falls back to the same `#<number>` placeholder titleFor() already
  // uses for an issue it cannot find at all (compute-board.mjs). An unrowed
  // issue becomes a POOL card straight from this array — compute-board.mjs's
  // POOL loop reads `iss.title` RAW, never through titleFor()'s fallback
  // chain — so this row genuinely needs a guaranteed string: an issue found
  // but unable to describe itself reads as its number rather than literal
  // `undefined` on the operator's page (#786).
  const issues = ghRows(issuesJson, "gh issue list").map((i) => ({
    number: i.number,
    title: typeof i.title === "string" ? i.title : `#${i.number}`,
    labels: labelsOf(i),
  }));

  const prsJson = tryRun("gh", ["pr", "list", "--state", "open", "--limit", "100",
    "--json", "number,state,labels,title"]);
  // No default for `title` or `state` here, unlike the issue row above — raw
  // passthrough, deliberately. `title`: compute-board.mjs's titleFor() already
  // falls through a falsy `pr.title` to the real issue title (`if (pr &&
  // pr.title) return pr.title;`); nothing else reads a PR row's `title` field
  // raw, so defaulting it to `#<number>` made it unconditionally truthy and
  // SILENTLY DISABLED that fallback — a titleless PR row showed the PR number
  // instead of the real issue title, worse than doing nothing. `state`: its
  // only consumer is `pr.state === "OPEN"` (compute-board.mjs), already false
  // for `undefined` exactly as it was for the old "UNKNOWN" sentinel, so the
  // default was inert — pure indirection with no behaviour to show for it.
  const prs = ghRows(prsJson, "gh pr list").map((p) => ({
    number: p.number,
    state: p.state,
    title: p.title,
    labels: labelsOf(p),
  }));

  // CI per open PR. On failure, carry the previous board's value for that PR.
  const prevCi = new Map((prev?.tickets || []).filter((t) => t.pr != null).map((t) => [t.pr, t.ci]));
  const ci = {};
  for (const p of prs) {
    const out = runCiState(scriptDir, p.number);
    ci[p.number] = out === null ? (prevCi.get(p.number) ?? "unknown") : mapCi(out, p.number);
  }

  // Repo identity + web URL for PR links — the url carries the host, so links
  // resolve on GitHub Enterprise, not just github.com. From the fleet's cwd, so
  // the board stays repo-agnostic. On failure, carry the previous board's values.
  const repoJson = tryRun("gh", ["repo", "view", "--json", "nameWithOwner,url"]);
  let repo = prev?.repo ?? null;
  let repoUrl = prev?.repoUrl ?? null;
  if (repoJson) {
    try { const d = JSON.parse(repoJson); repo = d.nameWithOwner ?? repo; repoUrl = d.url ?? repoUrl; }
    catch (e) { console.error(`${NAME}: gh repo view parse failed: ${e.message}`); }
  }

  // #1076: guard's own rationale (fail loud, gate on presence and on range,
  // not just finiteness) now lives at argSpendSince()'s definition above,
  // alongside argPort()/argInterval() — this call is unchanged in when it
  // runs, only in where the check itself is written.
  const sinceMs = argSpendSince();
  const spend = gatherSpend({ dir: spendDir, sinceMs, explicit: spendDirExplicit });
  // #1597: the heartbeat's mark, raw. readState() never throws — an absent
  // file is the ordinary state of a run whose heartbeat has not beaten yet,
  // and an unreadable or corrupt one announces itself on stderr and degrades
  // to no mark, which computeBoard() renders as no panel rather than as a
  // death it cannot substantiate. So no try/catch here and no `tryRun` shape:
  // the degrade lives in the module that owns the file.
  //
  // `null` when no caller named a state file, and DISTINCT from a file that
  // is simply absent: both omit the surface today, but only the second is a
  // reading. Defaulted rather than resolved here for gather()'s own reason —
  // every caller in this file passes the instance's answer, and a second
  // resolution could name a different workspace's beat.
  const beat = stateFile ? readState(stateFile, NAME).beat : null;
  return { ledger, issues, prs, ci, prev, repo, repoUrl, workspace, port, spend, beat, now: Date.now(), interval: interval ?? argInterval() ?? 15 };
}

async function main() {
  // #365: a misspelled flag was never looked for, so `serve --prot 9000`
  // served on the default 8123 in silence. In main(), not at module scope:
  // board.test.mjs and board-cli.test.mjs both import from this module, so a
  // module-scope sweep would read the TEST RUNNER's argv.
  //
  // One set for both subcommands, deliberately. `--port`/`--open` are USED
  // only by serve() and `--prev` only by build, so a WELL-FORMED `build
  // --port 5` is accepted and its value simply unused — narrowing the set per
  // subcommand would close that too, but that is a larger design question
  // (per-subcommand arg schemas) this ticket does not take; refusing a flag
  // this file does accept somewhere is not this ticket's business. What
  // build no longer does is stay silent on a MALFORMED one — see #468 below.
  //
  // Above `cmd`, so `board.mjs --prot 9000` names the stray rather than
  // printing the usage line for a missing subcommand. `build`/`serve` carry
  // no `--` and are never the sweep's business.
  // One list rather than the same six names spelled out in the sweep and in
  // both stray() calls below. `open` is not in it: it is boolean (has()), so
  // it never has a value token for stray() to skip over, and the sweep needs
  // the name anyway.
  const VALUE_FLAGS = ["ledger", "prev", "port", "interval", "spend-since", "spend-dir"];
  sweep([...VALUE_FLAGS, "open"]);
  const cmd = process.argv[2];
  // #1656: no default applied here any more — `build` and `serve` now each
  // apply their own. `build` has no workspace instance to default against
  // (no state directory, no board), so it keeps today's cwd-relative literal
  // below. `serve` defaults against `resolveCockpitInstance()`'s stateDir
  // instead, so an absent --ledger still points at the SAME workspace the
  // served state directory does, rather than the caller's raw cwd.
  const ledgerFile = arg("ledger");

  // #468: argPort()/has("open") used to run only inside serve(), so `build
  // --port abc` and `build --open=1` were accepted and silently ignored — the
  // malformed spellings these guards exist to refuse never ran on that path.
  // Called here, once, ahead of the build/serve dispatch (and ahead of both
  // branches' own stray() call, so a malformed value still wins the specific
  // wording over stray()'s generic one, same ordering rule arg.mjs documents
  // for every other value guard in this file). Ahead of the `cmd` check too,
  // so `board.mjs --port abc` with NO subcommand names the flag rather than
  // falling through to the usage die below — the same precedence the #365
  // sweep note above claims for a stray, now true of these two guards as
  // well. Both orderings are pinned in board.test.mjs; before this fix the
  // no-subcommand shape printed the usage line (measured). The return values are
  // deliberately discarded on the build path: build has no server to bind or
  // browser to open, so a WELL-FORMED --port/--open still does nothing here,
  // exactly like before this fix — only the malformed spellings now refuse.
  // serve() below still calls its own argPort()/has("open"); re-evaluating a
  // pure read of argv costs nothing and keeps the EXPORTED serve() validating
  // its own argv for a caller that skips main(). Nothing in this repo is such
  // a caller today — every serve() test drives the real CLI, which enters
  // main() — but serve() is public surface, so the guard stays with it.
  // #1092: unlike --port/--open (never read on `build` before #468) or
  // --ledger/--spend-since/--interval (already read on `build`, per the
  // header comment above), --prev was read on exactly one subcommand and it
  // was the wrong one to skip: `arg("prev")` sat inside the `build` branch
  // alone, and serve()'s own signature carries no `prev` parameter at all —
  // so `serve --prev`, `serve --prev=x` and `serve --prev --port 9000` all
  // fell through with no guard ever firing (measured), the last one blaming
  // --port's innocent value once stray() reached it instead. Hoisted here
  // for the same reason #468 hoisted argPort()/has("open") below it — ahead
  // of the dispatch and both branches' stray() calls — and ahead of argPort()
  // itself so a caller who gets BOTH flags wrong at once (`--port --prev`,
  // each trailing with no value) still hears about --prev specifically,
  // rather than whichever guard happens to run first. The old in-branch read
  // inside `build` is gone; this is now the only read, and its value reaches
  // gather() exactly as before — discarded on serve, same as --port/--open
  // are discarded on build.
  const prevFile = arg("prev");
  argPort();
  has("open");

  // #1076: same fail-open shape as --port/--open above (#468) — this closes
  // the two flags PR #1090 (#468) left standing. `argInterval()`'s read had
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
  // argPort()/has("open") already sit — build discards both return values,
  // same as it already discards argPort()'s. serve() below still calls its
  // own argInterval() (via `interval ?? argInterval() ?? 15`) and gather()
  // still calls its own argSpendSince() — re-evaluating a pure read of argv
  // costs nothing, and keeps both validating their own argv for a caller
  // that skips main(), same reasoning #468 gives for argPort()/has("open").
  argInterval();
  argSpendSince();
  // #1583: `--spend-dir` joins them for the same two reasons, from the day it
  // ships rather than one ticket later — it is read on both subcommands (in
  // gather()'s default, and through serve()'s pin), and a trailing
  // `--spend-dir` ahead of a stray positional has to name itself instead of
  // the token behind it. build discards the value here exactly as it discards
  // argPort()'s; gather() below does the read that reaches the panel.
  argSpendDir();

  // #463: sweep() above only refuses a `--`-prefixed token; a bare or
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
    stray(VALUE_FLAGS, ["build", "serve"]);
    const { computeBoard } = await import("./compute-board.mjs");
    // #1584: a snapshot printed here outlives the process that printed it —
    // redirected to a file, pasted into a ticket, read back by the next
    // launch — so it says which workspace it describes and which port that
    // workspace's cockpit answers on. The same seam serve() uses, so the two
    // subcommands can never name different instances from one cwd.
    //
    // No `port:` argument, deliberately: --port is read and DISCARDED on this
    // path (#468 above), and honouring it here would give the flag a meaning
    // on `build` it has never had. The DERIVED port is the identity anyway —
    // it is the port this workspace is reachable on, which is what a stray
    // snapshot needs to name; the port some one-shot invocation happened to
    // ask for is not.
    //
    // The default ledger stays the cwd-relative literal #1656 left here. That
    // is not an oversight to fix in passing: `build` prints to stdout and
    // writes no state directory, so the argument that moved serve()'s default
    // onto the workspace does not reach it, and changing it would change what
    // an existing `build` reads.
    const instance = resolveCockpitInstance({ cwd: process.cwd(), gitCommonDir: gitCommonDir() });
    const model = computeBoard(gather({
      ledgerFile: ledgerFile || ".fleet/ledger.md", prevFile,
      // #1597: the heartbeat's file, from the SAME instance the identity
      // fields below come from — not the cwd-relative literal the ledger
      // default keeps. That literal is `build`'s own back-compatibility (see
      // the note above); the mark has no existing `build` behaviour to
      // preserve, so it starts out resolved, and a snapshot printed from a
      // worktree names the run's real beat instead of a file that is not
      // there.
      stateFile: stateFileIn(instance.stateDir),
      workspace: instance.workspace, port: instance.port,
    }));
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  if (cmd === "serve") {
    stray(VALUE_FLAGS, ["build", "serve"]);
    await serve({ ledgerFile });
    return;
  }
  die("usage: board.mjs build|serve [--ledger <path>] [--port N] [--interval N] [--open] [--spend-since <epoch-ms>] [--spend-dir <path>]");
}

import { copyFileSync, mkdirSync } from "node:fs";

export function createBoardServer(dir) {
  return createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const path = url === "/" || url === "/board.html" ? join(dir, "board.html")
      : url === "/board.json" ? join(dir, "board.json") : null;
    if (!path || !existsSync(path)) { res.writeHead(404); res.end("not found"); return; }
    const type = path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(readFileSync(path));
  });
}

// A cockpit instance is identified by its WORKSPACE — the directory holding
// the shared git dir — not by the process's cwd and not by the machine. Two
// workspaces therefore get two boards on two ports, both live and neither
// aware of the other, and one workspace gets the SAME port on every run, so
// the URL survives runs, reboots and node versions.
//
// BASE is the port this file hardcoded before any of this existed, so the
// single-workspace case keeps the familiar URL. SPAN is deliberately narrow:
// the range an operator has to scan is what widening it costs, and a
// collision between two DIFFERENT workspaces is out of this seam's scope —
// nothing here reuses, hands off or falls back off a port already held, and
// serve()'s pre-existing EADDRINUSE refusal still owns that case.
const PORT_BASE = 8123;
const PORT_SPAN = 512;

// FNV-1a, 32-bit, written out inline. Three properties this needs that no
// crypto digest and no Math.random has together: stable across node versions
// and across machines (nothing in here reads the engine, the host or the
// clock), dependency-free, and cheap enough to run on every start. Math.imul
// is the whole reason it is spelled this way — a plain `h * 0x01000193`
// leaves exact integer range after two rounds and silently stops being FNV.
// `>>> 0` is load-bearing, not decoration: without it `h` stays SIGNED, so
// `h % PORT_SPAN` can come back negative and the derived port lands BELOW
// base, outside the window this function's own contract promises.
function workspaceHash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The one spelling of "this value is a workspace identity", read by every
// side of the cockpit handshake (#1661). The invariant is that null and the
// empty string are never an identity to match on, and it used to be carried
// by two independently-written guards — resolveCockpitInstance()'s
// `workspace === null` below and probeCockpitWorkspace()'s
// `typeof w === "string" && w !== ""` — correct only because both were
// written consistently, not because anything stopped one from moving without
// the other. What a drift buys is silent and cross-workspace: let the
// construction side call the empty string an identity while the parsing side
// still accepts it, and two cockpits in two different workspaces, neither
// with an identity established, match each other's board and one reuses the
// other — a hand-off nothing else in this file would refuse, since the
// degrade arm's "no identity to match on" is the only thing keeping a held
// port fatal there.
//
// A non-empty string, and nothing more: no trim(). A wholly-whitespace
// answer to `--git-common-dir` is already refused one layer down, by
// git-env.mjs's workspaceDirFromGitCommonDir(), so no identity reaching
// either call site can be whitespace — the construction side gets that
// function's return value and the parsing side gets a payload some process
// wrote from it. A second whitespace rule here would be one more guard of
// exactly the kind this predicate exists to stop writing.
//
// Not exported, for workspaceHash()'s reason above it: nothing outside this
// file asks the question, and every widening of it is already pinned from
// outside through the two call sites — mutation-verified for this extraction
// (#1661), each mutant killed by a test that was already in board.test.mjs:
// `v != null && v !== ""` by the probe's not-a-string row, `typeof v ===
// "string"` by its empty-workspace row, a degrade arm publishing `""` by
// resolveCockpitInstance's three degrade rows, and dropping it from
// serve()'s `scannable` by the CLI's held-port-on-the-degrade-arm row. So no
// test is added here: sharing the predicate is what makes the construction
// side's rows constrain the parsing side and back, which is a STRONGER suite
// than before, not one with a hole a new row could fill.
function isWorkspaceId(v) {
  return typeof v === "string" && v !== "";
}

/**
 * The cockpit's instance seam, and the only one. Given a cwd, the string
 * `git rev-parse --git-common-dir` answered with — INJECTED, never read in
 * here, which is what keeps the worktree case and the resolution-failed case
 * both plain table rows — and an explicitly requested port if there was one,
 * decide which state directory this cockpit serves and which port it binds.
 *
 * Pure: it listens to nothing, spawns nothing and writes nothing, so every
 * branch below is reachable from a test with no git repo and no socket. The
 * one thing it reads is realpath — asked for by `canonicalise: true` below,
 * and unable to fail the call either way.
 *
 * `--git-common-dir` answers with the MAIN checkout's git dir from inside a
 * linked worktree, so every worktree of one repo resolves to ONE state
 * directory. That resolution is not spelled here: since #1658 it is
 * git-env.mjs's workspaceDirFromGitCommonDir(), the same function
 * ledger.mjs's defaultLedgerPath() and fleet-state.mjs's statePath() resolve
 * the run's single ledger and single heartbeat with — so the board, the
 * ledger and the heartbeat cannot disagree about which run they belong to.
 * The `canonicalise` opt-in is this caller's alone: it is what makes a
 * symlinked route to one workspace derive that workspace's port instead of a
 * second, private one, and neither of the other two takes it (canonicalising
 * their answer would change the path each of them prints without changing
 * which file it names).
 */
export function resolveCockpitInstance({ cwd = process.cwd(), gitCommonDir, port } = {}) {
  // `port != null`, never truthiness: --port 0 is a real request (an
  // ephemeral bind, #366/#435) and reading it as "absent" would derive a port
  // straight over the top of one the caller explicitly asked for.
  const forced = port != null;
  const workspace = workspaceDirFromGitCommonDir(gitCommonDir, cwd, { canonicalise: true });
  // Asked as `!isWorkspaceId(...)` rather than `=== null`: the question this
  // arm answers is "was an identity established", and what counts as one is
  // the predicate above — the same one the probe parses with, so the two
  // sides cannot answer it differently. The behaviour is today's exactly:
  // workspaceDirFromGitCommonDir() answers null for every unusable
  // `--git-common-dir` and dirname() cannot answer "". It is the SHAPE of
  // the question that stops being written out twice.
  if (!isWorkspaceId(workspace)) {
    // Degrade, never die: a non-git or otherwise unusual checkout still gets
    // a board. The wording is defaultLedgerPath()'s rather than a second
    // dialect for the same failure, trailing parenthetical included — that
    // parenthetical names what is degraded HERE, which is not what is
    // degraded there. No cause is interpolated where the ledger interpolates
    // one: this function never ran the probe, so it has none to name, and the
    // ledger's own template already emits exactly this arm when its cause is
    // empty.
    console.error(`${NAME}: WARNING could not resolve --git-common-dir; using cwd-relative .fleet (a second cockpit in another workspace may collide on this port and this state directory)`);
    // Absolute, like the resolved arm, but anchored on the cwd — which is
    // what "cwd-relative" resolves to and what this script's fs calls did
    // with the bare `.fleet` they used before. No workspace was established,
    // so there is no key to hash and the port is BASE: today's default,
    // unchanged, for the case that used to be the only case.
    return { stateDir: join(cwd, ".fleet"), workspace: null, port: forced ? port : PORT_BASE, derived: !forced };
  }
  return {
    stateDir: join(workspace, ".fleet"),
    workspace,
    port: forced ? port : PORT_BASE + (workspaceHash(workspace) % PORT_SPAN),
    derived: !forced,
  };
}

// The impure half, deliberately outside the seam above. Bounded for the
// reason #1199 bounded the ledger's identical probe: an unbounded git that
// never returns hangs serve() before it binds anything, with nothing on
// stderr to say why. Ambient GIT_DIR/GIT_WORK_TREE scrubbed (#1599) — either
// one answers `--git-common-dir` for a DIFFERENT repository, which would
// serve this cockpit out of someone else's workspace at exit 0, in silence.
// A non-zero exit, a stall and git missing entirely all land on "" and take
// the degrade arm above; the seam is total over whatever comes back.
const GIT_TIMEOUT_MS = 10_000;
function gitCommonDir() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: gitEnv() });
  return r.status === 0 ? r.stdout : "";
}

// How many ports one launch may try before it gives up, and the whole cost
// of the scan: the worst case is ATTEMPTS × (a bind plus a probe), so a
// workspace whose derived port sits in a crowded corner of the range still
// fails in seconds rather than walking all 512. It also bounds how far a
// cockpit can land from the stable URL its workspace derives — a board a
// handful of ports from where it is bookmarked is still findable by hand,
// while one hundreds of ports away (where an unbounded scan could leave it)
// typically is not.
const PORT_ATTEMPTS = 8;

/**
 * The ports one launch may try, in order, for a resolved instance — the
 * second half of the instance seam and pure like the first, so every row
 * below is reachable with no socket.
 *
 * An EXPLICIT port collapses to a single candidate: the operator named a
 * port, so there is nothing to scan and (guarded separately in serve()) no
 * holder to handshake with.
 *
 * A DERIVED one starts at the derived port — the stable, bookmarkable one —
 * and walks forward MODULO the span, never out of the window
 * resolveCockpitInstance() promises. Without the wrap a workspace hashing to
 * the top of the range would scan straight past 8634 into ports belonging to
 * nothing in this scheme, and the range this exists to stay inside would be
 * a range in name only.
 */
export function cockpitPorts({ port, derived }) {
  if (!derived) return [port];
  const offset = port - PORT_BASE;
  return Array.from({ length: PORT_ATTEMPTS }, (_, i) => PORT_BASE + ((offset + i) % PORT_SPAN));
}

// One bind attempt, as a value rather than as an event. Resolves with null
// on success and with the error otherwise — never rejects, because every
// caller has to READ the code (EADDRINUSE is negotiable, everything else is
// fatal) and a rejection would make that a try/catch around a control-flow
// decision. The listeners are removed on whichever side loses: a server that
// failed to bind is dropped, and one that bound gets serve()'s own long-
// lived error handler instead of this one-shot.
function bindFailure(server, port) {
  return new Promise((resolve) => {
    const onError = (e) => { server.removeListener("listening", onListening); resolve(e); };
    const onListening = () => { server.removeListener("error", onError); resolve(null); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

// ~1s per attempt, and the whole reason this is a probe and not a lockfile:
// a launch that cannot get an answer within a second must proceed, not
// wait. A holder that accepts the connection and then says nothing is the
// case that pays for this timer — nothing else in a socket read bounds it.
// One silent window does not settle the question, though: a genuine
// same-workspace holder can be blocked inside its own synchronous gather()
// (gh/ledger.mjs calls) exactly when the probe arrives, and that looks
// identical from outside to nobody being there at all. The probe retries
// once before it will call a silent port foreign (#1660).
const PROBE_TIMEOUT_MS = 1000;
// 127.0.0.1 rather than `localhost`: no resolver in the path of a launch,
// and no chance of asking a different address than the one every cockpit
// here binds. The announced URL stays `localhost`, which is the operator's
// spelling, not this probe's.
const PROBE_HOST = "127.0.0.1";
// A holder is not necessarily a cockpit, and a second of localhost writes is
// a lot of memory to accept from one. The board payload for a real run is
// kilobytes; anything past this is not one, so it is refused as foreign
// rather than buffered.
const PROBE_BODY_CAP = 1024 * 1024;

/**
 * Ask whoever holds `port` which workspace it is serving. Returns that
 * workspace, or null for every other outcome there is — a refused
 * connection, a non-200, a body that is not JSON, a payload with no usable
 * `workspace`, a body over the cap, or a holder that never answers across
 * two attempts.
 *
 * Null is deliberately one value for all of them: the caller's question is
 * "is this my own cockpit", and every way of failing to prove that is the
 * same answer — foreign. A holder that IS this workspace's cockpit answers
 * with the board payload it already serves, so no endpoint is added for
 * this and the handshake reaches nothing a browser could not. The one
 * consequence to know: a cockpit started from a build older than #1585
 * serves a payload with no `workspace` at all, so it reads as foreign and a
 * launch steps over it rather than reusing it — once, until that process is
 * restarted.
 *
 * A bare timeout gets one retry (#1660) rather than folding straight into
 * "foreign": nothing in a socket read distinguishes "nobody is there" from
 * "busy", and a holder mid-gather() looks exactly like the first from out
 * here. Only a second silent window calls it, and says so on stderr
 * distinctly from a confirmed non-match — a shrug is not a verdict.
 */
export function probeCockpitWorkspace(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let attempts = 0;
    const probeOnce = () => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        req.destroy();
        attempts += 1;
        if (attempts < 2) { probeOnce(); return; }
        console.error(`${NAME}: no answer from port ${port} within ${timeoutMs * 2}ms — cannot confirm it is this workspace's cockpit`);
        resolve(null);
      }, timeoutMs);
      function finish(workspace) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Destroy rather than let it drain: an unread body, or a holder
        // still writing one, would otherwise keep this socket — and the
        // launch — alive well past the answer.
        req.destroy();
        resolve(workspace);
      }
      const req = httpRequest({ host: PROBE_HOST, port, path: "/board.json", method: "GET" }, (res) => {
        if (res.statusCode !== 200) { finish(null); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; if (body.length > PROBE_BODY_CAP) finish(null); });
        res.on("end", () => {
          let w;
          try { w = JSON.parse(body)?.workspace; } catch { finish(null); return; }
          // Exactly the construction side's rule, because it is literally
          // the same predicate (#1661): a non-string, or the empty string,
          // is no identity. `=== ours` would be false for the first anyway,
          // but an empty string could match an empty workspace and there
          // must be no such thing.
          finish(isWorkspaceId(w) ? w : null);
        });
      });
      req.on("error", () => finish(null));
      req.end();
    };
    probeOnce();
  });
}

export async function serve({ ledgerFile, port, interval, open, spendDir } = {}) {
  // Both the served state directory and the port come from
  // resolveCockpitInstance() now, rather than a cwd-relative `.fleet` and a
  // constant 8123. That is what lets two workspaces run two boards at once
  // without either writing into the other's state directory, and it ties the
  // board to the same workspace the ledger resolves itself against.
  //
  // A GIVEN-but-invalid --port is refused outright by argPort() and never
  // reaches here; an ABSENT one leaves `portGiven` nullish, which is how the
  // seam is told to derive rather than obey. `??` and not `||`, for #366's
  // reason: --port 0 is a legal ephemeral bind and `||` would discard it.
  //
  // A bind failure no longer means one thing, so the two kinds of port part
  // company here. One this script DERIVED is negotiable: the loop below
  // handshakes with whoever holds it and steps over a stranger (#1585). One
  // the caller CHOSE is not — the refusal names that port bare and dies,
  // because scanning off it would serve the board somewhere the operator did
  // not ask for and reusing it would hand them someone else's. What tells
  // them apart is `instance.derived` and not truthiness on `portGiven`: an
  // explicit `--port 0` is falsy (#366's legal ephemeral bind), so the old
  // spelling gave it the derived port's treatment, and nothing pinned that.
  const portGiven = port ?? argPort();
  interval = interval ?? argInterval() ?? 15;
  open = open ?? has("open");
  // #1583: built HERE, once, and read by every tick below. Beside the other
  // argv reads rather than inside tick() for the obvious reason — a pin rebuilt
  // per tick is a pin in name only — and above the port loop because it costs
  // nothing to carry: spendDirPin() touches no filesystem until its first call,
  // so the reuse and degrade arms that exit before ticking pay nothing for it.
  // `spendDir ?? argSpendDir()` (#1679), matching the `port ?? argPort()`
  // shape above: every other argv-read option here takes an in-process
  // override, and this one hadn't, so the only way to drive --spend-dir
  // through `serve` at all was the real CLI — no test exercised it.
  const spendPin = spendDirPin(spendDir ?? argSpendDir());
  const { computeBoard } = await import("./compute-board.mjs");
  const instance = resolveCockpitInstance({ cwd: process.cwd(), gitCommonDir: gitCommonDir(), port: portGiven });
  const stateDir = instance.stateDir;
  const jsonPath = join(stateDir, "board.json");
  // #1656: the ledger's own default (ledger.mjs's defaultLedgerPath()) is
  // never reached here — board.mjs always passes an explicit --file — so an
  // absent --ledger has to be defaulted against the SAME instance the state
  // directory came from, not a cwd-relative literal. A worktree or a
  // subdirectory cwd previously left this pointing at a ledger.md that does
  // not exist there, while the state directory (above) had already moved to
  // the workspace: the board and the ledger could disagree about which run
  // they belonged to, exactly what resolveCockpitInstance() exists to rule
  // out (#1656 review).
  ledgerFile = ledgerFile || join(stateDir, "ledger.md");
  // `served` is the port this process actually BOUND, handed in rather than
  // closed over: it is not knowable until listen() returns (--port 0 is an
  // ephemeral bind, #366/#435, and the loop below may also land past a
  // candidate it could not take), and a tick that reached for `portGiven`
  // instead would stamp every board served on an ephemeral port with a
  // `port: 0` no browser could ever reach. A parameter makes that
  // unreachable rather than merely unlikely — there is no earlier value in
  // scope for it to pick up.
  const tick = (served) => {
    try {
      // #1585: the identity a second launch's handshake reads off this
      // cockpit. It rides the board payload deliberately, rather than a
      // lockfile or a second endpoint: a payload exists only while the
      // process serving it does, so nothing written here can outlive this
      // cockpit and send the next launch at a port nobody holds. It is null
      // on the degrade arm — no workspace was established — which is exactly
      // the value no launch may ever match on.
      //
      // #1584: joined at gather(), not stamped onto the finished model. The
      // assignment that used to sit below this line wrote a field the pure
      // model did not declare, so `build` printed a board with no identity
      // at all and only the served copy carried one.
      const model = computeBoard(gather({
        ledgerFile, prevFile: jsonPath, interval,
        // #1597: beside the ledger and out of the same state directory, so
        // the board, the ledger and the heartbeat cannot disagree about which
        // run they belong to — the invariant resolveCockpitInstance() exists
        // for. Re-derived per tick rather than closed over, exactly like
        // `ledgerFile`: it is a pure join on a directory settled at bind time.
        stateFile: stateFileIn(stateDir),
        workspace: instance.workspace, port: served,
        // The pinned transcript directory, not a fresh lookup: every tick after
        // the first gets the SAME answer, which is what stops the panel
        // alternating between two sessions under one project directory (#1583).
        spendDir: spendPin(),
      }));
      const tmp = `${jsonPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(model));   // atomic: write tmp, rename over target
      renameSync(tmp, jsonPath);
    } catch (e) { console.error(`${NAME}: build tick failed: ${e.message}`); }
  };

  // #1660: a held port used to mean three different things this loop could
  // only tell apart by binding first and probing whichever candidate
  // happened to refuse — so a live cockpit that landed past a squatter
  // which has since departed was invisible the moment that squatter's port
  // freed (this process would just bind it directly), and a workspace with
  // no identity established (the degrade arm) still scanned past a held
  // port with nothing a handshake could ever match, reopening the
  // dual-cockpit hazard #1656 closed.
  //
  // Bind stays the FIRST thing tried per candidate: that is what lets two
  // launches racing at start settle on one winner quickly, the winner's
  // identity published (below) before it can block inside its own gather().
  // But a successful bind is not the end of the story — once this process
  // holds a candidate, the REST of the window still gets checked for a
  // live cockpit that landed further along, exactly the shape a departed
  // squatter leaves behind, and only when nothing there matches does this
  // process keep what it bound. A held candidate is probed the same way,
  // one at a time as the loop reaches it. Neither check runs at all when
  // this workspace has no identity to match on: an explicit --port
  // (`!instance.derived`) and the degrade arm (no `isWorkspaceId` identity)
  // never had a handshake to reach in the first place, so a held port for
  // either stays fatal, exactly as it was before #1585 existed.
  const candidates = cockpitPorts(instance);
  const scannable = instance.derived && isWorkspaceId(instance.workspace);
  let server = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attempt = createBoardServer(stateDir);
    const failure = await bindFailure(attempt, candidate);
    if (!failure) {
      const rest = scannable ? candidates.slice(i + 1) : [];
      const holders = await Promise.all(rest.map((p) => probeCockpitWorkspace(p)));
      const matchAt = holders.indexOf(instance.workspace);
      if (matchAt === -1) { server = attempt; break; }
      attempt.close();
      const url = `http://localhost:${rest[matchAt]}/`;
      console.error(`${NAME}: cockpit already running for this workspace on ${url}`);
      if (open) tryRun("open", [url]);
      // Exit 0 — and explicitly, not by returning: a backgrounded launch
      // reports nothing but its exit code, and a handle left behind by the
      // probe would otherwise hang this process forever while it holds no
      // port at all.
      process.exit(0);
    }
    // Only a port that is TAKEN is a candidate for any of the below. EACCES
    // on a privileged port, EADDRNOTAVAIL on an unusable address: those are
    // faults of their own, and scanning past them would bury each one under
    // an exhausted-range message at the end that names the wrong problem.
    if (failure.code !== "EADDRINUSE") die(failure.message);
    if (!scannable) die(`port ${candidate} in use — pass --port <n>`);
    const holder = await probeCockpitWorkspace(candidate);
    if (holder === instance.workspace) {
      const url = `http://localhost:${candidate}/`;
      console.error(`${NAME}: cockpit already running for this workspace on ${url}`);
      if (open) tryRun("open", [url]);
      process.exit(0);
    }
    console.error(`${NAME}: port ${candidate} is held by something that is not this workspace's cockpit — trying the next port`);
  }
  if (!server) die(`no free port for this workspace — tried ${candidates.join(", ")}; pass --port <n> to choose one`);

  // Only now — with a bind this process is actually keeping — does it need
  // the state directory and board.html. Never for a launch either check
  // above already turned into a no-op: this shares the state directory
  // with whatever this workspace's live cockpit is doing, and touching it
  // before reuse was settled is what #1660's review flagged in the reuse
  // arm (mkdirSync/copyFileSync used to run before the candidate loop).
  mkdirSync(stateDir, { recursive: true });
  try { copyFileSync(join(SCRIPT_DIR, "board.html"), join(stateDir, "board.html")); }
  catch (e) { die(`cannot stage board.html into ${stateDir}: ${e.message}`); }

  // A bind failure is handled above, one candidate at a time; this handler
  // owns everything a LISTENING server can still emit. Without it an 'error'
  // event after the bind has no listener at all and node rethrows it as an
  // uncaught exception — the one regression the loop above would otherwise
  // introduce by taking the old, always-attached handler away with it.
  server.on("error", (e) => die(e.message));

  // Everything below is reached only by a process that HOLDS a port, which is
  // what #1656's listen-callback gating bought and what this loop has to keep
  // paying for by position: tick() writes into stateDir, SHARED by every cwd
  // that resolves to this workspace, so a process that never binds must not
  // reach it. A second cockpit that ticked first would overwrite the live
  // one's board.json and reset every ticket's dwell clock.
  //
  // Announce the port we GOT, not the one we asked for. They differ for the
  // one value #366 newly permits: listen(0) binds an ephemeral port, so
  // echoing the request prints — and --opens — http://localhost:0, which
  // reaches nothing while the board sits on a port nobody was told (#435
  // review). address() is only populated once listening, hence only here.
  const bound = server.address().port;
  console.error(`${NAME}: cockpit on http://localhost:${bound}  (interval ${interval}s)`);
  if (open) tryRun("open", [`http://localhost:${bound}/`]);

  // #1660: publish identity the instant this port is ours — before the
  // first tick, which is the one that can be slow (gather() shells out to
  // gh and ledger.mjs). A sibling launch races this one by sending its
  // probe as soon as ITS bind attempt refuses, which can be well before
  // this process's first gather() ever returns; the answer that probe needs
  // has to already be on disk, not waiting on a compute this process has
  // not started yet.
  // #1584: `port` rides along. This stub is a board payload like any other
  // for as long as the first gather() takes, and a reader that finds it —
  // the operator, a script, the page — gets the same two identity fields
  // from it that every later tick writes. The handshake above still reads
  // only `workspace`.
  writeFileSync(`${jsonPath}.tmp`, JSON.stringify({ workspace: instance.workspace, port: bound }));
  renameSync(`${jsonPath}.tmp`, jsonPath);
  // Yield once so a connection already arriving — that same sibling's probe
  // — gets a chance to read the identity just written before this process
  // blocks inside gather() for however long that takes.
  await new Promise((resolve) => setImmediate(resolve));

  tick(bound);
  const timer = setInterval(() => tick(bound), interval * 1000);

  const stop = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeAllConnections?.();                  // drop keep-alive sockets so close() resolves promptly
    setTimeout(() => process.exit(0), 1000).unref();  // hard backstop if a socket somehow lingers
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {}); // run until signalled
}

// #1093: an internal FAULT is not a refusal, and until this they were one
// line. Every guard in this file refuses through die(), which writes its own
// line and calls process.exit(2) itself (arg.mjs) rather than throwing, so
// nothing a caller can type unwinds as far as the catch below. Re-checked
// against the tree rather than taken from the ticket: every `throw` in this
// file — readAgent's sidecar-shape guard, and the three prev-board shape guards
// gather() gained in #1192 — is caught by the try that raises it, so the whole
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
// minted verdict, and 126+ is the band a shell mints for itself. Stated in the
// script-surface table of docs/specs/2026-07-23-fleet-plugin-design.md, which
// board.mjs had no row in at all before this.
const FAULT_EXIT = 70;

// The diagnostic, and it can never come back empty. Read off `stack` rather
// than `instanceof Error`: the stack is what a fault owes the operator, and
// asking for it directly needs no error TYPE — the hierarchy #1093 rules out.
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
// failure #889 gave die() (arg.mjs) a bounded retry loop for, and PR #1523
// then gave staleness.mjs's verdict() too. board.mjs has exactly one
// writeSync call site — this one — and #1549 moved arg.mjs's die() and
// staleness.mjs's verdict() onto the shared writeAll() and deleted
// ci-state.mjs's emit() outright, so fault() is now the only script-level
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

// Only run main() as a CLI, never when imported by a test. realpathSync resolves
// both sides (relative argv, symlinks) so the equality is reliable regardless of
// how node was invoked.
const isCLI = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCLI) main().catch(fault);
