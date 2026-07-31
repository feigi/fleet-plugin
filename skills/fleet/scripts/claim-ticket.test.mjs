import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SCRIPT = join(import.meta.dirname, "claim-ticket.sh");

// Build a repo whose origin/main holds `files`. `local` is written to the
// working tree afterwards WITHOUT committing — that is how a checkout diverges
// from the ref the worktree is actually built from.
function repo(files, local = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claim-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git("add", "-A");
  git("commit", "-qm", "x");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [name, body] of Object.entries(local)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

// Returns {install, testcmd} on success, or {err} with the refusal message.
function claim(dir) {
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  if (r.status !== 0) return { err: out };
  return {
    install: out.match(/install: (.*)/)?.[1],
    testcmd: out.match(/test entrypoint → (.*)/)?.[1],
  };
}

const TESTS = "t.test.mjs";
const pkg = (o) => JSON.stringify(o);

// Runs the script for real and returns the emitted runner plus its worktree.
// `--apply` labels the issue, so `gh` is stubbed; everything else — the
// worktree, the install, the exclude file, the runner — is the real thing.
// The runner is what members actually invoke, so it is what gets asserted on.
function apply(files) {
  const dir = repo(files);
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const wt = join(dir, ".worktrees", "42-slug");
  // `node --test` marks the processes it spawns, and an inherited mark makes
  // the runner's own `node --test` report to a parent that is not listening —
  // status 0 and not a byte of stdout. An artifact of testing a test runner
  // from inside one; strip it so these assertions see what a member sees.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return {
    wt,
    text: readFileSync(join(wt, "agent-test"), "utf8"),
    run: (...args) => spawnSync(join(wt, "agent-test"), args, { cwd: wt, encoding: "utf8", env }),
  };
}

const PASSES = 'import { test } from "node:test";\ntest("ok", () => {});\n';
// `root.test.mjs` exists so no assertion below can be satisfied by the argv
// being dropped: bare `node --test` discovers the whole fixture, and every
// count asserted here differs from that. Without it the two-file cases and
// discovery both landed on `pass 2`, and a test that cannot tell "argv was
// honoured" from "argv was discarded" pins nothing.
const SUITE = {
  "t/a.test.mjs": PASSES,
  "t/b.test.mjs": PASSES,
  "t/nested/c.test.mjs": PASSES,
  "root.test.mjs": PASSES,
  "with space/s.test.mjs": PASSES,
  "br[a]cket/g.test.mjs": PASSES,
  "empty/README.md": "",
};

// `node --test <dir>` resolves the directory as a module specifier and dies
// with MODULE_NOT_FOUND before a single test runs. A directory is the
// ergonomic way to say "run this suite", and the red it produced was read as
// a finding against the diff under review rather than against the invocation.
// `pass 3` also pins the recursion: `t/` holds two files and `t/nested/` a
// third, so a `find` capped at one level reads as a red here.
test("runner: a directory argument runs the test files under it", () => {
  const r = apply(SUITE).run("t");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 3/);
});

// `set -f` and IFS only settle how the *shell* splits the expansion. Node
// globs its own argv afterwards, where a literal `[` is a bracket expression
// that cannot match itself — so an unescaped path matches nothing, node runs
// nothing, and it exits 0. That is the vacuous pass this shim exists to
// refuse, reached past the guard because `find` did match the file.
test("runner: a directory whose path holds a glob character still runs its tests", () => {
  const r = apply(SUITE).run("br[a]cket");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 1/);
});

// The other half of the same claim: IFS pinned to a newline is what keeps a
// path with a space in it one word. On the default IFS it splits into two
// words node cannot resolve, and node drops unresolvable arguments silently.
test("runner: a directory whose path holds a space still runs its tests", () => {
  const r = apply(SUITE).run("with space");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 1/);
});

