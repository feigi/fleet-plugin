---
name: run-team-local
description: fleet-plugin's own self-maintenance duties after a /fleet-ctl:run-team run on this repository — role-target drift notice. Not called by run-team; this repo's AGENTS.md triggers it, or the operator runs it by hand.
disable-model-invocation: true
---

# run-team-local

fleet-plugin dogfoods its own plugin, so the duties that only maintain the
plugin live here, not in the plugin it ships. `/fleet-ctl:run-team` never calls
this skill: the repository's `AGENTS.md` rule runs it after a run, and the
operator running it by hand is the fallback. Usage metrics — the member-outcomes
scrape, the tier-outcomes appends, the ticket-features drain and the cost
guard — are the plugin's own and are not repeated here.

Run it from the main checkout, once, after a run has finished and its metrics
PR is open or merged:

```bash
node .omp/skills/run-team-local/hook.mjs
```

Every duty is `hook.mjs`, beside this file, and every duty is safe to run
again, so a missed run strands nothing: the next one catches up.

## Duties

1. **Role-target drift notice:** each `fleet-implementer-<cell>` definition's
   most recent admissible `member-outcomes.tsv` row's `model` against
   `modelRoles.<role>`'s current target, and the cell's level against the
   levels that target runs at. A `tier-roles: notice:` line is reported,
   never acted on — rows pool across resolved models (spec § 2).
   `tier-roles.mjs` only supplies the target and stays blind to the metrics.

## Reading it

One `run-team-local: <duty>: …` line per duty on stdout, plus any
`tier-roles: notice:` lines. Exit 0: every duty ran. Exit 1: the duty named on
stderr failed — fix the cause and run it again. Exit 2: a usage error.

`--repo`, `--agents`, `--model-roles` and `--catalog` point the hook at a
fixture instead of this checkout and the live omp config; `hook.mjs`'s header
says what each one defaults to.
