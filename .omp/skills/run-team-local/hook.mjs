#!/usr/bin/env node
// fleet-plugin's own run-team-local hook: the metrics duties this repository
// has at two fixed points of a /fleet-ctl:run-team run (the controller's call
// is #2089's; until it lands the hook is run by hand). SKILL.md beside this
// file says when each phase runs and how to read what it prints.
//
//   hook.mjs phase-0|close-out [--dry-run] [--repo <dir>] [--agents <dir>]
//            [--model-roles <json>] [--catalog <json>]
//
//   phase-0    drain the pending ticket-features rows, refresh the cost guard,
//              print the role-target drift notice
//   close-out  drain again, refresh the cost guard again, run the per-cell
//              stopping rule, run the router re-fit when it is due
//
//   --repo     the workspace whose `.fleet/` and `docs/metrics/` the duties
//              read and write; default the main checkout of the repository
//              the cwd is in, where the router appends its pending rows
//   --agents   the `fleet-implementer-<cell>` definitions; default
//              <repo>/plugin/agents
//   --model-roles, --catalog
//              JSON files standing in for `omp config get modelRoles --json`
//              and `omp models --json`, which the drift notice reads otherwise
//   --dry-run  nothing is written to GitHub and nothing is pushed: the
//              withdrawal issue and the re-fit PR are printed as `would …`.
//              Every local duty still runs — the drain, the guard, and the fit
//              itself, inside a throwaway checkout
//
// Every plugin script this runs or imports is this checkout's own
// plugin/scripts. Exit 0 when every duty ran; 1 when one failed — named on
// stderr, and the duties after it did not run (each is safe to run again);
// 2 on a usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "../../../plugin/scripts/arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "../../../plugin/scripts/git-env.mjs";
import { CELL } from "../../../plugin/scripts/ledger-grammar.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "../../../plugin/scripts/pr-cost.mjs";
import { stoppingRule } from "../../../plugin/scripts/cell-readout.mjs";
import { parseTsv as parseMemberTsv } from "../../../plugin/scripts/member-outcomes.mjs";
import { parseTierOutcomes } from "../../../plugin/scripts/tier-outcomes.mjs";
import {
  catalogEntry, modelsEqual, readOmpConfigValue, readOmpModelCatalog, resolveRole,
} from "../../../plugin/scripts/tier-roles.mjs";

const NAME = "run-team-local";
const SCRIPTS = fileURLToPath(new URL("../../../plugin/scripts/", import.meta.url));
const TABLE = join("plugin", "scripts", "router-table.json");
const PENDING = join(".fleet", "ticket-features.pending.tsv");
const FEATURES = join("docs", "metrics", "ticket-features.tsv");
const GUARD = join(".fleet", "cost-guard.json");
const FIT_BRANCH = "chore/router-fit-";
// pr-cost.mjs --guard: 0 no cell tripped, 3 a cell tripped, 4 no verdict yet —
// all three are verdicts its readers consume; anything else is a failure.
const GUARD_VERDICT_EXITS = new Set([0, 3, 4]);
const MAX_BUFFER = 64 * 1024 * 1024;

const say = (line) => process.stdout.write(`${NAME}: ${line}\n`);
const warn = (line) => process.stderr.write(`${NAME}: ${line}\n`);
const metrics = (repo, file) => readFileSync(join(repo, "docs", "metrics", file), "utf8");
const headerOf = (text) => String(text).split("\n").find((l) => l.trim() && !l.startsWith("#")).split("\t");
const pullKey = (r) => `${r.session}\0${r.agent}`;

function run(cmd, args, { cwd, what = `${cmd} ${args.slice(0, 2).join(" ")}` } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: gitEnv(), maxBuffer: MAX_BUFFER });
  if (r.status !== 0) {
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
      return { cell, role, level, file: `fleet-implementer-${cell}.agent.md` };
    });
}

// ---------------------------------------------------------------------------
// duties
// ---------------------------------------------------------------------------

