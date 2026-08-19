// #159. Gate for the rerun fallback in `.github/workflows/rebase-check-refresh.yml`
// and the script it now routes through, `.github/scripts/rerun-rebase-check.sh`.
//
// The defect: the job-resolution loop took the FIRST candidate run holding a
// `rebase-check` job and broke, then POSTed the rerun once, outside the loop. A
// POST rejected because the parent run is still in progress therefore never
// reached the older, already-completed candidates — the ones `per_page=5` was
// chosen to have in hand.
//
// Two halves, because a loop that only ever sees an accepting first candidate
// pins neither:
//   - FALL BACK: a rejected candidate is followed by a POST to the next one.
//   - DO NOT: an accepted rerun stops, a token failure stops, and a PR with no
//     rebase-check job anywhere POSTs nothing at all.
//
// And the clause that is the whole difficulty: `rejected` counts PRs, not
// candidates. Trying three candidates for one PR must still summarise as
// `rejected: 1`. That number is asserted directly here rather than pinned as
// source text — the two former increment sites are gone, but an assertion that
// they are gone would survive a third being added anywhere else.
//
// Nothing in this repo executes a workflow, so the step's `run:` block is
// lifted out of the YAML and run under `bash` with a stub `gh` on PATH. cwd is
// the repo root, so the `.github/scripts/rerun-rebase-check.sh` the step names
// is the real script, not a second copy: what runs here is the shipped loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW = join(ROOT, ".github/workflows/rebase-check-refresh.yml");

// Canned `gh`. Every invocation is logged, so a test can count POSTs — the
// measurement the ticket turns on, and the one no exit status reports.
// Fixtures are files under $GH_FIX; a missing one is an API failure, which is
// how the "could not list jobs" path is reached.
const GH_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_LOG"',
  '[ "$1" = "pr" ] && { cat "$GH_FIX/prs.json"; exit 0; }',
  'if [ "$2" = "--method" ]; then url=$4; else url=$2; fi',
  'case "$url" in',
  "  */compare/*)",
  '    sha=${url##*...}',
  '    f="$GH_FIX/compare-$sha" ;;',
  "  */workflows/ci.yml/runs*)",
  '    sha=${url##*head_sha=}; sha=${sha%%&*}',
  '    f="$GH_FIX/runs-$sha.json" ;;',
  "  */actions/runs/*/jobs*)",
  '    id=${url##*/actions/runs/}; id=${id%%/jobs*}',
  '    f="$GH_FIX/jobs-$id.json" ;;',
  "  */actions/jobs/*/rerun)",
  '    id=${url##*/actions/jobs/}; id=${id%/rerun}',
  '    f="$GH_FIX/rerun-$id"',
  '    [ -f "$f" ] || { echo "gh stub: no rerun fixture for job [$id]" >&2; exit 90; }',
  '    st=$(head -n1 "$f"); tail -n +2 "$f"; exit "$st" ;;',
  "  *)",
  '    echo "gh stub: unexpected url [$url]" >&2; exit 91 ;;',
  "esac",
  '[ -f "$f" ] || { echo "gh: HTTP 500 (no fixture $f)" >&2; exit 1; }',
  'cat "$f"',
].join("\n");

/**
 * The step's shell script, lifted out of the YAML.
 *
 * Deliberately not a YAML parse: the point is to run the exact text the runner
 * runs. The block is located by its `run: |` line and dedented by that line's
 * indent + 2, which is the only indentation a literal block scalar can have.
 */
function stepScript() {
  const src = readFileSync(WORKFLOW, "utf8").split("\n");
  const heads = src.map((l, i) => [l, i]).filter(([l]) => /^\s*run: \|\s*$/.test(l));
  // A second step would make "the block" ambiguous and silently lift the wrong
  // one; zero would lift the empty string and pass every assertion vacuously.
  assert.equal(heads.length, 1, "expected exactly one `run: |` block in the refresh workflow");
  const [head, i] = heads[0];
  const indent = head.match(/^\s*/)[0].length + 2;
  const body = [];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j].trim() === "") {
      body.push("");
      continue;
    }
    if (src[j].match(/^\s*/)[0].length < indent) break;
    body.push(src[j].slice(indent));
  }
  const script = body.join("\n");
  // Positive control on the lift itself. An indentation change upstream would
  // otherwise hand every test an empty script that exits 0 and asserts nothing.
  assert.ok(script.includes("set -euo pipefail"), "lifted an empty or wrong block from the workflow");
  assert.ok(
    script.includes(".github/scripts/rerun-rebase-check.sh"),
    "the step no longer routes through rerun-rebase-check.sh — the loop under test is not the one that ships",
  );
  return script;
}

