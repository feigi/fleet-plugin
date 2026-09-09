#!/usr/bin/env node
// The allow-list checker (#1314, #1347). Layer 1 of two (#1298/ADR 0005):
// this is a STATIC audit of an agent/skill/command file's frontmatter SHAPE,
// before any run exists. Layer 2 (tier-check.mjs, #1345) compares a live
// dispatch's RESOLVED tier against the declaration; this file never reads a
// transcript and never runs anything.
//
// Contract, fixed on #1314 and recorded with the key sets on its closing
// comment: three key sets (agents, skills, commands), enforced in BOTH
// directions — an unknown key is a violation (half a contract leaves
// omp-side or Claude-side additions silent) and a missing REQUIRED key is a
// violation — plus a third class, FORBIDDEN: a key that IS documented on a
// harness but silently re-routes a member's tier, tree, or dispatch rather
// than merely doing nothing. `frontmatter-allowlist.json` carries the data;
// this file carries no key names of its own.
//
// Failure contract: exit 1 per violation, each printed as
// `file:line: key — reason` (one line per violation, all files' violations
// printed before exiting). Exit 2 for CANNOT-RUN — the allow-list is
// missing or unreadable, or a file's frontmatter cannot be parsed at all.
// The distinction matters: a missing allow-list must fail LOUDLY rather
// than silently pass with an empty key set (#1314's own wording), which a
// bare exit-1-on-no-violations would do by accident if a missing file
// happened to yield an empty ruleset instead of an error.
//
// Kind classification is PATH-based, never content-sniffed: an ancestor
// segment named `agents`, a `<name>/SKILL.md` under `skills`, or a
// `commands/<name>.md` — the same convention install-root-audit.test.mjs's
// own tree walk and repo-root.mjs's own layout assumptions already use.
// Works whether invoked with a repo-relative path (`plugin/agents/x.md`,
// after #1336's re-nest) or a bare one under a kind directory (check-tracked.sh
// hands this xargs-expanded `git ls-files` paths, always repo-relative from
// the repo root check-tracked.sh itself runs in).
//
// Frontmatter is read as flat `key: value` scalar lines between a `---`
// fence pair — not a YAML parser, because every fleet frontmatter block in
// this tree is exactly that shape (tier-check.mjs's own `parseFrontmatter`
// makes the identical simplification, for the identical files). A block
// this reader cannot make sense of (no closing fence, a line that is
// neither blank nor `key: value`) is CANNOT-RUN, not a violation — a parser
// that quietly skipped what it couldn't read would silently pass exactly
// the "frontmatter unparseable" case #1314 named as a hard exit-2.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME = "frontmatter-check";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST_PATH = join(SCRIPT_DIR, "frontmatter-allowlist.json");

// ---------------------------------------------------------------------------
// pure core — unit- and mutation-tested directly (frontmatter-check.test.mjs),
// no filesystem or process access below this line until main()
// ---------------------------------------------------------------------------

/** Parses and shape-validates the allow-list JSON. `{ allowlist }` or `{ error }`. */
export function parseAllowlist(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `not valid JSON (${e.message})` };
  }
  for (const kind of ["agents", "skills", "commands"]) {
    const section = json[kind];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return { error: `missing or malformed "${kind}" section` };
    }
    for (const field of ["required", "allowed", "forbidden"]) {
      if (field === "forbidden") {
        if (!section.forbidden || typeof section.forbidden !== "object" || Array.isArray(section.forbidden)) {
          return { error: `"${kind}.forbidden" must be an object of key -> reason` };
        }
      } else if (!Array.isArray(section[field])) {
        return { error: `"${kind}.${field}" must be an array` };
      }
    }
  }
  return { allowlist: json };
}

/**
 * Which kind (`agents`/`skills`/`commands`) a given path belongs to, or
 * `null` if it matches none of the three shapes. Scans every path segment
 * rather than assuming a fixed depth, so both `plugin/agents/x.md` and a
 * bare `agents/x.md` classify identically.
 */
export function kindForPath(anyPath) {
  const parts = String(anyPath).split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "agents" && i + 2 === parts.length && parts[i + 1].endsWith(".md")) return "agents";
    if (parts[i] === "skills" && i + 3 === parts.length && parts[i + 2] === "SKILL.md") return "skills";
    if (parts[i] === "commands" && i + 2 === parts.length && parts[i + 1].endsWith(".md")) return "commands";
  }
  return null;
}

