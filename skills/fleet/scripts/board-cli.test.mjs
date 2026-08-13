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
import { spawnSync } from "node:child_process";
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
