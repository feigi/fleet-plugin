# SKILL.md Line-Citation Spellings

The citation-sweep ban on `SKILL.md:<digit>` stays narrow. It is not widened to the non-colon spellings (`SKILL.md#L282`, `SKILL.md line 282`, `SKILL.md L282`, `SKILL.md :282`).

## Why this is out of scope

The ban exists because one stale `SKILL.md:282` citation was converted to a quoted anchor; it was never meant as a house-wide rule. The sweep's other file-level bans are each narrow or digit-general for one file and none polices every spelling of a line citation.

Widening has two costs and no cheap middle:

- A regex that catches every spelling, such as `/SKILL\.md(?::|#L|\s+(?:line|L)\s*)\s*\d/i`, still misses the space-before-colon form, and the form that does catch it false-positives on prose like `SKILL.md: 3 checks run`.
- Doing it properly is a decision to police all `file:line` spellings for every file, a policy change rather than a test tweak.

## Prior requests

- #2856 — "test(citation-sweep): node-floor-sweep SKILL.md line-number ban misses non-colon spellings"
