#!/usr/bin/env node
// Main-checkout dirty detection (#2210) — the backstop behind #1411's
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
// hash that changes: `dirty`.
//
// THE PROTECTED SET is exactly the non-ignored paths of the main checkout —
// what #1411's guard protects. `.fleet/`, `.worktrees/` and `.agent-brain/`
// are gitignored in a fleet repo, so run state, members' worktrees and
// agent-brain's cache never appear in porcelain and never trip this.
// Explicit `-uall`, never bare `--porcelain`: `status.showUntrackedFiles=no`
// silences untracked files otherwise (#730).
//
// FOUR ANSWERS, worktree-audit.sh's three plus the baseline's own refusal:
//   clean    — the porcelain entries and hashes equal the baseline's.
//   dirty    — they do not; `changed` names every path that differs.
//   unknown  — some read failed: git, a hash, or a baseline that EXISTS but
//              cannot be read (unreadable file, unsearchable `.fleet/`,
//              dangling symlink, not written by --record). "A failure is an
//              unknown answer, never a 'no'" — never `clean`.
//   absent   — no baseline at all: the run never recorded one. A refusal
//              ("record at run start"), never `clean`.
//
// RE-BASELINING OVERWRITES, IT DOES NOT COMPARE (#1058). `--record` writes
// whatever the tree looks like now, so it is the maintainer's clear only
// AFTER the stray paths are resolved. Over `unknown` it would walk the run
// from "could not look" to "certified clean" in one step, so it refuses on
// every unknown cause it can see: a baseline that exists but cannot be read,
// and any failed git or hash read (no snapshot, nothing to write).
//
// ROOT. The main checkout is the parent of `git rev-parse --git-common-dir`
// (git-env.mjs's `workspaceDirFromGitCommonDir`, as fleet-tick.mjs resolves
// the shortlist) — never `--show-toplevel`, which answers a WORKTREE's root
// from inside one — and every git child gets `gitEnv()`, so an ambient
// GIT_DIR/GIT_WORK_TREE cannot answer for another repository (#1599).
//
// CLI:
//   main-checkout.mjs --record   write the baseline (Phase 0; or the
//                                maintainer's clear once stray paths are
//                                resolved). Exit 0 written, 2 refused.
//   main-checkout.mjs --check    print the state. Exit 0 clean, 1 dirty,
//                                2 unknown or no baseline.
//
// Zero deps: `node --test plugin/scripts/main-checkout.test.mjs`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeDie } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

export const BASELINE_FILE = "main-checkout.sha";
export const RECORD_COMMAND = "~/.fleet/bin/fleet-run main-checkout.mjs --record";
const HEADER = "fleet main-checkout baseline v1";
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const NAME = "main-checkout";
const die = makeDie(NAME);

// The one git primitive. `gitEnv()` drops an ambient GIT_DIR/GIT_WORK_TREE
// (#1599); LC_ALL=C keeps a failure's last line readable as git wrote it.
// `what` names the call in a failure, since `why` is printed to the operator.
function git(what, args, cwd, env) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS,
    env: gitEnv({ LC_ALL: "C" }, env),
  });
  if (!r.error && r.status === 0) return { ok: true, stdout: r.stdout };
  if (r.error) return { ok: false, why: `${what} did not run: ${r.error.code ?? r.error.message}` };
  const last = String(r.stderr ?? "").trim().split("\n").at(-1);
  return { ok: false, why: `${what} ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${last ? `: ${last}` : ""}` };
}

/** The main checkout `cwd` belongs to: `{ok, root}` or `{ok: false, why}`. */
export function resolveMainCheckout(cwd = process.cwd(), env = process.env) {
  const r = git("git rev-parse --git-common-dir", ["rev-parse", "--git-common-dir"], cwd, env);
  if (!r.ok) return r;
  const root = workspaceDirFromGitCommonDir(r.stdout, cwd);
  return root === null ? { ok: false, why: "git rev-parse --git-common-dir answered nothing" } : { ok: true, root };
}

export const baselinePath = (root) => join(root, ".fleet", BASELINE_FILE);

// A content hash of one path porcelain named, relative to the main checkout.
// Gone is an answer (a deleted tracked file is a ` D` entry), and so is a
// directory (an untracked nested repository is listed as `dir/`); anything
// else that fails to read throws, and the caller's answer is `unknown`.
function hashPath(root, rel) {
  const abs = join(root, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return "absent";
    throw e;
  }
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  if (st.isSymbolicLink()) return `link:${sha(readlinkSync(abs))}`;
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return `sha256:${sha(readFileSync(abs))}`;
  return "other";
}

/**
 * The main checkout as it stands: `{ok, entries}` — a Map from each porcelain
 * entry (`XY path`) to its path's hash — or `{ok: false, why}`.
 * `--no-optional-locks` so a read never takes the main index's lock out from
 * under the controller's own git; `-z` so no path is quoted or split;
 * `--no-renames` so every entry names exactly one path.
 */
