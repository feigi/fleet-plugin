// dispositions-check.mjs: a review fix-applier's disposition record judged
// against the review file and the PR's diff, its verdict written onto the
// ledger, and `ledger.mjs dispatch` then gating the finisher on it.
//
// Every CLI case runs against a real git repository built in a temp dir —
// `origin/main` a ref, the PR head one commit past it — so the touched lines
// are git's own answer, not a fixture's restatement of one. The tracker is a
// `gh` stub first on PATH, answering `issue view` and `pr view` from JSON files the
// fixture writes: no case reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, realpathSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { deriveRun } from "../plugin/scripts/fleet-tick.mjs";
import { recordTitle } from "../plugin/scripts/dispositions-check.mjs";
import {
  LEDGER, REMAP, openIssue, cleanEnv, git, lines, fixture as sharedFixture, mismatch, okVerdict, core, escalated, deferOutside, withSeverity,
} from "./support/dispositions-fixture.mjs";

const bandRecord = (pr = 40) => ({ state: "CLOSED", title: recordTitle(pr), labels: ["wontfix"] });

// The shared fixture, plus the verb itself — `ledger.mjs dispositions
// <member> --scratch … --repo …` against the fixture's ledger, `extra` the
// flags after them — and PR 40's row as the ledger holds it.
function fixture(t, opts) {
  const f = sharedFixture(t, opts);
  const check = (member = "fix-pr-40", base = cleanEnv(), extra = []) => {
    const r = spawnSync(process.execPath, [LEDGER, "--file", f.ledger, "dispositions", member, "--scratch", f.scratch, "--repo", f.repo, ...extra],
      { encoding: "utf8", env: f.env(base), cwd: f.dir });
    return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null };
  };
  const row = () => f.okLedger("read").rows.find((r) => r.startsWith("#10 "));
  return { ...f, check, row };
}

test("an in-scope survivor deferred with no reason is a mismatch, and the finisher is refused with nothing written", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(entries);
  const r = f.check();
  mismatch(r, /fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason — src\/a\.js:5 is a line the PR's diff touched/);
  assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 0]]);
  assert.ok(f.row().includes(`dispositions-mismatch=fix-pr-40:${f.run}`), f.row());

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
    assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.run}`), `${reason}: ${f.row()}`);
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

// A finding on a PR body or a commit body has no file and no line: it names its
// surface in its `claim`. It must be judged in scope, so a deferral needs an
// allowed reason, rather than being taken at the scope the entry declares.
test("a finding with neither file nor line, such as one on a PR body, is in scope", (t) => {
  const f = fixture(t);
  f.writeReview({ ...f.review, survived: [f.review.survived[0], { severity: "important", claim: "PR body: says 3 files, the diff touches 2", evidence: "git diff --stat" }] });
  const entries = f.baseEntries();
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer" });
  f.writeRecord(entries);
  mismatch(f.check(), /survived\[1\]: .* it has no (line|file), so it is in scope/);
  // Applied, it passes: the in-scope ruling is not a refusal.
  entries[1] = f.entry("survived", 1, { scope: "in", disposition: "apply" });
  f.writeRecord(entries);
  okVerdict(f.check());
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
  rmSync(f.recordPath());
  mismatch(f.check(), /record: no disposition record at .*dispositions-fix-pr-40\.json/);
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
  assert.match(again.stderr, /row #10 already carries dispositions-ok=fix-pr-40:run-Rv40Aa01 — not written again/);
  const row = f.row();
  assert.equal(row.match(/dispositions-/g).length, 1, row);
  assert.ok(row.endsWith(` · dispositions-ok=fix-pr-40:${f.run}`), row);
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
  f.writeRecord(badRecord(f), f.head, "fix-pr-40-b");
  const r = f.check("fix-pr-40-b");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.verdict, "escalate");
  assert.equal(r.json.token, `dispositions-escalate=fix-pr-40-b:${f.run}`);
  assert.match(r.stderr, /^fix-pr-40-b: survived\[0\]: an in-scope survived finding deferred with no reason/m, "the violations are still printed");
  const row = f.row();
  assert.ok(row.includes(`dispositions-mismatch=fix-pr-40:${f.run}`) && row.includes(`dispositions-escalate=fix-pr-40-b:${f.run}`), row);
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
  f.writeRecord(f.baseEntries(), f.head, "fix-pr-40-b");
  okVerdict(f.check("fix-pr-40-b"));
  assert.ok(f.row().includes(`dispositions-mismatch=fix-pr-40:${f.run}`), "the first fix-applier's verdict is kept");
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("the first mismatch is a plain mismatch, and a mismatch on an earlier review does not count toward a later one", (t) => {
  const f = fixture(t);
  f.writeRecord(badRecord(f));
  const first = f.check();
  assert.equal(first.json.verdict, "mismatch");
  assert.equal(first.json.token, `dispositions-mismatch=fix-pr-40:${f.run}`);
  // The earlier fix-applier's mismatch answered another review.
  retry(f);
  f.writeRecord(badRecord(f), f.head, "fix-pr-40-b");
  const ledgerPath = join(f.dir, "ledger.md");
  writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8").replace(`dispositions-mismatch=fix-pr-40:${f.run}`, "dispositions-mismatch=fix-pr-40:run-deadbeer"));
  const second = f.check("fix-pr-40-b");
  assert.equal(second.json.verdict, "mismatch", second.stderr);
});

// #2886: a re-review at the same head leaves round 1's file in its own run
// root. The check reads the one the PR's latest `reviewed=` names, and the
// retry's record sits beside round 1's rather than over it.
test("with two review files present, a fix-applier is judged against the one the latest reviewed= names", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  okVerdict(f.check());
  const round2 = "run-Rv40Bb02";
  const review2 = { ...f.review, counts: { survived: 1, refuted: 0, unverified: 0, crashed: 0 }, survived: [f.review.survived[0]], refuted: [], unverified: [] };
  mkdirSync(join(f.scratch, "pr40", round2));
  writeFileSync(join(f.scratch, "pr40", round2, "review.json"), JSON.stringify(review2));
  f.okLedger("review", "40", "review=member:review-pr-40-b", `reviewed=${f.head}:1/0/0:${round2}`);
  retry(f);
  // The round-1 record, copied to the retry: it answers round 1's findings,
  // which round 2 does not hold.
  f.writeRecord(f.baseEntries(), f.head, "fix-pr-40-b");
  const stale = f.check("fix-pr-40-b");
  mismatch(stale, /names no finding/);
  assert.equal(stale.json.token, `dispositions-mismatch=fix-pr-40-b:${round2}`);
  f.writeRecord([f.entry("survived", 0)], f.head, "fix-pr-40-b", round2);
  const r = f.check("fix-pr-40-b");
  okVerdict(r);
  assert.equal(r.json.token, `dispositions-ok=fix-pr-40-b:${round2}`);
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.run}`), "round 1's verdict is kept");
  assert.deepEqual(JSON.parse(readFileSync(f.reviewPath, "utf8")), f.review, "round 1's review file was touched");
  assert.equal(JSON.parse(readFileSync(f.recordPath(), "utf8")).entries.length, 3, "the retry's record replaced round 1's");
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

