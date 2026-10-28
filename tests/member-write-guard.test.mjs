// member-write-guard.mjs, exercised the way omp runs it: the factory is handed
// a stand-in `pi`, and every call goes through the `tool_call` handler it
// registers — which resolves the main checkout with real git and hands it to
// `decide()`. The fixture is a real repository with a claimed-style worktree
// under `.worktrees/`, a `.gitignore` carrying the fleet's ignored
// directories, and a scratch directory outside it. On macOS `tmpdir()` lives
// behind the `/var` → `/private/var` symlink, so every row below also crosses
// the symlink the handler canonicalises away.
//
// Both halves are pinned: what the guard must refuse (a main-checkout write,
// relative or absolute, from a member or a member's child; an implementer's
// bash from the inherited cwd; a git that cannot answer) and what it must let
// through (the member's worktree, gitignored run state, scratch, internal
// URLs, every session that is not a fleet member's).
//
// Zero deps: `node --test tests/member-write-guard.test.mjs`.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import memberWriteGuard, { decide } from "../plugin/scripts/member-write-guard.mjs";

const ENV = gitEnv({
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
});
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, stdio: "pipe" });

function repo(dir) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\n.fleet/\n.agent-brain/\n");
  mkdirSync(join(dir, "plugin"));
  writeFileSync(join(dir, "plugin", "tool.mjs"), "export {};\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  assert.ok(existsSync(join(dir, ".git")), `fixture: ${dir} has no .git — git init answered for some other repository`);
  return dir;
}

const BASE = mkdtempSync(join(tmpdir(), "member-write-guard-"));
after(() => rmSync(BASE, { recursive: true, force: true }));
// The spelling a session would carry: NOT canonicalised, so the /var symlink stays in it.
const ROOT = repo(join(BASE, "main"));
const REAL_ROOT = realpathSync(ROOT);
const WT = join(ROOT, ".worktrees", "42-slug");
sh(ROOT, "worktree", "add", "-q", WT, "-b", "implementer/42");
const SCRATCH = join(BASE, "scratch");
mkdirSync(SCRATCH);
const ELSEWHERE = repo(join(BASE, "elsewhere"));

// The Install root is the realpath of the package entry under `os.homedir()`,
// which is $HOME, and the guard resolves it on every guarded path-writer call.
// Every row in this file runs under a fixture HOME, so none reads a real omp
// install and the file answers the same in CI, which has none, as on a
// machine that has one. NO_INSTALL has no package entry: the Install-root rule
// is off there, so every main-checkout row keeps its verdict.
const NO_INSTALL = join(BASE, "home-none");
mkdirSync(NO_INSTALL);
process.env.HOME = NO_INSTALL;
const ENTRY = [".omp", "plugins", "node_modules", "@feigi", "fleet-ctl"];
/** A fixture HOME named `name` whose package entry `make(entryPath)` creates. */
function installHome(name, make) {
  const home = join(BASE, name);
  const entry = join(home, ...ENTRY);
  mkdirSync(dirname(entry), { recursive: true });
  make(entry);
  return { home, entry };
}
async function underHome(home, fn) {
  process.env.HOME = home;
  try {
    await fn();
  } finally {
    process.env.HOME = NO_INSTALL;
  }
}
const pluginTree = (dir) => {
  for (const sub of ["commands", "scripts", "skills", "agents", "workflows"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "scripts", "fleet-tick.mjs"), "export {};\n");
};

