import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between, phrase } from "./prose-pin.mjs";

// #853. A workflow script whose body carries any statement BEFORE
// `export const meta` was observed absent from the workflow registry — no
// error, no warning, nothing that tells it apart from a file that was never
// written, a wrong path, or a harness that refused the construct you were
// actually probing.
//
// FOREIGN EVIDENCE, cited as observed rather than as a specification: the
// registry is the harness's, and this repo cannot settle what its loader
// guarantees. Measured against the Claude Code harness on 2026-08-23 by
// `impl-538` while implementing #538, recorded on PR #852, filed as #853. The
// `Workflow` tool's own contract states the requirement; what no document
// stated is the FAILURE MODE, silent omission rather than a load error.
//
// The behaviour is the harness's; the guard is OURS. Asserting the shape of
// our own files needs no cooperation from the loader, and the consequence
// lands on `workflows/review-pr.js`, the fleet's DEFAULT review path. A file
// that fails to register produces no red at all: the fleet falls back to the
// hand-dispatched reviewer, where dimension selection never runs and nothing
// budgets the adversarial pass, and the only symptom is a review that is
// quietly thinner — indistinguishable downstream from a review that found
// nothing.
//
// Files are DISCOVERED, never listed. A hardcoded list reproduces this
// ticket's own failure mode one level up: the workflow nobody remembered to
// add is silently uncovered, which reads exactly like a workflow that passes.
// `review-pr-reads.test.mjs`'s parse test is hardcoded to the one filename, so
// a second workflow arrives unparsed-checked; closing that is not this
// ticket's and is named as left rather than done here.
const REPO = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, "workflows");
const REVIEW_PR = readFileSync(join(WORKFLOWS, "review-pr.js"), "utf8");

// The first NON-COMMENT statement, per the rule — a leading licence block or an
// explanatory paragraph is legal and must not red. Comments are blanked by the
// shared stripper rather than skipped by a regex written here, so a `/* */`
// block spanning lines is handled the way every other pin in this directory
// handles one.
//
// Known ceiling, inherited from the stripper: a line that OPENS with `/*` is
// blanked whole, so `/* c */ export const meta = {` written on one physical
// line reds. Nothing writes that, and the failure is loud with an obvious fix
// — put the export on its own line — rather than silent, which is the trade
// this whole file exists to make.
const firstStatement = (source) => stripComments(source).split("\n").find((line) => line.trim() !== "") ?? "";

const META_FIRST = /^export\s+const\s+meta\b/;

test("every workflow file's first non-comment statement is `export const meta`", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".js"));
  // A FLOOR, not a count. `readdirSync` over an empty (or newly renamed)
  // `workflows/` yields an empty list, the loop below then inspects nothing,
  // and the test goes green having asserted over no file — which is this
  // ticket's own silent-absence defect arriving through the guard written to
  // prevent it. A pinned total is refused for the reason the derived list
  // exists: it would have to be edited every time a workflow is added, and
  // that is the step nobody remembers.
  assert.ok(
    files.length > 0,
    "no .js files found in workflows/ — this guard is asserting over nothing and would pass vacuously",
  );
  for (const f of files) {
    assert.match(
      firstStatement(readFileSync(join(WORKFLOWS, f), "utf8")),
      META_FIRST,
      `workflows/${f} has a statement before \`export const meta\` — the harness drops it from the registry silently, and nothing else in this repo would notice`,
    );
  }
});

// The other half of a shape assertion, and the sharper one: a legal file this
// matcher refuses is a false red with no way to satisfy it, and a guard that
// cannot go green gets deleted — worse than no guard.
test("the meta-first guard accepts the legal ways a workflow file can begin", () => {
  for (const [form, source] of [
    ["bare, nothing before it", "export const meta = {\n  name: 'x',\n};"],
    ["leading blank lines", "\n\n\nexport const meta = {"],
    ["a licence block comment", "/*\n * Copyright someone.\n * All rights reserved.\n */\nexport const meta = {"],
    ["a JSDoc block", "/**\n * What this workflow does.\n */\nexport const meta = {"],
    ["a run of line comments", "// why this exists\n// and a second line\nexport const meta = {"],
    ["a comment block then blank lines", "// header\n\n\nexport const meta = {"],
    ["a trailing comment on the export line", "export const meta = { // opens the meta block"],
    // A comment whose TEXT is a statement must not be read as one. This is the
    // form that made the shared stripper necessary in the first place, rather
    // than a `^(?!\s*//)` anchor written per assertion.
    ["a commented-out statement", "// const x = 1;\n/* import 'node:fs'; */\nexport const meta = {"],
    ["irregular spacing in the declaration", "export   const\tmeta={"],
  ])
    assert.match(firstStatement(source), META_FIRST, `a legal workflow file is refused: ${form}`);
});

