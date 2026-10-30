// The repo-local hook, .omp/skills/run-team-local/hook.mjs, run as the CLI
// against a fixture workspace: a clone of a bare origin whose main carries the
// metrics corpus, the router table and the cell definitions, and a stub `gh`
// that answers from a fixture file and logs every call it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { SEARCH_STUB_SRC } from "./support/gh-pr-search.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow } from "../plugin/scripts/tier-outcomes.mjs";
import { WINDOW_START } from "../plugin/scripts/pr-cost.mjs";
import { FEATURE_COLUMNS } from "../plugin/scripts/pull-attribution.mjs";
import { FIT_EVERY_MERGED } from "../plugin/scripts/ticket-router.mjs";
import { STOP } from "../plugin/scripts/cell-readout.mjs";

const HOOK = fileURLToPath(new URL("../.omp/skills/run-team-local/hook.mjs", import.meta.url));
const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const STAGE1 = ["slow-high", "task-high", "smol-high"];
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
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, dispatchModel: o.model ?? "claude-opus-5", workS: 60, ...o,
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
  rows.members.push(member({
    agent, ticket: String(ticket), pr: String(ticket + 5000), run_date: date, effort: level, model: MODEL_OF[role], subagentType: `fleet-implementer-${cell}`,
  }));
  rows.tiers.push(tier({ ticket: String(ticket), pr: String(ticket + 5000), run_date: date, minted_false_claim: fail ? "yes" : "no" }));
}

