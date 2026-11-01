#!/usr/bin/env node
// Evict: remove a claim tree's installed dependencies — every path git
// ignores in it except the `agent-test` runner — once IDLE_MS pass with
// neither a HEAD move nor a restore in it. The claim, its tree, its branch and
// its commits stay; the Install step runs again, through `--restore`, before a
// member runs code there. Not Reap, Release or Reclaim, which remove things.
//
//   evict.mjs [--after-rotate] [--apply]
//   evict.mjs --restore <abs tree> [--apply]
//
// Dry run by default; `--apply` mutates.
//
// THE SWEEP judges every worktree git lists directly under this checkout's
// `.worktrees/`, the checkout being the one fleet-dir.mjs's fleetFile()
// resolves from the cwd. A candidate is a claim tree: its directory and its
// branch match stranded.mjs's CLAIM_WORKTREE and CLAIM_BRANCH
// (`<N>-impl-<N>[-x]` on `implementer/<N>-impl-<N>[-x]`), whatever its PR's
// state; nothing here calls `gh`. A tree is KEPT, with its reason, when:
//   - it is no claim tree (another name, or another branch);
//   - a git operation is in progress in it — the state worktree.sh's
//     `wt_op_state` reads, which reap.sh reads too;
//   - this script's own cwd is inside it;
//   - a live member token holds it (below);
//   - it carries the mark already;
//   - `git status --porcelain -uall` in it is non-empty;
//   - HEAD moved or a restore ran in it within IDLE_MS: the newer of the
//     newest entry of the tree's own HEAD reflog (`logs/HEAD` in its admin
//     dir, or git's answer in a reftable repository; HEAD's commit date when
//     that reflog is empty) and the time RESTORED records;
//   - it ignores nothing but the runner;
//   - anything about it cannot be read — its `.git`, its admin dir, a status,
//     a reflog. A worktree listing that cannot be read keeps the whole
//     `.worktrees/` directory, with that reason.
// Every other candidate is evicted.
//
// LIVE TOKENS. The ledger's live tokens (ledger-grammar.mjs's liveOnLedger())
// of the members that work a claim tree's ticket or PR — `impl-<N>`,
// `review-pr-<M>`, `fix-pr-<M>`, `finisher-pr-<M>`, any retry suffix — hold
// trees. `impl-<N>` holds tree N. Any other holds the trees of the tickets the
// row carrying it names: a row keyed `#<N>` names ticket N, and a fold-in row
// `PR#<M> · inherited (closes #<N>, …)` names the tickets its list does. One
// on a row naming no ticket with a claim tree here (`closes no issue`, or only
// other issues), or on no row at all, holds every candidate: the tree its
// member works in cannot be told.
//
// THE LEDGER is read as reclaim-scratch.mjs reads it: `.fleet/ledger.md`
// through `ledger.mjs read`. An absent one refuses, except under
// `--after-rotate`, which phase 0 passes straight after its rotation: there
// an absent ledger is no live token. Only ENOENT is absence.
//
// `--apply` judges each tree to evict again, writes the mark (EVICTED, a file
// in the tree's git admin dir), then removes every ignored path but the
// runner through reclaim-scratch.mjs's one removal sequence. Tracked files,
// HEAD, the branch and the registration are not touched. Best-effort per
// tree: a tree whose mark cannot be written, or a path in it that cannot be
// removed, lands in `failed` and keeps its mark; the sweep goes on.
//
// Prints ONE JSON line:
//   {"applied","ledger":<abs path|null>,"evicted":[{"path","reason","ignored"}],
//    "kept":[{"path","reason"}],"failed":[{"path","error"}]}
// `ledger` is null when none was read (`--after-rotate` with no file); a dry
// run's `evicted` names what `--apply` would evict. Exit 0 whenever the receipt
// is printed; 2 for a refused invocation, before anything is touched.
//
// RESTORE. `--restore <abs tree>` runs the Install step in an evicted tree as
// claim-ticket.sh runs it after `worktree add`: the command `derive-testcmd.sh
// <tree> install --at origin/main` prints, through `sh -c` in the tree with `CI` unset. Exit 126
// or 127 refuses as a Recipe that no longer runs, any other non-zero as a
// failed install, and a `git status --porcelain -uall` that is not empty
// after it as an Install step that changed the tree — each with the claim's
// own words. A status that is not empty BEFORE it refuses in words of its
// own, before anything runs: that change is no Install step's. Only once the
// status after it is empty does it write the restore time (RESTORED) and then
// remove the mark; every refusal leaves the mark. A tree with no mark refuses:
// there is nothing to restore. Without `--apply` it runs nothing and prints
// the command it would run. Prints
// `{"applied","worktree","install"}`; exit 0 restored (or would), 2 refused.
//
// That install sequence is `installIn()`, exported: finisher-tree.mjs runs the
// same read, the same checks and the same words in the tree it builds for the
// acceptance mutation, so there is one copy of it.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlags, isDigits, makeDie, writeAll } from "./arg.mjs";
import { adminDir, EVICTED, evictionMark, how, RESTORED } from "./evict-mark.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { liveOnLedger, parseMember, REVIEWER } from "./ledger-grammar.mjs";
import { ledgerFile, readLedger, removeEntry } from "./reclaim-scratch.mjs";
import { CLAIM_BRANCH, CLAIM_WORKTREE } from "./stranded.mjs";

