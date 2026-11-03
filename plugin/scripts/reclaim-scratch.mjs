#!/usr/bin/env node
// Reclaim: remove what a run left under its scratch root once nothing can
// still want it. Distinct from Reap, which authorizes on git's evidence, and
// from Release, which undoes a claim that never became a PR: Reclaim
// authorizes on GitHub state and on age.
//
//   reclaim-scratch.mjs --root <abs> [--after-rotate] [--apply]
//   reclaim-scratch.mjs --pr <N> --root <abs> [--apply]
//   reclaim-scratch.mjs --siblings --root <abs> [--apply]
//
// Dry run by default; `--apply` removes. `--root` is required, an absolute
// path to an existing directory, and the root sweep and `--siblings` require
// it to be this workspace's own scratch root (the path scratch-root.mjs
// prints, computed from the cwd): the controller passes that path. Both
// refuse any other, dry run included, before reading anything under it;
// `--pr` mode reads no ledger and asks GitHub nothing, and does not check it.
//
// The root sweep reads the ledger, the claim worktrees and GitHub of the
// repository the cwd is in, so another workspace's key judged there would be
// judged against this one's numbers.
//
// `--siblings` is the sibling pass, its own invocation: `--root` names the
// live key, and the pass judges the other key-shaped directories beside it
// (judgeSiblings below) by the checkout each records and by age, judging each
// again just before `--apply` removes it. Under `--apply` it first writes the
// live key's own `checkout-path`, and only that. Any other key passed as
// `--root` would put the real live key among the judged siblings. It reads no
// ledger, asks GitHub nothing, and is never combined with --pr or
// --after-rotate.
//
// THE ROOT SWEEP judges every entry directly under `--root`:
//   pr<M>/, dispositions-fix-pr-<M>[-x].json
//            removed when PR #M is MERGED or CLOSED on GitHub and no live
//            ledger token names it — review-pr-<M>[-x], fix-pr-<M>[-x],
//            finisher-pr-<M>[-x]. A live merge-bot-<n> token holds every one
//            of them: a bot's token names no PR, and GitHub reads MERGED
//            while the bot is still writing under pr<M>/merge-bot-<n>/. An
//            OPEN PR's pr<M>/ is kept whole except its run-* roots, which
//            follow the --pr rule below. A MERGED PR's entry that holds
//            review evidence — a `<run>/review.json` under pr<M>/, or a
//            Charges file naming its run — is also kept until origin/main
//            holds every file of it where run-records.mjs's reviewTargets()
//            puts it, under docs/metrics/reviews/<M>/: the Close-out PR
//            carries it there. `git ls-tree origin/main` in the checkout the
//            ledger sits in answers that, once per sweep; a lookup that fails,
//            or evidence that cannot be read, keeps the entry with that
//            reason. A CLOSED PR gets no Ruling, and its entries keep the
//            rule above.
//   impl-<N>/
//            removed when issue #N is CLOSED, or OPEN with no live
//            impl-<N>[-x] token, no claim worktree standing, and idle past
//            the retention, so a bailed or released ticket's partition is not
//            inherited by its next claim. A claim worktree stands when a
//            worktree directly under this checkout's .worktrees/ names N as a
//            whole segment of its directory name and that directory is there:
//            an OPEN ticket's partition is kept while one stands, however idle.
//            A claim worktree that cannot be checked — `git worktree list`
//            failing, a .worktrees/ that cannot be read, or a directory there
//            named for N that git does not list — keeps it, with that reason.
//   reports/<member>.json, reports/<member>.check.json
//            a member's report file, and the Check-step record written beside
//            it. `reports/` itself is never removed, and is not aged out
//            whole: each file is judged on its own, by the entry it goes
//            with. A fix-pr-<M>[-x], finisher-pr-<M>[-x] or review-pr-<M>[-x]
//            report goes with pr<M>/ — the same verdict, the same live-token
//            holds, though no pr<M>/ need exist; an impl-<N>[-x] report goes
//            with impl-<N>/ the same way; the <member>.check.json record is
//            judged exactly as <member>.json is (one `.check` infix only:
//            <member>.check.check.json and <member>.checkx.json are "anything
//            else"); any other file in it (a merge-bot-<n> report or record,
//            which names no PR and no ticket) is judged as "anything else"
//            below, so it is removed only when idle past the retention and
//            its member's token is not live.
//   anything else, and a keyed name whose number GitHub resolves to the
//   other type (a pr<N> that is an issue, an impl-<N> that is a PR) or to
//   nothing
//            removed when idle past the retention and no live token's name
//            appears in the entry's name.
//   checkout-path
//            never judged: the sibling pass's record of the checkout the key
//            belongs to, neither removed nor listed.
// "Idle past the retention" is the newest mtime ANYWHERE under the entry
// older than 7 days — never the top-level mtime alone, which a write deep
// inside does not move. A directory that cannot be listed or searched counts
// its own mtime and is not descended into.
//
// The live tokens are `.fleet/ledger.md`'s, read through `ledger.mjs read`
// and ledger-grammar.mjs's liveOnLedger(), the file resolved by
// fleet-dir.mjs's fleetFile() from the cwd. An absent ledger REFUSES the root
// sweep, because nothing could then hold a live member's entry — unless
// `--after-rotate` is given: phase 0's rotate leaves no ledger behind when it
// carried nothing, so there an absent file is read as "no live token", which
// is rotate's own verdict. A ledger that is present is read as usual under
// either; only ENOENT is absence, and any other failure to read it refuses.
//
// GitHub is asked once per ≤100 numbers (`gh api graphql`, one aliased
// issueOrPullRequest per number, pr<N> and impl-<N> together). A number with
// no usable answer — a failed lookup, a partial failure included — keeps every
// keyed entry that names it, with that reason; the age rule still runs on
// unkeyed entries. A keyed entry is never judged by the ledger or by mtime
// alone in GitHub's place.
//
// `--pr <N>` MODE is the review snapshot's prune: every directory
// `<root>/pr<N>/run-*` idle past the retention is removed, and nothing else
// is looked at — no ledger, no gh (a live review's own run root is seconds
// old), no sibling under pr<N>/.
//
// EVERY REMOVAL, in either mode, goes through REMOVE below: owner rwx
// restored, darwin's user-immutable and append-only flags cleared where
// `chflags` exists, then `rm -rf` — so a fixture that dropped its own read bit
// or flagged a file cannot wedge it. Removal is best-effort per entry: a
// failure lands in `failed[]` and the sweep continues.
//
// Prints ONE JSON line on stdout once the sweep is done:
//   {"applied":<bool>,"ledger":<abs path|null>,"removed":[{"path","reason"}],
//    "kept":[{"path","reason"}],"failed":[{"path","error"}]}
// The sibling pass's kept entries also carry "idle": true when nothing under
// the key was found modified within the retention, false otherwise.
// `ledger` is the file read, or null when none was (`--pr` mode, or
// `--after-rotate` with no file) — so "never read" stays distinct from "read
// and found empty". A dry run prints the same receipt with "applied":false,
// `removed` naming what --apply would remove.
// Exit 0 whenever the receipt is printed, failures included; 2 for a refused
// invocation — bad arguments, no --root, a root that is not a directory, a
// root sweep or sibling pass whose --root is not this workspace's own scratch
// root or whose own scratch root cannot be resolved, a root sweep with no
// ledger and no --after-rotate, a ledger that cannot be read for any reason
// other than ENOENT. Nothing is removed before a refusal.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlags, isDigits, makeDie, writeAll } from "./arg.mjs";
import { fleetFile, FleetDirUnresolvable, SCRATCH_KEY_SHAPE, scratchRoot } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { ghAliasedRead, how } from "./gh-aliased-read.mjs";
import { isCLI } from "./is-cli.mjs";
import { liveOnLedger, parseMember, REVIEWER } from "./ledger-grammar.mjs";
import { REVIEWS_DIR, reviewTargets } from "./run-records.mjs";

