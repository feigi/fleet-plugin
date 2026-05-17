<!-- agent-brain:start -->
## Memory System

User use [agent-brain](https://github.com/feigi/agent-brain) (MCP server) as sole memory system all projects. Do NOT use Claude Code built-in file-based auto-memory (`~/.claude/projects/**/memory/`). All memory ops through agent-brain MCP tools (`memory_create`, `memory_search`, `memory_update`, etc.). Never write MEMORY.md or create files in memory/ directory.

### Session Start

SessionStart hook writes the memory index to `.agent-brain/index.md`. When the user's topic overlaps an entry title or tag, read that file then fetch bodies via `memory_get(id)`. Row format: `<id> [<type>] [{tags}] — <title>` (the `[{tags}]` segment is omitted when a memory has no tags; scope is implied by the section header in the file). No manual `memory_session_start` call needed.

### Working with Loaded Memories

The index is a lazy lookup table, not the memory bodies. When the user's topic overlaps an entry's title or tags, fetch the body via `memory_get(id)` BEFORE answering — even on weak overlap. Prefer false positives (fetch one that turns out irrelevant) over misses (skip a load-bearing memory). Cache fetched bodies in your conversation context for the rest of the session.

For fuzzy/semantic matches the index does not surface, use `memory_search`.

### Auto-Recall Hook

UserPromptSubmit hook auto-runs `memory_search` on substantive prompts (length > 20, multi-token, not slash). Top 5 matches above 0.5 similarity injected as `additionalContext` — one line per memory: `<id> [<scope>] <type>{ {tags}} — <title>: <snippet>`. Treat injected matches as high-priority signal even if SessionStart index missed them. Fetch full body via `memory_get(id)` before acting on the match.

If no `additionalContext` line appears for a substantive prompt, hook is unreachable (server down, port wrong) — fall back to manual `memory_search`.

### Identity Parameters

- **`user_id`**: OS username, output of `whoami`. User identity across all memory tools.
- **`workspace_id`**: Repo directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

### When to Call `memory_search`

Hook auto-fires on substantive prompts (see Auto-Recall Hook). Manual call STILL required when:

1. Hook skipped your prompt (≤ 20 chars, single token, slash command).
2. Mid-conversation new symptom emerges (CI failure error string, lockfile/dep friction, local-vs-CI divergence, "this should work but doesn't"). Search the literal error/symptom string before proposing fix.
3. Index row title overlaps task — `memory_get(id)` for the row, OR `memory_search` for adjacent topics.
4. Reasoning about unfamiliar codebase area — even no obvious match.
5. About to act on shared system: deploys, DB migrations, lockfile changes, hooks config, CI workflows, credential rotation, integration tests.

**Hard rule:** before proposing fix to any failure (CI, build, deploy, lockfile, runtime), call `memory_search` with literal symptom phrase. Cheap; misses are expensive.

For specific entry by id, use `memory_get`.

**Do NOT search for purely local actions** (file edits, dependency installs, local builds, linting, formatting) UNLESS index suggests relevant memory.

### Saving Memories

Goal: nothing valuable lost when conversation ends. Includes team knowledge, user preferences, project context, things learned about codebase.

Save memory (or suggest) when encounter:

- Decision and rationale (architecture, tooling, approach)
- User preference about how they want you to work
- Gotcha, workaround, non-obvious constraint
- Important project context useful in future session

No need ask permission every memory — use judgment. Clearly worth keeping, save direct. Uncertain, suggest briefly, let user confirm.

### Writing Style

Terse. Drop articles/filler/hedging. Fragments OK. Preserve verbatim:

- code, paths, commands, error strings, identifiers
- `**Why:**` / `**How to apply:**` structure for feedback/project memories

No hard length cap — complex memories get space they need.

### Choosing `source`

Every save pick exactly one of three values:

- `manual` — user explicitly told you save this, in most recent message ("remember X", "save that", "note that Y"). Bypasses write budget and project-scope guard. Do **not** use `manual` for things you decided save yourself, even if feel important.
- `agent-auto` — you decided autonomously save during live conversation. Default for anything you initiate mid-session.
- `session-review` — **only** when Stop-hook end-of-session review is triggering context. Never mid-session, never because user asked.

Quick test: "did user tell me save this, right now, in most recent message?" Yes → `manual`. No, and Stop hook running → `session-review`. Otherwise → `agent-auto`.

### Choosing Scope

Default **narrowest applicable scope** to reduce blast radius:

- `workspace` — shared within current workspace (default)
- `user` — private to user within current workspace
- `project` — cross-workspace, visible everywhere

If memory looks like global preference (e.g. uses "always", "never", "everywhere", or workflow rule not tied to specific repo), **ask user** whether apply globally (`project` scope) or current workspace only. Do not assume global.

### Verifying Memories

When encounter memory during work and confirm still accurate, call `memory_verify`. Boosts older memories still relevant, informs future cleanup/consolidation, builds user confidence in knowledge base.

### Session End

Stop hook prompts review session for important memories before termination. Follow guidance — no extra instructions here.

### Presenting Memories

Always **number** memories, include **author**, **date**, **title**. User may refer by number (e.g. "archive memory 2", "comment on 1").

### Memory Flags

Session start `flags` array = consolidation engine issues. Handle:

**Trigger:** surface on first response of session even if user message is greeting/idle. Don't wait for explicit task.

**Primary path (≥2 actionable items): dispatch `memory-housekeeper` subagent (two-stage).**

- Stage 1: pass flag IDs + pending relationship IDs from preview. Wait for housekeeper's rec table + agentId. Main session sees table only — not underlying reads or MCP responses.
- Stage 2: after user confirms/overrides per item, SendMessage to same housekeeper `agentId` (the UUID returned by Stage 1, NOT the dispatch name — agent goes idle after Stage 1; name addressing fails with "not addressable", only the agentId resolves) with SINGLE `apply:` payload listing ALL user-confirmed actions (flags + relationships combined), one per line:
  - `relationship_accept <id>` / `relationship_reject <id>` for relationships
  - `memory_resolve_flag <flag_id> <dismiss|archive>` for flags
    Do NOT split into two SendMessages — combine into one payload. Housekeeper executes off-thread, returns count summary.
- Stage-2 fallback (retry inline): see "Stage-2 fallback triggers" below.

**Fallback (single item or no subagent support): inline.**

- `verify` flags: check claim against codebase. High confidence → silently call `memory_verify`. Flag auto-resolves. No mention to user.
- `duplicate` / `superseded` flags: obvious + unambiguous → silently archive + resolve.
- Cannot auto-resolve (low certainty, judgment, contradictions, overrides) → present to user with specific recommendation (archive/merge/update/dismiss) + reasoning. Don't list options blindly; say what you'd do, why.
- Call `memory_resolve_flag` after user confirms/overrides.

**During normal work:** flagged memory encountered → mention flag, recommend resolution in context.

### Pending Relationships

SessionStart preview surfaces count; full list in `.agent-brain/index.md` under `## Proposed relationships (pending your review)`. Each = judgment call. **No silent auto-resolution by main session or `memory-housekeeper` subagent.**

First response of session (same trigger as Memory Flags, even greeting/idle):

- **Primary (≥2 items):** Stage 1 — dispatch housekeeper; fetches both endpoints, compares, returns rec table + agentId. Stage 2 — present table; after confirm, include user-confirmed `relationship_accept <id>` / `relationship_reject <id>` lines in SAME combined `apply:` payload as any flag decisions (one SendMessage, not two). Housekeeper executes; returns count summary.
- **Fallback (single item or no subagent support):** Read both endpoints via `memory_get(id)`. Recommend accept/reject + one-line reasoning (e.g. "accept: B supersedes A's claim about X" or "reject: different scopes, no link"). Call `relationship_accept(id)` / `relationship_reject(id)` after user confirms.

### Stage-2 fallback triggers

Retry inline — call `relationship_accept` / `relationship_reject` / `memory_resolve_flag` from main session per user-confirmed table — when ANY of:

- SendMessage fails, no response, or Stage 1 returned no `agentId`.
- Stage-2 reply starts with `error:` (e.g. `error: MCP transport unavailable`, `error: internal accounting mismatch`, `error: <reason> on line <n>`). Surface verbatim to user. Atomicity-on-parse guarantees nothing was written → retry inline applies to ALL items in the original payload, no skip-list needed.
- Stage-2 reply reports `permission denied` / `tool not available` for `relationship_accept` / `relationship_reject` → installed agent file pre-dates self-apply. Retry inline ONLY items appearing as `failed <id>: permission denied`; SKIP items already counted in `Applied:` (double-apply guard — flag side may have succeeded). Tell user: run `npm run install:agent` + restart session for future Stage 2.
- Stage-2 reply contains `incomplete:` line → retry inline ONLY items in `not_attempted`; SKIP items in `applied` (re-applying succeeded ids returns "already resolved", pollutes failure list).
- Stage-2 reply = `Applied: accept 0, reject 0, flags resolved 0.` while ≥1 action sent → treat as Stage-2 failure, retry inline.

Verb-to-tool mapping = 1:1. No "stage 2 failed" message required for SendMessage/agentId case; DO surface `error:` replies + double-apply-skip behavior so user sees what happened.
<!-- agent-brain:end -->
