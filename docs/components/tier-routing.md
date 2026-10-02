# Tier routing

## What it is for

Deciding which model tier builds a given ticket, and proving after the
fact that the harness actually ran it there — the model/effort routing
layer underneath the [Implementer](implementer.md) role.

## How it works
1. **Declare.** Every fleet agent declares a **Declared tier** in its
   frontmatter — `model: "@<role>:<level>"`, never a vendor name.
   `@slow`/`@task`/`@smol` are fleet tier routes, resolved through the
   operator's `modelRoles.<role>` config, so an install with no
   Anthropic model still runs the fleet
   ([ADR 0011](../adr/0011-omp-tier-routes-through-roles.md)).
2. **Route.** Today, `fleet-implementer.agent.md` declares `@slow:high`;
   its alt sibling declares `@task:high`; the controller dispatches
   `-alt` on every 5th Pull (counted off `.fleet/ledger.md`'s `impl-`
   rows) as a running, unconfounded A/B comparison.
3. **Check statically.**
   [`tier-roles.mjs`](../../plugin/scripts/tier-roles.mjs) `--check`
   validates that every role a definition uses resolves to a
   `modelRoles.<role>` entry, with no leftover per-agent override.
4. **Verify at dispatch.**
   [`tier-check.mjs`](../../plugin/scripts/tier-check.mjs) reads back
   what the harness resolved — `session_init.resolvedModel` plus
   `thinking_level_change.thinkingLevel`, never the frontmatter — and
   compares it to the Declared tier; a mismatch holds the next Pull
   (`HOLD (tier mismatch impl-<N>)`) until a corrected redispatch
   clears it.
5. **Record the outcome.** When the controller rules an implementer
   PR's review it appends one row for that PR to
   `docs/metrics/tier-outcomes.tsv` (`tier-outcomes.mjs append`).
   Nothing concludes inside a run and nothing reverts a tier
   automatically: the rows accumulate across runs for a later comparison.

## Opinionated choices

- **Tier is a version-controlled fact, not a runtime decision.** The
  agent file's own frontmatter is the recorded intent — no config a run
  could change mid-flight, no per-agent override to drift from
  ([ADR 0005](../adr/0005-tier-declared-per-harness-verified-at-dispatch.md)).
- **Declaring and verifying are two separate, narrow checks** —
  deliberately never one "trust the frontmatter" step, because a
  member dispatched with an explicit `model` override on the call was
  measured to silently *not* get the declared tier back.
- **Cell/Router/Admissible row are decided but not yet built.** The
  model-effort-router design
  ([`docs/specs/2026-09-28-model-effort-router-design.md`](../specs/2026-09-28-model-effort-router-design.md),
  [ADR 0016](../adr/0016-per-ticket-model-effort-routing.md)) is the
  planned successor to today's flat every-5th-Pull rule, not the
  current mechanism.
