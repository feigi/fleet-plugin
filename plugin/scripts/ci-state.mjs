#!/usr/bin/env node
// Bind a CI run to a PR's head and report whether it is genuinely green.
//
// Replaces the four-way run-binding check restated in three fleet documents.
// The failure it prevents: `gh pr checks` aggregates conclusions ACROSS runs and
// reports a `pass` inherited from a cancelled run on a superseded SHA. Head-SHA
// binding alone misses it, because the head is right and only the conclusions
// belong elsewhere.
//
// Nothing here is cached. A rerun rewrites a run in place, so a conclusion can
// invert under a fixed run id with nothing pushed. The only safe design is to
// re-query at the moment of decision, which is what this script is for.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { makeDie, makeArg, makeNumArg, makeHas, makeSweep, makeStray } from "./arg.mjs";

const NAME = "ci-state";

// die()/arg()/numArg()/has() shared with the other fleet scripts — see
// arg.mjs for the fail-open (#61/#169/#364/#878) and pipe-safety
// (#176/#328/#363) rationale.
// `base`/`workflow`/`workflow-file` below all fall back with `||`, so a
// trailing `--base` (nothing after it) used to read as omitted and silently
// compare against the DEFAULT base — `ci-state.mjs --pr 5 --base` gave a
// real, wrong verdict at exit 0/1 with no refusal, reached here because THIS
// is the verdict the fleet gates on. die() also has to survive --quiet,
// which is the mode the controller's CI Monitor polls in.
const die = makeDie(NAME);
const arg = makeArg(die);
const numArg = makeNumArg(die);
const has = makeHas(die);
const sweep = makeSweep(die);
const stray = makeStray(die);

// `--quiet` suppresses the diagnostic stream (command echoes, per-job/per-field
// lines) and drops `jobs` and `missing` from the payload. The controller's CI
// Monitor (and, standalone, the reviewer's own watch loop) polls this hot, and
// none of that stream is acted on — `reasons` already names every failing job,
// and the exit code already encodes green/not-green. die() and the one-line
// verdict summary still print, so a caller loses nothing it decides on.
const quiet = has("quiet");
const vlog = (...a) => {
  if (!quiet) console.error(...a);
};

// #262. A refusal from an exhausted REST quota reached the same arm as every
// other gh read failure, so a caller could not tell an outage that clears on
// its own from a repo or token that will still be unreadable after any wait.
// The cause is only ever in gh's own stderr, which execFileSync BOTH forwards
// to our fd 2 and captures on the thrown error (measured) — so it is matched
// here without being reprinted, for the reason run() gives below: interpolating
// it emits every byte twice.
//
// Matched on the quota wording rather than on the 403 status, because 403 also
// carries refusals no amount of waiting clears. One expression spans the
// spellings a quota is refused with: the primary limit, the secondary one, and
// the abuse-detection wording GitHub used for that same secondary limit before
// renaming it — which a GitHub Enterprise Server predating the rename still
// emits, and this script does reach GHE (the behind probe passes --hostname).
//
// `abuse detection` in full, never a bare `abuse`: "disabled for abuse of
// GitHub's terms of service" is a permanent refusal, and the short form
// relabels it a blip that clears itself (measured).
const RATE_LIMITED = /rate limit|abuse detection/i;