const IMPL = { kind: "sub", id: "impl-42", name: "fleet-implementer-slow-high", depth: 1, parentId: "Main" };
const OTHER_CELLS = ["slow-medium", "task-high", "task-max", "smol-high"].map((cell) => ({ ...IMPL, name: `fleet-implementer-${cell}` }));
const REVIEWER = { kind: "sub", id: "review-pr-9.Correctness", name: "fleet-review-correctness", depth: 2, parentId: "review-pr-9" };
const FINISHER = { kind: "sub", id: "finisher-pr-9", name: "fleet-finisher", depth: 1, parentId: "Main" };
const CHILD = { kind: "sub", id: "impl-42.Probe", name: "task", depth: 2, parentId: "impl-42" };
const UNRELATED = { kind: "sub", id: "0-Explore", name: "explore", depth: 1, parentId: "Main" };
const MAIN = { kind: "main", id: "Main", name: "main", depth: 0 };
// A fix-applier is dispatched as `fleet-fix-applier`; the untyped one is the
// same member under a generic `task` definition, which only its own id names.
const FIX_APPLIER = { kind: "sub", id: "fix-pr-2246", name: "fleet-fix-applier", depth: 0, parentId: "Main" };
const FIX_APPLIER_UNTYPED = { ...FIX_APPLIER, name: "task" };

let handler;
memberWriteGuard({ on: (event, fn) => { if (event === "tool_call") handler = fn; } });
const call = (agent, toolName, input, cwd) => handler({ type: "tool_call", toolCallId: "t", toolName, input }, { cwd, agent });

async function refused(agent, toolName, input, cwd, what) {
  const r = await call(agent, toolName, input, cwd);
  assert.equal(r?.block, true, `${what}: expected a refusal, got ${JSON.stringify(r)}`);
  assert.match(r.reason, /member-write-guard/, `${what}: the refusal does not name the guard`);
  assert.match(r.reason, /\.worktrees\/<n>-<slug>\//, `${what}: the refusal does not tell the member where to re-issue it`);
  return r.reason;
}
async function allowed(agent, toolName, input, cwd, what) {
  assert.equal(await call(agent, toolName, input, cwd), undefined, `${what}: expected the call to run`);
}
/** A refusal by the Install-root rule, naming the root it refused for. */
async function refusedInstall(agent, toolName, input, cwd, root, what) {
  const r = await refused(agent, toolName, input, cwd, what);
  assert.ok(r.includes(`inside the Install root ${root}`), `${what}: the refusal does not name the Install root ${root}: ${r}`);
  assert.match(r, /the installed plugin the fleet executes/, `${what}: the refusal does not say what the Install root is`);
  return r;
}

test("a member's relative and absolute writes into the main checkout are refused, naming the resolved path", async () => {
  const rel = await refused(IMPL, "write", { path: "plugin/new.mjs", content: "x" }, ROOT, "relative write");
  assert.ok(rel.includes(join(REAL_ROOT, "plugin", "new.mjs")), `the refusal does not name the resolved path: ${rel}`);
  assert.match(rel, /"plugin\/new\.mjs" resolved against the session cwd/, "a relative refusal does not say what it resolved against");
  await refused(IMPL, "write", { path: join(ROOT, "plugin", "tool.mjs"), content: "x" }, ROOT, "absolute write to a tracked file");
  await refused(IMPL, "write", { path: join(ROOT, "README.md"), content: "x" }, ROOT, "absolute write to a new file at the root");
  await refused(REVIEWER, "write", { path: "plugin/tool.mjs" }, ROOT, "a review specialist's relative write");
  await refused(FINISHER, "write", { path: "plugin/tool.mjs" }, ROOT, "the finisher's relative write");
});

test("edit is refused on any target in the main checkout — header, omp's derived paths, a MV destination", async () => {
  await refused(IMPL, "edit", { input: "[plugin/tool.mjs#ABCD]\nPUT 1.=1:\n+x\n" }, ROOT, "hashline header, unnormalised");
  await refused(IMPL, "edit", { input: "…", path: "plugin/tool.mjs", paths: ["plugin/tool.mjs"] }, ROOT, "omp-normalised path");
  await refused(IMPL, "edit", { input: `[${join(WT, "plugin", "tool.mjs")}#ABCD]\nMV "plugin/moved.mjs"\n` }, ROOT, "a worktree file moved into the main checkout");
  await refused(IMPL, "edit", { input: "*** Begin Patch\n*** Update File: plugin/tool.mjs\n*** End Patch\n" }, ROOT, "apply_patch-mode header");
  await refused(IMPL, "edit", { _path: join(ROOT, "plugin", "tool.mjs") }, ROOT, "a host-added _path key, un-normalised");
  await refused(IMPL, "edit", { _input: `[${join(ROOT, "plugin", "tool.mjs")}#ABCD]\nPUT 1.=1:\n+x\n` }, ROOT, "a host-added _input key, un-normalised");
  await allowed(IMPL, "edit", { input: `[${join(WT, "plugin", "tool.mjs")}#ABCD]\nPUT 1.=1:\n+x\n` }, ROOT, "a worktree edit");
});

test("ast_edit is refused on a main-checkout path or glob and allowed in the worktree", async () => {
  await refused(IMPL, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["plugin/**/*.mjs"] }, ROOT, "a relative glob");
  await refused(IMPL, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [join(WT, "plugin"), "plugin/tool.mjs"] }, ROOT, "one bad path among good ones");
  await allowed(IMPL, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [join(WT, "plugin", "**", "*.mjs")] }, ROOT, "a worktree glob");
});

