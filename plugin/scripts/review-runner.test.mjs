// #1802 (spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 3 §1,
// §2, §5, §7). `runReviewToFile` is the whole of the omp review runner's job —
// agents/fleet-review-runner.agent.md's one eval cell calls it and reports
// what it returns — so the runner's contract is pinned here, where it can be
// run, rather than in the agent's prose:
//
//   - the full result object lands at `<scratch>/review-<pr>.json`, and the
//     return carries only the digest, the path and the ledger token;
//   - a throw or an empty return is retried ONCE; a second failure reports
//     `failed` with both errors and names the fallback reviewer
//     `review-pr-<pr>-b`, writing no file;
//   - a dispatch mistake (no absolute scratch, a non-numeric pr) is refused
//     before the review runs at all — it is not a review failure, so it must
//     neither burn two 20-minute runs nor send the controller to the fallback.
//
// `run` is injected: the real one is `runReviewOnOmp`, which reads eval's
// `agent()`/`phase()`/`log()` prelude globals and cannot run under node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewToFile } from "./review-eval.mjs";
import { DIGEST_KEYS } from "./review-core.mjs";

const RESULT = {
  pr: 7,
  head: "abc123",
  resume: null,
  testEnvironment: "The snapshot is a verified repository.",
  dimensionsRun: ["correctness"],
  dimensionsUnrun: [],
  cwdAudit: [{ dimension: "correctness", state: "clean", line: "CWD-AUDIT: clean /repo" }],
  counts: { survived: 1, refuted: 2, unverified: 3, crashed: 0 },
  snapshot: "/scr/pr7/run-ab12/snapshot-abc123",
  survived: [{ claim: "s" }],
  refuted: [{ claim: "r1" }, { claim: "r2" }],
  unverified: [{ claim: "u1" }, { claim: "u2" }, { claim: "u3" }],
};

const scratch = () => mkdtempSync(join(tmpdir(), "review-runner-"));

// A `run` that answers from a script, one entry per call; an `Error` entry is
// thrown. Counts calls so a test can say how many reviews it cost.
function scriptedRun(answers) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const a = answers[Math.min(calls.length, answers.length) - 1];
    if (a instanceof Error) throw a;
    return a;
  };
  return { run, calls };
}

test("a completed review writes the whole result to <scratch>/review-<pr>.json and returns only the digest", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([RESULT]);
  const out = await runReviewToFile({ pr: 7, branch: "b", worktree: "/wt", testCmd: "node --test", scratch: dir }, run);
  assert.equal(calls.length, 1);
  assert.equal(out.status, "completed");
  assert.equal(out.path, join(dir, "review-7.json"));
  assert.deepEqual(JSON.parse(readFileSync(out.path, "utf8")), RESULT, "the file is not the bare result object");
  assert.deepEqual(Object.keys(out.digest), DIGEST_KEYS);
  for (const bulk of ["snapshot", "survived", "refuted", "unverified"]) {
    assert.equal(bulk in out.digest, false, `the report carries ${bulk} — findings must reach the fix-applier through the file, not the controller`);
  }
  assert.equal(out.ledger, "reviewed=abc123:1/2/3", "the ledger token is not reviewed=<head>:<survived>/<refuted>/<unverified>");
  assert.equal(out.attempts, 1);
});

test("the args reach the review unchanged — the runner adds and drops nothing", async () => {
  const dir = scratch();
  const args = { pr: "7", branch: "feature/x", worktree: "/repo/.worktrees/7-x", testCmd: "node --test", scratch: dir };
  const { run, calls } = scriptedRun([RESULT]);
  await runReviewToFile(args, run);
  assert.deepEqual(calls[0], args);
});

test("a thrown first run is retried once, and the second run's result is the one written", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([new Error("snapshot agent returned no tree"), RESULT]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2);
  assert.equal(out.status, "completed");
  assert.equal(out.attempts, 2);
  assert.match(out.errors[0], /snapshot agent returned no tree/, "the first failure vanished from the report");
  assert.deepEqual(JSON.parse(readFileSync(out.path, "utf8")), RESULT);
});

test("an empty return is a failure too, and is retried", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([undefined, RESULT]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2);
  assert.equal(out.status, "completed");
  assert.match(out.errors[0], /empty/);
});

// #1813: a truthy, object-shaped result missing `.counts` (e.g. a `run`
// callback that resolves to the finding buckets without the wrapper) must not
// reach the `mkdir`/`writeFile` below before the shape is checked — otherwise
// the destructure of `result.counts` on the next line throws OUTSIDE this
// function's own retry try/catch, and the half-written file it already put on
// disk is left there for a fix-applier to mistake for a completed review.
test("a result missing .counts is a failure too, retried, and leaves no half-written file", async () => {
  const dir = scratch();
  const malformed = { pr: 7, head: "abc123", survived: [], refuted: [], unverified: [] };
  const { run, calls } = scriptedRun([malformed, RESULT]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2, "the malformed attempt was retried, not thrown past");
  assert.equal(out.status, "completed");
  assert.match(out.errors[0], /empty/);
  assert.deepEqual(JSON.parse(readFileSync(out.path, "utf8")), RESULT, "only the second, well-formed result was ever written");
});

test("two malformed results in a row report failed and write no file", async () => {
  const dir = scratch();
  const malformed = { pr: 7, head: "abc123", survived: [], refuted: [], unverified: [] };
  const { run, calls } = scriptedRun([malformed, malformed]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2);
  assert.equal(out.status, "failed");
  assert.equal(out.fallback, "review-pr-7-b");
  assert.equal(existsSync(join(dir, "review-7.json")), false, "a malformed result left a partial file behind");
});

test("a second failure reports failed with BOTH errors, names the -b fallback, and writes no file", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([new Error("first: spend limit"), null]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2, "the retry is ONE re-run, not a loop");
  assert.equal(out.status, "failed");
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0], /first: spend limit/);
  assert.match(out.errors[1], /empty/);
  assert.equal(out.fallback, "review-pr-7-b");
  assert.equal(existsSync(join(dir, "review-7.json")), false, "a failed review left a result file a controller would read as a review");
});

test("a scratch that is missing or relative is refused before any review runs", async () => {
  for (const bad of [undefined, "", "scratch/fleet", "./x"]) {
    const { run, calls } = scriptedRun([RESULT]);
    await assert.rejects(runReviewToFile({ pr: 7, scratch: bad, worktree: "/wt" }, run), /args\.scratch must be an absolute path/, JSON.stringify(bad));
    assert.equal(calls.length, 0, `${JSON.stringify(bad)}: a review ran for a dispatch whose result file could land in the kernel's cwd`);
  }
});

test("a pr that is not a PR number is refused before any review runs", async () => {
  for (const bad of [undefined, "my-branch", "7/../../x", -7]) {
    const { run, calls } = scriptedRun([RESULT]);
    await assert.rejects(runReviewToFile({ pr: bad, scratch: scratch(), worktree: "/wt" }, run), /args\.pr must be a PR number/, JSON.stringify(bad));
    assert.equal(calls.length, 0);
  }
});
