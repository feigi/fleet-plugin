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

const NAME = "ci-state";

// writeSync, not console.error: stderr on a pipe is async and the exit below
// discards what is still queued, so a large forwarded child stderr swallows
// this line — the refusal is queued last and dropped first (#176). It also
// survives --quiet, which is the mode the controller's CI Monitor polls in.
// The leading newline is load-bearing: writeSync goes straight to the fd while
// the forwarded child stderr is still draining through the stream, so without
// it this text lands mid-line and stops matching line-anchored readers.
function die(msg) {
  writeSync(2, `\n${NAME}: ${msg}\n`);
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

// --quiet suppresses the diagnostic stream (command echoes, per-job/per-field
// lines) and drops the raw job list from the payload. The controller's CI
// Monitor (and, standalone, the reviewer's own watch loop) polls this hot, and
// none of that stream is acted on — `reasons` already names every failing job,
// and the exit code already encodes green/not-green. die() and the one-line
// verdict summary still print, so a caller loses nothing it decides on.
const has = (name) => process.argv.includes(`--${name}`);
const quiet = has("quiet");
const vlog = (...a) => {
  if (!quiet) console.error(...a);
};

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
    die(`${cmd} failed: ${e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)}`);
  }
}

// Every gh read in this file is JSON, and a bare JSON.parse of a child's stdout
// fails OPEN: gh can exit 0 with a non-JSON body (a proxy's HTML error page is
// the measured case) and the uncaught SyntaxError exits 1 — which in THIS
// script is the code for not-green, so a crash renders as a CI verdict.
function runJson(cmd, args) {
  const raw = run(cmd, args);
  try {
    return JSON.parse(raw);
  } catch {
    die(`${cmd} ${args[0]} ${args[1]} returned no JSON — ${raw.trim().slice(0, 120)}`);
  }
}

const pr = arg("pr");
if (!pr) {
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

// --- PR facts -------------------------------------------------------------
const prInfo = runJson("gh", [
  "pr", "view", String(pr),
  "--json", "headRefName,headRefOid,state,mergeStateStatus",
]);
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

const workflowFile = arg("workflow-file") || discoverWorkflowFile(workflowsPath(), workflow);
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
// Never hardcoded. The fleet's prose names four jobs; the workflow defines five.
// A list built from the documents would silently accept a run missing
// `integration-docker`.
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

const expected = noCi ? [] : expectedJobs(workflowFile);
if (!noCi) vlog(`    expected jobs (${expected.length}): ${expected.join(", ")}`);

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
  const runs = runJson("gh", [
    "run", "list",
    "--branch", branch,
    "--workflow", workflow,
    "--limit", "30",
    "--json", "databaseId,headSha,status,conclusion,event,createdAt",
  ]);
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
    const view = runJson("gh", [
      "run", "view", String(runId),
      "--json", "jobs,attempt,status,conclusion,headSha",
    ]);
    attempt = view.attempt;
    runHeadSha = view.headSha;
    status = view.status;
    conclusion = view.conclusion;
    jobs = (view.jobs || []).map((j) => ({
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
      behind = cmp.behind_by;
      vlog(`    behind_by=${behind} (status=${cmp.status})`);
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
console.error(`\n${NAME}: verdict=${verdict}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`);

// Compact, single-line: the consumer is an agent/script parsing JSON, and the
// pretty view already went to stderr. On the quiet hot path drop `jobs` and
// `missing` too — `reasons` already states every failing/absent job, so they
// are pure duplication in the two longest-lived contexts that poll this.
const payload = { pr: Number(pr), branch, prHead, runId, attempt, runHeadSha, status, conclusion, behind, verdict, reasons };
if (!quiet) Object.assign(payload, { jobs, missing });
console.log(JSON.stringify(payload));

// Exit vocabulary unchanged: 0 only when the gate is satisfied, 1 when it is
// not, 2 (via die(), above) only when the question could not be answered at
// all. no-ci without --declare-no-ci is a satisfiable question with an
// unsatisfied gate — exit 1, same bucket as not-green, so absence never reads
// as pass to a caller that checks only the exit code. no-ci WITH the
// declaration is the caller saying the gate is satisfied elsewhere (their own
// verified suite run) — exit 0.
const gateSatisfied = verdict === "green" || (verdict === "no-ci" && declareNoCi);
process.exit(gateSatisfied ? 0 : 1);
