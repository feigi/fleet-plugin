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
//   dispositions-escalate=fix-pr-<M>[-x]:<head>  a human rules: either every rule held
//                                                but a critical or important finding
//                                                was deferred `remedy-outside-diff`,
//                                                or a rule broke and an earlier
//                                                fix-applier's record on the same
//                                                review already had
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
//   - `remedy-outside-diff` passes only when `remedyFiles` names at least one
//     file absent from the file list of `git diff <merge-base>...<head>`
//     (renames and deletions listed on both sides, so a file the PR deleted
//     or moved away is in the diff). Empty `remedyFiles`, or every file named
//     inside the diff, is a mismatch. The reason can be gamed by naming any
//     untouched file, so a deferral for it of a `critical` or `important`
//     finding — or of one whose severity is neither that nor `suggestion` —
//     is escalated rather than passed: the verdict is `escalate`, and the
//     output names each such finding. A `suggestion` passes as `ok`. A record
//     that also breaks a rule is a `mismatch`, its escalations printed too.
//
// Exit status: 0 ok; 1 mismatch or escalate; 2 nothing judged and nothing
// written — a bad flag, an unreadable or malformed review file, a record file
// that exists but cannot be read, a git or ledger failure. A missing or
// unparseable RECORD is judged, not refused: the fix-applier wrote nothing a
// reader can use, so every finding it had to cover is dropped.
//
// Without a ledger the record is judged all the same and the exit status is
// the whole verdict: no token is written, no row is read, and `token` in the
// stdout payload is null. That is the shape of a standalone `/review-and-fix`
// with no controller, and it is chosen, never inferred — pass `--no-ledger`.
// A repository's `.fleet/ledger.md` outlives the fleet run that wrote it, so a
// standalone member in a worktree of such a repository would otherwise find
// the previous run's ledger, and a ledger that exists is never skipped: one
// holding no row for the member is a fault (exit 2), as is a ledger path that
// cannot be looked up (a parent that is a file, no permission, a symlink loop).
// Only a path that does not exist is "no ledger". `--no-ledger` names that
// state outright: no ledger is looked for, whatever the repository holds, and
// it contradicts `--ledger`.

import { readFileSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { isCLI } from "./is-cli.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";
import { parseMember, memberTokens } from "./ledger-grammar.mjs";
import { dispositionsToken, rowNums, sameHead } from "./fleet-tick.mjs";

const NAME = "dispositions-check";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// ---------------------------------------------------------------------------
// pure core — no filesystem or process access until main()
// ---------------------------------------------------------------------------

const REMEDY_OUTSIDE_DIFF = "remedy-outside-diff";
export const ALLOWED_DEFER = Object.freeze(["false-rationale", "mutual-exclusion", "remedy-worse", REMEDY_OUTSIDE_DIFF]);
const COVERED = ["survived", "unverified"];
const BUCKETS = [...COVERED, "refuted"];
const ENUMS = { scope: ["in", "out"], claimKind: ["behavior", "shape"], disposition: ["apply", "defer"] };

// Why `review` is not a review file this check can judge a record against,
// or null when it is: a 7-40 hex `head`, every bucket a list of finding
// objects, and `counts` reconciling with the lists it counts. checkDispositions
// reads `review` on that precondition, and main() refuses a file that breaks
// it rather than judging a record against it.
export function reviewProblem(review) {
  if (review === null || typeof review !== "object" || Array.isArray(review)) return "is not a review result object";
  if (!/^[0-9a-f]{7,40}$/i.test(String(review.head ?? ""))) return "carries no head commit";
  for (const bucket of BUCKETS) {
    if (!Array.isArray(review[bucket])) return `has no ${bucket} list`;
    const bad = review[bucket].findIndex((f) => f === null || typeof f !== "object" || Array.isArray(f));
    if (bad !== -1) return `has a ${bucket}[${bad}] that is not a finding object`;
    if (bucket !== "refuted" && review.counts?.[bucket] !== review[bucket].length) {
      return `says counts.${bucket} is ${review.counts?.[bucket]}, but ${bucket} holds ${review[bucket].length} — the review file does not reconcile with itself`;
    }
  }
  return null;
}

/**
 * The new-side line numbers each file's hunks touch, from `git diff
 * --unified=0` output with `a/`/`b/` prefixes. A pure deletion (`+c,0`)
 * touches no new-side line; a deleted file has no new side at all.
 *
 * A `+++ ` line is a file header only BETWEEN hunks: inside one, each hunk's
 * own line counts are consumed first, so an added content line that begins
 * `++ ` (printed `+++ …`) is content, never a header that would credit every
 * later hunk to a path that does not exist.
 * @returns {Map<string, Set<number>>}
 */
export function touchedLines(diffText) {
  const touched = new Map();
  let file = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diffText.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      else if (line.startsWith(" ")) { oldLeft--; newLeft--; }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4));
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (file !== null && !touched.has(file)) touched.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      const start = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
      if (file !== null) for (let n = start; n < start + newLeft; n++) touched.get(file).add(n);
    }
  }
  return touched;
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

