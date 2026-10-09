// Regression gate for main-checkout.mjs (#2210), the tick's main-checkout
// dirty check. Zero deps:
//   node --test tests/main-checkout.test.mjs
//
// Every case runs in a real temporary repository: what is under test is how
// git's porcelain, the gitignore, a linked worktree and the filesystem answer,
// and a stubbed git would answer whatever the stub was told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMainCheckout, recordBaseline, baselinePath, describe } from "../plugin/scripts/main-checkout.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/main-checkout.mjs", import.meta.url));
// Permission cases mean nothing to root, which reads through any mode bits.
const ROOT = process.getuid?.() === 0;

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// A fleet-shaped main checkout: one tracked file, `.fleet/` and `.worktrees/`
// ignored the way a fleet repo's .gitignore ignores them.
function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-")));
  t.after(() => {
    // Restore what a case took away, or rmSync cannot clear it.
    for (const p of [join(dir, ".fleet"), join(dir, "locked.txt")]) try { chmodSync(p, 0o755); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".fleet/\n.worktrees/\n.agent-brain/\n");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const record = (cwd, env) => {
  const r = recordBaseline({ cwd, env });
  assert.equal(r.ok, true, r.why);
  return r;
};
const check = (cwd, env) => checkMainCheckout({ cwd, env });

test("a clean tree recorded and left alone is clean", (t) => {
  const dir = repo(t);
  record(dir);
  assert.equal(check(dir).state, "clean");
});

test("uncommitted work present at run start is in the baseline and holds nothing", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "mine, uncommitted\n");
  writeFileSync(join(dir, "notes.md"), "untracked, mine\n");
  record(dir);
  assert.equal(check(dir).state, "clean");
});

test("a new untracked file is dirty, and named", (t) => {
  const dir = repo(t);
  record(dir);
  mkdirSync(join(dir, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(dir, "plugin", "scripts", "stray.mjs"), "x\n");
  const c = check(dir);
  assert.equal(c.state, "dirty");
  // -uall: the file itself, never only its new directory.
  assert.deepEqual(c.changed, ["plugin/scripts/stray.mjs"]);
});

test("an untracked file is dirty even where status.showUntrackedFiles=no would silence it (#730)", (t) => {
  const dir = repo(t);
  git(dir, "config", "status.showUntrackedFiles", "no");
  record(dir);
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(dir).changed, ["stray.txt"]);
});

test("a modified tracked file is dirty", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "tracked.txt"), "two\n");
  assert.deepEqual(check(dir), { state: "dirty", root: dir, baseline: baselinePath(dir), changed: ["tracked.txt"] });
});

test("a further edit to a file already dirty at the baseline is dirty — the hash, not the status line, catches it", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "mine\n");
  writeFileSync(join(dir, "notes.md"), "mine\n");
  record(dir);
  appendFileSync(join(dir, "tracked.txt"), "a member's line\n");
  assert.deepEqual(check(dir).changed, ["tracked.txt"]);
  appendFileSync(join(dir, "notes.md"), "a member's line\n");
  assert.deepEqual(check(dir).changed, ["notes.md", "tracked.txt"]);
});

test("a deleted tracked file, and an entry that leaves porcelain, are both dirty", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "notes.md"), "mine\n");
  record(dir);
  unlinkSync(join(dir, "tracked.txt"));
  unlinkSync(join(dir, "notes.md"));
  assert.deepEqual(check(dir).changed, ["notes.md", "tracked.txt"]);
});

test("staging a change is a change", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "tracked.txt"), "mine\n");
  record(dir);
  git(dir, "add", "tracked.txt");
  assert.deepEqual(check(dir).changed, ["tracked.txt"]);
});

// A repository nested in the main checkout, with one committed file `f`:
// untracked, porcelain lists it as `nested/`; `gitlink: true` commits it to
// the main checkout as a submodule's gitlink, listed as `nested` once dirty.
function nested(dir, { gitlink = false } = {}) {
  const sub = join(dir, "nested");
  mkdirSync(sub);
  git(sub, "init", "-q");
  writeFileSync(join(sub, "f"), "committed\n");
  git(sub, "add", "f");
  git(sub, "commit", "-qm", "init");
  if (gitlink) {
    git(dir, "-c", "advice.addEmbeddedRepo=false", "add", "nested");
    git(dir, "commit", "-qm", "gitlink");
  }
  return sub;
}

test("a further edit inside a nested repository already dirty at the baseline is dirty", (t) => {
  for (const gitlink of [false, true]) {
    const dir = repo(t);
    const sub = nested(dir, { gitlink });
    writeFileSync(join(sub, "f"), "mine, uncommitted\n");
    record(dir);
    assert.equal(check(dir).state, "clean");
    appendFileSync(join(sub, "f"), "a member's line\n");
    assert.deepEqual(check(dir).changed, [gitlink ? "nested" : "nested/"]);
  }
});

