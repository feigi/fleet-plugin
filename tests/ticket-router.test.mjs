import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import {
  DEFAULT_TABLE, assignmentProb, bArmLive, explorationCells, installOf, installVersion, issueMetrics, route, rowDispatch, rowFor, fitTable, readGuard, stratumOf, validateTable, formatFeatureRow, mergedSince, resolveCommit, sliceParent,
} from "../plugin/scripts/ticket-router.mjs";
import { AttributionError, FEATURE_COLUMNS as COLUMNS, parseFeatures } from "../plugin/scripts/pull-attribution.mjs";
import { drawCell, CELL, STARTING_CELLS, formatRouting, parseRouting } from "../plugin/scripts/ledger-grammar.mjs";
import { COLUMNS as MEMBER_COLUMNS, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as VERDICT_COLUMNS } from "../plugin/scripts/tier-outcomes.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { DAY_ONE_TABLE } from "./support/day-one-router-table.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ticket-router.mjs", import.meta.url));
const SESSION = "2026-10-01T10-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847a9";
const SESSION2 = "2026-10-01T11-00-00-000Z_01a0b344-33f6-7640-96a8-05f45bf847b0";
const STARTING = ["slow-high", "task-high", "smol-high"];
// The columns #4159 appended after `parent`, and the version the install's package.json names.
const NAMED = ["named_paths", "named_lines", "dirs", "title", "plugin_version"];
// The column after them: the probability `route` assigned the Pull its Cell with.
const PROB = "assignment_prob";
const INSTALLED_VERSION = JSON.parse(readFileSync(new URL("../plugin/package.json", import.meta.url), "utf8")).version;

// A table's `rows` or `reasons`: one set per objective, the speed set the cost set's unless named.
const both = (cost, speed = cost) => ({ cost, speed });
const UNJUDGED = { cell: "slow-high", reason: "unjudged", cells: {}, pairs: [] };
const baseTable = (over = {}) => ({
  window_start: null, fitted_commit: null, n_rows: 0, cells: [...STARTING], burn_in: false,
  splits: {}, rows: both({ "*": "slow-high" }), classifier: { b: null, tau: null }, estimates: {},
  reasons: both({ "*": UNJUDGED }), guard: { tripped: [], n: {} }, ...over,
});
// A two-leaf tree: the root splits on brief_chars at CUT into a group above it and one at or below it, each named by
// its rule path. `cost` and `speed` are the two row sets, naming `*`, ABOVE and BELOW; each node's reasons record is
// unjudged unless `over` says.
const CUT = 4047;
const ABOVE = `brief_chars>${CUT}`;
const BELOW = `brief_chars<=${CUT}`;
const SPLITS = { "*": { input: "brief_chars", cut: CUT } };
const twoLeaf = (cost, speed = cost, over = {}) => baseTable({
  splits: SPLITS, rows: { cost, speed }, reasons: both(Object.fromEntries(Object.keys(cost).map((node) => [node, UNJUDGED]))), ...over,
});
const guardFile = (over = {}) => ({
  computed_at: "2026-10-01T00:00:00Z", window_start: "2026-09-01",
  baseline: { cell: "slow-high", n: 5, mean_usd: 10, fail_rate: 0.5 },
  cells: STARTING.map((cell) => ({ cell, n: 5, mean_usd: 5, fail_rate: 0.5 })), tripped: [], verdict: "none", ...over,
});
const issue = (over = {}) => ({
  title: "t", body: "short brief\n- [ ] one\n- [x] two", comments: [], labels: [{ name: "bug" }],
  createdAt: new Date(Date.now() - 3.5 * 86_400_000).toISOString(), ...over,
});
// An issue whose brief is `chars` characters long and holds no criterion.
const issueOf = (chars, over = {}) => issue({ body: "x".repeat(chars), ...over });

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
// The install every routed Pull reads here, fixed so no test depends on the machine's omp: each role's model, and a
// catalog whose `smol` model tops out at `xhigh` while the other two reach `max`. The definitions are the plugin's own.
const MODEL_ROLES = { slow: "anthropic/claude-opus-5-5:high", task: "anthropic/claude-sonnet-5-5:high", smol: "anthropic/claude-haiku-4-5:auto" };
const CATALOG = { models: [
  { selector: "anthropic/claude-opus-5-5", thinking: ["low", "medium", "high", "xhigh", "max"] },
  { selector: "anthropic/claude-sonnet-5-5", thinking: ["low", "medium", "high", "xhigh", "max"] },
  { selector: "anthropic/claude-haiku-4-5", thinking: ["minimal", "low", "medium", "high", "xhigh"] },
] };
const AGENTS = fileURLToPath(new URL("../plugin/agents", import.meta.url));
const INSTALL = installOf({ modelRoles: MODEL_ROLES, catalog: CATALOG, definitions: readdirSync(AGENTS) });
const INSTALL_DIR = mkdtempSync(join(tmpdir(), "ticket-router-install-"));
process.on("exit", () => rmSync(INSTALL_DIR, { recursive: true, force: true }));
writeFileSync(join(INSTALL_DIR, "model-roles.json"), JSON.stringify(MODEL_ROLES));
writeFileSync(join(INSTALL_DIR, "catalog.json"), JSON.stringify(CATALOG));
const INSTALL_FLAGS = ["--model-roles", join(INSTALL_DIR, "model-roles.json"), "--catalog", join(INSTALL_DIR, "catalog.json"), "--agents", AGENTS];
// Every `route` run here reads the fixed install, but for any part it names itself.
const installFlags = (args) => [0, 2, 4].flatMap((i) => (args.includes(INSTALL_FLAGS[i]) ? [] : INSTALL_FLAGS.slice(i, i + 2)));
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args, ...(args[0] === "route" ? installFlags(args) : [])], { encoding: "utf8" });
function routeCli(p, { ticket = 42, arm = "A", implRow = 3, objective = "cost", extra = [] } = {}) {
  return cli(["route", "--session", SESSION, "--ticket", String(ticket), "--arm", arm, "--impl-row", String(implRow),
    ...(objective === null ? [] : ["--objective", objective]),
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, ...extra]);
}
// A rule path holds `=` (`brief_chars<=4047`), so a word splits at its first one alone.
const parseLine = (stdout) => Object.fromEntries(stdout.trim().split(" ").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));

// ---------------------------------------------------------------------------
// route: one line, every REASON, exit 0 on every degradation
// ---------------------------------------------------------------------------

test("route: a clean non-exploration Pull prints the full line, REASON=ok, and records a features row", (t) => {
  const p = world(t);
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok\n");
  const lines = readFileSync(p.pending, "utf8").replace(/\n$/, "").split("\n");
  assert.equal(lines[0], COLUMNS.join("\t"), "a new pending file starts with the header");
  assert.equal(COLUMNS.length, 26);
  assert.deepEqual(COLUMNS.slice(-NAMED.length - 1), [...NAMED, PROB], "the new columns come after parent, in order");
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
  assert.equal(row.title, "t");
  assert.equal(row.plugin_version, INSTALLED_VERSION, "the install's package.json version");
  assert.deepEqual([row.named_paths, row.named_lines, row.dirs], ["", "", ""], "a brief that names no path");
  assert.equal(row.assignment_prob, "4/5", "past burn-in, a Pull that does not explore runs its group's Cell at 4 in 5");
  // A second Pull appends, never a second header.
  routeCli(p, { ticket: 43 });
  const again = readFileSync(p.pending, "utf8").replace(/\n$/, "").split("\n");
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
  const r = cli(["route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "3",
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
  const r = cli(["route", "--session", `/x/sessions/proj/${SESSION}/`, "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "3",
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].session, SESSION);
});

test("route: no-issue-json — a missing or unparseable issue file blanks the metrics, routes the root `*`, exits 0", (t) => {
  for (const issueJson of [null, "{not json"]) {
    const p = world(t, { issueJson });
    const r = routeCli(p);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLine(r.stdout), {
      POLICY: "slow-high", CELL: "slow-high", DRAW: "-", BY: "-", STRATUM: "*", BRIEF: "-", CRITERIA: "-", PARENT: "-", SIZED: "-", OBJECTIVE: "cost", TRIPPED: "-", REASON: "no-issue-json",
    });
    const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
    for (const c of ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "kind", "named_paths", "named_lines", "dirs", "title"]) assert.equal(row[c], "", c);
    assert.equal(row.plugin_version, INSTALLED_VERSION, "the version is no issue metric: it is still recorded");
  }
});

test("route: no-sizing — a live B Pull without a usable sizing file says so and routes by the tree as arm A does, exits 0", (t) => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "task-high" }, undefined, { classifier: { b: "haiku", tau: null } });
  const p = world(t, { table });
  const r = routeCli(p, { arm: "B" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseLine(r.stdout), {
    POLICY: "task-high", CELL: "task-high", DRAW: "-", BY: "-", STRATUM: BELOW, BRIEF: "31", CRITERIA: "2", PARENT: "-", SIZED: "-", OBJECTIVE: "cost", TRIPPED: "-", REASON: "no-sizing",
  });
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].sizing_src, "", "no verdict: no sizing source");
});

test("route: a live B Pull WITH a sizing verdict records its label and picks no group — the tree routes it, as it routes arm A", (t) => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high" }, undefined, { classifier: { b: "haiku", tau: null } });
  const p = world(t, { table, sizing: { source: "haiku", model: "m", label: "heavy", confidence: 1, usd: 0.0002 } });
  const r = routeCli(p, { arm: "B", extra: ["--sizing", p.sizing] });
  assert.equal(r.status, 0, r.stderr);
  // The brief is short, so the walk ends below the cut whatever the label says: the label is recorded and moves nothing.
  assert.deepEqual(parseLine(r.stdout), {
    POLICY: "smol-high", CELL: "smol-high", DRAW: "-", BY: "-", STRATUM: BELOW, BRIEF: "31", CRITERIA: "2", PARENT: "-", SIZED: "heavy", OBJECTIVE: "cost", TRIPPED: "-", REASON: "ok",
  });
  const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.equal(row.sizing_src, "haiku");
  assert.equal(row.sizing_pre, "heavy");
  assert.equal(row.router_usd, "0.0002");
});

test("route: arm B on a table whose B gate is closed routes exactly as arm A and never reads a sizing file", (t) => {
  const p = world(t);
  const r = routeCli(p, { arm: "B" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok\n");
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].sizing_src, "rule");
});

test("route: guard-missing — no guard (or an unparseable one) dispatches the default cell only, even in burn-in", (t) => {
  for (const guard of [null, "{nope", JSON.stringify({ tripped: "x" })]) {
    const p = world(t, { table: baseTable({ burn_in: true, rows: both({ "*": "task-high" }) }), guard });
    const r = routeCli(p, { implRow: 5 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLine(r.stdout), {
      POLICY: "slow-high", CELL: "slow-high", DRAW: "-", BY: "-", STRATUM: "*", BRIEF: "31", CRITERIA: "2", PARENT: "-", SIZED: "-", OBJECTIVE: "cost", TRIPPED: "-", REASON: "guard-missing",
    });
  }
});

// The route call the run makes: no `--table`, so the table is the Fit beside `--guard`, else the starting table.
const routeByFit = (p, { implRow = 3 } = {}) => cli(["route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A",
  "--impl-row", String(implRow), "--issue", p.issue, "--guard", p.guard, "--pending", p.pending]);
const fitFile = (p) => join(p.dir, "router-fit.json");
const writeFit = (p, table) => writeFileSync(fitFile(p), JSON.stringify({ computed_at: "2026-10-01T00:00:00.000Z", table }));

test("route: with no --table, the Fit beside --guard routes the Pull", (t) => {
  const p = world(t);
  writeFit(p, baseTable({ rows: both({ "*": "task-high" }) }));
  const r = routeByFit(p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok\n");
});

test("route: a Fit that is absent, unreadable, unparseable or invalid routes by the starting table, and REASON names which", (t) => {
  const cases = [
    ["fit-missing", () => {}],
    ["fit-unreadable", (p) => mkdirSync(fitFile(p))],
    ["fit-unreadable", (p) => writeFileSync(fitFile(p), "{nope")],
    ["fit-invalid", (p) => writeFileSync(fitFile(p), "null")],
    ["fit-invalid", (p) => writeFit(p, { ...baseTable(), cells: [] })],
  ];
  for (const [reason, make] of cases) {
    const p = world(t);
    make(p);
    const r = routeByFit(p);
    assert.equal(r.status, 0, `${reason}: ${r.stderr}`);
    const starting = routeCli({ ...p, table: DEFAULT_TABLE }, { ticket: 42 });
    assert.equal(starting.status, 0, starting.stderr);
    assert.deepEqual(parseLine(r.stdout), { ...parseLine(starting.stdout), REASON: reason }, reason);
  }
});

test("route: a deleted guard still routes slow-high with no draw, whatever the Fit holds — a valid one, none, or an invalid one", (t) => {
  for (const [fit, make] of [
    ["valid", (p) => writeFit(p, baseTable({ burn_in: true, rows: both({ "*": "task-high" }) }))],
    ["absent", () => {}],
    ["invalid", (p) => writeFileSync(fitFile(p), "null")],
  ]) {
    const p = world(t, { guard: null });
    make(p);
    for (const implRow of [3, 5]) {
      const r = routeByFit(p, { implRow });
      assert.equal(r.status, 0, `${fit}: ${r.stderr}`);
      assert.deepEqual(parseLine(r.stdout), {
        POLICY: "slow-high", CELL: "slow-high", DRAW: "-", BY: "-", STRATUM: "*", BRIEF: "31", CRITERIA: "2", PARENT: "-", SIZED: "-", OBJECTIVE: "cost", TRIPPED: "-", REASON: "guard-missing",
      }, `${fit} Fit, impl row ${implRow}`);
    }
  }
});

test("route: an explicit --table routes by that table and never reads the Fit", (t) => {
  const p = world(t);
  writeFit(p, baseTable({ rows: both({ "*": "task-high" }) }));
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^POLICY=slow-high CELL=slow-high .* REASON=ok\n$/);
});

test("route: guard-tripped — a tripped cell leaves the draw's pool, and the line says so", (t) => {
  const p = world(t, { table: baseTable({ burn_in: true }), guard: guardFile({ tripped: ["smol-high"], verdict: "tripped" }) });
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  const out = parseLine(r.stdout);
  assert.equal(out.REASON, "guard-tripped");
  assert.notEqual(out.CELL, "smol-high");
  assert.match(out.DRAW, /^[12]\/2$/);
  assert.equal(out.BY, "burn-in");
  assert.equal(out.TRIPPED, "smol-high", "the line names the Cell the guard left out");
  assert.equal(out.CELL, drawCell({ session: SESSION, ticket: 42, policyCell: null, cells: ["slow-high", "task-high"] }).cell);
});

test("route: an every-5th draw with a tripped Cell left out prints the draw, BY=every-5th and the tripped Cell", (t) => {
  const p = world(t, { guard: guardFile({ tripped: ["slow-xhigh"], verdict: "tripped" }) });
  const r = routeCli(p, { implRow: 5 });
  assert.equal(r.status, 0, r.stderr);
  const d = drawCell({ session: SESSION, ticket: 42, policyCell: null, cells: ["slow-medium", "task-xhigh"] });
  assert.equal(r.stdout, `POLICY=slow-high CELL=${d.cell} DRAW=${d.k}/2 BY=every-5th STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=slow-xhigh REASON=guard-tripped\n`);
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].assignment_prob, "1/10", "1 in 5 explores, then 1 in the 2 Cells left");
});

test("route: a drawn burn-in Pull prints the whole Routing, BY=burn-in", (t) => {
  const p = world(t, { table: baseTable({ burn_in: true }) });
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  const d = drawCell({ session: SESSION, ticket: 42, policyCell: null, cells: STARTING });
  assert.equal(r.stdout, `POLICY=slow-high CELL=${d.cell} DRAW=${d.k}/3 BY=burn-in STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok\n`);
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].assignment_prob, "1/3", "1 over the untripped starting Cells");
});

test("route: table-cell-tripped — a table row naming a tripped cell is replaced by the default without waiting for a re-fit", (t) => {
  const p = world(t, { table: baseTable({ rows: both({ "*": "task-high" }) }), guard: guardFile({ tripped: ["task-high"] }) });
  const r = routeCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseLine(r.stdout), {
    POLICY: "slow-high", CELL: "slow-high", DRAW: "-", BY: "-", STRATUM: "*", BRIEF: "31", CRITERIA: "2", PARENT: "-", SIZED: "-", OBJECTIVE: "cost", TRIPPED: "task-high", REASON: "table-cell-tripped",
  });
});

test("route: a non-default table row is dispatched when its cell is not tripped", (t) => {
  const p = world(t, { table: twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "task-high" }) });
  const r = routeCli(p);
  assert.equal(r.stdout, `POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=${BELOW} BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok\n`);
});

test("route: burn-in draws on EVERY Pull, uniformly over the starting Cells, the default included", (t) => {
  const p = world(t, { table: baseTable({ burn_in: true }) });
  const seen = new Set();
  for (let ticket = 1; ticket <= 30; ticket++) {
    const r = routeCli(p, { ticket, implRow: ticket });
    assert.equal(r.status, 0, r.stderr);
    const out = parseLine(r.stdout);
    const d = drawCell({ session: SESSION, ticket, policyCell: null, cells: STARTING });
    assert.equal(out.CELL, d.cell);
    assert.equal(out.DRAW, `${d.k}/3`);
    seen.add(out.CELL);
  }
  assert.deepEqual([...seen].sort(), [...STARTING].sort(), "thirty burn-in draws never reached every cell");
  // Reproducible from the row: the same session and ticket draw the same cell.
  assert.equal(routeCli(p, { ticket: 7 }).stdout, routeCli(p, { ticket: 7, implRow: 99 }).stdout);
});

// slow-high's exploration Cells on the fixed install: its own role a level up and down, and the smaller model a
// level up. slow has no bigger model.
const SLOW_HIGH_EXPLORES = ["slow-medium", "slow-xhigh", "task-xhigh"];

test("route: after burn-in only the Pull creating impl- row 5k draws, over the group's exploration Cells", (t) => {
  const p = world(t);
  for (const implRow of [1, 4, 6, 9, 11]) assert.equal(parseLine(routeCli(p, { implRow }).stdout).DRAW, "-", `row ${implRow}`);
  for (const implRow of [5, 10, 15]) {
    const out = parseLine(routeCli(p, { implRow }).stdout);
    const d = drawCell({ session: SESSION, ticket: 42, policyCell: null, cells: SLOW_HIGH_EXPLORES });
    assert.equal(out.CELL, d.cell);
    assert.equal(out.DRAW, `${d.k}/3`);
    assert.equal(out.BY, "every-5th");
  }
  const rows = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.deepEqual(rows.map((r) => r.assignment_prob), ["4/5", "4/5", "4/5", "4/5", "4/5", "1/15", "1/15", "1/15"],
    "a Pull that does not explore runs the group's Cell at 4 in 5; one that does, its drawn Cell at 1 in 5 times 1 in 3");
  const [, , explore] = rows.filter((r) => r.exploration_draw !== "");
  assert.ok(explore, "an exploration Pull records its draw");
  assert.ok(SLOW_HIGH_EXPLORES.includes(explore.chosen_cell));
});