const NAME = "reclaim-scratch";
// The file at a key's top level naming the checkout the key's hash is taken
// over: one line, an absolute path.
export const CHECKOUT_FILE = "checkout-path";
const die = makeDie(NAME);
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 7 * DAY_MS;
const GH_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The one removal sequence. `$1` is the entry. A symlink entry is unlinked
// before anything else runs, so no chmod or chflags ever sees it: whether a
// recursive chmod dereferences a link given as its operand differs between
// BSD and GNU, and either would change the mode or flags of a target outside
// the entry being removed. Links met inside a directory are left to `rm`,
// which unlinks them without following. `chmod -R` fails
// on a flagged directory, and `chflags -R` cannot read a mode-000 directory it
// has just unflagged, so when the first pass fails each directory's flag and
// mode come off together, top-down, before anything inside it is read.
const REMOVE = [
  'd=$1',
  'if [ -L "$d" ]; then rm -f "$d"; exit $?; fi',
  'chmod -R u+rwx "$d" 2>/dev/null; m=$?',
  'if command -v chflags >/dev/null 2>&1; then',
  '  [ $m -eq 0 ] || { chflags nouchg,nouappnd "$d"; chmod u+rwx "$d"; find "$d" -type d -exec chflags nouchg,nouappnd {} ";" -exec chmod u+rwx {} ";"; } 2>/dev/null',
  '  chflags -R nouchg,nouappnd "$d" 2>/dev/null',
  'fi',
  'rm -rf "$d"',
].join("\n");

