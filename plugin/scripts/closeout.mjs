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
//                   three `docs/metrics/*.tsv` files, push `-u`, `gh pr create
//                   --label patch` with a body naming the reason and the rows
//                   each file gained and lost, `git switch main`. The branch, and
//                   the PR once it exists, are kept in the receipt: a re-run
//                   after a failed push or PR resumes on that branch and never
//                   opens a second PR.
//   phase0-receipt  moves `.fleet/phase0.json` to `.fleet/phase0.previous.json`,
//                   the name `phase0.mjs` holds a previous run's receipt under,
//                   so a run that ended here leaves no phase-0 receipt for the
//                   next run in this session to resume, and that run's rotation
//                   files it as `phase0.<UTC stamp>.json` beside the ledger
//                   archive. After the tick, which reads the bound from it, and
//                   before the stop. No `phase0.json` is nothing to move and is
//                   `ok`; a held receipt already there that is not this one is
//                   a failed step.
//   heartbeat-stop  `fleet-heartbeat.mjs --stop "<reason>"`, last, because
//                   every reader takes a recorded stop as the end of the run.
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
//   { reason, begun, branch, pr, steps: { <name>: { status, at, output } } }
//
// `status` is ok, pending or failed; `at` an ISO time; `output` the step's own
// words. Every step name of both commands is always present: one not yet run
// is `pending`. `begun` is the time `begin` finished its steps, ok or pending,
// null until then; `branch` and `pr` belong to the commit-and-pr step. A re-run
// skips every `ok` step and runs the rest, stopping at the first that is not
// `ok`, so the steps after it stay `pending`. `ledger.mjs rotate` archives the
// receipt beside the ledger as `closeout.<UTC stamp>.json`.
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
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { CLOSEOUT_RECEIPT, RECEIPT, RECEIPT_HELD, memberTokens, rowPr } from "./ledger-grammar.mjs";
import { encodeProjectDir, isOmpSessionDirName } from "./member-record.mjs";
import { tickCaps } from "./phase0-receipt.mjs";

const NAME = "closeout";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
export const METRICS = ["docs/metrics/member-outcomes.tsv", "docs/metrics/ticket-features.tsv", "docs/metrics/tier-outcomes.tsv"];
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

function readReceipt(path, stepNames) {
  let prior = null;
  try {
    prior = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") fatal(`cannot read receipt ${path}: ${e.message}`);
  }
  const steps = Object.fromEntries(stepNames.map((n) => [n, { ...blank(), ...prior?.steps?.[n] }]));
  return { reason: prior?.reason ?? null, begun: prior?.begun ?? null, branch: prior?.branch ?? null, pr: prior?.pr ?? null, steps };
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

// Everything the step does while the checkout is on the metrics branch; the
// caller switches back to main whatever this returns.
function onBranch({ git, cwd, reason, receipt, save }) {
  const dirty = git(["status", "--porcelain", "--", ...METRICS]);
  if (dirty.status !== 0) return failed(`git status failed: ${detail(dirty)}`);
  if (dirty.stdout !== "") {
    const commit = git(["commit", "-m", `Closeout: ${reason}`, "--", ...METRICS]);
    if (commit.status !== 0) return failed(`git commit failed: ${detail(commit)}`);
  }
  const ahead = git(["rev-list", "--count", "origin/main..HEAD"]);
  if (ahead.status !== 0) return failed(`git rev-list --count origin/main..HEAD failed: ${detail(ahead)}`);
  if (ahead.stdout === "0") return failed(`nothing to commit: ${METRICS.join(", ")} are unchanged`);

  const push = git(["push", "-u", "origin", receipt.branch], NETWORK_TIMEOUT_MS);
  if (push.status !== 0) return failed(`git push failed: ${detail(push)}`);

  if (receipt.pr !== null) return ok(`PR ${receipt.pr} already opened for ${receipt.branch}`);
  const counts = rowCounts(git);
  if (counts.error) return failed(counts.error);
  const body = `Closeout: ${reason}\n\nRows changed:\n${counts.lines.join("\n")}\n`;
  const pr = run("gh", ["pr", "create", "--head", receipt.branch, "--title", `Closeout: ${reason}`, "--label", "patch", "--body", body], { cwd, env: { GH_REPO: "" }, timeoutMs: NETWORK_TIMEOUT_MS });
  if (pr.status !== 0) return failed(`gh pr create failed: ${detail(pr)}`);
  receipt.pr = pr.stdout.split("\n").at(-1);
  save();
  return ok(`PR ${receipt.pr} opened on ${receipt.branch}`);
}

function stepCommitAndPR({ reason, branch, receipt, save }) {
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (top.status !== 0) return failed(`not inside a git work tree: ${detail(top)}`);
  const cwd = top.stdout;
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
  const ctx = { cwd: process.cwd(), fleetDir, reason, branch };
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
