// #3886: a consumer's docs/metrics/member-outcomes.tsv written before the
// `ending`, `dispatch_model` and `work_s` columns shipped is widened to the
// current width by metrics-refresh.mjs at the next run start. parseTsv refuses
// any row not exactly COLUMNS.length wide, so without the widen the file kills
// phase 0, the close-out scrape and `tier-outcomes append`. Driven through the
// CLIs, because the refusals and the exit statuses are observable only there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { COLUMNS, isImplementer, parseTsv } from "../plugin/scripts/member-outcomes.mjs";
import { REPORT_STATUSES, reportStatus } from "../plugin/scripts/report-files.mjs";
import { prUrl, ref } from "./support/queue-gh.mjs";

const REFRESH = fileURLToPath(new URL("../plugin/scripts/metrics-refresh.mjs", import.meta.url));
const SCRAPE = fileURLToPath(new URL("../plugin/scripts/member-outcomes.mjs", import.meta.url));
const TIER = fileURLToPath(new URL("../plugin/scripts/tier-outcomes.mjs", import.meta.url));
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const MEMBERS = join("docs", "metrics", "member-outcomes.tsv");
const COMMENTS = "# One row per dispatched fleet member.\n#\n# NEVER hand-edit a row.\n\n# a second paragraph\n";
const WIDTHS = { before_ending: COLUMNS.indexOf("ending"), before_dispatch_model: COLUMNS.indexOf("dispatch_model"), before_work_s: COLUMNS.indexOf("work_s") };

const full = (o) => {
  const r = Object.fromEntries(COLUMNS.map((c) => [c, ""]));
  return Object.assign(r, { session: SESSION, run_date: "2026-10-03", role: "implementer", model: "claude-opus-5", harness: "omp", cost: "0.5", ...o });
};
const ROWS = [
  full({ member: "impl-10", ticket: "10", pr: "15", agent: "impl-10", subagent_type: "fleet-implementer", ending: "pr", dispatch_model: "claude-opus-5", work_s: "300" }),
  full({ member: "review-pr-15", role: "reviewer", pr: "15", agent: "review-pr-15", ending: "", dispatch_model: "claude-opus-5", work_s: "60" }),
  full({ member: "impl-11-b", ticket: "11", agent: "impl-11-b", ending: "bail:fixed", dispatch_model: "claude-opus-5", work_s: "" }),
];

// `rows` written at `width` columns, the first `width` of COLUMNS, as a consumer's copy was.
const tsvAt = (width, rows = ROWS, comments = COMMENTS) =>
  comments + rows.map((r) => COLUMNS.slice(0, width).map((c) => r[c]).join("\t")).join("\n") + "\n";

function workspace(text) {
  const repo = tempDir("member-widen-");
  mkdirSync(join(repo, "docs", "metrics"), { recursive: true });
  const file = join(repo, MEMBERS);
  if (text !== null) writeFileSync(file, text);
  return { repo, file, text: () => readFileSync(file, "utf8") };
}
const refresh = (repo) => spawnSync(process.execPath, [REFRESH, "--repo", repo], { encoding: "utf8" });
const dataLines = (text) => text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));

for (const width of [20, 21, 22]) {
  test(`a ${width}-column file ends ${COLUMNS.length} wide, its old cells and leading comments unchanged`, () => {
    const w = workspace(tsvAt(width));
    const r = refresh(w.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`metrics-refresh: member-outcomes: widened 3 rows from ${width} to ${COLUMNS.length} columns`));
    const out = w.text();
    assert.ok(out.startsWith(COMMENTS), "the leading comments are kept verbatim");
    const rows = parseTsv(out);
    assert.equal(rows.length, ROWS.length);
    dataLines(out).forEach((l, i) => {
      const old = COLUMNS.slice(0, width).map((c) => ROWS[i][c]);
      assert.equal(l.split("\t").length, COLUMNS.length);
      assert.deepEqual(l.split("\t").slice(0, width), old, "every cell the file already held is unchanged");
    });
    // Added cells: blank where blank means unknown; `ending` is `unknown` on an implementer.
    for (const c of COLUMNS.slice(width)) {
      const cells = dataLines(out).map((l) => l.split("\t")[COLUMNS.indexOf(c)]);
      assert.deepEqual(cells, ROWS.map((r) => (c === "ending" && isImplementer(r.member) ? "unknown" : "")), `added column ${c}`);
    }
  });
}