const NAME = "evict";
const die = makeDie(NAME);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
// How long a claim tree sits with neither a HEAD move nor a restore before it
// is evicted.
export const IDLE_MS = 7 * DAY_MS;
/** Whether a tree whose HEAD last moved, or which was last restored, at `last` is idle at `now`. */
export const isIdle = (now, last) => now - last >= IDLE_MS;
const RUNNER = "agent-test";
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
// claim-ticket.sh's `rederive`, word for word: a restore refuses as the claim
// does.
export const REDERIVE = "the Recipe cache is invalid; run the Recipe derivation step (run-team phase 0, before the first claim) to re-derive it";
// worktree.sh's `wt_op_state`, sourced: `$wt_op` names the operation in
// progress, empty for none; a non-zero exit is an admin dir it cannot read.
const OP_STATE = '. "$1" || exit 3; wt_op_state "$2" || exit 1; printf "%s" "$wt_op"';

// Every child this script starts, with GIT_DIR and GIT_WORK_TREE scrubbed so
// an ambient pair cannot answer for another repository; `drop` names more
// variables to leave out.
function run(cmd, args, { cwd, drop = [], stdio, timeout = GIT_TIMEOUT_MS } = {}) {
  const env = gitEnv();
  for (const k of drop) delete env[k];
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env, stdio, timeout });
}

const git = (tree, args) => run("git", ["-C", tree, ...args]);

// --- live tokens ------------------------------------------------------------

const FOLD_IN = /· inherited \(closes ([^)]*)\)/;

