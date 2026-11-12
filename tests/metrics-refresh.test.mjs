// metrics-refresh.mjs: the drain of the pending ticket-features rows, the
// cost-guard refresh and the Fit beside it, run as the CLI against a fixture workspace — a git
// checkout carrying the metrics corpus, and a stub `gh` that answers
// pr-cost's `pr list` slices from a fixture file as GitHub's search would
// (tests/support/gh-pr-search.mjs) and logs every call it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow, parseTierOutcomes } from "../plugin/scripts/tier-outcomes.mjs";
import { DAY_ONE_TABLE, dayOneScripts } from "./support/day-one-router-table.mjs";
import { SEARCH_STUB_SRC, fillerPrs, searchesOf } from "./support/gh-pr-search.mjs";
import { WINDOW_START, MIN_N } from "../plugin/scripts/pr-cost.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "../plugin/scripts/pull-attribution.mjs";
import { fitTree, validateTable } from "../plugin/scripts/ticket-router.mjs";
import { writeFit } from "../plugin/scripts/metrics-refresh.mjs";
import { corpus as pullsOf, flip } from "./support/gate-corpus.mjs";
import { refitFailure } from "../plugin/scripts/compute-cell-evidence.mjs";

// A copy of the scripts holding the day-one table, so the installed table the run reads as its prior does not move with a re-fit.
const SCRIPT = join(dayOneScripts(), "metrics-refresh.mjs");
const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const PENDING = join(".fleet", "ticket-features.pending.tsv");
const FEATURES = join("docs", "metrics", "ticket-features.tsv");
const GUARD = join(".fleet", "cost-guard.json");
const MODEL_OF = { slow: "claude-opus-5", task: "claude-sonnet-5", smol: "claude-haiku-4-5" };

// Pinned identity, no developer config, no inherited repo pointers.
const ENV = {
  ...process.env,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_TEMPLATE_DIR: undefined,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { env: ENV, encoding: "utf8" }).trim();

const pull = (o) => ({
  run_date: DAY, session: SESSION, policy_cell: "slow-high", chosen_cell: "slow-high", exploration_draw: "",
  sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0",
  age_days: "0", paths: "0", test_paths: "0", xrefs: "0", kind: "enhancement", ...o,
});
const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp", subagentType: "",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, dispatchModel: o.model ?? "claude-opus-5", workS: 60, ...o,
});
const tier = (o) => ({
  run_date: DAY, class: "", tier: "", closed_own_ticket: "yes", minted_false_claim: "no", note: "n",
  sizing: "light", profile: "small", loc: "10", files: "1", ...o,
});
const corpus = () => ({ features: [], members: [], tiers: [] });
// One ruled Pull at `cell`: its features row, its admissible member row that opened the PR, its verdict.
function ruled(rows, { ticket, cell = "slow-high", fail = false }) {
  const [role, level] = cell.split("-");
  const agent = `impl-${ticket}`;
  rows.features.push(pull({ ticket: String(ticket), agent, chosen_cell: cell }));
  rows.members.push(member({
    agent, ticket: String(ticket), pr: String(ticket + 5000), effort: level, model: MODEL_OF[role], subagentType: `fleet-implementer-${cell}`,
  }));
  rows.tiers.push(tier({ ticket: String(ticket), pr: String(ticket + 5000), minted_false_claim: fail ? "yes" : "no" }));
}

