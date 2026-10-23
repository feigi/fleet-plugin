import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import {
  DEFAULT_TABLE, issueMetrics, ruleStratum, route, fitTable, readGuard, validateTable, formatFeatureRow, mergedSince, resolveCommit,
} from "../plugin/scripts/ticket-router.mjs";
import { FEATURE_COLUMNS as COLUMNS, parseFeatures } from "../plugin/scripts/pull-attribution.mjs";
import { drawCell, CELL } from "../plugin/scripts/ledger-grammar.mjs";
import { COLUMNS as MEMBER_COLUMNS, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as VERDICT_COLUMNS } from "../plugin/scripts/tier-outcomes.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ticket-router.mjs", import.meta.url));
const SESSION = "2026-10-01T10-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847a9";
const SESSION2 = "2026-10-01T11-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847b0";
const STAGE1 = ["slow-high", "task-high", "smol-high"];

const baseTable = (over = {}) => ({
  window_start: null, fitted_commit: null, n_rows: 0, stage: 1, cells: [...STAGE1], burn_in: false,
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

test("route: a 0-byte pending file gets the header before its first row", (t) => {
  const p = world(t);
  mkdirSync(dirname(p.pending), { recursive: true });
  writeFileSync(p.pending, "");
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(p.pending, "utf8").split("\n");
  assert.equal(lines.pop(), "", "the file ends with a newline");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], COLUMNS.join("\t"));
  assert.equal(parseFeatures(lines.join("\n"))[0].agent, "impl-42");
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
    const led = rendering(p.dir, (...args) => {
      const r = spawnSync(process.execPath, [LEDGER, "--file", ledgerFile, ...args], { encoding: "utf8", env, cwd: p.dir });
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    });
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

// With no --session the router takes the session directory the phase-0
// receipt `.fleet/phase0.json` records, in the git workspace it runs from.
function receiptWorld(t, receipt) {
  const p = world(t);
  assert.equal(spawnSync("git", ["init", "-q", p.dir], { encoding: "utf8", env: gitEnv() }).status, 0);
  mkdirSync(join(p.dir, ".fleet"), { recursive: true });
  if (receipt !== undefined) writeFileSync(join(p.dir, ".fleet", "phase0.json"), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
  const run = (session) => spawnSync(process.execPath, [SCRIPT, "route", ...(session === undefined ? [] : ["--session", session]),
    "--ticket", "42", "--arm", "A", "--impl-row", "3", "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending],
  { encoding: "utf8", cwd: p.dir, env: gitEnv() });
  return { ...p, run };
}
const receiptFor = (session) => ({ run: null, session, scratch: "/scratch", steps: {} });

test("route: with no --session the session is the one the phase-0 receipt records", (t) => {
  const p = receiptWorld(t, receiptFor(`/home/u/.omp/agent/sessions/-w/${SESSION2}`));
  const r = p.run();
  assert.equal(r.status, 0, r.stderr);
  const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.equal(row.session, SESSION2);
  assert.equal(row.run_date, "2026-10-01");
});

test("route: a given --session wins over the receipt's, and an unreadable receipt is never opened for it", (t) => {
  for (const receipt of [receiptFor(`/s/${SESSION2}`), "{"]) {
    const p = receiptWorld(t, receipt);
    const r = p.run(SESSION);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].session, SESSION);
  }
});

test("route: no --session and no session in the receipt is exit 2 naming the receipt, and nothing is recorded", (t) => {
  for (const [receipt, why] of [[undefined, "no receipt"], [receiptFor(""), "it records no session"], ["{", "unreadable: not JSON"]]) {
    const p = receiptWorld(t, receipt);
    const r = p.run();
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`no session given and none in the phase-0 receipt \\S+/\\.fleet/phase0\\.json \\(${why}`));
    assert.equal(r.stdout, "");
    assert.equal(existsSync(p.pending), false, `${why}: a refused route wrote a features row`);
  }
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
  const fit = cli(["fit", ...fp.fitArgs, "--guard", fp.guard, "--commit", "HEAD"]);
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
  const fit = cli(["fit", ...fp.fitArgs, "--guard", fp.guard, "--commit", "HEAD"]);
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
const memberRow = (over) => Object.fromEntries(MEMBER_COLUMNS.map((c) => [c, ""]).concat(Object.entries({ session: SESSION, harness: "omp", ...over })));
const verdictRow = (over) => ({ run_date: "2026-10-01", class: "", tier: "", note: "n", sizing: "", profile: "", loc: "", files: "", closed_own_ticket: "yes", minted_false_claim: "no", ...over });
const tsv = (cols, rows, header = false) => (header ? `${cols.join("\t")}\n` : "") + rows.map((r) => cols.map((c) => r[c] ?? "").join("\t")).join("\n") + (rows.length ? "\n" : "");
// The Admissible implementer row of features row `f`, costing $1.
const implementer = (f, over = {}) => ({
  session: f.session, run_date: f.run_date, agent: f.agent, member: f.agent, ticket: f.ticket, role: "implementer",
  subagent_type: `fleet-implementer-${f.chosen_cell}`, effort: f.chosen_cell.split("-")[1], model: "m", dispatch_model: "m", cost: "1", ending: "hollow", ...over,
});
// `members`, plus an implementer for every features row none of them is: one that opened the PR a verdict names for its ticket.
const withImplementers = (features, verdicts, members) => [
  ...features.filter((f) => !members.some((m) => (m.session ?? SESSION) === f.session && m.agent === f.agent)).map((f) => {
    const v = verdicts.find((x) => String(x.ticket).split("+").includes(f.ticket));
    return implementer(f, v ? { pr: String(v.pr), ending: "pr" } : {});
  }),
  ...members,
];
// `withImplementers`, parsed as the fit reads member-outcomes.tsv.
const parsedMembers = (features, verdicts, members) => parseMemberTsv(tsv(MEMBER_COLUMNS, withImplementers(features, verdicts, members).map(memberRow)));

function fitWorld(t, { features, members, verdicts, table = baseTable({ burn_in: true }), guard = guardFile() }) {
  const p = world(t, { table, guard });
  p.features = join(p.dir, "ticket-features.tsv");
  p.members = join(p.dir, "member-outcomes.tsv");
  p.verdicts = join(p.dir, "tier-outcomes.tsv");
  // Rewrites the three files, every features row given its implementer as `fitWorld` gives them.
  p.write = ({ features: f, members: m = [], verdicts: v }) => {
    writeFileSync(p.features, tsv(COLUMNS, f, true));
    writeFileSync(p.members, tsv(MEMBER_COLUMNS, withImplementers(f, v, m).map(memberRow)));
    writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, v.map(verdictRow)));
  };
  p.write({ features, members, verdicts });
  p.fitArgs = ["--table", p.table, "--features", p.features, "--members", p.members, "--verdicts", p.verdicts];
  // The fit reads the three TSVs as committed, so the fixture is a repository, and a test that
  // changes a file commits it with `p.commit()`, which answers the new commit's sha.
  p.git = (...args) => {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: p.dir, encoding: "utf8", env: gitEnv() });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  p.commit = () => {
    p.git("add", "ticket-features.tsv", "member-outcomes.tsv", "tier-outcomes.tsv");
    p.git("commit", "-q", "--allow-empty", "-m", "rows");
    return p.git("rev-parse", "HEAD");
  };
  p.git("init", "-q");
  p.commit();
  return p;
}

