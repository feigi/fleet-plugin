// Regression gate for json.sh, the JSON-escaping library every fleet script
// that emits a payload now sources. Zero deps:
// `node --test skills/fleet/scripts/json.test.mjs`.
//
// The library exists because the same ~40 lines were copy-pasted into
// inflight.sh, release-ticket.sh and no-undo-audit.sh, and every fix to the
// rule list had to be written out three times (five, counting jarr and
// jarr_rewritten). #119.
//
// The load-bearing case here is `a failing sed makes jstr report failure`.
// Measured on PR #425 and recorded on #119: `printf | sed | tr` returns only
// the LAST stage's status, so forcing `sed` to fail left jstr exiting 0 with a
// truncated or empty value while forcing `tr` — the actual tail — worked. A
// test that only forces the tail stage passes against the unfixed helper and
// pins nothing, which is exactly why both stages are forced below and why the
// sed case asserts on the OUTPUT as well as the status: an assertion that only
// reads the status cannot tell "the shim fired and jstr caught it" from "the
// shim never ran at all".
//
// Its opposite number is `a healthy call is silent and exits 0`. A guard that
// reports failure on a string it should have escaped fine is a different bug
// from the one above, not the same bug inverted, so the accept path is pinned
// on its own rather than left implied by the escaping table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("./json.sh", import.meta.url));

/**
 * Run `body` in a fresh /bin/sh that has sourced the library.
 *
 * No `set -e` in the driver, deliberately: these tests measure the status a
 * helper RETURNS, and under -e a non-zero return would abort the driver before
 * it could print that status. The scripts that source this library do run under
 * -e; that interaction is pinned in each script's own suite, not here.
 *
 * `break` names a tool to shadow with a failing stub — the only way to observe
 * a stage failing without editing the library under test.
 *
 * `raw` skips Node's own UTF-8 decoding of stdout, returning a Buffer instead
 * of a string. Required for any test asserting on a raw invalid-UTF-8 byte
 * (#613): `encoding: "utf8"` makes Node itself silently substitute U+FFFD on
 * the way OUT, which would hide the exact bug under test — a caller (`jq`,
 * `python3 json.load`) that does not launder the bytes first.
 */