test("route: the exploration share stays one impl- row in five", (t) => {
  const p = world(t);
  const drawn = Array.from({ length: 50 }, (_, i) => parseLine(routeCli(p, { ticket: i + 1, implRow: i + 1 }).stdout).DRAW !== "-");
  assert.deepEqual(drawn.flatMap((d, i) => (d ? [i + 1] : [])), [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
});

test("route: a chain head on row 5k does not draw — the assignment rolls to the next Pull", (t) => {
  const p = world(t);
  assert.equal(parseLine(routeCli(p, { implRow: 5, extra: ["--chain-head"] }).stdout).DRAW, "-");
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].assignment_prob, "1", "past burn-in a chain head runs its policy Cell for certain");
  // In burn-in every Pull draws, chain head or not, and records the burn-in draw's 1/N.
  const b = world(t, { table: baseTable({ burn_in: true }) });
  assert.notEqual(parseLine(routeCli(b, { implRow: 5, extra: ["--chain-head"] }).stdout).DRAW, "-");
  assert.equal(parseFeatures(readFileSync(b.pending, "utf8"))[0].assignment_prob, "1/3");
});

test("route: a group whose every exploration Cell is tripped has no draw and runs its Cell with probability 1", (t) => {
  const p = world(t, { guard: guardFile({ tripped: SLOW_HIGH_EXPLORES, verdict: "tripped" }) });
  for (const implRow of [3, 5]) {
    const r = routeCli(p, { implRow });
    assert.equal(r.status, 0, r.stderr);
    const out = parseLine(r.stdout);
    assert.deepEqual([out.CELL, out.DRAW, out.BY], ["slow-high", "-", "-"], `row ${implRow}`);
  }
  assert.deepEqual(parseFeatures(readFileSync(p.pending, "utf8")).map((r) => [r.exploration_draw, r.assignment_prob]), [["", "1"], ["", "1"]],
    "no exploring slot could take the Pull, so it is not 4/5 either");
});

test("route: a group whose every exploration Cell the install cannot run has no draw and runs its Cell with probability 1", (t) => {
  const p = world(t);
  const agents = join(p.dir, "agents");
  mkdirSync(agents);
  writeFileSync(join(agents, "fleet-implementer-slow-high.agent.md"), "");
  const r = routeCli(p, { implRow: 5, extra: ["--agents", agents] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok\n", "no draw, so no BY");
  const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.deepEqual([row.exploration_draw, row.assignment_prob], ["", "1"]);
});

test("route: an install it cannot read warns, draws nothing and still routes, exit 0", (t) => {
  const p = world(t);
  const r = cli(["route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "5",
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending,
    "--model-roles", join(INSTALL_DIR, "model-roles.json"), "--catalog", join(p.dir, "no-catalog.json"), "--agents", AGENTS]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseLine(r.stdout).DRAW, "-");
  assert.match(r.stderr, /WARNING cannot read what this install runs: .*no-catalog\.json.* — no exploration Cell is drawn/);
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].assignment_prob, "1");
});

test("route: an install read that parses but holds nothing to draw warns, and the Pull still routes, exit 0", (t) => {
  const p = world(t);
  const file = (name, value) => { const f = join(p.dir, name); writeFileSync(f, JSON.stringify(value)); return f; };
  const noAgents = join(p.dir, "no-agents");
  mkdirSync(noAgents);
  const cases = [
    [["--model-roles", file("null-roles.json", null)], /WARNING cannot read what this install runs: modelRoles is null, not a record of role to model — no exploration Cell is drawn/],
    [["--model-roles", file("list-roles.json", [])], /WARNING cannot read what this install runs: modelRoles is an array, not a record/],
    [["--catalog", file("no-models.json", {})], /WARNING cannot read what this install runs: omp's model catalog has no models list \(models: absent\)/],
    [["--model-roles", file("empty-roles.json", {})], /WARNING this install runs smol, task, slow at no level .* no exploration Cell of those roles is drawn/],
    [["--model-roles", file("wrapped-roles.json", { value: MODEL_ROLES })], /WARNING this install runs smol, task, slow at no level/],
    [["--catalog", file("empty-catalog.json", { models: [] })], /WARNING this install runs smol, task, slow at no level/],
    [["--model-roles", file("no-smol.json", { ...MODEL_ROLES, smol: undefined })], /WARNING this install runs smol at no level .* no exploration Cell of that role is drawn/],
    [["--agents", noAgents], /WARNING .*no-agents holds no implementer definition — no exploration Cell is drawn/],
  ];
  for (const [extra, warning] of cases) {
    const r = routeCli(p, { implRow: 5, extra });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, warning, extra.join(" "));
  }
  assert.equal(routeCli(p, { implRow: 5 }).stderr, "", "an install that runs every role warns nothing");
});

test("route: an omp that does not answer is killed and warns, and the Pull still routes, exit 0", (t) => {
  const p = world(t);
  const bin = join(p.dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "omp"), "#!/bin/sh\nexec sleep 60\n");
  const r = spawnSync(process.execPath, [SCRIPT, "route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A",
    "--impl-row", "5", "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, "--agents", AGENTS],
  { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 40_000 });
  assert.equal(r.signal, null, "the router returned on its own, before this test's own deadline");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING cannot read what this install runs: omp config get modelRoles --json did not answer in \d+ ms — no exploration Cell is drawn/);
  assert.equal(parseLine(r.stdout).DRAW, "-");
});

test("route: a burn-in Pull and a chain head read nothing of the install", (t) => {
  // An unreadable install would warn: neither of these reads it.
  const missing = ["--model-roles", "/nonexistent/m.json", "--catalog", "/nonexistent/c.json", "--agents", "/nonexistent"];
  const b = world(t, { table: baseTable({ burn_in: true }) });
  assert.equal(routeCli(b, { implRow: 5, extra: missing }).stderr, "");
  const p = world(t);
  assert.equal(routeCli(p, { implRow: 5, extra: ["--chain-head", ...missing] }).stderr, "");
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
  for (const bad of [{ ...baseTable(), cells: ["slow-high", "alt"] }, { ...baseTable(), rows: both({}) }, { ...baseTable(), burn_in: "yes" }]) {
    const q = world(t, { table: bad });
    const r = routeCli(q);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /router table:/);
  }
  assert.equal(existsSync(p.pending), false, "a refused route wrote a features row");
});

// With no --session the router takes the session directory the phase-0
// receipt `.fleet/phase0.json` records, in the git workspace it runs from, and
// with no --objective the objective it records. `run` gives `--objective cost`
// unless told `objective: null`.
function receiptWorld(t, receipt) {
  const p = world(t);
  assert.equal(spawnSync("git", ["init", "-q", p.dir], { encoding: "utf8", env: gitEnv() }).status, 0);
  mkdirSync(join(p.dir, ".fleet"), { recursive: true });
  if (receipt !== undefined) writeFileSync(join(p.dir, ".fleet", "phase0.json"), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
  const run = (session, { objective = "cost" } = {}) => spawnSync(process.execPath, [SCRIPT, "route", ...(session === undefined ? [] : ["--session", session]),
    ...(objective === null ? [] : ["--objective", objective]),
    "--ticket", "42", "--arm", "A", "--impl-row", "3", "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, ...INSTALL_FLAGS],
  { encoding: "utf8", cwd: p.dir, env: gitEnv() });
  return { ...p, run };
}
const receiptFor = (session, objective) => ({ run: null, session, scratch: "/scratch", objective, steps: {} });

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

test("route: no --objective is the one the phase-0 receipt records; a receipt that records none is exit 2 naming it, and nothing is recorded", (t) => {
  const p = receiptWorld(t, receiptFor(`/s/${SESSION2}`, "speed"));
  const r = p.run(SESSION, { objective: null });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseLine(r.stdout).OBJECTIVE, "speed");
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].objective, "speed");
  assert.equal(parseLine(p.run(SESSION, { objective: "cost" }).stdout).OBJECTIVE, "cost", "a given --objective wins over the receipt's");
  for (const [receipt, why] of [[undefined, "no receipt"], [receiptFor(`/s/${SESSION2}`), "it records no objective"], ["{", "unreadable: not JSON"]]) {
    const q = receiptWorld(t, receipt);
    const refused = q.run(SESSION, { objective: null });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, new RegExp(`no objective given and none in the phase-0 receipt \\S+/\\.fleet/phase0\\.json \\(${why}`));
    assert.equal(refused.stdout, "");
    assert.equal(existsSync(q.pending), false, `${why}: a refused route wrote a features row`);
  }
});

// What every shipped table must satisfy, whatever a re-fit made of it. It pins no `rows`, `burn_in` or
// `cells`: the day-one table's contents are tests/support/day-one-router-table.mjs's.
function assertShippable(table) {
  assert.equal(validateTable(table), table);
  const rowCells = Object.values(table.rows).flatMap((set) => Object.values(set));
  for (const c of new Set([...table.cells, ...rowCells])) {
    assert.ok(CELL.test(c));
    assert.ok(existsSync(fileURLToPath(new URL(`../plugin/agents/fleet-implementer-${c}.agent.md`, import.meta.url))), `${c} has no definition`);
  }
}

test("route: the checked-in table is valid and names only cells with a definition", () => {
  assertShippable(JSON.parse(readFileSync(DEFAULT_TABLE, "utf8")));
});

test("route: the shipped-table check passes a fitted table and fails a table validateTable refuses or one naming a cell with no definition", () => {
  const fitted = twoLeaf({ "*": "smol-high", [ABOVE]: "task-max", [BELOW]: "smol-high" }, { "*": "task-high", [ABOVE]: "task-high", [BELOW]: "task-high" }, {
    fitted_commit: "a".repeat(40), n_rows: 12, burn_in: false, cells: [...STARTING, "slow-medium", "task-max"],
  });
  assertShippable(fitted);
  assertShippable(baseTable());
  assert.throws(() => assertShippable({ ...fitted, burn_in: "no" }), /router table: `burn_in` is not a boolean/);
  assert.throws(() => assertShippable({ ...fitted, rows: both({ [ABOVE]: "slow-high", [BELOW]: "slow-high" }) }), /router table: `rows.cost` has no `\*` row/);
  assert.throws(() => assertShippable({ ...fitted, cells: [...STARTING, "smol-minimal"] }), /smol-minimal has no definition/);
  assert.throws(() => assertShippable({ ...fitted, rows: both({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "smol-minimal" }) }), /smol-minimal has no definition/);
});

test("route: pure — the same inputs give the same line, and the line names every field", () => {
  const args = { session: SESSION, ticket: 9, arm: "A", implRow: 10, issue: issue(), guard: readGuard(guardFile()), table: baseTable(), objective: "cost" };
  const a = route(args);
  assert.deepEqual(route(args), a);
  assert.match(a.line, /^POLICY=\S+ CELL=\S+ DRAW=\S+ BY=\S+ STRATUM=\* BRIEF=\S+ CRITERIA=\S+ PARENT=\S+ SIZED=\S+ OBJECTIVE=cost TRIPPED=\S+ REASON=\S+$/);
  assert.equal(formatRouting(parseRouting(a.line)), a.line, "the line is one the ledger's grammar reads back whole");
  assert.equal(formatFeatureRow(a.row).split("\t").length, COLUMNS.length);
});

// route() called directly, so the gate and sizing matrices need no process per case.
const routeIn = (over) => route({ session: SESSION, ticket: 42, arm: "B", implRow: 3, issue: issue(), guard: readGuard(guardFile()), table: baseTable(), objective: "cost", install: INSTALL, ...over });
// A two-leaf table with the B classifier set and a row that is not the default: the gate is open. The ordinary
// issue (31 chars) is below the cut and routes to its default row; a long brief routes above the cut, to task-high.
const liveB = (over = {}) => twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "slow-high" }, undefined, { classifier: { b: "haiku", tau: null }, ...over });
const haikuSizing = { source: "haiku", model: "m", label: "heavy", confidence: 1, usd: 0.5 };
const BELOW_LINE = `POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=${BELOW} BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok`;

test("route: arm B is live only on arm B, with a classifier set and some row not the default", () => {
  const cases = [
    ["a classifier but every row the default", liveB({ rows: both({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }) }), "B"],
    ["a non-default row but no classifier", liveB({ classifier: { b: null, tau: null } }), "B"],
    ["an open gate on arm A", liveB(), "A"],
  ];
  for (const [what, table, arm] of cases) {
    const { line, row } = routeIn({ table, arm, sizing: haikuSizing });
    assert.equal(line, BELOW_LINE, what);
    assert.equal(row.sizing_src, "rule", what);
    assert.equal(row.sizing_pre, "", what);
    assert.equal(row.router_usd, "", what);
  }
  const live = routeIn({ table: liveB(), arm: "B", sizing: haikuSizing });
  assert.equal(live.line, BELOW_LINE.replace("SIZED=-", "SIZED=heavy"), "the same inputs with the gate open and arm B do read the sizing, and record it");
  assert.deepEqual([live.row.sizing_src, live.row.sizing_pre, live.row.router_usd], ["haiku", "heavy", "0.5"]);
});

test("route: a live B sizing is read only when its source is the table's classifier and its label is light or heavy", () => {
  const refused = (table, sizing, what) => {
    const { line, row } = routeIn({ table, sizing });
    assert.equal(line, BELOW_LINE.replace("REASON=ok", "REASON=no-sizing"), what);
    assert.equal(row.sizing_src, "", what);
    assert.equal(row.sizing_pre, "", what);
  };
  refused(liveB(), { ...haikuSizing, source: "jev" }, "a jev verdict on a haiku table");
  refused(liveB({ classifier: { b: "jev", tau: null } }), haikuSizing, "a haiku verdict on a jev table");
  refused(liveB(), { ...haikuSizing, source: undefined }, "no source");
  refused(liveB(), null, "no verdict at all");
  for (const label of ["medium", "Heavy", "", null, undefined, 1, ["heavy"]]) refused(liveB(), { ...haikuSizing, label }, `label ${JSON.stringify(label)}`);
  // The label picks no group: a light label on a brief above the cut is still routed to the group above it.
  const light = routeIn({ table: liveB(), issue: issueOf(5000), sizing: { ...haikuSizing, label: "light" } });
  assert.equal(light.line, `POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=${ABOVE} BRIEF=5000 CRITERIA=0 PARENT=- SIZED=light OBJECTIVE=cost TRIPPED=- REASON=ok`);
  assert.equal(light.row.sizing_pre, "light");
});

test("route: a jev sizing is recorded whatever its confidence, moves no group, and sizing_src names the model", () => {
  const table = liveB({ classifier: { b: "jev", tau: 0.8 } });
  const jev = (over) => ({ source: "jev", model: "jev-1", label: "heavy", confidence: 0.9, usd: 0.25, ...over });
  for (const confidence of [0.9, 0.8, 0.79, 0, undefined, "high", null]) {
    const r = routeIn({ table, sizing: jev({ confidence }) });
    assert.equal(r.line, BELOW_LINE.replace("SIZED=-", "SIZED=heavy"), `confidence ${JSON.stringify(confidence)}`);
    assert.equal(r.row.sizing_src, "jev:jev-1");
    assert.equal(r.row.sizing_pre, "heavy");
    assert.equal(r.row.router_usd, "0.25");
  }
  assert.equal(routeIn({ table, sizing: jev({ model: undefined }) }).row.sizing_src, "jev:", "no model: the prefix alone");
  assert.equal(routeIn({ table, sizing: jev({ usd: undefined }) }).row.router_usd, "", "no finite usd: blank");
  assert.equal(routeIn({ table, sizing: jev({ usd: "0.25" }) }).row.router_usd, "", "a usd that is not a number: blank");
  const haiku = routeIn({ table: liveB({ classifier: { b: "haiku", tau: 0.8 } }), sizing: { ...haikuSizing, confidence: 0.1 } });
  assert.equal(haiku.line, BELOW_LINE.replace("SIZED=-", "SIZED=heavy"));
  assert.equal(haiku.row.sizing_src, "haiku");
});

test("route: a tripped token that is not a cell makes the guard unreadable — default cell only — while a real trip still reads", (t) => {
  const table = baseTable({ burn_in: true });
  for (const tripped of [["task-hgih"], [{ cell: "task-hgih" }], ["smol-high", "task-hgih"]]) {
    const p = world(t, { table, guard: guardFile({ tripped, verdict: "tripped" }) });
    const r = routeCli(p, { implRow: 5 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLine(r.stdout), {
      POLICY: "slow-high", CELL: "slow-high", DRAW: "-", BY: "-", STRATUM: "*", BRIEF: "31", CRITERIA: "2", PARENT: "-", SIZED: "-", OBJECTIVE: "cost", TRIPPED: "-", REASON: "guard-missing",
    }, JSON.stringify(tripped));
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
    [/`rows` key "\*" is not an objective/, bad({ rows: { "*": "slow-high" } })],
    [/`rows` key "fast" is not an objective/, bad({ rows: { ...both({ "*": "slow-high" }), fast: { "*": "slow-high" } } })],
    [/`rows\.speed` is not an object/, bad({ rows: { cost: { "*": "slow-high" } } })],
    [/`rows\.cost` is not an object/, bad({ rows: { cost: "slow-high", speed: { "*": "slow-high" } } })],
    [/`rows\.cost` has no `\*` row/, bad({ rows: both({}) })],
    [/`rows\.speed` has no `\*` row/, bad({ rows: both({ "*": "slow-high" }, {}) })],
    [/`rows\.cost` key "medium" is not a node of the tree/, bad({ rows: both({ "*": "slow-high", medium: "task-high" }) })],
    [/`rows\.speed` key "" is not a node of the tree/, bad({ rows: both({ "*": "slow-high" }, { "*": "slow-high", "": "task-high" }) })],
    [/`rows\.cost` key "heavy" is not a node of the tree/, bad({ rows: both({ "*": "slow-high", heavy: "task-high" }) })],
    [/`rows\.speed\.\*` is 5, not a cell token/, bad({ rows: both({ "*": "slow-high" }, { "*": 5 }) })],
    [/`rows\.cost\.\*` is null, not a cell token/, bad({ rows: both({ "*": null }) })],
    [/`rows\.cost\.\*` is "alt", not a cell token/, bad({ rows: both({ "*": "alt" }) })],
    [/`rows\.cost\.\*` is \["slow-high"\]/, bad({ rows: both({ "*": ["slow-high"] }) })],
    [/`reasons` is not an object/, bad({ reasons: undefined })],
    [/`reasons` key "\*" is not an objective/, bad({ reasons: { "*": UNJUDGED } })],
    [/`reasons\.speed` is not an object/, bad({ reasons: { cost: { "*": UNJUDGED } } })],
    [/`reasons\.speed` key "medium" is not a node of the tree/, bad({ reasons: both({ "*": UNJUDGED }, { medium: UNJUDGED }) })],
    [/`reasons\.cost` key "light" is not a node of the tree/, bad({ reasons: both({ "*": UNJUDGED, light: UNJUDGED }) })],
    [/`estimates` key "heavy" is not a node of the tree/, bad({ estimates: { heavy: {} } })],
    [/`splits` is not an object/, bad({ splits: undefined })],
    [/`splits` is not an object/, bad({ splits: null })],
    [/`splits` is not an object/, bad({ splits: [] })],
    [/`splits` is not an object/, bad({ splits: "*" })],
    [/`burn_in` is not a boolean/, bad({ burn_in: "yes" })],
    [/`burn_in` is not a boolean/, bad({ burn_in: 1 })],
    [/`burn_in` is not a boolean/, bad({ burn_in: undefined })],
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
    bad({ burn_in: true, cells: [...STARTING, "slow-medium", "task-max"] }),
    twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high" }, { "*": "task-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }),
    bad({ classifier: { b: "haiku", tau: null } }),
    bad({ classifier: { b: "jev", tau: 0.8 } }),
    bad({ classifier: { b: null, tau: 0 } }),
    bad({ guard: { tripped: ["task-high"], n: { "slow-high": 3 } } }),
  ];
  for (const table of valid) assert.equal(validateTable(table), table, JSON.stringify(table));
});

