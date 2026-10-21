#!/usr/bin/env node
// A wake recorded as one command: the writes it owes, then the tick.
//
//   fleet-event.mjs <kind> <args> [--in-flight <n>]
//   fleet-event.mjs drain --reason "<reason>" [--in-flight <n>]
//   fleet-event.mjs undrain --reason "<reason>" [--in-flight <n>]
//
// Reached through the Resolver and run from the main checkout. Every kind
// performs its writes, then runs `fleet-tick.mjs --apply` with the In-flight
// bound — `--in-flight` as given, else the one `.fleet/phase0.json` records,
// else the tick's own default — and prints one
// `event: <kind>: <summary>` line with the tick's output verbatim after it.
// Every kind is idempotent: a second run finds its writes made and only ticks
// again.
//
// `<scratch>` below is the phase-0 receipt's `scratch`, else the root
// scratch-root.mjs prints; every settle reads its report under
// `<scratch>/reports` (`--reports`). A member the ledger already holds
// settled, under any outcome, is not settled again.
//
//   impl-report <impl-N[-x]>
//       `ledger.mjs settle <member> --from-report`, which runs `verify-sha.sh` and reads the PR itself. Settled `bailed`: the
//       report's `bailCause` names the label (undecided `needs-triage`, fork,
//       hands and covered `ready-for-human`), then:
//         `gh issue edit <N> --remove-label ready-for-agent --remove-label
//         in-progress --add-label <label>`, skipped when the issue already
//         carries the label and neither of the others;
//         `gh issue comment <N>` with the comment `dispatch-prompt.mjs render
//         relabel` renders from the report's `bailDetail` — kind
//         `needs-triage` (`--line`), `fork` (`--options`), `covered`
//         (`--detail`, `PR#M — <how>`), or `hands`, whose
//         detail opens with the cause the Pull's answer names (`external
//         access`, `manual testing`, `judgment`) and goes on with the line —
//         skipped when the issue already carries that comment;
//         `release-ticket.sh <N> impl-<N> implementer --apply`, only once the
//         label is in place, since the release drops `in-progress` itself.
//         It runs on a second run too: it measures the claim again and
//         writes nothing when nothing is left to release. A refusal prints
//         `NEED hand-release #<N> <blocker>` and is never forced.
//         Dropping `in-progress` is the load-bearing half: phase 1 applied it and `candidates.mjs` excludes it, so leaving it makes the ticket invisible to the controller's scans and the maintainer's. It does not loop; it disappears.
//         `reap.sh` declines a claim that never became a PR, so the release of a bailed claim is `release-ticket.sh`'s.
//       A `fixed` bail takes no label. Its `bailDetail` is `<sha> — <how>`,
//       and `verify-sha.sh main <sha>` decides: exit 0 closes N, `gh issue
//       close <N> --comment` with the kind `fixed` render (`--detail`, the
//       whole `bailDetail`) — no comment when the issue already carries it,
//       no close when it is already closed — then drops whichever of
//       `ready-for-agent` and `in-progress` it carries and releases as above;
//       exit 1 relabels `needs-triage` as above, its comment naming `<sha>`
//       not on origin/main, and releases; any other answer, or a detail that
//       opens with no sha, is a NEED and N is left untouched, claim and all.
//       The PR a `covered` detail names is never written to.
//       A `PR#M` outcome also sets the claim branch's upstream when it has none: `reap.sh` keeps a branch with no upstream, and only an upstream's `[gone]` state makes it reapable. It writes `branch.<b>.remote` and `branch.<b>.merge` only while the merge key is unset, and prints `NEED upstream <b> — <why>` when a write fails.
//   fix-report <fix-pr-M[-x]>
//       `settle --from-report`, which records the filings and rulings the
//       report carries. Settled `applied:`/`no-op`, on a PR whose rows carry
//       `reviewed=`, by a member whose rendered brief
//       (`.fleet/briefs/<member>.json`) is kind `review` or
//       `dispositions-retry` — a review fix-applier, not one that cleared a
//       conflict hold or a red check — and with no `dispositions-*=<member>:`
//       token on the PR's rows yet: `dispositions-check.mjs --member <member>
//       --scratch <scratch>`, its stdout printed. That script writes its own
//       verdict token; its exit 1 is a verdict, its exit 2 a NEED.
//   finisher-report <finisher-pr-M[-x]>
//       `settle --from-report`. Settled `halted:<cause>`: `gh pr comment <M>`
//       with the report's cause and evidence. A repair finisher (a retry
//       suffix) whose report claims `labelled` and whose `labelsReadBack`
//       lacks `ready-to-merge`: the one-shot escalation, `gh pr comment <M>`
//       with its read-back and the read-back of the finisher before it —
//       whether or not its settle was accepted, since the settle refuses
//       exactly that read-back. Either comment is skipped when the PR already
//       carries it.
//       A settle that refuses on `ready-to-merge` — missing from the PR or from the read-back — is the case the tick's `DISPATCH finisher PR#<M>` catches next: settle it `ledger.mjs settle finisher-pr-<M>=labelled` as reported, and `ledger.mjs filed <N> "<subject>"` for each `unrecorded` entry.
//   merge-bot-report <merge-bot-n>
//       `ledger.mjs token <pr> held-behind:#<behind>` for each `held[]` entry
//       of the report the PR's rows do not already carry, then `ledger.mjs
//       token <pr> parked=<head>:<body digest>:<reason>` for each `refused[]`
//       entry whose reason is `main-gain-removed:<path>`, bound to the head
//       and body digest the bot's gate reading `<scratch>/pr<pr>/<merge-bot-n>/ci.json`
//       records it refused, unless the rows already carry it (a reading that
//       is missing or is not that refusal is a NEED, nothing written), then
//       `settle --from-report`.
//       Every other refusal reason writes nothing. The reap and the reclaim
//       run under the tick's `--apply`.
//       The verdict moves no label and leaves nothing in the repo, so the row is the only place the tick can read a `held-behind` from.
//       The reap and the reclaim run once for every merge bot settled `done`, always, even when the pass merged nothing, and again on the next tick after an `APPLY FAILED` line, and on every tick while this run has no controller record to remember the pass by.
//       The bot may also have written `conflict-hold:#<pr>` onto a held PR's own row earlier in the same pass, before reporting: a token the bot wrote in that pass, never one `reap.sh` writes.
//   review-result <pr> <path>
//       The review result file at `<path>`, which must be
//       `<scratch>/pr<pr>/<run>/<file>`, `<run>` a review run root
//       (`run-` and eight characters) and no `..` segment: its `head` and
//       `counts` make `ledger.mjs review <pr>
//       reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`, skipped when
//       the PR's rows already carry that token.
//       The result file is `<scratch>/pr<pr>/<run>/review.json`, `<run>` the review's own `run-XXXXXXXX` run root.
//   review-failed <pr> <launch>
//       `ledger.mjs review <pr> review=<launch>=failed`, `<launch>` as the
//       PR's row spells it after `review=` (`member:<runner>` or
//       `wf:<runId>`), skipped when the rows already carry it; the summary
//       names the runner the PR's next launch takes, as `review` reports it.
//   ci <pr>
//       `ci-state.mjs --pr <pr>`, never `--quiet`, then `ledger.mjs token <pr>
//       ci=<run-id>:<attempt>:<conclusion>` on the PR's row, `<conclusion>`
//       `-` when ci-state reports it as `""` or null (an in-progress run),
//       skipped when the PR's rows already carry that token. The payload is
//       the verdict, never the exit code: not-green exits 1 and is an
//       ordinary state. A payload with no `verdict`, or `verdict:
//       rate-limited`, prints `WATCHER DEGRADED: no usable ci-state reading
//       for #<pr> — silence is NOT green` and writes nothing; a payload that
//       binds no run (`no-ci`) writes nothing either.
//       `token` appends the key to the PR's row and keeps every token already on it, where `row` would replace the whole line.
//       That key cannot be reconstructed once the head is superseded, so a controller holding only the colour cannot later tell an edge it has already spent from one that never fired.
//   label <pr>
//       No write: a `ready-to-merge` label was seen, and the tick is the whole
//       of the event.
//   conflict <pr>
//       The tick's `CONFLICT` line for the PR, recorded: `ledger.mjs token
//       <pr> conflict-hold:#<pr>`, no note beside it (`token` refuses any
//       `conflict-hold` word that is not `conflict-hold:#<number>`, spelled
//       with `:` or `-`). `token` appends the hold and keeps every token the row already carries, where `row` would replace the whole line.
//       Refused, nothing written, exit 2, when the PR's row already carries a
//       hold no fix-applier has answered (the tick's own reading of the row),
//       or both spellings. A row whose one hold a fix-applier answered takes
//       the other spelling, `conflict-hold-#<pr>`: `token` writes no word the
//       row already carries, and the tick reads a fresh hold after an answer
//       as unresolved.
//   heartbeat
//       No write: the tick runs with `--fold-unchanged`, which prints one line
//       instead of the rows when the tick asks for nothing and says what the
//       last one said. The alarm turn that runs it is started by
//       `controller-alarm.mjs`, once the beat `fleet-heartbeat.mjs` marked falls due.
//   drain --reason "<reason>"
//       `closeout.mjs begin --reason "<reason>"`, its output printed as it
//       stands, then the tick.
//       `closeout.mjs begin` drains (`ledger.mjs drain`), then releases every claim that never became a PR and settles each `impl-<N>=released`. Nothing else in the loop fires for those claims.
//       `begin` answers a second drain with the standing marker, so a second
//       run releases what is left and writes nothing else. Its exit 4 (a
//       `NEED hand-release #<N> <blocker>` line) is this script's exit 4; its
//       exit 2 or 3 is passed through. The rest of the end of a run,
//       `closeout.mjs finish` last, is the controller's.
//   undrain --reason "<reason>"
//       `closeout.mjs reopen --reason "<reason>"`, its output printed as it
//       stands, then the tick. Refused once any `finish` step is ok, and when
//       no drain marker is set; its exit 2 or 3 is passed through.
//   member-died <member>
//       Settles a member the controller has confirmed dead, then ticks. The
//       outcome comes from the session directory's listing, never from an
//       argument or a file's contents. The first marker that matches decides:
//         <m>.jsonl.tombstone                              killed
//         <m>.md, no tombstone, fix-pr or finisher-pr      failed
//         <m>.md, no tombstone, merge-bot                  killed
//         <m>.md, no tombstone, impl                       refused: settle it by hand
//         <m>.jsonl, no marker                             refused: running or parked
//         no transcript, no marker                         killed once the tick's
//                                                          first-seen stamp in
//                                                          heartbeat.json is over
//                                                          five minutes old; refused
//                                                          when younger or unstamped
//       Ahead of the markers: a review runner refuses, its death being
//       `review-failed`; a member the ledger already holds settled is noted,
//       and the tick runs; a report on disk refuses, naming the kind that
//       settles it, or its violation when that kind could not settle from
//       it. The session directory is this run's phase-0 receipt's
//       `session`, else `--session <dir>`: the tick's lookup, so another
//       run's receipt names none.
//
// A write this script cannot make, and does not refuse, is printed as a
// `NEED <what> …` line, at the left margin, for the controller to make by
// hand.
//
// Exit: 0 every write made and the tick exited 0. 2 a usage error, refused
// before anything is written or ticked: an unknown kind or flag, a `--reason`
// that is empty or beside any kind but `drain` and `undrain`, a `--session`
// beside any kind but `member-died`, any `member-died` refusal (the table's,
// a name that is no ledger member, no session directory, a session directory
// that cannot be listed, a heartbeat file that cannot be used), a member of
// the wrong family, a review path outside the PR's partition or a file that
// is no review result, a ledger or phase-0 receipt that cannot be read. A
// ledger write's own refusal — `settle`'s 3 (the report's claim and the world
// disagree) or 2, `token`'s or `review`'s 2 — passes its exit and message
// through, as do `closeout.mjs begin`'s and `reopen`'s 2 or 3 and the
// refusal of a second conflict hold (2), and the tick still runs so the
// controller sees the rows.
// Else the tick's own exit when it is not 0. Else 4 when a NEED line was
// printed, `begin`'s own exit 4 included.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, isDigits, writeAll } from "./arg.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";
import { BRIEFS, REVIEW, REVIEWED, REVIEWER, memberTokens, nextReviewerName, parseDispatchedEntry, parseMember, parseToken, readRetired, rowNums } from "./ledger-grammar.mjs";
import { NO_TRANSCRIPT_AFTER_DEFAULT, PARKS, controllerState, dispositionsToken, foldLedger, parkedToken } from "./fleet-tick.mjs";
import { phase0Gate, readRunReceipt, tickCaps } from "./phase0-receipt.mjs";
import { defaultScratch, readReportIn, reportsDir } from "./report-files.mjs";
import { readState, statePath } from "./fleet-state.mjs";

