#!/usr/bin/env node
// Phase 0 as one command: the run's start sequence, in order, with a receipt.
//
//   phase0.mjs [--session <dir>] [--in-flight n] [--objective cost|speed]
//              [--plugin-checkout <dir>] [--spend-dir <dir>]
//              [--workflow <name> | --declare-no-ci]
//
// The session directory is `--session`, else `PI_ARTIFACTS_DIR`, which omp
// exports to its Python eval kernel and the processes that kernel starts (the
// bash tool's environment does not carry it); with neither, exit 2. It is
// accepted when `<dir>.jsonl` exists beside it and the path is a directory or
// does not exist yet — omp creates the directory when the session's first
// subagent writes there. An existing directory with no `<dir>.jsonl` beside
// it names no session (the directory holding every session of a checkout is
// one): from either source it exits 2 naming the path, writing no receipt.
//
// Reached through the Resolver and run from the MAIN checkout (a linked
// worktree refuses: the checks below judge the checkout the controller reads
// its rules from). The steps, each a named entry in the receipt, run in
// this order because the order is the point — the pin certifies the tree the
// fast-forward left, the rotation comes before the fold-in, the scratch
// reclaim straight after the rotation, the metrics refresh before the first
// Pull is routed:
//
//   alarm         `~/.fleet/alarm/<pid>.json` names this omp's pid and start time
//                 and this `.fleet/`. Missing, malformed or mismatched, or no omp
//                 above the script, refuses: restart omp.
//   branch        `git symbolic-ref -q HEAD` is refs/heads/main. A checkout left
//                 on a branch whose PR has merged would fast-forward that branch
//                 and the baseline would record it as the run's ref.
//   fast-forward  `git fetch origin`, `rev-list --count main..origin/main`,
//                 `merge --ff-only origin/main`. HEAD moving means the rules this
//                 script came from are superseded: prints `SUPERSEDED <n>
//                 commits; re-run phase0.mjs` and fails, so the re-run executes
//                 from the new tree.
//   pin           `instruments.sh --pin`, with `--audit <plugin-checkout>` when
//                 given (a workspace that tracks no `plugin/…` of its own).
//   baseline      `main-checkout.mjs --record`; its refusals fail the step.
//   preflight     `preflight.mjs`. A non-zero exit fails the step; the FAIL, WARN
//                 and PREFLIGHT lines of an exit 1 are printed.
//   ruleset       `.github/scripts/apply-ruleset.sh --check`, when the workspace
//                 checks a ruleset spec in. Exit 3 is `drift` (the diff is the
//                 output), exit 2 or anything else `unanswered`; neither stops
//                 the run — reconciling is a write to the gate and the
//                 maintainer's.
//   tier-roles    `tier-roles.mjs --check --in-flight <B>`. <B> is `--in-flight`
//                 when given, else the In-flight bound's default
//                 (IN_FLIGHT_DEFAULT in phase0-receipt.mjs). A notice
//                 tier-roles prints on a pass is part of
//                 the step's output.
//   metrics       `metrics-refresh.mjs`. A non-zero exit fails the step.
//   cockpit       `board.mjs serve --open` launched detached, `--spend-dir`
//                 passed through. Recorded; never fails the run.
//   rotate        `ledger.mjs rotate`. Exit 2 is a refusal and fails the step.
//   reclaim       `reclaim-scratch.mjs --root <scratch> --after-rotate --apply`,
//                 then `reclaim-scratch.mjs --siblings --root <scratch> --apply`
//                 for the other keys under the scratch parent, which runs
//                 whatever the first answered. What either receipt's failed[]
//                 names is listed. Recorded; never fails the run.
//   recipe        `derive-testcmd.sh . install` and `. test --at origin/main`.
//                 Either exiting 1 is a cache with nothing valid in it: pending,
//                 `NEED derive-recipe`. Exit 3 (a tool the reader could not run)
//                 fails the step — deriving would not help.
//   fold-in       every open PR no carried ledger row names: one that closes an
//                 issue gets a `#<pr>` row from `ledger.mjs row` (the tick queues
//                 its review off it); one that closes none is listed as `NEED
//                 review PR#<pr> (closes no issue)`.
//   stranded      `stranded.mjs`. A `resume` entry whose ticket has no ledger row
//                 yet is pending: `NEED resume #<n> <worktree> <branch>`. A
//                 `report` entry is printed. Resuming a claim writes its row, so
//                 a re-run after the dispatch finds the need met.
//   shortlist     `shortlist.mjs`. A non-zero exit fails the step.
//
// THE RECEIPT is `.fleet/phase0.json` (resolved through fleet-dir.mjs, so a
// worktree and the main checkout name one file):
//
//   { run, session, scratch, inFlight, objective,
//     steps: { <name>: { status, at, output } } }
//
// `status` is ok, pending, failed, drift or unanswered; `at` an ISO time;
// `output` the step's own words — the refusal for a failure, the NEED lines for
// a pending step. Every step name is always present: one not yet run is
// `pending`. `run` is the `at` that `ledger.mjs rotate` wrote into the
// controller record in `.fleet/heartbeat.json`, null until the rotation has
// run. `session` is the session directory, from `--session` or
// `PI_ARTIFACTS_DIR`. `scratch` is what `scratch-root.mjs` prints. `inFlight`
// is the In-flight bound this run used — `--in-flight`, or its default.
// `objective` is the Objective the router routes this run's Pulls by:
// `--objective`, or its default (OBJECTIVE_DEFAULT in phase0-receipt.mjs).
// It is fixed for the run: a resumed receipt keeps the one it records — the
// default when it records none — and a resume whose `--objective` names the
// other one exits 2 naming both, leaving the receipt as it was. A resumed
// receipt recording a value that is not an Objective exits 3 naming it.
//
// RESUMABLE. A re-run reads the receipt. It continues it — skipping every `ok`
// step but `alarm` and re-running the rest — only when its `run` equals the
// `at` the controller record holds now AND its `session` equals this run's
// session. That comparison alone does not separate two runs before the new
// run's rotation: the record still carries the previous run's `at` until
// `ledger.mjs rotate` writes the next, so the previous run's receipt still
// matches it, and a re-run that trusted `run` alone would skip `rotate`. The
// session rule closes a new session. `alarm` is re-run on every invocation,
// `ok` or not: it proves something about the omp running this invocation, and
// a resumed receipt may have been written under another. A receipt of any
// other run (a `run` that is set and does not match, or a different session)
// is held as `phase0.previous.json`, where `closeout.mjs finish` also leaves a
// finished run's receipt, and the script starts at `alarm`; this run's own
// receipt is written at `phase0.json` after every step. A receipt whose
// rotation has not run is simply overwritten: every step before `rotate` is
// idempotent and is re-run on every invocation until the rotation has run.
//
// THE ROTATION FILES THE PREVIOUS RUN'S RECEIPT. The `rotate` step takes this
// run's partial receipt off disk, puts the held one back at `phase0.json` and
// runs `ledger.mjs rotate`, which archives it as `phase0.<UTC stamp>.json`
// beside `ledger.<UTC stamp>.md`, one stamp for both. A rotation that refused
// leaves it held for the next attempt; one that archived the ledger and not
// the receipt files it under a stamp of this script's own. A rotation that
// writes no controller record (the ledger finds no omp above itself) leaves
// `run` null; a receipt whose `rotate` step is `ok` is then resumed on the
// session alone.
//
// A step that fails stops the script; so does a pending one — nothing after
// the recipe may run before it is proven, and the shortlist waits for the
// stranded claims. The steps after it stay `pending` in the receipt.
//
// `--workflow` and `--declare-no-ci` name how a repository without a workflow
// called CI runs. `preflight.mjs` takes no arguments, so they are not passed
// to it: they are checked against each other here and recorded in the
// `preflight` step's output.
//
// A `session <dir> (from --session|PI_ARTIFACTS_DIR)` line first on stdout,
// then one `phase0: <step>: <status> …` line per step, a step's further
// output indented under it when there is any, and the `NEED` lines last.
// Exit 0 every step ok, or `drift`/`unanswered` — advice the run goes on past;
// 2 a usage error; 3 a step failed, or the run could not start or record itself
// (the scratch root, the controller record, the receipt); 4 a step needs the
// controller — dispatch what the NEED line names, then run this again. A NEED
// the fold-in prints is advice too and changes no exit status: a PR with no
// issue behind it is the controller's to queue or leave, and nothing a re-run
// could meet.
//
// Zero deps: node builtins and sibling scripts only.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, isDigits } from "./arg.mjs";
import { alarmFile } from "./controller-alarm.mjs";
import { ownClosingIssues } from "./closing-refs.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { readState, stateFileIn } from "./fleet-state.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { RECEIPT, RECEIPT_HELD, archiveStamp, receiptArchiveName, rowNums } from "./ledger-grammar.mjs";
import { ancestry, controllerOf, processSource, ProcUnreadable } from "./proc.mjs";
import { IN_FLIGHT_DEFAULT, OBJECTIVES, OBJECTIVE_DEFAULT } from "./phase0-receipt.mjs";