test("a commit inside a nested repository is dirty, though its status reads the same", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  record(dir);
  git(sub, "commit", "-q", "--allow-empty", "-m", "a member's commit");
  assert.deepEqual(check(dir).changed, ["nested/"]);
});

test("a nested repository left alone is clean, a commitless one too", (t) => {
  const dir = repo(t);
  nested(dir);
  const bare = join(dir, "fresh");
  mkdirSync(bare);
  git(bare, "init", "-q");
  writeFileSync(join(bare, "draft.txt"), "x\n");
  record(dir);
  assert.equal(check(dir).state, "clean");
  appendFileSync(join(bare, "draft.txt"), "y\n");
  assert.deepEqual(check(dir).changed, ["fresh/"]);
});

test("the run's bookkeeping exemption is the main checkout's paths, not a nested repository's", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  record(dir);
  mkdirSync(join(sub, "docs", "metrics"), { recursive: true });
  writeFileSync(join(sub, "docs", "metrics", "tier-outcomes.tsv"), "x\n");
  assert.deepEqual(check(dir).changed, ["nested/"]);
});

test("a nested repository git cannot read is unknown, never clean", (t) => {
  const dir = repo(t);
  const sub = nested(dir);
  writeFileSync(join(sub, "f"), "mine, uncommitted\n");
  record(dir);
  writeFileSync(join(sub, ".git", "index"), "not an index");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /^cannot hash nested\/: git status --porcelain -uall exited \d+/);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
});

test("a write under a gitignored directory is clean — run state, agent-brain's cache", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, ".fleet", "ledger.md"), "# ledger\n");
  mkdirSync(join(dir, ".agent-brain"));
  writeFileSync(join(dir, ".agent-brain", "index.md"), "x\n");
  assert.equal(check(dir).state, "clean");
});

test("the run's own bookkeeping is not a stray write: the controller's metrics appends stay clean, anything beside them does not", (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, "docs", "metrics"), { recursive: true });
  writeFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), "# header\n");
  writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), "# header\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "metrics");
  record(dir);
  // What the controller does mid-run: `tier-outcomes.mjs append` per ruled
  // PR, the member-facts scrape rewriting its file. Twice, as a run does.
  for (const row of ["2026-10-01\t2298\n", "2026-10-01\t2302\n"]) {
    appendFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), row);
    writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), `# header\n${row}`);
    assert.equal(check(dir).state, "clean", "the controller's own append held the run");
  }
  // Two named files, never the directory, and a stray beside them is named alone.
  writeFileSync(join(dir, "docs", "metrics", "stray.tsv"), "x\n");
  writeFileSync(join(dir, "tracked.txt"), "a member's\n");
  assert.deepEqual(check(dir).changed, ["docs/metrics/stray.tsv", "tracked.txt"]);
});

test("a write inside .worktrees/<x>/ is clean, and the check run from that worktree still answers for the main checkout", (t) => {
  const dir = repo(t);
  git(dir, "worktree", "add", "-q", "-b", "impl/1", join(dir, ".worktrees", "1-x"));
  record(dir);
  const wt = join(dir, ".worktrees", "1-x");
  writeFileSync(join(wt, "tracked.txt"), "a member's own work\n");
  writeFileSync(join(wt, "new.mjs"), "x\n");
  assert.equal(check(dir).state, "clean");
  const fromWt = check(wt);
  assert.equal(fromWt.state, "clean");
  assert.equal(fromWt.root, dir, "resolved the worktree as the main checkout — --show-toplevel's answer, not the common dir's");
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(wt).changed, ["stray.txt"], "a stray write is invisible from a member's worktree");
});

test("paths that would split or blur the line are quoted in it", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "plain.txt"), "x\n");
  writeFileSync(join(dir, "a b.txt"), "x\n");
  writeFileSync(join(dir, 'q"uote.txt'), "x\n");
  writeFileSync(join(dir, "back\\slash.txt"), "x\n");
  writeFileSync(join(dir, "ctl\x01.txt"), "x\n");
  writeFileSync(join(dir, "new\nline.txt"), "x\n");
  const c = check(dir);
  assert.deepEqual(c.changed, ["a b.txt", "back\\slash.txt", "ctl\x01.txt", "new\nline.txt", "plain.txt", 'q"uote.txt']);
  const said = describe(c, ["impl-7"]);
  assert.ok(said.startsWith(`MAIN-CHECKOUT-DIRTY "a b.txt" "back\\\\slash.txt" "ctl\\u0001.txt" "new\\nline.txt" plain.txt "q\\"uote.txt" — `), said);
  assert.doesNotMatch(said, /[\x00-\x1f]/, "a raw control byte reached the printed line");
});

test("a git that fails is unknown, never clean", (t) => {
  const dir = repo(t);
  record(dir);
  // A corrupt index: git status exits non-zero.
  writeFileSync(join(dir, ".git", "index"), "not an index");
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "read");
  assert.match(c.why, /git status --porcelain -uall exited \d+/);
  assert.match(describe(c, []), /^MAIN-CHECKOUT-UNKNOWN could not look: .*NEVER re-baseline over it/);
});

