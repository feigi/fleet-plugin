import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLUMNS, DEFAULT_TABLE, issueMetrics, ruleStratum, route, fitTable, readGuard, validateTable, parseFeatures, formatFeatureRow,
} from "./ticket-router.mjs";
import { drawCell, CELL } from "./ledger-grammar.mjs";
import { COLUMNS as MEMBER_COLUMNS } from "./member-outcomes.mjs";
import { COLUMNS as VERDICT_COLUMNS } from "./tier-outcomes.mjs";

const SCRIPT = fileURLToPath(new URL("./ticket-router.mjs", import.meta.url));
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
    assert.ok(existsSync(fileURLToPath(new URL(`../agents/fleet-implementer-${c}.agent.md`, import.meta.url))), `${c} has no definition`);
  }
});

test("route: pure — the same inputs give the same line, and the line names every field", () => {
  const args = { session: SESSION, ticket: 9, arm: "A", implRow: 10, issue: issue(), guard: readGuard(guardFile()), table: baseTable() };
  const a = route(args);
  assert.deepEqual(route(args), a);
  assert.match(a.line, /^POLICY=\S+ CELL=\S+ DRAW=\S+ STRATUM=(light|heavy|unknown) REASON=\S+$/);
  assert.equal(formatFeatureRow(a.row).split("\t").length, COLUMNS.length);
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

// ---------------------------------------------------------------------------
// fit and --check
// ---------------------------------------------------------------------------

const featureRow = (over) => ({
  run_date: "2026-10-01", session: SESSION, agent: `impl-${over.ticket}`, policy_cell: "slow-high", chosen_cell: "slow-high",
  exploration_draw: "", sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0",
  age_days: "1", paths: "0", test_paths: "0", xrefs: "0", kind: "bug", ...over,
});
const memberRow = (over) => Object.fromEntries(MEMBER_COLUMNS.map((c) => [c, ""]).concat(Object.entries({ session: SESSION, ...over })));
const verdictRow = (over) => ({ run_date: "2026-10-02", class: "", tier: "", note: "n", sizing: "", profile: "", loc: "", files: "", closed_own_ticket: "yes", minted_false_claim: "no", ...over });
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
  const verdicts = features.map((f) => ({ ticket: f.ticket, pr: String(Number(f.ticket) + 500) }));
  const p = fitWorld(t, { features, members: [], verdicts: verdicts.slice(0, 49), table: baseTable({ fitted_through: "2026-10-01" }) });
  const before = readFileSync(p.table, "utf8");
  const no = cli(["fit", ...p.fitArgs, "--guard", p.guard, "--due"]);
  assert.equal(no.stdout, "DUE=no MERGED=49/50\n");
  assert.equal(readFileSync(p.table, "utf8"), before, "--due writes nothing");
  writeFileSync(p.verdicts, tsv(VERDICT_COLUMNS, verdicts.map(verdictRow)));
  assert.equal(cli(["fit", ...p.fitArgs, "--guard", p.guard, "--due"]).stdout, "DUE=yes MERGED=50/50\n");
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