test("writes the guard must let through: the worktree, gitignored run state, scratch, internal URLs", async () => {
  await allowed(IMPL, "write", { path: join(WT, "plugin", "new.mjs") }, ROOT, "absolute write into the worktree");
  await allowed(IMPL, "write", { path: ".worktrees/42-slug/plugin/new.mjs" }, ROOT, "relative write into the worktree");
  await allowed(IMPL, "write", { path: ".fleet/ledger.md" }, ROOT, "gitignored .fleet/");
  await allowed(IMPL, "write", { path: join(ROOT, ".agent-brain", "index.md") }, ROOT, "gitignored .agent-brain/");
  await allowed(IMPL, "write", { path: join(SCRATCH, "impl-42", "probe.mjs") }, ROOT, "scratch outside the repository");
  await allowed(IMPL, "write", { path: "local://notes.md" }, ROOT, "a local:// artifact");
  await allowed(IMPL, "write", { path: "xd://ast_edit", content: "{}" }, ROOT, "an xd:// device");
  // From the worktree itself — the cwd a member would have if omp ever gave it one.
  await allowed(IMPL, "write", { path: "plugin/new.mjs" }, WT, "relative write from a worktree cwd");
});

test("only fleet members and their children are guarded — nothing else in the session", async () => {
  await allowed(UNRELATED, "write", { path: "plugin/tool.mjs" }, ROOT, "a non-fleet subagent");
  await allowed(MAIN, "write", { path: "plugin/tool.mjs" }, ROOT, "the top-level session");
  await allowed(MAIN, "bash", { command: "true" }, ROOT, "the top-level session's bash");
  await allowed(undefined, "write", { path: "plugin/tool.mjs" }, ROOT, "a context with no agent");
  await refused(CHILD, "write", { path: "plugin/tool.mjs" }, ROOT, "a child of impl-42");
  await refused({ ...CHILD, parentId: "impl-42-b" }, "write", { path: "plugin/tool.mjs" }, ROOT, "a child of a recovery member");
  for (const parentId of ["fix-pr-7", "review-pr-2245", "finisher-pr-3"]) {
    await refused({ ...CHILD, parentId }, "write", { path: "plugin/tool.mjs" }, ROOT, `a child of ${parentId}`);
  }
  // The pattern is anchored at both ends: near-misses are someone else's agents.
  for (const parentId of ["impl-42x", "impl-", "myimpl-42", "impl-42.Probe", "Main"]) {
    await allowed({ ...CHILD, parentId }, "write", { path: "plugin/tool.mjs" }, ROOT, `a subagent whose parent is ${parentId}`);
  }
});

