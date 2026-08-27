import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeModel, parseMemberName, readMember, rowsForSession, COLUMNS, mergeRows, formatTsv, parseTsv } from "./member-outcomes.mjs";

test("a versioned model id is kept verbatim", () => {
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("the [1m] context variant is stripped — it is the same model", () => {
  // impl-580.meta.json records "claude-opus-5[1m]" while its own messages say
  // "claude-opus-5". Two spellings of one model would split every count.
  assert.equal(normalizeModel("claude-opus-5[1m]"), "claude-opus-5");
});

test("a bare alias stays bare — it cannot be resolved to a version", () => {
  // Guessing a version here would invent data. `opus` is honestly less precise
  // than `claude-opus-5`, and a read-out can group on the family prefix.
  assert.equal(normalizeModel("opus"), "opus");
  assert.equal(normalizeModel("sonnet"), "sonnet");
});

test("<synthetic> is dropped, not mapped — it is not a model", () => {
  assert.equal(normalizeModel("<synthetic>"), null);
});

test("empty and absent are dropped", () => {
  assert.equal(normalizeModel(""), null);
  assert.equal(normalizeModel(undefined), null);
});

test("impl-<n> names a TICKET, not a PR", () => {
  assert.deepEqual(parseMemberName("impl-580"), { ticket: "580", pr: "" });
});

test("every pr-shaped member name yields a PR and no ticket", () => {
  assert.deepEqual(parseMemberName("fix-pr-662"), { ticket: "", pr: "662" });
  assert.deepEqual(parseMemberName("review-pr-555"), { ticket: "", pr: "555" });
  assert.deepEqual(parseMemberName("finisher-pr-904"), { ticket: "", pr: "904" });
  assert.deepEqual(parseMemberName("finish-pr-601"), { ticket: "", pr: "601" });
  assert.deepEqual(parseMemberName("finisher-532"), { ticket: "", pr: "532" });
  assert.deepEqual(parseMemberName("finish-567"), { ticket: "", pr: "567" });
});

test("merge-bot's number is a WAVE, so it is neither ticket nor pr", () => {
  // merge-bot-12 is the twelfth wave, not PR 12. Booking it as a pr would join
  // this row to an unrelated PR's verdict row.
  assert.deepEqual(parseMemberName("merge-bot-12"), { ticket: "", pr: "" });
});

test("a retry suffix does not change what the name identifies", () => {
  // run-team spawns `impl-<N>-b` when a member is re-dispatched.
  assert.deepEqual(parseMemberName("impl-580-b"), { ticket: "580", pr: "" });
  assert.deepEqual(parseMemberName("finisher-pr-903-c"), { ticket: "", pr: "903" });
});

test("an unrecognised name yields blanks, never a guess", () => {
  assert.deepEqual(parseMemberName("size candidate 7"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName(""), { ticket: "", pr: "" });
});

const line = (o) => JSON.stringify(o);
const assistant = (model, effort, usage = {}) => line({
  type: "assistant", isSidechain: true, effort,
  timestamp: "2026-08-25T07:14:12.147Z",
  message: { model, usage: { cache_creation_input_tokens: 0, output_tokens: 0, ...usage } },
});
const meta = (o = {}) => ({ agentType: "impl-580", description: "Implement ticket 580", name: "impl-580", spawnDepth: 0, ...o });

test("model and effort come off the transcript, not the meta", () => {
  // meta.json never records effort, and records model only when the dispatch
  // supplied one — a frontmatter-resolved member has no `model` key at all.
  // The transcript is the only source that answers both.
  const row = readMember([
    assistant("claude-opus-5", "xhigh"),
    assistant("claude-opus-5", "xhigh"),
  ].join("\n"), meta());
  assert.equal(row.model, "claude-opus-5");
  assert.equal(row.effort, "xhigh");
  assert.equal(row.errored, "no");
});

test("usage sums across turns", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 100, output_tokens: 7 }),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 250, output_tokens: 3 }),
  ].join("\n"), meta());
  assert.equal(row.tokensCacheCreate, 350);
  assert.equal(row.tokensOut, 10);
  assert.equal(row.turns, 2);
});

