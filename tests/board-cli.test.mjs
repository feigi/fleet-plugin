// The --spend-since and --spend-dir trust boundaries, driven through the real
// CLI.
//
// Separate from board.test.mjs because these need a heavier rig than the
// process-boundary tests already there. Before #1076, gather() reached the
// --spend-since guard only AFTER its gh reads, so even the malformed-value
// cases below needed a stub `gh` on PATH and a fake HOME holding a
// transcript, where the --ledger/--port cases (in board.test.mjs) died
// before any gh call and needed neither.
// #1076 hoisted the same read (now argSpendSince()) into
// main(), ahead of the build/serve dispatch and ahead of gh reads too — but
// the rig stays: the success-path cases below (a valid value reaching the
// payload, the #807 case) still run gather() to completion
// and need the stub either way.
//
// The validation under test lives in main(), which reads process.argv directly
// and die()s with process.exit(2), so it is driven through the real CLI rather
// than called in-process the way gatherSpend() is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeProjectDir } from "../plugin/scripts/member-record.mjs";
import { writeReceipt, offlineBoardBin } from "./support/board-rig.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const BOARD = fileURLToPath(new URL("../plugin/scripts/board.mjs", import.meta.url));
const LEDGER = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

// One assistant turn, enough for readOmpSpend to bill an agent — the omp
// envelope's own shape (member-record.mjs's foldOmpTranscript comment). The
// summation shapes are board-gather.test.mjs's business, not this file's.
const ompTurn = (cacheWrite) => [
  { type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd: "/w" },
  { type: "message", id: "m1", parentId: "s1", timestamp: "2026-09-08T15:12:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite, totalTokens: 0, cost: { total: 0 } } } },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

// The stub `gh` fails on every call: each gh read goes through tryRun, which
// catches and degrades, so the board still builds and nothing here touches the
// network or this repo's live issue list. Prepended to PATH rather than
// replacing it, because gather() also shells out to `node`.
// `ledgerFile` overrides the missing-ledger default the --spend-since and
// --interval cases want: those die before the read matters, while the #807
// case below needs a real one the read has to carry back whole. `seed` lays
// a session's transcripts into the fake $HOME and records it in the phase-0
// receipt the child's board reads its spend session from.
function runBoard(sinceArgs, ledgerFile, seed = seedDefault) {
  const home = tempDir("since-home-");
  // realpath, not the bare mkdtemp path: on darwin $TMPDIR is under /var, which
  // is a symlink to /private/var, and the child's process.cwd() reports the
  // RESOLVED form. Encoding the unresolved one puts the fixture at a path
  // omp would never write for this cwd.
  const cwd = realpathSync(tempDir("since-cwd-"));
  const bin = offlineBoardBin("since-bin-");
  seed(home, cwd);
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

// The session sits where omp would write it for this cwd — encodeProjectDir
// is the real function, not a hand-rolled path — under an `<ISO>_<uuid>`
// name, and the receipt records it. The cwd is no git checkout, so the
// board's state directory is the cwd's own `.fleet`, and the receipt goes there.
function seedDefault(home, cwd) {
  const dir = join(home, ".omp", "agent", "sessions", encodeProjectDir(cwd, { home }),
    "2026-08-25T09-00-00-000Z_01a08126-ee04-7095-a695-14e3249f1127");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "default-agent.jsonl"), ompTurn(1000));
  writeReceipt(join(cwd, ".fleet"), dir);
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
  // no stderr. arg()'s own value guard is what closes it: argSpendSince()
  // tests `=== null` only on what arg() already accepted.
  const r = runBoard(["--spend-since"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since/);
});

// #364 gave has() a boolean-specific refusal, and gather() used to call has()
// on --spend-since — a flag that TAKES a value — so the wording stayed
// correct only while arg("spend-since") ran first. #1077 retired that has():
// the flag table declares --spend-since "value", so a has() read of it would
// now refuse as a bug. This pins the operator-facing wording either way.
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

// ── #1583: --spend-dir on the one-shot path ──────────────────────────────────
//
// `build` is one gather per process, and takes the same OVERRIDE every serve
// tick does — the same split --spend-since already has.
//
// This rig is what makes "overrode" observable: runBoard()'s default seed
// records a readable session in the receipt, so the board has a real answer
// of its own and a flag that did nothing would still produce a panel.
test("build: --spend-dir reads the named directory instead of the session the receipt records", () => {
  const root = tempDir("since-named-");
  const dir = join(root, "2026-08-25T09-00-00-000Z_abcdef12-3456-7890-abcd-ef1234567890");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "named.jsonl"), ompTurn(2000));
  const r = runBoard(["--spend-dir", dir]);
  assert.equal(r.status, 0, r.stderr);
  const spend = JSON.parse(r.stdout).spend;
  assert.equal(spend.ok, true, r.stderr);
  assert.equal(spend.totals.cacheWrite, 2000, "the panel came from the receipt's session, not the named one");
  assert.equal(spend.top[0].label, "named");
});

