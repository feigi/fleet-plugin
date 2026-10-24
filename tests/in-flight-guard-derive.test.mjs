// docs/research/in-flight-guard-derive.mjs — ADR 0031's guard (spec § 8). The
// GitHub read is a stub `gh` on PATH that serves canned pulls pages and logs
// every call, so nothing here touches the network; the member-outcomes rows,
// the omp session files and the review transcripts are synthetic files in a
// temp directory.
//
// Two seams: the exported pure functions (window cut, active-hour count, pair
// ratios, percentile band, verdicts, booking) and the CLI's exit codes and
// printed windows over the stub.
//
// Zero deps: `node --test tests/in-flight-guard-derive.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as G from "../docs/research/in-flight-guard-derive.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "docs", "research", "in-flight-guard-derive.mjs");
const H = 3600_000, MIN = 60_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const pr = (number, created, mergedAfter = 30 * MIN, closes = []) => ({ number, created, merged: created + mergedAfter, closes });

// ------------------------------------------------------------ pure seam ----

test("percentile band: p90 for a rise test, p10 for the fall test, by linear interpolation", () => {
  const ratios = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 2.23, 5]; // index 9 of 11 is the p90 exactly
  assert.equal(G.band(ratios, "rise"), 2.23);
  const low = [0.3, 0.68, 0.9, 1, 1, 1, 1, 1, 1, 1, 1]; // index 1 of 11 is the p10 exactly
  assert.equal(G.band(low, "fall"), 0.68);
  assert.ok(Math.abs(G.band([1, 2], "rise") - 1.9) < 1e-12, "between two points the percentile interpolates");
  assert.ok(Number.isNaN(G.band([], "rise")), "no ratios, no band");
});

test("a flat series trips nothing: post ÷ pre equals the band, which is not past it", () => {
  const flat = { 1: 100, 2: 50, "3a": 1.8e6, "3b": 1, "4a": 1e5, "4b": 2e5 };
  const ratios = G.ratioSeries(Array.from({ length: 9 }, () => [10, 10]));
  const bands = Object.fromEntries(G.TESTS.map((t) => [t.id, G.band(ratios, t.dir)]));
  const vs = G.verdicts(flat, flat, bands);
  assert.deepEqual(vs.map((v) => v.verdict), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(vs.map((v) => v.id), ["1", "2", "3a", "3b", "4a", "4b"]);
});

test("a cycle ratio of 3 against a p90 of 2.23 trips 3a, and only 3a; a ratio of 2 does not", () => {
  const history = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 2.23, 5];
  const bands = { 1: NaN, 2: NaN, "3a": G.band(history, "rise"), "3b": NaN, "4a": NaN, "4b": NaN };
  const pre = { 1: NaN, 2: NaN, "3a": H, "3b": NaN, "4a": NaN, "4b": NaN };
  const three = G.verdicts(pre, { ...pre, "3a": 3 * H }, bands);
  assert.equal(three.find((v) => v.id === "3a").verdict, "TRIP");
  assert.equal(three.find((v) => v.id === "3a").ratio, 3);
  assert.deepEqual(three.filter((v) => v.verdict === "TRIP").map((v) => v.id), ["3a"]);
  const two = G.verdicts(pre, { ...pre, "3a": 2 * H }, bands);
  assert.equal(two.find((v) => v.id === "3a").verdict, "ok", "a rise inside the band is not a trip");
});

test("a throughput ratio of 0.5 against a p10 of 0.68 trips 3b; 0.7 does not; a rise never does", () => {
  const history = [0.3, 0.68, 0.9, 1, 1, 1, 1, 1, 1, 1, 1];
  const bands = { 1: NaN, 2: NaN, "3a": NaN, "3b": G.band(history, "fall"), "4a": NaN, "4b": NaN };
  const pre = { 1: NaN, 2: NaN, "3a": NaN, "3b": 2, "4a": NaN, "4b": NaN };
  const verdictOf = (post) => G.verdicts(pre, { ...pre, "3b": post }, bands).find((v) => v.id === "3b");
  assert.equal(verdictOf(1).verdict, "TRIP");
  assert.equal(verdictOf(1.4).verdict, "ok");
  assert.equal(verdictOf(6).verdict, "ok", "throughput rising is the wanted direction");
});

test("signals 1, 2 and 4 trip on their rise side only: a fall is ok", () => {
  const bands = { 1: 1.5, 2: 1.5, "3a": NaN, "3b": NaN, "4a": 1.5, "4b": 1.5 };
  const pre = { 1: 100, 2: 100, "3a": NaN, "3b": NaN, "4a": 100, "4b": 100 };
  const rise = G.verdicts(pre, { ...pre, 1: 200, 2: 200, "4a": 200, "4b": 200 }, bands).filter((v) => v.verdict === "TRIP").map((v) => v.id);
  assert.deepEqual(rise, ["1", "2", "4a", "4b"]);
  const fall = G.verdicts(pre, { ...pre, 1: 10, 2: 10, "4a": 10, "4b": 10 }, bands).filter((v) => v.verdict === "TRIP");
  assert.deepEqual(fall, []);
});

