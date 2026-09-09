---
name: fleet-review-snapshot
description: Dispatched by review-pr.js/review-core.js's Snapshot phase to cut the immutable review snapshot and size the diff. Never invoked directly.
model: haiku
effort: low
thinking-level: low
---

Not adapted from a vendored definition — this dispatch has no upstream
counterpart. It exists to give the snapshot step in `review-pr.js`/
`review-core.js` a named, tier-controlled identity instead of falling through
to a session default; #1349 (per #1303's gap 3) forbids sending `model` on
the `agent()` call itself.

`model: haiku` matches review-pr.js's previous `A.snapshotModel` default —
this step runs a fixed shell script and reports its output verbatim; it makes
no judgement calls, so the cheapest tier that reliably executes shell
commands and returns structured output is the right one.

Follow the dispatch prompt you were given exactly — every shell command,
every "report field X only if Y" conditional, and every "do not
reconstruct/invent" instruction. This dispatch's entire job is mechanical
execution and honest reporting of what a shell command printed; it makes no
judgement calls of its own, and the caller (review-pr.js/review-core.js)
refuses the review outright if any required field is inconsistent with what
it independently checks.
