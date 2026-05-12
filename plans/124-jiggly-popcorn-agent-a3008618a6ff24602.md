# PR #124 Review — fix(vault): prune orphaned lance rows that have no markdown file

Branch: `fix/lance-drift-prune` -> `main`

Files reviewed:
- /Users/chris/dev/agent-brain/src/backend/vault/repositories/memory-repository.ts (lines 975-988)
- /Users/chris/dev/agent-brain/src/backend/vault/vector/lance-index.ts (lines 213-223)
- /Users/chris/dev/agent-brain/src/backend/vault/watcher/reconciler.ts (lines 303-323)
- /Users/chris/dev/agent-brain/tests/unit/backend/vault/watcher/reconciler.test.ts (lines 43-47)

Cross-checked callers: /Users/chris/dev/agent-brain/src/backend/vault/watcher/boot-scan.ts (sole caller of archiveOrphans), /Users/chris/dev/agent-brain/src/backend/vault/index.ts (runBootScan invoked pre-listen, line 320).

## Verdict

No critical (>=90) issues found. Two important findings (>=80) plus one borderline observation. Code meets CLAUDE.md style.

---

## Important issues (80-89)

### 1. Self-heal in `findNearestNeighbors` is an unawaited promise mid-loop — confidence 82
- File: /Users/chris/dev/agent-brain/src/backend/vault/repositories/memory-repository.ts:980-987
- The fire-and-forget `markArchived(h.id).catch(...)` runs concurrently with the rest of the for-loop, which then calls more `await this.findById(...)` on `lance hits`. Lance writes typically take a table lock; firing N of them in parallel from a hot read path can:
  - Surface unexpected lance contention/lock errors that weren't possible before this PR.
  - Cause the orphan to STILL be returned by the same in-flight `searchAllInProject` call's already-fetched `rawHits` (it was — but consecutive calls within the same tick can still race).
  - Leave an unhandled rejection if `logger.error` itself throws (very unlikely but the `.catch` body is unguarded).
- Lower-risk alternatives:
  - Collect drift IDs into a `driftIds: string[]` and `await Promise.all(driftIds.map(id => vectorIndex.markArchived(id).catch(log)))` after the loop.
  - Or just log and let the boot-scan/`archiveOrphans` second pass clean it up — that pass exists now, so the self-heal here is defence in depth, not load-bearing.
- Suggested fix: defer the markArchived calls until after the for-loop completes, then fire them in parallel with one combined `await Promise.allSettled(...)`. Or drop the self-heal entirely and rely on the new `archiveOrphans` second pass plus the existing `findById` filter.

### 2. `archived.includes(id)` is O(n) — confidence 80
- File: /Users/chris/dev/agent-brain/src/backend/vault/watcher/reconciler.ts:309
- The user flagged this. It is genuinely O(n*m) where n = lance-active rows and m = orphans archived in pass 1. In a realistic deployment (a few thousand memories, low orphan count) this is fine — m is usually 0 or single digits, so the `includes` check effectively returns immediately.
- However: the cost case is exactly when this code matters most, namely a vault reset where lance has thousands of rows and pass 1 archives many of them. There the second pass is O(n) and `includes` adds a constant-factor overhead per iteration.
- Suggested fix (low effort, no behaviour change):
  - Build `const archivedSet = new Set(archived);` before the second loop, then `if (archivedSet.has(id)) continue;`.
  - Equivalent style and matches the snapshot pattern already used at line 283 (`Array.from(... .entries())` to avoid mutation-during-iteration).

---

## Lower-confidence / borderline (reported only for visibility)

### 3. `listAllActiveIds` ordering and pagination — confidence 70 (NOT reported as required action)
- File: /Users/chris/dev/agent-brain/src/backend/vault/vector/lance-index.ts:216-223
- The query has no `.limit()` and reads all active rows into memory at once. For the current scale (a few thousand memories) this is fine; lancedb's `toArray()` materialises all rows. If the vault grows large this becomes a memory spike at boot. Not a defect today; flagging only because the comment notes "true drift where the row was never registered" — that pre-supposes drift is small, but a vault-reset scenario could mean *every* lance row is drift and you load them all. Acceptable trade-off given boot-scan already does an O(n) walk through `vaultIndex.entries()`.

---

## Answers to the focused questions

