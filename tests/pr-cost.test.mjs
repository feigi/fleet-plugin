// pr-cost.mjs: booking, the per-cell figures, and the guard's exit contract,
// over synthetic member-outcomes / tier-outcomes / ticket-features TSVs and a
// stub `gh` that answers the one `gh pr list` from a fixture file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow, parseTierOutcomes } from "../plugin/scripts/tier-outcomes.mjs";
import { computeReport, trips, guardFile, formatReport, crossCheck, WINDOW_START, MIN_N } from "../plugin/scripts/pr-cost.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "../plugin/scripts/pull-attribution.mjs";
import { readCostGuard, routerRows } from "../plugin/scripts/fleet-tick.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/pr-cost.mjs", import.meta.url));
const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";

// One world: member rows, tier rows, Pulls and PR states, built up by helpers
// and rendered into the three files the CLI reads.
function world() {
  return { members: [], tiers: [], features: [], prs: [] };
}
const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5",
  effort: "high", ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1,
  harness: "omp", subagentType: "", tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, dispatchModel: o.model ?? "claude-opus-5", workS: 60, ...o,
});
const pull = (o) => ({
  run_date: DAY, session: SESSION, policy_cell: "slow-high", exploration_draw: "", sizing_src: "rule",
  sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0", age_days: "0",
  paths: "0", test_paths: "0", xrefs: "0", kind: "enhancement", ...o,
});
const tier = (o) => ({
  run_date: DAY, class: "", tier: "", closed_own_ticket: "yes", minted_false_claim: "no", note: "n",
  sizing: "light", profile: "small", loc: "10", files: "1", ...o,
});

// A whole ruled PR: one Pull at `cell` costing `usd`, its verdict, its state.
function addPr(w, { ticket, pr, cell, usd, fail = false, state = "MERGED", agent = `impl-${ticket}` }) {
  const level = cell.split("-")[1];
  w.features.push(pull({ ticket: String(ticket), agent, chosen_cell: cell }));
  w.members.push(member({ agent, ticket: String(ticket), cost: usd, effort: level, subagentType: `fleet-implementer-${cell}`, pr: String(pr) }));
  w.tiers.push(tier({ pr: String(pr), ticket: String(ticket), minted_false_claim: fail ? "yes" : "no" }));
  w.prs.push({ number: pr, state, mergedAt: state === "MERGED" ? `${DAY}T12:00:00Z` : null });
}
// `n` merged PRs at `cell`, `failures` of them failing the floor, each costing `usd`.
let nextTicket = 1000;
function addCell(w, cell, n, failures, usd) {
  for (let i = 0; i < n; i++) {
    const t = nextTicket++;
    addPr(w, { ticket: t, pr: t + 5000, cell, usd, fail: i < failures });
  }
}

const parsed = (w) => ({
  members: parseMemberTsv(formatTsv(w.members)),
  tiers: parseTierOutcomes(w.tiers.map(formatRow).join("\n")),
  features: parseFeatures(featuresText(w)),
  prs: w.prs,
});
const featuresText = (w) => [FEATURE_COLUMNS.join("\t"), ...w.features.map((f) => FEATURE_COLUMNS.map((c) => f[c] ?? "").join("\t"))].join("\n") + "\n";

// `at(dir)` may replace the cwd and argv, and add env, for a run that needs the scratch dir's own paths.
function runCli(w, args = ["--guard"], { features, at } = {}) {
  const dir = tempDir("pr-cost-");
  mkdirSync(join(dir, "docs", "metrics"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), `# ${MEMBER_COLUMNS.join("\t")}\n${formatTsv(w.members)}`);
  writeFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), `# ${TIER_COLUMNS.join("\t")}\n${w.tiers.map(formatRow).join("\n")}\n`);
  writeFileSync(join(dir, "docs", "metrics", "ticket-features.tsv"), features ?? featuresText(w));
  writeFileSync(join(dir, "prs.json"), JSON.stringify(w.prs));
  writeExecStub(join(dir, "bin", "gh"), `#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 9\nprintf '%s\\n' "$@" > "$FIXTURE_PRS.args"\nprintf '%s' "\${GIT_DIR-unset}" > "$FIXTURE_PRS.gitdir"\ncat "$FIXTURE_PRS"\n`);
  const run = at?.(dir) ?? { cwd: dir, args };
  const r = spawnSync(process.execPath, [SCRIPT, ...run.args], {
    cwd: run.cwd, encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FIXTURE_PRS: join(dir, "prs.json"), ...run.env },
  });
  const guardPath = join(dir, ".fleet", "cost-guard.json");
  const argsPath = join(dir, "prs.json.args");
  return {
    ...r,
    guard: existsSync(guardPath) ? JSON.parse(readFileSync(guardPath, "utf8")) : null,
    ghArgs: existsSync(argsPath) ? readFileSync(argsPath, "utf8").trim().split("\n") : null,
    ghGitDir: existsSync(join(dir, "prs.json.gitdir")) ? readFileSync(join(dir, "prs.json.gitdir"), "utf8") : null,
    guardPath,
    dir,
  };
}

