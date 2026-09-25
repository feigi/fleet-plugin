#!/usr/bin/env node
// The Shortlist (ADR 0013 §1, §3; docs/specs/2026-09-24-slot-based-fleet-loop-design.md
// § 1): the ordered list of tickets the controller may admit, built from cheap
// filters only. No ticket body is read here — a Pull reads one ticket in full
// at the moment it admits it (ADR 0013 §2); this file decides which tickets are
// worth that read, and in what order.
//
// The filters, in the order they run:
//
//   1. `candidates.mjs --require-label ready-for-agent`, oldest-first and never
//      re-ranked. Its row count is `scanned`, the supply the tick reports.
//   2. The dependency scan on each row's `d`: an open blocker drops the ticket
//      (next-ticket step 2). A blocker that is itself a candidate is open by
//      construction — candidates.mjs queries `--state open` — so only the rest
//      cost a `gh issue view <N> --json state`, which answers for a PR number
//      as well as an issue. A ticket naming itself blocks nothing.
//   3. Live Exclusions. A ticket whose ledger row reads `excluded ·
//      behind-pr:#M` or `excluded · behind-issue:#M` stays out while its
//      premise holds: `behind-pr` is asked of `gh pr view M`, which takes the
//      PR number or the branch name recorded before that PR existed, and
//      `behind-issue` of `gh issue view M`. MERGED or CLOSED lifts either.
//      Nothing here rewrites the row — the Pull that admits the ticket does —
//      so a lifted ticket re-enters in its oldest-first slot simply because
//      step 1's order is the only order there is.
//   4. `inflight.sh <N>` per survivor: exit 1 is taken, and every other
//      non-zero exit is an in-flight check that could not answer, which is
//      never "free". Both drop the ticket.
//
// ADR 0013 lists step 3 last. Steps 2-4 only intersect, so their order changes
// what they cost and nothing else: the ledger is a local read and a premise
// one `gh` call, while inflight.sh is three network round-trips (measured at
// 2.6 s a ticket against this repository, 23 live candidates), so it runs on
// what the cheaper two leave.
//
// Every probe that cannot answer fails CLOSED and is logged by ticket number:
// an unreadable blocker counts as open, an unreadable premise leaves its
// exclusion standing, an unanswered in-flight check counts as taken. A ticket
// dropped wrongly waits one refresh; a ticket admitted wrongly costs a Pull's
// full read at best and two members on one ticket at worst.
//
// What REFUSES instead (exit 2), leaving the previous file exactly as it was: a
// scan that did not answer, a ledger that could not be read, a workspace that
// could not be resolved, a file that could not be written. An empty shortlist
// written in any of those cases would read as "no work". Exit 0 is the file
// written, an empty shortlist included — the empty queue is an answer. Never
// exit 1: this script has no verdict to report (docs/specs/2026-07-23-fleet-plugin-design.md
// § Script surface), and 1 is also Node's own code for a crash.
//
// The file is `<workspace>/.fleet/shortlist.json`, the workspace resolved from
// `git rev-parse --git-common-dir` through git-env.mjs, exactly as ledger.mjs's
// defaultLedgerPath() resolves `.fleet/ledger.md` — so the controller, the tick
// and a member in its own worktree all name one file. Unlike the ledger there
// is no cwd-relative degrade: outside a repository inflight.sh cannot answer
// for a single ticket either, so there is nothing honest to write. The payload
// is `{scanned, shortlist: [{n, t}]}`, written to a sibling temp file and
// renamed over the target so a reader never sees half of it; stdout carries
// the same object plus `file`.
//
// The ledger is read through `ledger.mjs read`, never parsed here, so the
// ledger keeps one parser. candidates.mjs's stderr passes straight through —
// the per-candidate lines phase 0 always read, #1032's dependency-heading
// notice among them. inflight.sh's and gh's are captured and summarised, one
// line per dropped ticket.

import { spawnSync, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, writeAll, isDigits } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

const NAME = "shortlist";
const die = makeDie(NAME);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LABEL = "ready-for-agent";
// The states that lift a premise or clear a blocker. `gh pr view` answers
// OPEN, CLOSED or MERGED; `gh issue view` answers OPEN or CLOSED for an issue
// and the PR's own state for a PR number — so one set serves every probe here.
const CLOSED = new Set(["MERGED", "CLOSED"]);
// Network probes run this many at a time. inflight.sh alone is ~2.6 s a
// ticket, so 23 candidates probed one after another cost up to a minute of the
// tick's turn. Results land by index, so the order written is candidates.mjs's,
// whatever order the probes finish in.
const IN_FLIGHT = 4;
// Bounds on children that could otherwise never return. None is a stopwatch:
// each is far past the healthy case (a `rev-parse` answers in milliseconds, a
// `gh … view` in under a second, inflight.sh in ~2.6 s), and each timeout
// lands on the same fail-closed path as any other failed probe.
const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 20_000;
const INFLIGHT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Synchronous, so a die() that follows cannot strand a log line in an async
// stderr queue when it exits.
const log = (line) => writeAll(2, `${line}\n`);

