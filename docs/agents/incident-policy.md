# Incident policy

A member-reliability incident closes with a mechanism, not a paragraph in the
runbook. This page says what counts as one, in what order a closing mechanism
is preferred, and what the ticket for one carries.

## What a member-reliability incident is

A member (an implementer, fixer, finisher, reviewer or merge-bot the
controller dispatched) did, or failed to do, something the run depends on, and
the controller could not tell from its own state. Four shapes, one tracker
example each:

- **A duty skipped.** #2331: `fleet-finisher` skipped duty 3 (adding
  `ready-to-merge`) and reported `labelled` anyway, in two of five PRs of one
  pass.
- **A report lost.** The measurement in
  `plugin/skills/run-team/references/member-lifecycle.md`'s **A missing report
  is not evidence the member failed to send one**: a finisher completed every duty, labelled the
  PR and sent its report; the send was accepted with a msg_id and never
  arrived, and the controller read the silence as the member ending its turn
  without reporting.
- **A step run out of order or twice.** #3047: nothing refused a second
  in-flight review of one PR, so a controller-restart identity mix-up put two
  review runners on one PR at the same head.
- **A brief missing, or contradicting, a line.** #2884: the fixer's duty list
  assigned the CI wait to a member, while the runbook said the controller owns
  it, so a member that obeyed the one parked for hours and a member that
  obeyed the other stopped with later duties unowned.

## How an incident closes

In order of preference:

1. **A script that refuses or does the duty.** The `finisher-label.mjs` shape:
   the member runs one command, and the command refuses (a nonzero exit naming
   what it found, nothing written) or performs the duty and reads its own write
   back. The duty cannot be skipped or mis-ordered because the member never
   performs it by hand.
2. **A schema field a settle checks.** The member's report is a structured
   file; the field the incident says went missing is a required field, and the
   settle refuses a report without it.
3. **A tick row or hold.** The tick names the condition from ledger state and
   tells the controller the one command to run, or holds the dispatch until it
   is met.
4. **A brief template line.** The brief template for that member carries the
   line, so it is in every dispatch prompt rather than in a paragraph the
   member may not read.

Prose in `run-team/SKILL.md` closes an incident only when the action is a
judgement no script can take. The prose then states the judgement and nothing
else: no war story, no "measured:" paragraph. Evidence of how the incident went
belongs in `plugin/skills/run-team/references/`, keyed by the rule it
justifies.

## What an incident ticket carries

A `Mechanism:` line in its body, naming which of the four it proposes
(`script`, `schema field`, `tick row`, `brief line`), or `judgement` followed by
the question the controller must answer. A ticket for an incident without a
`Mechanism:` line is `needs-triage`; see `docs/agents/triage-labels.md`.

## Where the policy comes from

The policy was introduced by the six 2026-10-13 specs, which close incidents
with code and share this page as their rule:

- #3177, rendered member briefs
- #3178, run boundaries as drivers
- #3179, structured member reports
- #3180, one command per wake
- #3181, the Pull as a driver
- #3182, runbook diet and incident policy, whose § D4 is this page
