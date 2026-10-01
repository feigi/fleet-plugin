import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeExecStub } from "./exec-stub.mjs";

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
//
// `recipe` is the repository's Recipe cache (ADR 0015), written untracked to
// `.fleet/recipe.json` beside the main checkout's git dir — where
// derive-testcmd.sh reads it — proven at origin/main. Every field is
// overridable; `null` writes no cache at all. The default is the smallest
// Recipe that runs anywhere: nothing to install, nothing to fail.
function repo(files, local = {}, recipe = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claim-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: FIXTURE_ENV, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "x");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [name, body] of Object.entries(local)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (recipe !== null) {
    mkdirSync(join(dir, ".fleet"), { recursive: true });
    writeFileSync(join(dir, ".fleet", "recipe.json"), JSON.stringify({
      install: "true",
      test: "true",
      derivedAt: git("rev-parse", "HEAD").trim(),
      installClean: true,
      testCount: 1,
      ...recipe,
    }));
  }
  return dir;
}

// Returns {install, testcmd} on success, or {err} with the refusal message.
function claim(dir) {
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  if (r.status !== 0) return { err: out };
  return {
    install: out.match(/Install step → (.*)/)?.[1],
    testcmd: out.match(/test entrypoint → (.*)/)?.[1],
  };
}

const TESTS = "run-tests.sh";

