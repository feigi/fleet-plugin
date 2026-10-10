// #1802 (spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 3 §1,
// §2, §5, §7). `runReviewToFile` is the whole of the omp review runner's job —
// agents/fleet-review-runner.agent.md's one eval cell calls it and reports
// what it returns — so the runner's contract is pinned here, where it can be
// run, rather than in the agent's prose:
//
//   - the full result object lands at `<run root>/review.json`, the run root
//     being the review's own `<scratch>/pr<pr>/run-XXXXXXXX` (#2886), and the
//     return carries only the digest, the path and the ledger token, which
//     names that run;
//   - a throw or an empty return is retried ONCE; a second failure reports
//     `failed` with both errors, naming no fallback (the controller takes the
//     next free reviewer name off the PR's rows), writing no file;
//   - a dispatch mistake (no absolute scratch, a non-numeric pr) is refused
//     before the review runs at all — it is not a review failure, so it must
//     neither burn two 20-minute runs nor send the controller to the fallback.
//
// `run` is injected: the real one is `runReviewOnOmp`, which reads eval's
// `agent()`/`phase()`/`log()` prelude globals and cannot run under node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tempDir } from "./support/temp-dir.mjs";
import { join } from "node:path";
import { runReviewToFile } from "../plugin/scripts/review-eval.mjs";
import { DIGEST_KEYS } from "../plugin/scripts/review-core.mjs";
const REVIEW_EVAL = new URL("../plugin/scripts/review-eval.mjs", import.meta.url).href;

// The result a review of PR 7 returns when its run root is
// `<dir>/pr7/<run>` — the snapshot sits in that root, as review-core.mjs
// provisions it.
const resultIn = (dir, run = "run-Ab12Cd34") => ({
  pr: 7,
  head: "abc123",
  resume: null,
  testEnvironment: "The snapshot is a verified repository.",
  dimensionsRun: ["correctness"],
  dimensionsUnrun: [],
  cwdAudit: [{ dimension: "correctness", state: "clean", line: "CWD-AUDIT: clean /repo" }],
  counts: { survived: 1, refuted: 2, unverified: 3, crashed: 0 },
  snapshot: join(dir, "pr7", run, "snapshot-abc123"),
  survived: [{ claim: "s" }],
  refuted: [{ claim: "r1" }, { claim: "r2" }],
  unverified: [{ claim: "u1" }, { claim: "u2" }, { claim: "u3" }],
});
const RESULT = resultIn("/scr");

const scratch = () => tempDir("review-runner-");

// Every file anywhere under `dir` — a failed review must leave none.
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name));

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

test("a completed review writes the whole result to <run root>/review.json and returns only the digest", async () => {
  const dir = scratch();
  const result = resultIn(dir);
  const { run, calls } = scriptedRun([result]);
  const out = await runReviewToFile({ pr: 7, branch: "b", worktree: "/wt", testCmd: "node --test", scratch: dir }, run);
  assert.equal(calls.length, 1);
  assert.equal(out.status, "completed");
  assert.equal(out.path, join(dir, "pr7", "run-Ab12Cd34", "review.json"));
  assert.deepEqual(JSON.parse(readFileSync(out.path, "utf8")), result, "the file is not the bare result object");
  assert.deepEqual(Object.keys(out.digest), DIGEST_KEYS);
  for (const bulk of ["snapshot", "survived", "refuted", "unverified"]) {
    assert.equal(bulk in out.digest, false, `the report carries ${bulk} — findings must reach the fix-applier through the file, not the controller`);
  }
  assert.equal(out.ledger, "reviewed=abc123:1/2/3:run-Ab12Cd34", "the ledger token is not reviewed=<head>:<survived>/<refuted>/<unverified>:<run>");
  assert.equal(out.attempts, 1);
});

test("two reviews of one PR at one head leave two files, two paths and two ledger tokens", async () => {
  const dir = scratch();
  const first = resultIn(dir, "run-Ab12Cd34");
  const second = { ...resultIn(dir, "run-Zz98Yy76"), counts: { survived: 0, refuted: 3, unverified: 0, crashed: 0 } };
  const a = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, scriptedRun([first]).run);
  const b = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, scriptedRun([second]).run);
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.ledger, b.ledger);
  assert.equal(b.ledger, "reviewed=abc123:0/3/0:run-Zz98Yy76");
  assert.deepEqual(JSON.parse(readFileSync(a.path, "utf8")), first, "the second review replaced the first one's findings");
  assert.deepEqual(JSON.parse(readFileSync(b.path, "utf8")), second);
});

test("a scratch passed with a trailing slash still finds the run root the review built from it", async () => {
  const dir = scratch();
  // review-core.mjs builds the run root by string, `${scratch}/pr<N>/run-…`.
  const result = { ...resultIn(dir), snapshot: `${dir}//pr7/run-Ab12Cd34/snapshot-abc123` };
  const out = await runReviewToFile({ pr: 7, scratch: `${dir}/`, worktree: "/wt" }, scriptedRun([result]).run);
  assert.equal(out.status, "completed", out.errors.join("\n"));
  assert.equal(out.path, join(dir, "pr7", "run-Ab12Cd34", "review.json"));
  assert.equal(out.ledger, "reviewed=abc123:1/2/3:run-Ab12Cd34");
});

