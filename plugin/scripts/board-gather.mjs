// The cockpit's raw-input half: everything upstream of computeBoard(). gather()
// reads the ledger, the `gh` issue/PR/repo/merged reads, per-PR CI and the
// member-spend transcripts, and returns exactly the shape computeBoard()
// consumes.
//
// Unlike compute-board.mjs this module is NOT pure. gather() performs real I/O
// — it spawns `gh`, `ledger.mjs` and `ci-state.mjs` and walks the transcript
// tree — so it is testable only through `PATH` stubs and fixture trees, never
// by handing it values. Splitting it out of board.mjs does not change leverage:
// every caller still reaches the board through the one board.mjs interface.
// The reason for the split is locality — a defect in a ledger, `gh` or
// transcript read points here, not at the HTTP server.
//
// Pipeline state is a pure function of ledger + GitHub. The spend panel adds
// a THIRD input that is neither — the local member-transcript tree, under
// ~/.omp/agent/sessions — so the "f(ledger, gh)" property no longer covers
// the whole model. It is
// telemetry, kept strictly to the side: it can only ever populate or omit
// `spend`, never change a ticket's stage.
//
// That transcript tree is keyed by PROJECT DIRECTORY, not by session, and one
// directory can hold several sessions at once, so nothing in the tree says
// which session is this run's. The run says it: phase 0 records the
// controller's own session directory in its receipt, `.fleet/phase0.json`,
// and receiptSpendDir() below reads it back on every tick — never latched,
// because a cockpit lives as long as its run's controller, which can start
// another run from the same omp session, and a phase-0 relaunch reuses a
// running server; either way it has to follow the next run's receipt.
// `--spend-dir <path>` overrides the receipt outright.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { computeSpend, attributeTools, mergeTools } from "./compute-spend.mjs";
import {
  isOmpSessionDirName, ompSessionTranscripts, foldOmpTranscript, ompMemberRecord,
} from "./member-record.mjs";
import { readReceipt } from "./phase0-receipt.mjs";
import { RECEIPT, RECEIPT_HELD, CLOSEOUT_RECEIPT } from "./ledger-grammar.mjs";
import { NAME, warnOnce, execRead } from "./board-common.mjs";
import { mergedReadPrs, issuesOfPrs } from "./compute-board.mjs";
import { readCostGuard } from "./fleet-tick.mjs";
import { parseFrontmatter } from "./tier-roles.mjs";
import { isImplementer } from "./member-outcomes.mjs";
import { validateTable } from "./ticket-router.mjs";
// The heartbeat's liveness mark and the controller record beside it, read here
// and never written: the heartbeat is the mark's only writer and
// `ledger.mjs rotate` the record's. stallOwner() reads the process table to
// name whose stall a stopped beat is.
import { readState, assessBeat, isStalled, stallOwner } from "./fleet-state.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// The "is this a plain JSON object" predicate and its kind word, one
// copy for the reads in this file that reject a parsed-but-wrong payload
// WHOLE — gather's `--prev` payload, gather's per-entry `tickets[i]` check,
// and readStates()'s `data.repository`. Each carried its own inline
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