/** Run the lifted step against `fixtures`. `cwd` defaults to the repo root. */
function runStep(t, fixtures, { cwd = ROOT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rerun-rebase-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fix = join(dir, "fix");
  const bin = join(dir, "bin");
  mkdirSync(fix);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(fix, name), body);

  const log = join(dir, "gh.log");
  const summaryFile = join(dir, "summary.md");
  writeFileSync(log, "");
  writeFileSync(summaryFile, "");

  const r = spawnSync("bash", ["-c", stepScript()], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GH_TOKEN: "stub",
      GH_REPO: "o/r",
      GITHUB_REF_NAME: "main",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_STEP_SUMMARY: summaryFile,
      GH_FIX: fix,
      GH_LOG: log,
    },
  });

  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    summary: readFileSync(summaryFile, "utf8"),
    calls,
    posts: calls.filter((c) => c.includes("--method POST")),
  };
}

// ---- fixture vocabulary -------------------------------------------------
// One PR (#7) at head `deadbeef`, three usable candidate runs newest-first,
// each holding a rebase-check job. `null` is the in-progress conclusion and
// must survive the caller's cancelled/skipped filter.
const RUNS_3 = JSON.stringify({
  workflow_runs: [{ id: 101, conclusion: null }, { id: 102, conclusion: "failure" }, { id: 103, conclusion: "success" }],
});
// gh answers `--json number,baseRefName,headRefOid` with an array of objects,
// and the step projects it into rows itself — so the stub has to return that
// shape or the projection under test never runs.
const prs = (...rows) => JSON.stringify(rows.map(([number, baseRefName, headRefOid]) => ({ number, baseRefName, headRefOid })));
const jobs = (id) => JSON.stringify({ jobs: [{ name: "check", id: id + 700 }, { name: "rebase-check", id }] });
const accept = "0\n";
const reject = (msg) => `1\n${msg}\n`;
// The real shape: GitHub answers a rerun against a still-running parent with a
// 403 whose body says so. It must read as the routine per-PR skip, which is
// why the in-progress test is ordered before the 401/403 test in the script.
const IN_PROGRESS_403 = "gh: HTTP 403: Cannot re-run jobs of a run that is in progress (https://api.github.com/...)";
const TOKEN_403 = "gh: HTTP 403: Resource not accessible by integration (https://api.github.com/...)";

const BEHIND_3_CANDIDATES = {
  "prs.json": prs([7, "main", "deadbeef"]),
  "compare-deadbeef": "4\n",
  "runs-deadbeef.json": RUNS_3,
  "jobs-101.json": jobs(201),
  "jobs-102.json": jobs(202),
  "jobs-103.json": jobs(203),
};

// ---- the deployment -----------------------------------------------------

test("the refresh job checks out the repo before the step that runs a file from it", () => {
  // Not a behaviour test but a deployment one, and the only kind that can
  // catch this: `runStep` always runs the lifted block from a checked-out
  // tree, so the whole suite stays green while the runner gets 127 on the
  // FIRST behind PR and refreshes nothing at all. Lifting inline YAML into a
  // repo file is a pattern here now, so the next extraction must not be able
  // to repeat it.
  const src = readFileSync(WORKFLOW, "utf8").split("\n");
  const run = src.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  const checkout = src.findIndex((l) => /^\s*-\s+uses:\s*actions\/checkout(@|\s*$)/.test(l));
  // Positive control on the anchor: without it a workflow holding no `run:`
  // block at all would satisfy the ordering assertion vacuously.
  assert.notEqual(run, -1, "no `run: |` block in the refresh workflow — the anchor this pins against is gone");
  assert.notEqual(checkout, -1, "the refresh job must check out the repo — the step it runs is a file in it");
  assert.ok(checkout < run, "the checkout must come before the step that invokes the checked-out script");
});

