#!/usr/bin/env node
// The shape of a member's report: one JSON Schema per member family, and the
// check that a report file has that shape.
//
//   report-schema.mjs print <family>
//   report-schema.mjs validate <family> <file>
//
// Reached through the Resolver: `~/.fleet/bin/fleet-run report-schema.mjs ...`.
// <family> is one of `impl`, `fix-pr`, `finisher`, `merge-bot`. The review
// runner is not a family here: its report already has a shape of its own.
//
// `print` writes the family's schema to stdout as JSON, the text a brief
// quotes or a `task` call carries as its `outputSchema`. `validate` reads
// <file> as JSON and checks it against the family's schema.
//
// Exit vocabulary:
//
//   0  print: the schema is on stdout. validate: `valid` on stdout
//   1  validate: `invalid: <violation>` on stdout, naming the FIRST violation;
//      a file that is not JSON is invalid too, as `$: not JSON (...)`, and so
//      is one that repeats a key, as `$.merged: duplicate key "merged"`, and
//      a merge-bot report giving one PR two verdicts, as
//      `$.refused[0].pr: PR #<pr> already has a verdict at $.merged[0].pr`
//   2  usage: no or unknown subcommand, a wrong argument count, an unknown
//      family, any flag; or <file> could not be read; or print could not
//      write the schema to stdout. Refused on stderr, nothing on stdout
//
// A validate verdict line that stdout would not take changes nothing: the
// exit code, 0 or 1, is the verdict.
//
// Every field a family lists is required, a nullable one included: a report
// says `null`, it never leaves the field out. Only the top level is closed
// (`additionalProperties: false`); objects inside it may carry more than
// their schema names.
//
// The validator below is hand-written and covers exactly the keywords these
// schemas use: `type` (one or a list), `enum`, `pattern`, `minimum` and
// `maximum` (numbers only: a value that is not a number, `null` included,
// passes them), `required`, `properties`, `additionalProperties: false` and
// `items`. A keyword it does not know is not checked, so a schema here that
// starts using one needs the validator to learn it first. An integer is
// bounded by the schema, not by `type`: ids by 1 and the largest safe
// integer, the other integers by the safe range, beyond which JSON.parse has
// already rounded the number. A duplicate key, compared decoded and at any
// depth, is a violation named before any schema check. The walk is in a
// fixed order, which is what makes "the first violation" one answer: at each
// value `type`, then `enum`, then `pattern`, then `minimum`, then `maximum`;
// in an object every `required` field in the schema's order, then any
// unexpected field in the report's order, then each property in the schema's
// order; in an array each item in turn. A violation is named by its path
// from the report's root, `$`, as `$.merged[1].sha`.
//
// Strict mode. A `task` call can carry this schema as `outputSchema` with
// `schemaMode: "strict"`. Measured 2026-10-14 under omp/18.10.3, and only on
// the path a member session can reach: the session's `task` tool takes items
// of { agent, name, solutionSpace, task, tools } and no `outputSchema` or
// `schemaMode`, so the same schema was handed to `eval`'s `agent(prompt,
// { schema, schemaMode })`, with a child told to submit `{}` and never
// anything else, against a schema requiring a field `x`. Each of its first
// three submissions got a notice from the child's `yield` tool:
//
//   Output does not match schema: x: is required. Call yield again with the
//   corrected shape — 2 retry attempt(s) remain before the schema constraint
//   is dropped.
//
// then `1 retry attempt(s) remain`, then `this is the final retry`, and the
// fourth submission was taken: `Result submitted (schema validation
// overridden after 4 failed attempt(s)).` What the caller then saw depended
// on the mode:
//
//   strict      job status `failed`; the handle's wait() rejected with
//               `schema_violation: missing required fields: x`; its output
//               text was {"error":"schema_violation","message":"x: is
//               required","missingRequired":["x"],"data":"{}"}
//   permissive  job status `completed`; the invalid `{}` came back as the
//               result
//
// A child that corrected itself after the first notice, in strict mode,
// resolved with its corrected data. Not measured: a `task` dispatch that
// carries both fields, which this session's tool cannot express. So a caller
// reading a report validates the file itself, whatever the dispatch's
// schema mode.