// And the shapes it must refuse, so the acceptance list above cannot be
// satisfied by a matcher that accepts everything.
test("the meta-first guard refuses the shapes that silently drop a workflow", () => {
  for (const [form, source] of [
    ["a const before the export", "const scratch = 'x';\nexport const meta = {"],
    ["a static import before the export", "import { readFileSync } from 'node:fs';\nexport const meta = {"],
    ["a call before the export", "log('starting');\nexport const meta = {"],
    // Legal JS, still refused, and the refusal is CORRECT: settled here that a
    // `"use strict"` directive prologue compiles fine as a function body, so
    // nothing local rejects it — but it is a statement before the export, so
    // the harness's shape rule drops the file anyway. Legality is not the
    // question this guard asks.
    ['a "use strict" directive', '"use strict";\nexport const meta = {'],
    // A shebang is likewise refused, and likewise correctly. Settled with
    // `new AsyncFunction("#!/usr/bin/env node\\nconst meta = {};")`, which
    // throws `SyntaxError: Invalid or unexpected token` — the hashbang grammar
    // is only legal at the start of a Script or Module source, and a workflow
    // body is neither (the observed harness compiles it as a function body,
    // per #538). So a shebang is not a legal form here to begin with; refusing
    // it costs nothing that could have worked.
    ["a shebang", "#!/usr/bin/env node\nexport const meta = {"],
    // The export present but not FIRST, with the real one further down. A
    // matcher that searched the file instead of reading its first statement
    // would go green on exactly the file this ticket is about.
    ["the export present but preceded", "const meta2 = 1;\nexport const meta = {"],
    // And the mirror: the only `export const meta` is inside a comment. A
    // matcher run over raw source rather than stripped source accepts this.
    ["the export only inside a comment", "// export const meta = {\nconst x = 1;"],
    ["an empty file", ""],
    ["a file of only comments", "// nothing here\n"],
  ])
    assert.doesNotMatch(firstStatement(source), META_FIRST, `a dropped-from-the-registry shape is accepted: ${form}`);
});

// The prose half of #853, and the half a passing test cannot deliver: what
// cost time was not a broken workflow but a MISATTRIBUTED CAUSE, and the
// person about to repeat it is the one writing a throwaway probe — who meets
// this file's subject at the re-measure instruction in review-pr.js, not here.
// Slice-bounded at both ends, per prose-pin.mjs: a presence check over the
// whole 1200-line source stays green when the paragraph lands somewhere its
// reader never reaches.
//
// Pinned as AFFIRMATIVE MOVES rather than as a phrase about the trap. A
// synonym walks around a description; it cannot supply the instruction that
// makes the next probe sound.
test("the throwaway-probe instruction carries the silent-omission trap", () => {
  // The `//` gutter has to come off before matching, for the reason
  // `stripHashGutter` exists in prose-pin.mjs: a JS comment block wraps at
  // `//`, and `\s+` does not span one, so a pinned phrase that happens to
  // break across a line today reds on prose that says exactly the right
  // thing. Rejoined with the single space the wrap point replaced.
  const record = between(
    REVIEW_PR,
    "re-measure with a throwaway workflow",
    "The head compare below",
    "review-pr.js's sandbox record",
  )
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/\s?/, ""))
    .join(" ");
  assert.match(
    record,
    phrase("registry presence is not evidence"),
    "the record does not say what registry presence is not — a reader takes an absence as a result",
  );
  assert.match(
    record,
    phrase("any statement before `export const meta`"),
    "the shape rule itself is not stated, so the reader cannot avoid tripping it",
  );
  assert.match(
    record,
    phrase("twin with the construct under test removed"),
    "the control that caught this is not named, so the next probe has no way to detect the same trap",
  );
  assert.match(
    record,
    phrase("RUN and return a computed marker"),
    "no positive signal is offered in place of presence — the reader is told what not to trust and given no alternative",
  );
});