const fitCli = (p, extra = [], commit = "HEAD") => cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", commit, ...extra]);

test("fit: a day-one three-TSV fixture writes an estimates-only table, and --check accepts it", (t) => {
  const features = [
    featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" }),
    featureRow({ ticket: "2", chosen_cell: "slow-high", exploration_draw: "1/3", brief_chars: "5000" }),
    featureRow({ ticket: "3", chosen_cell: "smol-high", exploration_draw: "3/3", run_date: "2026-10-02" }),
  ];
  // Every Pull's implementer is admissible and costs $1; ticket 1's PR took a $2 fix round, and the merge bot is no cell's.
  const members = [
    { member: "fix-pr-11", agent: "fix-pr-11", pr: "11", role: "fix-applier", cost: "2" },
    { member: "merge-bot-1", agent: "merge-bot-1", pr: "11", role: "merge-bot", cost: "100" },
  ];
  const verdicts = [{ pr: "11", ticket: "1" }, { pr: "12", ticket: "2+9", minted_false_claim: "yes" }];
  const p = fitWorld(t, { features, members, verdicts });
  const r = fitCli(p);
  assert.equal(r.status, 0, r.stderr);
  const sha = p.git("rev-parse", "HEAD");
  assert.match(r.stdout, new RegExp(`fitted 3 Pulls at ${sha.slice(0, 8)};.*; cells slow-high m n=1 merged=1 failed=1 usd_per_merged=1.00 excluded=0 left_out=0 unpriced=0, `));
  const table = JSON.parse(readFileSync(p.table, "utf8"));
  assert.deepEqual(table.rows, { "*": "slow-high" }, "no cell has n>=20 yet, so no row is adopted");
  assert.equal(table.burn_in, true);
  assert.equal(table.stage, 1);
  assert.equal(table.n_rows, 3);
  assert.equal(table.fitted_commit, sha, "the table records the commit the fit read, in full");
  assert.equal("fitted_through" in table, false, "no date field stays beside the commit");
  assert.equal(table.window_start, "2026-09-01", "the window comes from the guard; the fit never moves it");
  const est = (o) => ({ generation: "m", claims: o.merged, failed: 0, fix_rounds: 0, review_findings: null, excluded: 0, left_out: 0, unpriced: 0, older: {}, ...o });
  assert.deepEqual(table.estimates["*"]["task-high"], est({ n: 1, merged: 1, usd_per_merged: 3, fail_rate: 0, fix_rounds: 1 }));
  assert.deepEqual(table.estimates.heavy["slow-high"], est({ n: 1, merged: 1, failed: 1, usd_per_merged: 1, fail_rate: 1 }));
  assert.deepEqual(table.estimates.light["smol-high"], est({ n: 1, merged: 0, usd_per_merged: null, fail_rate: null, fix_rounds: null }));
  assert.deepEqual(table.guard, { tripped: [], n: { "slow-high": 5, "smol-high": 5, "task-high": 5 } });

  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, new RegExp(`matches a re-fit of 3 Pulls at ${sha.slice(0, 8)}\n`));
});

test("--check fails when the checked-in table is not a re-fit of its rows", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(fitCli(p).status, 0);
  const good = JSON.parse(readFileSync(p.table, "utf8"));
  for (const [what, edit] of [
    ["a hand-adopted row", (x) => { x.rows["*"] = "task-high"; }],
    ["burn-in switched off by hand", (x) => { x.burn_in = false; }],
    ["an edited estimate", (x) => { x.estimates["*"]["task-high"].n = 30; }],
    ["a fitted_commit reset to null", (x) => { x.fitted_commit = null; }],
  ]) {
    const bad = structuredClone(good);
    edit(bad);
    writeFileSync(p.table, JSON.stringify(bad));
    const r = cli(["--check", ...p.fitArgs]);
    assert.equal(r.status, 1, `${what}: ${r.stderr}`);
    assert.match(r.stderr, /is not a re-fit of its own rows/);
  }
  writeFileSync(p.table, JSON.stringify(good));
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0, "the table as fitted is accepted");
});

test("--check and --due after a fit: a features row with the fitted row's own date from another session is the next fit's, not a mismatch", (t) => {
  const p = fitWorld(t, {
    features: [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })],
    members: [], verdicts: [{ pr: "11", ticket: "1" }],
  });
  assert.equal(fitCli(p).status, 0);
  const fitted = readFileSync(p.table, "utf8");
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=no MERGED=0/50\n", "the rows the fit read are not new");
  p.write({
    features: [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" }), featureRow({ ticket: "2", session: SESSION2, run_date: "2026-10-01" })],
    verdicts: [{ pr: "11", ticket: "1" }, { pr: "22", ticket: "2" }],
  });
  p.commit();
  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(readFileSync(p.table, "utf8"), fitted, "--check never rewrites the table");
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=no MERGED=1/50\n", "the same-day row counts");
});