const featuresTsv = (rows, cols = FEATURE_COLUMNS) => [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n";
const membersTsv = (rows) => `# ${MEMBER_COLUMNS.join("\t")}\n${rows.length ? formatTsv(rows) : ""}`;
const tiersTsv = (rows) => `# ${TIER_COLUMNS.join("\t")}\n${rows.map((r) => `${formatRow(r)}\n`).join("")}`;

// Answers pr-cost's `pr list` from GH_FIXTURE, as the search would (its `created:` window, cut at 1,000); logs each argv to GH_LOG.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
${SEARCH_STUB_SRC}
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
if (args.slice(0, 2).join(" ") === "pr list") process.stdout.write(JSON.stringify(searchPrs(fx.prs, args, FIRST_DAY)));
else { process.stderr.write("gh stub: unexpected " + args.join(" ")); process.exit(9); }
`;

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// The install the fixtures read in place of omp's own: every role's model runs low to max but smol's, which stops at xhigh.
const INSTALL_ROLES = { slow: "anthropic/claude-opus-5-5", task: "anthropic/claude-sonnet-5-5", smol: "anthropic/claude-haiku-4-5" };
const installCatalog = (thinking = {}) => {
  const ladder = { slow: ["low", "medium", "high", "xhigh", "max"], task: ["low", "medium", "high", "xhigh", "max"], smol: ["minimal", "low", "medium", "high", "xhigh"], ...thinking };
  return { models: Object.entries(INSTALL_ROLES).map(([role, selector]) => ({ selector, thinking: ladder[role] })) };
};

function fixture({ rows = corpus(), pending = null, guardBefore = null, prs = [], catalog = installCatalog() } = {}) {
  const root = tempDir("metrics-refresh-");
  const repo = join(root, "repo");
  git(root, ["init", "--quiet", "-b", "main", repo]);
  write(repo, ".gitignore", ".fleet/\n");
  write(repo, FEATURES, featuresTsv(rows.features));
  write(repo, "docs/metrics/member-outcomes.tsv", membersTsv(rows.members));
  write(repo, "docs/metrics/tier-outcomes.tsv", tiersTsv(rows.tiers));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "corpus"]);
  if (pending !== null) write(repo, PENDING, pending);
  if (guardBefore !== null) write(repo, GUARD, JSON.stringify(guardBefore));
  mkdirSync(join(root, "bin"));
  writeExecStub(join(root, "bin", "gh"), GH_STUB);
  writeFileSync(join(root, "gh.json"), JSON.stringify({ prs }));
  // Pinned, so no run reads omp live: an argument naming either file first overrides it.
  writeFileSync(join(root, "model-roles.json"), JSON.stringify(INSTALL_ROLES));
  writeFileSync(join(root, "catalog.json"), JSON.stringify(catalog));
  const installArgs = ["--model-roles", join(root, "model-roles.json"), "--catalog", join(root, "catalog.json")];
  const log = join(root, "gh.log");
  return {
    root, repo,
    run({ cwd = repo, args = ["--repo", repo] } = {}) {
      return spawnSync(process.execPath, [SCRIPT, ...args, ...installArgs], {
        cwd, encoding: "utf8",
        env: { ...ENV, PATH: `${join(root, "bin")}:${process.env.PATH}`, GH_FIXTURE: join(root, "gh.json"), GH_LOG: log },
      });
    },
    ghCalls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

test("drains the pending TSV into ticket-features.tsv, deduped on session + agent, and writes a fresh cost-guard.json", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  const fresh = [pull({ ticket: "2", agent: "impl-2" }), pull({ ticket: "3", agent: "impl-3", chosen_cell: "task-high", exploration_draw: "2/3" })];
  // Read by column name: a pending header in another order drains the same rows.
  const pending = featuresTsv([rows.features[0], fresh[0], ...fresh], [...FEATURE_COLUMNS].reverse());
  const f = fixture({ rows, pending, guardBefore: { computed_at: "2000-01-01T00:00:00.000Z", verdict: "ok", tripped: [], cells: [] } });
  const started = Date.now();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), featuresTsv([rows.features[0], ...fresh]));
  assert.equal(existsSync(join(f.repo, PENDING)), false, "the drained pending file is gone");
  assert.match(r.stdout, /metrics-refresh: drain: 2 rows from \.fleet\/ticket-features\.pending\.tsv into docs\/metrics\/ticket-features\.tsv \(2 already there\)/);
  const guard = JSON.parse(readFileSync(join(f.repo, GUARD), "utf8"));
  assert.ok(Date.parse(guard.computed_at) >= started - 1000, `a fresh guard, not the stale one: ${guard.computed_at}`);
  assert.equal(guard.verdict, "none");
  assert.match(r.stdout, /cost guard: verdict none, pr-cost\.mjs exit 4/, "no verdict yet is a verdict, not a failure");
  assert.deepEqual(f.ghCalls().map((c) => c.slice(0, 2).join(" ")), ["pr list"], "nothing is written to GitHub");
});

test("with no --repo it works on the main checkout of the cwd's repository; a second run finds nothing pending and changes nothing", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  const fresh = pull({ ticket: "2", agent: "impl-2" });
  const f = fixture({ rows, pending: featuresTsv([fresh]) });
  const wt = join(f.root, "wt");
  git(f.repo, ["worktree", "add", "--quiet", wt]);
  const r = f.run({ cwd: wt, args: [] });
  assert.equal(r.status, 0, r.stderr);
  const drained = readFileSync(join(f.repo, FEATURES), "utf8");
  assert.equal(drained, featuresTsv([rows.features[0], fresh]));
  assert.equal(existsSync(join(f.repo, GUARD)), true);
  assert.equal(existsSync(join(wt, ".fleet")), false, "nothing is written under the linked worktree");

  const again = f.run({ cwd: wt, args: [] });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /drain: nothing pending in \.fleet\/ticket-features\.pending\.tsv/);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), drained);
});

test("--repo from a cwd outside the repository runs the guard inside it", () => {
  const f = fixture();
  const r = f.run({ cwd: f.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cost guard: verdict none, pr-cost\.mjs exit 4/);
  assert.equal(existsSync(join(f.repo, GUARD)), true);
});

test("a corpus whose last row lacks a trailing newline gets the first drained row on its own line", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  const fresh = pull({ ticket: "2", agent: "impl-2" });
  const f = fixture({ rows, pending: featuresTsv([fresh]) });
  write(f.repo, FEATURES, featuresTsv(rows.features).replace(/\n$/, ""));
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), featuresTsv([rows.features[0], fresh]));
});

test("a tripped guard is a verdict and the script exits 0; a guard that cannot be computed fails it", () => {
  const rows = corpus();
  const prs = [];
  for (let i = 0; i < MIN_N; i++) {
    ruled(rows, { ticket: 1000 + i, cell: "slow-high", fail: i < 6 });
    ruled(rows, { ticket: 2000 + i, cell: "task-high", fail: i < 9 });
    prs.push({ number: 6000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z` }, { number: 7000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z` });
  }
  const t = fixture({ rows, prs }).run();
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /cost guard: verdict tripped \(tripped: task-high\), pr-cost\.mjs exit 3/);

  const broken = fixture({ rows: corpus() });
  writeFileSync(join(broken.repo, "docs", "metrics", "tier-outcomes.tsv"), "short\trow\n");
  const b = broken.run();
  assert.equal(b.status, 1);
  assert.match(b.stderr, /metrics-refresh: cost guard failed: pr-cost\.mjs --guard exited 2/);
});

test("more than 1,000 PRs opened in the window is read in slices: the guard is computed, not failed on the search cap", () => {
  const rows = corpus();
  const prs = fillerPrs(1500);
  for (let i = 0; i < MIN_N; i++) {
    ruled(rows, { ticket: 1000 + i });
    prs.push({ number: 6000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z`, createdAt: `2026-10-${String(3 + (i % 28)).padStart(2, "0")}T08:00:00Z` });
  }
  const f = fixture({ rows, prs });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cost guard: verdict ok, pr-cost\.mjs exit 0/);
  const guard = JSON.parse(readFileSync(join(f.repo, GUARD), "utf8"));
  assert.equal(guard.cells.find((c) => c.cell === "slow-high").n, MIN_N, "every merged PR is read, across the slices");
  const searches = searchesOf(f.ghCalls());
  assert.equal(searches[0], `created:>=${WINDOW_START}`);
  assert.ok(searches.length > 1, "the full first read was split");
});

