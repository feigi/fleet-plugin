import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tempDir } from "./temp-dir.mjs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeModel, parseMemberName, rowsForSession, COLUMNS, mergeRows, formatTsv, parseTsv } from "./member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, TIER_SWITCH_DATE } from "./tier-outcomes.mjs";

const TIER_CLI = new URL("./tier-outcomes.mjs", import.meta.url).pathname;

test("a versioned model id is kept verbatim", () => {
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("the [1m] context variant is stripped — it is the same model", () => {
  // A member's `model` can read "claude-opus-5[1m]" on one turn while another
  // turn of the same member says "claude-opus-5". Two spellings of one model
  // would split every count.
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

test("resolve-pr-<n> names a PR and no ticket (#1250)", () => {
  // `resolve-pr-<n>` is the controller's conflict/rebase-resolver dispatch
  // against an already-open PR, real recorded names, the unrecognised before
  // this fix: `resolve-pr-1232`. Unmatched, it fell through to `{ticket:"",
  // pr:""}`, losing the join key into tier-outcomes.tsv.
  assert.deepEqual(parseMemberName("resolve-pr-1232"), { ticket: "", pr: "1232" });
  // The re-dispatch suffixes (#1482) apply to this family too, every other
  // PR-shaped name, the same as `resolve-pr-1440-2`, { ticket: "", pr: "1440" }.
  assert.deepEqual(parseMemberName("resolve-pr-1440-2"), { ticket: "", pr: "1440" });
});

test("merge-bot's number is a per-run dispatch counter, never a PR, so it is neither ticket nor PR", () => {
  // merge-bot-12 is the twelfth merge bot this run dispatched, not PR 12.
  // Booking it as a pr would join this row to an unrelated PR's verdict row.
  assert.deepEqual(parseMemberName("merge-bot-12"), { ticket: "", pr: "" });
});

test("a retry suffix does not change what the name identifies", () => {
  // run-team spawns `impl-<N>-b` when a member is re-dispatched.
  assert.deepEqual(parseMemberName("impl-580-b"), { ticket: "580", pr: "" });
  assert.deepEqual(parseMemberName("finisher-903-c"), { ticket: "", pr: "903" });
});

test("a -v<n> re-dispatch suffix is stripped the same way as a retry letter", () => {
  // #1482: a controller re-dispatches a finisher/reviewer against a PR whose
  // head moved after label — `<name>-v2`, `<name>-v10`, etc. Left unstripped,
  // this fell through to a blank pr column, orphaning the token row from the
  // PR's outcome.
  assert.deepEqual(parseMemberName("finisher-pr-1475-v2"), { ticket: "", pr: "1475" });
  // Two-digit suffixes are the same spelling, not a special case: -v10 is the
  // tenth re-dispatch, not a different pattern than -v2.
  assert.deepEqual(parseMemberName("finisher-pr-1475-v10"), { ticket: "", pr: "1475" });
  // The existing single-letter retry suffix keeps working unchanged.
  assert.deepEqual(parseMemberName("finisher-pr-1475-b"), { ticket: "", pr: "1475" });
});

test("a bare numeric re-dispatch suffix is stripped for PR-shaped names only (#1482)", () => {
  // The numeric-only suffix (a genuine second-ticket batch, not a retry) is
  // still deliberately NOT stripped for a TICKET-shaped name.
  assert.deepEqual(parseMemberName("impl-137-2"), { ticket: "", pr: "" });
  // The commoner numeric re-dispatch spelling (no `-v`, no letter) also falls
  // through the old regex: `finisher-pr-1440-2`, `fix-pr-1281-2`. A trailing
  // `-\d+` cannot be a second ticket the way `impl-<ticket>-<n>`'s can —
  // measured across docs/metrics/member-outcomes.tsv: 476,202 cache-create
  // tokens across 7 real rows fell through to a blank pr column this way,
  // more than the 37,580 the -v<n> fix above addressed.
  assert.deepEqual(parseMemberName("finisher-pr-1440-2"), { ticket: "", pr: "1440" });
  assert.deepEqual(parseMemberName("fix-pr-1281-2"), { ticket: "", pr: "1281" });
  // The ticket-shaped impl-<ticket>-<n> family is untouched: its second-ticket
  // ambiguity is real, and a PR-shaped name's is not.
  assert.deepEqual(parseMemberName("impl-753-2"), { ticket: "", pr: "" });
});

test("an unrecognised name yields blanks, never a guess", () => {
  assert.deepEqual(parseMemberName("size candidate 7"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName(""), { ticket: "", pr: "" });
});

test("a member family spelled PascalCase or without hyphens yields the same join key as its kebab form (#2396)", () => {
  // omp task names are free-form: this repo's own member-outcomes.tsv carries
  // `ReviewPR77`, `FinisherPr1567b` and `FixPr1568-2` beside `impl-580`. Each
  // returned blanks, losing the row's join key into tier-outcomes.tsv.
  assert.deepEqual(parseMemberName("Impl327"), { ticket: "327", pr: "" });
  assert.deepEqual(parseMemberName("Fix-pr-766"), { ticket: "", pr: "766" });
  assert.deepEqual(parseMemberName("FixPr774"), { ticket: "", pr: "774" });
  assert.deepEqual(parseMemberName("Review-pr-771"), { ticket: "", pr: "771" });
  assert.deepEqual(parseMemberName("ReviewPR77"), { ticket: "", pr: "77" });
  assert.deepEqual(parseMemberName("Finisher-pr-766"), { ticket: "", pr: "766" });
  assert.deepEqual(parseMemberName("ResolvePr1232"), { ticket: "", pr: "1232" });
  assert.deepEqual(parseMemberName("Finisher532"), { ticket: "", pr: "532" });
  // The retry suffixes keep their meaning when glued on without a hyphen.
  assert.deepEqual(parseMemberName("FinisherPr1567b"), { ticket: "", pr: "1567" });
  assert.deepEqual(parseMemberName("FixPr1568-2"), { ticket: "", pr: "1568" });
  assert.deepEqual(parseMemberName("Impl580b"), { ticket: "580", pr: "" });
  // ...and the deliberate blanks stay blank in either spelling.
  assert.deepEqual(parseMemberName("Impl137-2"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName("MergeBot12"), { ticket: "", pr: "" });
});

test("a generated word pair that merely starts with a family word yields blanks (#2396)", () => {
  assert.deepEqual(parseMemberName("InstallVerifySearch"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName("ReviewPrDispatch"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName("Issue134Implement"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName("Implementer5"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName("Impl1341/Impl1341.CwdProbe"), { ticket: "", pr: "" });
});

test("a review fan-out label books its PR, in the label's own spelling and in the stem omp writes for it", () => {
  // omp names the member by deleting every character outside [A-Za-z0-9_-]
  // from the label and appending -<n> from a label's second dispatch on.
  for (const [label, stem] of [
    ["review:correctness:pr2132", "reviewcorrectnesspr2132"],
    ["review:silent-failure:pr2132", "reviewsilent-failurepr2132"],
    ["verify:comments:pr2132", "verifycommentspr2132"],
    ["snapshot:pr2132", "snapshotpr2132"],
    ["test-run:pr2132", "test-runpr2132"],
  ]) {
    assert.deepEqual(parseMemberName(label), { ticket: "", pr: "2132" }, label);
    assert.deepEqual(parseMemberName(stem), { ticket: "", pr: "2132" }, stem);
    assert.deepEqual(parseMemberName(`${stem}-7`), { ticket: "", pr: "2132" }, `${stem}-7`);
    // Nested under the reviewer that dispatched it: the last segment is the member.
    assert.deepEqual(parseMemberName(`review-pr-2132/${stem}`), { ticket: "", pr: "2132" }, `nested ${stem}`);
  }
  // A dimension key that itself spells `pr` still yields the trailing number.
  assert.deepEqual(parseMemberName("reviewprpr12"), { ticket: "", pr: "12" });
});

test("a fan-out stem that carries no PR, or a name that only resembles one, books nothing", () => {
  // Measured stems from before the label carried its PR.
  for (const name of ["verifycorrectness-26", "reviewtests", "snapshot-8", "snapshot", "test-run",
    // Generated or human names: PascalCase never matches, and a bare number is not `pr<n>`.
    "ReviewCorrectness", "VerifyAndRepair", "Verify685", "ReviewTestsPr12", "review:correctness", "verify::pr", "reviewpr",
    // Look-alikes of a fan-out stem: a prefix before the family word, a key-less `verify`, a hyphen before `pr`.
    "xreviewfoopr12", "xsnapshotpr12", "verifypr12", "snapshot-pr12", "test-run-pr12", "verify-pr12", "reviewers-sprint-pr3"]) {
    assert.deepEqual(parseMemberName(name), { ticket: "", pr: "" }, name);
  }
});

// ---------------------------------------------------------------------------
// omp fixtures — shaped like real ~/.omp/agent/sessions/**/*.jsonl lines
// ---------------------------------------------------------------------------

const evt = (o) => JSON.stringify(o);
const sessionEvt = (cwd) => evt({ type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd });
const thinkingEvt = (level) => evt({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-09-08T15:11:49.494Z", thinkingLevel: level, configured: null });
const sessionInitEvt = (task, agent) => evt({ type: "session_init", id: "i1", parentId: "t1", timestamp: "2026-09-08T15:11:49.495Z", task, agent });
const assistantEvt = (model, usage = {}, ts = "2026-08-25T09:00:00.000Z") => evt({
  type: "message", id: "m1", parentId: "i1", timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 }, ...usage } },
});

// A real `<ISO>_<uuid>` name: most of this file's fixtures reach the CLI via
// spawnSync, and the CLI now refuses (#1302-style) a directory whose own
// name is not an omp session dir — see "a directory that is not an omp
// session dir is a refusal" below. rowsForSession() itself still reads
// whatever directory it is handed and applies no name gate of its own; only
// the CLI (member-outcomes.mjs's main()) and readMembers()'s tree walk
// (member-record.test.mjs) do.
function fixture(members) {
  const root = tempDir("mo-");
  const sessionDir = join(root, "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890");
  for (const [name, lines] of members) {
    const file = join(sessionDir, `${name}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
    utimesSync(file, new Date("2026-08-25T09:00:00Z"), new Date("2026-08-25T09:00:00Z"));
  }
  return sessionDir;
}

test("one row per member, stamped with the session and its run date", () => {
  const dir = fixture([
    ["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]],
    ["merge-bot-12", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("merge bot pass 12", "fleet-merge-bot"), assistantEvt("claude-opus-5")]],
  ]);
  const rows = rowsForSession(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].session, "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890");
  assert.equal(rows[0].run_date, "2026-08-25");
});

test("a member whose file readFileSync cannot read is skipped without losing its siblings", () => {
  // Not a permissions test (unreliable across CI users/root) — a directory
  // named `<x>.jsonl` matches the recursive `.jsonl` filter exactly the same
  // way a regular file does, and readFileSync on a directory throws EISDIR,
  // the same class of per-file fault the try/catch below exists to survive.
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  mkdirSync(join(dir, "bad.jsonl"));
  assert.equal(rowsForSession(dir).length, 1);
});

test("a session directory that does not exist yields no rows and does not throw", () => {
  const root = tempDir("mo-");
  assert.deepEqual(rowsForSession(join(root, "never-created")), []);
});

test("a member that yields no row still dates the session, and its siblings survive", () => {
  // A member dispatched but not yet answered (session_init, no assistant turn
  // yet) is dropped, but it DID write a transcript: its mtime is part of when
  // this session ran. Sampling mtime only for surviving members would date
  // the session from the older sibling.
  const dir = fixture([
    ["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]],
    ["impl-581", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("Implement ticket 581", "fleet-implementer")]],
  ]);
  const newer = join(dir, "impl-581.jsonl");
  utimesSync(newer, new Date("2026-08-26T09:00:00Z"), new Date("2026-08-26T09:00:00Z"));

  const rows = rowsForSession(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member, "impl-580");
  assert.equal(rows[0].run_date, "2026-08-26");
});

test("a nested member's fan-out is scraped too, keyed on its path-relative stem", () => {
  // Transcripts live at TWO depths: the flat top-level ones a directly-
  // dispatched member writes, and one level deeper for the fan-out a member
  // itself dispatches (a nested reviewer, say). A one-level readdir would
  // miss the whole nested half.
  //
  // Mutation this must survive: dropping `{ recursive: true }`.
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  mkdirSync(join(dir, "Nested"), { recursive: true });
  writeFileSync(join(dir, "Nested", "Reviewer.jsonl"), [
    sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("Review PR 943"), assistantEvt("claude-sonnet-5"),
  ].join("\n") + "\n");

  const rows = rowsForSession(dir);
  assert.equal(rows.length, 2);
  const nested = rows.find((r) => r.model === "claude-sonnet-5");
  assert.ok(nested, "the nested transcript produced a row");
  // The stem carries the path, which is what keeps `agent` unique across the
  // two depths — and what lets this widening REPLACE existing rows rather
  // than duplicate them, since a flat stem is unchanged by recursing.
  assert.equal(nested.agent, "Nested/Reviewer");
  assert.equal(rows.find((r) => r.model === "claude-opus-5").agent, "impl-580");
});

test("role comes from classifyRole and is not invented here", () => {
  // `role` had no assertion anywhere: it is the GROUPING column of the header's
  // pair query, so a classifyRole regression moved every bucket in the read-out
  // while the suite stayed green.
  const dir = fixture([
    ["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]],
    ["merge-bot-3", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("merge pass 3", "fleet-merge-bot"), assistantEvt("claude-opus-5")]],
    ["general-purpose", [sessionEvt("/x"), sessionInitEvt("Review PR 943 correctness"), assistantEvt("claude-opus-5")]],
  ]);
  const byMember = Object.fromEntries(rowsForSession(dir).map((r) => [r.member, r.role]));
  assert.equal(byMember["impl-580"], "implementer");
  assert.equal(byMember["merge-bot-3"], "merge-bot");
  // A non-canonical AgentId with no spawnDepth and no `agent` field, only
  // task prose — classifies off the task text alone.
  assert.equal(byMember["general-purpose"], "reviewer");
});

test("`subagent_type` is what the DISPATCH named, and blank when it named nothing", () => {
  // The whole of #1066: a deliberate alternate-tier pair is identifiable only
  // from the dispatch record, and `session_init.agent` is written at dispatch
  // time — so the column is derived, survives a regeneration, and mislabels
  // no historical row.
  const dir = fixture([
    ["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("Implement ticket 580", "fleet-implementer"), assistantEvt("claude-opus-5")]],
    ["impl-581", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("Implement ticket 581", "fleet-implementer-alt"), assistantEvt("claude-sonnet-5")]],
    ["impl-582", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]],
  ]);
  assert.deepEqual(
    Object.fromEntries(rowsForSession(dir).map((r) => [r.member, r.subagentType])),
    { "impl-580": "fleet-implementer", "impl-581": "fleet-implementer-alt", "impl-582": "" },
  );
});

test("a row whose cell count is wrong is REFUSED, never padded", () => {
  // Padding put "" in the trailing columns — `agent` was the LAST one when
  // this was written, a key rowsForSession can never produce, so mergeRows
  // could never replace it. Three measured routes there, all exit 0: a torn
  // last line became a permanent phantom that re-scraping could not heal, git
  // conflict markers became three data rows, and adding one column ahead of
  // `agent` collapsed 2,702 rows to 156. The columns that trail `agent` now
  // are the priced ones, where a padded blank reads as "no figure recorded".
  //
  // The 15-field spelling is the PREVIOUS schema, from before the four priced
  // columns: it must be refused rather than padded with blank prices, which
  // would read as "no figure was recorded" for members whose transcript
  // carried one. Re-scraping is the migration. The 14-field one before it is
  // refused the same way.
  //
  // Mutation this must survive: restoring `cells[i] ?? ""`.
  const short = ["s1", "2026-08-25", "memory"].join("\t");
  assert.throws(() => parseTsv(short), /malformed row: 3 fields, expected 19/);
  assert.throws(() => parseTsv("<<<<<<< HEAD"), /malformed row/);
  const full = formatTsv([row()]).replace(/\n$/, "").split("\t");
  assert.equal(full.length, 19);
  assert.throws(() => parseTsv(full.slice(0, 15).join("\t")), /15 fields, expected 19/);
  assert.throws(() => parseTsv(full.slice(0, 14).join("\t")), /14 fields, expected 19/);
  // A long row is refused too — that is the schema-drift direction.
  assert.throws(() => parseTsv(full.join("\t") + "\textra"), /20 fields/);
});

test("the four priced columns follow subagent_type, and a scraped member fills them", () => {
  assert.deepEqual(COLUMNS.slice(COLUMNS.indexOf("subagent_type")),
    ["subagent_type", "tokens_in", "tokens_cache_read", "tokens_cache_write_1h", "cost"]);
  const [parsed] = parseTsv(formatTsv([row({ tokensIn: 12, tokensCacheRead: 3400, tokensCacheWrite1h: 900, cost: 0.123457 })]));
  assert.deepEqual([parsed.tokensIn, parsed.tokensCacheRead, parsed.tokensCacheWrite1h, parsed.cost], ["12", "3400", "900", "0.123457"]);
});

const row = (o = {}) => ({
  session: "s1", run_date: "2026-08-25", role: "implementer", member: "impl-580",
  model: "claude-opus-5", effort: "xhigh", ticket: "580", pr: "",
  tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1,
  // Default agent tracks the default/overridden member, so fixtures that vary
  // only `member` still get distinct transcript ids, and fixtures that share
  // the default member (untouched) still key as the SAME agent.
  agent: o.member ?? "impl-580", harness: "omp",
  subagentType: "fleet-implementer",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0.01, ...o,
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
  // `member` falls back to the agent stem for an unnamed dispatch, and every
  // unnamed agent in a session shares the same fallback. Keying on the member
  // name collapsed 1,202 of 2,694 real members into their siblings.
  const a = row({ agent: "aaaa", member: "general-purpose" });
  const b = row({ agent: "bbbb", member: "general-purpose" });
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

test("a nonexistent session directory is a refusal, not a silent no-op", () => {
  // A wrong guess used to exit 0 having written nothing, because
  // rowsForSession() catches the readdir failure and returns []. A dir that
  // EXISTS but holds no transcripts yet is a real, legitimate state (a
  // session between launch and its first member's spawn) and must not
  // refuse; only a path that genuinely does not resolve should.
  const missing = join(tempDir("mo-empty-"), "never-created");
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const r = spawnSync(process.execPath, [CLI, missing, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
  assert.equal(existsSync(out), false);
});

test("a session-dir argument that is actually a FILE is a refusal, not a silent no-op", () => {
  const root = tempDir("mo-notdir-");
  const notADir = join(root, "impl-580.jsonl");
  writeFileSync(notADir, "");
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const r = spawnSync(process.execPath, [CLI, notADir, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ENOTDIR/);
  assert.equal(existsSync(out), false);
});

test("a directory that is not an omp <ISO>_<uuid> session dir is a refusal, not silently scraped whole", () => {
  // #1302-shaped regression: this CLI hands rowsForSession one EXPLICIT
  // directory, which readdirSync's `{recursive:true}` then walks in full —
  // so an encoded-cwd PROJECT directory (holding a real nested session dir
  // plus a stray top-level main-session transcript, the real tree's own
  // shape) used to be silently accepted whole: every session under it
  // stamped with the project dir's own name, and the controller's own
  // main-session transcript booked as a member.
  const root = tempDir("mo-proj-");
  const projectDir = join(root, "-dev-fleet-plugin");
  const sessionName = "2026-09-08T14-14-34-049Z_01a0815e-e141-716c-b2d8-2adf310fbe55";
  mkdirSync(join(projectDir, sessionName), { recursive: true });
  writeFileSync(join(projectDir, sessionName, "impl-5.jsonl"),
    [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")].join("\n") + "\n");
  writeFileSync(join(projectDir, `${sessionName}.jsonl`),
    [sessionEvt("/x"), assistantEvt("claude-sonnet-5")].join("\n") + "\n");
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const r = spawnSync(process.execPath, [CLI, projectDir, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not an omp .* session directory/);
  assert.equal(existsSync(out), false);
});

test("--file=<path> is refused, not silently ignored", () => {
  // --file wants a SPACE-separated value, not `=`. Without a check, this never
  // sets fileIdx, so it silently writes the PRODUCTION metrics file instead of
  // the path the operator asked for.
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const r = spawnSync(process.execPath, [CLI, dir, "--file=/tmp/x.tsv"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--file/);
});

test("an unrecognised flag is refused, not silently dropped", () => {
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const r = spawnSync(process.execPath, [CLI, dir, "--wat"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--wat/);
});

test("two separate sessions scraped in two runs merge into one TSV", () => {
  const dirA = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("Implement ticket 580", "fleet-implementer"), assistantEvt("claude-opus-5")]]]);
  const dirB = fixture([["Solo", [sessionEvt("/x"), thinkingEvt("high"), sessionInitEvt("Implement ticket 581", "fleet-implementer-alt"), assistantEvt("claude-sonnet-5")]]]);

  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const runA = spawnSync(process.execPath, [CLI, dirA, "--file", out], { encoding: "utf8" });
  assert.equal(runA.status, 0, runA.stderr);
  const runB = spawnSync(process.execPath, [CLI, dirB, "--file", out], { encoding: "utf8" });
  assert.equal(runB.status, 0, runB.stderr);

  const rows = parseTsv(readFileSync(out, "utf8"));
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.member)), new Set(["impl-580", "Solo"]));
  // #1066: the deliberate-pair column reaches the FILE, not just the record.
  assert.equal(rows.find((r) => r.member === "Solo").subagentType, "fleet-implementer-alt");
});

test("a scrape writes the priced columns off the transcript's usage, the 1h share off its cttl", () => {
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("high"),
    assistantEvt("claude-opus-5", { input: 7, cacheRead: 500, cacheWrite: 300, cttl: { ephemeral1h: 300 }, cost: { total: 0.25 } }),
    assistantEvt("claude-opus-5", { input: 3, cacheRead: 800, cacheWrite: 40, cttl: { ephemeral5m: 40 }, cost: { total: 0.0500004 } }, "2026-08-25T10:05:00.000Z"),
  ]]]);
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const r = spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [row] = parseTsv(readFileSync(out, "utf8"));
  assert.deepEqual([row.tokensIn, row.tokensCacheRead, row.tokensCacheCreate, row.tokensCacheWrite1h, row.cost],
    ["10", "1300", "340", "300", "0.3"]);
});

test("a run writes rows, and a second run over the same session changes nothing", () => {
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const run = () => spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const first = readFileSync(out, "utf8");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(out, "utf8"), first);
});

test("the header survives a rewrite", () => {
  // The header carries the read-out commands and the blank-means-unknown rule.
  // A rewrite that drops it strands every reader.
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  writeFileSync(out, "# keep me\n");
  spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.match(readFileSync(out, "utf8"), /^# keep me$/m);
});

test("importing the module never runs the CLI, even from a file whose name ends with its own", () => {
  // The guard used to be a suffix match, so a wrapper called
  // run-member-outcomes.mjs tripped the CLI block on import: it wrote a file
  // and exited 2 in a process that only wanted the helpers.
  const dir = tempDir("mo-wrap-");
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
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const cwd = tempDir("mo-cwd-");
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
  //
  // Mutation this must survive: printing merged.length alone.
  const dir = fixture([
    ["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]],
    // A sibling dispatched but never answered — the real drop shape: a
    // transcript that exists, carries no assistant turn, and so yields no row.
    ["impl-581", [sessionEvt("/x"), thinkingEvt("xhigh"), sessionInitEvt("Implement ticket 581", "fleet-implementer")]],
  ]);
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  writeFileSync(out, formatTsv([row({ session: "other", member: "impl-1" })]));

  const r = spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /scraped 1 of 2 members \(1 dropped\)/);
  // The file total is still reported, and is deliberately a DIFFERENT number
  // from the yield — that difference is the whole point.
  assert.match(r.stderr, /holds 2 rows/);
});

test("a corpus this schema cannot read is refused before anything is rewritten", () => {
  // Reading an out-of-schema file used to pad it and rewrite it, converting a
  // human's unresolved merge conflict into confident-looking data.
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
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
  const dir = fixture([["impl-580", [sessionEvt("/x"), thinkingEvt("xhigh"), assistantEvt("claude-opus-5")]]]);
  const out = join(tempDir("mo-out-"), "member-outcomes.tsv");
  const header = "# first paragraph\n\n# second paragraph\n";
  writeFileSync(out, header);
  spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(readFileSync(out, "utf8").startsWith(header), true);
});

test("a run dispatched under PascalCase names scrapes into rows tier-outcomes check can join, and a wrong tier fails (#2396)", () => {
  // End to end, the two CLIs the ticket's measurement ran: scrape the session,
  // then check tier-outcomes.tsv against what was scraped. Before the fix the
  // scraped row's ticket was blank, so check reported 0 checked and exited 0
  // even with a deliberately wrong tier.
  const dir = fixture([
    ["Impl327", [sessionEvt("/x"), thinkingEvt("high"), sessionInitEvt("Ticket 327", "fleet-implementer-alt"), assistantEvt("claude-sonnet-5")]],
    // Dispatched under the generic `task` definition, so only the NAME can
    // book it implementer — implementerRows() filters on role as well as ticket.
    ["Impl333", [sessionEvt("/x"), thinkingEvt("high"), sessionInitEvt("Ticket 333"), assistantEvt("claude-opus-5")]],
    ["FixPr774", [sessionEvt("/x"), thinkingEvt("high"), sessionInitEvt("Apply the findings"), assistantEvt("claude-opus-5")]],
    // No `session_init` line at all, so neither `task` nor `agent` exists: only
    // the canonical-stem gate in ompMemberRecord lets the name classify it.
    ["Impl340", [sessionEvt("/x"), thinkingEvt("high"), assistantEvt("claude-opus-5")]],
  ]);
  const work = tempDir("mo-tier-");
  const members = join(work, "member-outcomes.tsv");
  const scrape = spawnSync(process.execPath, [CLI, dir, "--file", members], { encoding: "utf8" });
  assert.equal(scrape.status, 0, scrape.stderr);
  const byMember = Object.fromEntries(parseTsv(readFileSync(members, "utf8")).map((r) => [r.member, `${r.role} ticket=${r.ticket} pr=${r.pr}`]));
  assert.deepEqual(byMember, {
    Impl327: "implementer ticket=327 pr=",
    Impl333: "implementer ticket=333 pr=",
    FixPr774: "reviewer ticket= pr=774",
    Impl340: "implementer ticket=340 pr=",
  });

  const check = (tier) => {
    const tierFile = join(work, "tier-outcomes.tsv");
    const row = [TIER_SWITCH_DATE, "774", "327", "routine", tier, "yes", "no", "n", "light", "production", "40", "2"].join("\t");
    writeFileSync(tierFile, `# ${TIER_COLUMNS.join("\t")}\n${row}\n`);
    return spawnSync(process.execPath, [TIER_CLI, "check", "--file", tierFile, "--member-outcomes", members, "--ledger", join(work, "no-ledger.md")], { encoding: "utf8", cwd: work });
  };
  const ok = check("alt");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 rows; 1 checked, 0 failed/);
  const mutant = check("WRONGTIER");
  assert.equal(mutant.status, 1);
  assert.match(mutant.stdout, /1 rows; 1 checked, 1 failed/);
  assert.match(mutant.stderr, /PR #774 \(ticket #327\): tier=WRONGTIER/);
});