// Every external read is wrapped: a failure returns null and the caller keeps a
// last-known value. Partial board beats a crashed loop or a false alarm.
async function tryRun(cmd, args) {
  const r = await execRead(cmd, args);
  if (r.error) { console.error(`${NAME}: ${cmd} ${args.join(" ")} failed: ${r.error.message}`); return null; }
  return r.stdout;
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
// build path or the serve tick's catch, exactly the crash-instead-of-degrade
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

// The merged and closed states of `prNums`, and the CLOSED-ness of `issueNums`,
// in ONE `gh api graphql` query — one aliased `pullRequest(number:)` field per
// PR and one `issue(number:)` field per issue, on the cwd's repository (gh's own
// `{owner}`/`{repo}` placeholders, the repo every other read here resolves) — so
// a PR merged at any age is found, and ten PRs cost what one does. It replaced
// `gh pr list --state merged --limit 100`, the repo's 100 most recent merges: about
// six days on 2026-09-25, so a row PR merged before that and never seen MERGED
// rendered REVIEW, turned stale and counted as claimed. Measured 2026-09-26: 400
// aliases answer in one call.
//
// An empty `prNums` makes no read at all. `state` is checked per alias, so an
// entry gh does not call MERGED is never merged, and one it does not call CLOSED
// is never closed; an issue not CLOSED is not CLOSED.
//
// A body with an object `data.repository` IS an answer even at exit 1:
// GitHub resolves every alias it can and nulls the rest — a number that is not
// a PR (or, for an issue alias, not an issue) comes back null beside a
// NOT_FOUND error, and gh exits 1 with the whole body on stdout (measured
// 2026-09-26, gh 2.101.0, which also names the number on stderr). Refusing that
// body would let one such row — a typo, or a row with no impl token keyed by an
// issue number — put every other row PR back in REVIEW on every tick. A null
// alias reads as not merged and not closed, which is what a failed read means
// for that one number.
//
// Real GitHub always answers EVERY requested PR alias, null or an object — never
// omits one — so an object naming NONE of the PR numbers is not a shape the API
// produces, only a corrupted or truncated one; `isJsonObject` alone cannot tell
// that apart from a genuine "checked, nothing matched" answer, so it is checked
// for too. Anything else is a failed read: every list empty, and
// computeBoard()'s carry-forward rule takes it from there.
async function readStates(prNums, issueNums) {
  const none = { merged: [], closed: [], closedIssues: [] };
  if (!prNums.length) return none;
  const fields = [
    ...prNums.map((n) => `p${n}:pullRequest(number:${n}){state}`),
    ...issueNums.map((n) => `i${n}:issue(number:${n}){state}`),
  ].join(" ");
  const r = await execRead("gh", ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
    "-f", `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`]);
  let repo;
  try { repo = JSON.parse(r.stdout)?.data?.repository; } catch {}
  if (!isJsonObject(repo) || !prNums.some((n) => Object.prototype.hasOwnProperty.call(repo, `p${n}`))) {
    // `how` as runCiState() spells it; never r.error.message, which repeats
    // the whole query — one field per number — into every failed tick's line.
    const how = r.code ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
    const n = prNums.length;
    console.error(`${NAME}: gh api graphql merged read (${n} PR${n === 1 ? "" : "s"}) failed (${how}) with no usable answer`);
    return none;
  }
  return {
    merged: prNums.filter((n) => repo[`p${n}`]?.state === "MERGED"),
    closed: prNums.filter((n) => repo[`p${n}`]?.state === "CLOSED"),
    closedIssues: issueNums.filter((n) => repo[`i${n}`]?.state === "CLOSED"),
  };
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

// The session directory this run's phase-0 receipt records, for a panel with
// no --spend-dir: `.fleet/phase0.json` in the cockpit's own state directory —
// the directory its ledger and heartbeat come from, so the three cannot
// disagree about which run they belong to — through phase0-receipt.mjs's
// readReceipt, the one reading of that file. The caller reads it on EVERY
// tick and keeps nothing: a cockpit survives across runs (a new run from the
// same omp session keeps it, and a phase-0 relaunch reuses a running server),
// so a session held from an earlier tick would keep showing the previous
// run's spend once the next run's receipt lands.
//
// A receipt with no session to give is `{ error }`, which the panel shows:
// the board names no session rather than guessing one. So is a recorded
// session whose NAME is not an omp `<ISO>_<uuid>` session directory:
// phase0.mjs refuses a directory with no `<dir>.jsonl` beside it, but a
// receipt it wrote before that refusal, or one written by hand, can record the
// encoded-cwd project dir instead of its own session child, and readOmpSpend
// would book every session under it — the controller's own main-session
// transcript included — as this run's agents.
// A recorded directory that does not exist yet is not an error — that is
// gatherSpend()'s quiet `null`, below.
export function receiptSpendDir(stateDir) {
  const path = join(stateDir, RECEIPT);
  const read = readReceipt(path);
  if (read.state === "ok" && read.receipt.session !== "") {
    const session = read.receipt.session;
    if (isOmpSessionDirName(basename(session))) return session;
    return { error: `phase-0 receipt ${path} records ${session}, which is not an omp <ISO>_<uuid> session directory` };
  }
  const none = "no session recorded — run phase 0 or pass --spend-dir";
  return { error: read.state === "unreadable" ? `${none} (phase-0 receipt ${path} unreadable: ${read.why})` : none };
}

// The `no-spend-dir` gate warns at most once per process PER DISTINCT ERROR.
// `dir.error` is not constant — receiptSpendDir words an unreadable receipt
// differently from a missing one — so it is keyed on the message
// itself, not the empty string this gate used to key on: an empty key
// collapsed both wordings onto the one `no-spend-dir\0` slot, so whichever
// fault landed first for a process consumed the slot and a later, genuinely
// different fault never reached stderr again for the rest of the run. Keying
// on `dir.error` fixes that without losing the steady-state behaviour: a
// receipt that stays missing is worded the same way on every tick, so a
// repeating identical fault
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
//
// `implementers`, when the caller hands in a Map, receives each implementer
// transcript's dispatch record (implementerRecord below) by member name, from
// the same fold the spend is read off: the cards' Cell lines read it, and the
// return value stays the panel's alone.
export function gatherSpend({ dir, sinceMs = null, topN = 8, explicit = false, implementers = null } = {}) {
  try {
    // `dir` is the caller's resolution, never one made here: the operator's
    // --spend-dir, or the session the phase-0 receipt records
    // (receiptSpendDir() above), or that read's `{ error }`. `null` or an
    // omitted `dir` is a caller with no session to read, and hides the panel.
    //
    // `explicit` is true only when `dir` came from the operator's
    // own --spend-dir, never from the receipt — see its uses below.
    const dirError = dir?.error;
    if (dirError) {
      warnOnce("no-spend-dir", dirError, dirError);
      return { ok: false, error: dirError };
    }
    if (!dir) return null;
    // A recorded session whose directory does not exist yet: omp creates it
    // when the session's first subagent writes there, and the cockpit
    // launches in phase 0, before that. The normal state at launch, so quiet
    // — but only ENOENT is that state. Any other failure to stat it (EACCES
    // or ENOTDIR on an ancestor) is a session the cockpit cannot read, and
    // goes to the catch's loud path below rather than hiding the panel.
    // An explicit --spend-dir that does not exist still takes the catch's
    // loud path too: an operator who named a directory hears about a typo.
    if (!explicit) {
      try { statSync(dir); } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    }
    // Here only for an EXPLICIT --spend-dir — receiptSpendDir() already holds
    // the receipt's session to this same name rule. Without this check
    // the mis-levelled path this same function's comments already name (the
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

    const { agents, toolTables, skipped, damaged } = readOmpSpend(dir, sinceMs, implementers);
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
      // Only for an EXPLICIT override — never the receipt's session holding
      // no transcripts yet, which is the normal state at launch and must
      // stay silent. An operator who named
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
function readOmpSpend(dir, sinceMs, implementers = null) {
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
      if (implementers !== null && isImplementer(m.member)) implementers.set(m.member, implementerRecord(m));
    } catch (e) {
      skipped++;
      // The prefix already names `file`; Node's errno text (`..., open|stat
      // '<file>'`) and member-record's shape refusal (`...: <file>`) end in
      // it too, so that tail is dropped. Any other wording prints whole.
      let why = String(e.message);
      for (const tail of [` '${file}'`, `: ${file}`]) {
        if (why.endsWith(tail)) { why = why.slice(0, -tail.length); break; }
      }
      warnOnce("skips", file, `skipping ${file}: ${why}`);
    }
  }
  return { agents, toolTables, skipped, damaged };
}

// An implementer's dispatch record, off its member record: the last turn's
// `model` beside what was fixed at dispatch — `session_init`'s model identity,
// the harness-written thinking level and the definition it was dispatched as.
// compute-board.mjs's cellLine reads it the way the figures read an
// implementer row.
function implementerRecord(m) {
  return { member: m.member, model: m.model, resolvedModelIdentity: m.resolvedModelIdentity, thinking: m.thinking, subagent_type: m.subagent_type };
}

// Between runs: close-out has moved `phase0.json` to `phase0.previous.json`
// while `ledger.md` still holds that run's rows, so the cards read the
// implementer transcripts of the session the held receipt names — the cards
// only: the spend panel keeps following `phase0.json` (receiptSpendDir). Into
// `implementers`, as readOmpSpend fills it; a held receipt that is absent,
// unreadable or names no omp session directory, and a directory not there,
// add nothing. A transcript that will not read is skipped under readOmpSpend's
// own once-per-file warning.
export function readHeldImplementers(stateDir, implementers) {
  const read = readReceipt(join(stateDir, RECEIPT_HELD));
  if (read.state !== "ok" || !isOmpSessionDirName(basename(read.receipt.session))) return;
  let transcripts;
  try { transcripts = ompSessionTranscripts(read.receipt.session); } catch { return; }
  for (const { file, agent, spawnDepth } of transcripts) {
    if (!isImplementer(agent)) continue;
    try {
      const m = ompMemberRecord(foldOmpTranscript(readFileSync(file, "utf8"), file), agent, spawnDepth);
      if (m) implementers.set(m.member, implementerRecord(m));
    } catch (e) {
      warnOnce("skips", file, `skipping ${file}: ${e.message}`);
    }
  }
}

// The installed router table, `router-table.json` beside the scripts, when
// `validateTable` accepts it, else null: a card words a policy row that has no
// row for its Stratum ("follows *") only off a table it could read.
export function readRouterTable(scriptDir) {
  try {
    const t = validateTable(JSON.parse(readFileSync(join(scriptDir, "router-table.json"), "utf8")));
    return t instanceof Error ? null : t;
  } catch {
    return null;
  }
}

// The Cell evidence tab's reads. Each is the whole of one input, kept apart from
// gather() so a test drives it alone; none of them throws, and a failure is
// reported in the value, which the tab words.

// The guard in the cockpit's own state directory, through the reader the tick
// judges the file by: only a guard it accepts shows figures.
export function readGuardFile(stateDir) {
  return readCostGuard(join(stateDir, "cost-guard.json"));
}

// A receipt's `metrics` step, `{ status, at, output }`, or null: no receipt, one
// that will not read, or one with no such step. Both receipts, `phase0.json` and
// `closeout.json`, carry `steps: { <name>: { status, at, output } }` and nothing
// else in common (phase0-receipt.mjs's readReceipt requires a `run` and a
// `session` that close-out's does not have), so only that is read.
export function readMetricsStep(path) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const step = isJsonObject(receipt) && isJsonObject(receipt.steps) ? receipt.steps.metrics : null;
  if (!isJsonObject(step) || typeof step.status !== "string") return null;
  return { status: step.status, at: step.at, output: typeof step.output === "string" ? step.output : "" };
}

