import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFrontmatter, declaredPairFor, familyOf,
  resolveActual, evaluateMember, formatMismatch, appendedLedgerText,
} from "./tier-check.mjs";

const SCRIPT = fileURLToPath(new URL("./tier-check.mjs", import.meta.url));
const LEDGER_SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// fixtures — shaped like member-record.test.mjs's, one line per event.
// Claude carries `sessionId`/`uuid` and effort as a top-level `d.effort`;
// omp carries `parentId` and thinkingLevel on its own `thinking_level_change`
// line. Neither carries the other's shape key (member-record.mjs's own
// wrong-root refusal would otherwise fire).
// ---------------------------------------------------------------------------

function claudeAgentMd(model, effort, thinkingLevel) {
  return [
    "---",
    "name: fixture-implementer",
    "description: fixture",
    `model: ${model}`,
    `effort: ${effort}`,
    `thinking-level: ${thinkingLevel}`,
    "---",
    "",
    "Follow the dispatch brief.",
    "",
  ].join("\n");
}

function claudeTranscript(model, effort) {
  const line = JSON.stringify({
    type: "assistant", sessionId: "sess-1", uuid: "u1", timestamp: "2026-09-09T07:14:12.147Z",
    effort,
    message: { id: "m1", model, usage: { cache_creation_input_tokens: 10, output_tokens: 1 } },
  });
  return line + "\n";
}

