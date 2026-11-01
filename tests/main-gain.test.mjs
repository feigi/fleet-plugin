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
import { dirname, join } from "node:path";
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

// `closing` is the object `gh pr view --json number,url,closingIssuesReferences`
// prints, or a string written as it is, handed over as `--closing-refs`.
function run(cwd, head, { body = null, args = [], env = {}, closing = null } = {}) {
  const argv = [SCRIPT, "--head", head, ...args];
  if (body !== null) argv.push("--body-file", "-");
  if (closing !== null) {
    const file = join(dirname(cwd), "closing-refs.json");
    writeFileSync(file, typeof closing === "string" ? closing : JSON.stringify(closing));
    argv.push("--closing-refs", file);
  }
  const r = spawnSync(process.execPath, argv, { cwd, env: { ...ENV, ...env }, encoding: "utf8", input: body ?? "" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const PR_URL = "https://github.com/o/r/pull/5";
/** What gh prints for a PR that closes `numbers` in its own repository. */
const closing = (...numbers) => ({
  number: 5,
  url: PR_URL,
  closingIssuesReferences: numbers.map((number) => ({ number, url: `https://github.com/o/r/issues/${number}` })),
});

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
    { line: 4, text: "new1", kind: "deleted" },
    { line: 5, text: "new2", kind: "deleted" },
    { line: 6, text: "new3", kind: "deleted" },
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

test("a removed line rewritten into text that drops one of its tokens is a modified hit", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD + "new1\nREWRITTEN\nnew3\n");
  const r = run(w, commitFeat(w, 5));
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 5, text: "new2", kind: "modified" }]);
});

test("a removed line edited in place, keeping every token, is not a hit", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD + "new1\nnew2 extra\nnew3\n");
  const r = run(w, commitFeat(w, 5));
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.edited, [{ path: "tests.txt", line: 5, text: "new2", replacement: "new2 extra", rule: "line" }]);
});

test("one added line holding the tokens of two removed lines covers only the first, when the hunk rule fails", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  // `new1` is dropped, so the added tokens do not hold the hunk's removed ones.
  write(w, "tests.txt", OLD + "new2 new3 extra\n");
  const r = run(w, commitFeat(w, 5));
  expect(r, 1);
  assert.deepEqual(r.json.edited, [{ path: "tests.txt", line: 5, text: "new2", replacement: "new2 new3 extra", rule: "line" }]);
  assert.deepEqual(r.json.hits[0].lines, [
    { line: 4, text: "new1", kind: "modified" },
    { line: 6, text: "new3", kind: "modified" },
  ]);
});

// --- hunk rule ---------------------------------------------------------------

test("a gained line re-wrapped over two added lines keeping every token clears as `hunk`", (t) => {
  const r = rewriteLanded(t, "w.txt", "aa bb cc dd\n", "aa bb\ncc dd\n");
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.edited, [{ path: "w.txt", line: 1, text: "aa bb cc dd", replacement: "aa bb\ncc dd", rule: "hunk" }]);
});

test("two gained lines joined into one: the first is an in-place edit, the rest of the hunk clears as `hunk`", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD + "new1\nnew2 new3 extra\n");
  const r = run(w, commitFeat(w, 5));
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.edited, [
    { path: "tests.txt", line: 5, text: "new2", replacement: "new2 new3 extra", rule: "line" },
    { path: "tests.txt", line: 6, text: "new3", replacement: "new2 new3 extra", rule: "hunk" },
  ]);
});

test("a hunk entry lists the first cleared gained line, every cleared line and every added line compared", (t) => {
  const r = rewriteLanded(t, "w.txt", "aa bb\ncc dd\nee ff\n", "aa bb cc dd ee ff\ngg\n");
  expect(r, 0);
  assert.deepEqual(r.json.edited.filter((e) => e.rule === "hunk"), [
    { path: "w.txt", line: 2, text: "cc dd\nee ff", replacement: "aa bb cc dd ee ff\ngg", rule: "hunk" },
  ]);
});

