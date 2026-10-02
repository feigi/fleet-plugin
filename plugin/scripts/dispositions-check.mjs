#!/usr/bin/env node
// The disposition check: a review fix-applier's rulings on a review's
// findings, checked as code rather than read back from its report. The
// fix-applier writes its record to `<scratch>/dispositions-<pr>.json` beside
// the review result file `<scratch>/review-<pr>.json`; this script reads the
// two together, judges the record, and writes its verdict onto the PR's
// ledger row as a token `ledger.mjs dispatch` gates the PR's finisher on:
//
//   dispositions-ok=fix-pr-<M>[-x]:<head>        every rule below held
//   dispositions-mismatch=fix-pr-<M>[-x]:<head>  at least one entry broke one
//
// `<head>` is the review file's `head` — the review the record answers — so a
// verdict on one review never answers a later one.
//
// The record:
//
//   { "head": "<the review file's head>",
//     "entries": [ { "bucket": "survived" | "unverified" | "refuted",
//                    "index": <position in that bucket of the review file>,
//                    "scope": "in" | "out",
//                    "claimKind": "behavior" | "shape",
//                    "disposition": "apply" | "defer",
//                    "reason": "<string>",          optional
//                    "issue": <number>,             optional: filed or commented to
//                    "verdictPath": "<path>",       optional: an in-scope suggestion's refuter verdict
//                    "remedyFiles": ["<path>", …]   optional: files the remedy names
//                  }, … ] }
//
// One entry per `survived` finding and per `unverified` finding, plus one per
// `refuted` finding the fix-applier reverses, its evidence in `reason`. A
// position is stable because a review round's file never changes.
//
// Rules — each broken one is reported as `<bucket>[<index>]: <rule>`:
//   - Coverage: a `survived` or `unverified` finding with no entry was
//     dropped. An entry naming no finding, or a second entry for one finding,
//     answers nothing.
//   - Shape: `scope`, `claimKind` and `disposition` take the values above;
//     the optional fields, when present, take the types above.
//   - Scope presumption: the touched lines are the new-side lines of
//     `git diff <merge-base> <head>`, the merge-base taken between
//     `origin/main` and the review's `<head>` — never the worktree's later
//     commits, so a fix-applier commit that shifts lines changes nothing
//     here. A finding whose `file` and `line` sit on a touched line is in
//     scope whatever the entry declares, and a finding with no `line` (or no
//     `file`) is in scope. Otherwise the declared `scope` stands.
//   - An in-scope `survived` finding deferred passes only with `reason` one
//     of ALLOWED_DEFER. Any other reason, or none, is a mismatch.
//
// Exit status: 0 ok; 1 mismatch; 2 nothing judged and nothing written — a
// bad flag, an unreadable review file, a git or ledger failure. A missing or
// unparseable RECORD is judged, not refused: the fix-applier wrote nothing a
// reader can use, so every finding it had to cover is dropped.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { parseMember, memberTokens } from "./ledger-grammar.mjs";
import { dispositionsToken, rowNums } from "./fleet-tick.mjs";

const NAME = "dispositions-check";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// ---------------------------------------------------------------------------
// pure core — no filesystem or process access until main()
// ---------------------------------------------------------------------------

export const ALLOWED_DEFER = Object.freeze(["false-rationale", "mutual-exclusion", "remedy-worse"]);
const COVERED = ["survived", "unverified"];
const BUCKETS = [...COVERED, "refuted"];
const ENUMS = { scope: ["in", "out"], claimKind: ["behavior", "shape"], disposition: ["apply", "defer"] };

export const dispositionsOkToken = (member, head) => `dispositions-ok=${member}:${head}`;
export const dispositionsMismatchToken = (member, head) => `dispositions-mismatch=${member}:${head}`;

/**
 * The new-side line numbers each file's hunks touch, from `git diff
 * --unified=0` output with `a/`/`b/` prefixes. A pure deletion (`+c,0`)
 * touches no new-side line; a deleted file has no new side at all.
 * @returns {Map<string, Set<number>>}
 */
export function touchedLines(diffText) {
  const touched = new Map();
  let file = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (file !== null && !touched.has(file)) touched.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file !== null) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let n = start; n < start + count; n++) touched.get(file).add(n);
    }
  }
  return touched;
}

