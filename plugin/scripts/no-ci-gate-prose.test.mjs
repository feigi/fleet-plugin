// #286. The `no-ci` FINISHER GATE — the label rests on the reviewer's own
// verified suite run, and without one nobody labels — was stated at four sites
// across three documents and pinned in none of them. What already exists pins a
// different clause of the same bullet: review-path-default.test.mjs anchors the
// Phase 3 no-ci edge's outstanding-ruling condition (`never while you still owe
// it a ruling`). The gate itself was free to rot in any of the four.
//
// Three sites remain, and they word it differently ON PURPOSE, so this pins the
// invariant each one must keep rather than a shared sentence:
//   - run-team/SKILL.md Phase 3 edge — the CONTROLLER's dispatch condition.
//   - run-team/SKILL.md finisher gate — the FINISHER's own two-facts verdict.
//   - review-and-fix.md step 6 — the REVIEWER's attestation, off its own step 3.
// All three can refuse to label, so all three carry the refusal half. The
// fourth, run-merge-bot.md step 3 reading the label back out, left the prose
// with #1806: `merge-gate.mjs` passes `--declare-no-ci` on every call itself,
// behind its own label check, so no bot-facing sentence states it any more.
//
// DELIBERATELY UNPINNED: references/ci-and-staleness.md. It states the SCRIPT
// contract (`no-ci` alone exits 1, exit 0 comes only with `--declare-no-ci`, the
// flag verifies nothing) and then explicitly hands the gate off — "SKILL.md's
// `no-ci` edge therefore dispatches the finisher off the reviewer's final
// verdict instead — that edge, not this file, carries the conditions on it".
// Pinning a finisher gate there would pin a duty that file disclaims, and would
// redden the moment someone correctly declines to restate it.
//
// THE CEILING, shared with every prose pin here: these prove the clause is
// PRESENT in the smallest slice that can hold it. None can prove a sentence
// added beside it does not negate it, and none runs anything — ci-state.test.mjs
// owns `ci-state.mjs`'s behavior, and the gate is executed by an agent reading
// this prose. Read each assertion as "not vacuous to REWORDING", never as "this
// rule cannot be subverted".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

// Reflow-safety: these documents hard-wrap, so a pinned phrase spans a newline
// plus indent and an exact-adjacency regex reports a clause that is right there
// as missing. Paragraphs are split off FIRST — that bound is what keeps a
// positive pin from being satisfied by a neighbouring paragraph — and only then
// is whitespace inside each one flattened.
const flat = (s) => s.replace(/\s+/g, " ").trim();
const paragraphs = (text) => text.split(/\n\s*\n/).map(flat);

// Anchored on what the paragraph SAYS, never on where it sits, and never on the
// clause under test: an ordinal re-rots the moment anyone inserts ahead of it,
// and an anchor that IS the assertion turns a deleted clause into "update this
// test" instead of a gate failure.
function paragraphSaying(text, anchor, label) {
  const hits = paragraphs(text).filter((p) => p.includes(anchor));
  assert.equal(hits.length, 1, `${label}: '${anchor}' matched ${hits.length} paragraphs, expected 1 — update this test`);
  return hits[0];
}

// SKILL.md's Phase 3 edge cannot use paragraphSaying: the whole event-loop
// bullet list is one blank-line-free paragraph (~3.6k chars), and a regex over
// that is satisfied by a neighbouring edge — vacuous. It gets a bullet-to-bullet
// slice instead, on the SAME anchor pair review-path-default.test.mjs already
// uses for this bullet, so this file adds no new anchor to that document.
function bullet(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const endAt = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(endAt, -1, `${label}: '${endAnchor}' moved — update this test`);
  // Clamp to the NEXT top-level bullet too. The end anchor is fixed, so on it
  // alone a sibling edge inserted between the two joins the slice and can carry
  // a pin the real edge has lost — the vacuity this slice exists to rule out.
  // The endAnchor assertion stays as the "moved — update this test" tripwire.
  const next = source.indexOf("\n- **", at + startAnchor.length);
  return flat(source.slice(at, next === -1 ? endAt : Math.min(next, endAt)));
}

const SITES = [
  [
    "run-team Phase 3 no-ci edge",
    () => bullet(RUN_TEAM, '- **`ci-state.mjs --pr <N>` reads `verdict: "no-ci"`**', "**Every wake ends in the tick.**", "run-team no-ci edge"),
    /label off the reviewer's (own )?verified suite run/i,
    /without it, do not label/i,
  ],
  [
    "run-team finisher gate",
    () => paragraphSaying(RUN_TEAM, "no verified suite run on record", "run-team finisher gate"),
    /rests on the reviewer's (own )?suite run, not on CI/i,
    /add no label/i,
  ],
  [
    "review-and-fix step 6",
    () => paragraphSaying(REVIEW_AND_FIX, "this repo has no `check` job to gate on at all", "review-and-fix step 6"),
    /label off step 3's own green `testCmd` run/i,
    /run on record → do not label/i,
  ],
];

test("every no-ci site rests the label on the reviewer's own verified suite run", () => {
  for (const [label, slice, rests] of SITES) {
    assert.match(
      slice(),
      rests,
      `${label}: no longer says the no-ci label rests on the reviewer's own verified suite run — the gate becomes the \`--declare-no-ci\` flag, which is caller-side and confirms only that the caller passed it`,
    );
  }
});

test("every no-ci site that can label carries the refusal when no such run exists", () => {
  for (const [label, slice, , refusal] of SITES) {
    assert.match(
      slice(),
      refusal,
      `${label}: lost the refusal — absence of CI now reads as a pass, which is exactly the misconfigured-repo case the declaration exists to rule out`,
    );
  }
});