test("a review file already at the run root is never replaced: the attempt fails and is retried", async () => {
  const dir = scratch();
  const taken = join(dir, "pr7", "run-Ab12Cd34");
  mkdirSync(taken, { recursive: true });
  writeFileSync(join(taken, "review.json"), "round one\n");
  const { run, calls } = scriptedRun([resultIn(dir, "run-Ab12Cd34"), resultIn(dir, "run-Qq11Ww22")]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2);
  assert.equal(out.status, "completed");
  assert.match(out.errors[0], /EEXIST/);
  assert.equal(readFileSync(join(taken, "review.json"), "utf8"), "round one\n");
  assert.equal(out.path, join(dir, "pr7", "run-Qq11Ww22", "review.json"));
});

// A write fault that is not the run root's file being taken is the
// environment's, not the review's: the review is not run again for it and no
// fallback reviewer is named. Here `pr7` is a regular file, so no run root can
// be made under it.
test("a write fault other than a taken file throws and does not re-run the review", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "pr7"), "not a directory\n");
  const { run, calls } = scriptedRun([resultIn(dir), resultIn(dir)]);
  await assert.rejects(runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run), (e) => e.code !== "EEXIST" && typeof e.code === "string");
  assert.equal(calls.length, 1, "a second full review was bought for a fault it would hit again");
});

// A write that fails partway — here a file-size limit on the child — has
// already created the file, and what it left is half a review. The same child
// with no limit is the control: it writes the whole file, so the limit is what
// made the second one fail.
test("a write that fails partway throws and removes the truncated file", { skip: process.platform === "win32" }, () => {
  const script = `
    import { runReviewToFile } from ${JSON.stringify(REVIEW_EVAL)};
    import { join } from "node:path";
    const dir = process.argv[1];
    const result = {
      pr: 7, head: "abc123", resume: null, testEnvironment: "t", dimensionsRun: [], dimensionsUnrun: [], cwdAudit: [],
      counts: { survived: 1, refuted: 0, unverified: 0, crashed: 0 },
      snapshot: join(dir, "pr7", "run-Ab12Cd34", "snapshot-abc123"),
      survived: [{ claim: "x".repeat(200000) }], refuted: [], unverified: [],
    };
    try {
      const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, async () => result);
      console.log(JSON.stringify({ status: out.status }));
    } catch (e) {
      console.log(JSON.stringify({ threw: e.code }));
    }`;
  const run = (dir, limit) => {
    const r = spawnSync("sh", ["-c", `${limit ? "ulimit -f 40 && " : ""}exec "$0" "$@"`, process.execPath, "--input-type=module", "-e", script, dir],
      { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const control = scratch();
  assert.deepEqual(run(control, false), { status: "completed" });
  assert.equal(filesUnder(control).length, 1, "the unlimited control did not write its file");
  const limited = scratch();
  assert.deepEqual(run(limited, true), { threw: "EFBIG" });
  assert.deepEqual(filesUnder(limited), [], "a half-written review.json was left in the run root");
});

test("a review run for another PR number lands in that PR's run root", async () => {
  const dir = scratch();
  const result = { ...resultIn(dir), pr: 42, snapshot: join(dir, "pr42", "run-Ab12Cd34", "snapshot-abc123") };
  const { run, calls } = scriptedRun([result]);
  const out = await runReviewToFile({ pr: 42, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 1);
  assert.equal(out.status, "completed", out.errors.join("\n"));
  assert.equal(out.path, join(dir, "pr42", "run-Ab12Cd34", "review.json"));
});

test("a result whose snapshot is not in a run root of this PR under this scratch is a failed attempt, retried, and writes nothing there", async () => {
  const outside = [
    (dir) => ({ ...resultIn(dir), snapshot: undefined }),
    (dir) => ({ ...resultIn(dir), snapshot: "relative/pr7/run-Ab12Cd34/snapshot-abc123" }),
    (dir) => ({ ...resultIn(dir), snapshot: join(dir, "pr8", "run-Ab12Cd34", "snapshot-abc123") }),
    (dir) => ({ ...resultIn(dir), snapshot: join(dir, "other", "pr7", "run-Ab12Cd34", "snapshot-abc123") }),
    (dir) => ({ ...resultIn(dir), snapshot: join(dir, "pr7", "snapshot-abc123") }),
    (dir) => ({ ...resultIn(dir), snapshot: join(dir, "pr7", "run-short", "snapshot-abc123") }),
    (dir) => ({ ...resultIn(dir), snapshot: `${dir}/pr7/run-Ab12Cd34/../run-Zz98Yy76/snapshot-abc123` }),
    // The basename is anchored at both ends: a prefix or a ninth character is
    // no run root.
    (dir) => ({ ...resultIn(dir), snapshot: join(dir, "pr7", "xrun-Ab12Cd34", "snapshot-abc123") }),
    (dir) => ({ ...resultIn(dir), snapshot: join(dir, "pr7", "run-Ab12Cd34Z", "snapshot-abc123") }),
  ];
  for (const make of outside) {
    const dir = scratch();
    const bad = make(dir);
    const { run, calls } = scriptedRun([bad, resultIn(dir)]);
    const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
    assert.equal(calls.length, 2, `${bad.snapshot}: not retried`);
    assert.equal(out.status, "completed");
    assert.match(out.errors[0], /run root/, String(bad.snapshot));
    assert.deepEqual(filesUnder(dir), [join(dir, "pr7", "run-Ab12Cd34", "review.json")], String(bad.snapshot));
  }
});

test("the args reach the review unchanged — the runner adds and drops nothing", async () => {
  const dir = scratch();
  const args = { pr: "7", branch: "feature/x", worktree: "/repo/.worktrees/7-x", testCmd: "node --test", scratch: dir };
  const { run, calls } = scriptedRun([resultIn(dir)]);
  await runReviewToFile(args, run);
  assert.deepEqual(calls[0], args);
});

test("a thrown first run is retried once, and the second run's result is the one written", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([new Error("snapshot agent returned no tree"), resultIn(dir)]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2);
  assert.equal(out.status, "completed");
  assert.equal(out.attempts, 2);
  assert.match(out.errors[0], /snapshot agent returned no tree/, "the first failure vanished from the report");
  assert.deepEqual(JSON.parse(readFileSync(out.path, "utf8")), resultIn(dir));
});

test("an empty return is a failure too, and is retried", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([undefined, resultIn(dir)]);
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
  const malformed = { pr: 7, head: "abc123", snapshot: join(dir, "pr7", "run-Mm00Nn11", "snapshot-abc123"), survived: [], refuted: [], unverified: [] };
  const { run, calls } = scriptedRun([malformed, resultIn(dir)]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2, "the malformed attempt was retried, not thrown past");
  assert.equal(out.status, "completed");
  assert.match(out.errors[0], /empty/);
  assert.deepEqual(JSON.parse(readFileSync(out.path, "utf8")), resultIn(dir), "only the second, well-formed result was ever written");
  assert.deepEqual(filesUnder(dir), [out.path], "the malformed attempt left a file behind");
});

test("two malformed results in a row report failed and write no file", async () => {
  const dir = scratch();
  const malformed = { pr: 7, head: "abc123", snapshot: join(dir, "pr7", "run-Mm00Nn11", "snapshot-abc123"), survived: [], refuted: [], unverified: [] };
  const { run, calls } = scriptedRun([malformed, malformed]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2);
  assert.equal(out.status, "failed");
  assert.equal("fallback" in out, false, "the result names no fallback reviewer: the controller takes the next free name off the PR's rows");
  assert.deepEqual(filesUnder(dir), [], "a malformed result left a partial file behind");
});

test("a second failure reports failed with BOTH errors, names no fallback, and writes no file", async () => {
  const dir = scratch();
  const { run, calls } = scriptedRun([new Error("first: spend limit"), null]);
  const out = await runReviewToFile({ pr: 7, scratch: dir, worktree: "/wt" }, run);
  assert.equal(calls.length, 2, "the retry is ONE re-run, not a loop");
  assert.equal(out.status, "failed");
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0], /first: spend limit/);
  assert.match(out.errors[1], /empty/);
  assert.equal("fallback" in out, false, "the result names no fallback reviewer: the controller takes the next free name off the PR's rows");
  assert.deepEqual(filesUnder(dir), [], "a failed review left a result file a controller would read as a review");
});