const PR_ENTRY = /^pr([1-9][0-9]*)$/;
const IMPL_ENTRY = /^impl-([1-9][0-9]*)$/;
const DISPOSITIONS_ENTRY = /^dispositions-fix-pr-([1-9][0-9]*)(?:-[a-z])?\.json$/;
// A member's report file, `reports/<member>.json`, and its Check-step record,
// `reports/<member>.check.json`: one that names a PR goes with that PR's
// entries, one that names a ticket with that ticket's.
const REPORTS_DIR = "reports";
const REPORT_PR_ENTRY = /^(?:fix-pr|finisher-pr|review-pr)-([1-9][0-9]*)(?:-[a-z])?(?:\.check)?\.json$/;
const REPORT_IMPL_ENTRY = /^impl-([1-9][0-9]*)(?:-[a-z])?(?:\.check)?\.json$/;
const RUN_ROOT = /^run-/;

/** The path of something under `path` (itself included) modified at or after
 * `cutoff`, or null when everything is older. Symlinks are not followed. A
 * directory that cannot be listed counts its own mtime only, and so does one
 * that can be listed but not searched: an entry inside it whose lstat is
 * refused is skipped, its parent's mtime already counted. Given `unreadable`,
 * an array, each path skipped for EACCES or EPERM is pushed onto it as
 * `<path>: <code>`. */
export function freshUnder(path, cutoff, unreadable = null) {
  const stack = [path];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") unreadable?.push(`${p}: ${e.code}`);
      if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EPERM") continue;
      throw e;
    }
    if (st.mtimeMs >= cutoff) return p;
    if (!st.isDirectory()) continue;
    let names;
    try {
      names = readdirSync(p);
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") unreadable?.push(`${p}: ${e.code}`);
      if (e.code === "EACCES" || e.code === "EPERM" || e.code === "ENOENT") continue;
      throw e;
    }
    for (const n of names) stack.push(join(p, n));
  }
  return null;
}

/** Remove `path` through REMOVE; null on success, else the reason. */
export function removeEntry(path) {
  const r = spawnSync("sh", ["-c", REMOVE, "sh", path], { encoding: "utf8" });
  return r.error || r.status !== 0 ? how(r) : null;
}

// The ledger's rows and `## Dispatched` entries, read through `ledger.mjs
// read` so the ledger keeps one parser. `--file` names it outright, so the read
// resolves no workspace and runs no git. `die` is the caller's, and `undone`
// names what a refusal leaves undone ("reclaimed", "evicted"): evict.mjs reads
// the ledger this same way.
export function readLedger(file, die, undone) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "ledger.mjs");
  const r = spawnSync(process.execPath, [script, "--file", file, "read"], { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0) die(`ledger.mjs read ${file} failed (${how(r)}) — which members are live is unknown, so nothing is ${undone}`);
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch (e) {
    die(`could not parse ledger.mjs read output: ${e.message}`);
  }
  const strings = (xs) => Array.isArray(xs) && xs.every((x) => typeof x === "string");
  if (!d || !strings(d.rows) || !strings(d.dispatched)) die("ledger.mjs read returned no {rows, dispatched}");
  return { rows: d.rows, dispatched: d.dispatched };
}

// The live tokens the ledger holds, by name.
function liveNames(file) {
  const { rows, dispatched } = readLedger(file, die, "reclaimed");
  return liveOnLedger(rows, dispatched).tokens.map((t) => t.name);
}