// The outage payload, on stdout at the unchanged exit 2 — where this arm
// printed nothing at all. A caller reading only the exit code is unaffected;
// one parsing stdout gets a named cause instead of the empty capture
// run-team/SKILL.md calls "the safe direction, but still a false one".
//
// It reports the refused query and nothing else. A quota refusal is a probe
// that could not look, so every field this script would otherwise observe is
// ABSENT rather than null. A null is a reading, and nothing here was read.
//
// Absence is what a direct reader needs: run-team/SKILL.md sends a merge bot to
// "gate on the payload's own fields", and an absent `missing` refuses that gate
// where an empty array would have told it nothing was missing. board.mjs is not
// that reader — it takes exit 2 as a failed read whatever was printed on the
// way out, and carries its previous CI value for the PR forward instead.
//
// Every write this script makes on its way out goes through here, for die()'s
// reason in arg.mjs: on a pipe, console.log/console.error hand the bytes to an
// ASYNC stream, and process.exit() discards whatever is still queued rather than
// draining it. The kernel takes one pipe buffer synchronously and the rest is
// dropped, so a payload past that size is cut mid-JSON while the exit code
// arrives intact — the caller reading the code sees a normal verdict and the
// caller parsing stdout gets bytes it cannot parse. writeSync goes straight to
// the fd, which is what survives process.exit(). It also takes no newline of its
// own, which is why every caller supplies the one console.log used to append.
//
// One writeSync is not enough, which is why this loops on the count it returns.
// Initialising a stream for an fd — what vlog's console.error does to fd 2 —
// puts that fd in O_NONBLOCK, and a non-blocking write to a pipe whose reader
// has left it full SHORT-WRITES: it returns the count it managed and throws
// nothing at all. A single call therefore cut the verdict line at one buffer
// with no throw for the catch to see and nothing logged — the failure the catch
// cannot cover, because the write reported success. Measured on this platform:
// asking for 200000 bytes on an fd a console.error had touched delivered 65536
// and returned normally, where the same write on an untouched fd blocks until
// the whole of it lands. Consuming the return value makes both fds behave the
// way the untouched one does.
//
// The catch is what keeps the exit code honest, and it is not optional. Once a
// reader is slow enough to leave this fd saturated and non-blocking, writeSync
// throws EAGAIN where console.log swallowed the failure; uncaught, that throw
// would skip the process.exit() the caller is about to make and drop the process
// to exit 1 — the code this script reserves for not-green. EAGAIN says the
// buffer is momentarily full, not that the write failed, so it waits for the
// reader and retries; every other code returns and loses the bytes, which is the
// behaviour that was already there. Losing a green verdict would be new, and
// worse than the truncation being fixed here. The wait is what keeps that retry
// from spinning: against a reader asleep three seconds, a bare `continue` burned
// a full core for the whole stall where the 1ms wait burned almost none, both
// delivering the same bytes.
function emit(fd, text) {
  let buf = Buffer.from(text);
  while (buf.length) {
    try {
      buf = buf.subarray(writeSync(fd, buf));
    } catch (e) {
      // The message may be lost; the exit code that follows it must not be.
      if (e.code !== "EAGAIN") return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

function emitRateLimited(query) {
  const payload = {
    pr,
    verdict: "rate-limited",
    reasons: [`${query} was refused by the GitHub API rate limit — no CI state was read. A quota refusal clears on its own: re-probe rather than reading this as a CI verdict`],
  };
  emit(1, `${JSON.stringify(payload)}\n`);
}

function run(cmd, args) {
  vlog(`$ ${cmd} ${args.join(" ")}`);
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (e) {
    // Names the cause, never the child's stderr — execFileSync forwarded it
    // already (no `stdio` above), so interpolating it emits every byte twice.
    // `e.message` is the same string, not a fallback: Node builds it as
    // `Command failed: <cmd>\n<stderr>`. Three disjoint shapes — Node-aborted
    // (ENOENT/ENOBUFS), signal, exit (#176).
    // A quota refusal names itself first (#262); every other cause reports
    // exactly as it always has, on this same line and this same exit code.
    // `?? ""` stays — RegExp.test would coerce an absent stderr to the string
    // "undefined", which a future looser pattern could match. String() around
    // it does nothing: encoding: "utf8" above makes e.stderr a string whenever
    // a child ran, and test() ToString-coerces anything else regardless.
    if (RATE_LIMITED.test(e.stderr ?? "")) emitRateLimited(`${cmd} ${args[0]} ${args[1]}`);
    die(`${cmd} failed: ${e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)}`);
  }
}

// One truncation rule for every raw gh value this script quotes into a
// refusal: cut at n chars behind a visible marker, shared by the non-JSON
// die below and by `saw` further down. An unmarked cut reads as the whole
// value — the length quoted is gh's, not this script's — so a bare
// `raw.trim().slice(0, n)` here would be exactly the lie `saw`'s own
// comment (below) declares unacceptable one screen away.
const cut = (s, n = 120) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

// Every gh read in this file is JSON, and a bare JSON.parse of a child's stdout
// fails OPEN: gh can exit 0 with a non-JSON body (a proxy's HTML error page is
// the measured case) and the uncaught SyntaxError exits 1 — which in THIS
// script is the code for not-green, so a crash renders as a CI verdict.
//
// The parse succeeding is not the shape succeeding: an error object where an
// array of runs is expected, a run view missing its jobs, parse cleanly and
// flow on unchecked until the first dereference throws — same exit-1-as-
// verdict failure, one layer further in (#269). `shape`, given, is
// `(parsed) => string | null` — a reason the payload isn't what the caller
// is about to read, or null when it's fine — checked here so each call site
// declares what it expects instead of hand-rolling its own, the way the two
// siblings do: candidates.mjs's `!Array.isArray(rows)` and its per-row field
// check, ledger.mjs's "gh returned JSON that is not an issue list". Named
// rather than cited by line, since both files move. Parity with them is
// partial on purpose: those check the discriminating field of every row, the
// row-level checks here refuse on object-ness alone — see the next comment.
function runJson(cmd, args, shape) {
  const raw = run(cmd, args);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(`${cmd} ${args[0]} ${args[1]} returned no JSON — ${cut(raw.trim())}`);
  }
  const problem = shape?.(parsed);
  if (problem) die(`${cmd} ${args[0]} ${args[1]} returned JSON but not the expected shape — ${problem}`);
  return parsed;
}

// Shared by every shape check below. The fields actually read off a row
// (r.headSha, j.name, ...) are bare property reads, safe on any object even
// one missing that field — undefined flows into a comparison or a String(),
// never a throw. Only a `null` throws on that first read — an array, string,
// number or boolean reads back `undefined` like any other missing field
// (measured). Refusing all of them is still right: none is a row, and the
// silent ones are the same failure one notch quieter, a wrong-shape reply
// read as a field-less one. Object-ness is the refusal, not each field's
// type — checking e.g. that a job's `conclusion` were a string would wrongly
// refuse a legitimate in-progress job, whose conclusion is `null`.
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// What a shape refusal is FOR is telling a reader what gh actually sent, and
// "missing <field>" told them the opposite of it. The two `gh pr view` field
// guards below each cover three faults at once — the key absent, the value an
// empty string, the value not a string — and the `jobs` guard two of the same
// kind, and every one of them printed a single identical "missing" line
// (#926, measured), so a reader went hunting for a key gh had in fact
// returned as `""`, `42` or `null`. `saw` reports the value instead, and
// claims absence only when the key really is absent.
//
// `Object.hasOwn`, not `key in obj`: `in` answers for the prototype chain
// too, and throws outright on a non-object (measured: TypeError, "Cannot use
// 'in' operator"). Every call site refuses a non-object ahead of any field
// check, so `in` would work there today — but a field guard reordered past
// that refusal would turn this diagnostic into the very exit-1-as-verdict
// crash the shape checks exist to prevent (#269), where `hasOwn` just answers
// `false`.
//
// JSON.stringify, not the raw value: it is what makes `""` visible at all and
// what tells the string `"42"` from the number 42. It always returns a string
// here — the value came from JSON.parse, and no JSON value stringifies to
// `undefined`. Cut through the shared `cut()` above — the same visible-
// marker rule the non-JSON die uses, because the length quoted here is
// gh's, not this script's, same as there.
const saw = (obj, key) => {
  if (!Object.hasOwn(obj, key)) return "the key is absent";
  const shown = JSON.stringify(obj[key]);
  return `got ${cut(shown)}`;
};

// #840: `pr` was validated for truthiness alone, so `--pr abc` survived to
// every payload site — each built `pr: Number(pr)`, and `JSON.stringify(NaN)`
// is `null`. The normal path is the worse of them: an unidentifiable payload
// at exit 0 with `verdict: "green"`, which is the verdict the fleet gates on.
// `pr` is that payload's only identifying field, and the fleet polls this
// script for several PRs at once — so a null there is not a cosmetic gap, it is
// a report that cannot be attributed to the PR it answered for. Reaching gh at
// all is the other harm: `gh pr view` resolves a non-numeric ref as a BRANCH,
// so `--pr abc` could return a genuine verdict for whatever PR that branch
// belongs to.
//
// #878 moved the rule itself into arg.mjs's numArg(), because the identical
// shape was still live in diff-stats.mjs and pr-overlap.mjs and a fourth
// spelling of it here is what the fix had to stop. What stays this file's own
// is the usage line below — absent and malformed are different mistakes, and
// numArg() refuses only the second.
//
// `=== null`, not `!pr`: numArg() returns a NUMBER, so `--pr 0` — a value the
// caller did give — would otherwise be answered with a usage line claiming
// `--pr` is required. `gh` answers it truthfully instead, as no such PR.
// numArg() also no longer needs the placement #840's regex did: that one had
// to sit below this die because test() coerces `null` to the string "null",
// and numArg() never tests a value it did not read. It still lands above
// sweep(), per arg.mjs — where both would refuse, the more specific wording
// wins — and still before the first gh read.
const pr = numArg("pr");
if (pr === null) {
  die(
    "usage: ci-state.mjs --pr <number> [--base main] [--workflow CI] " +
      "[--workflow-file <path>] [--declare-no-ci] [--quiet]",
  );
}

const base = arg("base") || "main";
const workflow = arg("workflow") || "CI";
// --declare-no-ci is the caller's opt-out, never inferred: without it, a repo
// with no workflow file yields verdict=no-ci but still exits non-zero (#111),
// so absence never silently reads as pass. Fits the argv-flag surface every
// other option here already uses, rather than a repo-committed marker file
// that would sit uncommitted or drift stale.
const declareNoCi = has("declare-no-ci");

// #365: every flag above is read by looking for its own name, so a name
// nothing reads was never looked for — `--basee main` left `base` on its
// default and this file returned a real, wrong verdict at exit 0/1. That is
// the verdict the fleet gates PR-green on. Placed below the reads, per
// arg.mjs, so `--base --quiet` keeps #169's "--base needs a value"; still
// above the first gh call, which is the next statement.
//
// The set is every name this file reads. A name missing here refuses a
// working invocation, which is worse than the bug being fixed.
//
// `--workflow-file` is read here rather than where its value is first needed,
// which is the whole reason the read is a statement of its own: measured,
// with it below the guards `--pr 42 --workflow-file --base main` refused with
// `unexpected argument 'main'` — naming --base's innocent value instead of
// the flag actually given wrong. Immediately above the sweep, not higher, so
// it cannot take the `--declare-no-ci=` refusal off the boolean guard that
// words it better.
const workflowFileArg = arg("workflow-file");

// Split out because stray() must be told which names take a VALUE and the
// sweep must be told every name at all; the four here are the overlap, and
// `--declare-no-ci`/`--quiet` are boolean.
const VALUE_FLAGS = ["pr", "base", "workflow", "workflow-file"];
sweep([...VALUE_FLAGS, "declare-no-ci", "quiet"]);

// #463: sweep() above only ever refuses a `--`-prefixed token, so a bare or
// single-dash stray rode along in silence — `--pr 42 basee main` ignored
// `basee`/`main` and still compared against the default base, the same
// fail-open harm #365 closed for a misspelled FLAG name. This file takes no
// positional of its own, so any leftover token is one. `base`/`workflow`/
// `workflow-file` are named so `--spend-since`-style negative values are not
// this file's concern, but a value on any of THESE three is still skipped
// rather than read as a stray — nothing here takes one that looks like `-1`,
// this just keeps the set exact instead of assuming it.
stray(VALUE_FLAGS);

// --- PR facts -------------------------------------------------------------
const prInfo = runJson(
  "gh",
  ["pr", "view", String(pr), "--json", "headRefName,headRefOid,state,mergeStateStatus"],
  (v) => {
    if (!isObject(v)) return "expected an object";
    if (typeof v.headRefName !== "string" || !v.headRefName) return `headRefName (the branch) is not a non-empty string (${saw(v, "headRefName")})`;
    if (typeof v.headRefOid !== "string" || !v.headRefOid) return `headRefOid (the head sha) is not a non-empty string (${saw(v, "headRefOid")})`;
    return null;
  },
);
const branch = prInfo.headRefName;
const prHead = prInfo.headRefOid;
vlog(`    branch=${branch} head=${prHead} state=${prInfo.state} mergeState=${prInfo.mergeStateStatus}`);

// --- Workflow file: discovered, not assumed --------------------------------
// A hard-coded `.github/workflows/ci.yml` default made every fleet CI read
// exit 2 the moment a repo's workflow had a different filename — no caller
// anywhere passed --workflow-file to work around it (#111). Locate the file
// by the SAME workflow identity `--workflow` already selects runs by (default
// "CI"), read off disk rather than another `gh api` round trip (#262 budget).
// --workflow-file stays as the explicit override for the one case discovery
// cannot settle by itself: two workflow files sharing a name.
const WORKFLOWS_DIR = ".github/workflows";

// Anchored to the repo root, never to the cwd. Every other fact in this script
// comes from `gh`, which resolves the repo from any depth, so a cwd-relative
// read made the SAME repo answer `no-ci` from a subdirectory while answering
// not-green from its root — and board.mjs spawns this with whatever cwd the
// cockpit happens to have. `git rev-parse` is a local read, so anchoring costs
// no REST call (#262). A root we cannot locate is exit 2, never `no-ci`:
// absence has to be established, and failing to find the root establishes
// nothing at all. Called only when discovery actually runs — an explicit
// --workflow-file answers the question without a repo root and must not die
// for want of one.
function workflowsPath() {
  const root = tryRun("git", ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) {
    die(`git rev-parse --show-toplevel failed — cannot locate ${WORKFLOWS_DIR}/ to answer whether this repo has CI`);
  }
  return `${root}/${WORKFLOWS_DIR}`;
}

// Returns the workflow's path, or null ONLY where this repo genuinely has no
// CI: no workflows directory, or a directory holding no YAML at all. Every
// other outcome is die() (exit 2, "could not be answered") — the directory
// unreadable, the target unreadable, or YAML present under other names. #111's
// whole point is that absence must be DECLARED, never inferred from an error:
// a repo whose CI is merely misconfigured must never read as one with no CI.
function discoverWorkflowFile(dir, workflowName) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    // ENOENT is the one and only condition that means "no CI configured".
    // EACCES, ENOTDIR, ELOOP and friends all mean the directory is there and
    // we could not read it — unanswerable, exactly like the unreadable
    // workflow file below. The bare `catch` this replaced relabelled every one
    // of them `no-ci`, so a `chmod 000` on .github/workflows/ reported no-CI
    // for a repo whose CI run was `failure` — and exit 0 under --declare-no-ci.
    if (e.code === "ENOENT") return null;
    die(`cannot read ${dir}: ${e.message}`);
  }
  const candidates = [];
  const yamls = [];
  const unreadable = [];
  for (const f of entries) {
    if (!/\.ya?ml$/.test(f)) continue;
    const path = `${dir}/${f}`;
    yamls.push(f);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      // NOT fatal on the spot: this entry may be an unrelated sibling, and
      // dying on it blinds discovery to a target sitting readable right next
      // to it (one chmod-000 workflow made a green repo exit 2). Fail closed
      // only if nothing matched — then this file is the one that might have
      // been the CI workflow. The ambiguity check below sees readable files
      // only, so an unreadable second `CI` is invisible; a matched target wins.
      unreadable.push(`${path}: ${e.message}`);
      continue;
    }
    // Top-level `name:` only (column 0) — a job's own `name:` step is indented
    // and expectedJobs() below already treats that as a different concern. The
    // optional ` #…` tail is a YAML comment, not part of the name: without it
    // `name: CI  # main pipeline` parsed as a workflow called `CI  # main
    // pipeline`, so a correctly configured repo reported no-ci. ` #` with the
    // space is what makes it a comment in YAML, so `name: CI#1` stays `CI#1`.
    const m = text.match(/^name:\s*(.+?)(?:\s+#.*)?\s*$/m);
    const name = m ? m[1].replace(/^['"]|['"]$/g, "") : null;
    if (name === workflowName) candidates.push(path);
  }
  if (candidates.length > 1) {
    die(
      `${candidates.length} workflow files under ${dir}/ are named '${workflowName}' (${candidates.join(", ")}) — pass --workflow-file to pick one`,
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (unreadable.length) {
    // Nothing matched, so an unreadable file could have been the match.
    die(`cannot read ${unreadable.join("; ")}`);
  }
  if (yamls.length) {
    // Workflows ARE configured here, just none under this name: a --workflow /
    // --workflow-file mismatch, not an absence. Saying "no CI configured" of a
    // directory full of workflows is a false statement, and letting
    // --declare-no-ci wave it through would hand the caller exit 0 for a repo
    // whose CI it never looked at.
    die(
      `${yamls.length} workflow file(s) under ${dir}/ (${yamls.join(", ")}), none named '${workflowName}' — pass --workflow <name> or --workflow-file <path>`,
    );
  }
  return null; // directory present, no workflow files in it — genuinely no CI
}

const workflowFile = workflowFileArg || discoverWorkflowFile(workflowsPath(), workflow);
// No workflows at all, so this repo has no CI configured for ci-state to read.
// That is its own verdict (`no-ci`), never the exit code reserved for "the
// question could not be answered" — every way of failing to READ a workflow
// (unreadable directory, unreadable file, malformed file) dies with exit 2
// instead, above or via expectedJobs() below.
const noCi = workflowFile === null;
if (noCi) {
  vlog(`    no workflow files under ${WORKFLOWS_DIR}/ — no-ci verdict`);
}

// --- Expected jobs, derived from the workflow file ------------------------
// Never hardcoded: expectedJobs() parses the `jobs:` block of the workflow file
// this run resolved (discoverWorkflowFile, or --workflow-file), so the expected
// set tracks that file and follows it across repos. A reader asking whether an
// empty `missing` is real should read that workflow for the current set. It is
// deliberately not restated here: a set written into this comment is wrong the
// moment a job is added.
//
// Not built from the fleet's own prose instead: `integration-docker` — a job in
// the agent-brain repo's CI workflow, which is on an internal GHE host and so
// cannot be settled from this repo — is named nowhere under the plugin's own
// component dirs but here (`git grep -l integration-docker -- commands scripts
// skills` matches only this file), so a
// list built from those documents would have accepted a run missing it.
function expectedJobs(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  const ids = [];
  let inJobs = false;
  let sawNameOverride = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^[A-Za-z]/.test(line)) break; // next top-level key ends the section
    if (!inJobs) continue;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) ids.push(m[1]);
    if (/^ {4}name:/.test(line)) sawNameOverride = true;
  }
  // Fail closed on the assumption this derivation rests on. If a job sets a
  // display name, ids no longer equal the names `gh run view` reports, and every
  // comparison below would silently compare the wrong strings.
  if (sawNameOverride) {
    die(`${file} sets a job-level 'name:' — job ids no longer match reported job names, derivation invalid`);
  }
  if (ids.length === 0) die(`derived zero jobs from ${file} — refusing to answer`);
  return ids;
}

// --- Find the run bound to this head --------------------------------------
// `--limit 1` is wrong: the newest run on a branch is frequently a label or
// policy workflow, which hides the CI result entirely. Filter by workflow, then
// match the head, then take the newest survivor.
//
// Skipped entirely under no-ci: there is no workflow to bind a run to, and
// asking anyway would spend the REST budget #262 is already tight on for a
// question this repo cannot answer either way.
const reasons = [];
let jobs = [];
let missing = [];
let runId = null;
let attempt = null;
let runHeadSha = null;
let status = null;
let conclusion = null;

if (noCi) {
  reasons.push(
    declareNoCi
      ? `no workflows configured under ${WORKFLOWS_DIR}/ — --declare-no-ci passed, gating on the caller's verified suite run instead`
      : `no workflows configured under ${WORKFLOWS_DIR}/ — pass --declare-no-ci once this repo is verified to gate on the reviewer's own suite run instead; absence never means pass`,
  );
} else {
  // Derived here rather than above the no-ci fork: `expected` is read on this
  // arm alone, and the payload carries `missing`, not `expected`. Kept as this
  // arm's first statement — expectedJobs() refuses on an underivable workflow,
  // and that refusal belongs before the run query rather than after it.
  const expected = expectedJobs(workflowFile);
  vlog(`    expected jobs (${expected.length}): ${expected.join(", ")}`);
  const runs = runJson(
    "gh",
    ["run", "list", "--branch", branch, "--workflow", workflow, "--limit", "30", "--json", "databaseId,headSha,status,conclusion,event,createdAt"],
    (v) => {
      if (!Array.isArray(v)) return "expected an array of runs";
      const bad = v.findIndex((r) => !isObject(r));
      return bad === -1 ? null : `run list row ${bad} is not an object`;
    },
  );
  const matching = runs
    .filter((r) => r.headSha === prHead)
    .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

  if (matching.length === 0) {
    reasons.push(`no ${workflow} run whose headSha equals the PR head ${prHead}`);
  } else {
    const chosen = matching[0];
    runId = chosen.databaseId;
    // Re-query the run itself. The list's conclusion is a second read from a
    // different moment; the authoritative job list is this one.
    const view = runJson(
      "gh",
      ["run", "view", String(runId), "--json", "jobs,attempt,status,conclusion,headSha"],
      (v) => {
        if (!isObject(v)) return "expected an object";
        if (!Array.isArray(v.jobs)) return `jobs is not an array (${saw(v, "jobs")})`;
        const bad = v.jobs.findIndex((j) => !isObject(j));
        return bad === -1 ? null : `job entry ${bad} is not an object`;
      },
    );
    attempt = view.attempt;
    runHeadSha = view.headSha;
    status = view.status;
    conclusion = view.conclusion;
    jobs = view.jobs.map((j) => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? null,
    }));
    for (const j of jobs) vlog(`    ${j.name}: ${j.status}/${j.conclusion ?? "-"}`);
    vlog(`    attempt=${attempt} runHeadSha=${runHeadSha} status=${status} conclusion=${conclusion}`);

    if (runHeadSha !== prHead) reasons.push(`run headSha ${runHeadSha} != PR head ${prHead}`);
    if (status !== "completed") reasons.push(`run status is ${status}, not completed`);

    const present = new Set(jobs.map((j) => j.name));
    missing = expected.filter((e) => !present.has(e));
    // An absent job reads as pending and is invisible in a checks summary. This is
    // the case a force-push creates: the run is cancelled, finished jobs keep their
    // conclusions, and the missing ones simply never appear.
    if (missing.length) reasons.push(`expected jobs absent from the run: ${missing.join(", ")}`);

    // `skipped` is NOT `passed`. When the currency check fails, the heavy suites
    // report skipped — they did not execute.
    for (const j of jobs) {
      if (j.conclusion !== "success") reasons.push(`job ${j.name} is ${j.conclusion ?? j.status}, not success`);
    }
  }
}

