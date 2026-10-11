# Automatic Bounds, Gutters and Locality in `Pin`

`tests/support/prose-pin.mjs` is moving from 16 flat exports to one `Pin`
interface (#2149, then #3063): a node per located slice, with methods named
after the flat functions they replace. The interface leaves every bound and
every gutter to the caller. Proposals to make `Pin` infer them — a section
that finds its own end, a blockquote gutter stripped on sight, a paragraph
bound folded into an option, a predicate in place of `assert.match`, a
`path:line:column` on every node — are refused. So is de-duplicating the
local quote-gutter regexes that test files keep beside the module's own.

## Why this is out of scope

`Pin` replaces the flat exports under one constraint: every suite keeps the
slice it takes today and the red/green outcome it has today. THE PIN
CONVENTION says existing pins move only where a hole in them is measured, and
a cutover that quietly re-spans 95 test modules' pins moves all of them at
once. Each refused item fails that constraint, or buys nothing a caller lacks.
All figures below were measured at `84b05f78` (2026-10-10) by running the
suites against patched copies of the module, never the real one.

**A section that ends itself.** A `.section(heading)` bounded at the next
heading of the same or shallower depth, for every caller, turns 2–3 of 444
markdown tests red, and 9 once the shell sites are included. Six heading-start
slices stop at a deeper child heading on purpose — four `### Reviewers` slices
whose suites assert the `#### Fallback` subsection is absent, and one that
would grow by 91,611 bytes. Five more end on a non-heading anchor on purpose;
`instrument-check-prose.test.mjs` records a pin that moved off a heading end
because renaming the neighbouring heading reddened it. `Pin` keeps
`.between(from, to)` and offers `.section(heading)` to call sites that opt in
where the slice comes out the same.

**A blockquote gutter stripped on sight.** Stripping `>` whenever a slice
carries quoted lines turns 24 of 192 tests red across
`dispatch-block-golden-prose`, `fix-applier-correction-rules-prose`,
`kill-rule-prose` and `review-path-default`. Those suites compare verbatim
dispatch blocks with the gutter intact. `Pin` strips only on
`.stripGutter(marker)`.

**`paragraph`'s bound as an option.** `.paragraph(anchor, { until })` would
fold `betweenPhrases` into `paragraph`. The two end differently: `paragraph`
ends at a blank line and requires `next`, the opening of the following block,
so a deleted blank line cannot merge two paragraphs into one slice;
`betweenPhrases` ends at a phrase. One method with two end rules hides which
one a call site relies on, and dropping `next` reopens the merge it guards.

**`.matches(re)`.** A boolean predicate makes `assert.ok(node.matches(re))`
the natural assertion, and a failing `assert.ok` prints `false`. A failing
`assert.match(node.text, re)` prints the text and the regex. Emphasis
tolerance, the predicate's other job, already lives on the locating methods.

**`.where`.** A `path:line:column` on every node means every method tracks
its offset into the root, including the ones that rewrite text
(`.stripGutter`, `.runAbove`). That is the riskiest arithmetic in the module,
and it would need mutation testing to the module's zero-survivor bar. It buys
a better message, not a different verdict: a missing anchor has no line to
report, and only the non-unique case would gain line numbers. `what` stays
required and still names the claim.

**De-duplicating the local quote-gutter regexes.** Eleven sites in ten test
files strip a quote gutter with their own regex and join
(`refuter-scratch-prose:45`, `injection-control-prose:88`,
`dispatch-block-golden-prose:1239`, `dispatch-block-pins-prose:107`,
`immutable-body-claim-prose:55`, `tracker-block-copy-prose:127,188`,
`reporter-output-rule-prose:67`, `stash-prohibition-prose:115`,
`fix-applier-correction-rules-prose:107`, `kill-rule-prose:82`). None matches
the module's `/^\s*>+\s?/` joined with `\n`. Swapping the module's version into
the two named `stripQuoteGutter` copies turns 2 tests red in `refuter-scratch`
and 3 in `injection-control`, because nested `> >` quotes strip differently.
Replacing them re-spans pins. Merely de-duplicating them is below ADR 0002's
bar.

## When to reconsider

- **Automatic section end:** a heading inserted between a pinned
  `.between("## A", "## B")` pair widens a slice and lets a pin pass on the
  inserted section's text. Then move that pair onto `.section()`. The
  automatic end for every caller stays refused while any slice stops at a
  child heading on purpose.
- **Automatic gutter stripping:** the verbatim dispatch-block suites stop
  comparing blocks with the gutter intact.
- **`{ until }`:** `betweenPhrases` loses its last caller, or `paragraph`
  loses its `next` requirement on its own measured grounds.
- **`.matches`:** never as a replacement for `assert.match`. Only if a caller
  needs a boolean over a slice that no locating method's option covers.
- **`.where`:** a fleet member's report shows a failing prose pin that took
  real effort to locate in its document, and the failure was a non-unique
  anchor.
- **Local quote-gutter regexes:** a measured defect in one of them (a pin it
  feeds goes green on prose it should refuse). Fix that one site.

## Prior requests

- #2149 — "prose-pin.mjs: one `Pin` interface over the 15 flat exports; migrate every prose suite" (the 2026-09-28 spec, in the issue's edit history; ruled 2026-10-11)