// A tree whose nodes are named by the rule paths of its splits, each holding a row of its own: `nodes` is a list of
// them (each row slow-high), or the Cell each routes to.
const treeOf = (splits, nodes, over = {}) => {
  const cells = Array.isArray(nodes) ? Object.fromEntries(nodes.map((n) => [n, "slow-high"])) : nodes;
  return baseTable({ splits, rows: both(cells), reasons: both(Object.fromEntries(Object.keys(cells).map((n) => [n, UNJUDGED]))), ...over });
};
const KIND_BELOW = `${BELOW}&kind=bug`;
const NOT_KIND_BELOW = `${BELOW}&kind!=bug`;
const DEEP = { ...SPLITS, [BELOW]: { input: "kind", cut: "bug" } };
const DEEP_NODES = ["*", ABOVE, BELOW, KIND_BELOW, NOT_KIND_BELOW];

test("validateTable: a well-formed tree is accepted — one node, two leaves, two levels, every input a split reads", () => {
  for (const table of [
    baseTable(),
    twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high" }),
    treeOf(DEEP, DEEP_NODES),
    treeOf({ "*": { input: "brief_chars", cut: 4047.5 } }, ["*", "brief_chars>4047.5", "brief_chars<=4047.5"]),
    treeOf({ "*": { input: "kind", cut: "enhancement" } }, ["*", "kind=enhancement", "kind!=enhancement"]),
    treeOf({ "*": { input: "parent", cut: 0 } }, ["*", "parent>0", "parent<=0"]),
    // Every number input a split reads, at a cut of 0, which the grammar writes as `0`.
    ...["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "dirs"]
      .map((input) => treeOf({ "*": { input, cut: 0 } }, ["*", `${input}>0`, `${input}<=0`])),
  ]) assert.equal(validateTable(table), table, JSON.stringify(table.splits));
});

test("validateTable: a malformed tree is refused for its own reason — no root, a node without a row, a row that is no cell, a split on an unknown input", () => {
  const nodes3 = ["*", ABOVE, BELOW];
  const rowsOf = (cost, speed = cost) => ({ rows: { cost, speed }, reasons: both({ "*": UNJUDGED }) });
  const all = Object.fromEntries(nodes3.map((n) => [n, "slow-high"]));
  const without = (node, rows = all) => Object.fromEntries(Object.entries(rows).filter(([k]) => k !== node));
  const cases = [
    // A missing root, or a node of the tree with no cost or no speed row.
    [/`rows\.cost` has no `\*` row/, twoLeaf(without("*"))],
    [/`rows\.speed` has no `\*` row/, twoLeaf(all, without("*"))],
    [/`rows\.cost` has no row for "brief_chars>4047"/, twoLeaf(without(ABOVE))],
    [/`rows\.speed` has no row for "brief_chars<=4047"/, twoLeaf(all, without(BELOW))],
    [/`rows\.speed` has no row for "brief_chars>4047"/, { ...twoLeaf(all), ...rowsOf(all, { "*": "slow-high", [BELOW]: "slow-high" }) }],
    // A node whose row is not a Cell token, whichever Objective's.
    [/`rows\.cost\.brief_chars>4047` is "alt", not a cell token/, twoLeaf({ ...all, [ABOVE]: "alt" })],
    [/`rows\.speed\.brief_chars<=4047` is 5, not a cell token/, twoLeaf(all, { ...all, [BELOW]: 5 })],
    [/`rows\.cost\.brief_chars<=4047` is null, not a cell token/, twoLeaf({ ...all, [BELOW]: null })],
    [/`rows\.cost\.brief_chars>4047` is "slow-ultra", not a cell token/, twoLeaf({ ...all, [ABOVE]: "slow-ultra" })],
    // A row, a reasons record or an estimate for a group the tree does not hold: the old light/heavy words among them.
    [/`rows\.cost` key "light" is not a node of the tree/, twoLeaf({ ...all, light: "slow-high" })],
    [/`rows\.speed` key "unknown" is not a node of the tree/, twoLeaf(all, { ...all, unknown: "slow-high" })],
    [/`rows\.cost` key "brief_chars>9" is not a node of the tree/, twoLeaf({ ...all, "brief_chars>9": "slow-high" })],
    [/`reasons\.cost` key "heavy" is not a node of the tree/, twoLeaf(all, all, { reasons: both({ "*": UNJUDGED, heavy: UNJUDGED }) })],
    [/`estimates` key "light" is not a node of the tree/, twoLeaf(all, all, { estimates: { light: {} } })],
    // A split on an input a split cannot read.
    [/`splits\["\*"\]` reads "bogus", which no split can read/, treeOf({ "*": { input: "bogus", cut: 5 } }, nodes3)],
    [/`splits\["\*"\]` reads "title", which no split can read/, treeOf({ "*": { input: "title", cut: 5 } }, nodes3)],
    [/`splits\["\*"\]` reads "named_paths", which no split can read/, treeOf({ "*": { input: "named_paths", cut: 5 } }, nodes3)],
    [/`splits\["\*"\]` reads "run_date", which no split can read/, treeOf({ "*": { input: "run_date", cut: 5 } }, nodes3)],
    [/`splits\["\*"\]` reads undefined, which no split can read/, treeOf({ "*": { cut: 5 } }, nodes3)],
    // A cut the input cannot take: a number for a number input, a ticket kind for `kind`.
    [/`splits\["\*"\]` cuts brief_chars at "4047"/, treeOf({ "*": { input: "brief_chars", cut: "4047" } }, nodes3)],
    [/`splits\["\*"\]` cuts brief_chars at null/, treeOf({ "*": { input: "brief_chars", cut: null } }, nodes3)],
    [/`splits\["\*"\]` cuts brief_chars at -1/, treeOf({ "*": { input: "brief_chars", cut: -1 } }, nodes3)],
    [/`splits\["\*"\]` cuts brief_chars at NaN/, treeOf({ "*": { input: "brief_chars", cut: NaN } }, nodes3)],
    [/`splits\["\*"\]` cuts brief_chars at Infinity/, treeOf({ "*": { input: "brief_chars", cut: Infinity } }, nodes3)],
    [/`splits\["\*"\]` cuts brief_chars at 1e\+21/, treeOf({ "*": { input: "brief_chars", cut: 1e21 } }, nodes3)],
    [/`splits\["\*"\]` cuts kind at "story"/, treeOf({ "*": { input: "kind", cut: "story" } }, nodes3)],
    [/`splits\["\*"\]` cuts kind at 3/, treeOf({ "*": { input: "kind", cut: 3 } }, nodes3)],
    // A split that is not `{ input, cut }`.
    [/`splits\["\*"\]` is not `\{ input, cut \}`/, treeOf({ "*": null }, nodes3)],
    [/`splits\["\*"\]` is not `\{ input, cut \}`/, treeOf({ "*": "brief_chars" }, nodes3)],
    [/`splits\["\*"\]` is not `\{ input, cut \}`/, treeOf({ "*": { input: "brief_chars", cut: 4047, above: "task-high" } }, nodes3)],
    [/`splits\["\*"\]` is not `\{ input, cut \}`/, treeOf({ "*": ["brief_chars", 4047] }, nodes3)],
    // A split that sits at no node: the root has none, or the path is no node a walk reaches.
    [/`splits\["brief_chars>4047"\]` sits at no node of the tree/, treeOf({ [ABOVE]: { input: "kind", cut: "bug" } }, ["*"])],
    [/`splits\["medium"\]` sits at no node of the tree/, twoLeaf(all, all, { splits: { ...SPLITS, medium: { input: "kind", cut: "bug" } } })],
    // Rows that do not match the tree: a split whose children have none, a child with no split above it.
    [/`rows\.cost` has no row for "brief_chars>4047"/, baseTable({ splits: SPLITS })],
  ];
  for (const [why, table] of cases) {
    const r = validateTable(table);
    assert.ok(r instanceof Error, `${why}: ${JSON.stringify(table.splits)}`);
    assert.match(r.message, /^router table: /);
    assert.match(r.message, why, JSON.stringify(table));
  }
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

// What a split reads is a column of the ticket-features row: `issueMetrics` makes the row's metrics at dispatch, and a
// features file holds them as strings. `at` walks a table on the ordinary issue's metrics with some columns replaced.
const at = (table, over = {}) => stratumOf(table, { ...issueMetrics(issue()), ...over });
const NUMBER_INPUTS = ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "dirs"];

test("stratumOf: a one-node tree puts every ticket at `*`, blank metrics and an unread issue included", () => {
  const table = baseTable();
  const unread = { brief_chars: "", criteria: "", comments: "", age_days: "", paths: "", test_paths: "", xrefs: "", kind: "", parent: "" };
  for (const m of [issueMetrics(issue()), issueMetrics(issueOf(9000)), issueMetrics(issue({ body: "Spec: #3177\n\nx" })), unread, { brief_chars: "", criteria: "", parent: "3177" }, {}]) {
    assert.equal(stratumOf(table, m), "*", JSON.stringify(m));
  }
});

test("stratumOf: a number split sends a ticket past the cut to its `>` group and one at or below it to its `<=` group, on every number input", () => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });
  assert.equal(at(table, { brief_chars: String(CUT + 1) }), ABOVE);
  assert.equal(at(table, { brief_chars: String(CUT) }), BELOW, "the cut itself is not past it");
  assert.equal(at(table, { brief_chars: "0" }), BELOW);
  assert.equal(at(table, { brief_chars: "123456" }), ABOVE);
  assert.equal(at(table, { brief_chars: "5000" }), ABOVE);
  assert.equal(at(table, { brief_chars: "04047" }), BELOW, "a plain count with a leading zero is still that count");
  for (const input of NUMBER_INPUTS) {
    const split = treeOf({ "*": { input, cut: 5 } }, ["*", `${input}>5`, `${input}<=5`]);
    assert.equal(at(split, { [input]: "6" }), `${input}>5`, input);
    assert.equal(at(split, { [input]: "5" }), `${input}<=5`, input);
    assert.equal(at(split, { [input]: "0" }), `${input}<=5`, input);
    // Only its own column is read.
    for (const other of NUMBER_INPUTS.filter((o) => o !== input)) assert.equal(at(split, { [other]: "99" }), at(split, {}), `${input} is not ${other}`);
  }
});

test("stratumOf: a ticket that lacks the input a split reads stays at that node — an issue never read, or a blank column", () => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });
  assert.equal(stratumOf(table, {}), "*", "no metrics at all");
  assert.equal(stratumOf(table, { brief_chars: "", criteria: "", kind: "", parent: "" }), "*", "the issue was not read");
  assert.equal(at(table, { brief_chars: undefined }), "*");
  assert.equal(at(table, { brief_chars: "" }), "*");
  const age = treeOf({ "*": { input: "age_days", cut: 3 } }, ["*", "age_days>3", "age_days<=3"]);
  assert.equal(at(age, { age_days: "3" }), "age_days<=3");
  assert.equal(at(age, { age_days: "" }), "*", "a blank column: the issue was read, its created date was not");
  assert.equal(at(age, { age_days: undefined }), "*", "a features file written before the column reads it blank");
  const dirs = treeOf({ "*": { input: "dirs", cut: 1 } }, ["*", "dirs>1", "dirs<=1"]);
  assert.equal(at(dirs, { dirs: "" }), "*", "a brief that names no path spans no directory count");
  assert.equal(stratumOf(dirs, issueMetrics(issue())), "*");
});

// A features column a split reads that is neither blank nor a plain count, each a value `Number()` reads as no number
// or as some number — or, for a digit string too long to read as a finite number, as Infinity.
const CORRUPT_COUNTS = ["abc", "many", "Infinity", "1e400", "5e3", "0x1000", "0b1", "0o7", " 5000 ", "5000 ", "5000.5", "-5", "+5", " ", "\t", "5000\n", "9".repeat(309)];
// A brief_chars split with a criteria split on its `<=` side.
const CRITERIA_BELOW = treeOf({ ...SPLITS, [BELOW]: { input: "criteria", cut: 2 } }, ["*", ABOVE, BELOW, `${BELOW}&criteria>2`, `${BELOW}&criteria<=2`]);

test("stratumOf refuses a column a number split reads that is neither blank nor a plain count, naming the column and value — and the row's ticket where it has one", () => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });
  for (const bad of CORRUPT_COUNTS) {
    assert.throws(() => at(table, { brief_chars: bad }), (e) => e instanceof AttributionError && e.message.includes(`brief_chars is '${bad}'`), JSON.stringify(bad));
    assert.throws(() => at(table, { ticket: "7", brief_chars: bad }), (e) => e instanceof AttributionError && e.message.includes(`ticket #7: a ticket-features row's brief_chars is '${bad}'`), JSON.stringify(bad));
  }
  for (const input of NUMBER_INPUTS.filter((i) => i !== "brief_chars")) {
    const split = treeOf({ "*": { input, cut: 5 } }, ["*", `${input}>5`, `${input}<=5`]);
    for (const bad of CORRUPT_COUNTS) {
      assert.throws(() => at(split, { [input]: bad }), (e) => e instanceof AttributionError && e.message.includes(`${input} is '${bad}'`), `${input} ${JSON.stringify(bad)}`);
    }
  }
  // Deeper in the tree too: the walk refuses the cell the split it reaches reads.
  assert.throws(() => at(CRITERIA_BELOW, { brief_chars: "100", criteria: "2.5" }), /criteria is '2\.5'/);
});

test("stratumOf reads past a corrupt column no split it reaches reads, and an unread issue's row, whatever its other columns hold", () => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });
  const criteria = treeOf({ "*": { input: "criteria", cut: 2 } }, ["*", "criteria>2", "criteria<=2"]);
  for (const bad of CORRUPT_COUNTS) {
    for (const other of NUMBER_INPUTS.filter((o) => o !== "brief_chars")) assert.equal(at(table, { brief_chars: "5000", [other]: bad }), ABOVE, `${other} ${JSON.stringify(bad)}`);
    assert.equal(stratumOf(criteria, { brief_chars: "", criteria: bad }), "*", "an unread issue holds no input");
  }
  // Past the cut there is no further split, so the criteria the `<=` side's split reads is never read.
  assert.equal(at(CRITERIA_BELOW, { brief_chars: "5000", criteria: "2.5" }), ABOVE);
  assert.equal(at(CRITERIA_BELOW, { brief_chars: "100", criteria: "3" }), `${BELOW}&criteria>2`);
  assert.equal(at(CRITERIA_BELOW, { brief_chars: "100", criteria: "" }), BELOW);
});

test("stratumOf: a kind split sends a ticket of that kind to `kind=` and any other kind to `kind!=`; a ticket with no kind lacks the input", () => {
  const table = treeOf({ "*": { input: "kind", cut: "bug" } }, ["*", "kind=bug", "kind!=bug"]);
  assert.equal(at(table, { kind: "bug" }), "kind=bug");
  assert.equal(at(table, { kind: "enhancement" }), "kind!=bug");
  assert.equal(at(table, { kind: "documentation" }), "kind!=bug");
  assert.equal(at(table, { kind: "" }), "*", "no kind label");
  assert.equal(stratumOf(table, { brief_chars: "", kind: "bug" }), "*", "an unread issue holds no kind");
  assert.equal(stratumOf(table, issueMetrics(issue({ labels: [{ name: "documentation" }, { name: "bug" }] }))), "kind!=bug", "the first kind label in label order, as issueMetrics reads it");
});

test("stratumOf: a parent split puts a Slice in `parent>0` and a ticket with no parent in `parent<=0`; only an unread issue lacks it", () => {
  const table = treeOf({ "*": { input: "parent", cut: 0 } }, ["*", "parent>0", "parent<=0"]);
  assert.equal(at(table, { parent: "3177" }), "parent>0");
  assert.equal(at(table, { parent: "" }), "parent<=0", "an issue read that is no Slice has no parent: a value, not a gap");
  assert.equal(at(table, { parent: undefined }), "parent<=0", "a features file written before the column: no Slice");
  assert.equal(stratumOf(table, { brief_chars: "", criteria: "", parent: "" }), "*", "an unread issue lacks it");
  assert.equal(stratumOf(table, { brief_chars: "", criteria: "", parent: "3177" }), "*", "even a parent a row names, with no issue read");
  assert.equal(stratumOf(table, issueMetrics(issue({ body: "Spec: #3177 § D1." }))), "parent>0");
  assert.equal(stratumOf(table, issueMetrics(issue())), "parent<=0");
});

test("stratumOf: a walk goes down as far as the ticket's inputs go, and a path joins the tests it took with `&`", () => {
  const table = treeOf(DEEP, DEEP_NODES);
  assert.equal(at(table, { brief_chars: "100", kind: "bug" }), KIND_BELOW);
  assert.equal(at(table, { brief_chars: "100", kind: "documentation" }), NOT_KIND_BELOW);
  assert.equal(at(table, { brief_chars: "100", kind: "" }), BELOW, "no kind: the walk stops at the node whose split reads it");
  assert.equal(at(table, { brief_chars: "9000", kind: "bug" }), ABOVE, "past the cut there is no further split");
  assert.equal(at(table, { brief_chars: "" }), "*");
  assert.equal(stratumOf(table, {}), "*");
});

test("metrics: a Slice's parent is read off the issue body's top — `Spec: #<N>` or an opening `## Parent` section — and nothing else makes one", () => {
  const cases = [
    ["Spec: #3177 § D1, D2. Ticket 1 of 6 for that spec.", "3177"],
    ["\n  \nSpec: #3485 § D8.", "3485", "leading blank lines are not the first non-blank line"],
    ["## Parent\n\nhttps://github.com/feigi/fleet-plugin/issues/2870\n\n## What to build\nSee #12.", "2870"],
    ["## Parent\n\n#2870, after #2871\n", "2870", "the first issue named counts"],
    ["## Parent\nhttps://github.com/o/r/issues/7 and #8", "7", "the first issue named counts, URL or #N"],
    ["Spec #3182 (`docs/specs/x.md`), D6.", "", "no colon"],
    ["Spec 7 of the 2026-10-13 determinism review", ""],
    ["## Parent\n\nnone yet\n\n## What to build\nSee #12.", "", "a Parent section naming no issue; a later section's #12 is not its parent"],
    ["Part of #3673\n\nSpec: #3177", "", "Part of makes none, and Spec: below the first line is not at the top"],
    ["## What to build\n\n## Parent\n#5", "", "a Parent section that does not open the body"],
    ["see Spec: #5", "", "Spec: mid-line is no Slice"],
    ["## Parent\nrepo#7", "", "a # glued to a word is no issue ref"],
    ["## Parent notes\n#5", "", "a heading that only begins with Parent"],
    ["", ""],
  ];
  for (const [body, parent, why] of cases) assert.equal(sliceParent(body), parent, why ?? body);
  assert.equal(issueMetrics(issue({ body: "Spec: #3177 § D1." })).parent, "3177");
  assert.equal(issueMetrics(issue()).parent, "");
  assert.equal(
    issueMetrics(issue({ body: "Spec: #3177 § D1.", comments: [{ body: "## Agent Brief\nshort, and no Spec line" }] })).parent, "3177",
    "the body decides, so a later Agent Brief comment leaves a Slice a Slice",
  );
  assert.equal(issueMetrics(issue({ body: "short", comments: [{ body: "## Agent Brief\nSpec: #3177" }] })).parent, "", "a brief that opens Spec: on a comment makes none");
});

