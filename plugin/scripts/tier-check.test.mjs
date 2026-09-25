import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  declaredPairFor, familyOf,
  resolveActual, evaluateMember, resolvedPairFromRecord, evaluateMemberFromRecord,
  formatMismatch, formatOmpExpectation, appendedLedgerText,
} from "./tier-check.mjs";
import { parseFrontmatter } from "./tier-roles.mjs";

const SCRIPT = fileURLToPath(new URL("./tier-check.mjs", import.meta.url));
const LEDGER_SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// fixtures — shaped like member-record.test.mjs's, one line per event.
// Claude carries `sessionId`/`uuid` and effort as a top-level `d.effort`;
// omp carries `parentId` and thinkingLevel on its own `thinking_level_change`
// line. Neither carries the other's shape key (member-record.mjs's own
// wrong-root refusal would otherwise fire).
//
// Model spellings below are the REAL measured ones, not the bare family
// name: omp's own `resolvedModel`/`resolvedModelIdentity`/transcript
// `model` are ALWAYS provider-prefixed (906/906 measured), sometimes with a
// trailing `:level`; Claude's carries a context-window variant or a dated
// generation. Using anything else here would let a `familyOf` regression
// hide behind a fixture no harness actually writes (the review finding
// this file exists to close).
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

// `resolvedModelIdentity` on `session_init` — written at DISPATCH, before any
// assistant turn — is what makes the omp fixtures below realistic: a member
// still working carries it with no assistant line at all.
function ompTranscript(resolvedModelIdentity, thinkingLevel, { withTurn = true } = {}) {
  const lines = [
    { type: "session", version: 3, id: "s1", timestamp: "2026-09-09T15:11:49.444Z", cwd: "/tmp/x" },
    { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-09T15:11:49.494Z", thinkingLevel, configured: null },
    { type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-09T15:11:49.495Z", task: "fixture", resolvedModelIdentity },
  ];
  if (withTurn) {
    lines.push({
      type: "message", id: "m1", parentId: "i1", timestamp: "2026-09-09T15:12:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: resolvedModelIdentity, usage: { input: 2, output: 201, cacheRead: 0, cacheWrite: 100, cost: { total: 0.01 } } },
    });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function claudeSessionFixture(members) {
  const root = mkdtempSync(join(tmpdir(), "tier-check-claude-session-"));
  const dir = join(root, ".claude", "projects", "-x", "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [agent, { name, model, effort }] of members) {
    const line = JSON.stringify({
      type: "assistant", sessionId: "sess-1", uuid: `msg-${agent}`, timestamp: "2026-09-09T07:14:12.147Z",
      effort,
      message: { id: `msg-${agent}`, model, usage: { cache_creation_input_tokens: 10, output_tokens: 1 } },
    });
    writeFileSync(join(dir, `${agent}.jsonl`), line + "\n");
    writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify({ name, agentType: name, spawnDepth: 0 }));
  }
  return join(root, ".claude", "projects", "-x", "sess-1");
}

function dir() {
  return mkdtempSync(join(tmpdir(), "tier-check-"));
}

// The measured real `modelRoles` shape (ADR 0011) used by every omp fixture
// below that needs a role to resolve through: `slow`->opus, `task`->sonnet,
// `smol`->haiku, each carrying its own baked level suffix the way a real
// install does.
const MODEL_ROLES = {
  default: "anthropic/claude-sonnet-5:high",
  slow: "anthropic/claude-opus-5:high",
  task: "anthropic/claude-sonnet-5:high",
  smol: "anthropic/claude-haiku-4-5:auto",
};

function modelRolesFile(d) {
  const p = join(d, "model-roles.json");
  writeFileSync(p, JSON.stringify(MODEL_ROLES));
  return p;
}

function runCli(argv, cwd, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, ...argv, ...extra], { cwd, encoding: "utf8" });
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

test("familyOf maps the bare alias and the resolved id to the same family", () => {
  assert.equal(familyOf("opus"), "opus");
  assert.equal(familyOf("claude-opus-5"), "opus");
  assert.equal(familyOf("sonnet"), "sonnet");
  assert.equal(familyOf("claude-sonnet-5"), "sonnet");
  assert.equal(familyOf("haiku"), "haiku");
  assert.equal(familyOf("claude-haiku-4-5"), "haiku");
  assert.equal(familyOf("gpt-4"), null, "an unrecognised spelling must not silently match");
});

// Review finding #1 (p0): every real omp `resolvedModel`/`resolvedModelIdentity`
// carries a provider prefix (906/906 measured, zero bare) and sometimes a
// trailing `:level`; Claude's own transcript spells a context-window variant
// or a dated generation. familyOf must strip all three before matching.
test("familyOf strips the provider prefix, the trailing :level tag, and the [context-window] variant", () => {
  assert.equal(familyOf("anthropic/claude-opus-5"), "opus", "the plain omp resolvedModelIdentity spelling");
  assert.equal(familyOf("anthropic/claude-opus-5:high"), "opus", "the measured real case: prefix AND trailing level tag");
  assert.equal(familyOf("anthropic/claude-sonnet-5:high"), "sonnet");
  assert.equal(familyOf("claude-opus-5[1m]"), "opus", "the context-window variant measured in real meta.json");
  assert.equal(familyOf("claude-haiku-4-5-20251001"), "haiku", "a dated generation id");
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

// Review finding #5 (p2): the documented loop is check, fix, re-check — a
// member that still mismatches for the SAME reason on a later run must not
// grow the row a second time. A DIFFERENT note still appends.
test("appendedLedgerText is idempotent on the identical note but still appends a genuinely different one", () => {
  assert.equal(appendedLedgerText("impl-42 · class=routine · note", "note"), "impl-42 · class=routine · note");
  assert.equal(appendedLedgerText("note", "note"), "note");
  assert.equal(appendedLedgerText("impl-42 · class=routine · note", "different note"), "impl-42 · class=routine · note · different note");
});

// The idempotency guard keys on the note being the row's TRAILING ` · `-joined
// segment, not on the note appearing anywhere: an earlier segment carrying the
// same text (a pair that was since fixed, then re-broken) or a longer segment
// merely ending in it (a different member whose name ends in this one's) is
// not this run's note, and the new one still appends.
test("appendedLedgerText's idempotency is anchored to the trailing ` · ` segment, never a substring match", () => {
  assert.equal(
    appendedLedgerText("impl-42 · note · class=routine", "note"),
    "impl-42 · note · class=routine · note",
  );
  const note = "Impl-1: declared opus/xhigh resolved anthropic/claude-opus-5/high";
  assert.equal(
    appendedLedgerText(`impl-42 · Fix${note}`, note),
    `impl-42 · Fix${note} · ${note}`,
  );
});

test("formatMismatch is the ticket's exact line shape", () => {
  const line = formatMismatch({
    member: "impl-9",
    declared: { model: "opus", level: "xhigh" },
    resolved: { model: "anthropic/claude-opus-5", level: "high" },
  });
  assert.equal(line, "impl-9: declared opus/xhigh resolved anthropic/claude-opus-5/high");
});

// ---------------------------------------------------------------------------
// Review finding #2 (p1): the omp job-record short-circuit fires ONLY when
// BOTH fields are given; a partial record falls back to the transcript for
// the half it lacks, and never reports the missing half as `null`.
// ---------------------------------------------------------------------------

test("resolveActual: full omp job record (both fields) never reads transcriptText", () => {
  const r = resolveActual({ harness: "omp", transcriptText: undefined, resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "high" });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "high", viaJobRecord: true });
});

test("resolveActual: resolvedModel alone falls back to the transcript for the thinking level, never `null`", () => {
  const r = resolveActual({
    harness: "omp", resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: undefined,
    transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh"),
  });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "xhigh", viaJobRecord: false });
});

