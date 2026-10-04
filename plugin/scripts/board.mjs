#!/usr/bin/env node
// The cockpit's I/O layer. `build` gathers ledger + gh + CI state, calls the
// pure computeBoard(), and prints board.json. `serve` (below) loops build,
// atomic-writes .fleet/board.json, and serves board.html. The board never
// depends on the controller feeding it.
//
// Pipeline state is a pure function of ledger + GitHub. The spend panel adds
// a THIRD input that is neither — the local member-transcript tree, under
// ~/.omp/agent/sessions — so the "f(ledger, gh)" property no longer covers
// the whole model. It is
// telemetry, kept strictly to the side: it can only ever populate or omit
// `spend`, never change a ticket's stage.
//
// That transcript tree is keyed by PROJECT DIRECTORY, not by session, and one
// directory can hold several sessions at once. `serve` therefore resolves ONE
// session's transcript directory and keeps it for its whole life — see
// spendDirPin() below — rather than re-picking the newest on every tick and
// alternating between two live runs' numbers in silence.
//
// LIMITATION, stated rather than solved: the session it keeps is whichever
// FIRST writes a transcript at or after the pin's own construction.
// Before that, a session that was already active when the pin was built —
// this run's own, mid-EACCES-fault, or a genuinely previous run's — is never
// latched; the pin keeps re-asking findSubagentsDir() every tick instead,
// which is what lets a transient fault or a stale session recover instead of
// freezing the panel for the server's whole life. What is not solved: two
// sessions that BOTH start writing after the pin exists, in the same project
// directory, are still indistinguishable — the board is scoped to a
// workspace and a workspace does not know that — so the first of them
// to pass the newest-transcript check wins and keeps winning. `--spend-dir
// <path>` is how an operator names the right one: it overrides the
// heuristic outright.

import { execFile, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, writeSync } from "node:fs";
import { classifyRole, computeSpend, attributeTools, mergeTools } from "./compute-spend.mjs";
import {
  encodeProjectDir, isOmpSessionDirName, ompSessionTranscripts, foldOmpTranscript, ompMemberRecord,
} from "./member-record.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";
import { mergedReadPrs } from "./compute-board.mjs";
// The heartbeat's liveness mark, read here and never written. The
// cockpit is a READER of that key — the heartbeat is its only writer — and it
// reaches the file through the module that owns the filename rather than
// spelling `heartbeat.json` a second time. The PATH still comes from this
// file's own resolveCockpitInstance(), not from statePath(): that probe is
// already run once per launch here, with the `canonicalise` opt-in only this
// caller takes, and a second probe could answer differently.
import { readState, stateFileIn } from "./fleet-state.mjs";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { dirname, join, basename } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { inspect } from "node:util";

const NAME = "board";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// die()/arg()/has() shared with the other fleet scripts — see arg.mjs for
// the fail-open and pipe-safety rationale.
const die = makeDie(NAME);
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
// IGNORED at exit 0 rather than refused. main() now calls argPort()/
// has("open") once, ahead of the build/serve dispatch, so both malformed
// spellings refuse on EVERY subcommand — build just discards the (validated)
// return value, since nothing on that path has a server to bind or a browser
// to open. A WELL-FORMED --port/--open on build still does nothing there,
// same as before this fix: the guard checks the flag's SHAPE, not whether
// this subcommand has a use for it. `ledger`/`prev`/`spend-since`/`interval`
// were already read on the build path and already refused there.
// That last claim held for `ledger`/`spend-since`/`interval`, not for
// `prev` — `prev` was read on `build` alone, and serve() never read it at
// all. Hoisted in main() below, next to argPort()/has("open").

