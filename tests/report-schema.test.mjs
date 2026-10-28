// Regression gate for report-schema.mjs: one JSON Schema per member family and
// the CLI that prints it or validates a report file against it. Zero deps:
// `node --test tests/report-schema.test.mjs`.
//
// Every invalid case starts from its family's valid fixture and changes one
// thing, so the violation it names is the one the case is about. The expected
// text is the whole verdict line: a validator that still exits 1 but names
// some other violation reds here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { SCHEMAS, validate, reportViolation } from "../plugin/scripts/report-schema.mjs";
import { HALT_CAUSES } from "../plugin/scripts/ledger-grammar.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/report-schema.mjs", import.meta.url));
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const DIR = tempDir("report-schema-");

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

let seq = 0;
const file = (content) => {
  const path = join(DIR, `report-${seq++}.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};

const check = (family, report) => run("validate", family, file(report));

// The fields each family's report carries, as the ticket's table names them.
const FIELDS = {
  impl: ["member", "outcome", "pr", "head", "branch", "sizing", "bailCause", "bailDetail", "confirmation"],
  "fix-pr": ["member", "outcome", "head", "branch", "applied", "deferred", "filed", "unrecorded", "dispositionsRecord", "testRun", "confirmation"],
  finisher: ["member", "outcome", "cause", "evidence", "pin", "labelsReadBack", "kill", "filed", "unrecorded", "confirmation"],
  "merge-bot": ["member", "merged", "held", "conflictHold", "refused", "branchKept"],
};

const VALID = {
  impl: {
    member: "impl-412",
    outcome: "pr",
    pr: 3300,
    head: SHA,
    branch: "implementer/412-impl-412",
    sizing: { verdict: "heavy", signal: ">3 implementation files", ranBeforePr: true },
    bailCause: null,
    bailDetail: null,
    confirmation: ["no warning received"],
  },
  "fix-pr": {
    member: "fix-pr-3300",
    outcome: "applied",
    head: SHA,
    branch: "implementer/412-impl-412",
    applied: [{ bucket: "apply", index: 0 }],
    deferred: [{ bucket: "refuted", index: 1, issue: 3301 }],
    filed: [{ issue: 3301, subject: "a deferred finding" }],
    unrecorded: [],
    dispositionsRecord: "/tmp/scratch/fix-pr-3300/dispositions.json",
    testRun: { cmd: "./agent-test", exit: 0, tests: 640, cancelled: 0 },
    confirmation: [],
  },
  finisher: {
    member: "finisher-pr-3300",
    outcome: "labelled",
    cause: null,
    evidence: null,
    pin: SHA,
    labelsReadBack: ["patch", "ready-to-merge"],
    kill: { red: "red: ./agent-test t.mjs → exit 1, fail 1 incl x", baseline: "baseline: ./agent-test t.mjs → exit 0, x pass" },
    filed: [],
    unrecorded: [{ issue: 3302, subject: "filed, not recorded" }],
    confirmation: [],
  },
  "merge-bot": {
    member: "merge-bot-1",
    merged: [{ pr: 3300, sha: SHA }],
    held: [{ pr: 3304, behind: 3300 }],
    conflictHold: [3305],
    refused: [{ pr: 3306, reason: "ci-wait-timeout" }],
    branchKept: [{ pr: 3300, by: 3307 }],
  },
};

const FAMILIES = Object.keys(FIELDS);

// `report` with `changes` merged over it; a key set to `undefined` is dropped.
const variant = (family, changes) => {
  const out = { ...VALID[family], ...changes };
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete out[k];
  return out;
};

const assertInvalid = (r, violation) => {
  assert.equal(r.status, 1, `exit ${r.status}, stderr: ${r.stderr}`);
  assert.equal(r.stdout, `invalid: ${violation}\n`);
};

test("the module carries exactly the four families, review-pr not among them", () => {
  assert.deepEqual(Object.keys(SCHEMAS).sort(), [...FAMILIES].sort());
});

for (const family of FAMILIES) {
  test(`print ${family} emits the family's schema as valid JSON`, () => {
    const r = run("print", family);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), SCHEMAS[family]);
  });

  test(`${family}: every ticket field is a required property, and the top level is closed`, () => {
    const s = SCHEMAS[family];
    assert.equal(s.type, "object");
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), [...FIELDS[family]].sort());
    assert.deepEqual(Object.keys(s.properties).sort(), [...FIELDS[family]].sort());
  });

  test(`validate ${family} passes the family's fixture`, () => {
    const r = check(family, VALID[family]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "valid\n");
  });

  test(`validate ${family} fails a report missing a required field, naming it`, () => {
    const missing = FIELDS[family][2];
    assertInvalid(check(family, variant(family, { [missing]: undefined })), `$: missing required field "${missing}"`);
  });

  test(`validate ${family} fails an extra top-level key, naming it`, () => {
    assertInvalid(check(family, variant(family, { notes: "free text" })), '$: unexpected field "notes"');
  });
}

