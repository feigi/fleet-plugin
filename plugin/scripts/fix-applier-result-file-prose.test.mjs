// #1802 (spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 3 §4,
// §8). The fix-applier now reads the review off `<scratch>/review-<pr>.json`
// and owns every per-PR ruling the controller used to make before dispatch —
// both mutual-exclusion scans, the suggested-fix re-derivation, `refuted=false`
// ≠ apply, per-site measurement for a sibling-site extension, and reading
// `testEnvironment`/`cwdAudit` before acting on a `test_run`. Their new home is
// review-and-fix.md's `## The review result file`, which is the copy the
// fix-applier reads. The controller-side copies in run-team/SKILL.md are due to
// be retired once the controller stops making these rulings (§ 8), and a
// retirement that loses the destination copy too would leave the rulings made
// by nobody, with every pin that read SKILL.md simply deleted alongside it.
//
// Two halves. The recipes half is not prose: a `jq` path naming a field the
// result does not carry prints `null` at exit 0, which reads exactly like an
// empty bucket — so every top-level field the recipes read is checked against
// the keys the review really returns (DIGEST_KEYS + the bulk arrays, the order
// review-in-run-retry.test.mjs holds both review bodies to by running them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";
import { DIGEST_KEYS } from "./review-core.js";

const REPO = join(import.meta.dirname, "..");
const DOC = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
const RESULT_KEYS = new Set([...DIGEST_KEYS, "snapshot", "survived", "refuted", "unverified"]);

const section = () => between(DOC, "\n## The review result file\n", "\n## Specialists\n", "review-and-fix.md's result-file section");
const ruling = (lead) => {
  // One paragraph per ruling: the document writes one line per paragraph, so
  // the paragraph is the line the bold lead-in opens.
  const line = section().split("\n").find((l) => l.startsWith(lead));
  assert.ok(line, `review-and-fix.md's result-file section no longer opens a paragraph with ${JSON.stringify(lead)}`);
  return line;
};

test("the fix-applier reads the review off the result file, at the path the runner and the controller write", () => {
  assert.match(section(), phrase("`<scratch>/review-<pr>.json`"));
  // Step 1's fix-applier branch is what sends a fix-applier here at all.
  const step1 = between(DOC, "1. Run the review yourself.", "\n2. Plan the actions.", "review-and-fix.md step 1");
  assert.match(step1, phrase("see **The review result file**"), "step 1 no longer points a fix-applier at the result file");
});

test("every top-level field the jq recipes read is a field the review returns", () => {
  const recipes = section().match(/^jq .*$/gm) ?? [];
  assert.ok(recipes.length >= 5, `found ${recipes.length} jq recipes — the section lost its reading recipes`);
  const read = new Set();
  for (const line of recipes) {
    const program = line.match(/'([^']*)'/)?.[1];
    assert.ok(program, `a jq recipe has no single-quoted program: ${line}`);
    // A projection `{a, b}` reads each name; otherwise the program's first
    // path segment is the field it reads (`.survived`, `[.unverified[] | ...`).
    const projection = program.match(/^\{([^}]*)\}$/);
    if (projection) for (const k of projection[1].split(",")) read.add(k.trim());
    else read.add(program.match(/\.(\w+)/)[1]);
  }
  for (const field of read) {
    assert.ok(RESULT_KEYS.has(field), `a jq recipe reads .${field}, which the review result does not carry — it would print null at exit 0`);
  }
  // Both inputs every other ruling depends on must actually be read.
  for (const field of ["survived", "unverified", "refuted", "counts", "testEnvironment", "cwdAudit", "dimensionsUnrun", "resume"]) {
    assert.ok(read.has(field), `no jq recipe reads .${field}`);
  }
});

test("the crash populations are told apart off refutersDispatched in the recipes, never off severity", () => {
  const recipes = (section().match(/^jq .*$/gm) ?? []).join("\n");
  assert.match(recipes, /select\(\.refutersDispatched > 0\)/);
  assert.match(recipes, /select\(\.refutersDispatched == 0\)/);
});

test("the fix-applier owns the mutual-exclusion scan, run twice, with a single refuter for a conflicting pair", () => {
  const p = ruling("**Scan the findings against each other for MUTUAL EXCLUSION");
  assert.match(p, phrase("run it twice"));
  assert.match(p, phrase("**Before you apply anything**"));
  assert.match(p, phrase("**Then as each refuter you dispatch reports**"));
  assert.match(p, phrase("**A conflicting pair goes to a SINGLE refuter, briefed with both claims**"));
});

test("the fix-applier owns the suggested-fix re-derivation, ordered so the tree to derive from exists", () => {
  const p = ruling("**A finding whose suggested fix quotes text another applied finding deletes");
  assert.match(p, phrase("**Re-derive, never copy:**"));
  assert.match(p, phrase("apply the finding that changes the text first"));
});

test("the fix-applier owns refuted=false ≠ apply, and per-site measurement for a sibling-site extension", () => {
  assert.match(ruling("**A `refuted=false` verdict is not an instruction to apply.**"), phrase("is a defer"));
  assert.match(
    ruling("**Extending a finding to sibling sites is a new claim at every added site"),
    phrase("never on a copied one"),
  );
});

test("the fix-applier reads testEnvironment and cwdAudit before acting on any test_run, and re-runs nothing", () => {
  const p = ruling("**Read `testEnvironment` and `cwdAudit` before you act on any `test_run`.**");
  assert.match(p, phrase("status --porcelain -uall"), "the cwdAudit check lost its explicit untracked mode");
  assert.match(p, phrase("never revert content you did not write"));
  assert.match(p, phrase("re-run nothing"), "a dimensionsUnrun entry now reads as an instruction to re-run the review");
});