// A finding's `file` as the diff spells it: relative to the repository root,
// no leading `./`. A specialist that reported an absolute path into the
// review's snapshot, or into the repository itself, is read relative to it.
export function repoPath(file, roots = []) {
  let p = String(file);
  if (isAbsolute(p)) {
    for (const root of roots) {
      if (!root) continue;
      const rel = relative(root, p);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    return p;
  }
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

// Why a finding is in scope regardless of what its entry declares, or null
// when the declared scope stands.
function presumedInScope(finding, touched, roots) {
  if (!Number.isInteger(finding.line)) return "it has no line";
  if (typeof finding.file !== "string" || finding.file === "") return "it has no file";
  if (touched.get(repoPath(finding.file, roots))?.has(finding.line)) {
    return `${repoPath(finding.file, roots)}:${finding.line} is a line the PR's diff touched`;
  }
  return null;
}

function shapeErrors(e) {
  const errors = [];
  for (const [field, values] of Object.entries(ENUMS)) {
    if (!values.includes(e[field])) errors.push(`${field} ${JSON.stringify(e[field] ?? null)} is not one of ${values.join("|")}`);
  }
  if (e.reason !== undefined && typeof e.reason !== "string") errors.push("reason is not a string");
  if (e.issue !== undefined && !(Number.isInteger(e.issue) && e.issue > 0)) errors.push("issue is not an issue number");
  if (e.verdictPath !== undefined && typeof e.verdictPath !== "string") errors.push("verdictPath is not a string");
  if (e.remedyFiles !== undefined && !(Array.isArray(e.remedyFiles) && e.remedyFiles.every((f) => typeof f === "string"))) {
    errors.push("remedyFiles is not an array of paths");
  }
  return errors;
}

/**
 * Every rule the record breaks against the review, as `{bucket, index, rule}`
 * — `bucket`/`index` null for a rule about the record as a whole. Empty means
 * ok. `record` is the parsed record, or null when there is none to read
 * (`recordProblem` then says why). `touched` is touchedLines() for the
 * review's head; `roots` the directories an absolute finding path is read
 * relative to.
 */
export function checkDispositions({ review, record, recordProblem = null, touched, roots = [] }) {
  const violations = [];
  const at = (bucket, index, rule) => violations.push({ bucket, index, rule });

  let entries = [];
  if (record === null) {
    at(null, null, recordProblem ?? "no disposition record");
  } else if (typeof record !== "object" || Array.isArray(record) || !Array.isArray(record.entries)) {
    at(null, null, "the record is not {head, entries: [...]}");
  } else {
    entries = record.entries;
    const head = String(record.head ?? "").toLowerCase();
    const reviewHead = String(review.head).toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(head) || !(reviewHead.startsWith(head) || head.startsWith(reviewHead))) {
      at(null, null, `the record answers head ${JSON.stringify(record.head ?? null)}, not the review's ${review.head}`);
    }
  }

  const seen = new Map();
  entries.forEach((e, n) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      at(null, null, `entries[${n}] is not an object`);
      return;
    }
    const { bucket, index } = e;
    if (!BUCKETS.includes(bucket)) {
      at(null, null, `entries[${n}] names bucket ${JSON.stringify(bucket ?? null)}, not one of ${BUCKETS.join("|")}`);
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= review[bucket].length) {
      at(bucket, index ?? null, `entries[${n}] names no finding — ${bucket} holds ${review[bucket].length}`);
      return;
    }
    const key = `${bucket}[${index}]`;
    if (seen.has(key)) {
      at(bucket, index, `a second entry (entries[${n}]) for a finding entries[${seen.get(key)}] already answers`);
      return;
    }
    seen.set(key, n);
    const errors = shapeErrors(e);
    if (errors.length > 0) {
      at(bucket, index, `malformed entry — ${errors.join("; ")}`);
      return;
    }
    if (bucket === "refuted") {
      if (!e.reason?.trim()) at(bucket, index, "a reversed refutation names its evidence in reason, and this one names none");
      return;
    }
    if (bucket !== "survived" || e.disposition !== "defer") return;
    const presumed = presumedInScope(review[bucket][index], touched, roots);
    if (presumed === null && e.scope === "out") return;
    if (ALLOWED_DEFER.includes(e.reason)) return;
    const why = presumed === null ? "its entry declares scope in" : `${presumed}, so it is in scope whatever its entry declares`;
    const reason = e.reason === undefined || e.reason === "" ? "no reason" : `reason ${JSON.stringify(e.reason)}`;
    at(bucket, index, `an in-scope survived finding deferred with ${reason} — ${why}; it defers only for ${ALLOWED_DEFER.join(", ")}`);
  });

  for (const bucket of COVERED) {
    review[bucket].forEach((_, index) => {
      if (!seen.has(`${bucket}[${index}]`)) at(bucket, index, "no entry — a finding with no entry is a dropped finding");
    });
  }
  return violations;
}

export function formatViolation({ bucket, index, rule }) {
  return bucket === null ? `record: ${rule}` : `${bucket}[${index}]: ${rule}`;
}