test("a torn final line is skipped, not fatal", () => {
  // A transcript can be read while it is still being written.
  const row = readMember(
    assistant("claude-opus-5", "xhigh", { output_tokens: 5 }) + '\n{"type":"assis',
    meta(),
  );
  assert.equal(row.tokensOut, 5);
  assert.equal(row.turns, 1);
});

test("errored keys on the LAST line being torn, not on how many turns there were", () => {
  // Distinct timestamps on purpose: the replaced rule keyed on
  // firstTs === lastTs and would answer "no" to BOTH cases here, so this is
  // the assertion that actually discriminates the two rules.
  const at = (ts) => line({
    type: "assistant", isSidechain: true, effort: "xhigh", timestamp: ts,
    message: { model: "claude-opus-5", usage: { cache_creation_input_tokens: 0, output_tokens: 0 } },
  });

  const endsTorn = readMember(
    [at("2026-08-25T07:14:12.147Z"), at("2026-08-25T07:15:00.000Z"), '{"type":"assis'].join("\n"),
    meta(),
  );
  assert.equal(endsTorn.errored, "yes");

  // A torn line in the MIDDLE is a hiccup, not a stall: the next good line
  // resets it.
  const recovers = readMember(
    [at("2026-08-25T07:14:12.147Z"), '{"type":"assis', at("2026-08-25T07:15:00.000Z")].join("\n"),
    meta(),
  );
  assert.equal(recovers.errored, "no");
});

test("a member with no effort field records blank, not a default", () => {
  // haiku carries no effort control at all. Defaulting to the session's value
  // would assert something never measured.
  const row = readMember(assistant("claude-haiku-4-5-20251001", undefined), meta());
  assert.equal(row.effort, "");
});

test("a transcript whose only model is <synthetic> yields no row", () => {
  assert.equal(readMember(assistant("<synthetic>", "xhigh"), meta()), null);
});

test("mixed models record the LAST — a mid-run switch is the tier it finished at", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh"),
    assistant("claude-sonnet-5", "xhigh"),
  ].join("\n"), meta());
  assert.equal(row.model, "claude-sonnet-5");
});

function fixture(members) {
  const root = mkdtempSync(join(tmpdir(), "mo-"));
  const dir = join(root, "sess-abc", "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [name, jsonl, meta] of members) {
    writeFileSync(join(dir, `agent-a${name}.jsonl`), jsonl);
    writeFileSync(join(dir, `agent-a${name}.meta.json`), JSON.stringify(meta));
    utimesSync(join(dir, `agent-a${name}.jsonl`), new Date("2026-08-25T09:00:00Z"), new Date("2026-08-25T09:00:00Z"));
  }
  return join(root, "sess-abc");
}

test("one row per member, stamped with the session and its run date", () => {
  const dir = fixture([
    ["impl-580", assistant("claude-opus-5", "xhigh"), meta()],
    ["merge-bot-12", assistant("claude-opus-5", "xhigh"), meta({ agentType: "merge-bot-12", name: "merge-bot-12", description: "merge bot wave 12" })],
  ]);
  const rows = rowsForSession(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].session, "sess-abc");
  assert.equal(rows[0].run_date, "2026-08-25");
});

test("a member with no .jsonl is skipped without losing its siblings", () => {
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  mkdirSync(join(dir, "subagents"), { recursive: true });
  writeFileSync(join(dir, "subagents", "agent-aorphan.meta.json"), JSON.stringify(meta()));
  assert.equal(rowsForSession(dir).length, 1);
});

