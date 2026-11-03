// cell-readout.mjs: the per-cell gate over ticket-features.tsv joined to
// member-outcomes.tsv, run as the CLI against synthetic fixture files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { Pin } from "./support/prose-pin.mjs";
import { COLUMNS, formatTsv } from "../plugin/scripts/member-outcomes.mjs";
import { FEATURE_COLUMNS } from "../plugin/scripts/pull-attribution.mjs";
import * as cellReadout from "../plugin/scripts/cell-readout.mjs";

const { readout, GATE } = cellReadout;
const SCRIPT = fileURLToPath(new URL("../plugin/scripts/cell-readout.mjs", import.meta.url));

// `dispatchModel` defaults to the row's `model`: a member that ran on the model it was dispatched on.
const member = (o) => ({
  run_date: "2026-10-01", role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp", report: "-",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, ending: "hollow", dispatchModel: o.model ?? "claude-opus-5", workS: 0, ...o,
});
const pull = (o) => ({
  run_date: "2026-10-01", policy_cell: "slow-high", exploration_draw: "", sizing_src: "rule", sizing_pre: "",
  router_usd: "", brief_chars: "100", criteria: "1", comments: "0", age_days: "0", paths: "0",
  test_paths: "0", xrefs: "0", kind: "enhancement", ...o,
});

function world() {
  return { features: [], members: [], ticket: 100 };
}
// One implementer Pull at `cell` in `session`, and the member row it left.
// `model`/`effort`/`subagentType` override what resolved and what was dispatched.
function addRow(w, { session, date, cell, model, effort, subagentType, member: withMember = true }) {
  const ticket = String(w.ticket++);
  const agent = `impl-${ticket}`;
  const level = cell.split("-").slice(1).join("-");
  w.features.push(pull({ session, agent, ticket, chosen_cell: cell }));
  if (withMember) {
    w.members.push(member({
      session, agent, run_date: date, ticket,
      model: model ?? (cell.startsWith("slow-") ? "claude-opus-5" : "claude-sonnet-5"),
      effort: effort ?? level, subagentType: subagentType ?? `fleet-implementer-${cell}`,
    }));
  }
}
// `n` sessions, each one comparison for `cell`: a `cell` row beside a slow-high
// row, spread round-robin over `dates` distinct run_dates.
let nextSession = 0;
function addComparisons(w, cell, n, dates, rowOpts = {}) {
  for (let i = 0; i < n; i++) {
    const session = `2026-10-01T00-00-00-000Z_s${nextSession++}`;
    const date = `2026-10-${String(1 + (i % dates)).padStart(2, "0")}`;
    addRow(w, { session, date, cell, ...rowOpts });
    addRow(w, { session, date, cell: "slow-high" });
  }
}

