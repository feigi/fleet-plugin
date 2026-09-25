# fleet-ctl

The agent fleet: a `run-team` controller, a merge bot, a PR reviewer, and the
ticket pipeline they share. Ships as the Claude Code / omp plugin
`fleet-ctl@fleet-plugin`.

## Installation

Shipped scripts run under your own `node`. `.nvmrc` pins the dev/CI runtime
the suite is verified against, not a floor
([ADR 0010](docs/adr/0010-the-node-pin-stays-exact-and-a-bot-moves-it.md)).

Supported platforms: macOS, Linux, and Windows via WSL. Native Windows is not
supported ([ADR 0009](docs/adr/0009-supported-platforms-are-macos-linux-wsl.md)).

Claude Code clones the marketplace over SSH; omp clones the marketplace
shorthand over HTTPS.

**Claude Code**

```
/plugin marketplace add feigi/fleet-plugin
/plugin install fleet-ctl@fleet-plugin
```

**omp**

Two settings are session-wide, install-time preconditions on omp (ADR 0003
point 8, ADR 0011) — plugin agents are invisible without the first, and the
fleet's `opus`/`sonnet`/`haiku` tiers resolve to nothing without the second:

```
omp config get enabledProviders          # inspect first: the next line REPLACES the whole list
omp config set enabledProviders '["claude-plugins"]'   # merge in any providers you already had enabled
omp plugin marketplace add feigi/fleet-plugin --scope=user
omp plugin install fleet-ctl@fleet-plugin --scope=user
omp config set task.agentModelOverrides "$(~/.fleet/bin/fleet-run tier-roles.mjs --json --merge)"   # set REPLACES the whole record: --merge keeps your own non-fleet overrides; re-run after every plugin update
~/.fleet/bin/fleet-run tier-roles.mjs --check
```

On omp, `model: opus|sonnet|haiku` in a fleet agent definition is a tier name
routed to `modelRoles.slow|task|smol` (ADR 0011), never a vendor model
directly — set those roles to whatever models this install has before a run.

The qualified id (`fleet-ctl@fleet-plugin`) is canonical on both harnesses —
an unqualified `fleet-ctl` install is not guaranteed to resolve to this
plugin. Background: [`docs/adr/0006-rename-to-fleet-ctl.md`](docs/adr/0006-rename-to-fleet-ctl.md).

## Quickstart

Start a fleet run over the `ready-for-agent` queue — implementers and reviewers
(both optional, default 2 and 6, no hard cap), plus one
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

## How it works

`/fleet-ctl:run-team` is a **controller** running in your own main thread —
never a subagent — that drives three short-lived, fresh-context member roles
over one repo's ticket queue. Standalone commands (`review-and-fix`,
`run-merge-bot`, the `next-ticket` skill) are the same roles run one
ticket/PR at a time, with no controller above them. Full design rationale:
[`docs/specs/2026-07-22-run-team-agent-fleet-design.md`](docs/specs/2026-07-22-run-team-agent-fleet-design.md).

**Controller loop** (phase 0 → 3, repeating until the queue drains):

1. **Shortlist** — `shortlist.mjs` scans `ready-for-agent` issues oldest
   first and drops anything with an unresolved dependency, already in flight
   (open PR, remote branch, or local worktree), or excluded behind an open PR
   or issue. No human approves it: supply is automatic. The fleet never
   touches `ready-for-human` work — there's no channel back to a human
   mid-run.
2. **Pull** — each free implementer slot admits the shortlist's head the
   moment it frees: one full read of the ticket, then either a relabel by
   cause (`needs-triage`, `ready-for-human`), an exclusion behind the PR or
   issue it collides with, or a claim — serially, in the main checkout: label
   the issue `in-progress`, `git worktree add` a dedicated tree.
3. **Dispatch** — each Pull dispatches one implementer in the background, a
   brand-new agent (never a resumed one — that would drag the previous
   ticket's context into this one); every 5th Pull runs at the alternate
   tier.
4. **Event loop** — react without blocking: an implementer's PR gets queued
   for review; a free review slot picks up the next queued PR; a reviewer
   that lands the `ready-to-merge` label dispatches a merge-bot pass; the tick
   refreshes the shortlist as it runs low.

**Reviewer fan-out** — each reviewer cuts a read-only snapshot, sizes the PR,
and dispatches the applicable subset of six specialist agents in parallel
(`fleet-review-correctness`, `-comments`, `-silent-failure`, `-tests`,
`-types`, `-simplify` — correctness always runs, the rest scale to what the
diff actually touches). A verifier adversarially tries to refute every
`critical`/`important` finding before it's trusted; `suggestion`-severity
findings get no verifier by policy and are the reviewer's own job to check.
Confirmed findings in scope get applied, pushed, and waited to CI-green
before the PR is labelled `ready-to-merge`.

**Merge bot** — one pass, at most one bot at a time: for each
`ready-to-merge` PR in numeric order, hold if a lower-numbered open PR
touches related work, otherwise rebase onto `main`, wait for CI green, merge
only on `merge-gate.mjs`'s second exit 0; then a 15-minute grace for late
labels and one report.

```mermaid
flowchart TD
    subgraph CTL["Controller — main thread, /fleet-ctl:run-team"]
        P0["Phase 0: shortlist.mjs<br/>candidate scan, dependency scan,<br/>in-flight check, minus exclusions"]
        P1["Phase 1: Pull<br/>read, judge, relabel or exclude or claim"]
        P2["Phase 2: dispatch one implementer<br/>(fresh context, per Pull)"]
        P3{"Phase 3: event loop"}
        P0 --> P1 --> P2 --> P3
        P3 -->|"slot free"| P1
        P3 -->|"shortlist low: tick refreshes"| P0
    end

    P2 --> IMPL["Implementer<br/>size + implement ticket, push, gh pr create"]
    IMPL -->|"reports PR + head SHA"| P3
    P3 -->|"PR queued, review slot free"| REV

    subgraph REVFAN["Reviewer — up to M, fresh context each"]
        REV["Snapshot: diff-stats.mjs<br/>selects applicable specialist dimensions"]
        SPEC["Specialists, parallel:<br/>correctness / comments / silent-failure<br/>tests / types / simplify"]
        VERI["Verifier: refutes every<br/>critical / important finding"]
        FIX["Apply in-scope fixes, push,<br/>wait CI green, label ready-to-merge"]
        REV --> SPEC --> VERI --> FIX
    end
    FIX -->|"ready-to-merge label"| P3
    P3 -->|"label seen"| MB["Merge-bot pass dispatched"]

    subgraph MERGEBOT["Merge bot — at most 1, one pass"]
        HOLD["Hold rule: pr-overlap.mjs vs<br/>every lower-numbered open PR"]
        REBASE["Rebase onto main"]
        GREEN["Wait CI green, merge-gate.mjs twice"]
        MERGE["Merge"]
        WAIT["Hold behind #lower PR,<br/>watcher retries later"]
        HOLD -->|"unrelated"| REBASE --> GREEN --> MERGE
        HOLD -->|"related"| WAIT
    end
    MB --> HOLD
    MERGE --> P3
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

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