/** The tickets a ledger row names: a fold-in row's `closes` list, else its `#<N>` key. */
export function rowTickets(text) {
  const fold = FOLD_IN.exec(text);
  if (fold) return [...fold[1].matchAll(/#([1-9][0-9]*)/g)].map((m) => Number(m[1]));
  const key = text.split(/\s/)[0];
  return /^#[1-9][0-9]*$/.test(key) ? [Number(key.slice(1))] : [];
}

/**
 * Which claim trees the ledger's live tokens hold: `{all, byTicket}`, `all`
 * the reason every candidate is held (null when none is), `byTicket` ticket
 * number → reason. `here` is the set of ticket numbers a claim tree here is
 * named for.
 */
export function liveHolds(rows, dispatched, here) {
  const byTicket = new Map();
  let all = null;
  const hold = (n, why) => {
    if (!byTicket.has(n)) byTicket.set(n, why);
  };
  for (const t of liveOnLedger(rows, dispatched).tokens) {
    const member = parseMember(t.name);
    // The members that run in a claim tree, or review or finish its PR.
    if ((member === null || member.family === "merge-bot") && !REVIEWER.test(t.name)) continue;
    if (member?.family === "impl") {
      hold(member.number, `held by the live ${t.name}`);
      continue;
    }
    const carrying = rows.filter((text) => text.split(/\s+/).includes(t.token));
    if (carrying.length === 0) all ??= `held by the live ${t.name}, which is on no row, so the tree its member works in cannot be told`;
    for (const text of carrying) {
      const key = text.split(/\s/)[0];
      const named = rowTickets(text).filter((n) => here.has(n));
      if (named.length === 0) all ??= `held by the live ${t.name} on row ${key}, which names no ticket with a claim tree here, so the tree its member works in cannot be told`;
      for (const n of named) hold(n, `held by the live ${t.name} on row ${key}`);
    }
  }
  return { all, byTicket };
}

// --- the worktrees ----------------------------------------------------------

// Every worktree git lists directly under `checkout`'s `.worktrees/`, as
// `{path, branch, prunable}`, `branch` the short name or null when detached.
// `{unknown}` when the listing or the directory cannot be read.
function listing(checkout) {
  const r = git(checkout, ["worktree", "list", "--porcelain", "-z"]);
  if (r.error || r.status !== 0) return { unknown: `git worktree list failed (${how(r)})` };
  const home = join(checkout, ".worktrees");
  let real;
  try {
    real = realpathSync(home);
  } catch (e) {
    if (e.code === "ENOENT") return { trees: [] };
    return { unknown: `cannot resolve ${home} (${e.code ?? e.message})` };
  }
  const all = [];
  let cur = null;
  for (const field of r.stdout.split("\0")) {
    if (field === "") cur = null;
    else if (field.startsWith("worktree ")) all.push((cur = { path: field.slice("worktree ".length), branch: null, prunable: false }));
    else if (cur !== null && field.startsWith("branch refs/heads/")) cur.branch = field.slice("branch refs/heads/".length);
    else if (cur !== null && (field === "prunable" || field.startsWith("prunable "))) cur.prunable = true;
  }
  const trees = [];
  for (const w of all) {
    try {
      if (realpathSync(dirname(w.path)) === real) trees.push(w);
    } catch (e) {
      if (e.code !== "ENOENT") return { unknown: `cannot resolve ${dirname(w.path)} (${e.code ?? e.message})` };
    }
  }
  return { trees };
}

// The newest entry of the tree's own HEAD reflog, in ms, or null when that
// reflog holds none; throws what cannot be read. The files ref backend keeps
// it as `logs/HEAD` in the admin dir, read here directly. A reftable
// repository keeps no such file, so there git answers: `reflog exists HEAD`,
// then the newest entry's time. Never `git log -g` alone: for a HEAD whose
// reflog holds nothing it walks the branch's reflog instead.
function reflogNewest(tree, dir) {
  const format = git(tree, ["rev-parse", "--show-ref-format"]);
  if (format.error || format.status !== 0) throw new Error(`cannot tell how its refs are stored (${how(format)})`);
  if (format.stdout.trim() === "reftable") {
    const exists = git(tree, ["reflog", "exists", "HEAD"]);
    if (!exists.error && exists.signal === null && exists.status === 1) return null;
    if (exists.error || exists.status !== 0) throw new Error(`cannot read its HEAD reflog (${how(exists)})`);
    const r = git(tree, ["log", "-g", "-1", "--date=unix", "--format=%gd", "HEAD"]);
    const at = /^HEAD@\{([0-9]+)\}$/.exec(String(r.stdout ?? "").trim());
    if (r.error || r.status !== 0 || !at) throw new Error(`cannot read its HEAD reflog's newest entry (${how(r)})`);
    return Number(at[1]) * 1000;
  }
  let text;
  try {
    text = readFileSync(join(dir, "logs", "HEAD"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read its HEAD reflog (${e.code ?? e.message})`);
  }
  const last = text.split("\n").filter(Boolean).at(-1);
  if (last === undefined) return null;
  const m = / ([0-9]+) [+-][0-9]{4}$/.exec(last.split("\t")[0]);
  if (!m) throw new Error("cannot read its HEAD reflog's newest entry");
  return Number(m[1]) * 1000;
}

// When HEAD last moved in the tree, in ms: its reflog's newest entry, else
// HEAD's commit date.
function headMoved(tree, dir) {
  const logged = reflogNewest(tree, dir);
  if (logged !== null) return logged;
  const r = git(tree, ["log", "-1", "--format=%ct", "HEAD"]);
  const s = String(r.stdout ?? "").trim();
  if (r.error || r.status !== 0 || !isDigits(s)) throw new Error(`cannot read HEAD's commit date (${how(r)})`);
  return Number(s) * 1000;
}

// The restore time RESTORED records, in ms, or null when none was.
function restoredAt(dir) {
  const file = join(dir, RESTORED);
  let text;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read ${file} (${e.code ?? e.message})`);
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`${file} holds no time: ${JSON.stringify(text)}`);
  return at;
}

// Every path the tree ignores, relative to it, but the runner — a directory
// git lists whole once, and nothing listed inside one already listed.
function ignoredPaths(tree) {
  const r = git(tree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (r.error || r.status !== 0) throw new Error(`git ls-files --ignored failed (${how(r)})`);
  const out = [];
  for (const p of r.stdout.split("\0").filter(Boolean).sort()) {
    const bare = p.replace(/\/$/, "");
    if (bare === RUNNER) continue;
    if (out.some((q) => q.endsWith("/") && p.startsWith(q))) continue;
    out.push(p);
  }
  return out;
}

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * One tree's verdict: `{evict: {reason, ignored, dir}}` or `{kept}`, a reason.
 * `ctx` is `{cwd, holds, now}`.
 */
function judge(w, ctx) {
  const name = CLAIM_WORKTREE.exec(basename(w.path));
  if (!name) return { kept: `not a claim tree: its directory is not named <N>-impl-<N>[-x]` };
  if (w.prunable) return { kept: "git lists it as prunable: its directory is gone or cannot be read" };
  const admin = adminDir(w.path);
  if (admin.unknown !== undefined) return { kept: admin.unknown };
  const op = run("sh", ["-c", OP_STATE, "sh", join(SCRIPT_DIR, "worktree.sh"), w.path]);
  if (op.error || op.status !== 0) return { kept: `cannot tell whether a git operation is in progress in it (${how(op)})` };
  if (op.stdout !== "") return { kept: `a git operation is in progress in it (${op.stdout})` };
  const branch = w.branch === null ? null : CLAIM_BRANCH.exec(w.branch);
  if (branch === null || branch[2] !== name[2] || branch[1] !== name[1]) {
    return { kept: `not a claim tree: it is on ${w.branch === null ? "a detached HEAD" : w.branch}, not implementer/${basename(w.path)}` };
  }
  let real;
  try {
    real = realpathSync(w.path);
  } catch (e) {
    return { kept: `cannot resolve it (${e.code ?? e.message})` };
  }
  if (ctx.cwd !== null && within(ctx.cwd, real)) return { kept: "this script's own cwd is inside it" };
  const n = Number(name[1]);
  const held = ctx.holds.byTicket.get(n) ?? ctx.holds.all;
  if (held !== null) return { kept: held };
  const mark = evictionMark(w.path);
  if (mark.unknown !== undefined) return { kept: mark.unknown };
  if (mark.marked) return { kept: `already evicted: ${join(mark.dir, EVICTED)} is there` };
  const status = git(w.path, ["status", "--porcelain", "-uall"]);
  if (status.error || status.status !== 0) return { kept: `cannot read its status (${how(status)})` };
  if (status.stdout !== "") return { kept: `git status is not clean (first: ${status.stdout.split("\n")[0]})` };
  let moved;
  let restored;
  try {
    moved = headMoved(w.path, admin.dir);
    restored = restoredAt(admin.dir);
  } catch (e) {
    return { kept: e.message };
  }
  const last = Math.max(moved, restored ?? 0);
  const what = restored !== null && restored >= moved ? "restored" : "HEAD last moved";
  if (!isIdle(ctx.now, last)) return { kept: `${what} ${new Date(last).toISOString()}, within ${IDLE_MS / DAY_MS} days` };
  let ignored;
  try {
    ignored = ignoredPaths(w.path);
  } catch (e) {
    return { kept: e.message };
  }
  if (ignored.length === 0) return { kept: `it ignores nothing but ${RUNNER}` };
  return { evict: { reason: `${what} ${new Date(last).toISOString()}, over ${IDLE_MS / DAY_MS} days ago`, ignored, dir: admin.dir } };
}

// Mark the tree, then remove each ignored path in it; null, or the error.
function evictTree(path, verdict, now) {
  try {
    writeFileSync(join(verdict.dir, EVICTED), `${new Date(now).toISOString()}\n`);
  } catch (e) {
    return `could not write ${join(verdict.dir, EVICTED)} (${e.code ?? e.message}), so nothing was removed`;
  }
  const errors = [];
  for (const p of verdict.ignored) {
    const error = removeEntry(join(path, p.replace(/\/$/, "")));
    if (error !== null) errors.push(`${p}: ${error}`);
  }
  return errors.length ? `could not remove ${errors.join("; ")}` : null;
}

function sweep({ afterRotate, apply }) {
  const found = ledgerFile(die);
  if (found.file === null && !afterRotate) {
    die("no .fleet/ledger.md — without it no live member can hold its claim tree, so nothing is evicted; pass --after-rotate only straight after `ledger.mjs rotate`");
  }
  const ledger = found.file === null ? { rows: [], dispatched: [] } : readLedger(found.file, die, "evicted");
  let cwd;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    cwd = null;
  }
  const now = Date.now();
  const evicted = [];
  const kept = [];
  const failed = [];
  const list = listing(found.checkout);
  if (list.unknown !== undefined) {
    kept.push({ path: join(found.checkout, ".worktrees"), reason: list.unknown });
  } else {
    const here = new Set(list.trees.map((w) => CLAIM_WORKTREE.exec(basename(w.path))).filter(Boolean).map((m) => Number(m[1])));
    const ctx = { cwd, holds: liveHolds(ledger.rows, ledger.dispatched, here), now };
    for (const w of [...list.trees].sort((a, b) => a.path.localeCompare(b.path))) {
      let v = judge(w, ctx);
      // Judged again just before anything is touched: the dry verdict is a
      // moment old, and a member may have moved HEAD or dirtied it since.
      if (apply && v.kept === undefined) v = judge(w, ctx);
      if (v.kept !== undefined) {
        kept.push({ path: w.path, reason: v.kept });
        continue;
      }
      const error = apply ? evictTree(w.path, v.evict, now) : null;
      if (error === null) evicted.push({ path: w.path, reason: v.evict.reason, ignored: v.evict.ignored });
      else failed.push({ path: w.path, error });
    }
  }
  writeAll(1, `${JSON.stringify({ applied: apply, ledger: found.file, evicted, kept, failed })}\n`);
}

/**
 * The Install step in `tree`, read and, with `apply`, run as claim-ticket.sh
 * runs it: the one sequence a restore and the finisher's tree share. `{install}`
 * when it ran and left the tree clean (or, without `apply`, would run); else
 * `{refusal: {kind, message, install, exit}}`, `message` the claim's own words
 * and `exit` the Install step's exit status, null when it never produced one.
 * `kind` is one of:
 *   derive         derive-testcmd.sh would not name the Install step
 *   status-before  the tree state could not be read before the Install step
 *   dirty-before   the tree was not clean before it: nothing ran
 *   not-run        the Install step could not be started, or exited 126 or 127
 *   failed         it was killed by a signal, or exited non-zero
 *   status-after   the tree state could not be read after it
 *   dirtied        it left the tree changed
 * `verb` names the operation in the dirty-before refusal, and `retry` whether
 * that refusal tells its reader to clear the change and run the operation again:
 * a restore's caller may, the finisher may not. `install` is null in a refusal
 * that came before the command was read. Nothing here writes a mark or a
 * restore time, and it never exits the process.
 */
export function installIn(tree, apply, { verb = "restore", retry = true } = {}) {
  const refuse = (kind, message, install = null, exit = null) => ({ refusal: { kind, message, install, exit } });
  const derived = run("sh", [join(SCRIPT_DIR, "derive-testcmd.sh"), tree, "install", "--at", "origin/main"]);
  const install = String(derived.stdout ?? "").replace(/\n$/, "");
  if (derived.error || derived.status !== 0 || install === "") {
    return refuse("derive", String(derived.stderr ?? "").trim() || `derive-testcmd.sh ${tree} install failed (${how(derived)})`);
  }
  // Dirty before anything runs is no Install step's doing: said in its own
  // words, so the dirty-after refusal below never blames the Recipe for it.
  const before = git(tree, ["status", "--porcelain", "-uall"]);
  if (before.error || before.status !== 0) return refuse("status-before", `could not read the tree state in ${tree} before the Install step (${how(before)})`, install);
  if (before.stdout !== "") {
    const then = retry ? `; clear that change, then ${verb} again` : "";
    return refuse("dirty-before", `${tree} is not clean before the ${verb} (first: ${before.stdout.split("\n")[0]}) — the Install step did not run${then}`, install);
  }
  if (!apply) return { install };
  // Through `sh -c` with `CI` unset and the output dropped, as claim-ticket.sh
  // runs it; no timeout, as there.
  const r = run("sh", ["-c", install], { cwd: tree, drop: ["CI"], stdio: "ignore", timeout: 0 });
  if (r.error) return refuse("not-run", `the Install step '${install}' did not run in ${tree} (${how(r)}) — ${REDERIVE}`, install);
  if (r.signal) return refuse("failed", `install failed in ${tree} (${how(r)})`, install);
  if (r.status === 126 || r.status === 127) {
    return refuse("not-run", `the Install step '${install}' did not run in ${tree} (exit ${r.status}: not executable or not found) — ${REDERIVE}`, install, r.status);
  }
  if (r.status !== 0) return refuse("failed", `install failed in ${tree} (exit ${r.status})`, install, r.status);
  const status = git(tree, ["status", "--porcelain", "-uall"]);
  if (status.error || status.status !== 0) return refuse("status-after", `could not verify the tree state in ${tree} after the Install step`, install, 0);
  if (status.stdout !== "") return refuse("dirtied", `the Install step '${install}' changed the tree in ${tree} (first: ${status.stdout.split("\n")[0]}) — ${REDERIVE}`, install, 0);
  return { install };
}

function restore(tree, apply) {
  try {
    if (!statSync(tree).isDirectory()) die(`--restore ${tree} is not a directory`);
  } catch (e) {
    die(`--restore ${tree} is not a directory: ${e.message}`);
  }
  const mark = evictionMark(tree);
  if (mark.unknown !== undefined) die(`cannot tell whether ${tree} is evicted: ${mark.unknown}`);
  if (!mark.marked) die(`${tree} is not evicted (no ${join(mark.dir, EVICTED)}) — nothing to restore`);
  const done = installIn(tree, apply);
  if (done.refusal) die(done.refusal.message);
  const { install } = done;
  if (apply) {
    // The restore time first: a mark removed with no time beside it would read
    // the tree idle by its HEAD alone and evict it again at once.
    const restored = join(mark.dir, RESTORED);
    try {
      writeFileSync(restored, `${new Date().toISOString()}\n`);
    } catch (e) {
      die(`installed in ${tree}, but could not record the restore in ${restored} (${e.code ?? e.message}) — the mark stays`);
    }
    try {
      unlinkSync(join(mark.dir, EVICTED));
    } catch (e) {
      die(`installed in ${tree} and recorded the restore in ${restored}, but could not remove the mark ${join(mark.dir, EVICTED)} (${e.code ?? e.message}) — the mark stays`);
    }
  }
  writeAll(1, `${JSON.stringify({ applied: apply, worktree: tree, install })}\n`);
}

function main() {
  const { arg, has, sweep: refuseUnknown, stray } = defineFlags(die, {
    flags: { "after-rotate": "bool", apply: "bool", restore: "value" },
  });
  refuseUnknown();
  stray();
  const target = arg("restore");
  const afterRotate = has("after-rotate");
  const apply = has("apply");
  if (target === null) {
    sweep({ afterRotate, apply });
    return;
  }
  if (afterRotate) die("--after-rotate is the sweep's; --restore reads no ledger");
  if (!isAbsolute(target)) die(`--restore must be an absolute path, got ${JSON.stringify(target)}`);
  restore(resolve(target), apply);
}

if (isCLI(import.meta.url)) main();
