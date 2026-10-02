#!/usr/bin/env node
// omp tier routing (ADR 0011, ADR 0014). `model: "@<role>:<level>"` in an
// agent definition is a fleet tier route — never a vendor id — resolved
// through the operator's `modelRoles.slow|task|smol`, with the explicit
// `:<level>` suffix on the REFERRING alias winning over the role's own
// baked one (`modelRoles.<role>` values carry their own baked suffix,
// measured `smol: anthropic/claude-haiku-4-5:auto` on a real install).
//
// This file is CHECK-ONLY (ADR 0014): there is no generator and no
// operator-side override record to derive any more — `model:` in the
// definition IS the route, and omp resolves the `@<role>` alias through
// `modelRoles` natively (`omp://task-agent-discovery.md`). What is left to
// verify, read-only, never `omp config set`:
//   (a) every definition's `model:` is a well-formed route
//       (`@slow|@task|@smol:<level>`);
//   (b) every role a definition uses has a `modelRoles.<role>` that
//       resolves to a model;
//   (c) no `task.agentModelOverrides` entry shadows a fleet definition —
//       that config is model-precedence #1 for task/eval dispatch (ADR
//       0011), so a leftover `fleet-*` key there would silently win over
//       the definition's own `model:`, which ADR 0014 retires as a lever;
//   (d) every definition's `:<level>` is one its role's current target
//       runs at — in that model's `thinking` efforts in omp's own model
//       catalog (`omp models --json`). omp clamps an unsupported level
//       silently (`claude-haiku-4-5` has no `max`, so `@smol:max` would run
//       at something else), tier-check would then read a level the
//       definition never declared, and every row the definition ran would
//       be inadmissible (spec 2026-09-28 § 2). A target the catalog does
//       not list cannot be checked, so it fails too;
//   (e) `modelRoles.slow`/`modelRoles.task` resolving to the same model is
//       flagged as a notice — legal, but every `slow-*` cell then measures
//       the same model as its `task-*` twin.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";

const NAME = "tier-roles";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// pure core — unit-tested directly (tier-roles.test.mjs), no filesystem or
// process access below this line until main()
// ---------------------------------------------------------------------------

// Role names in print order — a fixed list, not derived from anything: ADR
// 0014 retired the tier->role map this used to come from (OMP_ROLE_FOR_MODEL
// with its opus/sonnet/haiku keys), and the fleet only ever names these
// three roles.
const ROLE_ORDER = ["slow", "task", "smol"];

const MODEL_ROUTE_RE = /^@(slow|task|smol):(minimal|low|medium|high|xhigh|max)$/;

// Strips one matching pair of surrounding double or single quotes — YAML's
// own scalar quoting, needed because `model:` must be quoted in frontmatter
// (a bare leading `@` is not valid unquoted YAML).
function unquote(value) {
  const s = String(value ?? "");
  const m = /^"(.*)"$/.exec(s) || /^'(.*)'$/.exec(s);
  return m ? m[1] : s;
}

// A frontmatter `model:` value -> `{ role, level }`, both `null` when it is
// not a well-formed `@slow|@task|@smol:<level>` route.
export function parseModelRoute(value) {
  const m = MODEL_ROUTE_RE.exec(unquote(value));
  return m ? { role: m[1], level: m[2] } : { role: null, level: null };
}

