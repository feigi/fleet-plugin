import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tempDir } from "./temp-dir.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseModelRoute, parseFrontmatter, stripLevel, resolveRole, expectedOmpModel,
  modelsEqual, checkRoutes, catalogEntry,
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

// The shape of `omp models --json`, trimmed to the three targets above. The
// efforts are the ones measured on omp's own catalog (spec 2026-09-28 § 2):
// the adaptive pair runs low…max, haiku's budget mode minimal…xhigh — no max.
const ADAPTIVE = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = {
  models: [
    { provider: "amazon-bedrock", id: "anthropic.claude-haiku-4-5", selector: "amazon-bedrock/anthropic.claude-haiku-4-5", thinking: null },
    { provider: "anthropic", id: "claude-opus-5", selector: "anthropic/claude-opus-5", thinking: ADAPTIVE },
    { provider: "anthropic", id: "claude-sonnet-5", selector: "anthropic/claude-sonnet-5", thinking: ADAPTIVE },
    { provider: "anthropic", id: "claude-haiku-4-5", selector: "anthropic/claude-haiku-4-5", thinking: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
};

const routes = (files, modelRoles = MODEL_ROLES, overrides = {}) =>
  checkRoutes({ agentsDir: agentsDir(files), modelRoles, overrides, catalog: CATALOG });

test("checkRoutes: every definition routed and every role resolvable -> no violations or notices", () => {
  assert.deepEqual(routes({ "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" }), { violations: [], notices: [] });
});

test("checkRoutes (a): a definition whose model: is not a route is a violation naming the file", () => {
  const { violations } = routes({ "fleet-a": "opus" });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^fleet-a\.agent\.md: model "opus" is not @<role>:<level>$/);
});

test("checkRoutes (b): a used role with no modelRoles entry is a violation naming the role and the definition", () => {
  const { violations } = routes({ "fleet-a": "@slow:xhigh" }, {});
  assert.equal(violations.length, 1);
  assert.match(violations[0], /modelRoles\.slow is unset/);
  assert.match(violations[0], /fleet-a\.agent\.md/);
});

test("checkRoutes (b): an unset role no definition uses is not a violation", () => {
  assert.deepEqual(routes({ "fleet-a": "@slow:xhigh" }, { slow: MODEL_ROLES.slow }).violations, []);
});

test("checkRoutes (c): a fleet- key in task.agentModelOverrides shadows the definition and violates, remedy resets when nothing else remains", () => {
  const { violations } = routes({ "fleet-a": "@slow:xhigh" }, MODEL_ROLES, { "fleet-a": "@slow:xhigh" });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /task\.agentModelOverrides\.fleet-a shadows the definition's own model \(precedence #1\) — remove it/);
  assert.match(violations[0], /omp config reset task\.agentModelOverrides/);
});

test("checkRoutes (c): the remedy keeps the operator's own non-fleet- entries when one exists", () => {
  const { violations } = routes({ "fleet-a": "@slow:xhigh" }, MODEL_ROLES, { "fleet-a": "@slow:xhigh", "my-other-agent": "opus" });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /omp config set task\.agentModelOverrides/);
  assert.match(violations[0], /my-other-agent/);
  assert.doesNotMatch(violations[0], /"fleet-a"/);
});

test("checkRoutes (c): a non-fleet- override key is the operator's own and never violates", () => {
  assert.deepEqual(routes({ "fleet-a": "@slow:xhigh" }, MODEL_ROLES, { "my-other-agent": "opus" }).violations, []);
});

test("checkRoutes (d): a level the role's target does not run at is a violation naming the file and the efforts", () => {
  // The one the spec names: haiku has no `max`, so `smol-max` would clamp.
  const { violations } = routes({ "fleet-implementer-smol-max": "@smol:max", "fleet-implementer-smol-high": "@smol:high" });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^fleet-implementer-smol-max\.agent\.md: level max is not one modelRoles\.smol's target anthropic\/claude-haiku-4-5 runs at \(thinking: minimal, low, medium, high, xhigh\)/);
  // And the other edge of the adaptive range: no `minimal` on opus.
  assert.match(routes({ "fleet-a": "@slow:minimal" }).violations[0] ?? "", /fleet-a\.agent\.md: level minimal/);
});

test("checkRoutes (d): every level a target lists is accepted, through a role value written without its provider", () => {
  // The must-ACCEPT half: `task-max` is a real wire effort on the adaptive
  // models, and `smol-minimal` one on haiku's budget mode.
  assert.deepEqual(routes({ "fleet-a": "@task:max", "fleet-b": "@smol:minimal", "fleet-c": "@slow:low" }).violations, []);
  assert.deepEqual(routes({ "fleet-a": "@task:max" }, { task: "claude-sonnet-5:high" }).violations, []);
});

