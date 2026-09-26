import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OMP_ROLE_FOR_MODEL, ompOverrideFor, expectedOverrides, stripLevel, resolveRole,
  modelsEqual, formatYaml, checkOverrides,
} from "./tier-roles.mjs";

const SCRIPT = fileURLToPath(new URL("./tier-roles.mjs", import.meta.url));
const REPO_AGENTS = fileURLToPath(new URL("../agents", import.meta.url));

function dir() {
  return mkdtempSync(join(tmpdir(), "tier-roles-"));
}

function agentMd({ name, model, thinkingLevel = "high" }) {
  return [
    "---",
    `name: ${name}`,
    "description: fixture",
    `model: ${model}`,
    "effort: high",
    ...(thinkingLevel === null ? [] : [`thinking-level: ${thinkingLevel}`]),
    "---",
    "",
    "Follow the dispatch brief.",
    "",
  ].join("\n");
}

function runCli(argv, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// ompOverrideFor
// ---------------------------------------------------------------------------

test("ompOverrideFor: each declared alias routes to its role, suffixed with the declared level", () => {
  assert.equal(ompOverrideFor({ model: "opus", thinkingLevel: "xhigh" }), "@slow:xhigh");
  assert.equal(ompOverrideFor({ model: "sonnet", thinkingLevel: "medium" }), "@task:medium");
  assert.equal(ompOverrideFor({ model: "haiku", thinkingLevel: "low" }), "@smol:low");
});

test("ompOverrideFor: an unrecognised model returns null", () => {
  assert.equal(ompOverrideFor({ model: "gpt-4", thinkingLevel: "high" }), null);
});

test("ompOverrideFor: a recognised model with no thinking-level returns null", () => {
  assert.equal(ompOverrideFor({ model: "opus", thinkingLevel: null }), null);
});

// ---------------------------------------------------------------------------
// expectedOverrides
// ---------------------------------------------------------------------------

test("expectedOverrides: derives one override per *.agent.md file, keyed by its own name:", () => {
  const d = dir();
  writeFileSync(join(d, "a.agent.md"), agentMd({ name: "fleet-a", model: "opus", thinkingLevel: "xhigh" }));
  writeFileSync(join(d, "b.agent.md"), agentMd({ name: "fleet-b", model: "haiku", thinkingLevel: "low" }));
  assert.deepEqual(expectedOverrides(d), { "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" });
});

test("expectedOverrides: every real plugin/agents definition routes to a string, with the two measured endpoints exact", () => {
  const overrides = expectedOverrides(REPO_AGENTS);
  for (const [name, value] of Object.entries(overrides)) {
    assert.equal(typeof value, "string", `${name}: ${JSON.stringify(value)}`);
  }
  assert.equal(overrides["fleet-implementer"], "@slow:xhigh");
  assert.equal(overrides["fleet-review-snapshot"], "@smol:low");
});

test("expectedOverrides: a definition with an unroutable model throws naming the file", () => {
  const d = dir();
  writeFileSync(join(d, "bad.agent.md"), agentMd({ name: "fleet-bad", model: "gpt-4" }));
  assert.throws(() => expectedOverrides(d), /bad\.agent\.md/);
});

// ---------------------------------------------------------------------------
// stripLevel / resolveRole
// ---------------------------------------------------------------------------

test("stripLevel: removes a trailing :level, never touches the provider /", () => {
  assert.equal(stripLevel("anthropic/claude-opus-5:high"), "anthropic/claude-opus-5");
  assert.equal(stripLevel("anthropic/claude-opus-5"), "anthropic/claude-opus-5");
  assert.equal(stripLevel(null), "");
});

test("resolveRole: a direct role resolves to its stripped model", () => {
  assert.equal(resolveRole("slow", { slow: "anthropic/claude-opus-5:high" }), "anthropic/claude-opus-5");
});

test("resolveRole: an @-prefixed role value follows the chain to a bare model", () => {
  assert.equal(resolveRole("slow", { slow: "@plan", plan: "openai/gpt-5.4:high" }), "openai/gpt-5.4");
});

test("resolveRole: a cycle returns null rather than recursing forever", () => {
  assert.equal(resolveRole("a", { a: "@b", b: "@a" }), null);
});

test("resolveRole: unset/empty/non-string all return null", () => {
  assert.equal(resolveRole("slow", {}), null);
  assert.equal(resolveRole("slow", { slow: "" }), null);
  assert.equal(resolveRole("slow", { slow: 42 }), null);
});

// ---------------------------------------------------------------------------
// modelsEqual
// ---------------------------------------------------------------------------

test("modelsEqual: tolerates a role value written without its provider prefix", () => {
  assert.equal(modelsEqual("anthropic/claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelsEqual("claude-opus-5", "anthropic/claude-opus-5"), true);
  assert.equal(modelsEqual("anthropic/claude-opus-5:high", "anthropic/claude-opus-5"), true);
  assert.equal(modelsEqual("anthropic/claude-opus-5", "anthropic/claude-sonnet-5"), false);
});

// ---------------------------------------------------------------------------
// checkOverrides
// ---------------------------------------------------------------------------

const EXPECTED = { "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" };
const MODEL_ROLES = {
  slow: "anthropic/claude-opus-5:high",
  task: "anthropic/claude-sonnet-5:high",
  smol: "anthropic/claude-haiku-4-5:auto",
};

test("checkOverrides: a clean config has no violations or notices, and nothing to set", () => {
  const { violations, notices, overridesRemedy, unresolvedRoles } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: MODEL_ROLES, agentsDir: "agents" });
  assert.deepEqual(violations, []);
  assert.deepEqual(notices, []);
  assert.equal(overridesRemedy, null);
  assert.deepEqual(unresolvedRoles, []);
});

test("checkOverrides: missing keys violate, naming each and that it is absent", () => {
  const { violations } = checkOverrides({ expected: EXPECTED, actual: {}, modelRoles: MODEL_ROLES, agentsDir: "agents" });
  assert.deepEqual(violations, [
    `fleet-a: expected "@slow:xhigh", got absent`,
    `fleet-b: expected "@smol:low", got absent`,
  ]);
});

test("checkOverrides: a wrong value violates naming what was got", () => {
  const actual = { "fleet-a": "@task:xhigh", "fleet-b": "@smol:low" };
  const { violations } = checkOverrides({ expected: EXPECTED, actual, modelRoles: MODEL_ROLES, agentsDir: "agents" });
  assert.deepEqual(violations, [`fleet-a: expected "@slow:xhigh", got "@task:xhigh"`]);
});

test("checkOverrides: a stale fleet- override with no matching definition violates naming the dir it can't find it under", () => {
  const actual = { ...EXPECTED, "fleet-gone": "@slow:low" };
  const { violations } = checkOverrides({ expected: EXPECTED, actual, modelRoles: MODEL_ROLES, agentsDir: "/repo/agents" });
  assert.deepEqual(violations, [`fleet-gone: stale override "@slow:low" — no such definition under /repo/agents`]);
});

test("checkOverrides: a non-fleet- key in actual is the operator's own and is ignored", () => {
  const actual = { ...EXPECTED, "my-own-thing": "@task:low" };
  const { violations } = checkOverrides({ expected: EXPECTED, actual, modelRoles: MODEL_ROLES, agentsDir: "agents" });
  assert.deepEqual(violations, []);
});

// The modelRoles-only case: every override is already right, so an overrides
// remedy would be a no-op `omp config set` — `overridesRemedy` is `null` and
// the unresolved roles are what the operator is pointed at instead.
test("checkOverrides: an unset role a used definition needs violates naming the role, with no overrides remedy", () => {
  const { violations, overridesRemedy, unresolvedRoles } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: { task: MODEL_ROLES.task }, agentsDir: "agents" });
  assert.deepEqual(violations, [
    `modelRoles.slow: unset — @slow would fall through to the parent's model`,
    `modelRoles.smol: unset — @smol would fall through to the parent's model`,
  ]);
  assert.equal(overridesRemedy, null);
  assert.deepEqual(unresolvedRoles, ["slow", "smol"]);
});

