# Issue #19 — Enforce invariant: project-scoped memories have `workspace_id = NULL`

## Context

`MemoryService.create` passes `input.workspace_id ?? null` verbatim regardless of scope (`src/services/memory-service.ts:168`, `:202`). Project-scoped memories are cross-workspace by semantics, but nothing stops a caller from persisting them with a non-null `workspace_id`. The row is then self-contradictory (`scope=project` says "global", `workspace_id=X` says "scoped to X"). Today no reader consumes `workspace_id` on project-scoped rows — dead data — but it invites bugs: any future query that filters by `workspace_id` will silently exclude or double-count project memories.

Surfaced in PR #18 review: a defensive `isNull(workspace_id)` filter added to `listProjectScoped` broke `tests/integration/relationships.test.ts > full lifecycle` because that test creates a project-scoped memory with `workspace_id: "test-ws"`. The guard was reverted; this issue tracks the real cleanup.

Goal: enforce the invariant at schema and service layer, backfill existing rows, fix the one offending test, and re-add the defensive guard in the repository as defense-in-depth.

## Approach

Five coordinated changes in one PR, ordered so each step is safe on its own:

### 1. Service layer — coerce `workspace_id` to `null` for project scope

File: `src/services/memory-service.ts`

In `MemoryService.create`, after `effectiveScope` is derived (line 88), normalize once:

```ts
const effectiveWorkspaceId = effectiveScope === "project" ? null : (input.workspace_id ?? null);
```

Then replace both verbatim usages:
- Line 168: `workspaceId: effectiveWorkspaceId` in the `findDuplicates` call.
- Line 202: `workspace_id: effectiveWorkspaceId` in the `memoryData` object.

The existing Guard 0a (line 89) already requires `workspace_id` for non-project scope, so the coercion only strips it when the scope says "project". The Guard 0b autonomous-source check (line 99) is unaffected. The "ensure workspace exists" branch at line 148 uses the raw `input.workspace_id` — unchanged — so it still creates the workspace row if the caller happened to pass one even on a project-scope memory (harmless; the workspace row is useful on its own).

No changes needed to `MemoryService.update` (does not touch scope/workspace_id), `archive`, or consolidation paths.

### 2. DB constraint — CHECK in schema + migration

File: `src/db/schema.ts` (memories table, line 79-88)

Add a table-level check constraint inside the `(table) => [...]` array, following the pattern used for `relationships_no_self_ref` at line 250:

```ts
check("memories_project_scope_null_workspace", sql`scope != 'project' OR workspace_id IS NULL`),
```

Then run `npm run db:generate`, which produces `drizzle/0010_<slug>.sql`.

### 3. Data migration — backfill existing rows

Hand-edit the generated `drizzle/0010_*.sql` file (Drizzle will emit only the `ADD CONSTRAINT`, not a backfill). Prepend a statement-breakpoint-delimited UPDATE:

```sql
UPDATE "memories" SET "workspace_id" = NULL WHERE "scope" = 'project' AND "workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_scope_null_workspace" CHECK (scope != 'project' OR workspace_id IS NULL);
```

Order matters: backfill first, then add the constraint, or the `ALTER` fails on existing data.

### 4. Tests — fix the offending create

File: `tests/integration/relationships.test.ts:663`

Drop the `workspace_id: "test-ws"` line from the project-scoped create (lines 662-668). The service will now null it anyway, but leaving it would be misleading. All other project-scoped creates in the test suite already omit `workspace_id` (verified: `session-start.test.ts`, `consolidation.test.ts`, `memory-scoping.test.ts`) — no other test changes needed.

### 5. Repository — re-add defense-in-depth guard

File: `src/repositories/memory-repository.ts:491-506`

In `listProjectScoped`, add `isNull(memories.workspace_id)` to the `and(...)` clause:

```ts
and(
  eq(memories.project_id, options.project_id),
  isNull(memories.archived_at),
  eq(memories.scope, "project"),
  isNull(memories.workspace_id),
),
```

With the CHECK constraint active this is redundant, but makes the invariant visible at the read site and protects against constraint drift on future migrations.

## Files modified

- `src/services/memory-service.ts` — coerce workspace_id
- `src/db/schema.ts` — add CHECK constraint
- `drizzle/0010_<generated-slug>.sql` — new migration with backfill + constraint
- `src/repositories/memory-repository.ts` — defense-in-depth filter
- `tests/integration/relationships.test.ts` — drop misleading workspace_id

## Verification

1. `npm run db:generate` — confirms the schema change produces a clean migration.
2. Hand-edit the migration to prepend the backfill UPDATE.
3. `npm run db:migrate` against the dev DB — succeeds (no existing project rows with non-null workspace_id in a fresh dev DB; the backfill is a no-op but must run before the ALTER on any DB that does have them).
4. `npm run test tests/integration/relationships.test.ts` — full lifecycle passes.
5. `npm run test tests/integration/session-start.test.ts` — no regression on project-scope loading.
6. `npm run test tests/integration/memory-scoping.test.ts` — scope semantics still hold.
7. `npm test` — full suite green.
8. Manual negative check via `psql`: `INSERT INTO memories (..., scope, workspace_id, ...) VALUES (..., 'project', 'some-ws', ...)` must fail with the CHECK violation.

## Out of scope

- No changes to `listRecentBothScopes` or `search` — those already handle project scope correctly (they either exclude it or match on scope only, not workspace_id).
- No changes to the `workspace_id` column's nullability or FK — already nullable, correct.
