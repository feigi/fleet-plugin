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
import { readFileSync } from "node:fs";

const NAME = "ci-state";

function die(msg) {
  console.error(`${NAME}: ${msg}`);
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
    die(`${cmd} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

const pr = arg("pr");
if (!pr) die("usage: ci-state.mjs --pr <number> [--base main] [--workflow CI] [--workflow-file <path>] [--quiet]");
const base = arg("base") || "main";
const workflow = arg("workflow") || "CI";
const workflowFile = arg("workflow-file") || ".github/workflows/ci.yml";

// --- PR facts -------------------------------------------------------------
const prInfo = JSON.parse(
  run("gh", ["pr", "view", String(pr), "--json", "headRefName,headRefOid,state,mergeStateStatus"]),
);
const branch = prInfo.headRefName;
const prHead = prInfo.headRefOid;
vlog(`    branch=${branch} head=${prHead} state=${prInfo.state} mergeState=${prInfo.mergeStateStatus}`);

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

const expected = expectedJobs(workflowFile);
vlog(`    expected jobs (${expected.length}): ${expected.join(", ")}`);

// --- Find the run bound to this head --------------------------------------
// `--limit 1` is wrong: the newest run on a branch is frequently a label or
// policy workflow, which hides the CI result entirely. Filter by workflow, then
// match the head, then take the newest survivor.
const runs = JSON.parse(
  run("gh", [
    "run", "list",
    "--branch", branch,
    "--workflow", workflow,
    "--limit", "30",
    "--json", "databaseId,headSha,status,conclusion,event,createdAt",
  ]),
);
const matching = runs
  .filter((r) => r.headSha === prHead)
  .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

const reasons = [];
let jobs = [];
let missing = [];
let runId = null;
let attempt = null;
let runHeadSha = null;
let status = null;
let conclusion = null;

if (matching.length === 0) {
  reasons.push(`no ${workflow} run whose headSha equals the PR head ${prHead}`);
} else {
  const chosen = matching[0];
  runId = chosen.databaseId;
  // Re-query the run itself. The list's conclusion is a second read from a
  // different moment; the authoritative job list is this one.
  const view = JSON.parse(
    run("gh", ["run", "view", String(runId), "--json", "jobs,attempt,status,conclusion,headSha"]),
  );
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
    vlog(`    ${NAME}: ${cmd} failed: ${String(e.stderr || e.message).trim()}`);
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

const verdict = reasons.length === 0 ? "green" : "not-green";
console.error(`\n${NAME}: verdict=${verdict}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`);

// Compact, single-line: the consumer is an agent/script parsing JSON, and the
// pretty view already went to stderr. On the quiet hot path drop `jobs` and
// `missing` too — `reasons` already states every failing/absent job, so they
// are pure duplication in the two longest-lived contexts that poll this.
const payload = { pr: Number(pr), branch, prHead, runId, attempt, runHeadSha, status, conclusion, behind, verdict, reasons };
if (!quiet) Object.assign(payload, { jobs, missing });
console.log(JSON.stringify(payload));

process.exit(verdict === "green" ? 0 : 1);