test("a day that alone fills the search cap fails the guard and writes none, rather than reading merged state short", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1000 });
  const prs = Array.from({ length: 1000 }, (_, i) => ({ number: 90000 + i, state: "CLOSED", mergedAt: null, createdAt: `${DAY}T09:00:00Z` }));
  const f = fixture({ rows, prs, guardBefore: null });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /metrics-refresh: cost guard failed: pr-cost\.mjs --guard exited 2: .*one day cannot be split further/);
  assert.equal(existsSync(join(f.repo, GUARD)), false);
});

test("a workspace with no metrics corpus yet skips the guard with a notice and exits 0, still draining what is pending", () => {
  const f = fixture();
  rmSync(join(f.repo, "docs"), { recursive: true });
  const bare = f.run();
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /metrics-refresh: drain: nothing pending/);
  assert.match(bare.stdout, /metrics-refresh: cost guard: skipped, docs\/metrics\/member-outcomes\.tsv, docs\/metrics\/tier-outcomes\.tsv, docs\/metrics\/ticket-features\.tsv not found/);
  assert.equal(existsSync(join(f.repo, GUARD)), false);
  assert.deepEqual(f.ghCalls(), [], "no guard run, so no gh call");

  // A first run's rows: the drain creates the features file, and the guard still
  // waits on the two the controller writes later in the run.
  write(f.repo, PENDING, featuresTsv([pull({ ticket: "2", agent: "impl-2" })]));
  const fed = f.run();
  assert.equal(fed.status, 0, fed.stderr);
  assert.match(fed.stdout, /drain: 1 row from/);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), featuresTsv([pull({ ticket: "2", agent: "impl-2" })]));
  assert.match(fed.stdout, /cost guard: skipped, docs\/metrics\/member-outcomes\.tsv, docs\/metrics\/tier-outcomes\.tsv not found/);
  assert.deepEqual(f.ghCalls(), []);
});

test("a pending file with a column the corpus lacks fails the drain, leaves the pending file, and the guard does not run", () => {
  const f = fixture({ pending: featuresTsv([pull({ ticket: "2", agent: "impl-2" })], [...FEATURE_COLUMNS, "extra"]) });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /metrics-refresh: drain failed:/);
  assert.equal(existsSync(join(f.repo, PENDING)), true, "the rows stay for the next drain");
  assert.equal(existsSync(join(f.repo, GUARD)), false);
  assert.deepEqual(f.ghCalls(), []);
});

