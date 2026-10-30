#!/usr/bin/env node
// The Label map: the string the consumer's tracker uses for each Label role.
// This module owns the map's cache format — the file, its validity rules, the
// writer and the reader every role-reading script imports — and the verbs
// that read, derive or write it: `show`, `ensure`, the derivation step that
// writes the map when nothing is uncertain, and `set`, which writes it from a
// derivation plus the maintainer's answer. Where the reader or `show`
// refuses the cache, the message names `ensure` as the step that writes the map.
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
// code points, no `"` and no `\`, and no two roles mapping to one string,
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
//                                 JSON (exit 3, nothing written): `certain`,
//                                 `uncertain` and `tableFile`, the table's
//                                 path under the checkout's top level, for
//                                 the question to name. It never
//                                 creates a label. Exit 1: the table breaks
//                                 the string rules, the message naming each
//                                 role, the rule and the fix. Exit 2: no
//                                 repository, the table not readable, the
//                                 cache present but not readable or not
//                                 writable, `gh` could not answer, the label
//                                 list filled its limit, or a usage refusal.
//   label-map.mjs set [--accept-suggestions] [--create] [<role>=<label> …]
//                                 writes the map from a fresh derivation (as
//                                 `ensure` runs it) plus the answer: each
//                                 pair settles its role before the table is
//                                 consulted, `--accept-suggestions` fills
//                                 every other uncertain role with its
//                                 suggestion, and an uncertain role left
//                                 uncovered (a role with no suggestion
//                                 included) is a refusal naming it. A string
//                                 not in the tracker is created with
//                                 `gh label create <string>` (no colour)
//                                 only under `--create`, an "already exists"
//                                 answer counting as existing, and the live
//                                 list is read again so the map stores the
//                                 tracker's spelling; without `--create` it
//                                 is a refusal naming it. The cache is
//                                 written (origin `maintainer` for every role
//                                 a pair or `--accept-suggestions` settled)
//                                 only when every mapped string exists live;
//                                 exit 0 prints the map. Exit 1: a refusal
//                                 naming the role and the rule, nothing
//                                 written, nothing created. Exit 2: an
//                                 unknown role, a malformed pair, a role
//                                 answered twice or an unknown flag; no
//                                 repository, `gh` could not answer, or the
//                                 cache not readable or writable.
//   label-map.mjs show [<role>]   the mapped string for <role>, or the whole
//                                 `roles` object as JSON with no role.
//                                 `show` exits 0 printed; 1 no cache or an
//                                 invalid one, the message naming `ensure`,
//                                 or a cache that exists and cannot be read,
//                                 the message naming the errno as a
//                                 filesystem fault and its repair before
//                                 `ensure`; 2 an unknown role or no
//                                 repository. Any other verb is a usage
//                                 refusal, exit 2.
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
const USAGE = "usage: label-map.mjs ensure | set [--accept-suggestions] [--create] [<role>=<label> …] | show [<role>]";
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

// `cause` is the filesystem's own error when the cache exists and cannot be
// read; an absent cache or one that does not parse has none.
export class LabelMapUnreadable extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LabelMapUnreadable";
  }
}