test("a 20-column file's implementer rows read ending `unknown`, never blank; a non-implementer's stays blank", () => {
  const w = workspace(tsvAt(WIDTHS.before_ending));
  assert.equal(refresh(w.repo).status, 0);
  const by = Object.fromEntries(parseTsv(w.text()).map((r) => [r.member, r.ending]));
  assert.deepEqual(by, { "impl-10": "unknown", "review-pr-15": "", "impl-11-b": "unknown" });
});

test("a file already at the current width is left byte for byte, and a second run changes nothing", () => {
  const current = tsvAt(COLUMNS.length);
  const w = workspace(current);
  const r = refresh(w.repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`member-outcomes: already ${COLUMNS.length} columns`));
  assert.equal(w.text(), current);

  const older = workspace(tsvAt(20));
  const first = refresh(older.repo);
  assert.equal(first.status, 0, first.stderr);
  const once = older.text();
  const again = refresh(older.repo);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(older.text(), once);
  assert.match(again.stdout, new RegExp(`member-outcomes: already ${COLUMNS.length} columns`));
});

test("a file with comments only, and a workspace with no file, are left alone", () => {
  const w = workspace(COMMENTS);
  const c = refresh(w.repo);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /metrics-refresh: member-outcomes: no rows to widen/);
  assert.equal(w.text(), COMMENTS);
  const none = workspace(null);
  const r = refresh(none.repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(none.file), false);
});

test("a CRLF file widens with each row's CR kept as its last byte, after the cells it gains", () => {
  const lf = workspace(tsvAt(20));
  assert.equal(refresh(lf.repo).status, 0);
  const w = workspace(tsvAt(20).replace(/\n/g, "\r\n"));
  const r = refresh(w.repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`widened 3 rows from 20 to ${COLUMNS.length} columns`));
  assert.equal(w.text(), lf.text().replace(/\n/g, "\r\n"));
});

const row20 = tsvAt(20, ROWS.slice(0, 1)).slice(COMMENTS.length).trimEnd();
const rowNow = tsvAt(COLUMNS.length, ROWS.slice(0, 1)).slice(COMMENTS.length).trimEnd();
for (const [why, body, named] of [
  ["a row one cell wider than the current width", `${rowNow}\tx\n`, new RegExp(`${COLUMNS.length + 1} fields`)],
  ["a row too short to be any known width", "short\trow\n", /2 fields/],
  ["git conflict markers", `<<<<<<< HEAD\n${row20}\n=======\n${row20}\n>>>>>>> main\n`, /git conflict marker/],
  ["a bare `=======` git conflict marker", `${row20}\n=======\n${row20}\n`, /git conflict marker/],
  ["a `<<<<<<<` git conflict marker with nothing after it", `<<<<<<<\n${row20}\n`, /git conflict marker/],
  ["a bare `=======` git conflict marker in a CRLF file", `${row20}\r\n=======\r\n${row20}\r\n`, /git conflict marker/],
  ["rows of two different known widths", `${row20}\n${rowNow}\n`, new RegExp(`different widths \\(20, ${COLUMNS.length}\\)`)],
  ["a tab inside a cell, which makes its row one cell too wide", `${row20}\n${row20.replace("claude-opus-5", "claude\topus-5")}\n`, /different widths \(20, 21\)/],
]) {
  test(`${why} fails the widen with a named error and leaves the file as it was`, () => {
    const text = COMMENTS + body;
    const w = workspace(text);
    const r = refresh(w.repo);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /metrics-refresh: member-outcomes failed: docs\/metrics\/member-outcomes\.tsv: /);
    assert.match(r.stderr, named);
    assert.equal(w.text(), text);
    assert.equal(existsSync(`${w.file}.tmp`), false);
  });
}