export function snapshot(root, env = process.env) {
  const r = git("git status --porcelain -uall", ["--no-optional-locks", "status", "--porcelain", "-uall", "-z", "--no-renames"], root, env);
  if (!r.ok) return r;
  const entries = new Map();
  for (const line of r.stdout.split("\0")) {
    if (!line) continue;
    if (line.length < 4 || line[2] !== " ") return { ok: false, why: `git status printed an entry it does not document: ${JSON.stringify(line)}` };
    try {
      entries.set(line, hashPath(root, line.slice(3)));
    } catch (e) {
      return { ok: false, why: `cannot hash ${line.slice(3)}: ${e?.code ?? e?.message ?? e}` };
    }
  }
  return { ok: true, entries };
}

export function formatBaseline(entries) {
  const body = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([line, hash]) => `${hash}\t${JSON.stringify(line)}\n`).join("");
  return `${HEADER}\n${body}`;
}

/**
 * The run's baseline: `{status: "ok", entries}`, `{status: "absent"}`, or
 * `{status: "unreadable", why}`. ABSENT is only "nothing at that name": a
 * dangling symlink is present-but-broken, and an unsearchable `.fleet/`
 * answers EACCES rather than ENOENT, so neither can fall through to
 * "no baseline" (#1058's mislabel) — both are `unreadable`.
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
  if (lines[0] !== HEADER || lines.at(-1) !== "") {
    return { status: "unreadable", why: `${path} is not a baseline main-checkout.mjs --record wrote` };
  }
  const entries = new Map();
  for (const l of lines.slice(1, -1)) {
    const tab = l.indexOf("\t");
    let line;
    try { line = tab > 0 ? JSON.parse(l.slice(tab + 1)) : null; } catch { line = null; }
    if (typeof line !== "string") return { status: "unreadable", why: `${path} carries a line --record never writes: ${JSON.stringify(l)}` };
    entries.set(line, l.slice(0, tab));
  }
  return { status: "ok", entries };
}

/** Every path whose entry appeared, disappeared or changed hash, sorted. */
export function changedPaths(baseline, current) {
  const paths = new Set();
  for (const [line, hash] of current) if (baseline.get(line) !== hash) paths.add(line.slice(3));
  for (const line of baseline.keys()) if (!current.has(line)) paths.add(line.slice(3));
  return [...paths].sort();
}

/**
 * The tick's question: `{state, root?, baseline?, changed?, why?, cause?}`.
 * `cause` tells the two unknowns apart — `"baseline"` (it exists but cannot
 * be read) from `"read"` (git or a hash failed) — since each has its own
 * message. The baseline is read before the tree, because without one there
 * is nothing to compare against and no reason to look.
 */
export function checkMainCheckout({ cwd = process.cwd(), env = process.env } = {}) {
  const where = resolveMainCheckout(cwd, env);
  if (!where.ok) return { state: "unknown", cause: "read", why: where.why };
  const { root } = where;
  const path = baselinePath(root);
  const base = readBaseline(path);
  if (base.status === "absent") return { state: "absent", root, baseline: path };
  if (base.status === "unreadable") return { state: "unknown", cause: "baseline", root, baseline: path, why: base.why };
  const now = snapshot(root, env);
  if (!now.ok) return { state: "unknown", cause: "read", root, baseline: path, why: now.why };
  const changed = changedPaths(base.entries, now.entries);
  return changed.length ? { state: "dirty", root, baseline: path, changed } : { state: "clean", root, baseline: path };
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
      return `MAIN-CHECKOUT-DIRTY ${check.changed.map(shown).join(" ")} — changed since the run's baseline${members}`
        + ` — dispatch held: resolve the stray paths FIRST, then re-baseline with ${RECORD_COMMAND} (it overwrites, it does not compare)`;
    case "absent":
      return `MAIN-CHECKOUT-NO-BASELINE no baseline at ${check.baseline} — dispatch held: record it at run start with ${RECORD_COMMAND}`;
    default:
      return check.cause === "baseline"
        ? `MAIN-CHECKOUT-UNKNOWN baseline unreadable: ${check.why}${members}`
          + " — dispatch held: fix the baseline so it can be read; NEVER re-baseline over it, --record overwrites rather than compares"
        : `MAIN-CHECKOUT-UNKNOWN could not look: ${check.why}${members}`
          + " — dispatch held: fix the failure and tick again; NEVER re-baseline over it, --record overwrites rather than compares";
  }
}

/**
 * Write the baseline: `{ok, path, entries}` or `{ok: false, why}`. Refuses
 * over a baseline that exists but cannot be read — overwriting it blind
 * discards evidence nobody read (#1058) — and on any failed read of the tree.
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
  const now = snapshot(where.root, env);
  if (!now.ok) return { ok: false, why: `${now.why} — could not look, so there is nothing to record` };
  try {
    mkdirSync(join(where.root, ".fleet"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, formatBaseline(now.entries));
    renameSync(tmp, path);
  } catch (e) {
    return { ok: false, why: `cannot write ${path}: ${e?.code ?? e?.message}` };
  }
  return { ok: true, path, entries: now.entries.size };
}

function main() {
  const [flag, ...rest] = process.argv.slice(2);
  if (rest.length || (flag !== "--record" && flag !== "--check")) die("usage: main-checkout.mjs --record | --check");
  if (flag === "--record") {
    const r = recordBaseline();
    if (!r.ok) die(r.why);
    console.log(`main-checkout: recorded ${r.entries} porcelain entr${r.entries === 1 ? "y" : "ies"} at ${r.path}`);
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

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
