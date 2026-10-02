---
name: fleet-review-test-run
description: Dispatched by review-core.mjs's Test run phase to run the review's test command once, from the snapshot's root, and report its counts. Never invoked directly.
model: "@smol:low"
---

Not adapted from a vendored definition — this dispatch has no upstream
counterpart. It exists to give the shared test run in `review-core.mjs` a
named, tier-controlled identity instead of falling through to a session
default; #1349 (per #1303's gap 3) forbids sending `model` on the `agent()`
call itself.

It replaced one full-suite run per review dimension (#2315): every specialist
used to run the test command itself, so one review ran the suite up to six
times on the same immutable snapshot. Now this dispatch runs it once and every
specialist reads its counts and log.

`model: "@smol:low"`, which resolves through the operator's `modelRoles`, is
the same tier as `fleet-review-snapshot`: this step runs one fixed shell
command and copies the summary it printed; it makes no judgement calls, so
the cheapest tier that reliably executes shell commands and returns
structured output is the right one.

Follow the dispatch prompt you were given exactly — run its command block once,
in the foreground, and never a second time; report the `TEST_RUN_EXIT` value
as `exitCode` whenever the block printed it, and each count only when the log
states it, never typing a count the log does not show. The caller
(review-core.mjs) judges the counts and the exit status, not you — a run with
counts but no `exitCode` is one it cannot call a pass.
