import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseModelRoute, parseFrontmatter, stripLevel, resolveRole, expectedOmpModel,
  modelsEqual, checkRoutes, catalogEntry, semaphoreNotice, implementerCell, routableCells,
} from "../plugin/scripts/tier-roles.mjs";
import { POLICY_CELL } from "../plugin/scripts/ledger-grammar.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/tier-roles.mjs", import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL("../plugin/scripts", import.meta.url));
const REPO_AGENTS = fileURLToPath(new URL("../plugin/agents", import.meta.url));

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

function runCli(argv, cwd, env) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf8", env });
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

const routes = (files, modelRoles = MODEL_ROLES, overrides = {}, routable = null, catalog = CATALOG) =>
  checkRoutes({ agentsDir: agentsDir(files), modelRoles, overrides, catalog, routable });

test("checkRoutes: every definition routed and every role resolvable -> no violations or notices", () => {
  assert.deepEqual(routes({ "fleet-a": "@slow:xhigh", "fleet-b": "@smol:low" }), { violations: [], notices: [] });
});

test("checkRoutes: an agents directory holding no *.agent.md definition is a violation naming the directory, never a vacuous pass", () => {
  const empty = agentsDir({});
  const { violations } = checkRoutes({ agentsDir: empty, modelRoles: MODEL_ROLES, overrides: {}, catalog: CATALOG });
  assert.deepEqual(violations, [`no *.agent.md definition found in ${empty}`]);

  // A directory that holds only files the check does not read is the same case.
  writeFileSync(join(empty, "README.md"), "not a definition\n");
  assert.deepEqual(checkRoutes({ agentsDir: empty, modelRoles: MODEL_ROLES, overrides: {}, catalog: CATALOG }).violations, [`no *.agent.md definition found in ${empty}`]);
});

test("checkRoutes: an empty agents directory still reports the other violations alongside", () => {
  const { violations } = checkRoutes({ agentsDir: agentsDir({}), modelRoles: MODEL_ROLES, overrides: { "fleet-a": "@slow:xhigh" }, catalog: CATALOG });
  assert.equal(violations.length, 2);
  assert.match(violations.join("\n"), /task\.agentModelOverrides\.fleet-a shadows/);
});

test("checkRoutes: an --agents path that is missing, or a regular file, is a violation naming the flag and path, not a crash", () => {
  const d = dir();
  const missing = join(d, "nope");
  const file = join(d, "plain.txt");
  writeFileSync(file, "x\n");
  for (const [path, code] of [[missing, "ENOENT"], [file, "ENOTDIR"]]) {
    const { violations } = checkRoutes({ agentsDir: path, modelRoles: MODEL_ROLES, overrides: {}, catalog: CATALOG });
    assert.deepEqual(violations, [`--agents ${path}: cannot read the agents directory (${code})`]);
  }
});

