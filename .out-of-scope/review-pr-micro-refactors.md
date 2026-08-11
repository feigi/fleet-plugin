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
`ReferenceError` at lift time. Measured at 365 → 363 passing.

## Prior requests

- #280 — "hoist resolveDimensions' empty-override guard above the map"
- #313 — "delete the duplicated testCmd tombstone comment in the arg-defaulting block"
- #314 — "replace resolveTestCmd's snap && guards with optional chaining"
