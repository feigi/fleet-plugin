// cell-readout.mjs: the per-cell gate over ticket-features.tsv joined to
// member-outcomes.tsv, run as the CLI against synthetic fixture files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";
import { formatTsv } from "./member-outcomes.mjs";
import { FEATURE_COLUMNS } from "./pr-cost.mjs";
import { readout, GATE } from "./cell-readout.mjs";

const SCRIPT = fileURLToPath(new URL("./cell-readout.mjs", import.meta.url));

const member = (o) => ({
  run_date: "2026-10-01", role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, ...o,
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

function files(w) {
  const dir = tempDir("cell-readout-");
  const features = join(dir, "ticket-features.tsv");
  const members = join(dir, "member-outcomes.tsv");
  writeFileSync(features, [FEATURE_COLUMNS.join("\t"), ...w.features.map((r) => FEATURE_COLUMNS.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n");
  writeFileSync(members, "# header\n" + formatTsv(w.members));
  return { features, members, dir };
}
function cli(w, extra = []) {
  const f = files(w);
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
  // blank model: the resolved model is unknown, so nothing can differ from it
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

test("a run_date is the comparison session's member-outcomes run_date, not the ticket-features one", () => {
  const w = world();
  addComparisons(w, "task-high", 10, 5);
  for (const f of w.features) f.run_date = "2026-09-01";
  const r = cli(w);
  assert.equal(lineFor(r.stdout, "task-high"), "task-high 10 5 claude-sonnet-5");
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
  assert.match(r.stderr, /no cell but slow-high has a ticket-features row/);
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