// A `+++ ` header's path as git wrote it: the trailing tab git appends to a
// name holding a space dropped, and a C-quoted name (`"b/q\"x.js"`, used for
// a quote, a backslash, a control character or — with core.quotePath — a
// non-ASCII byte) unquoted, its octal escapes read as UTF-8 bytes.
function headerPath(raw) {
  const p = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { bytes.push(...Buffer.from(c, "utf8")); continue; }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? "")) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))[0];
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// A finding's `file` as the diff spells it: relative to the repository root,
// no leading `./`. A specialist that reported an absolute path into the
// review's snapshot, or into the repository itself, is read relative to it.
// An absolute path under none of `roots` — a specialist's own copy of the
// snapshot, a `/tmp` alias of a `/private/tmp` root — is read as the longest
// of `known` (the diff's file names) it ends in, at a path-component
// boundary: no suffix of the path naming a touched file is the only case in
// which it cannot sit on a touched line under any root.
export function repoPath(file, roots = [], known = []) {
  let p = String(file);
  if (isAbsolute(p)) {
    for (const root of roots) {
      if (!root) continue;
      const rel = relative(root, p);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    let best = null;
    for (const k of known) {
      if (p.endsWith(`/${k}`) && (best === null || k.length > best.length)) best = k;
    }
    return best ?? p;
  }
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

// Why a finding is in scope regardless of what its entry declares, or null
// when the declared scope stands.
function presumedInScope(finding, touched, roots) {
  if (!Number.isInteger(finding.line)) return "it has no line";
  if (typeof finding.file !== "string" || finding.file === "") return "it has no file";
  const file = repoPath(finding.file, roots, touched.keys());
  if (touched.get(file)?.has(finding.line)) return `${file}:${finding.line} is a line the PR's diff touched`;
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
 * Every rule the record breaks against the review, as `violations` of
 * `{bucket, index, rule}` — `bucket`/`index` null for a rule about the record
 * as a whole — and every deferral that needs a human, as `escalations` of
 * `{bucket, index, severity, files}`. Empty `violations` means the record
 * holds every rule. `record` is the parsed record, or null when there is none
 * to read (`recordProblem` then says why). `touched` is touchedLines() for the
 * review's head; `diffFiles` every file name `git diff <merge-base>...<head>`
 * lists, required only when an entry defers `remedy-outside-diff`; `roots` the
 * directories an absolute finding or remedy path is read relative to.
 * `review` must pass reviewProblem() — a bucket missing or holding a
 * non-object is a TypeError here, not a violation.
 */
export function checkDispositions({ review, record, recordProblem = null, touched, diffFiles = null, roots = [] }) {
  const violations = [];
  const escalations = [];
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
    if (!/^[0-9a-f]{7,40}$/.test(head) || !sameHead(head, reviewHead)) {
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
    if (!ALLOWED_DEFER.includes(e.reason)) {
      const why = presumed === null ? "its entry declares scope in" : `${presumed}, so it is in scope whatever its entry declares`;
      const reason = e.reason === undefined || e.reason === "" ? "no reason" : `reason ${JSON.stringify(e.reason)}`;
      at(bucket, index, `an in-scope survived finding deferred with ${reason} — ${why}; it defers only for ${ALLOWED_DEFER.join(", ")}`);
      return;
    }
    if (e.reason !== REMEDY_OUTSIDE_DIFF) return;
    if (diffFiles === null) throw new TypeError("checkDispositions: an entry defers remedy-outside-diff and no diffFiles was given");
    const inDiff = new Set(diffFiles);
    const named = (e.remedyFiles ?? []).map((f) => f.trim()).filter((f) => f !== "");
    const outside = named.map((f) => posix.normalize(repoPath(f, roots, inDiff))).filter((f) => !inDiff.has(f));
    if (outside.length === 0) {
      const what = named.length === 0 ? "remedyFiles names no file" : "every file remedyFiles names is in the PR's diff";
      at(bucket, index, `reason remedy-outside-diff needs a remedy file absent from the PR's diff — ${what}`);
      return;
    }
    const severity = review[bucket][index].severity;
    if (severity !== "suggestion") escalations.push({ bucket, index, severity: severity ?? null, files: outside });
  });

  for (const bucket of COVERED) {
    review[bucket].forEach((_, index) => {
      if (!seen.has(`${bucket}[${index}]`)) at(bucket, index, "no entry — a finding with no entry is a dropped finding");
    });
  }
  return { violations, escalations };
}

export function formatViolation({ bucket, index, rule }) {
  return bucket === null ? `record: ${rule}` : `${bucket}[${index}]: ${rule}`;
}

export function formatEscalation({ bucket, index, severity, files }) {
  return `${bucket}[${index}]: a ${severity ?? "severity-less"} finding deferred remedy-outside-diff, its remedy in ${files.join(", ")} — a human rules`;
}

// The row text with `token` in place of every verdict the same member wrote
// for the same review head — a re-run replaces its own earlier verdict rather
// than leaving two to disagree. Unchanged when the token is already the only
// one. Separators a removal leaves doubled are folded.
export function withVerdict(rowText, token) {
  const mine = dispositionsToken(token);
  if (mine === null) throw new Error(`withVerdict: '${token}' is not a dispositions-ok=/dispositions-mismatch=/dispositions-escalate= token`);
  const words = String(rowText).trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const d = dispositionsToken(w);
    return d === null || d.member.name !== mine.member.name || !sameHead(d.head, mine.head);
  });
  if (kept.length === words.length - 1 && words.includes(token)) return words.join(" ");
  const folded = kept.join(" ").replace(/·(?:\s+·)+/g, "·").replace(/^·\s*|\s*·$/g, "").trim();
  return folded === "" ? token : `${folded} · ${token}`;
}

