#!/usr/bin/env node
// Main-checkout dirty detection — the backstop behind the
// member-write-guard. The guard refuses a member's `write`/`edit` into the
// main checkout before it runs; it cannot see an `eval` cell (the shared
// kernel's cwd IS the main checkout, and `eval` takes no cwd), `bash` command
// text that `cd`s or `git -C`s there, or bash from a member the cwd rule does
// not cover. This file catches what lands anyway: fleet-tick.mjs runs
// `checkMainCheckout()` on every invocation and, on anything but `clean`,
// holds every dispatching row until the maintainer clears it.
//
// THE BASELINE. Recorded once per run, in Phase 0 beside `instruments.sh
// --pin` (after the fast-forward, before anything reads), at
// `<workspace>/.fleet/main-checkout.sha` — instruments.sh's own
// `.fleet/instruments.sha` precedent. It holds the main checkout's
// `git status --porcelain -uall` entries AND a content hash of every path
// they name, so the maintainer's own uncommitted work at run start is allowed
// (it is in the baseline) while a further edit to one of those files is still
// caught (its hash moves). Any entry that appears, any that disappears, any
// hash that changes: `dirty`. It also holds HEAD: the symbolic ref and the
// commit `B` it names.
//
// HEAD. Reads clean when ALL hold: the symbolic ref equals the baseline's (a
// detached HEAD never does); `B` is HEAD or an ancestor of it; and
// `git rev-list B..HEAD ^origin/main` is empty. So the controller's
// fast-forward to `origin/main` and a commit already unpushed at the baseline
// are clean, while a stray commit, a branch switch, `switch --detach`,
// `reset --hard HEAD~1` and `commit --amend` are dirty. When HEAD equals `B`
// the ancestry calls are skipped. `origin/main` is hardcoded — the ref Phase
// 0 fast-forwards — and read every time: a missing one, an unborn HEAD or any
// failed git read answers `unknown`.
//
// NOT COVERED, BY DESIGN. A faked local `origin/main` (`update-ref`); a branch
// switch and a switch back between two ticks; a stray commit pushed to `main`
// in a repository with no protecting ruleset. This is a backstop for
// accidents, not for adversaries.
//
// THE PROTECTED SET is the non-ignored paths of the main checkout — what the
// member-write-guard protects — and its HEAD. `.fleet/`, `.worktrees/` and
// `.agent-brain/` are gitignored in a fleet repo, so run state, members'
// worktrees and agent-brain's cache never appear in porcelain and never trip
// this.
// Explicit `-uall`, never bare `--porcelain`: `status.showUntrackedFiles=no`
// silences untracked files otherwise.
//
// THE RUN'S OWN BOOKKEEPING IS NOT A STRAY WRITE. Three tracked files in the
// main checkout are written by the controller itself mid-run:
// `docs/metrics/tier-outcomes.tsv`, appended each time it rules a PR's review
// (run-team/SKILL.md, `tier-outcomes.mjs append`),
// `docs/metrics/member-outcomes.tsv`, rewritten by the member-facts scrape, and
// `docs/metrics/ticket-features.tsv`, which `metrics-refresh.mjs` drains the
// pending Pull rows into at phase 0 and again at close-out.
// Compared like any other path, the first append would hold every
// dispatching row for the rest of the run, and clearing it with `--record`
// after every ruling would certify whatever stray write landed beside it.
// So `snapshot()` leaves exactly those three paths out, for the reason
// instruments.sh leaves `docs/metrics/` out of its pin. Three named files, not
// the directory: anything else under `docs/metrics/` is still a stray write.
// The price: a member's leaked write to one of those three files goes unseen.
//
// FOUR ANSWERS, worktree-audit.sh's three plus the baseline's own refusal:
//   clean    — the porcelain entries and hashes equal the baseline's, and HEAD
//              has not moved (see HEAD).
//   dirty    — they do not; `changed` names every path that differs, and a HEAD
//              move as a first entry `HEAD <was> → <now>`, which names `HEAD`,
//              never a path.
//   unknown  — some read failed: git, a hash, HEAD, `origin/main`, or a baseline
//              that EXISTS but cannot be read (unreadable file, unsearchable
//              `.fleet/`, dangling symlink, not written by --record) — or is a
//              v1 baseline, which says nothing of HEAD: re-record it. "A failure
//              is an unknown answer, never a 'no'" — never `clean`.
//   absent   — no baseline at all: the run never recorded one. A refusal
//              ("record at run start"), never `clean`.
//
// RE-BASELINING OVERWRITES, IT DOES NOT COMPARE. `--record` writes
// whatever the tree looks like now — and whatever branch it is on — so it is
// the maintainer's clear only AFTER the stray paths are resolved. Over `unknown`
// it would walk the run from "could not look" to "certified clean" in one step,
// so it refuses on every unknown cause it can see: a baseline that exists but
// cannot be read, and any failed git or hash read (no snapshot, nothing to
// write). A detached HEAD has no symbolic ref to record, so it refuses that
// too. A v1 baseline is the one thing it overwrites without a word.
//
// ROOT. The main checkout is the parent of `git rev-parse --git-common-dir`
// (git-env.mjs's `workspaceDirFromGitCommonDir`, as fleet-tick.mjs resolves
// the shortlist) — never `--show-toplevel`, which answers a WORKTREE's root
// from inside one — and every git child gets `gitEnv()`, so an ambient
// GIT_DIR/GIT_WORK_TREE cannot answer for another repository.
//
// CLI:
//   main-checkout.mjs --record   write the baseline (Phase 0; or the
//                                maintainer's clear once stray paths are
//                                resolved). Exit 0 written, 2 refused.
//   main-checkout.mjs --check    print the state. Exit 0 clean, 1 dirty,
//                                2 unknown or no baseline.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

