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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { touchedLines, checkDispositions, withVerdict, repoPath, formatViolation } from "./dispositions-check.mjs";

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

  const check = (member = "fix-pr-40", env = cleanEnv(), script = SCRIPT, extra = []) => {
    const r = spawnSync(process.execPath, [script, "--member", member, "--scratch", scratch, "--repo", repo, "--ledger", ledger, ...extra],
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
  const again = f.check();
  okVerdict(again);
  assert.match(again.stderr, /row #10 already carries dispositions-ok=fix-pr-40:[0-9a-f]+ — not written again/);
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

// A standalone `/review-and-fix` has no controller and so no ledger: the run
// is from the worktree, `--ledger` is not given, and `.fleet/ledger.md` does
// not exist under its git common dir.
function standalone(f, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, ...extra],
    { encoding: "utf8", env: cleanEnv(), cwd: f.repo });
  return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null };
}

test("with no ledger the exit status is the verdict, and nothing is written to any ledger", (t) => {
  const f = fixture(t);
  const ledgerBefore = readFileSync(join(f.dir, "ledger.md"), "utf8");

  f.writeRecord(f.baseEntries());
  let r = standalone(f);
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.deepEqual(r.json.violations, []);

  const bad = f.baseEntries();
  bad[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(bad);
  r = standalone(f);
  mismatch(r, /^fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason/m);
  assert.equal(r.json.token, null);
  assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 0]]);

  rmSync(join(f.scratch, "dispositions-40.json"));
  mismatch(standalone(f), /record: no disposition record at .*dispositions-40\.json/);

  assert.equal(existsSync(join(f.repo, ".fleet")), false, "no .fleet/ was created");
  assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), ledgerBefore, "a ledger elsewhere is not this run's and is not touched");
});

test("an explicit --ledger naming no file is no ledger either, and is not created", (t) => {
  const f = fixture(t);
  const absent = join(f.dir, "absent", "ledger.md");
  f.writeRecord(f.baseEntries());
  okVerdict(standalone(f, "--repo", f.repo, "--ledger", absent));
  assert.equal(existsSync(join(f.dir, "absent")), false);
});