test("a test with no reading is `none`, never ok: no band, or a zero pre value", () => {
  const pre = { 1: 0, 2: 5, "3a": 1, "3b": 1, "4a": 1, "4b": 1 };
  const vs = G.verdicts(pre, { 1: 5, 2: 5, "3a": 1, "3b": 1, "4a": 1, "4b": 1 }, { 1: 1.5, 2: NaN, "3a": 1, "3b": 1, "4a": 1, "4b": 1 });
  assert.equal(vs.find((v) => v.id === "1").verdict, "none");
  assert.equal(vs.find((v) => v.id === "2").verdict, "none");
});

test("history pairs: 431 PRs hold 79 pairs of disjoint, adjoining 20-PR windows five PRs apart", () => {
  const history = Array.from({ length: 431 }, (_, i) => pr(i, T0 + i * H));
  const pairs = G.historyPairs(history, 20, 5);
  assert.equal(pairs.length, 79);
  assert.deepEqual(pairs[0].early.map((p) => p.number), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(pairs[0].late.map((p) => p.number), Array.from({ length: 20 }, (_, i) => 20 + i));
  assert.equal(pairs[1].early[0].number, 5, "the next pair starts one offset later");
  assert.equal(G.historyPairs(history.slice(0, 39), 20, 5).length, 0, "a history shorter than two windows holds no pair");
  assert.equal(G.historyPairs(history.slice(0, 40), 20, 5).length, 1);
});

test("windows: PRs created between the merge and the cutover are in neither window", () => {
  const prs = Array.from({ length: 100 }, (_, i) => pr(i, T0 + i * H));
  const merge = T0 + 49.5 * H, cutover = T0 + 60 * H;
  const { history, pre, post } = G.cutWindows(prs, { merge, cutover, after: T0, n: 20 });
  assert.deepEqual(pre.map((p) => p.number), Array.from({ length: 20 }, (_, i) => 30 + i)); // 30..49
  assert.deepEqual(post.map((p) => p.number), Array.from({ length: 20 }, (_, i) => 60 + i)); // 60..79
  const between = prs.filter((p) => p.number >= 50 && p.number < 60).map((p) => p.number);
  for (const n of between) assert.ok(![...pre, ...post, ...history].some((p) => p.number === n), `#${n} is in a window`);
  assert.equal(history.length, 50);
  assert.equal(G.cutWindows(prs, { merge, after: T0, n: 20 }).post, null, "no cutover, no post window");
});

test("the history starts at --after and the pre window may reach back past it", () => {
  const prs = Array.from({ length: 30 }, (_, i) => pr(i, T0 + i * H));
  const { history, pre } = G.cutWindows(prs, { merge: T0 + 25.5 * H, after: T0 + 10 * H, n: 20 });
  assert.equal(history[0].number, 10);
  assert.equal(pre[0].number, 6, "the 20 most recent before the merge: 6..25");
});

test("active clock hours count a UTC hour once however many PRs touch it; throughput is N over them", () => {
  const win = [pr(1, T0), pr(2, T0 + 10 * MIN), pr(3, T0 + 40 * MIN, 90 * MIN)]; // hours 0, 0, 0 → merged 0, 0, 2
  assert.equal(G.activeHours(win), 2);
  assert.equal(G.throughput(win), 1.5);
  const split = [pr(1, T0 + 50 * MIN, 20 * MIN)]; // created hour 0, merged hour 1
  assert.equal(G.activeHours(split), 2);
});

test("cycle time is the median of merged − created, interpolated between the middle pair", () => {
  const win = [pr(1, T0, 1 * H), pr(2, T0, 2 * H), pr(3, T0, 4 * H), pr(4, T0, 100 * H)];
  assert.equal(G.cycleMedian(win), 3 * H);
});

test("window values: signal 1 divides by N, not by booked rows; signal 4 is the median and p90 over PRs with a review start", () => {
  const win = [pr(1, T0), pr(2, T0 + H)];
  const bookings = new Map([[1, [memberRow({ tokensCacheCreate: "100" }), memberRow({ tokensCacheCreate: "200" })]], [2, [memberRow({ tokensCacheCreate: "300", cost: "" })]]]);
  const w = G.windowValues(win, { bookings, turns: [[T0, 10], [T0 + H, 20], [T0 + 2 * H, 1000]], reviewStarts: new Map() });
  assert.equal(w.values["1"], 300, "600 booked tokens over 2 PRs");
  assert.equal(w.values["2"], 15, "turns at the created span's ends count, the one after does not");
  assert.equal(w.diag.unpriced_rows, 1);
  assert.ok(Number.isNaN(w.values["4a"]) && Number.isNaN(w.values["4b"]), "no review start, no latency");
  const ten = Array.from({ length: 10 }, (_, i) => pr(i + 1, T0));
  const starts = new Map(ten.map((p, i) => [p.number, T0 + (i + 1) * MIN]));
  const lat = G.windowValues(ten, { bookings: new Map(), turns: [], reviewStarts: starts });
  assert.equal(lat.values["4a"], 5.5 * MIN);
  assert.ok(Math.abs(lat.values["4b"] - 9.1 * MIN) < 1e-6);
  assert.ok(Number.isNaN(lat.values["1"]) && Number.isNaN(lat.values["2"]), "no rows and no turns are a missing reading, not a zero");
  const some = G.windowValues(ten, { bookings: new Map(), turns: [], reviewStarts: new Map([...starts].slice(0, 4)) });
  assert.equal(some.diag.review_prs, 4);
  assert.equal(some.diag.no_review_prs.length, 6);
});

test("a ratio series skips a pair with no reading or a zero early side, and keeps a real zero ratio", () => {
  assert.deepEqual(G.ratioSeries([[2, 4], [NaN, 3], [0, 1], [4, 2], [3, NaN], [2, 0]]), [2, 0.5, 0]);
});

test("closing keywords in a PR body name the issues it closes", () => {
  assert.deepEqual(G.closingIssues("Closes #12\n\nfixes #13, resolved: #14 and Closes feigi/fleet-plugin#15"), ["12", "13", "14", "15"]);
  assert.deepEqual(G.closingIssues("See #12 and issue #13"), [], "a bare mention closes nothing");
  assert.deepEqual(G.closingIssues(null), []);
});

test("merged PRs: unmerged rows are dropped, order is created then number, a bad timestamp is an input error", () => {
  const rows = [
    { number: 3, created_at: iso(T0 + H), merged_at: iso(T0 + 2 * H), body: "Closes #9" },
    { number: 2, created_at: iso(T0), merged_at: null, body: "" },
    { number: 1, created_at: iso(T0 + H), merged_at: iso(T0 + 3 * H), body: "" },
  ];
  assert.deepEqual(G.mergedPrs(rows).map((p) => p.number), [1, 3]);
  assert.deepEqual(G.mergedPrs(rows)[1].closes, ["9"]);
  assert.throws(() => G.mergedPrs([{ number: 4, created_at: "nope", merged_at: iso(T0) }]), G.InputError);
});

test("merged PRs: a PR the listing returns on two pages counts once, as its last-read copy", () => {
  const a = { number: 7, created_at: iso(T0), merged_at: iso(T0 + H), body: "" };
  const aAgain = { ...a, body: "Closes #5" };
  const b = { number: 8, created_at: iso(T0 + H), merged_at: iso(T0 + 2 * H), body: "" };
  const out = G.mergedPrs([a, b, aAgain]);
  assert.deepEqual(out.map((p) => p.number), [7, 8]);
  assert.deepEqual(out[0].closes, ["5"], "the later-read copy wins");
  assert.deepEqual(G.mergedPrs([a, { ...a, merged_at: null }]), [], "a later copy that is not merged drops the PR");
});

test("ISO input: an instant is accepted, a date or a word is an input error", () => {
  assert.equal(G.parseIso("2026-10-09T10:00:00Z", "--merge"), Date.parse("2026-10-09T10:00:00Z"));
  assert.equal(G.parseIso("2026-10-09T10:00:00.500+02:00", "--merge"), Date.parse("2026-10-09T08:00:00.500Z"));
  for (const bad of ["2026-10-09", "yesterday", "", null, "2026-13-45T00:00:00Z"]) assert.throws(() => G.parseIso(bad, "--merge"), G.InputError, String(bad));
});

// -------------------------------------------------------------- booking ----

const memberRow = (o) => ({
  session: "S1", role: "reviewer", member: "x", agent: "x", harness: "omp", ticket: "", pr: "",
  tokensCacheCreate: "100", cost: "1", ...o,
});

test("booking as pr-cost books: omp rows only; merge-bot, memory and __advisor stay unbooked", () => {
  const rows = [
    memberRow({ member: "review-pr-5", agent: "review-pr-5" }),
    memberRow({ member: "fix-pr-5", agent: "fix-pr-5", role: "fixer" }),
    memberRow({ member: "review-pr-5", agent: "review-pr-5", harness: "claude", session: "S2" }),
    memberRow({ member: "merge-bot-1-5", agent: "merge-bot-1-5", role: "merge-bot" }),
    memberRow({ member: "memory-housekeeper", agent: "memory-housekeeper", role: "memory" }),
    memberRow({ member: "memory", agent: "memory", role: "specialist" }),
    memberRow({ member: "__advisor", agent: "__advisor", role: "specialist" }),
  ];
  const { byPr, unbooked } = G.bookRows(rows, new Map());
  assert.deepEqual(byPr.get(5).map((r) => r.member), ["review-pr-5", "fix-pr-5"], "the claude row is not booked");
  assert.equal(unbooked.length, 0, "excluded rows are dropped, not listed as unbooked omp spend");
  assert.equal([...byPr.values()].flat().length, 2);
});

test("booking: a nested member books to its booked ancestor; an implementer books to the PR that closes its ticket", () => {
  const rows = [
    memberRow({ member: "review-pr-5", agent: "review-pr-5" }),
    memberRow({ member: "review-pr-5/review-pr-5.verifytypespr5", agent: "review-pr-5/review-pr-5.verifytypespr5", role: "specialist" }),
    memberRow({ member: "impl-77", agent: "impl-77", role: "implementer", ticket: "77" }),
    memberRow({ member: "helper", agent: "impl-77/impl-77.helper", role: "specialist" }),
    memberRow({ member: "impl-88", agent: "impl-88", role: "implementer", ticket: "88" }),
    memberRow({ member: "stray", agent: "stray", role: "other" }),
  ];
  const { byPr, unbooked } = G.bookRows(rows, new Map([["77", 9]]));
  assert.equal(byPr.get(5).length, 2);
  assert.deepEqual(byPr.get(9).map((r) => r.agent), ["impl-77", "impl-77/impl-77.helper"]);
  assert.deepEqual(unbooked.map((r) => r.agent).sort(), ["impl-88", "stray"], "a ticket no PR closes books nowhere");
});

test("ticket → PR booking takes the latest-created merged PR whose body closes the ticket", () => {
  const prs = [pr(1, T0, 30 * MIN, ["7"]), pr(2, T0 + H, 30 * MIN, ["7", "8"])];
  assert.deepEqual([...G.prByTicket(prs)], [["7", 2], ["8", 2]]);
});

// -------------------------------------------------------------- sessions ----

const line = (o) => JSON.stringify(o);
const sessionText = (turns, { runTeam = true } = {}) => [
  line({ type: "session", timestamp: iso(T0) }),
  line({ type: "message", timestamp: iso(T0 + 1000), message: { role: "user", content: [{ type: "text", text: runTeam ? "/skill:run-team 2 5" : "hello" }] } }),
  ...turns.map(([t, w]) => line({ type: "message", timestamp: iso(t), message: { role: "assistant", content: [], usage: { cacheWrite: w } } })),
].join("\n") + "\n";

test("scanSession: first and last timestamp, the /run-team marker, and assistant cacheWrite per turn", () => {
  const s = G.scanSession(sessionText([[T0 + H, 7], [T0 + 2 * H, 9]]));
  assert.equal(s.start, T0);
  assert.equal(s.end, T0 + 2 * H);
  assert.equal(s.runTeam, true);
  assert.deepEqual(s.turns, [[T0 + H, 7], [T0 + 2 * H, 9]]);
  assert.equal(G.scanSession(sessionText([[T0 + H, 7]], { runTeam: false })).runTeam, false);
  for (const text of ["/run-team 2 5", "/skill:run-team 2 5", "/fleet-ctl:run-team 2 5"]) {
    const t = line({ type: "message", timestamp: iso(T0), message: { role: "user", content: text } });
    assert.equal(G.scanSession(t + "\n").runTeam, true, text);
  }
  const mention = line({ type: "message", timestamp: iso(T0), message: { role: "user", content: [{ type: "text", text: "see /run-team in the docs" }] } });
  assert.equal(G.scanSession(mention + "\n").runTeam, false, "a user turn must BEGIN with the command");
});

test("scanSession counts the lines that are not JSON in `bad` and keeps reading past them", () => {
  assert.equal(G.scanSession(sessionText([[T0 + H, 7]])).bad, 0);
  const s = G.scanSession(sessionText([[T0 + H, 7]]) + "{not json\n\ngarbage\n");
  assert.equal(s.bad, 2, "a blank line is skipped, not counted");
  assert.equal(s.runTeam, true);
  assert.deepEqual(s.turns, [[T0 + H, 7]]);
});

test("readSessions reads the files directly under the directory, never a subagent directory's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-sessions-"));
  const stem = "2026-10-01T00-00-00-000Z_01a0aaaa-0000";
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), sessionText([[T0 + H, 7]]));
  fs.mkdirSync(path.join(dir, stem));
  fs.writeFileSync(path.join(dir, stem, "2026-10-01T00-00-01-000Z_01a0cccc-0000.jsonl"), sessionText([[T0 + H, 1_000_000]]));
  fs.writeFileSync(path.join(dir, "notes.jsonl"), sessionText([[T0 + H, 5]])); // not a session file name
  const sessions = G.readSessions(dir);
  assert.deepEqual(sessions.map((s) => s.stem), [stem]);
  assert.deepEqual(sessions[0].turns, [[T0 + H, 7]]);
  assert.deepEqual(G.readSessions(dir, T0 - H), [], "a session that began after `until` is not read");
});

