import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { join, dirname } from "node:path";

import {
  encodeProjectDir,
  readOmpMember, readOmpSession, foldOmpTranscript,
  readMembers,
} from "../plugin/scripts/member-record.mjs";

// ---------------------------------------------------------------------------
// cwd encoder, verified against real directory names
// ---------------------------------------------------------------------------

test("encodeProjectDir: home-relative cwd is `-` + segments joined by `-`, dots preserved", () => {
  // Verified 2026-09-09 against real `~/.omp/agent/sessions/*` directory
  // names on this machine, read out of each transcript's own
  // {"type":"session",...,"cwd":...} line:
  //   ~/dev/fleet-plugin -> -dev-fleet-plugin   (dir exists on disk)
  //   ~/.ssh             -> -.ssh               (dir exists on disk, dot kept)
  assert.equal(encodeProjectDir("/Users/chris/dev/fleet-plugin", { home: "/Users/chris" }), "-dev-fleet-plugin");
  assert.equal(encodeProjectDir("/Users/chris/.ssh", { home: "/Users/chris" }), "-.ssh");
});

test("encodeProjectDir: non-home cwd is realpath-resolved and double-dash wrapped", () => {
  // Verified 2026-09-09 against a real transcript's session line —
  // {"type":"session",...,"cwd":"/tmp/fix685/scratch"} — which lived under
  // ~/.omp/agent/sessions/--private-tmp-fix685-scratch--/. macOS symlinks
  // /tmp -> /private/tmp, which is why the ENCODING follows realpath rather
  // than the raw cwd; `realpath` is injected here so the assertion does not
  // depend on that scratch directory still existing on disk.
  const macRealpath = (p) => p.replace(/^\/tmp\b/, "/private/tmp");
  assert.equal(
    encodeProjectDir("/tmp/fix685/scratch", { home: "/Users/chris", realpath: macRealpath }),
    "--private-tmp-fix685-scratch--",
  );
  // Bare /tmp itself, confirmed against the real `--private-tmp--` directory.
  assert.equal(encodeProjectDir("/tmp", { home: "/Users/chris", realpath: macRealpath }), "--private-tmp--");
});

// ---------------------------------------------------------------------------
// omp fixtures — shaped like real ~/.omp/agent/sessions/**/*.jsonl lines,
// measured 2026-09-08/09 (see member-record.mjs's foldOmpTranscript comment).
// ---------------------------------------------------------------------------

