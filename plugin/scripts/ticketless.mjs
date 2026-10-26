#!/usr/bin/env node
// The Ticketless PR test as one script, so every reader that asks it asks the
// same question: is this PR one no ticket stands behind?
//
//   ticketless.mjs --pr <M> [--repo <dir>] [--ledger <file>]
//
// A Ticketless PR closes no issue in its own repository (closing-refs.mjs's
// ownClosingIssues, read off `gh pr view --json closingIssuesReferences,url`)
// and no settled `impl-<N>=PR#<M>` token in the run ledger names it. No ticket
// then supplies its acceptance mutation or its ruling. The tokens are read
// through `ledger.mjs read`, as tier-check.mjs reads the ledger, and
// tier-outcomes.mjs's implementerClaims() decides which tokens name the PR.
//
// `--repo` is the directory `gh` runs in and the run ledger is resolved from
// (the cwd when omitted), against the git common dir as `ledger.mjs` resolves
// it; `--ledger` names the ledger file instead. A ledger that cannot be
// resolved is exit 2: `ledger.mjs`'s own cwd-relative fallback is never taken,
// since an empty cwd-local ledger would answer Ticketless. Reached through the
// Resolver: `~/.fleet/bin/fleet-run ticketless.mjs ...`.
//
// Stdout is one JSON line:
//
//   {verdict, exit, pr, closing, tickets, reason}
//
//   verdict  "ticketless", "ticketed" or "unknown"
//   exit     0 ticketless, 1 ticketed, 2 could not look
//   closing  the issue numbers the PR closes in its own repository, or null
//   tickets  the tickets the settled impl tokens naming the PR carry, or null
//   reason   null, or on exit 2 what could not be read
//
// Exit vocabulary:
//
//   0  Ticketless: the PR closes no own-repository issue and no settled impl
//      token names it
//   1  not Ticketless: it closes an own-repository issue, or a settled impl
//      token names it
//   2  could not look: a `gh` or ledger read failed, the run ledger could not
//      be resolved, or the invocation was refused — never read as either answer
//
// The test is also exported as ticketlessVerdict(), which never exits the
// process, and as isTicketless(), the predicate over what was read, for a
// caller that has read the closing references and the tokens itself.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { ownClosingIssues } from "./closing-refs.mjs";
import { fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "ticketless";
const LEDGER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ledger.mjs");
const READ_TIMEOUT_MS = 60_000;
const USAGE = "usage: ticketless.mjs --pr <M> [--repo <dir>] [--ledger <file>]";
const EXIT = { ticketless: 0, ticketed: 1, unknown: 2 };

const die = makeDie(NAME);

// The test itself: no own-repository closing issue and no settled implementer
// ticket. `closing` and `tickets` are the arrays a reader got.
export function isTicketless(closing, tickets) {
  return closing.length === 0 && tickets.length === 0;
}

// What a child printed on stderr, for a reason that names why it failed.
const why = (e) => String(e.stderr ?? "").trim().split("\n").at(-1) || e.code || e.message;

// The verdict for PR `pr`. Never exits the process: a caller in-process gets
// the same object the command prints. `repo` absent or null is the cwd, and
// `ledgerFile` absent or null is the run ledger resolved from `repo`.
export async function ticketlessVerdict({ pr, repo = null, ledgerFile = null }) {
  const result = (verdict, fields) => ({ verdict, exit: EXIT[verdict], pr, closing: null, tickets: null, reason: null, ...fields });
  const fail = (reason) => result("unknown", { reason });
  if (!Number.isInteger(pr) || pr < 1) return fail("pr is not a positive integer");
  const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv(), timeout: READ_TIMEOUT_MS, ...(repo === null ? {} : { cwd: repo }) };

  let view;
  try {
    view = JSON.parse(execFileSync("gh", ["pr", "view", String(pr), "--json", "closingIssuesReferences,url"], opts));
  } catch (e) {
    return fail(`gh pr view ${pr} --json closingIssuesReferences,url: ${why(e)}`);
  }
  let closing;
  try {
    closing = ownClosingIssues(pr, view?.url, view?.closingIssuesReferences);
  } catch (e) {
    return fail(`gh pr view ${pr} --json closingIssuesReferences,url answered ${e.message}`);
  }

  // The ledger path is resolved here, not left to `ledger.mjs read`: unable to
  // resolve it, that falls back to a cwd-relative `.fleet/ledger.md` with only
  // a warning on stderr, and reads its absence as no token at all.
  let ledgerPath = ledgerFile;
  if (ledgerPath === null) {
    try {
      ledgerPath = fleetFile("ledger.md", { cwd: repo ?? process.cwd(), timeoutMs: READ_TIMEOUT_MS });
    } catch (e) {
      return fail(`could not resolve the run ledger: ${e.message}`);
    }
  }
  let ledger;
  try {
    const out = execFileSync(process.execPath, [LEDGER_SCRIPT, "--file", ledgerPath, "read"], opts);
    ledger = JSON.parse(out);
  } catch (e) {
    return fail(`could not read the ledger: ${why(e)}`);
  }
  if (!Array.isArray(ledger?.rows) || !ledger.rows.every((r) => typeof r === "string")) return fail("ledger.mjs read printed no {rows}");
  // tier-outcomes.mjs is imported here, not at the top: its import graph is
  // several modules a caller that only wants isTicketless() never loads.
  const { implementerClaims } = await import("./tier-outcomes.mjs");
  const tickets = [...new Set(implementerClaims(ledger, pr).map((c) => c.ticket))];
  return result(isTicketless(closing, tickets) ? "ticketless" : "ticketed", { closing, tickets });
}

// A path stat cannot read at all (EACCES on a parent) is a usage refusal like a
// missing one: uncaught, it would exit 1, the not-Ticketless code, about a PR
// nobody looked at.
function isDirectory(p) {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (e) {
    return die(`cannot stat ${p}: ${e.code ?? e.message}`);
  }
}

async function main() {
  const { arg, numArg, sweep, stray } = defineFlags(die, {
    flags: { pr: "value", repo: "value", ledger: "value" },
  });
  // The sweep runs before the required-flag check, so a misspelt flag is named
  // as that and not buried under a missing-flag usage line.
  sweep();
  stray();
  const pr = numArg("pr");
  const repoArg = arg("repo");
  const ledgerArg = arg("ledger");
  if (pr === null) die(USAGE);
  if (repoArg !== null && !isDirectory(resolve(repoArg))) die(`--repo is not a directory: ${repoArg}`);

  const v = await ticketlessVerdict({
    pr,
    repo: repoArg === null ? null : resolve(repoArg),
    ledgerFile: ledgerArg === null ? null : resolve(ledgerArg),
  });
  // Exit 0 is the only code that skips the acceptance mutation, so a verdict
  // that never reached stdout must not leave it set: a lost write is the
  // could-not-look exit.
  if (!writeAll(1, `${JSON.stringify(v)}\n`)) die("the verdict could not be written to stdout");
  process.exitCode = v.exit;
}

if (isCLI(import.meta.url)) await main();
