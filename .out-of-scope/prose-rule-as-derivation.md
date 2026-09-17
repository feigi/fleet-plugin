# Deriving a Prose Rule Into a Test

`workflows/review-pr.js` states a rule in a comment above `DEFAULT_DIMENSIONS`
— *downgrade a dimension's model only where a MISS by the cheaper finder is
RECOVERABLE* — and `scripts/select-dimensions.test.mjs` pins the
resulting six model choices as a literal list. Nothing connects the two: no
mechanism derives a model from the rule.

Proposals to build one are refused. The rule stays prose; the choices stay
pinned as literals.

## Why this is out of scope

**The rule is a judgement, and a judgement is not a derivation.** "Is a MISS by
the cheaper finder RECOVERABLE?" is answered by reasoning about what catches a
miss downstream — refuter budgets, whether a dimension's findings are all
`suggestion`, whether the search is open-ended. A test that encoded that
reasoning would be a second implementation of the judgement, and the two would
drift in the way this refusal exists to prevent. What can be checked mechanically
is whether the *facts the rule rests on* still hold, and PR #666 already added
that: `the refuter budget is keyed on severity alone, never on a dimension`.

**The guard is stronger than the proposals assume.** `select-dimensions.test.mjs`
pins `DEFAULT_DIMENSIONS.length` at 6 **and** `deepEqual`s the key list, and a
second test pins all six models by name off
`Object.fromEntries(DEFAULT_DIMENSIONS.map(...))`. Adding a seventh dimension reds
two assertions; changing an existing dimension's model reds one. (Cited by content,
not by line: both blocks have already moved once — at `675cf13` they were at
`:66-70` and `:169-180`.) **A human cannot land either change without being sent to the rule
comment.** That is the mechanism being asked for, in the only form that does not
duplicate the judgement — it forces the question rather than answering it.

**The drift class cited as motivation is closed.** The retired "faces refuters"
rationale did once survive in three places at once. Both live sites now carry it
**only as an explicit negation**: the comment above `SIZE_TIER_DIMS` in
`workflows/review-pr.js` reads *"NOT because those face refuters"*, and the
comment above `select-dimensions.test.mjs`'s "the refuter budget is keyed on
severity alone, never on a dimension" test says of the retired rationale that it
*"was never able to separate these six"*. The remaining hit is in `docs/specs/`,
a dated record of what was decided on 2026-08-06, and
the spec carries its own correction in the paragraph opening *"Corrected after
implementation (#221)"* (*"'faces refuters' cannot be what puts one on"*). There
is no live surface still asserting the retired rule.

Cited by content for the reason given one paragraph up, and #1130 is why that
reason is restated here rather than left implied. When this record was written
both live sites were cited by line, at `:404` and `:218,238`; every one of those
numbers has since moved. The `review-pr.js` negation drifted in wording too — it
read "those four alone" until #218 put `comments` on the size-tier floor and left
three — so the pointer and the quotation rotted together, and re-grepping the old
quote now finds nothing rather than finding it moved.
`review-pr-inbound-citation-prose.test.mjs` pins each quotation above against the
block it names, in both directions.

**A pin over the rule prose itself would be vacuous.** A positive regex over a
comment block is anchored by its slice size, not by its content, and this repo
has measured that failure repeatedly. Pinning that two copies of the rule agree
with each other adds a second copy to keep in sync and catches nothing that the
literal model pins do not already catch.

Not covered by this refusal: pinning further *facts the rule rests on*, the way
PR #666 did — that is the productive direction and needs no ticket. **Reopen only
with a concrete drift that the existing key-list and model pins did not catch** —
an argument that the rule "lives only in prose" has been made and answered.

## Prior requests

- #668 — "DEFAULT_DIMENSIONS model-tier invariant lives only in prose and a hand-enumerated test" (deferred from PR #666 review, `unverified[3]`)