// #3923: a tab inside a cell on EVERY row (or the only one) passes the
// one-width check, and the file looks one column wider than it is. The widen
// checks each row against the grammar of the columns at that width, and the
// cells a tab shifts break it: `agent` lands in `harness`, `cost` in `ending`,
// the second half of `session` in `run_date`.
const tabbed = (r) => ({ ...r, model: "claude\topus-5" });
for (const [why, text, column] of [
  ["case A: a 20-column file whose every row has a tab inside `model`", tsvAt(20, ROWS.slice(0, 2).map(tabbed)), "harness"],
  ["case B: one 20-column reviewer row with a blank `cost` and a tab inside `model`", tsvAt(20, [tabbed({ ...ROWS[1], cost: "" })]), "harness"],
  ["case C: a 21-column file whose every row has a tab inside `model`", tsvAt(21, ROWS.slice(0, 2).map(tabbed)), "harness"],
  ["a 20-column row whose last cell, `cost`, has a tab inside it", tsvAt(20, [{ ...ROWS[0], cost: "0.5\tx" }]), "ending"],
  ["a 20-column reviewer row whose last cell, `cost`, has a tab inside it", tsvAt(20, [{ ...ROWS[1], cost: "0.5\tx" }]), "ending"],
  ["a 20-column row with a tab inside `session`", tsvAt(20, [{ ...ROWS[0], session: SESSION.replace("_", "\t") }]), "run_date"],
  ["a 20-column row with a tab inside `model` and a filled `report`, which breaks a later column too", tsvAt(20, [tabbed({ ...ROWS[0], report: "ok" })]), "harness"],
]) {
  test(`${why} fails the widen, naming ${column}, and leaves the file as it was`, () => refusesNaming(text, column));
}

// The refused row is the file's first data row in every case here, so the
// error names its line in the file, counted from 1 with the comments.
function refusesNaming(text, column) {
  const w = workspace(text);
  const r = refresh(w.repo);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /metrics-refresh: member-outcomes failed: docs\/metrics\/member-outcomes\.tsv: /);
  const line = text.split("\n").findIndex((l) => l.trim() && !l.startsWith("#")) + 1;
  assert.match(r.stderr, new RegExp(`: line ${line}: \`${column}\` is `));
  assert.match(r.stderr, /tab inside a cell/);
  assert.doesNotMatch(r.stdout, /widened/);
  assert.equal(w.text(), text);
  assert.equal(existsSync(`${w.file}.tmp`), false);
}

// Each rule of the grammar refuses on its own: one row, one cell that breaks
// its column's rule — the shape a hand edit leaves — and every other cell
// fitting, so the column the error names is that cell's.
for (const [why, width, row, column] of [
  ["a `run_date` that only starts with a date", 20, { ...ROWS[0], run_date: "2026-10-03x" }, "run_date"],
  ["a negative token count", 20, { ...ROWS[0], tokens_out: "-1" }, "tokens_out"],
  ["a `turns` with trailing garbage", 20, { ...ROWS[0], turns: "9x" }, "turns"],
  ["a `tokens_in` with trailing whitespace", 20, { ...ROWS[0], tokens_in: "100 " }, "tokens_in"],
  ["a `harness` other than omp or claude", 20, { ...ROWS[0], harness: "x" }, "harness"],
  ["a `report` that no reportStatus() returns", 20, { ...ROWS[0], report: "bogus" }, "report"],
  ["an implementer row with a blank `ending`", 21, { ...ROWS[0], ending: "" }, "ending"],
  ["a reviewer row with a non-blank `ending`", 21, { ...ROWS[1], ending: "pr" }, "ending"],
]) {
  test(`a ${width}-column row with ${why} fails the widen, naming ${column}, and leaves the file as it was`, () => refusesNaming(tsvAt(width, [row]), column));
}

