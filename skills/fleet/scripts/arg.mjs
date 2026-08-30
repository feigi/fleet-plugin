// Shared CLI-boundary helpers for the fleet scripts: die(), arg(), has(),
// sweep(), stray().
// #367: was five drifting copies of arg(), three of has(), seven of die() in
// two incompatible shapes — one paste behind on any guard fix. One copy now;
// a fix to the contract lands here once and reaches every caller that routes
// through the helper it fixes.
//
// For die() that is all seven scripts. For the guards it is not: ledger.mjs
// splices --file/--require-file out of argv itself, in its own wording
// (#362), and imports makeDie alone — so arg()'s refusals below never reach
// it. `--file --require-file` used to take the next flag as the path, leaving
// the duplicate-filing guard to fail open at exit 0 (measured); #362 fixed
// that IN ledger.mjs, with its own copy of the `--`-prefix rule, because the
// splice has no equivalent here. That parser is still ledger.mjs's own — it
// is named here so this header is not read as covering a caller it does not,
// and so the next change to the rule below is known to need a second edit
// there. (fleet-tick.mjs also imports makeDie alone, so arg()'s refusals do
// not reach it either — but not for want of flags: it parses six of its own
// with node:util's parseArgs, and its unknown-flag, required-flag and range
// refusals are a second edit site on the same terms, as is the empty-or-blank
// value its integer guard refuses — the only one of the four spellings below
// that it hand-writes, because parseArgs takes an empty value and
// `Number("")` is 0.)
//
// Each factory takes (or returns something bound to) the caller's own die(),
// because every script's die() speaks under its own NAME — that stays
// site-specific, nothing here hardcodes a script name.

import { writeSync } from "node:fs";

// die() is writeSync, not console.error (#176/#328/#363). On a pipe,
// process.stderr.write is ASYNC and process.exit() discards whatever is
// still queued — a large forwarded child stderr (gh's own) eats the refusal
// line that follows it, because the refusal is queued last and dropped
// first. writeSync goes straight to the fd instead, so it survives.
//
// The leading newline is load-bearing, not formatting: writeSync lands while
// the forwarded child stderr may still be draining through the (async)
// stream, so without it this text can land mid-line with no separator.
// Every reader of these refusals, tests included, matches them
// line-anchored; without the leading newline they silently stop matching
// under exactly the large-stderr failure writeSync exists to survive.
//
// The write itself can still fail: once enough forwarded stderr is already
// queued on a pipe, this fd is non-blocking and writeSync throws EAGAIN.
// Uncaught, that skips process.exit(2) below and the process falls through
// to Node's default exit 1 — inverting the caller's own exit-code contract
// (#299/#328). The try/catch keeps the exit code landing regardless; the
// exit code is the contract, recovering the refusal TEXT under that exact
// race would need a retry loop and is out of scope.
export function makeDie(name) {
  return function die(msg) {
    try {
      writeSync(2, `\n${name}: ${msg}\n`);
    } catch {
      // Message may be lost; the exit code below must not be.
    }
    process.exit(2);
  };
}

// #61/#169: a flag given with no value must never read as the flag being
// absent. Every arg()-reading call site falls back with `||`/`??`, so a
// trailing flag used to silently substitute a default — the malformed
// invocation reading as a successful one.
//
// Four spellings reach that one harm, so all four are refused: no value, an
// empty or blank value, a value that is itself a `--flag`, and the
// `--flag=value` form `indexOf` cannot see (`arg()` would otherwise report
// the flag absent and the caller would fall back exactly as if it were).
// Rejecting a `--`-prefixed value does forfeit a real capability — a value
// that legitimately starts with `--` — and staleness.mjs (#238) is a caller
// that can want one: its `--gone`/`--present` value is a string quoted out of
// a ticket, and #240's is `--label ready-for-agent`. It documents the
// restriction in run-team/SKILL.md and lets the refusal land as its
// could-not-check verdict rather than working around it here, because
// refusing loudly still beats silently taking the next flag as this one's
// value.
export function makeArg(die) {
  return function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) {
      if (process.argv.some((a) => a.startsWith(`--${name}=`))) die(`--${name} needs a space-separated value, not --${name}=`);
      return null;
    }
    const value = process.argv[i + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) die(`--${name} needs a value`);
    return value;
  };
}

// #364: a boolean flag written --name=value must refuse, not read as
// absent — same fail-open class as arg()'s `=` guard above, but
// boolean-specific wording: there is no value to take, so "needs a
// space-separated value" would lie.
export function makeHas(die) {
  return function has(name) {
    if (process.argv.some((a) => a.startsWith(`--${name}=`))) die(`--${name} is a boolean flag, not --${name}=`);
    return process.argv.includes(`--${name}`);
  };
}

