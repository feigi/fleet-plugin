// report-files.mjs: which family a member's report belongs to, the file's state,
// and which implementer report of a ticket wins. The CLIs that consume it
// (tier-outcomes.mjs, member-outcomes.mjs) are driven in their own tests;
// these are the lookups' edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { latestImplReport, readReport, reportFamily, reportPath, reportStatus } from "../plugin/scripts/report-files.mjs";

const put = (scratch, name, body = "{}") => {
  mkdirSync(join(scratch, "reports"), { recursive: true });
  writeFileSync(join(scratch, "reports", name), body);
};

test("reportFamily maps the ledger's four member families to report-schema's and nothing else", () => {
  assert.equal(reportFamily("impl-412"), "impl");
  assert.equal(reportFamily("impl-412-b"), "impl");
  assert.equal(reportFamily("fix-pr-88"), "fix-pr");
  assert.equal(reportFamily("finisher-pr-88-c"), "finisher");
  assert.equal(reportFamily("merge-bot-3"), "merge-bot");
  for (const name of ["review-pr-88", "memory-proxy", "general-purpose", "fix-pr-88/fix-pr-88.RefuteN", "impl-0412", "merge-bot-3-b", ""]) {
    assert.equal(reportFamily(name), null, `${JSON.stringify(name)} has a schema`);
  }
});

test("reportStatus: `-` needs no scratch root at all, a covered member reads its file", () => {
  assert.equal(reportStatus(null, "review-pr-88"), "-");
  const scratch = tempDir("rf-");
  assert.equal(reportStatus(scratch, "impl-1"), "absent");
  put(scratch, "impl-1.json", "{}");
  assert.equal(reportStatus(scratch, "impl-1"), "invalid");
  assert.equal(readReport(scratch, "impl-1").path, reportPath(scratch, "impl-1"));
  assert.throws(() => readReport(scratch, "review-pr-88"), /no report schema/);
});

test("a report that repeats a key reads invalid, naming the duplicate before any schema check", () => {
  const scratch = tempDir("rf-");
  put(scratch, "merge-bot-1.json", '{"member":"merge-bot-1","merged":[],"held":[],"conflictHold":[],"refused":[],"branchKept":[],"merged":[5]}');
  const read = readReport(scratch, "merge-bot-1");
  assert.equal(read.state, "invalid");
  assert.equal(read.violation, '$.merged: duplicate key "merged"');
  put(scratch, "impl-2.json", "not json");
  assert.match(readReport(scratch, "impl-2").violation, /^\$: not JSON \(/);
});

test("latestImplReport: the highest letter wins, the unlettered name ranks lowest, and only this ticket's digits match", () => {
  const scratch = tempDir("rf-");
  assert.equal(latestImplReport(scratch, "10"), null, "no reports/ directory");
  put(scratch, "impl-10.json");
  assert.equal(latestImplReport(scratch, "10").member, "impl-10");
  put(scratch, "impl-10-b.json");
  put(scratch, "impl-10-d.json");
  put(scratch, "impl-10-c.json");
  for (const decoy of ["impl-100.json", "impl-1.json", "impl-10-bb.json", "impl-10-B.json", "impl-10.json.bak", "fix-pr-10.json", "impl-10-e.txt"]) put(scratch, decoy);
  const found = latestImplReport(scratch, "10");
  assert.equal(found.member, "impl-10-d");
  assert.equal(found.path, join(scratch, "reports", "impl-10-d.json"));
  assert.equal(latestImplReport(scratch, "11"), null);
});

test("a `reports` that is a regular file holds no report: absent, and no implementer report, never a throw", () => {
  const scratch = tempDir("rf-");
  writeFileSync(join(scratch, "reports"), "not a directory");
  assert.equal(readReport(scratch, "impl-1").state, "absent");
  assert.equal(latestImplReport(scratch, "1"), null);
});