test("tokens count at the hunk level: `foo bar` and `foo baz` rewritten as `foo bar baz` stays a hit", (t) => {
  const r = rewriteLanded(t, "c.txt", "foo bar\nfoo baz\n", "foo bar baz\n");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 2, text: "foo baz", kind: "modified" }]);
  assert.deepEqual(r.json.hits[0].hunks, [{ lines: [2], added: ["foo bar baz"], missing: [["foo", 1]] }]);
});

test("a token moved into a different hunk is missing from its own hunk: the line stays a hit", (t) => {
  const r = rewriteLanded(t, "h.txt", "a1 a2\nm1\nm2\nm3\nb1\n", "a1\nm1\nm2\nm3\nb1 a2\n");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "a1 a2", kind: "modified" }]);
  assert.deepEqual(r.json.hits[0].hunks, [{ lines: [1], added: ["a1"], missing: [["a2", 1]] }]);
  assert.deepEqual(r.json.edited, [{ path: "h.txt", line: 5, text: "b1", replacement: "b1 a2", rule: "line" }]);
});

test("a blank gained line replaced by text and a blank line in the same hunk, every other token kept, clears as `hunk`", (t) => {
  const r = rewriteLanded(t, "b.txt", "x1\n   \nx3\n", "x1\nX\n\nx3\n");
  expect(r, 0);
  assert.deepEqual(r.json.edited, [{ path: "b.txt", line: 2, text: "   ", replacement: "X\n", rule: "hunk" }]);
});

test("a hunk that adds nothing is never cleared: a deleted gained line stays a hit", (t) => {
  const r = rewriteLanded(t, "d.txt", "x1\nx2\nx3\n", "x1\nx3\n");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 2, text: "x2", kind: "deleted" }]);
  assert.deepEqual(r.json.hits[0].hunks, [{ lines: [2], added: [] }]);
});

// --- retraction rule ---------------------------------------------------------

// The retraction of a forward reference, re-wrapped; the PR closes the ticket.
const FORWARD = "acceptance criteria, `unknown` when either is missing. Once #3956 lands, a\nSlice is `heavy` whatever its length. `light` means a short ticket, not an\n";
const RETRACTED = "acceptance criteria, `unknown` when either is missing. A Slice is `heavy`\nwhatever its length. `light` means a short ticket, not an\n";

test("a forward reference to a ticket the PR closes is retracted: the hunk clears as `retracted #N`", (t) => {
  const r = rewriteLanded(t, "s.md", FORWARD, RETRACTED, { closing: closing(3956) });
  expect(r, 0);
  assert.deepEqual(r.json.closes, [3956]);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.edited, [{ path: "s.md", line: 1, text: FORWARD.trimEnd(), replacement: RETRACTED.trimEnd(), rule: "retracted #3956" }]);
});

test("the same retraction in a PR that only refers to the ticket stays a hit, with the missing tokens named", (t) => {
  const r = rewriteLanded(t, "s.md", FORWARD, RETRACTED, { closing: closing() });
  expect(r, 1);
  assert.deepEqual(r.json.closes, []);
  assert.deepEqual(r.json.hits[0].lines.map((l) => [l.line, l.kind]), [[1, "modified"], [2, "modified"]]);
  assert.deepEqual(r.json.hits[0].hunks[0].missing, [[",", 1], ["Once", 1], ["#", 1], ["3956", 1], ["lands", 1], ["a", 1]]);
  assert.deepEqual(r.json.hits[0].hunks[0].lines, [1, 2]);
});

test("a phrase may span lines", (t) => {
  const r = rewriteLanded(t, "s.md", "Once #12\nlands, the X\n", "The X\n", { closing: closing(12) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12"]);
});

test("a hunk that only removes a gained `Once #12 lands,` stays a deleted hit, even for a PR that closes #12", (t) => {
  const r = rewriteLanded(t, "d.txt", "x1\nOnce #12 lands,\nx3\n", "x1\nx3\n", { closing: closing(12) });
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 2, text: "Once #12 lands,", kind: "deleted" }]);
});