// Reads a definition's frontmatter -> `{ model, role, level }`. `model` is
// the raw declared value (as written, quotes and all); `role`/`level` are
// parsed off its unquoted form and both `null` when `model` is missing or
// does not match `@<role>:<level>` — the shape tier-check.mjs's own
// dispatch-time compare imports this for.
export function parseFrontmatter(agentFileText) {
  const fm = String(agentFileText ?? "").split("---")[1] ?? "";
  const model = /^model:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? null;
  const { role, level } = model ? parseModelRoute(model) : { role: null, level: null };
  return { model, role, level };
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

// A declared route (`@slow:xhigh`/…) -> the role/level it carries and the
// model that role currently resolves to. `role`/`level` are `null` when the
// value is not a route at all; `model` is `null` when the role is unset (or
// the value is not a route).
export function expectedOmpModel(declaredModel, modelRoles) {
  const { role, level } = parseModelRoute(declaredModel);
  return { role, level, model: role ? resolveRole(role, modelRoles) : null };
}

// Tolerates a role value written without its provider prefix — omp's
// `resolvedModelIdentity` is always provider-prefixed, a plain `modelRoles`
// entry may not be.
export function modelsEqual(a, b) {
  const sa = stripLevel(a);
  const sb = stripLevel(b);
  return sa === sb || sa.endsWith("/" + sb) || sb.endsWith("/" + sa);
}

// `omp config get <key> --json` reads the MERGED effective value (built-in
// defaults, global config, project settings, `--config` overlays, runtime
// overrides — measured for the retired pool-preflight.mjs, #1588) —
// `modelRoles.slow` dotted into a record is `Unknown setting` on this box,
// so a record-valued key is always read whole. Never writes.
export function readOmpConfigValue(key) {
  return readOmpJson(["config", "get", key, "--json"]).value;
}

// omp's model catalog, `{ models: [{ selector, thinking, … }] }` — `selector`
// is `<provider>/<id>`, `thinking` the efforts the model runs at, `null` for
// a model with none (measured, omp 18: `anthropic/claude-haiku-4-5` →
// minimal…xhigh, `anthropic/claude-opus-5-5` → low…max). Never refreshes.
export function readOmpModelCatalog() {
  return readOmpJson(["models", "--json"]);
}

function readOmpJson(argv) {
  const cmd = `omp ${argv.join(" ")}`;
  let out;
  try {
    out = execFileSync("omp", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`${cmd} failed: ${e.stderr || e.message}`);
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`${cmd} exited 0 but printed non-JSON: ${e.message}`);
  }
}

// The catalog entry a `modelRoles` target names — `selector` exactly, else
// the first entry `modelsEqual` accepts (a role value written without its
// provider prefix). `null` when the catalog does not list it.
export function catalogEntry(model, catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return models.find((m) => m?.selector === model)
    ?? models.find((m) => typeof m?.selector === "string" && modelsEqual(model, m.selector))
    ?? null;
}

// Every fleet definition's `name:` carries this prefix — enforced in CI by
// frontmatter-allowlist.json's agents `name` pattern (`^fleet-[^:]*$`,
// #1303). It is the only way to tell a fleet-owned `task.agentModelOverrides`
// entry (a pre-cutover install can still carry one — ADR 0014 retires the
// config as a lever, it does not clear it) from the operator's own entry,
// which this check never touches.
const FLEET_NAME_PREFIX = "fleet-";