test("route: a Slice names its parent on the line and the features row, by either form, even after a later Agent Brief; a ticket that is no Slice names none", (t) => {
  const brief = { comments: [{ body: "## Agent Brief\nA short brief.\n- [ ] one" }] };
  const slices = [
    [issue({ body: "Spec: #3177 § D3. Ticket 3 of 6 for that spec." }), "3177"],
    [issue({ body: "## Parent\n\nhttps://github.com/feigi/fleet-plugin/issues/2870\n\n## What to build\nshort" }), "2870"],
    [issue({ body: "Spec: #3177 § D3.", ...brief }), "3177"],
  ];
  for (const [issueJson, parent] of slices) {
    const p = world(t, { issueJson });
    const r = routeCli(p);
    assert.equal(r.status, 0, r.stderr);
    const line = parseLine(r.stdout);
    assert.deepEqual([line.STRATUM, line.PARENT], ["*", parent], r.stdout);
    assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].parent, parent, "the features row carries the parent the fit reads");
  }
  for (const body of ["Spec #3182 (`docs/specs/x.md`), D6.", "## Parent\n\nnone yet\n\n## What to build\nSee #12.", "Part of #3673\n\nshort"]) {
    const p = world(t, { issueJson: issue({ body }) });
    const r = routeCli(p);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([parseLine(r.stdout).STRATUM, parseLine(r.stdout).PARENT], ["*", "-"], body);
    assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].parent, "");
  }
});

test("route: a table that splits on parent puts a Slice in its own group, any other ticket in the other, and an unread issue at the root", () => {
  const table = treeOf({ "*": { input: "parent", cut: 0 } }, { "*": "slow-high", "parent>0": "task-high", "parent<=0": "smol-high" });
  const lineOf = (issueJson) => route({ session: SESSION, ticket: 42, arm: "A", implRow: 3, issue: issueJson, guard: readGuard(guardFile()), table, objective: "cost" }).line;
  assert.equal(lineOf(issue({ body: "Spec: #3177 § D1." })), "POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=parent>0 BRIEF=17 CRITERIA=0 PARENT=3177 SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok");
  assert.equal(lineOf(issue()), "POLICY=smol-high CELL=smol-high DRAW=- BY=- STRATUM=parent<=0 BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok");
  assert.equal(lineOf(null), "POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=* BRIEF=- CRITERIA=- PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=no-issue-json");
});

test("route: a pending file begun before the parent column, the named-path columns or the assignment column keeps its width", (t) => {
  for (const lacks of [["parent", ...NAMED, PROB], [...NAMED, PROB], [PROB]]) {
    const p = world(t, { issueJson: issue({ body: "Spec: #3177 § D3. Change `plugin/scripts/a.mjs`.", title: "x" }) });
    const older = COLUMNS.filter((c) => !lacks.includes(c));
    mkdirSync(dirname(p.pending), { recursive: true });
    writeFileSync(p.pending, `${older.join("\t")}\n`);
    for (const ticket of [42, 43]) assert.equal(routeCli(p, { ticket }).status, 0);
    const lines = readFileSync(p.pending, "utf8").replace(/\n$/, "").split("\n");
    assert.deepEqual(lines.map((l) => l.split("\t").length), [older.length, older.length, older.length], lacks.join());
    const rows = parseFeatures(lines.join("\n"));
    assert.deepEqual(rows.map((r) => r.ticket), ["42", "43"]);
    for (const row of rows) {
      assert.equal(row.objective, "cost");
      for (const c of lacks) assert.equal(row[c], "", `${lacks.join()}: the row is written at the file's width, so ${c} reads blank`);
    }
  }
});