test("checkRoutes: a directory named *.agent.md is a violation naming the entry, and the readable definitions after it are still checked", () => {
  const agents = agentsDir({ "fleet-a": "@slow:xhigh", "fleet-b": "@smol:max" });
  mkdirSync(join(agents, "a.agent.md"));
  const { violations } = checkRoutes({ agentsDir: agents, modelRoles: MODEL_ROLES, overrides: {}, catalog: CATALOG });
  assert.equal(violations.length, 2);
  assert.equal(violations[0], `--agents ${agents}: cannot read a.agent.md (EISDIR)`);
  assert.match(violations[1], /^fleet-b\.agent\.md: level max is not one modelRoles\.smol's target/);
});

test("checkRoutes: an unreadable agents directory names the source the caller gives, not --agents", () => {
  const missing = join(dir(), "nope");
  const { violations } = checkRoutes({ agentsDir: missing, agentsSource: "the default agents directory X", modelRoles: MODEL_ROLES, overrides: {}, catalog: CATALOG });
  assert.deepEqual(violations, ["the default agents directory X: cannot read the agents directory (ENOENT)"]);
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

// An implementer definition whose cell the router never selects: the level
// the role's target does not run is a notice there, a violation anywhere else.
const MAX_WITHOUT = (id) => ({ models: CATALOG.models.map((m) => (m.id === id ? { ...m, thinking: ADAPTIVE.filter((l) => l !== "max") } : m)) });
const NO_TASK_MAX = MAX_WITHOUT("claude-sonnet-5");
// A router table's `rows`: one row set per objective, the speed set the cost set's unless named.
const sets = (cost, speed = cost) => ({ cost, speed });
const TABLE = { cells: [POLICY_CELL, "task-high", "smol-high"], rows: sets({ "*": POLICY_CELL }) };
const TASK_MAX_DEFS = { "fleet-implementer-task-high": "@task:high", "fleet-implementer-task-max": "@task:max" };
const TASK_MAX_MISMATCH = "fleet-implementer-task-max.agent.md: level max is not one modelRoles.task's target anthropic/claude-sonnet-5 runs at (thinking: low, medium, high, xhigh)";
const routableOf = (table) => {
  const r = routableCells(table);
  assert.ok(r instanceof Set, String(r));
  return r;
};

test("checkRoutes: an implementer definition whose cell the router never selects gets a notice, not a violation, for a level its target lacks", () => {
  const { violations, notices } = routes(TASK_MAX_DEFS, MODEL_ROLES, {}, routableOf(TABLE), NO_TASK_MAX);
  assert.deepEqual(violations, []);
  assert.deepEqual(notices, [`${TASK_MAX_MISMATCH} — cell task-max is not one the router selects; omp would clamp this level silently once it does`]);
});

test("checkRoutes: the same level on a cell in the router table's `cells` is a violation", () => {
  const { violations, notices } = routes(TASK_MAX_DEFS, MODEL_ROLES, {}, routableOf({ ...TABLE, cells: [...TABLE.cells, "task-max"] }), NO_TASK_MAX);
  assert.deepEqual(violations, [`${TASK_MAX_MISMATCH} — omp would clamp it silently`]);
  assert.deepEqual(notices, []);
});

test("checkRoutes: a cell a `rows` value names, absent from `cells`, is selected and so a violation", () => {
  const table = { ...TABLE, rows: sets({ "*": POLICY_CELL, heavy: "task-max" }) };
  const { violations, notices } = routes(TASK_MAX_DEFS, MODEL_ROLES, {}, routableOf(table), NO_TASK_MAX);
  assert.deepEqual(violations, [`${TASK_MAX_MISMATCH} — omp would clamp it silently`]);
  assert.deepEqual(notices, []);
});

test("checkRoutes: the policy cell is selected whatever the table lists, so its mismatch is a violation", () => {
  const table = { cells: ["task-high"], rows: sets({ "*": "task-high" }) };
  const { violations, notices } = routes({ [`fleet-implementer-${POLICY_CELL}`]: "@slow:max" }, MODEL_ROLES, {}, routableOf(table), MAX_WITHOUT("claude-opus-5"));
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^fleet-implementer-${POLICY_CELL}\\.agent\\.md: level max is not one modelRoles\\.slow's target .* — omp would clamp it silently$`));
  assert.deepEqual(notices, []);
});

test("checkRoutes: a definition that is not an implementer cell is held to the level check whatever the table lists", () => {
  const defs = { "fleet-reviewer-xhigh": "@task:max", "fleet-implementer-alt": "@task:max" };
  const { violations, notices } = routes(defs, MODEL_ROLES, {}, routableOf(TABLE), NO_TASK_MAX);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /^fleet-implementer-alt\.agent\.md: level max is not one modelRoles\.task's target .* — omp would clamp it silently$/);
  assert.match(violations[1], /^fleet-reviewer-xhigh\.agent\.md: level max is not one modelRoles\.task's target .* — omp would clamp it silently$/);
  assert.deepEqual(notices, []);
});

test("checkRoutes: with no router table at all every implementer definition is held to the level check", () => {
  const { violations, notices } = routes(TASK_MAX_DEFS, MODEL_ROLES, {}, null, NO_TASK_MAX);
  assert.deepEqual(violations, [`${TASK_MAX_MISMATCH} — omp would clamp it silently`]);
  assert.deepEqual(notices, []);
});

// ---------------------------------------------------------------------------
// implementerCell / routableCells
// ---------------------------------------------------------------------------

test("implementerCell: a fleet-implementer-<cell> definition names its cell", () => {
  assert.equal(implementerCell("fleet-implementer-task-max.agent.md"), "task-max");
  assert.equal(implementerCell("fleet-implementer-slow-high.agent.md"), "slow-high");
});

test("implementerCell: any other definition, or an implementer whose name is not a cell, is null", () => {
  for (const file of ["fleet-reviewer-xhigh.agent.md", "fleet-merge-bot.agent.md", "fleet-implementer-alt.agent.md", "fleet-implementer.agent.md", "fleet-implementer-task-max-x.agent.md", "xfleet-implementer-task-max.agent.md"]) {
    assert.equal(implementerCell(file), null, file);
  }
});

test("routableCells: the policy cell, every `cells` entry and every `rows` value of either objective's set, and nothing else", () => {
  const table = { cells: ["task-high", "smol-high"], rows: sets({ "*": "task-high", heavy: "task-max" }) };
  assert.deepEqual([...routableOf(table)].sort(), [POLICY_CELL, "smol-high", "task-high", "task-max"].sort());
  assert.deepEqual([...routableOf({ cells: [], rows: {} })], [POLICY_CELL]);
});

test("routableCells: a cell only a speed row names is routable", () => {
  const table = { cells: [POLICY_CELL, "task-high"], rows: sets({ "*": POLICY_CELL }, { "*": POLICY_CELL, light: "smol-high" }) };
  assert.equal(routableOf(table).has("smol-high"), true);
  assert.equal(routableOf({ ...table, rows: sets({ "*": POLICY_CELL }) }).has("smol-high"), false, "named by no row, it is not");
});

for (const [label, table, why] of [
  ["null", null, /not a JSON object/],
  ["an array", [], /not a JSON object/],
  ["a string", "slow-high", /not a JSON object/],
  ["an object without `cells`", { rows: {} }, /`cells` is not an array of cell names/],
  ["a string `cells`", { cells: "slow-high,task-max", rows: {} }, /`cells` is not an array of cell names/],
  ["a number `cells`", { cells: 5, rows: {} }, /`cells` is not an array of cell names/],
  ["an object `cells`", { cells: { a: 1 }, rows: {} }, /`cells` is not an array of cell names/],
  ["a `cells` array holding a non-string", { cells: ["task-high", 1], rows: {} }, /`cells` is not an array of cell names/],
  ["an object without `rows`", { cells: [] }, /`rows` is not an object of row sets of cell names/],
  ["an array `rows`", { cells: [], rows: ["task-high"] }, /`rows` is not an object of row sets of cell names/],
  ["a row set that is a cell name, not an object", { cells: [], rows: { cost: "task-high" } }, /`rows` is not an object of row sets of cell names/],
  ["a `rows` value that is not a string", { cells: [], rows: sets({ "*": 5 }) }, /`rows` is not an object of row sets of cell names/],
]) {
  test(`routableCells: ${label} is an Error naming the missing shape, never an empty set`, () => {
    const r = routableCells(table);
    assert.ok(r instanceof Error, String(r));
    assert.match(r.message, /^router table: /);
    assert.match(r.message, why);
  });
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Every flag the check reads the live install through, pointed at a fixture:
// a test that left one off would shell out to the box's own `omp`. Each flag
// is given here once and a test never repeats one: arg() is first-wins, so a
// second copy would be ignored without a sound. `maxConcurrencyPath` and
// `tablePath` are paths, not values, so a test can hand over a file that is
// missing or not JSON; null leaves `maxConcurrencyPath` off, so the notice
// reads the live `omp`, and `table: null` leaves `--table` off, so the
// router-table.json beside the script is read.
function installFlags(d, { overrides = {}, modelRoles = MODEL_ROLES, catalog = CATALOG, table = TABLE, tablePath = null, inFlight = "5", maxConcurrencyPath = jsonFile(d, "max-concurrency.json", 32) } = {}) {
  return [
    "--in-flight", inFlight,
    ...(maxConcurrencyPath === null ? [] : ["--max-concurrency", maxConcurrencyPath]),
    "--overrides", jsonFile(d, "overrides.json", overrides),
    "--model-roles", jsonFile(d, "model-roles.json", modelRoles),
    "--catalog", jsonFile(d, "catalog.json", catalog),
    ...(table === null ? [] : ["--table", tablePath ?? jsonFile(d, "table.json", table)]),
  ];
}

test("CLI: --check with a clean install exits 0", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d)], d);
  assert.equal(r.status, 0, r.stderr);
});

test("CLI: --check on an agents directory with no definitions exits 1 naming the directory", () => {
  const d = dir();
  const agents = agentsDir({});
  const r = runCli(["--check", "--agents", agents, ...installFlags(d)], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no \*\.agent\.md definition found in /);
  assert.doesNotMatch(r.stdout, /every definition routes/);
});

test("CLI: --check on an --agents path that is missing, a regular file, or holds a directory named *.agent.md exits 1 with a refusal naming the cause, no stack trace", () => {
  const d = dir();
  const file = join(d, "plain.txt");
  writeFileSync(file, "x\n");
  const trap = agentsDir({ "fleet-a": "@slow:xhigh" });
  mkdirSync(join(trap, "x.agent.md"));
  for (const [path, code] of [[join(d, "nope"), "ENOENT"], [file, "ENOTDIR"], [trap, "EISDIR"]]) {
    const r = runCli(["--check", "--agents", path, ...installFlags(d)], d);
    assert.equal(r.status, 1, path);
    assert.match(r.stderr, new RegExp(`^tier-roles: --agents ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: cannot read .*\\(${code}\\)`), path);
    assert.doesNotMatch(r.stderr, /\n\s+at /, path);
    assert.doesNotMatch(r.stdout, /every definition routes/);
  }
});

test("CLI: --check with no --agents and an unreadable built-in agents directory refuses without naming a flag it was not given", () => {
  const d = dir();
  const script = copiedScript(d, TABLE);
  const r = spawnSync(process.execPath, [script, "--check", ...installFlags(d, { table: null })], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^tier-roles: the default agents directory .*agents: cannot read the agents directory \(ENOENT\)/);
  assert.doesNotMatch(r.stderr, /--agents/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
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
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { table: { ...TABLE, cells: [...TABLE.cells, "smol-max"] } })], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fleet-implementer-smol-max\.agent\.md: level max is not one modelRoles\.smol's target/);
  assert.doesNotMatch(r.stderr, /smol-high/);
});

