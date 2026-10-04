import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLUMNS, DEFAULT_TABLE, issueMetrics, ruleStratum, route, fitTable, readGuard, validateTable, parseFeatures, formatFeatureRow, mergedSince,
} from "../plugin/scripts/ticket-router.mjs";
import { drawCell, CELL } from "../plugin/scripts/ledger-grammar.mjs";
import { COLUMNS as MEMBER_COLUMNS } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as VERDICT_COLUMNS } from "../plugin/scripts/tier-outcomes.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ticket-router.mjs", import.meta.url));
const SESSION = "2026-10-01T10-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847a9";
const STAGE1 = ["slow-high", "task-high", "smol-high"];

const baseTable = (over = {}) => ({
  window_start: null, fitted_through: null, n_rows: 0, stage: 1, cells: [...STAGE1], burn_in: false,
  rows: { "*": "slow-high" }, classifier: { b: null, tau: null }, estimates: {}, guard: { tripped: [], n: {} }, ...over,
});
const guardFile = (over = {}) => ({
  computed_at: "2026-10-01T00:00:00Z", window_start: "2026-09-01",
  baseline: { cell: "slow-high", n: 5, mean_usd: 10, fail_rate: 0.5 },
  cells: STAGE1.map((cell) => ({ cell, n: 5, mean_usd: 5, fail_rate: 0.5 })), tripped: [], verdict: "none", ...over,
});
const issue = (over = {}) => ({
  title: "t", body: "short brief\n- [ ] one\n- [x] two", comments: [], labels: [{ name: "bug" }],
  createdAt: new Date(Date.now() - 3.5 * 86_400_000).toISOString(), ...over,
});

function world(t, { table = baseTable(), guard = guardFile(), issueJson = issue(), sizing } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ticket-router-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {
    table: join(dir, "router-table.json"), guard: join(dir, "cost-guard.json"), issue: join(dir, "issue.json"),
    sizing: join(dir, "sizing.json"), pending: join(dir, ".fleet", "ticket-features.pending.tsv"), dir,
  };
  writeFileSync(paths.table, typeof table === "string" ? table : JSON.stringify(table));
  if (guard !== null) writeFileSync(paths.guard, typeof guard === "string" ? guard : JSON.stringify(guard));
  if (issueJson !== null) writeFileSync(paths.issue, typeof issueJson === "string" ? issueJson : JSON.stringify(issueJson));
  if (sizing !== undefined) writeFileSync(paths.sizing, JSON.stringify(sizing));
  return paths;
}
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
function routeCli(p, { ticket = 42, arm = "A", implRow = 3, extra = [] } = {}) {
  return cli(["route", "--session", SESSION, "--ticket", String(ticket), "--arm", arm, "--impl-row", String(implRow),
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, ...extra]);
}
const parseLine = (stdout) => Object.fromEntries(stdout.trim().split(" ").map((kv) => kv.split("=")));

// ---------------------------------------------------------------------------
// route: one line, every REASON, exit 0 on every degradation
// ---------------------------------------------------------------------------

test("route: a clean non-exploration Pull prints the full line, REASON=ok, and records a features row", (t) => {
  const p = world(t);
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=light REASON=ok\n");
  const lines = readFileSync(p.pending, "utf8").trim().split("\n");
  assert.equal(lines[0], COLUMNS.join("\t"), "a new pending file starts with the header");
  const [row] = parseFeatures(lines.join("\n"));
  assert.equal(row.run_date, "2026-10-01");
  assert.equal(row.session, SESSION);
  assert.equal(row.agent, "impl-42");
  assert.equal(row.policy_cell, "slow-high");
  assert.equal(row.chosen_cell, "slow-high");
  assert.equal(row.exploration_draw, "", "no draw, so the draw column stays blank");
  assert.equal(row.sizing_src, "rule");
  assert.equal(row.criteria, "2");
  assert.equal(row.age_days, "3");
  assert.equal(row.kind, "bug");
  // A second Pull appends, never a second header.
  routeCli(p, { ticket: 43 });
  const again = readFileSync(p.pending, "utf8").trim().split("\n");
  assert.equal(again.length, 3);
  assert.equal(again.filter((l) => l === COLUMNS.join("\t")).length, 1);
});

test("route: with no --pending the features row lands beside the guard, in the run's .fleet/", (t) => {
  const p = world(t);
  const r = cli(["route", "--session", SESSION, "--ticket", "42", "--arm", "A", "--impl-row", "3",
    "--issue", p.issue, "--guard", p.guard, "--table", p.table]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseFeatures(readFileSync(join(p.dir, "ticket-features.pending.tsv"), "utf8")).length, 1);
});

// A scripted Pull's step 7, run against the real ledger.mjs: route, write the
// row with `tier=<CELL>` exactly when the router drew, then dispatch — whose
// printed `agent` is the definition the `task` call names.
test("a scripted Pull dispatches the router's cell: tier=<cell> on an Exploration Pull, no tier= otherwise", (t) => {
  const LEDGER = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));
  const pull = (p, ticket, implRow) => {
    const out = parseLine(routeCli(p, { ticket, implRow }).stdout);
    const ledgerFile = join(p.dir, "ledger.md");
    const env = { ...process.env, PATH: p.dir };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const led = (...args) => {
      const r = spawnSync(process.execPath, [LEDGER, "--file", ledgerFile, ...args], { encoding: "utf8", env, cwd: p.dir });
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    };
    const row = led("row", String(ticket), `impl-${ticket}${out.DRAW === "-" ? "" : ` · tier=${out.CELL}`}`);
    return { out, row: row.line, agent: led("dispatch", String(ticket), `impl-${ticket}`).agent };
  };
  const burnIn = world(t, { table: baseTable({ burn_in: true }) });
  for (const ticket of [101, 102, 103, 104]) {
    const { out, row, agent } = pull(burnIn, ticket, 1);
    assert.notEqual(out.DRAW, "-");
    assert.equal(row, `#${ticket} impl-${ticket} · tier=${out.CELL}`);
    assert.equal(agent, `fleet-implementer-${out.CELL}`);
  }
  const after = world(t);
  const plain = pull(after, 201, 4);
  assert.equal(plain.row, "#201 impl-201", "a Pull the router did not draw for carries no tier=");
  assert.equal(plain.agent, "fleet-implementer-slow-high");
  const explore = pull(after, 202, 5);
  assert.equal(explore.row, `#202 impl-202 · tier=${explore.out.CELL}`);
  assert.notEqual(explore.out.CELL, "slow-high");
  assert.equal(explore.agent, `fleet-implementer-${explore.out.CELL}`);
});

test("route: a session given as its directory path records the session id, not the path", (t) => {
  const p = world(t);
  const r = cli(["route", "--session", `/x/sessions/proj/${SESSION}/`, "--ticket", "42", "--arm", "A", "--impl-row", "3",
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].session, SESSION);
});

test("route: no-issue-json — a missing or unparseable issue file blanks the metrics, routes `unknown`, exits 0", (t) => {
  for (const issueJson of [null, "{not json"]) {
    const p = world(t, { issueJson });
    const r = routeCli(p);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLine(r.stdout), { POLICY: "slow-high", CELL: "slow-high", DRAW: "-", STRATUM: "unknown", REASON: "no-issue-json" });
    const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
    for (const c of ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "kind"]) assert.equal(row[c], "", c);
  }
});