test("a fix-applier is guarded whether or not its definition name says so: bash by its own id, path writers by name or id", async () => {
  for (const [agent, label] of [[FIX_APPLIER, "a fleet-fix-applier"], [FIX_APPLIER_UNTYPED, "an untyped fix-applier"]]) {
    await refused(agent, "write", { path: "plugin/tool.mjs" }, ROOT, `${label}'s relative write`);
    await refused(agent, "edit", { input: "[plugin/tool.mjs#ABCD]\nPUT 1.=1:\n+x\n" }, ROOT, `${label}'s edit`);
    await refused(agent, "bash", { command: "true" }, ROOT, `${label}'s bash with no cwd`);
    await refused(agent, "bash", { command: "true", cwd: ROOT }, WT, `${label}'s bash at the main checkout root`);
    await allowed(agent, "write", { path: "plugin/tool.mjs" }, WT, `${label}'s write from its worktree`);
    await allowed(agent, "bash", { command: "true", cwd: WT }, ROOT, `${label}'s bash cwd set to its worktree`);
  }
  // A recovery member (`-b`, `-c`, …) is the same fix-applier under a new name.
  for (const id of ["fix-pr-88-b", "fix-pr-88-z"]) {
    await refused({ ...FIX_APPLIER_UNTYPED, id }, "bash", { command: "true" }, ROOT, `an untyped fix-applier recovery member ${id}'s bash with no cwd`);
  }
  // The pattern is anchored at both ends and the suffix is one letter: a
  // generic `task` agent whose own id merely resembles `fix-pr-<n>` is nobody's
  // fix-applier and keeps its inherited cwd.
  for (const id of ["fix-pr-7x", "xfix-pr-7", "myfix-pr-7", "fix-pr-", "fix-pr-7-bb", "fix-pr-7-"]) {
    await allowed({ ...FIX_APPLIER_UNTYPED, id }, "bash", { command: "true" }, ROOT, `a task agent named ${id}'s bash with no cwd`);
  }
});

test("bash: an implementer is refused from the main checkout, never from its worktree; nobody else is", async () => {
  const r = await refused(IMPL, "bash", { command: "git status" }, ROOT, "implementer bash with no cwd");
  assert.ok(r.includes(REAL_ROOT), `the bash refusal does not name the cwd it resolved: ${r}`);
  for (const cell of OTHER_CELLS) await refused(cell, "bash", { command: "true" }, ROOT, `${cell.name} bash with no cwd`);
  // The bash rule is closed to the `CELL` grammar: a `fleet-implementer-`
  // name outside it is no implementer definition, and keeps the inherited cwd.
  await allowed({ ...IMPL, id: "probe-1", name: "fleet-implementer-probe" }, "bash", { command: "true" }, ROOT, "a non-cell fleet-implementer- name");
  await refused(IMPL, "bash", { command: "true", cwd: "plugin" }, ROOT, "a relative cwd inside the main checkout");
  await refused(IMPL, "bash", { command: "true", cwd: ROOT }, WT, "an explicit cwd at the main checkout root");
  await refused(IMPL, "bash", { command: "true", cwd: join(ROOT, ".worktrees") }, ROOT, "cwd at the bare .worktrees directory itself, not a worktree under it");
  await allowed(IMPL, "bash", { command: "true", cwd: WT }, ROOT, "cwd set to the worktree");
  await allowed(IMPL, "bash", { command: "true", cwd: SCRATCH }, ROOT, "cwd set to scratch");
  await allowed(IMPL, "bash", { command: "true" }, WT, "no cwd, session already in the worktree");
  await allowed(REVIEWER, "bash", { command: "pwd" }, ROOT, "a review specialist's pwd-first bash");
  await allowed(FINISHER, "bash", { command: "sh worktree-audit.sh" }, ROOT, "the finisher's audit");
  await allowed(CHILD, "bash", { command: "true" }, ROOT, "a member's child");
  await allowed(IMPL, "read", { path: "plugin/tool.mjs" }, ROOT, "a relative read");
  await allowed(IMPL, "eval", { code: "open('x','w')" }, ROOT, "eval");
});

