// board.mjs as composition: what only makes sense once gather(), computeBoard()
// and board-server are wired together — the argv refusals in main(), the tick
// loop serve() is handed (what it threads into every tick, and the receipt it
// reads the spend session from on each), the fault path, and the script's exit
// codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, readFileSync, realpathSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { faultText } from "../plugin/scripts/board.mjs";
import { encodeProjectDir } from "../plugin/scripts/member-record.mjs";
import { stripComments } from "./support/strip-comments.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { TURN, serveArgs, serveOpts, writeReceipt } from "./support/board-rig.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/board.mjs", import.meta.url));

// The acceptance criterion end to end, through serve()'s own tick loop: every
// assertion in board-gather.test.mjs is reachable with the receipt never read
// per tick at all. A REAL server, two sessions under one project directory,
// the sibling holding the NEWER transcripts — the shape a newest-mtime pick
// gets wrong. With no --spend-dir each tick reads the session the phase-0
// receipt records, and a receipt rewritten between ticks is followed: a
// cockpit serves the next run too, while its controller's session lives.
test("CLI: a live serve reads the receipt's session on every tick — never the newest sibling — and follows a rewritten receipt", async () => {
  // realpath, not the bare mkdtemp path: on darwin $TMPDIR is under /var, a
  // symlink to /private/var, and the child's process.cwd() reports the RESOLVED
  // form — encoding the unresolved one puts the fixture where nothing looks.
  const cwd = realpathSync(tempDir("spend-receipt-cwd-"));
  const home = tempDir("spend-receipt-home-");
  const bin = tempDir("spend-receipt-bin-");
  // gh fails on every call and the reads degrade, so this stays offline and off
  // this repo's live issue list. Prepended rather than replacing PATH: gather()
  // shells out to `node` for the ledger read.
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  const proj = join(home, ".omp", "agent", "sessions", encodeProjectDir(cwd, { home }));
  const mine = join(proj, "2026-09-08T13-13-27-300Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const theirs = join(proj, "2026-09-09T02-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  // With no sidecar the panel labels an agent by its filename stem, so the
  // board itself names which session it read — no second fixture needed for it.
  const turn = TURN.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(mine, "session-a.jsonl"), turn);
  utimesSync(join(mine, "session-a.jsonl"), new Date(1000), new Date(1000));
  writeFileSync(join(theirs, "session-b.jsonl"), turn);
  // The cwd is no git checkout, so the cockpit's state directory is the
  // cwd's own `.fleet` — the receipt goes beside the board.json it writes.
  const receipt = (session) => writeReceipt(join(cwd, ".fleet"), session);
  receipt(mine);

  const p = spawn(process.execPath, serveArgs(["--port", "0", "--interval", "1"]), {
    cwd, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  try {
    const jsonPath = join(cwd, ".fleet", "board.json");
    // The deadline is checked INSIDE the loop, so the loop ends with the wait:
    // a race against a timer would reject and leave this loop polling, and
    // the test file would then hang until an outside timeout instead of
    // reporting the failing assertion.
    const until = async (pred, what) => {
      const deadline = Date.now() + 20000;
      for (;;) {
        let b = null;
        try { b = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { /* not written yet, or mid-rename */ }
        if (b && pred(b)) return b;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    const first = await until((b) => b.spend?.ok, "the first tick that reads a transcript");
    assert.equal(first.spend.top[0].label, "session-a", "the receipt's session is read, not the sibling with the newer transcript");

    // The next run's receipt lands while this cockpit keeps running.
    receipt(theirs);
    await until((b) => b.spend?.ok && b.spend.top[0].label === "session-b", "a tick that follows the rewritten receipt");

    // A recorded session whose directory does not exist yet: the quiet null.
    receipt(join(proj, "2026-10-01T00-00-00-000Z_cccccccc-cccc-cccc-cccc-cccccccccccc"));
    await until((b) => b.spend === null, "a tick over a recorded session not created yet");
    assert.doesNotMatch(stderr, /spend read failed|holds no agent transcripts/);
  } finally { p.kill("SIGKILL"); }
});

// #169: `arg()` is CLI-internal (not exported), so this pins the trailing-flag
// refusal at the process boundary. `ledger`/`prev`/`spend-since`/`port`/
// `interval` all read via `arg(n) || default` or `?? `, so a trailing flag
// previously fell straight through to the default in total silence —
// `--spend-since` with nothing after it silently widened the spend panel to
// all-time; `--ledger` with nothing after it silently read the wrong file.
// Dies before any gh call, so no PATH stub is needed here.
test("CLI: trailing --ledger (no value) dies (exit 2) rather than silently falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

test("CLI: --ledger=path form dies by name, not silently read as absent", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger=/tmp/x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a space-separated value/);
});

// The other two branches of the same guard, neither of which the tests above
// reach: a flag eating the NEXT FLAG as its value (mutating away
// `value.startsWith("--")` left board/ci-state/diff-stats 100% green), and an
// explicit empty/whitespace value (`value.trim() === ""` was unpinned in all
// five scripts that then carried it — board, candidates, ci-state, diff-stats,
// pr-overlap — simultaneously). Both die before any gh call.
test("CLI: --ledger followed by another flag is rejected, not read as the string \"--prev\"", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", "--prev", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

// #463 fallout, and the one ordering nothing else pins: `--ledger` is read
// above stray() and always was, so none of the cases above reaches the new
// guard at all. `--prev` is read once, ahead of BOTH branches' stray() calls
// (hoisted by #1092 — see main()) — with the read moved back below either
// stray() call, this invocation refuses with `unexpected argument '9000'`,
// naming --port's innocent value instead of the flag actually given wrong
// (measured). Moving the read back below stray() is what this reds on.
test("CLI: trailing --prev names --prev, not the innocent value of the flag behind it", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--prev", "--port", "9000"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--prev needs a value/);
});

// #1092: unlike the case above, `--prev` was not merely ORDERED wrong on one
// subcommand — it was never read on `serve` at all. serve()'s own signature
// (`{ ledgerFile, port, interval, open }`) carries no `prev` parameter, and
// main()'s `serve` branch called only `stray()`, so a trailing `--prev` on
// `serve` never reached ANY guard: measured, pre-fix, `serve --prev` and
// `serve --prev=x` both fell straight through to gather()'s first `gh` call
// (a real network attempt, not a refusal), and `serve --prev --port 9000`
// refused with `unexpected argument '9000'` once stray() got to it — naming
// --port's innocent value rather than the flag actually given wrong, the
// exact harm the build-side pin above exists for. Hoisting `arg("prev")`
// above the dispatch (next to argPort()/has("open")) closes all three: every
// case below now dies inside main(), before `serve()` is ever called, so
// none of these needs board-cli.test.mjs's gh-stub/PATH rig — same as the
// build-side cases above and the --port/--open hoist cases below.
test("CLI: serve refuses a trailing --prev (no value), same message as build", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--prev"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a value/);
});

test("CLI: serve refuses --prev=x, the same shape --ledger=path is refused", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--prev=x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a space-separated value, not --prev=/);
});

test("CLI: serve refuses --prev --port 9000, naming --prev not --port's innocent value", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--prev", "--port", "9000"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a value/);
});

