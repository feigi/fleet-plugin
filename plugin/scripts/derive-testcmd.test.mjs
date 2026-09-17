import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// derive-testcmd.sh is the ONE place the test-entrypoint inference lives —
// reused by claim-ticket.sh (ref origin/main, worktree setup) and by
// review-pr.js's snapshot agent (ref HEAD, the repo under review), so the
// decision cannot drift between two independently-maintained copies (#142).
const SCRIPT = join(import.meta.dirname, "derive-testcmd.sh");

// A repo that is NOT claude-config. #142's own acceptance criterion is
// explicit that an archive OF this repo cannot prove the inference is
// portable — `claim-ticket.test.mjs`'s `repo()` already never checks out this
// repo either, for the same reason. Every fixture here is a synthetic tree.
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-"));
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
  return dir;
}

function derive(dir, ref = "HEAD", env = process.env) {
  const r = spawnSync("sh", [SCRIPT, dir, ref], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

const pkg = (o) => JSON.stringify(o);
const PASSES = 'import { test } from "node:test";\ntest("ok", () => {});\n';

test("a manifest declaring scripts.test wins", () => {
  const dir = repo({ "package.json": pkg({ scripts: { test: "vitest" } }) });
  const { status, out } = derive(dir);
  assert.equal(status, 0);
  assert.equal(out, "npm test --");
});

test("no scripts.test but test files present falls back to node --test", () => {
  const dir = repo({ "t.test.mjs": PASSES });
  const { status, out } = derive(dir);
  assert.equal(status, 0);
  assert.equal(out, "node --test");
});

// #614 named TWO bugs, and each needs its own fixture — one config does not
// exercise the other:
//
// 1. THE ONE `-z` ACTUALLY FIXES, below: under `core.quotePath`'s DEFAULT
//    `true`, git C-quotes a path holding a high-bit byte — `"b\377ad.test.mjs"`,
//    literal backslash-digits, wrapped in `"..."`. The trailing `"` defeats
//    `$testfile_re`'s `$` anchor: the line ends in `"`, not `.mjs`, so a repo
//    that demonstrably has a test file is refused as having none. This has
//    NOTHING to do with locale — measured reproducing under both `LC_ALL=C`
//    and an ambient UTF-8 locale identically (`derive-testcmd.sh` internally
//    `export`s `LC_ALL=C` regardless of the caller's environment, so an
//    ambient override cannot even reach the byte-sensitive `grep`). `-z`
//    fixes it by never asking git to quote at all, in any locale.
// 2. THE SEPARATE ONE BELOW ("regardless of core.quotePath, under an ambient
//    UTF-8 locale"): with `core.quotePath false` set, plain
//    `git ls-tree -r --name-only` ALREADY emits the byte unquoted — `-z` is
//    not what makes that case work, and reverting `-z` alone leaves that
//    fixture green. What that fixture pins instead is that the byte, once
//    unquoted, survives `tr`/`grep` intact only under `LC_ALL=C`; it is a
//    regression pin for the *locale* hazard (#582), not for the C-quoting
//    defect `-z` fixes.
//
// Mutation-verified against fixture 1 (this repo, #1271): reverting the `-z`
// fix to plain `git ls-tree -r --name-only` turns fixture 1 red — the script
// reports "has no scripts.test and no test files" against a repo that
// demonstrably has one — while fixture 2 stays green throughout, confirming
// it does not cover this scenario. Restoring `-z` turns fixture 1 green
// again.
test("a non-ASCII test filename is found under core.quotePath's default true (#614)", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  // Explicit, not relied on as an implicit default: pins the scenario against
  // a future git that ships a different default, rather than silently
  // tracking whatever git on the test runner happens to default to.
  execFileSync("git", ["config", "core.quotePath", "true"], { cwd: dir });
  writeFileSync(join(dir, "readme.md"), "x");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "x"], { cwd: dir });
  // A high-bit byte in the name: APFS refuses to hold it on disk, so it goes
  // in through the index directly, spelled as a `printf` FORMAT — node
  // re-encodes a JS string as UTF-8 on the way to argv, which would turn
  // `\377` into valid UTF-8 and reproduce nothing.
  const blob = execFileSync("sh", ["-c", "printf x | git hash-object -w --stdin"],
    { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("sh", ["-c",
    'git update-index --add --cacheinfo "100644,$1,$(printf "$2")"',
    "sh", blob, "b\\377ad.test.mjs"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "add bad name"], { cwd: dir });

  const r = spawnSync("sh", [SCRIPT, dir, "HEAD"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "node --test");
});

// The SECOND #614 fixture (see the block comment above): with
// `core.quotePath false` set, plain `git ls-tree -r --name-only` already
// emits the high-bit byte unquoted — `-z` buys nothing here, this does NOT
// exercise the C-quoting defect the fixture above pins. What this pins is the
// separate, locale-dependent hazard #582 already named: the unquoted byte
// only survives `tr`/`grep` intact under `LC_ALL=C`. Kept as its own
// regression pin for that concern, not overclaiming coverage of the
// C-quoting defect.
const AMBIENT_UTF8 = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: undefined, LC_CTYPE: undefined };
test("a non-ASCII test filename with core.quotePath false survives an ambient UTF-8 locale (#614)", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["config", "core.quotePath", "false"], { cwd: dir });
  writeFileSync(join(dir, "readme.md"), "x");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "x"], { cwd: dir });
  // A high-bit byte in the name: APFS refuses to hold it on disk, so it goes
  // in through the index directly, spelled as a `printf` FORMAT — node
  // re-encodes a JS string as UTF-8 on the way to argv, which would turn
  // `\377` into valid UTF-8 and reproduce nothing.
  const blob = execFileSync("sh", ["-c", "printf x | git hash-object -w --stdin"],
    { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("sh", ["-c",
    'git update-index --add --cacheinfo "100644,$1,$(printf "$2")"',
    "sh", blob, "b\\377ad.test.mjs"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "add bad name"], { cwd: dir });

  const r = spawnSync("sh", [SCRIPT, dir, "HEAD"], { encoding: "utf8", env: AMBIENT_UTF8 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "node --test");
});

test("neither a test script nor test files refuses rather than passing vacuously", () => {
  const dir = repo({ "README.md": "" });
  const { status, err } = derive(dir);
  assert.notEqual(status, 0);
  assert.match(err, /pass vacuously/);
});

test("a manifest with an empty scripts object falls back to the test-file check", () => {
  const dir = repo({ "package.json": pkg({ scripts: {} }), "t.test.mjs": PASSES });
  const { status, out } = derive(dir);
  assert.equal(status, 0);
  assert.equal(out, "node --test");
});

test("a non-repository directory refuses cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-not-a-repo-"));
  const { status, err } = derive(dir);
  assert.notEqual(status, 0);
  assert.match(err, /not a git repository/);
});

