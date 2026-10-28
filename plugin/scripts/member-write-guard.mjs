// The fleet's member write boundary, enforced. An omp
// extension: `plugin/package.json#omp.extensions` names this file, and a
// native install (link/npm; a marketplace cache install loads it
// the same way) loads it into every omp session on the box — the
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
//   - any subagent whose own id is a fleet member's task name (`impl-1411`,
//     `fix-pr-88`, `review-pr-2245`, `finisher-pr-7`, with an optional `-b`
//     recovery suffix): a member named by id is caught whatever definition
//     name its dispatch gave it;
//   - any subagent spawned BY a fleet member: its `parentId` is the member's
//     task name, while its own definition name is a generic one no prefix
//     check could see.
// A top-level (`kind: "main"`) session is never guarded: that is the
// controller, whose own writes into its checkout are its job.
//
// THREE RULES.
//   - Path writers (`write`, `edit`, `ast_edit`), for everyone guarded: refuse
//     when a target resolves inside the main checkout and `git check-ignore`
//     says it is not ignored. `.worktrees/`, `.fleet/` and `.agent-brain/` are
//     ignored in a fleet repo, so worktrees, run state and agent-brain's cache
//     stay writable, and what is protected is exactly what the main
//     checkout's `git status` would show dirty (main-checkout.mjs watches the
//     same set, and the checkout's HEAD besides).
//   - The Install root, for the same path writers and the same agents: refuse
//     when a target resolves inside the live Install root — the realpath of
//     `~/.omp/plugins/node_modules/@feigi/fleet-ctl`, the installed plugin
//     fleet-run executes scripts from and omp loads the runbooks from — the
//     root itself included. No gitignore exemption: nothing under it is a
//     member's to write. It holds whichever repository the session runs in,
//     or none, and for every install kind; under a linked checkout the
//     Install root is that checkout's `plugin/`.
//   - `bash` cwd, for every `fleet-implementer-<cell>` (ledger-grammar.mjs's
//     `CELL_DEF`), and for a fix-applier's own id (`fix-pr-<n>`) directly,
//     since its definition, `fleet-fix-applier`, is no implementer cell and
//     `CELL_DEF` does not match it: refuse when
//     `input.cwd ?? ctx.cwd` lies inside the main checkout outside
//     `.worktrees/`. Command text is never parsed. Review specialists and
//     refuters are REQUIRED to start from the inherited cwd (`pwd` first,
//     then `cd` inside the command), the finisher runs its audit and
//     `git worktree add` from there, and children follow ad-hoc briefs — so
//     none of them gets this rule.
// Never a rewrite: a refusal names the resolved path and tells the member to
// re-issue it absolute under its worktree. Relative READS and `eval` are not
// guarded here; main-checkout.mjs's dirty detection covers `eval`. A `bash` or
// `eval` write into the Install root lands, by design: the `bash` cwd rule is
// the main checkout's only, since members read from the Install root with a
// `cwd` there, and instruments.sh's re-check is what detects such a write.
//
// WHEN IT CANNOT DECIDE. A cwd outside any git repository is allowed by the
// main-checkout rules — there is no main checkout to protect. No package entry
// at all turns the Install-root rule off. A git that fails while resolving
// the main checkout or answering `check-ignore`, and a package entry that
// exists but does not resolve (a dangling link, any other lstat or realpath
// error), BLOCK, naming the failure: a guard that fails open on "could not
// look" protects nothing. omp fails closed the same way on a handler that
// throws or times out.
//
// `decide()` is the whole policy and touches nothing: the handler resolves the
// main checkout and, for a path writer, the Install root, then hands them and
// a `check-ignore` probe in. The Install root is resolved on every such call,
// so a relink or reinstall mid-run is followed. The main
// checkout is the parent of `git rev-parse --git-common-dir` (git-env.mjs's
// `mainCheckoutDirFromGitCommonDir`) — the work tree, which a symlinked `.git`
// does not move, never git-env.mjs's store rule — and never `--show-toplevel`,
// which answers a WORKTREE's root from inside one. Every git child gets
// `gitEnv()`, so an ambient GIT_DIR cannot answer for another repository.
//
// Zero deps: node builtins and sibling scripts only.

import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv, mainCheckoutDirFromGitCommonDir } from "./git-env.mjs";
import { CELL_DEF } from "./ledger-grammar.mjs";