// A key that exists on Object.prototype is still unexpected. Written as raw
// JSON text: a `constructor` key in a JS object literal would be fine, but a
// text fixture keeps the case independent of how the report is built.
test("validate fails an Object.prototype-named top-level key, naming it", () => {
  const raw = JSON.stringify(VALID.impl).replace(/}$/, ',"constructor":"x"}');
  assertInvalid(check("impl", raw), '$: unexpected field "constructor"');
});

test("validate fails a bad enum value in each family that has an enum, naming it", () => {
  assertInvalid(check("impl", variant("impl", { outcome: "merged" })), '$.outcome: "merged" is not one of "pr", "bailed", "blocked"');
  assertInvalid(check("fix-pr", variant("fix-pr", { outcome: "done" })), '$.outcome: "done" is not one of "applied", "no-op", "failed"');
  assertInvalid(
    check("finisher", variant("finisher", { cause: "flaky" })),
    `$.cause: "flaky" is not one of ${[...HALT_CAUSES, null].map((c) => JSON.stringify(c)).join(", ")}`,
  );
});

// The finisher's `cause` is the ledger's `halted:<cause>` vocabulary, so a
// cause the ledger grammar accepts is one a finisher's report may name.
test("validate passes every halt cause the ledger grammar accepts", () => {
  assert.ok(HALT_CAUSES.length > 0, "the ledger exports no halt cause — the loop below would pass vacuously");
  for (const cause of HALT_CAUSES) {
    const r = check("finisher", variant("finisher", { outcome: "halted", cause }));
    assert.equal(r.status, 0, `cause ${cause}: ${r.stdout}${r.stderr}`);
  }
});

// merge-bot's fields carry no enum, so it has no bad-enum variant. Asserted
// rather than assumed: an enum added to it later reds here and asks for one.
test("merge-bot's schema carries no enum anywhere", () => {
  const enums = (node) =>
    node && typeof node === "object" ? ("enum" in node ? 1 : 0) + Object.values(node).reduce((n, v) => n + enums(v), 0) : 0;
  assert.equal(enums(SCHEMAS["merge-bot"]), 0);
  assert.ok(enums(SCHEMAS.impl) > 0, "the walk finds no enum where one exists — it would pass merge-bot vacuously");
});

test("validate fails a bad hex in each family, naming it", () => {
  assertInvalid(check("impl", variant("impl", { head: "abc123" })), '$.head: "abc123" does not match ^[0-9a-f]{40}$');
  assertInvalid(check("fix-pr", variant("fix-pr", { head: SHA.toUpperCase() })), `$.head: "${SHA.toUpperCase()}" does not match ^[0-9a-f]{40}$`);
  assertInvalid(check("finisher", variant("finisher", { pin: `${SHA}0` })), `$.pin: "${SHA}0" does not match ^[0-9a-f]{40}$`);
  assertInvalid(
    check("merge-bot", variant("merge-bot", { merged: [{ pr: 3300, sha: OTHER }, { pr: 3301, sha: "deadbeef" }] })),
    '$.merged[1].sha: "deadbeef" does not match ^[0-9a-f]{40}$',
  );
});