const evt = (o) => JSON.stringify(o);
const sessionEvt = (cwd) => evt({ type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd });
const thinkingEvt = (level) => evt({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-08T15:11:49.494Z", thinkingLevel: level, configured: null });
const sessionInitEvt = (task, resolvedModelIdentity, agent) => evt({ type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-08T15:11:49.495Z", task, resolvedModelIdentity, agent });
const assistantEvt = (model, usage, ts = "2026-09-08T15:12:00.000Z") => evt({
  type: "message", id: "m1", parentId: "i1", timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], model, usage },
});

function ompSessionFixture(sessionName, files) {
  const root = tempDir("mr-omp-home-");
  const sessionsRoot = join(root, ".omp", "agent", "sessions", "-x");
  const sessionDir = join(sessionsRoot, sessionName);
  mkdirSync(sessionDir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    // `name` may itself carry `/` (a nested member, e.g. "Nested/Reviewer") —
    // create the parent dir so a fixture can exercise readOmpSession's own
    // recursive walk and the spawnDepth it reads off the path.
    mkdirSync(dirname(join(sessionDir, `${name}.jsonl`)), { recursive: true });
    writeFileSync(join(sessionDir, `${name}.jsonl`), lines.join("\n") + "\n");
  }
  return sessionDir;
}

test("readOmpMember: cost, tokens and thinking come off real usage/thinking_level_change shapes", () => {
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    thinkingEvt("xhigh"),
    sessionInitEvt("Implement ticket 580"),
    assistantEvt("claude-sonnet-5", { input: 2, output: 201, cacheRead: 0, cacheWrite: 31319, totalTokens: 31522, cost: { input: 4e-6, output: 0.00201, cacheRead: 0, cacheWrite: 0.0782975, total: 0.0803115 } }),
  ];
  const rec = readOmpMember(lines.join("\n"), "/fake/path.jsonl", "Memory1");
  assert.equal(rec.harness, "omp");
  assert.equal(rec.model, "claude-sonnet-5");
  assert.equal(rec.thinking, "xhigh");
  assert.equal(rec.tokens_in, 2);
  assert.equal(rec.tokens_cache_create, 31319);
  assert.equal(rec.tokens_cache_read, 0);
  assert.equal(rec.tokens_out, 201);
  assert.ok(Math.abs(rec.cost - 0.0803115) < 1e-9);
  assert.equal(rec.turns, 1);
});

test("readOmpMember: tokens_cache_write_1h sums each turn's usage.cttl.ephemeral1h, and is unknown when cache was written with no TTL split", () => {
  const turn = (cacheWrite, cttl, ts) => assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite, ...(cttl ? { cttl } : {}), cost: { total: 0.01 } }, ts);
  const rec = (...turns) => readOmpMember([sessionEvt("/x"), thinkingEvt("high"), ...turns].join("\n"), "/fake/path.jsonl", "impl-1");
  // Measured shapes: `{ephemeral1h:n}` and `{ephemeral5m:n}`, only on a turn that wrote cache.
  const mixed = rec(turn(300, { ephemeral1h: 300 }), turn(0, null, "2026-09-08T15:13:00.000Z"),
    turn(50, { ephemeral5m: 50 }, "2026-09-08T15:14:00.000Z"), turn(20, { ephemeral1h: 20 }, "2026-09-08T15:15:00.000Z"));
  assert.equal(mixed.tokens_cache_create, 370);
  assert.equal(mixed.tokens_cache_write_1h, 320);
  assert.equal(rec(turn(0, null)).tokens_cache_write_1h, 0, "nothing written is a real zero");
  assert.equal(rec(turn(40, null)).tokens_cache_write_1h, null, "cache written with no recorded split is unknown, never zero");
  assert.equal(rec(turn(300, { ephemeral1h: 300 }), turn(700, null, "2026-09-08T15:13:00.000Z")).tokens_cache_write_1h, null,
    "one cache-writing turn with no recorded split makes the whole figure unknown, never the recorded share alone");
});

test("readOmpMember: cost is null, never 0, when no turn carries usage.cost.total", () => {
  const rec = (...turns) => readOmpMember([sessionEvt("/x"), thinkingEvt("high"), ...turns].join("\n"), "/fake/path.jsonl", "impl-1");
  const noCost = assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  const priced = assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, "2026-09-08T15:13:00.000Z");
  assert.equal(rec(noCost).cost, null, "no figure recorded is blank, so pr-cost counts it unpriced instead of booking a free member");
  assert.equal(rec(noCost, noCost).cost, null);
  assert.equal(rec(noCost).turns, 1, "the turn itself still counts");
  assert.equal(rec(priced).cost, 0.25);
});

test("foldOmpTranscript: resolvedModelIdentity comes off session_init, present before any assistant turn (#1345)", () => {
  // Measured shape: always provider-prefixed (`anthropic/claude-opus-5`),
  // written at DISPATCH — before the member's first assistant turn, which
  // is exactly why this is a different field from `model` above rather than
  // a duplicate of it. No assistant turn at all here, so `model` stays null
  // while `resolvedModelIdentity` is already populated.
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    thinkingEvt("xhigh"),
    sessionInitEvt("Implement ticket 580", "anthropic/claude-opus-5"),
  ];
  const folded = foldOmpTranscript(lines.join("\n"), "/fake/path.jsonl");
  assert.equal(folded.model, null, "a member with no assistant turn yet must not fold a model from nowhere");
  assert.equal(folded.resolvedModelIdentity, "anthropic/claude-opus-5");
});

test("foldOmpTranscript: resolvedModelIdentity is null, never guessed, when session_init carries none", () => {
  const lines = [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("xhigh"), sessionInitEvt("Implement ticket 580")];
  assert.equal(foldOmpTranscript(lines.join("\n"), "/fake/path.jsonl").resolvedModelIdentity, null);
});