function files(w, cols = FEATURE_COLUMNS) {
  const dir = tempDir("cell-readout-");
  const features = join(dir, "ticket-features.tsv");
  const members = join(dir, "member-outcomes.tsv");
  writeFileSync(features, [cols.join("\t"), ...w.features.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n");
  writeFileSync(members, "# header\n" + formatTsv(w.members));
  return { features, members, dir };
}
function cli(w, extra = [], cols = FEATURE_COLUMNS) {
  const f = files(w, cols);
  return spawnSync(process.execPath, [SCRIPT, "--ticket-features", f.features, "--member-outcomes", f.members, ...extra], { encoding: "utf8", cwd: f.dir });
}
const lineFor = (stdout, cell) => stdout.split("\n").find((l) => l.split(" ")[0] === cell);

test("the gate is ten comparisons across five run_dates: nine across five does not gate, ten across five does", () => {
  const nine = world();
  addComparisons(nine, "task-high", 9, 5);
  const below = cli(nine);
  assert.equal(below.status, 0, below.stderr);
  assert.equal(lineFor(below.stdout, "task-high"), undefined, "a cell below the gate prints no line");
  assert.match(below.stderr, /task-high below the gate: 9 comparisons across 5 run_dates/);

  const ten = world();
  addComparisons(ten, "task-high", 10, 5);
  const at = cli(ten);
  assert.equal(at.status, 0, at.stderr);
  assert.equal(lineFor(at.stdout, "task-high"), "task-high 10 5 claude-sonnet-5");
  assert.doesNotMatch(at.stderr, /task-high below the gate/);
  assert.deepEqual(GATE, { comparisons: 10, runDates: 5 });
});

test("a features corpus with the named-path columns reads out as one without them", () => {
  const w = world();
  addComparisons(w, "task-high", 10, 5);
  w.features = w.features.map((r) => ({ ...r, named_paths: "plugin/a.mjs", named_lines: "3", dirs: "1", title: "a title", plugin_version: "1.2.3" }));
  const named = ["named_paths", "named_lines", "dirs", "title", "plugin_version"];
  const withThem = cli(w);
  assert.equal(withThem.status, 0, withThem.stderr);
  assert.equal(lineFor(withThem.stdout, "task-high"), "task-high 10 5 claude-sonnet-5");
  const without = cli(w, [], FEATURE_COLUMNS.filter((c) => !named.includes(c)));
  assert.deepEqual([without.status, without.stdout, without.stderr], [withThem.status, withThem.stdout, withThem.stderr]);
});

test("ten comparisons across four run_dates does not gate: both halves of the gate bind", () => {
  const w = world();
  addComparisons(w, "task-high", 12, 4);
  const r = cli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lineFor(r.stdout, "task-high"), undefined);
  assert.match(r.stderr, /task-high below the gate: 12 comparisons across 4 run_dates/);
});

test("two resolved models in one cell's gate window print `mixed (...)` with each model's row count", () => {
  const w = world();
  addComparisons(w, "task-high", 7, 5);
  addComparisons(w, "task-high", 3, 3, { model: "claude-opus-5" });
  const r = cli(w);
  assert.equal(r.status, 0, r.stderr);
  // claude-opus-5 at task-high/high still differs from slow-high only if its
  // effort does — it does not, so those three sessions are no comparison.
  assert.match(r.stderr, /task-high below the gate: 7 comparisons across 5 run_dates/);

  const gated = world();
  addComparisons(gated, "task-high", 10, 5);
  addComparisons(gated, "task-high", 2, 1, { model: "claude-haiku-4-5" });
  const g = cli(gated);
  assert.equal(g.status, 0, g.stderr);
  assert.equal(lineFor(g.stdout, "task-high"), "task-high 12 5 mixed (claude-sonnet-5 n=10, claude-haiku-4-5 n=2)");
});

test("a comparison is one session, however many rows it holds, and a row on each side is required", () => {
  const w = world();
  // One session, three task-high rows and two slow-high rows: one comparison.
  addRow(w, { session: "sA", date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: "sA", date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: "sA", date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: "sA", date: "2026-10-01", cell: "slow-high" });
  addRow(w, { session: "sA", date: "2026-10-01", cell: "slow-high" });
  // task-high with no slow-high beside it, and slow-high alone: no comparison.
  addRow(w, { session: "sB", date: "2026-10-02", cell: "task-high" });
  addRow(w, { session: "sC", date: "2026-10-03", cell: "slow-high" });
  // A pair split across two sessions is no comparison either.
  addRow(w, { session: "sD", date: "2026-10-04", cell: "smol-high" });
  addRow(w, { session: "sE", date: "2026-10-04", cell: "slow-high" });
  const [task, smol] = ["task-high", "smol-high"].map((c) => readout(parsed(w)).cells.find((x) => x.cell === c));
  assert.deepEqual([task.comparisons, task.runDates], [1, 1]);
  assert.deepEqual([smol.comparisons, smol.runDates], [0, 0]);
});

test("only admissible rows count: dispatched as the drawn cell's definition, at the cell's level, with a model on record", () => {
  const w = world();
  const s = (n) => `s-adm-${n}`;
  // effort off the cell's level (a clamp): inadmissible
  addRow(w, { session: s(1), date: "2026-10-01", cell: "task-high", effort: "medium" });
  addRow(w, { session: s(1), date: "2026-10-01", cell: "slow-high" });
  // dispatched as a generic task, not the cell's definition: inadmissible
  addRow(w, { session: s(2), date: "2026-10-01", cell: "task-high", subagentType: "task" });
  addRow(w, { session: s(2), date: "2026-10-01", cell: "slow-high" });
  // the slow-high side dispatched as the pre-cutover definition: inadmissible
  addRow(w, { session: s(3), date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: s(3), date: "2026-10-01", cell: "slow-high", subagentType: "fleet-implementer" });
  // the slow-high side has no member row at all: no join, inadmissible
  addRow(w, { session: s(4), date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: s(4), date: "2026-10-01", cell: "slow-high", member: false });
  // blank model on record, at dispatch and on its last turn: unknown, so nothing can differ from it
  addRow(w, { session: s(5), date: "2026-10-01", cell: "task-high", model: "" });
  addRow(w, { session: s(5), date: "2026-10-01", cell: "slow-high" });
  // the control: admissible on both sides
  addRow(w, { session: s(6), date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: s(6), date: "2026-10-01", cell: "slow-high" });
  const task = readout(parsed(w)).cells.find((x) => x.cell === "task-high");
  assert.equal(task.comparisons, 1, "only the admissible session counts");
  assert.deepEqual([...task.models], [["claude-sonnet-5", 3]], "the models column reads admissible rows only — sessions 3, 4 and 6");
});

test("a comparison needs a resolved (model, effort) that differs from slow-high's — the same model at a different level counts", () => {
  const w = world();
  // task-high resolved to slow-high's own model at the same level: empty comparison
  addRow(w, { session: "sSame", date: "2026-10-01", cell: "task-high", model: "claude-opus-5" });
  addRow(w, { session: "sSame", date: "2026-10-01", cell: "slow-high" });
  // slow-medium: same model, a different effort — a real comparison
  addRow(w, { session: "sEff", date: "2026-10-02", cell: "slow-medium" });
  addRow(w, { session: "sEff", date: "2026-10-02", cell: "slow-high" });
  const rows = readout(parsed(w)).cells;
  assert.equal(rows.find((x) => x.cell === "task-high").comparisons, 0);
  assert.equal(rows.find((x) => x.cell === "slow-medium").comparisons, 1);
  assert.equal(rows.find((x) => x.cell === "slow-high"), undefined, "slow-high is the baseline, never a readout line");
});

test("a comparison and the models column read the dispatch model, never the last turn's model", () => {
  const w = world();
  const dispatched = (session, cell, dispatchModel, model) => {
    addRow(w, { session, date: "2026-10-01", cell, model });
    w.members.at(-1).dispatchModel = dispatchModel;
  };
  // task-high dispatched on slow-high's own model at the same level: empty
  // comparisons, whether its last turn left no model or fell back to another provider
  dispatched("sBlank", "task-high", "claude-opus-5", "");
  addRow(w, { session: "sBlank", date: "2026-10-01", cell: "slow-high" });
  dispatched("sFallback", "task-high", "claude-opus-5", "ollama");
  addRow(w, { session: "sFallback", date: "2026-10-01", cell: "slow-high" });
  // dispatched on another model, though its last turn names slow-high's: a real comparison
  dispatched("sOther", "task-high", "claude-sonnet-5", "claude-opus-5");
  addRow(w, { session: "sOther", date: "2026-10-01", cell: "slow-high" });
  const task = readout(parsed(w)).cells.find((x) => x.cell === "task-high");
  assert.equal(task.comparisons, 1);
  assert.deepEqual([...task.models], [["claude-opus-5", 2], ["claude-sonnet-5", 1]]);
});

test("a run_date is the comparison session's member-outcomes run_date, not the ticket-features one", () => {
  const w = world();
  addComparisons(w, "task-high", 10, 5);
  for (const f of w.features) f.run_date = "2026-09-01";
  const r = cli(w);
  assert.equal(lineFor(r.stdout, "task-high"), "task-high 10 5 claude-sonnet-5");
});

test("a re-dispatched Pull is one Pull: two ticket-features rows for one session+agent count the member row once", () => {
  const w = world();
  addRow(w, { session: "sRe", date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: "sRe", date: "2026-10-01", cell: "slow-high" });
  // The re-dispatch: the same Pull's features row again, on the same member row.
  w.features.push({ ...w.features[0] });
  // An unjoined Pull, likewise written twice.
  addRow(w, { session: "sOrphan", date: "2026-10-01", cell: "smol-high", member: false });
  w.features.push({ ...w.features[w.features.length - 1] });
  const { cells, unjoined } = readout(parsed(w));
  const task = cells.find((x) => x.cell === "task-high");
  assert.equal(task.comparisons, 1);
  assert.deepEqual([...task.models], [["claude-sonnet-5", 1]], "the member row behind a re-dispatched Pull is counted once");
  assert.equal(unjoined, 1, "a re-dispatched Pull with no member row is one unjoined Pull");
});

test("two ticket-features rows for one session+agent naming different cells are refused, naming the session, agent and both cells", () => {
  const w = world();
  addRow(w, { session: "sTorn", date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: "sTorn", date: "2026-10-01", cell: "slow-high" });
  // The same Pull's row again, drawn at another cell: which cell ran is unknown.
  w.features.push({ ...w.features[0], chosen_cell: "smol-high" });
  const f = files(w);
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket-features", f.features, "--member-outcomes", f.members], { encoding: "utf8", cwd: f.dir });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `\ncell-readout: ${f.features}: session sTorn agent impl-100 has two rows, chosen_cell 'task-high' and 'smol-high'\n`);
  assert.throws(() => readout(parsed(w)), /session sTorn agent impl-100 has two rows, chosen_cell 'task-high' and 'smol-high'/);
});

// What the refusal must ACCEPT: a repeat that agrees on the cell, whatever else
// it differs on, and one agent name reused in another session.
test("a repeated session+agent on the same cell is one Pull even when its other columns differ, and the key is the session+agent pair", () => {
  const w = world();
  addRow(w, { session: "sSame", date: "2026-10-01", cell: "task-high" });
  addRow(w, { session: "sSame", date: "2026-10-01", cell: "slow-high" });
  w.features.push({ ...w.features[0], run_date: "2026-10-02", brief_chars: "200" });
  // impl-100 again, in another session and at another cell: a different Pull.
  addRow(w, { session: "sOther", date: "2026-10-02", cell: "smol-high" });
  w.features.at(-1).agent = "impl-100";
  w.members.at(-1).agent = "impl-100";
  w.members.at(-1).member = "impl-100";
  addRow(w, { session: "sOther", date: "2026-10-02", cell: "slow-high" });
  const r = cli(w);
  assert.equal(r.status, 0, r.stderr);
  const { cells } = readout(parsed(w));
  const of = (cell) => cells.find((c) => c.cell === cell);
  assert.deepEqual([of("task-high").comparisons, [...of("task-high").models]], [1, [["claude-sonnet-5", 1]]]);
  assert.equal(of("smol-high").comparisons, 1);
});

test("a member-outcomes session+agent repeated with different fields is refused, naming both; the readout is not changed by whichever row came last", () => {
  const w = world();
  addComparisons(w, "task-low", 12, 6);
  const [first] = w.members;
  // Every column but the key: a guard that compared only some of them would miss a conflict confined to the rest.
  const others = Object.keys(first).filter((c) => c !== "session" && c !== "agent");
  assert.equal(others.length, COLUMNS.length - 2, "the variants cover every column of the member row but the key");
  const variants = others.map((c) => ({ [c]: typeof first[c] === "number" ? first[c] + 7 : `${first[c]}x` }));
  for (const conflict of [{ model: "" }, ...variants]) {
    const dup = { ...w, members: [...w.members, { ...first, ...conflict }] };
    const r = cli(dup);
    assert.equal(r.status, 2, `${JSON.stringify(conflict)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.includes(`session ${first.session}`) && r.stderr.includes(`agent ${first.agent}`), r.stderr);
    assert.throws(() => readout(parsed(dup)), (e) => e.message.includes(`session ${first.session}`) && e.message.includes(`agent ${first.agent}`));
  }
});

test("the refusal of a repeated member-outcomes session+agent is prefixed with the path --member-outcomes named", () => {
  const w = world();
  addComparisons(w, "task-low", 12, 6);
  const f = files({ ...w, members: [...w.members, { ...w.members[0], cost: 7 }] });
  const renamed = join(f.dir, "members-copy.tsv");
  writeFileSync(renamed, readFileSync(f.members));
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket-features", f.features, "--member-outcomes", renamed], { encoding: "utf8", cwd: f.dir });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes(`cell-readout: ${renamed}: `), r.stderr);
});

test("an identical repeated member-outcomes row is one row, and one agent name in two sessions is two keys", () => {
  const w = world();
  addComparisons(w, "task-low", 12, 6);
  const clean = cli(w);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "task-low 12 6 claude-sonnet-5\n");
  const repeated = cli({ ...w, members: [...w.members, { ...w.members[0] }] });
  assert.deepEqual({ status: repeated.status, stdout: repeated.stdout, stderr: repeated.stderr }, { status: 0, stdout: clean.stdout, stderr: clean.stderr });
  // A named member's agent stem repeats across sessions; that is not a repeated key.
  const shared = world();
  addRow(shared, { session: "sOne", date: "2026-10-01", cell: "task-high" });
  addRow(shared, { session: "sOne", date: "2026-10-01", cell: "slow-high" });
  addRow(shared, { session: "sTwo", date: "2026-10-02", cell: "task-high" });
  addRow(shared, { session: "sTwo", date: "2026-10-02", cell: "slow-high" });
  for (const rows of [shared.features, shared.members]) rows[2].agent = rows[0].agent;
  const task = readout(parsed(shared)).cells.find((x) => x.cell === "task-high");
  assert.equal(task.comparisons, 2);
  assert.deepEqual(task.dates, ["2026-10-01", "2026-10-02"]);
});

test("a blank member-outcomes run_date is no date: its session is a comparison but adds nothing to the distinct-date count", () => {
  const w = world();
  addComparisons(w, "task-high", 4, 4);
  for (let i = 0; i < 6; i++) {
    const session = `sBlank${i}`;
    addRow(w, { session, date: "", cell: "task-high" });
    addRow(w, { session, date: "", cell: "slow-high" });
  }
  const task = readout(parsed(w)).cells.find((x) => x.cell === "task-high");
  assert.equal(task.comparisons, 10);
  assert.deepEqual([task.runDates, task.gated], [4, false], "ten comparisons over four real dates is below the five-date floor");
  assert.ok(!task.dates.includes(""), "a blank run_date is listed as a date");
});

test("gated cells print sorted by cell name, not in ticket-features order", () => {
  const w = world();
  // Rows are added in reverse alphabetical order: task-high first, smol-high second.
  addComparisons(w, "task-high", 10, 5);
  addComparisons(w, "smol-high", 10, 5);
  const r = cli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.stdout.split("\n").filter(Boolean),
    ["smol-high 10 5 claude-sonnet-5", "task-high 10 5 claude-sonnet-5"],
  );
});

test("equal per-model counts in a mixed cell list models alphabetically", () => {
  const w = world();
  // Reverse-alphabetical insertion order: sonnet rows first, then haiku, five each.
  addComparisons(w, "task-high", 5, 5, { model: "claude-sonnet-5" });
  addComparisons(w, "task-high", 5, 5, { model: "claude-haiku-4-5" });
  const r = cli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lineFor(r.stdout, "task-high"), "task-high 10 5 mixed (claude-haiku-4-5 n=5, claude-sonnet-5 n=5)");
});

// run-team/SKILL.md sends the controller here for a cell's comparison count.
// The prose is the only thing that does, and nothing else reads it: renaming
// the script or pointing the floor back at another query leaves every test
// above green. Each slice starts at an anchor that must occur exactly once and
// ends at the paragraph's blank line, so a restatement elsewhere in the file
// cannot satisfy a pin on the paragraph that carries the rule.
const RUN_TEAM = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"));

test("SKILL.md's floor names the script that prints a cell's count, and that script exists", () => {
  const floor = Pin.unemphasized(RUN_TEAM.paragraph("**Report the count the per-cell readout prints", "run-team's per-cell floor", Pin.END).text);
  const named = /`~\/\.omp\/plugins\/node_modules\/@feigi\/fleet-ctl\/scripts\/fleet-run (\S+\.mjs)`/.exec(floor)?.[1];
  assert.ok(named, "the floor no longer tells the controller which script to run");
  assert.equal(named, "cell-readout.mjs");
  assert.ok(existsSync(join(dirname(SCRIPT), named)), `${named} is not a script beside cell-readout.mjs`);
  assert.match(floor, Pin.phrase("prints `<cell> <comparisons> <run_dates> <resolved models>` for each cell past that floor"));
  assert.match(floor, Pin.phrase("a cell below it only as a count on stderr"));
});

test("the line SKILL.md says the readout prints is the line it prints: four fields, a cell below the floor on stderr only", () => {
  const gated = world();
  addComparisons(gated, "task-high", 10, 5);
  addComparisons(gated, "smol-high", 2, 2);
  const r = cli(gated);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lineFor(r.stdout, "task-high"), "task-high 10 5 claude-sonnet-5");
  assert.equal(lineFor(r.stdout, "smol-high"), undefined, "a cell below the floor must not print on stdout");
  assert.match(r.stderr, /smol-high below the gate: 2 comparisons/);
});

// The DELIBERATE paragraph moved, with its measurement, to references/pull.md;
// SKILL.md keeps the rule beside the pointer.
const PULL_MD = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "references", "pull.md"));
test("SKILL.md says the readout counts a pair only when the two rows ran a different model or effort, as the readout does", () => {
  assert.match(RUN_TEAM.text, Pin.phrase("**The readout counts DELIBERATE comparisons.** See references/pull.md."));
  const deliberate = Pin.unemphasized(PULL_MD.section("## The readout counts deliberate comparisons", "references/pull.md DELIBERATE section").text);
  assert.match(deliberate, Pin.phrase("the two rows must actually have RUN a different model or effort"));
  // Run, not read: the same model at the same level is no comparison, the same
  // model at a different level is one, a different model at the same level is one.
  const w = world();
  addRow(w, { session: "sNone", date: "2026-10-01", cell: "task-high", model: "claude-opus-5" });
  addRow(w, { session: "sNone", date: "2026-10-01", cell: "slow-high" });
  addRow(w, { session: "sModel", date: "2026-10-02", cell: "task-high" });
  addRow(w, { session: "sModel", date: "2026-10-02", cell: "slow-high" });
  addRow(w, { session: "sEffort", date: "2026-10-03", cell: "slow-medium" });
  addRow(w, { session: "sEffort", date: "2026-10-03", cell: "slow-high" });
  const { cells } = readout(parsed(w));
  const countOf = (cell) => cells.find((c) => c.cell === cell).comparisons;
  assert.deepEqual([countOf("task-high"), countOf("slow-medium")], [1, 1]);
});

test("the output identifies no comparison: no session, ticket or agent appears on either stream", () => {
  const w = world();
  addComparisons(w, "task-high", 10, 5);
  addComparisons(w, "smol-high", 3, 2);
  addRow(w, { session: "sOrphan", date: "2026-10-01", cell: "task-high", member: false });
  const r = cli(w);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout + r.stderr;
  for (const f of w.features) {
    assert.ok(!out.includes(f.session), `output names session ${f.session}`);
    assert.ok(!out.includes(f.agent), `output names agent ${f.agent}`);
  }
  assert.match(r.stderr, /1 ticket-features row has no member-outcomes row/);
});

test("an empty ticket-features.tsv prints no line and says why, exit 0", () => {
  const r = cli(world());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no cell other than slow-high has a ticket-features row/);
});

test("usage and input errors exit 2 and print nothing on stdout", () => {
  const w = world();
  addComparisons(w, "task-high", 1, 1);
  const f = files(w);
  for (const args of [
    ["--ticket-features", join(f.dir, "absent.tsv"), "--member-outcomes", f.members],
    ["--ticket-features", f.features, "--member-outcomes", join(f.dir, "absent.tsv")],
    ["--ticket-features", f.features, "--member-outcomes", f.members, "--bogus"],
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: f.dir });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
  writeFileSync(f.members, "# header\nshort\trow\n");
  const bad = spawnSync(process.execPath, [SCRIPT, "--ticket-features", f.features, "--member-outcomes", f.members], { encoding: "utf8", cwd: f.dir });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /malformed row/);
});

test("with no flags it reads docs/metrics/ under the working directory", () => {
  const w = world();
  addComparisons(w, "task-high", 10, 5);
  const f = files(w);
  const metrics = join(f.dir, "docs", "metrics");
  spawnSync("mkdir", ["-p", metrics]);
  spawnSync("cp", [f.features, f.members, metrics]);
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: f.dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lineFor(r.stdout, "task-high"), "task-high 10 5 claude-sonnet-5");
});

// The pure function's inputs, parsed the way the CLI parses them.
function parsed(w) {
  return {
    features: w.features.map((r) => ({ ...r })),
    members: w.members.map((r) => ({ ...r })),
  };
}

// The whole export surface: the readout and its gate.
test("the module exports the readout and its gate, and nothing else", () => {
  assert.deepEqual(Object.keys(cellReadout).sort(), ["GATE", "readout"]);
});