test("when git cannot answer, the guard refuses; when there is no repository at all, it allows", async () => {
  await allowed(IMPL, "write", { path: "x.txt" }, SCRATCH, "cwd outside any repository");
  await allowed(IMPL, "bash", { command: "true" }, SCRATCH, "implementer bash outside any repository");

  const broken = join(BASE, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, ".git"), `gitdir: ${join(BASE, "gone")}\n`);
  const r = await refused(IMPL, "write", { path: "x.txt" }, broken, "a gitfile naming a missing git dir");
  assert.match(r, /git rev-parse --git-common-dir exited/, `the refusal does not name the git failure: ${r}`);
  await refused(IMPL, "write", { path: "x.txt" }, join(BASE, "no-such-dir"), "a session cwd that does not exist");

  const failing = await decide({
    toolName: "write", input: { path: "plugin/tool.mjs" }, cwd: REAL_ROOT, agent: IMPL, mainRoot: REAL_ROOT,
    isIgnored: async () => { throw new Error("git check-ignore exited 128: fatal: boom"); },
  });
  assert.equal(failing?.block, true, "a check-ignore failure let the write through");
  assert.match(failing.reason, /fatal: boom/, "the refusal does not carry the check-ignore failure");

  // decide() is exported and callable directly (as this test does), so a
  // mainRoot outside its null/Error/non-empty-string contract must fail
  // closed rather than let `within()`'s empty-prefix match everything.
  const emptyRoot = await decide({
    toolName: "write", input: { path: "/etc/passwd" }, cwd: "/tmp", agent: IMPL, mainRoot: "",
    isIgnored: async () => false,
  });
  assert.equal(emptyRoot?.block, true, "an empty-string mainRoot let an arbitrary absolute path through");
});