// POSIX single-quoting for a printed command line: the remedy carries the
// operator's own override values, which this file never chose.
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The operator's install (`modelRoles`, omp's model `catalog`, and any
// leftover `task.agentModelOverrides`) against what the fleet's own
// definitions need. `violations` stop a run (ADR 0014); `notices` never do —
// they flag a hazard (two roles' cells measuring one model) that is legal
// configuration, just probably not what the operator meant.
export function checkRoutes({ agentsDir, modelRoles, overrides, catalog }) {
  const violations = [];
  const notices = [];
  const usedBy = {}; // role -> [{ file, level }, ...]

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md")).sort();
  for (const file of files) {
    const text = readFileSync(join(agentsDir, file), "utf8");
    const fm = parseFrontmatter(text);
    if (!fm.role || !fm.level) {
      violations.push(`${file}: model ${JSON.stringify(fm.model)} is not @<role>:<level>`);
      continue;
    }
    (usedBy[fm.role] ??= []).push({ file, level: fm.level });
  }

  for (const role of ROLE_ORDER) {
    if (!usedBy[role]) continue;
    const model = resolveRole(role, modelRoles);
    if (model === null) {
      violations.push(`modelRoles.${role} is unset — needed by ${usedBy[role].map((u) => u.file).join(", ")}`);
      continue;
    }
    const entry = catalogEntry(model, catalog);
    if (entry === null) {
      violations.push(`modelRoles.${role} resolves to ${model}, which omp's model catalog does not list — cannot check the level of ${usedBy[role].map((u) => u.file).join(", ")}`);
      continue;
    }
    const efforts = Array.isArray(entry.thinking) ? entry.thinking : [];
    for (const { file, level } of usedBy[role]) {
      if (!efforts.includes(level)) {
        violations.push(`${file}: level ${level} is not one modelRoles.${role}'s target ${model} runs at (thinking: ${efforts.join(", ") || "none"}) — omp would clamp it silently`);
      }
    }
  }

  const overrideKeys = Object.keys(overrides ?? {});
  const fleetKeys = overrideKeys.filter((k) => k.startsWith(FLEET_NAME_PREFIX)).sort();
  if (fleetKeys.length > 0) {
    const nonFleet = Object.fromEntries(
      overrideKeys.filter((k) => !k.startsWith(FLEET_NAME_PREFIX)).map((k) => [k, overrides[k]]),
    );
    const remedy = Object.keys(nonFleet).length === 0
      ? "omp config reset task.agentModelOverrides"
      : `omp config set task.agentModelOverrides ${shellQuote(JSON.stringify(nonFleet))}`;
    for (const name of fleetKeys) {
      violations.push(`task.agentModelOverrides.${name} shadows the definition's own model (precedence #1) — remove it (${remedy})`);
    }
  }

  const slowModel = resolveRole("slow", modelRoles);
  const taskModel = resolveRole("task", modelRoles);
  if (slowModel !== null && taskModel !== null && modelsEqual(slowModel, taskModel)) {
    notices.push(`modelRoles.slow and modelRoles.task both resolve to ${slowModel} — every slow-* cell measures the same model as its task-* twin`);
  }

  return { violations, notices };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const { arg, has, sweep, stray } = defineFlags(die, {
  flags: {
    check: "bool",
    agents: "value",
    overrides: "value",
    "model-roles": "value",
    catalog: "value",
  },
});

// `--<flagName> <path>` when given, else the live install read `readLive()`
// performs (`source` names it in a refusal).
function loadJsonObject(path, readLive, source, flagName) {
  let value;
  try {
    value = path ? JSON.parse(readFileSync(path, "utf8")) : readLive();
  } catch (e) {
    die(e.message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    die(`${path ? `--${flagName} ${path}` : source} must be a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`);
  }
  return value;
}

function main() {
  sweep();
  stray();

  const check = has("check");
  if (!check) die("--check is required (usage: tier-roles.mjs --check [--agents <dir>] [--model-roles <path>] [--overrides <path>] [--catalog <path>])");

  const agentsDir = arg("agents") ?? join(SCRIPT_DIR, "..", "agents");
  const config = (key) => [() => readOmpConfigValue(key), `omp config get ${key} --json`];
  const overrides = loadJsonObject(arg("overrides"), ...config("task.agentModelOverrides"), "overrides");
  const modelRoles = loadJsonObject(arg("model-roles"), ...config("modelRoles"), "model-roles");
  const catalog = loadJsonObject(arg("catalog"), readOmpModelCatalog, "omp models --json", "catalog");

  const { violations, notices } = checkRoutes({ agentsDir, modelRoles, overrides, catalog });

  if (violations.length === 0) {
    console.log("tier-roles: every definition routes to a resolvable model at a level it runs, no shadowing override");
    for (const n of notices) console.log(`tier-roles: notice: ${n}`);
    process.exit(0);
  }

  for (const v of violations) console.error(`tier-roles: ${v}`);
  for (const n of notices) console.error(`tier-roles: notice: ${n}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
