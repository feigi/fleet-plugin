#!/usr/bin/env node
// omp tier routing. `model: "@<role>:<level>"` in an
// agent definition is a fleet tier route — never a vendor id — resolved
// through the operator's `modelRoles.slow|task|smol`, with the explicit
// `:<level>` suffix on the REFERRING alias winning over the role's own
// baked one (`modelRoles.<role>` values carry their own baked suffix,
// measured `smol: anthropic/claude-haiku-4-5:auto` on a real install).
//
// This file is CHECK-ONLY: there is no generator and no
// operator-side override record to derive any more — `model:` in the
// definition IS the route, and omp resolves the `@<role>` alias through
// `modelRoles` natively (`omp://task-agent-discovery.md`). What is left to
// verify, read-only, never `omp config set`:
//   (a) every definition's `model:` is a well-formed route
//       (`@slow|@task|@smol:<level>`);
//   (b) every role a definition uses has a `modelRoles.<role>` that
//       resolves to a model;
//   (c) no `task.agentModelOverrides` entry shadows a fleet definition —
//       that config is model-precedence #1 for task/eval dispatch,
//       so a leftover `fleet-*` key there would silently win over
//       the definition's own `model:`, and that config is retired as a lever;
//   (d) every definition's `:<level>` is one its role's current target
//       runs at — in that model's `thinking` efforts in omp's own model
//       catalog (`omp models --json`). omp clamps an unsupported level
//       silently (`claude-haiku-4-5` has no `max`, so `@smol:max` would run
//       at something else), tier-check would then read a level the
//       definition never declared, and every row the definition ran would
//       be inadmissible. The one exception is an implementer definition
//       whose cell the router never selects (not in the router table's
//       `cells`, in no row of either objective's `rows` set, and not the
//       policy cell): a cell can be defined before the router may pick it,
//       so its mismatch is a notice. The router table is `router-table.json`
//       beside this script, or the file `--table <path>` names; one that
//       cannot be read, or that lacks a `cells` array or a `rows` object of
//       row sets of cell names, refuses. A target the catalog does not list cannot be checked, so it
//       fails too;
//   (e) `modelRoles.slow`/`modelRoles.task` resolving to the same model is
//       flagged as a notice — legal, but every `slow-*` cell then measures
//       the same model as its `task-*` twin;
//   (f) the agents directory holds at least one `*.agent.md` definition —
//       with none, (a), (b) and (d) have nothing to check; an agents
//       directory that cannot be read (missing, not a directory) or a
//       definition that cannot be read (a directory named `*.agent.md`)
//       fails too;
//   (g) `--in-flight <B>`, required under `--check`: omp's
//       `task.maxConcurrency` below 2·B+2, or one that cannot be read, is a
//       notice (`0` is unbounded and prints none). The value is read live
//       with `omp config get`, or from the file `--max-concurrency <path>`
//       names, which takes its place when given. A notice never changes the
//       exit code.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { CELL_DEF, POLICY_CELL } from "./ledger-grammar.mjs";

const NAME = "tier-roles";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// pure core — unit-tested directly, no filesystem or
// process access below this line until main()
// ---------------------------------------------------------------------------

// Role names in print order — a fixed list, not derived from anything: making
// omp the only harness retired the tier->role map this used to come from
// (OMP_ROLE_FOR_MODEL with its opus/sonnet/haiku keys), and the fleet only
// ever names these three roles.
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

// A definition file name -> the implementer cell it is (`task-max` for
// `fleet-implementer-task-max.agent.md`), `null` for any other definition,
// including one whose name is not a cell.
export function implementerCell(file) {
  const name = file.replace(/\.agent\.md$/, "");
  return CELL_DEF.test(name) ? name.slice("fleet-implementer-".length) : null;
}

