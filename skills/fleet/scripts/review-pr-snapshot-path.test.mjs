import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between, phrase } from "./prose-pin.mjs";
import { lift } from "./lift.mjs";

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
// byte-identity 'Verify it' step in the snapshot prompt.
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

const snapshotMissing = lift(CODE, "snapshotMissing", "snap");

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
// #539 splits the single "no tree" message this used to share across all six
// inputs into three, so the three groups below are asserted separately —
// otherwise a branch that can't actually tell path-missing from head-missing
// would still pass a loop that only checks "some string came back".
//
// A falsy `snap` is the agent contract failing — it died, or the harness
// exhausted structured-output retries and `agent()` returned null — not a
// claim about the tree on disk, which may be perfectly good. The citation is
// the `required:` comment inside `FINDINGS_SCHEMA` in review-pr.js, which
// records that a schema REJECTION is retried and every observed one recovered:
// exhaustion is the only one of the two that returns null, so naming rejection
// as the cause would point an operator at a signature successful runs carry.
test("a falsy snapshot (agent died, or it exhausted its structured-output retries) names the agent contract, not a missing tree", () => {
  for (const dead of [null, undefined, false]) {
    const reason = snapshotMissing(dead);
    assert.equal(typeof reason, "string", `${JSON.stringify(dead)} must yield a reason`);
    assert.match(reason, /died/, "the reason no longer names a dead agent as a cause");
    assert.match(reason, /exhausted/, "the reason no longer names exhausted retries — the only structured-output state that yields a falsy snap");
    assert.doesNotMatch(reason, /rejected/, "the reason names a rejection, which is retried and recovers rather than returning null");
  }
});

// `{}` and `{ head: "abc123" }` are both missing `path`; the original
// `!snap || !snap.path || !snap.head` chain checks `path` before `head`, so
// both land on the same branch under the split too — the split preserves that
// order rather than re-deciding it.
test("a report missing path is refused, naming path and not head", () => {
  for (const report of [{}, { head: "abc123" }]) {
    const reason = snapshotMissing(report);
    assert.equal(typeof reason, "string", `${JSON.stringify(report)} must yield a reason`);
    assert.match(reason, /`path`/, "the reason no longer names path as the missing field");
    assert.doesNotMatch(reason, /`head`/, "a missing-path report must not mention `head` at all — the pin is what catches this branch returning the head branch's message");
  }
});

