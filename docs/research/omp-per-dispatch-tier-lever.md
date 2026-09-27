# omp per-dispatch tier lever: is a definition per cell the only way?

Answers `feigi/fleet-plugin#2032`. Primary sources: `omp://task-agent-discovery.md`,
`omp://models.md`, `omp://config-usage.md`, the `task`/`agent()` tool schemas as
exposed to this session, the `@oh-my-pi/pi-coding-agent` TypeScript source shipped
with the local npm install (`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src`,
`omp/18.3.4`), its `CHANGELOG.md`, `docs/adr/0005-*.md`, `docs/adr/0011-*.md`,
`plugin/scripts/tier-roles.mjs`, `plugin/scripts/tier-check.mjs`,
`plugin/scripts/frontmatter-allowlist.json`, `.github/scripts/smoke-omp.sh`,
`.github/scripts/install-and-smoke.sh`, and four throwaway probe agent definitions
dispatched from this session (scratch, at `~/.omp/agent/agents/zzz-rtl2032-*.md`,
deleted after measurement — never under `plugin/agents/`, never touching
`task.agentModelOverrides`).

## Verdict up front

1. **No per-call MODEL lever exists, on 18.3.4, confirmed fresh.** Neither the
   `task` tool nor eval's `agent()` bridge lets one dispatch choose a model. The
   only levers that move the resolved model are (a) the target agent's own
   frontmatter `model:` field and (b) `task.agentModelOverrides[agentName]`,
   both **definition-scoped**, never call-scoped. ADR 0005's 2026-09-09 finding
   (omp 18.1.14/15) reproduces byte-for-byte on 18.3.4 today.
2. **A definition per cell is not the only way to reach a role+level — omp's own
   frontmatter `model:` field accepts `"@role:level"` directly, no
   `task.agentModelOverrides` entry required.** This is new relative to ADR 0005/0011,
   which only exercised the bare-alias-plus-override path. Measured directly (§2).
   But this repo's OWN CI static check (`frontmatter-allowlist.json`) currently
   restricts `model:` to the bare alias set `{opus, sonnet, haiku}`, so today a fleet
   cell definition still needs the bare-alias-plus-`task.agentModelOverrides` shape
   ADR 0011 already established, unless that allow-list is loosened (§4).
3. **A real per-call THINKING-LEVEL (not model) lever exists in source, but is
   switched off on this box and not exposed by this session's `task` tool schema.**
   `task.enableEffort` (default `false`) gates a coarse `effort: "lo"|"med"|"hi"`
   field on a task item that, when enabled, overrides the target agent's own
   configured level, clamped to `task.maxEffort`. Not empirically exercised this
   session — flipping a global setting shared by two concurrent sibling research
   agents on this box was judged too risky for a reversible probe (§5).
4. **A haiku-tier router dispatched off the controller's own turn, reporting a
   definition/cell name, is the same primitive `fleet-review-runner` already uses**
   — confirmed by dispatching one and reading its own resolved tier and cost back
   off its transcript. Floor cost for a real one-issue-body prompt: ~$0.03–0.035,
   ~24.5K total tokens across 2 turns, dominated (>85%) by fixed system-prompt
   cache-write overhead, not by the ticket content (§6).
5. **CI's `install-and-smoke.sh`/`smoke-omp.sh` omp pin (18.1.15) does not measure
   any of this.** Confirmed both by the script's own documented design (agents are
   asserted by file presence only, explicitly because CI carries no API key and a
   real dispatch would 401) and by a fresh structural check: 18.1.15's config schema
   does carry `task.agentModelOverrides` and `modelRoles` as record-typed settings,
   but no CI job ever dispatches through them (§7).

## 1. What the docs say the levers are

`omp://task-agent-discovery.md` § "Model and structured-output precedence":

> For task dispatch, model precedence is:
> 1. `task.agentModelOverrides[agentName]`
> 2. the agent frontmatter's prioritized `model` list
> 3. the parent's active model, then its configured/default model fallback
>
> Role aliases in either of the first two sources are expanded through `modelRoles`.
> The shared eval bridge can also supply an invocation-local model override ahead
> of the settings override; **the task wire schema does not expose that field.**