// Rows the router appended at dispatch move into the tracked corpus, deduped
// on session + agent, and the pending file goes. A crash between the write and
// the unlink leaves rows the next drain finds already there.
function drain(repo) {
  const pending = join(repo, PENDING);
  if (!existsSync(pending)) return say(`drain: nothing pending in ${PENDING}`);
  const pendingText = readFileSync(pending, "utf8");
  const incoming = parseFeatures(pendingText);
  const target = join(repo, FEATURES);
  let text = existsSync(target) ? readFileSync(target, "utf8") : `${FEATURE_COLUMNS.join("\t")}\n`;
  const seen = new Set(parseFeatures(text).map(pullKey));
  const header = headerOf(text);
  const unknown = headerOf(pendingText).filter((c) => !header.includes(c));
  if (unknown.length) throw new Error(`${PENDING} carries ${unknown.join(", ")}, which ${FEATURES} has no column for`);
  const added = [];
  for (const r of incoming) {
    if (seen.has(pullKey(r))) continue;
    seen.add(pullKey(r));
    added.push(header.map((c) => r[c] ?? "").join("\t"));
  }
  if (added.length) {
    if (!text.endsWith("\n")) text += "\n";
    writeFileSync(`${target}.tmp`, `${text}${added.join("\n")}\n`);
    renameSync(`${target}.tmp`, target);
  }
  unlinkSync(pending);
  say(`drain: ${added.length} row${added.length === 1 ? "" : "s"} from ${PENDING} into ${FEATURES} (${incoming.length - added.length} already there)`);
}

function costGuard(repo) {
  const out = join(repo, GUARD);
  const r = spawnSync(process.execPath, [join(SCRIPTS, "pr-cost.mjs"), "--guard", "--out", out], {
    cwd: repo, encoding: "utf8", env: gitEnv(), maxBuffer: MAX_BUFFER,
  });
  if (!GUARD_VERDICT_EXITS.has(r.status)) {
    throw new Error(`pr-cost.mjs --guard exited ${r.error?.code ?? r.status ?? r.signal}: ${String(r.stderr ?? "").trim()}`);
  }
  const g = JSON.parse(readFileSync(out, "utf8"));
  const tripped = g.tripped.map((t) => (typeof t === "string" ? t : t?.cell));
  say(`cost guard: verdict ${g.verdict}${tripped.length ? ` (tripped: ${tripped.join(", ")})` : ""}, pr-cost.mjs exit ${r.status}; ${GUARD} computed ${g.computed_at}`);
}

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