// EXPECTED routes through `slow` and `smol` only: `task` being unset is
// nothing any definition here would fall through on, so it must not stop a run.
test("checkOverrides: an unset role no expected override routes through is not a violation", () => {
  const { violations, unresolvedRoles } = checkOverrides({
    expected: EXPECTED, actual: EXPECTED,
    modelRoles: { slow: MODEL_ROLES.slow, smol: MODEL_ROLES.smol }, agentsDir: "agents",
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(unresolvedRoles, []);
});

// Iterates the tier map itself, so a role added to OMP_ROLE_FOR_MODEL is held
// to the same unset check without anyone remembering to list it anywhere else.
test("checkOverrides: every role the tier map routes to is checked for unset", () => {
  for (const role of Object.values(OMP_ROLE_FOR_MODEL)) {
    const expected = { "fleet-x": `@${role}:high` };
    const { violations } = checkOverrides({ expected, actual: expected, modelRoles: {}, agentsDir: "agents" });
    assert.deepEqual(violations, [`modelRoles.${role}: unset — @${role} would fall through to the parent's model`], role);
  }
});

test("checkOverrides: a role set to an @-alias chain that never reaches a model says so, not that it is unset", () => {
  const roles = { ...MODEL_ROLES, slow: "@plan", plan: "@slow" };
  const { violations, unresolvedRoles } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: roles, agentsDir: "agents" });
  assert.deepEqual(violations, [
    `modelRoles.slow: "@plan" never reaches a model — its @-alias chain hits an unset role, cycles, or runs past 8 hops`,
  ]);
  assert.deepEqual(unresolvedRoles, ["slow"]);
});