test("build: with no --spend-dir the panel comes from the session the receipt records", () => {
  // The other half of the same guard, and the one that catches the plausible
  // wiring slip: a `spendDir` defaulted to `null` rather than left absent
  // skips the receipt and blanks this panel on every subcommand at once,
  // with nothing on stderr to say so.
  const r = runBoard([]);
  assert.equal(r.status, 0, r.stderr);
  const spend = JSON.parse(r.stdout).spend;
  assert.equal(spend.ok, true, r.stderr);
  assert.equal(spend.totals.cacheWrite, 1000);
});

test("build: with no --spend-dir and no receipt the panel says so, naming both ways out", () => {
  const r = runBoard([], undefined, () => {});
  assert.equal(r.status, 0, r.stderr);
  const spend = JSON.parse(r.stdout).spend;
  assert.deepEqual(spend, { ok: false, error: "no session recorded — run phase 0 or pass --spend-dir" });
});

test("build: --spend-dir naming a directory that does not exist yet is accepted, not refused", () => {
  // The invocation this flag exists for, and the one an existence check at the
  // guard would refuse: a session directory is not created until its own
  // launch, and the cockpit launches in run-team phase 0, before that. The
  // operator names the directory; it appears seconds later. Until then the
  // panel hides — never zeroes, and never a refusal.
  const r = runBoard(["--spend-dir", join(tempDir("since-absent-"), "2026-08-26T09-00-00-000Z_01a08126-ee04-7095-a695-14e3249f1128")]);
  assert.equal(r.status, 0, r.stderr);
  const spend = JSON.parse(r.stdout).spend;
  assert.equal(spend.ok, false, "an unreadable named directory must not report spend");
  assert.equal(spend.totals, undefined, "and must not render a zeroed total in its place");
  // The override really did override: the receipt's session is still sitting
  // there readable, and a fallback to it would have produced a panel.
  assert.doesNotMatch(r.stdout, /"cacheWrite":1000/);
});

// One omp member transcript in the measured line shape (member-record.mjs's
// foldOmpTranscript comment). #1717: a toolCall/toolResult pair ahead of the
// billing turn, so this fixture is the one place the merged tool table's
// numbers survive the real CLI subprocess + JSON.stringify/JSON.parse
// boundary — every other assertion on this shape calls gatherSpend()/
// attributeTools() in-process. The call turn itself bills 0, so `cacheWrite`
// below still lands whole on the total AND (via the pending result batch)
// wholly attributed to "read".
const OMP_SESSION = "2026-09-08T13-13-27-300Z_01a08126-ee04-7095-a695-14e3249f1127";
const ompMember = (cacheWrite) => [
  { type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd: "/w" },
  { type: "session_init", id: "i1", parentId: null, timestamp: "2026-09-08T15:11:49.495Z", task: "Implement ticket 7", agent: "fleet-implementer" },
  { type: "message", id: "m1", parentId: "i1", timestamp: "2026-09-08T15:11:59.000Z",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {}, intent: "x" }],
      model: "claude-opus-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } },
  { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-08T15:11:59.500Z",
    message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "x".repeat(100) }], details: {}, isError: false, timestamp: 0 } },
  { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-08T15:12:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5", usage: { input: 1, output: 3, cacheRead: 40, cacheWrite, totalTokens: 0, cost: { total: 0.01 } } } },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

// The session dir as omp lays it out, with its main-session FILE beside it
// carrying a number that only a wrong read could put on the panel.
function ompSessionAt(proj) {
  const dir = join(proj, OMP_SESSION);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "impl-7.jsonl"), ompMember(3000));
  writeFileSync(join(proj, `${OMP_SESSION}.jsonl`), ompMember(999_999));
  return dir;
}