// `{ path: "/tmp/snap" }` is the one input of the six with `path` present —
// the only one that can reach the `head`-missing branch at all. It is also the
// one branch of the three that must NOT borrow the "no tree to review" ending:
// `path` is present and may name a perfectly good directory, so the absent sha
// is the whole of what is wrong. #539 exists because one message misattributed
// a handshake failure as a missing tree; this branch is where that would come
// straight back.
test("a report missing head (path present) is refused, naming head and not path", () => {
  const reason = snapshotMissing({ path: "/tmp/snap" });
  assert.equal(typeof reason, "string", "a present path with no head must yield a reason");
  assert.match(reason, /`head`/, "the reason no longer names head as the missing field");
  assert.doesNotMatch(reason, /no tree/, "the head branch claims there is no tree, on the one branch whose path is present and whose tree may be fine");
  assert.doesNotMatch(reason, /`path`/, "a missing-head report must not mention `path` at all — the pin is what catches this branch returning the path branch's message");
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

// #532: the head compare already existed — in `usableDiff`, where a
// mismatching `prHead` cost the review its DIFF and nothing else. The review
// then ran to completion against a tree that was not the PR, on the fallback
// read rules, and reported findings about code the PR does not contain. That is
// the measured case: a carried-over worktree re-created with
// `git worktree add <path> <branch>`, which checks out a leftover LOCAL branch
// and never consults the remote, so the tree sat at a pre-rebase commit whose
// subject line was byte-identical to the PR head's. Neither commit was an
// ancestor of the other. The refusal is what the comparison was missing.
test("a tree whose head is not the PR's head is refused, naming both commits", () => {
  const reason = snapshotMissing({ path: "/tmp/snap", head: "cff7330", pathVerified: true, prHead: "9e8ee3d" });
  assert.equal(typeof reason, "string", "a present, mismatching prHead must yield a reason");
  assert.match(reason, /cff7330/, "the reason must name the commit the tree is actually at");
  assert.match(reason, /9e8ee3d/, "the reason must name the PR head it was measured against");
});

// The ACCEPT half, and the one this guard is most likely to get wrong. An
// ABSENT `prHead` is not a mismatch: `gh pr view` can fail while everything
// else succeeded, and turning missing input into a refusal would let a network
// blip cancel a runnable review — the inversion `usableDiff`'s own comment
// records for the diff, now with a whole review behind it instead of a diff.
// Absent and mismatching are different cases and stay different.
test("a snapshot with no prHead at all still proceeds", () => {
  assert.equal(
    snapshotMissing({ path: "/tmp/snap", head: "abc123", pathVerified: true }),
    null,
    "a missing prHead must not refuse an otherwise good snapshot",
  );
});

// The normal path, plus the abbreviation tolerance that keeps it normal.
// `prHead` is 40 chars from `gh`; `head` is whatever the snapshot agent relayed
// for "the HEAD sha", and an agent may abbreviate it. Under a raw `!==` those
// two matching shas compare unequal — which used to cost a diff and would now
// cost the entire review, so the prefix tolerance is load-bearing in both
// directions here in a way it was not before.
test("a matching head proceeds, abbreviated on either side", () => {
  const full = "a".repeat(40);
  const ok = (snap) => snapshotMissing({ path: "/tmp/snap", pathVerified: true, ...snap });
  assert.equal(ok({ head: "abc123", prHead: "abc123" }), null, "an exact match must not be refused");
  assert.equal(ok({ head: full.slice(0, 7), prHead: full }), null, "an abbreviated head is the same commit");
  assert.equal(ok({ head: full, prHead: full.slice(0, 7) }), null, "and the same the other way round");
  // The tolerance must not swallow the case it sits beside: a genuinely
  // different sha still refuses, at short compare length too.
  assert.equal(
    typeof ok({ head: "abc1234", prHead: "abd" + "9".repeat(37) }),
    "string",
    "a different sha stays disqualifying however short the compare",
  );
});

// The head compare now lives in two places — `usableDiff`, which drops the
// diff, and `snapshotMissing`, which refuses the review — and the Workflow
// sandbox forbids `import`, so neither can call a shared helper and still be
// lifted (see lift.mjs). Two copies of one expression is this repo's recurring
// disconnect defect, so the copies are pinned to each other rather than to the
// comparison's own text: the pattern anchors on the `if (snap.prHead && ` guard
// head and CAPTURES whatever comparison follows it, then compares the two
// captures. A change to one side that is not made to the other reds here,
// whatever the expression becomes; a semantics-preserving rewrite applied to
// BOTH sides stays green. Both directions are measured, in this file's own
// mutants, because the earlier form of this test asserted a fixed literal and
// did neither — it red on an identical rewrite of both copies, with a message
// saying neither copy compared the heads at all, which is backwards.
//
// The anchor is the residual literal, and it is the loud direction: rename
// `prHead` and the count drops rather than the comparison silently ceasing to
// be pinned.
test("the head compare in usableDiff and snapshotMissing are the same expression", () => {
  const compares = [...CODE.matchAll(/^\s*if \(snap\.prHead && (.+?)\)(?: return null;)?$/gm)].map((m) => m[1]);
  assert.ok(
    compares.length > 1,
    `${compares.length} head compare(s) found — the diff drop and the refusal are no longer both armed`,
  );
  assert.equal(
    new Set(compares).size,
    1,
    `the two head compares have diverged — one of them now decides on a different test than the other:\n  ${compares.join("\n  ")}`,
  );
});

// The refusal above raised the price of an unnormalized `head` from one diff to
// the whole review: `prHead` is 40 lowercase hex from `gh`, `head` is whatever
// an agent relayed for `git rev-parse HEAD`, and that command prints a trailing
// newline. Measured before the fix: `"9e8ee3d\n"` against a 40-char `prHead`
// beginning `9e8ee3d` refused, naming two shas that look identical.
//
// The normalization is a top-level statement rather than a function, so it is
// lifted as TEXT and RUN. A presence pin would stay green on a normalization
// that had stopped normalizing, which is the failure this test exists to catch.
test("a relayed head is normalized before the refusal ever sees it", () => {
  // Anchored on the ASSIGNMENT, not on `.trim()`: anchoring on the operation
  // means a normalization that stops normalizing reads as one that was deleted,
  // and the assertions below never run to say what actually broke.
  const block = CODE.match(/if \(snap\) \{[^}]*snap\.head = [^}]*\}/);
  assert.ok(
    block,
    "no `if (snap) { … snap.head = … }` normalization ahead of snapshotMissing — it was deleted, or reshaped past what this pins",
  );
  assert.ok(
    CODE.indexOf(block[0]) < CODE.indexOf("const missingReason = snapshotMissing(snap);"),
    "the normalization runs AFTER the refusal — it can no longer keep a relay artifact from cancelling the review",
  );
  const normalize = new Function("snap", block[0]);
  const full = "deadbee" + "0".repeat(33);
  const after = (head, prHead) => {
    const snap = { path: "/tmp/snap", pathVerified: true, head, prHead };
    normalize(snap);
    return snapshotMissing(snap);
  };
  assert.equal(after("deadbee\n", full), null, "a rev-parse newline is a relay artifact, not a different commit");
  assert.equal(after(" deadbee ", full), null, "and neither is surrounding whitespace");
  assert.equal(after("DEADBEE", full), null, "and neither is case");
  // The tolerance must not swallow the case it sits beside, here either.
  assert.equal(typeof after("cff7330", full), "string", "a genuinely different sha still refuses after normalizing");
  const absent = { path: "/tmp/snap", pathVerified: true, head: "deadbee" };
  normalize(absent);
  assert.equal(snapshotMissing(absent), null, "normalizing must not invent a prHead the snapshot agent never sent");
  // A dead snapshot agent returns falsy, and `snapshotMissing`'s first guard is
  // what names that. Normalizing must not beat it to the dereference.
  assert.doesNotThrow(() => normalize(null), "a falsy snap must reach snapshotMissing's own guard, not a TypeError here");
});

