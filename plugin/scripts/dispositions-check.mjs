#!/usr/bin/env node
// The disposition check: a review fix-applier's rulings on a review's
// findings, checked as code rather than read back from its report. The
// fix-applier writes its record to `<scratch>/dispositions-fix-pr-<M>[-x].json`,
// one file per fix-applier; the review result file it answers is
// `<scratch>/pr<M>/<run>/review.json`, `<run>` the run root the PR's latest
// `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>` names. This
// script reads the two together, judges the record, and writes its verdict
// onto the PR's ledger row as a token `ledger.mjs dispatch` gates the PR's
// finisher on:
//
//   dispositions-ok=fix-pr-<M>[-x]:<run>        every rule below held
//   dispositions-mismatch=fix-pr-<M>[-x]:<run>  at least one entry broke one
//   dispositions-escalate=fix-pr-<M>[-x]:<run>  a human rules: either every rule held
//                                               but a critical or important finding
//                                               was deferred `remedy-outside-diff`,
//                                               or a rule broke and an earlier
//                                               fix-applier's record on the same
//                                               review already had
//   dispositions-unchecked=fix-pr-<M>[-x]:<run> no rule broke, but where a deferral was
//                                               filed could not be read
//
// `<run>` is the review's own run, so a verdict on one review never answers
// a later one — a second review at the same head included.
//
// The record:
//
//   { "head": "<the review file's head>",
//     "run": "<the review's run root, as the review path names it>",
//     "entries": [ { "bucket": "survived" | "unverified" | "refuted",
//                    "index": <position in that bucket of the review file>,
//                    "scope": "in" | "out",
//                    "claimKind": "behavior" | "shape",
//                    "disposition": "apply" | "defer",
//                    "reason": "<string>",          required, non-empty, on a `refuted` entry; else optional
//                    "issue": <number>,             optional: filed or commented to
//                    "verdictPath": "<path>",       optional: an in-scope suggestion's refuter verdict
//                    "remedyFiles": ["<path>", …]   optional: files the remedy names
//                  }, … ] }
//
// One entry per `survived` finding and per `unverified` finding, plus one per
// `refuted` finding the fix-applier reverses. A `refuted` entry carries
// `scope`, `claimKind` and `disposition` like every other entry, and a
// non-empty `reason` holding the evidence that reverses it; a missing or blank
// `reason` is a mismatch. A position is stable because a review round's file
// never changes.
//
// Rules — each broken one is reported as `<bucket>[<index>]: <rule>`:
//   - Run: with a ledger, `run` is the run the PR's latest `reviewed=` names. A
//     record naming another run, or none, answers a review that is not this
//     one — a fix-applier that ruled on an earlier review at the same head
//     included — and is a mismatch. Without a ledger nothing names the run,
//     and `run` is not read.
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
//     `disposition` has no `dismiss`: an in-scope `survived` finding verified
//     correct, needing no change, is deferred with `reason` `false-rationale`
//     and filed on the closed suggestion-band record.
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
//   - Refuter evidence: an in-scope suggestion — an `unverified` finding no
//     refuter was dispatched against (`refutersDispatched` zero or absent),
//     in scope by the presumption above or by its entry — needs
//     `verdictPath`: an absolute path to a file under the fix-applier's own
//     run root, `<scratch>/pr<N>/fix-XXXXXXXX/<finding>/`, holding a JSON
//     object that validates against the refuter verdict schema
//     `{refuted, reason}`. No `verdictPath`, a path outside that root, a file
//     missing, or one failing the schema — or abstaining, `inconclusive:
//     true` — is a mismatch. `refuted: true` puts
//     the finding on filing row 4, where applying it is a mismatch too;
//     `refuted: false` on row 5.
//   - Filing: every deferral names in `issue` the issue it was filed to, and
//     that issue — read back through `gh issue view --json
//     labels,state,title` — must be its finding's home in this table. A
//     mismatch names the row the entry broke:
//
//       row  finding                                             home
//       1    survived, in scope, deferred for an allowed         open, ready-for-agent
//            reason other than false-rationale
//       2    survived, in scope, deferred false-rationale        closed suggestion-band record
//       3    unverified, its refuters dispatched and crashed     open, needs-triage
//            or abstained
//       4    in-scope suggestion, its refuter refuted it         closed suggestion-band record
//       5    in-scope suggestion, its refuter let it survive     applied, or deferred as row 1
//       6    out-of-scope suggestion alleging wrong behavior     open, needs-triage
//       7    claimKind shape, below the claim bar                closed suggestion-band record
//       8    survived, out of scope, whatever its reason         open, ready-for-agent
//
//     Row 4 outranks row 7, and row 7 every other row. A row-5 deferral is
//     held to row 1's reasons: one of ALLOWED_DEFER other than
//     false-rationale, `remedy-outside-diff` under the rule above. A row-8
//     deferral is held to no reason and escalates nothing, whatever its
//     severity. An open home carries exactly one triage label, its row's or
//     a stronger one: `ready-for-agent` answers a `needs-triage` row, and
//     `needs-triage` never answers a `ready-for-agent` one. The closed
//     suggestion-band record is the closed issue titled `PR #<pr> review:
//     the suggestion band, checked`, labelled `wontfix`. `claimKind` is
//     trusted: the script never judges whether a claim is about shape. A
//     deferral no row holds — a reversed refutation whose claim is about
//     behavior — is a mismatch naming no filing-table row.
//
// Unchecked: `gh` unreachable, or a deferral's issue it cannot read, leaves
// that entry's filing unjudged. With no rule broken and nothing escalated the
// verdict is `unchecked`, which `ledger.mjs dispatch` refuses a finisher on —
// never ok, and never a mismatch, since the record broke nothing. Run the
// check again once `gh` answers.
//
// Exit status: 0 ok; 1 mismatch, escalate or unchecked; 2 nothing judged and
// nothing written — a bad flag, an unreadable or malformed review file, a
// record file that exists but cannot be read, a git or ledger failure. A
// missing or unparseable RECORD is judged, not refused: the fix-applier wrote
// nothing a reader can use, so every finding it had to cover is dropped.
//
// Without a ledger the record is judged all the same and the exit status is
// the whole verdict: no token is written, no row is read, and `token` in the
// stdout payload is null. That is the shape of a standalone `/review-and-fix`
// with no controller, chosen by `--no-ledger` or by a ledger path that does
// not exist. With no `reviewed=` to name the review, `--review <path>` names
// its file, and is required; with a ledger it is refused, since the ledger
// already names one.
// A repository's `.fleet/ledger.md` outlives the fleet run that wrote it, so a
// standalone member in a worktree of such a repository would otherwise find
// the previous run's ledger, and a ledger that exists is never skipped: one
// holding no row for the member is a fault (exit 2), as is a ledger path that
// cannot be looked up (a parent that is a file, no permission, a symlink loop).
// Only a path that does not exist is "no ledger": the default path, or one
// `--ledger` names, which also prints a note on stderr that no token was
// written. `--no-ledger` names that state outright: no ledger is looked for,
// whatever the repository holds, and it contradicts `--ledger`.