test("build: the panel comes from this workspace's own omp session, with its tool table intact", () => {
  // The default path, no flag: the receipt records the session omp laid out,
  // its main-session FILE beside it.
  const r = runBoard([], undefined, (home, cwd) => {
    writeReceipt(join(cwd, ".fleet"), ompSessionAt(join(home, ".omp", "agent", "sessions", encodeProjectDir(cwd, { home }))));
  });
  assert.equal(r.status, 0, r.stderr);
  const spend = JSON.parse(r.stdout).spend;
  assert.equal(spend.ok, true, r.stderr);
  assert.equal(spend.totals.cacheWrite, 3000);
  assert.deepEqual(spend.top.map((t) => [t.label, t.role, t.model]), [["impl-7", "implementer", "claude-opus-5"]]);
  assert.deepEqual(spend.tools.map((t) => [t.tool, t.calls, t.resultChars, t.cacheWrite]), [["read", 1, 100, 3000]]);
  assert.equal(spend.attributedPct, 100);
});

test("build: --spend-dir accepts a session directory over a receipt that records another", () => {
  // runBoard's default seed records a session of its own (1000), so these
  // numbers can only arrive through the named directory.
  const dir = ompSessionAt(tempDir("since-omp-"));
  const r = runBoard(["--spend-dir", dir]);
  assert.equal(r.status, 0, r.stderr);
  const spend = JSON.parse(r.stdout).spend;
  assert.equal(spend.ok, true, r.stderr);
  assert.equal(spend.totals.cacheWrite, 3000);
  assert.equal(spend.top[0].label, "impl-7");
});

// #366: the --interval read on `build`, where the value reaches the payload
// rather than a timer — distinct from serve()'s (pinned in board.test.mjs).
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
  const dir = tempDir("board-big-ledger-");
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

// ── #1093: a fault is not a refusal ──────────────────────────────────────────
//
// `main().catch()` used to hand every rejection to die(), the REFUSAL helper,
// so a bug in this script printed what a typo prints: one `board: <text>` line
// at exit 2, stack dropped.
//
// The fault driven here is the gap gather()'s own comment names and accepts:
// `tryParse` checks the ledger read is JSON, never that it is the
// `{rows,filed,ruled}` shape, because ledger.mjs is this repo's own tested
// producer of it. That read is `tryRun("node", [ledger.mjs, ...])`, backed by
// async `execFile` (see execRead in board-common.mjs), so a
// `node` earlier on PATH is the entire fixture, and a wrong-typed `rows`
// reaches compute-board.mjs's `(ledger.rows || []).map` with nothing between
// the TypeError and main()'s catch.
//
// Deliberately NOT the `--prev` route the ticket used to reach the handler: a
// previous board that parses but carries a wrong-typed `tickets` is a SEPARATE
// defect (a corrupt prev board is meant to be ignored, not fatal), and a test
// riding on it would turn green-and-vacuous the day that one is fixed. This
// route rests on a documented non-guard instead of a broken one.
// Split from the spawn itself so the timing test below can drive the same
// fixture through python3's saturated-pipe rig instead of spawnSync.
function boardFaultFixture() {
  const cwd = realpathSync(tempDir("board-fault-cwd-"));
  const bin = offlineBoardBin("board-fault-bin-");
  // Valid JSON, wrong shape: `rows` is an object where every consumer wants an
  // array. Answers any argv, which is all gather()'s single `node` read needs.
  writeExecStub(join(bin, "node"), `#!/bin/sh\necho '{"rows":{},"filed":[],"ruled":[]}'\n`);
  return {
    cwd,
    argv: [BOARD, "build", "--ledger", join(cwd, "nope.md")],
    env: { ...process.env, HOME: cwd, PATH: `${bin}:${process.env.PATH}` },
  };
}

