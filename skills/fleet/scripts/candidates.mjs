#!/usr/bin/env node
// Open issues that are candidates for work, reduced to the fields a shortlist
// needs.
//
// Never fetches raw bodies for the whole list — they are ~97% of the payload.
// The body is reduced server-side to dependency references only.
//
// The label policy is a FLAG, not prose. `next-ticket` may drop a required
// label and retry when the result is empty; the fleet must not, because an
// empty ready-for-agent queue means there is no work, not that the net should
// widen — ready-for-human tickets need a human to brainstorm first, and an
// unattended fleet has no channel to one.

import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { parseArgs } from "node:util";

const NAME = "candidates";

// writeSync, not console.error. On a pipe — which is every caller that captures
// this script — process.stderr.write is ASYNC, and the process.exit below
// discards whatever is still queued. gh's forwarded stderr goes first and this
// line goes last, so the refusal is the first thing dropped: measured, a 70 KB
// gh stderr swallowed it entirely and the caller saw exit 2 with no cause.
//
// The leading newline is load-bearing, not formatting. writeSync goes straight
// to the fd while the forwarded stderr is still draining through the stream, so
// this text lands wherever the child's output happens to be — mid-line, with no
// separator. Every reader of this script's refusals, tests included, matches
// them line-anchored; without this they silently stop matching under exactly
// the large-stderr failure the writeSync is here to survive.
function die(msg) {
  writeSync(2, `\n${NAME}: ${msg}\n`);
  process.exit(2);
}

// Refuses here, once, rather than at each call site: a flag given without a
// value yields `undefined`, and every caller reads a falsy result as "the flag
// was absent" — `--limit` falls back to 500 past its own positive-integer
// guard, and `--require-label` runs the UNFILTERED query at exit 0, the exact
// widening `--allow-fallback` gates. Both are the malformed invocation reading
// as a successful one that this file's exit codes exist to tell apart.
//
// Four spellings reach that one harm, so all four are refused here: no value,
// an empty or blank value (`--require-label "$LABEL"` with the var unset), a
// value that is itself a `--flag`, and the `--flag=value` form `indexOf` cannot
// see. The last two are the interesting ones. Rejecting a `--`-prefixed value
// does forfeit a real capability — GitHub permits a label named `--watch`, and
// `denoland/deno` has one — but no caller passes a variable label, this repo
// has no such label, and refusing loudly beats resolving it to the unfiltered
// query. `--flag=value` is otherwise invisible: `indexOf` misses it, `arg()`
// reports the flag absent, and the caller widens exactly as if it were.
//
// Neither caller is a hand-typed CLI — both are markdown read by a model — so
// a malformed invocation is more plausible here than the shape of this guard
// suggests.
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (process.argv.some((a) => a.startsWith(`--${name}=`))) die(`--${name} needs a space-separated value, not --${name}=`);
    return null;
  }
  const value = process.argv[i + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) die(`--${name} needs a value`);
  return value;
}
const has = (name) => process.argv.includes(`--${name}`);

const requireLabel = arg("require-label");
const allowFallback = has("allow-fallback");

// Default well above the proving ground's real volume. Measured 2026-07-23:
// 106 issues survive the exclusions, so the previous hardcoded 100 dropped six
// of them — silently, because a truncated list is indistinguishable from a
// complete one. A high-priority ticket sitting at position 101 was invisible to
// the fleet and nothing said so.
const limit = Number(arg("limit") ?? 500);
if (!Number.isInteger(limit) || limit < 1) die(`--limit must be a positive integer, got '${arg("limit")}'`);

// The accepted flag set, declared once, and the only check on flag NAMES.
// Nothing checked them until #173: an unrecognised flag was ignored, so
// `--label ready-for-agent` — the spelling run-team's own phase 0 rule carried
// — ran the UNFILTERED query at exit 0, the widening `--require-label` exists
// to prevent.
//
// Runs BELOW the value guards, deliberately: where both would refuse — notably
// `--require-label` and `--limit` given with no value — arriving second leaves
// the refusal to #169's wording above rather than Node's. Nothing above emits
// output or runs a query, so refusing this late is still refusing before gh.
//
// The catch is unconditional, and THAT is the guard. Testing `e.code` for
// `ERR_PARSE_ARGS_UNKNOWN_OPTION` is what shipped first and it did not hold.
// `parseArgs` throws on the FIRST offending argument, so dropping any other
// code does not narrow the guard, it disables it for every argv where such an
// argument comes earlier — the unknown flag behind it is never reached. Two
// other codes were measured on node v26.5.0: ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL
// for a bare positional, ERR_PARSE_ARGS_INVALID_OPTION_VALUE both for
// `--boolflag=value` and for a string flag left without its value.
//
// Measured on that version: `ready-for-agent`, `junk --label ready-for-agent`
// and `--allow-fallback=true --label ready-for-agent` each ran the UNFILTERED
// query at exit 0, while `--label ready-for-agent` and
// `--require-label x --bogus` both refused. Position is not what decided it —
// a bad flag last still refused — only whether something earlier threw a code
// the catch dropped.
const OPTIONS = {
  "require-label": { type: "string" },
  "allow-fallback": { type: "boolean" },
  "limit": { type: "string" },
};
// No `strict: true`: strict IS parseArgs' default, and stays the default when
// `allowPositionals`, `tokens` or `allowNegative` are added alongside it —
// measured across 48 argv shapes with and without, zero differences in error
// code, message or `{values, positionals}`.
try {
  parseArgs({ options: OPTIONS });
} catch (e) {
  die(`${e.message} — accepted: ${Object.keys(OPTIONS).map((f) => `--${f}`).join(", ")}`);
}

