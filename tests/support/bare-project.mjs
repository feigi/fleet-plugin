// The `.bare` project fixture and the broken-gitfile table the workspace-rule
// suites share (fleet-dir, git-env, derive-testcmd), so a new layout or a new
// way to break `p/.git` is written once.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

function git(env, cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  assert.equal(r.status, 0, `test setup: git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/**
 * A `.bare` project under `top`: the git dir is `p/.bare`, `p/.git` is the
 * gitfile naming it, and one linked worktree per name hangs off it. `env` is
 * the fixture's git environment, the ambient repository variables scrubbed.
 */
export function bareProject(top, env, names = ["w1", "w2"]) {
  const src = join(top, "src");
  mkdirSync(src);
  git(env, src, "init", "-q");
  git(env, src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const proj = join(top, "p");
  mkdirSync(proj);
  git(env, top, "clone", "-q", "--bare", src, join(proj, ".bare"));
  writeFileSync(join(proj, ".git"), "gitdir: ./.bare\n");
  const worktrees = names.map((name) => {
    const wt = join(proj, name);
    git(env, proj, "worktree", "add", "-q", "--detach", wt);
    return wt;
  });
  return { proj, worktrees };
}

/** What git itself says about refusing `gitfile`, asked the way the modules ask. */
export function gitsReason(env, cwd, gitfile) {
  const r = spawnSync("git", ["rev-parse", "--resolve-git-dir", gitfile], { cwd, encoding: "utf8", env });
  assert.notEqual(r.status, 0, `test setup: git accepted ${gitfile}`);
  return r.stderr.trim();
}

/** Each way to leave a `p/.git` that exists but that git refuses. */
export const BROKEN_GITFILES = [
  ["dangling", (file) => writeFileSync(file, "gitdir: ./nonexistent\n")],
  ["garbage", (file) => writeFileSync(file, "this is not a gitfile\n")],
  ["chmod 000", (file) => chmodSync(file, 0o000)],
  ["dangling symlink", (file) => { rmSync(file); symlinkSync("nowhere", file); }],
];
