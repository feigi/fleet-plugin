// Regression gate for main-gain.mjs: which lines would merging a head remove
// that `main` gained after the PR's work began. Zero deps:
// `node --test tests/main-gain.test.mjs`.
//
// Real git throughout, the way no-undo-audit.test.mjs builds its fixtures: a
// bare origin, a clone, merges spelled the way GitHub spells them, and every
// commit's author and committer dates pinned, so "after the PR began" is a
// fact the fixture states rather than a race against the wall clock. The
// developer's own git config and any ambient GIT_DIR are cut out.
//
// The shared timeline, in seconds since the epoch:
//
//   T0  root on main: tests.txt = old1 old2 old3
//   T1  the PR's first commit, on `feat` (R — its author date)
//   T2  pr7 adds new1 new2 new3 to tests.txt
//   T3  main merges pr7 as "Merge pull request #7 …" — the block lands after R

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/main-gain.mjs", import.meta.url));

const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_DATE: undefined,
  GIT_COMMITTER_DATE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
};

const T0 = 1_700_000_000;
const at = (n) => `@${T0 + n * 1000} +0000`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

// Author and committer both at `n`, the way a fresh commit or merge is dated.
function gitAt(n, cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...ENV, GIT_AUTHOR_DATE: at(n), GIT_COMMITTER_DATE: at(n) }, encoding: "utf8" }).trim();
}

// A rewrite at `n`: the committer date moves, the author date stays the
// commit's own — which is what a rebase or an amend does.
function rewriteAt(n, cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...ENV, GIT_COMMITTER_DATE: at(n) }, encoding: "utf8" }).trim();
}

const write = (w, path, text) => writeFileSync(join(w, path), text);
const OLD = "old1\nold2\nold3\n";
const BLOCK = "new1\nnew2\nnew3\n";

/** Lands `files` on main through a PR branch and a GitHub-subject merge. */
function landPr(w, n, prNumber, files) {
  git(w, "checkout", "-q", "main");
  git(w, "checkout", "-q", "-b", `pr${prNumber}`);
  for (const [path, text] of Object.entries(files)) write(w, path, text);
  git(w, "add", "-A");
  gitAt(n, w, "commit", "-q", "-m", `pr${prNumber} work`);
  git(w, "checkout", "-q", "main");
  gitAt(n + 1, w, "merge", "-q", "--no-ff", `pr${prNumber}`, "-m", `Merge pull request #${prNumber} from o/pr${prNumber}`);
  git(w, "push", "-q", "origin", "main");
}

