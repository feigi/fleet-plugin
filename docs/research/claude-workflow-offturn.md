# Claude Code: can the review workflow run off the controller's turn?

Research for [issue #1770](https://github.com/feigi/fleet-plugin/issues/1770), part of wayfinder map #1768 (retire waves).

## Question

On Claude Code, can `Workflow({name: "fleet-ctl:review-pr", args})` run without holding the controller's turn?

(a) Does the `Workflow` tool accept a background/non-blocking option, and how does its return value reach the caller?
(b) Can a subagent (Agent tool, any `subagent_type`) invoke `Workflow`? Recheck per agent type the fleet dispatches (`fleet-ctl:fleet-implementer`, `fleet-ctl:fleet-review-*`, `general-purpose`).
(c) Does the Agent tool offer `run_in_background`, and would a backgrounded member that hand-runs the review (SKILL.md's "Fallback: hand-dispatched reviewer member" section) report back without the controller waiting on it?

## Method

- Read the official Claude Code docs: [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows), [Create custom subagents](https://code.claude.com/docs/en/sub-agents), and the [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) (`Workflow`/`Agent` tool input/output shapes, `SDKTaskNotificationMessage`).
- A working Claude Code install (v2.1.281, authenticated) is available in this environment (`which claude` → `/Users/chris/.local/bin/claude`; `claude -p "hi"` → `PONG`), unlike the situation `plugin/scripts/workflow-files.mjs`'s header recorded on 2026-09-22 ("this sandbox has no working Claude Code credentials"). That earlier note is now stale for *this* workstation.
- Attempted a fresh live probe (`claude -p` dispatching `general-purpose`, `fleet-ctl:fleet-implementer`, and `fleet-ctl:fleet-review-comments` subagents, each asked to run `ToolSearch` for `Workflow`). The probe script is at `docs/research/probes/claude-workflow-offturn-probe.txt`. Every run was confounded by this workstation's personal `~/.claude` memory/hook configuration (agent-brain MCP + `PostToolUse`/session hooks tied to the `Agent` matcher): the nested session's final answer kept collapsing into a memory-save reflection ("Can't save — agent-brain MCP tools unavailable...", "Nothing to save.") instead of reporting the requested `ToolSearch` result, even with `--strict-mcp-config`, `--settings '{"hooks":{}}'`, and an overriding `--append-system-prompt`. `--bare` (which does skip hooks/auto-memory) also disables keychain/OAuth reads and the session couldn't authenticate. See Caveats.
- Because of that, the answer below rests on the documentation (which is precise, versioned, and matches the installed v2.1.281) plus the project's own prior *successful* live measurement, `memory t5L-VS7h-UUb60-zWsLkb` (verified 2026-07-30, two independent sources, `general-purpose` subagent, `ToolSearch("select:Workflow")` → `No matching deferred tools found`) — which the docs below now explain was not a `general-purpose`-specific quirk but an unconditional, tool-level rule.

## (a) Does `Workflow` accept a background/non-blocking option, and how does the result reach the caller?

**Yes — and it is not an opt-in, it is the tool's only mode.** A `Workflow` call is asynchronous by construction; there is no synchronous/foreground variant to opt out of.

- "A dynamic workflow is a JavaScript script that orchestrates many subagents at once. Claude writes the script for the task you describe, **and a runtime executes it in the background while your session stays responsive.**" — <https://code.claude.com/docs/en/workflows> ("Orchestrate subagents at scale with dynamic workflows" lede).
- "Workflows run in the background, so the session stays responsive while agents work." — same doc, § *Watch the run*.
- Exact call/result shape, from the Agent SDK TypeScript reference (<https://code.claude.com/docs/en/agent-sdk/typescript>, § *Workflow*):

  ```typescript
  type WorkflowInput = {
    script?: string;
    name?: string;         // e.g. "fleet-ctl:review-pr"
    scriptPath?: string;
    args?: unknown;        // {pr, branch, worktree, testCmd, scratch}
    resumeFromRunId?: string;
    title?: string;        // ignored
    description?: string;  // ignored
  };

  type WorkflowOutput = {
    status: "async_launched" | "remote_launched"; // NEVER "completed" — no sync variant exists
    taskId: string;
    taskType?: "local_workflow" | "remote_agent";
    workflowName?: string;
    runId?: string;
    summary?: string;
    transcriptDir?: string;
    scriptPath?: string;
    sessionUrl?: string;
    warning?: string;
    error?: string;        // set only when the script fails its syntax check; run never starts
  };
  ```

  "Returns immediately after the tool accepts the invocation. **The final result arrives later as a task completion.**" (same section). Contrast with the `Agent` tool's output union, which *does* include a `"completed"` (synchronous) arm for a foreground subagent call — `Workflow` has no such arm at all.
- Result-delivery path: the run's completion is delivered as an `SDKTaskNotificationMessage` (`type: "system"`, `subtype: "task_notification"`, `task_id`, `status: "completed"|"failed"|"stopped"`, `output_file`, `summary`, optional `usage`), injected into the session as a **synthetic turn** the docs classify with `origin.kind === "task-notification"` ("Synthetic turn injected for a delivery that arrives without a fresh user prompt, such as a finished background task") — <https://code.claude.com/docs/en/agent-sdk/typescript>, §§ *SDKTaskNotificationMessage*, *Message origin*. Claude Code prepends a notice stating no human input occurred, so the model doesn't mistake the delivery for a user instruction.
- This matches vocabulary already in `plugin/skills/run-team/SKILL.md` itself: "**A specialist report lands** (a task-notification from a grandchild you never dispatched)" (the "Fallback: hand-dispatched reviewer member" section) and "A grandchild surfaces as its own task-notification" (the "Invariants" section) — the controller's prompt already reasons in these terms for the *specialist* reports inside the hand-dispatched fallback, but SKILL.md's guidance for the primary `Workflow` path runs **one review workflow at a time and reads the whole 20–40 minute run as turn-blocking**: "Queued PRs wait. A queue is not a reason to start a second." (the "**One review workflow at a time.**" paragraph under "Reviewers") and "reviews serialize on your own turn" (the "**Reviews are the bottleneck, not tickets.**" paragraph under "Queue depth") — that is a controller-policy choice in the prose, not a technical limit of the `Workflow` tool, which per the SDK reference above never blocks the calling turn in the first place.
- Availability: "Workflows are available in the CLI, the Desktop app, the IDE extensions, non-interactive mode with `claude -p`, and the Agent SDK" (same page, § *Turn workflows off*) — so this holds whether the fleet controller runs interactively or headless.

## (b) Can a subagent invoke `Workflow`? (recheck per fleet-dispatched agent type)

**No — for every agent type the fleet dispatches, unconditionally, by design; not a per-model or per-definition quirk.**

`Create custom subagents` (<https://code.claude.com/docs/en/sub-agents>), § *Available tools*, states the rule Claude Code applies to **every** subagent:

> "The first filter removes these tools, **even when listed in the `tools` field**: `Agent` (at depth limit)… `AskUserQuestion`, `EndConversation`, `EnterPlanMode`, `ExitPlanMode` (unless `permissionMode: plan`), `ScheduleWakeup`, `WaitForMcpServers`, **`Workflow`**."

This first filter applies to every subagent dispatched via the `Agent`/Task tool, regardless of `subagent_type` — there is no carve-out for a plugin-defined type. Checked concretely:

- `general-purpose` — no `tools:` restriction of its own; subject to the universal first filter → no `Workflow`. This is the case memory `t5L-VS7h-UUb60-zWsLkb` measured live on 2026-07-30 (`ToolSearch("select:Workflow")` → `No matching deferred tools found`), and it is now explained as an instance of the general rule, not a `general-purpose`-specific limitation.
- `fleet-ctl:fleet-implementer` (`plugin/agents/fleet-implementer.agent.md`) — its frontmatter sets `model`, `effort`, `thinking-level` only, no `tools:`/`disallowedTools:` field, so it inherits the default subagent tool pool → same universal first filter removes `Workflow`.
- `fleet-ctl:fleet-review-*` (`fleet-review-comments.agent.md`, `fleet-review-correctness.agent.md`, etc.) — same shape (no `tools:` override) → same removal.

The **only** exception documented anywhere is a `fork` subagent (`/subtask`/`/fork`, or the type Claude requests automatically under fork mode): "Forks skip both filters and receive the main conversation's exact tool pool" (same § *Available tools*). None of the fleet's dispatch call sites request `subagent_type: "fork"` — the fleet always names a concrete type (`general-purpose`, `fleet-ctl:fleet-implementer`, `fleet-ctl:fleet-review-*`) — so this exception does not apply to any fleet member.

**Conclusion for (b):** SKILL.md's existing statement under "Reviewers" ("members have no `Workflow` tool on Claude… tool availability is per-agent-type, so recheck after a harness change") should be updated from "recheck per agent-type" to a flat, permanent fact: no subagent type the fleet dispatches has `Workflow` (v2.1.281, current). The one condition that *would* change this is the fleet naming `subagent_type: "fork"`, which it never does and structurally could not (a fork doesn't take the member-dispatch brief shape the fleet relies on).

## (c) Does the Agent tool offer `run_in_background`, and would a backgrounded hand-run reviewer report back without the controller waiting?

**Yes to both.**

- `AgentInput` (Agent SDK TypeScript reference, § *Agent*):

  ```typescript
  type AgentInput = {
    description: string;
    prompt: string;
    subagent_type?: string;
    model?: "sonnet" | "opus" | "haiku" | "fable";
    run_in_background?: boolean;
    name?: string;
    team_name?: string;   // deprecated
    mode?: …              // deprecated
  };
  ```

  `run_in_background: true` is a first-class field on the same `Agent` tool call the controller already uses to dispatch every fleet member.
- Default behavior without the flag, from `Create custom subagents` § *Run subagents in foreground or background*: in an **interactive** session, fork mode is on by default and "Claude Code runs the subagent in the background… and Claude can't ask for the foreground" — every subagent already runs backgrounded. In **non-interactive** (`claude -p`)/Agent-SDK sessions, fork mode defaults off, and "Claude runs the subagent in the background by default and in the foreground when it needs the result before continuing" — i.e. the controller should set `run_in_background: true` explicitly to force async behavior when it does eventually want the result but must not block on it, matching exactly the shape decision 2 needs.
- Tool retention while backgrounded: § *Available tools* lists the reduced built-in tool set a **background** subagent keeps (`Read, Grep, Glob, LSP, Bash, PowerShell, Edit, Write, NotebookEdit, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, EnterWorktree, ExitWorktree, Monitor, TaskStop, SendMessage, Artifact`), but carves out: "Apart from `Agent` and `ExitPlanMode`, which follow the first filter's conditions **wherever the subagent runs**…" — meaning a backgrounded subagent keeps the `Agent` tool (subject only to the universal first filter, i.e. removed solely at spawn-depth limit). This is exactly what the hand-dispatched fallback reviewer (SKILL.md's "Fallback: hand-dispatched reviewer member" section) needs: it hand-dispatches its own specialists **unnamed** (SKILL.md's "**Inverts one level down: members must name their children `undefined`.**" paragraph under "Rules that fail silently") via `Agent`, and it can still do so while itself running in the background.
- Report-back path: identical mechanism to (a) — a backgrounded subagent's completion (or a specialist grandchild's completion) arrives as an `SDKTaskNotificationMessage` synthetic turn (`origin.kind === "task-notification"`), which is precisely the vocabulary `plugin/skills/run-team/SKILL.md` already uses (its "Fallback: hand-dispatched reviewer member" and "Invariants" sections) for "a specialist report lands (a task-notification from a grandchild you never dispatched)" and "a grandchild surfaces as its own task-notification." The controller is not required to wait/poll *inside the tool call*: per the SDK reference the result is delivered as an injected notification rather than as the call's return. Whether that injected turn actually **wakes an idle Claude Code controller** is documented but **unmeasured** — see the ADR 0008 caveat under Bottom line. The backgrounded-`bash` wakes this research session saw for its own jobs do not settle it: ADR 0008 measured that shape (background-job completion injecting a turn) only for a main agent **on omp**, and explicitly declines to generalise it to Claude Code.

**Exact call shape for the fallback, off-turn:**
`Agent({description, prompt: <hand-run review brief per SKILL.md's "Fallback: hand-dispatched reviewer member">, subagent_type: "fleet-ctl:fleet-review-<key>" (or general-purpose), run_in_background: true})` → controller receives `{status: "async_launched", agentId, description, …}` immediately and continues; the reviewer's (and any specialist grandchild's) result arrives later as `SDKTaskNotificationMessage` turns, not by the controller blocking a tool call.

## Bottom line

Not every answer here is "no" — (a) and (c) are both **yes**. Standing decision 2 of wayfinder map [#1768](https://github.com/feigi/fleet-plugin/issues/1768) ("Standing decisions from charting", in the issue body) frames the fallback as "If Claude's `Workflow` cannot run off-turn, the hand-dispatched reviewer member … becomes Claude's primary path". That framing is triggered by (b) alone in the narrow sense that *a subagent* can never run `Workflow` itself — but that was never the blocking question, because (a) shows the **controller's own** `Workflow` call is already asynchronous and non-blocking by tool design, on every surface the fleet runs on (`claude -p` included). The 20–40 minute "blocking" behavior recorded in `plugin/skills/run-team/SKILL.md` (the "**One review workflow at a time.**" paragraph under "Reviewers" and "reviews serialize on your own turn" under "Queue depth") is a controller-policy choice in the current prose (wait for the return before dispatching a second review), not a technical constraint of the `Workflow` tool. This is directly relevant to G1: the off-turn review design can plausibly keep the primary path as the controller calling `Workflow` directly (not the hand-dispatched fallback), simply by changing the prose so the controller does *not* wait for the return before continuing — with the fallback member (backed by `run_in_background: true`, per (c)) staying reserved for when `Workflow` is genuinely unavailable or has failed, exactly as the fallback section's opening line already scopes it: "Only where the workflow is unavailable **or has failed** — never a preference."

**ADR 0008 caveat — "non-blocking" is not "woken".** (a) and (c) answer whether the call holds the controller's turn; neither answers whether anything brings an idle controller *back* when the result lands. [ADR 0008](../adr/0008-a-turn-based-fleet-holds-its-own-turn.md) ("A turn-based fleet holds its own turn; nothing external wakes it") measured a **Claude Code member** that backgrounded its test suite plus a Monitor and sat idle for roughly two hours, neither ever waking it, and it records background-job completion injecting a turn only for the **main agent on omp** — "This is *not* generalised … neither result settles the other, and the design deliberately does not depend on either." The SDK reference documents the `task-notification` synthetic turn, but no live measurement in this note or anywhere in the tree shows an idle Claude Code controller being woken by a `Workflow` (or backgrounded `Agent`) completion: that claim is **UNMEASURED on Claude**, unlike the omp case ADR 0008 did measure. So this note does not support a design in which the controller ends its turn and waits to be woken. ADR 0008's Decision 1 stands — "The controller holds its own turn" — and what (a) removes is only the need to sit inside one `Workflow` call for 20–40 minutes; how and when the notification surfaces to a controller that is holding its turn (e.g. mid-`fleet-heartbeat.mjs` hold) is a separate question that needs its own live probe before the off-turn design depends on it.

## Caveats

- The live re-probe attempted in this session (dispatching `general-purpose`, `fleet-ctl:fleet-implementer`, and `fleet-ctl:fleet-review-comments` subagents from a nested `claude -p` process and asking each to run `ToolSearch('select:Workflow')`) did not produce clean per-type output. This workstation's personal `~/.claude/settings.json` wires `PostToolUse`/`SessionStart` hooks and an `agent-brain` MCP memory system that the nested session kept reaching for regardless of prompt instructions, `--strict-mcp-config`, or a hook-clearing `--settings` override (settings sources appear to merge/concatenate hook lists rather than the later one replacing the earlier), so the nested session's final answer collapsed into "Can't save…"/"Nothing to save." three times running. `--bare` does clear hooks/auto-memory but also blocks OAuth/keychain reads, and the sandbox has no `ANTHROPIC_API_KEY`, so it could not authenticate. The probe script attempted is committed at `docs/research/probes/claude-workflow-offturn-probe.txt` for reuse in a cleaner environment (e.g. a fresh `CLAUDE_CONFIG_DIR` with no personal hooks/MCP config, or a machine where `--bare` can still authenticate).
- In place of a fresh live per-type measurement, (b)'s conclusion rests on the documentation's explicit statement that the `Workflow` removal is unconditional across every subagent type (not model- or definition-dependent) plus the one successful live measurement this repo already has on file (`general-purpose`, 2026-07-30). No documented mechanism distinguishes `fleet-ctl:fleet-implementer` or `fleet-ctl:fleet-review-*` from `general-purpose` for this filter (all three lack a `tools:`/custom scope that could plausibly re-add a first-filter-removed tool — the docs don't describe any way for `tools:` allowlisting to restore a first-filter-removed tool at all), so no version drift specific to those two types is plausible without the whole first-filter rule itself changing.
- Version pinned throughout: Claude Code / Agent SDK docs as fetched 2026-09-24, matching the installed CLI `2.1.281`. The docs note the `Workflow` tool itself requires "Agent SDK v0.3.149 and later" and several adjacent fields have their own minimum versions (e.g. `is_backgrounded`/`spawn_depth` require v0.3.238+); none of those minimums are in question for v2.1.281.
- Did not verify from first principles that the fleet's actual `claude -p`-driven controller session runs with fork mode off (the doc-stated non-interactive default) rather than forced on by some flag/setting in this repo's own Claude configuration; if the controller's session did somehow run with fork mode force-enabled, all subagents (not just workflows) would already be fully backgrounded and unable to hold the foreground even when the controller wants a result before continuing — which would make (c)'s explicit `run_in_background: true` moot rather than necessary, but wouldn't change the yes/no answer for (a)/(b)/(c) themselves.