test("--check and --due after a fit: a crashed run's row drained later, dated before the fitted date, is the next fit's, not a mismatch", (t) => {
  const p = fitWorld(t, {
    features: [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3", run_date: "2026-10-05" })],
    members: [], verdicts: [{ pr: "11", ticket: "1", run_date: "2026-10-05" }],
  });
  assert.equal(fitCli(p).status, 0);
  p.write({
    features: [
      featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3", run_date: "2026-10-05" }),
      featureRow({ ticket: "2", session: SESSION2, run_date: "2026-10-02" }),
    ],
    verdicts: [{ pr: "11", ticket: "1", run_date: "2026-10-05" }, { pr: "22", ticket: "2", run_date: "2026-10-03" }],
  });
  p.commit();
  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=no MERGED=1/50\n", "the older-dated row counts");
});

test("--check stays green when a fitted ticket's verdict is re-judged in place, and the next fit reads the new verdict", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(fitCli(p).status, 0);
  const fitted = readFileSync(p.table, "utf8");
  assert.equal(JSON.parse(fitted).estimates["*"]["task-high"].fail_rate, 0);
  // The same row, the same date, the same row count: only its content changes.
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [verdictRow({ pr: "11", ticket: "1", minted_false_claim: "yes" })]));
  const rejudged = p.commit();
  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(readFileSync(p.table, "utf8"), fitted, "--check never rewrites the table");
  assert.equal(fitCli(p).status, 0);
  const next = JSON.parse(readFileSync(p.table, "utf8"));
  assert.equal(next.fitted_commit, rejudged);
  assert.equal(next.estimates["*"]["task-high"].fail_rate, 1, "the next fit reads the new verdict");
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0, "and the table it wrote checks green");
});

test("--check stays green when a member scrape re-sorts or rewrites rows after the fit", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const members = [
    implementer(features[0], { pr: "11", ending: "pr" }),
    { agent: "fix-pr-11", member: "fix-pr-11", ticket: "1", pr: "11", cost: "1" },
  ];
  const p = fitWorld(t, { features, members, verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(fitCli(p).status, 0);
  const fitted = readFileSync(p.table, "utf8");
  assert.equal(JSON.parse(fitted).estimates["*"]["task-high"].fix_rounds, 1);
  // The scrape replaces rows by key and re-sorts the whole file: a newer row comes first, the
  // fitted rows follow in the other order, and one of them is rewritten with a later date.
  const scraped = [
    { run_date: "2026-10-09", agent: "fix-pr-12", member: "fix-pr-12", ticket: "1", pr: "11", cost: "1" },
    { run_date: "2026-10-09", agent: "fix-pr-11", member: "fix-pr-11", ticket: "1", pr: "11", cost: "1" },
    members[0],
  ];
  writeFileSync(p.members, tsv(MEMBER_COLUMNS, scraped.map(memberRow)));
  p.commit();
  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(readFileSync(p.table, "utf8"), fitted, "--check never rewrites the table");
});

test("fit and --check read the commit, not the working tree", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  const first = p.git("rev-parse", "HEAD");
  // An uncommitted edit of every file, and a deleted one, change nothing either reads.
  writeFileSync(p.features, tsv(COLUMNS, [featureRow({ ticket: "7", chosen_cell: "slow-high", exploration_draw: "1/3" })], true));
  writeFileSync(p.verdicts, "not\ta\tverdict\n");
  rmSync(p.members);
  assert.equal(fitCli(p).status, 0);
  assert.equal(JSON.parse(readFileSync(p.table, "utf8")).estimates["*"]["task-high"].merged, 1);
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0);
  // `--commit` names any commit, not only HEAD.
  p.commit();
  const r = fitCli(p, [], first);
  assert.equal(r.status, 0, r.stderr);
  const table = JSON.parse(readFileSync(p.table, "utf8"));
  assert.equal(table.fitted_commit, first);
  assert.equal(table.estimates["*"]["task-high"].merged, 1);
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0);
});

test("an ambient GIT_DIR or GIT_WORK_TREE naming another repository does not change what fit and --check read", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  const other = tempDir("router-other-");
  assert.equal(spawnSync("git", ["init", "-q", other], { encoding: "utf8", env: gitEnv() }).status, 0);
  for (const ambient of [{ GIT_DIR: join(other, ".git") }, { GIT_WORK_TREE: other }]) {
    const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...ambient } });
    const fit = run(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"]);
    assert.equal(fit.status, 0, `${Object.keys(ambient)}: ${fit.stderr}`);
    assert.equal(JSON.parse(readFileSync(p.table, "utf8")).estimates["*"]["task-high"].merged, 1, Object.keys(ambient).join());
    const check = run(["--check", ...p.fitArgs]);
    assert.equal(check.status, 0, `${Object.keys(ambient)}: ${check.stderr}`);
  }
});

test("--check exits 2 naming `git fetch --depth=1 origin <sha>` when fitted_commit is not in this repository, and fit refuses a --commit that is not one", (t) => {
  const p = fitWorld(t, { features: [], members: [], verdicts: [] });
  const absent = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true, fitted_commit: absent })));
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes(`git fetch --depth=1 origin ${absent}`), r.stderr);
  const due = fitCli(p, ["--due"]);
  assert.equal(due.status, 2, due.stderr);
  assert.ok(due.stderr.includes(`git fetch --depth=1 origin ${absent}`), due.stderr);
  for (const bad of ["not-a-sha", "ABCDEF", 7, "--output=x"]) {
    writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true, fitted_commit: bad })));
    const c = cli(["--check", ...p.fitArgs]);
    assert.equal(c.status, 2, `${JSON.stringify(bad)}: ${c.stderr}`);
    assert.match(c.stderr, /`fitted_commit` is not null or a full commit sha/);
  }
  writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true })));
  const before = readFileSync(p.table, "utf8");
  const f = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "no-such-ref"]);
  assert.equal(f.status, 2, f.stderr);
  assert.match(f.stderr, /is not a commit of the repository holding --features/);
  assert.equal(resolveCommit(p.features, "-x"), null, "a rev that reads as an option names no commit");
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard]).status, 2, "fit needs --commit");
  assert.equal(readFileSync(p.table, "utf8"), before);
});

