#!/usr/bin/env node
// Push `HEAD` to `refs/heads/<branch>` on origin, then move the worktree that
// holds `refs/heads/<branch>` to the pushed SHA.
//
//   push-sync.mjs --branch <branch> [--force-with-lease]
//
// WHY. A member in a `--detach` worktree can only push by refspec, and a
// refspec push moves origin's ref alone: the claim worktree claim-ticket.sh
// made (`worktree add --no-track -b`) still has `refs/heads/<branch>` at the
// old tip, and everything that later reads that local ref reads a head the PR
// no longer has. `git branch -f` refuses a branch a worktree has checked out,
// and `git update-ref` would move the ref while leaving that worktree's index
// and files at the old tip, so this uses neither: it runs
// `git -C <claim worktree> reset --keep <pushed>`, which moves the ref, the
// index and the working tree together, and covers a fast-forward and a
// rebased (non-fast-forward) push alike.
//
// BEFORE THE PUSH it reads origin's head of the branch (`ls-remote`) and the
// local `refs/heads/<branch>`. A failed or timed-out `ls-remote` does not stop
// the push — it only leaves the first ref guard below unmet.
//
// THE PUSH is `git push [--force-with-lease] origin HEAD:refs/heads/<branch>`,
// git's own output passed through on stderr. A failed push — a denied lease
// included — exits with the push's own status, is never retried with
// `--force`, and nothing is synced.
//
// THE SYNC, after a push that landed. The holder is found by parsing
// `git worktree list --porcelain -z` record by record (NUL-delimited, so a
// path holding a newline cannot split a record). The move happens only when
// both guards hold:
//   - the holder is clean: `git status --porcelain` prints nothing, untracked
//     files included;
//   - the local ref read before the push equals origin's head read before the
//     push, or is an ancestor of the pushed SHA. A rebase's force-push
//     replaces exactly the tip origin had, so under this guard no commit that
//     was only local is dropped.
// A guard that fails moves nothing: the refusal names each failed condition
// and says the push itself landed. The clean-tree check is the only
// protection against a member working in the holder at the same moment.
// A holder already at the pushed SHA — the attached claim worktree running
// this itself — has nothing to move and is not checked.
//
// OUTPUT, on stdout, in this order: one `push:` line, then one `sync:` line,
// then one `read-back:` line comparing `refs/heads/<branch>` with the pushed
// SHA. A failed push prints the `push:` line alone.
//
// Exit 0: pushed, and the holder is at the pushed SHA — or no worktree holds
//         the branch (`sync: no worktree holds <branch>`), where the push
//         result stands.
// Exit 2: bad usage, or HEAD names no commit. Nothing was pushed.
// Exit 3: pushed, NOT synced — a guard refused, a git call in the sync failed,
//         or the read-back differs. Origin has the pushed SHA.
// Any other non-zero: the push failed, with git's own exit status.

import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { defineFlags, makeDie, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "push-sync";
const die = makeDie(NAME);
const EXIT_NOT_SYNCED = 3;
// `ls-remote` moves refs, no objects, so it gets a short bound.
const LS_REMOTE_TIMEOUT_MS = 30_000;
const USAGE = "usage: push-sync.mjs --branch <branch> [--force-with-lease]";

const say = (line) => writeAll(1, `${line}\n`);

function git(args, { cwd, timeout, stdio } = {}) {
  return spawnSync("git", args, {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    stdio,
  });
}

const ok = (r) => !r.error && r.status === 0;
const why = (r) => r.error?.message ?? (r.signal ? `killed by ${r.signal}` : (r.stderr ?? "").trim() || `exit ${r.status}`);

/** The commit `ref` names, or null when it names none. */
function commitOf(ref, cwd) {
  const r = git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd });
  return ok(r) ? r.stdout.trim() : null;
}

/**
 * Origin's head of `branch`: `{ok: true, sha}` (`sha` null when origin has no
 * such branch) or `{ok: false, why}`. An exact field match, never ls-remote's
 * pattern, which matches any ref ENDING in it on a `/` boundary.
 */
function remoteHead(branch) {
  const ref = `refs/heads/${branch}`;
  const r = git(["ls-remote", "origin", ref], { timeout: LS_REMOTE_TIMEOUT_MS });
  if (!ok(r)) return { ok: false, why: why(r) };
  for (const line of r.stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if (name === ref) return { ok: true, sha };
  }
  return { ok: true, sha: null };
}

/**
 * The path of the worktree whose record in `listing` — the output of
 * `git worktree list --porcelain -z` — carries `branch refs/heads/<branch>`,
 * or null. Records end with an empty field; a record's first field is its
 * `worktree <path>`.
 */
