// #1586. Phase 0 step 0's cockpit-launch bullet was right about the symptom
// and wrong about the cause: a second launch finding the first one alive and
// exiting 0 is not an accident of "doing it anyway is harmless" — #1585 made
// that behaviour the DESIGN, an identity handshake on a held port with a
// bounded fallback scan, so the launch is idempotent PER WORKSPACE. The old
// wording still told the controller to gate the command to "the first
// phase-0 pass only" and to "skip" it on a later re-shortlist, which frames
// the reuse path as an accident worth avoiding rather than the rule. #39's
// multi-instance cockpit needs the opposite doctrine: run the launch on every
// re-shortlist, because reuse is cheap and a second workspace's launch never
// contends with the first — it derives a different port and serves its own
// board there.
//
// This file pins the REPLACEMENT doctrine and, separately, that the
// superseded "skip on later re-shortlists" framing is gone rather than left
// beside it (the plugin's prefer-moving rule) — so a revert back to the old
// wording, whole or partial, reds here even if it also keeps some of the new
// phrasing.
//
// Slice: `paragraph()`, `instrument-check-prose.test.mjs`'s own bound for the
// two sibling bullets immediately above this one in the same phase-0 step.
// Bounded at the anchor's own blank line, never widened to the whole step:
// step 0's OTHER two bullets ("Fast-forward the checkout", "Pin the
// instruments") talk about exit codes and staleness, not this bullet's
// claims, so an unbounded slice buys nothing extra and a bounded one is what
// keeps a decoy elsewhere in step 0 from satisfying these assertions.
//
// CEILING, shared with every prose pin in this repo: presence over a bounded
// slice proves the clause is STATED, not that a later sentence in the same
// bullet does not quietly carve out an exception. Measured — reverting this
// bullet to its pre-#1586 wording (`git show <base>:…` restored in place)
// reds every test below; the docs/specs design note this bullet does not
// cross-reference is untouched by either wording either way.
//
// PR #1664's own review amended the doctrine before merge: the idempotence
// claim is conditioned on the running cockpit ANSWERING the handshake — one
// blocked inside its own synchronous gather() reads as foreign and gets
// duplicated, reproduced by two independent refuters; `--open` fires on the
// reuse arm too, so a re-shortlist reopens the board tab, reproduced
// directly; and the "own port" claim is softened — a derived-port collision
// (#1657) lands the second workspace on the next free port in its scan
// range, not its own derived one, though it still gets its own board. The
// tests below that name PR #1664 pin these amendments; the two existing
// tests they sit beside were tightened rather than replaced.
//
// Zero deps: `node --test plugin/scripts/cockpit-launch-idempotent-prose.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// The whole bullet, bounded by its own blank line — the bound the two
// sibling bullets above it already use in `instrument-check-prose.test.mjs`.
const LAUNCH_STEP = () => paragraph(RUN_TEAM, "**Launch the cockpit.**", "run-team phase 0 cockpit-launch bullet");

test("phase 0 runs the cockpit launch on every pass, not just the first", () => {
  const step = LAUNCH_STEP();
  // The gate word itself, inverted: "only" on the first pass is exactly the
  // instruction #1586 removes. Pinning the positive alone would stay green if
  // a later edit restored a first-pass-only gate elsewhere in the sentence
  // under different wording, so the negative below carries the real weight.
  assert.match(step, phrase("On every phase-0 pass, not just the first"));
});

test("phase 0 states the cockpit launch is idempotent per workspace, conditioned on the handshake answering", () => {
  const step = LAUNCH_STEP();
  // The doctrine statement itself — not a symptom description ("a second
  // launch is harmless"), a stated design property ("idempotent"), scoped to
  // the unit #39's multi-instance cockpit cares about ("per workspace").
  assert.match(step, phrase("The launch is idempotent per workspace"));
  // PR #1664 review (finding 1): unconditional idempotence is false — a
  // cockpit blocked inside its own synchronous gather() does not answer the
  // handshake in time, so the doctrine states the condition rather than
  // leaving it implicit.
  assert.match(step, phrase("when the running cockpit answers the identity"));
  // The mechanism the doctrine rests on, named rather than left implicit: an
  // already-served workspace's launch finds the running server and exits 0
  // instead of starting a second one.
  assert.match(step, phrase("an already-served workspace's launch finds the"));
  assert.match(step, phrase("exits 0 without starting a second one"));
});