/** The task names the controller gives fleet members; a subagent whose parent carries one is a member's child, and a member whose own id matches this is caught directly, whatever definition name its dispatch gave it. */
const MEMBER_TASK_NAME = /^(impl|fix-pr|review-pr|finisher-pr)-\d+(-[a-z])?$/;
const FIX_APPLIER_ID = /^fix-pr-\d+(-[a-z])?$/;
const PATH_WRITERS = new Set(["write", "edit", "ast_edit"]);
const GIT_TIMEOUT_MS = 10_000;
const REISSUE = "Re-issue it with an absolute path under your worktree `.worktrees/<n>-<slug>/`.";
/** omp's package entry for this plugin, under the home directory: its realpath is the Install root. */
const INSTALL_ENTRY = [".omp", "plugins", "node_modules", "@feigi", "fleet-ctl"];

/** Whether `decide()` could refuse this call — the handler's cheap gate before it spends a git call. Never throws: it runs for every tool call in every session. */
function applies(agent, toolName) {
  if (agent?.kind !== "sub") return false;
  const name = typeof agent.name === "string" ? agent.name : "";
  const id = typeof agent.id === "string" ? agent.id : "";
  if (toolName === "bash") return CELL_DEF.test(name) || FIX_APPLIER_ID.test(id);
  return PATH_WRITERS.has(toolName)
    && (name.startsWith("fleet-") || MEMBER_TASK_NAME.test(id)
      || (typeof agent.parentId === "string" && MEMBER_TASK_NAME.test(agent.parentId)));
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
function targets(toolName, input) {
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

/** A refusal for a root `decide()` was handed as neither a usable path nor the "no root" null. */
function unusable(toolName, what, root) {
  if (root instanceof Error) {
    return { block: true, reason: `member-write-guard: refused ${toolName} — could not resolve ${what} (${root.message}), and a guard that cannot look does not let the call through. ${REISSUE}` };
  }
  if (typeof root !== "string" || root === "") {
    return { block: true, reason: `member-write-guard: refused ${toolName} — ${what} resolved to an unusable value, and a guard that cannot look does not let the call through. ${REISSUE}` };
  }
  return undefined;
}

/**
 * The policy: `undefined` to let the call run, `{block: true, reason}` to
 * refuse it. Pure — every effect is passed in:
 *   - `mainRoot`: the main checkout's absolute path, `null` when `cwd` is in
 *     no git repository (the main-checkout rule is off), or an `Error` when
 *     git could not say (block);
 *   - `installRoot`: the Install root's realpath, `null` when there is no
 *     package entry (the Install-root rule is off), or an `Error` naming the
 *     entry when it exists but does not resolve (block). Read for path
 *     writers only;
 *   - `isIgnored(absPath)`: resolves true/false from `git check-ignore`, and
 *     rejects when git fails (block);
 *   - `canonical(absPath)`: the symlink-free spelling of a path that may not
 *     exist yet, so `/var/…` and `/private/var/…` compare equal. Identity by
 *     default; the handler passes the real one.
 * `cwd` is the session cwd relative paths resolve against, `path.resolve(cwd, p)`.
 */
export async function decide({ toolName, input, cwd, agent, mainRoot, installRoot = null, isIgnored, canonical = (p) => p }) {
  if (!applies(agent, toolName)) return undefined;
  let located;
  const writes = () => (located ??= targets(toolName, input).flatMap((raw) => {
    const abs = fsPath(raw, cwd);
    return abs === null ? [] : [{ raw, at: canonical(abs) }];
  }));
  const said = ({ raw, at }) => (isAbsolute(raw) ? at : `${at} ("${raw}" resolved against the session cwd ${cwd})`);

  // The Install root, for path writers: whatever repository the session runs
  // in, or none, and with no gitignore exemption — nothing under it is a
  // member's to write.
  if (toolName !== "bash" && installRoot !== null) {
    const cannot = unusable(toolName, "the Install root", installRoot);
    if (cannot) return cannot;
    for (const t of writes()) {
      if (within(installRoot, t.at)) {
        return { block: true, reason: `member-write-guard: refused ${toolName} to ${said(t)} — it is inside the Install root ${installRoot}, the installed plugin the fleet executes, and nothing under it is a member's to write. ${REISSUE}` };
      }
    }
  }

  if (mainRoot === null) return undefined;
  const cannot = unusable(toolName, mainRoot instanceof Error ? `the main checkout from ${cwd}` : "the main checkout", mainRoot);
  if (cannot) return cannot;

  if (toolName === "bash") {
    const asked = typeof input?.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : cwd;
    const at = canonical(fsPath(asked, cwd) ?? resolve(cwd, asked));
    if (within(mainRoot, at) && !at.startsWith(join(mainRoot, ".worktrees") + sep)) {
      return { block: true, reason: `member-write-guard: refused bash — its cwd ${at} is inside the main checkout ${mainRoot}, outside \`.worktrees/\`. Re-issue it with \`cwd\` set to the absolute path of your worktree \`.worktrees/<n>-<slug>/\`.` };
    }
    return undefined;
  }

  for (const t of writes()) {
    if (!within(mainRoot, t.at)) continue;
    let ignored;
    try {
      ignored = await isIgnored(t.at);
    } catch (e) {
      return { block: true, reason: `member-write-guard: refused ${toolName} to ${said(t)} — could not tell whether it is gitignored (${e?.message ?? e}), and a guard that cannot look does not let the call through. ${REISSUE}` };
    }
    if (!ignored) {
      return { block: true, reason: `member-write-guard: refused ${toolName} to ${said(t)} — it is inside the main checkout ${mainRoot} and not gitignored. ${REISSUE}` };
    }
  }
  return undefined;
}

// ── The effects decide() is handed ──────────────────────────────────────────

// The one git primitive, async so a guarded call never stalls the other
// sessions sharing omp's process. `gitEnv()` drops an ambient GIT_DIR /
// GIT_WORK_TREE, and LC_ALL=C keeps "not a git repository" matchable.
function git(args, cwd) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const finish = (r) => done({ stdout, stderr, ...r });
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
async function resolveMainRoot(cwd) {
  const r = await git(["rev-parse", "--git-common-dir"], cwd);
  // Only git's no-repository-anywhere answer is "no main checkout". A gitfile
  // pointing at a missing git dir also says "not a git repository", followed
  // by the dead path rather than "(or any …": that is a broken repo, and blocks.
  if (!r.error && r.status !== 0 && /not a git repository \(or any/i.test(r.stderr)) return null;
  if (r.error || r.status !== 0) return new Error(failure(r, "git rev-parse --git-common-dir"));
  return mainCheckoutDirFromGitCommonDir(r.stdout, cwd, { canonicalise: true })
    ?? new Error("git rev-parse --git-common-dir answered nothing");
}

/** `git check-ignore` from `mainRoot`: true ignored, false not; rejects on anything else. */
async function checkIgnored(mainRoot, absPath) {
  const r = await git(["check-ignore", "-q", "--", absPath], mainRoot);
  if (!r.error && r.status === 0) return true;
  if (!r.error && r.status === 1) return false;
  throw new Error(failure(r, "git check-ignore"));
}

// The Install root, resolved the way fleet-run's Resolver resolves it — lstat,
// then realpath, of the package entry under the home directory — on every
// guarded path-writer call, so a relink or reinstall mid-run is followed. Not
// this module's own location: that names the copy omp loaded at session start.
/** The live Install root: its realpath, `null` when there is no package entry, or an `Error` naming the entry. */
function resolveInstallRoot() {
  const entry = join(homedir(), ...INSTALL_ENTRY);
  let isLink;
  try {
    isLink = lstatSync(entry).isSymbolicLink();
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return new Error(`cannot read the omp plugin entry ${entry}: ${e?.code ?? e?.message ?? e}`);
  }
  try {
    return realpathSync(entry);
  } catch (e) {
    const code = e?.code ?? e?.message ?? e;
    return new Error(isLink ? `the omp plugin link ${entry} is dangling: ${code}` : `cannot resolve the omp plugin entry ${entry}: ${code}`);
  }
}

/** The symlink-free spelling of `p`, whose tail need not exist yet. */
function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
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
      installRoot: PATH_WRITERS.has(event.toolName) ? resolveInstallRoot() : null,
      isIgnored: (p) => checkIgnored(mainRoot, p),
      canonical: canonicalPath,
    });
  });
}
