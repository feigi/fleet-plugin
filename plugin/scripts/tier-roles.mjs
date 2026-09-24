#!/usr/bin/env node
// omp tier routing (ADR 0011). `model: opus|sonnet|haiku` in an agent
// definition is a bare vendor alias that resolves directly on Claude Code —
// on omp, the same key is a fuzzy model selector, and an install with no
// Anthropic model configured fails preflight outright. omp's own lever for
// this is roles (`modelRoles.slow/task/smol`, `@role` aliases) plus the
// per-agent setting `task.agentModelOverrides[agentName]`, which is
// model-precedence #1 for task/eval dispatch. This file is the one place the
// tier->role map lives, the generator that derives every definition's
// override from it, and the checker that verifies the operator's
// `task.agentModelOverrides`/`modelRoles` against what the fleet's
// definitions actually need — read-only, never `omp config set`.
//
// The explicit `:<level>` suffix on every generated override is deliberate:
// `modelRoles.<role>` values carry their own baked suffix (measured
// `smol: anthropic/claude-haiku-4-5:auto` on a real install) and an explicit
// suffix on the REFERRING alias wins over the role's own baked one — so
// `@smol:low` on the override beats the role's `:auto` default.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeDie, makeArg, makeHas, makeSweep, makeStray } from "./arg.mjs";

const NAME = "tier-roles";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// pure core — unit-tested directly (tier-roles.test.mjs), no filesystem or
// process access below this line until main()
// ---------------------------------------------------------------------------

// The fixed tier->role map (user-confirmed). An operator wanting a different
// target model changes `modelRoles`, never this map — this is the only place
// it lives.
export const OMP_ROLE_FOR_MODEL = { opus: "slow", sonnet: "task", haiku: "smol" };

// Frontmatter reader — MOVED here (not duplicated) from tier-check.mjs, which
// now imports it: both the generator here and the dispatch-time compare in
// tier-check.mjs need the same three fields off the same five-key frontmatter
// shape implementer-model-tier.test.mjs pins independently for the
// declaration's own prose-adjacent contract.
export function parseFrontmatter(agentFileText) {
  const fm = String(agentFileText ?? "").split("---")[1] ?? "";
  const field = (key) => new RegExp(`^${key}:\\s*(\\S+)$`, "m").exec(fm)?.[1] ?? null;
  return { model: field("model"), effort: field("effort"), thinkingLevel: field("thinking-level") };
}

function nameField(agentFileText) {
  const fm = String(agentFileText ?? "").split("---")[1] ?? "";
  return /^name:\s*(\S+)$/m.exec(fm)?.[1] ?? null;
}

// One definition's frontmatter -> the omp override string it needs, or
// `null` when this cannot be routed at all (an unrecognised model, or no
// `thinking-level:` to carry as the explicit suffix). `null` is a refusal
// signal for the caller, never a default.
export function ompOverrideFor(frontmatter) {
  const role = OMP_ROLE_FOR_MODEL[frontmatter?.model];
  if (!role || !frontmatter?.thinkingLevel) return null;
  return `@${role}:${frontmatter.thinkingLevel}`;
}

// Every `*.agent.md` under `agentsDir` -> `{ [name]: override }`. A
// definition this cannot route (`ompOverrideFor` returns `null`, or the
// file's own `name:` is missing) is a refusal, never a skipped file: an
// operator who read a clean generator output and set exactly that has no way
// to know a definition was silently dropped.
export function expectedOverrides(agentsDir) {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md")).sort();
  const out = {};
  for (const file of files) {
    const text = readFileSync(join(agentsDir, file), "utf8");
    const name = nameField(text);
    if (!name) throw new Error(`${file}: missing name: in frontmatter`);
    const frontmatter = parseFrontmatter(text);
    const override = ompOverrideFor(frontmatter);
    if (override === null) {
      throw new Error(`${file}: model ${JSON.stringify(frontmatter.model)}/thinking-level ${JSON.stringify(frontmatter.thinkingLevel)} cannot be routed to an omp role`);
    }
    out[name] = override;
  }
  return out;
}

// Removes a trailing `:<level>` (`claude-opus-5:high` -> `claude-opus-5`);
// never touches the provider `/` (`anthropic/claude-opus-5` is untouched
// past its own colon-free tail).
export function stripLevel(selector) {
  return String(selector ?? "").replace(/:[^:/]*$/, "");
}

// One role's `modelRoles` entry -> the model identity it ultimately names,
// following an `@other-role` alias chain (a role may point at another role,
// omp://models.md) until a bare model is reached. `null` when the role is
// unset, empty, non-string, or the chain is longer than 8 hops (a cycle a
// human config could otherwise hang this on).
export function resolveRole(role, modelRoles, depth = 0) {
  if (depth > 8) return null;
  const raw = modelRoles?.[role];
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.startsWith("@")) return resolveRole(stripLevel(raw.slice(1)), modelRoles, depth + 1);
  return stripLevel(raw);
}

// A declared alias (`opus`/`sonnet`/`haiku`) -> the role it routes through on
// omp and the model that role currently resolves to (or `null` for either
// half when the alias is unrecognised or the role is unset).
export function expectedOmpModel(declaredModel, modelRoles) {
  const role = OMP_ROLE_FOR_MODEL[declaredModel] ?? null;
  return { role, model: role ? resolveRole(role, modelRoles) : null };
}

