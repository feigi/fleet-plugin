// The fleet's member write boundary, enforced (#1411, ADR 0020). An omp
// extension: `plugin/package.json#omp.extensions` names this file, and a
// marketplace install loads it into every omp session on the box — the
// controller's, every member's, and every unrelated session's — rebinding the
// factory below into each subagent session the `task` tool spawns.
//
// THE HAZARD. `write`/`edit`/`ast_edit` resolve a bare relative path against
// the session cwd, and a `task`-dispatched member inherits the controller's:
// the main checkout, never the member's claimed worktree. A member that writes
// `plugin/scripts/foo.mjs` therefore edits the tree every other member and the
// controller read their instruments out of. Prose told members so and they
// kept doing it, so the rule is now a refusal: a `tool_call` handler that
// returns `{block: true, reason}` stops the call before it runs, and the
// member sees the reason as the tool's error.
//
// WHO IS GUARDED — nothing else, because this loads in every session:
//   - any subagent whose definition name starts with `fleet-`;
//   - any subagent spawned BY a fleet member: its `parentId` is the member's
//     task name (`impl-1411`, `fix-pr-88`, `review-pr-2245`, `finisher-pr-7`,
//     with an optional `-b` recovery suffix), while its own definition name is
//     a generic one no prefix check could see.
// A top-level (`kind: "main"`) session is never guarded: that is the
// controller, whose own writes into its checkout are its job.
//
// TWO RULES.
//   - Path writers (`write`, `edit`, `ast_edit`), for everyone guarded: refuse
//     when a target resolves inside the main checkout and `git check-ignore`
//     says it is not ignored. `.worktrees/`, `.fleet/` and `.agent-brain/` are
//     ignored in a fleet repo, so worktrees, run state and agent-brain's cache
//     stay writable, and what is protected is exactly what the main
//     checkout's `git status` would show dirty (#2210 watches the same set).
//   - `bash` cwd, for `fleet-implementer`/`fleet-implementer-alt` only (a
//     fix-applier is dispatched as one): refuse when `input.cwd ?? ctx.cwd`
//     lies inside the main checkout outside `.worktrees/`. Command text is
//     never parsed. Review specialists and refuters are REQUIRED to start from
//     the inherited cwd (`pwd` first, then `cd` inside the command), the
//     finisher runs its audit and `git worktree add` from there, and children
//     follow ad-hoc briefs — so none of them gets this rule.
// Never a rewrite: a refusal names the resolved path and tells the member to
// re-issue it absolute under its worktree. Relative READS and `eval` are not
// guarded here; #2210's detection covers `eval`.
//
// WHEN IT CANNOT DECIDE. A cwd outside any git repository is allowed — there
// is no main checkout to protect. A git that fails while resolving the main
// checkout or answering `check-ignore` BLOCKS, naming the failure: a guard
// that fails open on "could not look" protects nothing. omp fails closed the
// same way on a handler that throws or times out.
//
// `decide()` is the whole policy and touches nothing: the handler resolves the
// main checkout, then hands it and a `check-ignore` probe in. The main
// checkout is the parent of `git rev-parse --git-common-dir` (git-env.mjs's
// `workspaceDirFromGitCommonDir`, as `fleet-tick.mjs` resolves the run's
// workspace) — never `--show-toplevel`, which answers a WORKTREE's root from
// inside one — and every git child gets `gitEnv()`, so an ambient GIT_DIR
// cannot answer for another repository (#1599).
//
// Zero deps: `node --test plugin/scripts/member-write-guard.test.mjs`.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";

/** The task names the controller gives fleet members; a subagent whose parent carries one is a member's child. */
export const MEMBER_TASK_NAME = /^(impl|fix-pr|review-pr|finisher-pr)-\d+(-[a-z])?$/;
const BASH_CWD_AGENTS = new Set(["fleet-implementer", "fleet-implementer-alt"]);
const PATH_WRITERS = new Set(["write", "edit", "ast_edit"]);
const GIT_TIMEOUT_MS = 10_000;
const REISSUE = "Re-issue it with an absolute path under your worktree `.worktrees/<n>-<slug>/`.";

