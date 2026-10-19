# 0027 — The scratch root is computed, not injected

**Status:** Accepted. Ruled 2026-10-11 by the maintainer in a grilling session
on #2194, against the measurements below. Replaces the ticket's triage
recommendation (`.fleet/scratch/` inside the checkout plus a recorded
`mktemp -d`), which this ADR reverses. Builds on the partition rule recorded in
`plugin/skills/run-team/references/isolation.md`, which it does not change.
Amended by #3091: the workspace is the common git dir itself unless its parent's `.git` resolves to it; `.fleet/` and the scratch root follow.
Amended by #3453: only an absent `<parent>/.git` is "not this parent"; one that exists but that `--resolve-git-dir` refuses (dangling, invalid, unreadable) fails the workspace closed, so a linked worktree never re-keys to the common dir.

## Context

The implementer bodies said the scratchpad root "your own system prompt names
is injected unprompted into every dispatched member". That is true on Claude
Code and was written there. It is false on omp, the only harness (ADR 0014):
omp puts no directory path in a member's system prompt, and no `OMP_*` session
variable carries one. `local://` is per controller session, shared by every
sibling, and bash cannot reach it without a `realpath` step. A member told to
use "the root" therefore made one up.

## Evidence

Measured 2026-10-11 against `main` at `84b05f78`, as recorded in the ruling comment on #2194.

| Fact | Evidence |
|---|---|
| omp puts no directory path in a member's system prompt | 3 implementer transcripts (2026-10-08): no `tmp`/`Scratchpad` text and no absolute paths in the harness text. No `OMP_*`/session env var. `local://` is per controller session |
| Since 09-29 the controller picks the root, not the member | 313 of 321 implementer dispatch prompts name an absolute root; 298 of those members wrote exactly it. Before 09-29 most prompts carried none, and that is where `/tmp`, `$TMPDIR` and `/fleet-scratch` came from |
| The controller's pick drifts | 3 roots in 10 days, none set by a script: `<repo>/.fleet/scratch`, then `<repo>/scratch` (not ignored; review `cwdAudit` flagged it), then `/tmp/fleet-scratch` (10-01 run), then `~/.fleet/scratch` after a re-invoke (10-08 run). `SKILL.md` never said what `<scratch>` is. Merge-bot dispatches mostly carried no root |
| The false "injected" claim appeared in 6 places | `plugin/agents/fleet-implementer-{slow-high,slow-medium,smol-high,task-high,task-max}.agent.md:99-100` and `plugin/commands/run-merge-bot.md:229` |
| A root inside the checkout breaks git discovery | The bracket in `SKILL.md` requires that, before `git init`, `--show-toplevel` does NOT resolve to the repo; under `<repo>/.fleet/scratch/...` it always does. `git archive` trees then pass by coincidence |
| The `$TMPDIR` objection does not hold | ADR 0009 is only the platform list and says nothing about a RAM-backed `/tmp`. On macOS `$TMPDIR` is on disk. `/tmp` roots are lost on reboot, so they cannot be resumed |
| Leftover scratch is on disk | `<repo>/.fleet/scratch` held 33G in 1.6M files; `~/.fleet/scratch` held 11G. Cleanup belongs to #2316 |
| Enclosing repo (a dotfiles `$HOME`) | `git init` inside an ignored scratch dir with no `.git` above it is refused `rc=1` ("paths are ignored") by `git add .`, but `git add -A` returns `rc=0` and stages the OUTER repo's changes. So the pre-commit half of the bracket remains required |

## Decision

1. **Root: one fixed root per repository, computed rather than recorded.**
   `~/.fleet/scratch/<repo-key>/`. It never lives in the checkout, `/tmp`,
   `$TMPDIR` or `local://`. A compacted, re-invoked or resumed controller
   computes the same path again.
2. **`<repo-key>` is `<basename>-<8 hex>`.** `<basename>` is the folder name of
   the workspace `fleetFile()` resolves: the common git dir's parent when the
   common dir is named `.git` or when that parent's own `.git` resolves to it
   (the `.bare` layout's gitfile); otherwise the common git dir itself (a bare
   repository, a submodule's git dir, a `--separate-git-dir` clone), with a
   trailing `.git` dropped from a git dir's name. The hex is the first 8
   characters of the sha256 of that workspace's realpath. A linked worktree
   maps to its repository's workspace, and two clones with the same name get
   different roots.
3. **Derivation.** `fleet-dir.mjs` exports `scratchRoot()`. A new CLI,
   `plugin/scripts/scratch-root.mjs` (run through
   `~/.fleet/bin/fleet-run`), runs `mkdir -p` and prints the absolute path.
   Nothing is written to `.fleet/` or anywhere else to record it.
4. **Enclosing-repo refusal.** `scratch-root.mjs` exits non-zero, with the
   reason, when the root is inside a git work tree and `git check-ignore` says
   it is not ignored — ADR 0020's rule for the main checkout. A root under an
   ignoring outer repo passes. The check runs before anything is created.
5. **Delivery to members.** The controller runs `scratch-root.mjs` and writes
   an absolute path into the prompt of every role it dispatches: implementer
   (`<root>/impl-<N>/`), fix-applier, finisher, review runner (`scratch` is the
   root itself) and merge bot, and the recipe deriver
   (`<root>/derive-recipe/`). The partition shapes do not change. A member never
   builds its own root; if its prompt names none, it asks the controller by name
   and never invents one.
6. **No per-harness fork.** omp is the only harness (ADR 0014). The "injected
   unprompted" and "injected into every dispatched member" sentences are
   deleted from the five implementer bodies and `run-merge-bot.md`, and each states one rule in their place: the
   dispatch prompt names your partition with an absolute path, and no harness
   supplies one.
7. **Standalone entry points use the same root.** `review-core.mjs` drops its
   `/tmp/review-pr-<pr>` fallback and resolves an omitted `scratch` through
   `scratchRoot()`, with the refusal above. The same applies to the standalone
   `/review-and-fix`, to `sizing-a-ticket`, and to the standalone
   recipe-deriver path: wherever `<scratch>` has no dispatcher, it resolves
   through `scratch-root.mjs`.
8. **Bracket wording.** The specialist and refuter bracket reads: before
   `git init`, `--show-toplevel` must not resolve to the host repository
   (`fatal: not a git repository` is the usual pass, and an outer repository
   whose ignore rules cover the root is also a pass); before any commit, it
   must resolve to the member's own scratch path, which catches a forgotten
   `git init` under any enclosing repository. The `/private/tmp/...` example is
   replaced by a neutral one: a symlinked parent such as `/tmp` or a symlinked
   `$HOME`.

## Consequences

- Shipped-surface prose (ADR 0019): `plugin/` states the rule and cites no
  issue number; provenance lives here and in `CONTEXT.md`'s **Scratch root**
  term.
- Moving or deleting existing data under `<repo>/.fleet/scratch` or
  `~/.fleet/scratch/pr*` is #2316's job, not this cutover's.
- No `reviewed=` token is migrated: no open PR carried one at ruling time.
