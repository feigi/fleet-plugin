// The mark an Evict leaves on a claim tree, and the restore time a restore
// leaves beside it, both files in the tree's git admin dir: evict.mjs writes
// and reads them, and dispatch-prompt.mjs reads the mark before it renders a
// brief for a member that runs code in the tree. A module of its own so the
// renderer reads the mark without loading the sweep.
//
// The admin dir is the one `git -C <tree> rev-parse --absolute-git-dir`
// names, asked only once `<tree>/.git` is there: without it git walks up and
// answers for the enclosing repository, whose admin dir is not the tree's.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "./git-env.mjs";

export const EVICTED = "fleet-evicted";
export const RESTORED = "fleet-restored";
const GIT_TIMEOUT_MS = 30_000;

/** The command that restores an evicted tree, as the controller runs it. */
export const restoreCommand = (tree) => `~/.fleet/bin/fleet-run evict.mjs --restore ${tree} --apply`;

const how = (r) => {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  const said = String(r.stderr ?? "").trim().split("\n").at(-1);
  return said ? `exit ${r.status}: ${said}` : `exit ${r.status}`;
};

/** `{dir}`, the tree's git admin dir, or `{unknown}`, why it cannot be told. */
export function adminDir(tree) {
  try {
    lstatSync(join(tree, ".git"));
  } catch (e) {
    return { unknown: `cannot read ${join(tree, ".git")} (${e.code ?? e.message}) — git would answer for the enclosing repository` };
  }
  const r = spawnSync("git", ["-C", tree, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: gitEnv(),
  });
  const dir = String(r.stdout ?? "").replace(/\n$/, "");
  if (r.error || r.status !== 0 || dir === "") return { unknown: `git rev-parse --absolute-git-dir in ${tree} failed (${how(r)})` };
  return { dir };
}

/** `{marked, dir}` for a tree whose admin dir can be read, else `{unknown}`. */
export function evictionMark(tree) {
  const admin = adminDir(tree);
  if (admin.unknown !== undefined) return admin;
  const mark = join(admin.dir, EVICTED);
  try {
    lstatSync(mark);
    return { marked: true, dir: admin.dir };
  } catch (e) {
    if (e.code === "ENOENT") return { marked: false, dir: admin.dir };
    return { unknown: `cannot look for ${mark} (${e.code ?? e.message})` };
  }
}
