import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";

// `snap.path` used to reach every specialist prompt and every verifier prompt
// unchecked: a well-formed string the schema required, but never confirmed to
// name a real directory. A silently-failed 'git archive | tar -x' (bad auth,
// a dead HEAD) leaves 'mkdir -p's directory standing, empty — so every
// specialist got `No such file or directory` on every read and reasoned from
// source instead of measuring, on all six dimensions at once (#140).
//
// `snapshotMissing` is the fix: a `pathVerified` boolean in the snapshot
// schema's own `required` array, so the agent cannot silently omit it — read by
// the CALLER rather than trusted from the agent's narration of the
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

// Bound at both ends via prose-pin.mjs's between() — an unbounded end lets the
// specialist and refuter prompts further down satisfy the assertions instead,
// the defect `review-pr-testcmd.test.mjs`'s "the specialist prompt hands the
// command over verbatim and rules 'tests 0' a failure" test records having
// shipped. Same two anchors `review-pr-reads.test.mjs`'s `slice()` and
// `review-pr-testcmd.test.mjs` already use.
function snapshotBlock() {
  return between(CODE, "const snap = await agent(", "if (!snap", "the snapshot agent dispatch");
}

// Every test above runs against the lifted `snapshotMissing`, which decides what
// to do with `pathVerified` but never produces it. The thing that produces it is
// two lines of review-pr.js — a shell probe and the sentence binding the field
// to that probe's output — and neither was pinned. Delete either and
// `required: [..., "pathVerified"]` still passes, all four tests above still
// pass, and the agent has lost the only instruction saying what value to report:
// `pathVerified` degrades to a boolean it invents, silently reopening #140 under
// a green suite. That is the exact shape `review-pr-reads.test.mjs`'s "the
// snapshot agent asks for the diff facts AND declares them in its schema"
// measured on the diff facts — "deleting this paragraph outright left this file
// at 12 pass, 0 fail".
test("the snapshot prompt runs the emptiness probe AND binds pathVerified to its output", () => {
  const snapshot = snapshotBlock();
  assert.match(
    snapshot,
    /\[ -n "\$\(ls -A \$\{scratch\}\/snapshot\)" \] && echo SNAPSHOT_NONEMPTY \|\| echo SNAPSHOT_EMPTY/,
    "the emptiness probe is gone — nothing mechanical stands behind pathVerified",
  );
  // These names live inside a template literal, so each backtick is a
  // BACKSLASH-backtick in the source text — `\\?` matches it either way, the
  // idiom review-pr-reads.test.mjs and review-pr-testcmd.test.mjs already use.
  // `\s+` spans the line wraps so a reflow of the same sentence stays green.
  const B = "\\\\?`";
  assert.match(
    snapshot,
    new RegExp(`Report\\s+${B}pathVerified${B}\\s+=\\s+true\\s+ONLY\\s+if\\s+the\\s+'ls -A'\\s+line\\s+printed\\s+SNAPSHOT_NONEMPTY`),
    "pathVerified is no longer bound to the probe's output — the agent may report whatever it likes",
  );
});

// The ORDER is the guard, not the probe, and two different reorderings each
// defeat it. Measured, both:
//   probe AFTER the symlink -> `ls -A` counts the symlink, so a `git archive`
//     that extracted NOTHING still prints SNAPSHOT_NONEMPTY, in every repo that
//     has node_modules (which is every repo the symlink exists for).
//   guard MISSING -> the wipe is executed text, not evaluated JS, so an empty
//     `scratch` emits `rm -rf /snapshot` and runs it.
//   wipe MISSING (or after `tar -x`) -> `mkdir -p` never empties and `tar -x`
//     MERGES, so a reused scratch keeps the previous run's files. Measured
//     across two PRs sharing one scratch: reviewing prB, the snapshot held
//     prA's file. A merged tree is non-empty for REAL, so the probe cannot
//     catch this one at all — only the wipe can.
// Both end the same way: the agent honestly reports `pathVerified: true`,
// because that is what it was told to report. Hence a sequence pin, not a
// presence pin — every one of these five lines is in the right place or the
// guard is decorative.
test("the snapshot block wipes, extracts, probes, then symlinks — in that order", () => {
  const snapshot = snapshotBlock();
  let prev = -1;
  for (const [needle, gone] of [
    [
      '[ -n "${scratch}" ] || { echo SNAPSHOT_SCRATCH_UNSET',
      "the empty-scratch guard is gone — the wipe below it reads `rm -rf /snapshot` on an empty interpolation",
    ],
    ["rm -rf ${scratch}/snapshot", "the wipe is gone — `tar -x` MERGES, so a reused scratch certifies a stale tree"],
    ["mkdir -p ${scratch}/snapshot", "the mkdir is gone — `tar -x` has nowhere to extract to"],
    ["git -C ${worktree} archive HEAD", "the archive is gone — there is no snapshot to review"],
    ['[ -n "$(ls -A ${scratch}/snapshot)" ]', "the emptiness probe is gone — nothing mechanical stands behind pathVerified"],
    ["ln -s ${worktree}/node_modules", "the node_modules symlink is gone — a derived `npm test --` cannot run"],
  ]) {
    const at = snapshot.indexOf(needle);
    assert.notEqual(at, -1, gone);
    assert.ok(
      at > prev,
      `\`${needle}\` is out of sequence — the block must wipe, then extract, then probe, then symlink`,
    );
    prev = at;
  }
});

// The function is worthless if nothing calls it, and every test above tests a
// COPY lifted from the source text: it stays green while the feature
// disconnects. `review-pr-testcmd.test.mjs`'s "review-pr.js actually calls
// resolveTestCmd once the snapshot is validated" records this exact defect for
// resolveTestCmd and `select-dimensions.test.mjs:251-256` for the fan-out.
// Delete the two lines below in review-pr.js and #140's refusal is dead code
// with this whole file green.
test("review-pr.js actually calls snapshotMissing and throws on its result", () => {
  assert.match(
    CODE,
    /^const missingReason = snapshotMissing\(snap\);$/m,
    "the snapshotMissing call site changed — the #140 guard may be disconnected",
  );
  assert.match(
    CODE,
    /^if \(missingReason\) throw new Error\(/m,
    "snapshotMissing's result is computed but never thrown on — the guard decides nothing",
  );
  // Ordering, same guardAt/callAt shape as review-pr-testcmd.test.mjs's
  // "review-pr.js actually calls resolveTestCmd once the snapshot is validated":
  // after the schema that produces `pathVerified`, and before the first thing
  // that reads `snap` — `resolveTestCmd`, which would otherwise derive a command
  // for a tree that was never confirmed to exist.
  const schemaAt = CODE.indexOf('required: ["path", "head", "pathVerified"]');
  const callAt = CODE.indexOf("const missingReason = snapshotMissing(snap);");
  const testCmdAt = CODE.indexOf("const testCmd = resolveTestCmd(");
  assert.ok(schemaAt !== -1 && testCmdAt !== -1, "the schema or the resolveTestCmd call moved — update this test");
  assert.ok(schemaAt < callAt, "the guard runs above the schema that produces pathVerified");
  assert.ok(callAt < testCmdAt, "resolveTestCmd reads snap before the guard has cleared it");
});
