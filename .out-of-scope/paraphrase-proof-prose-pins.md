# Paraphrase-Proof Prose Pins

A prose pin that refuses a wording defect refuses **that wording**. Proposals to make one
catch a *paraphrase* of the same defect — the claim reattached in different words, with a
connective clause inserted — are refused. The negative pin stays literal, and the ceiling
is documented in the test file rather than engineered away.

## Why this is out of scope

The gap is real, and measured. `ancestry-check-position-prose.test.mjs` carries five pins
over phase 0's staleness recipe: two positive spans holding the corrected prose, one
negative pin refusing the #814 defect's literal clause, and two accept-side tests. During
triage of #1478 the paraphrase was applied to a copy of the runbook outside the worktree —
the walk's output rebound to an ancestry check reading *"running `git merge-base
--is-ancestor <sha> origin/main` on that commit then confirms, before you cite it, that it
is not a pre-rebase orphan"* — and the suite answered **5 of 5 green**. The blindness
reproduces exactly as filed.

What makes it irreducible is the shape of the document, not a weakness in `phrase()`.

**The positive pins cannot see it.** They assert the corrected prose is present, and a
paraphrased re-attachment *adds* a sentence without removing anything. The document ends
up self-contradictory — stating that the walk's output needs no ancestry check, then
prescribing one on it — and no pin in the family asserts the absence of a contradiction,
because a contradiction is a relation between two spans rather than a property of either.

**A structural pin over-fires.** The obvious escape is to stop matching words and match the
mechanism: refuse any `--is-ancestor` adjacent to the walk's printed sha. But the paragraph
names `--is-ancestor` twice **legitimately** — once to say the walk's output needs no check
and why, once to relocate the check onto the sha the ticket quotes, which is the entire
point of the fix. A pin that cannot tell those two apart reds on correct prose, and a pin
that can tell them apart is reading intent. The accept-side tests in that file exist
precisely because "pre-rebase orphan" is *correct English* about the relocated input; the
same asymmetry defeats a structural rewrite of the negative.

**The ceiling is already written down.** The test file's own `THE CEILING` block states it:

```
// THE CEILING: two positive spans and one negative. The negative pins the
// LITERAL reverted clause — the walk's output bound to the proof claim — and a
// reworded re-attachment evades it; the positive spans are what carry the
// meaning.
```

That is the honest disclosure, in the place a future editor of those pins will read it. A
ticket asking for the gap to be closed is asking for something the primitives cannot
express, and the `.out-of-scope/prose-rule-as-derivation.md` objection applies at one
remove: catching an arbitrary paraphrase means deriving the *judgement* the prose encodes,
and a judgement is not a derivation.

Not covered by this refusal: pinning a **specific** paraphrase that has actually been
observed in the tree. A second real re-attachment, in whatever words it arrives, is a fact
about the document and a legitimate addition to the negative's alternatives — the same way
`compute-spend.mjs` matches four finisher spellings because four were really dispatched.
What is refused is engineering against the infinite set before any member of it has shown
up.

## What would reopen this

A paraphrased re-attachment landing in the tree for real, or a pin primitive that can
assert a relation between two spans — the no-check claim and an imperative check on the
same input — without reading intent. Either makes the argument worth having again on its
merits.

## Prior requests

- #1478 — "ancestry-check-position-prose pin is blind to a paraphrased re-attachment of the #814 defect" (deferred from PR #1475 review; blindness reproduced at triage, 5 of 5 pins green under the paraphrase)