// `omp config set` on a record key REPLACES the record, so the remedy is the
// whole value to set: the operator's own entries verbatim, every expected
// entry laid over, and the stale fleet- entry (the violation) dropped.
test("checkOverrides: the overrides remedy keeps the operator's own entries, fixes the fleet's, and drops a stale one", () => {
  const actual = { "fleet-a": "@task:xhigh", "fleet-gone": "@slow:low", "my-own-thing": "@task:low" };
  const { overridesRemedy } = checkOverrides({ expected: EXPECTED, actual, modelRoles: MODEL_ROLES, agentsDir: "agents" });
  assert.deepEqual(overridesRemedy, { "my-own-thing": "@task:low", "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" });
});

test("checkOverrides: slow and task both resolving to the same model is a notice, not a violation", () => {
  const roles = { ...MODEL_ROLES, task: MODEL_ROLES.slow };
  const { violations, notices } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: roles, agentsDir: "agents" });
  assert.deepEqual(violations, []);
  assert.deepEqual(notices, [
    `modelRoles.slow and modelRoles.task both resolve to anthropic/claude-opus-5 — the alternate-tier comparison controls nothing`,
  ]);
});

// ---------------------------------------------------------------------------
// formatYaml
// ---------------------------------------------------------------------------

test("formatYaml: exact double-quoted, sorted block", () => {
  assert.equal(
    formatYaml({ "fleet-b": "@smol:low", "fleet-a": "@slow:xhigh" }),
    'task:\n  agentModelOverrides:\n    fleet-a: "@slow:xhigh"\n    fleet-b: "@smol:low"\n',
  );
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("CLI: default output prints YAML whose parsed pairs equal --json's object", () => {
  const yamlR = runCli([]);
  assert.equal(yamlR.status, 0, yamlR.stdout + yamlR.stderr);
  const jsonR = runCli(["--json"]);
  assert.equal(jsonR.status, 0, jsonR.stdout + jsonR.stderr);
  const expected = JSON.parse(jsonR.stdout);
  const fromYaml = {};
  for (const line of yamlR.stdout.split("\n")) {
    const m = /^ {4}(\S+): "([^"]+)"$/.exec(line);
    if (m) fromYaml[m[1]] = m[2];
  }
  assert.deepEqual(fromYaml, expected);
});

