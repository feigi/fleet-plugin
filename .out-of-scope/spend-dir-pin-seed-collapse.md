# Spend-Dir Pin Seed Collapse

`spendDirPin()` in `plugin/scripts/board.mjs` builds a latching closure over the
cockpit's spend directory. Its current shape opens with a guard and two
declarations:

```js
export function spendDirPin(explicit, home = process.env.HOME, cwd = process.cwd()) {
  if (explicit != null) return () => explicit;
  const launchMs = Date.now();
  let pinned = null;
  return () => {
    if (pinned !== null) return pinned;
    const answer = findSubagentsDir(home, cwd);
    if (typeof answer !== "string") return answer; // null or { error }: neither is a trustworthy answer to latch
    if (newestTranscriptMs(answer) < launchMs) return answer; // predates this pin — could be a previous run's
    return (pinned = answer);
  };
}
```

Proposals to collapse the explicit-value early return into the latch's seed —
`let pinned = explicit ?? null`, dropping the guard line — are refused. The
explicit path keeps its own early return.

## Why this is out of scope

**The collapse is safe, and that was measured rather than assumed.** All three
invariants survive it. A `{ error }` from `findSubagentsDir` is still returned
without latching, so a transient EACCES still recovers on the next tick. The
`launchMs` gate still refuses to latch a directory whose newest transcript
predates this server's launch. And the explicit path still never reaches the
heuristic: seeding `pinned` makes the closure return on its first line, leaving
the `typeof answer !== "string"` and `newestTranscriptMs` checks unreached —
which is correct, because they guard only the heuristic. All five tests that
drive `spendDirPin` directly pass under the collapsed form unmodified, as does
the whole of `plugin/scripts/board.test.mjs` — including both live-`serve`
rows: the `--spend-dir` row (`board.test.mjs:1737`), the only one able to fail
on the explicit value being dropped between resolution and tick, and the
wrote-first-on-its-watch row (`board.test.mjs:795`), the only one able to fail
on the latch being rebuilt per tick.

So this is not a refusal on feasibility. It is the same refusal on churn that
[arg-factory-collapse.md](arg-factory-collapse.md),
[blockers-accessor-extraction.md](blockers-accessor-extraction.md),
[stray-skip-predicate-extraction.md](stray-skip-predicate-extraction.md) and
[review-pr-micro-refactors.md](review-pr-micro-refactors.md) already record: a
behaviour-neutral reshape, worth two lines, against code whose guards were each
re-derived under adversarial review.

**The guards being reshaped are the youngest and most expensive lines in the
function.** Both of them are PR #1679 `correctness` findings that survived
refutation. The `??=` latch that preceded the current form pinned a recoverable
`{ error }` forever instead of retrying. The pin-time comparison that preceded
the `launchMs` capture accepted whichever session was newest *at pin time*, which
can be a previous run's. The shape the request wants to tidy is the shape those
two findings produced, days old, and the argument for touching it is line count.

**The request is against a shape that no longer exists.** The finding was raised
against the pre-#1679 code — a two-line `??=` body — and the exact diff it
proposed cannot be applied to the current function at all. It was filed as a
question ("is a comparable simplification available here?") rather than a settled
proposal. The answer above is yes, and the answer to whether to take it is no.

**The alternative the KB prescribes is already in the tree.** Where a non-obvious
contract is at risk of being lost, these records prescribe pinning it with a test
rather than reshaping the code. Both contracts are pinned: *"an unresolvable
transcript tree recovers on its very next tick"* and *"the pin does not latch a
session that predates it"*.

## What would reopen this

A measured defect traced to the explicit-value path — an explicit `--spend-dir`
that fails to override the heuristic, or one that is wrongly subjected to the
`launchMs` gate. Or a third caller shape arriving (something other than "explicit
value" and "resolve it yourself") that makes the guard genuinely load-bearing for
more than one case. A readability argument alone has been made and answered.

## Prior requests

- #1686 — "board.mjs spendDirPin: re-look at the 2-line `??=` seed collapse against the #1679 rewrite" (deferred from PR #1679 review, `simplify` dimension, suggestion severity)