const NAME = "fleet-event";
const die = makeDie(NAME);
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;
const CHILD_TIMEOUT_MS = 300_000;
const READY = "ready-to-merge";

const KINDS = {
  "impl-report": { args: ["<member>"], family: "impl" },
  "fix-report": { args: ["<member>"], family: "fix-pr" },
  "finisher-report": { args: ["<member>"], family: "finisher-pr" },
  "merge-bot-report": { args: ["<member>"], family: "merge-bot" },
  "review-result": { args: ["<pr>", "<path>"], pr: true },
  "review-failed": { args: ["<pr>", "<launch>"], pr: true },
  ci: { args: ["<pr>"], pr: true },
  label: { args: ["<pr>"], pr: true },
  conflict: { args: ["<pr>"], pr: true },
  heartbeat: { args: [] },
  drain: { args: [], flag: "--reason \"<reason>\"" },
  undrain: { args: [], flag: "--reason \"<reason>\"" },
  "member-died": { args: ["<member>"] },
};
const FLAGS = { "in-flight": "value", reason: "value", session: "value" };
const USAGE = `usage: ${NAME}.mjs <kind> <args> [--in-flight <n>] — kinds: `
  + Object.entries(KINDS).map(([k, { args, flag }]) => [k, ...args, ...(flag ? [flag] : [])].join(" ")).join(", ");