function runBoardFaulted() {
  const { cwd, argv, env } = boardFaultFixture();
  return spawnSync(process.execPath, argv, { cwd, encoding: "utf8", env });
}

test("build: an internal fault exits 70 with a stack, where a refusal exits 2 with one line", () => {
  const r = runBoardFaulted();
  // Exit 0 here means the ledger shape got guarded somewhere and this fixture
  // no longer reaches the handler at all — pick another reachable fault rather
  // than deleting the pin.
  assert.equal(r.status, 70, `expected the fault exit, got ${r.status}: ${r.stderr.slice(-400)}`);
  assert.match(r.stderr, /internal fault/, "the fault must say it is one, not read as a refusal");
  // A real stack, not a message: at least one frame naming the file that threw.
  // This is the assertion the old `die(e.message)` handler cannot satisfy.
  assert.match(r.stderr, /\n\s+at .*compute-board\.mjs:\d+/, `no stack frame on stderr: ${r.stderr.slice(-400)}`);
  assert.equal(r.stdout, "", "a fault must not also print a board");

  // The other half of the distinction, measured in the same run rather than
  // inferred from the refusal cases above: a genuine refusal is still one line
  // at exit 2 with no stack and no stdout. `--port abc` dies in main() ahead of
  // every read, so it needs none of the rig above.
  const refusal = spawnSync(process.execPath, [BOARD, "build", "--port", "abc"], { encoding: "utf8" });
  assert.equal(refusal.stderr, "\nboard: --port wants an integer 0-65535, got abc\n");
  assert.equal(refusal.status, 2);
  assert.equal(refusal.stdout, "");
  assert.notEqual(refusal.status, r.status, "a fault and a refusal must not share an exit code");
});

// #1547: fault()'s EAGAIN retry loop, executed rather than pinned only as
// source shape (board.test.mjs's companion pin covers the shape; this drives
// the real writeSync(2, ...) call through the fixture above). The rig mirrors
// staleness.test.mjs's verdict() test and arg.test.mjs's die() test: a real
// non-blocking stderr pipe, filled to capacity with fcntl's O_NONBLOCK before
// the child ever touches it, held open with its read end never drained.
//
// Those two tests only bound the WORST case — the loop must still give up
// and call process.exit() rather than hang — and that alone cannot tell a
// retry loop from a bare `try { writeSync(2, buf) } catch {}`: against a pipe
// that never drains, a doomed single call and a 200-retry loop both write
// nothing and both reach process.exit(FAULT_EXIT) well inside any generous
// bound. What the loop spends that a bare call does not is TIME: every
// EAGAIN costs a real syscall plus a 1ms Atomics.wait, so
// MAX_EAGAIN_RETRIES iterations measurably outlast one failed call.
//
// Isolating that from this fixture's own cost is the rest of the rig: a cold
// `build` invocation here spawns two subprocesses (the stub `node` for the
// ledger read, then `gh`) and can take single-digit SECONDS on a loaded
// machine, against ~50ms once the OS/file caches are warm (measured on this
// machine) — noise far larger than the retry loop's own cost. A discarded
// warm-up run of the IDENTICAL fixture before the timed pairs cancels that
// noise; what is left is the loop's own cost. Measured on this machine: the
// real loop adds ~300-360ms over a from-/dev/null baseline of the same
// fixture; a body that calls writeSync once and swallows the exception added
// ~20-30ms in that single pre-change sample, which is not a bound.
// FAULT_RETRY_FLOOR_MS sits several times above that bare-call figure and
// below the real loop's lowest delta measured after #2385 (216ms, below), so
// the margin on the real-loop side is narrow.
//
// #2385: one sample of each was not enough on a loaded CI runner, where a
// real loop measured BASE=0.221 SAT=0.370 — 149ms, one under the floor.
// Scheduler noise only ever ADDS time to a run, so the harness takes
// FAULT_TIMING_PAIRS interleaved baseline/saturated pairs and compares the
// fastest of each: one slow tick no longer moves either side. Measured on
// this machine after the change: the real loop's fastest-vs-fastest delta
// read 216-429ms. A bare-call body's read -244 to +127ms across repeated
// runs on a host that was never idle (load average 80-140 on 14 cores, some
// runs with two `yes > /dev/null` per core added) — the sign flips from run
// to run, so that delta is noise, not a cost.
const FAULT_RETRY_FLOOR_MS = 150;
const FAULT_TIMING_PAIRS = 5;

