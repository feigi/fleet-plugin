// The repo-local run-team hook, .omp/skills/run-team-local/hook.mjs, run as
// the CLI against a fixture workspace: a clone of a bare origin whose main
// carries the metrics corpus, the router table and the cell definitions, and
// a stub `gh` that answers from a fixture file and logs every call it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";
import { writeExecStub } from "./exec-stub.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv } from "./member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow } from "./tier-outcomes.mjs";
import { FEATURE_COLUMNS, WINDOW_START, MIN_N } from "./pr-cost.mjs";
import { FIT_EVERY_MERGED } from "./ticket-router.mjs";
import { STOP } from "./cell-readout.mjs";

const HOOK = fileURLToPath(new URL("../../.omp/skills/run-team-local/hook.mjs", import.meta.url));
const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const STAGE1 = ["slow-high", "task-high", "smol-high"];
const PENDING = join(".fleet", "ticket-features.pending.tsv");
const FEATURES = join("docs", "metrics", "ticket-features.tsv");
const GUARD = join(".fleet", "cost-guard.json");
const TABLE = join("plugin", "scripts", "router-table.json");

// Pinned identity, no developer config, no inherited repo pointers.
const ENV = {
  ...process.env,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_TEMPLATE_DIR: undefined,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd, args, env = {}) => execFileSync("git", ["-C", cwd, ...args], { env: { ...ENV, ...env }, encoding: "utf8" }).trim();

const MODEL_ROLES = { slow: "anthropic/claude-opus-5", task: "anthropic/claude-sonnet-5", smol: "anthropic/claude-haiku-4-5" };
const CATALOG = {
  models: [
    { selector: "anthropic/claude-opus-5", thinking: ["low", "medium", "high", "xhigh", "max"] },
    { selector: "anthropic/claude-sonnet-5", thinking: ["low", "medium", "high", "xhigh", "max"] },
    { selector: "anthropic/claude-haiku-4-5", thinking: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
};
const MODEL_OF = { slow: "claude-opus-5", task: "claude-sonnet-5", smol: "claude-haiku-4-5" };

const pull = (o) => ({
  run_date: DAY, session: SESSION, policy_cell: "slow-high", chosen_cell: "slow-high", exploration_draw: "",
  sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0",
  age_days: "0", paths: "0", test_paths: "0", xrefs: "0", kind: "enhancement", ...o,
});
const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp", subagentType: "",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, ...o,
});
const tier = (o) => ({
  run_date: DAY, class: "", tier: "", closed_own_ticket: "yes", minted_false_claim: "no", note: "n",
  sizing: "light", profile: "small", loc: "10", files: "1", ...o,
});
const corpus = () => ({ features: [], members: [], tiers: [] });
// One ruled Pull at `cell`: its features row, its admissible member row, its verdict.
function ruled(rows, { ticket, cell = "slow-high", fail = false, date = DAY }) {
  const [role, level] = cell.split("-");
  const agent = `impl-${ticket}`;
  rows.features.push(pull({ ticket: String(ticket), agent, chosen_cell: cell, run_date: date }));
  rows.members.push(member({ agent, ticket: String(ticket), run_date: date, effort: level, model: MODEL_OF[role], subagentType: `fleet-implementer-${cell}` }));
  rows.tiers.push(tier({ ticket: String(ticket), pr: String(ticket + 5000), run_date: date, minted_false_claim: fail ? "yes" : "no" }));
}