// #1092: the --prev-before-argPort() ordering pinned above (`serve --prev
// --port 9000`) only exercises --prev going wrong while --port's value is
// well-formed — it never exercises BOTH flags malformed at once, which is
// the actual case the hoist comment above `arg("prev")` in main() claims to
// handle ("a caller who gets BOTH flags wrong at once ... still hears about
// --prev specifically"). With `arg("prev")` read before argPort() in the
// hoist (as it is), a trailing --port immediately followed by a trailing
// --prev — neither given a value — refuses on --prev, since --prev's read
// runs first and sweep() never reaches --port's dangling flag. Swap the
// hoist order (argPort() ahead of `arg("prev")`) and this reds: the error
// names --port instead (measured).
test("CLI: build refuses --port --prev with both flags trailing, naming --prev not --port", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "--prev"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--prev needs a value/);
});

test("CLI: --ledger given an empty value dies rather than falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", ""], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

// #468: argPort()/has("open") used to run only inside serve(), so build never
// evaluated them — `build --port abc` and `build --open=1` were silently
// IGNORED at exit 0 rather than refused, the one silent-default shape
// ledger/prev/spend-since/interval (pinned above and in board-cli.test.mjs)
// did not share. main() now calls both once, ahead of the build/serve
// dispatch, so these refuse on build too, with the exact wording serve
// already refuses them with. All three die before gather()'s first gh read
// (the guard moved above the dispatch, not just above serve()'s own call),
// so — like the --ledger/--prev cases above — none of these need the gh-stub
// rig that board-cli.test.mjs carries for its other runBoard cases.
test("CLI: build refuses a trailing --port, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a value/);
});