// A fix-applier that ruled on round 1 and is checked again after a same-head
// round 2 landed: the head matches and so do the findings, but the record was
// written against another run, so it answers nothing of round 2's.
test("a record written against an earlier review run is a mismatch even at the same head and over the same findings", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  okVerdict(f.check());
  const round2 = "run-Rv40Bb02";
  mkdirSync(join(f.scratch, "pr40", round2));
  writeFileSync(join(f.scratch, "pr40", round2, "review.json"), JSON.stringify(f.review));
  f.okLedger("review", "40", "review=member:review-pr-40-b", `reviewed=${f.head}:2/1/1:${round2}`);
  const stale = f.check();
  mismatch(stale, /the record answers run "run-Rv40Aa01", not the review's run-Rv40Bb02/);
  assert.equal(stale.json.token, `dispositions-mismatch=fix-pr-40:${round2}`);
  f.writeRecord(f.baseEntries(), f.head, "fix-pr-40", round2);
  okVerdict(f.check());
  // A record with no run answers no review a ledger names.
  writeFileSync(f.recordPath(), JSON.stringify({ head: f.head, entries: f.baseEntries() }));
  mismatch(f.check(), /the record answers run null, not the review's run-Rv40Bb02/);
});

test("nothing is judged or written when the review file or the git history cannot be read", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const before = f.row();
  rmSync(f.reviewPath);
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

test("nothing is judged or written for a review finding that is no object, an unreadable record file or a stray argument", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const before = f.row();
  f.writeReview({ ...f.review, survived: [f.review.survived[0], null] });
  let r = f.check();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /pr40\/run-Rv40Aa01\/review\.json has a survived\[1\] that is not a finding object/);
  f.writeReview();
  // A record path that exists and cannot be read is the environment's fault,
  // not a ruling the fix-applier wrote: no mismatch is blamed on it.
  rmSync(f.recordPath());
  mkdirSync(f.recordPath());
  r = f.check();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not read the disposition record .*dispositions-fix-pr-40\.json: EISDIR/);
  rmSync(f.recordPath(), { recursive: true });
  f.writeRecord(f.baseEntries());
  r = f.check("fix-pr-40", cleanEnv(), ["stray"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(f.row(), before);
  // The control: the same files and flags, nothing stray, are judged and written.
  okVerdict(f.check());
  assert.notEqual(f.row(), before);
});

// The same review row with no fix-applier landed on it is fix-due: the control
// that shows fixDueFor can see a PR become fix-due at all.
const dueUntilFixed = (f) => deriveRun({ rows: [`#10 impl-10=PR#40 → PR#40 · reviewed=${f.head}:2/1/1:${f.run}`], dispatched: [], drain: null },
  [{ number: 40, labels: [], closingIssuesReferences: [{ number: 10 }] }], "ready-to-merge").fixDue;
const fixDueFor = (f) => {
  const l = f.okLedger("read");
  return deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null }, [{ number: 40, labels: [], closingIssuesReferences: [{ number: 10 }] }], "ready-to-merge").fixDue;
};

test("a suggestion deferred remedy-outside-diff, its remedy in a file the diff lacks, passes as ok and lets the finisher dispatch", (t) => {
  const f = fixture(t);
  withSeverity(f, "suggestion");
  deferOutside(f, ["src/b.js"]);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.escalations, []);
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.run}`), f.row());
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
    assert.equal(r.json.token, `dispositions-escalate=fix-pr-40:${f.run}`);
    assert.match(r.stderr, new RegExp(`^fix-pr-40: survived\\[0\\]: a ${severity} finding deferred remedy-outside-diff, its remedy in src/b\\.js — the maintainer answers$`, "m"));
    assert.ok(f.row().includes(`dispositions-escalate=fix-pr-40:${f.run}`), f.row());

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
      assert.ok(f.row().includes(`dispositions-mismatch=fix-pr-40:${f.run}`), f.row());
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
  const rec = JSON.parse(readFileSync(f.recordPath(), "utf8"));
  f.writeRecord(rec.entries.filter((e) => !(e.bucket === "survived" && e.index === 1)));
  const r = f.check();
  mismatch(r, /^fix-pr-40: survived\[1\]: no entry/m);
  assert.match(r.stderr, /^fix-pr-40: survived\[0\]: a critical finding deferred remedy-outside-diff/m);
  assert.equal(r.json.token, `dispositions-mismatch=fix-pr-40:${f.run}`);
});

test("an escalation outranks an issue gh cannot read: the verdict is escalate, the maintainer answers, and the unread issue is still reported", (t) => {
  const f = fixture(t);
  withSeverity(f, "critical");
  deferOutside(f, ["src/b.js"]);
  const entries = JSON.parse(readFileSync(f.recordPath(), "utf8")).entries;
  entries[2] = { ...entries[2], issue: 404 };
  f.writeRecord(entries);
  const r = f.check();
  escalated(r);
  assert.equal(r.json.token, `dispositions-escalate=fix-pr-40:${f.run}`);
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
  entries[2] = { ...entries[2], reason: "remedy-outside-diff", issue: 13 };
  f.setIssues({ 13: openIssue("needs-triage") });
  f.writeRecord(entries);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.escalations, []);
});

const answered = (...pairs) => new Map(pairs);

const ledgerText = (f) => readFileSync(join(f.dir, "ledger.md"), "utf8");
const OUTSIDE = { disposition: "defer", reason: "remedy-outside-diff", issue: 81, remedyFiles: ["src/b.js"] };
// A record that breaks no rule and escalates survived[0] and survived[1].
// `second` overrides survived[1]'s entry: what the member does with it.
const deferBothOutside = (f, member = "fix-pr-40", second = {}) => {
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, OUTSIDE);
  entries[1] = f.entry("survived", 1, { ...OUTSIDE, ...second });
  f.writeRecord(entries, f.head, member);
};
const recordAnswers = (f, flags, member = "fix-pr-40") => f.check(member, cleanEnv(), flags);
// The check's refusal: exit 2, the cause named on stderr, the ledger byte-identical.
const refusedAnswers = (f, flags, cause, member = "fix-pr-40") => {
  const before = ledgerText(f);
  const r = recordAnswers(f, flags, member);
  assert.equal(r.status, 2, `expected a refusal, got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, cause);
  assert.equal(ledgerText(f), before, "a refused answer leaves the ledger byte-identical");
  return r;
};
const violationLines = (r) => r.stderr.split("\n").filter((l) => /^fix-pr-40(-[a-z])?: (?:(?:survived|unverified|refuted)\[\d+\]|record): /.test(l));

