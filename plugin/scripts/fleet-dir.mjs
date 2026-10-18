// Where a run's `.fleet/` directory lives, answered once for every script
// that keeps a file in it. The ledger, the heartbeat's state, the shortlist,
// the cost guard and the cockpit's state directory are each ONE file per run,
// and they live in the main checkout: a member running from
// `.worktrees/<n>-slug` and the controller running from the checkout root
// have to name the same file, or each worktree quietly reads and writes a
// private copy of it.
//
// The answer is git's: `rev-parse --git-common-dir` names the common git dir
// every worktree of one repository shares, and git-env.mjs's resolveWorkspace()
// turns that answer into the workspace it names: the common git dir's parent
// when the common dir is named `.git` or that parent's own `.git` resolves to
// it, otherwise the common git dir itself. This module is the spawn around
// that function — the scrubbed env, the bound, the join onto `.fleet/` — so a
// new `.fleet/`-rooted file is one `fleetFile("name")` call rather than
// another hand-spelled probe.
//
// One error policy: anything that leaves no workspace THROWS
// FleetDirUnresolvable, never a null or an empty path. What a caller does
// about it is the caller's own — the ledger and the heartbeat warn and fall
// back to a cwd-relative `.fleet/`, the shortlist refuses, the cockpit serves
// on its base port — and each says so in its own words around this error's
// message, which names what failed.
//
// The same workspace answer keys the run's scratch root, scratchRoot() below:
// ONE fixed root per repository under the user's home, computed and never
// recorded, so a re-invoked controller and every standalone entry point land
// on the same path. scratch-root.mjs is its CLI.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, WorkspaceProbeFailed, gitEnv, resolveWorkspace } from "./git-env.mjs";

// The cause reaches stderr inside a single warning line, so it is capped,
// keeping the END — the part of a child's stderr that says why it stopped.
const CAUSE_MAX = 500;

// What `git rev-parse --show-toplevel` says (exit 128, under LC_ALL=C) outside
// a work tree: no repository at all, or one with no work tree to name.
const NOT_A_WORK_TREE = /not a git repository|must be run in a work tree/;

export class FleetDirUnresolvable extends Error {
  constructor(message) {
    super(message);
    this.name = "FleetDirUnresolvable";
  }
}

// The first non-empty of the fields a failed git can put its reason in:
// `error.message` for a git that never ran or was killed (`spawnSync git
// ENOENT`, `spawnSync git ETIMEDOUT`), its stderr for one that ran and
// refused (`fatal: not a git repository …`).
function cause(...candidates) {
  const raw = candidates.map((c) => String(c ?? "").trim()).find(Boolean);
  if (!raw) return "";
  return raw.length > CAUSE_MAX ? `…${raw.slice(-(CAUSE_MAX - 1))}` : raw;
}

// A git that fails with nothing on stderr and no spawn error — a silent
// non-zero exit, a kill by a signal other than the bound's own — would
// otherwise leave the message naming no cause at all.
function ended(r) {
  if (r.signal) return `killed by ${r.signal}`;
  return r.status === null ? "" : `exit ${r.status}`;
}

// The probe every `.fleet/` answer and the scratch root share: git's common
// dir, then the workspace it names. Every failure throws FleetDirUnresolvable
// with git's own reason.
function workspaceOf(cwd, timeoutMs, canonicalise) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd, encoding: "utf8", timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, env: gitEnv(),
  });
  // No separate `r.status === 0` gate: every failure mode (no repository, an
  // unresolvable GIT_DIR, a permission-denied `.git`, a corrupt worktree
  // pointer, a missing `git` binary, a timed-out probe) leaves `r.stdout`
  // empty, which resolveWorkspace() reads as `null` on its own.
  let found;
  try {
    found = resolveWorkspace(r.stdout, cwd, { canonicalise, timeoutMs });
  } catch (e) {
    // `--git-common-dir` answered; the rule's own probe is what failed, and
    // its message names that probe.
    if (!(e instanceof WorkspaceProbeFailed)) throw e;
    throw new FleetDirUnresolvable(`could not resolve the workspace: ${e.message}`);
  }
  if (found === null) {
    const why = cause(r.error && r.error.message, r.stderr) || ended(r);
    throw new FleetDirUnresolvable(`could not resolve --git-common-dir${why ? `: ${why}` : ""}`);
  }
  return found;
}

