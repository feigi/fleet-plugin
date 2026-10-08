// dispositions-check.mjs: a review fix-applier's disposition record judged
// against the review file and the PR's diff, its verdict written onto the
// ledger, and `ledger.mjs dispatch` then gating the finisher on it.
//
// Every CLI case runs against a real git repository built in a temp dir —
// `origin/main` a ref, the PR head one commit past it — so the touched lines
// are git's own answer, not a fixture's restatement of one. The tracker is a
// `gh` stub first on PATH, answering `issue view` from a JSON file the
// fixture writes: no case reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRun } from "../plugin/scripts/fleet-tick.mjs";
import {
  touchedLines, checkDispositions, withVerdict, repoPath, formatViolation, failedBefore, verdictProblem, recordTitle, FILING_ROWS,
} from "../plugin/scripts/dispositions-check.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/dispositions-check.mjs", import.meta.url));
const LEDGER = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

// The `gh` stub: `issue view <n> --json labels,state,title` answered from
// FAKE_GH_ISSUES, an issue it does not hold answered the way gh answers one
// that does not exist. FAKE_GH_DOWN answers every call as an unreachable API.
// FAKE_GH_LOG, when set, gets one line per call: its argv, cwd and GIT_DIR.
const GH_STUB = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const { FAKE_GH_ISSUES, FAKE_GH_DOWN, FAKE_GH_LOG } = process.env;
if (FAKE_GH_LOG) fs.appendFileSync(FAKE_GH_LOG, JSON.stringify({ argv, cwd: process.cwd(), GIT_DIR: process.env.GIT_DIR ?? null }) + "\\n");
if (FAKE_GH_DOWN) { process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
const [cmd, sub, n, flag, fields] = argv;
if (argv.length !== 5 || cmd !== "issue" || sub !== "view" || flag !== "--json" || fields !== "labels,state,title") {
  process.stderr.write("gh stub: unexpected call " + JSON.stringify(argv) + "\\n");
  process.exit(2);
}
const issue = JSON.parse(fs.readFileSync(FAKE_GH_ISSUES, "utf8"))[n];
if (!issue) {
  process.stderr.write("GraphQL: Could not resolve to an issue or pull request with the number of " + n + ". (repository.issue)\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ labels: issue.labels.map((name) => ({ name })), state: issue.state, title: issue.title }));
`;
const openIssue = (label) => ({ state: "OPEN", title: "a deferred finding", labels: [label] });
const bandRecord = (pr = 40) => ({ state: "CLOSED", title: recordTitle(pr), labels: ["wontfix"] });

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
  // Every finding answered, every in-scope survivor applied, the out-of-scope
  // suggestion filed open `needs-triage` (row 6): an ok record.
  const baseEntries = () => [entry("survived", 0), entry("survived", 1), entry("unverified", 0, { scope: "out", disposition: "defer", issue: 77 })];
  const writeRecord = (entries, recHead = head) =>
    writeFileSync(join(scratch, "dispositions-40.json"), JSON.stringify({ head: recHead, entries }));

  // The tracker the `gh` stub answers from, issue number → {state, title, labels}.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });
  const issuesFile = join(dir, "issues.json");
  // 77 is the base record's row-6 home; 81 the row-1 home a deferred survivor
  // in these cases is filed to.
  const issues = { 77: openIssue("needs-triage"), 81: openIssue("ready-for-agent") };
  const setIssues = (more) => {
    Object.assign(issues, more);
    writeFileSync(issuesFile, JSON.stringify(issues));
  };
  setIssues({});
  // Any env, with the stub first on PATH.
  const env = (base = cleanEnv(), extra = {}) => ({ ...base, PATH: `${bin}:${base.PATH ?? ""}`, FAKE_GH_ISSUES: issuesFile, ...extra });
  // A refuter verdict under the fix-applier's run root, as step 2 writes it;
  // `value` an object written as JSON, or a string written as it stands.
  const writeVerdict = (value, finding = "1", runRoot = join(scratch, "pr40", "fix-Ab12Cd34")) => {
    const path = join(runRoot, finding, "verdict.json");
    mkdirSync(join(runRoot, finding), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  const check = (member = "fix-pr-40", base = cleanEnv(), script = SCRIPT, extra = []) => {
    const r = spawnSync(process.execPath, [script, "--member", member, "--scratch", scratch, "--repo", repo, "--ledger", ledger, ...extra],
      { encoding: "utf8", env: env(base), cwd: dir });
    return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null };
  };
  const row = () => okLedger("read").rows.find((r) => r.startsWith("#10 "));
  return {
    dir, repo, head, scratch, review, writeReview, entry, baseEntries, writeRecord, check, row, ledgerCli, okLedger,
    env, setIssues, writeVerdict,
  };
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
    f.setIssues({ 81: reason === "false-rationale" ? bandRecord() : openIssue("ready-for-agent") });
    entries[0] = f.entry("survived", 0, { disposition: "defer", reason, issue: 81 });
    f.writeRecord(entries);
    okVerdict(f.check());
    assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.head}`), `${reason}: ${f.row()}`);
    assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher", reason);
  }
});