const NAME = "phase0";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;
const isRecord = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const NETWORK_TIMEOUT_MS = 120_000;
const PR_LIMIT = 1000;
// The tail of a child's output is the part that says why it stopped.
const OUTPUT_MAX = 16_000;
const RULESET_SPEC = join(".github", "rulesets", "main.json");
const RULESET_CHECK = join(".github", "scripts", "apply-ruleset.sh");

const script = (name) => join(SCRIPTS, name);

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

const trimmed = (s) => String(s ?? "").trim();
const lines = (s) => trimmed(s).split("\n").filter((l) => l.trim() !== "");

/**
 * Runs a child to completion from `cwd`. `status` is the exit status, null
 * when the child never ran or was killed (`how` says which); `text` is its
 * stdout then stderr, trimmed.
 */
function run(cmd, args, { cwd, env, timeoutMs } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(env), timeout: timeoutMs,
  });
  const stdout = trimmed(r.stdout);
  const stderr = trimmed(r.stderr);
  return { status: r.error ? null : r.status, stdout, stderr, text: [stdout, stderr].filter(Boolean).join("\n"), how: how(r) };
}

const node = (name, args, opts) => run(process.execPath, [script(name), ...args], opts);
const sh = (name, args, opts) => run("sh", [script(name), ...args], opts);

