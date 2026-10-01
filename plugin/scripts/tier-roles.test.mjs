import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from "./temp-dir.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseModelRoute, parseFrontmatter, stripLevel, resolveRole, expectedOmpModel,
  modelsEqual, checkRoutes,
} from "./tier-roles.mjs";

const SCRIPT = fileURLToPath(new URL("./tier-roles.mjs", import.meta.url));
const REPO_AGENTS = fileURLToPath(new URL("../agents", import.meta.url));

function dir() {
  return tempDir("tier-roles-");
}

function agentsDir(files) {
  const d = dir();
  const agents = join(d, "agents");
  mkdirSync(agents, { recursive: true });
  for (const [name, model] of Object.entries(files)) {
    writeFileSync(
      join(agents, `${name}.agent.md`),
      `---\nname: ${name}\ndescription: fixture\nmodel: ${model}\n---\n\nFollow the dispatch brief.\n`,
    );
  }
  return agents;
}

function jsonFile(d, name, value) {
  const p = join(d, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

function runCli(argv, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// parseModelRoute / parseFrontmatter
// ---------------------------------------------------------------------------

test("parseModelRoute: a well-formed route, unquoted", () => {
  assert.deepEqual(parseModelRoute("@slow:xhigh"), { role: "slow", level: "xhigh" });
});

test("parseModelRoute: a well-formed route, double-quoted", () => {
  assert.deepEqual(parseModelRoute('"@slow:xhigh"'), { role: "slow", level: "xhigh" });
});

test("parseModelRoute: a well-formed route, single-quoted", () => {
  assert.deepEqual(parseModelRoute("'@task:low'"), { role: "task", level: "low" });
});

test("parseModelRoute: every role/level combination is accepted", () => {
  for (const role of ["slow", "task", "smol"]) {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.deepEqual(parseModelRoute(`@${role}:${level}`), { role, level });
    }
  }
});

test("parseModelRoute: a bare vendor alias is not a route", () => {
  assert.deepEqual(parseModelRoute("opus"), { role: null, level: null });
});

test("parseModelRoute: an unrecognised role is not a route", () => {
  assert.deepEqual(parseModelRoute("@fast:high"), { role: null, level: null });
});

test("parseModelRoute: an unrecognised level is not a route", () => {
  assert.deepEqual(parseModelRoute("@slow:extreme"), { role: null, level: null });
});

test("parseModelRoute: missing the :<level> suffix is not a route", () => {
  assert.deepEqual(parseModelRoute("@slow"), { role: null, level: null });
});

test("parseFrontmatter: a quoted route parses model/role/level together", () => {
  const text = '---\nname: fleet-x\ndescription: d\nmodel: "@slow:xhigh"\n---\nbody\n';
  assert.deepEqual(parseFrontmatter(text), { model: '"@slow:xhigh"', role: "slow", level: "xhigh" });
});

test("parseFrontmatter: an unquoted route parses the same role/level", () => {
  const text = "---\nname: fleet-x\ndescription: d\nmodel: @slow:xhigh\n---\nbody\n";
  assert.deepEqual(parseFrontmatter(text), { model: "@slow:xhigh", role: "slow", level: "xhigh" });
});

test("parseFrontmatter: no model: field at all is null/null/null", () => {
  const text = "---\nname: fleet-x\ndescription: d\n---\nbody\n";
  assert.deepEqual(parseFrontmatter(text), { model: null, role: null, level: null });
});

test("parseFrontmatter: a non-route model: value carries the raw model but null role/level", () => {
  const text = "---\nname: fleet-x\ndescription: d\nmodel: opus\n---\nbody\n";
  assert.deepEqual(parseFrontmatter(text), { model: "opus", role: null, level: null });
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
// expectedOmpModel
// ---------------------------------------------------------------------------

test("expectedOmpModel: a route resolves through the named role", () => {
  assert.deepEqual(
    expectedOmpModel("@slow:xhigh", { slow: "anthropic/claude-opus-5:auto" }),
    { role: "slow", level: "xhigh", model: "anthropic/claude-opus-5" },
  );
});

test("expectedOmpModel: an unset role resolves to a null model, role/level still reported", () => {
  assert.deepEqual(expectedOmpModel("@task:low", {}), { role: "task", level: "low", model: null });
});

test("expectedOmpModel: a non-route value has null role/level/model", () => {
  assert.deepEqual(expectedOmpModel("opus", {}), { role: null, level: null, model: null });
});

// ---------------------------------------------------------------------------
// modelsEqual
// ---------------------------------------------------------------------------

test("modelsEqual: tolerates a role value written without its provider prefix", () => {
  assert.equal(modelsEqual("anthropic/claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelsEqual("claude-opus-5", "anthropic/claude-opus-5"), true);
  assert.equal(modelsEqual("anthropic/claude-opus-5:high", "anthropic/claude-opus-5"), true);
  assert.equal(modelsEqual("anthropic/claude-opus-5", "anthropic/claude-haiku-4-5"), false);
});

test("modelsEqual: a bare suffix match without the '/' boundary is NOT equal", () => {
  // The prefix-tolerance above requires a `/` immediately before the shorter
  // spelling — this pins that boundary against a regression to a bare
  // `endsWith` (no `/`), which would wrongly equate two DIFFERENT models
  // that merely happen to share a trailing token.
  assert.equal(modelsEqual("claude-opus-5", "not-claude-opus-5"), false);
  assert.equal(modelsEqual("not-claude-opus-5", "claude-opus-5"), false);
  assert.equal(modelsEqual("x-claude-opus-5", "claude-opus-5"), false);
});

// ---------------------------------------------------------------------------
// checkRoutes
// ---------------------------------------------------------------------------

const MODEL_ROLES = { slow: "anthropic/claude-opus-5:auto", task: "anthropic/claude-sonnet-5:auto", smol: "anthropic/claude-haiku-4-5:auto" };

test("checkRoutes: every definition routed and every role resolvable -> no violations or notices", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" });
  const result = checkRoutes({ agentsDir: agents, modelRoles: MODEL_ROLES, overrides: {} });
  assert.deepEqual(result, { violations: [], notices: [] });
});

test("checkRoutes (a): a definition whose model: is not a route is a violation naming the file", () => {
  const agents = agentsDir({ "fleet-a": "opus" });
  const { violations } = checkRoutes({ agentsDir: agents, modelRoles: MODEL_ROLES, overrides: {} });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^fleet-a\.agent\.md: model "opus" is not @<role>:<level>$/);
});

test("checkRoutes (b): a used role with no modelRoles entry is a violation naming the role and the definition", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { violations } = checkRoutes({ agentsDir: agents, modelRoles: {}, overrides: {} });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /modelRoles\.slow is unset/);
  assert.match(violations[0], /fleet-a\.agent\.md/);
});

test("checkRoutes (b): an unset role no definition uses is not a violation", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { violations } = checkRoutes({ agentsDir: agents, modelRoles: { slow: MODEL_ROLES.slow }, overrides: {} });
  assert.deepEqual(violations, []);
});

test("checkRoutes (c): a fleet- key in task.agentModelOverrides shadows the definition and violates, remedy resets when nothing else remains", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { violations } = checkRoutes({
    agentsDir: agents,
    modelRoles: MODEL_ROLES,
    overrides: { "fleet-a": "@slow:xhigh" },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /task\.agentModelOverrides\.fleet-a shadows the definition's own model \(precedence #1\) — remove it/);
  assert.match(violations[0], /omp config reset task\.agentModelOverrides/);
});

test("checkRoutes (c): the remedy keeps the operator's own non-fleet- entries when one exists", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { violations } = checkRoutes({
    agentsDir: agents,
    modelRoles: MODEL_ROLES,
    overrides: { "fleet-a": "@slow:xhigh", "my-other-agent": "opus" },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /omp config set task\.agentModelOverrides/);
  assert.match(violations[0], /my-other-agent/);
  assert.doesNotMatch(violations[0], /"fleet-a"/);
});

test("checkRoutes (c): a non-fleet- override key is the operator's own and never violates", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { violations } = checkRoutes({
    agentsDir: agents,
    modelRoles: MODEL_ROLES,
    overrides: { "my-other-agent": "opus" },
  });
  assert.deepEqual(violations, []);
});

test("checkRoutes (d): slow and task resolving to the same model is a notice, not a violation", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { violations, notices } = checkRoutes({
    agentsDir: agents,
    modelRoles: { slow: "anthropic/claude-opus-5:auto", task: "anthropic/claude-opus-5:auto", smol: MODEL_ROLES.smol },
    overrides: {},
  });
  assert.deepEqual(violations, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /modelRoles\.slow and modelRoles\.task both resolve to/);
});

