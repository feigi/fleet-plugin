// Shared CLI-boundary helpers for the fleet scripts: die(), arg(), numArg(),
// has(), sweep(), stray(), the three refusal rules
// isFlagLike()/hasEqualsForm()/isDigits(), and writeAll() — the short-write
// and EAGAIN retry loop every script's own stdout/stderr write routes
// through (#1549).
// #367: was five drifting copies of arg(), three of has(), seven of die() in
// two incompatible shapes — one paste behind on any guard fix. One copy now;
// a fix to the contract lands here once and reaches every caller that routes
// through the helper it fixes.
//
// For die() that is every script that has one: `grep -ln '^function die(' \
// scripts/*.mjs` reports none, so no script carries a private
// module-scope die() any more. The `^` is the whole command: unanchored, it
// matches this very comment and makeDie()'s own indented `return function
// die(msg)`, so it reported arg.mjs — a settling command that answers with
// the file asserting it settles nothing. For the guards it is not, and the gap
// is where this file's own defect used to live: a script that hand-rolls its
// argv reader cannot call arg()/has() at all, because those refuse under a
// GENERATED message ("--<name> needs a value") and such a reader exists
// precisely to refuse under its own ("--file needs a path"). ledger.mjs
// splices --file/--require-file out of argv itself (#362) and
// member-outcomes.mjs reads its own --file, so both were out of arg()'s
// reach — and both answered that by copying the expression, which is a
// requirement recorded where nothing executes it.
//
// #567 closed that: the rules are stated once, as isFlagLike() and
// hasEqualsForm() below, and BOTH readers import and call them while keeping
// their own wording. No script now restates one of these rules as a value
// guard instead of calling it. That is executed, not documented —
// shared-refusal.test.mjs reds when a copy is re-inlined, including one
// re-inlined behaviour-identically, which no behavioural test can see. Read
// the current division with `grep -n 'from "./arg.mjs"'
// scripts/*.mjs | grep -v test` rather than trusting a list
// here to have aged well.
//
// The scripts that hold a flag refusal of their OWN are the second edit sites
// for this contract: change a rule here and each of them needs the same change
// made again at its own site. Holding that refusal is what makes a script one
// — not whether arg()'s refusals reach it. Being out of arg()'s reach is one
// way to end up holding one; running a second parser alongside arg() is
// another, and each way has a script that qualifies only under it.
//
// Which scripts those are is readable off the `from "./arg.mjs"` grep this
// header already recommends, provided you read the imported SYMBOL list and
// not the filenames: a row binding makeSweep has delegated the unknown-flag
// refusal, so `grep -n '^import .* from "./arg.mjs"'
// scripts/*.mjs | grep -v test | grep -v makeSweep` leaves the
// rows that hold their own. Anchoring on `^import` is load-bearing for the
// same reason it is on the die() grep: unanchored, this very comment matches
// itself. Read that output for the roster — the scripts this header names
// exemplify a way of qualifying, and were never the whole of it.
//
// fleet-tick.mjs is the one script still outside arg()/has(), and
// deliberately: it parses its flags with node:util's parseArgs, so its
// unknown-flag, required-flag and range refusals are a separate edit site on
// its own terms. Its integer guard is no longer one of them — #878 gave the
// digits grammar its own predicate (isDigits() below) precisely because
// isFlagLike() cannot express it, and int() now calls that instead of
// hand-writing the third spelling. What stays fleet-tick's own there is the
// `String(raw).trim()` its input needs and the wording of its refusal, not
// the rule.
//
// workflows/review-pr.js is a second edit site this header's grep CANNOT
// see, and #878 is where it became one. A Claude Code Workflow script cannot
// perform an import at all (#538, review-core.js's header), so it consumes no
// symbol from here and no `from "./arg.mjs"` row will ever name it — while
// its `pr` argument reaches `gh pr diff`, `gh pr view` and `diff-stats.mjs
// --pr` all the same. Its copy of the digits rule is held in step by
// shared-refusal.test.mjs, which runs it and isDigits() over the same values;
// its host-independent twin review-core.js is an ordinary module and imports
// the real thing.
//
// candidates.mjs qualifies the other way, which the reach test cannot express:
// it binds makeArg/makeHas, so arg()'s refusals DO reach it — `node
// scripts/candidates.mjs --limit` refuses under the generated
// wording from here — and it parses with node:util's parseArgs as well, whose
// unknown-flag refusal is its own edit site: `node
// scripts/candidates.mjs --bogus`. Why that refusal is not
// sweep()'s is argued at makeSweep(), which owns the trade-off; this names the
// edit site rather than restating it.
//
// Each factory takes (or returns something bound to) the caller's own die(),
// because every script's die() speaks under its own NAME — that stays
// site-specific, nothing here hardcodes a script name.