test("a features file outside any repository, or a git that fails, is reported as git failing, not as a commit this repository lacks", (t) => {
  const p = fitWorld(t, { features: [], members: [], verdicts: [] });
  const sha = p.git("rev-parse", "HEAD");
  writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true, fitted_commit: sha })));
  const plain = tempDir("router-plain-");
  const features = join(plain, "ticket-features.tsv");
  writeFileSync(features, readFileSync(p.features));
  const tail = ["--members", p.members, "--verdicts", p.verdicts];
  const check = cli(["--check", "--table", p.table, "--features", features, ...tail]);
  assert.equal(check.status, 2, check.stderr);
  assert.match(check.stderr, /cannot resolve [0-9a-f]{40} in the repository holding --features .*not a git repository/s);
  assert.doesNotMatch(check.stderr, /does not hold|git fetch/);
  const fit = cli(["fit", "--table", p.table, "--features", features, ...tail, "--guard", p.guard, "--commit", "HEAD"]);
  assert.equal(fit.status, 2, fit.stderr);
  assert.match(fit.stderr, /cannot resolve HEAD in the repository holding --features .*not a git repository/s);
  assert.doesNotMatch(fit.stderr, /is not a commit of the repository/);
  assert.throws(() => resolveCommit(features, "HEAD"), /not a git repository/);
});

test("--check passes on a day-one table over a header-only features file", (t) => {
  const p = fitWorld(t, { features: [], members: [], verdicts: [], table: JSON.parse(readFileSync(DEFAULT_TABLE, "utf8")) });
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 0, r.stderr);
});

