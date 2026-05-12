# Centralize installer harness paths/filenames into shared config (Issue #76)

## Context

Installer target files (`scripts/installer/targets/{claude,copilot,vscode-copilot}.ts`) and the uninstaller hardcode harness-specific paths and filenames as string literals scattered across multiple sites: `.claude`, `.copilot`, `settings.json`, `hooks.json`, `mcp-config.json`, `mcp.json`, `CLAUDE.md`, `copilot-instructions.md`, snippet source paths under `hooks/{claude,copilot,vscode-copilot}/`, and the VS Code user data directory.

When a path moves (recent example: vscode-copilot hooks migrated from `~/.copilot/hooks/hooks.json` to `~/.claude/settings.json` — commit `80b4210`), every literal must be hand-edited across 4+ files. The fix is mechanical: pull all harness-specific path/filename constants into `scripts/installer/paths.ts` and import from there. Pure refactor, zero behavior change, existing tests must pass unchanged.

## Approach

Create `scripts/installer/paths.ts` exporting all harness path constants and the two existing path helpers. Update the four call sites to import from it. No new abstractions — flat exports grouped by section.

### New file: `scripts/installer/paths.ts`

Sections (flat exports, no nested namespace objects — keeps grep-ability):

```ts
// Config directories (relative to $HOME)
export const CLAUDE_CONFIG_DIR = ".claude";
export const COPILOT_CONFIG_DIR = ".copilot";
export const HOOKS_SUBDIR = "hooks";

// Config filenames
export const CLAUDE_SETTINGS_FILE = "settings.json";
export const CLAUDE_INSTRUCTIONS_FILE = "CLAUDE.md";
export const COPILOT_MCP_CONFIG_FILE = "mcp-config.json";
export const COPILOT_HOOKS_CONFIG_FILE = "hooks.json";
export const COPILOT_INSTRUCTIONS_FILE = "copilot-instructions.md";
export const VSCODE_MCP_FILE = "mcp.json";
export const VSCODE_SETTINGS_FILE = "settings.json";
export const VSCODE_HOOKS_FILE = "hooks.json";

// Snippet source dirs (under repoRoot)
export const HOOKS_SRC_ROOT = "hooks";
export const CLAUDE_SNIPPETS_DIR = "claude";        // hooks/claude/
export const COPILOT_SNIPPETS_DIR = "copilot";      // hooks/copilot/
export const VSCODE_SNIPPETS_DIR = "vscode-copilot"; // hooks/vscode-copilot/

// Snippet filenames
export const CLAUDE_SETTINGS_SNIPPET = "settings-snippet.json";
export const CLAUDE_MD_SNIPPET = "claude-md-snippet.md";
export const COPILOT_MCP_SNIPPET = "mcp-snippet.json";
export const COPILOT_HOOKS_SNIPPET = "hooks.json";
export const COPILOT_INSTRUCTIONS_SNIPPET = "instructions-snippet.md";
export const VSCODE_MCP_SNIPPET = "mcp-snippet.json";
// vscode-copilot reuses copilot's instructions-snippet.md (deliberate reuse)

// VS Code config keys
export const VSCODE_CHAT_HOOK_LOCATIONS_KEY = "chat.hookFilesLocations";

// Marker id (single source of truth — currently hardcoded as "agent-brain"
// in 3 separate makeMarkerId() calls)
export const MARKER_ID_BASE = "agent-brain";

// Platform helpers (moved from vscode-copilot.ts)
export function vscodeUserDataDir(home: string): string { /* same body */ }
export function toTildePath(absolutePath: string, home: string): string { /* same body */ }
```

`HOOK_SCRIPTS` arrays stay where they are (`targets/claude.ts`, `targets/copilot.ts`) — they're target-specific identity, not paths, and `uninstall.ts` already imports them by name.

### Files to modify

| File | Changes |
|------|---------|
| `scripts/installer/paths.ts` | **New.** All constants + `vscodeUserDataDir` + `toTildePath` (moved from vscode-copilot.ts) |
| `scripts/installer/targets/claude.ts` | Replace `.claude`, `hooks`, `settings.json`, `CLAUDE.md`, `hooks/claude/...` literals with imports |
| `scripts/installer/targets/copilot.ts` | Replace `.copilot`, `hooks`, `mcp-config.json`, `hooks.json`, `copilot-instructions.md`, `hooks/copilot/...` literals |
| `scripts/installer/targets/vscode-copilot.ts` | Import `vscodeUserDataDir`/`toTildePath` from paths.ts (delete local copies); replace `mcp.json`, `settings.json`, `hooks.json`, snippet literals, `chat.hookFilesLocations` key |
| `scripts/installer/uninstall.ts` | No literal changes needed — operates on plan output; only touch if `chat.hookFilesLocations` literal appears (it doesn't — only test files reference it) |

### What stays put

- `HOOK_SCRIPTS` arrays in each target (target-specific contract, already importable).
- Inline VS Code event names (`SessionStart`, `PreToolUse`, `Stop`) — these are PascalCase event identifiers in the VS Code hook config schema, not paths. Out of scope for #76.
- Marker comment format `<!-- ${id}:start -->` in `uninstall.ts:117-119` — formatting concern, not a path.
- Hook script command quoting in `vscode-copilot.ts:73-94` — shell-safety concern, not a path.

### Reused existing helpers

- `makeMarkerId()` from `scripts/installer/types.ts` — keep using; called with `MARKER_ID_BASE` constant instead of inline `"agent-brain"`.
- `vscodeUserDataDir()` / `toTildePath()` — relocate from `vscode-copilot.ts:14-32` to `paths.ts`. Same signatures, no behavior change.
- `node:path` `join` — continue to use at call sites; `paths.ts` exports raw segment strings, not pre-joined paths (callers already mix `home`/`repoRoot` with segments and `join` handles platform separators).

## Verification

1. **Type check** — `npm run typecheck` (or `tsc --noEmit`) passes.
2. **Unit tests pass unchanged** — refactor must not require test updates:
   - `tests/unit/installer/targets.test.ts` — validates exact paths in plan output
   - `tests/unit/installer/uninstall.test.ts` — validates cleanup
   - `tests/unit/installer/install.test.ts` — full install flow
   - `tests/unit/installer/roundtrip.test.ts` — install → uninstall → install
   - `tests/unit/installer/merge-{json,markdown}.test.ts`
   Run: `npm test -- tests/unit/installer/`
3. **Lint** — `npm run lint` clean.
4. **Manual sanity** — dry-run install for each target, diff against `main`:
   - `node scripts/installer/cli.js install claude --dry-run`
   - `node scripts/installer/cli.js install copilot-cli --dry-run`
   - `node scripts/installer/cli.js install vscode-copilot --dry-run`
   Output must be byte-identical to pre-refactor output.
5. **Grep audit** — after refactor, these greps should return zero hits in `scripts/installer/targets/`:
   - `grep -rn '"\.claude"' scripts/installer/targets/`
   - `grep -rn '"\.copilot"' scripts/installer/targets/`
   - `grep -rn '"settings\.json"' scripts/installer/targets/`
   - `grep -rn '"CLAUDE\.md"' scripts/installer/targets/`
   - `grep -rn '"copilot-instructions\.md"' scripts/installer/targets/`

## Out of scope

- Changing test files (refactor is internal-only; tests assert observable behavior which is unchanged).
- Restructuring `HOOK_SCRIPTS` arrays.
- Adding env-var overrides for paths.
- Touching `scripts/installer/uninstall.ts` strip logic (#48 has separate items for that area).
