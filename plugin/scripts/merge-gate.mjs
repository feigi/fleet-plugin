#!/usr/bin/env node
// The merge bot's pre-merge gate as one read-only conjunction (#1800; spec
// docs/specs/2026-09-24-slot-based-fleet-loop-design.md § 5, ADR 0012
// Decision 3).
//
//   merge-gate.mjs --pr <n> --pre <sha> [--post <sha>] [--out <path>]
//
// Runs, in order, `instruments.sh --repo <main checkout>`, `gh pr view <n>
// --json labels,reviewDecision,headRefOid` and `ci-state.mjs --pr <n>
// --declare-no-ci`, then answers the conjunction. All three run on every
// call, whatever the earlier ones said, so the JSON line carries every field
// that was read. It never merges, labels, rebases or waits: the merge bot
// runs it once before any wait and once immediately before `gh pr merge`, and
// merges only on that second exit 0.
//
// `--pre` is the labelled head, `--post` the head the bot's own
// `gh pr update-branch --rebase` produced; omitted, it is `--pre` (the
// no-rebase path). `--out` also writes the JSON line to that path, creating
// its directory. Omitted, the line goes to stdout only: the path the merge bot
// uses, `<scratch>/pr<N>/merge-bot-<n>/ci.json`, names a scratch root and a
// member number only the bot knows, so the bot passes it and this script never
// guesses it (controller ruling on #1800).
//
// Stdout: exactly one JSON line, `{pr, verdict, reason, head, pre, post,
// behind, instruments, ci}`. Stderr: the children's own diagnostics, passed
// straight through and never folded into stdout.
//
// Exit vocabulary — the same three-way contract as inflight.sh, prove-merge.sh
// and staleness.mjs:
//
//   0  mergeable  every check holds
//   1  blocked    a verdict about this PR, now          → skip it, report
//                                                          `<reason>-#<pr>`
//   2  unknown    a finding about the tree, the tooling  → stop and report
//                 or the API — never about the PR
//
// The rows, checked in this order; the first that fails is the `reason`. A
// row whose input could not be read is skipped, and that input's own
// could-not-evaluate row fires further down instead:
//
//   label `ready-to-merge` absent            1  label-pulled
//   reviewDecision CHANGES_REQUESTED         1  changes-requested
//   PR head not in {pre, post}               1  head-moved-after-label
//   ci-state exit 1 (not-green)              1  ci:<first entry of ci.reasons>
//   ci.behind > 0                            1  behind:<n>
//   ci-state payload rate-limited/unusable   2  rate-limited / ci-unreadable
//   ci.behind === null                       2  behind-unknown
//   instruments.sh exit 1                    2  instrument-set-changed
//   instruments.sh any other failure         2  instruments-unanswerable
//   gh pr view fails or misparses            2  pr-unreadable
//
// An instrument change is 2, not 1: a changed instrument says nothing about
// the PR, and the response is stop-and-report like every other 2.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, makeArg, makeNumArg, makeSweep, makeStray, writeAll } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

const NAME = "merge-gate";

// The two instruments are this script's siblings in the install root the
// Resolver ran it from — the same resolution fleet-tick.mjs uses for
// candidates.mjs — so the gate always reads the ci-state and instrument set
// that shipped with it, never another install's.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const die = makeDie(NAME);
const arg = makeArg(die);
const numArg = makeNumArg(die);
const sweep = makeSweep(die);
const stray = makeStray(die);

const USAGE = "usage: merge-gate.mjs --pr <n> --pre <sha> [--post <sha>] [--out <path>]";

const pr = numArg("pr");
const preArg = arg("pre");
const postArg = arg("post");
const out = arg("out");
if (pr === null || preArg === null) die(USAGE);

// `--declare-no-ci` is deliberately NOT a flag here: the gate passes it to
// ci-state.mjs on every call (see readCi), so the sweep refuses it by name
// rather than letting a caller believe it changed anything.
const VALUE_FLAGS = ["pr", "pre", "post", "out"];
sweep(VALUE_FLAGS);
stray(VALUE_FLAGS);

