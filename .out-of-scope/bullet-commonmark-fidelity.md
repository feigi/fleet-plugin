# `bullet()` CommonMark Fidelity Beyond Its Call Sites

`prose-pin.mjs`'s `bullet()` reads the extent of one markdown list item so a
prose pin can hold a claim to that item. It models the subset of CommonMark's
list-item rules the pinned documents actually use. Proposals to close a
divergence from the reference renderer that no real call site hits are
refused. The divergence stays and is documented in `bullet()`'s own doc
comment, which says where `bullet()` and CommonMark disagree.

## Why this is out of scope

The divergences are real and measured. #2191 is the example: when a
shallower line comes straight after the item's text, CommonMark lets an HTML
block of types 1–6 (`<div>`, `</div>`, `<!--`, `<script>`, `<?`, `<!DOCTYPE`,
CDATA) interrupt the paragraph and end the item. `bullet()`'s
`PARAGRAPH_INTERRUPT` has no `<` alternative, so it keeps the line as lazy
continuation. Checked against `commonmark@0.31` at triage: all seven of those
openers end the item in the reference renderer and stay inside it in
`bullet()`. Type 7 (`<span>`, custom tags) interrupts in neither, so the two
agree there.

Nothing reaches the gap. At triage, `bullet()` had one real anchor, run-team's
`no-ci` edge, pinned from two test files. That item contains no line starting
with `<`. In `plugin/`, `docs/agents/`, `AGENTS.md` and `CONTEXT.md`, the only
lines that open an HTML block are the `<!--` attribution comments near the top
of six agent definitions, and none of them is inside a list.

Closing it would not buy completeness either. The same doc comment already
lists other deliberate non-models: it does not track which block the previous
line was, so a plain line after the item's own heading, fence or indented
code reads as lazy. It does not end the item at a shallower line inside a
still-open fence. It stands the marker column + 4 in for the parent's content
column. Adding HTML block starts correctly means CommonMark's type-6 tag list,
about 60 block-level names, pinned against a reference renderer. That is a
parser's worth of surface kept up to date for inputs no pinned document
contains. Shrinking this one divergence still leaves the others, so a piecemeal
fix makes `bullet()` look complete when it is not.

The documented ceiling is the defence. #2186 / PR #2190 corrected the doc
comment so it no longer claims HTML blocks interrupt. A reader who pins an
item containing HTML is told, at the definition, that `bullet()` will not end
the item there. `.out-of-scope/paraphrase-proof-prose-pins.md` takes the same
stance for a neighbouring gap: document the ceiling rather than engineer it
away.

## When to reconsider

When a real pin anchors an item whose extent depends on a divergence: its
item is followed by an HTML block, or by one of the other non-modelled shapes,
and the pin reads the wrong span. Then fix the divergence that pin exercises,
with a test comparing against the reference renderer. A hypothetical input is
not enough.

## Prior requests

- #2191 — "prose-pin.mjs: PARAGRAPH_INTERRUPT does not end an item at an HTML block (CommonMark types 1-6) — bullet() diverges from the reference renderer"
