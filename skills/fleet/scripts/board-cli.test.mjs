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
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeProjectDir } from "./board.mjs";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));

// One assistant turn, enough for readAgent to bill an agent. The summation
// shapes are board.test.mjs's business, not this file's.
const TURN = [
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 1 }, content: [{ type: "text" }] } },
];

// The stub `gh` fails on every call: each gh read goes through tryRun, which
// catches and degrades, so the board still builds and nothing here touches the
// network or this repo's live issue list. Prepended to PATH rather than
// replacing it, because gather() also shells out to `node`.
function runBoard(sinceArgs) {
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
  return spawnSync(process.execPath, [BOARD, "build", "--ledger", join(cwd, "nope.md"), ...sinceArgs], {
    cwd, encoding: "utf8",
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
// because arg("spend-since") runs one line earlier and dies first; swap the two
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
  assert.equal(JSON.parse(r.stdout).spend.since, since);
});

test("no --spend-since at all is not an error — the panel is simply unscoped", () => {
  const r = runBoard([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).spend.since, null);
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
  assert.equal(JSON.parse(r.stdout).interval, 42);
});

// ── #363: the pipe-race that motivated this file's --spend-since rig ──────────
//
// Same reason this file exists at all (see header): the --spend-since guard
// fires only AFTER gather()'s gh reads, and tryRun() (board.mjs) forwards
// each gh child's stderr straight through — no `stdio` override, so it
// inherits board.mjs's own fd 2. That is the exact shape #363 is about: a
// single child dumping enough bytes into a PIPED stderr can fill it before
// board.mjs ever gets to write its own refusal.
//
// #367 fixed the write itself (writeSync, not console.error — see arg.mjs),
// but nothing drove the race that motivated it. This does, and it is the
// non-flaky shape the ticket asks for, deliberately NOT candidates.test.mjs's
// EAGAIN test (which uses spawnSync and is admittedly racy — its own comment
// says 7/15 unfixed runs inverted). spawnSync drains the child's pipes with
// its own tight internal poll loop, which is fast enough to avoid the loss
// most of the time (a refuter measured a clean 209,865-byte survival that
// way). `spawn()` below, read through Node's ordinary Readable stream (the
// same path a real caller's piped stderr — a log file, `tee`, an agent
// controller reading a pipe — actually goes through), is bounded by that
// stream's highWaterMark (64 KiB) and reliably reproduces the loss instead:
// measured on this machine, a reverted console.error-based die() drops the
// message every run, capped at exactly 65,536 bytes received, matching the
// 200,000 B measurement in #363's own ruling (PR #222). writeSync bypasses
// that queue entirely — a direct fd write, not a Writable stream write — so
// the fixed code survives the identical flood reliably too.
//
// Darwin-only, and skipped elsewhere rather than left to pass silently: the
// loss is Node's OWN documented async pipe-write behaviour for
// process.stdout/stderr, which the Node docs and #363's ruling both scope to
// POSIX pipes generally, but this file's own prior measurements (and #363's)
// found it doesn't actually manifest on Linux's write path the same way — a
// green run there would prove nothing about the fix, so it must not read as
// coverage. See docs/agents/... no such doc; the platform gate below is the
// only gate.
const IS_DARWIN = process.platform === "darwin";

// A real `head -c` burst, not a hand-rolled Node writer: this is what a real
// forwarded child (gh, git) looks like from board.mjs's side — an ordinary
// process writing straight to its inherited fd 2, no non-blocking games on
// its own end. 200,000 B: comfortably past both the pipe's own buffer and
// the Readable stream's 64 KiB highWaterMark, matching #363's own reference
// measurement so the byte count here is traceable to that thread rather than
// picked arbitrarily.
const FLOOD_GH_STUB = "#!/bin/sh\nyes F | head -c 200000 >&2\nexit 0\n";

// Async spawn + immediate drain (not spawnSync — see header comment above):
// `close` rather than `exit`, so every byte the stream ever receives is
// captured before assertions run, not just whatever arrived by the time the
// process exited.
function runBoardFlooded(sinceValue) {
  const cwd = mkdtempSync(join(tmpdir(), "since-flood-cwd-"));
  const bin = mkdtempSync(join(tmpdir(), "since-flood-bin-"));
  writeFileSync(join(bin, "gh"), FLOOD_GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [BOARD, "build", "--ledger", join(cwd, "nope.md"), "--spend-since", sinceValue],
      { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test(
  "build: --spend-since's refusal survives a gh child that has already pushed past the pipe buffer, unread",
  { skip: IS_DARWIN ? false : "async pipe-write loss (#363) is darwin-only — a green run here is not coverage" },
  async () => {
    const r = await runBoardFlooded("notanumber");
    // The flood itself must have gone through and reached the buffer's
    // ceiling, or this test would pass against the pre-#367 bug too
    // (measured: dropping the gh stub down to a few hundred bytes leaves the
    // reverted console.error die() passing here right alongside the fix).
    // `>=`, not `>`: the exact failure this test exists for caps the
    // received bytes at precisely 65,536 (flood only, refusal dropped) — a
    // strict `>` here would fire on the setup check before the message/exit
    // assertions below ever ran, masking them under the mutant (measured).
    assert.ok(r.stderr.length >= 65_536, `gh's flood must reach the 64 KiB buffer, got ${r.stderr.length}`);
    assert.match(r.stderr, /board: --spend-since wants epoch milliseconds, got notanumber/);
    assert.equal(r.status, 2, r.stderr.slice(-300));
  },
);