// Full SHAs only. The head check is an exact comparison against what gh
// reports, which is always the full lowercase SHA, so an abbreviated `--pre`
// could never match and would skip a mergeable PR as `head-moved-after-label`
// — a wrong verdict about the PR where a refusal is a finding about the call.
// Case is folded rather than refused: `ABC…` names the same commit.
function sha(name, value) {
  const v = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(v)) die(`--${name} needs a full 40-character commit SHA, got ${value}`);
  return v;
}
const pre = sha("pre", preArg);
const post = postArg === null ? null : sha("post", postArg);
const heads = new Set([pre, post ?? pre]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Children's stdout is captured for parsing; their stderr goes straight to
// ours, so nothing a child says on fd 2 can reach a parse.
const CHILD = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };

// --- instruments.sh -------------------------------------------------------
// `--repo` is the directory holding the git COMMON dir — the main checkout,
// where the run's baseline `.fleet/instruments.sha` lives — never the cwd's
// own top level: from a worktree that has no baseline, and instruments.sh
// exits 2 on a missing baseline instead of comparing anything. gitEnv():
// an ambient GIT_DIR would otherwise answer `--git-common-dir` for a
// different repository, and the gate would certify that tree's instruments.
function readInstruments() {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { ...CHILD, env: gitEnv() });
  const root = common.error || common.status !== 0 ? null : workspaceDirFromGitCommonDir(common.stdout);
  if (root === null) return { exit: null, digest: null };
  const r = spawnSync("sh", [join(SCRIPT_DIR, "instruments.sh"), "--repo", root], CHILD);
  const digest = (r.stdout ?? "").trim().split("\n")[0] || null;
  if (r.error || r.signal) return { exit: null, digest };
  // An exit 0 that printed no digest compared nothing it can show, so it is
  // not taken as "unchanged". instruments.sh prints the digest on both of its
  // answering paths (0 and 1) before it exits.
  if (r.status === 0 && !/^[0-9a-f]{64}$/.test(digest ?? "")) return { exit: null, digest };
  return { exit: r.status, digest };
}

// --- gh pr view -----------------------------------------------------------
// null for anything that is not the three fields in their gh shapes: a parse
// that succeeds on the wrong shape must not reach a check that reads it.
function readPr() {
  const r = spawnSync("gh", ["pr", "view", String(pr), "--json", "labels,reviewDecision,headRefOid"], CHILD);
  if (r.error || r.status !== 0) return null;
  let v;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  if (!Array.isArray(v.labels) || !v.labels.every((l) => isObject(l) && typeof l.name === "string")) return null;
  // gh answers `""` when the repo requires no review; null is tolerated the
  // same way. Anything else is not a decision gh would give.
  if (!Object.hasOwn(v, "reviewDecision") || (v.reviewDecision !== null && typeof v.reviewDecision !== "string")) return null;
  if (typeof v.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(v.headRefOid)) return null;
  return v;
}

