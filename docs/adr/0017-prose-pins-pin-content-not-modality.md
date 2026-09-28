# 0017 — Prose pins pin content, never modality; an obligation that must not soften gets a code carrier

**Status:** Accepted. Ruled 2026-09-27 on #1111 by the maintainer, from a
grilling session, against the measurements below. The ruling named this ADR
"0014"; that number and the two after it were taken by other ADRs before it
landed, so it is recorded here as 0017.

## Context

A **prose pin** is a test that reads a skill or doc as text and asserts
something about it. This repo pins its runbook prose heavily, and three
measured failures show where that instrument stops working.

- **#1111 — the guard can be downgraded to advice, suite green.** Phase 2's
  tier guard in `plugin/skills/run-team/SKILL.md` opens with a bold
  imperative, `**Guard: accumulate per PR, never conclude inside one run.**`.
  Rewrite that lead in place to
  `**Guard: accumulate per PR, never conclude inside one run — advisory, at
  your discretion, skip when time is short.**` and the obligation is now
  advice. Re-measured on `1eaac4b0` for this ADR, on a scratch copy of the
  tree so the checkout was never written:
  `node --test plugin/scripts/*.test.mjs` reads `tests 3381 · pass 3381 ·
  fail 0` unmutated and `tests 3381 · pass 3381 · fail 0` mutated —
  identical. The ruling measured the same on `080fb9b0` (3568/3568). The one
  assertion whose stated purpose is keeping the guard mandatory is a
  case-insensitive `doesNotMatch` over two words, `Optional` and `you may`;
  the hedge uses neither. The guard-region slicer keys on the start anchor
  `**Guard: accumulate per PR`, a prefix of the lead, so the hedge also
  leaves every slice-based pin reading the region it always read.
- **#529 — the anchor tautology.** A `/^\*\*Guard: /` pin over that same
  slice could not fail for any input: `section()` returns a slice that
  *opens with* its start anchor, so the anchor alone satisfied it. It was
  deleted. A pin placed at the head of an anchored slice pins the anchor, not
  the prose after it.
- **#476 — the word list does not kill its own mutant.** A suggested
  polarity guard for the `/unit is the PR/` pin, a lookbehind over hedge
  words, was measured letting its own mutant through. A `doesNotMatch` word
  list scoped to a sentence is one reword away from green; broadened enough
  to red a given reword, it false-positives on the legitimate edits the repo
  makes (reflow, rebold, reordering).

All three are one approach failing three ways: **strengthening a prose pin
until it catches a change of modality**. #1111's own bar makes the failure
structural rather than a matter of effort — a mechanism has to kill the
hedge mutant *and* survive a pure reflow, a rebold and a sentence reorder.

## Decision

1. **Prose pins assert content, never modality.** Content is what a regex can
   decide: facts, values, units, anchors, named sources, runnable
   invocations. Whether a sentence obliges or merely advises is not.
2. **No `doesNotMatch` hedge-word list is the fix.** No new one is written to
   guard a modality, and the existing ones are not widened. Adding
   `advisory|at your discretion|if you like` is the next reword away from
   green, which is exactly what #476 measured.
3. **An obligation that must not soften into advice gets a code carrier.** A
   **code carrier** is a script that computes the verdict, plus a
   `fleet-tick` row the controller acts on when that verdict needs action —
   the shape `HOLD (tier mismatch …)` already has: `tier-check.mjs --batch`
   computes the mismatch and exits non-zero, the ledger settles the member
   `tier-mismatch`, and `plugin/scripts/fleet-tick.mjs` turns that ledger
   outcome into a row carrying `acts: true`. A prose sentence can be reworded
   into advice; an exit code and the tick row it drives cannot be reworded at
   all.

This ADR chooses a mechanism. It implements none.

## Consequences

- **Why no pin closes #1111, recorded so it is not re-attempted.** A
  *presence* pin — the exact lead span, whitespace-normalized so it survives
  a reflow — kills this mutant but passes `…one run.** Advisory — skip when
  short.`, because the pinned span is still intact beside the hedge. It pins a
  sentence, not the absence of a hedge. An *absence* pin is a word list,
  which #476 and #529 measured failing. Neither kind meets the bar, by
  construction.
- **The two existing hedge-word lists stay, as literal-word tripwires only.**
  Both live in `plugin/scripts/implementer-model-tier.test.mjs`: the
  tier-check dispatch test's `/tier check[\s\S]{0,600}(?:\bOptional\b|\byou
  may\b)/i`, and the guard test's `/\bOptional\b|\byou may\b/i`. They catch
  the literal `Optional` / `you may` hedges that prose-compression passes
  produce, and nothing else. Their failure messages still read "downgraded to
  advice"; read them as "one of two words appeared", not as a modality guard.
  Their comments cite this ADR.
- **Today's phase-2 tier guard stays exposed until #2037's successor lands.**
  Map #2030 replaces it: #2036 ruled the alt pairing's retirement, and #2037
  specified the successor guard with this ruling's code-carrier requirement
  built in — a `pr-cost.mjs --guard` verdict with its own exit contract, read
  by the router at dispatch, and a `fleet-tick` `router` row. Neither script
  is in the tree yet. Until the successor lands and the current
  guard retires, the hedge mutant above lands green. That exposure is a
  recorded, known gap, not an unnoticed one; it is not closed by any pin in
  the interim.
- **The same limit applies to the revert-note residual** in the same test
  file: a restoration of the reverted `class=routine` → `sonnet` binding
  written as modality ("that binding is back in force") rather than as a
  repeated token or date passes every check there. Its comment cites this ADR
  instead of an open question.
- **A future obligation needing hardness** is carried the same way: name the
  script, its exit contract, and the tick row, and pin *those* — their
  content is pinnable.
