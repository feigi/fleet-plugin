// The shared state module — #357. Both of its callers have a CLI test file of
// their own, and almost everything this module does shows through one of them:
// the corrupt-file announcements, the per-field validation, the patch write, the
// failed-write return value.
//
// One thing does not, and it is a contract rather than an output: `rest` is the
// fields OUTSIDE the schema, never a second unvalidated copy of the fields
// inside it. Two copies of one key — one sanitized, one raw — is a trap for the
// next caller (#1597's stage-2 keys arrive in `rest`), and it leaves
// writeState's key ORDER as the only thing standing between a junk value and
// the disk. No CLI output differs on that, so it is pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readState } from "./fleet-state.mjs";

const SCRIPT = fileURLToPath(new URL("./fleet-state.mjs", import.meta.url));

test("readState: `rest` is what lies outside the schema, never a second copy of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: "bogus", elapsed: 5, digest: "abc", note: "not ours" }));
  const state = readState(path, "fleet-state-test");
  rmSync(dir, { recursive: true, force: true });

  // The validated view, per field: a junk `quiet` sanitizes to 0 without taking
  // the good `elapsed` down with it.
  assert.equal(state.quiet, 0);
  assert.equal(state.elapsed, 5);
  assert.equal(state.digest, "abc");
  // And `rest` carries the foreign key alone. A raw `quiet: "bogus"` sitting in
  // here is the value writeState would spread back onto the disk — the script
  // that owns neither key re-persisting a fault the read had already repaired.
  assert.deepEqual(state.rest, { note: "not ours" });
});

test("statePath: an ambient GIT_COMMON_DIR is not canonicalised — this caller does not opt in (#1658)", () => {
  // git-env.mjs's own docstring: `canonicalise` is board.mjs's opt-in alone
  // (#1582, a symlinked cockpit route deriving a second port); ledger.mjs and
  // fleet-state.mjs stay on the default because both PRINT the path they
  // resolve, and realpath would change that output without changing which
  // file either reaches. board.test.mjs pins board.mjs's OPPOSITE choice;
  // git-env.test.mjs pins the HELPER's own default, which cannot see whether
  // THIS caller opted in — nothing before this test pinned that fact, so an
  // accidental `{ canonicalise: true }` added here would break no test.
  //
  // statePath() shells out to real `git`, which resolves a symlinked cwd
  // itself (the OS's own getcwd() never carries a symlink component), so the
  // vector has to be an ambient answer git echoes back verbatim instead:
  // GIT_COMMON_DIR, which statePath()'s scrub does not touch (only GIT_DIR
  // and GIT_WORK_TREE are). Measured directly: `GIT_COMMON_DIR=<symlinked
  // path>/.git git rev-parse --git-common-dir` from inside a repository
  // answers with that exact string, unresolved.
  const root = mkdtempSync(join(tmpdir(), "fleet-state-link-"));
  try {
    const real = join(root, "repo");
    assert.equal(spawnSync("git", ["init", "-q", real], { stdio: "ignore" }).status, 0);
    const link = join(root, "link");
    symlinkSync(real, link);
    // A plain repository to run FROM, not this suite's own (linked) worktree:
    // a GIT_COMMON_DIR override from inside a linked worktree collides with
    // that worktree's own admin files (measured: git then reports "not a git
    // repository", expecting GIT_DIR to name the worktree too).
    const cwdRepo = join(root, "cwd-repo");
    mkdirSync(cwdRepo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: cwdRepo, stdio: "ignore" }).status, 0);
    const r = spawnSync(process.execPath,
      ["-e", 'import(process.argv[1]).then((m) => { process.stdout.write(m.statePath("fleet-state-test")); });', SCRIPT],
      { cwd: cwdRepo, encoding: "utf8", env: { ...process.env, GIT_COMMON_DIR: join(link, ".git") } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, join(link, ".fleet", "heartbeat.json"),
      "statePath() must keep the symlinked spelling — canonicalising here is board.mjs's opt-in alone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