// Whether a fix-applier on PR `pr` with a lower retry suffix than `member`
// already has a mismatch or escalate on the ledger for `head` — on any row
// that resolves to the PR, since a row can be split. A verdict on another
// review head counts for nothing, so a new review starts the count again.
export function failedBefore(rows, pr, member, head) {
  const mine = member.retry ?? "";
  return rows.some((r) => rowNums(r).pr === pr && r.split(/\s+/).some((w) => {
    const d = dispositionsToken(w);
    return d !== null && d.verdict !== "ok" && d.member.number === pr
      && (d.member.retry ?? "") < mine && sameHead(d.head, head);
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const { arg, has, sweep, stray } = defineFlags(die, {
  flags: { member: "value", scratch: "value", repo: "value", ledger: "value", "no-ledger": "bool" },
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
    return execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, ...args], { encoding: "utf8" });
  } catch (e) {
    die(`could not ${what}: ${e.stderr?.trim() || e.message}`);
  }
}

// The ledger file this run writes its verdict to, or null when there is none:
// `--ledger`, else the run's `.fleet/ledger.md` under the git common dir of
// `repo` — the workspace every worktree of one repository shares, which is
// where `ledger.mjs dispatch` wrote the member's row. The path is handed to
// `ledger.mjs` as `--file`, so the existence probe and the calls that follow
// answer for one file. Only ENOENT means "there is none": any other failure
// to look the path up is a fault, not a standalone run. `lstat`, not `stat`, so
// a dangling symlink is a ledger that cannot be read rather than an absent one.
function ledgerInUse(explicit, repo) {
  const file = explicit ?? join(
    workspaceDirFromGitCommonDir(git(repo, ["rev-parse", "--git-common-dir"], "find the git common dir"), repo)
      ?? die("could not find the git common dir: git printed none"),
    ".fleet", "ledger.md",
  );
  try {
    lstatSync(file);
    return file;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    die(`could not look for the ledger ${file}: ${e.message}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const usage = "usage: dispositions-check.mjs --member fix-pr-<M>[-x] --scratch <dir> [--repo <path>] [--ledger <path> | --no-ledger]";
  const name = arg("member");
  const scratch = arg("scratch");
  if (!name || !scratch) die(usage);
  sweep();
  stray();
  const member = parseMember(name);
  if (member === null || member.family !== "fix-pr") die(`'${name}' is not a fix-applier — expected fix-pr-<M>, a -b, -c … suffix allowed`);
  const pr = member.number;
  const repo = arg("repo") ?? process.cwd();
  const standalone = has("no-ledger");
  if (standalone && arg("ledger") !== null) die("--no-ledger and --ledger contradict: name one");

  const reviewPath = join(scratch, `review-${pr}.json`);
  let review;
  try {
    review = readJson(reviewPath);
  } catch (e) {
    die(`could not read the review file ${reviewPath}: ${e.message}`);
  }
  const problem = reviewProblem(review);
  if (problem !== null) die(`${reviewPath} ${problem}`);
  const head = String(review.head).toLowerCase();

  const recordPath = join(scratch, `dispositions-${pr}.json`);
  let record = null, recordProblem = null;
  if (!existsSync(recordPath)) {
    recordProblem = `no disposition record at ${recordPath}`;
  } else {
    // A record that cannot be READ — a directory, no permission — is a fault
    // in the environment, not a ruling the fix-applier wrote: nothing is
    // judged and nothing written. Only one that reads and will not parse is
    // the fix-applier's own, and judged.
    let text;
    try {
      text = readFileSync(recordPath, "utf8");
    } catch (e) {
      die(`could not read the disposition record ${recordPath}: ${e.message}`);
    }
    try {
      record = JSON.parse(text);
    } catch (e) {
      recordProblem = `${recordPath} is not JSON — ${e.message}`;
    }
  }

  const base = git(repo, ["merge-base", "origin/main", head], `find the merge-base of origin/main and ${head}`).trim();
  const diff = git(repo, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--unified=0", "-M",
    "--src-prefix=a/", "--dst-prefix=b/", base, head], `diff ${base}..${head}`);
  const top = git(repo, ["rev-parse", "--show-toplevel"], "find the repository root").trim();
  // Every file the diff lists, a rename or a deletion by both its names — a
  // file the PR moved away or removed is a file the PR's diff names.
  const diffFiles = git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head],
    `list the files of ${base}..${head}`).split("\0").filter(Boolean);
  const ledgerFile = standalone ? null : ledgerInUse(arg("ledger"), repo);

  const { violations, escalations } = checkDispositions({
    review, record, recordProblem, touched: touchedLines(diff), diffFiles, roots: [review.snapshot, top],
  });
  // The verdict lands on the row carrying the member on its own PR's row —
  // where `ledger.mjs dispatch` wrote it, and where the gate reads PR M's
  // tokens from. No ledger, no row: the exit status below is the verdict, and
  // with no earlier fix-applier's verdict to count, a broken rule is always a
  // mismatch.
  const data = ledgerFile === null ? null : JSON.parse(runLedger(ledgerFile, ["read"], "read the ledger"));
  // A mismatch an earlier fix-applier already drew on this review makes this
  // one the second: it is written as an escalate, which no fix-applier answers.
  const secondMismatch = violations.length > 0 && data !== null && failedBefore(data.rows, pr, member, head);
  const verdict = violations.length > 0 ? (secondMismatch ? "escalate" : "mismatch")
    : escalations.length > 0 ? "escalate" : "ok";
  const token = `dispositions-${verdict}=${member.name}:${head}`;

  if (data !== null) {
    const row = data.rows.find((r) => rowNums(r).pr === pr && memberTokens(r).some((t) => t.name === member.name));
    if (row === undefined) die(`${member.name} is on no row of PR #${pr} — \`ledger.mjs dispatch\` records a fix-applier before its record can be checked; with no controller, pass --no-ledger`);
    const key = row.split(/\s/)[0];
    if (!/^#[0-9]+$/.test(key)) die(`the row carrying ${member.name} has no #<n> key for \`ledger.mjs row\` to rewrite it by: ${row}`);
    const text = row.slice(key.length).trim();
    const updated = withVerdict(text, token);
    if (updated === text) console.error(`    ${member.name}: row ${key} already carries ${token} — not written again`);
    else runLedger(ledgerFile, ["row", key, updated], `write ${token} onto row ${key}`);
  }

  for (const v of violations) console.error(`${member.name}: ${formatViolation(v)}`);
  for (const x of escalations) console.error(`${member.name}: ${formatEscalation(x)}`);
  if (secondMismatch) {
    console.error(`${member.name}: escalate — an earlier fix-applier's record on review ${head} already failed this check; no further fix-applier answers PR #${pr}, a human does`);
  }
  console.log(JSON.stringify({ member: member.name, pr, head, verdict, token: ledgerFile === null ? null : token, violations, escalations }));
  // exitCode, not exit(): stdout to a pipe is written asynchronously, and an
  // exit() here could cut the payload off.
  process.exitCode = verdict === "ok" ? 0 : 1;
}

// Only run main() as a CLI, never when imported (see is-cli.mjs): a string
// comparison skipped main() through a symlinked path and exited 0 — the code
// that means ok — having judged and written nothing.
if (isCLI(import.meta.url)) main();