// The label each `bailCause` demotes to, and the relabel template's kind.
// `fixed` takes no label: it closes the ticket once `verify-sha.sh` finds the
// commit on origin/main, and demotes to `needs-triage` when it does not.
export const BAILS = {
  undecided: { label: "needs-triage", kind: "needs-triage", flag: "line" },
  fork: { label: "ready-for-human", kind: "fork", flag: "options" },
  hands: { label: "ready-for-human", kind: "hands" },
  covered: { label: "ready-for-human", kind: "covered", flag: "detail" },
  fixed: { kind: "fixed", flag: "detail" },
};
// The commit a `fixed` bail's detail opens with.
export const FIXED_SHA = /^([0-9a-f]{7,40})(?![0-9A-Za-z])/;
// The causes a `hands` detail opens with — the Pull's answer grammar — and the
// words each puts in the comment.
const HANDS = { "external access": "external access", "manual testing": "manual testing", judgment: "judgment during the work" };
// The fix-applier brief kinds that answer a review and so write a disposition
// record.
const REVIEW_FIX_KINDS = new Set(["review", "dispositions-retry"]);

// ── children ────────────────────────────────────────────────────────────────

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

/**
 * Runs a child to completion from the cwd, every one with GIT_DIR and
 * GIT_WORK_TREE scrubbed and GH_REPO blanked, so no ambient value points a
 * write at another repository. `status` is null when the child never ran or
 * was killed.
 */
function run(cmd, args, timeoutMs = CHILD_TIMEOUT_MS) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv({ GH_REPO: "" }), timeout: timeoutMs });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", how: how(r) };
}

const node = (script, args) => run(process.execPath, [join(SCRIPTS, script), ...args]);
const gh = (args) => run("gh", args, GH_TIMEOUT_MS);

// What a failed child said: the last line of its stderr, else of its stdout —
// its own end says why it stopped — else how it ended.
const said = (r) => [r.stderr, r.stdout].map((s) => s.trim().split("\n").at(-1)).find(Boolean) || r.how;

// ── the run's state ─────────────────────────────────────────────────────────

/** The ledger as `ledger.mjs read` prints it. */
function readLedger() {
  const r = node("ledger.mjs", ["read"]);
  if (r.status !== 0) die(`ledger.mjs read failed (${r.how}): ${said(r)} — nothing written`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return die(`ledger.mjs read printed no JSON: ${e.message} — nothing written`);
  }
}

/** Every member token the ledger holds: its rows', then `## Dispatched`'s. */
const ledgerMembers = (ledger) => [
  ...ledger.rows.flatMap(memberTokens),
  ...ledger.dispatched.map((e) => parseToken(parseDispatchedEntry(e).token)),
].filter((t) => t !== null && t.error === null);

/** The outcome the ledger records for `member`, or null while it is live or unknown. */
const settledOutcome = (ledger, member) => ledgerMembers(ledger).find((t) => t.name === member && t.outcome !== null)?.outcome ?? null;

/** Every word of the rows PR `pr` maps to. */
const prWords = (ledger, pr) => ledger.rows.filter((r) => rowNums(r).pr === pr).flatMap((r) => r.split(/\s+/).filter(Boolean));

// ── the event's record ──────────────────────────────────────────────────────

