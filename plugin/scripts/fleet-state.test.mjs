// The shared state module — #357. Both of its callers have a CLI test file of
// their own, and almost everything this module does shows through one of them:
// the corrupt-file announcements, the per-field validation, the patch write, the
// failed-write return value.
//
// One thing does not, and it is a contract rather than an output: `rest` is the
// fields OUTSIDE the schema, never a second unvalidated copy of the fields
// inside it. Two copies of one key — one sanitized, one raw — is a trap for the
// next caller (#1597's stage-2 keys arrive in `rest`), and it leaves
// writeState's key ORDER as the only thing standing between a junk value and
// the disk. No CLI output differs on that, so it is pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readState } from "./fleet-state.mjs";

test("readState: `rest` is what lies outside the schema, never a second copy of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-"));
  const path = join(dir, "heartbeat.json");
  writeFileSync(path, JSON.stringify({ quiet: "bogus", elapsed: 5, digest: "abc", note: "not ours" }));
  const state = readState(path, "fleet-state-test");
  rmSync(dir, { recursive: true, force: true });

  // The validated view, per field: a junk `quiet` sanitizes to 0 without taking
  // the good `elapsed` down with it.
  assert.equal(state.quiet, 0);
  assert.equal(state.elapsed, 5);
  assert.equal(state.digest, "abc");
  // And `rest` carries the foreign key alone. A raw `quiet: "bogus"` sitting in
  // here is the value writeState would spread back onto the disk — the script
  // that owns neither key re-persisting a fault the read had already repaired.
  assert.deepEqual(state.rest, { note: "not ours" });
});