test("sessionsSpanned counts distinct /run-team sessions holding a window PR's creation", () => {
  const sessions = [
    { stem: "a", runTeam: true, start: T0, end: T0 + 10 * H },
    { stem: "b", runTeam: true, start: T0 + 11 * H, end: T0 + 20 * H },
    { stem: "chat", runTeam: false, start: T0, end: T0 + 20 * H },
    { stem: "c", runTeam: true, start: T0 + 30 * H, end: T0 + 40 * H },
  ];
  const win = [pr(1, T0 + 5 * H), pr(2, T0 + 15 * H), pr(3, T0 + 16 * H)];
  assert.deepEqual(G.sessionsSpanned(win, sessions), ["a", "b"]);
});

test("readReviewStarts: the earliest first timestamp of a PR's top-level review-pr member", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-reviews-"));
  fs.mkdirSync(path.join(dir, "S1", "review-pr-7"), { recursive: true });
  fs.writeFileSync(path.join(dir, "S1", "review-pr-7.jsonl"), `{"type":"title"}\n${line({ type: "session", timestamp: iso(T0 + 5 * MIN) })}\n`);
  fs.writeFileSync(path.join(dir, "S1", "review-pr-7-2.jsonl"), `${line({ type: "session", timestamp: iso(T0 + 50 * MIN) })}\n`);
  fs.writeFileSync(path.join(dir, "S1", "review-pr-7", "review-pr-7.verifyxpr7.jsonl"), `${line({ type: "session", timestamp: iso(T0) })}\n`);
  const rows = [
    memberRow({ agent: "review-pr-7" }), memberRow({ agent: "review-pr-7-2" }),
    memberRow({ agent: "review-pr-7/review-pr-7.verifyxpr7" }), // a nested fan-out member is not the review workflow
    memberRow({ agent: "review-pr-8" }), // no transcript on disk
    memberRow({ agent: "review-pr-9", harness: "claude" }),
  ];
  const starts = G.readReviewStarts(rows, dir, new Set([7, 8, 9]));
  assert.deepEqual([...starts], [[7, T0 + 5 * MIN]]);
});