test("CLI: --check with a task-max cell the router table lacks exits 0 with a notice, and exits 1 once the table lists it", () => {
  const d = dir();
  const agents = agentsDir(TASK_MAX_DEFS);
  const absent = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: NO_TASK_MAX })], d);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /^tier-roles: every definition routes/);
  assert.deepEqual(noticeLines(absent.stdout), [`tier-roles: notice: ${TASK_MAX_MISMATCH} — cell task-max is not one the router selects; omp would clamp this level silently once it does`]);

  const listed = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: NO_TASK_MAX, table: { ...TABLE, cells: [...TABLE.cells, "task-max"] } })], d);
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /fleet-implementer-task-max\.agent\.md: level max is not one modelRoles\.task's target .* — omp would clamp it silently/);
});

test("CLI: a --table that is malformed refuses by path with the missing shape, never an exemption", () => {
  const d = dir();
  const agents = agentsDir(TASK_MAX_DEFS);
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: NO_TASK_MAX, table: { cells: "task-high,task-max", rows: {} } })], d);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^tier-roles: .*table\.json: router table: `cells` is not an array of cell names/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  assert.equal(r.stdout, "");
});

test("CLI: a --table that is missing or not JSON refuses naming the path", () => {
  const d = dir();
  const agents = agentsDir(TASK_MAX_DEFS);
  const notJson = join(d, "not-json.json");
  writeFileSync(notJson, "{ not json");
  for (const path of [join(d, "nope.json"), notJson]) {
    const r = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: NO_TASK_MAX, tablePath: path })], d);
    assert.equal(r.status, 2, path);
    assert.ok(r.stderr.trimStart().startsWith(`tier-roles: cannot read the router table ${path}: `), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /, path);
    assert.equal(r.stdout, "", path);
  }
});