class Event {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.lines = [];
    this.summary = [];
    this.needs = 0;
    // The exit of the first ledger write that refused, null while none has.
    this.refused = null;
  }

  note(text) {
    this.summary.push(text);
  }

  print(text) {
    for (const line of text.split("\n").filter((l) => l.trim() !== "")) this.lines.push(line);
  }

  need(text) {
    this.needs += 1;
    this.lines.push(`NEED ${text}`);
  }

  // A ledger write that refused: its message on stderr, its exit kept.
  refuse(what, r) {
    if (r.stderr) writeAll(2, r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    if (this.refused === null) this.refused = r.status ?? 2;
    this.note(`${what} refused (${r.how})`);
  }

  report(member) {
    return readReportIn(reportsDir(this.scratch), member);
  }

  // `settle <member> --from-report` unless the ledger holds it settled, or
  // `settle <member> <decided>` when a marker decided the outcome — never one
  // a file's contents named. Returns the outcome, or null when the settle
  // refused.
  settle(member, decided = null) {
    const before = settledOutcome(this.ledger, member);
    if (before !== null) {
      this.note(`${member}=${before} already settled`);
      return before;
    }
    const tail = decided === null ? ["--from-report", "--reports", reportsDir(this.scratch)] : [decided];
    const r = node("ledger.mjs", ["settle", member, ...tail]);
    if (r.status !== 0) {
      this.refuse(`settle ${member}`, r);
      return null;
    }
    if (r.stderr) writeAll(2, r.stderr);
    let outcome;
    try {
      ({ outcome } = JSON.parse(r.stdout));
    } catch {
      // The settle wrote; only its receipt is unreadable.
    }
    if (typeof outcome !== "string") {
      this.refuse(`settle ${member} printed no receipt`, { ...r, status: 2, stderr: `${NAME}: settle ${member} exited 0 with no receipt on stdout: ${r.stdout.trim()}\n` });
      return null;
    }
    this.note(`settled ${member}=${outcome}`);
    return outcome;
  }

  // The labels, comments and state of issue `n`, or the comments of PR `n`,
  // each comment trimmed, or null when gh could not answer (the NEED is
  // printed here).
  comments(noun, n, what) {
    const r = gh([noun, "view", String(n), "--json", noun === "issue" ? "labels,comments,state" : "comments"]);
    let v = null;
    if (r.status === 0) {
      try {
        v = JSON.parse(r.stdout);
      } catch {
        // Falls through to the NEED below.
      }
    }
    if (v === null || !Array.isArray(v.comments) || (noun === "issue" && !Array.isArray(v.labels))) {
      this.need(`${what} — gh ${noun} view ${n} did not answer (${r.status === 0 ? "no JSON" : said(r)})`);
      return null;
    }
    return { labels: (v.labels ?? []).map((l) => l?.name), bodies: v.comments.map((c) => String(c?.body ?? "").trim()), state: v.state ?? null };
  }

  // `gh <noun> comment <n> --body <body>` unless `seen` already holds it.
  comment(noun, n, body, seen, what) {
    if (seen.bodies.includes(body.trim())) {
      this.note(`${what} already on #${n}`);
      return true;
    }
    const r = gh([noun, "comment", String(n), "--body", body]);
    if (r.status !== 0) {
      this.need(`${what} #${n} — gh ${noun} comment failed: ${said(r)}`);
      return false;
    }
    this.note(`${what} posted on #${n}`);
    return true;
  }
}

// ── the kinds ───────────────────────────────────────────────────────────────

// The relabel comment's render arguments for a bail, or a reason there are none.
function relabelArgs(cause, detail) {
  const bail = BAILS[cause];
  const text = String(detail ?? "").trim();
  if (text === "") return { why: "the report's bailDetail is empty" };
  if (bail.kind !== "hands") return { args: ["--kind", bail.kind, `--${bail.flag}`, text] };
  const opener = Object.keys(HANDS).find((c) => text === c || text.startsWith(`${c} `) || text.startsWith(`${c}:`));
  const line = opener === undefined ? "" : text.slice(opener.length).replace(/^[\s:—-]+/, "");
  if (line === "") return { why: `the report's bailDetail opens with none of ${Object.keys(HANDS).join(", ")} and a line` };
  return { args: ["--kind", "hands", "--hands", HANDS[opener], "--line", line] };
}

// The comment `dispatch-prompt.mjs render relabel` renders for a bail, or null
// when there is none (the NEED, named `what`, is printed here).
function rendered(ev, ticket, cause, detail, what) {
  const relabel = relabelArgs(cause, detail);
  if (relabel.why !== undefined) {
    ev.need(`${what} #${ticket} — ${relabel.why}: comment the cause by hand`);
    return null;
  }
  const r = node("dispatch-prompt.mjs", ["render", "relabel", ...relabel.args]);
  if (r.status !== 0) {
    ev.need(`${what} #${ticket} — dispatch-prompt.mjs render relabel refused: ${said(r)}`);
    return null;
  }
  return r.stdout;
}

// Moves #ticket to `label`, then posts the comment `body()` returns, if any.
// False when the move could not be made, so nothing after it may run.
function demote(ev, ticket, label, cause, body) {
  const seen = ev.comments("issue", ticket, `relabel #${ticket} ${label}`);
  if (seen === null) return false;
  if (seen.labels.includes(label) && !seen.labels.includes("ready-for-agent") && !seen.labels.includes("in-progress")) {
    ev.note(`#${ticket} already ${label}`);
  } else {
    const e = gh(["issue", "edit", String(ticket), "--remove-label", "ready-for-agent", "--remove-label", "in-progress", "--add-label", label]);
    if (e.status !== 0) {
      ev.need(`relabel #${ticket} ${label} — gh issue edit failed: ${said(e)}`);
      return false;
    }
    ev.note(`relabelled #${ticket} ${label} (${cause})`);
  }
  const text = body();
  if (text !== null) ev.comment("issue", ticket, text, seen, "relabel comment");
  return true;
}

// A `fixed` bail: closed when its commit is on origin/main, demoted to
// `needs-triage` when it is not, untouched when that cannot be told. False
// when the claim must not be released.
function fixed(ev, ticket, detail) {
  const sha = FIXED_SHA.exec(String(detail ?? "").trim())?.[1];
  if (sha === undefined) {
    ev.need(`close #${ticket} — the report's bailDetail opens with no commit sha: check the fix on origin/main and close or relabel by hand`);
    return false;
  }
  const v = run("sh", [join(SCRIPTS, "verify-sha.sh"), "main", sha]);
  if (v.status === 1) {
    return demote(ev, ticket, "needs-triage", "fixed", () => `*Relabelled by the fleet controller.* Pulled for implementation and returned as already fixed by ${sha}: ${sha} not on origin/main.`);
  }
  if (v.status !== 0) {
    ev.need(`close #${ticket} — verify-sha.sh main ${sha} could not answer (${v.how}): ${said(v)}`);
    return false;
  }
  const body = rendered(ev, ticket, "fixed", detail, "close-comment");
  if (body === null) return false;
  const seen = ev.comments("issue", ticket, `close #${ticket}`);
  if (seen === null) return false;
  if (seen.state === "CLOSED") {
    ev.note(`#${ticket} already closed`);
  } else {
    // A comment that landed before its close failed is not posted twice.
    const c = gh(["issue", "close", String(ticket), ...(seen.bodies.includes(body.trim()) ? [] : ["--comment", body])]);
    if (c.status !== 0) {
      ev.need(`close #${ticket} — gh issue close failed: ${said(c)}`);
      return false;
    }
    ev.note(`closed #${ticket}: fixed by ${sha}`);
  }
  const stale = ["ready-for-agent", "in-progress"].filter((l) => seen.labels.includes(l));
  if (stale.length > 0) {
    const e = gh(["issue", "edit", String(ticket), ...stale.flatMap((l) => ["--remove-label", l])]);
    if (e.status !== 0) ev.need(`unlabel #${ticket} ${stale.join(" ")} — gh issue edit failed: ${said(e)}`);
  }
  return true;
}

