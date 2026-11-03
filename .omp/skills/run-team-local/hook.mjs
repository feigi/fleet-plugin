#!/usr/bin/env node
// fleet-plugin's own run-team-local hook: the duties this repository has
// after a /fleet-ctl:run-team run, none of which ship in the plugin. Nothing in
// the plugin calls it; this repository's AGENTS.md has the operator run it
// after a run. SKILL.md beside this file says what each duty does and how to
// read what it prints.
//
//   hook.mjs [--dry-run] [--repo <dir>] [--agents <dir>]
//            [--model-roles <json>] [--catalog <json>]
//
// One invocation runs every duty, in order: the role-target drift notice, then
// the router re-fit when it is due. Each is safe to run again.
//
//   --repo     the workspace whose `.fleet/` and `docs/metrics/` the duties
//              read and write; default the main checkout of the repository
//              the cwd is in
//   --agents   the `fleet-implementer-<cell>` definitions; default
//              <repo>/plugin/agents
//   --model-roles, --catalog
//              JSON files standing in for `omp config get modelRoles --json`
//              and `omp models --json`, which the drift notice reads otherwise
//   --dry-run  nothing is written to GitHub and nothing is pushed: the re-fit
//              PR is printed as `would …`. Every local duty still runs, the
//              fit itself inside a throwaway checkout
//
// Every plugin script this runs or imports is this checkout's own
// plugin/scripts. Exit 0 when every duty ran; 1 when one failed — named on
// stderr, and the duties after it did not run; 2 on a usage error.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "../../../plugin/scripts/arg.mjs";
import { gitEnv, mainCheckoutDirFromGitCommonDir } from "../../../plugin/scripts/git-env.mjs";
import { CELL } from "../../../plugin/scripts/ledger-grammar.mjs";
import { parseTsv as parseMemberTsv } from "../../../plugin/scripts/member-outcomes.mjs";
import {
  catalogEntry, modelsEqual, readOmpConfigValue, readOmpModelCatalog, resolveRole,
} from "../../../plugin/scripts/tier-roles.mjs";

const NAME = "run-team-local";
const SCRIPTS = fileURLToPath(new URL("../../../plugin/scripts/", import.meta.url));
const TABLE = join("plugin", "scripts", "router-table.json");
const GUARD = join(".fleet", "cost-guard.json");
const FIT_BRANCH = "chore/router-fit-";
const MAX_BUFFER = 64 * 1024 * 1024;

const say = (line) => process.stdout.write(`${NAME}: ${line}\n`);
const warn = (line) => process.stderr.write(`${NAME}: ${line}\n`);
const metrics = (repo, file) => readFileSync(join(repo, "docs", "metrics", file), "utf8");

function run(cmd, args, { cwd, what = `${cmd} ${args.slice(0, 2).join(" ")}`, ok = [0] } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: gitEnv(), maxBuffer: MAX_BUFFER });
  if (!ok.includes(r.status)) {
    throw new Error(`${what} failed (${r.error?.code ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`)}): ${String(r.stderr ?? "").trim()}`);
  }
  return r.stdout;
}
const git = (cwd, args) => run("git", ["-C", cwd, ...args], { what: `git ${args[0]}` });
const gh = (cwd, args) => run("gh", args, { cwd });
function ghJson(cwd, args) {
  const out = gh(cwd, args);
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} printed non-JSON (${e.message}): ${JSON.stringify(out.slice(0, 80))}`);
  }
}
const script = (name, args, cwd) => run(process.execPath, [join(SCRIPTS, name), ...args], { cwd, what: `${name} ${args[0]}` });

/** The `fleet-implementer-<cell>` definitions in `agentsDir`, sorted by cell. */
function definitions(agentsDir) {
  return readdirSync(agentsDir)
    .map((f) => /^fleet-implementer-(.+)\.agent\.md$/.exec(f)?.[1])
    .filter((cell) => cell && CELL.test(cell))
    .sort()
    .map((cell) => {
      const [, role, level] = CELL.exec(cell);
      return { cell, role, level };
    });
}

// ---------------------------------------------------------------------------
// duties
// ---------------------------------------------------------------------------

