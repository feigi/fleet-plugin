#!/usr/bin/env node
// Phase 0's stranded-claim step: which claims did the previous run leave
// without a PR, and which of them does this run resume? It lists and
// classifies; it acts on nothing — no dispatch, no label, no release. The
// controller dispatches off its answer.
//
// A claim's label and worktree exist before its first push. Rotation after a
// dead or unknown run carries no ledger row forward, the candidate scan
// excludes `in-progress`, and the in-flight check reads the worktree as
// taken — so a claim a dead run left without a PR is held by nobody until
// this step names it. One with an open PR is not stranded: phase 0's fold-in
// queues every open PR, so it is never listed here.
//
// THE VERDICT is `prior` in the controller record, the one `ledger.mjs
// rotate` reached on the record it replaced — never a fresh judgement of the
// record itself, which names this run's own live controller and would read
// alive every time. A record that is absent, or a heartbeat file that cannot
// be read, is `none`.
//   dead      every open in-progress issue with no open PR: `resume` when
//             exactly one worktree for it sits under this checkout's
//             `.worktrees/` and its directory is there, `report` otherwise.
//             That worktree's branch is listed first, every PR state: one
//             CLOSED unmerged with none OPEN is `report` with `why` `PR #<M>
//             closed unmerged` — an unmerged close is the maintainer's to
//             rule on — and a list that does not answer is `report` too,
//             never `resume`.
//   ancestor  this session's earlier run: no claim listed — its members may
//             still be live, and rotate carried their tokens forward;
//             `carried` lists them instead, for the controller to reconcile
//             against the session's job list
//   none      nothing proves the previous run dead: every claim `report`
//
// "An open PR about the issue" is the in-flight check's reading, its branch rule
// narrowed: a PR linked to the issue that is still open, a linked PR in another
// repository (whose state this repository's list cannot show, so it counts), or
// an open PR whose branch opens with the number — `<type>/<n>-<slug>`,
// claim-ticket.sh's shape. A PR that carries the number elsewhere in its branch
// is not taken for the claim's: the claim is listed `report`, never resumed,
// with that PR named. A worktree is the issue's when its directory name names
// the number as a whole segment, so a worktree named for issue 129 is never
// issue 12's.
//
// Prints `{prior, claims: [{n, t, action, worktree, branch, why}], carried:
// [{name, token, row}]}` on stdout. `carried` is empty unless prior is
// `ancestor`; each entry is the member or runner name (a workflow launch's
// runId), the token as the ledger holds it, and the key of the first row
// carrying it — null for a member only `## Dispatched` names. It is every
// live token on the ledger: at phase 0 this run has dispatched nothing yet,
// so each is one rotate carried.
// Exit 0 answered; 2 a list that did not answer — a gh or git failure, a
// list at its cap, which may hold more than it showed, a worktree path
// whose presence cannot be told, or a ledger that cannot be read. Never read
// 2 as nothing stranded.

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { readState, stateFileIn } from "./fleet-state.mjs";
import { liveOnLedger } from "./ledger-grammar.mjs";

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

// gh resolves its repository from GH_REPO, then the cwd's git remotes: either
// one ambient would list another repository's tracker.
function ghList(what, args) {
  const r = spawnSync("gh", [...args, "--limit", String(LIMIT)], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }),
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

// The PRs a claim's branch opened, every state: `{closed}`, the highest PR
// number among those CLOSED unmerged when none is OPEN, else null; or
// `{failed}`, why the list did not answer. Never a refusal of the step: an
// unanswered list leaves this one claim unresumed, and the others classify.
function closedHeadPr(branch) {
  const r = spawnSync("gh", ["pr", "list", "--state", "all", "--head", branch, "--json", "number,state", "--limit", String(LIMIT)], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }),
  });
  if (r.error || r.status !== 0) return { failed: how(r) };
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (e) {
    return { failed: `unparsable: ${e.message}` };
  }
  if (!Array.isArray(rows) || !rows.every((p) => Number.isInteger(p?.number) && ["OPEN", "CLOSED", "MERGED"].includes(p.state))) {
    return { failed: "not a list of {number, state}" };
  }
  if (rows.length >= LIMIT) return { failed: `at its cap of ${LIMIT}` };
  const closed = rows.filter((p) => p.state === "CLOSED").map((p) => p.number);
  return { closed: closed.length > 0 && !rows.some((p) => p.state === "OPEN") ? Math.max(...closed) : null };
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