const featuresTsv = (rows, cols = FEATURE_COLUMNS) => [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n";
const membersTsv = (rows) => `# ${MEMBER_COLUMNS.join("\t")}\n${rows.length ? formatTsv(rows) : ""}`;
const tiersTsv = (rows) => `# ${TIER_COLUMNS.join("\t")}\n${rows.map((r) => `${formatRow(r)}\n`).join("")}`;
const routerTable = (over = {}) => ({
  window_start: null, fitted_through: "2026-10-01", n_rows: 0, stage: 1, cells: [...STAGE1], burn_in: true,
  rows: { "*": "slow-high" }, classifier: { b: null, tau: null }, estimates: {}, guard: { tripped: [], n: {} }, ...over,
});
const agentMd = (cell) => {
  const [role, level] = cell.split("-");
  return `---\nname: fleet-implementer-${cell}\ndescription: fixture\nmodel: "@${role}:${level}"\n---\n\nbody\n`;
};

// Answers `pr list` (pr-cost's merged-state read, or the open re-fit PR read),
// `issue list` (raw text instead of JSON when the fixture has `issuesRaw`),
// and the two writes, from GH_FIXTURE; logs each argv to GH_LOG.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
const json = args[args.indexOf("--json") + 1];
const out = (v) => process.stdout.write(JSON.stringify(v));
const cmd = args.slice(0, 2).join(" ");
if (cmd === "pr list") out(json === "number,headRefName" ? fx.openPrs : fx.prs);
else if (cmd === "issue list") { if (fx.issuesRaw !== undefined) process.stdout.write(fx.issuesRaw); else out(fx.issues); }
else if (cmd === "issue create") console.log("https://github.com/o/r/issues/901");
else if (cmd === "pr create") console.log("https://github.com/o/r/pull/902");
else { process.stderr.write("gh stub: unexpected " + args.join(" ")); process.exit(9); }
`;

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// `readded`: cell → the date its definition is deleted and added back on main.
function fixture({ rows = corpus(), table = routerTable(), cells = STAGE1, readded = {}, pending = null, guardBefore = null, gh = {} } = {}) {
  const root = tempDir("run-team-local-");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
  git(root, ["init", "--quiet", "-b", "main", seed]);
  const commit = (msg, at) => git(seed, ["commit", "--quiet", "-m", msg], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  write(seed, ".gitignore", ".fleet/\n");
  for (const cell of cells) write(seed, `plugin/agents/fleet-implementer-${cell}.agent.md`, agentMd(cell));
  git(seed, ["add", "-A"]);
  commit("cells", "2026-09-01T00:00:00Z");
  for (const [cell, at] of Object.entries(readded)) {
    git(seed, ["rm", "--quiet", `plugin/agents/fleet-implementer-${cell}.agent.md`]);
    commit(`withdraw ${cell}`, at);
    write(seed, `plugin/agents/fleet-implementer-${cell}.agent.md`, agentMd(cell));
    git(seed, ["add", "-A"]);
    commit(`reinstate ${cell}`, at);
  }
  write(seed, FEATURES, featuresTsv(rows.features));
  write(seed, "docs/metrics/member-outcomes.tsv", membersTsv(rows.members));
  write(seed, "docs/metrics/tier-outcomes.tsv", tiersTsv(rows.tiers));
  write(seed, TABLE, `${JSON.stringify(table, null, 2)}\n`);
  git(seed, ["add", "-A"]);
  commit("corpus", "2026-10-03T12:00:00Z");
  git(seed, ["push", "--quiet", origin, "main"]);
  const repo = join(root, "repo");
  git(root, ["clone", "--quiet", origin, repo]);
  if (pending !== null) write(repo, PENDING, pending);
  if (guardBefore !== null) write(repo, GUARD, JSON.stringify(guardBefore));
  mkdirSync(join(root, "bin"));
  writeExecStub(join(root, "bin", "gh"), GH_STUB);
  writeFileSync(join(root, "gh.json"), JSON.stringify({ prs: [], openPrs: [], issues: [], ...gh }));
  writeFileSync(join(root, "model-roles.json"), JSON.stringify(MODEL_ROLES));
  writeFileSync(join(root, "catalog.json"), JSON.stringify(CATALOG));
  const log = join(root, "gh.log");
  return {
    root, origin, repo,
    run(phase, extra = [], { cwd = repo, repoFlag = true } = {}) {
      const args = [HOOK, phase, ...(repoFlag ? ["--repo", repo] : []),
        "--model-roles", join(root, "model-roles.json"), "--catalog", join(root, "catalog.json"), ...extra];
      return spawnSync(process.execPath, args, {
        cwd, encoding: "utf8",
        env: { ...ENV, PATH: `${join(root, "bin")}:${process.env.PATH}`, GH_FIXTURE: join(root, "gh.json"), GH_LOG: log },
      });
    },
    ghCalls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}
const calls = (f, cmd) => f.ghCalls().filter((c) => c.slice(0, 2).join(" ") === cmd);
const worktrees = (repo) => git(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// ---------------------------------------------------------------------------
// phase-0

test("phase-0: drains the pending TSV into ticket-features.tsv, deduped on session + agent, and writes a fresh cost-guard.json", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  const fresh = [pull({ ticket: "2", agent: "impl-2" }), pull({ ticket: "3", agent: "impl-3", chosen_cell: "task-high", exploration_draw: "2/3" })];
  // Read by column name: a pending header in another order drains the same rows.
  const pending = featuresTsv([rows.features[0], fresh[0], ...fresh], [...FEATURE_COLUMNS].reverse());
  const f = fixture({ rows, pending, guardBefore: { computed_at: "2000-01-01T00:00:00.000Z", verdict: "ok", tripped: [], cells: [] } });
  const started = Date.now();
  const r = f.run("phase-0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), featuresTsv([rows.features[0], ...fresh]));
  assert.equal(existsSync(join(f.repo, PENDING)), false, "the drained pending file is gone");
  assert.match(r.stdout, /drain: 2 rows from \.fleet\/ticket-features\.pending\.tsv into docs\/metrics\/ticket-features\.tsv \(2 already there\)/);
  const guard = JSON.parse(readFileSync(join(f.repo, GUARD), "utf8"));
  assert.ok(Date.parse(guard.computed_at) >= started - 1000, `a fresh guard, not the stale one: ${guard.computed_at}`);
  assert.equal(guard.verdict, "none");
  assert.match(r.stdout, /cost guard: verdict none, pr-cost\.mjs exit 4/, "no verdict yet is a verdict, not a failure");
  assert.match(r.stdout, /drift notice: every cell's last admissible row ran its role's current target/);
  assert.deepEqual(f.ghCalls().map((c) => c.slice(0, 2).join(" ")), ["pr list"], "phase 0 writes nothing to GitHub");
});

test("phase-0: with no --repo it works on the main checkout of the cwd's repository; a second run finds nothing pending and changes nothing", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  const fresh = pull({ ticket: "2", agent: "impl-2" });
  const f = fixture({ rows, pending: featuresTsv([fresh]) });
  const wt = join(f.root, "wt");
  git(f.repo, ["worktree", "add", "--quiet", wt]);
  const r = f.run("phase-0", [], { cwd: wt, repoFlag: false });
  assert.equal(r.status, 0, r.stderr);
  const drained = readFileSync(join(f.repo, FEATURES), "utf8");
  assert.equal(drained, featuresTsv([rows.features[0], fresh]));
  assert.equal(existsSync(join(f.repo, GUARD)), true);
  assert.equal(existsSync(join(wt, ".fleet")), false, "nothing is written under the linked worktree");

  const again = f.run("phase-0", [], { cwd: wt, repoFlag: false });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /drain: nothing pending in \.fleet\/ticket-features\.pending\.tsv/);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), drained);
});

test("phase-0: a tripped guard is a verdict and the hook goes on; a guard that cannot be computed fails the hook there", () => {
  const rows = corpus();
  const prs = [];
  for (let i = 0; i < MIN_N; i++) {
    ruled(rows, { ticket: 1000 + i, cell: "slow-high", fail: i < 6 });
    ruled(rows, { ticket: 2000 + i, cell: "task-high", fail: i < 9 });
    prs.push({ number: 6000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z` }, { number: 7000 + i, state: "MERGED", mergedAt: `${DAY}T12:00:00Z` });
  }
  const tripped = fixture({ rows, gh: { prs } });
  const t = tripped.run("phase-0");
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /cost guard: verdict tripped \(tripped: task-high\), pr-cost\.mjs exit 3/);
  assert.match(t.stdout, /drift notice:/, "the duty after the guard ran");

  const broken = fixture({ rows: corpus() });
  writeFileSync(join(broken.repo, "docs", "metrics", "member-outcomes.tsv"), "short\trow\n");
  const b = broken.run("phase-0");
  assert.equal(b.status, 1);
  assert.match(b.stderr, /run-team-local: cost guard failed: pr-cost\.mjs --guard exited 2/);
  assert.doesNotMatch(b.stdout, /drift notice/, "the duties after a failed one do not run");
});

