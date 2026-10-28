#!/usr/bin/env node
// The Label map: the string the consumer's tracker uses for each Label role.
// This module owns the map's cache format — the file, its validity rules, the
// writer and the reader every role-reading script imports — and the verbs
// that read or derive it: `show`, and `ensure`, the derivation step that
// writes the map. Every refusal below names `ensure`.
//
// THE CACHE is `.fleet/labels.json`, resolved through fleet-dir.mjs's
// fleetFile() like the pre-flight marker, so a member in its own worktree and
// the controller in the main checkout name one file. `.fleet/` is gitignored,
// so the file is never committed, and it is never written by hand. Content:
//   derivedAt  ISO time of the derivation that wrote it
//   table      what the triage-label table said then: { present, rows: {role: string} }
//              (a role with two rows of different strings maps to the array of them)
//   roles      every Label role -> the string the tracker uses
//   origin     every Label role -> "table" | "default" | "maintainer"
//
// VALID STRINGS (labelStringFaults): non-empty after trimming, at most 50
// characters, no `"` and no `\`, and no two roles mapping to one string,
// compared ignoring case.
//
// THE READER (readLabelMap) returns `roles` when the cache parses, holds every
// Label role and passes the string rules; anything else throws
// LabelMapUnreadable. It never reads the tracker's live label list and has no
// defaults: an absent or broken map is a refusal, never a guess.
//
// THE WRITER (writeLabelMap) writes the whole cache to a temp file beside the
// target and renames it over the target, so a reader never sees half of it.
// It writes what it is handed: checking the map is its caller's step.
//
// CLI:
//   label-map.mjs ensure          the Label map derivation step. Reads the
//                                 cache, the repository's triage-label table
//                                 and the live label list (`gh label list`,
//                                 every call), and prints the map as JSON
//                                 (exit 0, writing the cache only when it
//                                 derived one), or the question payload as
//                                 JSON (exit 3, nothing written). It never
//                                 creates a label. Exit 1: the table breaks
//                                 the string rules, the message naming each
//                                 role, the rule and the fix. Exit 2: no
//                                 repository, the table not readable or
//                                 the cache not writable, `gh` could not
//                                 answer, the label list filled its limit,
//                                 or a usage refusal.
//   label-map.mjs show [<role>]   the mapped string for <role>, or the whole
//                                 `roles` object as JSON with no role.
//   Exit 0 printed; 1 no cache or an invalid one, the message naming `ensure`;
//   2 an unknown role, no repository, or a usage refusal (any other verb).
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCLI } from "./is-cli.mjs";
import { makeDie, writeAll } from "./arg.mjs";
import { DEFAULT_GIT_TIMEOUT_MS, gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";

const NAME = "label-map";
const die = makeDie(NAME);
const USAGE = "usage: label-map.mjs ensure | show [<role>]";
const MAX_LENGTH = 50;
const DERIVE = "run `label-map.mjs ensure`, the Label map derivation step";

export const LABEL_MAP_FILE = "labels.json";

export const LABEL_ROLES = Object.freeze([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "in-progress",
  "onhold",
  "ready-to-merge",
]);

export class LabelMapUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = "LabelMapUnreadable";
  }
}

// The rule a single string breaks on its own, or null.
function stringFault(value) {
  if (value === undefined) return "missing";
  if (typeof value !== "string") return `not a string (${JSON.stringify(value)})`;
  if (value.trim() === "") return "empty after trimming";
  if (value.length > MAX_LENGTH) return `longer than ${MAX_LENGTH} characters (${value.length})`;
  if (value.includes('"')) return 'contains `"`';
  if (value.includes("\\")) return "contains `\\`";
  return null;
}

/**
 * Every way `roles` (role -> string) breaks the Label map's string rules, as
 * `[{ role, rule }]` in role order; empty when it breaks none. A role absent
 * from `roles` is a fault too. Two roles mapping to one string, compared
 * ignoring case, is reported once, on the later role, its rule naming the
 * earlier one; a string that already breaks a rule on its own is not compared.
 */