test("--uphold writes the answer and dispositions-ok in place of the escalate, exits 0, and the finisher then dispatches", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  assert.ok(f.row().includes(`dispositions-escalate=fix-pr-40:${f.run}`), f.row());
  assert.equal(f.ledgerCli("dispatch", "40", "finisher-pr-40").status, 2, "control: the escalate refuses the finisher");
  const r = recordAnswers(f, ["--uphold", "survived[0]"]);
  okVerdict(r);
  assert.equal(r.json.token, `dispositions-ok=fix-pr-40:${f.run}`);
  assert.deepEqual([r.json.violations, r.json.escalations, r.json.unchecked], [[], [], []]);
  assert.match(r.stderr, /^fix-pr-40: recorded the maintainer's escalation answers on review run-Rv40Aa01 — survived\[0\] upheld$/m);
  const row = f.row();
  assert.ok(row.includes(`escalation-answer=${f.run}:survived[0]:upheld`), row);
  assert.ok(row.includes(`dispositions-ok=fix-pr-40:${f.run}`), row);
  assert.equal(row.match(/dispositions-/g).length, 1, "the escalate is replaced, not kept beside the ok");
  assert.doesNotMatch(row, /·\s+·/, "no doubled separator is left behind");
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("--send-back writes the answer and dispositions-mismatch, exits 1 naming the finding, and the tick offers the retry", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  assert.deepEqual(fixDueFor(f), [], "control: an escalate is never fix-due");
  const r = recordAnswers(f, ["--send-back", "survived[0]"]);
  mismatch(r, /^fix-pr-40: survived\[0\]: sent back to be applied in this PR/m);
  assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 0]]);
  assert.deepEqual(r.json.escalations, []);
  assert.equal(r.json.token, `dispositions-mismatch=fix-pr-40:${f.run}`);
  const row = f.row();
  assert.ok(row.includes(`escalation-answer=${f.run}:survived[0]:sent-back`), row);
  assert.ok(row.includes(`dispositions-mismatch=fix-pr-40:${f.run}`), row);
  assert.doesNotMatch(row, /dispositions-escalate/);
  assert.deepEqual(fixDueFor(f), [40], "the tick prints DISPATCH fix-pr for it");
  const d = f.ledgerCli("dispatch", "40", "finisher-pr-40");
  assert.equal(d.status, 2);
  assert.match(d.stderr, /finisher-pr-40: dispositions mismatch — fix-pr-40's/);
});

test("a mixed answer writes each finding's answer and a mismatch with a violation for the sent-back finding only", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  const e = f.check();
  escalated(e);
  assert.deepEqual(e.json.escalations.map((x) => `${x.bucket}[${x.index}]`), ["survived[0]", "survived[1]"]);
  const r = recordAnswers(f, ["--uphold", "survived[0]", "--send-back", "survived[1]"]);
  mismatch(r, /^fix-pr-40: survived\[1\]: sent back to be applied in this PR/m);
  assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 1]]);
  assert.deepEqual(r.json.escalations, []);
  assert.doesNotMatch(r.stderr, /^fix-pr-40: survived\[0\]:/m, "the upheld finding is neither a violation nor an escalation");
  const row = f.row();
  assert.ok(row.includes(`escalation-answer=${f.run}:survived[0]:upheld · escalation-answer=${f.run}:survived[1]:sent-back`), row);
  assert.ok(row.endsWith(` · dispositions-mismatch=fix-pr-40:${f.run}`), row);
  assert.deepEqual(fixDueFor(f), [40]);
});

test("a retry record is judged with the answers: deferring the sent-back finding again, for any reason, is the second failure; applying it and deferring the upheld one passes", (t) => {
  for (const [what, second, verdict] of [
    ["the same deferral again", {}, "escalate"],
    ["another reason", { reason: "mutual-exclusion", remedyFiles: undefined }, "escalate"],
    ["applied", { disposition: "apply", reason: undefined, issue: undefined, remedyFiles: undefined }, "ok"],
  ]) {
    const f = fixture(t);
    deferBothOutside(f);
    escalated(f.check());
    mismatch(recordAnswers(f, ["--uphold", "survived[0]", "--send-back", "survived[1]"]));
    retry(f);
    // survived[0], upheld, is deferred remedy-outside-diff again; survived[1], sent back, as the case says.
    deferBothOutside(f, "fix-pr-40-b", second);
    const r = f.check("fix-pr-40-b");
    assert.equal(r.json.verdict, verdict, `${what}: ${r.stderr}`);
    assert.equal(r.json.token, `dispositions-${verdict}=fix-pr-40-b:${f.run}`, what);
    assert.deepEqual(r.json.escalations, [], `${what}: the upheld finding escalates no more`);
    if (verdict === "ok") {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher", what);
    } else {
      assert.equal(r.status, 1, r.stderr);
      assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 1]], what);
      assert.match(r.stderr, /^fix-pr-40-b: survived\[1\]: sent back to be applied in this PR/m, what);
      assert.equal(f.ledgerCli("dispatch", "40", "finisher-pr-40").status, 2, what);
      assert.deepEqual(fixDueFor(f), [], `${what}: a second failure is never fix-due`);
    }
  }
});

