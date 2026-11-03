import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// review-and-fix.md step 3, run standalone, reads the repo's own Check step and
// Test entrypoint off the Recipe cache. The cache is shared through the common
// git dir, so any worktree of the repository reads the same one; what a tree
// changes is the probes. Read with no `--at` from the PR's worktree, a PR that
// deletes, renames or de-executes the command's leading path makes the read
// refuse as an invalid Recipe cache, though the cache is fine and the command
// was proven on origin/main. So both reads name a tree and read at origin/main,
// where such a PR reads valid and its own break shows as the red run step 3
// already handles. And a refusal is told by what it is: the cache's (derive),
// origin/main not resolving (fetch), or a tool the reader needs (fix it), with
// one derivation at most: a read that still refuses after `RECIPE PROVEN` stops.
//
// derive-testcmd.test.mjs holds the reader's own behaviour under `--at`; this
// file holds that step 3 tells its reader to use it, and what to do with each
// refusal.
const REVIEW_AND_FIX = Pin.file(join(import.meta.dirname, "..", "plugin", "commands", "review-and-fix.md"));
const step3 = () => REVIEW_AND_FIX.bullet("3. **Run `checkCmd` and `testCmd` before you commit**", "\n4. **", "review-and-fix.md step 3").text;

// Every Check or Test read written out in `text`: the tree argument, the field,
// and whether `--at origin/main` follows it. Matched across a line wrap, and to
// a token boundary, so `--at origin/main-old` is a different ref.
const READ = /derive-testcmd\.sh\s+(<[^>]*>|\S+)\s+(check|test)\b(\s+--at\s+origin\/main(?![\w/-]|\.\w))?/g;
const reads = (text) => [...text.matchAll(READ)].map((m) => ({ tree: m[1], field: m[2], atOriginMain: m[3] !== undefined }));

test("the read scanner accepts a read at origin/main over a line wrap and flags every other read", () => {
  assert.deepEqual(
    reads("`derive-testcmd.sh <tree> check --at origin/main` and `derive-testcmd.sh <tree> test\n  --at origin/main`"),
    [{ tree: "<tree>", field: "check", atOriginMain: true }, { tree: "<tree>", field: "test", atOriginMain: true }],
  );
  assert.deepEqual(
    reads("`derive-testcmd.sh <repo> check` `derive-testcmd.sh <tree> test --at origin/main-old` `derive-testcmd.sh <tree> test --at HEAD` `derive-testcmd.sh <tree> install`"),
    [
      { tree: "<repo>", field: "check", atOriginMain: false },
      { tree: "<tree>", field: "test", atOriginMain: false },
      { tree: "<tree>", field: "test", atOriginMain: false },
    ],
  );
});

test("step 3's standalone reads are the Check step's and the Test entrypoint's, each at origin/main, each from the tree it names", () => {
  const step = step3();
  assert.deepEqual(
    reads(step),
    [{ tree: "<tree>", field: "check", atOriginMain: true }, { tree: "<tree>", field: "test", atOriginMain: true }],
    "step 3 reads the Check step or the Test entrypoint with no --at origin/main, or from a path it does not name, or reads a third thing",
  );
  assert.match(
    step,
    Pin.phrase("read off the repo's Recipe cache from `<tree>`, the worktree this step runs from, at `origin/main` (`derive-testcmd.sh <tree> check --at origin/main` prints the first, `derive-testcmd.sh <tree> test --at origin/main` the second; every worktree reads the one cache)."),
    "step 3 no longer defines `<tree>` as the worktree it runs from, nor says the Recipe cache is shared by every worktree",
  );
  assert.match(step, Pin.phrase("**standalone, with no dispatcher to hand you them, they are the repo's own Check step and Test entrypoint**"));
  assert.doesNotMatch(step, /derive-testcmd\.sh\s+<repo>/, "step 3 reads the Recipe through <repo>, which it does not define for a read");
});

test("step 3 tells the three refusals apart: --at fetches, exit 3 fixes the tool, and neither derives; any other exit 1 derives", () => {
  const step = step3();
  assert.match(
    step,
    Pin.phrase("refusal naming `--at` (`origin/main` does not resolve) is no cache fault, so fetch it and read again, never derive"),
    "step 3 no longer sends a refusal naming --at to a fetch with no derivation — `origin/main` not resolving is no fault of the cache",
  );
  assert.match(
    step,
    Pin.phrase("exit 3 (a tool the reader needs could not run) is an environment fault, so fix it and read again, never derive"),
    "step 3 no longer calls an exit 3 an environment fault to fix, with no derivation",
  );
  assert.match(
    step,
    Pin.phrase("any other exit 1 is a refusal about the cache, so run the Recipe derivation step first"),
    "step 3 no longer sends a refusal about the cache to the Recipe derivation",
  );
});

test("step 3 derives once: RECIPE NOT PROVEN stops, and so does a read that refuses again after RECIPE PROVEN", () => {
  const step = step3();
  assert.match(step, Pin.phrase("`RECIPE NOT PROVEN` is a stop, reported with its reason"), "step 3 no longer stops on RECIPE NOT PROVEN");
  assert.match(
    step,
    Pin.phrase("**so is a read that refuses again after `RECIPE PROVEN`, reported with that refusal**: there is no second derivation"),
    "step 3 no longer stops a read that still refuses after RECIPE PROVEN — it would loop through the derivation",
  );
  assert.match(step, Pin.phrase("Never fall back to a runner of your own choosing."));
});

// What the new reads must still ACCEPT: a PR that broke its own Check or Test
// path is a red run in the worktree, not a fault in the cache or a new branch
// of this step. The rule that handles it is the one already there.
test("step 3 adds no branch for a PR that broke its own command's path: the existing red rule covers the run", () => {
  assert.match(step3(), Pin.phrase("Red, zero-test, or either no-work count → fix it or move the finding to defer; never commit over it."));
});
