#!/usr/bin/env node
// Which lines would merging this head remove that `main` gained after the
// PR's work began — the main-gain check, read-only.
//
//   main-gain.mjs --head <sha> [--base <ref>] [--body-file <path|->] [--closing-refs <path>]
//
// Reads the repository at the cwd. `--head` is a full commit SHA; `--base`
// defaults to `origin/main` and is spelled the way no-undo-audit.sh takes its
// BASE_REF — `origin/<branch>` or `refs/remotes/<path>`, qualified to the
// full `refs/remotes/` path before any read so a local tag or branch literally
// named `origin/main` cannot answer for it. `--body-file` is the PR body
// (`-` reads stdin); omitted, the body is empty and nothing is acknowledged.
// `--closing-refs` is a file holding the JSON object `gh pr view <pr> --json
// number,url,closingIssuesReferences` prints; the references in this PR's own
// repository (`ownClosingIssues`, a pure function, so no `gh` call here) are the
// issues the PR closes, echoed as `closes`. Absent, unreadable, or a reference
// that cannot be placed: `closes` is `null` and the retraction rule below is
// off, so there are more hits, never fewer.
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
// R misses two windows. The time between the fork and the PR's first commit
// is before R. And a branch rewritten into fresh commits (`git reset --soft
// <base>` and a new commit, or a squash that resets the author) carries new
// author dates, so R moves past a landing and a deletion replayed from the
// rewrite reads clean. Only a rebase or an amend keeps R.
//
// Removed lines are read off the merge the head would actually produce:
// `git merge-tree --write-tree <base> <head>`, diffed against `<base>` with
// rename detection on. That is right for a head that is behind `<base>` too,
// where a three-dot diff is not. Every removed line is a candidate, and every
// line of a deleted file is, except a move: a removed line whose exact text is
// added back in the same file. A candidate edited in place is not a hit: an
// added line of the same hunk that still holds every token of it claims it, and
// each added line claims at most one. A token is a run of letters, digits or
// underscores, or else one other character that is not whitespace, so
// appending a name to an import is an in-place edit and dropping one is not.
//
// Two more rules clear what in-place pairing leaves, hunk by hunk, for a hunk
// that adds at least one line; tokens never cross hunks. The hunk rule: the
// token multiset of every removed line of the hunk that is not a move (gained
// and older lines alike, a blank line being one blank token) is contained in
// that of every added line not spent on a move, claimed lines included, so a
// re-wrap that keeps every token clears. The retraction rule, when the hunk rule
// fails: a forward reference in the removed tokens (`once #N lands` and the
// like, read across lines) naming only issues the PR closes is dropped from the
// removed side, and the one token after it may differ from an added token in
// case alone; if what remains is contained, the hunk clears. A hunk that only
// removes lines is never cleared by either rule. Binary files cannot be read
// line by line and are listed in `unchecked[]` instead of blocking. A
// merge-tree that reports conflicts is a head that cannot merge as it stands,
// which is no answer about its content.
//
// Each hit carries a landing key: `#<n>` when the landing commit's subject is
// GitHub's merge subject for PR n, otherwise that commit's 12-character
// abbreviated SHA. A PR-body line `main-gain-removal: <path> <key> - <why>`
// acknowledges every hit in that file with that key, and nothing else; one
// with an empty reason, or a reason that is only an angle-bracket placeholder
// such as the printed `<why>`, does not count. Acknowledged hits move from `hits[]`
// to `acknowledged[]` and both are reported.
//
// Stdout: one JSON line, `{head, base, closes, since, hits, acknowledged,
// edited, unchecked, reason}`, `since` being R as an ISO timestamp and `closes`
// the PR's own closing issue numbers or `null`. Each hit is `{path, key,
// landed, lines: [{line, text, kind}], hunks, ack}`, `path` the file's name on
// `<base>` and `ack` the body line to copy, reason left for the author to
// write. `kind` is `modified` when the hunk that removed the line also adds
// lines, and `deleted` when it only removes them. `hunks` has one entry per
// hunk holding any of the hit's lines, `{lines: [line numbers], added: [the
// added lines the removed tokens were compared against], missing: [[token,
// count], ...]}`: the removed tokens those added lines do not carry, with
// counts, in order of first appearance, case-sensitive, a blank line's token
// written "\n"; a hunk with no added lines has `added: []` and no `missing`.
// `edited` lists the gained lines cleared as not removed, as `{path, line,
// text, replacement, rule}`. `rule` `line` is an in-place edit, one entry per
// line, `replacement` being the added line that holds its tokens. `hunk` and
// `retracted #N` (every closing number the removed phrases named, space
// separated) are one entry per cleared hunk: `line` is the first cleared gained
// line, `text` the cleared gained lines joined with "\n", `replacement` the
// added lines compared against, joined with "\n". An edited line is not a hit
// and needs no acknowledgement.
//
//   0  clean, or every hit acknowledged
//   1  at least one unacknowledged hit             reason main-gain-removed:<first path>
//   2  could not answer: no verdict                reason names what could not be read
//
// An argument this script refuses exits 2 with no JSON line at all.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { ownClosingIssues } from "./closing-refs.mjs";
import { gitEnv } from "./git-env.mjs";

