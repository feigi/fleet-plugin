# assessBeat Shape Guard

`assessBeat({ beat, ticked, now })` in `fleet-state.mjs` does not check the shape of
`beat` itself. It trusts that any truthy `beat` is `{ at: number, interval: number,
stopped: string }`, because every production caller gets `beat` from `readState()`,
whose `mark()` validator makes it either `null` or exactly that shape. Proposals to add a
second guard inside `assessBeat` (a `typeof beat.at === "number"` check, or a loud stderr
line on a malformed mark) are refused. The single parse boundary stays.

## Why this is out of scope

The hazard is real, and measured it is worse than the ticket described. Passing a
malformed mark straight into `assessBeat` —
`assessBeat({ beat: { at: "t", interval: 300, stopped: "" }, now })` — returns
`ageMs: NaN, overdueMs: NaN, kind: "beating"`. The kind is not unpredictable: `NaN > x` is
always false, so the beat is never overdue, and a corrupt mark reads as a *healthy* run.
That is the silence direction, which `mark()`'s own comment rules out: a mark that fails
validation is absent, "never 'beating', which is the silence".

It is refused because no production caller reaches it. Every call site on `ac5337d`
either routes through `readState()` or hands `assessBeat` a well-formed literal:

- `fleet-tick.mjs` — `readState(path, NAME)`, then `assessBeat({ beat: priorState.beat, … })`.
- The cockpit — `board.mjs`'s `gather()` reads `readState(stateFile, NAME)?.beat`, and
  `compute-board.mjs`'s `stall()` passes it on to `assessBeat`.
- `fleet-state.test.mjs` — well-formed literals and `null` only, straight into `assessBeat`.
- `compute-board.test.mjs` — well-formed literals, `null`, or no `beat` at all, through
  `computeBoard()`. That is an exported pure entry point: it takes `beat` from its caller
  and hands it to `stall()` unchecked, so it is a second door to `assessBeat`.

`mark()` validates the mark *as a unit*: both `at` and `interval` must be positive
integers, or the whole mark is absent. So a malformed mark is already impossible
downstream of the only reader of the file, and a guard inside `assessBeat` would be a
second copy of `mark()`'s rule. The module's header refuses exactly that: "what travels
between scripts is the rule, never a copy of it". `compute-board.mjs` gives the operator's
reason for importing the rule rather than restating it: two spellings of "this run is
dead" are two answers to reconcile at 3am.

This is the trade `no-undo-audit-payload-hardening.md` records for a payload nobody
consumes wrongly. A real, immediate cost (a duplicated validator that can drift from
`mark()`), paid against a caller that does not exist.

## What reopens it

A production call site that hands `assessBeat` a `beat` it did not get from `readState()`,
directly or through `computeBoard()`: a hand-built mark, a mark read from another file, or
an import of `assessBeat` or `computeBoard` from a script that parses its own state. At
that point the silent-healthy failure direction measured above is live, and the argument
is no longer defence in depth. The fix to argue for then is routing that caller through
`readState()`/`mark()`. A second validator comes only if it cannot be routed there.

## Prior requests

- #1737 — "assessBeat() trusts beat's shape by caller discipline, not a guard at its own boundary"