// --- Behind-count ---------------------------------------------------------
// `gh api` does NOT infer the host from the local remote the way `gh pr` and
// `gh run` do — on a GitHub Enterprise repo it silently 404s against github.com.
//
// This block MUST NOT use run(): run()'s failure path calls die(), which calls
// process.exit(2) and terminates before any surrounding catch can see it. An
// earlier version wrapped run() in a try/catch here, which made the catch
// unreachable — a transient failure on this purely informational side channel
// hard-exited the tool and discarded a fully computed CI verdict. Use a helper
// that returns null instead, so the behind-count can be unknown without costing
// the caller the answer it actually asked for.
function tryRun(cmd, args) {
  vlog(`$ ${cmd} ${args.join(" ")}`);
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (e) {
    // Same discipline as run(), and it matters more here: --quiet suppresses
    // vlog entirely, so under the controller's Monitor this line is discarded
    // and the interpolated stderr would have been paid for and then thrown
    // away. Name the cause; the child's own bytes already reached the caller.
    vlog(
      `    ${NAME}: ${cmd} failed: ${
        e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)
      }`,
    );
    return null;
  }
}

let behind = null;
try {
  const remote = tryRun("git", ["remote", "get-url", "origin"]);
  const repoJson = remote === null ? null : tryRun("gh", ["repo", "view", "--json", "nameWithOwner"]);
  if (remote !== null && repoJson !== null) {
    const host = remote.trim().replace(/^(git@|https:\/\/|ssh:\/\/git@)/, "").replace(/[:/].*$/, "");
    const repo = JSON.parse(repoJson).nameWithOwner;
    const cmpJson = tryRun("gh", ["api", "--hostname", host, `repos/${repo}/compare/${base}...${prHead}`]);
    if (cmpJson !== null) {
      const cmp = JSON.parse(cmpJson);
      // Shaped like every other gh read here (#269), but fail-SOFT: a compare
      // reply without a numeric `behind_by` — a 404 body from the wrong host
      // or base is the live case — leaves `behind` null, this block's
      // documented unknown, instead of `undefined`, which JSON.stringify drops
      // from the payload entirely, taking the contract below and its
      // unknown-vlog with it. Still never dies: the probe stays advisory.
      behind = typeof cmp?.behind_by === "number" ? cmp.behind_by : null;
      vlog(`    behind_by=${behind} (status=${cmp?.status})`);
    }
  }
} catch (e) {
  // JSON.parse of a malformed payload lands here; the subprocess failures are
  // already handled by tryRun returning null.
  vlog(`    ${NAME}: behind-count unusable: ${e.message}`);
}

