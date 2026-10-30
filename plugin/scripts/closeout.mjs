#!/usr/bin/env node
// The end of a run as two step-running commands, `begin` and `finish`, each a
// list of named steps with a receipt, plus `reopen`, which undoes `begin`.
//
//   closeout.mjs begin  --reason "<r>"
//   closeout.mjs finish --reason "<r>" [--branch <name>]
//   closeout.mjs reopen --reason "<r>"
//
// Reached through the Resolver and run from the MAIN checkout. The middle of
// the end of a run is the ordinary loop (the tick's review, fix-applier and
// merge rows), so the end is two calls around it: `begin` starts the drain,
// `finish` closes the run once the tick says it is over.
//
// `begin` steps:
//
//   drain     `ledger.mjs drain "<reason>"`. A second drain is answered with the
//             standing marker at exit 0, so a run already draining is `ok`.
//   release   every ticket row that carries a live or `bailed` `impl-` member
//             token and no PR: `release-ticket.sh <N> impl-<N> implementer
//             --apply`, then `ledger.mjs settle <member>=released` for each of
//             its live tokens (a `bailed` token is settled already). A claim the
//             script refuses is printed `NEED hand-release #<N> <blocker>` and
//             the loop goes on to the next claim; the step is then pending.
//
// `finish` steps, in order, because the order is the point:
//
//   tick            `fleet-tick.mjs`, with the In-flight bound
//                   `.fleet/phase0.json` records, when it records one.
//                   Failed unless its last line is `ACTION: run over`.
//   scrape          `member-outcomes.mjs <dir>` for every session directory
//                   omp keeps for this cwd, each scraper's own yield line as the
//                   output. A scraper that exits non-zero fails the step: a
//                   skipped scrape loses the run's member rows for good.
//   tier-outcomes   `tier-outcomes.mjs check --live`. Its exit 1 is a failed
//                   step. At exit 0 each `WARNING PR #<n> carries reviewed=` on
//                   its stderr is a PR the ledger marks reviewed with no row:
//                   `NEED tier-outcomes append <n>`, and the step is pending.
//                   The verdicts come from `tier-outcomes.mjs append`, which
//                   works them out from the Charges; this script never writes one.
//   metrics         `metrics-refresh.mjs`. Any non-zero exit is a failed step.
//   commit-and-pr   `git switch -c <branch>` (`--branch`, default
//                   `chore/run-artifacts-<UTC date>`, suffixed `b`, `c`… while
//                   that name exists locally or on origin), commit exactly the
//                   three `docs/metrics/*.tsv` files, `git fetch origin`, `git
//                   rebase origin/main`, push `-u` with a lease, `gh pr
//                   create --label patch` with a body naming the reason and the
//                   rows each file gained and lost, `git switch main`. The
//                   rebase is three-way, so rows `main` gained during the run
//                   stay; one that conflicts or that git refuses is aborted, the
//                   branch is pushed as it was, and the PR is opened all the
//                   same, for the merge step to leave open. The lease expects
//                   origin's branch at the head the receipt last recorded as
//                   pushed, or absent before the first push, so a re-run
//                   pushes its rebased branch over the one it pushed before,
//                   and over nothing else: a branch someone else pushed to
//                   fails the step. The branch, the pushed head
//                   (the merge step's pin) and the PR once it exists are kept
//                   in the receipt: a re-run after a failed push or PR resumes
//                   on that branch and never opens a second PR.
//   phase0-receipt  moves `.fleet/phase0.json` to `.fleet/phase0.previous.json`,
//                   the name `phase0.mjs` holds a previous run's receipt under,
//                   so a run that ended here leaves no phase-0 receipt for the
//                   next run in this session to resume, and that run's rotation
//                   files it as `phase0.<UTC stamp>.json` beside the ledger
//                   archive. After the tick, which reads the bound from it, and
//                   before the stop. No `phase0.json` is nothing to move and is
//                   `ok`; a held receipt already there that is not this one is
//                   a failed step.
//   heartbeat-stop  `fleet-heartbeat.mjs --stop "<reason>"`. Every reader takes
//                   a recorded stop as the end of the run, and it comes before
//                   the merge step because a stopped beat starts no alarm
//                   turn: before the stop, every wake ends in a tick, which
//                   lists the open Close-out PR as a review to dispatch and
//                   holds the run open. A `finish` call omp has moved to the
//                   background still delivers its result as a turn of its own.
//   merge           merges the Close-out PR the step before opened. A rebase
//                   that conflicted or was refused leaves it open at once.
//                   Otherwise `inertVerdict()` (finisher-scope.mjs) at the
//                   pin; anything but `inert` leaves it open. Then, every 30 s,
//                   `gh pr view <n> --json state,headRefOid,mergeStateStatus`
//                   and `ci-state.mjs --pr <n> --declare-no-ci`: green CI, the
//                   head at the pin and `mergeStateStatus` CLEAN or HAS_HOOKS
//                   is one `gh pr merge <n> --merge --match-head-commit <pin>`,
//                   then a read that confirms MERGED: `merged PR #<n> at <sha>`.
//                   A PR already MERGED is that line too; one CLOSED is
//                   `closed: PR #<n>`. A failed check (UNSTABLE included), a
//                   head off the pin, BEHIND or DIRTY is `left open: PR #<n> —
//                   <reason>`, ok, with nothing armed or retried: the next
//                   run's phase 0 folds it in. Every other state keeps the
//                   step pending, `NEED merge-wait PR #<n>` over the last state
//                   read: CI pending, gh or CI unreadable, green CI with
//                   `mergeStateStatus` neither CLEAN nor HAS_HOOKS, or a `gh pr
//                   merge` that failed or has not landed. 30 minutes after the
//                   step first ran, that state leaves the PR open the same way:
//                   `the 30-min bound: <state>`, or `gh unreadable until the
//                   bound` / `CI unreadable until the bound`. The step stops
//                   waiting within 4 minutes of the `finish` call's start; the
//                   steps before it are not held to that. The next call resumes
//                   from the receipt without pushing, opening or merging again,
//                   and one call asks `gh pr merge` at most once. A receipt
//                   whose `mergeStarted` is not a past time, or whose `rebase`
//                   is neither null nor a reason, fails the step. The step runs
//                   gh and read-only git only, and never moves HEAD, the index
//                   or a ref. It never arms auto-merge: GitHub keeps
//                   auto-merge armed across pushes by anyone with write
//                   access, and every member pushes with the maintainer's
//                   credentials. It never passes `--delete-branch`, which also
//                   deletes the local branch and switches the checkout.
//
// `reopen` undoes `begin` for a run that must drain again: refused (exit 2)
// once any `finish` step is ok, since the tick and what follows it have already
// acted. Otherwise `begin`'s `drain` and `release` steps go back to pending, so
// the next `begin` runs them again, and then `ledger.mjs undrain "<reason>"`
// clears the marker. A claim `begin` released stays released.
//
// THE RECEIPT is `.fleet/closeout.json` (resolved through fleet-dir.mjs, so a
// worktree and the main checkout name one file), shared by all three commands:
//
//   { reason, begun, branch, pr, pin, rebase, mergeStarted, mergeOutcome,
//     steps: { <name>: { status, at, output } } }
//
// `status` is ok, pending or failed; `at` an ISO time; `output` the step's own
// words. Every step name of both commands is always present: one not yet run
// is `pending`. `begun` is the time `begin` finished its steps, ok or pending,
// null until then; `branch`, `pr`, `pin` (the head pushed) and `rebase` (null,
// or why the rebase was aborted) belong to the commit-and-pr step;
// `mergeStarted` (the merge step's first run, an ISO time) and `mergeOutcome`
// (its final line) to the merge step. A re-run skips every `ok` step and runs
// the rest, stopping at the first that is not `ok`, so the steps after it stay
// `pending`. `ledger.mjs rotate` archives the receipt beside the ledger as
// `closeout.<UTC stamp>.json`.
//
// One `closeout: <step>: <status>` line per step on stdout, its output under
// it, indented, with the `NEED` lines at the left margin. Exit 0 every step
// ok; 2 a usage error or a refused `reopen`, `ledger.mjs undrain`'s own exit 2
// included, which it also gives for a ledger it could not lock or write; 3 a
// step failed, `reopen`'s `ledger.mjs undrain` failed any other way, or the
// receipt could not be read or written; 4 a `NEED` is pending: dispatch what
// the line names, then run the same command again.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { inertVerdict } from "./finisher-scope.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { CLOSEOUT_RECEIPT, RECEIPT, RECEIPT_HELD, memberTokens, rowPr, isOmpSessionDirName } from "./ledger-grammar.mjs";
import { encodeProjectDir } from "./member-record.mjs";
import { tickCaps } from "./phase0-receipt.mjs";