export const BASELINE_FILE = "main-checkout.sha";
export const RECORD_COMMAND = "~/.fleet/bin/fleet-run main-checkout.mjs --record";
const RUN_BOOKKEEPING = new Set(["docs/metrics/tier-outcomes.tsv", "docs/metrics/member-outcomes.tsv", "docs/metrics/ticket-features.tsv"]);
const HEADER_V1 = "fleet main-checkout baseline v1";
const HEADER = "fleet main-checkout baseline v2";
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const NAME = "main-checkout";
const die = makeDie(NAME);

// The one git primitive. `gitEnv()` drops an ambient GIT_DIR/GIT_WORK_TREE
// and LC_ALL=C keeps a failure's last line readable as git wrote it.
// `what` names the call in a failure, since `why` is printed to the operator.
function git(what, args, cwd, env) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS,
    env: gitEnv({ LC_ALL: "C" }, env),
  });
  if (!r.error && r.status === 0) return { ok: true, stdout: r.stdout };
  if (r.error) return { ok: false, why: `${what} did not run: ${r.error.code ?? r.error.message}`, status: null };
  const last = String(r.stderr ?? "").trim().split("\n").at(-1);
  return { ok: false, why: `${what} ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${last ? `: ${last}` : ""}`, status: r.status };
}

/** The main checkout `cwd` belongs to: `{ok, root}` or `{ok: false, why}`. */
export function resolveMainCheckout(cwd = process.cwd(), env = process.env) {
  const r = git("git rev-parse --git-common-dir", ["rev-parse", "--git-common-dir"], cwd, env);
  if (!r.ok) return r;
  const root = workspaceDirFromGitCommonDir(r.stdout, cwd);
  return root === null ? { ok: false, why: "git rev-parse --git-common-dir answered nothing" } : { ok: true, root };
}

export const baselinePath = (root) => join(root, ".fleet", BASELINE_FILE);