const ok = (output) => ({ status: "ok", output });
const failed = (output) => ({ status: "failed", output });
const withText = (head, r) => (r.text ? `${head}\n${r.text}` : head);
const refusal = (what, r) => failed(withText(`${what} ${r.how}`, r));

// ── the steps ────────────────────────────────────────────────────────────────

function branch({ cwd }) {
  const r = run("git", ["symbolic-ref", "-q", "HEAD"], { cwd });
  if (r.status === 0 && r.stdout === "refs/heads/main") return ok("HEAD is refs/heads/main");
  const now = r.status === 0 ? r.stdout : r.status === 1 ? "detached" : `unreadable (${r.how})`;
  return failed(`HEAD is ${now}, not refs/heads/main — switch the checkout to main before the run starts`);
}

function fastForward({ cwd }) {
  const fetch = run("git", ["fetch", "origin"], { cwd, timeoutMs: NETWORK_TIMEOUT_MS });
  if (fetch.status !== 0) return refusal("git fetch origin failed:", fetch);
  const count = run("git", ["rev-list", "--count", "main..origin/main"], { cwd });
  if (count.status !== 0 || !isDigits(count.stdout)) return refusal("git rev-list --count main..origin/main failed:", count);
  const behind = Number(count.stdout);
  if (behind === 0) return ok("main is level with origin/main");
  const merge = run("git", ["merge", "--ff-only", "origin/main"], { cwd });
  if (merge.status !== 0) return refusal("git merge --ff-only origin/main failed:", merge);
  return failed(`SUPERSEDED ${behind} commits; re-run phase0.mjs`);
}

function pin({ cwd, pluginCheckout }) {
  const r = sh("instruments.sh", ["--pin", ...(pluginCheckout ? ["--audit", pluginCheckout] : [])], { cwd });
  if (r.status !== 0) return refusal("instruments.sh --pin failed:", r);
  return ok(pluginCheckout ? `instruments pinned, auditing ${pluginCheckout}` : "instruments pinned");
}

function baseline({ cwd }) {
  const r = node("main-checkout.mjs", ["--record"], { cwd });
  if (r.status !== 0) return refusal("main-checkout.mjs --record refused:", r);
  return ok("main-checkout baseline recorded");
}

function preflight({ cwd, ci }) {
  const r = node("preflight.mjs", [], { cwd });
  if (r.status !== 0) {
    // Exit 1 is a row that failed, and its FAIL, WARN and PREFLIGHT lines are
    // the report; exit 2 is a script that could not run, whose own words are
    // all there is, as are an exit 1 that printed none of those lines.
    const fails = r.status === 1 ? lines(r.text).filter((l) => /^(FAIL|WARN|PREFLIGHT)/.test(l)) : [];
    const keep = fails.length > 0 ? fails : lines(r.text);
    return failed([`preflight.mjs ${r.how}`, ...keep].join("\n"));
  }
  return ok([`preflight.mjs passed (${lines(r.stdout).at(-1) ?? "no output"})`, ...(ci === null ? [] : [ci])].join("\n"));
}

