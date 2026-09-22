// #1588. A dispatch pool must not be opened in a session where a queued item
// would be appended onto a live worker's transcript: that default is a Wake,
// which a refill may never be, and it is silent when it happens. The guarantee
// is code (pool-preflight.mjs) rather than prose, so this is where it is held.
//
// Two halves, deliberately:
//
//   classify()  The whole decision, over a READING — the object spawnSync
//               returns. Every state the harness can answer in is a literal
//               here, so the table is exercised with no omp, no network and no
//               live harness at all. That is the ticket's own acceptance
//               criterion, and it is also the only way the absent and
//               unreadable rows are reachable: a machine whose omp is
//               configured one way can produce exactly one of the rows.
//   the CLI     Run for real against a stub `omp` on PATH that LOGS every
//               invocation it receives. That log carries the claim no exit
//               code can — this path reads the setting and writes nothing —
//               so an operator's configuration cannot be mutated by a
//               preflight, and the log reds if it ever is.
//
// Zero deps: `node --test plugin/scripts/pool-preflight.test.mjs`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTING, READINGS, WHY, classify, unpairedCauses } from "./pool-preflight.mjs";

const SCRIPT = fileURLToPath(new URL("./pool-preflight.mjs", import.meta.url));

// spawnSync's own result shape, defaulted to a read that ran and said nothing;
// each case below overrides exactly the field whose reading it is about.
const reading = (over = {}) => ({ error: null, signal: null, status: 0, stdout: "", stderr: "", ...over });

// What `omp config get <key> --json` prints — measured 2026-09-22 against the
// real binary: `{ "key": …, "value": false, "type": "boolean", "description":
// … }` on stdout at exit 0, and an `Unknown setting: <key>` on STDERR at exit 1
// with stdout empty for a key the harness does not have.
const payload = (value) => JSON.stringify({
  key: SETTING,
  value,
  type: "boolean",
  description: "Spawn a new subagent for every workpool item instead of reusing workers or batching queued items",
});
const effective = (value) => reading({ stdout: `${payload(value)}\n` });

const spawnFailure = (code) => Object.assign(new Error(`spawnSync omp ${code}`), { code });

test("an effective true permits the pool", () => {
  const v = classify(effective(true));
  assert.equal(v.ok, true);
  assert.equal(v.cause, "enabled");
});

test("an effective false refuses and names the key", () => {
  const v = classify(effective(false));
  assert.equal(v.ok, false);
  assert.equal(v.cause, "disabled");
  assert.ok(v.message.includes(SETTING), `refusal does not name the key: ${v.message}`);
});

test("a reading that carries no value for the key refuses as absent, never as the default", () => {
  // Absent is its own cause and not a synonym for false: the harness resolves
  // an unset key to its schema default at read time, so a payload with no
  // value in it is a payload that answered about nothing. Reading it as the
  // default would be guessing a value; reading it as permission would open the
  // pool on a setting nothing confirmed.
  for (const [what, stdout] of [
    ["the payload omits `value` entirely", JSON.stringify({ key: SETTING, type: "boolean" })],
    ["the payload carries a null `value`", JSON.stringify({ key: SETTING, value: null, type: "boolean" })],
  ]) {
    const v = classify(reading({ stdout }));
    assert.equal(v.ok, false, what);
    assert.equal(v.cause, "absent", what);
    assert.ok(v.message.includes(SETTING), `${what}: refusal does not name the key: ${v.message}`);
  }
});

test("every way the read can fail to answer refuses as unreadable", () => {
  // A guard that fails open on "could not look" protects nothing, and each row
  // below is a different way of not looking. The last two are the fail-open
  // direction specifically: a lenient parse that took the STRING "true", or a
  // truthy `1`, would open the pool on a value the harness never typed as the
  // boolean this guard needs.
  for (const [what, r] of [
    ["omp is not on PATH", reading({ error: spawnFailure("ENOENT"), status: null })],
    ["the read timed out", reading({ error: spawnFailure("ETIMEDOUT"), status: null, signal: "SIGTERM" })],
    ["the read was killed", reading({ status: null, signal: "SIGKILL" })],
    ["the key is unknown to this harness", reading({ status: 1, stderr: `Unknown setting: ${SETTING}\n` })],
    ["stdout is not JSON at all", reading({ stdout: "<!doctype html>\n" })],
    ["stdout is empty", reading({ stdout: "  \n" })],
    ["the answer is a bare scalar, not the documented object", reading({ stdout: "true\n" })],
    ["the value is the string 'true' rather than a boolean", reading({ stdout: payload("true") })],
    ["the value is the number 1 rather than a boolean", reading({ stdout: payload(1) })],
  ]) {
    const v = classify(r);
    assert.equal(v.ok, false, what);
    assert.equal(v.cause, "unreadable", what);
    assert.ok(v.message.includes(SETTING), `${what}: refusal does not name the key: ${v.message}`);
  }
});

test("a refused read carries the harness's own reason, not just this guard's", () => {
  // The cause an operator can act on lives in omp's message, and dropping it
  // leaves a refusal that names the key without saying why it could not be
  // read — indistinguishable, from the outside, from a key that is simply off.
  const v = classify(reading({
    status: 1,
    stderr: `Unknown setting: ${SETTING}\n\nRun 'omp config list' to see available keys\n`,
  }));
  assert.match(v.message, /Unknown setting/);
});

