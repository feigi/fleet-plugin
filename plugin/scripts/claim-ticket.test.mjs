import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, symlinkSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";

const SCRIPT = join(import.meta.dirname, "claim-ticket.sh");

// Fixture construction must not inherit the two variables this file's own
// #1020 cases set deliberately at the bottom. Under an ambient GIT_DIR the
// `git init` in `repo()` exits 0 and creates NOTHING in `dir` — it re-inits
// whatever GIT_DIR names — so every fixture in this file would be built
// against the wrong repository while the suite stayed green (ledger.test.mjs
// records the same trap). The two cases that need these variables pass them
// explicitly to the SCRIPT, never to the builder.
const FIXTURE_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

// Build a repo whose origin/main holds `files`. `local` is written to the
// working tree afterwards WITHOUT committing — that is how a checkout diverges
// from the ref the worktree is actually built from.
// `parent` is where the repo itself is created. It matters because the runner
// judges an argument by where its resolution diverges from the runner's OWN
// location, so a `node_modules` component in the repo's own ancestry is part of
// what the guard has to ignore — and only a fixture built under one can pin it.
function repo(files, local = {}, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, "claim-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: FIXTURE_ENV });
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
    env,
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

// #760 — that a claim carries no upstream, and what that means to reap.sh and
// release-ticket.sh — is pinned in claim-lifecycle.test.mjs, not here. This
// file's `repo()` fixture fabricates refs/remotes/origin/main with
// `update-ref` and configures no `origin` remote, so git declines to set an
// upstream from it at all: every assertion about upstream config passes here
// whatever `worktree add` was handed. Measured — a config pin in this fixture
// stayed green with `--no-track` removed.

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

// #600: a filename is bytes, and the two tools that read find's output are told
// which only by the ambient locale. Under en_US.UTF-8 with a name holding \377,
// measured on macOS: `grep` drops that line silently — a green over a smaller
// suite, #582's own false-green — and BSD `sed`, fed that byte directly, abandons
// the whole stream ("RE error: illegal byte sequence", exit 1), which empties
// $files and refuses a suite that is right there. `LC_ALL=C` on each command is
// the fix.
//
// Two stubs, because neither half of the fixture can be built for real. APFS
// refuses the name outright (`Illegal byte sequence`), so no filesystem this
// suite can create holds it — `find` is stubbed to emit what a filesystem that
// does would. And node cannot be asked what it ran, so it is stubbed to report
// how many arguments survived discovery: `--test` plus both paths is 3, and the
// unpinned runner reaches this assertion with one of them (`2` — `--test` plus
// the one path grep's own silent drop lets through; `sed`'s abort never enters
// into it, since grep already dropped the bad line before sed would see it).
//
// LC_ALL is set on the child rather than inherited: the ambient locale is the
// hostile input here, so pre-seeding it is what makes the test discriminate at
// all instead of depending on the operator's environment.
//
// THE CEILING, inherited from locale-pin-prose.test.mjs: this kills its mutant
// on macOS only. GNU grep and sed are byte-oriented and pass every line through
// whatever the locale says, so on ubuntu-latest — the one platform ci.yml runs —
// deleting both pins keeps this test green.
test("runner: an invalid UTF-8 byte in a discovered path does not drop it", () => {
  const a = apply(SUITE);
  const bin = mkdtempSync(join(tmpdir(), "claim-locale-"));
  // The byte cannot be spelled in JS — node re-encodes every string as UTF-8 on
  // the way to argv, turning `\xFF` into the two valid bytes `\303\277`. POSIX
  // `printf` interprets the octal escape, so the fixture stays pure ASCII and
  // the shell makes the byte.
  writeFileSync(join(bin, "find"), "#!/bin/sh\nprintf 't/b\\377ad.test.mjs\\nt/ok.test.mjs\\n'\n", { mode: 0o755 });
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf %s "$#"\n', { mode: 0o755 });
  const r = spawnSync(join(a.wt, "agent-test"), ["t"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}`, LC_ALL: "en_US.UTF-8" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "3", "discovery lost a path holding an invalid UTF-8 byte");
});

// The source-assertion half of #600, on both pins — same shape as
// locale-pin-prose.test.mjs (that file's own list deliberately excludes
// claim-ticket.sh; this is that decision, made here instead, since the emitted
// runner is generated, not a checked-in script the list's globbing would find).
//
// This is the ONLY regression coverage the file-argument branch's own pin gets
// (`arg=$(printf '%s\n' "$arg" | LC_ALL=C sed …)`, below). A behavioural twin of
// the test above is not constructable for it, on either platform this suite
// runs on: `[ -e "$arg" ]` gates that line, and it needs a REAL file — APFS
// refuses to create one whose name holds an invalid UTF-8 byte at all (measured:
// `touch` on such a name exits "Illegal byte sequence", not just Node's own
// fs), and `[` is a shell builtin, not a PATH-resolved command, so it can't be
// stubbed the way `find` and `node` are above. Where the filesystem WOULD allow
// the name (ext4, ubuntu-latest — the platform CI actually runs), GNU sed's own
// byte-orientation makes the pin invisible anyway, same ceiling as the
// directory branch. Nothing behavioural can fail if this pin goes missing, on
// any platform available here — only a source check can.
test("claim-ticket.sh still pins the locale on both find-output commands", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal((src.match(/LC_ALL=C grep\b/g) ?? []).length, 1,
    "the directory branch's grep pin (find's output, above) went missing or moved");
  assert.equal((src.match(/LC_ALL=C sed\b/g) ?? []).length, 2,
    "one of the two sed pins (directory branch above, file-argument branch below) went missing");
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
//
// The absolute spellings are the half that outlived the first fix (#230). An
// argument spelled absolutely carries the shared ancestor's `node_modules`
// inside its own text, so a guard term that reads the caller's spelling
// unanchored matches on it however the anchored term ruled — and the same
// directory reached two verdicts depending only on how it was named. Spelled
// and resolved forms are asserted side by side here because agreement between
// them, not any single row, is the property.
test("runner: a node_modules in the worktree's own ancestry refuses nothing", () => {
  const under = join(mkdtempSync(join(tmpdir(), "anc-")), "node_modules");
  mkdirSync(under, { recursive: true });
  const a = apply(SUITE, SCRIPT, under);
  for (const [args, count] of [
    [[], 6],
    [["."], 6],
    [[a.wt], 6],
    [["t"], 3],
    [[join(a.wt, "t")], 3],
    // File arguments too: the file branch grew its own resolved-path check
    // (#424), so the ancestor that must stay unread is now read by both arms.
    [["t/a.test.mjs"], 1],
    [[join(a.wt, "t", "a.test.mjs")], 1],
  ]) {
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
  // A DIRECTORY argument and a FILE argument in one argv, diverging from the
  // runner at different depths. Both arms share one `diverge` walk writing one
  // global `$shared` (POSIX sh has no `local`), so the file arm's verdict must
  // not inherit the directory's: `t` diverges at the worktree, `outlink`
  // resolves two levels above it, and reusing the deeper answer strips nothing
  // — leaving the ANCESTRY's own `node_modules` inside the string the file arm
  // scans, so the worktree refuses a file that is not vendored at all.
  // Every other row here passes one argument, where `$shared` is empty before
  // the call and dropping the call outright still reds. This row is the only
  // one that catches reusing a STALE value: `[ -n "$shared" ] || diverge …`,
  // the plausible optimization, left the whole file green before it existed
  // (measured) and reds here now.
  symlinkSync(join("..", "..", "root.test.mjs"), join(a.wt, "outlink.test.mjs"));
  const mixed = a.run("t", "outlink.test.mjs");
  assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);
  assert.match(mixed.stdout, /(?:ℹ|#) pass 4(?!\d)/);
  // The MIRROR order: a FILE argument first, then a DIRECTORY argument that
  // diverges ABOVE the worktree, still under this ancestor's own
  // `node_modules` — the shape the "resolution outside the worktree" test
  // below proves correct when the directory arm's own `diverge` call runs.
  // `t/a.test.mjs` diverges no further than the worktree, so the file arm
  // leaves `$shared` sitting at `$root` itself; if the DIRECTORY arm's own
  // `diverge` call were skipped in favour of that stale, narrower value,
  // stripping it from the directory's resolution would strip nothing —
  // leaving the ancestor's own `node_modules` in the string the directory arm
  // scans, refusing an ordinary directory outside the worktree that is not
  // vendored at all. Every row above passes a single argument in this order;
  // this is the only one that catches the DIRECTORY arm reusing a stale
  // value left behind by a FILE argument run first.
  const outside2 = join(mkdtempSync(join(under, "out2-")), "lib");
  mkdirSync(outside2, { recursive: true });
  writeFileSync(join(outside2, "o2.test.mjs"), PASSES);
  symlinkSync(outside2, join(a.wt, "outlink2"));
  const mixed2 = a.run("t/a.test.mjs", "outlink2");
  assert.equal(mixed2.status, 0, mixed2.stdout + mixed2.stderr);
  assert.match(mixed2.stdout, /(?:ℹ|#) pass 2(?!\d)/);
});

// The spelling term's own reason to exist, and the only input in this repo that
// isolates it: a cwd OUTSIDE the worktree, from which a relative argument
// descends through the shared ancestor's `node_modules` and so names it in its
// own text, while resolving to an ordinary directory the divergence walk has
// already cleared. Measured: delete `${arg##/*}` from the guard and every other
// test in the repo stays green, so without this row the term reads as dead code
// to the next simplifier — and it is not, since node excludes an argv entry
// whose normalized relative form opens with `node_modules/` and says nothing
// about it (#100). The message is asserted, not just the status: without the
// term the argument reaches node, which reports its own `Could not find`, and
// the two exits are indistinguishable by status alone. The absolute leg is the
// control — the same directory named absolutely is exempt from that term and
// must still run, which is #230's property and what separates this test from
// one that merely refuses everything spelled from outside.
test("runner: a relative argument through the shared ancestor is refused from outside the worktree", () => {
  const under = join(mkdtempSync(join(tmpdir(), "anc-")), "node_modules");
  mkdirSync(under, { recursive: true });
  const a = apply(SUITE, SCRIPT, under);
  // Four levels up from the worktree: `42-slug` -> `.worktrees` -> `claim-XXXX`
  // -> `node_modules` -> the ancestor holding it, so a path relative to that cwd
  // opens with the `node_modules` segment the guard has to read.
  const up = join("..", "..", "..", "..");
  const outside = a.runFrom(up, relative(join(a.wt, up), join(a.wt, "t")));
  assert.notEqual(outside.status, 0, outside.stdout + outside.stderr);
  assert.match(outside.stderr, /is under node_modules — excluded from the run/);
  const ok = a.runFrom(up, join(a.wt, "t"));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^(?:ℹ|#) pass 3$/m);
});

// The divergence WALK itself (#797). Every row above names an argument that
// resolves under the worktree, where `$shared` and `$root` strip the same text
// and the walk does no work — measured, substituting `$root` for `$shared` in
// `${resolved#"$shared"}` is green on all 1873 tests. What separates the two is
// a resolution landing OUTSIDE the runner's own directory while still under the
// `node_modules` ancestor they share: `$root` is no prefix of it, so nothing is
// stripped, the ancestor's own `node_modules` stays in the text being matched,
// and an ordinary directory out there is refused as vendored. That is the
// "opposite error" the guard's comment names, reached from its false-refusal
// side rather than its false-green one.
// One row per guard arm, no absolute spelling of either, and that is measured
// rather than an omission. Directory: `$resolved` comes from `pwd -P`, which
// erases the spelling, so an absolute argument reaches the case with
// `$root`/`$resolved`/`$shared` byte-identical to the relative row's and can
// differ only in the spelling term `${arg##/*}` — which the test directly above
// already pins as its control leg, and which the unreadable-directory test below
// pins again through a symlinked ancestor. Measured over nine mutations of this
// guard: none reds an absolute row here while leaving the relative row and those
// two green. File: an absolute `$arg` carrying a `node_modules` segment is
// exempted from the file arm's resolved check by design (#401), so that row
// would pin nothing here either.
// The file arm runs the same walk via `diverge`, writing the shared `$shared`
// (#424), so the file row here holds that anchor with the same fixture; the
// vendored legs it must keep refusing are the two tests above, which this one
// deliberately does not repeat.
test("runner: a resolution outside the worktree is judged from the divergence, not the runner's own root", () => {
  const ancestor = join(mkdtempSync(join(tmpdir(), "anc-")), "node_modules");
  mkdirSync(ancestor, { recursive: true });
  const a = apply(SUITE, SCRIPT, ancestor);
  // A sibling of the repo, so the argument diverges ABOVE the worktree while
  // still sitting under the shared `node_modules` — the one shape that makes
  // `$root` and `$shared` name different directories.
  const outside = join(mkdtempSync(join(ancestor, "outside-")), "lib");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "o.test.mjs"), PASSES);
  symlinkSync(outside, join(a.wt, "outlink"));
  symlinkSync(join(outside, "o.test.mjs"), join(a.wt, "outlink.test.mjs"));
  for (const arg of ["outlink", "outlink.test.mjs"]) {
    const r = a.run(arg);
    assert.equal(r.status, 0, `${arg}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^(?:ℹ|#) pass 1$/m, arg);
  }
});

// The guard resolves `$arg` against the process cwd, but `$root` against the
// runner's own location, so the two are no longer the same anchor and a
// subdirectory invocation exercises a different path than a root one. Measured:
// anchoring the argument at `$root` instead (`cd -- "$root/$arg"`, a one-token
// slip on the argument alone — claim-ticket.sh's `root=` assignment and its
// `resolved=` one now sit 171 lines apart, not side by side) is green on
// every OTHER test in this file while reporting
// the vendored test as a pass from one directory down.
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

// #960 case 1: `find "-dir/" ...` — the old spelling — is read by both BSD
// find (macOS) and GNU find (Linux CI) as the start of an option cluster,
// trailing slash and all, and dies before reading a single path: measured
// directly, "illegal option -- i" (BSD) / "unknown predicate `-dir/'"
// (GNU), neither rescued by a POSIX `--`. The runner used to report that as
// `cannot read every path under -dir`, blaming the subtree's readability
// for what was find's own argument parser losing to the caller's spelling.
// `-dir` is written into the worktree directly rather than through
// `repo()`: a leading-dash directory NAME is a shell/CLI-argument concern,
// not something a git commit needs to reproduce.
// Node's own `--test` CLI turns out to share the same parser confusion one
// layer down — measured, a relative file spec that starts with `-` after
// node's own normalisation is read as a bad option too, `./`-prefixed or
// not — so this fixture cannot be made to actually run without rewriting
// every file this arm hands to node into an absolute path, a much larger
// change than this bug. The runner refuses instead, naming ITS cause
// rather than reporting a suite that never got to node as unreadable.
test("runner: a dash-named directory refuses naming the parsing hazard, not unreadability", () => {
  const a = apply(SUITE);
  mkdirSync(join(a.wt, "-dir"), { recursive: true });
  writeFileSync(join(a.wt, "-dir", "z.test.mjs"), PASSES);
  const r = a.run("-dir");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /holds tests, but node reads a relative dash-led path as an option/);
  assert.doesNotMatch(r.stderr, /cannot read every path under/);
});

// The other half of the same fixture: a dash-named directory that is
// GENUINELY unreadable must still report that real fault, not the parsing
// refusal's message. `./` only routes the argument around find's OWN
// parser (pinned above); once find actually descends, a permission denied
// down there is what `cannot read every path under` is for, and this pins
// that the parsing fix did not also swallow real unreadability.
// The wrapper text alone (`cannot read every path under -locked`) does not
// discriminate: it is byte-identical whether find died on the dash before
// reading anything, or genuinely hit this fixture's chmod 0 `sub`. find's
// OWN stderr is never redirected by the runner, so it reaches this test
// alongside the wrapper — measured, the two causes leave distinct text
// there: `find: .../sub: Permission denied` for the real fault this test
// means to pin, versus `find: illegal option -- i` (BSD) / `find: unknown
// predicate '...'` (GNU) for the argument-parsing failure this PR's `./`
// routing prevents. Asserting on find's message too, and ruling out the
// parsing signature, is what makes this test fail if the `./` routing
// this PR adds is reverted — checked directly: reverting it leaves this
// test green under the wrapper-only assertion alone.
test("runner: an unreadable dash-named directory still reports the real read fault", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const a = apply(SUITE);
  const locked = join(a.wt, "-locked");
  mkdirSync(join(locked, "sub"), { recursive: true });
  writeFileSync(join(locked, "sub", "z.test.mjs"), PASSES);
  chmodSync(join(locked, "sub"), 0o000);
  try {
    const r = a.run("-locked");
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read every path under -locked/);
    assert.doesNotMatch(r.stderr, /holds tests, but node reads/);
    assert.match(r.stderr, /Permission denied/, `find must have actually descended into -locked rather than dying on its dash: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /illegal option|unknown predicate/i,
      `find's own argument-parsing failure text must not be present, or this is the parsing hazard, not the read fault: ${r.stderr}`);
  } finally {
    chmodSync(join(locked, "sub"), 0o755);
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

// The vendored half of the no-search-bit case: `cd` fails on a directory
// `[ -d ]` admits but that carries no search bit, so unless the resolution is
// recovered from somewhere the divergence walk has nothing to measure and this
// argument stops being refused as vendored at all. Measured against this file:
// remove the recovery entirely and this is the one test that reds. What the
// recovery is ANCHORED on is a separate property and this test is blind to it —
// give it back the argument's raw text and this row stays green — which is why
// the ancestor-spelling test below exists as well as this one.
// One spelling, not two. The relative one was measured redundant across every
// mutation of both halves of the guard: with a recovery in place the resolved
// term reaches it unaided, and with none the spelling term does, so no mutation
// moves it. The absolute spelling is the row that carries this test.
// The readability message is asserted absent — `find` refuses a starting point
// it cannot open as well, so a bare non-zero cannot tell the guard's refusal
// from find's, and which cause the reader is sent after is the point.
// Root can read anything, so it cannot see this.
test("runner: a vendored directory with no search bit is refused as vendored, not as unreadable", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  chmodSync(vendor, 0o000);
  try {
    const r = a.run(vendor);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /is under node_modules — excluded from the run/);
    assert.doesNotMatch(r.stderr, /cannot read every path under/);
  } finally {
    chmodSync(vendor, 0o755);
  }
});

// #230's own criterion in the one case the spelling exemption does not reach: a
// directory `[ -d ]` admits but that carries no search bit resolves to nothing,
// so what the guard falls back to is what decides the verdict. Anchored on the
// parent, every spelling of the directory agrees; anchored on the argument's raw
// text it did not — `$root` comes from `pwd -P`, so an absolute spelling routed
// through a symlinked ancestor shares no literal prefix with it, `$shared` walks
// down to empty, and the ancestor's own `node_modules` is left sitting in the
// text being matched. One directory, two absolute names, opposite verdicts.
// The symlinked ancestor is built here rather than borrowed from `$TMPDIR`:
// macOS resolves `/var/folders/...` to `/private/var/...` and would supply one
// for free, Linux would not, and a fixture that reproduces on one platform only
// stops discriminating on the other without saying so.
// NON-vendored on purpose. A vendored directory has to keep being refused (the
// test above pins that), so only a directory the guard has no business refusing
// can tell an anchored fallback from an unanchored one.
// Root can read anything, so it cannot see this.
test("runner: an unreadable directory under a node_modules ancestor names the read fault in every spelling", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const real = mkdtempSync(join(tmpdir(), "anc-"));
  const spelled = `${real}-link`;
  symlinkSync(real, spelled);
  mkdirSync(join(real, "node_modules"), { recursive: true });
  const a = apply(SUITE, SCRIPT, join(spelled, "node_modules"));
  const locked = join(a.wt, "t");
  chmodSync(locked, 0o000);
  try {
    for (const spelling of ["t", locked, join(realpathSync(a.wt), "t")]) {
      const r = a.run(spelling);
      assert.notEqual(r.status, 0, `${spelling}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /cannot read every path under/, spelling);
      assert.doesNotMatch(r.stderr, /is under node_modules/, spelling);
    }
  } finally {
    chmodSync(locked, 0o755);
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

// #960 case 2: `[ -e "$arg" ]` cannot tell "not there" from "could not
// look" — stat() answers the same false whether $arg is genuinely absent
// or a directory in its path lacks the search bit needed to resolve the
// rest. A file behind an unsearchable parent used to fall straight through
// to the typo arm above and get called missing, though it is right there.
// The directory arm already gets the IDENTICAL fixture right (see "a
// directory it cannot fully read refuses instead of running a partial
// suite" above): both arms are run here on one `locked` directory to pin
// the asymmetry the ticket names directly — same cause, and now the same
// kind of answer from both, not just the directory arm's.
// Root can search anything, so it cannot see this.
test("runner: a file behind an unsearchable parent refuses naming the permission fault, not a typo", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const a = apply({ ...SUITE, "locked/a.test.mjs": PASSES });
  const locked = join(a.wt, "locked");
  chmodSync(locked, 0o600);
  try {
    const asFile = a.run("locked/a.test.mjs");
    assert.notEqual(asFile.status, 0, asFile.stdout + asFile.stderr);
    assert.match(asFile.stderr, /cannot read locked\/a\.test\.mjs — locked is not searchable/);
    assert.doesNotMatch(asFile.stderr, /does not exist/);

    const asDir = a.run("locked");
    assert.notEqual(asDir.status, 0, asDir.stdout + asDir.stderr);
    assert.match(asDir.stderr, /cannot read every path under locked/);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// The fix above checks $fparent alone, which is the immediate parent —
// an unsearchable GRANDparent leaves `[ -d $fparent ]` itself false
// (resolving `t/u` needs search on `t`, the bit actually missing), so a
// single-level check falls through to "does not exist" one level further
// up than the fixture above pins. This walks the fixture one directory
// deeper: `t` (not `u`) is chmod'd 0600, so `t/u` can never be
// resolved at all, and the ancestor actually blocking it — `t`, not
// `t/u` — is what the message must name.
test("runner: a file behind an unsearchable grandparent refuses naming that ancestor, not a typo", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const a = apply({ ...SUITE, "t/u/a.test.mjs": PASSES });
  const tdir = join(a.wt, "t");
  chmodSync(tdir, 0o600);
  try {
    const r = a.run("t/u/a.test.mjs");
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read t\/u\/a\.test\.mjs — t is not searchable/);
    assert.doesNotMatch(r.stderr, /does not exist/);
  } finally {
    chmodSync(tdir, 0o755);
  }
});

// The bound on the fix above: a PARENT that is simply missing
// (`nosuchdir/x.test.mjs`) is the ordinary typo this arm already reported
// correctly, and the permission-fault check must not swallow it — `-x` on
// a nonexistent parent is false too, so without the `-d` term this input
// would misreport as a permission fault it does not have.
test("runner: a typo'd path with a missing parent still says it does not exist", () => {
  const r = apply(SUITE).run("nosuchdir/x.test.mjs");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /nosuchdir\/x\.test\.mjs does not exist/);
  assert.doesNotMatch(r.stderr, /cannot read/);
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

// The same guard under an inherited CDPATH, which nothing else in this suite
// varies. `cd` consults CDPATH before the cwd, so with a decoy on it that
// holds a same-named `node_modules/plain`, a bare `cd "$argdir"` resolves
// into the DECOY: the guard's `"$PWD"/node_modules/*` pattern misses, it
// falls through without refusing, and the vendored file reaches node — which
// drops it silently at exit 0, #100 back with the refusal removed. `apply()`
// hands the runner `{...process.env}`, so a developer's CDPATH reaches it.
// The decoy shape is deliberate over a bare `CDPATH=/tmp`: /bin/sh on macOS
// (bash 3.2) fails the `cd` outright when no CDPATH entry matches, while
// /bin/dash falls back to the cwd per POSIX and stays immune — so a
// non-matching decoy would pin this on the dev platform only. A MATCHING
// entry diverts both shells, which is what makes this row portable.
// The sibling directory branch already carries `CDPATH=` for this reason
// (see claim-ticket.sh, above `root=`); this pins the file branch's copy.
// Mutation-tested both ways: dropping `CDPATH= ` from the file branch's `cd`
// reds this row alone, and adding `-P` to it — the mutation the #401 row
// below pins — leaves this one green.
// Re-measured after #1005 collapsed that branch's unreachable `argdir` arm,
// because the collapse is exactly the edit that could drop the `CDPATH= `
// silently: stripping it from the collapsed line still reds this row and only
// it (17/18 of the vendored rows green), and forcing `argdir` back to the
// removed arm's `.` value reds five rows including this one — so the pin
// discriminates the guard's behaviour, not the shape it is written in.
test("runner: a vendored file argument refuses under an inherited CDPATH", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "plain");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  const decoy = mkdtempSync(join(tmpdir(), "cdpath-decoy-"));
  mkdirSync(join(decoy, "node_modules", "plain"), { recursive: true });
  const r = spawnSync(join(a.wt, "agent-test"), ["t/a.test.mjs", "node_modules/plain/v.test.mjs"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, CDPATH: decoy },
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /is under node_modules — node discards it silently/);
});

// The file-branch counterpart of the no-search-bit case pinned above for the
// directory branch: `arg` here is a FILE, so `[ -d $arg ]` never runs at
// all — this guard reads $argdir, the file's own parent, and it is $argdir
// that loses its search bit. Before the fix, `cd`'s failure on $argdir was
// discarded outright (`2>/dev/null`, nothing read from the pipeline), the
// vendored `case` fell through unrefused, `[ -e $arg ]` downstream read
// false because the parent could not be traversed, and the typo arm far
// below reported a permission fault as `does not exist` — measured directly
// against the unfixed shim. Root can read anything, so it cannot see this.
test("runner: a vendored file behind an unreadable directory names the permission fault, not a typo", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  chmodSync(vendor, 0o000);
  try {
    const r = a.run("t/a.test.mjs", "node_modules/pkg/v.test.mjs");
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read node_modules\/pkg — check its permissions/);
    assert.doesNotMatch(r.stderr, /does not exist/);
    assert.doesNotMatch(r.stderr, /is under node_modules — node discards it silently/);
  } finally {
    chmodSync(vendor, 0o755);
  }
});

// #1006's own warning about its remedy sketch: `[ -d $argdir ]` reads false
// not only when $argdir is missing, but also whenever $argdir's OWN PARENT
// is unreadable — so the guard above must not fire the permission message on
// a fixture it cannot actually back up. Here `node_modules` (the file's
// GRANDparent) loses its search bit, not `pkg` (the immediate parent): the
// guard can no longer even confirm `pkg` exists, so it has to stay silent
// and let the argument fall through exactly as an unmeasured path already
// did, rather than assert a fault it cannot name. Measured directly: `-d`
// reads false here where it read true in the row above, on the same
// $argdir. The downstream message this falls through to belongs to the
// general typo arm (#960/PR #1387), not this guard, and is deliberately
// left unpinned here — its exact wording is that ticket's to change; this
// row only pins that THIS guard neither over-fires nor claims the wrong
// verdict. Root can read anything, so it cannot see this.
test("runner: a vendored file whose ancestor is unreadable does not claim a permission fault it cannot confirm", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  const modules = join(a.wt, "node_modules");
  chmodSync(modules, 0o000);
  try {
    const r = a.run("t/a.test.mjs", "node_modules/pkg/v.test.mjs");
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /cannot read node_modules\/pkg — check its permissions/);
    assert.doesNotMatch(r.stderr, /is under node_modules — node discards it silently/);
  } finally {
    chmodSync(modules, 0o755);
  }
});

// #401: nothing above pins the RESOLUTION MODE this guard uses, only its
// spelling coverage. `cd`/`pwd` without `-P` is logical — it never resolves a
// symlinked path component — and that is deliberate: it is the same textual
// resolution node applies to its own argv, so the guard and node agree on
// which files count as vendored. The ordinary npm/pnpm workspace shape is
// where the two resolution modes diverge: `node_modules/pkg` is itself a
// symlink to a sibling real directory (`pkg` hoisted or linked from
// `packages/`). `pwd -P` there resolves `pkg` OUT of `node_modules`, so the
// pattern below stops matching, this guard falls through without refusing,
// and the argument reaches node unrefused — where it is excluded anyway, on
// its own unresolved spelling, silently, at exit 0. That is #100's silent
// drop back, minus the loud refusal that is supposed to catch it first.
// Measured against a scratch copy of this script with `cd`/`pwd` mutated to
// `cd -P`/`pwd -P` on this guard alone: this is the row that reds, and it
// stayed red for both `/bin/sh` (bash on macOS) and `/bin/dash` — the two
// disagree on many things but not on this.
test("runner: a vendored file behind a symlinked node_modules entry refuses", () => {
  const a = apply(SUITE);
  const real = join(a.wt, "packages", "pkg");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "v.test.mjs"), PASSES);
  mkdirSync(join(a.wt, "node_modules"), { recursive: true });
  symlinkSync(join("..", "packages", "pkg"), join(a.wt, "node_modules", "pkg"));
  const r = a.run("t/a.test.mjs", "node_modules/pkg/v.test.mjs");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /is under node_modules — node discards it silently/);
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

// #424: the file-branch sibling of #186. The guard above judges the argument's
// own SPELLING, and the logical directory that spelling names — which is what
// node's silent-discard rule reads. A symlink whose name carries no
// `node_modules` but whose TARGET is vendored passes it untouched, and node
// then RUNS the vendored file rather than discarding it. So the hazard here is
// not #100's: there is no silent drop left to make loud. It is #186's —
// third-party code deciding this suite's result — one `-d` away, and it takes
// #186's remedy: judge where the argument RESOLVES.
//
// Physical resolution, and only where the spelling does not already name
// `node_modules`. Those spellings are the guard above's own input, the two it
// deliberately lets run included, and re-judging them from a second place would
// overturn that ruling; the two checks cover disjoint arguments instead, which
// is what lets this one be physical while #401's stays logical.
//
// Anchored at the divergence from the runner's own location, as the directory
// branch is: a `node_modules` ABOVE that point is an ancestor of the runner too
// and says nothing about the argument. The absolute spelling is here because
// resolution, unlike the directory branch's lexical spelling term, is immune to
// how the caller named the file — a macOS $TMPDIR reaches the worktree through
// a symlinked ancestor, so the two spellings share no literal prefix and only
// the resolved form puts them on the same footing. The outside-the-worktree
// target is the leg that separates anchoring at the divergence from anchoring
// at the worktree root: its resolution lands outside the worktree entirely, so
// a root-anchored guard has nothing left to compare and runs it green — #186's
// own class, one input over.
test("runner: a symlink to a vendored file refuses however it is spelled", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("node_modules", "pkg", "v.test.mjs"), join(a.wt, "vendlink.test.mjs"));
  // A chain of file symlinks: node follows it to the vendored file, so a guard
  // that resolves only one hop reports a clean path node never used.
  symlinkSync("vendlink.test.mjs", join(a.wt, "chainlink.test.mjs"));
  // The vendored component reached through a symlinked DIRECTORY, with a real
  // file as the final component — the half `cd`/`pwd -P` on the argument's own
  // directory would already have caught, kept so the fix is not narrowed to
  // final-component links alone.
  symlinkSync(join("node_modules", "pkg"), join(a.wt, "dirlink"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  mkdirSync(join(outside, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(outside, "node_modules", "pkg", "o.test.mjs"), PASSES);
  symlinkSync(join(outside, "node_modules", "pkg", "o.test.mjs"), join(a.wt, "extlink.test.mjs"));
  // A directory whose name merely ENDS in the word, spelled both ways — the
  // merged `case` judges the two on different arms. The relative spelling is
  // held out of the logical arm by that arm's own segment bound. The absolute
  // one is held out by the FIRST arm, whose job is the single shape both
  // guards decline (absolute AND naming a real `node_modules` segment) and
  // which therefore has to carry the bound too: written as the one glob that
  // looks equivalent, `/*node_modules/*`, it swallows this spelling into the
  // skip and node runs the vendored file. Measured — that collapse reds this
  // row and nothing else in the file, so the relative row alone did not pin
  // it. Unbounded, `*node_modules/*` claimed the argument for the logical
  // guard instead, whose own inner test is anchored at `$PWD/node_modules/`
  // and never fired: the argument left both guards unjudged, same result.
  mkdirSync(join(a.wt, "vendor_node_modules"), { recursive: true });
  symlinkSync(join("..", "node_modules", "pkg", "v.test.mjs"), join(a.wt, "vendor_node_modules", "link.test.mjs"));
  for (const spelling of [
    "vendlink.test.mjs",
    "./vendlink.test.mjs",
    join(a.wt, "vendlink.test.mjs"),
    "chainlink.test.mjs",
    "dirlink/v.test.mjs",
    "extlink.test.mjs",
    "vendor_node_modules/link.test.mjs",
    join(a.wt, "vendor_node_modules", "link.test.mjs"),
  ]) {
    const r = a.run("t/a.test.mjs", spelling);
    assert.notEqual(r.status, 0, `${spelling}: ${r.stdout}${r.stderr}`);
    // The resolved target is named, not just the argument: the refusal states
    // what was applied to THIS path — a caller who spelled a name carrying no
    // `node_modules` otherwise has to re-run `realpath` to see which link went
    // where, and reads the bare clause as a rule the runner does not apply to
    // every spelling (a literal `t/node_modules/pkg/x.test.mjs` still runs,
    // #401's ruling, deliberately).
    assert.match(r.stderr, /resolves to \S+, inside node_modules — excluded from the run/, spelling);
  }
});

// The control, and what stops the fix above becoming a blanket refusal of
// symlinks: the refusal leg alone passes just as well under a guard that
// refuses every symlinked argument, or every argument with `node_modules`
// anywhere in its resolution.
//
// `sidelink` is the second half: a target that merely SITS BESIDE a vendored
// tree rather than inside one. `packages/pkg/w.test.mjs` is the ordinary
// npm/pnpm workspace shape, named by its REAL path — there is no symlinked
// spelling of it to grep for, because that is the point: `node_modules/pkg`
// is a symlink OUT to `packages/pkg`, so a caller naming `packages/pkg/…`
// names a file that is not vendored at all, and physical resolution is
// exactly what has to agree. The
// same tree spelled `node_modules/pkg/…` is #401's row above, refused by the
// logical guard this one is deliberately blind to.
test("runner: a symlink to a non-vendored file still runs", () => {
  const a = apply(SUITE);
  symlinkSync(join("t", "b.test.mjs"), join(a.wt, "oklink.test.mjs"));
  const outside = mkdtempSync(join(tmpdir(), "outside-ok-"));
  mkdirSync(join(outside, "lib", "node_modules"), { recursive: true });
  writeFileSync(join(outside, "lib", "o.test.mjs"), PASSES);
  symlinkSync(join(outside, "lib", "o.test.mjs"), join(a.wt, "sidelink.test.mjs"));
  const real = join(a.wt, "packages", "pkg");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "w.test.mjs"), PASSES);
  mkdirSync(join(a.wt, "node_modules"), { recursive: true });
  symlinkSync(join("..", "packages", "pkg"), join(a.wt, "node_modules", "pkg"));
  for (const spelling of [
    "oklink.test.mjs",
    "sidelink.test.mjs",
    "packages/pkg/w.test.mjs",
  ]) {
    const r = a.run("t/a.test.mjs", spelling);
    assert.equal(r.status, 0, `${spelling}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^(?:ℹ|#) pass 2$/m, spelling);
  }
});

// The resolved check is asked only of an argument that EXISTS, and that gate is
// the whole platform pin. BSD `realpath` fails on a nonexistent final component
// and GNU's succeeds on it, so one input drew opposite verdicts: this spelling
// reported `does not exist` on macOS and `resolves inside node_modules — not
// missing` on ubuntu-latest, asserting a missing file was not missing and
// pre-empting the arm that names it. The whole file ran 77/77 under both
// semantics, so nothing discriminated them — measured. This row does: green on
// BSD with the gate or without it, red on GNU without it.
test("runner: a missing file under a symlinked vendored directory is reported missing", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("node_modules", "pkg"), join(a.wt, "dirlink"));
  const r = a.run("t/a.test.mjs", "dirlink/nope.test.mjs");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /dirlink\/nope\.test\.mjs does not exist/);
  assert.doesNotMatch(r.stderr, /node_modules/);
});

// `realpath` is the one utility this runner reaches for that POSIX does not
// mandate — release-ticket.sh says so in terms, "none is guaranteed to exist",
// and dies there rather than guessing. Absent, this guard disarmed whole: the
// vendored file ran, the run exited 0 reporting `pass 2`, and not one byte
// reached stderr — #424's own defect restored with no notice. Absence is not a
// fallback case, it is a question this cannot answer, so it refuses. A stub
// that exits 127 rather than an emptied PATH, so `sed`, `dirname` and `node`
// still work and the resolver is the only thing missing.
test("runner: an unresolvable argument refuses rather than running unchecked", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("node_modules", "pkg", "v.test.mjs"), join(a.wt, "vendlink.test.mjs"));
  const bin = mkdtempSync(join(tmpdir(), "no-realpath-"));
  writeFileSync(join(bin, "realpath"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  // The vendored spelling goes FIRST: every file argument is judged, so the
  // refusal names whichever one the loop reaches first, and naming this one is
  // what shows the guard is still armed rather than merely dying early.
  const r = spawnSync(join(a.wt, "agent-test"), ["vendlink.test.mjs", "t/a.test.mjs"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot resolve vendlink\.test\.mjs — refusing rather than running it unchecked/);
  assert.doesNotMatch(r.stdout, /(?:ℹ|#) pass/);
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

// #352: a flag counts toward `$#`, so an argv of flags alone cleared the
// bare-form default, contributed no path operand, and reached node holding
// only flags. That is node's own default discovery — which does not recognise
// the `.spec.` form — so this fixture reported zero tests run at exit 0, the
// vacuous pass this runner exists to refuse. It refuses here too rather
// than defaulting: prepending the default AHEAD of node's own flags reorders
// argv, and no briefed workflow passes flags alone.
//
// `--` is in the list because POSIX's end-of-options marker reaches the same
// pass-through arm as a flag, and is no more a path than one.
//
// `-v` is in the list because a corpus spelled entirely with double dashes
// cannot tell the classification pattern `-*` from `--*`. That classification
// now lives in the dispatch's own arm order (the flag-detection arm, `-*) ;;`):
// narrow it to `--*` and every double-dash entry here is still refused
// exactly as before, while a lone `-v` no longer matches that arm and falls
// through to the default/typo arm instead, refused there as `-v does not
// exist` (exit 1) rather than reaching node. The row still discriminates the
// mutation — it pins the refusal's wording now, not a vacuous exit 0 — but
// the exit-0-after-printing-its-version failure mode this paragraph used to
// describe no longer applies to this code shape.
// Measured in both directions against that one-token mutation.
//
// Both directions, because a suite that only feeds a new refusal invalid input
// pins neither: the ACCEPT case below rides the same flag alongside a real
// operand, on the same fixture, so a refusal that swallowed the flag
// pass-through would be red here rather than invisible. The bare form — the
// other thing this guard could wrongly refuse — is pinned by the `.spec.`
// cases below.
//
// The fixture is the issue's own repro, and it is what discriminates: under
// node's discovery a `.spec.` file is not a test, so the pre-fix runner exited
// 0. A `.test.mjs` fixture would have run green both ways and pinned nothing.
test("runner: an argv of flags alone refuses instead of reaching node's own discovery", () => {
  const a = apply({ "t/a.spec.mjs": PASSES });
  for (const argv of [["--test-concurrency=1"], ["-v"], ["--"], ["--test-only", "--test-reporter=tap"]]) {
    const r = a.run(...argv);
    assert.notEqual(r.status, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /agent-test: no test file or directory/, argv.join(" "));
  }
  const ok = a.run("--test-concurrency=1", "t/a.spec.mjs");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^(?:ℹ|#) pass 1$/m);
});

// #961. The corpus above is spelled entirely with arguments that do not
// exist, so it pins one row of the classification and leaves the rule that
// produces it unpinned: a dash-led argument is an operand where it EXISTS,
// and a flag otherwise. Both rows below are dash-led, and they answer
// oppositely — which is what makes the rule, rather than the shape, the
// thing being pinned. Measured on a runner built from this emitter.
//
// `-dash.test.mjs` exists, so it is an operand. The runner never gets it to
// run — node reads a relative dash-led spec as an option and dies in ITS own
// voice, the same ceiling the dash-named directory test above already
// carries one level up (measured on node v26.8.1 and on the v26.5.0 the
// `.nvmrc` pins; `./`-prefixing does not escape it, node strips that
// prefix first). Which refusal a caller sees is the whole of what the
// classification buys here, and it is exactly what discriminates: classify
// this argument as a flag instead and the runner refuses in its own voice,
// at exit 1, before node is reached. The positive `node:` match is
// load-bearing beside the negative — a nonzero exit with nothing on stderr
// satisfies the negative on its own.
//
// `-t/*.test.mjs` does not exist and holds a glob metacharacter, so it
// reaches the arm order where dash-ness is read BEFORE glob-ness: a flag,
// not a glob, contributing no operand. Read it the other way round — "a
// glob is a glob whatever it starts with" — and this argv reaches node,
// which drops the unmatched pattern silently and exits 0 having run
// nothing: the vacuous pass the guard exists to refuse, one argv shape past
// the corpus above. The dash-led file is written straight into the worktree
// rather than through `repo()`, for the reason the dash-named directory
// test above gives.
test("runner: a dash-led argument counts as an operand only where it exists", () => {
  const a = apply(SUITE);
  writeFileSync(join(a.wt, "-dash.test.mjs"), PASSES);

  const exists = a.run("-dash.test.mjs");
  assert.notEqual(exists.status, 0, exists.stdout + exists.stderr);
  assert.doesNotMatch(exists.stderr, /agent-test: no test file or directory/, exists.stdout + exists.stderr);
  assert.match(exists.stderr, /node: bad option/, exists.stdout + exists.stderr);

  const missing = a.run("-t/*.test.mjs");
  assert.notEqual(missing.status, 0, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /agent-test: no test file or directory/, missing.stdout + missing.stderr);
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

// Same script, two claims — the stamp is a property of this script's own
// bytes, not of the claim, so it must not vary with the issue number, ports,
// or install command baked into the rest of the file.
test("runner: the stamp is stable across claims of the same template", () => {
  const a = apply(SUITE).text.match(STAMP_RE)[1];
  const b = apply(SUITE).text.match(STAMP_RE)[1];
  assert.equal(a, b);
});

// The other half: point a claim at a byte-for-byte-different copy of the
// script and the stamp must move. Copying rather than editing the real
// script in place keeps this test from mutating the file under test.
test("runner: the stamp changes when the script's content changes", () => {
  const scriptDir = mkdtempSync(join(tmpdir(), "claim-script-"));
  const editedScript = join(scriptDir, "claim-ticket.sh");
  writeFileSync(editedScript, readFileSync(SCRIPT, "utf8") + "\n# a harmless edit\n");
  // claim-ticket.sh resolves three siblings relative to itself
  // (`$(dirname -- "$0")`): derive-testcmd.sh for the testcmd, json.sh for the
  // payload escaping (#119), and worktree.sh for `gone()`, the established-absent
  // predicate the worktree guard asks (#727). All three have to travel with this
  // edited copy or the script refuses before it emits anything — which is the
  // guard working, not a regression.
  const sibling = join(scriptDir, "derive-testcmd.sh");
  copyFileSync(join(import.meta.dirname, "derive-testcmd.sh"), sibling);
  chmodSync(sibling, 0o755);
  for (const lib of ["json.sh", "worktree.sh"]) {
    copyFileSync(join(import.meta.dirname, lib), join(scriptDir, lib));
  }

  const after = apply(SUITE, editedScript).text.match(STAMP_RE)[1];
  const before = apply(SUITE).text.match(STAMP_RE)[1];

  assert.notEqual(after, before);
});

// #263: the stamp was derived by `cksum "$0" | cut -d' ' -f1`, whose status is
// `cut`'s, so `set -eu` never saw a `cksum` that could not read its operand —
// measured on that form, the runner carried nothing after the colon and the
// claim exited 0 reporting itself applied. And it was derived after the issue
// had been labelled and after `git worktree add`, so reading the status ALONE
// is the change that was refused: it exchanges a blank stamp for a refusal on
// a ticket that is already half-claimed. Reading the status is also not enough
// by itself — a `cksum` that exits 0 printing nothing leaves the stamp empty
// and ships that same blank line at exit 0 with the ticket claimed, which is
// why the value is read as well as the status. All three are pinned here.
//
// The stubs are the fixture, not a route: every call site this repo has, in
// the skill text and in this file, names the script by an absolute path, so
// `$0` always resolves and no argv makes the real `cksum` fail or come back
// empty. Nothing here claims a reachable failure — what is pinned is that the
// derivation reports on its own result and does so before anything is
// claimed.
//
// Exit 2, an empty stdout and a matching stderr are each reproducible by some
// other guard, so none of them establishes WHERE the refusal fired. The `gh`
// log is what only a refusal ahead of every mutation can satisfy — it is the
// criterion that separates this fix from the one that was refused. Measured:
// `gh issue edit` is the first mutation the apply branch makes, so under every
// placement of the derivation this script allows, the `gh` log is the
// assertion that reds. A registration check and a branch-ref check stood here
// too and could never fire ahead of it; the worktree check that remains states
// the same refusal in the form the json.sh guard's own test uses.
//
// The dry run is measured too, in the same fixture: it is this script's
// default mode, and the refusal reaching it is what shows the derivation sits
// with the pre-branch derivations rather than inside the apply branch, where
// the default mode never reaches it at all.
// Three stubs, because the two halves of the guard cover each other on the
// obvious ones and a stub each half owns alone is what discriminates.
// Measured on this tree: with only the first two, restoring the pipeline form
// `cksum "$0" | cut -d' ' -f1` — the #263 bug itself — leaves both green,
// because a failing `cksum` prints nothing, `cut` succeeds on empty input, and
// the value check refuses what the status check was meant to. Dropping the
// `|| die` to a bare `|| true` goes green the same way.
//   - "cannot be read"     rc 1, prints nothing. The realistic shape. Reds
//                          only when BOTH halves are gone; either alone
//                          catches it.
//   - "comes back empty"   rc 0, prints nothing. Owned by the value check —
//                          deleting that line is the mutation it reds.
//   - "fails despite printing"  rc 1, prints a plausible checksum line. Owned
//                          by the status check: the value survives `cut`, so
//                          this is the stub the pipeline form and the bare
//                          `|| true` both red.
for (const [what, stub] of [
  ["cannot be read", "#!/bin/sh\nexit 1\n"],
  ["comes back empty", "#!/bin/sh\nexit 0\n"],
  ["fails despite printing", "#!/bin/sh\necho '111 222 x'\nexit 1\n"],
]) {
  test(`a checksum that ${what} refuses before anything is claimed, in both modes`, () => {
    const dir = repo({ [TESTS]: "" });
    const bin = mkdtempSync(join(tmpdir(), "claim cksum-"));
    const ghLog = join(bin, "gh.log");
    // `>> "$GH_LOG"`, not the interpolated path (#880). The path comes from
    // `mkdtempSync(join(tmpdir(), …))` and so inherits `TMPDIR`; unquoted, a
    // space in it word-split the redirect, the shell wrote to the path's first
    // word and `echo` took the rest as an argument, and the log was never
    // created — which the assertion below reads as "gh was never invoked".
    // ci-state.test.mjs's GH_STUB form keeps the path out of the script text.
    // The prefix above now holds a space so this shape is exercised on every
    // machine, not only one whose TMPDIR has one.
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(bin, "cksum"), stub, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog };

    const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], { cwd: dir, encoding: "utf8", env });

    assert.equal(r.status, 2, `a stamp this script cannot derive is a refusal — its only failure code\n${r.stderr}`);
    assert.match(r.stderr, /refusing to claim without a runner template stamp/,
      "and it names the stamp rather than blaming whatever ran next");
    assert.equal(r.stdout, "", "no payload: the refusal fires before the claim exists, so there is nothing to report");

    // Nothing claimed. Both were TRUE under the guard-in-place form that was
    // refused, which is why the code and the message above cannot stand in
    // for them.
    assert.equal(existsSync(ghLog), false,
      "the issue is unlabelled — `gh` was never invoked, so there is no label to undo");
    assert.equal(existsSync(join(dir, ".worktrees", "42-slug")), false, "and no worktree on disk");

    // The default mode reaches the same derivation. Moved back inside the apply
    // branch it would not, and this claim would be predicted as makeable.
    const d = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8", env });
    assert.equal(d.status, 2, `the dry run refuses too\n${d.stderr}`);
    assert.match(d.stderr, /refusing to claim without a runner template stamp/);
    assert.equal(d.stdout, "", "and predicts no claim it could not make");

    // The must-ACCEPT half for the stub itself, not for the script: the
    // assertion above is satisfied by a `gh` that cannot record, so without
    // this the pin cannot tell a refusal from a broken fixture. Runs last so
    // it cannot perturb either measurement above.
    assert.equal(spawnSync("sh", ["-c", "gh issue edit 42"], { cwd: dir, encoding: "utf8", env }).status, 0,
      "fixture: the stub must be the gh on PATH");
    assert.equal(existsSync(ghLog), true,
      "the stub cannot record a call it did receive, so the assertion above passes vacuously");
  });
}

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

// #752: the `2>&1` on the ndeps capture merges node's stderr into $ndeps on
// the success path too (needed so the failure path keeps its reason — see
// the comment at the capture site), so anything that writes to node's stderr
// and still exits 0 reads as part of the "dependency count". A `node` stub
// stands in for that chatter instead of relying on NODE_DEBUG's actual
// output, which is unpinned across node versions — this asserts the shape
// guard, not node's debug format. What this fixture pins is the non-numeric
// case; digit-only chatter merges into a plausible count that the shape
// guard cannot catch.
test("install: non-numeric node stderr merged via 2>&1 refuses by shape, not misread as a dependency count", () => {
  const dir = repo({ "package.json": pkg({}), [TESTS]: "" });
  const bin = mkdtempSync(join(tmpdir(), "claim-node-"));
  writeFileSync(join(bin, "node"), '#!/bin/sh\necho "MODULE 12345: chatter" >&2\necho 0\n', { mode: 0o755 });
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 2, `non-numeric chatter refuses\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /unexpected output/, "names the shape refusal");
  assert.doesNotMatch(r.stderr, /dependencies but has no lockfile/,
    "non-numeric chatter must not be misread as a dependency count");
});

// The other half of the same guard: a `node` that exits 0 having written
// nothing to either stream — a broken or no-op shim earlier on PATH — leaves
// $ndeps empty, which is not a count either. Empty matches neither `*[!0-9]*`
// nor a digit, so without the `''` arm it falls past the guard to
// `[ "$ndeps" = 0 ]`, fails that, and refuses with `declares  dependencies`.
// Both refusals exit 2, so the status does not discriminate — the stated
// cause does, which is what a reader of the refusal acts on.
test("install: a node that prints nothing refuses by shape, not as a dependency count", () => {
  const dir = repo({ "package.json": pkg({}), [TESTS]: "" });
  const bin = mkdtempSync(join(tmpdir(), "claim-node-"));
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 2, `an empty capture refuses\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /unexpected output/, "names the shape refusal");
  assert.doesNotMatch(r.stderr, /dependencies but has no lockfile/,
    "an empty capture must not be misread as a dependency count");
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

// #730, the pathspec'd member of the same family (see reap.sh's branch sweep
// for the full explanation) — the untracked mode is CONFIG and governs a
// pathspec'd scan too, so an install that CREATES a lockfile the tree does
// not track is invisible at rc 0 unpinned.
test("an install that creates an UNTRACKED lockfile is caught under status.showUntrackedFiles=no (#730)", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  // On the repo's own config, so the linked worktree the check runs in shares it.
  execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: dir, stdio: "pipe" });
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Runs with cwd=$wt, so the stray lockfile lands in the worktree under check.
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nprintf '{}' > yarn.lock\nexit 0\n", { mode: 0o755 });

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, r.stdout + r.stderr);
  // The stated cause, not merely a refusal: several guards in this chain exit 2,
  // and triage reads the reason.
  assert.match(r.stderr, /install mutated the lockfile/);
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

// --- #727: the THIRD answer, which the `-e`/`-L` pair collapsed into the first.
//
// `-e` and `-L` both answer false when the stat could not RUN — an unreadable or
// unsearchable ancestor fails them EACCES, and the shell discards the errno. So
// a path that is occupied read as claimable, and nothing reached stderr saying
// the question had gone unanswered. Measured on the pre-fix script with a real
// directory at $wt and `.worktrees` chmod 000: exit 0 and the receipt below,
// byte-identical to one for a genuinely free path.
//
// The DRY RUN is the sharp mode and is why this is pinned there: it is the
// default, and the mode in which `git worktree add` never runs, so no downstream
// refusal exists to catch the mistake. `--apply` is pinned too, but for a
// different property — ORDERING. There the failure did surface, from inside `git
// worktree add`, but only AFTER `gh issue edit --add-label in-progress` had
// already fired, leaving a labelled issue with no worktree behind it.
//
// The fix routes through `gone()`, the established-absent predicate #725 moved
// into worktree.sh, so this script stops asking a question two of its three
// answers cannot distinguish.
test("an unreadable ancestor refuses rather than predicting a claim", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  mkdirSync(join(dir, ".worktrees", "42-slug"), { recursive: true });
  chmodSync(join(dir, ".worktrees"), 0o000);
  t.after(() => chmodSync(join(dir, ".worktrees"), 0o755));

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 2, "a path whose state could not be established is not a claimable path");
  assert.equal(r.stdout, "", "above all no receipt — the dry run is where nothing downstream refuses");
  // Named as unestablished, not as occupied: the script did not measure the
  // path, and saying it exists would assert something it cannot see either.
  assert.match(r.stderr, /could not establish whether \.worktrees\/42-slug exists/,
    "the refusal has to say the probe could not look, not guess an answer");
});

test("--apply refuses an unreadable ancestor BEFORE the in-progress label", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  mkdirSync(join(dir, ".worktrees", "42-slug"), { recursive: true });
  chmodSync(join(dir, ".worktrees"), 0o000);
  t.after(() => chmodSync(join(dir, ".worktrees"), 0o755));

  // A `gh` that RECORDS rather than one that merely succeeds: the assertion is
  // about whether the tracker was mutated at all, which a silent stub cannot
  // answer. Before the fix this file existed — the label landed, and only then
  // did `git worktree add` die on the leading directories it could not create.
  // Same `$GH_LOG` form and deliberately spaced prefix as the checksum test
  // above (#880): interpolated unquoted, this marker path word-split under a
  // spaced `TMPDIR` and recorded nothing, turning the assertion below into a
  // pin that passes hardest exactly when the stub is broken.
  const bin = mkdtempSync(join(tmpdir(), "claim bin-"));
  const marker = join(bin, "gh-ran");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: marker };

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });

  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(existsSync(marker), false,
    "the guard must refuse ahead of every mutation — a labelled issue with no worktree is the half-claim this ordering exists to prevent");

  // The must-ACCEPT half, as above: proves the marker's absence came from the
  // guard refusing and not from a stub that could never have written it.
  assert.equal(spawnSync("sh", ["-c", "gh issue edit 42"], { cwd: dir, encoding: "utf8", env }).status, 0,
    "fixture: the stub must be the gh on PATH");
  assert.equal(existsSync(marker), true,
    "the stub cannot record a call it did receive, so the assertion above passes vacuously");
});

// The must-ACCEPT half for `.worktrees` PRESENT — the `.worktrees` ABSENT
// shape is already covered by the `free` case in the dangling-symlink test
// above, byte-identical input and assertions. `gone()` walks UP to the
// nearest existing ancestor and asks whether that one is searchable, so this
// shape exercises a DIFFERENT walk: it stops at `.worktrees` itself rather
// than at the repo root. Measured, and the reason this test exists: handed
// the RELATIVE `$wt` the script carries, the walk terminates at the bare
// `.worktrees` component it cannot strip further, finds it missing, and
// answers "not established absent" — turning every first claim in a repo
// into a refusal. The absolute path is what keeps the accept case an accept.
test("a free path still claims, with the worktrees directory present", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  mkdirSync(join(dir, ".worktrees"), { recursive: true });
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /"worktree":"\.worktrees\/42-slug"/);
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

// The twin of the json.sh test above, for worktree.sh's own `[ -r ]` guard
// (#727's fourth caller of `gone()`) — json.sh present, worktree.sh absent.
test("a missing worktree.sh is exit 2, before anything is created", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });
  const lone = mkdtempSync(join(tmpdir(), "claim-nowt-"));
  copyFileSync(SCRIPT, join(lone, "claim-ticket.sh"));
  copyFileSync(join(dirname(SCRIPT), "json.sh"), join(lone, "json.sh"));
  const bin = mkdtempSync(join(tmpdir(), "claim-nowt-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const r = spawnSync("sh", [join(lone, "claim-ticket.sh"), "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, "a missing library is a refusal — this script's only failure code");
  assert.match(r.stderr, /worktree\.sh/, "and it names the file rather than blaming the lockfile probe");
  assert.equal(r.stdout, "", "no payload: this refusal fires before the claim exists, so there is nothing to report");
  assert.equal(existsSync(join(dir, ".worktrees", "42-slug")), false,
    "and no worktree — the guard fires ahead of every mutation, so this is a clean refusal and not a half-claim");
});

// --- #896: that guard's FATALITY, which none of the three payload cases above
// reaches. Each asserts what a WORKING escaper produces, so nothing here runs
// the `|| die` covering the escaper itself failing — measured, downgrading it
// to a message-preserving warning left this whole file green.
//
// The downgrade does not emit a malformed payload. `issue_branch`, `issue_wt`,
// `issue_install` and `issue_runner` are assigned by one `&&` chain, so the
// first `jstr` that fails short-circuits the rest and leaves those names unset;
// with the guard advisory the receipt `printf` reads one and `set -u` aborts
// the shell instead.
//
// This script is the exception among the four that carry this guard: it uses
// exit 2 for EVERY refusal and defines no exit 1 at all, so the 1 a bash-family
// `sh` aborts with is a code its caller has no reading for — not a refusal it
// can retry, not a claim it can record. The receipt is the claim's only
// machine-readable record, and it is the last thing this script emits.
//
// Which abort it is, though, is the shell's to choose and not this script's,
// and dash's lands on 2 — the very status a firing guard returns, under the
// same message a message-preserving downgrade still prints. This file spawns a
// bare `sh`, and `.github/workflows/ci.yml`'s `check` job runs on
// `ubuntu-latest`, where that name resolves to dash: an exit-code assertion
// therefore pins this guard on a developer's Mac and waves the mutant through
// on the runner that gates the merge, and a wording assertion pins nothing in
// either shell. `issue_wt` is what discriminates instead — both shells name it,
// and it reaches stderr only from that nounset abort.
//
// The shim is selected on CONTENT rather than argv. Only the slug reaches
// `jstr` here, `$install` is this script's own `npm ci` literal, and a `sed`
// that failed unconditionally could not say which stage it broke.

const REAL_SED = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();

/** A dir holding a `sed` shim with the given body, prepended to PATH. */
function sedShim(body) {
  const bin = mkdtempSync(join(tmpdir(), "claim-sed-shim-"));
  writeFileSync(join(bin, "sed"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

// `:a` appears in `jstr`'s rule list and in no other `sed` this script reaches.
const FAILS_ON_SLUG = `case " $* " in
  *:a*)
    in=$(cat)
    case "$in" in *esc-boom*) echo "sed: outage" >&2; exit 1 ;; esac
    printf '%s\\n' "$in" | exec ${REAL_SED} "$@" ;;
esac
exec ${REAL_SED} "$@"`;

test("an escaper that cannot run is exit 2 — this script has no other failure code", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "esc-boom", "fix"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: sedShim(FAILS_ON_SLUG) },
  });

  // Whether this fixture measured the guard at all is settled before its
  // verdict is read: an assertion that fails masks every one after it, and
  // "the shim broke something else" and "the guard is not fatal" are not
  // interchangeable diagnoses.
  assert.match(r.stderr, /sed: outage/, "the escaper ran and failed, which is the failure under test");
  assert.match(r.stderr, /DRY RUN — nothing created/,
    "the whole plan was settled — this is the guard after it, not an earlier one the shim happened to break");

  assert.equal(r.status, 2,
    "a receipt that could not be escaped is a refusal, and 2 is the only refusal this script defines. Exit 1 is a code its caller has no reading for.");
  assert.equal(r.stdout, "", "no receipt: an unescaped payload is not a record of a claim");
  assert.doesNotMatch(r.stderr, /issue_wt/,
    "the guard must stop the script, not warn and leave the receipt `printf` reading names the `&&` chain never assigned. The NAME, never the wording: bash says `issue_wt: unbound variable` at exit 1 and dash `issue_wt: parameter not set` at exit 2, so the exit-2 assertion above passes on the mutant under the shell CI actually runs, and the guard's own message survives a downgrade that preserves it.");
});

test("a shadowed `sed` that works claims normally — the guard refuses only a real outage", () => {
  // The false-positive half, and the control the case above needs: shadowing
  // `sed` on PATH is not by itself fatal to this script. Same fixture and the
  // same shadowed name, a passthrough body — so the exit 2 up there is the
  // escaper failing, not the shim's mere presence. Without this, that case
  // could be measuring a PATH it broke wholesale and still read green.
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({}), [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "esc-boom", "fix"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: sedShim(`exec ${REAL_SED} "$@"`) },
  });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    r.stdout,
    '{"issue":42,"branch":"fix/42-esc-boom","worktree":".worktrees/42-esc-boom","install":"npm ci","ports":{"postgres":16042,"ollama":22042},"runner":".worktrees/42-esc-boom/agent-test","applied":false}\n',
    "byte-identical to the receipt this script emits with no shim in the way",
  );
});

// #1141: the interpreter this script reads the manifest with is resolved by
// NAME, so a `PATH` that cannot resolve it makes the shell emit `node:
// command not found` — into the `2>&1` capture, where it was reported as
// `could not read origin/main:package.json — <that line>`. An absent
// interpreter is not evidence about the manifest, and while it was reported
// as such the case headed `install: an unparseable manifest refuses, and
// says so` was satisfied by it: measured on this tree before the guard, that case
// PASSES with the interpreter unresolvable. It is the assertion this guard
// exists to make discriminate.
//
// The fixture is the repo's PATH-shadow convention: a directory of symlinks
// to the REAL binaries the script reaches for, resolved from the ambient PATH
// up front, and `PATH` REPLACED by it rather than prepended — prepending
// leaves the interpreter reachable behind the shim and the fixture asks
// nothing. Resolving up front is the same reason `node` itself is linked from
// `process.execPath` rather than by name: a shim dir assembled by asking the
// child to look names up is the very PATH question the fixture controls.
// Nothing here touches the ambient PATH, which siblings on this machine
// inherit.
//
// The list is closed over what a dry run reaches, transitive calls included:
// `sed`, `tr` and `python3` are json.sh's `jstr` (the UTF-8 repair stage
// added for #613 is a new call site of its own), which the receipt goes
// through, and `cksum` is the runner's hash. `mktemp`, `cat` and `rm` joined
// it for #614: derive-testcmd.sh's own `git ls-tree -r -z` listing now writes
// to a temp file rather than a variable (a NUL terminator cannot survive
// `$()`), and claim-ticket.sh calls that script directly. A name absent here
// is one no path under test invokes — a wrapper that logged every exec under
// each of these fixtures named no others — so adding one back needs a call
// site, not a hunch.
const SHIMMED = ["sh", "git", "sed", "tr", "python3", "dirname", "cksum", "grep", "mktemp", "cat", "rm"];
function shimPath({ node }) {
  const bin = mkdtempSync(join(tmpdir(), "claim-path-"));
  for (const name of SHIMMED) {
    const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, name));
  }
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}
const onShimmedPath = (dir, bin) =>
  spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: bin } });

test("install: an unresolvable interpreter refuses in this script's own voice, never the manifest's", () => {
  const dir = repo({ "package.json": "{,,broken", [TESTS]: "" });

  const absent = onShimmedPath(dir, shimPath({ node: false }));
  assert.equal(absent.status, 2, `an unavailable interpreter is a refusal — this script's only failure code\n${absent.stderr}`);
  assert.match(absent.stderr, /^claim-ticket: node is unusable/, "this script's own voice, naming the interpreter as the unusable thing");
  assert.doesNotMatch(absent.stderr, /could not read origin\/main:package\.json/,
    "an interpreter that never ran establishes nothing about the manifest, so it must not claim to");
  // And the refusal is FATAL, which is a separate claim from its wording:
  // derive-testcmd.sh carries the same guard and is delegated to moments
  // later, so a downgraded die here still lands exit 2 carrying a refusal
  // that names the interpreter. Only stopping AT the refusal tells them
  // apart, so the refusal has to be the last thing on stderr.
  assert.equal(absent.stderr.trimEnd().split("\n").length, 1,
    `the guard aborts rather than warning — anything after it is the delegate refusing in this one's place\n${absent.stderr}`);

  // The must-ACCEPT half, on the discriminating input: the SAME unparseable
  // manifest with the interpreter resolvable still earns the manifest refusal
  // word for word. A guard that refused this too would satisfy every
  // assertion above and have destroyed the case it was added to sharpen.
  const present = onShimmedPath(dir, shimPath({ node: true }));
  assert.equal(present.status, 2, `an unparseable manifest still refuses\n${present.stderr}`);
  assert.match(present.stderr, /could not read origin\/main:package\.json/, "the manifest refusal is unchanged");
  assert.doesNotMatch(present.stderr, /node is unusable/, "and does not blame an interpreter that ran");
});

// The false-positive control for the shim dir itself: everything the two
// refusals above rest on is a stripped PATH, and a PATH too thin for the
// script to work at all would produce them for a reason that is not the
// interpreter. This drives a claim to completion under exactly that PATH.
test("install: a resolvable interpreter on the shimmed PATH still derives the install command and the entrypoint", () => {
  const r = onShimmedPath(repo({ "package.json": pkg({}), [TESTS]: "" }), shimPath({ node: true }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /install: true/);
  assert.match(out, /test entrypoint → node --test/);
});

// The silence half of the same guard, on the input that needs no interpreter
// at all: no manifest. The install settles on the `[ -z "$pkg" ]` arm ahead of
// the guard, and the entrypoint on derive-testcmd.sh's test-file fallback,
// which its own `[ -n "$pkg" ]` gate keeps the interpreter out of — so a claim
// that resolves nothing named `node` must still succeed. Nothing but that
// placement holds this: hoisting either guard above its gate refuses every
// manifest-less repo wherever an interpreter happens to be missing, and every
// refusal assertion in this file stays green while it does.
test("install: with no manifest at all the claim needs no interpreter, and neither guard fires", () => {
  const r = onShimmedPath(repo({ [TESTS]: "" }), shimPath({ node: false }));
  assert.equal(r.status, 0, `nothing here reads a manifest, so an unusable interpreter is not this claim's problem\n${r.stdout}${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /install: true/, "the no-manifest arm settles the install without an interpreter");
  assert.match(out, /test entrypoint → node --test/, "and the delegate's test-file fallback settles the entrypoint without one");
  assert.doesNotMatch(out, /node is unusable/, "so neither this script's guard nor the delegate's may speak here");
});

// The delegated cause. A lockfile settles the install without this script
// reading the manifest at all, so its own interpreter guard is never reached
// and `derive-testcmd.sh` is where the interpreter first has to resolve. Its
// refusal travels back through the `2>&1` capture, and what arrives must
// still name the interpreter rather than the manifest.
test("runner: an unresolvable interpreter in the delegated derivation carries that cause through", () => {
  const dir = repo({ "package-lock.json": "{}", "package.json": pkg({ dependencies: { a: "1" } }), [TESTS]: "" });
  const r = onShimmedPath(dir, shimPath({ node: false }));
  assert.equal(r.status, 2, `the wrapping refusal keeps this script's only failure code\n${r.stderr}`);
  assert.match(r.stderr, /derive-testcmd: node is unusable/, "the delegate's own voice, naming the interpreter");
  assert.doesNotMatch(r.stderr, /could not read origin\/main:package\.json/);
});

// ---------------------------------------------------------------------------
// #804 — the argument slot. `claim-ticket.sh` was the last of the four scripts
// taking `--apply` to carry #250's demotion: the arity check was a lower bound
// alone and nothing looked at the flag's VALUE.
//
// Both halves are pinned, because a guard's false-positive class is not its
// false-negative class and the refusal tests alone are satisfied by a guard
// that refuses everything. The accept test is the one that would have caught
// the regression this shape has produced before — a guard hoisted or widened
// until the default dry run stopped exiting 0.

// A PATH whose `gh` records that it ran. The direction that actually mutates
// is only pinned by proving the tracker was never reached: an argument refused
// AFTER `gh issue edit` still exits 2 and still looks like a refusal from the
// outside, which is exactly how the trailing-argument case read as one.
function ghSpy() {
  // Spaced prefix and the `$GH_LOG` form, one convention with the two stubs
  // above (#880). This spy was already safe — it interpolated through
  // `JSON.stringify`, which emits its own quotes — but a second spelling of
  // the same job is what lets the unquoted one look normal, and the
  // `ran() === true` assertion in the accept test below is what holds the env
  // threading here honest.
  const bin = mkdtempSync(join(tmpdir(), "claim ghspy-"));
  const marker = join(bin, "ran");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n`, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: marker }, ran: () => existsSync(marker) };
}

test("#804: a mistyped --apply is refused, never demoted to a dry run", () => {
  // The signature that made this invisible: `42 slug fix` and `42 slug fix
  // --aply` were byte-identical on stdout AND stderr at exit 0. Nothing
  // anywhere said the flag was not understood, so a caller reading `applied`
  // saw an honest `false` for a run it believed had applied.
  //
  // `--apply=true` and `-n` are here because the `=` spelling and the short
  // form are what a caller reaches for when the exact-match rule is not
  // obvious, and both matched nothing before. `apply` unprefixed covers the
  // dropped dashes, which no `--`-prefix rule would catch, and `extra` covers
  // a bare positional landing in the slot — within arity, so the bound below
  // never sees it and only a value check refuses it.
  for (const arg of ["--aply", "--apply=true", "--APPLY", "-n", "apply", "--", "extra"]) {
    const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", arg], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 2, `${arg} must be refused: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /unknown argument/, `${arg} must say the flag was not understood`);
    assert.equal(r.stdout.trim(), "", `${arg} must not emit a receipt: ${r.stdout}`);
  }

  // The discriminator, asserted rather than assumed. At this cwd the FLAGLESS
  // run also exits 2 with empty stdout — it dies on the repository check — so
  // "exit 2 and no receipt" is a signature the unguarded script already
  // produced and pins nothing on its own. What has to be true is that the two
  // runs are now distinguishable, which is the whole of #250.
  const flagless = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: tmpdir(), encoding: "utf8" });
  assert.doesNotMatch(flagless.stderr, /unknown argument/, "the slot rule fired on a run that passed no flag at all");
});

test("#804: a trailing argument is refused on both entry paths, before the tracker is touched", () => {
  // The worse direction. `--apply extra --whatever` dropped args five and six
  // without a word and entered APPLY mode, reaching `gh issue edit 42
  // --add-label in-progress`; the exit 2 it ended on came from that gh call
  // failing, not from any argument refusal. So the assertion that matters is
  // that `gh` never ran — not the exit code, which was already 2.
  //
  // The last row carries no flag in the trailing slot: the arity bound has to
  // hold on its own, without the value rule underneath it happening to catch
  // the same argv. (A bare `extra` in slot FOUR is within arity and is the
  // value rule's to refuse — it is asserted in the mistyped-flag test above,
  // not here, so that each row measures the guard it names.)
  for (const args of [
    ["42", "slug", "fix", "--apply", "extra"],
    ["42", "slug", "fix", "--apply", "extra", "--whatever"],
    ["42", "slug", "fix", "--apply", ""],
    ["42", "slug", "fix", "", "extra"],
  ]) {
    const spy = ghSpy();
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: tmpdir(), encoding: "utf8", env: spy.env });
    assert.equal(r.status, 2, `${args.join(" ")} must be refused: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: claim-ticket\.sh <issue> <slug> <type>/, `${args.join(" ")} must refuse on arity`);
    assert.equal(r.stdout.trim(), "", `${args.join(" ")} must not emit a receipt: ${r.stdout}`);
    assert.equal(spy.ran(), false, `${args.join(" ")} reached the tracker before refusing`);
  }

  // `--write-runner` needs its own bound and cannot borrow the claim path's.
  // Its positional rewrite collapses argv to exactly four before that check
  // runs, so a trailing argument arriving HERE is structurally invisible
  // there — measured on the unguarded script, `--write-runner <dest> 42 EXTRA
  // --junk` dropped both extras, exited 0 and wrote the runner.
  const dir = mkdtempSync(join(tmpdir(), "claim-wr-"));
  for (const args of [
    ["--write-runner", join(dir, "r1"), "42", "EXTRA"],
    ["--write-runner", join(dir, "r2"), "42", "EXTRA", "--junk"],
  ]) {
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")} must be refused: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: claim-ticket\.sh --write-runner/, `${args.join(" ")} must refuse on the write-runner arity`);
  }
  assert.equal(existsSync(join(dir, "r1")), false, "a refused --write-runner must not have written a runner");
  assert.equal(existsSync(join(dir, "r2")), false, "a refused --write-runner must not have written a runner");
});

test("#804: the slot rule accepts every argv it must — the false-positive half", () => {
  // A rule that refused everything satisfies both tests above. This is the
  // shape that regressed once already: a guard widened until it refused the
  // legitimate flags it was never meant to see. The default dry run leads,
  // because it is the mode with no flag in it — the one a suite whose call
  // sites all pass `--apply` cannot see at all.
  const dry = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: repo({ [TESTS]: "" }), encoding: "utf8" });
  assert.equal(dry.status, 0, `the default dry run must still exit 0\n${dry.stdout}${dry.stderr}`);
  assert.match(dry.stdout, /"applied":false/, "and must still emit its receipt");

  // `--apply` still reaches apply mode. Asserted as "the tracker WAS reached",
  // never as "it exited 0": a flag swallowed by a guard that then fell through
  // to the dry-run branch also exits 0, which is the fail-open the slot rule
  // exists to close.
  const spy = ghSpy();
  const applied = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], { cwd: repo({ [TESTS]: "" }), encoding: "utf8", env: spy.env });
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  assert.match(applied.stdout, /"applied":true/, "--apply must still apply");
  assert.equal(spy.ran(), true, "--apply must still reach the tracker");

  // An explicitly empty fourth argument. `${4:-}` cannot tell it from an
  // absent one, so it is a dry run — the same reading both already-guarded
  // siblings give it, and a decision on the record rather than a hole.
  const empty = spawnSync("sh", [SCRIPT, "42", "slug", "fix", ""], { cwd: repo({ [TESTS]: "" }), encoding: "utf8" });
  assert.equal(empty.status, 0, `${empty.stdout}${empty.stderr}`);
  assert.match(empty.stdout, /"applied":false/, "an empty flag slot reads as absent, as it does in the siblings");

  // Both `--write-runner` arities, since the bound is a RANGE and a test of
  // one end pins neither. `<issue>` is optional and defaults to 0.
  const wr = mkdtempSync(join(tmpdir(), "claim-wrok-"));
  for (const args of [["--write-runner", join(wr, "a")], ["--write-runner", join(wr, "b"), "42"]]) {
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: repo({ [TESTS]: "" }), encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")} must be accepted\n${r.stdout}${r.stderr}`);
  }
  assert.equal(existsSync(join(wr, "a")), true, "--write-runner <dest> must still write");
  assert.equal(existsSync(join(wr, "b")), true, "--write-runner <dest> <issue> must still write");

  // The neighbours the slot rule is not allowed to cost. It reads argument
  // four and no other position, so a <slug> or <type> that merely LOOKS like a
  // flag is none of its business — and neither is refused anywhere else.
  const odd = spawnSync("sh", [SCRIPT, "42", "-weird--slug", "fix"], { cwd: repo({ [TESTS]: "" }), encoding: "utf8" });
  assert.equal(odd.status, 0, `a flag-shaped slug must still claim\n${odd.stdout}${odd.stderr}`);
  assert.match(odd.stdout, /"branch":"fix\/42--weird--slug"/, "and must reach the branch name unaltered");
});

