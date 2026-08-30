// Regression gate for instruments.sh, the check that says whether the
// controller's instrument set changed under a run (#436).
//
// The defect it guards is not observable from inside the fleet: a member that
// edits a script in the MAIN checkout — where the controller runs every gate
// probe from — changes what the controller measures with no error, no diff in
// any PR and nothing in the ledger. Measured once, self-caught by the member.
//
// A guard against that has TWO failure classes and this file pins both, because
// a suite that only feeds a guard input it must reject proves it fires, never
// that it discriminates:
//
//   REFUSE — a tracked instrument rewritten, deleted, or newly staged; no
//            baseline; an unreadable one. All of these stop a gate.
//   ACCEPT — an ordinary run: nothing touched, an untracked dropping under the
//            set, a bare `touch`, branch and worktree churn in the shared ref
//            store, and any change outside the set. #436's third acceptance
//            criterion is that an unchanged set costs effectively nothing per
//            gate, and a guard that fires on ordinary runs becomes noise the
//            controller learns to ignore, which is the same defect wearing a
//            different hat.
//
// Every case builds a throwaway checkout and runs the script out of it — the
// script resolves the tree to measure from its OWN location, so a copy inside
// the fixture measures the fixture and the live checkout is never touched.
//
// Zero deps: `node --test skills/fleet/scripts/instruments.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./instruments.sh", import.meta.url));
const SET = "skills/fleet";

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `core.excludesfile` or hook cannot change what these repos look like.
// The GIT_* redirects would point the fixture out of its own temp dir.
const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

// realpath: on macOS $TMPDIR is a symlink into /private, and `git rev-parse
// --show-toplevel` reports the resolved form. Comparing the two spellings is a
// fixture bug that reads as a script bug.
function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  mkdirSync(join(root, SET, "skills", "run-team"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  // Two stand-ins for the class the digest covers: an executable probe and a
  // runbook. The controller reads the world through both, from this same tree.
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('green');\n");
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# runbook\n");
  writeFileSync(join(root, "unrelated.md"), "outside the set\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

const run = (root, args = []) =>
  spawnSync(join(root, SET, "scripts", "instruments.sh"), args, {
    cwd: tmpdir(), // never the repo: the script must find its tree from $0
    env: ENV,
    encoding: "utf8",
  });

const pin = (root) => {
  const r = run(root, ["--pin"]);
  assert.equal(r.status, 0, `--pin failed: ${r.stderr}`);
  return r.stdout.trim();
};

test("--pin then an untouched check is exit 0, and reports the same digest", (t) => {
  const root = repo(t);
  const pinned = pin(root);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pinned);
});

test("a rewritten tracked instrument is exit 1, and the refusal says so", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs"), "console.log('red');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /instrument set CHANGED/);
  assert.match(r.stderr, /refuse the gate/i);
  // The controller has to be able to name what moved; two digests cannot.
  assert.match(r.stderr, /ci-state\.mjs/);
});

test("a rewritten runbook is exit 1 too — the instructions are read from the same tree", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# rewritten\n");
  assert.equal(run(root).status, 1);
});

test("restoring the bytes restores exit 0 — the digest is content, not history", (t) => {
  const root = repo(t);
  pin(root);
  const f = join(root, SET, "scripts", "ci-state.mjs");
  writeFileSync(f, "console.log('red');\n");
  assert.equal(run(root).status, 1);
  writeFileSync(f, "console.log('green');\n");
  assert.equal(run(root).status, 0);
});

test("a tracked instrument deleted from the worktree refuses, and names the file", (t) => {
  const root = repo(t);
  pin(root);
  rmSync(join(root, SET, "scripts", "ci-state.mjs"));
  const r = run(root);
  // Exit 2, not 1: the digest could not be computed at all. Both refuse; only
  // this one is honest that nothing was measured.
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ci-state\.mjs/);
});

test("a newly staged file under the set is exit 1", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", "smuggled.sh"), "#!/bin/sh\nexit 0\n");
  git(root, "add", join(SET, "scripts", "smuggled.sh"));
  assert.equal(run(root).status, 1);
});

test("no baseline refuses with exit 2 — an unpinned run is not an unchanged one", (t) => {
  const root = repo(t);
  const r = run(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pin/);
});