// Whether `p` is on disk. Only ENOENT is gone: any other failure (EACCES on a
// parent of a worktree git still lists, a locked one whose directory is gone)
// leaves it unknown, and unknown is never read as gone — that would report the
// claim as one with no worktree and say nothing of why.
function present(p) {
  try {
    statSync(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    return die(`cannot tell whether ${p} exists (${e.code ?? e.message}) — which claims have a worktree is unknown, so nothing is classified`);
  }
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch (e) {
    if (e.code === "ENOENT") return p;
    return die(`cannot resolve ${p} (${e.code ?? e.message}) — which worktrees are in this checkout is unknown, so nothing is classified`);
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
    log(`${NAME}: the previous run is this session's own earlier run — its claims are left alone, and the live tokens rotate carried are listed`);
    console.log(JSON.stringify({ prior, claims: [], carried: carriedTokens(join(fleetDir, "ledger.md")) }));
    return;
  }

  const issues = ghList(`list of open ${LABEL} issues`, [
    "issue", "list", "--label", LABEL, "--state", "open", "--json", "number,title,url,closedByPullRequestsReferences",
  ]);
  const prs = ghList("list of open PRs", ["pr", "list", "--state", "open", "--json", "number,headRefName,url"]);
  const openByUrl = new Map(prs.map((p) => [p.url, p]));

  // The PRs that make an issue someone else's business, or none — and, apart,
  // the open PRs whose branch carries the number somewhere other than as the
  // ticket's own: `<type>/<n>-<slug>` is claim-ticket.sh's shape, so
  // `implementer/1799-bump-node-20` names issue 1799 and merely ends in 20.
  const prsFor = (issue, seg) => {
    const here = repoOf(issue.url);
    const linked = (issue.closedByPullRequestsReferences ?? []).flatMap((ref) => {
      if (openByUrl.has(ref.url)) return [`open PR #${openByUrl.get(ref.url).number}`];
      const repo = repoOf(ref.url);
      return repo !== here ? [`linked PR ${repo}#${ref.url.split("/").at(-1)}, whose state this repository's list cannot show`] : [];
    });
    const own = new RegExp(`^([^/]*/)?${issue.number}([-/]|$)`);
    const named = prs.filter((p) => seg.test(p.headRefName ?? ""));
    const describe = (p) => `open PR #${p.number} (branch ${p.headRefName})`;
    return {
      held: [...linked, ...named.filter((p) => own.test(p.headRefName)).map(describe)],
      mentioned: named.filter((p) => !own.test(p.headRefName)).map(describe),
    };
  };

  const home = real(join(checkout, ".worktrees"));
  const all = worktrees(checkout);
  const claims = [];
  for (const issue of issues) {
    const seg = segment(issue.number);
    const { held, mentioned } = prsFor(issue, seg);
    if (held.length > 0) {
      log(`    #${issue.number} has ${held.join(", ")} — the fold-in owns it`);
      continue;
    }
    const mine = all.filter((w) => !w.prunable && seg.test(basename(w.path)) && present(w.path));
    const inside = mine.filter((w) => real(dirname(w.path)) === home);
    const outside = mine.filter((w) => !inside.includes(w));
    const one = inside.length === 1 ? inside[0] : null;
    let why;
    if (prior !== "dead") why = "no record proves the previous run dead, so nothing is resumed";
    else if (one) why = "its worktree is in this checkout";
    else if (inside.length > 1) why = `several worktrees for it in this checkout: ${inside.map((w) => w.path).join(", ")}`;
    else if (outside.length > 0) why = `its worktree is outside this checkout's .worktrees/: ${outside.map((w) => w.path).join(", ")}`;
    else why = "no worktree for it in this checkout";
    // A dead claim's branch that opened a PR: one CLOSED unmerged, with none
    // OPEN, is reported in place of the resume, and so is a branch whose PRs
    // cannot be listed. A branch that never opened one resumes as before.
    const head = prior === "dead" && one?.branch ? closedHeadPr(one.branch) : null;
    if (head?.failed) why = `gh pr list --head ${one.branch} did not answer (${head.failed}) — whether its branch opened a PR is unknown, so nothing is resumed`;
    else if (head?.closed) why = `PR #${head.closed} closed unmerged`;
    const action = prior === "dead" && one && mentioned.length === 0 && !head?.failed && !head?.closed ? "resume" : "report";
    // Not taken for its PR — but never resumed past one that might be.
    if (mentioned.length > 0) why += `; ${mentioned.join(", ")} carries the number outside the ticket position, so check whether it is this claim's`;
    claims.push({ n: issue.number, t: issue.title, action, worktree: one?.path ?? null, branch: one?.branch ?? null, why });
    log(`    #${issue.number} ${action} — ${why}`);
  }
  console.log(JSON.stringify({ prior, claims, carried: [] }));
}

// Every live token on the ledger, read through `ledger.mjs read` so the
// ledger keeps one parser. A read that fails is a list that did not answer.
function carriedTokens(file) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "ledger.mjs");
  // `--file` names the ledger outright, so the read resolves no workspace
  // and runs no git.
  const r = spawnSync(process.execPath, [script, "--file", file, "read"], { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0) die(`ledger.mjs read failed (${how(r)}) — which tokens rotate carried is unknown`);
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch (e) {
    die(`could not parse ledger.mjs read output: ${e.message}`);
  }
  const strings = (xs) => Array.isArray(xs) && xs.every((x) => typeof x === "string");
  if (!d || !strings(d.rows) || !strings(d.dispatched)) die("ledger.mjs read returned no {rows, dispatched}");
  return liveOnLedger(d.rows, d.dispatched).tokens;
}

main();
