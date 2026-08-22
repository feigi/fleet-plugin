# no-undo-audit Payload Hardening

`no-undo-audit.sh` emits `stash` as a number or the literal `null`, where `null` means
the count is *unknown* — the stash list is unreadable, or the ref cannot be read — as
distinct from a genuinely empty stash. JS truthiness collapses `null` and `0`, so a
consumer writing `if (json.stash)` would erase that distinction. Proposals to harden the
payload against that — changing the representation so the unknown state cannot be
coerced, or adding a truthiness warning at the emit site — are refused. The payload stays
as it is.

## Why this is out of scope

The hazard is real and correctly described. It is refused because there is nothing to
protect, and that is a measurement rather than an assumption.

**No consumer exists.** Every `.stash` reference in the repo is
`assert.equal(r.json.stash, <literal>)` under `node:assert/strict` — `===` semantics,
which cannot coerce. Every other mention of the script is prose instructing a human or an
LLM reader to check `git stash list` when the count is "nonzero or unknown", never a code
path that could collapse `null` into `0`. Re-measured against `d6931fa` when this record
was written and unchanged: no truthy check on this field exists anywhere in the tree.

That settles the three options the ticket left open:

**Changing the representation** — a `stashKnown` boolean, or a string sentinel — is a
payload schema change touching the spec's script-surface row for this script and the
tests that pin it, to defend against a caller nobody has written. That is paying a real,
immediate cost for a hypothetical one.

**Adding a trap comment now** is nearly free, but the comment governing the payload
`printf` already tells a future editor the field is "a digit count (or the literal `null`
when the count is unknown)". Anyone writing a consumer reads that and has what they need;
a second comment warning about JS truthiness specifically is guarding a language footgun
at the wrong layer.

**Closing and relying on review** is what was chosen. The hazard is a review checklist
item for a PR that does not exist, not a defect in the one that introduced the field.

Not covered by this refusal: if whoever is next editing near the payload `printf` wants
to append a half-line naming the truthiness trap, that is free and welcome — an
opportunistic freebie, not a reason to carry the work as its own ticket.

Reopen when a JS consumer of this payload is actually written. At that point the
representation change becomes worth arguing on its merits, and #307 is the analysis
whoever reviews it should read first. What this record refuses is hardening the payload
*ahead of* such a consumer, not the hardening itself.

## Prior requests

- #307 — "`no-undo-audit` payload: `stash` is `number|null`, and JS truthiness collapses `null` and `0` — a future consumer's `if (json.stash)` would erase the distinction #147 introduced"