function bailed(ev, member) {
  const ticket = parseMember(member).number;
  const read = ev.report(member);
  const cause = read.state === "ok" ? read.report.bailCause : null;
  if (!Object.hasOwn(BAILS, cause ?? "")) {
    ev.need(`relabel #${ticket} — ${member}'s report ${read.path} is ${read.state === "ok" ? `missing a bailCause` : read.state}: relabel by its cause by hand`);
    return;
  }
  const detail = read.report.bailDetail;
  const moved = cause === "fixed"
    ? fixed(ev, ticket, detail)
    : demote(ev, ticket, BAILS[cause].label, cause, () => rendered(ev, ticket, cause, detail, "relabel-comment"));
  if (!moved) return;
  const release = run("sh", [join(SCRIPTS, "release-ticket.sh"), String(ticket), `impl-${ticket}`, "implementer", "--apply"]);
  if (release.status === 0) ev.note(`released #${ticket}`);
  else ev.need(`hand-release #${ticket} ${blocker(release)}`);
}

// What release-ticket.sh refused for: the blockers of its JSON receipt, else
// the last thing it said.
function blocker(r) {
  try {
    const { blockers } = JSON.parse(r.stdout);
    if (Array.isArray(blockers) && blockers.length > 0) return blockers.join("; ");
  } catch {
    // Not a receipt: a refusal before it could write one, in prose.
  }
  return said(r);
}

// One word of a command printed for a human to paste. A branch name git
// accepts can still carry `;`, `$`, a backtick or `'`, so any word outside a
// plain charset is single-quoted, its own quotes closed, escaped and reopened.
const shellWord = (s) => (/^[\w/.@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

// The claim branch's upstream, set once a PR is opened from it. Only the merge
// key being unset triggers the write, so a configured upstream is never touched.
function claimUpstream(ev, member) {
  const read = ev.report(member);
  if (read.state !== "ok") {
    ev.need(`upstream of ${member}'s claim branch — its report ${read.path} is ${read.state}: set the upstream by hand`);
    return;
  }
  const b = read.report.branch;
  const want = `run git config ${shellWord(`branch.${b}.remote`)} origin && git config ${shellWord(`branch.${b}.merge`)} ${shellWord(`refs/heads/${b}`)}`;
  const fail = (r) => ev.need(`upstream ${b} — ${said(r)}; ${want}`);
  const exists = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]);
  if (exists.status === 1) {
    ev.note(`upstream ${b} not set: no local branch`);
    return;
  }
  if (exists.status !== 0) return fail(exists);
  const merge = run("git", ["config", "--get", `branch.${b}.merge`]);
  if (merge.status === 0) {
    ev.note(`upstream ${b} already set`);
    return;
  }
  if (merge.status !== 1) return fail(merge);
  const remote = run("git", ["config", `branch.${b}.remote`, "origin"]);
  if (remote.status !== 0) return fail(remote);
  const set = run("git", ["config", `branch.${b}.merge`, `refs/heads/${b}`]);
  if (set.status !== 0) return fail(set);
  ev.note(`upstream ${b} set`);
}

function implReport(ev, member) {
  const outcome = ev.settle(member);
  if (outcome === "bailed") bailed(ev, member);
  else if (outcome?.startsWith("PR#")) claimUpstream(ev, member);
}

function fixReport(ev, member) {
  const outcome = ev.settle(member);
  if (outcome === null) return;
  const pr = parseMember(member).number;
  if (outcome !== "no-op" && !outcome.startsWith("applied:")) {
    ev.note("no dispositions check: it answered nothing");
    return;
  }
  const words = prWords(ev.ledger, pr);
  if (!words.some((w) => REVIEWED.test(w))) {
    ev.note(`no dispositions check: PR #${pr} has no reviewed=`);
    return;
  }
  if (words.some((w) => dispositionsToken(w)?.member.name === member)) {
    ev.note(`dispositions already checked for ${member}`);
    return;
  }
  const by = `dispositions-check.mjs --member ${member} --scratch ${ev.scratch}`;
  const sidecar = join(ev.fleetDir, BRIEFS, `${member}.json`);
  let kind;
  try {
    ({ kind } = JSON.parse(readFileSync(sidecar, "utf8")));
  } catch (e) {
    ev.need(`dispositions-check ${member} — its brief ${sidecar} is unreadable (${e.code ?? e.message}), so whether it answered a review is unknown: run ${by} if it did`);
    return;
  }
  if (!REVIEW_FIX_KINDS.has(kind)) {
    ev.note(`no dispositions check: ${member} was a ${kind} fix-applier`);
    return;
  }
  const r = node("dispositions-check.mjs", ["--member", member, "--scratch", ev.scratch]);
  ev.print(r.stdout);
  if (r.status === 0 || r.status === 1) ev.note(`dispositions checked (exit ${r.status})`);
  else ev.need(`dispositions-check ${member} — nothing judged (${r.how}): ${said(r)}; run ${by} again`);
}

const listed = (labels) => (labels.length === 0 ? "(none)" : labels.join(", "));

