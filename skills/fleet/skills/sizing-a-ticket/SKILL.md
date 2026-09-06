---
name: sizing-a-ticket
description: Use before implementing ticket — decides how much process work needs, returns light or heavy plus path to follow.
---

# Sizing a Ticket

Judge ticket **as written**, not as hoped. Torn between rows → take heavier —
process depth, not admissibility.

Read first: `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. `## Agent Brief` comment outranks body. Not `--json body` (body only, brief invisible) nor bare `--comments` (comments only, nothing at all when none, exit 0 — silent loss).

| Row | Signal | Path |
|---|---|---|
| **light** | States exactly what to change, one-two files, no design choice open | `superpowers:test-driven-development` |
| **heavy** | Ambiguity in *what* to build, >~3 files, new API/schema/UX, or several viable approaches | `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` |

**Fleet member on heavy: enter at `superpowers:writing-plans`.**
`superpowers:brainstorming` is the maintainer-present step — its `<HARD-GATE>`
waits on user approval no unattended member gets, and a `ready-for-agent`
ticket's `## Agent Brief` already is that output. Solo session has a user: run full path.

Bug reports: `superpowers:systematic-debugging` first, either row.

Report row, path, one-line why. **Process depth only** — no admissibility call
here, for anyone. Both rows workable, solo and in fleet; heavy means more process,
never blocked ticket.

Tie-break here: torn → take the heavier row. Right for process depth, **opposite** of
fleet's admissibility tie-break, where torn → surface to maintainer. Two
questions, two biases. Never carry this one across.

## Red flags

- "Body is short, so it's simple" → short bodies hide most design ambiguity. Size by unknowns, not word count.
- "Brainstorming is overkill here" → that thought is heavy row.
- "The Agent Brief is thorough, so it's light now" → brief quality never promotes
  a heavy row *for process depth*. Says nothing about admissibility — thorough
  brief is exactly what makes big ticket safe to run unattended.