test("checkRoutes (d): slow and task resolving to different models is not a notice", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const { notices } = checkRoutes({ agentsDir: agents, modelRoles: MODEL_ROLES, overrides: {} });
  assert.deepEqual(notices, []);
});

test("checkRoutes: every real plugin/agents definition routes cleanly against a model-roles fixture that covers all three roles", () => {
  const { violations } = checkRoutes({ agentsDir: REPO_AGENTS, modelRoles: MODEL_ROLES, overrides: {} });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("CLI: --check with a clean install exits 0", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const overridesPath = jsonFile(d, "overrides.json", {});
  const modelRolesPath = jsonFile(d, "model-roles.json", MODEL_ROLES);
  const r = runCli(["--check", "--agents", agents, "--overrides", overridesPath, "--model-roles", modelRolesPath], d);
  assert.equal(r.status, 0, r.stderr);
});

test("CLI: --check with a non-route model: exits 1 naming the file", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "opus" });
  const overridesPath = jsonFile(d, "overrides.json", {});
  const modelRolesPath = jsonFile(d, "model-roles.json", MODEL_ROLES);
  const r = runCli(["--check", "--agents", agents, "--overrides", overridesPath, "--model-roles", modelRolesPath], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fleet-a\.agent\.md: model "opus" is not @<role>:<level>/);
});

test("CLI: --check with a shadowing fleet- override exits 1 naming the remedy", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const overridesPath = jsonFile(d, "overrides.json", { "fleet-a": "@slow:xhigh" });
  const modelRolesPath = jsonFile(d, "model-roles.json", MODEL_ROLES);
  const r = runCli(["--check", "--agents", agents, "--overrides", overridesPath, "--model-roles", modelRolesPath], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /omp config reset task\.agentModelOverrides/);
});

test("CLI: --check without --check flag is required", () => {
  const d = dir();
  const r = runCli([], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--check is required/);
});

test("CLI: an unknown flag refuses by name", () => {
  const d = dir();
  const r = runCli(["--check", "--bogus", "x"], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --bogus/);
});

test("CLI: --agents defaults to the plugin's own agents directory", () => {
  const d = dir();
  const overridesPath = jsonFile(d, "overrides.json", {});
  const modelRolesPath = jsonFile(d, "model-roles.json", MODEL_ROLES);
  const r = runCli(["--check", "--overrides", overridesPath, "--model-roles", modelRolesPath], d);
  assert.equal(r.status, 0, r.stderr);
});