function withdrawalBody(c) {
  const rows = c.verdicts.map((v) => `| #${v.ticket} | #${v.pr} | ${v.run_date} | ${v.closed_own_ticket} | ${v.minted_false_claim} | ${v.failed ? "fail" : "pass"} |`);
  return [
    `\`fleet-implementer-${c.cell}\` verdicts since its definition was last added (${c.since}): ${c.failures} of ${c.verdicts.length} fail the quality floor (\`minted_false_claim=yes\` or \`closed_own_ticket=no\`).`,
    "",
    "| ticket | PR | ruled | closed_own_ticket | minted_false_claim | floor |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function stopping(repo, agentsDir, dryRun) {
  const features = parseFeatures(metrics(repo, "ticket-features.tsv"));
  const members = parseMemberTsv(metrics(repo, "member-outcomes.tsv"));
  const verdicts = parseTierOutcomes(metrics(repo, "tier-outcomes.tsv"));
  // The day each definition was most recently added: a reinstated cell's
  // count restarts there. A definition no commit adds (a shallow clone, an
  // uncommitted or renamed file, the wrong --agents dir) has no day to count
  // from, so it cannot be judged.
  const added = {};
  const unjudged = [];
  for (const d of definitions(agentsDir)) {
    const day = git(agentsDir, ["log", "--diff-filter=A", "-1", "--format=%cs", "--", d.file]).trim();
    if (day) added[d.cell] = day;
    else unjudged.push(d.file);
  }
  for (const c of stoppingRule({ features, members, verdicts, added })) {
    const tally = `${c.cell} ${c.failures}/${c.verdicts.length} floor failures since ${c.since}`;
    if (!c.stop) {
      say(`stopping rule: ${tally} — continues`);
      continue;
    }
    // One open issue per cell: the tally in its title moves at every close-out,
    // so the match is on the cell's prefix, and the title is the idempotency
    // key — written last, after the comment carrying the new verdict table.
    const prefix = `Withdraw exploration cell ${c.cell}:`;
    const title = `${prefix} ${c.failures}/${c.verdicts.length} floor failures`;
    const open = ghJson(repo, ["issue", "list", "--state", "open", "--search", `"${prefix}" in:title`, "--json", "number,title", "--limit", "100"])
      .filter((i) => i.title.startsWith(prefix))
      .sort((a, b) => a.number - b.number);
    const dup = open.find((i) => i.title === title) ?? open[0];
    if (dup?.title === title) {
      say(`stopping rule: ${tally} — withdrawal issue already open, #${dup.number}`);
    } else if (dup && dryRun) {
      say(`stopping rule: ${tally} — would retitle withdrawal issue #${dup.number} from "${dup.title}" to "${title}" and comment the verdict table`);
    } else if (dup) {
      gh(repo, ["issue", "comment", String(dup.number), "--body", withdrawalBody(c)]);
      gh(repo, ["issue", "edit", String(dup.number), "--title", title]);
      say(`stopping rule: ${tally} — withdrawal issue #${dup.number} retitled from "${dup.title}", verdict table commented`);
    } else if (dryRun) {
      say(`stopping rule: ${tally} — would file "${title}" (ready-for-human)`);
    } else {
      const url = gh(repo, ["issue", "create", "--title", title, "--label", "ready-for-human", "--body", withdrawalBody(c)]).trim();
      say(`stopping rule: ${tally} — filed ${url}`);
    }
  }
  if (unjudged.length) throw new Error(`not judged — no commit adds ${unjudged.join(", ")}`);
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

// CI's `ticket-router.mjs --check` re-fits from the committed corpus, so the
// fit reads origin/main's own TSVs, in a throwaway checkout — never the
// working tree's freshly drained rows, which reach main through the run's
// artifacts PR and count at the next close-out.
function routerFit(repo, dryRun) {
  git(repo, ["fetch", "--quiet", "origin", "main"]);
  const tmp = mkdtempSync(join(tmpdir(), "run-team-local-fit-"));
  try {
    git(repo, ["worktree", "add", "--quiet", "--detach", tmp, "origin/main"]);
    const table = join(tmp, TABLE);
    const corpus = (f) => join(tmp, "docs", "metrics", f);
    const args = ["--table", table, "--features", corpus("ticket-features.tsv"), "--members", corpus("member-outcomes.tsv"),
      "--verdicts", corpus("tier-outcomes.tsv"), "--guard", join(repo, GUARD)];
    const due = script("ticket-router.mjs", ["fit", ...args, "--due"], tmp).trim();
    if (!due.startsWith("DUE=yes ")) return say(`router fit: ${due} — not due`);
    const open = ghJson(repo, ["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "1000"])
      .find((p) => String(p.headRefName).startsWith(FIT_BRANCH));
    if (open) return say(`router fit: ${due} — re-fit PR #${open.number} (${open.headRefName}) is still open`);
    const fitted = script("ticket-router.mjs", ["fit", ...args], tmp).trim();
    if (spawnSync("git", ["-C", tmp, "diff", "--quiet", "--", TABLE], { env: gitEnv() }).status === 0) {
      return say(`router fit: ${due} — ${fitted}; the table is unchanged, so there is nothing to open`);
    }
    const branch = freeBranch(repo);
    if (dryRun) return say(`router fit: ${due} — ${fitted}; would open a chore PR from ${branch}`);
    const subject = `chore: re-fit router-table.json through ${JSON.parse(readFileSync(table, "utf8")).fitted_through}`;
    git(tmp, ["commit", "--quiet", "-m", subject, "--", TABLE]);
    // Pushed from the detached checkout, so the repository the hook runs in
    // keeps no local branch and no upstream config of this PR's.
    git(tmp, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    // Labelled by `create` itself: a separate edit that failed would leave an
    // open unlabelled PR that every later run takes for the earlier re-fit.
    const url = gh(tmp, ["pr", "create", "--base", "main", "--head", branch, "--label", "patch", "--title", subject,
      "--body", `Opened by the run-team-local hook at close-out (${due}).\n\n${fitted}\n`]).trim();
    say(`router fit: ${due} — ${fitted}; opened ${url} from ${branch}`);
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
    positionals: ["phase-0", "close-out"],
  });
  F.sweep();
  F.stray();
  // The phase is the positional ahead of the flags, as the usage line spells
  // it: filtering every argv token would take a flag's value for it.
  const [, , phase] = process.argv;
  if (phase !== "phase-0" && phase !== "close-out") die("usage: hook.mjs phase-0|close-out [--dry-run] [--repo <dir>] [--agents <dir>] [--model-roles <json>] [--catalog <json>]");
  // Absolute: routerFit hands paths under it to a script running in another cwd.
  let repo = F.arg("repo") === null ? null : resolve(F.arg("repo"));
  if (repo === null) {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", env: gitEnv() });
    repo = r.status === 0 ? workspaceDirFromGitCommonDir(r.stdout) : null;
    if (repo === null) die("the cwd is not in a git repository — pass --repo <dir>");
  }
  const agentsDir = F.arg("agents") ?? join(repo, "plugin", "agents");
  const dryRun = F.has("dry-run");

  const duties = phase === "phase-0"
    ? [["drain", () => drain(repo)], ["cost guard", () => costGuard(repo)], ["drift notice", () => driftNotice(repo, agentsDir, F)]]
    : [["drain", () => drain(repo)], ["cost guard", () => costGuard(repo)], ["stopping rule", () => stopping(repo, agentsDir, dryRun)],
      ["router fit", () => routerFit(repo, dryRun)]];
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