// A copy of the script and the three modules it imports, with `table` as the
// router-table.json beside it (null leaves none), so the default table is the
// one under test.
function copiedScript(d, table) {
  const scripts = join(d, "scripts");
  mkdirSync(scripts);
  for (const f of ["tier-roles.mjs", "arg.mjs", "is-cli.mjs", "ledger-grammar.mjs"]) copyFileSync(join(SCRIPTS_DIR, f), join(scripts, f));
  if (table !== null) writeFileSync(join(scripts, "router-table.json"), JSON.stringify(table));
  return join(scripts, "tier-roles.mjs");
}

test("CLI: without --table the router table is router-table.json beside the script, and its absence refuses", () => {
  const agents = agentsDir(TASK_MAX_DEFS);
  const run = (table) => {
    const d = dir();
    const script = copiedScript(d, table);
    return { d, r: spawnSync(process.execPath, [script, "--check", "--agents", agents, ...installFlags(d, { catalog: NO_TASK_MAX, table: null })], { cwd: d, encoding: "utf8" }) };
  };
  assert.equal(run(TABLE).r.status, 0, "task-max absent from the beside-the-script table is a notice");
  const listed = run({ ...TABLE, cells: [...TABLE.cells, "task-max"] }).r;
  assert.equal(listed.status, 1, "task-max listed in the beside-the-script table is a violation");
  const missing = run(null);
  assert.equal(missing.r.status, 2);
  assert.match(missing.r.stderr, /^tier-roles: cannot read the router table .*scripts\/router-table\.json: ENOENT/m);
});