test("wrong argument count refuses with a usage message", () => {
  const dir = repo({ "README.md": "" });
  const r = spawnSync("sh", [SCRIPT, dir], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: derive-testcmd\.sh <repo> <ref>/);
});

// `node --test` marks its children with these; inherited, a nested run's
// stdout arrives empty and reads as `tests 0` — a false red for a run that
// never happened. FORCE_COLOR goes for the same reason and is the same fix
// claim-ticket.test.mjs applies to its own spawns: inherited, it reaches the
// child's `node --test`, which SGR-wraps its summary even into a pipe
// (`\x1b[34mℹ pass 1\x1b[39m`), and the `^(?:ℹ|#) …$` assertions below read
// that summary literally. A developer with FORCE_COLOR set is what these
// assertions have to survive, not exercise.
function withoutNestedTestMarkers() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.FORCE_COLOR;
  return env;
}

// Parsing which form the derivation picked is the same bet #142 exists to
// close — RUN what it derived, against a repo that is not this one, and read
// the actual count. Mirrors the rigor `claim-ticket.test.mjs` and the old
// `review-pr-testcmd.test.mjs` applied to this repo's own suite.
test("the derived npm command actually runs the manifest's tests", () => {
  const dir = repo({
    "package.json": pkg({ scripts: { test: "node --test" } }),
    "t.test.mjs": PASSES,
  });
  const { out } = derive(dir);
  assert.equal(out, "npm test --");
  const r = spawnSync(out, { cwd: dir, shell: true, encoding: "utf8", env: withoutNestedTestMarkers() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:ℹ|#) pass 1$/m);
});

test("the derived node --test command actually runs the repo's test files", () => {
  const dir = repo({ "t.test.mjs": PASSES, "sub/u.test.mjs": PASSES });
  const { out } = derive(dir);
  assert.equal(out, "node --test");
  const r = spawnSync(out, { cwd: dir, shell: true, encoding: "utf8", env: withoutNestedTestMarkers() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ran = r.stdout.match(/^(?:ℹ|#) tests (\d+)$/m);
  assert.ok(ran && Number(ran[1]) > 0, `ran no tests:\n${r.stdout}`);
});

// The ref argument is not decoration — a caller can point this at any commit
// in the repo, not only the working tree's checkout.
test("derives from the given ref, not just the latest commit", () => {
  const dir = repo({ "README.md": "" });
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "t.test.mjs"), PASSES);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "add tests"], { cwd: dir });

  const atBefore = derive(dir, before);
  assert.notEqual(atBefore.status, 0);
  assert.match(atBefore.err, /pass vacuously/);

  const atHead = derive(dir, "HEAD");
  assert.equal(atHead.status, 0);
  assert.equal(atHead.out, "node --test");
});

// A ref this repo cannot list is a DIFFERENT failure from "this ref has no
// tests", and the refusal has to say which. Piped into `grep -q`, a dying
// `ls-tree` was swallowed — the pipeline reports grep's status — so a repo
// that demonstrably HAS test files got the vacuous-pass refusal, naming a
// cause that is not the cause. review-pr.js forwards this stderr verbatim as
// `testCmdError`, so the review then refuses for the wrong reason.
test("a ref that cannot be listed names THAT, not a missing test suite", () => {
  const dir = repo({ "t.test.mjs": PASSES });
  const { status, err } = derive(dir, "nosuchref");
  assert.notEqual(status, 0);
  assert.match(err, /derive-testcmd: cannot list nosuchref/);
  assert.doesNotMatch(err, /pass vacuously/);
});

test("an unborn HEAD names the listing failure too", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-testcmd-unborn-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const { status, err } = derive(dir, "HEAD");
  assert.notEqual(status, 0);
  assert.match(err, /derive-testcmd: cannot list HEAD/);
  assert.doesNotMatch(err, /pass vacuously/);
});

// A manifest that does not parse is not evidence of a manifest without a test
// script. Swallowed, this repo's real entrypoint (`vitest run`) was silently
// replaced by `node --test` and reported as a success — review-pr.js has no
// install step to trip over the same corruption later, so nothing downstream
// catches it. claim-ticket.sh already refuses on this same file for the
// dependency count it reads; both readers now agree.
test("a manifest that does not parse refuses instead of degrading to node --test", () => {
  const dir = repo({ "package.json": '{"scripts":{"test":"vitest run"},}', "t.test.mjs": PASSES });
  const { status, out, err } = derive(dir);
  assert.notEqual(status, 0);
  assert.equal(out, "");
  assert.match(err, /could not read HEAD:package\.json/);
  assert.doesNotMatch(err, /pass vacuously/);
});

// The two `testfile_re` literals cannot be one — claim-ticket.sh needs a shell
// string inside the runner heredoc it writes, not a git query — so the comment
// on each says "kept in sync by hand". This turns that promise into a checked
// invariant: adding a suffix to one copy alone previously left all 55 tests in
// this file, claim-ticket.test.mjs and review-pr-testcmd.test.mjs green, so
// "does a suite exist at all" could drift from "which files the runner picks
// up" in silence. Exactly the drift #142 exists to remove for testCmd itself.
test("derive-testcmd.sh and claim-ticket.sh declare the same testfile_re", () => {
  const literal = (file) => {
    const m = readFileSync(join(import.meta.dirname, file), "utf8").match(/^testfile_re=(.+)$/m);
    assert.ok(m, `${file} no longer declares testfile_re at the start of a line — update this test`);
    return m[1];
  };
  assert.equal(literal("derive-testcmd.sh"), literal("claim-ticket.sh"));
});

// #1141: this script resolves its interpreter by NAME, so a `PATH` that
// cannot resolve it makes the shell emit `node: command not found` into the
// `2>&1` capture, land on the `*)` arm, and refuse as `could not read
// <ref>:package.json` — the manifest's name for a fault that is not the
// manifest's. Two consumers read that refusal: claim-ticket.sh wraps it into
// its own, and review-pr.js's snapshot agent reads it against a repo under
// review. An absent interpreter is not evidence about the manifest.
//
// The repo's PATH-shadow convention: symlinks to the REAL binaries this
// script reaches for, resolved from the ambient PATH up front, with `PATH`
// REPLACED rather than prepended — prepending leaves the interpreter
// reachable behind the shim and the fixture asks nothing. `node` is linked
// from `process.execPath` for the same reason the spawns in this repo's
// suites use it: a name is exactly what a stripped PATH cannot answer.
// Nothing here mutates the ambient PATH.
//
// The list is closed: this script sources nothing, so `git`, `grep`, `mktemp`,
// `cat`, `tr` and `rm` are its whole external set beside the shell (#614 added
// the last four, for the byte-safe `-z` listing and its temp-file cleanup). A
// name absent here is one no derivation invokes — a wrapper that logged every
// exec under both derivations named no others — so adding one back needs a
// call site, not a hunch.
const SHIMMED = ["sh", "git", "grep", "mktemp", "cat", "tr", "rm"];
function shimPath({ node }) {
  const bin = mkdtempSync(join(tmpdir(), "derive-path-"));
  for (const name of SHIMMED) {
    const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, name));
  }
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}
const onShimmedPath = (dir, bin) =>
  spawnSync("sh", [SCRIPT, dir, "HEAD"], { encoding: "utf8", env: { ...process.env, PATH: bin } });