// ---- the fallback -------------------------------------------------------

test("a rejected candidate falls back to the next one, and the accepted rerun is the one counted", (t) => {
  const r = runStep(t, {
    ...BEHIND_3_CANDIDATES,
    "rerun-201": reject(IN_PROGRESS_403),
    "rerun-202": accept,
    "rerun-203": accept,
  });

  assert.equal(r.status, 0, r.out);
  // The whole ticket: the old shape POSTed once and gave up.
  assert.deepEqual(
    r.posts.map((c) => c.replace(/.*actions\/jobs\//, "").replace(/\/rerun.*/, "")),
    ["201", "202"],
    "a rejected first candidate must be followed by a POST to the next one, and an accepted one must stop the walk",
  );
  assert.match(r.out, /job 202/, "the accepted rerun must name the job it actually re-ran");
  assert.match(r.summary, /1 re-run/);
  assert.match(r.summary, /rejected: 0/, "a PR that was re-run on a later candidate is not a rejection");
});

test("a 403 that says the parent run is in progress is a skip, not a token failure", (t) => {
  // Ordering pin. Both branches match this message; the in-progress test runs
  // first, so it falls through to the next candidate. Read as a token failure
  // it would exit 1 with a wrong diagnosis and abandon every remaining PR.
  const r = runStep(t, {
    ...BEHIND_3_CANDIDATES,
    "rerun-201": reject(IN_PROGRESS_403),
    "rerun-202": reject(IN_PROGRESS_403),
    "rerun-203": accept,
  });

  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 3, "an in-progress 403 must not be fatal — the walk continues");
  assert.doesNotMatch(r.out, /GITHUB_TOKEN lacks/, "an in-progress rejection is not a permissions diagnosis");
  assert.match(r.summary, /1 re-run/);
});

test("a candidate whose jobs listing fails falls through to the next one", (t) => {
  // The other fallback in the walk, and the same category as the ticket's:
  // an unusable candidate must not end it. Omitting a jobs fixture is how the
  // stub returns an HTTP 500, which is the only way to reach the script's
  // `failed to list jobs` -> `continue`.
  const fixtures = { ...BEHIND_3_CANDIDATES, "rerun-202": accept };
  delete fixtures["jobs-101.json"];
  const r = runStep(t, fixtures);

  assert.equal(r.status, 0, r.out);
  assert.deepEqual(
    r.posts.map((c) => c.replace(/.*actions\/jobs\//, "").replace(/\/rerun.*/, "")),
    ["202"],
    "a run whose jobs could not be listed must be followed by a POST to the next candidate",
  );
  assert.match(r.out, /failed to list jobs for run 101/, "the listing failure gets its own line, it is not swallowed");
  assert.match(r.summary, /1 re-run/);
  assert.match(r.summary, /no-job: 0/, "one unlistable candidate is not `no rebase-check job in any candidate run`");
});

// ---- the counter --------------------------------------------------------

test("three rejected candidates are ONE rejected PR, not three", (t) => {
  const r = runStep(t, {
    ...BEHIND_3_CANDIDATES,
    "rerun-201": reject(IN_PROGRESS_403),
    "rerun-202": reject("gh: HTTP 403: Cannot re-run jobs of a run that is queued"),
    "rerun-203": reject("gh: HTTP 404: Not Found — run has aged out of the retention window"),
  });

  assert.equal(r.posts.length, 3, "every candidate must be tried before the PR is given up on");
  // The clause the ticket calls the whole difficulty.
  assert.match(r.summary, /rejected: 1\b/, "`rejected` counts PRs, not candidates");
  assert.doesNotMatch(r.summary, /rejected: [23]\b/);
  // Nothing was re-run and something needed to be: the all-or-nothing guard.
  // It exits before the skipped-PR warning at the foot of the step, so that
  // warning's copy of the counter is asserted in the two-PR test below, where
  // one accepted rerun keeps the guard silent and the step runs to the end.
  assert.equal(r.status, 1, r.out);
});

test("a supersession that leaves every candidate's parent run in progress fails the step", (t) => {
  // The claim the `concurrency:` note makes. A cancelled refresh's already-POSTed
  // reruns stay in flight, so the replacement run meets every candidate's parent
  // run in progress and every POST is refused. That is not a skip: the PR lands
  // in `rejected`, nothing was re-run, and the all-or-nothing guard exits 1.
  const r = runStep(t, {
    ...BEHIND_3_CANDIDATES,
    "rerun-201": reject(IN_PROGRESS_403),
    "rerun-202": reject(IN_PROGRESS_403),
    "rerun-203": reject(IN_PROGRESS_403),
  });

  assert.equal(r.status, 1, r.out);
  assert.match(r.summary, /1 behind their base → 0 re-run/);
  assert.match(r.summary, /rejected: 1\b/);
  assert.match(r.out, /::error::1 PR\(s\) are behind their base but none were re-run/);
});

test("rejected is per PR across PRs: one re-run and one exhausted is `rejected: 1`", (t) => {
  const r = runStep(t, {
    "prs.json": prs([7, "main", "deadbeef"], [8, "main", "cafe"]),
    "compare-deadbeef": "4\n",
    "compare-cafe": "2\n",
    "runs-deadbeef.json": RUNS_3,
    "runs-cafe.json": JSON.stringify({ workflow_runs: [{ id: 301, conclusion: "success" }, { id: 302, conclusion: null }] }),
    "jobs-101.json": jobs(201),
    "jobs-102.json": jobs(202),
    "jobs-103.json": jobs(203),
    "jobs-301.json": jobs(401),
    "jobs-302.json": jobs(402),
    "rerun-201": accept,
    "rerun-401": reject(IN_PROGRESS_403),
    "rerun-402": reject(IN_PROGRESS_403),
  });

  // RERAN > 0, so the all-or-nothing guard is correctly silent.
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 3, "one accepted POST for #7, two exhausted candidates for #8");
  assert.match(r.summary, /2 behind their base → 1 re-run/);
  assert.match(r.summary, /rejected: 1\b/);
  // The second reader of the counter. One accepted rerun must not launder the
  // exhausted PR into a clean green — and the count it reports is PRs.
  assert.match(r.out, /::warning::1 behind PR\(s\) were not re-run \(no-run: 0, no-job: 0, rejected: 1\)/);
});

// ---- what must NOT happen ----------------------------------------------

test("an accepted first candidate POSTs exactly once", (t) => {
  const r = runStep(t, {
    ...BEHIND_3_CANDIDATES,
    "rerun-201": accept,
    "rerun-202": accept,
    "rerun-203": accept,
  });

  assert.equal(r.status, 0, r.out);
  // Moving the POST into the loop must not turn one request per PR into five.
  assert.equal(r.posts.length, 1, "a 2xx must stop the walk");
  assert.match(r.summary, /1 re-run/);
});

test("a token failure exits on the first candidate rather than retrying per candidate", (t) => {
  const r = runStep(t, { ...BEHIND_3_CANDIDATES, "rerun-201": reject(TOKEN_403) });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /GITHUB_TOKEN lacks 'actions: write'/, "a global config defect must not read as N timing races");
  assert.equal(r.posts.length, 1, "retrying a token failure once per candidate is a rate-limit generator, not a fallback");
});

test("no rebase-check job in any candidate POSTs nothing and is counted as no-job", (t) => {
  const noJob = JSON.stringify({ jobs: [{ name: "check", id: 999 }] });
  const r = runStep(t, {
    ...BEHIND_3_CANDIDATES,
    "jobs-101.json": noJob,
    "jobs-102.json": noJob,
    "jobs-103.json": noJob,
  });

  assert.equal(r.posts.length, 0, "a PR with no rebase-check job anywhere must not POST a rerun");
  assert.match(r.summary, /no-job: 1/);
  assert.match(r.summary, /rejected: 0/, "nothing was rejected — nothing was asked");
  // The input #160's new error branch must still ACCEPT. Every candidate was
  // listed and none held the job, so the benign message is the accurate one
  // and the PR must stay out of `failed`.
  assert.match(r.summary, /failed: 0/, "three candidates that were all read successfully are not an API failure");
  assert.match(r.out, /no rebase-check job in any candidate run/, "with nothing unread, that claim is the true one");
  assert.doesNotMatch(r.out, /could not be listed/);
  assert.equal(r.status, 1, "behind and never re-run is still the all-or-nothing failure");
});

test("an up-to-date PR is still a silent green that touches no run at all", (t) => {
  // The default path. Restructuring the rerun branch must not reach it, and the
  // step must not acquire a way to exit 1 on a repo where nothing is stale.
  const r = runStep(t, { "prs.json": prs([7, "main", "deadbeef"]), "compare-deadbeef": "0\n" });

  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 0);
  assert.equal(r.calls.filter((c) => c.includes("/actions/")).length, 0, "an up-to-date PR must not query runs");
  assert.match(r.summary, /1 up to date, 0 behind/);
  assert.doesNotMatch(r.out, /--limit/, "one PR is not the list cap — the cap warning must not fire below it");
});