function finisherReport(ev, member) {
  const outcome = ev.settle(member);
  const self = parseMember(member);
  const pr = self.number;
  const read = ev.report(member);
  const report = read.state === "ok" ? read.report : null;
  if (outcome?.startsWith("halted:")) {
    if (report === null) {
      ev.need(`halt-comment PR #${pr} — ${member}'s report ${read.path} is ${read.state}: comment its cause and evidence by hand`);
    } else {
      const seen = ev.comments("pr", pr, `halt-comment PR #${pr}`);
      const body = `**${member} halted: \`${report.cause}\`.**\n\n${String(report.evidence ?? "").trim()}`;
      if (seen !== null) ev.comment("pr", pr, body, seen, "halt comment");
    }
  }
  // The escalation is for a repair finisher that claims the label and reads
  // back none; a halt says why in its own comment above.
  if (self.retry === null || report?.outcome !== "labelled" || report.labelsReadBack.includes(READY)) return;
  const earlier = ledgerMembers(ev.ledger)
    .filter((t) => t.family === "finisher-pr" && t.number === pr && (t.retry ?? "") < self.retry)
    .sort((a, b) => (a.retry ?? "").localeCompare(b.retry ?? "")).at(-1)?.name;
  let before = "no earlier finisher on the ledger";
  if (earlier !== undefined) {
    const prior = ev.report(earlier);
    before = prior.state === "ok" ? `${earlier} read back: ${listed(prior.report.labelsReadBack)}` : `${earlier}'s report ${prior.path} is ${prior.state}`;
  }
  const body = `**${member}, a repair finisher, read back no \`${READY}\` on PR #${pr}.**\n\n`
    + `- ${member} read back: ${listed(report.labelsReadBack)}\n- ${before}`;
  const seen = ev.comments("pr", pr, `escalation-comment PR #${pr}`);
  if (seen !== null) ev.comment("pr", pr, body, seen, "escalation comment");
}

function mergeBotReport(ev, member) {
  const read = ev.report(member);
  for (const { pr, behind } of read.state === "ok" ? read.report.held : []) {
    const tok = `held-behind:#${behind}`;
    if (prWords(ev.ledger, pr).includes(tok)) {
      ev.note(`#${pr} already ${tok}`);
      continue;
    }
    const r = node("ledger.mjs", ["token", String(pr), tok]);
    if (r.status === 0) ev.note(`#${pr} ${tok}`);
    else ev.refuse(`token #${pr} ${tok}`, r);
  }
  for (const { pr, reason } of read.state === "ok" ? read.report.refused : []) {
    if (PARKS.test(reason)) park(ev, member, pr, reason);
  }
  ev.settle(member);
}

// `ledger.mjs token <pr> parked=<head>:<body digest>:<reason>` for a refusal
// only a human edit clears, bound to the head and body the gate refused: the
// bot's own gate reading, `<scratch>/pr<pr>/<member>/ci.json` (run-merge-bot.md
// step 3's `--out`), never a read taken now, so a push or a body edit landing
// after the refusal is never what gets parked. Skipped when the PR's rows
// already carry that token. A reading that cannot be read, is not JSON, is not
// this refusal, or carries no full head and body digest is a NEED naming
// which, nothing written: a park bound to no refused head would never lift.
function park(ev, member, pr, reason) {
  const file = join(ev.scratch, `pr${pr}`, member, "ci.json");
  let g;
  try {
    g = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    ev.need(`park PR #${pr} ${reason} — the gate reading ${file} ${e instanceof SyntaxError ? "is not JSON" : `cannot be read (${e.code ?? e.message})`}; nothing parked`);
    return;
  }
  const off = g === null || typeof g !== "object" ? "is not a JSON object"
    : g.pr !== pr || g.verdict !== "blocked" || g.reason !== reason ? `is not this refusal (pr ${g.pr}, verdict ${g.verdict}, reason ${g.reason})`
    : null;
  const tok = off === null ? parkedToken(g.head, g.bodyDigest, reason) : null;
  if (tok === null) {
    ev.need(`park PR #${pr} ${reason} — the gate reading ${file} ${off ?? `carries no full head and body digest (head ${g.head}, bodyDigest ${g.bodyDigest})`}; nothing parked`);
    return;
  }
  if (prWords(ev.ledger, pr).includes(tok)) {
    ev.note(`#${pr} already ${tok}`);
    return;
  }
  const w = node("ledger.mjs", ["token", String(pr), tok]);
  if (w.status === 0) ev.note(`#${pr} ${tok}`);
  else ev.refuse(`token #${pr} ${tok}`, w);
}

// `p` with its symlinks resolved, or as written when it does not exist yet.
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// The run name of a review result file at `path` in PR `pr`'s partition of
// `scratch`, or die naming why it is not one.
function reviewRun(scratch, pr, path) {
  if (path.split("/").includes("..")) die(`review-result: ${path} has a ".." segment — pass the result file's path without one`);
  const file = resolve(path);
  const runRoot = dirname(file);
  const partition = join(normalize(scratch), `pr${pr}`);
  if (real(dirname(runRoot)) !== real(partition)) die(`review-result: ${file} is not under PR #${pr}'s partition ${partition}/ — nothing written`);
  const run = basename(runRoot);
  if (!/^run-[A-Za-z0-9]{8}$/.test(run)) die(`review-result: ${runRoot} is not a review run root (run- and eight characters) — nothing written`);
  return { file, run };
}

function reviewResult(ev, pr, path) {
  const { file, run } = reviewRun(ev.scratch, pr, path);
  let result;
  try {
    result = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    die(`review-result: cannot read ${file}: ${e.code ?? e.message} — nothing written`);
  }
  if (result?.pr !== undefined && Number(result.pr) !== pr) die(`review-result: ${file} is PR #${result.pr}'s review, not #${pr}'s — nothing written`);
  const { survived, refuted, unverified } = result?.counts ?? {};
  const token = `reviewed=${result?.head}:${survived}/${refuted}/${unverified}:${run}`;
  if (!REVIEWED.test(token)) die(`review-result: ${file} carries no head and counts a reviewed= token can name (${token}) — nothing written`);
  if (prWords(ev.ledger, pr).includes(token)) {
    ev.note(`PR #${pr} already ${token}`);
    return;
  }
  const r = node("ledger.mjs", ["review", String(pr), token]);
  if (r.status === 0) ev.note(`PR #${pr} ${token}`);
  else ev.refuse(`review #${pr} ${token}`, r);
}