function ruleset({ cwd }) {
  if (!existsSync(join(cwd, RULESET_SPEC))) return ok(`no ruleset spec at ${RULESET_SPEC} — nothing to check`);
  const r = run("bash", [join(cwd, RULESET_CHECK), "--check"], { cwd, timeoutMs: NETWORK_TIMEOUT_MS });
  if (r.status === 0) return ok("the live gate matches the ruleset spec");
  if (r.status === 3) return { status: "drift", output: withText("the live gate differs from the ruleset spec", r) };
  return { status: "unanswered", output: withText(`apply-ruleset.sh --check could not answer (${r.how})`, r) };
}

function tierRoles({ cwd, receipt }) {
  const r = node("tier-roles.mjs", ["--check", "--in-flight", String(receipt.inFlight)], { cwd });
  if (r.status !== 0) return refusal("tier-roles.mjs --check failed:", r);
  return ok(withText(`every tier route resolves (in-flight bound ${receipt.inFlight})`, r));
}

function metrics({ cwd }) {
  const r = node("metrics-refresh.mjs", [], { cwd });
  if (r.status !== 0) return refusal("metrics-refresh.mjs failed:", r);
  return ok(withText("metrics-refresh.mjs ran", r));
}

function cockpit({ cwd, spendDir }) {
  const args = [script("board.mjs"), "serve", "--open", ...(spendDir ? ["--spend-dir", spendDir] : [])];
  let child;
  try {
    child = spawn(process.execPath, args, { cwd, detached: true, stdio: "ignore", env: gitEnv() });
  } catch (e) {
    return ok(`not launched: ${e.message}`);
  }
  // A launch that fails does so after this returns; nobody reads the event.
  child.on("error", () => {});
  child.unref();
  return ok(child.pid === undefined ? "not launched" : `launched board.mjs serve, pid ${child.pid}`);
}

function rotate(ctx) {
  // This run's own partial receipt is off disk while the rotation runs, so the
  // archive cannot file it under the previous run's stamp. What the rotation
  // finds beside the ledger is the previous run's receipt, held since startup.
  rmSync(ctx.receiptPath, { force: true });
  const restored = existsSync(ctx.held);
  if (restored) renameSync(ctx.held, ctx.receiptPath);
  const r = node("ledger.mjs", ["rotate"], { cwd: ctx.cwd });
  if (restored && existsSync(ctx.receiptPath)) {
    // Not archived. After a refusal it waits, held, for the next attempt; after
    // a rotation that moved the ledger and not the receipt it is filed here,
    // unless that name is taken.
    const filed = join(ctx.fleetDir, receiptArchiveName(archiveStamp()));
    renameSync(ctx.receiptPath, r.status === 0 && !existsSync(filed) ? filed : ctx.held);
  }
  if (r.status !== 0) return refusal("ledger.mjs rotate refused:", r);
  const { controller } = readState(stateFileIn(ctx.fleetDir), NAME);
  ctx.receipt.run = controller?.at ?? null;
  const head = ctx.receipt.run === null ? "ledger rotated; no omp process above this run, so no controller record — a re-run is keyed on the session alone" : `ledger rotated, run ${ctx.receipt.run}`;
  // What rotate says on stderr is the only account of rows it did not carry
  // and a receipt it could not archive.
  return ok([head, ...lines(r.stderr).map((l) => l.trim())].join("\n"));
}

function reclaim({ cwd, scratch }) {
  const live = node("reclaim-scratch.mjs", ["--root", scratch, "--after-rotate", "--apply"], { cwd });
  // The sibling pass runs whatever the live sweep answered: a failure there is recorded beside it, never a reason to skip it.
  const siblings = node("reclaim-scratch.mjs", ["--siblings", "--root", scratch, "--apply"], { cwd });
  return ok([
    live.status === 0 ? "scratch reclaimed" : withText(`reclaim-scratch.mjs ${live.how}, not enforced`, live),
    ...unreclaimed("scratch root", live),
    ...(siblings.status === 0 ? unreclaimed("sibling keys", siblings) : [withText(`sibling keys: reclaim-scratch.mjs ${siblings.how}, not enforced`, siblings)]),
  ].join("\n"));
}