test("an unexpected exit status from the script fails the step instead of vanishing", (t) => {
  // `|| STATUS=$?` disarms `set -e` for the whole call, so every status the
  // `case` does not name has to be caught by its `*` arm.
  //
  // Two PRs, not one, and that is the whole point: #7 is re-run normally, so
  // RERAN=1 and the all-or-nothing guard at the foot of the step is silent.
  // With a single behind PR that guard exits 1 by itself, with a diagnostic
  // that happens to satisfy a status-plus-substring assertion — so the test
  // passes with the `*` arm's own `exit 1` deleted, which is the silent
  // absorption it is named for (the #574/#565 shape: a conjunction satisfied
  // by a DOWNSTREAM guard rather than the one under test).
  //
  // #8's jobs payload is unparseable, so jq aborts the script under
  // `set -euo pipefail` with 5 — a status the `case` does not name, reached
  // without mutating anything. If a `5)` arm is ever added, this test goes red
  // and wants a different unrouted status, not deleting.
  const r = runStep(t, {
    "prs.json": prs([7, "main", "deadbeef"], [8, "main", "cafe"]),
    "compare-deadbeef": "4\n",
    "compare-cafe": "2\n",
    "runs-deadbeef.json": RUNS_3,
    "runs-cafe.json": JSON.stringify({ workflow_runs: [{ id: 301, conclusion: "success" }] }),
    "jobs-101.json": jobs(201),
    "jobs-102.json": jobs(202),
    "jobs-103.json": jobs(203),
    "jobs-301.json": "not json",
    "rerun-201": accept,
  });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /exited 5/, "an unroutable classification must name the status, not be counted as a skip");
  // The consequence, and the half no downstream guard can produce here: the
  // step aborts AT #8 rather than running on to fold it into no counter at all
  // and summarising `2 behind -> 1 re-run` as a green.
  assert.equal(r.summary, "", "an unroutable status must abort the step, not be summarised over");
});

