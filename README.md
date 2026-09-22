# fleet-ctl

The agent fleet: a `run-team` controller, a merge bot, a PR reviewer, and the
ticket pipeline they share. Ships as the Claude Code / omp plugin
`fleet-ctl@fleet-plugin`.

## Installation

Requires Node `26.5.0` (see `.nvmrc`).

**Claude Code**

```
/plugin marketplace add feigi/fleet-plugin
/plugin install fleet-ctl@fleet-plugin
```

**omp**

Plugin agents are invisible on omp without `claude-plugins` enabled — add it
before installing:

```
omp config set enabledProviders '["claude-plugins"]'
omp plugin marketplace add feigi/fleet-plugin --scope=user
omp plugin install fleet-ctl@fleet-plugin --scope=user
```

The qualified id (`fleet-ctl@fleet-plugin`) is canonical on both harnesses —
an unqualified `fleet-ctl` install is not guaranteed to resolve to this
plugin. Background: [`docs/adr/0006-rename-to-fleet-ctl.md`](docs/adr/0006-rename-to-fleet-ctl.md).

## Quickstart

Start a fleet run over the `ready-for-agent` queue — up to 5 implementers, up
to 5 reviewers, one merge bot, all optional and capped at 5:

```
/fleet-ctl:run-team [implementers] [reviewers]
```

This runs `next-ticket` (claim and size a ticket), `review-and-fix` (review a
PR, apply recommended actions, push, watch checks), and `run-merge-bot`
(rebase, wait green, merge) as one coordinated fleet. Each is also invocable
on its own:

- `/fleet-ctl:review-and-fix [pr-number]` — review a PR, apply recommended
  actions, push, watch checks until green.
- `/fleet-ctl:run-merge-bot` — merge every `ready-to-merge` open PR in
  numeric order.
- `next-ticket` / `sizing-a-ticket` skills — pick up and size the next issue
  by intent rather than number.

Run the test suite from the repo root:

```
node --test plugin/scripts/*.test.mjs
```

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — glossary: the vocabulary (claims, worktrees,
  releases, the merge gate, dispatch, tiers) this repo's artefacts share.
- [`docs/adr/`](docs/adr) — accepted architecture decisions and the
  measurements behind each one.
- [`docs/specs/`](docs/specs) — design docs for the fleet, the cockpit, the
  reviewer's read rules, and member-outcomes instrumentation.
- [`docs/agents/`](docs/agents) — how the engineering skills consume this
  repo's domain docs, plus the triage-label and issue-tracker mappings.
