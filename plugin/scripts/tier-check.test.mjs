import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  declaredPairFor,
  resolveActual, evaluateMember, resolvedPairFromRecord, evaluateMemberFromRecord,
  formatMismatch, formatOmpExpectation, appendedLedgerText, expectedDefinition,
} from "./tier-check.mjs";
import { parseFrontmatter } from "./tier-roles.mjs";
import { deriveRun } from "./fleet-tick.mjs";

const SCRIPT = fileURLToPath(new URL("./tier-check.mjs", import.meta.url));
const LEDGER_SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// fixtures — shaped like member-record.test.mjs's, one line per event.
//
// Model spellings below are the REAL measured ones, not the bare family
// name: omp's own `resolvedModel`/`resolvedModelIdentity`/transcript
// `model` are ALWAYS provider-prefixed (906/906 measured), sometimes with a
// trailing `:level`. Using anything else here would let a `modelsEqual`
// regression hide behind a fixture omp never actually writes.
// ---------------------------------------------------------------------------

function agentMd(model) {
  return [
    "---",
    "name: fixture-implementer",
    "description: fixture",
    `model: ${model}`,
    "---",
    "",
    "Follow the dispatch brief.",
    "",
  ].join("\n");
}

// `resolvedModelIdentity` on `session_init` — written at DISPATCH, before any
// assistant turn — is what makes the fixtures below realistic: a member
// still working carries it with no assistant line at all. `agent` is the
// same line's record of the definition the dispatch named (a generic
// dispatch writes `task`).
function ompTranscript(resolvedModelIdentity, thinkingLevel, { withTurn = true, agent } = {}) {
  const lines = [
    { type: "session", version: 3, id: "s1", timestamp: "2026-09-09T15:11:49.444Z", cwd: "/tmp/x" },
    { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-09T15:11:49.494Z", thinkingLevel, configured: null },
    { type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-09T15:11:49.495Z", task: "fixture", resolvedModelIdentity, ...(agent ? { agent } : {}) },
  ];
  if (withTurn) {
    lines.push({
      type: "message", id: "m1", parentId: "i1", timestamp: "2026-09-09T15:12:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: resolvedModelIdentity, usage: { input: 2, output: 201, cacheRead: 0, cacheWrite: 100, cost: { total: 0.01 } } },
    });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function dir() {
  return mkdtempSync(join(tmpdir(), "tier-check-"));
}

// The measured real `modelRoles` shape (ADR 0011/0014) used by every fixture
// below that needs a role to resolve through: `slow`, `task`, `smol`, each
// carrying its own baked level suffix the way a real install does.
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

test("parseFrontmatter reads model, role and level together", () => {
  const fm = parseFrontmatter(agentMd("@slow:xhigh"));
  assert.deepEqual(fm, { model: "@slow:xhigh", role: "slow", level: "xhigh" });
});

test("declaredPairFor is the frontmatter's own model/level, no harness branch", () => {
  const fm = { model: "@slow:xhigh", role: "slow", level: "xhigh" };
  assert.deepEqual(declaredPairFor(fm), { model: "@slow:xhigh", level: "xhigh" });
});

test("a declared model that is not a route never reads ok, even when the resolved model would otherwise match", () => {
  const r = evaluateMember({
    member: "impl-1",
    frontmatter: { model: "opus", role: null, level: "xhigh" },
    transcriptText: ompTranscript("opus", "xhigh"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, false, "an unrouted declared model read as a match — null !== null slipped through");
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
    declared: { model: "@slow:xhigh", level: "xhigh" },
    resolved: { model: "anthropic/claude-opus-5", level: "high" },
  });
  assert.equal(line, "impl-9: declared @slow:xhigh/xhigh resolved anthropic/claude-opus-5/high");
});

// ---------------------------------------------------------------------------
// Review finding #2 (p1): the omp job-record short-circuit fires ONLY when
// BOTH fields are given; a partial record falls back to the transcript for
// the half it lacks, and never reports the missing half as `null`.
// ---------------------------------------------------------------------------

test("resolveActual: full job record (both fields) never reads transcriptText", () => {
  const r = resolveActual({ transcriptText: undefined, resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "high" });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "high", viaJobRecord: true });
});

test("resolveActual: resolvedModel alone falls back to the transcript for the thinking level, never `null`", () => {
  const r = resolveActual({
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: undefined,
    transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh"),
  });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "xhigh", viaJobRecord: false });
});