// The checkout the fleet dir sits in, and its ledger file — `file` null when it
// is absent. Only ENOENT is absence; a workspace that cannot be resolved, or a
// path that cannot be looked up, refuses through the caller's `die`. `lstat`,
// so a dangling symlink is a ledger that cannot be read.
export function ledgerFile(die) {
  let dir;
  try {
    dir = fleetFile(null);
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    die(`${e.message} — the ledger cannot be found, so which members are live is unknown`);
  }
  const file = join(dir, "ledger.md");
  try {
    lstatSync(file);
    return { checkout: dirname(dir), file };
  } catch (e) {
    if (e.code === "ENOENT") return { checkout: dirname(dir), file: null };
    die(`could not look for the ledger ${file}: ${e.message}`);
  }
}

// The linked worktrees under `checkout`'s `.worktrees/`, read the way
// stranded.mjs reads them. `paths` is every path git lists; `home` is that
// directory's realpath, or null when it does not exist, so no worktree sits
// inside it. `{unknown}` when git's registry cannot be read or the directory
// cannot be resolved; what stands inside it is read in claimWorktree(). An
// unknown is never read as no worktree.
function worktreeListing(checkout) {
  const r = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: checkout, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, env: gitEnv(),
  });
  if (r.error || r.status !== 0) return { unknown: `git worktree list failed (${how(r)})` };
  const paths = r.stdout.split("\0").filter((f) => f.startsWith("worktree ")).map((f) => f.slice("worktree ".length));
  const dir = join(checkout, ".worktrees");
  try {
    return { paths, home: realpathSync(dir) };
  } catch (e) {
    if (e.code === "ENOENT") return { paths, home: null };
    return { unknown: `cannot resolve ${dir} (${e.code ?? e.message})` };
  }
}

// The paths origin/main holds under REVIEWS_DIR, as `{paths}`, or `{unknown}`
// naming why the checkout could not say. A missing origin/main is an unknown.
function evidenceOnMain(checkout) {
  const r = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "origin/main", "--", `${REVIEWS_DIR}/`], {
    cwd: checkout, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, env: gitEnv(),
  });
  if (r.error || r.status !== 0) return { unknown: `git ls-tree origin/main -- ${REVIEWS_DIR}/ failed (${how(r)})` };
  return { paths: new Set(r.stdout.split("\0").filter(Boolean)) };
}

// Whether a claim worktree stands for issue `n`: a listed worktree directly under
// `.worktrees/` whose directory name names `n` as a whole segment, and whose
// directory is still there. `{stands}` is true or false; `{unknown}`
// when a candidate's presence cannot be told. A registration whose directory is
// gone stands for nothing. A directory under `.worktrees/` named for `n` that git
// does not list is an unknown, never none: git drops a worktree whose
// registration it cannot read — an unreadable `.git/worktrees/`, an empty
// `gitdir` file — from the list and still exits 0. The segment rule is
// stranded.mjs's, for a claim's own worktree.
function claimWorktree(listing, n) {
  if (listing.unknown !== undefined) return { unknown: listing.unknown };
  if (listing.home === null) return { stands: false };
  const named = new RegExp(`(^|[/-])${n}([-/]|$)`);
  for (const p of listing.paths) {
    if (!named.test(basename(p))) continue;
    try {
      if (realpathSync(dirname(p)) !== listing.home) continue;
    } catch (e) {
      if (e.code === "ENOENT") continue;
      return { unknown: `cannot resolve ${dirname(p)} (${e.code ?? e.message})` };
    }
    try {
      statSync(p);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      return { unknown: `cannot tell whether ${p} exists (${e.code ?? e.message})` };
    }
    return { stands: true };
  }
  let names;
  try {
    names = readdirSync(listing.home);
  } catch (e) {
    if (e.code === "ENOENT") return { stands: false };
    return { unknown: `cannot read ${listing.home} (${e.code ?? e.message})` };
  }
  const unlisted = names.find((name) => named.test(name));
  if (unlisted !== undefined) return { unknown: `${join(listing.home, unlisted)} is there but git does not list it as a worktree` };
  return { stands: false };
}