test("an unresolvable interpreter refuses in this script's own voice, never the manifest's", () => {
  const dir = repo({ "package.json": pkg({ scripts: { test: "vitest run" } }), "t.test.mjs": PASSES });

  const absent = onShimmedPath(dir, shimPath({ node: false }));
  assert.equal(absent.status, 1, `an unavailable interpreter is a refusal — this script's only failure code\n${absent.stderr}`);
  assert.equal(absent.stdout, "", "and emits no entrypoint it could not derive");
  assert.match(absent.stderr, /^derive-testcmd: node is unusable/, "this script's own voice, naming the interpreter as the unusable thing");
  assert.doesNotMatch(absent.stderr, /could not read HEAD:package\.json/,
    "an interpreter that never ran establishes nothing about the manifest, so it must not claim to");

  // The must-ACCEPT half on the discriminating input: an unparseable manifest
  // with the interpreter resolvable still earns the manifest refusal word for
  // word, so this case and `a manifest that does not parse refuses instead of
  // degrading to node --test` cannot be satisfied by each other's cause.
  const broken = repo({ "package.json": '{"scripts":{"test":"vitest run"},}', "t.test.mjs": PASSES });
  const present = onShimmedPath(broken, shimPath({ node: true }));
  assert.equal(present.status, 1, present.stderr);
  assert.match(present.stderr, /could not read HEAD:package\.json/, "the manifest refusal is unchanged");
  assert.doesNotMatch(present.stderr, /node is unusable/, "and does not blame an interpreter that ran");
});