// -------------------------------------------------------- GitHub read ----

test("readPulls pages until a page crosses --after with enough PRs before the merge, and no further", () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ number: 250 - i, created_at: iso(T0 + (250 - i) * H), merged_at: iso(T0 + (251 - i) * H) }));
  const calls = [];
  const listPage = (q, page) => { calls.push(page); return all.slice((page - 1) * 100, page * 100); };
  const after = T0 + 120 * H, merge = T0 + 240 * H;
  const r = G.readPulls(listPage, "q", { after, merge, n: 20 });
  assert.deepEqual(calls, [1, 2], "page 2 ends below --after (created #150 → #51 hours); page 3 is not needed");
  assert.equal(r.seen.length, 200);
  assert.equal(r.ended, false);
});

test("readPulls keeps paging a full last page and ends only on a short one", () => {
  const all = Array.from({ length: 200 }, (_, i) => ({ number: 200 - i, created_at: iso(T0 + (200 - i) * H), merged_at: iso(T0 + (201 - i) * H) }));
  const calls = [];
  const listPage = (q, page) => { calls.push(page); return all.slice((page - 1) * 100, page * 100); };
  const r = G.readPulls(listPage, "q", { after: T0 - 1000 * H, merge: T0 + 999 * H, n: 20 });
  assert.deepEqual(calls, [1, 2, 3], "page 2 is exactly per_page long, so page 3 is asked for; it is empty and ends the listing");
  assert.equal(r.ended, true);
});