test("an empty baseline refuses rather than matching an empty digest", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, ".fleet", "instruments.sha"), "");
  const r = run(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty/);
});

test("an unreadable baseline refuses — unreadable is not unchanged", (t) => {
  if (process.geteuid?.() === 0) return t.skip("root reads a mode-000 file regardless");
  const root = repo(t);
  pin(root);
  // No mode restored afterwards: `repo`'s own cleanup unlinks it, which needs
  // write on the directory and nothing at all on the file.
  chmodSync(join(root, ".fleet", "instruments.sha"), 0o000);
  // Status only, deliberately. The script reaches this through `[ -r "$base" ]`,
  // which cannot tell absent from unreadable, so the stderr calls this one "no
  // baseline" and prescribes `--pin` — the wrong label, filed separately.
  // Asserting that text would pin the mislabel as the contract; asserting the
  // refusal pins the half that is right.
  assert.equal(run(root).status, 2);
});

test("outside a git checkout it refuses instead of certifying nothing", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-bare-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  const r = run(root, ["--pin"]);
  assert.equal(r.status, 2);
  // The status alone does not reach this guard. Delete it and the run falls
  // through to `git ls-files`, which fails on the same non-git path and dies
  // with the same code — so the message is what tells the two apart, and the
  // ABSENCE of the downstream one is what says execution stopped here.
  assert.match(r.stderr, /not inside a git checkout/);
  assert.doesNotMatch(r.stderr, /ls-files failed/);
});

test("a checkout with no tracked file under the set refuses to certify it", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruments-empty-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, SET, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, SET, "scripts", "instruments.sh"));
  writeFileSync(join(root, "only.md"), "x\n");
  git(root, "add", "only.md");
  git(root, "commit", "-qm", "fixture");
  const r = run(root, ["--pin"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty instrument set/);
});

test("a bad argument refuses rather than falling through to a check", (t) => {
  const root = repo(t);
  pin(root);
  const r = run(root, ["--pn"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

// ---------------------------------------------------------------------------
// ACCEPT. Everything below is an ordinary run, and every one of them must stay
// exit 0. These are what keep the guard from becoming noise.
// ---------------------------------------------------------------------------

test("an untracked dropping under the set is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, SET, "scripts", ".DS_Store"), "\0junk\n");
  writeFileSync(join(root, SET, "scripts", "ci-state.mjs.swp"), "editor\n");
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

test("a bare touch is accepted — content is hashed, not the stat cache", (t) => {
  const root = repo(t);
  pin(root);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, SET, "scripts", "ci-state.mjs"), later, later);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

test("branch and worktree churn in the shared ref store is accepted", (t) => {
  const root = repo(t);
  pin(root);
  // Exactly what claim-ticket.sh and reap.sh do to the main checkout every
  // wave. A ref digest would refuse here, several times per wave.
  git(root, "branch", "fix/42-slug");
  git(root, "worktree", "add", "-q", join(root, "wt"), "fix/42-slug");
  assert.equal(run(root).status, 0);
  git(root, "worktree", "remove", "--force", join(root, "wt"));
  git(root, "branch", "-D", "fix/42-slug");
  assert.equal(run(root).status, 0);
});

test("a change outside the set is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, "unrelated.md"), "rewritten by the run\n");
  writeFileSync(join(root, "brand-new.md"), "an output the fleet wrote\n");
  assert.equal(run(root).status, 0);
});

test("a commit that does not change the bytes is accepted", (t) => {
  const root = repo(t);
  pin(root);
  writeFileSync(join(root, "unrelated.md"), "rewritten\n");
  git(root, "commit", "-qam", "an ordinary commit outside the set");
  assert.equal(run(root).status, 0);
});

test("--pin re-baselines after a deliberate edit — the controller's own tooling-fix path", (t) => {
  const root = repo(t);
  const first = pin(root);
  writeFileSync(join(root, SET, "skills", "run-team", "SKILL.md"), "# fixed mid-run\n");
  assert.equal(run(root).status, 1);
  const second = pin(root);
  assert.notEqual(second, first);
  assert.equal(run(root).status, 0);
});