1. **Correctness of orphan-prune logic**: Correct. Pass 1 archives `vaultIndex` entries whose disk file is missing; pass 2 archives lance rows whose id is unknown to `vaultIndex`. Both passes converge on the same target set. Failures keep `vaultIndex` intact for retry. The combined `archived[]` is returned, so callers see a unified count. Logic is sound.

2. **`archived.includes(id)` O(n)**: Real concern in vault-reset scenarios; recommend swapping for a `Set<string>` (issue #2 above). Confidence 80.

3. **`VaultVectorIndex` concrete-class dep type**: Not a problem in this codebase. Already the pattern used by `ReconcilerDeps`, `MemoryRepositoryConfig`, and `session-start.ts`. Tests stub it via `as unknown as Parameters<typeof createReconciler>[0]["vectorIndex"]` (line 107-109 of the test file), which is exactly how the existing tests already escape the concrete-class constraint. The new `listAllActiveIds` method is correctly added to `StubVectorIndex` (test lines 43-47). No issue.

4. **CLAUDE.md style compliance**:
   - No new doc files created. Pass.
   - File sizes: `reconciler.ts` is now 340 lines, `lance-index.ts` ~hundreds, `memory-repository.ts` is large but unchanged structurally. All under the 500-line limit (or unchanged from prior state). Pass.
   - Comments are explanatory, not noisy. The block comment at reconciler.ts:303-305 explains *why* (vault reset / out-of-band deletion) — good. The comment at lance-index.ts:213-215 explains the same intent at the producer side — good.
   - "No over-engineering": pass. The fix is minimal: one new method, one second-pass loop, one self-heal call.

5. **Edge cases**:
   - **Concurrent calls**: `archiveOrphans` is only called from `runBootScan` (boot-scan.ts:49), and `runBootScan` runs before the watcher listens and before HTTP opens (vault/index.ts:320 vs the listener that comes later). So no concurrent live writes during the second pass. Safe.
   - **`vaultIndex` registers an ID mid-loop**: Cannot happen during boot — the only writers to `vaultIndex` during boot are `reconcileFile` calls in pass 0 (boot-scan.ts:29) which complete *before* `archiveOrphans` runs (boot-scan.ts:49). The `vaultIndex.get(id) !== undefined` check at reconciler.ts:308 is therefore a stable read. Safe.
   - **`listAllActiveIds` returns a fresh row that pass 1 just archived**: Pass 1 archives via `markArchived` (sets `archived = true`), then pass 2 queries `where archived = false`, so pass-1-archived rows are excluded from the lance result anyway. The `archived.includes(id)` guard at line 309 is therefore mostly defensive — it only trips on the (impossible?) case where pass 1 reported success in `archived[]` but the lance row was never actually flipped. Still worth keeping as belt-and-braces, but the caller should know it's the unlikely path.
   - **Self-heal in `findNearestNeighbors` runs while the same call is still iterating**: see issue #1.
   - **`listAllActiveIds` returns IDs that contain SQL injection metacharacters**: Not a risk — IDs come from prior `upsert`s, and `markArchived` itself uses `sqlStr(id)` (lance-index.ts:230). Already safe.

---

## Suggested patch summary (NOT applied; plan mode)

Two small changes, both in /Users/chris/dev/agent-brain/src/backend/vault/watcher/reconciler.ts and /Users/chris/dev/agent-brain/src/backend/vault/repositories/memory-repository.ts:

```ts
// reconciler.ts, before the second-pass for-loop
const archivedSet = new Set(archived);
for (const id of activeIds) {
  if (this.deps.vaultIndex.get(id) !== undefined) continue;
  if (archivedSet.has(id)) continue;
  ...
  archivedSet.add(id);   // optional, only matters if multiple loops grow
  archived.push(id);
}
```

```ts
// memory-repository.ts findNearestNeighbors — defer self-heals
const driftIds: string[] = [];
for (const h of hits) {
  ...
  if (m === null) {
    logger.warn(...);
    driftIds.push(h.id);
    continue;
  }
  ...
}
if (driftIds.length > 0) {
  await Promise.allSettled(
    driftIds.map((id) =>
      this.cfg.vectorIndex.markArchived(id).catch((err) =>
        logger.error(`...self-heal failed for ${id}`, { err }),
      ),
    ),
  );
}
```

Both changes are small, reversible, and improve correctness/perf without changing semantics.
