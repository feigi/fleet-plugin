# 0011 — On omp the tier alias routes through a role, never a vendor model

**Status:** Accepted. Ruled 2026-09-24, against the measurements below.

## Context

`agents/*.agent.md` declares `model: opus|sonnet|haiku` — a bare vendor alias
(ADR 0005). On Claude Code that alias IS the model, resolved directly. On omp
the same `model:` key is read as a fuzzy model selector against whatever
models the install actually has configured; on an install with no Anthropic
model available, dispatching a fleet definition fails preflight outright
rather than resolving to some other family, silently or otherwise. Both
harnesses read the identical frontmatter key, so the definition cannot spell
a harness-specific model without reopening ADR 0004's one-tree rule.

omp's own lever for this case is roles: `modelRoles.slow/task/smol` (plus
further operator-named roles) are each a model identity, `@<role>` is an
alias that resolves to whatever that role currently points at, and
`task.agentModelOverrides[agentName]` is model-precedence #1 for task/eval
dispatch — it wins over every other selector, including the definition's own
frontmatter, before the session's default model is ever consulted.

Measured 2026-09-24, omp 18.3.0, on this box:

- `omp config get modelRoles --json` returns the whole record —
  `{"key":"modelRoles","value":{"default":"…","slow":"…","task":"…",
  "smol":"anthropic/claude-haiku-4-5:auto",…},"type":"record"}`. Dotting a
  single role into the key (`modelRoles.slow`) answers `Unknown setting`, so
  a role can only be read by fetching the whole record.
- `smol` carried its own baked suffix, `anthropic/claude-haiku-4-5:auto` — a
  role value is not bare. `omp://models.md` documents that an explicit
  suffix on the REFERRING alias wins over the role's own baked one, so
  `@smol:low` beats `@smol`'s baked `:auto`.
- `task.agentModelOverrides` accepts a JSON object read back verbatim by
  `omp config get task.agentModelOverrides --json`; nothing here writes it —
  every write in this port is the operator's, at install time (ADR 0003
  points 8–9 already establish that discipline for the other two
  install-time preconditions).
- `omp config set task.agentModelOverrides '<json>'` REPLACES the whole
  record, never merges into it: a set of `{"mine":…}` followed by a set of
  `{"fleet-a":…}` reads back as `{"fleet-a":…}` alone. An empty value is
  refused (`Invalid record JSON`) without writing.

## Decision

1. **A fixed map, one place.** `opus`->`slow`, `sonnet`->`task`,
   `haiku`->`smol` (`tier-roles.mjs`'s `OMP_ROLE_FOR_MODEL`). An operator
   wanting a different target model changes `modelRoles`, never this map.
2. **On omp the alias is a fleet tier NAME, not a vendor model.** Dispatching
   `fleet-implementer` (`model: opus`) is asking omp to run it at whatever
   `modelRoles.slow` currently points at — the alias no longer promises
   `anthropic/claude-opus-*` at all, by design: the whole point is that an
   install with no Anthropic model configured still runs the fleet, at
   whatever tier the operator assigned each role.
3. **The derived `task.agentModelOverrides` block is the third
   install-time precondition** (CONTEXT.md § Install), operator-set, fleet-
   read, never fleet-written. `tier-roles.mjs` derives it from every
   `*.agent.md` definition — `{"fleet-implementer":"@slow:xhigh",…}` — so the
   operator's own hand-editing never drifts from what the definitions
   actually declare.
4. **Every generated override carries an explicit `:<level>` suffix.**
   `modelRoles.<role>` values carry their own baked suffix (measured above),
   and an explicit suffix on the referring alias wins over it — so
   `@smol:low` reaches `low`, never the role's baked `:auto`, regardless of
   what the operator's `modelRoles.smol` says.
5. **The dispatch-time tier check (`tier-check.mjs`, ADR 0005) judges an omp
   member against the declared alias's OWN role target
   (`modelRoles.<role>`), never against the alias's model family.** Family
   comparison stays exactly as it was for Claude — the bare alias still IS
   the model there. On omp, comparing family would let a member dispatched
   through the wrong role, but at a same-family model, pass by accident.
6. **A read-only pre-dispatch check on omp**
   (`~/.fleet/bin/fleet-run tier-roles.mjs --check`), run once before a run's
   first dispatch, names every missing, stale, or wrong
   `task.agentModelOverrides` entry and every unset `modelRoles.<role>` a used
   definition needs, and stops the run. It prints the exact `omp config set
   task.agentModelOverrides` remedy only when an override is wrong, and that
   remedy is MERGED — the operator's own non-fleet entries kept, the fleet's
   laid over them — because `omp config set` on a record key replaces the
   whole record (measured, omp 18.3.0). An unset role gets a pointer to
   `modelRoles` instead: the overrides are already right there, and only the
   operator can choose the model. Claude has no such step — the routing
   precheck does not apply, because nothing routes the alias there.
7. **The finisher and merge bot get their own fleet-owned definitions**
   (`agents/fleet-finisher.agent.md`, `agents/fleet-merge-bot.agent.md`),
   dispatched by definition with `model` omitted on the call, exactly like
   every other fleet member (ADR 0005's Decision point 5, not this ADR's) —
   replacing today's per-call `model: "haiku"`, which omp's
   `agent()`/`task()` argument schema deletes before dispatch (ADR 0005's
   rejected-alternatives note on this), leaving those two dispatches running
   at the session's default tier on omp with no declared intent at all.

## Rejected alternatives

- **A CSV/array `model:` value** (`model: "@slow, opus"` — omp supports this
  shape). Both harnesses read the identical `model:` key; Claude Code would
  hand an unrecognised compound string to its own model selector verbatim
  (unmeasured, not relied on) rather than fail loudly, and on omp itself a
  value carrying BOTH a role alias and a bare vendor alias leaves which one
  wins unstated by anything this port controls.
- **Per-harness agent trees.** Rejected outright by ADR 0004 (one tree,
  marked lines for the two points of actual divergence).
- **An omp extension registering its own agent set.** Would duplicate the
  bare names the plugin's own `agents/` directory already registers —
  reopening ADR 0005's bare-name collision finding in a second form.
- **Provenance-only enforcement** (asserting the precondition only from
  `fleet-provenance`, never on the run path). `fleet-provenance` is
  operator-invoked, not something a run calls before dispatching — a wave
  could still open against a stale or absent `task.agentModelOverrides` with
  nothing stopping it. `tier-roles.mjs --check`, run from `run-team`'s own
  phase 2, is on the path that actually dispatches.

## Consequences

- The operator carries 12 `task.agentModelOverrides` entries (one per
  `*.agent.md` file) that drift whenever a definition's `model:` or
  `thinking-level:` changes; `tier-roles.mjs --check` is what catches the
  drift, not review of the definitions themselves.
- The per-wave alternate-tier pairing (`fleet-implementer` vs
  `fleet-implementer-alt`, ADR 0005) depends on `modelRoles.slow` actually
  differing from `modelRoles.task` on the operator's install —
  `checkOverrides`'s notice (not a violation, since it is legal
  configuration) surfaces this, but does not enforce it.
- CI's `install-and-smoke.sh` pins omp 18.1.15, where `task.agentModelOverrides`
  and the `:<level>`-suffix-wins-over-baked-suffix behaviour this ADR relies
  on are unmeasured; this decision rests on the 18.3.0 measurements above,
  taken on a separate box.
- `docs/adr/0005-tier-declared-per-harness-verified-at-dispatch.md` is
  amended, not superseded: layer 1's static shape and layer 2's declared-vs-
  resolved compare both stand; only what "resolved" is compared AGAINST on
  omp changes.
