// #2323. `runReview` owns the review side's `pr<N>/` partition: it appends
// `/pr${pr}` to the scratch it is given. A caller that already did so (the
// run-team skill once read as telling the controller to pass `<scratch>/pr<N>`)
// nested every run root at `<root>/pr<N>/pr<N>/run-*`, which a correctly scoped
// review's prune never reaches. So a scratch whose LAST component is `pr`
// followed only by digits is refused before any dispatch — whatever the digits,
// trailing slash ignored — and never coerced by stripping the suffix.
//
// Driven through the real `runReview` and asserted on `calls`, for the reason
// review-core-snapshot-path.test.mjs states beside its skewed-snapshot test: a
// rejection alone does not show nothing was dispatched first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "./review-core.mjs";
import { ARGS, SNAP, pipeline, parallel, review, scriptedHost } from "./review-host-fixture.mjs";

const PR = 42;

function runWith(scratch) {
  const base = scratch === undefined ? `/tmp/review-pr-${PR}` : scratch.replace(/\/+$/, "");
  const runRoot = `${base}/pr${PR}/run-ab12`;
  const snap = { ...SNAP, runRoot, path: `${runRoot}/snapshot-abc123` };
  const { host, calls, prompts } = scriptedHost({ snapshot: [snap], "review:correctness": [review([])] });
  const args = { ...ARGS, pr: PR };
  if (scratch === undefined) delete args.scratch;
  else args.scratch = scratch;
  return { run: runReview({ ...host, pipeline, parallel }, args), calls, prompts, base };
}

for (const scratch of ["/x/pr42", "/x/pr42/", "/x/pr7", "/x/pr42//", "pr42"]) {
  test(`a scratch ending in a pr<N> directory (${scratch}) is refused before any dispatch, naming the path`, async () => {
    const { run, calls } = runWith(scratch);
    await assert.rejects(run, (err) => {
      assert.ok(err.message.includes(JSON.stringify(scratch)), `the refusal does not name the scratch it was given: ${err.message}`);
      assert.match(err.message, /scratch root/, `the refusal does not say to pass the scratch root: ${err.message}`);
      return true;
    });
    assert.deepEqual(calls, {}, `a refused scratch still dispatched: ${JSON.stringify(calls)}`);
  });
}

// What the guard must ACCEPT: a pr-looking name that is not exactly `pr<digits>`,
// a `pr<N>` that is not the last component, and the default scratch. Each runs
// the review to its specialist, with the run root at `<scratch>/pr42/` — one
// level, as before.
for (const scratch of ["/x/review-pr-42", "/x/pr42x", "/x/apr42", "/x/pr", "/x/prx42", "/x/pr42/root", undefined]) {
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
