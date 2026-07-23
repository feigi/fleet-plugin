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

function run(cmd, args) {
  console.error(`$ ${cmd} ${args.join(" ")}`);
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (e) {
    die(`${cmd} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

const pr = arg("pr");
if (!pr) die("usage: ci-state.mjs --pr <number> [--base main] [--workflow CI] [--workflow-file <path>]");
const base = arg("base") || "main";
const workflow = arg("workflow") || "CI";
const workflowFile = arg("workflow-file") || ".github/workflows/ci.yml";

// --- PR facts -------------------------------------------------------------
const prInfo = JSON.parse(
  run("gh", ["pr", "view", String(pr), "--json", "headRefName,headRefOid,state,mergeStateStatus"]),
);
const branch = prInfo.headRefName;
const prHead = prInfo.headRefOid;
console.error(`    branch=${branch} head=${prHead} state=${prInfo.state} mergeState=${prInfo.mergeStateStatus}`);

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
console.error(`    expected jobs (${expected.length}): ${expected.join(", ")}`);

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
  for (const j of jobs) console.error(`    ${j.name}: ${j.status}/${j.conclusion ?? "-"}`);
  console.error(`    attempt=${attempt} runHeadSha=${runHeadSha} status=${status} conclusion=${conclusion}`);

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
let behind = null;
try {
  const remote = run("git", ["remote", "get-url", "origin"]).trim();
  const host = remote.replace(/^(git@|https:\/\/|ssh:\/\/git@)/, "").replace(/[:/].*$/, "");
  const repo = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const cmp = JSON.parse(run("gh", ["api", "--hostname", host, `repos/${repo}/compare/${base}...${prHead}`]));
  behind = cmp.behind_by;
  console.error(`    behind_by=${behind} (status=${cmp.status})`);
} catch {
  // Deliberately non-fatal: the behind-count is context for the caller, not part
  // of the green verdict. Reviewers label without requiring currency; only the
  // merge bot establishes it. Record that it is unknown rather than guessing 0,
  // because 0 would read as "current".
  reasons.push("behind-count unavailable");
}

const verdict = reasons.length === 0 ? "green" : "not-green";
console.error(`\n${NAME}: verdict=${verdict}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`);

console.log(
  JSON.stringify(
    { pr: Number(pr), branch, prHead, runId, attempt, runHeadSha, status, conclusion, jobs, missing, behind, verdict, reasons },
    null,
    2,
  ),
);

process.exit(verdict === "green" ? 0 : 1);