// Tolerates a role value written without its provider prefix — omp's
// `resolvedModelIdentity` is always provider-prefixed, a plain `modelRoles`
// entry may not be.
export function modelsEqual(a, b) {
  const sa = stripLevel(a);
  const sb = stripLevel(b);
  return sa === sb || sa.endsWith("/" + sb) || sb.endsWith("/" + sa);
}

// Exact double-quoted YAML block for `task.agentModelOverrides`, sorted by
// agent name so the output (and any diff against it) is stable.
export function formatYaml(overrides) {
  const lines = ["task:", "  agentModelOverrides:"];
  for (const name of Object.keys(overrides).sort()) {
    lines.push(`    ${name}: "${overrides[name]}"`);
  }
  return lines.join("\n") + "\n";
}

// `omp config get <key> --json` reads the MERGED effective value (built-in
// defaults, global config, project settings, `--config` overlays, runtime
// overrides — pool-preflight.mjs's own header) — `modelRoles.slow` dotted
// into a record is `Unknown setting` on this box, so a record-valued key is
// always read whole. Never writes.
export function readOmpConfigValue(key) {
  try {
    const out = execFileSync("omp", ["config", "get", key, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out).value;
  } catch (e) {
    throw new Error(`omp config get ${key} --json failed: ${e.stderr || e.message}`);
  }
}

// The role names in the order a violation/notice about them should print —
// matches the map's own declaration order (slow, task, smol).
const ROLE_ORDER = ["slow", "task", "smol"];

// The role an `expectedOverrides` value routes through, parsed back off the
// override string (`@slow:xhigh` -> `slow`) rather than re-deriving it from
// a model name, so this stays correct even for a hand-edited `expected` (the
// CLI's `--overrides`/`--model-roles` test seams pass raw JSON, not agent
// frontmatter).
function roleOf(override) {
  return /^@([a-z]+):/.exec(override)?.[1] ?? null;
}

// The operator's `task.agentModelOverrides`/`modelRoles` against what the
// fleet's own definitions need. `violations` stop a run (ADR 0011); `notices`
// never do — they flag a hazard (the alt-tier pairing controlling nothing)
// that is legal configuration, just probably not what the operator meant.
export function checkOverrides({ expected, actual, modelRoles, agentsDir }) {
  const violations = [];
  const notices = [];

  for (const name of Object.keys(expected)) {
    if (actual?.[name] !== expected[name]) {
      const got = actual?.[name] === undefined ? "absent" : JSON.stringify(actual[name]);
      violations.push(`${name}: expected "${expected[name]}", got ${got}`);
    }
  }

  for (const name of Object.keys(actual ?? {})) {
    if (name.startsWith("fleet-") && !(name in expected)) {
      violations.push(`${name}: stale override ${JSON.stringify(actual[name])} — no such definition under ${agentsDir}`);
    }
  }

  const usedRoles = new Set(Object.values(expected).map(roleOf).filter(Boolean));
  for (const role of ROLE_ORDER) {
    if (usedRoles.has(role) && resolveRole(role, modelRoles) === null) {
      violations.push(`modelRoles.${role}: unset — @${role} would fall through to the parent's model`);
    }
  }

  const slowModel = resolveRole("slow", modelRoles);
  const taskModel = resolveRole("task", modelRoles);
  if (slowModel !== null && taskModel !== null && modelsEqual(slowModel, taskModel)) {
    notices.push(`modelRoles.slow and modelRoles.task both resolve to ${slowModel} — the per-wave alternate-tier pairing controls nothing`);
  }

  return { violations, notices };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const arg = makeArg(die);
const has = makeHas(die);
const sweep = makeSweep(die);
const stray = makeStray(die);

function loadJsonObject(path, configKey, flagName) {
  let value;
  try {
    value = path ? JSON.parse(readFileSync(path, "utf8")) : readOmpConfigValue(configKey);
  } catch (e) {
    die(e.message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const source = path ? `--${flagName} ${path}` : `omp config get ${configKey} --json`;
    die(`${source} must be a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`);
  }
  return value;
}

function main() {
  sweep(["json", "check", "agents", "overrides", "model-roles"]);
  stray(["agents", "overrides", "model-roles"]);

  const agentsDir = arg("agents") ?? join(SCRIPT_DIR, "..", "agents");
  const json = has("json");
  const check = has("check");

  if (json && check) die("--json prints the block; it has no meaning with --check");

  let expected;
  try {
    expected = expectedOverrides(agentsDir);
  } catch (e) {
    die(e.message);
  }

  if (!check) {
    if (json) {
      console.log(JSON.stringify(expected));
    } else {
      process.stdout.write(formatYaml(expected));
    }
    process.exit(0);
  }

  const overridesPath = arg("overrides");
  const modelRolesPath = arg("model-roles");
  const actual = loadJsonObject(overridesPath, "task.agentModelOverrides", "overrides");
  const modelRoles = loadJsonObject(modelRolesPath, "modelRoles", "model-roles");

  const { violations, notices } = checkOverrides({ expected, actual, modelRoles, agentsDir });

  if (violations.length === 0) {
    for (const name of Object.keys(expected).sort()) {
      const role = roleOf(expected[name]);
      console.log(`tier-roles: ${name} → ${expected[name]} = ${resolveRole(role, modelRoles)}`);
    }
    for (const n of notices) console.log(`tier-roles: notice: ${n}`);
    process.exit(0);
  }

  for (const v of violations) console.error(`tier-roles: ${v}`);
  console.error(`tier-roles: remedy: omp config set task.agentModelOverrides '${JSON.stringify(expected)}'`);
  for (const n of notices) console.error(`tier-roles: notice: ${n}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