// The false-positive control for the shim dir: both refusals above rest on a
// stripped PATH, and a PATH too thin for this script to work at all would
// produce them for a reason that is not the interpreter. Both derivations run
// to completion under exactly that PATH.
test("a resolvable interpreter on the shimmed PATH still derives both entrypoints", () => {
  const bin = shimPath({ node: true });
  const fromManifest = onShimmedPath(repo({ "package.json": pkg({ scripts: { test: "vitest" } }) }), bin);
  assert.equal(fromManifest.status, 0, fromManifest.stderr);
  assert.equal(fromManifest.stdout.trim(), "npm test --");
  const fromFiles = onShimmedPath(repo({ "t.test.mjs": PASSES }), bin);
  assert.equal(fromFiles.status, 0, fromFiles.stderr);
  assert.equal(fromFiles.stdout.trim(), "node --test");
});

// --- #1020: the ambient GIT_DIR that outranks `-C "$repo"`.
//
// One case, not two, and that is a measurement rather than an omission.
// GIT_WORK_TREE is unset by the script alongside GIT_DIR, but it is INERT
// here: all three calls are object-database reads (`rev-parse --git-dir`,
// `ls-tree`, `show`) and none consults a work tree, so every target produces
// byte-identical output. A fixture for that half could only be vacuous —
// precisely the shape PR #1015 warned about — so the line's GIT_WORK_TREE
// half is pinned as source by ambient-git-vars-prose.test.mjs instead.
test("an ambient GIT_DIR does not derive another repository's entrypoint (#1020)", () => {
  // The two repos must disagree on the ANSWER, not merely on their contents:
  // one declares `scripts.test` and derives `npm test --`, the other declares
  // none and falls back to `node --test`. Two fixtures that happened to agree
  // would leave a retargeted run emitting the right string for the wrong
  // reason, and this case green over the live defect.
  const here = repo({ "package.json": pkg({ scripts: { test: "vitest" } }), "t.test.mjs": PASSES });
  const elsewhere = repo({ "package.json": pkg({ name: "other" }), "t.test.mjs": PASSES });

  // The fixture's own positive control, both halves: each repo really does
  // derive what this case assumes it derives.
  assert.equal(derive(here).out, "npm test --", "fixture: this repo must derive from its manifest");
  assert.equal(derive(elsewhere).out, "node --test", "fixture: the other repo must derive differently");

  const r = spawnSync("sh", [SCRIPT, here, "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: join(elsewhere, ".git") },
  });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "npm test --",
    "an ambient GIT_DIR must not answer for another repository — both consumers act on this string, and claim-ticket.sh bakes it into the runner it materialises");
});