// The installed definitions, `../agents/*.agent.md` from the script's directory:
// `{ list: [{ file, model }], error }`. `model` is the file's own `model:` value,
// null where it has none. A directory that cannot be listed is `error`, not an
// empty list: no definitions read is not no definitions.
export function readAgents(scriptDir) {
  const dir = join(scriptDir, "..", "agents");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".agent.md"));
  } catch (e) {
    return { list: [], error: `${dir}: ${e.code ?? e.message}` };
  }
  const list = [];
  for (const file of files) {
    try {
      list.push({ file, model: parseFrontmatter(readFileSync(join(dir, file), "utf8")).model });
    } catch (e) {
      return { list: [], error: `${join(dir, file)}: ${e.code ?? e.message}` };
    }
  }
  return { list, error: null };
}

// `modelRoles` is read at most once in this many milliseconds: it is one more
// child spawn per read, and a role changes rarely.
export const MODEL_ROLES_EVERY_MS = 60_000;

// A `modelRoles` read that has not answered in this many milliseconds is killed
// and reported as a failed read: gather() awaits it inside the tick, so a hung
// `omp` would otherwise hold every tick after it, not just this tab's.
export const MODEL_ROLES_TIMEOUT_MS = 10_000;

// `omp config get modelRoles --json`, in the cockpit's own environment, which can
// differ from the controller's. `{ ok: true, value }` with the record, or
// `{ ok: false, why }`.
export async function readModelRoles(timeout = MODEL_ROLES_TIMEOUT_MS) {
  const argv = ["config", "get", "modelRoles", "--json"];
  const r = await execRead("omp", argv, { timeout });
  if (r.error) {
    const how = r.code ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
    return { ok: false, why: `omp ${argv.join(" ")} failed (${how})` };
  }
  let value;
  try { value = JSON.parse(r.stdout)?.value; } catch { return { ok: false, why: `omp ${argv.join(" ")} printed non-JSON` }; }
  if (!isJsonObject(value)) return { ok: false, why: `omp ${argv.join(" ")} printed no modelRoles record` };
  return { ok: true, value };
}