test("validate fails a relative fix-pr dispositionsRecord, naming it", () => {
  assertInvalid(check("fix-pr", variant("fix-pr", { dispositionsRecord: "relative/path.json" })), '$.dispositionsRecord: "relative/path.json" does not match ^/');
});

// A refusal's reason is the record `## Ruled` gets, so a refusal with none is
// no verdict: empty or whitespace-only, it is invalid, and any text is valid.
test("validate fails a merge-bot refusal whose reason is empty or only whitespace, naming it", () => {
  for (const reason of ["", " ", "\t\n"]) {
    assertInvalid(
      check("merge-bot", variant("merge-bot", { refused: [{ pr: 3310, reason }] })),
      `$.refused[0].reason: ${JSON.stringify(reason)} does not match \\S`,
    );
  }
  assert.equal(check("merge-bot", variant("merge-bot", { refused: [{ pr: 3310, reason: " behind:2 " }] })).status, 0);
});

test("validate fails a wrong type, naming the expected and the given", () => {
  assertInvalid(check("impl", variant("impl", { pr: "3300" })), "$.pr: expected integer or null, got string");
  assertInvalid(check("impl", variant("impl", { pr: 3300.5 })), "$.pr: expected integer or null, got number");
  assertInvalid(check("finisher", variant("finisher", { labelsReadBack: "patch" })), "$.labelsReadBack: expected array, got string");
  assertInvalid(check("impl", variant("impl", { confirmation: ["ok", 7] })), "$.confirmation[1]: expected string, got integer");
});

test("validate checks each object in an array of objects", () => {
  assertInvalid(check("fix-pr", variant("fix-pr", { applied: [{ bucket: "apply", index: 0 }, { bucket: "apply" }] })), '$.applied[1]: missing required field "index"');
  assertInvalid(check("fix-pr", variant("fix-pr", { filed: ["#3301"] })), "$.filed[0]: expected object, got string");
  assertInvalid(check("fix-pr", variant("fix-pr", { testRun: { cmd: "./agent-test", exit: 0, tests: 640 } })), '$.testRun: missing required field "cancelled"');
  assertInvalid(check("impl", variant("impl", { sizing: { verdict: "medium", signal: "x", ranBeforePr: true } })), '$.sizing.verdict: "medium" is not one of "light", "heavy"');
});

test("validate names only the FIRST violation: required before unexpected, top level before nested", () => {
  assertInvalid(check("impl", variant("impl", { branch: undefined, notes: "x", outcome: "merged" })), '$: missing required field "branch"');
  assertInvalid(check("impl", variant("impl", { notes: "x", outcome: "merged" })), '$: unexpected field "notes"');
});

// What the validator must ACCEPT: the nulls each family allows, an absolute
// path, empty arrays. A guard that refuses these is wrong in the other
// direction from every case above.
test("validate passes the null and empty shapes each family allows", () => {
  const ok = (family, changes) => {
    const r = check(family, variant(family, changes));
    assert.equal(r.status, 0, `${family} ${JSON.stringify(changes)}: ${r.stdout}${r.stderr}`);
  };
  ok("impl", { outcome: "bailed", pr: null, head: null, sizing: null, bailCause: "hands", bailDetail: "needs a maintainer's credentials" });
  ok("impl", { outcome: "bailed", pr: null, head: null, sizing: null, bailCause: "fixed", bailDetail: "abc1234 — origin/main's guard already refuses the input" });
  ok("impl", { outcome: "bailed", pr: null, head: null, sizing: null, bailCause: "covered", bailDetail: "PR#77 — its diff adds the same guard" });
  ok("impl", { outcome: "blocked", pr: null, head: null, sizing: null, bailCause: null, bailDetail: "the ticket's two criteria contradict once the parser exists" });
  ok("impl", { sizing: { verdict: "light", signal: "one file", ranBeforePr: false }, confirmation: [] });
  ok("fix-pr", { outcome: "no-op", applied: [], deferred: [], filed: [] });
  ok("finisher", { outcome: "halted", cause: "live-editor", evidence: "a member still edits the worktree", kill: null, labelsReadBack: [] });
  ok("merge-bot", { merged: [], held: [], conflictHold: [], refused: [], branchKept: [] });
});

