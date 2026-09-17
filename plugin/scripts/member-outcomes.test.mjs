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

test("a -v<n> re-dispatch suffix is stripped the same way as a retry letter", () => {
  // #1482: a controller re-dispatches a finisher/reviewer against a PR whose
  // head moved after label as `<name>-v2`, `<name>-v10`, etc. Left unstripped
  // this fell through to a blank pr column, orphaning the token row from the
  // PR's outcome.
  assert.deepEqual(parseMemberName("finisher-pr-1475-v2"), { ticket: "", pr: "1475" });
  // Two-digit suffixes are the same spelling, not a special case: -v10 is
  // the tenth re-dispatch, not a different pattern than -v2.
  assert.deepEqual(parseMemberName("finisher-pr-1475-v10"), { ticket: "", pr: "1475" });
  // The existing single-letter retry suffix keeps working unchanged.
  assert.deepEqual(parseMemberName("finisher-pr-1475-b"), { ticket: "", pr: "1475" });
  // The numeric-only suffix (a genuine second-ticket batch, not a retry) is
  // still deliberately NOT stripped for a TICKET-shaped name.
  assert.deepEqual(parseMemberName("impl-137-2"), { ticket: "", pr: "" });
});

test("a bare numeric re-dispatch suffix is stripped for PR-shaped names only (#1482)", () => {
  // The commoner numeric re-dispatch spelling (no `-v`, no letter) also falls
  // through the old regex: `finisher-pr-1440-2`, `fix-pr-1281-2`. A
  // PR-shaped name carries exactly one number, the PR itself, so a second
  // trailing `-\d+` cannot be a second ticket the way `impl-<ticket>-<n>`'s
  // can — measured across docs/metrics/member-outcomes.tsv: 476,202
  // cache-create tokens across 7 real rows fell through to a blank pr column
  // this way, more than the 37,580 the -v<n> fix above addressed.
  assert.deepEqual(parseMemberName("finisher-pr-1440-2"), { ticket: "", pr: "1440" });
  assert.deepEqual(parseMemberName("finisher-pr-1321-3"), { ticket: "", pr: "1321" });
  assert.deepEqual(parseMemberName("fix-pr-1281-2"), { ticket: "", pr: "1281" });
  // The ticket-shaped impl-<ticket>-<n> family is untouched: its
  // second-ticket ambiguity is real, and a PR-shaped name's is not.
  assert.deepEqual(parseMemberName("impl-753-2"), { ticket: "", pr: "" });
});

test("an unrecognised name yields blanks, never a guess", () => {
  assert.deepEqual(parseMemberName("size candidate 7"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName(""), { ticket: "", pr: "" });
});

const line = (o) => JSON.stringify(o);
// `id` is the API turn id. Real transcripts carry one on EVERY assistant line
// (measured: 0 of 127,102 without), and several lines of one turn repeat it —
// which is why the fixtures below must be able to set it. Omitting it here
// leaves each line its own turn, the shape every pre-existing fixture assumes.
const assistant = (model, effort, usage = {}, id) => line({
  type: "assistant", isSidechain: true, effort,
  timestamp: "2026-08-25T07:14:12.147Z",
  message: { ...(id ? { id } : {}), model, usage: { cache_creation_input_tokens: 0, output_tokens: 0, ...usage } },
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
  assert.equal(row.torn, false);
});

test("usage sums across turns — lines with distinct ids are distinct turns", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 100, output_tokens: 7 }, "msg_1"),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 250, output_tokens: 3 }, "msg_2"),
  ].join("\n"), meta());
  assert.equal(row.tokensCacheCreate, 350);
  assert.equal(row.tokensOut, 10);
  assert.equal(row.turns, 2);
});

test("usage is billed ONCE per message.id — one turn is many jsonl lines", () => {
  // THE defect this pins: one assistant API turn is written as several lines,
  // one per content block, and every one repeats the same message.id AND the
  // same usage object. Summing per LINE overcounted cache_creation by 176% and
  // `turns` by 141% across all 2,723 real transcripts, and the overcount is
  // MODEL-DEPENDENT (opus-5 2.81x, sonnet-5 2.39x) because blocks-per-turn
  // tracks how tool-heavy a turn is. That tilts the cost comparison this file
  // exists to support, so it is not a rescale.
  //
  // Mutation this must survive: reverting to `cache += ...; turns++` per line.
  // That reads 900 / 3 here instead of 300 / 1.
  const blocks = [
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 300, output_tokens: 5 }, "msg_same"),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 300, output_tokens: 40 }, "msg_same"),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 300, output_tokens: 12 }, "msg_same"),
  ];
  const row = readMember(blocks.join("\n"), meta());
  assert.equal(row.tokensCacheCreate, 300, "cache_creation is billed once per turn, not once per block");
  assert.equal(row.turns, 1, "three content blocks are ONE turn");
  // output_tokens is a streaming snapshot, so the LARGEST value is the final
  // one. Summing would read 57.
  assert.equal(row.tokensOut, 40, "output_tokens takes the max across the turn's lines, not the sum");
});