function reviewFailed(ev, pr, launch) {
  const tok = `review=${launch.replace(/^review=/, "")}=failed`;
  if (!REVIEW.test(tok)) {
    die(`review-failed: '${launch}' is not a launch — member:<runner> or wf:<runId>, as the PR's row spells it after review=`);
  }
  let next;
  if (prWords(ev.ledger, pr).includes(tok)) {
    ev.note(`PR #${pr} already ${tok}`);
    // `## Retired` read as `ledger.mjs review` reads it, refusing a line that
    // names no member or reviewer as `review` does.
    const { names, malformed } = readRetired(ev.ledger.retired);
    if (malformed.length > 0) {
      ev.refuse(`next free runner for PR #${pr}`, { status: 2, how: "exit 2",
        stderr: `${NAME}: ## Retired has a line '${malformed[0]}' that names no member or reviewer — fix the ledger by hand before review can trust it\n` });
      return;
    }
    next = nextReviewerName(ev.ledger.rows, pr, names);
  } else {
    const r = node("ledger.mjs", ["review", String(pr), tok]);
    if (r.status !== 0) {
      ev.refuse(`review #${pr} ${tok}`, r);
      return;
    }
    ev.note(`PR #${pr} ${tok}`);
    try {
      ({ next } = JSON.parse(r.stdout));
    } catch {
      // The write landed; only the name is unread, and the summary says so.
    }
  }
  ev.note(next === undefined ? "next free runner unread: review printed no receipt"
    : next === null ? "no free runner name left" : `next free runner ${next}`);
}

// The line the CI watcher prints for a PR whose ci-state reading it cannot use.
const degraded = (pr) => `WATCHER DEGRADED: no usable ci-state reading for #${pr} — silence is NOT green`;

function ci(ev, pr) {
  const r = node("ci-state.mjs", ["--pr", String(pr)]);
  let payload = null;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    // No payload is a reading that cannot be used, judged below.
  }
  // The payload is the verdict, never the exit: not-green exits 1 and is an
  // ordinary state.
  const verdict = payload?.verdict;
  if (typeof verdict !== "string" || verdict === "" || verdict === "rate-limited") {
    ev.print(degraded(pr));
    ev.note(`#${pr} ci: no usable ci-state reading, nothing written`);
    return;
  }
  const { runId, attempt, conclusion } = payload;
  if (!isDigits(String(runId)) || !isDigits(String(attempt))) {
    ev.note(`#${pr} ci: verdict ${verdict} binds no run, nothing to record`);
    return;
  }
  // `""` is an in-progress run, which `//` would pass through as a conclusion.
  const tok = `ci=${runId}:${attempt}:${conclusion === null || conclusion === undefined || conclusion === "" ? "-" : conclusion}`;
  if (prWords(ev.ledger, pr).includes(tok)) {
    ev.note(`#${pr} already ${tok}`);
    return;
  }
  const w = node("ledger.mjs", ["token", String(pr), tok]);
  if (w.status === 0) ev.note(`#${pr} ${tok}`);
  else ev.refuse(`token #${pr} ${tok}`, w);
}

// A second hold on a row that already answered one is the same word spelled
// the other way the tick reads, because `token` writes no word a row carries.
const HOLD_SPELLINGS = (pr) => [`conflict-hold:#${pr}`, `conflict-hold-#${pr}`];

function conflict(ev, pr) {
  const open = foldLedger(ev.ledger, new Set(), { lenient: true }).byPr.get(pr)?.conflictOpen === true;
  const words = prWords(ev.ledger, pr);
  const tok = HOLD_SPELLINGS(pr).find((t) => !words.includes(t));
  if (open || tok === undefined) {
    const why = open ? "an unresolved conflict hold" : "every spelling of a conflict hold the tick reads";
    writeAll(2, `${NAME}: conflict: PR #${pr}'s row already carries ${why} — nothing written\n`);
    if (ev.refused === null) ev.refused = 2;
    ev.note(`#${pr} conflict hold refused (row already holds)`);
    return;
  }
  const w = node("ledger.mjs", ["token", String(pr), tok]);
  if (w.status === 0) ev.note(`#${pr} ${tok}`);
  else ev.refuse(`token #${pr} ${tok}`, w);
}

function drain(ev, reason) {
  const r = node("closeout.mjs", ["begin", "--reason", reason]);
  ev.print(r.stdout);
  if (r.status === 0) {
    ev.note("drain begun");
  } else if (r.status === 4) {
    ev.needs += 1;
    ev.note("drain begun, a claim to hand-release");
  } else {
    ev.refuse("closeout begin", r);
  }
}

function undrain(ev, reason) {
  const r = node("closeout.mjs", ["reopen", "--reason", reason]);
  ev.print(r.stdout);
  if (r.status === 0) {
    ev.note("undrain reopened");
  } else {
    ev.refuse("closeout reopen", r);
  }
}

// ── member-died ─────────────────────────────────────────────────────────────

// fleet-tick's default `--no-transcript-after`: a member with no transcript
// whose first-seen stamp is older than this never started.
const NO_TRANSCRIPT_MS = NO_TRANSCRIPT_AFTER_DEFAULT * 60_000;

// The kind whose report settles a family — the KINDS entry naming that family
// — named in the refusal that finds one on disk.
export const reportKind = (family) => Object.keys(KINDS).find((k) => KINDS[k].family === family);

// This run's phase-0 receipt `session`, or null: the receipt phase0Gate()
// judges this run's against the controller record in heartbeat.json and that
// record's process, as fleet-tick judges it.
function runSession({ read, path }) {
  const { controller } = readState(statePath(NAME), NAME);
  return phase0Gate(read, { path, controllerAt: controller?.at, controller: controllerState(controller, NAME) }).session;
}

// The names in the session directory. A missing one reads as empty when the
// receipt named it, as the tick reads it, and refuses otherwise.
function sessionListing(session, receiptNamed) {
  try {
    return new Set(readdirSync(session));
  } catch (e) {
    if (e.code === "ENOENT" && receiptNamed) return new Set();
    return die(`member-died: cannot list the session directory ${session} (${e.code ?? e.message}) — nothing written`);
  }
}