// `snapshotMissing`'s head compare is guarded on `snap.prHead &&`, so a failed
// `gh pr view` skips the refusal — deliberately, per the test above — and the
// run log used to be BYTE-IDENTICAL to a run where the two heads were compared
// and matched. That is the #532 case with the evidence removed: a wrong-commit
// review and a verified one read the same afterwards. Measured by running the
// log statement itself, not by matching its source, so a line that stops
// distinguishing the two reds here.
test("the snapshot log line says when the head check was skipped", () => {
  const line = CODE.split("\n").find((l) => l.startsWith("log(`snapshot "));
  assert.ok(line, "the snapshot run-log line is gone — the whole diff decision below it is unobservable without it");
  const say = (snap) => {
    let out;
    new Function("snap", "log", line)(snap, (m) => (out = m));
    return out;
  };
  const skipped = say({ path: "/tmp/snap", head: "deadbee" });
  const checked = say({ path: "/tmp/snap", head: "deadbee", prHead: "deadbee" + "0".repeat(33) });
  assert.notEqual(skipped, checked, "a skipped head check and a passed one log the same line — the two runs cannot be told apart");
  assert.match(skipped, /SKIPPED/, "the skip must be NAMED, not left to be inferred from a field the line does not print");
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
    /\[ -n "\$\(ls -A "\$SNAP"\)" \] && echo SNAPSHOT_NONEMPTY \|\| echo SNAPSHOT_EMPTY/,
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
//     `scratch` emits a wipe rooted at `/` and runs it.
//   wipe MISSING (or after `tar -x`) -> `mkdir -p` never empties and `tar -x`
//     MERGES, so a reused destination keeps the previous run's files. Measured
//     across two PRs sharing one scratch: reviewing prB, the snapshot held
//     prA's file. A merged tree is non-empty for REAL, so the probe cannot
//     catch this one at all — only the wipe can.
// Both end the same way: the agent honestly reports `pathVerified: true`,
// because that is what it was told to report. Hence a sequence pin, not a
// presence pin — every one of these lines is in the right place or the
// guard is decorative.
//
// #1129 moved the destination off `${scratch}/snapshot` and onto a per-run
// `$SNAP`, so the needles below address `$SNAP` — which is also what keeps the
// sequence honest now that the destination is a shell variable: an assignment
// that moved BELOW the wipe would wipe an unset (empty) `$SNAP`, and one command
// still spelling the old bare path would be a second destination this pin's
// order says nothing about. Both are caught here, by the assignment's place in
// the sequence and by `$SNAP` being what every later needle names.
test("the snapshot block derives a per-run destination, then wipes, extracts, probes, and symlinks — in that order", () => {
  const snapshot = snapshotBlock();
  let prev = -1;
  for (const [needle, gone] of [
    [
      '[ -n "${scratch}" ] || { echo SNAPSHOT_SCRATCH_UNSET',
      "the empty-scratch guard is gone — the wipe below it is rooted at `/` on an empty interpolation",
    ],
    [
      "SNAP=${runScratch}/snapshot-$(git -C ${worktree} rev-parse --short HEAD)",
      "the destination is no longer derived per run from the run root and the archived commit — two reviews sharing one scratch can collide again (#1129)",
    ],
    ['echo SNAPSHOT_DEST="$SNAP"', "the destination is never printed — the agent cannot report a path it can no longer read off this prompt"],
    ['rm -rf "$SNAP"', "the wipe is gone, or no longer bounded to this run's own destination — `tar -x` MERGES, so a reused destination certifies a stale tree"],
    ['mkdir -p "$SNAP"', "the mkdir is gone — `tar -x` has nowhere to extract to"],
    ["git -C ${worktree} archive HEAD", "the archive is gone — there is no snapshot to review"],
    ['[ -n "$(ls -A "$SNAP")" ]', "the emptiness probe is gone — nothing mechanical stands behind pathVerified"],
    ["ln -s ${worktree}/node_modules", "the node_modules symlink is gone — a derived `npm test --` cannot run"],
  ]) {
    const at = snapshot.indexOf(needle);
    assert.notEqual(at, -1, gone);
    assert.ok(
      at > prev,
      `\`${needle}\` is out of sequence — the block must derive the destination, then wipe, then extract, then probe, then symlink`,
    );
    prev = at;
  }
});

// #1129. The destination used to be `scratch` plus a fixed literal, so two runs
// handed one scratch root resolved to ONE absolute path — and the block above
// wipes its destination before extracting, so the second review deleted the tree
// the first review's fix-applier was still citing. Nothing failed: the path
// still existed, still held a plausible checkout of this repo, and answered a
// read with another PR's code. Observed live, worked around by hand-feeding each
// review a different scratch root.
//
// The derivation is a top-level statement rather than a function, so it is
// lifted as TEXT and RUN — the idiom the `snap.head` normalization above already
// uses, for the same reason: a presence pin over `runId` would stay green on a
// derivation that had stopped varying. The `.match()` is guarded and lives
// INSIDE the test, never at module scope, so a reformat that defeats the anchor
// reds one named test instead of taking the whole file down before it registers.
function deriveRunScratch() {
  const block = CODE.match(/^const runId = .+\nconst runScratch = .+$/m);
  assert.ok(
    block,
    "review-pr.js no longer derives `runId` and `runScratch` as adjacent top-level statements — the per-run root was deleted, or reshaped past what this lifts",
  );
  assert.ok(
    CODE.indexOf(block[0]) < CODE.indexOf("const snap = await agent("),
    "the per-run root is derived BELOW the snapshot dispatch that interpolates it",
  );
  return new Function("scratch", "pr", `${block[0]}\nreturn runScratch;`);
}

// AC-1, both halves, executed rather than read: two runs differing only in PR,
// and two runs differing in nothing at all.
test("two review runs sharing one scratch root never derive the same artefact root", () => {
  const derive = deriveRunScratch();
  assert.notEqual(
    derive("/scr", 1126),
    derive("/scr", 1128),
    "two PRs reviewed under one scratch root resolve to the same artefact root — the second review overwrites the first's",
  );
  // The half a per-PR path does NOT fix, and the one measured under #140: one
  // PR reviewed twice is one path twice, so a re-review still lands on the tree
  // a live consumer of the first review is citing.
  const again = Array.from({ length: 8 }, () => derive("/scr", 1129));
  assert.equal(
    new Set(again).size,
    again.length,
    `re-reviewing ONE PR resolves to a repeated artefact root — ${again[0]} came back more than once, so a second review of the same PR still overwrites the first's tree`,
  );
  // AC-2's PR half, asserted on the same axis rather than left to the two
  // inequalities above: a run token alone satisfies both of them while leaving
  // the path anonymous, and a path that does not say which PR it holds is one a
  // consumer cannot tell a stale reference from a current one by reading.
  assert.match(
    derive("/scr", 1129),
    /\/pr1129(\/|$)/,
    "the artefact root no longer names the PR — the paths are distinct but anonymous, so nothing about a path says which tree it holds",
  );
});

// NOT PINNED HERE, deliberately: that no run's root sits INSIDE another's, the
// property the wipe needs beyond mere distinctness (`rm -rf <a>` still takes
// `<a>/deeper`). It was written, and it killed no mutant the distinctness test
// above does not already kill — a derivation ending in a variable final segment
// cannot produce containment, since two distinct values of that segment are
// siblings whatever they are, so the assertion holds structurally rather than
// because the code is right. What the wipe actually targets is pinned where it
// is decided instead: the sequence test's `SNAP=${runScratch}/…` needle binds
// the wipe's variable to this root and nothing else.
//
// The ACCEPT case, and the class this change could wrongly BREAK. Everything
// downstream — the diff redirect, the specialists' own directories, the
// controller that provisioned the root and expects to find the run's artefacts
// beneath it — assumes what a run writes lands under the scratch argument it was
// given. A derivation that "fixed" collisions by moving artefacts somewhere
// unique but OUTSIDE that root would satisfy every assertion above it and break
// every one of those consumers, so the containment is asserted in its own right.
test("a run's artefact root stays under the scratch root the caller provisioned", () => {
  const derive = deriveRunScratch();
  for (const scratch of ["/scr", "/run/scratch", "/tmp/claude-501/session/scratchpad"]) {
    const root = derive(scratch, 1129);
    assert.ok(
      root.startsWith(`${scratch}/`),
      `a run under ${scratch} writes to ${root}, outside the root the caller provisioned — a caller that cleans up or inspects its own scratch root now finds nothing there`,
    );
    // A prefix alone does not settle "under": `/scr/../elsewhere` carries it and
    // resolves outside. Same escape review-pr-refuter-scratch.test.mjs asserts
    // separately of the refuter paths built on this root.
    assert.doesNotMatch(root, /\/\.\.(\/|$)/, `${root} climbs out of the provisioned root with a \`..\` segment`);
  }
});

// AC-6, and the pin that reds on a revert of ANY of the four artefact sites
// rather than only the snapshot's. `${scratch}` reaching a path directly is the
// whole defect: the snapshot, the captured diff behind `diffPath`, each
// specialist's directory and each refuter's were all spelled that way, and
// fixing one leaves the others colliding. Stated as a property over the source
// rather than as a list of four expected paths, so an artefact added later is
// covered without this test being remembered.
//
// The derivation itself is the one legitimate occurrence — it is where the
// caller's root is consumed — so it is excluded by identity, not by counting.
test("no artefact path is spelled off the bare scratch argument — every one hangs off the per-run root", () => {
  const offending = CODE.split("\n").filter((l) => l.includes("${scratch}/") && !l.includes("const runScratch ="));
  assert.deepEqual(
    offending,
    [],
    `these lines still build a path from the caller's scratch argument directly, so two reviews in one session share it:\n  ${offending.join("\n  ")}`,
  );
  // The other direction: an empty list must not be satisfied by the derivation
  // having been deleted along with everything it fed. Bound to the derivation
  // CONSUMING the caller's root, not to its shape — pinning the literal here
  // would red this test on every reshaping the tests above already judge on
  // their own terms, which makes a failure say nothing about which property
  // broke.
  assert.ok(
    CODE.split("\n").some((l) => l.includes("const runScratch =") && l.includes("${scratch}/")),
    "the per-run root no longer derives from the caller's scratch argument at all — the empty list above is vacuous",
  );
});

// The function is worthless if nothing calls it, and every test above tests a
// COPY lifted from the source text: it stays green while the feature
// disconnects. `review-pr-testcmd.test.mjs`'s "review-pr.js actually calls
// resolveTestCmd once the snapshot is validated" records this exact defect for
// resolveTestCmd and `select-dimensions.test.mjs:251-256` for the fan-out.
// Delete the `snapshotMissing(snap)` call and its `throw` in review-pr.js and
// #140's refusal is dead code with this whole file green.
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

// The #538 measurement, pinned because its whole value is that nobody repeats
// it. The next reader to notice that `pathVerified` is a boolean the agent
// types will reach for a caller-side `readdirSync` exactly as #538 did, and the
// reason that cannot work is a property of the Workflow harness that no amount
// of reading this repo reveals — #538 was filed precisely because the repo's
// own assertions about the sandbox had never been executed.
//
// Runs against SOURCE rather than CODE, the one pin in this file that does: the
// record is a comment, and CODE has its comments stripped. The usual objection
// to a source-text pin — that it passes vacuously over a construct sitting dead
// under a comment — does not apply to prose, which is what this protects and
// all it claims to.
//
// EVIDENCE AND VERDICT ARE PINNED SEPARATELY, because pinning the first never
// pins the second. With only the three measured facts held down, `It cannot be
// dropped.` inverted to `It can be dropped.`, `stays` to `goes`, and a softened
// `It could arguably be dropped, but …` all left this file GREEN — the record
// telling the next reader the opposite of what was measured, which is the one
// thing #538 exists to prevent.
//
// What these pins do NOT do: a pin is a substring test, so prose CONTRADICTING
// a fragment, added around it, passes every one of them. That is unreachable by
// any positive assertion and is not claimed below — hence the messages say the
// phrase stopped matching rather than that a reader has been misled. They are
// literal in the repo's usual way too: phrase() escapes metacharacters and
// joins on `\s+`, so a pin survives re-wrapping and nothing else, and a
// backtick or a capital changing reds it exactly as a deletion does.

// Hoisted so each generated test re-derives its own slice, and so a broken
// boundary reds every fragment rather than only the first. The `// ` prefixes
// come out before matching: a comment marker sitting mid-phrase is not
// whitespace, so leaving them in would pin the current line breaks instead of
// the sentence. `^[ \t]*` and not `^\s*`: under `/gm` the latter's `\s` eats the
// newline of a blank line and glues the paragraphs either side of it. No pin
// below changes verdict either way — phrase() joins on `\s+`, which already
// spans a blank line — so this is the sibling spelling from
// `review-pr-citation-prose.test.mjs:23`, kept as one idiom rather than two.
const rationale = () =>
  between(
    SOURCE,
    "`pathVerified` closes a narrower gap",
    "function snapshotMissing(snap)",
    "review-pr.js's snapshotMissing rationale",
  ).replace(/^[ \t]*\/\/ ?/gm, "");

for (const [fragment, carries] of [
  [
    "MEASURED rather than read off the documentation",
    "it is what tells the reader the verdict was executed rather than read off the docs, which is the whole reason #538 was filed",
  ],
  [
    "refused for ANY specifier",
    "it is what records that the harness rejects the mechanism, not `node:fs` in particular",
  ],
  [
    "`require` is undefined",
    "it is what records that require was measured too, not only import",
  ],
  [
    "It cannot be dropped.",
    "it is the verdict the three fragments above are evidence FOR — without it the record can carry the whole measurement and still read as though the round-trip were removable",
  ],
  [
    "So the round-trip stays,",
    "it is the same verdict restated where the record acts on it; pinning the evidence alone leaves both statements of the conclusion free to move",
  ],
]) {
  test(`the #538 record still carries "${fragment}"`, () => {
    assert.match(
      rationale(),
      phrase(fragment),
      `review-pr.js's #538 record no longer matches "${fragment}" — this pin is literal, so a reword or a case change reds it exactly as a deletion does. Restore the wording or re-pin it: ${carries}`,
    );
  });
}
