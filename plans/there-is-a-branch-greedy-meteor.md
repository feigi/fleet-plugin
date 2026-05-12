# Issue #48 — Vault Phase 4a cleanup sweep

## Context

Issue #48 is a tracker bundling quality items from the PR #34 retroactive review (5-agent panel: code-reviewer, silent-failure-hunter, pr-test-analyzer, comment-analyzer, type-design-analyzer). Items are individually small; bundled to avoid issue churn.

The branch `issue-48-cleanup` has prior in-progress work — explicitly ignored per user direction. This plan operates from `main` HEAD `a1652da`.

Several issue checklist items already shipped on main. Plan only addresses items still pending.

### Already shipped on main (do not re-implement)

| Issue item | Where it landed |
|---|---|
| Phase-tagged TODO at `bootstrap.ts:39` | replaced with audit-history rationale comment |
| Phase 5 watcher rot at `memory-repository.ts:121-122` | removed |
| Phase 2b.3 rot at `relationship-repository.ts:161` | removed (transactionality comment kept, untagged) |
| `env.ts:8-10` PAGER-only comment | expanded to PAGER/EDITOR/VISUAL with full rationale |
| `trailers.ts:3-4` LF-only comment | now describes LF/CR/`\` |
| `memory-repository.ts:251` WHAT-restating | stripped |
| `bootstrap.ts:126` WHAT-restating | code reorganized, comment gone |
| `comment-repository.ts:42-43` cross-backend rot | rewritten to describe field derivation |
| `scrubGitEnv` does not pin `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` | new `vaultGitEnv()` pins both to `/dev/null`; `createVaultGit()` is single chokepoint; test at `tests/unit/backend/vault/git/env-isolation.test.ts` proves poisoned global gitconfig cannot influence vault commits |
| `#serialize` per-instance vs per-vault-root | already keyed by resolved `rootKey` in module-level `ROOT_CHAINS` map; class-header doc explains shared mutex (`git-ops.ts:15-26, 87-88`) |

### Still pending (this plan)

1. `commitSubject` action typed `string` (`util.ts:11`)
2. `GitOps.enabled: boolean` discriminant smuggled as boolean → tagged union
3. Privacy guard duplicated across `memory-files.ts` + `memory-repository.ts` (5 call sites, 2 helper definitions)
4. `mutator` return shape: `commit?` optional by convention
5. `VaultGitNothingToCommitError` conflates "unchanged vs HEAD" with "ignored"
6. `ensureConfig` bare-catches every git error (`bootstrap.ts:68-80`)
7. `commitBootstrap` silently no-ops when bootstrap files were just written (`bootstrap.ts:186-194`)
8. `formatTrailers` escapes `reason` only — `actor` is unescaped free-form
9. `.env.example` documents `false` but `config.ts` accepts literal `"true"|"false"` only — `1`/`yes` zod-throws cryptically
10. `afterCommit?.()` sync-only throws — flag for future async hooks (doc-only)

---

## Implementation plan

### Item 1 — `commitSubject` action param

**File:** `src/backend/vault/repositories/util.ts:11`

**Change:**
```ts
import type { CommitAction } from "../git/types.js";

export function commitSubject(action: CommitAction, title: string): string {
```

**Why:** preserves the literal-union chain to `CommitTrailer.action`. A new action string typoed at a callsite would currently compile.

**Verification:** `npm run typecheck`. Existing callers already pass valid actions (verified; all callsites pass `trailer.action` or a literal in the union).

---

### Item 2 — `GitOps.enabled` tagged union

**Files:**
- `src/backend/vault/git/types.ts` (`GitOps` interface)
- `src/backend/vault/git/git-ops.ts` (`GitOpsImpl`)
- `src/backend/vault/index.ts:155, 191, 220, 274`
- `src/backend/vault/git/reconcile.ts:24`
- `src/backend/vault/migration/move-archived-to-dotdir.ts:124`
- `src/backend/vault/repositories/memory-files.ts:64`
- `src/backend/vault/repositories/memory-repository.ts:88`

**Current shape:** two implementations exist — `GitOpsImpl` (`git-ops.ts:30`, `enabled = true`) and `NoopGitOps` (`types.ts:75`, `enabled = false`). The boolean is the only signal of which class a caller holds.