test("CLI: a --catalog that is not a JSON object refuses by flag", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: [] })], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--catalog .*catalog\.json must be a JSON object, got an array/);
});

test("CLI: a --catalog file holding null refuses as null, not as object", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { catalog: null })], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--catalog .*catalog\.json must be a JSON object, got null$/m);
});

test("CLI: --check without --in-flight is a usage error", () => {
  const d = dir();
  const r = runCli(["--check"], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--in-flight is required with --check/);
  assert.equal(r.stdout, "");
});

test("CLI: --check and --in-flight are required", () => {
  const d = dir();
  const r = runCli([], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--check --in-flight/);
});

test("CLI: an unknown flag refuses by name", () => {
  const d = dir();
  const r = runCli(["--check", "--in-flight", "5", "--bogus", "x"], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --bogus/);
});

test("CLI: --agents defaults to the plugin's own agents directory", () => {
  const d = dir();
  const r = runCli(["--check", ...installFlags(d)], d);
  assert.equal(r.status, 0, r.stderr);
});

// A fake `omp` first on PATH running `script` — the live reads
// (`omp config get … --json`, `omp models --json`) have no flag-free fixture
// path, so the binary itself is the fixture. It is called `omp <subcommand>
// <key> --json`, so a script can answer by `$3`.
function runCliWithOmpScript(script, argv, cwd) {
  const bin = dir();
  const fake = join(bin, "omp");
  writeFileSync(fake, `#!/bin/sh\n${script}\n`);
  chmodSync(fake, 0o755);
  return runCli(argv, cwd, { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` });
}

// A fake `omp` whose every invocation prints `stdout`.
function runCliWithFakeOmp(stdout, argv, cwd) {
  return runCliWithOmpScript(`cat <<'FAKE_OMP_EOF'\n${stdout}\nFAKE_OMP_EOF`, argv, cwd);
}

// What an `omp` read may print that is JSON yet not an object, with the shape
// the refusal names.
const NON_OBJECTS = [["null", "null"], ["an array", "[]"], ["a string", "\"x\""], ["a number", "42"], ["a boolean", "true"]];

for (const [shape, printed] of NON_OBJECTS) {
  test(`CLI: live \`omp config get\` printing ${shape} refuses naming the command`, () => {
    const d = dir();
    const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
    const r = runCliWithFakeOmp(printed, ["--check", "--in-flight", "5", "--agents", agents, "--max-concurrency", jsonFile(d, "mc.json", 32), "--model-roles", jsonFile(d, "mr.json", MODEL_ROLES), "--catalog", jsonFile(d, "c.json", CATALOG)], d);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`omp config get task\\.agentModelOverrides --json exited 0 but printed ${shape}, not a JSON object`));
  });
}

for (const [shape, printed] of NON_OBJECTS) {
  test(`CLI: live \`omp models\` printing ${shape} refuses naming the command`, () => {
    const d = dir();
    const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
    const r = runCliWithFakeOmp(printed, ["--check", "--in-flight", "5", "--agents", agents, "--max-concurrency", jsonFile(d, "mc.json", 32), "--overrides", jsonFile(d, "o.json", {}), "--model-roles", jsonFile(d, "mr.json", MODEL_ROLES)], d);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`omp models --json exited 0 but printed ${shape}, not a JSON object`));
  });
}

test("CLI: live `omp config get` envelope holding a null value refuses as null, not as object", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCliWithFakeOmp("{\"value\":null}", ["--check", "--in-flight", "5", "--agents", agents, "--max-concurrency", jsonFile(d, "mc.json", 32), "--model-roles", jsonFile(d, "mr.json", MODEL_ROLES), "--catalog", jsonFile(d, "c.json", CATALOG)], d);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /omp config get task\.agentModelOverrides --json must be a JSON object, got null$/m);
});