test("a directory that is no repository is unknown, never clean", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "main-checkout-norepo-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = check(dir, { ...process.env, GIT_CEILING_DIRECTORIES: dir });
  assert.equal(c.state, "unknown");
  assert.match(c.why, /git rev-parse --git-common-dir exited 128/);
});

test("a path git names but the check cannot hash is unknown, never clean", { skip: ROOT }, (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "locked.txt"), "x\n");
  chmodSync(join(dir, "locked.txt"), 0o000);
  const c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /cannot hash locked\.txt: EACCES/);
});

test("an ambient GIT_DIR naming another repository does not change the answer (#1599)", (t) => {
  const dir = repo(t);
  const decoy = repo(t);
  writeFileSync(join(decoy, "decoy-stray.txt"), "x\n");
  const env = { ...process.env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy };
  record(dir, env);
  assert.equal(readFileSync(baselinePath(dir), "utf8").includes("decoy-stray"), false, "the baseline recorded the decoy's tree");
  assert.equal(check(dir, env).state, "clean");
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.deepEqual(check(dir, env).changed, ["stray.txt"]);
});

test("no baseline is its own refusal, never clean", (t) => {
  const dir = repo(t);
  const c = check(dir);
  assert.deepEqual(c, { state: "absent", root: dir, baseline: baselinePath(dir) });
  assert.match(describe(c, []), /^MAIN-CHECKOUT-NO-BASELINE no baseline at .*main-checkout\.sha — .*record it at run start/);
});

test("a baseline that exists but cannot be read is its own unknown, never clean and never 'no baseline'", { skip: ROOT }, (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);

  chmodSync(base, 0o000);
  let c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "baseline");
  assert.match(c.why, /exists but cannot be read: EACCES/);
  assert.match(describe(c, []), /^MAIN-CHECKOUT-UNKNOWN baseline unreadable: .*NEVER re-baseline over it/);
  chmodSync(base, 0o644);

  // An unsearchable .fleet/ hides the file from stat: EACCES, not ENOENT.
  chmodSync(join(dir, ".fleet"), 0o600);
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.equal(c.cause, "baseline");
  chmodSync(join(dir, ".fleet"), 0o755);

  unlinkSync(base);
  symlinkSync(join(dir, "gone"), base);
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /dangling symlink/);
  unlinkSync(base);

  writeFileSync(base, "deadbeef\n");
  c = check(dir);
  assert.equal(c.state, "unknown");
  assert.match(c.why, /not a baseline main-checkout\.mjs --record wrote/);
});

test("--record overwrites rather than compares: after the stray paths are resolved it clears, and it clears a dirty tree too", (t) => {
  const dir = repo(t);
  record(dir);
  writeFileSync(join(dir, "stray.txt"), "x\n");
  assert.equal(check(dir).state, "dirty");
  // Re-baselining while dirty certifies the tree as it stands — which is why
  // the runbook says resolve FIRST.
  record(dir);
  assert.equal(check(dir).state, "clean");
  unlinkSync(join(dir, "stray.txt"));
  assert.equal(check(dir).state, "dirty", "removing a path the baseline recorded is a change");
});

test("--record refuses over a baseline it cannot read, and leaves it in place", { skip: ROOT }, (t) => {
  const dir = repo(t);
  record(dir);
  const base = baselinePath(dir);
  chmodSync(base, 0o000);
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /do NOT --record over it, --record overwrites rather than compares/);
  chmodSync(base, 0o644);
  writeFileSync(base, "not a baseline\n");
  assert.equal(recordBaseline({ cwd: dir }).ok, false);
  assert.equal(readFileSync(base, "utf8"), "not a baseline\n");
});

test("--record refuses when git cannot look, and writes nothing", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, ".git", "index"), "not an index");
  const r = recordBaseline({ cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.why, /could not look, so there is nothing to record/);
  assert.equal(check(dir).state, "absent");
});

test("CLI: --record then --check, with the exit codes the header names", (t) => {
  const dir = repo(t);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  let r = run("--check");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^MAIN-CHECKOUT-NO-BASELINE /);
  r = run("--record");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^main-checkout: recorded 0 porcelain entries at /);
  r = run("--check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^main-checkout: clean against /);
  writeFileSync(join(dir, "stray.txt"), "x\n");
  r = run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MAIN-CHECKOUT-DIRTY stray\.txt — /);
  writeFileSync(join(dir, ".git", "index"), "not an index");
  r = run("--check");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^MAIN-CHECKOUT-UNKNOWN /);
  r = run("--record");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^main-checkout: .*could not look/m);
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: main-checkout\.mjs --record \| --check/);
  r = run("--record", "--check");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: main-checkout\.mjs --record \| --check/);
  r = run("--recrod");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--recrod/, "a misspelt flag must be refused by name, never run as a check");
});