test("any other reason is a mismatch", (t) => {
  const f = fixture(t);
  for (const reason of ["outside-ticket-files", ""]) {
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
  out[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", issue: 81 });
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
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", issue: 81 });
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
  f.setIssues({ 13: bandRecord() });
  f.writeRecord([
    f.entry("survived", 0),
    f.entry("survived", 1, { scope: "out", claimKind: "shape", disposition: "defer", issue: 13 }),
    f.entry("unverified", 0, { disposition: "defer", reason: "anything", issue: 13, verdictPath: f.writeVerdict({ refuted: true, reason: "r" }) }),
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

// A first mismatch is retried by `fix-pr-<M>-b`; a second on the same review
// is written as an escalate, which keeps the finisher refused and is the end
// of the automatic path.
const badRecord = (f) => {
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer" });
  return entries;
};
const retry = (f, name = "fix-pr-40-b") => {
  f.okLedger("dispatch", "40", name);
  f.okLedger("settle", name, `applied:${f.head.slice(0, 7)}`);
};

test("a second mismatch on the same review writes dispositions-escalate, and the finisher stays refused", (t) => {
  const f = fixture(t);
  f.writeRecord(badRecord(f));
  mismatch(f.check());
  retry(f);
  const r = f.check("fix-pr-40-b");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.verdict, "escalate");
  assert.equal(r.json.token, `dispositions-escalate=fix-pr-40-b:${f.head}`);
  assert.match(r.stderr, /^fix-pr-40-b: survived\[0\]: an in-scope survived finding deferred with no reason/m, "the violations are still printed");
  const row = f.row();
  assert.ok(row.includes(`dispositions-mismatch=fix-pr-40:${f.head}`) && row.includes(`dispositions-escalate=fix-pr-40-b:${f.head}`), row);
  const d = f.ledgerCli("dispatch", "40", "finisher-pr-40");
  assert.equal(d.status, 2);
  assert.match(d.stderr, /finisher-pr-40: dispositions escalate — fix-pr-40-b deferred .*second mismatch/);
  // Re-running the escalated member's check is idempotent.
  const again = f.check("fix-pr-40-b");
  assert.equal(again.json.verdict, "escalate");
  assert.equal(f.row().match(/dispositions-escalate=/g).length, 1, f.row());
});

test("the retry that passes the check ends the refusal, and the first mismatch stays on the row unread", (t) => {
  const f = fixture(t);
  f.writeRecord(badRecord(f));
  mismatch(f.check());
  retry(f);
  f.writeRecord(f.baseEntries());
  okVerdict(f.check("fix-pr-40-b"));
  assert.ok(f.row().includes(`dispositions-mismatch=fix-pr-40:${f.head}`), "the first fix-applier's verdict is kept");
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("the first mismatch is a plain mismatch, and a mismatch on an earlier review does not count toward a later one", (t) => {
  const f = fixture(t);
  f.writeRecord(badRecord(f));
  const first = f.check();
  assert.equal(first.json.verdict, "mismatch");
  assert.equal(first.json.token, `dispositions-mismatch=fix-pr-40:${f.head}`);
  // The earlier fix-applier's mismatch answered another review's head.
  retry(f);
  f.okLedger("row", "10", f.row().slice(4).replace(`dispositions-mismatch=fix-pr-40:${f.head}`, "dispositions-mismatch=fix-pr-40:deadbee1"));
  const second = f.check("fix-pr-40-b");
  assert.equal(second.json.verdict, "mismatch", second.stderr);
});

test("a mismatch from a later suffix, an ok, or another PR's fix-applier is not an earlier failure", () => {
  const H = "abc1234";
  const row = (...tokens) => `#10 impl-10=PR#40 → PR#40 · reviewed=${H}:1/0/0 · ${tokens.join(" · ")}`;
  const b = { retry: "b" };
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:${H}`)], 40, b, H), true);
  assert.equal(failedBefore([row(`dispositions-escalate=fix-pr-40:${H}`)], 40, b, H), true);
  assert.equal(failedBefore([row(`dispositions-ok=fix-pr-40:${H}`)], 40, b, H), false, "an ok is no failure");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40-c:${H}`)], 40, b, H), false, "a later suffix is not earlier");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40-b:${H}`)], 40, b, H), false, "the member itself is not earlier");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:${H}`)], 40, { retry: null }, H), false, "nor is the first fix-applier's own re-run");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:fedcba9`)], 40, b, H), false, "another review's head");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-41:${H}`)], 40, b, H), false, "another PR's fix-applier");
  // A split row: the earlier verdict sits on another row that resolves to PR 40.
  assert.equal(failedBefore(["#11 impl-11=PR#40 → PR#40 · dispositions-mismatch=fix-pr-40:abc1234", "#12 impl-12=PR#41 → PR#41"], 40, b, H), true);
  // A copy of PR 40's verdict on PR 41's row is a stray: that row does not resolve to PR 40.
  assert.equal(failedBefore(["#12 impl-12=PR#41 → PR#41 · dispositions-mismatch=fix-pr-40:abc1234"], 40, b, H), false);
  // The same review named by a short head on one side and a full SHA on the other.
  const full = `${H}${"0".repeat(33)}`;
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:${H}`)], 40, b, full), true, "an earlier token's short head matches a full check head");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:${full}`)], 40, b, H), true, "an earlier token's full head matches a short check head");
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
    { encoding: "utf8", env: f.env(), cwd: f.repo });
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
  assert.equal(r.stderr, "", "no --ledger and no default ledger is a standalone run that prints nothing");

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