// A corpus or pending file from before a column lacks every later column too:
// `objective`, then `parent`, then the named-path columns, the title and the plugin version, then the assignment
// probability.
const NAMED = ["named_paths", "named_lines", "dirs", "title", "plugin_version"];
const PROB = "assignment_prob";
const OLDER = [["objective", "parent", ...NAMED, PROB], ["parent", ...NAMED, PROB], [...NAMED, PROB], [PROB]];

test("a corpus written before the objective, parent, named-path or assignment columns gains them, blank on the rows it holds, when the pending file carries them", () => {
  for (const lacks of OLDER) {
    const rows = corpus();
    ruled(rows, { ticket: 1 });
    const older = FEATURE_COLUMNS.filter((c) => !lacks.includes(c));
    const fresh = pull({
      ticket: "2", agent: "impl-2", objective: "speed", parent: "3177",
      named_paths: "plugin/a.mjs docs/gone.md", named_lines: "12 -", dirs: "2", title: "A title", plugin_version: "1.2.3", assignment_prob: "1/15",
    });
    const f = fixture({ rows, pending: featuresTsv([fresh]) });
    write(f.repo, FEATURES, featuresTsv(rows.features, older));
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /drain: 1 row from/);
    const blank = Object.fromEntries(lacks.map((c) => [c, ""]));
    assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), featuresTsv([{ ...rows.features[0], ...blank }, fresh]), lacks.join());
  }
});

test("a pending file written before the objective, parent, named-path or assignment columns drains, its rows blank in them", () => {
  for (const lacks of OLDER) {
    const older = FEATURE_COLUMNS.filter((c) => !lacks.includes(c));
    const fresh = pull({ ticket: "2", agent: "impl-2", parent: "3177", title: "A title", assignment_prob: "4/5" });
    const f = fixture({ pending: featuresTsv([fresh], older) });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const last = readFileSync(join(f.repo, FEATURES), "utf8").split("\n").filter(Boolean).at(-1);
    assert.equal(last, FEATURE_COLUMNS.map((c) => (lacks.includes(c) ? "" : fresh[c] ?? "")).join("\t"), lacks.join());
  }
});

test("an empty or blank-only pending file is removed with its own line, exit 0, and the corpus is untouched", () => {
  for (const pending of ["", "\n\n", " \t\r\n"]) {
    const f = fixture({ pending });
    const before = readFileSync(join(f.repo, FEATURES), "utf8");
    const r = f.run();
    assert.equal(r.status, 0, `${JSON.stringify(pending)}: ${r.stderr}`);
    assert.equal(existsSync(join(f.repo, PENDING)), false, `${JSON.stringify(pending)}: the empty pending file is gone`);
    assert.match(r.stdout, /metrics-refresh: drain: \.fleet\/ticket-features\.pending\.tsv was empty — removed \(an append created it and never wrote: crash or full disk\)/);
    assert.doesNotMatch(r.stdout, /nothing pending/);
    assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), before);
  }
});

test("a pending file with rows but no header fails the drain naming the pending file, and is left in place", () => {
  const row = pull({ ticket: "2", agent: "impl-2" });
  const f = fixture({ pending: `${FEATURE_COLUMNS.map((c) => row[c]).join("\t")}\n` });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /metrics-refresh: drain failed: \.fleet\/ticket-features\.pending\.tsv: ticket-features\.tsv header lacks run_date/);
  assert.equal(existsSync(join(f.repo, PENDING)), true, "a headerless file is not repaired or removed");
  assert.equal(existsSync(join(f.repo, GUARD)), false);
});

const FIT = join(".fleet", "router-fit.json");
const SHIPPED = DAY_ONE_TABLE;
const INSTALLED_VERSION = JSON.parse(readFileSync(new URL("../plugin/package.json", import.meta.url), "utf8")).version;