// ---------------------------------------------------------------------------
// The guard's exit contract.

test("--guard: a cell exactly 15 points worse than the baseline trips, exits 3 and is named in tripped[]", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 6, 10);   // 30% fail, $10
  addCell(w, "task-high", MIN_N, 9, 5);    // 45% fail: +15 points, exactly the margin
  addCell(w, "smol-high", MIN_N, 8, 3);    // 40% fail: +10 points, under it
  const r = runCli(w);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(r.guard.tripped, ["task-high"]);
  assert.equal(r.guard.verdict, "tripped");
  assert.deepEqual(r.guard.baseline, { cell: "slow-high", generation: "claude-opus-5", n: 20, mean_usd: 10, fail_rate: 0.3 });
  assert.equal(r.guard.min_n, MIN_N);
  // The file is the router row's input: fleet-tick reads it as a verdict.
  const read = readCostGuard(r.guardPath);
  assert.equal(read.status, "ok");
  assert.deepEqual(routerRows({ router: read }).map((x) => [x.action, x.detail]),
    [["DEFAULT-ONLY", `cost guard: task-high $5.00 vs $10.00, fail 45% vs 30%, n=20/20; guard computed ${r.guard.computed_at}`]]);
  assert.deepEqual(r.guard.cells.find((c) => c.cell === "task-high"), { cell: "task-high", generation: "claude-opus-5", n: 20, mean_usd: 5, fail_rate: 0.45, untimed: 0 });
  assert.equal(r.guard.window_start, WINDOW_START);
  assert.ok(!Number.isNaN(Date.parse(r.guard.computed_at)));
  assert.match(r.stdout, /^task-high\tclaude-opus-5\t20\t20\t20\t9\t0\.45\t5\t5\t0\t[^\t]*\t0\t0\t0\t0\ttripped$/m);
  assert.match(r.stdout, /^smol-high\t.*\tok$/m);
});

test("--guard: a cell at least as dear as the baseline trips on $ alone, at an equal fail rate", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 4, 10);
  addCell(w, "task-high", MIN_N, 4, 10);
  const r = runCli(w);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(r.guard.tripped, ["task-high"]);
});

test("--guard: the $ leg compares unrounded means, so a cell cheaper by under half a cent does not trip on rounding", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 4, 10.004);
  addCell(w, "task-high", MIN_N, 4, 10.001);
  const r = runCli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.guard.cells.map((c) => c.mean_usd), [10, 10], "both print as $10.00");
  assert.deepEqual(r.guard.tripped, []);
});

test("--guard: every cell within the margin and cheaper exits 0, verdict ok", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 6, 10);
  addCell(w, "task-high", MIN_N, 8, 5);
  const r = runCli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.guard.tripped, []);
  assert.equal(r.guard.verdict, "ok");
});

test("--guard: a baseline under n=20 is no verdict, exit 4, and judges no cell however bad", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N - 1, 0, 10);
  addCell(w, "task-high", MIN_N, MIN_N, 50);
  const r = runCli(w);
  assert.equal(r.status, 4, r.stderr);
  assert.equal(r.guard.verdict, "none");
  assert.deepEqual(r.guard.tripped, []);
  assert.equal(r.guard.baseline.n, 19);
  assert.match(r.stdout, /^# verdict: none \(baseline slow-high n=19\/20\)/m);
});

test("--guard: a cell under n=20 is never tripped, however bad, while the baseline has a verdict", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "smol-high", MIN_N - 1, MIN_N - 1, 50);
  const r = runCli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.guard.tripped, []);
});

test("--guard: an unreadable input is exit 2 and writes no guard file", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  const bad = runCli(w, ["--guard"], { features: `${FEATURE_COLUMNS.join("\t")}\n${DAY}\tshort-row\n` });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /ticket-features\.tsv row 1: 2 fields, expected 18/);
  assert.equal(bad.guard, null);
  const noCell = runCli(w, ["--guard"], { features: featuresText(w).replace("\tslow-high\t\t", "\tfast-high\t\t") });
  assert.equal(noCell.status, 2);
  assert.match(noCell.stderr, /chosen_cell "fast-high" is not a cell/);
});

test("--guard: a missing ticket-features.tsv is exit 2 naming its producer, and writes no guard file", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  const r = runCli(w, null, {
    at: (dir) => {
      rmSync(join(dir, "docs", "metrics", "ticket-features.tsv"));
      return { cwd: dir, args: ["--guard"] };
    },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read docs\/metrics\/ticket-features\.tsv: ENOENT — the router script writes it at dispatch/);
  assert.equal(r.guard, null);
});

test("--guard: a gh pr list page at its cap is refused rather than read as complete", () => {
  const w = world();
  addCell(w, "slow-high", 1, 0, 10);
  for (let i = w.prs.length; i < 1000; i++) w.prs.push({ number: 90000 + i, state: "CLOSED", mergedAt: null });
  const r = runCli(w);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /returned 1000 PRs, its cap/);
});