// tier-roles.mjs supplies each role's current target and stays blind to the
// metrics; the comparison with what a cell last ran lives here.
function driftNotice(repo, agentsDir, F) {
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  let modelRoles;
  let catalog;
  try {
    modelRoles = F.arg("model-roles") ? readJson(F.arg("model-roles")) : readOmpConfigValue("modelRoles");
    catalog = F.arg("catalog") ? readJson(F.arg("catalog")) : readOmpModelCatalog();
  } catch (e) {
    return warn(`drift notice: skipped — ${e.message}`);
  }
  const members = parseMemberTsv(metrics(repo, "member-outcomes.tsv"));
  let notices = 0;
  const notice = (text) => { notices++; process.stdout.write(`tier-roles: notice: ${text}\n`); };
  for (const d of definitions(agentsDir)) {
    const now = resolveRole(d.role, modelRoles);
    if (now === null) continue; // tier-roles.mjs --check stops the run on an unset role
    let last = null;
    for (const m of members) {
      if (m.subagentType !== `fleet-implementer-${d.cell}` || m.effort !== d.level || !m.model) continue;
      if (!last || m.run_date > last.run_date || (m.run_date === last.run_date && m.session > last.session)) last = m;
    }
    if (last && !modelsEqual(last.model, now)) {
      notice(`fleet-implementer-${d.cell} last ran ${last.model}; modelRoles.${d.role} now resolves ${now} — cell history spans two models`);
    }
    const entry = catalogEntry(now, catalog);
    if (entry && (entry.thinking === null || Array.isArray(entry.thinking)) && !(entry.thinking ?? []).includes(d.level)) {
      notice(`fleet-implementer-${d.cell} runs at ${d.level}; modelRoles.${d.role} now resolves ${now}, which does not run at ${d.level} (thinking: ${(entry.thinking ?? []).join(", ") || "none"})`);
    }
  }
  if (notices === 0) say("drift notice: every cell's last admissible row ran its role's current target, at a level that target runs");
}

function freeBranch(repo) {
  const base = `${FIT_BRANCH}${new Date().toISOString().slice(0, 10)}`;
  const taken = new Set([
    ...git(repo, ["ls-remote", "--heads", "origin", `${base}*`]).split("\n").map((l) => l.split("\trefs/heads/")[1]),
    ...git(repo, ["branch", "--list", `${base}*`, "--format=%(refname:short)"]).split("\n"),
  ].filter(Boolean));
  for (const suffix of ["", ..."bcdefghijklmnopqrstuvwxyz"]) if (!taken.has(`${base}${suffix}`)) return `${base}${suffix}`;
  throw new Error(`every ${base}<letter> branch is taken`);
}

// The PRs a Pull the fit reads has no complete record of, from pr-cost's guard
// file: each cell's newest generation's `no_ruling_prs` (merged, no Ruling) and
// `pending_prs` (still open, or missing from pr-cost's list), each once,
// ascending. `openPrs`, the numbers `gh` lists open, splits the pending ones:
// letting a PR merge or close clears only one that is still open.
// Older generations and Rulings given by hand block nothing.
function incompleteRecord(guard, openPrs) {
  const prs = (field) => [...new Set(guard.cells.flatMap((c) => {
    if (!Array.isArray(c[field])) throw new Error(`the cost guard's ${c.cell} entry has no \`${field}\` list`);
    return c[field];
  }))].sort((a, b) => Number(a) - Number(b));
  const pending = prs("pending_prs");
  return {
    noRuling: prs("no_ruling_prs"),
    open: pending.filter((p) => openPrs.has(String(p))),
    unlisted: pending.filter((p) => !openPrs.has(String(p))),
  };
}

