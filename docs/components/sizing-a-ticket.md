# sizing-a-ticket (skill)

## What it is for

Deciding how much process a ticket needs before implementing it — never
whether the ticket is admissible at all, which is answered earlier by
[Pull & Claim](pull-and-claim.md)'s **decided?** test or a maintainer's
own pick in [next-ticket](next-ticket.md).

## How it works
1. **Read the ticket** (`## Agent Brief` outranks the body).
2. **Sort into one of two rows:**
   - **light** — states exactly what to change, one or two files, no
     open design choice → routes to a test-driven-development path.
   - **heavy** — ambiguity in *what* to build, three or more files, a
     new API/schema/UX, or several viable approaches → routes through
     brainstorming-and-writing-plans first.
3. **Break ties toward heavy.** A torn call surfaces to the maintainer
   to decide elsewhere; once a fleet member is actually implementing,
   "torn" takes the heavier row rather than escalate mid-work.

## Opinionated choices

- **Process depth only — never admissibility.** This skill is invoked
  fresh at the same point regardless of caller, so the fleet's
  admissibility bar and this skill's light/heavy bar never get to
  disagree about the same axis.
- **A thorough Agent Brief is evidence for *light*, not proof against
  unattended work.** Brainstorming overkill on a well-specified ticket
  is its own named red flag; brief quality alone never promotes a
  ticket to heavy.