const NAME = "closeout";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
export const METRICS = Object.freeze(["docs/metrics/member-outcomes.tsv", "docs/metrics/ticket-features.tsv", "docs/metrics/tier-outcomes.tsv"]);
const TICK_OVER = "ACTION: run over";

const script = (name) => join(SCRIPTS, name);

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

const trimmed = (s) => String(s ?? "").trim();

/**
 * Runs a child to completion from `cwd`. `status` is the exit status, null
 * when the child never ran or was killed (`how` says which). The environment
 * is scrubbed of GIT_DIR/GIT_WORK_TREE for every child — git itself, `gh`,
 * and the sibling scripts — so an ambient one cannot point any step at another
 * repository.
 */
function run(cmd, args, { cwd, env, timeoutMs } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(env), timeout: timeoutMs });
  return { status: r.error ? null : r.status, stdout: trimmed(r.stdout), stderr: trimmed(r.stderr), how: how(r) };
}

const node = (name, args, opts) => run(process.execPath, [script(name), ...args], opts);
const sh = (name, args, opts) => run("sh", [script(name), ...args], opts);

// What a failed child said, or how it ended when it said nothing.
const detail = (r) => [r.stdout, r.stderr].filter(Boolean).join("\n") || r.how;

const ok = (output = "") => ({ status: "ok", output });
const pending = (output) => ({ status: "pending", output });
const failed = (output) => ({ status: "failed", output });