**Change:** turn `GitOps` into a discriminated union:
```ts
type GitOps =
  | { kind: "noop" }
  | { kind: "real"; init(): Promise<void>; isRepo(): Promise<boolean>;
      stageAndCommit(...): Promise<void>; status(): Promise<{clean: boolean}>;
      afterCommit?: () => void };
```

Replace each `gitOps.enabled` read with `gitOps.kind === "real"`. The type narrows in the truthy branch so `stageAndCommit` and `afterCommit` are only reachable there — eliminates the latent foot-gun of calling them on a Noop. `NoopGitOps` becomes a literal `{ kind: "noop" } as const` factory.

**Why:** booleans tagged onto union members are the canonical "bug magnet" — every reader has to remember the unwritten correlation between `enabled === false` and "do not call `stageAndCommit`". A discriminant lets the type system enforce it, or — if there is only one variant — the flag is noise.

**Verification:** `npm run typecheck`; existing contract tests under `tests/contract/repositories/*-git.test.ts` cover the call-site behavior; unit tests under `tests/unit/backend/vault/git/git-ops.test.ts` cover the impl.

---

### Item 3 — Privacy guard centralization (`PrivacyPolicy.requireGuard`)

**Files:**
- `src/backend/vault/repositories/memory-files.ts:64, 76-86` (private method `#assertUserScopeAllowed` + `enforcePrivacyGuard` field)
- `src/backend/vault/repositories/memory-repository.ts:88, 103-113, 162, 327, 463, 559, 895` (same private method + 5 call sites)

**Current shape:** identical 3-clause method copy-pasted into both classes:
```ts
async #assertUserScopeAllowed(scope: string): Promise<void> {
  if (scope !== "user" || this.cfg.trackUsersInGit) return;
  if (!this.enforcePrivacyGuard) {
    throw new DomainError("user-scope write requires either trackUsersInGit=true or enforcePrivacyGuard=true",
      "VAULT_PRIVACY_REQUIRES_GIT", 500);
  }
  await assertUsersIgnored(this.cfg.root);
}
```

**Change:** new file `src/backend/vault/repositories/privacy-policy.ts`:
```ts
export interface PrivacyPolicyConfig {
  readonly root: string;
  readonly trackUsersInGit: boolean;
  readonly enforcePrivacyGuard: boolean;
}

export class PrivacyPolicy {
  constructor(private readonly cfg: PrivacyPolicyConfig) {}

  async requireGuard(scope: string): Promise<void> {
    if (scope !== "user" || this.cfg.trackUsersInGit) return;
    if (!this.cfg.enforcePrivacyGuard) {
      throw new DomainError(
        "user-scope write requires either trackUsersInGit=true or enforcePrivacyGuard=true",
        "VAULT_PRIVACY_REQUIRES_GIT", 500,
      );
    }
    await assertUsersIgnored(this.cfg.root);
  }
}
```

Replace both `#assertUserScopeAllowed` methods with a `PrivacyPolicy` field; replace the 5 callsites + 1 in `memory-files.ts` with `this.privacy.requireGuard(scope)`.

**Why:** issue says _"single enforcement point so future mutation methods can't forget"_. Today, adding a new mutation method requires re-discovering the 3-clause condition. With one type, you cannot forget — the `requireGuard` import advertises itself.

**Reuse:** `assertUsersIgnored` already lives at `src/backend/vault/git/users-gitignore-invariant.ts` — keep using it.

**Tests:**
- New unit test `tests/unit/backend/vault/repositories/privacy-policy.test.ts` covering: workspace scope no-op; user scope + trackUsersInGit no-op; user scope + !enforcePrivacyGuard throws `VAULT_PRIVACY_REQUIRES_GIT`; user scope + enforcePrivacyGuard delegates to `assertUsersIgnored`.
- Existing contract tests at `tests/contract/repositories/memory-repository-track-users-git.test.ts` and `tests/contract/repositories/users-gitignore-invariant.test.ts` continue to pass without modification.

---

### Item 4 — `mutator` return shape: `Unchanged<T> | Changed<T>`