const NAME = "main-gain";
const die = makeDie(NAME);
const { arg, sweep, stray } = defineFlags(die, {
  flags: { head: "value", base: "value", "body-file": "value", "closing-refs": "value" },
});

const USAGE = "usage: main-gain.mjs --head <sha> [--base <ref>] [--body-file <path|->] [--closing-refs <path>]";

const headArg = arg("head");
const base = arg("base") ?? "origin/main";
const bodyFile = arg("body-file");
const closingRefsFile = arg("closing-refs");
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

// The issue numbers this PR closes in its own repository, or `null` for no
// answer: the retraction rule is then off. Unreadable, unparsable and
// unplaceable all read the same, which is more hits, never fewer.
function closingIssues() {
  if (closingRefsFile === null) return null;
  try {
    const pr = JSON.parse(readFileSync(closingRefsFile, "utf8"));
    return ownClosingIssues(pr.number, pr.url, pr.closingIssuesReferences);
  } catch {
    return null;
  }
}
const closes = closingIssues();

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

// The hunks of one path, `{removed: [{line, text}], added: [text]}` each, in
// diff order, or `binary`. Removed lines are numbered on `<base>`.
function fileDiff(tree, oldPath, newPath) {
  const paths = oldPath === newPath ? [oldPath] : [oldPath, newPath];
  const r = git(["diff-tree", "-r", "-M", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", baseRev, tree, "--", ...paths]);
  if (r === null) unanswerable(`diff-unreadable:${oldPath}`);
  const hunks = [];
  let hunk = null;
  let oldLine = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      hunk = null;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h) {
      hunk = { removed: [], added: [] };
      hunks.push(hunk);
      oldLine = Number(h[1]);
    } else if (hunk === null) {
      if (line.startsWith("Binary files ")) return { binary: true };
    } else if (line.startsWith("-")) {
      hunk.removed.push({ line: oldLine++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      hunk.added.push(line.slice(1));
    }
  }
  return { binary: false, hunks };
}

// The tokens an in-place edit keeps: a run of letters, digits or underscores is
// one token, and each other character that is not whitespace is one.
const TOKEN = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const tokensOf = (text) => countOf(text.match(TOKEN) ?? []);

// Each unclaimed added line of one hunk claims at most one removed line of that
// hunk. Removed lines choose in turn, most tokens first so a short line does not
// take the added line a long one needs, and each takes the first unclaimed added
// line still holding every token of it. That is greedy: a removed line can stay
// a hit where another pairing would have matched every line, an error toward
// blocking. The rarest token of a removed line bounds the added lines tried for
// it.
function claimInPlace(removed, added) {
  const index = new Map();
  for (const a of added) {
    if (a.claimed) continue;
    a.tokens = tokensOf(a.text);
    for (const t of a.tokens.keys()) {
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(a);
    }
  }
  const size = (counts) => [...counts.values()].reduce((s, n) => s + n, 0);
  for (const c of [...removed].sort((x, y) => size(y.tokens) - size(x.tokens))) {
    if (c.tokens.size === 0) continue;
    const pool = [...c.tokens.keys()].map((t) => index.get(t) ?? []).reduce((best, l) => (l.length < best.length ? l : best));
    const a = pool.find((x) => !x.claimed && [...c.tokens].every(([t, n]) => (x.tokens.get(t) ?? 0) >= n));
    if (a) {
      a.claimed = true;
      c.replacement = a.text;
    }
  }
}

// The hunk rules read a hunk's lines as token streams, where a blank or
// whitespace-only line is one blank token, which no real token can equal.
const BLANK = "\n";
const streamOf = (lines) => lines.flatMap((text) => text.match(TOKEN) ?? [BLANK]);

function countOf(stream) {
  const counts = new Map();
  for (const t of stream) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

// `[token, count]` for each removed token the added tokens carry fewer of, in
// order of first appearance in the removed stream, the count being the shortfall.
function shortfall(removed, have) {
  const out = [];
  for (const [t, n] of countOf(removed)) {
    const lack = n - (have.get(t) ?? 0);
    if (lack > 0) out.push([t, lack]);
  }
  return out;
}

// The forward references a PR may retract. The patterns run over the tokens
// joined by single spaces, case-insensitively, and each match must begin and
// end on a token boundary.
const ID = "(?:`\\s)?#\\s\\d+(?:\\s`)?";
const IDS = `${ID}(?:\\s(?:and|,|/|&)\\s${ID})*`;
const RETRACTION = new RegExp(
  "(?<=^|\\s)(?:" +
    `(?:written\\s)?(?:once|until|when|after|pending)\\s${IDS}\\s(?:lands?|ships?|merges?|is\\sbuilt)(?:\\s,)?` +
    `|pending\\s${ID}\\s,\\snot\\syet\\sbuilt` +
    `|${IDS}\\s(?:are\\s)?still\\sto\\sland` +
    ")(?=\\s|$)",
  "gi",
);

// `{start, end, numbers}` for each phrase in `stream` that names only issues in
// `closes` — token indices, `end` exclusive — in stream order.
function retractions(stream, closes) {
  const starts = [];
  let joined = "";
  for (const t of stream) {
    if (joined !== "") joined += " ";
    starts.push(joined.length);
    joined += t === BLANK ? "\0" : t;
  }
  const mine = new Set(closes.map(String));
  const found = [];
  for (const m of joined.matchAll(RETRACTION)) {
    const numbers = [...m[0].matchAll(/#\s(\d+)/g)].map((n) => n[1]);
    if (!numbers.every((n) => mine.has(n))) continue;
    const first = starts.indexOf(m.index);
    let end = first;
    while (end < stream.length && starts[end] < m.index + m[0].length) end++;
    found.push({ start: first, end, numbers });
  }
  return found;
}

// Takes the tokens of `stream` off `have` (mutating it), each exactly; false
// when one is not there as often as the stream holds it.
function consume(stream, have) {
  for (const t of stream) {
    const n = have.get(t) ?? 0;
    if (n === 0) return false;
    have.set(t, n - 1);
  }
  return true;
}

// The hunk rule, then the retraction rule, on one hunk's removed and added
// lines: the rule name when no gained line of the hunk is a hit, else `null`.
// A hunk that adds nothing is never cleared.
function clearsHunk(removed, added, closes) {
  if (added.length === 0) return null;
  const gone = streamOf(removed);
  const have = countOf(streamOf(added));
  if (shortfall(gone, have).length === 0) return "hunk";
  if (closes === null) return null;
  const phrases = retractions(gone, closes);
  if (phrases.length === 0) return null;
  const dropped = new Set();
  for (const { start, end } of phrases) for (let i = start; i < end; i++) dropped.add(i);
  const after = new Set(phrases.map((p) => p.end).filter((i) => i < gone.length && !dropped.has(i)));
  const rest = gone.filter((_, i) => !dropped.has(i) && !after.has(i));
  if (!consume(rest, have)) return null;
  // The token after a retracted phrase may differ from an added one in case
  // alone; only after every other token has had its exact match.
  for (const i of [...after].sort((a, b) => a - b)) {
    const t = gone[i];
    const key = (have.get(t) ?? 0) > 0 ? t : [...have.keys()].find((u) => have.get(u) > 0 && u.toLowerCase() === t.toLowerCase());
    if (key === undefined) return null;
    have.set(key, have.get(key) - 1);
  }
  const named = [...new Set(phrases.flatMap((p) => p.numbers))];
  return `retracted ${named.map((n) => `#${n}`).join(" ")}`;
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
  const r = git(["blame", "--first-parent", "--line-porcelain", "--no-ignore-revs-file", ...ranges, baseRev, "--", path]);
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
// token before ` - `, so a path may carry spaces; a blank <why> never matches,
// and neither does one that is a single angle-bracket placeholder, the line
// the gate prints for the author to copy included.
function acknowledgements(text) {
  const acks = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^main-gain-removal: (.+) (#[1-9][0-9]*|[0-9a-f]{12}) - (\S.*)$/.exec(raw.trim());
    if (m && !/^<[^<>]*>$/.test(m[3])) acks.push({ path: m[1], key: m[2], reason: m[3] });
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
  const edited = [];
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
      // A removed line whose exact text is added back in the same file is a
      // move, and the added line is spent on it.
      const addsByHunk = d.hunks.map(() => []);
      const twins = new Map();
      d.hunks.forEach((h, hunk) => {
        for (const text of h.added) {
          const a = { text, moved: false, claimed: false, tokens: null };
          addsByHunk[hunk].push(a);
          if (!twins.has(text)) twins.set(text, []);
          twins.get(text).push(a);
        }
      });
      const candsByHunk = d.hunks.map(() => []);
      d.hunks.forEach((h, hunk) => {
        for (const { line, text } of h.removed) {
          const spare = twins.get(text);
          if (spare?.length) {
            const twin = spare.pop();
            twin.moved = true;
            twin.claimed = true;
            continue;
          }
          const kind = h.added.length > 0 ? "modified" : "deleted";
          candsByHunk[hunk].push({ line, text, kind, tokens: tokensOf(text), replacement: null });
        }
      });
      d.hunks.forEach((_, hunk) => claimInPlace(candsByHunk[hunk], addsByHunk[hunk]));
      if (candsByHunk.every((cs) => cs.length === 0)) continue;
      const cands = candsByHunk.flat();
      const blamed = blame(oldPath, cands);
      const byKey = new Map();
      d.hunks.forEach((h, hunk) => {
        const compared = addsByHunk[hunk].filter((a) => !a.moved).map((a) => a.text);
        const gained = [];
        for (const c of candsByHunk[hunk]) {
          if (blamed.get(c.line).time <= since) continue;
          if (c.replacement !== null) {
            edited.push({ path: oldPath, line: c.line, text: c.text, replacement: c.replacement, rule: "line" });
          } else {
            gained.push(c);
          }
        }
        if (gained.length === 0) return;
        const removed = candsByHunk[hunk].map((c) => c.text);
        const cleared = clearsHunk(removed, compared, closes);
        if (cleared !== null) {
          edited.push({
            path: oldPath,
            line: gained[0].line,
            text: gained.map((c) => c.text).join("\n"),
            replacement: compared.join("\n"),
            rule: cleared,
          });
          return;
        }
        const missing = h.added.length > 0 ? shortfall(streamOf(removed), countOf(streamOf(compared))) : null;
        // This hunk's diagnosis for each landing key, made once.
        const diagnoses = new Map();
        for (const c of gained) {
          const b = blamed.get(c.line);
          const key = landingKey(b.sha, b.summary);
          if (!byKey.has(key)) {
            byKey.set(key, { path: oldPath, key, landed: b.sha, lines: [], hunks: [], ack: `main-gain-removal: ${oldPath} ${key} - <why>` });
          }
          const hit = byKey.get(key);
          hit.lines.push({ line: c.line, text: c.text, kind: c.kind });
          if (!diagnoses.has(key)) {
            const diagnosis = missing === null ? { lines: [], added: compared } : { lines: [], added: compared, missing };
            diagnoses.set(key, diagnosis);
            hit.hunks.push(diagnosis);
          }
          diagnoses.get(key).lines.push(c.line);
        }
      });
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
    edited,
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
  result = { since: null, hits: [], acknowledged: [], edited: [], unchecked: [], reason: e.message, unknown: true };
}
const { unknown, ...payload } = result;
writeAll(1, `${JSON.stringify({ head, base, closes, ...payload })}\n`);
process.exit(unknown ? 2 : payload.hits.length ? 1 : 0);
