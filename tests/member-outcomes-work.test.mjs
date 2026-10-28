import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { rowsForSession, mergeRows, parseTsv, COLUMNS } from "../plugin/scripts/member-outcomes.mjs";

// ---------------------------------------------------------------------------
// Fixtures: a session directory of member transcripts, and the controller's
// own `<session>.jsonl` beside it. Every timestamp is `at(seconds)` past T0.
// ---------------------------------------------------------------------------

const SESSION = "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890";
const T0 = Date.parse("2026-08-25T09:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const evt = (o) => JSON.stringify(o);
const turn = (s) => evt({
  type: "message", timestamp: at(s),
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5", stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } } },
});
const usage = (s) => evt({ type: "model_usage", timestamp: at(s) });
const exit = (s) => evt({ type: "custom", customType: "session_exit", timestamp: at(s), data: { reason: "dispose", kind: "normal" } });
// A member that writes at each of `seconds`: a turn first, then plain entries.
const writes = (...seconds) => [turn(seconds[0]), ...seconds.slice(1).map(usage)];
const controllerAt = (...seconds) => seconds.map((s) => evt({ type: "message", timestamp: at(s), message: { role: "user", content: [] } }));
const every = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

// `controller` is the controller transcript's lines, or null for none.
function session(members, controller) {
  const root = tempDir("mow-");
  const dir = join(root, SESSION);
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(members)) {
    const file = join(dir, `${name}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
  }
  if (controller) writeFileSync(join(root, `${SESSION}.jsonl`), controller.join("\n") + "\n");
  return dir;
}

const rowsOf = (dir) => Object.fromEntries(rowsForSession(dir, {}, { verifyMain: () => 0 }).map((r) => [r.member, r]));
const workOf = (dir, member) => rowsOf(dir)[member].workS;

test("`work_s` is appended after `dispatch_model`, the column the file ended on", () => {
  assert.deepEqual(COLUMNS.slice(-3), ["ending", "dispatch_model", "work_s"]);
});

test("the committed TSV parses under COLUMNS, and every harness=claude row reads blank work_s", () => {
  const rows = parseTsv(readFileSync(new URL("../docs/metrics/member-outcomes.tsv", import.meta.url), "utf8"));
  const claude = rows.filter((r) => r.harness === "claude");
  assert.ok(claude.length > 0, "the corpus still holds claude rows");
  assert.deepEqual(claude.filter((r) => r.workS !== ""), []);
  assert.ok(rows.some((r) => r.harness === "omp" && r.workS !== ""), "omp rows carry work_s");
});

// ---------------------------------------------------------------------------
// A member's parts: split at each session_exit, the wait around it uncounted
// ---------------------------------------------------------------------------

test("a member whose session_exit comes 420 s after its last working entry works up to that entry; wall_s keeps the raw span", () => {
  const dir = session({ "impl-1": [...writes(0, 300, 600), exit(1020)] }, controllerAt(0, 1020));
  const row = rowsOf(dir)["impl-1"];
  assert.equal(row.workS, 600);
  assert.equal(row.wallS, 1020, "wall_s is still first entry to last, teardown included");
});

test("a member whose last line is stamped before its first reads a wall_s of the span, never negative (#3948)", () => {
  const dir = session({ "impl-28": [turn(100), turn(50)] }, controllerAt(0, 100));
  const row = rowsOf(dir)["impl-28"];
  assert.equal(row.wallS, 50);
  assert.equal(row.workS, 0, "work_s skips the part whose end is not after its start, as before");
});

test("a woken member works the sum of its two parts; the wait between them is not counted", () => {
  const dir = session({
    "impl-2": [...writes(0, 300), exit(720), usage(2000), usage(2300), exit(2720)],
  }, controllerAt(...every(0, 2720, 600)));
  assert.equal(workOf(dir, "impl-2"), 300 + 300);
});

test("a member never woken again after its final session_exit ends at its last entry before it", () => {
  const dir = session({ "impl-3": [...writes(0, 100), exit(520)] }, controllerAt(0, 520));
  assert.equal(workOf(dir, "impl-3"), 100);
});

test("a member that never exited works from its first entry to its last", () => {
  const dir = session({ "impl-4": writes(0, 250) }, controllerAt(0, 250));
  assert.equal(workOf(dir, "impl-4"), 250);
});

test("a fractional-second part rounds to the nearest whole second", () => {
  const dir = session({ "impl-26": writes(0, 1.5), "impl-27": writes(0, 1.499) }, controllerAt(0, 1.5));
  assert.equal(workOf(dir, "impl-26"), 2);
  assert.equal(workOf(dir, "impl-27"), 1);
});

// ---------------------------------------------------------------------------
// Halts: more than 60 minutes in which no transcript of the run writes
// ---------------------------------------------------------------------------

test("a 61-minute stretch inside a member's span with no entry anywhere in the run is subtracted", () => {
  const dir = session({ "impl-5": writes(0, 3660, 3720) }, controllerAt(0, 3720));
  assert.equal(workOf(dir, "impl-5"), 60);
});

test("a stretch of exactly 60 minutes is not a halt", () => {
  const dir = session({ "impl-6": writes(0, 3600, 3660) }, controllerAt(0, 3660));
  assert.equal(workOf(dir, "impl-6"), 3660);
});

test("a 90-minute stretch in which only another member's nested member writes is not subtracted", () => {
  const dir = session({
    "impl-8": writes(0, 5400),
    "review-pr-9": writes(0, 60),
    "review-pr-9/Nested": writes(...every(600, 4800, 600)),
  }, controllerAt(0, 5400));
  assert.equal(workOf(dir, "impl-8"), 5400);
});

test("a 90-minute stretch in which only the controller writes, one entry every 20 minutes, is not subtracted", () => {
  const dir = session({ "impl-10": writes(0, 5400) }, controllerAt(...every(0, 5400, 1200), 5400));
  assert.equal(workOf(dir, "impl-10"), 5400);
});

test("a halt over a session_exit wait is not subtracted a second time", () => {
  // Parts [0, 600] and [8220, 8520]; nothing writes from 1020 to 8220, which
  // is a halt lying wholly inside the uncounted wait.
  const dir = session({ "impl-11": [...writes(0, 600), exit(1020), usage(8220), usage(8520), exit(8940)] },
    controllerAt(0, 1020, 8220, 8940));
  assert.equal(workOf(dir, "impl-11"), 600 + 300);
});

test("of two halts, the one inside a part is subtracted and the one in the wait after its exit is not", () => {
  // Part [0, 4100]; the run is silent from 400 to 4100 and again from 4100 to
  // the member's session_exit at 8000, a wait that is never counted.
  const dir = session({ "impl-12": [...writes(0, 400, 4100), exit(8000)] }, controllerAt(0, 4100, 8000));
  assert.equal(workOf(dir, "impl-12"), 400);
});

test("a halt between the run's two earliest entries is subtracted", () => {
  // The member's first entry is the run's first; nothing else writes until
  // 3700, so the very first gap of the run is the halt.
  const dir = session({ "impl-28": writes(0, 3700, 3760) }, controllerAt(3700, 3760));
  assert.equal(workOf(dir, "impl-28"), 60);
});

// ---------------------------------------------------------------------------
// Blank: unknown, never zero
// ---------------------------------------------------------------------------

test("every row of a session whose controller transcript is missing reads blank work_s; the rest of each row is as before", () => {
  const members = { "impl-13": [...writes(0, 300), exit(720)], "review-pr-14": writes(0, 90) };
  const withController = rowsOf(session(members, controllerAt(0, 720)));
  const without = rowsOf(session(members, null));
  for (const m of Object.keys(members)) {
    assert.equal(without[m].workS, null, `${m}: unknown, which the TSV writes as blank`);
    assert.notEqual(withController[m].workS, null);
    const { workS: _a, ...rest } = without[m];
    const { workS: _b, ...restWith } = withController[m];
    assert.deepEqual(rest, restWith, `${m}: every other cell is unchanged`);
  }
});

test("an omp row whose transcript has no timestamped entry reads blank", () => {
  const untimed = [evt({ type: "message", message: { role: "assistant", content: [], model: "claude-opus-5", stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } })];
  const dir = session({ "impl-15": untimed, "impl-16": writes(0, 60) }, controllerAt(0, 60));
  const rows = rowsOf(dir);
  assert.equal(rows["impl-15"].workS, "");
  assert.equal(rows["impl-16"].workS, 60, "a member beside it still gets its own");
});

test("a transcript that yields no row still counts as the run writing", () => {
  // `Probe` has no assistant turn, so it books no row, but its entries break
  // what would otherwise be a 90-minute halt inside impl-17's span.
  const probe = every(600, 4800, 600).map(usage);
  const dir = session({ "impl-17": writes(0, 5400), Probe: probe }, controllerAt(0, 5400));
  const rows = rowsOf(dir);
  assert.equal(rows.Probe, undefined);
  assert.equal(rows["impl-17"].workS, 5400);
});

test("a controller line without a usable timestamp, or a torn last line, is skipped and finds the same halts", () => {
  // Clean: the run is silent from 0 to 3700, a halt inside impl-29's part.
  const members = { "impl-29": writes(0, 3700, 3760) };
  const clean = session(members, controllerAt(0, 3700, 3760));
  const noisy = session(members, null);
  writeFileSync(join(dirname(noisy), `${SESSION}.jsonl`), [
    evt({ type: "message", message: { role: "user", content: [] } }),
    evt({ type: "message", timestamp: 1800, message: { role: "user", content: [] } }),
    evt({ type: "message", timestamp: "not a time", message: { role: "user", content: [] } }),
    ...controllerAt(0, 3700, 3760),
    '{"type":"message","timestamp":"', // torn mid-write: no newline after it
  ].join("\n"));
  assert.equal(workOf(clean, "impl-29"), 60);
  assert.equal(workOf(noisy, "impl-29"), 60);
});

test("a controller line torn before its last leaves every row's work_s unknown", () => {
  // The torn line may have been the entry that broke the stretch from 2000 to
  // 5700, so that stretch cannot be read as a halt or as the run writing.
  const dir = session({ "impl-30": writes(0, 5700) }, null);
  writeFileSync(join(dirname(dir), `${SESSION}.jsonl`),
    [...controllerAt(0, 2000), '{"type":"message","timestamp":"', ...controllerAt(5700)].join("\n") + "\n");
  const stats = {};
  const [row] = rowsForSession(dir, stats, { verifyMain: () => 0 });
  assert.equal(row.workS, null);
  assert.equal(stats.workSUnknown, "an unparseable controller transcript line");
});

test("a controller transcript that is there but cannot be read leaves work_s unknown and is named as unreadable, not as missing", () => {
  const dir = session({ "impl-34": writes(0, 60) }, null);
  mkdirSync(join(dirname(dir), `${SESSION}.jsonl`));
  const stats = {};
  const [row] = rowsForSession(dir, stats, { verifyMain: () => 0 });
  assert.equal(row.workS, null);
  assert.equal(stats.workSUnknown, "unreadable controller transcript: EISDIR");
});

test("a transcript of the run that cannot be read leaves every row's work_s unknown", () => {
  // impl-31 writes from 0 to 8000 while impl-32 writes every 10 minutes
  // through it. A `.jsonl` entry that cannot be read (here a directory) hides
  // impl-32's entries, so 0 to 8000 would otherwise read as one halt.
  const dir = session({ "impl-31": writes(0, 8000), "impl-32": writes(...every(0, 7800, 600)) }, controllerAt(0, 8000));
  assert.equal(workOf(dir, "impl-31"), 8000);
  rmSync(join(dir, "impl-32.jsonl"));
  mkdirSync(join(dir, "impl-32.jsonl"));
  const stats = {};
  const rows = rowsForSession(dir, stats, { verifyMain: () => 0 });
  assert.deepEqual(rows.map((r) => [r.member, r.workS]), [["impl-31", null]]);
  assert.equal(stats.workSUnknown, "1 unreadable transcript");
});

// ---------------------------------------------------------------------------
// Keep a recorded work_s: mergeRows never overwrites one with an unknown
// ---------------------------------------------------------------------------

const row = (o) => ({ session: SESSION, agent: "impl-20", member: "impl-20", model: "m", workS: "", ...o });

test("an incoming unknown work_s keeps the recorded one, and the merge counts it", () => {
  const stats = {};
  const [merged] = mergeRows([row({ workS: "123" })], [row({ workS: null, model: "n" })], stats);
  assert.equal(merged.workS, "123");
  assert.equal(merged.model, "n", "every other cell is still the re-scrape's");
  assert.equal(stats.workSKept, 1);
});

test("an unknown work_s over a blank one stays blank, and a computed one replaces a recorded one", () => {
  const stats = {};
  assert.equal(mergeRows([row({ workS: "" })], [row({ workS: null })], stats)[0].workS ?? "", "");
  assert.equal(stats.workSKept, 0);
  assert.equal(mergeRows([row({ workS: "123" })], [row({ workS: 77 })], stats)[0].workS, 77);
  assert.equal(stats.workSKept, 0);
  assert.equal(mergeRows([row({ workS: "123" })], [row({ workS: "" })])[0].workS, "",
    "a transcript with no timestamped entry is a reading, not an unknown");
});

// ---------------------------------------------------------------------------
// Through the CLI: re-scrapes, with and without the controller transcript
// ---------------------------------------------------------------------------

const CLI = new URL("../plugin/scripts/member-outcomes.mjs", import.meta.url).pathname;
const scrape = (dir, file) => spawnSync(process.execPath, [CLI, dir, "--file", file, "--scratch", tempDir("mow-scratch-")], { encoding: "utf8" });
const workByMember = (file) => Object.fromEntries(parseTsv(readFileSync(file, "utf8")).map((r) => [r.member, r.workS]));

test("re-scraping a session gives every row the same work_s again", () => {
  const dir = session({ "impl-21": [...writes(0, 300), exit(720)], "review-pr-22": writes(0, 3700, 3760) }, controllerAt(0, 720, 3760));
  const out = join(tempDir("mow-out-"), "member-outcomes.tsv");
  assert.equal(scrape(dir, out).status, 0);
  const first = readFileSync(out, "utf8");
  assert.deepEqual(workByMember(out), { "impl-21": "300", "review-pr-22": "3760" });
  assert.equal(scrape(dir, out).status, 0);
  assert.equal(readFileSync(out, "utf8"), first);
});

test("re-scraping once the controller transcript is gone keeps each recorded work_s, and blank stays blank", () => {
  const dir = session({ "impl-23": [...writes(0, 300), exit(720)] }, controllerAt(0, 720));
  const out = join(tempDir("mow-out-"), "member-outcomes.tsv");
  assert.equal(scrape(dir, out).status, 0);
  assert.deepEqual(workByMember(out), { "impl-23": "300" });

  // A member that joins the session after the controller transcript is gone
  // has nothing recorded to keep.
  rmSync(join(dirname(dir), `${SESSION}.jsonl`));
  writeFileSync(join(dir, "review-pr-24.jsonl"), writes(0, 60).join("\n") + "\n");
  const r = scrape(dir, out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(workByMember(out), { "impl-23": "300", "review-pr-24": "" });
  assert.match(r.stderr, /rows; work_s unknown \(no controller transcript\), 1 kept the work_s already recorded\n$/);
});

test("a session scraped with no controller transcript at all writes blank work_s, names why, and says nothing was kept", () => {
  const dir = session({ "impl-25": writes(0, 60) }, null);
  const out = join(tempDir("mow-out-"), "member-outcomes.tsv");
  const r = scrape(dir, out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(workByMember(out), { "impl-25": "" });
  assert.match(r.stderr, /work_s unknown \(no controller transcript\)/);
  assert.doesNotMatch(r.stderr, /kept the work_s/);
});

test("a scrape with the controller transcript and every transcript read names no work_s cause", () => {
  const dir = session({ "impl-33": writes(0, 60) }, controllerAt(0, 60));
  const r = scrape(dir, join(tempDir("mow-out-"), "member-outcomes.tsv"));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /work_s/);
});
