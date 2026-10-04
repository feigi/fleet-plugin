import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { join, dirname, relative } from "node:path";
import { writeExecStub } from "./support/exec-stub.mjs";

// This repository's own test runner, `./agent-test` at the repo root: the
// `node --test` argument shim that left claim-ticket.sh's emitter for a
// repo-local runner (ADR 0015). These cases moved here with it, unchanged in
// what they assert; only the fixture changed — the runner is copied into a
// fixture tree rather than emitted by a claim.
const RUNNER = join(import.meta.dirname, "..", "agent-test");
// Installed through `writeExecStub`, never copied: a copy is a new executable
// inode per fixture, and macOS scans each one on its first exec.
const RUNNER_BODY = readFileSync(RUNNER, "utf8");

// `node --test` marks the processes it spawns, and an inherited mark makes
// the runner's own `node --test` report to a parent that is not listening —
// status 0 and not a byte of stdout. An artifact of testing a test runner
// from inside one; strip it so these assertions see what a member sees.
// FORCE_COLOR is stripped for the same reason: it reaches the runner's own
// `node --test`, which then SGR-wraps its summary even into a pipe
// (`\x1b[34mℹ pass 3\x1b[39m`), breaking every `run`/`runFrom` assertion
// that reads that summary literally. A developer with FORCE_COLOR set is
// exactly what these assertions have to survive, not exercise.
function runnerEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.FORCE_COLOR;
  return env;
}

