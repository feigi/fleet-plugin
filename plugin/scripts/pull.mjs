#!/usr/bin/env node
// A Pull as one resumable command: the mechanical steps in order, stopping at
// each judgement with a question the controller answers in one token.
//
//   pull.mjs next [--head <N>]
//   pull.mjs answer <N> <qid> <token> [--path <p>] [--] [<text>…]
//
// Reached through the Resolver and run from the MAIN checkout (a linked
// worktree refuses). `next` starts a Pull on the shortlist head — `--head`, else
// the first `.fleet/shortlist.json` entry with no `impl-` row, no live
// `excluded` row and no Pull of its own already ended in this phase-0 session — or resumes the
// one in progress for `--head`; `answer` records one answer and resumes. Both
// run until the next question or the end of the Pull, and both are safe to
// run again: the state is on disk after every step.
//
// EXITS
//   0   dispatched: `DISPATCH {"name","agent","brief"}` is printed. Running
//       `next --head <N>` on a dispatched Pull prints it again.
//   1   the ticket left the Pull — taken, relabelled elsewhere, closed,
//       relabelled by cause, excluded — with the reason printed; take the next
//       entry. An empty shortlist is this exit too.
//   2   could not look, named on stderr: a probe that did not answer, a write
//       that failed, a router that refused. `next --head <N>` runs a step that
//       failed again; when the failure came from applying an answer, the
//       question stands and the answer is given again. A router that refused
//       has its claim released and the Pull is over, `next --head <N>` starting
//       the ticket over; one whose claim could not be released leaves the Pull
//       at the route step with the claim standing, and `next` routes again. An
//       exclusion premise `gh` could not read is exit 2 when no other entry is
//       left. An unknown flag is exit 2 as well, as for every script that holds
//       a command line of its own.
//   3   usage: any other mistake in the command line, or an answer the pending
//       question does not take. Nothing is recorded.
//   10  a question is pending: its `QUESTION <qid>:` block, with the tokens it
//       takes, is printed.
//
// THE STEPS, in this order:
//
//   1  inflight   `inflight.sh <N>`: anything but exit 0 is taken.
//   2  issue      `gh issue view <N> --json title,body,comments,labels,createdAt`
//                 written to `<scratch>/impl-<N>/issue.json`. Without the
//                 `ready-for-agent` label the ticket is gone. The distilled
//                 brief and the paths the router's extractor finds in it are
//                 printed.
//   3  Q1 staleness   `gone` / `present` (each with `--path <p>` and the string
//                 as the text) run `staleness.mjs --path <p> --gone|--present --
//                 <string>`; `none <why>` and `done` end the question. Exit 1
//                 from the probe with a JSON verdict naming a commit asks Q1b
//                 `close`: `yes` closes the issue with a comment citing the
//                 probe's commit and that commit's subject, `no <why>` asks Q1
//                 again. Exit 2, and exit 1 with no verdict JSON or no commit,
//                 are recorded as `could-not-check: <reason>` and carried into
//                 the brief.
//   4  Q2 decided     `decided`, or a cause whose comment is posted and whose
//                 label replaces `ready-for-agent`.
//   5  Q3 collision   the scan first: the brief's paths, its Out of scope
//                 section's excepted, and every path a `paths <p>…` answer
//                 added, against each open PR's `gh pr diff <M> --name-only`
//                 and each live worktree branch's `git diff --name-only -z
//                 origin/main...<branch>` — `main` excepted, and a branch whose
//                 upstream is gone, its PR already merged or closed. A path,
//                 its trailing `:N` or `:N-M` dropped, matches a changed file
//                 of that path, one under it as a directory, with no `/` one of
//                 that name, or, holding a `/` but not starting with one, one
//                 whose trailing whole segments it is or sits under. One line
//                 per PR or branch sharing a path, then, from its full diff
//                 (`gh pr diff <M>`, or `git diff origin/main...<branch>`),
//                 each shared file's hunks by base-side range, each with the
//                 Markdown headings its changed lines sit under in the file
//                 at the merge-base (a PR's head fetched as `pull/<M>/head`);
//                 ranges only for a file that is not Markdown or whose base
//                 could not be read. Each brief path with a line reference
//                 in a shared file follows, with its headings on origin/main.
//                 `no overlap` when none, and `could not look: <which>` for
//                 one that could not be read; the `#N` refs of the brief's
//                 Out of scope section are printed as the behind-issue
//                 candidates. Then `clear`, `behind-pr:#M`, `behind-issue:#M`,
//                 or `paths <p>…`, which scans again and asks again. An
//                 exclusion is a ledger row.
//   6  claim      `claim-ticket.sh <N> impl-<N> implementer --apply`.
//   7  route      `ticket-router.mjs route …`; a router that refuses releases
//                 the claim, and a release that fails is exit 2 with the claim
//                 still standing. `--chain-head` is given when a ledger row reads
//                 `excluded · behind-issue:#<N>`: another open ticket
//                 sequences after this one.
//   8  row, render, dispatch   `ledger.mjs row`, `dispatch-prompt.mjs render
//                 implementer --member impl-<N>`, `ledger.mjs dispatch`. The
//                 brief and the staleness text are given with `‹name›` for each
//                 `<name>` the implementer template declares: the renderer
//                 refuses a value that spells one.
//
// THE STATE is `<scratch>/impl-<N>/pull.json`: every command run (script, its
// arguments, exit status, bounded stdout, time), every question asked and every
// answer with its text and time, and where the Pull stands. A Pull that left
// the Pull (exit 1) or was refused by the router is held as `pull.previous.json`
// when `next` starts the ticket over, and so is a record from another phase-0
// session, whatever it says.
//
// No judgement lives here: the script offers evidence and takes a token.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDigits, makeDie } from "./arg.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { memberTokens, premisesOf, tierValues } from "./ledger-grammar.mjs";
import { sessionFromReceipt } from "./phase0-receipt.mjs";
import { briefPaths, briefText, outOfScope } from "./ticket-router.mjs";

const NAME = "pull";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const die = makeDie(NAME);
const MAX_BUFFER = 64 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
const PR_LIMIT = 200;
// A command's stdout and each of its arguments are kept to this many characters
// in the record, the tail kept: the end of a child's output says why it stopped.
const RECORD_MAX = 4000;
const STATE = "pull.json";
const PREVIOUS = "pull.previous.json";
const EXPLORE_EVERY = 5;
// The states that lift an exclusion's premise.
const LIFTED = new Set(["MERGED", "CLOSED"]);

const READY = "ready-for-agent";
const TRIAGE = "needs-triage";
const HUMAN = "ready-for-human";

const USAGE = `usage: ${NAME}.mjs next [--head <N>] | ${NAME}.mjs answer <N> <qid> <token> [--path <p>] [--] [<text>…]`;

// ── the comments the script posts ────────────────────────────────────────────

const RELABELLED = "*Relabelled by the fleet controller.* Pulled for implementation and returned:";