test("sending a finding back after an earlier fix-applier's mismatch on the review writes dispositions-escalate, and upholding it does not", (t) => {
  for (const [flags, verdict] of [[["--uphold", "survived[0]", "--send-back", "survived[1]"], "escalate"], [["--uphold", "survived[0],survived[1]"], "ok"]]) {
    const f = fixture(t);
    f.writeRecord(badRecord(f));
    mismatch(f.check());
    retry(f);
    deferBothOutside(f, "fix-pr-40-b");
    const e = f.check("fix-pr-40-b");
    escalated(e);
    assert.deepEqual(e.json.violations, [], "the retry's record breaks no rule: an outside-diff escalate, though the first fix-applier failed");
    const r = recordAnswers(f, flags, "fix-pr-40-b");
    assert.equal(r.json.verdict, verdict, r.stderr);
    assert.equal(r.json.token, `dispositions-${verdict}=fix-pr-40-b:${f.run}`);
    const row = f.row();
    assert.ok(row.includes(`dispositions-mismatch=fix-pr-40:${f.run}`), "the first fix-applier's verdict is kept");
    assert.equal(row.match(/dispositions-(escalate|ok)=fix-pr-40-b/g).length, 1, row);
    if (verdict === "escalate") {
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^fix-pr-40-b: survived\[1\]: sent back to be applied in this PR/m);
      assert.match(r.stderr, /an earlier fix-applier's record on review run-Rv40Aa01 already failed this check/);
      assert.equal(f.ledgerCli("dispatch", "40", "finisher-pr-40").status, 2);
      assert.deepEqual(fixDueFor(f), [], "a second failure is never fix-due");
    } else {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
    }
  }
});

test("running the check again with no answer flags reproduces the verdict, its violation lines and the payload, and writes nothing", (t) => {
  for (const flags of [["--uphold", "survived[0]"], ["--send-back", "survived[0]"]]) {
    const f = fixture(t);
    deferOutside(f, ["src/b.js"]);
    escalated(f.check());
    const first = recordAnswers(f, flags);
    const before = ledgerText(f);
    const again = f.check();
    assert.equal(again.status, first.status, flags.join(" "));
    assert.deepEqual(again.json, first.json, flags.join(" "));
    assert.deepEqual(violationLines(again), violationLines(first), flags.join(" "));
    assert.equal(violationLines(again).length, flags[0] === "--send-back" ? 1 : 0);
    assert.match(again.stderr, /row #10 already carries dispositions-(ok|mismatch)=fix-pr-40:run-Rv40Aa01 — not written again/);
    assert.equal(ledgerText(f), before, "a re-run writes nothing");
  }
});

test("an answer to one review answers none of a later one: the same deferral of the same finding escalates again", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  okVerdict(recordAnswers(f, ["--uphold", "survived[0]"]));
  const round2 = "run-Rv40Bb02";
  mkdirSync(join(f.scratch, "pr40", round2));
  writeFileSync(join(f.scratch, "pr40", round2, "review.json"), JSON.stringify(f.review));
  f.okLedger("review", "40", "review=member:review-pr-40-b", `reviewed=${f.head}:2/1/1:${round2}`);
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, OUTSIDE);
  f.writeRecord(entries, f.head, "fix-pr-40", round2);
  const r = f.check();
  escalated(r);
  assert.equal(r.json.token, `dispositions-escalate=fix-pr-40:${round2}`);
  assert.deepEqual(r.json.escalations.map((x) => `${x.bucket}[${x.index}]`), ["survived[0]"]);
  assert.ok(f.row().includes(`escalation-answer=${f.run}:survived[0]:upheld`), "the earlier review's answer stays where it was written");
  // The later review's escalation takes its own answer, beside the first.
  okVerdict(recordAnswers(f, ["--uphold", "survived[0]"]));
  const row = f.row();
  assert.ok(row.includes(`escalation-answer=${round2}:survived[0]:upheld`), row);
  assert.ok(row.includes(`escalation-answer=${f.run}:survived[0]:upheld`), row);
  assert.ok(row.includes(`dispositions-ok=fix-pr-40:${round2}`), row);
});