test("--guard: an explicit --pricing that does not exist is exit 2, while an absent default is simply no cross-check", () => {
  const w = world();
  addCell(w, "slow-high", 1, 0, 10);
  const named = runCli(w, null, { at: (dir) => ({ cwd: dir, args: ["--guard", "--pricing", join(dir, "nope.json")] }) });
  assert.equal(named.status, 2);
  assert.match(named.stderr, /cannot read .*nope\.json: ENOENT/);
  assert.equal(named.guard, null);
  const absent = runCli(w, ["--json"]);
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(JSON.parse(absent.stdout).cross_check, null);
  const present = runCli(w, null, {
    at: (dir) => {
      writeFileSync(join(dir, "p.json"), JSON.stringify({ models: {} }));
      return { cwd: dir, args: ["--json", "--pricing", join(dir, "p.json")] };
    },
  });
  assert.deepEqual(JSON.parse(present.stdout).cross_check, { rows: 0, skipped: 1, ratio: null });
});

test("--guard: with no --out the file lands in the main workspace, where fleet-tick reads it, even from a linked worktree", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N - 1, 0, 10);
  const r = runCli(w, null, {
    at: (dir) => {
      const git = (cwd, ...a) => {
        const g = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env: gitEnv() });
        assert.equal(g.status, 0, g.stderr);
      };
      const main = join(dir, "main");
      mkdirSync(main);
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "x");
      git(main, "worktree", "add", "-q", join(dir, "wt"), "-b", "side");
      const m = join(dir, "docs", "metrics");
      return {
        cwd: join(dir, "wt"),
        args: ["--guard", "--member-outcomes", join(m, "member-outcomes.tsv"), "--tier-outcomes", join(m, "tier-outcomes.tsv"),
          "--ticket-features", join(m, "ticket-features.tsv")],
      };
    },
  });
  assert.equal(r.status, 4, r.stderr);
  const file = join(r.dir, "main", ".fleet", "cost-guard.json");
  assert.equal(readCostGuard(file).status, "ok", "the tick's reader accepts the file where it looks for it");
  assert.equal(existsSync(join(r.dir, "wt", ".fleet")), false, "nothing is written under the worktree's own cwd");
});

test("--guard: outside any repository with no --out, the cwd-relative fallback is announced with the reason, not taken in silence", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N - 1, 0, 10);
  const r = runCli(w, null, {
    at: (dir) => ({
      cwd: dir, env: { GIT_CEILING_DIRECTORIES: dirname(realpathSync(dir)) },
      args: ["--guard"],
    }),
  });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /pr-cost: WARNING could not resolve --git-common-dir: \S/, "the reason must follow, not only the fact of the failure");
  assert.match(r.stderr, /cwd-relative \.fleet\/cost-guard\.json/);
  assert.equal(existsSync(r.guardPath), true, "the fallback is still where the guard file lands");
});

test("an ambient GIT_DIR naming another repository cannot move the guard file out of the repository pr-cost runs in", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N - 1, 0, 10);
  let other;
  const git = (cwd, env, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env });
  const r = runCli(w, null, {
    at: (dir) => {
      const here = join(dir, "here");
      other = join(dir, "other");
      for (const repo of [here, other]) {
        mkdirSync(repo);
        assert.equal(git(repo, gitEnv(), "init", "-q").status, 0);
        assert.equal(git(repo, gitEnv(), "commit", "-q", "--allow-empty", "-m", "x").status, 0);
      }
      const m = join(dir, "docs", "metrics");
      return {
        cwd: here, env: { GIT_DIR: join(other, ".git") },
        args: ["--guard", "--member-outcomes", join(m, "member-outcomes.tsv"), "--tier-outcomes", join(m, "tier-outcomes.tsv"),
          "--ticket-features", join(m, "ticket-features.tsv")],
      };
    },
  });
  assert.equal(r.status, 4, r.stderr);
  // The injection reaches a child: an unscrubbed git, in the same cwd, answers for the other repository.
  const unscrubbed = git(join(r.dir, "here"), { ...process.env, GIT_DIR: join(other, ".git") }, "rev-parse", "--git-common-dir");
  assert.equal(unscrubbed.stdout.trim(), join(other, ".git"));
  assert.equal(existsSync(join(r.dir, "here", ".fleet", "cost-guard.json")), true);
  assert.equal(existsSync(join(other, ".fleet")), false);
});