// Writes `f.repo`'s own `.fleet/ledger.md` with the member's row, as a fleet
// run's `ledger.mjs dispatch` leaves it, and returns its path.
function seedOwnLedger(f) {
  const ledger = join(f.repo, ".fleet", "ledger.md");
  const run = (...args) => {
    const r = spawnSync(process.execPath, [LEDGER, "--file", ledger, ...args], { encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  };
  run("row", "10", `impl-10=PR#40 → PR#40 · reviewed=${f.head}:2/1/1`);
  run("dispatch", "40", "fix-pr-40");
  run("settle", "fix-pr-40", `applied:${f.head.slice(0, 7)}`);
  return ledger;
}

test("the run's own .fleet/ledger.md is found without --ledger, and the verdict is written to it", (t) => {
  const f = fixture(t);
  const ledger = seedOwnLedger(f);
  f.writeRecord(f.baseEntries());
  const r = standalone(f);
  okVerdict(r);
  assert.equal(r.json.token, `dispositions-ok=fix-pr-40:${f.head}`);
  assert.match(readFileSync(ledger, "utf8"), new RegExp(`dispositions-ok=fix-pr-40:${f.head}`));
});

test("a ledger that exists is never skipped: one with no row for the member is a fault, not a standalone run", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other-ledger.md");
  const made = spawnSync(process.execPath, [LEDGER, "--file", other, "row", "11", "impl-11=PR#41 → PR#41"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(made.status, 0, made.stderr);
  const before = readFileSync(other, "utf8");
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--ledger", other);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /fix-pr-40 is on no row of PR #40/);
  assert.equal(readFileSync(other, "utf8"), before);
});

// A repository's `.fleet/ledger.md` outlives the fleet run that wrote it, and
// every worktree of the repository finds it through the git common dir.
function linkedWorktree(f) {
  const wt = join(f.dir, "wt");
  git(f.repo, "worktree", "add", "-q", "--detach", wt, f.head);
  return wt;
}

test("from a linked worktree the default ledger is the main checkout's, found through the git common dir", (t) => {
  const f = fixture(t);
  const wt = linkedWorktree(f);
  const ledger = seedOwnLedger(f);
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--repo", wt);
  okVerdict(r);
  assert.equal(r.json.token, `dispositions-ok=fix-pr-40:${f.head}`);
  assert.match(readFileSync(ledger, "utf8"), new RegExp(`dispositions-ok=fix-pr-40:${f.head}`));
  assert.equal(existsSync(join(wt, ".fleet")), false, "the worktree holds no ledger of its own");
});

test("--no-ledger is a standalone run whatever ledger the repository holds: a stale one is not a fault, and none is written", (t) => {
  const f = fixture(t);
  const wt = linkedWorktree(f);
  const stale = join(f.repo, ".fleet", "ledger.md");
  mkdirSync(join(f.repo, ".fleet"));
  const made = spawnSync(process.execPath, [LEDGER, "--file", stale, "row", "11", "impl-11=PR#41 → PR#41"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(made.status, 0, made.stderr);
  const before = readFileSync(stale, "utf8");
  f.writeRecord(f.baseEntries());

  const fault = standalone(f, "--repo", wt);
  assert.equal(fault.status, 2, fault.stderr);
  assert.match(fault.stderr, /fix-pr-40 is on no row of PR #40.*--no-ledger/);

  const r = standalone(f, "--repo", wt, "--no-ledger");
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.equal(readFileSync(stale, "utf8"), before);

  const bad = f.baseEntries();
  bad[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(bad);
  mismatch(standalone(f, "--repo", wt, "--no-ledger"), /^fix-pr-40: survived\[0\]/m);
});

test("--no-ledger leaves a ledger that holds the member's row unwritten, and contradicts --ledger", (t) => {
  const f = fixture(t);
  const ledger = seedOwnLedger(f);
  const before = readFileSync(ledger, "utf8");
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--no-ledger");
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.equal(readFileSync(ledger, "utf8"), before);

  const both = standalone(f, "--no-ledger", "--ledger", ledger);
  assert.equal(both.status, 2, both.stderr);
  assert.match(both.stderr, /--no-ledger and --ledger contradict/);
});

test("a ledger path that cannot be looked up is a fault, never a standalone run", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());

  // `.fleet` is a regular file, so `.fleet/ledger.md` fails ENOTDIR, not ENOENT.
  writeFileSync(join(f.repo, ".fleet"), "");
  let r = standalone(f);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not look for the ledger .*ledger\.md/);
  rmSync(join(f.repo, ".fleet"));

  // A dangling symlink is a ledger that cannot be read, not an absent one.
  mkdirSync(join(f.repo, ".fleet"));
  symlinkSync(join(f.dir, "nowhere.md"), join(f.repo, ".fleet", "ledger.md"));
  r = standalone(f);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(existsSync(join(f.dir, "nowhere.md")), false, "nothing was created through the link");
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

test("an ambient GIT_DIR naming another repository does not change which ledger is found", (t) => {
  const f = fixture(t);
  const ledger = seedOwnLedger(f);
  const other = join(f.dir, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  f.writeRecord(f.baseEntries());
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--repo", f.repo],
    { encoding: "utf8", env: cleanEnv({ GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }), cwd: f.dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).token, `dispositions-ok=fix-pr-40:${f.head}`);
  assert.match(readFileSync(ledger, "utf8"), new RegExp(`dispositions-ok=fix-pr-40:${f.head}`));
  assert.equal(existsSync(join(other, ".fleet")), false);
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

// A second PR commit on the fixture's repository: `files` written (paths
// relative to the repository), everything committed, and the review rewritten
// to answer the new head with `survived` as its only covered findings.
function advance(f, files, survived) {
  for (const [p, text] of Object.entries(files)) writeFileSync(join(f.repo, p), text);
  git(f.repo, "add", "-A");
  git(f.repo, "commit", "-qm", "pr 2");
  const head = git(f.repo, "rev-parse", "HEAD");
  f.writeReview({ ...f.review, head, counts: { ...f.review.counts, survived: survived.length, unverified: 0 }, survived, unverified: [] });
  return head;
}
const declaredOut = (f, n) => Array.from({ length: n }, (_, i) => f.entry("survived", i, { scope: "out", disposition: "defer" }));
const flagged = (r) => r.json.violations.map((v) => v.index);
const finding = (file, line) => ({ severity: "important", file, line, claim: "c", evidence: "e" });

test("a touched line is found whatever git prints around it: an added `++ ` line, a name with a space, a quoted name", (t) => {
  const f = fixture(t);
  const a = readFileSync(join(f.repo, "src", "a.js"), "utf8").split("\n");
  a[1] = "++ b/elsewhere"; // git prints this added line as `+++ b/elsewhere`
  a[17] = "a 18 changed";
  const head = advance(f, {
    "src/a.js": a.join("\n"),
    "src/my file.js": lines(5, "m"),
    'src/q"x.js': lines(3, "q"),
    "src/back\\slash.js": lines(2, "s"),
  }, [
    finding("src/a.js", 18), finding("src/my file.js", 3), finding('src/q"x.js', 2), finding("src/back\\slash.js", 1),
    finding("src/a.js", 10), // untouched: its declared scope stands
  ]);
  f.writeRecord(declaredOut(f, 5), head);
  const r = f.check();
  mismatch(r, /survived\[0\]: .*src\/a\.js:18 is a line the PR's diff touched/);
  assert.match(r.stderr, /survived\[1\]: .*src\/my file\.js:3 is a line the PR's diff touched/);
  assert.match(r.stderr, /survived\[2\]: .*src\/q"x\.js:2 is a line the PR's diff touched/);
  assert.match(r.stderr, /survived\[3\]: .*src\/back\\slash\.js:1 is a line the PR's diff touched/);
  assert.deepEqual(flagged(r), [0, 1, 2, 3]);
});

test("only the lines the diff changed are touched — no context lines, and a renamed file's unchanged lines are not", (t) => {
  const f = fixture(t);
  // Rename detection held by the check itself, not by a config default.
  git(f.repo, "config", "diff.renames", "false");
  const b = lines(10, "b").split("\n");
  b[2] = "b 3 changed";
  rmSync(join(f.repo, "src", "b.js"));
  const head = advance(f, { "src/c.js": b.join("\n") }, [
    finding("src/a.js", 8), // two lines past the fixture's change at 5-6: context under --unified=3
    finding("src/c.js", 7), // unchanged by the rename
    finding("src/c.js", 3), // changed: in scope
  ]);
  f.writeRecord(declaredOut(f, 3), head);
  const r = f.check();
  mismatch(r, /survived\[2\]: .*src\/c\.js:3 is a line the PR's diff touched/);
  assert.deepEqual(flagged(r), [2]);
});

test("run through a symlinked path, the check still judges and writes its verdict", (t) => {
  const f = fixture(t);
  const link = join(f.dir, "dispositions-check-link.mjs");
  symlinkSync(SCRIPT, link);
  f.writeRecord(f.baseEntries());
  okVerdict(f.check("fix-pr-40", cleanEnv(), link));
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.head}`), f.row());
  const bare = spawnSync(process.execPath, [link], { encoding: "utf8", env: cleanEnv() });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /usage: dispositions-check\.mjs/);
});

test("nothing is judged or written for a review finding that is no object, an unreadable record file or a stray argument", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const before = f.row();
  f.writeReview({ ...f.review, survived: [f.review.survived[0], null] });
  let r = f.check();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /review-40\.json has a survived\[1\] that is not a finding object/);
  f.writeReview();
  // A record path that exists and cannot be read is the environment's fault,
  // not a ruling the fix-applier wrote: no mismatch is blamed on it.
  rmSync(join(f.scratch, "dispositions-40.json"));
  mkdirSync(join(f.scratch, "dispositions-40.json"));
  r = f.check();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not read the disposition record .*dispositions-40\.json: EISDIR/);
  rmSync(join(f.scratch, "dispositions-40.json"), { recursive: true });
  f.writeRecord(f.baseEntries());
  r = f.check("fix-pr-40", cleanEnv(), SCRIPT, ["stray"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(f.row(), before);
  // The control: the same files and flags, nothing stray, are judged and written.
  okVerdict(f.check());
  assert.notEqual(f.row(), before);
});

// The pure core, on one review: survived[0] on touched src/a.js:5, one refuted finding.
const H40 = "abc1234abc1234abc1234abc1234abc1234abcde";
const core = (entries, { head = H40, reviewHead = H40, survived = [{ file: "src/a.js", line: 5 }], record } = {}) => checkDispositions({
  review: { head: reviewHead, survived, unverified: [], refuted: [{ file: "src/b.js", line: 1 }] },
  record: record === undefined ? { head, entries } : record,
  touched: new Map([["src/a.js", new Set([5])]]),
  roots: ["/snap"],
}).map(formatViolation);
const applied = { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" };

test("a record entry that is no object, names no position, or a record with no entries is a mismatch, never a crash", () => {
  assert.deepEqual(core([applied, { ...applied, index: -1 }]), ["survived[-1]: entries[1] names no finding — survived holds 1"]);
  assert.deepEqual(core([applied, null]), ["record: entries[1] is not an object"]);
  assert.deepEqual(core([applied, ["survived", 0]]), ["record: entries[1] is not an object"]);
  assert.deepEqual(core(null, { record: { head: H40 } }), [
    "record: the record is not {head, entries: [...]}", "survived[0]: no entry — a finding with no entry is a dropped finding",
  ]);
});

test("every optional field is held to its type, and a well-typed one passes", () => {
  const malformed = (more, msg) => assert.deepEqual(core([{ ...applied, ...more }]), [`survived[0]: malformed entry — ${msg}`]);
  malformed({ issue: 0 }, "issue is not an issue number");
  malformed({ issue: "7" }, "issue is not an issue number");
  malformed({ issue: 1.5 }, "issue is not an issue number");
  malformed({ reason: 5 }, "reason is not a string");
  malformed({ verdictPath: 1 }, "verdictPath is not a string");
  malformed({ remedyFiles: [1] }, "remedyFiles is not an array of paths");
  malformed({ remedyFiles: "src/a.js" }, "remedyFiles is not an array of paths");
  malformed({ claimKind: "both" }, 'claimKind "both" is not one of behavior|shape');
  malformed({ disposition: undefined }, "disposition null is not one of apply|defer");
  assert.deepEqual(core([{ ...applied, issue: 1, reason: "", verdictPath: "", remedyFiles: [] }]), []);
});

test("the record's head answers the review's as a prefix in either direction, never below seven hex", () => {
  assert.deepEqual(core([applied], { head: H40.slice(0, 7) }), []);
  assert.deepEqual(core([applied], { head: H40.toUpperCase() }), []);
  assert.deepEqual(core([applied], { reviewHead: H40.slice(0, 10) }), []);
  const stale = (head) => [`record: the record answers head ${JSON.stringify(head)}, not the review's ${H40}`];
  assert.deepEqual(core([applied], { head: "abc" }), stale("abc"));
  assert.deepEqual(core([applied], { head: "abc1235" }), stale("abc1235"));
});

test("a finding with a line and no file is in scope; a reversed refutation's whitespace reason names no evidence", () => {
  const out = { ...applied, scope: "out", disposition: "defer" };
  assert.match(core([out], { survived: [{ line: 5 }] })[0], /^survived\[0\]: .* it has no file, so it is in scope/);
  assert.deepEqual(core([applied, { ...applied, bucket: "refuted", reason: " \t" }]),
    ["refuted[0]: a reversed refutation names its evidence in reason, and this one names none"]);
});

test("an absolute path into a copy of the tree no root names is read by the touched file it ends in", () => {
  const out = { ...applied, scope: "out", disposition: "defer" };
  // A specialist's own copy of the snapshot, and a /tmp alias of a root.
  for (const file of ["/tmp/specialist-copy/src/a.js", "/private/snap/src/a.js"]) {
    assert.match(core([out], { survived: [{ file, line: 5 }] })[0] ?? "", /^survived\[0\]: .*src\/a\.js:5 is a line the PR's diff touched/, file);
  }
  // What it must accept: an untouched line, an untouched file, and a name
  // that only ends in a touched one mid-component.
  for (const [file, line] of [["/tmp/specialist-copy/src/a.js", 6], ["/tmp/specialist-copy/src/b.js", 5], ["/tmp/copy/notsrc/a.js", 5]]) {
    assert.deepEqual(core([out], { survived: [{ file, line }] }), [], file);
  }
  assert.equal(repoPath("/x/src/a.js", ["/snap"], ["a.js", "src/a.js"]), "src/a.js");
  assert.equal(repoPath("/x/notsrc/a.js", ["/snap"], ["src/a.js"]), "/x/notsrc/a.js");
  assert.equal(repoPath("./././src/a.js"), "src/a.js");
});

test("touchedLines reads an added `++ ` line as content and unquotes git's header names", () => {
  const diff = [
    "diff --git a/x b/x", "--- a/x", "+++ b/x",
    "@@ -2 +2 @@", "-l2", "+++ b/elsewhere",
    "@@ -25 +25 @@", "-l25", "+l25 changed",
    "diff --git a/my file b/my file", "--- a/my file\t", "+++ b/my file\t", "@@ -1 +1 @@", "-o", "+n",
    'diff --git "a/q\\"x" "b/q\\"x"', '--- "a/q\\"x"', '+++ "b/q\\"x"', "@@ -0,0 +1 @@", "+n",
    'diff --git "a/\\303\\251\\tt" "b/\\303\\251\\tt"', "--- /dev/null", '+++ "b/\\303\\251\\tt"', "@@ -0,0 +1 @@", "+n",
  ].join("\n");
  const t = touchedLines(diff);
  assert.deepEqual([...t.keys()], ["x", "my file", 'q"x', "é\tt"]);
  assert.deepEqual([...t.get("x")], [2, 25]);
});

test("withVerdict leaves a row already carrying only the token unchanged, folds an emptied row, and refuses a non-verdict token", () => {
  const ok = `dispositions-ok=fix-pr-40:${H40}`;
  assert.equal(withVerdict(ok, ok), ok);
  // Already the row's only verdict for that member and head: left where it sits.
  assert.equal(withVerdict(`${ok} · impl-10=PR#40`, ok), `${ok} · impl-10=PR#40`);
  assert.equal(withVerdict(`dispositions-mismatch=fix-pr-40:${H40}`, ok), ok);
  assert.equal(withVerdict(`· dispositions-mismatch=fix-pr-40:${H40} ·`, ok), ok);
  assert.throws(() => withVerdict(`impl-10=PR#40 · ${ok}`, "garbage"), /'garbage' is not a dispositions-ok=\/dispositions-mismatch= token/);
});