// Runs the script for real and returns the emitted runner plus its worktree.
// `--apply` labels the issue, so `gh` is stubbed; everything else — the
// worktree, the install, the exclude file, the runner — is the real thing.
// The runner is what members actually invoke, so it is what gets asserted on.
// `script` defaults to the real one; pass a copy to claim from a different
// template.
function apply(files, script = SCRIPT, recipe = {}) {
  const dir = repo(files, {}, recipe);
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  const r = spawnSync("sh", [script, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const wt = join(dir, ".worktrees", "42-slug");
  return {
    dir,
    wt,
    receipt: JSON.parse(r.stdout),
    text: readFileSync(join(wt, "agent-test"), "utf8"),
    run: (...args) => spawnSync(join(wt, "agent-test"), args, { cwd: wt, encoding: "utf8" }),
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

// #760 — that a claim carries no upstream, and what that means to reap.sh and
// release-ticket.sh — is pinned in claim-lifecycle.test.mjs, not here. This
// file's `repo()` fixture fabricates refs/remotes/origin/main with
// `update-ref` and configures no `origin` remote, so git declines to set an
// upstream from it at all: every assertion about upstream config passes here
// whatever `worktree add` was handed. Measured — a config pin in this fixture
// stayed green with `--no-track` removed.

// --- The runner: a thin exec of the Recipe's Test entrypoint (ADR 0015).

// A script that reports exactly what it was handed — its argv one per line,
// then the isolation triple — so the runner's thinness is measured rather than
// assumed.
const ECHO_TESTS = '#!/bin/sh\nfor a do printf "arg:%s\\n" "$a"; done\nprintf "env:%s %s %s\\n" "$TEST_COMPOSE_PROJECT" "$TEST_POSTGRES_PORT" "$TEST_OLLAMA_PORT"\n';

// The ticket's own acceptance row: a repository with NO package.json — nothing
// any technology table could have recognised — claims on its cache alone, and
// `./agent-test` runs the Test entrypoint, arguments through verbatim (one
// holding a space stays one), under the per-claim isolation exports.
test("runner: a repo with no package.json claims on its Recipe cache and ./agent-test runs the Test entrypoint", () => {
  const a = apply({ "run-tests.sh": ECHO_TESTS }, SCRIPT, { install: "true", test: "sh ./run-tests.sh" });
  assert.equal(existsSync(join(a.wt, "package.json")), false, "fixture: nothing Node-shaped in the tree");
  assert.equal(a.receipt.install, "true");
  const r = a.run("one", "two words");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "arg:one\narg:two words\nenv:ab-42 16042 22042\n");
});

// Thin means the runner adds no verdict of its own: the suite's exit status
// IS the runner's. A red suite is a finding, and must reach the caller as red.
test("runner: the Test entrypoint's own exit status is the runner's", () => {
  const a = apply({ "run-tests.sh": "#!/bin/sh\necho red\nexit 3\n" }, SCRIPT, { test: "sh ./run-tests.sh" });
  const r = a.run();
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "red\n");
});

// The Test entrypoint is a shell command, and the runner must not reinterpret
// it: a single quote survives the runner's own quoting, nothing in it expands
// at write time, and a compound command keeps its meaning with the runner's
// arguments appended to its last simple command.
test("runner: a quoted or compound Test entrypoint runs exactly as written", () => {
  const quoted = apply({}, SCRIPT, { test: `echo "it's \\$HOME's"` });
  assert.match(quoted.text, /^exec sh -c '/m);
  const q = quoted.run("x");
  assert.equal(q.status, 0, q.stderr);
  assert.equal(q.stdout, "it's $HOME's x\n");

  const compound = apply({ "sub/t.sh": ECHO_TESTS }, SCRIPT, { test: "cd sub && sh ./t.sh" });
  const c = compound.run("y");
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^arg:y\n/);
});

// A repository that tracks its own `agent-test` keeps it — the repo-local
// runner ADR 0015 sends any convenience beyond the thin exec to (this repo's
// own node --test shim is one). Written over, it would be a modified TRACKED
// path every release then strands on (#1262), so it is left byte-identical and
// not added to the exclude list.
test("runner: a tracked repo-local agent-test is left as is", () => {
  const own = "#!/bin/sh\necho repo-local\n";
  const a = apply({ "agent-test": own }, SCRIPT, { test: "sh ./run-tests.sh" });
  assert.equal(a.text, own);
  const status = execFileSync("git", ["-C", a.wt, "status", "--porcelain"], { encoding: "utf8", env: FIXTURE_ENV });
  assert.equal(status, "", "the tracked runner must not show as modified");
});

// regardless of whether the runner branch above actually exported it. A
// tracked repo-local agent-test never receives those exports (previous
// test), so a receipt claiming them would tell a caller to trust isolation
// that is not there (measured: the echoed env was empty against a real
// tracked runner). `null` is the honest value — the object appears only when
// this script wrote the exports itself.
test("runner: a tracked repo-local agent-test's receipt does not claim ports it never exported", () => {
  const own = "#!/bin/sh\necho repo-local\n";
  const a = apply({ "agent-test": own }, SCRIPT, { test: "sh ./run-tests.sh" });
  assert.equal(a.receipt.ports, null, "isolation was never exported into the tracked runner");
  assert.equal(a.receipt.applied, true, "the claim itself still went through");
});

// #124: the runner is written once at claim time and never rewritten, so an
// old worktree can hold a runner a later template fix never reached. Nothing
// in the file said which template produced it — this pins the fix.
const STAMP_RE = /^# agent-test template: (\S+)$/m;

test("runner: carries a template stamp", () => {
  const { text } = apply({});
  assert.match(text, STAMP_RE);
});

// Same script, two claims — the stamp is a property of this script's own
// bytes, not of the claim, so it must not vary with the issue number, ports,
// or the Recipe baked into the rest of the file.
test("runner: the stamp is stable across claims of the same template", () => {
  const a = apply({}, SCRIPT, { test: "true" }).text.match(STAMP_RE)[1];
  const b = apply({}, SCRIPT, { test: "false" }).text.match(STAMP_RE)[1];
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
  writeExecStub(sibling, readFileSync(join(import.meta.dirname, "derive-testcmd.sh"), "utf8"));
  for (const lib of ["json.sh", "worktree.sh"]) {
    copyFileSync(join(import.meta.dirname, lib), join(scriptDir, lib));
  }

  const after = apply({}, editedScript).text.match(STAMP_RE)[1];
  const before = apply({}).text.match(STAMP_RE)[1];

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
    assert.match(bin, / /, "fixture: the stub's directory must hold a space, or this pins nothing");
    const ghLog = join(bin, "gh.log");
    // `>> "$GH_LOG"`, not the interpolated path (#880). The path comes from
    // `mkdtempSync(join(tmpdir(), …))` and so inherits `TMPDIR`; unquoted, a
    // space in it word-split the redirect, the shell wrote to the path's first
    // word and `echo` took the rest as an argument, and the log was never
    // created — which the assertion below reads as "gh was never invoked".
    // ci-state.test.mjs's GH_STUB form keeps the path out of the script text.
    // The prefix above now holds a space so this shape is exercised on every
    // machine, not only one whose TMPDIR has one.
    writeExecStub(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n`);
    writeExecStub(join(bin, "cksum"), stub);
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

// --- The Recipe (ADR 0015): both commands are READ from the cache through
// derive-testcmd.sh, never inferred from the tree.

test("the Install step and the Test entrypoint come from the Recipe cache, verbatim", () => {
  const { install, testcmd, err } = claim(repo({ [TESTS]: "" }, {}, { install: "exit 0", test: "sh ./run-tests.sh --all" }));
  assert.equal(err, undefined);
  assert.equal(install, "exit 0");
  assert.equal(testcmd, "sh ./run-tests.sh --all");
});

// Absent means "derive", never "infer" — and the refusal must say which step
// derives it, in claim-ticket's own voice so a reader sees whose claim failed.
// Both modes, before anything exists: the dry run is where a controller learns
// it, and --apply must not have labelled the issue first.
test("an absent Recipe cache refuses the claim before anything is claimed, naming the derivation step", () => {
  const dir = repo({ [TESTS]: "" }, {}, null);
  const dry = claim(dir);
  assert.match(dry.err, /claim-ticket: derive-testcmd: no Recipe cache at .*\/\.fleet\/recipe\.json/);
  assert.match(dry.err, /run the Recipe derivation step \(run-team phase 0/);

  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  const ghLog = join(bin, "gh.log");
  writeExecStub(join(bin, "gh"), '#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n');
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "", "no receipt for a claim that was never made");
  assert.equal(existsSync(ghLog), false, "the issue was never labelled");
  assert.equal(existsSync(join(dir, ".worktrees", "42-slug")), false, "and no worktree exists");
});

// The acceptance row: a Test entrypoint naming a binary that does not exist
// is a Recipe that cannot RUN — an invalid cache, refused with the invalidation
// message rather than handed to a runner that would die on every invocation.
test("a Recipe whose Test entrypoint names a missing binary refuses as an invalid cache", () => {
  const { err } = claim(repo({ [TESTS]: "" }, {}, { test: "no-such-runner-2117 --all" }));
  assert.match(err, /^claim-ticket: derive-testcmd: the Recipe cache at .* is invalid: its test command 'no-such-runner-2117' is not found or not executable/m);
  assert.match(err, /run the Recipe derivation step/);
});

// The worktree is built from origin/main, and the cache read no longer reads
// any ref — so the precondition is asked directly, in the dry run too, where
// nothing downstream would otherwise refuse before `worktree add`.
test("a repo with no origin/main refuses before anything is claimed", () => {
  const dir = repo({ [TESTS]: "" });
  execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: dir, env: FIXTURE_ENV });
  const { err } = claim(dir);
  assert.match(err, /claim-ticket: origin\/main does not resolve to a commit/);
});

// Installs a claim with the given Recipe and returns the spawn result — the
// Install step only runs under --apply.
function applyRecipe(recipe, files = { [TESTS]: "" }, local = {}) {
  const dir = repo(files, local, recipe);
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { dir, r };
}

// The acceptance row for the Install step: modifying ANY tracked file — not a
// lockfile by name, fleet-ctl keeps no list of those — is a Recipe that no
// longer holds, refused with the invalidation message and the file named.
test("an Install step that modifies a tracked file refuses as an invalid cache", () => {
  const { r } = applyRecipe({ install: "echo drift >> run-tests.sh" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the Install step 'echo drift >> run-tests\.sh' changed the tree in \.worktrees\/42-slug \(first: +M run-tests\.sh\) — the Recipe cache is invalid; run the Recipe derivation step/);
  assert.doesNotMatch(r.stdout, /"applied":true/);
});

// The must-ACCEPT half of the whole-tree guard, which is where it can go
// wrong: an install writing only what the repository IGNORES (a dependency
// directory, a build output) leaves `git status --porcelain` empty — the proof
// the deriving agent ran — and must claim.
test("an Install step that writes only ignored files claims cleanly", () => {
  const { r } = applyRecipe({ install: "mkdir -p deps && touch deps/x" }, { ".gitignore": "deps/\n", [TESTS]: "" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /tree clean after the Install step/);
  assert.match(r.stdout, /"applied":true/);
});

// Failure to RUN versus failure: 127 is the shell's own "not found" — an
// invalid Recipe — while any other non-zero is the install failing, named as
// that. The unrunnable one gets past derive-testcmd.sh's probe the realistic
// way: the script exists (executable) in the main checkout the probe reads
// from, but not at origin/main, which the worktree is built from.
test("an Install step that cannot run is named an invalid cache; one that fails is named failing", () => {
  const dir = repo({ [TESTS]: "" }, { "setup.sh": "#!/bin/sh\n" }, { install: "./setup.sh" });
  chmodSync(join(dir, "setup.sh"), 0o755);
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the Install step '\.\/setup\.sh' did not run in \.worktrees\/42-slug \(exit 127: not executable or not found\) — the Recipe cache is invalid/);

  const failing = applyRecipe({ install: "exit 4" });
  assert.equal(failing.r.status, 2);
  assert.match(failing.r.stderr, /install failed in \.worktrees\/42-slug \(exit 4\)/);
  assert.doesNotMatch(failing.r.stderr, /Recipe cache is invalid/, "a failing install is not a stale Recipe");
});

// The 126 half of the same classification: a script that IS at the resolved
// path but lacks the execute bit is "found but not executable" — the shell's
// own exit 126, distinct from 127's "not found" but pinned to the identical
// invalid-cache wording since both mean the Recipe cannot run, not that it
// failed. Committed non-executable (default `writeFileSync` mode, never
// chmod'd before `git add`), so `origin/main`'s tree entry is 100644 and a
// fresh worktree checks it out that way — but chmod'd +x on disk in the MAIN
// checkout only, AFTER the commit, so derive-testcmd.sh's own resolvability
// probe (which reads "." — the main checkout — directly, not through git)
// still passes and this script gets to run it for real, the same asymmetry
// the 127 case above exploits in the other direction.
test("an Install step present but not executable is also named an invalid cache (exit 126)", () => {
  const dir = repo({ [TESTS]: "", "setup.sh": "#!/bin/sh\n" }, {}, { install: "./setup.sh" });
  chmodSync(join(dir, "setup.sh"), 0o755);
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the Install step '\.\/setup\.sh' did not run in \.worktrees\/42-slug \(exit 126: not executable or not found\) — the Recipe cache is invalid/);
});

// #128: the tree-mutation check reads the same worktree-status hole
// no-undo-audit.sh, reap.sh and worktree-audit.sh share. Delete the
// worktree's own .git between `worktree add` and this check and `git -C`
// does not fail — it walks UP to the enclosing repo and answers about THAT
// at rc 0, which the old check would read as an untouched tree it never
// actually looked at. Simulated with an Install step that corrupts the
// worktree's own linkage, whatever a real cause for that would be — this
// guard does not get to assume a cause, only detect the hole.
// The other half of the same guard: `-f` is false for a `.git` that is absent
// AND for one this process may not stat, so an install that leaves $wt
// unsearchable was reported as a deletion — sending whoever cleans up (a
// created worktree, a created branch and an in-progress label are left behind)
// after a `.git` file that is sitting right there. Both refusals exit 2; only
// the stated cause differs, which is exactly what triage reads.
test("an unsearchable worktree refuses with git's own denial, never an absence nothing established", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches every directory");
  // Runs with cwd=$wt, so this strips the search bit off the worktree itself
  // and leaves .git entirely intact — the discriminating input.
  const { dir, r } = applyRecipe({ install: "chmod 000 ." });
  // Before the first assert: a red must not strand a directory nothing can
  // remove.
  chmodSync(join(dir, ".worktrees", "42-slug"), 0o755);

  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /has no \.git file/, "the .git file was never deleted, only made unreachable");
  assert.match(r.stderr, /could not verify the tree state/);
  assert.match(r.stderr, /Permission denied/, "git's own denial, not one this script invented");
  assert.equal(existsSync(join(dir, ".worktrees", "42-slug", ".git")), true);
});

// #730 (see reap.sh's branch sweep for the full explanation) — the untracked
// mode is CONFIG, so an install that CREATES a file the tree neither tracks
// nor ignores is invisible at rc 0 unpinned.
test("an install that creates an UNTRACKED file is caught under status.showUntrackedFiles=no (#730)", () => {
  const dir = repo({ [TESTS]: "" }, {}, { install: "printf '{}' > yarn.lock" });
  // On the repo's own config, so the linked worktree the check runs in shares it.
  execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: dir, stdio: "pipe" });
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, r.stdout + r.stderr);
  // The stated cause, not merely a refusal: several guards in this chain exit 2,
  // and triage reads the reason.
  assert.match(r.stderr, /changed the tree in \.worktrees\/42-slug \(first: \?\? yarn\.lock\)/);
});

test("a worktree whose .git vanishes during install refuses instead of trusting a leaked parent status", () => {
  const { r } = applyRecipe({ install: "rm -rf .git" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has no \.git file — cannot verify the Install step left the tree clean/);
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
  const dir = repo({ [TESTS]: "" });
  mkdirSync(join(dir, ".worktrees"), { recursive: true });
  symlinkSync("/nonexistent-target", join(dir, ".worktrees", "42-slug"));

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 2, "a path occupied by a dangling link is a refusal, not a claimable path");
  assert.match(r.stderr, /\.worktrees\/42-slug already exists — ticket may already be claimed/,
    "this script's own diagnosis, not git's bare `fatal: … already exists` from inside the next mutation");
  assert.equal(r.stdout, "", "and no receipt: nothing here is claimable, so there is nothing to predict");

  // The `-e` half of the same line — a REAL directory at $wt, no symlink.
  const occupied = repo({ [TESTS]: "" });
  mkdirSync(join(occupied, ".worktrees", "42-slug"), { recursive: true });
  const d = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: occupied, encoding: "utf8" });
  assert.equal(d.status, 2, "an occupied directory is a refusal too, in the mode with no downstream net");
  assert.match(d.stderr, /\.worktrees\/42-slug already exists — ticket may already be claimed/);
  assert.equal(d.stdout, "", "and no receipt: an unguarded real directory is exit 0 and a claim prediction");

  // The input the guard must ACCEPT — same script, same mode, nothing at $wt.
  const free = repo({ [TESTS]: "" });
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
  const dir = repo({ [TESTS]: "" });
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
  const dir = repo({ [TESTS]: "" });
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
  assert.match(bin, / /, "fixture: the stub's directory must hold a space, or this pins nothing");
  const marker = join(bin, "gh-ran");
  writeExecStub(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n`);
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
  const dir = repo({ [TESTS]: "" });
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
  const dir = repo({ [TESTS]: "" });

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
  const dir = repo({ [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "sl\\ug", "fix"], { cwd: dir, encoding: "utf8" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).worktree, ".worktrees/42-sl\\ug");
});

test("an ordinary slug is byte-identical — the escaping accepts what it should", () => {
  // The false-positive half: nothing here has anything to escape, so the
  // payload must be exactly what this script has always emitted.
  const dir = repo({ [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix"], { cwd: dir, encoding: "utf8" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    r.stdout,
    '{"issue":42,"branch":"fix/42-slug","worktree":".worktrees/42-slug","install":"true","ports":{"postgres":16042,"ollama":22042},"runner":".worktrees/42-slug/agent-test","applied":false}\n',
  );
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run. This script's
// contract is exit 2 for every refusal and 0 otherwise — there is no exit 1 —
// and the guard sits ahead of every mutation, so a missing library refuses
// before a worktree, a label or a runner exists.
test("a missing json.sh is exit 2, before anything is created", () => {
  const dir = repo({ [TESTS]: "" });
  const lone = mkdtempSync(join(tmpdir(), "claim-nolib-"));
  copyFileSync(SCRIPT, join(lone, "claim-ticket.sh"));
  const bin = mkdtempSync(join(tmpdir(), "claim-nolib-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");

  const r = spawnSync("sh", [join(lone, "claim-ticket.sh"), "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, "a missing library is a refusal — this script's only failure code");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the Recipe read");
  assert.equal(r.stdout, "", "no payload: this refusal fires before the claim exists, so there is nothing to report");
  assert.equal(existsSync(join(dir, ".worktrees", "42-slug")), false,
    "and no worktree — the guard fires ahead of every mutation, so this is a clean refusal and not a half-claim");
});

// The twin of the json.sh test above, for worktree.sh's own `[ -r ]` guard
// (#727's fourth caller of `gone()`) — json.sh present, worktree.sh absent.
test("a missing worktree.sh is exit 2, before anything is created", () => {
  const dir = repo({ [TESTS]: "" });
  const lone = mkdtempSync(join(tmpdir(), "claim-nowt-"));
  copyFileSync(SCRIPT, join(lone, "claim-ticket.sh"));
  copyFileSync(join(dirname(SCRIPT), "json.sh"), join(lone, "json.sh"));
  const bin = mkdtempSync(join(tmpdir(), "claim-nowt-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");

  const r = spawnSync("sh", [join(lone, "claim-ticket.sh"), "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.status, 2, "a missing library is a refusal — this script's only failure code");
  assert.match(r.stderr, /worktree\.sh/, "and it names the file rather than blaming the Recipe read");
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
// therefore pins this guard on a developer's Mac and lets the mutant through
// on the runner that gates the merge, and a wording assertion pins nothing in
// either shell. `issue_wt` is what discriminates instead — both shells name it,
// and it reaches stderr only from that nounset abort.
//
// The shim is selected on CONTENT rather than argv. Only the slug reaches
// `jstr` here, `$install` is the fixture Recipe's `true`, and a `sed` that
// failed unconditionally could not say which stage it broke.

const REAL_SED = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();

/** A dir holding a `sed` shim with the given body, prepended to PATH. */
function sedShim(body) {
  const bin = mkdtempSync(join(tmpdir(), "claim-sed-shim-"));
  writeExecStub(join(bin, "sed"), `#!/bin/sh\n${body}\n`);
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
  const dir = repo({ [TESTS]: "" });

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
  const dir = repo({ [TESTS]: "" });

  const r = spawnSync("sh", [SCRIPT, "42", "esc-boom", "fix"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: sedShim(`exec ${REAL_SED} "$@"`) },
  });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    r.stdout,
    '{"issue":42,"branch":"fix/42-esc-boom","worktree":".worktrees/42-esc-boom","install":"true","ports":{"postgres":16042,"ollama":22042},"runner":".worktrees/42-esc-boom/agent-test","applied":false}\n',
    "byte-identical to the receipt this script emits with no shim in the way",
  );
});

// #1141, delegated: this script reads no JSON itself — derive-testcmd.sh does,
// and it is where the interpreter first has to resolve. Its refusal travels
// back through the `2>&1` capture, and what arrives must still name the
// interpreter rather than the Recipe cache.
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
// added for #613 is a new call site of its own) and the Test entrypoint's
// quoting, `cksum` is the runner's hash, and `mktemp`, `cat` and `rm` are
// derive-testcmd.sh's stderr capture.
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

test("an unresolvable interpreter in the delegated Recipe read carries that cause through", () => {
  const r = onShimmedPath(repo({ [TESTS]: "" }), shimPath({ node: false }));
  assert.equal(r.status, 2, `the wrapping refusal keeps this script's only failure code\n${r.stderr}`);
  assert.match(r.stderr, /claim-ticket: derive-testcmd: node is unusable/, "the delegate's own voice, naming the interpreter");
  assert.doesNotMatch(r.stderr, /Recipe cache at .* is unusable/, "an interpreter that never ran establishes nothing about the cache");
});

// The false-positive control for the shim dir itself: the refusal above rests
// on a stripped PATH, and a PATH too thin for the script to work at all would
// produce it for a reason that is not the interpreter. This drives a claim to
// completion under exactly that PATH.
test("a resolvable interpreter on the shimmed PATH still reads both Recipe commands", () => {
  const r = onShimmedPath(repo({ [TESTS]: "" }), shimPath({ node: true }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /Install step → true/);
  assert.match(out, /test entrypoint → true/);
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
  assert.match(bin, / /, "fixture: the stub's directory must hold a space, or this pins nothing");
  const marker = join(bin, "ran");
  writeExecStub(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_LOG"\nexit 0\n`);
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
// the tree-mutation check after the install has already run — so one
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

test("an ambient GIT_WORK_TREE does not make a mutated tree look clean (#1020)", () => {
  // GIT_WORK_TREE outranks `-C`, so `git -C "$wt" status --porcelain -uall`
  // reads the ambient tree against $wt's index. Pointed at the repo root —
  // where the tracked file is untouched, and the Recipe cache and the
  // worktrees are ignored — it answers EMPTY at rc 0 while the fresh
  // worktree's copy has been rewritten.
  //
  // The install really does mutate: this guard runs immediately after the
  // install and there is no seam between them to write a file into. The
  // mutating Install step IS the hazard the guard exists for — npm@11 pruning
  // cross-platform optional deps out of a lockfile is the header's own example.
  const files = { [TESTS]: "", ".gitignore": ".fleet/\n.worktrees/\n" };
  const recipe = { install: "echo MUTATED >> run-tests.sh" };
  const bin = mkdtempSync(join(tmpdir(), "claim-bin-"));
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  const env = (extra) => ({ ...FIXTURE_ENV, PATH: `${bin}:${process.env.PATH}`, ...extra });

  // The control, and it is not optional: it proves the install really mutates
  // and the guard really fires on it. Without it an install that silently did
  // nothing would leave the poisoned run exiting 0 for an innocent reason, and
  // the assertion below would be measuring the absence of a hazard rather than
  // its containment.
  const control = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: repo(files, {}, recipe), encoding: "utf8", env: env(),
  });
  assert.equal(control.status, 2, `fixture: the unpoisoned run must refuse\n${control.stdout}${control.stderr}`);
  assert.match(control.stderr, /changed the tree/);

  const dir = repo(files, {}, recipe);
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], {
    cwd: dir, encoding: "utf8", env: env({ GIT_WORK_TREE: dir }),
  });

  assert.equal(r.status, 2,
    `an ambient GIT_WORK_TREE must not make the tree guard answer about the repo root; got\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /changed the tree in \.worktrees\/42-slug \(first: +M run-tests\.sh\)/,
    "and for the real reason — this guard is the only thing between a wrong Install step and a worktree corrupted for everyone");
  assert.doesNotMatch(r.stdout, /"applied":true/, "a claim must not be handed out over an unverified tree");
});