// The row text with `token` in place of every verdict the same member wrote
// for the same review head — a re-run replaces its own earlier verdict rather
// than leaving two to disagree. Unchanged when the token is already the only
// one. Separators a removal leaves doubled are folded.
export function withVerdict(rowText, token) {
  const mine = dispositionsToken(token);
  const words = String(rowText).trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const d = dispositionsToken(w);
    return d === null || d.member.name !== mine.member.name
      || !(d.head.startsWith(mine.head) || mine.head.startsWith(d.head));
  });
  if (kept.length === words.length - 1 && words.includes(token)) return words.join(" ");
  const folded = kept.join(" ").replace(/·(?:\s+·)+/g, "·").replace(/^·\s+|\s+·$/g, "").trim();
  return folded === "" ? token : `${folded} · ${token}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const { arg, sweep, stray } = defineFlags(die, {
  flags: { member: "value", scratch: "value", repo: "value", ledger: "value" },
});

// The one git primitive. An ambient GIT_DIR or GIT_WORK_TREE — a hook, a
// `rebase --exec` — would answer for another repository and judge the record
// against that repository's diff, so both are scrubbed.
function git(repo, args, what) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", env: gitEnv({ LC_ALL: "C" }), maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    die(`could not ${what}: ${e.stderr?.toString().trim() || e.message}`);
  }
}

function runLedger(ledgerFile, args, what) {
  try {
    return execFileSync(process.execPath, [LEDGER_SCRIPT, ...(ledgerFile ? ["--file", ledgerFile] : []), ...args], { encoding: "utf8" });
  } catch (e) {
    die(`could not ${what}: ${e.stderr?.trim() || e.message}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const usage = "usage: dispositions-check.mjs --member fix-pr-<M>[-x] --scratch <dir> [--repo <path>] [--ledger <path>]";
  const name = arg("member");
  const scratch = arg("scratch");
  if (!name || !scratch) die(usage);
  sweep();
  stray();
  const member = parseMember(name);
  if (member === null || member.family !== "fix-pr") die(`'${name}' is not a fix-applier — expected fix-pr-<M>, a -b, -c … suffix allowed`);
  const pr = member.number;
  const repo = arg("repo") ?? process.cwd();
  const ledgerFile = arg("ledger");

  const reviewPath = join(scratch, `review-${pr}.json`);
  let review;
  try {
    review = readJson(reviewPath);
  } catch (e) {
    die(`could not read the review file ${reviewPath}: ${e.message}`);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(String(review?.head ?? ""))) die(`${reviewPath} carries no head commit`);
  for (const bucket of BUCKETS) {
    if (!Array.isArray(review[bucket])) die(`${reviewPath} has no ${bucket} list`);
    if (bucket !== "refuted" && review.counts?.[bucket] !== review[bucket].length) {
      die(`${reviewPath}'s counts.${bucket} is ${review.counts?.[bucket]}, but ${bucket} holds ${review[bucket].length} — the review file does not reconcile with itself`);
    }
  }
  const head = String(review.head).toLowerCase();

  const recordPath = join(scratch, `dispositions-${pr}.json`);
  let record = null, recordProblem = null;
  if (!existsSync(recordPath)) {
    recordProblem = `no disposition record at ${recordPath}`;
  } else {
    try {
      record = readJson(recordPath);
    } catch (e) {
      recordProblem = `${recordPath} is not JSON — ${e.message}`;
    }
  }

  const base = git(repo, ["merge-base", "origin/main", head], `find the merge-base of origin/main and ${head}`).trim();
  const diff = git(repo, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--unified=0", "-M",
    "--src-prefix=a/", "--dst-prefix=b/", base, head], `diff ${base}..${head}`);
  const top = git(repo, ["rev-parse", "--show-toplevel"], "find the repository root").trim();

  const violations = checkDispositions({
    review, record, recordProblem, touched: touchedLines(diff), roots: [review.snapshot, top],
  });
  const verdict = violations.length === 0 ? "ok" : "mismatch";
  const token = verdict === "ok" ? dispositionsOkToken(member.name, head) : dispositionsMismatchToken(member.name, head);

  // The verdict lands on the row carrying the member on its own PR's row —
  // where `ledger.mjs dispatch` wrote it, and where the gate reads PR M's
  // tokens from.
  const data = JSON.parse(runLedger(ledgerFile, ["read"], "read the ledger"));
  const row = data.rows.find((r) => rowNums(r).pr === pr && memberTokens(r).some((t) => t.name === member.name));
  if (row === undefined) die(`${member.name} is on no row of PR #${pr} — \`ledger.mjs dispatch\` records a fix-applier before its record can be checked`);
  const key = row.split(/\s/)[0];
  if (!/^#[0-9]+$/.test(key)) die(`the row carrying ${member.name} has no #<n> key for \`ledger.mjs row\` to rewrite it by: ${row}`);
  const text = row.slice(key.length).trim();
  const updated = withVerdict(text, token);
  if (updated === text) console.error(`    ${member.name}: row ${key} already carries ${token} — not written again`);
  else runLedger(ledgerFile, ["row", key, updated], `write ${token} onto row ${key}`);

  for (const v of violations) console.error(`${member.name}: ${formatViolation(v)}`);
  console.log(JSON.stringify({ member: member.name, pr, head, verdict, token, violations }));
  // exitCode, not exit(): stdout to a pipe is written asynchronously, and an
  // exit() here could cut the payload off.
  process.exitCode = verdict === "ok" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