/** Which of the two rules bind `agent`. Never throws: it runs for every tool call in every session. */
export function guardScope(agent) {
  if (!agent || agent.kind !== "sub") return { paths: false, bashCwd: false };
  const name = typeof agent.name === "string" ? agent.name : "";
  const memberChild = typeof agent.parentId === "string" && MEMBER_TASK_NAME.test(agent.parentId);
  return { paths: name.startsWith("fleet-") || memberChild, bashCwd: BASH_CWD_AGENTS.has(name) };
}

/** Whether `decide()` could refuse this call — the handler's cheap gate before it spends a git call. */
export function applies(agent, toolName) {
  const scope = guardScope(agent);
  return toolName === "bash" ? scope.bashCwd : PATH_WRITERS.has(toolName) && scope.paths;
}

// The textual shapes an `edit` payload names its files in. omp adds `path` /
// `paths` to the event from the hashline headers itself; the headers are read
// here too so a payload the host did not normalise is not a silent pass, and
// `MV` destinations and apply_patch-mode headers are read because nothing
// else names them.
function editPayloadPaths(text) {
  const out = [];
  const unquote = (s) => (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s);
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = /^\[(.+)\]$/.exec(line) ?? /^\s*¶+(.+)$/.exec(line);
    if (header) {
      out.push(unquote(header[1].trim().replace(/#[0-9a-fA-F]{4}$/, "")));
      continue;
    }
    const other = /^MV\s+(.+)$/.exec(line) ?? /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line);
    if (other) out.push(unquote(other[1].trim()));
  }
  return out;
}

/** Every raw target path a path-writer call names, as the model wrote it. */
export function targets(toolName, input) {
  const i = input && typeof input === "object" ? input : {};
  const found = [];
  const add = (v) => { if (typeof v === "string" && v.trim() !== "") found.push(v.trim()); };
  const addAll = (v) => { if (Array.isArray(v)) v.forEach(add); };
  if (toolName === "write") add(i.path);
  if (toolName === "edit") {
    add(i.path);
    add(i._path);
    addAll(i.paths);
    for (const key of ["input", "_input"]) if (typeof i[key] === "string") editPayloadPaths(i[key]).forEach(add);
  }
  if (toolName === "ast_edit") addAll(i.paths);
  return [...new Set(found)];
}

// A raw path as omp's own resolver reads it (path-utils.ts `expandPath`): a
// stray `:` or `@` ahead of an absolute or `~` path is dropped, `file://` is a
// path, `~` is home. Any other `scheme://` is an internal URL (`local://`,
// `xd://`, `agent://`) and names no file in any checkout: null. An ast_edit
// glob needs no cutting: its literal spelling lies inside or outside the main
// checkout exactly as the directory it scans from does, and `check-ignore`
// reads it as a plain pathname.
function fsPath(raw, cwd) {
  let p = raw;
  if (/^:(?=[/\\~]|\.\.?[/\\])/.test(p)) p = p.slice(1);
  if (/^@(?=[/~])/.test(p)) p = p.slice(1);
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    return null;
  }
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  return resolve(cwd, p);
}