test("CLI: live `omp` reads printing well-formed objects are accepted", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  // One fake serves all three reads: `{ value, models }` satisfies the config
  // envelope and the catalog at once; each config read then takes `value` as its record.
  const printed = JSON.stringify({ value: {}, models: CATALOG.models });
  const r = runCliWithFakeOmp(printed, ["--check", "--in-flight", "5", "--agents", agents, "--max-concurrency", jsonFile(d, "mc.json", 32)], d);
  assert.notEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /not a JSON object/);
});

test("CLI: live `omp` reads printing an empty object are not refused by the readOmpJson guard", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCliWithFakeOmp("{}", ["--check", "--in-flight", "5", "--agents", agents, "--max-concurrency", jsonFile(d, "mc.json", 32)], d);
  assert.doesNotMatch(r.stderr, /exited 0 but printed/);
});

// ---------------------------------------------------------------------------
// semaphoreNotice — the phase-0 `task.maxConcurrency` notice
// ---------------------------------------------------------------------------

const NOTICE_8_AT_5 = "task.maxConcurrency is 8, below 2·5+2 = 12 for In-flight bound 5 — omp queues members past it, so a Pulled implementer may sit unstarted; raise it in omp config (the fleet never writes it)";

test("semaphoreNotice: below 2·B+2 names c, B and the threshold", () => {
  assert.equal(semaphoreNotice({ inFlight: 5, read: { ok: true, value: 8 } }), NOTICE_8_AT_5);
  assert.equal(semaphoreNotice({ inFlight: 5, read: { ok: true, value: 11 } }), NOTICE_8_AT_5.replace("is 8,", "is 11,"));
});

test("semaphoreNotice: the threshold is 2·B+2 for the B it is given", () => {
  assert.equal(semaphoreNotice({ inFlight: 1, read: { ok: true, value: 3 } }), "task.maxConcurrency is 3, below 2·1+2 = 4 for In-flight bound 1 — omp queues members past it, so a Pulled implementer may sit unstarted; raise it in omp config (the fleet never writes it)");
  assert.equal(semaphoreNotice({ inFlight: 1, read: { ok: true, value: 4 } }), null);
  assert.equal(semaphoreNotice({ inFlight: 5, read: { ok: true, value: 12 } }), null);
  assert.equal(semaphoreNotice({ inFlight: 5, read: { ok: true, value: 32 } }), null);
});

test("semaphoreNotice: 0 is unbounded and prints nothing", () => {
  assert.equal(semaphoreNotice({ inFlight: 5, read: { ok: true, value: 0 } }), null);
});

test("semaphoreNotice: a read that failed is an unreadable notice carrying why", () => {
  assert.equal(
    semaphoreNotice({ inFlight: 5, read: { ok: false, why: "boom" } }),
    "task.maxConcurrency unreadable — boom; In-flight bound 5 is unchecked against it",
  );
});

test("semaphoreNotice: a multi-line why (omp's raw stderr) still yields one line", () => {
  const line = semaphoreNotice({ inFlight: 5, read: { ok: false, why: "omp config get task.maxConcurrency --json failed: Unknown setting: x\n\nRun omp config list\n" } });
  assert.equal(line, "task.maxConcurrency unreadable — omp config get task.maxConcurrency --json failed: Unknown setting: x Run omp config list; In-flight bound 5 is unchecked against it");
});

// What a read can hold that is not a non-negative integer, with what the
// notice quotes back.
for (const [value, quoted] of [[-1, "-1"], [1.5, "1.5"], ["8", "\"8\""], [null, "null"], [{}, "{}"], [undefined, "no value"]]) {
  test(`semaphoreNotice: a value of ${quoted} is unreadable, not a number`, () => {
    assert.equal(
      semaphoreNotice({ inFlight: 5, read: { ok: true, value } }),
      `task.maxConcurrency unreadable — not a non-negative integer (got ${quoted}); In-flight bound 5 is unchecked against it`,
    );
  });
}

function noticeLines(stdout) {
  return stdout.split("\n").filter((l) => l.startsWith("tier-roles: notice: "));
}

test("CLI: semaphore notice, the ruled line, on stdout after the pass line when task.maxConcurrency is below 2·B+2", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: jsonFile(d, "mc.json", 8) })], d);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(noticeLines(r.stdout), [`tier-roles: notice: ${NOTICE_8_AT_5}`]);
});

