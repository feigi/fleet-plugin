#!/usr/bin/env node
// fleet-plugin's own run-team-local hook: the duties this repository has
// after a /fleet-ctl:run-team run, none of which ship in the plugin. Nothing in
// the plugin calls it; this repository's AGENTS.md has the operator run it
// after a run. SKILL.md beside this file says what each duty does and how to
// read what it prints.
//
//   hook.mjs [--repo <dir>] [--agents <dir>]
//            [--model-roles <json>] [--catalog <json>]
//
// One invocation runs every duty: the role-target drift notice. It is safe to
// run again.
//
//   --repo     the workspace whose `docs/metrics/` the duty reads; default the
//              main checkout of the repository the cwd is in
//   --agents   the `fleet-implementer-<cell>` definitions; default
//              <repo>/plugin/agents
//   --model-roles, --catalog
//              JSON files standing in for `omp config get modelRoles --json`
//              and `omp models --json`, which the drift notice reads otherwise
//
// Every plugin script this imports is this checkout's own plugin/scripts.
// Exit 0 when every duty ran; 1 when one failed — named on stderr; 2 on a
// usage error.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeDie, defineFlags } from "../../../plugin/scripts/arg.mjs";
import { gitEnv, mainCheckoutDirFromGitCommonDir } from "../../../plugin/scripts/git-env.mjs";
import { CELL } from "../../../plugin/scripts/ledger-grammar.mjs";
import { parseTsv as parseMemberTsv } from "../../../plugin/scripts/member-outcomes.mjs";
import {
  catalogEntry, modelsEqual, readOmpConfigValue, readOmpModelCatalog, resolveRole,
} from "../../../plugin/scripts/tier-roles.mjs";

const NAME = "run-team-local";

const say = (line) => process.stdout.write(`${NAME}: ${line}\n`);
const warn = (line) => process.stderr.write(`${NAME}: ${line}\n`);
const metrics = (repo, file) => readFileSync(join(repo, "docs", "metrics", file), "utf8");

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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, {
    flags: { repo: "value", agents: "value", "model-roles": "value", catalog: "value" },
  });
  F.sweep();
  F.stray();
  let repo = F.arg("repo") === null ? null : resolve(F.arg("repo"));
  if (repo === null) {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", env: gitEnv() });
    repo = r.status === 0 ? mainCheckoutDirFromGitCommonDir(r.stdout) : null;
    if (repo === null) die("the cwd is not in a git repository — pass --repo <dir>");
  }
  const agentsDir = F.arg("agents") ?? join(repo, "plugin", "agents");

  try {
    driftNotice(repo, agentsDir, F);
  } catch (e) {
    warn(`drift notice failed: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
