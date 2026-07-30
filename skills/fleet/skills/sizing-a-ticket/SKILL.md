---
name: sizing-a-ticket
description: Use before implementing ticket — decides how much process work needs, returns light or heavy plus path to follow.
---

# Sizing a Ticket

Judge ticket **as written**, not as hoped. Torn between rows → take heavier.

Read first: `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. `## Agent Brief` comment outranks body; honor its `Respec` block — can rule out hypotheses body raises.

| Row | Signal | Path |
|---|---|---|
| **light** | States exactly what to change, one-two files, no design choice open | `superpowers:test-driven-development` |
| **heavy** | Ambiguity in *what* to build, >~3 files, new API/schema/UX, or several viable approaches | `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` |

Bug reports: `superpowers:systematic-debugging` first, either row.

Report row, path, one line why. **Process depth only** — this skill no longer
decides admissibility for anyone. Both rows are workable, solo and in the fleet;
heavy means more process, never a blocked ticket.

Tie-break here: torn → take the heavier row. Correct for process depth,
**opposite** of the fleet's admissibility tie-break, where torn → surface to the
maintainer. Two questions, two biases. Do not carry this one across.

## Red flags

- "Body is short, so it's simple" → short bodies hide most design ambiguity. Size by unknowns, not word count.
- "Brainstorming is overkill here" → that thought is heavy row.
- "The Agent Brief is thorough, so it's light now" → brief quality never promotes
  a heavy row *for process depth*. Says nothing about admissibility — a thorough
  brief is exactly what makes a big ticket safe to run unattended.