test("listingReads: the earliest and latest read of the query's pages; staleWarning: a page read before the cutover or over a day ago", () => {
  const q = "repos/o/r/pulls?state=closed";
  const reads = new Map([[`${q}&per_page=100&page=2`, "2026-10-02T00:00:00.000Z"], [`${q}&per_page=100&page=1`, "2026-10-01T00:00:00.000Z"], ["repos/o/r/other", "2020-01-01T00:00:00.000Z"]]);
  assert.deepEqual(G.listingReads(reads, q), { first: "2026-10-01T00:00:00.000Z", last: "2026-10-02T00:00:00.000Z" });
  assert.equal(G.listingReads(new Map(), q), null);
  const r = { first: "2026-10-01T00:00:00.000Z", last: "2026-10-02T00:00:00.000Z" };
  const at = Date.parse(r.first);
  assert.equal(G.staleWarning(null, { now: at, cutover: at }), null);
  assert.match(G.staleWarning(r, { now: at + H, cutover: at + 1 }), /before --cutover 2026-10-01T00:00:00\.001Z/);
  assert.equal(G.staleWarning(r, { now: at + H, cutover: at }), null, "a page read at the cutover instant is not before it");
  assert.equal(G.staleWarning(r, { now: at + 24 * H }), null, "exactly a day is not over a day");
  assert.match(G.staleWarning(r, { now: at + 24 * H + 1 }), /a cached listing page was read at 2026-10-01T00:00:00\.000Z/);
});

// ------------------------------------------------------------------ CLI ----

/** A stub `gh` that answers `auth status` and serves pages of a fixture, logging each call. */
function stubGh(dir, pages) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fixture = path.join(dir, "pages.json"), log = path.join(dir, "gh.log");
  fs.writeFileSync(fixture, JSON.stringify(pages));
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] === "auth") process.exit(0);
if (a[0] === "api") {
  const pages = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
  const m = /[?&]page=(\\d+)/.exec(a[1]);
  process.stdout.write(JSON.stringify(Array.isArray(pages) ? pages[Number(m[1]) - 1] ?? [] : pages));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  return { bin, log };
}