test("route: no-sizing — a live B Pull without a usable sizing file routes `unknown`, exits 0", (t) => {
  const table = baseTable({ classifier: { b: "haiku", tau: null }, rows: { "*": "slow-high", heavy: "task-high" } });
  const p = world(t, { table });
  const r = routeCli(p, { arm: "B" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseLine(r.stdout), { POLICY: "slow-high", CELL: "slow-high", DRAW: "-", STRATUM: "unknown", REASON: "no-sizing" });
});

test("route: a live B Pull WITH a sizing verdict routes by it — the must-accept half of no-sizing", (t) => {
  const table = baseTable({ classifier: { b: "haiku", tau: null }, rows: { "*": "slow-high", heavy: "task-high" } });
  const p = world(t, { table, sizing: { source: "haiku", model: "m", label: "heavy", confidence: 1, usd: 0.0002 } });
  const r = routeCli(p, { arm: "B", extra: ["--sizing", p.sizing] });
  assert.equal(r.status, 0, r.stderr);
  // The table row for the classifier's stratum is dispatched; POLICY stays the free rule's.
  assert.deepEqual(parseLine(r.stdout), { POLICY: "slow-high", CELL: "task-high", DRAW: "-", STRATUM: "heavy", REASON: "ok" });
  const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.equal(row.sizing_src, "haiku");
  assert.equal(row.sizing_pre, "heavy");
  assert.equal(row.router_usd, "0.0002");
});

test("route: arm B on a table whose B gate is closed routes exactly as arm A and never reads a sizing file", (t) => {
  const p = world(t);
  const r = routeCli(p, { arm: "B" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=light REASON=ok\n");
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].sizing_src, "rule");
});

test("route: guard-missing — no guard (or an unparseable one) dispatches the default cell only, even in burn-in", (t) => {
  for (const guard of [null, "{nope", JSON.stringify({ tripped: "x" })]) {
    const p = world(t, { table: baseTable({ burn_in: true, rows: { "*": "task-high" } }), guard });
    const r = routeCli(p, { implRow: 5 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLine(r.stdout), { POLICY: "slow-high", CELL: "slow-high", DRAW: "-", STRATUM: "light", REASON: "guard-missing" });
  }
});

test("route: guard-tripped — a tripped cell leaves the draw's pool, and the line says so", (t) => {
  const p = world(t, { table: baseTable({ burn_in: true }), guard: guardFile({ tripped: ["smol-high"], verdict: "tripped" }) });
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  const out = parseLine(r.stdout);
  assert.equal(out.REASON, "guard-tripped");
  assert.notEqual(out.CELL, "smol-high");
  assert.match(out.DRAW, /^[12]\/2$/);
  assert.equal(out.CELL, drawCell({ session: SESSION, ticket: 42, policyCell: null, cells: ["slow-high", "task-high"] }).cell);
});

test("route: table-cell-tripped — a table row naming a tripped cell is replaced by the default without waiting for a re-fit", (t) => {
  const p = world(t, { table: baseTable({ rows: { "*": "task-high" } }), guard: guardFile({ tripped: ["task-high"] }) });
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseLine(r.stdout), { POLICY: "slow-high", CELL: "slow-high", DRAW: "-", STRATUM: "light", REASON: "table-cell-tripped" });
});

test("route: a non-default table row is dispatched when its cell is not tripped", (t) => {
  const p = world(t, { table: baseTable({ rows: { "*": "slow-high", light: "task-high" } }) });
  const r = routeCli(p);
  assert.equal(r.stdout, "POLICY=task-high CELL=task-high DRAW=- STRATUM=light REASON=ok\n");
});

test("route: burn-in draws on EVERY Pull, uniformly over all cells including the default", (t) => {
  const p = world(t, { table: baseTable({ burn_in: true }) });
  const seen = new Set();
  for (let ticket = 1; ticket <= 30; ticket++) {
    const r = routeCli(p, { ticket, implRow: ticket });
    assert.equal(r.status, 0, r.stderr);
    const out = parseLine(r.stdout);
    const d = drawCell({ session: SESSION, ticket, policyCell: null, cells: STAGE1 });
    assert.equal(out.CELL, d.cell);
    assert.equal(out.DRAW, `${d.k}/3`);
    seen.add(out.CELL);
  }
  assert.deepEqual([...seen].sort(), [...STAGE1].sort(), "thirty burn-in draws never reached every cell");
  // Reproducible from the row: the same session and ticket draw the same cell.
  assert.equal(routeCli(p, { ticket: 7 }).stdout, routeCli(p, { ticket: 7, implRow: 99 }).stdout);
});

test("route: after burn-in only the Pull creating impl- row 5k draws, over the cells minus the policy cell", (t) => {
  const p = world(t);
  for (const implRow of [1, 4, 6, 9, 11]) assert.equal(parseLine(routeCli(p, { implRow }).stdout).DRAW, "-", `row ${implRow}`);
  for (const implRow of [5, 10, 15]) {
    const out = parseLine(routeCli(p, { implRow }).stdout);
    const d = drawCell({ session: SESSION, ticket: 42, policyCell: "slow-high", cells: STAGE1 });
    assert.equal(out.CELL, d.cell);
    assert.equal(out.DRAW, `${d.k}/2`);
    assert.notEqual(out.CELL, "slow-high");
  }
  const [, , explore] = parseFeatures(readFileSync(p.pending, "utf8")).filter((r) => r.exploration_draw !== "");
  assert.ok(explore, "an exploration Pull records its draw");
  assert.notEqual(explore.chosen_cell, explore.policy_cell);
});

test("route: a chain head on row 5k does not draw — the assignment rolls to the next Pull", (t) => {
  const p = world(t);
  assert.equal(parseLine(routeCli(p, { implRow: 5, extra: ["--chain-head"] }).stdout).DRAW, "-");
  // In burn-in every Pull draws, chain head or not.
  const b = world(t, { table: baseTable({ burn_in: true }) });
  assert.notEqual(parseLine(routeCli(b, { implRow: 5, extra: ["--chain-head"] }).stdout).DRAW, "-");
});

test("route: with every non-default cell withdrawn (K=0) an exploration Pull runs the policy cell and records no draw", (t) => {
  const p = world(t, { table: baseTable({ cells: ["slow-high"] }) });
  const r = routeCli(p, { implRow: 5 });
  assert.equal(r.stdout, "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=light REASON=ok\n");
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].exploration_draw, "");
});

test("route: exit 2 only on usage errors and an unreadable or invalid table — and nothing is recorded", (t) => {
  const p = world(t);
  const base = ["route", "--session", SESSION, "--ticket", "42", "--arm", "A", "--impl-row", "3", "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending];
  const without = (flag) => { const i = base.indexOf(flag); return [...base.slice(0, i), ...base.slice(i + 2)]; };
  const swap = (flag, value) => base.map((a, i) => (base[i - 1] === flag ? value : a));
  const cases = [
    [without("--session"), /route needs --session/],
    [without("--guard"), /route needs --guard/],
    [swap("--arm", "C"), /--arm C is not A or B/],
    [swap("--ticket", "0"), /--ticket 0 is not an issue number/],
    [swap("--impl-row", "0"), /--impl-row 0 is not a positive row count/],
    [[...base, "--features", "x"], /--features does not apply to route/],
    [[...base, "--features=x"], /--features does not apply to route/],
    [[...without("--table"), `--table=${p.table}`], /--table needs a space-separated value/],
    [base.slice(1), /exactly one mode/],
    [swap("--table", join(p.dir, "absent.json")), /cannot read the router table/],
  ];
  for (const [args, why] of cases) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "");
  }
  for (const bad of [{ ...baseTable(), cells: ["slow-high", "alt"] }, { ...baseTable(), rows: {} }, { ...baseTable(), burn_in: "yes" }]) {
    const q = world(t, { table: bad });
    const r = routeCli(q);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /router table:/);
  }
  assert.equal(existsSync(p.pending), false, "a refused route wrote a features row");
});

test("route: the checked-in table is valid and is the day-one table", () => {
  const table = JSON.parse(readFileSync(DEFAULT_TABLE, "utf8"));
  assert.equal(validateTable(table), table);
  assert.equal(table.burn_in, true);
  assert.equal(table.stage, 1);
  assert.deepEqual(table.cells, STAGE1);
  assert.deepEqual(table.rows, { "*": "slow-high" });
  for (const c of table.cells) {
    assert.ok(CELL.test(c));
    assert.ok(existsSync(fileURLToPath(new URL(`../plugin/agents/fleet-implementer-${c}.agent.md`, import.meta.url))), `${c} has no definition`);
  }
});

test("route: pure — the same inputs give the same line, and the line names every field", () => {
  const args = { session: SESSION, ticket: 9, arm: "A", implRow: 10, issue: issue(), guard: readGuard(guardFile()), table: baseTable() };
  const a = route(args);
  assert.deepEqual(route(args), a);
  assert.match(a.line, /^POLICY=\S+ CELL=\S+ DRAW=\S+ STRATUM=(light|heavy|unknown) REASON=\S+$/);
  assert.equal(formatFeatureRow(a.row).split("\t").length, COLUMNS.length);
});

// route() called directly, so the gate and sizing matrices need no process per case.
const routeIn = (over) => route({ session: SESSION, ticket: 42, arm: "B", implRow: 3, issue: issue(), guard: readGuard(guardFile()), table: baseTable(), ...over });
const liveB = (over = {}) => baseTable({ classifier: { b: "haiku", tau: null }, rows: { "*": "slow-high", heavy: "task-high" }, ...over });
const haikuSizing = { source: "haiku", model: "m", label: "heavy", confidence: 1, usd: 0.5 };

test("route: arm B is live only on arm B, with a classifier set and some row not the default", () => {
  const ruleLine = "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=light REASON=ok";
  const cases = [
    ["a classifier but every row the default", liveB({ rows: { "*": "slow-high", heavy: "slow-high" } }), "B"],
    ["a non-default row but no classifier", liveB({ classifier: { b: null, tau: null } }), "B"],
    ["an open gate on arm A", liveB(), "A"],
  ];
  for (const [what, table, arm] of cases) {
    const { line, row } = routeIn({ table, arm, sizing: haikuSizing });
    assert.equal(line, ruleLine, what);
    assert.equal(row.sizing_src, "rule", what);
    assert.equal(row.sizing_pre, "", what);
    assert.equal(row.router_usd, "", what);
  }
  assert.equal(routeIn({ table: liveB(), arm: "B", sizing: haikuSizing }).line, "POLICY=slow-high CELL=task-high DRAW=- STRATUM=heavy REASON=ok", "the same inputs with the gate open and arm B do route by the sizing");
});