test("an ambient GIT_DIR does not reach the gh child that reads merged state", () => {
  const w = world();
  addCell(w, "slow-high", 1, 0, 10);
  const r = runCli(w, ["--json"], { at: (dir) => ({ cwd: dir, args: ["--json"], env: { GIT_DIR: join(dir, "elsewhere", ".git") } }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.ghGitDir, "unset");
  // The stub does echo an injected GIT_DIR back when it is not scrubbed.
  const probe = spawnSync(join(r.dir, "bin", "gh"), ["pr", "list"], { env: { ...process.env, GIT_DIR: "probe", FIXTURE_PRS: join(r.dir, "prs.json") } });
  assert.equal(probe.status, 0);
  assert.equal(readFileSync(join(r.dir, "prs.json.gitdir"), "utf8"), "probe");
});

test("without --guard the report prints and exits 0, writing nothing", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "task-high", MIN_N, MIN_N, 50);
  const r = runCli(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.guard, null);
  // One read, every state, scoped to PRs created since the window opened.
  assert.deepEqual(r.ghArgs, ["pr", "list", "--state", "all", "--search", `created:>=${WINDOW_START}`,
    "--limit", "1000", "--json", "number,state,mergedAt"]);
  assert.match(r.stdout, /^cell\tgeneration\tn_pulls\tn_merged\tn_claims\tn_failed\tfail_rate\tmean_usd\tmedian_usd\trouter_usd\tusd_diff_ci95\texcluded\tleft_out\tunpriced\tuntimed\tguard$/m);
  const json = JSON.parse(runCli(w, ["--json"]).stdout);
  assert.deepEqual(json.tripped, ["task-high"]);
});

test("the retire condition holds once every non-default stage-1 cell has tripped, and only then", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "task-high", MIN_N, 0, 11);
  const one = computeReport(parsed(w));
  assert.deepEqual([one.tripped, one.retire], [["task-high"], false]);
  addCell(w, "smol-high", MIN_N, 5, 1);
  const both = computeReport(parsed(w));
  assert.deepEqual([both.tripped, both.retire], [["smol-high", "task-high"], true]);
  assert.equal(guardFile(both, "t").retire, true);
  // A stratum that already adopted a non-default cell keeps the router.
  assert.equal(computeReport({ ...parsed(w), routerTable: { rows: { "*": "slow-high", light: "task-high" } } }).retire, false);
});

test("trips() takes the 15-point margin in counts, so 3 of 20 is exactly the margin", () => {
  const base = { claims: 20, failed: 4, mean_usd: 10 };
  assert.equal(trips({ claims: 20, failed: 7, mean_usd: 1 }, base), true, "7 of 20 failing vs 4 of 20 is +15 points");
  assert.equal(trips({ claims: 20, failed: 6, mean_usd: 1 }, base), false, "6 of 20 vs 4 of 20 is +10 points");
  assert.equal(trips({ claims: 40, failed: 14, mean_usd: 1 }, base), true, "35% vs 20% across different n");
  assert.equal(trips({ claims: 20, failed: 0, mean_usd: 10 }, base), true, "equal $ trips");
  assert.equal(trips({ claims: 20, failed: 0, mean_usd: 9.99 }, base), false);
});

// ---------------------------------------------------------------------------
// Booking.

test("a Pull books every implementer under it at any cell, its PR's named members and their nested members; merge-bot, memory and advisor book nowhere", () => {
  const w = world();
  const T = 41, P = 141;
  // The first implementer ran at another cell and ran out of budget; its replacement at the drawn cell opened the PR.
  w.features.push(pull({ ticket: String(T), agent: `impl-${T}`, chosen_cell: "slow-high", router_usd: "0.0002" }));
  w.members.push(member({ agent: `impl-${T}`, ticket: String(T), cost: 2, subagentType: "fleet-implementer-task-high", ending: "budget" }));
  w.members.push(member({ agent: `impl-${T}-b`, ticket: String(T), pr: String(P), cost: 3, subagentType: "fleet-implementer-slow-high", ending: "pr" }));
  w.members.push(member({ agent: `impl-${T}-b/Probe`, member: `impl-${T}-b/Probe`, cost: 0.5 }));
  for (const [agent, cost] of [[`review-pr-${P}`, 1], [`fix-pr-${P}`, 1.25], [`finisher-pr-${P}`, 0.25],
    [`reviewcorrectnesspr${P}`, 0.75], [`verifycorrectnesspr${P}-2`, 0.125], [`snapshotpr${P}`, 0.0625], [`test-runpr${P}`, 0.0625],
    [`review-pr-${P}/Helper`, 0.25], ["merge-bot-3", 100], ["memory", 100], ["__advisor", 100], ["MergeBot4", 100],
    // Excluded by its own name even where an ancestor is booked — nested as
    // `<parent>/<name>` and as omp writes it, `<parent>/<parent>.<name>`.
    [`impl-${T}-b/__advisor`, 100], [`review-pr-${P}/memory`, 100], [`review-pr-${P}/mergebot-2`, 100],
    [`impl-${T}-b/impl-${T}-b.__advisor`, 100], [`review-pr-${P}/review-pr-${P}.memory`, 100],
    [`review-pr-${P}/review-pr-${P}.merge-bot-2`, 100]]) {
    w.members.push(member({ agent, cost, role: "reviewer" }));
  }
  w.tiers.push(tier({ pr: String(P), ticket: String(T) }));
  w.prs.push({ number: P, state: "MERGED" });
  const rep = computeReport(parsed(w));
  assert.deepEqual(rep.cells.map((c) => c.cell), ["slow-high"], "nothing splits across cells");
  const slow = rep.cells[0];
  assert.equal(slow.n_merged, 1);
  assert.equal(slow.mean_usd, 2 + 3 + 0.5 + 1 + 1.25 + 0.25 + 0.75 + 0.125 + 0.0625 + 0.0625 + 0.25);
  assert.equal(slow.router_usd, 0.0002, "printed beside the spend, never in it");
});