// The last non-blank line a child printed, bounded: a cause, not a transcript.
function lastLine(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.at(-1) ?? "";
  return line.length > 300 ? `…${line.slice(-300)}` : line;
}

// How a child that did not exit 0 ended, for a log line or a refusal.
function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  return r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
}

function describe(r) {
  const said = lastLine(r.stderr);
  return said ? `${how(r)}: ${said}` : how(r);
}

// execFile, promised, with its error folded into spawnSync's result shape.
// execFile packs three things into `err`: a numeric `code` is the child's own
// exit status, a `signal` is a kill (the timeout's among them), and anything
// else is a child that never ran — ENOENT and the like.
function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, ...options }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
      const signal = err?.signal ?? null;
      resolve({ status, signal, error: err && status === null && !signal ? err : null, stdout, stderr });
    });
  });
}

// fn over items, IN_FLIGHT at a time, results in the items' own order.
async function eachLimited(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, items.length) }, worker));
  return results;
}

function shortlistPath() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: gitEnv(),
  });
  const workspace = workspaceDirFromGitCommonDir(r.stdout);
  if (workspace === null) {
    die(`could not resolve the workspace — git rev-parse --git-common-dir: ${describe(r)}`);
  }
  return join(workspace, ".fleet", "shortlist.json");
}

function scan() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "candidates.mjs"), "--require-label", LABEL], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.error) die(`candidates.mjs did not run: ${how(r)}`);
  const out = (r.stdout ?? "").trim();
  // Exit 1 (an empty queue) and exit 3 (every row a to-spec spec) are both the
  // empty answer. Exit 1 is also Node's own code for a crash, so the payload
  // decides, the way fleet-tick.mjs's readSupply() reads the same script.
  if ((r.status === 1 || r.status === 3) && out === "[]") return [];
  if (r.status !== 0) {
    die(`candidates.mjs ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`} — the scan did not answer, so there is no shortlist to write`);
  }
  let rows;
  try {
    rows = JSON.parse(out);
  } catch (e) {
    die(`could not parse candidates.mjs output: ${e.message}`);
  }
  if (!Array.isArray(rows)) die("candidates.mjs did not return an array");
  const bad = rows.findIndex(
    (row) => !row || !Number.isInteger(row.n) || typeof row.t !== "string" ||
      !Array.isArray(row.d) || !row.d.every(Number.isInteger),
  );
  if (bad !== -1) die(`candidates.mjs row ${bad} is not {n, t, d} with integer refs`);
  return rows;
}

function ledgerRows() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "ledger.mjs"), "read"], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.error) die(`ledger.mjs read did not run: ${how(r)}`);
  if (r.status !== 0) {
    die(`ledger.mjs read ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`} — no exclusion could be honoured, so there is no shortlist to write`);
  }
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch (e) {
    die(`could not parse ledger.mjs read output: ${e.message}`);
  }
  if (!data || !Array.isArray(data.rows) || !data.rows.every((row) => typeof row === "string")) {
    die("ledger.mjs read returned no rows[] of strings");
  }
  return data.rows;
}

// A ticket row is `#N <text>`; it is an exclusion when `excluded` is the text's
// first word — `impl-N · … excluded …` is a row about something else. Answers
// the premises the row names, possibly none, or null for any other row.
const EXCLUDED_ROW = /^#[0-9]+[ \t]+excluded(?=[ \t]|$)([\s\S]*)$/;
const PREMISE = /\bbehind-(pr|issue):#?([^\s,;]+)/g;
function premisesOf(row) {
  const m = EXCLUDED_ROW.exec(row);
  if (!m) return null;
  return [...m[1].matchAll(PREMISE)].map(([, kind, target]) => ({ kind, target }));
}

// gh takes a `-`-led argument as a flag, and `gh issue view` takes a number.
const askable = ({ kind, target }) => !target.startsWith("-") && (kind === "pr" || isDigits(target));
const premiseKey = ({ kind, target }) => `${kind} ${target}`;
const premiseLabel = ({ kind, target }) => `behind-${kind}:#${target}`;

async function probeState(kind, target) {
  const r = await run("gh", [kind, "view", target, "--json", "state"], { timeout: GH_TIMEOUT_MS });
  if (r.status !== 0) return { error: describe(r) };
  let state;
  try {
    ({ state } = JSON.parse(r.stdout));
  } catch {
    // Unparseable: `state` stays undefined and is refused as missing.
  }
  return typeof state === "string" && state
    ? { state }
    : { error: `gh ${kind} view ${target} answered no state: ${lastLine(r.stdout)}` };
}