// A carried `{ value, readAt, error }` read, as a previous board.json holds it, or
// null when it is anything else: the file can be hand-edited or older than this
// shape, and a carried value nobody validated is a value the page would trust.
// `error` is `{ at, message }` or null.
function heldRead(c) {
  if (!isJsonObject(c)) return null;
  const okValue = c.value === null || isJsonObject(c.value);
  const okAt = c.readAt === null || Number.isFinite(c.readAt);
  const okError = c.error === null || (isJsonObject(c.error) && Number.isFinite(c.error.at) && typeof c.error.message === "string");
  return okValue && okAt && okError ? { value: c.value, readAt: c.readAt, error: c.error } : null;
}

// The carried `modelRoles` read, read again only when its last attempt, a
// success or a failure, is a minute old or more. A failed read keeps the value
// carried, with the failure beside it: `readAt` stays the time the value was read.
export async function carryModelRoles(carried, now, read = readModelRoles) {
  const held = heldRead(carried) ?? { value: null, readAt: null, error: null };
  const lastTried = Math.max(held.readAt ?? -Infinity, held.error?.at ?? -Infinity);
  const age = now - lastTried;
  if (age >= 0 && age < MODEL_ROLES_EVERY_MS) return held;
  const r = await read();
  return r.ok ? { value: r.value, readAt: now, error: null } : { ...held, error: { at: now, message: r.why } };
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
// `spendDir` is the caller's transcript directory and is the one
// parameter here whose ABSENCE is not a default to fill in: the caller hands
// in the operator's --spend-dir or, with none, the receipt's answer for this
// tick — a directory or `{ error }` — and either has to reach gatherSpend() as
// itself. Nothing in here reads the receipt.
//
// `spendDirExplicit` is passed separately from `spendDir` itself: `spendDir`
// always arrives resolved, so its own presence cannot say whether an operator
// named it. Whether --spend-dir was given is a fact about argv. It,
// `spendSince` and `interval` are argv's answers, resolved by the caller:
// nothing in here reads argv.
// Async, because every child read below is. The event loop this frees
// belongs to serve()'s HTTP server, which shares this process — see execRead's
// note in board-common.mjs for what the synchronous version cost. `build` awaits it and is
// otherwise unchanged: one gather per process, nothing else waiting on it.
//
// `stateDir` is the workspace's `.fleet` directory, where the cost guard and the
// receipts the Cell evidence tab reads live. Null, as with `stateFile`, says no
// caller named one: that tab is then built from no guard and no receipt, and the
// cockpit's `omp` is not asked for `modelRoles`.
export async function gather({ ledgerFile, prevFile, stateFile = null, stateDir = null, scriptDir = SCRIPT_DIR, interval, workspace = null, port = null, spendDir, spendDirExplicit = false, spendSince = null }) {
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
      // same wording as readStates()'s `data.repository` read, which is this
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
        // policy this guard already shares with readStates()'s own read.
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
  // that answers whatever their merge age; see readStates(). A failed read
  // leaves every list empty, and the carry-forward in computeBoard() covers
  // exactly the PRs this set leaves out, so a failure costs only a PR never
  // yet seen MERGED, which reads REVIEW — and flags no pr-closed, since the
  // closed lists are empty too.
  const asked = mergedReadPrs({ ledger, prs, prev });
  const { merged, closed, closedIssues } = await readStates(asked, issuesOfPrs({ ledger, prs: asked }));

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
  // not just finiteness) lives at argSpendSince()'s definition in board.mjs,
  // whose main() runs it and hands the answer in as `spendSince`.
  // Each implementer's dispatch record, for the cards' Cell lines: off the
  // same transcripts the spend is read from, or — with no `phase0.json`, the
  // state between runs — off the session `phase0.previous.json` names.
  const implementers = new Map();
  const spend = gatherSpend({ dir: spendDir, sinceMs: spendSince, explicit: spendDirExplicit, implementers });
  if (stateDir !== null && !spendDirExplicit && !existsSync(join(stateDir, RECEIPT))) readHeldImplementers(stateDir, implementers);
  const routerTable = readRouterTable(scriptDir);
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
  // `ticked`, `acted` and `controller` ride beside `beat`, same file same
  // read, and under the same "no try/catch, no tryRun shape" rule just above:
  // a run is judged from all of its own marks, and the record's `at` is what
  // tells this run's marks from the previous run's (fleet-state.mjs's
  // assessBeat has the rule).
  const priorState = stateFile ? readState(stateFile, NAME) : null;
  const beat = priorState?.beat ?? null;
  const ticked = priorState?.ticked ?? null;
  const acted = priorState?.acted ?? null;
  const controller = priorState?.controller ?? null;
  // Whose stall it is, off the controller record in the same file — judged
  // here because it reads the process table, and only when the mark is
  // stalled, so a healthy board reads none. computeBoard() words it.
  const now = Date.now();
  const stallOwnerOf = isStalled(assessBeat({ beat, ticked, acted, controller, now })) ? stallOwner(controller, NAME) : null;
  // The Cell evidence tab's inputs. Every file again on every tick, nothing
  // cached, the rule of every read here; the one exception is `modelRoles`, one
  // child spawn, carried from the previous board and read again at most once a
  // minute. `stateDir` is the workspace's `.fleet`: a caller that names none names
  // no workspace, so it reads none of the workspace's records and spawns no `omp`
  // either (a guard that reads as missing, no receipts, the read carried as it was).
  const guard = stateDir === null ? { status: "missing" } : readGuardFile(stateDir);
  const receipts = stateDir === null
    ? { phase0: null, closeout: null }
    : { phase0: readMetricsStep(join(stateDir, RECEIPT)), closeout: readMetricsStep(join(stateDir, CLOSEOUT_RECEIPT)) };
  const agents = readAgents(scriptDir);
  const modelRoles = stateDir === null ? heldRead(prev?.modelRoles) : await carryModelRoles(prev?.modelRoles, now);
  return { ledger, issues, prs, merged, closed, closedIssues, ci, prev, repo, repoUrl, workspace, port, spend, beat, ticked, acted, controller, stallOwner: stallOwnerOf, poolOk,
    poolCapped, prsCapped, guard, receipts, agents, modelRoles, implementers: [...implementers.values()], routerTable,
    now, interval };
}