// A pass that exited 0 still lists in its receipt's `failed[]` what it could
// not judge or remove: each is named here, and none fails the step.
function unreclaimed(what, r) {
  if (r.status !== 0) return [];
  let entries;
  try {
    ({ failed: entries } = JSON.parse(r.stdout));
  } catch (e) {
    return [`${what}: could not read reclaim-scratch.mjs's receipt: ${e.message}`];
  }
  if (!Array.isArray(entries)) return [`${what}: reclaim-scratch.mjs's receipt holds no failed[]`];
  return entries.map((x) => `${what}: could not reclaim ${x?.path} (${x?.error})`);
}

function recipe({ cwd }) {
  const reads = [["install"], ["test", "--at", "origin/main"]].map((a) => ({ a, r: sh("derive-testcmd.sh", [".", ...a], { cwd }) }));
  const broken = reads.filter(({ r }) => r.status === 3 || (r.status !== 0 && r.status !== 1));
  if (broken.length > 0) {
    return failed(broken.map(({ a, r }) => withText(`derive-testcmd.sh . ${a.join(" ")} ${r.how} — the cache's state is unknown, and deriving would not help`, r)).join("\n"));
  }
  const refused = reads.filter(({ r }) => r.status === 1);
  if (refused.length > 0) {
    return { status: "pending", output: [...refused.map(({ a, r }) => withText(`derive-testcmd.sh . ${a.join(" ")} refused:`, r)), "NEED derive-recipe"].join("\n") };
  }
  return ok(`Recipe cache valid: ${reads.map(({ r }) => lines(r.stdout).at(-1) ?? "").join(" ; ")}`);
}

// The ledger's rows, read through `ledger.mjs read` so the ledger keeps one
// parser. `{ error }` when the read did not answer, `{ rows }` otherwise.
function ledgerRows(cwd) {
  const r = node("ledger.mjs", ["read"], { cwd });
  if (r.status !== 0) return { error: withText(`ledger.mjs read ${r.how}`, r) };
  try {
    const { rows } = JSON.parse(r.stdout);
    if (Array.isArray(rows) && rows.every((x) => typeof x === "string")) return { rows };
  } catch {
    // Falls through to the refusal below.
  }
  return { error: "ledger.mjs read printed no {rows}" };
}

const rowKey = (row) => row.split(/\s/)[0];