test("route: a live B sizing is used only when its source is the table's classifier and its label is light or heavy", () => {
  const refused = (table, sizing, what) => {
    const { line, row } = routeIn({ table, sizing });
    assert.equal(line, "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=unknown REASON=no-sizing", what);
    assert.equal(row.sizing_src, "", what);
    assert.equal(row.sizing_pre, "", what);
  };
  refused(liveB(), { ...haikuSizing, source: "jev" }, "a jev verdict on a haiku table");
  refused(liveB({ classifier: { b: "jev", tau: null } }), haikuSizing, "a haiku verdict on a jev table");
  refused(liveB(), { ...haikuSizing, source: undefined }, "no source");
  refused(liveB(), null, "no verdict at all");
  for (const label of ["medium", "Heavy", "", null, undefined, 1, ["heavy"]]) refused(liveB(), { ...haikuSizing, label }, `label ${JSON.stringify(label)}`);
  // A light verdict on a heavy-by-rule brief: the table row of the classifier's stratum, not the rule's.
  const light = routeIn({ table: liveB({ rows: { "*": "slow-high", light: "smol-high" } }), issue: issue({ body: "x".repeat(4000) }), sizing: { ...haikuSizing, label: "light" } });
  assert.equal(light.line, "POLICY=slow-high CELL=smol-high DRAW=- STRATUM=light REASON=ok");
  assert.equal(light.row.sizing_pre, "light");
});

test("route: a jev sizing below tau abstains to `unknown` but records its label, and sizing_src names the model", () => {
  const table = liveB({ classifier: { b: "jev", tau: 0.8 } });
  const jev = (over) => ({ source: "jev", model: "jev-1", label: "heavy", confidence: 0.9, usd: 0.25, ...over });
  const confident = routeIn({ table, sizing: jev() });
  assert.equal(confident.line, "POLICY=slow-high CELL=task-high DRAW=- STRATUM=heavy REASON=ok");
  assert.equal(confident.row.sizing_src, "jev:jev-1");
  assert.equal(confident.row.sizing_pre, "heavy");
  assert.equal(confident.row.router_usd, "0.25");
  assert.equal(routeIn({ table, sizing: jev({ confidence: 0.8 }) }).line, "POLICY=slow-high CELL=task-high DRAW=- STRATUM=heavy REASON=ok", "confidence exactly at tau does not abstain");
  for (const confidence of [0.79, 0, undefined, "high", null]) {
    const r = routeIn({ table, sizing: jev({ confidence }) });
    assert.equal(r.line, "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=unknown REASON=ok", `confidence ${JSON.stringify(confidence)}`);
    assert.equal(r.row.sizing_src, "jev:jev-1");
    assert.equal(r.row.sizing_pre, "heavy", "the abstained label is still recorded");
    assert.equal(r.row.router_usd, "0.25", "the abstained verdict's spend is still recorded");
  }
  assert.equal(routeIn({ table, sizing: jev({ model: undefined }) }).row.sizing_src, "jev:", "no model: the prefix alone");
  assert.equal(routeIn({ table, sizing: jev({ usd: undefined }) }).row.router_usd, "", "no finite usd: blank");
  assert.equal(routeIn({ table, sizing: jev({ usd: "0.25" }) }).row.router_usd, "", "a usd that is not a number: blank");
  // Without a tau the confidence is not consulted; and tau binds only a jev verdict.
  const noTau = routeIn({ table: liveB({ classifier: { b: "jev", tau: null } }), sizing: jev({ confidence: undefined }) });
  assert.equal(noTau.line, "POLICY=slow-high CELL=task-high DRAW=- STRATUM=heavy REASON=ok");
  const haiku = routeIn({ table: liveB({ classifier: { b: "haiku", tau: 0.8 } }), sizing: { ...haikuSizing, confidence: 0.1 } });
  assert.equal(haiku.line, "POLICY=slow-high CELL=task-high DRAW=- STRATUM=heavy REASON=ok");
  assert.equal(haiku.row.sizing_src, "haiku");
});