// ---- #160: an unlistable candidate is not a missing job -----------------
// The jobs query is the one query in the walk whose failure was reported as an
// absence. The runs query ~20 lines earlier already says "This is an API
// failure, not a missing run"; the jobs query said nothing, so a run nobody
// could look at came back as `no rebase-check job in any candidate run` — a
// diagnosis pointing at ci.yml's job name — and, because it landed in `no-job`
// rather than `failed`, neither the `FAILED == TOTAL` guard nor the
// `FAILED > 0` warning could see it.

test("every candidate's jobs listing failing is an API failure, not a missing job", (t) => {
  const fixtures = { ...BEHIND_3_CANDIDATES };
  for (const id of [101, 102, 103]) delete fixtures[`jobs-${id}.json`];
  const r = runStep(t, fixtures);

  assert.equal(r.posts.length, 0, "nothing was resolvable to POST against");
  assert.match(
    r.out,
    /::error::#7 \(deadbeef\): no rebase-check job found, and 3 candidate run\(s\) could not be listed — an API failure, not a missing job\./,
    "a run nobody could look at must not be reported as a run that lacks the job",
  );
  assert.doesNotMatch(r.out, /no rebase-check job in any candidate run/, "that message asserts the job does not exist");
  assert.match(r.summary, /failed: 1/, "the counter the `FAILED == TOTAL` guard and the `FAILED > 0` warning read");
  assert.match(r.summary, /no-job: 0/, "an unlistable candidate is not a candidate that lacked the job");
});

