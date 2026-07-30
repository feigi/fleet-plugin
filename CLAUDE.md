<!-- agent-brain:start -->
## Memory System

User use [agent-brain](https://bmw.ghe.com/CoCo/agent-brain) (MCP server) as sole memory system, all projects. Do NOT use Claude Code built-in file auto-memory (`~/.claude/projects/**/memory/`). All memory ops via agent-brain MCP tools (`memory_create`, `memory_search`, `memory_update`, etc.). Never write MEMORY.md or create files in memory/ dir.

**Routing:** agent-initiated reads/writes — `memory_search`/`memory_get`/`memory_list`/`memory_list_recent`/`memory_list_stale`/`memory_create`/`memory_update` — are dispatched to the `memory-proxy` subagent; never call those tools directly from the main thread. The proxy returns condensed markdown + `<abs-project-dir>/.agent-brain/cache/<id>.md` links; `Read` the cache file for a full body. Slim ops that return no payload (`verify`, `resolve_flag`, `relationship_*`, `archive`) and the recall/session-start hooks stay direct (no budget benefit from proxying). The `list`/`history`/`relationships` reads return payloads; `list*` is proxied, `history`/`relationships` are deferred (different render shape).

### Session Start

SessionStart hook writes memory index to `.agent-brain/index.md`. User topic overlaps entry title/tag → read file, fetch bodies via `memory-proxy` (it runs `memory_get(id)`, writes the cache), then `Read` the cache file. Row format: `<id> [<type>] [{tags}] — <title>` (`[{tags}]` omitted when no tags; scope from section header). Each row ends ` → <abs-project-dir>/.agent-brain/cache/<id>.md` — absolute clickable path to cached body (resolves regardless of open cwd). No manual `memory_session_start` needed.

### Working with Loaded Memories

Index = lazy lookup table, not bodies. User topic overlaps entry title/tags → dispatch `memory-proxy` (`get`), then `Read` the returned `<abs-project-dir>/.agent-brain/cache/<id>.md` BEFORE answering — even weak overlap. Prefer false positives (fetch one irrelevant) over misses (skip load-bearing memory). Cache fetched bodies in context rest of session.

Fuzzy/semantic matches index miss → dispatch `memory-proxy` (`search`).

### Auto-Recall Hook

UserPromptSubmit hook auto-runs `memory_search` on substantive prompts (length > 20, multi-token, not slash). Top 5 matches above 0.5 similarity injected as `additionalContext` — one line per memory: `<id> [<scope>] <type>{ {tags}} — <title>: <snippet> → <abs-project-dir>/.agent-brain/cache/<id>.md` (absolute path). Treat injected matches as high-priority signal even if SessionStart index missed. Fetch full body via `memory-proxy` (`get`) before acting on match.

No `additionalContext` line for substantive prompt → hook unreachable (server down, port wrong) — fall back to manual search via `memory-proxy`.

### Identity Parameters

- **`user_id`**: OS username, output of `whoami`. User identity across all memory tools.
- **`workspace_id`**: Canonical git repo dir name (e.g., `agent-brain`), lowercased. Worktree-stable — worktree session resolves same value as main checkout.

### When to Call `memory_search`

Manual searches dispatch `memory-proxy` (`search`); hook-driven recall stays direct. Hook auto-fires on substantive prompts (see Auto-Recall Hook). Manual call STILL required when:

1. Hook skipped prompt (≤ 20 chars, single token, slash command).
2. Mid-conversation new symptom emerges (CI failure error string, lockfile/dep friction, local-vs-CI divergence, "this should work but doesn't"). Search literal error/symptom string before proposing fix.
3. Index row title overlaps task — `memory-proxy` (`get`) for row, OR `memory-proxy` (`search`) for adjacent topics.
4. Reasoning about unfamiliar codebase area — even no obvious match.
5. About to act on shared system: deploys, DB migrations, lockfile changes, hooks config, CI workflows, credential rotation, integration tests.

**Hard rule:** before proposing fix to any failure (CI, build, deploy, lockfile, runtime), dispatch `memory-proxy` (`search`) with literal symptom phrase. Cheap; misses expensive.

For specific entry by id, dispatch `memory-proxy` (`get`).

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

Wikilinks: body link target = memory **id**, `[[<id>]]` (auto-aliases → `[[slug|id]]`). Never `[[slug]]`/`[[Title]]` — resolver id-only, slug-link never resolves + warns every write. Literal `[[…]]` docs in backticks.

### Choosing `source`

Every save pick exactly one of three values:

- `manual` — user explicitly told you save this, most recent message ("remember X", "save that", "note that Y"). Bypasses write budget + project-scope guard. Do **not** use `manual` for things you decided to save yourself, even if feel important.
- `agent-auto` — you decided autonomously during live conversation. Default for anything initiated mid-session.
- `session-review` — **only** when Stop-hook end-of-session review triggering context. Never mid-session, never because user asked.

Quick test: "did user tell me save this, right now, in most recent message?" Yes → `manual`. No, Stop hook running → `session-review`. Else → `agent-auto`.

### Choosing Scope

Reason about scope from the content. Absent a strong workspace- or
user-specific signal, default to the **active default scope shown at session
start** (`Default scope:` line / `index.md`). A strong signal narrows it:

- workspace-specific (this repo's build, paths, CI) → `workspace`
- personal preference private to you → `user`
- universal / cross-workspace knowledge, or an explicit "always / everywhere"
  instruction → `project`

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

## Response Style

Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].

## Agent skills

### Issue tracker

Issues live in `feigi/claude-config` GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary — label string equals role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