// The CI step's own shell, run against stubs: `git` only logs, and the step's `node` is the real one.
function ciRouterCheck(table) {
  const dir = tempDir("router-ci-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "git.log");
  // `git fetch` succeeds and brings nothing; every other call finds no repository.
  writeExecStub(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in fetch) exit 0 ;; *) exit 1 ;; esac\n`);
  const scripts = join(dir, "plugin", "scripts");
  mkdirSync(scripts, { recursive: true });
  const real = dirname(SCRIPT);
  for (const f of readdirSync(real)) if (f !== "router-table.json") symlinkSync(join(real, f), join(scripts, f));
  writeFileSync(join(scripts, "router-table.json"), JSON.stringify(table));
  mkdirSync(join(dir, "docs", "metrics"), { recursive: true });
  const [header, empty] = [`${COLUMNS.join("\t")}\n`, ""];
  writeFileSync(join(dir, "docs", "metrics", "ticket-features.tsv"), header);
  writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), empty);
  writeFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), empty);
  const yml = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
  const step = /- name: Router table check\n {8}run: \|\n((?: {10}.*\n)+)/.exec(yml);
  assert.ok(step, "ci.yml has a multi-line `Router table check` step");
  const r = spawnSync("bash", ["-c", step[1].replace(/^ {10}/gm, "")], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("CI's router check: with fitted_commit null it fetches nothing and --check exits 0 on the committed table", () => {
  const { r, calls } = ciRouterCheck(baseTable({ burn_in: true }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls, [], "no git call at all");
  assert.match(r.stdout, /matches a re-fit of 0 Pulls at no commit/);
});

test("CI's router check: with a fitted_commit it runs `git fetch --depth=1 origin <sha>` before --check", (t) => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const { r, calls } = ciRouterCheck(baseTable({ burn_in: true, fitted_commit: sha }));
  assert.deepEqual(calls[0], `fetch --depth=1 origin ${sha}`);
  assert.equal(r.status, 2, "the stubbed fetch brought nothing, so --check refuses naming the commit");
  assert.ok(r.stderr.includes(`git fetch --depth=1 origin ${sha}`), r.stderr);
});

// A direct fitTable call, its member rows given their implementers and parsed as the CLI parses them.
const direct = (input) => ({ ...input, members: parsedMembers(input.features, input.verdicts, input.members) });
const fitDirect = (input, guard = {}) => fitTable({ prior: baseTable(), ...direct(input), guard: { tripped: [], n: {}, window_start: null, ...guard } });
const exploring = (over) => featureRow({ exploration_draw: "1/3", ...over });
const ruled = (ticket, pr, over) => verdictRow({ ticket: String(ticket), pr: String(pr), ...over });

// Twenty-plus Pulls a side, so the adoption rule can decide: each implementer opened its PR and cost `usd`.
function adoptionInput({ cheapFails, cheapUsd = 2, baseUsd = 10, n = 20 }) {
  const features = [];
  const members = [];
  const verdicts = [];
  let ticket = 100;
  for (const [cell, usd, fail] of [["slow-high", baseUsd, false], ["smol-high", cheapUsd, cheapFails]]) {
    for (let i = 0; i < n; i++, ticket++) {
      const f = featureRow({ ticket: String(ticket), chosen_cell: cell, exploration_draw: "1/3" });
      features.push(f);
      members.push(implementer(f, { pr: String(ticket + 1000), cost: String(usd), ending: "pr" }));
      verdicts.push(ruled(ticket, ticket + 1000, { minted_false_claim: fail ? "yes" : "no" }));
    }
  }
  return { features, members, verdicts };
}
const atN = { tripped: [], n: { "slow-high": 20, "task-high": 20, "smol-high": 20 }, window_start: null };

test("fit: adopts the cheapest cell at n>=20 under 0.75x the default's $/merged PR, and never re-tests the quality floor", () => {
  // Every smol-high PR fails the floor; the fit adopts it anyway — the guard,
  // not the fit, is the quality gate.
  const next = fitTable({ prior: baseTable({ burn_in: true }), ...direct(adoptionInput({ cheapFails: true })), guard: atN });
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
  const above = fitTable({ prior: baseTable({ burn_in: true }), ...direct(adoptionInput({ cheapFails: false, cheapUsd: 8 })), guard: atN });
  assert.deepEqual(above.rows, { "*": "slow-high", light: "slow-high" });
  assert.equal(above.burn_in, false, "every stage-1 cell has pooled n>=20 in the guard");
  assert.equal(above.stage, 1, "no adoption and no eviction: the stage holds");
  const tripped = fitTable({ prior: baseTable(), ...direct(adoptionInput({ cheapFails: false })), guard: { ...atN, tripped: ["smol-high"] } });
  assert.deepEqual(tripped.rows, { "*": "slow-high" });
  assert.equal(tripped.stage, 2, "an eviction with every stage-1 cell at n advances the stage too");
  assert.deepEqual(tripped.cells, [...STAGE1, "slow-medium", "task-max"]);
  const small = fitTable({ prior: baseTable(), ...direct(adoptionInput({ cheapFails: false, n: 19 })), guard: atN });
  assert.deepEqual(small.rows, { "*": "slow-high" });
  // A booked row with no cost on record makes its Pull unpriced: out of the cell's n, so the cell falls under n=20.
  const input = adoptionInput({ cheapFails: false });
  input.members[30].cost = "";
  const unpriced = fitTable({ prior: baseTable(), ...direct(input), guard: atN });
  const smol = unpriced.estimates["*"]["smol-high"];
  assert.deepEqual([smol.n, smol.unpriced, smol.usd_per_merged], [19, 1, 2]);
  assert.deepEqual(unpriced.rows, { "*": "slow-high" });
});

test("fit: a non-exploration row a live B classifier routed is the A/B's test set, not fit input", () => {
  const features = [
    featureRow({ ticket: "1", sizing_src: "haiku", chosen_cell: "task-high" }),
    featureRow({ ticket: "2", sizing_src: "haiku", chosen_cell: "task-high", exploration_draw: "1/2" }),
    featureRow({ ticket: "3" }),
  ];
  const next = fitDirect({ features, members: [], verdicts: [] }, atN);
  assert.equal(next.n_rows, 2);
  assert.equal(next.estimates["*"]["task-high"].n, 1);
});

test("fit --due counts merged PRs whose features rows are not in the fitted commit, against the cadence", (t) => {
  const old = Array.from({ length: 10 }, (_, i) => featureRow({ ticket: String(i + 1), run_date: "2026-10-05" }));
  const fresh = Array.from({ length: 50 }, (_, i) => featureRow({ ticket: String(i + 11), run_date: "2026-10-05" }));
  const ruledAll = (rows) => rows.map((f) => ({ ticket: f.ticket, pr: String(Number(f.ticket) + 500), run_date: f.run_date }));
  const p = fitWorld(t, { features: old, members: [], verdicts: ruledAll(old) });
  assert.equal(fitCli(p).status, 0);
  p.write({ features: [...old, ...fresh], verdicts: ruledAll([...old, ...fresh.slice(0, 39)]) });
  p.commit();
  const before = readFileSync(p.table, "utf8");
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=no MERGED=39/50\n", "the ten fitted Pulls, ruled, are not counted");
  assert.equal(readFileSync(p.table, "utf8"), before, "--due writes nothing");
  p.write({ features: [...old, ...fresh], verdicts: ruledAll([...old, ...fresh]) });
  p.commit();
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=yes MERGED=50/50\n");
});

test("fit --due before any fit counts every merged PR in the window", (t) => {
  const features = Array.from({ length: 3 }, (_, i) => featureRow({ ticket: String(i + 1) }));
  const p = fitWorld(t, { features, members: [], verdicts: features.map((f) => ({ ticket: f.ticket, pr: String(Number(f.ticket) + 500) })) });
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=no MERGED=3/50\n");
});

test("fit --due counts only counted Pulls: a merged PR whose Pull has no Admissible row is not one", (t) => {
  const features = Array.from({ length: 3 }, (_, i) => featureRow({ ticket: String(i + 1) }));
  const verdicts = features.map((f) => ({ ticket: f.ticket, pr: String(Number(f.ticket) + 500) }));
  const p = fitWorld(t, { features, members: [implementer(features[0], { pr: "501", ending: "pr", subagent_type: "fleet-implementer-task-high" })], verdicts });
  assert.equal(fitCli(p, ["--due"]).stdout, "DUE=no MERGED=2/50\n");
});

// mergedSince over `features`, every row given its implementer.
const since = ({ table = baseTable(), features, verdicts, fitted = [] }) => mergedSince({ table, features, members: parsedMembers(features, verdicts, []), verdicts, fitted });

test("mergedSince: counts the rows the fitted commit's features file does not hold, matched by session and agent, on or after window_start", () => {
  const features = ["2026-09-30", "2026-10-01", "2026-10-02"].map((d, i) => featureRow({ ticket: String(i + 1), run_date: d }));
  const verdicts = features.map((f) => verdictRow({ ticket: f.ticket, pr: String(Number(f.ticket) + 500), run_date: "2026-10-03" }));
  const count = (over, fitted = []) => since({ table: baseTable(over), features, verdicts, fitted });
  assert.equal(count({}), 3, "nothing fitted, no window: every ruled Pull counts");
  assert.equal(count({}, [features[0]]), 2, "a row the fitted commit holds is already fitted");
  assert.equal(count({}, [{ ...features[1], run_date: "2026-01-01", ticket: "99" }]), 2, "matched by session and agent, whatever the row's date or ticket");
  assert.equal(count({}, [{ ...features[1], session: SESSION2 }]), 3, "another session's row is not this one");
  assert.equal(count({}, [{ ...features[1], agent: "impl-99" }]), 3, "another agent's row is not this one");
  assert.equal(count({}, features), 0, "every row fitted");
  assert.equal(count({ window_start: "2026-10-01" }), 2, "the window_start day itself is inside the window");
  assert.equal(count({ window_start: "2026-10-02" }, [features[0]]), 1, "the window bounds what the fitted commit does not hold");
  assert.equal(mergedSince({ table: baseTable(), features, members: parsedMembers(features, verdicts, []), verdicts: verdicts.slice(1), fitted: [] }), 2,
    "a Pull with no verdict is not a merged PR");
});

test("mergedSince: a Pull is merged only on a ruling dated on or after it, a row with both verdict columns blank skipped", () => {
  const features = [featureRow({ ticket: "1", run_date: "2026-10-03" })];
  const count = (verdicts) => since({ features, verdicts });
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-02" })]), 0, "a ruling dated before the Pull predates it");
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-03", closed_own_ticket: "", minted_false_claim: "" })]), 0, "a both-blank row was never ruled");
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-03" })]), 1, "a ruling dated the day of the Pull rules it");
});

test("mergedSince: a ticket Pulled twice merges once, through the Pull whose implementer opened the ruled PR", () => {
  const first = featureRow({ ticket: "1", run_date: "2026-10-01" });
  const second = featureRow({ ticket: "1", run_date: "2026-10-03", session: SESSION2 });
  const features = [first, second];
  const verdicts = [verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-03" })];
  const members = parseMemberTsv(tsv(MEMBER_COLUMNS, [implementer(first), implementer(second, { pr: "11", ending: "pr" })].map(memberRow)));
  const count = (fitted) => mergedSince({ table: baseTable(), features, members, verdicts, fitted });
  assert.equal(count([]), 1);
  assert.equal(count([first]), 1, "the fitted first Pull never merged");
  assert.equal(count([second]), 0, "the merging Pull is fitted");
});

test("mergedSince: a features row whose run_date is blank is no Pull, with neither bound set as with one set", () => {
  // route() writes a blank run_date for a session id with no date prefix.
  const features = [featureRow({ ticket: "2", run_date: "2026-10-03" }), featureRow({ ticket: "2", run_date: "", session: SESSION2 })];
  const count = (verdicts, over = {}) => since({ table: baseTable(over), features, verdicts });
  const early = verdictRow({ ticket: "2", pr: "22", run_date: "2026-01-01", minted_false_claim: "yes" });
  assert.equal(count([early]), 0, "a ruling dated before the dated row predates that Pull");
  assert.equal(count([early], { window_start: "2026-01-01" }), 0, "the same with window_start set");
  assert.equal(count([verdictRow({ ticket: "2", pr: "22", run_date: "2026-10-03" })]), 1, "a ruling on or after the dated row still rules it");
  assert.equal(since({ features: [featureRow({ ticket: "3", run_date: "" })], verdicts: [verdictRow({ ticket: "3", pr: "33" })] }), 0,
    "a ticket whose only row is blank-dated has no Pull to rule");
});

test("mergedSince refuses a features row whose run_date is neither blank nor YYYY-MM-DD, with window_start set or not, rather than dropping it", () => {
  const dated = featureRow({ ticket: "2", run_date: "2026-10-03" });
  for (const bad of ["10/01/2026", "2026-10-1", "2026", "abc"]) {
    for (const over of [{}, { window_start: "2026-01-01" }]) {
      assert.throws(
        () => mergedSince({ table: baseTable(over), features: [dated, featureRow({ ticket: "5", run_date: bad })], members: [], verdicts: [], fitted: [] }),
        (e) => e.message.includes("ticket #5") && e.message.includes(`run_date is '${bad}', expected YYYY-MM-DD or blank`),
        `${JSON.stringify(over)}, run_date ${bad}`,
      );
    }
  }
});

test("fit refuses an unreadable guard or input file at exit 2 and leaves the table alone", (t) => {
  const p = fitWorld(t, { features: [], members: [], verdicts: [], guard: null });
  const r = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read --guard/);
  writeFileSync(p.features, "not\tthe\theader\n");
  const bad = p.commit();
  const r2 = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", bad]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /cannot read --features/);
  writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true, fitted_commit: bad })));
  const r3 = cli(["--check", ...p.fitArgs]);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /cannot read --features/);
  assert.equal(readFileSync(p.table, "utf8"), JSON.stringify(baseTable({ burn_in: true, fitted_commit: bad })));
});

test("fit: a Pull's verdict is its ticket's last ruling dated on or after it, a row with both verdict columns blank skipped", () => {
  // Ticket 2, in another cell, has a later row than ticket 1's Pull; it moves nothing for ticket 1.
  const features = [exploring({ ticket: "1", run_date: "2026-10-03" }), exploring({ ticket: "2", run_date: "2026-10-05", chosen_cell: "task-high" })];
  const fit = (verdicts) => fitDirect({ features, members: [], verdicts }).estimates["*"]["slow-high"];
  const failed = ruled(1, 11, { run_date: "2026-10-03", minted_false_claim: "yes" });
  const blank = ruled(1, 11, { run_date: "2026-10-04", closed_own_ticket: "", minted_false_claim: "" });
  assert.equal(fit([failed, blank]).fail_rate, 1, "a both-blank row after a real ruling was never ruled, so the ruling stands");
  assert.equal(fit([blank]).merged, 0, "a Pull whose only row is both-blank has no verdict");
  assert.equal(fit([ruled(1, 11, { run_date: "2026-10-02", minted_false_claim: "yes" })]).merged, 0, "a ruling dated before the Pull predates it");
  const pass = ruled(1, 11, { run_date: "2026-10-03" });
  assert.deepEqual(fit([pass]), { ...fit([pass]), merged: 1, fail_rate: 0 }, "a ruling dated the day of the Pull rules it");
  assert.equal(fit([pass, ruled(1, 11, { run_date: "2026-10-05", minted_false_claim: "yes" })]).fail_rate, 1, "the last such ruling wins");
});

test("fit: a ticket Pulled twice is two units, each in its own row's cell and stratum, and its merge counts once", () => {
  const first = exploring({ ticket: "1", run_date: "2026-10-01", chosen_cell: "task-high", brief_chars: "100" });
  const second = exploring({ ticket: "1", run_date: "2026-10-03", chosen_cell: "smol-high", brief_chars: "5000", session: SESSION2 });
  const next = fitDirect({
    features: [first, second], members: [implementer(second, { pr: "11", ending: "pr", cost: "3" })], verdicts: [ruled(1, 11, { run_date: "2026-10-03" })],
  });
  assert.equal(next.n_rows, 2);
  assert.deepEqual([next.estimates.light["task-high"].n, next.estimates.light["task-high"].merged], [1, 0]);
  assert.deepEqual([next.estimates.heavy["smol-high"].n, next.estimates.heavy["smol-high"].merged], [1, 1]);
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 3, "the hollow first Pull's $1 is task-high's spend, not smol-high's");
});

test("fit: a features row whose run_date is blank is no input row", () => {
  // route() writes a blank run_date for a session id with no date prefix; ticket 9's blank row sits in another cell.
  const features = [
    exploring({ ticket: "2", run_date: "2026-10-03" }),
    exploring({ ticket: "2", run_date: "", chosen_cell: "smol-high", session: SESSION2 }),
    exploring({ ticket: "9", run_date: "", chosen_cell: "task-high" }),
  ];
  const early = ruled(2, 22, { run_date: "2026-01-01", minted_false_claim: "yes" });
  const fit = (verdicts) => fitDirect({ features, members: [], verdicts });
  const t = fit([early, ruled(9, 99)]);
  assert.deepEqual(Object.keys(t.estimates["*"]), ["slow-high"], "neither blank row sets a cell or adds a Pull");
  assert.equal(t.n_rows, 1);
  assert.equal(t.estimates["*"]["slow-high"].merged, 0, "a ruling dated before the dated row predates that Pull");
  assert.equal(fit([ruled(2, 22, { run_date: "2026-10-03" })]).estimates["*"]["slow-high"].merged, 1, "a ruling on or after the dated row rules it");
});

test("fit refuses a features row whose run_date is neither blank nor YYYY-MM-DD rather than dropping it", () => {
  const dated = exploring({ ticket: "1", run_date: "2026-10-03" });
  for (const bad of ["10/01/2026", "2026-10-1", "2026", "abc"]) {
    assert.throws(
      () => fitDirect({ features: [dated, exploring({ ticket: "7", run_date: bad })], members: [], verdicts: [] }),
      (e) => e.message.includes("ticket #7") && e.message.includes(`run_date is '${bad}', expected YYYY-MM-DD or blank`),
      `run_date ${bad}`,
    );
  }
});

test("fit, fit --due and --check refuse at exit 2 a features row whose run_date is neither blank nor YYYY-MM-DD, and leave the table alone; a blank one is not refused", (t) => {
  const p = fitWorld(t, { features: [exploring({ ticket: "1" }), exploring({ ticket: "7", run_date: "10/01/2026" })], members: [], verdicts: [ruled(1, 11)] });
  // --check re-fits the commit the table records, so the table records the one holding the row.
  writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true, fitted_commit: p.git("rev-parse", "HEAD") })));
  const before = readFileSync(p.table, "utf8");
  const fitArgs = ["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"];
  for (const args of [fitArgs, [...fitArgs, "--due"], ["--check", ...p.fitArgs]]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /cannot join --features .*, --members .* and --verdicts .*: ticket #7: a ticket-features row's run_date is '10\/01\/2026', expected YYYY-MM-DD or blank/);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
  p.write({ features: [exploring({ ticket: "1" }), exploring({ ticket: "7", run_date: "" })], verdicts: [ruled(1, 11)] });
  p.commit();
  for (const args of [[...fitArgs, "--due"], fitArgs]) {
    const r = cli(args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  }
});

test("fit, fit --due and --check refuse at exit 2 a booked cost that is neither blank nor a number, naming the row, and leave the table alone", (t) => {
  const f = exploring({ ticket: "1" });
  const p = fitWorld(t, { features: [f], members: [implementer(f, { pr: "11", ending: "pr", cost: "n/a" })], verdicts: [ruled(1, 11)] });
  writeFileSync(p.table, JSON.stringify(baseTable({ burn_in: true, fitted_commit: p.git("rev-parse", "HEAD") })));
  const before = readFileSync(p.table, "utf8");
  const fitArgs = ["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"];
  for (const args of [fitArgs, [...fitArgs, "--due"], ["--check", ...p.fitArgs]]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /: member-outcomes row session \S+ agent impl-1: cost 'n\/a' is not a number/);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
});

test("fit refuses at exit 2 a ruling of an input ticket whose run_date is not YYYY-MM-DD, and leaves the table alone; one of a ticket outside the input is not refused", (t) => {
  const features = [exploring({ ticket: "1" })];
  const p = fitWorld(t, { features, members: [], verdicts: [ruled(1, 11), ruled(2, 12, { run_date: "10/01/2026" })] });
  const before = readFileSync(p.table, "utf8");
  for (const mode of [["--due"], []]) {
    const ok = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD", ...mode]);
    assert.equal(ok.status, 0, `fit ${mode.join(" ")}: ${ok.stderr}`);
  }
  writeFileSync(p.table, before);
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11, { run_date: "10/01/2026" })].map(verdictRow)));
  p.commit();
  for (const mode of [[], ["--due"]]) {
    const r = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD", ...mode]);
    assert.equal(r.status, 2, `fit ${mode.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /ticket #1 \(PR #11\): run_date is '10\/01\/2026', expected YYYY-MM-DD/);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
});

