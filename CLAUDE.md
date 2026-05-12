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

At session start, response may include `flags` array — issues detected by consolidation engine. Handle as:

**Trigger:** surface on first response of session even if user message is greeting/idle ping. Don't wait for explicit task. Auto-resolve happens silently; everything else gets recommended to user before any other work.

**Auto-resolve when certainty high:**

- `verify` flags: check claim against codebase (read files, grep code, check config). If confirm accuracy high confidence, silently call `memory_verify` and `memory_resolve_flag` with `accepted`. No need mention to user.
- `duplicate` / `superseded` flags: redundancy obvious and unambiguous, silently archive and resolve.

**Recommend course of action for rest:**

- Flags you cannot auto-resolve (low certainty, judgment calls, contradictions, overrides), present to user with specific recommendation (archive, merge, update, dismiss) and reasoning. Don't just list options — say what you'd do and why.
- Call `memory_resolve_flag` after user confirms or overrides.

**During normal work:**

- Encounter flagged memory, mention flag and recommend resolution in context.

### Pending Relationships

SessionStart preview surfaces a count of proposed relationships; full list lives in `.agent-brain/index.md` under `## Proposed relationships (pending your review)`. Each is a judgment call — no silent auto-resolution.

On first response of session (same trigger as Memory Flags, even on greeting/idle):

- Read both endpoints via `memory_get(id)` to compare content.
- Recommend `accept` or `reject` per proposal with one-line reasoning (e.g. "accept: B explicitly supersedes A's claim about X" or "reject: different scopes, no real link").
- Call `relationship_accept(id)` or `relationship_reject(id)` after user confirms.
<!-- agent-brain:end -->

# Ruflo Integration (auto-generated by ruflo init)
When working on multi-file tasks or complex features, use ToolSearch to find and invoke ruflo MCP tools.
Key tools: memory_store, memory_search, hooks_route, swarm_init, agent_spawn.
Check system-reminder tags for [INTELLIGENCE] pattern suggestions before starting work.