That closing sentence is the whole of Q1's answer for the `task` tool: an
invocation-local override exists somewhere in the internal wiring (used for the
`^model`-tagged-mention pseudonym feature, § "User-tagged model agents" — a
session-level UI feature, not something a task item's fields can set), but it is
never surfaced to a caller through the `task` tool's own schema.

The `agent()`/`workpool()` eval bridge (`xd://eval/agents`, this session's own
tool docs) confirms the same for eval: its full signature is

```
agent(prompt, agent?="task", label?=None, schema?=None, schemaMode?="permissive",
      isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle
```

— no `model`, no `effort`, no `thinking` parameter anywhere in the exposed surface.

## 2. Fresh measurement, omp 18.3.4, this box (2026-09-27)

Four throwaway probes, `~/.omp/agent/agents/zzz-rtl2032-{a,b,c,d}.agent.md` (scratch
user-level agents dir, never `plugin/agents/`, no `task.agentModelOverrides` entry
for any of them), dispatched via this session's own `task` tool and read back off
their raw omp session transcripts
(`~/.omp/agent/sessions/-dev-fleet-plugin/<session>/<parent>/<Name>.jsonl`), the
same `session_init.resolvedModel` / `thinking_level_change.thinkingLevel` fields
`tier-check.mjs`'s `resolveActual()` reads:

| probe | frontmatter `model:` | frontmatter `thinking-level:` | `session_init.modelRole` | `session_init.resolvedModel` | `thinking_level_change.thinkingLevel` |
|---|---|---|---|---|---|
| a | `opus` (bare) | `xhigh` | `null` | `anthropic/claude-opus-5-5` | `xhigh` |
| b | `"@smol:medium"` | *(absent)* | `smol` | `anthropic/claude-haiku-4-5:medium` | `medium` |
| c | `"@slow:xhigh"` | *(absent)* | `slow` | `anthropic/claude-opus-5-5:xhigh` | `xhigh` |
| d | `haiku` (bare) | `low` | `null` | `anthropic/claude-haiku-4-5` | `low` |

Reading the raw lines (probe c shown, others identical shape):

```
{"type":"session_init", …, "agent":"zzz-rtl2032-c", "modelRole":"slow",
 "resolvedModel":"anthropic/claude-opus-5-5:xhigh", "readOnly":false, "spawns":""}
{"type":"thinking_level_change", …, "thinkingLevel":"xhigh","configured":null}
```

Findings from this table:

- **Probes a/d reproduce ADR 0005's 2026-09-09 measurement unchanged on 18.3.4**:
  a bare vendor alias plus a `thinking-level:` key resolves directly, with no
  `task.agentModelOverrides` entry at all, and no `:suffix` on `resolvedModel`
  (fuzzy vendor-family match, not role routing) — exactly ADR 0005 point 2's
  "declared level survives when pinned under the right key" and ADR 0011's "bare
  alias is not a vendor model *when routed through an override*" (these bare
  probes were **not** routed through any override, so they resolved as plain
  vendor aliases, matching ADR 0005's original premise for that path).
- **Probes b/c are new evidence, not covered by ADR 0005 or ADR 0011**: omp's
  `model:` frontmatter field accepts a **role selector with an explicit level
  suffix directly**, `"@smol:medium"` / `"@slow:xhigh"`, with **zero**
  `task.agentModelOverrides` entry for that agent name. `session_init` carries a
  `modelRole` field (undocumented in ADR 0005/0011 and unused by
  `tier-roles.mjs`/`tier-check.mjs` today) naming the role the dispatch actually
  routed through — `null` for the bare-alias probes, the role name for the
  `@role:level` probes. This is a **cleaner, more direct signal than family-matching
  `resolvedModel`** for a future dispatch-time check, worth flagging to whoever
  builds the router's verification step, though implementing it is outside this
  ticket.
- Per `omp://models.md`, an explicit `:level` suffix on the referring selector wins
  over the role's own baked suffix (`modelRoles.smol` = `anthropic/claude-haiku-4-5:auto`
  on this box, yet probe b resolved `:medium`) — ADR 0011 point 4's rule, reconfirmed.

**Per-call override, tested two ways, both dead:**

- Via the eval bridge, dispatching probe `a` (frontmatter `opus`/`xhigh`) with
  `agent(prompt, { agent: "zzz-rtl2032-a", model: "haiku", effort: "low", thinking: "low" })`:
  no error (JS silently accepts the extra object keys), and the dispatch resolved
  `anthropic/claude-opus-5-5` at `xhigh` — the frontmatter's values, the injected
  ones had zero effect. This is ADR 0005's exact 2026-09-09 test
  (`agent(prompt, {model:"haiku", effort:"low"})`), reproduced today.