test("route: a tripped token that is not a cell makes the guard unreadable — default cell only — while a real trip still reads", (t) => {
  const table = baseTable({ burn_in: true });
  for (const tripped of [["task-hgih"], [{ cell: "task-hgih" }], ["smol-high", "task-hgih"]]) {
    const p = world(t, { table, guard: guardFile({ tripped, verdict: "tripped" }) });
    const r = routeCli(p, { implRow: 5 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLine(r.stdout), { POLICY: "slow-high", CELL: "slow-high", DRAW: "-", STRATUM: "light", REASON: "guard-missing" }, JSON.stringify(tripped));
  }
  const real = world(t, { table, guard: guardFile({ tripped: [{ cell: "smol-high" }], verdict: "tripped" }) });
  const out = parseLine(routeCli(real, { implRow: 5 }).stdout);
  assert.equal(out.REASON, "guard-tripped");
  assert.match(out.DRAW, /^[12]\/2$/);
  assert.notEqual(out.CELL, "smol-high");
  // The fit refuses the same guard rather than fitting around it.
  const fp = fitWorld(t, { features: [], members: [], verdicts: [], guard: guardFile({ tripped: ["task-hgih"] }) });
  const fit = cli(["fit", ...fp.fitArgs, "--guard", fp.guard]);
  assert.equal(fit.status, 2);
  assert.match(fit.stderr, /cannot read --guard/);
});

test("readGuard: a cost guard missing its tripped list, its cells, or well-formed entries in either reads as null", () => {
  const good = guardFile();
  const malformed = [
    ["null", null],
    ["a string", "x"],
    ["tripped missing", { ...good, tripped: undefined }],
    ["tripped a string", { ...good, tripped: "task-high" }],
    ["tripped an object", { ...good, tripped: {} }],
    ["cells missing", { ...good, cells: undefined }],
    ["cells an object", { ...good, cells: {} }],
    ["a tripped number", { ...good, tripped: [5] }],
    ["a tripped null", { ...good, tripped: [null] }],
    ["a tripped object with no cell", { ...good, tripped: [{}] }],
    ["a tripped object with a numeric cell", { ...good, tripped: [{ cell: 5 }] }],
    ["a tripped object with an array cell", { ...good, tripped: [{ cell: ["slow-high"] }] }],
    ["a tripped array", { ...good, tripped: [["slow-high"]] }],
    ["a tripped token that is not a cell", { ...good, tripped: ["task-hgih"] }],
    ["a tripped object whose cell is not a cell", { ...good, tripped: [{ cell: "nope" }] }],
    ["one bad tripped token among good ones", { ...good, tripped: ["slow-high", "slow-higher"] }],
    ["an empty tripped token", { ...good, tripped: [""] }],
    ["a null cells entry", { ...good, cells: [null] }],
    ["a bad entry after a good one", { ...good, cells: [{ cell: "slow-high", n: 5 }, null] }],
    ["a cells entry with a numeric cell", { ...good, cells: [{ cell: 5, n: 1 }] }],
    ["a cells entry with no cell", { ...good, cells: [{ n: 1 }] }],
    ["a cells entry with no n", { ...good, cells: [{ cell: "slow-high" }] }],
    ["a cells entry with a string n", { ...good, cells: [{ cell: "slow-high", n: "5" }] }],
    ["a cells entry with a null n", { ...good, cells: [{ cell: "slow-high", n: null }] }],
  ];
  for (const [what, raw] of malformed) assert.equal(readGuard(raw), null, what);
  assert.deepEqual(
    readGuard(guardFile({ tripped: ["task-high", { cell: "smol-high", fail_rate: 1 }, "task-high"] })),
    { tripped: ["smol-high", "task-high"], n: { "slow-high": 5, "task-high": 5, "smol-high": 5 }, window_start: "2026-09-01" },
    "tripped cells are de-duplicated and sorted; n is per cell; the window rides along",
  );
  assert.deepEqual(readGuard({ tripped: [], cells: [] }), { tripped: [], n: {}, window_start: null });
  assert.equal(readGuard(guardFile({ window_start: 20260901 })).window_start, null, "a window that is not a string is no window");
});

test("validateTable: each malformed router table is refused for its own reason, and each well-formed variant passes", () => {
  const bad = (over) => ({ ...baseTable(), ...over });
  const cases = [
    [/not a JSON object/, null], [/not a JSON object/, []], [/not a JSON object/, "x"],
    [/`cells` is not a non-empty array/, bad({ cells: undefined })],
    [/`cells` is not a non-empty array/, bad({ cells: "slow-high" })],
    [/`cells` is not a non-empty array/, bad({ cells: [] })],
    [/`cells` holds 5/, bad({ cells: [5] })],
    [/`cells` holds "alt"/, bad({ cells: ["slow-high", "alt"] })],
    [/`cells` holds \["slow-high"\]/, bad({ cells: [["slow-high"]] })],
    [/`cells` repeats a cell/, bad({ cells: ["slow-high", "task-high", "slow-high"] })],
    [/`rows` is not an object/, bad({ rows: undefined })],
    [/`rows` is not an object/, bad({ rows: null })],
    [/`rows` is not an object/, bad({ rows: [] })],
    [/`rows` is not an object/, bad({ rows: "x" })],
    [/`rows` has no `\*` row/, bad({ rows: {} })],
    [/`rows` has no `\*` row/, bad({ rows: { heavy: "task-high" } })],
    [/`rows` key "medium" is not/, bad({ rows: { "*": "slow-high", medium: "task-high" } })],
    [/`rows` key "" is not/, bad({ rows: { "*": "slow-high", "": "task-high" } })],
    [/`rows\.heavy` is "alt"/, bad({ rows: { "*": "slow-high", heavy: "alt" } })],
    [/`rows\.heavy` is 5/, bad({ rows: { "*": "slow-high", heavy: 5 } })],
    [/`rows\.heavy` is null/, bad({ rows: { "*": "slow-high", heavy: null } })],
    [/`rows\.\*` is \["slow-high"\]/, bad({ rows: { "*": ["slow-high"] } })],
    [/`burn_in` is not a boolean/, bad({ burn_in: "yes" })],
    [/`burn_in` is not a boolean/, bad({ burn_in: 1 })],
    [/`burn_in` is not a boolean/, bad({ burn_in: undefined })],
    [/`stage` is not a positive integer/, bad({ stage: 0 })],
    [/`stage` is not a positive integer/, bad({ stage: -1 })],
    [/`stage` is not a positive integer/, bad({ stage: 1.5 })],
    [/`stage` is not a positive integer/, bad({ stage: "1" })],
    [/`stage` is not a positive integer/, bad({ stage: undefined })],
    [/`classifier` is not an object/, bad({ classifier: null })],
    [/`classifier` is not an object/, bad({ classifier: undefined })],
    [/`classifier` is not an object/, bad({ classifier: "haiku" })],
    [/`classifier.b` is not/, bad({ classifier: { b: "sonnet", tau: null } })],
    [/`classifier.b` is not/, bad({ classifier: { b: "Haiku", tau: null } })],
    [/`classifier.b` is not/, bad({ classifier: { tau: null } })],
    [/`classifier.tau` is not/, bad({ classifier: { b: null, tau: "0.5" } })],
    [/`classifier.tau` is not/, bad({ classifier: { b: "jev" } })],
    [/`guard` is not/, bad({ guard: undefined })],
    [/`guard` is not/, bad({ guard: null })],
    [/`guard` is not/, bad({ guard: "x" })],
    [/`guard` is not/, bad({ guard: { tripped: "x", n: {} } })],
    [/`guard` is not/, bad({ guard: { n: {} } })],
    [/`guard` is not/, bad({ guard: { tripped: [] } })],
    [/`guard` is not/, bad({ guard: { tripped: [], n: null } })],
    [/`guard` is not/, bad({ guard: { tripped: [], n: "x" } })],
  ];
  for (const [why, table] of cases) {
    const r = validateTable(table);
    assert.ok(r instanceof Error, JSON.stringify(table));
    assert.match(r.message, /^router table: /);
    assert.match(r.message, why, JSON.stringify(table));
  }
  const valid = [
    baseTable(),
    bad({ burn_in: true, stage: 2, cells: [...STAGE1, "slow-medium", "task-max"] }),
    bad({ rows: { "*": "slow-high", light: "smol-high", heavy: "task-high", unknown: "slow-high" } }),
    bad({ classifier: { b: "haiku", tau: null } }),
    bad({ classifier: { b: "jev", tau: 0.8 } }),
    bad({ classifier: { b: null, tau: 0 } }),
    bad({ guard: { tripped: ["task-high"], n: { "slow-high": 3 } } }),
  ];
  for (const table of valid) assert.equal(validateTable(table), table, JSON.stringify(table));
});

test("route and fit: a router table that fails validation exits 2 naming the table and the reason, and records nothing", (t) => {
  const dup = baseTable({ cells: ["slow-high", "slow-high"] });
  const p = world(t, { table: dup });
  const r = routeCli(p);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes(`${p.table}: router table: \`cells\` repeats a cell`), r.stderr);
  assert.equal(existsSync(p.pending), false);
  const fp = fitWorld(t, { features: [], members: [], verdicts: [], table: dup });
  const fit = cli(["fit", ...fp.fitArgs, "--guard", fp.guard]);
  assert.equal(fit.status, 2, fit.stderr);
  assert.match(fit.stderr, /router table: `cells` repeats a cell/);
  assert.equal(cli(["--check", ...fp.fitArgs]).status, 2);
});

test("cli: route or fit combined with --check is refused — exactly one mode", (t) => {
  const p = world(t);
  for (const args of [["route", "--check", "--table", p.table], ["--check", "fit", "--table", p.table], ["--check", "route", "--table", p.table]]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /exactly one mode/, args.join(" "));
    assert.equal(r.stdout, "");
  }
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

test("metrics: the last Agent Brief comment is the brief, else the body", () => {
  const brief = "## Agent Brief\nTouch `plugin/scripts/a.mjs`, `tests/b.test.mjs` and `c.json`, not `two words`.\n* [ ] one\n- [X] two\n  - [ ] three\nSee #12, #12 and #13.";
  const m = issueMetrics(issue({
    body: "body only #99",
    comments: [{ body: "## Agent Brief\nold" }, { body: brief }, { body: "chatter" }],
    labels: [{ name: "ready-for-agent" }, { name: "enhancement" }, { name: "bug" }],
  }));
  assert.equal(m.brief_chars, String([...brief.trim()].length));
  assert.equal(m.criteria, "3");
  assert.equal(m.comments, "3");
  assert.equal(m.paths, "3");
  assert.equal(m.test_paths, "1");
  assert.equal(m.xrefs, "2");
  assert.equal(m.kind, "enhancement", "the FIRST kind label in label order");
  assert.equal(issueMetrics(issue({ body: "#5 `x/y`" })).xrefs, "1", "no Agent Brief comment: the body is the brief");
  assert.equal(issueMetrics([]), null);
  assert.equal(issueMetrics({ title: "no body" }), null);
});

test("metrics: the rule classifier is heavy past 3483 brief chars or 5 criteria, unknown on blank metrics", () => {
  assert.equal(ruleStratum({ brief_chars: "3483", criteria: "5" }), "light");
  assert.equal(ruleStratum({ brief_chars: "3484", criteria: "0" }), "heavy");
  assert.equal(ruleStratum({ brief_chars: "10", criteria: "6" }), "heavy");
  assert.equal(ruleStratum({ brief_chars: "", criteria: "" }), "unknown");
});

test("metrics: a backticked token is a path only without whitespace and with a slash or an extension, and test_paths needs a .test. infix or a tests?/ segment", () => {
  const m = (body) => issueMetrics(issue({ body }));
  assert.equal(m("`my dir/file.ts`").paths, "0", "a token with whitespace is prose");
  assert.equal(m("`plugin/scripts`").paths, "1", "a slash alone makes a path");
  assert.equal(m("`main.c`").paths, "1", "a one-letter extension is an extension");
  assert.equal(m("`a.mjs`").paths, "1", "an extension alone makes a path");
  assert.equal(m("`1.9`").paths, "0", "an extension starts with a letter");
  assert.equal(m("`a.b-c`").paths, "0", "an extension runs to the end of the token");
  assert.equal(m("`Makefile`").paths, "0", "a bare word is not a path");
  assert.equal(m("`a.mjs2`").paths, "1", "an extension may carry digits after its first letter");
  assert.equal(m("`a/b` `a/b`").paths, "1", "a path named twice counts once");
  assert.equal(m("`a/x.test.mjs`").test_paths, "1", "a .test. infix alone");
  assert.equal(m("`a/b.test`").test_paths, "0", ".test needs a trailing dot");
  assert.equal(m("`src/contest.mjs`").test_paths, "0", ".test. needs its leading dot");
  assert.equal(m("`tests/x.mjs`").test_paths, "1", "a leading tests/ alone");
  assert.equal(m("`a/test/x.mjs`").test_paths, "1", "test/ after a slash");
  assert.equal(m("`a/tests/x.mjs`").test_paths, "1", "tests/ after a slash");
  assert.equal(m("`contests/x.mjs`").test_paths, "0", "tests/ must start a path segment");
  assert.equal(m("`lib/testdata/x.json`").test_paths, "0", "test/ and tests/ end in a slash");
  assert.equal(m("`x.mjs`").test_paths, "0");
});

// ---------------------------------------------------------------------------
// fit and --check
// ---------------------------------------------------------------------------

const featureRow = (over) => ({
  run_date: "2026-10-01", session: SESSION, agent: `impl-${over.ticket}`, policy_cell: "slow-high", chosen_cell: "slow-high",
  exploration_draw: "", sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0",
  age_days: "1", paths: "0", test_paths: "0", xrefs: "0", kind: "bug", ...over,
});
const memberRow = (over) => Object.fromEntries(MEMBER_COLUMNS.map((c) => [c, ""]).concat(Object.entries({ session: SESSION, ...over })));
const verdictRow = (over) => ({ run_date: "2026-10-01", class: "", tier: "", note: "n", sizing: "", profile: "", loc: "", files: "", closed_own_ticket: "yes", minted_false_claim: "no", ...over });
const tsv = (cols, rows, header = false) => (header ? `${cols.join("\t")}\n` : "") + rows.map((r) => cols.map((c) => r[c] ?? "").join("\t")).join("\n") + (rows.length ? "\n" : "");

function fitWorld(t, { features, members, verdicts, table = baseTable({ burn_in: true }), guard = guardFile() }) {
  const p = world(t, { table, guard });
  p.features = join(p.dir, "ticket-features.tsv");
  p.members = join(p.dir, "member-outcomes.tsv");
  p.verdicts = join(p.dir, "tier-outcomes.tsv");
  writeFileSync(p.features, tsv(COLUMNS, features, true));
  writeFileSync(p.members, tsv(MEMBER_COLUMNS, members.map(memberRow)));
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, verdicts.map(verdictRow)));
  p.fitArgs = ["--table", p.table, "--features", p.features, "--members", p.members, "--verdicts", p.verdicts];
  return p;
}

