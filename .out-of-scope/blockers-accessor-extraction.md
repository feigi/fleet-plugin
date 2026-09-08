# Blockers-Array Accessor Extraction

`scripts/release-ticket.sh` accumulates refusal reasons in a
`$blockers` variable that carries an implicit contract — **empty, or ends in a
trailing comma** — and each receipt site derives the JSON array body from it
separately:

```sh
blockers="${blockers}\"$block_j\","   # block() appends, comma included
"${blockers%,}"                       # the blocked checkpoint trims it
"${blockers}\"$die_j\""               # die() splices onto it
'"blockers":["%s"]'                   # halt() emits a single literal
'"blockers":[]'                       # the success receipt hard-codes empty
```

Proposals to factor these through one accessor — *"give me the blockers as a JSON
array body, plus an optional trailing one"* — are refused. The sites stay separate.

## Why this is out of scope

**Nothing is broken, and that was measured rather than assumed.** The reviewer
that raised this reproduced the `block()` + `die()` composition in isolation and
parsed the resulting stdout with `JSON.parse`: valid JSON, fields in the expected
order, both blockers present. All the sites are independently correct. The finding
called itself *"nice-to-have, not a merge blocker"*.

**The sites differ in the argument, and the difference is load-bearing.** The
blocked checkpoint strips the trailing comma because it is closing the array;
`die` keeps it because it is using it as the separator before its own entry. An
accessor that hides that distinction has to take a flag to re-expose it, at which
point the caller is still making the same decision with one more layer between it
and the output. The success receipt and `halt` do not read the accumulator at all
— they emit a constant — so two of the four "sites" are not derivations of
anything and cannot be routed through an accessor without inventing work for them.

**The divergence is already smaller than the finding describes.** PR #983 made
`die`'s receipt format string byte-identical to the blocked checkpoint's, taking
the file from four distinct receipt formats to three. Only the arguments still
differ, and per the point above they must.

**Extraction in this file has a specific cost.** These receipts are what the
script's own tests parse, and the tests pin the exact JSON shape because the
payload is a contract read by the fleet's other scripts. Reshaping the
construction path re-derives guards that exist because this payload has been
broken before — the same trade already refused in
[arg-factory-collapse.md](arg-factory-collapse.md) and
[cli-guard-test-consolidation.md](cli-guard-test-consolidation.md): a line count is
not worth a re-derived guard.

**"A fourth copy is where nobody remembers the contract" is a real worry with a
cheaper answer.** If the trailing-comma contract is at risk of being forgotten,
the fix is to pin it — a test asserting a receipt composed through `block()` then
`die()` parses as JSON — not to reshape four call sites. That is a smaller change
that protects the actual invariant, and it does not require agreeing that an
accessor is the right shape.

## What would reopen this

A **further** site deriving the array body — beyond the blocked checkpoint's trim
and `die`'s splice, the only two derivations the analysis above leaves — or a
measured defect traced to the trailing-comma contract — a receipt that fails to
parse, or an entry lost at a splice. Either makes the invariant's cost real
rather than anticipated. A re-raise on duplication count alone is answered above.

## Prior requests

- #987 — "release-ticket.sh: the blockers-array contract lives in prose across four receipt printf sites, not in one accessor" (deferred from PR #983 review, `types` dimension, severity suggestion)