test("closed and unruled spend lands on its cell's mean, an open PR is pending, and a Pull with no Admissible row is excluded and counted per cell", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10 });
  addPr(w, { ticket: 2, pr: 102, cell: "slow-high", usd: 4, state: "CLOSED" });
  addPr(w, { ticket: 3, pr: 103, cell: "slow-high", usd: 99, state: "OPEN" });
  // A Pull with no ruling yet, whose implementer opened nothing.
  w.features.push(pull({ ticket: "4", agent: "impl-4", chosen_cell: "slow-high" }));
  w.members.push(member({ agent: "impl-4", ticket: "4", cost: 6, subagentType: "fleet-implementer-slow-high" }));
  // A Pull with no ruling whose implementer opened a PR still open.
  w.features.push(pull({ ticket: "5", agent: "impl-5", chosen_cell: "slow-high" }));
  w.members.push(member({ agent: "impl-5", ticket: "5", cost: 50, pr: "105", subagentType: "fleet-implementer-slow-high" }));
  w.prs.push({ number: 105, state: "OPEN" });
  // Drawn as smol-high, but its only implementer ran a different definition.
  addPr(w, { ticket: 6, pr: 106, cell: "smol-high", usd: 1 });
  w.members.at(-1).subagentType = "fleet-implementer-slow-high";
  // A Pull before the window is not this guard's.
  w.features.push(pull({ ticket: "7", agent: "impl-7", chosen_cell: "slow-high", run_date: "2026-09-01" }));
  w.members.push(member({ agent: "impl-7", ticket: "7", cost: 1000, subagentType: "fleet-implementer-slow-high" }));

  const rep = computeReport(parsed(w));
  const slow = rep.cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_pulls: slow.n_pulls, n_merged: slow.n_merged, mean_usd: slow.mean_usd, median_usd: slow.median_usd },
    { n_pulls: 3, n_merged: 1, mean_usd: 20, median_usd: 10 });
  assert.deepEqual(rep.pending, ["103", "105"]);
  const smol = rep.cells.find((c) => c.cell === "smol-high");
  assert.deepEqual({ n_pulls: smol.n_pulls, excluded: smol.excluded }, { n_pulls: 0, excluded: 1 });
  assert.match(formatReport(rep), /^smol-high\t\t0\t0\t0\t0\t\t\t\t0\t\t1\t0\t0\t0\tn<20$/m, "a cell with only excluded Pulls has no generation");
  assert.equal("mismatch" in rep, false);
});

test("a booked row with a blank cost makes its Pull unpriced and counted per cell, out of every figure; Claude rows are outside the instrument", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: "" });
  w.members.push(member({ agent: "review-pr-101", cost: 2 }));
  addPr(w, { ticket: 2, pr: 102, cell: "slow-high", usd: 3 });
  w.members.push(member({ agent: "fix-pr-102", cost: "", harness: "claude" }));
  const rep = computeReport(parsed(w));
  const slow = rep.cells[0];
  assert.deepEqual({ n_pulls: slow.n_pulls, n_merged: slow.n_merged, unpriced: slow.unpriced, mean_usd: slow.mean_usd },
    { n_pulls: 1, n_merged: 1, unpriced: 1, mean_usd: 3 });
  assert.equal("unpriced" in rep, false, "the count is per cell, not a whole-report row count");
});

test("a Pull with no member row has no Admissible row, so it is excluded and counted rather than read as a free run", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10 });
  addPr(w, { ticket: 2, pr: 102, cell: "slow-high", usd: 6 });
  assert.equal(w.members.pop().agent, "impl-2");
  const rep = computeReport(parsed(w));
  const slow = rep.cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_pulls: slow.n_pulls, excluded: slow.excluded, mean_usd: slow.mean_usd }, { n_pulls: 1, excluded: 1, mean_usd: 10 });
  assert.equal("unbooked_pulls" in rep, false);
});

test("a cost that is neither blank nor a number is exit 2 naming the row, and writes no guard file", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  w.members[0].cost = "n/a";
  const r = runCli(w);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pr-cost: member-outcomes row session \S+ agent impl-\d+: cost 'n\/a' is not a number/);
  assert.equal(r.stdout, "");
  assert.equal(r.guard, null);
});