test("fit: a day-one three-TSV fixture writes an estimates-only table, and --check accepts it", (t) => {
  const features = [
    featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" }),
    featureRow({ ticket: "2", chosen_cell: "slow-high", exploration_draw: "1/3", brief_chars: "5000" }),
    featureRow({ ticket: "3", chosen_cell: "smol-high", exploration_draw: "3/3", run_date: "2026-10-02" }),
  ];
  const members = [
    { member: "impl-1", agent: "impl-1", ticket: "1", pr: "11", role: "implementer" },
    { member: "fix-pr-11", agent: "fix-pr-11", pr: "11", role: "fix-applier" },
    { member: "merge-bot-1", agent: "merge-bot-1", pr: "11", role: "merge-bot" },
  ];
  const verdicts = [{ pr: "11", ticket: "1" }, { pr: "12", ticket: "2+9", minted_false_claim: "yes" }];
  const p = fitWorld(t, { features, members, verdicts });
  const r = cli(["fit", ...p.fitArgs, "--guard", p.guard]);
  assert.equal(r.status, 0, r.stderr);
  const table = JSON.parse(readFileSync(p.table, "utf8"));
  assert.deepEqual(table.rows, { "*": "slow-high" }, "no cell has n>=20 yet, so no row is adopted");
  assert.equal(table.burn_in, true);
  assert.equal(table.stage, 1);
  assert.equal(table.n_rows, 3);
  assert.equal(table.fitted_through, "2026-10-02");
  assert.equal(table.window_start, "2026-09-01", "the window comes from the guard; the fit never moves it");
  assert.deepEqual(table.estimates["*"]["task-high"], { n: 1, merged: 1, usd_per_merged: null, fail_rate: 0, fix_rounds: 1, review_findings: null });
  assert.deepEqual(table.estimates.heavy["slow-high"], { n: 1, merged: 1, usd_per_merged: null, fail_rate: 1, fix_rounds: 0, review_findings: null });
  assert.equal(table.estimates.light["smol-high"].merged, 0);
  assert.deepEqual(table.guard, { tripped: [], n: { "slow-high": 5, "smol-high": 5, "task-high": 5 } });

  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /matches a re-fit of 3 tickets through 2026-10-02/);
});

test("--check fails when the checked-in table is not a re-fit of its rows", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard]).status, 0);
  const good = JSON.parse(readFileSync(p.table, "utf8"));
  for (const [what, edit] of [
    ["a hand-adopted row", (x) => { x.rows["*"] = "task-high"; }],
    ["burn-in switched off by hand", (x) => { x.burn_in = false; }],
    ["an edited estimate", (x) => { x.estimates["*"]["task-high"].n = 30; }],
  ]) {
    const bad = structuredClone(good);
    edit(bad);
    writeFileSync(p.table, JSON.stringify(bad));
    const r = cli(["--check", ...p.fitArgs]);
    assert.equal(r.status, 1, `${what}: ${r.stderr}`);
    assert.match(r.stderr, /is not a re-fit of its own rows/);
  }
  // Rows dated after fitted_through are the next fit's, not a mismatch.
  writeFileSync(p.table, JSON.stringify(good));
  writeFileSync(p.features, tsv(COLUMNS, [...features, featureRow({ ticket: "2", run_date: "2026-10-09" })], true));
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0);
});

test("--check stays green when a verdict or member row lands after the fit, for a ticket the fit already read", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const members = [{ agent: "impl-1", member: "impl-1", ticket: "1", pr: "11" }];
  const p = fitWorld(t, { features, members, verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard]).status, 0);
  const fitted = readFileSync(p.table, "utf8");
  assert.equal(JSON.parse(fitted).fitted_through, "2026-10-01");
  // The ruling lands later and flips the ticket to a failure, and a fix round books against it.
  writeFileSync(p.verdicts, `# ${tsv(VERDICT_COLUMNS, [verdictRow({ pr: "11", ticket: "1" }), verdictRow({ run_date: "2026-10-09", pr: "11", ticket: "1", minted_false_claim: "yes" })], true)}`);
  writeFileSync(p.members, tsv(MEMBER_COLUMNS, [...members, { run_date: "2026-10-09", agent: "fix-pr-11", member: "fix-pr-11", ticket: "1", pr: "11" }].map(memberRow), true));
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(p.table, "utf8"), fitted, "--check never rewrites the table");
  // The next fit, once a later features row exists, reads both.
  writeFileSync(p.features, tsv(COLUMNS, [...features, featureRow({ ticket: "2", run_date: "2026-10-09" })], true));
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard]).status, 0);
  const next = JSON.parse(readFileSync(p.table, "utf8"));
  assert.equal(next.fitted_through, "2026-10-09");
  assert.equal(next.estimates["*"]["task-high"].fail_rate, 1, "the later ruling is read once the fit reaches its date");
  assert.equal(next.estimates["*"]["task-high"].fix_rounds, 1);
});

test("--check passes on a day-one table over a header-only features file", (t) => {
  const p = fitWorld(t, { features: [], members: [], verdicts: [], table: JSON.parse(readFileSync(DEFAULT_TABLE, "utf8")) });
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 0, r.stderr);
});

// Twenty-plus tickets a side, so the adoption rule can decide.
function adoptionInput({ cheapFails, cheapUsd = 2, baseUsd = 10, n = 20 }) {
  const features = [];
  const members = [];
  const verdicts = [];
  let ticket = 100;
  for (const [cell, usd, fail] of [["slow-high", baseUsd, false], ["smol-high", cheapUsd, cheapFails]]) {
    for (let i = 0; i < n; i++, ticket++) {
      features.push(featureRow({ ticket: String(ticket), chosen_cell: cell, exploration_draw: "1/3" }));
      members.push({ session: SESSION, agent: `impl-${ticket}`, member: `impl-${ticket}`, ticket: String(ticket), pr: String(ticket + 1000), cost: String(usd) });
      verdicts.push({ ticket: String(ticket), pr: String(ticket + 1000), closed_own_ticket: "yes", minted_false_claim: fail ? "yes" : "no" });
    }
  }
  return { features, members, verdicts: verdicts.map(verdictRow) };
}
const atN = { tripped: [], n: { "slow-high": 20, "task-high": 20, "smol-high": 20 }, window_start: null };

test("fit: adopts the cheapest cell at n>=20 under 0.75x the default's $/merged PR, and never re-tests the quality floor", () => {
  // Every smol-high PR fails the floor; the fit adopts it anyway — the guard,
  // not the fit, is the quality gate.
  const next = fitTable({ prior: baseTable({ burn_in: true }), ...adoptionInput({ cheapFails: true }), guard: atN });
  assert.equal(next.estimates["*"]["smol-high"].fail_rate, 1);
  assert.equal(next.rows["*"], "smol-high");
  assert.equal(next.rows.light, "smol-high", "a stratum with both sides at n>=20 gets its own row");
  assert.equal(next.stage, 2, "an adoption with every stage-1 cell at n advances the stage");
  assert.deepEqual(next.cells, [...STAGE1, "slow-medium", "task-max"]);
  // Burn-in ends only when EVERY cell in `cells` has n>=20, and the stage-2
  // cells have none yet.
  assert.equal(next.burn_in, true);
});