export function labelStringFaults(roles) {
  const faults = [];
  const seen = new Map();
  for (const role of LABEL_ROLES) {
    const value = Object.hasOwn(roles, role) ? roles[role] : undefined;
    const rule = stringFault(value);
    if (rule) {
      faults.push({ role, rule });
      continue;
    }
    const key = value.toLowerCase();
    const first = seen.get(key);
    if (first) faults.push({ role, rule: `maps to the same string as ${first} (${JSON.stringify(value)}), compared ignoring case` });
    else seen.set(key, role);
  }
  return faults;
}

/**
 * Write `map` ({ derivedAt, table, roles, origin }) as the cache of the
 * repository `cwd` belongs to, through a temp file beside it, and return the
 * cache's path. Throws FleetDirUnresolvable outside a repository, and the
 * filesystem's own error when the file cannot be written.
 */
export function writeLabelMap(map, { cwd = process.cwd() } = {}) {
  const file = fleetFile(LABEL_MAP_FILE, { cwd });
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(map)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    // The write's own error is the one to report: a temp file that cannot be
    // removed (a directory in its place) must not replace it.
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  return file;
}

// The parsed cache of the repository `cwd` belongs to, with its path. Throws
// LabelMapUnreadable, its message naming `ensure`, when the file is absent,
// cannot be read or does not parse; FleetDirUnresolvable outside a repository.
function loadCache(cwd) {
  const file = fleetFile(LABEL_MAP_FILE, { cwd });
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new LabelMapUnreadable(`no Label map at ${file}: ${DERIVE}`);
    throw new LabelMapUnreadable(`cannot read the Label map at ${file} (${e.code ?? e.message}): ${DERIVE}`);
  }
  try {
    return { file, cache: JSON.parse(text) };
  } catch (e) {
    throw new LabelMapUnreadable(`the Label map at ${file} does not parse (${e.message}): ${DERIVE}`);
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (record, key) => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * The `roles` object (every Label role -> its string) of the cache of the
 * repository `cwd` belongs to. Throws LabelMapUnreadable, its message naming
 * `ensure`, when the cache is absent, does not parse, lacks a role or breaks
 * the string rules; throws FleetDirUnresolvable outside a repository.
 */
export function readLabelMap({ cwd = process.cwd() } = {}) {
  const { file, cache } = loadCache(cwd);
  const roles = cache?.roles;
  if (!isRecord(roles)) {
    throw new LabelMapUnreadable(`the Label map at ${file} holds no \`roles\` object: ${DERIVE}`);
  }
  const faults = labelStringFaults(roles);
  if (faults.length) {
    const why = faults.map(({ role, rule }) => `${role}: ${rule}`).join("; ");
    throw new LabelMapUnreadable(`the Label map at ${file} is invalid — ${why}: ${DERIVE}`);
  }
  return Object.fromEntries(LABEL_ROLES.map((role) => [role, roles[role]]));
}

// THE TABLE (TRIAGE_TABLE_FILE, under the checkout's top level): the
// one table whose second header cell, backticks and whitespace stripped, is
// TABLE_HEADER. A row is a table line whose first cell, stripped the same way,
// is a Label role and whose stripped second cell is not empty. `rows` maps a
// role to its string; a role with two rows of different strings maps to the
// array of them, in file order, so the cache's `table` still shows a changed
// second row. Any other table in the file is not read.
export const TRIAGE_TABLE_FILE = join("docs", "agents", "triage-labels.md");
const TABLE_HEADER = "Label in our tracker";

/** The tracker's answer could not be had, or the table could not be read: `ensure`'s exit 2. */
export class LabelMapUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "LabelMapUnavailable";
  }
}

const stripCell = (cell) => cell.replace(/^[\s`]+|[\s`]+$/g, "");

// The cells of a markdown table line, or null for any other line.
function cellsOf(line) {
  const text = line.trim();
  if (!text.startsWith("|")) return null;
  let inner = text.slice(1);
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
  return inner.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|"));
}

