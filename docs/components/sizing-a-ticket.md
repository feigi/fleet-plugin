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
     open design choice → test first, make the one change, run it with the
     repo's test runner.
   - **heavy** — ambiguity in *what* to build, three or more files, a
     new API/schema/UX, or several viable approaches → write a short plan,
     then carry it out inline, test first.
3. **Break ties toward heavy.** A torn call surfaces to the maintainer
   to decide elsewhere; once a fleet member is actually implementing,
   "torn" takes the heavier row rather than escalate mid-work.

## Opinionated choices

- **Process depth only — never admissibility.** This skill is invoked
  fresh at the same point regardless of caller, so the fleet's
  admissibility bar and this skill's light/heavy bar never get to
  disagree about the same axis.
- **A thorough Agent Brief never turns a heavy ticket light.** Brief
  quality says nothing about process depth — it is what makes a big
  ticket safe to run unattended, an admissibility fact, not a sizing
  one. "A plan is overkill here" is itself a named red flag for the
  heavy row.
