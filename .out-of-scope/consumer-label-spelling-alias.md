# Honouring A Consumer's Alternate Spelling Of A Fleet Label

The fleet reads a fixed set of label strings, and `docs/requirements.md`
section 2.4 tells a consumer repo to create exactly those. We don't accept an
alias, a configurable set or a guard in `claim-ticket.sh` that makes a second
spelling count, such as `on-hold` for `onhold`.

## Why this is out of scope

**The requirement is documented and hard.** The consumer pre-flight lists
`onhold` as "Excluded from Shortlist", says "Create these exact strings", and
ships a check loop that prints `missing: onhold` for a repo that only has
`on-hold`. `candidates.mjs` already drops `-label:onhold` from the shortlist.
A consumer that skipped the check has a setup fault, not a fleet defect.

**Every fix is a new surface for one non-conformant repo.** An alias or a
configurable freeze set adds a place a label name can disagree with the
documentation. ADR 0019 argues against hard-coding a consumer's spelling in
shipped code, and a guard in `claim-ticket.sh` would do exactly that.

## What would reopen this

A second consumer that cannot rename its label, with a reason the pre-flight
check does not already cover. The remedy then is a ruling on a configurable
label set, with its own ticket.

## Prior requests

- #2883 — "fleet-ctl: shortlist ignores on-hold — tick PULLs maintainer-frozen tickets (ready-for-agent + on-hold coexist)"
