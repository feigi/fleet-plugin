// #2232 moved every test file out of `plugin/scripts/` into `tests/` (ADR
// 0019): everything under `plugin/` ships, and a test file is no part of what
// a consumer installs. Nothing about the move stops the next test file from
// landing beside the scripts again — a branch cut before the move, or habit —
// and one that does both ships and never runs, because the suite command
// `node --test tests/*.test.mjs` reads only the top level of `tests/`. So the
// rule this file holds is the suite command's own reach: every tracked
// `*.test.mjs` sits directly in `tests/`. A test file nested under
// `tests/support/` or deeper falls outside the glob the same way.
//
// repo-root.mjs's `trackedPaths`, never a directory walk, for the reason
// scripts-path-citation-sweep.test.mjs states: an untracked scratch file must
// never become a false positive.
//
// KNOWN LIMIT, same as those siblings: needs an ambient `.git` to ask what is
// tracked. Absent one, the tree check DECLINES with a reason; the predicate's
// own tests below still run.
//
// Zero deps: `node --test tests/test-location.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRoot, skipWithoutRepo, trackedPaths } from "../plugin/scripts/repo-root.mjs";

const ROOT = repoRoot(import.meta.dirname);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the test-location check over the tracked tree");
const SELF = "tests/test-location.test.mjs";

/** The paths the suite command `node --test tests/*.test.mjs` reaches: a test file directly in `tests/`. */
const IN_SUITE = /^tests\/[^/]+\.test\.mjs$/;

/** The `*.test.mjs` paths among `paths` that the suite glob `tests/*.test.mjs` does not reach. */
function misplacedTests(paths) {
  return paths.filter((path) => path.endsWith(".test.mjs") && !IN_SUITE.test(path));
}

const FILES = ROOT === null ? [] : trackedPaths(ROOT);

test("the check sees the tree it is supposed to police", { skip: SKIP_WITHOUT_REPO }, () => {
  const suite = FILES.filter((path) => IN_SUITE.test(path));
  assert.ok(
    suite.length > 100,
    `trackedPaths(ROOT) holds only ${suite.length} test files under tests/ — too few to be this repo's real suite, and the check below would pass vacuously`,
  );
  assert.ok(FILES.includes(SELF), `${SELF} is not a tracked path, so this check is not reading the tree it lives in`);
});

test("every tracked test file sits directly in tests/, where the suite command reaches it", { skip: SKIP_WITHOUT_REPO }, () => {
  const misplaced = misplacedTests(FILES);
  assert.deepEqual(
    misplaced,
    [],
    `these test files sit outside tests/'s top level, so \`node --test tests/*.test.mjs\` never runs them — and under plugin/ they ship: move each to tests/: ${misplaced.join(", ")}`,
  );
});

test("misplacedTests refuses a test file under plugin/, at the repo root, or nested under tests/", () => {
  assert.deepEqual(
    misplacedTests(["plugin/scripts/arg.test.mjs", "plugin/x.test.mjs", "arg.test.mjs", "tests/support/x.test.mjs", "tests/a/b.test.mjs"]),
    ["plugin/scripts/arg.test.mjs", "plugin/x.test.mjs", "arg.test.mjs", "tests/support/x.test.mjs", "tests/a/b.test.mjs"],
  );
});

test("misplacedTests accepts a test file directly in tests/ and every file that is not a test", () => {
  assert.deepEqual(
    misplacedTests([
      "tests/arg.test.mjs",
      "tests/support/prose-pin.mjs",
      "plugin/scripts/arg.mjs",
      "plugin/scripts/test.mjs",
      "plugin/scripts/x.test.mjs.orig",
      "docs/x.test.md",
    ]),
    [],
  );
});
