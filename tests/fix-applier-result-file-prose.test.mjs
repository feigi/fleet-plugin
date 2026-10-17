// #1802 (spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 3 §4,
// §8). The fix-applier now reads the review off `<scratch>/pr<pr>/<run>/review.json`
// and owns every per-PR ruling the controller used to make before dispatch —
// both mutual-exclusion scans, the suggested-fix re-derivation, `refuted=false`
// ≠ apply, per-site measurement for a sibling-site extension, and reading
// `testEnvironment`/`cwdAudit` before acting on a result of the shared test
// run. Their new home is review-and-fix.md's `## The review result file`, which
// is the copy the fix-applier reads. The controller-side copies in
// run-team/SKILL.md are due to be retired once the controller stops making
// these rulings (§ 8), and a retirement that loses the destination copy too
// would leave the rulings made by nobody, with every pin that read SKILL.md
// simply deleted alongside it.
//
// Two halves. The recipes half is not prose: a `jq` path naming a field the
// result does not carry prints `null` at exit 0, which reads exactly like an
// empty bucket — so every top-level field the recipes read is checked against
// the keys the review really returns (DIGEST_KEYS + the bulk arrays, the order
// review-in-run-retry.test.mjs holds both review bodies to by running them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { DIGEST_KEYS } from "../plugin/scripts/review-core.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const DOC = Pin.file(join(REPO, "commands", "review-and-fix.md"));
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));
const RESULT_KEYS = new Set([...DIGEST_KEYS, "snapshot", "survived", "refuted", "unverified"]);

const ruling = (lead) => {
  // One paragraph per ruling: the document writes one line per paragraph, so
  // the paragraph is the line the bold lead-in opens.
  const line = DOC.section("## The review result file", "review-and-fix.md's result-file section").text.split("\n").find((l) => l.startsWith(lead));
  assert.ok(line, `review-and-fix.md's result-file section no longer opens a paragraph with ${JSON.stringify(lead)}`);
  return line;
};

test("the fix-applier reads the review off the result file, at the path the runner and the controller write", () => {
  assert.match(DOC.section("## The review result file", "review-and-fix.md's result-file section").text, Pin.phrase("`<scratch>/pr<pr>/<run>/review.json`"));
  // Step 1's fix-applier branch is what sends a fix-applier here at all.
  const step1 = DOC.between("1. Run the review yourself.", "\n2. Plan the actions.", "review-and-fix.md step 1").text;
  assert.match(step1, Pin.phrase("see **The review result file**"), "step 1 no longer points a fix-applier at the result file");
});

test("every top-level field the jq recipes read is a field the review returns", () => {
  const recipes = DOC.section("## The review result file", "review-and-fix.md's result-file section").text.match(/^jq .*$/gm) ?? [];
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
  for (const field of ["survived", "unverified", "refuted", "counts", "testEnvironment", "suiteVerdict", "cwdAudit", "dimensionsUnrun", "resume"]) {
    assert.ok(read.has(field), `no jq recipe reads .${field}`);
  }
});

test("the crash populations are told apart off refutersDispatched in the recipes, never off severity", () => {
  const recipes = (DOC.section("## The review result file", "review-and-fix.md's result-file section").text.match(/^jq .*$/gm) ?? []).join("\n");
  assert.match(recipes, /select\(\.refutersDispatched > \(\.refutersInconclusive \/\/ 0\)\)/);
  assert.match(recipes, /select\(\.refutersDispatched > 0 and \.refutersDispatched == \.refutersInconclusive\)/);
  assert.match(recipes, /select\(\.refutersDispatched == 0\)/);
});

// The recipes' comments are prose no ruling paragraph's pin reads. The one on
// the testEnvironment recipe says what that field is evidence about: the
// review's one shared test run, which no specialist returns a copy of, so no
// recipe comment names a specialist `test_run` field that no longer exists.
test("the testEnvironment recipe calls it evidence about the shared test run, and no recipe comment names a test_run field", () => {
  const recipes = DOC.section("## The review result file", "review-and-fix.md's result-file section").text.match(/^jq .*$/gm) ?? [];
  const line = recipes.find((l) => l.startsWith("jq -r '.testEnvironment' "));
  assert.ok(line, "the result-file section no longer has a `jq -r '.testEnvironment'` recipe");
  assert.match(line, Pin.phrase("# what the shared test run is evidence about"), "the testEnvironment recipe's comment no longer names the shared test run");
  // Every line of every fenced recipe block, not only the `jq ` ones: the `R=`
  // line and any other line the block grows carry comments too.
  const fenced = [...DOC.section("## The review result file", "review-and-fix.md's result-file section").text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].flatMap((m) => m[1].split("\n"));
  assert.ok(fenced.length > 0, "the result-file section lost its fenced recipe block");
  for (const l of fenced) assert.doesNotMatch(l, /test_run/i, `a recipe line names the retired test_run field: ${l}`);
});