// omp 18.8.6 writes the dispatch-time model under `resolvedModel` (level
// suffix included) and no `resolvedModelIdentity` (measured 2026-10-09).
const sessionInitResolvedModelEvt = (fields) => evt({ type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-08T15:11:49.495Z", task: "Implement ticket 580", agent: "fleet-implementer-slow-high", ...fields });

test("foldOmpTranscript: session_init.resolvedModel folds as the dispatch-time identity when resolvedModelIdentity is absent, before any assistant turn", () => {
  const lines = [sessionEvt("/x"), thinkingEvt("high"), sessionInitResolvedModelEvt({ resolvedModel: "anthropic/claude-opus-5:high" })];
  const folded = foldOmpTranscript(lines.join("\n"), "/fake/path.jsonl");
  assert.equal(folded.model, null, "a member with no assistant turn yet must not fold a model from nowhere");
  assert.equal(folded.resolvedModelIdentity, "anthropic/claude-opus-5:high");
});

test("foldOmpTranscript: resolvedModelIdentity wins over resolvedModel when session_init carries both", () => {
  const lines = [sessionEvt("/x"), thinkingEvt("high"), sessionInitResolvedModelEvt({ resolvedModel: "anthropic/claude-sonnet-5:high", resolvedModelIdentity: "anthropic/claude-opus-5" })];
  assert.equal(foldOmpTranscript(lines.join("\n"), "/fake/path.jsonl").resolvedModelIdentity, "anthropic/claude-opus-5");
});

test("foldOmpTranscript: a malformed line away from the tail is counted, not silently dropped (#1717 review)", () => {
  // The tool-attribution stream (#1717) turned the pre-existing silent
  // per-line drop into a real hazard: losing a middle line can desync a
  // toolCall from its toolResult, not just cost its own turn's totals — the
  // same mid-file-tear shape `malformedNonLastLines` exists to catch.
  const good = assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 100, totalTokens: 0 });
  const torn = '{"type":"message","message":{"role":"ass';
  const folded = foldOmpTranscript([good, torn, good].join("\n") + "\n", "/fake/path.jsonl");
  assert.equal(folded.malformedNonLastLines, 1);
  assert.equal(folded.cacheWrite, 200, "surrounding turns still fold — only the torn line itself is lost");
});

test("foldOmpTranscript: a torn LAST line stays uncounted — the tear a live write legitimately produces", () => {
  const good = assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 100, totalTokens: 0 });
  const torn = '{"type":"message","message":{"role":"ass';
  // No trailing newline: the torn write is the final element of the split.
  const folded = foldOmpTranscript([good, torn].join("\n"), "/fake/path.jsonl");
  assert.equal(folded.malformedNonLastLines, 0);
  assert.equal(folded.cacheWrite, 100);
});

test("readOmpMember: resolvedModelIdentity rides alongside `model` as an additive field, never replacing it", () => {
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    thinkingEvt("xhigh"),
    sessionInitEvt("Implement ticket 580", "anthropic/claude-opus-5"),
    assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }),
  ];
  const rec = readOmpMember(lines.join("\n"), "/fake/path.jsonl", "Memory1");
  assert.equal(rec.model, "claude-opus-5", "the per-turn model board.mjs/member-outcomes.mjs already key on must stay unchanged");
  assert.equal(rec.resolvedModelIdentity, "anthropic/claude-opus-5");
});

test("readOmpMember: subagent_type is session_init's `agent`, blank when the transcript carries no session_init", () => {
  // #1066: the deliberate alternate-tier pair is identifiable ONLY from
  // what the dispatch named. It cannot ride on `role`: since #1486 both
  // definitions book `role=implementer`, so a role filter selects the
  // pair's members without saying which arm each is. A classification that
  // moved is why the join key is the dispatch RECORD.
  const withAgent = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("xhigh"),
    sessionInitEvt("Implement ticket 580", "anthropic/claude-sonnet-5", "fleet-implementer-alt"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }),
  ];
  assert.equal(readOmpMember(withAgent.join("\n"), "/fake/path.jsonl", "Alt1").subagent_type, "fleet-implementer-alt");

  const noInit = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("xhigh"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }),
  ];
  assert.equal(readOmpMember(noInit.join("\n"), "/fake/path.jsonl", "Alt2").subagent_type, "");
});

