// Where a run's `.fleet/` directory lives, answered once for every script
// that keeps a file in it. The ledger, the heartbeat's state, the shortlist,
// the cost guard and the cockpit's state directory are each ONE file per run,
// and they live in the main checkout: a member running from
// `.worktrees/<n>-slug` and the controller running from the checkout root
// have to name the same file, or each worktree quietly reads and writes a
// private copy of it.
//
// The answer is git's: `rev-parse --git-common-dir` names the common git dir
// every worktree of one repository shares, and git-env.mjs's
// workspaceDirFromGitCommonDir() turns that answer into the workspace
// holding it. This module is the spawn around that function — the scrubbed
// env, the bound, the join onto `.fleet/` — so a new `.fleet/`-rooted file is
// one `fleetFile("name")` call rather than another hand-spelled probe.
//
// One error policy: anything that leaves no workspace THROWS
// FleetDirUnresolvable, never a null or an empty path. What a caller does
// about it is the caller's own — the ledger and the heartbeat warn and fall
// back to a cwd-relative `.fleet/`, the shortlist refuses, the cockpit serves
// on its base port — and each says so in its own words around this error's
// message, which names what failed.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

// A `rev-parse` answers in milliseconds; this bound exists so a git that
// never answers cannot hang its caller, not to time a healthy one. A caller
// with an override of its own (ledger.mjs's LEDGER_GIT_TIMEOUT) passes the
// value it settled on as `timeoutMs`.
const DEFAULT_GIT_TIMEOUT_MS = 10_000;

// The cause reaches stderr inside a single warning line, so it is capped,
// keeping the END — the part of a child's stderr that says why it stopped.
const CAUSE_MAX = 500;

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

/**
 * The absolute path of `name` under the run's `.fleet/` directory, resolved
 * from `cwd` — or the `.fleet/` directory itself when `name` is null.
 *
 * GIT_DIR/GIT_WORK_TREE are scrubbed from the probe (gitEnv()): either one
 * makes `--git-common-dir` answer for a DIFFERENT repository, which would put
 * the run's file in someone else's workspace, silently, at exit 0.
 *
 * `canonicalise` is workspaceDirFromGitCommonDir()'s opt-in, passed through:
 * only a caller that keys something on the path (the cockpit's port) takes
 * it. Everyone else prints the path it resolves, and realpath would change
 * that spelling without changing which file it names.
 *
 * Throws FleetDirUnresolvable for every probe that leaves no workspace — no
 * repository, an unreadable `.git`, git missing, a probe killed at
 * `timeoutMs` — with git's own reason in the message.
 */
export function fleetFile(name, { cwd = process.cwd(), timeoutMs, canonicalise = false } = {}) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd, encoding: "utf8", timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, env: gitEnv(),
  });
  // No separate `r.status === 0` gate: every failure mode (no repository, an
  // unresolvable GIT_DIR, a permission-denied `.git`, a corrupt worktree
  // pointer, a missing `git` binary, a timed-out probe) leaves `r.stdout`
  // empty, which workspaceDirFromGitCommonDir() reads as `null` on its own.
  const workspace = workspaceDirFromGitCommonDir(r.stdout, cwd, { canonicalise });
  if (workspace === null) {
    const why = cause(r.error && r.error.message, r.stderr) || ended(r);
    throw new FleetDirUnresolvable(`could not resolve --git-common-dir${why ? `: ${why}` : ""}`);
  }
  return name === null ? join(workspace, ".fleet") : join(workspace, ".fleet", name);
}