// --- #1175: the cross-file invariant claim-ticket.sh's `$testcmd` rests on.
//
// That script captures THIS one with stderr merged and then reads the result
// on its SUCCESS path — echoed, compared against the literal `node --test`,
// and baked into the `exec $testcmd "$@"` of the runner it materialises — with
// no shape guard on the capture, unlike the `ndeps` capture above it. Its own
// comment states what makes that safe: "derive-testcmd.sh writes nothing to
// stderr when it succeeds, so the success path still captures the command
// alone." Nothing pinned that, and it is a claim about THIS file's behaviour,
// enforceable only here.
//
// Measured against the tracked scripts: claim-ticket.sh's capture construct,
// copied verbatim, pointed at a copy of this script carrying one added
// `echo >&2` before its `node --test` emit, captures `warning: chatty\nnode
// --test` — the `= "node --test"` comparison silently takes the wrong arm and
// the emitted runner's `exec` runs the chatter as a command. So a warning, a
// deprecation notice or a `set -x` left on a success path here is a live
// defect in a sibling file, with nothing between the two but this case.
//
// The chatter env is not decoration and the fixtures must carry a manifest.
// What keeps node's OWN stderr out of this script's today is that both inner
// node calls are captured `2>&1` (into $nodeerr and $pkgerr) and read only in
// refusal arms — and neither call happens at all unless `git show
// <ref>:package.json` returned something. A manifest-less fixture pins the
// emit lines but says NOTHING about that swallowing, which is the half that is
// actually load-bearing: #1175's own verification ran against this repo at
// origin/main, which has no package.json, so it never invoked node and could
// not have observed the thing it reported as verified.
const CHATTY_NODE = { ...process.env, NODE_DEBUG: "module" };
test("every success path writes nothing to stderr, even when node is chatty (#1175)", () => {
  // Positive control, resolved by NAME exactly as the script resolves it: the
  // env really does make that interpreter noisy, so green below is the
  // swallowing working rather than an inert variable.
  const control = spawnSync("node", ["-e", "0"], { encoding: "utf8", env: CHATTY_NODE });
  assert.equal(control.status, 0, "fixture: `node -e 0` must run for this control to mean anything");
  assert.ok(control.stderr.length > 0,
    "fixture: NODE_DEBUG=module must make node write to its own stderr, or these legs prove nothing");

  // All three success routes, not just the two manifest-bearing ones: a
  // declared scripts.test (the parse probe exits 0), a manifest declaring
  // none (exits 1, falling through to the test-file check), and no manifest
  // at all ($pkg empty, skipping the whole `if [ -n "$pkg" ]` block — #1175's
  // own review found this exact gap, since a stderr write reachable only on
  // that route runs neither inner node call and so has no swallowing to hide
  // behind). Each manifest-bearing arm runs both inner node calls under the
  // control's env; the no-manifest arm invokes node zero times, so it is the
  // one route where the swallowing argument does not apply at all and only
  // the emit arms can write. Plain-env legs are omitted, not forgotten — this
  // env is strictly the more hostile one, and a stray write on any arm fails
  // here identically.
  for (const [arm, files] of [
    ["npm test --", { "package.json": pkg({ scripts: { test: "vitest" } }) }],
    ["node --test", { "package.json": pkg({ name: "x" }), "t.test.mjs": PASSES }],
    ["node --test", { "t.test.mjs": PASSES }],
  ]) {
    const r = derive(repo(files), "HEAD", CHATTY_NODE);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, arm, "fixture: this tree must derive the arm under test");
    assert.equal(r.err, "",
      `the ${arm} path must write nothing to stderr — claim-ticket.sh merges this stream into the $testcmd it compares against a literal and execs, with no guard of its own`);
  }
});