// The sharp edge. `node --test` with zero files exits 0, so an expansion that
// matched nothing and shrugged would smuggle back the vacuous pass the emit
// guard refuses — this time past it, at run time.
test("runner: a directory with no test files refuses instead of exiting 0", () => {
  const r = apply(SUITE).run("empty");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no test files under empty/);
});

test("runner: a file argument still works", () => {
  const r = apply(SUITE).run("t/a.test.mjs");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 1/);
});

// The shell expands a glob before the runner is entered, so the glob form
// reaches it as the plain multi-file argv this asserts on. Only the *matching*
// glob, though: one that matches nothing is handed over unexpanded, is not a
// directory, and so misses the shim entirely — node globs it, matches nothing
// and exits 0. That path is #100, not this test.
test("runner: the expanded glob form still works", () => {
  const r = apply(SUITE).run("t/a.test.mjs", "t/b.test.mjs");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass 2/);
});

// A subtree find cannot descend is the quiet version of the same hazard: find
// still prints what it reached, grep still matches it, and the count guard
// still passes — so the suite goes green having silently skipped whatever the
// unreadable directory held. Root can read anything, so it cannot see this.
test("runner: a directory it cannot fully read refuses instead of running a partial suite", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const a = apply({ ...SUITE, "t/locked/z.test.mjs": PASSES });
  chmodSync(join(a.wt, "t", "locked"), 0o000);
  try {
    const r = a.run("t");
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read every path under t/);
  } finally {
    chmodSync(join(a.wt, "t", "locked"), 0o755);
  }
});

// Node's own discovery excludes `node_modules`; `find` does not, so a vendored
// test ran and the suite's result hung on third-party code passing. The live
// shape is a *real* nested `node_modules` — an install that did not hoist, or
// a bundled dependency. Not pnpm's: its per-package `node_modules` is a
// symlink farm, and `find` without `-L` never descends it.
// The vendor test fails on purpose: the count alone cannot tell "vendor was
// pruned" from "vendor ran and failed", and the exit status alone cannot tell
// "pruned" from "the expansion dropped some of ours" — losing all of them
// refuses with `no test files`, losing a few still exits 0. Both, or neither.
// `node_modules_old/` pins the other direction. Over-pruning is the worse
// bug — it deletes real tests and still exits 0 — and this is its only
// coverage in the fleet suite: an over-broad `*node_modules*` passes every
// other test in this file.
// It is written into the worktree rather than through `repo()` because that is
// where `node_modules` actually comes from — the install step, not a commit —
// and committing it would rest this test on whatever `core.excludesFile` the
// machine happens to have.
test("runner: a vendored test under a nested node_modules does not run", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "t", "node_modules", "vendor");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(
    join(vendor, "v.test.mjs"),
    'import { test } from "node:test";\ntest("VENDOR", () => { throw new Error("not ours"); });\n',
  );
  const lookalike = join(a.wt, "t", "node_modules_old");
  mkdirSync(lookalike, { recursive: true });
  writeFileSync(join(lookalike, "k.test.mjs"), PASSES);
  const r = a.run("t");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Anchored: a bare `pass 4` is a substring and matches `pass 41`, so the pin
  // would dissolve the moment the fixture grows past 40. Both prefixes because
  // `node --test`'s default reporter is version- and TTY-dependent — spec
  // (`ℹ pass 4`) on a terminal and on newer node, tap (`# pass 4`) when older
  // node writes to a pipe, which is every CI run.
  assert.match(r.stdout, /^(?:ℹ|#) pass 4$/m);
});

// Directories are only rewritten for `node --test`. Every other entrypoint is
// somebody else's runner, and vitest and jest take a directory as a filter
// against their own naming conventions, which need not be this regex.
test("runner: the npm entrypoint is emitted without the directory shim", () => {
  const { text } = apply({ "package.json": pkg({ scripts: { test: "vitest" } }) });
  assert.match(text, /^exec npm test -- "\$@"$/m);
  assert.doesNotMatch(text, /no test files under/);
});