// --- ci-state.mjs ---------------------------------------------------------
// `--declare-no-ci` on every call, with no option on this script's surface.
// It moves exactly one arm of ci-state's gate — `no-ci` — and cannot relax
// green/not-green; a no-CI PR whose label was pulled is still refused,
// because the label row runs first. `ci.verdict: "no-ci"` in the output says
// which arm cleared.
//
// The payload decides, and the exit code has to agree with it. Node exits 1
// for a crash, a syntax error or a missing module — ci-state's own code for
// not-green — so an exit 1 with no not-green payload is not a CI verdict. An
// exit 0 whose payload is `{}` or empty is the vacuous gate the merge bot's
// hand-written `jq` checks used to pass. Both read as `ci-unreadable`.
function readCi() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "ci-state.mjs"), "--pr", String(pr), "--declare-no-ci"], CHILD);
  let payload = null;
  try {
    payload = JSON.parse(r.stdout ?? "");
  } catch {
    payload = null;
  }
  const ci = isObject(payload) ? payload : null;
  const unusable = (rateLimited = false) => ({ ci, usable: false, rateLimited });
  if (r.error || r.signal || ci === null) return unusable();
  if (r.status === 2) return unusable(ci.verdict === "rate-limited");
  const agrees =
    (r.status === 0 && (ci.verdict === "green" || ci.verdict === "no-ci")) ||
    (r.status === 1 && ci.verdict === "not-green" && Array.isArray(ci.reasons) && typeof ci.reasons[0] === "string");
  if (!agrees) return unusable();
  if (!Array.isArray(ci.reasons) || typeof ci.prHead !== "string" || ci.prHead === "") return unusable();
  // Absent is not null: null is ci-state's reading "could not count", while
  // an absent `behind` (undefined, failing the integer test) comes from a
  // payload that never carried the field.
  if (ci.behind !== null && !(Number.isInteger(ci.behind) && ci.behind >= 0)) return unusable();
  return { ci, usable: true, rateLimited: false, notGreen: r.status === 1 };
}

// --- the conjunction ------------------------------------------------------
function decide(instruments, prView, ciRead) {
  const blocked = (reason) => ({ verdict: "blocked", reason });
  const unknown = (reason) => ({ verdict: "unknown", reason });
  const { ci, usable } = ciRead;
  if (prView !== null) {
    if (!prView.labels.some((l) => l.name === "ready-to-merge")) return blocked("label-pulled");
    if (prView.reviewDecision === "CHANGES_REQUESTED") return blocked("changes-requested");
    if (!heads.has(prView.headRefOid)) return blocked("head-moved-after-label");
  }
  // ci-state reads the head a second time, a few seconds after gh pr view
  // above, and binds its run to THAT read. A push in between would have its
  // own CI judged here while the label's audit belongs to the tree before it,
  // so the same row applies to ci-state's reading too.
  if (usable && !heads.has(ci.prHead)) return blocked("head-moved-after-label");
  if (usable && ciRead.notGreen) return blocked(`ci:${ci.reasons[0]}`);
  if (usable && ci.behind > 0) return blocked(`behind:${ci.behind}`);
  if (!usable) return unknown(ciRead.rateLimited ? "rate-limited" : "ci-unreadable");
  if (ci.behind === null) return unknown("behind-unknown");
  if (instruments.exit === 1) return unknown("instrument-set-changed");
  if (instruments.exit !== 0) return unknown("instruments-unanswerable");
  if (prView === null) return unknown("pr-unreadable");
  return { verdict: "mergeable", reason: null };
}

const EXIT = { mergeable: 0, blocked: 1, unknown: 2 };

// Node exits 1 on an uncaught throw, and 1 here means "blocked" — a verdict
// about the PR. Nothing below may reach it by accident: any failure of the
// gate itself is exit 2.
try {
  const instruments = readInstruments();
  const prView = readPr();
  const ciRead = readCi();
  const { verdict, reason } = decide(instruments, prView, ciRead);
  const line = `${JSON.stringify({
    pr,
    verdict,
    reason,
    head: prView?.headRefOid ?? null,
    pre,
    post,
    behind: ciRead.usable ? ciRead.ci.behind : null,
    instruments: instruments.digest,
    ci: ciRead.ci,
  })}\n`;
  // The file first: if it cannot be written, the gate refuses (exit 2)
  // before any verdict reaches stdout, rather than printing a verdict the
  // file the caller asked for does not carry.
  if (out !== null) {
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, line);
    } catch (e) {
      die(`cannot write --out ${out}: ${e.code ?? e.message}`);
    }
  }
  // writeAll's false return is ignored for ci-state.mjs's reason: a lost
  // write must not also move the process to a different exit code.
  writeAll(1, line);
  process.exit(EXIT[verdict]);
} catch (e) {
  die(`gate failed: ${e.code ?? e.message} — could not evaluate`);
}