import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute, relative, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { isCLI } from "./is-cli.mjs";
import { gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { parseMember, memberTokens, rowNums } from "./ledger-grammar.mjs";
import { deriveRun, dispositionsToken, LedgerError } from "./fleet-tick.mjs";
import { VERDICT_SCHEMA } from "./review-core.mjs";

const NAME = "dispositions-check";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// Two spellings of one commit: either head a prefix of the other, the way a
// record's head (7-40 hex) is matched against its review's full head.
const sameHead = (a, b) => a.startsWith(b) || b.startsWith(a);

// ---------------------------------------------------------------------------
// pure core — no filesystem or process access until main()
// ---------------------------------------------------------------------------

const REMEDY_OUTSIDE_DIFF = "remedy-outside-diff";
export const ALLOWED_DEFER = Object.freeze(["false-rationale", "mutual-exclusion", "remedy-worse", REMEDY_OUTSIDE_DIFF]);
const COVERED = ["survived", "unverified"];
const BUCKETS = [...COVERED, "refuted"];
const ENUMS = { scope: ["in", "out"], claimKind: ["behavior", "shape"], disposition: ["apply", "defer"] };

// The filing table: a deferral's home by its finding's state. `record` is the
// closed suggestion-band record; `open` the weakest triage label an open home may carry.
export const FILING_ROWS = Object.freeze({
  1: { finding: "an in-scope survived finding deferred for an allowed reason other than false-rationale", open: "ready-for-agent" },
  2: { finding: "an in-scope survived finding deferred false-rationale", record: true },
  3: { finding: "an unverified finding whose refuters crashed or abstained", open: "needs-triage" },
  4: { finding: "an in-scope suggestion its refuter refuted", record: true },
  5: { finding: "an in-scope suggestion its refuter let survive", open: "ready-for-agent" },
  6: { finding: "an out-of-scope suggestion alleging wrong behavior", open: "needs-triage" },
  7: { finding: "a finding whose claim is about shape, below the claim bar", record: true },
  8: { finding: "an out-of-scope survived finding, whatever its reason", open: "ready-for-agent" },
});
// Strongest first: an open home may carry a label above its row's, never below.
const TRIAGE_LABELS = ["ready-for-agent", "needs-triage"];
// Row 1's reasons, which a row-5 deferral is held to.
const ROW_1_DEFER = ALLOWED_DEFER.filter((r) => r !== "false-rationale");
export const recordTitle = (pr) => `PR #${pr} review: the suggestion band, checked`;

function homeText(row, pr) {
  if (row.record) return `the closed "${recordTitle(pr)}" issue, labelled wontfix`;
  return `an open issue labelled ${TRIAGE_LABELS.slice(0, TRIAGE_LABELS.indexOf(row.open) + 1).reverse().join(" or ")}`;
}

// Whether an issue `{state, title, labels}` is `row`'s home on PR `pr`.
function homeHolds(row, { state, title, labels }, pr) {
  if (row.record) return state === "CLOSED" && title.trim() === recordTitle(pr) && labels.includes("wontfix");
  const triage = labels.filter((l) => TRIAGE_LABELS.includes(l));
  return state === "OPEN" && triage.length === 1 && TRIAGE_LABELS.indexOf(triage[0]) <= TRIAGE_LABELS.indexOf(row.open);
}

// The row a deferral's finding state puts it on, by precedence, or null when
// no row holds it: only a reversed refutation (the refuted bucket) whose claim
// is not about shape. `refuted` is an in-scope suggestion's refuter verdict,
// null for any other finding.
function filingRow({ bucket, inScope, crashed, refuted, shape, reason }) {
  if (refuted === true) return 4;
  if (shape) return 7;
  if (bucket === "refuted") return null;
  if (crashed) return 3;
  if (!inScope) return bucket === "survived" ? 8 : 6;
  if (bucket === "unverified") return 5;
  return reason === "false-rationale" ? 2 : 1;
}

function describeIssue({ state, title, labels }) {
  return `${state.toLowerCase()}, titled ${JSON.stringify(title)}, labelled ${labels.length === 0 ? "nothing" : labels.join(", ")}`;
}

const ABSTAINED = "is inconclusive — its refuter abstained, so it decided nothing about the finding";

// Why `value` is not a refuter verdict, or null when it is: the shape
// VERDICT_SCHEMA declares, checked key by key. An abstaining verdict
// (`inconclusive: true`) is refused on top: the in-scope suggestion refuter
// this reads is never offered an abstain, and one that abstained anyway
// decided nothing a filing row can be keyed on.
export function verdictProblem(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "is not a JSON object";
  for (const key of VERDICT_SCHEMA.required) {
    if (!(key in value)) return `has no ${key}`;
  }
  for (const [key, v] of Object.entries(value)) {
    const declared = VERDICT_SCHEMA.properties[key];
    if (declared === undefined) return `carries ${key}, which a refuter verdict does not`;
    if (typeof v !== declared.type) return `has a ${key} that is not a ${declared.type}`;
  }
  if (value.inconclusive === true) return ABSTAINED;
  return null;
}

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
 * as a whole — every deferral that needs a human, as `escalations` of
 * `{bucket, index, severity, files}`, and every deferral whose filing could
 * not be read, as `unchecked` of `{bucket, index, issue, problem}`. Empty
 * `violations` means the record holds every rule. `record` is the parsed
 * record, or null when there is none to read (`recordProblem` then says why).
 * `touched` is touchedLines() for the review's head; `diffFiles` every file
 * name `git diff <merge-base>...<head>` lists, required only when an entry
 * defers `remedy-outside-diff`; `run` the review's run root name, or null when
 * no ledger names it — a record answers it only by carrying the same `run`;
 * `roots` the directories an absolute finding
 * or remedy path is read relative to. `filing` is `{pr, issue(n), verdict(path)}`,
 * required only when an entry defers or is an in-scope suggestion: `issue`
 * answers `{state, title, labels}` — `state` upper-case, `labels` names — or
 * `{problem}` when the tracker cannot say; `verdict` answers `{refuted}` for
 * a refuter verdict path or `{problem}` when it is no usable evidence.
 * `review` must pass reviewProblem() — a bucket missing or holding a
 * non-object is a TypeError here, not a violation.
 */
export function checkDispositions({ review, record, recordProblem = null, run = null, touched, diffFiles = null, roots = [], filing = null }) {
  const violations = [];
  const escalations = [];
  const unchecked = [];
  const at = (bucket, index, rule) => violations.push({ bucket, index, rule });
  const filingOf = () => {
    if (filing === null) throw new TypeError("checkDispositions: an entry is judged against the tracker or a verdict file and no filing was given");
    return filing;
  };

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
    if (run !== null && record.run !== run) {
      at(null, null, `the record answers run ${JSON.stringify(record.run ?? null)}, not the review's ${run}`);
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
    if (bucket === "refuted" && !e.reason?.trim()) {
      at(bucket, index, "a reversed refutation names its evidence in reason, and this one names none");
      return;
    }
    if (bucket !== "unverified" && e.disposition !== "defer") return;
    const finding = review[bucket][index];
    const presumed = presumedInScope(finding, touched, roots);
    const inScope = presumed !== null || e.scope === "in";
    const why = presumed === null ? "its entry declares scope in" : `${presumed}, so it is in scope whatever its entry declares`;
    const crashed = bucket === "unverified" && finding.refutersDispatched > 0;
    // An in-scope suggestion's refuter verdict is the evidence a refuter ran.
    let refuted = null;
    if (bucket === "unverified" && !crashed && inScope) {
      if (e.verdictPath === undefined) {
        at(bucket, index, `an in-scope suggestion carries no refuter evidence — its entry names no verdictPath; ${why}`);
        return;
      }
      const v = filingOf().verdict(e.verdictPath);
      if (v.problem !== undefined) {
        at(bucket, index, `an in-scope suggestion carries no refuter evidence — verdictPath ${JSON.stringify(e.verdictPath)} ${v.problem}`);
        return;
      }
      refuted = v.refuted;
      if (refuted && e.disposition === "apply") {
        at(bucket, index, `filing row 4 (${FILING_ROWS[4].finding}): applied, though its verdict is refuted: true — it belongs in ${homeText(FILING_ROWS[4], filing.pr)}`);
        return;
      }
    }
    if (e.disposition !== "defer") return;
    const shape = e.claimKind === "shape";
    // A finding that stands defers only for a reason: an in-scope survivor
    // for one of ALLOWED_DEFER, a suggestion its refuter let through for one
    // of row 1's — unless row 7 takes it. An out-of-scope survivor defers for
    // any reason, and escalates nothing.
    if ((bucket === "survived" && inScope) || (refuted === false && !shape)) {
      const allowed = bucket === "survived" ? ALLOWED_DEFER : ROW_1_DEFER;
      if (!allowed.includes(e.reason)) {
        const reason = e.reason === undefined || e.reason === "" ? "no reason" : `reason ${JSON.stringify(e.reason)}`;
        at(bucket, index, bucket === "survived"
          ? `an in-scope survived finding deferred with ${reason} — ${why}; it defers only for ${allowed.join(", ")}`
          : `filing row 5 (${FILING_ROWS[5].finding}): deferred with ${reason} — it is applied, or deferred as row 1, for ${allowed.join(", ")}`);
        return;
      }
      if (e.reason === REMEDY_OUTSIDE_DIFF) {
        if (diffFiles === null) throw new TypeError("checkDispositions: an entry defers remedy-outside-diff and no diffFiles was given");
        const inDiff = new Set(diffFiles);
        const named = (e.remedyFiles ?? []).map((f) => f.trim()).filter((f) => f !== "");
        const outside = named.map((f) => posix.normalize(repoPath(f, roots, inDiff))).filter((f) => !inDiff.has(f));
        if (outside.length === 0) {
          const what = named.length === 0 ? "remedyFiles names no file" : "every file remedyFiles names is in the PR's diff";
          at(bucket, index, `reason remedy-outside-diff needs a remedy file absent from the PR's diff — ${what}`);
          return;
        }
        const severity = finding.severity;
        if (severity !== "suggestion") escalations.push({ bucket, index, severity: severity ?? null, files: outside });
      }
    }
    // Where the deferral must be filed. `claimKind` is trusted, never judged.
    const rowNo = filingRow({ bucket, inScope, crashed, refuted, shape, reason: e.reason });
    if (rowNo === null) {
      at(bucket, index, `no filing-table row holds a deferred ${bucket} finding, scope ${inScope ? "in" : "out"}, claimKind ${e.claimKind} — the table names no home for it`);
      return;
    }
    const row = FILING_ROWS[rowNo];
    const { pr, issue: readIssue } = filingOf();
    if (e.issue === undefined) {
      at(bucket, index, `filing row ${rowNo} (${row.finding}): a deferral names the issue it was filed to, and this entry names none — it belongs in ${homeText(row, pr)}`);
      return;
    }
    const issue = readIssue(e.issue);
    if (issue.problem !== undefined) {
      unchecked.push({ bucket, index, issue: e.issue, problem: issue.problem });
      return;
    }
    if (!homeHolds(row, issue, pr)) {
      at(bucket, index, `filing row ${rowNo} (${row.finding}): it belongs in ${homeText(row, pr)}, and #${e.issue} is ${describeIssue(issue)}`);
    }
  });

  for (const bucket of COVERED) {
    review[bucket].forEach((_, index) => {
      if (!seen.has(`${bucket}[${index}]`)) at(bucket, index, "no entry — a finding with no entry is a dropped finding");
    });
  }
  return { violations, escalations, unchecked };
}

