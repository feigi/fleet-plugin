#!/usr/bin/env node
// The merge bot's pre-merge gate as one read-only conjunction.
//
//   merge-gate.mjs --pr <n> --pre <sha> [--post <sha>] [--out <path>]
//
// Runs, in order, `instruments.sh --repo <main checkout>`, `gh pr view <n>
// --json labels,reviewDecision,headRefOid,body`, `main-gain.mjs` against the
// PR head in the main checkout, and `ci-state.mjs --pr <n> --declare-no-ci`,
// then answers the conjunction. All four run on every call, whatever the
// earlier ones said — except main-gain.mjs, which needs the head and body gh
// read and the main checkout, and is skipped when either could not be had — so
// the JSON line carries every field that was read. A head gh reads outside
// {pre, post} adds one more read, the rebase-carry proof below, in the main
// checkout. It never merges, labels, rebases or waits: the merge bot runs it
// once before any wait and once immediately before `gh pr merge`, and merges
// only on that second exit 0.
//
// `--pre` is the labelled head, `--post` the head the bot's own
// `gh pr update-branch --rebase` produced; omitted, it is `--pre` (the
// no-rebase path). `--out` also writes the JSON line to that path, creating
// its directory. Omitted, the line goes to stdout only: the path the merge bot
// uses, `<scratch>/pr<N>/merge-bot-<n>/ci.json`, names a scratch root and a
// member number only the bot knows, so the bot passes it and this script never
// guesses it.
//
// Stdout: exactly one JSON line, `{pr, verdict, reason, head, pre, post,
// rebaseCarry, behind, instruments, mainGain, ci}`, `rebaseCarry` naming the
// labelled head and the head accepted as carrying it (`{labelled, accepted}`),
// or null when no carry was proven, `mainGain` echoing main-gain.mjs's own
// payload — hits, acknowledged removals and unchecked files — or null when
// it did not run or printed no JSON object; an unusable payload is still
// echoed. Stderr: the children's own diagnostics, passed straight through
// and never folded into stdout.
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
//   PR head not in {pre, post} and not a     1  head-moved-after-label
//     proven rebase-carry of pre
//   main-gain.mjs exit 1                     1  main-gain-removed:<first path>
//   ci-state exit 1 (not-green)              1  ci:<first entry of ci.reasons>
//   ci.behind > 0                            1  behind:<n>
//   ci-state payload rate-limited/unusable   2  rate-limited / ci-unreadable
//   ci.behind === null                       2  behind-unknown
//   instruments.sh exit 1                    2  instrument-set-changed
//   instruments.sh any other failure         2  instruments-unanswerable
//   gh pr view fails or misparses            2  pr-unreadable
//   main-gain.mjs exit 2 or unusable payload 2  main-gain-unanswerable
//
// main-gain.mjs answers which lines merging the head would remove that `main`
// gained after the PR's work began. It reads `origin/main` in the main
// checkout as it stands, so the caller fetches first. On the server-side
// rebase path the PR object can lag at the pre-rebase head for a while;
// checking that head gives the same verdict as the rebased one, because
// `git merge-tree` against `main` lands the same content either way.
//
// An instrument change is 2, not 1: a changed instrument says nothing about
// the PR, and the response is stop-and-report like every other 2.
//
// A rebase-carry is a head outside {pre, post} whose net change is the
// labelled head's: the label binds to the change it audited, not to one SHA,
// so a conflict-free rebase keeps it. Anything the proof cannot establish —
// a missing object, an unresolvable base, a git failure — is no carry, and the
// head row blocks exactly as it does for any other moved head.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

const NAME = "merge-gate";

// The two instruments are this script's siblings in the install root the
// Resolver ran it from — the same resolution fleet-tick.mjs uses for
// candidates.mjs — so the gate always reads the ci-state and instrument set
// that shipped with it, never another install's.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const die = makeDie(NAME);
const { arg, numArg, sweep, stray } = defineFlags(die, {
  flags: { pr: "value", pre: "value", post: "value", out: "value" },
});

const USAGE = "usage: merge-gate.mjs --pr <n> --pre <sha> [--post <sha>] [--out <path>]";

const pr = numArg("pr");
const preArg = arg("pre");
const postArg = arg("post");
const out = arg("out");
if (pr === null || preArg === null) die(USAGE);

// `--declare-no-ci` is deliberately NOT a flag here: the gate passes it to
// ci-state.mjs on every call (see readCi), so the sweep refuses it by name
// rather than letting a caller believe it changed anything.
sweep();
stray();

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

