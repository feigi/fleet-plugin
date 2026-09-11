# review-pr Stats Validation

`selectDimensions(all, stats)` receives a `stats` object that crossed a process
boundary — produced by a snapshot agent, relayed as text, parsed from JSON — and
performs no schema validation on it. Proposals to add runtime validation of that
object are refused. The function keeps reading `stats` defensively instead.

## Why this is out of scope

**The premise is true and the consequence it implies is already designed out.**
`selectDimensions` never narrows coverage on a value it merely finds truthy. Every
narrowing decision is gated on an explicit strict comparison, and everything else
falls through to the full dimension set:

```js
if (!stats || !stats.profile || stats.profile === "empty") return all;  // absent/garbage → full set
if (stats.truncated) return all;
if (stats.docsOnly === true) { … }                                      // not `if (stats.docsOnly)`
stats.profile === "tests-only" && stats.hasConfig === true
… (d.key === "tests" && stats.hasTests === true)
```

A malformed, half-parsed, or hostile `stats` therefore produces **more** review, not
less, and two `throw`s backstop an empty dimension set. The safe direction is the
default, which is the property validation would be bought to guarantee.

This is deliberate and already documented in the source, immediately above the
relevant block: *"a cross-check would let missing input narrow coverage — the
inversion the `=== true` guards in `selectDimensions` exist to prevent."* The
`diffLines` field is called out there as the single deliberate exception, where
absent and `0` are treated alike because the count is the only measurement ruling
out a 0-byte file.

**Validation would convert a safe degradation into a hard failure.** Today a
mangled relay costs an over-broad review — every specialist runs, nothing is
skipped. A schema that throws on a shape mismatch turns that into a dead review
run. For a component whose failure mode is "review less than we should," trading a
silent widening for a loud stop is the wrong direction, and the widening is not
silent anyway: the dispatch log prints `profile unknown, full set` when `stats` is
absent or profileless.

**No incident.** The reviewing specialist who raised it wrote "not worth adding
runtime validation unless a real incident is observed," and filed it as
pre-existing rather than introduced by the PR under review. Nothing has been
observed since.

**The change is two-site, not one.** `selectDimensions` exists twice by design —
once in the workflow entry point and once in the portable core module that exists
so the logic is "portable verbatim" across harnesses. Any validation has to land in
both and stay byte-aligned, or the two harnesses silently disagree about which
reviews run. That doubles the cost and adds a drift surface, for a guard whose
absence currently costs nothing.

## What would reopen this

An observed incident where a malformed `stats` caused **fewer** dimensions to run
than the diff warranted — the inversion the `=== true` guards exist to prevent
actually occurring. That is the failure validation would have caught and the
current design claims is impossible; a real instance would refute the design, not
just the priority. A new narrowing branch added on a value that is *not* compared
with `=== true` would reopen it too, since it breaks the invariant this refusal
rests on.

An argument from "the input is unvalidated" alone has been made and answered: the
input is untrusted by construction and read accordingly.

## Prior requests

- #1286 — "review-pr.js: stats object crossing the process boundary into selectDimensions is unvalidated" (deferred from PR #1282 review, `types` dimension, specialist-rated low priority)