test("fit refuses at exit 2 a ruling of an input ticket whose run_date is not YYYY-MM-DD, whatever the string, as fit --due does", (t) => {
  const features = [exploring({ ticket: "1" })];
  const p = fitWorld(t, { features, members: [], verdicts: [ruled(1, 11)] });
  const before = readFileSync(p.table, "utf8");
  // Each of these sorts after "2026-10-01", so a string comparison against a date would misplace it.
  for (const bad of ["abc", "zzz", "2027", "2026-13-45x"]) {
    writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11, { run_date: bad })].map(verdictRow)));
    p.commit();
    for (const mode of [[], ["--due"]]) {
      const r = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD", ...mode]);
      assert.equal(r.status, 2, `run_date ${bad}, fit ${mode.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`ticket #1 \\(PR #11\\): run_date is '${bad}', expected YYYY-MM-DD`));
      assert.equal(r.stdout, "");
    }
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
  // The same junk on a ticket outside the input is still not refused.
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11), ruled(2, 12, { run_date: "zzz" })].map(verdictRow)));
  p.commit();
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"]).status, 0);
});

test("fit and fit --due both refuse a ruling whose run_date is not YYYY-MM-DD on a windowed Pull the fit then skips as a live B classifier's: every windowed Pull is booked first", (t) => {
  const features = [exploring({ ticket: "1" }), featureRow({ ticket: "3", exploration_draw: "", sizing_src: "" })];
  const p = fitWorld(t, { features, members: [], verdicts: [ruled(1, 11), ruled(3, 13, { run_date: "10/01/2026" })] });
  for (const mode of [["--due"], []]) {
    const r = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD", ...mode]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /ticket #3 \(PR #13\): run_date is '10\/01\/2026', expected YYYY-MM-DD/);
  }
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
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"]).status, 0);
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0);
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, [ruled(1, 11, { run_date: "10/01/2026" })].map(verdictRow)));
  const bad = p.commit();
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0, "the table's own commit is unaffected by a later one");
  writeFileSync(p.table, JSON.stringify({ ...JSON.parse(readFileSync(p.table, "utf8")), fitted_commit: bad }));
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ticket #1 \(PR #11\): run_date is '10\/01\/2026', expected YYYY-MM-DD/);
  assert.equal(r.stdout, "");
});