test("an unparseable meta does not take the whole session down", () => {
  // board.mjs skips a bad transcript rather than blacking out the panel; same
  // rule here, for the same reason.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  writeFileSync(join(dir, "subagents", "agent-abad.jsonl"), assistant("claude-opus-5", "xhigh"));
  writeFileSync(join(dir, "subagents", "agent-abad.meta.json"), "{not json");
  assert.equal(rowsForSession(dir).length, 1);
});

test("a session directory with no subagents dir yields no rows and does not throw", () => {
  const root = mkdtempSync(join(tmpdir(), "mo-"));
  assert.deepEqual(rowsForSession(root), []);
});

test("a member that yields no row still dates the session, and its siblings survive", () => {
  // A <synthetic>-only member is dropped, but it DID write a transcript: its
  // mtime is part of when this session ran. Sampling mtime only for surviving
  // members would date the session from the older sibling.
  const dir = fixture([
    ["impl-580", assistant("claude-opus-5", "xhigh"), meta()],
    ["impl-581", assistant("<synthetic>", "xhigh"), meta({ agentType: "impl-581", name: "impl-581" })],
  ]);
  const newer = join(dir, "subagents", "agent-aimpl-581.jsonl");
  utimesSync(newer, new Date("2026-08-26T09:00:00Z"), new Date("2026-08-26T09:00:00Z"));

  const rows = rowsForSession(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member, "impl-580");
  assert.equal(rows[0].run_date, "2026-08-26");
});

const row = (o = {}) => ({
  session: "s1", run_date: "2026-08-25", role: "implementer", member: "impl-580",
  model: "claude-opus-5", effort: "xhigh", ticket: "580", pr: "",
  tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, errored: "no",
  // Default agent tracks the default/overridden member, so fixtures that vary
  // only `member` still get distinct transcript ids, and fixtures that share
  // the default member (untouched) still key as the SAME agent.
  agent: `agent-a${o.member ?? "impl-580"}`, ...o,
});

test("re-scraping a session REPLACES its rows rather than appending duplicates", () => {
  const merged = mergeRows([row({ model: "opus" })], [row({ model: "claude-opus-5" })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].model, "claude-opus-5");
});

test("re-scraping one session leaves every other session untouched", () => {
  // The failure this guards: a backfill loop that rewrites the file per session
  // and drops the previous session each time.
  const merged = mergeRows(
    [row({ session: "s0", member: "impl-1" }), row({ session: "s1", member: "impl-580" })],
    [row({ session: "s1", member: "impl-580", turns: 9 })],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.session === "s0").member, "impl-1");
  assert.equal(merged.find((r) => r.session === "s1").turns, 9);
});

test("output order is stable, so a regeneration produces no spurious diff", () => {
  const a = formatTsv(mergeRows([], [row({ member: "impl-9" }), row({ member: "impl-1" })]));
  const b = formatTsv(mergeRows([], [row({ member: "impl-1" }), row({ member: "impl-9" })]));
  assert.equal(a, b);
});

test("a tsv round-trips", () => {
  // formatTsv does not sort (only mergeRows does), so the round-trip preserves
  // input order. Ordering itself is pinned by the "output order is stable" test.
  const rows = [row(), row({ session: "s2", member: "fix-pr-662", role: "reviewer", ticket: "", pr: "662" })];
  assert.deepEqual(parseTsv(formatTsv(rows)).map((r) => r.member), ["impl-580", "fix-pr-662"]);
});

test("a blank field round-trips as blank, never as zero", () => {
  // Blank means UNKNOWN. Reading it back as 0 would make an unmeasured member
  // look like a free one.
  const parsed = parseTsv(formatTsv([row({ effort: "" })]));
  assert.equal(parsed[0].effort, "");
});

test("two UNNAMED members of one session are two rows, not one", () => {
  // meta.name is absent for an unnamed dispatch, so `member` falls back to
  // agentType and every unnamed agent in a session shares it. Keying on the
  // member name collapsed 1,202 of 2,694 real members into their siblings.
  const a = row({ agent: "agent-aaaa", member: "general-purpose" });
  const b = row({ agent: "agent-bbbb", member: "general-purpose" });
  const merged = mergeRows([], [a, b]);
  assert.equal(merged.length, 2);
});