function foldIn({ cwd }) {
  const list = run("gh", ["pr", "list", "--state", "open", "--json", "number,closingIssuesReferences,url", "--limit", String(PR_LIMIT)], {
    cwd, env: { GH_REPO: "" }, timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (list.status !== 0) return refusal("gh pr list failed:", list);
  let prs;
  try {
    prs = JSON.parse(list.stdout);
  } catch (e) {
    return failed(`could not parse gh pr list: ${e.message}`);
  }
  if (!Array.isArray(prs)) return failed("gh pr list did not print a JSON array");
  if (prs.length >= PR_LIMIT) return failed(`gh pr list came back at its cap of ${PR_LIMIT} — it may hold more PRs than it showed, so none is folded in`);
  // The issues each PR closes in its own repository, by ownClosingIssues()'s
  // rule — another repository's reference closes none of this one's — read
  // for every PR before any row is written, so one that cannot be read folds
  // nothing in.
  const closing = new Map();
  for (const pr of prs) {
    try {
      closing.set(pr, ownClosingIssues(pr?.number, pr?.url, pr?.closingIssuesReferences ?? []));
    } catch (e) {
      return failed(`gh pr list answered PR #${pr?.number} with ${e.message} — which issues it closes is unknown, so none is folded in`);
    }
  }
  const ledger = ledgerRows(cwd);
  if (ledger.error) return failed(`${ledger.error} — which PRs a carried row names is unknown`);

  // A PR a carried row names is queued by that row already, and a `row` write
  // replaces the whole line, wiping the live tokens carried on it.
  const named = new Set();
  for (const row of ledger.rows) {
    const { keyNum, pr } = rowNums(row);
    if (keyNum !== null) named.add(keyNum);
    if (pr !== null) named.add(pr);
  }
  const queued = [];
  const advice = [];
  let carried = 0;
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (named.has(pr.number)) {
      carried += 1;
      continue;
    }
    const issues = closing.get(pr);
    if (issues.length === 0) {
      advice.push(`NEED review PR#${pr.number} (closes no issue)`);
      continue;
    }
    const closes = `closes ${issues.map((n) => `#${n}`).join(", ")}`;
    const w = node("ledger.mjs", ["row", String(pr.number), `PR#${pr.number} · inherited (${closes})`], { cwd });
    if (w.status !== 0) return refusal(`ledger.mjs row ${pr.number} failed:`, w);
    queued.push(`queued PR#${pr.number} for review (${closes})`);
  }
  const head = `${queued.length} PR(s) queued, ${carried} already on a carried row, ${advice.length} closing no issue`;
  return ok([head, ...queued, ...advice].join("\n"));
}

function stranded({ cwd }) {
  const r = node("stranded.mjs", [], { cwd });
  if (r.status !== 0) return refusal("stranded.mjs could not answer:", r);
  let verdict;
  try {
    verdict = JSON.parse(r.stdout);
  } catch (e) {
    return failed(`could not parse stranded.mjs output: ${e.message}`);
  }
  if (!Array.isArray(verdict?.claims) || !Array.isArray(verdict?.carried)) return failed("stranded.mjs printed no {claims, carried}");
  const ledger = ledgerRows(cwd);
  if (ledger.error) return failed(`${ledger.error} — which claims are already resumed is unknown`);
  const rowed = new Set(ledger.rows.map(rowKey));

  const body = [];
  const needs = [];
  for (const c of verdict.claims) {
    if (c.action !== "resume") body.push(`report #${c.n} — ${c.why}`);
    else if (rowed.has(`#${c.n}`)) body.push(`#${c.n} resumed: its ledger row is there`);
    else needs.push(`NEED resume #${c.n} ${c.worktree} ${c.branch}`);
  }
  for (const t of verdict.carried) body.push(`carried ${t.name} ${t.token} (row ${t.row ?? "none"})`);
  const head = `prior ${verdict.prior}: ${verdict.claims.length} claim(s), ${verdict.carried.length} live token(s) carried`;
  return { status: needs.length > 0 ? "pending" : "ok", output: [head, ...body, ...needs].join("\n") };
}

function shortlist({ cwd }) {
  const r = node("shortlist.mjs", [], { cwd });
  if (r.status !== 0) return refusal("shortlist.mjs refused:", r);
  return ok("shortlist built");
}

// The controller alarm: this omp's own record that its timer is armed against
// this checkout's `.fleet/` (controller-alarm.mjs writes it at session_start).
// The record is read, not trusted: it must name this omp's pid and start time
// and this `.fleet/`.
function alarm({ fleetDir }) {
  const tail = " — restart omp";
  let controller;
  try {
    const source = processSource();
    controller = controllerOf(source, ancestry(source));
  } catch (e) {
    if (!(e instanceof ProcUnreadable)) throw e;
    return failed(`${e.message}${tail}`);
  }
  if (controller === null) return failed(`no omp process above phase 0: the controller alarm cannot be checked${tail}`);
  const path = alarmFile(controller.pid);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return failed(`controller alarm is not armed: ${path} does not exist${tail}`);
    return failed(`controller alarm file ${path} cannot be read (${e.code ?? e.message})${tail}`);
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch (e) {
    return failed(`controller alarm file ${path} is not JSON (${e.message})${tail}`);
  }
  if (!isRecord(rec)) return failed(`controller alarm file ${path} is not an object${tail}`);
  const missing = ["pid", "lstart", "fleet"].filter((k) => !Object.hasOwn(rec, k));
  if (missing.length > 0) return failed(`controller alarm file ${path} lacks ${missing.join(", ")}${tail}`);
  if (rec.pid !== controller.pid) return failed(`controller alarm file ${path} names pid ${rec.pid}, but this omp is pid ${controller.pid}${tail}`);
  if (rec.lstart !== controller.lstart) return failed(`controller alarm file ${path} was written by a process started at "${rec.lstart}", but this omp started at "${controller.lstart}"${tail}`);
  if (rec.fleet !== fleetDir) return failed(`controller alarm file ${path} names fleet "${rec.fleet}", not ${fleetDir}${tail}`);
  return ok(`controller alarm armed: pid ${controller.pid}, ${fleetDir}`);
}

const STEPS = {
  "alarm": alarm, "branch": branch, "fast-forward": fastForward, "pin": pin, "baseline": baseline, "preflight": preflight,
  "ruleset": ruleset, "tier-roles": tierRoles, "metrics": metrics, "cockpit": cockpit, "rotate": rotate,
  "reclaim": reclaim, "recipe": recipe, "fold-in": foldIn, "stranded": stranded, "shortlist": shortlist,
};

const STEP_NAMES = Object.keys(STEPS);

// ── the receipt ──────────────────────────────────────────────────────────────

// Null when there is no receipt; a receipt that is there and cannot be read or
// is not one throws, naming the file and why.
function readReceipt(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read the receipt ${path} (${e.code ?? e.message}) — move it aside and re-run`);
  }
  let r;
  try {
    r = JSON.parse(text);
  } catch (e) {
    throw new Error(`the receipt ${path} is not JSON (${e.message}) — move it aside and re-run`);
  }
  if (!(isRecord(r) && isRecord(r.steps) && Object.hasOwn(r, "run") && typeof r.session === "string")) {
    throw new Error(`the receipt ${path} has no steps, run and session — move it aside and re-run`);
  }
  return r;
}

function writeReceipt(path, receipt) {
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmp, path);
}

const capped = (s) => (s.length > OUTPUT_MAX ? `…${s.slice(-(OUTPUT_MAX - 1))}` : s);

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, {
    flags: {
      session: "value", "in-flight": "value", objective: "value", "plugin-checkout": "value",
      "spend-dir": "value", workflow: "value", "declare-no-ci": "bool",
    },
  });
  F.sweep();
  F.stray();
  const absent = (name) => F.arg(name) === null;
  // The session directory: --session, else PI_ARTIFACTS_DIR, which omp exports
  // to its Python eval kernel and that kernel's children — not to the bash
  // tool. Never a guess at the newest session for this cwd: a concurrent
  // session in the same cwd can be newer.
  const given = F.arg("session");
  const fromEnv = process.env.PI_ARTIFACTS_DIR || null;
  if (given === null && fromEnv === null) {
    die("no session directory: pass --session <dir>, or run phase 0 from a Python eval cell (PI_ARTIFACTS_DIR); the bash tool's environment carries none");
  }
  const source = given === null ? "PI_ARTIFACTS_DIR" : "--session";
  const session = resolve(given ?? fromEnv);
  // A session is named by its transcript, `<session>.jsonl`, beside the
  // directory: an existing directory with none beside it — the one holding
  // every session of a checkout, say — names no session. The directory itself
  // may not exist yet: omp creates it when the session's first subagent writes
  // there.
  const transcript = existsSync(`${session}.jsonl`);
  try {
    if (!statSync(session).isDirectory()) die(`${source} ${session} is not a directory`);
    if (!transcript) die(`${source} ${session} has no ${session}.jsonl beside it, so it names no session`);
  } catch (e) {
    if (e.code === undefined) throw e;
    if (e.code !== "ENOENT") die(`${source} ${session} is not readable (${e.code})`);
    if (!transcript) die(`${source} ${session} does not exist, and no ${session}.jsonl beside it names a session`);
  }
  const positive = (name) => {
    const n = F.numArg(name);
    if (n !== null && n < 1) die(`--${name} needs a positive number, got ${n}`);
    return n;
  };
  const inFlight = positive("in-flight") ?? IN_FLIGHT_DEFAULT;
  const named = F.arg("objective");
  if (named !== null && !OBJECTIVES.includes(named)) die(`--objective needs ${OBJECTIVES.join(" or ")}, got ${named}`);
  if (F.has("declare-no-ci") && !absent("workflow")) die("--workflow and --declare-no-ci are alternatives, not a pair");
  const ci = F.has("declare-no-ci") ? "CI: declared absent (--declare-no-ci)" : absent("workflow") ? null : `CI: workflow ${F.arg("workflow")} (--workflow)`;
  const pathOf = (name) => (absent(name) ? null : resolve(F.arg(name)));
  const pluginCheckout = pathOf("plugin-checkout");
  const spendDir = pathOf("spend-dir");

  let fleetDir;
  try {
    fleetDir = fleetFile(null);
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    die(e.message);
  }
  const cwd = dirname(fleetDir);
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (top.status !== 0 || realpathSync(top.stdout) !== realpathSync(cwd)) {
    die(`run this from the main checkout ${cwd}${top.status === 0 ? `, not ${top.stdout}` : ""}`);
  }
  const root = node("scratch-root.mjs", [], { cwd });
  if (root.status !== 0) {
    process.stderr.write(`${NAME}: scratch-root.mjs ${root.how}\n${root.text}\n`);
    process.exitCode = 3;
    return;
  }
  const scratch = root.stdout;

  const receiptPath = join(fleetDir, RECEIPT);
  const held = join(fleetDir, RECEIPT_HELD);
  const state = readState(stateFileIn(fleetDir), NAME);
  if (state.degraded) {
    // The record decides whether a receipt is the previous run's, and a record
    // that could not be read says nothing about that.
    process.stderr.write(`${NAME}: ${stateFileIn(fleetDir)} ${state.degraded} — repair it so the controller record is intact; a receipt is not set aside on a record that could not be read\n`);
    process.exitCode = 3;
    return;
  }
  const record = state.controller;
  const now = new Date().toISOString();
  let previous;
  try {
    previous = readReceipt(receiptPath);
  } catch (e) {
    // A receipt that is there and cannot be used may record a rotation already
    // done; starting over would run it a second time.
    process.stderr.write(`${NAME}: ${e.message}\n`);
    process.exitCode = 3;
    return;
  }
  // A receipt belongs to a rotated run when the rotation wrote a controller
  // record it can be keyed on, or, when it wrote none, when its rotation is
  // recorded `ok`. Either way it is this run's only if the record now holds
  // the `at` it names and the session is the same.
  const rotated = previous !== null && (previous.run !== null || previous.steps.rotate?.status === "ok");
  const resumed = rotated && previous.run === (record?.at ?? null) && previous.session === session;
  // The Objective is fixed for the run: a resumed receipt's stands, and one
  // written before receipts recorded it resumes as the default. A receipt
  // recording anything else is refused, never read as an Objective.
  if (resumed && previous.objective !== undefined && !OBJECTIVES.includes(previous.objective)) {
    process.stderr.write(`${NAME}: this run's receipt ${receiptPath} records the objective ${JSON.stringify(previous.objective)}, which is not ${OBJECTIVES.join(" or ")} — set it to the objective this run began with and re-run\n`);
    process.exitCode = 3;
    return;
  }
  const kept = resumed ? previous.objective ?? OBJECTIVE_DEFAULT : null;
  if (kept !== null && named !== null && named !== kept) {
    die(`--objective ${named}: this run's receipt ${receiptPath} records the objective ${kept}, fixed for the run — run phase 0 again without --objective, or with --objective ${kept}`);
  }
  const objective = kept ?? named ?? OBJECTIVE_DEFAULT;
  if (rotated && !resumed) {
    if (existsSync(held)) {
      process.stderr.write(`${NAME}: cannot hold the previous run's receipt for the rotation: ${held} already holds another\n`);
      process.exitCode = 3;
      return;
    }
    renameSync(receiptPath, held);
  }

  const receipt = { run: resumed ? previous.run : null, session, scratch, inFlight, objective, steps: {} };
  for (const name of STEP_NAMES) {
    // `alarm` checks the omp running this invocation, so its `ok` is never carried.
    const was = resumed && name !== "alarm" ? previous.steps[name] : undefined;
    receipt.steps[name] = was?.status === "ok" ? was : { status: "pending", at: now, output: "not run" };
  }

  const ctx = { cwd, fleetDir, held, receipt, receiptPath, scratch, pluginCheckout, spendDir, ci };
  const say = (line) => process.stdout.write(`${line}\n`);
  say(`session ${session} (from ${source})`);
  let stop = null;
  for (const name of STEP_NAMES) {
    if (receipt.steps[name].status === "ok") {
      say(`phase0: ${name}: ok (done earlier in this run)`);
      continue;
    }
    let result;
    try {
      result = STEPS[name](ctx);
    } catch (e) {
      result = failed(`${name} threw: ${e.message}`);
    }
    receipt.steps[name] = { status: result.status, at: new Date().toISOString(), output: capped(result.output) };
    try {
      writeReceipt(receiptPath, receipt);
    } catch (e) {
      say(`phase0: ${name}: ${result.status}`);
      process.stderr.write(`${NAME}: cannot write ${receiptPath}: ${e.message}\n`);
      process.exitCode = 3;
      return;
    }
    const [head, ...rest] = lines(result.output).filter((l) => !l.startsWith("NEED "));
    say(`phase0: ${name}: ${result.status}${head ? ` — ${head}` : ""}`);
    for (const l of rest) say(`    ${l}`);
    if (result.status === "failed" || result.status === "pending") {
      stop = result.status;
      break;
    }
  }

  for (const name of STEP_NAMES) {
    for (const l of lines(receipt.steps[name].output)) if (l.startsWith("NEED ")) say(l);
  }
  process.exitCode = stop === "failed" ? 3 : stop === "pending" ? 4 : 0;
}

if (isCLI(import.meta.url)) main();
