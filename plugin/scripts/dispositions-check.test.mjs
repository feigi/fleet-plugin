// dispositions-check.mjs: a review fix-applier's disposition record judged
// against the review file and the PR's diff, its verdict written onto the
// ledger, and `ledger.mjs dispatch` then gating the finisher on it.
//
// Every CLI case runs against a real git repository built in a temp dir —
// `origin/main` a ref, the PR head one commit past it — so the touched lines
// are git's own answer, not a fixture's restatement of one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { touchedLines, checkDispositions, withVerdict, repoPath } from "./dispositions-check.mjs";

const SCRIPT = fileURLToPath(new URL("./dispositions-check.mjs", import.meta.url));
const LEDGER = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
};

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: cleanEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
  }).trim();
}

const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

// A repository whose `origin/main` holds src/a.js (20 lines) and src/b.js,
// and whose PR head rewrites src/a.js lines 5-6 and appends line 21. Lines
// 1-4 and 7-20 are untouched; src/b.js is not in the diff at all.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "dispositions-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.js"), lines(20, "a"));
  writeFileSync(join(repo, "src", "b.js"), lines(10, "b"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const a = lines(20, "a").split("\n");
  a[4] = "a 5 changed";
  a[5] = "a 6 changed";
  a.splice(20, 0, "a 21 added");
  writeFileSync(join(repo, "src", "a.js"), a.join("\n"));
  git(repo, "commit", "-qam", "pr");
  const head = git(repo, "rev-parse", "HEAD");

  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  const ledger = join(dir, "ledger.md");
  const ledgerCli = (...args) => spawnSync(process.execPath, [LEDGER, "--file", ledger, ...args], { encoding: "utf8", env: cleanEnv() });
  const okLedger = (...args) => {
    const r = ledgerCli(...args);
    assert.equal(r.status, 0, `ledger ${args.join(" ")}: exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  okLedger("row", "10", `impl-10=PR#40 → PR#40 · reviewed=${head}:2/1/1`);
  okLedger("dispatch", "40", "fix-pr-40");
  okLedger("settle", "fix-pr-40", `applied:${head.slice(0, 7)}`);

  const finding = (file, line, severity = "important") => ({ severity, file, line, claim: "c", evidence: "e" });
  const review = {
    pr: 40, head, snapshot: join(dir, "snap"),
    counts: { survived: 2, refuted: 1, unverified: 1, crashed: 0 },
    // survived[0] on a touched line; survived[1] on an untouched one.
    survived: [finding("src/a.js", 5), finding("src/a.js", 12)],
    refuted: [finding("src/b.js", 3)],
    unverified: [finding("src/a.js", 15, "suggestion")],
  };
  const writeReview = (r = review) => writeFileSync(join(scratch, "review-40.json"), JSON.stringify(r));
  writeReview();
  const entry = (bucket, index, more = {}) => ({ bucket, index, scope: "in", claimKind: "behavior", disposition: "apply", ...more });
  // Every finding answered, every in-scope survivor applied: an ok record.
  const baseEntries = () => [entry("survived", 0), entry("survived", 1), entry("unverified", 0, { disposition: "defer", issue: 77 })];
  const writeRecord = (entries, recHead = head) =>
    writeFileSync(join(scratch, "dispositions-40.json"), JSON.stringify({ head: recHead, entries }));

  const check = (member = "fix-pr-40", env = cleanEnv()) => {
    const r = spawnSync(process.execPath, [SCRIPT, "--member", member, "--scratch", scratch, "--repo", repo, "--ledger", ledger],
      { encoding: "utf8", env, cwd: dir });
    return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null };
  };
  const row = () => okLedger("read").rows.find((r) => r.startsWith("#10 "));
  return { dir, repo, head, scratch, review, writeReview, entry, baseEntries, writeRecord, check, row, ledgerCli, okLedger };
}

const mismatch = (r, re) => {
  assert.equal(r.status, 1, `expected a mismatch, got exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.verdict, "mismatch");
  if (re) assert.match(r.stderr, re);
};
const okVerdict = (r) => {
  assert.equal(r.status, 0, `expected ok, got exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.verdict, "ok");
};

test("an in-scope survivor deferred with no reason is a mismatch, and the finisher is refused with nothing written", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(entries);
  const r = f.check();
  mismatch(r, /fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason — src\/a\.js:5 is a line the PR's diff touched/);
  assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 0]]);
  assert.ok(f.row().includes(`dispositions-mismatch=fix-pr-40:${f.head}`), f.row());

  const before = readFileSync(join(f.dir, "ledger.md"), "utf8");
  const d = f.ledgerCli("dispatch", "40", "finisher-pr-40");
  assert.equal(d.status, 2);
  assert.match(d.stderr, /finisher-pr-40: dispositions mismatch — fix-pr-40's disposition record/);
  assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), before, "a refused dispatch writes nothing");
});