test("with every escalated finding upheld but a filing the tracker cannot read, the verdict is unchecked, and re-running once gh answers reads the answer and passes", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  const entries = JSON.parse(readFileSync(f.recordPath(), "utf8")).entries;
  entries[2] = { ...entries[2], issue: 404 };
  f.writeRecord(entries);
  escalated(f.check());
  const r = recordAnswers(f, ["--uphold", "survived[0]"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.verdict, "unchecked");
  assert.equal(r.json.token, `dispositions-unchecked=fix-pr-40:${f.run}`);
  assert.match(r.stderr, /unverified\[0\]: where it was filed is unchecked — #404 could not be read through gh/);
  assert.ok(f.row().includes(`escalation-answer=${f.run}:survived[0]:upheld`), f.row());
  assert.equal(f.ledgerCli("dispatch", "40", "finisher-pr-40").status, 2);
  f.setIssues({ 404: openIssue("needs-triage") });
  okVerdict(f.check());
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("a run whose escalated verdict names another member, or no escalate, or a record that has since broken a rule, is refused with the ledger untouched", (t) => {
  const f = fixture(t);
  // No verdict at all: the check never ran.
  deferBothOutside(f);
  refusedAnswers(f, ["--uphold", "survived[0],survived[1]"], /PR #40's current dispositions verdict on review run-Rv40Aa01 is none, not an escalate from fix-pr-40/);
  // An ok is no escalate.
  const g = fixture(t);
  g.writeRecord(g.baseEntries());
  okVerdict(g.check());
  refusedAnswers(g, ["--uphold", "survived[0]"], /current dispositions verdict on review run-Rv40Aa01 is ok from fix-pr-40, not an escalate from fix-pr-40/);
  // A mismatch is no escalate.
  const h = fixture(t);
  h.writeRecord(badRecord(h));
  mismatch(h.check());
  refusedAnswers(h, ["--uphold", "survived[0]"], /is mismatch from fix-pr-40, not an escalate from fix-pr-40/);
  // The escalate is another member's: fix-pr-40-b's ok is the current verdict.
  const i = fixture(t);
  deferBothOutside(i);
  escalated(i.check());
  retry(i);
  i.writeRecord(i.baseEntries(), i.head, "fix-pr-40-b");
  okVerdict(i.check("fix-pr-40-b"));
  refusedAnswers(i, ["--uphold", "survived[0],survived[1]"], /is ok from fix-pr-40-b, not an escalate from fix-pr-40/);
  // The escalate names fix-pr-40-b, and the member given is fix-pr-40.
  const j = fixture(t);
  retry(j);
  deferBothOutside(j, "fix-pr-40-b");
  escalated(j.check("fix-pr-40-b"));
  j.writeRecord(j.baseEntries());
  refusedAnswers(j, ["--uphold", "survived[0]"], /is escalate from fix-pr-40-b, not an escalate from fix-pr-40/);
});

test("an escalated member's answers are refused while a fix-applier on the PR is live, naming it", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  escalated(f.check());
  f.okLedger("dispatch", "40", "fix-pr-40-b");
  refusedAnswers(f, ["--uphold", "survived[0],survived[1]"], /fix-pr-40-b still live on PR #40/);
  f.okLedger("settle", "fix-pr-40-b", `applied:${f.head.slice(0, 7)}`);
  // The control: settled, the same call is judged — and the escalate is now fix-pr-40's, with fix-pr-40-b answering nothing.
  const r = recordAnswers(f, ["--uphold", "survived[0],survived[1]"]);
  okVerdict(r);
});

test("a record that breaks a rule is refused: its escalate is not an outside-diff one, and the violations are named", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  escalated(f.check());
  const rec = JSON.parse(readFileSync(f.recordPath(), "utf8"));
  f.writeRecord(rec.entries.filter((e) => !(e.bucket === "survived" && e.index === 1)));
  const r = refusedAnswers(f, ["--uphold", "survived[0]"], /fix-pr-40's record breaks a rule/);
  assert.match(r.stderr, /survived\[1\]: no entry — a finding with no entry is a dropped finding/);
});

test("a finding the record does not escalate is refused, naming what it does escalate", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  refusedAnswers(f, ["--uphold", "survived[1]"], /survived\[1\] is not one of fix-pr-40's escalated findings \(survived\[0\]\)/);
  refusedAnswers(f, ["--uphold", "survived[0]", "--send-back", "unverified[0]"], /unverified\[0\] is not one of fix-pr-40's escalated findings \(survived\[0\]\)/);
  refusedAnswers(f, ["--send-back", "refuted[0]"], /refuted\[0\] is not one of fix-pr-40's escalated findings/);
  refusedAnswers(f, ["--uphold", "survived[9]"], /survived\[9\] is not one of fix-pr-40's escalated findings/);
  // A record that has since stopped escalating has nothing to answer.
  f.writeRecord(f.baseEntries());
  refusedAnswers(f, ["--uphold", "survived[0]"], /survived\[0\] is not one of fix-pr-40's escalated findings — its record escalates none/);
});

test("a finding listed twice, answered both ways, or a flag given twice is refused", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  escalated(f.check());
  refusedAnswers(f, ["--uphold", "survived[0],survived[0]"], /--uphold lists survived\[0\] twice/);
  refusedAnswers(f, ["--uphold", "survived[0]", "--send-back", "survived[1],survived[1]"], /--send-back lists survived\[1\] twice/);
  refusedAnswers(f, ["--uphold", "survived[0]", "--send-back", "survived[0],survived[1]"], /survived\[0\] is listed in both --uphold and --send-back/);
  refusedAnswers(f, ["--uphold", "survived[0]", "--uphold", "survived[1]"], /--uphold is given twice/);
  refusedAnswers(f, ["--send-back", "survived[0]", "--uphold", "survived[1]", "--send-back", "survived[1]"], /--send-back is given twice/);
});

test("a list that is no comma-separated <bucket>[<index>] is refused, with no value or an empty one included", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  escalated(f.check());
  for (const bad of ["survived", "survived[]", "survived[01]", "survived[-1]", "survived[1.5]", "survived[x]", "fixed[0]", "Survived[0]", "survived[0],", ",survived[0]", "survived[0],,survived[1]", "survived[0] survived[1]"]) {
    refusedAnswers(f, ["--uphold", bad], /--uphold names .*, which is no <bucket>\[<index>\]/);
  }
  refusedAnswers(f, ["--send-back"], /--send-back needs a value/);
  refusedAnswers(f, ["--uphold", ""], /--uphold needs a value/);
  refusedAnswers(f, ["--uphold=survived[0]"], /--uphold needs a space-separated value/);
  // The accepting half: whitespace around a comma is no part of an address.
  const ok = recordAnswers(f, ["--uphold", " survived[0] , survived[1] "]);
  okVerdict(ok);
});

test("every escalated finding must be answered in the one run, and the refusal names the unanswered", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  escalated(f.check());
  refusedAnswers(f, ["--uphold", "survived[0]"], /fix-pr-40's record escalates survived\[0\], survived\[1\], and survived\[1\] has no answer/);
  refusedAnswers(f, ["--send-back", "survived[1]"], /survived\[0\] has no answer/);
  refusedAnswers(f, ["--send-back", "survived[0]"], /survived\[1\] has no answer/);
});

test("a ledger write that fails while recording answers exits 2 and leaves the ledger byte-identical", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes every directory");
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  const before = ledgerText(f);
  chmodSync(f.dir, 0o555);
  let r;
  try {
    r = recordAnswers(f, ["--uphold", "survived[0]"]);
  } finally {
    chmodSync(f.dir, 0o755);
  }
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot (create|write|lock) .*ledger\.md/);
  assert.equal(ledgerText(f), before);
});

test("a later member's answers keep the answers an earlier member recorded on the same review", (t) => {
  const f = fixture(t);
  f.writeReview({ ...f.review, counts: { ...f.review.counts, survived: 3 }, survived: [...f.review.survived, { severity: "important", file: "src/a.js", line: 13, claim: "c", evidence: "e" }] });
  const first = f.baseEntries();
  first[0] = f.entry("survived", 0, OUTSIDE);
  first[1] = f.entry("survived", 1, OUTSIDE);
  first.splice(2, 0, f.entry("survived", 2));
  f.writeRecord(first);
  escalated(f.check());
  mismatch(recordAnswers(f, ["--uphold", "survived[0]", "--send-back", "survived[1]"]));
  retry(f);
  // The retry applies the sent-back survived[1], defers the upheld survived[0]
  // again, and escalates survived[2], which nobody has answered yet.
  const second = f.baseEntries();
  second[0] = f.entry("survived", 0, OUTSIDE);
  second[1] = f.entry("survived", 1);
  second.splice(2, 0, f.entry("survived", 2, OUTSIDE));
  f.writeRecord(second, f.head, "fix-pr-40-b");
  const e = f.check("fix-pr-40-b");
  escalated(e);
  assert.deepEqual(e.json.escalations.map((x) => `${x.bucket}[${x.index}]`), ["survived[2]"]);
  const r = recordAnswers(f, ["--uphold", "survived[2]"], "fix-pr-40-b");
  okVerdict(r);
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40-b:${f.run}`), f.row());
});

test("a malformed escalation-answer token on the row answers nothing and is named on stderr", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  const bad = `escalation-answer=${f.run}:survived[0]:Sent-Back`;
  const p = join(f.dir, "ledger.md");
  writeFileSync(p, ledgerText(f).split("\n").map((l) => (l.includes("dispositions-escalate=") ? `${l} · ${bad}` : l)).join("\n"));
  const r = f.check();
  escalated(r);
  assert.match(r.stderr, new RegExp(`^dispositions-check: ignoring malformed token ${bad.replace(/[[\]]/g, "\\$&")} on PR #40's row — it answers nothing$`, "m"));
  // Control: a well-formed answer on the row is read and never named.
  const clean = fixture(t);
  deferOutside(clean, ["src/b.js"]);
  escalated(clean.check());
  okVerdict(recordAnswers(clean, ["--uphold", "survived[0]"]));
  const again = clean.check();
  okVerdict(again);
  assert.doesNotMatch(again.stderr, /ignoring malformed token/);
});

test("a retry that applies every sent-back finding passes its first check, which reads the answers already on the row", (t) => {
  const f = fixture(t);
  deferBothOutside(f);
  escalated(f.check());
  mismatch(recordAnswers(f, ["--send-back", "survived[0],survived[1]"]));
  retry(f);
  // The retry applies both sent-back findings: the answers are met, and fix-pr-40-b is judged ok on its first check.
  const entries = f.baseEntries();
  f.writeRecord(entries, f.head, "fix-pr-40-b");
  okVerdict(f.check("fix-pr-40-b"));
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

// ---------------------------------------------------------------------------
// The filing table: where each deferral was filed, read back from the
// tracker, and the refuter verdict a suggestion carries.
// ---------------------------------------------------------------------------

const closed = (issue) => ({ ...issue, state: "CLOSED" });
const deferred = (bucket, index, more = {}) => ({ bucket, index, scope: "in", claimKind: "behavior", disposition: "defer", issue: 9, ...more });

test("run as a CLI with a remapped Label map, a home labelled with the mapped strings is judged ok and the role names are not", (t) => {
  const f = fixture(t, { labelMap: { roles: REMAP } });
  const log = join(f.dir, "gh.log");
  const check = () => f.check("fix-pr-40", cleanEnv({ FAKE_GH_LOG: log }));
  f.writeRecord(f.baseEntries());
  // The base record files its one deferral to #77, row 6b.
  f.setIssues({ 77: openIssue("triage") });
  okVerdict(check());
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.run}`), f.row());
  f.setIssues({ 77: openIssue("agent-ready") });
  okVerdict(check());
  f.setIssues({ 77: openIssue("needs-triage") });
  mismatch(check(), /unverified\[0\]: filing row 6b \(.*\): it belongs in an open issue labelled triage or agent-ready, and #77 is open, titled "a deferred finding", labelled needs-triage/);
  // The tracker is asked for the issue, never for a label by name: the mapped
  // strings reach the comparison and the wording, not gh's argv.
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).argv);
  assert.ok(calls.length > 0);
  for (const argv of calls) assert.ok(!argv.some((a) => Object.values(REMAP).includes(a) || Object.keys(REMAP).includes(a)), JSON.stringify(argv));
});

test("run as the verb with no Label map, nothing is judged or written, and the refusal names ensure", (t) => {
  const f = fixture(t, { labelMap: null });
  f.writeRecord(f.baseEntries());
  const before = f.row();
  const log = join(f.dir, "gh.log");
  const r = f.check("fix-pr-40", cleanEnv({ FAKE_GH_LOG: log }));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ledger: .*Label map.*label-map\.mjs ensure/);
  assert.equal(r.stdout, "");
  assert.equal(f.row(), before);
  assert.equal(existsSync(log), false, "the tracker was never asked");
});

test("a confirmed defect deferred for an allowed reason is ok filed needs-triage or promoted ready-for-agent, and a mismatch naming row 1 filed with no triage label", (t) => {
  const f = fixture(t);
  f.setIssues({ 81: { ...openIssue("needs-triage"), labels: [] } });
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer", reason: "mutual-exclusion", issue: 81 });
  f.writeRecord(entries);
  const r = f.check();
  mismatch(r, /^fix-pr-40: survived\[0\]: filing row 1 \(an in-scope survived finding deferred for an allowed reason other than false-rationale\): it belongs in an open issue labelled needs-triage or ready-for-agent, and #81 is open, titled "a deferred finding", labelled nothing$/m);
  assert.equal(r.json.violations.length, 1);
  assert.match(f.ledgerCli("dispatch", "40", "finisher-pr-40").stderr, /dispositions mismatch/);
  f.setIssues({ 81: openIssue("needs-triage") });
  okVerdict(f.check());
  f.setIssues({ 81: openIssue("ready-for-agent") });
  okVerdict(f.check());
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("a critical out-of-scope survivor filed open needs-triage is ok, never escalate; filed with no triage label or to the record it is a mismatch naming row 8", (t) => {
  const f = fixture(t);
  f.writeReview({ ...f.review, survived: [f.review.survived[0], { ...f.review.survived[1], severity: "critical" }] });
  f.setIssues({ 13: bandRecord(), 82: { ...openIssue("needs-triage"), labels: [] } });
  const entries = f.baseEntries();
  entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"], issue: 77 });
  f.writeRecord(entries);
  const r = f.check();
  okVerdict(r);
  assert.deepEqual(r.json.escalations, []);
  assert.ok(f.row().includes(`dispositions-ok=fix-pr-40:${f.run}`), f.row());
  for (const [issue, is] of [[82, "open, titled \"a deferred finding\", labelled nothing"], [13, "closed, titled \"PR #40 review: the suggestion band, checked\", labelled wontfix"]]) {
    for (const reason of ["remedy-outside-diff", "false-rationale"]) {
      entries[1] = f.entry("survived", 1, { scope: "out", disposition: "defer", reason, issue });
      f.writeRecord(entries);
      mismatch(f.check(), new RegExp(`^fix-pr-40: survived\\[1\\]: filing row 8 \\(an out-of-scope survived finding, whatever its reason\\): it belongs in an open issue labelled needs-triage or ready-for-agent, and #${issue} is ${is.replace(/[()]/g, "\\$&")}$`, "m"));
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
  assert.equal(r.json.token, `dispositions-unchecked=fix-pr-40:${f.run}`);
  assert.match(r.stderr, /^fix-pr-40: unverified\[0\]: where it was filed is unchecked — #77 could not be read through gh: error connecting to api\.github\.com$/m);
  assert.ok(f.row().includes(`dispositions-unchecked=fix-pr-40:${f.run}`), f.row());
  const before = readFileSync(join(f.dir, "ledger.md"), "utf8");
  const d = f.ledgerCli("dispatch", "40", "finisher-pr-40");
  assert.equal(d.status, 2);
  assert.match(d.stderr, /finisher-pr-40: dispositions unchecked — fix-pr-40's check of review run-Rv40Aa01 could not read where a deferral was filed/);
  assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), before, "a refused dispatch writes nothing");
  assert.deepEqual(dueUntilFixed(f), [40], "control");
  assert.deepEqual(fixDueFor(f), [], "an unchecked verdict is answered by re-running the check, never by a fix-applier");

  okVerdict(f.check());
  const row = f.row();
  assert.equal(row.match(/dispositions-/g).length, 1, row);
  assert.equal(f.okLedger("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("an issue gh cannot read is unchecked too, and a broken rule outranks it", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[2] = { ...entries[2], issue: 404 };
  f.writeRecord(entries);
  const r = f.check();
  assert.equal(r.json.verdict, "unchecked", r.stderr);
  assert.match(r.stderr, /unverified\[0\]: where it was filed is unchecked — #404 could not be read through gh: GraphQL: Could not resolve to an issue/);

  entries[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(entries);
  const broken = f.check("fix-pr-40", cleanEnv({ FAKE_GH_DOWN: "1" }));
  mismatch(broken, /^fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason/m);
  assert.match(broken.stderr, /unverified\[0\]: where it was filed is unchecked/);
});

// The verb reads the tracker before it takes the ledger's lock, and writes onto
// the row as the ledger stands once it has it: a token another writer put on
// that row while gh was being read is carried, not dropped. The stub's own
// `token` call waits on the lock for a second at most, so a verb that held the
// lock across its gh reads would fail the stub, and the case with it.
test("a token another writer puts on the row while the tracker is read lands beside the verdict", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const hook = JSON.stringify([process.execPath, LEDGER, "--file", join(f.dir, "ledger.md"), "token", "10", "ci=39722006612:1:success"]);
  const r = f.check("fix-pr-40", cleanEnv({ FAKE_GH_HOOK: hook, LEDGER_LOCK_TIMEOUT_MS: "1000" }));
  okVerdict(r);
  const row = f.row();
  assert.ok(row.includes("ci=39722006612:1:success"), row);
  assert.ok(row.includes(`dispositions-ok=fix-pr-40:${f.run}`), row);
});

test("a row that stopped carrying the member while its record was judged refuses the write, naming the verb to run again, and writes nothing", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const p = join(f.dir, "ledger.md");
  // The hook rewrites the row without the member, as a rotation or a hand edit might.
  const hookScript = join(f.dir, "drop-member.mjs");
  writeFileSync(hookScript, `import { readFileSync, writeFileSync } from "node:fs";\nconst p = ${JSON.stringify(p)};\nwriteFileSync(p, readFileSync(p, "utf8").replace(" · fix-pr-40=applied:${f.head.slice(0, 7)}", ""));\n`);
  const r = f.check("fix-pr-40", cleanEnv({ FAKE_GH_HOOK: JSON.stringify([process.execPath, hookScript]) }));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /fix-pr-40 is on no row of PR #40 now .* run `ledger\.mjs dispositions fix-pr-40 --scratch .*` again/);
  assert.equal(r.stdout, "");
  assert.ok(!readFileSync(p, "utf8").includes("dispositions-"), "nothing was written");
});

// Two answer runs that read the same escalate: the hook runs the first, a
// --send-back, once, while the second, an --uphold, reads the tracker. The
// second takes the lock after the first wrote, so the escalate it answers is
// gone, and it must not lay an upheld answer and an ok over the sent-back one.
test("an answer run whose escalate another answer run cleared while the tracker was read writes nothing and exits 2, naming the verb to run again", (t) => {
  const f = fixture(t);
  deferOutside(f, ["src/b.js"]);
  escalated(f.check());
  const p = join(f.dir, "ledger.md");
  const [marker, firstOut, hookScript] = ["first-ran", "first.json", "send-back-first.mjs"].map((n) => join(f.dir, n));
  const firstArgv = [LEDGER, "--file", p, "dispositions", "fix-pr-40", "--scratch", f.scratch, "--repo", f.repo, "--send-back", "survived[0]"];
  writeFileSync(hookScript, `import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (!existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, "");
  const env = { ...process.env };
  delete env.FAKE_GH_HOOK;
  const r = spawnSync(process.execPath, ${JSON.stringify(firstArgv)}, { encoding: "utf8", env, cwd: ${JSON.stringify(f.dir)} });
  writeFileSync(${JSON.stringify(firstOut)}, JSON.stringify({ status: r.status, stderr: r.stderr }));
}
`);
  const r = f.check("fix-pr-40", cleanEnv({ FAKE_GH_HOOK: JSON.stringify([process.execPath, hookScript]) }), ["--uphold", "survived[0]"]);
  const first = JSON.parse(readFileSync(firstOut, "utf8"));
  assert.equal(first.status, 1, `control: the first answer run wrote its mismatch\n${first.stderr}`);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the ledger changed while fix-pr-40's record was judged — PR #40's current dispositions verdict on review run-Rv40Aa01 is mismatch from fix-pr-40, not an escalate .*; nothing written, run `ledger\.mjs dispositions fix-pr-40 --scratch .*` again/);
  assert.equal(r.stdout, "");
  const row = f.row();
  assert.ok(row.includes(`escalation-answer=${f.run}:survived[0]:sent-back`), row);
  assert.ok(row.includes(`dispositions-mismatch=fix-pr-40:${f.run}`), row);
  assert.doesNotMatch(row, /:upheld|dispositions-ok=/);
  assert.equal(f.ledgerCli("dispatch", "40", "finisher-pr-40").status, 2, "the finisher stays refused");
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
    [f.writeVerdict({ refuted: true, reason: "r", inconclusive: true }, "7"), /verdictPath "[^"]*" is inconclusive — its refuter abstained/],
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

test("an out-of-scope suggestion refuted and filed as an open issue is a mismatch naming row 6a; filed to the closed record it is ok", (t) => {
  const f = fixture(t);
  const verdictPath = f.writeVerdict({ refuted: true, reason: "the probe ran clean" });
  const entries = f.baseEntries();
  // Issue 77 is open, labelled needs-triage: a refuted finding filed as open work.
  entries[2] = { ...entries[2], verdictPath };
  f.writeRecord(entries);
  mismatch(f.check(), /^fix-pr-40: unverified\[0\]: filing row 6a \(an out-of-scope suggestion alleging wrong behavior, its refuter refuted it\): it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wontfix, and #77 is open/m);
  f.setIssues({ 78: bandRecord() });
  entries[2] = { ...entries[2], issue: 78 };
  f.writeRecord(entries);
  okVerdict(f.check());
});

test("an out-of-scope suggestion above the claim bar with no verdictPath, or one that is no refuter's location, is a mismatch; one whose refuter crashed or abstained files open needs-triage", (t) => {
  const f = fixture(t);
  f.setIssues({ 78: bandRecord() });
  // unverified[0], an untouched line declared out of scope.
  const deferWith = (verdictPath, issue = 77) => {
    const entries = f.baseEntries();
    const { verdictPath: _, ...bare } = entries[2];
    entries[2] = { ...bare, issue, ...(verdictPath === undefined ? {} : { verdictPath }) };
    f.writeRecord(entries);
    return f.check();
  };
  const noEvidence = /^fix-pr-40: unverified\[0\]: an out-of-scope suggestion alleging wrong behavior carries no refuter evidence — /m;
  mismatch(deferWith(undefined), /unverified\[0\]: an out-of-scope suggestion alleging wrong behavior carries no refuter evidence — its entry names no verdictPath; claimKind behavior puts it above the claim bar/);
  mkdirSync(join(f.scratch, "pr40", "fix-Ab12Cd34", "2"), { recursive: true });
  for (const [path, why] of [
    ["pr40/fix-Ab12Cd34/1/verdict.json", /is not an absolute path/],
    [f.writeVerdict({ refuted: false, reason: "r" }, "1", join(f.scratch, "pr40", "elsewhere")), /is not under a fix-applier run root/],
    [f.writeVerdict({ refuted: false, reason: "r" }, "1", join(f.dir, "pr40", "fix-Ab12Cd34")), /is not under a fix-applier run root/],
    // No run directory either: no fix-applier round ever made a refuter's location there.
    [join(f.scratch, "pr40", "fix-Zz99Zz99", "2", "verdict.json"), /names no file that exists/],
    // The run directory exists but its finding directory was never made: no refuter ever ran.
    [join(f.scratch, "pr40", "fix-Ab12Cd34", "9", "verdict.json"), /names no file that exists/],
  ]) {
    const r = deferWith(path);
    mismatch(r, noEvidence);
    assert.match(r.stderr, why, path);
  }
  // A refuter that crashed before writing its verdict, wrote a broken one,
  // or abstained decided nothing.
  for (const path of [
    join(f.scratch, "pr40", "fix-Ab12Cd34", "2", "verdict.json"),
    f.writeVerdict("{not json", "3"),
    f.writeVerdict({ refuted: "yes", reason: "r" }, "4"),
    f.writeVerdict({ refuted: true, reason: "r", inconclusive: true }, "5"),
  ]) {
    okVerdict(deferWith(path));
    mismatch(deferWith(path, 78), /^fix-pr-40: unverified\[0\]: filing row 6b \(an out-of-scope suggestion alleging wrong behavior, its refuter let it survive, crashed or abstained\): it belongs in an open issue labelled needs-triage or ready-for-agent, and #78 is closed/m);
  }
});

test("an out-of-scope suggestion below the claim bar names no verdictPath and files to the closed record", (t) => {
  const f = fixture(t);
  f.setIssues({ 78: bandRecord() });
  const entries = f.baseEntries();
  const { verdictPath: _, ...bare } = entries[2];
  entries[2] = { ...bare, claimKind: "shape", issue: 78 };
  f.writeRecord(entries);
  okVerdict(f.check());
  entries[2] = { ...entries[2], issue: 77 };
  f.writeRecord(entries);
  mismatch(f.check(), /^fix-pr-40: unverified\[0\]: filing row 7 \(/m);
});

// ---------------------------------------------------------------------------
// Charges: on the record answering a PR's first review, every entry whose
// finding stands carries one.
// ---------------------------------------------------------------------------

const uncharged = ({ charge: _c, chargeReason: _r, ...rest }) => rest;
const TRIAGE = { state: "OPEN", title: "a deferred finding", labels: ["needs-triage"] };
// survived[0] on touched src/a.js:5; survived[1] on untouched src/a.js:12.
const TWO = [{ file: "src/a.js", line: 5 }, { file: "src/a.js", line: 12 }];
const charged = (entries, opts = {}) => core(entries, { survived: TWO, issues: { 81: TRIAGE }, charges: true, ...opts });

test("the CLI requires Charges on the record answering the PR's first review, and on no later one", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[0] = uncharged(entries[0]);
  f.writeRecord(entries);
  mismatch(f.check(), /^fix-pr-40: survived\[0\]: a finding that stands on the PR's first review carries a Charge/m);
  f.writeRecord(f.baseEntries());
  okVerdict(f.check());

  // A second review, answered by fix-pr-40-b: the first review stays the
  // one fix-pr-40 answered, so this record needs no Charge.
  const later = "run-Rv40Bb02";
  f.okLedger("review", "40", "review=member:review-pr-40-b", `reviewed=${f.head}:2/1/1:${later}`);
  f.okLedger("dispatch", "40", "fix-pr-40-b");
  mkdirSync(join(f.scratch, "pr40", later), { recursive: true });
  writeFileSync(join(f.scratch, "pr40", later, "review.json"), JSON.stringify(f.review));
  f.writeRecord(f.baseEntries().map(uncharged), f.head, "fix-pr-40-b", later);
  const r = f.check("fix-pr-40-b");
  okVerdict(r);
  assert.equal(r.json.token, `dispositions-ok=fix-pr-40-b:${later}`);
});

test("the CLI reads a review no fix-applier answered as superseded: the next answered one is the first review", (t) => {
  const f = fixture(t);
  // PR 40's review `f.run` drew no fix-applier's record before a second review returned.
  const later = "run-Rv40Bb02";
  f.okLedger("review", "40", "review=member:review-pr-40-b", `reviewed=${f.head}:2/1/1:${later}`);
  f.okLedger("dispatch", "40", "fix-pr-40-b");
  mkdirSync(join(f.scratch, "pr40", later), { recursive: true });
  writeFileSync(join(f.scratch, "pr40", later, "review.json"), JSON.stringify(f.review));
  f.writeRecord(f.baseEntries().map(uncharged), f.head, "fix-pr-40-b", later);
  mismatch(f.check("fix-pr-40-b"), /^fix-pr-40-b: survived\[0\]: a finding that stands on the PR's first review carries a Charge/m);
});
