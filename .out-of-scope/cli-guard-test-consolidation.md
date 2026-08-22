# CLI-Guard Test Consolidation

Each fleet script's own test suite spawns that script and pins its own `arg()`
CLI-boundary guards — a trailing flag dies by name, and `--flag=value` is refused
rather than read as absent. The `=` form's wording is pinned too, except in
`candidates`, which pins only that it refuses.
Proposals to lift those per-file spawn assertions out of the per-script suites and into
one shared table-driven file are refused. The per-file pins stay where they are.

## Why this is out of scope

**The proposal's own first argument is the deciding one**, and it was written by the
person proposing the consolidation:

> Consolidating them into one table restores exactly the property that made the gap
> invisible: deleting the guard from one script would then be caught by a file that
> script's own suite never runs.

That is decisive. These tests exist *because* per-file suites did not pin their own
file's guard — #169 was filed precisely because four scripts lacked a guard nobody's
local suite would have missed. Moving the pins into a file that no single script's suite
runs recreates the blind spot the tests were added to close, and trades a real property
for a line count.

This is not a refusal on feasibility. The consolidation was written and measured before
it was proposed — a five-row table, its own run green, and the full suite green with it
added. It works; it is the wrong shape.

**The proposal was already stale when it was ruled on.** The assertion count grew between
filing and closing — measured at close on `5bbd2ca`, from the 11 the proposal counted to
18 — and every assertion added in that window was a per-file pin added deliberately in
the PR #360 round. Consolidating would have undone more recent, deliberate work than it
tidied. The durable form of that measurement is not the number but the direction: this
layer grows by scripts acquiring their own pins, so a table that freezes a snapshot of it
is stale on arrival.

**Sharing the implementation is not sharing the pins.** The seam question was live when
this was filed and has since been ruled the other way — #367 overturned #169's "no shared
module" ruling and `arg.mjs` now exists. That does not change this ruling. Sharing the
*implementation* is what removes drift; sharing the *pins* is what removes local
coverage. The per-file spawn assertions stay where they are as the integration layer
proving each script actually wired it up. Re-measured against `d6931fa` when this record
was written, that is the shape in the tree: the shared module carries its own unit tests
while the per-file pins stay in the suites that spawn each script — including in scripts
the proposed table never had a row for.

**On the duplication itself:** near-identical spawn assertions across the script suites
are the correct cost of each suite standing alone. `spawnSync` boilerplate is cheap; a
guard that no local suite pins is what actually cost this repo a ticket.

Two cases were measured as inexpressible in the table even by the proposer, and would
have had to stay in the per-script files regardless: `ci-state`'s assertion that it died
before touching `gh`, and `pr-overlap`'s flag-as-value case, which exercises a different
branch of the guard than a trailing flag.

Not covered by this refusal: unit-testing the shared `arg.mjs` module itself, which is
the right home for the helper's own behaviour and is not what these per-file pins are
for. Reopen only with evidence that the per-file pins have failed to catch something the
table would have — an argument from line count alone has been made and answered.

## Prior requests

- #368 — "consolidate the per-file `arg()` CLI-guard tests into one table-driven `arg-guard.test.mjs` across all five scripts"