test("one unlistable candidate among candidates that lack the job is still an API failure", (t) => {
  // The mixed case, and the classification the whole ticket turns on: you
  // cannot report "no rebase-check job in ANY candidate run" while one
  // candidate is a run you never got to look at.
  const noJob = JSON.stringify({ jobs: [{ name: "check", id: 999 }] });
  const fixtures = { ...BEHIND_3_CANDIDATES, "jobs-102.json": noJob, "jobs-103.json": noJob };
  delete fixtures["jobs-101.json"];
  const r = runStep(t, fixtures);

  assert.match(r.out, /and 1 candidate run\(s\) could not be listed — an API failure, not a missing job\./);
  assert.match(r.summary, /failed: 1/);
  assert.match(r.summary, /no-job: 0/);
});

test("the jobs-API failure lands where the downstream guards read it, without newly failing the step", (t) => {
  // The other half: incrementing FAILED changes what three readers emit — the
  // `FAILED == TOTAL` exit, the `FAILED > 0` warning, and the SKIPPED warning
  // this PR must LEAVE. #7 re-runs, so the all-or-nothing guard is silent and
  // the step runs to the foot: a step that exited 0 before must still exit 0.
  const r = runStep(t, {
    "prs.json": prs([7, "main", "deadbeef"], [8, "main", "cafe"]),
    "compare-deadbeef": "4\n",
    "compare-cafe": "2\n",
    "runs-deadbeef.json": RUNS_3,
    "runs-cafe.json": JSON.stringify({ workflow_runs: [{ id: 301, conclusion: "success" }] }),
    "jobs-101.json": jobs(201),
    "jobs-102.json": jobs(202),
    "jobs-103.json": jobs(203),
    "rerun-201": accept,
  });

  assert.equal(r.status, 0, r.out);
  assert.match(r.summary, /2 behind their base → 1 re-run/);
  assert.match(r.summary, /no-job: 0, rejected: 0, failed: 1/);
  assert.match(r.out, /::warning::1 PR\(s\) hit API errors and may still show a stale rebase-check/);
  assert.doesNotMatch(r.out, /behind PR\(s\) were not re-run/, "an API failure is reported as one, not as a skip");
});

test("a found-and-rejected candidate still classifies the PR when a sibling's jobs listing failed", (t) => {
  // The gate, not the message: the new JOBS_ERRS branch sits INSIDE
  // `if [ -z "$FOUND_JOB" ]`, and the comment at the head of the script says
  // why — "a candidate that WAS listed still classifies the PR however many of
  // its siblings errored". Hoist the branch out of that gate and this case
  // flips from `rejected` to `failed` with a false "no rebase-check job found"
  // — the same misdiagnosis class #160 exists to end, reached from the other
  // side. Nothing above pins it: every #160 test leaves FOUND_JOB unset.
  const fixtures = { ...BEHIND_3_CANDIDATES, "rerun-202": reject(IN_PROGRESS_403), "rerun-203": reject(IN_PROGRESS_403) };
  delete fixtures["jobs-101.json"];
  const r = runStep(t, fixtures);

  assert.equal(r.posts.length, 2, "the two listable candidates were both found and both tried");
  assert.match(r.out, /failed to list jobs for run 101/, "the listing failure still gets its own line");
  assert.match(r.out, /every candidate run rejected the rerun/, "jobs WERE found — this is an exhausted walk, not an API failure");
  assert.doesNotMatch(r.out, /no rebase-check job found/, "claiming no job was found is false when two candidates held one");
  assert.match(r.summary, /rejected: 1\b/);
  assert.match(r.summary, /failed: 0/, "one unlistable sibling does not move a resolved PR into `failed`");
  assert.match(r.summary, /no-job: 0/);
  assert.equal(r.status, 1, "behind and never re-run is still the all-or-nothing failure");
});