test("every refusing cause the table can reach carries its own reason", () => {
  // Nothing but spelling ties a row's cause to a WHY entry, and the miss is
  // the quiet kind: a row added with a new cause and no reason beside it
  // refuses at the same exit 2 with `undefined` where the reason belongs, and
  // reads like a working guard.
  assert.deepEqual(unpairedCauses(READINGS, WHY), []);
  assert.deepEqual(unpairedCauses([{ cause: "novel" }], {}), ["novel"]);
  assert.deepEqual(unpairedCauses([{ cause: "novel" }], { novel: "because" }), []);
  // The permitting cause states no reason because it refuses nothing — the
  // same exemption a defaulted flag gets from fleet-tick's unpairedFlags().
  assert.deepEqual(unpairedCauses([{ cause: "enabled" }], {}), []);
});

// ---- The CLI, against a stub `omp` that logs every invocation it receives ----

const OMP_STUB = [
  "#!/bin/sh",
  'echo "$*" >> "$OMP_LOG"',
  '[ -n "$OMP_STDOUT" ] && printf \'%s\' "$OMP_STDOUT"',
  '[ -n "$OMP_STDERR" ] && printf \'%s\' "$OMP_STDERR" >&2',
  'exit "${OMP_EXIT:-0}"',
  "",
].join("\n");

// The stub is written ONCE and reused: on macOS the first execution of a
// freshly written executable pays a multi-second security scan (measured here
// — a per-run stub cost ~2.7s per CLI test, one shared stub ~2.7s for the
// file), and nothing in these tests varies by stub content. What varies is
// handed over as environment instead.
const BIN = mkdtempSync(join(tmpdir(), "pool-preflight-bin-"));
const STUB = join(BIN, "omp");
writeFileSync(STUB, OMP_STUB);
chmodSync(STUB, 0o755);
// A second directory with no `omp` in it at all, for the no-harness route.
const EMPTY_BIN = mkdtempSync(join(tmpdir(), "pool-preflight-nobin-"));
after(() => {
  rmSync(BIN, { recursive: true, force: true });
  rmSync(EMPTY_BIN, { recursive: true, force: true });
});

// `omp: false` runs with the stubless PATH, for the no-harness-to-ask route.
// The run's cwd is a fresh empty directory that is read back afterwards: this
// preflight must leave nothing behind, and a state file dropped there is the
// shape of "writes nothing" quietly stopping being true.
function runCli(args = [], { stdout = "", stderr = "", exit = "0", omp = true } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "pool-preflight-run-"));
  const cwd = mkdtempSync(join(tmpdir(), "pool-preflight-cwd-"));
  const log = join(scratch, "omp.log");
  writeFileSync(log, "");
  try {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      // PATH is REPLACED rather than prefixed: a real `omp` further down the
      // caller's own PATH would answer for THIS machine's configuration, and
      // the fixture would silently stop deciding the outcome — green here,
      // red on a maintainer's laptop that has the setting the other way.
      env: {
        ...process.env,
        PATH: omp ? BIN : EMPTY_BIN,
        OMP_LOG: log, OMP_STDOUT: stdout, OMP_STDERR: stderr, OMP_EXIT: exit,
      },
    });
    return { ...r, log: readFileSync(log, "utf8"), left: readdirSync(cwd) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("CLI: an effective true exits 0", () => {
  const r = runCli([], { stdout: payload(true) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(SETTING), r.stdout);
});

test("CLI: an effective false refuses at exit 2 and prints no permission", () => {
  const r = runCli([], { stdout: payload(false) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "a refused preflight must print nothing a caller could read as a go-ahead");
  assert.match(r.stderr, /refusing to open a dispatch pool/);
  assert.ok(r.stderr.includes(SETTING), r.stderr);
});

test("CLI: the preflight reads the setting and never writes one", () => {
  // Nothing on this path may mutate the operator's configuration — the setting
  // is session-wide, so a preflight that "helpfully" set it would be changing
  // every other pool in the session, and on the global file at that. The stub
  // logs every invocation, so a `config set`/`config reset` reds here.
  for (const value of [true, false]) {
    const r = runCli([], { stdout: payload(value) });
    assert.deepEqual(
      r.log.trim().split("\n"),
      [`config get ${SETTING} --json`],
      `effective ${value}: the preflight ran something other than the single effective-value read`,
    );
    assert.deepEqual(r.left, [], `effective ${value}: the preflight left a file in its working directory`);
  }
});

test("CLI: no harness to ask refuses rather than assuming the default", () => {
  const r = runCli([], { omp: false });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.ok(r.stderr.includes(SETTING), r.stderr);
});

test("CLI: a key the harness does not have refuses, carrying omp's own message", () => {
  const r = runCli([], { stderr: `Unknown setting: ${SETTING}\n`, exit: "1" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown setting/);
});

test("CLI: an argument refuses before anything is read", () => {
  // The setting is session-wide configuration with no per-pool argument, so
  // there is nothing to pass and nothing to override at call time. A typo'd
  // flag silently ignored would be a preflight answering a question its caller
  // did not ask.
  for (const argv of [["--fresh-agents"], ["--json"], ["true"]]) {
    const r = runCli(argv, { stdout: payload(true) });
    assert.equal(r.status, 2, `${argv.join(" ")} should refuse`);
    assert.equal(r.log.trim(), "", `${argv.join(" ")}: the refusal must land before the harness is asked anything`);
  }
});
