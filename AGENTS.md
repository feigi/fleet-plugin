## Agent skills

### Triage labels

Label string equals role name for all five roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. Both exist here. See `docs/agents/domain.md`.

## Shipped surface

Shipped files (`plugin/`) cite no issue, PR, ADR, repo-internal `docs/`
record path (`adr`/`specs`/`research`/`agents`/`requirements`) or test
file — state the claim instead; provenance lives in git history. See ADR
0019 and `CONTEXT.md`'s **Shipped surface**.

## Incident policy

A member-reliability incident closes with a script, a schema field, a tick row
or a brief template line, in that order of preference; prose only for a judgement.
See `docs/agents/incident-policy.md`.

## Runs on this repo

After a `/fleet-ctl:run-team` run on this repository, run the `run-team-local`
skill (`read skill://run-team-local`): the plugin never calls it, so this rule
is what triggers it. It is repeatable, so a missed run strands nothing.

Run artifacts follow this repo's own convention, which the plugin does not
mandate: the metrics PR goes on `chore/run-artifacts-<date>` (a letter suffix
when that date already has one, `chore/run-artifacts-2026-08-23b`), and data
rows and rule-doc prose never share a PR — one branch each. The halves have
opposite cost profiles: a stranded data row is lost (the member-outcomes
scrape is regenerated from harness transcripts we do not own), while a
stranded rule change only costs the status quo, but is expensive to review.
Bundled, the cheap half gates the expensive one. So the metrics branch carries
the `docs/metrics/` files and nothing else, and prose that wants review goes
on its own branch with its own PR.

## ADR amendments

An accepted ADR's body stays as ruled. A later change that falsifies or closes
something it states is recorded on its `**Status:**` line as `Amended by #N: …`
(the issue) or `Amended by ADR NNNN: …`.
