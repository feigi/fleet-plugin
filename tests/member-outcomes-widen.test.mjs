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
  assert.equal(refresh(w.repo).status, 0);
  assert.equal(w.text(), COMMENTS);
  const none = workspace(null);
  const r = refresh(none.repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(none.file), false);
});

const row20 = tsvAt(20, ROWS.slice(0, 1)).slice(COMMENTS.length).trimEnd();
const rowNow = tsvAt(COLUMNS.length, ROWS.slice(0, 1)).slice(COMMENTS.length).trimEnd();
for (const [why, body, named] of [
  ["a row one cell wider than the current width", `${rowNow}\tx\n`, new RegExp(`${COLUMNS.length + 1} fields`)],
  ["a row too short to be any known width", "short\trow\n", /2 fields/],
  ["git conflict markers", `<<<<<<< HEAD\n${row20}\n=======\n${row20}\n>>>>>>> main\n`, /git conflict marker/],
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