test("a phrase naming a number the PR does not close does not count", (t) => {
  const r = rewriteLanded(t, "p.txt", "(target; #12 and #13 still to land)\n", "(target; #13 still to land)\n", { closing: closing(12) });
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "(target; #12 and #13 still to land)", kind: "modified" }]);
});

test("a phrase naming only closed numbers counts, whatever joins them", (t) => {
  const r = rewriteLanded(t, "p.txt", "(target; #12 and #13 still to land)\n", "(target;)\n", { closing: closing(12, 13) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12 #13"]);
});

test("an amendment note is no forward reference: dropping a gained `Amended by #12.` stays a hit", (t) => {
  const r = rewriteLanded(t, "a.txt", "Some rule. Amended by #12.\n", "Some rule.\n", { closing: closing(12) });
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "Some rule. Amended by #12.", kind: "modified" }]);
});

test("a Status line whose gained `Amended by #12: …` text the PR's own edit drops stays a hit", (t) => {
  const landed = "**Status:** Accepted. Amended by #12: the row is gone.\n";
  const r = rewriteLanded(t, "adr.md", landed, "**Status:** Accepted.\n", { closing: closing(12) });
  expect(r, 1);
  assert.equal(r.json.hits[0].lines[0].text, landed.trimEnd());
});

test("case tolerance covers the one token after the phrase: `Once #12 lands, the X` -> `The X` clears", (t) => {
  const r = rewriteLanded(t, "k.txt", "Once #12 lands, the X\n", "The X\n", { closing: closing(12) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12"]);
});

test("case tolerance covers one token only: `Once #12 lands, the X` -> `The x` stays a hit", (t) => {
  const r = rewriteLanded(t, "k.txt", "Once #12 lands, the X\n", "The x\n", { closing: closing(12) });
  expect(r, 1);
});

test("a phrase is matched case-insensitively, on whole tokens", (t) => {
  const loud = rewriteLanded(t, "k.txt", "ONCE #12 LANDS, the X\n", "The X\n", { closing: closing(12) });
  expect(loud, 0);
  const partial = rewriteLanded(t, "k.txt", "nonce #12 lands, the X\n", "The X\n", { closing: closing(12) });
  expect(partial, 1);
});

// Each documented phrase form, with the closing numbers it names, for a PR
// that closes #12 and #13. One hunk per form, so each clears or fails alone.
const PHRASES = [
  ["until #12 lands", "#12"],
  ["when #12 land", "#12"],
  ["after #12 ships", "#12"],
  ["pending #12 ship", "#12"],
  ["once #12 merges", "#12"],
  ["once #12 merge", "#12"],
  ["once #12 is built", "#12"],
  ["written once #12 lands", "#12"],
  ["once #12, #13 land", "#12 #13"],
  ["once #12/#13 land", "#12 #13"],
  ["once #12 & #13 land", "#12 #13"],
  ["once `#12` lands", "#12"],
  ["pending #12, not yet built", "#12"],
  ["#12 and #13 are still to land", "#12 #13"],
];

test("every documented phrase form is retracted", (t) => {
  const landed = PHRASES.map(([phrase], i) => `keep${i}\nL${i} ${phrase} tail${i}\n`).join("");
  const edited = PHRASES.map((_, i) => `keep${i}\nL${i} tail${i}\n`).join("");
  const r = rewriteLanded(t, "f.md", landed, edited, { closing: closing(12, 13) });
  expect(r, 0);
  assert.deepEqual(
    r.json.edited.map((e) => [e.text, e.rule]),
    PHRASES.map(([phrase, named], i) => [`L${i} ${phrase} tail${i}`, `retracted ${named}`]),
  );
});

test("a phrase ends on a token boundary: `once #12 landed` is no phrase", (t) => {
  const r = rewriteLanded(t, "k.txt", "Once #12 landed the X\n", "the X\n", { closing: closing(12) });
  expect(r, 1);
});

test("a lead word inside a longer word starts no phrase, beside a real phrase that retracts", (t) => {
  const r = rewriteLanded(t, "k.txt", "nonce #12 lands, once #12 lands, the X\n", "nonce #12 lands, The X\n", { closing: closing(12) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12"]);
});

test("a phrase at the very end of the removed lines is retracted", (t) => {
  const r = rewriteLanded(t, "k.txt", "The X until #12 lands\n", "The X\n", { closing: closing(12) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12"]);
});

test("two phrases side by side are each retracted", (t) => {
  const r = rewriteLanded(t, "k.txt", "Once #12 lands, once #13 lands, the X\n", "The X\n", { closing: closing(12, 13) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12 #13"]);
});

test("the token after a phrase must still be there: `Once #12 lands, the X` -> `X` stays a hit", (t) => {
  const r = rewriteLanded(t, "k.txt", "Once #12 lands, the X\n", "X\n", { closing: closing(12) });
  expect(r, 1);
});

test("a number two phrases name is listed once in the rule", (t) => {
  const r = rewriteLanded(t, "k.txt", "Once #12 lands, the X\nUntil #12 lands, the Y\n", "The X\nThe Y\n", { closing: closing(12) });
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["retracted #12"]);
});

// --- closing issues ----------------------------------------------------------

test("no --closing-refs: closes is null and the retraction rule is off", (t) => {
  const r = rewriteLanded(t, "s.md", FORWARD, RETRACTED);
  expect(r, 1);
  assert.equal(r.json.closes, null);
});

test("closes keeps this repository's closing references and drops another repository's", (t) => {
  const refs = {
    number: 5,
    url: PR_URL,
    closingIssuesReferences: [
      { number: 3956, url: "https://github.com/o/r/issues/3956" },
      { number: 12, url: "https://github.com/o/other/issues/12" },
    ],
  };
  const r = rewriteLanded(t, "s.md", FORWARD, RETRACTED, { closing: refs });
  expect(r, 0);
  assert.deepEqual(r.json.closes, [3956]);
  const foreign = rewriteLanded(t, "k.txt", "Once #12 lands, the X\n", "The X\n", { closing: refs });
  expect(foreign, 1);
});

test("a closing reference it cannot place, a url that is not this PR's, or an unreadable file: it still answers, closes null, rule off", (t) => {
  const unplaced = { ...closing(3956), closingIssuesReferences: [{ number: 3956 }] };
  const wrongUrl = { ...closing(3956), url: "https://github.com/o/r/pull/6" };
  for (const bad of [unplaced, wrongUrl, "not json", "null"]) {
    const r = rewriteLanded(t, "s.md", FORWARD, RETRACTED, { closing: bad });
    expect(r, 1);
    assert.equal(r.json.closes, null);
  }
  const { w } = world(t);
  const missing = run(w, git(w, "rev-parse", "HEAD"), { args: ["--closing-refs", join(dirname(w), "absent.json")] });
  expect(missing, 0);
  assert.equal(missing.json.closes, null);
});

test("every in-place edit carries rule `line`, and the output carries closes", (t) => {
  const r = rewriteLanded(t, "i.mjs", `${IMPORT}\n`, 'import { a, b, c } from "./m.mjs";\n');
  expect(r, 0);
  assert.deepEqual(r.json.edited.map((e) => e.rule), ["line"]);
  assert.equal(r.json.closes, null);
});

/** Lands `path` holding `landed` through #9 after R, then the PR rewrites it to `edited`. */
function rewriteLanded(t, path, landed, edited, options = {}) {
  const { w } = world(t);
  landPr(w, 4, 9, { [path]: landed });
  git(w, "checkout", "-q", "feat");
  rewriteAt(6, w, "rebase", "-q", "origin/main");
  write(w, path, edited);
  return run(w, commitFeat(w, 7), options);
}

const IMPORT = 'import { a, b } from "./m.mjs";';

test("a name appended to a gained import line is an in-place edit, not a hit", (t) => {
  const r = rewriteLanded(t, "i.mjs", `${IMPORT}\n`, 'import { a, b, c } from "./m.mjs";\n');
  expect(r, 0);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.edited, [{ path: "i.mjs", line: 1, text: IMPORT, replacement: 'import { a, b, c } from "./m.mjs";', rule: "line" }]);
});

test("an in-place edit reports both lines verbatim, indentation included", (t) => {
  const r = rewriteLanded(t, "g.mjs", "if (ok) {\n  run(a);\n}\n", "if (ok) {\n  run(a, b);\n}\n");
  expect(r, 0);
  assert.deepEqual(r.json.edited, [{ path: "g.mjs", line: 2, text: "  run(a);", replacement: "  run(a, b);", rule: "line" }]);
});

test("a name dropped from a gained import line is a modified hit", (t) => {
  const r = rewriteLanded(t, "i.mjs", `${IMPORT}\n`, 'import { a } from "./m.mjs";\n');
  expect(r, 1);
  assert.equal(r.json.reason, "main-gain-removed:i.mjs");
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: IMPORT, kind: "modified" }]);
  assert.deepEqual(r.json.edited, []);
});

// A name is one token, so a rewrite that keeps its characters but not the name
// is a modified hit. `renamed` lands `use(max);` and puts `to` in place of `max`.
const renamed = (t, to) => rewriteLanded(t, "u.mjs", "use(max);\n", `use(${to});\n`);

test("a name is one token: reordering its letters is a modified hit", (t) => {
  const r = renamed(t, "xam");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "use(max);", kind: "modified" }]);
});