// A checkout root under its own base directory, so `../` from the root lands on a file of the base.
function checkout(t) {
  const base = mkdtempSync(join(tmpdir(), "ticket-router-root-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "root");
  mkdirSync(join(root, "plugin", "scripts"), { recursive: true });
  return { base, root };
}
const rowAt = (root, body, over = {}) => route({
  session: SESSION, ticket: 42, arm: "A", implRow: 3, issue: issue({ body }), guard: readGuard(guardFile()), table: baseTable(), objective: "cost", root, version: "9.9.9", ...over,
}).row;

test("route: the row records the paths the brief names as named, each one's lines aligned, and the directories they span", (t) => {
  const { root } = checkout(t);
  writeFileSync(join(root, "plugin", "scripts", "a.mjs"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "plugin", "scripts", "b.mjs"), "one\ntwo");
  writeFileSync(join(root, "README.md"), "");
  const body = "Change `plugin/scripts/a.mjs`, `docs/gone.md`, `plugin/scripts/b.mjs:12-30`, `plugin/scripts/`, `README.md` and `plugin/scripts/a.mjs:4`.\n\n## Out of scope\n- `other/x.mjs`";
  const row = rowAt(root, body);
  assert.equal(row.named_paths, "plugin/scripts/a.mjs docs/gone.md plugin/scripts/b.mjs:12-30 plugin/scripts/ README.md plugin/scripts/a.mjs:4", "as named, first-seen order, Out of scope skipped");
  assert.equal(row.named_lines, "3 - 2 dir 0 3", "a count, `-` when missing, the suffixed file's count, `dir`, an empty file, a last line with no newline counted");
  assert.equal(row.dirs, "3", "plugin/scripts (a trailing `/` its own), docs, and `.` for the bare filename");
  assert.equal(row.paths, "6");
  assert.equal(row.plugin_version, "9.9.9", "the injected version");
  assert.equal(rowAt(root, "Change `a/b.mjs`.", { version: null }).plugin_version, "", "a version that cannot be read is blank");
  assert.deepEqual(issueMetrics(issue({ body: "`a/x.mjs` `./a/y.mjs` `a/b/../z.mjs` `a/b/` `a/b`" })).dirs, "2", "a directory is counted once however it is spelled: a, and a/b");
});

test("route: a path outside the checkout — `..`, absolute, `~`, or through a symlink — is recorded `-` and never read; one inside it is read however it is spelled", (t) => {
  const { base, root } = checkout(t);
  writeFileSync(join(base, "x"), "1\n2\n3\n4\n5\n");
  // Read as spelled, `~/.fleet/x` would be this file under the root: its count would show it was opened.
  mkdirSync(join(root, "~", ".fleet"), { recursive: true });
  writeFileSync(join(root, "~", ".fleet", "x"), "1\n2\n");
  symlinkSync(join(base, "x"), join(root, "out.mjs"));
  symlinkSync(base, join(root, "outdir"));
  const outside = ["../x", "/etc/passwd", "~/.fleet/x", "plugin/../../x", "out.mjs", "outdir/x"];
  const outRow = rowAt(root, outside.map((p) => `\`${p}\``).join(" "));
  assert.equal(outRow.named_paths, outside.join(" "));
  assert.equal(outRow.named_lines, outside.map(() => "-").join(" "));

  writeFileSync(join(root, "plugin", "scripts", "a.mjs"), "one\ntwo\n");
  symlinkSync(join(root, "plugin", "scripts", "a.mjs"), join(root, "in.mjs"));
  symlinkSync(root, join(base, "alias"));
  const inside = ["plugin/scripts/a.mjs", "./plugin/scripts/a.mjs", "plugin/x/../scripts/a.mjs", "in.mjs"];
  for (const at of [root, join(base, "alias")]) {
    assert.equal(rowAt(at, inside.map((p) => `\`${p}\``).join(" ")).named_lines, "2 2 2 2", `root ${at}`);
  }
});

test("route: a path spelled outside the checkout is `-` even where a symlink there leads back inside it", (t) => {
  const { base, root } = checkout(t);
  writeFileSync(join(root, "plugin", "scripts", "a.mjs"), "one\ntwo\n");
  symlinkSync(join(root, "plugin", "scripts", "a.mjs"), join(base, "sib"));
  symlinkSync(join(root, "plugin"), join(base, "sibdir"));
  assert.equal(rowAt(root, "`../sib` `../sibdir/scripts/a.mjs` `../sibdir` `plugin/scripts/a.mjs`").named_lines, "- - - 2");
});

test("route: a file named with a trailing `/` is `-`, not its line count", (t) => {
  const { root } = checkout(t);
  writeFileSync(join(root, "plugin", "scripts", "a.mjs"), "1\n2\n3\n");
  assert.equal(rowAt(root, "`plugin/scripts/a.mjs/` `plugin/scripts/a.mjs`").named_lines, "- 3");
});

test("route: a FIFO inside the checkout is recorded `-` and never opened", (t) => {
  const { root } = checkout(t);
  const fifo = join(root, "plugin", "scripts", "pipe.fifo");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) return t.skip("mkfifo unavailable");
  // A writer that holds the FIFO's data for any reader that opens it: opened, the FIFO reads `2`; never opened, the writer stays blocked until killed.
  const writer = spawn("sh", ["-c", 'printf "one\\ntwo\\n" > "$1"', "sh", fifo], { stdio: "ignore" });
  t.after(() => writer.kill("SIGKILL"));
  assert.equal(rowAt(root, "`plugin/scripts/pipe.fifo`").named_lines, "-");
});

test("route: run with no root, the CLI looks the brief's paths up under its working directory", (t) => {
  const p = world(t, { issueJson: issue({ body: "Change `plugin/scripts/a.mjs` and `docs/b.md`." }) });
  mkdirSync(join(p.dir, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(p.dir, "plugin", "scripts", "a.mjs"), "a\nb\nc\nd\n");
  const r = spawnSync(process.execPath, [SCRIPT, "route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "3",
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, ...INSTALL_FLAGS], { encoding: "utf8", cwd: p.dir });
  assert.equal(r.status, 0, r.stderr);
  const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.deepEqual([row.named_paths, row.named_lines, row.dirs], ["plugin/scripts/a.mjs docs/b.md", "4 -", "2"]);
  assert.equal(row.plugin_version, installVersion());
});

test("route: a working directory removed under the CLI warns and reads every named path `-`, exit 0", (t) => {
  const p = world(t, { issueJson: issue({ body: "Change `plugin/scripts/a.mjs`." }) });
  const gone = join(p.dir, "gone");
  mkdirSync(gone);
  const r = spawnSync("sh", ["-c", 'cd "$1" && rmdir "$1" && shift && exec "$@"', "sh", gone, process.execPath, SCRIPT, "route", "--session", SESSION,
    "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "3", "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, ...INSTALL_FLAGS],
  { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^POLICY=.* REASON=ok$/m);
  assert.match(r.stderr, /WARNING cannot resolve the working directory/);
  const [row] = parseFeatures(readFileSync(p.pending, "utf8"));
  assert.equal(row.named_lines, "-");
});

test("route: an install package.json with no readable version warns and leaves plugin_version blank, exit 0", (t) => {
  const p = world(t);
  const install = join(p.dir, "install");
  cpSync(dirname(SCRIPT), join(install, "scripts"), { recursive: true });
  const args = ["route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "3",
    "--issue", p.issue, "--guard", p.guard, "--table", p.table, "--pending", p.pending, ...INSTALL_FLAGS];
  const run = (pkg) => {
    writeFileSync(join(install, "package.json"), pkg);
    const r = spawnSync(process.execPath, [join(install, "scripts", "ticket-router.mjs"), ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { stderr: r.stderr, row: parseFeatures(readFileSync(p.pending, "utf8")).at(-1) };
  };
  const ok = run('{"version":"1.2.3"}');
  assert.equal(ok.row.plugin_version, "1.2.3");
  assert.doesNotMatch(ok.stderr, /WARNING/);
  const bad = run("{oops");
  assert.equal(bad.row.plugin_version, "");
  assert.match(bad.stderr, /WARNING .*package\.json names no readable version/);
});

test("installVersion: a string version comes back; a numeric, missing, unparseable or unreadable one is null", () => {
  const dir = tempDir("router-version-");
  const at = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  assert.equal(installVersion(at("string.json", '{"version":"1.2.3"}')), "1.2.3");
  assert.equal(installVersion(at("number.json", '{"version":3}')), null);
  assert.equal(installVersion(at("missing.json", "{}")), null);
  assert.equal(installVersion(at("nul.json", "null")), null);
  assert.equal(installVersion(at("bad.json", "{not json")), null);
  assert.equal(installVersion(join(dir, "absent.json")), null);
});

test("route: a title holding a tab, a newline or a carriage return lands as one field, and the row parses at the header's width", (t) => {
  const p = world(t, { issueJson: issue({ title: "tab\there\nnew\r\nline" }) });
  assert.equal(routeCli(p).status, 0);
  const lines = readFileSync(p.pending, "utf8").replace(/\n$/, "").split("\n");
  assert.deepEqual(lines.map((l) => l.split("\t").length), [COLUMNS.length, COLUMNS.length]);
  assert.equal(parseFeatures(lines.join("\n"))[0].title, "tab here new  line");
});

test("route: a pending file whose first line is no features header is left alone, with the WARNING, and the route still prints", (t) => {
  const stray = [...COLUMNS.slice(0, -1), "extra"].join("\t");
  for (const [seed, why] of [["garbage\n", "not a header"], ["\nfoo\n", "a blank first line"], ["ticket\tsession\n", "required columns missing"], [`${stray}\n`, "a name no features file carries"]]) {
    const p = world(t);
    mkdirSync(dirname(p.pending), { recursive: true });
    writeFileSync(p.pending, seed);
    const r = routeCli(p);
    assert.equal(r.status, 0, `${why}: ${r.stderr}`);
    assert.equal(parseLine(r.stdout).REASON, "ok", why);
    assert.match(r.stderr, /WARNING could not append to .*: its first line is no ticket-features header: .* — this Pull's ticket-features row is not recorded\n$/, why);
    assert.equal(readFileSync(p.pending, "utf8"), seed, `${why}: the file is not appended to`);
  }
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
// Every column blank but `work_s`, a minute unless `over` names it: a blank one would leave the Pull untimed.
const memberRow = (over) => Object.fromEntries(MEMBER_COLUMNS.map((c) => [c, ""]).concat(Object.entries({ session: SESSION, harness: "omp", work_s: "60", ...over })));
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

test("fit: a day-one three-TSV fixture writes an estimates-only table over its tree, and --check accepts it", (t) => {
  const features = [
    featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" }),
    featureRow({ ticket: "2", chosen_cell: "slow-high", exploration_draw: "1/3", brief_chars: "5000" }),
    featureRow({ ticket: "3", chosen_cell: "smol-high", exploration_draw: "3/3", run_date: "2026-10-02" }),
  ];
  // Every Pull's implementer is admissible, costs $1 and worked a minute; ticket 1's PR took a $2 fix round of a minute, and the merge bot is no cell's.
  const members = [
    { member: "fix-pr-11", agent: "fix-pr-11", pr: "11", role: "fix-applier", cost: "2" },
    { member: "merge-bot-1", agent: "merge-bot-1", pr: "11", role: "merge-bot", cost: "100" },
  ];
  const verdicts = [{ pr: "11", ticket: "1" }, { pr: "12", ticket: "2+9", minted_false_claim: "yes" }];
  const p = fitWorld(t, { features, members, verdicts, table: twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, undefined, { burn_in: true }) });
  const r = fitCli(p);
  assert.equal(r.status, 0, r.stderr);
  const sha = p.git("rev-parse", "HEAD");
  assert.match(r.stdout, new RegExp(`fitted 3 Pulls at ${sha.slice(0, 8)};.*; cells slow-high m n=1 merged=1 failed=1 usd_per_merged=1.00 minutes_per_merged=1.00 excluded=0 left_out=0 unpriced=0 untimed=0, `));
  assert.match(r.stdout, /^ticket-router: fitted 3 Pulls at [0-9a-f]{8}; rows \{[^\n]*\}; burn_in true; cells /, "the summary names burn-in, then the cells");
  const table = JSON.parse(readFileSync(p.table, "utf8"));
  assert.deepEqual(table.rows.cost, { "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, "no cell has n>=20 yet, so no row is adopted, and every node holds the default");
  assert.deepEqual(table.splits, SPLITS, "the fit makes no split and takes none away");
  assert.equal(table.burn_in, true);
  assert.deepEqual(table.cells, STARTING);
  assert.deepEqual(Object.keys(table).sort(), ["burn_in", "cells", "classifier", "estimates", "fitted_commit", "guard", "n_rows", "reasons", "rows", "splits", "window_start"], "the fit writes these fields and no others");
  assert.equal(table.n_rows, 3);
  assert.equal(table.fitted_commit, sha, "the table records the commit the fit read, in full");
  assert.equal("fitted_through" in table, false, "no date field stays beside the commit");
  assert.equal(table.window_start, "2026-09-01", "the window comes from the guard; the fit never moves it");
  const est = (o) => ({ generation: "m", claims: o.merged, by_hand: o.merged, failed: 0, fix_rounds: 0, review_findings: null, excluded: 0, left_out: 0, unpriced: 0, untimed: 0, older: {}, ...o });
  assert.deepEqual(table.estimates["*"]["task-high"], est({ n: 1, merged: 1, usd_per_merged: 3, minutes_per_merged: 2, fail_rate: 0, fix_rounds: 1 }));
  assert.deepEqual(table.estimates[ABOVE]["slow-high"], est({ n: 1, merged: 1, failed: 1, usd_per_merged: 1, minutes_per_merged: 1, fail_rate: 1 }));
  assert.deepEqual(table.estimates[BELOW]["smol-high"], est({ n: 1, merged: 0, usd_per_merged: null, minutes_per_merged: null, fail_rate: null, fix_rounds: null }));
  assert.deepEqual(table.guard, { tripped: [], n: { "slow-high": 5, "smol-high": 5, "task-high": 5 } });

  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, new RegExp(`matches a re-fit of 3 Pulls at ${sha.slice(0, 8)}\n`));
});

test("fit and --check read a features corpus with the named-path columns as one without them", (t) => {
  const features = [
    featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" }),
    featureRow({ ticket: "2", chosen_cell: "slow-high", exploration_draw: "1/3", brief_chars: "5000" }),
  ].map((f) => ({ ...f, named_paths: "plugin/a.mjs docs/b.md", named_lines: "3 -", dirs: "2", title: "a title", plugin_version: "1.2.3" }));
  const verdicts = [{ pr: "11", ticket: "1" }, { pr: "12", ticket: "2" }];
  const p = fitWorld(t, { features, members: [], verdicts });
  const fitted = () => {
    const r = fitCli(p);
    assert.equal(r.status, 0, r.stderr);
    const { fitted_commit: _, ...table } = JSON.parse(readFileSync(p.table, "utf8"));
    const check = cli(["--check", ...p.fitArgs]);
    assert.equal(check.status, 0, check.stderr);
    return table;
  };
  const withThem = fitted();
  assert.equal(withThem.n_rows, 2);
  writeFileSync(p.features, tsv(COLUMNS.filter((c) => !NAMED.includes(c)), features, true));
  p.commit();
  assert.deepEqual(fitted(), withThem);
});

test("fit: an older generation prints on its own `(older)` segment with its own fix rounds, and a cell with only excluded Pulls names no generation", (t) => {
  // task-high: two merged Pulls on model-a, each with a $2 fix round, then one on model-b with none.
  const a1 = featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "1/3" });
  const a2 = featureRow({ ticket: "4", chosen_cell: "task-high", exploration_draw: "1/3" });
  const b = featureRow({ ticket: "2", chosen_cell: "task-high", exploration_draw: "1/3", session: SESSION2 });
  // smol-high: its only implementer has no dispatch model, so its one Pull is excluded.
  const x = featureRow({ ticket: "3", chosen_cell: "smol-high", exploration_draw: "1/3" });
  const members = [
    implementer(a1, { pr: "11", ending: "pr", dispatch_model: "model-a" }),
    implementer(a2, { pr: "14", ending: "pr", dispatch_model: "model-a" }),
    implementer(b, { pr: "12", ending: "pr", dispatch_model: "model-b" }),
    implementer(x, { dispatch_model: "" }),
    { member: "fix-pr-11", agent: "fix-pr-11", pr: "11", role: "fix-applier", cost: "2" },
    { member: "fix-pr-14", agent: "fix-pr-14", pr: "14", role: "fix-applier", cost: "2" },
  ];
  const verdicts = [{ pr: "11", ticket: "1" }, { pr: "14", ticket: "4" }, { pr: "12", ticket: "2" }];
  const p = fitWorld(t, { features: [a1, a2, b, x], members, verdicts });
  const r = fitCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /; cells smol-high - n=0 merged=0 failed=0 usd_per_merged=- minutes_per_merged=- excluded=1 left_out=0 unpriced=0 untimed=0, task-high model-b n=1 merged=1 failed=0 usd_per_merged=1\.00 minutes_per_merged=1\.00 excluded=0 left_out=0 unpriced=0 untimed=0, task-high model-a \(older\) n=2 merged=2 failed=0 usd_per_merged=3\.00 minutes_per_merged=2\.00\nticket-router: row cost \* slow-high unjudged\n/);
  assert.match(r.stdout, /\nticket-router: row speed \* slow-high unjudged\n/, "the fit prints the speed set too");
  const task = JSON.parse(readFileSync(p.table, "utf8")).estimates["*"]["task-high"];
  assert.deepEqual([task.generation, task.fix_rounds, task.older["model-a"].fix_rounds], ["model-b", 0, 1]);
});

test("fit: a Pull with a blank work_s on a top-level booked row prints as untimed and leaves the cell's figures, and --check re-derives it", (t) => {
  const timed = featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "1/3" });
  const untimed = featureRow({ ticket: "2", chosen_cell: "task-high", exploration_draw: "1/3" });
  const members = [
    implementer(timed, { pr: "11", ending: "pr", work_s: "5400" }),
    implementer(untimed, { pr: "12", ending: "pr", cost: "7" }),
    { member: "fix-pr-12", agent: "fix-pr-12", pr: "12", role: "fix-applier", cost: "2", work_s: "" },
  ];
  const p = fitWorld(t, { features: [timed, untimed], members, verdicts: [{ pr: "11", ticket: "1" }, { pr: "12", ticket: "2" }] });
  const r = fitCli(p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /; cells task-high m n=1 merged=1 failed=0 usd_per_merged=1\.00 minutes_per_merged=90\.00 excluded=0 left_out=0 unpriced=0 untimed=1\n/);
  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
});

test("--check fails when the checked-in table is not a re-fit of its rows", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(fitCli(p).status, 0);
  const good = JSON.parse(readFileSync(p.table, "utf8"));
  for (const [what, edit] of [
    ["a hand-adopted row", (x) => { x.rows.cost["*"] = "task-high"; }],
    ["a hand-adopted speed row", (x) => { x.rows.speed["*"] = "smol-high"; }],
    ["burn-in switched off by hand", (x) => { x.burn_in = false; }],
    ["an edited estimate", (x) => { x.estimates["*"]["task-high"].n = 30; }],
    ["an edited minutes per merged PR", (x) => { x.estimates["*"]["task-high"].minutes_per_merged = 2; }],
    ["an edited untimed count", (x) => { x.estimates["*"]["task-high"].untimed = 1; }],
    ["a table fitted before work time, lacking both", (x) => { for (const row of Object.values(x.estimates)) for (const e of Object.values(row)) { delete e.minutes_per_merged; delete e.untimed; } }],
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
  const p = fitWorld(t, { features: [], members: [], verdicts: [], table: structuredClone(DAY_ONE_TABLE) });
  const r = cli(["--check", ...p.fitArgs]);
  assert.equal(r.status, 0, r.stderr);
});

test("a table fitted before work time, its estimates lacking minutes_per_merged and untimed, is valid and is the next fit's prior", (t) => {
  const features = [featureRow({ ticket: "1", chosen_cell: "task-high", exploration_draw: "2/3" })];
  const p = fitWorld(t, { features, members: [], verdicts: [{ pr: "11", ticket: "1" }] });
  assert.equal(fitCli(p).status, 0);
  const before = JSON.parse(readFileSync(p.table, "utf8"));
  for (const row of Object.values(before.estimates)) for (const e of Object.values(row)) { delete e.minutes_per_merged; delete e.untimed; }
  assert.equal(validateTable(before), before);
  writeFileSync(p.table, JSON.stringify(before));
  const r = fitCli(p);
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(p.table, "utf8")).estimates["*"]["task-high"];
  assert.deepEqual([after.minutes_per_merged, after.untimed], [1, 0]);
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

test("fit: adopts the cheapest cell at n>=20 under 0.75x the default's $/merged PR, reliably cheaper and above the quality floor", () => {
  const next = fitTable({ prior: twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, undefined, { burn_in: true }), ...direct(adoptionInput({ cheapFails: false })), guard: atN });
  assert.equal(next.rows.cost["*"], "smol-high");
  assert.equal(next.rows.cost[BELOW], "smol-high", "a node with both sides at n>=20 gets its own row");
  assert.deepEqual(next.cells, STARTING, "an adoption adds no Cell");
  // Burn-in ends once every starting Cell has n>=20 in the guard, adoption or none.
  assert.equal(next.burn_in, false);
});

test("fit: re-tests the quality floor per row — a cell under it is refused the row however cheap, and the guard's trip is not needed", () => {
  // Every smol-high PR fails the floor, and the guard has tripped nothing.
  const next = fitTable({ prior: baseTable({ burn_in: true }), ...direct(adoptionInput({ cheapFails: true })), guard: atN });
  assert.equal(next.estimates["*"]["smol-high"].fail_rate, 1);
  assert.deepEqual(next.rows.cost, { "*": "slow-high" });
  assert.deepEqual(next.reasons.cost["*"].cells["smol-high"], { verdict: "under-floor", under_floor: true, bar: 0.15, range: [-8, -8] });
  assert.equal(next.reasons.cost["*"].reason, "no-qualifier");
  assert.deepEqual(next.cells, STARTING, "a refusal by the floor adds no Cell");
});

test("fit: no adoption above the 0.75x margin, for a tripped cell, or below n=20 — the default stays", () => {
  const above = fitTable({ prior: baseTable({ burn_in: true }), ...direct(adoptionInput({ cheapFails: false, cheapUsd: 8 })), guard: atN });
  assert.deepEqual(above.rows.cost, { "*": "slow-high" });
  assert.equal(above.burn_in, false, "every starting Cell has pooled n>=20 in the guard");
  const tripped = fitTable({ prior: baseTable(), ...direct(adoptionInput({ cheapFails: false })), guard: { ...atN, tripped: ["smol-high"] } });
  assert.deepEqual(tripped.rows.cost, { "*": "slow-high" });
  assert.deepEqual([tripped.cells, tripped.burn_in], [STARTING, false], "an eviction adds no Cell, and the tripped Cell at n>=20 holds no burn-in open");
  const small = fitTable({ prior: baseTable(), ...direct(adoptionInput({ cheapFails: false, n: 19 })), guard: atN });
  assert.deepEqual(small.rows.cost, { "*": "slow-high" });
  // A booked row with no cost on record makes its Pull unpriced: out of the cell's n, so the cell falls under n=20.
  const input = adoptionInput({ cheapFails: false });
  input.members[30].cost = "";
  const unpriced = fitTable({ prior: baseTable(), ...direct(input), guard: atN });
  const smol = unpriced.estimates["*"]["smol-high"];
  assert.deepEqual([smol.n, smol.unpriced, smol.usd_per_merged], [19, 1, 2]);
  assert.deepEqual(unpriced.rows.cost, { "*": "slow-high" });
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

test("mergedSince: the Pull whose implementer opened the ruled PR is merged on a ruling of any date; a row with both verdict columns blank skipped", () => {
  const features = [featureRow({ ticket: "1", run_date: "2026-10-03" })];
  const count = (verdicts) => since({ features, verdicts });
  assert.equal(count([verdictRow({ ticket: "1", pr: "11", run_date: "2026-10-02" })]), 1, "a ruling dated before its PR's carrier still rules it");
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
  assert.equal(count([early]), 1, "the dated row's Pull, whose implementer opened the PR, takes a ruling of any date");
  assert.equal(count([early], { window_start: "2026-01-01" }), 1, "the same with window_start set");
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

test("fit: a Pull's verdict is the last ruling in file order of the PR its implementer opened, whatever its date, a row with both verdict columns blank skipped", () => {
  // Ticket 2, in another cell, has a later row than ticket 1's Pull; it moves nothing for ticket 1.
  const features = [exploring({ ticket: "1", run_date: "2026-10-03" }), exploring({ ticket: "2", run_date: "2026-10-05", chosen_cell: "task-high" })];
  const fit = (verdicts) => fitDirect({ features, members: [], verdicts }).estimates["*"]["slow-high"];
  const failed = ruled(1, 11, { run_date: "2026-10-03", minted_false_claim: "yes" });
  const blank = ruled(1, 11, { run_date: "2026-10-04", closed_own_ticket: "", minted_false_claim: "" });
  assert.equal(fit([failed, blank]).fail_rate, 1, "a both-blank row after a real ruling was never ruled, so the ruling stands");
  assert.equal(fit([blank]).merged, 0, "a Pull whose only row is both-blank has no verdict");
  assert.equal(fit([ruled(1, 11, { run_date: "2026-10-02", minted_false_claim: "yes" })]).merged, 1, "a ruling dated before the Pull still rules the Pull whose implementer opened its PR");
  const pass = ruled(1, 11, { run_date: "2026-10-03" });
  assert.deepEqual(fit([pass]), { ...fit([pass]), merged: 1, fail_rate: 0 }, "a ruling dated the day of the Pull rules it");
  assert.equal(fit([pass, ruled(1, 11, { run_date: "2026-10-05", minted_false_claim: "yes" })]).fail_rate, 1, "the last such ruling wins");
});

test("fit: a ticket Pulled twice is two units, each in its own row's cell and group, and its merge counts once", () => {
  const first = exploring({ ticket: "1", run_date: "2026-10-01", chosen_cell: "task-high", brief_chars: "100" });
  const second = exploring({ ticket: "1", run_date: "2026-10-03", chosen_cell: "smol-high", brief_chars: "5000", session: SESSION2 });
  const next = fitTable({
    prior: twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, undefined, { burn_in: true }),
    ...direct({ features: [first, second], members: [implementer(second, { pr: "11", ending: "pr", cost: "3" })], verdicts: [ruled(1, 11, { run_date: "2026-10-03" })] }), guard: atN,
  });
  assert.equal(next.n_rows, 2);
  assert.deepEqual([next.estimates[BELOW]["task-high"].n, next.estimates[BELOW]["task-high"].merged], [1, 0]);
  assert.deepEqual([next.estimates[ABOVE]["smol-high"].n, next.estimates[ABOVE]["smol-high"].merged], [1, 1]);
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 3, "the hollow first Pull's $1 is task-high's spend, not smol-high's");
});

test("fit: a Slice's Pull is booked in the group of its parent, as it was routed; the same brief with no parent is booked in the other", () => {
  const spec = exploring({ ticket: "1", chosen_cell: "task-high", brief_chars: "100", criteria: "1", parent: "3177" });
  const parented = exploring({ ticket: "2", chosen_cell: "task-high", brief_chars: "100", criteria: "1", parent: "2870", session: SESSION2 });
  const own = exploring({ ticket: "3", chosen_cell: "smol-high", brief_chars: "100", criteria: "1" });
  const prior = treeOf({ "*": { input: "parent", cut: 0 } }, ["*", "parent>0", "parent<=0"], { burn_in: true });
  const next = fitTable({ prior, ...direct({ features: [spec, parented, own], members: [], verdicts: [] }), guard: atN });
  assert.equal(next.estimates["parent>0"]["task-high"].n, 2, "both Slices, one per form");
  assert.equal(next.estimates["parent<=0"]?.["task-high"]?.n ?? 0, 0);
  assert.equal(next.estimates["parent<=0"]["smol-high"].n, 1);
});

test("fit: an inner node's estimates are over every Pull that went through it — its own group's and each group's below it", () => {
  // Over DEEP: a bug below the cut ends at the leaf KIND_BELOW; a ticket with a blank kind stops at BELOW, the inner node.
  const bug = exploring({ ticket: "1", chosen_cell: "task-high", brief_chars: "100", kind: "bug" });
  const blank = exploring({ ticket: "2", chosen_cell: "task-high", brief_chars: "100", kind: "", session: SESSION2 });
  const next = fitTable({ prior: treeOf(DEEP, DEEP_NODES, { burn_in: true }), ...direct({ features: [bug, blank], members: [], verdicts: [] }), guard: atN });
  assert.equal(next.estimates[KIND_BELOW]["task-high"].n, 1, "the leaf: its own group's Pull");
  assert.equal(next.estimates[BELOW]["task-high"].n, 2, "the inner node: its own group's Pull and the one below it");
  assert.equal(next.estimates["*"]["task-high"].n, 2);
  assert.equal(next.estimates[NOT_KIND_BELOW], undefined, "a node no Pull went through has none");
});

test("fit: a node with no row of its own holds its parent's — the node one test up its path, at any depth", () => {
  // A third level under DEEP: KIND_BELOW splits on criteria. Every Pull carries one criterion, so the node past
  // that cut, three tests deep, has no Pull and holds its parent's rows. The bugs make smol-high KIND_BELOW's row;
  // smol-high's false claims on enhancements keep BELOW, one test further up, on slow-high.
  const PAST = `${KIND_BELOW}&criteria>2`;
  const prior = treeOf({ ...DEEP, [KIND_BELOW]: { input: "criteria", cut: 2 } }, [...DEEP_NODES, PAST, `${KIND_BELOW}&criteria<=2`], { burn_in: true });
  const { features, members, verdicts } = adoptionInput({ cheapFails: false });
  for (let ticket = 500; ticket < 520; ticket++) {
    const f = featureRow({ ticket: String(ticket), chosen_cell: "smol-high", exploration_draw: "1/3", kind: "enhancement" });
    features.push(f);
    members.push(implementer(f, { pr: String(ticket + 1000), cost: "2", ending: "pr" }));
    verdicts.push(ruled(ticket, ticket + 1000, { minted_false_claim: "yes" }));
  }
  const next = fitTable({ prior, ...direct({ features, members, verdicts }), guard: atN });
  assert.deepEqual([next.rows.cost[BELOW], next.rows.cost[KIND_BELOW]], ["slow-high", "smol-high"], "the fixture: the two ancestors hold different rows");
  assert.equal(next.reasons.cost[PAST].reason, "unjudged", "no Pull went through it");
  assert.equal(next.rows.cost[PAST], "smol-high", "its parent's cost row, not BELOW's");
  assert.equal(next.rows.speed[PAST], next.rows.speed[KIND_BELOW], "its parent's speed row");
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
  assert.equal(t.estimates["*"]["slow-high"].merged, 1, "the dated row's Pull, whose implementer opened the PR, takes a ruling of any date");
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

test("fit refuses a features row whose column a split reads is neither blank nor a plain count; blank or a plain count, or corrupt in a column no split reads, fits", () => {
  const prior = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });
  const fitOver = (features) => fitTable({ prior, ...direct({ features, members: [], verdicts: [] }), guard: { tripped: [], n: {}, window_start: null } });
  const one = exploring({ ticket: "1" });
  for (const bad of CORRUPT_COUNTS) {
    assert.throws(
      () => fitOver([one, exploring({ ticket: "7", brief_chars: bad })]),
      (e) => e instanceof AttributionError && e.message.includes(`ticket #7: a ticket-features row's brief_chars is '${bad}'`),
      JSON.stringify(bad),
    );
    assert.doesNotThrow(() => fitOver([one, exploring({ ticket: "7", criteria: bad })]), `criteria ${JSON.stringify(bad)}: no split reads it`);
  }
  for (const fine of ["", "0", "4047", "5000"]) assert.doesNotThrow(() => fitOver([one, exploring({ ticket: "7", brief_chars: fine })]), JSON.stringify(fine));
});

test("fit and --check refuse at exit 2 a features row whose column a split reads is not a plain count, and leave the table alone; fit --due walks no tree; blanked or fixed, it fits", (t) => {
  const split = (over = {}) => twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, undefined, { burn_in: true, ...over });
  const p = fitWorld(t, { features: [exploring({ ticket: "1" }), exploring({ ticket: "7", brief_chars: "5e3" })], members: [], verdicts: [ruled(1, 11)], table: split() });
  // --check re-fits the commit the table records, so the table records the one holding the row.
  writeFileSync(p.table, JSON.stringify(split({ fitted_commit: p.git("rev-parse", "HEAD") })));
  const before = readFileSync(p.table, "utf8");
  const fitArgs = ["fit", ...p.fitArgs, "--guard", p.guard, "--commit", "HEAD"];
  assert.equal(cli([...fitArgs, "--due"]).status, 0, "--due counts merged PRs and walks no tree");
  for (const args of [fitArgs, ["--check", ...p.fitArgs]]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /cannot join --features .*, --members .* and --verdicts .*: ticket #7: a ticket-features row's brief_chars is '5e3', which a split reads, expected a plain count or blank/);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(p.table, "utf8"), before);
  for (const fixed of ["", "5000"]) {
    p.write({ features: [exploring({ ticket: "1" }), exploring({ ticket: "7", brief_chars: fixed })], verdicts: [ruled(1, 11)] });
    p.commit();
    for (const args of [[...fitArgs, "--due"], fitArgs]) {
      const r = cli(args);
      assert.equal(r.status, 0, `brief_chars ${JSON.stringify(fixed)}, ${args.join(" ")}: ${r.stderr}`);
    }
  }
});

test("parseFeatures reads past a corrupt number column: only a split's walk refuses one", () => {
  for (const bad of CORRUPT_COUNTS.filter((b) => !b.includes("\n") && !b.includes("\t"))) {
    const [row] = parseFeatures(tsv(COLUMNS, [featureRow({ ticket: "7", brief_chars: bad, criteria: bad })], true));
    assert.equal(row.brief_chars, bad, JSON.stringify(bad));
    assert.equal(row.criteria, bad, JSON.stringify(bad));
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
const startingAtN = { "slow-high": 20, "task-high": 20, "smol-high": 20 };

test("fit: a cell at exactly 0.75x the default's $ per merged PR is adopted", () => {
  const next = fitDirect(cellInput([["slow-high", 10], ["smol-high", 7.5]]));
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 7.5);
  assert.equal(next.estimates["*"]["slow-high"].usd_per_merged, 10);
  assert.equal(next.rows.cost["*"], "smol-high");
});

test("fit: a cell just above 0.75x the default's $ per merged PR is not adopted", () => {
  const next = fitDirect(cellInput([["slow-high", 10], ["smol-high", 7.6]]));
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 7.6);
  assert.equal(next.rows.cost["*"], "slow-high");
});

test("fit: equally cheap candidates break the tie by cell name, whatever their order in `cells`", () => {
  // `cells` lists task-high before smol-high; the name order is the reverse.
  const next = fitDirect(cellInput([["slow-high", 10], ["task-high", 2], ["smol-high", 2]]));
  assert.equal(next.rows.cost["*"], "smol-high");
});

test("fit: the cheapest candidate is the one adopted, wherever it sits in `cells`", () => {
  const lastCheapest = fitDirect(cellInput([["slow-high", 10], ["task-high", 5], ["smol-high", 3]]));
  assert.equal(lastCheapest.rows.cost["*"], "smol-high");
  const firstCheapest = fitDirect(cellInput([["slow-high", 10], ["task-high", 3], ["smol-high", 5]]));
  assert.equal(firstCheapest.rows.cost["*"], "task-high");
});

test("fit: a stratum with no default cell on record adopts nothing", () => {
  const next = fitDirect(cellInput([["smol-high", 2]]));
  assert.deepEqual(next.rows.cost, { "*": "slow-high" });
});

test("fit: a stratum whose default cell is below n=20 adopts nothing", () => {
  const next = fitDirect(cellInput([["slow-high", 10, 19], ["smol-high", 2]]));
  assert.deepEqual(next.rows.cost, { "*": "slow-high" });
});

test("fit: an unpriced default-cell Pull leaves the stratum below n=20, so it adopts nothing, even from a cell that cost nothing", () => {
  const input = cellInput([["slow-high", 10], ["smol-high", 0]]);
  input.members[0].cost = "";
  const next = fitDirect(input);
  assert.deepEqual([next.estimates["*"]["slow-high"].n, next.estimates["*"]["slow-high"].unpriced], [19, 1]);
  assert.equal(next.estimates["*"]["smol-high"].usd_per_merged, 0);
  assert.deepEqual(next.rows.cost, { "*": "slow-high" });
});

test("fit: burn-in lasts until every starting Cell is at n>=20, even with an adoption in hand", () => {
  const next = fitDirect(cellInput([["slow-high", 10], ["smol-high", 2]]), { n: { ...startingAtN, "task-high": 19 } });
  assert.equal(next.rows.cost["*"], "smol-high");
  assert.equal(next.burn_in, true);
  assert.deepEqual(next.cells, STARTING);
});

test("fit: burn_in is judged over the starting Cells alone — whatever other Cells the table holds, with any number of merged PRs", () => {
  const input = cellInput([["slow-high", 10], ["smol-high", 2]]);
  const extra = ["slow-medium", "task-max"];
  const burnIn = (n, cells = STARTING, tripped = []) => fitTable({
    prior: baseTable({ burn_in: true, cells }), ...direct(input), guard: { tripped, n, window_start: null },
  }).burn_in;
  // Every starting Cell at MIN_N ends burn-in, however many merged PRs a Cell exploration added has, or whether the guard has a count for it.
  for (const [what, n, cells] of [
    ["no other Cell", startingAtN, STARTING],
    ["another Cell the guard has no count for", startingAtN, [...STARTING, ...extra]],
    ["other Cells at 0 merged PRs", { ...startingAtN, "slow-medium": 0, "task-max": 0 }, [...STARTING, ...extra]],
    ["another Cell below MIN_N", { ...startingAtN, "slow-medium": 3 }, [...STARTING, ...extra]],
    ["another Cell far past MIN_N", { ...startingAtN, "task-max": 500 }, [...STARTING, ...extra]],
  ]) assert.equal(burnIn(n, cells), false, what);
  // A starting Cell short of MIN_N keeps it on, and no other Cell's merged PRs end it.
  for (const [what, n] of [
    ["one starting Cell at MIN_N-1", { ...startingAtN, "task-high": 19 }],
    ["a starting Cell the guard has no count for", { "slow-high": 20, "smol-high": 20 }],
    ["no Cell counted", {}],
    ["a role's model changed: its Cell's newest generation is at 0", { ...startingAtN, "smol-high": 0 }],
  ]) {
    assert.equal(burnIn(n), true, what);
    assert.equal(burnIn({ ...n, "slow-medium": 50, "task-max": 50 }, [...STARTING, ...extra]), true, `${what}, with other Cells past MIN_N`);
  }
  // A trip takes a Cell out of the draw, not out of the count: a tripped starting Cell at MIN_N is at MIN_N.
  assert.equal(burnIn(startingAtN, STARTING, ["smol-high"]), false);
  assert.equal(burnIn({ ...startingAtN, "smol-high": 19 }, STARTING, ["smol-high"]), true);
});

test("fit: the fit adds no Cell — the table's `cells` are the prior's, whatever the guard tripped or a row adopted", () => {
  const input = cellInput([["slow-high", 10], ["smol-high", 2]]);
  for (const tripped of [[], ["task-high"], ["slow-high"], ["smol-high"]]) {
    const next = fitDirect(input, { n: startingAtN, tripped });
    assert.deepEqual(next.cells, STARTING, `tripped: ${tripped.join(", ") || "none"}`);
    assert.equal(next.burn_in, false, `tripped: ${tripped.join(", ") || "none"}: a trip neither ends burn-in nor holds it open`);
  }
});

test("fit: a table holding Cells beyond the starting ones judges its rows over every one of them, and re-fitting it with itself as the prior reproduces it", () => {
  const prior = baseTable({ burn_in: true, cells: [...STARTING, "slow-medium", "task-max"] });
  const input = cellInput([["slow-high", 10], ["smol-high", 2], ["task-high", 10]]);
  const T = fitTable({ prior, ...direct(input), guard: { tripped: [], n: startingAtN, window_start: null } });
  assert.deepEqual([T.cells, T.burn_in], [prior.cells, false], "the two Cells with no merged PR keep no burn-in on");
  assert.deepEqual(Object.keys(T.reasons.cost["*"].cells).sort(), ["slow-medium", "smol-high", "task-high", "task-max"], "the `cost` record judges every cell but its base");
  assert.equal(T.reasons.cost["*"].cells["slow-medium"].verdict, "too-few");
  const again = fitTable({ prior: T, ...direct(input), guard: { ...T.guard, window_start: T.window_start } });
  assert.deepEqual(again, T);
});

test("fit: burn_in reads the starting Cells even when the table's `cells` lacks one — task-high, here, holds it on until it has MIN_N merged PRs", () => {
  const prior = baseTable({ cells: ["slow-high", "smol-high"] });
  const input = cellInput([["slow-high", 10], ["smol-high", 2]]);
  const guard = (n) => ({ tripped: [], n, window_start: null });
  assert.equal(fitTable({ prior, ...direct(input), guard: guard({ "slow-high": 20, "smol-high": 20 }) }).burn_in, true);
  assert.equal(fitTable({ prior, ...direct(input), guard: guard(startingAtN) }).burn_in, false);
});

// Pulls by spec entry, each its own ticket: `merged` Pulls ruled a pass, the first `failed` of them minting a
// false claim, then `hollow` Pulls that never merged. Each implementer is booked at the next of `usd`, a number
// or a list taken in turn, and worked the next of `work` seconds, likewise. `heavy` puts the entry's Pulls above the
// cut of the tree a two-leaf prior splits on (a 5000-char brief), else they are below it (100 chars).
function rowInput(spec) {
  const features = [];
  const members = [];
  const verdicts = [];
  let ticket = 100;
  for (const { cell, heavy = false, merged = 20, failed = 0, usd = 10, work = 60, hollow = 0 } of spec) {
    const costs = [usd].flat();
    const works = [work].flat();
    for (let i = 0; i < merged + hollow; i++, ticket++) {
      const f = exploring({ ticket: String(ticket), chosen_cell: cell, brief_chars: heavy ? "5000" : "100" });
      features.push(f);
      const cost = String(costs[i % costs.length]);
      const work_s = String(works[i % works.length]);
      if (i < merged) {
        members.push(implementer(f, { pr: String(ticket + 1000), ending: "pr", cost, work_s }));
        verdicts.push(ruled(ticket, ticket + 1000, { minted_false_claim: i < failed ? "yes" : "no" }));
      } else members.push(implementer(f, { ending: "hollow", cost, work_s }));
    }
  }
  return { features, members, verdicts };
}
const fitRows = (spec, guard = {}, prior = baseTable()) => fitTable({ prior, ...direct(rowInput(spec)), guard: { tripped: [], n: {}, window_start: null, ...guard } });
const tooFew = { verdict: "too-few", under_floor: null, bar: null, range: null };
// A prior of two leaves, the tree `rowInput` puts Pulls in: the group above the cut and the group below it.
const TREE = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });

test("fit: at the bar — 8 of 20 failed against slow-high's 5 of 20 is exactly 15 points, under the floor; 7 of 20 is adopted", () => {
  const at = (failed) => fitRows([{ cell: "slow-high", failed: 5 }, { cell: "task-high", failed, usd: 5 }]);
  const under = at(8);
  assert.deepEqual(under.reasons.cost["*"].cells["task-high"], { verdict: "under-floor", under_floor: true, bar: 0.4, range: [-5, -5] });
  assert.deepEqual([under.rows.cost["*"], under.reasons.cost["*"].reason], ["slow-high", "no-qualifier"]);
  const over = at(7);
  assert.deepEqual(over.reasons.cost["*"].cells["task-high"], { verdict: "qualifies", under_floor: false, bar: 0.4, range: [-5, -5] });
  assert.deepEqual([over.rows.cost["*"], over.reasons.cost["*"].reason], ["task-high", "sole-qualifier"]);
  // The floor is checked before the price: at $9 against $10 task-high is too dear as well, and reads under the floor.
  const both = fitRows([{ cell: "slow-high", failed: 5 }, { cell: "task-high", failed: 8, usd: 9 }]);
  assert.deepEqual(both.reasons.cost["*"].cells["task-high"], { verdict: "under-floor", under_floor: true, bar: 0.4, range: [-1, -1] });
});

test("fit: the floor is per row — a cell under it in the group below the cut alone is refused there, which keeps a slow-high row of its own while the group above and `*` adopt the cell", () => {
  const next = fitRows([
    { cell: "slow-high" }, { cell: "task-high", failed: 3, usd: 5 },
    { cell: "slow-high", heavy: true }, { cell: "task-high", heavy: true, usd: 5 },
  ], {}, TREE);
  assert.deepEqual(next.rows.cost, { "*": "task-high", [BELOW]: "slow-high", [ABOVE]: "task-high" });
  assert.deepEqual(Object.fromEntries(Object.entries(next.reasons.cost).map(([s, r]) => [s, [r.cell, r.reason, r.cells["task-high"].verdict]])), {
    "*": ["task-high", "sole-qualifier", "qualifies"],
    [BELOW]: ["slow-high", "no-qualifier", "under-floor"],
    [ABOVE]: ["task-high", "sole-qualifier", "qualifies"],
  });
});

test("fit: a node with no untripped candidate at 20 merged PRs is unjudged and holds its parent's row", () => {
  const heavy = [{ cell: "slow-high", heavy: true }, { cell: "task-high", heavy: true, usd: 5 }];
  const few = fitRows([{ cell: "slow-high" }, { cell: "task-high", merged: 19, hollow: 1, usd: 5 }, ...heavy], {}, TREE);
  assert.deepEqual(few.estimates[BELOW]["task-high"].n, 20, "20 counted Pulls, 19 of them merged");
  assert.deepEqual(few.rows.cost, { "*": "task-high", [ABOVE]: "task-high", [BELOW]: "task-high" }, "below the cut, the root's row");
  assert.deepEqual(few.reasons.cost[BELOW], { cell: "task-high", reason: "unjudged", cells: { "task-high": tooFew, "smol-high": tooFew }, pairs: [] });
  const tripped = fitRows([{ cell: "slow-high" }, { cell: "task-high", usd: 5 }, ...heavy], { tripped: ["task-high"] }, TREE);
  assert.deepEqual(tripped.rows.cost, { "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" });
  assert.deepEqual(tripped.reasons.cost[BELOW].cells["task-high"], { ...tooFew, verdict: "tripped" });
  assert.equal(tripped.reasons.cost["*"].reason, "unjudged");
});

test("fit: MIN_N counts merged PRs — slow-high with 20 counted Pulls but 19 merged leaves its node unjudged; at 20 merged it is judged", () => {
  const spec = (slow) => [
    { cell: "slow-high", ...slow }, { cell: "task-high", usd: 5 },
    { cell: "slow-high", heavy: true }, { cell: "task-high", heavy: true, usd: 5 },
  ];
  const short = fitRows(spec({ merged: 19, hollow: 1 }), {}, TREE);
  assert.deepEqual([short.estimates[BELOW]["slow-high"].n, short.estimates[BELOW]["slow-high"].merged], [20, 19]);
  assert.deepEqual(short.reasons.cost[BELOW], { cell: "task-high", reason: "unjudged", cells: {}, pairs: [] }, "no row of its own: the root's");
  const judged = fitRows(spec({ merged: 20, hollow: 1 }), {}, TREE);
  assert.deepEqual([judged.rows.cost[BELOW], judged.reasons.cost[BELOW].reason], ["task-high", "sole-qualifier"]);
});

test("fit: a candidate at or under 0.75x whose range spans zero, or whose upper end reads 0 or −0, is not adopted — the row is slow-high", () => {
  for (const [usd, range] of [[[0, 14], null], [[1, 13], [-5.4, 0]], [[0, 13.33], [-6, 0]]]) {
    const next = fitRows([{ cell: "slow-high" }, { cell: "task-high", usd }]);
    const c = next.reasons.cost["*"].cells["task-high"];
    assert.ok(next.estimates["*"]["task-high"].usd_per_merged <= 7.5, `${usd} is at or under the ratio`);
    assert.equal(c.verdict, "not-reliably-cheaper", `${usd}: ${c.range}`);
    if (range === null) assert.ok(c.range[0] < 0 && c.range[1] > 0, `${usd} spans zero: ${c.range}`);
    else assert.ok(Object.is(c.range[1], 0) && c.range[0] === range[0], `${usd} ends at 0: ${c.range}`);
    assert.deepEqual(next.rows.cost, { "*": "slow-high" });
    assert.equal(next.reasons.cost["*"].reason, "no-qualifier");
  }
});

test("fit: two qualifiers — the reliably cheaper wins whatever the fail rates; else the lower fail rate, then the lower $, then the name", () => {
  const two = (task, smol) => fitRows([{ cell: "slow-high" }, { cell: "task-high", ...task }, { cell: "smol-high", ...smol }]).reasons.cost["*"];
  const reliably = two({ usd: 4, failed: 2 }, { usd: 6 });
  assert.deepEqual([reliably.cell, reliably.reason], ["task-high", "reliably-cheaper"]);
  assert.deepEqual(reliably.pairs, [{ cheaper: "task-high", other: "smol-high", range: [-2, -2] }]);
  const fail = two({ usd: [2, 8], failed: 2 }, { usd: [3, 9] });
  assert.ok(fail.pairs[0].range[1] >= 0, `not reliably cheaper: ${fail.pairs[0].range}`);
  assert.deepEqual([fail.cell, fail.reason], ["smol-high", "lower-fail-rate"]);
  // 2 of 20 against 3 of 30 is one fail rate, in counts, so the lower $ per merged PR wins.
  const usd = two({ usd: [2, 9], failed: 2 }, { usd: [3, 7], merged: 30, failed: 3 });
  assert.ok(usd.pairs[0].range[1] >= 0, `not reliably cheaper: ${usd.pairs[0].range}`);
  assert.deepEqual([usd.cell, usd.reason], ["smol-high", "lower-usd"]);
  // On equal $ the cheaper of the pair is the first by name.
  const name = two({ usd: 2 }, { usd: 2 });
  assert.deepEqual([name.cell, name.reason, name.pairs], ["smol-high", "name", [{ cheaper: "smol-high", other: "task-high", range: [0, 0] }]]);
});

test("fit: three qualifiers — a cell another qualifier is reliably cheaper than never wins, whatever its fail rate", () => {
  const prior = baseTable({ cells: [...STARTING, "task-max"] });
  const r = fitRows([
    { cell: "slow-high" }, { cell: "smol-high", usd: 3, failed: 2 }, { cell: "task-max", usd: [1, 7], failed: 1 }, { cell: "task-high", usd: 6 },
  ], {}, prior).reasons.cost["*"];
  assert.deepEqual(Object.values(r.cells).map((c) => c.verdict), ["qualifies", "qualifies", "qualifies"]);
  assert.equal(r.pairs.length, 3);
  assert.deepEqual(r.pairs.find((x) => x.other === "task-high"), { cheaper: "smol-high", other: "task-high", range: [-3, -3] });
  assert.deepEqual([r.cell, r.reason], ["task-max", "lower-fail-rate"], "task-high fails least, and smol-high is reliably cheaper than it");
});

test("fit: a prior table that records a cell under the floor has no effect on a fit whose figures put the cell above it", () => {
  const refused = { cell: "slow-high", reason: "no-qualifier", cells: { "task-high": { verdict: "under-floor", under_floor: true, bar: 0.15, range: [-5, -5] } }, pairs: [] };
  const prior = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, undefined, { reasons: both({ "*": refused, [ABOVE]: refused, [BELOW]: refused }) });
  const next = fitRows([{ cell: "slow-high" }, { cell: "task-high", usd: 5 }], {}, prior);
  assert.deepEqual(next.rows.cost, { "*": "task-high", [ABOVE]: "task-high", [BELOW]: "task-high" });
  assert.equal(next.reasons.cost[BELOW].cells["task-high"].under_floor, false);
});

test("route: an exploration Pull in a group the floor refused a cell can still draw it; a tripped cell is never drawn", () => {
  const refused = { cell: "slow-high", reason: "no-qualifier", cells: { "slow-medium": { verdict: "under-floor", under_floor: true, bar: 0.4, range: [-5, -5] } }, pairs: [] };
  const table = twoLeaf({ "*": "task-high", [ABOVE]: "task-high", [BELOW]: "slow-high" }, undefined, { reasons: both({ "*": { ...refused, cell: "task-high", reason: "sole-qualifier" }, [ABOVE]: UNJUDGED, [BELOW]: refused }) });
  const drawn = (guard) => new Set(Array.from({ length: 40 }, (_, i) => /CELL=(\S+)/.exec(routeIn({ arm: "A", ticket: i + 1, implRow: 5, table, guard }).line)[1]));
  assert.ok(drawn(readGuard(guardFile())).has("slow-medium"), "the floor never takes a cell out of the draw");
  const tripped = drawn(readGuard(guardFile({ tripped: ["slow-medium"] })));
  assert.equal(tripped.has("slow-medium"), false, "the guard's trip does");
  assert.ok(tripped.has("slow-xhigh"));
});

test("fit prints one line per row, its cell and reason, and --check exits 1 on any edited reason or range", (t) => {
  const p = fitWorld(t, { ...rowInput([{ cell: "slow-high" }, { cell: "task-high", usd: 4 }, { cell: "smol-high", usd: 6 }]), table: twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, undefined, { burn_in: true }) });
  const r = fitCli(p);
  assert.equal(r.status, 0, r.stderr);
  const row = (s) => `ticket-router: row cost ${s} task-high reliably-cheaper \\(task-high qualifies \\[-6\\.00, -6\\.00\\], smol-high qualifies \\[-4\\.00, -4\\.00\\]\\)\n`;
  const speed = (s) => `ticket-router: row speed ${s} task-high no-qualifier \\(slow-high too-slow \\[0\\.00, 0\\.00\\], smol-high too-slow \\[0\\.00, 0\\.00\\]\\)\n`;
  // The root, then the group above the cut — no Pull went through it, so it holds the root's Cell unjudged — then the group below.
  const unjudgedAbove = (o) => `ticket-router: row ${o} ${ABOVE} task-high unjudged\n`;
  assert.match(r.stdout, new RegExp(`\n${row("\\*")}${unjudgedAbove("cost")}${row(BELOW)}${speed("\\*")}${unjudgedAbove("speed")}${speed(BELOW)}$`));
  const good = JSON.parse(readFileSync(p.table, "utf8"));
  for (const [what, edit] of [
    ["a row's reason", (x) => { x.reasons.cost["*"].reason = "lower-usd"; }],
    ["a row's recorded cell", (x) => { x.reasons.cost[BELOW].cell = "smol-high"; }],
    ["a cell's verdict", (x) => { x.reasons.cost["*"].cells["smol-high"].verdict = "too-dear"; }],
    ["a cell's under_floor", (x) => { x.reasons.cost["*"].cells["smol-high"].under_floor = true; }],
    ["a cell's bar", (x) => { x.reasons.cost["*"].cells["smol-high"].bar = 0.2; }],
    ["a cell's range", (x) => { x.reasons.cost["*"].cells["task-high"].range[1] = -5.99; }],
    ["a pair's range", (x) => { x.reasons.cost["*"].pairs[0].range[0] = -2.01; }],
    ["a row's record dropped", (x) => { delete x.reasons.cost[BELOW]; }],
    ["a speed row's reason", (x) => { x.reasons.speed["*"].reason = "fewer-minutes"; }],
    ["a speed cell's verdict", (x) => { x.reasons.speed["*"].cells["smol-high"].verdict = "qualifies"; }],
    ["a speed row's record dropped", (x) => { delete x.reasons.speed[BELOW]; }],
  ]) {
    const bad = structuredClone(good);
    edit(bad);
    writeFileSync(p.table, JSON.stringify(bad));
    const check = cli(["--check", ...p.fitArgs]);
    assert.equal(check.status, 1, `${what}: ${check.stderr}`);
    assert.match(check.stderr, /differs in `reasons`/, what);
  }
  writeFileSync(p.table, JSON.stringify(good));
  assert.equal(cli(["--check", ...p.fitArgs]).status, 0, "the table as fitted is accepted");
});

test("--check holds on a fit whose range ends at −0: the table records it as 0, as JSON reads it back", (t) => {
  const p = fitWorld(t, rowInput([{ cell: "slow-high" }, { cell: "task-high", usd: [0, 13.33] }]));
  assert.equal(fitCli(p).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(p.table, "utf8")).reasons.cost["*"].cells["task-high"].range, [-6, 0]);
  const check = cli(["--check", ...p.fitArgs]);
  assert.equal(check.status, 0, check.stderr);
});

// ---------------------------------------------------------------------------
// the objective: a `speed` row set beside the `cost` one
// ---------------------------------------------------------------------------

// Work time is in seconds per implementer: 100 s a Pull is 1.67 minutes per merged PR, 70 s is 0.7 of it.
test("fit: where task-high is the cost row's cell and slow-high takes 0.7 of its minutes, reliably, the speed row is slow-high and the cost row stays task-high", () => {
  const next = fitRows([{ cell: "slow-high", usd: 10, work: 70 }, { cell: "task-high", usd: 5, work: 100 }], {}, TREE);
  assert.equal(next.rows.cost["*"], "task-high");
  assert.equal(next.rows.speed["*"], "slow-high");
  assert.deepEqual(next.reasons.speed["*"].cells["slow-high"], { verdict: "qualifies", under_floor: false, bar: 0.15, range: [-0.5, -0.5] });
  assert.deepEqual([next.reasons.speed["*"].cell, next.reasons.speed["*"].reason], ["slow-high", "sole-qualifier"]);
  assert.deepEqual(next.reasons.speed["*"].cells["smol-high"], tooFew, "a candidate is every other cell of `cells`");
  assert.deepEqual([next.rows.cost[BELOW], next.rows.speed[BELOW]], ["task-high", "slow-high"], "each node with a cost row of its own is judged");
});

test("fit: a speed row holds the cost row's cell when no candidate qualifies — 0.8 of its minutes, a range across zero, or under the floor", () => {
  // smol-high is too dear to move the cost row in each case, so task-high is the base.
  const base = [{ cell: "slow-high", usd: 10, work: 100, failed: 5 }, { cell: "task-high", usd: 5, work: 100, failed: 5 }];
  const holds = (smol, verdict) => {
    const next = fitRows([...base, { cell: "smol-high", usd: 9, failed: 5, ...smol }]);
    assert.equal(next.rows.cost["*"], "task-high");
    assert.equal(next.rows.speed["*"], "task-high", verdict);
    assert.equal(next.reasons.speed["*"].reason, "no-qualifier", verdict);
    const c = next.reasons.speed["*"].cells["smol-high"];
    assert.equal(c.verdict, verdict);
    return c;
  };
  assert.ok(holds({ work: 80 }, "too-slow").range[1] < 0, "its range lies wholly below zero, and 0.8 still does not qualify");
  const crossing = holds({ work: [0, 0, 0, 280] }, "not-reliably-faster");
  assert.ok(crossing.range[0] < 0 && crossing.range[1] > 0, `0.7 of the base's minutes, a range across zero: ${crossing.range}`);
  const under = holds({ work: 70, failed: 8 }, "under-floor");
  assert.deepEqual([under.under_floor, under.bar], [true, 0.4], "the floor is slow-high's, not the base's");
  assert.equal(holds({ work: 100 }, "too-slow").range[1], 0, "the same minutes are no faster");
});

test("fit: between two speed qualifiers with no reliable difference the lower fail rate wins, then fewer minutes, then the name", () => {
  // slow-high is the cost row's cell in every case: neither candidate is cheaper.
  const pick = (task, smol) => fitRows([{ cell: "slow-high", work: 100 }, { cell: "task-high", ...task }, { cell: "smol-high", ...smol }]).reasons.speed["*"];
  const fails = pick({ work: [40, 60], failed: 2 }, { work: [40, 60], failed: 1 });
  assert.deepEqual([fails.cell, fails.reason], ["smol-high", "lower-fail-rate"]);
  assert.ok(fails.pairs.every((p) => p.range[1] >= 0), "no qualifier is reliably faster than the other");
  const minutes = pick({ work: [40, 60] }, { work: [44, 60] });
  assert.deepEqual([minutes.cell, minutes.reason], ["task-high", "fewer-minutes"]);
  assert.deepEqual(minutes.pairs.map((p) => [p.faster, p.other]), [["task-high", "smol-high"]]);
  const name = pick({ work: 50 }, { work: 50 });
  assert.deepEqual([name.cell, name.reason], ["smol-high", "name"]);
  const reliably = pick({ work: 30 }, { work: 50 });
  assert.deepEqual([reliably.cell, reliably.reason], ["task-high", "reliably-faster"]);
});

test("fit: a node no Pull went through holds its parent's cost and speed rows, each Objective's own, and an unjudged record naming the cell it holds", () => {
  const next = fitRows([{ cell: "slow-high", usd: 10, work: 70 }, { cell: "task-high", usd: 5, work: 100 }], {}, TREE);
  assert.deepEqual([next.rows.cost["*"], next.rows.speed["*"]], ["task-high", "slow-high"], "the root's rows differ between Objectives");
  assert.equal(ABOVE in next.estimates, false, "no Pull went through it: it has no estimates");
  assert.deepEqual([next.rows.cost[ABOVE], next.rows.speed[ABOVE]], ["task-high", "slow-high"]);
  assert.deepEqual(next.reasons.cost[ABOVE], { cell: "task-high", reason: "unjudged", cells: {}, pairs: [] });
  assert.deepEqual(next.reasons.speed[ABOVE], { cell: "slow-high", reason: "unjudged", cells: {}, pairs: [] });
  assert.equal(validateTable(next), next, "the table the fit writes is a valid tree");
});

test("fit: with every starting Cell at MIN_N, burn-in is over whether the speed `*` row has left slow-high or no row has, and the fit adds no Cell", () => {
  const input = rowInput([{ cell: "slow-high", work: 100 }, { cell: "task-high", work: 30 }, { cell: "smol-high", work: 100 }]);
  const next = fitTable({ prior: baseTable({ burn_in: true }), ...direct(input), guard: atN });
  assert.deepEqual([next.rows.cost["*"], next.rows.speed["*"]], ["slow-high", "task-high"]);
  assert.deepEqual([next.burn_in, next.cells], [false, STARTING]);
  const neither = fitTable({ prior: baseTable({ burn_in: true }), ...direct(rowInput([{ cell: "slow-high" }, { cell: "task-high" }, { cell: "smol-high" }])), guard: atN });
  assert.deepEqual([neither.rows.cost["*"], neither.rows.speed["*"], neither.burn_in, neither.cells], ["slow-high", "slow-high", false, STARTING]);
});

test("route: a speed run routes by the speed rows and a cost run by the cost rows; the exploration draw is the same under both", () => {
  const table = baseTable({ rows: both({ "*": "task-high" }, { "*": "smol-high" }) });
  assert.equal(routeIn({ arm: "A", table, objective: "cost" }).line, "POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok");
  const speed = routeIn({ arm: "A", table, objective: "speed" });
  assert.equal(speed.line, "POLICY=smol-high CELL=smol-high DRAW=- BY=- STRATUM=* BRIEF=31 CRITERIA=2 PARENT=- SIZED=- OBJECTIVE=speed TRIPPED=- REASON=ok");
  assert.equal(speed.row.objective, "speed");
  const draws = (objective, over = {}) => Array.from({ length: 30 }, (_, i) => {
    const { line } = routeIn({ arm: "A", ticket: i + 1, implRow: 5, table: { ...table, ...over }, objective });
    return /CELL=\S+ DRAW=\S+/.exec(line)[0];
  });
  assert.deepEqual(draws("speed"), draws("cost"));
  assert.ok(draws("cost").every((d) => !d.startsWith("CELL=task-high")), "the draw leaves out the cost row's cell");
  assert.deepEqual(draws("speed", { burn_in: true }), draws("cost", { burn_in: true }));
});

// Tickets that differ in everything a split could read, and one whose issue was never read.
const TICKETS = {
  "a short brief": issue(), "a long brief": issueOf(9000), "many criteria": issue({ body: `a brief\n${"- [ ] a criterion\n".repeat(9)}` }),
  "a Slice": issue({ body: "Spec: #3177\n\nthe design is there" }), "no kind label": issue({ labels: [] }), "an unread issue": null,
};

test("route: a one-node tree routes every ticket as its `*` row does, under both Objectives — an unread issue and blank metrics included", () => {
  const table = baseTable({ rows: both({ "*": "task-high" }, { "*": "smol-high" }) });
  for (const [what, issueJson] of Object.entries(TICKETS)) {
    for (const [objective, cell] of [["cost", "task-high"], ["speed", "smol-high"]]) {
      const { line, row } = routeIn({ arm: "A", table, objective, issue: issueJson });
      const r = parseRouting(line);
      assert.deepEqual([r.stratum, r.policy, r.cell, r.reason], ["*", cell, cell, issueJson === null ? "no-issue-json" : "ok"], `${what} · ${objective}`);
      assert.equal(row.policy_cell, cell, `${what} · ${objective}: the features row names the Cell`);
      assert.equal(rowDispatch({ table, guard: readGuard(guardFile()), objective, stratum: "*" }).policy, cell, `${what} · ${objective}: rowDispatch agrees`);
    }
  }
});

test("route: a two-leaf tree routes each side by its own row under both Objectives, and the line names the group by its rule path", () => {
  const table = twoLeaf(
    { "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high" },
    { "*": "slow-high", [ABOVE]: "smol-high", [BELOW]: "task-high" },
  );
  const cases = [
    ["cost", CUT + 1, ABOVE, "task-high"], ["cost", CUT, BELOW, "smol-high"], ["cost", 0, BELOW, "smol-high"],
    ["speed", CUT + 1, ABOVE, "smol-high"], ["speed", CUT, BELOW, "task-high"], ["speed", 9000, ABOVE, "smol-high"],
  ];
  for (const [objective, chars, stratum, cell] of cases) {
    assert.equal(routeIn({ arm: "A", table, objective, issue: issueOf(chars) }).line,
      `POLICY=${cell} CELL=${cell} DRAW=- BY=- STRATUM=${stratum} BRIEF=${chars} CRITERIA=0 PARENT=- SIZED=- OBJECTIVE=${objective} TRIPPED=- REASON=ok`, `${objective} ${chars}`);
  }
});

test("route: a ticket missing the input a split reads follows the node's own row — an unread issue at the root, a blank column at the split's node", () => {
  const unread = routeIn({ arm: "A", table: twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high" }), issue: null });
  assert.equal(unread.line, "POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=* BRIEF=- CRITERIA=- PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- REASON=no-issue-json");
  // A blank column on an issue that was read: its created date is no date, so the split on age_days cannot place it.
  const age = treeOf({ "*": { input: "age_days", cut: 3 } }, { "*": "slow-high", "age_days>3": "task-high", "age_days<=3": "smol-high" });
  const dated = parseRouting(routeIn({ arm: "A", table: age, issue: issue() }).line);
  assert.deepEqual([dated.stratum, dated.cell], ["age_days<=3", "smol-high"], "3 days old: not past the cut");
  const undated = parseRouting(routeIn({ arm: "A", table: age, issue: issue({ createdAt: "not a date" }) }).line);
  assert.deepEqual([undated.stratum, undated.policy, undated.cell, undated.reason], ["*", "slow-high", "slow-high", "ok"], "the root's own row");
  // One level down, the node's own row is that node's, not the root's.
  const nodes = { "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high", [`${ABOVE}&age_days>3`]: "slow-medium", [`${ABOVE}&age_days<=3`]: "slow-high" };
  const deep = treeOf({ ...SPLITS, [ABOVE]: { input: "age_days", cut: 3 } }, nodes, { cells: [...STARTING, "slow-medium"] });
  const lost = parseRouting(routeIn({ arm: "A", table: deep, issue: issueOf(5000, { createdAt: "not a date" }) }).line);
  assert.deepEqual([lost.stratum, lost.cell], [ABOVE, "task-high"], "stopped at the node whose split it lacks the input for");
});

test("route: the CLI prints the rule path of a two-leaf table's group, a line the ledger's grammar reads back whole, and the features row records the brief", (t) => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "smol-high" });
  for (const [chars, stratum, cell] of [[5000, ABOVE, "task-high"], [100, BELOW, "smol-high"]]) {
    const p = world(t, { table, issueJson: issueOf(chars) });
    const r = routeCli(p);
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.trim();
    assert.deepEqual([parseLine(r.stdout).STRATUM, parseLine(r.stdout).CELL], [stratum, cell]);
    assert.equal(formatRouting(parseRouting(line)), line);
    assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].brief_chars, String(chars));
  }
});

