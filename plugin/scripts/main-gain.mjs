#!/usr/bin/env node
// Which lines would merging this head remove that `main` gained after the
// PR's work began — the main-gain check, read-only.
//
//   main-gain.mjs --head <sha> [--base <ref>] [--body-file <path|->]
//
// Reads the repository at the cwd. `--head` is a full commit SHA; `--base`
// defaults to `origin/main` and is spelled the way no-undo-audit.sh takes its
// BASE_REF — `origin/<branch>` or `refs/remotes/<path>`, qualified to the
// full `refs/remotes/` path before any read so a local tag or branch literally
// named `origin/main` cannot answer for it. `--body-file` is the PR body
// (`-` reads stdin); omitted, the body is empty and nothing is acknowledged.
// It never fetches, writes or changes refs: the caller fetches first.
//
// The reference point R is the earliest author date among the PR's own
// commits (`<base>..<head>`). Rebases and amends keep author dates, so R
// survives a rewritten branch, where a merge-base taken after the rebase
// would not. A line landed on `main` when the commit `git blame
// --first-parent` attributes it to on `<base>` was committed; `main` is
// merge-only, so that is the first-parent commit that brought it in. A line
// is a main gain when it landed after R.
//
// Removed lines are read off the merge the head would actually produce:
// `git merge-tree --write-tree <base> <head>`, diffed against `<base>` with
// rename detection on. That is right for a head that is behind `<base>` too,
// where a three-dot diff is not. Every removed line is a candidate, including
// one replaced by other text, and every line of a deleted file is. A removed
// line whose exact text is added back in the same file is a move, not a
// candidate. Binary files cannot be read line by line and are listed in
// `unchecked[]` instead of blocking. A merge-tree that reports conflicts is a
// head that cannot merge as it stands, which is no answer about its content.
//
// Each hit carries a landing key: `#<n>` when the landing commit's subject is
// GitHub's merge subject for PR n, otherwise that commit's 12-character
// abbreviated SHA. A PR-body line `main-gain-removal: <path> <key> - <why>`
// acknowledges every hit in that file with that key, and nothing else; one
// with an empty reason does not count. Acknowledged hits move from `hits[]`
// to `acknowledged[]` and both are reported.
//
// Stdout: one JSON line, `{head, base, since, hits, acknowledged, unchecked,
// reason}`, `since` being R as an ISO timestamp. Each hit is `{path, key,
// landed, lines: [{line, text}], ack}`, `path` the file's name on `<base>` and
// `ack` the body line to copy, reason left for the author to write.
//
//   0  clean, or every hit acknowledged
//   1  at least one unacknowledged hit             reason main-gain-removed:<first path>
//   2  could not answer: no verdict                reason names what could not be read
//
// An argument this script refuses exits 2 with no JSON line at all.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";

const NAME = "main-gain";
const die = makeDie(NAME);
const { arg, sweep, stray } = defineFlags(die, {
  flags: { head: "value", base: "value", "body-file": "value" },
});

const USAGE = "usage: main-gain.mjs --head <sha> [--base <ref>] [--body-file <path|->]";

const headArg = arg("head");
const base = arg("base") ?? "origin/main";
const bodyFile = arg("body-file");
if (headArg === null) die(USAGE);
sweep();
stray();

const head = headArg.toLowerCase();
if (!/^[0-9a-f]{40}$/.test(head)) die(`--head needs a full 40-character commit SHA, got ${headArg}`);
if (!/^(origin|refs\/remotes)\/./.test(base)) die(`--base must be spelled origin/<branch> or refs/remotes/<path>, got '${base}'`);
const baseRev = base.startsWith("refs/remotes/") ? base : `refs/remotes/${base}`;

let body = "";
if (bodyFile !== null) {
  try {
    body = readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8");
  } catch (e) {
    die(`cannot read --body-file ${bodyFile}: ${e.code ?? e.message}`);
  }
}

// LC_ALL=C: the `Binary files … differ` line below is read by its text.
// GIT_LITERAL_PATHSPECS: a path is a name here, never a glob or magic.
const ENV = gitEnv({ LC_ALL: "C", GIT_LITERAL_PATHSPECS: "1" });

// The one git spawn. `null` for a git that could not run or exited outside
// `ok`; the caller names what it was reading.
function git(args, ok = [0]) {
  const r = spawnSync("git", args, { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });
  if (r.error || r.signal || !ok.includes(r.status)) return null;
  return r;
}

class Unanswerable extends Error {}
const unanswerable = (reason) => {
  throw new Unanswerable(reason);
};

const MERGE_SUBJECT = /^Merge pull request #([1-9][0-9]*) from /;

function landingKey(sha, summary) {
  const m = MERGE_SUBJECT.exec(summary);
  return m ? `#${m[1]}` : sha.slice(0, 12);
}

// `<old> <new> <status>` per changed path, off `diff-tree --raw -z`.
function changedPaths(tree) {
  const r = git(["diff-tree", "-r", "-M", "-z", "--raw", baseRev, tree]);
  if (r === null) unanswerable("diff-unreadable");
  const parts = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i < parts.length - 1; ) {
    const meta = parts[i++];
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!m) unanswerable("diff-unreadable");
    const status = m[3];
    const oldPath = parts[i++];
    const newPath = status === "R" || status === "C" ? parts[i++] : oldPath;
    out.push({ oldMode: m[1], status, oldPath, newPath });
  }
  return out;
}