export function formatViolation({ bucket, index, rule }) {
  return bucket === null ? `record: ${rule}` : `${bucket}[${index}]: ${rule}`;
}

export function formatEscalation({ bucket, index, severity, files }) {
  return `${bucket}[${index}]: a ${severity ?? "severity-less"} finding deferred remedy-outside-diff, its remedy in ${files.join(", ")} — a human rules`;
}

// The row text with `token` in place of every verdict the same member wrote
// for the same review run — a re-run replaces its own earlier verdict rather
// than leaving two to disagree. Unchanged when the token is already the only
// one. Separators a removal leaves doubled are folded.
export function withVerdict(rowText, token) {
  const mine = dispositionsToken(token);
  if (mine === null) throw new Error(`withVerdict: '${token}' is not a dispositions-ok=/dispositions-mismatch=/dispositions-escalate=/dispositions-unchecked= token`);
  const words = String(rowText).trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const d = dispositionsToken(w);
    return d === null || d.member.name !== mine.member.name || d.run !== mine.run;
  });
  if (kept.length === words.length - 1 && words.includes(token)) return words.join(" ");
  const folded = kept.join(" ").replace(/·(?:\s+·)+/g, "·").replace(/^·\s*|\s*·$/g, "").trim();
  return folded === "" ? token : `${folded} · ${token}`;
}