test("phase-0: the drift notice names a cell whose last admissible row ran another model than its role now resolves, and a cell whose level that target does not run", () => {
  const rows = corpus();
  rows.members.push(
    member({ agent: "impl-1", run_date: "2026-10-01", session: "s1", model: "claude-sonnet-5", effort: "high", subagentType: "fleet-implementer-task-high" }),
    member({ agent: "impl-2", run_date: "2026-10-02", session: "s2", model: "claude-sonnet-4-5", effort: "high", subagentType: "fleet-implementer-task-high" }),
    // Newer, but clamped to another effort: never admissible, so never the last admissible row.
    member({ agent: "impl-3", run_date: "2026-10-05", session: "s3", model: "claude-sonnet-5", effort: "medium", subagentType: "fleet-implementer-task-high" }),
    // The role's target spelled with its provider prefix is the same model.
    member({ agent: "impl-4", run_date: "2026-10-02", session: "s4", model: "claude-opus-5", effort: "high", subagentType: "fleet-implementer-slow-high" }),
    member({ agent: "impl-5", run_date: "2026-10-01", session: "s5", model: "claude-haiku-4-5", effort: "high", subagentType: "fleet-implementer-smol-high" }),
    member({ agent: "impl-6", run_date: "2026-10-09", session: "s6", model: "claude-haiku-3", effort: "high", subagentType: "task" }),
  );
  const f = fixture({ rows, cells: [...STAGE1, "smol-max"] });
  const r = f.run("phase-0");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("tier-roles: notice: ")), [
    "tier-roles: notice: fleet-implementer-smol-max runs at max; modelRoles.smol now resolves anthropic/claude-haiku-4-5, which does not run at max (thinking: minimal, low, medium, high, xhigh)",
    "tier-roles: notice: fleet-implementer-task-high last ran claude-sonnet-4-5; modelRoles.task now resolves anthropic/claude-sonnet-5 — cell history spans two models",
  ]);
});