test("fit: a Pull's $ is its booked members' cost, never its router_usd", () => {
  const f = exploring({ ticket: "1", router_usd: "0.5" });
  const next = fitDirect({ features: [f], members: [implementer(f, { pr: "11", ending: "pr", cost: "3" })], verdicts: [ruled(1, 11)] });
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, 3);
});

test("fit: members whose cost does not vary with the cell are not booked against a Pull", () => {
  const f = exploring({ ticket: "1" });
  const named = (member, cost) => memberRow({ agent: member, member, pr: "11", cost });
  const members = [implementer(f, { pr: "11", ending: "pr", cost: "2" }), named("merge-bot-9", "100"), named("memory", "200"), named("__advisor", "400")];
  const next = fitDirect({ features: [f], members, verdicts: [ruled(1, 11)] });
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, 2);
});

test("fit: a Pull books its implementers in its session, a claim resumed in a later session, and its PR's members, and no other row", () => {
  const LATER = "2026-10-02T10-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847c1";
  const features = [
    exploring({ ticket: "1", chosen_cell: "slow-high" }),
    exploring({ ticket: "2", chosen_cell: "task-high" }),
    exploring({ ticket: "3", chosen_cell: "smol-high" }),
  ];
  const members = [
    implementer(features[0], { pr: "701", ending: "pr", cost: "2" }),
    // A claim resumed in a later session that holds no Pull of ticket 1.
    implementer(features[0], { session: LATER, run_date: "2026-10-02", agent: "impl-1-b", member: "impl-1-b", subagent_type: "fleet-implementer-task-high", cost: "1" }),
    implementer(features[1], { pr: "702", ending: "pr", cost: "3" }),
    memberRow({ session: LATER, agent: "review-pr-702", member: "review-pr-702", pr: "702", cost: "4" }),
    memberRow({ session: LATER, agent: "fix-pr-702/fix-pr-702.RefuteU1", member: "fix-pr-702/fix-pr-702.RefuteU1", cost: "5" }),
    memberRow({ session: LATER, agent: "fix-pr-702", member: "fix-pr-702", pr: "702", cost: "6" }),
    implementer(features[2], { pr: "703", ending: "pr", cost: "7" }),
    // An implementer of a ticket with no Pull, and one in an earlier session than ticket 3's only Pull, book nowhere.
    memberRow({ agent: "impl-9", member: "impl-9", ticket: "9", role: "implementer", cost: "1000" }),
    implementer(features[2], { session: "2026-09-30T10-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847c2", run_date: "2026-09-30", cost: "2000" }),
  ];
  const verdicts = [ruled(1, 701), ruled(2, 702), ruled(3, 703)];
  const est = fitDirect({ features, members, verdicts }).estimates["*"];
  assert.equal(est["slow-high"].usd_per_merged, 3, "the resumed claim at another cell books to the Pull's own cell");
  assert.equal(est["task-high"].usd_per_merged, 18, "the PR's review, fix and the fix's nested member, wherever they ran");
  assert.equal(est["smol-high"].usd_per_merged, 7);
});

