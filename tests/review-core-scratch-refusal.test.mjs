// #2323. `runReview` owns the review side's `pr<N>/` partition: it appends
// `/pr${pr}` to the scratch it is given. A caller that already did so (the
// run-team skill once read as telling the controller to pass `<scratch>/pr<N>`)
// nested every run root at `<root>/pr<N>/pr<N>/run-*`, which a correctly scoped
// review's prune never reaches. So a scratch whose LAST component — after `.`
// segments and repeated or trailing slashes collapse — is `pr` followed only
// by digits is refused before any dispatch, whatever the digits, and never
// coerced by stripping the suffix. A `..` segment is refused outright: the
// kernel resolves it through symlinks, so no lexical reading of it is safe.
//
// Driven through the real `runReview` and asserted on `calls`, for the reason
// review-core-snapshot-path.test.mjs states beside its skewed-snapshot test: a
// rejection alone does not show nothing was dispatched first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../plugin/scripts/review-core.mjs";
import { scratchRoot } from "../plugin/scripts/fleet-dir.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { ARGS, SNAP, pipeline, parallel, review, scriptedHost } from "./support/review-host-fixture.mjs";

const PR = 42;

function runWith(scratch) {
  const base = scratch === undefined ? scratchRoot() : scratch.replace(/\/+$/, "");
  const runRoot = `${base}/pr${PR}/run-ab12`;
  const snap = { ...SNAP, runRoot, path: `${runRoot}/snapshot-abc123` };
  const { host, calls, prompts } = scriptedHost({ snapshot: [snap], "review:correctness": [review([])] });
  return { run: runReview({ ...host, pipeline, parallel }, { ...ARGS, pr: PR, scratch }), calls, prompts, base };
}

// The omitted scratch is `~/.fleet/scratch/<key>/`, and whether that root is
// accepted depends on the home it sits under — a developer whose HOME is a git
// work tree that does not ignore `.fleet/` is refused. `os.homedir()` follows
// HOME on POSIX, so each case that reads the default root pins HOME to a bare
// temp directory instead of the machine's own.
async function withBareHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "review-core-home-")));
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  }
}

const PR_SUFFIX = /already ends in a pr<N> directory/;
const DOTDOT = /has a "\.\." segment/;
const refused = [
  ...["/x/pr42", "/x/pr42/", "/x/pr7", "/x/pr42//", "pr42", "/x/pr42/.", "/x/pr42/./", "/x/./pr42/."].map((s) => [s, PR_SUFFIX]),
  ...["/x/pr42/..", "/x/a/../pr42", "/x/link/.."].map((s) => [s, DOTDOT]),
];
for (const [scratch, reason] of refused) {
  test(`scratch ${scratch} is refused before any dispatch (${reason.source}), naming the path`, async () => {
    const { run, calls } = runWith(scratch);
    await assert.rejects(run, (err) => {
      assert.ok(err.message.includes(JSON.stringify(scratch)), `the refusal does not name the scratch it was given: ${err.message}`);
      assert.match(err.message, reason, `refused for the wrong reason: ${err.message}`);
      assert.match(err.message, /scratch root/, `the refusal does not say to pass the scratch root: ${err.message}`);
      return true;
    });
    assert.deepEqual(calls, {}, `a refused scratch still dispatched: ${JSON.stringify(calls)}`);
  });
}

// A scratch that is present but not an absolute string — a relative path, a
// number, an array, or any falsy value (only an absent one takes the default) —
// is refused before any dispatch, naming the value: every one of them would
// otherwise be interpolated into the snapshot prompt's paths or silently
// replaced. A non-string whose `String()` form is an absolute path is in the
// list too: only the `typeof` half of the guard refuses it. The absolute and
// omitted cases it must still accept are in the loop below.
for (const scratch of [3, "42", ["a"], 0, false, "", null, Number.NaN, ["/tmp/x"], { toString: () => "/tmp/x" }]) {
  test(`scratch ${inspect(scratch)} is refused before any dispatch as not an absolute path`, async () => {
    const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [review([])] });
    await assert.rejects(runReview({ ...host, pipeline, parallel }, { ...ARGS, pr: PR, scratch }), (err) => {
      assert.match(err.message, /^review-pr: args\.scratch must be an absolute path/, `refused for the wrong reason: ${err.message}`);
      assert.ok(err.message.includes(JSON.stringify(scratch)), `the refusal does not name the scratch it was given: ${err.message}`);
      return true;
    });
    assert.deepEqual(calls, {}, `a non-absolute scratch still dispatched: ${JSON.stringify(calls)}`);
  });
}