function fatal(message) {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(3);
}

// ── the receipt ──────────────────────────────────────────────────────────────

const blank = () => ({ status: "pending", at: null, output: "" });
// The receipt's own fields, in the order it is written; each null until set.
const RECEIPT_FIELDS = ["reason", "begun", "branch", "pr", "pin", "rebase", "mergeStarted", "mergeOutcome"];

function readReceipt(path, stepNames) {
  let prior = null;
  try {
    prior = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") fatal(`cannot read receipt ${path}: ${e.message}`);
  }
  const steps = Object.fromEntries(stepNames.map((n) => [n, { ...blank(), ...prior?.steps?.[n] }]));
  return { ...Object.fromEntries(RECEIPT_FIELDS.map((k) => [k, prior?.[k] ?? null])), steps };
}

function writeReceipt(path, receipt) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    fatal(`cannot write receipt ${path}: ${e.message}`);
  }
}

// ── begin ────────────────────────────────────────────────────────────────────

function stepDrain({ cwd, reason }) {
  const r = node("ledger.mjs", ["drain", reason], { cwd });
  return r.status === 0 ? ok(r.stdout) : failed(`ledger.mjs drain failed: ${detail(r)}`);
}

// What release-ticket.sh refused for: the blockers of its JSON receipt on
// stdout, else the first line it printed.
function blocker(r) {
  try {
    const { blockers } = JSON.parse(r.stdout);
    if (Array.isArray(blockers) && blockers.length > 0) return blockers.join("; ");
  } catch {
    // Not a receipt: a refusal before it could write one, in prose.
  }
  return detail(r).split("\n")[0];
}

function stepRelease({ cwd }) {
  const read = node("ledger.mjs", ["read"], { cwd });
  if (read.status !== 0) return failed(`ledger.mjs read failed: ${detail(read)}`);
  let rows;
  try {
    rows = JSON.parse(read.stdout).rows;
  } catch (e) {
    return failed(`ledger.mjs read: unparseable answer: ${e.message}`);
  }
  if (!Array.isArray(rows)) return failed("ledger.mjs read: no rows in its answer");

  const lines = [];
  let needs = 0;
  const need = (line) => {
    needs += 1;
    lines.push(line);
  };
  for (const text of rows) {
    if (rowPr(text) !== null) continue;
    const members = memberTokens(text).filter((t) => t.family === "impl" && t.error === null && (t.outcome === null || t.outcome === "bailed"));
    if (members.length === 0) continue;
    const ticket = members[0].number;
    const release = sh("release-ticket.sh", [String(ticket), `impl-${ticket}`, "implementer", "--apply"], { cwd });
    if (release.status !== 0) {
      need(`NEED hand-release #${ticket} ${blocker(release)}`);
      continue;
    }
    lines.push(`released #${ticket}`);
    for (const t of members.filter((m) => m.outcome === null)) {
      const settle = node("ledger.mjs", ["settle", `${t.name}=released`], { cwd });
      if (settle.status !== 0) need(`NEED hand-release #${ticket} released, but ledger.mjs settle ${t.name}=released failed: ${detail(settle)}`);
    }
  }
  if (lines.length === 0) return ok("no claim to release");
  return (needs > 0 ? pending : ok)(lines.join("\n"));
}

// ── finish ───────────────────────────────────────────────────────────────────

