import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  encodeClaudeProjectDir, encodeOmpProjectDir,
  readClaudeMember, readClaudeSession,
  readOmpMember, readOmpSession,
  readMembers,
} from "./member-record.mjs";

// ---------------------------------------------------------------------------
// cwd encoders, verified against real directory names
// ---------------------------------------------------------------------------

test("encodeClaudeProjectDir replaces every non-alphanumeric character, dots included", () => {
  assert.equal(encodeClaudeProjectDir("/Users/x/.claude"), "-Users-x--claude");
  assert.equal(encodeClaudeProjectDir("/Users/x/dev/repo"), "-Users-x-dev-repo");
});

test("readClaudeMember: harness is claude and cost is null — no pricing table exists in this repo", () => {
  const line = JSON.stringify({
    type: "assistant", sessionId: "sess-1", uuid: "u1", timestamp: "2026-08-25T07:14:12.147Z",
    message: { id: "m1", model: "claude-opus-5", usage: { cache_creation_input_tokens: 10, output_tokens: 1 } },
  });
  const rec = readClaudeMember(line, { name: "impl-580", agentType: "impl-580", spawnDepth: 0 });
  assert.equal(rec.harness, "claude");
  assert.equal(rec.model, "claude-opus-5");
  assert.equal(rec.cost, null);
  assert.equal(rec.ticket, "580");
});

test("readClaudeMember: thinking is `-`, never blank, when the transcript carries no `d.effort` (haiku has no effort control)", () => {
  const line = JSON.stringify({
    type: "assistant", sessionId: "sess-1", uuid: "u1", timestamp: "2026-08-25T07:14:12.147Z",
    message: { id: "m1", model: "claude-haiku-4-5-20251001", usage: { cache_creation_input_tokens: 10, output_tokens: 1 } },
  });
  const rec = readClaudeMember(line, { name: "impl-580", agentType: "impl-580", spawnDepth: 0 });
  assert.equal(rec.thinking, "-");
});

test("encodeOmpProjectDir: home-relative cwd is `-` + segments joined by `-`, dots preserved", () => {
  // Verified 2026-09-09 against real `~/.omp/agent/sessions/*` directory
  // names on this machine, read out of each transcript's own
  // {"type":"session",...,"cwd":...} line:
  //   ~/dev/fleet-plugin -> -dev-fleet-plugin   (dir exists on disk)
  //   ~/.claude          -> -.claude            (dir exists on disk, dot kept)
  assert.equal(encodeOmpProjectDir("/Users/chris/dev/fleet-plugin", { home: "/Users/chris" }), "-dev-fleet-plugin");
  assert.equal(encodeOmpProjectDir("/Users/chris/.claude", { home: "/Users/chris" }), "-.claude");
});

test("encodeOmpProjectDir: non-home cwd is realpath-resolved and double-dash wrapped", () => {
  // Verified 2026-09-09 against a real transcript's session line —
  // {"type":"session",...,"cwd":"/tmp/fix685/scratch"} — which lived under
  // ~/.omp/agent/sessions/--private-tmp-fix685-scratch--/. macOS symlinks
  // /tmp -> /private/tmp, which is why the ENCODING follows realpath rather
  // than the raw cwd; `realpath` is injected here so the assertion does not
  // depend on that scratch directory still existing on disk.
  const macRealpath = (p) => p.replace(/^\/tmp\b/, "/private/tmp");
  assert.equal(
    encodeOmpProjectDir("/tmp/fix685/scratch", { home: "/Users/chris", realpath: macRealpath }),
    "--private-tmp-fix685-scratch--",
  );
  // Bare /tmp itself, confirmed against the real `--private-tmp--` directory.
  assert.equal(encodeOmpProjectDir("/tmp", { home: "/Users/chris", realpath: macRealpath }), "--private-tmp--");
});

// ---------------------------------------------------------------------------
// omp fixtures — shaped like real ~/.omp/agent/sessions/**/*.jsonl lines,
// measured 2026-09-08/09 (see member-record.mjs's foldOmpTranscript comment).
// ---------------------------------------------------------------------------

