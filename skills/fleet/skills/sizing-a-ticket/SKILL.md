---
name: sizing-a-ticket
description: Use before implementing ticket, or admitting tickets into queue by complexity — decides how much process work needs, returns light or heavy plus path to follow.
---

# Sizing a Ticket

Judge ticket **as written**, not as hoped. Torn between rows → take heavier.

Read first: `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. `## Agent Brief` comment outranks body; honor its `Respec` block — can rule out hypotheses body raises.

| Row | Signal | Path |
|---|---|---|
| **light** | States exactly what to change, one-two files, no design choice open | `superpowers:test-driven-development` |
| **heavy** | Ambiguity in *what* to build, >~3 files, new API/schema/UX, or several viable approaches | `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` |

Bug reports: `superpowers:systematic-debugging` first, either row.

Report row, path, one line why. Admissibility is caller's policy — solo session follows heavy path, unattended fleet excludes ticket.

## Red flags

- "Body is short, so it's simple" → short bodies hide most design ambiguity. Size by unknowns, not word count.
- "Brainstorming is overkill here" → that thought is heavy row.
- "The Agent Brief is thorough, so it's light now" → brief quality never promotes heavy row. Unknowns live in work, not write-up.