test("readOmpMember: subagent_type is `task` for an untyped dispatch, blank when session_init carries no string `agent`", () => {
  const readType = (init, stem) => readOmpMember([
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("xhigh"), init,
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }),
  ].join("\n"), "/fake/path.jsonl", stem).subagent_type;

  assert.equal(readType(sessionInitEvt("Implement ticket 580", "anthropic/claude-sonnet-5", "task"), "Untyped1"), "task");
  assert.equal(readType(sessionInitEvt("Implement ticket 580", "anthropic/claude-sonnet-5"), "NoAgent1"), "");
  assert.equal(readType(sessionInitEvt("Implement ticket 580", "anthropic/claude-sonnet-5", null), "NullAgent1"), "");
  assert.equal(readType(sessionInitEvt("Implement ticket 580", "anthropic/claude-sonnet-5", 7), "NumberAgent1"), "");
});

test("readOmpMember: cost and tokens sum across turns — one usage object per turn, no fold-back", () => {
  const usage = (cw) => ({ input: 1, output: 10, cacheRead: 5, cacheWrite: cw, totalTokens: cw + 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } });
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    thinkingEvt("high"),
    assistantEvt("claude-opus-5", usage(100)),
    assistantEvt("claude-opus-5", usage(200)),
  ];
  const rec = readOmpMember(lines.join("\n"), "/fake/path.jsonl", "Agent2");
  assert.equal(rec.turns, 2);
  assert.equal(rec.tokens_cache_create, 300);
  assert.equal(rec.tokens_out, 20);
  assert.ok(Math.abs(rec.cost - 0.02) < 1e-9);
});

test("readOmpMember: thinking is `-`, never blank, when no thinking_level_change event exists", () => {
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } }),
  ];
  const rec = readOmpMember(lines.join("\n"), "/fake/path.jsonl", "Agent3");
  assert.equal(rec.thinking, "-");
});

test("readOmpMember: a transcript with no assistant turn yields no row", () => {
  const lines = [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high")];
  assert.equal(readOmpMember(lines.join("\n"), "/fake/path.jsonl", "Idle"), null);
});

test("readOmpMember: a nested member whose task reads like a reviewer books as specialist — depth wins over text", () => {
  // The concrete misclassification this pins: a fan-out member dispatched
  // one level deep, whose own `session_init.task` happens to read like a
  // reviewer's ("Review PR 1353 correctness"), must not be read as a
  // top-level reviewer. classifyRole() checks spawnDepth BEFORE any text
  // match for exactly this reason; the fix is passing the real depth
  // through rather than defaulting it to 0.
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    sessionInitEvt("Review PR 1353 correctness"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } }),
  ];
  const rec = readOmpMember(lines.join("\n"), "/fake/path.jsonl", "NestedReviewer", 1);
  assert.equal(rec.role, "specialist");
});

test("readOmpMember: role comes off session_init's `agent`, the identity the row already records (#1486)", () => {
  // The defect this closes. `agent` was in scope and written to the row's own
  // `subagent_type` column, but never handed to classifyRole — so classifyRole's
  // FIRST branch, the one whose comment says memory-system work must "never land
  // in review spend", was structurally unreachable and every omp row's role
  // was decided by dispatch-prompt prose alone.
  //
  // Measured 2026-09-16 over the live corpus: 50 omp/memory-proxy rows, none of
  // them role=memory — 47 booked `other`, 2 `finisher`, 1 `reviewer`, entirely
  // on how each dispatch prompt happened to read. The task text below is a real
  // shape of that: prose that says "finish", from a member that is not a
  // finisher.
  const memory = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
    sessionInitEvt("Save the merge-bot label cycle memory, then finish PR 1485", "anthropic/claude-sonnet-5", "memory-proxy"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 41982, totalTokens: 2 }),
  ];
  const rec = readOmpMember(memory.join("\n"), "/fake/path.jsonl", "SaveMergeBotLabelCycleMemory", 0);
  assert.equal(rec.role, "memory");
  // The column and the role now read the same dispatch record rather than
  // disagreeing about what the member was.
  assert.equal(rec.subagent_type, "memory-proxy");

  // The review fan-out is the same defect at depth 0, which is where omp puts
  // it: `review-eval.mjs` runs inside the controller's own session, so a
  // depth-only rule cannot separate it from a top-level dispatch.
  const verifier = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
    sessionInitEvt("Refute finding unv1 on PR 1353", "anthropic/claude-sonnet-5", "fleet-review-verifier"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 2 }),
  ];
  assert.equal(readOmpMember(verifier.join("\n"), "/fake/path.jsonl", "RefuteUnvOne", 0).role, "specialist");

  const impl = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("xhigh"),
    sessionInitEvt("Your full dispatch brief is at local://dispatch-1486.md", "anthropic/claude-opus-5", "fleet-implementer"),
    assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 2 }),
  ];
  assert.equal(readOmpMember(impl.join("\n"), "/fake/path.jsonl", "InstallVerifySearch", 0).role, "implementer");
});