// Every row of the install matrix. `true` is the no-op: nothing to install.
for (const [name, files, want] of [
  ["lockfile wins", { "package-lock.json": "{}", "package.json": pkg({ dependencies: { a: "1" } }), [TESTS]: "" }, "npm ci"],
  ["pnpm lockfile", { "pnpm-lock.yaml": "{}", [TESTS]: "" }, "pnpm i --frozen-lockfile"],
  ["yarn lockfile", { "yarn.lock": "{}", [TESTS]: "" }, "yarn --immutable"],
  ["no manifest at all", { [TESTS]: "" }, "true"],
  ["empty dependencies object", { "package.json": pkg({ dependencies: {} }), [TESTS]: "" }, "true"],
  ["null dependencies", { "package.json": pkg({ dependencies: null }), [TESTS]: "" }, "true"],
  ["all four fields empty", { "package.json": pkg({ dependencies: {}, devDependencies: {}, peerDependencies: {}, optionalDependencies: {} }), [TESTS]: "" }, "true"],
  ["empty workspaces array", { "package.json": pkg({ workspaces: [] }), [TESTS]: "" }, "true"],
]) {
  test(`install: ${name} → ${want}`, () => {
    assert.equal(claim(repo(files)).install, want);
  });
}

// No lockfile + anything declared anywhere = refuse. Guessing corrupts the tree.
for (const [name, manifest] of [
  ["dependencies", { dependencies: { a: "1" } }],
  ["devDependencies", { devDependencies: { a: "1" } }],
  ["peerDependencies", { peerDependencies: { a: "1" } }],
  ["optionalDependencies", { optionalDependencies: { a: "1" } }],
  ["workspaces array", { workspaces: ["p/*"] }],
  ["workspaces object", { workspaces: { packages: ["p/*"] } }],
]) {
  test(`install: ${name} without a lockfile refuses`, () => {
    const { err } = claim(repo({ "package.json": pkg(manifest), [TESTS]: "" }));
    assert.match(err, /refusing to guess an install command/);
  });
}

test("install: an unparseable manifest refuses, and says so", () => {
  const { err } = claim(repo({ "package.json": "{,,broken", [TESTS]: "" }));
  assert.match(err, /could not read origin\/main:package\.json/);
  assert.doesNotMatch(err, /refusing to guess an install command/);
});

test("runner: scripts.test wins", () => {
  assert.equal(claim(repo({ "package.json": pkg({ scripts: { test: "vitest" } }) })).testcmd, "npm test --");
});

test("runner: no scripts.test but test files present falls back to node --test", () => {
  assert.equal(claim(repo({ [TESTS]: "" })).testcmd, "node --test");
});

// `node --test` with zero test files exits 0. A runner that passes vacuously is
// worse than a dead one — the review fan-out consumes it as a green suite.
test("runner: no scripts.test and no test files refuses rather than passing vacuously", () => {
  const { err } = claim(repo({ "README.md": "" }));
  assert.match(err, /pass vacuously/);
});

// The worktree is built from origin/main, so every probe must read origin/main.
// Probing $PWD announced "no lockfile" and then built a worktree holding one.
test("origin/main beats the local checkout for the install probe", () => {
  const dir = repo(
    { "package-lock.json": "{}", "package.json": pkg({ dependencies: { a: "1" } }), [TESTS]: "" },
    { "package.json": pkg({ name: "stripped" }) },
  );
  execFileSync("rm", ["-f", join(dir, "package-lock.json")]);
  assert.equal(claim(dir).install, "npm ci");
});

test("a gitignored local package.json cannot influence the probe", () => {
  const dir = repo({ ".gitignore": "package.json\n", [TESTS]: "" }, { "package.json": pkg({ dependencies: { a: "1" } }) });
  assert.equal(claim(dir).install, "true");
});

test("origin/main beats the local checkout for the runner probe", () => {
  const dir = repo({ "package.json": pkg({ scripts: { test: "vitest" } }) }, { "package.json": pkg({ name: "stripped" }) });
  assert.equal(claim(dir).testcmd, "npm test --");
});
