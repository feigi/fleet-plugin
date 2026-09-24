import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ompOverrideFor, expectedOverrides, stripLevel, resolveRole,
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

test("checkOverrides: a clean config has no violations or notices", () => {
  const { violations, notices } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: MODEL_ROLES, agentsDir: "agents" });
  assert.deepEqual(violations, []);
  assert.deepEqual(notices, []);
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

test("checkOverrides: an unset role a used definition needs violates naming the role", () => {
  const { violations } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: { task: MODEL_ROLES.task }, agentsDir: "agents" });
  assert.deepEqual(violations, [
    `modelRoles.slow: unset — @slow would fall through to the parent's model`,
    `modelRoles.smol: unset — @smol would fall through to the parent's model`,
  ]);
});

test("checkOverrides: slow and task both resolving to the same model is a notice, not a violation", () => {
  const roles = { ...MODEL_ROLES, task: MODEL_ROLES.slow };
  const { violations, notices } = checkOverrides({ expected: EXPECTED, actual: EXPECTED, modelRoles: roles, agentsDir: "agents" });
  assert.deepEqual(violations, []);
  assert.deepEqual(notices, [
    `modelRoles.slow and modelRoles.task both resolve to anthropic/claude-opus-5 — the per-wave alternate-tier pairing controls nothing`,
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

test("CLI: --check with one key missing exits 1, names it, and prints a remedy whose JSON matches expectedOverrides", () => {
  const d = dir();
  writeFileSync(join(d, "a.agent.md"), agentMd({ name: "fleet-a", model: "opus", thinkingLevel: "xhigh" }));
  writeFileSync(join(d, "b.agent.md"), agentMd({ name: "fleet-b", model: "haiku", thinkingLevel: "low" }));
  const overridesFile = join(d, "overrides.json");
  writeFileSync(overridesFile, JSON.stringify({ "fleet-a": "@slow:xhigh" }));
  const modelRolesFile = join(d, "model-roles.json");
  writeFileSync(modelRolesFile, JSON.stringify(MODEL_ROLES));
  const r = runCli(["--check", "--agents", d, "--overrides", overridesFile, "--model-roles", modelRolesFile]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /fleet-b: expected "@smol:low", got absent/);
  const remedyMatch = /remedy: omp config set task\.agentModelOverrides '(.+)'/.exec(r.stderr);
  assert.ok(remedyMatch, r.stderr);
  assert.deepEqual(JSON.parse(remedyMatch[1]), expectedOverrides(d));
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
