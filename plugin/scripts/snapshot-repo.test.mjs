// #1056. The review snapshot was cut with `git archive HEAD | tar -x` and
// nothing more, so it was not a git repository — and this repo's suite has
// whole files that ask git what ships rather than walking the directory, which
// need a `.git` at or above them. Measured at `ffa9026`, one commit three ways,
// `env -u FORCE_COLOR node --test` from each tree's root:
//
//   a worktree                           tests 2401  pass 2401  fail 0  skipped 0
//   a bare `git archive` extraction      tests 2401  pass 2382  fail 0  skipped 19
//   an extraction this block initialized  tests 2401  pass 2401  fail 0  skipped 0
//
// The middle row is what every dimension used to report: the same `tests`
// total, `fail 0`, and 19 checks that never ran — invisible, because a total
// that matches reads as a suite that ran. Before those files learned to decline
// (#1149) the same cause hard-FAILED them instead, and two dimensions in one
// run filed nothing at all over a red they could not attribute.
//
// EXECUTED, not text-pinned, and that distinction is the whole point of this
// file: `review-pr-snapshot-path.test.mjs` pins the block's lines and their
// ORDER as text, which stays green on a sequence that is spelled right and does
// not work — a `git add` that skips a tracked-but-ignored file, an init that a
// stale `GIT_DIR` sends elsewhere, a commit an unconfigured identity refuses.
// Each of those is a real environment an unattended snapshot agent runs in, and
// none of them is visible in the source text. So every test below RUNS the
// block's own lines, lifted from each harness's copy, against a fixture
// repository it builds itself.
//
// Fixtures only: every test here builds its own repository under `$TMPDIR`, so
// none of them needs an ambient working tree and none declines in an extraction
// (the condition this ticket is about). The one thing they need is `git`.
//
// Zero deps: `node --test plugin/scripts/snapshot-repo.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { environmentNote } from "./review-core.js";
import { between, phrase } from "./prose-pin.mjs";
import { stripComments } from "./strip-comments.mjs";

const REPO = join(import.meta.dirname, "..");
const SOURCES = [
  ["workflows/review-pr.js", join(REPO, "workflows", "review-pr.js")],
  ["scripts/review-core.js", join(REPO, "scripts", "review-core.js")],
];

// Every git identity is scrubbed — both config files and all four `GIT_*` name
// and email variables — so the commit the block takes can only be the one the
// block's own `-c user.name`/`-c user.email` supply. That does NOT make the
// commit impossible without them: measured here, git auto-detects an identity
// from the OS and committed as `Christian Ziegler <chris@Mac.fritz.box>` with
// both config files pointed at /dev/null
// (`env -u GIT_AUTHOR_NAME … GIT_CONFIG_GLOBAL=/dev/null git commit`). So the
// flags are pinned by the AUTHOR assertion below rather than by a refusal:
// unflagged, a review stamps whoever's machine ran it onto a commit nobody
// wrote, and on a host whose name gives git no address it can form the commit
// fails outright instead.
//
// `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are cleared for a different
// reason: inherited, `git init` exits 0 and creates nothing in the target, so a
// fixture built under an ambient GIT_DIR would be no repository at all while
// every status check passed (repo-root.test.mjs's own measurement).
// `GIT_TEMPLATE_DIR` joins them (#1056): an ambient template directory with no
// `info/` subdirectory makes `git init` produce no `.git/info`, so the block's
// `.git/info/exclude` append silently fails and every fixture below would be
// measuring the ambient host's template instead of the hazard this file
// exists to catch.
const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: ENV, encoding: "utf8" }).trim();