// What each `ready-for-human-hands` cause says in the comment.
const HANDS = Object.freeze({
  "external access": "external access",
  "manual testing": "manual testing",
  judgment: "judgment during the work",
});

// `<cause> <line>`, the cause first: null cause when the text starts with none.
function handsParts(text) {
  for (const cause of Object.keys(HANDS)) {
    if (text === cause || text.startsWith(`${cause} `)) return { cause, line: text.slice(cause.length).trim() };
  }
  return { cause: null, line: "" };
}

/** The comment, and the label that replaces `ready-for-agent`, for a Q2 answer other than `decided`. */
export function relabel(token, text) {
  if (token === "needs-triage") {
    return {
      label: TRIAGE,
      comment: `${RELABELLED} the brief does not decide what to build. Missing decision: ${text}. Returning to /triage; \`${READY}\` restored once decided.`,
    };
  }
  if (token === "ready-for-human-fork") {
    return { label: HUMAN, comment: `${RELABELLED} the brief leaves a decision open. Open fork: ${text}.` };
  }
  const { cause, line } = handsParts(text);
  return { label: HUMAN, comment: `${RELABELLED} needs human hands — ${HANDS[cause]}: ${line}.` };
}

/** The comment a `yes` to Q1b closes the issue with. */
export function closeComment(commit, subject) {
  return `*Closed by the fleet controller.* Pulled for implementation and found already fixed by ${commit}: ${subject}.`;
}

// ── the ledger, read ─────────────────────────────────────────────────────────

const rowKey = (row) => row.split(/\s/)[0];
const isImplRow = (row) => memberTokens(row).some((t) => t.family === "impl");

/**
 * The `--impl-row` the router is given: the row count the Pull creates — or,
 * while an exploration assignment is rolling (the latest row 5k and every row
 * after it carry no `tier=`), that row's number.
 */
export function implRow(rows) {
  const impl = rows.filter(isImplRow);
  const n = impl.length;
  const latest = n - (n % EXPLORE_EVERY);
  if (latest >= EXPLORE_EVERY && impl.slice(latest - 1).every((r) => tierValues(r).length === 0)) return latest;
  return n + 1;
}

/** Whether an `excluded · behind-issue:#<n>` row names ticket `n`: another open ticket sequences after it. */
export function chainHead(rows, n) {
  return rows.some((r) => (premisesOf(r) ?? []).some((p) => p.kind === "issue" && p.target === String(n)));
}

// ── the brief ────────────────────────────────────────────────────────────────

/** The ticket's `Out of scope` section: the brief's, else the body's; null when neither holds one. */
function scopeOf(issue) {
  return outOfScope(briefText(issue).trim()) ?? outOfScope(String(issue.body ?? ""));
}