test("validate fails a file that is not JSON", () => {
  const r = run("validate", "impl", file("{ not json"));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^invalid: \$: not JSON \(.+\)\n$/);
});

test("validate() answers null for a valid report and the violation text otherwise", () => {
  assert.equal(validate(SCHEMAS.impl, VALID.impl), null);
  assert.equal(validate(SCHEMAS.impl, variant("impl", { outcome: "x" })), '$.outcome: "x" is not one of "pr", "bailed", "blocked"');
});

// One verdict per PR is a rule no schema keyword states, so validate() alone
// passes a PR named twice; `validate` and reportViolation() refuse it at its
// second entry. `branchKept` names a merged PR without giving it a verdict.
test("validate refuses a merge-bot report giving one PR two verdicts, in two lists or in one, and accepts one verdict each", () => {
  for (const [changes, said] of [
    [{ refused: [{ pr: 3300, reason: "behind:2" }] }, "$.refused[0].pr: PR #3300 already has a verdict at $.merged[0].pr"],
    [{ conflictHold: [3304] }, "$.conflictHold[0]: PR #3304 already has a verdict at $.held[0].pr"],
    [{ held: [{ pr: 3305, behind: 3300 }] }, "$.conflictHold[0]: PR #3305 already has a verdict at $.held[0].pr"],
    [{ merged: [{ pr: 3300, sha: SHA }, { pr: 3300, sha: SHA }] }, "$.merged[1].pr: PR #3300 already has a verdict at $.merged[0].pr"],
    [{ refused: [{ pr: 3306, reason: "a" }, { pr: 3306, reason: "b" }] }, "$.refused[1].pr: PR #3306 already has a verdict at $.refused[0].pr"],
  ]) {
    const report = variant("merge-bot", changes);
    assert.equal(validate(SCHEMAS["merge-bot"], report), null, said);
    assert.equal(reportViolation("merge-bot", report), said);
    assertInvalid(check("merge-bot", report), said);
  }
  assert.equal(reportViolation("merge-bot", VALID["merge-bot"]), null);
  assert.equal(check("merge-bot", VALID["merge-bot"]).status, 0, "one verdict each, a merged PR's branchKept entry beside it, is valid");
  assert.equal(reportViolation("impl", VALID.impl), null);
});

// A block names no cause and no PR, and gives its reason: rules no schema
// keyword states, so validate() alone passes a block that breaks them;
// `validate` and reportViolation() refuse it. A bail keeps its own shape.
test("validate refuses a blocked impl report that names a bailCause, a pr or a head, or gives no bailDetail, and accepts one with its reason", () => {
  const blocked = (changes) => variant("impl", { outcome: "blocked", pr: null, head: null, bailCause: null, bailDetail: "needs a ruling", ...changes });
  for (const [changes, said] of [
    [{ bailCause: "fork" }, '$.bailCause: "fork" is not null, with outcome "blocked" — a block is no bail'],
    [{ bailDetail: null }, '$.bailDetail: null is not a reason, with outcome "blocked"'],
    [{ bailDetail: "" }, '$.bailDetail: "" is not a reason, with outcome "blocked"'],
    [{ bailDetail: " \t\n" }, '$.bailDetail: " \\t\\n" is not a reason, with outcome "blocked"'],
    [{ pr: 6 }, '$.pr: 6 is not null, with outcome "blocked" — a block reports no PR'],
    [{ head: "a".repeat(40) }, `$.head: "${"a".repeat(40)}" is not null, with outcome "blocked" — a block reports no PR`],
  ]) {
    const report = blocked(changes);
    assert.equal(validate(SCHEMAS.impl, report), null, said);
    assert.equal(reportViolation("impl", report), said);
    assertInvalid(check("impl", report), said);
  }
  assert.equal(reportViolation("impl", blocked({})), null);
  assert.equal(check("impl", blocked({})).status, 0, "a block with its reason is valid");
  assert.equal(reportViolation("impl", variant("impl", { outcome: "bailed", pr: null, head: null, bailCause: null, bailDetail: null })), null,
    "a bail's shape is not a block's");
});

