# Claimed-Count Shape

`fleet-tick.mjs`'s `claimed()` returns `number | "<n>+" | null`. `null` means unknown,
a number is an exact count, and the string `"200+"` means the `gh` query hit
`CLAIMED_LIMIT` and may be truncated. Proposals to replace that union with a
self-describing `{ count, truncated }` object, with the `+` formatting moved into
`stallReport`'s display helper, are refused. The union stays.

## Why this is out of scope

It fixes no defect. On `ac5337d` the value has exactly one consumer: `stallReport`'s
`n()` helper, which does `v == null ? "unknown" : String(v)`. No code does arithmetic or
numeric comparison on it, so the string form cannot be mistaken for a number anywhere it
travels. The comment above the `return` says the string is deliberate: "that is what the
reader must not mistake for an exact count".

The reshape also cannot be done on one side. `stallReport`'s `claimed` parameter has two
producers: `fleet-tick`'s capped `gh` count, and `compute-board.mjs`'s card count, which
is a plain integer or `null` and can never truncate. There are only two ways to do it:

- **Wrap both producers** in `{ count, truncated }`. This changes the cockpit's
  `liveness` payload, which `compute-board.mjs` serialises into `board.json`, a public
  shape, for a producer that has no truncation to report.
- **Change only `fleet-tick`** and have `n()` accept both a bare number and the object.
  Then `stallReport` takes two input shapes, which is the drift `fleet-state.mjs`'s
  header exists to prevent.

Either way it reshapes a shipped contract for tidiness. `review-pr-micro-refactors.md`,
`arg-factory-collapse.md` and `blockers-accessor-extraction.md` record the same trade
and refuse it.

Not covered by this refusal: the truncation branch (`n === CLAIMED_LIMIT` → `"200+"`)
has no test, in either `fleet-tick.test.mjs` or `fleet-state.test.mjs`. That is a
coverage gap in the current shape, not an argument for a new one. It is filed as #1760.

## What reopens it

A second consumer that needs the count as a number (a threshold, a sum, a comparison),
or a measured bug where `"200+"` reaches code that treats it as numeric.

## Prior requests

- #1738 — "fleet-tick.mjs claimed() returns an ad-hoc number|string|null union instead of a self-describing shape"
