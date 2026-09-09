import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

// #1349 (per #1303's gap 3): no `agent()` call anywhere in the review port —
// Claude's workflows/review-pr.js, the shared scripts/review-core.js, or the
// omp shim scripts/review-eval.mjs — may pass `model` or `effort` directly.
// Measured on omp: `agent(prompt, {model, effort})` silently resolves to the
// baseline model, zero effect, no error. Every dispatch instead names a
// fleet-owned definition whose OWN frontmatter carries the tier. This file is
// the general-purpose guard review-core-parity.test.mjs and
// select-dimensions.test.mjs's dispatch-shape pins do not generalize: those
// pin SPECIFIC call sites; this one finds every `agent(` call in the audited
// files and inspects its options object directly, so a NEW call site added
// later is covered without anyone remembering to extend a list.
const REPO = join(import.meta.dirname, "..");
const FILES = {
  "workflows/review-pr.js": readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8"),
  "scripts/review-core.js": readFileSync(join(REPO, "scripts", "review-core.js"), "utf8"),
  "scripts/review-eval.mjs": readFileSync(join(REPO, "scripts", "review-eval.mjs"), "utf8"),
};

// Every `agent(` call site's own options-object text, brace-balanced from the
// FIRST `{` after the call's opening paren to its matching close. Comments
// stripped first so a commented-out `model:` cannot satisfy or defeat this —
// the same policy every other pin in this directory takes with `stripComments`
// (review-pr-reads.test.mjs's header explains the measured reason).
function agentCallOptionBlocks(code) {
  const blocks = [];
  const callRe = /\bagent\(/g;
  let m;
  while ((m = callRe.exec(code))) {
    // Find the options object: the first top-level `{` after the call opens,
    // skipping over the prompt argument (a template literal or string, which
    // may itself contain `{`/`}` — e.g. `${d.key}` interpolations). Track
    // paren depth so a nested `agent(...)` inside a prompt string is not
    // mistaken for this call's own close.
    let i = callRe.lastIndex;
    let depth = 1; // the `(` this call just opened
    let inTemplate = 0; // nesting depth of backtick template literals
    let braceStart = -1;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === "`") inTemplate = inTemplate ? inTemplate - 1 : inTemplate + 1;
      if (inTemplate) continue;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "{" && braceStart === -1 && depth === 1) braceStart = i;
    }
    if (braceStart !== -1) {
      // Brace-balance from braceStart to find the matching `}`.
      let bd = 0, j = braceStart;
      for (; j < code.length; j++) {
        if (code[j] === "{") bd++;
        else if (code[j] === "}") { bd--; if (bd === 0) { j++; break; } }
      }
      blocks.push(code.slice(braceStart, j));
    }
  }
  return blocks;
}

test("agentCallOptionBlocks finds every options object and stops at its own close", () => {
  const sample = 'x = agent(`hi ${a.b}`, { label: "a", schema: S1 }); y = agent("p2", { label: "b" });';
  const blocks = agentCallOptionBlocks(sample);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /label: "a"/);
  assert.doesNotMatch(blocks[0], /label: "b"/);
  assert.match(blocks[1], /label: "b"/);
});

// Mutation-tested: this must RED the moment a `model`/`effort` key is
// reintroduced anywhere in an audited file's `agent(` call, and must NOT red
// on a comment mentioning either word (review-pr.js's own removal comments
// say "model"/"effort" repeatedly, by design).
for (const [name, source] of Object.entries(FILES)) {
  test(`${name}: no agent() call carries model or effort`, () => {
    const code = stripComments(source);
    const blocks = agentCallOptionBlocks(code);
    assert.ok(blocks.length > 0, `${name}: no agent( call found at all — update this test if the file's shape changed`);
    for (const block of blocks) {
      assert.doesNotMatch(block, /\bmodel\s*:/, `${name}: an agent() call carries \`model\` — #1349 forbids this entirely`);
      assert.doesNotMatch(block, /\beffort\s*:/, `${name}: an agent() call carries \`effort\` — #1349 forbids this entirely`);
    }
  });
}

// The mutation check, run directly against a synthetic mutant rather than
// against the real files (which must stay clean): confirms the checker
// itself actually catches the shape it claims to.
test("the checker reds on a synthetic mutation that reintroduces model/effort", () => {
  const mutant = 'const snap = await agent(prompt, { label: "snapshot", model: "haiku", schema: S });';
  const blocks = agentCallOptionBlocks(stripComments(mutant));
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /\bmodel\s*:/);
  const mutant2 = 'const v = await agent(prompt, { label: "verify", effort: "low", schema: S });';
  const blocks2 = agentCallOptionBlocks(stripComments(mutant2));
  assert.match(blocks2[0], /\beffort\s*:/);
});

// The counterpart to the mutation check: a call carrying `agentType`/`agent`
// (the legitimate dispatch lever) must NOT be flagged — a checker that reds
// on everything is not a check.
test("the checker does not false-positive on a legitimate agentType/agent dispatch", () => {
  const clean = 'const r = await agent(prompt, { label: "review:x", agentType: "fleet-ctl:fleet-review-correctness", schema: S });';
  const blocks = agentCallOptionBlocks(stripComments(clean));
  assert.doesNotMatch(blocks[0], /\bmodel\s*:/);
  assert.doesNotMatch(blocks[0], /\beffort\s*:/);
});