// CI's `ticket-router.mjs --check` re-fits from the commit the table records,
// so the fit reads origin/main's own TSVs, in a throwaway checkout — never the
// working tree's freshly drained rows, which reach main through the run's
// artifacts PR and count at the next close-out. The cost guard it reads is the
// hook's own pr-cost.mjs run first over the throwaway checkout's TSVs — so its
// `retire` reads the hook's table, which nothing here uses: its exits 0, 3
// and 4 are guard verdicts, any other exit fails the duty, due or not. A re-fit
// is not opened while a Pull the fit reads has a merged PR with no Ruling, or a
// PR still open or missing from pr-cost's list.
function routerFit(repo, dryRun) {
  git(repo, ["fetch", "--quiet", "origin", "main"]);
  const tmp = mkdtempSync(join(tmpdir(), "run-team-local-fit-"));
  try {
    git(repo, ["worktree", "add", "--quiet", "--detach", tmp, "origin/main"]);
    const guardPath = join(tmp, GUARD);
    run(process.execPath, [join(SCRIPTS, "pr-cost.mjs"), "--json", "--guard", "--out", guardPath], { cwd: tmp, what: "pr-cost.mjs --json", ok: [0, 3, 4] });
    const guard = JSON.parse(readFileSync(guardPath, "utf8"));
    const table = join(tmp, TABLE);
    const corpus = (f) => join(tmp, "docs", "metrics", f);
    const args = ["--table", table, "--features", corpus("ticket-features.tsv"), "--members", corpus("member-outcomes.tsv"),
      "--verdicts", corpus("tier-outcomes.tsv"), "--guard", guardPath, "--commit", "origin/main"];
    const due = script("ticket-router.mjs", ["fit", ...args, "--due"], tmp).trim();
    if (!due.startsWith("DUE=yes ")) return say(`router fit: ${due} — not due`);
    const openPrs = ghJson(repo, ["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "1000"]);
    const open = openPrs.find((p) => String(p.headRefName).startsWith(FIT_BRANCH));
    if (open) return say(`router fit: ${due} — re-fit PR #${open.number} (${open.headRefName}) is still open`);
    const { noRuling, open: stillOpen, unlisted } = incompleteRecord(guard, new Set(openPrs.map((p) => String(p.number))));
    const list = (prs) => `PR ${prs.map((p) => `#${p}`).join(", ")}`;
    const parts = [
      noRuling.length ? `merged with no Ruling ${list(noRuling)} — run \`tier-outcomes.mjs append <pr>\` for each` : null,
      stillOpen.length ? `still open ${list(stillOpen)}` : null,
      unlisted.length ? `missing from pr-cost's list ${list(unlisted)}` : null,
    ].filter(Boolean);
    if (parts.length) return say(`router fit: ${due} — record incomplete, no re-fit: ${parts.join("; ")}`);
    // The fit prints its summary line, then one line per row: its cell and the
    // reason, then each candidate's verdict and range.
    const out = script("ticket-router.mjs", ["fit", ...args], tmp).trim();
    const [fitted, ...rows] = out.split("\n");
    const sayRows = () => { for (const r of rows) say(`router fit: ${r}`); };
    const branch = freeBranch(repo);
    if (dryRun) {
      say(`router fit: ${due} — ${fitted}; would open a chore PR from ${branch}`);
      return sayRows();
    }
    const subject = `chore: re-fit router-table.json at ${JSON.parse(readFileSync(table, "utf8")).fitted_commit.slice(0, 8)}`;
    let url;
    try {
      git(tmp, ["commit", "--quiet", "-m", subject, "--", TABLE]);
      // Pushed from the detached checkout, so the repository the hook runs in
      // keeps no local branch and no upstream config of this PR's.
      git(tmp, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
      // Labelled by `create` itself: a separate edit that failed would leave an
      // open unlabelled PR that every later run takes for the earlier re-fit.
      url = gh(tmp, ["pr", "create", "--base", "main", "--head", branch, "--label", "patch", "--title", subject,
        "--body", `Opened by the run-team-local hook (${due}).\n\n${out}\n`]).trim();
    } catch (e) {
      // A re-fit that never became a PR still leaves its summary and its rows in the log.
      say(`router fit: ${due} — ${fitted}; no PR opened from ${branch}`);
      sayRows();
      throw e;
    }
    say(`router fit: ${due} — ${fitted}; opened ${url} from ${branch}`);
    sayRows();
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", tmp], { env: gitEnv() });
    rmSync(tmp, { recursive: true, force: true });
    spawnSync("git", ["-C", repo, "worktree", "prune"], { env: gitEnv() });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, {
    flags: { "dry-run": "bool", repo: "value", agents: "value", "model-roles": "value", catalog: "value" },
  });
  F.sweep();
  F.stray();
  // Absolute: routerFit hands paths under it to a script running in another cwd.
  let repo = F.arg("repo") === null ? null : resolve(F.arg("repo"));
  if (repo === null) {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", env: gitEnv() });
    repo = r.status === 0 ? mainCheckoutDirFromGitCommonDir(r.stdout) : null;
    if (repo === null) die("the cwd is not in a git repository — pass --repo <dir>");
  }
  const agentsDir = F.arg("agents") ?? join(repo, "plugin", "agents");
  const dryRun = F.has("dry-run");

  const duties = [
    ["drift notice", () => driftNotice(repo, agentsDir, F)],
    ["router fit", () => routerFit(repo, dryRun)],
  ];
  for (const [name, duty] of duties) {
    try {
      duty();
    } catch (e) {
      warn(`${name} failed: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }
}

main();