- Via this session's own `task` tool, dispatching the same probe with extra
  `"model": "haiku", "effort": "low"` keys on the task item: also no schema
  rejection, also zero effect — `resolvedModel` stayed `anthropic/claude-opus-5-5`,
  `thinkingLevel` stayed `xhigh`.

Both silently accept and silently drop the extra fields — never a validation error,
never a resolved-tier change. There is no way, on this box, for a calling turn to
choose a model per dispatch.

## 3. The one real per-call lever that exists — for effort, never model

`src/task/types.ts` (shipped source, `@oh-my-pi/pi-coding-agent` `18.3.4`):

```ts
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;
...
const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
...
const effortEnabled = options.effortEnabled ?? false;
```

`src/prompts/tools/task.md` (the model-facing tool description template):

```
{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}
```

And `omp://task-agent-discovery.md` itself: "When `task.enableEffort` (default
`false`) exposes it, a task item's coarse `effort` (`lo`, `med`, `hi`) takes
precedence at launch. OMP maps that hint to the selected model's lowest, middle,
or highest supported effort, then clamps it to `task.maxEffort` (default `max`)."
`TASK_EFFORTS = ["lo","med","hi"]` (`@oh-my-pi/pi-tui/thinking`), `lo` = the
model's lowest supported level, `hi` = highest (`xhigh`/`max`, whichever the model
exposes), `med` = the middle of the two.

