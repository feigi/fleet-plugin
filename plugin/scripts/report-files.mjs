// Where a member's report file lives and what state it is in: the reading
// side of report-schema.mjs, shared by the scripts that look a report up
// rather than write one.
//
// The readers here take a member's report at `<scratch>/reports/<member>.json`
// (flat: no per-run directory), `<member>` being its ledger name (`impl-412`,
// `impl-412-b`, `fix-pr-88`, `finisher-pr-88`, `merge-bot-3`). The file is
// checked against the schema of the member's family, report-schema.mjs's
// SCHEMAS. The review runner and every member outside those four families
// have no schema, so no file to look up.
//
// The Check-step record beside a report, `<reports>/<member>.check.json`, is
// looked up here the same way: recipe-check.mjs writes it, and this module
// only names where it lives and reads it back.
//
// This module only looks files up: it writes none, and creates no scratch
// root.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMAS, parseReport, validate } from "./report-schema.mjs";
import { parseMember } from "./ledger-grammar.mjs";
import { scratchRoot } from "./fleet-dir.mjs";

// The ledger's family name to report-schema.mjs's.
const SCHEMA_FAMILY = { impl: "impl", "fix-pr": "fix-pr", "finisher-pr": "finisher", "merge-bot": "merge-bot" };

/** The report-schema family of a ledger member name, or null for a name no
 * schema covers (a specialist, a review runner, a memory member). */
export function reportFamily(member) {
  const m = parseMember(member);
  return m === null ? null : SCHEMA_FAMILY[m.family];
}

export const reportsDir = (scratch) => join(scratch, "reports");

export const reportPath = (scratch, member) => join(reportsDir(scratch), `${member}.json`);

/** Where `member`'s Check-step record sits in reports directory `dir`: the
 * sibling of its report, `<dir>/<member>.check.json`. recipe-check.mjs writes
 * it, `ledger.mjs settle --from-report` reads it. */
export const checkRecordPathIn = (dir, member) => join(dir, `${member}.check.json`);

const HEX_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// One command's half of a record: the command string, whether it ran (a Check
// step of `true` is recorded as green without running), the exit status it
// ended with — null when it never ran because an earlier one failed — and
// the pass/fail counts its output printed, null where the runner printed none.
function commandViolation(path, c) {
  if (!isObject(c)) return `${path}: not an object`;
  if (typeof c.command !== "string" || c.command === "") return `${path}.command: not a non-empty string`;
  if (typeof c.ran !== "boolean") return `${path}.ran: not a boolean`;
  if (c.exitCode !== null && !Number.isInteger(c.exitCode)) return `${path}.exitCode: not an integer or null`;
  for (const k of ["pass", "fail"]) {
    if (c[k] !== null && !(Number.isInteger(c[k]) && c[k] >= 0)) return `${path}.${k}: not a non-negative integer or null`;
  }
  return null;
}

// A file's text as `{text}`, or the answer both readers below give for a file
// that is not there (`absent`) or cannot be read (`invalid`).
function readAt(path) {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { state: "absent", path };
    return { state: "invalid", path, violation: `$: unreadable (${e.code ?? e.message})` };
  }
}

/** The Check-step record of `member` in reports directory `dir`, the way
 * readReportIn() answers for a report: `{state: "ok", path, record}`,
 * `{state: "invalid", path, violation}` for a file that exists and is
 * unreadable, not JSON, or the wrong shape, or `{state: "absent", path}`.
 * The record is `{member, tree, check, test}`, `tree` the `git write-tree`
 * of the index the two commands ran against and `check`/`test` each
 * `{command, ran, exitCode, pass, fail}`. */
export function readCheckRecordIn(dir, member) {
  const path = checkRecordPathIn(dir, member);
  const read = readAt(path);
  if (read.text === undefined) return read;
  let record;
  try {
    record = JSON.parse(read.text);
  } catch (e) {
    return { state: "invalid", path, violation: `$: not JSON (${e.message})` };
  }
  if (!isObject(record)) return { state: "invalid", path, violation: "$: not an object" };
  if (record.member !== member) return { state: "invalid", path, violation: `$.member: ${JSON.stringify(record.member)} is not ${member}` };
  if (typeof record.tree !== "string" || !HEX_TREE.test(record.tree)) {
    return { state: "invalid", path, violation: "$.tree: not a full lowercase hex tree id" };
  }
  const violation = commandViolation("$.check", record.check) ?? commandViolation("$.test", record.test);
  return violation === null ? { state: "ok", path, record } : { state: "invalid", path, violation };
}

/** The report file of `member` under `scratch`, read and checked against its
 * family's schema: `{state: "ok", path, report}`, `{state: "invalid", path,
 * violation}` for a file that exists and is unreadable, not JSON, or the
 * wrong shape, or `{state: "absent", path}`. Throws on a member no schema
 * covers: ask reportFamily() first. */
export function readReport(scratch, member) {
  return readReportIn(reportsDir(scratch), member);
}

/** readReport() for a reports directory named directly, `<dir>/<member>.json`. */
export function readReportIn(dir, member) {
  const family = reportFamily(member);
  if (family === null) throw new Error(`no report schema for '${member}'`);
  const path = join(dir, `${member}.json`);
  const read = readAt(path);
  if (read.text === undefined) return read;
  const parsed = parseReport(read.text);
  const violation = parsed.violation ?? validate(SCHEMAS[family], parsed.value);
  return violation === null ? { state: "ok", path, report: parsed.value } : { state: "invalid", path, violation };
}

/** `ok`, `invalid`, `absent`, or `-` when no schema covers the member. */
export function reportStatus(scratch, member) {
  return reportFamily(member) === null ? "-" : readReport(scratch, member).state;
}

/** The implementer report of `ticket` that wins: `{member, path}` for
 * `impl-<ticket>` or `impl-<ticket>-<letter>` with the highest retry letter
 * (the name with no letter is the first attempt, so it ranks lowest), or null
 * when none exists. */
export function latestImplReport(scratch, ticket) {
  let names;
  try {
    names = readdirSync(reportsDir(scratch));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
  const mine = new RegExp(`^impl-${ticket}(-[a-z])?\\.json$`);
  let best = null;
  for (const name of names) {
    const m = mine.exec(name);
    if (m === null) continue;
    const letter = m[1] ? m[1].slice(1) : "";
    if (best === null || letter > best.letter) best = { letter, member: name.slice(0, -".json".length) };
  }
  return best === null ? null : { member: best.member, path: reportPath(scratch, best.member) };
}

/** The scratch root this repository's members write under: the path
 * scratch-root.mjs prints, computed the same way, but never created. Throws
 * fleet-dir.mjs's FleetDirUnresolvable where no repository is there to key on. */
export function defaultScratch() {
  return scratchRoot();
}
