# PR #124 Error-Handling Audit Plan

Plan-mode file. No edits performed. Findings delivered in chat.

## Scope
- src/backend/vault/repositories/memory-repository.ts (findNearestNeighbors self-heal)
- src/backend/vault/watcher/reconciler.ts (archiveOrphans second pass)
- src/backend/vault/watcher/boot-scan.ts (caller of archiveOrphans)
- src/backend/vault/watcher/types.ts (BootScanResult)
- src/backend/vault/index.ts (boot wiring into bootMeta)
- src/backend/vault/vector/lance-index.ts (listAllActiveIds, markArchived contract)

## Findings (delivered in chat)
1. CRITICAL: archiveOrphans `failed[]` discarded by boot-scan; not surfaced into BackendSessionStartMeta.
2. HIGH: findNearestNeighbors fire-and-forget self-heal; orphans request, no propagation, no rate limit.
3. HIGH: self-heal triggers on findById==null which conflates drift with parse-errors and already-archived state.
4. MEDIUM: markArchived rowsUpdated contract ignored at all four call sites (1 new, 3 pre-existing).
5. MEDIUM: listAllActiveIds throw at boot will abort runBootScan with no degraded-mode signal.
6. LOW: archived.includes(id) O(N^2) in dedupe check (correctness, not error-handling).
