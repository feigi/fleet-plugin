## Response Style

Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].

<!-- agent-brain:start -->
## Memory System

User use [agent-brain](https://bmw.ghe.com/CoCo/agent-brain) (MCP server) as sole memory system, all projects. Do NOT use Claude Code built-in file auto-memory (`~/.claude/projects/**/memory/`). All memory ops via agent-brain MCP tools. Never write MEMORY.md or create files in memory/ dir.

**Routing:** agent-initiated reads/writes — `memory_search`/`memory_get`/`memory_list`/`memory_list_recent`/`memory_list_stale`/`memory_create`/`memory_update` — are dispatched to the `memory-proxy` subagent; never call those tools directly from the main thread. The proxy returns condensed markdown + `<abs-project-dir>/.agent-brain/cache/<id>.md` links; `Read` the cache file for a full body. Slim ops that return no payload (`verify`, `resolve_flag`, `relationship_*`, `archive`) and the recall/session-start hooks stay direct. `history`/`relationships` are deferred (different render shape).

### Loading Memories

Two hooks feed you memories; both are lazy pointers, not bodies.

- **SessionStart** writes an index to `.agent-brain/index.md` — one row per memory, `<id> [<type>] [{tags}] — <title>` (`[{tags}]` omitted when the memory has none; scope from the section header), each ending in the absolute path of its cached body.
- **UserPromptSubmit** auto-runs `memory_search` on substantive prompts (length > 20, multi-token, not slash) and injects the top matches as `additionalContext`.

Either surface overlaps the user's topic — even weakly — → dispatch `memory-proxy` (it runs `memory_get(id)` and writes the cache), then `Read` the cache file BEFORE answering. Prefer false positives (fetch one irrelevant) over misses (skip a load-bearing memory). Keep fetched bodies in context for the rest of the session.

No `additionalContext` line on a substantive prompt → the hook is unreachable (server down, port wrong); fall back to manual `memory-proxy` (`search`).

### When to Call `memory_search`

The prompt hook covers the opening ask, so search when the hook could not have: a prompt it skipped (≤ 20 chars, single token, slash command), a symptom that emerged mid-conversation, an index row you want the neighbours of, an unfamiliar area of the codebase, or before acting on a shared system (deploys, migrations, lockfiles, hooks config, CI, credentials, integration tests).

**Hard rule:** before proposing a fix to any failure (CI, build, deploy, lockfile, runtime), search the literal error/symptom string. Cheap; misses expensive.

Skip search for purely local actions (file edits, dependency installs, local builds, linting, formatting) unless the index suggests otherwise.

### Identity Parameters

- **`user_id`**: OS username, output of `whoami`, slugified (`First.Last` → `first-last`).
- **`workspace_id`**: canonical git repo directory name, slugified — lowercase alphanumeric and hyphens (`~/.claude` → `claude`, `my_repo` → `my-repo`). Worktree-stable.

Auto-filled by the `memory-autofill.sh` PreToolUse hook — `workspace_id` always, `user_id` unless derivation fails (it fails closed rather than guess). Supply them explicitly when the hook is not installed.

### Saving Memories

Goal: nothing valuable lost when conversation ends — team knowledge, user preferences, project context, things learned about the codebase. Save (or suggest) a decision + rationale, a preference for how you work, a gotcha or non-obvious constraint, project context a future session needs. Judgment call, not a permission request: clearly worth keeping → save; uncertain → suggest briefly.

### Writing Style

Terse. Drop articles/filler/hedging. Fragments OK. Preserve verbatim:

- code, paths, commands, error strings, identifiers
- `**Why:**` / `**How to apply:**` structure for feedback/project memories

No hard length cap — complex memories get space needed.

Wikilinks: body link target = memory **id**, `[[<id>]]` (auto-aliases → `[[slug|id]]`). Never `[[slug]]`/`[[Title]]` — resolver id-only, slug-link never resolves + warns every write. Literal `[[…]]` docs in backticks.

### Choosing `source`

- `manual` — user explicitly told you to save this, in their most recent message ("remember X", "save that"). Bypasses write budget + project-scope guard. Not for your own inferences, however important they feel.
- `agent-auto` — you decided autonomously mid-session. Default.
- `session-review` — **only** under the Stop-hook end-of-session review. Never mid-session, never because the user asked.

### Choosing Scope

Reason about scope from the content. Absent a strong signal, default to the **active default scope shown at session start** (`Default scope:` line / `index.md`). A strong signal narrows it:

- workspace-specific (this repo's build, paths, CI) → `workspace`
- personal preference private to you → `user`
- universal / cross-workspace knowledge, or an explicit "always / everywhere" instruction → `project`

### Verifying Memories

Encounter a memory during work and confirm it still accurate → call `memory_verify`. Boosts older memories still relevant, informs future cleanup/consolidation.

### Presenting Memories

Always **number** memories, include **author**, **date**, **title** — the user may refer back by number ("archive memory 2"). When you cite a memory id in your own reply prose (not when reproducing an index/auto-recall row) → render a markdown link whose **visible text is the bare id** and whose target is an absolute `file://` URL: `[<id>](file:///Users/you/project/.agent-brain/cache/<id>.md)`. Never print the raw path as visible text, never a bare id, never a relative or scheme-less target — a relative OSC 8 target makes macOS throw a `-50` paramErr popup on click. (Index/recall rows are injected as plain text and auto-linkify, so they carry a bare path instead.)

### Flags and Pending Relationships

Open flags and proposed relationships are surfaced by the SessionStart hook, which carries the dispatch instructions with them — a `## Action required this session` block naming the `memory-housekeeper` subagent. Follow that block when it appears; it is the single source for the procedure. Encounter a flagged memory during normal work → mention the flag and recommend a resolution in context.
<!-- agent-brain:end -->

## Agent skills

### Triage labels

Label string equals role name for all five roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. Neither exists yet; they get created lazily. See `docs/agents/domain.md`.
