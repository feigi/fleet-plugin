# Tier routing

## What it is for

Deciding which model tier builds a given ticket, and proving after the
fact that the harness actually ran it there. This is the model/effort
routing layer underneath the [Implementer](implementer.md) role.

## How it works

Every fleet agent declares a **Declared tier** in its own frontmatter —
`model: "@<role>:<level>"` — never a vendor model name; `@slow`, `@task`,
`@smol` are fleet tier routes, resolved through the operator's
`modelRoles.<role>` install-time config (an install with no Anthropic
model still runs the fleet), and the `:<level>` suffix is the only
per-agent lever ([ADR 0011](../adr/0011-omp-tier-routes-through-roles.md)).
Today, [`fleet-implementer.agent.md`](../../plugin/agents/fleet-implementer.agent.md)
declares `@slow:high`; [`fleet-implementer-alt.agent.md`](../../plugin/agents/fleet-implementer-alt.agent.md)
declares `@task:high`; the controller dispatches `-alt` on every 5th
Pull, counted off `.fleet/ledger.md`'s own `impl-` rows, as a running,
unconfounded A/B comparison.
[`plugin/scripts/tier-roles.mjs`](../../plugin/scripts/tier-roles.mjs)
statically validates that config (`--check`): every role a definition
uses resolves to a `modelRoles.<role>` entry, and no leftover per-agent
override survives.
[`plugin/scripts/tier-check.mjs`](../../plugin/scripts/tier-check.mjs) is
the dispatch-time half: it reads back what the harness actually resolved
for a member — `session_init.resolvedModel` plus
`thinking_level_change.thinkingLevel`, never the frontmatter — and
compares it against the Declared tier; a mismatch exits non-zero and the
controller holds the next Pull (`HOLD (tier mismatch impl-<N>)`) until a
corrected redispatch clears it. A rate guard over
`docs/metrics/tier-outcomes.tsv` runs at every alternate-tier Pull and
reverts the A/B pairing back to a single tier if the alternate's own
floor and trigger conditions fire.

## Opinionated choices

Tier is a version-controlled fact, not a runtime decision: the agent
file's own frontmatter is the recorded intent, so there is no config a
run could change mid-flight and no per-agent override record to drift
from it ([ADR 0005](../adr/0005-tier-declared-per-harness-verified-at-dispatch.md)).
Declaring and verifying are two separate, narrow checks — a static shape
check over the agent files, and a dispatch-time readback compare —
deliberately never a single "trust the frontmatter" step, because a
member dispatched with an explicit `model` override on the call was
measured to silently *not* get the declared tier back. The **Cell** /
**Router** / **Admissible row** model-effort-router design
([`docs/specs/2026-09-28-model-effort-router-design.md`](../specs/2026-09-28-model-effort-router-design.md),
[ADR 0016](../adr/0016-per-ticket-model-effort-routing.md)) is decided
but **not yet built** — today's routing is the flat every-5th-Pull rule
above, not a per-ticket table; treat the router spec as the planned
successor, not the current mechanism.
