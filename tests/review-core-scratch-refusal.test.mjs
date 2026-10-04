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
import { runReview } from "../plugin/scripts/review-core.mjs";
import { ARGS, SNAP, pipeline, parallel, review, scriptedHost } from "./support/review-host-fixture.mjs";

const PR = 42;

function runWith(scratch) {
  const base = scratch === undefined ? `/tmp/review-pr-${PR}` : scratch.replace(/\/+$/, "");
  const runRoot = `${base}/pr${PR}/run-ab12`;
  const snap = { ...SNAP, runRoot, path: `${runRoot}/snapshot-abc123` };
  const { host, calls, prompts } = scriptedHost({ snapshot: [snap], "review:correctness": [review([])] });
  return { run: runReview({ ...host, pipeline, parallel }, { ...ARGS, pr: PR, scratch }), calls, prompts, base };
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

// What the guard must ACCEPT: a pr-looking name that is not exactly `pr<digits>`,
// a `pr<N>` that is not the last component — including behind a `.` segment,
// which collapses away without changing the last component — a `..` inside a
// name rather than as a segment, and the default scratch. Each runs the review
// to its specialist, with the run root at `<scratch>/pr42/` — one level, as
// before.
for (const scratch of ["/x/review-pr-42", "/x/pr42x", "/x/apr42", "/x/pr", "/x/prx42", "/x/pr42/root", "/x/pr42/./root", "/x/.pr42", "/x/a..b", undefined]) {
  test(`scratch ${scratch ?? "(omitted)"} is accepted and runs the review under <scratch>/pr42/`, async () => {
    const { run, calls, prompts, base } = runWith(scratch);
    await run;
    assert.equal(calls["review:correctness"], 1, "an accepted scratch must reach its specialist");
    assert.ok(
      prompts.snapshot[0].includes(`mkdir -p "${base}/pr${PR}"`),
      `the snapshot agent was not told to make the run root parent at ${base}/pr${PR}`,
    );
  });
}
