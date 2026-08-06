# Correction tickets ship new wrong claims

Why ticket meant to correct fact tends to ship fresh wrong one, and why check belongs on implementer as much as reviewer. Two assertions in SKILL.md cite this: the Reviewers section, and phase 0 step 4's `class=correction` judgement. Evidence here.

Nothing below measures a **model tier**. The four-for-four ran at one tier and this file records no comparison, so it cannot support a claim that either tier is better or worse for this class — step 4 cites it as a precaution and says so.

## The four-for-four finding

Four for four in one run — misattributed package, list at inverted polarity, commit body citing wrong line, banner refuting currently-true fact.

## The mechanism is the ticket's framing, not implementer sloppiness

Fix text **paraphrases the issue body's framing** instead of being checked clause-by-clause against tree, so wrong premise in ticket becomes wrong claim in repo. Two of four came verbatim from their issue's wording, and that issue still wrong on two counts — so every ticket split from same source inherits them.

## Second mechanism: minted, not inherited — scope creep in the prose

Second run, on a **different repo**; the numbers and test vocabulary describing it are theirs, not ours. Its PR 574 shipped **two** fresh false claims, neither traceable to the issue. Issue asked for **one clause**; PR wrote **five lines**. Both errors entered in that expansion — so comparing fix text against the issue clause cannot catch them, there being no clause to compare against.

Both were **positional references**: "the *closing* `report-file verification` block" (4th of 5) and "the *second* assertion is the one with teeth" (3rd). Positional refs are one of the four classes in the four-for-four finding, and they re-rot the moment anyone inserts ahead of them.

Ordinals also **fake their own verification**: the wrong ordinal named an assertion earlier than the real one, and the test runner stops at the first failed expect — so the obvious mutation (setting the workflow step under test to `if: ${{ always() }}`) reds the named assertion and never reaches the true one, appearing to confirm the wrong claim. One mutation cannot discriminate an ordinal: PR #32 measured that `always()` reds the named assertion, and only the narrower `always() && steps.mutate.outcome == 'success'` reds the true one.

Two rules for the implementer, both cheap: **match the ticket's stated size** — added prose is where minted claims enter — and **never write a positional reference** (`the closing/second/last X`); name what the thing *is*, not where it sits.

## The clause-by-clause duty

Put check on **implementer**, not only reviewer: every factual claim the diff restates must have settling command run against tree first. Issue body is lead, never citation. Tell reviewers same, and to read each corrected sentence literally, asking whether every clause true under that reading — nobody hunts this unprompted, because diff "obviously" improves accuracy.