test("CLI: build refuses a non-numeric --port, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

test("CLI: build refuses --open=1, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--open=1"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--open is a boolean flag, not --open=/);
});

// The ordering half of the same fix, and the one the three cases above cannot
// see: they pass a malformed flag ALONE, so nothing distinguishes a guard that
// runs ahead of the build branch's stray() from one that runs after it. Add a
// stray positional and it does: with the guard moved below that stray() call,
// this invocation refused with `unexpected argument 'extra'` (measured),
// naming a trailing token instead of the malformed value the caller actually
// got wrong. Both orderings still exit 2 — only which real mistake gets named
// differs, which is exactly what the --prev case above pins for its own flag.
test("CLI: build refuses a malformed --port ahead of a stray token, naming --port not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "abc", "extra"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

// #1076: same ordering gap as the --prev/--port cases above, for the two
// flags PR #1090 (#468) left standing — argInterval()'s read had two call
// sites (serve() directly, and embedded in gather()'s return, which build's
// dispatch reaches too), and the --spend-since read sat inside gather();
// all three sat below every stray() call on every path that reaches them.
// With any of those reads left below the guard, the invocation refused
// with `unexpected argument 'x'` (measured), naming the value flag's own
// innocent trailing token instead of the flag actually given wrong — true
// of build+interval as much as the serve+interval and build+spend-since
// cases below cover. Hoisting both into main(), the same place and the
// same way #468 hoisted argPort()/has("open"), is what these two red on
// if reverted.
test("CLI: serve refuses a trailing --interval ahead of a stray token, naming --interval not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--interval", "--open", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--interval needs a value/);
});

test("CLI: build refuses a trailing --spend-since ahead of a stray token, naming --spend-since not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--spend-since", "--open", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since needs a value/);
});

