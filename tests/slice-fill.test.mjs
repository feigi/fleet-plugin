// slice-fill.mjs: sets `parent` on every ticket-features row whose ticket is a
// Slice, off its issue body, and changes nothing else — so a second run is a
// no-op and a run over rows drained without the column repairs them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_COLUMNS, parseFeatures } from "../plugin/scripts/pull-attribution.mjs";
import { fillParent } from "../plugin/scripts/slice-fill.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/slice-fill.mjs", import.meta.url));

const row = (o) => ({
  run_date: "2026-10-14", session: `s-${o.ticket}`, agent: `impl-${o.ticket}`, policy_cell: "slow-high", chosen_cell: "slow-high",
  exploration_draw: "", sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0",
  age_days: "0", paths: "0", test_paths: "0", xrefs: "0", kind: "", objective: "cost", ...o,
});
const tsv = (rows, cols = FEATURE_COLUMNS) => [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n";
const WITHOUT = FEATURE_COLUMNS.filter((c) => c !== "parent");

// Tickets 1 and 2 are Slices (one per form), 3 is none, 4 opens `Spec #N (…)` without the colon.
const BODIES = {
  1: "Spec: #3177 § D3. Ticket 3 of 6 for that spec.",
  2: "## Parent\n\nhttps://github.com/feigi/fleet-plugin/issues/2870\n\n## What to build\nshort",
  3: "Part of #3673\n\nshort",
  4: "Spec #3182 (`docs/specs/x.md`), D6.",
};
const PARENTS = new Map([["1", "3177"], ["2", "2870"], ["3", ""], ["4", ""]]);
const ROWS = [row({ ticket: "1" }), row({ ticket: "2" }), row({ ticket: "3" }), row({ ticket: "4" })];

test("fillParent adds the column to a corpus written without it and sets parent on every Slice row, nothing else", () => {
  const before = `# a comment line stays\n${tsv(ROWS, WITHOUT)}`;
  const { text, set, widened } = fillParent(before, PARENTS);
  assert.deepEqual([set, widened], [2, true]);
  assert.equal(text, `# a comment line stays\n${tsv(ROWS.map((r) => ({ ...r, parent: PARENTS.get(r.ticket) })))}`);
  assert.deepEqual(parseFeatures(text).map((r) => r.parent), ["3177", "2870", "", ""]);
  const again = fillParent(text, PARENTS);
  assert.deepEqual([again.text, again.set, again.widened], [text, 0, false], "a second run changes nothing");
});

test("fillParent sets parent on a Slice row drained without one, and leaves every other row as it was", () => {
  const filled = tsv([...ROWS.slice(0, 2).map((r) => ({ ...r, parent: PARENTS.get(r.ticket) })), ROWS[2], ROWS[3]]);
  // A later Pull of ticket 1, drained from a plugin that wrote no parent.
  const drained = `${filled}${tsv([row({ ticket: "1", session: "later" })]).split("\n")[1]}\n`;
  const { text, set } = fillParent(drained, PARENTS);
  assert.equal(set, 1);
  assert.deepEqual(parseFeatures(text).map((r) => [r.ticket, r.parent]), [["1", "3177"], ["2", "2870"], ["3", ""], ["4", ""], ["1", "3177"]]);
  assert.equal(text.split("\n").slice(0, 5).join("\n"), drained.split("\n").slice(0, 5).join("\n"), "the rows already right are byte for byte the same");
});

test("fillParent leaves a ticket it has no answer for, and a row whose ticket is no Slice, as they were", () => {
  const before = tsv([row({ ticket: "1" }), row({ ticket: "3", parent: "99" })]);
  const { text, set } = fillParent(before, new Map([["3", ""]]));
  assert.equal(set, 0);
  assert.equal(text, before);
});

test("fillParent refuses a corpus that does not parse", () => {
  assert.throws(() => fillParent(`${FEATURE_COLUMNS.join("\t")}\nshort\trow\n`, PARENTS), /fields, expected/);
});

// Answers the batched GraphQL read: each `n<N>:issue(number:<N>)` alias from
// STUB_BODIES, null with a NOT_FOUND error for a number it holds no body for.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const bodies = JSON.parse(fs.readFileSync(process.env.STUB_BODIES, "utf8"));
const query = process.argv.find((a) => a.startsWith("query="));
const repository = {};
const errors = [];
for (const [, n] of query.matchAll(/n(\\d+):issue\\(number:\\d+\\)/g)) {
  if (Object.hasOwn(bodies, n)) repository["n" + n] = { body: bodies[n] };
  else { repository["n" + n] = null; errors.push({ type: "NOT_FOUND", path: ["repository", "n" + n], message: "no issue" }); }
}
process.stdout.write(JSON.stringify({ data: { repository }, ...(errors.length ? { errors } : {}) }));
process.exitCode = errors.length ? 1 : 0;
`;

function world(bodies, text) {
  const dir = tempDir("slice-fill-");
  writeExecStub(join(dir, "gh"), GH_STUB);
  writeFileSync(join(dir, "bodies.json"), JSON.stringify(bodies));
  const file = join(dir, "ticket-features.tsv");
  writeFileSync(file, text);
  const run = () => spawnSync(process.execPath, [SCRIPT, "--features", file], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_BODIES: join(dir, "bodies.json") },
  });
  return { file, run };
}

test("slice-fill fills the corpus off each ticket's issue body, and a second run writes nothing", () => {
  const w = world(BODIES, tsv(ROWS, WITHOUT));
  const first = w.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /parent set on 2 rows, parent column added; 2 of 4 tickets read are Slices/);
  const filled = readFileSync(w.file, "utf8");
  assert.deepEqual(parseFeatures(filled).map((r) => r.parent), ["3177", "2870", "", ""]);
  const second = w.run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /parent set on 0 rows;/);
  assert.equal(readFileSync(w.file, "utf8"), filled);
});

test("slice-fill names an issue it could not read, leaves its rows, writes the rest, and exits 1", () => {
  const { 2: _, ...bodies } = BODIES;
  const w = world(bodies, tsv(ROWS));
  const r = w.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /slice-fill: issue #2 not found — its rows are left as they were/);
  assert.deepEqual(parseFeatures(readFileSync(w.file, "utf8")).map((x) => x.parent), ["3177", "", "", ""]);
});

test("slice-fill refuses a corpus that does not parse at exit 2 and writes nothing", () => {
  const bad = `${FEATURE_COLUMNS.join("\t")}\nshort\trow\n`;
  const w = world(BODIES, bad);
  const r = w.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fields, expected/);
  assert.equal(readFileSync(w.file, "utf8"), bad);
});

test("slice-fill names a corpus it cannot write at exit 2, in one line with no stack trace, and writes nothing", () => {
  const text = tsv(ROWS, WITHOUT);
  const w = world(BODIES, text);
  chmodSync(dirname(w.file), 0o555);
  let r;
  try {
    r = w.run();
  } finally {
    chmodSync(dirname(w.file), 0o755);
  }
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(r.stderr.split("\n").filter(Boolean), [r.stderr.trim()], "one line");
  assert.match(r.stderr, /^\nslice-fill: .*ticket-features\.tsv: cannot write: /);
  assert.equal(readFileSync(w.file, "utf8"), text);
  assert.equal(existsSync(`${w.file}.tmp`), false);
});
