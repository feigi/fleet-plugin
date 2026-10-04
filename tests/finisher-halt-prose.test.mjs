// #2083. A finisher halt had no record rule and no resolution rule, so every
// halt parked its PR until a human read the report. The ruling: a halt is its
// own outcome (`finisher-pr-M=halted:<cause>`), it escalates on the PR itself
// (cockpit flag + `gh pr comment`, no label), and each cause has one
// resolution — two automatic, every other one escalated.
//
// Each pin is sliced to the one table row, sentence or bullet carrying its
// claim, never the whole section: the causes' names recur all over it, so a
// section-wide match would stay green with a resolution swapped between rows.
// The cause vocabulary itself is read from ledger-grammar.mjs, the one parser
// that accepts or refuses a settle — the prose and the grammar naming
// different causes is exactly a halt the ledger refuses to record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase, sentences } from "./support/prose-pin.mjs";
import { HALT_CAUSES } from "../plugin/scripts/ledger-grammar.mjs";

const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const RESOLVING = "**Resolving a finisher halt.**";
const resolutionRows = () => {
  const table = between(RUN_TEAM, "| Cause | Resolution |", "\n\n", "halt resolution table");
  return table.split("\n").filter((l) => l.startsWith("| `"));
};
// A row's first-cell backticked causes, in order — shared by rowFor's
// lookup and the coverage test below so the two cannot read the table's
// cells differently.
const causesIn = (row) => [...row.split("|")[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
// The row whose first cell names exactly these causes.
const rowFor = (causes) => {
  const rows = resolutionRows().filter((r) => causesIn(r).join(",") === causes.join(","));
  assert.equal(rows.length, 1, `the resolution table has ${rows.length} rows for ${causes.join(", ")}`);
  return rows[0].split("|")[2];
};

test("the resolution table resolves every cause the grammar accepts, each exactly once", () => {
  // HALT_CAUSES is the exported, shared array parseToken's own grammar
  // validates against — copy it before sorting, since sort mutates in
  // place. resolutionRows().flatMap(causesIn) is a fresh array every call,
  // needing no copy of its own.
  assert.deepEqual(resolutionRows().flatMap(causesIn).sort(), [...HALT_CAUSES].sort());
});

test("live-editor resolves automatically: ask the member by name, wait, re-finish at the current head — past-pin if it moved", () => {
  const r = rowFor(["live-editor"]);
  assert.match(r, /^\s*\*\*Automatic\.\*\*/);
  assert.match(r, /Ask the live member \*\*by name\*\* for its report, wait for it, then dispatch `finisher-pr-<M>-b` at the current head\./);
  assert.match(r, /If the head moved in the meantime, resolve it as `past-pin` instead\./);
});

test("past-pin resolves automatically through the tick, as a re-review", () => {
  const r = rowFor(["past-pin"]);
  assert.match(r, /^\s*\*\*Automatic, through the tick: re-review\.\*\*/);
  assert.match(r, /The tick prints `DISPATCH review PR#<M>` for a PR whose latest finisher is `halted:past-pin` and whose latest `reviewed=<head>` is not its current head/);
});

test("rebase escalates with the git cherry read, and has no automatic rule yet", () => {
  const r = rowFor(["rebase"]);
  assert.match(r, /^\s*\*\*Escalate\*\* — comment and flag, nothing more\./);
  assert.match(r, /only `-` lines is a clean rebase, and a `\+` line is a conflict resolution that changed content or a commit past the pin/);
  assert.match(r, /`git cherry <pin> HEAD origin\/main`/);
  assert.match(r, /No automatic rule until a live halt shows the case recurring\./);
  assert.doesNotMatch(r, /Automatic\./);
});

test("unreadable, missing, absent and other escalate with no automatic retry", () => {
  const r = rowFor(["unreadable", "missing", "absent", "other"]);
  assert.match(r, /^\s*\*\*Escalate\*\* — comment and flag, no automatic retry\.\s*$/);
});

test("every halt escalates on the PR itself — a comment that outlives the run — and never by label", () => {
  const para = flat(paragraph(RUN_TEAM, RESOLVING, "halt resolution lead-in"));
  const s = sentences(para);
  const settle = s.find((x) => x.includes("Record it"));
  assert.match(settle ?? "", /Record it `ledger\.mjs settle finisher-pr-<M>=halted:<cause>`/);
  assert.match(para, /so it is never `failed`, which stays for a finisher that crashed or gave up\./);
  assert.match(
    para,
    /Every halt escalates two ways: the cockpit flags the PR `halted:<cause>` at severity 4 off that token, and you post the finisher's halt report — cause and evidence — with `gh pr comment <M>`, so it outlives the run\./,
  );
  assert.match(para, /\*\*No label\*\*: the missing `ready-to-merge` already keeps the PR out of the merge queue\./);
});

test("the tick paragraph says why past-pin cannot use the dead-review path, and that a fix-applier push stays not due", () => {
  const para = flat(paragraph(RUN_TEAM, "`past-pin` needs the tick because", "past-pin tick rationale"));
  assert.match(para, /settling that review `=failed` re-queues nothing — that path covers only a review that died before returning\./);
  assert.match(para, /A head that moved past `reviewed=` with no such halt — a fix-applier's push — stays not due: duty 2 verifies what it applied\./);
});

test("finisher duty 4 names the cause in the ledger's vocabulary, and a rebase report carries git cherry", () => {
  const duty = flat(between(RUN_TEAM, "4. Report you the label", "\n\n", "finisher duty 4"));
  const vocab = sentences(duty).find((x) => x.includes("vocabulary")) ?? "";
  for (const c of HALT_CAUSES) assert.match(vocab, new RegExp(`\`${c}\``), `duty 4 no longer names \`${c}\``);
  assert.match(vocab, /`other` for every other halt/);
  assert.match(duty, /A `rebase` halt's report carries the output of `git cherry <pin> HEAD origin\/main`, run in the worktree\./);
});

test("the settle grammar summary lists halted:<cause> with the grammar's own causes", () => {
  const bulletText = flat(between(RUN_TEAM, "- **`ledger.mjs settle <member> <outcome>`**", "\n- **", "settle summary"));
  assert.match(bulletText, phrase("`finisher-pr-M` = `labelled | failed | killed | halted:<cause>`"));
  assert.match(bulletText, phrase(`\`<cause>\` one of \`${HALT_CAUSES.join(" | ")}\``));
});