const isSeparator = (cells) => cells !== null && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));

/** The `{ present: true, rows }` the triage-label table text says. */
export function parseTriageTable(text) {
  const lines = text.split(/\r?\n/).map(cellsOf);
  const found = new Map();
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i];
    if (head === null || head.length < 2 || !isSeparator(lines[i + 1]) || stripCell(head[1]) !== TABLE_HEADER) continue;
    for (let j = i + 2; j < lines.length && lines[j] !== null; j++) {
      const role = stripCell(lines[j][0]);
      const value = stripCell(lines[j][1] ?? "");
      if (!LABEL_ROLES.includes(role) || value === "") continue;
      const strings = found.get(role) ?? [];
      if (!strings.includes(value)) strings.push(value);
      found.set(role, strings);
    }
    break;
  }
  const rows = {};
  for (const role of LABEL_ROLES) {
    if (found.has(role)) rows[role] = found.get(role).length === 1 ? found.get(role)[0] : found.get(role);
  }
  return { present: true, rows };
}

/**
 * The top level of the checkout `cwd` is in and the table it holds:
 * `{ top, table }`, `table` being `{ present: false, rows: {} }` when the file
 * is absent. Throws FleetDirUnresolvable outside a work tree and
 * LabelMapUnavailable when the file exists and cannot be read.
 */
export function readTriageTable({ cwd = process.cwd() } = {}) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", env: gitEnv(), timeout: DEFAULT_GIT_TIMEOUT_MS });
  const top = (r.stdout ?? "").trim();
  if (r.status !== 0 || top === "") {
    const why = (r.error?.message ?? (r.stderr ?? "").trim()) || `exit ${r.status}`;
    throw new FleetDirUnresolvable(`could not resolve --show-toplevel: ${why}`);
  }
  const file = join(top, TRIAGE_TABLE_FILE);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { top, table: { present: false, rows: {} } };
    throw new LabelMapUnavailable(`cannot read ${file} (${e.code ?? e.message})`);
  }
  return { top, table: parseTriageTable(text) };
}

// The live label list is capped at this many labels per call: a list that
// fills the limit may be cut, and is a refusal (the capped-list rule).
export const LIVE_LABEL_LIMIT = 1000;

/**
 * The names of every label the tracker has, from `gh label list`. Throws
 * LabelMapUnavailable when `gh` cannot answer, answers something else, or
 * the list fills LIVE_LABEL_LIMIT.
 */