// The rule a single string breaks on its own, or null.
function stringFault(value) {
  if (value === undefined) return "missing";
  if (typeof value !== "string") return `not a string (${JSON.stringify(value)})`;
  if (value.trim() === "") return "empty after trimming";
  const length = [...value].length;
  if (length > MAX_LENGTH) return `longer than ${MAX_LENGTH} code points (${length})`;
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

// The parsed cache at `file`. Throws LabelMapUnreadable, its
// message naming `ensure`, when the file is absent or does not parse; when it
// exists and cannot be read, the message names the errno as a filesystem
// fault and its repair before `ensure`.
function loadCache(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new LabelMapUnreadable(`no Label map at ${file}: ${DERIVE}`);
    throw new LabelMapUnreadable(
      `cannot read the Label map at ${file} (${e.code ?? e.message}): a filesystem fault, not a map fault — `
        + `make that path a readable file (check its and .fleet/'s permissions, and that .fleet/ is a directory) `
        + `or remove what is in the way, then ${DERIVE}`,
      { cause: e },
    );
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new LabelMapUnreadable(`the Label map at ${file} does not parse (${e.message}): ${DERIVE}`);
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (record, key) => (Object.hasOwn(record, key) ? record[key] : undefined);

// The eight roles of `roles`, keyed in role order.
const inRoleOrder = (roles) => Object.fromEntries(LABEL_ROLES.map((role) => [role, roles[role]]));

/**
 * The `roles` object (every Label role -> its string) of the cache of the
 * repository `cwd` belongs to, or of the cache at `file` when the caller has
 * resolved that path already — then no git probe runs, which is what a
 * caller on an event loop it must not block (the cockpit's tick) needs.
 * Throws LabelMapUnreadable, its message naming `ensure`, when the cache is
 * absent, does not parse, lacks a role or breaks the string rules; when the
 * cache exists and cannot be read (e.g. EACCES, EISDIR, ENOTDIR), its message
 * names the errno as a filesystem fault, not a map fault, and the repair,
 * then `ensure` as the following step. Throws FleetDirUnresolvable outside a
 * repository when no `file` is given.
 */
export function readLabelMap({ cwd = process.cwd(), file = null } = {}) {
  const at = file ?? fleetFile(LABEL_MAP_FILE, { cwd });
  const roles = loadCache(at)?.roles;
  if (!isRecord(roles)) {
    throw new LabelMapUnreadable(`the Label map at ${at} holds no \`roles\` object: ${DERIVE}`);
  }
  const faults = labelStringFaults(roles);
  if (faults.length) {
    const why = faults.map(({ role, rule }) => `${role}: ${rule}`).join("; ");
    throw new LabelMapUnreadable(`the Label map at ${at} is invalid — ${why}: ${DERIVE}`);
  }
  return inRoleOrder(roles);
}

// THE TABLE (TRIAGE_TABLE_FILE, under the checkout's top level): the
// first table whose second header cell, backticks and whitespace stripped, is
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

// The cells of a markdown table line — any line holding an unescaped `|`, its
// leading and trailing pipes optional as GFM has them — or null for any other.
function cellsOf(line) {
  let inner = line.trim();
  if (!/(?<!\\)\|/.test(inner)) return null;
  if (inner.startsWith("|")) inner = inner.slice(1);
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
    const strings = found.get(role);
    if (strings) rows[role] = strings.length === 1 ? strings[0] : strings;
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
// `gh label list` is killed after this long, so a `gh` hung on auth or the
// network is `ensure`'s exit 2 rather than a hang.
const GH_TIMEOUT_MS = 60_000;

// `gh` run in `cwd` with GH_REPO blanked, since an ambient one would point the
// call at another repository's labels.
function spawnGh(args, cwd) {
  return spawnSync("gh", args, { cwd, encoding: "utf8", env: gitEnv({ GH_REPO: "" }), stdio: ["ignore", "pipe", "pipe"], timeout: GH_TIMEOUT_MS });
}

/**
 * The names of every label the tracker has, from `gh label list`. Throws
 * LabelMapUnavailable when `gh` cannot answer, answers something else, or
 * the list fills LIVE_LABEL_LIMIT.
 */
export function readLiveLabels({ cwd = process.cwd() } = {}) {
  const args = ["label", "list", "--limit", String(LIVE_LABEL_LIMIT), "--json", "name"];
  const r = spawnGh(args, cwd);
  if (r.error?.code === "ETIMEDOUT") throw new LabelMapUnavailable(`gh label list timed out after ${GH_TIMEOUT_MS / 1000}s`);
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
 * tracker's label names) and `cache` (the parsed cache, any JSON value, or
 * null; only its `roles` and `origin` records are read). `answers` (role ->
 * string, a Map) are the maintainer's explicit answers: each settles its role,
 * live or not, before the table is consulted — the role's own table row is
 * not read — and a cached answer or a table row naming the same string loses
 * to it as it would to a table row. Pure: no file, no `gh`. One of
 *   { kind: "certain", roles, origin }        every role certain, the map valid
 *   { kind: "break", faults: [{ role, rule, fix }] }   the table or an answer breaks the string rules
 *   { kind: "uncertain", payload: { certain, uncertain, tableFile }, roles, origin }   the maintainer decides;
 *     `roles` and `origin` are the certain roles' and what settled them;
 *     `tableFile` is TRIAGE_TABLE_FILE, so the question can name the file
 */
export function deriveLabelMap({ table, live, cache, answers = new Map() }) {
  const exact = new Set(live);
  const byKey = new Map();
  for (const name of live) if (!byKey.has(lc(name))) byKey.set(lc(name), name);
  // The live label a string names, in the tracker's own spelling.
  const liveOf = (text) => (exact.has(text) ? text : byKey.get(lc(text)));
  const rowsOf = (role) => (answers.has(role) ? [answers.get(role)] : Object.hasOwn(table.rows, role) ? [].concat(table.rows[role]) : []);

  const cacheRoles = isRecord(cache?.roles) ? cache.roles : {};
  const cacheOrigin = isRecord(cache?.origin) ? cache.origin : {};
  // The cache's strings decide which roles are gone, valid or not; only a
  // cache whose strings pass the string rules carries answers. A role the
  // cache lacks is no string to break them, so it drops no answer.
  const cacheValid = labelStringFaults(cacheRoles).every(({ rule }) => rule === "missing");
  const was = (role) => {
    const text = own(cacheRoles, role);
    return typeof text === "string" && text.trim() !== "" && liveOf(text) === undefined ? text : undefined;
  };

  const rowKeys = new Set(LABEL_ROLES.flatMap((role) => rowsOf(role).map(lc)));
  // Live near matches of `role` the maintainer may be offered: none that the
  // string rules reject, none that a table row or a carried answer holds.
  const nearOf = (role, held) =>
    [...exact]
      .filter((name) => squash(name) === squash(role) && lc(name) !== lc(role) && stringFault(name) === null && !held.has(lc(name)))
      .sort(compare);
  const heldBy = (carried) => new Set([...rowKeys, ...[...carried].map((role) => lc(cacheRoles[role]))]);

  // Roles with no row that the cache answered as the maintainer, the answer
  // still live: the answers that carry over, before any is dropped.
  const candidates = cacheValid
    ? LABEL_ROLES.filter(
        (role) =>
          rowsOf(role).length === 0 &&
          own(cacheOrigin, role) === "maintainer" &&
          Object.hasOwn(cacheRoles, role) &&
          liveOf(cacheRoles[role]) !== undefined,
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
  // starting with every answer carried. A carried role has no row and is
  // never in `resolved`, so neither check can find the role itself.
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
        const row = rowsOf(other).find((text) => lc(text) === key);
        if (row !== undefined) {
          claimedBy = { role: other, string: row, by: "table" };
          break;
        }
      }
      if (claimedBy === null) {
        for (const [other, verdict] of resolved) {
          if (lc(verdict.string) === key) {
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
  const what = (role) => (answers.has(role) ? `the ${role}=<label> pair` : `the ${role} row`);
  const fixRow = (role) => (answers.has(role) ? `change ${what(role)}` : `edit the ${role} row in ${TRIAGE_TABLE_FILE}`);
  const named = (role) => (answers.has(role) ? "its answer" : "its row");
  const firstRowOwner = new Map();
  for (const role of LABEL_ROLES) {
    const rows = rowsOf(role);
    for (const text of rows) {
      const rule = stringFault(text);
      if (rule) faults.push({ role, rule: `${named(role)} names ${JSON.stringify(text)}, which is not a valid label string (${rule})`, fix: fixRow(role) });
    }
    if (rows.length === 0 || stringFault(rows[0])) continue;
    const owner = firstRowOwner.get(lc(rows[0]));
    if (owner !== undefined) {
      const bothRows = !answers.has(role) && !answers.has(owner);
      faults.push({
        role,
        rule: `${named(role)} names ${JSON.stringify(rows[0])}, the same string as ${what(owner)} (compared ignoring case)`,
        fix: bothRows ? `edit the ${role} row or the ${owner} row in ${TRIAGE_TABLE_FILE}` : `change ${what(role)} or ${what(owner)}`,
      });
    } else {
      firstRowOwner.set(lc(rows[0]), role);
    }
    // `resolved` holds only roles with no row and no answer, so never this one.
    for (const [other, verdict] of resolved) {
      if (lc(verdict.string) === lc(rows[0])) {
        faults.push({
          role,
          rule: `${named(role)} names ${JSON.stringify(rows[0])}, the string ${other} resolves to as its default (${other} has no row and no answer of its own)`,
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
    if (answers.has(role)) {
      // The tracker's own spelling when the string is live; as given when it is to be created.
      settled = { string: liveOf(rows[0]) ?? rows[0], origin: "maintainer" };
    } else if (rows.length) {
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
  if (uncertain.length) return { kind: "uncertain", payload: { certain, uncertain, tableFile: TRIAGE_TABLE_FILE }, roles: certain, origin };
  // Nothing above lets two certain roles share a string; this is the belt to
  // that suspenders, the same rules the reader and the writer's caller hold.
  const broken = labelStringFaults(certain);
  if (broken.length) return { kind: "break", faults: broken.map(({ role, rule }) => ({ role, rule, fix: fixRow(role) })) };
  return { kind: "certain", roles: certain, origin };
}

// The three inputs of a derivation, read the same way for `ensure` and `set`:
// the table, the live label list and the cache (null when absent or not
// parsing, which is derived again).
function readDerivationInputs(cwd) {
  const { top, table } = readTriageTable({ cwd });
  const live = readLiveLabels({ cwd: top });
  let cache = null;
  try {
    cache = loadCache(fleetFile(LABEL_MAP_FILE, { cwd }));
  } catch (e) {
    if (!(e instanceof LabelMapUnreadable)) throw e;
    // Absent or not parsing is derived again; a cache that exists and cannot
    // be read may hold maintainer answers, so it is never written over.
    if (e.cause) throw new LabelMapUnavailable(`cannot read the Label map at ${e.cause.path} (${e.cause.code ?? e.cause.message}); nothing written`);
  }
  return { top, table, live, cache };
}

const mapOf = (roles) => JSON.stringify(inRoleOrder(roles));
const faultLines = (faults) => faults.map(({ role, rule, fix }) => `  ${role}: ${rule}. Fix: ${fix}`).join("\n");

/**
 * The Label map derivation step: `{ code, stdout, stderr }` for the CLI to
 * print. 0 the map (the cache valid as it stands, or derived and written),
 * 1 the table breaks the string rules, 3 the question payload. Writes only
 * the cache, and only on code 0 from a derivation; never creates a label.
 * Throws FleetDirUnresolvable and LabelMapUnavailable, both exit 2.
 */
export function ensureLabelMap({ cwd = process.cwd() } = {}) {
  const { table, live, cache } = readDerivationInputs(cwd);
  // Valid as it stands: every mapped string is in the tracker's own spelling,
  // so a label whose case was changed after caching is derived again.
  if (
    isRecord(cache) &&
    isRecord(cache.roles) &&
    labelStringFaults(cache.roles).length === 0 &&
    tableKey(cache.table) === tableKey(table) &&
    LABEL_ROLES.every((role) => live.includes(cache.roles[role]))
  ) {
    return { code: 0, stdout: mapOf(cache.roles) };
  }
  const derived = deriveLabelMap({ table, live, cache });
  if (derived.kind === "break") {
    return {
      code: 1,
      stderr: `\n${NAME}: ${TRIAGE_TABLE_FILE} gives a Label map that breaks the string rules; nothing written, nothing created:\n${faultLines(derived.faults)}\n`,
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

// `gh label create` says the label exists in these words; a label that exists
// is what `set` wanted, whoever made it.
const ALREADY_EXISTS = /already exists/i;

/**
 * The Label map write: `{ code, stdout, stderr }` for the CLI to print. A
 * fresh derivation (as `ensureLabelMap` runs it) plus the maintainer's
 * answer: `answers` (role -> string, a Map) settle their roles first, and
 * with `acceptSuggestions` every other uncertain role takes its suggestion.
 * A string that does not exist in the tracker is created with `gh label
 * create <string>` (no colour) only when `create` is set, and the live list
 * is read again so the map stores the tracker's spelling. The cache is
 * written only when every mapped string exists live, origin `maintainer` for
 * every role an answer or an accepted suggestion settled. 0 the map written,
 * 1 a refusal (the string rules, an uncovered uncertain role, a missing
 * string without `create`), nothing written and nothing created. Throws
 * FleetDirUnresolvable and LabelMapUnavailable, both exit 2 — one of them
 * after labels were created, the message then naming them.
 */
export function setLabelMap({ answers = new Map(), acceptSuggestions = false, create = false, cwd = process.cwd() } = {}) {
  const refuse = (...lines) => ({ code: 1, stderr: `\n${NAME}: set refused; nothing written, nothing created:\n${lines.join("\n")}\n` });
  const { top, table, live, cache } = readDerivationInputs(cwd);
  const derived = deriveLabelMap({ table, live, cache, answers });
  if (derived.kind === "break") return refuse(faultLines(derived.faults));

  const roles = { ...derived.roles };
  const origin = { ...derived.origin };
  if (derived.kind === "uncertain") {
    const uncovered = derived.payload.uncertain.filter((u) => !acceptSuggestions || u.suggestion === null);
    if (uncovered.length) {
      return refuse(
        ...uncovered.map(({ role, suggestion, was }) =>
          suggestion === null
            ? `  ${role}: uncovered, and it has no suggestion (its label ${JSON.stringify(was)} is gone from the tracker); answer ${role}=<label>`
            : `  ${role}: uncovered; answer ${role}=<label>, or pass --accept-suggestions to take ${JSON.stringify(suggestion)}`,
        ),
      );
    }
    for (const { role, suggestion } of derived.payload.uncertain) {
      roles[role] = suggestion;
      origin[role] = "maintainer";
    }
  }
  const broken = labelStringFaults(roles);
  if (broken.length) return refuse(...broken.map(({ role, rule }) => `  ${role}: ${rule}`));

  // The live label a string names, in the tracker's own spelling.
  const liveSpelling = (names) => {
    const byKey = new Map();
    for (const name of names) if (!byKey.has(lc(name))) byKey.set(lc(name), name);
    return (text) => byKey.get(lc(text));
  };
  let spelling = liveSpelling(live);
  const missing = LABEL_ROLES.filter((role) => spelling(roles[role]) === undefined);
  // The labels this run created, named by every failure that follows one.
  const made = [];
  const named = (lead) => (made.length ? `; ${lead}: ${made.map((s) => JSON.stringify(s)).join(", ")}` : "");
  if (missing.length) {
    if (!create) {
      return refuse(...missing.map((role) => `  ${role}: ${JSON.stringify(roles[role])} does not exist in the tracker; pass --create to create it`));
    }
    for (const role of missing) {
      // A string that starts with `-` would be read as a flag.
      const string = roles[role];
      const r = spawnGh(["label", "create", ...(string.startsWith("-") ? ["--"] : []), string], top);
      const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const where = `${named("created before it")}; nothing written`;
      if (r.error?.code === "ETIMEDOUT") throw new LabelMapUnavailable(`gh label create ${JSON.stringify(string)} timed out after ${GH_TIMEOUT_MS / 1000}s${where}`);
      if (r.error) throw new LabelMapUnavailable(`could not run gh: ${r.error.message}${where}`);
      if (r.signal) throw new LabelMapUnavailable(`gh was killed by ${r.signal} creating ${JSON.stringify(string)}${where}`);
      if (r.status === 0) made.push(string);
      else if (!ALREADY_EXISTS.test(said)) {
        throw new LabelMapUnavailable(`gh label create ${JSON.stringify(string)} failed: ${said.trim().split("\n")[0] || `exit ${r.status}`}${where}`);
      }
    }
    try {
      spelling = liveSpelling(readLiveLabels({ cwd: top }));
    } catch (e) {
      if (!(e instanceof LabelMapUnavailable)) throw e;
      throw new LabelMapUnavailable(`${e.message}${named("created")}; nothing written`);
    }
  }
  for (const role of LABEL_ROLES) {
    const name = spelling(roles[role]);
    if (name === undefined) {
      throw new LabelMapUnavailable(`${role}: ${JSON.stringify(roles[role])} is not in the tracker's label list after gh label create${named("created")}; nothing written`);
    }
    roles[role] = name;
  }
  try {
    writeLabelMap({ derivedAt: new Date().toISOString(), table, roles: inRoleOrder(roles), origin: inRoleOrder(origin) }, { cwd });
  } catch (e) {
    throw new LabelMapUnavailable(`cannot write the Label map: ${e.message}${named("created")}`);
  }
  return { code: 0, stdout: mapOf(roles) };
}

function report(run) {
  let result;
  try {
    result = run();
  } catch (e) {
    if (e instanceof FleetDirUnresolvable || e instanceof LabelMapUnavailable) die(e.message);
    throw e;
  }
  if (result.stderr) writeAll(2, result.stderr);
  if (result.stdout !== undefined) console.log(result.stdout);
  process.exitCode = result.code;
}

function ensure(rest) {
  if (rest.length) die(`ensure takes no arguments, got: ${rest.join(" ")}; ${USAGE}`);
  report(ensureLabelMap);
}

function set(rest) {
  const answers = new Map();
  let acceptSuggestions = false;
  let create = false;
  for (const arg of rest) {
    if (arg === "--accept-suggestions") acceptSuggestions = true;
    else if (arg === "--create") create = true;
    else if (arg.startsWith("-")) die(`unknown flag ${JSON.stringify(arg)}; ${USAGE}`);
    else {
      const eq = arg.indexOf("=");
      if (eq === -1) die(`malformed pair ${JSON.stringify(arg)}: expected <role>=<label>; ${USAGE}`);
      const role = arg.slice(0, eq);
      if (!LABEL_ROLES.includes(role)) die(`unknown role ${JSON.stringify(role)} in ${JSON.stringify(arg)}; the roles are ${LABEL_ROLES.join(", ")}`);
      if (answers.has(role)) die(`${role} is answered twice; ${USAGE}`);
      answers.set(role, arg.slice(eq + 1));
    }
  }
  report(() => setLabelMap({ answers, acceptSuggestions, create }));
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
  if (verb === "set") return set(rest);
  if (verb === "show") return show(rest);
  die(verb === undefined ? USAGE : `unknown verb ${JSON.stringify(verb)}; ${USAGE}`);
}

if (isCLI(import.meta.url)) main();