// A content hash of one path porcelain named, relative to `root`. Gone is an
// answer (a deleted tracked file is a ` D` entry); anything else that fails
// to read throws, and the caller's answer is `unknown`. A directory holding
// `.git` is a nested repository (an untracked one is listed as `dir/`, a
// submodule by its own path), hashed as `nestedHash` below; any other
// directory hashes as `dir`.
function hashPath(root, rel, env) {
  const abs = join(root, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return "absent";
    throw e;
  }
  if (st.isSymbolicLink()) return `link:${sha(readlinkSync(abs))}`;
  if (st.isDirectory()) {
    try {
      lstatSync(join(abs, ".git"));
    } catch (e) {
      if (e?.code === "ENOENT") return "dir";
      throw e;
    }
    return nestedHash(abs, env);
  }
  if (st.isFile()) return `sha256:${sha(readFileSync(abs))}`;
  return "other";
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// A nested repository's own snapshot — its porcelain entries and the hash of
// every path they name, so a further edit to a file already dirty in it moves
// the hash where its status line would not — folded with its HEAD, so a
// commit in it moves the hash too. A commitless repository's HEAD is the
// branch it names. Nothing is left out: the run's bookkeeping is the main
// checkout's two paths, not a nested repository's. Any git that fails
// throws: `unknown`, never a hash that reads clean.
function nestedHash(abs, env) {
  const now = entriesAt(abs, env, new Set());
  if (!now.ok) throw new Error(now.why);
  let head = git("git rev-parse HEAD", ["rev-parse", "-q", "--verify", "HEAD^{commit}"], abs, env);
  if (!head.ok) head = git("git symbolic-ref HEAD", ["symbolic-ref", "-q", "HEAD"], abs, env);
  if (!head.ok) throw new Error(head.why);
  return `repo:${sha(`${head.stdout}${formatEntries(now.entries)}`)}`;
}

/**
 * The main checkout as it stands: `{ok, entries}` — a Map from each porcelain
 * entry (`XY path`) to its path's hash, the run's own bookkeeping left out
 * (header) — or `{ok: false, why}`.
 * `--no-optional-locks` so a read never takes the main index's lock out from
 * under the controller's own git; `-z` so no path is quoted or split;
 * `--no-renames` so every entry names exactly one path.
 */
export function snapshot(root, env = process.env) {
  return entriesAt(root, env, RUN_BOOKKEEPING);
}

// `snapshot` of the repository at `root`, leaving out the paths in `skip`.
function entriesAt(root, env, skip) {
  const r = git("git status --porcelain -uall", ["--no-optional-locks", "status", "--porcelain", "-uall", "-z", "--no-renames"], root, env);
  if (!r.ok) return r;
  const entries = new Map();
  for (const line of r.stdout.split("\0")) {
    if (!line) continue;
    if (line.length < 4 || line[2] !== " ") return { ok: false, why: `git status printed an entry it does not document: ${JSON.stringify(line)}` };
    const rel = line.slice(3);
    if (skip.has(rel)) continue;
    try {
      entries.set(line, hashPath(root, rel, env));
    } catch (e) {
      return { ok: false, why: `cannot hash ${rel}: ${e?.code ?? e?.message ?? e}` };
    }
  }
  return { ok: true, entries };
}

// `ref` and `oid` lines name HEAD; the entries follow, one `hash<TAB>"line"` each.
export function formatBaseline(entries, head) {
  return `${HEADER}\nref ${head.ref}\noid ${head.oid}\n${formatEntries(entries)}`;
}

function formatEntries(entries) {
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([line, hash]) => `${hash}\t${JSON.stringify(line)}\n`).join("");
}

/**
 * The main checkout's HEAD: `{ok, ref, oid}` — `ref` is the symbolic ref, or
 * null for a detached HEAD — or `{ok: false, why}`. An unborn HEAD has no
 * commit to name, so it fails: `rev-parse -q --verify HEAD^{commit}`, because
 * a bare `rev-parse HEAD` prints the word `HEAD` there.
 */
function readHead(root, env) {
  const sym = git("git symbolic-ref -q HEAD", ["symbolic-ref", "-q", "HEAD"], root, env);
  // `-q` makes a detached HEAD exit 1 without a word; any other failure is a failure.
  if (!sym.ok && sym.status !== 1) return sym;
  const oid = git("git rev-parse --verify HEAD^{commit}", ["rev-parse", "-q", "--verify", "HEAD^{commit}"], root, env);
  if (!oid.ok) return { ok: false, why: `${oid.why} — HEAD is unborn or unreadable` };
  return { ok: true, ref: sym.ok ? sym.stdout.trim() : null, oid: oid.stdout.trim() };
}

/** The tree (`snapshot`) and HEAD together: `{ok, entries, head}` or `{ok: false, why}`. */
function readState(root, env) {
  const now = snapshot(root, env);
  if (!now.ok) return now;
  const head = readHead(root, env);
  return head.ok ? { ok: true, entries: now.entries, head } : head;
}

const headLabel = ({ ref, oid }) => `${ref ?? "(detached)"}@${oid.slice(0, 7)}`;

/**
 * Did HEAD move off the baseline's? `{ok, change}`: `change` is null, or the
 * `HEAD <was> → <now>` entry; `{ok: false, why}` when a read failed.
 * Clean is all of: the same symbolic ref; the baseline's commit an ancestor of
 * HEAD or equal to it; no commit in `B..HEAD` that `origin/main` lacks. So a
 * fast-forward to `origin/main` and a commit already unpushed at the baseline
 * read clean, while a stray commit, a reset or an amend do not. `origin/main`
 * is read even when HEAD equals the baseline: a checkout that cannot name it
 * is one this cannot vouch for.
 */