import { readFileSync } from "node:fs";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { isCLI } from "./is-cli.mjs";
import { HALT_CAUSES } from "./ledger-grammar.mjs";

const NAME = "report-schema";
const die = makeDie(NAME);

const USAGE = "usage: report-schema.mjs print <family> | validate <family> <file>";

const HEX = "^[0-9a-f]{40}$";
const str = { type: "string" };
// An id is a positive safe integer; a negative one writes a ledger row `#-3 …` that `filed` refuses and `check`'s subjectOf() cannot strip.
const id = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
// A position or a count: the safe range only, so a truthful negative `exit` stays valid.
const int = { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const sha = { type: "string", pattern: HEX };
const strings = { type: "array", items: str };

// An object node whose every named property is required.
const obj = (properties, type = "object") => ({ type, required: Object.keys(properties), properties });
const listOf = (properties) => ({ type: "array", items: obj(properties) });

// A family's top level: every field required, nothing else allowed.
const report = (properties) => ({ ...obj(properties), additionalProperties: false });

const issues = listOf({ issue: id, subject: str });

export const SCHEMAS = {
  impl: report({
    member: str,
    outcome: { type: "string", enum: ["pr", "bailed"] },
    pr: { ...id, type: ["integer", "null"] },
    head: { type: ["string", "null"], pattern: HEX },
    branch: str,
    sizing: obj(
      { verdict: { type: "string", enum: ["light", "heavy"] }, signal: str, ranBeforePr: { type: "boolean" } },
      ["object", "null"],
    ),
    bailCause: { type: ["string", "null"], enum: ["undecided", "fork", "hands", "fixed", "covered", null] },
    bailDetail: { type: ["string", "null"] },
    confirmation: strings,
  }),
  "fix-pr": report({
    member: str,
    outcome: { type: "string", enum: ["applied", "no-op", "failed"] },
    head: sha,
    branch: str,
    applied: listOf({ bucket: str, index: int }),
    deferred: listOf({ bucket: str, index: int, issue: id }),
    filed: issues,
    unrecorded: issues,
    dispositionsRecord: { type: "string", pattern: "^/" },
    testRun: obj({ cmd: str, exit: int, tests: int, cancelled: int }),
    confirmation: strings,
  }),
  finisher: report({
    member: str,
    outcome: { type: "string", enum: ["labelled", "halted", "failed"] },
    // The ledger's own `halted:<cause>` vocabulary, so a cause added there is accepted here.
    cause: { type: ["string", "null"], enum: [...HALT_CAUSES, null] },
    evidence: { type: ["string", "null"] },
    pin: sha,
    labelsReadBack: strings,
    kill: obj({ red: str, baseline: str }, ["object", "null"]),
    filed: issues,
    unrecorded: issues,
    confirmation: strings,
  }),
  "merge-bot": report({
    member: str,
    merged: listOf({ pr: id, sha }),
    held: listOf({ pr: id, behind: id }),
    conflictHold: { type: "array", items: id },
    // A refusal is a verdict only with a reason: the reason is the record
    // `## Ruled` gets, so one with no text but whitespace is invalid.
    refused: listOf({ pr: id, reason: { type: "string", pattern: "\\S" } }),
    branchKept: listOf({ pr: id, by: id }),
  }),
};

// Every verdict a merge-bot report gives, as `{pr, path}`, `path` the entry's
// PR field: `merged`, `held`, `conflictHold`, then `refused`, each in report
// order. `branchKept` gives none: it names a merged PR's branch and the open
// PR keeping it.
export function mergeBotVerdicts(report) {
  return [
    ...["merged", "held"].flatMap((k) => report[k].map((e, i) => ({ pr: e.pr, path: `$.${k}[${i}].pr` }))),
    ...report.conflictHold.map((pr, i) => ({ pr, path: `$.conflictHold[${i}]` })),
    ...report.refused.map((e, i) => ({ pr: e.pr, path: `$.refused[${i}].pr` })),
  ];
}

// The first violation of `family`'s schema by `value`, or null; for a
// merge-bot report then the rule no schema keyword states: each PR gets one
// verdict — merged, held, conflict-held or refused — the last it reached in
// the pass, so a PR named twice, in one list or in two, is a violation at
// its second entry.
export function reportViolation(family, value) {
  const found = validate(SCHEMAS[family], value);
  if (found !== null || family !== "merge-bot") return found;
  const first = new Map();
  for (const { pr, path } of mergeBotVerdicts(value)) {
    if (first.has(pr)) return `${path}: PR #${pr} already has a verdict at ${first.get(pr)}`;
    first.set(pr, path);
  }
  return null;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const show = (v) => JSON.stringify(v);

// The first violation of `schema` by `value`, as `<path>: <what>`, or null.
export function validate(schema, value, path = "$") {
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.includes(typeOf(value))) return `${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${path}: ${show(value)} is not one of ${schema.enum.map(show).join(", ")}`;
  }
  if (typeof value === "string" && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    return `${path}: ${show(value)} does not match ${schema.pattern}`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: ${show(value)} is below minimum ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: ${show(value)} is above maximum ${schema.maximum}`;
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${path}: missing required field ${show(key)}`;
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(props, key));
      if (extra !== undefined) return `${path}: unexpected field ${show(extra)}`;
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!Object.hasOwn(value, key)) continue;
      const found = validate(sub, value[key], `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const found = validate(schema.items, value[i], `${path}[${i}]`);
      if (found !== null) return found;
    }
  }
  return null;
}

// The first duplicate key of `text` in text order, as `<path>: duplicate key
// "<key>"`, or null. `text` is well-formed JSON, so nothing here can meet a
// malformed token. Keys are compared decoded, as JSON.parse collides them.
function firstDuplicateKey(text) {
  // One frame per open container: an object's keys so far, an array's index.
  const open = [];
  let next = "$"; // the path of the value that starts next
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const top = open[open.length - 1];
    if (c === "{") {
      open.push({ path: next, keys: new Set(), wantKey: true });
    } else if (c === "[") {
      open.push({ path: next, index: 0 });
      next = `${next}[0]`;
    } else if (c === "}" || c === "]") {
      open.pop();
    } else if (c === ",") {
      if (top.keys === undefined) next = `${top.path}[${++top.index}]`;
      else top.wantKey = true;
    } else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (top?.wantKey) {
        const key = JSON.parse(text.slice(i, end + 1));
        next = `${top.path}.${key}`;
        if (top.keys.has(key)) return `${next}: duplicate key ${show(key)}`;
        top.keys.add(key);
        top.wantKey = false;
      }
      i = end;
    }
    i++;
  }
  return null;
}

