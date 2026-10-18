// The Recipe cache records `uncovered`: the merge-gating CI steps neither its
// Test entrypoint nor its Check step runs. The review's snapshot agent reads it through
// derive-testcmd.sh beside the `install` and `test` reads, and the payload's
// `testEnvironment` — the same note every specialist and refuter prompt
// carries — names each step with its reason on one line, so a green review
// says what it did not run. An empty list adds nothing; a list the agent could
// not read is said so rather than read as an empty one.
//
// Zero deps: `node --test tests/review-core-uncovered.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIGEST_KEYS, environmentNote, runReview, SNAPSHOT_SCHEMA } from "../plugin/scripts/review-core.mjs";
import { ARGS, SNAP, finding, parallel, pipeline, review, scriptedHost, vote } from "./support/review-host-fixture.mjs";
import { stripComments } from "./support/strip-comments.mjs";
import { Pin } from "./support/prose-pin.mjs";

const CODE = stripComments(readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "review-core.mjs"), "utf8"));

const LIST = [
  { step: "integration-docker", reason: "needs a Docker daemon this host lacks" },
  { step: "test:hooks", reason: "a second runner config;\nno one invocation runs both" },
];
const LEFT_OUT = { ...SNAP, uncovered: JSON.stringify(LIST) };
const linesAbout = (note) => note.split("\n").filter((l) => /merge-gating CI steps/.test(l));

test("environmentNote renders a non-empty list as one line naming every step and its reason", () => {
  const lines = linesAbout(environmentNote(LEFT_OUT));
  assert.equal(lines.length, 1, "the uncovered steps are not on exactly one line");
  const [line] = lines;
  assert.match(line, /^The Recipe's Test entrypoint and Check step do not run these merge-gating CI steps, and nothing in this review ran them: /);
  assert.ok(line.includes("integration-docker (needs a Docker daemon this host lacks)"), line);
  assert.ok(line.includes("test:hooks (a second runner config; no one invocation runs both)"), `a reason's own newline split the line: ${line}`);
});

// The accept case: a Test entrypoint and Check step that run every merge-gating
// CI step add nothing, so the note reads exactly as it did before the field existed.
test("environmentNote appends nothing for an empty list", () => {
  const note = environmentNote({ repoVerified: true, uncovered: "[]" });
  assert.deepEqual(linesAbout(note), []);
  assert.match(note, /about\nthe PR\.$/, "an empty list appended something after the environment note");
});

test("environmentNote says when the list could not be read, never reading it as empty", () => {
  const refused = environmentNote({ repoVerified: true, uncoveredError: "derive-testcmd: the Recipe cache at /r/.fleet/recipe.json is unusable:\n`uncovered` is not a list" });
  assert.deepEqual(linesAbout(refused), [
    "Which merge-gating CI steps neither the Recipe's Test entrypoint nor its Check step runs could not be read (derive-testcmd: the Recipe cache at /r/.fleet/recipe.json is unusable: `uncovered` is not a list), so a passing run here is not known to cover them.",
  ]);
  for (const [snap, why] of [
    [{ repoVerified: true }, /could not be read \(the snapshot agent reported nothing for it\)/],
    [null, /could not be read \(the snapshot agent reported nothing for it\)/],
    [{ repoVerified: true, uncovered: "not json" }, /could not be read \(it reported "not json", not a list of steps\)/],
    [{ repoVerified: true, uncovered: '{"step":"a","reason":"b"}' }, /could not be read \(it reported .*, not a list of steps\)/],
    [{ repoVerified: true, uncovered: '[{"step":"a"}]' }, /could not be read \(it reported .*, not a list of steps\)/],
  ]) {
    const lines = linesAbout(environmentNote(snap));
    assert.equal(lines.length, 1, JSON.stringify(snap));
    assert.match(lines[0], why, JSON.stringify(snap));
  }
});

test("the uncovered line reaches the payload's testEnvironment and every specialist and refuter prompt", async () => {
  const run = scriptedHost({
    snapshot: [LEFT_OUT],
    "review:correctness": [review([finding("critical")])],
    "verify:correctness": [vote(false)],
  });
  const result = await runReview({ ...run.host, pipeline, parallel }, { ...ARGS, dimensions: ["correctness"] });
  const [line] = linesAbout(environmentNote(LEFT_OUT));
  assert.ok(result.testEnvironment.split("\n").includes(line), "the payload's testEnvironment does not carry the uncovered line");
  assert.ok(run.prompts["review:correctness"][0].includes(line), "the specialist prompt does not carry the uncovered line");
  assert.ok(run.prompts["verify:correctness"].length > 0, "no refuter was dispatched");
  for (const p of run.prompts["verify:correctness"]) assert.ok(p.includes(line), "a refuter prompt does not carry the uncovered line");
  assert.ok(!DIGEST_KEYS.includes("uncovered"), "the uncovered list became a digest key of its own");
});

// `additionalProperties: false` drops an undeclared field silently, so the
// prompt asking for it and the schema declaring it are pinned together.
test("the snapshot agent reads `uncovered` through derive-testcmd.sh and the schema declares it", () => {
  const snapshot = Pin.of(CODE, "CODE").between("const snap = await agent(", "if (snap) {", "the snapshot agent dispatch").text;
  assert.match(snapshot, /~\/\.fleet\/bin\/fleet-run derive-testcmd\.sh \$\{worktree\} uncovered/);
  const B = "\\\\?`";
  assert.match(snapshot, new RegExp(`Report\\s+${B}uncovered${B}\\s*=\\s*its\\s+stdout,\\s+one\\s+line\\s+of\\s+JSON\\s+copied\\s+verbatim,\\s+ONLY\\s+if\\s+it\\s+exited\\s+0`));
  assert.match(snapshot, new RegExp(`report\\s+${B}uncoveredError${B}\\s*=\\s*its\\s+stderr`));
  for (const field of ["uncovered", "uncoveredError"]) {
    assert.deepEqual(SNAPSHOT_SCHEMA.properties[field], { type: "string" }, `${field} is not declared as a string`);
    assert.ok(!SNAPSHOT_SCHEMA.required.includes(field), `${field} is required — an unread list would abort a snapshot that is otherwise good`);
  }
  assert.doesNotMatch(CODE, /recipe\.json/, "review-core.mjs reads the Recipe cache itself instead of through its one reader");
});
