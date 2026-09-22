# fleet-ctl

The agent fleet: a `run-team` controller, a merge bot, a PR reviewer, and the
ticket pipeline they share. Ships as the Claude Code / omp plugin
`fleet-ctl@fleet-plugin`.

## Installation

Pinned dev/CI Node version: `26.5.0` (see `.nvmrc`) — not an enforced floor;
the suite also runs clean on newer Node.

This repo is private: Claude Code clones it over SSH (needs a key with repo
access); omp clones the marketplace shorthand over HTTPS (needs a configured
git credential helper, e.g. `gh auth setup-git`).

**Claude Code**

```
/plugin marketplace add feigi/fleet-plugin
/plugin install fleet-ctl@fleet-plugin
```

**omp**

Two settings are session-wide, install-time preconditions on omp (ADR 0003
points 8–9) — plugin agents are invisible without the first, and
`run-team`'s implementer dispatch pool can't open without the second:

```
omp config get enabledProviders          # inspect first: the next line REPLACES the whole list
omp config set enabledProviders '["claude-plugins"]'   # merge in any providers you already had enabled
omp config set eval.workpool.freshAgents true
omp plugin marketplace add feigi/fleet-plugin --scope=user
omp plugin install fleet-ctl@fleet-plugin --scope=user
```

The qualified id (`fleet-ctl@fleet-plugin`) is canonical on both harnesses —
an unqualified `fleet-ctl` install is not guaranteed to resolve to this
plugin. Background: [`docs/adr/0006-rename-to-fleet-ctl.md`](docs/adr/0006-rename-to-fleet-ctl.md).

## Quickstart

Start a fleet run over the `ready-for-agent` queue — up to 5 implementers and
up to 5 reviewers (both optional, default 5, capped at 5), plus one
non-configurable merge bot:

```
/fleet-ctl:run-team [implementers] [reviewers]
```

`run-team` is invoke-only and hidden from both harnesses' `/` picker — type
the command above exactly rather than selecting it; if it doesn't show up,
`/fleet-ctl:run-team-help` prints the exact invocation for you.

This runs `next-ticket` (claim and size a ticket), `review-and-fix` (review a
PR, apply recommended actions, push, watch checks), and `run-merge-bot`
(rebase, wait green, merge) as one coordinated fleet. Each is also invocable
on its own:

- `/fleet-ctl:review-and-fix [pr-number]` — review a PR, apply recommended
  actions, push, watch checks until green.
- `/fleet-ctl:run-merge-bot` — merge every `ready-to-merge` open PR in
  numeric order.
- `next-ticket` skill — pick a ready ticket by intent rather than number,
  implement it, and open a PR rebased on `origin/main`.
- `sizing-a-ticket` skill — decide how much process a ticket needs before
  implementing it.

Run the test suite from the repo root — the glob only expands there, and a
wrong directory silently exits 0 with zero tests run:

```
node --test plugin/scripts/*.test.mjs
```

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — glossary: the vocabulary (claims, worktrees,
  releases, the merge gate, dispatch, tiers) this repo's artefacts share.
- [`docs/adr/`](docs/adr) — accepted architecture decisions and the
  measurements behind each one.
- [`docs/specs/`](docs/specs) — design docs including the fleet, the
  cockpit, the reviewer's read rules, and member-outcomes instrumentation.
- [`docs/agents/`](docs/agents) — how the engineering skills consume this
  repo's domain docs, plus the triage-label and issue-tracker mappings.