const CLI = new URL("./member-outcomes.mjs", import.meta.url).pathname;

test("no session dir is a refusal, not a silent no-op", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /member-outcomes/);
  assert.equal(r.stdout, "");
});

test("the subagents/ dir and its parent session dir scrape the same rows", () => {
  // findSubagentsDir() (board.mjs) returns the subagents dir; a human types
  // the session dir. Both spellings must reach the same rows.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const outSession = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const outSubagents = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const bySession = spawnSync(process.execPath, [CLI, dir, "--file", outSession], { encoding: "utf8" });
  const bySubagents = spawnSync(process.execPath, [CLI, join(dir, "subagents"), "--file", outSubagents], { encoding: "utf8" });
  assert.equal(bySession.status, 0);
  assert.equal(bySubagents.status, 0);
  assert.equal(readFileSync(outSession, "utf8"), readFileSync(outSubagents, "utf8"));
});

test("a directory with no subagents/ under it is a refusal, not a silent no-op", () => {
  // A wrong guess used to exit 0 having written nothing, because
  // rowsForSession() catches the readdir failure and returns [].
  const empty = mkdtempSync(join(tmpdir(), "mo-empty-"));
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const r = spawnSync(process.execPath, [CLI, empty, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /subagents/);
  assert.equal(existsSync(out), false);
});

test("--file=<path> is refused, not silently ignored", () => {
  // --file wants a SPACE-separated value, not `=`. Without a check, this never
  // sets fileIdx, so it silently writes the PRODUCTION metrics file instead of
  // the path the operator asked for.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const r = spawnSync(process.execPath, [CLI, dir, "--file=/tmp/x.tsv"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--file/);
});

test("an unrecognised flag is refused, not silently dropped", () => {
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const r = spawnSync(process.execPath, [CLI, dir, "--wat"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--wat/);
});

test("a run writes rows, and a second run over the same session changes nothing", () => {
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const run = () => spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const first = readFileSync(out, "utf8");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(out, "utf8"), first);
});

test("the header survives a rewrite", () => {
  // The header carries the read-out commands and the blank-means-unknown rule.
  // A rewrite that drops it strands every reader.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  writeFileSync(out, "# keep me\n");
  spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.match(readFileSync(out, "utf8"), /^# keep me$/m);
});

test("importing the module never runs the CLI, even from a file whose name ends with its own", () => {
  // The guard used to be a suffix match, so a wrapper called
  // run-member-outcomes.mjs tripped the CLI block on import: it wrote a file
  // and exited 2 in a process that only wanted the helpers.
  const dir = mkdtempSync(join(tmpdir(), "mo-wrap-"));
  const wrapper = join(dir, "run-member-outcomes.mjs");
  writeFileSync(wrapper, `import { normalizeModel } from ${JSON.stringify(CLI)};\n`
    + `console.log(normalizeModel("claude-opus-5"));\n`);
  const r = spawnSync(process.execPath, [wrapper], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "claude-opus-5");
  assert.equal(r.stderr, "");
});

test("the documented bare form works — no --file needed", () => {
  // `member-outcomes.mjs <session-dir>` is the form the spec, the backfill loop
  // and run-team's phase-3 instruction all use. It exited 2 for every input
  // until the filter stopped treating `fileIdx + 1` as a real index when
  // --file is absent.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const cwd = mkdtempSync(join(tmpdir(), "mo-cwd-"));
  mkdirSync(join(cwd, "docs", "metrics"), { recursive: true });
  const r = spawnSync(process.execPath, [CLI, dir], { encoding: "utf8", cwd });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /wrote 1 rows to/);
  const written = readFileSync(join(cwd, "docs", "metrics", "member-outcomes.tsv"), "utf8");
  assert.match(written, /impl-580/);
});
