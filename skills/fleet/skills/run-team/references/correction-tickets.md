# Correction tickets ship new wrong claims

Why a ticket that sets out to correct a fact tends to ship a fresh wrong one, and
why the check belongs on the implementer as much as the reviewer. The assertion
this justifies lives in SKILL.md's Reviewers section; the evidence is here.

## The four-for-four finding

Four for four in one run — a misattributed package, a list at inverted polarity, a
commit body citing the wrong line, a banner refuting a currently-true fact.

## The mechanism is the ticket's framing, not implementer sloppiness

The fix text **paraphrases the issue body's framing** instead of being checked
clause-by-clause against the tree, so a wrong premise in the ticket becomes a
wrong claim in the repo. Two of the four came verbatim from their issue's wording,
and that issue is still wrong on two counts — so every ticket split from the same
source inherits them.

## The clause-by-clause duty

Put the check on the **implementer**, not only the reviewer: every factual claim
it restates must have a settling command run against the tree first. The issue
body is a lead, never a citation. Tell reviewers the same, and to read each
corrected sentence literally, asking whether every clause is true under that
reading — nobody hunts this unprompted, because the diff "obviously" improves
accuracy.