// `{type, state}` per number GitHub answered (type "Issue" or "PullRequest",
// or null for a number that names nothing), or `{unreachable}` for a number
// that has no usable answer. What counts as an answer is gh-aliased-read.mjs's:
// a number GitHub nulls with NOT_FOUND names nothing, and a failed lookup is
// not an answer.
function githubStates(numbers) {
  const out = new Map();
  const read = ghAliasedRead(numbers, {
    field: "issueOrPullRequest", selection: "{__typename ... on Issue{state} ... on PullRequest{state}}", timeoutMs: GH_TIMEOUT_MS,
  });
  for (const [n, r] of read) {
    if (r.unreachable !== undefined) out.set(n, { unreachable: `gh api graphql gave no answer for #${n} (${r.unreachable})` });
    else if (r.notFound) out.set(n, { type: null });
    else out.set(n, { type: r.node.__typename, state: String(r.node.state).toUpperCase() });
  }
  return out;
}

// The root sweep's verdicts: `{remove: [{path, reason}], kept: [{path, reason}]}`.
function judgeRoot(root, names, live, now, listing, checkout) {
  const cutoff = now - RETENTION_MS;
  const remove = [];
  const kept = [];
  const liveMembers = live.map(parseMember).filter((m) => m !== null);
  const bot = liveMembers.find((m) => m.family === "merge-bot");
  const prHolder = (n) => live.find((name) => {
    const m = parseMember(name);
    if (m !== null) return (m.family === "fix-pr" || m.family === "finisher-pr") && m.number === n;
    const r = REVIEWER.exec(name);
    return r !== null && Number(r[1]) === n;
  });
  const implHolder = (n) => liveMembers.find((m) => m.family === "impl" && m.number === n)?.name;
  // Why a MERGED PR's entry is kept for its review evidence, or null when it
  // holds none origin/main lacks. origin/main is read once, on first need.
  let onMain = null;
  const evidenceHold = (path, name, n) => {
    let found;
    try {
      found = reviewTargets(path, name);
    } catch (e) {
      return `PR #${n} is MERGED, and its review evidence cannot be read: ${e.code ?? e.message}`;
    }
    if (found.targets.length === 0) return null;
    onMain ??= evidenceOnMain(checkout);
    if (onMain.unknown !== undefined) return `PR #${n} is MERGED, but whether origin/main holds its review evidence cannot be told: ${onMain.unknown}`;
    const missing = found.targets.filter((t) => !onMain.paths.has(t.to)).map((t) => t.to);
    return missing.length === 0 ? null : `PR #${n} is MERGED, but origin/main does not hold its review evidence yet: ${missing.join(", ")}`;
  };

  const byAge = (path, name, young) => {
    const holder = live.find((t) => name.includes(t));
    if (holder !== undefined) return kept.push({ path, reason: `live token ${holder} appears in its name` });
    const fresh = freshUnder(path, cutoff);
    if (fresh === null) return remove.push({ path, reason: "idle past 7 days" });
    kept.push({ path, reason: young ? `${young}; modified within 7 days` : "modified within 7 days" });
  };

  // `reports/` is not an entry to age out whole: each file in it is judged as
  // the member's own, so a live member's report is never swept along with an
  // idle directory.
  const entries = [];
  for (const name of names) {
    // The sibling pass's record of whose key this is: never this sweep's to judge.
    if (name === CHECKOUT_FILE) continue;
    const path = join(root, name);
    let isDir = false;
    try {
      isDir = name === REPORTS_DIR && lstatSync(path).isDirectory();
    } catch (e) {
      // raced away: judged below as any other entry. Anything else (an
      // unsearchable root) leaves `reports` unclassified, and judging it as an
      // ordinary entry would age the whole directory out.
      if (e.code !== "ENOENT") {
        kept.push({ path, reason: `its type cannot be read: ${e.message}` });
        continue;
      }
    }
    if (!isDir) {
      entries.push({ path, name, report: false });
      continue;
    }
    let inner;
    try {
      inner = readdirSync(path).sort();
    } catch (e) {
      kept.push({ path, reason: `its entries cannot be listed: ${e.message}` });
      continue;
    }
    for (const f of inner) entries.push({ path: join(path, f), name: f, report: true });
  }

  const keyed = [];
  const numbers = new Set();
  for (const { path, name, report } of entries) {
    let m;
    if (report) {
      if ((m = REPORT_PR_ENTRY.exec(name))) keyed.push({ path, name, kind: "pr", n: Number(m[1]) });
      else if ((m = REPORT_IMPL_ENTRY.exec(name))) keyed.push({ path, name, kind: "impl", n: Number(m[1]) });
      else {
        byAge(path, name, null);
        continue;
      }
    } else if ((m = PR_ENTRY.exec(name))) keyed.push({ path, name, kind: "pr", n: Number(m[1]) });
    else if ((m = IMPL_ENTRY.exec(name))) keyed.push({ path, name, kind: "impl", n: Number(m[1]) });
    else if ((m = DISPOSITIONS_ENTRY.exec(name))) keyed.push({ path, name, kind: "pr", n: Number(m[1]) });
    else {
      byAge(path, name, null);
      continue;
    }
    numbers.add(keyed.at(-1).n);
  }
  const states = githubStates([...numbers].sort((a, b) => a - b));

  for (const { path, name, kind, n } of keyed) {
    const s = states.get(n);
    if (s.unreachable) {
      kept.push({ path, reason: s.unreachable });
      continue;
    }
    const want = kind === "pr" ? "PullRequest" : "Issue";
    if (s.type !== want) {
      byAge(path, name, s.type === null ? `#${n} names nothing on GitHub` : `#${n} is a ${s.type}, not ${kind === "pr" ? "a pull request" : "an issue"}`);
      continue;
    }
    if (kind === "pr") {
      if (bot !== undefined) {
        kept.push({ path, reason: `live ${bot.name} holds every pr<N>` });
        continue;
      }
      if (s.state === "OPEN") {
        kept.push({ path, reason: `PR #${n} is OPEN` });
        if (name === `pr${n}`) {
          try {
            remove.push(...staleRunRoots(path, cutoff, kept));
          } catch (e) {
            kept.push({ path, reason: `its run-* roots cannot be listed: ${e.message}` });
          }
        }
        continue;
      }
      if (s.state !== "MERGED" && s.state !== "CLOSED") {
        kept.push({ path, reason: `PR #${n} has an unrecognised state ${s.state}` });
        continue;
      }
      const holder = prHolder(n);
      if (holder !== undefined) {
        kept.push({ path, reason: `PR #${n} is ${s.state}, but live ${holder} names it` });
        continue;
      }
      const held = s.state === "MERGED" ? evidenceHold(path, name, n) : null;
      if (held !== null) kept.push({ path, reason: held });
      else remove.push({ path, reason: `PR #${n} is ${s.state}` });
      continue;
    }
    if (s.state === "CLOSED") {
      remove.push({ path, reason: `issue #${n} is CLOSED` });
      continue;
    }
    const holder = implHolder(n);
    if (holder !== undefined) {
      kept.push({ path, reason: `issue #${n} is OPEN and live ${holder} names it` });
      continue;
    }
    const claim = claimWorktree(listing, n);
    if (claim.unknown !== undefined) {
      kept.push({ path, reason: `its claim worktree cannot be checked: ${claim.unknown}` });
      continue;
    }
    if (claim.stands) {
      kept.push({ path, reason: "claim worktree stands" });
      continue;
    }
    if (freshUnder(path, cutoff) === null) remove.push({ path, reason: `issue #${n} is OPEN, no live impl-${n} token, idle past 7 days` });
    else kept.push({ path, reason: `issue #${n} is OPEN; modified within 7 days` });
  }
  return { remove, kept };
}