// --- #1020: the ambient git variables, one fixture each.
//
// Not one case setting both. PR #1015 measured the cost of that shortcut on
// release-ticket.sh: a fixture overriding only one of the pair leaves the
// other half of `unset GIT_DIR GIT_WORK_TREE` unpinned and green. Here the
// two halves do not even defeat the same guard — GIT_DIR walks past the
// branch-collision check before anything is created, GIT_WORK_TREE walks past
// the lockfile-mutation check after the install has already run — so one
// detector could not see both.

test("an ambient GIT_DIR does not look for the claim's branch in another repository (#1020)", () => {
  // No git call in this script carries a `-C` until after `worktree add`, so
  // an ambient GIT_DIR moves the whole claim elsewhere. The detector is the
  // branch-collision guard, because that is the one whose WRONG answer is
  // the double-claim: two members dispatched onto one ticket, each believing
  // it holds it.
  const dir = repo({ [TESTS]: "" });
  execFileSync("git", ["branch", "fix/42-slug", "HEAD"], { cwd: dir, stdio: "pipe", env: FIXTURE_ENV });
  const other = repo({ [TESTS]: "" });

  // The fixture's own positive control: without it, a case where the branch
  // was never created passes while pinning nothing, and a case where BOTH
  // repos carry the branch passes for the wrong reason.
  assert.equal(
    spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/fix/42-slug"], { cwd: other, env: FIXTURE_ENV }).status,
    1,
    "fixture: the other repository must NOT carry the branch, or looking in the wrong place would give the right answer",
  );

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], {
    cwd: dir, encoding: "utf8", env: { ...FIXTURE_ENV, GIT_DIR: join(other, ".git") },
  });

  assert.equal(r.status, 2,
    `an ambient GIT_DIR must not make an already-claimed ticket look free; got\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /branch fix\/42-slug already exists/,
    "and it must refuse for the real reason rather than tripping over something else");
  assert.equal(r.stdout, "", "a refusal emits no receipt — a receipt here is a claim the caller would act on");
});

test("an ambient GIT_WORK_TREE does not make a mutated lockfile look clean (#1020)", () => {
  // GIT_WORK_TREE outranks `-C`, so `git -C "$wt" status --porcelain -uall
  // package-lock.json …` reads the ambient tree against $wt's index. Pointed
  // at the repo root — where the lockfile is untouched — it answers EMPTY at
  // rc 0 while the fresh worktree's copy has been rewritten.
  //
  // The install really does mutate, through a shimmed `npm` rather than a
  // hand-edit after the fact: this guard runs immediately after the install
  // and there is no seam between them to write a file into. The shim IS the
  // hazard the guard exists for — npm@11 pruning cross-platform optional deps
  // is the header's own example.
  const files = {
    [TESTS]: "",
    "package.json": pkg({ name: "x", scripts: { test: "true" } }),
    "package-lock.json": '{"lockfileVersion":3}\n',
  };
  const bin = mkdtempSync(join(tmpdir(), "claim-mutating-npm-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "npm"),
    '#!/bin/sh\nprintf \'{"lockfileVersion":3,"MUTATED":true}\\n\' > package-lock.json\nexit 0\n',
    { mode: 0o755 });
  const env = (extra) => ({ ...FIXTURE_ENV, PATH: `${bin}:${process.env.PATH}`, ...extra });

  // The control, and it is not optional: it proves the shim really mutates and
  // the guard really fires on it. Without it a shim that silently did nothing
  // would leave the poisoned run exiting 0 for an innocent reason, and the
  // assertion below would be measuring the absence of a hazard rather than its
  // containment.
  const control = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: repo(files), encoding: "utf8", env: env(),
  });
  assert.equal(control.status, 2, `fixture: the unpoisoned run must refuse\n${control.stdout}${control.stderr}`);
  assert.match(control.stderr, /install mutated the lockfile/);

  const dir = repo(files);
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: env({ GIT_WORK_TREE: dir }),
  });

  assert.equal(r.status, 2,
    `an ambient GIT_WORK_TREE must not make the lockfile guard answer about the repo root; got\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /install mutated the lockfile/,
    "and for the real reason — this guard is the only thing between a wrong install command and a lockfile corrupted for everyone");
  assert.doesNotMatch(r.stdout, /"applied":true/, "a claim must not be handed out over an unverified lockfile");
});