import { writeSync } from "node:fs";

// #1549: ONE write-retry loop, not three. Resuming a short write and waiting
// out an EAGAIN are properties of the FD, not of any one caller, so die()
// below, ci-state.mjs's verdict writes and staleness.mjs's verdict() all
// route through writeAll() instead of each hand-rolling the same
// while/try/subarray. They were three independent copies held in step by a
// comment reading "mirrors emit()" and by nothing executable — which is
// exactly how one of them (ci-state.mjs's emit()) stayed the only one with no
// retry cap at all. board.mjs's fault() is the fourth site and is #1547's to
// move, not this file's.
const MAX_EAGAIN_RETRIES = 200;

// Shared across every retry: Atomics.wait never writes or notifies it, so one
// instance times out exactly as a fresh one would, without allocating a
// SharedArrayBuffer on every EAGAIN.
const IDLE = new Int32Array(new SharedArrayBuffer(4));

// Writes every byte of `text` to `fd`, or reports that it could not.
//
// A single writeSync fails two ways against a pipe whose reader has left it
// full — the state an fd reaches once a stream has been initialised on it
// (console.error does that to fd 2) and enough output is queued behind it. It
// either SHORT-WRITES, returning the count it managed and throwing nothing at
// all, silently truncating with no diagnostic for a catch to see (#885/#889);
// or it throws EAGAIN. So this resumes from writeSync's own return value
// until the buffer is empty, and reads EAGAIN as "momentarily full", waiting
// 1ms for the reader rather than treating it as failure. The wait is what
// keeps that retry from spinning: against a reader asleep three seconds, a
// bare `continue` burned a full core for the whole stall where the 1ms wait
// burned almost none, both delivering the same bytes.
//
// The EAGAIN retry is CAPPED (#889). Uncapped, a reader that stays open but
// never drains — not merely a slow one — spins here forever, and every caller
// is one whose whole job is to finish and report an exit code, so an
// indefinite hang trades that guarantee away. Past the cap this gives up on
// the BYTES rather than on the process.
//
// Returns true when the whole of `text` landed, false when bytes were lost —
// to a non-EAGAIN errno, or to the cap. What that costs is the caller's to
// decide, and the callers genuinely differ: die() exits 2 either way,
// staleness.mjs's verdict() downgrades to could-not-check, ci-state.mjs
// carries on to its own exit code. The one thing none of them may do is
// mistake a short write for a complete one, which is what a bare writeSync
// leaves every one of them doing.
export function writeAll(fd, text) {
  let buf = Buffer.from(text);
  let retries = 0;
  while (buf.length) {
    try {
      const written = writeSync(fd, buf);
      if (written > 0) retries = 0;
      buf = buf.subarray(written);
    } catch (e) {
      if (e.code !== "EAGAIN" || ++retries > MAX_EAGAIN_RETRIES) return false;
      Atomics.wait(IDLE, 0, 0, 1);
    }
  }
  return true;
}

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
export function makeDie(name) {
  return function die(msg) {
    // The try covers the TEMPLATE as well as the write, and that is the whole
    // of its job: uncaught, a throwing msg — or anything escaping writeAll —
    // skips process.exit(2) and drops the process to Node's default exit 1,
    // inverting the caller's own exit-code contract (#299/#328). Hoisting the
    // string out to writeAll's argument list reintroduces precisely that,
    // which is why the pin in candidates.test.mjs requires it to sit inside.
    // writeAll's false return is ignored on purpose, and says no more than
    // this function always promised: the message may be lost, the exit code
    // may not.
    try {
      writeAll(2, `\n${name}: ${msg}\n`);
    } catch {
      // Message (or its own construction) may be lost; the exit code below must not be.
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
// a ticket, and #240's is `--label ready-for-agent`. Refusing loudly here
// still beats silently taking the next flag as this one's value, so this
// guard itself does not bend for it. staleness.mjs (#818) instead opts a
// caller in per flag with its own end-of-options separator, `--gone --
// '<value>'`, read before arg() ever sees the value — bare, with no `--`
// immediately before it, this refusal still stands unchanged.
// #567: the two predicates immediately below ARE those rules, exported so a
// caller that cannot route through arg()/has() consumes them instead of
// copying the expression — the header above says which callers and why.
// isDigits(), further down, is a third export on the same terms for a
// different rule (#878); these two are the ones this paragraph is about.
//
// What travels is the RULE, never the refusal text: each caller keeps its own
// die() wording, which is the constraint that made copying look necessary in
// the first place. ledger.mjs says "--file needs a path" where arg() below
// says "--<name> needs a value", because a reader who typed --file is owed the
// flag they typed and not the grammar behind it.
//
// Plain exports, not factories, because neither takes a script NAME — one is a
// predicate over a value, the other over an argv. That is also why #467's
// proposed makeCli(NAME) collapse of makeDie/makeArg/makeHas cannot absorb
// them whichever way it lands: those three exist to BIND a name, and these
// have no name to bind.
export function isFlagLike(value) {
  return value === undefined || value.trim() === "" || value.startsWith("--");
}

// Prefix-matched on `--name=`, so a longer flag name sharing the prefix
// (`--filename=x` asked about `file`) is NOT caught here — that one is a name
// no script reads, which is sweep()'s to refuse in its own wording.
//
// argv is a parameter because the two kinds of caller hold different arrays:
// arg()/has() read the live process.argv, where argv[0] and argv[1] are the
// node and script paths and are scanned harmlessly; ledger.mjs holds its own
// process.argv.slice(2) and passes it.
export function hasEqualsForm(name, argv = process.argv) {
  return argv.some((a) => a.startsWith(`--${name}=`));
}

export function makeArg(die) {
  return function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) {
      if (hasEqualsForm(name)) die(`--${name} needs a space-separated value, not --${name}=`);
      return null;
    }
    const value = process.argv[i + 1];
    if (isFlagLike(value)) die(`--${name} needs a value`);
    return value;
  };
}

// #364: a boolean flag written --name=value must refuse, not read as
// absent — same fail-open class as arg()'s `=` guard above, but
// boolean-specific wording: there is no value to take, so "needs a
// space-separated value" would lie.
export function makeHas(die) {
  return function has(name) {
    if (hasEqualsForm(name)) die(`--${name} is a boolean flag, not --${name}=`);
    return process.argv.includes(`--${name}`);
  };
}

// #878: the digits rule, stated once. #840 closed a non-numeric `--pr` in
// ci-state.mjs alone, and the identical shape stayed live in its siblings.
// Measured on the pre-fix tree against a stub `gh` that ANSWERS, the way a
// real one does for a branch ref: `diff-stats.mjs --pr abc` reached
// `gh pr view abc` and printed `{"pr":null,…}` at exit 0, and
// `pr-overlap.mjs --a abc --b def` printed `{"a":null,"b":null,…}` at exit 0
// under a real `signal: "files"` verdict. Each payload's only identifying
// field was built with `Number()`, and `JSON.stringify(NaN)` is `null` — a
// report that cannot be attributed to the PR it answered for, at the exit code
// the fleet gates on. `gh pr view` resolves a non-numeric ref as a BRANCH, so
// the answer underneath was genuine and about a different PR.
//
// The class is NOT bounded by the `arg("pr")` spelling — pr-overlap.mjs reads
// `--a`/`--b` — so it is enumerated by SHAPE: an argument checked for
// truthiness alone, then handed to `gh` as a ref AND to `Number()` in a
// payload field. Its members are ci-state.mjs, diff-stats.mjs and
// pr-overlap.mjs, and all three now route through numArg() below. A sweep for
// the flag NAME finds two of the three, which is how the third stayed open
// through #840's review.
//
// Stated here rather than a third time at the call sites, because the
// invariant had no single expression: ci-state.mjs spelled it `/^[0-9]+$/`
// while fleet-tick.mjs's int() spells it `/^\d+$/` over a parseArgs value,
// each with its own wording. #367 overturned #169's "no shared module" ruling
// to stop exactly this drift, and a fourth spelling IS the drift.

// `+`, so the empty string is not a number. arg() already refuses that value
// through isFlagLike, but this predicate's other consumers do not read argv
// through arg(): fleet-tick.mjs's int() reads parseArgs values, where
// `Number("")` is 0 and `Number.isInteger(0)` is true, so `--pool ""` — the
// shape an unset shell variable produces — would read as a genuine, empty
// pool.
//
// Digits, not a `Number()` coercion, and the difference is the whole guard:
// `Number` accepts `1e3`, ` 42 `, `0x2a` and `Infinity`, and each of those
// reaches `gh` as a ref that is not the PR the caller meant. It forfeits the
// branch and URL spellings `gh pr view` itself takes — the same trade the
// `--`-prefixed value rule above makes — and nothing in this repo passes one:
// board.mjs's runCiState() sends `String(pr)` off a numeric record, and every
// documented invocation is `--pr <N>`.
//
// RegExp.test coerces, which is load-bearing in both directions. It is what
// lets review-core.js ask this about a workflow argument that arrives as the
// number 42 rather than the string "42"; it is also why this can never be an
// ABSENCE check, since `null` coerces to the string "null" and answers false.
// Every caller reads absence first, on its own terms.
//
// Leading zeros are accepted: `Number("007")` is 7 and `gh pr view 007`
// resolves PR 7, so there is nothing ambiguous to refuse. The shell half of
// this same invariant (claim-ticket.sh, inflight.sh, release-ticket.sh,
// drop-merged-label.sh) carries an extra `0?*` clause that refuses them, and
// this rule deliberately does not adopt it — tightening here would refuse a
// `--pr 007` that #840's shipped guard accepts, which is a behaviour change
// dressed as a de-duplication.
//
// A plain export rather than a factory, for the reason isFlagLike and
// hasEqualsForm are: it is a question about a value and binds no script name.
export function isDigits(value) {
  return /^[0-9]+$/.test(value);
}

// Built ON makeArg, not beside it, so the digits test runs AFTER arg()'s own
// value guards: `--pr` given trailing still reports "--pr needs a value" and
// `--pr=5` still reports the `=` form. Where both would refuse, the more
// specific wording wins — the same ordering rule sweep() states below.
//
// Absent returns null and is never refused here. That half does not decompose:
// pr-overlap.mjs's usage line names `--a` and `--b` at once, so its absent
// case has no per-flag wording to give. So only the MALFORMED refusal travels,
// and it is flag-named because all three callers mean one thing by it, while
// each caller keeps its own absent refusal above its own usage text — the
// header's "what travels is the RULE, never the refusal text", applied to a
// product whose two refusals genuinely differ in that respect.
//
// This also discharges #840's placement rule structurally instead of
// positionally. That guard had to sit BELOW ci-state.mjs's usage die because
// RegExp.test coerces `null` to "null": hoisted above it, an omitted `--pr`
// was answered with a complaint about a number and the usage line never
// printed. numArg() only ever tests a value it actually read, so the refusal
// is free to land at the read and no call site has to remember an order.
//
// Returns a NUMBER, which is what deletes the defect rather than guarding
// upstream of it: the payload sites each built `pr: Number(pr)`, and that
// expression is where `NaN` became `null`. Converted here, it cannot be
// reached with anything but digits and no call site restates it. Callers test
// absence as `=== null`, never `!pr` — `--pr 0` is a value the caller GAVE,
// and answering it with a usage line claiming `--pr` is required would be a
// lie, where `gh` answers it truthfully as no such PR.
export function makeNumArg(die) {
  const arg = makeArg(die);
  return function numArg(name) {
    const raw = arg(name);
    if (raw === null) return null;
    if (!isDigits(raw)) die(`--${name} needs a number, got ${raw}`);
    return Number(raw);
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
// ledger.mjs is left out for the opposite reason: its `check`, `filed`, `row`
// and `ruled` all take a FREE-TEXT tail, where a `--` token is legitimately
// DATA — `check
// "--require-file silently absent when value missing"` works today and is the
// shape of issue titles in this repo — so this sweep would refuse working
// invocations, which #365's own AC calls worse than the bug. #584 NARROWED
// that gap without routing through this sweep, rather than closing it, and
// #1161 narrowed it again: ledger.mjs's own refuseStrayInCheckTail() is read on
// `check`'s tail ALONE, and refuses a `--`-prefixed token there only when it
// shares that tail with something else — the shape an unquoted stray flag
// makes, never the shape a one-argument subject makes — so a subject that
// legitimately opens with `--`, given as that one argument, is accepted and
// emitted in the payload's `subject` field unchanged. Unchanged there, not
// everywhere: `check` normalises and reorders the subject before it becomes a
// tracker query, so `the --basee flag is unread` is queried as `unread basee
// flag`.
//
// `check` alone because the length rule is only sound where the documented
// convention IS one quoted argument, and `filed`, `row` and `ruled` are
// documented with a bare multi-word tail — so on those three the gate refused
// what their own docs prescribe, measured (#1161). What guards them instead is
// ledger.mjs's refuseStrayInId(), a bare prefix test on the id slot ahead of
// the tail, where a `--` token is never data.
//
// It is the LENGTH gate that spares the legitimate case, not the prefix test
// — that test is `startsWith("--")`, the same one this sweep uses. A prefix
// test with no length gate was measured refusing the legitimate subject.
//
// #584 does not make this file's cost disappear; it buys a smaller version of
// the same cost. An unquoted subject carrying a `--` word is a working
// invocation ledger.mjs's `check` now refuses too: `check the --basee flag is
// unread` answered at exit 0 before #584 and exits 2 after it. The residual
// that stays open and owned is a lone stray with no subject beside it, still
// taken as the subject, which ledger.mjs's own comment prices.
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