test("a scratch that is missing or relative is refused before any review runs", async () => {
  for (const bad of [undefined, "", "scratch/fleet", "./x"]) {
    const { run, calls } = scriptedRun([RESULT]);
    await assert.rejects(runReviewToFile({ pr: 7, scratch: bad, worktree: "/wt" }, run), /args\.scratch must be an absolute path/, JSON.stringify(bad));
    assert.equal(calls.length, 0, `${JSON.stringify(bad)}: a review ran for a dispatch whose result file could land in the kernel's cwd`);
  }
});

// #2323. A scratch the controller already partitioned is a dispatch mistake,
// not a review failure: runReview would throw it, and without this the runner
// would retry it and name a fallback reviewer for a review that never ran.
test("a scratch already ending in pr<N> is refused before any review runs, not retried", async () => {
  for (const bad of ["/x/pr7", "/x/pr7/", "/x/pr42"]) {
    const { run, calls } = scriptedRun([RESULT]);
    await assert.rejects(runReviewToFile({ pr: 7, scratch: bad, worktree: "/wt" }, run), /pass the scratch root/, bad);
    assert.equal(calls.length, 0, `${bad}: a partitioned scratch reached the review`);
  }
});

test("a pr that is not a PR number is refused before any review runs", async () => {
  for (const bad of [undefined, "my-branch", "7/../../x", -7]) {
    const { run, calls } = scriptedRun([RESULT]);
    await assert.rejects(runReviewToFile({ pr: bad, scratch: scratch(), worktree: "/wt" }, run), /args\.pr must be a PR number/, JSON.stringify(bad));
    assert.equal(calls.length, 0);
  }
});