export function readLiveLabels({ cwd = process.cwd() } = {}) {
  const args = ["label", "list", "--limit", String(LIVE_LABEL_LIMIT), "--json", "name"];
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", env: gitEnv({ GH_REPO: "" }), stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new LabelMapUnavailable(`could not run gh: ${r.error.message}`);
  if (r.signal) throw new LabelMapUnavailable(`gh was killed by ${r.signal}`);
  if (r.status !== 0) {
    throw new LabelMapUnavailable(`gh label list failed: ${(r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`}`);
  }
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (e) {
    throw new LabelMapUnavailable(`gh label list did not answer JSON (${e.message})`);
  }
  if (!Array.isArray(rows) || !rows.every((row) => isRecord(row) && typeof row.name === "string")) {
    throw new LabelMapUnavailable("gh label list did not answer a list of { name }");
  }
  if (rows.length >= LIVE_LABEL_LIMIT) {
    throw new LabelMapUnavailable(
      `exactly ${rows.length} labels — the list is capped and may be truncated; a map derived from a cut list is not an answer`,
    );
  }
  return rows.map((row) => row.name);
}

// A table's identity for "the table now in the repo equals the cached one":
// role order, so key order in the file does not matter; null for a malformed one.
function tableKey(table) {
  if (!isRecord(table) || typeof table.present !== "boolean" || !isRecord(table.rows)) return null;
  if (!Object.keys(table.rows).every((key) => LABEL_ROLES.includes(key))) return null;
  return JSON.stringify([table.present, LABEL_ROLES.map((role) => own(table.rows, role) ?? null)]);
}

const lc = (text) => text.toLowerCase();
const compare = (a, b) => (lc(a) < lc(b) ? -1 : lc(a) > lc(b) ? 1 : a < b ? -1 : a > b ? 1 : 0);
// A label equals a role's name after lowercasing and dropping every
// non-alphanumeric character: `on-hold` for `onhold`, `Ready For Agent` for
// `ready-for-agent`.
const squash = (text) => lc(text).replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Derive the Label map from `table` (`{ present, rows }`), `live` (the
 * tracker's label names) and `cache` (the parsed cache, or null). Pure: no
 * file, no `gh`. One of
 *   { kind: "certain", roles, origin }        every role certain, the map valid
 *   { kind: "break", faults: [{ role, rule, fix }] }   the table breaks the string rules
 *   { kind: "uncertain", payload: { certain, uncertain } }   the maintainer decides
 */
export function deriveLabelMap({ table, live, cache }) {
  const exact = new Set(live);
  const byKey = new Map();
  for (const name of live) if (!byKey.has(lc(name))) byKey.set(lc(name), name);
  // The live label a string names, in the tracker's own spelling.
  const liveOf = (text) => (exact.has(text) ? text : byKey.get(lc(text)));
  const rowsOf = (role) => (Object.hasOwn(table.rows, role) ? [].concat(table.rows[role]) : []);

  const cacheRoles = isRecord(cache?.roles) ? cache.roles : {};
  const cacheOrigin = isRecord(cache?.origin) ? cache.origin : {};
  // The cache's strings decide which roles are gone, valid or not; only a
  // cache that passes the string rules carries answers.
  const cacheValid = labelStringFaults(cacheRoles).length === 0;
  const was = (role) => {
    const text = own(cacheRoles, role);
    return typeof text === "string" && text.trim() !== "" && liveOf(text) === undefined ? text : undefined;
  };

  const rowKeys = new Set(LABEL_ROLES.flatMap((role) => rowsOf(role).map(lc)));
  // Live near matches of `role` the maintainer may be offered: none that the
  // string rules reject, none that a table row or a carried answer holds.
  const nearOf = (role, held) =>
    [...new Set(live)]
      .filter((name) => squash(name) === squash(role) && lc(name) !== lc(role) && stringFault(name) === null && !held.has(lc(name)))
      .sort(compare);
  const heldBy = (carried) => new Set([...rowKeys, ...[...carried].map((role) => lc(cacheRoles[role]))]);

  // Roles with no row that the cache answered as the maintainer, the answer
  // still live: the answers that carry over, before any is dropped.
  const candidates = cacheValid
    ? LABEL_ROLES.filter(
        (role) => rowsOf(role).length === 0 && own(cacheOrigin, role) === "maintainer" && liveOf(cacheRoles[role]) !== undefined,
      )
    : [];

  // What each role with no row and no carried answer resolves to by its
  // default: its certain string, or its suggestion.
  const resolve = (carried, dropped) => {
    const held = heldBy(carried);
    const out = new Map();
    for (const role of LABEL_ROLES) {
      if (rowsOf(role).length || carried.has(role)) continue;
      const def = liveOf(role);
      const near = nearOf(role, held);
      // A dropped answer and a gone label are asked again, a live default or not.
      const askAgain = dropped.has(role) || was(role) !== undefined;
      if (def !== undefined && near.length === 0 && !askAgain) out.set(role, { certain: true, string: def, origin: "default" });
      else if (def !== undefined) out.set(role, { certain: false, string: def, origin: "default" });
      else if (near.length) out.set(role, { certain: false, string: near[0], origin: "near-match" });
      else out.set(role, { certain: false, string: role, origin: "default" });
    }
    return out;
  };

  // An answer is dropped when a table row names its string, or another role
  // resolves to it as its default; dropping one can make its role resolve to
  // its default and so drop another, so this runs until nothing more drops,
  // starting with every answer carried.
  const dropped = new Map();
  let carried;
  let resolved;
  for (;;) {
    carried = new Set(candidates.filter((role) => !dropped.has(role)));
    resolved = resolve(carried, dropped);
    let changed = false;
    for (const role of carried) {
      const key = lc(cacheRoles[role]);
      let claimedBy = null;
      for (const other of LABEL_ROLES) {
        const row = other === role ? undefined : rowsOf(other).find((text) => lc(text) === key);
        if (row !== undefined) {
          claimedBy = { role: other, string: row, by: "table" };
          break;
        }
      }
      if (claimedBy === null) {
        for (const [other, verdict] of resolved) {
          if (other !== role && lc(verdict.string) === key) {
            claimedBy = { role: other, string: verdict.string, by: "default" };
            break;
          }
        }
      }
      if (claimedBy !== null) {
        dropped.set(role, claimedBy);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // The string rules on the verdicts, before any suggestion is withheld.
  const faults = [];
  const fixRow = (role) => `edit the ${role} row in ${TRIAGE_TABLE_FILE}`;
  const firstRowOwner = new Map();
  for (const role of LABEL_ROLES) {
    const rows = rowsOf(role);
    for (const text of rows) {
      const rule = stringFault(text);
      if (rule) faults.push({ role, rule: `its row names ${JSON.stringify(text)}, which is not a valid label string (${rule})`, fix: fixRow(role) });
    }
    if (rows.length === 0 || stringFault(rows[0])) continue;
    const owner = firstRowOwner.get(lc(rows[0]));
    if (owner !== undefined) {
      faults.push({
        role,
        rule: `its row names ${JSON.stringify(rows[0])}, the same string as the ${owner} row (compared ignoring case)`,
        fix: `edit the ${role} row or the ${owner} row in ${TRIAGE_TABLE_FILE}`,
      });
    } else {
      firstRowOwner.set(lc(rows[0]), role);
    }
    for (const [other, verdict] of resolved) {
      if (other !== role && lc(verdict.string) === lc(rows[0])) {
        faults.push({
          role,
          rule: `its row names ${JSON.stringify(rows[0])}, the string ${other} resolves to as its default (${other} has no row and no answer of its own)`,
          fix: `${fixRow(role)}, or run \`label-map.mjs set ${other}=<label>\` to give ${other} another label`,
        });
      }
    }
  }
  if (faults.length) return { kind: "break", faults };

  const held = heldBy(carried);
  const certain = {};
  const origin = {};
  const uncertain = [];
  for (const role of LABEL_ROLES) {
    const rows = rowsOf(role);
    let settled = null;
    let suggested = null;
    if (rows.length) {
      const live1 = rows.length === 1 ? liveOf(rows[0]) : undefined;
      if (live1 !== undefined) settled = { string: live1, origin: "table" };
      else suggested = { string: liveOf(rows[0]) ?? rows[0], origin: "table" };
    } else if (carried.has(role)) {
      settled = { string: liveOf(cacheRoles[role]), origin: "maintainer" };
    } else {
      const verdict = resolved.get(role);
      if (verdict.certain) settled = { string: verdict.string, origin: "default" };
      else suggested = { string: verdict.string, origin: verdict.origin };
    }
    if (settled !== null) {
      certain[role] = settled.string;
      origin[role] = settled.origin;
      continue;
    }
    // A gone role is never offered the string that vanished back.
    const vanished = was(role);
    const withheld = vanished !== undefined && lc(suggested.string) === lc(vanished);
    const entry = {
      role,
      suggestion: withheld ? null : suggested.string,
      origin: withheld ? "gone" : suggested.origin,
      candidates: nearOf(role, held),
      exists: !withheld && liveOf(suggested.string) !== undefined,
    };
    if (vanished !== undefined) entry.was = vanished;
    if (dropped.has(role)) entry.claimedBy = dropped.get(role);
    uncertain.push(entry);
  }
  if (uncertain.length) return { kind: "uncertain", payload: { certain, uncertain } };
  // Nothing above lets two certain roles share a string; this is the belt to
  // that suspenders, the same rules the reader and the writer's caller hold.
  const broken = labelStringFaults(certain);
  if (broken.length) return { kind: "break", faults: broken.map(({ role, rule }) => ({ role, rule, fix: fixRow(role) })) };
  return { kind: "certain", roles: certain, origin };
}

