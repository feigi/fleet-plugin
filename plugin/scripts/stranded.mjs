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
//             That worktree's branch is listed first, every PR state: every
//             one CLOSED unmerged — none OPEN, none MERGED — is `report` with
//             `why` `PR #<M> closed unmerged` — an unmerged close is the
//             maintainer's to rule on — and a list that does not answer, or a
//             detached worktree whose branch cannot be asked about, is
//             `report` too, never `resume`.
//   ancestor  this session's earlier run: no in-progress claim listed — its
//             members may still be live, and rotate carried their tokens
//             forward; `carried` lists them instead, for the controller to
//             reconcile against the session's job list
//   none      nothing proves the previous run dead: every in-progress claim
//             `report`
//
// A claim with no `in-progress` label is listed whatever `prior` says, for no
// member of it is live without one. Each implementer claim on the disk — a
// worktree `.worktrees/<N>-impl-<N>[-x]` or a local branch
// `implementer/<N>-impl-<N>[-x]` — whose issue is open, has no `in-progress`
// label and no open PR is `report`, never `resume`: a bail that left commits
// behind cannot release its claim, and nothing else names it once the run that
// made it is gone. Its `why` is the blockers of a read-only `release-ticket.sh
// <N> impl-<N>[-x] implementer` dry run, then the two ways out: push the
// branch and open a PR, or release the claim by hand. A dry run or an issue
// read that does not answer still lists the claim, naming why. Under
// `ancestor` an issue read that does not answer names neither way out: no
// in-progress list was read, so the claim may be the earlier run's live
// member — its `why` says to check it against `carried`. The disk and
// the issue are read at every run, so the claim is listed until it is pushed
// or released, whatever any ledger holds. A closed issue's claim is not listed.
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
const RELEASE_TIMEOUT_MS = 120_000;

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
// number when every one of them is CLOSED unmerged — none OPEN, none MERGED,
// at least one — else null; or `{failed}`, why the list did not answer. Never
// a refusal of the step: an unanswered list leaves this one claim unresumed,
// and the others classify.
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
  const closed = rows.length > 0 && rows.every((p) => p.state === "CLOSED");
  return { closed: closed ? Math.max(...rows.map((p) => p.number)) : null };
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

// A claim's names, off claim-ticket.sh's shapes for an implementer:
// `.worktrees/<N>-impl-<N>[-x]` and `implementer/<N>-impl-<N>[-x]`, `-x` a
// replacement's single retry letter. Each captures the number and the member
// name `impl-<N>[-x]`, the slug release-ticket.sh takes.
const CLAIM_WORKTREE = /^([1-9][0-9]*)-(impl-\1(?:-[a-z])?)$/;
const CLAIM_BRANCH = /^implementer\/([1-9][0-9]*)-(impl-\1(?:-[a-z])?)$/;
const WAYS_OUT = "push the branch and open a PR, or release the claim by hand";

// Every local branch under `implementer/`.
function implementerBranches(cwd) {
  const r = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/implementer/"], {
    cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, env: gitEnv(),
  });
  if (r.error || r.status !== 0) die(`git for-each-ref failed (${how(r)}) — which claims have a branch is unknown`);
  return r.stdout.split("\n").filter(Boolean);
}

// The implementer claims the disk holds, one per member name: its worktree
// under this checkout's `.worktrees/` and its local branch, each null when
// the disk holds none.
function diskClaims(all, home, branches) {
  const claims = new Map();
  const slot = (m) => {
    if (!claims.has(m[2])) claims.set(m[2], { n: Number(m[1]), slug: m[2], worktree: null, branch: null });
    return claims.get(m[2]);
  };
  for (const w of all) {
    const m = w.prunable ? null : CLAIM_WORKTREE.exec(basename(w.path));
    if (!m || !present(w.path) || real(dirname(w.path)) !== home) continue;
    const c = slot(m);
    c.worktree = w.path;
    c.branch = w.branch;
  }
  for (const b of branches) {
    const m = CLAIM_BRANCH.exec(b);
    if (!m) continue;
    const c = slot(m);
    c.branch ??= b;
  }
  return [...claims.values()].sort((a, b) => a.n - b.n || a.slug.localeCompare(b.slug));
}