function headMove(root, env, was, now) {
  const origin = git("git rev-parse --verify refs/remotes/origin/main", ["rev-parse", "-q", "--verify", "refs/remotes/origin/main^{commit}"], root, env);
  if (!origin.ok) return { ok: false, why: `origin/main is missing or unreadable (${origin.why})` };
  const moved = { ok: true, change: `HEAD ${headLabel(was)} → ${headLabel(now)}` };
  if (now.ref !== was.ref) return moved;
  if (now.oid === was.oid) return { ok: true, change: null };
  const ancestor = git("git merge-base --is-ancestor", ["merge-base", "--is-ancestor", was.oid, now.oid], root, env);
  if (!ancestor.ok) return ancestor.status === 1 ? moved : ancestor;
  const stray = git("git rev-list", ["rev-list", "--max-count=1", `${was.oid}..${now.oid}`, "^refs/remotes/origin/main"], root, env);
  if (!stray.ok) return stray;
  return stray.stdout.trim() === "" ? { ok: true, change: null } : moved;
}

/**
 * The run's baseline: `{status: "ok", entries, head}`, `{status: "absent"}`,
 * `{status: "outdated", why}` (a v1 file) or `{status: "unreadable", why}`.
 * ABSENT is only "nothing at that name": a
 * dangling symlink is present-but-broken, and an unsearchable `.fleet/`
 * answers EACCES rather than ENOENT, so neither can fall through to
 * "no baseline" (a mislabel this once made) — both are `unreadable`.
 */
export function readBaseline(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") {
      try {
        lstatSync(path);
        return { status: "unreadable", why: `${path} is a dangling symlink` };
      } catch (l) {
        if (l?.code === "ENOENT") return { status: "absent" };
        return { status: "unreadable", why: `${path}: ${l?.code ?? l?.message}` };
      }
    }
    return { status: "unreadable", why: `${path} exists but cannot be read: ${e?.code ?? e?.message}` };
  }
  const lines = text.split("\n");
  if (lines[0] === HEADER_V1) return { status: "outdated", why: "baseline v1 — re-record" };
  const ref = lines[1]?.startsWith("ref ") ? lines[1].slice(4) : "";
  const oid = lines[2]?.startsWith("oid ") ? lines[2].slice(4) : "";
  if (lines[0] !== HEADER || lines.at(-1) !== "" || !ref || !/^[0-9a-f]{40,64}$/.test(oid)) {
    return { status: "unreadable", why: `${path} is not a baseline main-checkout.mjs --record wrote` };
  }
  const entries = new Map();
  for (const l of lines.slice(3, -1)) {
    const tab = l.indexOf("\t");
    let line;
    try { line = tab > 0 ? JSON.parse(l.slice(tab + 1)) : null; } catch { line = null; }
    if (typeof line !== "string") return { status: "unreadable", why: `${path} carries a line --record never writes: ${JSON.stringify(l)}` };
    entries.set(line, l.slice(0, tab));
  }
  return { status: "ok", entries, head: { ref, oid } };
}

/** Every path whose entry appeared, disappeared or changed hash, sorted. */
export function changedPaths(baseline, current) {
  const paths = new Set();
  for (const [line, hash] of current) if (baseline.get(line) !== hash) paths.add(line.slice(3));
  for (const line of baseline.keys()) if (!current.has(line)) paths.add(line.slice(3));
  return [...paths].sort();
}

/**
 * The tick's question: `{state, root?, baseline?, changed?, headMove?, why?, cause?}`.
 * `cause` tells the three unknowns apart — `"baseline"` (it exists but cannot
 * be read), `"outdated"` (a v1 baseline: it says nothing of HEAD, so it can
 * answer nothing) and `"read"` (git or a hash failed) — since each has its own
 * message. The baseline is read before the tree, because without one there
 * is nothing to compare against and no reason to look.
 * A HEAD move is the first entry of `changed`, also named in `headMove`.
 */
export function checkMainCheckout({ cwd = process.cwd(), env = process.env } = {}) {
  const where = resolveMainCheckout(cwd, env);
  if (!where.ok) return { state: "unknown", cause: "read", why: where.why };
  const { root } = where;
  const path = baselinePath(root);
  const base = readBaseline(path);
  if (base.status === "absent") return { state: "absent", root, baseline: path };
  if (base.status === "unreadable") return { state: "unknown", cause: "baseline", root, baseline: path, why: base.why };
  if (base.status === "outdated") return { state: "unknown", cause: "outdated", root, baseline: path, why: base.why };
  const unknown = (why) => ({ state: "unknown", cause: "read", root, baseline: path, why });
  const now = readState(root, env);
  if (!now.ok) return unknown(now.why);
  const move = headMove(root, env, base.head, now.head);
  if (!move.ok) return unknown(move.why);
  const changed = changedPaths(base.entries, now.entries);
  if (move.change !== null) changed.unshift(move.change);
  if (!changed.length) return { state: "clean", root, baseline: path };
  return move.change === null
    ? { state: "dirty", root, baseline: path, changed }
    : { state: "dirty", root, baseline: path, changed, headMove: move.change };
}

