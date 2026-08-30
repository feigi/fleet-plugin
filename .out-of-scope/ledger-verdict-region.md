# ledger.mjs's Verdict Region

`skills/fleet/scripts/ledger.mjs` computes a `verdict` — one of `already-filed`,
`tracker-hit`, `soft-hit`, `clean`, `unverified` — from a nested ternary, with the
domain existing only as string literals in that expression and in the assertions
that check it.

Two proposals against this region are refused: **declaring the verdict domain as a
constant** (an `ALLOWED_VERDICTS` array, an `isVerdict` predicate, a `switch`), and
**restyling the expression** — optional chaining for the presence guards, an
if/else chain for the ternary, inlining the single-use near-miss binding.

## Why the domain constant is out of scope

**The domain is already enforced, by runnable tests rather than by a declaration.**
Measured at triage: no `ALLOWED_VERDICTS`, `isVerdict` or `switch (verdict)` exists
anywhere in the tree — the finding's grep reproduces. But mutating one arm of the
ternary by a single character:

```js
? "soft-hit"      →      ? "Soft-hit"
```

reds `ledger.test.mjs` immediately:

```
code: 'ERR_ASSERTION', actual: 'Soft-hit', expected: 'soft-hit'
```

All five values are asserted across the suite. A typo, a rename, or a sixth value
arriving without its tests fails at the point it matters. A `VERDICTS` constant
would restate what those assertions already kill, and — because nothing constructs
a verdict from outside this expression — would be a declaration no code path can
violate without also failing a test.

This is the same ground on which the identical proposal against the sibling script
was refuted and closed (**#824**): the invariant is enforced by executable tests
that kill exactly the hypothesised mutation, and the proposed guard pins nothing
the tests do not already catch. That refutation was measured there; the mutation
above re-measures it here rather than assuming it transfers.

## Why the restyling is out of scope

**Its load-bearing citation does not exist.** The if/else proposal justified itself
by "the project rule against nested ternaries". Verified: `grep -rniE 'ternar'`
over `CLAUDE.md`, `docs/` and the skills tree returns nothing. There is no such
rule. That leaves readability alone, which is not a reason to touch a region whose
evaluation order is load-bearing.

**The presence guards are not obviously redundant.** The proposed
`tracker.hits?.[0]?.score ?? 0` drops a `tracker.ok` re-test that the comment
block above documents as load-bearing: `hits` is *absent*, not `[]`, on the
failed-read branch, and the short-circuit is what keeps `unverified` ahead of the
near-miss floor — a tracker nobody read is the weaker answer and may not be
dressed up as the stronger one. The reporter's own note flags this: green tests
are not proof the guard is dead.

**Inlining the near-miss binding trades symmetry for density.** It is named
alongside its sibling and self-documenting at the point of use; inlining makes the
verdict arm harder to read for no behavioural gain.

The one clause in this cluster that was a factual claim rather than a preference —
a comment overclaiming a sharing only one of the two bindings has — was ruled on
its own merits, survived, and is already fixed in `e396577`.

## What would reopen this

For the domain constant: a verdict value constructed **outside** this expression —
another module emitting one, or a value read from a payload — at which point there
is a boundary for a predicate to guard and the tests no longer cover the whole
surface. For the restyling: a measured defect traced to the expression's shape, or
an actual project rule about ternaries, in which case it applies to the tree rather
than to this file.

Same trade refused in [review-pr-micro-refactors.md](review-pr-micro-refactors.md)
and [arg-factory-collapse.md](arg-factory-collapse.md): a re-derived guard is worth
more than a line count.

## Prior requests

- #1010 — "ledger.mjs: the verdict string domain has no single source of truth" (deferred from PR #1001 review, `types` dimension, unchecked by any refuter)
- #1011 — "ledger.mjs: bestHit/bestNear derivations and the four-arm verdict ternary — three style deferrals from PR #1001" (`simplify` dimension)
- #824 — the same domain-constant proposal against `staleness.mjs`, refuted on verification and closed
