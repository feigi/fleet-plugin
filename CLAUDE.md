<!-- agent-brain:start -->
## Memory System

User use [agent-brain](https://github.com/feigi/agent-brain) (MCP server) as sole memory system, all projects. Do NOT use Claude Code built-in file auto-memory (`~/.claude/projects/**/memory/`). All memory ops via agent-brain MCP tools (`memory_create`, `memory_search`, `memory_update`, etc.). Never write MEMORY.md or create files in memory/ dir.

### Session Start

SessionStart hook writes memory index to `.agent-brain/index.md`. User topic overlaps entry title/tag → read file, fetch bodies via `memory_get(id)`. Row format: `<id> [<type>] [{tags}] — <title>` (`[{tags}]` omitted when no tags; scope from section header). Each row ends ` → <abs-project-dir>/.agent-brain/cache/<id>.md` — absolute clickable path to cached body (resolves regardless of open cwd). No manual `memory_session_start` needed.

### Working with Loaded Memories

Index = lazy lookup table, not bodies. User topic overlaps entry title/tags → fetch body via `memory_get(id)` BEFORE answering — even weak overlap. Prefer false positives (fetch one irrelevant) over misses (skip load-bearing memory). Cache fetched bodies in context rest of session.

Fuzzy/semantic matches index miss → use `memory_search`.

### Auto-Recall Hook

UserPromptSubmit hook auto-runs `memory_search` on substantive prompts (length > 20, multi-token, not slash). Top 5 matches above 0.5 similarity injected as `additionalContext` — one line per memory: `<id> [<scope>] <type>{ {tags}} — <title>: <snippet> → <abs-project-dir>/.agent-brain/cache/<id>.md` (absolute path). Treat injected matches as high-priority signal even if SessionStart index missed. Fetch full body via `memory_get(id)` before acting on match.

No `additionalContext` line for substantive prompt → hook unreachable (server down, port wrong) — fall back to manual `memory_search`.

### Identity Parameters

- **`user_id`**: OS username, output of `whoami`. User identity across all memory tools.
- **`workspace_id`**: Canonical git repo dir name (e.g., `agent-brain`), lowercased. Worktree-stable — worktree session resolves same value as main checkout.

### When to Call `memory_search`

Hook auto-fires on substantive prompts (see Auto-Recall Hook). Manual call STILL required when:

1. Hook skipped prompt (≤ 20 chars, single token, slash command).
2. Mid-conversation new symptom emerges (CI failure error string, lockfile/dep friction, local-vs-CI divergence, "this should work but doesn't"). Search literal error/symptom string before proposing fix.
3. Index row title overlaps task — `memory_get(id)` for row, OR `memory_search` for adjacent topics.
4. Reasoning about unfamiliar codebase area — even no obvious match.
5. About to act on shared system: deploys, DB migrations, lockfile changes, hooks config, CI workflows, credential rotation, integration tests.

**Hard rule:** before proposing fix to any failure (CI, build, deploy, lockfile, runtime), call `memory_search` with literal symptom phrase. Cheap; misses expensive.

For specific entry by id, use `memory_get`.

**Do NOT search for purely local actions** (file edits, dependency installs, local builds, linting, formatting) UNLESS index suggests relevant memory.

### Saving Memories

Goal: nothing valuable lost when conversation ends. Includes team knowledge, user preferences, project context, things learned about codebase.

Save memory (or suggest) when encounter:

- Decision + rationale (architecture, tooling, approach)
- User preference how want you work
- Gotcha, workaround, non-obvious constraint
- Important project context useful future session

No need ask permission every memory — use judgment. Clearly worth keeping → save direct. Uncertain → suggest briefly, let user confirm.

### Writing Style

Terse. Drop articles/filler/hedging. Fragments OK. Preserve verbatim:

- code, paths, commands, error strings, identifiers
- `**Why:**` / `**How to apply:**` structure for feedback/project memories

No hard length cap — complex memories get space needed.

### Choosing `source`

Every save pick exactly one of three values:

- `manual` — user explicitly told you save this, most recent message ("remember X", "save that", "note that Y"). Bypasses write budget + project-scope guard. Do **not** use `manual` for things you decided to save yourself, even if feel important.
- `agent-auto` — you decided autonomously during live conversation. Default for anything initiated mid-session.
- `session-review` — **only** when Stop-hook end-of-session review triggering context. Never mid-session, never because user asked.

Quick test: "did user tell me save this, right now, in most recent message?" Yes → `manual`. No, Stop hook running → `session-review`. Else → `agent-auto`.

### Choosing Scope

Default **narrowest applicable scope** to reduce blast radius:

- `workspace` — shared within current workspace (default)
- `user` — private to user within current workspace
- `project` — cross-workspace, visible everywhere

Memory looks like global preference (e.g. uses "always", "never", "everywhere", or workflow rule not tied to specific repo) → **ask user** whether apply globally (`project` scope) or current workspace only. Do not assume global.

### Verifying Memories

Encounter memory during work + confirm still accurate → call `memory_verify`. Boosts older memories still relevant, informs future cleanup/consolidation, builds user confidence in knowledge base.

### Session End

Stop hook prompts review session for important memories before termination. Follow guidance — no extra instructions here.

### Presenting Memories

Always **number** memories, include **author**, **date**, **title**. User may refer by number (e.g. "archive memory 2", "comment on 1"). When you cite a memory id in your own reply prose (not when reproducing an index/auto-recall row) → render as markdown link whose **visible text is bare id**, **target is absolute `file://` URL**: `[<id>](file://<abs-workspace-path>/.agent-brain/cache/<id>.md)` (e.g. `file:///Users/you/project/.agent-brain/cache/<id>.md`). User sees only id, clicks to open full memory in editor (cache hooks materialize file). Do NOT print raw path as visible text. Do NOT print bare id without link. NEVER relative or scheme-less target — relative OSC 8 hyperlink target makes macOS throw `-50` paramErr popup on click; `file://` scheme + absolute path mandatory. (Index/recall lines use _bare_ absolute path, no scheme: injected as plain text terminal auto-linkifies; authored markdown link becomes OSC 8 hyperlink → needs explicit `file://` scheme.)

### Memory Flags

Session start `flags` array = consolidation engine issues.

**Trigger:** first response of session (even greeting/idle ping). Don't wait for explicit task.

**Autonomous background resolution.** Actionable items exist (any count — one or many) → spawn ONE `memory-housekeeper` subagent with `run_in_background: true`, passing flag IDs + types + attached memory IDs and proposed relationship IDs + endpoint memory IDs. Do NOT wait, Do NOT ask user confirm — answer user's actual request immediately. Housekeeper investigates + applies every item autonomously, returns compact receipt as task-notification. Relay one-line ack when lands; show full decision list only if asked.

**Conservative bias (housekeeper applies this):** `verify` only when claim confirmed from codebase/endpoints, else `dismiss`; `duplicate`/`superseded` → `archive` when clearly redundant, else `dismiss`. Accept relationship only when type matches endpoints, else reject. Zero items pending after run.

**Undo (safety model):** every call reversible — `flag_reopen` re-opens resolved flag; `relationship_repropose` returns accepted/rejected relationship to `proposed`. Catch wrong call by reopening/reproposing.

**No-subagent fallback:** client cannot spawn subagents → perform SAME investigate-and-apply pass inline, autonomously, same conservative rules. No confirmation step.

**During normal work:** flagged memory encountered → mention flag, recommend resolution in context.

### Pending Relationships

SessionStart preview surfaces count; full list in `.agent-brain/index.md` under `## Proposed relationships (pending your review)`. Resolved by SAME autonomous background `memory-housekeeper` dispatch as Memory Flags above — included in that one dispatch, applied without confirmation. Conservative bias: accept when relationship type matches endpoints, else reject. Reversible via `relationship_repropose`.
<!-- agent-brain:end -->
