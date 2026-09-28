# arg.mjs Factory Collapse

> **Superseded in part (2026-09-28).** #1077 (PR #2105) changed the module this
> record describes. `makeSweep`, `makeStray` and `makeNumArg` are deleted. Eight
> scripts (board, ci-state, diff-stats, merge-gate, pr-overlap, staleness,
> tier-check, tier-roles) now wire through one factory,
> `defineFlags(die, { flags, positionals = [] })`. `flags` maps each name to
> `"value"` or `"bool"`. The call returns `{ arg, numArg, has, sweep, stray }`,
> every reader bound to that one table, and a read of the wrong kind or of an
> undeclared name refuses through `die()` at exit 2. Their stanza is now:
>
> ```js
> const die = makeDie(NAME);
> const { arg, has, sweep, stray } = defineFlags(die, { flags: { … } });
> ```
>
> So the opening list and the first "Why" paragraph no longer describe the
> code. No standalone `makeSweep` is left to split the module into a collapsed
> half and a threaded half, and "five of the nine consumers import it" counts an
> export that no longer exists. The consumer counts further down ("nine wiring
> sites") are the August tree's too; read today's roster with
> `grep -n '^import .* from "./arg.mjs"' plugin/scripts/*.mjs | grep -v test`.
>
> The refusal of `makeCli` returning `{ die, arg, has }` is resolved, not
> reversed. Its `arg`/`has` half shipped as `defineFlags`, through the door the
> closing paragraph left open: the export shape changed for a reason other than
> line count — binding the flag table to the reads, so the two can no longer
> drift apart. The `die` half did not ship. #1077's brief specified
> `defineFlags(die, …)`, so `die` is still bound by `makeDie(NAME)` and still
> explicitly threaded. `makeArg`/`makeHas` stay exported because
> `candidates.mjs` binds them directly.
>
> Folding `makeDie(NAME)` into that call, so `defineFlags(NAME, …)` also returns
> `die`, is the one piece of the proposal still open, and nothing here reopens
> it. It saves one line per script, which is line count. It would not retire
> `makeDie` either: six scripts bind `die` without `defineFlags` (candidates,
> fleet-heartbeat, fleet-tick, ledger, member-outcomes, shortlist). That brings
> back the two-shapes split the first "Why" paragraph refused, with `die` as the
> split point this time. The pins, churn and header-rationale paragraphs still
> hold on the current tree: `arg.test.mjs` still pins the import,
> `const die = makeDie(NAME);` and the `NAME` constant, and four of the scripts
> it pins are `defineFlags` scripts. The analysis below is left as written, in the
> tense it was written in.

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