// --- rebase-carry proof ----------------------------------------------------
// Same net change: `git diff-tree` of each head against its own merge base
// with `origin/main`, in the main checkout, compared byte for byte after
// dropping only what a conflict-free rebase moves without changing the
// change — the line numbers and function context of each hunk header, and a
// text file's pre/post blob ids (the file around the hunks moved with
// `main`). Kept: every added, removed and context line, every mode, new-file,
// deleted-file and `\ No newline` line, symlink targets and submodule
// pointers (both are content lines), and a binary file's whole block, whose
// `index` line carries both full blob ids: its patch can be a delta against
// the other side, and two different pairs of blobs can share one delta in
// both directions. `--no-renames` turns a rename into the deletion and
// addition it is, so no similarity score decides anything.
//
// Not `git patch-id`: it drops whitespace. Measured with git 2.50.1, two
// branches adding `new` and `  new` to the same file gave one
// `patch-id --stable`, so an indentation change would read as a carry.
//
// latin1 decodes every byte to its own code unit, so two different invalid
// UTF-8 sequences can never decode to the same replacement character and
// compare equal. Read-only: cat-file, merge-base and diff-tree write no ref,
// index or worktree.
const GIT = gitEnv({ LC_ALL: "C" });

function gitRead(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "latin1", env: GIT, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 30 });
  return r.error || r.signal || r.status !== 0 ? null : r.stdout;
}

function netChange(root, head) {
  if (gitRead(root, ["cat-file", "-e", `${head}^{commit}`]) === null) return null;
  const bases = gitRead(root, ["merge-base", "--all", "origin/main", head]);
  const base = bases === null ? [] : bases.split("\n").filter(Boolean);
  if (base.length !== 1) return null;
  const diff = gitRead(root, [
    "diff-tree", "-r", "-p", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--no-color", "-U3", "--src-prefix=a/", "--dst-prefix=b/", base[0], head,
  ]);
  if (diff === null || diff === "") return null;
  // One block per file, each starting at its `diff --git` line. No content
  // line can start that way — every one carries a ` `, `+`, `-` or `\` prefix,
  // and a binary patch line has no space in it.
  const blocks = diff.split(/^(?=diff --git )/m);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.includes("GIT binary patch")) return block;
      return lines
        .map((l) => {
          const index = /^index [0-9a-f]+\.\.[0-9a-f]+((?: [0-7]+)?)$/.exec(l);
          if (index) return `index${index[1]}`;
          return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l) ? "@@" : l;
        })
        .join("\n");
    })
    .join("");
}

function proveCarry(root, prView) {
  if (root === null || prView === null || heads.has(prView.headRefOid)) return null;
  const labelled = netChange(root, pre);
  if (labelled === null) return null;
  const moved = netChange(root, prView.headRefOid);
  return moved === labelled ? { labelled: pre, accepted: prView.headRefOid } : null;
}

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
// `--repo` locates the baseline only; the baseline itself names the tree to
// audit, so a workspace that does not track `plugin/…` still reaches a
// verdict over the checkout its run pinned — no flag here repoints it.
// `root` is returned too: main-gain.mjs reads the same main checkout.
function readInstruments() {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { ...CHILD, env: gitEnv() });
  const root = common.error || common.status !== 0 ? null : workspaceDirFromGitCommonDir(common.stdout);
  if (root === null) return { exit: null, digest: null, root };
  const r = spawnSync("sh", [join(SCRIPT_DIR, "instruments.sh"), "--repo", root], CHILD);
  const digest = (r.stdout ?? "").trim().split("\n")[0] || null;
  if (r.error || r.signal) return { exit: null, digest, root };
  // An exit 0 that printed no digest compared nothing it can show, so it is
  // not taken as "unchanged". instruments.sh prints the digest on both of its
  // answering paths (0 and 1) before it exits.
  if (r.status === 0 && !/^[0-9a-f]{64}$/.test(digest ?? "")) return { exit: null, digest, root };
  return { exit: r.status, digest, root };
}

// --- gh pr view -----------------------------------------------------------
// null for anything that is not the four fields in their gh shapes: a parse
// that succeeds on the wrong shape must not reach a check that reads it.
function readPr() {
  const r = spawnSync("gh", ["pr", "view", String(pr), "--json", "labels,reviewDecision,headRefOid,body"], CHILD);
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
  // The body carries the main-gain acknowledgements. gh answers `""` for an
  // empty one, so a missing field is a read that did not happen.
  if (typeof v.body !== "string") return null;
  return v;
}

