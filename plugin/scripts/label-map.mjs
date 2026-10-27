#!/usr/bin/env node
// The Label map: the string the consumer's tracker uses for each Label role.
// This module owns the map's cache format — the file, its validity rules, the
// writer and the reader every role-reading script imports — and the `show`
// verb. It derives nothing: the derivation step is `ensure`, which is not
// here yet, so every refusal below names it as the step that writes the map.
//
// THE CACHE is `.fleet/labels.json`, resolved through fleet-dir.mjs's
// fleetFile() like the pre-flight marker, so a member in its own worktree and
// the controller in the main checkout name one file. `.fleet/` is gitignored,
// so the file is never committed, and it is never written by hand. Content:
//   derivedAt  ISO time of the derivation that wrote it
//   table      what the triage-label table said then: { present, rows: {role: string} }
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
//   label-map.mjs show [<role>]   the mapped string for <role>, or the whole
//                                 `roles` object as JSON with no role.
//   Exit 0 printed; 1 no cache or an invalid one, the message naming `ensure`;
//   2 an unknown role, no repository, or a usage refusal (any other verb).
//
// Zero deps: node builtins and sibling scripts only.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isCLI } from "./is-cli.mjs";
import { makeDie, writeAll } from "./arg.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";

const NAME = "label-map";
const die = makeDie(NAME);
const USAGE = "usage: label-map.mjs show [<role>]";
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
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/**
 * The `roles` object (every Label role -> its string) of the cache of the
 * repository `cwd` belongs to. Throws LabelMapUnreadable, its message naming
 * `ensure`, when the cache is absent, does not parse, lacks a role or breaks
 * the string rules; throws FleetDirUnresolvable outside a repository.
 */
export function readLabelMap({ cwd = process.cwd() } = {}) {
  const file = fleetFile(LABEL_MAP_FILE, { cwd });
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new LabelMapUnreadable(`no Label map at ${file}: ${DERIVE}`);
    throw new LabelMapUnreadable(`cannot read the Label map at ${file} (${e.code ?? e.message}): ${DERIVE}`);
  }
  let cache;
  try {
    cache = JSON.parse(text);
  } catch (e) {
    throw new LabelMapUnreadable(`the Label map at ${file} does not parse (${e.message}): ${DERIVE}`);
  }
  const roles = cache?.roles;
  if (roles === null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new LabelMapUnreadable(`the Label map at ${file} holds no \`roles\` object: ${DERIVE}`);
  }
  const faults = labelStringFaults(roles);
  if (faults.length) {
    const why = faults.map(({ role, rule }) => `${role}: ${rule}`).join("; ");
    throw new LabelMapUnreadable(`the Label map at ${file} is invalid — ${why}: ${DERIVE}`);
  }
  return Object.fromEntries(LABEL_ROLES.map((role) => [role, roles[role]]));
}

function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb !== "show") die(verb === undefined ? USAGE : `unknown verb ${JSON.stringify(verb)}; ${USAGE}`);
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

if (isCLI(import.meta.url)) main();