// ---- #162: a row that reaches no counter -------------------------------
// The malformed-row guard `continue`s past every counter, so a list where
// every row fails to parse leaves TOTAL=N and everything else 0: the
// `BEHIND > 0 && RERAN == 0` guard is false, the `FAILED == TOTAL` guard is
// false, and the step exits 0 over a summary of zeros. The fix is one
// assertion over the counters rather than a counter for malformed rows,
// because a counter only covers the `continue` that exists today.

test("a list whose rows all fail to parse fails the step instead of summarising zeros", (t) => {
  // An empty string, not a missing key: a null field projects as the literal
  // `null`, which is three tokens and parses fine. A degraded API blanking a
  // field is the shape that actually reaches the malformed-row guard.
  const r = runStep(t, { "prs.json": prs([7, "main", ""], [8, "main", ""]) });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::accounting mismatch: 2 PR\(s\) listed but 0 evaluated/);
  assert.equal(r.posts.length, 0, "nothing was evaluated — the failure is that this was green");
});

test("a PR that is behind AND then fails is one row, not two — the run still exits 0", (t) => {
  // The accept half, and the case that decides the shape of the assertion.
  // BEHIND is not a terminal disposition: #9 increments BEHIND and then FAILED,
  // so `UPTODATE + BEHIND + FAILED` reads 4 against TOTAL=3 and would fail a
  // run whose only complaint is one PR hitting an API error — a warn, not a
  // failure. Summing the terminal counters instead (up-to-date, re-run,
  // no-run, no-job, rejected, failed) counts each row exactly once.
  const r = runStep(t, {
    "prs.json": prs([7, "main", "deadbeef"], [8, "main", "cafe"], [9, "main", "feed"]),
    "compare-deadbeef": "0\n",
    "compare-cafe": "4\n",
    "compare-feed": "6\n",
    "runs-cafe.json": JSON.stringify({ workflow_runs: [{ id: 301, conclusion: "success" }] }),
    "jobs-301.json": jobs(401),
    "rerun-401": accept,
    // no runs-feed.json: the stub answers HTTP 500, so #9 is behind and failed.
  });

  assert.equal(r.status, 0, r.out);
  assert.match(r.summary, /Checked 3 open PR\(s\): 1 up to date, 2 behind their base → 1 re-run/);
  assert.match(r.summary, /failed: 1/);
  assert.doesNotMatch(r.out, /accounting mismatch/, "three rows, three terminal counters — nothing was dropped");
});

// ---- #162: the projection against the response it came from -------------
// `gh pr list` exiting non-zero is caught. Exiting ZERO having produced rows
// that do not correspond to the PRs it listed is not, and this is the
// most-taken path in the workflow, so there is no baseline from which to
// notice the day it starts lying.

test("a row count that disagrees with the response is refused before anything is evaluated", (t) => {
  // A field carrying a newline splits one element into two rows, and both
  // halves here parse as three tokens — so the assertion at the foot of the
  // step cannot see it: three rows reaching three terminal counters IS
  // balanced accounting. The step evaluates two refs that no PR ever had,
  // summarises one up-to-date PR and two API errors, and exits 0. The count
  // gh returned is the only thing that disagrees.
  const r = runStep(t, {
    "prs.json": prs([7, "main", "deadbeef"], [8, "x y\nz w", "cafe"]),
    "compare-deadbeef": "0\n",
  });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::gh listed 2 open PR\(s\) but the projection produced 3 row\(s\)/);
  assert.equal(
    r.calls.filter((c) => c.includes("/compare/")).length,
    0,
    "a list this step cannot account for must be refused before any of it is acted on",
  );
});

