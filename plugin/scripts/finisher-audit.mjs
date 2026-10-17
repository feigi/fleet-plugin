#!/usr/bin/env node
// The finisher's worktree audit (duty 1) as one command, so the row lookup, the
// dirty check, the head-equality check and the reflog cause derivation cannot be
// run, or skipped, one at a time:
//
//   finisher-audit.mjs --worktree <abs> --pin <sha> [--sample-seconds <n>] [--repo <dir>]
//
// `--worktree` is the absolute path the finisher was dispatched with, spelled
// however it was reached: it is matched by its realpath. `--pin` is the full
// 40-hex head the finisher was dispatched against. `--repo` is the directory
// `worktree-audit.sh` runs in (it audits the worktrees of whichever repository
// it stands in); the cwd when omitted. `--sample-seconds` is the gap between the
// two `git diff --stat` samples of a dirty tree, 60 when omitted. Reached
// through the Resolver: `~/.fleet/bin/fleet-run finisher-audit.mjs ...`.
//
// Stdout is always one JSON line, the verdict:
//
//   {worktree, realpath, pin, head, cause, evidence}
//
// worktree  the path as given
// realpath  its physical path, the form the audit's row names it by
// pin       the pin, lowercased
// head      `git -C <worktree> rev-parse HEAD`, null when it was never read
// cause     null, or the word the ledger's `halted:<cause>` takes: live-editor,
//           rebase, past-pin, unreadable, missing, absent or other
// evidence  one entry per step that ran, each holding what that step read
//
// Exit vocabulary:
//
//   0  the worktree is clean at the pin: `cause` is null and nothing else is
//   1  a halt cause: `cause` names it and `evidence` holds what it was derived from
//   2  it could not look - the invocation or a read failed, `evidence.error`
//      says which and the same line is on stderr. `cause` is null in that
//      verdict and means nothing: only exit 0 is clean.
//
// Derivation, in this order, each step's output in `evidence`. A step runs only
// if every earlier one answered "no cause".
//
// 1 The row. `worktree-audit.sh` takes no argument and audits every worktree,
//   so the row is found by `realpath(--worktree)` against the row's `worktree`,
//   which is the physical path `git worktree list` reports - never by the path
//   as written, so a spelling reached through a symlink (macOS's `/tmp` and
//   `/var/folders` are symlinks too) still finds a healthy worktree's row.
//     - no row at all: `absent`.
//     - `readable:false` with null counts: `unreadable`, the script's own
//       `UNREADABLE: <wt> (<cause>)` stderr line quoted in `evidence.audit`.
//     - `readable:false` with zero counts: `missing`, its `MISSING on disk:
//       <wt>` line quoted the same way.
//   `git status` is no substitute for the row on the first two: in a worktree
//   whose `.git` linkage is missing it answers for the enclosing repository, at
//   rc 0.
//
// 2 Dirty. The row's `dirty` count, cross-checked with `git -C <wt> status
//   --porcelain -unormal` - the explicit mode, never bare `--porcelain`, or
//   `status.showUntrackedFiles = no` reads a dirty tree as clean. Either one
//   reporting dirt is dirt. Then `git diff --stat` is sampled twice,
//   `--sample-seconds` apart, and the cause is `live-editor` with both samples
//   in the evidence: a diffstat that grew between them is someone still writing.
//   Every dirty tree halts, grown or not - a finisher that verifies the dirt is
//   harmless and labels anyway has replaced the rule with its purpose.
//
// 3 Head-equality. `git -C <wt> rev-parse HEAD` equal to the pin on a clean tree
//   settles it: `cause` null, exit 0. It is against the dispatch pin, never
//   against the PR's `headRefOid`: a member that kept working and pushed after
//   the pin matches the branch tip on a clean tree, so a `headRefOid` comparison
//   would report "settled" over commits no reviewer read. And no reflog entry
//   is read at all on this path - a rebase sitting at or behind the pin is that
//   head's provenance (the implementer's own pre-push replay), not divergence
//   from it.
//
// 4 Only when the head differs from the pin: `git -C <wt> reflog -n 20`, and the
//   newest entry is the move that put HEAD where it is.
//     - a `reset` or `rebase` entry: `rebase`. The branch replayed onto a new
//       base - its own commits on a new parent, content-identical only on a
//       conflict-free replay. Evidence: `replay`, the verdict of `git range-diff
//       --no-patch origin/main <pin> HEAD` run in the worktree; `rangeDiff`, that
//       output (or the error that stopped it); and `remote`, read as `past-pin`
//       reads it. `pure` only when every pinned commit pairs with an unchanged
//       one. A dropped, edited or added commit, or a stale `origin/main`, is
//       `changed`; a listing that cannot be read is `unknown`. `range-diff`
//       lists non-merge commits only, so a merge commit in either range is
//       `changed` as well: its own content - an evil merge, a conflict resolved
//       inside it - would otherwise leave no line. Not `git cherry`: it lists
//       only the head-side commits, reads a whitespace-only edit as unchanged,
//       and reads a conflict resolved to main's side as nothing at all.
//       `range-diff` pairs both sides of the replay, so each of those is an
//       unpaired line.
//     - a plain `commit` entry: `past-pin`. A member kept working after the
//       dispatch. Evidence: `git log -1 --format='%h %s'` and whether that
//       commit is pushed, unpushed or unknown, read from `git ls-remote origin
//       refs/heads/<branch>` - the branch being the row's, and the full ref
//       name so a branch named like the tail of another ref matches only
//       itself. Only a successful read settles pushed against unpushed: the
//       remote's value equal to HEAD is `pushed`, anything else from a read
//       that succeeded is `unpushed`, the commit existing only in that
//       worktree where no reviewer can reach it. A failed read - a non-zero
//       exit, a timeout, a detached HEAD with no branch to ask about - is
//       `unknown`, never `unpushed`, the same rule `release-ticket.sh`'s own
//       `ls-remote` states. The remote is asked rather than the PR object,
//       whose head lags a ref move.
//     - anything else, an empty reflog included: `other`. Evidence: both status
//       reads (the step-2 read and one after the reflog), the reflog line at
//       the move, and both SHAs. A cause nobody has named yet is still a cause
//       observed, and the report is what gets it named.
//
// Every cause halts, always - named or not. A rebase is not a fast-forward the
// finisher gets to accept, a commit past the pin is not one either, and a cause
// that could not be named is the least settled of the lot.
//
// A usage refusal (a missing, unknown or malformed flag) is a one-line refusal
// on stderr with no verdict, exit 2, as in every other script's `die()`.

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";

