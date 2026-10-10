#!/usr/bin/env node
// Phase 0's stranded-claim step: which claims did the previous run leave
// without a PR, and which of them does this run resume? It lists and
// classifies; it acts on nothing — no dispatch, no label, no release. The
// controller dispatches off its answer.
//
// A claim's label and worktree exist before its first push. Rotation carries
// no ledger row forward, the candidate scan excludes `in-progress`, and the
// in-flight check reads the worktree as taken — so a claim a dead run left
// without a PR is held by nobody until this step names it. One with an open
// PR is not stranded: phase 0's fold-in queues every open PR, so it is never
// listed here.
//
// THE VERDICT is `prior` in the controller record, the one `ledger.mjs
// rotate` reached on the record it replaced — never a fresh judgement of the
// record itself, which names this run's own live controller and would read
// alive every time. A record that is absent, or a heartbeat file that cannot
// be read, is `none`.
//   dead      every open in-progress issue with no open PR: `resume` when
//             exactly one worktree for it sits under this checkout's
//             `.worktrees/` and its directory is there, `report` otherwise
//   ancestor  this session's earlier run: nothing listed — its members may
//             still be live, and the in-run liveness check covers them
//   none      nothing proves the previous run dead: every claim `report`
//
// "An open PR about the issue" is the in-flight check's own reading: a PR
// linked to the issue that is still open, a linked PR in another repository
// (whose state this repository's list cannot show, so it counts), or an open
// PR whose branch names the number as a whole segment. A worktree is the
// issue's when its directory name names the number the same way, so
// `.worktrees/129-…` is never #12's.
//
// Prints `{prior, claims: [{n, t, action, worktree, branch, why}]}` on stdout.
// Exit 0 answered; 2 a list that did not answer — a gh or git failure, or a
// list at its cap, which may hold more than it showed. Never read 2 as nothing
// stranded.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { makeDie, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { readState, stateFileIn } from "./fleet-state.mjs";

const NAME = "stranded";
const die = makeDie(NAME);
const LABEL = "in-progress";
const LIMIT = 1000;
const GH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 64 * 1024 * 1024;

const log = (line) => writeAll(2, `${line}\n`);
const segment = (n) => new RegExp(`(^|[/-])${n}([-/]|$)`);
// `owner/repo` of a github.com issue or PR URL.
const repoOf = (url) => String(url ?? "").split("/").slice(3, 5).join("/");

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  const said = String(r.stderr ?? "").trim().split("\n").at(-1);
  return said ? `exit ${r.status}: ${said}` : `exit ${r.status}`;
}

function ghList(what, args) {
  const r = spawnSync("gh", [...args, "--limit", String(LIMIT)], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, env: gitEnv(),
  });
  if (r.error || r.status !== 0) die(`gh ${args.slice(0, 2).join(" ")} failed (${how(r)}) — the ${what} is unknown, so nothing is classified`);
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (e) {
    die(`could not parse the ${what}: ${e.message}`);
  }
  if (!Array.isArray(rows)) die(`the ${what} is not a JSON array`);
  if (rows.length >= LIMIT) die(`the ${what} came back at its cap of ${LIMIT} — it may hold more than it showed, so nothing is classified`);
  return rows;
}

// Every registered worktree: its path, branch (null when detached) and
// whether git calls it prunable — its directory gone.
function worktrees(cwd) {
  const r = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, env: gitEnv(),
  });
  if (r.error || r.status !== 0) die(`git worktree list failed (${how(r)}) — which claims have a worktree is unknown`);
  const out = [];
  let cur = null;
  for (const field of r.stdout.split("\0")) {
    if (field === "") {
      cur = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      cur = { path: field.slice("worktree ".length), branch: null, prunable: false };
      out.push(cur);
    } else if (cur !== null && field.startsWith("branch refs/heads/")) {
      cur.branch = field.slice("branch refs/heads/".length);
    } else if (cur !== null && (field === "prunable" || field.startsWith("prunable "))) {
      cur.prunable = true;
    }
  }
  return out;
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function main() {
  if (process.argv.length > 2) die(`takes no arguments, got ${process.argv.slice(2).join(" ")}`);
  let fleetDir;
  try {
    fleetDir = fleetFile(null);
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    die(e.message);
  }
  const checkout = dirname(fleetDir);

  // readState() announces a file it could not use on stderr and returns no
  // record, which is `none`: unknown, so nothing is resumed.
  const { controller } = readState(stateFileIn(fleetDir), NAME);
  const prior = controller?.prior ?? "none";
  if (prior === "ancestor") {
    log(`${NAME}: the previous run is this session's own earlier run — its claims are left alone`);
    console.log(JSON.stringify({ prior, claims: [] }));
    return;
  }

  const issues = ghList(`list of open ${LABEL} issues`, [
    "issue", "list", "--label", LABEL, "--state", "open", "--json", "number,title,url,closedByPullRequestsReferences",
  ]);
  const prs = ghList("list of open PRs", ["pr", "list", "--state", "open", "--json", "number,headRefName,url"]);
  const openByUrl = new Map(prs.map((p) => [p.url, p]));

  // The PRs that make an issue someone else's business, or none.
  const prsFor = (issue) => {
    const here = repoOf(issue.url);
    const linked = (issue.closedByPullRequestsReferences ?? []).flatMap((ref) => {
      if (openByUrl.has(ref.url)) return [`open PR #${openByUrl.get(ref.url).number}`];
      const repo = repoOf(ref.url);
      return repo !== here ? [`linked PR ${repo}#${ref.url.split("/").at(-1)}, whose state this repository's list cannot show`] : [];
    });
    const seg = segment(issue.number);
    const named = prs.filter((p) => seg.test(p.headRefName ?? "")).map((p) => `open PR #${p.number} (branch ${p.headRefName})`);
    return [...linked, ...named];
  };

  const home = real(join(checkout, ".worktrees"));
  const all = worktrees(checkout);
  const claims = [];
  for (const issue of issues) {
    const held = prsFor(issue);
    if (held.length > 0) {
      log(`    #${issue.number} has ${held.join(", ")} — the fold-in owns it`);
      continue;
    }
    const seg = segment(issue.number);
    const mine = all.filter((w) => !w.prunable && seg.test(basename(w.path)) && existsSync(w.path));
    const inside = mine.filter((w) => real(dirname(w.path)) === home);
    const outside = mine.filter((w) => !inside.includes(w));
    const one = inside.length === 1 ? inside[0] : null;
    let why;
    if (prior !== "dead") why = "no record proves the previous run dead, so nothing is resumed";
    else if (one) why = "its worktree is in this checkout";
    else if (inside.length > 1) why = `several worktrees for it in this checkout: ${inside.map((w) => w.path).join(", ")}`;
    else if (outside.length > 0) why = `its worktree is outside this checkout's .worktrees/: ${outside.map((w) => w.path).join(", ")}`;
    else why = "no worktree for it in this checkout";
    const action = prior === "dead" && one ? "resume" : "report";
    claims.push({ n: issue.number, t: issue.title, action, worktree: one?.path ?? null, branch: one?.branch ?? null, why });
    log(`    #${issue.number} ${action} — ${why}`);
  }
  console.log(JSON.stringify({ prior, claims }));
}

main();