test("an underscore joins a name: extending one with _len is a modified hit", (t) => {
  const r = renamed(t, "max_len");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "use(max);", kind: "modified" }]);
});

test("a non-ASCII letter joins a name: extending one with é is a modified hit", (t) => {
  const r = renamed(t, "maxé");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "use(max);", kind: "modified" }]);
});

test("a token the removed line repeats must survive as often: an added line holding it once is a modified hit", (t) => {
  const r = rewriteLanded(t, "f.mjs", "f(a, a);\n", "f(a, b);\n");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "f(a, a);", kind: "modified" }]);
  assert.deepEqual(r.json.edited, []);
});

test("a gained blank line replaced by text is a modified hit, not an unanswerable run", (t) => {
  const r = rewriteLanded(t, "b.txt", "x1\n\nx3\n", "x1\nX\nx3\n");
  expect(r, 1);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 2, text: "", kind: "modified" }]);
  assert.deepEqual(r.json.hits[0].hunks, [{ lines: [2], added: ["X"], missing: [["\n", 1]] }]);
});

test("a long removed line claims an added line holding its tokens before a short one does", (t) => {
  // The short line comes first in the diff, so only the most-tokens-first
  // order hands the added line to the long one.
  const r = rewriteLanded(t, "s.txt", "a\na b c\n", "a b c d\n");
  expect(r, 1);
  assert.deepEqual(r.json.edited, [{ path: "s.txt", line: 2, text: "a b c", replacement: "a b c d", rule: "line" }]);
  assert.deepEqual(r.json.hits[0].lines, [{ line: 1, text: "a", kind: "modified" }]);
});

test("a modified hit is acknowledged like any other", (t) => {
  const { w } = world(t);
  rewriteAt(4, w, "rebase", "-q", "origin/main");
  write(w, "tests.txt", OLD + "new1\nREWRITTEN\nnew3\n");
  const r = run(w, commitFeat(w, 5), { body: "main-gain-removal: tests.txt #7 - reworded on purpose\n" });
  expect(r, 0);
  assert.equal(r.json.acknowledged[0].lines[0].kind, "modified");
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
  assert.deepEqual(r.json.hits[0].lines.map((l) => l.kind), ["deleted", "deleted"]);
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
  assert.deepEqual(r.json.hits.map((h) => [h.path, h.lines]), [["long.txt", [{ line: 2, text: "l2", kind: "deleted" }, { line: 19, text: "l19", kind: "deleted" }]]]);
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
  assert.deepEqual(r.json.hits.map((h) => [h.path, h.lines]), [["dup.txt", [{ line: 6, text: "dup", kind: "deleted" }]]]);
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
