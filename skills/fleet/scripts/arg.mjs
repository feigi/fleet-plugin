#!/usr/bin/env node
// Shared CLI-boundary helpers for the fleet scripts: die(), arg(), has().
// #367: was five drifting copies of arg(), three of has(), seven of die() in
// two incompatible shapes — one paste behind on any guard fix. One copy now;
// a fix to the contract lands here once and reaches every caller.
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