// The cells the router can select from a parsed router table: the pool it
// explores (`cells`), the cell each row of each objective's set names (`rows`
// values) and the policy cell, which every Pull falls back to whatever the
// table says. An Error saying why when the table lacks a `cells` array of
// names or a `rows` object of row sets of names — a table that cannot be read
// must refuse, never quietly make every cell non-routable.
export function routableCells(table) {
  const bad = (why) => new Error(`router table: ${why}`);
  if (!isJsonObject(table)) return bad("not a JSON object");
  if (!Array.isArray(table.cells) || !table.cells.every((c) => typeof c === "string")) return bad("`cells` is not an array of cell names");
  const sets = isJsonObject(table.rows) ? Object.values(table.rows) : null;
  if (sets === null || !sets.every((set) => isJsonObject(set) && Object.values(set).every((c) => typeof c === "string"))) {
    return bad("`rows` is not an object of row sets of cell names");
  }
  return new Set([POLICY_CELL, ...table.cells, ...sets.flatMap((set) => Object.values(set))]);
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
// overrides — measured for the retired pool-preflight.mjs) —
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

// A plain JSON object — not null, an array or a scalar. Every read here
// dereferences the parsed value (`.value`, `.models`), so anything else is
// refused where it is read, naming its source.
function isJsonObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readOmpJson(argv) {
  const cmd = `omp ${argv.join(" ")}`;
  let out;
  try {
    out = execFileSync("omp", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`${cmd} failed: ${e.stderr || e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`${cmd} exited 0 but printed non-JSON: ${e.message}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${cmd} exited 0 but printed ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`}, not a JSON object`);
  }
  return parsed;
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
// frontmatter-allowlist.json's agents `name` pattern (`^fleet-[^:]*$`).
// It is the only way to tell a fleet-owned `task.agentModelOverrides`
// entry (a pre-cutover install can still carry one — the config is retired
// as a lever, not cleared) from the operator's own entry,
// which this check never touches.
const FLEET_NAME_PREFIX = "fleet-";

// POSIX single-quoting for a printed command line: the remedy carries the
// operator's own override values, which this file never chose.
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// What a malformed catalog value is, for a refusal that names the shape.
function kindOf(v) {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

// The operator's install (`modelRoles`, omp's model `catalog`, and any
// leftover `task.agentModelOverrides`) against what the fleet's own
// definitions need. `violations` stop a run; `notices` never do —
// they flag a hazard (two roles' cells measuring one model) that is legal
// configuration, just probably not what the operator meant. `routable` is
// the set `routableCells` returns: the router never selects an implementer
// definition outside it, so an unsupported level there is a notice; `null`
// is no table at all, and then every definition is held to the level check.
export function checkRoutes({ agentsDir, agentsSource = `--agents ${agentsDir}`, modelRoles, overrides, catalog, routable = null }) {
  const violations = [];
  const notices = [];
  const usedBy = {}; // role -> [{ file, level }, ...]

  // A path `readdirSync`/`readFileSync` cannot read (missing, a regular file,
  // a directory named `*.agent.md`, no permission) is a wrong agents
  // directory, not a crash: name the path and where it came from
  // (`agentsSource` — `--agents <dir>`, or the built-in default).
  const unreadable = (what, e) => `${agentsSource}: cannot read ${what} (${e.code ?? e.message})`;
  let files = [];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md")).sort();
    // A directory with no definitions has nothing to route, so every
    // per-definition check below (the model route, the role's resolution, the
    // level) would pass over it — a wrong `--agents` path that exists must not
    // read as a healthy install.
    if (files.length === 0) violations.push(`no *.agent.md definition found in ${agentsDir}`);
  } catch (e) {
    violations.push(unreadable("the agents directory", e));
  }
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(agentsDir, file), "utf8");
    } catch (e) {
      violations.push(unreadable(file, e));
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm.role || !fm.level) {
      violations.push(`${file}: model ${JSON.stringify(fm.model)} is not @<role>:<level>`);
      continue;
    }
    (usedBy[fm.role] ??= []).push({ file, level: fm.level });
  }

  // A catalog with no `models` list, or an entry whose `thinking` is neither a
  // list nor `null`, is a shape omp did not print — name it, rather than read
  // it as "not listed" or "runs at no level" and blame the operator's roles.
  const listed = Array.isArray(catalog?.models);
  if (!listed && Object.keys(usedBy).length > 0) {
    violations.push(`omp's model catalog has no models list (models: ${kindOf(catalog?.models)}) — cannot check the level of any definition`);
  }

  for (const role of ROLE_ORDER) {
    if (!usedBy[role]) continue;
    const users = usedBy[role].map((u) => u.file).join(", ");
    const model = resolveRole(role, modelRoles);
    if (model === null) {
      violations.push(`modelRoles.${role} is unset — needed by ${users}`);
      continue;
    }
    if (!listed) continue;
    const entry = catalogEntry(model, catalog);
    if (entry === null) {
      violations.push(`modelRoles.${role} resolves to ${model}, which omp's model catalog does not list — cannot check the level of ${users}`);
      continue;
    }
    if (entry.thinking !== null && !Array.isArray(entry.thinking)) {
      violations.push(`omp's model catalog lists ${model} with thinking that is neither a list nor null (${kindOf(entry.thinking)}) — cannot check the level of ${users}`);
      continue;
    }
    const efforts = entry.thinking ?? [];
    for (const { file, level } of usedBy[role]) {
      if (efforts.includes(level)) continue;
      const mismatch = `${file}: level ${level} is not one modelRoles.${role}'s target ${model} runs at (thinking: ${efforts.join(", ") || "none"})`;
      const cell = implementerCell(file);
      if (routable !== null && cell !== null && !routable.has(cell)) {
        notices.push(`${mismatch} — cell ${cell} is not one the router selects; omp would clamp this level silently once it does`);
      } else {
        violations.push(`${mismatch} — omp would clamp it silently`);
      }
    }
  }

  const overrideKeys = Object.keys(overrides ?? {});
  const fleetKeys = overrideKeys.filter((k) => k.startsWith(FLEET_NAME_PREFIX)).sort();
  if (fleetKeys.length > 0) {
    // The remedy writes the operator's non-fleet entries back in full because
    // `omp config set` replaces the whole `task.agentModelOverrides` record
    // rather than merging into it, and `omp config reset` empties it. Measured
    // on omp 18.4.10: setting {"other":"y"} over {"fleet-a":"x","other":"y"}
    // left exactly {"other":"y"}, and `reset` left {}.
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

// The phase-0 semaphore notice: omp's `task.maxConcurrency` against the
// In-flight bound. `read` is `{ ok: true, value }` or `{ ok: false, why }`.
// Returns the notice line, or null for `0` (unbounded) and `>= 2·B+2`. A
// notice never changes the exit code, so a value that cannot be read is a
// line too, not a refusal.
export function semaphoreNotice({ inFlight, read }) {
  const unreadable = (why) => `task.maxConcurrency unreadable — ${why}; In-flight bound ${inFlight} is unchecked against it`;
  // `why` can be omp's raw stderr, which ends in a newline and may span
  // lines; a notice is one line.
  if (!read.ok) return unreadable(read.why.replace(/\s+/g, " ").trim());
  const c = read.value;
  if (!Number.isInteger(c) || c < 0) return unreadable(`not a non-negative integer (got ${c === undefined ? "no value" : JSON.stringify(c)})`);
  const threshold = 2 * inFlight + 2;
  if (c === 0 || c >= threshold) return null;
  return `task.maxConcurrency is ${c}, below 2·${inFlight}+2 = ${threshold} for In-flight bound ${inFlight} — omp queues members past it, so a Pulled implementer may sit unstarted; raise it in omp config (the fleet never writes it)`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const { arg, numArg, has, sweep, stray } = defineFlags(die, {
  flags: {
    check: "bool",
    "in-flight": "value",
    agents: "value",
    overrides: "value",
    "model-roles": "value",
    catalog: "value",
    table: "value",
    "max-concurrency": "value",
  },
});

// The `task.maxConcurrency` read `semaphoreNotice` formats: the
// `--max-concurrency <path>` fixture (a file holding the bare JSON value)
// when given, else the live `omp config get` read. A read that throws is a
// result, not a refusal — the notice says it was unreadable and the exit
// code is the role check's either way.
function readMaxConcurrency(path) {
  try {
    return { ok: true, value: path === null ? readOmpConfigValue("task.maxConcurrency") : JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// `--<flagName> <path>` when given, else the live install read `readLive()`
// performs (`source` names it in a refusal).
function loadJsonObject(path, readLive, source, flagName) {
  let value;
  try {
    value = path ? JSON.parse(readFileSync(path, "utf8")) : readLive();
  } catch (e) {
    die(e.message);
  }
  if (!isJsonObject(value)) {
    die(`${path ? `--${flagName} ${path}` : source} must be a JSON object, got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`);
  }
  return value;
}

function main() {
  sweep();
  stray();

  const check = has("check");
  if (!check) die("--check --in-flight <B> is required (usage: tier-roles.mjs --check --in-flight <B> [--agents <dir>] [--model-roles <path>] [--overrides <path>] [--catalog <path>] [--table <path>] [--max-concurrency <path>])");

  // numArg() is the fleet's digits rule (arg.mjs): `0x5`, `1e1`, ` 5`, `5.0`
  // and `+5` are refused where `Number()` would have read a bound the caller
  // never wrote.
  const inFlightBound = numArg("in-flight");
  if (inFlightBound === null) die("--in-flight is required with --check");
  if (inFlightBound < 1) die(`--in-flight must be at least 1, got ${inFlightBound}`);

  const agentsFlag = arg("agents");
  const agentsDir = agentsFlag ?? join(SCRIPT_DIR, "..", "agents");
  const config = (key) => [() => readOmpConfigValue(key), `omp config get ${key} --json`];
  const overrides = loadJsonObject(arg("overrides"), ...config("task.agentModelOverrides"), "overrides");
  const modelRoles = loadJsonObject(arg("model-roles"), ...config("modelRoles"), "model-roles");
  const catalog = loadJsonObject(arg("catalog"), readOmpModelCatalog, "omp models --json", "catalog");
  const tablePath = arg("table") ?? join(SCRIPT_DIR, "router-table.json");
  let table;
  try {
    table = JSON.parse(readFileSync(tablePath, "utf8"));
  } catch (e) {
    die(`cannot read the router table ${tablePath}: ${e.message}`);
  }
  const routable = routableCells(table);
  if (routable instanceof Error) die(`${tablePath}: ${routable.message}`);

  const { violations, notices } = checkRoutes({
    agentsDir,
    agentsSource: agentsFlag === null ? `the default agents directory ${agentsDir}` : undefined,
    modelRoles,
    overrides,
    catalog,
    routable,
  });
  const notice = semaphoreNotice({ inFlight: inFlightBound, read: readMaxConcurrency(arg("max-concurrency")) });
  if (notice !== null) notices.push(notice);

  if (violations.length === 0) {
    console.log("tier-roles: every definition routes to a resolvable model at a level it runs, no shadowing override");
    for (const n of notices) console.log(`tier-roles: notice: ${n}`);
    process.exit(0);
  }

  for (const v of violations) console.error(`tier-roles: ${v}`);
  for (const n of notices) console.error(`tier-roles: notice: ${n}`);
  process.exit(1);
}

if (isCLI(import.meta.url)) main();