const evt = (o) => JSON.stringify(o);
const sessionEvt = (cwd) => evt({ type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd });
const thinkingEvt = (level) => evt({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-08T15:11:49.494Z", thinkingLevel: level, configured: null });
const sessionInitEvt = (task) => evt({ type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-08T15:11:49.495Z", task });
const assistantEvt = (model, usage, ts = "2026-09-08T15:12:00.000Z") => evt({
  type: "message", id: "m1", parentId: "i1", timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], model, usage },
});

function ompSessionFixture(sessionName, files) {
  const root = mkdtempSync(join(tmpdir(), "mr-omp-home-"));
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
// readMembers — the one entry point that owns both roots
// ---------------------------------------------------------------------------

function claudeSessionFixture(members) {
  const root = mkdtempSync(join(tmpdir(), "mr-claude-"));
  const dir = join(root, ".claude", "projects", "-x", "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  const claudeLine = (id) => JSON.stringify({
    type: "assistant", sessionId: "sess-1", uuid: id, timestamp: "2026-08-25T07:14:12.147Z",
    message: { id, model: "claude-opus-5", usage: { cache_creation_input_tokens: 10, output_tokens: 1 } },
  });
  for (const [agent, meta] of members) {
    writeFileSync(join(dir, `${agent}.jsonl`), claudeLine(`msg-${agent}`) + "\n");
    writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify(meta));
  }
  return join(root, ".claude", "projects", "-x", "sess-1");
}

test("readMembers: a mixed set of roots yields one array whose harness column is correct per row", () => {
  const claudeSession = claudeSessionFixture([["agent-a1", { name: "impl-1", agentType: "impl-1", spawnDepth: 0 }]]);
  const ompDir = ompSessionFixture("2026-09-09T00-00-00-000Z_deadbeef-dead-dead-dead-deadbeefdead", {
    Solo: [sessionEvt("/Users/chris/dev/fleet-plugin"), thinkingEvt("high"), assistantEvt("claude-sonnet-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } })],
  });
  const rows = readMembers([claudeSession, ompDir]);
  assert.equal(rows.length, 2);
  const byHarness = Object.fromEntries(rows.map((r) => [r.harness, r]));
  assert.equal(byHarness.claude.member, "impl-1");
  assert.equal(byHarness.omp.agent, "Solo");
});

test("readMembers: a loose top-level session .jsonl FILE beside session directories is not swept in as a member, and `session` is the session directory's own name", () => {
  // Regression fixture for the real tree's shape:
  // ~/.omp/agent/sessions/-dev-fleet-plugin/ holds the project's MAIN-session
  // transcripts as plain FILES sibling to the per-session DIRECTORIES. The
  // old `.jsonl`-presence shortcut in findOmpSessionDirs matched the
  // encoded-cwd directory itself for that reason, stamping every row
  // `session=-dev-fleet-plugin` instead of the `<ISO>_<uuid>` name and
  // booking the loose top-level file as a member.
  const root = mkdtempSync(join(tmpdir(), "mr-omp-realshape-"));
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

test("readMembers: a Claude-shaped file under the omp root is refused loudly, not parsed as omp", () => {
  const ompDir = ompSessionFixture("2026-09-09T01-00-00-000Z_baadf00d-baad-baad-baad-baadf00dbaad", {});
  // A real Claude line carries `sessionId` on every line (measured against
  // ~/.claude/projects/**/subagents/*.jsonl); an omp line never does.
  const claudeShaped = JSON.stringify({
    type: "assistant", sessionId: "sess-1", uuid: "u1", timestamp: "2026-08-25T07:14:12.147Z",
    message: { id: "m1", model: "claude-opus-5", usage: { cache_creation_input_tokens: 10, output_tokens: 1 } },
  });
  writeFileSync(join(ompDir, "wrong-root.jsonl"), claudeShaped + "\n");
  assert.throws(() => readMembers([ompDir]), /wrong-root\.jsonl/);
});

test("readMembers: an omp-shaped file under the Claude root is refused loudly, not silently skipped", () => {
  // Mirrors the omp-side test above: `thinking_level_change`'s `parentId`
  // key is omp's own envelope signature, never present on a real Claude
  // line (which spells it `parentUuid`), and never set by any Claude
  // fixture in this repo either — a safe positive check.
  const claudeSession = claudeSessionFixture([["agent-a1", { name: "impl-1", agentType: "impl-1", spawnDepth: 0 }]]);
  writeFileSync(join(claudeSession, "subagents", "wrong-root.jsonl"), thinkingEvt("high") + "\n");
  assert.throws(() => readMembers([claudeSession]), /wrong-root\.jsonl/);
});

test("readMembers: a Claude root with no subagents/ directory anywhere is refused, not silently empty", () => {
  // The omp side of this exact mistake: dropping an omp session directory
  // (no `subagents/` child anywhere) under `~/.claude/projects/<enc>/`.
  const root = mkdtempSync(join(tmpdir(), "mr-claude-empty-"));
  const encDir = join(root, ".claude", "projects", "-x");
  mkdirSync(encDir, { recursive: true });
  assert.throws(() => readMembers([encDir]), /no subagents\/ directory/);
});

test("readMembers: a root under neither tree is refused, not silently empty", () => {
  const stray = mkdtempSync(join(tmpdir(), "mr-stray-"));
  assert.throws(() => readMembers([stray]), /neither a Claude nor an omp/);
});

test("readClaudeSession and readOmpSession agree on the record's harness field for their own harness", () => {
  const claudeSession = claudeSessionFixture([["agent-a1", { name: "impl-1", agentType: "impl-1", spawnDepth: 0 }]]);
  const claudeRows = readClaudeSession(join(claudeSession, "subagents"));
  assert.equal(claudeRows.length, 1);
  assert.equal(claudeRows[0].harness, "claude");
  assert.equal(claudeRows[0].cost, null);
});