test("an explicit --ledger naming no file is no ledger either: the default ledger is not borrowed, nothing is created, and stderr says so", (t) => {
  const f = fixture(t);
  const own = seedOwnLedger(f);
  const ownBefore = readFileSync(own, "utf8");
  const absent = join(f.dir, "absent", "ledger.md");
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--repo", f.repo, "--ledger", absent);
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.equal(readFileSync(own, "utf8"), ownBefore);
  assert.equal(existsSync(join(f.dir, "absent")), false);
  const lines = r.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(lines[0].startsWith(`dispositions-check: no ledger at ${absent} `), lines[0]);
  assert.match(lines[0], /no token was written.*--no-ledger/);

  // A --ledger that exists is used, and draws no such note.
  const present = standalone(f, "--repo", f.repo, "--ledger", own);
  okVerdict(present);
  assert.equal(present.json.token, `dispositions-ok=fix-pr-40:${f.head}`);
  assert.doesNotMatch(present.stderr, /no ledger at/);
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
  assert.equal(r.stderr, "", "--no-ledger is a chosen standalone run and prints nothing");
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
  assert.equal(r.stderr, "");
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

// The default ledger is looked up through fleet-dir.mjs's fleetFile(), and a
// failure of that lookup refuses at exit 2 with ITS message: what failed and
// git's reason. The repository is a real one (the merge-base probes before it
// answer), so the shim refuses only the `--git-common-dir` question.
test("a default ledger whose location cannot be resolved is a fault naming the failed resolution and its reason", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const shimDir = join(f.dir, "git-shim");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "git"),
    `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) echo "shim-refusal" >&2; exit 1 ;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--repo", f.repo],
    { encoding: "utf8", env: f.env({ ...cleanEnv(), PATH: `${shimDir}:${process.env.PATH}` }), cwd: f.dir });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /dispositions-check: could not resolve --git-common-dir: shim-refusal/);
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
    { encoding: "utf8", env: f.env({ ...cleanEnv(), GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }), cwd: f.dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).token, `dispositions-ok=fix-pr-40:${f.head}`);
  assert.match(readFileSync(ledger, "utf8"), new RegExp(`dispositions-ok=fix-pr-40:${f.head}`));
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
  const record = { head: "abc1234", entries: [{ bucket: "survived", index: 0, scope: "out", claimKind: "behavior", disposition: "defer", issue: 9 }] };
  const touched = new Map([["src/a.js", new Set([5])]]);
  const filing = { pr: 40, issue: () => ({ state: "OPEN", title: "a deferred finding", labels: ["ready-for-agent"] }) };
  assert.equal(checkDispositions({ review, record, touched, roots: ["/snap"], filing }).violations.length, 1);
  assert.equal(checkDispositions({ review, record, touched: new Map(), roots: ["/snap"], filing }).violations.length, 0);
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
const declaredOut = (f, n) => Array.from({ length: n }, (_, i) => f.entry("survived", i, { scope: "out", disposition: "defer", issue: 81 }));
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
// `issues` the tracker by number — an issue it does not hold is an open
// `ready-for-agent` one — and `verdicts` the refuter verdicts by path.
const coreRun = (entries, {
  head = H40, reviewHead = H40, survived = [{ file: "src/a.js", line: 5 }], unverified = [], record, diffFiles = ["src/a.js"],
  issues = {}, verdicts = {},
} = {}) => checkDispositions({
  review: { head: reviewHead, survived, unverified, refuted: [{ file: "src/b.js", line: 1 }] },
  record: record === undefined ? { head, entries } : record,
  touched: new Map([["src/a.js", new Set([5])]]),
  diffFiles,
  roots: ["/snap"],
  filing: {
    pr: 40,
    issue: (n) => issues[n] ?? { state: "OPEN", title: "a deferred finding", labels: ["ready-for-agent"] },
    verdict: (p) => verdicts[p] ?? { problem: "names no file that exists" },
  },
});
const core = (entries, opts) => coreRun(entries, opts).violations.map(formatViolation);
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
  const out = { ...applied, scope: "out", disposition: "defer", issue: 9 };
  assert.match(core([out], { survived: [{ line: 5 }] })[0], /^survived\[0\]: .* it has no file, so it is in scope/);
  assert.deepEqual(core([applied, { ...applied, bucket: "refuted", reason: " \t" }]),
    ["refuted[0]: a reversed refutation names its evidence in reason, and this one names none"]);
});

test("an absolute path into a copy of the tree no root names is read by the touched file it ends in", () => {
  const out = { ...applied, scope: "out", disposition: "defer", issue: 9 };
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
  assert.throws(() => withVerdict(`impl-10=PR#40 · ${ok}`, "garbage"), /'garbage' is not a dispositions-ok=\/dispositions-mismatch=\/dispositions-escalate=\/dispositions-unchecked= token/);
});

// ---------------------------------------------------------------------------
// remedy-outside-diff: a deferral whose remedy lies in a file the PR's diff
// does not name. In the fixture src/a.js is in the PR's diff and src/b.js is
// not.
// ---------------------------------------------------------------------------

const escalated = (r) => {
  assert.equal(r.status, 1, `expected an escalation, got exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.verdict, "escalate");
};
// survived[0], on touched line 5, deferred remedy-outside-diff.
const deferOutside = (f, remedyFiles, recHead) => {
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer", reason: "remedy-outside-diff", issue: 81, remedyFiles });
  f.writeRecord(entries, recHead);
};
const withSeverity = (f, severity) => f.writeReview({ ...f.review, survived: [{ ...f.review.survived[0], severity }, f.review.survived[1]] });
// The same review row with no fix-applier landed on it is fix-due: the control
// that shows fixDueFor can see a PR become fix-due at all.
const dueUntilFixed = (f) => deriveRun({ rows: [`#10 impl-10=PR#40 → PR#40 · reviewed=${f.head}:2/1/1`], dispatched: [], drain: null },
  [{ number: 40, labels: [], closingIssuesReferences: [{ number: 10 }] }]).fixDue;
const fixDueFor = (f) => {
  const l = f.okLedger("read");
  return deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null }, [{ number: 40, labels: [], closingIssuesReferences: [{ number: 10 }] }]).fixDue;
};

test("a suggestion deferred remedy-outside-diff, its remedy in a file the diff lacks, passes as ok and lets the finisher dispatch", (t) => {
  const f = fixture(t);
  withSeverity(f, "suggestion");
  deferOutside(f, ["src/b.js"]);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.escalations, []);
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.head}`), f.row());
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("a critical or important finding deferred remedy-outside-diff writes dispositions-escalate, refuses the finisher by name and never makes the PR fix-due", (t) => {
  for (const severity of ["important", "critical"]) {
    const f = fixture(t);
    withSeverity(f, severity);
    deferOutside(f, ["src/a.js", "src/b.js"]);
    const r = f.check();
    escalated(r);
    assert.deepEqual(r.json.violations, []);
    assert.deepEqual(r.json.escalations, [{ bucket: "survived", index: 0, severity, files: ["src/b.js"] }]);
    assert.equal(r.json.token, `dispositions-escalate=fix-pr-40:${f.head}`);
    assert.match(r.stderr, new RegExp(`^fix-pr-40: survived\\[0\\]: a ${severity} finding deferred remedy-outside-diff, its remedy in src/b\\.js — a human rules$`, "m"));
    assert.ok(f.row().includes(`dispositions-escalate=fix-pr-40:${f.head}`), f.row());

    const before = readFileSync(join(f.dir, "ledger.md"), "utf8");
    const d = f.ledgerCli("dispatch", "40", "finisher-pr-40");
    assert.equal(d.status, 2, severity);
    assert.match(d.stderr, /finisher-pr-40: dispositions escalate — fix-pr-40 deferred/);
    assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), before, "a refused dispatch writes nothing");
    assert.deepEqual(dueUntilFixed(f), [40], "control");
    assert.deepEqual(fixDueFor(f), [], `${severity}: an escalation is a human's, never a fix-pr dispatch`);
  }
});