// #3048: the suite verdict has a recipe of its own, and the digest recipe
// projects it, so a fix-applier reads it where it reads the rest of the digest.
test("the result-file section reads suiteVerdict in the digest and in a recipe of its own", () => {
  const recipes = DOC.section("## The review result file", "review-and-fix.md's result-file section").text.match(/^jq .*$/gm) ?? [];
  const digest = recipes.find((l) => l.includes("# the digest"));
  assert.ok(digest, "the result-file section no longer has the digest recipe");
  assert.match(digest, /\{pr, head, resume, testEnvironment, suiteVerdict, dimensionsRun, dimensionsUnrun, cwdAudit, counts\}/, "the digest recipe does not project suiteVerdict in digest order");
  assert.ok(recipes.some((l) => l.startsWith("jq -r '.suiteVerdict' ")), "the result-file section no longer has a `jq -r '.suiteVerdict'` recipe");
});

test("the fix-applier owns the mutual-exclusion scan, run twice, with a single refuter for a conflicting pair", () => {
  const p = ruling("**Scan the findings against each other for MUTUAL EXCLUSION");
  assert.match(p, Pin.phrase("run it twice"));
  assert.match(p, Pin.phrase("**Before you apply anything**"));
  assert.match(p, Pin.phrase("**Then as each refuter you dispatch reports**"));
  assert.match(p, Pin.phrase("**A conflicting pair goes to a SINGLE refuter, briefed with both claims**"));
});

test("the fix-applier owns the suggested-fix re-derivation, ordered so the tree to derive from exists", () => {
  const p = ruling("**A finding whose suggested fix quotes text another applied finding deletes");
  assert.match(p, Pin.phrase("**Re-derive, never copy:**"));
  assert.match(p, Pin.phrase("apply the finding that changes the text first"));
});

test("the fix-applier owns refuted=false ≠ apply, and per-site measurement for a sibling-site extension", () => {
  assert.match(ruling("**A `refuted=false` verdict is not an instruction to apply.**"), Pin.phrase("is a defer"));
  assert.match(
    ruling("**Extending a finding to sibling sites is a new claim at every added site"),
    Pin.phrase("never on a copied one"),
  );
});

test("the fix-applier reads testEnvironment and cwdAudit before acting on any result of the shared test run, and re-runs nothing", () => {
  const p = ruling("**Read `testEnvironment` and `cwdAudit` before you act on any result of the shared test run.**");
  assert.match(p, Pin.phrase("status --porcelain -uall"), "the cwdAudit check lost its explicit untracked mode");
  assert.match(p, Pin.phrase("never revert content you did not write"));
  assert.match(p, Pin.phrase("re-run nothing"), "a dimensionsUnrun entry now reads as an instruction to re-run the review");
});

// #3048: an unusable shared run is named in the verdict and nothing more — the
// fix-applier's own `<testCmd>` run and CI cover the suite — and it is never a
// reason to call a dimension unrun, which only a crashed specialist is.
test("the fix-applier names an unusable shared test run in its verdict and does nothing more about it, and never rules a dimension unrun for it", () => {
  const p = ruling("**Read `testEnvironment` and `cwdAudit` before you act on any result of the shared test run.**");
  assert.match(p, Pin.phrase("`suiteVerdict.usable` is false, name `shared test run not usable: <reason>` in your final verdict and do nothing more about it"));
  assert.match(p, Pin.phrase("your own `<testCmd>` run and CI cover the suite"));
  assert.doesNotMatch(p, /not a reason to rule a dimension unrun/, "the testEnvironment clause about ruling a dimension unrun for the shared run is back");
  assert.match(p, Pin.phrase("A `dimensionsUnrun` entry is a specialist that returned nothing"));
});

// The two run-team/SKILL.md sentences that hand the fix-applier the same ruling
// were reworded off the specialists' retired `test_run` field (#2374), and
// nothing read either one. They go with the rest of the SKILL.md copies (§ 8).
test("run-team's digest paragraph tells the controller the fix-applier reads testEnvironment before acting on any count from the shared test run", () => {
  const p = RUN_TEAM.paragraph(
    "`testEnvironment` says what the review's shared test run is evidence about",
    "run-team/SKILL.md's testEnvironment digest paragraph",
    "**`dimensionsRun` is the dispatch; `dimensionsUnrun` is",
    { emphasisTolerant: true },
  ).text;
  assert.match(
    p,
    Pin.phrase("fix-applier reads it before acting on any count from the shared test run"),
    "the digest paragraph no longer says the fix-applier reads testEnvironment before acting on a count from the shared test run",
  );
});

test("run-team's fix-applier dispatch hands it testEnvironment and cwdAudit before any result of the shared test run", () => {
  const p = RUN_TEAM.between(
    "\n**Then dispatch a fix-applier** — on `DISPATCH fix-pr PR#<M>`",
    "\n**A `DISPATCH fix-pr PR#<M>` on a conflict hold**",
    "run-team/SKILL.md's fix-applier dispatch paragraph",
  ).text;
  assert.match(
    p,
    Pin.phrase("`testEnvironment`/`cwdAudit` before any result of the shared test run."),
    "the fix-applier dispatch paragraph no longer says to read testEnvironment/cwdAudit before a result of the shared test run",
  );
});