// The run-* directories directly under `parent` idle past the retention, as
// removals; young ones are pushed onto `kept`. An absent parent holds none; one
// that cannot be listed throws.
function staleRunRoots(parent, cutoff, kept) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }
  const remove = [];
  for (const e of entries) {
    if (!e.isDirectory() || !RUN_ROOT.test(e.name)) continue;
    const path = join(parent, e.name);
    if (freshUnder(path, cutoff) === null) remove.push({ path, reason: "run root idle past 7 days" });
    else kept.push({ path, reason: "run root modified within 7 days" });
  }
  return remove;
}

// THE SIBLING PASS judges every key-shaped directory directly under the scratch
// parent of `root`, other than the live key, by the checkout its
// `checkout-path` names (judgeSibling below) and by age. Other entries under
// the parent, links and the live key are not judged at all. The keys are
// judged in name order.
function judgeSiblings(root, cutoff) {
  const parent = dirname(root);
  const live = basename(root);
  const remove = [];
  const kept = [];
  const failed = [];
  const entries = readdirSync(parent, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === live || !SCRATCH_KEY_SHAPE.test(entry.name)) continue;
    const path = join(parent, entry.name);
    let verdict;
    try {
      verdict = judgeSibling(path, cutoff);
    } catch (e) {
      failed.push({ path, error: e.message });
      continue;
    }
    if (verdict.remove) remove.push({ path, reason: verdict.reason });
    else kept.push({ path, reason: verdict.reason, idle: verdict.idle });
  }
  return { remove, kept, failed };
}

