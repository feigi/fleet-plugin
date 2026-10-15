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
// `excluded` row and no Pull of its own already ended this run — or resumes the
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
//       that failed, a router that refused (its claim released first). The
//       Pull stays where it was, so running it again retries that step.
//   3   usage: a bad command line, or an answer the pending question does not
//       take. Nothing is recorded.
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
//                 from the probe asks Q1b `close`: `yes` closes the issue with
//                 a comment citing the probe's commit and that commit's
//                 subject, `no <why>` asks Q1 again. Exit 2 is recorded as
//                 `could-not-check: <reason>` and carried into the brief.
//   4  Q2 decided     `decided`, or a cause whose comment is posted and whose
//                 label replaces `ready-for-agent`.
//   5  Q3 collision   `clear`, `behind-pr:#M`, `behind-issue:#M`. The script
//                 prints the brief's paths and the open PR numbers and runs no
//                 scan of its own. An exclusion is a ledger row.
//   6  claim      `claim-ticket.sh <N> impl-<N> implementer --apply`.
//   7  route      `ticket-router.mjs route …`; a router that refuses releases
//                 the claim. `--chain-head` is given when a ledger row reads
//                 `excluded · behind-issue:#<N>`: another open ticket
//                 sequences after this one.
//   8  row, render, dispatch   `ledger.mjs row`, `dispatch-prompt.mjs render
//                 implementer --member impl-<N>`, `ledger.mjs dispatch`.
//
// THE STATE is `<scratch>/impl-<N>/pull.json`: every command run (script, its
// arguments, exit status, bounded stdout, time), every question asked and every
// answer with its text and time, and where the Pull stands. A Pull that left
// the Pull (exit 1) or was refused by the router is held as `pull.previous.json`
// when `next --head <N>` starts the ticket over.
//
// No judgement lives here: the script offers evidence and takes a token.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDigits, writeAll } from "./arg.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { memberTokens, premisesOf, tierValues } from "./ledger-grammar.mjs";
import { sessionFromReceipt } from "./phase0-receipt.mjs";
import { briefPaths, briefText } from "./ticket-router.mjs";

const NAME = "pull";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
const PR_LIMIT = 1000;
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