test("resolveActual: resolvedThinkingLevel alone falls back to the transcript for the model, never `null`", () => {
  const r = resolveActual({
    harness: "omp", resolvedModel: undefined, resolvedThinkingLevel: "xhigh",
    transcriptText: ompTranscript("anthropic/claude-sonnet-5", "high"),
  });
  assert.deepEqual(r, { model: "anthropic/claude-sonnet-5", level: "xhigh", viaJobRecord: false });
});

test("resolveActual: neither job-record field given reads both off the transcript, preferring resolvedModelIdentity over the per-turn model", () => {
  const r = resolveActual({ harness: "omp", transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh") });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "xhigh", viaJobRecord: false });
});

// Review finding #3 (p1): the identity exists BEFORE the first assistant
// turn — a member still working must resolve from it rather than reading a
// correctly-dispatched member as an unresolved mismatch.
test("resolveActual: a member with no assistant turn yet still resolves via resolvedModelIdentity", () => {
  const r = resolveActual({ harness: "omp", transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh", { withTurn: false }) });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "xhigh", viaJobRecord: false });
});

test("evaluateMember: a still-running omp member (no assistant turn) at its declared tier reads ok, not a mismatch", () => {
  const r = evaluateMember({
    member: "StillRunning", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh", { withTurn: false }),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// resolvedPairFromRecord / evaluateMemberFromRecord — the `--session` path's
// pure core, over an already-resolved member-record.mjs row.
// ---------------------------------------------------------------------------

test("resolvedPairFromRecord: omp prefers resolvedModelIdentity over the per-turn model", () => {
  assert.deepEqual(
    resolvedPairFromRecord({ model: "claude-opus-5", resolvedModelIdentity: "anthropic/claude-opus-5", thinking: "xhigh" }, "omp"),
    { model: "anthropic/claude-opus-5", level: "xhigh" },
  );
});

test("resolvedPairFromRecord: claude has no resolvedModelIdentity concept — uses the record's model as-is", () => {
  assert.deepEqual(
    resolvedPairFromRecord({ model: "claude-sonnet-5", thinking: "high" }, "claude"),
    { model: "claude-sonnet-5", level: "high" },
  );
});

test("evaluateMemberFromRecord: viaJobRecord is always false — reaching a record at all means a transcript was read", () => {
  const r = evaluateMemberFromRecord({
    member: "impl-1", harness: "claude",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    record: { model: "claude-opus-5", thinking: "xhigh" },
  });
  assert.equal(r.viaJobRecord, false);
  assert.equal(r.ok, true);
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
    transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh"),
    modelRoles: MODEL_ROLES,
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
    transcriptText: ompTranscript("anthropic/claude-sonnet-5", "xhigh"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(omp.ok, true, JSON.stringify(omp));
});

test("AC1 end-to-end via the CLI: a batch of both agents on both harnesses, every one at its declared tier -> exit 0", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "fleet-implementer-alt.agent.md"), claudeAgentMd("sonnet", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-opus-5", "xhigh"));
  writeFileSync(join(d, "claude-impl-alt.jsonl"), claudeTranscript("claude-sonnet-5", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  writeFileSync(join(d, "omp-impl-alt.jsonl"), ompTranscript("anthropic/claude-sonnet-5", "xhigh"));
  const batch = [
    { member: "impl-101", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" },
    { member: "impl-102", agentFile: "fleet-implementer-alt.agent.md", harness: "claude", transcript: "claude-impl-alt.jsonl" },
    { member: "OmpWordPairOne", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" },
    { member: "OmpWordPairTwo", agentFile: "fleet-implementer-alt.agent.md", harness: "omp", transcript: "omp-impl-alt.jsonl" },
  ];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// AC 2 — the measured real case: omp thinkingLevel: high vs declared xhigh
// ---------------------------------------------------------------------------

test("AC2: omp resolved thinkingLevel `high` against declared `xhigh` -> mismatch naming both pairs", () => {
  const r = evaluateMember({
    member: "MeasuredRealCase", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    transcriptText: ompTranscript("anthropic/claude-opus-5", "high"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.declared, { model: "opus", level: "xhigh" });
  assert.deepEqual(r.resolved, { model: "anthropic/claude-opus-5", level: "high", viaJobRecord: false });
  assert.equal(formatMismatch(r), "MeasuredRealCase: declared opus/xhigh resolved anthropic/claude-opus-5/high");
});

test("AC2 end-to-end via the CLI: the same case exits 1 and prints the member and both pairs", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "high"));
  const batch = [{ member: "MeasuredRealCase", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /MeasuredRealCase: declared opus\/xhigh resolved anthropic\/claude-opus-5\/high/);
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
    transcriptText: ompTranscript("anthropic/claude-haiku-4-5", "xhigh"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, false);
  assert.equal(formatMismatch(r), "OmpFamilyMismatch: declared sonnet/xhigh resolved anthropic/claude-haiku-4-5/xhigh");
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
  const r = resolveActual({ harness: "omp", transcriptText: undefined, resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "high" });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "high", viaJobRecord: true });
});

test("AC4: omp job record present in a batch entry -> the CLI never opens (or even names) a transcript file", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{
    member: "JobRecordShortcut", agentFile: "fleet-implementer.agent.md", harness: "omp",
    // No `transcript`/`session` key at all — proves the CLI does not
    // require, let alone open, a session file when BOTH job-record fields
    // are given.
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
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
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /ENOENT|does-not-exist\.jsonl/);
});

test("AC4b: omp job record PARTIAL (resolvedModel only, no transcript/session given) -> refuses rather than defaulting the missing level to null", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{ member: "PartialNoFallback", agentFile: "fleet-implementer.agent.md", harness: "omp", resolvedModel: "anthropic/claude-opus-5" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no --transcript or --session given/);
});

test("AC4c: omp job record PARTIAL (resolvedModel only) plus a transcript for the missing level -> resolves correctly, not a false mismatch", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{
    member: "PartialWithFallback", agentFile: "fleet-implementer.agent.md", harness: "omp",
    resolvedModel: "anthropic/claude-opus-5", transcript: "omp-impl.jsonl",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// ADR 0011 — on omp the declared alias routes through a role
// (`OMP_ROLE_FOR_MODEL`), and compare is against THAT role's own
// `modelRoles.<role>` target, never against the alias's model family.
// ---------------------------------------------------------------------------

test("omp: an explicit override suffix reaching a `modelRoles.slow` target at the SAME generation reads ok", () => {
  const r = evaluateMember({
    member: "impl-1", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    resolvedModel: "anthropic/claude-opus-5-5:xhigh", resolvedThinkingLevel: "xhigh",
    modelRoles: { slow: "anthropic/claude-opus-5-5:high" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("omp: the SAME declared/roles but resolved at an OLDER generation (same family, alias fallthrough) is NOT ok", () => {
  const r = evaluateMember({
    member: "impl-1", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
    modelRoles: { slow: "anthropic/claude-opus-5-5:high" },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(formatMismatch(r), "impl-1: declared opus/xhigh resolved anthropic/claude-opus-5/xhigh");
  assert.equal(formatOmpExpectation(r), "    impl-1: omp routes opus through @slow = anthropic/claude-opus-5-5");
});

test("omp: modelRoles.slow pointing at another role (`@plan`) resolves through the chain, even to a non-Anthropic model", () => {
  const r = evaluateMember({
    member: "impl-1", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    resolvedModel: "openai/gpt-5.4", resolvedThinkingLevel: "xhigh",
    modelRoles: { slow: "@plan", plan: "openai/gpt-5.4:high" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("omp: an unset modelRoles.<role> reads not ok, and the expectation line names the unset role", () => {
  const r = evaluateMember({
    member: "impl-1", harness: "omp",
    frontmatter: parseFrontmatter(claudeAgentMd("opus", "xhigh", "xhigh")),
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
    modelRoles: {},
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(formatOmpExpectation(r), "    impl-1: omp routes opus through @slow = (modelRoles.slow unset)");
});

test("CLI: an omp batch entry with no --model-roles and no `omp` on PATH refuses naming the config read", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{ member: "NoPathOmp", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const emptyPath = mkdtempSync(join(tmpdir(), "tier-check-empty-path-"));
  const r = spawnSync(process.execPath, [SCRIPT, "--batch", "batch.json", "--repo", d], {
    cwd: d, encoding: "utf8", env: { ...process.env, PATH: emptyPath },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /omp config get modelRoles --json failed/);
});

test("CLI: --model-roles pointing at a JSON array refuses", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{ member: "ArrModelRoles", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const arrPath = join(d, "model-roles.json");
  writeFileSync(arrPath, JSON.stringify(["not", "an", "object"]));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", arrPath]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

// #1786: `--model-roles` is only consulted when an omp entry exists, so a
// Claude-only batch used to accept it, never open it, and exit on the
// verdict alone — a wrong path, or a caller who believed the file was being
// validated, passed in silence. It is now refused the way #1669 refuses any
// other argument the run would silently absorb: exit 2, naming the flag, and
// BEFORE any ledger write. The flag not being opened at all is the point —
// an existing, well-formed file is refused just the same as a missing one,
// so this is not a path check.
test("CLI: --model-roles on a Claude-only batch refuses naming the flag, whether or not the file exists", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-opus-5", "xhigh"));
  const batch = [{ member: "impl-1", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  for (const path of ["/does/not/exist", modelRolesFile(d)]) {
    const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", path]);
    assert.equal(r.status, 2, `${path}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--model-roles .* no batch entry has harness omp/);
    assert.doesNotMatch(r.stderr, /ENOENT/);
  }
});

test("CLI: --model-roles on a Claude-only mismatched batch refuses before the ledger is written", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const ledgerFile = join(d, ".fleet", "ledger.md");
  execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, "row", "78", "impl-78 · class=routine"], { cwd: d, encoding: "utf8" });
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-sonnet-5", "xhigh"));
  const batch = [{ member: "impl-78", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledgerFile], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const data = JSON.parse(execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, "read"], { encoding: "utf8" }));
  const row = data.rows.find((row) => row.startsWith("#78"));
  assert.doesNotMatch(row, /declared opus/, "the refusal came after the ledger append");
});

// The accept half: the refusal keys on "no omp entry", not on "any claude
// entry" — a mixed batch still reads --model-roles for its omp members.
test("CLI: --model-roles on a mixed Claude+omp batch is still accepted and read", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-opus-5", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [
    { member: "impl-1", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" },
    { member: "MixedOmp", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" },
  ];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const missing = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", "/does/not/exist"]);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /ENOENT/);
});

// ---------------------------------------------------------------------------
// --session lookup (review finding #4): the controller supplies a session
// root it already knows instead of an exact transcript file.
// ---------------------------------------------------------------------------

test("--session (claude): resolves via member-record.mjs's own readMembers, matched by member name", () => {
  const session = claudeSessionFixture([["agent-a1", { name: "impl-201", model: "claude-opus-5", effort: "xhigh" }]]);
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{ member: "impl-201", agentFile: "fleet-implementer.agent.md", harness: "claude", session }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("--session (claude): a family mismatch found via session lookup still exits 1", () => {
  const session = claudeSessionFixture([["agent-a1", { name: "impl-202", model: "claude-sonnet-5", effort: "xhigh" }]]);
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{ member: "impl-202", agentFile: "fleet-implementer.agent.md", harness: "claude", session }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-202: declared opus\/xhigh resolved claude-sonnet-5\/xhigh/);
});

test("--session (claude): no member of that name under the session root refuses by name", () => {
  const session = claudeSessionFixture([["agent-a1", { name: "impl-203", model: "claude-opus-5", effort: "xhigh" }]]);
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{ member: "impl-999", agentFile: "fleet-implementer.agent.md", harness: "claude", session }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no member named impl-999 found under --session/);
});

test("--session (omp): resolves via the flat <session>/<member>.jsonl file, bypassing readOmpMember's null-model gate", () => {
  const sessionDir = dir();
  // No assistant turn at all — proves this path does NOT filter out a
  // still-running member the way readOmpMember's `if (!folded.model) return
  // null` would (the exact gate this bypass exists to avoid).
  writeFileSync(join(sessionDir, "OmpSessionMember.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh", { withTurn: false }));
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{ member: "OmpSessionMember", agentFile: "fleet-implementer.agent.md", harness: "omp", session: sessionDir }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("--session (omp): no <member>.jsonl under the session root refuses by name", () => {
  const sessionDir = dir();
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  const batch = [{ member: "NoSuchMember", agentFile: "fleet-implementer.agent.md", harness: "omp", session: sessionDir }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no NoSuchMember\.jsonl found under --session/);
});

// ---------------------------------------------------------------------------
// ledger append — "if the ledger has no per-member field, write the pair
// into the row's free text" (ledger.mjs's own row is ticket-keyed free text;
// #1345 does not add a member concept to it), and idempotent on a re-run.
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

test("ledger append: re-running the check on an unchanged mismatch does not duplicate the note", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const ledgerFile = join(d, ".fleet", "ledger.md");
  execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, "row", "88", "impl-88"], { cwd: d, encoding: "utf8" });

  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-sonnet-5", "xhigh"));
  const batch = [{ member: "impl-88", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));

  runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledgerFile], d);
  const r2 = runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledgerFile], d);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stderr, /already carries this exact pair — not appended again/);

  const data = JSON.parse(execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerFile, "read"], { encoding: "utf8" }));
  const row = data.rows.find((row) => row.startsWith("#88"));
  const occurrences = row.split("declared opus/xhigh resolved claude-sonnet-5/xhigh").length - 1;
  assert.equal(occurrences, 1, `the note appeared ${occurrences} times after two identical runs — it grew on the re-check`);
});

test("ledger append: a mismatch on a member with no derivable ticket (an omp AgentId) still exits 1 but writes no ledger row", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const ledgerFile = join(d, ".fleet", "ledger.md");

  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "high"));
  const batch = [{ member: "SomeWordPair", agentFile: "fleet-implementer.agent.md", harness: "omp", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));

  const r = runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledgerFile], d, ["--model-roles", modelRolesFile(d)]);
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

// ---------------------------------------------------------------------------
// #1669: tier-check bound only makeDie/makeArg, so a stray or misspelled flag
// was silently ignored and the run computed a real verdict against the
// DEFAULT ledger/repo instead of refusing. makeSweep closes that gap.
// ---------------------------------------------------------------------------

// No agent/transcript/batch-content fixtures here: sweep() dies on the
// stray flag immediately after the arg() reads, before main() ever opens
// --batch's own file (verified by mutation — deleting this file's fixture
// writes changes no assertion's outcome), so writing them would be dead
// setup that never runs.
test("CLI: an unknown flag outside the roster refuses by name, not a computed verdict", () => {
  const d = dir();
  const r = runCli(["--batch", "batch.json", "--repo", d, "--zz-no-such-flag"], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown flag --zz-no-such-flag/);
});

// The ticket's own repro: a misspelled --ledgerr used to fall through to
// arg()'s `||`/`??` default and compute a real 0/1 verdict against the
// DEFAULT ledger, never naming the typo.
test("CLI: a misspelled --ledgerr refuses instead of computing a verdict against the default ledger", () => {
  const d = dir();
  const r = runCli(["--batch", "batch.json", "--repo", d, "--ledgerr", "/tmp/should-not-be-read.tsv"], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown flag --ledgerr/);
});

// The false-positive class the sweep addition risks: a roster flag present
// but missing its value must still answer arg()'s own "needs a value"
// message, never sweep()'s generic stray complaint — arg()'s per-flag
// guards run (and can refuse) before sweep() is ever reached. The stray
// riding after the valueless flag is what makes that ordering observable:
// with no stray in argv, sweep() has nothing to complain about and the
// "unknown flag" assertion holds under either ordering (#1711 — a stray-less
// twin of this test stayed green with sweep() hoisted to main()'s first
// statement, so it was deleted rather than kept as a second guard).
test("CLI: a stray flag riding after a valueless roster flag never pre-empts that flag's own value-guard message", () => {
  const d = dir();
  writeFileSync(join(d, "batch.json"), JSON.stringify([{ member: "impl-1", agentFile: "x.md", harness: "claude" }]));
  const r = runCli(["--batch", "batch.json", "--ledger", "--zz-no-such-flag"], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--ledger needs a value/);
  assert.ok(!r.stderr.includes("unknown flag"), r.stderr);
});

// Review finding #1 (survived, confirmed): sweep() alone only refuses
// `--`-prefixed tokens, so the ticket's stated harm was only half closed --
// a single-dash misspelling (`-ledger`) rode through in silence the same
// way `--ledgerr` used to. Binding stray() alongside sweep(), the same
// makeSweep+makeStray pairing every sibling CLI (ci-state, diff-stats,
// board, pr-overlap) already uses, closes the other half.
test("CLI: a single-dash misspelling (`-ledger`) refuses as a stray, not a computed verdict", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), claudeAgentMd("opus", "xhigh", "xhigh"));
  writeFileSync(join(d, "claude-impl.jsonl"), claudeTranscript("claude-opus-5", "xhigh"));
  const batch = [{ member: "impl-1", agentFile: "fleet-implementer.agent.md", harness: "claude", transcript: "claude-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d, "-ledger", "/tmp/should-not-be-read.tsv"], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unexpected argument '-ledger'/);
});