function ompTranscript(model, thinkingLevel) {
  const lines = [
    { type: "session", version: 3, id: "s1", timestamp: "2026-09-09T15:11:49.444Z", cwd: "/tmp/x" },
    { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-09T15:11:49.494Z", thinkingLevel, configured: null },
    { type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-09T15:11:49.495Z", task: "fixture" },
    {
      type: "message", id: "m1", parentId: "i1", timestamp: "2026-09-09T15:12:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], model, usage: { input: 2, output: 201, cacheRead: 0, cacheWrite: 100, cost: { total: 0.01 } } },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function dir() {
  return mkdtempSync(join(tmpdir(), "tier-check-"));
}

function runCli(argv, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// pure core
// ---------------------------------------------------------------------------

test("parseFrontmatter reads all three tier keys", () => {
  const fm = parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh"));
  assert.deepEqual(fm, { model: "opus", effort: "xhigh", thinkingLevel: "xhigh" });
});

test("declaredPairFor picks effort on claude and thinking-level on omp — never both", () => {
  const fm = { model: "opus", effort: "xhigh", thinkingLevel: "high" };
  assert.deepEqual(declaredPairFor(fm, "claude"), { model: "opus", level: "xhigh" });
  assert.deepEqual(declaredPairFor(fm, "omp"), { model: "opus", level: "high" });
});

test("familyOf maps both the bare alias and the resolved id to the same family", () => {
  assert.equal(familyOf("opus"), "opus");
  assert.equal(familyOf("claude-opus-5"), "opus");
  assert.equal(familyOf("sonnet"), "sonnet");
  assert.equal(familyOf("claude-sonnet-5"), "sonnet");
  assert.equal(familyOf("haiku"), "haiku");
  assert.equal(familyOf("claude-haiku-4-5"), "haiku");
  assert.equal(familyOf("gpt-4"), null, "an unrecognised spelling must not silently match");
});

test("two unrecognised models never compare equal via familyOf(...) === familyOf(...)", () => {
  const ok = evaluateMember({
    member: "impl-1", harness: "claude",
    frontmatter: { model: "gpt-4", effort: "xhigh" },
    transcriptText: claudeTranscript("gpt-4", "xhigh"),
  }).ok;
  assert.equal(ok, false, "an unrecognised declared family read as a match — null === null slipped through");
});

test("appendedLedgerText appends to existing free text rather than replacing it", () => {
  assert.equal(appendedLedgerText("impl-42 · class=routine", "note"), "impl-42 · class=routine · note");
  assert.equal(appendedLedgerText("", "note"), "note");
  assert.equal(appendedLedgerText(null, "note"), "note");
});

test("formatMismatch is the ticket's exact line shape", () => {
  const line = formatMismatch({
    member: "impl-9",
    declared: { model: "opus", level: "xhigh" },
    resolved: { model: "claude-opus-5", level: "high" },
  });
  assert.equal(line, "impl-9: declared opus/xhigh resolved claude-opus-5/high");
});

// ---------------------------------------------------------------------------
// AC 1 — every fleet agent, both harnesses, at the declared tier -> exit 0
// ---------------------------------------------------------------------------

test("AC1: fleet-implementer (opus/xhigh) at declared tier on both harnesses -> ok", () => {
  const claude = evaluateMember({
    member: "impl-1", harness: "claude",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    transcriptText: claudeTranscript("claude-opus-5", "xhigh"),
  });
  assert.equal(claude.ok, true, JSON.stringify(claude));

  const omp = evaluateMember({
    member: "AgentWordPair", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    transcriptText: ompTranscript("claude-opus-5", "xhigh"),
  });
  assert.equal(omp.ok, true, JSON.stringify(omp));
});

test("AC1: fleet-implementer-alt (sonnet/xhigh) at declared tier on both harnesses -> ok", () => {
  const claude = evaluateMember({
    member: "impl-2", harness: "claude",
    frontmatter: parseFrontmatter(claudeAgentMd("sonnet", "xhigh", "xhigh")),
    transcriptText: claudeTranscript("claude-sonnet-5", "xhigh"),
  });
  assert.equal(claude.ok, true, JSON.stringify(claude));

  const omp = evaluateMember({
    member: "AnotherWordPair", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("sonnet", "xhigh", "xhigh")),
    transcriptText: ompTranscript("claude-sonnet-5", "xhigh"),
  });
  assert.equal(omp.ok, true, JSON.stringify(omp));
});

test("AC1 end-to-end via the CLI: a batch of both agents on both harnesses, every one at its declared tier -> exit 0", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "fleet-implementer-alt.agent.md"), claudeAgentMd("sonnet", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-opus-5", "xhigh"));
  writeFileSync(join(d, "claude-impl-alt.jsonl"), claudeTranscript("claude-sonnet-5", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("claude-opus-5", "xhigh"));
  writeFileSync(join(d, "omp-impl-alt.jsonl"), ompTranscript("claude-sonnet-5", "xhigh"));
  const batch = [
    { member: "impl-101", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" },
    { member: "impl-102", agentFile: "fleet-implementer-alt.agent.md", harness: "claude", transcript: "claude-impl-alt.jsonl" },
    { member: "OmpWordPairOne", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" },
    { member: "OmpWordPairTwo", agentFile: "fleet-implementer-alt.agent.md", harness: "omp", transcript: "omp-impl-alt.jsonl" },
  ];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// AC 2 — the measured real case: omp thinkingLevel: high vs declared xhigh
// ---------------------------------------------------------------------------

test("AC2: omp resolved thinkingLevel `high` against declared `xhigh` -> mismatch naming both pairs", () => {
  const r = evaluateMember({
    member: "MeasuredRealCase", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    transcriptText: ompTranscript("claude-opus-5", "high"),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.declared, { model: "opus", level: "xhigh" });
  assert.deepEqual(r.resolved, { model: "claude-opus-5", level: "high", viaJobRecord: false });
  assert.equal(formatMismatch(r), "MeasuredRealCase: declared opus/xhigh resolved claude-opus-5/high");
});

test("AC2 end-to-end via the CLI: the same case exits 1 and prints the member and both pairs", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("claude-opus-5", "high"));
  const batch = [{ member: "MeasuredRealCase", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /MeasuredRealCase: declared opus\/xhigh resolved claude-opus-5\/high/);
});

// ---------------------------------------------------------------------------
// AC 3 — model family mismatch on either harness -> exit 1
// ---------------------------------------------------------------------------

test("AC3: Claude family mismatch (declared opus, resolved sonnet) -> mismatch", () => {
  const r = evaluateMember({
    member: "impl-3", harness: "claude",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    transcriptText: claudeTranscript("claude-sonnet-5", "xhigh"),
  });
  assert.equal(r.ok, false);
  assert.equal(formatMismatch(r), "impl-3: declared opus/xhigh resolved claude-sonnet-5/xhigh");
});

test("AC3: omp family mismatch (declared sonnet, resolved haiku) -> mismatch", () => {
  const r = evaluateMember({
    member: "OmpFamilyMismatch", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("sonnet", "xhigh", "xhigh")),
    transcriptText: ompTranscript("claude-haiku-4-5", "xhigh"),
  });
  assert.equal(r.ok, false);
  assert.equal(formatMismatch(r), "OmpFamilyMismatch: declared sonnet/xhigh resolved claude-haiku-4-5/xhigh");
});

test("AC3 end-to-end via the CLI: a family mismatch on either harness exits 1", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-sonnet-5", "xhigh"));
  const batch = [{ member: "impl-4", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-4: declared opus\/xhigh resolved claude-sonnet-5\/xhigh/);
});

// ---------------------------------------------------------------------------
// AC 4 — omp job record present: never opens the child's session file;
// absent: it opens the file.
// ---------------------------------------------------------------------------

test("AC4: resolvedModel/resolvedThinkingLevel given -> resolveActual never reads transcriptText", () => {
  // transcriptText is left undefined entirely — if resolveActual tried to
  // read it as a transcript (foldOmpTranscript(undefined, ...)) it would not
  // throw either, so the real proof is viaJobRecord and the values used.
  const r = resolveActual({ harness: "omp", transcriptText: undefined, resolvedModel: "claude-opus-5", resolvedThinkingLevel: "high" });
  assert.deepEqual(r, { model: "claude-opus-5", level: "high", viaJobRecord: true });
});

test("AC4: omp job record present in a batch entry -> the CLI never opens (or even names) a transcript file", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{
    member: "JobRecordShortcut", agentFile: "fleet-implementer.agent.md", harness: "omp",
    // No `transcript` key at all — proves the CLI does not require, let alone
    // open, a session file when the job record already carries both fields.
    resolvedModel: "claude-opus-5", resolvedThinkingLevel: "xhigh",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("AC4: omp job record absent -> the CLI opens the transcript file (and a missing one refuses, proving it tried)", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{
    member: "NoJobRecord", agentFile: "fleet-implementer.agent.md", harness: "omp",
    transcript: "does-not-exist.jsonl",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /ENOENT|does-not-exist\.jsonl/);
});

// ---------------------------------------------------------------------------
// ledger append — "if the ledger has no per-member field, write the pair
// into the row's free text" (ledger.mjs's own row is ticket-keyed free text;
// #1345 does not add a member concept to it).
// ---------------------------------------------------------------------------

test("ledger append: a mismatch on impl-<N> appends the pair to that ticket's existing row rather than replacing it", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const ledgerFile = join(d, ".fleet", "ledger.md");
  execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, "row", "77", "impl-77 · class=routine"], { cwd: d, encoding: "utf8" });

  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-sonnet-5", "xhigh"));
  const batch = [{ member: "impl-77", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));

  const r = runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledgerFile], d);
  assert.equal(r.status, 1, r.stdout + r.stderr);

  const data = JSON.parse(execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, "read"], { encoding: "utf8" }));
  const row = data.rows.find((row) => row.startsWith("#77"));
  assert.ok(row, "no row for #77 survived the append");
  assert.match(row, /class=routine/, "the append replaced the existing free text instead of appending to it");
  assert.match(row, /declared opus\/xhigh resolved claude-sonnet-5\/xhigh/, "the tier-mismatch pair was not written to the ledger row");
});

test("ledger append: a mismatch on a member with no derivable ticket (an omp AgentId) still exits 1 but writes no ledger row", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const ledgerFile = join(d, ".fleet", "ledger.md");

  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("claude-opus-5", "high"));
  const batch = [{ member: "SomeWordPair", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));

  const r = runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledgerFile], d);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(existsSync(ledgerFile), false, "a ledger file materialised for a member with no derivable ticket");
});

test("CLI: --batch given no value refuses by name", () => {
  const r = runCli(["--batch"], dir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--batch needs a value/);
});

test("CLI: no --batch at all refuses with the usage line", () => {
  const r = runCli([], dir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: tier-check\.mjs/);
});

test("CLI: a batch entry missing harness refuses by naming the entry, not a generic parse error", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "batch.json"), JSON.stringify([{ member: "impl-1", agentFile: "fleet-implementer.agent.md" }]));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /missing member\/agentFile\/harness/);
});

test("CLI: --repo defaults to the script's own plugin/ root, so a real fleet-implementer.agent.md is found without --repo", () => {
  const d = dir();
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-opus-5", "xhigh"));
  const batch = [{ member: "impl-1", agentFile: "agents/fleet-implementer.agent.md", harness: "claude", transcript: join(d, "claude-impl.jsonl") }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", join(d, "batch.json")], d);
  // The real fleet-implementer declares opus/xhigh (implementer-model-tier.test.mjs
  // pins this) — this fixture's transcript matches it, so a correctly
  // resolved --repo default exits 0. A wrong default (or none) would refuse
  // ENOENT on agents/fleet-implementer.agent.md instead.
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