// A read of `checkout-path` that leaves no file to judge, rather than an error.
const NO_CHECKOUT_FILE = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);

// The checkout `key`'s `checkout-path` names: `{ checkout }`; `{ none }`, why
// there is no valid file — missing, unreadable, anything but one absolute
// path, or a path whose sha256 does not start with the key's 8-hex suffix;
// or `{ error }` for any other failure to read it.
function checkoutOf(key) {
  let text;
  try {
    text = readFileSync(join(key, CHECKOUT_FILE), "utf8");
  } catch (e) {
    if (NO_CHECKOUT_FILE.has(e.code)) return { none: e.code === "ENOENT" ? `${CHECKOUT_FILE} is missing` : `${CHECKOUT_FILE} cannot be read (${e.code})` };
    return { error: `its ${CHECKOUT_FILE} cannot be read: ${e.message}` };
  }
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.includes("\n") || !isAbsolute(line)) return { none: `${CHECKOUT_FILE} holds no single absolute path` };
  const suffix = basename(key).slice(-8);
  if (!createHash("sha256").update(line).digest("hex").startsWith(suffix)) return { none: `${line} does not hash to the key's suffix ${suffix}` };
  return { checkout: line };
}

// Whether anything exists at `p` (lstat): true, false, or the error that
// leaves it unknown.
function existsAt(p) {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    return e;
  }
}

// One sibling key's verdict, `{remove, reason, idle}`. `idle` is whether
// nothing under the key was found modified within the retention, searched for
// every key. Removed only when its checkout file is valid, nothing exists at
// the checkout it names, the directory that held that checkout does exist,
// nothing under the key is fresh and every part of it could be read. A key
// whose checkout still exists is its own phase 0's to reclaim; one whose
// checkout's parent is gone too may sit on an unplugged drive.
function judgeSibling(path, cutoff) {
  const unreadable = [];
  const idle = freshUnder(path, cutoff, unreadable) === null;
  const keep = (reason) => ({ remove: false, reason, idle });
  const found = checkoutOf(path);
  if (found.error !== undefined) return keep(found.error);
  if (found.none !== undefined) return keep(`no checkout file: ${found.none}`);
  const { checkout } = found;
  const at = existsAt(checkout);
  if (at instanceof Error) return keep(`whether its checkout ${checkout} exists cannot be told: ${at.message}`);
  if (at) return keep(`its checkout ${checkout} still exists, so its own phase 0 reclaims it`);
  const held = dirname(checkout);
  const up = existsAt(held);
  if (up instanceof Error) return keep(`whether ${held}, the directory that held its checkout ${checkout}, exists cannot be told: ${up.message}`);
  if (!up) return keep(`neither its checkout ${checkout} nor ${held}, the directory that held it, exists`);
  if (!idle) return keep("sibling key modified within 7 days");
  if (unreadable.length > 0) return keep(`sibling key could not be read whole (${unreadable[0]})`);
  return { remove: true, reason: `its checkout ${checkout} is gone and nothing under it changed in 7 days`, idle };
}

// The live key's own `checkout-path`, written when it is missing or says
// anything but this workspace's canonical path: a temp file in the key,
// renamed over it. A failure is returned as a failed[] entry, null otherwise.
function writeCheckout(root) {
  const file = join(root, CHECKOUT_FILE);
  let checkout;
  try {
    checkout = dirname(fleetFile(null, { canonicalise: true }));
  } catch (e) {
    return { path: file, error: e.message };
  }
  if (checkoutOf(root).checkout === checkout) return null;
  const tmp = join(root, `.${CHECKOUT_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${checkout}\n`);
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // left for the root sweep to age out
    }
    return { path: file, error: e.message };
  }
  return null;
}