const featuresTsv = (rows) => [FEATURE_COLUMNS.join("\t"), ...rows.map((r) => FEATURE_COLUMNS.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n";
const membersTsv = (rows) => `# ${MEMBER_COLUMNS.join("\t")}\n${rows.length ? formatTsv(rows) : ""}`;
const tiersTsv = (rows) => `# ${TIER_COLUMNS.join("\t")}\n${rows.map((r) => `${formatRow(r)}\n`).join("")}`;
const unjudged = { cell: "slow-high", reason: "unjudged", cells: {}, pairs: [] };
const routerTable = (over = {}) => ({
  window_start: null, fitted_commit: null, n_rows: 0, stage: 1, cells: [...STAGE1], burn_in: true,
  rows: { cost: { "*": "slow-high" }, speed: { "*": "slow-high" } }, classifier: { b: null, tau: null }, estimates: {},
  reasons: { cost: { "*": unjudged }, speed: { "*": unjudged } }, guard: { tripped: [], n: {} }, ...over,
});
const agentMd = (cell) => {
  const [role, level] = cell.split("-");
  return `---\nname: fleet-implementer-${cell}\ndescription: fixture\nmodel: "@${role}:${level}"\n---\n\nbody\n`;
};

// Answers `pr list` (pr-cost's merged-state read, which takes `fx.prs` through
// the search's `created:` window and 1,000-row cap as GitHub does, or the
// hook's open-PR read: `openPrs` plus every `prs` entry whose state is OPEN),
// `issue list` (raw text instead of JSON when the fixture has `issuesRaw`), and
// the writes, from GH_FIXTURE; `pr create` fails when it has `createFails`.
// Logs each argv to GH_LOG.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
${SEARCH_STUB_SRC}
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
const json = args[args.indexOf("--json") + 1];
const out = (v) => process.stdout.write(JSON.stringify(v));
const cmd = args.slice(0, 2).join(" ");
if (cmd === "pr list" && fx.listFails) { process.stderr.write("gh stub: list refused"); process.exit(1); }
if (cmd === "pr list") out(json === "number,headRefName"
  ? [...fx.openPrs, ...fx.prs.filter((p) => p.state === "OPEN").map((p) => ({ number: p.number, headRefName: "implementer/" + p.number }))]
  : searchPrs(fx.prs, args, FIRST_DAY));
else if (cmd === "issue list") { if (fx.issuesRaw !== undefined) process.stdout.write(fx.issuesRaw); else out(fx.issues); }
else if (cmd === "issue create") console.log("https://github.com/o/r/issues/901");
else if (cmd === "issue edit") console.log("https://github.com/o/r/issues/" + args[2]);
else if (cmd === "issue comment") console.log("https://github.com/o/r/issues/" + args[2] + "#issuecomment-1");
else if (cmd === "pr create") { if (fx.createFails) { process.stderr.write("gh stub: create refused"); process.exit(1); } console.log("https://github.com/o/r/pull/902"); }
else { process.stderr.write("gh stub: unexpected " + args.join(" ")); process.exit(9); }
`;

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// `readded`: cell → the date its definition is deleted and added back on main. `fitted`: the rows an
// earlier commit of main holds, the commit the table records as `fitted_commit`.
function fixture({ rows = corpus(), table = routerTable(), cells = STAGE1, readded = {}, fitted = null, gh = {} } = {}) {
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
  if (fitted !== null) {
    write(seed, FEATURES, featuresTsv(fitted.features));
    write(seed, "docs/metrics/member-outcomes.tsv", membersTsv(fitted.members));
    write(seed, "docs/metrics/tier-outcomes.tsv", tiersTsv(fitted.tiers));
    git(seed, ["add", "-A"]);
    commit("fitted corpus", "2026-10-02T12:00:00Z");
    table = { ...table, fitted_commit: git(seed, ["rev-parse", "HEAD"]) };
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
  // No `.fleet/cost-guard.json`: the re-fit reads pr-cost's own guard over origin/main's TSVs.
  mkdirSync(join(root, "bin"));
  writeExecStub(join(root, "bin", "gh"), GH_STUB);
  // An `omp` that fails at once, so no spawn with this `bin` first reads the
  // host's omp config: a run without `--model-roles`/`--catalog` skips the drift notice.
  writeExecStub(join(root, "bin", "omp"), "#!/bin/sh\nexit 1\n");
  // Every PR a Ruling names is merged, and `gh.prs` adds to or overrides these;
  // `gh.unlisted` names the ones `gh pr list` leaves out.
  const rulingPrs = rows.tiers.map((t) => ({ number: Number(t.pr), state: "MERGED", mergedAt: `${DAY}T12:00:00Z` }))
    .filter((p) => !(gh.unlisted ?? []).includes(p.number));
  writeFileSync(join(root, "gh.json"), JSON.stringify({ openPrs: [], issues: [], ...gh, prs: [...rulingPrs, ...(gh.prs ?? [])] }));
  writeFileSync(join(root, "model-roles.json"), JSON.stringify(MODEL_ROLES));
  writeFileSync(join(root, "catalog.json"), JSON.stringify(CATALOG));
  const log = join(root, "gh.log");
  return {
    root, origin, repo,
    run(extra = [], { cwd = repo, repoFlag = true } = {}) {
      const args = [HOOK, ...(repoFlag ? ["--repo", repo] : []),
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
// the role-target drift notice

test("drift notice: names a cell whose last admissible row ran another model than its role now resolves, and a cell whose level that target does not run", () => {
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
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("tier-roles: notice: ")), [
    "tier-roles: notice: fleet-implementer-smol-max runs at max; modelRoles.smol now resolves anthropic/claude-haiku-4-5, which does not run at max (thinking: minimal, low, medium, high, xhigh)",
    "tier-roles: notice: fleet-implementer-task-high last ran claude-sonnet-4-5; modelRoles.task now resolves anthropic/claude-sonnet-5 — cell history spans two models",
  ]);
});

test("drift notice: a role with no target in modelRoles raises no notice for its cells, and the cells whose role resolves are still checked", () => {
  const rows = corpus();
  rows.members.push(
    member({ agent: "impl-1", run_date: "2026-10-01", session: "s1", model: "claude-haiku-3", effort: "high", subagentType: "fleet-implementer-smol-high" }),
    member({ agent: "impl-2", run_date: "2026-10-01", session: "s2", model: "claude-sonnet-4-5", effort: "high", subagentType: "fleet-implementer-task-high" }),
  );
  const f = fixture({ rows });
  const { smol, ...withoutSmol } = MODEL_ROLES;
  writeFileSync(join(f.root, "model-roles.json"), JSON.stringify(withoutSmol));
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("tier-roles: notice: ")), [
    "tier-roles: notice: fleet-implementer-task-high last ran claude-sonnet-4-5; modelRoles.task now resolves anthropic/claude-sonnet-5 — cell history spans two models",
  ]);
});

test("drift notice: of the rows dated the same day it follows the higher session, in whichever order the rows come", () => {
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
  const r = fixture({ rows }).run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /tier-roles: notice:/);
  assert.match(r.stdout, /drift notice: every cell's last admissible row ran its role's current target/);
});

// ---------------------------------------------------------------------------
// the per-cell stopping rule

// smol-high at ten verdicts, eight failing the floor; task-high at three, all failing.
function floorFailing() {
  const rows = corpus();
  for (let i = 0; i < STOP.verdicts; i++) ruled(rows, { ticket: 100 + i, cell: "smol-high", fail: i < 8 });
  for (let i = 0; i < 3; i++) ruled(rows, { ticket: 200 + i, cell: "task-high", fail: true });
  return rows;
}
const TITLE = "Withdraw exploration cell smol-high: 8/10 floor failures on claude-haiku-4-5";
const STALE = { number: 78, title: "Withdraw exploration cell smol-high: 7/9 floor failures" };
const writes = (f) => ["issue create", "issue edit", "issue comment"].flatMap((cmd) => calls(f, cmd));

test("stopping rule --dry-run: a cell at ten verdicts and eight floor failures would file its withdrawal issue; a cell under the rule continues", () => {
  const f = fixture({ rows: floorFailing() });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — would file "${escape(TITLE)}" \\(ready-for-human\\)`));
  assert.match(r.stdout, /stopping rule: task-high 3\/3 floor failures since 2026-09-01 — continues/);
  const lists = calls(f, "issue list");
  assert.equal(lists.length, 1, "only the stopping cell is looked up");
  assert.deepEqual(lists[0].slice(2), ["--state", "open", "--search", `"Withdraw exploration cell smol-high:" in:title`, "--json", "number,title", "--limit", "100"]);
  assert.deepEqual(writes(f), [], "a dry run writes nothing");
});