test("fault()'s writeSync loop spends real time retrying a saturated stderr, not the ~30ms a bare call would take", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const { cwd, argv, env } = boardFaultFixture();

  const harness = [
    "import fcntl, os, subprocess, sys, time",
    "argv = sys.argv[1:]",
    "def run_baseline():",
    "    t0 = time.monotonic()",
    "    r = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)",
    "    return time.monotonic() - t0, r.returncode",
    "def run_saturated():",
    "    r, w = os.pipe()",
    "    fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)",
    "    try:",
    "        while True:",
    "            os.write(w, b'x' * 65536)",
    "    except BlockingIOError:",
    "        pass",
    "    t0 = time.monotonic()",
    "    proc = subprocess.Popen(argv, stderr=w, stdout=subprocess.DEVNULL)",
    "    os.close(w)",
    "    proc.wait(timeout=60)",
    "    elapsed = time.monotonic() - t0",
    "    os.close(r)",
    "    return elapsed, proc.returncode",
    "run_baseline()",
    `for _ in range(${FAULT_TIMING_PAIRS}):`,
    "    base_t, base_code = run_baseline()",
    "    print(f'BASE={base_t:.3f} EXIT={base_code}')",
    "    sat_t, sat_code = run_saturated()",
    "    print(f'SAT={sat_t:.3f} EXIT={sat_code}')",
  ].join("\n");

  const r = spawnSync("python3", ["-c", harness, process.execPath, ...argv], { cwd, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `harness itself failed: ${r.stderr}`);
  const samples = { BASE: [], SAT: [] };
  for (const [, kind, s, exit] of r.stdout.matchAll(/^(BASE|SAT)=(\d+\.\d+) EXIT=(-?\d+)$/gm)) {
    assert.equal(Number(exit), 70, `a ${kind} run did not reach the fault exit: ${r.stdout}`);
    samples[kind].push(Number(s));
  }
  assert.equal(samples.BASE.length, FAULT_TIMING_PAIRS, `harness printed the wrong number of baseline samples: stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(samples.SAT.length, FAULT_TIMING_PAIRS, `harness printed the wrong number of saturated samples: stdout=${r.stdout} stderr=${r.stderr}`);
  const deltaMs = (Math.min(...samples.SAT) - Math.min(...samples.BASE)) * 1000;
  assert.ok(
    deltaMs > FAULT_RETRY_FLOOR_MS,
    `fault() against a saturated stderr took only ${deltaMs.toFixed(0)}ms more than baseline (fastest of ` +
      `${FAULT_TIMING_PAIRS} each) — the retry loop must spend real time on EAGAIN, not return almost ` +
      `immediately like a bare call: ${r.stdout}`,
  );
  // No upper bound here: MAX_EAGAIN_RETRIES capping the loop rather than
  // spinning forever against a reader that never drains is board.test.mjs's
  // job (the regex pin anchors the cap and the break condition) — this test's
  // job is only the floor above. An upper bound here would also be the first
  // thing to false-positive under real scheduling contention, since each
  // Atomics.wait(…, 1) is a 1ms TARGET, not a guarantee, under load.
});
