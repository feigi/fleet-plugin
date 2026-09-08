# arg.mjs Factory Collapse

`scripts/arg.mjs` exports separate factories — `makeDie(name)`,
`makeArg(die)`, `makeHas(die)`, `makeSweep(die)` — and each consumer wires them
in a short stanza:

```js
const die = makeDie(NAME);
const arg = makeArg(die);
const has = makeHas(die);
```

Proposals to collapse these into one `makeCli(scriptName)` returning
`{ die, arg, has }` are refused. The factories stay separate and `die` stays
explicitly threaded.

## Why this is out of scope

**The premise stopped being true four days after it was proposed.** The
argument is that the factories *"exist only to thread `die` into `arg`/`has`"*,
so collapsing them removes the threading. `makeSweep(die)` landed on
2026-08-18 in `8046bc5` — four days after the proposal — and threads `die`
exactly the same way. **Five of the nine consumers import it.** So a
`makeCli()` returning `{die, arg, has}` does not remove the pattern; it splits
the module into a collapsed half and a threaded half, which is worse than
either shape alone. Including `sweep` in the returned object instead makes it a
larger change than anything that has been measured.

**The measurement no longer covers the tree it was taken against.** The
proposal's evidence — 640/640 green, 2433 → 2423 lines over eight scripts — was
recorded before `makeSweep` existed and before `staleness.mjs` and
`member-outcomes.mjs` became consumers. There are nine wiring sites now, not
seven. Anyone reapplying this has to re-measure from scratch, so the ticket's
own evidence carries none of the weight it was filed with.

**The line count is not the cost that matters.** Ten lines net, against
rewriting the three assertions in `arg.test.mjs` that pin the import, the
wiring line, and the `NAME` constant for every consumer. Those assertions exist
to stop the `#176`/`#328`/`#363` pipe-truncation defect walking back in — a bug
that has already returned three times. The pins are the asset here; ten lines
spread across nine files are not. Trading a re-derived guard for a line count
is the same trade refused in [cli-guard-test-consolidation.md](cli-guard-test-consolidation.md),
from the other direction.

**It re-decides a shipped design decision for no behaviour change.** #367's
agent brief specifies `makeArg(die)` and states *"`die` must stay injected"*,
and `arg.mjs`'s own header carries the rationale in shipped prose: *"Each
factory takes (or returns something bound to) the caller's own `die()`, because
every script's `die()` speaks under its own NAME."* A `makeCli(scriptName)`
form does satisfy that constraint — nothing would be hardcoded — so this is not
a refusal on correctness. It is a refusal on churn: re-opening an interface
decision that a brief made deliberately, for a change its own proposer calls
behaviour-neutral.

**This is not a refusal on feasibility.** The reviewer applied it in a private
copy and measured it green. It works; the module it was measured against no
longer exists in that shape.

Not covered by this refusal: extracting genuinely new shared behaviour into
`arg.mjs`, or re-shaping its exports if `sweep` or a future helper forces the
question on its own merits. **Reopen only if something other than line count
forces the export shape to change** — at which point `makeCli` is the natural
form to consider, and this record is the thing to re-read rather than
re-derive.

## Prior requests

- #467 — "collapse arg.mjs's makeDie/makeArg/makeHas into one makeCli(NAME) returning {die, arg, has}?"
