import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tempDir } from "./support/temp-dir.mjs";
import { join, dirname } from "node:path";
import { rowsForSession, endingOf, mergeRows, COLUMNS } from "../plugin/scripts/member-outcomes.mjs";

// ---------------------------------------------------------------------------
// Fixtures shaped like real omp transcripts: the lines the ending reads.
// ---------------------------------------------------------------------------

const SESSION = "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890";
const T0 = "2026-08-25T09:00:00.000Z";
const T1 = "2026-08-25T10:00:00.000Z";
const REPORTS = "/scratch/reports";
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

test("`ending` follows the four priced columns, and `dispatch_model` follows it", () => {
  assert.deepEqual(COLUMNS.slice(-3), ["cost", "ending", "dispatch_model"]);
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

test("an implementer that opened two PRs reads pr, though its pr column stays blank", () => {
  const dir = session({
    "impl-21": finished([
      turn({ stopReason: "toolUse", blocks: [call("g1", "bash", { command: "gh pr create --title x" })] }),
      result("g1", "https://github.com/chris/fleet-plugin/pull/4243"),
      turn({ stopReason: "toolUse", blocks: [call("g2", "bash", { command: "gh pr create --title probe" })] }),
      result("g2", "https://github.com/chris/fleet-plugin/pull/4244"),
    ]),
  });
  const row = rowsForSession(dir, {}, { verifyMain: () => 0 }).find((r) => r.member === "impl-21");
  assert.equal(row.pr, "");
  assert.equal(row.ending, "pr");
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

// A bash command that writes the member's undecided-bail report in a shape
// the first scanner could not see.
const bashReport = (member, command) => session({
  [member]: [modelChange(), turn({ stopReason: "toolUse", blocks: [call("b1", "bash", { command })] }), exitEvt()],
});

test("a report written through a variable, tee, <<- or a wrapper reads bail:undecided the same way", () => {
  const body = reportJson("impl-51");
  const path = `${REPORTS}/impl-51.json`;
  const cases = {
    variable: `R=${path}; mkdir -p "$(dirname "$R")"; cat > "$R" <<EOF\n${body}\nEOF`,
    tee: `tee ${path} >/dev/null <<'EOF'\n${body}\nEOF`,
    dash: `cat > ${path} <<-'EOF'\n\t${body}\n\tEOF`,
    redirectAfter: `cat <<'EOF' > ${path}\n${body}\nEOF`,
    prefixedVariable: `D=/scratch; mkdir -p $D/reports; cat > $D/reports/impl-51.json <<'EOF'\n${body}\nEOF`,
    wrapper: `timeout 5 cat > ${path} <<'EOF'\n${body}\nEOF`,
  };
  for (const [shape, command] of Object.entries(cases)) {
    assert.equal(endingOfMember(bashReport("impl-51", command), "impl-51"), "bail:undecided", shape);
  }
});

test("a heredoc whose target cannot be resolved, or never terminates, is no report", () => {
  const body = reportJson("impl-52");
  assert.equal(endingOfMember(bashReport("impl-52", `cat > $R <<EOF\n${body}\nEOF`), "impl-52"), "hollow");
  assert.equal(endingOfMember(bashReport("impl-52", `cat > ${REPORTS}/impl-52.json <<EOF\n${body}`), "impl-52"), "hollow");
});

test("a json written outside a reports/ directory is not a report, by the write tool or a heredoc", () => {
  const write = turn({ stopReason: "toolUse", blocks: [call("w1", "write", { path: "/tmp/impl-39.json", content: reportJson("impl-39") })] });
  const heredoc = turn({ stopReason: "toolUse", blocks: [call("b1", "bash", { command: `cat > /tmp/impl-39.json <<'EOF'\n${reportJson("impl-39")}\nEOF` })] });
  assert.equal(endingOfMember(session({ "impl-39": [modelChange(), write, exitEvt()] }), "impl-39"), "hollow");
  assert.equal(endingOfMember(session({ "impl-39": [modelChange(), heredoc, exitEvt()] }), "impl-39"), "hollow");
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

test("a fixed bail whose detail opens with whitespace still names its sha", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  const dir = session({ "impl-35": [modelChange(), reportWrite("impl-35", { bailCause: "fixed", bailDetail: ` ${sha} — x` }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-35"), "bail:fixed");
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

test("a last report that bails with a known cause but fails the schema elsewhere is no report", () => {
  const dir = session({ "impl-38": [modelChange(), reportWrite("impl-38", { branch: undefined }), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-38"), "hollow");
});

test("a last report that is not JSON, or repeats a key, is no report, not a bail", () => {
  const written = (content) => turn({ stopReason: "toolUse", blocks: [call("w1", "write", { path: `${REPORTS}/impl-38.json`, content })] });
  const garbled = session({ "impl-38": [modelChange(), reportWrite("impl-38"), written("{not json"), exitEvt()] });
  assert.equal(endingOfMember(garbled, "impl-38"), "hollow");
  const twice = reportJson("impl-38").replace(`"bailCause":"undecided"`, `"bailCause":"hands","bailCause":"undecided"`);
  assert.notEqual(twice, reportJson("impl-38"));
  assert.equal(endingOfMember(session({ "impl-38": [modelChange(), written(twice), exitEvt()] }), "impl-38"), "hollow");
});

test("a report naming another member is no report of this one", () => {
  const foreign = turn({ stopReason: "toolUse", blocks: [call("w1", "write", { path: `${REPORTS}/impl-38.json`, content: reportJson("impl-99") })] });
  const dir = session({ "impl-38": [modelChange(), foreign, exitEvt()] });
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

test("a [budget notice] after leading whitespace reads budget; one quoted mid-message does not", () => {
  const dir = session({ "impl-44": [modelChange(), turn(), userMsg("  \n[budget notice] You have used 200 requests"), exitEvt()] });
  assert.equal(endingOfMember(dir, "impl-44"), "budget");
  const quoted = session({ "impl-44": [modelChange(), turn(), userMsg("the log said [budget notice] earlier"), exitEvt()] });
  assert.equal(endingOfMember(quoted, "impl-44"), "hollow");
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

test("a custom event of another customType is not a session exit", () => {
  const other = evt({ type: "custom", customType: "ttsr_injection", timestamp: T0, data: {} });
  assert.equal(endingOfMember(session({ "impl-47": [modelChange(), turn(), other] }), "impl-47"), "crash");
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

// A member that opens PR `n`, starting at `at`; and one that starts at `at`
// and whose last report claims PR `n` as its own outcome.
const opensPr = (n, at = T0) => [modelChange(false, at),
  turn({ stopReason: "toolUse", blocks: [call("g9", "bash", { command: "gh pr create --title z" })] }),
  result("g9", `https://github.com/chris/fleet-plugin/pull/${n}`), turn(), exitEvt()];
const claimsPr = (member, n, at = T1) => [modelChange(false, at),
  reportWrite(member, { outcome: "pr", pr: n, bailCause: null, bailDetail: null }), exitEvt()];
const joined = (members, member) => endingOfMember(session(members), member);

test("a PR an implementer of another ticket opened is no predecessor's PR", () => {
  assert.equal(joined({ "impl-51": opensPr(5161), "impl-52-b": claimsPr("impl-52-b", 5161) }, "impl-52-b"), "hollow");
});

test("a PR a same-ticket member that is not an implementer opened is no predecessor's PR", () => {
  assert.equal(joined({ Impl53: opensPr(5162), "impl-53-b": claimsPr("impl-53-b", 5162) }, "impl-53-b"), "hollow");
});

test("a same-ticket implementer that started at the same moment is not an earlier one", () => {
  assert.equal(joined({ "impl-54": opensPr(5163, T1), "impl-54-b": claimsPr("impl-54-b", 5163, T1) }, "impl-54-b"), "hollow");
});

test("an implementer whose name carries no ticket joins no predecessor", () => {
  assert.equal(joined({ "impl-56-2": opensPr(5164), "impl-55-2": claimsPr("impl-55-2", 5164) }, "impl-55-2"), "hollow");
});

// ---------------------------------------------------------------------------
// A re-scrape that cannot say never overwrites what an earlier one read
// ---------------------------------------------------------------------------

const tsvRow = (o) => ({ session: SESSION, agent: "impl-70", member: "impl-70", model: "m", ending: "", ...o });

test("an incoming unknown ending keeps the recorded one, and the merge counts it", () => {
  const stats = {};
  const [row] = mergeRows([tsvRow({ ending: "bail:fixed" })], [tsvRow({ ending: "unknown", model: "n" })], stats);
  assert.equal(row.ending, "bail:fixed");
  assert.equal(row.model, "n", "every other cell is still the re-scrape's");
  assert.equal(stats.endingsKept, 1);
});

test("an incoming reading replaces the recorded ending, and unknown fills a blank one", () => {
  const stats = {};
  assert.equal(mergeRows([tsvRow({ ending: "crash" })], [tsvRow({ ending: "hollow" })], stats)[0].ending, "hollow");
  assert.equal(stats.endingsKept, 0);
  assert.equal(mergeRows([tsvRow({ ending: "" })], [tsvRow({ ending: "unknown" })])[0].ending, "unknown");
});

// The real verifier, run in a child so its cwd and PATH are the fixture's own.
function endingThroughRealVerifier(env) {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  const dir = session({ "impl-71": [modelChange(), reportWrite("impl-71", { bailCause: "fixed", bailDetail: `${sha} — x` }), exitEvt()] });
  // The verifier asks the cwd's git: run where no repository answers.
  const cwd = tempDir("moe-norepo-");
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const mod = new URL("../plugin/scripts/member-outcomes.mjs", import.meta.url).href;
  const code = `import { rowsForSession } from ${JSON.stringify(mod)};
process.stdout.write(rowsForSession(process.argv[1]).find((r) => r.member === "impl-71").ending);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, dir],
    { cwd, env: { ...base, GIT_CEILING_DIRECTORIES: dirname(cwd), ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`verify-sha\\.sh main ${sha} could not answer`));
  return r;
}

test("a verifier that cannot answer says why on stderr, and its fixed bail reads unknown", () => {
  const r = endingThroughRealVerifier({});
  assert.equal(r.stdout, "unknown");
  assert.match(r.stderr, /not a git repository/);
});

test("a verifier script that cannot even start reads unknown, and says so", () => {
  const r = endingThroughRealVerifier({ PATH: tempDir("moe-nopath-") });
  assert.equal(r.stdout, "unknown");
  assert.match(r.stderr, /ENOENT/);
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
