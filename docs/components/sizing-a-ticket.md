# sizing-a-ticket (skill)

## What it is for

Deciding how much process a ticket needs before implementing it — never
whether the ticket is admissible at all, which is a different question
answered earlier, by [Pull & Claim](pull-and-claim.md)'s **decided?**
test or a maintainer's own pick in [next-ticket](next-ticket.md).

## How it works

[`plugin/skills/sizing-a-ticket/SKILL.md`](../../plugin/skills/sizing-a-ticket/SKILL.md)
reads the ticket (`## Agent Brief` outranking the body) and sorts it into
one of two rows: **light** — the brief states exactly what to change,
touches one or two files, and carries no open design choice — routes to
a test-driven-development path; **heavy** — ambiguity in *what* to
build, three or more files, a new API/schema/UX, or several viable
approaches — routes through a brainstorming-and-writing-plans path
first. The tie-break is deliberately asymmetric: a torn call surfaces to
the maintainer to decide elsewhere ([Pull & Claim](pull-and-claim.md)'s
own fork-vs-relabel decision), but once a fleet member is actually
implementing, "torn" takes the **heavier** row rather than escalate
mid-work, because more process is the safer over-commitment and a solo
session has already cleared its one human-approval gate at admission.

## Opinionated choices

This skill decides process depth only, and is invoked fresh at the same
point regardless of caller — an unattended implementer and a
maintainer's `next-ticket` session both reach it the same way, so the
fleet's own admissibility bar (**decided?**) and this skill's own bar
(light vs. heavy) never get to disagree about the same axis. A thorough
Agent Brief is itself evidence for *light*, not proof against
unattended work — brainstorming overkill on a well-specified ticket is
its own named red flag, and the framework refuses to let brief quality
alone promote a ticket to heavy.