/**
 * The absolute path of `name` under the run's `.fleet/` directory, resolved
 * from `cwd` — or the `.fleet/` directory itself when `name` is null.
 *
 * GIT_DIR/GIT_WORK_TREE are scrubbed from the probe (gitEnv()): either one
 * makes `--git-common-dir` answer for a DIFFERENT repository, which would put
 * the run's file in someone else's workspace, silently, at exit 0.
 *
 * `canonicalise` is git-env.mjs's resolveWorkspace() opt-in, passed through:
 * only a caller that keys something on the path (the cockpit's port) takes
 * it. Everyone else prints the path it resolves, and realpath would change
 * that spelling without changing which file it names.
 *
 * Throws FleetDirUnresolvable for every probe that leaves no workspace — no
 * repository, an unreadable `.git`, git missing, a probe killed at
 * `timeoutMs` — with git's own reason in the message.
 */
export function fleetFile(name, { cwd = process.cwd(), timeoutMs, canonicalise = false } = {}) {
  const { dir } = workspaceOf(cwd, timeoutMs, canonicalise);
  return name === null ? join(dir, ".fleet") : join(dir, ".fleet", name);
}

/**
 * The scratch root of this run's repository: `~/.fleet/scratch/<repo-key>/`,
 * COMPUTED here and never recorded or injected, so a compacted or re-invoked
 * controller derives the same path again and so does any standalone entry
 * point that has no dispatcher to name one.
 *
 * `<repo-key>` is `<basename>-<8 hex>`. `<basename>` is the folder name of the
 * workspace fleetFile() resolves — a checkout's directory, so a linked worktree
 * maps to its main checkout, or a bare repository's or submodule's git dir
 * (a trailing `.git` on that name is dropped) — and the
 * hex is the first 8 characters of the sha256 of that directory's realpath,
 * so two clones that share a name get different roots. Both come from the
 * canonical form, so a symlinked route to one workspace is not a second root.
 *
 * `home` exists for tests; it defaults to the user's home directory. Throws
 * FleetDirUnresolvable exactly as fleetFile() does.
 */
export function scratchRoot({ cwd = process.cwd(), timeoutMs, home = homedir() } = {}) {
  const { dir, gitDir } = workspaceOf(cwd, timeoutMs, true);
  const folder = basename(dir);
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return join(scratchParent(home), `${gitDir ? folder.replace(/\.git$/, "") : folder}-${hex}`);
}

/** The directory every run's scratch root sits directly in: `<home>/.fleet/scratch`. */
export function scratchParent(home = homedir()) {
  return join(home, ".fleet", "scratch");
}

/** The shape of a scratch root's last segment: `<workspace basename>-<8 hex>`. */
export const SCRATCH_KEY_SHAPE = /-[0-9a-f]{8}$/;

function nearestExisting(path) {
  let at = path;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return at;
    at = up;
  }
  return at;
}

/**
 * Why `root` may not be used as a scratch root, or `null` when it may.
 *
 * A root inside a git work tree is refused unless `git check-ignore` says that
 * work tree ignores it: scratch inside a tree that does not ignore it is the
 * write into a repository the scratch discipline exists to prevent (`git add
 * -A` there stages it). The main checkout is held to the same rule: a write
 * into it is refused unless `git check-ignore` says the path is ignored. A root
 * under an OUTER repository whose ignore rules cover it passes — a dotfiles
 * `$HOME` that ignores `.fleet/` is an ordinary setup.
 *
 * Asked before the root exists, from its nearest existing ancestor: refusing
 * must not create a directory inside the repository it refuses. The trailing
 * slash makes a directory-only ignore pattern (`.fleet/`) match a path that is
 * not on disk yet.
 */
export function scratchRootRefusal(root, { timeoutMs } = {}) {
  const cwd = nearestExisting(root);
  // LC_ALL=C: the not-a-work-tree answer below is read off git's own words, so
  // they must not arrive translated.
  const opts = { cwd, encoding: "utf8", timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, env: gitEnv({ LC_ALL: "C" }) };
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], opts);
  // Not in a work tree — no repository, a bare one, the inside of a `.git` —
  // so there is no tree for scratch to dirty. That is git's own answer, read
  // off its stderr: any other failure — a git that never ran, one killed by a
  // signal, one that refused (`detected dubious ownership`) — says nothing
  // about whether a work tree is there, and is refused below rather than read
  // as that answer.
  if (top.status !== 0 && !top.error && NOT_A_WORK_TREE.test(top.stderr)) return null;
  if (top.error || top.status !== 0) {
    return `could not ask git whether ${root} is inside a work tree: ${cause(top.error && top.error.message, top.stderr) || ended(top)}`;
  }
  const tree = top.stdout.trim();
  const ignored = spawnSync("git", ["check-ignore", "-q", `${root}/`], opts);
  if (ignored.status === 0) return null;
  const why = ignored.status === 1 ? "which does not ignore it" : cause(ignored.error && ignored.error.message, ignored.stderr) || ended(ignored);
  return `scratch root ${root} is inside the git work tree ${tree}, ${why} — scratch there would be staged by \`git add -A\``;
}