test("a top-level booked row with a blank work_s makes its Pull untimed: out of every figure, and counted in the report and the guard file", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 50, fail: true });
  w.members.push(member({ agent: "review-pr-101", cost: 2, workS: "" }));
  const r = runCli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.guard.baseline, { cell: "slow-high", generation: "claude-opus-5", n: MIN_N, mean_usd: 10, fail_rate: 0 });
  assert.deepEqual(r.guard.cells, [{ cell: "slow-high", generation: "claude-opus-5", n: MIN_N, mean_usd: 10, fail_rate: 0, untimed: 1 }]);
  assert.match(r.stdout, /^slow-high\tclaude-opus-5\t20\t20\t20\t0\t0\t10\t10\t0\t\t0\t0\t0\t1\tbaseline$/m);
  assert.doesNotMatch(r.stdout, /minute/, "the guard prints no time figure");
});

test("a work_s that is neither blank nor a number is exit 2 naming the row, and writes no guard file", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  w.members[0].workS = "n/a";
  const r = runCli(w);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pr-cost: member-outcomes row session \S+ agent impl-\d+: work_s 'n\/a' is not a number/);
  assert.equal(r.stdout, "");
  assert.equal(r.guard, null);
});

test("the A/B report says B has not run until a B Pull carries a sizing_pre", () => {
  const w = world();
  addCell(w, "slow-high", 3, 0, 10);
  assert.deepEqual(computeReport(parsed(w)).ab,
    { status: "not-run", reason: "B not run — the table has no row a better classifier could change" });
  w.features.find((f) => Number(f.ticket) % 2 === 1).sizing_pre = "light";
  assert.equal(computeReport(parsed(w)).ab.status, "insufficient");
});

test("the A/B report is underpowered until B disagrees with the policy on MIN_N Pulls, and not at MIN_N", () => {
  const build = (agreeing) => {
    const w = world();
    addCell(w, "task-high", 2 * MIN_N, 0, 10);
    for (const f of w.features) if (Number(f.ticket) % 2 === 1) f.sizing_pre = "light";
    // `policy_cell` is slow-high on every Pull; make `agreeing` of the B Pulls agree with it.
    for (const f of w.features.filter((f) => Number(f.ticket) % 2 === 1).slice(0, agreeing)) f.policy_cell = f.chosen_cell;
    return computeReport(parsed(w)).ab;
  };
  const under = build(1);
  assert.equal(under.disagreement, (MIN_N - 1) / MIN_N);
  assert.equal(under.status, "underpowered");
  const enough = build(0);
  assert.equal(enough.disagreement, 1);
  assert.notEqual(enough.status, "underpowered");
});

test("trips() draws the 15-point line at counts that are not multiples of 5", () => {
  const base = { claims: 20, failed: 0, mean_usd: 10 };
  assert.equal(trips({ claims: 50, failed: 7, mean_usd: 1 }, base), false, "7 of 50 failing is +14 points");
  assert.equal(trips({ claims: 100, failed: 15, mean_usd: 1 }, base), true, "15 of 100 failing is +15 points");
});

test("the table labels a non-baseline cell under MIN_N as n<MIN_N rather than ok", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "smol-high", MIN_N - 1, 0, 5);
  assert.match(formatReport(computeReport(parsed(w))), new RegExp(`^smol-high\\t.*\\tn<${MIN_N}$`, "m"));
});

test("an older generation prints on its own line after its cell's newest, with no verdict, and never trips the cell", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  // Every one of model-a's PRs fails the floor and costs twice the baseline's.
  addCell(w, "smol-high", MIN_N, MIN_N, 20);
  for (const m of w.members.slice(-MIN_N)) m.dispatchModel = "model-a";
  addCell(w, "smol-high", 2, 0, 5);
  const rep = computeReport(parsed(w));
  assert.deepEqual([rep.tripped, rep.verdict], [[], "ok"]);
  assert.match(formatReport(rep), new RegExp(`^smol-high\\tclaude-opus-5\\t2\\t2\\t.*\\tn<${MIN_N}\\nsmol-high\\tmodel-a\\t${MIN_N}\\t${MIN_N}\\t.*\\t\\t\\t0\\t0\\t0\\tolder$`, "m"));
});

test("the cross-check reports recorded cost against pricing.json as a ratio, never a $", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 0.03 });
  Object.assign(w.members[0], { tokensIn: 1000, tokensOut: 1000, tokensCacheRead: 0, tokensCacheCreate: 0, tokensCacheWrite1h: 0 });
  const pricing = { models: { "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 } } };
  assert.deepEqual(computeReport({ ...parsed(w), pricing }).cross_check, { rows: 1, skipped: 0, ratio: 1 });
  assert.deepEqual(computeReport({ ...parsed(w), pricing: { models: {} } }).cross_check, { rows: 0, skipped: 1, ratio: null });
});