function drive(body, { args = [], input, break: broken, raw = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "json-sh-"));
  try {
    const env = { ...process.env };
    if (broken) {
      const stub = join(dir, broken);
      // Exit 1 and emit nothing — how BSD `tr` behaves on a byte that is not
      // valid UTF-8, the real-world failure this stands in for (#582).
      writeFileSync(stub, "#!/bin/sh\nexit 1\n");
      chmodSync(stub, 0o755);
      env.PATH = `${dir}:${process.env.PATH}`;
    }
    const f = join(dir, "drive.sh");
    writeFileSync(f, `. ${JSON.stringify(LIB)}\n${body}\n`);
    return spawnSync("sh", [f, ...args], { env, input, encoding: raw ? "buffer" : "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Call a one-argument helper; returns {rc, out}. */
function call(fn, arg, opts = {}) {
  const r = drive(`${fn} "$1"; printf '\\nRC=%s' "$?"`, { args: [arg], ...opts });
  assert.equal(r.status, 0, `driver itself failed: ${r.stderr}`);
  const at = r.stdout.lastIndexOf("\nRC=");
  return { out: r.stdout.slice(0, at), rc: Number(r.stdout.slice(at + 4)) };
}

/** Call a stdin helper; returns {rc, out}. */
function pipe(fn, input, opts = {}) {
  const r = drive(`${fn}; printf '\\nRC=%s' "$?"`, { input, ...opts });
  assert.equal(r.status, 0, `driver itself failed: ${r.stderr}`);
  const at = r.stdout.lastIndexOf("\nRC=");
  return { out: r.stdout.slice(0, at), rc: Number(r.stdout.slice(at + 4)) };
}

// ---------------------------------------------------------------- jstr

// The escaping table. Each row is a string a fleet script can genuinely be
// handed — git accepts `"` in a ref, a worktree path is a filename and accepts
// `\` too — and the expectation is what makes `"<out>"` parse back to it.
const ESCAPES = [
  ["plain", "feature/ordinary-branch", "feature/ordinary-branch"],
  ["a double quote", 'evil"branch', 'evil\\"branch'],
  ["a backslash", "a\\b", "a\\\\b"],
  ["backslash before quote", '\\"', '\\\\\\"'],
  ["a tab", "a\tb", "a\\tb"],
  ["a newline", "a\nb", "a\\nb"],
  ["a carriage return", "a\rb", "a\\rb"],
  ["a backspace", "a\bb", "a\\bb"],
  ["a form feed", "a\fb", "a\\fb"],
  ["UTF-8, untouched", "brée/ünïcode", "brée/ünïcode"],
];

for (const [name, input, expected] of ESCAPES) {
  test(`jstr escapes ${name}`, () => {
    const { rc, out } = call("jstr", input);
    assert.equal(rc, 0);
    assert.equal(out, expected);
    assert.equal(JSON.parse(`"${out}"`), input, "must round-trip through a real JSON parser");
  });
}

test("jstr replaces a C0 byte with no JSON short form, rather than emitting it raw", () => {
  // \013 (VT) is the example RFC 8259 does not give a short form. Emitted raw
  // it is a control character in a JSON string, which no parser accepts.
  const { rc, out } = call("jstr", "a\x0bb");
  assert.equal(rc, 0);
  assert.equal(out, "a b");
  assert.doesNotThrow(() => JSON.parse(`"${out}"`));
});

test("jstr leaves DEL alone — \\177 is not a C0 byte and JSON permits it", () => {
  const { rc, out } = call("jstr", "a\x7fb");
  assert.equal(rc, 0);
  assert.equal(out, "a\x7fb");
  assert.equal(JSON.parse(`"${out}"`), "a\x7fb");
});

// A byte that is not valid UTF-8 at all — not merely a C0 control byte, a
// byte no UTF-8 sequence starts or continues with. Built as a raw Buffer
// rather than a JS string: `execFileSync`/`spawnSync` re-encode a JS string
// argv as UTF-8, so a JS `"\xFF"` (U+00FF) would arrive as the two-byte
// sequence \303\277 — valid UTF-8, which reproduces nothing (same pitfall
// no-undo-audit.test.mjs's `byteConflictRepo` comment names). Piped to stdin
// as a Buffer and captured inside the driven script with `$(cat)` sidesteps
// it: Node writes a Buffer to a child's stdin unchanged, and shell command
// substitution is byte-transparent.
const INVALID_UTF8 = Buffer.concat([Buffer.from("b"), Buffer.from([0xff]), Buffer.from("ad")]);

test("jstr replaces an invalid UTF-8 byte with U+FFFD rather than emitting it raw, and the result is valid UTF-8 JSON (#613)", () => {
  const r = drive(`x=$(cat); jstr "$x"`, { input: INVALID_UTF8, raw: true });
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const wrapped = Buffer.concat([Buffer.from('"'), r.stdout, Buffer.from('"')]);
  const decoded = wrapped.toString("utf8");
  // Strict UTF-8 validity via round-trip: Node's decoder is itself lossy —
  // it substitutes U+FFFD for a raw invalid byte on the way IN — so
  // re-encoding the decoded string reproduces the same bytes only when the
  // buffer was already valid UTF-8. A raw invalid byte that jstr failed to
  // repair shows up here as a length/content mismatch, not a thrown error.
  assert.deepEqual(Buffer.from(decoded, "utf8"), wrapped,
    "jstr's output is not valid UTF-8 — a raw invalid byte reached the JSON body");
  assert.equal(JSON.parse(decoded), "b�ad",
    "the fault must render as U+FFFD, not vanish or truncate the string");
});

test("a failing python3 makes jstr report failure", () => {
  const { rc, out } = call("jstr", 'evil"branch', { break: "python3" });
  assert.notEqual(out, 'evil\\"branch', "the python3 stub did not shadow the real python3 — this test proves nothing");
  assert.notEqual(rc, 0);
});

test("jstr on an empty string is empty at exit 0, forking nothing", () => {
  const { rc, out } = call("jstr", "");
  assert.equal(rc, 0);
  assert.equal(out, "");
});

test("jstr on an empty string survives a broken sed and tr — it never calls them", () => {
  // The short circuit is what lets a field that legitimately found nothing stay
  // empty during the PATH-wide tool outage inflight.sh measures at its own top:
  // that field never runs the broken tool, so it cannot observe the failure.
  for (const broken of ["sed", "tr", "python3"]) {
    const { rc, out } = call("jstr", "", { break: broken });
    assert.equal(rc, 0, `empty jstr must not fail on a broken ${broken}`);
    assert.equal(out, "");
  }
});

// ------------------------------------------------- the internal-status half

test("a failing sed makes jstr report failure", () => {
  const { rc, out } = call("jstr", 'evil"branch', { break: "sed" });
  // The shim really engaged: with sed working this is `evil\"branch`.
  assert.notEqual(out, 'evil\\"branch', "the sed stub did not shadow the real sed — this test proves nothing");
  assert.notEqual(rc, 0,
    "jstr swallowed a failed sed. `printf | sed | tr` reports only tr's status, so the caller gets a truncated value at exit 0 and its `|| die` never fires (#119, measured on PR #425).");
});

test("a failing tr makes jstr report failure", () => {
  const { rc, out } = call("jstr", 'evil"branch', { break: "tr" });
  assert.notEqual(out, 'evil\\"branch', "the tr stub did not shadow the real tr — this test proves nothing");
  assert.notEqual(rc, 0);
});

test("a healthy jstr exits 0 and is not caught by its own guard", () => {
  // The false-positive half. The status fix above must not start refusing
  // strings it has always escaped correctly, and every one of these is ordinary
  // input a fleet script sees on its healthy path.
  for (const s of ["fix/119-json-sh-extract", ".worktrees/119-json-sh-extract", "no-rebase", "npm ci", "brée", "a\tb", "x".repeat(4096)]) {
    const { rc, out } = call("jstr", s);
    assert.equal(rc, 0, `jstr wrongly refused ${JSON.stringify(s)}`);
    assert.equal(JSON.parse(`"${out}"`), s);
  }
});

// ---------------------------------------------------------- jrewritten

test("jrewritten is false when every byte was escaped rather than replaced", () => {
  for (const s of ["", "plain", 'a"b', "a\\b", "a\tb", "a\nb", "a\rb", "a\bb", "a\fb", "a\x7fb"]) {
    const { rc, out } = call("jrewritten", s);
    assert.equal(rc, 0);
    assert.equal(out, "false", `${JSON.stringify(s)} loses no bytes, so nothing was rewritten`);
  }
});

test("jrewritten is true when a byte was replaced", () => {
  const { rc, out } = call("jrewritten", "a\x0bb");
  assert.equal(rc, 0);
  assert.equal(out, "true");
});

test("a failing tr makes jrewritten report failure rather than a confident answer", () => {
  // Its last line is `[ … ] && printf false || printf true`, an AND-OR list
  // that always exits 0. Without an explicit return, bash 5.x in every mode —
  // every distro whose /bin/sh is bash 5 — runs on to it and hands back a
  // confident `true` about bytes nothing ever examined.
  const { rc } = call("jrewritten", "a\x0bb", { break: "tr" });
  assert.notEqual(rc, 0);
});

test("a failing python3 makes jrewritten report failure rather than a confident answer", () => {
  const { rc } = call("jrewritten", "a\x0bb", { break: "python3" });
  assert.notEqual(rc, 0);
});

test("jrewritten is true when a byte was not valid UTF-8, not just for the C0 replacement set (#613)", () => {
  const r = drive(`x=$(cat); jrewritten "$x"`, { input: INVALID_UTF8 });
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  assert.equal(r.stdout, "true");
});

test("jrewritten stays false for valid multi-byte UTF-8 under the new UTF-8 check (#613)", () => {
  const { rc, out } = call("jrewritten", "brée/ünïcode");
  assert.equal(rc, 0);
  assert.equal(out, "false");
});

// ---------------------------------------------------------------- jarr

test("jarr emits one quoted JSON string per line, comma-joined", () => {
  const { rc, out } = pipe("jarr", 'a\nb"c\nd\\e\n');
  assert.equal(rc, 0);
  assert.deepEqual(JSON.parse(`[${out}]`), ["a", 'b"c', "d\\e"]);
});

test("a failing sed makes jarr report failure", () => {
  const { rc, out } = pipe("jarr", 'a\nb"c\n', { break: "sed" });
  assert.notEqual(out, '"a","b\\"c"', "the sed stub did not shadow the real sed — this test proves nothing");
  assert.notEqual(rc, 0,
    "jarr swallowed a failed sed. Its `sed | tr | paste` reports only paste's status, the same mask jstr carries (#119).");
});

test("a failing tr makes jarr report failure", () => {
  const { rc } = pipe("jarr", 'a\nb"c\n', { break: "tr" });
  assert.notEqual(rc, 0);
});

test("a failing python3 makes jarr report failure", () => {
  const { rc } = pipe("jarr", 'a\nb"c\n', { break: "python3" });
  assert.notEqual(rc, 0);
});

test("jarr replaces an invalid UTF-8 byte with U+FFFD rather than emitting it raw, other elements untouched (#613)", () => {
  const input = Buffer.concat([Buffer.from("plain\n"), INVALID_UTF8]);
  const r = drive("jarr", { input, raw: true });
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const wrapped = Buffer.concat([Buffer.from("["), r.stdout, Buffer.from("]")]);
  const decoded = wrapped.toString("utf8");
  assert.deepEqual(Buffer.from(decoded, "utf8"), wrapped,
    "jarr's output is not valid UTF-8 — a raw invalid byte reached the JSON body");
  assert.deepEqual(JSON.parse(decoded), ["plain", "b�ad"]);
});

test("jarr_rewritten is a parallel boolean array, last line included", () => {
  // `read` alone drops a final line with no trailing newline, so the last
  // element is the one that goes missing — pinned with input that has none.
  const { rc, out } = pipe("jarr_rewritten", "plain\na\x0bb");
  assert.equal(rc, 0);
  assert.deepEqual(JSON.parse(`[${out}]`), [false, true]);
});

test("jarr_rewritten flags a line holding an invalid UTF-8 byte, not just the C0 replacement set (#613)", () => {
  // jarr_rewritten delegates to jrewritten per line, so this pins the
  // delegation carries the new check rather than re-testing jrewritten itself.
  const input = Buffer.concat([Buffer.from("plain\n"), INVALID_UTF8]);
  const r = drive("jarr_rewritten", { input });
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  assert.deepEqual(JSON.parse(`[${r.stdout}]`), [false, true]);
});

test("a failing tr makes jarr_rewritten report failure, not a short array", () => {
  // Its own last stage is `paste`, which exits 0 on whatever the aborted loop
  // managed to hand it. Without the `|| exit 1` inside the loop and the
  // `|| return 1` on the capture, a broken `tr` yields a SHORTER boolean array
  // than the string array it is supposed to parallel — and the caller has no
  // way to notice, because the two are emitted as separate JSON fields.
  const { rc } = pipe("jarr_rewritten", "plain\na\x0bb\n", { break: "tr" });
  assert.notEqual(rc, 0);
});

test("jarr on empty stdin is empty, not a one-element array holding nothing", () => {
  // The original `sed | tr | paste` emitted nothing at all on empty input
  // (measured). Splitting the pipeline to read each stage's status introduced a
  // `printf '%s\n'` re-emit that would turn "no elements" into one empty line,
  // and `paste` would answer `""` — inventing an element. The `[ -n ]` guard is
  // what preserves the original answer.
  const { rc, out } = pipe("jarr", "");
  assert.equal(rc, 0);
  assert.equal(out, "", "empty in, empty out — `[]` and `[\"\"]` are different answers");
  const { rc: rc2, out: out2 } = pipe("jarr_rewritten", "");
  assert.equal(rc2, 0);
  assert.equal(out2, "");
});