test("resolveActual: resolvedThinkingLevel alone falls back to the transcript for the model, never `null`", () => {
  const r = resolveActual({
    resolvedModel: undefined, resolvedThinkingLevel: "xhigh",
    transcriptText: ompTranscript("anthropic/claude-sonnet-5", "high"),
  });
  assert.deepEqual(r, { model: "anthropic/claude-sonnet-5", level: "xhigh", viaJobRecord: false });
});

test("resolveActual: neither job-record field given reads both off the transcript, preferring resolvedModelIdentity over the per-turn model", () => {
  const r = resolveActual({ transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh") });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "xhigh", viaJobRecord: false });
});

// Review finding #3 (p1): the identity exists BEFORE the first assistant
// turn — a member still working must resolve from it rather than reading a
// correctly-dispatched member as an unresolved mismatch.
test("resolveActual: a member with no assistant turn yet still resolves via resolvedModelIdentity", () => {
  const r = resolveActual({ transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh", { withTurn: false }) });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "xhigh", viaJobRecord: false });
});

test("evaluateMember: a still-running member (no assistant turn) at its declared tier reads ok, not a mismatch", () => {
  const r = evaluateMember({
    member: "StillRunning",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh", { withTurn: false }),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// resolvedPairFromRecord / evaluateMemberFromRecord — the `--session` path's
// pure core, over an already-resolved member-record.mjs row.
// ---------------------------------------------------------------------------

test("resolvedPairFromRecord: prefers resolvedModelIdentity over the per-turn model", () => {
  assert.deepEqual(
    resolvedPairFromRecord({ model: "claude-opus-5", resolvedModelIdentity: "anthropic/claude-opus-5", thinking: "xhigh" }),
    { model: "anthropic/claude-opus-5", level: "xhigh" },
  );
});

test("resolvedPairFromRecord: falls back to the record's own model when resolvedModelIdentity is absent", () => {
  assert.deepEqual(
    resolvedPairFromRecord({ model: "anthropic/claude-sonnet-5", thinking: "high" }),
    { model: "anthropic/claude-sonnet-5", level: "high" },
  );
});

test("evaluateMemberFromRecord: viaJobRecord is always false — reaching a record at all means a transcript was read", () => {
  const r = evaluateMemberFromRecord({
    member: "impl-1",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    record: { model: "anthropic/claude-opus-5", thinking: "xhigh" },
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.viaJobRecord, false);
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// AC 1 — every fleet agent, at the declared tier -> exit 0
// ---------------------------------------------------------------------------

test("AC1: fleet-implementer (@slow:xhigh) at declared tier -> ok", () => {
  const r = evaluateMember({
    member: "AgentWordPair",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    transcriptText: ompTranscript("anthropic/claude-opus-5", "xhigh"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("AC1: fleet-implementer-alt (@task:xhigh) at declared tier -> ok", () => {
  const r = evaluateMember({
    member: "AnotherWordPair",
    frontmatter: parseFrontmatter(agentMd("@task:xhigh")),
    transcriptText: ompTranscript("anthropic/claude-sonnet-5", "xhigh"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("AC1 end-to-end via the CLI: a batch of both agents, every one at its declared tier -> exit 0", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "fleet-implementer-alt.agent.md"), agentMd("@task:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  writeFileSync(join(d, "omp-impl-alt.jsonl"), ompTranscript("anthropic/claude-sonnet-5", "xhigh"));
  const batch = [
    { member: "OmpWordPairOne", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" },
    { member: "OmpWordPairTwo", agentFile: "fleet-implementer-alt.agent.md", transcript: "omp-impl-alt.jsonl" },
  ];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// AC 2 — the measured real case: resolved thinkingLevel `high` vs declared xhigh
// ---------------------------------------------------------------------------

test("AC2: resolved thinkingLevel `high` against declared `xhigh` -> mismatch naming both pairs", () => {
  const r = evaluateMember({
    member: "MeasuredRealCase",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    transcriptText: ompTranscript("anthropic/claude-opus-5", "high"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.declared, { model: "@slow:xhigh", level: "xhigh" });
  assert.deepEqual(r.resolved, { model: "anthropic/claude-opus-5", level: "high", viaJobRecord: false });
  assert.equal(formatMismatch(r), "MeasuredRealCase: declared @slow:xhigh/xhigh resolved anthropic/claude-opus-5/high");
});

test("AC2 end-to-end via the CLI: the same case exits 1 and prints the member and both pairs", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "high"));
  const batch = [{ member: "MeasuredRealCase", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /MeasuredRealCase: declared @slow:xhigh\/xhigh resolved anthropic\/claude-opus-5\/high/);
});

// ---------------------------------------------------------------------------
// AC 3 — role-target mismatch -> exit 1
// ---------------------------------------------------------------------------

test("AC3: role-target mismatch (declared @task, resolved smol's model) -> mismatch", () => {
  const r = evaluateMember({
    member: "RoleMismatch",
    frontmatter: parseFrontmatter(agentMd("@task:xhigh")),
    transcriptText: ompTranscript("anthropic/claude-haiku-4-5", "xhigh"),
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, false);
  assert.equal(formatMismatch(r), "RoleMismatch: declared @task:xhigh/xhigh resolved anthropic/claude-haiku-4-5/xhigh");
});

test("AC3 end-to-end via the CLI: a role-target mismatch exits 1", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-sonnet-5", "xhigh"));
  const batch = [{ member: "RoleMismatchCli", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /RoleMismatchCli: declared @slow:xhigh\/xhigh resolved anthropic\/claude-sonnet-5\/xhigh/);
});

// ---------------------------------------------------------------------------
// AC 4 — job record present: never opens the child's session file; absent:
// it opens the file.
// ---------------------------------------------------------------------------

test("AC4: resolvedModel/resolvedThinkingLevel given -> resolveActual never reads transcriptText", () => {
  const r = resolveActual({ transcriptText: undefined, resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "high" });
  assert.deepEqual(r, { model: "anthropic/claude-opus-5", level: "high", viaJobRecord: true });
});

test("AC4: job record present in a batch entry -> the CLI never opens (or even names) a transcript file", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  const batch = [{
    member: "JobRecordShortcut", agentFile: "fleet-implementer.agent.md",
    // No `transcript`/`session` key at all — proves the CLI does not
    // require, let alone open, a session file when BOTH job-record fields
    // are given.
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("AC4: job record absent -> the CLI opens the transcript file (and a missing one refuses, proving it tried)", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  const batch = [{
    member: "NoJobRecord", agentFile: "fleet-implementer.agent.md",
    transcript: "does-not-exist.jsonl",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /ENOENT|does-not-exist\.jsonl/);
});

test("AC4b: job record PARTIAL (resolvedModel only, no transcript/session given) -> refuses rather than defaulting the missing level to null", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  const batch = [{ member: "PartialNoFallback", agentFile: "fleet-implementer.agent.md", resolvedModel: "anthropic/claude-opus-5" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no --transcript or --session given/);
});

test("AC4c: job record PARTIAL (resolvedModel only) plus a transcript for the missing level -> resolves correctly, not a false mismatch", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{
    member: "PartialWithFallback", agentFile: "fleet-implementer.agent.md",
    resolvedModel: "anthropic/claude-opus-5", transcript: "omp-impl.jsonl",
  }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// ADR 0011/0014 — the declared alias routes through a role, and compare is
// against THAT role's own `modelRoles.<role>` target, never against the
// alias's own spelling.
// ---------------------------------------------------------------------------

test("an explicit override suffix reaching a `modelRoles.slow` target at the SAME generation reads ok", () => {
  const r = evaluateMember({
    member: "impl-1",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    resolvedModel: "anthropic/claude-opus-5-5:xhigh", resolvedThinkingLevel: "xhigh",
    modelRoles: { slow: "anthropic/claude-opus-5-5:high" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("the SAME declared/roles but resolved at an OLDER generation is NOT ok", () => {
  const r = evaluateMember({
    member: "impl-1",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
    modelRoles: { slow: "anthropic/claude-opus-5-5:high" },
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(formatMismatch(r), "impl-1: declared @slow:xhigh/xhigh resolved anthropic/claude-opus-5/xhigh");
  assert.equal(formatOmpExpectation(r), "    impl-1: omp routes @slow:xhigh through @slow = anthropic/claude-opus-5-5");
});

test("modelRoles.slow pointing at another role (`@plan`) resolves through the chain, even to a non-Anthropic model", () => {
  const r = evaluateMember({
    member: "impl-1",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    resolvedModel: "openai/gpt-5.4", resolvedThinkingLevel: "xhigh",
    modelRoles: { slow: "@plan", plan: "openai/gpt-5.4:high" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("an unset modelRoles.<role> reads not ok, and the expectation line names the unset role", () => {
  const r = evaluateMember({
    member: "impl-1",
    frontmatter: parseFrontmatter(agentMd("@slow:xhigh")),
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
    modelRoles: {},
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(formatOmpExpectation(r), "    impl-1: omp routes @slow:xhigh through @slow = (modelRoles.slow unset)");
});

test("a non-route declared model reads not ok, and the expectation line names it as unrouted", () => {
  const r = evaluateMember({
    member: "impl-1",
    frontmatter: parseFrontmatter(agentMd("opus")),
    resolvedModel: "anthropic/claude-opus-5", resolvedThinkingLevel: "xhigh",
    modelRoles: MODEL_ROLES,
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(formatOmpExpectation(r), /no role — model: is not a route/);
});

test("CLI: no --model-roles and no `omp` on PATH refuses naming the config read", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{ member: "NoPathOmp", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" }];
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
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{ member: "ArrModelRoles", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const arrPath = join(d, "model-roles.json");
  writeFileSync(arrPath, JSON.stringify(["not", "an", "object"]));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", arrPath]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// --session lookup (review finding #4): the controller supplies a session
// root it already knows instead of an exact transcript file.
// ---------------------------------------------------------------------------

test("--session: resolves via the flat <session>/<member>.jsonl file, bypassing readOmpMember's null-model gate", () => {
  const sessionDir = dir();
  // No assistant turn at all — proves this path does NOT filter out a
  // still-running member the way readOmpMember's `if (!folded.model) return
  // null` would (the exact gate this bypass exists to avoid).
  writeFileSync(join(sessionDir, "OmpSessionMember.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh", { withTurn: false }));
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  const batch = [{ member: "OmpSessionMember", agentFile: "fleet-implementer.agent.md", session: sessionDir }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("--session: no <member>.jsonl under the session root refuses by name", () => {
  const sessionDir = dir();
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  const batch = [{ member: "NoSuchMember", agentFile: "fleet-implementer.agent.md", session: sessionDir }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no NoSuchMember\.jsonl found under --session/);
});

// ---------------------------------------------------------------------------
// #1398 — an implementer is judged on the ledger's terms: its definition
// derived from the ticket row's `tier=`, its dispatched agent type read off
// its own transcript, and the verdict written back to the row either way —
// `tier-ok=impl-<N>:<definition>` on a pass, `settle impl-<N> tier-mismatch`
// on a failure. fleet-tick.mjs's deriveRun is the reader of both.
// ---------------------------------------------------------------------------

const ledgerCli = (file, ...args) => execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", file, ...args], { encoding: "utf8" });

// One implementer's world: its definitions under <d>/agents/, its ticket row
// on a --file ledger, its transcript at <d>/session/<member>.jsonl — the flat
// `session` lookup phase 2 hands the check.
function implWorld({
  ticket = 7, member = `impl-${ticket}`, row = `${member} · class=routine`,
  definitions = { "fleet-implementer": "@slow:high" },
  agent = "fleet-implementer", model = "anthropic/claude-opus-5", level = "high",
} = {}) {
  const d = dir();
  mkdirSync(join(d, "agents"));
  for (const [name, route] of Object.entries(definitions)) writeFileSync(join(d, "agents", `${name}.agent.md`), agentMd(route));
  const ledger = join(d, "ledger.md");
  ledgerCli(ledger, "row", String(ticket), row);
  mkdirSync(join(d, "session"));
  writeFileSync(join(d, "session", `${member}.jsonl`), ompTranscript(model, level, { agent }));
  writeFileSync(join(d, "batch.json"), JSON.stringify([{ member, session: "session" }]));
  const read = () => JSON.parse(ledgerCli(ledger, "read"));
  return {
    ledger, read,
    check: () => runCli(["--batch", "batch.json", "--repo", d, "--ledger", ledger, "--model-roles", modelRolesFile(d)], d),
    row: () => read().rows.find((r) => r.split(/\s/)[0] === `#${ticket}`),
    tick: () => deriveRun({ ...read(), drain: null }, []),
  };
}

test("implementer pass: exit 0 writes tier-ok=impl-<N>:<definition> onto the row exactly once, however often the check re-runs", () => {
  const w = implWorld();
  const r = w.check();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(w.row(), "#7 impl-7 · class=routine · tier-ok=impl-7:fleet-implementer");
  assert.equal(w.check().status, 0);
  assert.equal(w.row(), "#7 impl-7 · class=routine · tier-ok=impl-7:fleet-implementer", "a re-run grew the row");
  // The token is no longer the row's tail once the member settles and the
  // controller writes past it — a re-run still finds it.
  ledgerCli(w.ledger, "row", "7", "impl-7 · class=routine · tier-ok=impl-7:fleet-implementer · → PR#9");
  assert.equal(w.check().status, 0);
  assert.equal(w.row().split("tier-ok=").length - 1, 1, w.row());
});

test("implementer mismatch: exit 1 settles the member tier-mismatch on the ledger and notes why, once", () => {
  const w = implWorld({ model: "anthropic/claude-sonnet-5" });
  const r = w.check();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-7: declared @slow:high\/high resolved anthropic\/claude-sonnet-5\/high/);
  const row = w.row();
  assert.equal(row, "#7 impl-7=tier-mismatch · class=routine · impl-7: declared @slow:high/high resolved anthropic/claude-sonnet-5/high");
  assert.deepEqual(w.tick().tierMismatch, ["impl-7"]);
  const again = w.check();
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.equal(w.row(), row, "a re-run on an unchanged mismatch changed the row");
});

test("implementer: the expected definition follows the row's tier= — none, alt, and any other <cell>", () => {
  for (const [tier, definition] of [[null, "fleet-implementer"], ["alt", "fleet-implementer-alt"], ["slow-medium", "fleet-implementer-slow-medium"]]) {
    const w = implWorld({
      row: `impl-7 · class=routine${tier ? ` · tier=${tier}` : ""}`,
      definitions: { "fleet-implementer": "@slow:high", "fleet-implementer-alt": "@slow:high", "fleet-implementer-slow-medium": "@slow:high" },
      agent: definition,
    });
    const r = w.check();
    assert.equal(r.status, 0, `${tier}: ${r.stdout}${r.stderr}`);
    assert.ok(w.row().endsWith(` · tier-ok=impl-7:${definition}`), `${tier}: ${w.row()}`);
  }
  // The row's tier, not the dispatch, names the definition: an alt row whose
  // member ran the default definition fails even though that definition's
  // tier resolved exactly.
  const w = implWorld({ row: "impl-7 · tier=alt", definitions: { "fleet-implementer": "@slow:high", "fleet-implementer-alt": "@task:high" } });
  const r = w.check();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-7: dispatched fleet-implementer, expected fleet-implementer-alt/);
});

test("implementer: a cell with no definition file under agents/ fails as a mismatch rather than crashing the check", () => {
  const w = implWorld({ row: "impl-7 · tier=slow-medium", agent: "fleet-implementer-slow-medium" });
  const r = w.check();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-7: expected fleet-implementer-slow-medium has no agents\/fleet-implementer-slow-medium\.agent\.md/);
  assert.match(w.row(), /impl-7=tier-mismatch/);
});

test("implementer: a `task` dispatch fails even when the model and level it resolved match the definition's", () => {
  const w = implWorld({ agent: "task" });
  const r = w.check();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-7: dispatched task, expected fleet-implementer/);
  assert.doesNotMatch(r.stderr, /declared @slow/, "the model half passed and must not be reported as a mismatch");
  assert.match(w.row(), /impl-7=tier-mismatch/);
});

test("implementer: a member already settled another way records tier-mismatch as a row token and holds the tick", () => {
  const w = implWorld({ row: "impl-7=bailed · class=routine", agent: "task" });
  assert.deepEqual(w.tick().tierUnchecked, ["impl-7"], "a settled member with no verdict must hold as unchecked");
  const r = w.check();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(w.row(), "#7 impl-7=bailed · class=routine · tier-mismatch=impl-7:fleet-implementer · impl-7: dispatched task, expected fleet-implementer");
  assert.deepEqual([w.tick().tierMismatch, w.tick().tierUnchecked], [["impl-7"], []]);
  assert.equal(w.check().status, 1);
  assert.equal(w.row().split("tier-mismatch=").length - 1, 1, "a re-run wrote the token twice");
});

test("tick: a settled, unchecked implementer holds; a later tier-check writes tier-ok and the hold clears", () => {
  const w = implWorld({ row: "impl-7=released · class=routine" });
  assert.deepEqual(w.tick().tierUnchecked, ["impl-7"]);
  const r = w.check();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([w.tick().tierMismatch, w.tick().tierUnchecked], [[], []]);
});

test("expectedDefinition refuses a tier= it cannot name one definition file by", () => {
  assert.throws(() => expectedDefinition("impl-7 · tier=alt · tier=slow-high"), /conflicting tier= tokens \(tier=alt, tier=slow-high\)/);
  assert.throws(() => expectedDefinition("impl-7 · tier=../../etc"), /is not a definition suffix/);
  assert.equal(expectedDefinition("impl-7 · tier=alt · tier=alt"), "fleet-implementer-alt");
});

test("ledger append: a mismatch on a member with no derivable ticket (an omp AgentId) still exits 1 but writes no ledger row", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const ledgerFile = join(d, ".fleet", "ledger.md");
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "high"));
  const batch = [{ member: "SomeWordPair", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" }];
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

test("CLI: a batch entry missing member/agentFile refuses by naming the entry, not a generic parse error", () => {
  const d = dir();
  writeFileSync(join(d, "batch.json"), JSON.stringify([{ member: "SomeWordPair" }]));
  const r = runCli(["--batch", "batch.json", "--repo", d], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /missing member\/agentFile/);
});

test("CLI: an impl- entry carrying agentFile refuses — the definition is the ledger row's, never the caller's", () => {
  const d = dir();
  writeFileSync(join(d, "batch.json"), JSON.stringify([{ member: "impl-1", agentFile: "agents/fleet-implementer-alt.agent.md", session: "s" }]));
  const r = runCli(["--batch", "batch.json", "--repo", d, "--ledger", join(d, "ledger.md")], d, ["--model-roles", modelRolesFile(d)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /impl-1: an impl- entry carries no agentFile/);
});

test("CLI: --repo defaults to the script's own plugin/ root, so the real agents/fleet-implementer.agent.md is found without --repo", () => {
  const d = dir();
  const ledger = join(d, "ledger.md");
  ledgerCli(ledger, "row", "1", "impl-1");
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "high", { agent: "fleet-implementer" }));
  const batch = [{ member: "impl-1", transcript: join(d, "omp-impl.jsonl") }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", join(d, "batch.json"), "--ledger", ledger], d, ["--model-roles", modelRolesFile(d)]);
  // The real fleet-implementer declares @slow:high (implementer-model-tier.test.mjs
  // pins this) — this fixture's transcript matches it, so a correctly
  // resolved --repo default exits 0. A wrong default (or none) finds no
  // definition file and fails as a mismatch instead.
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// #1669: tier-check bound only makeDie/makeArg, so a stray or misspelled flag
// was silently ignored and the run computed a real verdict against the
// DEFAULT ledger/repo instead of refusing. sweep() closes that gap.
// ---------------------------------------------------------------------------

// No agent/transcript/batch-content fixtures here: sweep() dies on the
// stray flag immediately after the arg() reads, before main() ever opens
// --batch's own file (verified by mutation — deleting this file's fixture
// writes changes no assertion's outcome), so writing them would be dead
// setup that never runs.
test("CLI: an unknown flag outside the roster refuses by name, not a computed verdict", () => {
  const d = dir();
  const r = runCli(["--batch", "batch.json", "--repo", d, "--zz-no-such-flag"], d);
  assert.equal(r.status, 2);
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
  writeFileSync(join(d, "batch.json"), JSON.stringify([{ member: "impl-1", agentFile: "x.md" }]));
  const r = runCli(["--batch", "batch.json", "--repo", "d.md", "--ledger", "--zz-no-such-flag"], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!r.stderr.includes("unknown flag"));
  assert.match(r.stderr, /--ledger needs a value/);
});

// Review finding #1 (survived, confirmed): sweep() alone only refuses
// `--`-prefixed tokens, so the ticket's stated harm was only half closed —
// a single-dash misspelling (`-ledger`) rode through in silence the same
// way `--ledgerr` used to. Binding stray() alongside sweep(), the same
// pairing every sibling CLI (ci-state, diff-stats, board, pr-overlap)
// already uses, closes the other half.
test("CLI: a single-dash misspelling (`-ledger`) refuses as a stray, not a computed verdict", () => {
  const d = dir();
  writeFileSync(join(d, "fleet-implementer.agent.md"), agentMd("@slow:xhigh"));
  writeFileSync(join(d, "omp-impl.jsonl"), ompTranscript("anthropic/claude-opus-5", "xhigh"));
  const batch = [{ member: "impl-1", agentFile: "fleet-implementer.agent.md", transcript: "omp-impl.jsonl" }];
  writeFileSync(join(d, "batch.json"), JSON.stringify(batch));
  const r = runCli(["--batch", "batch.json", "--repo", d, "-ledger", "/tmp/should-not-be-read.tsv"], d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unexpected argument '-ledger'/);
});