test("the cross-check skips a blank cost and an unpriced token kind, and prices a 1h cache write apart from the 5m remainder", () => {
  const pricing = { models: { m: { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 } } };
  const row = (o) => parseMemberTsv(formatTsv([member({ model: "m", cost: 0, ...o })]))[0];
  // Blank cost: no figure of record, so nothing to compare.
  assert.deepEqual(crossCheck([row({ cost: "", tokensIn: 1000 })], pricing), { rows: 0, skipped: 1, ratio: null });
  // A token kind the model has no price for cannot be priced as 0.
  assert.deepEqual(crossCheck([row({ cost: 1, tokensCacheRead: 100 })], { models: { m: { input: 5, output: 25 } } }),
    { rows: 0, skipped: 1, ratio: null });
  // A cache write with no recorded 1h split is unpriceable.
  assert.deepEqual(crossCheck([row({ cost: 1, tokensCacheCreate: 100, tokensCacheWrite1h: "" })], pricing),
    { rows: 0, skipped: 1, ratio: null });
  // 100 of the 300 cache-write tokens are 1h; the other 200 are priced 5m, none twice.
  const exact = (100 * 10 + 200 * 6.25) / 1e6;
  assert.deepEqual(crossCheck([row({ cost: exact, tokensCacheCreate: 300, tokensCacheWrite1h: 100 })], pricing),
    { rows: 1, skipped: 0, ratio: 1 });
});

test("a ticket's ruling is its LAST tier row: a re-ruling on a later PR its replacement opened decides n_failed", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10, fail: true });
  w.members.push(member({ agent: "impl-1-b", ticket: "1", pr: "102", cost: 1, subagentType: "fleet-implementer-slow-high" }));
  w.tiers.push(tier({ pr: "102", ticket: "1" }));
  w.prs.push({ number: 102, state: "MERGED" });
  const slow = computeReport(parsed(w)).cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_merged: slow.n_merged, n_failed: slow.n_failed }, { n_merged: 1, n_failed: 0 });
});

test("a ticket's ruling is its last tier row in file order even when an earlier row is dated later: dates only set the floor", () => {
  const w = world();
  w.features.push(pull({ ticket: "1", agent: "impl-1", chosen_cell: "slow-high" }));
  w.members.push(member({ agent: "impl-1", ticket: "1", pr: "102", cost: 1, effort: "high", subagentType: "fleet-implementer-slow-high" }));
  w.tiers.push(tier({ pr: "101", ticket: "1", run_date: "2026-10-04", minted_false_claim: "yes" }), tier({ pr: "102", ticket: "1" }));
  w.prs.push({ number: 101, state: "MERGED" }, { number: 102, state: "MERGED" });
  const slow = computeReport(parsed(w)).cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_merged: slow.n_merged, n_failed: slow.n_failed }, { n_merged: 1, n_failed: 0 }, "PR 102 is the later row, though the older-dated: it rules, and it passes");
});

// Two tickets ruled by PR 101, each Pulled once, ticket 1's implementer opening it; `rows` are their two tier rows, in file order.
function onePrTwoTickets(rows) {
  const w = world();
  for (const t of [1, 2]) {
    w.features.push(pull({ ticket: String(t), agent: `impl-${t}`, chosen_cell: "slow-high" }));
    w.members.push(member({ agent: `impl-${t}`, ticket: String(t), pr: t === 1 ? "101" : "", cost: 1, effort: "high", subagentType: "fleet-implementer-slow-high" }));
  }
  w.tiers.push(...rows);
  w.prs.push({ number: 101, state: "MERGED" });
  const slow = computeReport(parsed(w)).cells.find((c) => c.cell === "slow-high");
  return { n_merged: slow.n_merged, n_failed: slow.n_failed };
}

test("two tickets ruled by one PR: the ruling later in the file carries the quality verdict, whatever the run_dates", () => {
  const LATER = "2026-10-04";
  // The later row is the older-dated: pass, then fail.
  assert.deepEqual(
    onePrTwoTickets([tier({ pr: "101", ticket: "1", run_date: LATER }), tier({ pr: "101", ticket: "2", minted_false_claim: "yes" })]),
    { n_merged: 1, n_failed: 1 });
  // Fail, then pass.
  assert.deepEqual(
    onePrTwoTickets([tier({ pr: "101", ticket: "1", run_date: LATER, minted_false_claim: "yes" }), tier({ pr: "101", ticket: "2" })]),
    { n_merged: 1, n_failed: 0 });
});

test("two tickets ruled by one PR: the later row in the file carries the verdict even when its ticket is the one read first", () => {
  // Tickets are read in Pull order, 1 then 2, so here the later row is the ticket read FIRST.
  assert.deepEqual(
    onePrTwoTickets([tier({ pr: "101", ticket: "2", minted_false_claim: "yes" }), tier({ pr: "101", ticket: "1" })]),
    { n_merged: 1, n_failed: 0 });
  assert.deepEqual(
    onePrTwoTickets([tier({ pr: "101", ticket: "2" }), tier({ pr: "101", ticket: "1", minted_false_claim: "yes" })]),
    { n_merged: 1, n_failed: 1 });
});