test("route: on arm B the exploration draw is the same under both, even when arm B is live for one set only, and a sizing label moves it nowhere", () => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "slow-high" }, { "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, { classifier: { b: "haiku", tau: null } });
  assert.equal(bArmLive(table, "cost"), true);
  assert.equal(bArmLive(table, "speed"), false);
  const draws = (objective, sizing) => Array.from({ length: 30 }, (_, i) => {
    const { line } = routeIn({ arm: "B", ticket: i + 1, implRow: 5, table, objective, sizing });
    return /CELL=\S+ DRAW=\S+/.exec(line)[0];
  });
  for (const sizing of [haikuSizing, null]) {
    const cost = draws("cost", sizing);
    assert.ok(cost.every((d) => /DRAW=\d+\/\d+$/.test(d)), "every Pull draws");
    assert.deepEqual(draws("speed", sizing), cost, `sizing ${sizing === null ? "missing" : "heavy"}`);
  }
  assert.deepEqual(draws("cost", haikuSizing), draws("cost", null), "the label moves no draw");
  assert.ok(draws("cost", haikuSizing).every((d) => !d.startsWith("CELL=slow-high")), "the draw leaves out the cost row's cell for the group, which is slow-high below the cut");
});

test("route: arm B reads the run's own row set — not live when that set is all slow-high, whatever the other set holds", () => {
  const table = twoLeaf({ "*": "slow-high", [ABOVE]: "slow-high", [BELOW]: "slow-high" }, { "*": "slow-high", [ABOVE]: "task-high", [BELOW]: "slow-high" }, { classifier: { b: "haiku", tau: null } });
  assert.equal(bArmLive(table, "cost"), false);
  assert.equal(bArmLive(table, "speed"), true);
  assert.equal(routeIn({ table, objective: "cost", sizing: haikuSizing }).row.sizing_src, "rule");
  assert.equal(routeIn({ table, objective: "speed", sizing: haikuSizing, issue: issueOf(5000) }).line,
    `POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=${ABOVE} BRIEF=5000 CRITERIA=0 PARENT=- SIZED=heavy OBJECTIVE=speed TRIPPED=- REASON=ok`);
});