if (allowFallback && !requireLabel) die("--allow-fallback is meaningless without --require-label");

const EXCLUDE =
  "-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info";
const JQ =
  '[.[]|{n:.number,t:.title,l:[.labels[].name],' +
  'spec:((.body//"")|test("(?m)^##\\\\s+User Stories\\\\s*$")),' +
  'd:[(.body//""|scan("(?i)(?:depends on|blocked by|requires|after)\\\\s+#\\\\d+"))]}]';

function query(label) {
  const search = label ? `${EXCLUDE} label:${label}` : EXCLUDE;
  const args = [
    "issue", "list",
    "--state", "open",
    "--limit", String(limit),
    "--search", search,
    "--json", "number,title,labels,body",
    "--jq", JQ,
  ];
  console.error(`$ gh ${args.join(" ")}`);
  let out;
  try {
    out = execFileSync("gh", args, { encoding: "utf8" });
  } catch (e) {
    // Fail closed. A failed query and an empty queue are different facts, and
    // only one of them means "there is no work".
    //
    // Names the cause, never gh's stderr — same discipline as the row-shape
    // refusal below. execFileSync forwards the child's stderr to ours already
    // (it does so precisely because `stdio` is absent from the options above —
    // Node gates the forward on `!options.stdio`, so adding one silently makes
    // this message the only report). Interpolating `e.stderr` therefore emitted
    // every byte twice: measured 7,700 B of gh stderr → 15,454 B, into a caller
    // that is markdown read by a model. `e.message` is the same string, not a
    // safer fallback — Node builds it as `Command failed: <cmd>\n<stderr>`.
    //
    // Three disjoint shapes, so three branches. `e.code` is set when Node
    // itself aborted the call: ENOENT (nothing spawned, nothing printed),
    // ENOBUFS/ETIMEDOUT (the child ran and printed, then Node killed it).
    // `e.signal` is the only field a signal death sets — without it this reads
    // `exit null`, naming nothing, for the OOM kill and the SIGPIPE. `e.status`
    // carries a real exit code, whose stderr the caller has already seen.
    die(
      `gh issue list failed: ${
        e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)
      }`,
    );
  }
  const trimmed = out.trim();
  // Not `return []`. The reduction is `[…]`-wrapped, so it emits an array for
  // every input including none — empty output means it did not run, which is
  // the same fact as the shape check below, not an empty queue.
  if (trimmed === "") die("gh returned no output — the --jq reduction did not apply");
  let rows;
  try {
    rows = JSON.parse(trimmed);
  } catch (e) {
    die(`could not parse gh output as JSON: ${e.message}`);
  }
  // The reduction runs inside gh, not here, so nothing at this end guarantees
  // it applied — an older gh, an expression it rejects, an error object from a
  // proxy. Unchecked, the wrong shape flows on until the first use of it
  // throws, and an uncaught throw exits 1: the code reserved for "successful
  // query, no survivors". Fail closed, same as the failed-query path above.
  if (!Array.isArray(rows)) die("gh output is not an array — the --jq reduction did not apply");
  const bad = rows.findIndex(
    (r) =>
      !r ||
      typeof r.n !== "number" ||
      typeof r.t !== "string" ||
      !Array.isArray(r.l) ||
      !Array.isArray(r.d) ||
      typeof r.spec !== "boolean",
  );
  // The row is named, never dumped: an unreduced payload carries every issue
  // body, ~97% of what this file refuses to fetch in the first place.
  // Says what is wrong, not why: this also fires when the reduction ran fine
  // and the upstream field types were not what it assumed, so it cannot claim
  // the reduction did not apply the way the two checks above can.
  if (bad !== -1) die(`gh output row ${bad} is not {n,t,l,d,spec} — not the shape the --jq reduction produces`);
  return rows;
}