function inflightPayload(r) {
  try {
    const p = JSON.parse(r.stdout);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

async function main() {
  const extra = process.argv.slice(2);
  if (extra.length) die(`takes no arguments, got ${extra.join(" ")}`);
  const file = shortlistPath();
  const rows = scan();
  const ledger = ledgerRows();

  // Dependency scan.
  const candidates = new Set(rows.map((row) => row.n));
  const blockersOf = (row) => row.d.filter((b) => b !== row.n);
  const unknownBlockers = [...new Set(rows.flatMap(blockersOf))].filter((b) => !candidates.has(b));
  const blockerStates = await eachLimited(unknownBlockers, (b) => probeState("issue", String(b)));
  const blocker = new Map(unknownBlockers.map((b, i) => [b, blockerStates[i]]));
  const blockedBy = (row) => {
    for (const b of blockersOf(row)) {
      if (candidates.has(b)) return `open blocker #${b}`;
      const s = blocker.get(b);
      if (s.error) return `blocker #${b}'s state could not be read (${s.error}), so it counts as open`;
      if (s.state === "OPEN") return `open blocker #${b}`;
      if (!CLOSED.has(s.state)) return `blocker #${b} is ${s.state}, not MERGED or CLOSED`;
    }
    return null;
  };
  const unblocked = rows.filter((row) => {
    const why = blockedBy(row);
    if (why) log(`    #${row.n} dropped — ${why}`);
    return !why;
  });

  // Live exclusions. One row per ticket, rewritten in place by ledger.mjs, which
  // matches the FIRST row carrying a key — so the first is the one read here.
  const rowOf = new Map();
  for (const line of ledger) {
    const key = line.split(/\s/)[0];
    if (!rowOf.has(key)) rowOf.set(key, line);
  }
  const excluded = new Map();
  for (const row of unblocked) {
    const line = rowOf.get(`#${row.n}`);
    const premises = line === undefined ? null : premisesOf(line);
    if (premises) excluded.set(row.n, premises);
  }
  const premiseKeys = [...new Set([...excluded.values()].flat().filter(askable).map(premiseKey))];
  const premiseStates = await eachLimited(premiseKeys, (k) => probeState(...k.split(" ")));
  const premise = new Map(premiseKeys.map((k, i) => [k, premiseStates[i]]));
  const stillExcluded = (premises) => {
    if (premises.length === 0) return "excluded with no behind-pr:/behind-issue: premise to probe, so the exclusion stands";
    for (const p of premises) {
      if (!askable(p)) return `excluded · ${premiseLabel(p)}, which gh cannot be asked about, so the exclusion stands`;
      const s = premise.get(premiseKey(p));
      if (s.error) return `excluded · ${premiseLabel(p)}, whose state could not be read (${s.error}), so the exclusion stands`;
      if (!CLOSED.has(s.state)) return `excluded · ${premiseLabel(p)}, which is ${s.state}`;
    }
    return null;
  };
  const admissible = unblocked.filter((row) => {
    const premises = excluded.get(row.n);
    if (!premises) return true;
    const why = stillExcluded(premises);
    if (why) {
      log(`    #${row.n} dropped — ${why}`);
      return false;
    }
    log(`    #${row.n} lifted — ${premises.map((p) => `${premiseLabel(p)} is ${premise.get(premiseKey(p)).state}`).join(", ")}`);
    return true;
  });

  // In-flight check.
  const verdicts = await eachLimited(admissible, (row) =>
    run("sh", [join(SCRIPT_DIR, "inflight.sh"), String(row.n)], { timeout: INFLIGHT_TIMEOUT_MS }));
  const survivors = admissible.filter((row, i) => {
    const r = verdicts[i];
    if (r.status === 0) return true;
    const p = inflightPayload(r);
    if (r.status === 1) {
      const hits = Array.isArray(p?.hits) && p.hits.length ? `: hits ${p.hits.join(",")}` : "";
      log(`    #${row.n} dropped — taken (inflight.sh exit 1${hits})`);
    } else {
      const why = Array.isArray(p?.unknown) && p.unknown.length ? p.unknown.join("; ") : lastLine(r.stderr);
      log(`    #${row.n} dropped — in-flight check could not answer (inflight.sh ${how(r)})${why ? `: ${why}` : ""}`);
    }
    return false;
  });

  const payload = { scanned: rows.length, shortlist: survivors.map(({ n, t }) => ({ n, t })) };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    die(`cannot write ${file}: ${e.message}`);
  }
  log(`${NAME}: ${payload.shortlist.length} of ${payload.scanned} scanned → ${file}`);
  // Printed and left to drain, never followed by process.exit(): stdout on a
  // pipe is async, and an exit would cut the payload mid-JSON (#246).
  console.log(JSON.stringify({ file, ...payload }));
}

try {
  await main();
} catch (e) {
  // Nothing inside main() is expected to throw; if something does, the answer
  // is still "could not answer", never Node's exit 1.
  die(`unexpected failure: ${e?.stack ?? e}`);
}