test("checkRoutes (d): a target the catalog does not list, or lists with no thinking at all, cannot pass", () => {
  const unlisted = routes({ "fleet-a": "@slow:high" }, { slow: "acme/unknown-1" }).violations;
  assert.equal(unlisted.length, 1);
  assert.match(unlisted[0], /modelRoles\.slow resolves to acme\/unknown-1, which omp's model catalog does not list — cannot check the level of fleet-a\.agent\.md/);
  const thinkless = routes({ "fleet-a": "@smol:low" }, { smol: "amazon-bedrock/anthropic.claude-haiku-4-5" }).violations;
  assert.equal(thinkless.length, 1);
  assert.match(thinkless[0], /level low is not one .*\(thinking: none\)/);
});

test("checkRoutes (d): a catalog omp did not print is named as a shape error, never blamed on the operator's roles", () => {
  const withCatalog = (catalog, modelRoles = MODEL_ROLES) =>
    checkRoutes({ agentsDir: agentsDir({ "fleet-a": "@slow:high" }), modelRoles, overrides: {}, catalog }).violations;
  for (const [catalog, kind] of [[{}, "absent"], [{ models: "nope" }, "string"], [{ models: null }, "null"]]) {
    const v = withCatalog(catalog);
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.equal(v[0], `omp's model catalog has no models list (models: ${kind}) — cannot check the level of any definition`);
  }
  // An unset role is still its own violation beside a malformed catalog.
  assert.deepEqual(withCatalog({}, {}).map((v) => v.split(" ")[0]), ["omp's", "modelRoles.slow"]);
  const opus = (thinking) => ({ models: [{ selector: "anthropic/claude-opus-5", thinking }] });
  for (const [thinking, kind] of [["low,medium,high,max", "string"], [undefined, "absent"], [{ high: true }, "object"]]) {
    const v = withCatalog(opus(thinking));
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.equal(v[0], `omp's model catalog lists anthropic/claude-opus-5 with thinking that is neither a list nor null (${kind}) — cannot check the level of fleet-a.agent.md`);
  }
  // The must-ACCEPT half: `thinking: null` is a real catalog value (a model
  // with no efforts), so it stays the level violation, and an empty list is a list.
  assert.match(withCatalog(opus(null))[0], /^fleet-a\.agent\.md: level high is not one .*\(thinking: none\)/);
  assert.match(withCatalog(opus([]))[0], /^fleet-a\.agent\.md: level high is not one .*\(thinking: none\)/);
  assert.deepEqual(withCatalog(opus(["high"])), []);
});

test("catalogEntry: an exact selector wins over a provider-less match", () => {
  assert.equal(catalogEntry("anthropic/claude-haiku-4-5", CATALOG).provider, "anthropic");
  assert.equal(catalogEntry("claude-opus-5", CATALOG).selector, "anthropic/claude-opus-5");
  assert.equal(catalogEntry("claude-opus", CATALOG), null);
  assert.equal(catalogEntry("anthropic/claude-opus-5", {}), null);
});

test("checkRoutes (e): slow and task resolving to the same model is a notice, not a violation", () => {
  const { violations, notices } = routes(
    { "fleet-a": "@slow:xhigh" },
    { slow: "anthropic/claude-opus-5:auto", task: "anthropic/claude-opus-5:auto", smol: MODEL_ROLES.smol },
  );
  assert.deepEqual(violations, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /modelRoles\.slow and modelRoles\.task both resolve to/);
});

test("checkRoutes (e): slow and task resolving to different models is not a notice", () => {
  assert.deepEqual(routes({ "fleet-a": "@slow:xhigh" }).notices, []);
});

// The five-cell grid at ratification (spec 2026-09-28 § 2), and every real
// definition clean against targets that run each one's level.
test("checkRoutes: every real plugin/agents definition routes cleanly, and the implementer definitions are exactly the five cells", () => {
  const cells = readdirSync(REPO_AGENTS)
    .map((f) => /^fleet-implementer(?:-(.+))?\.agent\.md$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.deepEqual(cells.sort(), ["slow-high", "slow-medium", "smol-high", "task-high", "task-max"]);
  const { violations } = checkRoutes({ agentsDir: REPO_AGENTS, modelRoles: MODEL_ROLES, overrides: {}, catalog: CATALOG });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Every flag the check reads the live install through, pointed at a fixture:
// a test that left one off would shell out to the box's own `omp`.
function installFlags(d, { overrides = {}, modelRoles = MODEL_ROLES, catalog = CATALOG } = {}) {
  return [
    "--overrides", jsonFile(d, "overrides.json", overrides),
    "--model-roles", jsonFile(d, "model-roles.json", modelRoles),
    "--catalog", jsonFile(d, "catalog.json", catalog),
  ];
}

test("CLI: --check with a clean install exits 0", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d)], d);
  assert.equal(r.status, 0, r.stderr);
});

test("CLI: --check with a non-route model: exits 1 naming the file", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "opus" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d)], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fleet-a\.agent\.md: model "opus" is not @<role>:<level>/);
});

test("CLI: --check with a shadowing fleet- override exits 1 naming the remedy", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { overrides: { "fleet-a": "@slow:xhigh" } })], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /omp config reset task\.agentModelOverrides/);
});

test("CLI: --check with a smol-max cell exits 1 — haiku has no max, and the check refuses rather than clamps", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-implementer-smol-high": "\"@smol:high\"", "fleet-implementer-smol-max": "\"@smol:max\"" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d)], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fleet-implementer-smol-max\.agent\.md: level max is not one modelRoles\.smol's target/);
  assert.doesNotMatch(r.stderr, /smol-high/);
});

test("CLI: a --catalog that is not a JSON object refuses by flag", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: [] })], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--catalog .*catalog\.json must be a JSON object, got an array/);
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
  const r = runCli(["--check", ...installFlags(d)], d);
  assert.equal(r.status, 0, r.stderr);
});