// #1583: the same four spellings for --spend-dir, and the same ordering. A
// PATH has no range to check, so arg() IS this flag's whole refusal — which
// makes the two things this ticket wrote the only things standing between an
// operator and a silent wrong answer: the "value" entry in the flag table, and
// the read hoisted into main(). Drop it from the table and sweep() calls the
// flag unknown; drop the hoisted read and the stray case below blames `x`.
test("CLI: every malformed --spend-dir spelling is refused under its own name", () => {
  const cases = [
    [["build", "--spend-dir"], /--spend-dir needs a value/],                                   // trailing
    [["build", "--spend-dir="], /--spend-dir needs a space-separated value, not --spend-dir=/], // = form
    [["build", "--spend-dir", ""], /--spend-dir needs a value/],                               // empty value
    [["build", "--spend-dir", "--prev", "x"], /--spend-dir needs a value/],                    // eats the next flag, naming --spend-dir not the stray
  ];
  for (const [args, message] of cases) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `expected exit 2 for ${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, message, `for ${args.join(" ")}`);
  }
});

// The other two malformed spellings arg.mjs refuses, which the hoist closes on
// build alongside the three above. Pinned because a NARROWED hoist keeps the
// three green while dropping these: measured, `if (process.argv.includes(
// "--port")) argPort();` — a plausible "only bother when the flag was given" —
// leaves `build --port=9000` at exit 0 with every other case still refusing.
test("CLI: build refuses --port=9000, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port=9000"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a space-separated value, not --port=/);
});

test("CLI: build refuses an empty --port value rather than falling back to the default port", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", ""], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a value/);
});

// The hoist sits above the `cmd` dispatch, not just above serve()'s own call,
// so it also changed the no-subcommand path: `board.mjs --port abc` printed
// the usage line before this fix and names the flag after it (measured, both
// sides). Sanctioned by #468's Option A ruling — a malformed flag is refused
// wherever it is written — and unpinned until now: the same narrowing that
// moves the guards into the `build` branch restores the usage line here while
// leaving all four `build` cases above green.
test("CLI: a malformed --port with no subcommand names the flag, not the usage line", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--port", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

// #366: `Number(x) || default` treated a non-numeric --port/--interval exactly
// like an absent one — silently substituting the default with no refusal.
// These pin the refusal itself, before listen() is ever reached.
test("CLI: serve refuses a non-numeric --port by name, not silently substituting the default", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "abc"]), serveOpts());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

test("CLI: serve refuses an out-of-range or non-integer --port", () => {
  for (const v of ["-1", "70000", "1.5"]) {
    const r = spawnSync(process.execPath, serveArgs(["--port", v]), serveOpts());
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, /--port wants an integer 0-65535/, `for ${v}: ${r.stderr}`);
  }
});

