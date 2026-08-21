import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SCRIPT = join(import.meta.dirname, "claim-ticket.sh");

// Build a repo whose origin/main holds `files`. `local` is written to the
// working tree afterwards WITHOUT committing — that is how a checkout diverges
// from the ref the worktree is actually built from.
// `parent` is where the repo itself is created. It matters because the runner
// judges an argument by where its resolution diverges from the runner's OWN
// location, so a `node_modules` component in the repo's own ancestry is part of
// what the guard has to ignore — and only a fixture built under one can pin it.
function repo(files, local = {}, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, "claim-"));
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
// `script` defaults to the real one; pass a copy to claim from a different
// template.
function apply(files, script = SCRIPT, parent = tmpdir()) {
  const dir = repo(files, {}, parent);
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = spawnSync("sh", [script, "42", "slug", "fix", "--apply"], {
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
  // FORCE_COLOR is stripped for the same reason: it reaches the runner's own
  // `node --test`, which then SGR-wraps its summary even into a pipe
  // (`\x1b[34mℹ pass 3\x1b[39m`), breaking every `run`/`runFrom` assertion
  // that reads that summary literally. A developer with FORCE_COLOR set is
  // exactly what these assertions have to survive, not exercise.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.FORCE_COLOR;
  return {
    wt,
    text: readFileSync(join(wt, "agent-test"), "utf8"),
    run: (...args) => spawnSync(join(wt, "agent-test"), args, { cwd: wt, encoding: "utf8", env }),
    // The same runner invoked from a subdirectory. Node resolves argv against
    // the cwd, so where a member stands is part of what an argument means.
    runFrom: (sub, ...args) =>
      spawnSync(join(wt, "agent-test"), args, { cwd: join(wt, sub), encoding: "utf8", env }),
  };
}

test("a zero-padded issue is refused", () => {
  // #121: `$issue` reaches a JSON number slot (`"issue":%s`), where all-digits
  // is not enough — RFC 8259 forbids a leading zero, so `007` emitted
  // `{"issue":007,…}` that no parser accepts. It also reaches `$((16000 +
  // issue))`, where /bin/sh reads `010` as octal 8 and refuses `008` outright,
  // so a padded number could silently derive another claim's ports.
  // Two widths, because one does not pin the guard: `0?*` narrowed to `0??*`
  // still refuses `007` and re-admits `01`, which is the same bug back.
  for (const padded of ["007", "01"]) {
    const r = spawnSync("sh", [SCRIPT, padded, "slug", "fix"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 2, padded);
    assert.match(r.stderr, /issue must be a number/);
  }
});

test("a bare 0 clears the numeric guard", () => {
  // `0?*`, not `0*`: #121 lists `sh inflight.sh 0 -> parses` among its PASSING
  // cases, beside `42`. A bare `0` is a valid RFC 8259 number and `$((0))` is
  // `0`, so neither hazard the guard exists to close applies to it. Widening
  // the arm would refuse a value the ticket's own worked example shows working.
  const r = spawnSync("sh", [SCRIPT, "0", "slug", "fix"], { cwd: tmpdir(), encoding: "utf8" });
  assert.doesNotMatch(r.stderr, /issue must be a number/);
  // Positive, not just the absence of one string: `0` has to reach the *next*
  // precondition. A refusal worded differently, or added ahead of the guard,
  // never gets here and cannot leave this message behind.
  assert.match(r.stderr, /not inside a git repository/);
});

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
  // Bounded rather than line-anchored: a bare `pass 3` is a substring of
  // `pass 3<n>` and stops discriminating once a fixture reaches 30, but a
  // `^…$/m` anchor buys that at the cost of the line's raw edges — under a
  // colored reporter the summary comes back SGR-wrapped (`\x1b[34mℹ pass 3…`),
  // so it neither starts with the prefix nor ends with the digit. The reporter
  // prefix plus a `(?!\d)` lookahead rejects `pass 30`-`pass 39` either way.
  // Both prefixes because `node --test`'s default reporter is
  // version-dependent — spec (`ℹ pass 3`) on newer node, tap (`# pass 3`) on
  // older.
  assert.match(r.stdout, /(?:ℹ|#) pass 3(?!\d)/);
});

// `set -f` and IFS only settle how the *shell* splits the expansion. Node
// globs its own argv afterwards, where a literal `[` is a bracket expression
// that cannot match itself — so an unescaped path matches nothing, node runs
// nothing, and it exits 0. That is the vacuous pass this shim exists to
// refuse, reached past the guard because `find` did match the file.
test("runner: a directory whose path holds a glob character still runs its tests", () => {
  const r = apply(SUITE).run("br[a]cket");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Bounded, same reason as above: a bare `pass 1` is the worst offender — it
  // matches every count whose leading digit is 1: `pass 1` itself, 10-19, 100+.
  assert.match(r.stdout, /(?:ℹ|#) pass 1(?!\d)/);
});

// The other half of the same claim: IFS pinned to a newline is what keeps a
// path with a space in it one word. On the default IFS it splits into two
// words node cannot resolve, and node drops unresolvable arguments silently.
test("runner: a directory whose path holds a space still runs its tests", () => {
  const r = apply(SUITE).run("with space");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Bounded, same reason as the glob-character case above.
  assert.match(r.stdout, /(?:ℹ|#) pass 1(?!\d)/);
});

// Why the trailing slash, and why not `-L`: claim-ticket.sh, above `found=`.
// The symlink is written into the worktree rather than through `repo()` because
// the runner only ever stats a path in its cwd — whether a commit or a local
// `ln -s` put it there is invisible to it — and keeping it out of the shared
// fixture leaves every other count assertion in this file measuring what it
// measured before.
test("runner: a symlink to a directory runs the test files under it", () => {
  const a = apply(SUITE);
  symlinkSync("t", join(a.wt, "tlink"));
  // `t/vendor` is the shape neither exclusion can see: a symlink into
  // `node_modules` under another name — `-prune` matches the directory's own
  // name and this one is called `vendor`, and the `case` guard reads the
  // argument, which neither spells nor resolves into one. Measured: it
  // is exactly as blind as the `-not -path` filter it replaced, both legs.
  // The slash form does not descend it and reads 3; `find -L`
  // sweeps the vendored test in and reads 4. Without this every test passes
  // under `-L`, leaving the reasoning in claim-ticket.sh as the only thing
  // between a future tidy-up and a suite resting on third-party code.
  mkdirSync(join(a.wt, "node_modules"), { recursive: true });
  writeFileSync(join(a.wt, "node_modules", "v.test.mjs"), PASSES);
  symlinkSync("../node_modules", join(a.wt, "t", "vendor"));
  const r = a.run("tlink");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Anchored for the same reason as the vendored-test count below: bare
  // `pass 3` is a substring of `pass 3<n>` and stops discriminating once a
  // fixture grows. 3 is `t/`'s own two files plus the one under `t/nested/`,
  // so a `find` capped at one level reads as a red here too.
  assert.match(r.stdout, /^(?:ℹ|#) pass 3$/m);
});

// #186: the argument itself is a symlink whose TARGET lies inside a vendored
// tree. Spelling can't see it — `vendlink` carries no `node_modules` in its
// own name — and `-prune` only fires on a dirent the walk descends THROUGH
// named `node_modules`; here the walk starts at the symlink's target,
// already past the vendored component, so neither existing guard sees it.
// Measured on the unfixed shim: `agent-test vendlink` exits 0 and reports
// the vendored test as a pass — the same green-over-third-party-code #109's
// prune exists to refuse, reached by a route neither mechanism covers.
test("runner: a symlink whose target is inside a vendored tree refuses", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("node_modules", "pkg"), join(a.wt, "vendlink"));
  const r = a.run("vendlink");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /is under node_modules — excluded from the run/);
});

// The false-positive class of the same fix: a symlink to a directory that
// merely CONTAINS a vendored tree, rather than one whose own resolution ends
// inside it, must still run that directory's own tests and still exclude the
// real `node_modules` beneath it. Already true pre-fix (find's own prune
// handles it once the walk is inside), and must stay true — a resolved-path
// guard that widens into refusing every symlinked directory with
// `node_modules` somewhere underneath would regress this ordinary case.
test("runner: a symlink to a directory containing a vendored tree still runs its own tests", () => {
  const a = apply(SUITE);
  mkdirSync(join(a.wt, "proj"), { recursive: true });
  writeFileSync(join(a.wt, "proj", "ok.test.mjs"), PASSES);
  const vendor = join(a.wt, "proj", "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(
    join(vendor, "v.test.mjs"),
    'import { test } from "node:test";\ntest("VENDOR", () => { throw new Error("not ours"); });\n',
  );
  symlinkSync("proj", join(a.wt, "projlink"));
  const r = a.run("projlink");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 1$/m);
});

// The vendored tree the symlink lands in need not be inside the worktree.
// Judging the resolution RELATIVE TO THE WORKTREE ROOT passes every other test
// in this file and still runs this one green — the resolution lands outside, so
// there is nothing left to compare — which is #186's own class one input over.
// Both directions are here because the cheap over-correction (refuse anything
// resolving outside) also passes the refusal leg alone.
test("runner: a symlink to a vendored tree outside the worktree refuses", () => {
  const a = apply(SUITE);
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const vendor = join(outside, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(vendor, join(a.wt, "extlink"));
  const r = a.run("extlink");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /is under node_modules — excluded from the run/);
  const plain = join(outside, "lib");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "o.test.mjs"), PASSES);
  symlinkSync(plain, join(a.wt, "oklink"));
  const ok = a.run("oklink");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^(?:ℹ|#) pass 1$/m);
});

// The opposite error, and the one that actually shipped: `pwd -P` is absolute,
// so matching `*/node_modules/*` against it refuses on a `node_modules` in the
// WORKTREE'S OWN ANCESTRY — which is shared with the runner and says nothing
// about the argument. Measured on the unfixed shim: a worktree under such a
// parent refused every directory argument, the bare invocation's implicit `.`
// included, so the whole suite became unrunnable. No other fixture in this file
// is built under a `node_modules` parent, so nothing else can see it.
test("runner: a node_modules in the worktree's own ancestry refuses nothing", () => {
  const under = join(mkdtempSync(join(tmpdir(), "anc-")), "node_modules");
  mkdirSync(under, { recursive: true });
  const a = apply(SUITE, SCRIPT, under);
  for (const [args, count] of [[[], 6], [["."], 6], [["t"], 3]]) {
    const r = a.run(...args);
    assert.equal(r.status, 0, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^(?:ℹ|#) pass ${count}$`, "m"));
  }
  // ...and the guard still bites inside such a worktree.
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("node_modules", "pkg"), join(a.wt, "vendlink"));
  const r = a.run("vendlink");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /is under node_modules — excluded from the run/);
});

// The guard resolves `$arg` against the process cwd, but `$root` against the
// runner's own location, so the two are no longer the same anchor and a
// subdirectory invocation exercises a different path than a root one. Measured:
// anchoring the argument at `$root` instead (`cd -- "$root/$arg"`, a one-token
// slip now that `$root` sits on the line above) is green on every OTHER test in
// this file while reporting the vendored test as a pass from one directory down.
// Second leg stops the fix degenerating into "refuse everything named from a
// subdirectory"; the stderr assert is load-bearing, since status alone cannot
// tell a refusal from a vendored test that threw.
test("runner: the resolved-path guard resolves against the cwd, from a subdirectory too", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("..", "node_modules", "pkg"), join(a.wt, "t", "vendlink"));
  const refused = a.runFrom("t", "vendlink");
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /is under node_modules — excluded from the run/);
  const ran = a.runFrom("t", "nested");
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^(?:ℹ|#) pass 1$/m);
});

// The false-positive leg of the resolved-path guard. The nested-node_modules
// test below pins `-prune`'s immunity to a `node_modules_old` lookalike, not
// this guard's: its argument is `t`, so neither half of the composed
// `"/$arg/ /…/"` string ever carries the lookalike and the `case` never sees
// one. Here only the RESOLUTION does — `vlink` is clean in spelling — which is
// the leg #186 added. Measured: relaxing the slash-bounding to `*node_modules*`
// leaves every other test in this file green and reddens only this one.
test("runner: a symlink resolving into a node_modules lookalike still runs", () => {
  const a = apply(SUITE);
  const lookalike = join(a.wt, "node_modules_old", "pkg");
  mkdirSync(lookalike, { recursive: true });
  writeFileSync(join(lookalike, "k.test.mjs"), PASSES);
  symlinkSync(join("node_modules_old", "pkg"), join(a.wt, "vlink"));
  const r = a.run("vlink");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 1$/m);
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
  // Bounded, same reason as the other bare `pass 1` cases above.
  assert.match(r.stdout, /(?:ℹ|#) pass 1(?!\d)/);
});

// The shell expands a glob before the runner is entered, so the glob form
// reaches it as the plain multi-file argv this asserts on. Only the *matching*
// glob, though: one that matches nothing is handed over unexpanded, is not a
// directory, and so misses the shim entirely — node globs it, matches nothing
// and exits 0. That path is #100, not this test.
test("runner: the expanded glob form still works", () => {
  const r = apply(SUITE).run("t/a.test.mjs", "t/b.test.mjs");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Bounded, same reason as above: a bare `pass 2` is a substring of
  // `pass 2<n>` and stops discriminating once a fixture reaches 20.
  assert.match(r.stdout, /(?:ℹ|#) pass 2(?!\d)/);
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

// The point of `-prune` over a path filter: content under `node_modules` is
// excluded from the run either way, so its readability cannot change the
// verdict. An unreadable directory *in* it used to still fail `find` and trip
// the guard above — a loud but pointless stall. Pruning skips descending
// `node_modules` entirely, so this directory's permissions are never even
// read. `pass 3` — the same count as the bare "t" case — pins that: the
// locked directory is empty and is never descended, so nothing about it can
// move the count or the status. Mutation-checked: reverting the walk to the
// `-not -path` filter, or typoing the prune's name, fails this test.
test("runner: an unreadable directory under node_modules no longer refuses the suite", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const a = apply(SUITE);
  const locked = join(a.wt, "t", "node_modules", "locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    const r = a.run("t");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^(?:ℹ|#) pass 3$/m);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// Same directories, six spellings of the argument. The top-level pair alone
// is not coverage of "a vendored argument": `-prune` fires only where the
// walk DESCENDS through a `node_modules` dirent, so an argument at or under
// one prunes nothing and prints every file beneath it. Measured against the
// prune alone, the four spellings below the top level all ran their vendored
// test and exited 0 — the vacuous vendored green this shim exists to refuse.
// Only the `case` guard covers them, which is why every spelling is here.
// The message is asserted too, not just the status: falling through to the
// emptiness guard would report a deliberate exclusion as an absence and send
// a reader after a discovery bug that does not exist.
test("runner: a vendored directory argument refuses however it is spelled", () => {
  const a = apply(SUITE);
  mkdirSync(join(a.wt, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(a.wt, "t", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(a.wt, "node_modules", "v.test.mjs"), PASSES);
  writeFileSync(join(a.wt, "node_modules", "pkg", "v.test.mjs"), PASSES);
  writeFileSync(join(a.wt, "t", "node_modules", "v.test.mjs"), PASSES);
  writeFileSync(join(a.wt, "t", "node_modules", "pkg", "v.test.mjs"), PASSES);
  for (const spelling of [
    "node_modules",
    "./node_modules",
    "node_modules/pkg",
    "t/node_modules",
    "t/node_modules/pkg",
    join(a.wt, "node_modules", "pkg"),
  ]) {
    const r = a.run(spelling);
    assert.notEqual(r.status, 0, `${spelling}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /is under node_modules — excluded from the run/, spelling);
    assert.doesNotMatch(r.stderr, /no test files under/, spelling);
  }
});

// #100: node counts argv separately from the runner's own `find`, and a file
// or glob argument reaches node with no check of its own. Node drops an
// argument it cannot resolve and exits non-zero only when it refuses every
// argument in argv — mixed with anything valid, the discard is silent and
// the runner used to exit 0 having run less than it was asked. These pin the
// shapes node discards: a typo, a file under `node_modules` however it is
// spelled, a path holding a `[`, and (the one deliberately left alone) an
// unmatched glob — plus the two it does NOT discard, a flag and a vendored
// spelling node runs anyway, which the guard must not refuse in their place.

// The repro from the issue itself: alone a typo is loud (node's own
// `Could not find`, exit 1) — mixed with a real file, node ran the one file
// and exited 0, and the runner reported a pass for a suite that only half
// ran. Named, not just refused: `no test files under` or a bare non-zero
// would both send a reader after the wrong bug.
test("runner: a typo'd path mixed with a valid one refuses and names the typo", () => {
  const r = apply(SUITE).run("t/a.test.mjs", "t/typo.test.mjs");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /t\/typo\.test\.mjs does not exist/);
});

test("runner: a typo'd path alone still refuses", () => {
  const r = apply(SUITE).run("t/typo.test.mjs");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /t\/typo\.test\.mjs does not exist/);
});

// #125's surviving case, per the issue's "Agent Brief": a vendored *file*
// argument bypasses the directory branch entirely (that guard only ever sees
// what `[ -d ]` is true for), so node — not this shim — is what would drop
// it, and only when something else in argv resolves. Written into the
// worktree rather than through `repo()` for the same reason as the nested
// node_modules test above: this is what an unhoisted install produces, not
// something anyone commits.
// Four spellings, because one is not the class. `./` is the second literal
// form, and dropping either alternative from a prefix match would go
// uncaught with only the first pinned. `t/../node_modules/…` is why the
// guard resolves the argument's own directory rather than matching a prefix
// at all: node normalizes before applying its rule, so that spelling is
// excluded too (measured directly against node v26.5.0 — `tests 1` for a
// two-file argv) and a literal prefix misses it. And the `*` spelling is why
// the vendored check runs BEFORE the glob classification: a metacharacter
// anywhere in a vendored path used to route it into the passthrough arm and
// out of this refusal entirely.
test("runner: a vendored file argument refuses however it is spelled", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  for (const spelling of [
    "node_modules/pkg/v.test.mjs",
    "./node_modules/pkg/v.test.mjs",
    "t/../node_modules/pkg/v.test.mjs",
    "node_modules/pkg/*.test.mjs",
  ]) {
    const r = a.run("t/a.test.mjs", spelling);
    assert.notEqual(r.status, 0, `${spelling}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /is under node_modules — node discards it silently/, spelling);
  }
});

// The other half of the same rule, and the guard against over-widening it.
// Node's exclusion fires only when the argument's normalized RELATIVE form
// starts with `node_modules/`: a deeper segment and an absolute path are NOT
// excluded — node runs both and counts them, so there is no silent drop to
// refuse and refusing them would reject argv node handles fine. `pass 2` is
// what says the vendored file ran rather than being dropped, so borrowing
// the directory branch's own `*/node_modules/*` pattern here reddens this.
test("runner: the vendored file spellings node runs are not refused", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  const nested = join(a.wt, "t", "node_modules", "pkg");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "n.test.mjs"), PASSES);
  for (const spelling of [
    "t/node_modules/pkg/n.test.mjs",
    join(a.wt, "node_modules", "pkg", "v.test.mjs"),
  ]) {
    const r = a.run("t/a.test.mjs", spelling);
    assert.equal(r.status, 0, `${spelling}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^(?:ℹ|#) pass 2$/m, spelling);
  }
});

// Node's exclusion is anchored at the cwd its arguments are relative to —
// that is what "relative form" means, and it is what separates mirroring the
// rule from matching a prefix. The two fixture files below swap verdicts on
// nothing but where the runner is invoked from: at the worktree root
// `node_modules/pkg/v.test.mjs` is the dropped one and `t/node_modules/…`
// runs, while from inside `t/` the polarity inverts — `node_modules/pkg/…`
// now names the nested file and is dropped, `../node_modules/pkg/…` names
// the root one and runs. Measured against node itself, both ways. A guard
// anchored at the worktree root rather than the cwd gets both backwards and
// no other test in this file would see it.
test("runner: the vendored rule is anchored at the cwd, as node's is", () => {
  const a = apply(SUITE);
  for (const p of ["node_modules/pkg", "t/node_modules/pkg"]) {
    mkdirSync(join(a.wt, p), { recursive: true });
    writeFileSync(join(a.wt, p, "v.test.mjs"), PASSES);
  }
  const refused = a.runFrom("t", "a.test.mjs", "node_modules/pkg/v.test.mjs");
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /is under node_modules — node discards it silently/);
  const ran = a.runFrom("t", "a.test.mjs", "../node_modules/pkg/v.test.mjs");
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^(?:ℹ|#) pass 2$/m);
});

// The issue's own second case, verbatim: "and, before PR #75's escape,
// bracketed paths". Node globs its own argv, where a literal `[` is a bracket
// expression that cannot match itself — so the path matches nothing, node
// drops it, and mixed with a resolvable file that drop is silent: the runner
// reported `pass 1` for a two-file argv and exited 0. The escape is the same
// `sed 's/\[/[[]/g'` the directory branch already applies to find's output,
// and asking whether the path EXISTS before reading it as a glob is what
// gets the argument to it. Both invocations are here because they fail
// differently without the escape: mixed goes quiet, alone exits 1 because
// node then has nothing left to run.
test("runner: a bracketed file argument runs, alone and mixed with a valid one", () => {
  const a = apply(SUITE);
  const mixed = a.run("t/a.test.mjs", "br[a]cket/g.test.mjs");
  assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);
  assert.match(mixed.stdout, /^(?:ℹ|#) pass 2$/m);
  const alone = a.run("br[a]cket/g.test.mjs");
  assert.equal(alone.status, 0, alone.stdout + alone.stderr);
  assert.match(alone.stdout, /^(?:ℹ|#) pass 1$/m);
});

// A flag is not a path, and only node can judge one. Reading an argument
// that does not exist as a typo refused every documented `node --test` flag
// as a missing file — argv that ran fine before this guard existed, and
// nothing else in this suite passes a flag. Node takes flag values with `=`
// (measured: the space-separated form exits 9 at node itself), so a flag is
// always one argv entry and passing it through cannot swallow a path. A
// typo'd flag stays loud without this runner's help: node rejects it and
// exits 9, which is why the last assertion insists the refusal is NOT
// `agent-test:`-prefixed.
test("runner: a node --test flag reaches node instead of being read as a path", () => {
  const a = apply(SUITE);
  for (const flag of [
    "--test-name-pattern=ok",
    "--test-only",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "--",
  ]) {
    const r = a.run(flag, "t/a.test.mjs");
    assert.equal(r.status, 0, `${flag}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /does not exist/, flag);
  }
  const typo = a.run("--test-nmae-pattern=ok", "t/a.test.mjs");
  assert.notEqual(typo.status, 0, typo.stdout + typo.stderr);
  assert.doesNotMatch(typo.stderr, /agent-test:/, typo.stdout + typo.stderr);
});

// The deliberately preserved escape hatch: `set -f` above stops the *shell*
// from touching this, so a literal `*` reaches the runner exactly as the
// glob-detection guard requires — spawnSync never invokes a shell, so this
// is the same argv a member's own shell produces for a quoted glob. Only
// node can expand it, and here it matches real files, so it must still run
// them rather than being refused as "does not exist".
test("runner: a quoted glob argument still runs, unexpanded by the shell", () => {
  const r = apply(SUITE).run("t/*.test.mjs");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 2$/m);
});

// A valid mix of both argument shapes the passthrough branch and the
// directory branch each handle — neither new guard may refuse an argument
// that was never in question.
test("runner: a mixed argv of files and directories still runs everything", () => {
  const r = apply(SUITE).run("t/a.test.mjs", "t/nested");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 2$/m);
});

// #97: a bare invocation must go through the same expansion as an explicit
// ".", not fall through to node's own default discovery. `for arg do` with no
// `in` clause iterates "$@", so on an empty argv the loop body never ran and
// the runner fell straight to bare `node --test`. Mixing a `.spec.` file into
// the plain SUITE is what makes `pass 7` discriminate: SUITE alone is *not* a
// counter-example, since node's own default discovery happens to match every
// `.test.mjs` name in it too — a fixture that pinned "6" against SUITE would
// stay green under the pre-fix bare `node --test` and prove nothing.
test("runner: a bare invocation runs the same suite as an explicit \".\"", () => {
  const a = apply({ ...SUITE, "t/d.spec.mjs": PASSES });
  const dot = a.run(".");
  assert.equal(dot.status, 0, dot.stdout + dot.stderr);
  assert.match(dot.stdout, /^(?:ℹ|#) pass 7$/m);
  const bare = a.run();
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.match(bare.stdout, /^(?:ℹ|#) pass 7$/m);
});

// The sharpest edge of #97: node's own default discovery does not recognise
// the `.spec.` form, so a repo whose only test file uses it went green over
// zero tests run under the pre-fix bare invocation. This is the exact
// fixture from the issue's own repro.
test("runner: a bare invocation runs .spec. files, which node's own discovery does not", () => {
  const r = apply({ "t/a.spec.mjs": PASSES }).run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 1$/m);
});

// A repo with zero test files anywhere never reaches this runner at all —
// derive-testcmd.sh refuses at emit time before a runner is written, pinned
// by "runner: no scripts.test and no test files refuses rather than passing
// vacuously" below. Nothing about that guard changes here — and where the two
// disagree, they disagree safely: the emit guard greps `git ls-tree`, which
// excludes neither `node_modules` nor symlinks, while this walk prunes the
// first and `-type f` drops the second. A repo whose only committed test files
// are vendored or symlinked therefore does reach the runner, and gets the
// emptiness guard's `no test files under .` at exit 1 — a loud refusal, never
// a vacuous pass. Pinned here rather than asserted: the block above used to
// claim this state was unreachable, and the only `no test files under` pins in
// the file were an explicit directory argument and two `doesNotMatch`. Vendored
// is the cheaper of the two shapes to build — the symlink one needs a mode
// 120000 entry that `apply()` cannot express — and both end in the same guard.
// Pre-fix this is the vacuous green #97 exists to refuse: node's own discovery
// skips `node_modules`, finds nothing, and exits 0 over `tests 0`.
test("runner: a bare invocation refuses a repo whose only test files are vendored", () => {
  const r = apply({ "node_modules/pkg/v.test.mjs": PASSES }).run();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /no test files under \./);
});

// The blocker named in the issue body (defaulting to "." would sweep vendored
// tests) was discharged by #109's node_modules exclusion before this landed.
// Confirm the defaulted path actually goes through that prune rather than
// bypassing it some other way.
// Both fixture choices carry the pin; neither is decoration. The `.spec.`
// file is what makes the count discriminate #97 — SUITE alone reads `pass 6`
// under the pre-fix bare `node --test` too, since node's own discovery
// matches every `.test.mjs` name in it and already skips node_modules, so a
// fixture pinning "6" here is exactly the hollow one the comment above
// warns about. And the vendored file is NESTED rather than sitting at the
// worktree root because node refuses an argv entry whose relative path
// starts with `node_modules/`, dropping it silently while the rest of argv
// resolves (#100). At the root that refusal stands in for the prune:
// measured with the prune deleted, a root-level fixture still reads
// `pass 7` and still exits 0, so the assertion cannot tell this shim's walk
// from node's own behaviour. Nested, only the prune keeps the file out.
// `pass 7` rather than `pass 8`, over a vendored test that fails on
// purpose, is what says it ran.
test("runner: a bare invocation excludes vendored tests under node_modules", () => {
  const a = apply({ ...SUITE, "t/d.spec.mjs": PASSES });
  const vendor = join(a.wt, "t", "node_modules");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), 'import { test } from "node:test";\ntest("VENDOR", () => { throw new Error("not ours"); });\n');
  const r = a.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 7$/m);
});

// Directories are only rewritten for `node --test`. Every other entrypoint is
// somebody else's runner, and vitest and jest take a directory as a filter
// against their own naming conventions, which need not be this regex.
test("runner: the npm entrypoint is emitted without the directory shim", () => {
  const { text } = apply({ "package.json": pkg({ scripts: { test: "vitest" } }) });
  assert.match(text, /^exec npm test -- "\$@"$/m);
  assert.doesNotMatch(text, /no test files under/);
});

// #124: the runner is written once at claim time and never rewritten, so an
// old worktree can hold a runner a later template fix never reached. Nothing
// in the file said which template produced it — this pins the fix, on both
// entrypoint forms, since the stamp line is emitted before the branch that
// tells them apart.
const STAMP_RE = /^# agent-test template: (\S+)$/m;

test("runner: carries a template stamp on the npm entrypoint", () => {
  const { text } = apply({ "package.json": pkg({ scripts: { test: "vitest" } }) });
  assert.match(text, STAMP_RE);
});

test("runner: carries a template stamp on the node --test entrypoint", () => {
  const { text } = apply(SUITE);
  assert.match(text, STAMP_RE);
});

// Same script, two claims — the stamp is a property of the template, not the
// instance, so it must not vary with the issue number, ports, or install
// command baked into the rest of the file.
test("runner: the stamp is stable across claims of the same template", () => {
  const a = apply(SUITE).text.match(STAMP_RE)[1];
  const b = apply(SUITE).text.match(STAMP_RE)[1];
  assert.equal(a, b);
});

// The other half: point a claim at a byte-for-byte-different copy of the
// script and the stamp must move. Copying rather than editing the real
// script in place keeps this test from mutating the file under test.
test("runner: the stamp changes when the template's content changes", () => {
  const scriptDir = mkdtempSync(join(tmpdir(), "claim-script-"));
  const editedScript = join(scriptDir, "claim-ticket.sh");
  writeFileSync(editedScript, readFileSync(SCRIPT, "utf8") + "\n# a harmless edit\n");
  // claim-ticket.sh resolves two siblings relative to itself
  // (`$(dirname -- "$0")`): derive-testcmd.sh for the testcmd, and json.sh for
  // the payload escaping (#119). Both have to travel with this edited copy or
  // the script refuses before it emits anything — which is the guard working,
  // not a regression.
  const sibling = join(scriptDir, "derive-testcmd.sh");
  copyFileSync(join(import.meta.dirname, "derive-testcmd.sh"), sibling);
  chmodSync(sibling, 0o755);
  copyFileSync(join(import.meta.dirname, "json.sh"), join(scriptDir, "json.sh"));

  const after = apply(SUITE, editedScript).text.match(STAMP_RE)[1];
  const before = apply(SUITE).text.match(STAMP_RE)[1];

  assert.notEqual(after, before);
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

// Regression control for the ndeps fix above (String(…) around the reduce in
// claim-ticket.sh): Node's console.log SGR-wraps a bare number whenever
// FORCE_COLOR is set (`\x1b[33m0\x1b[39m`), and `[ "$ndeps" = 0 ]` in the
// script does not match that. Forced into THIS spawn's own env, not
// process.env, so apply()/claim()'s scrubbing elsewhere is irrelevant here —
// this pins the script's own robustness, not an absence of FORCE_COLOR in
// whatever ran the suite.
test("a FORCE_COLOR'd caller still resolves a dependency-free manifest", () => {
  const dir = repo({ "package.json": pkg({}), [TESTS]: "" });
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /install: true/);
});

test("runner: scripts.test wins", () => {
  assert.equal(claim(repo({ "package.json": pkg({ scripts: { test: "vitest" } }) })).testcmd, "npm test --");
});

test("runner: no scripts.test but test files present falls back to node --test", () => {
  assert.equal(claim(repo({ [TESTS]: "" })).testcmd, "node --test");
});

// `node --test` with zero test files exits 0. A runner that passes vacuously is
// worse than a dead one — the review fan-out consumes it as a green suite.
// Anchored on THIS script's own prefix, not on `pass vacuously` alone: the
// nested derive-testcmd.sh writes its reason to a stderr that claim-ticket.sh
// does not redirect, so the loose form is satisfied by the child's line and
// stays green while claim-ticket's own `die` prints a bare `claim-ticket: `
// with nothing after the colon. Anchoring is what makes the capture's `2>&1`
// a pinned invariant rather than a promise. `.` does not cross a newline, so
// this matches only when one line carries both.
test("runner: no scripts.test and no test files refuses rather than passing vacuously", () => {
  const { err } = claim(repo({ "README.md": "" }));
  assert.match(err, /claim-ticket: .*pass vacuously/);
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

// #128: the lockfile-mutation check reads the same worktree-status hole
// no-undo-audit.sh, reap.sh and worktree-audit.sh share. Delete the
// worktree's own .git between `worktree add` and this check and `git -C`
// does not fail — it walks UP to the enclosing repo and answers about THAT
// at rc 0, which the old check would read as an untouched lockfile it never
// actually looked at. Simulated with a shimmed `npm` standing in for an
// install that corrupts the worktree's own linkage, whatever a real cause for
// that would be — this guard does not get to assume a cause, only detect the
// hole.
// The other half of the same guard: `-f` is false for a `.git` that is absent
// AND for one this process may not stat, so an install that leaves $wt
// unsearchable was reported as a deletion — sending whoever cleans up (a
// created worktree, a created branch and an in-progress label are left behind)
// after a `.git` file that is sitting right there. Both refusals exit 2; only
// the stated cause differs, which is exactly what triage reads.
test("an unsearchable worktree refuses with git's own denial, never an absence nothing established", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Runs with cwd=$wt, so this strips the search bit off the worktree itself
  // and leaves .git entirely intact — the discriminating input.
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nchmod 000 .\nexit 0\n", { mode: 0o755 });

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  // Before the first assert: a red must not strand a directory nothing can
  // remove.
  chmodSync(join(dir, ".worktrees", "42-slug"), 0o755);

  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /has no \.git file/, "the .git file was never deleted, only made unreachable");
  assert.match(r.stderr, /could not verify lockfile state/);
  assert.match(r.stderr, /Permission denied/, "git's own denial, not one this script invented");
  assert.equal(existsSync(join(dir, ".worktrees", "42-slug", ".git")), true);
});

test("a worktree whose .git vanishes during install refuses instead of trusting a leaked parent status", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nrm -rf .git\nexit 0\n", { mode: 0o755 });

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2);
  assert.match(r.stderr, /has no \.git file — cannot verify the lockfile was not mutated/);
});

// #188: `[ -e ]` stats, so it FOLLOWS symlinks, while `git worktree add` refuses
// on lstat semantics. A DANGLING symlink at $wt splits the two — the guard looks
// through it and sees nothing, while the path is still occupied and still fails
// the `worktree add` below. `-L` closes that gap, and it is the same predicate
// release-ticket.sh already ships as `occupied()`, for residue THIS fleet
// leaves: where a symlink points AT the registered worktree directory, `git
// worktree remove` deletes the directory and returns 0, leaving the link behind
// and now dangling.
//
// The DRY RUN is the discriminating mode, and it is this script's default. Under
// `--apply` both spellings do land on exit 2, but base only gets there having
// already labelled the issue and stranded the branch ref `git worktree add`
// created before dying — the ticket's own framing — and the dry run is where
// they diverge outright (measured, git 2.50.1):
//
//   dangling symlink, base    exit 0  + a receipt naming the path as claimable
//   dangling symlink, fixed   exit 2  claim-ticket: … already exists
//   real directory,   both    exit 2  claim-ticket: … already exists
//
// So base does not merely misdiagnose the path, it PREDICTS a claim that cannot
// be made. `--apply` is left unpinned deliberately: it reaches this same guard on
// the same line, so the cheap mode is already the one that fails.
//
// The third row is this test's own, and was unheld until now: #188 did not touch
// the `-e` half, and deleting it outright — leaving `[ -L "$wt" ] && die` — left
// the whole suite green. It is pinned in the dry run for the same reason the
// first row is: `git worktree add` never runs in this mode to refuse the occupied
// path on its own, so a regression there surfaces as exit 0 and a receipt naming
// the path claimable, not as somebody else's later refusal.
//
// Both directions, because a guard that refused everything would satisfy the
// refusal alone. `-L` is true for ANY symlink, so the accept case is what
// establishes it did not widen into one: measured on git 2.50.1, every path `-L`
// newly refuses (dangling link, symlink loop) is a path `git worktree add`
// refuses too, and an unoccupied path must still claim.
test("a dangling symlink and a real directory are both refused, and a free path still claims", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  mkdirSync(join(dir, ".worktrees"), { recursive: true });
  symlinkSync("/nonexistent-target", join(dir, ".worktrees", "42-slug"));

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 2, "a path occupied by a dangling link is a refusal, not a claimable path");
  assert.match(r.stderr, /\.worktrees\/42-slug already exists — ticket may already be claimed/,
    "this script's own diagnosis, not git's bare `fatal: … already exists` from inside the next mutation");
  assert.equal(r.stdout, "", "and no receipt: nothing here is claimable, so there is nothing to predict");

  // The `-e` half of the same line — a REAL directory at $wt, no symlink.
  const occupied = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  mkdirSync(join(occupied, ".worktrees", "42-slug"), { recursive: true });
  const d = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: occupied, encoding: "utf8" });
  assert.equal(d.status, 2, "an occupied directory is a refusal too, in the mode with no downstream net");
  assert.match(d.stderr, /\.worktrees\/42-slug already exists — ticket may already be claimed/);
  assert.equal(d.stdout, "", "and no receipt: an unguarded real directory is exit 0 and a claim prediction");

  // The input the guard must ACCEPT — same script, same mode, nothing at $wt.
  const free = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  const ok = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: free, encoding: "utf8" });
  assert.equal(ok.status, 0, "`-L` must not refuse a path that is simply not there");
  assert.match(ok.stdout, /"worktree":"\.worktrees\/42-slug"/);
});