const NAME = "finisher-audit";
const die = makeDie(NAME);
const { arg, numArg, sweep, stray } = defineFlags(die, {
  flags: { worktree: "value", pin: "value", "sample-seconds": "value", repo: "value" },
});
const USAGE = "usage: finisher-audit.mjs --worktree <abs> --pin <sha> [--sample-seconds <n>] [--repo <dir>]";
// The sweep runs before the required-flag check so a misspelled flag is named
// as that, not buried under a missing-flag usage line.
sweep();
stray();

const AUDIT = join(dirname(fileURLToPath(import.meta.url)), "worktree-audit.sh");
const DEFAULT_SAMPLE_SECONDS = 60;
// A read of the remote that has not answered by now is an unknown answer, not a
// reason to hold the finisher's halt report.
const LS_REMOTE_TIMEOUT_MS = 30_000;
// One audit row per worktree, each carrying its dirty files: far past
// spawnSync's 1 MiB default on a repository with many dirty worktrees.
const AUDIT_BUFFER = 256 * 1024 * 1024;
const REFLOG_LIMIT = "20";
// Atomics.wait never blocks on a value nothing writes, so it is a plain sleep.
const IDLE = new Int32Array(new SharedArrayBuffer(4));

const worktree = arg("worktree");
const pinArg = arg("pin");
const sampleSeconds = numArg("sample-seconds");
const repoArg = arg("repo");
if (worktree === null || pinArg === null) die(USAGE);
if (!worktree.startsWith("/")) die(`--worktree needs an absolute path, got ${worktree}`);
// Full SHAs only, lowercased: a shorter pin could not be compared to HEAD, and
// case is folded rather than refused, as finisher-label.mjs does.
const pin = pinArg.toLowerCase();
if (!/^[0-9a-f]{40}$/.test(pin)) die(`--pin needs a full 40-character commit SHA, got ${pinArg}`);
// A missing directory makes spawn report ENOENT for the binary itself, which
// would blame git or sh for a bad --repo. A stat that throws (EACCES on an
// ancestor) is the same refusal, not a crash with no verdict.
if (repoArg !== null) {
  let isDir = false;
  try {
    isDir = statSync(repoArg, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (e) {
    die(`--repo cannot be read: ${repoArg} (${e.code ?? e.message})`);
  }
  if (!isDir) die(`--repo is not a directory: ${repoArg}`);
}
const repo = repoArg === null ? process.cwd() : resolve(repoArg);

// The physical form of a path, for a path that may no longer exist: the deepest
// ancestor that resolves is made physical and the rest is appended as written,
// which is how `git worktree list` names a worktree whose directory is gone
// under a symlinked ancestor.
function physical(path) {
  const tail = [];
  let here = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(here), ...tail.reverse());
    } catch {
      const up = dirname(here);
      if (up === here) return resolve(path);
      tail.push(basename(here));
      here = up;
    }
  }
}

