// metrics-refresh.mjs: the drain of the pending ticket-features rows and the
// cost-guard refresh, run as the CLI against a fixture workspace — a git
// checkout carrying the metrics corpus, and a stub `gh` that answers
// pr-cost's one `pr list` from a fixture file and logs every call it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow } from "../plugin/scripts/tier-outcomes.mjs";
import { WINDOW_START, MIN_N } from "../plugin/scripts/pr-cost.mjs";
import { FEATURE_COLUMNS } from "../plugin/scripts/pull-attribution.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/metrics-refresh.mjs", import.meta.url));
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

// Answers pr-cost's `pr list` from GH_FIXTURE; logs each argv to GH_LOG.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
if (args.slice(0, 2).join(" ") === "pr list") process.stdout.write(JSON.stringify(fx.prs));
else { process.stderr.write("gh stub: unexpected " + args.join(" ")); process.exit(9); }
`;

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function fixture({ rows = corpus(), pending = null, guardBefore = null, prs = [] } = {}) {
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
  const log = join(root, "gh.log");
  return {
    root, repo,
    run({ cwd = repo, args = ["--repo", repo] } = {}) {
      return spawnSync(process.execPath, [SCRIPT, ...args], {
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
  writeFileSync(join(broken.repo, "docs", "metrics", "member-outcomes.tsv"), "short\trow\n");
  const b = broken.run();
  assert.equal(b.status, 1);
  assert.match(b.stderr, /metrics-refresh: cost guard failed: pr-cost\.mjs --guard exited 2/);
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

test("a corpus written before the objective column gains it, blank on the rows it holds, when the pending file carries it", () => {
  const rows = corpus();
  ruled(rows, { ticket: 1 });
  const older = FEATURE_COLUMNS.filter((c) => c !== "objective");
  const fresh = pull({ ticket: "2", agent: "impl-2", objective: "speed" });
  const f = fixture({ rows, pending: featuresTsv([fresh]) });
  write(f.repo, FEATURES, featuresTsv(rows.features, older));
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /drain: 1 row from/);
  assert.equal(readFileSync(join(f.repo, FEATURES), "utf8"), featuresTsv([{ ...rows.features[0], objective: "" }, fresh]));
});

test("a pending file written before the objective column drains, its rows blank in that column", () => {
  const older = FEATURE_COLUMNS.filter((c) => c !== "objective");
  const fresh = pull({ ticket: "2", agent: "impl-2" });
  const f = fixture({ pending: featuresTsv([fresh], older) });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const last = readFileSync(join(f.repo, FEATURES), "utf8").split("\n").filter(Boolean).at(-1);
  assert.equal(last, FEATURE_COLUMNS.map((c) => (c === "objective" ? "" : fresh[c] ?? "")).join("\t"));
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

test("usage: only the declared flag and no positional, else exit 2", () => {
  const f = fixture();
  for (const args of [["--bogus"], ["phase-0"], ["--repo"]]) {
    const r = f.run({ args });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
});