// A path printed on one line: anything that would split or blur it is quoted.
const shown = (p) => (/[\s"\\\x00-\x1f\x7f]/.test(p) ? JSON.stringify(p) : p);

/**
 * The one line the tick prints for a check that is not `clean`, or null.
 * `live` names the run's live members: concurrent members make a change
 * impossible to attribute to one of them, so the line names them all and
 * attributes nothing. `null` (the `--check` CLI, which reads no ledger)
 * leaves them out.
 */
export function describe(check, live = null) {
  const members = live === null ? "" : `; live members: ${live.length ? live.join(" ") : "none"}`;
  switch (check.state) {
    case "clean":
      return null;
    case "dirty":
      // The HEAD entry is text, not a path: quoting it would blur it.
      return `MAIN-CHECKOUT-DIRTY ${check.changed.map((p) => (p === check.headMove ? p : shown(p))).join(" ")} — changed since the run's baseline${members}`
        + ` — dispatch held: resolve the stray paths FIRST, then re-baseline with ${RECORD_COMMAND} (it overwrites, it does not compare)`;
    case "absent":
      return `MAIN-CHECKOUT-NO-BASELINE no baseline at ${check.baseline} — dispatch held: record it at run start with ${RECORD_COMMAND}`;
    default:
      if (check.cause === "outdated") {
        return `MAIN-CHECKOUT-UNKNOWN ${check.why}${members}`
          + ` — dispatch held: resolve any stray paths FIRST, then re-record with ${RECORD_COMMAND} (it overwrites, it does not compare)`;
      }
      return check.cause === "baseline"
        ? `MAIN-CHECKOUT-UNKNOWN baseline unreadable: ${check.why}${members}`
          + " — dispatch held: fix the baseline so it can be read; NEVER re-baseline over it, --record overwrites rather than compares"
        : `MAIN-CHECKOUT-UNKNOWN could not look: ${check.why}${members}`
          + " — dispatch held: fix the failure and tick again; NEVER re-baseline over it, --record overwrites rather than compares";
  }
}

/**
 * Write the baseline: `{ok, path, entries, head}` or `{ok: false, why}`.
 * Refuses over a baseline that exists but cannot be read — overwriting it
 * blind discards evidence nobody read — and on any failed read of the tree or
 * of HEAD, and on a detached HEAD, which has no symbolic ref to record. A v1
 * baseline is not unreadable: it is the one this overwrites.
 * Written to a temporary name and renamed, so a reader never sees half of it.
 */
export function recordBaseline({ cwd = process.cwd(), env = process.env } = {}) {
  const where = resolveMainCheckout(cwd, env);
  if (!where.ok) return { ok: false, why: `${where.why} — cannot find the main checkout` };
  const path = baselinePath(where.root);
  const prior = readBaseline(path);
  if (prior.status === "unreadable") {
    return { ok: false, why: `${prior.why} — fix it first; do NOT --record over it, --record overwrites rather than compares` };
  }
  const now = readState(where.root, env);
  if (!now.ok) return { ok: false, why: `${now.why} — could not look, so there is nothing to record` };
  if (now.head.ref === null) {
    return { ok: false, why: "HEAD is detached, so there is no symbolic ref to record — switch to the run's branch first" };
  }
  try {
    mkdirSync(join(where.root, ".fleet"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, formatBaseline(now.entries, now.head));
    renameSync(tmp, path);
  } catch (e) {
    return { ok: false, why: `cannot write ${path}: ${e?.code ?? e?.message}` };
  }
  return { ok: true, path, entries: now.entries.size, head: now.head };
}

function main() {
  // sweep()/stray() first, so an unknown flag or a stray positional is
  // refused in arg.mjs's one wording before the usage guard can answer.
  const { has, sweep, stray } = defineFlags(die, { flags: { record: "bool", check: "bool" } });
  sweep();
  stray();
  const record = has("record");
  if (record === has("check")) die("usage: main-checkout.mjs --record | --check");
  if (record) {
    const r = recordBaseline();
    if (!r.ok) die(r.why);
    console.log(`main-checkout: recorded ${r.entries} porcelain entr${r.entries === 1 ? "y" : "ies"} at ${r.path}; HEAD ${headLabel(r.head)}`);
    return;
  }
  const c = checkMainCheckout();
  if (c.state === "clean") {
    console.log(`main-checkout: clean against ${c.baseline}`);
    return;
  }
  console.log(describe(c));
  process.exitCode = c.state === "dirty" ? 1 : 2;
}

if (isCLI(import.meta.url)) main();
