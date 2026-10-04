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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const IMPL = { kind: "sub", id: "impl-42", name: "fleet-implementer-slow-high", depth: 1, parentId: "Main" };
const OTHER_CELLS = ["slow-medium", "task-high", "task-max", "smol-high"].map((cell) => ({ ...IMPL, name: `fleet-implementer-${cell}` }));
const REVIEWER = { kind: "sub", id: "review-pr-9.Correctness", name: "fleet-review-correctness", depth: 2, parentId: "review-pr-9" };
const FINISHER = { kind: "sub", id: "finisher-pr-9", name: "fleet-finisher", depth: 1, parentId: "Main" };
const CHILD = { kind: "sub", id: "impl-42.Probe", name: "task", depth: 2, parentId: "impl-42" };
const UNRELATED = { kind: "sub", id: "0-Explore", name: "explore", depth: 1, parentId: "Main" };
const MAIN = { kind: "main", id: "Main", name: "main", depth: 0 };
// A fix-applier: dispatched under the generic `task` definition (no `fleet-`
// prefix) directly by the controller, so only its own id names it.
const FIX_APPLIER = { kind: "sub", id: "fix-pr-2246", name: "task", depth: 0, parentId: "Main" };

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

test("a fix-applier dispatched under the generic `task` definition is guarded by its own id, not its definition name", async () => {
  await refused(FIX_APPLIER, "write", { path: "plugin/tool.mjs" }, ROOT, "a fix-applier's relative write");
  await refused(FIX_APPLIER, "edit", { input: "[plugin/tool.mjs#ABCD]\nPUT 1.=1:\n+x\n" }, ROOT, "a fix-applier's edit");
  await refused(FIX_APPLIER, "bash", { command: "true" }, ROOT, "a fix-applier's bash with no cwd");
  await refused(FIX_APPLIER, "bash", { command: "true", cwd: ROOT }, WT, "a fix-applier's bash at the main checkout root");
  await allowed(FIX_APPLIER, "write", { path: "plugin/tool.mjs" }, WT, "a fix-applier's write from its worktree");
  await allowed(FIX_APPLIER, "bash", { command: "true", cwd: WT }, ROOT, "a fix-applier's bash cwd set to its worktree");
  // The pattern is anchored: a generic `task` agent whose own id does not
  // match `fix-pr-<n>` is nobody's fix-applier and stays unguarded — the
  // existing UNRELATED/CHILD near-miss rows above already cover this shape.
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
