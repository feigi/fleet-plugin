# Tackle open issues of `sc-expedition-service-ui`

## Context

User asked to tackle open GitHub issues for the expedition-service-ui. After triage:

- **6 open issues** in `feigi/sc-expedition-service-ui`.
- **3 real engineering issues**: #93, #94, #50.
- **3 spam/test user-feedback issues** (#38 "test feedback", #39 "smoke test", #70 "ich mag kekse") — **already closed by the user**; skip.

Note on policy: per workspace memory, new follow-up issues belong on `feigi/beyond-infinity`, not per-service repos. #93/#94/#50 already exist in the submodule repo, so each PR will close its issue in place (using the submodule-local `Closes #NN`) and the policy applies to future filings.

The three issues:

- **#93** — `expeditionApi.*` mutations in `src/api.ts` (~L225-292) don't chain `.catch(unwrapAxiosError)` so server 4xx messages are swallowed by axios's generic *"Request failed with status code 4xx"*. Per issue body, the audit extends to `templateApi.*` (L195-214) and `fleetApi.*` (L485-493); `vehicleApi.*` has no mutations. The helper `unwrapAxiosError` exists at api.ts:406-418 and `targetApi.*` (L435-479) uses it correctly.
- **#94** — `onError` handlers in `ExpeditionDetail.tsx` (4 mutations at L114-142: addMaintainer, removeMaintainer, delete, leave) and `JoinDialog.tsx` (1 mutation at L49-62: join) are `onError: () => toast(...)` — they discard the `err` argument and don't pass `description: err.message`. Correct pattern lives at `features/expeditions/targets/TargetCardActions.tsx:29-34`. #94 depends on #93 for the *message* to actually be useful, but each PR is independently valid (adding `console.error(err)` + `description: err.message` is a strict improvement even when the message is still generic).
- **#50** — "Assigning crew to reclaimer does not work. Assigned crew members do not stay in reclaimer. In the mole works like expected." User-reported via feedback system. Diagnosis so far: `sc-vehicle-service/src/vehicle_function/app.py` added `_effective_crew_max()` on 2026-03-29 (Reclaimer becomes crew.max=10 via specialist seats: 1 pilot + 9 weapon). Demo `vehicles.json` shows `crew.max=1` (stale). But user-feedback typically comes from prod, and prod backend already calls the correct `fetch_vehicle_crew_max`. Real root cause unclear — **requires further investigation**. Worker must reproduce before fixing.

## Decomposition — 5 Parallel Work Units

Unit sizing rationale: Units 1-3 all modify `src/api.ts` in different, non-overlapping regions — each is a trivial `.catch(unwrapAxiosError)` append per API namespace. They're split by namespace for maximum parallelism even though a single combined PR would also be reasonable. Merge conflicts between them will be minimal (different line ranges); sequential rebase if needed.

| # | Title | Repo / Files | Change |
|---|-------|--------------|--------|
| 1 | Unwrap axios errors in `expeditionApi.*` mutations | `sc-expedition-service-ui/src/api.ts` (~L225-292) | Append `.catch(unwrapAxiosError)` to `create`, `update`, `join`, `leave`, `addMaintainer`, `removeMaintainer`, `delete`, `updateCrewShip`, `assignShipCrew`. Partial fix for #93. |
| 2 | Unwrap axios errors in `templateApi.*` mutations | `sc-expedition-service-ui/src/api.ts` (~L195-214) | Append `.catch(unwrapAxiosError)` to `create`, `update`, `delete`, `validate`. Audit-portion of #93. |
| 3 | Unwrap axios errors in `fleetApi.*` mutations | `sc-expedition-service-ui/src/api.ts` (~L485-493) | Append `.catch(unwrapAxiosError)` to `create`, `update`. Audit-portion of #93. `vehicleApi` has no mutations — nothing to do there. |
| 4 | Surface server error messages in `ExpeditionDetail` + `JoinDialog` `onError` handlers | `sc-expedition-service-ui/src/features/expeditions/ExpeditionDetail.tsx` (L114-142, 4 mutations) and `.../JoinDialog.tsx` (L49-62, 1 mutation) | Replace each `onError: () => toast(...)` with `onError: (err: Error) => { console.error(err); toast({ title, description: err.message, variant: 'destructive' }); }`. Closes #94. |
| 5 | Investigate + fix Reclaimer crew assignment bug | Starting files: `sc-expedition-service-ui/src/features/expeditions/ShipsAndCrewTab.tsx`, `sc-expedition-service-ui/src/api.ts` (shipAssignments logic), `sc-expedition-service/src/expedition_ship_assign_function/app.py` (`fetch_vehicle_crew_max`), `sc-vehicle-service/src/vehicle_function/app.py` (`_effective_crew_max`), `sc-expedition-service-ui/src/demo/vehicles.json`. May cross repos. | **Investigate first.** Reproduce the bug, identify root cause in prod (not just demo mode), fix the actual cause. Closes #50. |

## E2E Verification Recipe

Per user preference: **unit tests only** for Units 1–4 (error plumbing / toast surfacing). Browser / e2e verification not required.

**For Units 1–4** (inside the worktree, `cd sc-expedition-service-ui` if needed):
```bash
npm ci                  # if node_modules is missing
npm test                # vitest — all existing tests must still pass
npm run lint            # eslint
npm run build           # tsc + vite; catches TS errors (no separate typecheck script)
```
Add or update vitest specs to cover the new behavior where practical (see worker instructions for specifics). Pre-commit hooks run prettier + eslint; CI requires 75% coverage.

**For Unit 5** (investigation):
- Reproduce the bug first against real backend or demo, and document the repro path.
- After fix: run unit tests in whichever repo(s) changed (e.g. `npm test` in `sc-expedition-service-ui`, `python3 -m pipenv run pytest tests/unit/ -v` in Python services).
- If the fix crosses multiple repos (e.g. `sc-vehicle-service` + `sc-expedition-service-ui`), open a separate PR per repo and list all PR URLs in the final report.

## Codebase Conventions Workers Must Follow

- **Stack:** React 19, Vite, Vitest, Tailwind v4.2 (CSS-first via `@tailwindcss/vite`). Do **not** treat it as CRA.
- **ESLint:** `react-hooks/exhaustive-deps` is **not** configured — do NOT add `// eslint-disable-next-line react-hooks/exhaustive-deps` comments; they lint-error.
- **Tests:** Wrap in `QueryClientProvider` with `retry: false`. Mock API via `vi.mock('@/api')`. Existing tests don't assert toast content; adding such assertions is fine for #94 coverage.
- **Response/error unwrap pattern:** Copy from `targetApi.delete` (api.ts:454-462) and `TargetCardActions.tsx:29-34`.
- **Issue policy:** Future follow-up issues → `feigi/beyond-infinity`, not the submodule. These three existed pre-policy — close in place via `Closes #93` etc. in the submodule PR.
- **Commit style:** Inspect `git log --oneline -20` in the submodule; prior commits use conventional-style (`fix:`, `feat:`, `chore:`).

## Worker Prompt Template

Each worker receives:
1. Overall goal: "Tackle open issues of sc-expedition-service-ui."
2. This unit's specific task (title, files, change) — copied verbatim from the table above.
3. The codebase conventions listed above.
4. The E2E recipe above.
5. The verbatim worker instructions block (simplify → unit tests → e2e → commit/push → PR → `PR: <url>` report line).

## Phase 2 Launch Plan

Spawn 5 background agents in a single message with `isolation: "worktree"` and `run_in_background: true`. Each agent operates on an independent git worktree of `feigi/beyond-infinity`; they `cd` into the relevant submodule and create branches + PRs against that submodule's GitHub remote (since #93, #94, #50 live there). Unit 5 may produce multiple cross-repo PRs.

After all agents report, render the final status table with PR URLs and note any failures.