test("CLI: --check against a correct config exits 0 with one line per agent", () => {
  const d = dir();
  writeFileSync(join(d, "a.agent.md"), agentMd({ name: "fleet-a", model: "opus", thinkingLevel: "xhigh" }));
  writeFileSync(join(d, "b.agent.md"), agentMd({ name: "fleet-b", model: "haiku", thinkingLevel: "low" }));
  const overridesFile = join(d, "overrides.json");
  writeFileSync(overridesFile, JSON.stringify({ "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" }));
  const modelRolesFile = join(d, "model-roles.json");
  writeFileSync(modelRolesFile, JSON.stringify(MODEL_ROLES));
  const r = runCli(["--check", "--agents", d, "--overrides", overridesFile, "--model-roles", modelRolesFile]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 2);
  assert.match(r.stdout, /tier-roles: fleet-a → @slow:xhigh = anthropic\/claude-opus-5/);
});

test("CLI: --check with one key missing exits 1, names it, and prints a remedy that sets every expected override and keeps the operator's own", () => {
  const d = dir();
  writeFileSync(join(d, "a.agent.md"), agentMd({ name: "fleet-a", model: "opus", thinkingLevel: "xhigh" }));
  writeFileSync(join(d, "b.agent.md"), agentMd({ name: "fleet-b", model: "haiku", thinkingLevel: "low" }));
  const overridesFile = join(d, "overrides.json");
  writeFileSync(overridesFile, JSON.stringify({ "fleet-a": "@slow:xhigh", "my-own-thing": "@task:low" }));
  const modelRolesFile = join(d, "model-roles.json");
  writeFileSync(modelRolesFile, JSON.stringify(MODEL_ROLES));
  const r = runCli(["--check", "--agents", d, "--overrides", overridesFile, "--model-roles", modelRolesFile]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /fleet-b: expected "@smol:low", got absent/);
  const remedyMatch = /remedy: omp config set task\.agentModelOverrides '(.+)'/.exec(r.stderr);
  assert.ok(remedyMatch, r.stderr);
  // `omp config set` replaces the record with exactly this value, so it IS
  // the post-remedy state: the non-fleet key must be in it.
  assert.deepEqual(JSON.parse(remedyMatch[1]), { "my-own-thing": "@task:low", ...expectedOverrides(d) });
  assert.doesNotMatch(r.stderr, /modelRoles/);
});

test("CLI: --check with only a modelRoles role unset prints no overrides command, and points at modelRoles", () => {
  const d = dir();
  writeFileSync(join(d, "a.agent.md"), agentMd({ name: "fleet-a", model: "opus", thinkingLevel: "xhigh" }));
  const overridesFile = join(d, "overrides.json");
  writeFileSync(overridesFile, JSON.stringify({ "fleet-a": "@slow:xhigh" }));
  const modelRolesFile = join(d, "model-roles.json");
  writeFileSync(modelRolesFile, JSON.stringify({ task: MODEL_ROLES.task }));
  const r = runCli(["--check", "--agents", d, "--overrides", overridesFile, "--model-roles", modelRolesFile]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /omp config set task\.agentModelOverrides/);
  assert.match(r.stderr, /task\.agentModelOverrides already matches every definition/);
  assert.match(r.stderr, /remedy: give modelRoles\.slow a model this install has/);
});

test("CLI: --json --merge prints the expected overrides laid over the operator's own, dropping a stale fleet- entry", () => {
  const d = dir();
  writeFileSync(join(d, "a.agent.md"), agentMd({ name: "fleet-a", model: "opus", thinkingLevel: "xhigh" }));
  const overridesFile = join(d, "overrides.json");
  writeFileSync(overridesFile, JSON.stringify({ "fleet-gone": "@slow:low", "my-own-thing": "@task:low" }));
  const r = runCli(["--json", "--merge", "--agents", d, "--overrides", overridesFile]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { "my-own-thing": "@task:low", "fleet-a": "@slow:xhigh" });
});

test("CLI: --merge without --json refuses", () => {
  const r = runCli(["--merge"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--merge only shapes --json's object/);
});

test("CLI: --json together with --check refuses", () => {
  const r = runCli(["--json", "--check"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--json prints the block; it has no meaning with --check/);
});

test("CLI: an unknown flag refuses by name", () => {
  const r = runCli(["--checkk"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown flag --checkk/);
});