// --- #119: the payload's own string fields.
//
// `$issue` is guarded (`case … ''|*[!0-9]*|0?*`), but `<slug>` and `<type>` are
// not, and all four string fields derive from them: `branch` is
// `$type/$issue-$slug`, `worktree` is `.worktrees/$issue-$slug`, `runner` is
// `$worktree/agent-test`. Spliced raw, a quote in either argument emitted a
// payload no parser accepts — at exit 0, and under `--apply` after the worktree
// and the label had already been created.
test("a quote in the slug still emits parseable JSON", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", 'sl"ug', "fix"], { cwd: dir, encoding: "utf8" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.branch, 'fix/42-sl"ug');
  assert.equal(json.worktree, '.worktrees/42-sl"ug');
  assert.equal(json.runner, '.worktrees/42-sl"ug/agent-test');
  assert.equal(json.issue, 42, "still a JSON number, not a string — the numeric fields are not wrapped");
});

test("a backslash in the slug is escaped too", () => {
  // The worktree path is a filename and carries `\` fine, where a ref could
  // not; `branch` and `worktree` are built from the same argument, so one
  // argument exercises both the ref-legal and the path-only vector.
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "sl\\ug", "fix"], { cwd: dir, encoding: "utf8" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).worktree, ".worktrees/42-sl\\ug");
});