const realpath = physical(worktree);
const GIT_ENV = gitEnv({ GIT_TERMINAL_PROMPT: "0" });
const verdict = { worktree, realpath, pin, head: null, cause: null, evidence: {} };
const evidence = verdict.evidence;

function finish(exit, cause = null) {
  verdict.cause = cause;
  writeAll(1, `${JSON.stringify(verdict)}\n`);
  process.exit(exit);
}

// The finisher could not look: the verdict carries what failed and the exit is
// 2, so a read that failed is never taken for a read that found nothing.
function fail(error) {
  evidence.error = error;
  writeAll(2, `\n${NAME}: ${error}\n`);
  finish(2);
}

const halt = (cause) => finish(1, cause);

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", env: GIT_ENV, maxBuffer: AUDIT_BUFFER, ...options });
}

// A git call inside the worktree. A call that could not run, was killed or
// exited non-zero stops the audit at exit 2 unless the caller asked to read the
// failure itself (`soft`).
function git(step, args, { soft = false, timeout } = {}) {
  const r = run("git", ["-C", realpath, ...args], timeout === undefined ? {} : { timeout });
  if (r.error || r.signal || r.status !== 0) {
    if (soft) return { ok: false, out: "", error: (r.error?.message ?? r.stderr ?? "").trim() || `exit ${r.status ?? r.signal}` };
    const why = r.error?.message ?? (r.signal ? `killed by ${r.signal}` : (r.stderr ?? "").trim() || `exit ${r.status}`);
    fail(`${step}: git ${args.join(" ")} failed: ${why}`);
  }
  return { ok: true, out: r.stdout, error: null };
}

// The remote ref of `branch`, the row's, against `head`. Only a successful read
// settles pushed against unpushed; a failed read, a timeout, or a detached HEAD
// is `unknown`.
function remoteState(branch, head) {
  if (typeof branch !== "string" || branch === "" || branch === "DETACHED") {
    return { state: "unknown", error: "detached HEAD: no branch to ask the remote about" };
  }
  const ref = `refs/heads/${branch}`;
  const r = git("ls-remote", ["ls-remote", "origin", ref], { soft: true, timeout: LS_REMOTE_TIMEOUT_MS });
  if (!r.ok) return { state: "unknown", ref, error: r.error };
  const line = r.out.split("\n").find((l) => l.split("\t")[1] === ref);
  const sha = line === undefined ? null : line.split("\t")[0];
  return { state: sha === head ? "pushed" : "unpushed", ref, sha };
}

// `git range-diff` prints one line per pairing, `<n>:  <sha> <marker> <m>:  <sha>
// <subject>`, with `-:` on the side a commit is missing from, and nothing after
// the second sha for a commit whose subject is empty. The replay is pure only
// when every line is a pairing marked `=`; an empty listing pairs nothing and
// is not pure. A merge commit never gets a line, so `merges`, the count of
// them in either range, above zero is not pure either.
const RANGE_PAIR = /^\s*\S+:\s+\S+\s+([=!<>])\s+\S+:\s+\S+(?:\s|$)/;
function replayVerdict(rangeDiff, merges) {
  if (!rangeDiff.ok) return "unknown";
  const lines = rangeDiff.out.split("\n").filter((l) => l.trim() !== "");
  return merges === 0 && lines.length > 0 && lines.every((l) => RANGE_PAIR.exec(l)?.[1] === "=") ? "pure" : "changed";
}