// `behind` stays null when unknown, and null NEVER enters `reasons`. The
// behind-count is context for the caller, not part of the green verdict:
// reviewers label without requiring currency, and only the merge bot
// establishes it. An earlier version pushed "behind-count unavailable" into
// reasons, which silently turned a fully green board into not-green over a
// number the verdict is not supposed to depend on.
//
// null is deliberately not 0 — 0 would read as "current", which is the one
// wrong answer that matters here.
if (behind === null) {
  vlog(`    ${NAME}: behind-count unknown (reported as null; verdict unaffected)`);
}

// no-ci is its own verdict, distinguishable from both green and not-green —
// board.mjs's mapCi() and any other caller that reads `verdict` by string
// value sees "no-ci" rather than either, so it cannot be silently folded into
// a pass or a red. reasons.length is never 0 here: the no-ci branch above
// always pushes exactly one, whichever way --declare-no-ci went.
const verdict = noCi ? "no-ci" : reasons.length === 0 ? "green" : "not-green";
emit(2, `\n${NAME}: verdict=${verdict}${reasons.length ? ` — ${reasons.join("; ")}` : ""}\n`);

// Compact, single-line: the consumer is an agent/script parsing JSON, and the
// pretty view already went to stderr. On the quiet hot path drop `jobs` and
// `missing` too — `reasons` already states every failing/absent job, so they
// are pure duplication in the two longest-lived contexts that poll this.
//
// no-ci drops them unconditionally, quiet or not — never folded into the
// `!quiet` check above, which is about duplication, not about what was read.
// `jobs`/`missing` stay at their `let jobs = []`/`let missing = []`
// initialisers on this path (the no-ci branch never reaches the run-binding
// arm that assigns them), so shipping them read as "checked, nothing
// missing" to a caller gating on `missing.length` when no workflow was ever
// read to check against. `emitRateLimited()` above already answers the same
// "nothing was read" question by omitting `jobs`/`missing` rather than
// emitting them empty; this is the no-ci arm agreeing with it, one
// convention for both places in this file that never bind a run.
const payload = { pr, branch, prHead, runId, attempt, runHeadSha, status, conclusion, behind, verdict, reasons };
if (!quiet && !noCi) Object.assign(payload, { jobs, missing });
emit(1, `${JSON.stringify(payload)}\n`);

// Exit vocabulary unchanged: 0 only when the gate is satisfied, 1 when it is
// not, 2 (via die(), above) only when the question could not be answered at
// all. no-ci without --declare-no-ci is a satisfiable question with an
// unsatisfied gate — exit 1, same bucket as not-green, so absence never reads
// as pass to a caller that checks only the exit code. no-ci WITH the
// declaration is the caller saying the gate is satisfied elsewhere (their own
// verified suite run) — exit 0.
const gateSatisfied = verdict === "green" || (verdict === "no-ci" && declareNoCi);
process.exit(gateSatisfied ? 0 : 1);