/** The shared timeline above, left checked out on `feat`; `landAt` moves pr7's work (its merge lands one second later). */
function world(t, landAt = 2) {
  const root = mkdtempSync(join(tmpdir(), "main-gain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  // Cloning the empty origin warns on stderr; a failure still throws.
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "ignore" });
  write(w, "tests.txt", OLD);
  git(w, "add", "tests.txt");
  gitAt(0, w, "commit", "-q", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  git(w, "checkout", "-q", "-b", "feat");
  write(w, "feat.txt", "feature\n");
  git(w, "add", "feat.txt");
  gitAt(1, w, "commit", "-q", "-m", "feat work");
  landPr(w, landAt, 7, { "tests.txt": OLD + BLOCK });
  git(w, "checkout", "-q", "feat");
  return { root, w };
}

/** Commits whatever the worktree holds on `feat`, dated `n`. */
function commitFeat(w, n, message = "feat change") {
  git(w, "add", "-A");
  gitAt(n, w, "commit", "-q", "-m", message);
  return git(w, "rev-parse", "HEAD");
}

function run(cwd, head, { body = null, args = [], env = {} } = {}) {
  const argv = [SCRIPT, "--head", head, ...args];
  if (body !== null) argv.push("--body-file", "-");
  const r = spawnSync(process.execPath, argv, { cwd, env: { ...ENV, ...env }, encoding: "utf8", input: body ?? "" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const expect = (r, code) => assert.equal(r.code, code, `exit ${r.code}, expected ${code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

/**
 * AC5's shape: rebased onto the merge that added the block — a recent
 * merge-base — and only then deleting it.
 */
function deleteAfterRebase(t) {
  const f = world(t);
  rewriteAt(4, f.w, "rebase", "-q", "origin/main");
  write(f.w, "tests.txt", OLD);
  return { ...f, head: commitFeat(f.w, 5, "drop the block") };
}

// --- hits --------------------------------------------------------------------

test("AC1: a deletion written into a branch commit by an earlier rewrite, replayed cleanly onto a main that moved on -> 1, naming the file, the lines and #7", (t) => {
  const { w } = world(t);
  // The earlier rewrite: rebased onto #7, and the deletion amended into the
  // branch's first commit — its author date, R, is still T1.
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD);
  git(w, "add", "-A");
  rewriteAt(5, w, "commit", "-q", "--amend", "--no-edit");
  const head = git(w, "rev-parse", "HEAD");
  // main moves on elsewhere, so the head is behind and a rebase replays the
  // deletion with zero conflicts.
  landPr(w, 6, 8, { "other.txt": "other\n" });
  git(w, "checkout", "-q", "feat");
  rewriteAt(8, w, "rebase", "-q", "origin/main");

  const r = run(w, head);
  expect(r, 1);
  assert.equal(r.json.reason, "main-gain-removed:tests.txt");
  assert.equal(r.json.since, new Date((T0 + 1000) * 1000).toISOString());
  assert.equal(r.json.hits.length, 1);
  const [hit] = r.json.hits;
  assert.equal(hit.path, "tests.txt");
  assert.equal(hit.key, "#7");
  assert.deepEqual(hit.lines, [
    { line: 4, text: "new1" },
    { line: 5, text: "new2" },
    { line: 6, text: "new3" },
  ]);
  assert.equal(hit.ack, "main-gain-removal: tests.txt #7 - <why>");
  assert.deepEqual(r.json.acknowledged, []);
});

test("AC5: rebased onto the merge that added the block, and only then deleting it -> still 1", (t) => {
  const { w, head } = deleteAfterRebase(t);
  const r = run(w, head);
  expect(r, 1);
  assert.equal(r.json.hits[0].key, "#7");
  assert.equal(r.json.hits[0].lines.length, 3);
});

test("a removed line replaced by different text counts as removed", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD + "new1\nREWRITTEN\nnew3\n");
  const r = run(w, commitFeat(w, 5));
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 5, text: "new2" }]);
});

test("a whole-file deletion of fresh main work -> a hit on that file", (t) => {
  const { w } = world(t);
  landPr(w, 4, 9, { "fresh.txt": "fresh1\nfresh2\n" });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  unlinkSync(join(w, "fresh.txt"));
  const r = run(w, commitFeat(w, 7));
  expect(r, 1);
  assert.equal(r.json.reason, "main-gain-removed:fresh.txt");
  assert.deepEqual(r.json.hits.map((h) => [h.path, h.key, h.lines.length]), [["fresh.txt", "#9", 2]]);
});

test("a landing commit without GitHub's merge subject is keyed by its 12-character SHA, and acknowledgeable by that key", (t) => {
  const { w } = world(t);
  git(w, "checkout", "-q", "main");
  write(w, "direct.txt", "pushed\n");
  git(w, "add", "direct.txt");
  gitAt(4, w, "commit", "-q", "-m", "a direct push");
  const landed = git(w, "rev-parse", "HEAD");
  git(w, "push", "-q", "origin", "main");
  git(w, "checkout", "-q", "feat");
  rewriteAt(5, w, "rebase", "-q", "origin/main");
  unlinkSync(join(w, "direct.txt"));
  const head = commitFeat(w, 6);

  const r = run(w, head);
  expect(r, 1);
  assert.equal(r.json.hits[0].key, landed.slice(0, 12));
  assert.equal(r.json.hits[0].landed, landed);
  assert.equal(r.json.hits[0].ack, `main-gain-removal: direct.txt ${landed.slice(0, 12)} - <why>`);

  const acked = run(w, head, { body: `main-gain-removal: direct.txt ${landed.slice(0, 12)} - pushed by mistake\n` });
  expect(acked, 0);
  assert.equal(acked.json.acknowledged[0].reason, "pushed by mistake");
});

// --- acknowledgement ---------------------------------------------------------

test("AC3: a body marker for that path and key -> 0, with the hit under acknowledged[]", (t) => {
  const { w, head } = deleteAfterRebase(t);
  const r = run(w, head, { body: "Drops the flaky block.\r\n\r\nmain-gain-removal: tests.txt #7 - superseded by the new suite\r\n" });
  expect(r, 0);
  assert.equal(r.json.reason, null);
  assert.deepEqual(r.json.hits, []);
  assert.equal(r.json.acknowledged.length, 1);
  assert.equal(r.json.acknowledged[0].path, "tests.txt");
  assert.equal(r.json.acknowledged[0].key, "#7");
  assert.equal(r.json.acknowledged[0].reason, "superseded by the new suite");
  assert.equal(r.json.acknowledged[0].lines.length, 3);
});

test("AC3: a marker for another key, another file, or with an empty reason acknowledges nothing -> 1", (t) => {
  const { w, head } = deleteAfterRebase(t);
  for (const body of [
    "main-gain-removal: tests.txt #8 - wrong landing source\n",
    "main-gain-removal: other.txt #7 - wrong file\n",
    "main-gain-removal: tests.txt #7 - \n",
    "main-gain-removal: tests.txt #7 -    \n",
  ]) {
    const r = run(w, head, { body });
    assert.equal(r.code, 1, `${JSON.stringify(body)}: exit ${r.code}\n${r.stdout}`);
    assert.deepEqual(r.json.acknowledged, [], JSON.stringify(body));
  }
});

// --- not hits ----------------------------------------------------------------

test("AC2: the same branch without the deletion -> 0", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "feat.txt", "feature, revised\n");
  const r = run(w, commitFeat(w, 5));
  expect(r, 0);
  assert.equal(r.json.reason, null);
  assert.deepEqual([r.json.hits, r.json.acknowledged, r.json.unchecked], [[], [], []]);
});

test("a branch that is behind main and never touched the block -> 0", (t) => {
  const { w } = world(t);
  const r = run(w, git(w, "rev-parse", "HEAD"));
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
});

test("a block moved within its file is not a hit", (t) => {
  const { w } = world(t);
  // Every line of moves.txt lands after R, and the move is the cheaper diff
  // only as a removal of `moved` at the bottom plus an addition at the top —
  // so the removal is really in the diff, and only the move rule clears it.
  landPr(w, 4, 9, { "moves.txt": "a\nb\nc\nd\ne\nmoved\n" });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  write(w, "moves.txt", "moved\na\nb\nc\nd\ne\n");
  const r = run(w, commitFeat(w, 7));
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
});

test("a deletion of lines older than R is not a hit", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", "old2\n" + BLOCK);
  const r = run(w, commitFeat(w, 5));
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
});

test("a rename is not a mass hit", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  renameSync(join(w, "tests.txt"), join(w, "renamed.txt"));
  const r = run(w, commitFeat(w, 5));
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
});

test("a binary file goes into unchecked[] and the check exits 0", (t) => {
  const { w } = world(t);
  landPr(w, 4, 9, { "asset.bin": Buffer.from([0, 1, 2, 3, 0, 9]) });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  write(w, "asset.bin", Buffer.from([0, 7, 7, 7, 0, 9]));
  const r = run(w, commitFeat(w, 7));
  expect(r, 0);
  assert.deepEqual(r.json.unchecked, ["asset.bin"]);
  assert.deepEqual(r.json.hits, []);
});

// --- unknown -----------------------------------------------------------------

test("a head object that does not exist -> 2, never a clean answer", (t) => {
  const { w } = world(t);
  const r = run(w, "e".repeat(40));
  expect(r, 2);
  assert.equal(r.json.reason, "head-unreadable");
  assert.deepEqual(r.json.hits, []);
});

test("a head that cannot merge cleanly -> 2 merge-conflict", (t) => {
  const { w } = world(t);
  write(w, "tests.txt", OLD + "conflicting\n");
  const r = run(w, commitFeat(w, 4));
  expect(r, 2);
  assert.equal(r.json.reason, "merge-conflict");
});

test("bad arguments -> 2 with no JSON line", (t) => {
  const { w } = world(t);
  const head = git(w, "rev-parse", "HEAD");
  for (const [args, pattern] of [
    [["--head", head.slice(0, 12)], /full 40-character commit SHA/],
    [["--head", head, "--base", "main"], /--base must be spelled origin\/<branch> or refs\/remotes\/<path>/],
    [["--head", head, "--body-file", join(w, "no-such-file")], /cannot read --body-file/],
    [[], /usage: main-gain\.mjs/],
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: w, env: ENV, encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, pattern);
  }
});

// --- where it reads ----------------------------------------------------------

test("an ambient GIT_DIR naming another repository cannot move the check there", (t) => {
  const { w, root, head } = deleteAfterRebase(t);
  const other = join(root, "other");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", other], { env: ENV });
  const r = run(w, head, { env: { GIT_DIR: join(other, ".git") } });
  expect(r, 1);
  assert.equal(r.json.hits[0].key, "#7");
});

test("it never fetches, writes or changes refs", (t) => {
  const { w, head } = deleteAfterRebase(t);
  const refs = () => git(w, "for-each-ref", "--format=%(refname) %(objectname)");
  const before = refs();
  const status = git(w, "status", "--porcelain");
  run(w, head);
  assert.equal(refs(), before);
  assert.equal(git(w, "status", "--porcelain"), status);
  assert.equal(readFileSync(join(w, "tests.txt"), "utf8"), OLD);
});

// --- boundaries and hardening ---------------------------------------------------

test("a landing at exactly R is not after R → 0", (t) => {
  // pr7's merge is committed at T1, the same second as the PR's first commit.
  const { w } = world(t, 0);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD);
  const r = run(w, commitFeat(w, 5, "drop the block"));
  expect(r, 0);
  assert.equal(r.json.since, new Date((T0 + 1000) * 1000).toISOString());
  assert.deepEqual(r.json.hits, []);
});

test("a well-formed --base that names no remote ref → 2 base-unreadable, never a clean answer", (t) => {
  const { w, head } = deleteAfterRebase(t);
  const r = run(w, head, { args: ["--base", "origin/gone"] });
  expect(r, 2);
  assert.equal(r.json.reason, "base-unreadable");
  assert.deepEqual(r.json.hits, []);
});

test("a blame git cannot answer → 2 blame-failed:<path>, never a clean answer", (t) => {
  const { w, head } = deleteAfterRebase(t);
  // A repository setting git refuses at blame time.
  git(w, "config", "blame.date", "bogus");
  const r = run(w, head);
  expect(r, 2);
  assert.equal(r.json.reason, "blame-failed:tests.txt");
  assert.deepEqual(r.json.hits, []);
});

// Not pinned, because real git cannot reach them: the history read's integer
// check, the merge-tree sha check and the blame completeness check each guard
// a git that exits 0 with output it does not print.

test("a blame.ignoreRevsFile naming a file that is not there cannot blind the check → 1", (t) => {
  const { w, head } = deleteAfterRebase(t);
  git(w, "config", "blame.ignoreRevsFile", ".git-blame-ignore-revs");
  const r = run(w, head);
  expect(r, 1);
  assert.equal(r.json.hits[0].key, "#7");
});

test("a local tag or branch literally named origin/main cannot answer for the remote one", (t) => {
  const { w, head } = deleteAfterRebase(t);
  // Unqualified, `origin/main` would resolve to this tag — the head itself, and
  // against the head the deletion is no change at all.
  git(w, "tag", "origin/main", head);
  assert.equal(git(w, "rev-parse", "origin/main"), head);
  const r = run(w, head);
  expect(r, 1);
  assert.equal(r.json.hits[0].key, "#7");
  git(w, "tag", "-d", "origin/main");
  git(w, "branch", "origin/main", head);
  const b = run(w, head);
  expect(b, 1);
  assert.equal(b.json.hits[0].key, "#7");
});

test("a file whose name holds glob characters is a name, never a pattern", (t) => {
  const { w } = world(t);
  landPr(w, 4, 9, { "[a]*.txt": "x1\nx2\n", "ab.txt": "y1\ny2\ny3\ny4\n" });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  unlinkSync(join(w, "[a]*.txt"));
  unlinkSync(join(w, "ab.txt"));
  const r = run(w, commitFeat(w, 7));
  expect(r, 1);
  assert.deepEqual(r.json.hits.map((h) => [h.path, h.key, h.lines.length]).sort(), [["[a]*.txt", "#9", 2], ["ab.txt", "#9", 4]]);
});

test("an uppercase --head names the same commit → read as lowercase", (t) => {
  const { w, head } = deleteAfterRebase(t);
  const r = run(w, head.toUpperCase());
  expect(r, 1);
  assert.equal(r.json.head, head);
});

// --- diff reading ------------------------------------------------------------------

test("removals in two hunks of one file each carry their own line number", (t) => {
  const { w } = world(t);
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  landPr(w, 4, 9, { "long.txt": `${lines.join("\n")}\n` });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  write(w, "long.txt", `${lines.filter((l) => l !== "l2" && l !== "l19").join("\n")}\n`);
  const r = run(w, commitFeat(w, 7));
  expect(r, 1);
  assert.deepEqual(r.json.hits.map((h) => [h.path, h.lines]), [["long.txt", [{ line: 2, text: "l2" }, { line: 19, text: "l19" }]]]);
});

test("a line text added back once covers only one removal of that text", (t) => {
  const { w } = world(t);
  landPr(w, 4, 9, { "dup.txt": "dup\na\nb\nc\nd\ndup\n" });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  // Both `dup` lines are removed — the one diff alignment there is — and one
  // `dup` is added between b and c: one removal moved, the other is gone.
  write(w, "dup.txt", "a\nb\ndup\nc\nd\n");
  const r = run(w, commitFeat(w, 7));
  expect(r, 1);
  assert.deepEqual(r.json.hits.map((h) => [h.path, h.lines]), [["dup.txt", [{ line: 6, text: "dup" }]]]);
});

test("a submodule is listed in unchecked[], never read line by line", (t) => {
  const { w } = world(t);
  git(w, "checkout", "-q", "main");
  git(w, "checkout", "-q", "-b", "pr9");
  git(w, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
  gitAt(4, w, "commit", "-q", "-m", "pr9 work");
  git(w, "checkout", "-q", "main");
  gitAt(5, w, "merge", "-q", "--no-ff", "pr9", "-m", "Merge pull request #9 from o/pr9");
  git(w, "push", "-q", "origin", "main");
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  git(w, "update-index", "--force-remove", "sub");
  const r = run(w, commitFeat(w, 7));
  expect(r, 0);
  assert.deepEqual(r.json.unchecked, ["sub"]);
  assert.deepEqual(r.json.hits, []);
});
