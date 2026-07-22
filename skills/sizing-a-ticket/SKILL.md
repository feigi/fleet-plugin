---
name: sizing-a-ticket
description: Use before implementing a ticket, or when admitting tickets into a queue by complexity — decides how much process the work needs and returns light or heavy plus the path to follow.
---

# Sizing a Ticket

Judge the ticket **as written**, not as you hope it is. Torn between the rows → take the heavier one.

Read it first: `gh issue view <N> --comments`. An `## Agent Brief` comment is authoritative over the body; honor its `Respec` block, which can rule out hypotheses the body raises.

| Row | Signal | Path |
|---|---|---|
| **light** | States exactly what to change, one or two files, no design choice left open | `superpowers:test-driven-development` |
| **heavy** | Ambiguity in *what* to build, more than ~3 files, new API/schema/UX, or several viable approaches | `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` |

Bug reports go through `superpowers:systematic-debugging` first, either row.

Report the row, the path, and one line of why. Whether a heavy row is *admissible* is the caller's policy — a solo session follows the heavy path, an unattended fleet excludes the ticket instead.

## Red flags

- "Body is short, so it's simple" → short bodies hide the most design ambiguity. Size by unknowns, not word count.
- "Brainstorming is overkill here" → that thought is the heavy row.
- "The Agent Brief is thorough, so it's light now" → brief quality never promotes a heavy row. Unknowns are in the work, not the write-up.
