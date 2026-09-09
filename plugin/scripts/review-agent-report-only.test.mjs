import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Review finding on #1349's PR (#1361): "Say read-only" in
// commands/review-and-fix.md was scoped to a false premise — NONE of the
// six `fleet-review-*` specialist definitions restricts tool access in its
// frontmatter (a `.agent.md` prompt saying "report only" is instruction, not
// enforcement), so a hand-dispatched agent, named or general-purpose, always
// carries write tools it must not use. Fixed there (the rule is
// unconditional again); this pins the OTHER half — every one of the six
// review-dimension prompts states the constraint explicitly, so a reader of
// the prompt alone (not just the command doc) sees it too.
const REPO = join(import.meta.dirname, "..");
const SPECIALISTS = ["correctness", "silent-failure", "tests", "comments", "types", "simplify"];

for (const key of SPECIALISTS) {
  test(`fleet-review-${key}.agent.md states report-only, never edit/commit/push`, () => {
    const text = readFileSync(join(REPO, "agents", `fleet-review-${key}.agent.md`), "utf8");
    assert.match(text, /Report only; never edit, commit or push\./);
  });
}

// The snapshot and verifier dispatches are NOT specialists in this sense —
// snapshot's whole job is a fixed shell script the caller already bounds
// (`Do not modify ${worktree}` is in review-pr.js's own prompt, not the
// agent's), and verifier is a refuter whose job is verification commands in
// its own scratch directory, never the checkout. Neither belongs in the six
// above; this documents the exclusion is deliberate rather than an oversight
// a future reader "fixes" by adding a ninth/tenth match here.
test("the exclusion is exactly the six review-dimension specialists, not all eight definitions", () => {
  assert.equal(SPECIALISTS.length, 6);
  assert.ok(!SPECIALISTS.includes("snapshot") && !SPECIALISTS.includes("verifier"));
});

// commands/review-and-fix.md's own rule must be unconditional again — no
// carve-out for a "by design" fleet-review-* exemption that isn't true.
test("review-and-fix.md's read-only rule is unconditional, not scoped to general-purpose hand-dispatch only", () => {
  const text = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
  const bullet = text.split("\n").find((l) => l.includes("**Say read-only.**"));
  assert.ok(bullet, "the Say read-only bullet is gone");
  assert.match(bullet, /No `fleet-review-\*` definition's frontmatter restricts tool access/);
  assert.doesNotMatch(
    bullet,
    /is a report-only specialist by design/,
    "the bullet still claims fleet-review-* dispatches are enforced report-only, which no frontmatter actually does",
  );
});