const MEMBER_HEADER = "# synthetic member-outcomes\n";
const tsvRow = (r) => [r.session, "2026-10-01", r.role, r.member, "m", "high", r.ticket ?? "", r.pr ?? "", r.cache, "0", "0", "0", r.agent, "omp", "", "-", "", "", "", "1", "", "", ""].join("\t");

/**
 * One synthetic world: PR i (0-based) is created at T0 + i h as #(100+i), merged
 * `cycleOf(i)` later; every PR has a review-pr row (1000 cache tokens) and a
 * review transcript starting two minutes after creation; the controller writes
 * an assistant turn (10 cacheWrite) every hour, in one `/run-team` session
 * before hour `split` and a second from it on.
 */
function world({ total = 160, cycleOf = () => 30 * MIN, split = 120, rows = true, nonArray = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-world-"));
  const prs = Array.from({ length: total }, (_, i) => ({
    number: 100 + i, created_at: iso(T0 + i * H), merged_at: iso(T0 + i * H + cycleOf(i)), body: `Closes #${i}`,
  }));
  prs.push({ number: 5000, created_at: iso(T0 + 105 * H + 1000), merged_at: null, body: "" }); // closed unmerged
  prs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const pages = [];
  for (let i = 0; i < prs.length; i += 100) pages.push(prs.slice(i, i + 100));
  const gh = stubGh(dir, nonArray ? { not: "an array" } : pages);

  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(path.join(sessions, "S1"), { recursive: true });
  const turn = (i) => line({ type: "message", timestamp: iso(T0 + i * H), message: { role: "assistant", content: [], usage: { cacheWrite: 10 } } });
  const user = (t) => line({ type: "message", timestamp: iso(t), message: { role: "user", content: [{ type: "text", text: "/skill:run-team 2 5" }] } });
  const cut = Math.min(split, total);
  const a = [line({ type: "session", timestamp: iso(T0) }), user(T0 + 1000), ...Array.from({ length: cut }, (_, i) => turn(i))];
  fs.writeFileSync(path.join(sessions, "2026-10-01T00-00-00-000Z_01a0aaaa-0000.jsonl"), a.join("\n") + "\n");
  if (cut < total) {
    const startB = T0 + cut * H;
    const b = [line({ type: "session", timestamp: iso(startB) }), user(startB + 1000), ...Array.from({ length: total - cut }, (_, i) => turn(cut + i))];
    fs.writeFileSync(path.join(sessions, `${iso(startB).replace(/[:.]/g, "-")}_01a0bbbb-0000.jsonl`), b.join("\n") + "\n");
  }
  const tsv = path.join(dir, "member-outcomes.tsv");
  const out = [];
  for (let i = 0; i < total; i++) {
    const n = 100 + i;
    out.push(tsvRow({ session: "S1", role: "reviewer", member: `review-pr-${n}`, agent: `review-pr-${n}`, cache: "1000" }));
    fs.writeFileSync(path.join(sessions, "S1", `review-pr-${n}.jsonl`), line({ type: "session", timestamp: iso(T0 + i * H + 2 * MIN) }) + "\n");
  }
  fs.writeFileSync(tsv, MEMBER_HEADER + (rows ? out.join("\n") + "\n" : ""));
  return { dir, gh, sessions, tsv };
}

const MERGE = iso(T0 + 100.5 * H), CUTOVER = iso(T0 + 110 * H);

function run(w, args, env = {}) {
  const jsonFile = path.join(w.dir, "report.json");
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--after", iso(T0), "--cache", path.join(w.dir, "cache"),
    "--member-outcomes", w.tsv, "--sessions", w.sessions, "--json", jsonFile], {
    encoding: "utf8", env: { ...process.env, PATH: `${w.gh.bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  const json = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, "utf8")).report : null;
  return { ...r, json };
}

test("CLI: a flat series exits 0, prints both windows, six ratios and six `ok` verdicts, and reads only the pulls listing", () => {
  const w = world();
  const r = run(w, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.tripped, []);
  assert.deepEqual(r.json.verdicts.map((v) => v.verdict), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(r.json.verdicts.map((v) => v.ratio), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(r.json.pre.values, { 1: 1000, 2: 10, "3a": 30 * MIN, "3b": 1, "4a": 2 * MIN, "4b": 2 * MIN });
  assert.deepEqual(r.json.post.values, r.json.pre.values);
  assert.deepEqual(r.json.pre.numbers, [181, 200]);
  assert.deepEqual(r.json.post.numbers, [210, 229]);
  assert.equal(r.json.post.run_team_sessions.length, 2);
  assert.equal(r.json.history.pairs, 13);
  assert.match(r.stdout, /pre: 20 merged PRs, #181–#200, created 2026-10-04T09:00:00Z → 2026-10-05T04:00:00Z/);
  assert.match(r.stdout, /post: 20 merged PRs, #210–#229, created 2026-10-05T14:00:00Z → 2026-10-06T09:00:00Z/);
  assert.match(r.stdout, /The post window spans 2 `\/run-team` session\(s\)/);
  assert.match(r.stdout, /tripped: none/);
  assert.equal((r.stdout.match(/\bok$/gm) ?? []).length, 6);
  const calls = fs.readFileSync(w.gh.log, "utf8").trim().split("\n");
  assert.ok(calls.every((c) => c === "auth status" || c.startsWith("api repos/feigi/fleet-plugin/pulls?state=closed")), calls.join("\n"));
});

test("CLI: the report names when the listing was read, and warns on stderr when a cached page predates --cutover or is a day old", () => {
  const w = world();
  const fresh = run(w, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  assert.match(fresh.stdout, /read from GitHub 20\d\d-\d\d-\d\dT[\d:.]+Z/);
  assert.doesNotMatch(fresh.stderr, /WARNING/);
  const cacheDir = path.join(w.dir, "cache", "feigi__fleet-plugin");
  const files = fs.readdirSync(cacheDir);
  assert.ok(files.length > 0, "the first run cached its pages");
  for (const f of files) {
    const file = path.join(cacheDir, f);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), fetchedAt: "2026-09-01T00:00:00.000Z" }));
  }
  const beforeCutover = run(w, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(beforeCutover.status, 0, beforeCutover.stderr + beforeCutover.stdout);
  assert.match(beforeCutover.stderr, /WARNING: a listing page was read at 2026-09-01T00:00:00\.000Z, before --cutover/);
  assert.match(beforeCutover.stdout, /read from GitHub 2026-09-01T00:00:00\.000Z/);
  const dayOld = run(w, ["--merge", MERGE]);
  assert.equal(dayOld.status, 0, dayOld.stderr + dayOld.stdout);
  assert.match(dayOld.stderr, /WARNING: a cached listing page was read at 2026-09-01T00:00:00\.000Z/);
});

test("CLI: the Source line counts the transcript lines that did not parse", () => {
  const w = world();
  assert.match(run(w, ["--merge", MERGE, "--cutover", CUTOVER]).stdout, /\b0 unparseable transcript line\(s\) skipped/);
  fs.appendFileSync(path.join(w.sessions, "2026-10-01T00-00-00-000Z_01a0aaaa-0000.jsonl"), "{not json\ngarbage\n");
  assert.match(run(w, ["--merge", MERGE, "--cutover", CUTOVER]).stdout, /\b2 unparseable transcript line\(s\) skipped/);
});

test("CLI: a page longer than per_page is an input error, exit 2, never read as a list", () => {
  const w = world();
  fs.writeFileSync(path.join(w.dir, "pages.json"), JSON.stringify([Array.from({ length: 101 }, (_, i) => ({ number: i + 1, created_at: iso(T0 + i * H), merged_at: iso(T0 + i * H + 30 * MIN), body: "" }))]));
  const r = run(w, ["--merge", MERGE]);
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /101 items on a per_page=100 page/);
});

test("CLI: PRs created between the merge and the cutover are in neither window, whatever they look like", () => {
  const odd = (i) => (i > 100 && i < 110 ? 100 * H : 30 * MIN);
  const w = world({ cycleOf: odd });
  const r = run(w, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const inWindows = new Set([...r.json.pre.prs, ...r.json.post.prs]);
  for (let n = 201; n <= 209; n++) assert.ok(!inWindows.has(n), `#${n} is in a window`);
  assert.deepEqual(r.json.verdicts.map((v) => v.verdict), ["ok", "ok", "ok", "ok", "ok", "ok"]);
});

test("CLI: a post window that cycles slower and merges less trips 3a and 3b and exits 3, naming each", () => {
  const w = world({ cycleOf: (i) => (i >= 110 ? 4 * H : 30 * MIN) });
  const r = run(w, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.deepEqual(r.json.tripped, ["3a", "3b"]);
  assert.equal(r.json.verdicts.find((v) => v.id === "3a").ratio, 8);
  assert.match(r.stdout, /tripped: 3a 3b/);
  assert.match(r.stdout, /Then \(3a\): re-run docs\/research\/in-flight-cycle-time-stages-derive\.mjs on both windows/);
  assert.match(r.stdout, /Then \(3b\): the default bound first/);
});

test("CLI: a trip read under a withheld verdict is printed, and the exit stays 4", () => {
  const r = run(world({ total: 129, cycleOf: (i) => (i >= 110 ? 4 * H : 30 * MIN) }), ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.ok(r.json.tripped.includes("3a"));
  assert.match(r.stdout, /tripped: 3a/);
});

test("CLI: a 19-PR post window has no verdict and exits 4; 20 PRs are enough", () => {
  const short = world({ total: 129 });
  const r = run(short, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.equal(r.json.post.n, 19);
  assert.match(r.stdout, /the post window holds 19 merged PRs, fewer than 20/);
  const exact = run(world({ total: 130 }), ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(exact.status, 0, exact.stderr + exact.stdout);
  assert.equal(exact.json.post.n, 20);
});

test("CLI: a post window inside one /run-team session has no verdict and exits 4", () => {
  const r = run(world({ split: 1000 }), ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.deepEqual(r.json.post.run_team_sessions.length, 1);
  assert.match(r.stdout, /spans 1 \/run-team session\(s\), fewer than 2/);
});

test("CLI: member-outcomes.tsv without rows leaves signals 1 and 4 unread and exits 4", () => {
  const r = run(world({ rows: false }), ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 4, r.stderr + r.stdout);
  const none = r.json.verdicts.filter((v) => v.verdict === "none").map((v) => v.id);
  assert.deepEqual(none, ["1", "4a", "4b"]);
  assert.match(r.stdout, /test 1 has no reading/);
});

test("CLI: --merge alone prints the six bands, no windows and no verdict, and exits 0", () => {
  const r = run(world(), ["--merge", MERGE]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.json.history.pairs, 13);
  assert.deepEqual(Object.values(r.json.bands), [1, 1, 1, 1, 1, 1]);
  assert.match(r.stdout, /3a +cycle time created→merged, median +13 +above +p90 ×1\.00/);
  assert.match(r.stdout, /3b +merged PRs per active clock hour +13 +below +p10 ×1\.00/);
  for (const id of ["1", "2", "4a", "4b"]) assert.match(r.stdout, new RegExp(`^${id} .* ×1\\.00`, "m"));
  assert.doesNotMatch(r.stdout, /## Windows|## Verdicts/);
  assert.equal(r.json.pre, null);
});

test("CLI: input errors exit 2 and print no verdict", () => {
  const w = world();
  const refused = path.join(ROOT, `.guard-test-cache-${process.pid}`);
  const cases = [
    [["--merge", "yesterday"], /--merge must be an ISO-8601 instant/],
    [["--merge", MERGE, "--cutover", "2026-10-01"], /--cutover must be an ISO-8601 instant/],
    [["--merge", MERGE, "--cutover", iso(T0 + 50 * H)], /--cutover is before --merge/],
    [[], /--merge <ISO> is required/],
    [["--merge", MERGE, "--bogus"], /unknown flag --bogus/],
    [["--merge", MERGE, "--n", "0"], /--n must be a positive integer/],
    [["--merge", MERGE, "--offset", "21"], /--offset must be between 1 and --n/],
    [["--merge", MERGE, "--cache", refused], /inside the git checkout/],
  ];
  try {
    for (const [args, re] of cases) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args, ...(args.includes("--cache") ? [] : ["--cache", path.join(w.dir, "cache")]), "--member-outcomes", w.tsv, "--sessions", w.sessions], {
        encoding: "utf8", env: { ...process.env, PATH: `${w.gh.bin}${path.delimiter}${process.env.PATH}` },
      });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}${r.stdout}`);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stdout, /Verdicts/);
    }
    assert.ok(!fs.existsSync(refused), "a refused cache is not created");
  } finally {
    fs.rmSync(refused, { recursive: true, force: true });
  }
});

test("CLI: an untrusted GitHub page (not an array) is an input error, exit 2", () => {
  const w = world({ nonArray: true });
  const r = run(w, ["--merge", MERGE, "--cutover", CUTOVER]);
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /expected a JSON array/);
  assert.equal(r.stdout, "");
});

test("CLI: a --sessions directory that does not exist is an input error when named", () => {
  const w = world();
  const r = spawnSync(process.execPath, [SCRIPT, "--merge", MERGE, "--sessions", path.join(w.dir, "nope"), "--member-outcomes", w.tsv, "--cache", path.join(w.dir, "cache")], {
    encoding: "utf8", env: { ...process.env, PATH: `${w.gh.bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such directory/);
});

test("the header names where the cutover comes from and each signal's Then remedy", () => {
  const head = fs.readFileSync(SCRIPT, "utf8").split("\n").filter((l) => l.startsWith("//"))
    .map((l) => l.replace(/^\/\/ ?/, "")).join(" ").replace(/\s+/g, " ");
  assert.match(head, /The cutover is the first timestamp in the omp session file of the first `\/run-team` whose phase-0 pin includes the merge/);
  assert.match(head, /jq -r 'select\(\.timestamp != null\) \| \.timestamp' <file> \| head -1/);
  const remedies = [
    "the default bound first (at B = 5, 68 % of past Pulls would have been held), then the definition of In flight",
    "re-run docs/research/in-flight-cycle-time-stages- derive.mjs on both windows",
    "A rise in Claim → open, open → review evidence, or evidence → label revisits the default bound",
    "the default bound first (it is the load lever), then ADR 0012's existing order: merges per pass, then the bot's brief size",
    "unchanged: the per-Pull prompt",
    "the reviewer row's uncapped dispatch first (decision 5), then the operator's `task.maxConcurrency`",
  ];
  for (const phrase of remedies) assert.ok(head.includes(phrase), phrase);
  // The printed Then lines come from the same table, so each test carries one.
  for (const t of G.TESTS) assert.ok(t.then.length > 20, t.id);
});