test("a line with no message.id is its own turn — the honest reading of nothing to fold on", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 100, output_tokens: 7 }),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 100, output_tokens: 7 }),
  ].join("\n"), meta());
  assert.equal(row.turns, 2);
  assert.equal(row.tokensCacheCreate, 200);
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

test("torn keys on the LAST line, and is NOT a column", () => {
  // `torn` says the file was read while the member was still writing to it. It
  // is a property of WHEN the scraper ran, not of the member — re-scraping the
  // same finished transcript flips it back — so it rides on the row for
  // rowsForSession() to count and reaches stderr, never the schema. The old
  // `errored` column read "no" on all 2,702 rows, including all 34 transcripts
  // carrying a real terminal API failure, and needed four header lines to stop
  // readers taking it for a reliability signal.
  assert.equal(COLUMNS.includes("errored"), false, "torn-ness is a scrape artifact, not a member fact");

  const at = (ts) => line({
    type: "assistant", isSidechain: true, effort: "xhigh", timestamp: ts,
    message: { id: `msg_${ts}`, model: "claude-opus-5", usage: { cache_creation_input_tokens: 0, output_tokens: 0 } },
  });

  const endsTorn = readMember(
    [at("2026-08-25T07:14:12.147Z"), at("2026-08-25T07:15:00.000Z"), '{"type":"assis'].join("\n"),
    meta(),
  );
  assert.equal(endsTorn.torn, true);

  // A torn line in the MIDDLE is a hiccup, not a stall: the next good line
  // resets it.
  const recovers = readMember(
    [at("2026-08-25T07:14:12.147Z"), '{"type":"assis', at("2026-08-25T07:15:00.000Z")].join("\n"),
    meta(),
  );
  assert.equal(recovers.torn, false);
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

test("a Workflow's nested fan-out is scraped too, keyed on its path-relative stem", () => {
  // Transcripts live at TWO depths. A one-level readdir saw 2,723 files and
  // missed 2,894 under subagents/workflows/wf_<id>/ across 37 sessions — 52% of
  // the corpus, and specifically `workflows/review-pr.js`'s specialists, which
  // is the population where the dispatched agent (and therefore its resolved
  // model) is DELIBERATELY varied per dimension — six distinct
  // `fleet-review-*` names since #1349, each carrying its own frontmatter
  // tier (previously three of six carried a per-call `model: "sonnet"`,
  // before that knob was removed). No fixture had a nested directory, so
  // 1,223 tests passed over a scraper that saw half the disk.
  //
  // Mutation this must survive: dropping `{ recursive: true }`. That reads 1.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const wf = join(dir, "subagents", "workflows", "wf_abc123");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "agent-anested.jsonl"), assistant("claude-sonnet-5", "xhigh"));
  writeFileSync(join(wf, "agent-anested.meta.json"),
    JSON.stringify({ agentType: "fleet-ctl:fleet-review-correctness", description: "Review PR 943", spawnDepth: 1 }));

  const rows = rowsForSession(dir);
  assert.equal(rows.length, 2);
  const nested = rows.find((r) => r.model === "claude-sonnet-5");
  assert.ok(nested, "the nested transcript produced a row");
  // The stem carries the path, which is what keeps `agent` unique across the
  // two depths — and what let this widening REPLACE existing rows rather than
  // duplicate them, since a FLAT stem is unchanged by recursing.
  assert.equal(nested.agent, "workflows/wf_abc123/agent-anested");
  assert.equal(rows.find((r) => r.model === "claude-opus-5").agent, "agent-aimpl-580");
});

test("role comes from classifyRole and is not invented here", () => {
  // `role` had no assertion anywhere: it is the GROUPING column of the header's
  // pair query, so a classifyRole regression moved every bucket in the read-out
  // while the suite stayed green.
  const dir = fixture([
    ["impl-580", assistant("claude-opus-5", "xhigh"), meta()],
    ["mb", assistant("claude-opus-5", "xhigh"),
      meta({ agentType: "merge-bot-3", name: "merge-bot-3", description: "merge wave 3" })],
    ["spec", assistant("claude-opus-5", "xhigh"),
      meta({ agentType: "general-purpose", name: undefined, description: "Review PR 943 correctness", spawnDepth: 1 })],
  ]);
  const byMember = Object.fromEntries(rowsForSession(dir).map((r) => [r.member, r.role]));
  assert.equal(byMember["impl-580"], "implementer");
  assert.equal(byMember["merge-bot-3"], "merge-bot");
  // spawnDepth >= 1 is a reviewer's fan-out, not the member's own name.
  assert.equal(byMember["general-purpose"], "specialist");
});

test("`subagent_type` is what the DISPATCH named, and blank when it named nothing", () => {
  // The whole of #1066: a deliberate alternate-tier pair is identifiable only
  // from the dispatch record, and the sidecar carrying it is already open when
  // the row is built — so the column is derived, survives a regeneration, and
  // mislabels no historical row.
  //
  // Mutation this must survive: reading `meta.agentType` instead. That is the
  // member's own NAME for a named dispatch (`impl-582`), so every row would
  // carry a value, the untyped category would vanish, and `impl-582` would
  // read as an agent definition that does not exist.
  const dir = fixture([
    ["impl-580", assistant("claude-opus-5", "xhigh"), meta({ customAgentType: "fleet-implementer" })],
    ["impl-581", assistant("claude-sonnet-5", "xhigh"),
      meta({ agentType: "impl-581", name: "impl-581", customAgentType: "fleet-implementer-alt" })],
    ["impl-582", assistant("claude-opus-5", "xhigh"), meta({ agentType: "impl-582", name: "impl-582" })],
  ]);
  assert.deepEqual(
    Object.fromEntries(rowsForSession(dir).map((r) => [r.member, r.subagentType])),
    { "impl-580": "fleet-implementer", "impl-581": "fleet-implementer-alt", "impl-582": "" },
  );
});

test("a row whose cell count is wrong is REFUSED, never padded", () => {
  // Padding put "" in the LAST column — `agent` when this was written,
  // `subagent_type` now — a key rowsForSession can never produce, so mergeRows
  // could never replace it. Three measured routes there, all exit 0: a torn
  // last line became a permanent phantom that re-scraping could not heal, git
  // conflict markers became three data rows, and adding one column ahead of
  // `agent` collapsed 2,702 rows to 156.
  //
  // The 14-field spelling is the PREVIOUS schema, still on every branch cut
  // before #1066: it must be refused rather than padded with a blank
  // `subagent_type`, which would read as "this member was dispatched untyped"
  // for rows that were nothing of the kind. Regenerating is the migration.
  //
  // Mutation this must survive: restoring `cells[i] ?? ""`.
  const short = ["s1", "2026-08-25", "memory"].join("\t");
  assert.throws(() => parseTsv(short), /malformed row: 3 fields, expected 15/);
  assert.throws(() => parseTsv("<<<<<<< HEAD"), /malformed row/);
  assert.throws(() => parseTsv(formatTsv([row()]).trim().split("\t").slice(0, 14).join("\t")), /14 fields, expected 15/);
  // A long row is refused too — that is the schema-drift direction.
  assert.throws(() => parseTsv(formatTsv([row()]).trim() + "\textra"), /16 fields/);
});

const row = (o = {}) => ({
  session: "s1", run_date: "2026-08-25", role: "implementer", member: "impl-580",
  model: "claude-opus-5", effort: "xhigh", ticket: "580", pr: "",
  tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1,
  // Default agent tracks the default/overridden member, so fixtures that vary
  // only `member` still get distinct transcript ids, and fixtures that share
  // the default member (untouched) still key as the SAME agent.
  agent: `agent-a${o.member ?? "impl-580"}`, harness: "claude",
  subagentType: "fleet-implementer", ...o,
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

test("#1342: a Claude run and an omp run over separate sessions merge into one TSV carrying both harness values", () => {
  const claudeDir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);

  const ompRoot = mkdtempSync(join(tmpdir(), "mo-omp-"));
  const ompSessionName = "2026-09-09T03-00-00-000Z_deadbeef-dead-dead-dead-deadbeefdead";
  const ompSessionDir = join(ompRoot, ompSessionName);
  mkdirSync(ompSessionDir, { recursive: true });
  const ompLine = (o) => JSON.stringify(o);
  writeFileSync(join(ompSessionDir, "Solo.jsonl"), [
    ompLine({ type: "session", version: 3, id: "s1", timestamp: "2026-09-09T03:00:00.000Z", cwd: "/Users/chris/dev/fleet-plugin" }),
    ompLine({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-09T03:00:01.000Z", thinkingLevel: "high", configured: null }),
    // omp's spelling of the dispatch record. Without it this side of the
    // corpus reaches #1066's pair query blank, so an omp-era pair is
    // uncountable however deliberately it was dispatched.
    ompLine({ type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-09T03:00:01.500Z", task: "Implement ticket 580", agent: "fleet-implementer-alt" }),
    ompLine({
      type: "message", id: "m1", parentId: "t1", timestamp: "2026-09-09T03:00:02.000Z",
      message: {
        role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-sonnet-5",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } },
      },
    }),
  ].join("\n") + "\n");

  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const runClaude = spawnSync(process.execPath, [CLI, claudeDir, "--file", out], { encoding: "utf8" });
  assert.equal(runClaude.status, 0, runClaude.stderr);
  const runOmp = spawnSync(process.execPath, [CLI, ompSessionDir, "--file", out], { encoding: "utf8" });
  assert.equal(runOmp.status, 0, runOmp.stderr);

  const rows = parseTsv(readFileSync(out, "utf8"));
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.harness)), new Set(["claude", "omp"]));
  const omp = rows.find((r) => r.harness === "omp");
  assert.equal(omp.session, ompSessionName);
  assert.equal(omp.agent, "Solo");
  // #1066: the deliberate-pair column travels the omp path too, out of
  // `session_init.agent`. It reaches the FILE, not just the record — the
  // adapter in rowsForOmpSession is a separate hop from the Claude one and
  // dropping it leaves every omp row blank while the suite stays green.
  assert.equal(omp.subagentType, "fleet-implementer-alt");
  assert.equal(rows.find((r) => r.harness === "claude").subagentType, "");
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
  assert.match(r.stderr, /scraped 1 of 1 members \(0 dropped\)/);
  const written = readFileSync(join(cwd, "docs", "metrics", "member-outcomes.tsv"), "utf8");
  assert.match(written, /impl-580/);
});

test("the run reports its own YIELD, not just the file's size", () => {
  // `wrote N rows` printed merged.length — the whole corpus — so a session where
  // every member dropped printed the same reassuring line as a healthy one.
  // Measured: a real 2-member session whose metas were missing wrote
  // "wrote 2702 rows", exit 0, byte-identical to full success.
  //
  // Mutation this must survive: printing merged.length alone.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  // A sibling transcript with no meta.json — the real drop shape: 6 such files
  // are on disk, one of them 58 KB of opus-5 work carrying a pr=647 join key.
  writeFileSync(join(dir, "subagents", "agent-aorphan.jsonl"), assistant("claude-opus-5", "xhigh"));
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  writeFileSync(out, formatTsv([row({ session: "other", member: "impl-1" })]));

  const r = spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /scraped 1 of 2 members \(1 dropped\)/);
  // The file total is still reported, and is deliberately a DIFFERENT number
  // from the yield — that difference is the whole point.
  assert.match(r.stderr, /holds 2 rows/);
});

test("an unreadable subagents/ is a refusal, not a silent no-op", () => {
  // The old existsSync guard closed only the ENOENT half. A regular FILE named
  // `subagents` (ENOTDIR) walked past it into rowsForSession's catch, which
  // returned [], and the run exited 0 having written nothing.
  //
  // Mutation this must survive: `existsSync(join(sessionDir, "subagents"))`.
  const root = mkdtempSync(join(tmpdir(), "mo-notdir-"));
  writeFileSync(join(root, "subagents"), "");
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const r = spawnSync(process.execPath, [CLI, root, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ENOTDIR/);
  assert.equal(existsSync(out), false);
});

test("a corpus this schema cannot read is refused before anything is rewritten", () => {
  // Reading an out-of-schema file used to pad it and rewrite it, converting a
  // human's unresolved merge conflict into confident-looking data.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const conflicted = "# hdr\n<<<<<<< HEAD\n" + formatTsv([row()]) + "=======\n>>>>>>> theirs\n";
  writeFileSync(out, conflicted);
  const r = spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /malformed row/);
  assert.equal(readFileSync(out, "utf8"), conflicted, "the file is left exactly as found");
});

test("the header's blank lines and paragraph order survive a rewrite", () => {
  // Collecting every `#` line from anywhere hoisted a below-data note to the
  // top and dropped the blank separators, silently, while the comment promised
  // "preserved verbatim".
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const header = "# first paragraph\n\n# second paragraph\n";
  writeFileSync(out, header);
  spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(readFileSync(out, "utf8").startsWith(header), true);
});