test("readOmpMember: the agent definition is a role signal in its own right, so a task-less dispatch still classifies", () => {
  // `hasRoleSignal` named two signals because only two existed; `agent` is now a
  // third, and leaving it out would REFUSE a classification to a row that holds
  // a perfectly readable identity. `session_init.task` is documented as present
  // only "when present", so this is a shape the format sanctions rather than one
  // invented here — measured 2026-09-16, 0 of 1,403 transcripts on disk carry
  // `agent` without `task` today, which is exactly why nothing else pins it.
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
    evt({ type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-08T15:11:49.495Z", resolvedModelIdentity: "anthropic/claude-sonnet-5", agent: "memory-proxy" }),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 2 }),
  ];
  assert.equal(readOmpMember(lines.join("\n"), "/fake/path.jsonl", "NoTaskMemory", 0).role, "memory");

  // And the hole stays visible where there genuinely is no signal: a transcript
  // with no session_init line at all still refuses to guess off the AgentId.
  const bare = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 2 }),
  ];
  assert.equal(readOmpMember(bare.join("\n"), "/fake/path.jsonl", "InstallVerifySearch", 0).role, "-");
});

test("readOmpMember: role is `-`, never a guess off the bare AgentId, when neither task nor depth gives a real signal", () => {
  // AgentId is a generated CamelCase word pair (`InstallVerifySearch`) — it
  // names nothing classifyRole can read, so guessing from it would invent a
  // classification rather than record one.
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } }),
  ];
  const rec = readOmpMember(lines.join("\n"), "/fake/path.jsonl", "InstallVerifySearch", 0);
  assert.equal(rec.role, "-");
});

test("readOmpMember: a canonically-named AgentId is itself a role signal under the default `task` definition (#1506)", () => {
  // `fix-pr-1380`, `merge-bot-5`, `impl-1049` and friends are dispatched
  // under run-team's default `task` definition — `session_init.agent` is the
  // literal string `task`, which no definition branch of classifyRole
  // matches. That is a different gap from #1502's: #1502 fixed a forwarding
  // bug where an EXISTING `folded.agent` value wasn't reaching classifyRole;
  // here the recorded definition names no role at all. But the AgentId
  // itself IS the dispatch name (run-team's own naming convention), so it
  // must reach classifyRole as `memberName` and win a real classification
  // even when the dispatch prompt's own prose says nothing role-shaped.
  const noKeywords = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
    sessionInitEvt("Apply the requested patch set and open a PR.", "anthropic/claude-sonnet-5", "task"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 12 }),
  ].join("\n");
  assert.equal(readOmpMember(noKeywords, "/fake/path.jsonl", "fix-pr-1380", 0).role, "reviewer");
  assert.equal(readOmpMember(noKeywords, "/fake/path.jsonl", "review-pr-42", 0).role, "reviewer");
  assert.equal(readOmpMember(noKeywords, "/fake/path.jsonl", "finisher-99", 0).role, "finisher");
  assert.equal(readOmpMember(noKeywords, "/fake/path.jsonl", "finish-7", 0).role, "finisher");
  assert.equal(readOmpMember(noKeywords, "/fake/path.jsonl", "impl-1049", 0).role, "implementer");
  assert.equal(readOmpMember(noKeywords, "/fake/path.jsonl", "merge-bot-5", 0).role, "merge-bot");
});

