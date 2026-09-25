import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, markedLine } from "./prose-pin.mjs";

// Review finding on #1349's PR (#1361): none of the three CLAUDE:/OMP: marked
// pairs this port introduced was actually pinned — a same-rule pair must
// differ ONLY in dialect tokens (CONTEXT.md § Dialect's "Pair"), and nothing
// asserted that here. This file is that pin, one per site, each carrying a
// `doesNotMatch` for the other harness's tool token per ADR 0004 — the shape
// that keeps a two-dialect rule from becoming the fat slice #1299 measured
// (22 of 33 mutations survived a section-wide pin).
const REPO = join(import.meta.dirname, "..");

test("review-and-fix.md's review-invocation pair: CLAUDE names Workflow, OMP names eval/review-eval.mjs, neither borrows the other's verb", () => {
  const text = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
  const region = between(
    text,
    "**The controller runs the workflow; everything below is the fallback for when it cannot.**",
    "'s Reviewers section owns its dispatch on both harnesses.",
    "review-and-fix.md's review-invocation pair",
  );
  const claude = markedLine(region, "CLAUDE", "review-and-fix.md review-invocation CLAUDE line");
  const omp = markedLine(region, "OMP", "review-and-fix.md review-invocation OMP line");

  assert.match(claude, phrase("Workflow({name: \"fleet-ctl:review-pr\""));
  assert.doesNotMatch(claude, /\beval\b|review-eval\.mjs|runReviewOnOmp/, "the CLAUDE line must not also carry omp's eval verb");

  assert.match(omp, phrase("eval` loading `scripts/review-eval.mjs` through the Resolver"));
  assert.match(omp, /--path review-eval\.mjs/);
  assert.match(omp, /runReviewOnOmp/);
  assert.doesNotMatch(omp, /\bWorkflow\(/, "the OMP line must not also carry Claude's Workflow verb");
});

test("review-and-fix.md's hand-dispatch name-spelling pair: CLAUDE namespaces, OMP stays bare, neither borrows the other's form", () => {
  const text = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
  const region = between(
    text,
    "hand-dispatch the six `fleet-review-*` specialists yourself, by name:",
    "See **Specialists**",
    "review-and-fix.md's hand-dispatch name-spelling pair",
  );
  const claude = markedLine(region, "CLAUDE", "review-and-fix.md hand-dispatch CLAUDE line");
  const omp = markedLine(region, "OMP", "review-and-fix.md hand-dispatch OMP line");

  assert.match(claude, /fleet-ctl:fleet-review-<key>/);
  assert.doesNotMatch(claude, /^CLAUDE: `fleet-review-<key>`/, "the CLAUDE line must not also carry omp's bare spelling as its own");

  assert.match(omp, /`fleet-review-<key>`/);
  assert.doesNotMatch(omp, /fleet-ctl:/, "the OMP line must not also carry Claude's fleet-ctl: namespace");
});

test("SKILL.md's review-invocation pair: same rule as review-and-fix.md's, restated once", () => {
  const text = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
  const region = between(
    text,
    "**You run the review yourself, once per PR. That is the default path.**",
    "Only you can run it",
    "SKILL.md review-invocation pair",
  );
  const claude = markedLine(region, "CLAUDE", "SKILL.md review-invocation CLAUDE line");
  const omp = markedLine(region, "OMP", "SKILL.md review-invocation OMP line");

  assert.match(claude, phrase("Workflow({name: \"fleet-ctl:review-pr\""));
  assert.doesNotMatch(claude, /\beval\b|review-eval\.mjs|runReviewOnOmp/, "the CLAUDE line must not also carry omp's eval verb");

  assert.match(omp, phrase("eval` loading `scripts/review-eval.mjs` through the Resolver"));
  assert.match(omp, /--path review-eval\.mjs/);
  assert.match(omp, /runReviewOnOmp/);
  assert.doesNotMatch(omp, /\bWorkflow\(/, "the OMP line must not also carry Claude's Workflow verb");
});

// review-pr.js's pair is documentary (a block comment — this file never
// executes on omp, so nothing here branches on harness at runtime; see the
// comment immediately above it for why that shape was chosen). `markedLine`
// still applies unmodified: the block comment's interior is plain text once
// isolated, and the marker grammar (`^\s*(CLAUDE|OMP): `) does not care that
// `/*`/`*/` wrap it.
test("review-pr.js's resumeFor documentary pair: CLAUDE names Workflow/resumeFromRunId, OMP names reported-not-acted-on, neither borrows the other's claim", () => {
  const text = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
  const region = between(
    text,
    "/*\nCLAUDE:",
    "\n*/\nfunction resumeFor(unverified) {",
    "review-pr.js's resumeFor documentary pair",
  );
  const claude = markedLine("CLAUDE:" + region.slice(region.indexOf("\n")), "CLAUDE", "review-pr.js resumeFor CLAUDE line");
  const omp = markedLine(region, "OMP", "review-pr.js resumeFor OMP line");

  assert.match(claude, phrase("Workflow({scriptPath, resumeFromRunId})"));
  assert.doesNotMatch(claude, /re-run|review-core\.js/i, "the CLAUDE line must not also carry omp's re-run claim");

  assert.match(omp, phrase("to be reported, not acted on"));
  assert.doesNotMatch(omp, /resumeFromRunId|Workflow\(/, "the OMP line must not also carry Claude's resumeFromRunId claim");
});

// Mutation check: confirms markedLine()/doesNotMatch actually catch a
// borrowed verb, run directly against synthetic text rather than the real
// prose (which must stay clean). Without this, "the pin exists" and "the pin
// catches the defect it claims to" are two different facts and only the
// first is verified above.
test("the pin catches a CLAUDE line that borrows OMP's verb, and vice versa", () => {
  const contaminatedClaude = 'CLAUDE: run `Workflow({name: "fleet-ctl:review-pr"})`, or fall back to eval via review-eval.mjs.\nOMP: run `eval` loading review-eval.mjs.';
  const claude = markedLine(contaminatedClaude, "CLAUDE", "synthetic");
  assert.throws(() => assert.doesNotMatch(claude, /review-eval\.mjs/), { operator: "doesNotMatch" });

  const contaminatedOmp = 'CLAUDE: run `Workflow(...)`.\nOMP: run `eval`, or `Workflow(...)` if that fails.';
  const omp = markedLine(contaminatedOmp, "OMP", "synthetic");
  assert.throws(() => assert.doesNotMatch(omp, /Workflow\(/), { operator: "doesNotMatch" });
});