/** The `#N` refs in `section`, each once, in the order they first appear; `owner/repo#N` is another repository's and none. */
export function issueRefs(section) {
  if (section === null) return [];
  return [...new Set([...section.matchAll(/(?<![\w/.-])#(\d+)\b/g)].map((m) => `#${m[1]}`))];
}

// ── the collision scan ───────────────────────────────────────────────────────

// A brief path's trailing line reference, `:N` or `:N-M`.
const LINE_REF = /:(\d+)(?:-(\d+))?$/;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

/**
 * Whether brief path `p` names changed file `f`, once a trailing `:N` or `:N-M`
 * line reference is dropped: the same path, a directory above it (with or
 * without its trailing `/`), or, with no `/`, a file by its name. A path that
 * holds a `/` and does not start with one is also a suffix on whole segments,
 * naming a file whose trailing segments equal it or one under a directory
 * whose trailing segments do. A path starting with `/` is a slash command and
 * is never a suffix.
 */
export function pathHits(p, f) {
  const t = p.replace(LINE_REF, "");
  const q = t.replace(/\/+$/, "");
  if (q === "") return false;
  if (f === q || f.startsWith(`${q}/`)) return true;
  if (!q.includes("/")) return f.split("/").pop() === q || (t !== q && f.includes(`/${q}/`));
  return !t.startsWith("/") && (f.endsWith(`/${q}`) || f.includes(`/${q}/`));
}

/** A path as a diff header spells it: C-quoted when git quotes it, its trailing tab dropped. */
function diffPath(s) {
  const raw = s.replace(/\t$/, "");
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const ESC = { n: 10, t: 9, '"': 34, "\\": 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
  const bytes = [];
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] !== "\\") {
      const ch = String.fromCodePoint(raw.codePointAt(i));
      bytes.push(...Buffer.from(ch));
      i += ch.length - 1;
    } else if (/[0-7]{3}/.test(raw.slice(i + 1, i + 4))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      i += 1;
      bytes.push(ESC[raw[i]] ?? raw.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The side of a `--- a/<p>` or `+++ b/<p>` line: the path, or null for `/dev/null`. */
function diffSide(s, prefix) {
  const p = diffPath(s);
  if (p === "/dev/null") return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Every file of a unified git diff, `{ old, new, hunks }`: `old` the base-side
 * path and `new` the other, null for `/dev/null`, and each hunk its base-side
 * range `{ a, b }` from `@@ -a,b` with `from`..`to`, the base-side lines its
 * changes touch — a removed line its own, an added line the one it follows, 0
 * before the first — so its context lines are no part of it. A hunk's own
 * lines are counted off its header, so a removed `-- x` line is never read as
 * a file header.
 */
export function diffHunks(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let left = 0;
  let right = 0;
  let at = 0;
  for (const line of text.split("\n")) {
    if (left > 0 || right > 0) {
      if (line.startsWith("-")) {
        hunk.from ??= at;
        hunk.to = at++;
        left--;
      } else if (line.startsWith("+")) {
        hunk.from ??= at - 1;
        hunk.to = at - 1;
        right--;
      } else if (!line.startsWith("\\")) {
        at++;
        left--;
        right--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = { old: null, new: null, hunks: [] };
      files.push(file);
      continue;
    }
    if (file === null) continue;
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (h !== null) {
      const a = Number(h[1]);
      const b = h[2] === undefined ? 1 : Number(h[2]);
      hunk = { a, b, from: null, to: null };
      file.hunks.push(hunk);
      left = b;
      right = h[3] === undefined ? 1 : Number(h[3]);
      // An empty base range `-a,0` sits after line a, not on it.
      at = b === 0 ? a + 1 : a;
    } else if (line.startsWith("--- ")) file.old = diffSide(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) file.new = diffSide(line.slice(4), "b/");
  }
  return files;
}

/** The ATX headings of Markdown `text`, `{ line, text }`, 1-based, fenced code skipped. */
export function headings(text) {
  const out = [];
  let fence = null;
  text.split("\n").forEach((l, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (f !== null) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (fence === null && /^ {0,3}#{1,6}(\s|$)/.test(l)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

/** The heading lines `from`..`to` sit under: the one enclosing `from`, then each that starts after it, up to `to`. */
export function sectionsOf(hs, from, to) {
  const above = hs.filter((h) => h.line <= from).at(-1);
  const within = hs.filter((h) => h.line > from && h.line <= to);
  return [above === undefined ? "(no heading above)" : above.text, ...within.map((h) => h.text)].join(" → ");
}

// The placeholders the implementer's brief template declares. dispatch-prompt.mjs
// refuses a value that spells one, and a ticket's text is a value: one that
// names `<N>` would stop every render, with the claim standing.
const TEMPLATE = join(SCRIPTS, "..", "skills", "run-team", "briefs", "implementer.md");

function declaredPlaceholders() {
  const lines = readFileSync(TEMPLATE, "utf8").split("\n");
  if (lines[0] !== "---") return [];
  const names = [];
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    const m = /^arg \S+ (.+)$/.exec(line);
    if (m !== null) names.push(m[1]);
  }
  return names;
}

/** `text` with each declared placeholder's spelling `<name>` written `‹name›`, which the renderer does not read. */
export function defang(text, names) {
  return names.reduce((t, n) => t.split(`<${n}>`).join(`‹${n}›`), text);
}

// ── children ─────────────────────────────────────────────────────────────────

const trimmed = (s) => String(s ?? "").trim();
const cap = (s) => (s.length > RECORD_MAX ? `…${s.slice(-(RECORD_MAX - 1))}` : s);
// What the record keeps of a child whose stdout is a whole file or diff: its size.
const sized = (r) => `${Buffer.byteLength(r.stdout)} bytes`;
const now = () => new Date().toISOString();

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

/** `status` is the exit status, null when the child never ran or was killed (`how` says which). `raw` keeps stdout as printed. */
function spawn(cmd, args, { cwd, env, timeoutMs, raw = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(env), timeout: timeoutMs });
  const stdout = raw ? String(r.stdout ?? "") : trimmed(r.stdout);
  const stderr = trimmed(r.stderr);
  return { status: r.error ? null : r.status, stdout, stderr, text: [stdout, stderr].filter(Boolean).join("\n"), how: how(r) };
}

const GH_ENV = { GH_REPO: "" };
const withText = (head, r) => (r.text ? `${head}\n${r.text}` : head);
// How a child failed, with the first line of what it said.
const failure = (r) => `${r.how}${r.stderr === "" ? "" : `: ${r.stderr.split("\n")[0]}`}`;

/** The branches `git worktree list --porcelain -z` names; a detached worktree names none. */
function worktreeBranches(out) {
  const head = "branch refs/heads/";
  return out.split("\0").filter((f) => f.startsWith(head)).map((f) => f.slice(head.length));
}

/** The local branches whose upstream is gone, from `git for-each-ref --format=%(refname:short)%09%(upstream:track)`. */
function goneBranches(out) {
  const mark = "\t[gone]";
  return new Set(out.split("\n").filter((l) => l.endsWith(mark)).map((l) => l.slice(0, -mark.length)));
}

// ── the state ────────────────────────────────────────────────────────────────

function fresh(ticket, session) {
  return {
    ticket,
    member: `impl-${ticket}`,
    started: now(),
    status: "running",
    stage: "inflight",
    pending: null,
    commands: [],
    questions: [],
    answers: [],
    staleness: [],
    close: null,
    addedPaths: [],
    scans: [],
    session,
    commented: null,
    route: null,
    dispatch: null,
    outcome: null,
  };
}

// Null when there is no state; one that is there and cannot be used throws, naming it.
function readPull(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Refusal(`cannot read ${path} (${e.code ?? e.message}) — move it aside and run again`);
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch (e) {
    throw new Refusal(`${path} is not JSON (${e.message}) — move it aside and run again`);
  }
  const ok = s !== null && typeof s === "object" && !Array.isArray(s)
    && Number.isInteger(s.ticket) && typeof s.stage === "string" && typeof s.status === "string"
    && Array.isArray(s.commands) && Array.isArray(s.questions) && Array.isArray(s.answers);
  if (!ok) throw new Refusal(`${path} is not a Pull record — move it aside and run again`);
  // A record written before the collision scan holds neither field.
  s.scans ??= [];
  s.addedPaths ??= [];
  if (!Array.isArray(s.scans) || !Array.isArray(s.addedPaths)) throw new Refusal(`${path} is not a Pull record — move it aside and run again`);
  // A collision question is printed from the latest scan, so one standing with no scan behind it cannot be.
  if (s.pending?.qid === "collision" && s.scans.length === 0) {
    throw new Refusal(`${path} holds a collision question that no scan of this script asked — move it aside and run again`);
  }
  return s;
}

function writePull(path, st) {
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
  renameSync(tmp, path);
}

/** A refusal the script reports at exit 2 in its own words. */
class Refusal extends Error {}

/** A command line or an answer the script refuses at exit 3. */
class Usage extends Error {}

// ── the questions ────────────────────────────────────────────────────────────

const STALENESS_TOKENS = [
  "gone --path <p> [--] <string>      the string the fix must remove from <p> on origin/main",
  "present --path <p> [--] <string>   the string the fix must add to <p> on origin/main",
  "none <why>                         no string settles it; ends this question",
  "done                               ends this question",
];
const CLOSE_TOKENS = ["yes          close the issue citing the commit and its subject", "no <why>     keep the ticket"];
const DECIDED_TOKENS = [
  "decided",
  "needs-triage <the missing decision>",
  "ready-for-human-fork <the options, verbatim from the brief>",
  "ready-for-human-hands <external access|manual testing|judgment> <one line>",
];
const COLLISION_TOKENS = [
  "clear",
  "behind-pr:#M      an open PR, or a branch with no PR yet by its name",
  "behind-issue:#M   an open issue the brief's Out of scope sequences this one after",
  "paths <p>…        adds paths to the scan, which runs again",
];

const TOKEN_LINES = { staleness: STALENESS_TOKENS, close: CLOSE_TOKENS, decided: DECIDED_TOKENS, collision: COLLISION_TOKENS };

// What each question's tokens take. `path`: a `--path <p>` is required; `text`: free text is required.
const SPECS = {
  staleness: { gone: { path: true, text: true }, present: { path: true, text: true }, none: { text: true }, done: {} },
  close: { yes: {}, no: { text: true } },
  decided: { decided: {}, "needs-triage": { text: true }, "ready-for-human-fork": { text: true }, "ready-for-human-hands": { text: true } },
};

function block(qid, ticket, context) {
  return [
    `QUESTION ${qid}:`,
    ...context.map((l) => `  ${l}`),
    `  answer with: pull.mjs answer ${ticket} ${qid} <token> [<text>…] — the tokens:`,
    ...TOKEN_LINES[qid].map((l) => `    ${l}`),
  ];
}

/**
 * The answer's parts, or a Usage refusal naming what the question takes. `rest`
 * is what follows the token on the command line: `--path <p>` first where the
 * token takes one, a `--` that ends the options, then the text.
 */
export function parseAnswer(qid, token, rest) {
  const takes = TOKEN_LINES[qid];
  if (takes === undefined) throw new Usage(`${qid} is no question this script asks`);
  const refuse = (why) => new Usage(`${why} — the tokens ${qid} takes:\n${takes.map((l) => `    ${l}`).join("\n")}`);
  let spec = SPECS[qid]?.[token];
  let said = token;
  if (qid === "collision") {
    const m = /^behind-(pr|issue):#?(\S+)$/.exec(token);
    if (token === "clear") spec = {};
    else if (token === "paths") spec = { text: true };
    else if (m !== null && !m[2].startsWith("-") && (m[1] === "pr" || isDigits(m[2]))) {
      spec = {};
      said = `behind-${m[1]}:#${m[2]}`;
    }
  }
  if (spec === undefined) throw refuse(`'${token}' is not a token of ${qid}`);
  let path = null;
  let args = rest;
  if (args[0] === "--path") {
    if (!spec.path) throw refuse(`${token} takes no --path`);
    path = args[1];
    if (path === undefined || path.trim() === "") throw refuse(`${token} needs a path after --path`);
    args = args.slice(2);
  } else if (spec.path) {
    throw refuse(`${token} needs --path <p> before its text`);
  }
  if (args[0] === "--") args = args.slice(1);
  const text = args.join(" ").trim();
  if (spec.text && text === "") throw refuse(`${token} needs text`);
  if (!spec.text && text !== "") throw refuse(`${token} takes no text, got: ${text}`);
  if (token === "ready-for-human-hands" && handsParts(text).line === "") {
    throw refuse("ready-for-human-hands needs one of external access|manual testing|judgment, then a line");
  }
  return { token: said, text, path };
}

// ── the Pull ─────────────────────────────────────────────────────────────────

// `{ exit, out, err }`: what a command prints and how it ends.
const result = (exit, out = [], err = []) => ({ exit, out, err });

class Pull {
  constructor(st, p) {
    this.st = st;
    this.p = p;
    // What the stages say on the way to their result, printed ahead of it.
    this.log = [];
  }

  save() {
    writePull(this.p.state, this.st);
  }

  // The Pull ends without a dispatch: exit 1, the ticket is not this run's.
  leave(reason) {
    this.st.status = "left";
    this.st.pending = null;
    this.st.outcome = { exit: 1, reason, at: now() };
    return result(1, [`LEFT #${this.st.ticket}: ${reason} — next entry`]);
  }

  stop(why) {
    return result(2, [], [`${NAME}: #${this.st.ticket}: ${why}`]);
  }

  // Runs a child and records it: `lead` is what the interpreter is given ahead
  // of the arguments (the script's path), kept out of the record. `shown`
  // computes the stdout the record keeps.
  exec(step, name, cmd, lead, args, opts = {}, shown = null) {
    const r = spawn(cmd, [...lead, ...args], { cwd: this.p.cwd, ...opts });
    this.st.commands.push({
      at: now(),
      step,
      cmd: [name, ...args.map((a) => cap(String(a)))],
      exit: r.status,
      ...(r.status === null ? { error: r.how } : {}),
      stdout: cap(shown === null ? r.stdout : shown(r)),
    });
    this.save();
    return r;
  }

  script(step, file, args, opts, shown) {
    const cmd = file.endsWith(".sh") ? "sh" : process.execPath;
    return this.exec(step, file, cmd, [join(SCRIPTS, file)], args, { env: GH_ENV, ...opts }, shown);
  }

  gh(step, args, shown) {
    return this.exec(step, "gh", "gh", [], args, { env: GH_ENV, timeoutMs: NETWORK_TIMEOUT_MS }, shown);
  }

  ask(qid, context) {
    this.st.pending = { qid, at: now() };
    this.st.questions.push({ at: this.st.pending.at, qid });
    this.save();
    return result(10, block(qid, this.st.ticket, context));
  }

  ledgerRows() {
    const r = this.script("ledger", "ledger.mjs", ["read"]);
    if (r.status !== 0) throw new Refusal(withText(`ledger.mjs read ${r.how}`, r));
    try {
      const { rows } = JSON.parse(r.stdout);
      if (Array.isArray(rows) && rows.every((x) => typeof x === "string")) return rows;
    } catch {
      // Falls through to the refusal below.
    }
    throw new Refusal("ledger.mjs read printed no {rows}");
  }

  // ── the ticket, as read ──
  issue() {
    return JSON.parse(readFileSync(this.p.issue, "utf8"));
  }

  brief() {
    const issue = this.issue();
    const text = briefText(issue).trim();
    const found = scopeOf(issue);
    const paths = briefPaths(text);
    return [
      `TICKET #${this.st.ticket}: ${issue.title}`,
      "BRIEF:",
      ...text.split("\n"),
      "OUT OF SCOPE:",
      ...(found === null ? ["(no Out of scope section found)"] : found.split("\n")),
      `PATHS: ${paths.length === 0 ? "(none)" : paths.join(" ")}`,
    ];
  }

  // What the dispatched member is told the ticket is: its title, its brief,
  // and the Out of scope section when that sits outside the brief.
  dispatchBrief() {
    const issue = this.issue();
    const text = briefText(issue).trim();
    const outside = outOfScope(text) === null ? outOfScope(String(issue.body ?? "")) : null;
    return [`Title: ${issue.title}`, text, ...(outside === null ? [] : [outside])].join("\n\n");
  }

  // ── the question standing, printed in full: what a Pull picked up again re-reads ──
  describe() {
    const { qid } = this.st.pending;
    if (qid === "staleness") return [...this.brief(), ...block(qid, this.st.ticket, this.stalenessContext())];
    if (qid === "close") return block(qid, this.st.ticket, this.closeContext());
    if (qid === "decided") return [...this.brief(), ...block(qid, this.st.ticket, [])];
    return [...this.brief(), ...block(qid, this.st.ticket, this.collisionContext())];
  }

  stalenessContext() {
    return [`issue read: ${this.p.issue}`];
  }

  closeContext() {
    const c = this.st.close;
    return [
      `staleness.mjs read --${c.mode} in ${c.path} as fixed by ${c.commit}`,
      `subject: ${c.subject}`,
    ];
  }

  // The latest scan, line by line, and the behind-issue candidates. A scan
  // recorded before the hunk evidence holds no `evidence` and no `lineRefs`.
  collisionContext() {
    const { paths, overlaps, lineRefs = [], unread } = this.st.scans.at(-1);
    const refs = issueRefs(scopeOf(this.issue()));
    const who = (o) => (o.branch === undefined ? `PR #${o.pr}` : `branch ${o.branch}${o.pr === null ? "" : ` (PR #${o.pr})`}`);
    return [
      `paths scanned: ${paths.length === 0 ? "(none)" : paths.join(" ")}`,
      ...overlaps.flatMap((o) => [`${who(o)}: ${o.paths.join(" ")}`, ...(o.evidence ?? [])]),
      ...lineRefs,
      ...unread.map((u) => `could not look: ${u}`),
      ...(overlaps.length === 0 ? ["no overlap"] : []),
      `behind-issue candidates (Out of scope): ${refs.length === 0 ? "(none)" : refs.join(" ")}`,
    ];
  }

  // A file as it stands at `rev`, `{ text }`, or `{ why }` it could not be read.
  fileAt(rev, path) {
    const r = this.exec("collision", "git", "git", [], ["cat-file", "blob", `${rev}:${path}`], { raw: true }, sized);
    return r.status === 0 ? { text: r.stdout } : { why: `git cat-file blob ${rev}:${path}: ${failure(r)}` };
  }

  // The merge-base of origin/main and `rev`, `{ rev }`, or `{ why }` there is none.
  mergeBase(rev) {
    const r = this.exec("collision", "git", "git", [], ["merge-base", "origin/main", rev]);
    return r.status === 0 && r.stdout !== "" ? { rev: r.stdout } : { why: `git merge-base origin/main ${rev}: ${failure(r)}` };
  }

  // The merge-base a PR's diff is taken against: its head fetched, then met with origin/main.
  prBase(pr) {
    const r = this.exec("collision", "git", "git", [], ["fetch", "-q", "origin", `pull/${pr}/head`], { timeoutMs: NETWORK_TIMEOUT_MS });
    return r.status === 0 ? this.mergeBase("FETCH_HEAD") : { why: `git fetch origin pull/${pr}/head: ${failure(r)}` };
  }

  // Each shared file's hunks in `diff`, by base-side range, each with the
  // headings its changed lines sit under in the base file `base()` names —
  // ranges only for a file that is not Markdown or whose base could not be read.
  hunkLines(files, diff, base) {
    const parsed = diffHunks(diff);
    const lines = [];
    let at;
    for (const f of files) {
      const d = parsed.find((x) => (x.new ?? x.old) === f);
      if (d === undefined || d.hunks.length === 0) {
        lines.push(`  ${f}: no hunk in the diff`);
        continue;
      }
      let hs = null;
      if (d.old !== null && MARKDOWN.test(d.old)) {
        at ??= base();
        const read = at.rev === undefined ? at : this.fileAt(at.rev, d.old);
        if (read.text === undefined) lines.push(`  ${f}: base not read (${read.why})`);
        else hs = headings(read.text);
      }
      for (const { a, b, from, to } of d.hunks) {
        const where = d.old === null ? " (new file)" : hs === null ? "" : ` ${sectionsOf(hs, from, to)}`;
        lines.push(`  ${f} @@ -${a},${b} @@${where}`);
      }
    }
    return lines;
  }

  // ── the stages: each returns null to go on to the stage `stage` now names, or a result ──
  advance() {
    const { st } = this;
    for (;;) {
      if (st.pending !== null) return result(10, this.describe());
      const stage = this[`stage_${st.stage}`];
      if (typeof stage !== "function") throw new Refusal(`${this.p.state} is at stage ${st.stage}, which this script does not know — move it aside and run again`);
      const r = stage.call(this);
      this.save();
      if (r !== null) return r;
    }
  }

  stage_inflight() {
    const r = this.script("inflight", "inflight.sh", [String(this.st.ticket)]);
    if (r.status === 0) {
      this.st.stage = "issue";
      return null;
    }
    return this.leave(r.status === 1 ? "taken" : `taken (the in-flight check could not answer: ${r.how})`);
  }

  stage_issue() {
    const { st } = this;
    const r = this.gh("issue", ["issue", "view", String(st.ticket), "--json", "title,body,comments,labels,createdAt"], (x) => `${Buffer.byteLength(x.stdout)} bytes, written to ${this.p.issue}`);
    if (r.status !== 0) return this.stop(withText(`gh issue view failed (${r.how})`, r));
    let issue;
    try {
      issue = JSON.parse(r.stdout);
    } catch (e) {
      return this.stop(`gh issue view printed no JSON: ${e.message}`);
    }
    const whole = issue !== null && typeof issue === "object" && typeof issue.title === "string"
      && typeof issue.body === "string" && Array.isArray(issue.labels) && Array.isArray(issue.comments);
    if (!whole) return this.stop("gh issue view printed no title, body, comments and labels");
    try {
      mkdirSync(dirname(this.p.issue), { recursive: true });
      writeFileSync(this.p.issue, `${r.stdout}\n`);
    } catch (e) {
      return this.stop(`cannot write ${this.p.issue}: ${e.message}`);
    }
    if (!issue.labels.some((l) => l?.name === READY)) return this.leave("relabelled elsewhere");
    this.log.push(...this.brief());
    st.stage = "staleness";
    return null;
  }

  stage_staleness() {
    const { st } = this;
    if (st.close === null) return this.ask("staleness", this.stalenessContext());
    if (st.close.subject === null) {
      const r = this.exec("close", "git", "git", [], ["log", "-1", "--format=%s", st.close.commit]);
      const subject = r.stdout.split("\n")[0];
      if (r.status !== 0 || subject === "") return this.stop(withText(`could not read the subject of ${st.close.commit} (${r.how})`, r));
      st.close.subject = subject;
    }
    return this.ask("close", this.closeContext());
  }

  stage_decided() {
    return this.ask("decided", []);
  }

  // The scan runs every time this stage does: after Q2, and after each `paths` answer.
  stage_collision() {
    const { st } = this;
    const r = this.gh("collision", ["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "number,headRefName"]);
    if (r.status !== 0) return this.stop(withText(`gh pr list failed (${r.how})`, r));
    let prs;
    try {
      prs = JSON.parse(r.stdout);
    } catch (e) {
      return this.stop(`could not parse gh pr list: ${e.message}`);
    }
    if (!Array.isArray(prs) || !prs.every((p) => Number.isInteger(p?.number) && typeof p.headRefName === "string")) {
      return this.stop("gh pr list did not print a JSON array of PRs with their number and head branch");
    }
    if (prs.length >= PR_LIMIT) return this.stop(`gh pr list came back at its cap of ${PR_LIMIT} — it may hold more PRs than it showed`);
    const wt = this.exec("collision", "git", "git", [], ["worktree", "list", "--porcelain", "-z"]);
    if (wt.status !== 0) return this.stop(withText(`git worktree list failed (${wt.how})`, wt));
    const refs = this.exec("collision", "git", "git", [], ["for-each-ref", "--format=%(refname:short)%09%(upstream:track)", "refs/heads"]);
    if (refs.status !== 0) return this.stop(withText(`git for-each-ref failed (${refs.how})`, refs));
    const gone = goneBranches(refs.stdout);

    const paths = [...new Set([...briefPaths(briefText(this.issue()).trim()), ...st.addedPaths])];
    const sharedFiles = new Set();
    // The brief paths a listing shares, and its files they name.
    const shared = (stdout, sep) => {
      const files = stdout.split(sep).filter((f) => f !== "");
      return { paths: paths.filter((p) => files.some((f) => pathHits(p, f))), files: files.filter((f) => paths.some((p) => pathHits(p, f))) };
    };
    const overlaps = [];
    const unread = [];
    for (const pr of prs.map((p) => p.number).sort((a, b) => a - b)) {
      const d = this.gh("collision", ["pr", "diff", String(pr), "--name-only"]);
      const common = shared(d.stdout, "\n");
      if (d.status !== 0) unread.push(`gh pr diff ${pr} (${failure(d)})`);
      // Fail closed, as pr-overlap.mjs does: a PR with no changed file is a query that did not work, never "no overlap".
      else if (d.stdout === "") unread.push(`gh pr diff ${pr} (printed no file)`);
      else if (common.paths.length > 0) {
        for (const f of common.files) sharedFiles.add(f);
        const full = this.gh("collision", ["pr", "diff", String(pr)], sized);
        let evidence = [];
        if (full.status !== 0) unread.push(`gh pr diff ${pr} (${failure(full)})`);
        else if (full.stdout === "") unread.push(`gh pr diff ${pr} (printed no diff)`);
        else evidence = this.hunkLines(common.files, full.stdout, () => this.prBase(pr));
        overlaps.push({ pr, paths: common.paths, evidence });
      }
    }
    const heads = new Map(prs.map((p) => [p.headRefName, p.number]));
    for (const branch of worktreeBranches(wt.stdout).filter((b) => b !== "main" && !gone.has(b)).sort()) {
      const range = `origin/main...${branch}`;
      // NUL-separated: git quotes a non-ASCII path in the newline form, and a quoted name equals no path the brief spells.
      const d = this.exec("collision", "git", "git", [], ["diff", "--name-only", "-z", range, "--"]);
      const common = shared(d.stdout, "\0");
      if (d.status !== 0) unread.push(`git diff --name-only ${range} (${failure(d)})`);
      else if (common.paths.length > 0) {
        for (const f of common.files) sharedFiles.add(f);
        const full = this.exec("collision", "git", "git", [], ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", range, "--"], {}, sized);
        let evidence = [];
        if (full.status !== 0) unread.push(`git diff ${range} (${failure(full)})`);
        else evidence = this.hunkLines(common.files, full.stdout, () => this.mergeBase(branch));
        overlaps.push({ branch, pr: heads.get(branch) ?? null, paths: common.paths, evidence });
      }
    }
    // A brief path carrying a line reference, in a shared file, with the headings it sits under on origin/main.
    const lineRefs = [];
    const onMain = new Map();
    for (const p of paths) {
      const ref = LINE_REF.exec(p);
      if (ref === null) continue;
      for (const f of [...sharedFiles].filter((x) => pathHits(p, x))) {
        let where = "(not Markdown)";
        if (MARKDOWN.test(f)) {
          if (!onMain.has(f)) onMain.set(f, this.fileAt("origin/main", f));
          const read = onMain.get(f);
          where = read.text === undefined ? `(not read: ${read.why})` : sectionsOf(headings(read.text), Number(ref[1]), Number(ref[2] ?? ref[1]));
        }
        lineRefs.push(`brief ref ${p} (${f} on origin/main): ${where}`);
      }
    }
    st.scans.push({ at: now(), paths, overlaps, lineRefs, unread });
    return this.ask("collision", this.collisionContext());
  }

  stage_claim() {
    const { st } = this;
    // The session is the router's, and a claim made before it is known would
    // have to be released again.
    try {
      st.session = sessionFromReceipt({ cwd: this.p.cwd });
    } catch (e) {
      return this.stop(e.message);
    }
    const r = this.script("claim", "claim-ticket.sh", [String(st.ticket), st.member, "implementer", "--apply"]);
    if (r.status === 0) {
      st.stage = "route";
      return null;
    }
    if (r.status === 2) return this.leave(`taken (claim-ticket.sh refused the claim${r.text === "" ? "" : `: ${r.text.replace(/\s+/g, " ")}`})`);
    return this.stop(withText(`claim-ticket.sh could not claim (${r.how})`, r));
  }

  stage_route() {
    const { st } = this;
    const rows = this.ledgerRows();
    const k = implRow(rows);
    const head = chainHead(rows, st.ticket);
    const args = [
      "route", "--session", st.session, "--ticket", String(st.ticket), "--arm", st.ticket % 2 === 0 ? "A" : "B",
      "--impl-row", String(k), ...(head ? ["--chain-head"] : []), "--issue", this.p.issue, "--guard", this.p.guard,
    ];
    const r = this.script("route", "ticket-router.mjs", args);
    const m = r.status === 0 ? /^POLICY=(\S+) CELL=(\S+) DRAW=(\S+) STRATUM=(\S+) REASON=(\S+)$/m.exec(r.stdout) : null;
    if (m === null) {
      const said = r.status === 0 ? `printed no routing line: ${r.stdout}` : withText(`refused (${r.how})`, r);
      const rel = this.script("release", "release-ticket.sh", [String(st.ticket), st.member, "implementer", "--apply"]);
      if (rel.status !== 0) {
        // The claim stands, so the Pull is not over: it stays at this step, and running it again routes, or refuses and releases, again.
        return this.stop(`ticket-router.mjs ${said}\n${withText(`its claim is STILL STANDING: release-ticket.sh failed (${rel.how})`, rel)}`);
      }
      st.status = "released";
      st.outcome = { exit: 2, reason: `router ${said}`, at: now() };
      return this.stop(`ticket-router.mjs ${said}\nits claim is released`);
    }
    st.route = { line: m[0], cell: m[2], draw: m[3], reason: m[5], implRow: k, chainHead: head };
    st.stage = "row";
    return null;
  }

  stage_row() {
    const { st } = this;
    const { cell, draw, reason } = st.route;
    const text = `${st.member}${draw === "-" ? "" : ` · tier=${cell}`}${reason === "ok" ? "" : ` · route=${reason}`}`;
    const r = this.script("row", "ledger.mjs", ["row", String(st.ticket), text]);
    if (r.status !== 0) return this.stop(withText(`ledger.mjs row failed (${r.how})`, r));
    st.stage = "render";
    return null;
  }

  stage_render() {
    const { st } = this;
    const worktree = join(this.p.cwd, ".worktrees", `${st.ticket}-${st.member}`);
    const staleness = st.staleness.length === 0 ? "no probe was run" : st.staleness.join("; ");
    let names;
    try {
      names = declaredPlaceholders();
    } catch (e) {
      return this.stop(`cannot read the brief template ${TEMPLATE} (${e.code ?? e.message})`);
    }
    const r = this.script("render", "dispatch-prompt.mjs", [
      "render", "implementer", "--member", st.member, "--ticket", String(st.ticket), "--worktree", worktree,
      "--branch", `implementer/${st.ticket}-${st.member}`, "--scratch", this.p.scratch,
      "--brief", defang(this.dispatchBrief(), names), "--staleness", defang(staleness, names),
    ]);
    if (r.status !== 0) return this.stop(withText(`dispatch-prompt.mjs render refused (${r.how}) — the claim stands`, r));
    st.stage = "dispatch";
    return null;
  }

  stage_dispatch() {
    const { st } = this;
    const r = this.script("dispatch", "ledger.mjs", ["dispatch", String(st.ticket), st.member]);
    if (r.status !== 0) return this.stop(withText(`ledger.mjs dispatch refused (${r.how}) — the claim stands`, r));
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch (e) {
      return this.stop(`ledger.mjs dispatch printed no JSON: ${e.message}`);
    }
    if (typeof out?.agent !== "string" || typeof out?.brief?.path !== "string") return this.stop("ledger.mjs dispatch printed no agent and brief path");
    st.dispatch = { name: st.member, agent: out.agent, brief: out.brief.path };
    st.status = "dispatched";
    st.stage = "done";
    st.outcome = { exit: 0, at: now() };
    return this.dispatched();
  }

  stage_done() {
    return this.dispatched();
  }

  dispatched() {
    return result(0, [`DISPATCH ${JSON.stringify(this.st.dispatch)}`]);
  }

  // ── an answer's effect: null to ask on, or a result. Exit 2 is an effect that failed ──
  answer(qid, { token, text, path }) {
    const { st } = this;
    const entry = { at: now(), qid, token, text, ...(path === null ? {} : { path }), applied: false };
    st.answers.push(entry);
    this.save();
    const r = this[`answer_${qid}`](token, text, path);
    // A failed effect leaves the question standing, to be answered again.
    if (r !== null && r.exit === 2) return r;
    entry.applied = true;
    st.pending = null;
    this.save();
    return r;
  }

  answer_staleness(token, text, path) {
    const { st } = this;
    if (token === "done") {
      st.stage = "decided";
      return null;
    }
    if (token === "none") {
      st.staleness.push(`could-not-check: no string settles it — ${text}`);
      st.stage = "decided";
      return null;
    }
    const r = this.script("staleness", "staleness.mjs", ["--path", path, `--${token}`, "--", text]);
    if (r.status === 0) {
      st.staleness.push(`${token} check at ${path}: still reproduces`);
      return null;
    }
    let payload = null;
    try {
      payload = JSON.parse(r.stdout);
    } catch {
      // Not JSON: the reason below comes from its words.
    }
    if (r.status === 1 && typeof payload?.commit === "string" && payload.commit !== "") {
      st.close = { mode: token, path, needle: text, commit: payload.commit, subject: null };
      return null;
    }
    let reason;
    if (r.status === 1) {
      reason = payload !== null && typeof payload === "object"
        ? "the probe read the ticket as fixed and named no commit"
        : `the probe exited 1 with no verdict JSON, which is a crash and no verdict: ${(r.stderr || r.stdout || r.how).split("\n")[0]}`;
    } else {
      reason = typeof payload?.why === "string" ? payload.why : (r.stderr || r.stdout || r.how).split("\n")[0];
    }
    st.staleness.push(`could-not-check: ${reason}`);
    return null;
  }

  answer_close(token, text) {
    const { st } = this;
    const c = st.close;
    if (token === "no") {
      st.staleness.push(`staleness probe read --${c.mode} in ${c.path} as fixed by ${c.commit}: ${c.subject}; kept by the controller: ${text}`);
      st.close = null;
      return null;
    }
    const r = this.gh("close", ["issue", "close", String(st.ticket), "--comment", closeComment(c.commit, c.subject)]);
    if (r.status !== 0) return this.stop(withText(`gh issue close failed (${r.how})`, r));
    return this.leave(`closed: fixed by ${c.commit}: ${c.subject}`);
  }

  answer_decided(token, text) {
    const { st } = this;
    if (token === "decided") {
      st.stage = "collision";
      return null;
    }
    const { label, comment } = relabel(token, text);
    // One comment per cause: an edit that failed after its comment landed is
    // answered again without a second comment.
    if (st.commented !== comment) {
      const c = this.gh("relabel", ["issue", "comment", String(st.ticket), "--body", comment]);
      if (c.status !== 0) return this.stop(withText(`gh issue comment failed (${c.how})`, c));
      st.commented = comment;
      this.save();
    }
    const e = this.gh("relabel", ["issue", "edit", String(st.ticket), "--remove-label", READY, "--add-label", label]);
    if (e.status !== 0) return this.stop(withText(`gh issue edit failed (${e.how}) — the comment is posted`, e));
    return this.leave(`relabelled ${label}: ${token}`);
  }

  answer_collision(token, text) {
    const { st } = this;
    if (token === "clear") {
      st.stage = "claim";
      return null;
    }
    // The stage stays at collision, so the scan runs again and the question is asked again.
    if (token === "paths") {
      for (const p of text.split(/\s+/)) if (!st.addedPaths.includes(p)) st.addedPaths.push(p);
      return null;
    }
    const r = this.script("exclude", "ledger.mjs", ["row", String(st.ticket), `excluded · ${token}`]);
    if (r.status !== 0) return this.stop(withText(`ledger.mjs row failed (${r.how})`, r));
    return this.leave(`excluded · ${token}`);
  }
}

// ── the shortlist head ───────────────────────────────────────────────────────

// Whether an exclusion's premises still hold: a premise `gh` cannot be asked
// about, or whose state could not be read, stands, as the shortlist's refresh
// reads it. Each such premise is added to `unreadable`, so that a shortlist
// emptied by premises nobody could read is told apart from an empty one.
function exclusionLive(premises, cwd, unreadable) {
  if (premises.length === 0) return true;
  for (const { kind, target } of premises) {
    if (target.startsWith("-") || !(kind === "pr" || isDigits(target))) return true;
    const r = spawn("gh", [kind, "view", target, "--json", "state"], { cwd, env: GH_ENV, timeoutMs: NETWORK_TIMEOUT_MS });
    if (r.status !== 0) {
      unreadable.push(`gh ${kind} view ${target} (${r.how}${r.stderr === "" ? "" : `: ${r.stderr.split("\n")[0]}`})`);
      return true;
    }
    let state;
    try {
      ({ state } = JSON.parse(r.stdout));
    } catch {
      unreadable.push(`gh ${kind} view ${target} (printed no JSON state)`);
      return true;
    }
    if (!LIFTED.has(state)) return true;
  }
  return false;
}

// The phase-0 session names the run a Pull belongs to: the persistent scratch
// root holds every run's records, and only this run's are this run's. Null when
// the receipt names none, which the claim step refuses in its own words.
function currentRun(cwd) {
  try {
    return sessionFromReceipt({ cwd });
  } catch {
    return null;
  }
}

/** The first shortlist entry still to be pulled, or null when the list holds none. */
function shortlistHead(p, run) {
  let list;
  try {
    list = JSON.parse(readFileSync(p.shortlist, "utf8"));
  } catch (e) {
    throw new Refusal(`cannot read ${p.shortlist} (${e.code ?? e.message}) — run shortlist.mjs`);
  }
  if (!Array.isArray(list?.shortlist) || !list.shortlist.every((e) => Number.isInteger(e?.n))) {
    throw new Refusal(`${p.shortlist} holds no shortlist[] of {n}`);
  }
  const led = spawn(process.execPath, [join(SCRIPTS, "ledger.mjs"), "read"], { cwd: p.cwd });
  let rows;
  try {
    ({ rows } = JSON.parse(led.stdout));
  } catch {
    rows = null;
  }
  if (led.status !== 0 || !Array.isArray(rows) || !rows.every((r) => typeof r === "string")) {
    throw new Refusal(withText(`ledger.mjs read did not answer (${led.how})`, led));
  }
  const unreadable = [];
  for (const { n } of list.shortlist) {
    const row = rows.find((r) => rowKey(r) === `#${n}`);
    if (row !== undefined && isImplRow(row)) continue;
    const premises = row === undefined ? null : premisesOf(row);
    if (premises !== null && exclusionLive(premises, p.cwd, unreadable)) continue;
    const ended = readPull(p.statePath(n));
    if (ended !== null && (ended.status === "left" || ended.status === "released") && (run === null || ended.session === run)) continue;
    return n;
  }
  if (unreadable.length > 0) {
    throw new Refusal(`no entry to pull, and gh could not read the premise of an exclusion, which stands: ${unreadable.join("; ")} — run again once gh answers`);
  }
  return null;
}

// ── the commands ─────────────────────────────────────────────────────────────

function setup() {
  let fleetDir;
  try {
    fleetDir = fleetFile(null);
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    throw new Refusal(e.message);
  }
  const cwd = dirname(fleetDir);
  const top = spawn("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (top.status !== 0 || realpathSync(top.stdout) !== realpathSync(cwd)) {
    throw new Usage(`run this from the main checkout ${cwd}${top.status === 0 ? `, not ${top.stdout}` : ""}`);
  }
  const root = spawn(process.execPath, [join(SCRIPTS, "scratch-root.mjs")], { cwd });
  if (root.status !== 0) throw new Refusal(withText(`scratch-root.mjs ${root.how}`, root));
  const scratch = root.stdout;
  const dir = (n) => join(scratch, `impl-${n}`);
  return {
    cwd,
    scratch,
    shortlist: join(fleetDir, "shortlist.json"),
    guard: join(fleetDir, "cost-guard.json"),
    statePath: (n) => join(dir(n), STATE),
    previousPath: (n) => join(dir(n), PREVIOUS),
    issuePath: (n) => join(dir(n), "issue.json"),
  };
}

const pullFor = (base, st) => new Pull(st, { ...base, state: base.statePath(st.ticket), issue: base.issuePath(st.ticket) });

function parseNext(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--head" || !isDigits(args[1]) || Number(args[1]) < 1) {
    throw new Usage(`next takes only --head <N>, a ticket number — ${USAGE}`);
  }
  return Number(args[1]);
}

function next(args) {
  const head = parseNext(args);
  const base = setup();
  const run = currentRun(base.cwd);
  const n = head ?? shortlistHead(base, run);
  if (n === null) return result(1, ["EMPTY: the shortlist holds no entry to pull — run shortlist.mjs once and Pull again; still empty, hold the slot idle until the next refresh trigger"]);
  let st = readPull(base.statePath(n));
  if (st !== null && (st.status === "left" || st.status === "released" || (run !== null && st.session !== run))) {
    // Asked for by number, so asked for again: the ended Pull is kept beside the new one. A record from another
    // run is ended too, whatever it says: the ledger rotated, and a dispatch it made is none of this run's.
    renameSync(base.statePath(n), base.previousPath(n));
    st = null;
  }
  const first = st === null;
  if (first) st = fresh(n, run);
  const pull = pullFor(base, st);
  if (first) pull.save();
  const r = pull.advance();
  return { ...r, out: [first ? `PULL #${n}: started, state in ${base.statePath(n)}` : `PULL #${n}: resumed at ${st.pending === null ? st.stage : `question ${st.pending.qid}`}`, ...pull.log, ...r.out] };
}

function answer(args) {
  const [ticket, qid, token, ...rest] = args;
  if (token === undefined) throw new Usage(`answer needs <N> <qid> <token> — ${USAGE}`);
  if (!isDigits(ticket) || Number(ticket) < 1) throw new Usage(`'${ticket}' is not a ticket number — ${USAGE}`);
  const base = setup();
  const n = Number(ticket);
  const st = readPull(base.statePath(n));
  if (st === null) throw new Usage(`no Pull in progress for #${n} — start it with: ${NAME}.mjs next --head ${n}`);
  if (st.status !== "running") throw new Usage(`the Pull for #${n} is ${st.status}, not in progress`);
  if (st.pending === null) throw new Usage(`the Pull for #${n} has no question pending — resume it with: ${NAME}.mjs next --head ${n}`);
  if (st.pending.qid !== qid) throw new Usage(`the question pending for #${n} is ${st.pending.qid}, not ${qid}`);
  const parsed = parseAnswer(qid, token, rest);
  const pull = pullFor(base, st);
  const r = pull.answer(qid, parsed) ?? pull.advance();
  return { ...r, out: [...pull.log, ...r.out] };
}

// An unknown flag is refused the way every script that holds a command line of
// its own refuses one, through arg.mjs's die() at exit 2; every other mistake
// in the command line is exit 3.
function refuseUnknownFlags(sub, args) {
  const known = sub === "next" ? ["--head"] : [];
  for (const word of [sub, ...(sub === "next" ? args : [])]) {
    if (typeof word === "string" && word.startsWith("-") && !known.includes(word)) die(`unknown flag ${word} — ${USAGE}`);
  }
}

function main() {
  const [sub, ...args] = process.argv.slice(2);
  let r;
  try {
    refuseUnknownFlags(sub, args);
    if (sub === "next") r = next(args);
    else if (sub === "answer") r = answer(args);
    else throw new Usage(USAGE);
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`${NAME}: ${e.message}\n`);
      process.exitCode = 3;
      return;
    }
    // Node exits 1 on an uncaught throw, and 1 here means the ticket left the
    // Pull: a crash must never read as a verdict.
    process.stderr.write(`${NAME}: ${e instanceof Refusal ? e.message : `unexpected: ${e?.stack ?? e}`}\n`);
    process.exitCode = 2;
    return;
  }
  for (const l of r.out) process.stdout.write(`${l}\n`);
  for (const l of r.err) process.stderr.write(`${l}\n`);
  process.exitCode = r.exit;
}

if (isCLI(import.meta.url)) main();