test("phase-0: a role with no target in modelRoles raises no notice for its cells, and the cells whose role resolves are still checked", () => {
  const rows = corpus();
  rows.members.push(
    member({ agent: "impl-1", run_date: "2026-10-01", session: "s1", model: "claude-haiku-3", effort: "high", subagentType: "fleet-implementer-smol-high" }),
    member({ agent: "impl-2", run_date: "2026-10-01", session: "s2", model: "claude-sonnet-4-5", effort: "high", subagentType: "fleet-implementer-task-high" }),
  );
  const f = fixture({ rows });
  const { smol, ...withoutSmol } = MODEL_ROLES;
  writeFileSync(join(f.root, "model-roles.json"), JSON.stringify(withoutSmol));
  const r = f.run("phase-0");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("tier-roles: notice: ")), [
    "tier-roles: notice: fleet-implementer-task-high last ran claude-sonnet-4-5; modelRoles.task now resolves anthropic/claude-sonnet-5 — cell history spans two models",
  ]);
});

test("phase-0: of the rows dated the same day the drift notice follows the higher session, in whichever order the rows come", () => {
  const rows = corpus();
  const sameDay = (agent, session, model, cell) => member({ agent, run_date: "2026-10-02", session, model, effort: "high", subagentType: `fleet-implementer-${cell}` });
  rows.members.push(
    // The lower session ran another model and comes first.
    sameDay("impl-1", "s1", "claude-haiku-3", "smol-high"),
    sameDay("impl-2", "s2", "claude-haiku-4-5", "smol-high"),
    // The higher session comes first.
    sameDay("impl-3", "s4", "claude-sonnet-5", "task-high"),
    sameDay("impl-4", "s3", "claude-sonnet-4-5", "task-high"),
  );
  const r = fixture({ rows }).run("phase-0");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /tier-roles: notice:/);
  assert.match(r.stdout, /drift notice: every cell's last admissible row ran its role's current target/);
});

// ---------------------------------------------------------------------------
// close-out: the stopping rule

// smol-high at ten verdicts, eight failing the floor; task-high at three, all failing.
function floorFailing() {
  const rows = corpus();
  for (let i = 0; i < STOP.verdicts; i++) ruled(rows, { ticket: 100 + i, cell: "smol-high", fail: i < 8 });
  for (let i = 0; i < 3; i++) ruled(rows, { ticket: 200 + i, cell: "task-high", fail: true });
  return rows;
}
const TITLE = "Withdraw exploration cell smol-high: 8/10 floor failures";