test("a ticket's first Pull is the floor of its ruling: an older-dated row is skipped, one dated before its last Pull still rules", () => {
  const BEFORE = "2026-10-02", MID = "2026-10-04", LAST = "2026-10-05";
  // One ticket Pulled on DAY and again on LAST, the first Pull's implementer opening PR 101; `rows` are its tier rows, in file order.
  const report = (rows) => {
    const w = world();
    for (const [agent, run_date, pr] of [["impl-1", DAY, "101"], ["impl-1-b", LAST, ""]]) {
      w.features.push(pull({ ticket: "1", agent, chosen_cell: "slow-high", run_date }));
      w.members.push(member({ agent, ticket: "1", pr, cost: 1, effort: "high", subagentType: "fleet-implementer-slow-high" }));
    }
    w.tiers.push(...rows);
    w.prs.push({ number: 101, state: "MERGED" }, { number: 102, state: "MERGED" });
    const slow = computeReport(parsed(w)).cells.find((c) => c.cell === "slow-high");
    return { n_pulls: slow.n_pulls, n_merged: slow.n_merged, n_failed: slow.n_failed };
  };
  // The later row in the file predates the first Pull, so it rules nothing: the earlier row rules, and passes.
  assert.deepEqual(
    report([tier({ pr: "101", ticket: "1" }), tier({ pr: "102", ticket: "1", run_date: BEFORE, minted_false_claim: "yes" })]),
    { n_pulls: 2, n_merged: 1, n_failed: 0 });
  // Dated between the two Pulls: it rules the first, and the Pull dated after it stays unruled.
  assert.deepEqual(report([tier({ pr: "101", ticket: "1", run_date: MID, minted_false_claim: "yes" })]), { n_pulls: 2, n_merged: 1, n_failed: 1 });
});

test("a failing ruling followed by a both-blank row of the same ticket on a later PR is still the failure", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10, fail: true });
  w.tiers.push(tier({ pr: "102", ticket: "1", closed_own_ticket: "", minted_false_claim: "" }));
  w.prs.push({ number: 102, state: "MERGED" });
  const slow = computeReport(parsed(w)).cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_merged: slow.n_merged, n_failed: slow.n_failed }, { n_merged: 1, n_failed: 1 });
});

test("a ticket whose only tier row is both-blank reports exactly as a ticket with no tier row", () => {
  const unruled = (rows) => {
    const w = world();
    addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10 });
    w.tiers = rows;
    w.prs.push({ number: 102, state: "MERGED" });
    return computeReport(parsed(w));
  };
  const blank = unruled([tier({ pr: "102", ticket: "1", closed_own_ticket: "", minted_false_claim: "" })]);
  assert.deepEqual(blank, unruled([]));
  assert.equal(blank.cells.find((c) => c.cell === "slow-high").n_merged, 0);
});

test("a ruling of a Pulled ticket whose run_date is not YYYY-MM-DD is an input error naming tier-outcomes: exit 2, nothing on stdout, no guard file", () => {
  const w = world();
  const pulled = nextTicket;
  addCell(w, "slow-high", MIN_N, 0, 10);
  w.tiers.push(tier({ pr: "101", ticket: String(pulled), run_date: "2026-10-0x" }));
  const r = runCli(w);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tier-outcomes\.tsv: ticket #\d+ \(PR #101\): run_date is '2026-10-0x', expected YYYY-MM-DD/);
  assert.equal(r.stdout, "");
  assert.equal(r.guard, null);
});

test("a malformed run_date on a ticket with no Pull in the window is not refused", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  w.tiers.push(tier({ pr: "9", ticket: "7", run_date: "2026-10-0x" }));
  const r = runCli(w);
  assert.equal(r.status, 0);
  assert.ok(r.guard);
});

test("a bug raised while picking a ruling is a crash with its own stack, not an input error naming tier-outcomes", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  assert.equal(runCli(w).status, 0, "the same world runs clean without the injected fault");
  // A preload that makes `findLast`, which `rulingFor` calls, throw a TypeError.
  const r = runCli(w, ["--guard"], {
    at: (dir) => {
      const boom = join(dir, "boom.mjs");
      writeFileSync(boom, 'Array.prototype.findLast = () => { throw new TypeError("injected"); };\n');
      return { cwd: dir, args: ["--guard"], env: { NODE_OPTIONS: `--import=${boom}` } };
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TypeError: injected[\s\S]*at rulingFor/);
  assert.doesNotMatch(r.stderr, /tier-outcomes\.tsv: /);
  assert.equal(r.stdout, "");
  assert.equal(r.guard, null);
});

test("a Pull whose only implementer ran at another effort than its cell's level is excluded even when its subagent_type matches", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10 });
  w.members.at(-1).effort = "medium";
  const slow = computeReport(parsed(w)).cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_pulls: slow.n_pulls, n_merged: slow.n_merged, excluded: slow.excluded }, { n_pulls: 0, n_merged: 0, excluded: 1 });
});
