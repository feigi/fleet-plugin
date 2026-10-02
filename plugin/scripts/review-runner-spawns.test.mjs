// #2102: `fleet-review-runner.agent.md`'s `spawns` frontmatter must allow
// exactly the agent types `runReviewOnOmp` (review-core.mjs) actually
// dispatches from inside its own eval cell — omp denies every spawn by
// default, and the runner declared neither `spawns` nor `tools` until this
// fix, so every dispatch failed with `Cannot spawn '<name>'. Allowed: none`.
//
// This pin derives BOTH sides from source instead of hand-copying either:
// the declared side from the frontmatter's own `spawns:` line, the dispatched
// side from review-core.mjs's exported `SPAWNED_AGENT_TYPES` (itself derived
// from `DEFAULT_DIMENSIONS` plus the snapshot/verifier constants, not a
// second hand-copied list — see review-core.mjs's own comment on that
// export). A dimension added to `DEFAULT_DIMENSIONS` without a matching
// `spawns` entry, or a `spawns` entry that stops matching a dispatched type,
// fails this test in either direction — and so does a NAME repeated on
// either side (a duplicate `spawns` entry, or two dispatch sites colliding
// on one `agentType`), which a bare Set-vs-Set compare would otherwise
// collapse away silently (#2102 review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter-check.mjs";
import { SNAPSHOT_AGENT_TYPE, SPAWNED_AGENT_TYPES, TEST_RUN_AGENT_TYPE, VERIFIER_AGENT_TYPE } from "./review-core.mjs";

const REPO = join(import.meta.dirname, "..");
const RUNNER_PATH = join(REPO, "agents", "fleet-review-runner.agent.md");
const CORE_PATH = join(REPO, "scripts", "review-core.mjs");

function declaredSpawns() {
  const text = readFileSync(RUNNER_PATH, "utf8");
  const { fields, error } = parseFrontmatter(text);
  assert.equal(error, undefined, `fleet-review-runner.agent.md frontmatter failed to parse: ${error}`);
  const field = fields.find((f) => f.key === "spawns");
  assert.ok(field, "fleet-review-runner.agent.md declares no spawns field");
  return { field, fields };
}

test("fleet-review-runner's spawns allowlist is exactly the set runReviewOnOmp dispatches", () => {
  const { field } = declaredSpawns();
  const declaredList = field.value.split(",").map((s) => s.trim()).filter(Boolean);
  const declared = new Set(declaredList);
  assert.equal(
    declaredList.length,
    declared.size,
    `fleet-review-runner's spawns allowlist lists a name more than once: ${declaredList.join(", ")}`,
  );
  const dispatched = new Set(SPAWNED_AGENT_TYPES);
  assert.equal(
    SPAWNED_AGENT_TYPES.length,
    dispatched.size,
    "SPAWNED_AGENT_TYPES has a duplicate agentType — two of snapshot/a DEFAULT_DIMENSIONS entry/verifier are " +
      `colliding, so one would never actually dispatch under its own identity: ${SPAWNED_AGENT_TYPES.join(", ")}`,
  );
  assert.deepEqual(
    [...declared].sort(),
    [...dispatched].sort(),
    `fleet-review-runner's spawns allowlist (${[...declared].sort().join(", ")}) must equal the ` +
      `set runReviewOnOmp actually dispatches (${[...dispatched].sort().join(", ")}) — a mismatch ` +
      "either silently denies a real dispatch again or over-grants a spawn nothing needs",
  );
});

test("fleet-review-runner declares no tools: list — that would drop eval", () => {
  const { fields } = declaredSpawns();
  assert.ok(
    !fields.some((f) => f.key === "tools"),
    "fleet-review-runner.agent.md must not declare tools: — a restricted tool list would drop eval, " +
      "which the runner's whole job (running one eval cell) requires",
  );
});

test("every agent type fleet-review-runner is allowed to spawn has a definition file", () => {
  for (const name of SPAWNED_AGENT_TYPES) {
    const p = join(REPO, "agents", `${name}.agent.md`);
    assert.ok(existsSync(p), `${name} (in SPAWNED_AGENT_TYPES) has no agent definition file at ${p}`);
  }
});

test("review-core.mjs's snapshot/test-run/verifier dispatch sites reference the exported constants, not a hardcoded duplicate", () => {
  // #2102 review: SPAWNED_AGENT_TYPES and the runner's spawns pin above both
  // derive from SNAPSHOT_AGENT_TYPE/TEST_RUN_AGENT_TYPE/VERIFIER_AGENT_TYPE, never from the
  // dispatch call sites themselves — so a call site quietly reverted to a
  // hardcoded string literal (instead of the constant) would leave both
  // pins green while review-core.mjs's real dispatch silently drifts from
  // what SPAWNED_AGENT_TYPES claims. Independent of what the constants are
  // currently defined to equal: this only checks that each call site still
  // references the constant BY NAME.
  const source = readFileSync(CORE_PATH, "utf8");
  assert.equal(SNAPSHOT_AGENT_TYPE, "fleet-review-snapshot");
  assert.match(source, /agentType:\s*SNAPSHOT_AGENT_TYPE\b/);
  assert.equal(TEST_RUN_AGENT_TYPE, "fleet-review-test-run");
  assert.match(source, /agentType:\s*TEST_RUN_AGENT_TYPE\b/);
  assert.equal(VERIFIER_AGENT_TYPE, "fleet-review-verifier");
  assert.match(source, /agentType:\s*VERIFIER_AGENT_TYPE\b/);
});