function stepTick({ cwd, fleetDir }) {
  const caps = tickCaps(fleetDir);
  if (caps.error) return failed(caps.error);
  const r = node("fleet-tick.mjs", caps.args, { cwd });
  if (r.status !== 0) return failed(`fleet-tick.mjs failed: ${detail(r)}`);
  const last = r.stdout.split("\n").at(-1);
  if (!last.startsWith(TICK_OVER)) return failed(`the tick's last line is not \`${TICK_OVER}\`: ${last || "(no output)"}`);
  return ok(last);
}

function stepScrape({ cwd }) {
  let root;
  try {
    const home = process.env.HOME ?? homedir();
    root = join(home, ".omp", "agent", "sessions", encodeProjectDir(cwd, { home }));
  } catch (e) {
    return failed(`cannot name this cwd's omp session directory: ${e.message}`);
  }
  let sessions;
  try {
    // Directories only: the same directory holds this cwd's own top-level
    // transcripts as loose files, which are not sessions.
    sessions = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && isOmpSessionDirName(e.name)).map((e) => e.name).sort();
  } catch (e) {
    if (e.code === "ENOENT") return ok(`no session directory at ${root}`);
    return failed(`cannot read ${root}: ${e.code ?? e.message}`);
  }
  if (sessions.length === 0) return ok(`no session under ${root}`);
  const lines = [];
  for (const name of sessions) {
    const r = node("member-outcomes.mjs", [join(root, name)], { cwd });
    if (r.status !== 0) return failed([...lines, `member-outcomes.mjs ${name} failed: ${detail(r)}`].join("\n"));
    lines.push(`${name}: ${r.stderr || r.stdout}`);
  }
  return ok(lines.join("\n"));
}

