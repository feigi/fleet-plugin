# review-pr.js Micro-Refactors

Style-level refactors of `workflows/review-pr.js` — hoisting guards, swapping `&&` for
optional chaining, deleting comments that look duplicated — are not accepted on their
own. Three have been measured and rejected. This is not a rule against changing the
file; it is a rule against changing it for tidiness alone.

## Why this is out of scope

The reviews that produce these findings run over the file constantly, and each pass
re-derives the same handful of "obvious" simplifications. Measured, they are not
simplifications:

**Hoisting `resolveDimensions`' empty-override guard above the `map`** looks safe
because `Array.prototype.map` is length-preserving. A differential harness lifted the
function verbatim and compared the hoisted variant across 43 inputs — holes, sparse
arrays, `Set`, `arguments`, Array subclasses, `Symbol.species` subclasses, length-lying
Proxies, frozen arrays — on return value, `length`, hole positions, own keys, prototype
and thrown message. The variants diverge. The guard stays below the map.

**Replacing the `snap &&` guards with optional chaining** is pure churn on code that was
just added. Both idioms already appear in the file, the guards are unreachable at the
only call site, and the direct unit tests that *do* exercise them pass either way.

**Deleting the `testCmd` tombstone comment** as a near-duplicate of the function's own
header misreads what it does: the header states the resolution *policy*, while the
tombstone is an absence marker sitting where a default used to be — it answers "why is
there no default here?", which the header does not.

A related trap worth knowing before proposing anything module-level in this file:
`review-pr-testcmd.test.mjs` lifts `resolveTestCmd` out of the source *text* by regex and
evals the function body alone, so a `const` declared beside the function is a
`ReferenceError` at lift time. Measured: the tests that reach the reference go red — two
if the `const` is read only in the throw branch, all five calling tests if it is read
above the guards.

Comment-density findings over this file land in the same place. A review pass counting
comment-to-code ratio on a freshly added block, and finding the same rationale in the
code comment, the design spec and the test, is measuring restatement rather than a
defect. The three surfaces have different audiences and different lifetimes: the spec
records the decision and its alternatives, the test pins the behaviour, and the comment
answers "why is this line like this?" for whoever is reading only the code. Agreement
between them is the intended state. Cutting one to remove the overlap trades a durable
answer for a line count, and the repo's agent-facing prose is deliberately dense.

Note the asymmetry if any of this is ever actioned: agent-facing markdown is executable
instruction, so cutting a clause there can change behaviour, whereas `review-pr.js`
comments and the spec cannot. That makes the markdown the *least* safe place to trim,
not the most.

Not covered by this refusal, and still open if anyone wants them as their own change:
the test-side consolidations #220 also lists — the repeated "a loose match is vacuous"
lesson in `review-path-default.test.mjs`, and the near-identical `dimensionKeys`
`deepEqual` cases in `select-dimensions.test.mjs`, which restate the #211 spec's
size-tier matrix and could be one table. Those are test structure, not comment density.

No count is given for those cases on purpose: the #211 spec's item 12 refuses to carry
one, noting that "nine" was hand-derived against an eleven-row table. They are also not
1:1 with the matrix, part of which is pinned by `assert.equal`/`assert.ok` instead.
Exclude the `kinds`-missing case — its comment reads "Fail DIRECTION, not a matrix row",
and because `computeStats` always emits `kinds` that test hand-builds its stats blob, so
it must stay standalone.

If the vacuous-pin lesson is ever consolidated, keep verbatim the copies that record an
applied mutation and its result — "Measured GREEN under exactly that mutation",
"Measured GREEN on review-and-fix step 2", and the one ending "green with the gate
removed". Those are evidence; the dozen-plus other restatements are not, and the
file-header ceiling block is the place to consolidate *into*, not a copy to cut.

## Prior requests

- #280 — "hoist resolveDimensions' empty-override guard above the map"
- #313 — "delete the duplicated testCmd tombstone comment in the arg-defaulting block"
- #314 — "replace resolveTestCmd's snap && guards with optional chaining"
- #220 — "review-pr.js comment blocks and the #211 spec restate each other and the tests"