// What the guard must ACCEPT: a pr-looking name that is not exactly `pr<digits>`,
// a `pr<N>` that is not the last component — including behind a `.` segment,
// which collapses away without changing the last component — a `..` inside a
// name rather than as a segment, and the default scratch. Each runs the review
// to its specialist, with the run root at `<scratch>/pr42/` — one level, as
// before.
for (const scratch of ["/x/review-pr-42", "/x/pr42x", "/x/apr42", "/x/pr", "/x/prx42", "/x/pr42/root", "/x/pr42/./root", "/x/.pr42", "/x/a..b", undefined]) {
  test(`scratch ${scratch ?? "(omitted)"} is accepted and runs the review under <scratch>/pr42/`, () => withBareHome(async () => {
    const { run, calls, prompts, base } = runWith(scratch);
    await run;
    assert.equal(calls["review:correctness"], 1, "an accepted scratch must reach its specialist");
    assert.ok(
      prompts.snapshot[0].includes(`mkdir -p "${base}/pr${PR}"`),
      `the snapshot agent was not told to make the run root parent at ${base}/pr${PR}`,
    );
  }));
}

// An omitted scratch is a review with no dispatcher: it takes the fleet's own
// scratch root for this repository (scratch-root.mjs's answer), never a
// `/tmp/review-pr-<N>` of its own. Where that root cannot be resolved — no
// repository to key it on — the review is refused before any dispatch instead
// of falling back to some other directory.
test("an omitted scratch with no repository to key a root on is refused before any dispatch", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "review-core-norepo-")));
  const here = process.cwd();
  process.chdir(outside);
  try {
    const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [review([])] });
    await assert.rejects(runReview({ ...host, pipeline, parallel }, { ...ARGS, pr: PR, scratch: undefined }), (err) => {
      assert.match(err.message, /^review-pr: no args\.scratch, and the scratch root could not be resolved/, err.message);
      return true;
    });
    assert.deepEqual(calls, {}, `an unresolvable scratch root still dispatched: ${JSON.stringify(calls)}`);
  } finally {
    process.chdir(here);
  }
});

// The default scratch is resolved by spawning git, so it comes AFTER the argument
// guards: a missing or malformed `pr` is owed its own refusal even where no
// repository exists to key a root on.
for (const [what, args, expected] of [
  ["a missing pr", { ...ARGS, pr: undefined, scratch: undefined }, /^review-pr: args\.pr and args\.worktree are required/],
  ["a malformed pr", { ...ARGS, pr: "../x", scratch: undefined }, /^review-pr: args\.pr must be a PR number/],
]) {
  test(`${what} with an omitted scratch outside a repository is refused on the argument, not the scratch root`, async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "review-core-norepo-args-")));
    const here = process.cwd();
    process.chdir(outside);
    try {
      const { host, calls } = scriptedHost({ snapshot: [SNAP], "review:correctness": [review([])] });
      await assert.rejects(runReview({ ...host, pipeline, parallel }, args), (err) => {
        assert.match(err.message, expected, err.message);
        return true;
      });
      assert.deepEqual(calls, {});
    } finally {
      process.chdir(here);
    }
  });
}

// A given scratch is held to the omitted one's rule: inside a git work tree that
// does not ignore it, it is refused before any dispatch; where the work tree
// ignores it, it runs. The same scratch with nothing to ignore it is the control
// that the second case is the ignore rule's doing.
test("an explicit scratch inside a work tree that does not ignore it is refused before any dispatch", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "review-core-explicit-")));
  assert.equal(spawnSync("git", ["init", "-q", repo], { env: gitEnv() }).status, 0);
  const { run, calls } = runWith(join(repo, "scr"));
  await assert.rejects(run, (err) => {
    assert.match(err.message, /^review-pr: args\.scratch: scratch root .* is inside the git work tree .*, which does not ignore it/, err.message);
    return true;
  });
  assert.deepEqual(calls, {}, `a refused scratch still dispatched: ${JSON.stringify(calls)}`);
});

test("an explicit scratch inside a work tree that ignores it runs the review", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "review-core-explicit-ignored-")));
  assert.equal(spawnSync("git", ["init", "-q", repo], { env: gitEnv() }).status, 0);
  writeFileSync(join(repo, ".gitignore"), "scr/\n");
  const { run, calls } = runWith(join(repo, "scr"));
  await run;
  assert.equal(calls["review:correctness"], 1, "an ignored scratch must reach its specialist");
});
