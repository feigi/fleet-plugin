// Every review fan-out dispatch books its cost to the PR it reviews: the label
// review-core.mjs dispatches under carries the PR, and parseMemberName reads it
// back, both off the label itself and off the member id omp derives from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "./review-core.mjs";
import { parseMemberName } from "./member-record.mjs";
import { ARGS, SNAP, pipeline, parallel, review, finding, vote, scriptedHost } from "./review-host-fixture.mjs";

// omp's member id for a labelled dispatch: every character outside
// [A-Za-z0-9_-] deleted, capped at 48, and `-<n>` appended from the second
// dispatch of the same label on.
const ompId = (label, nth = 1) => {
  const id = label.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
  return nth === 1 ? id : `${id}-${nth}`;
};

test("every dispatch of one review is labelled with its PR, and each label books to that PR", async () => {
  const { host, labels } = scriptedHost({
    snapshot: [SNAP],
    "review:correctness": [review([finding("critical")])],
    "verify:correctness": [vote(false)],
  });
  await runReview({ ...host, pipeline, parallel }, ARGS);

  const kinds = new Set(labels.map((l) => l.replace(/:pr\d+$/, "")));
  assert.deepEqual([...kinds].sort(), ["review:correctness", "snapshot", "test-run", "verify:correctness"],
    "the review no longer dispatches every kind this test books");
  for (const label of labels) {
    assert.match(label, new RegExp(`:pr${ARGS.pr}$`), `${label} does not carry its PR`);
    for (const name of [label, ompId(label), ompId(label, 2), `review-pr-${ARGS.pr}/${ompId(label, 3)}`]) {
      assert.deepEqual(parseMemberName(name), { ticket: "", pr: String(ARGS.pr) }, name);
    }
  }
});