// --- 1: the row --------------------------------------------------------------
const audit = run("sh", [AUDIT], { cwd: repo });
if (audit.error || audit.signal || audit.status !== 0) {
  fail(`worktree-audit.sh failed: ${audit.error?.message ?? (audit.signal ? `killed by ${audit.signal}` : (audit.stderr ?? "").trim() || `exit ${audit.status}`)}`);
}
let rows;
try {
  rows = JSON.parse(audit.stdout);
} catch {
  fail(`worktree-audit.sh printed no JSON: ${audit.stdout.slice(0, 200)}`);
}
if (!Array.isArray(rows)) fail(`worktree-audit.sh printed an unexpected shape: ${audit.stdout.slice(0, 200)}`);

const row = rows.find((r) => r !== null && typeof r === "object" && typeof r.worktree === "string" && physical(r.worktree) === realpath);
// The audit's own stderr line for a row, quoted where it printed one.
const quote = (prefix) => audit.stderr.split("\n").find((l) => l.trimStart().startsWith(prefix)) ?? null;
if (!row) {
  evidence.audit = { row: null, rows: rows.map((r) => r?.worktree ?? null) };
  halt("absent");
}
if (row.readable !== true) {
  const unreadable = row.ahead === null || row.dirty === null;
  evidence.audit = { row, stderr: quote(unreadable ? `UNREADABLE: ${row.worktree} (` : `MISSING on disk: ${row.worktree}`)?.trim() ?? null };
  halt(unreadable ? "unreadable" : "missing");
}
evidence.audit = { row };

// --- 2: dirty ----------------------------------------------------------------
const status = () => git("status", ["status", "--porcelain", "-unormal"]).out;
const statusFirst = status();
evidence.status = [statusFirst];
if (row.dirty > 0 || statusFirst.trim() !== "") {
  const stat = () => git("sample", ["diff", "--stat"]).out;
  const first = stat();
  Atomics.wait(IDLE, 0, 0, (sampleSeconds ?? DEFAULT_SAMPLE_SECONDS) * 1000);
  const second = stat();
  evidence.samples = [first, second];
  halt("live-editor");
}

// --- 3: head-equality ----------------------------------------------------------
const head = git("head", ["rev-parse", "HEAD"]).out.trim();
verdict.head = head;
if (head === pin) finish(0);

// --- 4: the reflog -------------------------------------------------------------
// `--no-decorate --no-color`: a user's `log.decorate` or `color.ui` config would
// otherwise put `(HEAD -> branch)` or an escape ahead of the subject, and the
// subject match below would read every move as `other`.
const reflog = git("reflog", ["reflog", "--no-decorate", "--no-color", "-n", REFLOG_LIMIT]).out;
const move = reflog.split("\n").find((l) => l.trim() !== "") ?? null;
// `<abbrev> HEAD@{0}: <subject>`: the subject is what names the operation.
const subject = move === null ? "" : (/^\S+ [^\s:]*@\{\d+\}: (.*)$/.exec(move)?.[1] ?? "");
evidence.reflog = move;

if (/^(reset|rebase)\b/.test(subject)) {
  const rangeDiff = git("range-diff", ["range-diff", "--no-color", "--no-patch", "--creation-factor=60", "origin/main", pin, "HEAD"], { soft: true });
  const merges = rangeDiff.ok ? Number(git("merges", ["rev-list", "--merges", "--count", "^origin/main", pin, "HEAD"]).out.trim()) : 0;
  evidence.replay = replayVerdict(rangeDiff, merges);
  evidence.rangeDiff = rangeDiff.ok ? rangeDiff.out : { error: rangeDiff.error };
  evidence.remote = remoteState(row.branch, head);
  halt("rebase");
}

if (/^commit\b/.test(subject)) {
  evidence.commit = git("log", ["log", "-1", "--format=%h %s"]).out.trim();
  evidence.remote = remoteState(row.branch, head);
  halt("past-pin");
}

evidence.status.push(status());
evidence.shas = { pin, head };
halt("other");