// --- main-gain.mjs --------------------------------------------------------
// Against the head gh just read, in the main checkout, with the body on
// stdin. Not run without both, and its row then stays silent:
// instruments-unanswerable or pr-unreadable names the missing input. As with
// ci-state below, the payload decides and the exit code has to agree with
// it — exit 0 with a hit, or exit 1 without one, is not a verdict. `payload`
// is whatever object the child printed, kept for the output line's echo
// (an exit 2 names what it could not read); decide() reads it only when
// `usable`.
function readMainGain(root, prView) {
  if (root === null || prView === null) return { usable: false, exit: null, payload: null };
  const r = spawnSync(
    process.execPath,
    [join(SCRIPT_DIR, "main-gain.mjs"), "--head", prView.headRefOid, "--body-file", "-"],
    // A PR that removes a large main-gained file prints every removed line:
    // past spawnSync's 1 MiB default the read fails ENOBUFS and the verdict
    // that PR earned reads as unanswerable. main-gain.mjs's own git reads
    // carry the same 1 GiB bound.
    { ...CHILD, stdio: ["pipe", "pipe", "inherit"], cwd: root, input: prView.body, maxBuffer: 1 << 30 },
  );
  if (r.error) writeAll(2, `merge-gate: main-gain.mjs could not be read: ${r.error.code ?? r.error.message}\n`);
  let v = null;
  try {
    v = JSON.parse(r.stdout ?? "");
  } catch {
    v = null;
  }
  const payload = isObject(v) ? v : null;
  const read = (usable) => ({ usable, exit: r.status, payload });
  if (r.error || r.signal || payload === null || payload.head !== prView.headRefOid) return read(false);
  if (![payload.hits, payload.acknowledged, payload.unchecked].every(Array.isArray)) return read(false);
  if (!payload.hits.every((h) => isObject(h) && typeof h.path === "string" && h.path !== "")) return read(false);
  return read((r.status === 0 && payload.hits.length === 0) || (r.status === 1 && payload.hits.length > 0));
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
// The `validated` field is null whenever `usable` is false — mirroring
// readPr()'s null-on-any-shape-violation pattern — so decide() below reads
// off `validated`, not the raw (possibly malformed) `ci` payload, for every
// check gated on usability. That makes decide()'s safety independent of
// statement ORDER: a future edit that moved the `!usable` row below
// `validated.behind === null` would crash on a null dereference instead of
// silently answering `behind-unknown` for an unreadable payload. `ci` itself
// is kept only for the output line's diagnostic echo (e.g. a rate-limited
// payload's `ci.verdict`).
function readCi() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "ci-state.mjs"), "--pr", String(pr), "--declare-no-ci"], CHILD);
  let payload = null;
  try {
    payload = JSON.parse(r.stdout ?? "");
  } catch {
    payload = null;
  }
  const ci = isObject(payload) ? payload : null;
  const unusable = (rateLimited = false) => ({ ci, validated: null, usable: false, rateLimited });
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
  return { ci, validated: ci, usable: true, rateLimited: false, notGreen: r.status === 1 };
}

// --- the conjunction ------------------------------------------------------
function decide(instruments, prView, mainGain, ciRead, rebaseCarry) {
  const blocked = (reason) => ({ verdict: "blocked", reason });
  const unknown = (reason) => ({ verdict: "unknown", reason });
  const { validated, usable } = ciRead;
  // The carried head joins the accepted set; nothing else does. A third head
  // at ci-state's read is still not one of them.
  const accepted = rebaseCarry === null ? heads : new Set([...heads, rebaseCarry.accepted]);
  if (prView !== null) {
    if (!prView.labels.some((l) => l.name === "ready-to-merge")) return blocked("label-pulled");
    if (prView.reviewDecision === "CHANGES_REQUESTED") return blocked("changes-requested");
    if (!accepted.has(prView.headRefOid)) return blocked("head-moved-after-label");
  }
  // ci-state reads the head a second time, a few seconds after gh pr view
  // above, and binds its run to THAT read. A push in between would have its
  // own CI judged here while the label's audit belongs to the tree before it,
  // so the same row applies to ci-state's reading too.
  if (usable && !accepted.has(validated.prHead)) return blocked("head-moved-after-label");
  if (mainGain.usable && mainGain.exit === 1) return blocked(`main-gain-removed:${mainGain.payload.hits[0].path}`);
  if (usable && ciRead.notGreen) return blocked(`ci:${validated.reasons[0]}`);
  if (usable && validated.behind > 0) return blocked(`behind:${validated.behind}`);
  if (!usable) return unknown(ciRead.rateLimited ? "rate-limited" : "ci-unreadable");
  if (validated.behind === null) return unknown("behind-unknown");
  if (instruments.exit === 1) return unknown("instrument-set-changed");
  if (instruments.exit !== 0) return unknown("instruments-unanswerable");
  if (prView === null) return unknown("pr-unreadable");
  if (!mainGain.usable) return unknown("main-gain-unanswerable");
  return { verdict: "mergeable", reason: null };
}

const EXIT = { mergeable: 0, blocked: 1, unknown: 2 };

// Node exits 1 on an uncaught throw, and 1 here means "blocked" — a verdict
// about the PR. Nothing below may reach it by accident: any failure of the
// gate itself is exit 2.
try {
  const instruments = readInstruments();
  const prView = readPr();
  const mainGain = readMainGain(instruments.root, prView);
  const rebaseCarry = proveCarry(instruments.root, prView);
  const ciRead = readCi();
  const { verdict, reason } = decide(instruments, prView, mainGain, ciRead, rebaseCarry);
  const line = `${JSON.stringify({
    pr,
    verdict,
    reason,
    head: prView?.headRefOid ?? null,
    pre,
    post,
    rebaseCarry,
    behind: ciRead.usable ? ciRead.ci.behind : null,
    instruments: instruments.digest,
    mainGain: mainGain.payload,
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