/**
 * The Label map derivation step: `{ code, stdout, stderr }` for the CLI to
 * print. 0 the map (the cache valid as it stands, or derived and written),
 * 1 the table breaks the string rules, 3 the question payload. Writes only
 * the cache, and only on code 0 from a derivation; never creates a label.
 * Throws FleetDirUnresolvable and LabelMapUnavailable, both exit 2.
 */
export function ensureLabelMap({ cwd = process.cwd() } = {}) {
  const { top, table } = readTriageTable({ cwd });
  const live = readLiveLabels({ cwd: top });
  let cache = null;
  try {
    cache = loadCache(cwd).cache;
  } catch (e) {
    if (!(e instanceof LabelMapUnreadable)) throw e;
  }
  const mapOf = (roles) => JSON.stringify(Object.fromEntries(LABEL_ROLES.map((role) => [role, roles[role]])));
  // Valid as it stands: every mapped string is in the tracker's own spelling,
  // so a label whose case was changed after caching is derived again.
  if (
    isRecord(cache) &&
    isRecord(cache.roles) &&
    labelStringFaults(cache.roles).length === 0 &&
    tableKey(cache.table) !== null &&
    tableKey(cache.table) === tableKey(table) &&
    LABEL_ROLES.every((role) => live.includes(cache.roles[role]))
  ) {
    return { code: 0, stdout: mapOf(cache.roles) };
  }
  const derived = deriveLabelMap({ table, live, cache: isRecord(cache) ? cache : null });
  if (derived.kind === "break") {
    const lines = derived.faults.map(({ role, rule, fix }) => `  ${role}: ${rule}. Fix: ${fix}`);
    return {
      code: 1,
      stderr: `\n${NAME}: ${TRIAGE_TABLE_FILE} gives a Label map that breaks the string rules; nothing written, nothing created:\n${lines.join("\n")}\n`,
    };
  }
  if (derived.kind === "uncertain") return { code: 3, stdout: JSON.stringify(derived.payload) };
  try {
    writeLabelMap({ derivedAt: new Date().toISOString(), table, roles: derived.roles, origin: derived.origin }, { cwd });
  } catch (e) {
    throw new LabelMapUnavailable(`cannot write the Label map: ${e.message}`);
  }
  return { code: 0, stdout: mapOf(derived.roles) };
}

