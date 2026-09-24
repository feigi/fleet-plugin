# 0005 — Tier is declared per harness in the definition and verified at dispatch

**Status:** Accepted. Ruled 2026-09-09 on #1298, #1302, #1303, #1314, against the measurements below. Amended by ADR 0011: on omp the bare alias is a fleet tier name routed through a role, not a vendor model selector.

## Context

`agents/fleet-implementer.agent.md` declared `model: opus` and
`effort: xhigh`; omp does not read `effort:` as this repo's meaning and
preserves unknown frontmatter keys rather than rejecting them, so a member
could load clean and silently run at the wrong tier (#1298). Measured
2026-09-09, omp 18.1.14/15 and Claude Code 2.1.265, on the real installed
`fleet-implementer`:

- **The premise was half wrong.** Dispatching the installed agent resolved
  `anthropic/claude-opus-5`; `fleet-implementer-alt` (`model: sonnet`)
  resolved `anthropic/claude-sonnet-5` — bare Claude model aliases *do*
  resolve on omp. What falls through silently is `effort:` alone: both
  agents declared `xhigh` and both ran at `high`, this box's
  `defaultThinkingLevel`.
- **The declared level survives when pinned under the right key.** A/B on the
  same model: `thinking-level: xhigh` in frontmatter produced an on-disk
  `thinking_level_change` event of `{"thinkingLevel":"xhigh"}` and a live
  `resolvedModel` of `…:xhigh`; no `thinking-level:` key produced `high` (the
  default). But `session_init.resolvedModel`'s `:suffix` only appears when
  resolution passed through a `modelRoles.<role>` alias baking in a level — a
  plugin agent resolving off its own frontmatter `model:`, this fleet's exact
  shape, writes no suffix. The durable record of the effective level is the
  `thinking_level_change` event, present once per subagent transcript in 6/6
  samples — correcting #1295, which named the suffix as the recoverable
  signal (#1302).
- **Per-call overrides are silently dropped.** `agent(prompt, {model:"haiku",
  effort:"low"})` resolved to the identical `anthropic/claude-sonnet-5:high`
  as the baseline — zero effect. `agent(prompt, {agent:"fleet-probe-slow"})`
  resolved `claude-opus-5:high` — the definition's own frontmatter is the
  only tier lever that works (#1303).
- **Bare-name dispatch collides.** omp's agent lookup is exact and
  unnamespaced (`agents.find(a => a.name === name)`); the vendored
  `pr-review-toolkit:code-reviewer` literal is rejected outright on omp, and
  two vendored plugin caches already ship a bare-named `code-reviewer.md`,
  with the winner decided by `installed_plugins.json` registration order —
  not a rule anyone would design against (#1303).
- **No load-time hook exists on either harness** a plugin can run a check
  from — no `hooks/` here, Claude's hook plugin-root is measured wrong for
  this install shape, omp has no plugin hooks documented (#1298).

## Decision

1. **Every fleet agent definition declares its thinking level explicitly, for
   both harnesses**, side by side in the same frontmatter: `effort:` for
   Claude, `thinking-level:` for omp. `auto` never applies to a fleet member.
2. **Two verification layers, each asserting only what it can see.**
   - **Layer 1 — CI, static shape**, over the agent/skill/command files
     (#1314's allow-list checker): required keys `name`, `description`,
     `model`, `effort`, `thinking-level`; `model` restricted to the bare
     alias set `{opus, sonnet, haiku}` — the one spelling measured to
     resolve on both harnesses; `effort` and `thinking-level` restricted to
     each harness's value set (`auto`/`off` rejected); forbidden keys
     include `thinking` (the omp alias — one spelling only), `prewalk`,
     `advisor` (silent mid-run model hand-off), `isolation` (#1315: members
     never use harness isolation), and Claude keys documented as ignored for
     plugin subagents (`permissionMode`, `mcpServers`, `hooks`).
   - **Layer 2 — dispatch time, per member, both harnesses**, resolved tier.
     The controller reads the member's tier back from the harness's own
     record and compares it with the declaration; on mismatch it stops the
     wave and names the pair. Readback: Claude `agent-<id>.jsonl` → `model`,
     `effort`; omp → `session_init.resolvedModel` identity plus
     `thinking_level_change.thinkingLevel` (never the `:suffix`).
3. **The reader records what the harness wrote, never the frontmatter** —
   `thinking_level_change.thinkingLevel` on omp, `d.effort` on Claude. That
   is what makes declared-versus-resolved comparison meaningful: declared
   lives in the definition, resolved lives in the transcript, produced by
   different parties.
4. **The adapter is one module, one per-member record, two readers chosen by
   the tree walked**, not by content-sniffing: a transcript under
   `~/.claude/projects/` selects the Claude reader, under
   `~/.omp/agent/sessions/` selects the omp reader. A `harness` column is
   added to `member-outcomes.mjs`'s TSV explicitly — nothing existing can be
   repurposed as a detector.
5. **The port passes no `model`/`effort` on any `agent()` call.** Every
   review call site dispatches a fleet-owned, `fleet-`-prefixed, bare-named
   definition whose frontmatter carries the tier for both harnesses. This is
   also the only shape layer 2 can verify.
6. **The six vendored `pr-review-toolkit` specialists are replaced with
   fleet-owned definitions** (`fleet-review-<dimension>` ×6, plus
   `fleet-review-snapshot` and `fleet-review-verifier`), dual-key tiers,
   bare-alias models, on both harnesses — closing the tier-fallthrough and
   the bare-name collision at once.

## Rejected alternatives

- **Recording intent at dispatch time into the ledger** (effort-policy
  candidate 2). Not needed for fleet agents: the version-controlled
  definition already *is* the recorded intent.
- **Accepting a hole in the omp column of the board** (effort-policy
  candidate 3). Applies only to non-fleet members; the adapter writes
  `thinking` as `-` for them so the hole is visible rather than silent,
  rather than accepting it project-wide.
- **A preflight that verifies eval's per-call `model`/`effort` overrides.**
  Impossible — eval deletes them before anything is written
  (`agentArgsSchema`'s `'+': 'delete'`). The honest check is a static lint
  asserting no `agent(` call in the review core carries `model`/`effort`,
  not a runtime preflight.
- **Keeping the vendored `pr-review-toolkit` specialists and accepting the
  omp fallthrough.** They would run at the parent's model with default
  thinking, the preflight could only warn (a mismatch the fleet cannot
  fix), and the bare-name winner would depend on the operator's
  `enabledPlugins` — exactly the silent-tier shape the map forbids, made
  loud-but-unfixable rather than closed.
- **Fleet-owned specialists on omp only, vendored on Claude.** Rejected: the
  two prompt sets would diverge over time, reopening #1299's divergence
  problem in a second instance.
- **A plugin-load-time verification layer.** Unavailable — neither harness
  exposes a load-time hook a plugin can run a check from.

## Consequences

- `implementer-model-tier.test.mjs` extends to cover the agent files'
  required keys, alias spelling, and per-wave model pairing; the
  dispatch-time readback compare is a new instrument living with the
  adapter, invoked from run-team's phase 2 as a scripted step rather than a
  prose instruction, because prose asking a controller to "verify the tier"
  was measured not to happen.
- `thinking_level_change.configured` was `null` in every sample; its
  semantics are unmeasured and no check depends on it.
- Today's tree fails the agents allow-list on missing `thinking-level` until
  the two-line frontmatter addition lands — the gate's first real red, and
  the correct answer.
- The six vendored specialist prompts move into this repo; upstream
  improvements from `pr-review-toolkit` stop arriving automatically.
- Work is filed downstream: #1342 (adapter + readers + harness column),
  #1343 (pin `thinking-level:` beside `effort:`), #1345 (dispatch-time tier
  check), #1349 (fleet-owned review specialists, blocked on #1336).