// Hitting the limit exactly means the answer may be incomplete, and there is
// no way to tell from the result itself. Refuse rather than hand back a
// shortlist that silently omits work — "no silent caps" is the rule this
// enforces. Applied verbatim to BOTH the labeled query and the fallback
// query below — the fallback result was previously never re-checked, so
// --require-label <nonexistent> --allow-fallback could ship a silently
// truncated unfiltered list.
function refuseIfCapped(rows, description) {
  if (rows.length === limit) {
    die(
      `exactly ${limit} results${description} — the list is capped and may be truncated. ` +
        `Re-run with a higher --limit; a shortlist that silently drops tickets is not an answer.`,
    );
  }
}

// `## User Stories` is to-spec's signature — mandatory in its template, absent
// from every ticket template. to-spec stamps a whole spec `ready-for-agent`
// with "no need for additional triage", so it arrives looking admissible; it is
// to-tickets' INPUT, not a ticket, however well decided it is.
//
// ponytail: shape-match on to-spec's template, and no markdown awareness — a
// ticket quoting `## User Stories` inside a fenced block is dropped too. Not
// worth a fence parser: every drop is logged by number, so a false positive is
// loud rather than silent.
//
// This is the ONLY line of defence — nothing downstream catches a spec. A
// leaked one is decided and needs no human hands, so it passes both of phase
// 2's bail tests, and heavy is explicitly never a bail reason (run-team:180).
// Change to-spec's template and this predicate goes with it, or a member
// implements an entire spec as one ticket.
function dropSpecs(rows) {
  const kept = [];
  for (const { spec, ...rest } of rows) {
    if (spec) {
      // "no silent caps" covers drops too — a filtered list that does not say
      // what it filtered is indistinguishable from a complete one.
      console.error(`    dropped #${rest.n} — to-spec spec, not a ticket (## User Stories)`);
    } else {
      kept.push(rest);
    }
  }
  return kept;
}

let rows = query(requireLabel);
console.error(`    ${rows.length} candidate(s)${requireLabel ? ` with label:${requireLabel}` : ""}`);
refuseIfCapped(rows, requireLabel ? ` with label:${requireLabel}` : "");
// After refuseIfCapped, never before: filtering first can shrink the array below
// `limit` and the cap check would stop seeing a truncated list. Before the
// emptiness test below, never after: a queue whose every row was filtered out
// IS an empty queue — see #60. Telling that case apart from a genuinely empty
// one, for a caller reading only the exit code, is #64 and still open.
rows = dropSpecs(rows);

if (rows.length === 0 && allowFallback && requireLabel) {
  console.error(`${NAME}: empty with label:${requireLabel}; --allow-fallback given, retrying unfiltered`);
  rows = query(null);
  console.error(`    ${rows.length} candidate(s) unfiltered`);
  refuseIfCapped(rows, " unfiltered (fallback)");
  // After refuseIfCapped for the same reason as above; the emptiness half does
  // not transfer, as no gate follows this one. The call must exist because the
  // fallback's rows arrive raw and nothing downstream drops a spec.
  rows = dropSpecs(rows);
}

// FIFO among survivors. Issue number is monotonic in creation order, so this
// needs no extra field and no query semantics. Dependencies do not rank —
// blocked tickets are dropped by the CONSUMER reading `d` (run-team step 2 /
// next-ticket step 2), not here, and to-tickets publishes chains blockers-first
// so lower numbers are the blockers anyway. Note that drop under-fires: the `d`
// scan misses to-tickets' `## Blocked by` heading form and native sub-issue
// links, so blocked tickets do reach this sort — see #58.
rows.sort((a, b) => a.n - b.n);

for (const r of rows) {
  console.error(`    #${r.n} [${r.l.join(",")}] ${r.t}${r.d.length ? `  deps:${r.d.join(";")}` : ""}`);
}

// Compact: the pretty per-candidate view already went to stderr above; this
// payload is parsed by a machine, and indenting up to `--limit` issues is pure
// token cost in the controller's context.
console.log(JSON.stringify(rows));

// Exit 1 for a successful query with no survivors. The caller must be able to
// tell "the queue is empty" from "the query broke" (2) without reading stderr.
//
// exitCode, not exit(): stdout on a pipe is async too, and process.exit() drops
// the queued payload at the 64 KiB buffer while still reporting 0. Measured,
// 499 rows — one under the DEFAULT --limit — arrived truncated mid-JSON at exit
// 0, the corrupt-payload-typed-as-success this file's exit codes exist to make
// impossible. refuseIfCapped cannot see it: that fires at exactly `limit`.
process.exitCode = rows.length === 0 ? 1 : 0;
