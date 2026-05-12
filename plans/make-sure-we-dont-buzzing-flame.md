# Strip `null` Properties From Response Payloads

## Context

Agent-brain emits JSON responses through two HTTP surfaces:

1. **MCP Streamable HTTP** at `POST /mcp` — consumed by MCP clients (Claude Code, etc.). Envelopes are serialized inside `toolResponse()` via `JSON.stringify(envelope)` and wrapped as `content[{type:"text", text}]`.
2. **REST "hook API"** at `POST /api/tools/:toolName` (plus `GET /health`) — consumed by shell hooks that can't speak MCP (e.g. `~/.claude/hooks/memory-session-start.sh`). Responses go through Express 5 `res.json(...)`.

Both emit nullable fields verbatim today (`verified_at: null`, `archived_at: null`, `tags: null`, `metadata: null`, `session_id: null`, etc.) across `Memory`, `Relationship`, `FlagResponse`, and `EnvelopeMeta` shapes. That noise balloons the `memory-session-start.sh` hook payload past Claude Code's ~2KB `additionalContext` preview budget (see memory `UhPeYgeER8c0Zaqqiny9Q`), wastes tokens for MCP clients, and muddies the public contract.

Goal: JSON responses omit any key whose value is `null`. Consistent across both surfaces. No new dependencies.

## Approach

Single shared `JSON.stringify` replacer, applied at both boundaries.

The replacer returns `undefined` for `null` values, which JSON.stringify omits from output. Called recursively at every depth by the engine, so nested nulls (inside `data[].metadata`, `meta.team_activity`, `flags[]`, `relationships[]`) are dropped too — one function, full coverage.

`undefined` values already disappear via `JSON.stringify` default behavior; no change needed there.

### Files to change

**New**

- `src/utils/json-replacer.ts` — export `stripNullsReplacer(_key, value)`. One-liner: `value === null ? undefined : value`. Plus brief JSDoc noting array-item caveat (returning `undefined` for array items serializes as `null`; not triggered here because nulls never appear as array items in our envelopes — only as object props).

**Modify**

- `src/tools/tool-utils.ts:9` — change `JSON.stringify(envelope)` → `JSON.stringify(envelope, stripNullsReplacer)` inside `toolResponse()`. The `toolError` path (line 22) has no nulls, no change needed, but apply replacer for consistency (cheap).
- `src/server.ts` — after `createMcpExpressApp()` (line 173), add `app.set("json replacer", stripNullsReplacer)`. Express 5 honors this for all `res.json()` calls — covers `src/routes/api-tools.ts` (~13 sites) and `src/routes/health.ts` in one line. No per-route edits.

### Why not the alternatives

- **Per-route mapper / DTO layer**: would require touching every `res.json(result)` site and every `toolResponse(envelope)` call; high churn, easy to miss one. Replacer is centralized.
- **Strip before serialization** (walk object, delete keys): mutates service-returned data, breaks if anything else reads it; slower; reinvents what `JSON.stringify` already does via replacer.
- **Type-level change** (remove `| null` from Memory/Relationship/etc.): changes internal representation; service/repo layers rely on `null` from Drizzle + vault reads. Keep internal types honest, strip only at the wire.

### Service-level tests unaffected

Integration tests under `tests/integration/` call services directly (`memoryService.create(...)`, `relationshipService.listForMemories(...)`) and inspect the returned object before any JSON round-trip. Those still see `null`. Only tests that serialize via `toolResponse` or `res.json` will observe stripped keys. A quick grep shows no `supertest`/HTTP-client integration tests exist today, so no existing integration-test assertions need updating.

### New tests

- `tests/unit/json-replacer.test.ts` (new) — unit test for `stripNullsReplacer`:
  - drops top-level `null` keys
  - drops nested `null` keys inside objects and arrays-of-objects
  - keeps `0`, `false`, `""`, `[]`, `{}`
  - leaves non-null `Date` ISO serialization untouched (Date → string via default `toJSON`)
  - preserves `undefined` omission (already default)
- `tests/integration/response-serialization.test.ts` (new, small) — spins up the Express app with a stub backend (reuse existing test harness if present; otherwise mount router manually) and asserts:
  - `POST /api/tools/memory_create` response body (via `fetch` or supertest-equivalent) has no `null` values at any depth
  - `POST /mcp` → `toolResponse`-wrapped text also null-free after `JSON.parse(content[0].text)`
  - Specifically: create a memory without `tags`/`source`/`session_id`/`metadata`, verify those keys are absent (not present-and-null) in both surfaces.

If `supertest` isn't already a devDep, use Node's native `fetch` against `app.listen(0)` on an ephemeral port — avoids adding a dep for one test file.

## Verification

1. `npm run typecheck` — confirm no TS breakage (replacer return type compatible with `JSON.stringify` signature).
2. `npm test` — all existing tests still pass (service-level unaffected; no integration test touches HTTP today).
3. New unit test `tests/unit/json-replacer.test.ts` passes.
4. New HTTP-level integration test passes against both surfaces.
5. Manual smoke — run `npm run dev`, then:
   ```
   curl -s -X POST http://localhost:19898/api/tools/memory_list \
     -H 'Content-Type: application/json' \
     -d '{"workspace_id":"agent-brain","user_id":"chris","limit":3}' \
     | jq '.data[0]'
   ```
   Expect no `"verified_at": null` / `"archived_at": null` / etc.
6. Sanity: re-run `echo '{}' | ~/.claude/hooks/memory-session-start.sh | wc -c` after deploy — byte count should drop noticeably (fewer null keys).

## Out of scope

- Changing TS types (e.g. removing `| null`). Wire-contract fix only.
- Stripping zero-value numeric counters (`comment_count: 0`, `flag_count: 0`). Separate concern — memory `ABpJojErGrmV0rV7qGiFj` tracks a related sessionStart zero-filter bug; resolve independently.
- Stripping empty arrays/objects. Only `null` per the request.