test("close-out --dry-run: a cell at ten verdicts and eight floor failures would file its withdrawal issue; a cell under the rule continues", () => {
  const f = fixture({ rows: floorFailing() });
  const r = f.run("close-out", ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — would file "${escape(TITLE)}" \\(ready-for-human\\)`));
  assert.match(r.stdout, /stopping rule: task-high 3\/3 floor failures since 2026-09-01 — continues/);
  const lists = calls(f, "issue list");
  assert.equal(lists.length, 1, "only the stopping cell is looked up");
  assert.deepEqual(lists[0].slice(2, 6), ["--state", "open", "--search", `"${TITLE}" in:title`]);
  assert.deepEqual(calls(f, "issue create"), [], "a dry run files nothing");
});

test("close-out: an open issue with the same title dedupes the withdrawal; an open one with other counts does not, and the issue is filed", () => {
  const decoy = { number: 78, title: "Withdraw exploration cell smol-high: 7/9 floor failures" };
  const open = { number: 77, title: TITLE };
  const dup = fixture({ rows: floorFailing(), gh: { issues: [decoy, open] } });
  const d = dup.run("close-out");
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — withdrawal issue already open, #${open.number}$`, "m"));
  assert.deepEqual(calls(dup, "issue create"), []);

  const fresh = fixture({ rows: floorFailing(), gh: { issues: [decoy] } });
  const r = fresh.run("close-out");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopping rule: smol-high 8\/10 floor failures since 2026-09-01 — filed https:\/\/github\.com\/o\/r\/issues\/901/);
  const [create] = calls(fresh, "issue create");
  const flag = (name) => create[create.indexOf(name) + 1];
  assert.equal(flag("--title"), TITLE);
  assert.equal(flag("--label"), "ready-for-human");
  // One verdict-table row per ticket: ticket and PR as references, the ruling's date and both floor fields.
  const row = (ticket, minted, floor) => `| #${ticket} | #${ticket + 5000} | 2026-10-03 | yes | ${minted} | ${floor} |`;
  const body = flag("--body").split("\n");
  assert.ok(body.includes(row(100, "yes", "fail")), flag("--body"));
  assert.ok(body.includes(row(109, "no", "pass")), flag("--body"));
  const tickets = body.filter((l) => l.startsWith("| #")).map((l) => Number(l.match(/^\| #(\d+) /)[1]));
  assert.deepEqual(tickets, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109], "rows run in ascending ticket order");
});

test("close-out: the count restarts on the day a cell's definition was most recently added", () => {
  const f = fixture({ rows: floorFailing(), readded: { "smol-high": "2026-10-04T00:00:00Z" } });
  const r = f.run("close-out", ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopping rule: smol-high 0\/0 floor failures since 2026-10-04 — continues/);
  assert.deepEqual(calls(f, "issue list"), []);
});

