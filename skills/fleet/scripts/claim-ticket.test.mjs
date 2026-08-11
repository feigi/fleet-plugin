import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, copyFileSync } from "node:fs";
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
// `script` defaults to the real one; pass a copy to claim from a different
// template.
function apply(files, script = SCRIPT) {
  const dir = repo(files);
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
  // argument's spelling, which holds no `node_modules` either. Measured: it
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
  // claim-ticket.sh now derives testcmd via a sibling script, resolved
  // relative to itself ($(dirname -- "$0")) — copy the real one alongside
  // this edited copy so the derivation still finds it.
  const sibling = join(scriptDir, "derive-testcmd.sh");
  copyFileSync(join(import.meta.dirname, "derive-testcmd.sh"), sibling);
  chmodSync(sibling, 0o755);

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