function scratch(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A repository standing in for the worktree under review. Deliberately carries
 * the three shapes that separate a faithful snapshot from a plausible one: a
 * nested path, an executable bit, and a file this repo's own `.gitignore`
 * covers while git tracks it anyway — legal, present in `git archive`'s output,
 * and skipped by a plain `git add`.
 *
 * `exportIgnore` marks one tracked file `export-ignore`, which is the one way a
 * `git archive` legitimately does NOT carry the whole tree. That fixture is the
 * honest-refusal case, not a bug to fix: the snapshot really is not the
 * reviewed tree, and the block has to say so rather than report a match.
 */
function reviewedRepo(t, { exportIgnore = false } = {}) {
  const dir = scratch(t, "snapshot-repo-src-");
  git(dir, "init", "-q");
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "nested", "run.sh"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
  writeFileSync(join(dir, "plain.txt"), "content\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "tracked anyway\n");
  if (exportIgnore) writeFileSync(join(dir, ".gitattributes"), "plain.txt export-ignore\n");
  git(dir, "add", "-A", "-f");
  git(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-q", "-m", "fixture");
  return dir;
}

/**
 * The lines under test, lifted from one harness's snapshot prompt and rendered
 * with the same `${worktree}` interpolation the script performs: the archive,
 * the emptiness probe, the init/commit, the tree compare, the exclude and the
 * symlink. `$SNAP` and `$SHA` are the shell's, supplied by `cut` below — the
 * lines that mint them are pinned by `review-pr-snapshot-path.test.mjs`'s own
 * executed mint test, and repeating that here would test its subject twice
 * while testing this one no better.
 */
function cutLines(path) {
  const code = stripComments(readFileSync(path, "utf8"));
  const from = code.search(/^ *git -C \$\{worktree\} archive HEAD/m);
  const to = code.search(/^ *if \[ -n "\$SNAP" \] && \[ -d \$\{worktree\}\/node_modules \]/m);
  assert.ok(
    from !== -1 && to > from,
    `${path} no longer runs from a \`git archive\` down to the node_modules symlink — the block was reshaped past what this test lifts; update it or restore the block`,
  );
  return code.slice(from, code.indexOf("\n", to));
}

/** `cutLines`, rendered for one worktree. */
const render = (path, worktree) => new Function("worktree", "return `" + cutLines(path) + "`")(worktree);

/**
 * `cutLines`'s slice, prefixed with the block's own ambient-var clearing
 * line — pulled from the source by its literal text rather than assumed, so
 * a rewrap or a dropped var still fails this the same way
 * review-pr-snapshot-path.test.mjs's own sequence pin would. Neither
 * `cutLines` nor `render` widen to include it: in the real script the
 * clearing line sits ABOVE `${scratch}`/`${runRootParent}`, and pulling it
 * into `render`'s narrow, worktree-only `new Function` would need those too.
 */
function withUnset(path) {
  const code = stripComments(readFileSync(path, "utf8"));
  const m = code.match(/^ *unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_TEMPLATE_DIR *$/m);
  assert.ok(m, `${path} no longer clears the ambient git vars before the snapshot block — the hoist this test depends on is gone (#1056)`);
  return `${m[0]}\n${cutLines(path)}`;
}

/** `withUnset`, rendered for one worktree. */
const renderWithUnset = (path, worktree) => new Function("worktree", "return `" + withUnset(path) + "`")(worktree);

/**
 * Runs a rendered block and returns what it printed plus where it wrote. The
 * status is returned rather than asserted: two tests below are about a block
 * whose `git archive` FAILS, and that is a scenario, not a test failure.
 */
function cut(t, script, { snapName = "snapshot-deadbee", env = ENV } = {}) {
  const runRoot = scratch(t, "snapshot-repo-run-");
  const snap = join(runRoot, snapName);
  const r = spawnSync(
    "sh",
    ["-c", ["SHA=deadbee", `SNAP=${JSON.stringify(snap)}`, 'mkdir -p "$SNAP"', script].join("\n")],
    { env, encoding: "utf8" },
  );
  return { snap, out: r.stdout ?? "", err: r.stderr ?? "", status: r.status };
}

for (const [name, path] of SOURCES) {
  // The accept case, and the property the whole ticket turns on: the snapshot
  // is a repository, and it is a repository holding the REVIEWED tree. The tree
  // hash is what settles the second half — two commits whose trees hash the
  // same hold byte-identical content, every file, which is strictly more than
  // the "confirm a couple of the diff's files" spot check this replaced.
  test(`${name}: the block leaves a repository whose commit holds the reviewed tree`, (t) => {
    const worktree = reviewedRepo(t);
    const { snap, out, status } = cut(t, render(path, worktree));

    assert.match(out, /SNAPSHOT_NONEMPTY/, `the extraction came back empty: ${out}`);
    assert.doesNotMatch(out, /SNAPSHOT_INIT_FAILED/, `the init or the commit failed: ${out}`);
    assert.match(out, /SNAPSHOT_TREE_MATCH/, `the block did not settle that the snapshot is the reviewed tree: ${out}`);
    assert.equal(status, 0, "the block exited non-zero — a snapshot agent reads that as a failed cut");

    assert.ok(existsSync(join(snap, ".git")), "there is no `.git` in the snapshot — every suite that asks git what ships declines or fails there");
    assert.equal(
      git(snap, "rev-parse", "HEAD^{tree}"),
      git(worktree, "rev-parse", "HEAD^{tree}"),
      "the snapshot's commit does not hold the reviewed tree",
    );
    // The identity flags, pinned where they have an observable effect. The
    // snapshot commit is a mechanism, not a contribution, and nothing about it
    // is the operator's: unflagged, git auto-detects a name and address off the
    // machine (measured in the header) and every review in the fleet stamps
    // whoever ran it onto a commit nobody wrote.
    assert.equal(
      git(snap, "log", "-1", "--format=%an <%ae>"),
      "fleet <fleet@invalid>",
      "the snapshot commit is not attributed to the block's own synthetic identity",
    );
    // The `-f` on `git add`, measured rather than read off the flag: this file
    // is tracked at HEAD, so `git archive` carries it, and the extraction's own
    // `.gitignore` is what would make a plain `git add -A` skip it. Dropping
    // `-f` also breaks the tree compare above — but this assertion names the
    // cause, and the hash comparison cannot.
    assert.equal(
      git(snap, "ls-files", "--error-unmatch", "ignored.txt"),
      "ignored.txt",
      "a tracked file the repo's own .gitignore covers did not make it into the snapshot's index",
    );
    // The exec bit is part of the tree object, so a mode the extraction lost
    // would already have reddened the hash. Asserted anyway because it is the
    // one property a reader checks by hand when a suite behaves differently in
    // the snapshot, and a named assertion beats re-deriving it from a hash.
    assert.match(git(snap, "ls-files", "-s", "nested/run.sh"), /^100755 /, "the executable bit did not survive into the snapshot");
  });

  // The negative control for the test above. Without it, "there is a repository
  // at the snapshot" is satisfiable by an ambient repository ABOVE the snapshot
  // — `$TMPDIR` inside a checkout, a stray `.git` in a temp root — and the pin
  // would pass with the init deleted.
  test(`${name}: without the block's init the same extraction is not a repository`, (t) => {
    const worktree = reviewedRepo(t);
    const lines = render(path, worktree).split("\n");
    const extractOnly = lines.filter((l) => /archive HEAD/.test(l) || /ls -A/.test(l));
    assert.equal(extractOnly.length, 2, "the archive and the probe are no longer one line each — update this control");
    const { snap, out } = cut(t, extractOnly.join("\n"));

    assert.match(out, /SNAPSHOT_NONEMPTY/, "the control's own extraction failed, so it controls nothing");
    assert.ok(!existsSync(join(snap, ".git")), "the control extraction has a `.git` — it is not the pre-fix shape and proves nothing");
    const probe = spawnSync("git", ["-C", snap, "rev-parse", "--show-toplevel"], {
      env: { ...ENV, GIT_CEILING_DIRECTORIES: dirname(snap) },
      encoding: "utf8",
    });
    assert.notEqual(probe.status, 0, "git answered for a bare extraction — the ceiling is wrong, or this environment nests the snapshot inside a repository");
    assert.match(
      probe.stderr,
      /not a git repository/,
      "the bare extraction failed for some reason OTHER than having no repository, so it is not the condition #1056 describes",
    );
  });

  // The ordering, executed. `review-pr-snapshot-path.test.mjs` pins that the
  // probe sits above the init as TEXT; this is why that order is load-bearing.
  // A `git archive` that produced nothing — no auth, a dead HEAD — leaves the
  // directory `mkdir -p` made, and `.git` is enough to make it look populated,
  // in every repo rather than only the ones with node_modules.
  test(`${name}: the emptiness probe still sees an empty extraction, and would not above the init`, (t) => {
    const notARepo = scratch(t, "snapshot-repo-norepo-");
    const lines = render(path, notARepo).split("\n");
    const probeAt = lines.findIndex((l) => /ls -A/.test(l));
    const initAt = lines.findIndex((l) => /git init -q/.test(l));
    assert.ok(probeAt !== -1 && initAt > probeAt, "the block no longer probes above its init — the text pin in review-pr-snapshot-path.test.mjs is the one to read first");

    const real = cut(t, lines.join("\n"));
    assert.match(
      real.out,
      /SNAPSHOT_EMPTY/,
      `a failed archive must report SNAPSHOT_EMPTY so the caller refuses the tree (#140): ${real.out}`,
    );
    assert.doesNotMatch(real.out, /SNAPSHOT_NONEMPTY/, "the probe called a failed extraction non-empty");
    assert.match(real.out, /SNAPSHOT_TREE_MISMATCH/, "a failed archive is also not the reviewed tree, and the block must say so");

    const moved = [...lines];
    moved.splice(initAt, 1);
    moved.splice(probeAt, 0, lines[initAt]);
    const swapped = cut(t, moved.join("\n"));
    assert.match(
      swapped.out,
      /SNAPSHOT_NONEMPTY/,
      "moving the init above the probe no longer fools the probe — if that is genuinely true the order is free, but it was measured false and the pin above rests on it",
    );
  });

  // What this change can wrongly REFUSE, and the answer it must give when it
  // does: `export-ignore` keeps a tracked file out of `git archive`, so the
  // snapshot genuinely is not the reviewed tree. The block reports that rather
  // than a match — and the review still RUNS, because refusing would trade a
  // wrong test count for no coverage at all, which is this defect's own
  // expensive half (two dimensions in one run filed nothing over a suite they
  // could not attribute).
  test(`${name}: a snapshot the archive could not fill reports the mismatch and does not cancel the review`, (t) => {
    const worktree = reviewedRepo(t, { exportIgnore: true });
    const { snap, out } = cut(t, render(path, worktree));

    assert.ok(!existsSync(join(snap, "plain.txt")), "the export-ignore fixture did not actually drop a file, so it exercises nothing");
    assert.match(out, /SNAPSHOT_TREE_MISMATCH/, `an archive missing a tracked file must not report a match: ${out}`);
    assert.doesNotMatch(out, /SNAPSHOT_TREE_MATCH/, "the block reported both outcomes");
    assert.match(out, /SNAPSHOT_TREE_MISMATCH=snapshot [0-9a-f]{40} vs commit [0-9a-f]{40}/, "the mismatch names neither hash — a reader cannot tell which tree was measured");
  });

  // Both prompts that order a suite run, and the payload. A fact reported to
  // the caller and never told to the agent measuring in that environment is
  // half a fix: the specialist is the one deciding whether a red is a finding.
  test(`${name}: both suite-running prompts and the payload carry what the run is evidence about`, () => {
    const code = stripComments(readFileSync(path, "utf8"));
    const specialist = between(code, "READ ONLY FROM THE SNAPSHOT", "Report only what you RAN", "the specialist prompt");
    const refuter = between(code, "Try to REFUTE this finding", "{ label: `verify:", "the refuter prompt");
    assert.match(specialist, /\$\{environmentNote\(snap\)\}/, "the specialist prompt no longer says what its own suite run is evidence about — a dimension then reads a skip or a red as a fact about the tree");
    assert.match(refuter, /\$\{environmentNote\(snap\)\}/, "the refuter prompt no longer carries it — a refuter that runs the suite to check a finding draws the same wrong conclusion");
    assert.match(code, /testEnvironment: environmentNote\(snap\)/, "the returned payload no longer carries the measurement environment — the controller is back to reading a count with nothing saying where it was taken");
  });

  // #1056 Finding 3: `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE` used to sit
  // INSIDE the init's own subshell, so the SHA capture, the archive and the
  // tree-hash compare — all of them OUTSIDE that subshell — ran with an
  // ambient GIT_DIR still outranking every `-C`. Measured: pointed at an
  // unrelated repository, the old block archived and compared THAT repo
  // instead of the worktree, and reported SNAPSHOT_TREE_MATCH for it. The
  // fix hoists the clearing to the top of the whole block.
  test(`${name}: an ambient GIT_DIR naming an unrelated repository does not retarget the snapshot`, (t) => {
    const worktree = reviewedRepo(t);
    const stranger = scratch(t, "snapshot-repo-stranger-");
    git(stranger, "init", "-q");
    writeFileSync(join(stranger, "stranger.txt"), "stranger\n");
    git(stranger, "add", "-A");
    git(stranger, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-q", "-m", "stranger");

    const { snap, out } = cut(t, renderWithUnset(path, worktree), { env: { ...ENV, GIT_DIR: join(stranger, ".git") } });

    assert.ok(!existsSync(join(snap, "stranger.txt")), `an ambient GIT_DIR retargeted the archive at the unrelated repository: ${out}`);
    assert.ok(existsSync(join(snap, "plain.txt")), `the archive did not pull from the worktree under review: ${out}`);
    assert.match(out, /SNAPSHOT_TREE_MATCH\b/, `an ambient GIT_DIR pointed at an unrelated repository must not stop the block from settling the real tree: ${out}`);
  });

  // #1056 Finding 4: an ambient GIT_TEMPLATE_DIR with no `info/` subdirectory
  // makes `git init` skip populating `.git/info`, so the block's own
  // `.git/info/exclude` append has nowhere to land and node_modules goes back
  // to being untracked but NOT excluded — the exact dirty-status regression
  // the symlink tests above guard against, reachable through the host's
  // environment instead of through the diff.
  test(`${name}: an ambient GIT_TEMPLATE_DIR with no info/ still leaves the snapshot clean`, (t) => {
    const worktree = reviewedRepo(t);
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    const emptyTemplate = scratch(t, "snapshot-repo-template-");
    const { snap, out } = cut(t, renderWithUnset(path, worktree), { env: { ...ENV, GIT_TEMPLATE_DIR: emptyTemplate } });

    assert.match(out, /SNAPSHOT_TREE_MATCH/, `an ambient GIT_TEMPLATE_DIR must not stop the init from settling the tree: ${out}`);
    assert.ok(
      existsSync(join(snap, ".git", "info", "exclude")),
      "an ambient GIT_TEMPLATE_DIR without info/ leaves the exclude file missing — node_modules is untracked but not excluded",
    );
    assert.equal(
      git(snap, "status", "--porcelain", "--untracked-files=all"),
      "",
      "an ambient GIT_TEMPLATE_DIR left the snapshot reading dirty",
    );
  });
}

// One block, two harnesses. The fix that matters is the same four lines in both
// copies, and a fix applied to one is exactly the shape this repo's own
// "recurring pin defect" comment describes — with the omp path (review-core.js)
// the one every review in this session actually runs, so a Claude-only fix
// would leave the live path broken while every pin over review-pr.js passed.
test("both harnesses cut the snapshot with byte-identical shell", () => {
  const [claude, omp] = SOURCES.map(([, path]) => withUnset(path));
  assert.equal(omp, claude, "the two copies of the snapshot block have diverged — a fix landed on one harness only");
});

// `environmentNote`'s two regimes, read as a consumer reads them. The parity
// test pins that both copies agree; this pins what they agree ON, which no
// comparison of two identical answers can.
test("environmentNote says a verified snapshot measures the tree, and an unverified one does not", () => {
  const verified = environmentNote({ repoVerified: true });
  assert.doesNotMatch(verified, /UNVERIFIED/, "a verified environment is reported as unverified — every run now reads as degraded, and a reader who sees that on healthy runs stops reading it");
  // `phrase()`, not a literal: this prose is hard-wrapped at ~78 columns, so
  // every inter-word gap in it may be a newline, and a pin that reds on a
  // rewrap is one the next reader edits around.
  assert.match(verified, phrase("what a checkout at that commit does"), "the verified branch no longer says the suite measures what a checkout does, which is the whole claim the tree-hash compare buys");

  const failed = environmentNote({ repoVerified: false, repoError: "SNAPSHOT_INIT_FAILED" });
  assert.match(failed, /UNVERIFIED/, "a degraded environment is not announced");
  assert.match(failed, /SNAPSHOT_INIT_FAILED/, "the reason is dropped — the payload says the environment differs without saying why, which is what a reader needs to tell an artifact from a regression");
  assert.match(failed, phrase("NOT a validation of the tree"), "the consequence is dropped — a reader is left to infer that the counts mean less than they look like");

  // Absent, not false: an agent that omitted the field must not read as a
  // verified environment. The schema's `required` is what should prevent it;
  // this is the same belt-and-braces `snapshotMissing` applies to
  // `pathVerified`, at the layer that has to be right if that one is bypassed.
  assert.match(environmentNote({}), /UNVERIFIED/, "an omitted repoVerified reads as a verified environment");
  assert.match(environmentNote(null), /UNVERIFIED/, "a dead snapshot agent reads as a verified environment");
  // A string is not a boolean: `=== true` is deliberate, since a schema bypass
  // or a hand-built fixture can carry the word rather than the value.
  assert.match(environmentNote({ repoVerified: "true" }), /UNVERIFIED/, "a non-boolean truthy value reads as a verified environment");

  // #1056 Finding 5: SNAPSHOT_TREE_MISMATCH means the init SUCCEEDED — the
  // snapshot IS a git repository, just not one holding the reviewed tree —
  // which is a different cause than SNAPSHOT_INIT_FAILED (no repository at
  // all). Repo-gated tests behave differently under it: they actually RUN
  // there, so a failure is a real measurement of a DIFFERENT tree, not the
  // "every test that needs one skips or fails" story the init-failed case
  // tells.
  const mismatched = environmentNote({ repoVerified: false, repoError: "SNAPSHOT_TREE_MISMATCH=snapshot aaa vs commit bbb" });
  assert.match(mismatched, /UNVERIFIED/, "a mismatched tree is not announced as degraded");
  assert.match(mismatched, /SNAPSHOT_TREE_MISMATCH=snapshot aaa vs commit bbb/, "the mismatch reason is dropped — a reader cannot tell which tree was measured");
  assert.match(mismatched, phrase("the snapshot IS a git repository"), "the mismatch case no longer says the init succeeded — it reads as no repository at all, which is the wrong cause");
  assert.doesNotMatch(
    mismatched,
    phrase("NOT a validation of the tree"),
    "the mismatch case still carries the init-failed consequence, which claims repo-gated tests skip or fail there when they actually RUN against the wrong tree",
  );
});

// The snapshot is handed a node_modules symlink AFTER its commit, so it is
// untracked by construction — and an untracked entry makes every `git status`
// in the snapshot read dirty, which is the one signal that would otherwise say
// "this tree is exactly the reviewed commit". Excluded rather than committed:
// in the index it would change the tree hash the verification rests on.
test("a snapshot carrying the node_modules symlink still reads clean", (t) => {
  const worktree = reviewedRepo(t);
  const modules = join(worktree, "node_modules");
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(modules, "marker"), "");
  const { snap, out } = cut(t, render(SOURCES[1][1], worktree));

  assert.match(out, /SNAPSHOT_TREE_MATCH/, `the fixture's own cut failed: ${out}`);
  assert.ok(existsSync(join(snap, "node_modules", "marker")), "the symlink is missing — a derived `npm test --` cannot run in there");
  assert.equal(
    git(snap, "status", "--porcelain", "--untracked-files=all"),
    "",
    "the snapshot reads dirty — the symlink is neither excluded nor committed, so `git status` there no longer says the tree is the reviewed commit",
  );
  // And it is NOT tracked: committed instead of excluded, the tree hash would
  // stop matching the reviewed commit's and every review would report a
  // mismatch it cannot act on.
  assert.equal(
    spawnSync("git", ["-C", snap, "ls-files", "--error-unmatch", "node_modules"], { env: ENV, encoding: "utf8" }).status !== 0,
    true,
    "node_modules is tracked in the snapshot — the tree hash cannot match the reviewed commit's",
  );
});

// The symlink the test above needs is created by the block's last line, whose
// own guard is pinned as text elsewhere. This asserts the fixture actually
// exercised that line rather than passing because nothing made a symlink.
test("the block only symlinks node_modules where the reviewed tree has one", (t) => {
  const worktree = reviewedRepo(t);
  const { snap } = cut(t, render(SOURCES[0][1], worktree));
  assert.ok(!existsSync(join(snap, "node_modules")), "a snapshot of a repo with no node_modules carries one anyway — the guard on the symlink is gone");
  assert.ok(existsSync(join(snap, ".git", "info", "exclude")), "the exclude file is missing, so the clean-status property above rests on nothing");
  assert.match(
    readFileSync(join(snap, ".git", "info", "exclude"), "utf8"),
    /^node_modules$/m,
    "node_modules is no longer excluded in the snapshot's own repository",
  );
});