// The run's route call against the fixture workspace, from the same scripts directory: no `--table`, so it routes by
// the Fit beside the guard, else by the starting table. `table`, when given, is passed as `--table` instead.
const ROUTER = join(dirname(SCRIPT), "ticket-router.mjs");
function routeIn(f, table = null, labels = ["bug"]) {
  const issue = join(f.root, "issue.json");
  writeFileSync(issue, JSON.stringify({ title: "t", body: "short brief\n- [ ] one", comments: [], labels: labels.map((name) => ({ name })), createdAt: "2026-10-01T00:00:00Z" }));
  const tableArgs = [];
  if (table !== null) {
    const path = join(f.root, "routed-table.json");
    writeFileSync(path, JSON.stringify(table));
    tableArgs.push("--table", path);
  }
  // The fixture's install, so a Pull past burn-in reads no live omp.
  const roles = join(f.root, "model-roles.json");
  const catalog = join(f.root, "catalog.json");
  const r = spawnSync(process.execPath, [ROUTER, "route", "--session", SESSION, "--objective", "cost", "--ticket", "42", "--arm", "A", "--impl-row", "3",
    "--issue", issue, "--guard", join(f.repo, GUARD), "--pending", join(f.root, "pending.tsv"), "--model-roles", roles, "--catalog", catalog, ...tableArgs],
  { cwd: f.repo, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("a phase 0 over fixture records writes router-fit.json beside the fresh guard: the guard it used, the records it read, the starting table as prior", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  ruled(rows, { ticket: 2, cell: "task-high" });
  const f = fixture({ rows });
  const started = Date.now();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const guard = JSON.parse(readFileSync(join(f.repo, GUARD), "utf8"));
  const fit = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  assert.deepEqual(Object.keys(fit), ["computed_at", "guard_computed_at", "guard", "tsv_blobs", "prior", "table", "gate"]);
  assert.ok(Date.parse(fit.computed_at) >= started - 1000, fit.computed_at);
  assert.equal(fit.guard_computed_at, guard.computed_at, "fitted beside the guard this run wrote");
  assert.deepEqual(fit.guard, {
    computed_at: guard.computed_at, tripped: guard.tripped.map((t) => t.cell ?? t).sort(),
    n: Object.fromEntries(guard.cells.map((c) => [c.cell, c.n])), window_start: guard.window_start,
  }, "the guard it used: its tripped Cells, per-Cell n and its own computed_at");
  assert.deepEqual(fit.tsv_blobs, guard.tsv_blobs, "the same working-tree files the guard read, by the same keys");
  assert.equal(fit.tsv_blobs["docs/metrics/tier-outcomes.tsv"], git(f.repo, ["hash-object", "docs/metrics/tier-outcomes.tsv"]));
  assert.deepEqual(fit.prior, {
    version: INSTALLED_VERSION, cells: SHIPPED.cells,
    classifier: SHIPPED.classifier, splits: SHIPPED.splits, window_start: SHIPPED.window_start,
  });
  assert.equal(validateTable(fit.table) instanceof Error, false, "route reads it through validateTable");
  assert.deepEqual(Object.keys(fit.table).sort(), ["burn_in", "cells", "classifier", "estimates", "guard", "n_rows", "reasons", "rows", "splits", "starting_cells", "window_start"], "the table carries no commit field");
  assert.deepEqual(fit.table.starting_cells, ["slow-high", "task-high", "smol-high"], "the Fit records the starting Cells it counted");
  assert.equal(fit.table.n_rows, 2);
  assert.equal(fit.table.window_start, guard.window_start);
  assert.match(r.stdout, /metrics-refresh: fit: fitted 2 Pulls, in burn-in; \.fleet\/router-fit\.json computed /);
  assert.equal(existsSync(join(f.repo, `${FIT}.tmp`)), false, "the temp file was renamed into place");
  assert.equal(git(f.repo, ["status", "--porcelain", "--ignored=no"]), "", "nothing tracked changed: the Fit is never committed");
  assert.equal(git(f.repo, ["check-ignore", FIT]), FIT, "the Fit file is ignored, so a Close-out PR never carries it");
});

test("a Fit over every starting Cell at MIN_N merged PRs is out of burn-in, says nothing of it on its line, and adds no Cell", () => {
  const rows = corpus();
  const prs = [];
  for (const [first, cell] of [[1000, "slow-high"], [2000, "task-high"], [3000, "smol-high"]]) {
    for (let i = 0; i < MIN_N; i++) {
      ruled(rows, { ticket: first + i, cell });
      prs.push({ number: first + 5000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z` });
    }
  }
  const f = fixture({ rows, prs });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /metrics-refresh: fit: fitted 60 Pulls; \.fleet\/router-fit\.json computed /);
  const { table } = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  assert.equal(table.burn_in, false);
  assert.deepEqual(table.cells, SHIPPED.cells);
});

test("the next route call routes by the Fit phase 0 wrote", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const fit = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  // A Fit that routes otherwise than the starting table does, so the line says which one routed.
  const moved = { ...fit, table: { ...fit.table, burn_in: false, rows: { cost: { "*": "task-high" }, speed: { "*": "task-high" } } } };
  writeFileSync(join(f.repo, FIT), JSON.stringify(moved));
  assert.equal(routeIn(f), "POLICY=task-high CELL=task-high DRAW=- BY=- STRATUM=* BRIEF=21 CRITERIA=1 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=- UNRUNNABLE=smol-max REASON=ok\n");
});

test("a first run with no records computes a Fit that routes as the starting table does", () => {
  const f = fixture();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /metrics-refresh: fit: fitted 0 Pulls/);
  assert.equal(routeIn(f), routeIn(f, SHIPPED));
});

test("no guard written, no Fit: a skipped guard skips it with a line, and a failed guard stops the run before it", () => {
  const f = fixture();
  rmSync(join(f.repo, "docs"), { recursive: true });
  const bare = f.run();
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /metrics-refresh: fit: skipped, no guard written — \.fleet\/router-fit\.json left as it is/);
  assert.equal(existsSync(join(f.repo, FIT)), false);
  assert.match(routeIn(f), /^POLICY=slow-high CELL=slow-high DRAW=- .* REASON=guard-missing\n$/, "no guard: the default Cell only");

  const broken = fixture();
  writeFileSync(join(broken.repo, "docs", "metrics", "tier-outcomes.tsv"), "short\trow\n");
  const b = broken.run();
  assert.equal(b.status, 1);
  assert.doesNotMatch(b.stdout, /fit:/);
  assert.equal(existsSync(join(broken.repo, FIT)), false);
});

test("--no-fit runs the duties and computes no Fit, leaving the one on disk as it is", () => {
  const f = fixture();
  write(f.repo, FIT, "old fit\n");
  const r = f.run({ args: ["--repo", f.repo, "--no-fit"] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cost guard: verdict none/, "the guard ran");
  assert.doesNotMatch(r.stdout, /fit:/);
  assert.equal(readFileSync(join(f.repo, FIT), "utf8"), "old fit\n");
});

test("a Fit that cannot be written keeps the previous file, exits as the other duties set it, and the run routes by that file", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const fit = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  const previous = `${JSON.stringify({ ...fit, table: { ...fit.table, burn_in: false, rows: { cost: { "*": "task-high" }, speed: { "*": "task-high" } } } })}\n`;
  write(f.repo, FIT, previous);
  mkdirSync(join(f.repo, `${FIT}.tmp`));
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /metrics-refresh: fit: failed — \S/);
  assert.match(refitFailure(r.stdout), /^EISDIR: /, "the cockpit's own parse reads the reason off this run's real stdout");
  assert.match(r.stdout, /cost guard: verdict none/, "the guard ran and stands");
  assert.equal(readFileSync(join(f.repo, FIT), "utf8"), previous);
  assert.match(routeIn(f), /^POLICY=task-high CELL=task-high .* REASON=ok\n$/, "the last Fit that computed routes");
});

test("a fit that cannot run throws before the rename, so the old file stays", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const before = readFileSync(join(f.repo, FIT), "utf8");
  const guard = JSON.parse(readFileSync(join(f.repo, GUARD), "utf8"));
  const bad = join(f.root, "router-table.json");
  writeFileSync(bad, JSON.stringify({ ...SHIPPED, burn_in: "no" }));
  assert.throws(() => writeFit(f.repo, guard, { tablePath: bad }), /router table: `burn_in` is not a boolean/);
  assert.throws(() => writeFit(f.repo, { ...guard, cells: "none" }), /is not a guard the router reads/);
  rmSync(join(f.repo, "docs", "metrics", "ticket-features.tsv"));
  assert.throws(() => writeFit(f.repo, guard), /ENOENT/);
  assert.equal(readFileSync(join(f.repo, FIT), "utf8"), before);
});

test("the Fit records the prior's window_start, the install's version only as a string, and the blob ids in key order", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const guard = JSON.parse(readFileSync(join(f.repo, GUARD), "utf8"));
  const table = join(f.root, "router-table.json");
  writeFileSync(table, JSON.stringify({ ...SHIPPED, window_start: "2026-09-01" }));
  const pkg = join(f.root, "package.json");
  writeFileSync(pkg, JSON.stringify({ version: 7 }));
  const p = writeFit(f.repo, guard, { tablePath: table, packagePath: pkg });
  assert.equal(p.prior.window_start, "2026-09-01");
  assert.equal(p.prior.version, null, "a version that is not a string is none");
  assert.deepEqual(Object.keys(p.tsv_blobs), ["docs/metrics/member-outcomes.tsv", "docs/metrics/ticket-features.tsv", "docs/metrics/tier-outcomes.tsv"], "sorted, not in the order the fit read them");
});

test("the recorded blob ids, guard and prior recompute the same Fit once the rows are on a commit", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  ruled(rows, { ticket: 2, cell: "task-high" });
  ruled(rows, { ticket: 3, cell: "smol-high", fail: true });
  // A smol model that runs no level: the Fit counts two starting Cells, and records which.
  const f = fixture({ rows, catalog: installCatalog({ smol: null }) });
  assert.equal(f.run().status, 0);
  const fit = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  assert.deepEqual(fit.table.starting_cells, ["slow-high", "task-high"]);
  const at = (path, parse) => {
    assert.equal(fit.tsv_blobs[path], git(f.repo, ["rev-parse", `HEAD:${path}`]), `${path}: the blob the Fit read is the one on the commit`);
    return parse(execFileSync("git", ["-C", f.repo, "cat-file", "blob", fit.tsv_blobs[path]], { env: ENV, encoding: "utf8" }));
  };
  const again = fitTree({
    prior: fit.prior, guard: fit.guard, commit: null, previous: null, startingCells: fit.table.starting_cells,
    members: at("docs/metrics/member-outcomes.tsv", parseMemberTsv),
    verdicts: at("docs/metrics/tier-outcomes.tsv", parseTierOutcomes),
    features: at(FEATURES, parseFeatures),
  });
  assert.equal(fit.table.n_rows, 3);
  assert.deepEqual(again, { table: fit.table, gate: fit.gate });
});

// Pulls of each Cell named at MIN_N merged PRs: each Pull's PR is merged on GitHub.
function mergedAt(cells) {
  const rows = corpus();
  const prs = [];
  let first = 1000;
  for (const cell of cells) {
    for (let i = 0; i < MIN_N; i++) {
      ruled(rows, { ticket: first + i, cell });
      prs.push({ number: first + 5000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z` });
    }
    first += 1000;
  }
  return { rows, prs };
}

test("a Fit counts only the starting Cells the install runs: smol-high at nothing, on a smol model that runs no level, is out of burn-in", () => {
  const { rows, prs } = mergedAt(["slow-high", "task-high"]);
  const f = fixture({ rows, prs, catalog: installCatalog({ smol: null }) });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "", "an install that reads warns nothing");
  const { table } = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  assert.deepEqual([table.burn_in, table.starting_cells], [false, ["slow-high", "task-high"]]);
  // The same records under an install that runs smol-high leave it in burn-in: it has none.
  const all = fixture({ rows, prs });
  assert.equal(all.run().status, 0);
  const full = JSON.parse(readFileSync(join(all.repo, FIT), "utf8")).table;
  assert.deepEqual([full.burn_in, full.starting_cells], [true, ["slow-high", "task-high", "smol-high"]]);
});

test("a Fit whose install cannot be read warns and counts all three starting Cells", () => {
  const { rows, prs } = mergedAt(["slow-high", "task-high"]);
  const f = fixture({ rows, prs, catalog: installCatalog({ smol: null }) });
  const r = f.run({ args: ["--repo", f.repo, "--catalog", join(f.root, "no-such-catalog.json")] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /metrics-refresh: WARNING cannot read what this install runs: .*no-such-catalog\.json.* — burn-in counts all three starting Cells/);
  const { table } = JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
  assert.deepEqual([table.burn_in, table.starting_cells], [true, ["slow-high", "task-high", "smol-high"]]);
});

test("--no-fit reads no install: a run that names files that are not there warns of nothing", () => {
  const f = fixture();
  const gone = ["--model-roles", join(f.root, "none.json"), "--catalog", join(f.root, "none.json")];
  const noFit = f.run({ args: ["--repo", f.repo, "--no-fit", ...gone] });
  assert.equal(noFit.status, 0, noFit.stderr);
  assert.equal(noFit.stderr, "", "no Fit, no install read, no warning");
});

// A corpus whose `kind` splits the Cells' prices: task-high $1 on an enhancement and $14 on a bug, slow-high $10 on both. Pooled
// task-high is $7.50, so the root routes task-high, the bugs go back to slow-high, and the other kinds stay on task-high.
// `n` Pulls of each Cell on each side.
const KIND_FLIP = (n = 40) => pullsOf(flip({ input: "kind", sides: ["enhancement", "bug"], low: [10, 1], high: [10, 14], n }));
// The fixture's three metrics files rewritten to hold `rows`, as close-outs that added rows would leave them.
const recorded = (f, rows) => {
  write(f.repo, FEATURES, featuresTsv(rows.features));
  write(f.repo, "docs/metrics/member-outcomes.tsv", membersTsv(rows.members));
  write(f.repo, "docs/metrics/tier-outcomes.tsv", tiersTsv(rows.tiers));
};
const phase0 = (f) => {
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const fitFile = (f) => JSON.parse(readFileSync(join(f.repo, FIT), "utf8"));
// The tmp file the Fit is renamed from, made a directory so that writing it fails.
const blockFit = (f) => mkdirSync(join(f.repo, `${FIT}.tmp`), { recursive: true });
const unblockFit = (f) => rmSync(join(f.repo, `${FIT}.tmp`), { recursive: true });

test("a split that passes the gate at one phase 0 stands at the next over more records, read from the Fit file the next one replaces, and the group's row routes its tickets", () => {
  const f = fixture({ rows: KIND_FLIP() });
  phase0(f);
  const first = fitFile(f);
  assert.deepEqual([first.table.splits, first.gate.passed], [{}, ["kind"]], "a first pass is kept in the file and stands nowhere");
  assert.deepEqual(first.gate.best.cuts, [{ input: "kind", cut: "bug" }]);
  assert.deepEqual([first.gate.scored, first.gate.left_out], [160, 0]);
  // Phase 0 run again before any close-out: the same records, so no look, and the first pass does not stand on them.
  phase0(f);
  const again = fitFile(f);
  assert.deepEqual([again.gate.records, again.table.splits, again.gate.passed], [first.gate.records, {}, ["kind"]]);
  recorded(f, KIND_FLIP(41));
  phase0(f);
  const second = fitFile(f);
  assert.deepEqual(second.table.splits, { "*": { input: "kind", cut: "bug" } });
  assert.deepEqual(second.table.rows.cost, { "*": "task-high", "kind=bug": "slow-high", "kind!=bug": "task-high" });
  assert.deepEqual(second.gate.passed, ["kind"], "and its next pass is read in turn");
  assert.equal(validateTable(second.table) instanceof Error, false);
  phase0(f);
  assert.deepEqual([fitFile(f).table.splits, fitFile(f).gate.stands], [second.table.splits, ["kind"]], "phase 0 run again over the records it stood on keeps it");
  const where = (line) => /POLICY=(\S+) .* STRATUM=(\S+) /.exec(line).slice(1);
  assert.deepEqual(where(routeIn(f, null, ["bug"])), ["slow-high", "kind=bug"]);
  assert.deepEqual(where(routeIn(f, null, ["enhancement"])), ["task-high", "kind!=bug"]);
  // A ticket with no kind label lacks the input the split reads, so it follows the node's own row: the root's.
  assert.deepEqual(where(routeIn(f, null, [])), ["task-high", "*"]);
  assert.deepEqual(where(routeIn(f, null, ["needs-triage"])), ["task-high", "*"]);
});

test("a Fit that failed is no look at the gate: it neither advances the count nor resets it", () => {
  const f = fixture({ rows: KIND_FLIP() });
  // A failure before any pass is no pass: the first Fit that computes passes once and does not stand.
  blockFit(f);
  assert.match(phase0(f).stdout, /metrics-refresh: fit: failed — /);
  assert.equal(existsSync(join(f.repo, FIT)), false);
  unblockFit(f);
  phase0(f);
  const once = readFileSync(join(f.repo, FIT), "utf8");
  assert.deepEqual([fitFile(f).table.splits, fitFile(f).gate.passed], [{}, ["kind"]]);
  // A failure after a pass leaves its file as it was, and that pass is still the one the next Fit reads.
  blockFit(f);
  assert.match(phase0(f).stdout, /metrics-refresh: fit: failed — /);
  assert.equal(readFileSync(join(f.repo, FIT), "utf8"), once);
  unblockFit(f);
  // A close-out has added rows since, so the Fit after the failure searches other records than the pass before it.
  recorded(f, KIND_FLIP(41));
  phase0(f);
  assert.deepEqual(fitFile(f).table.splits, { "*": { input: "kind", cut: "bug" } }, "the pass before the failure and the pass after it are consecutive Fits that computed");
});

test("a previous Fit that will not parse, or holds no gate, is no previous pass; one that cannot be read fails the Fit", () => {
  const f = fixture({ rows: KIND_FLIP() });
  phase0(f);
  const { table } = fitFile(f);
  for (const old of ["not json", "[]", "null", JSON.stringify({ table }), JSON.stringify({ table, gate: { passed: "kind" } })]) {
    writeFileSync(join(f.repo, FIT), old);
    phase0(f);
    const fit = fitFile(f);
    assert.deepEqual([fit.table.splits, fit.gate.passed], [{}, ["kind"]], old);
  }
  // A directory where the file belongs is a read the Fit cannot make: it fails, naming why, and leaves it.
  rmSync(join(f.repo, FIT));
  mkdirSync(join(f.repo, FIT));
  assert.match(phase0(f).stdout, /metrics-refresh: fit: failed — EISDIR: illegal operation on a directory, read/, "the read of the file it replaces, not the write over it");
});

test("a grown tree that route would refuse is never written: the Fit fails, naming why, and the old file stays", () => {
  // Counts past what a double holds exactly: the cut the gate finds is 9e+25, which is no count a table can name.
  const huge = (digits) => `9${"0".repeat(digits)}`;
  const rows = (n) => pullsOf(flip({ sides: [huge(25), huge(30)], n }));
  const f = fixture({ rows: rows(40) });
  phase0(f);
  const once = readFileSync(join(f.repo, FIT), "utf8");
  assert.deepEqual(JSON.parse(once).gate.passed, ["criteria"]);
  recorded(f, rows(41));
  assert.match(phase0(f).stdout, /metrics-refresh: fit: failed — .*cuts criteria at 9e\+25/);
  assert.equal(readFileSync(join(f.repo, FIT), "utf8"), once);
});

test("usage: only the declared flag and no positional, else exit 2", () => {
  const f = fixture();
  for (const args of [["--bogus"], ["phase-0"], ["--repo"]]) {
    const r = f.run({ args });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
});