test("readOmpMember: a canonically-named AgentId still classifies with no session_init line at all — the stem widens `hasRoleSignal` itself (#1506)", () => {
  // Unlike the generated-word-pair case above, a canonical name is a
  // readable identity even when the transcript predates #1343 and carries
  // neither `task` nor `agent`. The hole must not swallow a real signal —
  // checked against every prefix `OMP_CANONICAL_STEM_RE` names, not just one,
  // so a mutant that drops a prefix from the gate fails here even though the
  // memberName-reaches-classifyRole test above cannot see it (that fixture's
  // `session_init.task` already satisfies `hasRoleSignal` on its own).
  const bare = [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 12 }),
  ].join("\n");
  assert.equal(readOmpMember(bare, "/fake/path.jsonl", "fix-pr-1516", 0).role, "reviewer");
  assert.equal(readOmpMember(bare, "/fake/path.jsonl", "review-pr-77", 0).role, "reviewer");
  assert.equal(readOmpMember(bare, "/fake/path.jsonl", "finisher-3", 0).role, "finisher");
  assert.equal(readOmpMember(bare, "/fake/path.jsonl", "finish-3", 0).role, "finisher");
  assert.equal(readOmpMember(bare, "/fake/path.jsonl", "impl-1516", 0).role, "implementer");
  assert.equal(readOmpMember(bare, "/fake/path.jsonl", "merge-bot-3", 0).role, "merge-bot");
});

test("readOmpMember: a real agent definition still wins over a coincidentally name-shaped AgentId (#1506)", () => {
  // Guards the ordering: classifyRole's definition-based branches run BEFORE
  // the name/description patterns, so a member dispatched under a real
  // definition must classify on that definition regardless of what its
  // AgentId happens to look like.
  const lines = [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
    sessionInitEvt("Run the correctness review dimension.", "anthropic/claude-sonnet-5", "fleet-review-verifier"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 12 }),
  ].join("\n");
  assert.equal(readOmpMember(lines, "/fake/path.jsonl", "review-pr-42", 0).role, "specialist");
});

// #2209: `pr` for a member whose NAME carries none (every implementer) comes
// from the transcript's own `gh pr create` result. Shapes measured 2026-09-29
// across every real ~/.omp/agent/sessions/**/*.jsonl: the call is a `bash`
// toolCall block, the result its own `toolResult` line whose first text block
// holds gh's stdout — the PR URL on a line of its own — then omp's
// "Wall time" trailer, sometimes followed by a second injected text block.
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, totalTokens: 12 };
const bashCallEvt = (id, command) => evt({
  type: "message", id: `c-${id}`, parentId: "i1", timestamp: "2026-09-08T15:12:00.000Z",
  message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command, i: "x" } }], model: "claude-sonnet-5", usage: USAGE },
});
const bashResultEvt = (id, text, isError = false) => evt({
  type: "message", id: `r-${id}`, parentId: `c-${id}`, timestamp: "2026-09-08T15:12:01.000Z",
  message: {
    role: "toolResult", toolCallId: id, toolName: "bash",
    content: [{ type: "text", text }, { type: "text", text: "Memory check: skip if nothing notable." }], isError,
  },
});
const memberWith = (stem, ...calls) => readOmpMember([
  sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
  sessionInitEvt("Implement ticket 7", "anthropic/claude-sonnet-5"),
  ...calls.flat(),
].join("\n"), "/fake/path.jsonl", stem, 0);
const created = (id, command, text) => [bashCallEvt(id, command), bashResultEvt(id, text)];
const CREATE = 'cd /wt && rtk git push -u origin HEAD && rtk gh pr create --base main --title "t" --body-file /tmp/b.md';

test("readOmpMember: pr is the PR the member's own `gh pr create` printed; the name-carried ticket stays (#2209)", () => {
  const rec = memberWith("impl-7", created("t1", CREATE, "https://github.com/feigi/fleet-plugin/pull/1528\n\n\nWall time: 2.05 seconds"));
  assert.equal(rec.pr, "1528");
  assert.equal(rec.ticket, "7");
});