for (const c of [12, 32, 0]) {
  test(`CLI: no semaphore notice when task.maxConcurrency is ${c}`, () => {
    const d = dir();
    const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
    const r = runCli(["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: jsonFile(d, "mc.json", c) })], d);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(noticeLines(r.stdout), []);
  });
}

// The three ways the read itself can fail, each with its own why: a file that
// is not JSON, a file that is not there, and a value that parses but is no
// number. jsonFile() would write the last kind as a valid JSON string, so the
// first two are written or pointed at directly.
test("CLI: semaphore notice when the --max-concurrency file is not JSON", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const bad = join(d, "bad.json");
  writeFileSync(bad, "{invalid");
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: bad })], d);
  assert.equal(r.status, 0, r.stderr);
  const [line, ...rest] = noticeLines(r.stdout);
  assert.deepEqual(rest, []);
  assert.match(line, /^tier-roles: notice: task\.maxConcurrency unreadable — .*JSON.*; In-flight bound 5 is unchecked against it$/);
  assert.doesNotMatch(line, /not a non-negative integer/);
});

test("CLI: semaphore notice when the --max-concurrency file is missing", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: join(d, "nope.json") })], d);
  assert.equal(r.status, 0, r.stderr);
  const [line, ...rest] = noticeLines(r.stdout);
  assert.deepEqual(rest, []);
  assert.match(line, /^tier-roles: notice: task\.maxConcurrency unreadable — ENOENT: no such file or directory.*; In-flight bound 5 is unchecked against it$/);
});

test("CLI: semaphore notice when the --max-concurrency file holds a string", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: jsonFile(d, "mc.json", "{invalid}") })], d);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(noticeLines(r.stdout), ["tier-roles: notice: task.maxConcurrency unreadable — not a non-negative integer (got \"{invalid}\"); In-flight bound 5 is unchecked against it"]);
});

// With no --max-concurrency the notice reads the live install. This fake
// answers only `task.maxConcurrency` and refuses every other key, so a read
// of a different key fails the test; the other three reads take fixtures.
test("CLI: with no --max-concurrency the notice reads the live task.maxConcurrency", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCliWithOmpScript(
    "case \"$3\" in task.maxConcurrency) echo '{\"value\":8}' ;; *) echo \"Unknown setting: $3\" >&2; exit 1 ;; esac",
    ["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: null })],
    d,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(noticeLines(r.stdout), [`tier-roles: notice: ${NOTICE_8_AT_5}`]);
});

test("CLI: a failed live task.maxConcurrency read is one unreadable line, whatever omp's stderr spans", () => {
  const d = dir();
  const agents = agentsDir({ "fleet-a": "@slow:xhigh" });
  const r = runCliWithOmpScript(
    "printf 'Unknown setting: x\\n\\nRun omp config list\\n' >&2; exit 1",
    ["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: null })],
    d,
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  assert.equal(lines[1], "tier-roles: notice: task.maxConcurrency unreadable — omp config get task.maxConcurrency --json failed: Unknown setting: x Run omp config list; In-flight bound 5 is unchecked against it");
});

test("CLI: with a violation the notice goes to stderr, stdout stays empty, and the exit stays 1", () => {
  const d = dir();
  // A definition whose `model:` is not a route.
  const agents = agentsDir({ "fleet-bad": "no agent here" });
  const r = runCli(["--check", "--agents", agents, ...installFlags(d, { maxConcurrencyPath: jsonFile(d, "mc.json", 8) })], d);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.deepEqual(noticeLines(r.stderr), [`tier-roles: notice: ${NOTICE_8_AT_5}`]);
});

test("CLI: --in-flight 0 is a usage error and prints nothing on stdout", () => {
  const d = dir();
  const r = runCli(["--check", ...installFlags(d, { inFlight: "0" })], d);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--in-flight must be at least 1, got 0/);
});

// Digits, not a `Number()` coercion: each of these coerces to a number, and
// `1e1` would have been read as a bound of 10.
for (const raw of ["abc", "1e1", "0x5", " 5", "5.0", "+5"]) {
  test(`CLI: --in-flight ${JSON.stringify(raw)} is a usage error and prints nothing on stdout`, () => {
    const d = dir();
    const r = runCli(["--check", ...installFlags(d, { inFlight: raw })], d);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /--in-flight needs a number, got /);
  });
}