// A bail is the pre-code outcome, so it names no PR and no head — a PR the
// member opened is outcome `pr`, which settle checks. validate() alone passes
// a bail that names one; `validate` and reportViolation() refuse it. A bail
// with both null stays valid, a `covered` one naming its PR in bailDetail too.
test("validate refuses a bailed impl report that names a pr or a head, and accepts one with both null", () => {
  const bailed = (changes) => variant("impl", { outcome: "bailed", pr: null, head: null, bailCause: "hands", bailDetail: "needs a token", ...changes });
  for (const [changes, said] of [
    [{ pr: 12 }, '$.pr: 12 is not null, with outcome "bailed" — a bail reports no PR'],
    [{ head: "a".repeat(40) }, `$.head: "${"a".repeat(40)}" is not null, with outcome "bailed" — a bail reports no PR`],
    [{ bailCause: "covered", bailDetail: "PR#9 — its diff meets the acceptance", pr: 9 }, '$.pr: 9 is not null, with outcome "bailed" — a bail reports no PR'],
  ]) {
    const report = bailed(changes);
    assert.equal(validate(SCHEMAS.impl, report), null, said);
    assert.equal(reportViolation("impl", report), said);
    assertInvalid(check("impl", report), said);
  }
  assert.equal(reportViolation("impl", bailed({})), null);
  assert.equal(check("impl", bailed({})).status, 0, "a bail naming no PR and no head is valid");
  const covered = bailed({ bailCause: "covered", bailDetail: "PR#9 — its diff meets the acceptance" });
  assert.equal(reportViolation("impl", covered), null);
  assert.equal(check("impl", covered).status, 0, "a covered bail names its PR in bailDetail, not in pr");
});

// A conflict hold and a red-check fix write no dispositions record, and a
// no-op or a failed fix may have run no tests: such a report says `null`
// there rather than inventing a value (#3889).
const quiet = (changes) => variant("fix-pr", { applied: [], deferred: [], filed: [], dispositionsRecord: null, testRun: null, ...changes });

test("validate accepts a no-op or failed fix-pr report with a null dispositionsRecord and a null testRun", () => {
  for (const outcome of ["no-op", "failed"]) {
    const report = quiet({ outcome });
    assert.equal(reportViolation("fix-pr", report), null, outcome);
    const r = check("fix-pr", report);
    assert.equal(r.status, 0, `${outcome}: ${r.stdout}${r.stderr}`);
  }
});

// Null is the absence of a run or a record, never a licence for less: a
// no-op or failed report that did run its tests or write its record keeps
// saying so, and a non-null value is still held to its shape.
test("validate accepts a no-op or failed fix-pr report naming a real test run or record, and still checks a non-null one's shape", () => {
  for (const outcome of ["no-op", "failed"]) {
    for (const changes of [
      { testRun: { cmd: "./agent-test", exit: 0, tests: 640, cancelled: 0 } },
      { dispositionsRecord: "/tmp/scratch/dispositions-fix-pr-3300.json" },
    ]) {
      const r = check("fix-pr", quiet({ outcome, ...changes }));
      assert.equal(r.status, 0, `${outcome} ${JSON.stringify(changes)}: ${r.stdout}${r.stderr}`);
    }
  }
  assertInvalid(check("fix-pr", quiet({ outcome: "no-op", testRun: { cmd: "t", exit: 0, tests: 1 } })), '$.testRun: missing required field "cancelled"');
  assertInvalid(check("fix-pr", quiet({ outcome: "no-op", dispositionsRecord: "rel.json" })), '$.dispositionsRecord: "rel.json" does not match ^/');
  assertInvalid(check("fix-pr", quiet({ outcome: "no-op", testRun: "none" })), "$.testRun: expected object or null, got string");
});