test("fit: no adoption above the 0.75x margin, for a tripped cell, or below n=20 — the default stays", () => {
  const above = fitTable({ prior: baseTable({ burn_in: true }), ...adoptionInput({ cheapFails: false, cheapUsd: 8 }), guard: atN });
  assert.deepEqual(above.rows, { "*": "slow-high", light: "slow-high" });
  assert.equal(above.burn_in, false, "every stage-1 cell has pooled n>=20 in the guard");
  assert.equal(above.stage, 1, "no adoption and no eviction: the stage holds");
  const tripped = fitTable({ prior: baseTable(), ...adoptionInput({ cheapFails: false }), guard: { ...atN, tripped: ["smol-high"] } });
  assert.deepEqual(tripped.rows, { "*": "slow-high" });
  assert.equal(tripped.stage, 2, "an eviction with every stage-1 cell at n advances the stage too");
  assert.deepEqual(tripped.cells, [...STAGE1, "slow-medium", "task-max"]);
  const small = fitTable({ prior: baseTable(), ...adoptionInput({ cheapFails: false, n: 19 }), guard: atN });
  assert.deepEqual(small.rows, { "*": "slow-high" });
  // A booked row with no cost on record makes the cell's $ unknown, and unknown never adopts.
  const input = adoptionInput({ cheapFails: false });
  input.members[30].cost = "";
  const unknown = fitTable({ prior: baseTable(), ...input, guard: atN });
  assert.equal(unknown.estimates["*"]["smol-high"].usd_per_merged, null);
  assert.deepEqual(unknown.rows, { "*": "slow-high" });
});

test("fit: a non-exploration row a live B classifier routed is the A/B's test set, not fit input", () => {
  const features = [
    featureRow({ ticket: "1", sizing_src: "haiku", chosen_cell: "task-high" }),
    featureRow({ ticket: "2", sizing_src: "haiku", chosen_cell: "task-high", exploration_draw: "1/2" }),
    featureRow({ ticket: "3" }),
  ];
  const next = fitTable({ prior: baseTable(), features, members: [], verdicts: [], guard: atN });
  assert.equal(next.n_rows, 2);
  assert.equal(next.estimates["*"]["task-high"].n, 1);
});

test("fit --due counts merged PRs since fitted_through against the cadence", (t) => {
  const features = Array.from({ length: 50 }, (_, i) => featureRow({ ticket: String(i + 1), run_date: "2026-10-05" }));
  const verdicts = features.map((f) => ({ ticket: f.ticket, pr: String(Number(f.ticket) + 500), run_date: f.run_date }));
  const p = fitWorld(t, { features, members: [], verdicts: verdicts.slice(0, 49), table: baseTable({ fitted_through: "2026-10-01" }) });
  const before = readFileSync(p.table, "utf8");
  const no = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--due"]);
  assert.equal(no.stdout, "DUE=no MERGED=49/50\n");
  assert.equal(readFileSync(p.table, "utf8"), before, "--due writes nothing");
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, verdicts.map(verdictRow)));
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard, "--due"]).stdout, "DUE=yes MERGED=50/50\n");
});

test("mergedSince: strictly after fitted_through, on or after window_start, each bound only when set, the window bounding what fitted_through admits", () => {
  const features = ["2026-09-30", "2026-10-01", "2026-10-02"].map((d, i) => featureRow({ ticket: String(i + 1), run_date: d }));
  const verdicts = features.map((f) => verdictRow({ ticket: f.ticket, pr: String(Number(f.ticket) + 500), run_date: "2026-10-03" }));
  const count = (over) => mergedSince({ table: baseTable(over), features, verdicts });
  assert.equal(count({ fitted_through: null, window_start: null }), 3, "neither bound set: every ruled ticket counts");
  assert.equal(count({ fitted_through: "2026-10-01" }), 1, "the fitted_through day itself is already fitted");
  assert.equal(count({ window_start: "2026-10-01" }), 2, "the window_start day itself is inside the window");
  assert.equal(count({ window_start: "2026-09-30", fitted_through: "2026-09-30" }), 2);
  assert.equal(count({ window_start: "2026-10-02", fitted_through: "2026-09-30" }), 1, "the window still bounds what fitted_through admits");
  assert.equal(mergedSince({ table: baseTable(), features, verdicts: verdicts.slice(1) }), 2, "a ticket with no verdict is not a merged PR");
  const twice = [...features, featureRow({ ticket: "3", run_date: "2026-10-03" })];
  assert.equal(mergedSince({ table: baseTable(), features: twice, verdicts }), 3, "a ticket with two features rows is one merged PR");
});

test("mergedSince: a ticket is merged only on a ruling dated on or after its last features row, a row with both verdict columns blank skipped", () => {
  const features = [featureRow({ ticket: "1", run_date: "2026-10-01" }), featureRow({ ticket: "1", run_date: "2026-10-03" })];
  const count = (verdicts) => mergedSince({ table: baseTable(), features, verdicts });
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-02" })]), 0, "a ruling dated before the last features row predates that Pull");
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-03", closed_own_ticket: "", minted_false_claim: "" })]), 0, "a both-blank row was never ruled");
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-03" })]), 1, "a ruling dated the day of the last features row rules it");
});

test("mergedSince: a ticket's last Pull is its last features row in file order, not its latest-dated one", () => {
  const features = [featureRow({ ticket: "1", run_date: "2026-10-03" }), featureRow({ ticket: "1", run_date: "2026-10-01" })];
  const count = (verdicts) => mergedSince({ table: baseTable(), features, verdicts });
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-02" })]), 1, "the later row in file order is older-dated, and its date is the floor the ruling clears");
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-09-30" })]), 0, "a ruling dated before even that floor rules nothing");
});

test("mergedSince: a features row whose run_date is blank is no Pull, with neither bound set as with one set", () => {
  // route() writes a blank run_date for a session id with no date prefix.
  const features = [featureRow({ ticket: "2", run_date: "2026-10-03" }), featureRow({ ticket: "2", run_date: "" })];
  const count = (verdicts, over = {}) => mergedSince({ table: baseTable(over), features, verdicts });
  const early = verdictRow({ ticket: "2", pr: "22", run_date: "2026-01-01", minted_false_claim: "yes" });
  assert.equal(count([early]), 0, "a ruling dated before the last dated row predates that Pull");
  assert.equal(count([early], { window_start: "2026-01-01" }), 0, "the same with window_start set");
  assert.equal(count([verdictRow({ ticket: "2", pr: "22", run_date: "2026-10-03" })]), 1, "a ruling on or after the last dated row still rules the ticket");
  assert.equal(mergedSince({ table: baseTable(), features: [featureRow({ ticket: "3", run_date: "" })], verdicts: [verdictRow({ ticket: "3", pr: "33" })] }), 0, "a ticket whose only row is blank-dated has no Pull to rule");
});

test("fit refuses an unreadable guard or input file at exit 2 and leaves the table alone", (t) => {
  const p = fitWorld(t, { features: [], members: [], verdicts: [], guard: null });
  const before = readFileSync(p.table, "utf8");
  const r = cli(["fit", ...p.fitArgs, "--guard", p.guard]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read --guard/);
  writeFileSync(p.features, "not\tthe\theader\n");
  const r2 = cli(["--check", ...p.fitArgs]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /cannot read --features/);
  assert.equal(readFileSync(p.table, "utf8"), before);
});

// A direct fitTable call: the `cost` column is not in member-outcomes COLUMNS, so cost-bearing fixtures skip the TSV round trip.
const fitDirect = (input, guard = {}) => fitTable({ prior: baseTable(), ...input, guard: { tripped: [], n: {}, window_start: null, ...guard } });
const exploring = (over) => featureRow({ exploration_draw: "1/3", ...over });
const ruled = (ticket, pr, over) => verdictRow({ ticket: String(ticket), pr: String(pr), ...over });

test("fit: a ticket's verdict is its last ruling dated on or after its last input row, a row with both verdict columns blank skipped", () => {
  // Ticket 2, in another cell, carries the fit's cutoff past ticket 1's last input row.
  const features = [
    exploring({ ticket: "1", run_date: "2026-10-01" }),
    exploring({ ticket: "1", run_date: "2026-10-03" }),
    exploring({ ticket: "2", run_date: "2026-10-05", chosen_cell: "task-high" }),
  ];
  const fit = (verdicts) => fitDirect({ features, members: [], verdicts }).estimates["*"]["slow-high"];
  const failed = ruled(1, 11, { run_date: "2026-10-03", minted_false_claim: "yes" });
  const blank = ruled(1, 11, { run_date: "2026-10-04", closed_own_ticket: "", minted_false_claim: "" });
  assert.equal(fit([failed, blank]).fail_rate, 1, "a both-blank row after a real ruling was never ruled, so the ruling stands");
  assert.equal(fit([blank]).merged, 0, "a ticket whose only row is both-blank has no verdict");
  assert.equal(fit([ruled(1, 11, { run_date: "2026-10-02", minted_false_claim: "yes" })]).merged, 0, "a ruling dated before the last input row predates that Pull");
  const pass = ruled(1, 11, { run_date: "2026-10-03" });
  assert.deepEqual(fit([pass]), { ...fit([pass]), merged: 1, fail_rate: 0 }, "a ruling dated the day of the last input row rules it");
  assert.equal(fit([pass, ruled(1, 11, { run_date: "2026-10-05", minted_false_claim: "yes" })]).fail_rate, 1, "the last such ruling wins");
});