test("an ordinary slug is byte-identical — the escaping accepts what it should", () => {
  // The false-positive half: nothing here has anything to escape, so the
  // payload must be exactly what this script has always emitted.
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    r.stdout,
    '{"issue":42,"branch":"fix/42-slug","worktree":".worktrees/42-slug","install":"npm ci","ports":{"postgres":16042,"ollama":22042},"runner":".worktrees/42-slug/agent-test","applied":false}\n',
  );
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run. This script's
// contract is exit 2 for every refusal and 0 otherwise — there is no exit 1 —
// and the guard sits ahead of every mutation, so a missing library refuses
// before a worktree, a label or a runner exists.
test("a missing json.sh is exit 2, before anything is created", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  const lone = mkdtempSync(join(tmpdir(), "claim-nolib-"));
  copyFileSync(SCRIPT, join(lone, "claim-ticket.sh"));
  const bin = mkdtempSync(join(tmpdir(), "claim-nolib-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const r = spawnSync("sh", [join(lone, "claim-ticket.sh"), "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, "a missing library is a refusal — this script's only failure code");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the lockfile probe");
  assert.equal(r.stdout, "", "no payload: this refusal fires before the claim exists, so there is nothing to report");
  assert.equal(existsSync(join(dir, ".worktrees", "42-slug")), false,
    "and no worktree — the guard fires ahead of every mutation, so this is a clean refusal and not a half-claim");
});