test("stopping rule: an older generation's tally is printed and never files, and the cell's newest generation is judged alone", () => {
  const rows = floorFailing();
  for (const m of rows.members) if (m.subagentType === "fleet-implementer-smol-high") m.dispatchModel = "model-a";
  // One clean Pull after them on the cell's role model: its newest generation.
  ruled(rows, { ticket: 300, cell: "smol-high" });
  const f = fixture({ rows });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopping rule: smol-high older generation model-a 8\/10 floor failures since 2026-09-01 — not judged$/m);
  assert.match(r.stdout, /stopping rule: smol-high 0\/1 floor failures since 2026-09-01 — continues$/m);
  assert.deepEqual(calls(f, "issue list"), [], "no withdrawal issue is looked up for the cell");
});

test("stopping rule: an open withdrawal issue with the same title is left as it is, even beside one of the cell's older tallies", () => {
  const open = { number: 77, title: TITLE };
  const f = fixture({ rows: floorFailing(), gh: { issues: [STALE, open] } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — withdrawal issue already open, #${open.number}$`, "m"));
  assert.deepEqual(writes(f), []);
});

test("stopping rule: an open withdrawal issue at the same tally that names no generation, or another one, gets the newest generation's verdict table and title", () => {
  for (const prior of ["Withdraw exploration cell smol-high: 8/10 floor failures", "Withdraw exploration cell smol-high: 8/10 floor failures on model-a"]) {
    const f = fixture({ rows: floorFailing(), gh: { issues: [{ number: 77, title: prior }] } });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — withdrawal issue #77 retitled from "${escape(prior)}", verdict table commented$`, "m"));
    assert.deepEqual(calls(f, "issue create"), []);
    const [comment] = calls(f, "issue comment");
    assert.match(comment[4], /newest generation, `claude-haiku-4-5`/);
    assert.deepEqual(calls(f, "issue edit"), [["issue", "edit", "77", "--title", TITLE]]);
  }
});

test("stopping rule: the cell's open withdrawal issue at another tally gets the verdict table as a comment, then the new title; no second issue is filed", () => {
  const f = fixture({ rows: floorFailing(), gh: { issues: [STALE] } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — withdrawal issue #78 retitled from "${escape(STALE.title)}", verdict table commented$`, "m"));
  assert.deepEqual(calls(f, "issue create"), []);
  const [comment] = calls(f, "issue comment");
  assert.deepEqual(comment.slice(0, 4), ["issue", "comment", "78", "--body"]);
  assert.ok(comment[4].split("\n").includes("| #100 | #5100 | 2026-10-03 | yes | yes | fail |"), comment[4]);
  assert.deepEqual(calls(f, "issue edit"), [["issue", "edit", "78", "--title", TITLE]]);
  // The title is the idempotency key, so it is written after the comment.
  assert.deepEqual(f.ghCalls().map((c) => c.slice(0, 2).join(" ")).filter((c) => c === "issue comment" || c === "issue edit"), ["issue comment", "issue edit"]);
});

test("stopping rule: with several open withdrawal issues for the cell and none at the new tally, the lowest-numbered one is retitled and commented, however the list orders them, and the others are named", () => {
  const older = { number: 90, title: "Withdraw exploration cell smol-high: 6/8 floor failures" };
  const newer = { number: 95, title: STALE.title };
  const f = fixture({ rows: floorFailing(), gh: { issues: [newer, older] } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — withdrawal issue #90 retitled from "${escape(older.title)}", verdict table commented$`, "m"));
  assert.match(r.stdout, /stopping rule: smol-high 8\/10 floor failures since 2026-09-01 — more open withdrawal issues for the cell, left as they are: #95$/m);
  assert.deepEqual(calls(f, "issue create"), []);
  assert.deepEqual(calls(f, "issue comment").map((c) => c[2]), ["90"]);
  assert.deepEqual(calls(f, "issue edit"), [["issue", "edit", "90", "--title", TITLE]]);
});

test("stopping rule: the cell's open issue already at the new tally is the one kept, though an older issue at another tally is also open, and that one is named", () => {
  const older = { number: 70, title: "Withdraw exploration cell smol-high: 6/8 floor failures" };
  const exact = { number: 77, title: TITLE };
  const f = fixture({ rows: floorFailing(), gh: { issues: [exact, older] } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — withdrawal issue already open, #${exact.number}$`, "m"));
  assert.match(r.stdout, /stopping rule: smol-high 8\/10 floor failures since 2026-09-01 — more open withdrawal issues for the cell, left as they are: #70$/m);
  assert.deepEqual(writes(f), []);
});

test("stopping rule: a withdrawal issue whose title differs from the prefix only in case is still the cell's, and is retitled", () => {
  const lower = { number: 71, title: STALE.title.toLowerCase() };
  const f = fixture({ rows: floorFailing(), gh: { issues: [lower] } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(f, "issue create"), []);
  assert.deepEqual(calls(f, "issue edit"), [["issue", "edit", "71", "--title", TITLE]]);
});

test("stopping rule --dry-run: the cell's open withdrawal issue at another tally would be retitled and commented, and nothing is written", () => {
  const f = fixture({ rows: floorFailing(), gh: { issues: [STALE] } });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — would retitle withdrawal issue #78 from "${escape(STALE.title)}" to "${escape(TITLE)}" and comment the verdict table$`, "m"));
  assert.deepEqual(writes(f), []);
});

test("stopping rule: another cell's withdrawal issue, or a title that only contains the cell's prefix, does not dedupe, and the issue is filed", () => {
  const other = { number: 79, title: "Withdraw exploration cell task-high: 3/3 floor failures" };
  const quoted = { number: 80, title: "Re: Withdraw exploration cell smol-high: 7/9 floor failures" };
  const longer = { number: 81, title: "Withdraw exploration cell smol-high2: 7/9 floor failures" };
  const f = fixture({ rows: floorFailing(), gh: { issues: [other, quoted, longer] } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopping rule: smol-high 8\/10 floor failures since 2026-09-01 — filed https:\/\/github\.com\/o\/r\/issues\/901/);
  assert.deepEqual([...calls(f, "issue edit"), ...calls(f, "issue comment")], []);
  const [create] = calls(f, "issue create");
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

test("stopping rule: the count restarts on the day a cell's definition was most recently added", () => {
  const f = fixture({ rows: floorFailing(), readded: { "smol-high": "2026-10-04T00:00:00Z" } });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopping rule: smol-high 0\/0 floor failures since 2026-10-04 — continues/);
  assert.deepEqual(calls(f, "issue list"), []);
});

test("stopping rule: a definition no commit adds fails the duty naming it, after the cells that can be judged are reported, and the re-fit does not run", () => {
  const f = fixture({ rows: floorFailing() });
  // On disk beside the committed definitions, never committed.
  writeFileSync(join(f.repo, "plugin", "agents", "fleet-implementer-smol-max.agent.md"), agentMd("smol-max"));
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — would file "${escape(TITLE)}"`));
  assert.match(r.stderr, /run-team-local: stopping rule failed: not judged — no commit adds fleet-implementer-smol-max\.agent\.md$/m);
  assert.doesNotMatch(r.stdout, /router fit/);
});

test("stopping rule: a gh that prints something other than JSON fails the duty naming the gh command and what it printed", () => {
  const f = fixture({ rows: floorFailing(), gh: { issuesRaw: "<html>rate limited</html>" } });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /stopping rule failed: gh issue list printed non-JSON \(.*\): "<html>rate limited<\/html>"$/m);
});

test("stopping rule --dry-run: a both-blank tier-outcomes row after a ticket's real ruling leaves the count as it was, and the router fit still runs", () => {
  const rows = floorFailing();
  rows.tiers.push(tier({ ticket: "100", pr: "1392", closed_own_ticket: "", minted_false_claim: "" }));
  const f = fixture({ rows });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stopping rule: smol-high 8/10 floor failures since 2026-09-01 — would file "${escape(TITLE)}"`));
  assert.match(r.stdout, /^run-team-local: router fit: /m);
});

// ---------------------------------------------------------------------------
// the router re-fit cadence

// FIT_EVERY_MERGED Pulls on main that no fitted commit holds, each with an admissible implementer that opened its PR, `n` of them ruled.
function merged(n) {
  const rows = corpus();
  for (let i = 1; i <= FIT_EVERY_MERGED; i++) {
    rows.features.push(pull({ ticket: String(i), agent: `impl-${i}`, run_date: "2026-10-05" }));
    rows.members.push(member({ agent: `impl-${i}`, ticket: String(i), pr: String(500 + i), run_date: "2026-10-05", subagentType: "fleet-implementer-slow-high" }));
    if (i <= n) rows.tiers.push(tier({ ticket: String(i), pr: String(500 + i), run_date: "2026-10-05" }));
  }
  return rows;
}

test("router fit --dry-run: fifty merged PRs not in fitted_commit run ticket-router.mjs fit in a throwaway checkout; forty-nine do not", () => {
  const below = fixture({ rows: merged(FIT_EVERY_MERGED - 1) });
  const b = below.run(["--dry-run"]);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /router fit: DUE=no MERGED=49\/50 — not due/);
  assert.doesNotMatch(b.stdout, /ticket-router: fitted/);

  const at = fixture({ rows: merged(FIT_EVERY_MERGED) });
  const before = readFileSync(join(at.repo, TABLE), "utf8");
  const a = at.run(["--dry-run"]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^run-team-local: router fit: DUE=yes MERGED=50\/50 — ticket-router: fitted \d+ Pulls at [0-9a-f]{8}; .*; would open a chore PR from chore\/router-fit-\d{4}-\d{2}-\d{2}$/m);
  assert.match(a.stdout, /^run-team-local: router fit: ticket-router: row cost \* slow-high unjudged /m, "each row's line follows the fit's summary, one line each");
  assert.match(a.stdout, /^run-team-local: router fit: ticket-router: row speed \* slow-high unjudged /m, "the speed set's rows too");
  assert.equal(readFileSync(join(at.repo, TABLE), "utf8"), before, "the checkout's own table is untouched");
  assert.equal(worktrees(at.repo), 1, "the throwaway checkout is gone");
  assert.equal(git(at.origin, ["branch", "--list", "chore/*"]), "", "a dry run pushes nothing");
  assert.deepEqual(calls(at, "pr create"), []);
});

test("router fit --dry-run: rows the fitted commit holds are not counted, whatever their date or verdict", () => {
  const fitted = corpus();
  for (let i = 101; i <= 110; i++) ruled(fitted, { ticket: i, date: "2026-10-09" });
  const count = (n) => {
    const rows = merged(n);
    for (let i = 101; i <= 110; i++) ruled(rows, { ticket: i, date: "2026-10-09" });
    return fixture({ rows, fitted }).run(["--dry-run"]);
  };
  const below = count(FIT_EVERY_MERGED - 1);
  assert.equal(below.status, 0, below.stderr);
  assert.match(below.stdout, /router fit: DUE=no MERGED=49\/50 — not due/, "the ten fitted PRs are ruled and in the window, yet not counted");
  const at = count(FIT_EVERY_MERGED);
  assert.equal(at.status, 0, at.stderr);
  assert.match(at.stdout, /router fit: DUE=yes MERGED=50\/50 — /);
});

test("router fit: a relative --repo reaches the re-fit as the absolute one does", () => {
  const f = fixture({ rows: merged(FIT_EVERY_MERGED) });
  const r = f.run(["--repo", ".", "--dry-run"], { cwd: f.repo, repoFlag: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /router fit: DUE=yes MERGED=50\/50 — .*; would open a chore PR from chore\/router-fit-/);
});

// A Pull at `cell` whose implementer opened `pr`, with no Ruling for it: what `gh.prs` says of the PR is all the record holds.
// `session` and `dispatchModel` place it in the cell's newest generation or an older one.
function unruled(rows, { ticket, pr, cell = "slow-high", session = SESSION, dispatchModel = MODEL_OF[cell.split("-")[0]] }) {
  const [role, level] = cell.split("-");
  rows.features.push(pull({ ticket: String(ticket), agent: `impl-${ticket}`, chosen_cell: cell, run_date: "2026-10-05", session }));
  rows.members.push(member({
    agent: `impl-${ticket}`, ticket: String(ticket), pr: String(pr), run_date: "2026-10-05", session, model: MODEL_OF[role], effort: level,
    dispatchModel, subagentType: `fleet-implementer-${cell}`,
  }));
}
const prState = (number, state) => ({ number, state });
const REFUSAL = /^run-team-local: router fit: DUE=yes MERGED=50\/50 — record incomplete, no re-fit: (.*)$/m;
// Nothing fitted, pushed or opened: no re-fit branch on origin, no `pr create`, no `ticket-router: fitted` line.
function assertNoRefit(f, r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.origin, ["branch", "--list", "chore/*"]), "");
  assert.deepEqual(calls(f, "pr create"), []);
  assert.doesNotMatch(r.stdout, /ticket-router: fitted|would open|; opened /);
  assert.equal(worktrees(f.repo), 1, "the throwaway checkout is gone");
}

test("router fit: a newest-generation Pull whose PR merged with no Ruling stops the re-fit, naming the PR and how to rule it; --dry-run says the same and no `would open`", () => {
  const rows = merged(FIT_EVERY_MERGED);
  unruled(rows, { ticket: 900, pr: 1400 });
  for (const extra of [[], ["--dry-run"]]) {
    const f = fixture({ rows, gh: { prs: [prState(1400, "MERGED")] } });
    const r = f.run(extra);
    assertNoRefit(f, r);
    assert.match(r.stdout, /^run-team-local: router fit: DUE=yes MERGED=50\/50 — record incomplete, no re-fit: merged with no Ruling PR #1400 — run `tier-outcomes\.mjs append <pr>` for each$/m);
    assert.equal(existsSync(join(f.repo, GUARD)), false, "the checkout's own cost-guard.json is neither needed nor written");
  }
});

test("router fit: a newest-generation Pull whose PR is still open stops the re-fit, naming it under `still open`", () => {
  const rows = merged(FIT_EVERY_MERGED);
  unruled(rows, { ticket: 900, pr: 1400 });
  for (const extra of [[], ["--dry-run"]]) {
    const f = fixture({ rows, gh: { prs: [prState(1400, "OPEN")] } });
    const r = f.run(extra);
    assertNoRefit(f, r);
    assert.equal(REFUSAL.exec(r.stdout)?.[1], "still open PR #1400");
  }
  // A ruled PR that has not merged is as open as an unruled one.
  const ruledOpen = fixture({ rows: merged(FIT_EVERY_MERGED), gh: { prs: [prState(501, "OPEN")] } });
  const o = ruledOpen.run();
  assertNoRefit(ruledOpen, o);
  assert.equal(REFUSAL.exec(o.stdout)?.[1], "still open PR #501");
});

test("router fit: a ruled PR missing from pr-cost's list is named apart from the open ones, which merging or closing clears", () => {
  for (const extra of [[], ["--dry-run"]]) {
    const f = fixture({ rows: merged(FIT_EVERY_MERGED), gh: { unlisted: [501], prs: [prState(502, "OPEN")] } });
    const r = f.run(extra);
    assertNoRefit(f, r);
    assert.equal(REFUSAL.exec(r.stdout)?.[1], "still open PR #502; missing from pr-cost's list PR #501");
  }
});

test("router fit: both kinds are listed, each in ascending order of PR number, merged-with-no-Ruling first", () => {
  const rows = merged(FIT_EVERY_MERGED);
  for (const [ticket, pr] of [[901, 1500], [902, 999], [903, 1400], [904, 2000], [905, 1000]]) unruled(rows, { ticket, pr });
  const f = fixture({ rows, gh: { prs: [prState(1500, "MERGED"), prState(999, "MERGED"), prState(1400, "OPEN"), prState(2000, "OPEN"), prState(1000, "MERGED")] } });
  const r = f.run(["--dry-run"]);
  assertNoRefit(f, r);
  assert.equal(REFUSAL.exec(r.stdout)?.[1], "merged with no Ruling PR #999, #1000, #1500 — run `tier-outcomes.mjs append <pr>` for each; still open PR #1400, #2000");
});

test("router fit: PRs from several cells' newest generations are listed once each, in ascending order across the cells", () => {
  const rows = merged(FIT_EVERY_MERGED);
  unruled(rows, { ticket: 901, pr: 1500 });
  unruled(rows, { ticket: 902, pr: 999, cell: "task-high" });
  // One PR, carried by a Pull in each cell.
  unruled(rows, { ticket: 903, pr: 1200 });
  unruled(rows, { ticket: 904, pr: 1200, cell: "task-high" });
  const f = fixture({ rows, gh: { prs: [prState(1500, "MERGED"), prState(999, "MERGED"), prState(1200, "MERGED")] } });
  const r = f.run(["--dry-run"]);
  assertNoRefit(f, r);
  assert.equal(REFUSAL.exec(r.stdout)?.[1], "merged with no Ruling PR #999, #1200, #1500 — run `tier-outcomes.mjs append <pr>` for each");
});

test("router fit: with every PR of the newest generation ruled the re-fit opens as ever, and the checkout holds no cost-guard.json", () => {
  const rows = merged(FIT_EVERY_MERGED);
  unruled(rows, { ticket: 900, pr: 1400 });
  rows.tiers.push(tier({ ticket: "900", pr: "1400", run_date: "2026-10-05" }));
  const f = fixture({ rows });
  assert.equal(existsSync(join(f.repo, GUARD)), false);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /router fit: DUE=yes MERGED=51\/50 — .*; opened https:\/\/github\.com\/o\/r\/pull\/902 from chore\/router-fit-\S+$/m);
  assert.doesNotMatch(r.stdout, /record incomplete/);
  assert.equal(calls(f, "pr create").length, 1);
});

test("router fit: an older generation's unruled or open PR, a closed PR and a Ruling given by hand do not stop the re-fit", () => {
  const rows = merged(FIT_EVERY_MERGED);
  // model-old is the cell's older generation: its Pulls' session opens earlier than the newest generation's.
  const older = "2026-10-03T09-00-00-000Z_01a00000-0000-7000-8000-000000000000";
  unruled(rows, { ticket: 901, pr: 1401, session: older, dispatchModel: "model-old" });
  unruled(rows, { ticket: 902, pr: 1402, session: older, dispatchModel: "model-old" });
  unruled(rows, { ticket: 903, pr: 1403 });
  rows.tiers.push(tier({ ticket: "904", pr: "1404", note: "ruled by hand" }));
  unruled(rows, { ticket: 904, pr: 1404 });
  const f = fixture({ rows, gh: { prs: [prState(1401, "MERGED"), prState(1402, "OPEN"), prState(1403, "CLOSED")] } });
  const r = f.run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /record incomplete/);
  assert.match(r.stdout, /router fit: DUE=yes MERGED=\d+\/50 — .*; would open a chore PR from chore\/router-fit-/);
});

test("router fit: a tripped cell (pr-cost exit 3) or a baseline under n=20 (exit 4) is a guard verdict, not a failure", () => {
  const rows = merged(FIT_EVERY_MERGED);
  for (let i = 1; i <= 20; i++) ruled(rows, { ticket: 100 + i, cell: "task-high", fail: true });
  const tripped = fixture({ rows });
  const t = tripped.run(["--dry-run"]);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /router fit: DUE=yes MERGED=\d+\/50 — .*; would open a chore PR from chore\/router-fit-/);
  const none = fixture({ rows: corpus() }).run(["--dry-run"]);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /router fit: DUE=no MERGED=0\/50 — not due/);
});

test("router fit: when `gh pr list` fails the duty fails — due or not — naming the duty, and nothing is pushed or opened", () => {
  for (const rows of [merged(FIT_EVERY_MERGED), corpus()]) {
    const f = fixture({ rows, gh: { listFails: true } });
    const r = f.run();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /^run-team-local: router fit failed: pr-cost\.mjs --json failed \(exit 2\): pr-cost: gh pr list failed: exit 1$/m);
    assert.equal(git(f.origin, ["branch", "--list", "chore/*"]), "");
    assert.deepEqual(calls(f, "pr create"), []);
    assert.equal(worktrees(f.repo), 1);
  }
});

test("router fit: a due re-fit is pushed to its own chore branch and opened as a PR labelled patch, never onto main — and not while an earlier re-fit PR is open", () => {
  const f = fixture({ rows: merged(FIT_EVERY_MERGED) });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const branch = /opened https:\/\/github\.com\/o\/r\/pull\/902 from (chore\/router-fit-\S+)$/m.exec(r.stdout)?.[1];
  assert.ok(branch, r.stdout);
  const mainSha = git(f.origin, ["rev-parse", "main"]);
  assert.equal(JSON.parse(git(f.origin, ["show", `${branch}:${TABLE}`])).fitted_commit, mainSha, "the re-fit records the commit of main it read");
  assert.equal(JSON.parse(git(f.origin, ["show", `main:${TABLE}`])).fitted_commit, null, "main itself is untouched");
  const [create] = calls(f, "pr create");
  const subject = `chore: re-fit router-table.json at ${mainSha.slice(0, 8)}`;
  assert.equal(create[create.indexOf("--title") + 1], subject, "the PR title names the short sha");
  assert.equal(git(f.origin, ["log", "-1", "--format=%s", branch]), subject);
  assert.equal(create[create.indexOf("--base") + 1], "main");
  assert.equal(create[create.indexOf("--head") + 1], branch);
  assert.equal(create[create.indexOf("--label") + 1], "patch", "labelled by the create itself, not by an edit that can fail after it");
  assert.match(create[create.indexOf("--body") + 1], /\n\nticket-router: fitted \d+ Pulls .*\nticket-router: row cost \* slow-high unjudged /, "the body carries the fit's whole output: its summary, then each row's line");
  assert.match(r.stdout, /; opened \S+ from chore\/router-fit-\S+\nrun-team-local: router fit: ticket-router: row cost \* slow-high unjudged /, "each row's line follows the opened line");
  assert.deepEqual(calls(f, "pr edit"), []);
  assert.equal(git(f.repo, ["branch", "--list", "chore/*"]), "", "the checkout's repository keeps no local branch of the PR's");
  assert.doesNotMatch(git(f.repo, ["config", "--local", "--list"]), /^branch\.chore/m, "and no upstream config for it");
  assert.equal(worktrees(f.repo), 1);

  const earlier = { number: 55, headRefName: "chore/router-fit-2026-10-01" };
  const held = fixture({ rows: merged(FIT_EVERY_MERGED), gh: { openPrs: [earlier] } });
  const h = held.run();
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, new RegExp(`router fit: DUE=yes MERGED=50/50 — re-fit PR #${earlier.number} \\(${escape(earlier.headRefName)}\\) is still open$`, "m"));
  assert.deepEqual(calls(held, "pr create"), []);
  assert.equal(git(held.origin, ["branch", "--list", "chore/*"]), "");
});

test("router fit: a re-fit whose `pr create` fails still prints the fit's summary and each row's line, then fails the duty", () => {
  const f = fixture({ rows: merged(FIT_EVERY_MERGED), gh: { createFails: true } });
  const r = f.run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /run-team-local: router fit failed: .*create refused/);
  assert.match(r.stdout, /^run-team-local: router fit: DUE=yes MERGED=50\/50 — ticket-router: fitted \d+ Pulls .*; no PR opened from chore\/router-fit-\S+\nrun-team-local: router fit: ticket-router: row cost \* slow-high unjudged /m);
  assert.doesNotMatch(r.stdout, /; opened /);
});

test("router fit: reads origin/main, not the checkout's own HEAD, when the two differ", () => {
  const f = fixture({ rows: merged(FIT_EVERY_MERGED) });
  // A local commit no remote holds, whose features file has no rows (the hook's own stopping rule still
  // reads the file, so it must exist): a fit from this HEAD would count no merged pull and not be due.
  write(f.repo, FEATURES, featuresTsv([]));
  git(f.repo, ["commit", "--quiet", "-am", "local only"]);
  const localSha = git(f.repo, ["rev-parse", "HEAD"]);
  const mainSha = git(f.origin, ["rev-parse", "main"]);
  assert.notEqual(localSha, mainSha);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const branch = /opened https:\/\/github\.com\/o\/r\/pull\/902 from (chore\/router-fit-\S+)$/m.exec(r.stdout)?.[1];
  assert.ok(branch, r.stdout);
  assert.match(r.stdout, /router fit: DUE=yes MERGED=50\/50 — /);
  assert.equal(JSON.parse(git(f.origin, ["show", `${branch}:${TABLE}`])).fitted_commit, mainSha, "the re-fit records origin/main, not the local HEAD");
});

// ---------------------------------------------------------------------------
// usage

test("usage: no positional, and only the declared flags, else exit 2", () => {
  const f = fixture();
  for (const extra of [["phase-0"], ["close-out"], ["--bogus"], ["--repo"]]) {
    const r = spawnSync(process.execPath, [HOOK, ...extra, "--repo", f.repo], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stderr}`);
  }
  // A flag's value is not a positional.
  const value = spawnSync(process.execPath, [HOOK, "--repo", f.repo, "--dry-run"], { encoding: "utf8", env: { ...ENV, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, GH_FIXTURE: join(f.root, "gh.json"), GH_LOG: join(f.root, "gh.log") }, cwd: f.repo });
  assert.notEqual(value.status, 2, value.stderr);
  // No `--model-roles`/`--catalog` here, so the drift notice asks `omp`: the
  // fixture's failing stub answers it, never the host's omp.
  assert.match(value.stdout + value.stderr, /drift notice: skipped — omp config get modelRoles --json failed/);
});