function stepTierOutcomes({ cwd }) {
  const r = node("tier-outcomes.mjs", ["check", "--live"], { cwd });
  if (r.status !== 0) return failed(`tier-outcomes.mjs check --live failed: ${detail(r)}`);
  const prs = [...new Set([...r.stderr.matchAll(/WARNING PR #(\d+) carries reviewed=/g)].map((m) => m[1]))];
  if (prs.length > 0) return pending(prs.map((pr) => `NEED tier-outcomes append ${pr}`).join("\n"));
  return ok(r.stdout);
}

function stepMetrics({ cwd }) {
  const r = node("metrics-refresh.mjs", [], { cwd });
  return r.status === 0 ? ok(r.stdout) : failed(`metrics-refresh.mjs failed: ${detail(r)}`);
}

// A name for the metrics branch: `--branch` as given, else the dated default,
// lettered while the name is taken. A probe that fails to answer is no answer
// at all, never "not taken".
function pickBranch(git, given) {
  if (given !== null) return { name: given };
  const base = `chore/run-artifacts-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  for (const suffix of ["", ..."bcdefghijklmnopqrstuvwxyz"]) {
    const name = base + suffix;
    const local = git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    if (local.status !== 0 && local.status !== 1) return { error: `git show-ref refs/heads/${name} failed: ${detail(local)}` };
    const remote = git(["ls-remote", "--exit-code", "--heads", "origin", name], NETWORK_TIMEOUT_MS);
    if (remote.status !== 0 && remote.status !== 2) return { error: `git ls-remote origin ${name} failed: ${detail(remote)}` };
    if (local.status === 1 && remote.status === 2) return { name };
  }
  return { error: `every lettered ${base} name is taken` };
}

// The rows each metrics file gained and lost on the branch, one TSV line a row.
function rowCounts(git) {
  const r = git(["diff", "--numstat", "origin/main...HEAD", "--", ...METRICS]);
  if (r.status !== 0) return { error: `git diff --numstat failed: ${detail(r)}` };
  return { lines: r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")).map(([added, removed, file]) => `- ${file}: +${added} -${removed}`) };
}

// Replays the branch's commit onto the `origin/main` just fetched, three-way,
// so rows `main` gained during the run stay. A replay that stops on a
// conflict, or that git refuses to start, is aborted and the branch stays as
// it was: `{ leftOpen }` names why, and the step goes on to push and open the
// PR. `{ error }` is a fetch, or an abort, that failed.
function rebaseOntoMain(git) {
  const fetch = git(["fetch", "origin"], NETWORK_TIMEOUT_MS);
  if (fetch.status !== 0) return { error: `git fetch origin failed: ${detail(fetch)}` };
  const rebase = git(["rebase", "origin/main"]);
  if (rebase.status === 0) return { leftOpen: null };
  const unmerged = git(["diff", "--name-only", "--diff-filter=U"]);
  const stopped = git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
  if (stopped.status === 0) {
    const abort = git(["rebase", "--abort"]);
    if (abort.status !== 0) return { error: `git rebase origin/main stopped and git rebase --abort failed: ${detail(abort)}` };
  }
  // git's first line, then the paths it lists indented under it, such as the
  // untracked files a replay would overwrite.
  const [said, ...rest] = detail(rebase).split("\n");
  const named = rest.filter((l) => /^\s/.test(l)).map((l) => l.trim());
  const refused = [said, named.join(", ")].filter(Boolean).join(" ");
  if (unmerged.status !== 0) return { leftOpen: `rebase failed: ${refused}; git diff --diff-filter=U failed: ${detail(unmerged)}` };
  const files = unmerged.stdout.split("\n").filter(Boolean);
  if (files.length > 0) return { leftOpen: `rebase conflict: ${files.join(", ")}` };
  return { leftOpen: `rebase refused: ${refused}` };
}

// Everything the step does while the checkout is on the metrics branch; the
// caller switches back to main whatever this returns.
function onBranch({ git, cwd, reason, receipt, save }) {
  const dirty = git(["status", "--porcelain", "--", ...METRICS]);
  if (dirty.status !== 0) return failed(`git status failed: ${detail(dirty)}`);
  if (dirty.stdout !== "") {
    const commit = git(["commit", "-m", `Closeout: ${reason}`, "--", ...METRICS]);
    if (commit.status !== 0) return failed(`git commit failed: ${detail(commit)}`);
  }
  const rebased = rebaseOntoMain(git);
  if (rebased.error) return failed(rebased.error);
  const ahead = git(["rev-list", "--count", "origin/main..HEAD"]);
  if (ahead.status !== 0) return failed(`git rev-list --count origin/main..HEAD failed: ${detail(ahead)}`);
  if (ahead.stdout === "0") return failed(`nothing to commit: ${METRICS.join(", ")} are unchanged`);
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0) return failed(`git rev-parse HEAD failed: ${detail(head)}`);

  // The lease is the head this step last pushed, never what the fetch above
  // just read: an empty one expects the branch absent from origin.
  const lease = `--force-with-lease=refs/heads/${receipt.branch}:${receipt.pin ?? ""}`;
  const push = git(["push", "-u", lease, "origin", receipt.branch], NETWORK_TIMEOUT_MS);
  if (push.status !== 0) return failed(`git push failed: ${detail(push)}`);
  receipt.pin = head.stdout;
  receipt.rebase = rebased.leftOpen;
  save();
  const lines = [`pushed ${receipt.pin}`, ...(rebased.leftOpen === null ? [] : [rebased.leftOpen])];

  if (receipt.pr !== null) return ok([...lines, `PR ${receipt.pr} already opened for ${receipt.branch}`].join("\n"));
  const counts = rowCounts(git);
  if (counts.error) return failed(counts.error);
  const body = `Closeout: ${reason}\n\nRows changed:\n${counts.lines.join("\n")}\n`;
  const pr = run("gh", ["pr", "create", "--head", receipt.branch, "--title", `Closeout: ${reason}`, "--label", "patch", "--body", body], { cwd, env: { GH_REPO: "" }, timeoutMs: NETWORK_TIMEOUT_MS });
  if (pr.status !== 0) return failed(`gh pr create failed: ${detail(pr)}`);
  receipt.pr = pr.stdout.split("\n").at(-1);
  save();
  return ok([...lines, `PR ${receipt.pr} opened on ${receipt.branch}`].join("\n"));
}

// The work tree the command runs in, as `{ cwd }`, or `{ error }`.
function workTree() {
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  return top.status === 0 ? { cwd: top.stdout } : { error: `not inside a git work tree: ${detail(top)}` };
}

function stepCommitAndPR({ reason, branch, receipt, save }) {
  const wt = workTree();
  if (wt.error) return failed(wt.error);
  const { cwd } = wt;
  const git = (args, timeoutMs) => run("git", args, { cwd, timeoutMs });

  if (receipt.branch === null) {
    const picked = pickBranch(git, branch);
    if (picked.error) return failed(picked.error);
    const made = git(["switch", "-c", picked.name]);
    if (made.status !== 0) return failed(`git switch -c ${picked.name} failed: ${detail(made)}`);
    receipt.branch = picked.name;
    save();
  } else {
    const back = git(["switch", receipt.branch]);
    if (back.status !== 0) return failed(`git switch ${receipt.branch} failed: ${detail(back)}`);
  }
  const result = onBranch({ git, cwd, reason, receipt, save });
  const main = git(["switch", "main"]);
  if (main.status !== 0) return failed([result.status === "ok" ? null : result.output, `git switch main failed: ${detail(main)}`].filter(Boolean).join("\n"));
  return result;
}

// The receipt `phase0.mjs` resumes would otherwise outlive the run it describes.
// It is set aside under the name `phase0.mjs` holds a previous run's receipt
// under, which the next run's rotation restores and archives with the ledger.
// Linked, then unlinked, so a held receipt already there is refused rather than
// overwritten; one that is this very file, left by a crash between the two, is
// finished off.
function stepPhase0Receipt({ fleetDir }) {
  const from = join(fleetDir, RECEIPT);
  if (!existsSync(from)) return ok(`no ${RECEIPT} to move`);
  const to = join(fleetDir, RECEIPT_HELD);
  try {
    linkSync(from, to);
  } catch (e) {
    if (e.code !== "EEXIST") return failed(`cannot move ${from} to ${to}: ${e.message}`);
    const [a, b] = [statSync(from), statSync(to)];
    if (a.dev !== b.dev || a.ino !== b.ino) return failed(`${to} already holds another receipt — move it out of the way, then run finish again`);
  }
  try {
    unlinkSync(from);
  } catch (e) {
    return failed(`moved ${from} to ${to} but could not remove it: ${e.message} — remove it by hand before the next run`);
  }
  return ok(`${from} -> ${to}`);
}

function stepHeartbeatStop({ cwd, reason }) {
  const r = node("fleet-heartbeat.mjs", ["--stop", reason], { cwd });
  return r.status === 0 ? ok(r.stdout) : failed(`fleet-heartbeat.mjs --stop failed: ${detail(r)}`);
}

// One read of the PR: `{ state, headRefOid, mergeStateStatus }`, or
// `{ unreadable }` naming what gh answered instead.
function readPr(n, cwd, timeoutMs) {
  const r = run("gh", ["pr", "view", n, "--json", "state,headRefOid,mergeStateStatus"], { cwd, env: { GH_REPO: "" }, timeoutMs });
  if (r.status !== 0) return { unreadable: `gh pr view failed: ${detail(r)}` };
  let v = null;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    // Not JSON: named below with what gh printed.
  }
  if (typeof v?.state === "string" && typeof v.headRefOid === "string" && typeof v.mergeStateStatus === "string") return v;
  return { unreadable: `gh pr view answered ${r.stdout || "nothing"}` };
}

// CI as the merge gate reads it, `ci-state.mjs --pr <n> --declare-no-ci`, with
// the payload and the exit status agreeing. A not-green answer whose run has
// not completed, or that found no run on the head yet, is still pending; one
// whose run completed is a failed check.
function readCi(n, cwd, timeoutMs) {
  const r = node("ci-state.mjs", ["--pr", n, "--declare-no-ci"], { cwd, env: { GH_REPO: "" }, timeoutMs });
  let ci = null;
  try {
    ci = JSON.parse(r.stdout);
  } catch {
    // Not JSON: unreadable below.
  }
  if (ci === null || typeof ci !== "object") return { unreadable: `ci-state.mjs answered nothing readable: ${detail(r)}` };
  if (r.status === 0 && (ci.verdict === "green" || ci.verdict === "no-ci")) return { green: true, prHead: ci.prHead };
  if (r.status === 1 && ci.verdict === "not-green" && Array.isArray(ci.reasons)) {
    const why = ci.reasons.join("; ") || "not green";
    return ci.status === "completed" ? { failed: why } : { pending: why };
  }
  return { unreadable: `ci-state.mjs ${r.how}, verdict ${ci.verdict ?? "absent"}` };
}

// The merge step's clocks: it stops waiting within CALL_MS of the `finish`
// call's start, reads the PR every POLL_MS, sleeps only while READ_MS is left
// after the sleep for the reads that follow it, and stops waiting BOUND_MS
// after its first run. CLOSEOUT_CALL_MS and CLOSEOUT_POLL_MS can only shorten
// theirs.
const shorter = (name, ms) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < ms ? v : ms;
};
const CALL_MS = shorter("CLOSEOUT_CALL_MS", 4 * 60_000);
const POLL_MS = shorter("CLOSEOUT_POLL_MS", 30_000);
const READ_MS = CALL_MS / 8;
const BOUND_MS = 30 * 60_000;
const BOUND = "the 30-min bound";
const PR_NUMBER = /\/pull\/(\d+)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MERGEABLE = new Set(["CLEAN", "HAS_HOOKS"]);
// Atomics.wait never blocks on a value nothing writes, so it is a plain sleep.
const IDLE = new Int32Array(new SharedArrayBuffer(4));

function stepMerge({ receipt, save, started }) {
  const n = PR_NUMBER.exec(receipt.pr ?? "")?.[1];
  if (n === undefined) return failed(`no PR number in the receipt's pr: ${receipt.pr}`);
  const done = (line) => {
    receipt.mergeOutcome = line;
    save();
    return ok(line);
  };
  const leftOpen = (why) => done(`left open: PR #${n} — ${why}`);
  const merged = (oid) => done(`merged PR #${n} at ${oid}`);
  const { rebase } = receipt;
  if (rebase !== null && (typeof rebase !== "string" || rebase === "")) return failed(`the receipt's rebase is neither null nor a reason: ${JSON.stringify(rebase)}`);
  if (rebase !== null) return leftOpen(rebase);
  if (!FULL_SHA.test(receipt.pin ?? "")) return failed(`no pushed head in the receipt to pin the merge to: ${receipt.pin}`);
  const wt = workTree();
  if (wt.error) return failed(wt.error);
  const { cwd } = wt;
  if (receipt.mergeStarted === null) {
    receipt.mergeStarted = new Date().toISOString();
    save();
  }
  // NaN, from anything but a time string, fails the comparison too.
  const begun = typeof receipt.mergeStarted === "string" ? Date.parse(receipt.mergeStarted) : NaN;
  if (!(begun <= Date.now())) return failed(`the receipt's mergeStarted is not a past time: ${JSON.stringify(receipt.mergeStarted)}`);

  const v = inertVerdict({ worktree: cwd, pin: receipt.pin });
  if (v.verdict !== "inert") {
    const why = v.reason ?? v.paths.filter((p) => p.class === null).map((p) => `${p.path} (${p.why})`).join(", ");
    return leftOpen(`verdict ${v.verdict}: ${why}`);
  }

  const bound = begun + BOUND_MS;
  const deadline = started + CALL_MS - CALL_MS / 8;
  const budget = () => Math.min(NETWORK_TIMEOUT_MS, Math.max(1, Math.floor(deadline - Date.now())));
  // `at` is how the bound names the state if it is the last one read.
  const atBound = (last) => leftOpen(`${last.at}: ${last.why}`);
  const NOT_YET = { at: BOUND, why: "gh pr merge answered and the PR is not MERGED yet" };
  let last = { at: BOUND, why: "not read yet" };
  // What the call's one `gh pr merge` answered, kept for every later poll so a
  // failed merge's own words reach the NEED line and the bound.
  let asked = null;
  while (Date.now() < deadline) {
    const pr = readPr(n, cwd, budget());
    if (pr.unreadable) last = { at: "gh unreadable until the bound", why: pr.unreadable };
    else if (pr.state === "MERGED") return merged(pr.headRefOid);
    else if (pr.state === "CLOSED") return done(`closed: PR #${n}`);
    else if (pr.headRefOid !== receipt.pin) return leftOpen(`head moved off the pin ${receipt.pin}: ${pr.headRefOid}`);
    else if (pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "DIRTY") return leftOpen(pr.mergeStateStatus);
    else {
      const ci = readCi(n, cwd, budget());
      if (ci.failed) return leftOpen(`a check failed: ${ci.failed}`);
      if (ci.unreadable) last = { at: "CI unreadable until the bound", why: ci.unreadable };
      else if (ci.pending) last = { at: BOUND, why: `CI pending: ${ci.pending}` };
      else if (ci.prHead !== receipt.pin) return leftOpen(`head moved off the pin ${receipt.pin}: ${ci.prHead}`);
      else if (pr.mergeStateStatus === "UNSTABLE") return leftOpen("a check failed: UNSTABLE");
      else if (!MERGEABLE.has(pr.mergeStateStatus)) last = { at: BOUND, why: `CI green, mergeStateStatus ${pr.mergeStateStatus}` };
      else if (asked !== null) last = asked;
      else {
        const merge = run("gh", ["pr", "merge", n, "--merge", "--match-head-commit", receipt.pin], { cwd, env: { GH_REPO: "" }, timeoutMs: budget() });
        const after = readPr(n, cwd, budget());
        if (after.state === "MERGED") return merged(after.headRefOid);
        asked = merge.status === 0 ? NOT_YET : { at: BOUND, why: `gh pr merge failed: ${detail(merge)}` };
        last = asked;
      }
    }
    if (Date.now() >= bound) return atBound(last);
    if (Date.now() + POLL_MS + READ_MS >= deadline) break;
    Atomics.wait(IDLE, 0, 0, POLL_MS);
  }
  if (Date.now() >= bound) return atBound(last);
  return pending(`NEED merge-wait PR #${n}\n${last.why}`);
}

// ── the steps, in order ──────────────────────────────────────────────────────

const BEGIN = { drain: stepDrain, release: stepRelease };
const FINISH = {
  tick: stepTick,
  scrape: stepScrape,
  "tier-outcomes": stepTierOutcomes,
  metrics: stepMetrics,
  "commit-and-pr": stepCommitAndPR,
  "phase0-receipt": stepPhase0Receipt,
  "heartbeat-stop": stepHeartbeatStop,
  merge: stepMerge,
};
const STEP_NAMES = [...Object.keys(BEGIN), ...Object.keys(FINISH)];

const say = (line) => process.stdout.write(`${line}\n`);

// Runs `steps` in order against the receipt, skipping every `ok` one, and
// stops at the first that is not: the receipt is written after each step, and
// the exit status is the one that step earns.
function runSteps(steps, ctx, receipt, receiptPath) {
  const save = () => writeReceipt(receiptPath, receipt);
  for (const [name, step] of Object.entries(steps)) {
    if (receipt.steps[name].status !== "ok") {
      const result = step({ ...ctx, receipt, save });
      receipt.steps[name] = { status: result.status, at: new Date().toISOString(), output: result.output };
      save();
    }
    const { status, output } = receipt.steps[name];
    say(`${NAME}: ${name}: ${status}`);
    for (const line of output.split("\n").filter(Boolean)) say(line.startsWith("NEED ") ? line : `  ${line}`);
    if (status === "failed") return 3;
    if (status === "pending") return 4;
  }
  return 0;
}

// ── reopen ───────────────────────────────────────────────────────────────────

// Undoes `begin`'s drain. A finish step already ok means the tick and what
// follows it have acted, so the reopen is refused; a failed tick is not ok and
// blocks nothing. Otherwise the receipt goes back first and the marker second,
// so a run stopped between the two is left with `drain` pending and a marker
// standing, which the next `begin` re-drains ("already draining") or the next
// `reopen` clears. A ledger with no marker refuses, the receipt already back.
function reopen({ cwd, reason }, receipt, receiptPath) {
  const done = Object.keys(FINISH).filter((n) => receipt.steps[n].status === "ok");
  if (done.length > 0) {
    process.stderr.write(`${NAME}: reopen refused: finish step ${done.join(", ")} is already ok\n`);
    return 2;
  }
  if (existsSync(receiptPath)) {
    for (const n of Object.keys(BEGIN)) receipt.steps[n] = blank();
    receipt.begun = null;
    writeReceipt(receiptPath, receipt);
  }
  const undrain = node("ledger.mjs", ["undrain", reason], { cwd });
  if (undrain.status !== 0) {
    process.stderr.write(`${NAME}: ledger.mjs undrain failed: ${detail(undrain)}\n`);
    return undrain.status === 2 ? 2 : 3;
  }
  say(`${NAME}: reopen: ok`);
  for (const line of undrain.stdout.split("\n").filter(Boolean)) say(`  ${line}`);
  return 0;
}

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, { flags: { reason: "value", branch: "value" }, positionals: ["begin", "finish", "reopen"] });
  F.sweep();
  F.stray();
  const cmd = process.argv[2];
  if (cmd !== "begin" && cmd !== "finish" && cmd !== "reopen") die(`usage: ${NAME}.mjs begin --reason <reason> | finish --reason <reason> [--branch <name>] | reopen --reason <reason>`);
  const reason = F.arg("reason");
  if (reason === null) die("--reason is required");
  const branch = F.arg("branch");
  if (branch !== null && cmd !== "finish") die("--branch belongs to finish");

  let fleetDir;
  try {
    fleetDir = fleetFile(null);
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    die(e.message);
  }
  const receiptPath = join(fleetDir, CLOSEOUT_RECEIPT);
  const receipt = readReceipt(receiptPath, STEP_NAMES);
  receipt.reason = reason;
  const ctx = { cwd: process.cwd(), fleetDir, reason, branch, started: performance.timeOrigin };
  if (cmd === "reopen") {
    process.exitCode = reopen(ctx, receipt, receiptPath);
  } else if (cmd === "begin") {
    const code = runSteps(BEGIN, ctx, receipt, receiptPath);
    if (receipt.steps.drain.status === "ok" && receipt.steps.release.status !== "failed") {
      receipt.begun = new Date().toISOString();
      writeReceipt(receiptPath, receipt);
    }
    process.exitCode = code;
  } else {
    process.exitCode = runSteps(FINISH, ctx, receipt, receiptPath);
  }
}

if (isCLI(import.meta.url)) main();