// #1679: every other argv-read option `serve` takes has both an in-process
// override AND a CLI test driving it end to end; --spend-dir had neither
// until then — every --spend-dir test drove `build` (one gather per
// process), never `serve`'s own tick loop. A receipt naming another session
// sits beside the board, so the override wins over a real alternative.
test("CLI: serve --spend-dir reads the named directory's spend into every tick, not just build", () => {
  const opts = serveOpts();
  // A real `<ISO>_<uuid>` leaf name: gatherSpend's `explicit` path now
  // refuses a --spend-dir whose own basename is not an omp session dir
  // (#1302-style guard), so this fixture must look like one to keep testing
  // what it says it tests — the named directory's data reaching the panel.
  const root = tempDir("spend-named-");
  const dir = join(root, "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "named.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const recorded = join(root, "2026-08-24T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567891");
  mkdirSync(recorded, { recursive: true });
  writeFileSync(join(recorded, "recorded.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeReceipt(join(opts.cwd, ".fleet"), recorded);
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--spend-dir", dir]), { ...opts, timeout: 2000 });
  assert.notEqual(r.status, 2, r.stderr);
  const body = JSON.parse(readFileSync(join(opts.cwd, ".fleet", "board.json"), "utf8"));
  assert.equal(body.spend.ok, true, r.stderr);
  assert.equal(body.spend.totals.cacheWrite, 1000, "the served panel must come from the named directory");
  assert.equal(body.spend.top[0].label, "named");
});

// main() resolves --spend-since, --interval and whether --spend-dir was named,
// and hands them to the tick serve() runs; gather() reads none of them from
// argv. A tick built without one of them still serves a board — with
// `since` null, the default interval, or the receipt's panel in place of a
// refusal — so each is pinned here by the value the served board.json carries.
test("CLI: serve threads --spend-since, --interval and an explicit --spend-dir into every tick", () => {
  const since = 1789300000000;
  const opts = serveOpts();
  const root = tempDir("spend-threaded-");
  const dir = join(root, "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "named.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--spend-since", String(since), "--spend-dir", dir]), { ...opts, timeout: 2000 });
  assert.notEqual(r.status, 2, r.stderr);
  const body = JSON.parse(readFileSync(join(opts.cwd, ".fleet", "board.json"), "utf8"));
  assert.equal(body.spend.since, since, "the served panel must carry the --spend-since the operator passed");
  assert.equal(body.interval, 3600, "the served board must carry the --interval the operator passed");

  // Explicit means the operator NAMED the directory, so a mis-levelled name is
  // refused rather than read: the same board.json carries `ok: false` here
  // where a tick that dropped the flag would have read the directory anyway.
  const wrongLevel = join(root, "not-a-session-dir");
  mkdirSync(wrongLevel, { recursive: true });
  writeFileSync(join(wrongLevel, "named.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const opts2 = serveOpts();
  const r2 = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--spend-dir", wrongLevel]), { ...opts2, timeout: 2000 });
  assert.notEqual(r2.status, 2, r2.stderr);
  const body2 = JSON.parse(readFileSync(join(opts2.cwd, ".fleet", "board.json"), "utf8"));
  assert.equal(body2.spend.ok, false, r2.stderr);
  assert.match(body2.spend.error, /is not an omp <ISO>_<uuid> session directory/);
});

test("CLI: serve refuses a non-numeric or non-positive --interval by name", () => {
  for (const v of ["abc", "0", "-5"]) {
    const r = spawnSync(process.execPath, serveArgs(["--interval", v]), serveOpts());
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--interval wants seconds > 0 and <= 2147483, got ${v}`), `for ${v}: ${r.stderr}`);
  }
});

// Both boundaries, both flags — an untested edge is an edge a later mutation
// walks straight through: `n > 65535` weakened to `n >= 65535` (rejecting the
// legal maximum port) survived the whole suite (#435 review). 65535 may well
// be free here and may not, so pin the ABSENCE of the refusal rather than a
// successful bind: an occupied port dies with "port 65535 in use", a rejected
// one with "--port wants", and only the second is this guard's doing.
test("CLI: serve accepts the maximum legal --port 65535 and refuses 65536", () => {
  const ok = spawnSync(process.execPath, serveArgs(["--port", "65535", "--interval", "3600"]), { ...serveOpts(), timeout: 2000 });
  assert.doesNotMatch(ok.stderr, /--port wants/, ok.stderr);
  const over = spawnSync(process.execPath, serveArgs(["--port", "65536"]), serveOpts());
  assert.equal(over.status, 2, over.stderr);
  assert.match(over.stderr, /--port wants an integer 0-65535, got 65536/);
});

// The interval ceiling is setInterval's, so pin it where it bites: at the max
// the timer must be armed normally, one second past it the flag is refused.
// Without the ceiling, 2147484s becomes a 1ms tick and the rebuild loop spins
// on gh instead of sleeping ~25 days — announced only by Node's own warning.
test("CLI: serve arms the maximum --interval 2147483 without overflowing, and refuses 2147484", () => {
  const ok = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "2147483"]), { ...serveOpts(), timeout: 2000 });
  assert.doesNotMatch(ok.stderr, /--interval wants/, ok.stderr);
  assert.doesNotMatch(ok.stderr, /TimeoutOverflowWarning/, ok.stderr);
  const over = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "2147484"]), serveOpts());
  assert.equal(over.status, 2, over.stderr);
  assert.match(over.stderr, /--interval wants seconds > 0 and <= 2147483, got 2147484/);
});

// #364: has() used exact argv.includes, so a boolean flag written --open=value
// (in any form the value takes) silently read as absent. Boolean-specific
// wording, distinct from arg()'s "needs a space-separated value" above: a
// boolean has no value to give. Dies before listen(), same as the port/interval
// guards above — nothing this reaches ever shells out.
for (const v of ["=true", "=false", "="]) {
  test(`CLI: serve refuses --open${v} as a boolean flag, not silently read as absent`, () => {
    const r = spawnSync(process.execPath, serveArgs([`--open${v}`]), serveOpts());
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--open is a boolean flag, not --open=/);
  });
}

// Position, not just spelling: `serve` is fixed and every case in the loop
// above passes its flag alone, so all three land at exactly process.argv[3] —
// and a guard narrowed to that one index passes all three. Measured (#462
// review): has() rewritten to `process.argv[3].startsWith(...)` kept this file
// green at 34/34 while `serve --port 0 --interval 3600 --open=true` started
// the server, dropped the flag in silence and never opened a browser — #364
// itself, alive under a green suite. The real invocation always carries
// --port/--interval, so pin the flag where an operator actually types it.
// The MESSAGE is the load-bearing assertion, not `status`: spawnSync reports
// status 2 on a timeout too, so a serve left running would satisfy the code
// alone.
test("CLI: serve refuses --open=true behind other flags, not only as the first argument", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open=true"]), { ...serveOpts(), timeout: 2000 });
  assert.match(r.stderr, /--open is a boolean flag, not --open=/, r.stderr);
  assert.equal(r.status, 2, r.stderr);
});

// The control: the new `=` guard must not touch the bare spelling. Observable
// effect is the browser launcher firing — PATH is stripped to an empty dir
// (serveOpts), so every launcher this platform would try is missing and the
// warning naming the URL shows up on stderr rather than a browser opening.
// #1714's rows further down put stub launchers on PATH to see which one ran.
// The other half of the control — absence still reading as absent — is
// asserted on the --port 0 test above, whose spawn is byte-identical to the
// one this would otherwise repeat.
test("CLI: serve --open (bare) still reads as present, not swallowed by the `=` guard", () => {
  const opened = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open"]), { ...serveOpts(), timeout: 2000 });
  assert.match(opened.stderr, /could not open a browser .*http:\/\/127\.0\.0\.1:\d+\//, opened.stderr);
});

// #463: sweep() only ever refuses a `--`-prefixed token, so a bare stray
// alongside a valid subcommand rode through in silence the same way
// `board.mjs build junk` did — this pins the `serve` side of that fix.
// stray() sits at the top of the `serve` branch, ahead of serve()'s own
// port/interval/open reads, so this dies before ever calling listen() —
// same reasoning as every guard above it in this file, and why serveOpts()'s
// 20s timeout is a backstop here rather than the expected path.
test("CLI: serve refuses a stray positional the same way build does", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "junk"]), serveOpts());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument 'junk'/);
});

// #1093: the CLI's top-level handler printed `e.message`, which is `undefined`
// for a rejection that is not an `Error` — so the whole diagnostic was the
// literal `board: undefined`. Nothing in this file throws a non-Error today,
// which is why this is the unit half of board-cli.test.mjs's fault case: the
// text the handler writes has to carry bytes for every value a rejection can
// arrive as, including the four that render as nothing under a naive
// `String(e)`/`e.message` read.
test("faultText renders any rejected value, so no fault prints an empty diagnostic", () => {
  for (const v of [undefined, null, "", 0, false, { a: 1 }]) {
    const t = faultText(v);
    assert.match(t, /\S/, `faultText(${String(v)}) has nothing in it`);
    assert.notEqual(t, "undefined", "the `board: undefined` diagnostic is exactly what this replaces");
  }
  // The rejected value is NAMED, not merely non-empty: a constant string would
  // satisfy the loop above and tell the reader nothing.
  assert.match(faultText(undefined), /undefined/);
  assert.match(faultText({ a: 1 }), /a: 1/);
  // Why inspect() and not JSON.stringify: a self-referential rejection is a
  // value like any other, and stringify THROWS on it — inside the fault
  // handler, which is the one place left that can still report anything.
  const circular = {};
  circular.self = circular;
  assert.match(faultText(circular), /Circular/);
  // An Error keeps its stack verbatim. That is the whole point of the path:
  // a message alone is what made a fault indistinguishable from a refusal.
  const e = new Error("boom");
  assert.equal(faultText(e), e.stack);
  assert.match(faultText(e), /\n\s+at /);
});

// #1547: fault() writes a full stack trace in a single writeSync(2, ...) call
// — the same unlooped shape die()'s pre-#889 bug had (arg.mjs). board.mjs has
// exactly one writeSync call site — this is it, not the largest of four in
// this file — but it is one of four across the fleet (arg.mjs's die(),
// board.mjs's fault(), ci-state.mjs's emit(), staleness.mjs's verdict()) and
// carries the largest single payload of the four: a full stack, not a
// one-line refusal. A short write returns the count it actually wrote and
// throws nothing at all, so a bare try/catch around one call never sees it
// and the diagnostic is silently truncated with no error — the class
// ci-state.mjs's emit() had before #885, and the reason #889 gave
// die()/verdict() a bounded retry loop.
//
// A source-shape pin alone cannot tell a retry loop from a bare call that
// happens to fit in one write, and the pin below used to stop at the resumed
// writeSync call itself — the EAGAIN check, the MAX_EAGAIN_RETRIES cap and
// the Atomics.wait backoff that follow were unanchored, so a mutant that
// collapses the whole catch block to a bare `break;` — deleting the retry
// this PR exists to add — still passed it (measured). The regex below now
// anchors through those lines too, and board-cli.test.mjs pairs this with an
// EXECUTED companion: a real non-blocking stderr pipe that starts fully
// saturated and is never drained, the same rig staleness.test.mjs's verdict()
// test and arg.test.mjs's die() test use — but timed, not just bounded, since
// a doomed single call and a 200-retry loop against a pipe that never drains
// both write nothing and both still reach process.exit() well inside any
// generous bound; only the loop spends real time doing it.
//
// A body that still calls writeSync once and discards the count — `try {
// writeSync(2, ...) } catch {}` — satisfies a pin that stops at `try {`, so
// this one requires the loop that resumes from writeSync's own return value,
// and now the retry/backoff that follows it too. Each fragment is anchored at
// a line start and joined with `\s*^\s*`, and no fragment is terminated with
// `$`, so a comment line added inside fault() does not redden this and a
// trailing comment cannot satisfy it — the anchoring candidates.test.mjs's
// die() pin documents in full.
test("fault()'s writeSync loop consumes its own return value and retries EAGAIN with a capped backoff, not just a bare call", () => {
  assert.equal(
    stripComments(readFileSync(SCRIPT, "utf8")).match(/^\s*function fault\(/gm)?.length,
    1,
    "board.mjs declares fault() more than once, or not at all — the pin below reads the first",
  );
  assert.match(
    stripComments(readFileSync(SCRIPT, "utf8")),
    /^\s*function fault\(e\) \{\s*^\s*try \{\s*^\s*let buf = Buffer\.from\(`[^`]*`\);\s*^\s*let retries = 0;\s*^\s*while \(buf\.length\) \{\s*^\s*try \{\s*^\s*buf = buf\.subarray\(writeSync\(2, buf\)\);\s*^\s*\} catch \(writeErr\) \{\s*^\s*if \(writeErr\.code !== "EAGAIN" \|\| \+\+retries > MAX_EAGAIN_RETRIES\) break;\s*^\s*Atomics\.wait\(IDLE, 0, 0, 1\);/m,
  );
});

// board.mjs had no row in the design spec's script-surface table, so neither of
// its exit codes was written down anywhere a consumer reads. Derived from the
// script rather than restated here: the fault code is read out of board.mjs's
// own declaration, so changing it there and leaving the document behind reddens
// this — the drift #407 caught the hard way for candidates.mjs's exit 3.
test("the design spec's board row names both exit codes the script can produce", () => {
  const declared = readFileSync(SCRIPT, "utf8").match(/^const FAULT_EXIT = (\d+);$/m);
  assert.ok(declared, "board.mjs no longer declares FAULT_EXIT — update this test");
  const spec = readFileSync(
    fileURLToPath(new URL("../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `board.mjs` |"));
  assert.ok(row, "the design spec's script-surface table has no `board.mjs` row");
  for (const code of ["2", declared[1]]) {
    assert.match(row, new RegExp(`exit ${code}\\b`, "i"), `the board row does not name exit ${code}`);
  }
});