// The "is this a plain JSON object" predicate and its kind word, one
// copy for the reads in this file that reject a parsed-but-wrong payload
// WHOLE — gather's `--prev` payload, gather's per-entry `tickets[i]` check,
// and readMerged()'s `data.repository`. Each carried its own inline
// copy of both halves before, which is three places for one policy to drift in.
//
// TWO functions and not one, because `typeof` alone cannot name the fault the
// predicate rejects: it answers "object" for `null` and for `[]` alike, and
// those are exactly two of the three shapes turned away here, so a
// `typeof`-only diagnostic distinguishes neither from a real object. That is
// the same three-arm naming review-core.mjs's resolveDimensions keeps, for the
// same reason.
//
// Not every payload-shape check in this file is one of these, and the others
// are not oversights: mapCi's and tryParse's are both null-only, neither
// refusing a payload for being an array or a scalar. A settled, deliberately
// different policy — not more callers waiting to be converted.
function isJsonObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonKind(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

// `Number(x) || default` treated a garbage --port/--interval exactly
// like an absent one — "abc" is NaN, NaN is falsy, so it silently became the
// default with no refusal. Same silent-fallback class as arg()'s own comment
// above and the --spend-since guard. `interval` is read from argv in two
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
// gather() still calls this itself, in the same spot, so nothing about WHEN
// it validates changes for a caller that skips main() (same reasoning as
// for argPort()/has("open") staying in serve() too).
function argSpendSince() {
  const sinceRaw = arg("spend-since");
  if (sinceRaw === null) return null;
  const sinceMs = Number(sinceRaw);
  if (!Number.isFinite(sinceMs) || sinceMs < 1e12 || sinceMs > Date.now()) {
    die(`--spend-since wants epoch milliseconds, got ${sinceRaw}`);
  }
  return sinceMs;
}

// The operator's override for the session heuristic (findSubagentsDir()
// below). A PATH, so there is no range or magnitude to check the way
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
// `undefined` for an absent flag, not the `null` argPort()/argInterval()/
// argSpendSince() return: `null` is a transcript-directory RESOLUTION in this
// file ("resolved, no session yet" — findSubagentsDir() below), and the
// absence of an override must not read as one.
function argSpendDir() {
  return arg("spend-dir") ?? undefined;
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
// Both child reads in this file take it. `tryRun` is NOT the single funnel —
// runCiState() spawns its own, because it needs the exit code that a plain
// tryRun discards — so a fix applied only here would leave that one uncapped.
const READ_OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// Every child read in this file is ASYNCHRONOUS, and that is
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
// throws. That single oversized write is the subject of a flood row in the CLI tests,
// so it is spelled out below — and on both arms, because
// the sync one wrote whether or not it went on to throw.
//
// This never throws; a failure is REPORTED in the record, in the field names
// execFileSync's throw used — `status` for an exit code, `signal` for a kill,
// `code` for a libuv/node fault. That translation is the whole reason this is
// not a bare `promisify(execFile)`: the async error carries the EXIT CODE in
// `err.code` (measured: `3`, a number), where the sync one carried `ENOENT` /
// `ENOBUFS` there and the exit code in `status`, and runCiState() below reads
// all three to tell those causes apart.
function execRead(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, READ_OPTS, (err, stdout, stderr) => {
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

// Every external read is wrapped: a failure returns null and the caller keeps a
// last-known value. Partial board beats a crashed loop or a false alarm.
async function tryRun(cmd, args) {
  const r = await execRead(cmd, args);
  if (r.error) { console.error(`${NAME}: ${cmd} ${args.join(" ")} failed: ${r.error.message}`); return null; }
  return r.stdout;
}

// `serve --open`'s browser launcher, one per supported platform.
// macOS ships `open`. Linux has no single program, but `xdg-open` is
// the freedesktop one every mainstream desktop provides; WSL usually lacks it
// and has `wslview` (wslu) instead, which hands the URL to the Windows default
// browser. Only a launcher that is NOT ON PATH passes the URL down the list:
// one that ran and failed is the right program meeting a real fault, and the
// next one would not fix that.
//
// Never throws and never exits. A tab that did not open is a warning naming
// the URL — the cockpit is up and serving either way, and the operator can
// open it by hand — so a missing launcher changes nothing about the exit code.
async function openBrowser(url) {
  const tried = [];
  for (const cmd of process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview"]) {
    const r = await execRead(cmd, [url]);
    if (!r.error) return;
    if (r.code === "ENOENT") { tried.push(`${cmd} not found`); continue; }
    tried.push(r.status != null ? `${cmd} exited ${r.status}` : `${cmd} failed: ${r.error.message.split("\n")[0]}`);
    break;
  }
  console.error(`${NAME}: WARNING --open could not open a browser (${tried.join(", ")}) — the cockpit is on ${url}`);
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
// for the `gh ... list` reads, gather()'s `--prev` read demands
// an object, and gather()'s ledger branch takes any shape ledger.mjs emits,
// deliberately, for the reason stated there. A shape policy could not be written
// in here anyway: `fallback` is `[]` where the open-PR read calls this and null where the
// ledger read does, so the helper is never told what its caller wanted — only
// that null is not it.
//
// Reported, and never as "parse failed": the parse succeeded, and keeping the
// state a read reached apart from the state it failed at is what the ledger states are for.
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
// OTHER rows, and degrades instead of dying.
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

// gh stops a `list` read at its `--limit` with exit 0 and no warning, so
// a read that came back exactly that long may have been cut there — "at least
// this many", never "this many". candidates.mjs's refuseIfCapped() and
// fleet-tick.mjs's PR_LIMIT/CLAIMED_LIMIT carry the same rule; this board is a
// display, so it discloses a capped read (computeBoard's `n+` and capNotice)
// rather than dying on one. Counted on the raw rows, before withNumber() drops
// any: gh's cap applies to what it returned, not to what this file kept.
const POOL_LIMIT = 100;
const OPEN_PR_LIMIT = 100;
function hitLimit(parsed, limit) {
  return Array.isArray(parsed) && parsed.length >= limit;
}

// Which of `prNums` gh calls MERGED, in ONE `gh api graphql` query —
// one aliased `pullRequest(number:)` field per PR, on the cwd's repository
// (gh's own `{owner}`/`{repo}` placeholders, the repo every other read here
// resolves) — so a PR merged at any age is found, and ten PRs cost what one
// does. It replaced `gh pr list --state merged --limit 100`, the repo's 100
// most recent merges: about six days on 2026-09-25, so a row PR merged
// before that and never seen MERGED rendered REVIEW, turned stale and
// counted as claimed. Measured 2026-09-26: 400 aliases answer in one call.
//
// An empty `prNums` makes no read at all. `state` is checked, so an entry gh
// does not call MERGED never makes a card MERGED on its own account.
//
// A body with an object `data.repository` IS an answer even at exit 1:
// GitHub resolves every alias it can and nulls the rest — a number that is
// not a PR comes back null beside a NOT_FOUND error, and gh exits 1 with the
// whole body on stdout (measured 2026-09-26, gh 2.101.0, which also names
// the number on stderr). Refusing that body would let one such row — a
// typo, or a row with no impl token keyed by an issue number — put every other
// row PR back in REVIEW on every tick. A null alias reads as not merged,
// which is what a failed read means for that one PR.
//
// Real GitHub always answers EVERY requested `p<N>` alias, null or an
// object — never omits one — so an object naming NONE of `prNums` is not a
// shape the API produces, only a corrupted or truncated one; `isJsonObject`
// alone cannot tell that apart from a genuine "checked, nothing merged"
// answer, so it is checked for too. Anything else is a failed read: `[]`,
// and computeBoard()'s carry-forward rule takes it from there.
async function readMerged(prNums) {
  if (!prNums.length) return [];
  const fields = prNums.map((n) => `p${n}:pullRequest(number:${n}){state}`).join(" ");
  const r = await execRead("gh", ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
    "-f", `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`]);
  let repo;
  try { repo = JSON.parse(r.stdout)?.data?.repository; } catch {}
  if (!isJsonObject(repo) || !prNums.some((n) => Object.prototype.hasOwnProperty.call(repo, `p${n}`))) {
    // `how` as runCiState() spells it; never r.error.message, which repeats
    // the whole query — one field per PR — into every failed tick's line.
    const how = r.code ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
    console.error(`${NAME}: gh api graphql merged read (${prNums.length} PR${prNums.length === 1 ? "" : "s"}) failed (${how}) with no usable answer; they read as not merged`);
    return [];
  }
  return prNums.filter((n) => repo[`p${n}`]?.state === "MERGED");
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
// stdout was only ever a proxy for it, and that proxy no longer holds: a quota
// refusal now names its cause on stdout on the way out at exit 2, so "non-empty
// stdout" began reading an outage as a reading. That payload carries no
// `status`, so mapCi answered "unknown" and gather()'s prevCi carry-forward —
// which only a null return reaches — was skipped, overwriting a PR's
// last-known-good CI state during a blip that clears itself. Exit 2 means the
// question could not be answered, whatever the script printed while saying so.
//
// The exit code is not sufficient on its own either, for the symmetric
// reason: it reports that the child reached its own exit path, never that its
// payload arrived whole. `e.status !== 2` is also true of a signal kill, where
// `status` is null, and of a write cut mid-JSON at exit 1 — emit() over in
// ci-state.mjs abandons a short write it cannot retry, which keeps the exit
// code intact while losing the tail of the line. Those bytes were returned AS a
// verdict, mapCi could not parse them, and the non-null return skipped the very
// carry-forward added for the exit-2 case: that regression re-entering through the gate
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
async function runCiState(scriptDir, pr) {
  const r = await execRead("node", [join(scriptDir, "ci-state.mjs"), "--pr", String(pr), "--quiet"]);
  const out = r.stdout;
  if (r.error) {
    // `r.stdout` and not `error.stdout`: what the child managed to write before
    // it died is the salvage this whole block exists for, and execRead's record
    // carries it on every arm — including a spawn failure, where it is "".
    if (r.status === 2 || !out.trim()) {
      console.error(`${NAME}: ci-state --pr ${pr} failed: ${r.error.message}`);
      return null;
    }
    // Its own line, not the one above: "failed" reads as "the child never
    // answered", and an operator looking at a carried-forward CI value needs to
    // know a payload DID arrive and was thrown away, and why.
    //
    // `how` reads the libuv/node `code` first — the three-way ci-state.mjs
    // already uses at its own child reads — because one cause of this shape is
    // OURS: overrunning READ_OPTS.maxBuffer is enforced by node killing the
    // child, and that arrives as code ERR_CHILD_PROCESS_STDIO_MAXBUFFER
    // (measured; the synchronous read this replaced reported the same cap as
    // signal SIGTERM carrying code ENOBUFS). A signal-first `how` renders a cap
    // this file sets as an outside kill, sending the operator after an OOM kill
    // or a stray `kill -TERM`. The signal arm stays ahead of the exit arm
    // behind it: `status` is null on a real signal kill, where "exit null"
    // would name nothing to act on. execRead splits the async error's one
    // `code` field back into these three, so all three arms still read as they
    // did — measured: an exit 3 gives `status` 3 and no `code`, a SIGKILL gives
    // `signal` and neither, an unreachable binary gives `code` ENOENT.
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
    try { JSON.parse(out); }
    catch (pe) {
      const how = r.code ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
      warnOnce("ci-salvage-nonzero", pr, `ci-state --pr ${pr} (${how}) left a payload that will not parse (${pe.message}); carrying the previous CI value forward rather than reading this as a verdict`);
      return null;
    }
    return out;
  }
  // Exit 0 was never covered by any of the checks above — they only run
  // once the child read reports a failure, and a child that exits 0 reports
  // none. So the same write cut mid-JSON that the failure block above salvages
  // at exit 1 rode straight through here and into mapCi at exit 0, where an
  // unparseable string maps to "unknown" and gather()'s carry-forward — which
  // only a null return reaches — was skipped, discarding the PR's last-known
  // CI value exactly as the exit-2 case did before it was fixed. Same parse
  // check, same null return as the failure block above — but its OWN channel,
  // `ci-salvage-exit0`, not that block's `ci-salvage-nonzero`: a
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
  // strictly, not falsiness: an EMPTY payload is not that case. Since
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
  // all. That was closed for runCiState()'s catch block (a payload that will
  // not parse there is a failed read, reaching gather()'s carry-forward);
  // and for the exit-0 arm the same way (see runCiState() above),
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

// Where this session's member transcripts live:
//   ~/.omp/agent/sessions/<encoded-cwd>/<ISO>_<uuid>/
// The encoder lives in member-record.mjs, shared with
// member-outcomes.mjs; it is re-exported here under its original name so
// nothing importing `encodeProjectDir` from this file needs to change.
export { encodeProjectDir };

// The session uuid is not knowable from here, so take the most recently
// active one. Rank on the newest TRANSCRIPT mtime, not on the session
// directory's own: a directory's mtime moves when an entry is created or
// removed, never when a file inside it is appended to. Ranking on the
// directory therefore tracked the last agent SPAWN rather than the last
// agent activity — and since the cockpit launches in run-team phase 0,
// before the first agent spawns, the live session has no transcript yet and
// a PREVIOUS session won. The board would render a prior run's spend as
// this run's, then silently switch when the first agent landed. That is the
// one failure mode here that produces confidently wrong numbers rather than
// no numbers.
//
// Returns { error } when there is no project dir for this cwd — a bug that
// never fixes itself — and null when one resolves but holds no sessions
// yet, which is normal at run start. Collapsing those two into one bare
// null is what hid the encoding bug above. A listing that THROWS is
// { error } too.
export function findSubagentsDir(home = process.env.HOME, cwd = process.cwd()) {
  try {
    const tree = sessionDirs(home, cwd);
    if (tree.dirs === null) {
      return { error: `no transcript dir for cwd ${cwd} (looked in ${tree.root})` };
    }
    const cands = tree.dirs
      .map((d) => ({ d, m: newestTranscriptMs(d) }))
      .sort((a, b) => b.m - a.m);
    return cands.length ? cands[0].d : null;
  } catch (e) { return { error: `transcript lookup failed: ${e.message}` }; }
}

// The candidate session directories for this cwd. `dirs: null` means there
// is no project dir here at all; `[]` means there is one holding no session
// yet. `root` is where it looked, for the error above.
//
// `encodeProjectDir` realpath-resolves a cwd outside $HOME, which throws
// ENOENT when that cwd does not exist. No omp session can be keyed on such a
// cwd, so THAT is this tree's absence — not a lookup fault. Any OTHER error
// (EACCES on an ancestor directory, say) is a real fault, not an absence,
// and must not be relabelled as one: swallowing it here would crash
// silently with no signal anything went wrong. It is rethrown, uncaught,
// into findSubagentsDir's own catch — the same fate a listing failure below
// already gets, deliberately.
function sessionDirs(home, cwd) {
  const sessions = join(home, ".omp", "agent", "sessions");
  let root;
  try {
    root = join(sessions, encodeProjectDir(cwd, { home }));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return { root: sessions, dirs: null };
  }
  if (!existsSync(root)) return { root, dirs: null };
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isOmpSessionDirName(e.name))
    .map((e) => join(root, e.name));
  return { root, dirs };
}

// Newest *.jsonl mtime anywhere under a session's transcript dir, 0 if it
// holds none. Recursive: a nested member (a dispatcher's own further
// fan-out, one directory level down — the same walk ompSessionTranscripts
// does to book their spend) can be the only fresh activity in an otherwise
// idle-looking session, and a scan bounded to the top level would score
// that session 0 and lose it to a genuinely stale sibling.
//
// A dir whose transcripts are all unreadable loses to one that is readable,
// which is the behaviour we want when picking "the live session".
//
// The scan is wrapped for the same reason the per-file stat below is. This runs
// once per CANDIDATE, so an uncaught throw here does not just lose one dir — it
// escapes findSubagentsDir's try and turns the whole lookup into { error },
// blacking out every readable session over one bad sibling. Scoring 0 is what
// the comment above already promises: a dir we cannot read simply loses.
function newestTranscriptMs(dir) {
  let names;
  try { names = readdirSync(dir, { recursive: true }); } catch { return 0; }
  let newest = 0;
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch { /* raced away */ }
  }
  return newest;
}

// The transcript directory a `serve` process is bound to, resolved
// once it can be trusted and reused by every tick after it. findSubagentsDir()
// above ranks sessions by newest transcript mtime and gather() reached it
// through gatherSpend() on EVERY tick (~15s by default), so two sessions live
// under one project directory took turns winning: the panel alternated
// between two runs' numbers with nothing on the page or on stderr to say it
// had switched.
//
// The pin holds the first answer that COULD BE THIS RUN'S, not the first
// non-null answer and not the first call. findSubagentsDir() has
// three returns and none of them is safe to latch on sight: a directory
// resolved at pin-construction time can be a PREVIOUS run's session — newer
// than nothing else that exists yet, so it wins the ranking, but not this
// run's — and `{ error }` can be a transient fault (EACCES on a directory
// mid-permission-change, EMFILE, EIO) recovering on the very next tick just
// as easily as it can be the truly unresolvable "bug that never fixes
// itself" the ticket originally reasoned about. Latching either one turns
// the self-correcting degradation this file's header describes into a
// permanent one: measured, a chmod'd-then-restored session tree left
// the OLD `??=` pin stuck on `{ error }` forever while the unpinned lookup
// recovered on its very next tick, and a prior run's session dir
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

// Scope is the SESSION directory, which is the closest thing to a run
// boundary that actually exists on disk — one session, one folder,
// identified by its own NAME: `<ISO>_<uuid>` (member-record.mjs's
// isOmpSessionDirName, the rule its own readers dispatch on).
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
// `error`'s truthiness was a bug: `e.message` is "" for an error thrown
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
    // A caller-supplied `null` is a RESOLUTION from one that owns a pin
    // (spendDirPin() above) — the project directory is there and holds no
    // session yet — and must not run the heuristic a second time; only an
    // omitted `dir` (every gatherSpend test driver, and `build`, which is one
    // gather per process and so needs no pin) defaults to it. A default
    // parameter fires on `undefined` alone, never `null`, which is exactly
    // that distinction — the hand-rolled `if (dir === undefined) dir =
    // findSubagentsDir();` this used to spell out is redundant with it.
    //
    // `explicit` is true only when `dir` came from the operator's
    // own --spend-dir, never from the heuristic or an unresolved pin — see
    // its one use below, at the empty-directory branch.
    const dirError = dir?.error;
    if (dirError) {
      warnOnce("no-spend-dir", dirError, dirError);
      return { ok: false, error: dirError };
    }
    if (!dir) return null; // resolved, but this session has spawned no agents yet
    // Only for an EXPLICIT --spend-dir — the heuristic's own
    // findSubagentsDir() already dispatches on isOmpSessionDirName, so a
    // resolved-but-non-heuristic `dir` here only ever arrives from the
    // operator naming a directory directly. Without this check the
    // mis-levelled path this same function's comments already name (the
    // encoded-cwd project dir instead of its own <ISO>_<uuid> child) walked
    // straight into readOmpSpend below, which recurses over every nested
    // .jsonl with no name check of its own, and booked every session's
    // transcripts — including the controller's own main-session one — as
    // "agents" instead of refusing.
    if (explicit && !isOmpSessionDirName(basename(dir))) {
      const error = `${dir} is not an omp <ISO>_<uuid> session directory`;
      warnOnce("bad-spend-dir", dir, `--spend-dir ${error}`);
      return { ok: false, error };
    }

    const { agents, toolTables, skipped, damaged } = readOmpSpend(dir, sinceMs);
    if (!agents.length) {
      // `damaged` belongs here beside `skipped`. An omp transcript with
      // no parseable assistant-with-usage line folds to no model, so
      // readOmpSpend drops it without a throw — `skipped` stays 0 — and its
      // non-last parse failures are the only trace that the directory held a
      // transcript at all. Reading `skipped` alone sent that down the empty
      // path below: a hidden panel, or an explicit override told the directory
      // "holds no agent transcripts". A torn LAST line never counts as damaged,
      // so a live write's partial first line still takes the empty path.
      // A wholly-corrupt transcript with a readable "not executed" tool
      // result but no assistant-with-usage line still drops here rather
      // than booking at zero spend.
      //
      // `damaged` counts LINES, `skipped` whole transcripts, so each keeps its
      // own clause — the lines one in board.html's damagedPhrase wording. "all
      // N transcripts unreadable" stays for `skipped` alone: beside damaged
      // lines it would count only the whole files and read as the entire loss.
      if (damaged) {
        const lost = [`${damaged} damaged transcript line${damaged === 1 ? "" : "s"}`];
        if (skipped) lost.unshift(`${skipped} transcript${skipped === 1 ? "" : "s"} unreadable`);
        return { ok: false, error: `no agent turn readable: ${lost.join("; ")}` };
      }
      if (skipped) return { ok: false, error: `all ${skipped} transcripts unreadable` };
      // Only for an EXPLICIT override — never the heuristic's own
      // "resolved, no session yet" `null` case two arms up, which is the
      // normal state at launch and must stay silent. An operator who named
      // this exact directory has a panel that just went quiet with nothing
      // saying whether that is the normal "not written yet" wait or a typo'd
      // / mis-levelled path (e.g. the encoded-cwd directory instead of its
      // own `<ISO>_<uuid>` child) that will never resolve.
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
    return { ...spend, tools, attributedPct, skipped, damaged, since: sinceMs, ok: true };
  } catch (e) {
    // A real bug, not an empty run — say so rather than hiding the panel, which
    // is what turned the last type surprise in here into "no panel appeared".
    // `e.message` is carried as-is, including the "" and `undefined` a
    // message-less throw would give it: the tag above is what routes this to the
    // error panel, so an unhelpful message costs wording, never the panel.
    // An explicit --spend-dir naming a directory that does not exist
    // YET (the legitimate, tested case) throws ENOENT here on every tick
    // until it appears, and this catch used to print unconditionally — one
    // line per ~15s tick, forever. Routed through warnOnce, keyed on the
    // message the same way the `{ error }` arm above it already is, so a
    // repeating fault costs one stderr line, not one per tick.
    warnOnce("spend-read-failed", e.message, `spend read failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// omp's side: one agent per member transcript anywhere under the
// session dir — a nested member's too, at its own spawnDepth — read by
// member-record.mjs's own omp reader over the walk readOmpSession uses:
// foldOmpTranscript once per file, then ompMemberRecord on that fold, never
// a second parse of omp's line shape. So each row's totals, model and role
// are exactly the member record's: role from `session_init`'s agent
// definition, task and AgentId, label the AgentId itself (the path-relative
// stem, `review-pr-12/Security` for a nested one). The same fold's `entries`
// are the tool stream, so the tool table goes through attributeTools.
//
// Per-transcript tolerance is this file's, not readOmpSession's: readOmpSession
// (used by the bulk scrape) lets a wrong-shape refusal propagate, and here
// both — an unreadable file and a wrong-shape refusal — are one transcript's
// fault, so readOmpSpend, this file's own reader, instead catches both per-
// transcript, landing them in `skipped` with a stderr line. A transcript
// ompMemberRecord answers null for (no assistant turn yet — a member
// dispatched this second) has spent nothing, so it is neither booked nor
// skipped.
//
// `damaged` is real — the tool-attribution stream is a join
// across lines (a toolCall's id names its tool, a pending result batch bills
// the next turn), so a dropped MIDDLE line can silently shift spend onto a
// neighbouring tool instead of just costing its own turn's totals — the
// hazard foldOmpTranscript's `malformedNonLastLines` counts. This reader
// sums it across
// the transcript regardless of whether the file ends up booked as an agent,
// so a transcript that is corrupt where its assistant-with-usage line should
// be still surfaces here instead of falling through `if (!m) continue` unseen.
function readOmpSpend(dir, sinceMs) {
  const agents = [];
  const toolTables = [];
  let skipped = 0;
  let damaged = 0;
  for (const { file, agent, spawnDepth } of ompSessionTranscripts(dir)) {
    try {
      if (sinceMs != null && statSync(file).mtimeMs < sinceMs) continue;
      const folded = foldOmpTranscript(readFileSync(file, "utf8"), file);
      damaged += folded.malformedNonLastLines;
      const m = ompMemberRecord(folded, agent, spawnDepth);
      if (!m) continue;
      // Both halves before either is recorded, so `skipped++` below always
      // means "this transcript contributed nothing".
      const tools = attributeTools(folded.entries);
      agents.push({
        label: m.member, role: m.role, model: m.model,
        cacheWrite: m.tokens_cache_create, output: m.tokens_out, cacheRead: m.tokens_cache_read,
      });
      toolTables.push(tools);
    } catch (e) {
      skipped++;
      warnOnce("skips", file, `skipping ${file}: ${e.message}`);
    }
  }
  return { agents, toolTables, skipped, damaged };
}

// `workspace`/`port` are the caller's answers, never read in here:
// resolveCockpitInstance() already decided both, and a second derivation in
// this function could disagree with the one the server actually bound. They
// join the payload HERE, alongside the repo fields above, because this is the
// boundary where every impure input meets the pure model — computeBoard() only
// echoes them. Defaulted to null, which is also the degrade arm's workspace
// and the value the launch handshake refuses to match on, so a caller with no
// instance to name (every gather() test driver) says so rather than omitting
// the fields.
//
// `spendDir` is the caller's PINNED transcript directory and is the one
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
// `spendDirExplicit` is read the same way, independently of
// `spendDir` itself: serve() always passes a resolved `spendDir` (the pin's
// answer), never leaving it to default, so `spendDir`'s own presence cannot
// say whether an operator named it. Whether --spend-dir was given is a fact
// about argv, unrelated to which of gatherSpend's three shapes the pin
// currently holds.
// Async, because every child read below is. The event loop this frees
// belongs to serve()'s HTTP server, which shares this process — see execRead's
// note above for what the synchronous version cost. `build` awaits it and is
// otherwise unchanged: one gather per process, nothing else waiting on it.
export async function gather({ ledgerFile, prevFile, stateFile = null, scriptDir = SCRIPT_DIR, interval, workspace = null, port = null, spendDir = argSpendDir(), spendDirExplicit = argSpendDir() != null }) {
  // The one read that must not crash the gather: a corrupt/partial board.json
  // (the fallback safety net itself) is ignored, not fatal. That holds for a
  // SHAPE fault as much as a parse fault — the guard below rejects the
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
      // object, and `typeof null` alone would let it through. Same check and
      // same wording as readMerged()'s `data.repository` read, which is this
      // repo's precedent for rejecting a parsed-but-wrong payload at its own
      // read — literally the same, both calling the shared predicate.
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
        // policy this guard already shares with readMerged()'s own read.
        const bad = p.tickets.findIndex((t) => !isJsonObject(t));
        if (bad !== -1)
          throw new TypeError(`expected tickets[${bad}] to be a JSON object, got ${jsonKind(p.tickets[bad])}`);
      }
      prev = p;
    }
    catch (e) { console.error(`${NAME}: ignoring unreadable prev board ${prevFile}: ${e.message}`); }
  }

  // `--require-file` turns an absent ledger into a refusal at exit 2 rather
  // than the empty payload a real empty ledger returns. Without it the
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
  const ledgerJson = await tryRun("node", [join(scriptDir, "ledger.mjs"), "--file", ledgerFile, "--require-file", "read"]);
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

  const issuesJson = await tryRun("gh", ["issue", "list", "--label", "ready-for-agent",
    "--state", "open", "--limit", String(POOL_LIMIT), "--json", "number,title,labels"]);
  // title: falls back to the same `#<number>` placeholder titleFor() already
  // uses for an issue it cannot find at all (compute-board.mjs). An unrowed
  // issue becomes a POOL card straight from this array — compute-board.mjs's
  // POOL loop reads `iss.title` RAW, never through titleFor()'s fallback
  // chain — so this row genuinely needs a guaranteed string: an issue found
  // but unable to describe itself reads as its number rather than literal
  // `undefined` on the operator's page.
  //
  // Its null fallback, not the open-PR read's `[]` below, is deliberate:
  // this read is the pool's ONLY source, and
  // compute-board.mjs's stall() needs to tell a genuinely empty pool from a
  // `gh` outage the same way it already tells an empty ledger from an unread
  // one — a `[]` fallback collapses both to the identical shape before a
  // caller here could split them back apart.
  const issuesParsed = tryParse(issuesJson, null, "gh issue list");
  const poolOk = issuesParsed !== null;
  const poolCapped = hitLimit(issuesParsed, POOL_LIMIT);
  const issues = withNumber(poolOk ? issuesParsed : [], "gh issue list").map((i) => ({
    number: i.number,
    title: typeof i.title === "string" ? i.title : `#${i.number}`,
    labels: labelsOf(i),
  }));

  const prsJson = await tryRun("gh", ["pr", "list", "--state", "open", "--limit", String(OPEN_PR_LIMIT),
    "--json", "number,state,labels,title,headRefOid"]);
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
  const prsParsed = tryParse(prsJson, [], "gh pr list");
  const prsCapped = hitLimit(prsParsed, OPEN_PR_LIMIT);
  const prs = withNumber(prsParsed, "gh pr list").map((p) => ({
    number: p.number,
    state: p.state,
    title: p.title,
    labels: labelsOf(p),
    // compute-board.mjs's reviewBacklog needs it to tell a
    // past-pin halt already answered by the automatic re-review apart from
    // one still owed a fresh one — the same field fleet-tick.mjs's
    // openPrs() already requires.
    headRefOid: p.headRefOid,
  }));

  // MERGED is gh's answer, not a ledger token — no rule writes `MERGED
  // <sha>`, and the open list above drops a PR the moment it merges. It is
  // asked only about mergedReadPrs()'s set — row PRs absent from the open
  // list, with no token, not carried forward — in one batched read
  // that answers whatever their merge age; see readMerged(). A failed read
  // is `[]`, and the carry-forward in computeBoard() covers exactly the
  // PRs this set leaves out, so a failure costs only a PR never yet seen
  // MERGED, which reads REVIEW.
  const merged = await readMerged(mergedReadPrs({ ledger, prs, prev }));

  // CI per open PR. On failure, carry the previous board's value for that PR.
  const prevCi = new Map((prev?.tickets || []).filter((t) => t.pr != null).map((t) => [t.pr, t.ci]));
  const ci = {};
  // Awaited one at a time rather than raced with Promise.all, and that is a
  // decision rather than an oversight: this loop spawns one `node
  // ci-state.mjs` per open PR and each of those hits the GitHub API, so a fan
  // of 40 at once is a rate-limit and a load spike where a queue of 40 is
  // neither. Nothing here waits on the loop any more — the server answers
  // throughout it — so the only thing concurrency would buy is a
  // shorter tick, against an interval measured in seconds. The warn-once
  // lines below also stay in PR order this way.
  for (const p of prs) {
    const out = await runCiState(scriptDir, p.number);
    ci[p.number] = out === null ? (prevCi.get(p.number) ?? "unknown") : mapCi(out, p.number);
  }

  // Repo identity + web URL for PR links — the url carries the host, so links
  // resolve on GitHub Enterprise, not just github.com. From the fleet's cwd, so
  // the board stays repo-agnostic. On failure, carry the previous board's values.
  const repoJson = await tryRun("gh", ["repo", "view", "--json", "nameWithOwner,url"]);
  let repo = prev?.repo ?? null;
  let repoUrl = prev?.repoUrl ?? null;
  if (repoJson) {
    try { const d = JSON.parse(repoJson); repo = d.nameWithOwner ?? repo; repoUrl = d.url ?? repoUrl; }
    catch (e) { console.error(`${NAME}: gh repo view parse failed: ${e.message}`); }
  }

  // The guard's own rationale (fail loud, gate on presence and on range,
  // not just finiteness) now lives at argSpendSince()'s definition above,
  // alongside argPort()/argInterval() — this call is unchanged in when it
  // runs, only in where the check itself is written.
  const sinceMs = argSpendSince();
  const spend = gatherSpend({ dir: spendDir, sinceMs, explicit: spendDirExplicit });
  // The heartbeat's mark, raw. readState() never throws — an absent
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
  // `ticked` rides beside `beat`, same file same read, and under the same
  // "no try/catch, no tryRun shape" rule just above — fleet-tick.mjs's own
  // liveness key, for the busy-stretch case `beat` alone
  // cannot see (fleet-state.mjs's assessBeat has the rule).
  const priorState = stateFile ? readState(stateFile, NAME) : null;
  const beat = priorState?.beat ?? null;
  const ticked = priorState?.ticked ?? null;
  return { ledger, issues, prs, merged, ci, prev, repo, repoUrl, workspace, port, spend, beat, ticked, poolOk,
    poolCapped, prsCapped,
    now: Date.now(), interval: interval ?? argInterval() ?? 15 };
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
  // no-subcommand shape printed the usage line (measured). The return values are
  // deliberately discarded on the build path: build has no server to bind or
  // browser to open, so a WELL-FORMED --port/--open still does nothing here,
  // exactly like before this fix — only the malformed spellings now refuse.
  // serve() below still calls its own argPort()/has("open"); re-evaluating a
  // pure read of argv costs nothing and keeps the EXPORTED serve() validating
  // its own argv for a caller that skips main(). Nothing in this repo is such
  // a caller today — every serve() test drives the real CLI, which enters
  // main() — but serve() is public surface, so the guard stays with it.
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
  argPort();
  has("open");

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
  // argPort()/has("open") already sit — build discards both return values,
  // same as it already discards argPort()'s. serve() below still calls its
  // own argInterval() (via `interval ?? argInterval() ?? 15`) and gather()
  // still calls its own argSpendSince() — re-evaluating a pure read of argv
  // costs nothing, and keeps both validating their own argv for a caller
  // that skips main(), same reasoning as for argPort()/has("open").
  argInterval();
  argSpendSince();
  // `--spend-dir` joins them for the same two reasons, from the day it
  // ships rather than one ticket later — it is read on both subcommands (in
  // gather()'s default, and through serve()'s pin), and a trailing
  // `--spend-dir` ahead of a stray positional has to name itself instead of
  // the token behind it. build discards the value here exactly as it discards
  // argPort()'s; gather() below does the read that reaches the panel.
  argSpendDir();

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
    const instance = resolveCockpitInstance({ cwd: process.cwd(), gitCommonDir: gitCommonDir() });
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
    }));
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  if (cmd === "serve") {
    stray();
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
// aware of the other, and one workspace derives the SAME port on every run,
// so that URL survives runs, reboots and node versions.
//
// BASE is the port this file hardcoded before any of this existed;
// resolveCockpitInstance()'s degrade arm, with no workspace to hash, still
// defaults to it. SPAN = 512 was kept deliberately: a
// collision between two DIFFERENT workspaces is not priced into the width but
// carried by serve()'s launch loop, which probes whoever holds the derived
// port, reuses that cockpit when it is this workspace's own, and otherwise
// scans on through cockpitPorts()'s PORT_ATTEMPTS candidates. The accepted
// cost is launch order: whichever colliding workspace starts second binds a
// port other than the one its hash derives.
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
// side of the cockpit handshake. The invariant is that null and the
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
// and each mutant was killed by a test that already existed in the board tests:
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
 * directory. That resolution is not spelled here: it is
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
  // ephemeral bind) and reading it as "absent" would derive a port
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
// reason the ledger's identical probe is bounded: an unbounded git that
// never returns hangs serve() before it binds anything, with nothing on
// stderr to say why. Ambient GIT_DIR/GIT_WORK_TREE scrubbed — either
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
    server.listen(port, COCKPIT_HOST);
  });
}

// Whether something already answers on COCKPIT_HOST:port, asked BEFORE the
// bind rather than read off it: a 127.0.0.1 bind does not reliably fail when
// the port is taken. On macOS/BSD, SO_REUSEADDR lets it succeed beside a
// listener that holds every interface — a dev server, or a cockpit started
// before the bind was narrowed to loopback — and the launch would then sit
// on that holder's 127.0.0.1 traffic instead of stepping over it or reusing
// it. Linux refuses that bind outright; this check gives both the same answer.
// Resolves in bindFailure()'s vocabulary so the loop reads one shape: null
// when the connection is refused (nothing holds the port), an EADDRINUSE
// error when it connects or times out, and any other error as itself — a
// fault of its own, like EACCES on a bind. A timeout counts as held because
// a live holder whose accept backlog is full drops the SYN rather than
// refusing it. The window between this check and the bind is a race the
// loop accepts, like its others.
function heldFailure(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: COCKPIT_HOST, port });
    const held = () => {
      socket.destroy();
      resolve(Object.assign(new Error(`port ${port} answers on ${COCKPIT_HOST}`), { code: "EADDRINUSE" }));
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, held);
    socket.once("connect", held);
    socket.once("error", (e) => resolve(e.code === "ECONNREFUSED" ? null : e));
  });
}

