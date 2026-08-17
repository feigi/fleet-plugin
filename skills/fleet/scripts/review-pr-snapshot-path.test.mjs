import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

// `snap.path` used to reach every specialist prompt and every verifier prompt
// unchecked: a well-formed string the schema required, but never confirmed to
// name a real directory. A silently-failed 'git archive | tar -x' (bad auth,
// a dead HEAD) leaves 'mkdir -p's directory standing, empty — so every
// specialist got `No such file or directory` on every read and reasoned from
// source instead of measuring, on all six dimensions at once (#140).
//
// `snapshotMissing` is the fix: a required `pathVerified` boolean the snapshot
// agent cannot silently omit (`additionalProperties: false` + `required`
// already caught the sibling defect at #113/#118, same schema), read by the
// CALLER rather than trusted from the agent's own narration of the
// byte-identity 'Verify it' step a few lines above it in the prompt.
//
// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported,
// so the function is lifted out of the source text instead — same technique as
// review-pr-reads.test.mjs and review-pr-testcmd.test.mjs.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Pins run against CODE, not SOURCE: review-pr-reads.test.mjs and
// review-pr-testcmd.test.mjs each measured a source-text pin pass vacuously
// against a field dead under a comment — same stripper, same policy here.
const CODE = stripComments(SOURCE);

function liftSnapshotMissing() {
  const m = CODE.match(/^function snapshotMissing\(snap\) \{[\s\S]*?^\}$/m);
  assert.ok(m, "review-pr.js no longer declares snapshotMissing(snap) at top level — update this test");
  return new Function(`${m[0]}\nreturn snapshotMissing;`)();
}
const snapshotMissing = liftSnapshotMissing();

// The accept case: this is the ONLY shape the review/verify stages may
// proceed on. A guard's false-positive class (wrongly refusing a healthy
// snapshot) is not its false-negative class, and nothing above this line
// exercises the ACCEPT path — every other test in this file feeds it input
// it must reject.
test("a fully verified snapshot is not missing", () => {
  const reason = snapshotMissing({ path: "/tmp/snap", head: "abc123", pathVerified: true });
  assert.equal(reason, null, "a snapshot with path, head and pathVerified:true must not be refused");
});

// Pre-existing behaviour (#140 must not regress it): no snapshot object at
// all, or one missing path/head, was already refused before this ticket.
test("a dead snapshot agent (falsy, or missing path/head) is refused, naming no tree", () => {
  for (const dead of [null, undefined, false, {}, { path: "/tmp/snap" }, { head: "abc123" }]) {
    const reason = snapshotMissing(dead);
    assert.equal(typeof reason, "string", `${JSON.stringify(dead)} must yield a reason`);
    assert.match(reason, /no tree/, "the reason no longer names a snapshot agent that returned no tree");
  }
});

// #140's actual case: path and head are both present, well-formed strings —
// exactly what let a garbage path through before this ticket — but the
// mechanical existence check came back false. The interpolation defect this
// closes is only reachable through THIS branch, not the no-tree one above.
test("a present path that failed its existence check is refused, naming the path", () => {
  const reason = snapshotMissing({ path: "/tmp/empty-snap", head: "abc123", pathVerified: false });
  assert.equal(typeof reason, "string", "pathVerified:false must yield a reason");
  assert.match(reason, /\/tmp\/empty-snap/, "the reason must name the unverified path");
  assert.match(reason, /not verified to exist/, "the reason no longer says the path was not verified");
});

// A specialist that skipped the required field entirely is the same fact as
// one that ran the check and got false — the schema's `required` is what is
// supposed to prevent this at the tool-call layer, but the pure function must
// not read silence as success if that layer is ever bypassed.
test("a snapshot that omitted pathVerified is refused, not assumed true", () => {
  const reason = snapshotMissing({ path: "/tmp/snap", head: "abc123" });
  assert.equal(typeof reason, "string", "an absent pathVerified must yield a reason, not pass through as verified");
});