**File:** `src/backend/vault/repositories/memory-files.ts:96-102` (and the matching mutator type wherever it's exported)

**Current:**
```ts
async edit<T>(
  memoryId: string,
  mutator: (parsed: ParsedMemoryFile) => {
    next: ParsedMemoryFile;
    result: T;
    commit?: { subject: string; trailer: CommitTrailer };
  },
): Promise<T>
```

**Change:**
```ts
export type MutatorResult<T> =
  | { kind: "unchanged"; result: T }
  | { kind: "changed"; next: ParsedMemoryFile; result: T;
      commit: { subject: string; trailer: CommitTrailer } };

async edit<T>(memoryId: string, mutator: (parsed: ParsedMemoryFile) => MutatorResult<T>): Promise<T>
```

Update `edit()` body: switch on `kind`. The `unchanged` branch skips write/commit; `changed` always writes + commits. No more `commit?` to forget.

**Why:** today `commit: undefined` while still returning a mutated `next` is a silent contract violation — the file gets written but no audit trail entry is recorded. Discriminated union forces every callsite to declare intent.

**Audit:** every existing mutator callsite must be migrated. Grep `\.edit\(` in `src/backend/vault/repositories/`. Rewrite the mutator return to the new shape.

**Tests:**
- Add unit test for `edit()` covering both branches (`tests/unit/backend/vault/repositories/memory-files.test.ts` if exists, else new).
- Existing contract tests must pass unchanged — caller-observable behavior is identical.

---

### Item 5 — `VaultGitNothingToCommitError` distinguishes two failure modes

**Files:**
- `src/backend/vault/git/git-ops.ts:62-66` (throw site)
- `src/backend/vault/git/types.ts:65-73` (error class)
- `src/backend/vault/repositories/memory-files.ts:135-141` (catch site)
- `src/backend/vault/repositories/memory-repository.ts:1056-1061` (catch site)
- `src/backend/vault/repositories/workspace-repository.ts:84` (catch site)

**Current:** single `VaultGitNothingToCommitError`. Two semantically different cases collapse to it:
1. Path is staged but identical to HEAD (idempotent re-write — debug-worthy).
2. Path is gitignored — no entry appears in `status.staged` or `status.created` (real misconfig — should escalate).

**Change:** in `stageAndCommit`, after `git add` and `git status`, additionally call `git check-ignore --no-index --stdin` (or read `git ls-files --error-unmatch <path>` for cheaper signal — verify in implementation) to detect ignored paths. Throw a distinct error subclass (`VaultGitPathIgnoredError extends DomainError`) with a different code (`VAULT_GIT_PATH_IGNORED`, 500) and message including the offending path.

Catch sites: only downgrade `VaultGitNothingToCommitError` to debug. `VaultGitPathIgnoredError` propagates as a real failure.

**Why:** today, a `users/abc.md` write to a vault with `users/` in `.gitignore` and `trackUsersInGit=true` (operator misconfig) silently succeeds at the file-system level and silently logs at debug. The privacy guard catches the inverse case (track=false + write to user) but not this one.

**Tests:**
- New unit test in `tests/unit/backend/vault/git/git-ops.test.ts`: stage a path that is gitignored, expect `VaultGitPathIgnoredError`.
- Existing nothing-to-commit test continues to assert the idempotent case throws `VaultGitNothingToCommitError`.

---

### Item 6 — `ensureConfig` discriminate exit-code 1

**File:** `src/backend/vault/git/bootstrap.ts:68-80`

**Current:**
```ts
async function ensureConfig(git, key, fallback) {
  try { const { value } = await git.getConfig(key); if (value) return; }
  catch { /* unset → fall through */ }
  await git.addConfig(key, fallback);
}
```

**Change:** narrow the catch to simple-git's structured error:
```ts
catch (err: unknown) {
  const e = err as { exitCode?: number; message?: string };
  const isUnsetKey = e.exitCode === 1 || (
    typeof e.message === "string" && /key does not contain a section|configuration entry/.test(e.message)
  );
  if (!isUnsetKey) throw err;
}
```

**Why:** today, a corrupt `.git/config`, a permission error reading the config, or a hostile global config returning a non-1 exit code is silently swallowed and overridden with the fallback. Real git errors should surface.

**Verification:**
- `npm run typecheck`.
- Existing `tests/unit/backend/vault/git/bootstrap.test.ts` should cover the unset-key branch. Add a case for "non-unset error rethrows" by stubbing `git.getConfig` to reject with a different exit code.

**Open question:** confirm simple-git surfaces `exitCode` on `GitConstructError`/`GitError`; if not, fall back to message regex only. Verify by reading simple-git's error types or by adding a quick test that asserts `err.exitCode` exists.

---

### Item 7 — `commitBootstrap` throws when bootstrap files were just written

**File:** `src/backend/vault/git/bootstrap.ts:186-194`

**Current:**
```ts
async function commitBootstrap(git: SimpleGit): Promise<void> {
  await git.add([".gitignore", ".gitattributes"]);
  const status = await git.status();
  if (status.staged.length === 0 && status.created.length === 0) return;  // silent
  await git.commit(...);
}
```

**Change:** caller (`ensureVaultGit` flow) already knows whether files were *just written*. Pass that signal in:
```ts
async function commitBootstrap(git: SimpleGit, opts: { wroteFiles: boolean }): Promise<void> {
  await git.add([".gitignore", ".gitattributes"]);
  const status = await git.status();
  const nothingStaged = status.staged.length === 0 && status.created.length === 0;
  if (nothingStaged) {
    if (opts.wroteFiles) {
      throw new Error(
        "commitBootstrap: just wrote .gitignore/.gitattributes but git index is empty — likely permissions or hooks rejected the add",
      );
    }
    logger.debug("vault bootstrap: no changes to commit");
    return;
  }
  await git.commit(...);
}
```

The caller already tracks `changed` from `ensureGitignore`/`ensureGitattributes` returns — thread that into `wroteFiles`.

**Why:** issue says _"throw if we just wrote bootstrap files and have nothing to commit; log status for diagnostics"_. The current branch is silent in the diagnostic case (writes accepted, commit skipped). A future ACL-restricted vault root would silently fail bootstrap.

**Tests:**
- Add unit test: stub `git.add` to no-op, write bootstrap files, expect `commitBootstrap({wroteFiles: true})` to throw.
- Existing happy-path tests pass `wroteFiles: true` and remain green.

---

### Item 8 — `formatTrailers` escape uniformity

**File:** `src/backend/vault/git/trailers.ts`

**Current:** only `reason` is encoded. `actor` is interpolated raw.

**Choice (recommend Option A):**
- **Option A — escape uniformly:** apply `encode()` to `actor` too. Simplest; matches the comment header that says "free-form fields".
- **Option B — constrain `actor` charset upstream:** add zod validator `^[\w.@+-]+$` on the `CommitTrailer.actor` field. More restrictive but rules out exotic actor strings.

**Recommended:** Option A. It's defense-in-depth without coupling trailer format to caller validation.

**Change:**
```ts
lines.push(`AB-Actor: ${encode(trailer.actor)}`);
// also: workspaceId / memoryId are validated upstream as ULIDs/slugs so left raw — add a comment noting why
```

**Tests:**
- Unit test `formatTrailers` with an actor containing `\n` → asserts encoded `\\n`.

---

### Item 9 — `.env.example` vs `config.ts` boolean parsing

**Files:** `src/config.ts:11-14, 27-30, 44-47, 55-58, 70-73`; `.env.example`.

**Current:** zod schema accepts only literal `"true"`/`"false"`. `1`/`yes`/`TRUE` throw with cryptic zod errors.

**Change:** define a shared bool coercer:
```ts
const envBool = (def: boolean) =>
  z.string().default(String(def)).transform((v, ctx) => {
    const norm = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(norm)) return true;
    if (["false", "0", "no", "off", ""].includes(norm)) return false;
    ctx.addIssue({ code: "custom", message: `expected boolean (true/false/1/0/yes/no), got "${v}"` });
    return z.NEVER;
  });
```

Replace each `.enum(["true","false"]).default(...).transform(...)` with `envBool(false)` / `envBool(true)`.

**Why:** issue says _"Consider .transform from any string"_. Operators copy-paste `1` from other tools and hit a confusing zod error. Custom message names the expected forms.

**Tests:**
- Unit test on the schema: `1` → `true`, `YES ` → `true`, `false` → `false`, `2` → ValidationError with the custom message.
- `.env.example` already documents `false` literally — update the comments where useful but values can stay as-is.

---

### Item 10 — `afterCommit?.()` async-throw note (doc-only)

**File:** `src/backend/vault/git/git-ops.ts:73-80`

**Change:** add a comment block above the try/catch noting that the contract is `() => void` (sync); async hooks would need `await this.afterCommit?.()` and a Promise-rejection-aware catch. No behavior change.

```ts
// Contract: afterCommit is sync (() => void). The try/catch only
// captures synchronous throws — if the hook is ever changed to
// `() => Promise<void>` or `async`, the catch must `await` and
// handle Promise rejections, otherwise an async failure would be
// unhandled.
```

**Why:** issue marks this _"flag for future async hooks"_. The signature is contract-correct today; the comment prevents a quiet regression if the hook signature ever broadens.

---

## Critical files modified

| File | Items |
|---|---|
| `src/backend/vault/repositories/util.ts` | 1 |
| `src/backend/vault/git/types.ts` | 2, 5 |
| `src/backend/vault/git/git-ops.ts` | 2, 5, 10 |
| `src/backend/vault/index.ts` | 2 |
| `src/backend/vault/git/reconcile.ts` | 2 |
| `src/backend/vault/migration/move-archived-to-dotdir.ts` | 2 |
| `src/backend/vault/repositories/memory-files.ts` | 2, 3, 4, 5 |
| `src/backend/vault/repositories/memory-repository.ts` | 2, 3, 5 |
| `src/backend/vault/repositories/workspace-repository.ts` | 5 |
| `src/backend/vault/repositories/privacy-policy.ts` (NEW) | 3 |
| `src/backend/vault/git/bootstrap.ts` | 6, 7 |
| `src/backend/vault/git/trailers.ts` | 8 |
| `src/config.ts` | 9 |

Tests added/touched:
- `tests/unit/backend/vault/repositories/privacy-policy.test.ts` (NEW — item 3)
- `tests/unit/backend/vault/repositories/memory-files.test.ts` (item 4 — may need creation)
- `tests/unit/backend/vault/git/git-ops.test.ts` (item 5)
- `tests/unit/backend/vault/git/bootstrap.test.ts` (items 6, 7)
- `tests/unit/backend/vault/git/trailers.test.ts` (item 8 — may need creation)
- `tests/unit/config.test.ts` (item 9 — may need creation)

---

## Suggested commit grouping

Bundling rule: each commit a single coherent slice; type-checker green between commits.

1. `refactor(vault): tighten commitSubject action to CommitAction union` (item 1)
2. `refactor(vault): GitOps tagged union / drop dead enabled flag` (item 2)
3. `refactor(vault): centralize user-scope privacy guard in PrivacyPolicy` (item 3)
4. `refactor(vault): MutatorResult discriminant — Unchanged | Changed` (item 4)
5. `feat(vault): distinguish gitignored-path commit failure from no-op` (item 5)
6. `fix(vault): ensureConfig narrows catch to unset-key, rethrows others` (item 6)
7. `fix(vault): commitBootstrap throws when bootstrap files were just written` (item 7)
8. `refactor(vault): formatTrailers escapes actor uniformly` (item 8)
9. `feat(config): bool env coercion accepts true/false/1/0/yes/no` (item 9)
10. `docs(vault): note afterCommit sync-only contract` (item 10)

---

## Verification

End-to-end (run after each commit and once at the end):

```bash
npm run typecheck
npm run lint
npm run test:unit -- --run
npm run test:contract -- --run
```

Item-specific spot checks:
- **Item 2:** grep `gitOps.enabled` after refactor → either zero hits (drop path) or only on `kind === "real"` narrowing (union path).
- **Item 3:** grep `assertUserScopeAllowed` after refactor → zero hits in repositories. `requireGuard` only present on `PrivacyPolicy`.
- **Item 5:** integration check — set up a vault with `users/` ignored and `trackUsersInGit: true`, attempt a user-scope create, assert `VaultGitPathIgnoredError` (or whatever code is finalized) propagates instead of silent debug log.
- **Item 7:** integration check — bootstrap a vault with `chmod -w` on `.git/`, assert `commitBootstrap` throws rather than returns silently.
- **Item 9:** unit test `AGENT_BRAIN_VAULT_TRACK_USERS=1` → loads as `true`; `=2` → ValidationError with helpful message.

Run the full test suite once at end on a clean worktree rebased to `origin/main`.

---

## Out of scope

- Hardcoded `main` branch in pull/push (deferred).
- Smart YAML merge driver for frontmatter (deferred to its own design).
- Push-queue retry exhaustion telemetry (Phase 4c follow-up).
- Reasoning/consolidation env var changes beyond the bool coercion shared helper.
- Any change to the issue-48-cleanup branch — ignored per user direction; this plan implements from main.
