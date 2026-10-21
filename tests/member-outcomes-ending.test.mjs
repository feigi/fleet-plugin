import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { join, dirname } from "node:path";
import { rowsForSession, endingOf, COLUMNS } from "../plugin/scripts/member-outcomes.mjs";

// ---------------------------------------------------------------------------
// Fixtures shaped like real omp transcripts: the lines the ending reads.
// ---------------------------------------------------------------------------

const SESSION = "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890";
const T0 = "2026-08-25T09:00:00.000Z";
const T1 = "2026-08-25T10:00:00.000Z";
const REPORTS = "/Users/chris/.fleet/scratch/fleet-plugin-28971265/reports";
const evt = (o) => JSON.stringify(o);
const sessionInit = (agent, at = T0) => evt({ type: "session_init", timestamp: at, task: "Implement ticket", agent });
const modelChange = (fallback = false, at = T0) => evt({ type: "model_change", timestamp: at, model: "anthropic/claude-haiku-5-5", resolvedModelIsFallback: fallback });
const turn = ({ stopReason = "stop", blocks = [{ type: "text", text: "ok" }], at = T0 } = {}) => evt({
  type: "message", timestamp: at,
  message: { role: "assistant", content: blocks, model: "claude-opus-5", stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } } },
});
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, text) => evt({ type: "message", timestamp: T0, message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } });
const userMsg = (text) => evt({ type: "message", timestamp: T0, message: { role: "user", content: [{ type: "text", text }] } });
const exitEvt = () => evt({ type: "custom", customType: "session_exit", timestamp: T0, data: { reason: "dispose", kind: "normal" } });
const reportJson = (member, o = {}) => JSON.stringify({
  member, outcome: "bailed", pr: null, head: null, branch: `implementer/${member}`,
  sizing: null, bailCause: "undecided", bailDetail: "needs a human line", confirmation: [], ...o,
});
const reportWrite = (member, o) => turn({ stopReason: "toolUse", blocks: [call("w1", "write", { path: `${REPORTS}/${member}.json`, content: reportJson(member, o) })] });
const heredocWrite = (member, o) => turn({
  stopReason: "toolUse",
  blocks: [call("b1", "bash", { command: `cat > ${REPORTS}/${member}.json <<'EOF'\n${reportJson(member, o)}\nEOF` })],
});
// A clean finish: the member ran, then stopped with the session exiting.
const finished = (extra = []) => [modelChange(), ...extra, turn(), exitEvt()];