test("fit: features rows dated before the window are not the fit's", () => {
  const features = [exploring({ ticket: "1", run_date: "2026-08-31" }), exploring({ ticket: "2", run_date: "2026-09-01", session: SESSION2 })];
  const next = fitDirect({ features, members: [], verdicts: [ruled(2, 12, { run_date: "2026-09-01" })] }, { window_start: "2026-09-01" });
  assert.equal(next.n_rows, 1, "the window's first day is in; the day before is out");
  assert.deepEqual([next.estimates["*"]["slow-high"].n, next.estimates["*"]["slow-high"].merged], [1, 1]);
});

// Pulls in one cell mixing ruled-pass, ruled-failure and not-yet-ruled, each implementer booked at $2.
function unmergedMix() {
  const ids = ["1", "2", "3", "4"];
  const features = ids.map((ticket) => exploring({ ticket }));
  return {
    features,
    members: features.map((f) => implementer(f, { pr: String(Number(f.ticket) + 10), ending: "pr", cost: "2" })),
    verdicts: [ruled(1, 11), ruled(2, 12, { minted_false_claim: "yes" })],
  };
}

test("fit: a cell's fail rate is its false claims over its claims, not over every Pull in it", () => {
  const e = fitDirect(unmergedMix()).estimates["*"]["slow-high"];
  assert.equal(e.n, 4);
  assert.equal(e.merged, 2);
  assert.equal(e.fail_rate, 0.5);
});

test("fit: a cell's $ per merged PR spreads every counted Pull's spend over the merged PRs, not over every Pull", () => {
  assert.equal(fitDirect(unmergedMix()).estimates["*"]["slow-high"].usd_per_merged, 4);
});

test("fit: a Pull that never merged and ended only on the ticket's or neither's endings is left out of the cell's n and $", () => {
  const input = unmergedMix();
  input.members[2].ending = "bail:undecided";
  input.members[2].pr = "";
  input.members[3].ending = "provider";
  input.members[3].pr = "";
  const e = fitDirect(input).estimates["*"]["slow-high"];
  assert.deepEqual([e.n, e.merged, e.left_out, e.usd_per_merged], [2, 2, 2, 2]);
});

// `[cell, usd, n]` entries: n Pulls in the cell, each implementer booked at `usd` and ruled a pass, so the cell's $ per merged PR is `usd`.
function cellInput(spec) {
  const features = [];
  const members = [];
  const verdicts = [];
  let ticket = 100;
  for (const [cell, usd, n = 20] of spec) {
    for (let i = 0; i < n; i++, ticket++) {
      const f = exploring({ ticket: String(ticket), chosen_cell: cell });
      features.push(f);
      members.push(implementer(f, { pr: String(ticket + 1000), ending: "pr", cost: String(usd) }));
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

test("fit: an unpriced default-cell Pull leaves the stratum below n=20, so it adopts nothing, even from a cell that cost nothing", () => {
  const input = cellInput([["slow-high", 10], ["smol-high", 0]]);
  input.members[0].cost = "";
  const next = fitDirect(input);
  assert.deepEqual([next.estimates["*"]["slow-high"].n, next.estimates["*"]["slow-high"].unpriced], [19, 1]);
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
  const next = fitTable({ prior, ...direct(cellInput([["slow-high", 10], ["smol-high", 2]])), guard: { tripped: [], n, window_start: null } });
  assert.equal(next.stage, 2);
  assert.deepEqual(next.cells, [...STAGE1, "slow-medium", "task-max"]);
});

test("fit: stage 2 adds no effort cell on a role the table holds no stage-1 cell for", () => {
  const prior = baseTable({ cells: ["slow-high", "smol-high"] });
  const n = { "slow-high": 20, "smol-high": 20 };
  const next = fitTable({ prior, ...direct(cellInput([["slow-high", 10], ["smol-high", 2]])), guard: { tripped: [], n, window_start: null } });
  assert.equal(next.stage, 2);
  assert.deepEqual(next.cells, ["slow-high", "smol-high", "slow-medium"]);
});