test("readOmpMember: the created PR is accepted whatever the member's name shape, host, or chain position (#2209)", () => {
  // A generated or non-canonical AgentId (`Impl676`, `impl1230`) names no
  // ticket, yet those members opened PRs too (Impl1335..Impl1349, impl1230, ...).
  // A GitHub Enterprise host prints the same one-URL line; `gh pr create`
  // first in the command, after `&&`, or on its own line all invoke it.
  assert.equal(memberWith("Impl676", created("t1", "gh pr create --fill", "https://bmw.ghe.com/CoCo/agent-brain/pull/688\n\nWall time: 2.06 seconds")).pr, "688");
  assert.equal(memberWith("impl1230", created("t1", "cat > /tmp/b <<'EOF'\nbody\nEOF\ngh pr create -F /tmp/b", "https://github.com/o/r/pull/1629\n")).pr, "1629");
  // The same PR printed twice (a retried call) is still one PR.
  assert.equal(memberWith("impl-7",
    created("t1", CREATE, "https://github.com/o/r/pull/12\n"),
    created("t2", CREATE, "https://github.com/o/r/pull/12\n")).pr, "12");
  // A non-zero exit AFTER the create (`gh pr create ... && gh pr edit
  // --add-label` where the label write fails) still printed a real, opened PR.
  assert.equal(memberWith("impl-7", [bashCallEvt("t1", `${CREATE} && gh pr edit --add-label patch`),
    bashResultEvt("t1", "https://github.com/o/r/pull/31\nfailed to update: label not found\n", true)]).pr, "31");
});

test("readOmpMember: pr stays blank, never guessed, when no call of the member's own created exactly one PR (#2209)", () => {
  const cases = {
    // A URL line from a command that merely READS a PR.
    "view, not create": created("t1", "gh pr view 5 --json url -q .url", "https://github.com/o/r/pull/5\n"),
    // `gh pr create` quoted as text is not an invocation of it.
    "create only quoted": created("t1", 'echo "next: gh pr create"; gh pr view 5 --json url -q .url', "next: gh pr create\nhttps://github.com/o/r/pull/5\n"),
    // gh's refusal names the PR someone ELSE already opened for the branch.
    "already exists": created("t1", CREATE, 'a pull request for branch "fix/7" into branch "main" already exists:\nhttps://github.com/o/r/pull/9\n'),
    // A URL inside prose is not gh's own output line.
    "url in prose": created("t1", CREATE, "see https://github.com/o/r/pull/9 for context\n"),
    // A create outrunning the tool timeout — the URL never reaches this result.
    "backgrounded": created("t1", CREATE, "Backgrounded as job bg_15; result will be delivered automatically."),
    // Two distinct PRs (a real one plus a throwaway probe, measured on
    // impl-1578): picking either is a guess.
    "two distinct PRs": [
      ...created("t1", CREATE, "https://github.com/o/r/pull/1681\n"),
      ...created("t2", CREATE, "https://github.com/o/r/pull/1682\n"),
    ],
  };
  for (const [label, lines] of Object.entries(cases)) {
    assert.equal(memberWith("impl-7", lines).pr, "", label);
  }
});

test("readOmpMember: a PR-named member keeps the PR its name carries over any PR it created (#2209)", () => {
  // `fix-pr-9` works PR 9 by construction; a PR it opened on the side is not
  // its unit of work and must not repoint its join into tier-outcomes.tsv.
  assert.equal(memberWith("fix-pr-9", created("t1", CREATE, "https://github.com/o/r/pull/12\n")).pr, "9");
});

test("readOmpSession: one row per member file, stamped with the session dir name", () => {
  const dir = ompSessionFixture("2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127", {
    Memory1: [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"), assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } })],
    Memory2: [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"), assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.002 } })],
  });
  const rows = readOmpSession(dir);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.harness), ["omp", "omp"]);
  assert.deepEqual(new Set(rows.map((r) => r.agent)), new Set(["Memory1", "Memory2"]));
  assert.ok(rows.every((r) => r.session === "2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127"));
});

test("readOmpSession: nesting depth is read off the path and feeds classifyRole's depth-first rule", () => {
  const dir = ompSessionFixture("2026-09-09T02-00-00-000Z_cafef00d-cafe-cafe-cafe-cafef00dcafe", {
    "Nested/Reviewer": [
      sessionEvt("/x"), sessionInitEvt("Review PR 1353 correctness"),
      assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } }),
    ],
  });
  const rows = readOmpSession(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "Nested/Reviewer");
  assert.equal(rows[0].role, "specialist");
});

// ---------------------------------------------------------------------------
// readMembers — the tree-walking entry point
// ---------------------------------------------------------------------------