// An applied fix is a commit the controller trusts on its test run, so a
// null testRun is invalid there: a rule no schema keyword states, so
// validate() alone passes it and reportViolation() refuses it.
test("validate refuses an applied fix-pr report with a null testRun", () => {
  const said = '$.testRun: null, with outcome "applied" — an applied fix reports the test run behind it';
  const report = variant("fix-pr", { testRun: null });
  assert.equal(validate(SCHEMAS["fix-pr"], report), null);
  assert.equal(reportViolation("fix-pr", report), said);
  assertInvalid(check("fix-pr", report), said);
  assert.equal(reportViolation("fix-pr", variant("fix-pr", { dispositionsRecord: null, deferred: [] })), null,
    "an applied conflict or red-check fix names no dispositions record");
});

// Settle reads a refuted deferral's reason out of the dispositions record, so
// a report naming one with no record is invalid, whatever its outcome — the
// report check refuses it before settle ever opens a path.
test("validate refuses a fix-pr report deferring a refuted finding with a null dispositionsRecord, and accepts other deferrals without one", () => {
  for (const outcome of ["applied", "no-op", "failed"]) {
    const report = variant("fix-pr", { outcome, dispositionsRecord: null, deferred: [{ bucket: "survived", index: 0, issue: 3302 }, { bucket: "refuted", index: 1, issue: 3301 }] });
    const said = "$.dispositionsRecord: null, with a refuted deferral at $.deferred[1] — settle reads its reason from that record";
    assert.equal(validate(SCHEMAS["fix-pr"], report), null, outcome);
    assert.equal(reportViolation("fix-pr", report), said, outcome);
    assertInvalid(check("fix-pr", report), said);
  }
  const r = check("fix-pr", quiet({ outcome: "no-op", deferred: [{ bucket: "survived", index: 0, issue: 3302 }] }));
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("print fix-pr shows dispositionsRecord and testRun as nullable", () => {
  const r = run("print", "fix-pr");
  assert.equal(r.status, 0, r.stderr);
  const { properties } = JSON.parse(r.stdout);
  assert.deepEqual(properties.dispositionsRecord.type, ["string", "null"]);
  assert.deepEqual(properties.testRun.type, ["object", "null"]);
});

// Exit 2: the invocation or the file, never the report.
for (const [why, args, said] of [
  ["no subcommand", [], "usage:"],
  ["an unknown subcommand", ["check", "impl"], "usage:"],
  ["print with no family", ["print"], "usage:"],
  ["print with an extra argument", ["print", "impl", "x"], "usage:"],
  ["validate with no file", ["validate", "impl"], "usage:"],
  ["validate with an extra argument", ["validate", "impl", "f.json", "x"], "usage:"],
  ["print of an unknown family", ["print", "review-pr"], "unknown family 'review-pr'"],
  ["validate of an unknown family", ["validate", "nope", "/nonexistent"], "unknown family 'nope'"],
  ["an unknown flag", ["print", "impl", "--json"], "unknown flag --json"],
]) {
  test(`${why} is exit 2`, () => {
    const r = run(...args);
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.includes(`report-schema: ${said}`), r.stderr);
  });
}

// A stdout that takes no bytes (fd 1 a read-only descriptor, so the write is
// refused) must not read as a printed schema: exit 2, nothing on stdout.
test("print whose stdout takes no bytes is exit 2", () => {
  const r = spawnSync("/bin/sh", ["-c", `"$0" "$1" print impl 1<&0`, process.execPath, SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes("report-schema: the schema could not be written to stdout"), r.stderr);
});

test("validate of an unreadable file is exit 2, naming the file", () => {
  const missing = join(DIR, "absent.json");
  const r = run("validate", "impl", missing);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes(`report-schema: cannot read ${missing}`), r.stderr);

  const dir = join(DIR, "a-directory");
  mkdirSync(dir);
  const d = run("validate", "impl", dir);
  assert.equal(d.status, 2, d.stdout);
  assert.ok(d.stderr.includes(`report-schema: cannot read ${dir}`), d.stderr);
});

// Integers. Every id is a positive safe integer; the other integers are only
// held to the safe range, so a truthful negative `exit` stays valid.
const MAX = "9007199254740991";
const withText = (family, changes, from, to) => JSON.stringify(variant(family, changes)).replace(from, to);

test("validate fails an integer above the safe range, naming the parsed value", () => {
  const text = withText("impl", {}, '"pr":3300', '"pr":9007199254740993');
  assertInvalid(run("validate", "impl", file(text)), "$.pr: 9007199254740992 is above maximum 9007199254740991");
  const huge = withText("impl", {}, '"pr":3300', '"pr":12345678901234567890123');
  assertInvalid(run("validate", "impl", file(huge)), "$.pr: 1.2345678901234568e+22 is above maximum 9007199254740991");
});

test("validate bounds the safe range exactly, on both sides", () => {
  const top = withText("impl", {}, '"pr":3300', `"pr":${MAX}`);
  assert.equal(run("validate", "impl", file(top)).status, 0);
  const exit = (n) => withText("fix-pr", {}, '"exit":0', `"exit":${n}`);
  assert.equal(run("validate", "fix-pr", file(exit(`-${MAX}`))).status, 0);
  assertInvalid(run("validate", "fix-pr", file(exit("-9007199254740993"))), "$.testRun.exit: -9007199254740992 is below minimum -9007199254740991");
});

test("validate holds an id to at least 1 and leaves the other integers their zero and negatives", () => {
  assertInvalid(check("finisher", variant("finisher", { unrecorded: [{ issue: 0, subject: "s" }] })), "$.unrecorded[0].issue: 0 is below minimum 1");
  assertInvalid(check("finisher", variant("finisher", { unrecorded: [{ issue: -3, subject: "s" }] })), "$.unrecorded[0].issue: -3 is below minimum 1");
  assertInvalid(check("merge-bot", variant("merge-bot", { conflictHold: [0] })), "$.conflictHold[0]: 0 is below minimum 1");
  const ok = check("fix-pr", variant("fix-pr", { applied: [{ bucket: "apply", index: 0 }], testRun: { cmd: "c", exit: -1, tests: 0, cancelled: 0 } }));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("validate passes a nullable impl pr that is null", () => {
  const r = check("impl", variant("impl", { outcome: "bailed", pr: null, head: null, sizing: null, bailCause: "hands", bailDetail: "d" }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// An id is a PR or issue number: a `pr`, `issue`, `behind` or `by` field, or
// a `conflictHold` item. It is held to 1; every other integer to the safe range.
test("print states the bounds on every integer node, minimum 1 on an id and the safe range elsewhere", () => {
  const IDS = new Set(["pr", "issue", "behind", "by", "conflictHold"]);
  const nodes = [];
  // `name` is the property a node sits under; an array's items keep it.
  const walk = (node, path, name) => {
    if ([].concat(node.type ?? []).includes("integer")) nodes.push({ node, path, id: IDS.has(name) });
    for (const [key, sub] of Object.entries(node.properties ?? {})) walk(sub, `${path}.${key}`, key);
    if (node.items !== undefined) walk(node.items, `${path}[]`, name);
  };
  for (const family of FAMILIES) {
    const printed = JSON.parse(run("print", family).stdout);
    walk(printed, `${family}:$`, null);
  }
  assert.ok(nodes.some((n) => n.id) && nodes.some((n) => !n.id));
  for (const { node, path, id } of nodes) {
    assert.equal(node.maximum, Number.MAX_SAFE_INTEGER, path);
    assert.equal(node.minimum, id ? 1 : -Number.MAX_SAFE_INTEGER, path);
  }
});

// Duplicate keys: JSON.parse keeps the last, so the text is scanned for them.
test("validate names a top-level duplicate key before any schema check, though its second value is also wrong", () => {
  const text = '{"member":"merge-bot-1","merged":[],"held":[],"conflictHold":[],"refused":[],"branchKept":[],"merged":[5]}';
  assertInvalid(run("validate", "merge-bot", file(text)), '$.merged: duplicate key "merged"');
  const first = '{"pr":"oops","pr":42}';
  assertInvalid(run("validate", "impl", file(first)), '$.pr: duplicate key "pr"');
});

test("validate names a nested duplicate key by its full path", () => {
  const text = `{"member":"merge-bot-1","merged":[{"pr":1,"sha":"${SHA}"},{"pr":2,"sha":"${SHA}","sha":"${OTHER}"}],"held":[],"conflictHold":[],"refused":[],"branchKept":[]}`;
  assertInvalid(run("validate", "merge-bot", file(text)), '$.merged[1].sha: duplicate key "sha"');
  const deep = '{"a":{"b":[[{"c":1,"c":2}]]}}';
  assertInvalid(run("validate", "impl", file(deep)), '$.a.b[0][0].c: duplicate key "c"');
});

test("validate compares keys decoded, so an escaped spelling of a key collides with the plain one", () => {
  assertInvalid(run("validate", "impl", file('{"a":1,"\\u0061":2}')), '$.a: duplicate key "a"');
  assertInvalid(run("validate", "impl", file('{"\\u0061":1,"a":2}')), '$.a: duplicate key "a"');
  assertInvalid(run("validate", "impl", file('{"x":{"q\\"":1,"q\\u0022":2}}')), '$.x.q": duplicate key "q\\""');
});

test("validate does not call the same key in two sibling or nested objects a duplicate", () => {
  const text = `{"member":"merge-bot-1","merged":[{"pr":1,"sha":"${SHA}"},{"pr":2,"sha":"${SHA}"}],"held":[{"pr":3,"behind":1}],"conflictHold":[],"refused":[{"pr":4,"reason":"r"}],"branchKept":[{"pr":1,"by":2}]}`;
  const r = run("validate", "merge-bot", file(text));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // A key whose value is a string that looks like a key is no key.
  const looks = check("impl", variant("impl", { confirmation: ['"member":', '{"x":1,"x":2}'] }));
  assert.equal(looks.status, 0, looks.stdout + looks.stderr);
});

test("validate reads text that is not JSON as `not JSON`, whether or not it also repeats a key", () => {
  const r = run("validate", "impl", file('{"a":1,"a":2'));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^invalid: \$: not JSON \(.+\)\n$/);
});

test("SCHEMAS uses only the keywords validate() implements", () => {
  const supported = new Set(["type", "enum", "pattern", "minimum", "maximum", "required", "properties", "additionalProperties", "items"]);
  let seen = 0;
  const walk = (node, at) => {
    for (const key of Object.keys(node)) {
      seen++;
      assert.ok(supported.has(key), `${at}: keyword '${key}' is not checked by validate()`);
    }
    for (const [k, sub] of Object.entries(node.properties ?? {})) walk(sub, `${at}.${k}`);
    if (node.items !== undefined) walk(node.items, `${at}[]`);
  };
  for (const [family, schema] of Object.entries(SCHEMAS)) walk(schema, family);
  assert.ok(seen > 0);
});