test("route: the features row and the line carry the objective, and a features file written before the column reads it blank", (t) => {
  const p = world(t);
  const r = routeCli(p, { objective: "speed" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseLine(r.stdout).OBJECTIVE, "speed");
  assert.equal(parseFeatures(readFileSync(p.pending, "utf8"))[0].objective, "speed");
  const older = COLUMNS.filter((c) => c !== "objective");
  const [row] = parseFeatures(`${older.join("\t")}\n${formatFeatureRow({ ticket: "7", chosen_cell: "slow-high" }).split("\t").slice(0, -1).join("\t")}\n`);
  assert.deepEqual([row.ticket, row.objective], ["7", ""]);
});

test("route: --objective names cost or speed, else exit 2 and nothing is recorded", (t) => {
  const p = world(t);
  const bogus = routeCli(p, { objective: "fast" });
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /--objective fast is not cost or speed/);
  assert.equal(existsSync(p.pending), false, "nothing is recorded");
});

test("fit: a speed row with no judged candidate holds the cost row's cell", () => {
  const next = fitRows([{ cell: "slow-high", usd: 10, work: 100 }, { cell: "task-high", usd: 5, work: 100 }], { tripped: ["slow-high"] });
  assert.equal(next.rows.cost["*"], "task-high");
  assert.equal(next.reasons.speed["*"].reason, "unjudged");
  assert.equal(next.rows.speed["*"], "task-high");
});

// ---------------------------------------------------------------------------
// rowDispatch: what the cockpit shows is what route does
// ---------------------------------------------------------------------------

const ROW_CELLS = [...STARTING, "slow-medium"];
// A two-leaf table whose every row differs: below the cut task-high under cost and speed, above it smol-high under
// cost and slow-medium under speed, and the root's own rows slow-high and task-high.
const rowTable = (over = {}) => twoLeaf(
  { "*": "slow-high", [BELOW]: "task-high", [ABOVE]: "smol-high" },
  { "*": "task-high", [BELOW]: "task-high", [ABOVE]: "slow-medium" },
  { cells: ROW_CELLS, ...over },
);
// A ticket's group is set by its issue alone: a short brief is below the cut, a long one above it, and an issue never read is the root's.
const GROUP_ISSUE = { [BELOW]: issue(), [ABOVE]: issueOf(CUT + 1), "*": null };
const row5 = (guard, over) => ({ tripped: [], n: {}, window_start: null, ...guard, ...over });
const GUARD_STATES = {
  "missing": null,
  "verdict none": row5({}),
  "a tripped row Cell": row5({ tripped: ["task-high"] }),
  "a tripped draw Cell": row5({ tripped: ["smol-high"] }),
  "every Cell but the default tripped": row5({ tripped: ["task-high", "smol-high", "slow-medium"] }),
  "the speed row's Cell tripped": row5({ tripped: ["slow-medium"] }),
};

