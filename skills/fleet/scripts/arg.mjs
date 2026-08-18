// Shared CLI-boundary helpers for the fleet scripts: die(), arg(), has(),
// sweep().
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
// there. (fleet-tick.mjs also imports makeDie alone, but reads no flags at
// all — nothing to reach.)
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
// that legitimately starts with `--` — but no caller here passes one, and
// refusing loudly beats silently taking the next flag as this one's value.
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
// candidates.mjs deliberately does NOT route through this. It accepts no
// positionals, so its parseArgs (#173) additionally refuses a bare
// `candidates.mjs ready-for-agent` — which this cannot, board.mjs's
// subcommands being exactly that shape. Strictly stronger there; leave it.
export function makeSweep(die) {
  return function sweep(known) {
    for (const a of process.argv.slice(2)) {
      if (a.startsWith("--") && !known.includes(a.slice(2).split("=")[0])) {
        die(`unknown flag ${a} — accepted: ${known.map((k) => `--${k}`).join(", ")}`);
      }
    }
  };
}
