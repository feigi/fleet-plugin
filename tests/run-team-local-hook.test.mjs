// The repo-local hook, .omp/skills/run-team-local/hook.mjs, run as the CLI
// against a fixture workspace: the member-outcomes corpus and the cell
// definitions, and a stub `gh` that logs every call it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv } from "../plugin/scripts/member-outcomes.mjs";
import { WINDOW_START } from "../plugin/scripts/pr-cost.mjs";

const HOOK = fileURLToPath(new URL("../.omp/skills/run-team-local/hook.mjs", import.meta.url));
const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const STARTING = ["slow-high", "task-high", "smol-high"];

// Pinned identity, no developer config, no inherited repo pointers.
const ENV = {
  ...process.env,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_TEMPLATE_DIR: undefined,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

const MODEL_ROLES = { slow: "anthropic/claude-opus-5", task: "anthropic/claude-sonnet-5", smol: "anthropic/claude-haiku-4-5" };
const CATALOG = {
  models: [
    { selector: "anthropic/claude-opus-5", thinking: ["low", "medium", "high", "xhigh", "max"] },
    { selector: "anthropic/claude-sonnet-5", thinking: ["low", "medium", "high", "xhigh", "max"] },
    { selector: "anthropic/claude-haiku-4-5", thinking: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
};

const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp", subagentType: "",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, dispatchModel: o.model ?? "claude-opus-5", workS: 60, ...o,
});
const corpus = () => ({ members: [] });

const membersTsv = (rows) => `# ${MEMBER_COLUMNS.join("\t")}\n${rows.length ? formatTsv(rows) : ""}`;
const agentMd = (cell) => {
  const [role, level] = cell.split("-");
  return `---\nname: fleet-implementer-${cell}\ndescription: fixture\nmodel: "@${role}:${level}"\n---\n\nbody\n`;
};

// Logs each argv to GH_LOG and answers nothing: the hook has no call to make.
const GH_STUB = `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("gh stub: unexpected " + process.argv.slice(2).join(" "));
process.exit(9);
`;

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function fixture({ rows = corpus(), cells = STARTING } = {}) {
  const root = tempDir("run-team-local-");
  const repo = join(root, "repo");
  for (const cell of cells) write(repo, `plugin/agents/fleet-implementer-${cell}.agent.md`, agentMd(cell));
  write(repo, "docs/metrics/member-outcomes.tsv", membersTsv(rows.members));
  mkdirSync(join(root, "bin"));
  writeExecStub(join(root, "bin", "gh"), GH_STUB);
  // An `omp` that fails at once, so no spawn with this `bin` first reads the
  // host's omp config: a run without `--model-roles`/`--catalog` skips the drift notice.
  writeExecStub(join(root, "bin", "omp"), "#!/bin/sh\nexit 1\n");
  writeFileSync(join(root, "model-roles.json"), JSON.stringify(MODEL_ROLES));
  writeFileSync(join(root, "catalog.json"), JSON.stringify(CATALOG));
  const log = join(root, "gh.log");
  const env = { ...ENV, PATH: `${join(root, "bin")}:${process.env.PATH}`, GH_LOG: log };
  return {
    root, repo, env,
    run(extra = []) {
      const args = [HOOK, "--repo", repo, "--model-roles", join(root, "model-roles.json"), "--catalog", join(root, "catalog.json"), ...extra];
      return spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", env });
    },
    ghCalls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

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
  const f = fixture({ rows, cells: [...STARTING, "smol-max"] });
  const r = f.run();
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
  const r = f.run();
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
  const r = fixture({ rows }).run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /tier-roles: notice:/);
  assert.match(r.stdout, /drift notice: every cell's last admissible row ran its role's current target/);
});

// ---------------------------------------------------------------------------
// the duties

test("duties: the hook runs the drift notice and no other, and makes no GitHub call", () => {
  const rows = corpus();
  rows.members.push(member({ agent: "impl-1", run_date: "2026-10-02", session: "s1", subagentType: "fleet-implementer-slow-high" }));
  const f = fixture({ rows });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  // The duty each `run-team-local: <duty>: …` line names, a run of one duty's lines collapsed to one.
  const duties = [...r.stdout.matchAll(/^run-team-local: ([^:]+): /gm)].map((m) => m[1]).filter((d, i, all) => d !== all[i - 1]);
  assert.deepEqual(duties, ["drift notice"]);
  assert.deepEqual(f.ghCalls(), [], "no PR is listed or opened");
});

test("duties: a duty that fails exits 1 naming it: a torn member-outcomes.tsv fails the drift notice", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "docs", "metrics", "member-outcomes.tsv"), "# header\nshort\trow\n");
  const r = f.run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^run-team-local: drift notice failed: malformed row/m);
  assert.deepEqual(f.ghCalls(), []);
});

// ---------------------------------------------------------------------------
// usage

test("usage: no positional, and only the declared flags, else exit 2", () => {
  const f = fixture();
  for (const extra of [["phase-0"], ["close-out"], ["--bogus"], ["--repo"], ["--dry-run"]]) {
    const r = spawnSync(process.execPath, [HOOK, ...extra, "--repo", f.repo], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stderr}`);
  }
  // A flag's value is not a positional.
  const value = spawnSync(process.execPath, [HOOK, "--repo", f.repo], { encoding: "utf8", env: f.env, cwd: f.repo });
  assert.equal(value.status, 0, value.stderr);
  // No `--model-roles`/`--catalog` here, so the drift notice asks `omp`: the
  // fixture's failing stub answers it, never the host's omp.
  assert.match(value.stdout + value.stderr, /drift notice: skipped — omp config get modelRoles --json failed/);
});