// #365: the guards above all answer "was this flag given well?", and none of
// them can answer "was a flag given that nothing reads?". A MISSPELLED name is
// simply never looked for, so `ci-state.mjs --pr 5 --basee main` computed a
// real verdict against the DEFAULT base and exited 0/1 with no refusal — the
// same fail-open harm as #61/#169, reached from the other side: not an absent
// value, an unread flag. It bites hardest where the caller is markdown re-read
// by a model each run (ci-state.mjs, candidates.mjs), and #173 already recorded
// one landing: a doc naming `--label` where the flag is `--require-label`.
//
// Only `--`-prefixed tokens are its business. Everything else is positional and
// is not — board.mjs's `build`/`serve` subcommands, and every valued flag's
// value. A value can never legitimately BE a `--` token either, because arg()
// above refuses `--base --other` outright, so there is nothing to skip over and
// no need to know here which names take a value.
//
// #463: that leftover class — a bare or single-dash token nothing reads,
// `ci-state.mjs --pr 42 basee main` or `-basee` — is not this function's fix,
// and stays out of scope here for the same reason board.mjs's subcommands are:
// this sweep still refuses ONLY a `--`-prefixed token, unchanged. makeStray()
// below covers it instead, because unlike this sweep it DOES need to know
// which names take a value, to skip over one instead of refusing it.
//
// The `=` form is looked up by NAME alone: `--base=main` stays arg()/has()'s to
// refuse in their own wording, while `--basee=main` is caught here. The token
// is then echoed verbatim rather than the parsed name, so the refusal quotes
// what the caller actually typed.
//
// Callers put the call BELOW their own value guards, the way candidates.mjs
// places its parseArgs, so where both would refuse the more specific wording
// wins — `diff-stats.mjs --pr --json` still reports "--pr needs a value" and
// not the stray behind it. Nothing above those guards runs a query, so it is
// still a refusal before gh.
//
// One deliberate exception: board.mjs sweeps ABOVE its `cmd`, for the reason
// its own comment gives — so `board.mjs --prot 9000` names the stray rather
// than printing the usage line for a missing subcommand. The cost is that
// `build --ledger --bogus` gets this generic wording instead of "--ledger
// needs a value"; both exit 2, both name a real error, both refuse before gh.
//
// candidates.mjs deliberately does NOT route through this. It accepts no
// positionals, so its parseArgs (#173) additionally refuses a bare
// `candidates.mjs ready-for-agent` — which this cannot, board.mjs's
// subcommands being exactly that shape. Strictly stronger there; leave it.
//
// ledger.mjs is left out for the opposite reason: its `check`/`filed` take a
// FREE-TEXT tail, where a `--` token is legitimately DATA — `check
// "--require-file silently absent when value missing"` works today and is the
// shape of issue titles in this repo — so this sweep would refuse working
// invocations, which #365's own AC calls worse than the bug. The cost is that
// a stray flag in that tail is still absorbed into the duplicate-filing
// subject at exit 0. Measured, unowned since #362 closed without covering it,
// and tracked in #584; do not close it with a bare `startsWith("--")` guard.
export function makeSweep(die) {
  return function sweep(known) {
    for (const a of process.argv.slice(2)) {
      if (a.startsWith("--") && !known.includes(a.slice(2).split("=")[0])) {
        die(`unknown flag ${a} — accepted: ${known.map((k) => `--${k}`).join(", ")}`);
      }
    }
  };
}

// #463: sweep() above only ever refuses a `--`-prefixed token — deliberately,
// per its own comment, because staying ignorant of which names take a value
// is what keeps it from having to refuse board.mjs's `build`/`serve` or any
// flag's own value. That leaves the OTHER half of "was a flag given that
// nothing reads?" open: a bare word or a single dash, which sweep's
// `startsWith("--")` check was never going to catch — `ci-state.mjs --pr 42
// basee main` runs the compare against the DEFAULT base and reports a real,
// wrong verdict at exit 0/1, the same fail-open harm as #365 reached from the
// positional side rather than the misspelled-flag side. `-basee` is the
// likelier typo of the two, since the caller plainly meant a flag.
//
// Widening sweep's own bound past `--` cannot fix this — #365's triage ruling
// is explicit that the sweep must never refuse tokens outside it, and
// board.mjs's subcommands are exactly the shape a widened sweep would catch
// by mistake. Nor can `startsWith("-")`: it refuses a legitimate negative
// value such as `--spend-since -1`, which arg() accepts today. The only way
// to tell a stray from a value is to know, by NAME, which flags take one —
// so unlike every guard above, this one takes that set as an argument
// instead of discovering it from argv.
//
// `positionals` is the script's own declared grammar for the one slot ahead
// of its flags — board.mjs's `build`/`serve`; every other caller passes
// none. Only the FIRST non-flag token can fill that slot; a second one, or
// any positional at all on a script that declares none, is refused by name.
//
// Every `--`-prefixed token here is assumed to have already survived sweep()
// — callers run this after it, same ordering — so a name outside
// `valueFlags` is a known boolean flag and consumes nothing, and a name
// inside it takes the next token as its value unconditionally, whatever that
// token looks like (that unconditional skip is what lets `--spend-since -1`
// through instead of reading `-1` as a stray positional). An `=`-joined form
// (`--pr=5`) is never treated as carrying a value to skip over: has()/arg()
// already refuse that form, by name, for every flag `valueFlags` lists,
// wherever the script reads it — before or after this call.
export function makeStray(die) {
  return function stray(valueFlags, positionals = []) {
    const argv = process.argv.slice(2);
    let usedPositional = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith("--")) {
        if (!a.includes("=") && valueFlags.includes(a.slice(2))) i++;
        continue;
      }
      if (!usedPositional && positionals.includes(a)) {
        usedPositional = true;
        continue;
      }
      die(`unexpected argument '${a}'`);
    }
  };
}