// A session dir holding `members` as `<name>.jsonl`, each file's lines; `yields`
// names the members whose `<name>.md` sidecar is written beside them.
function session(members, yields = []) {
  const root = tempDir("moe-");
  const dir = join(root, SESSION);
  for (const [name, lines] of Object.entries(members)) {
    const file = join(dir, `${name}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
    utimesSync(file, new Date("2026-08-25T09:00:00Z"), new Date("2026-08-25T09:00:00Z"));
  }
  for (const name of yields) writeFileSync(join(dir, `${name}.md`), "# yield\n");
  return dir;
}

const endingOfMember = (dir, member, verifyMain = () => 0) => {
  const row = rowsForSession(dir, {}, { verifyMain }).find((r) => r.member === member);
  assert.ok(row, `no row for ${member}`);
  return row.ending;
};

// ---------------------------------------------------------------------------
// The column itself
// ---------------------------------------------------------------------------

test("`ending` is the last column, after the four priced columns", () => {
  assert.equal(COLUMNS.at(-1), "ending");
  assert.deepEqual(COLUMNS.slice(-2), ["cost", "ending"]);
});

test("only implementer rows carry an ending: review, fix, finisher and merge-bot rows are blank", () => {
  const dir = session({
    "impl-10": finished(),
    "impl-10-b": finished(),
    "review-pr-5": finished(),
    "fix-pr-6-b": finished(),
    "merge-bot-7": finished(),
  });
  const byMember = Object.fromEntries(rowsForSession(dir, {}, { verifyMain: () => 0 }).map((r) => [r.member, r.ending]));
  assert.notEqual(byMember["impl-10"], "");
  assert.notEqual(byMember["impl-10-b"], "");
  assert.equal(byMember["review-pr-5"], "");
  assert.equal(byMember["fix-pr-6-b"], "");
  assert.equal(byMember["merge-bot-7"], "");
});

test("an implementer that named its own PR reads pr, whatever else its transcript says", () => {
  const dir = session({
    "impl-20": finished([
      turn({ stopReason: "toolUse", blocks: [call("g1", "bash", { command: "gh pr create --title x" })] }),
      result("g1", "https://github.com/chris/fleet-plugin/pull/4242"),
    ]),
  });
  assert.equal(endingOfMember(dir, "impl-20"), "pr");
});

// ---------------------------------------------------------------------------
// bail:<cause>, from the member's report in the transcript
// ---------------------------------------------------------------------------

test("a report written with the write tool that bails undecided reads bail:undecided", () => {
  const dir = session({ "impl-30": [modelChange(), sessionInit("fleet-implementer"), reportWrite("impl-30"), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-30"), "bail:undecided");
});

test("a report written with a bash heredoc reads its bail cause the same way", () => {
  const dir = session({ "impl-31": [modelChange(), heredocWrite("impl-31", { bailCause: "hands", bailDetail: "needs a key" }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-31"), "bail:hands");
});

test("a bail naming a fixed sha reads bail:fixed when origin/main reaches that sha", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  const dir = session({ "impl-32": [modelChange(), reportWrite("impl-32", { bailCause: "fixed", bailDetail: `${sha} — fixed on main` }), exitEvt()] });
  const asked = [];
  const row = rowsForSession(dir, {}, { verifyMain: (s) => { asked.push(s); return 0; } }).find((r) => r.member === "impl-32");
  assert.equal(row.ending, "bail:fixed");
  assert.deepEqual(asked, [sha]);
});

test("a fixed sha origin/main does not reach reads bail:fixed-refuted", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  const dir = session({ "impl-33": [modelChange(), reportWrite("impl-33", { bailCause: "fixed", bailDetail: `${sha} — claimed` }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-33", () => 1), "bail:fixed-refuted");
});

test("a fixed bail the verifier cannot answer, or whose detail names no sha, reads unknown", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  const cannot = session({ "impl-34": [modelChange(), reportWrite("impl-34", { bailCause: "fixed", bailDetail: `${sha} — x` }), exitEvt()] });
  assert.equal(endingOfMember(cannot, "impl-34", () => 2), "unknown");
  const noSha = session({ "impl-35": [modelChange(), reportWrite("impl-35", { bailCause: "fixed", bailDetail: "fixed upstream" }), exitEvt()] });
  assert.equal(endingOfMember(noSha, "impl-35"), "unknown");
});

test("a bailed report with a null cause is not a bail, and reads the stop it actually had", () => {
  const dir = session({ "impl-36": [modelChange(), reportWrite("impl-36", { bailCause: null, bailDetail: null }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-36"), "hollow");
});

test("only the last report counts: a later null-cause report supersedes an earlier bail", () => {
  const dir = session({ "impl-37": [modelChange(), reportWrite("impl-37"), reportWrite("impl-37", { bailCause: null, bailDetail: null }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-37"), "hollow");
});

test("a last report that fails the impl schema is no report, not a bail", () => {
  const dir = session({ "impl-38": [modelChange(), reportWrite("impl-38", { bailCause: "nonsense" }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-38"), "hollow");
});

// ---------------------------------------------------------------------------
// provider, budget, abort, crash, hollow — and the readings that must NOT fire
// ---------------------------------------------------------------------------

test("a first model_change that reads resolvedModelIsFallback false does not read provider", () => {
  const dir = session({ "impl-40": [modelChange(false), turn(), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-40"), "hollow");
});

test("a model_change that falls back reads provider", () => {
  const dir = session({ "impl-41": [modelChange(false), modelChange(true), turn(), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-41"), "provider");
});

test("a last assistant turn that errored reads provider, but an earlier transient error does not", () => {
  const dir = session({ "impl-42": [modelChange(), turn({ stopReason: "error" }), turn(), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-42"), "hollow");
  const broke = session({ "impl-43": [modelChange(), turn(), turn({ stopReason: "error" }), exitEvt()] });
  assert.equal(endingOfMember(broke, "impl-43"), "provider");
});

test("a user message beginning [budget notice] reads budget", () => {
  const dir = session({ "impl-44": [modelChange(), turn(), userMsg("[budget notice] You have used 200 requests"), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-44"), "budget");
});

test("a quoted [budget notice] inside a tool result does not read budget", () => {
  const dir = session({
    "impl-45": [modelChange(), turn({ stopReason: "toolUse", blocks: [call("r1", "read", { path: "/x" })] }),
      result("r1", "[budget notice] You have used 200 requests"), turn(), exitEvt()],
  });
  assert.equal(endingOfMember(dir, "impl-45"), "hollow");
});

test("a last assistant turn aborted reads abort", () => {
  const dir = session({ "impl-46": [modelChange(), turn({ stopReason: "aborted" }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-46"), "abort");
});

test("no session_exit and no yield sidecar reads crash; the sidecar alone makes it hollow", () => {
  const lines = [modelChange(), turn()];
  assert.equal(endingOfMember(session({ "impl-47": lines }), "impl-47"), "crash");
  assert.equal(endingOfMember(session({ "impl-48": lines }, ["impl-48"]), "impl-48"), "hollow");
});

test("a transcript with a malformed non-last line reads unknown, never a guessed ending", () => {
  const dir = session({ "impl-49": [modelChange(), "{not json", turn(), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-49"), "unknown");
});

// ---------------------------------------------------------------------------
// pr from the join over the session's own records
// ---------------------------------------------------------------------------

test("a report naming a PR an earlier same-ticket implementer opened reads pr, and the pr column stays blank", () => {
  const opener = finished([
    turn({ stopReason: "toolUse", blocks: [call("g2", "bash", { command: "gh pr create --title y" })] }),
    result("g2", "https://github.com/chris/fleet-plugin/pull/5151"),
  ]);
  const continuer = [modelChange(false, T1), reportWrite("impl-50-b", { outcome: "pr", pr: 5151, bailCause: null, bailDetail: null }), exitEvt()];
  const dir = session({ "impl-50": opener, "impl-50-b": continuer });
  const rows = Object.fromEntries(rowsForSession(dir, {}, { verifyMain: () => 0 }).map((r) => [r.member, r]));
  assert.equal(rows["impl-50-b"].ending, "pr");
  assert.equal(rows["impl-50-b"].pr, "");
});

// ---------------------------------------------------------------------------
// Pure helper: no signals means no transcript, and no guess beyond the row
// ---------------------------------------------------------------------------

test("an implementer row with no transcript reads unknown, or pr when its pr is named", () => {
  assert.equal(endingOf({ member: "impl-60", pr: "", signals: null }), "unknown");
  assert.equal(endingOf({ member: "impl-60", pr: "7", signals: null }), "pr");
  assert.equal(endingOf({ member: "review-pr-1", pr: "", signals: null }), "");
});

test("a member whose name is an implementer name in a nested directory is classified by its leaf", () => {
  assert.equal(endingOf({ member: "Parent/impl-61-c", pr: "", signals: null }), "unknown");
});