test("readMembers: multiple roots merge into one array", () => {
  const dirA = ompSessionFixture("2026-09-09T00-00-00-000Z_deadbeef-dead-dead-dead-deadbeefdead", {
    Solo: [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"), assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } })],
  });
  const dirB = ompSessionFixture("2026-09-09T03-00-00-000Z_feedface-feed-face-feed-facefeedface", {
    Solo2: [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"), assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.002 } })],
  });
  const rows = readMembers([dirA, dirB]);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.agent)), new Set(["Solo", "Solo2"]));
});

test("readMembers: a loose top-level session .jsonl FILE beside session directories is not swept in as a member, and `session` is the session directory's own name", () => {
  // Regression fixture for the real tree's shape:
  // ~/.omp/agent/sessions/-dev-fleet-plugin/ holds the project's MAIN-session
  // transcripts as plain FILES sibling to the per-session DIRECTORIES. The
  // old `.jsonl`-presence shortcut in findOmpSessionDirs matched the
  // encoded-cwd directory itself for that reason, stamping every row
  // `session=-dev-fleet-plugin` instead of the `<ISO>_<uuid>` name and
  // booking the loose top-level file as a member.
  const root = tempDir("mr-omp-realshape-");
  const encDir = join(root, ".omp", "agent", "sessions", "-dev-fleet-plugin");
  const sessionName = "2026-09-08T14-14-34-049Z_01a0815e-e141-716c-b2d8-2adf310fbe55";
  const sessionDir = join(encDir, sessionName);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(encDir, `${sessionName}.jsonl`), [
    sessionEvt("/Users/chris/dev/fleet-plugin"),
    assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.999 } }),
  ].join("\n") + "\n");
  writeFileSync(join(sessionDir, "Member1.jsonl"), [
    sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"),
    assistantEvt("claude-opus-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.002 } }),
  ].join("\n") + "\n");
  const rows = readMembers([encDir]);
  assert.equal(rows.length, 1, "the loose top-level main-session file must not be swept in as a member");
  assert.equal(rows[0].agent, "Member1");
  assert.equal(rows[0].session, sessionName, "session must be the <ISO>_<uuid> DIRECTORY name, not the encoded-cwd dir");
});

test("readMembers: a not-omp-shaped file under an omp root is refused loudly, not silently parsed", () => {
  const ompDir = ompSessionFixture("2026-09-09T01-00-00-000Z_baadf00d-baad-baad-baad-baadf00dbaad", {});
  // `sessionId`/`parentUuid` are assertOmpShaped's own structural check — an
  // omp line never carries either (session id lives in the DIRECTORY name);
  // any line that does is a foreign or corrupted file, not this reader's
  // business to guess at.
  const foreignShaped = JSON.stringify({
    type: "assistant", sessionId: "sess-1", uuid: "u1", timestamp: "2026-08-25T07:14:12.147Z",
    message: { id: "m1", model: "claude-opus-5" },
  });
  writeFileSync(join(ompDir, "wrong-root.jsonl"), foreignShaped + "\n");
  assert.throws(() => readMembers([ompDir]), /wrong-root\.jsonl/);
});

test("readMembers: a line matching NEITHER shape (no `type`, no Claude keys) is refused loudly too, not folded into a fabricated null record", () => {
  // The blocklist half of assertOmpShaped (sessionId/parentUuid absence)
  // only catches a Claude-shaped foreign line. A line that is foreign or
  // corrupted in some OTHER way — missing omp's own `type` field entirely —
  // used to pass that check silently and fold into an all-null/zero member
  // record instead of the refusal the function's own comment promises.
  const ompDir = ompSessionFixture("2026-09-09T02-00-00-000Z_deadbeef-dead-dead-dead-deadbeefdead", {});
  writeFileSync(join(ompDir, "no-envelope.jsonl"), JSON.stringify({ foo: "bar" }) + "\n");
  assert.throws(() => readMembers([ompDir]), /no-envelope\.jsonl/);
});

test("readMembers: a root holding no omp session directory anywhere is refused, not silently empty", () => {
  const stray = tempDir("mr-stray-");
  assert.throws(() => readMembers([stray]), /no omp session directory/);
});