// n/d in lowest terms, as assignment_prob writes it: `1`, or `<n>/<d>`.
const lowest = (n, d) => {
  for (let g = Math.min(n, d); g > 1; g--) if (n % g === 0 && d % g === 0) return lowest(n / g, d / g);
  return d === 1 ? String(n) : `${n}/${d}`;
};

test("rowDispatch and route agree for every Objective × Stratum, guard state and phase of the table", () => {
  for (const burn_in of [true, false]) {
    const table = rowTable({ burn_in });
    for (const [state, guard] of Object.entries(GUARD_STATES)) {
      for (const objective of ["cost", "speed"]) {
        for (const stratum of [BELOW, ABOVE, "*"]) {
          const at = `${burn_in ? "burn-in" : "fitted"} · ${state} · ${objective} · ${stratum}`;
          const rd = rowDispatch({ table, guard, objective, stratum, install: INSTALL });
          for (let implRow = 1; implRow <= 10; implRow++) {
            const { line, row } = route({ session: SESSION, ticket: 40 + implRow, arm: "A", implRow, issue: GROUP_ISSUE[stratum], guard, table, objective, install: INSTALL });
            const r = parseRouting(line);
            assert.equal(r.stratum, stratum, at);
            assert.equal(r.policy, rd.policy, `${at}: the policy Cell`);
            const exploring = guard !== null && (burn_in || implRow % 5 === 0);
            if (exploring && rd.draw !== null) {
              assert.equal(r.by, rd.draw.by, `${at} row ${implRow}: by`);
              assert.equal(r.draw.K, rd.draw.cells.length, `${at} row ${implRow}: K`);
              assert.ok(rd.draw.cells.includes(r.cell), `${at} row ${implRow}: ${r.cell} is drawn from ${rd.draw.cells}`);
              if (burn_in) assert.ok(rd.draw.cells.every((c) => STARTING.includes(c)), `${at} row ${implRow}: burn-in draws the starting Cells alone`);
              assert.equal(r.cell, drawCell({ session: SESSION, ticket: 40 + implRow, policyCell: null, cells: rd.draw.cells }).cell, at);
              const K = rd.draw.cells.length;
              // Past burn-in the group's Cell is 4/5 + 1/(5K) where the draw holds it too: under speed the row's Cell can be
              // one of the cost row Cell's exploration Cells.
              const past = lowest((r.cell === rd.policy ? 4 * K : 0) + 1, 5 * K);
              assert.equal(row.assignment_prob, burn_in ? lowest(1, K) : past, `${at} row ${implRow}: probability`);
            } else {
              assert.deepEqual([r.draw, r.by, r.cell], [null, null, rd.policy], `${at} row ${implRow}: not drawn`);
              const K = rd.draw?.cells.length ?? 0;
              const stays = rd.draw !== null && rd.draw.cells.includes(rd.policy) ? lowest(4 * K + 1, 5 * K) : "4/5";
              assert.equal(row.assignment_prob, rd.draw === null || burn_in ? "1" : stays, `${at} row ${implRow}: probability`);
            }
            // REASON keeps the first thing that went wrong: an unreadable issue first, then rowDispatch's, then the draw's.
            const expected = stratum === "*" ? "no-issue-json" : rd.reason !== "ok" ? rd.reason : r.reason;
            assert.equal(r.reason, expected, `${at} row ${implRow}: reason`);
            if (rd.reason === "ok" && stratum !== "*") assert.ok(["ok", "guard-tripped"].includes(r.reason), at);
          }
        }
      }
    }
  }
});

test("route: burn-in draws only the starting Cells, whatever `cells` the table lists — a tripped starting Cell is left out, and a tripped Cell burn-in never drew costs the draw nothing", () => {
  const table = baseTable({ burn_in: true, cells: [...STARTING, "slow-medium", "task-max"] });
  const drawn = (tripped) => Array.from({ length: 60 }, (_, i) => parseRouting(route({
    session: SESSION, ticket: i + 1, arm: "A", implRow: i + 1, issue: issue(), guard: readGuard(guardFile({ tripped })), table, objective: "cost",
  }).line));
  const cellsOf = (routings) => [...new Set(routings.map((r) => r.cell))].sort();
  const open = drawn([]);
  assert.deepEqual(cellsOf(open), [...STARTING].sort(), "every starting Cell is drawn, and no other");
  assert.ok(open.every((r) => r.by === "burn-in" && r.draw.K === 3 && r.reason === "ok"));
  const smol = drawn(["smol-high"]);
  assert.deepEqual(cellsOf(smol), ["slow-high", "task-high"]);
  assert.ok(smol.every((r) => r.draw.K === 2 && r.reason === "guard-tripped"), "the Routing says the guard left a Cell out");
  const outside = drawn(["slow-medium", "task-max"]);
  assert.deepEqual(cellsOf(outside), [...STARTING].sort());
  assert.ok(outside.every((r) => r.draw.K === 3 && r.reason === "ok"), "a Cell burn-in does not draw is no Cell the guard left out of it");
  const all = drawn(STARTING);
  assert.ok(all.every((r) => r.draw === null && r.cell === "slow-high"), "every starting Cell tripped: no draw, and never a Cell outside them");
});

test("the starting Cells are the three models at `high`, in a list no caller can change", () => {
  assert.deepEqual([...STARTING_CELLS], ["slow-high", "task-high", "smol-high"]);
  assert.ok(Object.isFrozen(STARTING_CELLS), "a caller cannot move the set burn-in covers");
});

test("rowDispatch: no guard dispatches the default Cell only, whatever the table says; a guard that holds nothing back is the table", () => {
  const table = rowTable({ burn_in: true });
  assert.deepEqual(rowDispatch({ table, guard: null, objective: "cost", stratum: BELOW }), { policy: "slow-high", reason: "guard-missing", draw: null });
  const none = rowDispatch({ table, guard: row5({}), objective: "cost", stratum: BELOW });
  // slow-medium is one of the table's Cells, and burn-in draws the starting Cells alone.
  assert.deepEqual(none, { policy: "task-high", reason: "ok", draw: { by: "burn-in", cells: STARTING } });
});

test("rowDispatch: after burn-in the draw is the cost row's exploration Cells, under either Objective, less the tripped", () => {
  const table = rowTable();
  assert.deepEqual(rowDispatch({ table, guard: row5({}), objective: "speed", stratum: BELOW, install: INSTALL }).draw,
    { by: "every-5th", cells: ["task-xhigh", "task-medium", "slow-medium", "smol-xhigh"] }, "the group's cost row is task-high, whichever Objective routes");
  assert.deepEqual(rowDispatch({ table, guard: row5({ tripped: ["task-high", "slow-medium"] }), objective: "cost", stratum: BELOW, install: INSTALL }),
    { policy: "slow-high", reason: "table-cell-tripped", draw: { by: "every-5th", cells: ["slow-xhigh", "task-xhigh"] } },
    "a tripped cost row's Cell is replaced by the default, whose exploration Cells the draw then takes, less the tripped");
  assert.equal(rowDispatch({ table, guard: row5({}), objective: "cost", stratum: BELOW }).draw, null, "an install not read runs nothing to draw");
});

test("rowDispatch: no Cell left to draw is no draw", () => {
  const table = rowTable();
  const all = row5({ tripped: ["smol-xhigh", "smol-medium", "task-medium"] });
  assert.equal(rowDispatch({ table, guard: all, objective: "cost", stratum: ABOVE, install: INSTALL }).draw, null, "smol-high's every exploration Cell tripped");
  assert.equal(rowDispatch({ table: rowTable({ burn_in: true }), guard: row5({ tripped: ROW_CELLS }), objective: "cost", stratum: ABOVE }).draw, null);
  // Burn-in draws the starting Cells and no other: with every one tripped, the table's untripped slow-medium is no fallback.
  const startingTripped = row5({ tripped: STARTING });
  assert.equal(rowDispatch({ table: rowTable({ burn_in: true }), guard: startingTripped, objective: "cost", stratum: ABOVE, install: INSTALL }).draw, null);
  assert.deepEqual(rowDispatch({ table: rowTable(), guard: startingTripped, objective: "cost", stratum: ABOVE, install: INSTALL }).draw,
    { by: "every-5th", cells: ["slow-xhigh", "slow-medium", "task-xhigh"] }, "after burn-in, the default Cell's exploration Cells are the draw");
});

test("rowDispatch: a Cell the install cannot run is never drawn", () => {
  const table = rowTable();
  const defined = new Set([...INSTALL.defined].filter((c) => c !== "task-xhigh" && c !== "smol-xhigh"));
  assert.deepEqual(rowDispatch({ table, guard: row5({}), objective: "cost", stratum: BELOW, install: { ...INSTALL, defined } }).draw,
    { by: "every-5th", cells: ["task-medium", "slow-medium"] }, "no definition, no candidate");
  const noSmol = { ...INSTALL, ladders: { ...INSTALL.ladders, smol: [] } };
  assert.deepEqual(rowDispatch({ table, guard: row5({}), objective: "cost", stratum: BELOW, install: noSmol }).draw,
    { by: "every-5th", cells: ["task-xhigh", "task-medium", "slow-medium"] }, "a role the catalog runs at no level has no candidate");
});

test("explorationCells: one level up and down on the role's own ladder, the bigger model one lower, the smaller one higher", () => {
  const L = INSTALL.ladders;
  assert.deepEqual(L, { smol: ["minimal", "low", "medium", "high", "xhigh"], task: ["low", "medium", "high", "xhigh", "max"], slow: ["low", "medium", "high", "xhigh", "max"] });
  assert.deepEqual(explorationCells("task-high", L), ["task-xhigh", "task-medium", "slow-medium", "smol-xhigh"]);
  assert.deepEqual(explorationCells("slow-high", L), ["slow-xhigh", "slow-medium", "task-xhigh"], "no bigger model than slow");
  assert.deepEqual(explorationCells("smol-high", L), ["smol-xhigh", "smol-medium", "task-medium"], "no smaller model than smol");
  assert.deepEqual(explorationCells("slow-max", L), ["slow-xhigh"], "no level above max, on slow's ladder or task's");
  assert.deepEqual(explorationCells("smol-xhigh", L), ["smol-high", "task-high"], "smol's ladder tops out at xhigh");
  assert.deepEqual(explorationCells("task-low", L), ["task-medium", "smol-medium"], "no level below task's lowest, nor below slow's");
});

test("explorationCells: a level the role's catalog does not list is never a candidate — the next rung on its own ladder is", () => {
  const ladders = { smol: ["low", "medium", "high"], task: ["low", "medium", "high", "max"], slow: ["medium", "high", "xhigh", "max"] };
  assert.deepEqual(explorationCells("task-high", ladders), ["task-max", "task-medium", "slow-medium"], "task has no xhigh, and smol nothing above high");
  assert.deepEqual(explorationCells("smol-medium", ladders), ["smol-high", "smol-low", "task-low"]);
  assert.deepEqual(explorationCells("slow-medium", { ...ladders, task: [] }), ["slow-high"], "a role with no ladder has no Cell");
});

test("installOf: each role's ladder is its modelRoles target's catalog levels, by effort; the defined Cells are the implementer definitions", () => {
  const install = installOf({
    modelRoles: { slow: "@task", task: "anthropic/claude-sonnet-5-5:high", smol: "anthropic/claude-unlisted" },
    catalog: { models: [{ selector: "anthropic/claude-sonnet-5-5", thinking: ["max", "high", "low", "auto"] }] },
    definitions: ["fleet-implementer-task-high.agent.md", "fleet-reviewer.agent.md", "fleet-implementer-task-max.agent.md", "notes.txt"],
  });
  assert.deepEqual(install.ladders, { smol: [], task: ["low", "high", "max"], slow: ["low", "high", "max"] },
    "slow follows its alias to task's model; a model the catalog does not list runs at no level; a level no Cell names is dropped");
  assert.deepEqual([...install.defined].sort(), ["task-high", "task-max"]);
  assert.deepEqual(installOf({ modelRoles: null, catalog: null, definitions: [] }).ladders, { smol: [], task: [], slow: [] });
});

test("assignmentProb: 1/N in burn-in, 4/5 at the group's Cell after it, 1/5 of 1/K on an exploring draw, 1 with nothing drawn", () => {
  const prob = (burnIn, chainHead, cell, policy, cells) => assignmentProb({ burnIn, chainHead, cell, policy, cells });
  assert.equal(prob(true, false, "task-high", "slow-high", STARTING), "1/3");
  assert.equal(prob(true, true, "task-high", "slow-high", STARTING), "1/3", "a burn-in chain head was drawn too");
  assert.equal(prob(true, false, "task-high", "slow-high", ["task-high"]), "1");
  assert.equal(prob(true, false, "slow-high", "slow-high", []), "1", "every starting Cell tripped");
  const around = ["task-xhigh", "task-medium", "slow-medium", "smol-xhigh"];
  assert.equal(prob(false, false, "task-high", "task-high", around), "4/5");
  assert.equal(prob(false, false, "slow-medium", "task-high", around), "1/20");
  assert.equal(prob(false, false, "slow-medium", "task-high", ["slow-medium"]), "1/5");
  assert.equal(prob(false, true, "task-high", "task-high", around), "1", "a chain head never explores");
  assert.equal(prob(false, false, "task-high", "task-high", []), "1", "no candidate: no exploring slot could take it");
});

test("assignmentProb: a group Cell the draw also holds sums both ways to it, whichever way this Pull came", () => {
  // Under `speed` the group's Cell can be one of the `cost` row Cell's exploration Cells: 4/5 + 1/(5K).
  const around = ["task-xhigh", "task-medium", "slow-medium", "smol-xhigh"];
  const prob = (cell, cells = around) => assignmentProb({ burnIn: false, chainHead: false, cell, policy: "task-xhigh", cells });
  assert.equal(prob("task-xhigh"), "17/20", "drawn or not, the group's Cell is 4/5 + 1/20");
  assert.equal(prob("task-medium"), "1/20", "any other drawn Cell is the exploring share alone");
  assert.equal(prob("task-xhigh", ["task-xhigh"]), "1", "a draw over the group's Cell alone leaves no other Cell");
  assert.equal(prob("task-xhigh", [...around, "slow-high", "task-max"]), "5/6", "25/30 in lowest terms");
});

test("route: under speed, a group Cell that is one of the cost row Cell's exploration Cells records 4/5 + 1/(5K), drawn or not", () => {
  const table = baseTable({ rows: { cost: { "*": "task-high" }, speed: { "*": "task-xhigh" } } });
  const guard = readGuard(guardFile());
  const seen = new Set();
  for (let ticket = 1; ticket <= 60; ticket++) {
    for (const implRow of [3, 5]) {
      const { row } = routeIn({ ticket, implRow, table, guard, objective: "speed", arm: "A" });
      assert.equal(row.policy_cell, "task-xhigh");
      assert.equal(row.assignment_prob, row.chosen_cell === "task-xhigh" ? "17/20" : "1/20", `ticket ${ticket} row ${implRow}: ${row.chosen_cell}`);
      seen.add(`${implRow} ${row.chosen_cell}`);
    }
  }
  assert.ok(seen.has("3 task-xhigh") && seen.has("5 task-xhigh"), "a Pull that stays and one that draws the group's Cell");
  assert.ok([...seen].some((s) => s.startsWith("5 ") && s !== "5 task-xhigh"), "an exploring Pull that draws another Cell");
  // A tripped speed Cell falls back to the default, slow-high, which is one of task-xhigh's exploration Cells (K = 3).
  const fallback = baseTable({ rows: { cost: { "*": "task-xhigh" }, speed: { "*": "task-medium" } } });
  const { row } = routeIn({ table: fallback, guard: readGuard(guardFile({ tripped: ["task-medium"] })), objective: "speed", arm: "A" });
  assert.deepEqual([row.policy_cell, row.chosen_cell, row.assignment_prob], ["slow-high", "slow-high", "13/15"]);
});

test("route: a Pull with no guard runs the default Cell with probability 1", () => {
  for (const burn_in of [true, false]) {
    const { row } = routeIn({ arm: "A", implRow: 5, guard: null, table: baseTable({ burn_in }) });
    assert.deepEqual([row.chosen_cell, row.exploration_draw, row.assignment_prob], ["slow-high", "", "1"], `burn_in ${burn_in}`);
  }
});

test("burn-in is one set: a Cell holds the fit's burn_in open exactly when burn-in draws it, whatever else the table lists", () => {
  const table = baseTable({ burn_in: true, cells: ROW_CELLS });
  const drawn = rowDispatch({ table, guard: row5({}), objective: "cost", stratum: "*" }).draw.cells;
  assert.deepEqual([...drawn].sort(), [...STARTING].sort());
  for (const cell of ROW_CELLS) {
    // Every Cell at MIN_N but this one, which has none.
    const n = Object.fromEntries(ROW_CELLS.map((c) => [c, c === cell ? 0 : 20]));
    const fitted = fitTable({ prior: table, features: [], members: [], verdicts: [], guard: { tripped: [], n, window_start: null } });
    assert.equal(fitted.burn_in, drawn.includes(cell), `${cell}: short alone, it ${fitted.burn_in ? "holds" : "does not hold"} burn-in on, and burn-in ${drawn.includes(cell) ? "draws" : "does not draw"} it`);
  }
});

test("rowFor: a group without a row of its own follows `*` — as a group named by a Routing filed before the tree does", () => {
  assert.equal(rowFor({ "*": "slow-high", [ABOVE]: "task-high" }, ABOVE), "task-high");
  assert.equal(rowFor({ "*": "slow-high", [ABOVE]: "task-high" }, BELOW), "slow-high");
  for (const old of ["light", "heavy", "unknown"]) assert.equal(rowFor({ "*": "slow-high", [ABOVE]: "task-high" }, old), "slow-high", old);
});

test("rowDispatch and route agree on arm B: a sizing label moves neither the policy row nor the draw, and is recorded", () => {
  const table = rowTable({ classifier: { b: "haiku", tau: null } });
  const guard = row5({ tripped: ["smol-high"] });
  // A short brief the sizing calls heavy: the walk puts it below the cut, so its row, its Cell and its draw are that group's.
  const args = { session: SESSION, ticket: 42, implRow: 5, issue: issue(), sizing: haikuSizing, guard, table, objective: "speed", install: INSTALL };
  const r = parseRouting(route({ ...args, arm: "B" }).line);
  assert.deepEqual([r.stratum, r.sized], [BELOW, "heavy"]);
  assert.equal(r.policy, rowDispatch({ table, guard, objective: "speed", stratum: BELOW }).policy);
  const below = rowDispatch({ table, guard, objective: "cost", stratum: BELOW, install: INSTALL });
  assert.equal(r.by, below.draw.by);
  assert.ok(below.draw.cells.includes(r.cell), `${r.cell} is drawn from the cost row's pool ${below.draw.cells}`);
  assert.equal(r.draw.K, below.draw.cells.length);
  assert.deepEqual({ ...r, sized: null }, parseRouting(route({ ...args, arm: "A" }).line), "arm A's Routing but for the label");
});