test("fit: a ticket's cell is its last input row in file order, not its latest-dated one, and that row's date is the ruling's floor", () => {
  // Ticket 1's rows are in reverse date order; ticket 2, in another cell, carries the fit's cutoff past both.
  const features = [
    exploring({ ticket: "1", run_date: "2026-10-03", chosen_cell: "slow-high" }),
    exploring({ ticket: "1", run_date: "2026-10-01", chosen_cell: "smol-high" }),
    exploring({ ticket: "2", run_date: "2026-10-05", chosen_cell: "task-high" }),
  ];
  const estimates = fitDirect({ features, members: [], verdicts: [ruled(1, 11, { run_date: "2026-10-02" })] }).estimates["*"];
  assert.equal(estimates["smol-high"]?.merged, 1, "the later row in file order is the older-dated: its cell takes the ruling, which clears only its floor");
  assert.equal(estimates["slow-high"], undefined, "the latest-dated row does not set the ticket's cell");
});

test("fit: a features row whose run_date is blank is no input row, for the fit and for --check's re-fit at fitted_through", () => {
  // route() writes a blank run_date for a session id with no date prefix; ticket 9's blank row sits in another cell.
  const features = [
    exploring({ ticket: "2", run_date: "2026-10-03" }),
    exploring({ ticket: "2", run_date: "", chosen_cell: "smol-high" }),
    exploring({ ticket: "9", run_date: "", chosen_cell: "task-high" }),
  ];
  const early = ruled(2, 22, { run_date: "2026-01-01", minted_false_claim: "yes" });
  for (const cutoff of [undefined, "2026-10-03"]) {
    const fit = (verdicts) => fitDirect({ features, members: [], verdicts, cutoff });
    const t = fit([early, ruled(9, 99)]);
    assert.deepEqual(Object.keys(t.estimates["*"]), ["slow-high"], `cutoff ${cutoff}: neither blank row sets a cell or adds a ticket`);
    assert.equal(t.n_rows, 1, `cutoff ${cutoff}`);
    assert.equal(t.estimates["*"]["slow-high"].merged, 0, `cutoff ${cutoff}: a ruling dated before the last dated row predates that Pull`);
    assert.equal(fit([ruled(2, 22, { run_date: "2026-10-03" })]).estimates["*"]["slow-high"].merged, 1, `cutoff ${cutoff}: a ruling on or after the last dated row rules the ticket`);
    assert.equal(t.fitted_through, "2026-10-03", `cutoff ${cutoff}`);
  }
});

test("fit refuses at exit 2 a ruling of an input ticket whose run_date is not YYYY-MM-DD, and leaves the table alone; one of a ticket outside the input is not refused", (t) => {
  const features = [exploring({ ticket: "1" })];
  const p = fitWorld(t, { features, members: [], verdicts: [ruled(1, 11), ruled(2, 12, { run_date: "10/01/2026" })] });
  const before = readFileSync(p.table, "utf8");
  for (const mode of [["--due"], []]) {
    const ok = cli(["fit", ...p.fitArgs, "--guard", p.guard, ...mode]);
    assert.equal(ok.status, 0, `fit ${mode.join(" ")}: ${ok.stderr}`);
  }
  writeFileSync(p.table, before);
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11, { run_date: "10/01/2026" })].map(verdictRow)));
  for (const mode of [[], ["--due"]]) {
    const r = cli(["fit", ...p.fitArgs, "--guard", p.guard, ...mode]);
    assert.equal(r.status, 2, `fit ${mode.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /ticket #1 \(PR #11\): run_date is '10\/01\/2026', expected YYYY-MM-DD/);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
});

test("fit refuses at exit 2 a ruling of an input ticket whose run_date is not YYYY-MM-DD even when it sorts after the fit's cut, as fit --due does", (t) => {
  const features = [exploring({ ticket: "1" })];
  const p = fitWorld(t, { features, members: [], verdicts: [ruled(1, 11)] });
  const before = readFileSync(p.table, "utf8");
  // Each of these is `>` the cut ("2026-10-01"), so a string `<=` would drop it before `rulingFor` saw it.
  for (const bad of ["abc", "zzz", "2027", "2026-13-45x"]) {
    writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11, { run_date: bad })].map(verdictRow)));
    for (const mode of [[], ["--due"]]) {
      const r = cli(["fit", ...p.fitArgs, "--guard", p.guard, ...mode]);
      assert.equal(r.status, 2, `run_date ${bad}, fit ${mode.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`ticket #1 \\(PR #11\\): run_date is '${bad}', expected YYYY-MM-DD`));
      assert.equal(r.stdout, "");
    }
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
  // The same junk on a ticket outside the input is still not refused.
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11), ruled(2, 12, { run_date: "zzz" })].map(verdictRow)));
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard]).status, 0);
});

test("fit: a ruling's run_date with trailing or leading junk is refused, not read as the date inside it", () => {
  const features = [exploring({ ticket: "1", run_date: "2026-10-01" }), exploring({ ticket: "2", run_date: "2026-10-05", chosen_cell: "task-high" })];
  for (const bad of ["2026-10-01x", "x2026-10-01"]) {
    assert.throws(
      () => fitDirect({ features, members: [], verdicts: [ruled(1, 11, { run_date: bad })] }),
      { message: new RegExp(`ticket #1 \\(PR #11\\): run_date is '${bad}', expected YYYY-MM-DD`) },
    );
  }
});

test("fit: a ruling with closed_own_ticket no and no minted false claim still fails the floor", () => {
  const features = [exploring({ ticket: "1" })];
  const next = fitDirect({ features, members: [], verdicts: [ruled(1, 11, { closed_own_ticket: "no", minted_false_claim: "no" })] });
  assert.deepEqual(next.estimates["*"]["slow-high"], { ...next.estimates["*"]["slow-high"], merged: 1, fail_rate: 1 });
});

test("--check refuses at exit 2 a ruling of an input ticket whose run_date is not YYYY-MM-DD, not as a mismatch with the table", (t) => {
  const features = [exploring({ ticket: "1" })];
  const p = fitWorld(t, { features, members: [], verdicts: [ruled(1, 11)] });
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard]).status, 0);
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0);
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11, { run_date: "10/01/2026" })].map(verdictRow)));
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ticket #1 \(PR #11\): run_date is '10\/01\/2026', expected YYYY-MM-DD/);
  assert.equal(r.stdout, "");
});

test("fit: a ticket's cell and stratum are its last features row's", () => {
  const features = [
    exploring({ ticket: "1", chosen_cell: "task-high", brief_chars: "100" }),
    exploring({ ticket: "1", chosen_cell: "smol-high", exploration_draw: "2/3", brief_chars: "5000" }),
  ];
  const members = [memberRow({ agent: "impl-1", member: "impl-1", ticket: "1", cost: "3" })];
  const next = fitDirect({ features, members, verdicts: [ruled(1, 11)] });
  assert.equal(next.n_rows, 1);
  assert.deepEqual(Object.keys(next.estimates["*"]), ["smol-high"]);
  assert.deepEqual(Object.keys(next.estimates.heavy), ["smol-high"]);
  assert.equal(next.estimates.light, undefined);
});

test("fit: a ticket's $ adds the router's own spend from every one of its features rows to its members' cost", () => {
  const features = [
    exploring({ ticket: "1", router_usd: "0.5" }),
    exploring({ ticket: "1", router_usd: "" }),
    exploring({ ticket: "1", router_usd: "0.25" }),
  ];
  const members = [memberRow({ agent: "impl-1", member: "impl-1", ticket: "1", cost: "3" })];
  const next = fitDirect({ features, members, verdicts: [ruled(1, 11)] });
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, 3.75);
});

test("fit: members whose cost does not vary with the cell are not booked against a ticket", () => {
  const features = [exploring({ ticket: "1" })];
  const named = (member, cost) => memberRow({ agent: member, member, ticket: "1", cost });
  const members = [named("impl-1", "2"), named("merge-bot-9", "100"), named("memory", "200"), named("__advisor", "400")];
  const next = fitDirect({ features, members, verdicts: [ruled(1, 11)] });
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, 2);
});

test("fit: a ticket whose only members are cell-independent has an unknown $, not a free one", () => {
  const features = [exploring({ ticket: "1" })];
  const named = (member) => memberRow({ agent: member, member, ticket: "1", cost: "1" });
  const members = [named("merge-bot-9"), named("memory"), named("__advisor")];
  const next = fitDirect({ features, members, verdicts: [ruled(1, 11)] });
  assert.equal(next.estimates["*"]["slow-high"].merged, 1);
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, null);
});