test("remedy-outside-diff whose remedy files are all in the PR's diff, or none, is a mismatch — a suggestion's included", (t) => {
  const f = fixture(t);
  for (const severity of ["important", "suggestion"]) {
    withSeverity(f, severity);
    for (const remedyFiles of [["src/a.js"], ["./src/a.js"], [join(f.repo, "src/a.js")], [" src/a.js "], ["src//a.js"], ["src/../src/a.js"], ["./src/../src/a.js", " "], [], [""], undefined]) {
      deferOutside(f, remedyFiles);
      const r = f.check();
      mismatch(r, /^fix-pr-40: survived\[0\]: reason remedy-outside-diff needs a remedy file absent from the PR's diff — /m);
      assert.deepEqual(r.json.escalations, [], `${severity} ${JSON.stringify(remedyFiles)}`);
      assert.ok(f.row().includes(`dispositions-mismatch=fix-pr-40:${f.head}`), f.row());
    }
  }
  deferOutside(f, ["src/a.js"]);
  assert.match(f.check().stderr, /every file remedyFiles names is in the PR's diff/);
  deferOutside(f, []);
  assert.match(f.check().stderr, /remedyFiles names no file/);
});

test("a file the PR deleted or moved away is in the PR's diff, so a remedy naming only it is a mismatch", (t) => {
  const f = fixture(t);
  git(f.repo, "rm", "-q", "src/b.js");
  git(f.repo, "mv", "src/a.js", "src/c.js");
  git(f.repo, "commit", "-qm", "pr 2: delete b, move a");
  const head = git(f.repo, "rev-parse", "HEAD");
  f.writeReview({ ...f.review, head, survived: [{ severity: "suggestion", claim: "c", evidence: "e" }, f.review.survived[1]] });
  for (const remedyFiles of [["src/b.js"], ["src/a.js"], ["src/c.js"]]) {
    deferOutside(f, remedyFiles, head);
    mismatch(f.check(), /reason remedy-outside-diff needs a remedy file absent from the PR's diff/);
  }
  // The control: a file the PR never touched is outside it.
  git(f.repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
  deferOutside(f, ["src/never.js"], head);
  okVerdict(f.check());
});

test("a record that breaks a rule is a mismatch even when it also escalates, and prints both", (t) => {
  const f = fixture(t);
  withSeverity(f, "critical");
  deferOutside(f, ["src/b.js"]);
  const rec = JSON.parse(readFileSync(join(f.scratch, "dispositions-40.json"), "utf8"));
  f.writeRecord(rec.entries.filter((e) => !(e.bucket === "survived" && e.index === 1)));
  const r = f.check();
  mismatch(r, /^fix-pr-40: survived\[1\]: no entry/m);
  assert.match(r.stderr, /^fix-pr-40: survived\[0\]: a critical finding deferred remedy-outside-diff/m);
  assert.equal(r.json.token, `dispositions-mismatch=fix-pr-40:${f.head}`);
});

test("an escalation outranks an issue gh cannot read: the verdict is escalate, a human rules, and the unread issue is still reported", (t) => {
  const f = fixture(t);
  withSeverity(f, "critical");
  deferOutside(f, ["src/b.js"]);
  const entries = JSON.parse(readFileSync(join(f.scratch, "dispositions-40.json"), "utf8")).entries;
  entries[2] = f.entry("unverified", 0, { scope: "out", disposition: "defer", issue: 404 });
  f.writeRecord(entries);
  const r = f.check();
  escalated(r);
  assert.equal(r.json.token, `dispositions-escalate=fix-pr-40:${f.head}`);
  assert.match(r.stderr, /^fix-pr-40: survived\[0\]: a critical finding deferred remedy-outside-diff/m);
  assert.match(r.stderr, /unverified\[0\]: where it was filed is unchecked — #404 could not be read through gh/);
});

test("a re-check after an escalation replaces it with the member's new verdict, and the finisher then dispatches", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  f.writeRecord(f.baseEntries());
  okVerdict(f.check());
  const row = f.row();
  assert.equal(row.match(/dispositions-/g).length, 1, row);
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("an out-of-scope deferral, an unverified one and an applied remedy need no remedy file and escalate nothing", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", reason: "remedy-outside-diff", issue: 81 });
  entries[2] = f.entry("unverified", 0, { scope: "out", disposition: "defer", reason: "remedy-outside-diff", issue: 13 });
  f.setIssues({ 13: openIssue("needs-triage") });
  f.writeRecord(entries);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.escalations, []);
});

test("checkDispositions: escalation is every severity but suggestion, a missing severity included; diffFiles is required when a deferral needs it", () => {
  const entry = { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "defer", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"], issue: 81 };
  for (const [severity, expected] of [["critical", 1], ["important", 1], [undefined, 1], ["suggestion", 0]]) {
    const r = coreRun([entry], { survived: [{ file: "src/a.js", line: 5, severity }] });
    assert.deepEqual(r.violations, [], String(severity));
    assert.equal(r.escalations.length, expected, String(severity));
  }
  assert.deepEqual(coreRun([entry], { survived: [{ file: "src/a.js", line: 5, severity: "important" }] }).escalations,
    [{ bucket: "survived", index: 0, severity: "important", files: ["src/b.js"] }]);
  assert.throws(() => coreRun([entry], { diffFiles: null }), /no diffFiles was given/);
  // A remedy the other reasons never read: no diffFiles needed.
  assert.deepEqual(coreRun([{ ...entry, reason: "remedy-worse" }], { diffFiles: null }).violations, []);
});

test("withVerdict replaces an escalation with the same member's later verdict for the head, and an escalation for an ok", () => {
  const esc = `dispositions-escalate=fix-pr-40:${H40}`;
  const ok = `dispositions-ok=fix-pr-40:${H40}`;
  assert.equal(withVerdict(`impl-10=PR#40 · ${esc}`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`impl-10=PR#40 · ${ok}`, esc), `impl-10=PR#40 · ${esc}`);
});

// ---------------------------------------------------------------------------
// The filing table: where each deferral was filed, read back from the
// tracker, and the refuter verdict an in-scope suggestion carries.
// ---------------------------------------------------------------------------

// The core's review for the table: survived[0] on touched src/a.js:5;
// survived[1] a critical finding on untouched src/a.js:30; unverified[0] a
// finding whose refuters crashed; unverified[1] a suggestion on touched
// src/a.js:5, so in scope; unverified[2] a suggestion on an untouched line;
// refuted[0] the core's refuted finding.
const TABLE_SURVIVED = [{ file: "src/a.js", line: 5 }, { file: "src/a.js", line: 30, severity: "critical" }];
const TABLE_UNVERIFIED = [
  { file: "src/a.js", line: 9, severity: "important", refutersDispatched: 2 },
  { file: "src/a.js", line: 5, severity: "suggestion", refutersDispatched: 0 },
  { file: "src/a.js", line: 30, severity: "suggestion", refutersDispatched: 0 },
];
const REFUTED_V = "/scratch/pr40/fix-Ab12Cd34/2/verdict.json";
const STOOD_V = "/scratch/pr40/fix-Ab12Cd34/3/verdict.json";
const TABLE_VERDICTS = { [REFUTED_V]: { refuted: true }, [STOOD_V]: { refuted: false } };
const OPEN_RFA = { state: "OPEN", title: "a deferred finding", labels: ["ready-for-agent"] };
const OPEN_NT = { state: "OPEN", title: "a deferred finding", labels: ["needs-triage"] };
const RECORD = { state: "CLOSED", title: "PR #40 review: the suggestion band, checked", labels: ["wontfix"] };
const closed = (issue) => ({ ...issue, state: "CLOSED" });
const reopened = (issue) => ({ ...issue, state: "OPEN" });
const BOTH = { ...OPEN_RFA, labels: ["ready-for-agent", "needs-triage"] };
// Every finding of the table's review answered without a deferral, `entry`
// standing in for the one it names.
const tableRun = (entry, issues = {}) => {
  const fill = [
    { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" },
    { bucket: "survived", index: 1, scope: "out", claimKind: "behavior", disposition: "apply" },
    { bucket: "unverified", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" },
    { bucket: "unverified", index: 1, scope: "in", claimKind: "behavior", disposition: "apply", verdictPath: STOOD_V },
    { bucket: "unverified", index: 2, scope: "out", claimKind: "behavior", disposition: "apply" },
  ];
  const answered = fill.some((e) => e.bucket === entry.bucket && e.index === entry.index);
  return coreRun(answered ? fill.map((e) => (e.bucket === entry.bucket && e.index === entry.index ? entry : e)) : [...fill, entry],
    { survived: TABLE_SURVIVED, unverified: TABLE_UNVERIFIED, issues, verdicts: TABLE_VERDICTS });
};
const tableCore = (entry, issues) => tableRun(entry, issues).violations.map(formatViolation);
const deferred = (bucket, index, more = {}) => ({ bucket, index, scope: "in", claimKind: "behavior", disposition: "defer", issue: 9, ...more });

// Each row: its entry, its home, and homes that break it — the wrong label and
// the wrong state among them.
const ROWS = [
  [1, deferred("survived", 0, { reason: "mutual-exclusion" }), OPEN_RFA,
    [["labelled needs-triage", OPEN_NT], ["closed", closed(OPEN_RFA)], ["carrying both triage labels", BOTH]]],
  [2, deferred("survived", 0, { reason: "false-rationale" }), RECORD,
    [["labelled needs-triage, not wontfix", { ...RECORD, labels: ["needs-triage"] }], ["open", reopened(RECORD)],
      ["another PR's record", { ...RECORD, title: "PR #41 review: the suggestion band, checked" }]]],
  [3, deferred("unverified", 0), OPEN_NT, [["labelled nothing", { ...OPEN_NT, labels: [] }], ["closed", closed(OPEN_NT)], ["carrying both triage labels", BOTH]]],
  [4, deferred("unverified", 1, { verdictPath: REFUTED_V }), RECORD, [["labelled needs-triage, not wontfix", { ...RECORD, labels: ["needs-triage"] }], ["open", OPEN_NT]]],
  [5, deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-worse" }), OPEN_RFA, [["labelled needs-triage", OPEN_NT], ["closed", closed(OPEN_RFA)]]],
  [6, deferred("unverified", 2, { scope: "out" }), OPEN_NT, [["labelled nothing", { ...OPEN_NT, labels: [] }], ["closed", closed(OPEN_NT)], ["carrying both triage labels", BOTH]]],
  [7, deferred("survived", 0, { claimKind: "shape", reason: "remedy-worse" }), RECORD,
    [["labelled needs-triage, not wontfix", { ...RECORD, labels: ["needs-triage"] }], ["open", reopened(RECORD)]]],
  // false-rationale is row 2's reason only in scope: out of scope it is row 8.
  [8, deferred("survived", 1, { scope: "out", reason: "false-rationale" }), OPEN_RFA,
    [["labelled needs-triage", OPEN_NT], ["closed", closed(OPEN_RFA)], ["the closed suggestion-band record", RECORD], ["carrying both triage labels", BOTH]]],
];
for (const [n, entry, home, wrong] of ROWS) {
  test(`filing row ${n}: its home passes, and the wrong label or the wrong state is a mismatch naming the row`, () => {
    assert.deepEqual(tableCore(entry, { 9: home }), [], "its home");
    for (const [what, issue] of wrong) {
      const v = tableCore(entry, { 9: issue });
      assert.equal(v.length, 1, `${what}: ${v}`);
      assert.match(v[0], new RegExp(`^${entry.bucket}\\[${entry.index}\\]: filing row ${n} \\(${FILING_ROWS[n].finding}\\): it belongs in .*, and #9 is `), what);
    }
  });
}

test("filing row 7 outranks every row but row 4: a shape claim's deferral is filed to the closed record whatever its state", () => {
  for (const entry of [deferred("survived", 0, { claimKind: "shape", reason: "false-rationale" }), deferred("unverified", 0, { claimKind: "shape" }),
    deferred("unverified", 1, { claimKind: "shape", verdictPath: STOOD_V }), deferred("unverified", 2, { scope: "out", claimKind: "shape" }),
    deferred("survived", 1, { scope: "out", claimKind: "shape" }), deferred("survived", 1, { scope: "out", claimKind: "shape", reason: "false-rationale" }),
    deferred("refuted", 0, { scope: "out", claimKind: "shape", reason: "re-ran the probe" })]) {
    assert.deepEqual(tableCore(entry, { 9: RECORD }), [], JSON.stringify(entry));
    assert.match(tableCore(entry, { 9: OPEN_NT })[0], /: filing row 7 \(/, JSON.stringify(entry));
    assert.match(tableCore(entry, { 9: OPEN_RFA })[0], /: filing row 7 \(/, JSON.stringify(entry));
  }
  // A refuted suggestion is row 4 whatever its claimKind; the home is the same.
  assert.match(tableCore(deferred("unverified", 1, { claimKind: "shape", verdictPath: REFUTED_V }), { 9: OPEN_NT })[0], /: filing row 4 \(/);
});

test("filing row 3 outranks row 6: a crashed unverified finding is named row 3 though it is out of scope", () => {
  const entry = deferred("unverified", 0, { scope: "out" });
  assert.deepEqual(tableCore(entry, { 9: OPEN_NT }), []);
  assert.match(tableCore(entry, { 9: closed(OPEN_NT) })[0], /^unverified\[0\]: filing row 3 \(/);
  assert.match(tableCore(entry, { 9: RECORD })[0], /^unverified\[0\]: filing row 3 \(/);
});

test("an out-of-scope survivor is filed open ready-for-agent whatever its reason, and escalates nothing at any severity", () => {
  for (const reason of [undefined, "", "false-rationale", "mutual-exclusion", "remedy-worse", "remedy-outside-diff", "outside-ticket-files"]) {
    const r = tableRun(deferred("survived", 1, { scope: "out", reason }), { 9: OPEN_RFA });
    assert.deepEqual([r.violations, r.escalations, r.unchecked], [[], [], []], String(reason));
  }
  // survived[1] is critical, and its remedy sits outside the diff: still no escalation.
  const r = tableRun(deferred("survived", 1, { scope: "out", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"] }), { 9: OPEN_RFA });
  assert.deepEqual([r.violations, r.escalations], [[], []]);
  // Declared out on a touched line it is in scope, so false-rationale is row 2's, not row 8's.
  assert.match(tableCore(deferred("survived", 0, { scope: "out", reason: "false-rationale" }), { 9: OPEN_RFA })[0], /^survived\[0\]: filing row 2 \(/);
});

test("an open ready-for-agent issue answers a needs-triage row; an open needs-triage one never answers a ready-for-agent row", () => {
  for (const entry of [deferred("unverified", 0), deferred("unverified", 2, { scope: "out" })]) {
    assert.deepEqual(tableCore(entry, { 9: OPEN_RFA }), [], JSON.stringify(entry));
  }
  for (const entry of [deferred("survived", 0, { reason: "mutual-exclusion" }), deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-worse" }),
    deferred("survived", 1, { scope: "out" })]) {
    assert.match(tableCore(entry, { 9: OPEN_NT })[0] ?? "",
      /: filing row [158] \(.*\): it belongs in an open issue labelled ready-for-agent, and #9 is open, titled "a deferred finding", labelled needs-triage$/, JSON.stringify(entry));
  }
});

test("a deferral no filing-table row holds is a mismatch naming no filing-table row, never a pass", () => {
  const reversed = deferred("refuted", 0, { scope: "out", reason: "re-ran the probe" });
  const rule = "refuted[0]: no filing-table row holds a deferred refuted finding, scope out, claimKind behavior — the table names no home for it";
  for (const home of [OPEN_RFA, OPEN_NT, RECORD]) assert.deepEqual(tableCore(reversed, { 9: home }), [rule], JSON.stringify(home));
  const { issue: _, ...unfiled } = reversed;
  assert.deepEqual(tableCore(unfiled), [rule]);
  // Applied, a reversed refutation is never filed, so no row is asked for.
  assert.deepEqual(tableCore({ ...reversed, disposition: "apply" }, { 9: closed(OPEN_NT) }), []);
});

test("a deferral that names no issue is a mismatch naming its row and home", () => {
  const { issue: _, ...entry } = deferred("unverified", 2, { scope: "out" });
  assert.deepEqual(tableCore(entry), [
    `unverified[2]: filing row 6 (${FILING_ROWS[6].finding}): a deferral names the issue it was filed to, and this entry names none — it belongs in an open issue labelled needs-triage or ready-for-agent`,
  ]);
});

test("an in-scope suggestion its refuter let survive defers only as row 1, for a reason other than false-rationale", () => {
  for (const reason of [undefined, "", "false-rationale", "outside-ticket-files"]) {
    const v = tableCore(deferred("unverified", 1, { verdictPath: STOOD_V, reason }), { 9: OPEN_RFA });
    assert.equal(v.length, 1, String(reason));
    assert.match(v[0], /^unverified\[1\]: filing row 5 \(an in-scope suggestion its refuter let survive\): deferred with .* — it is applied, or deferred as row 1, for mutual-exclusion, remedy-worse, remedy-outside-diff$/);
  }
  // remedy-outside-diff holds it to the remedy rule, and a suggestion escalates nothing.
  const r = tableRun(deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-outside-diff", remedyFiles: ["src/b.js"] }), { 9: OPEN_RFA });
  assert.deepEqual([r.violations, r.escalations], [[], []]);
  assert.match(tableCore(deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-outside-diff", remedyFiles: ["src/a.js"] }), { 9: OPEN_RFA })[0],
    /^unverified\[1\]: reason remedy-outside-diff needs a remedy file absent from the PR's diff/);
});

test("an in-scope suggestion needs refuter evidence whether applied or deferred; refuted, applying it breaks row 4", () => {
  for (const disposition of ["apply", "defer"]) {
    const { verdictPath: _, ...bare } = deferred("unverified", 1, { disposition });
    assert.deepEqual(tableCore(bare, { 9: RECORD }),
      ["unverified[1]: an in-scope suggestion carries no refuter evidence — its entry names no verdictPath; src/a.js:5 is a line the PR's diff touched, so it is in scope whatever its entry declares"]);
    assert.deepEqual(tableCore({ ...bare, verdictPath: "/scratch/pr40/fix-Ab12Cd34/9/nothing.json" }, { 9: RECORD }),
      ['unverified[1]: an in-scope suggestion carries no refuter evidence — verdictPath "/scratch/pr40/fix-Ab12Cd34/9/nothing.json" names no file that exists']);
  }
  // In scope by its entry alone: an untouched line declared in.
  assert.match(tableCore(deferred("unverified", 2), { 9: OPEN_NT })[0], /^unverified\[2\]: an in-scope suggestion carries no refuter evidence — its entry names no verdictPath; its entry declares scope in$/);
  // A finding with no refutersDispatched at all is a suggestion too.
  const r = coreRun([{ bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" }, deferred("unverified", 0)],
    { unverified: [{ file: "src/a.js", line: 5, severity: "suggestion" }] });
  assert.match(r.violations.map(formatViolation)[0], /^unverified\[0\]: an in-scope suggestion carries no refuter evidence/);
  assert.deepEqual(tableCore(deferred("unverified", 1, { disposition: "apply", verdictPath: REFUTED_V })), [
    `unverified[1]: filing row 4 (${FILING_ROWS[4].finding}): applied, though its verdict is refuted: true — it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wontfix`,
  ]);
  assert.deepEqual(tableCore(deferred("unverified", 1, { disposition: "apply", verdictPath: STOOD_V })), [], "row 5: applied");
});

test("what the filing check never reads: an applied finding, a crashed finding or an out-of-scope suggestion applied, a reversed refutation applied", () => {
  const filing = { pr: 40, issue: () => assert.fail("the tracker was read"), verdict: () => assert.fail("a verdict was read") };
  const entries = [
    { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "survived", index: 1, scope: "out", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "unverified", index: 0, scope: "in", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "unverified", index: 1, scope: "out", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "refuted", index: 0, scope: "out", claimKind: "behavior", disposition: "apply", reason: "re-ran the probe", issue: 9 },
  ];
  const r = checkDispositions({
    review: { head: H40, survived: [{ file: "src/a.js", line: 5 }, { file: "src/a.js", line: 30 }], refuted: [{ file: "src/b.js", line: 1 }],
      unverified: [TABLE_UNVERIFIED[0], TABLE_UNVERIFIED[2]] },
    record: { head: H40, entries }, touched: new Map([["src/a.js", new Set([5])]]), diffFiles: ["src/a.js"], roots: [], filing,
  });
  assert.deepEqual([r.violations, r.escalations, r.unchecked], [[], [], []]);
});

test("an issue the tracker cannot answer leaves that filing unchecked, never a violation", () => {
  const r = tableRun(deferred("unverified", 2, { scope: "out" }), { 9: { problem: "error connecting to api.github.com" } });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.unchecked, [{ bucket: "unverified", index: 2, issue: 9, problem: "error connecting to api.github.com" }]);
});

test("verdictProblem holds a refuter verdict to its schema", () => {
  assert.equal(verdictProblem({ refuted: true, reason: "r" }), null);
  assert.equal(verdictProblem({ refuted: false, reason: "", counter_evidence: "ran x" }), null);
  for (const [value, problem] of [
    [null, "is not a JSON object"], [[], "is not a JSON object"], ["refuted", "is not a JSON object"],
    [{ reason: "r" }, "has no refuted"], [{ refuted: true }, "has no reason"],
    [{ refuted: "true", reason: "r" }, "has a refuted that is not a boolean"], [{ refuted: true, reason: 1 }, "has a reason that is not a string"],
    [{ refuted: true, reason: "r", verdict: "survived" }, "carries verdict, which a refuter verdict does not"],
  ]) assert.equal(verdictProblem(value), problem, JSON.stringify(value));
});

// The CLI against the stubbed tracker.

test("a confirmed defect deferred for an allowed reason and filed needs-triage is a mismatch naming row 1; relabelled ready-for-agent it is ok", (t) => {
  const f = fixture(t);
  f.setIssues({ 81: openIssue("needs-triage") });
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer", reason: "mutual-exclusion", issue: 81 });
  f.writeRecord(entries);
  const r = f.check();
  mismatch(r, /^fix-pr-40: survived\[0\]: filing row 1 \(an in-scope survived finding deferred for an allowed reason other than false-rationale\): it belongs in an open issue labelled ready-for-agent, and #81 is open, titled "a deferred finding", labelled needs-triage$/m);
  assert.equal(r.json.violations.length, 1);
  assert.match(f.ledgerCli("dispatch", "40", "finisher-pr-40").stderr, /dispositions mismatch/);
  f.setIssues({ 81: openIssue("ready-for-agent") });
  okVerdict(f.check());
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("a critical out-of-scope survivor filed open ready-for-agent is ok, never escalate; filed needs-triage or to the record it is a mismatch naming row 8", (t) => {
  const f = fixture(t);
  f.writeReview({ ...f.review, survived: [f.review.survived[0], { ...f.review.survived[1], severity: "critical" }] });
  f.setIssues({ 13: bandRecord() });
  const entries = f.baseEntries();
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"], issue: 81 });
  f.writeRecord(entries);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.escalations, []);
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.head}`), f.row());
  for (const [issue, is] of [[77, "open, titled \"a deferred finding\", labelled needs-triage"], [13, "closed, titled \"PR #40 review: the suggestion band, checked\", labelled wontfix"]]) {
    for (const reason of ["remedy-outside-diff", "false-rationale"]) {
      entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", reason, issue });
      f.writeRecord(entries);
      mismatch(f.check(), new RegExp(`^fix-pr-40: survived\\[1\\]: filing row 8 \\(an out-of-scope survived finding, whatever its reason\\): it belongs in an open issue labelled ready-for-agent, and #${issue} is ${is.replace(/[()]/g, "\\$&")}$`, "m"));
    }
  }
});

test("gh is run from the repository with no ambient GIT_DIR", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  f.writeRecord(f.baseEntries());
  const log = join(f.dir, "gh.log");
  okVerdict(f.check("fix-pr-40", { ...cleanEnv(), GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, FAKE_GH_LOG: log }));
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls, [{ argv: ["issue", "view", "77", "--json", "labels,state,title"], cwd: realpathSync(f.repo), GIT_DIR: null }]);
});

test("an issue two entries name is read through gh once", (t) => {
  const f = fixture(t);
  f.setIssues({ 81: openIssue("ready-for-agent") });
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer", reason: "mutual-exclusion", issue: 81 });
  entries[1] = f.entry("survived", 1, { scope: "in", disposition: "defer", reason: "remedy-worse", issue: 81 });
  f.writeRecord(entries);
  const log = join(f.dir, "gh.log");
  okVerdict(f.check("fix-pr-40", { ...cleanEnv(), FAKE_GH_LOG: log }));
  const read = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).argv[2]);
  assert.deepEqual(read.filter((n) => n === "81"), ["81"], read.join(","));
});

test("the closed suggestion-band record is found by its title past surrounding whitespace", (t) => {
  const f = fixture(t);
  f.setIssues({ 81: { ...bandRecord(), title: `  ${recordTitle(40)}\n` } });
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer", reason: "false-rationale", issue: 81 });
  f.writeRecord(entries);
  okVerdict(f.check());
});

test("gh unreachable writes dispositions-unchecked, the finisher is refused naming dispositions unchecked, and a re-run once gh answers writes ok", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const r = f.check("fix-pr-40", cleanEnv({ FAKE_GH_DOWN: "1" }));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.verdict, "unchecked");
  assert.deepEqual(r.json.violations, []);
  assert.equal(r.json.token, `dispositions-unchecked=fix-pr-40:${f.head}`);
  assert.match(r.stderr, /^fix-pr-40: unverified\[0\]: where it was filed is unchecked — #77 could not be read through gh: error connecting to api\.github\.com$/m);
  assert.ok(f.row().includes(`dispositions-unchecked=fix-pr-40:${f.head}`), f.row());
  const before = readFileSync(join(f.dir, "ledger.md"), "utf8");
  const d = f.ledgerCli("dispatch", "40", "finisher-pr-40");
  assert.equal(d.status, 2);
  assert.match(d.stderr, /finisher-pr-40: dispositions unchecked — fix-pr-40's check of review [0-9a-f]+ could not read where a deferral was filed/);
  assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), before, "a refused dispatch writes nothing");
  assert.deepEqual(dueUntilFixed(f), [40], "control");
  assert.deepEqual(fixDueFor(f), [], "an unchecked verdict is answered by re-running the check, never by a fix-applier");

  okVerdict(f.check());
  const row = f.row();
  assert.equal(row.match(/dispositions-/g).length, 1, row);
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("an issue gh cannot read is unchecked too, a broken rule outranks it, and with no ledger the exit status says so", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[2] = f.entry("unverified", 0, { scope: "out", disposition: "defer", issue: 404 });
  f.writeRecord(entries);
  const r = f.check();
  assert.equal(r.json.verdict, "unchecked", r.stderr);
  assert.match(r.stderr, /unverified\[0\]: where it was filed is unchecked — #404 could not be read through gh: GraphQL: Could not resolve to an issue/);

  entries[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(entries);
  const broken = f.check("fix-pr-40", cleanEnv({ FAKE_GH_DOWN: "1" }));
  mismatch(broken, /^fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason/m);
  assert.match(broken.stderr, /unverified\[0\]: where it was filed is unchecked/);

  f.writeRecord(f.baseEntries());
  const alone = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--no-ledger"],
    { encoding: "utf8", env: f.env(cleanEnv(), { FAKE_GH_DOWN: "1" }), cwd: f.repo });
  assert.equal(alone.status, 1, alone.stderr);
  assert.deepEqual([JSON.parse(alone.stdout).verdict, JSON.parse(alone.stdout).token], ["unchecked", null]);
});

test("an in-scope suggestion with no verdictPath, a missing file, one outside the run root, or one failing the schema is a mismatch", (t) => {
  const f = fixture(t);
  f.setIssues({ 78: bandRecord() });
  // unverified[0], an untouched line declared in scope: an in-scope suggestion.
  const deferWith = (verdictPath) => {
    const entries = f.baseEntries();
    entries[2] = f.entry("unverified", 0, { disposition: "defer", issue: 78, ...(verdictPath === undefined ? {} : { verdictPath }) });
    f.writeRecord(entries);
    return f.check();
  };
  const noEvidence = /^fix-pr-40: unverified\[0\]: an in-scope suggestion carries no refuter evidence — /m;
  mismatch(deferWith(undefined), /unverified\[0\]: an in-scope suggestion carries no refuter evidence — its entry names no verdictPath; its entry declares scope in/);
  const good = f.writeVerdict({ refuted: true, reason: "the probe ran clean" });
  for (const [path, why] of [
    [join(f.scratch, "pr40", "fix-Ab12Cd34", "2", "verdict.json"), /names no file that exists/],
    ["pr40/fix-Ab12Cd34/1/verdict.json", /is not an absolute path/],
    [f.writeVerdict({ refuted: true, reason: "r" }, "1", join(f.scratch, "pr40", "elsewhere")), /is not under a fix-applier run root/],
    [f.writeVerdict({ refuted: true, reason: "r" }, "1", join(f.dir, "pr40", "fix-Ab12Cd34")), /is not under a fix-applier run root/],
    [join(f.scratch, "pr40", "fix-Ab12Cd34", "1"), /is not under a fix-applier run root/],
    [(() => { const d = join(f.scratch, "pr40", "fix-Ab12Cd34", "6", "verdict.json"); mkdirSync(d, { recursive: true }); return d; })(), /names something that is not a file/],
    [f.writeVerdict("{not json", "3"), /cannot be read as JSON/],
    [f.writeVerdict({ refuted: "yes", reason: "r" }, "4"), /fails the refuter verdict schema — it has a refuted that is not a boolean/],
    [f.writeVerdict({ refuted: true }, "5"), /fails the refuter verdict schema — it has no reason/],
  ]) {
    const r = deferWith(path);
    mismatch(r, noEvidence);
    assert.match(r.stderr, why, path);
  }
  okVerdict(deferWith(good));
  // Reached through a symlink, the run root is still the run root.
  const alias = join(f.dir, "alias");
  symlinkSync(f.scratch, alias);
  okVerdict(deferWith(join(alias, "pr40", "fix-Ab12Cd34", "1", "verdict.json")));
});

test("an in-scope suggestion refuted and filed as an open issue, or applied, is a mismatch naming row 4; filed to the closed record it is ok", (t) => {
  const f = fixture(t);
  const verdictPath = f.writeVerdict({ refuted: true, reason: "the probe ran clean" });
  const entries = f.baseEntries();
  // Issue 77 is open, labelled needs-triage — where #2226 and #2227 went.
  entries[2] = f.entry("unverified", 0, { disposition: "defer", issue: 77, verdictPath });
  f.writeRecord(entries);
  mismatch(f.check(), /^fix-pr-40: unverified\[0\]: filing row 4 \(an in-scope suggestion its refuter refuted\): it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wontfix, and #77 is open/m);
  entries[2] = f.entry("unverified", 0, { verdictPath });
  f.writeRecord(entries);
  mismatch(f.check(), /^fix-pr-40: unverified\[0\]: filing row 4 \(an in-scope suggestion its refuter refuted\): applied, though its verdict is refuted: true/m);
  f.setIssues({ 78: bandRecord() });
  entries[2] = f.entry("unverified", 0, { disposition: "defer", issue: 78, verdictPath });
  f.writeRecord(entries);
  okVerdict(f.check());
});