test("close-out: a definition no commit adds fails the stopping rule naming it, after the cells that can be judged are reported, and the re-fit does not run", () => {
  const f = fixture({ rows: floorFailing() });
  // On disk beside the committed definitions, never committed.
  writeFileSync(join(f.repo, "plugin", "agents", "fleet-implementer-smol-max.agent.md"), agentMd("smol-max"));
  const r = f.run("close-out", ["--dry-run"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — would file "${escape(TITLE)}"`));
  assert.match(r.stderr, /run-team-local: stopping rule failed: not judged — no commit adds fleet-implementer-smol-max\.agent\.md$/m);
  assert.doesNotMatch(r.stdout, /router fit/);
});

test("close-out: a gh that prints something other than JSON fails the duty naming the gh command and what it printed", () => {
  const f = fixture({ rows: floorFailing(), gh: { issuesRaw: "<html>rate limited</html>" } });
  const r = f.run("close-out", ["--dry-run"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /stopping rule failed: gh issue list printed non-JSON \(.*\): "<html>rate limited<\/html>"$/m);
});

// ---------------------------------------------------------------------------
// close-out: the router re-fit cadence

// FIT_EVERY_MERGED Pulls on main dated after the table's fitted_through, `n` of them ruled.
function merged(n) {
  const rows = corpus();
  for (let i = 1; i <= FIT_EVERY_MERGED; i++) {
    rows.features.push(pull({ ticket: String(i), agent: `impl-${i}`, run_date: "2026-10-05" }));
    if (i <= n) rows.tiers.push(tier({ ticket: String(i), pr: String(500 + i), run_date: "2026-10-05" }));
  }
  return rows;
}

test("close-out --dry-run: fifty merged PRs since fitted_through run ticket-router.mjs fit in a throwaway checkout; forty-nine do not", () => {
  const below = fixture({ rows: merged(FIT_EVERY_MERGED - 1) });
  const b = below.run("close-out", ["--dry-run"]);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /router fit: DUE=no MERGED=49\/50 — not due/);
  assert.doesNotMatch(b.stdout, /ticket-router: fitted/);

  const at = fixture({ rows: merged(FIT_EVERY_MERGED) });
  const before = readFileSync(join(at.repo, TABLE), "utf8");
  const a = at.run("close-out", ["--dry-run"]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^run-team-local: router fit: DUE=yes MERGED=50\/50 — ticket-router: fitted \d+ tickets through 2026-10-05; .*; would open a chore PR from chore\/router-fit-\d{4}-\d{2}-\d{2}$/m);
  assert.equal(readFileSync(join(at.repo, TABLE), "utf8"), before, "the checkout's own table is untouched");
  assert.equal(worktrees(at.repo), 1, "the throwaway checkout is gone");
  assert.equal(git(at.origin, ["branch", "--list", "chore/*"]), "", "a dry run pushes nothing");
  assert.deepEqual(calls(at, "pr create"), []);
});

test("close-out: a relative --repo reaches the re-fit as the absolute one does", () => {
  const f = fixture({ rows: merged(FIT_EVERY_MERGED) });
  const r = f.run("close-out", ["--repo", ".", "--dry-run"], { cwd: f.repo, repoFlag: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /router fit: DUE=yes MERGED=50\/50 — .*; would open a chore PR from chore\/router-fit-/);
});

test("close-out: a due re-fit is pushed to its own chore branch and opened as a PR labelled patch, never onto main — and not while an earlier re-fit PR is open", () => {
  const f = fixture({ rows: merged(FIT_EVERY_MERGED) });
  const r = f.run("close-out");
  assert.equal(r.status, 0, r.stderr);
  const branch = /opened https:\/\/github\.com\/o\/r\/pull\/902 from (chore\/router-fit-\S+)$/m.exec(r.stdout)?.[1];
  assert.ok(branch, r.stdout);
  assert.equal(JSON.parse(git(f.origin, ["show", `${branch}:${TABLE}`])).fitted_through, "2026-10-05");
  assert.equal(JSON.parse(git(f.origin, ["show", `main:${TABLE}`])).fitted_through, "2026-10-01", "main itself is untouched");
  const [create] = calls(f, "pr create");
  assert.equal(create[create.indexOf("--base") + 1], "main");
  assert.equal(create[create.indexOf("--head") + 1], branch);
  assert.equal(create[create.indexOf("--label") + 1], "patch", "labelled by the create itself, not by an edit that can fail after it");
  assert.deepEqual(calls(f, "pr edit"), []);
  assert.equal(git(f.repo, ["branch", "--list", "chore/*"]), "", "the checkout's repository keeps no local branch of the PR's");
  assert.doesNotMatch(git(f.repo, ["config", "--local", "--list"]), /^branch\.chore/m, "and no upstream config for it");
  assert.equal(worktrees(f.repo), 1);

  const earlier = { number: 55, headRefName: "chore/router-fit-2026-10-01" };
  const held = fixture({ rows: merged(FIT_EVERY_MERGED), gh: { openPrs: [earlier] } });
  const h = held.run("close-out");
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, new RegExp(`router fit: DUE=yes MERGED=50/50 — re-fit PR #${earlier.number} \\(${escape(earlier.headRefName)}\\) is still open$`, "m"));
  assert.deepEqual(calls(held, "pr create"), []);
  assert.equal(git(held.origin, ["branch", "--list", "chore/*"]), "");
});

// ---------------------------------------------------------------------------
// usage

test("usage: exactly one phase, and only the declared flags, else exit 2", () => {
  const f = fixture();
  for (const extra of [[], ["phase-0", "close-out"], ["phase-0", "--bogus"]]) {
    const r = spawnSync(process.execPath, [HOOK, ...extra, "--repo", f.repo], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stderr}`);
  }
  // A flag's value that spells a phase is not the phase.
  const value = spawnSync(process.execPath, [HOOK, "--repo", "phase-0", "--dry-run"], { encoding: "utf8", env: ENV, cwd: f.repo });
  assert.equal(value.status, 2, value.stderr);
  assert.match(value.stderr, /usage: hook\.mjs phase-0\|close-out/);
});