// ~1s per attempt, and the whole reason this is a probe and not a lockfile:
// a launch that cannot get an answer within a second must proceed, not
// wait. A holder that accepts the connection and then says nothing is the
// case that pays for this timer — nothing else in a socket read bounds it.
// One silent window does not settle the question, though: nothing in a socket
// read tells a port nobody holds from one whose holder was busy for that
// second, and a box under load, a process still between its bind and its
// identity write, or a dropped SYN all produce the second shape. The probe
// retries once before it will call a silent port foreign.
//
// Until the tick's reads became asynchronous the commonest producer of that shape was this cockpit itself —
// a same-workspace holder blocked inside its own synchronous gather() when
// the probe arrived, for the 4.72–4.91s a board took to build, which no
// number of retries at this timeout would have covered. That one is gone at
// the source: the tick's reads are asynchronous and the server answers
// throughout. Raising this timeout was
// ruled out as the fix for it — it would have to clear a gather(), which
// charges every launch past a stranger-held port that much per candidate.
const PROBE_TIMEOUT_MS = 1000;
// The one address a cockpit binds, and so the one address the probe and the
// pre-bind check dial: whatever holds a candidate where this launch would
// bind answers here. 127.0.0.1 rather than `localhost` keeps a resolver out
// of the launch path, and loopback alone keeps the board — a read-only
// mirror of the ledger — off every other machine on the network; remote
// viewing goes through an `ssh -L` tunnel. IPv4 only: `::1` is left unbound,
// which is why every URL printed below names 127.0.0.1 too. `localhost`
// resolves `::1` first, and on `::1` a browser can reach some other process
// that holds the same port.
const COCKPIT_HOST = "127.0.0.1";
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
 * consequence to know: a cockpit started from a build older than the identity handshake
 * serves a payload with no `workspace` at all, so it reads as foreign and a
 * launch steps over it rather than reusing it — once, until that process is
 * restarted.
 *
 * A bare timeout gets one retry rather than folding straight into
 * "foreign": nothing in a socket read distinguishes "nobody is there" from
 * "busy for that second", and a loaded box produces the second shape. Only a
 * second silent window calls it, and says so on stderr distinctly from a
 * confirmed non-match — a shrug is not a verdict.
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
      const req = httpRequest({ host: COCKPIT_HOST, port, path: "/board.json", method: "GET" }, (res) => {
        if (res.statusCode !== 200) { finish(null); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; if (body.length > PROBE_BODY_CAP) finish(null); });
        res.on("end", () => {
          let w;
          try { w = JSON.parse(body)?.workspace; } catch { finish(null); return; }
          // Exactly the construction side's rule, because it is literally
          // the same predicate: a non-string, or the empty string,
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
  // seam is told to derive rather than obey. `??` and not `||`:
  // --port 0 is a legal ephemeral bind and `||` would discard it.
  //
  // A bind failure no longer means one thing, so the two kinds of port part
  // company here. One this script DERIVED is negotiable: the loop below
  // handshakes with whoever holds it and steps over a stranger. One
  // the caller CHOSE is not — the refusal names that port bare and dies,
  // because scanning off it would serve the board somewhere the operator did
  // not ask for and reusing it would hand them someone else's. What tells
  // them apart is `instance.derived` and not truthiness on `portGiven`: an
  // explicit `--port 0` is falsy (a legal ephemeral bind), so the old
  // spelling gave it the derived port's treatment, and nothing pinned that.
  const portGiven = port ?? argPort();
  interval = interval ?? argInterval() ?? 15;
  open = open ?? has("open");
  // Built HERE, once, and read by every tick below. Beside the other
  // argv reads rather than inside tick() for the obvious reason — a pin rebuilt
  // per tick is a pin in name only — and above the port loop because it costs
  // nothing to carry: spendDirPin() touches no filesystem until its first call,
  // so the reuse and degrade arms that exit before ticking pay nothing for it.
  // `spendDir ?? argSpendDir()`, matching the `port ?? argPort()`
  // shape above: every other argv-read option here takes an in-process
  // override, and this one hadn't, so the only way to drive --spend-dir
  // through `serve` at all was the real CLI — no test exercised it.
  const spendPin = spendDirPin(spendDir ?? argSpendDir());
  const { computeBoard } = await import("./compute-board.mjs");
  const instance = resolveCockpitInstance({ cwd: process.cwd(), gitCommonDir: gitCommonDir(), port: portGiven });
  const stateDir = instance.stateDir;
  const jsonPath = join(stateDir, "board.json");
  // The ledger's own default (ledger.mjs's defaultLedgerPath()) is
  // never reached here — board.mjs always passes an explicit --file — so an
  // absent --ledger has to be defaulted against the SAME instance the state
  // directory came from, not a cwd-relative literal. A worktree or a
  // subdirectory cwd previously left this pointing at a ledger.md that does
  // not exist there, while the state directory (above) had already moved to
  // the workspace: the board and the ledger could disagree about which run
  // they belonged to, exactly what resolveCockpitInstance() exists to rule
  // out.
  ledgerFile = ledgerFile || join(stateDir, "ledger.md");
  // `served` is the port this process actually BOUND, handed in rather than
  // closed over: it is not knowable until listen() returns (--port 0 is an
  // ephemeral bind, and the loop below may also land past a
  // candidate it could not take), and a tick that reached for `portGiven`
  // instead would stamp every board served on an ephemeral port with a
  // `port: 0` no browser could ever reach. A parameter makes that
  // unreachable rather than merely unlikely — there is no earlier value in
  // scope for it to pick up.
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
  const tick = async (served) => {
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
      const model = computeBoard(await gather({
        ledgerFile, prevFile: jsonPath, interval,
        // Beside the ledger and out of the same state directory, so
        // the board, the ledger and the heartbeat cannot disagree about which
        // run they belong to — the invariant resolveCockpitInstance() exists
        // for. Re-derived per tick rather than closed over, exactly like
        // `ledgerFile`: it is a pure join on a directory settled at bind time.
        stateFile: stateFileIn(stateDir),
        workspace: instance.workspace, port: served,
        // The pinned transcript directory, not a fresh lookup: every tick after
        // the first gets the SAME answer, which is what stops the panel
        // alternating between two sessions under one project directory.
        spendDir: spendPin(),
      }));
      const tmp = `${jsonPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(model));   // atomic: write tmp, rename over target
      renameSync(tmp, jsonPath);
    } catch (e) { console.error(`${NAME}: build tick failed: ${e.message}`); }
    finally { ticking = false; }
  };

  // A held port used to mean three different things this loop could
  // only tell apart by binding first and probing whichever candidate
  // happened to refuse — so a live cockpit that landed past a squatter
  // which has since departed was invisible the moment that squatter's port
  // freed (this process would just bind it directly), and a workspace with
  // no identity established (the degrade arm) still scanned past a held
  // port with nothing a handshake could ever match, reopening the
  // dual-cockpit hazard.
  //
  // Bind stays ahead of any handshake per candidate — only heldFailure()'s
  // bare connect precedes it: that is what lets two launches racing at start
  // settle on one winner quickly, the winner's identity published (below)
  // before it can block inside its own gather().
  // But a successful bind is not the end of the story — once this process
  // holds a candidate, the REST of the window still gets checked for a
  // live cockpit that landed further along, exactly the shape a departed
  // squatter leaves behind, and only when nothing there matches does this
  // process keep what it bound. A held candidate is probed the same way,
  // one at a time as the loop reaches it. Neither check runs at all when
  // this workspace has no identity to match on: an explicit --port
  // (`!instance.derived`) and the degrade arm (no `isWorkspaceId` identity)
  // never had a handshake to reach in the first place, so a held port for
  // either stays fatal, exactly as it was before the handshake existed.
  const candidates = cockpitPorts(instance);
  const scannable = instance.derived && isWorkspaceId(instance.workspace);
  let server = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attempt = createBoardServer(stateDir);
    // --port 0 asks the kernel for a port nobody holds; there is nothing to dial.
    const failure = (candidate === 0 ? null : await heldFailure(candidate)) ?? await bindFailure(attempt, candidate);
    if (!failure) {
      const rest = scannable ? candidates.slice(i + 1) : [];
      const holders = await Promise.all(rest.map((p) => probeCockpitWorkspace(p)));
      const matchAt = holders.indexOf(instance.workspace);
      if (matchAt === -1) { server = attempt; break; }
      attempt.close();
      const url = `http://${COCKPIT_HOST}:${rest[matchAt]}/`;
      console.error(`${NAME}: cockpit already running for this workspace on ${url}`);
      // Nothing is opened here, --open or not. This cockpit was
      // already running when this launch arrived, so its tab was the business
      // of the launch that started it; run-team's phase 0 relaunches on every
      // re-shortlist, and opening here stacked one more tab for the same
      // board each pass. Only a launch that binds a port and starts the
      // server opens one, below.
      //
      // Exit 0 — and explicitly, not by returning: a backgrounded launch
      // reports nothing but its exit code, and a handle left behind by the
      // probe would otherwise hang this process forever while it holds no
      // port at all.
      process.exit(0);
    }
    // Only a port that is TAKEN is a candidate for any of the below. EACCES
    // on a privileged port, EADDRNOTAVAIL on an unusable address, a pre-bind
    // connect that fails with anything but ECONNREFUSED: those are faults of
    // their own, and scanning past them would bury each one under an
    // exhausted-range message at the end that names the wrong problem.
    if (failure.code !== "EADDRINUSE") die(failure.message);
    if (!scannable) die(`port ${candidate} in use — pass --port <n>`);
    const holder = await probeCockpitWorkspace(candidate);
    if (holder === instance.workspace) {
      const url = `http://${COCKPIT_HOST}:${candidate}/`;
      console.error(`${NAME}: cockpit already running for this workspace on ${url}`);
      // Already running, so nothing opens — the same rule as the arm above.
      process.exit(0);
    }
    console.error(`${NAME}: port ${candidate} is held by something that is not this workspace's cockpit — trying the next port`);
  }
  if (!server) die(`no free port for this workspace — tried ${candidates.join(", ")}; pass --port <n> to choose one`);

  // Only now — with a bind this process is actually keeping — does it need
  // the state directory and board.html. Never for a launch either check
  // above already turned into a no-op: this shares the state directory
  // with whatever this workspace's live cockpit is doing, and touching it
  // before reuse was settled was a defect in the reuse
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
  // what the listen-callback gating bought and what this loop has to keep
  // paying for by position: tick() writes into stateDir, SHARED by every cwd
  // that resolves to this workspace, so a process that never binds must not
  // reach it. A second cockpit that ticked first would overwrite the live
  // one's board.json and reset every ticket's dwell clock.
  //
  // Announce the port we GOT, not the one we asked for. They differ for the
  // one value `--port 0` newly permits: listen(0) binds an ephemeral port, so
  // echoing the request prints — and --opens — http://127.0.0.1:0, which
  // reaches nothing while the board sits on a port nobody was told.
  // address() is only populated once listening, hence only here.
  const bound = server.address().port;
  console.error(`${NAME}: cockpit on http://${COCKPIT_HOST}:${bound}  (interval ${interval}s)`);

  // Publish identity the instant this port is ours — before the
  // first tick, which is the one that can be slow (gather() shells out to
  // gh and ledger.mjs). A sibling launch races this one by sending its
  // probe as soon as ITS bind attempt refuses, which can be well before
  // this process's first gather() ever returns; the answer that probe needs
  // has to already be on disk, not waiting on a compute this process has
  // not started yet.
  // `port` rides along. This stub is a board payload like any other
  // for as long as the first gather() takes, and a reader that finds it —
  // the operator, a script, the page — gets the same two identity fields
  // from it that every later tick writes. The handshake above still reads
  // only `workspace`.
  writeFileSync(`${jsonPath}.tmp`, JSON.stringify({ workspace: instance.workspace, port: bound }));
  renameSync(`${jsonPath}.tmp`, jsonPath);
  // Yield once so a connection already arriving — that same sibling's probe —
  // gets a chance to read the identity just written before this process starts
  // the first tick. The tick no longer blocks the loop, but gather()
  // still opens with a synchronous prev-board read before its first await, and
  // a turn of the loop costs nothing.
  await new Promise((resolve) => setImmediate(resolve));

  // Deliberately not awaited: the first tick is the slow one, and everything
  // below it — the timer, and the two signal handlers that are the only way
  // this process is ever asked to stop — must be in place before it returns,
  // not after. Nothing here rejects; tick() catches its own faults and the
  // `ticking` flag it sets is cleared in a finally.
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

  // --open, from this launch alone: it is the one that bound a port and
  // started a server, and the reuse arms above open nothing. Only
  // once the identity is on disk — a launcher running BEFORE that write put a
  // child squarely inside the window the identity stub exists to keep empty, where a
  // racing launch's probe finds no payload and reads this port as foreign —
  // and only after the tick, the timer and both signal handlers are in
  // place: `xdg-open` can run the browser it starts in the foreground and
  // return only when that browser exits, so a launcher awaited any earlier
  // could hold the first tick back for the whole session. openBrowser()
  // never throws; a launcher that is missing or fails is one warning line.
  if (open) await openBrowser(`http://${COCKPIT_HOST}:${bound}/`);
  await new Promise(() => {}); // run until signalled
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