// ---- #162: the list cap ------------------------------------------------
// `--limit 100` is the one truncation this step cannot measure: TOTAL, the
// count gh returned and the accounting assertion all describe the 100 rows
// that came back, never the PRs past them. The warning is kept for that
// reason, but it warned at a count that merely EQUALS the cap while
// asserting as fact that PRs were missed.

test("a full page warns that the list hit its limit without asserting PRs were missed", (t) => {
  const rows = [];
  const fixtures = {};
  for (let i = 0; i < 100; i++) {
    rows.push([i + 1, "main", `sha${i}`]);
    fixtures[`compare-sha${i}`] = "0\n";
  }
  const r = runStep(t, { "prs.json": prs(...rows), ...fixtures });

  // Exactly 100 open PRs, all up to date, nothing truncated: a legitimate
  // no-op that must stay green, and the largest accept the accounting
  // assertion gets.
  assert.equal(r.status, 0, r.out);
  assert.match(r.summary, /Checked 100 open PR\(s\): 100 up to date/);
  assert.match(r.out, /::warning::.*--limit 100/, "the warning must state the limit it is reporting");
  assert.doesNotMatch(
    r.out,
    /PRs beyond the first 100 were not refreshed/,
    "at exactly the cap nothing was necessarily truncated — the count equalling the limit is not evidence",
  );
});

// ---- #162: the guards on the list response itself -----------------------
// Three guards stand between `gh pr list` exiting 0 and the loop, and each
// one shipped without a witness. They are pinned by their annotations rather
// than by exit status alone: `set -euo pipefail` makes an unguarded failure
// exit non-zero too, so a status assertion on its own passes just as well
// with every guard deleted — and the whole point of these guards is that the
// run log says which one fired.

test("a fast exit on an empty list is the most-taken path, and it stays green", (t) => {
  // `prs()` is the literal `[]`: gh listed nothing. Decided from the count,
  // not from the empty projection, so this is the arm that reads N — and it
  // is the arm that runs on a quiet week, which is why it must be pinned
  // rather than inferred from the busy cases.
  const r = runStep(t, { "prs.json": prs() });

  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /No open PRs targeting main\./);
  assert.equal(
    r.calls.filter((c) => c.includes("/compare/")).length,
    0,
    "an empty list must be answered without touching the compare API",
  );
});

test("output that is not a JSON array is refused, naming the guard that refused it", (t) => {
  // The four shapes `jq 'length'` alone cannot tell apart from an array:
  // length answers 0 for null, the key count for an object and the character
  // count for a string, so a bare `length` exits 0 on the first three and
  // only truncated JSON ever reached the annotation. Each is asserted
  // separately — one of them passing is not the class passing.
  for (const body of ['null', '{"message":"bad credentials"}', '"nope"', '[{"num']) {
    const r = runStep(t, { "prs.json": body });

    assert.equal(r.status, 1, `${body} was accepted: ${r.out}`);
    assert.match(
      r.out,
      /::error::gh pr list returned output jq could not read as a JSON array/,
      `${body} exited non-zero with no annotation — an abort under set -e, not this guard`,
    );
  }
});

test("output that is empty rather than malformed is refused too, not counted as zero PRs", (t) => {
  // jq handed empty stdin prints nothing and exits 0, so the guard above sees
  // a success and N is left the empty string. Both readers of N are `[ ]`
  // integer comparisons that abort with `integer expected` and read FALSE on
  // it, so without this guard the empty-list fast exit does not fire AND the
  // cross-check this step exists for is inoperative on exactly this input.
  const r = runStep(t, { "prs.json": "" });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::gh pr list exited 0 but produced no countable JSON array/);
  assert.doesNotMatch(r.out, /No open PRs targeting/, "empty output is not a quiet week — nothing said there are no PRs");
});

test("an array the projection cannot read is refused with an annotation, not a bare abort", (t) => {
  // Past the type check — `[1,2]` is an array of length 2 — and into the
  // projection, where `.headRefOid` on a number is a jq error. A bare
  // assignment here aborts under `set -e` with nothing in the run log, which
  // is the failure mode the `if !` convention in this block exists to avoid.
  const r = runStep(t, { "prs.json": "[1,2]" });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::gh pr list output could not be projected into rows/);
});