/** `text` read as a report: `{ value }`, or `{ violation }` for text that is
 * not JSON or that repeats a key in any object at any depth. */
export function parseReport(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { violation: `$: not JSON (${e.message})` };
  }
  const violation = firstDuplicateKey(text);
  return violation === null ? { value } : { violation };
}

function familyOf(name) {
  if (!Object.hasOwn(SCHEMAS, name)) die(`unknown family '${name}' — known: ${Object.keys(SCHEMAS).join(", ")}`);
  return SCHEMAS[name];
}

function main() {
  // No flags at all: the sweep refuses every `--` token by name. The
  // positionals are read by count below, not by stray(), whose grammar holds
  // one positional slot and this command line has up to three.
  defineFlags(die, { flags: {} }).sweep();
  const [cmd, family, path, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || family === undefined) die(USAGE);

  if (cmd === "print" && path === undefined) {
    if (!writeAll(1, `${JSON.stringify(familyOf(family), null, 2)}\n`)) die("the schema could not be written to stdout");
    return;
  }
  if (cmd !== "validate" || path === undefined) die(USAGE);

  familyOf(family);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  const parsed = parseReport(text);
  const violation = parsed.violation ?? reportViolation(family, parsed.value);
  if (violation !== null) {
    writeAll(1, `invalid: ${violation}\n`);
    process.exit(1);
  }
  writeAll(1, "valid\n");
}

if (isCLI(import.meta.url)) main();