This is a real, shipped, per-dispatch lever — but only for **effort/thinking
level**, never for model selection, and it is off by default
(`task.enableEffort: false`) and evidently off on this box: this session's own
`task` tool schema (visible in the tool's JSON schema this session was given) has
no `effort` field on a task item at all, which is exactly what `effortEnabled:
false` produces per the template above.

**Not empirically exercised.** Flipping `task.enableEffort` on to test it would be
a global, persisted config write shared by every concurrent session on this box —
at dispatch time this session had two live siblings (`ResearchTierReadout`,
`ResearchTokenPricing`) running their own dispatches against the same shared omp
config, so toggling a setting that changes every subsequent `task` tool's exposed
schema was judged out of bounds for a reversible probe, distinct from the
scratch-agent-file approach used everywhere else in this ticket. This is a real
gap: **if this coarse effort hint works as documented, a router needs only one
definition per MODEL, not per model×level cell** — level could be chosen by the
router at dispatch time via this field instead of by picking among N pre-declared
definitions. That collapses G2's definition-per-cell design space from
`|models| × |levels|` down to `|models|` definitions plus a per-dispatch effort
argument, if and only if `task.enableEffort` is turned on and its coarse 3-bucket
granularity (vs. the fleet's current 6-value `minimal/low/medium/high/xhigh/max`)
is acceptable. This needs a dedicated, isolated follow-up before G2 commits to a
definition-per-cell design.

## 4. If a definition per cell is the lever: what it must respect

**Frontmatter form.** Two forms both work at the omp runtime layer (§2): bare
alias + `thinking-level:` key (ADR 0011's existing shape, needs an
`task.agentModelOverrides` entry to route through a role), or `model: "@role:level"`
directly (no override entry needed). But `plugin/scripts/frontmatter-allowlist.json`
(CI's Layer-1 static check, ADR 0005 point 2):

```json
"values": {
  "model": ["opus", "sonnet", "haiku"],
  ...
}
```

only accepts the three bare aliases. A cell definition using `model: "@smol:medium"`
would fail this repo's own CI check today. **This repo's tooling, not omp itself,
is what forces the definition-per-cell-plus-override-record shape** — loosening
this allow-list is itself a design decision for whoever builds the router (G2/T2),
not assumed here.

**Generator/checker compatibility.** `plugin/scripts/tier-roles.mjs`'s
`parseFrontmatter()` reads `model` with `/^model:\s*(\S+)$/` and looks it up in
`OMP_ROLE_FOR_MODEL = { opus: "slow", sonnet: "task", haiku: "smol" }`
(`ompOverrideFor()`); a value of `opus`, `sonnet`, or `haiku` — any other string,
including a quoted `"@role:level"` literal — returns `null`, which
`expectedOverrides()`'s own comment calls "a refusal, never a skipped file." **The
existing generator/checker only understands the bare-alias-plus-override shape**;
adopting the direct-role-selector form found in §2 would need `tier-roles.mjs`
rewritten, not merely the CI allow-list. Definitions named `fleet-implementer-<model>-<level>`
work with today's tooling exactly as-is, because neither `parseFrontmatter`,
`ompOverrideFor`, nor `checkOverrides` inspects the file's own `name:` shape — only
its `model`/`effort`/`thinking-level` fields — confirmed by reading
`plugin/scripts/tier-roles.mjs:44-63` end to end.

**Config reload.** `omp://task-agent-discovery.md` § "Role-backed custom agents":
"Task/eval preflight reloads the current global, project, and explicit overlay
settings before rediscovering agents, so agent files and their role aliases added
during a live session resolve from one refreshed configuration state." This session
observed the agent-file half of that directly: all four scratch probes were
created mid-session and dispatched successfully without any restart. The
`task.agentModelOverrides` half was not independently re-verified by a live write
this session (forbidden by this ticket's own constraint), but it is the identical
code path the doc describes and ADR 0011 already asserts it (point 6: the
pre-dispatch check "run once before a run's first dispatch").

**Discovery cost.** No documented per-file overhead number exists for
`discoverAgents()`; this was not independently benchmarked (isolating a few
milliseconds of file I/O from noise in a shared session was judged low-value).
What is measurable: `plugin/agents/*.agent.md` today is 13 files, 76K total,
dominated by `fleet-implementer(-alt).agent.md` at ~14.4K each — the two files are
otherwise byte-identical prose, differing only in frontmatter and one description
line. A definition-per-cell design that keeps that same ~14K prose body per cell
(rather than factoring the shared prose out) multiplies file size and per-dispatch
read/parse cost roughly linearly with cell count — e.g. a 3×3 model×level grid
(the bound G2's ticket proposes) would carry ~9 near-duplicate 14K files (~126K)
plus a router definition, versus today's 2. This is a real operational cost for
G2 to weigh, not a blocking one.

**Two-definition assumptions elsewhere.** Not re-derived here (already established
in this map's charting ground truth) but worth restating as a constraint a cell
definition set must respect: `plugin/scripts/compute-spend.mjs:112`'s
`/(^|:)fleet-implementer(-alt)?$/` regex and at least four test files
(`member-outcomes-header.test.mjs`, `within-run-pair-prose.test.mjs`,
`tier-check.test.mjs`, `implementer-model-tier.test.mjs`) hardcode exactly two
implementer definitions; a definition-per-cell design breaks all of them.

## 5. `task.maxRecursionDepth` and other guardrails a router dispatch must respect

Not asked directly, but relevant to Q3 (a router dispatched by the controller,
itself possibly dispatching nothing further): `task.maxRecursionDepth` defaults to
`2`; the shared spawn policy rejects a spawn once current depth reaches the cap.
A `fleet-router` member dispatched directly by the controller (depth 1) has no
recursion concern of its own as long as it does not itself call `task`.

## 6. Haiku-tier router off the controller's turn: the `fleet-review-runner` primitive, floor cost

`fleet-review-runner.agent.md` frontmatter: `model: haiku`, `effort: low`,
`thinking-level: low`; dispatched by the controller via the identical `task`
mechanism this session used for its own probes ("dispatched by the controller as
review-pr-<pr#>" — its own description line). Probe `d` above
(`model: haiku`, `thinking-level: low`) reproduces that exact shape, dispatched
from a background `task` call carrying one real GitHub issue body
(`gh issue view 2032 --json body`, 1797 bytes / 244 words) in its prompt, resolved
verbatim to `anthropic/claude-haiku-4-5` at `low`, and returned a
one-word verdict (`light`) without ever touching the dispatching turn's own
context — the same "off the controller's turn" shape `fleet-review-runner` already
uses and this ticket asks about.

Its own transcript's per-turn `usage` objects (omp records full cost, not just
`cache_creation`):

```json
{"input":10,"output":727,"cacheRead":0,"cacheWrite":10545,"totalTokens":11282,
 "cost":{"input":0.00001,"output":0.003635,"cacheRead":0,"cacheWrite":0.02109,"total":0.024735}}
{"input":10,"output":972,"cacheRead":10545,"cacheWrite":1720,"totalTokens":13247,
 "cost":{"input":0.00001,"output":0.00486,"cacheRead":0.0010545,"cacheWrite":0.00344,"total":0.0093645}}
```

Two turns (the second is the structured-output retry this session's own
`solutionSpace`-driven schema requirement produced), total **~24.5K tokens,
~$0.0341**. The first turn's 10,545-token cache-write is the fixed harness system
prompt plus the probe's own short instructions plus the 1,797-byte issue body
combined — **the issue body itself is a few hundred tokens out of that 10.5K; the
floor is dominated by fixed per-dispatch overhead, not by ticket content.** A
router built on this primitive should expect a **per-dispatch floor near $0.03–0.035
regardless of how small the ticket is**, before weighing whether its reasoning
"pays for itself" against a cheaper deterministic-only path (G3's question).

## 7. CI's omp pin measures none of this

`.github/scripts/install-and-smoke.sh:46` / `.github/scripts/smoke-omp.sh:55`:
`PIN="18.1.15"`. `smoke-omp.sh`'s own header comment states the design directly:

> a real dispatch needing `resolvedModelIdentity` off a live job record requires
> an actual successful model call, and this job must never reach for one against a
> non-configured provider — CI carries no API key at all. So agents are ALSO
> asserted by presence only.

So CI's pin never dispatches anything and never reads a resolved tier back — it
cannot measure the routing behavior in this ticket at all, on any version.

Separately, fetched the pinned binary itself (`bunx --bun @oh-my-pi/pi-coding-agent@18.1.15`,
isolated `PI_CODING_AGENT_DIR`/`HOME`, never touching this box's real `~/.omp`) and
ran `omp config list --json` against a blank config:

```json
"modelRoles": {"value": {}, "type": "record", "description": ""}
"task.agentModelOverrides": {"value": {}, "type": "record", "description": ""}
```

Both settings exist as record-typed keys on 18.1.15, structurally identical to
18.3.4 — so the CONFIG SURFACE ADR 0011 relies on was already present at CI's pin.
What was not, and could not safely be, verified this session is the actual
dispatch-time *behavior* (the `:level`-suffix-wins-over-baked-suffix rule, the
`modelRole` field, role routing through `task.agentModelOverrides`) on 18.1.15,
since that requires a working authenticated provider inside an isolated
environment — out of scope for a reversible probe on live credentials. This
reproduces, rather than closes, ADR 0011's own Consequences-section caveat: "CI's
`install-and-smoke.sh` pins omp 18.1.15, where `task.agentModelOverrides` and the
`:<level>`-suffix-wins-over-baked-suffix behaviour this ADR relies on are
unmeasured."

## Answers to the ticket's three questions

**Q1 — is there any lever to choose model+thinking-level per call?** For model: no,
on any of `task`, eval `agent()`, or a `model:`/`effort:` field smuggled onto a
task item — all silently dropped, reproduced fresh on 18.3.4. For thinking-level
alone: a real but currently-disabled `task.enableEffort` → per-task-item coarse
`effort: lo|med|hi` lever exists in source and is documented, but was not
exercised this session (§3) — the single most consequential open question for
G2/G4, since if it works it changes the definition-per-cell design entirely.

**Q2 — if a definition per cell is the only lever, what must it respect?**
`task.agentModelOverrides` reloads live, no restart (documented; agent-file half
observed directly this session); `tier-roles.mjs`/`tier-check.mjs` work unchanged
for any definition name shape including `fleet-implementer-<model>-<level>`,
because neither inspects the name, only `model`/`effort`/`thinking-level`
frontmatter fields; CI's frontmatter allow-list currently forces the bare-alias
form (not the newly-found `model: "@role:level"` shape) for any file under
`plugin/agents/`; discovery cost is undocumented and not independently
benchmarked, but file size scales roughly linearly with near-duplicate prose per
cell (~14K × cell count on today's prompt bodies); CI's omp pin measures none of
the routing behavior at all (§7).

**Q3 — can a haiku-tier router be dispatched off the controller's turn, reporting
a definition name, at what floor cost?** Yes — confirmed with the exact
`fleet-review-runner` primitive (`task`, `model: haiku`/`effort: low`), reporting a
structured verdict without consuming the dispatching turn's own context. Floor
cost for a prompt carrying one real issue body: ~$0.03–0.035 / ~24.5K tokens over
2 turns, over 85% of it fixed per-dispatch overhead rather than ticket-size-driven
(§6).
