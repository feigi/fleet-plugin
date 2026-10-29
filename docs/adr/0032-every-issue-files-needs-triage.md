# 0032 — Every issue the plugin creates is filed `needs-triage`

**Status:** Accepted. Ruled 2026-10-13 on #3171 by the maintainer, from a
grilling session on #2878. Supersedes ADR 0001.

## Context

ADR 0001 set the filing-time label bar to *is the defect confirmed*: a
confirmed defect whose remedy is still open files `ready-for-agent`, with the
openness named in the body. A confirmed defect says nothing about how it
should be fixed, so these tickets reach the fleet's pool without a settled
remedy. The Pull's **decided?** gate does not relabel them: per the #3171
ticket, a persistent ~18-ticket subset of `ready-for-agent` sat with
self-reported open remedy forks, silently re-excluded every wave, until a
manual sweep on 2026-09-21 relabelled 13 of them `ready-for-human`. Those are
the ticket's figures; this record does not re-derive them.

## Decision

**Every issue the plugin creates is filed `needs-triage`. Only triage sets
`ready-for-agent`.** This applies to both filing sites: `review-and-fix.md`
step 5, and run-team finisher duty 2, which files the way step 5 does.

- **Body:** a filed issue carries the evidence triage needs — the refuter's
  verdict (the `verdictPath` reason, or the review's votes) and the candidate
  remedy.
- **Duplicates:** step 5's relabel-up rule becomes comment-only — cite the
  refuters' verdict on the existing issue and change no label. Never relabel
  down.
- **Satisfaction:** an existing open `ready-for-agent` issue still answers a
  `needs-triage` filing row, because triage already promoted it.
  `TRIAGE_ROLES` ordering stays; only the filing rows' required label
  changes — rows 1, 5 and 8 of `dispositions-check.mjs`'s `FILING_ROWS`, the
  rows that required `ready-for-agent`.
- **Migration:** relabel open review-filed issues (`Deferred from PR` in the
  body) labelled `ready-for-agent` whose body states the remedy is open →
  `needs-triage`. Issues stating a concrete remedy stay.

Phase 0's **decided?** bar, the consumption-time seat ADR 0001 left
unchanged, stays unchanged here too.

## The guard — floor and trigger, chosen before any data

- **Floor:** more than **40** open `needs-triage` issues citing
  `Deferred from PR` in the body.
- **Trigger:** above the floor on **3 consecutive** run dates.
- **Then:** the maintainer revisits — batch triage, a fleet triage role, or a
  different bar.

ADR 0001's own history is the risk this guards: by that record's figures
`needs-triage` went from 11 to 135 under the bar ADR 0001 replaced.

## Consequences

- A confirmed defect with an open remedy files `needs-triage`; triage, not
  the filer, decides whether it reaches the fleet's pool.
- The maintainer's `needs-triage` queue absorbs the review path's output
  again, which is what the guard watches.
- A duplicate finding never changes an existing issue's label; a
  `ready-for-agent` issue triage already promoted stays promoted.