function main() {
  const { arg, has, sweep, stray } = defineFlags(die, {
    flags: { root: "value", pr: "value", "after-rotate": "bool", apply: "bool", siblings: "bool" },
  });
  sweep();
  stray();
  const rootArg = arg("root");
  const pr = arg("pr");
  const afterRotate = has("after-rotate");
  const apply = has("apply");
  const siblings = has("siblings");
  const usage = "usage: reclaim-scratch.mjs --root <abs> [--after-rotate] [--apply] | --pr <N> --root <abs> [--apply] | --siblings --root <abs> [--apply]";
  if (rootArg === null) die(`--root is required — ${usage}`);
  if (!isAbsolute(rootArg)) die(`--root must be an absolute path, got ${JSON.stringify(rootArg)}`);
  if (pr !== null && !isDigits(pr)) die(`--pr must be a PR number, got ${JSON.stringify(pr)}`);
  if (pr !== null && afterRotate) die("--after-rotate is the root sweep's; --pr reads no ledger");
  const root = resolve(rootArg);
  try {
    if (!statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
  } catch (e) {
    die(`--root ${root} is not a directory: ${e.message}`);
  }
  if (siblings) {
    if (pr !== null) die("--siblings and --pr are separate passes");
    if (afterRotate) die("--after-rotate is the root sweep's; --siblings reads no ledger");
  }
  if (pr === null) {
    // Only this workspace's own scratch root: the header says why, per pass.
    const [judges, why] = siblings
      ? ["--siblings judges the keys beside", "--siblings judges the keys beside the live one"]
      : ["the root sweep judges", "the root sweep judges entries against this workspace's ledger, worktrees and GitHub repository"];
    let own;
    try {
      own = scratchRoot();
    } catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      die(`${judges} this workspace's scratch root, which could not be resolved: ${e.message}`);
    }
    if (!isAbsolute(own)) die(`${judges} this workspace's scratch root, which could not be resolved: ${own} is not absolute, so HOME is empty or relative`);
    if (root !== own) die(`${why}: --root must be this workspace's scratch root ${own}, got ${root}`);
  }

  const now = Date.now();
  let ledger = null;
  let remove;
  let kept = [];
  const failed = [];
  if (pr !== null) {
    const parent = join(root, `pr${Number(pr)}`);
    try {
      remove = staleRunRoots(parent, now - RETENTION_MS, kept);
    } catch (e) {
      remove = [];
      failed.push({ path: parent, error: e.message });
    }
  } else if (siblings) {
    if (apply) {
      const wrote = writeCheckout(root);
      if (wrote !== null) failed.push(wrote);
    }
    try {
      const judged = judgeSiblings(root, now - RETENTION_MS);
      remove = judged.remove;
      kept = judged.kept;
      failed.push(...judged.failed);
    } catch (e) {
      remove = [];
      failed.push({ path: dirname(root), error: e.message });
    }
  } else {
    const found = ledgerFile(die);
    ledger = found.file;
    if (ledger === null && !afterRotate) die("no .fleet/ledger.md — without it no live member can hold its scratch, so nothing is reclaimed; pass --after-rotate only straight after `ledger.mjs rotate`");
    const live = ledger === null ? [] : liveNames(ledger);
    let names;
    try {
      names = readdirSync(root).sort();
    } catch (e) {
      die(`could not list --root ${root}: ${e.message}`);
    }
    const listing = worktreeListing(found.checkout);
    ({ remove, kept } = judgeRoot(root, names, live, now, listing, found.checkout));
  }

  const removed = [];
  for (const entry of remove) {
    if (!apply) {
      removed.push(entry);
      continue;
    }
    let error;
    try {
      // A sibling key belongs to another workspace's runs, which can write to it
      // or bring its checkout back while an earlier key is still being removed:
      // its whole verdict is taken again here, so a key no longer removable is
      // kept.
      const again = siblings ? judgeSibling(entry.path, now - RETENTION_MS) : null;
      if (again !== null && !again.remove) {
        kept.push({ path: entry.path, reason: again.reason, idle: again.idle });
        continue;
      }
      error = removeEntry(entry.path);
    } catch (e) {
      error = e.message;
    }
    if (error === null) removed.push(entry);
    else failed.push({ path: entry.path, error });
  }
  writeAll(1, `${JSON.stringify({ applied: apply, ledger, removed, kept, failed })}\n`);
}

if (isCLI(import.meta.url)) main();