test("phase 0 states a cockpit blocked in gather() reads as foreign and gets duplicated", () => {
  const step = LAUNCH_STEP();
  // PR #1664 review (finding 1), reproduced by two independent refuters:
  // SIGSTOP-ing the holder mid-gather() makes a relaunch treat it as
  // foreign and bind the next free port, starting a second server that
  // shares this workspace's OWN `.fleet` state directory with the first —
  // not a different workspace's, which would be the harmless #1585 case.
  assert.match(step, phrase("does not answer inside the probe window and reads"));
  assert.match(step, phrase("as foreign instead"));
  assert.match(step, phrase("starts a second server sharing this workspace's"));
  assert.match(step, phrase("`.fleet` state directory"));
});

test("phase 0 states --open fires on every relaunch, reopening the board tab each pass", () => {
  const step = LAUNCH_STEP();
  // PR #1664 review (finding 2), reproduced: `serve --open` run twice
  // against the same workspace calls `open()` on BOTH runs, including the
  // reuse arm — so moving the launch to every phase-0 pass means a
  // re-shortlist reopens the browser tab, not just the first pass. The
  // doctrine says so rather than leaving the operator to discover it.
  assert.match(step, phrase("`--open` fires on every one of those launches too"));
  assert.match(step, phrase("a re-shortlist reopens the board tab"));
});

test("phase 0 states a second workspace's launch derives its own port, falling back when it is held", () => {
  const step = LAUNCH_STEP();
  // The other half of #39's doctrine: idempotence is per WORKSPACE, not
  // global, so a second fleet on a different workspace is not merely
  // "unaffected" — it gets a board of its own. Pinning "collides with none of
  // that" alone would be vacuous to a rewrite that dropped the affirmative
  // claim and left only the negative, so both are asserted.
  assert.match(step, phrase("A second fleet on another workspace collides with none of that"));
  assert.match(step, phrase("its own launch derives that"));
  assert.match(step, phrase("workspace's own port and binds it when free"));
  // PR #1664 review (finding D): derived ports collide across workspaces at
  // a real, non-negligible probability (#1657, filed and deferred
  // separately) — the doctrine must not promise the derived port
  // specifically, only that a board gets served either way.
  assert.match(step, phrase("scans to the next free port in its range when the derived one is already held"));
  assert.match(step, phrase("it gets its own board, just not always on the port its hash predicts"));
});

test("the old skip-on-re-shortlist framing is gone, not left beside its replacement", () => {
  const step = LAUNCH_STEP();
  // Verbatim phrases from the text #1586 replaced. Verified zero occurrences
  // in the current file — the plugin's prefer-moving rule means the
  // superseded sentence is DELETED, so a reword that restores either phrase
  // (in full or copy-pasted back in beside the new doctrine) reds here.
  assert.doesNotMatch(
    step,
    phrase("On the first phase-0 pass only"),
    "the cockpit launch is gated to the first phase-0 pass again — #1586's per-workspace doctrine has been reverted",
  );
  assert.doesNotMatch(
    step,
    phrase("Skip on later re-shortlists"),
    "phase 0 tells the controller to skip the cockpit launch on a later re-shortlist again — that is the exact defect #1586 closed",
  );
  assert.doesNotMatch(
    step,
    phrase("Doing it anyway is harmless rather than a collision"),
    "the cockpit launch is framed as an accidentally-harmless collision again, rather than a per-workspace-idempotent design",
  );
});
