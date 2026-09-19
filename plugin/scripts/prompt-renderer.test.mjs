// #1552. prompt-renderer.mjs's `workflowCode()` runs the file it reads through
// `stripComments()` before extraction — its own header comment (lines 17-21)
// documents this as the defense against a block-commented dead `agent()` call
// being extracted and rendered as live text, the exact vacuity class
// strip-comments.mjs exists for (measured twice on review-pr.js before this
// module existed, per the comment above `workflowCode`). Nothing pinned that
// wrapper: review-pr-refuter-scratch.test.mjs, review-pr-specialist-scratch
// .test.mjs and injection-control-prose.test.mjs all extract from
// `workflows/review-pr.js`, which carries no dead duplicate today, so none of
// them can red if the `stripComments()` call is dropped. This file pins the
// guard directly with a synthetic fixture, once, for all three consumers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promptRenderer, workflowCode } from "./prompt-renderer.mjs";

const REPO = join(import.meta.dirname, "..");

// A dead `agent()` call, block-commented on one line (matching
// strip-comments.mjs's line-based stripping), sits BEFORE the live one — the
// same first-occurrence hazard `between()`'s "no longer contains" pin never
// catches, since the dead text satisfies indexOf just as well as the live
// text and comes first.
const TEMPLATE_START = "`Try to REFUTE this finding from PR #";
const TEMPLATE_END = "{ label: `verify:";
const FIXTURE = [
  "/* agent(`Try to REFUTE this finding from PR #999`, { label: `verify:dead` }); */",
  "agent(`Try to REFUTE this finding from PR #1`, { label: `verify:live` });",
  "",
].join("\n");

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "prompt-renderer-test-"));
  try {
    const file = join(dir, "fixture-workflow.js");
    writeFileSync(file, FIXTURE, "utf8");
    return fn(relative(REPO, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("workflowCode() strips a block-commented dead call before extraction, so a stale earlier occurrence cannot win", () => {
  withFixture((relFile) => {
    const code = workflowCode(relFile);
    assert.ok(!code.includes("PR #999"), "the block-commented dead PR #999 call survived stripComments() — extraction would prefer it over the live call below it");
    assert.ok(code.includes("PR #1"), "the live PR #1 call was stripped along with the dead comment — stripComments() over-blanked");
  });
});

test("promptRenderer() renders the live occurrence, not a block-commented dead one that appears first", () => {
  withFixture((relFile) => {
    const RENDER = promptRenderer({
      file: relFile,
      start: TEMPLATE_START,
      end: TEMPLATE_END,
      scope: [],
      what: "fixture template",
    });
    assert.equal(
      RENDER(),
      "Try to REFUTE this finding from PR #1",
      "promptRenderer() extracted the block-commented dead template instead of the live one — workflowCode() is no longer stripping comments before extraction",
    );
  });
});