// Settles a member the controller has confirmed dead, by the first marker
// that matches; see the header. The settle is a ledger write, so its
// refusal passes through to the exit as every other kind's does. Every other
// refusal is a die() before anything is written or ticked.
function memberDied(ev, member, receipt, flagSession) {
  const review = REVIEWER.exec(member);
  if (review !== null) die(`member-died ${member}: a review runner settles nothing; its death is review-failed ${review[1]} member:${member} — nothing written`);
  const m = parseMember(member);
  if (m === null) die(`member-died: '${member}' is not a ledger member — nothing written`);
  const before = settledOutcome(ev.ledger, member);
  if (before !== null) {
    ev.note(`${member}=${before} already settled`);
    return;
  }
  const report = ev.report(member);
  const kind = reportKind(m.family);
  if (report.state === "invalid") die(`member-died ${member}: its report ${report.path} is on disk and ${kind} cannot settle from it (${report.violation}): fix the report and run ${kind} ${member}, or settle ${member} by hand — nothing written`);
  if (report.state !== "absent") die(`member-died ${member}: its report ${report.path} is on disk; ${kind} ${member} settles it — nothing written`);
  // The session directory the tick reads: this run's receipt's `session`,
  // else `--session`. A `--session` the receipt's overrides is said, not
  // dropped in silence.
  const receiptSession = runSession(receipt);
  if (receiptSession !== null && flagSession !== null && resolve(flagSession) !== resolve(receiptSession)) {
    writeAll(2, `${NAME}: member-died ${member} reads ${receiptSession}, this run's phase-0 receipt's session, not --session ${flagSession}\n`);
  }
  const session = receiptSession ?? flagSession;
  if (session === null) die(`member-died ${member} needs the session directory: this run's phase-0 receipt names none, so pass --session <dir> — nothing written`);
  const listed = sessionListing(session, receiptSession !== null);
  const md = `${member}.md`;
  const jsonl = `${member}.jsonl`;
  if (listed.has(`${jsonl}.tombstone`)) return ev.settle(member, "killed");
  if (listed.has(md)) {
    if (m.family === "impl") die(`member-died ${member}: ${md} is in ${session} with no tombstone, and an implementer's yield is its own outcome: read agent://${member} and settle it by hand — nothing written`);
    return ev.settle(member, m.family === "merge-bot" ? "killed" : "failed");
  }
  if (listed.has(jsonl)) die(`member-died ${member}: ${member} has a transcript and no marker in ${session}, so it is running or parked; census it, kill it, then rerun — nothing written`);
  const heartbeat = statePath("fleet-event");
  const state = readState(heartbeat, "fleet-event");
  if (state.degraded) die(`member-died ${member}: ${heartbeat} ${state.degraded} — nothing written`);
  const stamp = state.seen[member];
  if (typeof stamp !== "number") die(`member-died ${member}: no transcript and no first-seen stamp in ${heartbeat}, so the tick never saw it live — nothing written`);
  const age = Date.now() - stamp;
  if (age <= NO_TRANSCRIPT_MS) die(`member-died ${member}: first seen ${Math.floor(age / 60_000)} min ago, not yet past the ${NO_TRANSCRIPT_MS / 60_000}-minute no-transcript bound — nothing written`);
  return ev.settle(member, "killed");
}

// ── main ────────────────────────────────────────────────────────────────────

function boundArg(F, name) {
  const v = F.arg(name);
  if (v === null) return null;
  if (!isDigits(v) || Number(v) < 1) die(`--${name} must be a whole number of at least 1, got '${v}'`);
  return v;
}

// The words of argv that are no flag or flag value.
function positionals() {
  const argv = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (FLAGS[argv[i].slice(2)] === "value") i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function main() {
  const F = defineFlags(die, { flags: FLAGS });
  F.sweep();
  const [kind, ...args] = positionals();
  if (!Object.hasOwn(KINDS, kind ?? "")) die(kind === undefined ? USAGE : `unknown kind '${kind}' — ${USAGE}`);
  const spec = KINDS[kind];
  if (args.length !== spec.args.length) die(`${kind} takes ${spec.args.join(" ") || "no arguments"} — ${USAGE}`);
  const inFlight = boundArg(F, "in-flight");
  const reason = F.arg("reason");
  if (kind === "drain" || kind === "undrain") {
    if (reason === null) die(`${kind} takes --reason "<reason>"`);
  } else if (reason !== null) {
    die(`--reason belongs to drain and undrain, not ${kind}`);
  }
  if (kind !== "member-died" && F.arg("session") !== null) die(`--session belongs to member-died, not ${kind}`);
  let pr = null;
  if (spec.family !== undefined) {
    const m = parseMember(args[0]);
    if (m === null || m.family !== spec.family) die(`${kind} takes a member of the ${spec.family} family, not '${args[0]}'`);
  } else if (spec.pr) {
    const digits = args[0].replace(/^#/, "");
    if (!isDigits(digits) || Number(digits) < 1) die(`${kind}: '${args[0]}' is not a PR number`);
    pr = Number(digits);
  }

  let fleetDir;
  let scratch;
  let receipt;
  try {
    fleetDir = fleetFile(null);
    receipt = readRunReceipt();
    const { read } = receipt;
    const named = read.state === "ok" ? read.receipt.scratch : undefined;
    scratch = typeof named === "string" && named !== "" ? named : defaultScratch();
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    die(e.message);
  }
  const caps = tickCaps(fleetDir);
  if (caps.error) die(`${caps.error} — nothing written`);
  const tickArgs = ["--apply", ...(inFlight === null ? caps.args : ["--in-flight", inFlight]), ...(kind === "heartbeat" ? ["--fold-unchanged"] : [])];
  const ev = new Event({ fleetDir, scratch, ledger: readLedger() });
  if (kind === "impl-report") implReport(ev, args[0]);
  else if (kind === "fix-report") fixReport(ev, args[0]);
  else if (kind === "finisher-report") finisherReport(ev, args[0]);
  else if (kind === "merge-bot-report") mergeBotReport(ev, args[0]);
  else if (kind === "review-result") reviewResult(ev, pr, args[1]);
  else if (kind === "review-failed") reviewFailed(ev, pr, args[1]);
  else if (kind === "ci") ci(ev, pr);
  else if (kind === "conflict") conflict(ev, pr);
  else if (kind === "drain") drain(ev, reason);
  else if (kind === "undrain") undrain(ev, reason);
  else if (kind === "member-died") memberDied(ev, args[0], receipt, F.arg("session"));

  writeAll(1, `${[...ev.lines, `event: ${kind}: ${ev.summary.join("; ") || "nothing to record"}`].join("\n")}\n`);
  const tick = spawnSync(process.execPath, [join(SCRIPTS, "fleet-tick.mjs"), ...tickArgs], { stdio: ["ignore", "inherit", "inherit"], env: gitEnv() });
  const tickExit = tick.error || tick.status === null ? 2 : tick.status;
  if (tick.error || tick.signal) writeAll(2, `${NAME}: fleet-tick.mjs did not finish (${how(tick)})\n`);
  process.exitCode = ev.refused ?? (tickExit !== 0 ? tickExit : ev.needs > 0 ? 4 : 0);
}

if (isCLI(import.meta.url)) main();
