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
import { SCHEMAS, validate } from "../plugin/scripts/report-schema.mjs";
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
  assertInvalid(check("impl", variant("impl", { outcome: "merged" })), '$.outcome: "merged" is not one of "pr", "bailed"');
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
  assert.equal(validate(SCHEMAS.impl, variant("impl", { outcome: "x" })), '$.outcome: "x" is not one of "pr", "bailed"');
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

test("SCHEMAS uses only the keywords validate() implements", () => {
  const supported = new Set(["type", "enum", "pattern", "required", "properties", "additionalProperties", "items"]);
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