export function claimHolder(listing, branch) {
  const want = `branch refs/heads/${branch}`;
  let path = null;
  for (const field of listing.split("\0")) {
    if (field === "") path = null;
    else if (path === null && field.startsWith("worktree ")) path = field.slice("worktree ".length);
    else if (field === want && path !== null) return path;
  }
  return null;
}

/** The push's exit status as a shell would report it. */
function pushStatus(r) {
  if (r.status !== null) return r.status;
  const n = r.signal ? osConstants.signals[r.signal] : undefined;
  return n ? 128 + n : 1;
}

function readBack(branch, pushed) {
  const now = commitOf(`refs/heads/${branch}`);
  if (now === null) {
    say(`read-back: refs/heads/${branch} is absent; the pushed SHA is ${pushed}`);
    return false;
  }
  const same = now === pushed;
  say(`read-back: refs/heads/${branch} is ${now} — ${same ? "equals" : "differs from"} the pushed ${pushed}`);
  return same;
}

function refuse(branch, pushed, reasons) {
  for (const [name, text] of reasons) {
    say(`sync: refused (${name}): ${text}; nothing moved — the push itself landed`);
  }
  readBack(branch, pushed);
  process.exit(EXIT_NOT_SYNCED);
}

function main() {
  const flags = defineFlags(die, { flags: { branch: "value", "force-with-lease": "bool" } });
  flags.sweep();
  flags.stray();
  const branch = flags.arg("branch");
  if (branch === null) die(`--branch is required\n${USAGE}`);
  const lease = flags.has("force-with-lease");
  if (!ok(git(["check-ref-format", `refs/heads/${branch}`]))) die(`'${branch}' is not a valid branch name`);

  const pushed = commitOf("HEAD");
  if (pushed === null) die("HEAD names no commit — nothing to push");
  const remoteBefore = remoteHead(branch);
  const localBefore = commitOf(`refs/heads/${branch}`);

  const pushArgs = ["push", ...(lease ? ["--force-with-lease"] : []), "origin", `HEAD:refs/heads/${branch}`];
  writeAll(2, `$ git ${pushArgs.join(" ")}\n`);
  const push = git(pushArgs, { stdio: ["ignore", 2, 2] });
  if (push.error) die(`git push could not run: ${push.error.message}`);
  if (push.status !== 0) {
    const status = pushStatus(push);
    say(`push: failed (exit ${status}); nothing synced, nothing retried`);
    process.exit(status);
  }
  say(`push: landed ${pushed} on origin refs/heads/${branch}`);

  const list = git(["worktree", "list", "--porcelain", "-z"]);
  if (!ok(list)) refuse(branch, pushed, [["worktree-list-failed", `git worktree list failed: ${why(list)}`]]);
  const holder = claimHolder(list.stdout, branch);
  if (holder === null) {
    say(`sync: no worktree holds ${branch}`);
    readBack(branch, pushed);
    process.exit(0);
  }
  if (localBefore === pushed) {
    say(`sync: ${holder} already at ${pushed}`);
    process.exit(readBack(branch, pushed) ? 0 : EXIT_NOT_SYNCED);
  }

  const reasons = [];
  const st = git(["-C", holder, "status", "--porcelain"]);
  if (!ok(st)) reasons.push(["status-unreadable", `git -C ${holder} status failed: ${why(st)}`]);
  else if (st.stdout !== "") reasons.push(["claim-worktree-dirty", `${holder} has uncommitted or untracked changes`]);

  const local = localBefore ?? "(absent)";
  const equalsRemote = remoteBefore.ok && remoteBefore.sha !== null && remoteBefore.sha === localBefore;
  const ancestor = localBefore !== null && git(["merge-base", "--is-ancestor", localBefore, pushed]).status === 0;
  if (!equalsRemote && !ancestor) {
    const remote = !remoteBefore.ok ? `unread: ${remoteBefore.why}` : remoteBefore.sha ?? "absent";
    reasons.push([
      "claim-ref-diverged",
      `refs/heads/${branch} at ${local} neither equals origin's pre-push head (${remote}) nor is an ancestor of the pushed ${pushed}`,
    ]);
  }
  if (reasons.length > 0) refuse(branch, pushed, reasons);

  const reset = git(["-C", holder, "reset", "-q", "--keep", pushed]);
  if (!ok(reset)) refuse(branch, pushed, [["reset-failed", `git -C ${holder} reset --keep ${pushed} failed: ${why(reset)}`]]);
  say(`sync: moved ${holder} from ${local} to ${pushed}`);
  process.exit(readBack(branch, pushed) ? 0 : EXIT_NOT_SYNCED);
}

if (isCLI(import.meta.url)) main();