// One issue, as `gh issue view` shows it: `{issue}`, or `{failed}` — why it
// did not answer. Per claim, like closedHeadPr: an unanswered view leaves this
// claim reported with the reason, and the others classify.
function viewIssue(n) {
  const r = spawnSync("gh", ["issue", "view", String(n), "--json", "number,title,url,state,labels,closedByPullRequestsReferences"], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }),
  });
  if (r.error || r.status !== 0) return { failed: how(r) };
  let v;
  try {
    v = JSON.parse(r.stdout);
  } catch (e) {
    return { failed: `unparsable: ${e.message}` };
  }
  const named = Array.isArray(v?.labels) && v.labels.every((l) => typeof l?.name === "string");
  if (v?.number !== n || typeof v.state !== "string" || typeof v.url !== "string" || !named) {
    return { failed: "not an issue with {number, state, url, labels}" };
  }
  return { issue: v };
}

// release-ticket.sh's dry run for a claim — it reads and changes nothing
// without `--apply`: `{blockers}`, what stands in the way of releasing it
// joined, empty when nothing does; or `{failed}`, why the dry run did not
// answer.
function releaseDryRun(cwd, n, slug) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "release-ticket.sh");
  const r = spawnSync("sh", [script, String(n), slug, "implementer"], {
    cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: RELEASE_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }),
  });
  let receipt = null;
  try {
    receipt = JSON.parse(r.stdout);
  } catch {
    // Not a receipt: a refusal before it could write one, in prose.
  }
  const blockers = receipt?.blockers;
  if (Array.isArray(blockers) && blockers.length > 0 && blockers.every((b) => typeof b === "string")) {
    return { blockers: blockers.join("; ") };
  }
  if (r.status === 0 && receipt?.released === true && Array.isArray(blockers)) return { blockers: "" };
  return { failed: how(r) };
}

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
  const ancestor = prior === "ancestor";
  if (ancestor) log(`${NAME}: the previous run is this session's own earlier run — its in-progress claims are left alone, and the live tokens rotate carried are listed`);

  // An ancestor's in-progress claims are not listed, so neither list is asked
  // for them: the open PR list waits for the first claim that needs it.
  const issues = ancestor ? [] : ghList(`list of open ${LABEL} issues`, [
    "issue", "list", "--label", LABEL, "--state", "open", "--json", "number,title,url,closedByPullRequestsReferences",
  ]);
  let openPrs = null;
  const open = () => {
    if (openPrs === null) {
      const prs = ghList("list of open PRs", ["pr", "list", "--state", "open", "--json", "number,headRefName,url"]);
      openPrs = { prs, openByUrl: new Map(prs.map((p) => [p.url, p])) };
    }
    return openPrs;
  };
  if (!ancestor) open();

  // The PRs that make an issue someone else's business, or none — and, apart,
  // the open PRs whose branch carries the number somewhere other than as the
  // ticket's own: `<type>/<n>-<slug>` is claim-ticket.sh's shape, so
  // `implementer/1799-bump-node-20` names issue 1799 and merely ends in 20.
  const prsFor = (issue, seg) => {
    const { prs, openByUrl } = open();
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
  const heldLog = (n, held) => log(`    #${n} has ${held.join(", ")} — the fold-in owns it`);
  const mentionedNote = (mentioned) => mentioned.length > 0
    ? `; ${mentioned.join(", ")} carries the number outside the ticket position, so check whether it is this claim's`
    : "";

  const home = real(join(checkout, ".worktrees"));
  const all = worktrees(checkout);
  const claims = [];
  for (const issue of issues) {
    const seg = segment(issue.number);
    const { held, mentioned } = prsFor(issue, seg);
    if (held.length > 0) {
      heldLog(issue.number, held);
      continue;
    }
    const mine = all.filter((w) => !w.prunable && seg.test(basename(w.path)) && present(w.path));
    const inside = mine.filter((w) => real(dirname(w.path)) === home);
    const outside = mine.filter((w) => !inside.includes(w));
    const one = inside.length === 1 ? inside[0] : null;
    // A dead claim's branch that opened a PR: every one CLOSED unmerged is
    // reported in place of the resume, and so is a branch whose PRs cannot be
    // listed — or cannot be asked about at all, its worktree detached. A
    // branch that never opened one resumes as before.
    const head = prior === "dead" && one?.branch ? closedHeadPr(one.branch) : null;
    let why;
    if (prior !== "dead") why = "no record proves the previous run dead, so nothing is resumed";
    else if (one && !one.branch) why = "its worktree is detached, so whether its branch opened a PR cannot be told — nothing is resumed";
    else if (head?.failed) why = `gh pr list --head ${one.branch} did not answer (${head.failed}) — whether its branch opened a PR is unknown, so nothing is resumed`;
    else if (head?.closed) why = `PR #${head.closed} closed unmerged`;
    else if (one) why = "its worktree is in this checkout";
    else if (inside.length > 1) why = `several worktrees for it in this checkout: ${inside.map((w) => w.path).join(", ")}`;
    else if (outside.length > 0) why = `its worktree is outside this checkout's .worktrees/: ${outside.map((w) => w.path).join(", ")}`;
    else why = "no worktree for it in this checkout";
    const action = prior === "dead" && one?.branch && mentioned.length === 0 && !head?.failed && !head?.closed ? "resume" : "report";
    // Not taken for its PR — but never resumed past one that might be.
    why += mentionedNote(mentioned);
    claims.push({ n: issue.number, t: issue.title, action, worktree: one?.path ?? null, branch: one?.branch ?? null, why });
    log(`    #${issue.number} ${action} — ${why}`);
  }

  // A claim no `in-progress` label holds live: its member is not running, so
  // `prior` has nothing to say of it. A bail that left commits behind strands
  // its claim this way, for release-ticket.sh refuses a branch ahead of
  // origin/main. Reported, never resumed — and read off the disk and the
  // issue at every run, so it is named until it is pushed or released.
  const views = new Map();
  const live = new Set(issues.map((i) => i.number));
  for (const c of diskClaims(all, home, implementerBranches(checkout))) {
    if (live.has(c.n)) continue;
    if (!views.has(c.n)) views.set(c.n, viewIssue(c.n));
    const { issue, failed } = views.get(c.n);
    let why;
    let mentioned = [];
    if (failed) {
      why = `gh issue view ${c.n} did not answer (${failed}) — whether ${c.slug}'s ticket is open, unlabelled and without a PR is unknown`;
      // No in-progress list is read under ancestor, so nothing has ruled out
      // that this is the earlier run's live member: never point at a release.
      if (ancestor) why += `, and so is whether ${c.slug} is the earlier run's live member — check it against carried`;
    } else {
      if (issue.state !== "OPEN") continue;
      if (issue.labels.some((l) => l.name === LABEL)) continue;
      const found = prsFor(issue, segment(c.n));
      if (found.held.length > 0) {
        heldLog(c.n, found.held);
        continue;
      }
      mentioned = found.mentioned;
      const probe = releaseDryRun(checkout, c.n, c.slug);
      if (probe.failed) why = `release-ticket.sh ${c.n} ${c.slug} implementer did not answer (${probe.failed}) — what stands in the way of releasing the claim is unknown`;
      else if (probe.blockers) why = probe.blockers;
      else why = "release-ticket.sh finds nothing in the way of releasing the claim";
    }
    if (!(failed && ancestor)) why += ` — ${WAYS_OUT}`;
    why += mentionedNote(mentioned);
    claims.push({ n: c.n, t: issue?.title ?? null, action: "report", worktree: c.worktree, branch: c.branch, why });
    log(`    #${c.n} report — ${why}`);
  }
  console.log(JSON.stringify({ prior, claims, carried: ancestor ? carriedTokens(join(fleetDir, "ledger.md")) : [] }));
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