test("a survived finding left off the record is a mismatch naming its bucket and index, and so is an unverified one", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries().filter((e) => !(e.bucket === "survived" && e.index === 1)));
  mismatch(f.check(), /^fix-pr-40: survived\[1\]: no entry — a finding with no entry is a dropped finding$/m);

  f.writeRecord(f.baseEntries().filter((e) => e.bucket !== "unverified"));
  const r = f.check();
  mismatch(r, /^fix-pr-40: unverified\[0\]: no entry/m);
  assert.deepEqual(r.json.violations, [{ bucket: "unverified", index: 0, rule: "no entry — a finding with no entry is a dropped finding" }]);
});

test("each allowed reason passes an in-scope survivor's deferral, writes dispositions-ok and lets the finisher dispatch", (t) => {
  for (const reason of ["false-rationale", "mutual-exclusion", "remedy-worse"]) {
    const f = fixture(t);
    const entries = f.baseEntries();
    entries[0] = f.entry("survived", 0, { disposition: "defer", reason, issue: 81 });
    f.writeRecord(entries);
    okVerdict(f.check());
    assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.head}`), `${reason}: ${f.row()}`);
    assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher", reason);
  }
});

test("any other reason is a mismatch — remedy-outside-diff included, until it is accepted", (t) => {
  const f = fixture(t);
  for (const reason of ["outside-ticket-files", "remedy-outside-diff", ""]) {
    const entries = f.baseEntries();
    entries[0] = f.entry("survived", 0, { disposition: "defer", reason });
    f.writeRecord(entries);
    mismatch(f.check(), /survived\[0\]: an in-scope survived finding deferred with/);
  }
});

test("a touched line is in scope whatever the record declares; an untouched one keeps its declared scope", (t) => {
  const f = fixture(t);
  // survived[0] sits on touched line 5: declaring it out changes nothing.
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { scope: "out", disposition: "defer" });
  f.writeRecord(entries);
  mismatch(f.check(), /survived\[0\]: .* src\/a\.js:5 is a line the PR's diff touched, so it is in scope whatever its entry declares/);

  // survived[1] sits on untouched line 12: declared out, it defers with no reason.
  const out = f.baseEntries();
  out[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", issue: 90 });
  f.writeRecord(out);
  okVerdict(f.check());
  // Declared in, the same deferral is a mismatch.
  out[1] = f.entry("survived", 1, { scope: "in", disposition: "defer" });
  f.writeRecord(out);
  mismatch(f.check(), /survived\[1\]: .* its entry declares scope in/);
});

test("a finding with no line is in scope, so its deferral needs an allowed reason", (t) => {
  const f = fixture(t);
  f.writeReview({ ...f.review, survived: [f.review.survived[0], { severity: "important", file: "src/a.js", claim: "c", evidence: "e" }] });
  const entries = f.baseEntries();
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer" });
  f.writeRecord(entries);
  mismatch(f.check(), /survived\[1\]: .* it has no line, so it is in scope/);
});

test("a fix-applier commit that shifts line numbers after the review head does not change the verdict", (t) => {
  const f = fixture(t);
  // survived[1], line 12, is untouched at the review head: declared out, deferred.
  const entries = f.baseEntries();
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer" });
  f.writeRecord(entries);
  okVerdict(f.check());
  // The fix-applier's commit rewrites line 12 and inserts lines above it: at
  // the worktree's HEAD line 12 is touched, at the review head it is not.
  const a = readFileSync(join(f.repo, "src", "a.js"), "utf8").split("\n");
  a[11] = "a 12 rewritten";
  a.splice(0, 0, "inserted 1", "inserted 2", "inserted 3");
  writeFileSync(join(f.repo, "src", "a.js"), a.join("\n"));
  git(f.repo, "commit", "-qam", "fix-applier");
  okVerdict(f.check());
  // And the reverse: survived[0] on touched line 5 stays a mismatch however
  // far the later commit pushed it.
  entries[0] = f.entry("survived", 0, { scope: "out", disposition: "defer" });
  f.writeRecord(entries);
  mismatch(f.check(), /survived\[0\]: .* src\/a\.js:5 is a line the PR's diff touched/);
});

test("what the check accepts: applied survivors, out-of-scope deferrals, unverified deferrals, reversed refutations with evidence", (t) => {
  const f = fixture(t);
  f.writeRecord([
    f.entry("survived", 0),
    f.entry("survived", 1, { scope: "out", claimKind: "shape", disposition: "defer", issue: 12 }),
    f.entry("unverified", 0, { disposition: "defer", reason: "anything", issue: 13, verdictPath: "/tmp/v.json" }),
    f.entry("refuted", 0, { reason: "re-ran the refuter's probe at the head and the defect reproduces", remedyFiles: ["src/b.js"] }),
  ]);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.violations, []);
});

test("a malformed, duplicate, out-of-range, stale or missing record is a mismatch", (t) => {
  const f = fixture(t);
  const cases = [
    [[...f.baseEntries(), f.entry("survived", 0)], /survived\[0\]: a second entry \(entries\[3\]\)/],
    [[...f.baseEntries(), f.entry("survived", 2)], /survived\[2\]: entries\[3\] names no finding — survived holds 2/],
    [[...f.baseEntries(), f.entry("bogus", 0)], /record: entries\[3\] names bucket "bogus"/],
    [[f.entry("survived", 0, { scope: "maybe" }), ...f.baseEntries().slice(1)], /survived\[0\]: malformed entry — scope "maybe" is not one of in\|out/],
    [[...f.baseEntries(), f.entry("refuted", 0)], /refuted\[0\]: a reversed refutation names its evidence in reason/],
  ];
  for (const [entries, re] of cases) {
    f.writeRecord(entries);
    mismatch(f.check(), re);
  }
  f.writeRecord(f.baseEntries(), "deadbeef");
  mismatch(f.check(), /record: the record answers head "deadbeef", not the review's/);
  rmSync(join(f.scratch, "dispositions-40.json"));
  mismatch(f.check(), /record: no disposition record at .*dispositions-40\.json/);
});

test("a re-check replaces the member's own verdict for the same head and never duplicates it", (t) => {
  const f = fixture(t);
  const bad = f.baseEntries();
  bad[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(bad);
  mismatch(f.check());
  f.writeRecord(f.baseEntries());
  okVerdict(f.check());
  okVerdict(f.check());
  const row = f.row();
  assert.equal(row.match(/dispositions-/g).length, 1, row);
  assert.ok(row.endsWith(` · dispositions-ok=fix-pr-40:${f.head}`), row);
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("nothing is judged or written when the review file or the git history cannot be read", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const before = f.row();
  rmSync(join(f.scratch, "review-40.json"));
  let r = f.check();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not read the review file/);
  f.writeReview({ ...f.review, counts: { ...f.review.counts, survived: 3 } });
  r = f.check();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /counts\.survived is 3, but survived holds 2/);
  f.writeReview();
  git(f.repo, "update-ref", "-d", "refs/remotes/origin/main");
  r = f.check();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not find the merge-base of origin\/main/);
  assert.equal(f.row(), before);
  r = f.check("finisher-pr-40");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /'finisher-pr-40' is not a fix-applier/);
});

test("an ambient GIT_DIR naming another repository does not change the answer", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { scope: "out", disposition: "defer" });
  f.writeRecord(entries);
  const r = f.check("fix-pr-40", { ...cleanEnv(), GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other });
  mismatch(r, /src\/a\.js:5 is a line the PR's diff touched/);
});

test("touchedLines reads new-side lines; pure deletions and deleted files touch none", () => {
  const diff = [
    "diff --git a/x b/x", "--- a/x", "+++ b/x",
    "@@ -3 +3 @@", "-o", "+n",
    "@@ -10,0 +11,2 @@", "+p", "+q",
    "@@ -20,2 +21,0 @@", "-r", "-s",
    "diff --git a/gone b/gone", "--- a/gone", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-t", "-u",
  ].join("\n");
  const t = touchedLines(diff);
  assert.deepEqual([...t.get("x")], [3, 11, 12]);
  assert.equal(t.has("gone"), false);
});

test("repoPath reads an absolute finding path relative to the snapshot or the repository", () => {
  assert.equal(repoPath("/snap/src/a.js", ["/snap", "/repo"]), "src/a.js");
  assert.equal(repoPath("/repo/src/a.js", ["/snap", "/repo"]), "src/a.js");
  assert.equal(repoPath("./src/a.js"), "src/a.js");
  assert.equal(repoPath("/elsewhere/a.js", ["/snap"]), "/elsewhere/a.js");
});

test("checkDispositions reads an absolute snapshot path onto the diff's touched lines", () => {
  const review = { head: "abc1234", survived: [{ file: "/snap/src/a.js", line: 5 }], unverified: [], refuted: [] };
  const record = { head: "abc1234", entries: [{ bucket: "survived", index: 0, scope: "out", claimKind: "behavior", disposition: "defer" }] };
  const touched = new Map([["src/a.js", new Set([5])]]);
  assert.equal(checkDispositions({ review, record, touched, roots: ["/snap"] }).length, 1);
  assert.equal(checkDispositions({ review, record, touched: new Map(), roots: ["/snap"] }).length, 0);
});

test("withVerdict replaces only the same member's verdict for the same head", () => {
  const H = "abc1234abc1234abc1234abc1234abc1234abcde";
  const ok = `dispositions-ok=fix-pr-40:${H}`;
  const bad = `dispositions-mismatch=fix-pr-40:${H}`;
  const other = `dispositions-ok=fix-pr-40-b:${H}`;
  const older = "dispositions-mismatch=fix-pr-40:def5678";
  assert.equal(withVerdict(`impl-10=PR#40 · ${bad}`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`impl-10=PR#40 · ${ok}`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`${bad} · impl-10=PR#40`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`impl-10=PR#40 · ${other} · ${older}`, ok), `impl-10=PR#40 · ${other} · ${older} · ${ok}`);
});