test("fit: a member row books against a ticket by its ticket, by its session and agent, or by the ticket's ruled PR, and no other way", () => {
  const features = [
    exploring({ ticket: "1", chosen_cell: "slow-high" }),
    exploring({ ticket: "2", chosen_cell: "task-high" }),
    exploring({ ticket: "3", chosen_cell: "smol-high" }),
  ];
  const members = [
    memberRow({ session: "elsewhere", agent: "impl-x1", member: "impl-x1", ticket: "1", pr: "", cost: "2" }),
    memberRow({ session: SESSION, agent: "impl-2", member: "impl-2", ticket: "", pr: "", cost: "3" }),
    memberRow({ session: "elsewhere", agent: "impl-x3", member: "impl-x3", ticket: "", pr: "703", cost: "5" }),
    // The right agent in another session, and the right session under another agent, are neither of the three.
    memberRow({ session: "elsewhere", agent: "impl-2", member: "impl-2", ticket: "", pr: "", cost: "1000" }),
    memberRow({ session: SESSION, agent: "impl-9", member: "impl-9", ticket: "", pr: "", cost: "2000" }),
  ];
  const verdicts = [ruled(1, 701), ruled(2, 702), ruled(3, 703)];
  const est = fitDirect({ features, members, verdicts }).estimates["*"];
  assert.equal(est["slow-high"].usd_per_merged, 2, "booked by ticket alone");
  assert.equal(est["task-high"].usd_per_merged, 3, "booked by session and agent alone");
  assert.equal(est["smol-high"].usd_per_merged, 5, "booked by the ticket's ruled PR alone");
});

test("fit: features rows dated before the window are not the fit's, whole tickets and single rows alike", () => {
  const features = [
    exploring({ ticket: "1", run_date: "2026-08-31" }),
    exploring({ ticket: "2", run_date: "2026-08-31", router_usd: "5" }),
    exploring({ ticket: "2", run_date: "2026-09-01", router_usd: "1" }),
  ];
  const members = [
    memberRow({ agent: "impl-1", member: "impl-1", ticket: "1", cost: "2" }),
    memberRow({ agent: "impl-2", member: "impl-2", ticket: "2", cost: "1" }),
  ];
  const next = fitDirect({ features, members, verdicts: [ruled(2, 12, { run_date: "2026-09-01" })] }, { window_start: "2026-09-01" });
  assert.equal(next.n_rows, 1, "the window's first day is in; the day before is out");
  const e = next.estimates["*"]["slow-high"];
  assert.equal(e.n, 1);
  assert.equal(e.usd_per_merged, 2, "the out-of-window row's router spend is not the ticket's");
});

// Tickets in one cell mixing ruled-pass, ruled-failure and not-yet-ruled, each booked at $2.
function unmergedMix() {
  const ids = ["1", "2", "3", "4"];
  return {
    features: ids.map((ticket) => exploring({ ticket })),
    members: ids.map((ticket) => memberRow({ agent: `impl-${ticket}`, member: `impl-${ticket}`, ticket, cost: "2" })),
    verdicts: [ruled(1, 11), ruled(2, 12, { minted_false_claim: "yes" })],
  };
}

test("fit: a cell's fail rate is its failed PRs over its merged PRs, not over every ticket in it", () => {
  const e = fitDirect(unmergedMix()).estimates["*"]["slow-high"];
  assert.equal(e.n, 4);
  assert.equal(e.merged, 2);
  assert.equal(e.fail_rate, 0.5);
});

test("fit: a cell's $ per merged PR spreads every ticket's cost over the merged PRs, not over every ticket", () => {
  assert.equal(fitDirect(unmergedMix()).estimates["*"]["slow-high"].usd_per_merged, 4);
});

// `[cell, usd, n]` entries: n tickets in the cell, each booked at `usd` and ruled a pass, so the cell's $ per merged PR is `usd`.
function cellInput(spec) {
  const features = [];
  const members = [];
  const verdicts = [];
  let ticket = 100;
  for (const [cell, usd, n = 20] of spec) {
    for (let i = 0; i < n; i++, ticket++) {
      features.push(exploring({ ticket: String(ticket), chosen_cell: cell }));
      members.push(memberRow({ agent: `impl-${ticket}`, member: `impl-${ticket}`, ticket: String(ticket), cost: String(usd) }));
      verdicts.push(ruled(ticket, ticket + 1000));
    }
  }
  return { features, members, verdicts };
}
const stage1AtN = { "slow-high": 20, "task-high": 20, "smol-high": 20 };

test("fit: a cell at exactly 0.75x the default's $ per merged PR is adopted", () => {
  const next = fitDirect(cellInput([["slow-high", 10], ["smol-high", 7.5]]));
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 7.5);
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, 10);
  assert.equal(next.rows["*"], "smol-high");
});

test("fit: a cell just above 0.75x the default's $ per merged PR is not adopted", () => {
  const next = fitDirect(cellInput([["slow-high", 10], ["smol-high", 7.6]]));
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 7.6);
  assert.equal(next.rows["*"], "slow-high");
});

test("fit: equally cheap candidates break the tie by cell name, whatever their order in `cells`", () => {
  // `cells` lists task-high before smol-high; the name order is the reverse.
  const next = fitDirect(cellInput([["slow-high", 10], ["task-high", 2], ["smol-high", 2]]));
  assert.equal(next.rows["*"], "smol-high");
});

test("fit: the cheapest candidate is the one adopted, wherever it sits in `cells`", () => {
  const lastCheapest = fitDirect(cellInput([["slow-high", 10], ["task-high", 5], ["smol-high", 3]]));
  assert.equal(lastCheapest.rows["*"], "smol-high");
  const firstCheapest = fitDirect(cellInput([["slow-high", 10], ["task-high", 3], ["smol-high", 5]]));
  assert.equal(firstCheapest.rows["*"], "task-high");
});

test("fit: a stratum with no default cell on record adopts nothing", () => {
  const next = fitDirect(cellInput([["smol-high", 2]]));
  assert.deepEqual(next.rows, { "*": "slow-high" });
});

test("fit: a stratum whose default cell is below n=20 adopts nothing", () => {
  const next = fitDirect(cellInput([["slow-high", 10, 19], ["smol-high", 2]]));
  assert.deepEqual(next.rows, { "*": "slow-high" });
});

test("fit: a stratum whose default cell's $ is unknown adopts nothing, even from a cell that cost nothing", () => {
  const input = cellInput([["slow-high", 10], ["smol-high", 0]]);
  input.members[0].cost = "";
  const next = fitDirect(input);
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, null);
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 0);
  assert.deepEqual(next.rows, { "*": "slow-high" });
});

test("fit: stage 2 waits until every stage-1 cell is at n>=20, even with an adoption in hand", () => {
  const next = fitDirect(cellInput([["slow-high", 10], ["smol-high", 2]]), { n: { ...stage1AtN, "task-high": 19 } });
  assert.equal(next.rows["*"], "smol-high");
  assert.equal(next.stage, 1);
  assert.deepEqual(next.cells, STAGE1);
});

test("fit: stage 2 adds no effort cell on a role whose stage-1 cell is tripped", () => {
  const input = cellInput([["slow-high", 10], ["smol-high", 2]]);
  const taskTripped = fitDirect(input, { n: stage1AtN, tripped: ["task-high"] });
  assert.equal(taskTripped.stage, 2);
  assert.deepEqual(taskTripped.cells, [...STAGE1, "slow-medium"]);
  const slowTripped = fitDirect(input, { n: stage1AtN, tripped: ["slow-high"] });
  assert.equal(slowTripped.stage, 2);
  assert.deepEqual(slowTripped.cells, [...STAGE1, "task-max"]);
});

test("fit: stage 2 does not add an effort cell the table already holds", () => {
  const prior = baseTable({ cells: [...STAGE1, "slow-medium"] });
  const n = { ...stage1AtN, "slow-medium": 20 };
  const next = fitTable({ prior, ...cellInput([["slow-high", 10], ["smol-high", 2]]), guard: { tripped: [], n, window_start: null } });
  assert.equal(next.stage, 2);
  assert.deepEqual(next.cells, [...STAGE1, "slow-medium", "task-max"]);
});

test("fit: stage 2 adds no effort cell on a role the table holds no stage-1 cell for", () => {
  const prior = baseTable({ cells: ["slow-high", "smol-high"] });
  const n = { "slow-high": 20, "smol-high": 20 };
  const next = fitTable({ prior, ...cellInput([["slow-high", 10], ["smol-high", 2]]), guard: { tripped: [], n, window_start: null } });
  assert.equal(next.stage, 2);
  assert.deepEqual(next.cells, ["slow-high", "smol-high", "slow-medium"]);
});