// Whether a fix-applier on PR `pr` with a lower retry suffix than `member`
// already has a mismatch or escalate on the ledger for review `run` — on any
// row that resolves to the PR, since a row can be split. An unchecked verdict
// is no failure of a record, and a verdict on another review counts for
// nothing, so a new review starts the count again.
export function failedBefore(rows, pr, member, run) {
  const mine = member.retry ?? "";
  return rows.some((r) => rowNums(r).pr === pr && r.split(/\s+/).some((w) => {
    const d = dispositionsToken(w);
    return d !== null && (d.verdict === "mismatch" || d.verdict === "escalate") && d.member.number === pr
      && (d.member.retry ?? "") < mine && d.run === run;
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const { arg, has, sweep, stray } = defineFlags(die, {
  flags: { member: "value", scratch: "value", repo: "value", ledger: "value", "no-ledger": "bool", review: "value" },
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

// Where a deferral was filed, as checkDispositions' `filing.issue` reads it:
// `gh issue view <n> --json labels,state,title`, each number read once, run
// from `repo` so gh resolves the tracker from that repository's remotes —
// under the same scrubbed GIT_DIR and GIT_WORK_TREE as the git primitive,
// which would otherwise point gh at another repository's remotes. Anything
// short of an answer in that shape is `{problem}`: the filing goes unchecked,
// never judged.
function issueReader(repo) {
  const cache = new Map();
  const read = (n) => {
    let out;
    try {
      out = execFileSync("gh", ["issue", "view", String(n), "--json", "labels,state,title"], {
        cwd: repo, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      });
    } catch (e) {
      return { problem: e.code === "ENOENT" ? "gh is not on PATH" : e.stderr?.toString().trim() || e.message };
    }
    let j;
    try {
      j = JSON.parse(out);
    } catch (e) {
      return { problem: `gh printed no JSON — ${e.message}` };
    }
    if (typeof j?.state !== "string" || typeof j.title !== "string" || !Array.isArray(j.labels)
      || !j.labels.every((l) => typeof l?.name === "string")) {
      return { problem: "gh printed no {labels, state, title}" };
    }
    return { state: j.state.toUpperCase(), title: j.title, labels: j.labels.map((l) => l.name) };
  };
  return (n) => {
    if (!cache.has(n)) cache.set(n, read(n));
    return cache.get(n);
  };
}

// A refuter verdict, as checkDispositions' `filing.verdict` reads it: an
// absolute path to a file under `<scratch>/pr<pr>/fix-XXXXXXXX/<finding>/`,
// both sides resolved through symlinks, holding JSON in the refuter verdict
// schema. Anything else is `{problem}` — no evidence a refuter ran.
function verdictReader(scratch, pr) {
  const runs = join(scratch, `pr${pr}`);
  const notUnder = `is not under a fix-applier run root, ${runs}/fix-XXXXXXXX/<finding>/`;
  return (path) => {
    if (!isAbsolute(path)) return { problem: "is not an absolute path" };
    let file, root;
    try {
      file = realpathSync(path);
    } catch {
      return { problem: "names no file that exists" };
    }
    try {
      root = realpathSync(runs);
    } catch {
      return { problem: notUnder };
    }
    if (!/^fix-[^/]+\/[^/]+\/./.test(relative(root, file).split(sep).join("/"))) return { problem: notUnder };
    let value;
    try {
      if (!statSync(file).isFile()) return { problem: "names something that is not a file" };
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return { problem: `cannot be read as JSON — ${e.message}` };
    }
    const why = verdictProblem(value);
    if (why === null) return { refuted: value.refuted };
    // An abstention validates against the schema; it is refused as evidence, not as a malformed file.
    return { problem: why === ABSTAINED ? why : `fails the refuter verdict schema — it ${why}` };
  };
}

// The ledger file this run writes its verdict to, or null when there is none:
// `--ledger`, else the run's `.fleet/ledger.md` resolved from `repo` by
// fleet-dir.mjs's fleetFile() — the workspace every worktree of one
// repository shares, which is where `ledger.mjs dispatch` wrote the member's
// row. The path is handed to `ledger.mjs` as `--file`, so the existence probe
// and the calls that follow answer for one file. Only ENOENT means "there is
// none": any other failure to look the path up is a fault, not a standalone
// run. An absent path named by `--ledger` is announced on stderr; an absent
// default path is not.
// `lstat`, not `stat`, so a dangling symlink is a ledger that cannot be read
// rather than an absent one.
function ledgerInUse(explicit, repo) {
  let file = explicit;
  if (file == null) {
    try {
      file = fleetFile("ledger.md", { cwd: repo });
    } catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      die(e.message);
    }
  }
  try {
    lstatSync(file);
    return file;
  } catch (e) {
    if (e.code === "ENOENT") {
      if (explicit !== null) console.error(`${NAME}: no ledger at ${file} (named by --ledger) — judged with no ledger, so no token was written; pass --no-ledger to choose that`);
      return null;
    }
    die(`could not look for the ledger ${file}: ${e.message}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const usage = "usage: dispositions-check.mjs --member fix-pr-<M>[-x] --scratch <dir> [--repo <path>] [--ledger <path> | --no-ledger --review <path>]";
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
  const ledgerFile = standalone ? null : ledgerInUse(arg("ledger"), repo);

  // The review the record answers. With a ledger it is the one PR M's latest
  // `reviewed=` names — `<scratch>/pr<M>/<run>/review.json`, read off the
  // same per-PR fold `ledger.mjs dispatch` gates the finisher by, so the check
  // and the gate never judge two different reviews. Without one nothing names
  // it, so `--review` must.
  let data = null, row = null, run = null, reviewPath;
  if (ledgerFile === null) {
    reviewPath = arg("review");
    if (reviewPath === null) die(`no ledger names PR #${pr}'s review — pass --review <path> for the review file ${member.name}'s record answers`);
  } else {
    if (arg("review") !== null) die(`--review and a ledger contradict: with a ledger the review is the one PR #${pr}'s latest reviewed= names`);
    data = JSON.parse(runLedger(ledgerFile, ["read"], "read the ledger"));
    // The verdict lands on the row carrying the member on its own PR's row —
    // where `ledger.mjs dispatch` wrote it, and where the gate reads PR M's
    // tokens from.
    row = data.rows.find((r) => rowNums(r).pr === pr && memberTokens(r).some((t) => t.name === member.name));
    if (row === undefined) die(`${member.name} is on no row of PR #${pr} — \`ledger.mjs dispatch\` records a fix-applier before its record can be checked; with no controller, pass --no-ledger`);
    let latest;
    try {
      latest = deriveRun({ rows: data.rows, dispatched: data.dispatched, drain: data.drain }, []).reviewed.find((r) => r.pr === pr);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      die(`${e.message} — fleet-tick.mjs refuses this ledger, so PR #${pr}'s latest review cannot be read off it`);
    }
    if (latest === undefined) die(`PR #${pr} has no reviewed= on the ledger — no review for ${member.name}'s record to answer`);
    run = latest.run;
    reviewPath = join(scratch, `pr${pr}`, run, "review.json");
  }
  let review;
  try {
    review = readJson(reviewPath);
  } catch (e) {
    die(`could not read the review file ${reviewPath}: ${e.message}`);
  }
  const problem = reviewProblem(review);
  if (problem !== null) die(`${reviewPath} ${problem}`);
  const head = String(review.head).toLowerCase();

  // One record per fix-applier: a retry, or a fix-applier answering a later
  // review, writes its own and never replaces an earlier one's.
  const recordPath = join(scratch, `dispositions-${member.name}.json`);
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

  const { violations, escalations, unchecked } = checkDispositions({
    review, record, recordProblem, run, touched: touchedLines(diff), diffFiles, roots: [review.snapshot, top],
    filing: { pr, issue: issueReader(repo), verdict: verdictReader(scratch, pr) },
  });
  // No ledger, no row: the exit status below is the verdict, and with no
  // earlier fix-applier's verdict to count, a broken rule is always a
  // mismatch.
  // A mismatch an earlier fix-applier already drew on this review makes this
  // one the second: it is written as an escalate, which no fix-applier answers.
  // A broken rule outranks an escalation, and an escalation a filing the
  // tracker could not answer.
  const secondMismatch = violations.length > 0 && data !== null && failedBefore(data.rows, pr, member, run);
  const verdict = violations.length > 0 ? (secondMismatch ? "escalate" : "mismatch")
    : escalations.length > 0 ? "escalate" : unchecked.length > 0 ? "unchecked" : "ok";
  const token = data === null ? null : `dispositions-${verdict}=${member.name}:${run}`;

  if (data !== null) {
    const key = row.split(/\s/)[0];
    if (!/^#[0-9]+$/.test(key)) die(`the row carrying ${member.name} has no #<n> key for \`ledger.mjs row\` to rewrite it by: ${row}`);
    const text = row.slice(key.length).trim();
    const updated = withVerdict(text, token);
    if (updated === text) console.error(`    ${member.name}: row ${key} already carries ${token} — not written again`);
    else runLedger(ledgerFile, ["row", key, updated], `write ${token} onto row ${key}`);
  }

  for (const v of violations) console.error(`${member.name}: ${formatViolation(v)}`);
  for (const x of escalations) console.error(`${member.name}: ${formatEscalation(x)}`);
  for (const u of unchecked) {
    console.error(`${member.name}: ${u.bucket}[${u.index}]: where it was filed is unchecked — #${u.issue} could not be read through gh: ${u.problem}`);
  }
  if (secondMismatch) {
    console.error(`${member.name}: escalate — an earlier fix-applier's record on review ${run} already failed this check; no further fix-applier answers PR #${pr}, a human does`);
  }
  console.log(JSON.stringify({ member: member.name, pr, head, verdict, token, violations, escalations, unchecked }));
  // exitCode, not exit(): stdout to a pipe is written asynchronously, and an
  // exit() here could cut the payload off.
  process.exitCode = verdict === "ok" ? 0 : 1;
}

// Only run main() as a CLI, never when imported (see is-cli.mjs): a string
// comparison skipped main() through a symlinked path and exited 0 — the code
// that means ok — having judged and written nothing.
if (isCLI(import.meta.url)) main();