function ensure(rest) {
  if (rest.length) die(`ensure takes no arguments, got: ${rest.join(" ")}; ${USAGE}`);
  let result;
  try {
    result = ensureLabelMap();
  } catch (e) {
    if (e instanceof FleetDirUnresolvable || e instanceof LabelMapUnavailable) die(e.message);
    throw e;
  }
  if (result.stderr) writeAll(2, result.stderr);
  if (result.stdout !== undefined) console.log(result.stdout);
  process.exitCode = result.code;
}

function show(rest) {
  if (rest.length > 1) die(`show takes at most one role, got: ${rest.join(" ")}; ${USAGE}`);
  const [role] = rest;
  if (role !== undefined && !LABEL_ROLES.includes(role)) {
    die(`unknown role ${JSON.stringify(role)}; the roles are ${LABEL_ROLES.join(", ")}`);
  }
  let roles;
  try {
    roles = readLabelMap();
  } catch (e) {
    if (e instanceof FleetDirUnresolvable) die(e.message);
    if (!(e instanceof LabelMapUnreadable)) throw e;
    writeAll(2, `\n${NAME}: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(role === undefined ? JSON.stringify(roles) : roles[role]);
}

function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === "ensure") return ensure(rest);
  if (verb === "show") return show(rest);
  die(verb === undefined ? USAGE : `unknown verb ${JSON.stringify(verb)}; ${USAGE}`);
}

if (isCLI(import.meta.url)) main();