/**
 * Reads the flat `key: value` fields out of a `---`-fenced frontmatter
 * block. `{ fields: [{ key, value, line }] }` or `{ error }`. `line` is the
 * 1-based source line the field's `key:` token sits on, so callers can print
 * `file:line:` without re-deriving it.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? "");
  if (!src.startsWith("---\n") && src !== "---" && !src.startsWith("---\r\n")) {
    return { error: "no opening --- fence at the start of the file" };
  }
  const firstNewline = src.indexOf("\n");
  const rest = src.slice(firstNewline + 1);
  const closeMatch = /\n---\s*(?:\r?\n|$)/.exec(rest);
  if (!closeMatch) return { error: "no closing --- fence" };
  const body = rest.slice(0, closeMatch.index);
  const lines = body.split(/\r?\n/);
  const fields = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sourceLine = i + 2; // +1 for the opening fence line, +1 for 1-based
    if (line.trim() === "") continue;
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (!m) return { error: `unparseable frontmatter at line ${sourceLine}: ${JSON.stringify(line)}` };
    fields.push({ key: m[1], value: m[2].trim(), line: sourceLine });
  }
  return { fields };
}

/**
 * A value-rule violation message for `key`/`value` under `kindRules.values`,
 * or `null` if the value is fine (or the key carries no value rule at all).
 * A rule is either an enum (array of legal literal strings) or a
 * `{ pattern, message }` regex rule (agents' `name`).
 */
function valueViolation(kindRules, key, value) {
  const rule = kindRules.values && kindRules.values[key];
  if (rule === undefined) return null;
  if (Array.isArray(rule)) {
    if (rule.includes(value)) return null;
    return `value ${JSON.stringify(value)} is not one of {${rule.join(", ")}}`;
  }
  if (rule && typeof rule === "object" && typeof rule.pattern === "string") {
    if (new RegExp(rule.pattern).test(value)) return null;
    return rule.message || `value ${JSON.stringify(value)} does not match ${rule.pattern}`;
  }
  return null;
}

/**
 * Every allow-list violation for one file's already-parsed fields, against
 * one kind's rules. `[{ line, key, reason }]`, in file order, with missing
 * required keys appended last (they have no field/line of their own —
 * reported at line 1, the frontmatter's own opening fence, which is where a
 * reader would add them).
 */
export function checkFields(kind, allowlist, fields) {
  const rules = allowlist[kind];
  const violations = [];
  const seen = new Set();
  for (const { key, value, line } of fields) {
    seen.add(key);
    if (Object.prototype.hasOwnProperty.call(rules.forbidden, key)) {
      violations.push({ line, key, reason: rules.forbidden[key] });
      continue;
    }
    if (!rules.required.includes(key) && !rules.allowed.includes(key)) {
      violations.push({ line, key, reason: `unrecognised key for ${kind} frontmatter — not required, allowed, or forbidden` });
      continue;
    }
    const vv = valueViolation(rules, key, value);
    if (vv) violations.push({ line, key, reason: vv });
  }
  for (const req of rules.required) {
    if (!seen.has(req)) violations.push({ line: 1, key: req, reason: "required key missing" });
  }
  return violations;
}

/** `file:line: key — reason`, the ticket's exact violation-line shape. */
export function formatViolation(file, v) {
  return `${file}:${v.line}: ${v.key} — ${v.reason}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function dieCannotRun(message) {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(2);
}

function usage() {
  process.stderr.write(`usage: ${NAME} [--allowlist <path>] <frontmatter-file...>\n`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  let allowlistPath = DEFAULT_ALLOWLIST_PATH;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allowlist") {
      allowlistPath = argv[i + 1];
      i += 1;
      if (allowlistPath === undefined) usage();
    } else {
      files.push(argv[i]);
    }
  }
  if (files.length === 0) usage();

  let raw;
  try {
    raw = readFileSync(allowlistPath, "utf8");
  } catch (e) {
    dieCannotRun(`allow-list unreadable at ${allowlistPath} (${e.code || e.message})`);
  }
  const { allowlist, error: allowlistError } = parseAllowlist(raw);
  if (allowlistError) dieCannotRun(`allow-list at ${allowlistPath} ${allowlistError}`);

  let anyViolation = false;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      dieCannotRun(`cannot read ${file} (${e.code || e.message})`);
    }

    const kind = kindForPath(file);
    if (!kind) {
      dieCannotRun(
        `cannot classify ${file} as agents/skills/commands frontmatter — expected `
        + '".../agents/<name>.md", ".../skills/<name>/SKILL.md", or ".../commands/<name>.md"',
      );
    }

    const parsed = parseFrontmatter(text);
    if (parsed.error) dieCannotRun(`${file}: ${parsed.error}`);

    for (const v of checkFields(kind, allowlist, parsed.fields)) {
      anyViolation = true;
      process.stdout.write(formatViolation(file, v) + "\n");
    }
  }

  process.exit(anyViolation ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