test("an ambient GIT_DIR naming another repository does not change the answer", async () => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(ELSEWHERE, ".git");
  try {
    await refused(IMPL, "write", { path: "plugin/tool.mjs" }, ROOT, "main-checkout write under an ambient GIT_DIR");
    await allowed(IMPL, "write", { path: ".fleet/ledger.md" }, ROOT, "ignored write under an ambient GIT_DIR");
    await refused(IMPL, "bash", { command: "true" }, ROOT, "implementer bash under an ambient GIT_DIR");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test("a symlinked route into the main checkout is the main checkout", async () => {
  const link = join(BASE, "link");
  symlinkSync(ROOT, link);
  await refused(IMPL, "write", { path: "plugin/tool.mjs" }, link, "relative write from a symlinked cwd");
  await refused(IMPL, "write", { path: join(link, "plugin", "tool.mjs") }, ROOT, "absolute write through the symlink");
  await allowed(IMPL, "write", { path: join(link, ".worktrees", "42-slug", "a.mjs") }, ROOT, "worktree write through the symlink");
});

// The run's stores follow a symlinked `.git` into the git dir it points at;
// the checkout a member must not write into is still the folder holding the link.
test("a checkout whose .git is a symlink to a git dir elsewhere is still the main checkout", async () => {
  const proj = repo(join(BASE, "symproj"));
  const gitDir = join(BASE, "symproj-g.git");
  renameSync(join(proj, ".git"), gitDir);
  symlinkSync(gitDir, join(proj, ".git"));
  await refused(IMPL, "write", { path: "plugin/tool.mjs" }, proj, "relative write into a symlinked-.git checkout");
  await refused(IMPL, "bash", { command: "true" }, proj, "implementer bash from a symlinked-.git checkout");
  await allowed(IMPL, "write", { path: ".fleet/ledger.md" }, proj, "gitignored .fleet/ in a symlinked-.git checkout");
});

test("a package install: a guarded write into the Install root is refused however the path is spelled", async () => {
  const { home, entry } = installHome("home-npm", (e) => pluginTree(e));
  const root = realpathSync(entry);
  await underHome(home, async () => {
    const r = await refusedInstall(IMPL, "write", { path: join(entry, "scripts", "fleet-tick.mjs") }, ROOT, root, "an absolute write into the Install root");
    assert.ok(r.includes(join(root, "scripts", "fleet-tick.mjs")), `the refusal does not name the resolved path: ${r}`);
    await refusedInstall(IMPL, "write", { path: "~/.omp/plugins/node_modules/@feigi/fleet-ctl/commands/run-merge-bot.md" }, ROOT, root, "a ~/ write into the Install root");
    // SCRATCH is in no repository, so only the Install-root rule can refuse this.
    await refusedInstall(IMPL, "write", { path: "../home-npm/.omp/plugins/node_modules/@feigi/fleet-ctl/skills/x.md" }, SCRATCH, root, "a relative ../ write into the Install root");
    await refusedInstall(IMPL, "write", { path: entry }, ROOT, root, "a write to the Install root itself");
    // The one measured stray: a `scheme://` tail after an absolute path is a file under it.
    await refusedInstall(IMPL, "write", { path: `${entry}/commands/xd://mcp__agent_brain_memory_get` }, ROOT, root, "an internal-URL tail under the Install root");
    await refusedInstall(FINISHER, "write", { path: join(root, "scripts", "x.mjs") }, ROOT, root, "the finisher's write into the Install root");
    await refusedInstall(REVIEWER, "write", { path: join(root, "scripts", "x.mjs") }, ROOT, root, "a review specialist's write into the Install root");
    await refusedInstall(CHILD, "write", { path: join(root, "scripts", "x.mjs") }, ROOT, root, "a member's child's write into the Install root");
    // Beside the Install root is not inside it.
    await allowed(IMPL, "write", { path: join(home, ".omp", "plugins", "node_modules", "@feigi", "fleet-ctl-other", "x.mjs") }, ROOT, "a sibling package sharing the root's name as a prefix");
    await allowed(IMPL, "write", { path: join(WT, "plugin", "new.mjs") }, ROOT, "the worktree, with a package install present");
  });
});

test("a linked entry: a write through the entry path or through its realpath is refused", async () => {
  const market = join(BASE, "cache-home", ".omp", "plugins", "cache", "fleet-ctl", "3.0.0");
  pluginTree(market);
  const OTHER = repo(join(BASE, "other"));
  const fixtures = [
    ["marketplace-style, outside any repository", installHome("home-market", (e) => symlinkSync(market, e))],
    ["another repository's plugin/", installHome("home-other", (e) => symlinkSync(join(OTHER, "plugin"), e))],
  ];
  for (const [kind, { home, entry }] of fixtures) {
    const root = realpathSync(entry);
    await underHome(home, async () => {
      await refusedInstall(IMPL, "write", { path: join(entry, "scripts", "x.mjs") }, ROOT, root, `${kind}: a write through the entry path`);
      await refusedInstall(IMPL, "write", { path: join(root, "scripts", "x.mjs") }, ROOT, root, `${kind}: a write through the realpath`);
    });
  }
  // The other repository is not the session's main checkout: outside its plugin/ it is not protected.
  await underHome(fixtures[1][1].home, async () => {
    await allowed(IMPL, "write", { path: join(OTHER, "README.md") }, ROOT, "another repository's file outside the Install root");
  });
});

test("every edit shape that names the Install root is refused", async () => {
  const { home, entry } = installHome("home-edit", (e) => pluginTree(e));
  const root = realpathSync(entry);
  await underHome(home, async () => {
    await refusedInstall(IMPL, "edit", { input: `[${join(entry, "scripts", "fleet-tick.mjs")}#ABCD]\nPUT 1.=1:\n+x\n` }, ROOT, root, "a hashline header");
    await refusedInstall(IMPL, "edit", { input: `[${join(WT, "plugin", "tool.mjs")}#ABCD]\nMV ${join(root, "scripts", "moved.mjs")}\n` }, ROOT, root, "an MV destination");
    await refusedInstall(IMPL, "edit", { input: "...", paths: [join(root, "scripts", "fleet-tick.mjs")] }, ROOT, root, "omp-normalised paths");
    await refusedInstall(IMPL, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [join(WT, "plugin"), join(entry, "scripts")] }, ROOT, root, "an ast_edit path among good ones");
    await allowed(IMPL, "edit", { input: `[${join(WT, "plugin", "tool.mjs")}#ABCD]\nPUT 1.=1:\n+x\n` }, ROOT, "a worktree edit");
  });
});

test("an Install root linked into the session's own repository has no gitignore exemption", async () => {
  const own = repo(join(BASE, "own"));
  writeFileSync(join(own, ".gitignore"), ".worktrees/\n.fleet/\n.agent-brain/\nplugin/*.log\n");
  const ownWt = join(own, ".worktrees", "7-slug");
  sh(own, "worktree", "add", "-q", ownWt, "-b", "implementer/7");
  // The main-checkout rule alone would let this file through.
  sh(own, "check-ignore", "-q", join(own, "plugin", "debug.log"));
  const { home, entry } = installHome("home-own", (e) => symlinkSync(join(own, "plugin"), e));
  const root = realpathSync(entry);
  await underHome(home, async () => {
    await refusedInstall(IMPL, "write", { path: "plugin/debug.log" }, own, root, "a gitignored file under the linked plugin/");
    await allowed(IMPL, "write", { path: join(ownWt, "plugin", "tool.mjs") }, own, "a write under .worktrees/<n>-<slug>/");
    await allowed(IMPL, "write", { path: ".fleet/ledger.md" }, own, "gitignored run state beside the Install root");
  });
});

test("with the session cwd in no repository, a write into the Install root is still refused", async () => {
  const { home, entry } = installHome("home-norepo", (e) => pluginTree(e));
  const root = realpathSync(entry);
  await underHome(home, async () => {
    await refusedInstall(IMPL, "write", { path: join(entry, "commands", "x.md") }, SCRATCH, root, "an absolute write from outside any repository");
    await allowed(IMPL, "write", { path: "x.txt" }, SCRATCH, "scratch, outside any repository");
  });
});

test("no package entry: the Install-root rule is off and the main-checkout rule still refuses", async () => {
  // NO_INSTALL has no `.omp` at all; this HOME has the directories up to the entry and no entry.
  const { home } = installHome("home-partial", () => {});
  for (const h of [NO_INSTALL, home]) {
    await underHome(h, async () => {
      const r = await refused(IMPL, "write", { path: "plugin/tool.mjs" }, ROOT, `no entry under ${h}: a main-checkout write`);
      assert.match(r, /inside the main checkout/, `the main-checkout rule did not answer: ${r}`);
      await allowed(IMPL, "write", { path: join(SCRATCH, "x.mjs") }, ROOT, `no entry under ${h}: a scratch write`);
    });
  }
});

test("an entry that does not resolve refuses every guarded path writer, and no bash", async () => {
  const dangling = installHome("home-dangling", (e) => symlinkSync(join(BASE, "gone-install"), e));
  // A file where a directory of the entry's path should be: lstat answers ENOTDIR, not ENOENT.
  const notDir = join(BASE, "home-notdir");
  mkdirSync(join(notDir, ".omp", "plugins"), { recursive: true });
  writeFileSync(join(notDir, ".omp", "plugins", "node_modules"), "");
  const rows = [
    [dangling.home, dangling.entry, /dangling: ENOENT/],
    [notDir, join(notDir, ...ENTRY), /ENOTDIR/],
  ];
  for (const [home, entry, error] of rows) {
    await underHome(home, async () => {
      for (const [toolName, input] of [
        ["write", { path: join(SCRATCH, "x.txt") }],
        ["edit", { input: `[${join(WT, "plugin", "tool.mjs")}#ABCD]\nPUT 1.=1:\n+x\n` }],
        ["ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [join(WT, "plugin")] }],
      ]) {
        const r = await refused(IMPL, toolName, input, SCRATCH, `${entry}: ${toolName}`);
        assert.ok(r.includes(entry), `${entry}: the ${toolName} refusal does not name the entry: ${r}`);
        assert.match(r, error, `${entry}: the ${toolName} refusal does not name the error: ${r}`);
      }
      await allowed(IMPL, "bash", { command: "true", cwd: WT }, ROOT, `${entry}: implementer bash with an allowed cwd`);
      await allowed(FIX_APPLIER, "bash", { command: "true", cwd: SCRATCH }, ROOT, `${entry}: fix-applier bash with an allowed cwd`);
      await allowed(MAIN, "write", { path: join(SCRATCH, "x.txt") }, SCRATCH, `${entry}: the top-level session's write`);
      await allowed(UNRELATED, "write", { path: join(SCRATCH, "x.txt") }, SCRATCH, `${entry}: a non-fleet subagent's write`);
    });
  }
});

test("unchanged: bash with a cwd in the Install root, and every unguarded session's write into it", async () => {
  const { home, entry } = installHome("home-unchanged", (e) => pluginTree(e));
  const root = realpathSync(entry);
  await underHome(home, async () => {
    await allowed(IMPL, "bash", { command: "cat commands/x.md", cwd: root }, ROOT, "an implementer's bash with cwd in the Install root");
    await allowed(FIX_APPLIER, "bash", { command: "cat commands/review-and-fix.md", cwd: entry }, ROOT, "a fix-applier's bash with cwd at the entry");
    await allowed(MAIN, "write", { path: join(root, "scripts", "x.mjs") }, ROOT, "the top-level session's write into the Install root");
    await allowed(UNRELATED, "write", { path: join(root, "scripts", "x.mjs") }, ROOT, "a non-fleet subagent's write into the Install root");
    await allowed(IMPL, "read", { path: join(root, "scripts", "fleet-tick.mjs") }, ROOT, "a read from the Install root");
  });
});

test("decide() takes the Install root as a path, null or an Error, and reads it for path writers only", async () => {
  const base = { cwd: "/tmp", agent: IMPL, mainRoot: null, isIgnored: async () => false };
  const inside = await decide({ ...base, toolName: "write", input: { path: "/opt/fleet/scripts/x.mjs" }, installRoot: "/opt/fleet" });
  assert.equal(inside?.block, true, "a write inside a string Install root went through");
  assert.equal(await decide({ ...base, toolName: "write", input: { path: "/opt/fleetx/a" }, installRoot: "/opt/fleet" }), undefined, "a path sharing the root as a prefix was refused");
  assert.equal(await decide({ ...base, toolName: "write", input: { path: "/opt/fleet/a" }, installRoot: null }), undefined, "a null Install root refused a write");
  const err = await decide({ ...base, toolName: "write", input: { path: "/elsewhere" }, installRoot: new Error("the omp plugin link /h/e is dangling: ENOENT") });
  assert.equal(err?.block, true, "an unresolvable Install root let a write through");
  assert.match(err.reason, /\/h\/e is dangling: ENOENT/, "the refusal does not carry the resolution error");
  const empty = await decide({ ...base, toolName: "write", input: { path: "/elsewhere" }, installRoot: "" });
  assert.equal(empty?.block, true, "an empty-string Install root let a write through");
  assert.equal(await decide({ ...base, toolName: "bash", input: { command: "true", cwd: "/opt/fleet" }, installRoot: new Error("x") }), undefined, "bash read the Install root");
});