// The widen refuses a `report` cell outside REPORT_STATUSES, so the list must
// be exactly what reportStatus() can return: each `state: "…"` readAt() and
// readReportIn() return, and reportStatus()'s own literal. A state added or
// dropped there without REPORT_STATUSES following fails here.
test("REPORT_STATUSES is every value reportStatus() returns, and nothing else", () => {
  const src = readFileSync(new URL("../plugin/scripts/report-files.mjs", import.meta.url), "utf8");
  const body = (sig) => src.slice(src.indexOf(sig), src.indexOf("\n}\n", src.indexOf(sig)));
  const states = ["function readAt(", "export function readReportIn("].flatMap((sig) => [...body(sig).matchAll(/state: "([^"]*)"/g)].map((m) => m[1]));
  const own = [...body("export function reportStatus(").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(states.includes("absent") && own.includes("-"), "the scan reads readAt()'s and reportStatus()'s own returns");
  assert.deepEqual([...REPORT_STATUSES].sort(), [...new Set([...states, ...own])].sort());

  const scratch = tempDir("report-statuses-");
  mkdirSync(join(scratch, "reports"));
  writeFileSync(join(scratch, "reports", "impl-20.json"), "not json");
  writeFileSync(join(scratch, "reports", "impl-21.json"), JSON.stringify({
    member: "impl-21", outcome: "bailed", pr: null, head: null, branch: "implementer/impl-21",
    sizing: null, bailCause: "undecided", bailDetail: "needs a human line", confirmation: [],
  }));
  const seen = ["Explore", "impl-19", "impl-20", "impl-21"].map((m) => reportStatus(scratch, m));
  assert.deepEqual(seen, ["-", "absent", "invalid", "ok"]);
});

// What the check must ACCEPT: every column it reads, at each width, filled
// the ways a real file fills it, in a CRLF file, whose last cell ends in `\r`.
for (const width of [20, 21, 22]) {
  test(`a ${width}-column CRLF file whose rows fit the grammar still widens, its last cell's CR not refused`, () => {
    const rows = [
      ...ROWS,
      full({ member: "fix-pr-6", role: "fix-applier", agent: "fix-pr-6", harness: "claude", report: "ok", tokens_cache_create: "12", tokens_out: "3400", wall_s: "61.5", turns: "9", tokens_in: "100", tokens_cache_read: "2000", tokens_cache_write_1h: "0", cost: "0.012345", work_s: "45" }),
      full({ member: "merge-bot-7", role: "merge-bot", agent: "merge-bot-7", report: "absent", cost: "" }),
      full({ member: "Explore", role: "other", agent: "explore-1", report: "-" }),
      full({ member: "impl-12", ticket: "12", agent: "impl-12", report: "invalid", ending: "bail:fixed-refuted" }),
      full({ member: "impl-13", ticket: "13", agent: "impl-13", run_date: "", ending: "pr" }),
    ];
    const w = workspace(tsvAt(width, rows).replace(/\n/g, "\r\n"));
    const r = refresh(w.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`widened ${rows.length} rows from ${width} to ${COLUMNS.length} columns`));
  });
}

test("the widen runs before the cost guard, so a corpus it cannot read stops the run there", () => {
  const w = workspace("short\trow\n");
  writeFileSync(join(w.repo, "docs", "metrics", "tier-outcomes.tsv"), "");
  writeFileSync(join(w.repo, "docs", "metrics", "ticket-features.tsv"), "");
  const r = refresh(w.repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /member-outcomes failed/);
  assert.doesNotMatch(r.stderr, /cost guard/);
  assert.equal(existsSync(join(w.repo, ".fleet", "cost-guard.json")), false);
});

test("the drain runs before the widen, so a member-outcomes file it cannot read stops the run after the drain", () => {
  const w = workspace("short\trow\n");
  const pending = join(w.repo, ".fleet", "ticket-features.pending.tsv");
  mkdirSync(join(w.repo, ".fleet"), { recursive: true });
  writeFileSync(pending, "");
  const r = refresh(w.repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /metrics-refresh: drain: .*ticket-features\.pending\.tsv was empty — removed/);
  assert.match(r.stderr, /member-outcomes failed/);
  assert.equal(existsSync(pending), false);
});

for (const width of [20, 21, 22]) {
  test(`after the widen from ${width} columns, member-outcomes.mjs on an empty session dir and tier-outcomes.mjs append succeed`, () => {
    const w = workspace(tsvAt(width));
    assert.equal(refresh(w.repo).status, 0);

    const scratch = tempDir("member-widen-scratch-");
    const sessions = tempDir("member-widen-sessions-");
    const dir = join(sessions, SESSION);
    mkdirSync(dir);
    const scrape = spawnSync(process.execPath, [SCRAPE, dir, "--file", w.file, "--scratch", scratch], { encoding: "utf8" });
    assert.equal(scrape.status, 0, scrape.stderr);
    assert.equal(parseTsv(w.text()).length, ROWS.length, "an empty session replaces nothing");

    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeExecStub(join(bin, "gh"), `#!/bin/sh\nif [ "$5" = state ]; then printf '{"state":"MERGED"}\\n'; exit 0; fi\nprintf '%s\\n' '{"closingIssuesReferences":${JSON.stringify([ref(10)])},"url":"${prUrl("")}'"$3"'"}'\n`);
    const tier = join(scratch, "tier-outcomes.tsv");
    writeFileSync(tier, "");
    const append = spawnSync(process.execPath, [TIER, "append", "15", "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--note", "n", "--scratch", scratch, "--file", tier, "--member-outcomes", w.file, "--ledger", join(scratch, "ledger.md")], {
      encoding: "utf8", cwd: scratch, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(append.status, 0, append.stderr);
    assert.equal(dataLines(readFileSync(tier, "utf8")).length, 1);
  });
}