/** The `Out of scope` section of `text`, heading to the next heading of its level or above; null when there is none. */
export function outOfScope(text) {
  const all = text.split("\n");
  const at = all.findIndex((l) => /^#{1,6}\s*out of scope\b/i.test(l));
  if (at === -1) return null;
  const level = /^#+/.exec(all[at])[0].length;
  let end = all.length;
  for (let i = at + 1; i < all.length; i++) {
    const h = /^(#{1,6})\s/.exec(all[i]);
    if (h !== null && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return all.slice(at, end).join("\n").trim();
}

// ── children ─────────────────────────────────────────────────────────────────

const trimmed = (s) => String(s ?? "").trim();
const cap = (s) => (s.length > RECORD_MAX ? `…${s.slice(-(RECORD_MAX - 1))}` : s);
const now = () => new Date().toISOString();

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

/** `status` is the exit status, null when the child never ran or was killed (`how` says which). */
function spawn(cmd, args, { cwd, env, timeoutMs } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(env), timeout: timeoutMs });
  const stdout = trimmed(r.stdout);
  const stderr = trimmed(r.stderr);
  return { status: r.error ? null : r.status, stdout, stderr, text: [stdout, stderr].filter(Boolean).join("\n"), how: how(r) };
}

const GH_ENV = { GH_REPO: "" };
const withText = (head, r) => (r.text ? `${head}\n${r.text}` : head);

// ── the state ────────────────────────────────────────────────────────────────

function fresh(ticket) {
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
    openPrs: null,
    session: null,
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
const COLLISION_TOKENS = ["clear", "behind-pr:#M", "behind-issue:#M"];

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
    return this.exec(step, file, cmd, [join(SCRIPTS, file)], args, opts, shown);
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
    const found = outOfScope(text) ?? outOfScope(String(issue.body ?? ""));
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

  collisionContext() {
    const paths = briefPaths(briefText(this.issue()).trim());
    const prs = this.st.openPrs;
    return [
      `paths the brief names: ${paths.length === 0 ? "(none)" : paths.join(" ")}`,
      `open PRs: ${prs.length === 0 ? "(none)" : prs.map((n) => `#${n}`).join(" ")}`,
    ];
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

  stage_collision() {
    const { st } = this;
    if (st.openPrs === null) {
      const r = this.gh("collision", ["pr", "list", "--state", "open", "--json", "number", "--limit", String(PR_LIMIT)]);
      if (r.status !== 0) return this.stop(withText(`gh pr list failed (${r.how})`, r));
      let prs;
      try {
        prs = JSON.parse(r.stdout);
      } catch (e) {
        return this.stop(`could not parse gh pr list: ${e.message}`);
      }
      if (!Array.isArray(prs) || !prs.every((p) => Number.isInteger(p?.number))) return this.stop("gh pr list did not print a JSON array of numbered PRs");
      if (prs.length >= PR_LIMIT) return this.stop(`gh pr list came back at its cap of ${PR_LIMIT} — it may hold more PRs than it showed`);
      st.openPrs = prs.map((p) => p.number).sort((a, b) => a - b);
      this.save();
    }
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
    if (r.status === 2) return this.leave("taken (claim-ticket.sh refused the claim)");
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
      st.status = "released";
      st.outcome = { exit: 2, reason: `router ${said}`, at: now() };
      const claim = rel.status === 0 ? "its claim is released" : withText(`its claim is STILL STANDING: release-ticket.sh failed (${rel.how})`, rel);
      return this.stop(`ticket-router.mjs ${said}\n${claim}`);
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
    const r = this.script("render", "dispatch-prompt.mjs", [
      "render", "implementer", "--member", st.member, "--ticket", String(st.ticket), "--worktree", worktree,
      "--branch", `implementer/${st.ticket}-${st.member}`, "--scratch", this.p.scratch,
      "--brief", this.dispatchBrief(), "--staleness", staleness,
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
    const reason = r.status === 1
      ? "the probe read the ticket as fixed and named no commit"
      : (typeof payload?.why === "string" ? payload.why : (r.stderr || r.stdout || r.how).split("\n")[0]);
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

  answer_collision(token) {
    const { st } = this;
    if (token === "clear") {
      st.stage = "claim";
      return null;
    }
    const r = this.script("exclude", "ledger.mjs", ["row", String(st.ticket), `excluded · ${token}`]);
    if (r.status !== 0) return this.stop(withText(`ledger.mjs row failed (${r.status === null ? r.how : `exit ${r.status}`})`, r));
    return this.leave(`excluded · ${token}`);
  }
}

// ── the shortlist head ───────────────────────────────────────────────────────

// Whether an exclusion's premises still hold: a premise `gh` cannot be asked
// about, or whose state could not be read, stands, as the shortlist's refresh
// reads it.
function exclusionLive(premises, cwd) {
  if (premises.length === 0) return true;
  for (const { kind, target } of premises) {
    if (target.startsWith("-") || !(kind === "pr" || isDigits(target))) return true;
    const r = spawn("gh", [kind, "view", target, "--json", "state"], { cwd, env: GH_ENV, timeoutMs: NETWORK_TIMEOUT_MS });
    if (r.status !== 0) return true;
    let state;
    try {
      ({ state } = JSON.parse(r.stdout));
    } catch {
      return true;
    }
    if (!LIFTED.has(state)) return true;
  }
  return false;
}

/** The first shortlist entry still to be pulled, or null when the list holds none. */
function shortlistHead(p) {
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
  for (const { n } of list.shortlist) {
    const row = rows.find((r) => rowKey(r) === `#${n}`);
    if (row !== undefined && isImplRow(row)) continue;
    const premises = row === undefined ? null : premisesOf(row);
    if (premises !== null && exclusionLive(premises, p.cwd)) continue;
    const ended = readPull(p.statePath(n));
    if (ended !== null && (ended.status === "left" || ended.status === "released")) continue;
    return n;
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
  const n = head ?? shortlistHead(base);
  if (n === null) return result(1, ["EMPTY: the shortlist holds no entry to pull — run shortlist.mjs once and Pull again; still empty, hold the slot idle until the next refresh trigger"]);
  let st = readPull(base.statePath(n));
  if (st !== null && (st.status === "left" || st.status === "released")) {
    // Asked for by number, so asked for again: the ended Pull is kept beside the new one.
    renameSync(base.statePath(n), base.previousPath(n));
    st = null;
  }
  const first = st === null;
  if (first) st = fresh(n);
  const pull = pullFor(base, st);
  if (first) pull.save();
  const r = pull.advance();
  return { ...r, out: [...(first ? [`PULL #${n}: started, state in ${base.statePath(n)}`] : [`PULL #${n}: resumed at ${st.pending === null ? st.stage : `question ${st.pending.qid}`}`]), ...pull.log, ...r.out] };
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

function main() {
  const [sub, ...args] = process.argv.slice(2);
  let r;
  try {
    if (sub === "next") r = next(args);
    else if (sub === "answer") r = answer(args);
    else throw new Usage(USAGE);
  } catch (e) {
    if (e instanceof Usage) {
      writeAll(2, `${NAME}: ${e.message}\n`);
      process.exitCode = 3;
      return;
    }
    // Node exits 1 on an uncaught throw, and 1 here means the ticket left the
    // Pull: a crash must never read as a verdict.
    writeAll(2, `${NAME}: ${e instanceof Refusal ? e.message : `unexpected: ${e?.stack ?? e}`}\n`);
    process.exitCode = 2;
    return;
  }
  for (const l of r.out) writeAll(1, `${l}\n`);
  for (const l of r.err) writeAll(2, `${l}\n`);
  process.exitCode = r.exit;
}

if (isCLI(import.meta.url)) main();