// Removed lines `[{line, text}]` and added texts, or `binary`, for one path.
function fileDiff(tree, oldPath, newPath) {
  const paths = oldPath === newPath ? [oldPath] : [oldPath, newPath];
  const r = git(["diff-tree", "-r", "-M", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", baseRev, tree, "--", ...paths]);
  if (r === null) unanswerable(`diff-unreadable:${oldPath}`);
  const removed = [];
  const added = [];
  let inHunk = false;
  let oldLine = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("Binary files ")) return { binary: true };
      const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (h) {
        inHunk = true;
        oldLine = Number(h[1]);
      }
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLine = Number(h[1]);
    } else if (line.startsWith("-")) {
      removed.push({ line: oldLine++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      added.push(line.slice(1));
    }
  }
  return { binary: false, removed, added };
}

// line number on `<base>` → {sha, time, summary} for the requested lines,
// which arrive in ascending order; consecutive ones share one `-L` range.
function blame(path, lines) {
  const spans = [];
  for (const { line } of lines) {
    const last = spans.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else spans.push([line, line]);
  }
  const ranges = spans.flatMap(([from, to]) => ["-L", `${from},${to}`]);
  const r = git(["blame", "--first-parent", "--line-porcelain", "--ignore-revs-file=", ...ranges, baseRev, "--", path]);
  if (r === null) unanswerable(`blame-failed:${path}`);
  const out = new Map();
  let cur = null;
  for (const line of r.stdout.split("\n")) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (h) {
      cur = { sha: h[1], line: Number(h[2]), time: null, summary: "" };
    } else if (cur && line.startsWith("committer-time ")) {
      cur.time = Number(line.slice("committer-time ".length));
    } else if (cur && line.startsWith("summary ")) {
      cur.summary = line.slice("summary ".length);
    } else if (cur && line.startsWith("\t")) {
      out.set(cur.line, cur);
      cur = null;
    }
  }
  for (const { line } of lines) {
    if (!out.has(line) || !Number.isInteger(out.get(line).time)) unanswerable(`blame-failed:${path}`);
  }
  return out;
}

// `main-gain-removal: <path> <key> - <why>`, one per line. The key is the
// token before ` - `, so a path may carry spaces; a blank <why> never matches.
function acknowledgements(text) {
  const acks = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^main-gain-removal: (.+) (#[1-9][0-9]*|[0-9a-f]{12}) - (\S.*)$/.exec(raw.trim());
    if (m) acks.push({ path: m[1], key: m[2], reason: m[3] });
  }
  return acks;
}

function check() {
  if (git(["cat-file", "-e", `${head}^{commit}`]) === null) unanswerable("head-unreadable");
  if (git(["rev-parse", "--verify", "-q", `${baseRev}^{commit}`]) === null) unanswerable("base-unreadable");

  const own = git(["log", "--format=%at", `${baseRev}..${head}`]);
  if (own === null) unanswerable("history-unreadable");
  const times = own.stdout.split("\n").filter(Boolean).map(Number);
  if (times.some((t) => !Number.isInteger(t))) unanswerable("history-unreadable");
  const since = times.length ? Math.min(...times) : null;

  const merged = git(["merge-tree", "--write-tree", baseRev, head], [0, 1]);
  if (merged === null) unanswerable("merge-unreadable");
  if (merged.status === 1) unanswerable("merge-conflict");
  const tree = merged.stdout.split("\n")[0];
  if (!/^[0-9a-f]{40,64}$/.test(tree)) unanswerable("merge-unreadable");

  const hits = [];
  const unchecked = [];
  // No commits of its own: the head is already on `<base>` and merges nothing.
  if (since !== null) {
    for (const { oldMode, status, oldPath, newPath } of changedPaths(tree)) {
      if (status === "A") continue;
      if (oldMode === "160000") {
        unchecked.push(oldPath);
        continue;
      }
      const d = fileDiff(tree, oldPath, newPath);
      if (d.binary) {
        unchecked.push(oldPath);
        continue;
      }
      const addedBack = new Map();
      for (const t of d.added) addedBack.set(t, (addedBack.get(t) ?? 0) + 1);
      const candidates = d.removed.filter(({ text }) => {
        const n = addedBack.get(text) ?? 0;
        if (n === 0) return true;
        addedBack.set(text, n - 1);
        return false;
      });
      if (candidates.length === 0) continue;
      const blamed = blame(oldPath, candidates);
      const byKey = new Map();
      for (const c of candidates) {
        const b = blamed.get(c.line);
        if (b.time <= since) continue;
        const key = landingKey(b.sha, b.summary);
        if (!byKey.has(key)) {
          byKey.set(key, { path: oldPath, key, landed: b.sha, lines: [], ack: `main-gain-removal: ${oldPath} ${key} - <why>` });
        }
        byKey.get(key).lines.push(c);
      }
      hits.push(...byKey.values());
    }
  }

  const acks = acknowledgements(body);
  const acknowledged = [];
  const open = [];
  for (const hit of hits) {
    const ack = acks.find((a) => a.path === hit.path && a.key === hit.key);
    if (ack) acknowledged.push({ ...hit, reason: ack.reason });
    else open.push(hit);
  }
  return {
    since: since === null ? null : new Date(since * 1000).toISOString(),
    hits: open,
    acknowledged,
    unchecked,
    reason: open.length ? `main-gain-removed:${open[0].path}` : null,
  };
}

// Node exits 1 on an uncaught throw, and 1 here is a verdict about the PR,
// so nothing but a hit may reach it: every other failure is exit 2.
let result;
try {
  result = check();
} catch (e) {
  if (!(e instanceof Unanswerable)) die(`check failed: ${e.code ?? e.message} — could not evaluate`);
  result = { since: null, hits: [], acknowledged: [], unchecked: [], reason: e.message, unknown: true };
}
const { unknown, ...payload } = result;
writeAll(1, `${JSON.stringify({ head, base, ...payload })}\n`);
process.exit(unknown ? 2 : payload.hits.length ? 1 : 0);