const within = (root, p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The policy: `undefined` to let the call run, `{block: true, reason}` to
 * refuse it. Pure — every effect is passed in:
 *   - `mainRoot`: the main checkout's absolute path, `null` when `cwd` is in
 *     no git repository (allow), or an `Error` when git could not say (block);
 *   - `isIgnored(absPath)`: resolves true/false from `git check-ignore`, and
 *     rejects when git fails (block);
 *   - `canonical(absPath)`: the symlink-free spelling of a path that may not
 *     exist yet, so `/var/…` and `/private/var/…` compare equal. Identity by
 *     default; the handler passes the real one.
 * `cwd` is the session cwd relative paths resolve against, `path.resolve(cwd, p)`.
 */
export async function decide({ toolName, input, cwd, agent, mainRoot, isIgnored, canonical = (p) => p }) {
  if (!applies(agent, toolName)) return undefined;
  if (mainRoot === null) return undefined;
  if (mainRoot instanceof Error) {
    return { block: true, reason: `member-write-guard: refused ${toolName} — could not resolve the main checkout from ${cwd} (${mainRoot.message}), and a guard that cannot look does not let the call through. ${REISSUE}` };
  }

  if (toolName === "bash") {
    const asked = typeof input?.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : cwd;
    const at = canonical(fsPath(asked, cwd) ?? resolve(cwd, asked));
    if (within(mainRoot, at) && !within(join(mainRoot, ".worktrees"), at)) {
      return { block: true, reason: `member-write-guard: refused bash — its cwd ${at} is inside the main checkout ${mainRoot}, outside \`.worktrees/\`. Re-issue it with \`cwd\` set to the absolute path of your worktree \`.worktrees/<n>-<slug>/\`.` };
    }
    return undefined;
  }

  for (const raw of targets(toolName, input)) {
    const abs = fsPath(raw, cwd);
    if (abs === null) continue;
    const at = canonical(abs);
    if (!within(mainRoot, at)) continue;
    const said = isAbsolute(raw) ? at : `${at} ("${raw}" resolved against the session cwd ${cwd})`;
    let ignored;
    try {
      ignored = await isIgnored(at);
    } catch (e) {
      return { block: true, reason: `member-write-guard: refused ${toolName} to ${said} — could not tell whether it is gitignored (${e?.message ?? e}), and a guard that cannot look does not let the call through. ${REISSUE}` };
    }
    if (!ignored) {
      return { block: true, reason: `member-write-guard: refused ${toolName} to ${said} — it is inside the main checkout ${mainRoot} and not gitignored. ${REISSUE}` };
    }
  }
  return undefined;
}

// ── The effects decide() is handed ──────────────────────────────────────────

// The one git primitive, async so a guarded call never stalls the other
// sessions sharing omp's process. `gitEnv()` drops an ambient GIT_DIR /
// GIT_WORK_TREE (#1599); LC_ALL=C keeps "not a git repository" matchable.
function git(args, cwd) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; done({ stdout, stderr, ...r }); } };
    let child;
    try {
      child = spawn("git", args, { cwd, env: gitEnv({ LC_ALL: "C" }), stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
    } catch (error) {
      finish({ error, status: null });
      return;
    }
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => finish({ error, status: null }));
    child.on("close", (status, signal) => finish({ status, signal }));
  });
}

function failure(r, what) {
  if (r.error) return `${what} did not run: ${r.error.code ?? r.error.message}`;
  const last = r.stderr.trim().split("\n").at(-1);
  return `${what} ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${last ? `: ${last}` : ""}`;
}

/** The main checkout `cwd` belongs to: a path, `null` outside any repository, or an `Error`. */
export async function resolveMainRoot(cwd) {
  const r = await git(["rev-parse", "--git-common-dir"], cwd);
  // Only git's no-repository-anywhere answer is "no main checkout". A gitfile
  // pointing at a missing git dir also says "not a git repository", followed
  // by the dead path rather than "(or any …": that is a broken repo, and blocks.
  if (!r.error && r.status !== 0 && /not a git repository \(or any/i.test(r.stderr)) return null;
  if (r.error || r.status !== 0) return new Error(failure(r, "git rev-parse --git-common-dir"));
  return workspaceDirFromGitCommonDir(r.stdout, cwd, { canonicalise: true })
    ?? new Error("git rev-parse --git-common-dir answered nothing");
}

/** `git check-ignore` from `mainRoot`: true ignored, false not; rejects on anything else. */
export async function checkIgnored(mainRoot, absPath) {
  const r = await git(["check-ignore", "-q", "--", absPath], mainRoot);
  if (!r.error && r.status === 0) return true;
  if (!r.error && r.status === 1) return false;
  throw new Error(failure(r, "git check-ignore"));
}

/** The symlink-free spelling of `p`, whose tail need not exist yet. */
export function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonicalPath(parent), basename(p));
  }
}

/** The extension factory omp calls once per session. */
export default function memberWriteGuard(pi) {
  pi.on("tool_call", async (event, ctx) => {
    const agent = ctx?.agent;
    if (!applies(agent, event?.toolName)) return undefined;
    const cwd = canonicalPath(resolve(ctx?.cwd ?? process.cwd()));
    const mainRoot = await resolveMainRoot(cwd);
    return decide({
      toolName: event.toolName,
      input: event.input,
      cwd,
      agent,
      mainRoot,
      isIgnored: (p) => checkIgnored(mainRoot, p),
      canonical: canonicalPath,
    });
  });
}