// Lays `files` out the way a claim does — once in the repository's own
// checkout `<parent>/claim-XXXX` and once in its worktree
// `.worktrees/42-slug` under it — and puts the runner in the worktree. The
// layout is load-bearing: the runner judges an argument by where its
// resolution DIVERGES from the runner's own location, so the ancestry above
// it (and the copy of the suite sitting in it) is part of what the
// vendored-path guards have to ignore, and only a fixture built under a
// `node_modules` parent can pin that.
function apply(files, parent = null) {
  const dir = parent === null ? tempDir("claim-") : mkdtempSync(join(parent, "claim-"));
  const wt = join(dir, ".worktrees", "42-slug");
  for (const root of [dir, wt]) {
    mkdirSync(root, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), body);
    }
  }
  writeExecStub(join(wt, "agent-test"), RUNNER_BODY);
  const env = runnerEnv();
  return {
    wt,
    env,
    run: (...args) => spawnSync(join(wt, "agent-test"), args, { cwd: wt, encoding: "utf8", env }),
    // The same runner invoked from a subdirectory. Node resolves argv against
    // the cwd, so where a member stands is part of what an argument means.
    runFrom: (sub, ...args) =>
      spawnSync(join(wt, "agent-test"), args, { cwd: join(wt, sub), encoding: "utf8", env }),
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
  const bin = tempDir("claim-locale-");
  // The byte cannot be spelled in JS — node re-encodes every string as UTF-8 on
  // the way to argv, turning `\xFF` into the two valid bytes `\303\277`. POSIX
  // `printf` interprets the octal escape, so the fixture stays pure ASCII and
  // the shell makes the byte.
  writeExecStub(join(bin, "find"), "#!/bin/sh\nprintf 't/b\\377ad.test.mjs\\nt/ok.test.mjs\\n'\n");
  writeExecStub(join(bin, "node"), '#!/bin/sh\nprintf %s "$#"\n');
  const r = spawnSync(join(a.wt, "agent-test"), ["t"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}`, LC_ALL: "en_US.UTF-8" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "3", "discovery lost a path holding an invalid UTF-8 byte");
});

// The source-assertion half of #600, on both pins — same shape as
// locale-pin-prose.test.mjs, whose list covers plugin/scripts only; this
// runner is a repo-root file, so the decision is made here instead.
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
test("agent-test still pins the locale on both find-output commands", () => {
  const src = readFileSync(RUNNER, "utf8");
  assert.equal((src.match(/LC_ALL=C grep\b/g) ?? []).length, 1,
    "the directory branch's grep pin (find's output, above) went missing or moved");
  assert.equal((src.match(/LC_ALL=C sed\b/g) ?? []).length, 2,
    "one of the two sed pins (directory branch above, file-argument branch below) went missing");
});

// Why the trailing slash, and why not `-L`: agent-test, above `found=`.
// The symlink is written into the worktree rather than through `apply()` because
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
  // under `-L`, leaving the reasoning in agent-test as the only thing
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
  const outside = tempDir("outside-");
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
  const under = join(tempDir("anc-"), "node_modules");
  mkdirSync(under, { recursive: true });
  const a = apply(SUITE, under);
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
  const under = join(tempDir("anc-"), "node_modules");
  mkdirSync(under, { recursive: true });
  const a = apply(SUITE, under);
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
  const ancestor = join(tempDir("anc-"), "node_modules");
  mkdirSync(ancestor, { recursive: true });
  const a = apply(SUITE, ancestor);
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

// The walk's EXACT-MATCH arm, `| "$shared"` (#1327). The test above pins the
// anchor the walk produces; nothing pinned the arm that ENDS the walk when the
// argument resolves TO an ancestor rather than under it. Deleting it reads as a
// no-op — the next iteration's `"$shared"/*` matches the same path — and is not
// one: it matches against a `$shared` one segment shorter, so
// `${resolved#"$shared"}` gains a leading `/<basename of $resolved>`, and where
// that basename is literally `node_modules` the guard refuses the shared
// ancestor itself. That is the false refusal the walk's own comment already
// names in prose — "a worktree living under one refused every directory
// argument, including the bare invocation's implicit `.`" — asserted there and
// unnoticed here: measured, deleting the arm left the rest of this file green.
//
// Two fixtures, because the arm is reached on two different iterations and the
// mutations that reach them are disjoint. V1 breaks on the FIRST iteration
// ($resolved IS $root); V2 on a later one ($resolved is a proper ancestor of
// $root). Measured over five template variants, every cell run against an
// emitted runner:
//                                        V1 bare  V1 vendored  V2 ../../..
//   `| "$shared"` deleted                RED      pass         RED
//   `case "$1"/ in "$shared"/*`          pass     pass         pass
//   `shared=${root%/*}`                  RED      pass         pass
//   `shared=${shared%/*/*}`              pass     pass         RED
//   guard skipped when $root is vendored pass     RED          pass
// Row two is the behaviour-preserving rewrite of the same `case` — the equality
// spelled as a slash-bound subject instead of its own alternative — and it has
// to stay green, or these rows pin the spelling rather than the behaviour.
// The vendored row is asserted on the MESSAGE, not the status: under the
// over-exempt variant it still exits 1, with node's own `Could not find`, so
// status alone cannot tell a guard that refused from one that was skipped and
// handed node a path it drops (#100's silent shape — the same reason the
// relative-spelling test above asserts its message too).
//
// The file arm needs no row of its own, and that is measured rather than
// assumed. #1016 left ONE walk holding ONE such arm: it occurs exactly once in
// this template, and deleting that occurrence changes exactly one line of the
// emitted runner, so these rows pin it for both callers — and the mixed-argv
// rows above already pin that the file arm re-runs the walk rather than reading
// a stale `$shared`. The file caller cannot reach the arm in any case: it runs
// only from the `else` of `[ -d "$arg" ]`, over `realpath`'s answer for a path
// that is NOT a directory, while every value `$shared` can hold is `$root` or
// one of its ancestors — all directories, so the equality can never hold.
test("runner: the divergence walk ends on an argument that resolves TO the shared ancestor", () => {
  // V1 — the runner's own directory is named `node_modules`, so a bare
  // invocation's implicit `.` resolves to `$root` itself and the walk's first
  // iteration is the equality. No claim can put a runner there: the worktree
  // is always `.worktrees/<issue>-<slug>`, which cannot be that name. So the
  // runner is copied straight into a `node_modules` directory instead — same
  // bytes, and no worktree the assertions below never inspect.
  const home = join(tempDir("nm-"), "node_modules");
  mkdirSync(home, { recursive: true });
  writeExecStub(join(home, "agent-test"), RUNNER_BODY);
  writeFileSync(join(home, "a.test.mjs"), PASSES);
  // Vendored content one level in, where the exemption is at its widest: the
  // runner's own directory name IS the excluded word, and the guard still has
  // to bite on a path that genuinely descends through another.
  const vendor = join(home, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  const v1 = (...args) =>
    spawnSync(join(home, "agent-test"), args, { cwd: home, encoding: "utf8", env: runnerEnv() });
  // `pass 1`, not merely exit 0: the fixture holds two test files and one of
  // them is vendored, so a count is what says the vendored one stayed out.
  // It does NOT say the argument was honoured rather than dropped — measured,
  // discarding the runner's own file-list handoff (`set -- "$@"` in place of
  // `set -- "$@" $files`) leaves this row byte-identical
  // at `pass 1`, because node's own default discovery from this cwd
  // independently excludes the same vendored file too. V2's `pass 12` below
  // is what pins the argument being honoured; this row does not.
  const bare = v1();
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.match(bare.stdout, /^(?:ℹ|#) pass 1$/m);
  const vendored = v1(join("node_modules", "pkg"));
  assert.notEqual(vendored.status, 0, vendored.stdout + vendored.stderr);
  assert.match(vendored.stderr, /is under node_modules — excluded from the run/);

  // V2 — the runner where the claim actually put it, under a `node_modules`
  // ancestor, with an argument naming that ancestor exactly:
  // `42-slug` -> `.worktrees` -> `claim-XXXX` -> the `node_modules` itself.
  // The walk reaches the equality three iterations down rather than on the
  // first, and the runner is unmoved, so this row cannot be dismissed as an
  // artifact of relocating one.
  const under = join(tempDir("anc-"), "node_modules");
  mkdirSync(under, { recursive: true });
  const a = apply(SUITE, under);
  // 12: the six test files of the committed fixture, once in the repo's own
  // checkout and once in the worktree built from it, both under the named
  // ancestor. Bare discovery from the worktree reports 6, so the count also
  // says the argument reached node instead of being dropped.
  const r = a.run(join("..", "..", ".."));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 12$/m);
});

// The guard resolves `$arg` against the process cwd, but `$root` against the
// runner's own location, so the two are no longer the same anchor and a
// subdirectory invocation exercises a different path than a root one. Measured:
// anchoring the argument at `$root` instead (`cd -- "$root/$arg"`, a one-token
// slip on the argument alone — the runner's `root=` assignment and its
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

// #1628: grep's and sed's own exit codes used to go unread in the
// directory-scan pipe — only whether `$files` ended up non-empty was
// checked — so a scan failure inside either tool (rc 2+, distinct from
// grep's normal rc-1 "no match") read through the emptiness test above as
// an indistinguishable "no test files", even though real test files sit
// right there. Stubbing `grep` itself to die outright (rc 2) is the
// cleanest reproduction of a scan tool breaking mid-run, and must be
// reported as ITS failure, not folded into the empty-directory message.
test("runner: a grep failure mid-scan is reported distinctly from an empty result", () => {
  const a = apply(SUITE);
  const bin = tempDir("claim-grepfail-");
  writeExecStub(join(bin, "grep"), "#!/bin/sh\nexit 2\n");
  const r = spawnSync(join(a.wt, "agent-test"), ["t"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /could not scan for test files under t \(grep exited 2\)/);
  assert.doesNotMatch(r.stderr, /no test files under/);
});

// The other half: sed sits downstream of grep in the same pipe, and its own
// rc was just as unread. Stubbing `sed` alone (grep runs for real, matches
// `t`'s two files, then hands them to the dying stub) isolates sed's status
// from grep's — the failure must still name sed, not grep or "no test files".
test("runner: a sed failure mid-scan is reported distinctly from an empty result", () => {
  const a = apply(SUITE);
  const bin = tempDir("claim-sedfail-");
  writeExecStub(join(bin, "sed"), "#!/bin/sh\nexit 2\n");
  const r = spawnSync(join(a.wt, "agent-test"), ["t"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /could not scan for test files under t \(sed exited 2\)/);
  assert.doesNotMatch(r.stderr, /no test files under/);
});

// BSD sed (this machine's actual /usr/bin/sed) exits rc 1 for EVERY error it
// reports — illegal byte sequence, malformed regex, missing file — there is
// no BSD sed error path that ever reaches rc 2+. A guard that tolerated
// `sed_rc -le 1` (mirroring grep's real "no match is rc 1" case) could NEVER
// catch a genuine BSD sed failure: the stub below reproduces that exact
// shape — always exit 1, the way real BSD sed does on a bad invocation —
// and must still be reported as a sed failure, not silently folded into "no
// test files" the way an unread rc would. (Reverting the guard to
// `-le 1` reproduces the pre-fix bug: this test goes green on silence,
// asserting `no test files under t` instead of a reported sed failure.)
test("runner: a BSD-style sed rc-1 failure is reported, not tolerated as a no-match analog", () => {
  const a = apply(SUITE);
  const bin = tempDir("claim-sedrc1-");
  writeExecStub(join(bin, "sed"), "#!/bin/sh\nexit 1\n");
  const r = spawnSync(join(a.wt, "agent-test"), ["t"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /could not scan for test files under t \(sed exited 1\)/);
  assert.doesNotMatch(r.stderr, /no test files under/);
});

// grep's rc 1 ("no match") must NOT be swept into the same failure this pins
// above — that is the genuinely-empty case the pre-existing "no test files"
// test (above) already covers end to end. This is the narrower unit-level
// half: a stub that always exits 1, never touching `find` or the real test
// files, pins that a bare "no match" alone still reaches the ORIGINAL
// "no test files" message, not the new "grep exited" one.
test("runner: grep's plain no-match rc still reads as no test files, not a grep failure", () => {
  const a = apply(SUITE);
  const bin = tempDir("claim-grepnomatch-");
  writeExecStub(join(bin, "grep"), "#!/bin/sh\nexit 1\n");
  const r = spawnSync(join(a.wt, "agent-test"), ["t"], {
    cwd: a.wt,
    encoding: "utf8",
    env: { ...a.env, PATH: `${bin}:${a.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /no test files under t/);
  assert.doesNotMatch(r.stderr, /grep exited/);
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
// `apply()`: a leading-dash directory NAME is a shell/CLI-argument concern,
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
// It is written into the worktree rather than through `apply()` because that is
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
  const base = tempDir("anc-");
  const real = join(base, "real");
  const spelled = join(base, "link");
  mkdirSync(real);
  symlinkSync(real, spelled);
  mkdirSync(join(real, "node_modules"), { recursive: true });
  const a = apply(SUITE, join(spelled, "node_modules"));
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
// worktree rather than through `apply()` for the same reason as the nested
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
// (see agent-test, above `root=`); this pins the file branch's copy.
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
  const decoy = tempDir("cdpath-decoy-");
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
  const outside = tempDir("outside-");
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
  const outside = tempDir("outside-ok-");
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
// mandate, so the runner dies rather than guessing when it is missing. Absent,
// this guard disarmed whole: the vendored file ran, the run exited 0 reporting
// `pass 2`, and not one byte reached stderr — #424's own defect restored with no
// notice. Absence is not a fallback case, it is a question this cannot answer,
// so it refuses. A stub that exits 127 rather than an emptied PATH, so `sed`,
// `dirname` and `node` still work and the resolver is the only thing missing.
test("runner: an unresolvable argument refuses rather than running unchecked", () => {
  const a = apply(SUITE);
  const vendor = join(a.wt, "node_modules", "pkg");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "v.test.mjs"), PASSES);
  symlinkSync(join("node_modules", "pkg", "v.test.mjs"), join(a.wt, "vendlink.test.mjs"));
  const bin = tempDir("no-realpath-");
  writeExecStub(join(bin, "realpath"), "#!/bin/sh\nexit 127\n");
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
// rather than through `apply()`, for the reason the dash-named directory
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
