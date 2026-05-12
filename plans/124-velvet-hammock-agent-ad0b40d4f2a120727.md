# PR #124 Review — `fix/lance-drift-prune`

Reviewing: orphan-row pruning across `archiveOrphans`, `findNearestNeighbors` self-heal, and the new `listAllActiveIds`.

Files in scope:
- `/Users/chris/dev/agent-brain/src/backend/vault/repositories/memory-repository.ts`
- `/Users/chris/dev/agent-brain/src/backend/vault/vector/lance-index.ts`
- `/Users/chris/dev/agent-brain/src/backend/vault/watcher/reconciler.ts`
- `/Users/chris/dev/agent-brain/tests/unit/backend/vault/watcher/reconciler.test.ts`

Context confirmed:
- `archiveOrphans` is invoked from `runBootScan` (boot-scan.ts:49) before HTTP listen, so the second pass runs in a single-writer window — concurrent-modification risk is small at boot.
- `findNearestNeighbors` runs at request time, fully concurrent with other vault ops.
- The reconciler depends on the concrete `VaultVectorIndex` class, so adding `listAllActiveIds` does not require an interface update.

## Findings

### Important (80–89)

- `src/backend/vault/watcher/reconciler.ts:309`: Important: `archived.includes(id)` makes the second-pass loop O(n*m) where `n = active lance rows` and `m = vault-index orphans`. At a healthy vault these arrays diverge (first-pass `archived` are vaultIndex-known orphans; second-pass `activeIds` are vaultIndex-unknown), so they should never overlap. The guard is defensive. With 10K rows this still walks `archived` for every active id and is wasteful; either switch to `const archivedSet = new Set(archived)` before the loop and check `archivedSet.has(id)`, or drop the guard and rely on the `vaultIndex.get(id) !== undefined` filter (the only path into `archived` from the first pass is via the vaultIndex iteration, so any id reaching the second pass with a `vaultIndex.get(id) === undefined` cannot be in `archived`). Fix: replace with `Set` lookup or remove the redundant check.

- `src/backend/vault/vector/lance-index.ts:216`: Important: `listAllActiveIds()` materialises every active id into memory in one shot. At 10K+ rows on boot this is one allocation of ~10K small strings (UUIDs ≈ 36 bytes → ~0.4 MB), which is fine; at 1M+ it becomes a real concern, and there is no streaming path. There is no `LIMIT`, no batching, and the result is iterated linearly afterwards. Fix at minimum: add a `// O(n) memory; acceptable up to ~100K rows` comment, and consider exposing an async iterator (`for await ... of this.table.query()...`) for future scale. At current sizes this is acceptable but should be documented. (Not blocking.)

- `src/backend/vault/repositories/memory-repository.ts:980`: Important: the fire-and-forget `markArchived` is unawaited on a hot read path, which means: (1) the same drifted id can race through the loop multiple times across concurrent `findNearestNeighbors` calls, each issuing its own `markArchived` write — these are idempotent at the lance layer (update-where-archived=false → 0 rows on second call) so correctness holds, but every concurrent caller pays the write cost on the first hit; (2) the promise is detached from the request lifetime, so if the process exits between detection and write completion, the row will resurface next request — acceptable as best-effort self-heal. The bigger concern is rejection masking: lance write failures during request handling now log via `logger.error` but do not propagate, which is the intended behaviour of self-heal. Confirm the `logger.error` call site here is the only signal an operator gets — if there is no metric/alert on this log line, drift may persist silently. Fix: either add a counter (`metrics.increment("vault.drift.self_heal_fail")`) or accept and document the silent best-effort contract.

- `src/backend/vault/repositories/memory-repository.ts:980`: Important: the self-heal fires for every `findById === null` case, but the comment one block up (line 971-974) admits this branch is also taken for **archived** memories (not only drift). For an already-archived memory, `markArchived` will succeed with `rowsUpdated === 0` (lance update predicate `archived = false` finds nothing) — the call is wasted but harmless. However, the warning log in line 976-978 will continue to fire on every search until you also exclude archived rows from the lance query itself. Verify `searchAllInProject` filters `archived = false`; if it does, this branch is only ever drift and the wording in 977 should drop "(archived or drift)". If it does not, the self-heal does nothing for archived rows (they already have `archived=true`) and the log will spam. Fix: confirm `searchAllInProject` predicate, then narrow the log message.

- `src/backend/vault/watcher/reconciler.ts:306`: Important: `listAllActiveIds()` is called after the first-pass loop has already written `markArchived` for vaultIndex orphans. Lance `update()` is not transactional with the subsequent `query().where("archived = false")` — but since the first pass also archives those ids, they are correctly excluded from the second-pass active list. The order is correct. However, if a `markArchived` call in the first pass **failed** (pushed to `failed`), the row remains active and `vaultIndex.unregister` did not run, so `vaultIndex.get(id) !== undefined` will be true and the second pass will skip it. Good. But: a race where `reconcileFile` is concurrently inserting a new row whose markdown was written to disk after `runBootScan` snapshotted `diskPaths` — the second pass will see it as "active without vaultIndex entry" and prune it. Boot-scan runs pre-listen, so external writes are blocked, but watcher events that fire mid-boot are not. Verify the watcher does not start until after `runBootScan` resolves; if it can fire concurrently, this is a real data-loss bug (newly-created memory archived seconds after creation). Fix: confirm watcher start ordering in `vault/index.ts`; if concurrent, gate the second pass behind a "watcher idle" check or capture `activeIds` before any concurrent writer can run.

### Style / CLAUDE.md compliance

- No CLAUDE.md violations spotted. Files stay under 500 lines, no new docs/scripts at root, input is internal so no new boundary validation needed, existing logger pattern reused, no secrets.

## Items to verify before merge

1. `searchAllInProject` lance predicate includes `archived = false` — confirm in `lance-index.ts`. If yes, narrow the warn message at memory-repository.ts:977. If no, the self-heal is a no-op for already-archived rows.
2. Watcher start ordering — does `runBootScan` complete before the chokidar/fs watcher starts emitting? If not, the second pass can prune freshly-created rows.
3. `archived.includes(id)` — confirm it cannot trigger (first-pass ids always have `vaultIndex.get(id) !== undefined`); either drop or switch to `Set`.

## Suggested patch shape (not applied — plan mode)

```ts
// reconciler.ts:303-323
const archivedSet = new Set(archived);
const activeIds = await this.deps.vectorIndex.listAllActiveIds();
for (const id of activeIds) {
  if (this.deps.vaultIndex.get(id) !== undefined) continue;
  if (archivedSet.has(id)) continue; // defence-in-depth; should be unreachable
  ...
}
```
