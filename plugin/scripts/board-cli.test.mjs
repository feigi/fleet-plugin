// The --spend-since trust boundary, driven through the real CLI.
//
// Separate from board.test.mjs because these need a heavier rig than the
// process-boundary tests already there: gather() reaches the --spend-since
// guard only AFTER its gh reads, so these need a stub `gh` on PATH and a fake
// HOME holding a transcript, where the --ledger/--port cases die before any gh
// call and need neither.
//
// gather() reads process.argv directly and die()s with process.exit(2), so it
// cannot be called in-process the way gatherSpend() is — which is why this
// validation shipped with no coverage at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeProjectDir } from "./board.mjs";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));
const LEDGER = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

// One assistant turn, enough for readAgent to bill an agent. The summation
// shapes are board.test.mjs's business, not this file's.
const TURN = [
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 1 }, content: [{ type: "text" }] } },
];

// The stub `gh` fails on every call: each gh read goes through tryRun, which
// catches and degrades, so the board still builds and nothing here touches the
// network or this repo's live issue list. Prepended to PATH rather than
// replacing it, because gather() also shells out to `node`.
// `ledgerFile` overrides the missing-ledger default the --spend-since and
// --interval cases want: those die before the read matters, while the #807
// case below needs a real one the read has to carry back whole.
function runBoard(sinceArgs, ledgerFile) {
  const home = mkdtempSync(join(tmpdir(), "since-home-"));
  // realpath, not the bare mkdtemp path: on darwin $TMPDIR is under /var, which
  // is a symlink to /private/var, and the child's process.cwd() reports the
  // RESOLVED form. Encoding the unresolved one puts the fixture at a path
  // findSubagentsDir never looks in, and the panel comes back { error }.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "since-cwd-")));
  const bin = mkdtempSync(join(tmpdir(), "since-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  // findSubagentsDir() defaults to $HOME and cwd, so the fixture has to sit
  // where the encoding puts it — encodeProjectDir is the real function, not a
  // hand-rolled path, so this cannot drift from it.
  const sub = join(home, ".claude", "projects", encodeProjectDir(cwd), "sess", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-a.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return spawnSync(process.execPath, [BOARD, "build", "--ledger", ledgerFile ?? join(cwd, "nope.md"), ...sinceArgs], {
    cwd, encoding: "utf8",
    // This harness's own ceiling, not the subject's: a board built over a big
    // ledger prints a board.json past spawnSync's default, and the default
    // kills the child and reports `status: null` — which reads exactly like
    // the subject crashing. Measured: without this the #807 case fails on the
    // READER, with the fix under test working correctly.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("--spend-since rejects a seconds-magnitude epoch — the mistake its own comment names", () => {
  // The motivating bug, and the one a finiteness-only guard cannot see: a
  // seconds value is perfectly finite, so it passed, filtered nothing out, and
  // produced a whole-session panel that reported itself as scoped — shipping
  // the bogus number into board.json's `since`, where nothing downstream could
  // tell. 1e12 ms is 2001-09-09, so every seconds-magnitude epoch is below it.
  const r = runBoard(["--spend-since", String(Math.floor(Date.now() / 1000))]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since wants epoch milliseconds/);
});

test("--spend-since rejects garbage, zero, negative and a boundary in the future", () => {
  // A future boundary matches nothing at all, which renders as an empty panel
  // rather than as the operator error it is.
  for (const v of ["yesterday", "0", "-1", String(Date.now() + 86_400_000)]) {
    const r = runBoard(["--spend-since", v]);
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, /--spend-since wants epoch milliseconds/);
  }
});

test("--spend-since with the value omitted fails, rather than reading as 'no filter at all'", () => {
  // The flag as the last argv: arg() yields undefined and the guard's old
  // `sinceRaw == null` read that as "flag absent" — exit 0, whole session,
  // no stderr. Gating on has() is what closes it.
  const r = runBoard(["--spend-since"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since/);
});

// #364 gave has() a boolean-specific refusal, and gather() calls has() on
// --spend-since — a flag that TAKES a value. The wording stays correct only
// because arg("spend-since") runs before it and dies first; swap the two
// and the operator is told to drop a value the flag requires. Nothing pinned
// that order, so this does: measured, the reorder turns this message into
// "--spend-since is a boolean flag" while the rest of the suite stays green.
test("--spend-since=123 is refused as a value flag, not misreported as a boolean one", () => {
  const r = runBoard(["--spend-since=123"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since needs a space-separated value/);
});

test("a valid epoch-ms --spend-since survives the guard and reaches the payload", () => {
  // The leg that stops the guard from being merely strict. `since` is also the
  // only field downstream can read to tell a scoped panel from an unscoped one,
  // so it has to arrive, not just be accepted.
  const since = Date.now() - 3_600_000;
  const r = runBoard(["--spend-since", String(since)]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.spend.since, since);
  // This case's default ledger file (nope.md) never exists — build() must
  // still exit 0 and say so via ledgerState, not go silent about the refusal.
  assert.equal(body.ledgerState, "unread");
});

test("no --spend-since at all is not an error — the panel is simply unscoped", () => {
  const r = runBoard([]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.spend.since, null);
  assert.equal(body.ledgerState, "unread");
});

// #366: the SECOND --interval read site. gather()'s own argInterval() fallback
// — reached only through `build`, after the same gh reads as --spend-since
// above — is distinct from serve()'s (pinned in board.test.mjs) and a fix
// there alone would leave this one still silently defaulting.
test("build: --interval abc is refused, not silently read as the 15s default", () => {
  const r = runBoard(["--interval", "abc"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--interval wants seconds > 0 and <= 2147483, got abc/);
});

test("build: --interval 0, a negative value and an over-range value are all refused", () => {
  for (const v of ["0", "-5", "3000000"]) {
    const r = runBoard(["--interval", v]);
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, /--interval wants seconds > 0 and <= 2147483/);
  }
});

test("build: a valid --interval survives the guard and reaches the payload", () => {
  const r = runBoard(["--interval", "42"]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.interval, 42);
  // This case's default ledger file (nope.md) never exists — build() must
  // still exit 0 and say so via ledgerState, not go silent about the refusal.
  assert.equal(body.ledgerState, "unread");
});

// ── #363: the pipe-race that motivated this file's --spend-since rig ──────────
//
// Same reason this file exists at all (see header): the --spend-since guard
// fires only AFTER gather()'s gh reads, and tryRun() (board.mjs) runs each
// one through `execFileSync`, passing no `stdio` option. That CAPTURES the
// child's stderr rather than inheriting it, and re-emits it through
// board.mjs's OWN process.stderr — the child never touches an inherited
// fd 2. So the write that has to clear the pipe before die() can land is
// board.mjs's own, and on a pipe that is an async stream write: whatever is
// still queued when process.exit() runs is discarded.
//
// Measured, both shapes, each parent flooding 200,000 B and then exiting,
// read by a spawn() reader identical to runBoardFlooded's — tryRun's
// no-stdio form delivers 65,536 B, while stdio [..., "inherit"], which is
// what actually inherits fd 2, delivers all 200,000.
//
// #367 fixed the write itself (writeSync, not console.error — see arg.mjs),
// but nothing drove the race that motivated it. This does, and it is the
// non-flaky shape the ticket asks for — deliberately NOT candidates.test.mjs's
// EAGAIN test, which pins a different failure (the exit CODE inverting to 1,
// not the message vanishing), is racy by its own account (its comment: "7/15
// unfixed runs inverted"), and says darwin never fires it at all.
//
// Driven through this test's own rig, against a die() reverted to
// console.error: the refusal is dropped every run and delivered stderr caps
// at exactly 65,536 B, at 66,000 / 200,000 / 2,000,000 alike. The shipped
// writeSync die() delivers 65,599 B at every one of those sizes — the same
// cap plus the refusal.
//
// This ran darwin-only until #951, behind "the loss was measured on darwin and
// nowhere else". That was true of the measurement, not of the loss — nobody had
// driven this scenario on Linux, and the gate's own wording is what stopped
// anyone re-checking. Driven on it now, 100 runs per arm, ubuntu-24.04 /
// node 26.5.0 (this repo's CI runner and its .nvmrc), same rig as below:
//
//   build                          refusal LOST  stderr bytes  distinct
//   die() = writeSync   (PIPE)         0/100     146239-182783        2
//   die() = console.error (PIPE)     100/100            146176        1
//   die() = console.error (FILE)       0/100            600187        1
//
// The mutant drops the refusal on every Linux run, at one byte count, so the
// platform gate was hiding real coverage rather than protecting a vacuous
// green. It is gone, and this file no longer reads process.platform at all.
//
// It was the last one: no test in this suite is now gated on the platform, so
// nothing here is unexercised on CI by construction the way #337 found. The
// conditional skips that remain — candidates.test.mjs's gojq gate and the
// SKIP_WITHOUT_REPO sweeps — are runtime-capability gates that CI provisions
// for and does execute. A non-zero `skipped` on CI is therefore a real signal
// again rather than the permanent floor it used to be, which is the residue
// #337 left and #951 closes.
//
// The FILE row is the control that removal rests on, and it is why the stdio
// below must stay a pipe: on a file fd the same mutant keeps the refusal 100/100
// and delivers all 600,187 bytes, so a harness capturing to a file would pass
// whether or not die() was ever fixed.
//
// Two sampling notes, both recorded because each misleads on its own:
//
//   - A SINGLE Linux run of the mutant delivered all 600,187 bytes with the
//     refusal intact. The loss is deterministic under the back-to-back load of
//     a repeated run and absent in one isolated shot, so n=1 is not evidence
//     here in either direction, including a single green run of this test.
//   - One 25-run sample of the FIXED build lost the refusal 1/25, with a
//     546,301-byte outlier. That is #889 — die()'s writeSync is unlooped, so a
//     non-blocking pipe can short-write it — not this gate's subject. It did
//     not recur over 100 further runs, and the whole test flaked 0/30 end to
//     end. If this test ever does red on a correct build, that is the cause and
//     #889 is the fix; do not re-gate this on the platform for it.
//
// Nothing about the EAGAIN exit-code inversion (#299/#328) is claimed here.
// That is the other half of this file family — probabilistic, and genuinely
// darwin-immune. This is the truncation half (#176/#246/#328/#363), which is
// deterministic on both platforms. Do not merge the two.

// The stub has one job: make board.mjs's re-emission of this output a single
// write bigger than the pipe can hold. `head -c` rather than a hand-rolled
// Node writer so the bytes come off an ordinary child, as gh's do. Any size
// past the 65,536 B capacity does it, and they all behave identically —
// measured on the fixed build, 66,000 / 200,000 / 2,000,000 each deliver
// 65,599 B — so the headroom above the cap buys nothing and costs nothing.
// Named, because the guard below is tied to it: de-tune one and the other
// goes red instead of quietly vacuous.
const FLOOD_BYTES = 200_000;
const FLOOD_GH_STUB = `#!/bin/sh\nyes F | head -c ${FLOOD_BYTES} >&2\nexit 0\n`;

// One pipe buffer — the cap every measurement above lands on. The fixture has
// to clear it or this test proves nothing: shrink FLOOD_BYTES under the cap and
// the flood arrives whole, the refusal is never at risk, and all three
// assertions below pass green under the very bug they exist to pin. Asserted
// rather than trusted to the comment, because that is the failure a later
// de-tuning would introduce silently.
const PIPE_BUF = 65_536;
assert.ok(
  FLOOD_BYTES > PIPE_BUF * 2,
  `flood fixture must outgrow the pipe buffer with headroom: ${FLOOD_BYTES} <= ${PIPE_BUF * 2}`,
);

// Async spawn + immediate drain: `close` rather than `exit`, so every byte
// the stream ever receives is captured before assertions run, not just
// whatever arrived by the time the process exited. stdout is discarded
// rather than piped — nothing here asserts on it, and an unread pipe is one
// more thing that can stall the child.
function runBoardFlooded() {
  const cwd = mkdtempSync(join(tmpdir(), "since-flood-cwd-"));
  const bin = mkdtempSync(join(tmpdir(), "since-flood-bin-"));
  writeFileSync(join(bin, "gh"), FLOOD_GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [BOARD, "build", "--ledger", join(cwd, "nope.md"), "--spend-since", "notanumber"],
      { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test(
  "build: --spend-since's refusal survives a gh child that has already pushed past the pipe buffer, unread",
  async () => {
    const r = await runBoardFlooded();
    // The flood must have OVERRUN the pipe, not arrived whole — and tied to
    // FLOOD_BYTES this is exact rather than a heuristic: gather() re-emits
    // three of these, so delivering even the FIRST one intact already puts
    // r.stderr at >= FLOOD_BYTES. Landing below it means the first re-write
    // was cut short, which is the loss this test exists for.
    //
    // A literal 65,536 floor fails open instead, because r.stderr sums all
    // three calls: three sub-cap floods total past it while every one of
    // them arrives complete, refusal included. Measured against a
    // console.error die() at 22,000 B — 66,188 delivered, refusal PRESENT,
    // all three assertions here green under the very bug they pin. That
    // darwin-era (65,536 mutant, 65,599 fixed) pair reads as headroom this
    // gate no longer has: the 100-run Linux measurement above puts the real
    // outcomes at 146,176 (mutant) and 146,239-182,783 (fixed) — within
    // ~17,217 B of FLOOD_BYTES, not far below it. The #889 outlier
    // (546,301 B) clears FLOOD_BYTES outright, so it would fail this
    // overrun assertion too, not only the refusal-match below.
    assert.ok(
      r.stderr.length < FLOOD_BYTES,
      `gh's flood must overrun the pipe, not arrive whole: got ${r.stderr.length} of ${FLOOD_BYTES}`,
    );
    assert.match(r.stderr, /board: --spend-since wants epoch milliseconds, got notanumber/);
    assert.equal(r.status, 2, r.stderr.slice(-300));
  },
);

// #365: board.mjs's known set is the UNION over both subcommands, so every
// name in it has to survive a run of either one. Driven on `build` because
// runBoard already has the rig; --port/--open are read only by serve() and are
// accepted-and-ignored here, which is the pre-existing gap board.mjs's own
// comment names and #365 does not close.
//
// A name dropped from that set refuses an invocation board.mjs accepts. Other
// tests pass most of these names too and redden alongside — measured, all six
// do, so this is NOT the only row that would go red. What it adds is the WHOLE
// set in a single run: `--prev` appears elsewhere only as the value placeholder
// in board.test.mjs's `--ledger followed by another flag` case, incidental
// cover a rename would remove, and a name added to the set later has exactly
// one row obliged to carry it.

// #468 AC-4: build now validates --port/--open's SHAPE (moved in board.mjs's
// main(), tested malformed in board.test.mjs, which can drive that case
// without this file's gh-stub rig because the guard dies before gather()'s
// first gh read) — but never reads either VALUE. build has no server to bind
// or browser to open, so a well-formed --port/--open behaves exactly as
// before this fix: accepted, unused, board built and printed at exit 0. This
// is the ruling's other half and the one a malformed-only suite cannot see —
// it must NOT newly refuse a caller who typed the flag correctly.
test("build: a well-formed --port/--open is accepted and simply unused, per the #468 ruling", () => {
  const r = runBoard(["--port", "9999", "--open"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).spend.since, null);
});

test("every flag board.mjs accepts survives the unknown-flag sweep in one build", () => {
  const r = runBoard([
    "--prev", "nope.json",
    "--spend-since", String(Date.now() - 3_600_000),
    "--interval", "42",
    "--port", "0",
    "--open",
  ]);
  assert.equal(r.status, 0, `a working invocation was refused: ${r.stderr}`);
  // NOT subsumed by the status assertion above: gather() reaches ledger.mjs
  // through tryRun(), which forwards the child's stderr and then swallows its
  // failure, so a fleet sibling refusing a flag board.mjs passed it lands on
  // this stderr at exit 0 (measured). ledger.mjs still parses --file by hand,
  // so that skew is live, not hypothetical. ci-state.test.mjs's sibling test
  // carried this same line and there it WAS subsumed — dropped, not forgotten.
  assert.doesNotMatch(r.stderr, /unknown flag/);
  assert.equal(JSON.parse(r.stdout).interval, 42);
});

// ── #807: a ledger read big enough to hit node's default stdout cap ──────────
//
// `tryRun` runs every board read through `execFileSync`, and with no
// `maxBuffer` node applies its default stdout cap and KILLS the child past it
// rather than truncating. In `tryRun` that throw is indistinguishable from an
// unreachable tool: the read degrades to `tryParse`'s empty ledger and the
// cockpit renders a board with nothing on it at HTTP 200, one stderr line the
// only trace. That is #246's own symptom — #803 moved the cliff up from the
// pipe buffer rather than removing it.
//
// Pinned on the ACCEPT side, deliberately. Asserting the failure shape instead
// would stay green on a board.mjs that refused the oversized read outright,
// and a refusal is not the fix: the ledger grows for the life of a run, so the
// read has to keep working, not fail more legibly.
//
// This file rather than board.test.mjs for the reason in the header: the read
// happens inside gather(), which cannot be driven in-process, and the rig that
// stubs `gh` out of the way already lives here.
const OVERSIZED_ROWS = 4000;

// The row shape `ledger.mjs row` actually writes, padded so the JSON payload
// clears the cap. Padding rather than more rows keeps the fixture's cost in
// bytes instead of in parse work. Every row gets its own key, so a read that
// arrived short cannot satisfy the count assertions by coincidence.
function oversizedLedger() {
  const section = (kind) => Array.from(
    { length: OVERSIZED_ROWS },
    (_, i) => `- #${i} ${kind}-${i} · class=routine · ${"pad".padEnd(120, "x")}`,
  ).join("\n");
  return `# Fleet run ledger\n\n## Rows\n\n${section("impl")}\n\n## Filed\n\n${section("finding")}\n\n## Ruled\n\n${section("pr")}\n`;
}

test("build: a ledger read past node's default stdout cap arrives whole, not as an empty board", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-big-ledger-"));
  const ledger = join(dir, "ledger.md");
  writeFileSync(ledger, oversizedLedger());

  // Calibration, not decoration. It proves THIS fixture still exercises the
  // capped mode on the node running the suite, using the exact call shape
  // board.mjs had before the fix. Without it, a fixture that drifted under the
  // cap — or a node whose default rose above it — leaves everything below
  // passing over a read that was never at risk, which is the vacuous green
  // this test exists to refuse.
  assert.throws(
    () => execFileSync(process.execPath, [LEDGER, "--file", ledger, "read"], { encoding: "utf8" }),
    (e) => e.code === "ENOBUFS",
    "fixture no longer clears node's default stdout cap — enlarge it; the assertions below prove nothing without this",
  );

  const r = runBoard([], ledger);
  assert.equal(r.status, 0, r.stderr);
  const board = JSON.parse(r.stdout);
  // Counts, not emptiness: `tickets: 0` is what the bug produced, but so is a
  // read that came back with some rows and lost the rest.
  assert.equal(board.tickets.length, OVERSIZED_ROWS, `tickets lost: ${r.stderr.slice(-300)}`);
  assert.equal(board.filed.length, OVERSIZED_ROWS, `filed rows lost: ${r.stderr.slice(-300)}`);
  // The read must not have been reported as failed either — the stub `gh`
  // failures on the same stderr are expected and are not this read.
  assert.doesNotMatch(r.stderr, /ledger\.mjs[^\n]*failed/);
});
